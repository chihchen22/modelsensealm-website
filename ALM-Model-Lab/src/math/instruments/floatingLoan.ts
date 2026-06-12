/**
 * Floating-rate loan instrument.
 *
 * Phase 2 simple instrument: indexed to 1M SOFR with a margin spread, level-pay
 * or bullet amortization. On each reset month the coupon resets to the
 * current path-realised index rate plus the static margin. For level-pay the
 * payment re-amortizes at each reset (standard practice for floaters).
 *
 * No optionality; no caps/floors (could add in a later phase). Origination at
 * model time-zero; current balance equals notional.
 */

import type {
  Cashflow,
  Instrument,
  InstrumentTermsBase,
  RatePath,
} from "./types";
import { levelPayPayment } from "./fixedLoan";

export interface FloatingLoanTerms extends InstrumentTermsBase {
  type: "floating-loan";
  /** Index tenor in months (1 = 1M SOFR). For Phase 2 only 1M is supported. */
  indexTenorMonths: number;
  /** Static margin over the index, decimal annualised. */
  margin: number;
  /** Reset cadence in months (1 = monthly). */
  resetFrequencyMonths: number;
}

export const FLOATING_LOAN_DEFAULTS: FloatingLoanTerms = {
  id: "floating-loan-1",
  type: "floating-loan",
  label: "Floating-rate loan",
  notional: 1_000_000,
  maturityMonths: 60,
  originationOffsetMonths: 0,
  amortType: "level-pay",
  indexTenorMonths: 1,
  margin: 0.0125,
  resetFrequencyMonths: 1,
};

export class FloatingLoan implements Instrument {
  readonly terms: FloatingLoanTerms;

  constructor(terms: FloatingLoanTerms) {
    if (terms.notional <= 0) throw new Error("FloatingLoan: notional must be positive");
    if (terms.maturityMonths <= 0) throw new Error("FloatingLoan: maturity must be positive");
    if (terms.resetFrequencyMonths < 1) {
      throw new Error("FloatingLoan: resetFrequencyMonths must be >= 1");
    }
    this.terms = terms;
  }

  /** Reset months: 1, 1+R, 1+2R, ... up to maturity. */
  repricingSchedule(): number[] {
    const { resetFrequencyMonths, maturityMonths } = this.terms;
    const out: number[] = [];
    for (let m = 1; m <= maturityMonths; m += resetFrequencyMonths) out.push(m);
    return out;
  }

  generateCashflows(path: RatePath): Cashflow[] {
    const { notional, maturityMonths, amortType, margin, resetFrequencyMonths } = this.terms;
    const out: Cashflow[] = [];
    let bal = notional;
    let currentCoupon = path.rateAt(0) + margin;
    let currentPayment = amortType === "level-pay"
      ? levelPayPayment(bal, currentCoupon / 12, maturityMonths)
      : 0;

    for (let m = 1; m <= maturityMonths; m++) {
      // Reset on schedule: month 1 (origination reset), then every R months.
      const isResetMonth = ((m - 1) % resetFrequencyMonths) === 0;
      if (isResetMonth) {
        currentCoupon = path.rateAt(m - 1) + margin;
        if (amortType === "level-pay") {
          const remaining = maturityMonths - (m - 1);
          currentPayment = levelPayPayment(bal, currentCoupon / 12, remaining);
        }
      }

      const monthlyRate = currentCoupon / 12;
      const interest = bal * monthlyRate;

      let principal: number;
      if (amortType === "bullet") {
        principal = m === maturityMonths ? bal : 0;
      } else {
        principal = currentPayment - interest;
        if (m === maturityMonths || principal > bal) principal = bal;
      }

      out.push({
        monthOffset: m,
        balance: bal,
        principalPaid: principal,
        interestPaid: interest,
        couponRate: currentCoupon,
      });
      bal -= principal;
      if (bal < 0) bal = 0;
    }
    return out;
  }
}

export function isFloatingLoanTerms(t: InstrumentTermsBase): t is FloatingLoanTerms {
  return t.type === "floating-loan";
}
