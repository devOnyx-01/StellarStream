/**
 * Dual-Version Ingestor (Issue #481 + #484)
 *
 * Polls V1 and V2 contract IDs simultaneously.
 * - Events from V1_CONTRACT_ID are stored with legacy: true.
 * - A "migrate" event atomically marks the V1 record as migrated
 *   and creates the V2 record in a single DB transaction.
 *
 * Performance (Issue #484):
 * - Events are staged into a BatchProcessor and flushed with
 *   createMany / updateMany — one DB round-trip per poll cycle.
 * - A PromiseQueue caps concurrent flush tasks at QUEUE_CONCURRENCY.
 * - DynamicThrottle adjusts the sleep interval based on ledger lag
 *   so the indexer sprints when behind and idles when caught up.
 */

import { SorobanRpc, scValToNative } from "@stellar/stellar-sdk";
import { PrismaClient } from "../generated/client/index.js";
import {
  getLastLedgerSequence,
  saveLastLedgerSequence,
} from "../services/syncMetadata.service.js";
import { logger } from "../logger.js";
import { NotificationService } from "../services/notification.service.js";
import {
  BatchProcessor,
  DynamicThrottle,
  PromiseQueue,
} from "./batch-processor.js";

const prisma = new PrismaClient();
const notificationService = new NotificationService();

const RPC_URL = process.env.STELLAR_RPC_URL ?? "";
const V1_CONTRACT_ID = process.env.V1_CONTRACT_ID ?? "";
const V2_CONTRACT_ID = process.env.NEBULA_CONTRACT_ID ?? "";

// Throttle bounds (ms). Override via env for tuning.
const MIN_POLL_MS = parseInt(process.env.MIN_POLL_MS ?? "500", 10);
const MAX_POLL_MS = parseInt(process.env.MAX_POLL_MS ?? "6000", 10);

// Max concurrent batch-flush tasks in flight at once.
const QUEUE_CONCURRENCY = parseInt(process.env.QUEUE_CONCURRENCY ?? "4", 10);

// ── Ingestor ──────────────────────────────────────────────────────────────────

export class DualVersionIngestor {
  private server: SorobanRpc.Server;
  private running = false;
  private pollTimeout?: NodeJS.Timeout;
  private contractIds: string[];

  private readonly batchProcessor: BatchProcessor;
  private readonly throttle: DynamicThrottle;
  private readonly queue: PromiseQueue;

  constructor(rpcUrl = RPC_URL) {
    if (!V1_CONTRACT_ID) throw new Error("V1_CONTRACT_ID is not set");
    if (!V2_CONTRACT_ID) throw new Error("NEBULA_CONTRACT_ID is not set");

    this.server = new SorobanRpc.Server(rpcUrl, {
      allowHttp: rpcUrl.startsWith("http://"),
    });
    this.contractIds = [V1_CONTRACT_ID, V2_CONTRACT_ID];
    this.batchProcessor = new BatchProcessor(prisma, V1_CONTRACT_ID, V2_CONTRACT_ID);
    this.throttle = new DynamicThrottle(MIN_POLL_MS, MAX_POLL_MS);
    this.queue = new PromiseQueue(QUEUE_CONCURRENCY);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info("[DualIngestor] Starting", {
      contractIds: this.contractIds,
      minPollMs: MIN_POLL_MS,
      maxPollMs: MAX_POLL_MS,
      queueConcurrency: QUEUE_CONCURRENCY,
    });
    await this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimeout) clearTimeout(this.pollTimeout);
    logger.info("[DualIngestor] Stopped");
  }

  // ── Poll loop ───────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (!this.running) return;

    let sleepMs = MAX_POLL_MS;

    try {
      sleepMs = await this.fetchAndProcess();
    } catch (err) {
      logger.error("[DualIngestor] Poll error", { err });
    }

    this.pollTimeout = setTimeout(() => this.poll(), sleepMs);
  }

  /**
   * Fetch one page of events, stage them all, flush in one DB round-trip,
   * then return the computed sleep duration based on ledger lag.
   */
  private async fetchAndProcess(): Promise<number> {
    const startLedger = await getLastLedgerSequence();

    // Fetch the latest ledger to compute lag
    const latestLedgerInfo = await this.server.getLatestLedger();
    const networkTip = latestLedgerInfo.sequence;
    const lag = Math.max(0, networkTip - startLedger);

    const response = await this.server.getEvents({
      startLedger: startLedger === 0 ? undefined : startLedger + 1,
      filters: [{ type: "contract", contractIds: this.contractIds }],
    });

    const events = response.events ?? [];

    if (events.length === 0) {
      logger.debug("[DualIngestor] No new events", { startLedger, networkTip, lag });
      return this.throttle.compute(lag);
    }

    logger.info(`[DualIngestor] Staging ${events.length} event(s)`, {
      startLedger,
      networkTip,
      lag,
    });

    // Stage all events (pure CPU — no I/O)
    for (const event of events) {
      this.batchProcessor.stage(event);
    }

    // Determine the highest ledger in this batch
    let latestLedger = startLedger;
    for (const event of events) {
      if (event.ledger > latestLedger) latestLedger = event.ledger;
    }

    const ledgersProcessed = latestLedger - startLedger;

    // Enqueue the flush so multiple batches can be in-flight concurrently
    this.queue.add(async () => {
      const result = await this.batchProcessor.flush(ledgersProcessed);

      // Persist cursor only after successful flush (idempotency guarantee)
      await saveLastLedgerSequence(latestLedger);

      // Fire notifications for newly created streams (non-blocking)
      this.dispatchCreateNotifications(events).catch((err) =>
        logger.error("[DualIngestor] Notification dispatch error", { err }),
      );

      logger.debug("[DualIngestor] Batch flushed", {
        ...result,
        latestLedger,
        queuePending: this.queue.pending,
      });
    }).catch((err) => logger.error("[DualIngestor] Flush error", { err }));

    return this.throttle.compute(lag);
  }

  // ── Notifications ───────────────────────────────────────────────────────────

  /**
   * Fire "Stream Received" notifications for create events.
   * Runs after the DB flush so we never notify on a failed write.
   */
  private async dispatchCreateNotifications(
    events: SorobanRpc.Api.EventResponse[],
  ): Promise<void> {
    for (const event of events) {
      try {
        const action = this.extractAction(event);
        if (action !== "create") continue;

        const payload = this.decodePayload(event);
        if (!payload?.stream_id) continue;

        await notificationService.notifyStreamReceived({
          streamId: String(payload.stream_id),
          sender: String(payload.sender ?? ""),
          receiver: String(payload.receiver ?? ""),
          amount: String(payload.amount ?? "0"),
          tokenAddress: payload.token ? String(payload.token) : null,
          txHash: event.txHash ?? event.id,
        });
      } catch {
        // Individual notification failures must not abort the loop
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private extractAction(event: SorobanRpc.Api.EventResponse): string | null {
    try {
      const native = scValToNative(event.topic[0]);
      return typeof native === "string" ? native.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  private decodePayload(event: SorobanRpc.Api.EventResponse): Record<string, unknown> | null {
    try {
      const native = scValToNative(event.value);
      return typeof native === "object" && native !== null
        ? (native as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}
