/**
 * Save/Load Run bundles.
 *
 * Save Run packages the active calibration + simulation results into a
 * single .zip with the disk-export layout the wireframe specifies:
 *
 *   manifest.json
 *   paths_hw_{tenorLabel}.csv
 *   paths_bgm_{tenorLabel}.csv
 *
 * Path CSVs follow Steph's convention at
 * `ALM-Modeling-Book/chapters/ch03/sofr_paths_100x_v1.csv`. Compatible with
 * Larry, Kobe, and the Marcus Evans masterclass team's pandas readers.
 *
 * Load Run accepts the same .zip layout and reconstructs the AppContext
 * state (snapshot, calibration results, simulation results).
 */

import { unzipSync, zipSync } from "fflate";

/** Maximum total decompressed bytes accepted from a user-uploaded run bundle. */
const MAX_UNZIP_BYTES = 64 * 1024 * 1024; // 64 MB

import type { MarketSnapshot } from "../math/rates/marketData";
import type { ZeroCurve } from "../math/rates/bootstrap";
import type { HWCalibrationResult } from "../math/rates/hwCalibrate";
import type { BGMCalibrationResult } from "../math/rates/bgmCalibrate";
import {
  type HWSimulationResult,
  projectHWToTenor,
} from "../math/rates/simulateHw";
import type { BGMSimulationResult } from "../math/rates/simulateBgm";
import { formatPathsCsv, parsePathsCsv, type PathMatrix } from "./csvFormat";

/** Tenors written to disk. Internal-mode default; the Settings drawer can override. */
export const DEFAULT_EXPORT_TENORS: ReadonlyArray<{ label: string; value: number; bgmIdx: number }> = [
  { label: "1D", value: 1 / 360, bgmIdx: 0 },
  { label: "1M", value: 1 / 12, bgmIdx: 1 },
  { label: "3M", value: 0.25, bgmIdx: 2 },
  { label: "6M", value: 0.5, bgmIdx: 3 },
  { label: "1Y", value: 1.0, bgmIdx: 4 },
  { label: "2Y", value: 2.0, bgmIdx: 5 },
  { label: "5Y", value: 5.0, bgmIdx: 6 },
  { label: "7Y", value: 7.0, bgmIdx: 7 },
  { label: "10Y", value: 10.0, bgmIdx: 8 },
];

/**
 * Run manifest schema.
 *
 * v1 (legacy): no `version` field — treated as version 1. Only rates payload.
 * v2 (current): version=2. Adds optional `instruments[]` and `analytics[]`
 *   slots so future instrument-level and ALM-analytic outputs can ride
 *   alongside the rate payload without breaking older readers.
 *
 * Forward-compat: writers always emit v2. Readers accept both; v1 bundles
 * load with the optional slots defaulted to undefined.
 */
export interface RunManifest {
  /** Manifest schema version. Absent in v1 bundles. */
  version?: 1 | 2;
  runId: string;
  generatedUtc: string;
  calibrationDate: string;
  currency: string;
  discountingIndex: string;
  seed: number;
  nPaths: number;
  horizonYears: number;
  dtYears: number;
  fCeiling: number;
  hw: {
    a: number;
    sigma: number;
    rmseBp: number;
  };
  bgm: {
    a: number;
    b: number;
    c: number;
    d: number;
    beta: number;
    volScalar: number;
    /** Shifted-lognormal LMM displacement δ. δ=0 = pure LMM. */
    displacement: number;
    /** Shifted-CEV LMM exponent β_cev. β=1 = shifted lognormal. */
    cevBeta: number;
    rmseBp: number;
  };
  savedTenors: Array<{ label: string; valueYears: number }>;
  /**
   * Phase-2+ instrument library. Each entry is the instrument terms
   * serialised; concrete schema lives in src/math/instruments/types.ts.
   * Optional in v2; absent until an Instruments tab populates it.
   */
  instruments?: Array<Record<string, unknown>>;
  /**
   * Phase-3+ ALM analytic outputs (repricing gap, liquidity gap, FTP, SEG/EBP).
   * Optional in v2; absent until an Analytics tab populates it.
   */
  analytics?: Array<{
    type: "repricing-gap" | "liquidity-gap" | "ftp" | "seg" | "ebp";
    payload: Record<string, unknown>;
  }>;
}

export interface SaveRunInputs {
  snapshot: MarketSnapshot;
  curve: ZeroCurve;
  hw: HWCalibrationResult;
  bgm: BGMCalibrationResult;
  hwSim: HWSimulationResult;
  bgmSim: BGMSimulationResult;
  seed: number;
  selectedTenorLabels?: ReadonlyArray<string>;
}

function bgmTenorPaths(sim: BGMSimulationResult, tenorIdx: number): Float64Array[] {
  const nSteps = sim.times.length;
  const nT = sim.tenors.length;
  const out: Float64Array[] = new Array(sim.nPaths);
  for (let p = 0; p < sim.nPaths; p++) {
    const path = new Float64Array(nSteps);
    for (let k = 0; k < nSteps; k++) {
      path[k] = sim.rates[(p * nSteps + k) * nT + tenorIdx];
    }
    out[p] = path;
  }
  return out;
}

export function buildRunBundle(inputs: SaveRunInputs): { runId: string; zipBytes: Uint8Array } {
  const { snapshot, curve, hw, bgm, hwSim, bgmSim, seed } = inputs;
  const runId = `${snapshot.calibrationDate}_${seed}_${hwSim.nPaths}paths`;
  const generatedUtc = new Date().toISOString();
  const allowedLabels = inputs.selectedTenorLabels ?? DEFAULT_EXPORT_TENORS.map((t) => t.label);

  const tenors = DEFAULT_EXPORT_TENORS.filter((t) => allowedLabels.includes(t.label));

  const manifest: RunManifest = {
    version: 2,
    runId,
    generatedUtc,
    calibrationDate: snapshot.calibrationDate,
    currency: snapshot.currency,
    discountingIndex: snapshot.discountingIndex,
    seed,
    nPaths: hwSim.nPaths,
    horizonYears: hwSim.horizonYears,
    dtYears: hwSim.dtYears,
    fCeiling: bgmSim.fCeiling,
    hw: { a: hw.a, sigma: hw.sigma, rmseBp: hw.rmseBp },
    bgm: {
      a: bgm.a,
      b: bgm.b,
      c: bgm.c,
      d: bgm.d,
      beta: bgm.beta,
      volScalar: bgm.volScalar,
      displacement: bgm.displacement ?? 0,
      cevBeta: bgm.cevBeta ?? 1.0,
      rmseBp: bgm.rmseBp,
    },
    savedTenors: tenors.map((t) => ({ label: t.label, valueYears: t.value })),
  };

  const files: Record<string, Uint8Array> = {};
  const enc = new TextEncoder();

  files["manifest.json"] = enc.encode(JSON.stringify(manifest, null, 2));

  for (const t of tenors) {
    const hwPaths = projectHWToTenor(hwSim, curve, t.value);
    const hwMatrix: PathMatrix = { times: hwSim.times, paths: hwPaths };
    files[`paths_hw_${t.label}.csv`] = enc.encode(formatPathsCsv(hwMatrix));

    const bgmPaths = bgmTenorPaths(bgmSim, t.bgmIdx);
    const bgmMatrix: PathMatrix = { times: bgmSim.times, paths: bgmPaths };
    files[`paths_bgm_${t.label}.csv`] = enc.encode(formatPathsCsv(bgmMatrix));
  }

  // calibration_report.txt: human-readable per-instrument residual tables.
  files["calibration_report.txt"] = enc.encode(formatCalibrationReport(hw, bgm));

  const zipBytes = zipSync(files, { level: 6 });
  return { runId, zipBytes };
}

function formatCalibrationReport(hw: HWCalibrationResult, bgm: BGMCalibrationResult): string {
  const lines: string[] = [];
  lines.push("ALM Model Lab: calibration report");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("Hull-White 1F");
  lines.push(`  a       = ${hw.a.toFixed(6)}`);
  lines.push(`  sigma   = ${hw.sigma.toFixed(6)}`);
  lines.push(`  RMSE    = ${hw.rmseBp.toFixed(4)} bp`);
  lines.push("");
  lines.push("BGM Rebonato 2F");
  lines.push(`  a          = ${bgm.a.toFixed(6)}`);
  lines.push(`  b          = ${bgm.b.toFixed(6)}`);
  lines.push(`  c          = ${bgm.c.toFixed(6)}`);
  lines.push(`  d          = ${bgm.d.toFixed(6)}`);
  lines.push(`  beta       = ${bgm.beta.toFixed(6)}`);
  lines.push(`  vol_scalar = ${bgm.volScalar.toFixed(6)}`);
  lines.push(`  delta      = ${(bgm.displacement ?? 0).toFixed(6)}  (shifted-lognormal displacement)`);
  lines.push(`  cev_beta   = ${(bgm.cevBeta ?? 1.0).toFixed(4)}      (shifted-CEV exponent; β=1 = DD)`);
  lines.push(`  RMSE       = ${bgm.rmseBp.toFixed(4)} bp`);
  return lines.join("\n") + "\n";
}

export interface LoadedRun {
  manifest: RunManifest;
  hwPathsByTenor: Map<string, { times: Float64Array; paths: Float64Array[] }>;
  bgmPathsByTenor: Map<string, { times: Float64Array; paths: Float64Array[] }>;
  calibrationReport: string;
}

function isRunManifest(obj: unknown): obj is RunManifest {
  if (obj === null || typeof obj !== "object") return false;
  const m = obj as Record<string, unknown>;
  return (
    typeof m.calibrationDate === "string" &&
    typeof m.seed === "number" &&
    typeof m.nPaths === "number" &&
    typeof m.horizonYears === "number" &&
    typeof m.fCeiling === "number"
  );
}

export function parseRunBundle(zipBytes: Uint8Array): LoadedRun {
  const files = unzipSync(zipBytes);

  let totalBytes = 0;
  for (const bytes of Object.values(files)) totalBytes += bytes.byteLength;
  if (totalBytes > MAX_UNZIP_BYTES) {
    throw new Error(
      `Bundle decompressed to ${(totalBytes / 1024 / 1024).toFixed(1)} MB, ` +
        `exceeding the ${MAX_UNZIP_BYTES / 1024 / 1024} MB limit.`
    );
  }

  const dec = new TextDecoder();

  const manifestRaw = files["manifest.json"];
  if (!manifestRaw) throw new Error("missing manifest.json in bundle");
  const parsedManifest: unknown = JSON.parse(dec.decode(manifestRaw));
  if (!isRunManifest(parsedManifest)) {
    throw new Error("manifest.json is missing required fields or has wrong types");
  }
  const manifest = parsedManifest;

  const hwPathsByTenor = new Map<string, { times: Float64Array; paths: Float64Array[] }>();
  const bgmPathsByTenor = new Map<string, { times: Float64Array; paths: Float64Array[] }>();
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith(".csv")) continue;
    const text = dec.decode(bytes);
    const parsed = parsePathsCsv(text);
    const hwMatch = /^paths_hw_(.+)\.csv$/.exec(name);
    const bgmMatch = /^paths_bgm_(.+)\.csv$/.exec(name);
    if (hwMatch) hwPathsByTenor.set(hwMatch[1], parsed);
    if (bgmMatch) bgmPathsByTenor.set(bgmMatch[1], parsed);
  }

  const reportRaw = files["calibration_report.txt"];
  const calibrationReport = reportRaw ? dec.decode(reportRaw) : "";

  return { manifest, hwPathsByTenor, bgmPathsByTenor, calibrationReport };
}

/** Trigger a browser download of the given bytes as a file. */
export function triggerDownload(bytes: Uint8Array, filename: string): void {
  // Slice to detach the underlying buffer type from any SharedArrayBuffer
  // possibility — keeps TS structural types happy for Blob construction.
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Defer revoke so the download starts.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
