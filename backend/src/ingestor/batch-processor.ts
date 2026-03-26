/**
 * Concurrent Batch-Processing Engine (Issue #484)
 *
 * Collects events into per-ledger buckets, then flushes them in a single
 * DB round-trip using Prisma createMany / updateMany.
 *
 * Design goals:
 *  - Reduce DB round-trips from O(n events) → O(1) per batch flush
 *  - Concurrency-controlled via PromiseQueue (no unbounded parallelism)
 *  - Dynamic sleep throttle: shrinks when lagging, grows when caught up
 */

import { SorobanRpc, scValToNative } from "@stellar/stellar-sdk";
import { PrismaClient, StreamStatus } from "../generated/client/index.js";
import { logger } from "../logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface RawStreamPayload {
  stream_id?: unknown;
  sender?: unknown;
  receiver?: unknown;
  amount?: unknown;
  token?: unknown;
  yield_enabled?: unknown;
  yieldEnabled?: unknown;
  vault_contract_id?: unknown;
  vaultContractId?: unknown;
}

interface StreamCreateData {
  streamId: string;
  txHash: string;
  sender: string;
  receiver: string;
  contractId: string;
  tokenAddress: string | null;
  amount: string;
  version: number;
  yieldEnabled: boolean;
  legacy: boolean;
  status: StreamStatus;
}

interface StreamUpdateData {
  streamId: string;
  status: StreamStatus;
  contractId: string;
  version: number;
  yieldEnabled: boolean;
}

interface MigrationData {
  v1StreamId: string;
  v2Data: Omit<StreamCreateData, "streamId">;
}

export interface BatchFlushResult {
  created: number;
  updated: number;
  migrated: number;
  ledgersProcessed: number;
}

// ── PromiseQueue ──────────────────────────────────────────────────────────────

/**
 * Lightweight concurrency limiter.
 * Ensures at most `concurrency` async tasks run simultaneously.
 */
export class PromiseQueue {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly concurrency: number) {}

  async add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.running++;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.running--;
            if (this.queue.length > 0) {
              const next = this.queue.shift()!;
              next();
            }
          });
      };

      if (this.running < this.concurrency) {
        run();
      } else {
        this.queue.push(run);
      }
    });
  }

  get pending(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.running;
  }
}

// ── DynamicThrottle ───────────────────────────────────────────────────────────

/**
 * Adjusts poll sleep based on ledger lag.
 *
 * - lag > HIGH_WATERMARK  → use minMs  (catch up fast)
 * - lag < LOW_WATERMARK   → use maxMs  (idle, save RPC quota)
 * - in between            → linear interpolation
 */
export class DynamicThrottle {
  private static readonly HIGH_WATERMARK = 100; // ledgers behind → sprint
  private static readonly LOW_WATERMARK = 5;    // ledgers behind → idle

  constructor(
    private readonly minMs: number = 500,
    private readonly maxMs: number = 6000,
  ) {}

  /** Returns the sleep duration in ms for the given ledger lag. */
  compute(lag: number): number {
    if (lag >= DynamicThrottle.HIGH_WATERMARK) return this.minMs;
    if (lag <= DynamicThrottle.LOW_WATERMARK) return this.maxMs;

    const ratio =
      (lag - DynamicThrottle.LOW_WATERMARK) /
      (DynamicThrottle.HIGH_WATERMARK - DynamicThrottle.LOW_WATERMARK);

    return Math.round(this.maxMs - ratio * (this.maxMs - this.minMs));
  }
}

// ── BatchProcessor ────────────────────────────────────────────────────────────

/**
 * Accumulates decoded events and flushes them to the DB in bulk.
 */
export class BatchProcessor {
  private creates: StreamCreateData[] = [];
  private updates: StreamUpdateData[] = [];
  private migrations: MigrationData[] = [];
  private seenStreamIds = new Set<string>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly v1ContractId: string,
    private readonly v2ContractId: string,
  ) {}

  /** Decode and stage a single event. Returns the event's ledger number. */
  stage(event: SorobanRpc.Api.EventResponse): void {
    const action = this.extractAction(event);
    if (!action) return;

    if (action === "migrate") {
      this.stageMigration(event);
      return;
    }

    const payload = this.decodePayload(event);
    if (!payload?.stream_id) return;

    const streamId = String(payload.stream_id);
    const contractId = event.contractId?.toString() ?? "";
    const isLegacy = contractId === this.v1ContractId;
    const version = contractId === this.v1ContractId ? 1 : 2;
    const status = actionToStatus(action);

    if (action === "create" && !this.seenStreamIds.has(streamId)) {
      this.seenStreamIds.add(streamId);
      this.creates.push({
        streamId,
        txHash: event.txHash ?? event.id,
        sender: String(payload.sender ?? ""),
        receiver: String(payload.receiver ?? ""),
        contractId,
        tokenAddress: payload.token ? String(payload.token) : null,
        amount: String(payload.amount ?? "0"),
        version,
        yieldEnabled: isYieldEnabled(payload),
        legacy: isLegacy,
        status,
      });
    } else {
      this.updates.push({ streamId, status, contractId, version, yieldEnabled: isYieldEnabled(payload) });
    }
  }

  private stageMigration(event: SorobanRpc.Api.EventResponse): void {
    const payload = this.decodePayload(event);
    if (!payload?.stream_id) return;

    const v1StreamId = String(payload.stream_id);
    this.migrations.push({
      v1StreamId,
      v2Data: {
        txHash: event.txHash ?? event.id,
        sender: String(payload.sender ?? ""),
        receiver: String(payload.receiver ?? ""),
        contractId: this.v2ContractId,
        tokenAddress: payload.token ? String(payload.token) : null,
        amount: String(payload.amount ?? "0"),
        version: 2,
        yieldEnabled: isYieldEnabled(payload),
        legacy: false,
        status: StreamStatus.ACTIVE,
      },
    });
  }

  get size(): number {
    return this.creates.length + this.updates.length + this.migrations.length;
  }

  /** Flush all staged events to the DB and reset internal state. */
  async flush(ledgersProcessed: number): Promise<BatchFlushResult> {
    if (this.size === 0) {
      return { created: 0, updated: 0, migrated: 0, ledgersProcessed };
    }

    const creates = this.creates.splice(0);
    const updates = this.updates.splice(0);
    const migrations = this.migrations.splice(0);
    this.seenStreamIds.clear();

    let created = 0;
    let updated = 0;
    let migrated = 0;

    await this.prisma.$transaction(async (tx) => {
      // ── Batch creates ──────────────────────────────────────────────────────
      if (creates.length > 0) {
        const result = await tx.stream.createMany({
          data: creates,
          skipDuplicates: true,
        });
        created = result.count;
      }

      // ── Batch updates (group by status for updateMany) ─────────────────────
      if (updates.length > 0) {
        // Group by status to minimise updateMany calls
        const byStatus = new Map<StreamStatus, string[]>();
        for (const u of updates) {
          const ids = byStatus.get(u.status) ?? [];
          ids.push(u.streamId);
          byStatus.set(u.status, ids);
        }

        for (const [status, streamIds] of byStatus) {
          const r = await tx.stream.updateMany({
            where: { streamId: { in: streamIds } },
            data: { status },
          });
          updated += r.count;
        }
      }

      // ── Migrations (must remain atomic per pair) ───────────────────────────
      for (const m of migrations) {
        await tx.stream.updateMany({
          where: { streamId: m.v1StreamId, legacy: true },
          data: { migrated: true },
        });
        await tx.stream.create({
          data: { streamId: `${m.v1StreamId}-v2`, ...m.v2Data },
        });
        migrated++;
      }
    });

    logger.info("[BatchProcessor] Flush complete", {
      created,
      updated,
      migrated,
      ledgersProcessed,
    });

    return { created, updated, migrated, ledgersProcessed };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private extractAction(event: SorobanRpc.Api.EventResponse): string | null {
    try {
      const native = scValToNative(event.topic[0]);
      return typeof native === "string" ? native.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  private decodePayload(event: SorobanRpc.Api.EventResponse): RawStreamPayload | null {
    try {
      const native = scValToNative(event.value);
      return typeof native === "object" && native !== null
        ? (native as RawStreamPayload)
        : null;
    } catch {
      return null;
    }
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function actionToStatus(action: string): StreamStatus {
  switch (action) {
    case "cancel":   return StreamStatus.CANCELED;
    case "pause":    return StreamStatus.PAUSED;
    case "resume":   return StreamStatus.ACTIVE;
    default:         return StreamStatus.ACTIVE;
  }
}

function isYieldEnabled(payload: RawStreamPayload | null): boolean {
  if (!payload) return false;
  const flag = payload.yield_enabled ?? payload.yieldEnabled;
  if (typeof flag === "boolean") return flag;
  return Boolean(payload.vault_contract_id ?? payload.vaultContractId);
}
