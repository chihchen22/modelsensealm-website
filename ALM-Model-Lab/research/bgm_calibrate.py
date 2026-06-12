"""BGM/LMM Rebonato 2-factor least-squares calibration to ATM swaptions.

Replaces the prototype's pseudo-random `performCalibration` for the BGM block
(Gemini source lines ~190-250). Fits (a, b, c, d, beta, vol_scalar) by
minimising squared deviations between Rebonato model normal vol and market
normal vol on each ATM swaption surface entry.

The Rebonato vol surface has six free parameters; the prototype's market
swaption surface has 20 ATM points (5 expiries x 4 tenors). 20 residuals,
6 parameters: well-posed.

Solver: scipy.optimize.least_squares with TRF, finite-diff Jacobian.
Bounds enforce vol-shape positivity.

Acceptance threshold (Steph audit memo Sec 7): RMSE <= 10 bps in normal
vol terms across the ATM swaption grid.

References
----------
- Rebonato 2002 *Modern Pricing of Interest-Rate Derivatives* Sec 13-15.
- Andersen-Piterbarg Vol II Sec 14.4.
"""

from __future__ import annotations

from dataclasses import dataclass
import os

import numpy as np
from scipy.optimize import least_squares

from market_data import MarketSnapshot
from bootstrap import ZeroCurve
from bgm_pricing import build_swap, rebonato_swaption_normal_vol_grid, SwapStructure


@dataclass(frozen=True)
class BGMCalibrationResult:
    a: float
    b: float
    c: float
    d: float
    beta: float
    vol_scalar: float
    displacement: float
    cev_beta: float
    rmse_bp: float
    residuals_bp: np.ndarray
    expiries: np.ndarray
    tenors: np.ndarray
    par_rates: np.ndarray
    market_vols: np.ndarray
    model_vols: np.ndarray
    iterations: int
    success: bool
    message: str


def _build_swap_targets(
    snapshot: MarketSnapshot,
    curve: ZeroCurve,
) -> tuple[list[SwapStructure], np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    swaps: list[SwapStructure] = []
    expiries: list[float] = []
    tenors: list[float] = []
    market_vols: list[float] = []
    par_rates: list[float] = []
    for q in snapshot.swaption_atm_quotes:
        swap = build_swap(curve, q.expiry_years, q.expiry_years + q.tenor_years)
        swaps.append(swap)
        expiries.append(q.expiry_years)
        tenors.append(q.tenor_years)
        market_vols.append(q.normal_vol)
        par_rates.append(swap.S0)
    return (
        swaps,
        np.array(expiries),
        np.array(tenors),
        np.array(par_rates),
        np.array(market_vols),
    )


def calibrate_bgm(
    snapshot: MarketSnapshot,
    curve: ZeroCurve,
    a_init: float = 0.10,
    b_init: float = 0.20,
    c_init: float = 0.50,
    d_init: float = 0.80,
    beta_init: float = 0.08,
    vol_scalar_init: float | None = None,
    displacement: float = 0.0,
    cev_beta: float = 1.0,
    verbose: bool = False,
) -> BGMCalibrationResult:
    """Fit the six Rebonato 2F parameters to the ATM swaption surface.

    `displacement` (δ) and `cev_beta` (β_cev) are held fixed during the fit.
      (cev_beta, displacement) = (1, 0) = standard lognormal LMM;
      cev_beta=1, δ>0 = shifted-lognormal LMM (DD);
      cev_beta<1, δ≥0 = shifted-CEV LMM.
    """
    swaps, expiries, tenors, par_rates, market_vols = _build_swap_targets(snapshot, curve)

    if vol_scalar_init is None:
        # Heuristic: σ_N ≈ (S+δ)^β · σ_LN_kernel ⇒ vol_scalar ≈ σ_N / (S+δ)^β.
        # β=1, δ=0 reproduces the original init.
        avg_n = float(np.mean(market_vols))
        avg_S = float(np.mean(par_rates))
        denom = (avg_S + displacement) if cev_beta == 1.0 else (avg_S + displacement) ** cev_beta
        vol_scalar_init = avg_n / denom

    def residuals(params: np.ndarray) -> np.ndarray:
        a, b, c, d, beta, vs = params
        model = rebonato_swaption_normal_vol_grid(
            swaps, a, b, c, d, beta, vs, displacement, cev_beta
        )
        return (model - market_vols) * 1e4  # bp

    x0 = np.array([a_init, b_init, c_init, d_init, beta_init, vol_scalar_init])
    lb = np.array([0.0,    0.0,    1e-3,   0.0,    -1.0,      0.01])
    ub = np.array([5.0,    5.0,    5.0,    5.0,    +1.0,      2.0])

    result = least_squares(
        residuals,
        x0,
        bounds=(lb, ub),
        method="trf",
        x_scale="jac",
        verbose=2 if verbose else 0,
        max_nfev=4000,
        xtol=1e-12,
        ftol=1e-12,
        gtol=1e-12,
    )

    a, b, c, d, beta, vs = result.x
    model_vols = rebonato_swaption_normal_vol_grid(
        swaps, a, b, c, d, beta, vs, displacement, cev_beta
    )
    residual_bps = (model_vols - market_vols) * 1e4
    rmse_bp = float(np.sqrt(np.mean(residual_bps ** 2)))

    return BGMCalibrationResult(
        a=float(a),
        b=float(b),
        c=float(c),
        d=float(d),
        beta=float(beta),
        vol_scalar=float(vs),
        displacement=float(displacement),
        cev_beta=float(cev_beta),
        rmse_bp=rmse_bp,
        residuals_bp=residual_bps,
        expiries=expiries,
        tenors=tenors,
        par_rates=par_rates,
        market_vols=market_vols,
        model_vols=model_vols,
        iterations=int(result.nfev),
        success=bool(result.success),
        message=str(result.message),
    )


def report(result: BGMCalibrationResult) -> str:
    lines = []
    lines.append("BGM Rebonato 2F calibration result")
    lines.append(f"  a          = {result.a:.6f}")
    lines.append(f"  b          = {result.b:.6f}")
    lines.append(f"  c          = {result.c:.6f}")
    lines.append(f"  d          = {result.d:.6f}")
    lines.append(f"  beta       = {result.beta:.6f}")
    lines.append(f"  vol_scalar = {result.vol_scalar:.6f}")
    lines.append(f"  delta      = {result.displacement:.6f}  (shifted-lognormal displacement)")
    lines.append(f"  cev_beta   = {result.cev_beta:.4f}      (shifted-CEV exponent; β=1 = DD)")
    lines.append(f"  RMSE       = {result.rmse_bp:.4f} bp  (target: <= 10 bp)")
    lines.append(f"  status     = {result.message}  (nfev={result.iterations}, success={result.success})")
    lines.append("")
    lines.append(
        f"  {'expiry':>7s} {'tenor':>6s} {'S(0)':>9s} "
        f"{'mkt_N(bp)':>10s} {'mod_N(bp)':>10s} {'res(bp)':>10s}"
    )
    for T, tau, S, mkt, mod, res in zip(
        result.expiries,
        result.tenors,
        result.par_rates,
        result.market_vols,
        result.model_vols,
        result.residuals_bp,
    ):
        lines.append(
            f"  {T:7.3f} {tau:6.1f} {S*100:8.4f}% "
            f"{mkt*1e4:10.2f} {mod*1e4:10.2f} {res:+10.4f}"
        )
    return "\n".join(lines)


if __name__ == "__main__":
    import dataclasses
    from pathlib import Path
    from market_data import load_market_snapshot
    from bootstrap import bootstrap_zero_curve

    snap = load_market_snapshot(
        Path(__file__).parent / "data" / os.environ.get("MARKET_JSON", "market_2025-09-30.json")
    )
    # Standard liquid calibration subset, matching the lab's default swaption
    # selection (marketData.ts DEFAULT_SWAPTION_CALIB_*): the 2026-03-31
    # surface is 21 x 15 = 315 quotes with tenors to 30Y, far beyond an
    # interactive fit. Snapshots whose grid misses the subset (legacy 9/30
    # file) calibrate to their full quote list, preserving old references.
    CALIB_EXPIRIES = (1 / 12, 3 / 12, 6 / 12, 1.0, 2.0, 5.0, 10.0)
    CALIB_TENORS = (1.0, 2.0, 5.0, 10.0)

    def _near(x: float, vals: tuple[float, ...]) -> bool:
        return any(abs(x - v) < 1e-9 for v in vals)

    subset = tuple(
        q
        for q in snap.swaption_atm_quotes
        if _near(q.expiry_years, CALIB_EXPIRIES) and _near(q.tenor_years, CALIB_TENORS)
    )
    if subset and len(subset) < len(snap.swaption_atm_quotes):
        snap = dataclasses.replace(snap, swaption_atm_quotes=subset)
        print(f"calibrating to the standard subset: {len(subset)} of the surface's quotes\n")
    curve = bootstrap_zero_curve(snap)
    result = calibrate_bgm(snap, curve, verbose=False)
    print(report(result))
    if result.rmse_bp > 10.0:
        print(f"\nWARNING: RMSE {result.rmse_bp:.2f} bp exceeds 10 bp threshold.")
