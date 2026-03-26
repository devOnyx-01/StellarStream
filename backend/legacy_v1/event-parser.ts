/**
 * Event parsing and transformation utilities
 */

import { SorobanRpc, xdr, scValToNative } from "@stellar/stellar-sdk";
import { ParsedContractEvent } from "./types";
import { logger } from "./logger";
import * as Sentry from "@sentry/node";

export interface ParsedProposalCreatedEvent {
  id: string;
  creator: string;
  description: string;
  quorum: number;
  votesFor: number;
  votesAgainst: number;
}
/**
 * Parse raw Stellar event into structured format.
 * Event IDs from Soroban RPC follow the format: "<ledger>-<txIndex>-<eventIndex>"
 * We extract eventIndex to support the unique (txHash, eventIndex) constraint.
 */
export function parseContractEvent(
  event: SorobanRpc.Api.EventResponse,
): ParsedContractEvent | null {
  try {
    // Extract eventIndex from the event ID: "<ledger>-<txIndex>-<eventIndex>"
    const eventIndex = parseEventIndex(event.id);

    return {
      id: event.id,
      type: event.type,
      ledger: event.ledger,
      ledgerClosedAt: event.ledgerClosedAt,
      contractId: event.contractId?.toString() ?? "unknown",
      topics: event.topic.map((topic) => topic.toXDR("base64")),
      value: parseScVal(event.value),
      txHash: event.txHash ?? "unknown",
      eventIndex,
      inSuccessfulContractCall: event.inSuccessfulContractCall,
    };
  } catch (error) {
    logger.error("Failed to parse contract event", error, {
      eventId: event.id,
    });
    return null;
  }
}

/**
 * Extract the event index from a Soroban event ID.
 * Format: "<ledger>-<txIndex>-<eventIndex>"
 * Falls back to 0 if the format is unexpected.
 */
function parseEventIndex(eventId: string): number {
  const parts = eventId.split("-");
  if (parts.length >= 3) {
    const idx = parseInt(parts[parts.length - 1], 10);
    return Number.isFinite(idx) ? idx : 0;
  }
  return 0;
}

/**
 * Parse Soroban ScVal to JavaScript value
 */
function parseScVal(scVal: xdr.ScVal): unknown {
  try {
    const type = scVal.switch();

    switch (type.name) {
      case "scvBool":
        return scVal.b();

      case "scvVoid":
      case "scvLedgerKeyContractInstance":
        return null;

      case "scvU32":
        return scVal.u32();

      case "scvI32":
        return scVal.i32();

      case "scvU64":
        return scVal.u64().toString();

      case "scvI64":
        return scVal.i64().toString();

      case "scvU128": {
        const parts = scVal.u128();
        return (
          (BigInt(parts.hi().toString()) << 64n) | BigInt(parts.lo().toString())
        );
      }

      case "scvI128": {
        const parts = scVal.i128();
        return (
          (BigInt(parts.hi().toString()) << 64n) | BigInt(parts.lo().toString())
        );
      }

      case "scvU256":
      case "scvI256":
        return scVal.toXDR("base64");

      case "scvBytes":
        return Buffer.from(scVal.bytes()).toString("hex");

      case "scvString":
        return scVal.str().toString();

      case "scvSymbol":
        return scVal.sym().toString();

      case "scvVec": {
        const vec = scVal.vec();
        return vec ? vec.map((item) => parseScVal(item)) : [];
      }

      case "scvMap": {
        const map = scVal.map();
        if (!map) return {};
        const result: Record<string, unknown> = {};
        map.forEach((entry) => {
          const key = parseScVal(entry.key());
          const val = parseScVal(entry.val());
          result[String(key)] = val;
        });
        return result;
      }

      case "scvAddress":
        return String(scValToNative(scVal));

      case "scvContractInstance":
        return "ContractInstance";

      default:
        return scVal.toXDR("base64");
    }
  } catch (error) {
    Sentry.withScope((scope) => {
      scope.setTag("failure_type", "indexer_failure");
      scope.setTag("event_type", "xdr_parse_failure");
      scope.setContext("xdr_payload", {
        raw: scVal.toXDR("base64"), // the raw XDR strin
      });
      Sentry.captureException(error);
    });
    logger.warn("Failed to parse ScVal, returning raw XDR", { error });
    return scVal.toXDR("base64");
  }
}

/**
 * Extract event type from topics (first topic is usually the event name)
 */
export function extractEventType(topics: string[]): string {
  if (topics.length === 0) return "unknown";

  try {
    const firstTopic = xdr.ScVal.fromXDR(topics[0], "base64");
    const parsed = parseScVal(firstTopic);
    return String(parsed);
  } catch {
    return "unknown";
  }
}

/**
 * Parse a ProposalCreated contract event directly from XDR payload.
 * Returns null when the event is not a proposal creation.
 */
export function parseProposalCreatedEventXdr(
  event: SorobanRpc.Api.EventResponse,
): ParsedProposalCreatedEvent | null {
  try {
    if (event.topic.length === 0) {
      return null;
    }

    const eventName = String(parseScVal(event.topic[0])).toLowerCase();
    if (eventName !== "create" && eventName !== "proposal_created") {
      return null;
    }

    const payload = parseScVal(event.value);
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      return null;
    }

    const data = payload as Record<string, unknown>;
    const proposalId = readId(data.proposal_id ?? data.proposalId ?? data.id);
    if (!proposalId) {
      return null;
    }

    const topicCreator = event.topic[1] ? parseScVal(event.topic[1]) : null;
    const creator = readText(
      data.creator ?? data.sender ?? topicCreator,
      "unknown",
    );
    const description = readText(
      data.description ?? data.title ?? data.metadata,
      `Proposal #${proposalId}`,
    );
    const quorum = readInt(data.quorum ?? data.required_approvals, 0);
    const votesFor = readInt(data.votes_for ?? data.votesFor, 0);
    const votesAgainst = readInt(data.votes_against ?? data.votesAgainst, 0);

    return {
      id: proposalId,
      creator,
      description,
      quorum,
      votesFor,
      votesAgainst,
    };
  } catch (error) {
    logger.warn("Failed to parse ProposalCreated event XDR", { error });
    return null;
  }
}

function readId(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return null;
}

function readText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function readInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  }
  return fallback;
}
