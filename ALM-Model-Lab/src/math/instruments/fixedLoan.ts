/**
 * Fixed-rate loan instrument.
 *
 * Phase 2 simple instrument: fixed coupon, level-pay or bullet amortization,
 * no optionality (no prepayment, no early termination). Origination at
 * model time-zero; current balance equals notional. Cashflows generated
 * deterministically from terms — the rate path is not used (kept in the
 * signature so the call surface matches the Instrument interface).
 */

import type {
  Cashflow,
  Instrument,
  InstrumentTermsBase,
  RatePath,
} from "./types";

export interface FixedLoanTerms extends InstrumentTermsBase {
  type: "fixed-loan";
  /** Fixed annual coupon, decimal (e.g. 0.05 = 5%). */
  coupon: number;
}

export const FIXED_LOAN_DEFAULTS: FixedLoanTerms = {
  id: "fixed-loan-1",
  type: "fixed-loan",
  label: "Fixed-rate loan",
  notional: 1_000_000,
  maturityMonths: 60,
  originationOffsetMonths: 0,
  amortType: "level-pay",
  coupon: 0.05,
};

/** Compute the constant level-pay monthly payment. */
function levelPayPayment(balance: number, monthlyRate: number, nMonths: number): number {
  if (nMonths <= 0) return balance;
  if (monthlyRate < 1e-12) return balance / nMonths;
  const factor = Math.pow(1 + monthlyRate, nMonths);
  return (balance * monthlyRate * factor) / (factor - 1);
}

export class FixedLoan implements Instrument {
  readonly terms: FixedLoanTerms;

  constructor(terms: FixedLoanTerms) {
    if (terms.notional <= 0) throw new Error("FixedLoan: notional must be positive");
    if (terms.maturityMonths <= 0) throw new Error("FixedLoan: maturity must be positive");
    this.terms = terms;
  }

  /** No reset schedule for a fixed-rate instrument. */
  repricingSchedule(): number[] {
    return [];
  }

  generateCashflows(_path: RatePath): Cashflow[] {
    const { notional, maturityMonths, amortType, coupon } = this.terms;
    const monthlyRate = coupon / 12;
    const out: Cashflow[] = [];

    if (amortType === "bullet") {
      // Interest-only until maturity; principal at maturity.
      let bal = notional;
      for (let m = 1; m <= maturityMonths; m++) {
        const interest = bal * monthlyRate;
        const principalPaid = m === maturityMonths ? bal : 0;
        const newBal = bal - principalPaid;
        out.push({
          monthOffset: m,
          balance: bal,
          principalPaid,
          interestPaid: interest,
          couponRate: coupon,
        });
        bal = newBal;
      }
      return out;
    }

    // level-pay
    const payment = levelPayPayment(notional, monthlyRate, maturityMonths);
    let bal = notional;
    for (let m = 1; m <= maturityMonths; m++) {
      const interest = bal * monthlyRate;
      let principal = payment - interest;
      // Final payment may slightly under-pay due to rounding; clamp.
      if (m === maturityMonths || principal > bal) principal = bal;
      out.push({
        monthOffset: m,
        balance: bal,
        principalPaid: principal,
        interestPaid: interest,
        couponRate: coupon,
      });
      bal -= principal;
      if (bal < 0) bal = 0;
    }
    return out;
  }

  /** Helpful summary scalars for the UI. */
  summary(): { totalPrincipal: number; totalInterest: number; nMonths: number; payment: number | null } {
    const cf = this.generateCashflows({} as RatePath);
    const totalPrincipal = cf.reduce((s, c) => s + c.principalPaid, 0);
    const totalInterest = cf.reduce((s, c) => s + c.interestPaid, 0);
    const payment =
      this.terms.amortType === "level-pay"
        ? levelPayPayment(this.terms.notional, this.terms.coupon / 12, this.terms.maturityMonths)
        : null;
    return { totalPrincipal, totalInterest, nMonths: cf.length, payment };
  }
}

/** Re-export the helper for tests + future re-amortization callers (floater). */
export { levelPayPayment };

/** Type guard. */
export function isFixedLoanTerms(t: InstrumentTermsBase): t is FixedLoanTerms {
  return t.type === "fixed-loan";
}

