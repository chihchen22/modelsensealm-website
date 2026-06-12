/**
 * Market-data loader: TypeScript port of `research/market_data.py`.
 *
 * Mirrors the Python dataclasses with strict TS types. Loads a market
 * snapshot (SOFR OIS curve, optional FHLB curve + Term LP nodes, cap and ATM
 * swaption surfaces) from JSON produced by `research/convert_market_data.py`
 * or the in-browser xlsx importer; both share one contract.
 */

import type { TLPNode } from "./tlpCurve";

export interface CurveQuote {
  readonly term: string;
  readonly tYears: number;
  readonly instrumentType: "CASH" | "SWAP";
  readonly rate: number;
}

export interface SwaptionATMQuote {
  readonly expiryYears: number;
  readonly tenorYears: number;
  readonly normalVol: number;
}

/**
 * Default BGM calibration subset: liquid expiries x core tenors (28 quotes).
 * The 2026-03-31 surface carries 21 expiries x 15 tenors = 315 quotes with
 * tenors out to 30Y; the Rebonato pricer's cost is quadratic in swap length,
 * so calibrating to the full grid takes tens of minutes in TS. The default
 * selection keeps calibration interactive; every quote remains individually
 * selectable on the SABR tab. The Python reference (research/bgm_calibrate.py)
 * applies the same subset.
 */
export const DEFAULT_SWAPTION_CALIB_EXPIRIES: ReadonlyArray<number> = [
  1 / 12, 3 / 12, 6 / 12, 1, 2, 5, 10,
];
export const DEFAULT_SWAPTION_CALIB_TENORS: ReadonlyArray<number> = [1, 2, 5, 10];

export function isDefaultCalibrationSwaption(q: SwaptionATMQuote): boolean {
  const near = (x: number, set: ReadonlyArray<number>) =>
    set.some((v) => Math.abs(x - v) < 1e-9);
  return (
    near(q.expiryYears, DEFAULT_SWAPTION_CALIB_EXPIRIES) &&
    near(q.tenorYears, DEFAULT_SWAPTION_CALIB_TENORS)
  );
}

/**
 * Curated cap-surface display grid for the SABR tab (the pre-2026-03-31
 * vintage granularity): liquid expiries x whole-percent strikes plus ATM.
 * Display-only: every quote in the snapshot stays selectable behind the
 * "full surface" toggle, and the default selection is unaffected.
 */
export const DEFAULT_CAP_DISPLAY_EXPIRIES: ReadonlyArray<number> = [1, 2, 3, 5, 10, 15];
export const DEFAULT_CAP_DISPLAY_STRIKES: ReadonlyArray<number> = [
  -0.02, -0.01, 0.01, 0.02, 0.03, 0.04, 0.05,
];

export function isDefaultDisplayCap(q: CapQuote): boolean {
  const near = (x: number, set: ReadonlyArray<number>) =>
    set.some((v) => Math.abs(x - v) < 1e-9);
  if (!near(q.expiryYears, DEFAULT_CAP_DISPLAY_EXPIRIES)) return false;
  return q.isAtm || (q.strike !== null && near(q.strike, DEFAULT_CAP_DISPLAY_STRIKES));
}

/**
 * One cap vol quote. Strikes are ABSOLUTE rates (decimal); the BBG matrix
 * columns -2.00%..7.00% are strike levels (negative strikes are a
 * negative-rate-era convention), and the ATM quote is a separate explicit
 * column, not the 0.00% strike.
 */
export interface CapQuote {
  readonly expiryYears: number;
  readonly strike: number | null; // null for ATM
  readonly normalVol: number;
  readonly isAtm: boolean;
}

export interface FHLBQuote {
  readonly term: string;
  readonly tYears: number;
  readonly rate: number;
}

export interface MarketSnapshot {
  readonly calibrationDate: string;
  readonly currency: string;
  readonly discountingIndex: string;
  readonly curveQuotes: ReadonlyArray<CurveQuote>;
  readonly capQuotes: ReadonlyArray<CapQuote>;
  readonly swaptionATMQuotes: ReadonlyArray<SwaptionATMQuote>;
  /** FHLB advance curve; empty for snapshots that predate the FHLB block. */
  readonly fhlbCurveQuotes: ReadonlyArray<FHLBQuote>;
  /** Term LP nodes (FHLB - SOFR, 1D pinned to 0 at t=0); empty if absent. */
  readonly tlpNodes: ReadonlyArray<TLPNode>;
}

const TENOR_TO_YEARS: Record<string, number> = {
  "1D": 1 / 360,
  "1M": 1 / 12,
  "2M": 2 / 12,
  "3M": 3 / 12,
  "6M": 6 / 12,
  "9M": 9 / 12,
  "1Y": 1.0,
  "18M": 1.5,
  "2Y": 2.0,
  "3Y": 3.0,
  "4Y": 4.0,
  "5Y": 5.0,
  "6Y": 6.0,
  "7Y": 7.0,
  "8Y": 8.0,
  "9Y": 9.0,
  "10Y": 10.0,
  "12Y": 12.0,
  "15Y": 15.0,
  "20Y": 20.0,
  "25Y": 25.0,
  "30Y": 30.0,
};

function toYears(label: string): number {
  const v = TENOR_TO_YEARS[label];
  if (v === undefined) {
    throw new Error(`Unknown tenor label: ${label}`);
  }
  return v;
}

export interface RawSnapshot {
  calibration_date: string;
  currency: string;
  discounting_index: string;
  curve_sofr_ois: {
    instruments: Array<{ term: string; t_years: number; type: "CASH" | "SWAP"; rate: number }>;
  };
  fhlb_curve?: {
    instruments: Array<{ term: string; t_years: number; rate: number }>;
  };
  tlp_nodes?: Array<{ term: string; t_years: number; spread: number }>;
  cap_vol_surface: {
    rows: Array<{ expiry: string; vols: Record<string, number> }>;
  };
  swaption_atm_vol_surface: {
    rows: Array<{ expiry: string; vols: Record<string, number> }>;
  };
}

export function parseMarketSnapshot(raw: RawSnapshot): MarketSnapshot {
  const curveQuotes: CurveQuote[] = raw.curve_sofr_ois.instruments.map((q) => ({
    term: q.term,
    tYears: q.t_years,
    instrumentType: q.type,
    rate: q.rate,
  }));

  const capQuotes: CapQuote[] = [];
  for (const row of raw.cap_vol_surface.rows) {
    const expiry = toYears(row.expiry);
    for (const [strikeLabel, vol] of Object.entries(row.vols)) {
      const isAtm = strikeLabel === "ATM";
      capQuotes.push({
        expiryYears: expiry,
        strike: isAtm ? null : Number(strikeLabel),
        normalVol: vol,
        isAtm,
      });
    }
  }

  const fhlbCurveQuotes: FHLBQuote[] = (raw.fhlb_curve?.instruments ?? []).map((q) => ({
    term: q.term,
    tYears: q.t_years,
    rate: q.rate,
  }));

  const tlpNodes: TLPNode[] = (raw.tlp_nodes ?? []).map((n) => ({
    tYears: n.t_years,
    spread: n.spread,
  }));

  const swaptionATMQuotes: SwaptionATMQuote[] = [];
  for (const row of raw.swaption_atm_vol_surface.rows) {
    const expiry = toYears(row.expiry);
    for (const [tenorLabel, vol] of Object.entries(row.vols)) {
      swaptionATMQuotes.push({
        expiryYears: expiry,
        tenorYears: toYears(tenorLabel),
        normalVol: vol,
      });
    }
  }

  return {
    calibrationDate: raw.calibration_date,
    currency: raw.currency,
    discountingIndex: raw.discounting_index,
    curveQuotes,
    capQuotes,
    swaptionATMQuotes,
    fhlbCurveQuotes,
    tlpNodes,
  };
}

/** Load a market snapshot from a JSON URL (browser) or path (Node tests). */
export async function loadMarketSnapshot(source: string | URL): Promise<MarketSnapshot> {
  if (typeof window !== "undefined") {
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`Failed to load market data: ${res.status} ${res.statusText}`);
    }
    return parseMarketSnapshot((await res.json()) as RawSnapshot);
  }
  // Node fallback for tests: dynamic import of fs.
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(source as string, "utf-8");
  return parseMarketSnapshot(JSON.parse(text) as RawSnapshot);
}
