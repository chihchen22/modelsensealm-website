import { describe, expect, it } from "vitest";

import { FixedLoan, FIXED_LOAN_DEFAULTS } from "../../instruments/fixedLoan";
import { FloatingLoan, FLOATING_LOAN_DEFAULTS } from "../../instruments/floatingLoan";
import { Mortgage, MORTGAGE_DEFAULTS } from "../../instruments/mortgage";
import { MBS_DEFAULTS } from "../../behavioral/mbsModel";
import { NMDeposit, NMD_TERMS_DEFAULTS } from "../../instruments/nmd";
import { NMDBeta, NMD_B_TERMS_DEFAULTS } from "../../instruments/nmdBeta";
import { DeterministicRatePath } from "../../rates/ratePath";
import type { ZeroCurve } from "../../rates/bootstrap";
import {
  buildTLPCurve,
  DEFAULT_TLP_CURVE,
  DEFAULT_TLP_NODES,
  parseTLPCurveCSV,
} from "../../rates/tlpCurve";

import { computeFTP } from "../ftp";

/**
 * Flat curve whose discount factors equal (1 + r/12)^(-12 t), i.e. simple-monthly
 * compounding at annual rate r. Used so the par-match identity FTP = r holds
 * exactly under the loan's simple-monthly accrual convention.
 */
function flatSimpleMonthlyCurve(annualRate: number): ZeroCurve {
  const z = 12 * Math.log(1 + annualRate / 12);
  return {
    t: [],
    z: [],
    zeroRate: () => z,
    discountFactor: (t: number) => Math.exp(-z * t),
    forwardRate(t1: number, t2: number) {
      return (Math.exp(-z * t1) / Math.exp(-z * t2) - 1) / (t2 - t1);
    },
    forwardSwapRate(t1: number, t2: number) {
      const tau = t2 - t1;
      const df = (u: number) => Math.exp(-z * u);
      if (tau <= 1.0 + 1e-9) return (df(t1) / df(t2) - 1) / tau;
      const n = Math.round(tau);
      let annuity = 0;
      for (let k = 1; k <= n; k++) annuity += (365 / 360) * df(t1 + k);
      return (df(t1) - df(t1 + n)) / annuity;
    },
  };
}

/** TLP curve flat at a constant spread for every tenor. */
const flatTLP = (spread: number) =>
  buildTLPCurve([
    { tYears: 0, spread },
    { tYears: 30, spread },
  ]);

const ZERO_TLP = flatTLP(0);

describe("TLP curve", () => {
  it("default curve has 12 nodes and zero TLP at overnight", () => {
    expect(DEFAULT_TLP_NODES.length).toBe(12);
    expect(DEFAULT_TLP_CURVE.tlp(0)).toBe(0);
  });

  it("interpolates linearly between node tenors", () => {
    const c = buildTLPCurve([
      { tYears: 1, spread: 0.01 },
      { tYears: 3, spread: 0.03 },
    ]);
    expect(c.tlp(2)).toBeCloseTo(0.02, 12);
    expect(c.tlp(0.5)).toBeCloseTo(0.01, 12); // clamps to first node
    expect(c.tlp(5)).toBeCloseTo(0.03, 12); // clamps to last node
  });

  it("default curve hits the 9/30/2025 1Y and 5Y values", () => {
    expect(DEFAULT_TLP_CURVE.tlp(1)).toBeCloseTo(0.0031, 12);
    expect(DEFAULT_TLP_CURVE.tlp(5)).toBeCloseTo(0.0056, 12);
  });

  it("CSV parser accepts decimal and percent inputs", () => {
    const csvDecimal = "tenor,tlp\n0,0\n1,0.0031\n5,0.0056";
    const decimalNodes = parseTLPCurveCSV(csvDecimal);
    expect(decimalNodes).toHaveLength(3);
    expect(decimalNodes[1].spread).toBeCloseTo(0.0031, 12);

    const csvPercent = "tenor,tlp\n0,0\n1,0.31\n5,0.56";
    const percentNodes = parseTLPCurveCSV(csvPercent);
    expect(percentNodes).toHaveLength(3);
    expect(percentNodes[1].spread).toBeCloseTo(0.0031, 12);
    expect(percentNodes[2].spread).toBeCloseTo(0.0056, 12);
  });

  it("CSV parser tolerates BOMs and Windows line endings", () => {
    const csv = "﻿tenor_years,tlp\r\n0,0\r\n1,0.0031\r\n";
    const nodes = parseTLPCurveCSV(csv);
    expect(nodes).toHaveLength(2);
    expect(nodes[1].tYears).toBe(1);
  });
});

describe("FTP — par-matched static strip with TLP overlay", () => {
  it("flat simple-monthly SOFR curve, zero TLP -> all-in FTP equals SOFR rate", () => {
    const r = 0.04;
    const curve = flatSimpleMonthlyCurve(r);
    const path = new DeterministicRatePath(curve, 60);
    const loan = new FixedLoan({
      ...FIXED_LOAN_DEFAULTS,
      notional: 1_000_000,
      maturityMonths: 60,
      coupon: 0.06,
      amortType: "level-pay",
    });
    const result = computeFTP([loan], curve, ZERO_TLP, path);
    const row = result.perInstrument[0];
    expect(row.irFtpRate).toBeCloseTo(r, 8);
    expect(row.allInFtpRate).toBeCloseTo(r, 8);
    expect(row.lpFtpRate).toBeCloseTo(0, 8);
    expect(row.assetRate).toBeCloseTo(0.06, 6);
    expect(row.ftpMargin).toBeCloseTo(0.06 - r, 6);
  });

  it("flat SOFR + flat TLP overlay: LP FTP equals the TLP spread within tolerance", () => {
    const r = 0.04;
    const lp = 0.005;
    const curve = flatSimpleMonthlyCurve(r);
    const tlp = flatTLP(lp);
    const path = new DeterministicRatePath(curve, 60);
    const loan = new FixedLoan({
      ...FIXED_LOAN_DEFAULTS,
      notional: 1_000_000,
      maturityMonths: 60,
      coupon: 0.06,
    });
    const result = computeFTP([loan], curve, tlp, path);
    const row = result.perInstrument[0];
    expect(row.irFtpRate).toBeCloseTo(r, 8);
    // Adding a flat continuous LP spread to a simple-monthly curve introduces a
    // small compounding-mismatch bias (~lp^2/2). For 50 bps that's <1 bp; we
    // require par-match within 5 bps and the decomposition identity exactly.
    expect(row.allInFtpRate).toBeGreaterThan(r);
    expect(Math.abs(row.allInFtpRate - (r + lp))).toBeLessThan(0.0005);
    expect(row.lpFtpRate).toBeCloseTo(row.allInFtpRate - row.irFtpRate, 12);
  });

  it("decomposition is exactly additive: LP FTP = all-in FTP - IR FTP", () => {
    const curve = flatSimpleMonthlyCurve(0.04);
    const path = new DeterministicRatePath(curve, 60);
    const fixed = new FixedLoan({ ...FIXED_LOAN_DEFAULTS, id: "f1", notional: 1_000_000, coupon: 0.06 });
    const floater = new FloatingLoan({ ...FLOATING_LOAN_DEFAULTS, id: "fl1", notional: 1_000_000, margin: 0.0125 });
    const result = computeFTP([fixed, floater], curve, DEFAULT_TLP_CURVE, path);
    for (const row of result.perInstrument) {
      expect(row.lpFtpRate).toBeCloseTo(row.allInFtpRate - row.irFtpRate, 12);
      expect(row.ftpMargin).toBeCloseTo(row.assetRate - row.allInFtpRate, 12);
    }
  });

  it("book NIM is notional-weighted across instruments", () => {
    const curve = flatSimpleMonthlyCurve(0.04);
    const path = new DeterministicRatePath(curve, 60);
    const fixed = new FixedLoan({ ...FIXED_LOAN_DEFAULTS, id: "f1", notional: 1_000_000, coupon: 0.06 });
    const floater = new FloatingLoan({ ...FLOATING_LOAN_DEFAULTS, id: "fl1", notional: 1_000_000, margin: 0.0125 });
    const result = computeFTP([fixed, floater], curve, ZERO_TLP, path);
    const fixedNim = result.perInstrument[0].ftpMargin;
    const floatNim = result.perInstrument[1].ftpMargin;
    // Equal notionals so book NIM = average.
    expect(result.bookNim).toBeCloseTo((fixedNim + floatNim) / 2, 10);
  });

  it("liability: FTP margin is reported as positive franchise value (allInFTP − depositRate)", () => {
    const curve = flatSimpleMonthlyCurve(0.04);
    const path = new DeterministicRatePath(curve, 120);
    const nmd = new NMDeposit(
      { ...NMD_TERMS_DEFAULTS, depositRate: 0.005 },
      // Synthesize a flat 4% history so spread reads zero throughout the projection.
      new Array(120).fill(4.0),
    );
    const result = computeFTP([nmd], curve, ZERO_TLP, path);
    const row = result.perInstrument[0];
    expect(row.side).toBe("liability");
    // Asset side would have ftpMargin = depositRate − allInFTP (negative, since
    // deposit rate 0.5% << SOFR ~4%). Liability flip makes it positive.
    expect(row.ftpMargin).toBeGreaterThan(0);
    expect(row.ftpMargin).toBeCloseTo(row.allInFtpRate - row.assetRate, 12);
  });

  it("IB NMD FTP: headline rate equals (1−β) · fixed + β · 1M SOFR", () => {
    const curve = flatSimpleMonthlyCurve(0.04);
    const horizon = 360;
    const path = new DeterministicRatePath(curve, horizon);
    // Pin β with a near-step S-curve at low inflection so β(r=4%) ≈ β_max.
    const nmdB = new NMDBeta({
      ...NMD_B_TERMS_DEFAULTS,
      id: "nmd-b",
      sCurve: { ...NMD_B_TERMS_DEFAULTS.sCurve, betaMin: 0.2, betaMax: 0.7, k: 50, m: 0 },
    });
    const result = computeFTP([nmdB], curve, ZERO_TLP, path);
    const row = result.perInstrument[0];
    expect(row.side).toBe("liability");
    // Fixed-slice par-match against the decay schedule under the SOFR DF.
    const cf = nmdB.generateCashflows(path);
    const N = nmdB.terms.notional;
    let pvP = 0;
    let ann = 0;
    for (const c of cf) {
      const t = c.monthOffset / 12;
      const d = curve.discountFactor(t);
      pvP += d * c.principalPaid;
      ann += d * c.balance * (1 / 12);
    }
    const fixed = ann > 1e-12 ? (N - pvP) / ann : 0;
    const float1M = curve.forwardRate(0, 1 / 12);
    const beta = nmdB.initialBeta(path);
    const expectedBlend = (1 - beta) * fixed + beta * float1M;
    expect(row.allInFtpRate).toBeCloseTo(expectedBlend, 10);
    // β at r = 4% with the near-step curve is essentially β_max = 0.7.
    expect(beta).toBeCloseTo(0.7, 6);
  });

  it("five-instrument book (incl. NMD-A and NMD-B) preserves decomposition identity", () => {
    const curve = flatSimpleMonthlyCurve(0.04);
    const horizon = 360;
    const path = new DeterministicRatePath(curve, horizon);
    const fixed = new FixedLoan({ ...FIXED_LOAN_DEFAULTS, id: "f1", notional: 1_000_000, coupon: 0.06 });
    const floater = new FloatingLoan({ ...FLOATING_LOAN_DEFAULTS, id: "fl1", notional: 1_000_000, margin: 0.0125 });
    const mortgage = new Mortgage({
      ...MORTGAGE_DEFAULTS,
      id: "m1",
      notional: 400_000,
      noteRate: 0.065,
      cprParams: { ...MBS_DEFAULTS, minCpr: 0, maxCpr: 0 },
    });
    const nmdA = new NMDeposit(
      { ...NMD_TERMS_DEFAULTS, id: "nmd-a", depositRate: 0 },
      new Array(360).fill(4.0),
    );
    const nmdB = new NMDBeta({ ...NMD_B_TERMS_DEFAULTS, id: "nmd-b" });
    const result = computeFTP([fixed, floater, mortgage, nmdA, nmdB], curve, DEFAULT_TLP_CURVE, path);
    expect(result.perInstrument).toHaveLength(5);
    for (const row of result.perInstrument) {
      expect(row.lpFtpRate).toBeCloseTo(row.allInFtpRate - row.irFtpRate, 10);
      const expected =
        row.side === "liability"
          ? row.allInFtpRate - row.assetRate
          : row.assetRate - row.allInFtpRate;
      expect(row.ftpMargin).toBeCloseTo(expected, 10);
    }
    // NMD-B's asset rate (deposit rate) is the balance-weighted realised D(t),
    // which is non-zero and below NMD-A's all-in FTP credit.
    const nmdBRow = result.perInstrument[4];
    expect(nmdBRow.side).toBe("liability");
    expect(nmdBRow.assetRate).toBeGreaterThan(0);
  });

  it("three-instrument book including mortgage: decomposition identity holds", () => {
    const curve = flatSimpleMonthlyCurve(0.04);
    const horizon = 360;
    const path = new DeterministicRatePath(curve, horizon);
    const fixed = new FixedLoan({ ...FIXED_LOAN_DEFAULTS, id: "f1", notional: 1_000_000, coupon: 0.06 });
    const floater = new FloatingLoan({ ...FLOATING_LOAN_DEFAULTS, id: "fl1", notional: 1_000_000, margin: 0.0125 });
    const mortgage = new Mortgage({
      ...MORTGAGE_DEFAULTS,
      id: "m1",
      notional: 400_000,
      noteRate: 0.065,
      cprParams: { ...MBS_DEFAULTS, minCpr: 0, maxCpr: 0 }, // disable prepay for stable test
    });
    const result = computeFTP([fixed, floater, mortgage], curve, DEFAULT_TLP_CURVE, path);
    expect(result.perInstrument).toHaveLength(3);
    for (const row of result.perInstrument) {
      // Decomposition identity: LP FTP = all-in FTP − IR FTP.
      expect(row.lpFtpRate).toBeCloseTo(row.allInFtpRate - row.irFtpRate, 10);
      // FTP margin identity: FTP margin = asset rate − all-in FTP.
      expect(row.ftpMargin).toBeCloseTo(row.assetRate - row.allInFtpRate, 10);
    }
    // Mortgage row picks up the noteRate as asset rate.
    expect(result.perInstrument[2].assetRate).toBeCloseTo(0.065, 6);
  });
});

describe("FTP — monthly coupon vs FTP series", () => {
  it("fixed loan: coupon and FTP are flat at constant values", () => {
    const curve = flatSimpleMonthlyCurve(0.04);
    const path = new DeterministicRatePath(curve, 60);
    const loan = new FixedLoan({ ...FIXED_LOAN_DEFAULTS, notional: 1_000_000, maturityMonths: 60, coupon: 0.06 });
    const result = computeFTP([loan], curve, DEFAULT_TLP_CURVE, path);
    const row = result.perInstrument[0];
    expect(row.monthlySeries.length).toBe(60);
    for (const m of row.monthlySeries) {
      expect(m.couponRate).toBeCloseTo(0.06, 12);
      expect(m.ftpRate).toBeCloseTo(row.allInFtpRate, 12);
    }
  });

  it("floater: coupon and FTP both float; coupon - FTP = margin - 1M_TLP, constant across months", () => {
    const r = 0.045;
    const lp = 0.0021; // matches default 1M TLP
    const curve = flatSimpleMonthlyCurve(r);
    const tlp = flatTLP(lp);
    const path = new DeterministicRatePath(curve, 60);
    const loan = new FloatingLoan({
      ...FLOATING_LOAN_DEFAULTS,
      notional: 1_000_000,
      maturityMonths: 60,
      margin: 0.0125,
      resetFrequencyMonths: 1,
    });
    const result = computeFTP([loan], curve, tlp, path);
    const row = result.perInstrument[0];
    expect(row.monthlySeries.length).toBe(60);
    for (const m of row.monthlySeries) {
      // Under flat curve every reset gives spot SOFR = r, so coupon = r + 0.0125,
      // FTP = r + lp. Spread coupon - FTP = 0.0125 - lp, locked.
      expect(m.couponRate).toBeCloseTo(r + 0.0125, 6);
      expect(m.ftpRate).toBeCloseTo(r + lp, 6);
      expect(m.couponRate - m.ftpRate).toBeCloseTo(0.0125 - lp, 6);
    }
  });

  it("floater under upward-sloping SOFR: coupon and FTP both rise with the curve, spread holds", () => {
    // 2% at t=0, 6% at t=10, linear in zero rate.
    const curve: ZeroCurve = {
      t: [0, 10],
      z: [0.02, 0.06],
      zeroRate(time: number) {
        if (time <= 0) return 0.02;
        if (time >= 10) return 0.06;
        return 0.02 + (0.06 - 0.02) * (time / 10);
      },
      discountFactor(time: number) {
        return Math.exp(-this.zeroRate(time) * time);
      },
      forwardRate(t1: number, t2: number) {
        return (this.discountFactor(t1) / this.discountFactor(t2) - 1) / (t2 - t1);
      },
      forwardSwapRate(t1: number, t2: number) {
        const tau = t2 - t1;
        if (tau <= 1.0 + 1e-9) return (this.discountFactor(t1) / this.discountFactor(t2) - 1) / tau;
        const n = Math.round(tau);
        let annuity = 0;
        for (let k = 1; k <= n; k++) annuity += (365 / 360) * this.discountFactor(t1 + k);
        return (this.discountFactor(t1) - this.discountFactor(t1 + n)) / annuity;
      },
    };
    const path = new DeterministicRatePath(curve, 60);
    const loan = new FloatingLoan({
      ...FLOATING_LOAN_DEFAULTS,
      notional: 1_000_000,
      maturityMonths: 60,
      margin: 0.0125,
      resetFrequencyMonths: 1,
    });
    const result = computeFTP([loan], curve, DEFAULT_TLP_CURVE, path);
    const row = result.perInstrument[0];
    // Spread coupon - FTP = (margin) - (1M TLP) at every reset, regardless of where SOFR is.
    const tlp1m = DEFAULT_TLP_CURVE.tlp(1 / 12);
    for (const m of row.monthlySeries) {
      expect(m.couponRate - m.ftpRate).toBeCloseTo(0.0125 - tlp1m, 6);
    }
    // And the coupon series should rise meaningfully over the 5y horizon.
    expect(row.monthlySeries[59].couponRate).toBeGreaterThan(row.monthlySeries[0].couponRate);
  });
});
