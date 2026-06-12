/**
 * BGM/LMM Monte Carlo with Glasserman-Zhao log-coordinate state, optional
 * displaced-diffusion (shifted), and optional CEV exponent.
 *
 * State variable: ŷ_k = F_k + δ, evolved in log space. (β_cev, δ) = (1, 0)
 * recovers the pure lognormal LMM; β_cev=1 with δ>0 = shifted lognormal
 * (DD); β_cev<1 with any δ = shifted-CEV LMM.
 *
 * Under CEV the local lognormal vol on F̂ is F̂^(β_cev−1) · σ — i.e., the
 * lognormal LMM's σ_LN at F̂_0 stays the same, but as F̂ rises the
 * effective local F-vol decays as F̂^(β_cev−1) → 0. This dampens the upper
 * tail at long horizon and is what most fixed-income desks actually run.
 *
 * State equation (shifted-CEV LMM, spot-LIBOR measure):
 *   d ŷ_k = ŷ_k^β · σ_k · dW̃ + drift_k dt
 *   drift_k = ŷ_k^β · Σ_{j=m+1..k} G_j^CEV (σ_j · σ_k)
 *   G_j^CEV = dt · ŷ_j^β / (1 + dt · F_j)
 *
 * In log coordinates (Itô, with σ_loc = ŷ^(β−1) σ):
 *   d log ŷ_k = (μ_k_log − 0.5 σ_loc² ) dt + σ_loc · dW̃
 *   μ_k_log = ŷ_k^(β−1) · Σ_j G_j^CEV (σ_j · σ_k)
 *
 * β=1 collapses σ_loc ≡ σ and μ_k_log ≡ Σ G_j σ_j σ_k. The implementation
 * preserves bit-for-bit equivalence at β=1 by short-circuiting the
 * F̂^(β−1) prefactor and the F̂^β power inside G^CEV.
 *
 * The per-step numéraire ratio uses the *unshifted* simply-compounded
 * accrual 1/(1 + dt·F_m); same for the tenor projection that builds yields
 * from the alive-row of forwards. CEV and DD only enter the dynamics.
 *
 * References:
 *   - Glasserman, P. & Zhao, X. (2000). Arbitrage-free discretization of
 *     lognormal forward LIBOR and swap rate models.
 *   - Andersen, L. & Andreasen, J. (2002). Volatile volatilities (CEV LMM).
 *   - Joshi, M.S. & Rebonato, R. (2003). A displaced-diffusion stochastic
 *     volatility LIBOR market model.
 */

import type { ZeroCurve } from "./bootstrap";
import { PCG32 } from "./random";

// Defensive numerical guards — only fire on truly degenerate paths.
// Set wide enough that the calibrated lognormal LMM doesn't saturate in
// its extreme upper tail; we want the model to evolve freely and rely on
// log-domain arithmetic for stability. F = e^100 ≈ 2.7e43 is far beyond
// any plausible computation.
const LOG_F_FLOOR = -100;
const LOG_F_CEILING = 100;

// Backward-compatible names retained for callers that still pass them as
// options or read them off the result. The defaults are now sentinel values
// (effectively disabled) since the GZ scheme doesn't need a finite cap.
export const F_FLOOR = Math.exp(LOG_F_FLOOR);
export const F_CEILING_DEFAULT = Math.exp(LOG_F_CEILING);

export interface BGMSimulationResult {
  seed: bigint;
  a: number;
  b: number;
  c: number;
  d: number;
  beta: number;
  volScalar: number;
  displacement: number;
  cevBeta: number;
  nPaths: number;
  horizonYears: number;
  dtYears: number;
  nGrid: number;
  times: Float64Array;
  tenors: Float64Array;
  rates: Float64Array;
  dfMarket: Float64Array;
  dfSimulated: Float64Array;
  rawErrorBps: Float64Array;
  corrected: boolean;
  /** Number of evolutions where logF excursions hit the safety guard. Should be 0 in normal operation. */
  nCapFires: number;
  nFloorFires: number;
  nTotalEvolutions: number;
  fCeiling: number;
}

export interface BGMSimulationOptions {
  horizonYears?: number;
  dtYears?: number;
  nPairs?: number;
  seed?: bigint | number;
  savedTenors?: ReadonlyArray<number>;
  applyCorrection?: boolean;
  /** Ignored under the GZ scheme; retained for API compatibility. */
  fCeiling?: number;
}

const DEFAULT_SAVED_TENORS = [
  1 / 360, // 1D SOFR — overnight rate (simple-compounded forward, ≈ short rate)
  1 / 12,
  3 / 12,
  6 / 12,
  1.0,
  2.0,
  5.0,
  7.0,
  10.0,
  20.0,
  30.0,
];

/**
 * Shifted-CEV drift weight G_j^CEV = dt · F̂_j^β / (1 + dt · F_j) for the
 * shifted-CEV LMM drift. β=1 reduces to the DD form; β=1, δ=0 reduces to
 * the standard LMM form.
 *
 *   logFhat >> -log(dt):  numerator dominates; for β=1 G→1, for β<1 the
 *                         result decays as F̂^(β−1)
 *   logFhat moderate:      direct arithmetic
 *   logFhat very small:    F → −δ, 1+dt·F → 1−dt·δ, G ≈ dt·F̂^β / (1−dt·δ)
 */
function computeG(logFhat: number, delta: number, dt: number, cevBeta: number): number {
  if (logFhat > 30) {
    // 1 + dt·F ≈ dt·F. For β=1: G ≈ F̂/F = 1 + δ/F. For β<1: G ≈ F̂^β/F.
    const F = Math.exp(logFhat) - delta;
    if (cevBeta === 1.0) {
      return Math.exp(logFhat) / F;
    }
    return Math.exp(cevBeta * logFhat) / F;
  }
  const Fhat = Math.exp(logFhat);
  const F = Fhat - delta;
  const FhatPow = cevBeta === 1.0 ? Fhat : Math.pow(Fhat, cevBeta);
  return (dt * FhatPow) / (1.0 + dt * F);
}

/**
 * Local-vol prefactor F̂^(β−1) for shifted-CEV. β=1 returns 1 (short-circuit
 * preserves bit-for-bit DD behavior). For β<1 we floor logFhat at a moderate
 * value so the prefactor doesn't explode if a path's F̂ momentarily underflows
 * — the calibrated DD shift δ keeps F̂ ≥ ~δ in practice, but this guard makes
 * the simulator robust to extreme tails.
 */
const LOG_FHAT_FLOOR_FOR_VOL = -10; // F̂ ≈ 4.5e-5
function localVolPrefactor(logFhat: number, cevBeta: number): number {
  if (cevBeta === 1.0) return 1.0;
  const lf = Math.max(logFhat, LOG_FHAT_FLOOR_FOR_VOL);
  return Math.exp((cevBeta - 1.0) * lf);
}

/**
 * Numerically stable log(1 + dt·F) from log(F+δ).
 * For the per-step numéraire DF and the tenor projection we need *unshifted*
 * F, so this returns log(1 + dt·F) (not log(1 + dt·(F+δ))).
 */
function logOnePlusDtF(logFhat: number, delta: number, dt: number): number {
  if (logFhat > 30) {
    // 1 + dt·F ≈ dt·F = dt·(exp(logFhat) − δ) ≈ dt·exp(logFhat)
    // log(...) ≈ logFhat + log(dt) + log(1 − δ·exp(−logFhat))
    return logFhat + Math.log(dt) + Math.log1p(-delta * Math.exp(-logFhat));
  }
  const F = Math.exp(logFhat) - delta;
  return Math.log1p(dt * F);
}

export function getRate(
  res: BGMSimulationResult,
  path: number,
  step: number,
  tenorIdx: number,
): number {
  const nSteps = res.times.length;
  const nTenors = res.tenors.length;
  return res.rates[(path * nSteps + step) * nTenors + tenorIdx];
}

export function simulateBGM(
  curve: ZeroCurve,
  params: { a: number; b: number; c: number; d: number; beta: number; volScalar: number; displacement?: number; cevBeta?: number },
  options: BGMSimulationOptions = {},
): BGMSimulationResult {
  const { a, b, c, d, beta, volScalar } = params;
  const displacement = params.displacement ?? 0;
  const cevBeta = params.cevBeta ?? 1.0;
  const horizonYears = options.horizonYears ?? 30.0;
  const dtYears = options.dtYears ?? 1 / 12;
  const nPairs = options.nPairs ?? 250;
  const seed = options.seed ?? 20250930n;
  const applyCorrection = options.applyCorrection ?? true;
  const savedTenors = options.savedTenors ?? DEFAULT_SAVED_TENORS;

  const rng = new PCG32(typeof seed === "bigint" ? seed : BigInt(seed));
  const nSteps = Math.round(horizonYears / dtYears);
  const nGrid = nSteps;
  const nPaths = 2 * nPairs;
  const nTenors = savedTenors.length;

  const times = new Float64Array(nSteps);
  for (let k = 0; k < nSteps; k++) times[k] = (k + 1) * dtYears;
  const tenorsArr = new Float64Array(savedTenors);

  // Vol loadings (v1, v2) by time-to-maturity bucket.
  const V1 = new Float64Array(nGrid);
  const V2 = new Float64Array(nGrid);
  for (let idx = 0; idx < nGrid; idx++) {
    const tau = idx * dtYears;
    const sigma = volScalar * ((a + b * tau) * Math.exp(-c * tau) + d);
    V1[idx] = sigma * Math.cos(beta * tau);
    V2[idx] = sigma * Math.sin(beta * tau);
  }

  // Initial forward curve in LOG coordinates.
  const F_init = new Float64Array(nGrid);
  for (let k = 0; k < nGrid; k++) {
    const P1 = curve.discountFactor(k * dtYears);
    const P2 = curve.discountFactor((k + 1) * dtYears);
    F_init[k] = (P1 / P2 - 1.0) / dtYears;
  }
  // Log-state holds log(F + δ).
  const logF_init = new Float64Array(nGrid);
  for (let k = 0; k < nGrid; k++) logF_init[k] = Math.log(Math.max(F_init[k] + displacement, 1e-12));

  // Per-path state in log coordinates: logF[path * nGrid + k] = log F_k(t_m).
  const logF = new Float64Array(nPaths * nGrid);
  for (let p = 0; p < nPaths; p++) {
    for (let k = 0; k < nGrid; k++) logF[p * nGrid + k] = logF_init[k];
  }

  // Output tensor: flat [nPaths][nSteps][nTenors] in decimal yield.
  const rates = new Float64Array(nPaths * nSteps * nTenors);

  const dfMarket = new Float64Array(nSteps);
  for (let k = 0; k < nSteps; k++) dfMarket[k] = curve.discountFactor(times[k]);
  const dfSimulated = new Float64Array(nSteps);
  const rawErrorBps = new Float64Array(nSteps);
  const dPath = new Float64Array(nPaths);
  for (let p = 0; p < nPaths; p++) dPath[p] = 1.0;

  const sqrtDt = Math.sqrt(dtYears);
  let nCapFires = 0;
  let nFloorFires = 0;
  let nTotalEvolutions = 0;

  const tmpZ1 = new Float64Array(nPairs);
  const tmpZ2 = new Float64Array(nPairs);

  for (let m = 0; m < nSteps; m++) {
    // Project current alive-row of forwards into saved tenors at simulation time t_m.
    projectRowToTenors(logF, m, nPaths, nGrid, dtYears, displacement, tenorsArr, rates, m, nSteps, nTenors);

    // Per-step uncorrected discount factor 1 / (1 + dt · F_m). Numerically:
    // 1 / (1 + dt·F_m) = exp(-log(1 + dt·F_m)) = exp(-logOnePlusDtF(logFhat_m, δ, dt))
    let sumDUncorr = 0;
    const dStep = new Float64Array(nPaths);
    for (let p = 0; p < nPaths; p++) {
      const lf = logF[p * nGrid + m];
      dStep[p] = Math.exp(-logOnePlusDtF(lf, displacement, dtYears));
      sumDUncorr += dPath[p] * dStep[p];
    }
    const eDUncorr = sumDUncorr / nPaths;
    rawErrorBps[m] = (eDUncorr - dfMarket[m]) * 1e4;
    const correction = applyCorrection ? dfMarket[m] / eDUncorr : 1.0;
    let sumDCorr = 0;
    for (let p = 0; p < nPaths; p++) {
      dPath[p] = dPath[p] * dStep[p] * correction;
      sumDCorr += dPath[p];
    }
    dfSimulated[m] = sumDCorr / nPaths;

    if (m >= nSteps - 1) break;

    const nAlive = nGrid - (m + 1);
    if (nAlive === 0) continue;

    for (let i = 0; i < nPairs; i++) {
      tmpZ1[i] = rng.nextNormal();
      tmpZ2[i] = rng.nextNormal();
    }

    for (let p = 0; p < nPaths; p++) {
      const pair = p >>> 1;
      const sign = p & 1 ? -1 : 1;
      const Z1 = sign * tmpZ1[pair];
      const Z2 = sign * tmpZ2[pair];

      // Predictor: log-Euler advance with drift evaluated at F(t_m).
      // Under shifted-CEV the σ in log-space is F̂^(β−1) σ; the drift is
      // F̂^(β−1) Σ G^CEV σ_j σ_k. β=1 short-circuits both prefactors to 1
      // for bit-for-bit DD equivalence.
      let s1 = 0;
      let s2 = 0;
      const logF_pred = new Float64Array(nAlive);
      for (let kIdx = 0; kIdx < nAlive; kIdx++) {
        const k = m + 1 + kIdx;
        const v1k = V1[kIdx + 1];
        const v2k = V2[kIdx + 1];
        const volSq = v1k * v1k + v2k * v2k;

        const lfk = logF[p * nGrid + k];
        const Gk = computeG(lfk, displacement, dtYears, cevBeta);
        s1 += Gk * v1k;
        s2 += Gk * v2k;
        const muRaw = s1 * v1k + s2 * v2k; // CEV-weighted drift sum

        const prefactor = localVolPrefactor(lfk, cevBeta);
        const muPred = prefactor * muRaw;
        const sigLocSq = prefactor * prefactor * volSq;

        const diff = sqrtDt * prefactor * (v1k * Z1 + v2k * Z2);
        const dlog = (muPred - 0.5 * sigLocSq) * dtYears + diff;
        logF_pred[kIdx] = clampLogF(lfk + dlog);
      }

      // Corrector: drift averaged across F(t_m) and F̃(t_{m+1}). Same shocks.
      let s1pred = 0;
      let s2pred = 0;
      let s1corr = 0;
      let s2corr = 0;
      for (let kIdx = 0; kIdx < nAlive; kIdx++) {
        const k = m + 1 + kIdx;
        const v1k = V1[kIdx + 1];
        const v2k = V2[kIdx + 1];
        const volSq = v1k * v1k + v2k * v2k;

        const lfk = logF[p * nGrid + k];
        const Gk_pred = computeG(lfk, displacement, dtYears, cevBeta);
        s1pred += Gk_pred * v1k;
        s2pred += Gk_pred * v2k;
        const muRawP = s1pred * v1k + s2pred * v2k;

        const Gk_corr = computeG(logF_pred[kIdx], displacement, dtYears, cevBeta);
        s1corr += Gk_corr * v1k;
        s2corr += Gk_corr * v2k;
        const muRawC = s1corr * v1k + s2corr * v2k;

        // Average prefactor at predictor / corrector (same shocks too).
        const prefP = localVolPrefactor(lfk, cevBeta);
        const prefC = localVolPrefactor(logF_pred[kIdx], cevBeta);
        const prefBar = 0.5 * (prefP + prefC);
        const muP = prefP * muRawP;
        const muC = prefC * muRawC;
        const muBar = 0.5 * (muP + muC);
        const sigLocSqBar = prefBar * prefBar * volSq;

        const diff = sqrtDt * prefBar * (v1k * Z1 + v2k * Z2);
        const dlog = (muBar - 0.5 * sigLocSqBar) * dtYears + diff;
        const lfFinal = lfk + dlog;
        if (lfFinal > LOG_F_CEILING) nCapFires++;
        if (lfFinal < LOG_F_FLOOR) nFloorFires++;
        nTotalEvolutions++;
        logF[p * nGrid + k] = clampLogF(lfFinal);
      }
    }
  }

  return {
    seed: typeof seed === "bigint" ? seed : BigInt(seed),
    a, b, c, d, beta, volScalar, displacement, cevBeta,
    nPaths,
    horizonYears,
    dtYears,
    nGrid,
    times,
    tenors: tenorsArr,
    rates,
    dfMarket,
    dfSimulated,
    rawErrorBps,
    corrected: applyCorrection,
    nCapFires,
    nFloorFires,
    nTotalEvolutions,
    fCeiling: F_CEILING_DEFAULT,
  };
}

function clampLogF(lf: number): number {
  if (lf > LOG_F_CEILING) return LOG_F_CEILING;
  if (lf < LOG_F_FLOOR) return LOG_F_FLOOR;
  return lf;
}

/**
 * Project current alive-row of forwards into saved tenors at simulation time t_m.
 * Operates entirely in log coordinates so any forward magnitude is handled
 * without numerical loss.
 */
const ACT_360_ANNUAL = 365 / 360;

function projectRowToTenors(
  logF: Float64Array,
  m: number,
  nPaths: number,
  nGrid: number,
  dt: number,
  delta: number,
  savedTenors: Float64Array,
  out: Float64Array,
  outStep: number,
  outNSteps: number,
  nTenors: number,
): void {
  const nAlive = nGrid - m;
  const nT = savedTenors.length;
  // Convention switch:
  //   τ < 1Y  →  simple-compounded forward (single-payment OIS / SOFR fix).
  //   τ ≥ 1Y, integer  →  par swap rate, annual ACT/360 fixed schedule.
  // isSwap[ti] selects the branch.
  const isSwap = new Array<boolean>(nT);
  const nFull = new Int32Array(nT);
  const residual = new Float64Array(nT);
  const swapYearsN = new Int32Array(nT);
  const stepsPerYear = Math.round(1 / dt); // 12 for dt = 1/12
  for (let ti = 0; ti < nT; ti++) {
    const tau = savedTenors[ti];
    if (tau > 1.0 + 1e-9) {
      isSwap[ti] = true;
      swapYearsN[ti] = Math.round(tau);
      nFull[ti] = 0;
      residual[ti] = 0;
    } else {
      isSwap[ti] = false;
      const nf = Math.floor(tau / dt);
      nFull[ti] = nf;
      residual[ti] = tau - nf * dt;
    }
  }

  for (let p = 0; p < nPaths; p++) {
    // Cumulative log discount: cumLog[j] = Σ_{i=0..j-1} log(1 + dt · F_{m+i}).
    // Uses *unshifted* F (the actual numéraire); the log-state is log(F+δ),
    // so logOnePlusDtF subtracts δ internally.
    const cumLog = new Float64Array(nAlive + 1);
    cumLog[0] = 0;
    for (let j = 0; j < nAlive; j++) {
      const lfk = logF[p * nGrid + m + j];
      cumLog[j + 1] = cumLog[j] + logOnePlusDtF(lfk, delta, dt);
    }
    const lfLast = logF[p * nGrid + nGrid - 1];
    const tailLog = logOnePlusDtF(lfLast, delta, dt); // log(1 + dt·F_last)

    // Log of P(t, t + k*dt). Past grid edge, extrapolate using lfLast.
    const logDiscAt = (j: number): number => {
      if (j <= nAlive) return cumLog[j];
      return cumLog[nAlive] + tailLog * (j - nAlive);
    };

    for (let ti = 0; ti < nT; ti++) {
      if (isSwap[ti]) {
        // Annual fixed schedule: payments at integer-year offsets k = 1..n.
        const n = swapYearsN[ti];
        let annuity = 0;
        let logPlast = 0; // log of P(t, t + n)
        for (let k = 1; k <= n; k++) {
          const lp = logDiscAt(k * stepsPerYear);
          const Pk = Math.exp(-lp);
          annuity += ACT_360_ANNUAL * Pk;
          if (k === n) logPlast = lp;
        }
        const Pn = Math.exp(-logPlast);
        out[(p * outNSteps + outStep) * nTenors + ti] = (1.0 - Pn) / annuity;
        continue;
      }

      // Simple-compounded forward branch (sub-1Y).
      const tau = savedTenors[ti];
      const nf = nFull[ti];
      const res = residual[ti];
      let logTotal: number;
      if (nf > nAlive) {
        const baseLog = cumLog[nAlive];
        const extra = tailLog * (nf - nAlive);
        logTotal = baseLog + extra;
        if (res > 1e-9) logTotal += logOnePlusDtF(lfLast, delta, res);
      } else {
        logTotal = cumLog[nf];
        if (res > 1e-9) {
          const lfNext = nf < nAlive ? logF[p * nGrid + m + nf] : lfLast;
          logTotal += logOnePlusDtF(lfNext, delta, res);
        }
      }
      const yld = Math.expm1(logTotal) / tau;
      out[(p * outNSteps + outStep) * nTenors + ti] = yld;
    }
  }
}
