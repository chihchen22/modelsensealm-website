/**
 * Hull-White 1F Monte Carlo simulator — TypeScript port of `research/simulate_hw.py`.
 *
 * Exact transition for X under shifted-Gaussian HW with antithetic pairing
 * and multiplicative martingale correction (Glasserman Sec 4.5).
 */

import type { ZeroCurve } from "./bootstrap";
import { PCG32 } from "./random";
import { bFunction } from "./hwPricing";

export interface HWSimulationResult {
  seed: bigint;
  a: number;
  sigma: number;
  nPaths: number;
  horizonYears: number;
  dtYears: number;
  times: Float64Array;
  /** Latent factor X(t) per path per step. Shape: [nPaths][nSteps]. */
  XPaths: Float64Array[];
  /** Short rate r(t) per path per step. Shape: [nPaths][nSteps]. */
  rPaths: Float64Array[];
  dfMarket: Float64Array;
  dfSimulated: Float64Array;
  rawErrorBps: Float64Array;
  corrected: boolean;
}

export interface HWSimulationOptions {
  horizonYears?: number;
  dtYears?: number;
  nPairs?: number;
  seed?: bigint | number;
  applyCorrection?: boolean;
}

export function simulateHW(
  curve: ZeroCurve,
  a: number,
  sigma: number,
  options: HWSimulationOptions = {},
): HWSimulationResult {
  const horizonYears = options.horizonYears ?? 30.0;
  const dtYears = options.dtYears ?? 1 / 12;
  const nPairs = options.nPairs ?? 250;
  const seed = options.seed ?? 20250930n;
  const applyCorrection = options.applyCorrection ?? true;

  const rng = new PCG32(typeof seed === "bigint" ? seed : BigInt(seed));
  const nSteps = Math.round(horizonYears / dtYears);
  const nPaths = 2 * nPairs;
  const times = new Float64Array(nSteps);
  for (let k = 0; k < nSteps; k++) times[k] = (k + 1) * dtYears;

  // Precompute initial-curve forward rates at each step f^M(0, t_k).
  // Use f(t) = -log(P(0, t+dt)/P(0, t)) / dt evaluated at the step grid.
  const dfFull = new Float64Array(nSteps + 1);
  dfFull[0] = curve.discountFactor(0);
  for (let k = 0; k < nSteps; k++) dfFull[k + 1] = curve.discountFactor(times[k]);
  const fwdAtStep = new Float64Array(nSteps);
  for (let k = 0; k < nSteps; k++) {
    fwdAtStep[k] = -Math.log(dfFull[k + 1] / dfFull[k]) / dtYears;
  }

  const decay = Math.exp(-a * dtYears);
  const stdX = sigma * Math.sqrt((1.0 - Math.exp(-2.0 * a * dtYears)) / (2.0 * a));

  // Pre-allocate per-path Float64 arrays for X and r.
  const XPaths: Float64Array[] = new Array(nPaths);
  const rPaths: Float64Array[] = new Array(nPaths);
  for (let p = 0; p < nPaths; p++) {
    XPaths[p] = new Float64Array(nSteps);
    rPaths[p] = new Float64Array(nSteps);
  }

  const xCurr = new Float64Array(nPaths);
  const rUncorrCurr = new Float64Array(nPaths);
  const f0 = fwdAtStep[0];
  for (let p = 0; p < nPaths; p++) rUncorrCurr[p] = f0;
  const dPath = new Float64Array(nPaths);
  for (let p = 0; p < nPaths; p++) dPath[p] = 1.0;

  const dfSimulated = new Float64Array(nSteps);
  const rawErrorBps = new Float64Array(nSteps);
  const dfMarket = new Float64Array(nSteps);
  for (let k = 0; k < nSteps; k++) dfMarket[k] = curve.discountFactor(times[k]);

  for (let k = 0; k < nSteps; k++) {
    let sumDUncorr = 0;
    const dUncorrStep = new Float64Array(nPaths);

    for (let pair = 0; pair < nPairs; pair++) {
      const z = rng.nextNormal();
      const shock = stdX * z;

      // Path index for the +Z branch.
      const idx1 = pair * 2;
      const xNext1 = xCurr[idx1] * decay + shock;
      const rNext1 = fwdAtStep[k] + xNext1;
      dUncorrStep[idx1] = Math.exp(-0.5 * (rUncorrCurr[idx1] + rNext1) * dtYears);
      sumDUncorr += dPath[idx1] * dUncorrStep[idx1];
      xCurr[idx1] = xNext1;
      rUncorrCurr[idx1] = rNext1;

      // Antithetic -Z branch.
      const idx2 = pair * 2 + 1;
      const xNext2 = xCurr[idx2] * decay - shock;
      const rNext2 = fwdAtStep[k] + xNext2;
      dUncorrStep[idx2] = Math.exp(-0.5 * (rUncorrCurr[idx2] + rNext2) * dtYears);
      sumDUncorr += dPath[idx2] * dUncorrStep[idx2];
      xCurr[idx2] = xNext2;
      rUncorrCurr[idx2] = rNext2;
    }

    const eDUncorr = sumDUncorr / nPaths;
    rawErrorBps[k] = (eDUncorr - dfMarket[k]) * 1e4;

    let sumDCorr = 0;
    const correction = applyCorrection ? dfMarket[k] / eDUncorr : 1.0;
    for (let p = 0; p < nPaths; p++) {
      dPath[p] = dPath[p] * dUncorrStep[p] * correction;
      sumDCorr += dPath[p];
      XPaths[p][k] = xCurr[p];
      rPaths[p][k] = rUncorrCurr[p];
    }
    dfSimulated[k] = sumDCorr / nPaths;
  }

  return {
    seed: typeof seed === "bigint" ? seed : BigInt(seed),
    a,
    sigma,
    nPaths,
    horizonYears,
    dtYears,
    times,
    XPaths,
    rPaths,
    dfMarket,
    dfSimulated,
    rawErrorBps,
    corrected: applyCorrection,
  };
}

const ACT_360_ANNUAL = 365 / 360;

/**
 * Single-state HW forward/par-swap rate at time t for a latent factor X(t).
 *
 * Mirrors `projectHWToTenor` operation-for-operation for one (X, t, tenor) so
 * the reusable StochasticRatePath can reconstruct any tenor analytically
 * instead of averaging realized 1M spots. Kept separate from projectHWToTenor
 * (rather than refactoring it) to leave the verified research path bit-stable;
 * a unit test cross-checks numerical equality between the two.
 *
 * Convention (matches ZeroCurve.forwardSwapRate / projectHWToTenor):
 *   - τ < 1Y: simple-compounded forward.
 *   - τ ≥ 1Y, integer: par swap on annual ACT/360 fixed schedule.
 * P(t,T) = (P^M(0,T)/P^M(0,t)) · exp(-B(t,T)·X(t) - V(t,T)),
 *   V(t,T) = (σ²/4a)(1 - e^{-2at}) B(t,T)².
 */
export function hwForwardRate(
  X: number,
  a: number,
  sigma: number,
  curve: ZeroCurve,
  t: number,
  tenorYears: number,
): number {
  const tau = tenorYears;
  const expDecay = 1.0 - Math.exp(-2.0 * a * t);

  // Sub-1Y: simple-compounded forward.
  if (tau <= 1.0 + 1e-9) {
    const Btau = bFunction(a, tau);
    const ratio = curve.discountFactor(t + tau) / curve.discountFactor(t);
    const varTerm = ((sigma * sigma) / (4.0 * a)) * expDecay * Btau * Btau;
    const logP = Math.log(ratio) - Btau * X - varTerm;
    const Ptau = Math.exp(logP);
    return (1.0 / Ptau - 1.0) / tau;
  }

  // ≥ 1Y: forward par swap rate on annual ACT/360 schedule.
  const n = Math.round(tau);
  let annuity = 0;
  let Pn = 1.0;
  for (let k = 1; k <= n; k++) {
    const B = bFunction(a, k);
    const V = ((sigma * sigma) / (4.0 * a)) * expDecay * B * B;
    const logP = Math.log(curve.discountFactor(t + k) / curve.discountFactor(t)) - B * X - V;
    const Pk = Math.exp(logP);
    annuity += ACT_360_ANNUAL * Pk;
    Pn = Pk;
  }
  return (1.0 - Pn) / annuity;
}

/**
 * Project HW simulation paths to forward swap rate S(t, t+tau) for each
 * path/step via the analytical bond price formula.
 *
 * Convention (matches ZeroCurve.forwardSwapRate / bgmPricing.buildSwap):
 *   - τ < 1Y: simple-compounded forward (single-payment OIS).
 *   - τ ≥ 1Y, integer: par swap rate on annual ACT/360 fixed schedule:
 *       S(t, t+n) = (P(t,t) - P(t,t+n)) / Σ_k (365/360) · P(t, t+k)
 * Bond prices P(t, t+k) come from HW analytic formula:
 *   P(t,T) = (P^M(0,T)/P^M(0,t)) · exp(-B(t,T) · X(t) - V(t,T))
 *   V(t,T) = (σ²/4a)(1 - e^{-2at}) B(t,T)²
 */
export function projectHWToTenor(
  sim: HWSimulationResult,
  curve: ZeroCurve,
  tenorYears: number,
): Float64Array[] {
  const { a, sigma, times, XPaths, nPaths } = sim;
  const tau = tenorYears;
  const nSteps = times.length;

  // Sub-1Y: simple-compounded forward — original code path.
  if (tau <= 1.0 + 1e-9) {
    const Btau = bFunction(a, tau);
    const ratio = new Float64Array(nSteps);
    const varTerm = new Float64Array(nSteps);
    for (let k = 0; k < nSteps; k++) {
      const t = times[k];
      ratio[k] = curve.discountFactor(t + tau) / curve.discountFactor(t);
      varTerm[k] = ((sigma * sigma) / (4.0 * a)) * (1.0 - Math.exp(-2.0 * a * t)) * Btau * Btau;
    }
    const out: Float64Array[] = new Array(nPaths);
    for (let p = 0; p < nPaths; p++) {
      const path = new Float64Array(nSteps);
      for (let k = 0; k < nSteps; k++) {
        const logP = Math.log(ratio[k]) - Btau * XPaths[p][k] - varTerm[k];
        const Ptau = Math.exp(logP);
        path[k] = (1.0 / Ptau - 1.0) / tau;
      }
      out[p] = path;
    }
    return out;
  }

  // ≥ 1Y: forward par swap rate on annual schedule.
  const n = Math.round(tau);
  // Precompute B(τ_k) and per-step ratio/varTerm tables for each k=1..n.
  const Bk = new Float64Array(n + 1);
  for (let k = 1; k <= n; k++) Bk[k] = bFunction(a, k);
  const expDecay = new Float64Array(nSteps);
  for (let s = 0; s < nSteps; s++) {
    expDecay[s] = 1.0 - Math.exp(-2.0 * a * times[s]);
  }
  // ratioKS[k][s] = P^M(0, t_s + k) / P^M(0, t_s).
  const ratioKS: Float64Array[] = new Array(n + 1);
  for (let k = 1; k <= n; k++) {
    const r = new Float64Array(nSteps);
    for (let s = 0; s < nSteps; s++) {
      r[s] = curve.discountFactor(times[s] + k) / curve.discountFactor(times[s]);
    }
    ratioKS[k] = r;
  }
  const out: Float64Array[] = new Array(nPaths);
  for (let p = 0; p < nPaths; p++) {
    const path = new Float64Array(nSteps);
    for (let s = 0; s < nSteps; s++) {
      const X = XPaths[p][s];
      // Compute P(t, t+k) for k = 1..n; build annuity and tail bond.
      let annuity = 0;
      let Pn = 1.0;
      for (let k = 1; k <= n; k++) {
        const B = Bk[k];
        const V = ((sigma * sigma) / (4.0 * a)) * expDecay[s] * B * B;
        const logP = Math.log(ratioKS[k][s]) - B * X - V;
        const Pk = Math.exp(logP);
        annuity += ACT_360_ANNUAL * Pk;
        Pn = Pk;
      }
      // P(t, t) = 1, so numerator = 1 - Pn.
      path[s] = (1.0 - Pn) / annuity;
    }
    out[p] = path;
  }
  return out;
}

export interface PathDFResult {
  /** Dcorr[p][k] = terminally-corrected money-market DF to time (k+1)·dt on path p. */
  Dcorr: Float64Array[];
  /** max|E_p[D_p(t_k)] − P^M(0,t_k)| across horizons, in bp (martingale check). */
  meanErrBp: number;
}

/**
 * Reconstruct per-path money-market discount factors from the HW short-rate
 * paths, with a terminal multiplicative correction so the cross-path mean DF
 * equals the market DF at every horizon (E_p[D_p(t_k)] = P^M(0, t_k)). Verified
 * path-by-path identical to the simulator's own incremental correction; the
 * companion of `projectHWToTenor` for discounting rather than forward rates.
 *
 * Trapezoidal money-market accrual: D ∝ Π exp(−½(r_{k-1}+r_k)·dt), seeded at the
 * instantaneous t=0 forward f^M(0, dt). Used by stochastic FTP / OAS discounting.
 */
export function reconstructPathDF(sim: HWSimulationResult, curve: ZeroCurve): PathDFResult {
  const P = sim.nPaths;
  const nSteps = sim.times.length;
  const dt = sim.dtYears;
  const f0 = -Math.log(curve.discountFactor(dt)) / dt;

  const U: Float64Array[] = new Array(P);
  for (let p = 0; p < P; p++) {
    const u = new Float64Array(nSteps);
    let cum = 1;
    let rPrev = f0;
    for (let k = 0; k < nSteps; k++) {
      const rk = sim.rPaths[p][k];
      cum *= Math.exp(-0.5 * (rPrev + rk) * dt);
      u[k] = cum;
      rPrev = rk;
    }
    U[p] = u;
  }

  const corr = new Float64Array(nSteps);
  for (let k = 0; k < nSteps; k++) {
    let mean = 0;
    for (let p = 0; p < P; p++) mean += U[p][k];
    mean /= P;
    if (mean < 1e-15) throw new Error(`reconstructPathDF: DF mean collapsed to zero at step ${k}`);
    corr[k] = curve.discountFactor(sim.times[k]) / mean;
  }

  const Dcorr: Float64Array[] = new Array(P);
  for (let p = 0; p < P; p++) {
    const d = new Float64Array(nSteps);
    for (let k = 0; k < nSteps; k++) d[k] = U[p][k] * corr[k];
    Dcorr[p] = d;
  }

  let maxErr = 0;
  for (let k = 0; k < nSteps; k++) {
    let mean = 0;
    for (let p = 0; p < P; p++) mean += Dcorr[p][k];
    mean /= P;
    maxErr = Math.max(maxErr, Math.abs(mean - curve.discountFactor(sim.times[k])) * 1e4);
  }
  return { Dcorr, meanErrBp: maxErr };
}
