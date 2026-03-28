"use client";

// #772 – Post-Submission Summary: deep-links every operation hash to Stellar.Expert

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ExternalLink, CheckCircle2, Copy } from "lucide-react";

const STELLAR_EXPERT_BASE =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet"
    ? "https://stellar.expert/explorer/public/op"
    : "https://stellar.expert/explorer/testnet/op";

interface OperationRow {
  index: number;
  operationId: string;
  url: string;
}

function buildRows(txHash: string, opCount: number): OperationRow[] {
  // Stellar operation IDs are derived from the transaction hash + operation index.
  // Format: <tx_hash_as_decimal_u256> * 100 + op_index  (simplified display here).
  // In production replace with the real IDs from the transaction envelope result.
  return Array.from({ length: opCount }, (_, i) => {
    const operationId = `${txHash.slice(0, 16)}…op${i}`;
    return { index: i, operationId, url: `${STELLAR_EXPERT_BASE}/${operationId}` };
  });
}

function CopyButton({ text }: { text: string }) {
  async function copy() {
    await navigator.clipboard.writeText(text);
  }
  return (
    <button
      onClick={copy}
      aria-label="Copy operation ID"
      className="ml-2 text-white/30 hover:text-white/70 transition-colors"
    >
      <Copy size={13} />
    </button>
  );
}

function ReportContent() {
  const params = useSearchParams();
  const txHash = params.get("tx") ?? "demo_tx_hash_placeholder";
  const opCount = Number(params.get("ops") ?? "3");
  const rows = buildRows(txHash, opCount);

  return (
    <div className="min-h-screen bg-black text-white px-4 py-10 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <CheckCircle2 className="text-emerald-400 h-7 w-7 flex-shrink-0" />
        <div>
          <h1 className="text-xl font-bold">Split Submitted</h1>
          <p className="text-sm text-white/50 mt-0.5">
            Transaction confirmed on the Stellar network.
          </p>
        </div>
      </div>

      {/* Tx hash */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-6">
        <p className="text-xs text-white/40 uppercase tracking-wider mb-1">Transaction Hash</p>
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-white/80 break-all">{txHash}</span>
          <CopyButton text={txHash} />
        </div>
      </div>

      {/* Operations table */}
      <p className="text-xs text-white/40 uppercase tracking-wider mb-3">
        Operations ({rows.length})
      </p>
      <div className="rounded-xl border border-white/10 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-white/[0.03]">
              <th className="text-left px-4 py-3 text-white/40 font-normal">#</th>
              <th className="text-left px-4 py-3 text-white/40 font-normal">Operation ID</th>
              <th className="px-4 py-3 text-white/40 font-normal text-right">Explorer</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.index}
                className="border-b border-white/5 last:border-0 hover:bg-white/[0.02] transition-colors"
              >
                <td className="px-4 py-3 text-white/40">{row.index + 1}</td>
                <td className="px-4 py-3 font-mono text-white/70">
                  {row.operationId}
                  <CopyButton text={row.operationId} />
                </td>
                <td className="px-4 py-3 text-right">
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-indigo-400 hover:text-indigo-300 transition-colors"
                  >
                    View
                    <ExternalLink size={13} />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-6 text-xs text-white/30 text-center">
        Links open Stellar.Expert in a new tab. Data is read-only and non-custodial.
      </p>
    </div>
  );
}

export default function SplitReportPage() {
  return (
    <Suspense>
      <ReportContent />
    </Suspense>
  );
}
