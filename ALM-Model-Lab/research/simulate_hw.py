"""Hull-White 1-factor Monte Carlo simulator.

Exact transition for the OU latent factor X under shifted-Gaussian HW:

    r(t) = f^M(0, t) + X(t),     dX = -a X dt + sigma dW.

Per simulation step:
    X_{t+dt} = X_t * exp(-a dt) + sigma * sqrt((1 - exp(-2 a dt)) / (2 a)) * Z
    r_uncorr_{t+dt} = f^M(0, t+dt) + X_{t+dt}
    D_step = exp(-0.5 (r_t + r_{t+dt}) dt)             # trapezoidal
    D_path *= D_step

Martingale correction (Glasserman Sec 4.5): scale every path's cumulative
discount factor at each step by  c_t = P^M(0, t) / E[D_uncorr],  yielding
an unbiased estimator of zero-coupon prices on the simulated paths.

This replaces the prototype's `runHullWhiteSimulation` (Gemini source lines
~530-660) with NumPy-vectorised path arithmetic, antithetic pairing, and
optional `apply_correction=False` for variance-reduction comparison runs.
"""

from __future__ import annotations

from dataclasses import dataclass
import os

import numpy as np

from bootstrap import ZeroCurve
from hw_pricing import b_function


@dataclass(frozen=True)
class HWSimulationResult:
    seed: int
    a: float
    sigma: float
    n_paths: int           # total paths (= 2 * n_pairs)
    horizon_years: float
    dt_years: float
    times: np.ndarray      # shape (n_steps,) simulation times t_1, ..., t_n
    X_paths: np.ndarray    # shape (n_paths, n_steps) latent factor X(t_k)
    r_paths: np.ndarray    # shape (n_paths, n_steps) short rate r(t_k) = f^M(0, t_k) + X
    df_market: np.ndarray  # shape (n_steps,) market DF(0, t_k)
    df_simulated: np.ndarray  # shape (n_steps,) simulated mean DF(0, t_k)
    raw_error_bps: np.ndarray  # uncorrected DF error (model minus market) in bps
    corrected: bool


def simulate_hw(
    curve: ZeroCurve,
    a: float,
    sigma: float,
    horizon_years: float = 30.0,
    dt_years: float = 1 / 12,
    n_pairs: int = 250,
    seed: int = 42,
    apply_correction: bool = True,
) -> HWSimulationResult:
    """Simulate HW1F paths under the spot-numeraire measure with antithetic pairing.

    Parameters
    ----------
    curve : ZeroCurve
        Bootstrapped initial zero curve.
    a, sigma : float
        Calibrated HW parameters.
    horizon_years : float
        Total simulation horizon.
    dt_years : float
        Step size (default monthly).
    n_pairs : int
        Number of antithetic pairs. Total paths = 2 * n_pairs.
    seed : int
        RNG seed for reproducibility.
    apply_correction : bool
        If True, apply multiplicative martingale correction at each step.

    Returns
    -------
    HWSimulationResult
        Latent factor and short-rate paths plus diagnostic arrays.
    """
    rng = np.random.default_rng(seed)
    n_steps = int(round(horizon_years / dt_years))
    times = np.arange(1, n_steps + 1) * dt_years
    n_paths = 2 * n_pairs

    # Forward rates derived from the curve, used as f^M(0, t) in r = f^M + X.
    # Using f(0, t) ~= -log(P(0, t+dt)/P(0, t))/dt at each grid point.
    grid_full = np.concatenate(([0.0], times))
    df_full = curve.discount_factor(grid_full)
    fwd_at_step = -np.log(df_full[1:] / df_full[:-1]) / dt_years  # f^M(0, t_k) for each step k

    # Exact OU transition coefficients.
    decay = np.exp(-a * dt_years)
    std_x = sigma * np.sqrt((1.0 - np.exp(-2.0 * a * dt_years)) / (2.0 * a))

    X = np.zeros((n_paths, n_steps), dtype=np.float64)
    r = np.zeros((n_paths, n_steps), dtype=np.float64)

    x_curr = np.zeros(n_paths, dtype=np.float64)
    # Initial r at t = 0 is the instantaneous forward at 0.
    f0 = float(fwd_at_step[0])
    r_uncorr_curr = np.full(n_paths, f0, dtype=np.float64)

    D_path = np.ones(n_paths, dtype=np.float64)
    df_simulated = np.empty(n_steps, dtype=np.float64)
    df_market = curve.discount_factor(times)
    raw_error_bps = np.empty(n_steps, dtype=np.float64)

    for k in range(n_steps):
        # Antithetic shocks: first half +Z, second half -Z.
        z = rng.standard_normal(n_pairs)
        shock = np.concatenate((std_x * z, -std_x * z))

        x_next = x_curr * decay + shock
        r_uncorr_next = fwd_at_step[k] + x_next

        D_step = np.exp(-0.5 * (r_uncorr_curr + r_uncorr_next) * dt_years)

        # Per-step uncorrected mean discount factor.
        e_d_uncorr = float(np.mean(D_path * D_step))
        raw_error_bps[k] = (e_d_uncorr - df_market[k]) * 1e4

        if apply_correction:
            correction = df_market[k] / e_d_uncorr
            D_path = D_path * D_step * correction
        else:
            D_path = D_path * D_step

        df_simulated[k] = float(np.mean(D_path))

        x_curr = x_next
        r_uncorr_curr = r_uncorr_next
        X[:, k] = x_curr
        r[:, k] = r_uncorr_next

    return HWSimulationResult(
        seed=seed,
        a=a,
        sigma=sigma,
        n_paths=n_paths,
        horizon_years=horizon_years,
        dt_years=dt_years,
        times=times,
        X_paths=X,
        r_paths=r,
        df_market=df_market,
        df_simulated=df_simulated,
        raw_error_bps=raw_error_bps,
        corrected=apply_correction,
    )


def project_hw_to_tenor(
    sim: HWSimulationResult,
    curve: ZeroCurve,
    tenor_years: float,
) -> np.ndarray:
    """Reconstruct simply-compounded forward F(t, t+tau) for each path/time.

    Uses the analytical HW bond price formula for P(t, t+tau) given X(t).
    Returns an array of shape (n_paths, n_steps).
    """
    a, sigma = sim.a, sim.sigma
    times = sim.times
    tau = tenor_years

    B_tau = float(b_function(a, tau))
    var_term = (sigma * sigma / (4.0 * a)) * (1.0 - np.exp(-2.0 * a * times)) * (B_tau ** 2)
    P0_t = curve.discount_factor(times)
    P0_T = curve.discount_factor(times + tau)
    ratio = P0_T / P0_t  # shape (n_steps,)

    # P(t, t+tau) = ratio * exp(-B(tau) X(t) - V(t, tau))
    log_P = np.log(ratio)[None, :] - B_tau * sim.X_paths - var_term[None, :]
    P_t_T = np.exp(log_P)
    return (1.0 / P_t_T - 1.0) / tau


if __name__ == "__main__":
    from pathlib import Path
    from market_data import load_market_snapshot
    from bootstrap import bootstrap_zero_curve
    from hw_calibrate import calibrate_hw

    snap = load_market_snapshot(
        Path(__file__).parent / "data" / os.environ.get("MARKET_JSON", "market_2025-09-30.json")
    )
    curve = bootstrap_zero_curve(snap)
    hw_fit = calibrate_hw(snap, curve)

    sim = simulate_hw(
        curve, hw_fit.a, hw_fit.sigma,
        horizon_years=30.0, dt_years=1 / 12, n_pairs=250, seed=20250930,
    )
    sim_no_corr = simulate_hw(
        curve, hw_fit.a, hw_fit.sigma,
        horizon_years=30.0, dt_years=1 / 12, n_pairs=250, seed=20250930,
        apply_correction=False,
    )

    print(f"HW simulation: a={hw_fit.a:.6f}, sigma={hw_fit.sigma:.6f}, "
          f"n_paths={sim.n_paths}, seed={sim.seed}")
    print(f"\n  step  t       DF_mkt    DF_corr   err_bp  DF_uncorr err_bp")
    for k in (0, 11, 59, 119, 239, 359):
        if k >= len(sim.times):
            continue
        print(
            f"  {k:4d}  {sim.times[k]:5.2f}  "
            f"{sim.df_market[k]:8.6f}  {sim.df_simulated[k]:8.6f}  "
            f"{(sim.df_simulated[k] - sim.df_market[k]) * 1e4:+7.3f}  "
            f"{sim_no_corr.df_simulated[k]:8.6f}  "
            f"{(sim_no_corr.df_simulated[k] - sim.df_market[k]) * 1e4:+7.3f}"
        )

    # 1Y forward path summary at a few horizons.
    fwd = project_hw_to_tenor(sim, curve, tenor_years=1.0)
    print(f"\n1Y forward rate distribution at selected horizons:")
    print(f"  horizon  mean    p5      p95")
    for k in (0, 11, 59, 119, 239):
        if k >= fwd.shape[1]:
            continue
        cs = fwd[:, k]
        print(
            f"  {sim.times[k]:6.2f}y  {cs.mean()*100:6.4f}%  "
            f"{np.percentile(cs, 5)*100:6.4f}%  "
            f"{np.percentile(cs, 95)*100:6.4f}%"
        )
