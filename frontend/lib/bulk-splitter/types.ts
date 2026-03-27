// lib/bulk-splitter/types.ts

export interface Voter {
  address: string;
  governance_score: bigint;
  /** Optional internal Tax ID / note — stored backend-only, never on-chain. */
  taxId?: string;
}

export interface Recipient {
  address: string;
  amount: bigint;
  /** Optional internal Tax ID / note — stored backend-only, never on-chain. */
  taxId?: string;
}
