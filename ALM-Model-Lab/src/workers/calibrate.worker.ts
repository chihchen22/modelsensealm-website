/**
 * Calibration Worker. Runs HW + BGM least-squares fits off the main thread.
 *
 * The main thread already loads the JSON, parses, and bootstraps. This worker
 * receives the parsed `MarketSnapshot` plus a curve payload {t, z}, runs both
 * calibrations, and returns the fits.
 *
 * Protocol:
 *   { type: "calibrate", snapshot, curvePayload, hwOptions?, bgmOptions? }
 *   -> { type: "calibrated", hw, bgm }
 *      | { type: "error", message }
 */

import type { MarketSnapshot } from "../math/rates/marketData";
import type { ZeroCurve } from "../math/rates/bootstrap";
import { calibrateHW, type HWCalibrationResult, type HWCalibrationOptions } from "../math/rates/hwCalibrate";
import { calibrateBGM, type BGMCalibrationResult, type BGMCalibrationOptions } from "../math/rates/bgmCalibrate";

export interface CalibrateRequest {
  type: "calibrate";
  snapshot: MarketSnapshot;
  curvePayload: { t: number[]; z: number[] };
  hwOptions?: HWCalibrationOptions;
  bgmOptions?: BGMCalibrationOptions;
}

export interface CalibrateResponse {
  type: "calibrated";
  hw: HWCalibrationResult;
  bgm: BGMCalibrationResult;
}

export interface ErrorResponse {
  type: "error";
  message: string;
}

function rebuildCurve(payload: { t: number[]; z: number[] }): ZeroCurve {
  const { t, z } = payload;
  const lerp = (x: number): number => {
    if (t.length === 0) return 0;
    if (x <= t[0]) return z[0];
    if (x >= t[t.length - 1]) return z[z.length - 1];
    for (let i = 0; i < t.length - 1; i++) {
      if (x >= t[i] && x <= t[i + 1]) {
        const w = (x - t[i]) / (t[i + 1] - t[i]);
        return z[i] * (1 - w) + z[i + 1] * w;
      }
    }
    return z[z.length - 1];
  };
  return {
    t,
    z,
    zeroRate(time) {
      return lerp(time);
    },
    discountFactor(time) {
      return Math.exp(-this.zeroRate(time) * time);
    },
    forwardRate(t1, t2) {
      return (this.discountFactor(t1) / this.discountFactor(t2) - 1) / (t2 - t1);
    },
    forwardSwapRate(t1, t2) {
      const tau = t2 - t1;
      if (tau <= 1.0 + 1e-9) return (this.discountFactor(t1) / this.discountFactor(t2) - 1) / tau;
      const n = Math.round(tau);
      let annuity = 0;
      for (let k = 1; k <= n; k++) annuity += (365 / 360) * this.discountFactor(t1 + k);
      return (this.discountFactor(t1) - this.discountFactor(t1 + n)) / annuity;
    },
  };
}

self.onmessage = (e: MessageEvent<CalibrateRequest>) => {
  try {
    const req = e.data;
    if (req.type !== "calibrate") {
      throw new Error(`unknown request type ${(req as { type: string }).type}`);
    }
    const curve = rebuildCurve(req.curvePayload);
    const hw = calibrateHW(req.snapshot, curve, req.hwOptions);
    const bgm = calibrateBGM(req.snapshot, curve, req.bgmOptions);
    const response: CalibrateResponse = { type: "calibrated", hw, bgm };
    self.postMessage(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const response: ErrorResponse = { type: "error", message };
    self.postMessage(response);
  }
};
