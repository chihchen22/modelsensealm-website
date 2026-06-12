/**
 * Parity test: the in-browser xlsx importer and the offline Python converter
 * (`research/convert_market_data.py`) share one parsing contract. The
 * importer reads the committed 3/31/2026 workbook fixture and must reproduce
 * the converter's JSON output exactly (1e-7 rounding on both sides).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { importMarketWorkbook } from "../importWorkbook";
import { parseMarketSnapshot } from "../marketData";

const ROOT = resolve(__dirname, "..", "..", "..", "..");
const WORKBOOK_PATH = resolve(ROOT, "research", "data", "SOFR_Market_Data_20260331.xlsx");
const JSON_PATH = resolve(ROOT, "public", "market_2026-03-31.json");

describe("importMarketWorkbook parity with convert_market_data.py", () => {
  const bytes = readFileSync(WORKBOOK_PATH);
  const { snapshot: imported, summary } = importMarketWorkbook(
    new Uint8Array(bytes),
    "SOFR_Market_Data_20260331.xlsx",
    "1999-01-01",
  );
  const converted = parseMarketSnapshot(JSON.parse(readFileSync(JSON_PATH, "utf-8")));

  it("reads the as-of date from the filename", () => {
    expect(summary.dateFromFilename).toBe(true);
    expect(imported.calibrationDate).toBe("2026-03-31");
    expect(imported.calibrationDate).toBe(converted.calibrationDate);
  });

  it("matches the converter's curve quotes exactly", () => {
    expect(imported.curveQuotes.length).toBe(converted.curveQuotes.length);
    imported.curveQuotes.forEach((q, i) => {
      const c = converted.curveQuotes[i];
      expect(q.term).toBe(c.term);
      expect(q.instrumentType).toBe(c.instrumentType);
      expect(q.tYears).toBeCloseTo(c.tYears, 9);
      expect(q.rate).toBeCloseTo(c.rate, 9);
    });
  });

  it("matches the converter's FHLB curve and derived TLP nodes", () => {
    expect(imported.fhlbCurveQuotes.length).toBe(converted.fhlbCurveQuotes.length);
    imported.fhlbCurveQuotes.forEach((q, i) => {
      const c = converted.fhlbCurveQuotes[i];
      expect(q.term).toBe(c.term);
      expect(q.tYears).toBeCloseTo(c.tYears, 9);
      expect(q.rate).toBeCloseTo(c.rate, 9);
    });
    expect(imported.tlpNodes.length).toBe(converted.tlpNodes.length);
    imported.tlpNodes.forEach((n, i) => {
      const c = converted.tlpNodes[i];
      expect(n.tYears).toBeCloseTo(c.tYears, 9);
      expect(n.spread).toBeCloseTo(c.spread, 9);
    });
    // 1D pin: t=0, spread=0.
    expect(imported.tlpNodes[0].tYears).toBe(0);
    expect(imported.tlpNodes[0].spread).toBe(0);
  });

  it("matches the converter's cap surface (absolute strikes + explicit ATM)", () => {
    expect(imported.capQuotes.length).toBe(converted.capQuotes.length);
    expect(imported.capQuotes.length).toBe(15 * 26);
    const key = (q: { expiryYears: number; strike: number | null; isAtm: boolean }) =>
      `${q.expiryYears}_${q.isAtm ? "ATM" : q.strike}`;
    const byKey = new Map(converted.capQuotes.map((q) => [key(q), q]));
    for (const q of imported.capQuotes) {
      const c = byKey.get(key(q));
      expect(c, `converter is missing cap quote ${key(q)}`).toBeDefined();
      expect(q.normalVol).toBeCloseTo(c!.normalVol, 9);
    }
    // One explicit ATM quote per expiry, distinct from the 0.00% strike.
    const atms = imported.capQuotes.filter((q) => q.isAtm);
    expect(atms.length).toBe(15);
    const oneYearAtm = atms.find((q) => q.expiryYears === 1)!;
    const oneYearZeroStrike = imported.capQuotes.find(
      (q) => q.expiryYears === 1 && q.strike === 0,
    )!;
    expect(oneYearAtm.normalVol).not.toBeCloseTo(oneYearZeroStrike.normalVol, 5);
  });

  it("matches the converter's swaption ATM surface", () => {
    expect(imported.swaptionATMQuotes.length).toBe(converted.swaptionATMQuotes.length);
    expect(imported.swaptionATMQuotes.length).toBe(21 * 15);
    const key = (q: { expiryYears: number; tenorYears: number }) =>
      `${q.expiryYears}_${q.tenorYears}`;
    const byKey = new Map(converted.swaptionATMQuotes.map((q) => [key(q), q]));
    for (const q of imported.swaptionATMQuotes) {
      const c = byKey.get(key(q));
      expect(c, `converter is missing swaption quote ${key(q)}`).toBeDefined();
      expect(q.normalVol).toBeCloseTo(c!.normalVol, 9);
    }
  });

  it("falls back to the supplied date when the filename has no date suffix", () => {
    const fallback = importMarketWorkbook(new Uint8Array(bytes), "market.xlsx", "2026-04-30");
    expect(fallback.summary.dateFromFilename).toBe(false);
    expect(fallback.snapshot.calibrationDate).toBe("2026-04-30");
  });
});
