/**
 * SABR (alpha, rho, nu) heuristic initialisation from a market snapshot.
 *
 * The prototype's `performCalibration` set SABR params via a strike-coverage
 * heuristic rather than a true least-squares fit. Phase 1 binding scope
 * (Steph audit memo Sec 11, item 6) was "port Hagan beta=0 closed form
 * as-is" — no SABR calibration loop. This mirrors the prototype heuristic
 * so the SABR tab has sensible defaults; users can override alpha, rho,
 * and nu live in the tab to sensitivity-test the smile shape.
 */

import type { MarketSnapshot } from "./marketData";

export interface SabrParams {
  alpha: number;
  beta: number; // fixed at 0 (Bachelier limit)
  rho: number;
  nu: number;
}

/** Default SABR params if no market data is available. */
export const SABR_DEFAULT: SabrParams = {
  alpha: 0.0084,
  beta: 0.0,
  rho: -0.30,
  nu: 0.70,
};

export function sabrHeuristic(snapshot: MarketSnapshot): SabrParams {
  // Average across all cap quotes (any strike) to set alpha.
  const allCaps = snapshot.capQuotes;
  let sum = 0;
  let count = 0;
  for (const q of allCaps) {
    sum += q.normalVol;
    count++;
  }
  const avgVol = count > 0 ? sum / count : SABR_DEFAULT.alpha / 1.05;

  // Strike coverage decides rho/nu shape (matches prototype logic).
  const hasLow = allCaps.some(
    (q) => q.strike !== null && (q.strike <= -0.01 || (q.strike > 0 && q.strike <= 0.02)),
  );
  const hasHigh = allCaps.some((q) => q.strike !== null && q.strike >= 0.04);

  let rho: number;
  let nu: number;
  if (hasLow && hasHigh) {
    rho = -0.35;
    nu = 0.95;
  } else if (hasLow) {
    rho = -0.55;
    nu = 0.70;
  } else if (hasHigh) {
    rho = 0.15;
    nu = 0.70;
  } else {
    rho = -0.15;
    nu = 0.60;
  }

  return {
    alpha: avgVol * 1.05,
    beta: 0.0,
    rho,
    nu,
  };
}
