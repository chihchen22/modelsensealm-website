/**
 * Step-2 wiring impact: HW-aware StochasticRatePath term forwards vs the prior
 * averaging fallback, measured on the production SEG path.
 *
 * Builds the exact app default state (free HW calibration on the 2025-09-30
 * snapshot, 100 paths, seed 20250930, 30Y) and runs runSegOnInstrument on each
 * of the five default instruments BOTH ways:
 *   - WITHOUT bundle  -> averaging fallback (pre-wiring production numbers)
 *   - WITH    bundle  -> HW analytic term forwards (post-wiring numbers)
 * and reports the per-instrument delta on the SEG aggregates the Excel export
 * and the SEG/EBP tab display.
 *
 * Run: npx tsx research/ch04_seg_hw_delta.ts
 */

import { bootstrapZeroCurve } from "../src/math/rates/bootstrap";
import { loadMarketSnapshot } from "../src/math/rates/marketData";
import { calibrateHW } from "../src/math/rates/hwCalibrate";
import { simulateHW, projectHWToTenor } from "../src/math/rates/simulateHw";
import { runSegOnInstrument, type SegOutput } from "../src/math/analytics/seg";
import type { HWForwardBundle } from "../src/math/rates/ratePath";
import type { Instrument } from "../src/math/instruments/types";
import { FixedLoan, FIXED_LOAN_DEFAULTS } from "../src/math/instruments/fixedLoan";
import { FloatingLoan, FLOATING_LOAN_DEFAULTS } from "../src/math/instruments/floatingLoan";
import { Mortgage, MORTGAGE_DEFAULTS } from "../src/math/instruments/mortgage";
import { NMDeposit, NMD_TERMS_DEFAULTS } from "../src/math/instruments/nmd";
import { NMDBeta, NMD_B_TERMS_DEFAULTS } from "../src/math/instruments/nmdBeta";
import { DeterministicRatePath } from "../src/math/rates/ratePath";

const DT = 1 / 12;
const TENOR_1M = 1 / 12;

/** Replicate SegEbpTab.buildMcPaths (HW branch): 1M projection, trim/pad to h. */
function buildMcPaths(hwPaths: Float64Array[], horizon: number): Float64Array[] {
  return hwPaths.map((p) => {
    const out = new Float64Array(horizon);
    const n = Math.min(horizon, p.length);
    for (let t = 0; t < n; t++) out[t] = p[t];
    const last = n > 0 ? p[n - 1] : 0;
    for (let t = n; t < horizon; t++) out[t] = last;
    return out;
  });
}

function maxAbsDelta(a: Float64Array, b: Float64Array): { abs: number; at: number } {
  let abs = 0;
  let at = -1;
  for (let t = 0; t < a.length; t++) {
    const d = Math.abs(a[t] - b[t]);
    if (d > abs) {
      abs = d;
      at = t;
    }
  }
  return { abs, at };
}

function row(label: string, fb: SegOutput, hw: SegOutput) {
  const cum = maxAbsDelta(fb.cumulativeSegMean, hw.cumulativeSegMean);
  const out = maxAbsDelta(fb.outstandingSegMean, hw.outstandingSegMean);
  const ebp = maxAbsDelta(fb.ebpMcMean, hw.ebpMcMean);
  const n = fb.cumulativeSegMean.length;
  const fmt = (d: { abs: number; at: number }) =>
    `${(d.abs / 1e3).toFixed(2).padStart(10)}k @t=${String(d.at).padStart(3)}`;
  console.log(
    `${label.padEnd(16)} | cumSEG ${fmt(cum)} | outSEG ${fmt(out)} | EBP ${fmt(ebp)} | (H=${n})`,
  );
}

async function main() {
  const snap = await loadMarketSnapshot("research/data/market_2025-09-30.json");
  const curve = bootstrapZeroCurve(snap);
  // App default calibration is the free fit (no a bounds).
  const hw = calibrateHW(snap, curve);
  const sim = simulateHW(curve, hw.a, hw.sigma, {
    horizonYears: 30,
    dtYears: DT,
    nPairs: 50, // nPaths/2 = 100/2
    seed: 20250930n,
  });
  const hwPaths = projectHWToTenor(sim, curve, TENOR_1M);
  const bundle: HWForwardBundle = { xPaths: sim.XPaths, a: sim.a, sigma: sim.sigma, curve };

  console.log(`HW free fit: a=${hw.a.toFixed(4)} sigma=${(hw.sigma * 1e4).toFixed(1)}bp  nPaths=${sim.nPaths}`);
  console.log("Max |Δ| (HW-analytic minus averaging-fallback) on SEG aggregates:\n");

  const targets: Array<{ label: string; inst: Instrument; h: number }> = [
    { label: "Fixed loan", inst: new FixedLoan(FIXED_LOAN_DEFAULTS), h: FIXED_LOAN_DEFAULTS.maturityMonths },
    { label: "Floating loan", inst: new FloatingLoan(FLOATING_LOAN_DEFAULTS), h: FLOATING_LOAN_DEFAULTS.maturityMonths },
    { label: "Mortgage", inst: new Mortgage(MORTGAGE_DEFAULTS), h: MORTGAGE_DEFAULTS.maturityMonths },
    { label: "Non-IB NMD", inst: new NMDeposit(NMD_TERMS_DEFAULTS), h: NMD_TERMS_DEFAULTS.maturityMonths },
    { label: "IB NMD (beta)", inst: new NMDBeta(NMD_B_TERMS_DEFAULTS), h: NMD_B_TERMS_DEFAULTS.maturityMonths },
  ];

  for (const { label, inst, h } of targets) {
    const mcPaths = buildMcPaths(hwPaths, h);
    const detPath = new DeterministicRatePath(curve, h);
    const fb = runSegOnInstrument(inst, mcPaths, detPath, { horizon: h });
    const hwOut = runSegOnInstrument(inst, mcPaths, detPath, { horizon: h }, bundle);
    row(label, fb, hwOut);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
