/**
 * Funds transfer pricing — par-matched static-strip with TLP overlay.
 *
 * The bank's true funding curve is the SOFR zero curve plus a Term Liquidity
 * Premium (TLP) spread, which empirically tracks FHLB advance rates minus
 * matching-tenor SOFR. We compute three par-matched FTP rates per instrument:
 *
 *   - IR FTP      : par-match against SOFR zero curve alone.
 *   - all-in FTP  : par-match against (SOFR + TLP) all-in funding curve.
 *   - LP FTP      : residual = all-in FTP - IR FTP. By construction additive.
 *
 * FTP margin = asset rate - all-in FTP. This is the locked NIM under the
 * bank's actual funding cost.
 *
 * Par-match formula (linear in r, no root-find):
 *
 *   N = sum_i D(t_i) * [P_i + r * B_{i-1} * dt]
 *   r = (N - sum_i D(t_i) * P_i) / (sum_i D(t_i) * B_{i-1} * dt)
 *
 * Monthly coupon-vs-FTP series. For each month we report:
 *   - couponRate(m) : the realised loan coupon at month m
 *   - ftpRate(m)    : the SPOT funding rate the bank pays for that month
 *
 * For a fixed-rate loan, ftpRate(m) is held flat at the par-matched all-in
 * rate (match-funded at fixed tenor at origination). For a floater with
 * monthly resets, ftpRate(m) refixes alongside the coupon at each reset:
 * ftpRate = SOFR forward over the reset window + TLP at the reset tenor.
 * The vertical gap between the two lines is the locked margin in both cases.
 */

import type { Instrument, RatePath } from "../instruments/types";
import { isFloatingLoanTerms } from "../instruments/floatingLoan";
import { isNMDBetaTerms, betaAtRate } from "../instruments/nmdBeta";
import type { ZeroCurve } from "../rates/bootstrap";
import type { TLPCurve } from "../rates/tlpCurve";
import type { FTPResult, FtpInstrumentRow, FtpMonthlyRow } from "./types";

const DT_YEARS = 1 / 12;

/** Discount factor under the all-in (SOFR + TLP) funding curve. */
function allInDF(curve: ZeroCurve, tlp: TLPCurve, t: number): number {
  if (t <= 0) return 1;
  return curve.discountFactor(t) * Math.exp(-tlp.tlp(t) * t);
}

/**
 * Solve the linear par-match equation for the constant transfer rate that
 * prices the cashflow's principal schedule to par under the supplied
 * discount-factor function. Exported for the tractor pillar ladder, whose
 * runoff schedule par-matches through the same formula.
 */
export function parMatchedRate(
  cashflows: ReadonlyArray<{ monthOffset: number; balance: number; principalPaid: number }>,
  notional: number,
  df: (tYears: number) => number,
): number {
  let pvPrincipal = 0;
  let annuityFactor = 0;
  for (const c of cashflows) {
    const t = c.monthOffset / 12;
    const d = df(t);
    pvPrincipal += d * c.principalPaid;
    annuityFactor += d * c.balance * DT_YEARS;
  }
  if (annuityFactor < 1e-12) return 0;
  return (notional - pvPrincipal) / annuityFactor;
}

function ftpForInstrument(
  instr: Instrument,
  curve: ZeroCurve,
  tlp: TLPCurve,
  path: RatePath,
): FtpInstrumentRow {
  const cf = instr.generateCashflows(path);
  const N = instr.terms.notional;
  const side: "asset" | "liability" = instr.terms.side === "liability" ? "liability" : "asset";

  // Default: par-match against the full cashflow stream.
  let irFtpRate = parMatchedRate(cf, N, (t) => curve.discountFactor(t));
  let allInFtpRate = parMatchedRate(cf, N, (t) => allInDF(curve, tlp, t));

  // IB NMD (NMD-B): split into a (1 − β) fixed slice that earns the long-tenor
  // par-matched credit against the decay schedule, and a β slice that funds at
  // 1M SOFR (+ 1M TLP) and reprices monthly. Blend into the headline rate so
  // the FTP table reflects the deposit's actual repricing structure: the β
  // fraction earns short-tenor credit, only the rate-locked (1 − β) earns the
  // longer-dated franchise value.
  if (isNMDBetaTerms(instr.terms)) {
    const beta = betaAtRate(path.rateAt(0) * 100, instr.terms.sCurve);
    const oneMonthSofr = curve.forwardRate(0, 1 / 12);
    const oneMonthTlp = tlp.tlp(1 / 12);
    const fixedIr = irFtpRate;
    const fixedAllIn = allInFtpRate;
    const floatIr = oneMonthSofr;
    const floatAllIn = oneMonthSofr + oneMonthTlp;
    irFtpRate = (1 - beta) * fixedIr + beta * floatIr;
    allInFtpRate = (1 - beta) * fixedAllIn + beta * floatAllIn;
  }
  const lpFtpRate = allInFtpRate - irFtpRate;

  // Coupon rate = balance-weighted realised coupon. For assets this is the
  // asset yield; for liabilities it is the deposit cost.
  let weightedCoupon = 0;
  let weightSum = 0;
  for (const c of cf) {
    weightedCoupon += c.couponRate * c.balance;
    weightSum += c.balance;
  }
  const assetRate = weightSum > 1e-12 ? weightedCoupon / weightSum : 0;
  // Sign flip so franchise value reads positive for both sides:
  //   asset    : assetRate − allInFtpRate (loan yield over funding cost)
  //   liability: allInFtpRate − depositRate (FTP credit over deposit cost)
  const ftpMargin = side === "liability" ? allInFtpRate - assetRate : assetRate - allInFtpRate;

  // Monthly spot funding rate. For a floater we mirror its reset cadence,
  // sampling the SOFR forward over the reset window + the TLP at the same
  // tenor; for a fixed loan we hold the par-matched all-in rate flat.
  const monthlySeries: FtpMonthlyRow[] = [];
  if (isFloatingLoanTerms(instr.terms)) {
    const tenorYears = instr.terms.resetFrequencyMonths / 12;
    const tlpAtTenor = tlp.tlp(tenorYears);
    const resetFreq = instr.terms.resetFrequencyMonths;
    let currentFtp = 0;
    for (const c of cf) {
      const m = c.monthOffset;
      const isResetMonth = ((m - 1) % resetFreq) === 0;
      if (isResetMonth) {
        // Sample SOFR forward over [t, t + tenor) where t = (m-1)/12.
        const t1 = (m - 1) / 12;
        const t2 = t1 + tenorYears;
        const sofrFwd = curve.forwardRate(t1, t2);
        currentFtp = sofrFwd + tlpAtTenor;
      }
      monthlySeries.push({ month: m, couponRate: c.couponRate, ftpRate: currentFtp });
    }
  } else if (isNMDBetaTerms(instr.terms)) {
    // IB NMD (NMD-B): blended monthly FTP. The (1 − β) slice carries the
    // long-tenor par-matched all-in credit against the decay schedule (held
    // flat — that's its match-funded fixed-tenor credit). The β slice resets
    // monthly to 1M SOFR + 1M TLP, so its rate floats step-by-step. The chart
    // therefore shows an FTP line that rises (or falls) with the 1M forward
    // for the β fraction, while the (1 − β) base stays anchored.
    const beta = betaAtRate(path.rateAt(0) * 100, instr.terms.sCurve);
    const oneMonthTlp = tlp.tlp(1 / 12);
    // (1 − β) slice: par-match against the FULL stream gives the same rate
    // independent of scaling, so reuse the original par-matched all-in rate.
    const fixedAllIn = parMatchedRate(cf, N, (t) => allInDF(curve, tlp, t));
    for (const c of cf) {
      const m = c.monthOffset;
      const t1 = (m - 1) / 12;
      const t2 = t1 + 1 / 12;
      const oneMonthSofrAtM = curve.forwardRate(t1, t2);
      const blended = (1 - beta) * fixedAllIn + beta * (oneMonthSofrAtM + oneMonthTlp);
      monthlySeries.push({ month: m, couponRate: c.couponRate, ftpRate: blended });
    }
  } else {
    for (const c of cf) {
      monthlySeries.push({ month: c.monthOffset, couponRate: c.couponRate, ftpRate: allInFtpRate });
    }
  }

  return {
    instrumentId: instr.terms.id,
    label: instr.terms.label ?? instr.terms.id,
    side,
    assetRate,
    irFtpRate,
    lpFtpRate,
    allInFtpRate,
    ftpMargin,
    monthlySeries,
  };
}

export function computeFTP(
  instruments: ReadonlyArray<Instrument>,
  curve: ZeroCurve,
  tlp: TLPCurve,
  path: RatePath,
): FTPResult {
  const rows = instruments.map((i) => ftpForInstrument(i, curve, tlp, path));

  let weightedMargin = 0;
  let totalNotional = 0;
  for (let i = 0; i < instruments.length; i++) {
    const N = instruments[i].terms.notional;
    weightedMargin += rows[i].ftpMargin * N;
    totalNotional += N;
  }
  const bookNim = totalNotional > 1e-12 ? weightedMargin / totalNotional : 0;

  return { perInstrument: rows, bookNim };
}
