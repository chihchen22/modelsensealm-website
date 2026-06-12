/**
 * Stochastic option-adjusted FTP primitives.
 *
 * The deterministic counterpart (analytics/ftp.ts) par-matches an instrument's
 * cashflows on a single forward-implied path. For instruments with embedded
 * rate optionality — the prepayable mortgage above all — a single path misses
 * the convexity the option creates: the borrower prepays disproportionately
 * when rates fall, so the expected transfer rate over the Hull-White path
 * distribution is not the transfer rate of the expected (single-path) cashflow.
 *
 * These primitives operate on per-path cashflow sets and per-path money-market
 * discount factors (reconstructPathDF, in rates/simulateHw) to deliver:
 *   - the path-averaged par-coupon FTP rate (IR / all-in / LP triple), linear
 *     in the rate so the cross-path expectation is a direct solve, no root find
 *     and no dropped covariance term;
 *   - the option-adjusted spread (OAS) and its static analog the Z-spread, by
 *     root find on the per-path / single-path price.
 *
 * The option cost is read two equivalent ways: as the IR-leg vol value
 * (stochastic option premium minus the deterministic option premium) on the
 * par-rate functional, and as Z minus OAS on the price functional. Both are
 * SOFR-only and corroborate to within a few bp (distinct functionals).
 *
 * Lifted verbatim (arithmetic-identical) from research/ch04_ftp_stochastic.ts,
 * which now imports these so the Ch4 bit-exact regression guards this module.
 */

import { brentq } from "../rates/rootFind";
import type { ZeroCurve } from "../rates/bootstrap";
import type { TLPCurve } from "../rates/tlpCurve";

const DT_YEARS = 1 / 12;

/** Default OAS / Z-spread search bracket (decimal continuous spread). */
const SPREAD_BOUNDS: readonly [number, number] = [-0.02, 0.2];

/**
 * Minimal cashflow shape the FTP primitives consume. `monthOffset` is the
 * 1-based month index; `balanceStart` is the outstanding balance entering the
 * month (the annuity base); `principalPaid` / `interestPaid` are that month's
 * paydown and accrued interest.
 */
export interface FtpCashflow {
  monthOffset: number;
  balanceStart: number;
  principalPaid: number;
  interestPaid: number;
}

/** IR FTP (SOFR), LP FTP (residual), all-in FTP (SOFR + TLP). lp = all - ir. */
export interface FtpTriple {
  ir: number;
  lp: number;
  all: number;
}

/** Per-path discount: `dfp(pathIndex, tYears)` → money-market DF on that path. */
export type PathDiscount = (pathIndex: number, tYears: number) => number;

/** Single-path discount: `df(tYears)` → DF at t. */
export type Discount = (tYears: number) => number;

/**
 * Linear par-coupon rate for one cashflow stream under discount `df`:
 *   r = (N − Σ df(tᵢ)·Pᵢ) / (Σ df(tᵢ)·Bᵢ₋₁·Δt)
 */
export function parRateSingle(
  cf: ReadonlyArray<FtpCashflow>,
  notional: number,
  df: Discount,
): number {
  let pvPrincipal = 0;
  let annuity = 0;
  for (const c of cf) {
    const t = c.monthOffset / 12;
    const d = df(t);
    pvPrincipal += d * c.principalPaid;
    annuity += d * c.balanceStart * DT_YEARS;
  }
  return annuity > 1e-12 ? (notional - pvPrincipal) / annuity : 0;
}

/**
 * Path-averaged par-coupon rate. The par-match is linear in r, so the
 * cross-path expectation is the par rate of the expected price — a ratio of
 * sums, no per-path solve:
 *   r = (P·N − Σ_p Σ_i df_p(tᵢ)·P_{i,p}) / (Σ_p Σ_i df_p(tᵢ)·B_{i-1,p}·Δt)
 */
export function parRatePathAveraged(
  cfPerPath: ReadonlyArray<ReadonlyArray<FtpCashflow>>,
  notional: number,
  dfp: PathDiscount,
): number {
  const P = cfPerPath.length;
  let pvPrincipal = 0;
  let annuity = 0;
  for (let p = 0; p < P; p++) {
    for (const c of cfPerPath[p]) {
      const t = c.monthOffset / 12;
      const d = dfp(p, t);
      pvPrincipal += d * c.principalPaid;
      annuity += d * c.balanceStart * DT_YEARS;
    }
  }
  return annuity > 1e-12 ? (P * notional - pvPrincipal) / annuity : 0;
}

/** PV of actual (principal + interest) cashflows on one path at extra spread s. */
export function priceSingleAtSpread(
  cf: ReadonlyArray<FtpCashflow>,
  df: Discount,
  s: number,
): number {
  let total = 0;
  for (const c of cf) {
    const t = c.monthOffset / 12;
    total += df(t) * Math.exp(-s * t) * (c.principalPaid + c.interestPaid);
  }
  return total;
}

/** Mean across paths of the actual-cashflow PV at extra spread s. */
export function meanPriceAtSpread(
  cfPerPath: ReadonlyArray<ReadonlyArray<FtpCashflow>>,
  baseDfp: PathDiscount,
  s: number,
): number {
  const P = cfPerPath.length;
  let total = 0;
  for (let p = 0; p < P; p++) {
    for (const c of cfPerPath[p]) {
      const t = c.monthOffset / 12;
      total += baseDfp(p, t) * Math.exp(-s * t) * (c.principalPaid + c.interestPaid);
    }
  }
  return total / P;
}

/**
 * Z-spread: the static (single-path) constant spread over the base discount
 * that reprices the actual cashflows to `targetPrice` (par = notional).
 */
export function solveZSpread(
  cf: ReadonlyArray<FtpCashflow>,
  df: Discount,
  targetPrice: number,
  bounds: readonly [number, number] = SPREAD_BOUNDS,
): number {
  return brentq((s: number) => priceSingleAtSpread(cf, df, s) - targetPrice, bounds[0], bounds[1]);
}

/**
 * OAS: the constant spread over the per-path base discounts that reprices the
 * mean actual-cashflow PV to `targetPrice` (par = notional). The stochastic
 * analog of the Z-spread; Z − OAS is the option cost.
 */
export function solveOAS(
  cfPerPath: ReadonlyArray<ReadonlyArray<FtpCashflow>>,
  baseDfp: PathDiscount,
  targetPrice: number,
  bounds: readonly [number, number] = SPREAD_BOUNDS,
): number {
  return brentq(
    (s: number) => meanPriceAtSpread(cfPerPath, baseDfp, s) - targetPrice,
    bounds[0],
    bounds[1],
  );
}

/** Map time t (years) to the 0-based monthly step index of a per-path DF row. */
function dfIndexAt(t: number): number {
  return Math.round(t * 12) - 1;
}

/**
 * Stochastic IR / all-in / LP par-coupon triple. `Dcorr[p][k]` is the
 * terminally-corrected money-market DF to time (k+1)/12 on path p
 * (reconstructPathDF). IR discounts on SOFR alone; all-in multiplies by the TLP
 * discount factor at the cashflow time.
 */
export function stochasticFtpTriple(
  cfPerPath: ReadonlyArray<ReadonlyArray<FtpCashflow>>,
  notional: number,
  Dcorr: ReadonlyArray<ArrayLike<number>>,
  tlp: TLPCurve,
): FtpTriple {
  const dfIR: PathDiscount = (p, t) => {
    const k = dfIndexAt(t);
    return k < 0 ? 1 : Dcorr[p][Math.min(k, Dcorr[p].length - 1)];
  };
  const dfAll: PathDiscount = (p, t) => dfIR(p, t) * Math.exp(-tlp.tlp(t) * t);
  const ir = parRatePathAveraged(cfPerPath, notional, dfIR);
  const all = parRatePathAveraged(cfPerPath, notional, dfAll);
  return { ir, lp: all - ir, all };
}

/** Deterministic (single forward-implied path) IR / all-in / LP triple. */
export function deterministicFtpTriple(
  cf: ReadonlyArray<FtpCashflow>,
  notional: number,
  curve: ZeroCurve,
  tlp: TLPCurve,
): FtpTriple {
  const dfIR: Discount = (t) => curve.discountFactor(t);
  const dfAll: Discount = (t) => curve.discountFactor(t) * Math.exp(-tlp.tlp(t) * t);
  const ir = parRateSingle(cf, notional, dfIR);
  const all = parRateSingle(cf, notional, dfAll);
  return { ir, lp: all - ir, all };
}
