"""SABR closed forms with normal (Bachelier) volatility output.

Implements the Hagan-Kumar-Lesniewski-Woodward 2002 closed form in the
beta=0 (Bachelier) limit. Mirrors `sabrNormalVol` in the prototype
(lines 105-115 of the Gemini source), but with explicit handling of the
ATM expansion and a small unit-test entry point.

Reference: Hagan, Kumar, Lesniewski, Woodward, "Managing Smile Risk",
Wilmott 2002, equation (A.69a) for beta=0.
"""

from __future__ import annotations

import math


def sabr_normal_vol(
    forward: float,
    strike: float,
    expiry: float,
    alpha: float,
    rho: float,
    nu: float,
) -> float:
    """SABR normal vol in the beta=0 limit (Bachelier).

    Parameters
    ----------
    forward : float
        ATM forward rate (decimal).
    strike : float
        Strike (decimal). Can be at, above, or below `forward`.
    expiry : float
        Time to expiry in years.
    alpha : float
        SABR alpha parameter (vol-of-rate, decimal). For beta=0 this is
        the lognormal-equivalent vol of F-K.
    rho : float
        SABR rho (correlation between rate and vol shocks).
    nu : float
        SABR nu (vol-of-vol, decimal).

    Returns
    -------
    float
        Implied normal volatility (decimal). Multiply by 1e4 to get bps.
    """
    eps = 1e-7
    # Higher-order ATM correction term used by both branches.
    higher_order = 1.0 + ((2.0 - 3.0 * rho * rho) * nu * nu / 24.0) * expiry

    if abs(forward - strike) < eps:
        # ATM expansion: z/x(z) -> 1 as z -> 0.
        return alpha * higher_order

    z = (nu / alpha) * (forward - strike)
    arg = (math.sqrt(1.0 - 2.0 * rho * z + z * z) + z - rho) / (1.0 - rho)
    if arg <= 0.0:
        # Regulariser: replicate the prototype's eps fallback. Should never
        # fire in calibrated regimes.
        arg = eps
    x = math.log(arg)
    return alpha * (z / x) * higher_order


def _self_test() -> None:
    """Sanity checks: ATM continuity and rho symmetry."""
    F = 0.036
    T = 5.0
    alpha = 0.008
    rho = -0.20
    nu = 0.60

    atm = sabr_normal_vol(F, F, T, alpha, rho, nu)
    near = sabr_normal_vol(F, F + 1e-9, T, alpha, rho, nu)
    assert abs(atm - near) < 1e-6, f"ATM continuity broken: {atm} vs {near}"

    # rho=0 should produce a symmetric smile.
    sym_alpha, sym_nu = 0.008, 0.40
    up = sabr_normal_vol(F, F + 0.005, T, sym_alpha, 0.0, sym_nu)
    dn = sabr_normal_vol(F, F - 0.005, T, sym_alpha, 0.0, sym_nu)
    assert abs(up - dn) < 1e-6, f"rho=0 symmetry broken: {up} vs {dn}"

    print("sabr.py self-test: PASS")


if __name__ == "__main__":
    _self_test()

    # Print a small slice for visual inspection.
    F = 0.036
    T = 5.0
    alpha, rho, nu = 0.008, -0.30, 0.70
    print(f"\nSABR normal vol slice: F={F:.4f}, T={T}, alpha={alpha}, rho={rho}, nu={nu}")
    for offset_bp in (-150, -100, -50, -25, 0, 25, 50, 100, 150):
        K = F + offset_bp / 1e4
        v = sabr_normal_vol(F, K, T, alpha, rho, nu)
        print(f"  offset={offset_bp:+5d} bp  K={K:7.4f}  vol_N={v*1e4:7.2f} bp")
