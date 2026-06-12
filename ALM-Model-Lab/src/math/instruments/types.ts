/**
 * Instrument abstraction for ALM Model Lab.
 *
 * Phase 1: types only. Concrete instruments arrive in Phase 2 (Fixed Loan,
 * Floating Loan), Phase 5 (Mortgage), Phases 6-7 (NMD with age, NMD-β).
 *
 * Design intent:
 *   - Every instrument exposes the same surface: terms, cashflows, repricing
 *     schedule, liquidity schedule. ALM analytics (repricing gap, liquidity
 *     gap, FTP, SEG/EBP) operate on `Instrument[]` and a `RatePath` — they
 *     don't care which concrete instrument they're seeing.
 *   - Rate paths are themselves an interface so the same instrument can be
 *     evaluated under a deterministic forward curve, an HW path, or a BGM
 *     path with no special-casing.
 *   - Behavioral overlays (prepayment, decay, deposit-rate β) attach to the
 *     instrument at construction; the analytic layer never reaches inside.
 */

/** Instrument type discriminator. */
export type InstrumentType =
  | "fixed-loan"
  | "floating-loan"
  | "mortgage"
  | "nmd"
  | "nmd-b";

/** Amortization style. */
export type AmortType = "level-pay" | "bullet";

/** Single cashflow event on an instrument. */
export interface Cashflow {
  /** Months from origination (or sim start, depending on context). */
  monthOffset: number;
  /** Outstanding principal AT START of this month (pre-amortization). */
  balance: number;
  /** Principal paid in this month (positive = repayment, negative = drawdown). */
  principalPaid: number;
  /** Interest paid in this month. */
  interestPaid: number;
  /** Coupon / accrual rate applied this month (decimal annualised). */
  couponRate: number;
}

/** Common terms across instrument types. Concrete instruments add fields. */
export interface InstrumentTermsBase {
  id: string;
  type: InstrumentType;
  label?: string;
  /** Notional / current balance at instrument-time-zero, in dollars. */
  notional: number;
  /** Months to legal maturity from instrument-time-zero. */
  maturityMonths: number;
  /** Origination month offset relative to model time-zero (negative = seasoned). */
  originationOffsetMonths: number;
  /** Amortization style. */
  amortType: AmortType;
  /**
   * Balance-sheet side. "asset" (default when omitted) means the bank earns the
   * coupon and pays a funding charge; "liability" means the bank pays the
   * coupon and earns a funding credit. Affects the FTP-margin sign convention
   * so that all rows in the FTP decomposition table report positive franchise
   * value.
   */
  side?: "asset" | "liability";
}

/**
 * RatePath: any time-series of rates an instrument can consume.
 *
 * Implementations:
 *   - DeterministicRatePath: wraps the bootstrapped zero curve, returns the
 *     forward rate at each (time, tenor).
 *   - StochasticRatePath: wraps a single HW or BGM path realisation.
 *   - PathEnsemble: a list of stochastic paths (for MC analytics).
 */
export interface RatePath {
  /** Number of monthly steps available. */
  readonly nSteps: number;
  /** Time grid in years (length nSteps + 1, with t[0] = 0). */
  readonly times: ReadonlyArray<number>;
  /** Spot rate (1M tenor by convention) at month index `step`. */
  rateAt(step: number): number;
  /** Forward rate over [t_step, t_step + tenorYears] from this path's perspective. */
  forwardRateAt(step: number, tenorYears: number): number;
}

/** The minimal interface every concrete instrument must satisfy. */
export interface Instrument {
  readonly terms: InstrumentTermsBase;
  /**
   * Generate the per-month cashflow schedule under the given rate path.
   * Returns array of length min(maturity, path.nSteps).
   */
  generateCashflows(path: RatePath): Cashflow[];
  /**
   * Repricing dates: month offsets when the coupon rate resets. For fixed-rate
   * instruments this returns []. For floaters this returns the full reset grid.
   * Used by the repricing-gap analytic.
   */
  repricingSchedule(): number[];
}
