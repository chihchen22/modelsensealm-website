"""End-to-end ALM Model Lab reference pipeline.

Sequence:
1. Load market snapshot (default: 9/30/2025).
2. Bootstrap zero curve.
3. Calibrate HW1F to ATM caps.
4. Calibrate BGM Rebonato 2F to ATM swaptions.
5. Simulate HW (with and without martingale correction).
6. Simulate BGM with predictor-corrector advance.
7. Write run artefacts to `Model-Sense/ALM-Model-Lab/runs/{run_id}/`:
   * manifest.json
   * calibration_report.txt
   * paths_hw_{tenor}.csv per saved tenor
   * paths_bgm_{tenor}.csv per saved tenor
   * martingale_diagnostic.csv (HW corrected vs uncorrected DF errors)

Run ID format: {calibration_date}_{seed}_{n_paths}paths.

This is what Kobe ports to TypeScript for the in-browser engine. Numerical
parity between this Python reference and the TS port is verified in
Phase 2c via vitest.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from market_data import load_market_snapshot
from bootstrap import bootstrap_zero_curve
from hw_calibrate import calibrate_hw, report as hw_report
from bgm_calibrate import calibrate_bgm, report as bgm_report
from simulate_hw import simulate_hw, project_hw_to_tenor
from simulate_bgm import simulate_bgm, F_CEILING

# Overnight uses the SOFR ACT/360 convention: one business day = 1/360 of a year.
# On a monthly-step simulation grid, the 1D yield extracted at simulation time
# t_m is functionally identical to the model's spot rate at t_m (HW: r(t_m);
# BGM: F_m(t_m)). Useful as a clean SOFR O/N path; no intra-month dynamic.
DEFAULT_TENORS_FOR_HW = (1 / 360, 1 / 12, 3 / 12, 6 / 12, 1.0, 2.0, 5.0, 7.0, 10.0, 20.0, 30.0)
DEFAULT_TENORS_FOR_BGM = (1 / 360, 1 / 12, 3 / 12, 6 / 12, 1.0, 2.0, 5.0, 7.0, 10.0, 20.0, 30.0)
TENOR_LABELS = ("1D", "1M", "3M", "6M", "1Y", "2Y", "5Y", "7Y", "10Y", "20Y", "30Y")


def _write_paths_csv(
    out_path: Path,
    times: np.ndarray,
    paths: np.ndarray,  # shape (n_paths, n_steps)
    tenor_label: str,
) -> None:
    """Write paths to CSV in the convention `Month, Year, path_001..path_N`.

    Matches Steph's existing format at
    `ALM-Modeling-Book/chapters/ch03/sofr_paths_100x_v1.csv`.
    """
    n_paths, n_steps = paths.shape
    header = ["Month", "Year"] + [f"path_{i+1:03d}" for i in range(n_paths)]
    with out_path.open("w", encoding="utf-8") as fh:
        fh.write(",".join(header) + "\n")
        for k in range(n_steps):
            row = [str(k + 1), f"{times[k]:.4f}"]
            row.extend(f"{paths[i, k]:.6f}" for i in range(n_paths))
            fh.write(",".join(row) + "\n")


def _write_diagnostic_csv(
    out_path: Path,
    times: np.ndarray,
    df_market: np.ndarray,
    df_corrected: np.ndarray,
    df_uncorrected: np.ndarray,
) -> None:
    with out_path.open("w", encoding="utf-8") as fh:
        fh.write("Month,Year,DF_market,DF_corrected,DF_uncorrected,err_corr_bp,err_uncorr_bp\n")
        for k in range(len(times)):
            err_c = (df_corrected[k] - df_market[k]) * 1e4
            err_u = (df_uncorrected[k] - df_market[k]) * 1e4
            fh.write(
                f"{k+1},{times[k]:.4f},{df_market[k]:.8f},{df_corrected[k]:.8f},"
                f"{df_uncorrected[k]:.8f},{err_c:+.6f},{err_u:+.6f}\n"
            )


def run_reference(
    market_path: str | Path | None = None,
    seed: int = 20250930,
    n_pairs: int = 250,
    horizon_years: float = 30.0,
    dt_years: float = 1 / 12,
    runs_root: Path | None = None,
    verbose: bool = True,
) -> dict:
    """Execute the end-to-end reference pipeline and return the manifest dict."""
    if market_path is None:
        market_path = Path(__file__).parent / "data" / "market_2025-09-30.json"
    market_path = Path(market_path)

    if runs_root is None:
        runs_root = Path(__file__).resolve().parents[1] / "runs"
    runs_root.mkdir(parents=True, exist_ok=True)

    snap = load_market_snapshot(market_path)
    n_paths = 2 * n_pairs
    run_id = f"{snap.calibration_date}_{seed}_{n_paths}paths"
    run_dir = runs_root / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    if verbose:
        print(f"=== ALM Model Lab reference run: {run_id} ===")
        print(f"  market data: {market_path}")
        print(f"  output dir : {run_dir}")
        print(f"  paths      : {n_paths} (n_pairs={n_pairs})")
        print(f"  horizon    : {horizon_years}y at dt={dt_years:.6f}")
        print(f"  seed       : {seed}\n")

    # 1-2. Curve.
    curve = bootstrap_zero_curve(snap)
    if verbose:
        print(f"Bootstrap: {len(curve.t)} nodes, max DF error after reprice <= 1e-8.")

    # 3. HW calibration.
    hw_fit = calibrate_hw(snap, curve)
    if verbose:
        print()
        print(hw_report(hw_fit))

    # 4. BGM calibration.
    bgm_fit = calibrate_bgm(snap, curve)
    if verbose:
        print()
        print(bgm_report(bgm_fit))

    # 5. HW simulation (corrected + uncorrected for diagnostic).
    hw_sim = simulate_hw(
        curve, hw_fit.a, hw_fit.sigma,
        horizon_years=horizon_years, dt_years=dt_years, n_pairs=n_pairs, seed=seed,
        apply_correction=True,
    )
    hw_sim_uncorr = simulate_hw(
        curve, hw_fit.a, hw_fit.sigma,
        horizon_years=horizon_years, dt_years=dt_years, n_pairs=n_pairs, seed=seed,
        apply_correction=False,
    )
    if verbose:
        max_err_corr = float(np.max(np.abs(hw_sim.df_simulated - hw_sim.df_market)) * 1e4)
        max_err_uncorr = float(np.max(np.abs(hw_sim_uncorr.df_simulated - hw_sim_uncorr.df_market)) * 1e4)
        print()
        print(f"HW MC: max DF error corrected={max_err_corr:.4f} bp, "
              f"uncorrected={max_err_uncorr:.2f} bp.")

    # 6. BGM simulation.
    bgm_sim = simulate_bgm(
        curve,
        bgm_fit.a, bgm_fit.b, bgm_fit.c, bgm_fit.d, bgm_fit.beta, bgm_fit.vol_scalar,
        horizon_years=horizon_years, dt_years=dt_years, n_pairs=n_pairs, seed=seed,
        saved_tenors=DEFAULT_TENORS_FOR_BGM,
    )
    if verbose:
        max_err_bgm = float(np.max(np.abs(bgm_sim.df_simulated - bgm_sim.df_market)) * 1e4)
        print(f"BGM MC: max DF error corrected={max_err_bgm:.4f} bp.")

    # 7. Write artefacts.
    # 7a. HW path CSVs at saved tenors (HW projects from latent X on demand).
    for tau, label in zip(DEFAULT_TENORS_FOR_HW, TENOR_LABELS):
        paths = project_hw_to_tenor(hw_sim, curve, tenor_years=tau)
        _write_paths_csv(run_dir / f"paths_hw_{label}.csv", hw_sim.times, paths, label)

    # 7b. BGM path CSVs at saved tenors (already projected during simulation).
    for ti, label in enumerate(TENOR_LABELS):
        paths = bgm_sim.rates[:, :, ti]
        _write_paths_csv(run_dir / f"paths_bgm_{label}.csv", bgm_sim.times, paths, label)

    # 7c. Martingale diagnostic.
    _write_diagnostic_csv(
        run_dir / "martingale_diagnostic_hw.csv",
        hw_sim.times, hw_sim.df_market, hw_sim.df_simulated, hw_sim_uncorr.df_simulated,
    )

    # 7d. Calibration report.
    with (run_dir / "calibration_report.txt").open("w", encoding="utf-8") as fh:
        fh.write(f"ALM Model Lab calibration report\n")
        fh.write(f"Run ID: {run_id}\n")
        fh.write(f"Calibration date: {snap.calibration_date}\n")
        fh.write(f"Generated: {datetime.now(timezone.utc).isoformat()}\n\n")
        fh.write(hw_report(hw_fit))
        fh.write("\n\n")
        fh.write(bgm_report(bgm_fit))
        fh.write("\n")

    # 7e. Manifest.
    manifest = {
        "run_id": run_id,
        "calibration_date": snap.calibration_date,
        "currency": snap.currency,
        "discounting_index": snap.discounting_index,
        "market_data_path": str(market_path),
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "seed": seed,
        "n_paths": n_paths,
        "n_pairs": n_pairs,
        "horizon_years": horizon_years,
        "dt_years": dt_years,
        "saved_tenors_years": list(DEFAULT_TENORS_FOR_HW),
        "saved_tenor_labels": list(TENOR_LABELS),
        "hw": {
            "a": hw_fit.a,
            "sigma": hw_fit.sigma,
            "rmse_bp": hw_fit.rmse_bp,
            "fit_success": hw_fit.success,
            "fit_iterations": hw_fit.iterations,
        },
        "bgm": {
            "a": bgm_fit.a,
            "b": bgm_fit.b,
            "c": bgm_fit.c,
            "d": bgm_fit.d,
            "beta": bgm_fit.beta,
            "vol_scalar": bgm_fit.vol_scalar,
            "rmse_bp": bgm_fit.rmse_bp,
            "fit_success": bgm_fit.success,
            "fit_iterations": bgm_fit.iterations,
            "discretization": "predictor_corrector_hjj2001",
            "f_floor": 1e-8,
            "f_ceiling": F_CEILING,
        },
        "martingale": {
            "method": "multiplicative_glasserman_4_5",
            "hw_corrected_max_df_err_bp": float(np.max(np.abs(hw_sim.df_simulated - hw_sim.df_market)) * 1e4),
            "hw_uncorrected_max_df_err_bp": float(np.max(np.abs(hw_sim_uncorr.df_simulated - hw_sim_uncorr.df_market)) * 1e4),
            "bgm_corrected_max_df_err_bp": float(np.max(np.abs(bgm_sim.df_simulated - bgm_sim.df_market)) * 1e4),
        },
        "outputs": {
            "paths_hw": [f"paths_hw_{label}.csv" for label in TENOR_LABELS],
            "paths_bgm": [f"paths_bgm_{label}.csv" for label in TENOR_LABELS],
            "calibration_report": "calibration_report.txt",
            "martingale_diagnostic": "martingale_diagnostic_hw.csv",
        },
    }
    with (run_dir / "manifest.json").open("w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)

    if verbose:
        print(f"\nWrote {len(TENOR_LABELS) * 2 + 3} artefacts to {run_dir}")

    return manifest


def _cli() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the ALM Model Lab end-to-end Python reference pipeline.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--market-data",
        type=Path,
        default=None,
        help="Path to market snapshot JSON. Default: data/market_2025-09-30.json.",
    )
    parser.add_argument(
        "--n-paths",
        type=int,
        default=500,
        help="Total number of simulation paths. Must be even (paths run as antithetic pairs). "
             "Typical: 100 for quick exhibits, 500 for the canonical reference, "
             "1000-10000 for production stress runs.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=20250930,
        help="RNG seed for reproducibility.",
    )
    parser.add_argument(
        "--horizon-years",
        type=float,
        default=30.0,
        help="Total simulation horizon in years.",
    )
    parser.add_argument(
        "--dt-years",
        type=float,
        default=1 / 12,
        help="Step size in years (default: monthly = 1/12).",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress progress and per-section reporting.",
    )
    return parser


if __name__ == "__main__":
    args = _cli().parse_args()
    if args.n_paths % 2 != 0:
        raise SystemExit(f"--n-paths must be even (antithetic pairing); got {args.n_paths}.")
    n_pairs = args.n_paths // 2
    run_reference(
        market_path=args.market_data,
        seed=args.seed,
        n_pairs=n_pairs,
        horizon_years=args.horizon_years,
        dt_years=args.dt_years,
        verbose=not args.quiet,
    )
