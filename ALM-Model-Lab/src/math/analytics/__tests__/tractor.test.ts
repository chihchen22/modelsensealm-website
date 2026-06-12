import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import {
  blendWalMonths,
  buildFrontier,
  buildMarginFrontier,
  dirichletWeights,
  fittedClientRateSeries,
  historicalRpPerformance,
  ladderWalMonths,
  maxYieldBlend,
  minVolBlend,
  mulberry32,
  newMoneyFlowLadder,
  newMoneyYield,
  pillarLadderCashflows,
  pillarWalMonths,
  pillarYieldCovariance,
  pillarYieldLevelSeries,
  regressOnPillars,
  regressOnSamples,
  sampleCovariance,
  sampleMean,
  simulatedClientRateSamples,
  simulatedPillarYieldSamples,
  solveConstrainedQP,
  stackedLadderByPillar,
  synthesizeClientRateSeries,
} from "../tractor";
import { parMatchedRate } from "../ftp";
import { loadRateHistory, firstCompleteIndex, trailingMASeries } from "../../rates/rateHistory";
import { loadMarketSnapshot } from "../../rates/marketData";
import { bootstrapZeroCurve, type ZeroCurve } from "../../rates/bootstrap";
import { projectHWToTenor, type HWSimulationResult } from "../../rates/simulateHw";
import { betaAtRate, BETA_S_CURVE_DEFAULTS } from "../../instruments/nmdBeta";

/** A zero-volatility HW sim (X ≡ 0) so projectHWToTenor returns the pure
 *  deterministic curve forwards — lets us unit-test the warm-start MA splice
 *  exactly, treating projectHWToTenor as a trusted black box. */
function zeroVolSim(horizon: number): HWSimulationResult {
  const times = new Float64Array(horizon);
  for (let k = 0; k < horizon; k++) times[k] = (k + 1) / 12;
  return {
    a: 0.1,
    sigma: 0,
    nPaths: 1,
    times,
    XPaths: [new Float64Array(horizon)],
  } as unknown as HWSimulationResult;
}

const PUBLIC = resolve(__dirname, "..", "..", "..", "..", "public");
const HISTORY_PATH = resolve(PUBLIC, "rate_history_2008-10_2026-03.json");
const SNAPSHOT_PATH = resolve(PUBLIC, "market_2026-03-31.json");

describe("pillar WAL identities", () => {
  it("WAL = (k+1)/2 months, overnight convention 0.5", () => {
    expect(pillarWalMonths(1)).toBe(0.5);
    expect(pillarWalMonths(3)).toBe(2);
    expect(pillarWalMonths(24)).toBe(12.5);
    expect(pillarWalMonths(120)).toBe(60.5);
    expect(pillarWalMonths(180)).toBe(90.5);
  });

  it("blend 20/20/60 @ 24/60/120 = 44.9m = 3.74y; 100% 120M = 5.04y", () => {
    const m = blendWalMonths([24, 60, 120], [0.2, 0.2, 0.6]);
    expect(m).toBeCloseTo(44.9, 9);
    expect(m / 12).toBeCloseTo(3.74, 2);
    expect(blendWalMonths([120], [1]) / 12).toBeCloseTo(5.04, 2);
  });

  it("ladder runoff WAL matches the closed form", () => {
    const cf = pillarLadderCashflows(12, 1_200_000);
    expect(cf).toHaveLength(12);
    expect(cf[0].balance).toBeCloseTo(1_200_000, 6);
    expect(cf[0].principalPaid).toBeCloseTo(100_000, 6);
    // Balance telescopes and principal sums to notional.
    for (let i = 1; i < cf.length; i++) {
      expect(cf[i].balance).toBeCloseTo(cf[i - 1].balance - cf[i - 1].principalPaid, 6);
    }
    const principalSum = cf.reduce((s, c) => s + c.principalPaid, 0);
    expect(principalSum).toBeCloseTo(1_200_000, 6);
    expect(ladderWalMonths(cf, 1_200_000)).toBeCloseTo(pillarWalMonths(12), 9);
  });
});

describe("ladder == trailing MA on real data (tractor identity)", () => {
  it("equal-weight ladder of the last k k-tenor rates equals pillarYield", async () => {
    const h = await loadRateHistory(HISTORY_PATH);
    const asOf = h.months.length - 1;
    for (const k of [3, 12, 24, 60, 120]) {
      const series = h.sofrTermSeries(k);
      // k equal rolling bullets: tranche originated i months ago earns the
      // k-tenor rate fixed at origination; portfolio yield is their mean.
      let ladderYield = 0;
      for (let i = 0; i < k; i++) ladderYield += series[asOf - i] / k;
      expect(h.pillarYield(asOf, k)).toBeCloseTo(ladderYield, 12);
      expect(pillarYieldLevelSeries(h, k)[asOf]).toBeCloseTo(ladderYield, 12);
    }
  });
});

describe("flat-curve par-match sanity", () => {
  it("par-matched rate of the pillar ladder under a flat curve is the monthly-compounded flat rate", () => {
    const z = 0.04;
    const cf = pillarLadderCashflows(60, 1_000_000);
    const r = parMatchedRate(cf, 1_000_000, (t) => Math.exp(-z * t));
    // Exact identity: with monthly accrual r·B·dt against e^{-z t} discounting,
    // the ladder par-matches at r = 12(e^{z/12} - 1).
    expect(r).toBeCloseTo(12 * (Math.exp(z / 12) - 1), 10);
    expect(r).toBeCloseTo(z, 3);
  });
});

describe("new-money yield (curve par interp)", () => {
  it("k<=1 uses the 1D cash quote; nodes interpolate linearly; ends clamp", async () => {
    const snap = await loadMarketSnapshot(SNAPSHOT_PATH);
    const q = snap.curveQuotes;
    const sorted = [...q].sort((a, b) => a.tYears - b.tYears);
    expect(newMoneyYield(1, q)).toBeCloseTo(sorted[0].rate, 12);
    // Exact node: 2Y.
    const node2y = sorted.find((x) => Math.abs(x.tYears - 2) < 1e-12)!;
    expect(newMoneyYield(24, q)).toBeCloseTo(node2y.rate, 12);
    // Midpoint between 2Y and 3Y.
    const node3y = sorted.find((x) => Math.abs(x.tYears - 3) < 1e-12)!;
    expect(newMoneyYield(30, q)).toBeCloseTo((node2y.rate + node3y.rate) / 2, 12);
    // Clamp beyond the longest quote.
    expect(newMoneyYield(600, q)).toBeCloseTo(sorted[sorted.length - 1].rate, 12);
  });
});

describe("face-enumeration QP", () => {
  it("diagonal Q with sum=1 gives w_i proportional to 1/q_i", () => {
    const sol = solveConstrainedQP(
      [
        [1, 0, 0],
        [0, 2, 0],
        [0, 0, 4],
      ],
      [0, 0, 0],
      [[1, 1, 1]],
      [1],
    );
    expect(sol.feasible).toBe(true);
    expect(sol.weights[0]).toBeCloseTo(4 / 7, 8);
    expect(sol.weights[1]).toBeCloseTo(2 / 7, 8);
    expect(sol.weights[2]).toBeCloseTo(1 / 7, 8);
  });

  it("activates the nonnegativity bound when the unconstrained optimum is negative", () => {
    // min (w1-1)^2 + (w2+1)^2 s.t. w1+w2=1, w>=0 -> w=(1,0).
    const sol = solveConstrainedQP(
      [
        [2, 0],
        [0, 2],
      ],
      [2, -2],
      [[1, 1]],
      [1],
    );
    expect(sol.feasible).toBe(true);
    expect(sol.weights[0]).toBeCloseTo(1, 8);
    expect(sol.weights[1]).toBeCloseTo(0, 8);
  });

  it("two pillars + two equality rows pin the unique feasible point regardless of Q", () => {
    const pillars = [3, 120];
    const wal = pillars.map(pillarWalMonths); // [2, 60.5]
    const wi = (36 - wal[1]) / (wal[0] - wal[1]);
    const sol = solveConstrainedQP(
      [
        [5, 1],
        [1, 3],
      ],
      [0.7, -0.2],
      [
        [1, 1],
        [wal[0], wal[1]],
      ],
      [1, 36],
    );
    expect(sol.feasible).toBe(true);
    expect(sol.weights[0]).toBeCloseTo(wi, 10);
    expect(sol.weights[1]).toBeCloseTo(1 - wi, 10);
  });

  it("reports infeasible when the target WAL is unreachable", () => {
    const pillars = [3, 12];
    const sol = solveConstrainedQP(
      [
        [1, 0],
        [0, 1],
      ],
      [0, 0],
      [
        [1, 1],
        pillars.map(pillarWalMonths),
      ],
      [1, 36], // max achievable WAL is 6.5m
    );
    expect(sol.feasible).toBe(false);
  });
});

describe("NIB frontier endpoints", () => {
  const PILLARS = [3, 12, 24, 60, 120, 180];

  it("max-yield matches the closed-form pair structure on the real 3/31/2026 curve", async () => {
    const snap = await loadMarketSnapshot(SNAPSHOT_PATH);
    const h = await loadRateHistory(HISTORY_PATH);
    const mu = PILLARS.map((k) => newMoneyYield(k, snap.curveQuotes));
    const { cov } = pillarYieldCovariance(h, PILLARS, h.months.length - 1);
    const sol = maxYieldBlend(PILLARS, mu, cov, 36);
    expect(sol.feasible).toBe(true);
    // On the 3/31/2026 curve the 12M node (3.701%) sits above 3M (3.677%),
    // so the optimal pair couples the 12M pillar (WAL 6.5m) with 180M
    // (WAL 90.5m): w_12M = (90.5 - 36) / (90.5 - 6.5) = 64.88%. Verified by
    // closed-form pair enumeration across all six pillars (the 3M + 180M
    // alternative yields 0.46 bp less).
    expect(sol.weights[1]).toBeCloseTo((90.5 - 36) / (90.5 - 6.5), 3);
    expect(sol.weights[5]).toBeCloseTo(1 - (90.5 - 36) / (90.5 - 6.5), 3);
    expect(sol.weights[0]).toBeCloseTo(0, 12);
    expect(sol.weights[2]).toBeCloseTo(0, 12);
    expect(sol.weights[3]).toBeCloseTo(0, 12);
    expect(sol.weights[4]).toBeCloseTo(0, 12);
    expect(sol.walMonths).toBeCloseTo(36, 9);
  });

  it("max-yield pair enumeration beats brute-forced feasible triples", () => {
    const mu = [0.0363, 0.0345, 0.0335, 0.0339, 0.0358, 0.0371];
    const cov = PILLARS.map((_, i) => PILLARS.map((_, j) => (i === j ? 1e-6 : 0)));
    const target = 36;
    const sol = maxYieldBlend(PILLARS, mu, cov, target);
    expect(sol.feasible).toBe(true);
    expect(sol.weights.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9);
    expect(sol.walMonths).toBeCloseTo(target, 9);

    // Brute force: every triple (i,j,l) with w_l on a grid, the remaining
    // two solved from the equality rows; no feasible point may beat the
    // pair-enumeration optimum.
    const wal = PILLARS.map(pillarWalMonths);
    for (let i = 0; i < PILLARS.length; i++) {
      for (let j = i + 1; j < PILLARS.length; j++) {
        for (let l = 0; l < PILLARS.length; l++) {
          if (l === i || l === j) continue;
          for (let g = 0; g <= 50; g++) {
            const wl = g / 50;
            // Solve wi+wj = 1-wl ; wi*wal_i + wj*wal_j = target - wl*wal_l.
            const denom = wal[i] - wal[j];
            if (Math.abs(denom) < 1e-12) continue;
            const wi = (target - wl * wal[l] - (1 - wl) * wal[j]) / denom;
            const wj = 1 - wl - wi;
            if (wi < 0 || wj < 0) continue;
            const y = wi * mu[i] + wj * mu[j] + wl * mu[l];
            expect(y).toBeLessThanOrEqual(sol.yieldDec + 1e-12);
          }
        }
      }
    }
  });

  it("min-vol endpoint satisfies the constraints and does not beat max-yield on yield", async () => {
    const snap = await loadMarketSnapshot(SNAPSHOT_PATH);
    const h = await loadRateHistory(HISTORY_PATH);
    const mu = PILLARS.map((k) => newMoneyYield(k, snap.curveQuotes));
    const { cov, nObs } = pillarYieldCovariance(h, PILLARS, h.months.length - 1);
    expect(nObs).toBeGreaterThanOrEqual(2);

    const mv = minVolBlend(PILLARS, mu, cov, 36);
    const my = maxYieldBlend(PILLARS, mu, cov, 36);
    expect(mv.feasible).toBe(true);
    expect(mv.weights.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
    expect(mv.walMonths).toBeCloseTo(36, 6);
    expect(mv.weights.every((w) => w >= 0)).toBe(true);
    // Frontier ordering: min-vol has lower (or equal) vol, max-yield higher
    // (or equal) yield.
    expect(mv.volBp).toBeLessThanOrEqual(my.volBp + 1e-9);
    expect(my.yieldDec).toBeGreaterThanOrEqual(mv.yieldDec - 1e-12);
  });
});

describe("pillar-yield covariance (historical monthly changes)", () => {
  it("uses the common complete window and annualizes", async () => {
    const h = await loadRateHistory(HISTORY_PATH);
    const endIdx = h.months.length - 1; // 2026-03
    const { cov, nObs, startIdx } = pillarYieldCovariance(h, [3, 120], endIdx);
    // 120M window completes at index 119 (2018-09, verified in rateHistory tests).
    expect(startIdx).toBe(firstCompleteIndex(120));
    expect(nObs).toBe(endIdx - firstCompleteIndex(120));
    // Short pillar reprices faster: its yield-change variance dominates.
    expect(cov[0][0]).toBeGreaterThan(cov[1][1]);
    expect(cov[0][0]).toBeGreaterThan(0);
  });

  it("flags the starved 180M sample via nObs", async () => {
    const h = await loadRateHistory(HISTORY_PATH);
    const { nObs } = pillarYieldCovariance(h, [3, 180], h.months.length - 1);
    // 180M completes Sep 2023 -> ~30 monthly changes through Mar 2026.
    expect(nObs).toBe(h.months.length - 1 - firstCompleteIndex(180));
    expect(nObs).toBeLessThan(36);
  });
});

describe("IB client-rate synthesis + NNLS regression", () => {
  it("synthesized client rate tracks beta(r)·r with lambda=1", async () => {
    const h = await loadRateHistory(HISTORY_PATH);
    const d = synthesizeClientRateSeries(h, BETA_S_CURVE_DEFAULTS);
    expect(d).toHaveLength(h.months.length);
    // lambda=1 snaps to target every month: spot-check a high-rate month.
    const i = h.months.length - 1;
    const rPct = h.sofrON[i] * 100;
    const beta =
      BETA_S_CURVE_DEFAULTS.betaMin +
      (BETA_S_CURVE_DEFAULTS.betaMax - BETA_S_CURVE_DEFAULTS.betaMin) /
        (1 + Math.exp(-BETA_S_CURVE_DEFAULTS.k * (rPct - BETA_S_CURVE_DEFAULTS.m)));
    expect(d[i]).toBeCloseTo((beta * rPct) / 100, 12);
    expect(d.every((v) => v >= 0)).toBe(true);
  });

  it("NNLS recovers a known synthetic blend exactly", async () => {
    const h = await loadRateHistory(HISTORY_PATH);
    const pillars = [3, 12, 24, 60, 120];
    const endIdx = h.months.length - 1;
    const y12 = pillarYieldLevelSeries(h, 12);
    const y60 = pillarYieldLevelSeries(h, 60);
    const target = h.months.map((_, t) => 0.35 * y12[t] + 0.65 * y60[t]);
    const reg = regressOnPillars(h, pillars, target, endIdx);
    expect(reg.feasible).toBe(true);
    expect(reg.weights[1]).toBeCloseTo(0.35, 4);
    expect(reg.weights[3]).toBeCloseTo(0.65, 4);
    expect(reg.weights[0]).toBeCloseTo(0, 4);
    expect(reg.weights[2]).toBeCloseTo(0, 4);
    expect(reg.weights[4]).toBeCloseTo(0, 4);
    expect(reg.r2).toBeGreaterThan(0.9999);
    expect(reg.rmseBp).toBeLessThan(0.1);
  });

  it("throws loudly on an out-of-range endIdx (matches pillarYieldCovariance)", async () => {
    const h = await loadRateHistory(HISTORY_PATH);
    const target = synthesizeClientRateSeries(h, BETA_S_CURVE_DEFAULTS);
    expect(() => regressOnPillars(h, [3, 12], target, h.months.length)).toThrow(/out of range/);
    expect(() => pillarYieldCovariance(h, [3, 12], h.months.length)).toThrow(/out of range/);
  });

  it("regressing the beta-synthesized client rate recovers the beta split", async () => {
    const h = await loadRateHistory(HISTORY_PATH);
    const pillars = [1, 3, 12, 24, 60, 120];
    const target = synthesizeClientRateSeries(h, BETA_S_CURVE_DEFAULTS);
    const reg = regressOnPillars(h, pillars, target, h.months.length - 1);
    expect(reg.feasible).toBe(true);
    expect(reg.weights.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 8);
    // With D = beta(r)·r the overnight pillar's weight estimates the
    // effective in-sample beta (S-curve range 0.43-0.80; the 2018-2026
    // window realises ~0.49) and the (1 − beta) complement lands on smooth
    // long pillars as the quasi-fixed slice, the same split the beta-aware
    // FTP applies. The 2025-09-window run verified 48.8% 1M + 51.2% 60M;
    // the 2026-03 window lands nearby, inside the bounds below.
    expect(reg.weights[0]).toBeGreaterThan(0.4);
    expect(reg.weights[0]).toBeLessThan(0.65);
    const longWeight = reg.weights[3] + reg.weights[4] + reg.weights[5];
    expect(longWeight).toBeGreaterThan(0.3);
    expect(reg.r2).toBeGreaterThan(0.5);
  });
});

describe("fitted client-rate series (chart helper)", () => {
  it("reproduces the regression in-sample fit and is NaN before the window", async () => {
    const h = await loadRateHistory(HISTORY_PATH);
    const pillars = [1, 3, 12, 24, 60, 120];
    const target = synthesizeClientRateSeries(h, BETA_S_CURVE_DEFAULTS);
    const endIdx = h.months.length - 1;
    const reg = regressOnPillars(h, pillars, target, endIdx);
    const fitted = fittedClientRateSeries(h, pillars, reg.weights);
    expect(fitted).toHaveLength(h.months.length);

    // RMSE recomputed from the helper output over the regression window
    // must match the regression's own reported RMSE.
    const nObs = endIdx - reg.startIdx + 1;
    let ssRes = 0;
    for (let t = reg.startIdx; t <= endIdx; t++) {
      ssRes += (target[t] - fitted[t]) ** 2;
    }
    expect(Math.sqrt(ssRes / nObs) * 1e4).toBeCloseTo(reg.rmseBp, 6);

    // The fit is defined exactly from the first complete window (the longest
    // pillar's MA): finite at startIdx, NaN one month before.
    expect(Number.isFinite(fitted[reg.startIdx])).toBe(true);
    expect(Number.isNaN(fitted[reg.startIdx - 1])).toBe(true);
  });
});

describe("stacked ladder by pillar (chart helper)", () => {
  it("month-1 total = notional, columns = weighted notionals, total WAL = blend WAL", () => {
    const pillars = [24, 60, 120];
    const weights = [0.2, 0.2, 0.6];
    const notional = 1_000;
    const rows = stackedLadderByPillar(pillars, weights, notional);

    expect(rows).toHaveLength(120); // longest pillar drives the horizon
    expect(rows[0].total).toBeCloseTo(notional, 6);
    expect(rows[0].byPillar[0]).toBeCloseTo(0.2 * notional, 6);
    expect(rows[0].byPillar[2]).toBeCloseTo(0.6 * notional, 6);

    // Principal-weighted WAL of the stacked total runoff equals the analytic
    // blend WAL (ties the chart geometry to blendWalMonths).
    let wal = 0;
    for (let m = 0; m < rows.length; m++) {
      const next = m + 1 < rows.length ? rows[m + 1].total : 0;
      wal += (m + 1) * (rows[m].total - next);
    }
    expect(wal / notional).toBeCloseTo(blendWalMonths(pillars, weights), 6);
  });

  it("each pillar column telescopes to zero by its own maturity", () => {
    const rows = stackedLadderByPillar([3, 12], [0.5, 0.5], 100);
    expect(rows[2].byPillar[0]).toBeGreaterThan(0); // month 3: pillar-3 alive
    expect(rows[3].byPillar[0]).toBeCloseTo(0, 9); // month 4: pillar-3 gone
    expect(rows[11].byPillar[1]).toBeGreaterThan(0); // month 12: pillar-12 alive
  });
});

describe("new-money flow ladder", () => {
  it("shares match (w_k / k) normalized and sum to 1", () => {
    const pillars = [1, 12, 120];
    const weights = [0.5, 0.3, 0.2];
    const ladder = newMoneyFlowLadder(pillars, weights);
    const raw = [0.5 / 1, 0.3 / 12, 0.2 / 120];
    const tot = raw[0] + raw[1] + raw[2];
    expect(ladder.map((r) => r.tenorMonths)).toEqual(pillars);
    ladder.forEach((r, i) => expect(r.share).toBeCloseTo(raw[i] / tot, 12));
    expect(ladder.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1, 12);
  });

  it("a single pillar puts 100% of new money at its tenor", () => {
    const ladder = newMoneyFlowLadder([60], [1]);
    expect(ladder[0].share).toBeCloseTo(1, 12);
  });

  it("shorter pillars draw proportionally more new money than equal weights", () => {
    // Equal stock weight, but the 3M turns over 40x faster than the 120M.
    const ladder = newMoneyFlowLadder([3, 120], [0.5, 0.5]);
    expect(ladder[0].share).toBeGreaterThan(ladder[1].share);
    expect(ladder[0].share / ladder[1].share).toBeCloseTo(120 / 3, 9);
  });
});

describe("Dirichlet sampling (frontier cloud)", () => {
  it("is reproducible per seed and lands on the simplex", () => {
    const r1 = mulberry32(123);
    const r2 = mulberry32(123);
    for (let s = 0; s < 50; s++) {
      const w1 = dirichletWeights(r1, 5);
      const w2 = dirichletWeights(r2, 5);
      expect(w1).toEqual(w2);
      expect(w1.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      expect(w1.every((w) => w >= 0)).toBe(true);
    }
  });
});

describe("simulated-path pillar yields (warm-started MA splice)", () => {
  const HORIZON = 60;

  it("reproduces the analytic trailing-k MA on a zero-vol path", async () => {
    const snap = await loadMarketSnapshot(SNAPSHOT_PATH);
    const curve: ZeroCurve = bootstrapZeroCurve(snap);
    const h = await loadRateHistory(HISTORY_PATH);
    const asOf = h.months.length - 1;
    const sim = zeroVolSim(HORIZON);

    for (const k of [3, 24]) {
      const out = simulatedPillarYieldSamples(h, [k], sim, curve, asOf, HORIZON);
      expect(out.nSamples).toBe(HORIZON); // nPaths(1) × horizon

      // Independent reconstruction: (k−1) historical warmup + the projected
      // k-tenor forwards, trailing-k MA, sliced to the forecast window.
      const proj = projectHWToTenor(sim, curve, k / 12);
      const term = h.sofrTermSeries(k);
      const warm = k - 1;
      const ser = new Float64Array(warm + HORIZON);
      for (let i = 0; i < warm; i++) ser[i] = term[asOf - warm + 1 + i];
      for (let j = 0; j < HORIZON; j++) ser[warm + j] = proj[0][j];
      const ma = trailingMASeries(ser, k);
      for (let j = 0; j < HORIZON; j++) {
        expect(out.samples[0][j]).toBeCloseTo(ma[warm + j], 12);
      }
    }
  });

  it("client-rate sample snaps to beta(r)·r at lambda=1 on a zero-vol path", async () => {
    const snap = await loadMarketSnapshot(SNAPSHOT_PATH);
    const curve: ZeroCurve = bootstrapZeroCurve(snap);
    const h = await loadRateHistory(HISTORY_PATH);
    const asOf = h.months.length - 1;
    const sim = zeroVolSim(HORIZON);

    const d = simulatedClientRateSamples(h, sim, curve, BETA_S_CURVE_DEFAULTS, asOf, HORIZON);
    expect(d).toHaveLength(HORIZON);
    const proj1m = projectHWToTenor(sim, curve, 1 / 12);
    // lambda=1 means each month D snaps to its target β(r)·r.
    const rPct = proj1m[0][HORIZON - 1] * 100;
    const target = (betaAtRate(rPct, BETA_S_CURVE_DEFAULTS) * rPct) / 100;
    expect(d[HORIZON - 1]).toBeCloseTo(target, 12);
    expect(d.every((v) => v >= 0)).toBe(true);
  });
});

describe("sample moments", () => {
  it("mean and covariance match a hand computation", () => {
    const s = [
      [1, 2, 3, 4],
      [2, 2, 4, 4],
    ];
    expect(sampleMean(s)).toEqual([2.5, 3]);
    const cov = sampleCovariance(s);
    // var(row0) with n−1: mean 2.5, devs ±1.5,±0.5 -> (2·2.25+2·0.25)/3 = 5/3.
    expect(cov[0][0]).toBeCloseTo(5 / 3, 12);
    expect(cov[1][1]).toBeCloseTo(4 / 3, 12);
    expect(cov[0][1]).toBeCloseTo(cov[1][0], 12);
  });
});

describe("mean-variance frontier (yield space)", () => {
  const PILLARS = [3, 12, 24, 60, 120];
  // Upward curve; longer MA pillars are smoother (lower variance).
  const MU = [0.034, 0.036, 0.038, 0.041, 0.044];
  const COV = PILLARS.map((_, i) =>
    PILLARS.map((_, j) => (i === j ? 4e-5 / (i + 1) : 1e-5 / (Math.abs(i - j) + 1))),
  );
  const CAP = 60; // months
  const RF = 0.034;

  it("every corner is feasible: sum=1, w>=0, WAL<=cap", () => {
    const fr = buildFrontier(PILLARS, MU, COV, CAP, RF, { nSamples: 800 });
    expect(fr.feasible).toBe(true);
    for (const pt of [fr.minVol, fr.maxRet, fr.maxSharpe, fr.liqCapped]) {
      expect(pt.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
      expect(pt.weights.every((w) => w >= -1e-9)).toBe(true);
      expect(pt.walMonths).toBeLessThanOrEqual(CAP + 1e-6);
    }
    expect(fr.cloud.length).toBeGreaterThan(0);
    expect(fr.cloud.every((p) => p.walMonths <= CAP + 1e-9)).toBe(true);
  });

  it("max-Sharpe dominates every cloud sample", () => {
    const fr = buildFrontier(PILLARS, MU, COV, CAP, RF, { nSamples: 800 });
    for (const p of fr.cloud) expect(fr.maxSharpe.sharpe).toBeGreaterThanOrEqual(p.sharpe - 1e-9);
  });

  it("liquidity-capped blend uses the full WAL budget; min-vol <= max-yield vol", () => {
    const fr = buildFrontier(PILLARS, MU, COV, CAP, RF, { nSamples: 400 });
    expect(fr.liqCapped.walMonths).toBeCloseTo(CAP, 4);
    expect(fr.minVol.vol).toBeLessThanOrEqual(fr.maxRet.vol + 1e-9);
    expect(fr.maxRet.ret).toBeGreaterThanOrEqual(fr.minVol.ret - 1e-12);
  });
});

describe("mean-variance frontier (margin space, IB)", () => {
  const PILLARS = [1, 3, 12, 24, 60, 120];

  it("closed-form margin mean/vol equals a brute-force (path,month) recompute", () => {
    // Build aligned pillar-yield and client-rate samples, derive moments, then
    // check the frontier's margin formula against a direct recomputation.
    const n = 200;
    const rng = mulberry32(7);
    const Y = PILLARS.map((k) =>
      Array.from({ length: n }, (_, t) => 0.03 + 0.0002 * k + 0.001 * Math.sin(t / k + k)),
    );
    const D = Array.from({ length: n }, (_, t) => 0.02 + 0.0008 * Math.sin(t / 5) + 0.0005 * rng());
    const muY = sampleMean(Y);
    const muD = sampleMean([D])[0];
    const covYY = sampleCovariance(Y);
    const covYD = sampleCovariance([...Y, D]).slice(0, PILLARS.length).map((row) => row[PILLARS.length]);
    const varD = sampleCovariance([D])[0][0];

    const w = dirichletWeights(rng, PILLARS.length);
    // Closed form.
    let retCF = -muD;
    let varCF = varD;
    for (let i = 0; i < PILLARS.length; i++) {
      retCF += w[i] * muY[i];
      varCF -= 2 * w[i] * covYD[i];
      for (let j = 0; j < PILLARS.length; j++) varCF += w[i] * covYY[i][j] * w[j];
    }
    // Brute force over the samples.
    const margin = Array.from({ length: n }, (_, t) => {
      let m = -D[t];
      for (let i = 0; i < PILLARS.length; i++) m += w[i] * Y[i][t];
      return m;
    });
    const meanBF = margin.reduce((a, b) => a + b, 0) / n;
    let varBF = 0;
    for (const m of margin) varBF += (m - meanBF) ** 2;
    varBF /= n - 1;
    expect(retCF).toBeCloseTo(meanBF, 9);
    expect(varCF).toBeCloseTo(varBF, 9);
  });

  it("frontier corners feasible and max-Sharpe dominates the cloud", () => {
    const muY = [0.033, 0.034, 0.036, 0.038, 0.041, 0.044];
    const covYY = PILLARS.map((_, i) => PILLARS.map((_, j) => (i === j ? 3e-5 : 8e-6)));
    const covYD = PILLARS.map(() => 5e-6);
    const cap = pillarWalMonths(120); // IB: WAL bounded only by the 120M pillar
    const fr = buildMarginFrontier(PILLARS, muY, covYY, covYD, 2e-5, 0.02, cap, { nSamples: 600 });
    expect(fr.feasible).toBe(true);
    for (const pt of [fr.minVol, fr.maxRet, fr.maxSharpe, fr.liqCapped]) {
      expect(pt.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
      expect(pt.weights.every((w) => w >= -1e-9)).toBe(true);
      expect(pt.walMonths).toBeLessThanOrEqual(cap + 1e-6);
    }
    expect(fr.cloud.length).toBeGreaterThan(0);
    for (const p of fr.cloud) expect(fr.maxSharpe.sharpe).toBeGreaterThanOrEqual(p.sharpe - 1e-9);
  });
});

describe("historical RP performance (backtest)", () => {
  it("realized yield series equals the weighted pillar MA over the valid window", async () => {
    const h = await loadRateHistory(HISTORY_PATH);
    const asOf = h.months.length - 1;
    const pillars = [12, 60];
    const weights = [0.4, 0.6];
    const perf = historicalRpPerformance(h, pillars, weights, asOf);
    expect(perf.startIdx).toBe(firstCompleteIndex(60)); // longest pillar drives the window
    expect(perf.nObs).toBe(asOf - firstCompleteIndex(60) + 1);
    const y12 = pillarYieldLevelSeries(h, 12);
    const y60 = pillarYieldLevelSeries(h, 60);
    // First and last window points match the weighted blend exactly.
    expect(perf.series[0]).toBeCloseTo(0.4 * y12[perf.startIdx] + 0.6 * y60[perf.startIdx], 12);
    expect(perf.series[perf.nObs - 1]).toBeCloseTo(0.4 * y12[asOf] + 0.6 * y60[asOf], 12);
    // Mean matches a direct recompute; realized vol is finite and positive.
    const mean = perf.series.reduce((s, v) => s + v, 0) / perf.series.length;
    expect(perf.meanDec).toBeCloseTo(mean, 12);
    expect(perf.volBp).toBeGreaterThan(0);
  });

  it("subtracting the client rate gives the margin; a zero client rate matches the yield", async () => {
    const h = await loadRateHistory(HISTORY_PATH);
    const asOf = h.months.length - 1;
    const pillars = [3, 12, 60];
    const weights = [0.2, 0.3, 0.5];
    const yieldOnly = historicalRpPerformance(h, pillars, weights, asOf);
    const zeros = h.months.map(() => 0);
    const withZero = historicalRpPerformance(h, pillars, weights, asOf, zeros);
    expect(withZero.series[0]).toBeCloseTo(yieldOnly.series[0], 12);

    const D = synthesizeClientRateSeries(h, BETA_S_CURVE_DEFAULTS);
    const margin = historicalRpPerformance(h, pillars, weights, asOf, D);
    // margin = yield − D, point by point over the shared window.
    for (let i = 0; i < margin.nObs; i += 17) {
      expect(margin.series[i]).toBeCloseTo(yieldOnly.series[i] - D[margin.startIdx + i], 12);
    }
  });
});

describe("NNLS regression on simulated samples", () => {
  it("recovers a known blend exactly", () => {
    const n = 240;
    const P0 = Array.from({ length: n }, (_, t) => 0.03 + 0.001 * Math.sin(t / 3));
    const P1 = Array.from({ length: n }, (_, t) => 0.035 + 0.001 * Math.cos(t / 7));
    const P2 = Array.from({ length: n }, (_, t) => 0.04 + 0.0008 * Math.sin(t / 11 + 1));
    const target = P0.map((v, t) => 0.3 * v + 0.7 * P2[t]);
    const reg = regressOnSamples([P0, P1, P2], target);
    expect(reg.feasible).toBe(true);
    expect(reg.weights[0]).toBeCloseTo(0.3, 4);
    expect(reg.weights[1]).toBeCloseTo(0, 4);
    expect(reg.weights[2]).toBeCloseTo(0.7, 4);
    expect(reg.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 8);
    expect(reg.r2).toBeGreaterThan(0.9999);
  });
});
