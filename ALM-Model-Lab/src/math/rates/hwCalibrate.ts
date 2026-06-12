/**
 * Hull-White 1-factor least-squares calibration.
 *
 * TypeScript port of `research/hw_calibrate.py`. Fits (a, sigma) by minimising
 * squared deviations between HW-model and market normal vols on the ATM column
 * of the cap surface.
 *
 * Solver: ml-levenberg-marquardt (npm), with bounded parameters. Mirrors
 * scipy.optimize.least_squares(method="trf") semantics for the cases this
 * calibration needs.
 *
 * Acceptance threshold: RMSE <= 5 bps in normal vol terms across ATM cap surface
 * (Steph audit memo Sec 7).
 */

import { levenbergMarquardt } from "ml-levenberg-marquardt";

import type { MarketSnapshot } from "./marketData";
import type { ZeroCurve } from "./bootstrap";
import { hwCapletNormalVol, hwCapletNormalVolVec } from "./hwPricing";

/** Default underlying period for SOFR caps (3 months). */
export const DEFAULT_UNDERLYING_TAU = 0.25;

export interface HWCalibrationResult {
  a: number;
  sigma: number;
  rmseBp: number;
  residualsBp: number[];
  expiries: number[];
  marketVols: number[];
  modelVols: number[];
  forwards: number[];
  iterations: number;
  underlyingTau: number;
}

interface ATMTargets {
  expiries: number[];
  marketVols: number[];
  forwards: number[];
}

function atmCapTargets(
  snapshot: MarketSnapshot,
  curve: ZeroCurve,
  underlyingTau: number,
): ATMTargets {
  const expiries: number[] = [];
  const marketVols: number[] = [];
  const forwards: number[] = [];
  for (const q of snapshot.capQuotes) {
    if (!q.isAtm) continue;
    expiries.push(q.expiryYears);
    marketVols.push(q.normalVol);
    forwards.push(curve.forwardRate(q.expiryYears, q.expiryYears + underlyingTau));
  }
  if (expiries.length === 0) {
    throw new Error("no ATM cap quotes in surface");
  }
  return { expiries, marketVols, forwards };
}

export interface HWCalibrationOptions {
  underlyingTau?: number;
  aInit?: number;
  sigmaInit?: number;
  aBounds?: [number, number];
  sigmaBounds?: [number, number];
  maxIterations?: number;
}

export function calibrateHW(
  snapshot: MarketSnapshot,
  curve: ZeroCurve,
  options: HWCalibrationOptions = {},
): HWCalibrationResult {
  const underlyingTau = options.underlyingTau ?? DEFAULT_UNDERLYING_TAU;
  const aInit = options.aInit ?? 0.05;
  const sigmaInit = options.sigmaInit ?? 0.01;
  const [aMin, aMax] = options.aBounds ?? [1e-4, 0.5];
  const [sigMin, sigMax] = options.sigmaBounds ?? [1e-6, 0.05];
  const maxIterations = options.maxIterations ?? 2000;

  const { expiries, marketVols, forwards } = atmCapTargets(snapshot, curve, underlyingTau);

  // Levenberg-Marquardt expects (x, y) with x scalar per data point. Use
  // index x = i and look up (expiry, forward) by index in the closure.
  const xs = expiries.map((_, i) => i);
  // Targets in bps for stable scaling.
  const ys = marketVols.map((v) => v * 1e4);

  const parameterizedFunction = (params: number[]) => {
    return (x: number) => {
      const idx = Math.round(x);
      const v = hwCapletNormalVol(params[0], params[1], expiries[idx], underlyingTau, forwards[idx]);
      return v * 1e4; // also bps
    };
  };

  const result = levenbergMarquardt({ x: xs, y: ys }, parameterizedFunction, {
    initialValues: [aInit, sigmaInit],
    minValues: [aMin, sigMin],
    maxValues: [aMax, sigMax],
    damping: 1e-2,
    gradientDifference: [1e-6, 1e-7],
    centralDifference: true,
    maxIterations,
    errorTolerance: 1e-8,
  });

  const aFit = result.parameterValues[0];
  const sigmaFit = result.parameterValues[1];
  const modelVols = hwCapletNormalVolVec(aFit, sigmaFit, expiries, underlyingTau, forwards);
  const residualsBp = modelVols.map((m, i) => (m - marketVols[i]) * 1e4);
  const rmseBp = Math.sqrt(residualsBp.reduce((s, r) => s + r * r, 0) / residualsBp.length);

  return {
    a: aFit,
    sigma: sigmaFit,
    rmseBp,
    residualsBp,
    expiries,
    marketVols,
    modelVols,
    forwards,
    iterations: result.iterations,
    underlyingTau,
  };
}
