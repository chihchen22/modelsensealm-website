/**
 * Interest-Bearing NMD-B with β-driven repricing — Phase 7.
 *
 * Layered on top of the four-factor decay model used by Non-IB NMD: the
 * deposit rate D(t) tracks the market index (1M SOFR by convention) through
 * a logistic S-curve β applied as a level ratio:
 *
 *     β(r) = β_min + (β_max − β_min) / (1 + exp(−k · (r − m)))
 *     D_target(t) = β(r(t)) · r(t)
 *     D(t) = D(t−1) + λ · (D_target(t) − D(t−1))
 *     D(0) = β(r(0)) · r(0)             (always the level target at t=0)
 *
 * with r in % per annum, m the inflection rate level (% per annum), k the
 * logistic steepness, and λ ∈ (0, 1] a Nerlove partial-adjustment factor
 * controlling how quickly D converges to its target each period (default
 * 1.0 = full snap to target; values around 0.47 give smoother trajectories
 * estimated in Chen (2026), "Dynamic Deposit Betas," SSRN Working Paper 6269838).
 *
 * Why level-ratio rather than incremental ΔD = β·Δr: the level form ensures
 * that under a flat market environment D ≈ β · r (the long-run pass-through),
 * not whatever D₀ was originally set to. With β ≈ 0.5 and SOFR ≈ 4%, this
 * gives D ≈ 2% — and therefore the spread r − D feeding the closure model's
 * rate-driven incentive sits near 2%, putting the logistic near its midpoint
 * (the same regime as the Non-IB NMD's r − MA spread of ≈ 0). This keeps the
 * closure-decay magnitudes consistent across the two models without
 * recalibrating the logistic shape.
 *
 * Default S-curve parameters are the in-sample estimates from that paper:
 * β_min = 0.433, β_max = 0.800, k = 0.566, m = 3.919% — derived from
 * Jan 2017 – Mar 2025 high-yield MMDA + Fed Funds data. Asymmetric volatility
 * (λ_up vs λ_down) and the FHLB-spread coefficient γ_fhlb are intentionally
 * omitted in this simpler version per Chih's guidance; if needed they can
 * be added as additional fields without breaking the interface.
 *
 * Decay overlay (prepayment-form, two-tranche): the cohort is split at the
 * FDIC insured threshold D_ref into an insured tranche min(D_ref, notional)
 * and an uninsured tranche (the remainder). Mirroring the mortgage model's
 * CPR = turnover + refi-incentive structure:
 *
 *   - Insured tranche: closure(t) only (turnover analog — relationship
 *     attrition with the same age ramp as Non-IB NMD). Money under the
 *     insurance cap does not rate-shop.
 *   - Uninsured tranche: closure(t) composed with a one-sided refi-style
 *     incentive S(spread) = max_decay / (1 + exp(−K·(spread − midpoint)))
 *     (the generic logistic with max_growth = 0). Hot commercial money
 *     withdraws fast when the market pays more than the deposit; when rates
 *     fall the term collapses toward zero — depositors keep money parked,
 *     they don't add to the cohort.
 *
 * Per Steph's audit memo Sec 9 the incentive spread is r(t) − D(t) (the
 * depositor's actual switching incentive given the current deposit rate)
 * instead of r(t) − MA(r), so no MA history warmup is needed.
 *
 * No burnout by default (burnoutLambda = 0): unlike mortgage refi burnout,
 * rate-sensitive commercial money does not exhaust — it stays responsive to
 * every new spread widening. The incentive additionally carries a
 * cash-sorting salience multiplier r/salienceRefPct so the decay RATE is
 * convex in the rate level: up-rate paths see disproportionate uninsured
 * flight (the 2022-23 dynamic), down-rate paths collapse toward the
 * closure-only floor (2010s parked surge balances). Because the runoff
 * profile is bounded on both sides, this asymmetry does NOT push stochastic
 * WAL below deterministic at a ~3y operating point — see salienceRefPct.
 *
 * Bank's-perspective convention: liability. The repricing-gap split uses
 * β(r(0)) — the initial β at the t=0 market rate — so that the (1 − β) slice
 * is the rate-locked deposit franchise and the β slice reprices in the next
 * monthly bucket. As rates evolve over the projection horizon, the actual β
 * applied to ΔD changes month by month, but the gap's "fixed gap" measure
 * is taken at t=0.
 */

import type {
  Cashflow,
  Instrument,
  InstrumentTermsBase,
  RatePath,
} from "./types";
import { type NMDParams, NMD_DEFAULTS } from "../behavioral/nmdModel";
import { shockCurve, type ZeroCurve } from "../rates/bootstrap";
import type { TLPCurve } from "../rates/tlpCurve";
import { ParallelShockPath, type DurationResult } from "../analytics/duration";

/** Logistic S-curve parameters mapping market rate level (% pa) to β ∈ [β_min, β_max]. */
export interface BetaSCurveParams {
  /** Lower asymptote — rate sensitivity at very low rate levels. */
  betaMin: number;
  /** Upper asymptote — rate sensitivity at very high rate levels. */
  betaMax: number;
  /** Logistic steepness — controls how sharply β transitions across the inflection. */
  k: number;
  /** Inflection rate level, in % per annum. */
  m: number;
  /** Nerlove partial-adjustment factor in (0, 1]. 1.0 = full pass-through;
   *  smaller values smooth the deposit-rate trajectory. */
  lambda: number;
}

export const BETA_S_CURVE_DEFAULTS: BetaSCurveParams = {
  betaMin: 0.433,
  betaMax: 0.800,
  k: 0.566,
  m: 3.919,
  lambda: 1.0,
};

export interface NMDBetaTerms extends InstrumentTermsBase {
  type: "nmd-b";
  /** β S-curve parameters mapping market rate level to rate sensitivity. */
  sCurve: BetaSCurveParams;
  /** Closure-and-incentive parameter set (same shape as Non-IB NMD). */
  nmdParams: NMDParams;
  /**
   * Rate-level salience normalization (% pa, default 4). The uninsured
   * incentive scales by r/salienceRefPct — the cash-sorting effect: a given
   * spread moves money much faster at 6% short rates than at 1%. Without
   * this term the β S-curve's own repricing makes the spread (1−β(r))·r
   * concave in r, muting the up-rate response; the linear-in-r factor
   * restores a convex decay RATE in the rate level (2022-23-style uninsured
   * flight on up-paths, 2010s-style parked surge balances on down-paths).
   * Note this does NOT force stochastic WAL below deterministic: the runoff
   * profile is bounded (insured floor below, closure-only ceiling above),
   * and at a ~3y operating point down-paths have far more room to lengthen
   * than up-paths have to shorten, so persistent level dispersion raises
   * mean WAL slightly. See the duration discussion in the tab helper.
   */
  salienceRefPct?: number;
}

export const NMD_B_TERMS_DEFAULTS: NMDBetaTerms = {
  id: "nmd-b-1",
  type: "nmd-b",
  label: "IB NMD",
  notional: 1_000_000,
  // Match Non-IB NMD and Mortgage horizon so all gap charts share an x-axis.
  maturityMonths: 360,
  originationOffsetMonths: 0,
  amortType: "level-pay",
  side: "liability",
  sCurve: BETA_S_CURVE_DEFAULTS,
  // Prepayment-form recalibration vs Non-IB NMD (see header):
  //   maxRateGrowth = 0    → one-sided refi-style S-curve (no inflow side)
  //   burnoutLambda = 0    → commercial money stays rate-responsive
  //   maxRateDecay        → hot-money plateau, %/mo on the uninsured tranche
  //   logisticMidpoint, logisticK → midpoint above the operating spread
  //     (1−β)·r ≈ 1.45% on the 3/31 curve (convex lower limb)
  //   salienceRefPct = 4  → cash-sorting multiplier r/4 on the incentive
  // Tuned 2026-06-11 so the deterministic-forward WAL on the 3/31 curve
  // lands near 3y (det 3.08y at these values).
  nmdParams: {
    ...NMD_DEFAULTS,
    maxRateDecay: 16,
    maxRateGrowth: 0,
    burnoutLambda: 0,
    logisticMidpoint: 2.0,
    logisticK: 1.5,
  },
  salienceRefPct: 4,
};

/** S-curve β at market rate level r (in % per annum). */
export function betaAtRate(rPct: number, p: BetaSCurveParams): number {
  return p.betaMin + (p.betaMax - p.betaMin) / (1 + Math.exp(-p.k * (rPct - p.m)));
}

export class NMDBeta implements Instrument {
  readonly terms: NMDBetaTerms;

  constructor(terms: NMDBetaTerms) {
    if (terms.notional <= 0) throw new Error("NMDBeta: notional must be positive");
    if (terms.maturityMonths <= 0) throw new Error("NMDBeta: projection horizon must be positive");
    if (terms.sCurve.betaMin < 0 || terms.sCurve.betaMax <= terms.sCurve.betaMin) {
      throw new Error("NMDBeta: require 0 ≤ betaMin < betaMax");
    }
    if (terms.sCurve.lambda <= 0 || terms.sCurve.lambda > 1) {
      throw new Error("NMDBeta: lambda must be in (0, 1]");
    }
    this.terms = terms;
  }

  /** NMD-B reprices the β slice at the next monthly bucket; the (1 − β)
   *  slice is rate-locked. The schedule itself is empty — the gap chart
   *  consumes the (β, balance) split directly via the analytics layer. */
  repricingSchedule(): number[] {
    return [];
  }

  /** Initial β computed from the path's t=0 market rate. Used by the
   *  repricing-gap analytic to size the rate-locked vs β-slice split. */
  initialBeta(path: RatePath): number {
    return betaAtRate(path.rateAt(0) * 100, this.terms.sCurve);
  }

  /** Generate the projected deposit-rate path D(t), in decimal, over the
   *  full projection horizon. D(t) tracks the level target β(r(t))·r(t)
   *  with optional Nerlove partial adjustment toward that target. */
  depositRatePath(path: RatePath): { rPct: number[]; dPct: number[]; betaPct: number[] } {
    const n = this.terms.maturityMonths;
    const rPct = new Array<number>(n);
    const dPct = new Array<number>(n);
    const betaPct = new Array<number>(n);
    const lambda = this.terms.sCurve.lambda;
    let dPrev = 0;
    for (let t = 0; t < n; t++) {
      const rNow = path.rateAt(t) * 100;
      const beta = betaAtRate(rNow, this.terms.sCurve);
      const target = beta * rNow;
      // D(0) snaps to the target. From t=1 onward, partial-adjustment toward
      // the target governed by λ. With λ=1 the deposit rate equals β·r at
      // every step.
      const dNow = t === 0 ? target : Math.max(0, dPrev + lambda * (target - dPrev));
      rPct[t] = rNow;
      dPct[t] = dNow;
      betaPct[t] = beta;
      dPrev = dNow;
    }
    return { rPct, dPct, betaPct };
  }

  /**
   * Two-tranche monthly simulation (see header): insured tranche decays at
   * closure(t) only; uninsured tranche at closure(t) composed with the
   * one-sided incentive S(spread)·B(t). Returns per-month tranche balances
   * (opening) alongside the cashflow legs; generateCashflows and the tab's
   * tranche-share chart both consume this so the loop exists exactly once.
   */
  simulateTranches(path: RatePath): Array<{
    monthOffset: number;
    balIns: number;
    balUnins: number;
    principalPaid: number;
    interestPaid: number;
    couponRate: number;
  }> {
    const { notional, maturityMonths, nmdParams, sCurve } = this.terms;
    const D = nmdParams.balanceDenominator;

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

    // Deposit rate tracks D_target = β(r) · r each period, with optional
    // partial-adjustment smoothing controlled by λ. At t=0 (m=1) we snap to
    // the target so the initial spread r − D = (1 − β) · r is the long-run
    // pass-through gap (same regime as Non-IB NMD's r − MA ≈ 0 spread).
    let depositRatePct = 0;

    for (let m = 1; m <= maturityMonths; m++) {
      const currentMarketPct = path.rateAt(m - 1) * 100;
      const betaT = betaAtRate(currentMarketPct, sCurve);
      const targetPct = betaT * currentMarketPct;
      depositRatePct =
        m === 1
          ? targetPct
          : Math.max(0, depositRatePct + sCurve.lambda * (targetPct - depositRatePct));

      // Per Steph's audit: rate-driven incentive uses (market − D) spread.
      const spread = currentMarketPct - depositRatePct;

      const expTerm = Math.exp(-nmdParams.logisticK * (spread - nmdParams.logisticMidpoint));
      const baseIncentive =
        nmdParams.maxRateGrowth +
        (nmdParams.maxRateDecay - nmdParams.maxRateGrowth) / (1 + expTerm);

      const burnoutB = Math.exp(-nmdParams.burnoutLambda * cumIncentive);
      const closureT =
        nmdParams.closureSteady +
        (nmdParams.closureInitial - nmdParams.closureSteady) * Math.exp(-(m - 1) / tau);

      // Clamp at zero — negative incentive (deep low-spread regimes) means
      // depositors keep money parked; inflows are new-cohort flows, never
      // recovery of this one. Balance stays monotonically non-increasing.
      // The r/salienceRef factor is the cash-sorting multiplier (see terms).
      const salience = Math.max(0, currentMarketPct) / (this.terms.salienceRefPct ?? 4);
      const rateIncentiveDecay = Math.max(0, baseIncentive * burnoutB * salience);
      const closureFactor = 1 - closureT / 100;
      const decayInsDecimal = closureT / 100;
      const decayUninsDecimal = 1 - closureFactor * (1 - rateIncentiveDecay / 100);

      const bal = balIns + balUnins;
      const decayIns = Math.max(0, balIns * decayInsDecimal);
      const decayUnins = Math.max(0, balUnins * decayUninsDecimal);
      const principalPaid =
        m === maturityMonths ? bal : Math.min(bal, decayIns + decayUnins);
      const depositRateDecimal = depositRatePct / 100;
      const interest = (bal * depositRateDecimal) / 12;

      out.push({
        monthOffset: m,
        balIns,
        balUnins,
        principalPaid,
        interestPaid: interest,
        couponRate: depositRateDecimal,
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

export function isNMDBetaTerms(t: InstrumentTermsBase): t is NMDBetaTerms {
  return t.type === "nmd-b";
}

/**
 * Static-runoff effective duration for IB NMD.
 *
 * The generic effectiveDurationOnPaths re-simulates the full cashflow model
 * under ±shock, which lets the behavioral runoff respond to the rate change
 * and flips the PV differential negative for high-β deposits. This function
 * fixes that by separating the two effects:
 *
 *   - Principal / balance runoff: frozen at the BASE path (static).
 *   - Interest repricing: fully re-priced via β(r±Δ)·(r±Δ) on the shocked path.
 *   - Discounting: shifted FHLB curve (SOFR+TLP) under each shock leg.
 *
 * Expected result: D_IB ≈ (1 − β) · D_principal, positive, below Non-IB.
 * Raises toward D_principal as β_max → 0; shrinks toward 0 as β_max → 1.
 */
export function ibStaticRunoffDuration(
  instr: NMDBeta,
  paths: ReadonlyArray<RatePath>,
  curve: ZeroCurve,
  tlp: TLPCurve,
  shockBp = 100,
): DurationResult {
  if (paths.length === 0) {
    return { pvBase: 0, pvUp: 0, pvDown: 0, effectiveDuration: 0, shockBp, spreadBp: 0 };
  }

  // Generate base cashflows once per path — this defines the frozen balance
  // and principal schedule used for all three shock legs.
  const baseCfsByPath = paths.map((p) => instr.generateCashflows(p));

  const dfFor = (bp: number) => {
    const c = bp === 0 ? curve : shockCurve(curve, bp);
    return (t: number): number =>
      t <= 0 ? 1 : c.discountFactor(t) * Math.exp(-tlp.tlp(t) * t);
  };

  const pvFor = (bp: number): number => {
    const df = dfFor(bp);
    let sum = 0;
    for (let pi = 0; pi < paths.length; pi++) {
      const baseCfs = baseCfsByPath[pi];
      const shockedPath = bp === 0 ? paths[pi] : new ParallelShockPath(paths[pi], bp);
      // depositRatePath gives dPct[0..maturityMonths-1] where dPct[m-1] is
      // the deposit rate (% pa) for month m, repriced via β(r±Δ)·(r±Δ).
      const ratePath = instr.depositRatePath(shockedPath);
      for (const c of baseCfs) {
        const t = c.monthOffset / 12;
        const interestRepriced = (c.balance * ratePath.dPct[c.monthOffset - 1]) / 100 / 12;
        sum += df(t) * (c.principalPaid + interestRepriced);
      }
    }
    return sum / paths.length;
  };

  const pvBase = pvFor(0);
  const pvUp = pvFor(+shockBp);
  const pvDown = pvFor(-shockBp);
  const dr = shockBp / 1e4;
  const effectiveDuration = pvBase > 0 ? (pvDown - pvUp) / (2 * pvBase * dr) : 0;
  return { pvBase, pvUp, pvDown, effectiveDuration, shockBp, spreadBp: 0 };
}

/**
 * Monte Carlo NMD-B runner. Mirrors the shape of `runNMDOnPaths` so the
 * NmdBTab can render the same balance-fan / decay-fan / WAL output cards.
 * The deposit-rate path is computed per-path from the supplied 1M SOFR
 * realisations through the β S-curve, then the closure overlay runs against
 * spread = r − D (per audit memo Sec 9). No historical SOFR warmup is needed
 * because the spread doesn't reference an MA window.
 */
export interface NMDBetaScenarioOutput {
  decayMean: Float64Array;
  decayP5: Float64Array;
  decayP95: Float64Array;
  balMean: Float64Array;
  balP5: Float64Array;
  balP95: Float64Array;
  /** Mean deposit rate (% per annum) at each step across paths. */
  depositRateMean: Float64Array;
  depositRateP5: Float64Array;
  depositRateP95: Float64Array;
  /** Path-average WAL in years (with horizon-tail piece). */
  wal: number;
  /** Path-average life decay (% per month, balance-weighted). */
  lifeDecay: number;
}

function percentile(arr: ArrayLike<number>, q: number): number {
  const sorted = Array.from(arr).sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

export function runNMDBetaOnPaths(
  paths: ArrayLike<Float64Array>,
  terms: NMDBetaTerms,
): NMDBetaScenarioOutput {
  const nPaths = paths.length;
  if (nPaths === 0) throw new Error("runNMDBetaOnPaths: paths must be non-empty");
  const nSteps = paths[0].length;
  const { notional, nmdParams, sCurve } = terms;
  const D = nmdParams.balanceDenominator;
  const tau = Math.max(nmdParams.closureTauMonths, 1e-6);

  const allDecay: Float64Array[] = new Array(nSteps);
  const allBal: Float64Array[] = new Array(nSteps);
  const allDeposit: Float64Array[] = new Array(nSteps);
  for (let t = 0; t < nSteps; t++) {
    allDecay[t] = new Float64Array(nPaths);
    allBal[t] = new Float64Array(nPaths);
    allDeposit[t] = new Float64Array(nPaths);
  }

  let sumWal = 0;
  let sumLifeDecay = 0;

  for (let p = 0; p < nPaths; p++) {
    const path = paths[p];
    let balIns = Math.min(Math.max(0, D), notional);
    let balUnins = notional - balIns;
    let cumIncentive = 0;
    let depositRatePct = 0;
    let walSum = 0;
    let balSum = 0;
    let decayWeightSum = 0;

    for (let t = 1; t <= nSteps; t++) {
      const currentMarketPct = path[t - 1] * 100;
      const betaT = betaAtRate(currentMarketPct, sCurve);
      const targetPct = betaT * currentMarketPct;
      depositRatePct =
        t === 1
          ? targetPct
          : Math.max(0, depositRatePct + sCurve.lambda * (targetPct - depositRatePct));

      const spread = currentMarketPct - depositRatePct;
      const expTerm = Math.exp(-nmdParams.logisticK * (spread - nmdParams.logisticMidpoint));
      const baseIncentive =
        nmdParams.maxRateGrowth +
        (nmdParams.maxRateDecay - nmdParams.maxRateGrowth) / (1 + expTerm);

      const burnoutB = Math.exp(-nmdParams.burnoutLambda * cumIncentive);
      const closureT =
        nmdParams.closureSteady +
        (nmdParams.closureInitial - nmdParams.closureSteady) * Math.exp(-(t - 1) / tau);

      // Two-tranche split (matches simulateTranches): insured decays at
      // closure only; uninsured at closure composed with the clamped
      // one-sided incentive scaled by the cash-sorting salience r/ref.
      const salience = Math.max(0, currentMarketPct) / (terms.salienceRefPct ?? 4);
      const rateIncentiveDecay = Math.max(0, baseIncentive * burnoutB * salience);
      const closureFactor = 1 - closureT / 100;
      const bal = balIns + balUnins;
      const decayIns = Math.max(0, balIns * (closureT / 100));
      const decayUnins = Math.max(
        0,
        balUnins * (1 - closureFactor * (1 - rateIncentiveDecay / 100)),
      );
      const decayAmount = decayIns + decayUnins;
      const newBalIns = Math.max(0, balIns - decayIns);
      const newBalUnins = Math.max(0, balUnins - decayUnins);
      const newBal = newBalIns + newBalUnins;
      const actualDecay = bal > 0 ? ((bal - newBal) / bal) * 100 : 0;

      // Display in normalised (start = 100) units to match NmdTab convention.
      const balDisplay = (bal / notional) * 100;
      const newBalDisplay = (newBal / notional) * 100;

      allDecay[t - 1][p] = actualDecay;
      allBal[t - 1][p] = newBalDisplay;
      allDeposit[t - 1][p] = depositRatePct;

      balSum += balDisplay;
      decayWeightSum += actualDecay * balDisplay;
      if (decayAmount > 0) walSum += (decayAmount / notional) * (t / 12);

      if (baseIncentive > 0) cumIncentive += baseIncentive;
      balIns = newBalIns;
      balUnins = newBalUnins;
    }

    walSum += ((balIns + balUnins) / notional) * (nSteps / 12);
    sumWal += walSum;
    sumLifeDecay += balSum > 0 ? decayWeightSum / balSum : 0;
  }

  const decayMean = new Float64Array(nSteps);
  const decayP5 = new Float64Array(nSteps);
  const decayP95 = new Float64Array(nSteps);
  const balMean = new Float64Array(nSteps);
  const balP5 = new Float64Array(nSteps);
  const balP95 = new Float64Array(nSteps);
  const depositRateMean = new Float64Array(nSteps);
  const depositRateP5 = new Float64Array(nSteps);
  const depositRateP95 = new Float64Array(nSteps);

  for (let t = 0; t < nSteps; t++) {
    if (nPaths === 1) {
      decayMean[t] = allDecay[t][0];
      decayP5[t] = allDecay[t][0];
      decayP95[t] = allDecay[t][0];
      balMean[t] = allBal[t][0];
      balP5[t] = allBal[t][0];
      balP95[t] = allBal[t][0];
      depositRateMean[t] = allDeposit[t][0];
      depositRateP5[t] = allDeposit[t][0];
      depositRateP95[t] = allDeposit[t][0];
    } else {
      const sortedDecay = Array.from(allDecay[t]).sort((a, b) => a - b);
      const sortedBal = Array.from(allBal[t]).sort((a, b) => a - b);
      const sortedDep = Array.from(allDeposit[t]).sort((a, b) => a - b);
      decayMean[t] = sortedDecay.reduce((s, v) => s + v, 0) / nPaths;
      decayP5[t] = percentile(sortedDecay, 0.05);
      decayP95[t] = percentile(sortedDecay, 0.95);
      balMean[t] = sortedBal.reduce((s, v) => s + v, 0) / nPaths;
      balP5[t] = percentile(sortedBal, 0.05);
      balP95[t] = percentile(sortedBal, 0.95);
      depositRateMean[t] = sortedDep.reduce((s, v) => s + v, 0) / nPaths;
      depositRateP5[t] = percentile(sortedDep, 0.05);
      depositRateP95[t] = percentile(sortedDep, 0.95);
    }
  }

  return {
    decayMean,
    decayP5,
    decayP95,
    balMean,
    balP5,
    balP95,
    depositRateMean,
    depositRateP5,
    depositRateP95,
    wal: sumWal / nPaths,
    lifeDecay: sumLifeDecay / nPaths,
  };
}
