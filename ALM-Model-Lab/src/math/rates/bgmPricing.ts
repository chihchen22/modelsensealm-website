/**
 * BGM/LMM Rebonato 2-factor parametric volatility and swaption pricing.
 *
 * TypeScript port of `research/bgm_pricing.py`.
 *
 * Volatility structure (Rebonato 2002):
 *   sigma_i(t) = volScalar * [(a + b * (tau_i - t)) * exp(-c * (tau_i - t)) + d]
 * with 2-factor rotation:
 *   v1_i(t) = sigma_i(t) * cos(beta * (tau_i - t))
 *   v2_i(t) = sigma_i(t) * sin(beta * (tau_i - t))
 *
 * Correlation between forwards i and j is time-homogeneous:
 *   rho_{ij} = cos(beta * (tau_i - tau_j)).
 *
 * ATM-swaption normal vol via Rebonato approximation:
 *   sigma_S(T_alpha, T_beta)^2 * T_alpha ~=
 *       sum_{i,j} w_i * w_j * F_i(0) * F_j(0) / S(0)^2 * I_{ij}
 *
 * with I_{ij} = integral_0^{T_alpha} sigma_i(t) * sigma_j(t) * rho_{ij} dt
 * computed in closed form here (4-term expansion of (A + Bv)*exp(-cv) + d).
 */

import type { ZeroCurve } from "./bootstrap";

// ---------------------------------------------------------------------------
// Closed-form helpers for the Rebonato vol-product integral
// ---------------------------------------------------------------------------

const SMALL_K_THRESHOLD = 1e-12;

/** Integral of exp(-k v) from 0 to T. */
function expInt0(T: number, k: number): number {
  if (Math.abs(k) < SMALL_K_THRESHOLD) return T;
  return (1.0 - Math.exp(-k * T)) / k;
}

/** Integral of v * exp(-k v) from 0 to T. */
function expInt1(T: number, k: number): number {
  if (Math.abs(k) < SMALL_K_THRESHOLD) return 0.5 * T * T;
  return (1.0 - Math.exp(-k * T) * (1.0 + k * T)) / (k * k);
}

/** Integral of v^2 * exp(-k v) from 0 to T. */
function expInt2(T: number, k: number): number {
  if (Math.abs(k) < SMALL_K_THRESHOLD) return (T * T * T) / 3.0;
  const kT = k * T;
  return (2.0 - Math.exp(-k * T) * (2.0 + 2.0 * kT + kT * kT)) / (k ** 3);
}

/** Closed form of integral_0^{T_alpha} sigma_i(t) sigma_j(t) dt. */
export function volProductIntegral(
  deltaI: number,
  deltaJ: number,
  TAlpha: number,
  a: number,
  b: number,
  c: number,
  d: number,
  volScalar: number,
): number {
  const Ai = (a + b * deltaI) * Math.exp(-c * deltaI);
  const Bi = b * Math.exp(-c * deltaI);
  const Aj = (a + b * deltaJ) * Math.exp(-c * deltaJ);
  const Bj = b * Math.exp(-c * deltaJ);

  const e0_2c = expInt0(TAlpha, 2.0 * c);
  const e1_2c = expInt1(TAlpha, 2.0 * c);
  const e2_2c = expInt2(TAlpha, 2.0 * c);
  const e0_c = expInt0(TAlpha, c);
  const e1_c = expInt1(TAlpha, c);

  const part1 = Ai * Aj * e0_2c + (Ai * Bj + Aj * Bi) * e1_2c + Bi * Bj * e2_2c;
  const part2 = d * (Ai * e0_c + Bi * e1_c);
  const part3 = d * (Aj * e0_c + Bj * e1_c);
  const part4 = d * d * TAlpha;
  return volScalar * volScalar * (part1 + part2 + part3 + part4);
}

// ---------------------------------------------------------------------------
// Swap structure
// ---------------------------------------------------------------------------

export interface SwapStructure {
  TAlpha: number;
  TBeta: number;
  paymentDates: number[];
  forwardDates: number[];
  forwardTaus: number[];
  F0: number[];
  dfPay: number[];
  weights: number[];
  S0: number;
}

export function buildSwap(curve: ZeroCurve, TAlpha: number, TBeta: number): SwapStructure {
  const n = Math.round(TBeta - TAlpha);
  if (Math.abs(TBeta - TAlpha - n) > 1e-6) {
    throw new Error(`non-integer tenor ${TBeta - TAlpha}`);
  }
  const paymentDates: number[] = [];
  const forwardDates: number[] = [];
  for (let k = 1; k <= n; k++) paymentDates.push(TAlpha + k);
  for (let k = 0; k < n; k++) forwardDates.push(TAlpha + k);
  // ACT/360 annual fraction.
  const forwardTaus = new Array<number>(n).fill(365 / 360);

  const dfPay = paymentDates.map((t) => curve.discountFactor(t));
  const dfFwdStart = forwardDates.map((t) => curve.discountFactor(t));
  const F0 = forwardTaus.map((tau, i) => (dfFwdStart[i] / dfPay[i] - 1.0) / tau);

  const annuity = forwardTaus.reduce((s, tau, i) => s + tau * dfPay[i], 0);
  const dfTAlpha = curve.discountFactor(TAlpha);
  const dfTBeta = curve.discountFactor(TBeta);
  const S0 = (dfTAlpha - dfTBeta) / annuity;
  const weights = forwardTaus.map((tau, i) => (tau * dfPay[i]) / annuity);

  return {
    TAlpha,
    TBeta,
    paymentDates,
    forwardDates,
    forwardTaus,
    F0,
    dfPay,
    weights,
    S0,
  };
}

// ---------------------------------------------------------------------------
// Rebonato ATM-swaption normal vol
// ---------------------------------------------------------------------------

export interface RebonatoParams {
  a: number;
  b: number;
  c: number;
  d: number;
  beta: number;
  volScalar: number;
  /** Displacement δ for shifted-lognormal LMM. δ=0 recovers standard LMM. */
  displacement?: number;
  /**
   * CEV exponent β_cev for shifted-CEV LMM dynamics: dF̂ = F̂^β_cev · σ · dW.
   * β_cev=1 recovers shifted lognormal LMM (DD).
   * β_cev<1 dampens upper-tail growth: as F̂ rises, local F-vol scales as
   * F̂^(β_cev−1) → 0, so high-rate paths compound less aggressively.
   */
  cevBeta?: number;
}

export function rebonatoSwaptionNormalVol(swap: SwapStructure, params: RebonatoParams): number {
  const { TAlpha, F0, weights, forwardDates } = swap;
  const { a, b, c, d, beta, volScalar } = params;
  const disp = params.displacement ?? 0;
  const cevBeta = params.cevBeta ?? 1.0;
  const n = F0.length;
  // tauOffsets[i] = forward_dates_i - T_alpha (>= 0). Distinct from
  // displacement δ and from CEV exponent β_cev.
  const tauOffsets = forwardDates.map((t) => t - TAlpha);

  // Shifted-CEV Rebonato freeze approximation. ATM Bachelier vol from
  // local-vol of S at S=Ŝ_0 under CEV dynamics on F̂_i = F_i + δ:
  //   σ_N(ATM) ≈ √( Σ_{ij} w_i w_j F̂_i^β F̂_j^β ρ_{ij} I_{ij} / T_α )
  // β=1 collapses to the DD freeze (Σ w_i w_j F̂_i F̂_j ρ I).
  // δ=0, β=1 collapses to the original lognormal Rebonato.
  // Pre-compute F̂_i^β. β=1 short-circuits to F̂_i exactly so the path is
  // bit-identical to the lognormal DD case (Math.pow(x, 1) is not bit-equal
  // to x in JS due to exp/log path).
  const Fpow = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    Fpow[i] = cevBeta === 1.0 ? F0[i] + disp : Math.pow(F0[i] + disp, cevBeta);
  }
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const rho = Math.cos(beta * (tauOffsets[i] - tauOffsets[j]));
      const Iij = volProductIntegral(tauOffsets[i], tauOffsets[j], TAlpha, a, b, c, d, volScalar);
      varSum += weights[i] * weights[j] * Fpow[i] * Fpow[j] * rho * Iij;
    }
  }
  // σ_N is the absolute (Bachelier) vol; under CEV freeze the (S+δ)^β
  // factors are absorbed into Σ F̂_i^β F̂_j^β.
  // For β=1, preserve the prior FP path (Ŝ · σ_LN) so the LM solver lands
  // at the exact same redundancy-manifold point as the pre-CEV calibrator.
  if (cevBeta === 1.0) {
    const Shat = swap.S0 + disp;
    const varS = varSum / (Shat * Shat);
    const sigmaLN = Math.sqrt(Math.max(varS, 0) / TAlpha);
    return Shat * sigmaLN;
  }
  return Math.sqrt(Math.max(varSum, 0) / TAlpha);
}

export function rebonatoSwaptionNormalVolGrid(
  swaps: ReadonlyArray<SwapStructure>,
  params: RebonatoParams,
): number[] {
  return swaps.map((s) => rebonatoSwaptionNormalVol(s, params));
}

// ---------------------------------------------------------------------------
// Rebonato ATM-caplet normal vol (cross-fit onto the cap surface)
// ---------------------------------------------------------------------------

/**
 * ATM caplet normal vol under the same shifted-CEV freeze as the swaption
 * approximation. A caplet is the one-forward degenerate case: the forward
 * fixing at T has tau-offset 0, rho_ii = 1, so the variance integral is
 * volProductIntegral(0, 0, T) and the freeze anchor is F̂ = F + δ:
 *
 *   σ_N(T) ≈ F̂^β_cev · sqrt( I(T) / T ).
 *
 * Exactly consistent with rebonatoSwaptionNormalVol on a one-period swap
 * (weights = [1], S0 = F0). The lab consumes cap quotes as single-caplet vols
 * at the cap expiry (the same simplification hwCalibrate uses), so this
 * overlays apples-to-apples on the cap ATM column.
 */
export function rebonatoCapletNormalVol(
  forwardRate: number,
  expiry: number,
  params: RebonatoParams,
): number {
  if (expiry <= 0) return 0;
  const { a, b, c, d, volScalar } = params;
  const disp = params.displacement ?? 0;
  const cevBeta = params.cevBeta ?? 1.0;
  const I = volProductIntegral(0, 0, expiry, a, b, c, d, volScalar);
  const Fhat = forwardRate + disp;
  const Fpow = cevBeta === 1.0 ? Fhat : Math.pow(Fhat, cevBeta);
  return Fpow * Math.sqrt(Math.max(I, 0) / expiry);
}
