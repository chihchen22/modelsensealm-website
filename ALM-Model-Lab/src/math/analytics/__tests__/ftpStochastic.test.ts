import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadMarketSnapshot } from "../../rates/marketData";
import { bootstrapZeroCurve } from "../../rates/bootstrap";
import { calibrateHW } from "../../rates/hwCalibrate";
import { simulateHW, reconstructPathDF } from "../../rates/simulateHw";
import { DEFAULT_TLP_CURVE } from "../../rates/tlpCurve";
import {
  parRateSingle,
  parRatePathAveraged,
  priceSingleAtSpread,
  meanPriceAtSpread,
  solveZSpread,
  solveOAS,
  stochasticFtpTriple,
  type FtpCashflow,
} from "../ftpStochastic";

const MARKET_PATH = resolve(__dirname, "..", "..", "..", "..", "public", "market_2026-03-31.json");

/** Level-principal amortiser: N over `months` equal paydowns, coupon `c`. */
function amortiser(notional: number, months: number, c: number): FtpCashflow[] {
  const prin = notional / months;
  const mr = c / 12;
  const cf: FtpCashflow[] = [];
  let bal = notional;
  for (let m = 1; m <= months; m++) {
    cf.push({ monthOffset: m, balanceStart: bal, principalPaid: prin, interestPaid: bal * mr });
    bal -= prin;
  }
  return cf;
}

describe("ftpStochastic primitives", () => {
  it("parRateSingle returns the analytic par rate of a 1Y bullet", () => {
    // Bullet: principal N at t=1, outstanding N all year. Under flat df=d,
    // r = (N - d·N) / (d·N·1/12) = 12·(1-d)/d. d=0.96 → r = 0.5.
    const N = 1_000_000;
    const bullet: FtpCashflow[] = [
      { monthOffset: 12, balanceStart: N, principalPaid: N, interestPaid: 0 },
    ];
    const r = parRateSingle(bullet, N, () => 0.96);
    expect(r).toBeCloseTo(0.5, 10);
  });

  it("parRateSingle reprices the stream to par by construction", () => {
    const N = 1_000_000;
    const cf = amortiser(N, 36, 0.05);
    const df = (t: number) => Math.exp(-0.04 * t);
    const r = parRateSingle(cf, N, df);
    // PV of principal + r·annuity must return par.
    let repriced = 0;
    for (const c of cf) {
      const t = c.monthOffset / 12;
      repriced += df(t) * (c.principalPaid + r * c.balanceStart * (1 / 12));
    }
    expect(repriced).toBeCloseTo(N, 4);
  });

  it("parRatePathAveraged reprices the mean stream to par", () => {
    const N = 1_000_000;
    const cfA = amortiser(N, 24, 0.05);
    const cfB = amortiser(N, 24, 0.05);
    const dfp = (_p: number, t: number) => Math.exp(-0.03 * t);
    const r = parRatePathAveraged([cfA, cfB], N, dfp);
    let repriced = 0;
    for (const cf of [cfA, cfB]) {
      for (const c of cf) {
        const t = c.monthOffset / 12;
        repriced += dfp(0, t) * (c.principalPaid + r * c.balanceStart * (1 / 12));
      }
    }
    expect(repriced / 2).toBeCloseTo(N, 4);
  });

  it("solveZSpread finds the spread that reprices actual cashflows to par", () => {
    const N = 1_000_000;
    const cf = amortiser(N, 60, 0.06);
    const df = (t: number) => Math.exp(-0.045 * t);
    const z = solveZSpread(cf, df, N);
    expect(priceSingleAtSpread(cf, df, z)).toBeCloseTo(N, 2);
  });

  it("solveOAS finds the spread that reprices the mean price to par", () => {
    const N = 1_000_000;
    const cfA = amortiser(N, 48, 0.06);
    const cfB = amortiser(N, 48, 0.055);
    const baseDfp = (_p: number, t: number) => Math.exp(-0.042 * t);
    const oas = solveOAS([cfA, cfB], baseDfp, N);
    expect(meanPriceAtSpread([cfA, cfB], baseDfp, oas)).toBeCloseTo(N, 2);
  });

  it("stochasticFtpTriple is additive: ir + lp === all", () => {
    const N = 1_000_000;
    const nSteps = 24;
    const cf = amortiser(N, nSteps, 0.05);
    // Two flat-ish per-path DF rows.
    const mk = (rate: number) => {
      const d = new Float64Array(nSteps);
      for (let k = 0; k < nSteps; k++) d[k] = Math.exp(-rate * ((k + 1) / 12));
      return d;
    };
    const Dcorr = [mk(0.04), mk(0.045)];
    const triple = stochasticFtpTriple([cf, cf], N, Dcorr, DEFAULT_TLP_CURVE);
    expect(triple.ir + triple.lp).toBeCloseTo(triple.all, 12);
    // All-in funds over SOFR + positive TLP, so it must exceed IR.
    expect(triple.all).toBeGreaterThan(triple.ir);
  });

  it("reconstructPathDF is a martingale: cross-path mean DF == market DF", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const hw = calibrateHW(snap, curve);
    const sim = simulateHW(curve, hw.a, hw.sigma, {
      horizonYears: 5,
      dtYears: 1 / 12,
      nPairs: 64,
      seed: 20250930n,
    });
    const { meanErrBp } = reconstructPathDF(sim, curve);
    expect(meanErrBp).toBeLessThan(1e-6);
  });
});
