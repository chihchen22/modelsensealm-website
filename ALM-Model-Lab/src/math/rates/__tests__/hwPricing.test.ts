import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadMarketSnapshot } from "../marketData";
import { bootstrapZeroCurve } from "../bootstrap";
import { hwCapletNormalVol, hwSwaptionNormalVol, bFunction, hwBondPrice } from "../hwPricing";
import type { ZeroCurve } from "../bootstrap";
import { calibrateHW } from "../hwCalibrate";

const MARKET_PATH = resolve(__dirname, "..", "..", "..", "..", "public", "market_2026-03-31.json");

describe("HW pricing", () => {
  it("B(tau) matches the closed form (1 - exp(-a*tau))/a", () => {
    expect(bFunction(0.05, 1.0)).toBeCloseTo((1 - Math.exp(-0.05)) / 0.05, 12);
    expect(bFunction(0.05, 5.0)).toBeCloseTo((1 - Math.exp(-0.25)) / 0.05, 12);
  });

  it("B(tau) -> tau as a -> 0 (small-a expansion)", () => {
    expect(bFunction(1e-12, 0.25)).toBeCloseTo(0.25, 10);
    expect(bFunction(1e-12, 1.0)).toBeCloseTo(1.0, 10);
  });

  it("HW caplet smoke values match Python reference (a=0.05, sigma=0.01, F=0.036)", () => {
    // From `python hw_pricing.py`:
    //   T=1: 97.82 bp, T=2: 95.46, T=5: 88.95, T=10: 79.72, T=15: 72.16
    const a = 0.05;
    const sigma = 0.01;
    const F = 0.036;
    const tauU = 0.25;
    const expected: Array<[number, number]> = [
      [1.0, 0.009782],
      [2.0, 0.009546],
      [5.0, 0.008895],
      [10.0, 0.007972],
      [15.0, 0.007216],
    ];
    for (const [T, want] of expected) {
      const v = hwCapletNormalVol(a, sigma, T, tauU, F);
      expect(v).toBeCloseTo(want, 5);
    }
  });

  it("hwBondPrice at X=0 equals the no-arbitrage forward DF ratio", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const t = 5.0;
    const tau = 5.0;
    const P0_t = curve.discountFactor(t);
    const P0_T = curve.discountFactor(t + tau);
    const a = 0.05;
    const sigma = 0.01;
    const P_at_zero = hwBondPrice(P0_t, P0_T, a, sigma, t, tau, 0.0);
    // V(t,tau) = (sigma^2/(4a))(1-e^(-2at)) B(tau)^2 -> a positive shrinkage
    // factor; P(t, t+tau) at X=0 = (P0_T/P0_t) * exp(-V) <= P0_T/P0_t.
    expect(P_at_zero).toBeLessThan(P0_T / P0_t);
    expect(P_at_zero).toBeGreaterThan((P0_T / P0_t) * 0.99);
  });
});

describe("HW swaption normal vol", () => {
  // buildSwap and hwSwaptionNormalVol only touch discountFactor; a flat
  // 4% continuously-compounded curve is enough.
  const flatCurve = {
    discountFactor: (t: number) => Math.exp(-0.04 * t),
  } as unknown as ZeroCurve;

  it("1-period swaption is consistent with the caplet closed form", () => {
    // Same Gaussian-factor freeze: the 1-period swaption's dS/dX collapses to
    // B(τ)(1 + S·τ_s)/τ_s while the caplet uses B(τ_u)(1 + F·τ_u)/τ_u. With a
    // 1Y calendar gap vs ACT/360 accrual (365/360) the two differ only by the
    // accrual convention — within 2%.
    const a = 0.05;
    const sigma = 0.01;
    const F = Math.exp(0.04) - 1; // 1Y simple forward on the flat curve
    for (const T of [1, 2, 5, 10]) {
      const sw = hwSwaptionNormalVol(flatCurve, a, sigma, T, T + 1);
      const cap = hwCapletNormalVol(a, sigma, T, 1.0, F);
      expect(Math.abs(sw - cap) / cap).toBeLessThan(0.02);
    }
  });

  it("declines with expiry under mean reversion; small-a guard holds", () => {
    const a = 0.05;
    const sigma = 0.01;
    const v1 = hwSwaptionNormalVol(flatCurve, a, sigma, 1, 6);
    const v10 = hwSwaptionNormalVol(flatCurve, a, sigma, 10, 15);
    expect(v1).toBeGreaterThan(0);
    expect(v10).toBeGreaterThan(0);
    // Mean reversion damps the factor's per-annum variance as expiry grows.
    expect(v10).toBeLessThan(v1);
    // a -> 0: integrated variance -> sigma^2 * T, no division blow-up.
    const v0 = hwSwaptionNormalVol(flatCurve, 1e-12, sigma, 5, 10);
    expect(Number.isFinite(v0)).toBe(true);
    expect(v0).toBeGreaterThan(0);
  });
});

describe("HW calibration vs Python reference", () => {
  it("fits the 3/31/2026 ATM cap surface near (a~0.0001, sigma~0.0092, RMSE~7.77 bp)", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const fit = calibrateHW(snap, curve);

    // Python reference (MARKET_JSON=market_2026-03-31.json research/hw_calibrate.py):
    // a=0.000100, sigma=0.009160, RMSE=7.7742 bp on 15 ATM expiries.
    // The 3/31 Cap_Volatility export was quoted 10x too small (1Y ATM read
    // 6.5 bp against ~57 bp at 9/30 while the swaption surface barely moved);
    // the owner confirmed the units error and the surface was corrected x10 at
    // source (research/data/SOFR_Market_Data_20260331.xlsx). Cap ATM normal
    // vols now sit ~64-99 bp, in line with the 9/30 vintage. These pins
    // validate the TS-vs-Python optimizer agreement on the corrected data.
    expect(fit.rmseBp).toBeCloseTo(7.7742, 1);          // RMSE within 0.05 bp
    expect(fit.sigma).toBeCloseTo(0.00916, 4);          // sigma within 1e-4
    expect(fit.a).toBeLessThan(0.005);                  // a hits lower bound region
    expect(fit.expiries).toHaveLength(15);
  });
});
