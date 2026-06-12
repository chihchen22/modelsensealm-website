/**
 * Hull-White 1-factor analytical pricing — TypeScript port of `research/hw_pricing.py`.
 *
 * Closed forms for the shifted-Gaussian HW1F model:
 *
 *   r(t) = f^M(0, t) + X(t),     dX = -a X dt + sigma dW.
 *
 * Bachelier-equivalent normal vol of a caplet (Andersen-Piterbarg Vol II Sec 10.1.6):
 *
 *   sigma_N(T, tau_u)^2 * T = sigma^2 * B(tau_u)^2 * (1 - exp(-2 a T))/(2 a)
 *                              * ((1 + F * tau_u) / tau_u)^2
 *
 * with B(tau) = (1 - exp(-a tau)) / a.
 */

import type { ZeroCurve } from "./bootstrap";
import { buildSwap } from "./bgmPricing";

const SMALL_A_THRESHOLD = 1e-10;

/** B(tau) = (1 - exp(-a*tau)) / a, with small-a expansion. */
export function bFunction(a: number, tau: number): number {
  if (Math.abs(a) < SMALL_A_THRESHOLD) {
    return tau - 0.5 * a * tau * tau;
  }
  return (1.0 - Math.exp(-a * tau)) / a;
}

/**
 * Reconstructed P(t, t+tau) under HW given the latent factor X(t).
 *
 * Brigo-Mercurio Eq 3.39-3.40 in shifted form:
 *   P(t, T) = (P^M(0, T) / P^M(0, t)) * exp(-B(tau) * X(t) - V(t, tau))
 * with V(t, tau) = (sigma^2 / (4 a)) * (1 - exp(-2 a t)) * B(tau)^2.
 */
export function hwBondPrice(
  P0_t: number,
  P0_T: number,
  a: number,
  sigma: number,
  t: number,
  tau: number,
  xT: number,
): number {
  const B = bFunction(a, tau);
  const V = (sigma * sigma / (4.0 * a)) * (1.0 - Math.exp(-2.0 * a * t)) * B * B;
  return (P0_T / P0_t) * Math.exp(-B * xT - V);
}

/**
 * Model normal (Bachelier) vol of a caplet under HW.
 *
 * @param a HW mean-reversion.
 * @param sigma HW volatility.
 * @param expiry Caplet expiry T in years.
 * @param underlyingTau Length of rate accrual period tau_u in years.
 * @param forwardRate Initial simply-compounded forward F(0, T, T+tau_u).
 */
export function hwCapletNormalVol(
  a: number,
  sigma: number,
  expiry: number,
  underlyingTau: number,
  forwardRate: number,
): number {
  if (expiry <= 0) return 0;
  const Bu = bFunction(a, underlyingTau);
  const integrated = (sigma * sigma * (1.0 - Math.exp(-2.0 * a * expiry))) / (2.0 * a);
  const coef = ((1.0 + forwardRate * underlyingTau) / underlyingTau) ** 2;
  const sigmaNSqT = integrated * (Bu * Bu) * coef;
  return Math.sqrt(Math.max(sigmaNSqT, 0) / expiry);
}

/**
 * ATM swaption normal (Bachelier) vol under HW1F — Gaussian-factor freeze.
 *
 * At expiry T_alpha bond prices are P(T_alpha, T_k) = A_k exp(-B(T_k - T_alpha) X),
 * so the par swap rate is a smooth function of the single factor. Linearising
 * at X = 0 with forward bond prices P_k ≈ P(0, T_k) / P(0, T_alpha):
 *
 *   dS/dX = [ B(T_beta - T_alpha) P_beta A + (1 - P_beta) Σ_k τ_k B(T_k - T_alpha) P_k ] / A²
 *   σ_N² T_alpha = (dS/dX)² σ² (1 - e^{-2 a T_alpha}) / (2a)
 *
 * The one-period limit reproduces hwCapletNormalVol exactly (same freeze:
 * dS/dX collapses to B(τ)(1 + S τ_s)/τ_s). Swap schedule conventions (annual
 * ACT/360) come from buildSwap so the result is directly comparable to the
 * quoted ATM normal vols and the BGM fit.
 */
export function hwSwaptionNormalVol(
  curve: ZeroCurve,
  a: number,
  sigma: number,
  TAlpha: number,
  TBeta: number,
): number {
  if (TAlpha <= 0) return 0;
  const swap = buildSwap(curve, TAlpha, TBeta);
  const dfA = curve.discountFactor(TAlpha);
  // Bond prices as seen from T_alpha (X = 0 freeze).
  const pFwd = swap.paymentDates.map((t) => curve.discountFactor(t) / dfA);
  const annuity = swap.forwardTaus.reduce((s, tau, i) => s + tau * pFwd[i], 0);
  const pBeta = pFwd[pFwd.length - 1];
  const dNum = bFunction(a, TBeta - TAlpha) * pBeta;
  const dAnn = swap.forwardTaus.reduce(
    (s, tau, i) => s + tau * bFunction(a, swap.paymentDates[i] - TAlpha) * pFwd[i],
    0,
  );
  const dSdX = (dNum * annuity + (1.0 - pBeta) * dAnn) / (annuity * annuity);
  const integrated =
    Math.abs(a) < SMALL_A_THRESHOLD
      ? sigma * sigma * TAlpha
      : (sigma * sigma * (1.0 - Math.exp(-2.0 * a * TAlpha))) / (2.0 * a);
  return Math.abs(dSdX) * Math.sqrt(integrated / TAlpha);
}

/** Vectorised over arrays of expiries and forwards (parallel arrays). */
export function hwCapletNormalVolVec(
  a: number,
  sigma: number,
  expiries: ArrayLike<number>,
  underlyingTau: number,
  forwards: ArrayLike<number>,
): number[] {
  const out = new Array<number>(expiries.length);
  for (let i = 0; i < expiries.length; i++) {
    out[i] = hwCapletNormalVol(a, sigma, expiries[i], underlyingTau, forwards[i]);
  }
  return out;
}
