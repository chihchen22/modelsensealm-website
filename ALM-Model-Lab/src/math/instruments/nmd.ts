/**
 * Non-maturity deposit (NMD) instrument — Phase 6, two-tranche form.
 *
 * Decay model: prepayment-form two-tranche split at the FDIC insured threshold
 * D_ref (= nmdParams.balanceDenominator, default $250k). Mirrors the IB NMD
 * (nmdBeta.ts) structure but keeps the r − MA(r) rate-surprise spread as the
 * logistic argument (IB NMD uses r − D):
 *
 *   - Insured tranche: min(D_ref, notional) — baseline closure only (turnover
 *     analog; relationship-driven attrition that is insensitive to rate level).
 *   - Uninsured tranche: remainder — closure composed with a one-sided incentive
 *     logistic S(spread) · B(t) · salience(r):
 *
 *       spread(t) = r_1M(t) − MA_P(r_1M; t)         ← rate-surprise driver
 *       base_incentive(t) = maxRateGrowth + (maxRateDecay − maxRateGrowth) /
 *                           (1 + exp(−K · (spread − midpoint)))
 *       salience(t) = max(0, r_1M(t)) / salienceRefPct   ← cash-sorting level
 *       rateIncentiveDecay(t) = max(0, base_incentive · B(t) · salience(t))
 *
 *   default: maxRateGrowth = 0 (one-sided), burnoutLambda = 0 (no burnout),
 *   salienceRefPct = 4 (% pa normaliser).
 *
 *   decay_ins(t)   = closure(t)
 *   decay_unins(t) = 1 − (1 − closure(t)) · (1 − rateIncentiveDecay(t) / 100)
 *
 * Path dependency: the logistic argument still uses the r − MA(r) spread, so
 * the MA warmup history is retained (same convention as pre-tranche Non-IB NMD).
 * The MA is in % pa; warmup is truncated at the Sep 2025 calibration date.
 *
 * Bank's-perspective convention: liability. depositRate = 0 for Non-IB.
 * The full FTP credit on the all-in funding curve is the deposit franchise.
 */

import type {
  Cashflow,
  Instrument,
  InstrumentTermsBase,
  RatePath,
} from "./types";
import {
  buildWarmupSOFR1M,
  NMD_DEFAULTS,
  type NMDParams,
} from "../behavioral/nmdModel";

export interface NMDTerms extends InstrumentTermsBase {
  type: "nmd";
  /** Static deposit rate the bank pays, decimal annualised (0 for Non-IB). */
  depositRate: number;
  /**
   * Deposit-rate β against the market index. Drives the repricing-gap split:
   * the (1 − β) fraction is rate-locked (fixed-rate gap), β × initial_balance
   * reprices at the next reset bucket. NMD-A defaults to β = 0 (fully rate-locked).
   */
  beta: number;
  /** Closure-and-incentive parameter set. */
  nmdParams: NMDParams;
  /**
   * Rate-level salience normalization (% pa, default 4). The uninsured
   * incentive scales by max(0, r) / salienceRefPct — the cash-sorting effect:
   * a given r − MA spread moves money much faster at 6% than at 1%. Salience
   * uses the rate LEVEL r, not the spread, so it is independent of the MA lag.
   * Set to a large number to disable.
   */
  salienceRefPct?: number;
}

export const NMD_TERMS_DEFAULTS: NMDTerms = {
  id: "nmd-1",
  type: "nmd",
  label: "Non-IB NMD",
  notional: 1_000_000,
  maturityMonths: 360,
  originationOffsetMonths: 0,
  amortType: "level-pay",
  side: "liability",
  depositRate: 0,
  beta: 0,
  // Two-tranche prepayment-form calibration (tuned 2026-06-11 for det WAL ~5y
  // on the 3/31 curve with notional $1M and D_ref $250k):
  //   maxRateGrowth = 0    → one-sided refi shape (no inflow side)
  //   burnoutLambda = 0    → money stays rate-responsive throughout
  //   maxRateDecay = 3     → uninsured plateau %/mo
  //   logisticMidpoint = 0 → r−MA spread oscillates near 0 (non-IB regime)
  //   logisticK = 1.5      → matched to IB NMD curvature
  //   salienceRefPct = 4   → cash-sorting multiplier r/4 on the incentive
  nmdParams: {
    ...NMD_DEFAULTS,
    maxRateDecay: 3,
    maxRateGrowth: 0,
    burnoutLambda: 0,
    logisticMidpoint: 0.0,
    logisticK: 1.5,
  },
  salienceRefPct: 4,
};

export class NMDeposit implements Instrument {
  readonly terms: NMDTerms;
  private readonly historical: ReadonlyArray<number>;

  constructor(terms: NMDTerms, historical?: ReadonlyArray<number>) {
    if (terms.notional <= 0) throw new Error("NMDeposit: notional must be positive");
    if (terms.maturityMonths <= 0) throw new Error("NMDeposit: projection horizon must be positive");
    if (terms.depositRate < 0) throw new Error("NMDeposit: depositRate must be non-negative");
    if (terms.nmdParams.maPeriod <= 0) throw new Error("NMDeposit: maPeriod must be positive");
    this.terms = terms;
    this.historical = historical ?? buildWarmupSOFR1M();
  }

  repricingSchedule(): number[] {
    return [];
  }

  /**
   * Two-tranche monthly simulation. Insured tranche decays at closure(t) only;
   * uninsured tranche at closure(t) composed with the clamped one-sided incentive
   * scaled by cash-sorting salience. Returns per-month tranche opening balances
   * alongside the cashflow legs; generateCashflows and the tranche-share chart
   * both consume this so the loop exists exactly once.
   *
   * Spread driver: r_1M − MA(r_1M), keeping the MA warmup machinery for the
   * rate-surprise signal (unlike IB NMD which uses r − D).
   */
  simulateTranches(path: RatePath): Array<{
    monthOffset: number;
    balIns: number;
    balUnins: number;
    principalPaid: number;
    interestPaid: number;
    couponRate: number;
  }> {
    const { notional, maturityMonths, depositRate, nmdParams } = this.terms;
    const D = nmdParams.balanceDenominator;
    const monthlyDepositRate = depositRate / 12;
    const salienceRef = this.terms.salienceRefPct ?? 4;

    const histLen = this.historical.length;
    if (histLen < nmdParams.maPeriod) {
      throw new Error(`NMDeposit: historical SOFR too short for MA period of ${nmdParams.maPeriod}`);
    }

    // Build [historical || path] rate array in % pa for MA computation.
    const fullHistory: number[] = new Array(histLen + maturityMonths);
    for (let i = 0; i < histLen; i++) fullHistory[i] = this.historical[i];
    for (let t = 0; t < maturityMonths; t++) fullHistory[histLen + t] = path.rateAt(t) * 100;
    const offset = histLen;

    const out: Array<{
      monthOffset: number;
      balIns: number;
      balUnins: number;
      principalPaid: number;
      interestPaid: number;
      couponRate: number;
    }> = [];

    let balIns = Math.min(Math.max(0, D), notional);
    let balUnins = notional - balIns;
    let cumIncentive = 0;
    const tau = Math.max(nmdParams.closureTauMonths, 1e-6);

    for (let m = 1; m <= maturityMonths; m++) {
      const idx = offset + m - 1;
      const currentRatePct = fullHistory[idx];

      // r − MA(r) spread: rate-surprise driver, same as original non-IB form.
      let maSum = 0;
      for (let j = 1; j <= nmdParams.maPeriod; j++) maSum += fullHistory[idx - j];
      const spread = currentRatePct - maSum / nmdParams.maPeriod;

      const expTerm = Math.exp(-nmdParams.logisticK * (spread - nmdParams.logisticMidpoint));
      const baseIncentive =
        nmdParams.maxRateGrowth +
        (nmdParams.maxRateDecay - nmdParams.maxRateGrowth) / (1 + expTerm);

      const burnoutB = Math.exp(-nmdParams.burnoutLambda * cumIncentive);
      const closureT =
        nmdParams.closureSteady +
        (nmdParams.closureInitial - nmdParams.closureSteady) * Math.exp(-(m - 1) / tau);

      // Salience = rate LEVEL / ref, not the spread (cash-sorting magnitude).
      const salience = Math.max(0, currentRatePct) / salienceRef;
      const rateIncentiveDecay = Math.max(0, baseIncentive * burnoutB * salience);

      const closureFactor = 1 - closureT / 100;
      const decayInsDecimal = closureT / 100;
      const decayUninsDecimal = 1 - closureFactor * (1 - rateIncentiveDecay / 100);

      const bal = balIns + balUnins;
      const decayIns = Math.max(0, balIns * decayInsDecimal);
      const decayUnins = Math.max(0, balUnins * decayUninsDecimal);
      const principalPaid = m === maturityMonths ? bal : Math.min(bal, decayIns + decayUnins);
      const interest = bal * monthlyDepositRate;

      out.push({
        monthOffset: m,
        balIns,
        balUnins,
        principalPaid,
        interestPaid: interest,
        couponRate: depositRate,
      });

      if (baseIncentive > 0) cumIncentive += baseIncentive;
      if (m === maturityMonths) {
        balIns = 0;
        balUnins = 0;
      } else {
        balIns = Math.max(0, balIns - decayIns);
        balUnins = Math.max(0, balUnins - decayUnins);
      }
      if (balIns + balUnins < 1e-6 && m < maturityMonths) break;
    }

    return out;
  }

  generateCashflows(path: RatePath): Cashflow[] {
    return this.simulateTranches(path).map((s) => ({
      monthOffset: s.monthOffset,
      balance: s.balIns + s.balUnins,
      principalPaid: s.principalPaid,
      interestPaid: s.interestPaid,
      couponRate: s.couponRate,
    }));
  }
}

export function isNMDTerms(t: InstrumentTermsBase): t is NMDTerms {
  return t.type === "nmd";
}
