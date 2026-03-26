import { Router, type Request, type Response } from "express";
import { config } from "../config";
import { decodeCursor, encodeCursor } from "../cursor";
import { countStreams, findStreams, getStream } from "../db";
import type { StreamListQuery, StreamPage } from "../types";

const router = Router();

// ─── GET /api/streams ─────────────────────────────────────────────────────────
/**
 * List streams with cursor-based pagination.
 *
 * Query params:
 *   after    — opaque cursor; return items after this position (forward)
 *   before   — opaque cursor; return items before this position (backward)
 *   limit    — page size (default: DEFAULT_PAGE_SIZE, max: MAX_PAGE_SIZE)
 *   sender   — filter by sender address
 *   receiver — filter by receiver address
 *   status   — filter by status: active | paused | cancelled | completed
 *
 * Response:
 *   {
 *     data: Stream[],
 *     pageInfo: {
 *       nextCursor: string | null,
 *       prevCursor: string | null,
 *       hasNextPage: boolean,
 *       hasPrevPage: boolean,
 *     },
 *     total: number
 *   }
 */
router.get("/", (req: Request, res: Response) => {
  const query = req.query as Record<string, string>;

  // ── Parse & validate limit ─────────────────────────────────────────────────
  let limit = config.defaultPageSize;
  if (query.limit) {
    const parsed = parseInt(query.limit, 10);
    if (isNaN(parsed) || parsed < 1) {
      return res.status(400).json({ error: "limit must be a positive integer" });
    }
    limit = Math.min(parsed, config.maxPageSize);
  }

  // ── Validate status filter ─────────────────────────────────────────────────
  const validStatuses = ["active", "paused", "cancelled", "completed"] as const;
  type Status = (typeof validStatuses)[number];
  let status: Status | undefined;
  if (query.status) {
    if (!validStatuses.includes(query.status as Status)) {
      return res.status(400).json({
        error: `status must be one of: ${validStatuses.join(", ")}`,
      });
    }
    status = query.status as Status;
  }

  const params: StreamListQuery = {
    after: query.after,
    before: query.before,
    limit,
    sender: query.sender,
    receiver: query.receiver,
    status,
  };

  // ── Decode cursors ─────────────────────────────────────────────────────────
  let afterPayload = params.after ? decodeCursor(params.after) : null;
  let beforePayload = params.before ? decodeCursor(params.before) : null;

  if (params.after && !afterPayload) {
    return res.status(400).json({ error: "Invalid `after` cursor" });
  }
  if (params.before && !beforePayload) {
    return res.status(400).json({ error: "Invalid `before` cursor" });
  }

  // ── Fetch limit+1 to detect if there's a next/prev page ───────────────────
  const fetchLimit = limit + 1;

  const rows = findStreams({
    limit: fetchLimit,
    sender: params.sender,
    receiver: params.receiver,
    status: params.status,
    afterId: afterPayload?.id,
    afterCreatedAt: afterPayload?.createdAt,
    beforeId: beforePayload?.id,
    beforeCreatedAt: beforePayload?.createdAt,
  });

  // ── Determine if more pages exist ──────────────────────────────────────────
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);

  // When paginating backward, the DB returns rows in reverse order — restore
  // natural (ASC) order for the response.
  if (beforePayload) {
    pageRows.reverse();
  }

  // ── Build cursors ──────────────────────────────────────────────────────────
  const firstRow = pageRows[0];
  const lastRow = pageRows[pageRows.length - 1];

  const nextCursor =
    !beforePayload && hasMore && lastRow ? encodeCursor(lastRow) : null;

  const prevCursor =
    beforePayload && hasMore && firstRow ? encodeCursor(firstRow) : null;

  // When moving forward, there's a prev page if we used an `after` cursor.
  // When moving backward, there's a next page if we used a `before` cursor.
  const hasNextPage = beforePayload ? !!params.before : hasMore;
  const hasPrevPage = afterPayload ? !!params.after : !!beforePayload && hasMore;

  const total = countStreams({
    sender: params.sender,
    receiver: params.receiver,
    status: params.status,
  });

  const page: StreamPage = {
    data: pageRows,
    pageInfo: {
      nextCursor,
      prevCursor,
      hasNextPage,
      hasPrevPage,
    },
    total,
  };

  return res.json(page);
});

// ─── GET /api/streams/:id ─────────────────────────────────────────────────────
router.get("/:id", (req: Request, res: Response) => {
  const stream = getStream(req.params.id);
  if (!stream) {
    return res.status(404).json({ error: "Stream not found" });
  }
  return res.json(stream);
});

export default router;
