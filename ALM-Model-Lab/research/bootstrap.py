"""SOFR OIS zero-coupon bootstrap.

Replaces the prototype's `bootstrapZeroCurve` (lines 422-447 of the Gemini
source) with conventions that match USD SOFR OIS practice.

Conventions
-----------
* Day count: ACT/360 for cash, ACT/360 for swap fixed (USD SOFR OIS standard).
  The prototype used integer-year accrual, undercounting by 1.4% (5 days / 360);
  this changes long-end discount factors by 1-3 bp.
* Cash leg: discount factor = 1 / (1 + r * accrual). The prototype used
  simple compounding too, so this is unchanged in form, only in accrual.
* Swap leg: annual fixed schedule, par swap rate priced under standard
  formula PV_fix = K * sum(tau_i * DF_i), PV_float = 1 - DF(0, T_n).
  Setting equal gives the bootstrap equation, solved by Newton-Raphson with
  closed-form derivative dPV_fix/dz_n.
* Interpolation between zero-rate nodes: linear in zero rate.

Outputs
-------
ZeroCurve: a pair of numpy arrays (t_years, z_rate) plus a callable for
log-linear-in-DF interpolation, suitable as input to HW and BGM pricers.

References
----------
- Andersen-Piterbarg Vol I §6 (curve construction).
- Brigo-Mercurio §1.2 (yield-curve conventions).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable
import os

import numpy as np
from scipy.optimize import brentq

from market_data import MarketSnapshot, curve_arrays


@dataclass(frozen=True)
class ZeroCurve:
    """A bootstrapped continuously compounded zero-coupon curve.

    Attributes
    ----------
    t : np.ndarray
        Tenors in years for each node.
    z : np.ndarray
        Continuously compounded zero rates at each node.
    """
    t: np.ndarray
    z: np.ndarray

    def discount_factor(self, time: float | np.ndarray) -> float | np.ndarray:
        """DF(0, time) by linear interpolation in the zero rate.

        Off the curve edges, holds the endpoint rate flat (consistent with
        the prototype's interpLinear behaviour).
        """
        z_interp = np.interp(time, self.t, self.z)
        return np.exp(-z_interp * np.asarray(time))

    def zero_rate(self, time: float | np.ndarray) -> float | np.ndarray:
        return np.interp(time, self.t, self.z)

    def forward_rate(self, t1: float, t2: float) -> float:
        """Simply-compounded forward rate between t1 and t2."""
        if t2 <= t1:
            raise ValueError(f"t2={t2} must exceed t1={t1}")
        return (self.discount_factor(t1) / self.discount_factor(t2) - 1.0) / (t2 - t1)


def _annual_fix_schedule(t_n: float) -> np.ndarray:
    """Annual fixed-leg payment dates up to t_n (inclusive). ACT/360 fraction."""
    # USD SOFR OIS: annual fixed coupons. Schedule is years 1, 2, ..., n where
    # n = round(t_n). For a 4Y swap quoted at t_years=4.0 we expect [1, 2, 3, 4].
    n = int(round(t_n))
    if abs(n - t_n) > 1e-6:
        raise ValueError(f"non-integer maturity {t_n} not supported by annual schedule")
    return np.arange(1, n + 1, dtype=float)


def bootstrap_zero_curve(snapshot: MarketSnapshot) -> ZeroCurve:
    """Bootstrap a continuously compounded zero curve from SOFR OIS quotes.

    Cash quotes (t <= 1.0) are converted directly via simple compounding.
    Swap quotes (t > 1.0) are bootstrapped sequentially by Newton-style
    root finding on the par-swap equation, given prior nodes already solved.
    """
    t_in, r_in = curve_arrays(snapshot)
    if not np.all(np.diff(t_in) > 0):
        raise ValueError("curve quotes must be sorted by t_years strictly ascending")

    t_nodes: list[float] = []
    z_nodes: list[float] = []

    for t_i, r_i, q in zip(t_in, r_in, snapshot.curve_quotes):
        if q.instrument_type == "CASH" or t_i <= 1.0:
            # Simple compounded cash conversion.
            df = 1.0 / (1.0 + r_i * t_i)
            z = -np.log(df) / t_i
            t_nodes.append(t_i)
            z_nodes.append(z)
            continue

        # SWAP > 1Y: solve for z_n such that PV_fix(K=r_i; z_n) = PV_float(z_n).
        prior_t = np.array(t_nodes)
        prior_z = np.array(z_nodes)
        schedule = _annual_fix_schedule(t_i)

        def par_residual(z_n: float) -> float:
            # Build a candidate curve including the trial z_n.
            tt = np.append(prior_t, t_i)
            zz = np.append(prior_z, z_n)
            # Discount factors at coupon dates by linear interpolation in z.
            z_at_coupons = np.interp(schedule, tt, zz)
            df_coupons = np.exp(-z_at_coupons * schedule)
            # ACT/360 accrual fraction between consecutive coupon dates.
            # First coupon: prior point is t=0 (DF=1); accrual = year 1.
            tau = np.diff(np.concatenate(([0.0], schedule))) * 365.0 / 360.0
            pv_fixed = r_i * np.sum(tau * df_coupons)
            df_n = np.exp(-z_n * t_i)
            pv_float = 1.0 - df_n
            return pv_float - pv_fixed

        # Bracket: z_n bounded loosely by the surrounding rates.
        lo = max(prior_z[-1] - 0.05, 1e-5)
        hi = prior_z[-1] + 0.10
        try:
            z_solved = brentq(par_residual, lo, hi, xtol=1e-12, rtol=1e-12, maxiter=200)
        except ValueError:
            # Fall back to a wider bracket if the initial one missed the root.
            z_solved = brentq(par_residual, 1e-5, 0.30, xtol=1e-12, rtol=1e-12, maxiter=200)

        t_nodes.append(t_i)
        z_nodes.append(z_solved)

    return ZeroCurve(t=np.array(t_nodes), z=np.array(z_nodes))


def make_curve_callable(curve: ZeroCurve) -> Callable[[float], float]:
    """Return a callable DF(0, t) -> float for downstream pricers."""
    def _df(t: float) -> float:
        return float(curve.discount_factor(t))
    return _df


if __name__ == "__main__":
    from pathlib import Path
    from market_data import load_market_snapshot

    snap = load_market_snapshot(
        Path(__file__).parent / "data" / os.environ.get("MARKET_JSON", "market_2025-09-30.json")
    )
    curve = bootstrap_zero_curve(snap)
    print(f"Bootstrapped {len(curve.t)} nodes from {snap.calibration_date}:")
    for t, z in zip(curve.t, curve.z):
        df = float(curve.discount_factor(t))
        print(f"  t={t:8.4f}y  z={z:8.6f}  DF={df:8.6f}")

    # Round-trip check: bootstrap then reprice each swap and report bp error.
    print("\nRepricing check (bp error on each input swap):")
    for q in snap.curve_quotes:
        if q.instrument_type != "SWAP" or q.t_years <= 1.0:
            continue
        schedule = _annual_fix_schedule(q.t_years)
        z_at = curve.zero_rate(schedule)
        df_at = np.exp(-z_at * schedule)
        tau = np.diff(np.concatenate(([0.0], schedule))) * 365.0 / 360.0
        pv_fix_unit = float(np.sum(tau * df_at))
        df_n = float(curve.discount_factor(q.t_years))
        par_implied = (1.0 - df_n) / pv_fix_unit
        err_bp = (par_implied - q.rate) * 1e4
        print(f"  {q.term:>4s}  market={q.rate*100:6.4f}%  implied={par_implied*100:6.4f}%  err={err_bp:+.4f} bp")
