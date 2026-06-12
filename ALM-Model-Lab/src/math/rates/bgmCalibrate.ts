/**
 * BGM/LMM Rebonato 2-factor least-squares calibration.
 *
 * TypeScript port of `research/bgm_calibrate.py`. Fits (a, b, c, d, beta,
 * volScalar) to ATM swaptions via ml-levenberg-marquardt with bounds.
 *
 * Acceptance threshold: RMSE <= 10 bps in normal vol terms across the ATM
 * swaption grid (Steph audit memo Sec 7).
 */

import { levenbergMarquardt } from "ml-levenberg-marquardt";

import type { MarketSnapshot } from "./marketData";
import type { ZeroCurve } from "./bootstrap";
import {
  buildSwap,
  rebonatoSwaptionNormalVolGrid,
  type RebonatoParams,
  type SwapStructure,
} from "./bgmPricing";

export interface BGMCalibrationResult extends RebonatoParams {
  rmseBp: number;
  residualsBp: number[];
  expiries: number[];
  tenors: number[];
  parRates: number[];
  marketVols: number[];
  modelVols: number[];
  iterations: number;
  /** Displacement δ used at fit time (echoed for downstream consumers). */
  displacement: number;
  /** CEV exponent β_cev used at fit time. β=1 = shifted lognormal LMM. */
  cevBeta: number;
}

export interface BGMCalibrationOptions {
  aInit?: number;
  bInit?: number;
  cInit?: number;
  dInit?: number;
  betaInit?: number;
  volScalarInit?: number;
  maxIterations?: number;
  /** Displacement δ for shifted-lognormal LMM. Held fixed during fit. */
  displacement?: number;
  /** CEV exponent β_cev for shifted-CEV LMM. Held fixed during fit. β=1 = DD. */
  cevBeta?: number;
}

/**
 * Default (a, b, c, d) starting points. The Rebonato surface has local
 * minima; LM from a single start can land 1-2 bp above the best fit
 * depending on the quote set (observed on the 2026-03-31 subset, where the
 * legacy start converges to 6.6 bp vs 5.1 bp from the second start). When
 * the caller supplies no explicit inits, every start is fit and the lowest
 * RMSE wins, mirroring scipy TRF's basin on the reference runs.
 */
const DEFAULT_ABCD_STARTS: ReadonlyArray<[number, number, number, number]> = [
  [0.10, 0.20, 0.50, 0.80],
  [0.60, 0.60, 0.65, 0.70],
];

export function calibrateBGM(
  snapshot: MarketSnapshot,
  curve: ZeroCurve,
  options: BGMCalibrationOptions = {},
): BGMCalibrationResult {
  const betaInit = options.betaInit ?? 0.08;
  const maxIterations = options.maxIterations ?? 4000;
  const displacement = options.displacement ?? 0;
  const cevBeta = options.cevBeta ?? 1.0;
  const hasExplicitInit =
    options.aInit !== undefined ||
    options.bInit !== undefined ||
    options.cInit !== undefined ||
    options.dInit !== undefined;
  const abcdStarts: ReadonlyArray<[number, number, number, number]> = hasExplicitInit
    ? [[options.aInit ?? 0.10, options.bInit ?? 0.20, options.cInit ?? 0.50, options.dInit ?? 0.80]]
    : DEFAULT_ABCD_STARTS;

  const swaps: SwapStructure[] = [];
  const expiries: number[] = [];
  const tenors: number[] = [];
  const parRates: number[] = [];
  const marketVols: number[] = [];
  for (const q of snapshot.swaptionATMQuotes) {
    const swap = buildSwap(curve, q.expiryYears, q.expiryYears + q.tenorYears);
    swaps.push(swap);
    expiries.push(q.expiryYears);
    tenors.push(q.tenorYears);
    parRates.push(swap.S0);
    marketVols.push(q.normalVol);
  }

  const meanS = parRates.reduce((s, v) => s + v, 0) / parRates.length;
  const meanVolN = marketVols.reduce((s, v) => s + v, 0) / marketVols.length;
  // Heuristic init: under shifted-CEV freeze σ_N ≈ (S+δ)^β · σ_LN_kernel,
  // so vol_scalar ≈ σ_N / (S+δ)^β. β=1 short-circuits Math.pow so δ=0, β=1
  // reproduces the original init bit-for-bit.
  const denom =
    cevBeta === 1.0 ? meanS + displacement : Math.pow(meanS + displacement, cevBeta);
  const volScalarInit = options.volScalarInit ?? meanVolN / denom;

  const xs = swaps.map((_, i) => i);
  const ys = marketVols.map((v) => v * 1e4); // bps for stable scaling

  const parameterizedFunction = (params: number[]) => {
    return (x: number) => {
      const idx = Math.round(x);
      const swap = swaps[idx];
      const p: RebonatoParams = {
        a: params[0],
        b: params[1],
        c: params[2],
        d: params[3],
        beta: params[4],
        volScalar: params[5],
        displacement,
        cevBeta,
      };
      const grid = rebonatoSwaptionNormalVolGrid([swap], p);
      return grid[0] * 1e4;
    };
  };

  let best: {
    fitted: RebonatoParams;
    modelVols: number[];
    residualsBp: number[];
    rmseBp: number;
    iterations: number;
  } | null = null;

  for (const [aInit, bInit, cInit, dInit] of abcdStarts) {
    const result = levenbergMarquardt({ x: xs, y: ys }, parameterizedFunction, {
      initialValues: [aInit, bInit, cInit, dInit, betaInit, volScalarInit],
      minValues: [0.0, 0.0, 1e-3, 0.0, -1.0, 0.01],
      maxValues: [5.0, 5.0, 5.0, 5.0, +1.0, 2.0],
      damping: 1e-2,
      gradientDifference: [1e-6, 1e-6, 1e-6, 1e-6, 1e-5, 1e-6],
      centralDifference: true,
      maxIterations,
      errorTolerance: 1e-8,
    });

    const fitted: RebonatoParams = {
      a: result.parameterValues[0],
      b: result.parameterValues[1],
      c: result.parameterValues[2],
      d: result.parameterValues[3],
      beta: result.parameterValues[4],
      volScalar: result.parameterValues[5],
      displacement,
      cevBeta,
    };
    const modelVols = rebonatoSwaptionNormalVolGrid(swaps, fitted);
    const residualsBp = modelVols.map((m, i) => (m - marketVols[i]) * 1e4);
    const rmseBp = Math.sqrt(residualsBp.reduce((s, r) => s + r * r, 0) / residualsBp.length);
    if (best === null || rmseBp < best.rmseBp) {
      best = { fitted, modelVols, residualsBp, rmseBp, iterations: result.iterations };
    }
  }

  return {
    ...best!.fitted,
    displacement,
    cevBeta,
    rmseBp: best!.rmseBp,
    residualsBp: best!.residualsBp,
    expiries,
    tenors,
    parRates,
    marketVols,
    modelVols: best!.modelVols,
    iterations: best!.iterations,
  };
}
