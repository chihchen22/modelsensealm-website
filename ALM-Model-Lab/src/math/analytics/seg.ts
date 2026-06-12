/**
 * Sensitivity Equivalent Gap (SEG) and Equivalent Balance Profile (EBP).
 *
 * Per Chapters 2–3 of Chih's ALM Modeling Book and the SEG_Fixed_Linear1Y /
 * SEG_Floating_Linear1Y reference workbooks: SEG measures the rate-locked
 * outstanding balance via the NII sensitivity of a static-balance-sheet
 * portfolio under a parallel ±10 bp shock applied **starting at t=1** (the
 * first month uses the pre-shock rate; the shock kicks in between month 1
 * and month 2).
 *
 *   NII(month m, scenario) = total interest from existing book + all live
 *                            new-business vintages on the static balance
 *                            sheet. Asset side: interest received. Liability
 *                            side: interest paid.
 *
 *   Cumulative SEG(t) = (NII_up(month t+1) − NII_down(month t+1)) × 12 / Δr
 *                     = portion of the original notional that has *repriced*
 *                       through replacement vintages or coupon resets by t.
 *
 *   Outstanding SEG(t) = side_sign × (notional − Cumulative SEG(t))
 *     - t = 0: hardcoded to side_sign × notional (full balance is rate-locked
 *       at the very start, before any rate evolution).
 *     - t ≥ 1: derived from cumulative repriced through month t+1.
 *
 *   Periodic SEG(t) = Outstanding SEG(t−1) − Outstanding SEG(t), the dollar
 *                    amount that repriced during period t. Periodic(0) = 0.
 *
 * Sign convention:
 *   side_sign = +1 for assets (rate-locked asset has positive SEG)
 *   side_sign = −1 for liabilities (rate-locked liability has negative SEG)
 *
 * Vanilla cases (no behavioral optionality) reproduce the Repricing Gap line
 * exactly — Outstanding SEG(t) tracks the existing-book balance amortisation.
 * Convex cases (mortgage prepay, IB NMD β-curve) bake the linear-swap-
 * equivalent of the option into SEG; the ±10 bp clamp keeps the linearisation
 * accurate.
 *
 * Static balance sheet: each month's runoff is replaced by a fresh vintage
 * with the same term structure but a new-volume coupon at the current
 * shocked-rate environment (forward at matching tenor + carrying spread for
 * fixed/mortgage; SOFR + margin for floating; 0% for Non-IB NMD; β·r for
 * IB NMD). Total balance stays at notional throughout.
 *
 * MC simplification: existing book runs on each MC path with shock applied;
 * vintages run on the (shocked) deterministic path. Decouples vintage tracking
 * from MC paths and keeps runtime tractable while preserving the dominant
 * rate-sensitivity effect for the existing book.
 */

import type { Cashflow, Instrument, RatePath } from "../instruments/types";
import { FixedLoan, isFixedLoanTerms } from "../instruments/fixedLoan";
import { FloatingLoan, isFloatingLoanTerms } from "../instruments/floatingLoan";
import { Mortgage, isMortgageTerms } from "../instruments/mortgage";
import { NMDeposit, isNMDTerms } from "../instruments/nmd";
import { NMDBeta, isNMDBetaTerms } from "../instruments/nmdBeta";
import { StochasticRatePath, type HWForwardBundle } from "../rates/ratePath";

const SHOCK_BP = 10;
const DELTA_R = (2 * SHOCK_BP) / 1e4; // 0.0020 (20 bp)
const DT_YEARS = 1 / 12;

/** Wraps a base RatePath with a parallel shock applied at step ≥ 1. Step 0
 *  returns the unshocked rate so the first month's coupon (already locked
 *  before the shock event) is preserved across base / up / down scenarios. */
export class ShockedPath implements RatePath {
  readonly nSteps: number;
  readonly times: ReadonlyArray<number>;
  private readonly shockDecimal: number;

  constructor(private readonly base: RatePath, shockBp: number) {
    this.nSteps = base.nSteps;
    this.times = base.times;
    this.shockDecimal = shockBp / 1e4;
  }

  rateAt(step: number): number {
    if (step <= 0) return this.base.rateAt(step);
    return this.base.rateAt(step) + this.shockDecimal;
  }

  forwardRateAt(step: number, tenorYears: number): number {
    if (step <= 0) return this.base.forwardRateAt(step, tenorYears);
    return this.base.forwardRateAt(step, tenorYears) + this.shockDecimal;
  }
}

export class ShiftedPath implements RatePath {
  readonly nSteps: number;
  readonly times: ReadonlyArray<number>;

  constructor(private readonly base: RatePath, private readonly offset: number) {
    this.nSteps = Math.max(0, base.nSteps - offset);
    this.times = [];
  }

  rateAt(step: number): number {
    return this.base.rateAt(step + this.offset);
  }

  forwardRateAt(step: number, tenorYears: number): number {
    return this.base.forwardRateAt(step + this.offset, tenorYears);
  }
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

interface ExtractedCashflows {
  balance: Float64Array;
  interest: Float64Array;
  principal: Float64Array;
  coupon: Float64Array;
}

function generateAndExtract(
  instrument: Instrument,
  path: RatePath,
  horizon: number,
): ExtractedCashflows {
  const cf = instrument.generateCashflows(path);
  const balance = new Float64Array(horizon);
  const interest = new Float64Array(horizon);
  const principal = new Float64Array(horizon);
  const coupon = new Float64Array(horizon);
  const n = Math.min(cf.length, horizon);
  for (let i = 0; i < n; i++) {
    balance[i] = cf[i].balance;
    interest[i] = cf[i].interestPaid;
    principal[i] = cf[i].principalPaid;
    coupon[i] = cf[i].couponRate;
  }
  return { balance, interest, principal, coupon };
}

/** Build a fresh-vintage instrument originating at wall-clock month
 *  `originationMonth` with notional `notional`, parameterised against the
 *  supplied shocked-deterministic path. The carrying-spread reference uses
 *  the *unshocked* base path so the shock fully propagates through the new-
 *  vintage coupon rather than being absorbed into a re-anchored spread. */
export function makeVintage(
  parent: Instrument,
  originationMonth: number,
  notional: number,
  shockedDetPath: RatePath,
  basePath: RatePath,
  horizon: number,
): { instrument: Instrument; path: RatePath } | null {
  const t = parent.terms;
  const remaining = horizon - originationMonth;
  if (remaining <= 0 || notional <= 1e-9) return null;

  const path = new ShiftedPath(shockedDetPath, originationMonth);

  if (isFixedLoanTerms(t)) {
    const matMonths = Math.min(t.maturityMonths, remaining);
    const tenorYears = Math.max(t.maturityMonths / 12, 1 / 12);
    const fwdNow = shockedDetPath.forwardRateAt(originationMonth, tenorYears);
    const fwdZeroBase = basePath.forwardRateAt(0, tenorYears);
    const carrying = t.coupon - fwdZeroBase;
    return {
      instrument: new FixedLoan({
        ...t,
        notional,
        maturityMonths: matMonths,
        coupon: fwdNow + carrying,
      }),
      path,
    };
  }

  if (isFloatingLoanTerms(t)) {
    const matMonths = Math.min(t.maturityMonths, remaining);
    return {
      instrument: new FloatingLoan({
        ...t,
        notional,
        maturityMonths: matMonths,
      }),
      path,
    };
  }

  if (isMortgageTerms(t)) {
    const matMonths = Math.min(t.maturityMonths, remaining);
    const totalSpread = (t.cprParams.secSpread + t.cprParams.primSpread) / 1e4;
    // HW paths can drift sufficiently negative that fwd + spread < 0; the
    // Mortgage constructor rejects that (lenders won't originate at a
    // negative rate either), so clamp at 0 to keep vintage construction
    // valid under deep-negative MC paths.
    const newNoteRate = Math.max(
      0,
      shockedDetPath.forwardRateAt(originationMonth, 10) + totalSpread,
    );
    return {
      instrument: new Mortgage({
        ...t,
        notional,
        originalBalance: notional,
        maturityMonths: matMonths,
        noteRate: newNoteRate,
        ageMonths: 0,
      }),
      path,
    };
  }

  if (isNMDTerms(t)) {
    const matMonths = Math.min(t.maturityMonths, remaining);
    return {
      instrument: new NMDeposit({ ...t, notional, maturityMonths: matMonths }),
      path,
    };
  }

  if (isNMDBetaTerms(t)) {
    const matMonths = Math.min(t.maturityMonths, remaining);
    return {
      instrument: new NMDBeta({ ...t, notional, maturityMonths: matMonths }),
      path,
    };
  }

  return null;
}

export interface VintageRecord {
  /** 1-based wall-clock month at which the vintage originated. NB_1 = 1, NB_2 = 2, … */
  startMonth: number;
  cashflows: Cashflow[];
}

export interface PortfolioTrajectory {
  /** Per-month total interest income (existing + all live vintages). */
  totalInterest: Float64Array;
  /** Per-month total balance — should equal notional under static balance sheet. */
  totalBalance: Float64Array;
  /** Existing-book trajectory under this scenario. */
  existing: ExtractedCashflows;
  /** New-business vintages, in origination order. */
  vintages: VintageRecord[];
}

/** Run existing book under `existingPath` and accumulate vintages (replacing
 *  monthly runoff) on `shockedDetPath`. Returns per-month totals plus the
 *  full per-vintage cashflow streams for downstream Excel export. */
export function runStaticBalanceScenario(
  instrument: Instrument,
  existingPath: RatePath,
  shockedDetPath: RatePath,
  basePath: RatePath,
  horizon: number,
): PortfolioTrajectory {
  const existing = generateAndExtract(instrument, existingPath, horizon);

  const totalInterest = new Float64Array(horizon);
  const totalBalance = new Float64Array(horizon);
  const vintages: VintageRecord[] = [];

  for (let m = 1; m <= horizon; m++) {
    let bal = existing.balance[m - 1];
    let interest = existing.interest[m - 1];
    let runoff = existing.principal[m - 1];

    for (const v of vintages) {
      const localM = m - v.startMonth;
      if (localM >= 1 && localM <= v.cashflows.length) {
        const c = v.cashflows[localM - 1];
        bal += c.balance;
        interest += c.interestPaid;
        runoff += c.principalPaid;
      }
    }

    totalBalance[m - 1] = bal;
    totalInterest[m - 1] = interest;

    if (runoff > 1e-6 && m < horizon) {
      const built = makeVintage(instrument, m, runoff, shockedDetPath, basePath, horizon);
      if (built !== null) {
        const cashflows = built.instrument.generateCashflows(built.path);
        vintages.push({ startMonth: m, cashflows });
      }
    }
  }

  return { totalInterest, totalBalance, existing, vintages };
}

export interface SegOutput {
  /** Existing-book balance under unshocked deterministic path. */
  ebpDeterministic: Float64Array;
  /** Mean of existing-book balance across MC paths (no shock). */
  ebpMcMean: Float64Array;
  ebpMcP5: Float64Array;
  ebpMcP95: Float64Array;
  /** Cumulative SEG (amount repriced through time t) under deterministic. */
  cumulativeSegDeterministic: Float64Array;
  /** Cumulative SEG mean across MC paths. */
  cumulativeSegMean: Float64Array;
  /** Outstanding SEG = side_sign × (notional − cumulative). Asset positive,
   *  liability negative. Indexed t = 0..H−1. */
  outstandingSegDeterministic: Float64Array;
  outstandingSegMean: Float64Array;
  outstandingSegP5: Float64Array;
  outstandingSegP95: Float64Array;
  /** Periodic SEG = ΔOutstanding (period-over-period repricing). */
  periodicSegDeterministic: Float64Array;
  periodicSegMean: Float64Array;
  /** Initial outstanding balance signed by side. */
  signedInitialBalance: number;
  /** Initial β for IB NMD; undefined for other instrument types. */
  initialBeta?: number;
}

export interface SegOptions {
  horizon: number;
}

/** Compute SEG / EBP series for an instrument across a set of MC paths. */
export function runSegOnInstrument(
  instrument: Instrument,
  mcPaths: ReadonlyArray<Float64Array>,
  deterministicPath: RatePath,
  opts: SegOptions,
  hwForward?: HWForwardBundle,
): SegOutput {
  const { horizon } = opts;
  if (horizon <= 0) throw new Error("runSegOnInstrument: horizon must be positive");

  const sideSign = instrument.terms.side === "liability" ? -1 : +1;
  const notional = instrument.terms.notional;

  // EBP: existing book on the unshocked deterministic forward.
  const ebpDet = generateAndExtract(instrument, deterministicPath, horizon).balance;

  // Deterministic SEG via shocked-deterministic scenarios.
  const detUp = new ShockedPath(deterministicPath, +SHOCK_BP);
  const detDown = new ShockedPath(deterministicPath, -SHOCK_BP);
  const detUpRun = runStaticBalanceScenario(instrument, detUp, detUp, deterministicPath, horizon);
  const detDownRun = runStaticBalanceScenario(instrument, detDown, detDown, deterministicPath, horizon);

  const cumSegDet = new Float64Array(horizon);
  for (let t = 0; t < horizon; t++) {
    // Cumulative SEG at time t derived from NII over month m = t + 1.
    cumSegDet[t] = ((detUpRun.totalInterest[t] - detDownRun.totalInterest[t]) * 12) / DELTA_R;
  }
  const outDet = buildOutstandingFromCumulative(cumSegDet, sideSign, notional);
  const perDet = buildPeriodicFromOutstanding(outDet);

  // MC SEG: per path, run the full static-balance-sheet portfolio (existing
  // book + replacement vintages) on the shocked MC path. Vintages now follow
  // the same path as the existing book — the deterministic-vintage
  // simplification was retired so each MC path produces a genuinely path-
  // dependent NB-total stream visible in the Excel export.
  const nPaths = mcPaths.length;
  const outByPath: Float64Array[] = new Array(nPaths);
  const cumByPath: Float64Array[] = new Array(nPaths);
  const balByPath: Float64Array[] = new Array(nPaths);

  for (let p = 0; p < nPaths; p++) {
    const arr = mcPaths[p];
    const hw = hwForward
      ? { xPath: hwForward.xPaths[p], a: hwForward.a, sigma: hwForward.sigma, curve: hwForward.curve }
      : undefined;
    const mcPath = new StochasticRatePath(Array.from(arr), DT_YEARS, hw);
    const mcUp = new ShockedPath(mcPath, +SHOCK_BP);
    const mcDown = new ShockedPath(mcPath, -SHOCK_BP);

    const upTraj = runStaticBalanceScenario(instrument, mcUp, mcUp, deterministicPath, horizon);
    const downTraj = runStaticBalanceScenario(instrument, mcDown, mcDown, deterministicPath, horizon);
    const eBase = generateAndExtract(instrument, mcPath, horizon);

    const cum = new Float64Array(horizon);
    for (let t = 0; t < horizon; t++) {
      cum[t] = ((upTraj.totalInterest[t] - downTraj.totalInterest[t]) * 12) / DELTA_R;
    }
    const out = buildOutstandingFromCumulative(cum, sideSign, notional);

    cumByPath[p] = cum;
    outByPath[p] = out;
    balByPath[p] = eBase.balance;
  }

  const outMean = new Float64Array(horizon);
  const outP5 = new Float64Array(horizon);
  const outP95 = new Float64Array(horizon);
  const cumMean = new Float64Array(horizon);
  const ebpMcMean = new Float64Array(horizon);
  const ebpMcP5 = new Float64Array(horizon);
  const ebpMcP95 = new Float64Array(horizon);

  if (nPaths === 0) {
    for (let t = 0; t < horizon; t++) {
      outMean[t] = outDet[t];
      outP5[t] = outDet[t];
      outP95[t] = outDet[t];
      cumMean[t] = cumSegDet[t];
      ebpMcMean[t] = ebpDet[t];
      ebpMcP5[t] = ebpDet[t];
      ebpMcP95[t] = ebpDet[t];
    }
  } else {
    const outCol = new Float64Array(nPaths);
    const cumCol = new Float64Array(nPaths);
    const balCol = new Float64Array(nPaths);
    for (let t = 0; t < horizon; t++) {
      let oSum = 0;
      let cSum = 0;
      let bSum = 0;
      for (let p = 0; p < nPaths; p++) {
        outCol[p] = outByPath[p][t];
        cumCol[p] = cumByPath[p][t];
        balCol[p] = balByPath[p][t];
        oSum += outCol[p];
        cSum += cumCol[p];
        bSum += balCol[p];
      }
      outMean[t] = oSum / nPaths;
      cumMean[t] = cSum / nPaths;
      ebpMcMean[t] = bSum / nPaths;
      outP5[t] = percentile(outCol, 0.05);
      outP95[t] = percentile(outCol, 0.95);
      ebpMcP5[t] = percentile(balCol, 0.05);
      ebpMcP95[t] = percentile(balCol, 0.95);
    }
  }

  const perMean = buildPeriodicFromOutstanding(outMean);

  let initialBeta: number | undefined;
  if (isNMDBetaTerms(instrument.terms) && instrument instanceof NMDBeta) {
    initialBeta = instrument.initialBeta(deterministicPath);
  }

  return {
    ebpDeterministic: ebpDet,
    ebpMcMean,
    ebpMcP5,
    ebpMcP95,
    cumulativeSegDeterministic: cumSegDet,
    cumulativeSegMean: cumMean,
    outstandingSegDeterministic: outDet,
    outstandingSegMean: outMean,
    outstandingSegP5: outP5,
    outstandingSegP95: outP95,
    periodicSegDeterministic: perDet,
    periodicSegMean: perMean,
    signedInitialBalance: sideSign * notional,
    initialBeta,
  };
}

function buildOutstandingFromCumulative(
  cumulative: Float64Array,
  sideSign: number,
  notional: number,
): Float64Array {
  const out = new Float64Array(cumulative.length);
  // t=0: full notional rate-locked at the start, before any rate evolution.
  out[0] = sideSign * notional;
  for (let t = 1; t < cumulative.length; t++) {
    out[t] = sideSign * (notional - cumulative[t]);
  }
  return out;
}

function buildPeriodicFromOutstanding(outstanding: Float64Array): Float64Array {
  const out = new Float64Array(outstanding.length);
  for (let t = 1; t < outstanding.length; t++) {
    out[t] = outstanding[t - 1] - outstanding[t];
  }
  return out;
}

