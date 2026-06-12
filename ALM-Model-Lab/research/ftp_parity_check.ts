/**
 * FTP static-strip parity harness vs the owner's BBG workbook.
 * Run: npx tsx research/ftp_parity_check.ts
 *
 * Input: research/data/ftp_workbook_extract.json (from extract_ftp_workbook.py).
 *
 * Workbook vintage: the owner re-baselined the workbook to the 2026-03-31 BBG
 * strip (m1 1M SOFR reset now 3.6623%, was the 2025-09 4.2738%), so the loan
 * sheets and the BBG_Curves sheets share the lab snapshot's vintage. Parity is
 * now a true 1:1 cross-check, organized in four layers:
 *
 *   A. Formula parity: replicate the sheet's par-matched FTP from the
 *      sheet's OWN cashflows, ACT/365 day-count fractions, and dated DFs.
 *      Proves the workbook formula is the same linear par-match as ftp.ts.
 *   B. Convention quantification: rerun A with the lab's month/12 accrual
 *      (ftp.ts parMatchedRate) against the same workbook DFs. The difference
 *      is the pure day-count quote-basis effect (ACT/365 vs month/12).
 *   C. Cashflow mechanics parity: rebuild each loan with lab instruments
 *      driven by the sheet's own coupon path and diff the schedules.
 *   D. Lab-native 3/31 reference: the four loans through computeFTP on the
 *      2026-03-31 curve + snapshot TLP, as the lab's new reference triple.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { bootstrapZeroCurve } from "../src/math/rates/bootstrap";
import { loadMarketSnapshot } from "../src/math/rates/marketData";
import { buildTLPCurve } from "../src/math/rates/tlpCurve";
import { DeterministicRatePath } from "../src/math/rates/ratePath";
import { FixedLoan } from "../src/math/instruments/fixedLoan";
import { FloatingLoan, FLOATING_LOAN_DEFAULTS } from "../src/math/instruments/floatingLoan";
import { PrimeLoan, PRIME_LOAN_DEFAULTS, PRIME_SOFR_BASIS_DEFAULT } from "../src/math/instruments/primeLoan";
import { computeFTP, parMatchedRate } from "../src/math/analytics/ftp";
import type { Instrument, RatePath } from "../src/math/instruments/types";

const bp = (x: number) => (x * 1e4).toFixed(2);
const pct = (x: number) => (x * 100).toFixed(4);

interface ExtractRow {
  month: number;
  balance: number;
  coupon: number | null;
  interest: number | null;
  scheduled: number;
  maturity: number;
  prepay: number;
  total_principal: number;
  dcf: number | null;
  rfr_df: number | null;
  allin_df: number | null;
}
interface ExtractSheet {
  assumptions: { param_value: number; term_months: number; cpr: number; amort_type: string };
  results: Record<string, number>;
  rows: ExtractRow[];
}

const extract = JSON.parse(
  readFileSync(resolve(__dirname, "data", "ftp_workbook_extract.json"), "utf-8"),
) as { sheets: Record<string, ExtractSheet> };

function liveRows(s: ExtractSheet): ExtractRow[] {
  return s.rows.filter((r) => r.month <= s.assumptions.term_months && r.balance > 1e-9);
}

/** The workbook's par-match: r = (N - sum(df*P)) / (sum(df*B*dcf)). */
function sheetParMatch(rows: ExtractRow[], notional: number, dfKey: "rfr_df" | "allin_df"): number {
  let pvP = 0;
  let annuity = 0;
  for (const r of rows) {
    const df = r[dfKey]!;
    pvP += df * r.total_principal;
    annuity += df * r.balance * r.dcf!;
  }
  return (notional - pvP) / annuity;
}

function stepPath(resets: number[], nSteps: number): RatePath {
  return {
    nSteps,
    times: Array.from({ length: nSteps + 1 }, (_, i) => i / 12),
    rateAt: (s: number) => resets[Math.min(s, resets.length - 1)],
    forwardRateAt: (s: number) => resets[Math.min(s, resets.length - 1)],
  };
}

/**
 * Max abs schedule differences. The sheets accrue interest as
 * balance x coupon x dcf with their own dated day-count column; the lab
 * always uses month/12. `interest` therefore compares the sheet's interest
 * NORMALIZED to the /12 basis (x (1/12)/dcf), so it isolates engine
 * mechanics from the calendar convention; `interestRaw` keeps the raw gap.
 */
function maxAbsDiff(
  rows: ExtractRow[],
  cf: ReadonlyArray<{ interestPaid: number; principalPaid: number; balance: number }>,
): { interest: number; interestRaw: number; principal: number; balance: number } {
  let di = 0;
  let diRaw = 0;
  let dp = 0;
  let db = 0;
  rows.forEach((r, i) => {
    const sheetI = r.interest ?? 0;
    const dcf = r.dcf ?? 1 / 12;
    const normalized = dcf > 0 ? (sheetI * (1 / 12)) / dcf : sheetI;
    di = Math.max(di, Math.abs(normalized - cf[i].interestPaid));
    diRaw = Math.max(diRaw, Math.abs(sheetI - cf[i].interestPaid));
    dp = Math.max(dp, Math.abs(r.total_principal - cf[i].principalPaid));
    db = Math.max(db, Math.abs(r.balance - cf[i].balance));
  });
  return { interest: di, interestRaw: diRaw, principal: dp, balance: db };
}

async function main() {
  const N = 1000;

  console.log("=== A. Formula parity (workbook-internal: own CFs, ACT/365 dcf, dated DFs) ===");
  for (const name of ["Fixed_Rate_Loan", "Fixed_Rate_Loan_amort"]) {
    const s = extract.sheets[name];
    const rows = liveRows(s);
    const rIr = sheetParMatch(rows, N, "rfr_df");
    const rAll = sheetParMatch(rows, N, "allin_df");
    const refIr = s.results["IR_FTP"];
    const refAll = s.results["All-in_FTP"];
    console.log(
      `${name.padEnd(22)} IR ${pct(rIr)}% (sheet ${pct(refIr)}%, diff ${bp(rIr - refIr)}bp) | ` +
        `all-in ${pct(rAll)}% (sheet ${pct(refAll)}%, diff ${bp(rAll - refAll)}bp)`,
    );
  }

  console.log("\n=== B. Day-count quote basis: ftp.ts month/12 accrual on the same workbook DFs ===");
  for (const name of ["Fixed_Rate_Loan", "Fixed_Rate_Loan_amort"]) {
    const s = extract.sheets[name];
    const rows = liveRows(s);
    const dfByMonth = new Map(rows.map((r) => [r.month, r.rfr_df!]));
    const cf = rows.map((r) => ({
      monthOffset: r.month,
      balance: r.balance,
      principalPaid: r.total_principal,
      interestPaid: r.interest ?? 0,
      couponRate: r.coupon ?? 0,
    }));
    const rLab = parMatchedRate(cf, N, (t) => dfByMonth.get(Math.round(t * 12)) ?? 1);
    const rSheet = sheetParMatch(rows, N, "rfr_df");
    console.log(
      `${name.padEnd(22)} month/12 ${pct(rLab)}% vs ACT/365 ${pct(rSheet)}% -> quote-basis effect ${bp(rLab - rSheet)}bp`,
    );
  }

  console.log("\n=== C. Cashflow mechanics parity (lab instruments on the sheet's own coupon path) ===");
  {
    // 24M 6% bullet, no CPR.
    const s = extract.sheets["Fixed_Rate_Loan"];
    const rows = liveRows(s);
    const fixed = new FixedLoan({
      id: "wb-fixed", type: "fixed-loan", label: "24M 6% bullet", notional: N,
      maturityMonths: 24, originationOffsetMonths: 0, amortType: "bullet", coupon: 0.06,
    });
    const d = maxAbsDiff(rows, fixed.generateCashflows(stepPath([0], 24)));
    console.log(`Fixed_Rate_Loan        max|diff| interest(norm) ${d.interest.toExponential(2)} raw ${d.interestRaw.toExponential(2)}  principal ${d.principal.toExponential(2)}  balance ${d.balance.toExponential(2)}`);
  }
  {
    // 60M 6% level-pay, CPR 16.4054%: PrimeLoan with zero path + basis = coupon.
    const s = extract.sheets["Fixed_Rate_Loan_amort"];
    const rows = liveRows(s);
    const loan = new PrimeLoan({
      ...PRIME_LOAN_DEFAULTS, id: "wb-amort", notional: N, maturityMonths: 60,
      primeSofrBasis: 0.06, margin: 0, cpr: s.assumptions.cpr,
    });
    const d = maxAbsDiff(rows, loan.generateCashflows(stepPath([0], 60)));
    console.log(`Fixed_Rate_Loan_amort  max|diff| interest(norm) ${d.interest.toExponential(2)} raw ${d.interestRaw.toExponential(2)}  principal ${d.principal.toExponential(2)}  balance ${d.balance.toExponential(2)}`);
  }
  {
    // 24M floating bullet, margin +2.25%: drive with the sheet's own resets.
    const s = extract.sheets["Floating_Rate_Loan"];
    const rows = liveRows(s);
    const resets = rows.map((r) => (r.coupon ?? 0) - 0.0225);
    const loan = new FloatingLoan({
      ...FLOATING_LOAN_DEFAULTS, id: "wb-float", notional: N, maturityMonths: 24,
      margin: 0.0225, resetFrequencyMonths: 1, amortType: "bullet",
    });
    const d = maxAbsDiff(rows, loan.generateCashflows(stepPath(resets, 24)));
    console.log(`Floating_Rate_Loan     max|diff| interest(norm) ${d.interest.toExponential(2)} raw ${d.interestRaw.toExponential(2)}  principal ${d.principal.toExponential(2)}  balance ${d.balance.toExponential(2)}`);
  }
  {
    // 360M Prime level-pay, margin -0.75%, CPR 10%: drive so coupons reproduce.
    const s = extract.sheets["Floating_Rate_Loan_Prime"];
    const rows = liveRows(s);
    const resets = rows.map((r) => (r.coupon ?? 0) - PRIME_SOFR_BASIS_DEFAULT - -0.0075);
    const loan = new PrimeLoan({
      ...PRIME_LOAN_DEFAULTS, id: "wb-prime", notional: N, maturityMonths: 360,
      margin: -0.0075, primeSofrBasis: PRIME_SOFR_BASIS_DEFAULT, cpr: 0.10,
    });
    const d = maxAbsDiff(rows, loan.generateCashflows(stepPath(resets, 360)));
    console.log(`Floating_Rate_Loan_Prime max|diff| interest(norm) ${d.interest.toExponential(2)} raw ${d.interestRaw.toExponential(2)}  principal ${d.principal.toExponential(2)}  balance ${d.balance.toExponential(2)}`);
  }

  console.log("\n=== D. Lab-native FTP reference on the 2026-03-31 curve + snapshot TLP ===");
  const snap = await loadMarketSnapshot("research/data/market_2026-03-31.json");
  const curve = bootstrapZeroCurve(snap);
  const tlp = buildTLPCurve([...snap.tlpNodes]);
  const path = new DeterministicRatePath(curve, 360);
  // Fixed 6% level-pay with CPR: generate the schedule once on a zero path
  // (PrimeLoan with basis = coupon reduces to a fixed loan with constant-CPR
  // prepay), then wrap it as a path-independent fixed instrument so the live
  // 3/31 path cannot leak into its coupon.
  const amortCf = new PrimeLoan({
    ...PRIME_LOAN_DEFAULTS, id: "amort-gen", notional: N, maturityMonths: 60,
    primeSofrBasis: 0.06, margin: 0,
    cpr: extract.sheets["Fixed_Rate_Loan_amort"].assumptions.cpr,
  }).generateCashflows(stepPath([0], 60));
  const amortFixed: Instrument = {
    terms: {
      id: "amort-60m", type: "fixed-loan", label: "60M 6% level-pay CPR 16.4%",
      notional: N, maturityMonths: 60, originationOffsetMonths: 0, amortType: "level-pay",
    },
    generateCashflows: () => amortCf,
    repricingSchedule: () => [],
  };
  const instruments: Instrument[] = [
    new FixedLoan({
      id: "fixed-24m", type: "fixed-loan", label: "24M 6% bullet", notional: N,
      maturityMonths: 24, originationOffsetMonths: 0, amortType: "bullet", coupon: 0.06,
    }),
    amortFixed,
    new FloatingLoan({
      ...FLOATING_LOAN_DEFAULTS, id: "float-24m", label: "24M float +2.25%", notional: N,
      maturityMonths: 24, margin: 0.0225, resetFrequencyMonths: 1, amortType: "bullet",
    }),
    new PrimeLoan({
      ...PRIME_LOAN_DEFAULTS, id: "prime-360m", label: "360M Prime -0.75% CPR 10%",
      notional: N, maturityMonths: 360,
    }),
  ];
  const ftp = computeFTP(instruments, curve, tlp, path);
  console.log(`curve: 1M fwd ${pct(curve.forwardRate(0, 1 / 12))}%  2Y par ${pct(curve.forwardSwapRate(0, 2))}%  TLP 2Y ${bp(tlp.tlp(2))}bp  TLP 5Y ${bp(tlp.tlp(5))}bp`);
  for (const row of ftp.perInstrument) {
    console.log(
      `${row.label.padEnd(28)} coupon ${pct(row.assetRate)}% | IR FTP ${pct(row.irFtpRate)}% | LP ${bp(row.lpFtpRate)}bp | all-in ${pct(row.allInFtpRate)}% | margin ${bp(row.ftpMargin)}bp`,
    );
  }

  // Historical, pre-rebaseline references (workbook on the 2025-09 strip).
  console.log("\nHistorical (pre-rebaseline 2025-09 strip): fixed-24M IR 3.3901%/all-in 3.7416%; amort-60M IR 3.3881%/all-in 3.7920%.");
}

void main();
