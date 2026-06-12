import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadMarketSnapshot } from "../marketData";
import { bootstrapZeroCurve, _annualFixSchedule } from "../bootstrap";

const MARKET_PATH = resolve(__dirname, "..", "..", "..", "..", "public", "market_2026-03-31.json");

describe("bootstrapZeroCurve (TS) vs Python reference", () => {
  it("reprices every input swap to within 0.01 bp", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);

    let maxAbsErrBp = 0;
    for (const q of snap.curveQuotes) {
      if (q.instrumentType !== "SWAP" || q.tYears <= 1.0) continue;
      const schedule = _annualFixSchedule(q.tYears);
      let pvFixUnit = 0;
      let prev = 0;
      for (const cd of schedule) {
        const z = curve.zeroRate(cd);
        const df = Math.exp(-z * cd);
        const tau = (cd - prev) * (365 / 360);
        pvFixUnit += tau * df;
        prev = cd;
      }
      const dfN = curve.discountFactor(q.tYears);
      const parImplied = (1 - dfN) / pvFixUnit;
      const errBp = Math.abs((parImplied - q.rate) * 1e4);
      maxAbsErrBp = Math.max(maxAbsErrBp, errBp);
    }
    expect(maxAbsErrBp).toBeLessThan(0.01);
  });

  it("zero rate at 10Y matches Python reference within 1e-6", async () => {
    // From `MARKET_JSON=market_2026-03-31.json python bootstrap.py`:
    // t=10y, z=0.038759, DF=0.678693.
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    expect(curve.zeroRate(10.0)).toBeCloseTo(0.038759, 5);
    expect(curve.discountFactor(10.0)).toBeCloseTo(0.678693, 5);
  });

  it("forward rate at 5Y x 1Y matches direct computation", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const f = curve.forwardRate(5.0, 6.0);
    // simply-compounded forward = (DF(5)/DF(6) - 1)
    const expected = curve.discountFactor(5.0) / curve.discountFactor(6.0) - 1;
    expect(f).toBeCloseTo(expected, 12);
  });

  it("forwardSwapRate(0, T) reproduces par OIS quotes within 0.1 bp", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    for (const q of snap.curveQuotes) {
      if (q.instrumentType !== "SWAP" || q.tYears < 1.0) continue;
      const s = curve.forwardSwapRate(0, q.tYears);
      const errBp = Math.abs((s - q.rate) * 1e4);
      expect(errBp).toBeLessThan(0.1);
    }
  });

  it("forwardSwapRate at 1M matches simply-compounded forward", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const tau = 1 / 12;
    const simple = curve.forwardRate(0, tau);
    const swap = curve.forwardSwapRate(0, tau);
    expect(swap).toBeCloseTo(simple, 12);
  });

  it("forwardSwapRate at 10Y is substantially below simply-compounded 10Y forward", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const simple = curve.forwardRate(0, 10);
    const swap = curve.forwardSwapRate(0, 10);
    // Expect at least 50 bps gap given a ~3.87% 10Y rate (compounding effect).
    expect(simple - swap).toBeGreaterThan(0.005);
  });
});
