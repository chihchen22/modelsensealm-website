/**
 * Ch4 Section 4.5 FTP worked examples — Tables 4.1 and 4.2.
 * Run: npx tsx research/ch04_ftp_compute.ts
 */
import { bootstrapZeroCurve } from "../src/math/rates/bootstrap";
import type { ZeroCurve } from "../src/math/rates/bootstrap";
import { loadMarketSnapshot } from "../src/math/rates/marketData";
import { DEFAULT_TLP_CURVE } from "../src/math/rates/tlpCurve";
import { DeterministicRatePath } from "../src/math/rates/ratePath";
import { FixedLoan } from "../src/math/instruments/fixedLoan";
import { FloatingLoan } from "../src/math/instruments/floatingLoan";
import { Mortgage } from "../src/math/instruments/mortgage";
import { MBS_DEFAULTS } from "../src/math/behavioral/mbsModel";
import { computeFTP } from "../src/math/analytics/ftp";
import type { Cashflow, Instrument } from "../src/math/instruments/types";

const bp = (x: number) => (x * 1e4).toFixed(1);
const pct = (x: number) => (x * 100).toFixed(3);

/** Bullet cashflow: principal returns in full at `months`. */
function bulletCF(notional: number, months: number): Cashflow[] {
  const out: Cashflow[] = [];
  for (let m = 1; m <= months; m++) {
    out.push({ monthOffset: m, balance: notional, principalPaid: m === months ? notional : 0, interestPaid: 0, couponRate: 0 });
  }
  return out;
}

/** Linear (level-principal) amortization: equal principal each month over `months`. */
function linearAmortCF(notional: number, months: number): Cashflow[] {
  const out: Cashflow[] = [];
  const prin = notional / months;
  let bal = notional;
  for (let m = 1; m <= months; m++) {
    out.push({ monthOffset: m, balance: bal, principalPaid: prin, interestPaid: 0, couponRate: 0 });
    bal -= prin;
  }
  return out;
}

/** Minimal synthetic instrument from an explicit cashflow schedule (par-match only). */
function synthetic(id: string, label: string, notional: number, cf: Cashflow[]): Instrument {
  return {
    terms: { id, type: "fixed-loan", label, notional, maturityMonths: cf.length, originationOffsetMonths: 0, amortType: "bullet", side: "liability" },
    generateCashflows: () => cf,
    repricingSchedule: () => [],
  };
}

/** Parallel shift of the continuously-compounded zero curve by `delta` (decimal). */
function shiftCurve(base: ZeroCurve, delta: number): ZeroCurve {
  return {
    t: base.t,
    z: base.z.map((z) => z + delta),
    zeroRate: (time: number) => base.zeroRate(time) + delta,
    discountFactor: (time: number) => base.discountFactor(time) * Math.exp(-delta * time),
    forwardRate(t1: number, t2: number) {
      return (this.discountFactor(t1) / this.discountFactor(t2) - 1) / (t2 - t1);
    },
    forwardSwapRate(t1: number, t2: number) {
      const tau = t2 - t1;
      if (tau <= 1 + 1e-9) return (this.discountFactor(t1) / this.discountFactor(t2) - 1) / tau;
      const n = Math.round(tau);
      let a = 0;
      for (let k = 1; k <= n; k++) a += (365 / 360) * this.discountFactor(t1 + k);
      return (this.discountFactor(t1) - this.discountFactor(t1 + n)) / a;
    },
  };
}

async function main() {
  const snap = await loadMarketSnapshot("research/data/market_2025-09-30.json");
  const curve = bootstrapZeroCurve(snap);
  const tlp = DEFAULT_TLP_CURVE;

  console.log(`=== Curve (${snap.calibrationDate}) reference points ===`);
  console.log(`SOFR 1M (fwd 0->1m): ${pct(curve.forwardRate(0, 1 / 12))}%`);
  console.log(`SOFR 1Y par:         ${pct(curve.forwardSwapRate(0, 1))}%`);
  console.log(`SOFR 5Y par:         ${pct(curve.forwardSwapRate(0, 5))}%`);
  console.log(`SOFR 10Y par:        ${pct(curve.forwardSwapRate(0, 10))}%`);
  console.log(`TLP 1M=${bp(tlp.tlp(1 / 12))}bp  TLP 5Y=${bp(tlp.tlp(5))}bp  TLP 10Y=${bp(tlp.tlp(10))}bp`);

  // ---------- Table 4.1: fixed vs floating 5Y bullet, $100M ----------
  const N = 100e6;
  const fixed = new FixedLoan({
    id: "fix5y", type: "fixed-loan", label: "5Y bullet fixed 5%",
    notional: N, maturityMonths: 60, originationOffsetMonths: 0,
    amortType: "bullet", coupon: 0.05,
  });
  const floater = new FloatingLoan({
    id: "flt5y", type: "floating-loan", label: "5Y bullet floater 1M+200",
    notional: N, maturityMonths: 60, originationOffsetMonths: 0,
    amortType: "bullet", indexTenorMonths: 1, margin: 0.02, resetFrequencyMonths: 1,
  });
  const path41 = new DeterministicRatePath(curve, 60);
  const r41 = computeFTP([fixed, floater], curve, tlp, path41);
  const fx = r41.perInstrument[0];
  const fl = r41.perInstrument[1];

  console.log(`\n=== TABLE 4.1: fixed vs floating 5Y bullet ($100M) ===`);
  console.log(`FIXED   par-match: IR=${bp(fx.irFtpRate)}bp  LP=${bp(fx.lpFtpRate)}bp  all-in=${bp(fx.allInFtpRate)}bp  coupon=${pct(fx.assetRate)}%  margin=${bp(fx.ftpMargin)}bp`);
  console.log(`FLOATER par-match: IR=${bp(fl.irFtpRate)}bp  LP=${bp(fl.lpFtpRate)}bp  all-in=${bp(fl.allInFtpRate)}bp  coupon(m1)=${pct(fl.monthlySeries[0].couponRate)}%  margin=${bp(fl.ftpMargin)}bp`);
  console.log(`FLOATER reset view: IR FTP @1M reset = SOFR 1M = ${pct(curve.forwardRate(0, 1 / 12))}%  ; liquidity FTP @5Y funding tenor = TLP(5Y) = ${bp(tlp.tlp(5))}bp`);
  console.log(`Reconciliation: fixed reprices & funds at 5Y (IR=5Y SOFR, LP=TLP@5Y). Floater reprices at 1M (IR=1M SOFR) but funds 5Y (LP=TLP@5Y).`);

  // ---------- Table 4.2: 30Y mortgage, deterministic option-adjusted ----------
  function makeMortgage(cpr: number): Mortgage {
    return new Mortgage({
      id: `m_cpr${cpr}`, type: "mortgage", label: `30Y 6% CPR${cpr}`,
      notional: N, originalBalance: N, originalTermMonths: 360, ageMonths: 0,
      maturityMonths: 360, originationOffsetMonths: 0, amortType: "level-pay", noteRate: 0.06,
      cprParams: { ...MBS_DEFAULTS, wac: 6, minCpr: cpr, maxCpr: cpr, seasonalityAmp: 0, burnoutDecay: 0, seasoningRamp: 1 },
    });
  }

  // Ch3 v17 convexity triple: +200bp -> CPR 5%, base -> CPR 10%, -200bp -> CPR 25%.
  const scenarios = [
    { name: "-200bp", delta: -0.02, cprOn: 25 },
    { name: "base", delta: 0.0, cprOn: 10 },
    { name: "+200bp", delta: 0.02, cprOn: 5 },
  ];

  console.log(`\n=== TABLE 4.2: 30Y mortgage ($100M, 6% WAC) per-scenario ===`);
  const onRows: { ir: number; lp: number; all: number; wal: number }[] = [];
  const offRows: { ir: number; lp: number; all: number; wal: number }[] = [];
  for (const s of scenarios) {
    const cs = shiftCurve(curve, s.delta);
    const ps = new DeterministicRatePath(cs, 360);
    const mOn = makeMortgage(s.cprOn);
    const mOff = makeMortgage(0);
    const rOn = computeFTP([mOn], cs, tlp, ps).perInstrument[0];
    const rOff = computeFTP([mOff], cs, tlp, ps).perInstrument[0];
    const walOn = mOn.summary(ps).walYears;
    const walOff = mOff.summary(ps).walYears;
    onRows.push({ ir: rOn.irFtpRate, lp: rOn.lpFtpRate, all: rOn.allInFtpRate, wal: walOn });
    offRows.push({ ir: rOff.irFtpRate, lp: rOff.lpFtpRate, all: rOff.allInFtpRate, wal: walOff });
    console.log(`  ${s.name.padEnd(7)} ON  (CPR${s.cprOn}%): IR=${bp(rOn.irFtpRate)}  LP=${bp(rOn.lpFtpRate)}  all-in=${bp(rOn.allInFtpRate)}  WAL=${walOn.toFixed(2)}y`);
    console.log(`  ${s.name.padEnd(7)} OFF (CPR0%) : IR=${bp(rOff.irFtpRate)}  LP=${bp(rOff.lpFtpRate)}  all-in=${bp(rOff.allInFtpRate)}  WAL=${walOff.toFixed(2)}y`);
  }
  const avg = (rows: typeof onRows, k: "ir" | "lp" | "all" | "wal") =>
    rows.reduce((s, r) => s + r[k], 0) / rows.length;

  const onIR = avg(onRows, "ir"), onLP = avg(onRows, "lp"), onAll = avg(onRows, "all"), onWal = avg(onRows, "wal");
  const offIR = avg(offRows, "ir"), offLP = avg(offRows, "lp"), offAll = avg(offRows, "all"), offWal = avg(offRows, "wal");

  // Plain base-curve contractual (single scenario) for context.
  const pBase = new DeterministicRatePath(curve, 360);
  const rBaseOff = computeFTP([makeMortgage(0)], curve, tlp, pBase).perInstrument[0];
  const rBaseOn10 = computeFTP([makeMortgage(10)], curve, tlp, pBase).perInstrument[0];

  console.log(`\n--- Scenario-averaged (deterministic option-adjusted) ---`);
  console.log(`OPTION OFF (contractual, CPR0, avg over +-200): IR=${bp(offIR)}  LP=${bp(offLP)}  all-in=${bp(offAll)}  WAL=${offWal.toFixed(2)}y`);
  console.log(`OPTION ON  (behavioral CPR{25,10,5}, avg)     : IR=${bp(onIR)}  LP=${bp(onLP)}  all-in=${bp(onAll)}  WAL=${onWal.toFixed(2)}y`);
  console.log(`DELTA ON-OFF: IR=${bp(onIR - offIR)}bp  LP=${bp(onLP - offLP)}bp  all-in(net)=${bp(onAll - offAll)}bp  WAL=${(onWal - offWal).toFixed(2)}y`);
  console.log(`\n--- Context: base curve only ---`);
  console.log(`base contractual CPR0 : IR=${bp(rBaseOff.irFtpRate)}  LP=${bp(rBaseOff.lpFtpRate)}  all-in=${bp(rBaseOff.allInFtpRate)}  WAL=${makeMortgage(0).summary(pBase).walYears.toFixed(2)}y`);
  console.log(`base behavioral CPR10 : IR=${bp(rBaseOn10.irFtpRate)}  LP=${bp(rBaseOn10.lpFtpRate)}  all-in=${bp(rBaseOn10.allInFtpRate)}  WAL=${makeMortgage(10).summary(pBase).walYears.toFixed(2)}y`);

  console.log(`\n--- Pattern check (v5 finding: LP falls, IR ~flat, net falls; option premium is the stochastic-OAS cost the deterministic strip omits) ---`);
  console.log(`LP falls?  ${onLP < offLP}  (ON ${bp(onLP)} vs OFF ${bp(offLP)})`);
  console.log(`IR ~flat?  ${Math.abs(onIR - offIR) < 10}  (ON ${bp(onIR)} vs OFF ${bp(offIR)}, delta ${bp(onIR - offIR)}bp)`);
  console.log(`Net falls? ${onAll < offAll}  (ON ${bp(onAll)} vs OFF ${bp(offAll)})`);

  // ---------- Table 4.3: NMD replicating-portfolio credit (Ch2 Sec 2.4.1: 25% ON / 50% 6M rolling / 25% 5Y linear) ----------
  const pRP = new DeterministicRatePath(curve, 360);
  const tranches = [
    { w: 0.25, label: "overnight (1M proxy)", instr: synthetic("rp_on", "overnight", N, bulletCF(N, 1)) },
    { w: 0.50, label: "6M rolling", instr: synthetic("rp_6m", "6M rolling", N, bulletCF(N, 6)) },
    { w: 0.25, label: "5Y linear core", instr: synthetic("rp_5y", "5Y linear", N, linearAmortCF(N, 60)) },
  ];
  console.log(`\n=== TABLE 4.3: NMD replicating-portfolio credit ($100M, 25/50/25) ===`);
  let cIR = 0, cLP = 0, cAll = 0;
  for (const tr of tranches) {
    const r = computeFTP([tr.instr], curve, tlp, pRP).perInstrument[0];
    cIR += tr.w * r.irFtpRate; cLP += tr.w * r.lpFtpRate; cAll += tr.w * r.allInFtpRate;
    console.log(`  ${tr.label.padEnd(22)} w=${(tr.w * 100).toFixed(0)}%  IR=${bp(r.irFtpRate)}  LP=${bp(r.lpFtpRate)}  all-in=${bp(r.allInFtpRate)} (${pct(r.allInFtpRate)}%)`);
  }
  console.log(`  WEIGHTED CREDIT (replicating) IR=${bp(cIR)}  LP=${bp(cLP)}  all-in=${bp(cAll)} (= ${pct(cAll)}%)`);

  // Matched-maturity contrast: fund the Ch2 2.6.2 24-month linear-decay schedule as one struck-once strip.
  const rDecay = computeFTP([synthetic("mm_decay", "24M decay strip", N, linearAmortCF(N, 24))], curve, tlp, pRP).perInstrument[0];
  console.log(`  MATCHED-MATURITY (24M linear-decay strip, WAL ~12.5m): IR=${bp(rDecay.irFtpRate)}  LP=${bp(rDecay.lpFtpRate)}  all-in=${bp(rDecay.allInFtpRate)} (= ${pct(rDecay.allInFtpRate)}%)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
