/**
 * Term Liquidity Premium (TLP) curve.
 *
 * The TLP at tenor t is the spread between FHLB advance rates (the bank's
 * actual term-funding source) and the matching-tenor SOFR OIS rate. By
 * convention the overnight TLP is zero — the bank funds overnight at policy
 * rates, not via FHLB advances. The curve interpolates linearly in spread
 * between node tenors and clamps flat outside the bracket.
 *
 * Default values are the 9/30/2025 FHLB - SOFR snapshot:
 *
 *     1D   0 bps     1Y    31 bps      10Y    91 bps
 *     1M  21 bps     2Y    43 bps      20Y   134 bps
 *     3M  19 bps     3Y    50 bps      30Y   153 bps
 *     6M  20 bps     4Y    56 bps
 *                    5Y    56 bps
 *
 * The curve composes additively with the SOFR zero curve to produce the all-in
 * funding curve used by FTP: z_all_in(t) = z_sofr(t) + tlp(t).
 */

export interface TLPCurve {
  /** Tenor nodes in years. */
  readonly t: ReadonlyArray<number>;
  /** Spread at each node, decimal annualised. */
  readonly spread: ReadonlyArray<number>;
  /** Spread at any tenor t (years). Linear in spread between nodes. */
  tlp(t: number): number;
}

export interface TLPNode {
  tYears: number;
  spread: number;
}

/** Default 9/30/2025 FHLB - SOFR TLP curve. */
export const DEFAULT_TLP_NODES: ReadonlyArray<TLPNode> = [
  { tYears: 0, spread: 0.0 },
  { tYears: 1 / 12, spread: 0.0021 },
  { tYears: 3 / 12, spread: 0.0019 },
  { tYears: 6 / 12, spread: 0.0020 },
  { tYears: 1, spread: 0.0031 },
  { tYears: 2, spread: 0.0043 },
  { tYears: 3, spread: 0.0050 },
  { tYears: 4, spread: 0.0056 },
  { tYears: 5, spread: 0.0056 },
  { tYears: 10, spread: 0.0091 },
  { tYears: 20, spread: 0.0134 },
  { tYears: 30, spread: 0.0153 },
];

function lerp(xs: ReadonlyArray<number>, ys: ReadonlyArray<number>, x: number): number {
  if (xs.length === 0) return 0;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[xs.length - 1];
  for (let i = 0; i < xs.length - 1; i++) {
    if (x >= xs[i] && x <= xs[i + 1]) {
      const w = (x - xs[i]) / (xs[i + 1] - xs[i]);
      return ys[i] * (1 - w) + ys[i + 1] * w;
    }
  }
  return ys[ys.length - 1];
}

export function buildTLPCurve(nodes: ReadonlyArray<TLPNode>): TLPCurve {
  const sorted = [...nodes].sort((a, b) => a.tYears - b.tYears);
  // Deduplicate identical tenors, keeping the last spread quoted.
  const t: number[] = [];
  const spread: number[] = [];
  for (const n of sorted) {
    if (t.length > 0 && Math.abs(t[t.length - 1] - n.tYears) < 1e-9) {
      spread[spread.length - 1] = n.spread;
      continue;
    }
    t.push(n.tYears);
    spread.push(n.spread);
  }
  return {
    t,
    spread,
    tlp(time: number): number {
      return lerp(t, spread, time);
    },
  };
}

export const DEFAULT_TLP_CURVE: TLPCurve = buildTLPCurve(DEFAULT_TLP_NODES);

/**
 * Parse a CSV upload of TLP nodes. Expected format (header optional):
 *   tenor_years,tlp_decimal
 *   0,0
 *   0.0833,0.0021
 *   0.25,0.0019
 *   ...
 *
 * Robust to:
 *   - Optional header line (any line that fails to parse as two numbers is skipped)
 *   - Tenor expressed in years (e.g., 0.25 for 3M, 1 for 1Y)
 *   - Spread expressed in decimal (0.0021 = 21 bps) or in percent (0.21 = 21 bps);
 *     a value > 0.5 is interpreted as percent and divided by 100.
 *   - Trailing blank lines, BOMs, Windows line endings
 */
export function parseTLPCurveCSV(csv: string): TLPNode[] {
  const text = csv.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  const out: TLPNode[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(",").map((s) => s.trim());
    if (parts.length < 2) continue;
    const t = Number(parts[0]);
    const sRaw = Number(parts[1]);
    if (!Number.isFinite(t) || !Number.isFinite(sRaw)) continue;
    if (t < 0) continue;
    // Heuristic: percent vs decimal. 21 bps = 0.0021 decimal = 0.21 percent.
    // Anything with absolute value > 0.10 we treat as percent — a "decimal"
    // input over 0.10 would mean a 1000+ bps TLP, well outside any realistic
    // FHLB-SOFR spread, so the percent interpretation is overwhelmingly more
    // likely.
    const spread = Math.abs(sRaw) > 0.10 ? sRaw / 100 : sRaw;
    out.push({ tYears: t, spread });
  }
  return out;
}
