/**
 * ScVal-to-JSON Decoding Pipeline (Issue #480)
 *
 * 1. Decodes raw Soroban ScVal XDR topics/values into native JS objects.
 * 2. Maps contract topic symbols to internal DB action names.
 * 3. Validates the decoded payload against the V2 Stream Zod schema.
 */

import { scValToNative, xdr, SorobanRpc } from "@stellar/stellar-sdk";
import { z } from "zod";

// ── Topic → DB action mapping ─────────────────────────────────────────────────

const TOPIC_ACTION_MAP: Record<string, string> = {
  create:   "create",
  withdraw: "withdraw",
  cancel:   "cancel",
  pause:    "pause",
  resume:   "resume",
};

export function topicToAction(symbol: string): string | null {
  return TOPIC_ACTION_MAP[symbol.toLowerCase()] ?? null;
}

// ── V2 Stream payload schema (Zod) ────────────────────────────────────────────

export const StreamEventPayloadSchema = z.object({
  stream_id:  z.union([z.string(), z.number(), z.bigint()]).transform(String),
  sender:     z.string().optional(),
  receiver:   z.string().optional(),
  amount:     z.union([z.string(), z.number(), z.bigint()]).transform(String).optional(),
  token:      z.string().optional(),
  start_time: z.union([z.string(), z.number(), z.bigint()]).transform(String).optional(),
  end_time:   z.union([z.string(), z.number(), z.bigint()]).transform(String).optional(),
});

export type StreamEventPayload = z.infer<typeof StreamEventPayloadSchema>;

// ── Decoder ───────────────────────────────────────────────────────────────────

export interface DecodedEvent {
  action: string;
  payload: StreamEventPayload;
  raw: unknown;
}

/**
 * Decode a raw Soroban EventResponse into a typed DecodedEvent.
 * Returns null when the event topic is not a recognised stream action
 * or when the payload fails schema validation.
 */
export function decodeEvent(
  event: SorobanRpc.Api.EventResponse,
): DecodedEvent | null {
  if (event.topic.length === 0) return null;

  // Decode first topic (the action symbol)
  const actionSymbol = decodeScValXdr(event.topic[0]);
  if (typeof actionSymbol !== "string") return null;

  const action = topicToAction(actionSymbol);
  if (!action) return null;

  // Decode value payload
  const raw = scValToNative(event.value);

  const result = StreamEventPayloadSchema.safeParse(raw);
  if (!result.success) return null;

  return { action, payload: result.data, raw };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function decodeScValXdr(scVal: xdr.ScVal): unknown {
  try {
    return scValToNative(scVal);
  } catch {
    return null;
  }
}
