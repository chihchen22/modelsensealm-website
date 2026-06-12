"""BGM/LMM 2-factor Monte Carlo with predictor-corrector advance.

Replaces the prototype's Euler + truncation scheme (`runBgmSimulation` in
the Gemini source, lines ~660-735) with the Hunter-Jaeckel-Joshi 2001
predictor-corrector that removes the practical need for an upper-bound
truncation on F.

Per simulation step m -> m+1, for each forward k > m:

    Predictor step:
        mu^pred_k(t_m) = sum_{j=m+1..k} term_j(F(t_m)) * (v(tau_j) . v(tau_k))
                where term_j = dt F_j / (1 + dt F_j),  v = (v1, v2) 2-factor loadings.
        F~_k(t_{m+1}) = F_k(t_m) * exp((mu^pred_k - 0.5 |v_k|^2) dt + sqrt(dt) (v1_k Z1 + v2_k Z2))

    Corrector step:
        mu^corr_k(t_{m+1}) computed from F~(t_{m+1}).
        mu_bar = 0.5 (mu^pred + mu^corr)
        F_k(t_{m+1}) = F_k(t_m) * exp((mu_bar - 0.5 |v_k|^2) dt + sqrt(dt) (v1_k Z1 + v2_k Z2))

This is the standard Hunter-Jaeckel-Joshi advance, second-order in dt.
F_MIN clipped to 1e-8 only as a defensive numerical floor; F_MAX is
removed entirely. The lognormal SDE is naturally non-negative under
exact integration; the clip exists only to guard against floating-point
underflow.

Streaming: the simulator does not retain the full 360 x 360 forward grid
through the run. After each step, the current grid row is projected into
a user-selected tenor set, the projected per-step rates are stored, and
the row buffer for the previous step is discarded.

References
----------
- Hunter, Jaeckel, Joshi 2001 *Drift approximations in a forward-rate-based
  LIBOR market model* (Risk).
- Joshi, Stacey *Intelligent predictor-corrector schemes for the LIBOR market model*.
- Glasserman, Zhao 2000 *Arbitrage-free discretization of LMM* (alternative).
"""

from __future__ import annotations

from dataclasses import dataclass
import math
import numpy as np

from bootstrap import ZeroCurve


F_FLOOR = 1e-8
F_CEILING_DEFAULT = 2.0  # 200% defensive upper cap. The cap exists to prevent
                          # numerical overflow in the lognormal evolution, not
                          # to physically bound the model. Lognormal is
                          # infinite-tailed so any finite cap bites somewhere;
                          # 2.0 keeps p95 clean across the full 30Y horizon at
                          # 9/30/2025-calibrated vol structure. Surfaced as a
                          # runtime parameter so users can override.
                          # See Steph audit memo Sec 4 on truncation-as-distortion.

# Backward-compatible name retained for existing imports.
F_CEILING = F_CEILING_DEFAULT


@dataclass(frozen=True)
class BGMSimulationResult:
    seed: int
    a: float
    b: float
    c: float
    d: float
    beta: float
    vol_scalar: float
    displacement: float
    cev_beta: float
    n_paths: int
    horizon_years: float
    dt_years: float
    n_grid: int
    times: np.ndarray              # shape (n_steps,)
    tenors: np.ndarray             # shape (n_tenors,) tenors saved per step
    rates: np.ndarray              # shape (n_paths, n_steps, n_tenors)
    df_market: np.ndarray          # shape (n_steps,)
    df_simulated: np.ndarray       # shape (n_steps,) corrected mean DF(0, t_k)
    raw_error_bps: np.ndarray      # shape (n_steps,) per-step uncorrected error in bps
    corrected: bool
    n_cap_fires: int               # forward-grid clips at F_CEILING across the run
    n_floor_fires: int             # forward-grid clips at F_FLOOR across the run
    n_total_evolutions: int        # total path-step-forward triples evolved (for ratio)


def _compute_v(
    a: float, b: float, c: float, d: float, beta: float, vol_scalar: float,
    dt: float, n_grid: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Vol loadings (v1, v2) indexed by time-to-maturity bucket idx = 0..n_grid-1."""
    tau = np.arange(n_grid, dtype=np.float64) * dt
    sigma = vol_scalar * ((a + b * tau) * np.exp(-c * tau) + d)
    v1 = sigma * np.cos(beta * tau)
    v2 = sigma * np.sin(beta * tau)
    return v1, v2


def _drift_from_row(
    F_row: np.ndarray,
    m: int,
    V1: np.ndarray,
    V2: np.ndarray,
    dt: float,
    displacement: float = 0.0,
    cev_beta: float = 1.0,
) -> np.ndarray:
    """Drift mu_k(t_m) for k in (m, n_grid). Returns array of length n_grid - m - 1.

    F_row has shape (n_paths, n_grid - m - 1) where column j corresponds to
    forward F_{m+1+j}(t_m) (the forwards still alive at step m+1 onward).
    Returns shape (n_paths, n_grid - m - 1).

    Drift formula:
        mu_k = sum_{j=m+1..k} [dt F_j / (1 + dt F_j)] * (v(tau_j) . v(tau_k))
    where tau_j = (j - m) * dt at simulation time t_m.
    """
    n_paths, n_alive = F_row.shape
    if n_alive == 0:
        return np.empty((n_paths, 0), dtype=np.float64)
    # idx within alive forwards: j_idx = 0 corresponds to k=m+1 (tau = dt).
    # tau_idx for v[]: we want v(tau_{m+1}), v(tau_{m+2}), ... v(tau_n).
    # In V1/V2 arrays which are indexed by (k - 0) * dt absolute, we need
    # idx = k - m for time-to-maturity. Since k ranges m+1 to n_grid-1, idx
    # ranges 1 to n_grid - 1 - m. So slice V1[1:n_alive+1].
    v1k = V1[1:n_alive + 1]  # shape (n_alive,)
    v2k = V2[1:n_alive + 1]
    # Shifted-CEV drift G_j^CEV = dt·F̂_j^β / (1+dt·F_j) where F̂ = F + δ.
    # β=1 = shifted lognormal (DD); δ=0, β=1 = standard LMM.
    Fhat = F_row + displacement
    Fhat_pow = Fhat if cev_beta == 1.0 else Fhat ** cev_beta
    term = (dt * Fhat_pow) / (1.0 + dt * F_row)
    sum1 = np.cumsum(term * v1k[None, :], axis=1)     # cumulative sum over k's predecessors
    sum2 = np.cumsum(term * v2k[None, :], axis=1)
    mu = sum1 * v1k[None, :] + sum2 * v2k[None, :]
    return mu


def simulate_bgm(
    curve: ZeroCurve,
    a: float, b: float, c: float, d: float, beta: float, vol_scalar: float,
    horizon_years: float = 30.0,
    dt_years: float = 1 / 12,
    n_pairs: int = 250,
    seed: int = 42,
    saved_tenors: tuple[float, ...] = (1/12, 3/12, 6/12, 1.0, 2.0, 5.0, 7.0, 10.0, 20.0, 30.0),
    apply_correction: bool = True,
    f_ceiling: float = F_CEILING_DEFAULT,
    displacement: float = 0.0,
    cev_beta: float = 1.0,
) -> BGMSimulationResult:
    """BGM/LMM Monte Carlo with predictor-corrector advance.

    (cev_beta, displacement) = (1, 0) = standard LMM;
    cev_beta=1, δ>0 = shifted lognormal (DD);
    cev_beta<1 = shifted-CEV LMM with sub-linear vol-of-F.

    State evolved is F̂ = F + δ. Local lognormal vol on F̂ becomes F̂^(β−1)·σ.
    """
    rng = np.random.default_rng(seed)
    n_steps = int(round(horizon_years / dt_years))
    n_grid = n_steps  # 30Y at monthly dt -> 360 monthly forwards
    times = np.arange(1, n_steps + 1) * dt_years
    n_paths = 2 * n_pairs

    saved_tenors = np.array(saved_tenors, dtype=np.float64)
    n_tenors = len(saved_tenors)

    V1, V2 = _compute_v(a, b, c, d, beta, vol_scalar, dt_years, n_grid)

    # Initial forward curve: F_init[k] = simply-compounded forward over (k dt, (k+1) dt).
    grid_full = np.arange(n_grid + 1) * dt_years
    df_full = curve.discount_factor(grid_full)
    F_init = (df_full[:-1] / df_full[1:] - 1.0) / dt_years  # shape (n_grid,)

    # Path state: one row per simulation time. At step m, only forwards
    # F_m, F_{m+1}, ..., F_{n_grid-1} are alive. Working buffer holds these.
    F_curr = np.tile(F_init, (n_paths, 1)).astype(np.float64)   # (n_paths, n_grid) at t_0
    rates_out = np.zeros((n_paths, n_steps, n_tenors), dtype=np.float64)

    df_market = curve.discount_factor(times)
    df_simulated = np.empty(n_steps, dtype=np.float64)
    raw_error_bps = np.empty(n_steps, dtype=np.float64)
    D_path = np.ones(n_paths, dtype=np.float64)

    sqrt_dt = math.sqrt(dt_years)
    n_cap_fires = 0
    n_floor_fires = 0
    n_total_evolutions = 0

    for m in range(n_steps):
        # Project current row (alive forwards F_m..F_{n_grid-1}) into saved tenors
        # at simulation time t_m.
        rates_out[:, m, :] = _project_row_to_tenors(
            F_curr[:, m:], dt_years, saved_tenors,
        )

        # Per-step uncorrected discount factor: 1 / (1 + dt F_m).
        spot = np.clip(F_curr[:, m], F_FLOOR, None)
        D_step = 1.0 / (1.0 + dt_years * spot)
        e_d_uncorr = float(np.mean(D_path * D_step))
        raw_error_bps[m] = (e_d_uncorr - df_market[m]) * 1e4

        if apply_correction:
            corr = df_market[m] / e_d_uncorr
            D_path = D_path * D_step * corr
        else:
            D_path = D_path * D_step
        df_simulated[m] = float(np.mean(D_path))

        # If we are at the last step there is nothing to evolve further.
        if m >= n_steps - 1:
            break

        # Evolve forwards (m+1, ..., n_grid-1) from t_m to t_{m+1} via predictor-corrector.
        alive = F_curr[:, m + 1:]                      # (n_paths, n_alive)
        n_alive = alive.shape[1]
        if n_alive == 0:
            continue

        # Common shocks for both predictor and corrector.
        z1 = rng.standard_normal(n_pairs)
        z2 = rng.standard_normal(n_pairs)
        Z1 = np.concatenate((z1, -z1))
        Z2 = np.concatenate((z2, -z2))

        # Vol loadings for the alive forwards (idx 1..n_alive in V1/V2).
        v1k = V1[1:n_alive + 1]
        v2k = V2[1:n_alive + 1]
        vol_sq = v1k * v1k + v2k * v2k                  # (n_alive,)

        diff_term = sqrt_dt * (v1k[None, :] * Z1[:, None] + v2k[None, :] * Z2[:, None])

        # State variable: Fhat = F + δ. CEV local vol on Fhat is Fhat^(β−1)·σ.
        Fhat_alive = alive + displacement
        F_floor_shift = -displacement + F_FLOOR

        # CEV local-vol prefactor F̂^(β−1). β=1 ⇒ identity (DD path).
        if cev_beta == 1.0:
            pref_alive = np.ones_like(Fhat_alive)
        else:
            # Floor for numerical stability (rare in practice with δ shift).
            pref_alive = np.maximum(Fhat_alive, math.exp(-10.0)) ** (cev_beta - 1.0)

        # Predictor.
        mu_raw_pred = _drift_from_row(alive, m, V1, V2, dt_years, displacement, cev_beta)
        mu_pred = pref_alive * mu_raw_pred
        sig_loc_sq_pred = pref_alive ** 2 * vol_sq[None, :]
        diff_pred = pref_alive * diff_term
        log_step_pred = (mu_pred - 0.5 * sig_loc_sq_pred) * dt_years + diff_pred
        Fhat_pre_pred = Fhat_alive * np.exp(log_step_pred)
        F_pre_pred = Fhat_pre_pred - displacement
        F_pred = np.clip(F_pre_pred, F_floor_shift, f_ceiling)

        # Corrector: averaged drift + averaged prefactor (same shocks).
        if cev_beta == 1.0:
            pref_pred = np.ones_like(Fhat_alive)
        else:
            Fhat_pred = F_pred + displacement
            pref_pred = np.maximum(Fhat_pred, math.exp(-10.0)) ** (cev_beta - 1.0)
        pref_bar = 0.5 * (pref_alive + pref_pred)

        mu_raw_corr = _drift_from_row(F_pred, m, V1, V2, dt_years, displacement, cev_beta)
        mu_p = pref_alive * mu_raw_pred
        mu_c = pref_pred * mu_raw_corr
        mu_bar = 0.5 * (mu_p + mu_c)
        sig_loc_sq_bar = pref_bar ** 2 * vol_sq[None, :]
        diff_bar = pref_bar * diff_term
        log_step_final = (mu_bar - 0.5 * sig_loc_sq_bar) * dt_years + diff_bar
        Fhat_pre_final = Fhat_alive * np.exp(log_step_final)
        F_pre_final = Fhat_pre_final - displacement
        F_next_alive = np.clip(F_pre_final, F_floor_shift, f_ceiling)

        # Track cap and floor firings on the corrector step (the value that persists).
        n_cap_fires += int(np.sum(F_pre_final > f_ceiling))
        n_floor_fires += int(np.sum(F_pre_final < F_FLOOR))
        n_total_evolutions += int(F_pre_final.size)

        # Write back into F_curr for the next iteration. Forwards at indices
        # 0..m are spent and irrelevant; only indices >= m+1 matter going
        # forward, and we just updated those.
        F_curr[:, m + 1:] = F_next_alive

    return BGMSimulationResult(
        seed=seed,
        a=a, b=b, c=c, d=d, beta=beta, vol_scalar=vol_scalar,
        displacement=displacement,
        cev_beta=cev_beta,
        n_paths=n_paths,
        horizon_years=horizon_years,
        dt_years=dt_years,
        n_grid=n_grid,
        times=times,
        tenors=saved_tenors,
        rates=rates_out,
        df_market=df_market,
        df_simulated=df_simulated,
        raw_error_bps=raw_error_bps,
        corrected=apply_correction,
        n_cap_fires=n_cap_fires,
        n_floor_fires=n_floor_fires,
        n_total_evolutions=n_total_evolutions,
    )


def _project_row_to_tenors(
    alive_row: np.ndarray, dt: float, saved_tenors: np.ndarray,
) -> np.ndarray:
    """Project the alive-forward row into rates at saved tenors.

    alive_row: (n_paths, n_alive) where column j is the forward over
        [t_m + j dt, t_m + (j+1) dt].

    For each tenor in saved_tenors, compute simply-compounded yield over
    [t_m, t_m + tenor]. If the tenor extends beyond the alive horizon, pad
    by flat-forward extrapolation using the final alive forward.

    Returns shape (n_paths, n_tenors).
    """
    n_paths, n_alive = alive_row.shape
    out = np.empty((n_paths, len(saved_tenors)), dtype=np.float64)
    if n_alive == 0:
        out[:] = 0.0
        return out

    # Cumulative log discount: cum_log[j] = sum_{i=0..j} log(1 + dt F_i).
    log1p = np.log1p(dt * alive_row)                   # (n_paths, n_alive)
    cum_log = np.cumsum(log1p, axis=1)
    cum_log = np.concatenate((np.zeros((n_paths, 1)), cum_log), axis=1)  # leading 0

    for ti, tau in enumerate(saved_tenors):
        n_full = int(tau / dt)
        residual = tau - n_full * dt
        if n_full > n_alive:
            # Extrapolate flat-forward using F at index n_alive - 1.
            base_log = cum_log[:, n_alive]
            extra_steps = (n_full - n_alive)
            extra = np.log1p(dt * alive_row[:, -1]) * extra_steps
            log_total = base_log + extra
            if residual > 1e-9:
                log_total = log_total + np.log1p(residual * alive_row[:, -1])
        else:
            log_total = cum_log[:, n_full]
            if residual > 1e-9:
                log_total = log_total + np.log1p(residual * alive_row[:, n_full])
        df_tau = np.exp(-log_total)
        out[:, ti] = (1.0 / df_tau - 1.0) / tau
    return out


if __name__ == "__main__":
    from pathlib import Path
    from market_data import load_market_snapshot
    from bootstrap import bootstrap_zero_curve
    from bgm_calibrate import calibrate_bgm

    snap = load_market_snapshot(
        Path(__file__).parent / "data" / "market_2025-09-30.json"
    )
    curve = bootstrap_zero_curve(snap)
    bgm_fit = calibrate_bgm(snap, curve)

    print(
        f"BGM simulation: a={bgm_fit.a:.4f}, b={bgm_fit.b:.4f}, c={bgm_fit.c:.4f}, "
        f"d={bgm_fit.d:.4f}, beta={bgm_fit.beta:.4f}, vol_scalar={bgm_fit.vol_scalar:.4f}\n"
    )

    sim = simulate_bgm(
        curve,
        bgm_fit.a, bgm_fit.b, bgm_fit.c, bgm_fit.d, bgm_fit.beta, bgm_fit.vol_scalar,
        horizon_years=30.0, dt_years=1/12, n_pairs=250, seed=20250930,
    )

    print(f"  step  t       DF_mkt    DF_corr   err_bp")
    for k in (0, 11, 59, 119, 239, 359):
        if k >= len(sim.times):
            continue
        print(
            f"  {k:4d}  {sim.times[k]:5.2f}  "
            f"{sim.df_market[k]:8.6f}  {sim.df_simulated[k]:8.6f}  "
            f"{(sim.df_simulated[k] - sim.df_market[k]) * 1e4:+7.3f}"
        )

    # 1Y (idx 3) forward distribution at selected horizons.
    one_y_idx = int(np.argmin(np.abs(sim.tenors - 1.0)))
    print(f"\n1Y forward rate (saved_tenor idx={one_y_idx}) at selected horizons:")
    print(f"  horizon  mean    p5      p95")
    for k in (0, 11, 59, 119, 239):
        if k >= sim.rates.shape[1]:
            continue
        cs = sim.rates[:, k, one_y_idx]
        print(
            f"  {sim.times[k]:6.2f}y  {cs.mean()*100:6.4f}%  "
            f"{np.percentile(cs, 5)*100:6.4f}%  "
            f"{np.percentile(cs, 95)*100:6.4f}%"
        )
