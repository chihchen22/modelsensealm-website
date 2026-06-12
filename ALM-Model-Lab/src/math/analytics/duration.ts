/**
 * Effective duration engine.
 *
 *   D_eff = (PV_- − PV_+) / (2 · PV_0 · Δr)
 *
 * Cashflows are REGENERATED under each shifted rate path, so behavioral
 * responses come through the bump: deposit beta and decay re-simulate,
 * prepayment re-fires. That is the "effective" part — for an NMD the up-shock
 * accelerates runoff and the down-shock slows it, so effective duration sits
 * below the WAL-implied duration (negative convexity of the liability).
 *
 * Conventions (per the EVE design intent in docs/ALM-Skills-and-Engine_handoff_v1.md):
 *  - Discounting on the all-in funding curve — economically the FHLB advance
 *    curve: SOFR zero curve + TLP overlay, DF_allin(t) = DF(t) · exp(−tlp(t)·t),
 *    with the SOFR leg rebuilt from the SHIFTED curve per shock (shockCurve in
 *    bootstrap.ts). The TLP spread over SOFR is held STATIC across simulated
 *    paths and rate shocks: the FHLB curve inherits the SOFR simulation, it is
 *    not simulated as a separate factor.
 *  - The cashflow-side shock is a uniform parallel bump on the projection
 *    path from step 0 (ParallelShockPath below) — the EVE convention, unlike
 *    seg.ts's ShockedPath which preserves the locked first coupon (a SEG/NII
 *    convention).
 *  - Per-scenario stochastic variant: cashflows regenerate per path under the
 *    bumped path; discounting stays on the deterministic shifted all-in curve
 *    (stochastic-cashflow / deterministic-discounting first cut; per-path
 *    shocked DF reconstruction is a later iteration).
 */

import type { Cashflow, RatePath } from "../instruments/types";
import { shockCurve, type ZeroCurve } from "../rates/bootstrap";
import { brentq } from "../rates/rootFind";
import type { TLPCurve } from "../rates/tlpCurve";

/** Uniform parallel bump on a rate path, applied from step 0 (EVE convention). */
export class ParallelShockPath implements RatePath {
  readonly nSteps: number;
  readonly times: ReadonlyArray<number>;
  private readonly base: RatePath;
  private readonly shock: number;

  constructor(base: RatePath, shockBp: number) {
    this.base = base;
    this.shock = shockBp / 1e4;
    this.nSteps = base.nSteps;
    this.times = base.times;
  }

  rateAt(step: number): number {
    return this.base.rateAt(step) + this.shock;
  }

  forwardRateAt(step: number, tenorYears: number): number {
    return this.base.forwardRateAt(step, tenorYears) + this.shock;
  }
}

/**
 * RatePath over an already-projected tenor driver series (the arrays the
 * instrument tabs feed runNMDOnPaths / runMBSOnPaths). The array IS the
 * driver, so rateAt and forwardRateAt both return the series value at the
 * step — matching how the behavioral MC runners consume these paths, and
 * keeping the instrument generators' driver identical to the runners'.
 */
export class DriverPath implements RatePath {
  readonly nSteps: number;
  readonly times: ReadonlyArray<number>;
  private readonly path: ArrayLike<number>;

  constructor(path: ArrayLike<number>, dtYears: number = 1 / 12) {
    this.path = path;
    this.nSteps = path.length;
    const times = new Array<number>(path.length + 1);
    for (let k = 0; k <= path.length; k++) times[k] = k * dtYears;
    this.times = times;
  }

  rateAt(step: number): number {
    if (step < 0) return this.path[0];
    if (step >= this.path.length) return this.path[this.path.length - 1];
    return this.path[step];
  }

  forwardRateAt(step: number, _tenorYears: number): number {
    return this.rateAt(step);
  }
}

/** PV of principal + interest cashflows under the supplied discount function. */
export function pvCashflows(
  cf: ReadonlyArray<Cashflow>,
  df: (tYears: number) => number,
): number {
  let pv = 0;
  for (const c of cf) {
    const t = c.monthOffset / 12;
    pv += df(t) * (c.principalPaid + c.interestPaid);
  }
  return pv;
}

/** Principal-runoff weighted average life in years. */
export function walFromCashflows(cf: ReadonlyArray<Cashflow>, notional: number): number {
  if (notional <= 0) return 0;
  let wal = 0;
  for (const c of cf) {
    wal += (c.principalPaid / notional) * (c.monthOffset / 12);
  }
  return wal;
}

export interface DurationResult {
  pvBase: number;
  pvUp: number;
  pvDown: number;
  /** Effective duration in years: (PV_- − PV_+) / (2 · PV_0 · Δr). */
  effectiveDuration: number;
  shockBp: number;
  /**
   * Flat continuously-compounded spread (bp) solved so the base-leg PV equals
   * the par anchor: a static spread on a deterministic path, an OAS under MC
   * scenarios. 0 when no anchor was requested. Held fixed for the shock legs.
   */
  spreadBp: number;
}

export interface DurationOptions {
  /** Parallel shock size in bp (default 100). */
  shockBp?: number;
  /** "all-in" (SOFR + TLP, default) or "sofr" (risk-free leg only). */
  discountBasis?: "all-in" | "sofr";
  /**
   * Anchor the base PV to this value (typically notional) by solving a flat
   * spread over the discount curve; the spread is then held static under the
   * ±shock legs. This is the standard OAS-style effective duration for
   * premium/discount instruments — without it, a deep-premium mortgage shows
   * near-zero duration because the refi wave destroys the premium under the
   * down-shock.
   */
  parAnchor?: number;
}

/**
 * Effective duration over a set of rate paths (length 1 = deterministic).
 * `generate` regenerates the instrument's cashflows for a given path; PVs are
 * path-averaged per shock leg before differencing.
 */
export function effectiveDurationOnPaths(
  /**
   * Regenerate the instrument's cashflows for a path and the leg's shock (bp,
   * 0 for the base leg). The shock is passed so callers whose behavioral
   * "moneyness" is measured against rate HISTORY (e.g. the Non-IB NMD's
   * trailing-MA spread) can shift that history by the same parallel amount —
   * a level shock is a shift of the whole rate environment, not just the
   * forward path. Callers whose driver lives entirely in the path (mortgage
   * rate, IB deposit-rate β(r)·r) can ignore the second argument.
   */
  generate: (path: RatePath, shockBp: number) => Cashflow[],
  paths: ReadonlyArray<RatePath>,
  curve: ZeroCurve,
  tlp: TLPCurve,
  opts?: DurationOptions,
): DurationResult {
  const shockBp = opts?.shockBp ?? 100;
  const basis = opts?.discountBasis ?? "all-in";
  if (paths.length === 0) {
    return { pvBase: 0, pvUp: 0, pvDown: 0, effectiveDuration: 0, shockBp, spreadBp: 0 };
  }

  const dfFor = (bp: number): ((t: number) => number) => {
    const c = bp === 0 ? curve : shockCurve(curve, bp);
    if (basis === "sofr") return (t) => c.discountFactor(t);
    return (t) => (t <= 0 ? 1 : c.discountFactor(t) * Math.exp(-tlp.tlp(t) * t));
  };

  // Cashflows regenerate once per shock leg; PV-at-spread is then cheap, so
  // the par-anchor root-find re-prices without re-simulating.
  const legShocks = [0, +shockBp, -shockBp] as const;
  const legCashflows = legShocks.map((bp) =>
    paths.map((p) => generate(bp === 0 ? p : new ParallelShockPath(p, bp), bp)),
  );
  const legDfs = legShocks.map((bp) => dfFor(bp));
  const meanPVAt = (leg: number, spread: number): number => {
    const df = legDfs[leg];
    let sum = 0;
    for (const cf of legCashflows[leg]) {
      sum += pvCashflows(cf, (t) => df(t) * Math.exp(-spread * t));
    }
    return sum / legCashflows[leg].length;
  };

  let spread = 0;
  if (opts?.parAnchor !== undefined && opts.parAnchor > 0) {
    const target = opts.parAnchor;
    spread = brentq((s) => meanPVAt(0, s) - target, -0.15, 0.3);
  }

  const pvBase = meanPVAt(0, spread);
  const pvUp = meanPVAt(1, spread);
  const pvDown = meanPVAt(2, spread);
  const dr = shockBp / 1e4;
  const effectiveDuration = pvBase > 0 ? (pvDown - pvUp) / (2 * pvBase * dr) : 0;
  return { pvBase, pvUp, pvDown, effectiveDuration, shockBp, spreadBp: spread * 1e4 };
}
