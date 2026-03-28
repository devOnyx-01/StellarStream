"use client";

// components/recipient-grid.tsx
// Issue #779 — Memo-Batcher for Exchanges
// Adds a Memo column (type + value) to the recipient grid with validation.

import { useState, useCallback } from "react";
import type { MemoType } from "@/lib/bulk-splitter/types";

export interface RecipientRow {
  id: string;
  address: string;
  amount: string;
  memoType: MemoType;
  memo: string;
  /** Validation error for the memo field */
  memoError?: string;
}

// ── Validation ───────────────────────────────────────────────────────────────

function validateMemo(type: MemoType, value: string): string | undefined {
  if (type === "none" || !value) return undefined;
  if (type === "text") {
    // Stellar text memo: max 28 bytes
    if (new TextEncoder().encode(value).length > 28)
      return "Text memo must be ≤ 28 bytes";
    return undefined;
  }
  if (type === "id") {
    // Stellar ID memo: unsigned 64-bit integer
    if (!/^\d+$/.test(value)) return "ID memo must be a positive integer";
    if (BigInt(value) > 18446744073709551615n) return "ID memo exceeds u64 max";
    return undefined;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function emptyRow(id: string): RecipientRow {
  return { id, address: "", amount: "", memoType: "none", memo: "" };
}

let _id = 0;
const nextId = () => String(++_id);

// ── Sub-components ───────────────────────────────────────────────────────────

function MemoTypeSelect({
  value,
  onChange,
}: {
  value: MemoType;
  onChange: (v: MemoType) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as MemoType)}
      className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-2 py-1.5 text-xs text-white/80 focus:border-cyan-400/50 focus:outline-none"
    >
      <option value="none">None</option>
      <option value="text">Text</option>
      <option value="id">ID</option>
    </select>
  );
}

// ── RecipientGrid ─────────────────────────────────────────────────────────────

interface Props {
  /** Controlled rows — pass [] to start empty */
  rows: RecipientRow[];
  onChange: (rows: RecipientRow[]) => void;
}

export function RecipientGrid({ rows, onChange }: Props) {
  const update = useCallback(
    (id: string, patch: Partial<RecipientRow>) => {
      onChange(
        rows.map((r) => {
          if (r.id !== id) return r;
          const updated = { ...r, ...patch };
          // Re-validate memo whenever type or value changes
          if ("memoType" in patch || "memo" in patch) {
            updated.memoError = validateMemo(updated.memoType, updated.memo);
          }
          return updated;
        }),
      );
    },
    [rows, onChange],
  );

  const addRow = () => onChange([...rows, emptyRow(nextId())]);
  const removeRow = (id: string) => onChange(rows.filter((r) => r.id !== id));

  // ── CSV import ─────────────────────────────────────────────────────────────
  function handleCSVImport(raw: string) {
    const lines = raw.trim().split(/\r?\n/).filter(Boolean);
    const header = lines[0].toLowerCase().split(",").map((h) => h.trim());
    const addrIdx = header.indexOf("address");
    const amtIdx = header.indexOf("amount");
    const memoIdx = header.indexOf("memo");
    const memoTypeIdx = header.indexOf("memo_type");
    const dataLines = addrIdx >= 0 ? lines.slice(1) : lines;

    const parsed: RecipientRow[] = dataLines.map((line) => {
      const cols = line.split(",");
      const memoType = (memoTypeIdx >= 0 ? cols[memoTypeIdx]?.trim() : "none") as MemoType;
      const memo = memoIdx >= 0 ? (cols[memoIdx]?.trim() ?? "") : "";
      const row: RecipientRow = {
        id: nextId(),
        address: addrIdx >= 0 ? (cols[addrIdx]?.trim() ?? "") : (cols[0]?.trim() ?? ""),
        amount: amtIdx >= 0 ? (cols[amtIdx]?.trim() ?? "") : (cols[1]?.trim() ?? ""),
        memoType: ["none", "text", "id"].includes(memoType) ? memoType : "none",
        memo,
      };
      row.memoError = validateMemo(row.memoType, row.memo);
      return row;
    });
    onChange(parsed);
  }

  const hasErrors = rows.some((r) => r.memoError);

  return (
    <div className="space-y-3">
      {/* CSV import */}
      <div className="flex items-center justify-between">
        <p className="text-[10px] tracking-widest text-white/30 uppercase">Recipients</p>
        <label className="cursor-pointer rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-[11px] text-white/50 hover:text-white/80 transition-colors">
          Import CSV
          <input
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = (ev) => handleCSVImport(ev.target?.result as string);
              reader.readAsText(file);
            }}
          />
        </label>
      </div>

      {/* Table header */}
      <div className="grid grid-cols-[1fr_100px_90px_120px_24px] gap-2 px-1">
        {["Address", "Amount", "Memo Type", "Memo Value", ""].map((h) => (
          <span key={h} className="text-[10px] font-bold tracking-widest text-white/30 uppercase">
            {h}
          </span>
        ))}
      </div>

      {/* Rows */}
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.id} className="space-y-1">
            <div className="grid grid-cols-[1fr_100px_90px_120px_24px] gap-2 items-center">
              {/* Address */}
              <input
                value={row.address}
                onChange={(e) => update(row.id, { address: e.target.value })}
                placeholder="G… or *stellar.org"
                className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs text-white/80 placeholder-white/20 focus:border-cyan-400/50 focus:outline-none font-mono"
              />
              {/* Amount */}
              <input
                value={row.amount}
                onChange={(e) => update(row.id, { amount: e.target.value })}
                placeholder="0.00"
                type="number"
                min="0"
                className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs text-white/80 placeholder-white/20 focus:border-cyan-400/50 focus:outline-none"
              />
              {/* Memo type */}
              <MemoTypeSelect
                value={row.memoType}
                onChange={(v) => update(row.id, { memoType: v, memo: "" })}
              />
              {/* Memo value */}
              <input
                value={row.memo}
                onChange={(e) => update(row.id, { memo: e.target.value })}
                disabled={row.memoType === "none"}
                placeholder={
                  row.memoType === "id"
                    ? "e.g. 123456789"
                    : row.memoType === "text"
                    ? "e.g. invoice-42"
                    : "—"
                }
                className={`rounded-lg border px-3 py-1.5 text-xs text-white/80 placeholder-white/20 focus:outline-none transition-colors ${
                  row.memoError
                    ? "border-red-400/50 bg-red-400/[0.05] focus:border-red-400"
                    : "border-white/[0.08] bg-white/[0.04] focus:border-cyan-400/50"
                } disabled:opacity-30`}
              />
              {/* Remove */}
              <button
                onClick={() => removeRow(row.id)}
                className="flex h-6 w-6 items-center justify-center rounded-md text-white/20 hover:text-red-400/70 transition-colors"
              >
                ✕
              </button>
            </div>
            {/* Inline memo error */}
            {row.memoError && (
              <p className="pl-[calc(1fr+100px+90px+8px)] text-[10px] text-red-400/80 col-start-4">
                ⚠ {row.memoError}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Add row */}
      <button
        onClick={addRow}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-white/[0.1] py-2.5 text-xs text-white/30 hover:border-cyan-400/30 hover:text-cyan-400/60 transition-colors"
      >
        + Add Recipient
      </button>

      {/* Validation summary */}
      {hasErrors && (
        <div className="rounded-xl border border-red-400/20 bg-red-400/[0.05] px-4 py-2.5">
          <p className="text-[11px] text-red-400/80">
            ⚠ Some memo values are invalid. Please fix them before dispatching.
          </p>
        </div>
      )}
    </div>
  );
}
