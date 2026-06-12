import { describe, expect, it } from "vitest";
import { FixedLoan, FIXED_LOAN_DEFAULTS, levelPayPayment } from "../fixedLoan";
import { FloatingLoan, FLOATING_LOAN_DEFAULTS } from "../floatingLoan";
import { DeterministicRatePath, StochasticRatePath } from "../../rates/ratePath";
import type { RatePath } from "../types";

// Stub curve for DeterministicRatePath. Returns a constant 4% forward rate so
// the instrument under test sees a flat term structure.
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

describe("FixedLoan", () => {
  it("level-pay: payment matches the closed-form mortgage formula", () => {
    const loan = new FixedLoan({
      ...FIXED_LOAN_DEFAULTS,
      notional: 100_000,
      coupon: 0.06,
      maturityMonths: 360,
      amortType: "level-pay",
    });
    const expected = levelPayPayment(100_000, 0.06 / 12, 360);
    // Standard 30Y $100k at 6%: ~$599.55/mo.
    expect(expected).toBeCloseTo(599.5505, 3);
    const sum = loan.summary();
    expect(sum.payment).not.toBeNull();
    expect(sum.payment!).toBeCloseTo(expected, 6);
  });

  it("level-pay: total principal repaid equals notional", () => {
    const loan = new FixedLoan({
      ...FIXED_LOAN_DEFAULTS,
      notional: 250_000,
      coupon: 0.045,
      maturityMonths: 360,
      amortType: "level-pay",
    });
    const cf = loan.generateCashflows({} as RatePath);
    const totalPrincipal = cf.reduce((s, c) => s + c.principalPaid, 0);
    expect(totalPrincipal).toBeCloseTo(250_000, 4);
    expect(cf[cf.length - 1].balance).toBeGreaterThan(0); // last row's start-balance > 0
  });

  it("bullet: only interest until maturity, then full notional at end", () => {
    const loan = new FixedLoan({
      ...FIXED_LOAN_DEFAULTS,
      notional: 1_000_000,
      coupon: 0.04,
      maturityMonths: 60,
      amortType: "bullet",
    });
    const cf = loan.generateCashflows({} as RatePath);
    expect(cf).toHaveLength(60);
    for (let i = 0; i < 59; i++) {
      expect(cf[i].principalPaid).toBe(0);
      expect(cf[i].balance).toBe(1_000_000);
      expect(cf[i].interestPaid).toBeCloseTo(1_000_000 * 0.04 / 12, 6);
    }
    expect(cf[59].principalPaid).toBe(1_000_000);
  });
});

describe("FloatingLoan", () => {
  it("level-pay with flat 4% index + 1.25% margin: behaves like a fixed-rate loan at 5.25%", () => {
    const path = flatCurveRatePath(0.04, 60);
    const floater = new FloatingLoan({
      ...FLOATING_LOAN_DEFAULTS,
      notional: 100_000,
      maturityMonths: 60,
      margin: 0.0125,
      resetFrequencyMonths: 1,
      amortType: "level-pay",
    });
    const fixedEquiv = new FixedLoan({
      ...FIXED_LOAN_DEFAULTS,
      notional: 100_000,
      coupon: 0.0525,
      maturityMonths: 60,
      amortType: "level-pay",
    });
    const cfF = floater.generateCashflows(path);
    const cfX = fixedEquiv.generateCashflows({} as RatePath);
    expect(cfF).toHaveLength(60);
    for (let i = 0; i < 60; i++) {
      // Floater re-amortizes each month against an unchanged effective coupon
      // 5.25%, so the schedule should match the fixed equivalent within float
      // tolerance.
      expect(cfF[i].balance).toBeCloseTo(cfX[i].balance, 4);
      expect(cfF[i].principalPaid).toBeCloseTo(cfX[i].principalPaid, 4);
      expect(cfF[i].interestPaid).toBeCloseTo(cfX[i].interestPaid, 4);
      expect(cfF[i].couponRate).toBeCloseTo(0.0525, 8);
    }
  });

  it("repricing schedule: monthly resets give every month from 1..maturity", () => {
    const f = new FloatingLoan({ ...FLOATING_LOAN_DEFAULTS, maturityMonths: 36, resetFrequencyMonths: 1 });
    expect(f.repricingSchedule()).toHaveLength(36);
    expect(f.repricingSchedule()[0]).toBe(1);
    expect(f.repricingSchedule()[35]).toBe(36);
  });

  it("repricing schedule: quarterly reset frequency", () => {
    const f = new FloatingLoan({ ...FLOATING_LOAN_DEFAULTS, maturityMonths: 36, resetFrequencyMonths: 3 });
    expect(f.repricingSchedule()).toEqual([1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34]);
  });

  it("StochasticRatePath: rate steps follow the path's 1M sequence", () => {
    const path = [0.01, 0.02, 0.03, 0.04, 0.05];
    const rp = new StochasticRatePath(path);
    expect(rp.nSteps).toBe(5);
    expect(rp.rateAt(0)).toBe(0.01);
    expect(rp.rateAt(4)).toBe(0.05);
    expect(rp.rateAt(99)).toBe(0.05); // out-of-bounds: hold last
  });

  it("rising-rate path: floater interest grows on each reset", () => {
    // Path that ramps from 3% to 8% linearly over 60 months.
    const path: number[] = [];
    for (let m = 0; m < 60; m++) path.push(0.03 + (0.05 * m) / 59);
    const rp = new StochasticRatePath(path);
    const f = new FloatingLoan({
      ...FLOATING_LOAN_DEFAULTS,
      notional: 1_000_000,
      maturityMonths: 60,
      margin: 0.0,
      resetFrequencyMonths: 1,
      amortType: "bullet",
    });
    const cf = f.generateCashflows(rp);
    // Bullet floater: balance constant, interest = bal·rate(m-1)/12 each month.
    // Strict monotone increase (modulo final-month principal payment).
    for (let i = 1; i < 59; i++) {
      expect(cf[i].interestPaid).toBeGreaterThan(cf[i - 1].interestPaid);
    }
    expect(cf[59].principalPaid).toBe(1_000_000);
  });
});
