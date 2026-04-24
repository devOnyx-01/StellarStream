"use client";

// components/capital-flow-map.tsx
// Issue: Capital Flow Map [Frontend][Data-Viz][Hard]
// Interactive SVG map showing capital beams from sender wallet to global recipients
// during the Execute phase of a split.

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Globe } from "lucide-react";

// ─── Region mapping ───────────────────────────────────────────────────────────
// Maps a Stellar G-address to an approximate SVG coordinate on the world map.
// Uses the first 4 chars of the address as a deterministic seed.

const REGIONS: Array<{ name: string; x: number; y: number }> = [
  { name: "North America", x: 160, y: 130 },
  { name: "South America", x: 220, y: 230 },
  { name: "Western Europe", x: 390, y: 110 },
  { name: "Eastern Europe", x: 450, y: 100 },
  { name: "West Africa",    x: 370, y: 190 },
  { name: "East Africa",    x: 450, y: 200 },
  { name: "Middle East",    x: 490, y: 140 },
  { name: "South Asia",     x: 560, y: 160 },
  { name: "East Asia",      x: 640, y: 130 },
  { name: "Southeast Asia", x: 630, y: 185 },
  { name: "Oceania",        x: 680, y: 240 },
];

function addressToRegion(address: string): { name: string; x: number; y: number } {
  if (!address || address.length < 4) return REGIONS[0];
  const seed = address.charCodeAt(1) + address.charCodeAt(2) + address.charCodeAt(3);
  return REGIONS[seed % REGIONS.length];
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FlowRecipient {
  address: string;
  amount?: string;
  label?: string;
}

interface Props {
  /** Sender's wallet address (origin of all beams) */
  senderAddress?: string;
  /** List of recipients to draw beams to */
  recipients: FlowRecipient[];
  /** When true, beams animate (Execute phase is active) */
  isExecuting: boolean;
  className?: string;
}

// ─── SVG world map paths (simplified continents) ──────────────────────────────

const CONTINENT_PATHS = [
  // North America
  "M 100 80 L 130 70 L 200 75 L 230 100 L 240 130 L 220 160 L 190 170 L 160 160 L 130 140 L 110 120 Z",
  // South America
  "M 190 175 L 220 170 L 250 185 L 260 220 L 255 260 L 235 280 L 210 275 L 195 250 L 185 220 Z",
  // Europe
  "M 360 70 L 410 65 L 440 75 L 450 95 L 430 110 L 400 115 L 370 105 L 355 90 Z",
  // Africa
  "M 360 120 L 400 115 L 430 125 L 440 160 L 435 210 L 415 240 L 390 245 L 365 230 L 350 195 L 348 160 Z",
  // Asia
  "M 450 70 L 560 60 L 660 75 L 700 100 L 690 140 L 650 160 L 580 170 L 510 155 L 460 130 L 445 100 Z",
  // Oceania
  "M 630 210 L 680 205 L 710 220 L 705 250 L 670 255 L 635 245 Z",
];

// ─── Beam component ───────────────────────────────────────────────────────────

function CapitalBeam({
  x1, y1, x2, y2, delay, amount,
}: {
  x1: number; y1: number; x2: number; y2: number;
  delay: number; amount?: string;
}) {
  // Cubic bezier control point — arc upward
  const cx = (x1 + x2) / 2;
  const cy = Math.min(y1, y2) - 60;
  const d = `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;

  return (
    <g>
      {/* Static dim path */}
      <path d={d} fill="none" stroke="rgba(34,211,238,0.12)" strokeWidth="1" />

      {/* Animated travelling dot */}
      <motion.circle
        r={3}
        fill="#22d3ee"
        filter="url(#beam-glow)"
        initial={{ offsetDistance: "0%" }}
        animate={{ offsetDistance: "100%" }}
        transition={{
          duration: 1.6,
          delay,
          repeat: Infinity,
          repeatDelay: 0.8,
          ease: "easeInOut",
        }}
        style={{ offsetPath: `path('${d}')` } as React.CSSProperties}
      />

      {/* Destination pulse */}
      <motion.circle
        cx={x2}
        cy={y2}
        r={5}
        fill="none"
        stroke="#22d3ee"
        strokeWidth="1.5"
        initial={{ scale: 0.5, opacity: 0.8 }}
        animate={{ scale: 2.5, opacity: 0 }}
        transition={{ duration: 1.4, delay, repeat: Infinity, repeatDelay: 1 }}
      />

      {/* Amount label */}
      {amount && (
        <text
          x={x2 + 7}
          y={y2 + 4}
          fontSize="8"
          fill="rgba(34,211,238,0.7)"
          fontFamily="monospace"
        >
          {amount}
        </text>
      )}
    </g>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function CapitalFlowMap({
  senderAddress,
  recipients,
  isExecuting,
  className = "",
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);

  // Sender node — fixed centre-left
  const SENDER = { x: 80, y: 160 };

  const recipientNodes = useMemo(
    () =>
      recipients.map((r) => ({
        ...r,
        region: addressToRegion(r.address),
      })),
    [recipients],
  );

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.02] ${className}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-cyan-400" />
          <span className="text-xs font-semibold tracking-widest text-white/60 uppercase">
            Capital Flow Map
          </span>
        </div>
        <AnimatePresence>
          {isExecuting && (
            <motion.span
              key="executing"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-1.5 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-0.5 text-[10px] font-semibold text-cyan-400"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />
              Executing
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      {/* SVG canvas */}
      <svg
        ref={svgRef}
        viewBox="0 0 780 300"
        className="w-full"
        aria-label="Capital flow map"
      >
        <defs>
          <filter id="beam-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="node-glow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Continent outlines */}
        {CONTINENT_PATHS.map((d, i) => (
          <path
            key={i}
            d={d}
            fill="rgba(255,255,255,0.03)"
            stroke="rgba(255,255,255,0.06)"
            strokeWidth="0.8"
          />
        ))}

        {/* Beams — only animate during Execute phase */}
        <AnimatePresence>
          {isExecuting &&
            recipientNodes.map((r, i) => (
              <CapitalBeam
                key={r.address}
                x1={SENDER.x}
                y1={SENDER.y}
                x2={r.region.x}
                y2={r.region.y}
                delay={i * 0.25}
                amount={r.amount}
              />
            ))}
        </AnimatePresence>

        {/* Static dim lines when not executing */}
        {!isExecuting &&
          recipientNodes.map((r) => {
            const cx = (SENDER.x + r.region.x) / 2;
            const cy = Math.min(SENDER.y, r.region.y) - 60;
            return (
              <path
                key={r.address}
                d={`M ${SENDER.x} ${SENDER.y} Q ${cx} ${cy} ${r.region.x} ${r.region.y}`}
                fill="none"
                stroke="rgba(255,255,255,0.05)"
                strokeWidth="0.8"
                strokeDasharray="3 4"
              />
            );
          })}

        {/* Sender node */}
        <circle
          cx={SENDER.x}
          cy={SENDER.y}
          r={7}
          fill="#22d3ee"
          filter="url(#node-glow)"
        />
        <text
          x={SENDER.x}
          y={SENDER.y + 16}
          textAnchor="middle"
          fontSize="7"
          fill="rgba(34,211,238,0.8)"
          fontFamily="monospace"
        >
          {senderAddress ? `${senderAddress.slice(0, 6)}…` : "Sender"}
        </text>

        {/* Recipient nodes */}
        {recipientNodes.map((r) => (
          <g key={r.address}>
            <circle
              cx={r.region.x}
              cy={r.region.y}
              r={4}
              fill={isExecuting ? "#22d3ee" : "rgba(255,255,255,0.2)"}
              filter={isExecuting ? "url(#node-glow)" : undefined}
            />
            <text
              x={r.region.x}
              y={r.region.y + 12}
              textAnchor="middle"
              fontSize="6.5"
              fill="rgba(255,255,255,0.35)"
              fontFamily="monospace"
            >
              {r.label ?? `${r.address.slice(0, 5)}…`}
            </text>
          </g>
        ))}
      </svg>

      {/* Legend */}
      <div className="flex items-center gap-4 px-4 py-2 border-t border-white/[0.06]">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-cyan-400" />
          <span className="text-[10px] text-white/30">Sender</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-white/20" />
          <span className="text-[10px] text-white/30">Recipient</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-px w-4 bg-cyan-400/40" />
          <span className="text-[10px] text-white/30">Capital beam</span>
        </div>
        <span className="ml-auto text-[10px] text-white/20">
          {recipients.length} recipient{recipients.length !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  );
}
