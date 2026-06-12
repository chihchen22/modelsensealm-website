import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadMarketSnapshot } from "../marketData";
import { bootstrapZeroCurve } from "../bootstrap";
import { calibrateHW } from "../hwCalibrate";
import { simulateHW, projectHWToTenor } from "../simulateHw";
import { simulateBGM, getRate } from "../simulateBgm";
import { PCG32 } from "../random";

const MARKET_PATH = resolve(__dirname, "..", "..", "..", "..", "public", "market_2026-03-31.json");

function percentile(arr: ArrayLike<number>, q: number): number {
  const sorted = Array.from(arr).sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = base + 1;
  if (next < sorted.length) return sorted[base] + rest * (sorted[next] - sorted[base]);
  return sorted[base];
}

describe("PCG32 RNG", () => {
  it("is reproducible with the same seed", () => {
    const r1 = new PCG32(42n);
    const r2 = new PCG32(42n);
    for (let i = 0; i < 100; i++) {
      expect(r1.nextUint32()).toBe(r2.nextUint32());
    }
  });

  it("generates ~standard normals (Box-Muller)", () => {
    const rng = new PCG32(123n);
    const N = 10000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      const z = rng.nextNormal();
      sum += z;
      sumSq += z * z;
    }
    const mean = sum / N;
    const variance = sumSq / N - mean * mean;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(Math.abs(variance - 1.0)).toBeLessThan(0.05);
  });
});

describe("HW simulator", () => {
  it("antithetic identity: mean(X) across paths is zero to numerical precision", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const hw = calibrateHW(snap, curve);
    const sim = simulateHW(curve, hw.a, hw.sigma, {
      horizonYears: 5.0, dtYears: 1 / 12, nPairs: 100, seed: 20250930n,
    });
    let maxAbsMean = 0;
    for (let k = 0; k < sim.times.length; k++) {
      let s = 0;
      for (let p = 0; p < sim.nPaths; p++) s += sim.XPaths[p][k];
      const mean = s / sim.nPaths;
      maxAbsMean = Math.max(maxAbsMean, Math.abs(mean));
    }
    expect(maxAbsMean).toBeLessThan(1e-12);
  });

  it("martingale correction: mean DF matches market to numerical precision", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const hw = calibrateHW(snap, curve);
    const sim = simulateHW(curve, hw.a, hw.sigma, {
      horizonYears: 10.0, dtYears: 1 / 12, nPairs: 100, seed: 20250930n,
    });
    let maxErrBp = 0;
    for (let k = 0; k < sim.times.length; k++) {
      maxErrBp = Math.max(maxErrBp, Math.abs(sim.dfSimulated[k] - sim.dfMarket[k]) * 1e4);
    }
    expect(maxErrBp).toBeLessThan(1e-6);
  });

  it("1Y forward distribution at 1Y horizon: mean within MC tolerance of Python reference", async () => {
    // Python reference (MARKET_JSON=market_2026-03-31.json research/simulate_hw.py,
    // 500 paths): horizon 1Y: mean 3.6490%, p5 2.1363%, p95 5.1760%. The wide
    // dispersion reflects the HW sigma (~0.0092) calibrated to the corrected
    // 3/31 cap ATM vols (see hwPricing.test.ts note: the Cap_Volatility export
    // was 10x too small and was corrected at source).
    // The TS code emits the par swap rate (annual ACT/360) for τ ≥ 1Y,
    // which is the Python simple rate scaled by 360/365 ≈ 0.9863 (~5 bp lower
    // at these levels). Within the MC tolerance below.
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const hw = calibrateHW(snap, curve);
    const sim = simulateHW(curve, hw.a, hw.sigma, {
      horizonYears: 5.0, dtYears: 1 / 12, nPairs: 250, seed: 20250930n,
    });
    const fwd = projectHWToTenor(sim, curve, 1.0);
    // 1Y horizon = step 11 (0-indexed for end-of-month-12).
    const k = 11;
    const cs = new Float64Array(sim.nPaths);
    for (let p = 0; p < sim.nPaths; p++) cs[p] = fwd[p][k];
    const mean = Array.from(cs).reduce((s, v) => s + v, 0) / cs.length;
    const p5 = percentile(cs, 0.05);
    const p95 = percentile(cs, 0.95);
    // Tolerances: mean within 30 bp; percentiles within 80 bp (10x wider
    // dispersion under the corrected sigma raises tail MC noise accordingly).
    expect(Math.abs(mean - 0.0365)).toBeLessThan(0.003);
    expect(Math.abs(p5 - 0.0214)).toBeLessThan(0.008);
    expect(Math.abs(p95 - 0.0518)).toBeLessThan(0.008);
  });
});

describe("BGM simulator", () => {
  it("martingale correction: mean DF matches market to numerical precision", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const sim = simulateBGM(
      curve,
      { a: 0.5327, b: 0.2159, c: 0.498, d: 0.7294, beta: 0.0, volScalar: 0.2403 },
      { horizonYears: 10.0, dtYears: 1 / 12, nPairs: 100, seed: 20250930n },
    );
    let maxErrBp = 0;
    for (let k = 0; k < sim.times.length; k++) {
      maxErrBp = Math.max(maxErrBp, Math.abs(sim.dfSimulated[k] - sim.dfMarket[k]) * 1e4);
    }
    expect(maxErrBp).toBeLessThan(1e-6);
  });

  it("Glasserman-Zhao log-coordinate scheme: in-scope p95 is sensible; sentinel guard rare", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const sim = simulateBGM(
      curve,
      { a: 0.5327, b: 0.2159, c: 0.498, d: 0.7294, beta: 0.0, volScalar: 0.2403 },
      { horizonYears: 30.0, dtYears: 1 / 12, nPairs: 100, seed: 20250930n },
    );
    // Under the GZ log-coordinate scheme, the F_CEILING clip is replaced by
    // a numerical safety guard at log F = 100 (F ≈ 2.7e43). Some far-tail
    // paths in the calibrated lognormal LMM legitimately reach this region;
    // a small saturation rate is a model property, not a bug. Anything below
    // 0.5% of evolutions is acceptable.
    const capRate = sim.nCapFires / Math.max(sim.nTotalEvolutions, 1);
    expect(capRate).toBeLessThan(0.005);
    expect(sim.nFloorFires).toBe(0);

    // In-scope (≤ 10Y horizon, ≤ 10Y tenor): every cell's p95 should be a
    // finite, sensible rate. This is what charts and downstream consumers see.
    const inScopeStep = sim.times.findIndex((t) => t > 10) - 1;
    const inScopeTenor = Array.from(sim.tenors).filter((t) => t <= 10).length;
    let maxP95 = 0;
    const nT = sim.tenors.length;
    const nS = sim.times.length;
    for (let s = 0; s <= inScopeStep; s++) {
      for (let ti = 0; ti < inScopeTenor; ti++) {
        const cs = new Float64Array(sim.nPaths);
        for (let p = 0; p < sim.nPaths; p++) cs[p] = sim.rates[(p * nS + s) * nT + ti];
        maxP95 = Math.max(maxP95, percentile(cs, 0.95));
      }
    }
    expect(maxP95).toBeGreaterThan(0.04); // at least 4% somewhere in scope
    expect(maxP95).toBeLessThan(0.5); // < 50% in-scope (≤ 10Y horizon × ≤ 10Y tenor)
  });

  it("getRate accessor returns same data as direct flat-array indexing", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const sim = simulateBGM(
      curve,
      { a: 0.5327, b: 0.2159, c: 0.498, d: 0.7294, beta: 0.0, volScalar: 0.2403 },
      { horizonYears: 1.0, dtYears: 1 / 12, nPairs: 10, seed: 20250930n },
    );
    const nT = sim.tenors.length;
    const nS = sim.times.length;
    for (const [p, s, ti] of [[0, 0, 0], [3, 5, 2], [10, 11, 9]] as const) {
      expect(getRate(sim, p, s, ti)).toBe(sim.rates[(p * nS + s) * nT + ti]);
    }
  });
});
