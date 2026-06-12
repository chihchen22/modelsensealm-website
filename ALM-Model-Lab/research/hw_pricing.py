"""Hull-White 1-factor analytical pricing.

Closed forms for the shifted-Gaussian HW1F model:

    r(t) = f^M(0, t) + X(t),     dX = -a X dt + sigma dW

The simply-compounded forward rate F(t, T, T+tau_u) = (P(t,T)/P(t,T+tau_u) - 1)/tau_u
has, under the T+tau_u-forward measure, dynamics that yield a closed-form
Bachelier-equivalent normal vol used for caplet calibration.

Derivation (Andersen-Piterbarg Vol II Sec 10.1.6, freezing the F coefficient
in the lognormal-to-normal vol conversion):

    sigma_N^2(T, tau_u) * T = sigma^2 * B(tau_u)^2 * (1 - exp(-2 a T))/(2 a)
                                 * ((1 + F * tau_u) / tau_u)^2

with B(tau) = (1 - exp(-a tau)) / a.

Closed forms here also include analytical bond prices used by the simulator
to reconstruct yields from the latent X factor.
"""

from __future__ import annotations

import math
import numpy as np


# ---------------------------------------------------------------------------
# Building blocks
# ---------------------------------------------------------------------------

def b_function(a: float, tau: float | np.ndarray) -> float | np.ndarray:
    """B(tau) = (1 - exp(-a*tau)) / a.

    Time-homogeneous in HW: depends only on (T - t), not on t separately.
    The tau -> 0 limit is handled by series expansion to avoid 0/0.
    """
    a_arr = np.asarray(a, dtype=float)
    tau_arr = np.asarray(tau, dtype=float)
    # Small-a expansion: B ~ tau - 0.5 a tau^2 + ...
    if np.isscalar(a) and abs(a) < 1e-10:
        return tau_arr - 0.5 * a_arr * tau_arr * tau_arr
    return (1.0 - np.exp(-a_arr * tau_arr)) / a_arr


def hw_bond_price(
    P0_t: float,
    P0_T: float,
    a: float,
    sigma: float,
    t: float,
    tau: float,
    x_t: float,
) -> float:
    """Reconstructed P(t, t+tau) under HW given the latent factor X(t).

    Brigo-Mercurio Eq 3.39-3.40 in shifted form:

        P(t, T) = (P^M(0, T) / P^M(0, t)) * exp(-B(tau) * X(t) - V(t, tau))

    with V(t, tau) = (sigma^2 / (4 a)) * (1 - exp(-2 a t)) * B(tau)^2.
    """
    B = float(b_function(a, tau))
    V = (sigma * sigma / (4.0 * a)) * (1.0 - math.exp(-2.0 * a * t)) * B * B
    return (P0_T / P0_t) * math.exp(-B * x_t - V)


# ---------------------------------------------------------------------------
# Caplet normal vol under HW (calibration target)
# ---------------------------------------------------------------------------

def hw_caplet_normal_vol(
    a: float,
    sigma: float,
    expiry: float,
    underlying_tau: float,
    forward_rate: float,
) -> float:
    """Model normal (Bachelier) vol of a caplet under HW.

    Parameters
    ----------
    a, sigma : float
        HW mean-reversion and volatility parameters.
    expiry : float
        Caplet expiry T in years.
    underlying_tau : float
        Length of the rate's accrual period tau_u in years (typical 0.25 for 3M SOFR).
    forward_rate : float
        Initial simply-compounded forward F(0, T, T+tau_u) (decimal).

    Returns
    -------
    float
        Implied Bachelier normal vol of F (decimal).
    """
    if expiry <= 0.0:
        return 0.0
    B_u = float(b_function(a, underlying_tau))
    # Variance contribution from sigma * dW integrated over [0, T] times the
    # rate-to-bond-vol conversion factor ((1+F*tau_u)/tau_u)^2.
    integrated = sigma * sigma * (1.0 - math.exp(-2.0 * a * expiry)) / (2.0 * a)
    coef = ((1.0 + forward_rate * underlying_tau) / underlying_tau) ** 2
    sigma_n_sq_T = integrated * (B_u * B_u) * coef
    return math.sqrt(max(sigma_n_sq_T, 0.0) / expiry)


def hw_caplet_normal_vol_vec(
    a: float,
    sigma: float,
    expiries: np.ndarray,
    underlying_tau: float,
    forwards: np.ndarray,
) -> np.ndarray:
    """Vectorised caplet normal vol over arrays of expiries and forwards."""
    expiries = np.asarray(expiries, dtype=float)
    forwards = np.asarray(forwards, dtype=float)
    B_u = float(b_function(a, underlying_tau))
    integrated = sigma * sigma * (1.0 - np.exp(-2.0 * a * expiries)) / (2.0 * a)
    coef = ((1.0 + forwards * underlying_tau) / underlying_tau) ** 2
    sigma_n_sq_T = integrated * (B_u * B_u) * coef
    return np.sqrt(np.maximum(sigma_n_sq_T, 0.0) / np.where(expiries > 0, expiries, 1.0))


# ---------------------------------------------------------------------------
# Bachelier caplet price (used for sanity / pricing in run reports)
# ---------------------------------------------------------------------------

def bachelier_caplet_price(
    forward: float,
    strike: float,
    expiry: float,
    underlying_tau: float,
    df_pay: float,
    sigma_n: float,
) -> float:
    """Bachelier (normal) caplet price.

    Pay-off: tau_u * max(F - K, 0) at T + tau_u; discounted by df_pay = DF(0, T+tau_u).
    """
    from math import sqrt, exp, pi
    from statistics import NormalDist

    if expiry <= 0.0 or sigma_n <= 0.0:
        return underlying_tau * df_pay * max(forward - strike, 0.0)
    sd = sigma_n * sqrt(expiry)
    d = (forward - strike) / sd
    nd = NormalDist().cdf(d)
    pdf_d = exp(-0.5 * d * d) / sqrt(2.0 * pi)
    return underlying_tau * df_pay * ((forward - strike) * nd + sd * pdf_d)


if __name__ == "__main__":
    # Smoke test: known-good a=0.05, sigma=0.01 should produce HW caplet normal vols
    # of order 80-120 bps for SOFR-like 3.6% forwards across 1-10Y expiries.
    a, sigma = 0.05, 0.01
    tau_u = 0.25
    F = 0.036
    print(f"HW pricing smoke test: a={a}, sigma={sigma}, F={F}, tau_u={tau_u}")
    for T in (1.0, 2.0, 3.0, 5.0, 10.0, 15.0):
        v = hw_caplet_normal_vol(a, sigma, T, tau_u, F)
        print(f"  T={T:5.1f}y  sigma_N={v*1e4:7.2f} bp")
