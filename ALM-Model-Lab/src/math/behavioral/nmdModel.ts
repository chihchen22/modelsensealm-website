/**
 * NMD (non-maturity deposit) decay model — TypeScript port of the
 * prototype's `handleGenerateNmdCashFlows` (Gemini source lines ~1145-1305).
 *
 * Per Steph's audit memo Sec 9, this is *illustrative only*; the canonical
 * Model Sense deposit decay framework lives in Chapter 4+ work and is not
 * implemented here. The math is preserved for engine-demonstration parity
 * with the prototype.
 *
 * Mechanics:
 *   1. Baseline closure: flat `closureRate` % per month.
 *   2. Rate-driven incentive: spread = current 1M rate − MA(past `maPeriod` months).
 *      Pushed through a logistic with (maxDecay, maxGrowth, K, midpoint) parameters.
 *      Multiplied by balMult(t-1) and a Schwartz-Torous burnout B(t).
 *
 * Three sources of path dependency layer onto the rate-incentive term:
 *
 *   a. Dynamic balMult: balMult(t-1) = max(0, 1 + ln(bal_dollars(t-1)/D))
 *      where D is the FDIC-style insured-threshold reference (default $250k).
 *      Internal balance tracks dollars (start = balanceSize); display
 *      normalizes to start = 100. Heavy-decay paths exhaust their own rate
 *      sensitivity, mimicking burnout via stock attrition.
 *
 *   b. Burnout factor: B(t) = exp(−λ_b · C(t)), C(t) = Σ_{s<t} max(0, base_incentive(s)).
 *      Cumulative-positive-incentive history dampens future rate sensitivity.
 *      λ_b=0 disables burnout.
 *
 *   c. Age-ramped closure: closure(t) = closure_steady + (closure_initial − closure_steady)·exp(−t/τ_age).
 *      Front-loaded baseline attrition (account-opening churn, address moves)
 *      relaxes to a steady-state closure rate. Setting closure_initial =
 *      closure_steady disables the ramp.
 *   3. Combined decay: 1 − (1 − closure) × (1 − incentive).
 *
 * Historical SOFR overlay (Jan 2001 – Feb 2026, piecewise-linear FOMC anchors)
 * provides the warmup MA window so the simulation's first months reference
 * actual rate cycles.
 */

export interface NMDParams {
  /** Steady-state closure rate %/mo. Baseline once the age ramp settles. */
  closureSteady: number;
  /** Initial closure rate %/mo at t=0. Equals closureSteady to disable ramp. */
  closureInitial: number;
  /** Time constant (months) for closure age ramp; ramp settles by ~3·τ. */
  closureTauMonths: number;
  /** Burnout exponential rate. λ_b=0 disables burnout. */
  burnoutLambda: number;
  maxRateDecay: number; // % at high spread (high rates -> outflow)
  maxRateGrowth: number; // % at low spread (low rates -> inflow). Negative => inflow.
  logisticK: number;
  logisticMidpoint: number;
  maPeriod: number; // months
  /** Initial cohort balance in dollars. */
  balanceSize: number;
  /** Insured-threshold reference D in dollars (default $250k FDIC). Static. */
  balanceDenominator: number;
}

export const NMD_DEFAULTS: NMDParams = {
  closureSteady: 0.75,
  closureInitial: 2.0,
  closureTauMonths: 24,
  burnoutLambda: 0.1,
  maxRateDecay: 3.0,
  maxRateGrowth: -1.0,
  logisticK: 2.0,
  logisticMidpoint: 0.0,
  maPeriod: 24,
  balanceSize: 1_000_000,
  balanceDenominator: 250_000,
};

/**
 * Historical 1M SOFR (% per annum) by month index from Jan 2001 to Feb 2026.
 * Piecewise-linear interpolation between FOMC-aligned anchor points.
 * Used as the warmup window for the moving-average computation so the
 * simulation's first months reference actual rate cycles.
 */
export function buildHistoricalSOFR1M(): number[] {
  const anchors: Array<{ m: number; r: number }> = [
    { m: 0, r: 6.0 },     // Jan 2001
    { m: 11, r: 1.75 },   // Dec 2001
    { m: 35, r: 1.0 },    // Dec 2003
    { m: 41, r: 1.0 },    // Jun 2004
    { m: 65, r: 5.25 },   // Jun 2006
    { m: 79, r: 5.25 },   // Aug 2007
    { m: 95, r: 0.1 },    // Dec 2008
    { m: 179, r: 0.1 },   // Dec 2015
    { m: 215, r: 2.4 },   // Dec 2018
    { m: 227, r: 1.55 },  // Dec 2019
    { m: 230, r: 0.05 },  // Mar 2020
    { m: 253, r: 0.05 },  // Feb 2022
    { m: 263, r: 4.3 },   // Dec 2022
    { m: 271, r: 5.3 },   // Aug 2023
    { m: 284, r: 5.3 },   // Sep 2024
    { m: 299, r: 3.8 },   // Dec 2025
    { m: 301, r: 3.66 },  // Feb 2026
  ];
  const out: number[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const start = anchors[i];
    const end = anchors[i + 1];
    const steps = end.m - start.m;
    for (let j = 0; j < steps; j++) {
      out.push(start.r + (end.r - start.r) * (j / steps));
    }
  }
  out.push(anchors[anchors.length - 1].r);
  return out;
}

/**
 * Month index of Sep 2025 in the historical series (Jan 2001 = month 0),
 * aligned with the bundled market snapshot's 2025-09-30 calibration date and
 * with `AS_OF_IDX = 296` in `research/rp_tractor_verify.py`.
 */
export const HISTORICAL_ASOF_INDEX_SEP_2025 = 296;

/**
 * Warmup slice of the historical series ending at the calibration date.
 * The simulation's t=0 is Oct 2025, so the MA warmup must stop at Sep 2025;
 * splicing the full series (through Feb 2026) ahead of the path would let
 * the MA window read five post-calibration months as if they were the past.
 */
export function buildWarmupSOFR1M(): number[] {
  return buildHistoricalSOFR1M().slice(0, HISTORICAL_ASOF_INDEX_SEP_2025 + 1);
}

export interface NMDScenarioOutput {
  decayMean: Float64Array; // % per month
  decayP5: Float64Array;
  decayP95: Float64Array;
  balMean: Float64Array; // normalised
  balP5: Float64Array;
  balP95: Float64Array;
  wal: number; // years (path-mean)
  lifeDecay: number; // % (balance-weighted, path-mean)
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

/**
 * Run the NMD decay model on an array of rate paths.
 *
 * Two-tranche prepayment-form: the cohort splits at D = params.balanceDenominator
 * into an insured tranche (closure only) and an uninsured tranche (closure composed
 * with a clamped one-sided incentive scaled by cash-sorting salience). Mirrors
 * NMDeposit.simulateTranches so the MC runner and the instrument cashflows are
 * always in sync.
 *
 * @param paths Array of 1M rate paths in DECIMAL terms.
 * @param params Logistic + MA parameters.
 * @param historicalSOFR1M Historical 1M rates (% per annum) used to warm up
 *   the MA window. Must be at least `maPeriod` long.
 * @param salienceRefPct Rate-level salience normaliser (default 4). Must match
 *   the NMDTerms.salienceRefPct used when constructing NMDeposit instances.
 */
export function runNMDOnPaths(
  paths: ArrayLike<Float64Array>,
  params: NMDParams,
  historicalSOFR1M: ReadonlyArray<number>,
  salienceRefPct = 4,
): NMDScenarioOutput {
  const nPaths = paths.length;
  if (nPaths === 0) {
    throw new Error("runNMDOnPaths: paths must be non-empty");
  }
  const nSteps = paths[0].length;
  const D = params.balanceDenominator;
  const S0_dollars = params.balanceSize;

  const allDecay: Float64Array[] = new Array(nSteps);
  const allBal: Float64Array[] = new Array(nSteps);
  for (let t = 0; t < nSteps; t++) {
    allDecay[t] = new Float64Array(nPaths);
    allBal[t] = new Float64Array(nPaths);
  }

  let sumWal = 0;
  let sumLifeDecay = 0;

  for (let p = 0; p < nPaths; p++) {
    const path = paths[p];
    const pathRatesPct = new Float64Array(nSteps);
    for (let t = 0; t < nSteps; t++) pathRatesPct[t] = path[t] * 100;
    const fullHistory = [...historicalSOFR1M, ...Array.from(pathRatesPct)];
    const offset = historicalSOFR1M.length;

    // Two-tranche initial split: insured = min(D, S0), uninsured = remainder.
    let balIns = Math.min(Math.max(0, D), S0_dollars);
    let balUnins = S0_dollars - balIns;
    let cumIncentive = 0;
    let walSum = 0;
    let balSum = 0;
    let decayWeightSum = 0;

    for (let t = 1; t <= nSteps; t++) {
      const idx = offset + t - 1;
      const currentRate = fullHistory[idx];

      let maSum = 0;
      for (let j = 1; j <= params.maPeriod; j++) maSum += fullHistory[idx - j];
      const spread = currentRate - maSum / params.maPeriod;

      const expTerm = Math.exp(-params.logisticK * (spread - params.logisticMidpoint));
      const baseIncentive =
        params.maxRateGrowth + (params.maxRateDecay - params.maxRateGrowth) / (1 + expTerm);

      const burnoutB = Math.exp(-params.burnoutLambda * cumIncentive);
      const tau = Math.max(params.closureTauMonths, 1e-6);
      const closureT =
        params.closureSteady +
        (params.closureInitial - params.closureSteady) * Math.exp(-(t - 1) / tau);

      // Salience = rate LEVEL / ref (cash-sorting magnitude, not spread).
      const salience = Math.max(0, currentRate) / salienceRefPct;
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

      // Display in normalized (start=100) units.
      const balDisplay = (bal / S0_dollars) * 100;

      allDecay[t - 1][p] = actualDecay;
      allBal[t - 1][p] = (newBal / S0_dollars) * 100;

      balSum += balDisplay;
      decayWeightSum += actualDecay * balDisplay;

      if (decayAmount > 0) walSum += (decayAmount / S0_dollars) * (t / 12);

      if (baseIncentive > 0) cumIncentive += baseIncentive;
      balIns = newBalIns;
      balUnins = newBalUnins;
    }

    // Tail piece for any balance still alive at horizon.
    walSum += ((balIns + balUnins) / S0_dollars) * (nSteps / 12);
    sumWal += walSum;
    sumLifeDecay += balSum > 0 ? decayWeightSum / balSum : 0;
  }

  const decayMean = new Float64Array(nSteps);
  const decayP5 = new Float64Array(nSteps);
  const decayP95 = new Float64Array(nSteps);
  const balMean = new Float64Array(nSteps);
  const balP5 = new Float64Array(nSteps);
  const balP95 = new Float64Array(nSteps);

  for (let t = 0; t < nSteps; t++) {
    if (nPaths === 1) {
      decayMean[t] = allDecay[t][0];
      decayP5[t] = allDecay[t][0];
      decayP95[t] = allDecay[t][0];
      balMean[t] = allBal[t][0];
      balP5[t] = allBal[t][0];
      balP95[t] = allBal[t][0];
    } else {
      const sortedDecay = Array.from(allDecay[t]).sort((a, b) => a - b);
      const sortedBal = Array.from(allBal[t]).sort((a, b) => a - b);
      decayMean[t] = sortedDecay.reduce((s, v) => s + v, 0) / nPaths;
      decayP5[t] = percentile(sortedDecay, 0.05);
      decayP95[t] = percentile(sortedDecay, 0.95);
      balMean[t] = sortedBal.reduce((s, v) => s + v, 0) / nPaths;
      balP5[t] = percentile(sortedBal, 0.05);
      balP95[t] = percentile(sortedBal, 0.95);
    }
  }

  return {
    decayMean,
    decayP5,
    decayP95,
    balMean,
    balP5,
    balP95,
    wal: sumWal / nPaths,
    lifeDecay: sumLifeDecay / nPaths,
  };
}

/**
 * Sub-linear log-additive balance-size multiplier.
 * balMult = max(0, 1 + ln(S / S₀)).
 *   S = S₀     → balMult = 1   (no scaling)
 *   S = 2·S₀   → balMult ≈ 1.69
 *   S = 4·S₀   → balMult ≈ 2.39
 *   S ≤ S₀/e   → balMult = 0   (rate-driven decay turned off)
 */
export function computeBalMult(balanceSize: number, balanceDenominator: number): number {
  if (balanceSize <= 0 || balanceDenominator <= 0) return 0;
  return Math.max(0, 1 + Math.log(balanceSize / balanceDenominator));
}

/** Static logistic decay-curve diagnostic (decay vs spread). */
export function nmdSCurveData(params: NMDParams): Array<{ spread: number; incentive: number }> {
  const balMult = computeBalMult(params.balanceSize, params.balanceDenominator);
  const out: Array<{ spread: number; incentive: number }> = [];
  for (let s = -4.0; s <= 4.01; s += 0.1) {
    const expTerm = Math.exp(-params.logisticK * (s - params.logisticMidpoint));
    const baseIncentive =
      params.maxRateGrowth + (params.maxRateDecay - params.maxRateGrowth) / (1 + expTerm);
    out.push({ spread: Number(s.toFixed(2)), incentive: baseIncentive * balMult });
  }
  return out;
}

/**
 * Balance-scaling diagnostic: rate-driven decay vs S/S₀ ratio at three
 * fixed reference spreads (−2%, 0%, +2%). Shows how the log-additive
 * balMult amplifies each spread regime.
 *
 * X-axis: balance ratio S/S₀ (log scale on the chart side).
 * Y-axis: rate-driven decay impact (%/mo).
 */
export function nmdBalanceScalingData(
  params: NMDParams,
): Array<{ ratio: number; spreadDown: number; spreadFlat: number; spreadUp: number }> {
  const referenceSpreads = [-2.0, 0.0, 2.0];
  const baseIncentiveAt = (s: number): number => {
    const expTerm = Math.exp(-params.logisticK * (s - params.logisticMidpoint));
    return params.maxRateGrowth + (params.maxRateDecay - params.maxRateGrowth) / (1 + expTerm);
  };
  const baseAt = referenceSpreads.map(baseIncentiveAt);

  // Log-spaced ratio grid from 0.1× to 10×.
  const out: Array<{ ratio: number; spreadDown: number; spreadFlat: number; spreadUp: number }> = [];
  const nSteps = 60;
  const logMin = Math.log(0.1);
  const logMax = Math.log(10.0);
  for (let i = 0; i <= nSteps; i++) {
    const logR = logMin + (i / nSteps) * (logMax - logMin);
    const ratio = Math.exp(logR);
    const balMult = Math.max(0, 1 + logR);
    out.push({
      ratio: Number(ratio.toFixed(4)),
      spreadDown: baseAt[0] * balMult,
      spreadFlat: baseAt[1] * balMult,
      spreadUp: baseAt[2] * balMult,
    });
  }
  return out;
}

/**
 * Closure age-ramp diagnostic: closure(t) decays from `closureInitial` toward
 * `closureSteady` with time constant τ. Returns 0..120 months at monthly
 * resolution.
 *
 * X-axis: months from cohort origination.
 * Y-axis: closure rate (%/mo).
 */
export function nmdClosureRampData(
  params: NMDParams,
): Array<{ month: number; closure: number; steady: number }> {
  const tau = Math.max(params.closureTauMonths, 1e-6);
  const out: Array<{ month: number; closure: number; steady: number }> = [];
  for (let m = 0; m <= 120; m++) {
    const closure =
      params.closureSteady + (params.closureInitial - params.closureSteady) * Math.exp(-m / tau);
    out.push({ month: m, closure, steady: params.closureSteady });
  }
  return out;
}
