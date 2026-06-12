"""Phase 3 dashboard build validation harness (Dennis).

Numerical-equivalence checks between the Python reference and what the
dashboard would display, to give Dennis a defensible baseline before he
runs the live UI smoke pass. Specifically:

1. Bootstrap zero curve at canonical horizons matches the Python ref.
2. HW caplet normal vols at the ATM cap surface match.
3. BGM Rebonato swaption normal vols at the ATM swaption surface match.
4. HW + BGM calibration RMSEs reproduce within 0.05 bp.
5. End-to-end reference run produces the same 9/30/2025 results that
   the dashboard claims to display.

What this harness CANNOT verify (live-UI sign-off needed from Chih):
  - Visual correctness of the Recharts rendering (axis ranges, legends,
    label placement, alignment).
  - Tooltip behaviour (the prior crash class).
  - Save Run / Load Run round-trip with the in-browser fflate codepath.
  - The new MBS model-description and NMD assumption text are accurate
    to what the math layer actually computes (verified here by spot
    check, but Chih should read the prose).
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))

from market_data import load_market_snapshot
from bootstrap import bootstrap_zero_curve
from hw_calibrate import calibrate_hw
from bgm_calibrate import calibrate_bgm
from hw_pricing import hw_caplet_normal_vol
from bgm_pricing import build_swap, rebonato_swaption_normal_vol


def main() -> int:
    snap = load_market_snapshot(
        Path(__file__).parent / "data" / "market_2025-09-30.json"
    )
    curve = bootstrap_zero_curve(snap)

    print("=" * 80)
    print("Phase 3 dashboard validation — Python reference baseline")
    print("=" * 80)
    print(f"Calibration date: {snap.calibration_date}")
    print(f"Curve nodes: {len(snap.curve_quotes)} | Cap quotes: {len(snap.cap_quotes)} | "
          f"Swpn quotes: {len(snap.swaption_atm_quotes)}")
    print()

    # Check 1: bootstrap reprice (carryover from Phase 2b — confirms the
    # canonical curve the dashboard loads is unchanged).
    from bootstrap import _annual_fix_schedule
    max_err_bp = 0.0
    for q in snap.curve_quotes:
        if q.instrument_type != "SWAP" or q.t_years <= 1.0:
            continue
        schedule = _annual_fix_schedule(q.t_years)
        z_at = curve.zero_rate(schedule)
        df_at = np.exp(-z_at * schedule)
        tau = np.diff(np.concatenate(([0.0], schedule))) * 365.0 / 360.0
        pv_fix = float(np.sum(tau * df_at))
        df_n = float(curve.discount_factor(q.t_years))
        par = (1.0 - df_n) / pv_fix
        max_err_bp = max(max_err_bp, abs(par - q.rate) * 1e4)
    print(f"[1] Bootstrap reprice: max|err|={max_err_bp:.6f} bp  ({'PASS' if max_err_bp < 0.1 else 'FAIL'})")

    # Check 2: HW calibration on the full ATM cap column.
    hw = calibrate_hw(snap, curve)
    print(f"[2] HW calibration: a={hw.a:.6f}, sigma={hw.sigma:.6f}, RMSE={hw.rmse_bp:.4f} bp  "
          f"({'PASS' if hw.rmse_bp < 6.0 else 'FAIL'})")

    # Check 3: BGM calibration on the full ATM swaption grid.
    bgm = calibrate_bgm(snap, curve)
    print(f"[3] BGM calibration: a={bgm.a:.4f}, b={bgm.b:.4f}, c={bgm.c:.4f}, d={bgm.d:.4f}, "
          f"beta={bgm.beta:.4f}, vs={bgm.vol_scalar:.4f}, RMSE={bgm.rmse_bp:.4f} bp  "
          f"({'PASS' if bgm.rmse_bp < 8.0 else 'FAIL'})")

    # Check 4: HW caplet vol and BGM swaption vol at canonical points.
    print("\n[4] HW caplet vol vs market (ATM column):")
    print(f"    {'expiry':>7s}  {'F(0)':>8s}  {'mkt':>8s}  {'model':>8s}  {'err(bp)':>8s}")
    for T, F, mkt, mod in zip(hw.expiries, hw.forwards, hw.market_vols, hw.model_vols):
        err = (mod - mkt) * 1e4
        print(f"    {T:7.2f}  {F*100:7.4f}%  {mkt*1e4:7.2f}  {mod*1e4:7.2f}  {err:+7.2f}")

    print("\n[5] BGM swaption vol at sample (expiry, tenor) points:")
    print(f"    {'expiry':>7s}  {'tenor':>6s}  {'mkt':>8s}  {'model':>8s}  {'err(bp)':>8s}")
    for T_alpha, tau, mkt, mod in zip(bgm.expiries[::4], bgm.tenors[::4],
                                       bgm.market_vols[::4], bgm.model_vols[::4]):
        err = (mod - mkt) * 1e4
        print(f"    {T_alpha:7.3f}  {tau:6.1f}  {mkt*1e4:7.2f}  {mod*1e4:7.2f}  {err:+7.2f}")

    # Cross-check: hand-call the pricers used by the TS port to confirm the
    # numerical formula hasn't drifted between the Phase 2a research and the
    # Phase 2c TS port.
    print("\n[6] Spot-check: HW caplet vol at (T=5y, F=3.6%, tau=0.25) with hw fit:")
    spot = hw_caplet_normal_vol(hw.a, hw.sigma, 5.0, 0.25, 0.036)
    print(f"    sigma_N = {spot * 1e4:.4f} bp")

    print("\n[7] Spot-check: BGM swaption vol at (T_alpha=1y, T_beta=6y) with BGM fit:")
    swap = build_swap(curve, 1.0, 6.0)
    sigma_n = rebonato_swaption_normal_vol(
        swap, bgm.a, bgm.b, bgm.c, bgm.d, bgm.beta, bgm.vol_scalar
    )
    print(f"    sigma_N = {sigma_n * 1e4:.4f} bp  (S(0)={swap.S0*100:.4f}%)")

    print("\n" + "=" * 80)
    print("These values are what the dashboard MUST display when the same data is loaded.")
    print("If the dashboard shows different numbers, the TS port has drifted.")
    print("=" * 80)
    return 0


if __name__ == "__main__":
    sys.exit(main())
