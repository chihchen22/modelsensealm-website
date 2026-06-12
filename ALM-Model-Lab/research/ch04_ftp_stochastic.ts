/**
 * Ch4 Section 4.6 — Stochastic option-adjusted FTP for the 30Y mortgage.
 *
 * Deterministic single-path vs Hull-White stochastic-path, Richard & Roll (1989)
 * arctan prepayment. The deliverable answers: how much FTP does the prepayment
 * option cost the bank, and how much of that cost does a single forward-implied
 * path miss because it ignores rate convexity?
 *
 * Prepayment: genuine Richard & Roll (1989) refinancing incentive, the
 * rate-DIFFERENCE arctan form
 *   RI = 0.28 + 0.14 * atan(-8.571 + 430 * (WAC - r))     [WAC, r decimal]
 * (Richard, S.F. & Roll, R. (1989), "Prepayments on Fixed-Rate Mortgage-Backed
 * Securities," J. Portfolio Management.) Full CPR = RI * seasoning * seasonality
 * * burnout. The R&R coefficients are an 1980s-pool fit; we apply a single
 * multiplicative speed multiple kappa, solved so the DETERMINISTIC life CPR =
 * 10% (the Ch3 base-case canon, WAL 7.68y). Seasoning/seasonality/burnout are
 * illustrative overlays, not R&R-native.
 *
 * Two constructions, cross-checked:
 *   B (primary). Par-coupon FTP RATE, path-averaged. The par-match is linear in
 *      the rate, so the cross-path expectation is the par rate of the EXPECTED
 *      price (ratio of expectations), a direct linear solve with no dropped
 *      covariance term and no root find. Decomposes into IR / all-in / LP.
 *        r = (P*N - Sum_p Sum_i D_p(t_i) P_{i,p}) / (Sum_p Sum_i D_p(t_i) B_{i-1,p} dt)
 *   A (cross-check). Z-spread (static, single path) and OAS (stochastic) on the
 *      actual mortgage cashflows, by root find, both over SOFR. Option cost
 *      = Z - OAS must corroborate B's IR-leg vol value (also SOFR-only).
 *
 * Discounting. Per-path money-market discount factors are reconstructed from the
 * HW short-rate paths with a terminal martingale correction so E_p[D_p(t_k)] =
 * P^M(0, t_k) exactly (verified identical path-by-path to the simulator's
 * incremental correction). Consequence: with prepayment OFF the stochastic rate
 * equals the deterministic rate within MC noise (the machinery control).
 *
 * Calibration. Headline pins mean-reversion a = 0.03 and refits sigma to the ATM
 * cap surface; the free fit (a -> 0, near Ho-Lee) is reported as the upper
 * sensitivity bound on the option cost.
 *
 * Run: npx tsx research/ch04_ftp_stochastic.ts
 */

import { bootstrapZeroCurve, type ZeroCurve } from "../src/math/rates/bootstrap";
import { loadMarketSnapshot } from "../src/math/rates/marketData";
import { DEFAULT_TLP_CURVE, type TLPCurve } from "../src/math/rates/tlpCurve";
import { calibrateHW } from "../src/math/rates/hwCalibrate";
import { simulateHW, projectHWToTenor, reconstructPathDF, type HWSimulationResult } from "../src/math/rates/simulateHw";
import { brentq } from "../src/math/rates/rootFind";
import {
  RichardRollCPR,
  ConstantCPR,
  amortizeMortgage,
  type PrepayContext,
} from "../src/math/behavioral/prepay";
import {
  solveOAS,
  solveZSpread,
  stochasticFtpTriple,
  deterministicFtpTriple,
  type FtpCashflow,
} from "../src/math/analytics/ftpStochastic";

const DT = 1 / 12;
const N = 100e6; // $100M pool (scale-invariant; kept as a pool per Ch2/Ch3)
const TERM = 360; // 30Y
const NOTE = 0.06; // 6% WAC/note rate (Ch3/Ch4 canon)
const SEC_SPREAD = 120; // bps, agency g-fee / securitization
const PRIM_SPREAD = 130; // bps, primary-secondary
const TOTAL_SPREAD = (SEC_SPREAD + PRIM_SPREAD) / 1e4; // decimal
const SEASONING_RAMP = 30; // months
const SEASONALITY_AMP = 0.20; // peak/trough
const BURNOUT_RATE = 0.001; // per cumulative ITM (percentage points)
const BENCH_TENOR = 10; // 10Y refi benchmark
const TARGET_LIFE_CPR = 0.10; // Ch3 base-case canon

const bp = (x: number) => (x * 1e4).toFixed(1);
const pct = (x: number) => (x * 100).toFixed(3);

type CF = FtpCashflow;

/**
 * One mortgage cashflow stream given a per-month 10Y benchmark lookup.
 * `optionOn=false` forces CPR=0 (contractual only). `kappa` is the speed
 * multiple on CPR (pool calibration; 1 = R&R-native level).
 *
 * Prepayment and amortization now run through the shared PrepayModel seam
 * (RichardRollCPR + amortizeMortgage in src/math/behavioral/prepay), which is a
 * bit-for-bit lift of the previous inline loop.
 */
function mortgageCF(bench10: (m: number) => number, optionOn: boolean, kappa = 1): CF[] {
  const ctx: PrepayContext = {
    term: TERM,
    age: 0,
    noteRate: NOTE,
    mortgageRateAt: (m) => bench10(m) + TOTAL_SPREAD,
  };
  const model = optionOn
    ? new RichardRollCPR({
        seasoningRamp: SEASONING_RAMP,
        seasonalityAmp: SEASONALITY_AMP,
        burnoutRate: BURNOUT_RATE,
        kappa,
      })
    : new ConstantCPR(0);
  const sched = model.cprSchedule(ctx);
  const rows = amortizeMortgage({ notional: N, noteRate: NOTE, term: TERM, cprSchedule: sched });
  return rows.map((r) => ({
    monthOffset: r.monthOffset,
    balanceStart: r.balance,
    principalPaid: r.principalPaid,
    interestPaid: r.interestPaid,
  }));
}

/** WAL (years) of a single cashflow stream. */
function wal(cf: CF[]): number {
  let num = 0, den = 0;
  for (const c of cf) { num += (c.monthOffset / 12) * c.principalPaid; den += c.principalPaid; }
  return den > 1e-12 ? num / den : 0;
}

/** Life CPR (balance-weighted, annualised) of a single stream. */
function lifeCPR(cf: CF[]): number {
  let wSum = 0, cprSum = 0;
  const mr = NOTE / 12;
  for (const c of cf) {
    const remMonths = TERM - c.monthOffset + 1;
    const sp = c.balanceStart > 1e-6 ? c.balanceStart * (mr / (Math.pow(1 + mr, remMonths) - 1)) : 0;
    const pp = Math.max(0, c.principalPaid - sp);
    const base = Math.max(1e-9, c.balanceStart - sp);
    const smm = Math.min(1, pp / base);
    const cpr = 1 - Math.pow(1 - smm, 12);
    cprSum += cpr * c.balanceStart;
    wSum += c.balanceStart;
  }
  return wSum > 1e-12 ? cprSum / wSum : 0;
}

function stochBench(swap10: Float64Array[], curve: ZeroCurve, p: number): (m: number) => number {
  const det0 = curve.forwardSwapRate(0, BENCH_TENOR);
  return (m: number) => (m === 1 ? det0 : swap10[p][Math.min(m - 2, swap10[p].length - 1)]);
}

function detBench(curve: ZeroCurve): (m: number) => number {
  return (m: number) => curve.forwardSwapRate((m - 1) / 12, (m - 1) / 12 + BENCH_TENOR);
}

/** Full stochastic block for a given (nPairs, seed, kappa). */
function runStoch(curve: ZeroCurve, a: number, sigma: number, tlp: TLPCurve, nPairs: number, seed: bigint, kappa: number) {
  const sim = simulateHW(curve, a, sigma, { horizonYears: 30, dtYears: DT, nPairs, seed });
  const swap10 = projectHWToTenor(sim, curve, BENCH_TENOR);
  const { Dcorr, meanErrBp } = reconstructPathDF(sim, curve);
  const P = sim.nPaths;

  const cfOn: CF[][] = new Array(P);
  const cfOff: CF[][] = new Array(P);
  for (let p = 0; p < P; p++) {
    const bench = stochBench(swap10, curve, p);
    cfOn[p] = mortgageCF(bench, true, kappa);
    cfOff[p] = mortgageCF(bench, false);
  }
  const on = stochasticFtpTriple(cfOn, N, Dcorr, tlp);
  const off = stochasticFtpTriple(cfOff, N, Dcorr, tlp);

  const baseDfp = (p: number, t: number) => {
    const k = Math.round(t * 12) - 1;
    return k < 0 ? 1 : Dcorr[p][Math.min(k, Dcorr[p].length - 1)];
  };
  let oas = NaN;
  try { oas = solveOAS(cfOn, baseDfp, N); } catch { /* NaN */ }

  let walSum = 0, cprSum = 0;
  for (let p = 0; p < P; p++) { walSum += wal(cfOn[p]); cprSum += lifeCPR(cfOn[p]); }

  return { sim, on, off, oas, meanErrBp, walOn: walSum / P, cprOn: cprSum / P, P };
}

async function main() {
  const snap = await loadMarketSnapshot("research/data/market_2025-09-30.json");
  const curve = bootstrapZeroCurve(snap);
  const tlp = DEFAULT_TLP_CURVE;

  console.log(`=== Curve (${snap.calibrationDate}) ===`);
  console.log(`SOFR 1M=${pct(curve.forwardRate(0, 1 / 12))}%  5Y=${pct(curve.forwardSwapRate(0, 5))}%  10Y=${pct(curve.forwardSwapRate(0, 10))}%`);

  // ---- Calibration: headline (a=0.03 refit) + free (sensitivity) ----
  const hwFree = calibrateHW(snap, curve);
  const hwFix = calibrateHW(snap, curve, { aBounds: [0.0299, 0.0301], aInit: 0.03, sigmaInit: 0.01 });
  console.log(`\n=== HW calibration (ATM caps) ===`);
  console.log(`HEADLINE a=${hwFix.a.toFixed(4)} (pinned)  sigma=${hwFix.sigma.toFixed(5)} (${bp(hwFix.sigma)}bp)  RMSE=${hwFix.rmseBp.toFixed(2)}bp`);
  console.log(`FREE     a=${hwFree.a.toFixed(4)} (Ho-Lee limit)  sigma=${hwFree.sigma.toFixed(5)} (${bp(hwFree.sigma)}bp)  RMSE=${hwFree.rmseBp.toFixed(2)}bp`);

  // ---- Recalibrate R&R speed to Ch3 canon: solve kappa s.t. det life CPR = 10% ----
  const benchDet = detBench(curve);
  let kappa = 1;
  try {
    kappa = brentq((k: number) => lifeCPR(mortgageCF(benchDet, true, k)) - TARGET_LIFE_CPR, 0.1, 12.0);
  } catch { console.log("  WARN: kappa solve failed; using kappa=1"); }
  const cprNative = lifeCPR(mortgageCF(benchDet, true, 1));
  console.log(`\n=== R&R speed calibration ===`);
  console.log(`R&R-native det life CPR=${pct(cprNative)}%  ->  kappa=${kappa.toFixed(3)}  ->  det life CPR=${pct(lifeCPR(mortgageCF(benchDet, true, kappa)))}% (target ${pct(TARGET_LIFE_CPR)}%)`);

  // ---- Deterministic baselines (kappa-calibrated) ----
  const cfDetOn = mortgageCF(benchDet, true, kappa);
  const cfDetOff = mortgageCF(benchDet, false);
  const detOn = deterministicFtpTriple(cfDetOn, N, curve, tlp);
  const detOff = deterministicFtpTriple(cfDetOff, N, curve, tlp);
  const walDetOn = wal(cfDetOn), cprDetOn = lifeCPR(cfDetOn);

  console.log(`\n=== DETERMINISTIC (single forward-implied path) ===`);
  console.log(`OFF (CPR0): IR=${bp(detOff.ir)}  LP=${bp(detOff.lp)}  all-in=${bp(detOff.all)}  WAL=${wal(cfDetOff).toFixed(2)}y`);
  console.log(`ON  (R&R) : IR=${bp(detOn.ir)}  LP=${bp(detOn.lp)}  all-in=${bp(detOn.all)}  WAL=${walDetOn.toFixed(2)}y  lifeCPR=${pct(cprDetOn)}%`);
  console.log(`det option premium: IR=${bp(detOn.ir - detOff.ir)}  LP=${bp(detOn.lp - detOff.lp)}  all-in=${bp(detOn.all - detOff.all)}`);

  // ---- Turnover-only base (R&R refi incentive frozen at-the-money) ----
  // Hold the benchmark at the note rate every month so (WAC - r) = 0: the refi
  // S-curve is neutralised (richardRollRefi at ATM = 7.63% annual, burnout inert
  // since cumITM = 0) while seasoning / seasonality / burnout stay live. This is
  // the model-native turnover floor. The deterministic financial-prepay effect is
  // the increment from this base to the live-curve det-on run; at the 2025-09-30
  // curve the loan is slightly OTM, so that increment is small and the vol value
  // carries the option cost.
  const benchATM = (_m: number) => NOTE - TOTAL_SPREAD; // => mortgageRateAt(m) = NOTE
  const cfTurnover = mortgageCF(benchATM, true, kappa);
  const turnover = deterministicFtpTriple(cfTurnover, N, curve, tlp);
  console.log(`\n=== TURNOVER BASE (R&R incentive frozen ATM, seasoning/seasonality/burnout live) ===`);
  console.log(`kappa=${kappa.toFixed(3)}: IR=${bp(turnover.ir)}  LP=${bp(turnover.lp)}  all-in=${bp(turnover.all)}  WAL=${wal(cfTurnover).toFixed(2)}y  lifeCPR=${pct(lifeCPR(cfTurnover))}%`);
  console.log(`  R&R-native kappa=1 reference: lifeCPR=${pct(lifeCPR(mortgageCF(benchATM, true, 1)))}%`);
  console.log(`financial-prepay effect (det-on - turnover base): IR=${bp(detOn.ir - turnover.ir)}  LP=${bp(detOn.lp - turnover.lp)}  all-in=${bp(detOn.all - turnover.all)}`);

  // ---- Headline stochastic (a=0.03) ----
  const H = runStoch(curve, hwFix.a, hwFix.sigma, tlp, 250, 20250930n, kappa);
  console.log(`\n=== STOCHASTIC HEADLINE (HW MC a=0.03, ${H.P} paths, seed 20250930) ===`);
  console.log(`martingale check: max|E[D]-P^M| = ${H.meanErrBp.toFixed(3)}bp`);
  console.log(`OFF (CPR0): IR=${bp(H.off.ir)}  LP=${bp(H.off.lp)}  all-in=${bp(H.off.all)}`);
  console.log(`ON  (R&R) : IR=${bp(H.on.ir)}  LP=${bp(H.on.lp)}  all-in=${bp(H.on.all)}  WAL=${H.walOn.toFixed(2)}y  lifeCPR=${pct(H.cprOn)}%`);
  console.log(`stoch option premium: IR=${bp(H.on.ir - H.off.ir)}  LP=${bp(H.on.lp - H.off.lp)}  all-in=${bp(H.on.all - H.off.all)}`);

  // ---- Machinery control ----
  console.log(`\n=== CONTROL: stoch-off vs det-off (must match within MC noise) ===`);
  console.log(`IR : det=${bp(detOff.ir)}  stoch=${bp(H.off.ir)}  diff=${bp(H.off.ir - detOff.ir)}bp`);
  console.log(`all: det=${bp(detOff.all)}  stoch=${bp(H.off.all)}  diff=${bp(H.off.all - detOff.all)}bp`);

  // ---- Vol value the static strip omits (headline) ----
  const volIR = (H.on.ir - H.off.ir) - (detOn.ir - detOff.ir);
  const volLP = (H.on.lp - H.off.lp) - (detOn.lp - detOff.lp);
  const volAll = (H.on.all - H.off.all) - (detOn.all - detOff.all);
  console.log(`\n=== VOL VALUE = stoch premium - det premium (what one path misses) [a=0.03] ===`);
  console.log(`IR=${bp(volIR)}bp  LP=${bp(volLP)}bp  all-in=${bp(volAll)}bp`);

  // ---- A cross-check: Z (det) vs OAS (stoch), both SOFR; compare Z-OAS to IR vol value ----
  const z = solveZSpread(cfDetOn, (t) => curve.discountFactor(t), N);
  console.log(`\n=== A cross-check: Z-spread (static) vs OAS (stochastic), both over SOFR ===`);
  console.log(`Z-spread=${bp(z)}bp  OAS=${bp(H.oas)}bp  option cost (Z-OAS)=${bp(z - H.oas)}bp`);
  console.log(`  apples-to-apples comparator is the IR-leg vol value=${bp(volIR)}bp (both SOFR-only; ~few-bp gap expected, distinct functionals)`);

  // ---- Sensitivity: a-free (Ho-Lee) upper bound ----
  const S = runStoch(curve, hwFree.a, hwFree.sigma, tlp, 250, 20250930n, kappa);
  const volIRfree = (S.on.ir - S.off.ir) - (detOn.ir - detOff.ir);
  const volAllfree = (S.on.all - S.off.all) - (detOn.all - detOff.all);
  console.log(`\n=== SENSITIVITY: option cost band over calibration ===`);
  console.log(`IR  vol value: a=0.03 -> ${bp(volIR)}bp   a-free(Ho-Lee) -> ${bp(volIRfree)}bp`);
  console.log(`all vol value: a=0.03 -> ${bp(volAll)}bp   a-free(Ho-Lee) -> ${bp(volAllfree)}bp`);

  // ---- Ch3 coherence ----
  console.log(`\n=== Ch3 coherence (canon: base CPR 10%, WAL 7.68y) ===`);
  console.log(`det-on  : lifeCPR=${pct(cprDetOn)}%  WAL=${walDetOn.toFixed(2)}y`);
  console.log(`stoch-on: lifeCPR=${pct(H.cprOn)}%  WAL=${H.walOn.toFixed(2)}y`);

  // ---- Convergence (a=0.03) ----
  console.log(`\n=== CONVERGENCE: stoch-on IR / all-in by path count (a=0.03) ===`);
  for (const np of [50, 250, 1000]) {
    const r = runStoch(curve, hwFix.a, hwFix.sigma, tlp, np, 20250930n, kappa);
    console.log(`  ${String(2 * np).padStart(4)} paths: IR=${bp(r.on.ir)}  all-in=${bp(r.on.all)}  OAS=${bp(r.oas)}  (martErr ${r.meanErrBp.toFixed(3)}bp)`);
  }
  const seeds = [20250930n, 11111111n, 99999999n];
  const irs: number[] = [], alls: number[] = [];
  for (const sd of seeds) {
    const r = runStoch(curve, hwFix.a, hwFix.sigma, tlp, 250, sd, kappa);
    irs.push(r.on.ir); alls.push(r.on.all);
  }
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const std = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
  console.log(`  seed dispersion @500 paths: IR mean=${bp(mean(irs))} std=${bp(std(irs))}bp  all mean=${bp(mean(alls))} std=${bp(std(alls))}bp`);
}

main().catch((e) => { console.error(e); process.exit(1); });
