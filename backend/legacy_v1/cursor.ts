import type { Cursor, CursorPayload, Stream } from "./types";

/** Encode a stream position into an opaque base64 cursor. */
export function encodeCursor(stream: Stream): Cursor {
  const payload: CursorPayload = {
    id: stream.id,
    createdAt: stream.createdAt,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/** Decode a cursor back to its payload. Returns null if invalid. */
export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as CursorPayload;
    if (typeof parsed.id !== "string" || typeof parsed.createdAt !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
