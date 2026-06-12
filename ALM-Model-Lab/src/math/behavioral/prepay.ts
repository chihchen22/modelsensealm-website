/**
 * Prepayment injection seam (the `PrepayModel` of alm-engine/references/contract.md).
 *
 * One canonical home for the prepayment CPR logic that was previously copied in
 * three places: the per-step four-factor logistic inside `Mortgage.generateCashflows`
 * (mortgage.ts), the same logistic inside the Monte-Carlo fan `runMBSOnPaths`
 * (mbsModel.ts), and the Richard & Roll (1989) arctan form inside the Ch4
 * research script (research/ch04_ftp_stochastic.ts).
 *
 * The seam exploits one structural fact shared by all three: CPR is
 * BALANCE-INDEPENDENT. Per-month CPR depends only on the month, the loan age,
 * the benchmark mortgage rate, and the cumulative in-the-money exposure that
 * drives burnout. It never reads the outstanding balance. Therefore "compute the
 * full CPR schedule in one forward pass, then amortize" is mathematically
 * identical to the original interleaved loops, and the arithmetic here is lifted
 * operation-for-operation so the results reproduce bit-for-bit.
 *
 * Primary interface: `cprSchedule(ctx)` returns the whole annual-CPR vector
 * (natural for the cumulative-ITM accumulation). `cpr(month, ctx)` is the thin
 * per-month wrapper matching the contract's `PrepayModel.cpr` signature; balance
 * is intentionally absent because CPR does not depend on it.
 *
 * Conventions match alm-conventions: rates decimal, 1-based month offsets,
 * annual CPR in [0, 1] decimal, positive principal magnitudes.
 */

import type { MBSParams } from "./mbsModel";

/** Everything a prepayment model needs that is not the model's own parameters. */
export interface PrepayContext {
  /** Number of monthly steps to produce (the amortization horizon). */
  term: number;
  /** Months already seasoned at month-zero; seasoning/seasonality use age + m. */
  age: number;
  /** Note rate / pool WAC in decimal (used by arctan refi and ITM; the logistic
   *  model reads its own `wac` field from MBSParams instead). */
  noteRate: number;
  /** Decimal market mortgage rate at month m (benchmark forward + spread). */
  mortgageRateAt: (month: number) => number;
}

/** The injection seam. A user supplies their own prepayment curve by implementing this. */
export interface PrepayModel {
  /** Annual CPR (decimal, [0, 1]) for every month 1..ctx.term, single forward pass. */
  cprSchedule(ctx: PrepayContext): Float64Array;
  /** Per-month annual CPR (decimal). Contract-shaped convenience; CPR is
   *  balance-independent, so no balance argument. Rebuilds the schedule per call;
   *  for month-by-month iteration consume `cprSchedule` directly. */
  cpr(month: number, ctx: PrepayContext): number;
}

/**
 * Four-factor logistic CPR: refi-incentive S-curve times seasoning ramp times
 * seasonality times burnout. Lifted verbatim (same operation order) from the
 * shared loop of mortgage.ts and mbsModel.ts.
 */
export class FourFactorCPR implements PrepayModel {
  constructor(private readonly params: MBSParams) {}

  cprSchedule(ctx: PrepayContext): Float64Array {
    const p = this.params;
    const inflectionPct = p.inflection / 100;
    const burnoutRate = p.burnoutDecay / 100;
    const seasonalityAmp = p.seasonalityAmp / 100;

    const out = new Float64Array(ctx.term);
    let cumItm = 0;
    for (let m = 1; m <= ctx.term; m++) {
      const mortgageRate = ctx.mortgageRateAt(m);
      const rateDiffPct = p.wac - mortgageRate * 100;
      const currentItm = Math.max(0, rateDiffPct);
      cumItm += currentItm;

      const burnoutFactor = Math.exp(-burnoutRate * cumItm);
      const riBase =
        (p.maxCpr - p.minCpr) /
        (1 + Math.exp(-p.steepness * (rateDiffPct - inflectionPct)));
      const ri = (p.minCpr + riBase) / 100;

      const loanAge = ctx.age + m;
      const seasoningFactor = Math.min(1, loanAge / p.seasoningRamp);
      const monthIndex = ((loanAge - 1) % 12) + 1;
      const seasonalityFactor = 1 + seasonalityAmp * Math.sin((Math.PI * (monthIndex - 4)) / 6);

      const cprDecimal = ri * seasoningFactor * seasonalityFactor * burnoutFactor;
      out[m - 1] = Math.min(1, Math.max(0, cprDecimal));
    }
    return out;
  }

  cpr(month: number, ctx: PrepayContext): number {
    return this.cprSchedule(ctx)[month - 1];
  }
}

/** Parameters for the Richard & Roll arctan refi model. */
export interface RichardRollParams {
  /** Months to full seasoning. */
  seasoningRamp: number;
  /** Seasonality peak/trough amplitude (decimal, e.g. 0.20). */
  seasonalityAmp: number;
  /** Burnout exponential decay per cumulative ITM percentage-point. */
  burnoutRate: number;
  /** Multiplicative speed multiple on CPR (pool calibration; 1 = R&R-native). */
  kappa: number;
}

/**
 * Richard & Roll (1989) refinancing incentive, the rate-DIFFERENCE arctan form,
 * annual CPR (decimal). WAC and mortgageRate in decimal.
 * (Richard, S.F. & Roll, R. (1989), "Prepayments on Fixed-Rate Mortgage-Backed
 * Securities," J. Portfolio Management.)
 */
export function richardRollRefi(wac: number, mortgageRate: number): number {
  return 0.28 + 0.14 * Math.atan(-8.571 + 430 * (wac - mortgageRate));
}

/**
 * Richard & Roll arctan refi times the same seasoning / seasonality / burnout
 * overlays, scaled by a pool speed multiple kappa. Lifted operation-for-operation
 * from the Ch4 research script's `mortgageCF`.
 */
export class RichardRollCPR implements PrepayModel {
  constructor(private readonly p: RichardRollParams) {}

  cprSchedule(ctx: PrepayContext): Float64Array {
    const out = new Float64Array(ctx.term);
    let cumItmPct = 0;
    for (let m = 1; m <= ctx.term; m++) {
      const mortgageRate = ctx.mortgageRateAt(m);
      const itmPct = Math.max(0, (ctx.noteRate - mortgageRate) * 100);
      cumItmPct += itmPct;
      const burnout = Math.exp(-this.p.burnoutRate * cumItmPct);
      const refi = richardRollRefi(ctx.noteRate, mortgageRate);
      const loanAge = ctx.age + m;
      const seasoning = Math.min(1, loanAge / this.p.seasoningRamp);
      const monthIndex = ((loanAge - 1) % 12) + 1;
      const seasonality = 1 + this.p.seasonalityAmp * Math.sin((Math.PI * (monthIndex - 4)) / 6);
      out[m - 1] = Math.min(1, Math.max(0, this.p.kappa * refi * seasoning * seasonality * burnout));
    }
    return out;
  }

  cpr(month: number, ctx: PrepayContext): number {
    return this.cprSchedule(ctx)[month - 1];
  }
}

/** Flat CPR every month. */
export class ConstantCPR implements PrepayModel {
  constructor(private readonly value: number) {}
  cprSchedule(ctx: PrepayContext): Float64Array {
    return new Float64Array(ctx.term).fill(this.value);
  }
  cpr(): number {
    return this.value;
  }
}

/** User-supplied CPR vector; positions past the supplied length read as 0. */
export class VectorCPR implements PrepayModel {
  constructor(private readonly schedule: ArrayLike<number>) {}
  cprSchedule(ctx: PrepayContext): Float64Array {
    const out = new Float64Array(ctx.term);
    for (let i = 0; i < ctx.term; i++) out[i] = this.schedule[i] ?? 0;
    return out;
  }
  cpr(month: number): number {
    return this.schedule[month - 1] ?? 0;
  }
}

/** One amortized cashflow row (the lab `Cashflow` shape). */
export interface AmortRow {
  monthOffset: number;
  balance: number;
  principalPaid: number;
  interestPaid: number;
  couponRate: number;
}

/**
 * Level-pay amortization driver, shared by `Mortgage` and the Ch4 research script.
 * Scheduled principal under remaining-term annuity, prepayment principal from the
 * supplied CPR schedule via SMM, balance rolled forward. Operation order is lifted
 * from the original mortgage.ts loop so cashflows reproduce bit-for-bit.
 *
 * The loop stops once the balance is exhausted; the returned array therefore has
 * length min(term, months-to-exhaustion).
 */
export function amortizeMortgage(args: {
  notional: number;
  noteRate: number;
  term: number;
  cprSchedule: ArrayLike<number>;
}): AmortRow[] {
  const { notional, noteRate, term, cprSchedule } = args;
  const monthlyRate = noteRate / 12;
  const out: AmortRow[] = [];

  let bal = notional;
  for (let m = 1; m <= term; m++) {
    const remMonths = term - m + 1;

    let sp = 0;
    if (bal > 1e-6 && monthlyRate > 1e-12 && remMonths > 0) {
      sp = bal * (monthlyRate / (Math.pow(1 + monthlyRate, remMonths) - 1));
    } else if (bal > 1e-6 && remMonths > 0) {
      sp = bal / remMonths;
    }

    const cpr = cprSchedule[m - 1] ?? 0;
    const smm = 1 - Math.pow(1 - cpr, 1 / 12);
    const pp = Math.max(0, bal - sp) * smm;

    let totalPrincipal = sp + pp;
    if (m === term || totalPrincipal > bal) totalPrincipal = bal;

    const interest = bal * monthlyRate;

    out.push({
      monthOffset: m,
      balance: bal,
      principalPaid: totalPrincipal,
      interestPaid: interest,
      couponRate: noteRate,
    });

    bal -= totalPrincipal;
    if (bal < 0) bal = 0;
    if (bal < 1e-6) break;
  }

  return out;
}
