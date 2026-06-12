"""Hull-White 1-factor least-squares calibration to ATM caps.

Replaces the prototype's pseudo-random `performCalibration` (Gemini source
lines ~190-250). Fits (a, sigma) by minimising squared deviations between
HW-model and market normal vols on the ATM column of the cap surface.

HW is a one-factor Gaussian model: it has no smile. Non-ATM strikes are
fit by SABR overlay in `sabr.py`, not by HW.

Solver: scipy.optimize.least_squares with Trust Region Reflective (TRF),
finite-difference Jacobian. Bounds enforce a > 0, sigma > 0.

Acceptance threshold (from Steph audit memo Sec 7): RMSE <= 5 bps in
normal vol terms across ATM cap surface.

Reference: Andersen-Piterbarg Vol II Sec 10.1.6 for the Bachelier-equivalent
HW caplet vol; Brigo-Mercurio Sec 3.3.2 for HW caplet pricing under the
forward measure (alternative formulation used as cross-check).
"""

from __future__ import annotations

from dataclasses import dataclass
import os

import numpy as np
from scipy.optimize import least_squares

from market_data import MarketSnapshot
from bootstrap import ZeroCurve
from hw_pricing import hw_caplet_normal_vol_vec


# Default underlying period for SOFR caps. Real SOFR caps tile 3M-SOFR caplets
# across the cap horizon; for surface calibration we treat each surface entry
# as a single caplet at the cap maturity. Documented simplification in
# Steph's audit memo Sec 7.
DEFAULT_UNDERLYING_TAU = 0.25  # 3 months


@dataclass(frozen=True)
class HWCalibrationResult:
    a: float
    sigma: float
    rmse_bp: float
    residuals_bp: np.ndarray
    expiries: np.ndarray
    market_vols: np.ndarray
    model_vols: np.ndarray
    forwards: np.ndarray
    iterations: int
    success: bool
    message: str


def _atm_cap_targets(
    snapshot: MarketSnapshot,
    curve: ZeroCurve,
    underlying_tau: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Extract (expiries, market normal vols, initial forwards) for ATM caps."""
    atm = [q for q in snapshot.cap_quotes if q.is_atm]
    if not atm:
        raise ValueError("no ATM cap quotes in surface")
    expiries = np.array([q.expiry_years for q in atm])
    market_vols = np.array([q.normal_vol for q in atm])
    # Initial simple-compounded forward F(0, T, T + tau_u) at each expiry.
    forwards = np.array(
        [
            curve.forward_rate(T, T + underlying_tau)
            for T in expiries
        ]
    )
    return expiries, market_vols, forwards


def calibrate_hw(
    snapshot: MarketSnapshot,
    curve: ZeroCurve,
    underlying_tau: float = DEFAULT_UNDERLYING_TAU,
    a_init: float = 0.05,
    sigma_init: float = 0.01,
    a_bounds: tuple[float, float] = (1e-4, 0.5),
    sigma_bounds: tuple[float, float] = (1e-6, 0.05),
    verbose: bool = False,
) -> HWCalibrationResult:
    """Fit HW (a, sigma) by least-squares against ATM cap normal vols."""
    expiries, mkt_vols, forwards = _atm_cap_targets(snapshot, curve, underlying_tau)

    def residuals(params: np.ndarray) -> np.ndarray:
        a_p, sigma_p = float(params[0]), float(params[1])
        model = hw_caplet_normal_vol_vec(a_p, sigma_p, expiries, underlying_tau, forwards)
        return (model - mkt_vols) * 1e4  # in bp for stable scaling

    x0 = np.array([a_init, sigma_init])
    lb = np.array([a_bounds[0], sigma_bounds[0]])
    ub = np.array([a_bounds[1], sigma_bounds[1]])

    result = least_squares(
        residuals,
        x0,
        bounds=(lb, ub),
        method="trf",
        x_scale="jac",
        verbose=2 if verbose else 0,
        max_nfev=2000,
        xtol=1e-12,
        ftol=1e-12,
        gtol=1e-12,
    )

    a_fit, sigma_fit = float(result.x[0]), float(result.x[1])
    model_vols = hw_caplet_normal_vol_vec(a_fit, sigma_fit, expiries, underlying_tau, forwards)
    residual_bps = (model_vols - mkt_vols) * 1e4
    rmse_bp = float(np.sqrt(np.mean(residual_bps ** 2)))

    return HWCalibrationResult(
        a=a_fit,
        sigma=sigma_fit,
        rmse_bp=rmse_bp,
        residuals_bp=residual_bps,
        expiries=expiries,
        market_vols=mkt_vols,
        model_vols=model_vols,
        forwards=forwards,
        iterations=int(result.nfev),
        success=bool(result.success),
        message=str(result.message),
    )


def report(result: HWCalibrationResult) -> str:
    lines = []
    lines.append(f"HW1F calibration result")
    lines.append(f"  a       = {result.a:.6f}")
    lines.append(f"  sigma   = {result.sigma:.6f}")
    lines.append(f"  RMSE    = {result.rmse_bp:.4f} bp  (target: <= 5 bp)")
    lines.append(f"  status  = {result.message}  (nfev={result.iterations}, success={result.success})")
    lines.append("")
    lines.append(f"  {'expiry':>7s} {'F(0)':>10s} {'mkt_N(bp)':>10s} {'mod_N(bp)':>10s} {'res(bp)':>10s}")
    for T, F, mkt, mod, res in zip(
        result.expiries, result.forwards, result.market_vols, result.model_vols, result.residuals_bp
    ):
        lines.append(
            f"  {T:7.2f} {F*100:9.4f}% {mkt*1e4:10.2f} {mod*1e4:10.2f} {res:+10.4f}"
        )
    return "\n".join(lines)


if __name__ == "__main__":
    from pathlib import Path
    from market_data import load_market_snapshot
    from bootstrap import bootstrap_zero_curve

    snap = load_market_snapshot(
        Path(__file__).parent / "data" / os.environ.get("MARKET_JSON", "market_2025-09-30.json")
    )
    curve = bootstrap_zero_curve(snap)
    result = calibrate_hw(snap, curve)
    print(report(result))
    if result.rmse_bp > 5.0:
        print(f"\nWARNING: RMSE {result.rmse_bp:.2f} bp exceeds 5 bp threshold.")
