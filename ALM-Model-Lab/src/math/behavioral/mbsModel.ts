/**
 * MBS prepayment model — TypeScript port of the prototype's
 * `handleGenerateCashFlows` (Gemini source lines ~948-1110).
 *
 * Per-month CPR is the product of four factors:
 *   1. Refi incentive (logistic on WAC - currentMortgageRate)
 *   2. Seasoning ramp (linear, capped at 1.0)
 *   3. Seasonality (sinusoidal, summer peak)
 *   4. Burnout (exponential decay against cumulative ITM)
 *
 * Each path runs through 360 monthly amortization steps starting from
 * balance = 100. Output: per-step CPR + balance fans (mean + p5/p95) plus
 * scalar WAL and life-CPR per scenario.
 *
 * Conventions:
 *   - All rate params in percentage points (e.g. WAC = 6.50 means 6.50%).
 *   - Spread params in basis points (sec + prim spreads added to underlying rate).
 *   - Output CPR in percent, balance in normalised units (start = 100).
 */

import { FourFactorCPR } from "./prepay";

export interface MBSParams {
  // Spreads (bps)
  secSpread: number; // securitization OAS / agency g-fee
  primSpread: number; // primary-secondary spread
  // Rates
  wac: number; // weighted average coupon (%)
  // Logistic refi-incentive parameters (CPR in %)
  minCpr: number;
  maxCpr: number;
  steepness: number;
  inflection: number; // bps spread at the S-curve midpoint
  // Multipliers
  seasoningRamp: number; // months to full seasoning
  seasonalityAmp: number; // peak/trough amplitude in %
  burnoutDecay: number; // exponential decay rate (per cumulative ITM unit)
}

export const MBS_DEFAULTS: MBSParams = {
  secSpread: 120,
  primSpread: 130,
  wac: 6.5,
  minCpr: 2.0,
  maxCpr: 65.0,
  // 2.5 keeps the deterministic path on the convex toe of the S-curve so MC
  // dispersion shortens average life (Jensen): WAL and effective duration
  // under HW/BGM come out BELOW the deterministic single path, the usual
  // practitioner ordering. At 1.5 the MC mean-rate drift dominated and the
  // ordering inverted.
  steepness: 2.5,
  inflection: 50,
  seasoningRamp: 30,
  seasonalityAmp: 20,
  burnoutDecay: 0.1,
};

export interface MBSScenarioOutput {
  cprMean: Float64Array; // length nSteps, in percent
  cprP5: Float64Array;
  cprP95: Float64Array;
  balMean: Float64Array; // length nSteps, normalised
  balP5: Float64Array;
  balP95: Float64Array;
  wal: number; // years (path-mean)
  lifeCpr: number; // % (balance-weighted, path-mean)
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
 * Run the prepayment model on an array of rate paths.
 *
 * @param paths Array of rate paths. Each path is a Float64Array of length
 *   nSteps containing the underlying mortgage benchmark rate (typically
 *   the 10Y forward at each simulation time) in DECIMAL terms (e.g. 0.04
 *   for 4%).
 * @param params Logistic CPR + multiplier parameters.
 */
export function runMBSOnPaths(
  paths: ArrayLike<Float64Array>,
  params: MBSParams,
): MBSScenarioOutput {
  const nPaths = paths.length;
  if (nPaths === 0) {
    throw new Error("runMBSOnPaths: paths must be non-empty");
  }
  const nSteps = paths[0].length;

  const allCpr: Float64Array[] = new Array(nSteps);
  const allBal: Float64Array[] = new Array(nSteps);
  for (let t = 0; t < nSteps; t++) {
    allCpr[t] = new Float64Array(nPaths);
    allBal[t] = new Float64Array(nPaths);
  }

  let sumWal = 0;
  let sumLifeCpr = 0;
  const totalSpread = (params.secSpread + params.primSpread) / 1e4;
  const wacMonthly = params.wac / 100 / 12;
  const model = new FourFactorCPR(params);

  for (let p = 0; p < nPaths; p++) {
    const path = paths[p];
    // CPR is balance-independent; precompute the whole schedule via the shared
    // PrepayModel seam (FourFactorCPR), then run the MC-fan amortization below.
    const cprSchedule = model.cprSchedule({
      term: nSteps,
      age: 0,
      noteRate: params.wac / 100,
      mortgageRateAt: (m) => path[m - 1] + totalSpread,
    });

    let bal = 100.0;
    let walSum = 0;
    let balSum = 0;
    let cprWeightSum = 0;

    for (let t = 1; t <= nSteps; t++) {
      const finalCpr = cprSchedule[t - 1] * 100; // seam returns decimal; fan reports percent

      allCpr[t - 1][p] = finalCpr;
      allBal[t - 1][p] = bal;

      balSum += bal;
      cprWeightSum += finalCpr * bal;

      const smm = 1 - Math.pow(1 - finalCpr / 100, 1 / 12);
      const remMonths = nSteps - t + 1;
      let sp = 0;
      if (bal > 0.0001) {
        sp = bal * (wacMonthly / (Math.pow(1 + wacMonthly, remMonths) - 1));
      }
      const pp = (bal - sp) * smm;
      const totalPrin = Math.min(bal, sp + pp);

      walSum += totalPrin * (t / 12);
      bal -= totalPrin;
    }

    sumWal += walSum / 100;
    sumLifeCpr += balSum > 0 ? cprWeightSum / balSum : 0;
  }

  const cprMean = new Float64Array(nSteps);
  const cprP5 = new Float64Array(nSteps);
  const cprP95 = new Float64Array(nSteps);
  const balMean = new Float64Array(nSteps);
  const balP5 = new Float64Array(nSteps);
  const balP95 = new Float64Array(nSteps);

  for (let t = 0; t < nSteps; t++) {
    if (nPaths === 1) {
      cprMean[t] = allCpr[t][0];
      cprP5[t] = allCpr[t][0];
      cprP95[t] = allCpr[t][0];
      balMean[t] = allBal[t][0];
      balP5[t] = allBal[t][0];
      balP95[t] = allBal[t][0];
    } else {
      const sortedCpr = Array.from(allCpr[t]).sort((a, b) => a - b);
      const sortedBal = Array.from(allBal[t]).sort((a, b) => a - b);
      cprMean[t] = sortedCpr.reduce((s, v) => s + v, 0) / nPaths;
      cprP5[t] = percentile(sortedCpr, 0.05);
      cprP95[t] = percentile(sortedCpr, 0.95);
      balMean[t] = sortedBal.reduce((s, v) => s + v, 0) / nPaths;
      balP5[t] = percentile(sortedBal, 0.05);
      balP95[t] = percentile(sortedBal, 0.95);
    }
  }

  return {
    cprMean,
    cprP5,
    cprP95,
    balMean,
    balP5,
    balP95,
    wal: sumWal / nPaths,
    lifeCpr: sumLifeCpr / nPaths,
  };
}

/** Compute the static refi-incentive S-curve (CPR vs rate-difference). */
export function sCurveData(params: MBSParams): Array<{ diffBps: number; cpr: number }> {
  const inflectionPct = params.inflection / 100;
  const out: Array<{ diffBps: number; cpr: number }> = [];
  for (let bps = -300; bps <= 400; bps += 10) {
    const rateDiff = bps / 100;
    const riBase =
      (params.maxCpr - params.minCpr) /
      (1 + Math.exp(-params.steepness * (rateDiff - inflectionPct)));
    out.push({ diffBps: bps, cpr: params.minCpr + riBase });
  }
  return out;
}

/** Seasoning ramp curve: month -> multiplier in [0, 1]. */
export function seasoningCurve(params: MBSParams, maxMonths = 60): Array<{ month: number; factor: number }> {
  const out: Array<{ month: number; factor: number }> = [];
  for (let t = 1; t <= maxMonths; t++) {
    out.push({ month: t, factor: Math.min(1.0, t / params.seasoningRamp) });
  }
  return out;
}

/** Seasonality multiplier across a 12-month cycle. */
export function seasonalityCurve(params: MBSParams): Array<{ month: number; factor: number }> {
  const amp = params.seasonalityAmp / 100;
  const out: Array<{ month: number; factor: number }> = [];
  for (let m = 1; m <= 12; m++) {
    out.push({ month: m, factor: 1 + amp * Math.sin((Math.PI * (m - 4)) / 6) });
  }
  return out;
}

/** Burnout decay against cumulative ITM (assumes a fixed ITM per month for diagnostic). */
export function burnoutCurve(
  params: MBSParams,
  itmPerMonthPct: number,
  maxMonths = 120,
): Array<{ month: number; factor: number }> {
  const decay = params.burnoutDecay / 100;
  const out: Array<{ month: number; factor: number }> = [];
  let cumItm = 0;
  for (let t = 1; t <= maxMonths; t++) {
    cumItm += Math.max(0, itmPerMonthPct);
    out.push({ month: t, factor: Math.exp(-decay * cumItm) });
  }
  return out;
}
