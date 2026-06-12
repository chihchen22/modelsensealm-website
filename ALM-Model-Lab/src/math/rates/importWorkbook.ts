/**
 * In-browser market-data workbook importer.
 *
 * Parses the 4-sheet BBG market-data workbook (SOFR_OIS_Curve, FHLB_Curve,
 * Cap_Volatility, ATM_Swaption_Volatility) into a MarketSnapshot. This is
 * the browser twin of `research/convert_market_data.py`: the two parsers
 * share one contract and must produce identical snapshots (parity-tested in
 * `__tests__/importWorkbook.test.ts` against the converter's JSON output).
 *
 * Conventions (same as the converter):
 *   - rates and vols in DECIMAL per annum, rounded to 1e-7;
 *   - tenor labels normalized: '1 D' -> '1D', '1 MO' -> '1M', '1 YR' -> '1Y',
 *     '1Yr' -> '1Y', '18Mo' -> '18M';
 *   - t_years: 1D = 1/360, k months = k/12 (rounded 1e-6), k years = k;
 *   - cap strikes are ABSOLUTE rates; the 'ATM' column is a separate
 *     explicit ATM-strike quote, not the 0.00% strike column;
 *   - Term LP = FHLB - SOFR per tenor, 1D pinned to 0 at t_years = 0.
 */

import * as XLSX from "xlsx";

import { parseMarketSnapshot, type MarketSnapshot, type RawSnapshot } from "./marketData";

export interface ImportSummary {
  readonly sourceFile: string;
  readonly calibrationDate: string;
  /** true if the date came from the filename (`..._YYYYMMDD.xlsx`). */
  readonly dateFromFilename: boolean;
  readonly curveNodes: number;
  readonly fhlbNodes: number;
  readonly tlpNodes: number;
  readonly capExpiries: number;
  readonly capStrikes: number;
  readonly swaptionExpiries: number;
  readonly swaptionTenors: number;
}

export interface WorkbookImport {
  readonly snapshot: MarketSnapshot;
  readonly summary: ImportSummary;
}

function normTerm(label: unknown): string {
  const m = /^\s*(\d+)\s*(D|MO|YR|Mo|Yr)\s*$/.exec(String(label));
  if (!m) throw new Error(`Unrecognized tenor label: "${String(label)}"`);
  const unit = m[2] === "D" ? "D" : m[2].toUpperCase() === "MO" ? "M" : "Y";
  return `${m[1]}${unit}`;
}

function termYears(term: string): number {
  const n = parseInt(term.slice(0, -1), 10);
  const unit = term.slice(-1);
  if (unit === "D") return Math.round((n / 360) * 1e6) / 1e6;
  if (unit === "M") return Math.round((n / 12) * 1e6) / 1e6;
  return n;
}

/** Round to 1e-7 (0.001 bp), matching the Python converter. */
function dec(v: unknown, where: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`Missing or non-numeric value at ${where}`);
  return Math.round(n * 1e7) / 1e7;
}

/** '-2.00%' -> '-0.02', 'ATM' -> 'ATM'; numeric percent cells pass through. */
function strikeKey(label: unknown): string {
  if (typeof label === "number") return String(Math.round(label * 1e6) / 1e6);
  const s = String(label).trim();
  if (s.toUpperCase() === "ATM") return "ATM";
  const m = /^(-?\d+(?:\.\d+)?)%$/.exec(s);
  if (!m) throw new Error(`Unrecognized cap strike label: "${s}"`);
  return String(Math.round((Number(m[1]) / 100) * 1e6) / 1e6);
}

function sheetRows(wb: XLSX.WorkBook, name: string): unknown[][] {
  const ws = wb.Sheets[name];
  if (!ws) {
    throw new Error(`Missing sheet "${name}". Workbook sheets: ${wb.SheetNames.join(", ")}.`);
  }
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as unknown[][];
}

/**
 * Parse a market-data workbook. The as-of date is taken from a
 * `..._YYYYMMDD.xlsx` filename suffix when present, else `fallbackDate`.
 */
export function importMarketWorkbook(
  bytes: ArrayBuffer | Uint8Array,
  fileName: string,
  fallbackDate: string,
): WorkbookImport {
  const wb = XLSX.read(bytes, { type: bytes instanceof Uint8Array ? "buffer" : "array" });

  const dateMatch = /_(\d{4})(\d{2})(\d{2})\.[a-z]+$/i.exec(fileName);
  const calibrationDate = dateMatch
    ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`
    : fallbackDate;

  // --- SOFR OIS curve: Term | InstType | Mid -------------------------------
  const curveRows = sheetRows(wb, "SOFR_OIS_Curve");
  const instruments: RawSnapshot["curve_sofr_ois"]["instruments"] = [];
  for (const row of curveRows.slice(1)) {
    if (row[0] == null) continue;
    const term = normTerm(row[0]);
    const instType = String(row[1]);
    if (instType !== "CASH" && instType !== "SWAP") {
      throw new Error(`Unexpected InstType "${instType}" at curve tenor ${term}`);
    }
    instruments.push({
      term,
      t_years: termYears(term),
      type: instType,
      rate: dec(row[2], `SOFR_OIS_Curve ${term}`),
    });
  }
  if (instruments.length === 0) throw new Error("SOFR_OIS_Curve has no instrument rows.");

  // --- FHLB curve: Term | Mid ----------------------------------------------
  const fhlbRows = sheetRows(wb, "FHLB_Curve");
  const fhlb: NonNullable<RawSnapshot["fhlb_curve"]>["instruments"] = [];
  for (const row of fhlbRows.slice(1)) {
    if (row[0] == null) continue;
    const term = normTerm(row[0]);
    fhlb.push({ term, t_years: termYears(term), rate: dec(row[1], `FHLB_Curve ${term}`) });
  }
  const curveTerms = instruments.map((q) => q.term).join(",");
  if (fhlb.map((q) => q.term).join(",") !== curveTerms) {
    throw new Error("FHLB tenor set does not match the SOFR curve tenor set.");
  }

  // --- Term LP = FHLB - SOFR, 1D pinned to 0 at t = 0 -----------------------
  const sofrByTerm = new Map(instruments.map((q) => [q.term, q.rate]));
  const tlpNodes: NonNullable<RawSnapshot["tlp_nodes"]> = [];
  for (const q of fhlb) {
    if (q.term === "1D") {
      tlpNodes.push({ term: "1D", t_years: 0, spread: 0 });
      continue;
    }
    const spread = Math.round((q.rate - (sofrByTerm.get(q.term) ?? NaN)) * 1e7) / 1e7;
    if (!(spread > 0)) {
      throw new Error(`Non-positive Term LP at ${q.term}: ${spread}. Check the FHLB sheet.`);
    }
    tlpNodes.push({ term: q.term, t_years: q.t_years, spread });
  }

  // --- Cap vol surface: banner row, header row, then expiry rows ------------
  const capSheet = sheetRows(wb, "Cap_Volatility");
  const capHeader = capSheet[1] ?? [];
  if (String(capHeader[0]).trim() !== "Expiry") {
    throw new Error('Cap_Volatility row 2 must start with an "Expiry" header.');
  }
  const strikeKeys = capHeader.slice(1).filter((c) => c != null).map(strikeKey);
  if (!strikeKeys.includes("ATM")) throw new Error("Cap_Volatility has no explicit ATM column.");
  const capRows: RawSnapshot["cap_vol_surface"]["rows"] = [];
  for (const row of capSheet.slice(2)) {
    if (row[0] == null) continue;
    const expiry = normTerm(row[0]);
    const vols: Record<string, number> = {};
    strikeKeys.forEach((key, i) => {
      vols[key] = dec(row[i + 1], `Cap_Volatility ${expiry} @ ${key}`);
    });
    capRows.push({ expiry, vols });
  }
  if (capRows.length === 0) throw new Error("Cap_Volatility has no expiry rows.");

  // --- ATM swaption vol surface ---------------------------------------------
  const swpnSheet = sheetRows(wb, "ATM_Swaption_Volatility");
  const swpnHeader = swpnSheet[1] ?? [];
  if (String(swpnHeader[0]).trim() !== "Expiry") {
    throw new Error('ATM_Swaption_Volatility row 2 must start with an "Expiry" header.');
  }
  const tenorKeys = swpnHeader.slice(1).filter((c) => c != null).map(normTerm);
  const swpnRows: RawSnapshot["swaption_atm_vol_surface"]["rows"] = [];
  for (const row of swpnSheet.slice(2)) {
    if (row[0] == null) continue;
    const expiry = normTerm(row[0]);
    const vols: Record<string, number> = {};
    tenorKeys.forEach((key, i) => {
      vols[key] = dec(row[i + 1], `ATM_Swaption_Volatility ${expiry} x ${key}`);
    });
    swpnRows.push({ expiry, vols });
  }
  if (swpnRows.length === 0) throw new Error("ATM_Swaption_Volatility has no expiry rows.");

  const raw: RawSnapshot = {
    calibration_date: calibrationDate,
    currency: "USD",
    discounting_index: "SOFR_OIS",
    curve_sofr_ois: { instruments },
    fhlb_curve: { instruments: fhlb },
    tlp_nodes: tlpNodes,
    cap_vol_surface: { rows: capRows },
    swaption_atm_vol_surface: { rows: swpnRows },
  };

  return {
    snapshot: parseMarketSnapshot(raw),
    summary: {
      sourceFile: fileName,
      calibrationDate,
      dateFromFilename: dateMatch !== null,
      curveNodes: instruments.length,
      fhlbNodes: fhlb.length,
      tlpNodes: tlpNodes.length,
      capExpiries: capRows.length,
      capStrikes: strikeKeys.length,
      swaptionExpiries: swpnRows.length,
      swaptionTenors: tenorKeys.length,
    },
  };
}
