/**
 * Deposit-tractor replicating-portfolio analytics: Phase 3 of the
 * rate-history integration.
 *
 * The atom is the moving-average pillar: a k-month MA of the k-month SOFR
 * tenor IS k equal rolling bullets in that tenor IS a linear-amortizing
 * runoff (WAL = (k+1)/2 months) whose steady-state yield is the trailing
 * k-month average of the k-month rate. `research/rp_tractor_verify.py`
 * confirms the identity on the spliced overnight series; the tests here
 * re-verify it on the real term-history dataset.
 *
 * Two yields per pillar, never mixed in one figure:
 *   - new-money    : today's curve par rate at the pillar tenor, linear
 *                    interpolation in t-years over the snapshot curve quotes
 *                    (port of the Python reference's `curve_rate`; k <= 1
 *                    uses the 1D cash quote).
 *   - steady-state : `RateHistory.pillarYield`, the trailing k-month MA of
 *                    the k-month tenor from the real term history. This
 *                    replaces the Python reference's overnight-proxy lag
 *                    adjustment entirely.
 *
 * Solver: exact face-enumeration QP, not iterative Lawson-Hanson.
 *   min (1/2) w'Qw − c'w   s.t.   Aw = b,  w >= 0
 * For convex Q the optimum sits on some face of the nonnegative orthant
 * (a support subset S of the pillars). Enumerate every subset (n <= 12 so
 * <= 4096 faces), solve each face's equality-KKT system by small Gaussian
 * elimination, keep primal-feasible candidates, take the minimum objective:
 * provably global. One engine serves both the NNLS client-rate regression
 * (Q = Y'Y, c = Y't) and the NIB min-vol frontier (Q = Σ, c = 0).
 *
 * NIB frontier covariance: historical monthly CHANGES of the pillar-yield
 * series, annualized, estimated on the common complete window. This is a
 * deliberate deviation from the Python reference's forward Vasicek MC; an
 * HW-simulated version (projectHWToTenor) is the future upgrade.
 */

import type { Cashflow } from "../instruments/types";
import type { CurveQuote } from "../rates/marketData";
import type { RateHistory } from "../rates/rateHistory";
import { firstCompleteIndex, trailingMASeries } from "../rates/rateHistory";
import { betaAtRate, type BetaSCurveParams } from "../instruments/nmdBeta";
import type { ZeroCurve } from "../rates/bootstrap";
import { projectHWToTenor, type HWSimulationResult } from "../rates/simulateHw";

/**
 * Pillar WAL in months. A k-month linear-amortizing pillar (equal monthly
 * principal) has WAL = (k+1)/2. k <= 1 uses the overnight convention of
 * 0.5 months (the Python reference's `pillar_wal_months`), not the discrete
 * 1-month bullet's 1.0.
 */
export function pillarWalMonths(k: number): number {
  return k <= 1 ? 0.5 : (k + 1) / 2;
}

/** Blend WAL in months: weight-dot-WAL across pillars. */
export function blendWalMonths(
  pillars: ReadonlyArray<number>,
  weights: ReadonlyArray<number>,
): number {
  if (pillars.length !== weights.length) {
    throw new Error("blendWalMonths: pillars and weights length mismatch");
  }
  let m = 0;
  for (let i = 0; i < pillars.length; i++) m += weights[i] * pillarWalMonths(pillars[i]);
  return m;
}

/**
 * Stock view of a steady-state k-month pillar: a linear-amortizing runoff,
 * 1/k of notional maturing each month, emitted in the shared Cashflow shape
 * (monthOffset 1-based, balance = start-of-month) so it feeds
 * `ftp.parMatchedRate` and the gap/EVE schedules unchanged.
 */
export function pillarLadderCashflows(
  k: number,
  notional: number,
  couponRate = 0,
): Cashflow[] {
  const n = Math.max(1, Math.round(k));
  const principal = notional / n;
  const out: Cashflow[] = [];
  let bal = notional;
  for (let m = 1; m <= n; m++) {
    const principalPaid = m === n ? bal : principal;
    out.push({
      monthOffset: m,
      balance: bal,
      principalPaid,
      interestPaid: (bal * couponRate) / 12,
      couponRate,
    });
    bal -= principalPaid;
  }
  return out;
}

/** WAL in months implied by a cashflow schedule's principal runoff. */
export function ladderWalMonths(cf: ReadonlyArray<Cashflow>, notional: number): number {
  let s = 0;
  for (const c of cf) s += c.monthOffset * c.principalPaid;
  return s / notional;
}

/**
 * New-money pillar yield: today's curve par rate at the pillar tenor.
 * Exact port of the Python reference's `curve_rate`: linear interpolation
 * in t-years over the snapshot curve quotes, clamped at the ends. k <= 1
 * returns the shortest (1D cash) quote.
 */
export function newMoneyYield(kMonths: number, quotes: ReadonlyArray<CurveQuote>): number {
  if (quotes.length === 0) throw new Error("newMoneyYield: empty curve quotes");
  const sorted = [...quotes].sort((a, b) => a.tYears - b.tYears);
  if (kMonths <= 1) return sorted[0].rate;
  const t = kMonths / 12;
  if (t <= sorted[0].tYears) return sorted[0].rate;
  const last = sorted.length - 1;
  if (t >= sorted[last].tYears) return sorted[last].rate;
  let i = 1;
  while (sorted[i].tYears < t) i++;
  const w = (t - sorted[i - 1].tYears) / (sorted[i].tYears - sorted[i - 1].tYears);
  return sorted[i - 1].rate + w * (sorted[i].rate - sorted[i - 1].rate);
}

/** Full monthly steady-state yield series for one pillar (NaN before the
 *  first complete window). The trailing k-MA of the k-month tenor. */
export function pillarYieldLevelSeries(history: RateHistory, k: number): number[] {
  return trailingMASeries(history.sofrTermSeries(k), k);
}

// ---------------------------------------------------------------------------
// Exact face-enumeration QP
// ---------------------------------------------------------------------------

export interface QpSolution {
  weights: number[];
  objective: number;
  /** false when no support subset yields a primal-feasible KKT solution. */
  feasible: boolean;
}

const MAX_QP_VARS = 12;

/**
 * Gaussian elimination with partial pivoting. Returns null on a singular
 * system (pivot below tolerance); callers skip that face.
 */
function solveLinear(M: number[][], rhs: number[]): number[] | null {
  const n = rhs.length;
  // Augmented working copy.
  const a = M.map((row, i) => [...row, rhs[i]]);
  let maxAbs = 0;
  for (const row of a) for (const v of row) maxAbs = Math.max(maxAbs, Math.abs(v));
  const tol = 1e-12 * Math.max(1, maxAbs);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    }
    if (Math.abs(a[piv][col]) < tol) return null;
    if (piv !== col) [a[piv], a[col]] = [a[col], a[piv]];
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / a[col][col];
      if (f === 0) continue;
      for (let cc = col; cc <= n; cc++) a[r][cc] -= f * a[col][cc];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let acc = a[r][n];
    for (let cc = r + 1; cc < n; cc++) acc -= a[r][cc] * x[cc];
    x[r] = acc / a[r][r];
  }
  return x;
}

/**
 * Global solver for the small convex QP
 *   min (1/2) w'Qw − c'w   s.t.   Aw = b,  w >= 0.
 *
 * Enumerates every non-empty support subset S, solves the face's KKT system
 *   [ Q_SS  A_S' ] [w_S]   [c_S]
 *   [ A_S   0   ] [ λ ]  = [ b ]
 * and keeps the primal-feasible candidate with the lowest objective. For
 * PSD Q the optimum lies on some face, where it satisfies exactly this
 * system, so the enumeration is exhaustive and the result global.
 */
export function solveConstrainedQP(
  Q: ReadonlyArray<ReadonlyArray<number>>,
  c: ReadonlyArray<number>,
  A: ReadonlyArray<ReadonlyArray<number>>,
  b: ReadonlyArray<number>,
): QpSolution {
  const n = c.length;
  const m = b.length;
  if (n === 0 || Q.length !== n || Q.some((row) => row.length !== n)) {
    throw new Error("solveConstrainedQP: Q must be n x n matching c");
  }
  if (A.length !== m || A.some((row) => row.length !== n)) {
    throw new Error("solveConstrainedQP: A must be m x n matching b");
  }
  if (n > MAX_QP_VARS) {
    throw new Error(`solveConstrainedQP: ${n} variables exceeds the 2^${MAX_QP_VARS} enumeration cap`);
  }

  let bestW: number[] | null = null;
  let bestObj = Infinity;

  for (let mask = 1; mask < 1 << n; mask++) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) idx.push(i);
    const s = idx.length;
    const dim = s + m;

    const M: number[][] = Array.from({ length: dim }, () => new Array<number>(dim).fill(0));
    const rhs = new Array<number>(dim).fill(0);
    for (let i = 0; i < s; i++) {
      for (let j = 0; j < s; j++) M[i][j] = Q[idx[i]][idx[j]];
      for (let r = 0; r < m; r++) {
        M[i][s + r] = A[r][idx[i]];
        M[s + r][i] = A[r][idx[i]];
      }
      rhs[i] = c[idx[i]];
    }
    for (let r = 0; r < m; r++) rhs[s + r] = b[r];

    const sol = solveLinear(M, rhs);
    if (!sol) continue;

    const w = new Array<number>(n).fill(0);
    let ok = true;
    for (let i = 0; i < s; i++) {
      if (sol[i] < -1e-9) {
        ok = false;
        break;
      }
      w[idx[i]] = Math.max(0, sol[i]);
    }
    if (!ok) continue;
    for (let r = 0; r < m; r++) {
      let acc = 0;
      for (let j = 0; j < n; j++) acc += A[r][j] * w[j];
      if (Math.abs(acc - b[r]) > 1e-7 * Math.max(1, Math.abs(b[r]))) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    let obj = 0;
    for (let i = 0; i < n; i++) {
      obj -= c[i] * w[i];
      for (let j = 0; j < n; j++) obj += 0.5 * w[i] * Q[i][j] * w[j];
    }
    if (obj < bestObj) {
      bestObj = obj;
      bestW = w;
    }
  }

  return bestW
    ? { weights: bestW, objective: bestObj, feasible: true }
    : { weights: new Array<number>(n).fill(NaN), objective: NaN, feasible: false };
}

// ---------------------------------------------------------------------------
// NIB frontier: covariance + min-vol / max-yield endpoints
// ---------------------------------------------------------------------------

export interface PillarCovariance {
  /** Annualized covariance of monthly pillar-yield changes, decimal^2. */
  cov: number[][];
  /** Number of monthly change observations in the common window. */
  nObs: number;
  /** History index of the first month with every pillar's window complete. */
  startIdx: number;
}

/** Below this many monthly change observations the estimate is starved
 *  (the 180M pillar's window only completes in Sep 2023). */
export const STARVED_COV_OBS = 36;

/**
 * Pillar-yield covariance from historical monthly CHANGES of each pillar's
 * steady-state yield series, annualized (x12), on the common complete
 * window ending at `endIdx`. Sample covariance with n−1 denominator.
 */
export function pillarYieldCovariance(
  history: RateHistory,
  pillars: ReadonlyArray<number>,
  endIdx: number,
): PillarCovariance {
  const p = pillars.length;
  if (p === 0) throw new Error("pillarYieldCovariance: no pillars");
  const levels = pillars.map((k) => pillarYieldLevelSeries(history, k));
  let startIdx = 0;
  for (const k of pillars) startIdx = Math.max(startIdx, firstCompleteIndex(k));
  if (endIdx >= history.months.length) {
    throw new Error(`pillarYieldCovariance: endIdx ${endIdx} out of range`);
  }
  const nObs = endIdx - startIdx;
  if (nObs < 2) {
    throw new Error(
      `pillarYieldCovariance: only ${nObs} change observations between the first ` +
        `complete window (${history.months[startIdx]}) and ${history.months[endIdx]}`,
    );
  }

  const changes: number[][] = Array.from({ length: p }, () => new Array<number>(nObs));
  for (let i = 0; i < p; i++) {
    for (let t = 0; t < nObs; t++) {
      changes[i][t] = levels[i][startIdx + t + 1] - levels[i][startIdx + t];
    }
  }
  const means = changes.map((d) => d.reduce((s, v) => s + v, 0) / nObs);
  const cov: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  for (let i = 0; i < p; i++) {
    for (let j = i; j < p; j++) {
      let acc = 0;
      for (let t = 0; t < nObs; t++) {
        acc += (changes[i][t] - means[i]) * (changes[j][t] - means[j]);
      }
      const v = (acc / (nObs - 1)) * 12; // annualize monthly-change variance
      cov[i][j] = v;
      cov[j][i] = v;
    }
  }
  return { cov, nObs, startIdx };
}

export interface BlendSolution {
  weights: number[];
  /** Blend yield, decimal: weight-dot-mu (new-money by convention). */
  yieldDec: number;
  /** Annualized yield-change vol of the blend, bp: sqrt(w'Σw) x 1e4. */
  volBp: number;
  walMonths: number;
  feasible: boolean;
}

function blendStats(
  pillars: ReadonlyArray<number>,
  mu: ReadonlyArray<number>,
  cov: ReadonlyArray<ReadonlyArray<number>>,
  w: number[],
  feasible: boolean,
): BlendSolution {
  let y = 0;
  let varAcc = 0;
  for (let i = 0; i < w.length; i++) {
    y += w[i] * mu[i];
    for (let j = 0; j < w.length; j++) varAcc += w[i] * cov[i][j] * w[j];
  }
  return {
    weights: w,
    yieldDec: y,
    volBp: Math.sqrt(Math.max(0, varAcc)) * 1e4,
    walMonths: blendWalMonths(pillars, w),
    feasible,
  };
}

/**
 * Min-vol endpoint of the NIB frontier: min w'Σw s.t. sum(w)=1,
 * WAL(w)=target, w>=0. A tiny ridge (1e-6 x mean diagonal) regularizes the
 * near-singular covariance of highly correlated MA series; stats are
 * reported against the raw Σ.
 */
export function minVolBlend(
  pillars: ReadonlyArray<number>,
  mu: ReadonlyArray<number>,
  cov: ReadonlyArray<ReadonlyArray<number>>,
  targetWalMonths: number,
): BlendSolution {
  const p = pillars.length;
  let trace = 0;
  for (let i = 0; i < p; i++) trace += cov[i][i];
  const ridge = 1e-6 * (trace / p);
  const Q = cov.map((row, i) => row.map((v, j) => (i === j ? v + ridge : v)));
  const A = [new Array<number>(p).fill(1), pillars.map((k) => pillarWalMonths(k))];
  const sol = solveConstrainedQP(Q, new Array<number>(p).fill(0), A, [1, targetWalMonths]);
  if (!sol.feasible) {
    return { weights: sol.weights, yieldDec: NaN, volBp: NaN, walMonths: NaN, feasible: false };
  }
  return blendStats(pillars, mu, cov, sol.weights, true);
}

/**
 * Max-yield endpoint of the NIB frontier: max w·mu s.t. sum(w)=1,
 * WAL(w)=target, w>=0. An LP whose optimum sits at a vertex of the
 * two-equality-constraint polytope, i.e. at most two nonzero pillars, so
 * enumerating singles and pairs is exact.
 */
export function maxYieldBlend(
  pillars: ReadonlyArray<number>,
  mu: ReadonlyArray<number>,
  cov: ReadonlyArray<ReadonlyArray<number>>,
  targetWalMonths: number,
): BlendSolution {
  const p = pillars.length;
  const wal = pillars.map((k) => pillarWalMonths(k));
  let bestW: number[] | null = null;
  let bestY = -Infinity;

  for (let i = 0; i < p; i++) {
    if (Math.abs(wal[i] - targetWalMonths) < 1e-9 && mu[i] > bestY) {
      const w = new Array<number>(p).fill(0);
      w[i] = 1;
      bestW = w;
      bestY = mu[i];
    }
  }
  for (let i = 0; i < p; i++) {
    for (let j = i + 1; j < p; j++) {
      const denom = wal[i] - wal[j];
      if (Math.abs(denom) < 1e-12) continue;
      const wi = (targetWalMonths - wal[j]) / denom;
      if (wi < -1e-9 || wi > 1 + 1e-9) continue;
      const wiC = Math.min(1, Math.max(0, wi));
      const y = wiC * mu[i] + (1 - wiC) * mu[j];
      if (y > bestY) {
        const w = new Array<number>(p).fill(0);
        w[i] = wiC;
        w[j] = 1 - wiC;
        bestW = w;
        bestY = y;
      }
    }
  }

  if (!bestW) {
    return {
      weights: new Array<number>(p).fill(NaN),
      yieldDec: NaN,
      volBp: NaN,
      walMonths: NaN,
      feasible: false,
    };
  }
  return blendStats(pillars, mu, cov, bestW, true);
}

// ---------------------------------------------------------------------------
// IB demo: synthetic client rate + NNLS pillar regression
// ---------------------------------------------------------------------------

/**
 * Synthesize a client-rate history (decimal, full dataset length) by running
 * the NMD-B S-curve beta against the historical overnight SOFR series:
 * D_target = beta(r) · r with Nerlove partial adjustment (same recursion as
 * NMDBeta.depositRatePath, t=0 snaps to target).
 */
export function synthesizeClientRateSeries(
  history: RateHistory,
  sCurve: BetaSCurveParams,
): number[] {
  const n = history.months.length;
  const out = new Array<number>(n);
  let dPrev = 0;
  for (let t = 0; t < n; t++) {
    const rPct = history.sofrON[t] * 100;
    const target = betaAtRate(rPct, sCurve) * rPct;
    const dNow = t === 0 ? target : Math.max(0, dPrev + sCurve.lambda * (target - dPrev));
    out[t] = dNow / 100;
    dPrev = dNow;
  }
  return out;
}

/**
 * Reconstruct the fitted client-rate level series from a pillar-weight vector:
 * fit[t] = sum_i w_i · pillarYieldLevelSeries(history, k_i)[t], full dataset
 * length. NaN propagates before the longest pillar's first complete window,
 * so slicing to [startIdx, endIdx] gives exactly the regression's fit. Pairs
 * with `synthesizeClientRateSeries` (the actual) for the fitted-vs-actual chart.
 */
export function fittedClientRateSeries(
  history: RateHistory,
  pillars: ReadonlyArray<number>,
  weights: ReadonlyArray<number>,
): number[] {
  if (pillars.length !== weights.length) {
    throw new Error("fittedClientRateSeries: pillars and weights length mismatch");
  }
  const levels = pillars.map((k) => pillarYieldLevelSeries(history, k));
  const n = history.months.length;
  const out = new Array<number>(n);
  for (let t = 0; t < n; t++) {
    let acc = 0;
    for (let i = 0; i < pillars.length; i++) acc += weights[i] * levels[i][t];
    out[t] = acc;
  }
  return out;
}

export interface StackedLadderRow {
  /** 1-based month offset. */
  month: number;
  /** Start-of-month balance contributed by each pillar (aligned to `pillars`). */
  byPillar: number[];
  /** Sum across pillars: the composite RP start-of-month balance. */
  total: number;
}

/**
 * Expand a pillar-weight vector into a stacked runoff profile: each pillar k
 * becomes its linear-amortizing ladder on (w_k · notional), padded with zeros
 * past its maturity, so the per-month columns stack into the blended RP's
 * amortization. Month-1 total = notional (weights summing to 1) and the
 * principal-weighted WAL of the total equals `blendWalMonths`. Drives the
 * stacked maturity-ladder charts.
 */
export function stackedLadderByPillar(
  pillars: ReadonlyArray<number>,
  weights: ReadonlyArray<number>,
  notional: number,
): StackedLadderRow[] {
  if (pillars.length !== weights.length) {
    throw new Error("stackedLadderByPillar: pillars and weights length mismatch");
  }
  const ladders = pillars.map((k, i) => pillarLadderCashflows(k, weights[i] * notional));
  const maxLen = ladders.reduce((mx, cf) => Math.max(mx, cf.length), 0);
  const rows: StackedLadderRow[] = [];
  for (let m = 0; m < maxLen; m++) {
    const byPillar = ladders.map((cf) => (m < cf.length ? cf[m].balance : 0));
    rows.push({ month: m + 1, byPillar, total: byPillar.reduce((s, v) => s + v, 0) });
  }
  return rows;
}

export interface PillarRegression {
  weights: number[];
  r2: number;
  rmseBp: number;
  nObs: number;
  startIdx: number;
  feasible: boolean;
}

/**
 * NNLS regression of a target rate series on the pillar steady-state yield
 * series: min ||Yw − t||² s.t. w >= 0, sum(w) = 1, over the common complete
 * window ending at `endIdx`. The sum constraint is enforced directly in the
 * QP (the practitioner residual-to-longest-tenor rule is the manual fix for
 * unconstrained NNLS; the equality row makes it unnecessary).
 */
export function regressOnPillars(
  history: RateHistory,
  pillars: ReadonlyArray<number>,
  target: ReadonlyArray<number>,
  endIdx: number,
): PillarRegression {
  const p = pillars.length;
  if (p === 0) throw new Error("regressOnPillars: no pillars");
  if (target.length !== history.months.length) {
    throw new Error("regressOnPillars: target must align with history.months");
  }
  if (endIdx >= history.months.length) {
    throw new Error(`regressOnPillars: endIdx ${endIdx} out of range`);
  }
  const levels = pillars.map((k) => pillarYieldLevelSeries(history, k));
  let startIdx = 0;
  for (const k of pillars) startIdx = Math.max(startIdx, firstCompleteIndex(k));
  const nObs = endIdx - startIdx + 1;
  if (nObs < p + 2) {
    throw new Error(
      `regressOnPillars: ${nObs} observations for ${p} pillars; window too short`,
    );
  }

  // Q = Y'Y, c = Y't on the window.
  const Q: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const c = new Array<number>(p).fill(0);
  for (let t = startIdx; t <= endIdx; t++) {
    for (let i = 0; i < p; i++) {
      c[i] += levels[i][t] * target[t];
      for (let j = i; j < p; j++) {
        Q[i][j] += levels[i][t] * levels[j][t];
      }
    }
  }
  for (let i = 0; i < p; i++) for (let j = 0; j < i; j++) Q[i][j] = Q[j][i];

  const sol = solveConstrainedQP(Q, c, [new Array<number>(p).fill(1)], [1]);
  if (!sol.feasible) {
    return { weights: sol.weights, r2: NaN, rmseBp: NaN, nObs, startIdx, feasible: false };
  }

  let ssRes = 0;
  let tMean = 0;
  for (let t = startIdx; t <= endIdx; t++) tMean += target[t];
  tMean /= nObs;
  let ssTot = 0;
  for (let t = startIdx; t <= endIdx; t++) {
    let fit = 0;
    for (let i = 0; i < p; i++) fit += sol.weights[i] * levels[i][t];
    ssRes += (target[t] - fit) ** 2;
    ssTot += (target[t] - tMean) ** 2;
  }
  return {
    weights: sol.weights,
    r2: ssTot > 0 ? 1 - ssRes / ssTot : NaN,
    rmseBp: Math.sqrt(ssRes / nObs) * 1e4,
    nObs,
    startIdx,
    feasible: true,
  };
}

// ---------------------------------------------------------------------------
// Simulated-path frontier (the HW upgrade flagged in the header).
//
// The historical-covariance frontier above uses ~30 monthly changes for the
// 120M pillar; this block instead evaluates the objective over the simulated
// 5Y forecast. For each pillar k it projects the k-month tenor forward along
// every HW path, takes the trailing k-month MA warm-started with the (k−1)
// historical k-tenor levels ending at the as-of month, and pools the
// (path × forecast-month) yields. The mean and covariance of those LEVELS
// drive the mean-variance frontier ("maximize the average yield with the
// lowest variance in the yield"), and the same machinery in margin space
// (RP credit − client rate) drives the IB tracking frontier.
// ---------------------------------------------------------------------------

/** Months optimised over: the forecast window is intentionally short — five
 *  years is as far as the rate paths are trusted to inform the blend. */
export const FORECAST_HORIZON_MONTHS = 60;

/** mulberry32: a tiny seeded PRNG so the frontier cloud is reproducible
 *  across renders (Math.random would reshuffle the scatter every paint). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Marsaglia-Tsang gamma(shape, 1) sample; shape >= 1 path only (alpha=1
 *  here gives the exponential, which is all the Dirichlet(1,...,1) needs). */
function gammaSample(rng: () => number, shape: number): number {
  if (shape < 1) {
    // Boost: gamma(shape) = gamma(shape+1) · U^{1/shape}.
    return gammaSample(rng, shape + 1) * Math.pow(rng(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      // Box-Muller normal.
      const u1 = Math.max(1e-12, rng());
      const u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** A Dirichlet(alpha,...,alpha) weight vector on the n-simplex (sums to 1). */
export function dirichletWeights(rng: () => number, n: number, alpha = 1): number[] {
  const g = new Array<number>(n);
  let s = 0;
  for (let i = 0; i < n; i++) {
    g[i] = gammaSample(rng, alpha);
    s += g[i];
  }
  if (s <= 0) return new Array<number>(n).fill(1 / n);
  return g.map((v) => v / s);
}

/** Mean of each row of a sample matrix (rows = variables, cols = samples). */
export function sampleMean(samples: ReadonlyArray<ReadonlyArray<number>>): number[] {
  return samples.map((row) => {
    let s = 0;
    for (const v of row) s += v;
    return row.length ? s / row.length : NaN;
  });
}

/** Sample covariance matrix (n−1 denominator) of a sample matrix. */
export function sampleCovariance(samples: ReadonlyArray<ReadonlyArray<number>>): number[][] {
  const p = samples.length;
  const n = p ? samples[0].length : 0;
  const mu = sampleMean(samples);
  const cov: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  if (n < 2) return cov;
  for (let i = 0; i < p; i++) {
    for (let j = i; j < p; j++) {
      let acc = 0;
      for (let t = 0; t < n; t++) acc += (samples[i][t] - mu[i]) * (samples[j][t] - mu[j]);
      const v = acc / (n - 1);
      cov[i][j] = v;
      cov[j][i] = v;
    }
  }
  return cov;
}

export interface SimPillarYields {
  pillars: number[];
  /** samples[i] = pooled forecast yields for pillar i, length nPaths·horizon. */
  samples: number[][];
  nSamples: number;
}

/**
 * Pooled simulated forecast yields per pillar: project the k-tenor along each
 * HW path (`projectHWToTenor`), warm-start the trailing k-month MA with the
 * (k−1) historical k-tenor levels ending at `asOfIdx`, and collect the first
 * `horizonMonths` MA values from every path. Decimal per annum, aligned to a
 * fixed (path, month) grid so a separate target series (the client rate) lines
 * up sample-for-sample for the IB joint covariance.
 */
export function simulatedPillarYieldSamples(
  history: RateHistory,
  pillars: ReadonlyArray<number>,
  sim: HWSimulationResult,
  curve: ZeroCurve,
  asOfIdx: number,
  horizonMonths: number = FORECAST_HORIZON_MONTHS,
): SimPillarYields {
  const nSteps = sim.times.length;
  const horizon = Math.min(horizonMonths, nSteps);
  const nPaths = sim.nPaths;
  const samples: number[][] = [];
  for (const k of pillars) {
    const kk = Math.max(1, Math.round(k));
    const warm = kk - 1;
    if (asOfIdx - warm + 1 < 0) {
      throw new Error(
        `simulatedPillarYieldSamples: ${kk}M pillar needs ${warm} warmup months but the ` +
          `history reaches only index ${asOfIdx}`,
      );
    }
    const termSeries = history.sofrTermSeries(kk);
    const proj = projectHWToTenor(sim, curve, kk / 12);
    const pooled = new Array<number>(nPaths * horizon);
    const ser = new Float64Array(warm + horizon);
    for (let i = 0; i < warm; i++) ser[i] = termSeries[asOfIdx - warm + 1 + i];
    for (let p = 0; p < nPaths; p++) {
      for (let j = 0; j < horizon; j++) ser[warm + j] = proj[p][j];
      const ma = trailingMASeries(ser, kk);
      for (let j = 0; j < horizon; j++) pooled[p * horizon + j] = ma[warm + j];
    }
    samples.push(pooled);
  }
  return { pillars: [...pillars], samples, nSamples: nPaths * horizon };
}

/**
 * Pooled simulated forecast client-rate D(t) on the SAME (path, month) grid as
 * `simulatedPillarYieldSamples`: the β S-curve with Nerlove partial adjustment
 * run forward on each HW 1M path, seeded at the as-of target level D(0) =
 * β(r₀)·r₀ from the history's 1M tenor. Decimal per annum.
 */
export function simulatedClientRateSamples(
  history: RateHistory,
  sim: HWSimulationResult,
  curve: ZeroCurve,
  sCurve: BetaSCurveParams,
  asOfIdx: number,
  horizonMonths: number = FORECAST_HORIZON_MONTHS,
): number[] {
  const nSteps = sim.times.length;
  const horizon = Math.min(horizonMonths, nSteps);
  const nPaths = sim.nPaths;
  const proj1m = projectHWToTenor(sim, curve, 1 / 12);
  const r0Pct = history.sofrTermRate(asOfIdx, 1) * 100;
  const dSeed = betaAtRate(r0Pct, sCurve) * r0Pct; // D(0) target, % pa
  const pooled = new Array<number>(nPaths * horizon);
  for (let p = 0; p < nPaths; p++) {
    let dPrev = dSeed;
    for (let j = 0; j < horizon; j++) {
      const rPct = proj1m[p][j] * 100;
      const target = betaAtRate(rPct, sCurve) * rPct;
      const dNow = Math.max(0, dPrev + sCurve.lambda * (target - dPrev));
      pooled[p * horizon + j] = dNow / 100;
      dPrev = dNow;
    }
  }
  return pooled;
}

// ---------------------------------------------------------------------------
// Mean-variance frontier: cloud + four curated corners.
// ---------------------------------------------------------------------------

export interface FrontierPoint {
  weights: number[];
  /** Return coordinate (decimal): blend yield, or mean franchise margin. */
  ret: number;
  /** Risk coordinate (decimal): standard deviation of the return. */
  vol: number;
  walMonths: number;
  /** (ret − rf) / vol; rf = 0 in margin space. */
  sharpe: number;
}

export interface FrontierResult {
  cloud: FrontierPoint[];
  minVol: FrontierPoint;
  maxRet: FrontierPoint;
  maxSharpe: FrontierPoint;
  /** Min-risk blend that uses the full liquidity duration (WAL = cap). */
  liqCapped: FrontierPoint;
  feasible: boolean;
}

const FRONTIER_SAMPLES = 600;

/** Min-variance face QP: min w'Qw − c'w s.t. sum(w)=1, w>=0, plus an optional
 *  WAL=target equality row. A ridge regularizes the near-singular Σ of highly
 *  correlated MA series. Returns null when infeasible. */
function minVarBlend(
  pillars: ReadonlyArray<number>,
  Q: ReadonlyArray<ReadonlyArray<number>>,
  c: ReadonlyArray<number>,
  walTarget: number | null,
): number[] | null {
  const p = pillars.length;
  let trace = 0;
  for (let i = 0; i < p; i++) trace += Q[i][i];
  const ridge = 1e-9 * (trace / Math.max(1, p));
  const Qr = Q.map((row, i) => row.map((v, j) => (i === j ? v + ridge : v)));
  const A: number[][] = [new Array<number>(p).fill(1)];
  const b: number[] = [1];
  if (walTarget !== null) {
    A.push(pillars.map((k) => pillarWalMonths(k)));
    b.push(walTarget);
  }
  const sol = solveConstrainedQP(Qr, c, A, b);
  return sol.feasible ? sol.weights : null;
}

/** Max linear objective max w·g s.t. sum(w)=1, w>=0, WAL<=cap. The LP optimum
 *  is a single pillar (if its WAL<=cap) or a WAL=cap pair; enumerate both. */
function maxLinearUnderWalCap(
  pillars: ReadonlyArray<number>,
  g: ReadonlyArray<number>,
  walCap: number,
): number[] | null {
  const p = pillars.length;
  const wal = pillars.map((k) => pillarWalMonths(k));
  let bestW: number[] | null = null;
  let bestV = -Infinity;
  for (let i = 0; i < p; i++) {
    if (wal[i] <= walCap + 1e-9 && g[i] > bestV) {
      const w = new Array<number>(p).fill(0);
      w[i] = 1;
      bestW = w;
      bestV = g[i];
    }
  }
  for (let i = 0; i < p; i++) {
    for (let j = i + 1; j < p; j++) {
      const denom = wal[i] - wal[j];
      if (Math.abs(denom) < 1e-12) continue;
      const wi = (walCap - wal[j]) / denom;
      if (wi < -1e-9 || wi > 1 + 1e-9) continue;
      const wiC = Math.min(1, Math.max(0, wi));
      const v = wiC * g[i] + (1 - wiC) * g[j];
      if (v > bestV) {
        const w = new Array<number>(p).fill(0);
        w[i] = wiC;
        w[j] = 1 - wiC;
        bestW = w;
        bestV = v;
      }
    }
  }
  return bestW;
}

/**
 * Mean-variance frontier in yield space: cloud of feasible Dirichlet samples
 * (WAL <= cap) plus four curated corners — min-vol, max-yield, max-Sharpe
 * (rf = the overnight new-money yield), and the liquidity-capped min-vol blend
 * at WAL = cap. The max-Sharpe corner is the optimum over the cloud and the
 * other corners, so it is at least as good as every plotted sample.
 */
export function buildFrontier(
  pillars: ReadonlyArray<number>,
  mu: ReadonlyArray<number>,
  cov: ReadonlyArray<ReadonlyArray<number>>,
  walCapMonths: number,
  rfRate: number,
  opts: { nSamples?: number; seed?: number } = {},
): FrontierResult {
  const p = pillars.length;
  const point = (w: number[]): FrontierPoint => {
    let ret = 0;
    let varAcc = 0;
    for (let i = 0; i < p; i++) {
      ret += w[i] * mu[i];
      for (let j = 0; j < p; j++) varAcc += w[i] * cov[i][j] * w[j];
    }
    const vol = Math.sqrt(Math.max(0, varAcc));
    return {
      weights: w,
      ret,
      vol,
      walMonths: blendWalMonths(pillars, w),
      sharpe: vol > 0 ? (ret - rfRate) / vol : 0,
    };
  };

  const rng = mulberry32(opts.seed ?? 0x5eed);
  const nSamples = opts.nSamples ?? FRONTIER_SAMPLES;
  const cloud: FrontierPoint[] = [];
  for (let s = 0; s < nSamples; s++) {
    const w = dirichletWeights(rng, p);
    if (blendWalMonths(pillars, w) <= walCapMonths + 1e-9) cloud.push(point(w));
  }

  // Corners. Min-vol: unconstrained-WAL; bind to WAL=cap if it overshoots.
  const zeros = new Array<number>(p).fill(0);
  let minVolW = minVarBlend(pillars, cov, zeros, null);
  if (minVolW && blendWalMonths(pillars, minVolW) > walCapMonths + 1e-9) {
    minVolW = minVarBlend(pillars, cov, zeros, walCapMonths);
  }
  const maxRetW = maxLinearUnderWalCap(pillars, mu, walCapMonths);
  const liqCappedW = minVarBlend(pillars, cov, zeros, walCapMonths) ?? maxRetW;

  const feasible = Boolean(minVolW && maxRetW);
  const corners = [minVolW, maxRetW, liqCappedW].filter(Boolean) as number[][];
  const candidates = [...cloud, ...corners.map(point)];
  let maxSharpe = candidates[0] ?? point(new Array<number>(p).fill(1 / p));
  for (const c of candidates) if (c.sharpe > maxSharpe.sharpe) maxSharpe = c;

  const fallback = maxSharpe;
  return {
    cloud,
    minVol: minVolW ? point(minVolW) : fallback,
    maxRet: maxRetW ? point(maxRetW) : fallback,
    maxSharpe,
    liqCapped: liqCappedW ? point(liqCappedW) : fallback,
    feasible,
  };
}

/**
 * Mean-variance frontier in margin space for the IB book. The "return" is the
 * mean franchise margin m = Σ w_k Y_k − D; its variance is
 * w'Σ_YY w − 2 w·Σ_YD + Var(D), closed-form in w from the joint covariance.
 * Min-margin-vol minimizes that variance (the tracking-error minimizer, a QP
 * with linear term c = 2 Σ_YD); max-margin maximizes w·μ_Y. rf = 0 because the
 * margin is already a spread.
 */
export function buildMarginFrontier(
  pillars: ReadonlyArray<number>,
  muY: ReadonlyArray<number>,
  covYY: ReadonlyArray<ReadonlyArray<number>>,
  covYD: ReadonlyArray<number>,
  varD: number,
  muD: number,
  walCapMonths: number,
  opts: { nSamples?: number; seed?: number } = {},
): FrontierResult {
  const p = pillars.length;
  const point = (w: number[]): FrontierPoint => {
    let ret = -muD;
    let varAcc = varD;
    for (let i = 0; i < p; i++) {
      ret += w[i] * muY[i];
      varAcc -= 2 * w[i] * covYD[i];
      for (let j = 0; j < p; j++) varAcc += w[i] * covYY[i][j] * w[j];
    }
    const vol = Math.sqrt(Math.max(0, varAcc));
    return {
      weights: w,
      ret,
      vol,
      walMonths: blendWalMonths(pillars, w),
      sharpe: vol > 0 ? ret / vol : 0,
    };
  };

  const rng = mulberry32(opts.seed ?? 0x1b);
  const nSamples = opts.nSamples ?? FRONTIER_SAMPLES;
  const cloud: FrontierPoint[] = [];
  for (let s = 0; s < nSamples; s++) {
    const w = dirichletWeights(rng, p);
    if (blendWalMonths(pillars, w) <= walCapMonths + 1e-9) cloud.push(point(w));
  }

  // Min-margin-variance QP: Q = 2 Σ_YY, c = 2 Σ_YD (the −2 w·Σ_YD term).
  const Q2 = covYY.map((row) => row.map((v) => 2 * v));
  const c2 = covYD.map((v) => 2 * v);
  let minVolW = minVarBlend(pillars, Q2, c2, null);
  if (minVolW && blendWalMonths(pillars, minVolW) > walCapMonths + 1e-9) {
    minVolW = minVarBlend(pillars, Q2, c2, walCapMonths);
  }
  const maxRetW = maxLinearUnderWalCap(pillars, muY, walCapMonths);
  const liqCappedW = minVarBlend(pillars, Q2, c2, walCapMonths) ?? maxRetW;

  const feasible = Boolean(minVolW && maxRetW);
  const corners = [minVolW, maxRetW, liqCappedW].filter(Boolean) as number[][];
  const candidates = [...cloud, ...corners.map(point)];
  let maxSharpe = candidates[0] ?? point(new Array<number>(p).fill(1 / p));
  for (const c of candidates) if (c.sharpe > maxSharpe.sharpe) maxSharpe = c;

  const fallback = maxSharpe;
  return {
    cloud,
    minVol: minVolW ? point(minVolW) : fallback,
    maxRet: maxRetW ? point(maxRetW) : fallback,
    maxSharpe,
    liqCapped: liqCappedW ? point(liqCappedW) : fallback,
    feasible,
  };
}

/**
 * NNLS regression of a pooled target series on pooled pillar-yield samples:
 * min ||Yw − t||² s.t. w >= 0, sum(w) = 1. The simulated-path analogue of
 * `regressOnPillars` (same QP, samples instead of a history window). For the
 * IB book the target is the simulated client rate, so the weights are the
 * Σβ = 100% tracking portfolio.
 */
export function regressOnSamples(
  pillarSamples: ReadonlyArray<ReadonlyArray<number>>,
  target: ReadonlyArray<number>,
): PillarRegression {
  const p = pillarSamples.length;
  if (p === 0) throw new Error("regressOnSamples: no pillars");
  const n = target.length;
  if (pillarSamples.some((s) => s.length !== n)) {
    throw new Error("regressOnSamples: sample lengths must match the target");
  }
  const Q: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const c = new Array<number>(p).fill(0);
  for (let t = 0; t < n; t++) {
    for (let i = 0; i < p; i++) {
      c[i] += pillarSamples[i][t] * target[t];
      for (let j = i; j < p; j++) Q[i][j] += pillarSamples[i][t] * pillarSamples[j][t];
    }
  }
  for (let i = 0; i < p; i++) for (let j = 0; j < i; j++) Q[i][j] = Q[j][i];

  const sol = solveConstrainedQP(Q, c, [new Array<number>(p).fill(1)], [1]);
  if (!sol.feasible) {
    return { weights: sol.weights, r2: NaN, rmseBp: NaN, nObs: n, startIdx: 0, feasible: false };
  }
  let tMean = 0;
  for (let t = 0; t < n; t++) tMean += target[t];
  tMean /= n;
  let ssRes = 0;
  let ssTot = 0;
  for (let t = 0; t < n; t++) {
    let fit = 0;
    for (let i = 0; i < p; i++) fit += sol.weights[i] * pillarSamples[i][t];
    ssRes += (target[t] - fit) ** 2;
    ssTot += (target[t] - tMean) ** 2;
  }
  return {
    weights: sol.weights,
    r2: ssTot > 0 ? 1 - ssRes / ssTot : NaN,
    rmseBp: Math.sqrt(ssRes / n) * 1e4,
    nObs: n,
    startIdx: 0,
    feasible: true,
  };
}

export interface RealizedRpPerformance {
  /** ISO month labels over the valid window (longest pillar's first complete
   *  window through the as-of month). */
  months: string[];
  /** Realized RP yield/margin level series over the window, decimal per annum. */
  series: number[];
  /** Mean realized level over the window, decimal. */
  meanDec: number;
  /** Realized volatility: annualized std of monthly changes, bp. */
  volBp: number;
  startIdx: number;
  nObs: number;
}

/**
 * Backtest of a fixed RP weight vector on the real rate history: the realized
 * yield is Σ w_k · pillarYieldLevelSeries(k) (the same blend the frontier
 * picks). Subtract the synthesized client rate to get the realized franchise
 * MARGIN — for the Non-IB book pass clientRate = null (the rate is zero so the
 * margin equals the yield); for the IB book pass `synthesizeClientRateSeries`.
 * Mean is the level average; realized vol is the annualized std of monthly
 * changes (the standard practitioner convention, not the cycle-dominated level
 * dispersion). Valid from the longest pillar's first complete window.
 */
export function historicalRpPerformance(
  history: RateHistory,
  pillars: ReadonlyArray<number>,
  weights: ReadonlyArray<number>,
  asOfIdx: number,
  clientRate?: ReadonlyArray<number> | null,
): RealizedRpPerformance {
  if (asOfIdx >= history.months.length) {
    throw new Error(`historicalRpPerformance: asOfIdx ${asOfIdx} out of range`);
  }
  const rpYield = fittedClientRateSeries(history, pillars, weights);
  let startIdx = 0;
  for (const k of pillars) startIdx = Math.max(startIdx, firstCompleteIndex(k));
  const months: string[] = [];
  const series: number[] = [];
  for (let t = startIdx; t <= asOfIdx; t++) {
    months.push(history.months[t]);
    series.push(rpYield[t] - (clientRate ? clientRate[t] : 0));
  }
  const n = series.length;
  const meanDec = n ? series.reduce((s, v) => s + v, 0) / n : NaN;
  let volBp = NaN;
  if (n >= 2) {
    const ch: number[] = [];
    for (let t = 1; t < n; t++) ch.push(series[t] - series[t - 1]);
    const cm = ch.reduce((s, v) => s + v, 0) / ch.length;
    let acc = 0;
    for (const d of ch) acc += (d - cm) ** 2;
    volBp = Math.sqrt((acc / (ch.length - 1)) * 12) * 1e4;
  }
  return { months, series, meanDec, volBp, startIdx, nObs: n };
}

export interface FlowLadderRow {
  tenorMonths: number;
  /** Share of each month's new-money reinvestment placed at this bullet tenor. */
  share: number;
}

/**
 * Flow view of a blended RP: the steady-state new-money mix. A k-month pillar
 * is k equal rolling bullets, so 1/k of its w_k stock matures and reinvests
 * each month — the monthly reinvestment into tenor k is w_k/k. Normalised,
 * the bullet ladder share at tenor k is (w_k/k) / Σ_j (w_j/j). Shorter pillars
 * draw proportionally more new money because they turn over faster; this is
 * "what new money buys", distinct from the stock runoff.
 */
export function newMoneyFlowLadder(
  pillars: ReadonlyArray<number>,
  weights: ReadonlyArray<number>,
): FlowLadderRow[] {
  if (pillars.length !== weights.length) {
    throw new Error("newMoneyFlowLadder: pillars and weights length mismatch");
  }
  const raw = pillars.map((k, i) => weights[i] / Math.max(1, k));
  const tot = raw.reduce((s, v) => s + v, 0);
  return pillars.map((k, i) => ({ tenorMonths: k, share: tot > 0 ? raw[i] / tot : 0 }));
}
