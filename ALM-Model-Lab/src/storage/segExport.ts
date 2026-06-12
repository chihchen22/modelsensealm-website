/**
 * SEG / EBP per-instrument workbook export.
 *
 * One file per instrument with tabs labelled `[scenario]_[output]`. Each
 * scenario × output tab has rows = months 1..H and per-path columns split
 * into two blocks: "existing" (existing-book contribution) and "NB total"
 * (sum of replacement-vintage contributions). Adding the two blocks
 * column-wise reproduces the static-balance-sheet portfolio total per path.
 *
 * Scenarios: base (no shock), up (+10 bp at step ≥ 1), down (−10 bp at step
 * ≥ 1). Outputs: balance, coupon, principal, interest. Plus a Summary tab
 * with the engine's cross-100-path SEG aggregates.
 *
 * Vintages run on each MC path (not deterministic), so the per-path NB
 * totals are genuinely path-dependent.
 */

import { utils, write } from "xlsx";

import type { Instrument, RatePath } from "../math/instruments/types";
import { StochasticRatePath, type HWForwardBundle } from "../math/rates/ratePath";
import {
  runSegOnInstrument,
  runStaticBalanceScenario,
  ShockedPath,
  type PortfolioTrajectory,
  type SegOutput,
} from "../math/analytics/seg";

const SHOCK_BP = 10;
const DT = 1 / 12;

type ScenarioKey = "base" | "up" | "down";
type OutputKey = "balance" | "coupon" | "principal" | "interest";

interface ExistingNbSeries {
  /** Per-month existing-book value at start of month. */
  existing: Float64Array;
  /** Per-month sum across all live vintages at start of month. */
  nbTotal: Float64Array;
}

/** Pull (existing, NB-total) per-output series out of a portfolio trajectory.
 *  - balance: start-of-month balance
 *  - coupon: existing's coupon rate, NB block reports a balance-weighted
 *            average coupon across live vintages (or 0 if no live vintage)
 *  - principal: principal paid in month
 *  - interest: interest paid in month
 */
function extractExistingNb(
  traj: PortfolioTrajectory,
  outputKey: OutputKey,
  horizon: number,
): ExistingNbSeries {
  const existing = new Float64Array(horizon);
  const nbTotal = new Float64Array(horizon);

  for (let m = 1; m <= horizon; m++) {
    const t = m - 1;
    if (outputKey === "balance") {
      existing[t] = traj.existing.balance[t];
    } else if (outputKey === "coupon") {
      existing[t] = traj.existing.coupon[t];
    } else if (outputKey === "principal") {
      existing[t] = traj.existing.principal[t];
    } else {
      existing[t] = traj.existing.interest[t];
    }

    let nbSum = 0;
    let nbBalSum = 0;
    let nbWeightedCoupon = 0;
    for (const v of traj.vintages) {
      const localM = m - v.startMonth;
      if (localM >= 1 && localM <= v.cashflows.length) {
        const c = v.cashflows[localM - 1];
        if (outputKey === "balance") nbSum += c.balance;
        else if (outputKey === "principal") nbSum += c.principalPaid;
        else if (outputKey === "interest") nbSum += c.interestPaid;
        else if (outputKey === "coupon") {
          nbBalSum += c.balance;
          nbWeightedCoupon += c.balance * c.couponRate;
        }
      }
    }
    if (outputKey === "coupon") {
      nbTotal[t] = nbBalSum > 1e-9 ? nbWeightedCoupon / nbBalSum : 0;
    } else {
      nbTotal[t] = nbSum;
    }
  }

  return { existing, nbTotal };
}

interface ScenarioBundle {
  /** Per path: existing + NB total for each output type. */
  perPath: Array<Record<OutputKey, ExistingNbSeries>>;
  /** Per path: 1M rate trajectory under this scenario. */
  rates: Float64Array[];
}

function runScenarioForAllPaths(
  instrument: Instrument,
  mcPaths: ReadonlyArray<Float64Array>,
  deterministicPath: RatePath,
  horizon: number,
  shock: ScenarioKey,
  hwForward?: HWForwardBundle,
): ScenarioBundle {
  const perPath: Array<Record<OutputKey, ExistingNbSeries>> = [];
  const rates: Float64Array[] = [];
  for (let p = 0; p < mcPaths.length; p++) {
    const hw = hwForward
      ? { xPath: hwForward.xPaths[p], a: hwForward.a, sigma: hwForward.sigma, curve: hwForward.curve }
      : undefined;
    const mcPath = new StochasticRatePath(Array.from(mcPaths[p]), DT, hw);
    const path =
      shock === "base"
        ? mcPath
        : new ShockedPath(mcPath, shock === "up" ? +SHOCK_BP : -SHOCK_BP);
    const traj = runStaticBalanceScenario(instrument, path, path, deterministicPath, horizon);
    const bundle: Record<OutputKey, ExistingNbSeries> = {
      balance: extractExistingNb(traj, "balance", horizon),
      coupon: extractExistingNb(traj, "coupon", horizon),
      principal: extractExistingNb(traj, "principal", horizon),
      interest: extractExistingNb(traj, "interest", horizon),
    };
    perPath.push(bundle);
    const rateRow = new Float64Array(horizon);
    for (let m = 1; m <= horizon; m++) rateRow[m - 1] = path.rateAt(m - 1);
    rates.push(rateRow);
  }
  return { perPath, rates };
}

/** Build the AOA for one scenario × output tab. Layout:
 *  - Cols A, B: month, t (start of month)
 *  - Block 1 ("existing", nPaths cols): path_001 ... path_N existing values
 *  - Block 2 ("NB total", nPaths cols): path_001 ... path_N vintage-aggregate values
 */
function scenarioOutputAoa(
  bundle: ScenarioBundle,
  outputKey: OutputKey,
  scenarioLabel: string,
  horizon: number,
): unknown[][] {
  const nPaths = bundle.perPath.length;

  const header1: unknown[] = [scenarioLabel, ""];
  for (let p = 0; p < nPaths; p++) header1.push(p === 0 ? "existing" : "");
  for (let p = 0; p < nPaths; p++) header1.push(p === 0 ? "NB total" : "");

  const header2: unknown[] = ["month", "t (start of month)"];
  for (let p = 0; p < nPaths; p++) header2.push(`path_${String(p + 1).padStart(3, "0")}`);
  for (let p = 0; p < nPaths; p++) header2.push(`path_${String(p + 1).padStart(3, "0")}`);

  const rows: unknown[][] = [header1, header2];
  for (let m = 1; m <= horizon; m++) {
    const t = m - 1;
    const row: unknown[] = [m, t];
    for (let p = 0; p < nPaths; p++) row.push(bundle.perPath[p][outputKey].existing[t]);
    for (let p = 0; p < nPaths; p++) row.push(bundle.perPath[p][outputKey].nbTotal[t]);
    rows.push(row);
  }
  return rows;
}

function summarySheetAoa(
  out: SegOutput,
  horizon: number,
  meta: { label: string; instrumentType: string; notional: number; side: string; initialBeta?: number },
): unknown[][] {
  const rows: unknown[][] = [
    ["Instrument", meta.label],
    ["Type", meta.instrumentType],
    ["Side", meta.side],
    ["Notional ($)", meta.notional],
    ...(meta.initialBeta !== undefined ? [["β at t=0", meta.initialBeta]] : []),
    ["Δr (decimal, 20bp)", 0.002],
    ["dt", DT],
    ["Shock convention", "±10 bp parallel, applied at step ≥ 1"],
    ["Cumulative SEG formula", "(NII_up(month t+1) − NII_down(month t+1)) × 12 / Δr"],
    ["Outstanding SEG formula", "side_sign × (Notional − Cumulative SEG(t)); t=0 hardcoded"],
    ["Periodic SEG formula", "Outstanding(t−1) − Outstanding(t); periodic(0) = 0"],
    ["Side sign", meta.side === "liability" ? -1 : +1],
    [
      "Note",
      "Engine output below is signed (asset positive, liability negative). UI charts display absolute magnitudes.",
    ],
    [],
    [
      "t (months)",
      "EBP det ($)",
      "EBP MC mean ($)",
      "EBP MC P5 ($)",
      "EBP MC P95 ($)",
      "Cumulative SEG det ($)",
      "Cumulative SEG MC mean ($)",
      "Outstanding SEG det ($)",
      "Outstanding SEG MC mean ($)",
      "Outstanding SEG MC P5 ($)",
      "Outstanding SEG MC P95 ($)",
      "Periodic SEG det ($)",
      "Periodic SEG MC mean ($)",
    ],
  ];
  for (let t = 0; t < horizon; t++) {
    rows.push([
      t,
      out.ebpDeterministic[t],
      out.ebpMcMean[t],
      out.ebpMcP5[t],
      out.ebpMcP95[t],
      out.cumulativeSegDeterministic[t],
      out.cumulativeSegMean[t],
      out.outstandingSegDeterministic[t],
      out.outstandingSegMean[t],
      out.outstandingSegP5[t],
      out.outstandingSegP95[t],
      out.periodicSegDeterministic[t],
      out.periodicSegMean[t],
    ]);
  }
  return rows;
}

export interface SegExportInputs {
  instrument: Instrument;
  mcPaths: ReadonlyArray<Float64Array>;
  deterministicPath: RatePath;
  horizon: number;
  displayLabel: string;
  hwForward?: HWForwardBundle;
}

export function buildSegInstrumentWorkbook(inputs: SegExportInputs): Uint8Array {
  const { instrument, mcPaths, deterministicPath, horizon, displayLabel, hwForward } = inputs;

  const segOut = runSegOnInstrument(instrument, mcPaths, deterministicPath, { horizon }, hwForward);

  const baseBundle = runScenarioForAllPaths(instrument, mcPaths, deterministicPath, horizon, "base", hwForward);
  const upBundle = runScenarioForAllPaths(instrument, mcPaths, deterministicPath, horizon, "up", hwForward);
  const downBundle = runScenarioForAllPaths(instrument, mcPaths, deterministicPath, horizon, "down", hwForward);

  const wb = utils.book_new();

  utils.book_append_sheet(
    wb,
    utils.aoa_to_sheet(
      summarySheetAoa(segOut, horizon, {
        label: displayLabel,
        instrumentType: instrument.terms.type,
        notional: instrument.terms.notional,
        side: instrument.terms.side ?? "asset",
        initialBeta: segOut.initialBeta,
      }),
    ),
    "Summary",
  );

  const scenarios: Array<[ScenarioKey, ScenarioBundle, string]> = [
    ["base", baseBundle, `Base (no shock): ${displayLabel}`],
    ["up", upBundle, `Up +10bp (shock at step ≥ 1): ${displayLabel}`],
    ["down", downBundle, `Down −10bp (shock at step ≥ 1): ${displayLabel}`],
  ];
  const outputs: OutputKey[] = ["balance", "coupon", "principal", "interest"];

  for (const [scenarioKey, bundle, scenarioLabel] of scenarios) {
    for (const outputKey of outputs) {
      const tabName = `${scenarioKey}_${outputKey}`;
      const sheet = utils.aoa_to_sheet(scenarioOutputAoa(bundle, outputKey, scenarioLabel, horizon));
      utils.book_append_sheet(wb, sheet, tabName);
    }
  }

  const data = write(wb, { bookType: "xlsx", type: "array" });
  return new Uint8Array(data);
}

export function downloadXlsx(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes.buffer as ArrayBuffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
