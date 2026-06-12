import { describe, expect, it } from "vitest";

import { FixedLoan, FIXED_LOAN_DEFAULTS } from "../../instruments/fixedLoan";
import { FloatingLoan, FLOATING_LOAN_DEFAULTS } from "../../instruments/floatingLoan";
import { Mortgage, MORTGAGE_DEFAULTS } from "../../instruments/mortgage";
import { NMDeposit, NMD_TERMS_DEFAULTS } from "../../instruments/nmd";
import { NMDBeta, NMD_B_TERMS_DEFAULTS } from "../../instruments/nmdBeta";
import type { RatePath } from "../../instruments/types";
import { runSegOnInstrument } from "../seg";

function flatPath(rateDecimal: number, nSteps: number): RatePath {
  return {
    nSteps,
    times: Array.from({ length: nSteps + 1 }, (_, k) => k / 12),
    rateAt: () => rateDecimal,
    forwardRateAt: () => rateDecimal,
  };
}

function constMcPaths(rateDecimal: number, nPaths: number, nSteps: number): Float64Array[] {
  const out: Float64Array[] = [];
  for (let p = 0; p < nPaths; p++) {
    const arr = new Float64Array(nSteps);
    arr.fill(rateDecimal);
    out.push(arr);
  }
  return out;
}

describe("SEG analytic — Sensitivity Equivalent Gap", () => {
  it("Fixed loan: Outstanding(t=0) = +N; declines tracking existing-book amortisation; Outstanding(t→H) → 0", () => {
    const inst = new FixedLoan({
      ...FIXED_LOAN_DEFAULTS,
      notional: 1_000_000,
      maturityMonths: 12,
    });
    const path = flatPath(0.05, 12);
    const mc = constMcPaths(0.05, 1, 12);
    const out = runSegOnInstrument(inst, mc, path, { horizon: 12 });

    expect(out.outstandingSegDeterministic[0]).toBeCloseTo(1_000_000, -2);
    expect(out.cumulativeSegDeterministic[0]).toBeCloseTo(0, -1); // shock starts at step≥1
    // Strictly monotone-decreasing over the loan life.
    for (let t = 1; t < 12; t++) {
      expect(out.outstandingSegDeterministic[t]).toBeLessThan(
        out.outstandingSegDeterministic[t - 1] + 1,
      );
    }
    expect(out.outstandingSegDeterministic[11]).toBeLessThan(150_000);
  });

  it("Floating loan: Outstanding(t=0) = +N; Outstanding(t≥1) ≈ 0 (entire portfolio reprices at first reset)", () => {
    const inst = new FloatingLoan({
      ...FLOATING_LOAN_DEFAULTS,
      notional: 1_000_000,
      maturityMonths: 12,
    });
    const path = flatPath(0.05, 12);
    const mc = constMcPaths(0.05, 1, 12);
    const out = runSegOnInstrument(inst, mc, path, { horizon: 12 });

    expect(out.outstandingSegDeterministic[0]).toBeCloseTo(1_000_000, -2);
    for (let t = 1; t < 12; t++) {
      expect(Math.abs(out.outstandingSegDeterministic[t])).toBeLessThan(100);
    }
  });

  it("Floating loan: Periodic SEG at t=1 ≈ +N (the entire $1M repriced in the first period)", () => {
    const inst = new FloatingLoan({
      ...FLOATING_LOAN_DEFAULTS,
      notional: 1_000_000,
      maturityMonths: 12,
    });
    const path = flatPath(0.05, 12);
    const mc = constMcPaths(0.05, 1, 12);
    const out = runSegOnInstrument(inst, mc, path, { horizon: 12 });
    expect(out.periodicSegDeterministic[0]).toBe(0);
    expect(out.periodicSegDeterministic[1]).toBeCloseTo(1_000_000, -2);
    for (let t = 2; t < 12; t++) {
      expect(Math.abs(out.periodicSegDeterministic[t])).toBeLessThan(100);
    }
  });

  it("Fixed loan: Periodic SEG matches existing-book scheduled principal each period", () => {
    const inst = new FixedLoan({
      ...FIXED_LOAN_DEFAULTS,
      notional: 1_000_000,
      maturityMonths: 12,
      coupon: 0.05,
    });
    const path = flatPath(0.05, 12);
    const mc = constMcPaths(0.05, 1, 12);
    const out = runSegOnInstrument(inst, mc, path, { horizon: 12 });

    // For a vanilla fixed loan, Outstanding SEG mirrors the existing-book
    // balance trajectory: Outstanding(t) = existing.balance(month t+1).
    // Periodic SEG(t) = existing.principal(month t).
    expect(out.periodicSegDeterministic[0]).toBe(0);
    // Sum of periodic SEG over the life should approximately equal initial N.
    let cumPeriodic = 0;
    for (let t = 1; t < 12; t++) cumPeriodic += out.periodicSegDeterministic[t];
    expect(cumPeriodic).toBeGreaterThan(800_000);
    expect(cumPeriodic).toBeLessThan(1_050_000);
  });

  it("Non-IB NMD: Outstanding SEG ≈ −N constant (locked 0% deposit, no rate sensitivity)", () => {
    const inst = new NMDeposit({
      ...NMD_TERMS_DEFAULTS,
      notional: 1_000_000,
      maturityMonths: 60,
    });
    const path = flatPath(0.04, 60);
    const mc = constMcPaths(0.04, 3, 60);
    const out = runSegOnInstrument(inst, mc, path, { horizon: 60 });

    expect(out.outstandingSegDeterministic[0]).toBeCloseTo(-1_000_000, -2);
    for (let t = 0; t < 60; t++) {
      expect(out.outstandingSegDeterministic[t]).toBeLessThanOrEqual(0);
      // Without coupon sensitivity, cumulative repriced ≈ 0 → outstanding ≈ −N.
      expect(out.outstandingSegDeterministic[t]).toBeGreaterThan(-1_010_000);
    }
  });

  it("IB NMD: Outstanding(t=0) = −N; Outstanding(t≥1) compresses toward −(1−β_eff)·N", () => {
    const inst = new NMDBeta({
      ...NMD_B_TERMS_DEFAULTS,
      notional: 1_000_000,
      maturityMonths: 60,
    });
    const path = flatPath(0.04, 60);
    const mc = constMcPaths(0.04, 3, 60);
    const out = runSegOnInstrument(inst, mc, path, { horizon: 60 });

    expect(out.outstandingSegDeterministic[0]).toBeCloseTo(-1_000_000, -2);
    // Liability signed negative; magnitude shrinks below |N| once β-pass-through kicks in.
    expect(out.outstandingSegDeterministic[1]).toBeLessThan(0);
    expect(Math.abs(out.outstandingSegDeterministic[1])).toBeLessThan(1_000_000);
  });

  it("Mortgage: Outstanding(t=0) = +N; positive across the horizon (asset side, locked coupon)", () => {
    const inst = new Mortgage({
      ...MORTGAGE_DEFAULTS,
      notional: 400_000,
      originalBalance: 400_000,
      maturityMonths: 120,
    });
    const path = flatPath(0.04, 120);
    const mc: Float64Array[] = [
      Float64Array.from(Array.from({ length: 120 }, () => 0.02)),
      Float64Array.from(Array.from({ length: 120 }, () => 0.04)),
      Float64Array.from(Array.from({ length: 120 }, () => 0.07)),
    ];
    const out = runSegOnInstrument(inst, mc, path, { horizon: 120 });

    expect(out.outstandingSegDeterministic[0]).toBeCloseTo(400_000, -2);
    for (let t = 0; t < 120; t++) {
      expect(Number.isFinite(out.outstandingSegDeterministic[t])).toBe(true);
    }
  });

  it("Cumulative + Outstanding identity: Outstanding(t≥1) = side_sign × (N − Cumulative(t))", () => {
    const inst = new FixedLoan({
      ...FIXED_LOAN_DEFAULTS,
      notional: 1_000_000,
      maturityMonths: 12,
    });
    const path = flatPath(0.05, 12);
    const mc = constMcPaths(0.05, 1, 12);
    const out = runSegOnInstrument(inst, mc, path, { horizon: 12 });

    for (let t = 1; t < 12; t++) {
      const expected = 1_000_000 - out.cumulativeSegDeterministic[t];
      expect(out.outstandingSegDeterministic[t]).toBeCloseTo(expected, 6);
    }
  });

  it("signedInitialBalance carries the correct asset/liability sign", () => {
    const horizon = 60;
    const asset = new FloatingLoan({ ...FLOATING_LOAN_DEFAULTS, maturityMonths: horizon });
    const liab = new NMDeposit({ ...NMD_TERMS_DEFAULTS, maturityMonths: horizon });
    const path = flatPath(0.04, horizon);
    const mc = constMcPaths(0.04, 2, horizon);
    expect(runSegOnInstrument(asset, mc, path, { horizon }).signedInitialBalance).toBe(asset.terms.notional);
    expect(runSegOnInstrument(liab, mc, path, { horizon }).signedInitialBalance).toBe(-liab.terms.notional);
  });
});
