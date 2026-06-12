/**
 * SOFR OIS zero-coupon bootstrap.
 *
 * Port of `research/bootstrap.py`. Conventions match USD SOFR OIS practice:
 * - Day count: ACT/360 (annual fixed coupon = 365/360 fraction).
 * - Cash leg: simple compounding DF = 1 / (1 + r * t).
 * - Swap leg: annual fixed schedule, par equation solved by Brent root finding.
 * - Interpolation between zero-rate nodes: linear in zero rate.
 *
 * References
 * - Andersen-Piterbarg Vol I Sec 6 (curve construction).
 */

import type { MarketSnapshot } from "./marketData";
import { brentq } from "./rootFind";

export interface ZeroCurve {
  readonly t: number[]; // tenors in years
  readonly z: number[]; // continuously compounded zero rates
  zeroRate(time: number): number;
  discountFactor(time: number): number;
  /**
   * Simply-compounded forward rate over [t1, t2]:
   *   f = (P(t1)/P(t2) - 1) / (t2 - t1)
   * Money-market convention. Correct for τ ≤ 1Y (caps, FTP, SOFR fix
   * derivation). For τ > 1Y, use forwardSwapRate instead — simple
   * compounding overstates long-tenor rates by hundreds of bps.
   */
  forwardRate(t1: number, t2: number): number;
  /**
   * Forward par swap rate for an annual ACT/360 fixed schedule:
   *   For τ < 1Y: simple-compounded forward (single-payment OIS convention).
   *   For τ ≥ 1Y, integer: S = (P(t1) - P(t2)) / (Σ_k (365/360) · P(t1+k)).
   * This matches the convention used by the bootstrap (par OIS) and by
   * buildSwap (BGM/SABR-on-swaptions). Use this for any swap-rate driver
   * (mortgage prepayment, long-tenor forward display, etc.).
   */
  forwardSwapRate(t1: number, t2: number): number;
}

/** Annual fixed coupon fraction for SOFR OIS (ACT/360). */
const ACT_360_ANNUAL = 365 / 360;

function lerp(xs: number[], ys: number[], x: number): number {
  if (xs.length === 0) return 0;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[xs.length - 1];
  // binary search would be O(log n); array sizes are tiny here
  for (let i = 0; i < xs.length - 1; i++) {
    if (x >= xs[i] && x <= xs[i + 1]) {
      const w = (x - xs[i]) / (xs[i + 1] - xs[i]);
      return ys[i] * (1 - w) + ys[i + 1] * w;
    }
  }
  return ys[ys.length - 1];
}

function makeCurve(t: number[], z: number[]): ZeroCurve {
  return {
    t,
    z,
    zeroRate(time: number): number {
      return lerp(t, z, time);
    },
    discountFactor(time: number): number {
      return Math.exp(-this.zeroRate(time) * time);
    },
    forwardRate(t1: number, t2: number): number {
      if (t2 <= t1) {
        throw new Error(`forwardRate: t2=${t2} must exceed t1=${t1}`);
      }
      return (this.discountFactor(t1) / this.discountFactor(t2) - 1) / (t2 - t1);
    },
    forwardSwapRate(t1: number, t2: number): number {
      if (t2 <= t1) {
        throw new Error(`forwardSwapRate: t2=${t2} must exceed t1=${t1}`);
      }
      const tau = t2 - t1;
      // Boundary matches the bootstrap:
      //   τ ≤ 1Y → cash / single-payment OIS, simple-compounded
      //            (no ACT/360 day-count scaling — same convention the
      //            bootstrap uses for q.tYears ≤ 1.0, so round-trip is exact).
      //   τ > 1Y → annual ACT/360 fixed schedule, par swap rate
      //            (same as bgmPricing.buildSwap).
      if (tau <= 1.0 + 1e-9) {
        return (this.discountFactor(t1) / this.discountFactor(t2) - 1) / tau;
      }
      const n = Math.round(tau);
      let annuity = 0;
      for (let k = 1; k <= n; k++) {
        annuity += ACT_360_ANNUAL * this.discountFactor(t1 + k);
      }
      const P1 = this.discountFactor(t1);
      const Pn = this.discountFactor(t1 + n);
      return (P1 - Pn) / annuity;
    },
  };
}

function annualFixSchedule(tN: number): number[] {
  const n = Math.round(tN);
  if (Math.abs(n - tN) > 1e-6) {
    throw new Error(`non-integer maturity ${tN} not supported by annual schedule`);
  }
  const sched: number[] = [];
  for (let i = 1; i <= n; i++) sched.push(i);
  return sched;
}

export function bootstrapZeroCurve(snapshot: MarketSnapshot): ZeroCurve {
  const quotes = [...snapshot.curveQuotes];
  for (let i = 0; i < quotes.length - 1; i++) {
    if (!(quotes[i].tYears < quotes[i + 1].tYears)) {
      throw new Error("curve quotes must be strictly ascending in t_years");
    }
  }

  const tNodes: number[] = [];
  const zNodes: number[] = [];

  for (const q of quotes) {
    if (q.instrumentType === "CASH" || q.tYears <= 1.0) {
      const df = 1.0 / (1.0 + q.rate * q.tYears);
      const z = -Math.log(df) / q.tYears;
      tNodes.push(q.tYears);
      zNodes.push(z);
      continue;
    }

    const priorT = [...tNodes];
    const priorZ = [...zNodes];
    const schedule = annualFixSchedule(q.tYears);

    const parResidual = (zN: number): number => {
      const tt = [...priorT, q.tYears];
      const zz = [...priorZ, zN];
      let pvFixed = 0;
      let prevDate = 0;
      for (const couponDate of schedule) {
        const zAt = lerp(tt, zz, couponDate);
        const dfAt = Math.exp(-zAt * couponDate);
        const tau = (couponDate - prevDate) * (365 / 360);
        pvFixed += q.rate * tau * dfAt;
        prevDate = couponDate;
      }
      const dfN = Math.exp(-zN * q.tYears);
      const pvFloat = 1.0 - dfN;
      return pvFloat - pvFixed;
    };

    const lo = Math.max(priorZ[priorZ.length - 1] - 0.05, 1e-5);
    const hi = priorZ[priorZ.length - 1] + 0.10;
    let zSolved: number;
    try {
      zSolved = brentq(parResidual, lo, hi);
    } catch {
      zSolved = brentq(parResidual, 1e-5, 0.30);
    }
    tNodes.push(q.tYears);
    zNodes.push(zSolved);
  }

  return makeCurve(tNodes, zNodes);
}

/**
 * Parallel-shifted copy of a zero curve: every node's zero rate moves by
 * shockBp. Interpolation is linear in zero rate, so zeroRate(t) shifts by
 * exactly s at every t and discount factors scale by exp(-s·t). This is the
 * EVE-style curve shock (discounting side); ShockedPath in seg.ts shifts only
 * the projection path (cashflow side).
 */
export function shockCurve(curve: ZeroCurve, shockBp: number): ZeroCurve {
  const s = shockBp / 1e4;
  return makeCurve([...curve.t], curve.z.map((z) => z + s));
}

export function _annualFixSchedule(tN: number): number[] {
  return annualFixSchedule(tN);
}

export function _curveLerp(t: number[], z: number[], x: number): number {
  return lerp(t, z, x);
}
