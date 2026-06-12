/**
 * HW Monte Carlo Worker. Runs the HW1F simulator off the main thread.
 *
 * Protocol:
 *   { type: "simulate", curve: {t,z}, a, sigma, options? }
 *   -> { type: "simulated", result } | { type: "error", message }
 *
 * The result is the full HWSimulationResult. For browser transfer we pass
 * the typed-array fields as transferable objects to avoid copy cost.
 */

import { simulateHW, type HWSimulationOptions, type HWSimulationResult } from "../math/rates/simulateHw";
import type { ZeroCurve } from "../math/rates/bootstrap";

export interface HWSimulateRequest {
  type: "simulate";
  curve: { t: number[]; z: number[] };
  a: number;
  sigma: number;
  options?: HWSimulationOptions;
}

interface CurvePayload {
  t: number[];
  z: number[];
}

function rebuildCurve(payload: CurvePayload): ZeroCurve {
  const { t, z } = payload;
  const lerp = (x: number): number => {
    if (t.length === 0) return 0;
    if (x <= t[0]) return z[0];
    if (x >= t[t.length - 1]) return z[t.length - 1];
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

self.onmessage = (e: MessageEvent<HWSimulateRequest>) => {
  try {
    const { curve: cp, a, sigma, options } = e.data;
    const curve = rebuildCurve(cp);
    const result: HWSimulationResult = simulateHW(curve, a, sigma, options);
    self.postMessage({ type: "simulated", result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: "error", message });
  }
};
