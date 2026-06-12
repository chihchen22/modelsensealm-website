import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  betaAtRate,
  NMDBeta,
  NMD_B_TERMS_DEFAULTS,
  BETA_S_CURVE_DEFAULTS,
  runNMDBetaOnPaths,
} from "../nmdBeta";
import { NMD_DEFAULTS } from "../../behavioral/nmdModel";
import { DeterministicRatePath } from "../../rates/ratePath";
import { loadMarketSnapshot } from "../../rates/marketData";
import { bootstrapZeroCurve } from "../../rates/bootstrap";
import type { RatePath } from "../types";

const MARKET_PATH = resolve(__dirname, "..", "..", "..", "..", "public", "market_2026-03-31.json");

function flatCurveRatePath(rate: number, nSteps: number): RatePath {
  const stub = {
    t: [],
    z: [],
    zeroRate: () => rate,
    discountFactor: (t: number) => Math.exp(-rate * t),
    forwardRate: () => rate,
    forwardSwapRate: () => rate,
  };
  return new DeterministicRatePath(stub as never, nSteps);
}

/** Linearly-rising rate path: r(t) = rStart + slopePerMonth × t. */
function risingRatePath(rStartDecimal: number, slopePerMonth: number, nSteps: number): RatePath {
  return {
    nSteps,
    times: Array.from({ length: nSteps + 1 }, (_, k) => k / 12),
    rateAt(step: number) {
      const s = Math.max(0, Math.min(nSteps, step));
      return rStartDecimal + slopePerMonth * s;
    },
    forwardRateAt(step: number, _tenorYears: number) {
      const s = Math.max(0, Math.min(nSteps, step));
      return rStartDecimal + slopePerMonth * s;
    },
  };
}

describe("β S-curve", () => {
  it("is monotone non-decreasing across the rate axis", () => {
    const p = BETA_S_CURVE_DEFAULTS;
    let prev = -Infinity;
    for (let r = -1; r <= 12; r += 0.25) {
      const b = betaAtRate(r, p);
      expect(b).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = b;
    }
  });

  it("approaches β_min at low rates and β_max at high rates", () => {
    const p = BETA_S_CURVE_DEFAULTS;
    expect(betaAtRate(-50, p)).toBeCloseTo(p.betaMin, 4);
    expect(betaAtRate(50, p)).toBeCloseTo(p.betaMax, 4);
  });

  it("at the inflection rate β = (β_min + β_max) / 2", () => {
    const p = BETA_S_CURVE_DEFAULTS;
    expect(betaAtRate(p.m, p)).toBeCloseTo((p.betaMin + p.betaMax) / 2, 12);
  });
});

describe("NMDBeta instrument", () => {
  it("rejects degenerate inputs", () => {
    expect(() => new NMDBeta({ ...NMD_B_TERMS_DEFAULTS, notional: 0 })).toThrow();
    expect(
      () => new NMDBeta({ ...NMD_B_TERMS_DEFAULTS, sCurve: { ...BETA_S_CURVE_DEFAULTS, betaMax: 0.2 } }),
    ).toThrow();
    expect(
      () => new NMDBeta({ ...NMD_B_TERMS_DEFAULTS, sCurve: { ...BETA_S_CURVE_DEFAULTS, lambda: 0 } }),
    ).toThrow();
    expect(
      () => new NMDBeta({ ...NMD_B_TERMS_DEFAULTS, sCurve: { ...BETA_S_CURVE_DEFAULTS, lambda: 1.5 } }),
    ).toThrow();
  });

  it("side is liability and initial β reflects the t=0 market rate", () => {
    const inst = new NMDBeta(NMD_B_TERMS_DEFAULTS);
    expect(inst.terms.side).toBe("liability");
    const path = flatCurveRatePath(0.04, 360);
    const expected = betaAtRate(4.0, NMD_B_TERMS_DEFAULTS.sCurve);
    expect(inst.initialBeta(path)).toBeCloseTo(expected, 12);
  });

  it("flat-rate path with λ=1: D(t) = β(r) · r every period", () => {
    const inst = new NMDBeta({
      ...NMD_B_TERMS_DEFAULTS,
      sCurve: { ...BETA_S_CURVE_DEFAULTS, lambda: 1.0 },
    });
    const path = flatCurveRatePath(0.04, 60);
    const cf = inst.generateCashflows(path);
    const expected = (betaAtRate(4.0, BETA_S_CURVE_DEFAULTS) * 4.0) / 100;
    for (const c of cf) {
      expect(c.couponRate).toBeCloseTo(expected, 10);
    }
  });

  it("rising-rate path with λ=1: D(t) tracks β(r(t)) · r(t) exactly", () => {
    const horizon = 60;
    const path = risingRatePath(0.02, 0.0005, horizon);
    const inst = new NMDBeta({
      ...NMD_B_TERMS_DEFAULTS,
      maturityMonths: horizon,
      sCurve: { ...BETA_S_CURVE_DEFAULTS, lambda: 1.0 },
    });
    const ratePath = inst.depositRatePath(path);
    for (let t = 0; t < ratePath.dPct.length; t++) {
      const r = ratePath.rPct[t];
      const beta = betaAtRate(r, BETA_S_CURVE_DEFAULTS);
      expect(ratePath.dPct[t]).toBeCloseTo(beta * r, 10);
    }
    // Spread r − D = (1 − β) · r is much narrower than r alone.
    const lastR = ratePath.rPct[horizon - 1];
    const lastBeta = ratePath.betaPct[horizon - 1];
    const lastSpread = lastR - ratePath.dPct[horizon - 1];
    expect(lastSpread).toBeCloseTo((1 - lastBeta) * lastR, 10);
  });

  it("partial adjustment λ < 1 produces a smoother trajectory than λ = 1", () => {
    const horizon = 60;
    const path = risingRatePath(0.02, 0.0005, horizon);
    const fast = new NMDBeta({
      ...NMD_B_TERMS_DEFAULTS,
      maturityMonths: horizon,
      sCurve: { ...BETA_S_CURVE_DEFAULTS, lambda: 1.0 },
    }).depositRatePath(path);
    const slow = new NMDBeta({
      ...NMD_B_TERMS_DEFAULTS,
      maturityMonths: horizon,
      sCurve: { ...BETA_S_CURVE_DEFAULTS, lambda: 0.4 },
    }).depositRatePath(path);
    // Both snap to the same target at t=0; with λ<1 the slow path lags the
    // rising target so its terminal value is lower.
    expect(fast.dPct[0]).toBeCloseTo(slow.dPct[0], 10);
    expect(slow.dPct[horizon - 1]).toBeLessThan(fast.dPct[horizon - 1]);
  });

  it("interest paid each month equals balance × D(t) / 12", () => {
    const path = risingRatePath(0.02, 0.0003, 60);
    const inst = new NMDBeta({
      ...NMD_B_TERMS_DEFAULTS,
      maturityMonths: 60,
    });
    const cf = inst.generateCashflows(path);
    for (const c of cf) {
      expect(c.interestPaid).toBeCloseTo((c.balance * c.couponRate) / 12, 8);
    }
  });

  it("repricingSchedule is empty (β-slice repricing handled by analytics)", () => {
    const inst = new NMDBeta(NMD_B_TERMS_DEFAULTS);
    expect(inst.repricingSchedule()).toEqual([]);
  });

  it("near-zero β-range collapses D toward zero (deposit pays nothing)", () => {
    const inst = new NMDBeta({
      ...NMD_B_TERMS_DEFAULTS,
      sCurve: { ...BETA_S_CURVE_DEFAULTS, betaMin: 0, betaMax: 1e-9, k: 0.5, m: 4.0 },
    });
    const path = risingRatePath(0.02, 0.001, 60);
    const ratePath = inst.depositRatePath(path);
    // With β ≈ 0 the deposit rate target is β · r ≈ 0 every step.
    for (const d of ratePath.dPct) {
      expect(d).toBeCloseTo(0, 5);
    }
  });

  it("runNMDBetaOnPaths single-path matches the instrument's own decay schedule", () => {
    const horizon = 60;
    const path = risingRatePath(0.02, 0.0005, horizon);
    const terms = {
      ...NMD_B_TERMS_DEFAULTS,
      maturityMonths: horizon,
      notional: 1_000_000,
      nmdParams: { ...NMD_B_TERMS_DEFAULTS.nmdParams, balanceSize: 1_000_000 },
    };
    const inst = new NMDBeta(terms);
    const cf = inst.generateCashflows(path);

    // Build a Float64Array of the same 1M rates the path would emit.
    const arr = new Float64Array(horizon);
    for (let t = 0; t < horizon; t++) arr[t] = path.rateAt(t);
    const out = runNMDBetaOnPaths([arr], terms);

    // Reconstruct cohort balance the MC reports (start = 100 normalised) and
    // compare to the instrument's outputs scaled the same way. We compare up
    // to the second-to-last index — the instrument clamps the final month's
    // principal to remaining balance to fully close the cashflow stream,
    // while the MC leaves the residual to be picked up by the WAL tail piece.
    for (let i = 0; i < horizon - 1; i++) {
      const balDisplayInst = ((cf[i].balance - cf[i].principalPaid) / terms.notional) * 100;
      expect(out.balMean[i]).toBeCloseTo(balDisplayInst, 4);
    }
  });

  it("runNMDBetaOnPaths produces non-trivial dispersion across multiple paths", () => {
    const horizon = 60;
    const terms = {
      ...NMD_B_TERMS_DEFAULTS,
      maturityMonths: horizon,
      notional: 1_000_000,
      nmdParams: { ...NMD_B_TERMS_DEFAULTS.nmdParams, balanceSize: 1_000_000 },
    };
    // Three divergent paths: low, mid, high rate environment.
    const paths: Float64Array[] = [
      Float64Array.from(Array.from({ length: horizon }, () => 0.005)),
      Float64Array.from(Array.from({ length: horizon }, () => 0.04)),
      Float64Array.from(Array.from({ length: horizon }, () => 0.08)),
    ];
    const out = runNMDBetaOnPaths(paths, terms);
    // p95 strictly above p5 at most steps when paths actually diverge.
    let nonTrivial = 0;
    for (let i = 0; i < horizon; i++) {
      if (out.balP95[i] - out.balP5[i] > 1e-3) nonTrivial++;
    }
    expect(nonTrivial).toBeGreaterThan(horizon / 2);
  });

  it("default terms: deterministic-forward WAL on the 3/31 curve lands near 3y", async () => {
    // Pin for the two-tranche prepayment-form recalibration (2026-06-11):
    // uninsured 75% drains in ~2y under the one-sided incentive + salience,
    // insured $250k core runs off at closure-only. Wide band guards against
    // brittleness; a structural regression (e.g. losing the tranche split)
    // moves WAL by years, not tenths.
    const curve = bootstrapZeroCurve(await loadMarketSnapshot(MARKET_PATH));
    const N = NMD_B_TERMS_DEFAULTS.maturityMonths;
    const basePath = new Float64Array(N);
    for (let t = 0; t < N; t++) basePath[t] = curve.forwardRate(t / 12, t / 12 + 1 / 12);
    const out = runNMDBetaOnPaths([basePath], NMD_B_TERMS_DEFAULTS);
    expect(out.wal).toBeGreaterThan(2.6);
    expect(out.wal).toBeLessThan(3.4);
  });

  it("two-tranche split: balance never falls below the insured closure-only trajectory", () => {
    // Even on a punitive high-rate path the insured tranche decays at
    // closure(t) only — total balance is bounded below by it. The uninsured
    // tranche exhausts, so the uninsured share of the remaining balance
    // collapses toward zero.
    const horizon = 240;
    const path = flatCurveRatePath(0.08, horizon);
    const inst = new NMDBeta({ ...NMD_B_TERMS_DEFAULTS, maturityMonths: horizon });
    const sim = inst.simulateTranches(path);
    const p = NMD_B_TERMS_DEFAULTS.nmdParams;
    const tau = Math.max(p.closureTauMonths, 1e-6);
    let insRef = Math.min(p.balanceDenominator, NMD_B_TERMS_DEFAULTS.notional);
    for (let i = 0; i < sim.length - 1; i++) {
      const s = sim[i];
      expect(s.balIns + s.balUnins).toBeGreaterThanOrEqual(insRef - 1e-6);
      const closureT = p.closureSteady + (p.closureInitial - p.closureSteady) * Math.exp(-i / tau);
      insRef *= 1 - closureT / 100;
    }
    const last = sim[sim.length - 1];
    const share = last.balUnins / (last.balIns + last.balUnins);
    expect(share).toBeLessThan(0.01);
  });

  it("rising-rate ITM path: closure overlay decays cohort over the horizon", () => {
    const path = risingRatePath(0.02, 0.0005, 360);
    const inst = new NMDBeta({
      ...NMD_B_TERMS_DEFAULTS,
      notional: 1_000_000,
      maturityMonths: 360,
      nmdParams: { ...NMD_DEFAULTS, balanceSize: 1_000_000 },
    });
    const cf = inst.generateCashflows(path);
    // Cohort drains substantially by horizon.
    expect(cf[cf.length - 1].balance).toBeLessThan(1_000_000 * 0.05);
    // Total decay summed equals notional within rounding (final clamp).
    const total = cf.reduce((s, c) => s + c.principalPaid, 0);
    expect(total).toBeCloseTo(1_000_000, 2);
  });
});
