"""BGM/LMM Rebonato 2-factor parametric volatility and swaption pricing.

Volatility structure (Rebonato 2002, *Modern Pricing of Interest-Rate Derivatives*):

    sigma_i(t) = volScalar * [(a + b * (tau_i - t)) * exp(-c * (tau_i - t)) + d]

with 2-factor rotation:

    v1_i(t) = sigma_i(t) * cos(beta * (tau_i - t))
    v2_i(t) = sigma_i(t) * sin(beta * (tau_i - t))

Correlation between forwards i and j is time-homogeneous:

    rho_{ij} = cos(beta * (tau_i - tau_j)).

ATM-swaption normal vol via the Rebonato approximation:

    sigma_S(T_alpha, T_beta)^2 * T_alpha ~=
        sum_{i,j} w_i * w_j * F_i(0) * F_j(0) / S(0)^2 * I_{ij}

where I_{ij} = integral_0^{T_alpha} sigma_i(t) * sigma_j(t) * rho_{ij} dt,
      w_i are swap-rate weights derived from the initial discount curve,
      S(0) is the par swap rate.

The integral I_{ij} is computed in closed form here so the calibration loop
runs in seconds, not minutes.

References
----------
- Rebonato 2002 *Modern Pricing of Interest-Rate Derivatives* Sec 13-15.
- Andersen-Piterbarg Vol II Sec 14.4 (Rebonato approximation).
- Brigo-Mercurio Sec 6.7.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
import os

import numpy as np

from bootstrap import ZeroCurve


# ---------------------------------------------------------------------------
# Closed-form helpers for the Rebonato vol integral
# ---------------------------------------------------------------------------

def _exp_int_0(T: float, k: float) -> float:
    """Integral of exp(-k v) from 0 to T."""
    if abs(k) < 1e-12:
        return T
    return (1.0 - math.exp(-k * T)) / k


def _exp_int_1(T: float, k: float) -> float:
    """Integral of v * exp(-k v) from 0 to T."""
    if abs(k) < 1e-12:
        return 0.5 * T * T
    return (1.0 - math.exp(-k * T) * (1.0 + k * T)) / (k * k)


def _exp_int_2(T: float, k: float) -> float:
    """Integral of v^2 * exp(-k v) from 0 to T."""
    if abs(k) < 1e-12:
        return T * T * T / 3.0
    kT = k * T
    return (2.0 - math.exp(-k * T) * (2.0 + 2.0 * kT + kT * kT)) / (k ** 3)


def vol_product_integral(
    delta_i: float,
    delta_j: float,
    T_alpha: float,
    a: float,
    b: float,
    c: float,
    d: float,
    vol_scalar: float,
) -> float:
    """Closed form of integral_0^{T_alpha} sigma_i(t) sigma_j(t) dt.

    delta_i, delta_j : tau_i - T_alpha, tau_j - T_alpha (both >= 0).
    """
    # Substitute v = T_alpha - t so the lower limit at t = 0 becomes
    # v = T_alpha and upper at t = T_alpha becomes v = 0. Reverse limits and
    # absorb a sign; the integrand becomes f(delta_i + v) f(delta_j + v).
    Ai = (a + b * delta_i) * math.exp(-c * delta_i)
    Bi = b * math.exp(-c * delta_i)
    Aj = (a + b * delta_j) * math.exp(-c * delta_j)
    Bj = b * math.exp(-c * delta_j)

    # Expand the product:
    #   (A_i + B_i v)(A_j + B_j v) * exp(-2 c v)
    # + d (A_i + B_i v) exp(-c v)
    # + d (A_j + B_j v) exp(-c v)
    # + d^2
    e0_2c = _exp_int_0(T_alpha, 2.0 * c)
    e1_2c = _exp_int_1(T_alpha, 2.0 * c)
    e2_2c = _exp_int_2(T_alpha, 2.0 * c)
    e0_c = _exp_int_0(T_alpha, c)
    e1_c = _exp_int_1(T_alpha, c)

    part1 = Ai * Aj * e0_2c + (Ai * Bj + Aj * Bi) * e1_2c + Bi * Bj * e2_2c
    part2 = d * (Ai * e0_c + Bi * e1_c)
    part3 = d * (Aj * e0_c + Bj * e1_c)
    part4 = d * d * T_alpha
    return (vol_scalar ** 2) * (part1 + part2 + part3 + part4)


# ---------------------------------------------------------------------------
# Swap structure helpers
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SwapStructure:
    """Annual fixed-leg swap on [T_alpha, T_beta] under SOFR conventions."""
    T_alpha: float                  # expiry / first reset
    T_beta: float                   # final payment
    payment_dates: np.ndarray       # T_alpha + 1, ..., T_beta
    forward_dates: np.ndarray       # reset dates for each constituent forward
    forward_taus: np.ndarray        # accrual fraction (~1.0 ACT/360 = 365/360)
    F0: np.ndarray                  # initial simply-compounded forwards
    df_pay: np.ndarray              # DF(0, payment date)
    weights: np.ndarray             # swap-rate weights w_i
    S0: float                       # par swap rate from initial curve


def build_swap(curve: ZeroCurve, T_alpha: float, T_beta: float) -> SwapStructure:
    """Build an annual-fixed swap structure on [T_alpha, T_beta]."""
    n = int(round(T_beta - T_alpha))
    if abs((T_beta - T_alpha) - n) > 1e-6:
        raise ValueError(f"non-integer tenor {T_beta - T_alpha}")
    payment = np.array([T_alpha + k for k in range(1, n + 1)], dtype=float)
    forward = np.array([T_alpha + k for k in range(0, n)], dtype=float)
    # ACT/360 accrual; one-year period = 365/360. For annual payments this is
    # a constant.
    taus = np.full(n, 365.0 / 360.0)

    df_pay = np.array([float(curve.discount_factor(t)) for t in payment])
    df_fwd_start = np.array([float(curve.discount_factor(t)) for t in forward])
    F0 = (df_fwd_start / df_pay - 1.0) / taus

    annuity = float(np.sum(taus * df_pay))
    df_T_alpha = float(curve.discount_factor(T_alpha))
    df_T_beta = float(curve.discount_factor(T_beta))
    S0 = (df_T_alpha - df_T_beta) / annuity

    weights = (taus * df_pay) / annuity

    return SwapStructure(
        T_alpha=T_alpha,
        T_beta=T_beta,
        payment_dates=payment,
        forward_dates=forward,
        forward_taus=taus,
        F0=F0,
        df_pay=df_pay,
        weights=weights,
        S0=S0,
    )


# ---------------------------------------------------------------------------
# Rebonato ATM-swaption normal vol
# ---------------------------------------------------------------------------

def rebonato_swaption_normal_vol(
    swap: SwapStructure,
    a: float,
    b: float,
    c: float,
    d: float,
    beta: float,
    vol_scalar: float,
    displacement: float = 0.0,
    cev_beta: float = 1.0,
) -> float:
    """Model normal vol of ATM swaption on `swap` under shifted-CEV Rebonato 2F.

    (cev_beta, displacement) = (1, 0) reproduces the standard lognormal LMM.
    cev_beta=1 with δ>0 reproduces the shifted-lognormal LMM (DD).
    cev_beta<1 selects the shifted-CEV LMM and dampens the upper tail.

    Freeze ATM-Bachelier approximation:
        σ_N(ATM) ≈ √(Σ_{ij} w_i w_j F̂_i^β · F̂_j^β · ρ_{ij} · I_{ij} / T_α)

    where F̂_i = F_i + δ. β=1 short-circuits to the equivalent
    (Ŝ · σ_LN_swap) form for FP-path stability vs the prior code.
    """
    T_alpha = swap.T_alpha
    F0 = swap.F0
    w = swap.weights
    fwd_dates = swap.forward_dates
    n = len(F0)

    tau_offsets = fwd_dates - T_alpha

    # F̂_i^β with β=1 short-circuit (same FP path as DD).
    if cev_beta == 1.0:
        Fpow = F0 + displacement
    else:
        Fpow = (F0 + displacement) ** cev_beta

    var_sum = 0.0
    for i in range(n):
        for j in range(n):
            rho_ij = math.cos(beta * (tau_offsets[i] - tau_offsets[j]))
            I_ij = vol_product_integral(
                tau_offsets[i], tau_offsets[j], T_alpha, a, b, c, d, vol_scalar
            )
            var_sum += w[i] * w[j] * Fpow[i] * Fpow[j] * rho_ij * I_ij

    if cev_beta == 1.0:
        Shat = swap.S0 + displacement
        var_S = var_sum / (Shat ** 2)
        sigma_LN = math.sqrt(max(var_S, 0.0) / T_alpha)
        return Shat * sigma_LN
    return math.sqrt(max(var_sum, 0.0) / T_alpha)


def rebonato_swaption_normal_vol_grid(
    swaps: list[SwapStructure],
    a: float,
    b: float,
    c: float,
    d: float,
    beta: float,
    vol_scalar: float,
    displacement: float = 0.0,
    cev_beta: float = 1.0,
) -> np.ndarray:
    """Vector of Bachelier vols across a list of pre-built swap structures."""
    return np.array(
        [
            rebonato_swaption_normal_vol(s, a, b, c, d, beta, vol_scalar, displacement, cev_beta)
            for s in swaps
        ]
    )


if __name__ == "__main__":
    from pathlib import Path
    from market_data import load_market_snapshot
    from bootstrap import bootstrap_zero_curve

    snap = load_market_snapshot(
        Path(__file__).parent / "data" / os.environ.get("MARKET_JSON", "market_2025-09-30.json")
    )
    curve = bootstrap_zero_curve(snap)

    # Smoke test: prototype hardcoded parameters on a few swaptions.
    a, b, c, d, beta = 0.10, 0.20, 0.50, 0.80, 0.08
    vol_scalar = 0.008 / 0.036  # ~0.222 from prototype's heuristic

    print(f"BGM Rebonato smoke test with prototype hardcoded params:")
    print(f"  a={a}, b={b}, c={c}, d={d}, beta={beta}, volScalar={vol_scalar:.4f}\n")
    print(f"  {'expiry':>6s} {'tenor':>5s} {'S(0)':>7s} {'sigma_N(bp)':>11s}")
    for q in snap.swaption_atm_quotes[:8]:
        swap = build_swap(curve, q.expiry_years, q.expiry_years + q.tenor_years)
        sigma_N = rebonato_swaption_normal_vol(swap, a, b, c, d, beta, vol_scalar)
        print(
            f"  {q.expiry_years:6.3f} {q.tenor_years:5.1f} "
            f"{swap.S0*100:6.4f}% {sigma_N*1e4:11.2f}"
        )
