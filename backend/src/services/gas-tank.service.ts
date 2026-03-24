import { prisma } from "../lib/db.js";
import { logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Stellar / Soroban rent constants
// ---------------------------------------------------------------------------

/**
 * Average ledger close time on Stellar (seconds).
 * Used to convert ledger-denominated burn rates to wall-clock time.
 */
const LEDGER_CLOSE_TIME_SECONDS = 5;

/**
 * Soroban write-fee per 1 KB per ledger (in stroops).
 * Matches the current Stellar testnet/mainnet network setting.
 * Override via GAS_TANK_RENT_FEE_PER_1KB_PER_LEDGER env var.
 */
const DEFAULT_RENT_FEE_PER_1KB_PER_LEDGER = 1_000n; // stroops

/**
 * Estimated on-chain storage footprint of a single stream entry (bytes).
 * A Soroban stream record holds ~8 fields (addresses, i128s, u64s, bools)
 * which serialises to roughly 200 bytes of XDR.
 * Override via GAS_TANK_STREAM_SIZE_BYTES env var.
 */
const DEFAULT_STREAM_SIZE_BYTES = 200n;

/** 1 XLM = 10,000,000 stroops */
const STROOPS_PER_XLM = 10_000_000n;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GasTankStatus {
  streamId: string;
  /** Current gas tank balance in stroops (string to preserve precision). */
  gasTankBalanceStroops: string;
  /** Current gas tank balance in XLM. */
  gasTankBalanceXlm: string;
  /** Rent cost per ledger in stroops. */
  burnRatePerLedgerStroops: string;
  /** Rent cost per second in stroops (floating-point approximation). */
  burnRatePerSecondStroops: string;
  /** Rent cost per day in stroops. */
  burnRatePerDayStroops: string;
  /** Rent cost per day in XLM. */
  burnRatePerDayXlm: string;
  /**
   * Estimated ledgers remaining before the gas tank is depleted.
   * null when balance is zero or burn rate is zero.
   */
  estimatedLedgersRemaining: string | null;
  /**
   * Estimated seconds remaining before depletion.
   * null when balance is zero or burn rate is zero.
   */
  estimatedSecondsRemaining: number | null;
  /**
   * ISO-8601 timestamp of the projected depletion date.
   * null when the stream is already ended or burn rate is zero.
   */
  estimatedDepletionAt: string | null;
  /**
   * Whether the gas tank is critically low (< 7 days of runway).
   */
  isCritical: boolean;
  /**
   * Whether the gas tank is already empty.
   */
  isDepleted: boolean;
  /** Stream end time as Unix timestamp (seconds). */
  streamEndTime: number | null;
  /** Effective end: whichever comes first — stream end or gas depletion. */
  effectiveEndAt: string | null;
}

export interface GasTankConfig {
  /** Rent fee per 1 KB per ledger in stroops. */
  rentFeePerKbPerLedger: bigint;
  /** Estimated stream entry size in bytes. */
  streamSizeBytes: bigint;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stroopsToXlm(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const frac = stroops % STROOPS_PER_XLM;
  return `${whole}.${frac.toString().padStart(7, "0")}`;
}

function loadConfig(): GasTankConfig {
  const rentFeePerKbPerLedger = process.env.GAS_TANK_RENT_FEE_PER_1KB_PER_LEDGER != null && process.env.GAS_TANK_RENT_FEE_PER_1KB_PER_LEDGER !== ""
    ? BigInt(process.env.GAS_TANK_RENT_FEE_PER_1KB_PER_LEDGER)
    : DEFAULT_RENT_FEE_PER_1KB_PER_LEDGER;

  const streamSizeBytes = process.env.GAS_TANK_STREAM_SIZE_BYTES != null && process.env.GAS_TANK_STREAM_SIZE_BYTES !== ""
    ? BigInt(process.env.GAS_TANK_STREAM_SIZE_BYTES)
    : DEFAULT_STREAM_SIZE_BYTES;

  return { rentFeePerKbPerLedger, streamSizeBytes };
}

/**
 * Compute the rent burn rate per ledger for a stream entry.
 *
 * Formula:
 *   burnRatePerLedger = (streamSizeBytes / 1024) * rentFeePerKbPerLedger
 *
 * We use integer arithmetic throughout; the division is ceiling-rounded so
 * we never under-estimate the cost.
 */
function computeBurnRatePerLedger(config: GasTankConfig): bigint {
  const { rentFeePerKbPerLedger, streamSizeBytes } = config;
  // Ceiling division: (size + 1023) / 1024
  return ((streamSizeBytes + 1023n) / 1024n) * rentFeePerKbPerLedger;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class GasTankService {
  private readonly config: GasTankConfig;

  constructor(config?: Partial<GasTankConfig>) {
    const defaults = loadConfig();
    this.config = {
      rentFeePerKbPerLedger: config?.rentFeePerKbPerLedger ?? defaults.rentFeePerKbPerLedger,
      streamSizeBytes: config?.streamSizeBytes ?? defaults.streamSizeBytes,
    };
  }

  /**
   * Calculate the gas tank burn rate and depletion forecast for a stream.
   *
   * The "gas tank" is the XLM balance the sender deposited to cover ongoing
   * Soroban storage-rent fees. This method:
   *   1. Fetches the stream record from the DB.
   *   2. Derives the current gas tank balance from the stream's amount and
   *      withdrawn fields (the unstreamed portion acts as the rent reserve).
   *   3. Computes the per-ledger rent burn rate based on the stream's on-chain
   *      storage footprint.
   *   4. Projects when the tank will run dry.
   */
  async getGasTankStatus(streamId: string): Promise<GasTankStatus> {
    const stream = await prisma.stream.findFirst({
      where: {
        OR: [{ streamId }, { id: streamId }],
      },
    });

    if (!stream) {
      throw new Error(`Stream not found: ${streamId}`);
    }

    // Derive gas tank balance.
    // The unstreamed (locked) portion of the stream's amount is what backs
    // the rent. We treat: gasTank = totalAmount - withdrawn.
    const totalAmount = BigInt(stream.amount ?? "0");
    const withdrawn = BigInt(stream.withdrawn ?? "0");
    const gasTankBalance = totalAmount > withdrawn ? totalAmount - withdrawn : 0n;

    const burnRatePerLedger = computeBurnRatePerLedger(this.config);

    // Per-day burn rate: ledgers_per_day = (86400 / LEDGER_CLOSE_TIME_SECONDS)
    const ledgersPerDay = BigInt(Math.round(86_400 / LEDGER_CLOSE_TIME_SECONDS));
    const burnRatePerDay = burnRatePerLedger * ledgersPerDay;

    // Burn rate per second (as a fractional stroops value — keep as number for display)
    const burnRatePerSecond =
      Number(burnRatePerLedger) / LEDGER_CLOSE_TIME_SECONDS;

    const isDepleted = gasTankBalance === 0n;

    let estimatedLedgersRemaining: bigint | null = null;
    let estimatedSecondsRemaining: number | null = null;
    let estimatedDepletionAt: string | null = null;

    if (!isDepleted && burnRatePerLedger > 0n) {
      estimatedLedgersRemaining = gasTankBalance / burnRatePerLedger;
      estimatedSecondsRemaining =
        Number(estimatedLedgersRemaining) * LEDGER_CLOSE_TIME_SECONDS;
      estimatedDepletionAt = new Date(
        Date.now() + estimatedSecondsRemaining * 1_000
      ).toISOString();
    }

    // Resolve stream end time from EventLog metadata if available
    const streamEndTime = await this.resolveStreamEndTime(
      stream.streamId ?? streamId
    );

    // Effective end: whichever comes first
    let effectiveEndAt: string | null = null;
    if (estimatedDepletionAt !== null && streamEndTime !== null) {
      const depletionMs = new Date(estimatedDepletionAt).getTime();
      const streamEndMs = streamEndTime * 1_000;
      effectiveEndAt =
        depletionMs < streamEndMs
          ? estimatedDepletionAt
          : new Date(streamEndMs).toISOString();
    } else if (estimatedDepletionAt !== null) {
      effectiveEndAt = estimatedDepletionAt;
    } else if (streamEndTime !== null) {
      effectiveEndAt = new Date(streamEndTime * 1_000).toISOString();
    }

    // Critical = less than 7 days of runway remaining
    const CRITICAL_THRESHOLD_SECONDS = 7 * 24 * 3600;
    const isCritical =
      !isDepleted &&
      estimatedSecondsRemaining !== null &&
      estimatedSecondsRemaining < CRITICAL_THRESHOLD_SECONDS;

    logger.debug(
      `[GasTank] stream=${streamId} balance=${gasTankBalance} burnRate=${burnRatePerLedger}/ledger depletes=${estimatedDepletionAt}`
    );

    return {
      streamId,
      gasTankBalanceStroops: gasTankBalance.toString(),
      gasTankBalanceXlm: stroopsToXlm(gasTankBalance),
      burnRatePerLedgerStroops: burnRatePerLedger.toString(),
      burnRatePerSecondStroops: burnRatePerSecond.toFixed(6),
      burnRatePerDayStroops: burnRatePerDay.toString(),
      burnRatePerDayXlm: stroopsToXlm(burnRatePerDay),
      estimatedLedgersRemaining: estimatedLedgersRemaining?.toString() ?? null,
      estimatedSecondsRemaining,
      estimatedDepletionAt,
      isCritical,
      isDepleted,
      streamEndTime,
      effectiveEndAt,
    };
  }

  /**
   * Resolve the stream's end_time from the EventLog create event metadata.
   * Falls back to null if not available.
   */
  private async resolveStreamEndTime(streamId: string): Promise<number | null> {
    try {
      const event = await prisma.eventLog.findFirst({
        where: { streamId, eventType: "create" },
        select: { metadata: true },
        orderBy: { createdAt: "asc" },
      });

      if (event?.metadata == null || event.metadata === "") return null;

      const meta = JSON.parse(event.metadata) as Record<string, unknown>;
      const raw = meta.end_time ?? meta.endTime;

      if (typeof raw === "number" && Number.isFinite(raw)) return raw;
      if (typeof raw === "string") {
        const n = Number(raw);
        if (Number.isFinite(n)) return n;
      }
      if (typeof raw === "bigint") return Number(raw);

      return null;
    } catch {
      return null;
    }
  }
}
