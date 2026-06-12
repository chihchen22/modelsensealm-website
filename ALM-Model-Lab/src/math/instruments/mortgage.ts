/**
 * Mortgage instrument.
 *
 * Phase 5: promotes the standalone MBS prepayment runner to a first-class
 * Instrument that participates in the ALM analytics tabs (Repricing Gap,
 * Liquidity Gap, FTP). Cashflows are driven by:
 *
 *   1. Scheduled principal under remaining-term level-pay amortization at the
 *      locked note rate. Standard agency-MBS pool convention: scheduled
 *      principal recomputed each month against current balance and remaining
 *      WAM.
 *   2. Prepayment principal driven by the four-factor CPR from
 *      src/math/behavioral/prepay (FourFactorCPR via the PrepayModel seam):
 *      refi incentive logistic on (wac - mortgageRate), seasoning ramp on loan
 *      age, calendar seasonality, and exponential burnout on cumulative ITM.
 *
 * The benchmark mortgage rate at each month is taken from the rate path's
 * 10Y forward + (sec_spread + prim_spread). Under the deterministic path
 * this is the bootstrapped 10Y forward; under HW or BGM it's a simulated
 * 10Y projection (handled by the path's forwardRateAt implementation).
 *
 * From the bank's repricing-gap perspective the mortgage is fixed-rate:
 * repricingSchedule() returns []. Principal returns (scheduled + prepay)
 * are the repricing events, since each repaid dollar must be reinvested
 * at the prevailing market rate.
 */

import type {
  Cashflow,
  Instrument,
  InstrumentTermsBase,
  RatePath,
} from "./types";
import { MBS_DEFAULTS, type MBSParams } from "../behavioral/mbsModel";
import { FourFactorCPR, amortizeMortgage, type PrepayContext } from "../behavioral/prepay";

const MORTGAGE_BENCHMARK_TENOR_YEARS = 10;

export interface MortgageTerms extends InstrumentTermsBase {
  type: "mortgage";
  /** Locked note coupon, decimal annualised (e.g. 0.065 = 6.50%). */
  noteRate: number;
  /** Original loan term at origination, in months (typically 360). */
  originalTermMonths: number;
  /** Original loan balance at origination, for display / context only. */
  originalBalance: number;
  /** Months elapsed since origination at simulation time-zero. */
  ageMonths: number;
  /** Full CPR parameter set including refi-incentive, seasoning, seasonality, burnout. */
  cprParams: MBSParams;
}

export const MORTGAGE_DEFAULTS: MortgageTerms = {
  id: "mortgage-1",
  type: "mortgage",
  label: "Mortgage",
  notional: 400_000,
  originalBalance: 400_000,
  originalTermMonths: 360,
  ageMonths: 0,
  maturityMonths: 360,
  originationOffsetMonths: 0,
  amortType: "level-pay",
  noteRate: 0.065,
  cprParams: MBS_DEFAULTS,
};

export class Mortgage implements Instrument {
  readonly terms: MortgageTerms;

  constructor(terms: MortgageTerms) {
    if (terms.notional <= 0) throw new Error("Mortgage: notional must be positive");
    if (terms.maturityMonths <= 0) throw new Error("Mortgage: maturityMonths must be positive");
    if (terms.noteRate < 0) throw new Error("Mortgage: noteRate must be non-negative");
    if (terms.cprParams.seasoningRamp <= 0) throw new Error("Mortgage: seasoningRamp must be positive");
    this.terms = terms;
  }

  /** Mortgages are fixed-rate; no scheduled coupon resets. */
  repricingSchedule(): number[] {
    return [];
  }

  generateCashflows(path: RatePath): Cashflow[] {
    const { notional, maturityMonths, noteRate, ageMonths, cprParams } = this.terms;

    // Mortgage benchmark rate = 10Y forward at this step + (sec + prim) spread.
    const totalSpread = (cprParams.secSpread + cprParams.primSpread) / 1e4;
    const ctx: PrepayContext = {
      term: maturityMonths,
      age: ageMonths,
      noteRate,
      mortgageRateAt: (m) =>
        path.forwardRateAt(m - 1, MORTGAGE_BENCHMARK_TENOR_YEARS) + totalSpread,
    };

    const cprSchedule = new FourFactorCPR(cprParams).cprSchedule(ctx);
    return amortizeMortgage({ notional, noteRate, term: maturityMonths, cprSchedule });
  }

  /** Helpful summary scalars for the UI. */
  summary(path: RatePath): {
    nMonths: number;
    totalPrincipal: number;
    totalInterest: number;
    walYears: number;
  } {
    const cf = this.generateCashflows(path);
    let totalPrincipal = 0;
    let totalInterest = 0;
    let walNum = 0;
    let walDen = 0;
    for (const c of cf) {
      totalPrincipal += c.principalPaid;
      totalInterest += c.interestPaid;
      walNum += (c.monthOffset / 12) * c.principalPaid;
      walDen += c.principalPaid;
    }
    return {
      nMonths: cf.length,
      totalPrincipal,
      totalInterest,
      walYears: walDen > 1e-12 ? walNum / walDen : 0,
    };
  }
}

export function isMortgageTerms(t: InstrumentTermsBase): t is MortgageTerms {
  return t.type === "mortgage";
}
