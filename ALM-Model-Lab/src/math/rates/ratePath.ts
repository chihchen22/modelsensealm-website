/**
 * Concrete RatePath implementations.
 *
 * Phase 2 instruments need a uniform interface for accessing rates regardless
 * of source. DeterministicRatePath wraps the bootstrapped zero curve;
 * StochasticRatePath wraps a single realisation from HW or BGM. Both expose
 * the same `RatePath` surface (see src/math/instruments/types.ts) so an
 * instrument's cashflow generator never branches on rate source.
 */

import type { RatePath } from "../instruments/types";
import type { ZeroCurve } from "./bootstrap";
import { hwForwardRate } from "./simulateHw";

const DT_YEARS_DEFAULT = 1 / 12;

/**
 * RatePath backed by a deterministic forward curve. Forward rates come from
 * the bootstrapped zero curve directly; no Monte Carlo dispersion.
 */
export class DeterministicRatePath implements RatePath {
  readonly nSteps: number;
  readonly times: ReadonlyArray<number>;
  private readonly curve: ZeroCurve;
  private readonly dtYears: number;

  constructor(curve: ZeroCurve, nSteps: number, dtYears: number = DT_YEARS_DEFAULT) {
    this.curve = curve;
    this.nSteps = nSteps;
    this.dtYears = dtYears;
    const times = new Array<number>(nSteps + 1);
    for (let k = 0; k <= nSteps; k++) times[k] = k * dtYears;
    this.times = times;
  }

  rateAt(step: number): number {
    return this.forwardRateAt(step, this.dtYears);
  }

  forwardRateAt(step: number, tenorYears: number): number {
    const t = step * this.dtYears;
    // Use swap-rate convention so long-tenor drivers (mortgage 10Y, etc.)
    // match the bootstrapped OIS par rates rather than overstating via
    // simple compounding.
    return this.curve.forwardSwapRate(t, t + tenorYears);
  }
}

/**
 * State a StochasticRatePath needs to reconstruct term forwards analytically
 * from a single HW realisation instead of averaging realized 1M spots.
 * `xPath[k]` is the latent factor X(t) at sim step k (time (k+1)·dt), aligned
 * index-for-index with the short-rate path.
 */
export interface HWForwardState {
  xPath: ArrayLike<number>;
  a: number;
  sigma: number;
  curve: ZeroCurve;
}

/**
 * Per-path bundle of HW latent state, sufficient to attach `HWForwardState` to
 * every StochasticRatePath in a Monte Carlo set. `xPaths[p]` is path p's latent
 * X(t) series, index-aligned with the p-th MC rate path. `a`, `sigma`, `curve`
 * are shared across paths. Pass `xPaths` straight from `HWSimulationResult.XPaths`
 * (Float64Array[]) — no copy required.
 */
export interface HWForwardBundle {
  xPaths: ReadonlyArray<ArrayLike<number>>;
  a: number;
  sigma: number;
  curve: ZeroCurve;
}

/**
 * RatePath backed by a single 1M-tenor stochastic path realisation.
 *
 * rateAt(step) indexes the 1M reset directly. forwardRateAt depends on how the
 * path was constructed:
 *  - WITH HW state (the `hw` argument): the term forward at (step, tenor) is the
 *    HW analytic par-swap/forward reconstructed from the latent factor X — high
 *    fidelity for any tenor, matching projectHWToTenor / ZeroCurve.forwardSwapRate.
 *    Alignment: step s uses t = s·dt and X = xPath[s-1] (so step and time agree
 *    with DeterministicRatePath); step ≤ 0 returns the deterministic t=0 forward
 *    (the month-1 coupon is locked at origination before any path move). This
 *    reproduces the verified research `stochBench` mapping month m → swap10[m-2].
 *  - WITHOUT HW state: falls back to averaging the spot 1M rates across the tenor
 *    window — a crude proxy retained for callers/models that supply no latent
 *    state (e.g. BGM until it ships its own projector, or unit-test stubs).
 */
export class StochasticRatePath implements RatePath {
  readonly nSteps: number;
  readonly times: ReadonlyArray<number>;
  private readonly path: ReadonlyArray<number>;
  private readonly dtYears: number;
  private readonly hw?: HWForwardState;

  /**
   * @param path Decimal-annualised 1M rate at each monthly step.
   * @param dtYears Step size (default 1/12).
   * @param hw Optional HW latent state enabling analytic term forwards.
   */
  constructor(
    path: ReadonlyArray<number>,
    dtYears: number = DT_YEARS_DEFAULT,
    hw?: HWForwardState,
  ) {
    this.path = path;
    this.nSteps = path.length;
    this.dtYears = dtYears;
    this.hw = hw;
    const times = new Array<number>(path.length + 1);
    for (let k = 0; k <= path.length; k++) times[k] = k * dtYears;
    this.times = times;
  }

  rateAt(step: number): number {
    if (step < 0) return this.path[0];
    if (step >= this.path.length) return this.path[this.path.length - 1];
    return this.path[step];
  }

  forwardRateAt(step: number, tenorYears: number): number {
    const hw = this.hw;
    if (hw) {
      if (step <= 0) return hw.curve.forwardSwapRate(0, tenorYears);
      const t = step * this.dtYears;
      const xi = Math.min(step - 1, hw.xPath.length - 1);
      return hwForwardRate(hw.xPath[xi], hw.a, hw.sigma, hw.curve, t, tenorYears);
    }
    // Fallback: approximate the forward over (t, t+tenor) by averaging the spot
    // 1M rates across the tenor window.
    const nWindow = Math.max(1, Math.round(tenorYears / this.dtYears));
    let sum = 0;
    for (let k = 0; k < nWindow; k++) sum += this.rateAt(step + k);
    return sum / nWindow;
  }
}
