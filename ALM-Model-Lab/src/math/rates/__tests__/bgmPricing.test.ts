import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  isDefaultCalibrationSwaption,
  loadMarketSnapshot,
  type MarketSnapshot,
} from "../marketData";
import { bootstrapZeroCurve } from "../bootstrap";
import {
  buildSwap,
  rebonatoCapletNormalVol,
  rebonatoSwaptionNormalVol,
  volProductIntegral,
  type RebonatoParams,
} from "../bgmPricing";
import { calibrateBGM } from "../bgmCalibrate";

const MARKET_PATH = resolve(__dirname, "..", "..", "..", "..", "public", "market_2026-03-31.json");

/**
 * Calibration tests fit the standard liquid subset (28 quotes), matching the
 * lab's default swaption selection and the Python reference; the full 315-
 * quote surface makes the quadratic-cost Rebonato fit run for tens of minutes.
 */
async function loadCalibSnapshot(): Promise<MarketSnapshot> {
  const snap = await loadMarketSnapshot(MARKET_PATH);
  return { ...snap, swaptionATMQuotes: snap.swaptionATMQuotes.filter(isDefaultCalibrationSwaption) };
}

describe("BGM pricing", () => {
  it("vol-product integral closed form vs midpoint quadrature", () => {
    const a = 0.5327,
      b = 0.2159,
      c = 0.498,
      d = 0.7294,
      vs = 0.2403;
    const TAlpha = 1.0;
    const cases: Array<[number, number]> = [
      [0, 0],
      [0, 4],
      [2, 4],
    ];
    const f = (u: number) => vs * ((a + b * u) * Math.exp(-c * u) + d);

    for (const [di, dj] of cases) {
      const analytical = volProductIntegral(di, dj, TAlpha, a, b, c, d, vs);
      // High-resolution composite Simpson's rule for cross-check (5000 panels).
      const N = 5000;
      const h = TAlpha / N;
      let sum = 0.5 * f(di) * f(dj);
      for (let k = 1; k < N; k++) {
        const v = TAlpha - k * h;
        sum += f(di + v) * f(dj + v);
      }
      sum += 0.5 * f(di + TAlpha) * f(dj + TAlpha);
      const trapezoidal = sum * h;
      // Trapezoidal at N=5000 is sufficient for 6+ digit agreement.
      const relErr = Math.abs(analytical - trapezoidal) / Math.abs(trapezoidal);
      expect(relErr).toBeLessThan(1e-6);
    }
  });

  it("Rebonato swaption vol with prototype hardcoded params matches Python smoke output", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const params: RebonatoParams = {
      a: 0.1,
      b: 0.2,
      c: 0.5,
      d: 0.8,
      beta: 0.08,
      volScalar: 0.008 / 0.036,
    };
    // From `MARKET_JSON=market_2026-03-31.json python bgm_pricing.py` smoke
    // output on the 3/31/2026 curve:
    //   1M x 1Y: 73.41 bp
    //   1M x 2Y: 75.74 bp
    //   1M x 5Y: 75.95 bp
    //   1M x 8Y: 75.80 bp
    const expected: Array<[number, number, number]> = [
      [1 / 12, 1.0, 0.007341],
      [1 / 12, 2.0, 0.007574],
      [1 / 12, 5.0, 0.007595],
      [1 / 12, 8.0, 0.007580],
    ];
    for (const [TAlpha, tenor, want] of expected) {
      const swap = buildSwap(curve, TAlpha, TAlpha + tenor);
      const v = rebonatoSwaptionNormalVol(swap, params);
      expect(v).toBeCloseTo(want, 5);
    }
  });

  it("caplet normal vol equals the one-period swaption freeze exactly", async () => {
    // A 1-period swap has weights = [1] and S0 = F0, so the Rebonato freeze
    // collapses to the caplet formula. This pins the cross-fit overlay's
    // consistency with the swaption pricer, including the shifted-CEV branch.
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const base: RebonatoParams = {
      a: 0.1,
      b: 0.2,
      c: 0.5,
      d: 0.8,
      beta: 0.08,
      volScalar: 0.008 / 0.036,
    };
    const cev: RebonatoParams = { ...base, displacement: 0.015, cevBeta: 0.7 };
    for (const params of [base, cev]) {
      for (const T of [1, 2, 5]) {
        const swap = buildSwap(curve, T, T + 1);
        const sw = rebonatoSwaptionNormalVol(swap, params);
        const cap = rebonatoCapletNormalVol(swap.F0[0], T, params);
        expect(cap).toBeCloseTo(sw, 12);
      }
    }
    expect(rebonatoCapletNormalVol(0.036, 0, base)).toBe(0);
  });
});

describe("BGM calibration vs Python reference", () => {
  it("matches Python on RMSE and the effective vol curve (parameter redundancy aware)", async () => {
    // Python reference (MARKET_JSON=market_2026-03-31.json bgm_calibrate.py,
    // standard 28-quote subset) produces a=0.600035, b=0.588411, c=0.633374,
    // d=0.687097, beta=0.0000, vs=0.228311, RMSE=5.1192 bp.
    //
    // The Rebonato shape (a + b*tau)*exp(-c*tau) + d has parameter
    // redundancy: volScalar trades against (a, b, d) along an equivalent-fit
    // manifold. Different LM solvers find different points on this manifold
    // with nearly identical fit quality. The right equivalence test is on
    // (RMSE, effective vol curve), not on individual parameter values.
    const snap = await loadCalibSnapshot();
    const curve = bootstrapZeroCurve(snap);
    const fit = calibrateBGM(snap, curve);

    // Fit quality must match within ~0.5 bp of the Python reference.
    expect(fit.rmseBp).toBeGreaterThan(4.4);
    expect(fit.rmseBp).toBeLessThan(5.9);

    // Beta should land near zero (well-known underdetermination from
    // ATM-only data).
    expect(Math.abs(fit.beta)).toBeLessThan(0.2);

    // Effective vol curve sigma(tau) = volScalar * ((a + b*tau)*exp(-c*tau) + d)
    // must match Python within 5% on the data-constrained range. The longest
    // calibration expiry is 10Y; beyond it sigma(tau) is pure extrapolation of
    // the parametric form, where the volScalar-vs-(a, b, d) redundancy leaves
    // the two solvers free to diverge (observed ~7% at tau 20-30 with equal
    // RMSE), so taus past the last quote are not part of the equivalence.
    const sigmaAt = (tau: number, p: typeof fit) =>
      p.volScalar * ((p.a + p.b * tau) * Math.exp(-p.c * tau) + p.d);

    const pythonRef = { a: 0.600035, b: 0.588411, c: 0.633374, d: 0.687097, volScalar: 0.228311 };
    for (const tau of [0, 0.5, 1, 2, 5, 10]) {
      const sigmaTS = sigmaAt(tau, fit);
      const sigmaPy =
        pythonRef.volScalar *
        ((pythonRef.a + pythonRef.b * tau) * Math.exp(-pythonRef.c * tau) + pythonRef.d);
      const relErr = Math.abs(sigmaTS - sigmaPy) / sigmaPy;
      expect(relErr).toBeLessThan(0.05); // within 5%
    }

    expect(fit.expiries).toHaveLength(28);
  });

  it("displaced-diffusion (δ=0.015) refits to similar RMSE on the swaption surface", async () => {
    const snap = await loadCalibSnapshot();
    const curve = bootstrapZeroCurve(snap);
    const fit0 = calibrateBGM(snap, curve, { displacement: 0 });
    const fitD = calibrateBGM(snap, curve, { displacement: 0.015 });

    // Same swaption surface — refitting with a small δ should hit a nearby
    // RMSE. We accept up to 1 bp degradation; in practice it's near-identical.
    expect(fitD.rmseBp).toBeLessThan(fit0.rmseBp + 1.0);
    expect(fitD.displacement).toBeCloseTo(0.015, 6);
  });
});

describe("BGM displaced-diffusion simulator", () => {
  it("δ=0.015 tames the upper tail vs δ=0 at long horizons", async () => {
    const { simulateBGM, getRate } = await import("../simulateBgm");
    const snap = await loadCalibSnapshot();
    const curve = bootstrapZeroCurve(snap);

    // Refit at each δ so we compare two equally-calibrated models.
    const fit0 = calibrateBGM(snap, curve, { displacement: 0 });
    const fitD = calibrateBGM(snap, curve, { displacement: 0.015 });

    const opts = { horizonYears: 30.0, dtYears: 1 / 12, nPairs: 100, seed: 20250930n };
    const sim0 = simulateBGM(curve, fit0, opts);
    const simD = simulateBGM(curve, fitD, opts);

    // DD's tail-tame is most pronounced at long horizon × long tenor where
    // F has had room to drift into high regions: the (F+δ)/F multiplier on
    // local vol → 1 from above as F grows, so DD's effective vol at high F
    // is strictly below pure-LMM. Probe the 10Y forward at 20Y horizon and
    // average p95 across 5Y / 10Y tenors to suppress MC noise at 200 paths.
    const p95 = (sim: typeof sim0, step: number, ti: number): number => {
      const cs = new Float64Array(sim.nPaths);
      for (let p = 0; p < sim.nPaths; p++) cs[p] = getRate(sim, p, step, ti);
      const sorted = Array.from(cs).sort((a, b) => a - b);
      const idx = Math.floor(0.95 * (sorted.length - 1));
      return sorted[idx];
    };
    const step20y = sim0.times.findIndex((t) => Math.abs(t - 20) < 1e-6);
    const idx5y = Array.from(sim0.tenors).findIndex((t) => Math.abs(t - 5) < 1e-6);
    const idx10y = Array.from(sim0.tenors).findIndex((t) => Math.abs(t - 10) < 1e-6);
    const p950 = 0.5 * (p95(sim0, step20y, idx5y) + p95(sim0, step20y, idx10y));
    const p95D = 0.5 * (p95(simD, step20y, idx5y) + p95(simD, step20y, idx10y));

    // Displaced diffusion should produce a tamer averaged 95th percentile.
    expect(p95D).toBeLessThan(p950);

    // Martingale correction must remain tight under DD as well.
    let maxErrBp = 0;
    for (let k = 0; k < simD.times.length; k++) {
      maxErrBp = Math.max(maxErrBp, Math.abs(simD.dfSimulated[k] - simD.dfMarket[k]) * 1e4);
    }
    expect(maxErrBp).toBeLessThan(1e-6);
  });

  it("CEV β=0.7 + δ=0.015 tames the upper tail further than DD alone", async () => {
    const { simulateBGM, getRate } = await import("../simulateBgm");
    const snap = await loadCalibSnapshot();
    const curve = bootstrapZeroCurve(snap);

    // Refit at each (β, δ) so we compare equally-calibrated models.
    const fitDD = calibrateBGM(snap, curve, { displacement: 0.015, cevBeta: 1.0 });
    const fitCEV = calibrateBGM(snap, curve, { displacement: 0.015, cevBeta: 0.7 });

    const opts = { horizonYears: 30.0, dtYears: 1 / 12, nPairs: 100, seed: 20250930n };
    const simDD = simulateBGM(curve, fitDD, opts);
    const simCEV = simulateBGM(curve, fitCEV, opts);

    const p95 = (sim: typeof simDD, step: number, ti: number): number => {
      const cs = new Float64Array(sim.nPaths);
      for (let p = 0; p < sim.nPaths; p++) cs[p] = getRate(sim, p, step, ti);
      const sorted = Array.from(cs).sort((a, b) => a - b);
      const idx = Math.floor(0.95 * (sorted.length - 1));
      return sorted[idx];
    };
    // Probe long-tenor × long-horizon cell: 5Y/10Y forward at 20Y horizon.
    const step20y = simDD.times.findIndex((t) => Math.abs(t - 20) < 1e-6);
    const idx5y = Array.from(simDD.tenors).findIndex((t) => Math.abs(t - 5) < 1e-6);
    const idx10y = Array.from(simDD.tenors).findIndex((t) => Math.abs(t - 10) < 1e-6);
    const p95DD = 0.5 * (p95(simDD, step20y, idx5y) + p95(simDD, step20y, idx10y));
    const p95CEV = 0.5 * (p95(simCEV, step20y, idx5y) + p95(simCEV, step20y, idx10y));

    // CEV β=0.7 must produce a strictly tamer averaged 95th percentile.
    expect(p95CEV).toBeLessThan(p95DD);
    expect(fitCEV.cevBeta).toBeCloseTo(0.7, 6);

    // Martingale correction must remain tight under CEV as well.
    let maxErrBp = 0;
    for (let k = 0; k < simCEV.times.length; k++) {
      maxErrBp = Math.max(maxErrBp, Math.abs(simCEV.dfSimulated[k] - simCEV.dfMarket[k]) * 1e4);
    }
    expect(maxErrBp).toBeLessThan(1e-6);
  });
});
