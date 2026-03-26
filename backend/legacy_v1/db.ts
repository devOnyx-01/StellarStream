import type { Stream } from "./types";

/**
 * In-memory stream store.
 *
 * In production this would be a Postgres query layer. The interface is kept
 * intentionally thin so swapping the implementation is a one-file change.
 *
 * Streams are stored sorted by (createdAt ASC, id ASC) — the same order the
 * cursor pagination logic relies on.
 */

const store: Map<string, Stream> = new Map();

/** Insert or update a stream. */
export function upsertStream(stream: Stream): void {
  store.set(stream.id, stream);
}

/** Retrieve a single stream by ID. */
export function getStream(id: string): Stream | undefined {
  return store.get(id);
}

export interface FindStreamsOptions {
  afterId?: string;
  afterCreatedAt?: number;
  beforeId?: string;
  beforeCreatedAt?: number;
  limit: number;
  sender?: string;
  receiver?: string;
  status?: "active" | "paused" | "cancelled" | "completed";
  /** When true, fetch in reverse order (used for `before` cursor). */
  reverse?: boolean;
}

function streamStatus(s: Stream): "active" | "paused" | "cancelled" | "completed" {
  if (s.cancelled) return "cancelled";
  if (s.isPaused) return "paused";
  if (Date.now() / 1000 >= s.endTime) return "completed";
  return "active";
}

/**
 * Cursor-aware stream query.
 *
 * Ordering: (createdAt ASC, id ASC) for forward; reversed for backward.
 * The cursor position is exclusive — the item at the cursor is not included.
 */
export function findStreams(opts: FindStreamsOptions): Stream[] {
  let rows = Array.from(store.values());

  // ── Status filter ──────────────────────────────────────────────────────────
  if (opts.status) {
    rows = rows.filter((s) => streamStatus(s) === opts.status);
  }

  // ── Address filters ────────────────────────────────────────────────────────
  if (opts.sender) {
    rows = rows.filter((s) => s.sender === opts.sender);
  }
  if (opts.receiver) {
    rows = rows.filter((s) => s.receiver === opts.receiver);
  }

  // ── Sort: (createdAt ASC, id ASC) ─────────────────────────────────────────
  rows.sort((a, b) =>
    a.createdAt !== b.createdAt
      ? a.createdAt - b.createdAt
      : Number(BigInt(a.id) - BigInt(b.id))
  );

  // ── Cursor: after (forward) ────────────────────────────────────────────────
  if (opts.afterCreatedAt !== undefined && opts.afterId !== undefined) {
    const afterCreatedAt = opts.afterCreatedAt;
    const afterId = opts.afterId;
    rows = rows.filter(
      (s) =>
        s.createdAt > afterCreatedAt ||
        (s.createdAt === afterCreatedAt && BigInt(s.id) > BigInt(afterId))
    );
  }

  // ── Cursor: before (backward) ─────────────────────────────────────────────
  if (opts.beforeCreatedAt !== undefined && opts.beforeId !== undefined) {
    const beforeCreatedAt = opts.beforeCreatedAt;
    const beforeId = opts.beforeId;
    rows = rows.filter(
      (s) =>
        s.createdAt < beforeCreatedAt ||
        (s.createdAt === beforeCreatedAt && BigInt(s.id) < BigInt(beforeId))
    );
    // Reverse so we get the items immediately before the cursor
    rows.reverse();
  }

  // ── Limit ──────────────────────────────────────────────────────────────────
  return rows.slice(0, opts.limit);
}

/** Total count (for informational purposes only — not used for pagination). */
export function countStreams(opts: Omit<FindStreamsOptions, "limit" | "afterId" | "afterCreatedAt" | "beforeId" | "beforeCreatedAt" | "reverse">): number {
  let rows = Array.from(store.values());
  if (opts.status) rows = rows.filter((s) => streamStatus(s) === opts.status);
  if (opts.sender) rows = rows.filter((s) => s.sender === opts.sender);
  if (opts.receiver) rows = rows.filter((s) => s.receiver === opts.receiver);
  return rows.length;
}

/** Seed with mock data for development. */
export function seedMockData(): void {
  const now = Math.floor(Date.now() / 1000);
  const senders = ["GABC1", "GDEF2", "GHIJ3"];
  const receivers = ["GKLM4", "GNOP5", "GQRS6"];

  for (let i = 1; i <= 50; i++) {
    const stream: Stream = {
      id: String(i),
      sender: senders[i % senders.length],
      receiver: receivers[i % receivers.length],
      token: "CTOKEN_USDC",
      totalAmount: String(i * 1_000_000_000),
      withdrawnAmount: "0",
      startTime: now - 86400 * (50 - i),
      endTime: now + 86400 * i,
      cancelled: i % 13 === 0,
      isPaused: i % 7 === 0,
      createdAt: now - 86400 * (50 - i),
      txHash: `0xmock${i.toString().padStart(4, "0")}`,
    };
    upsertStream(stream);
  }
}
