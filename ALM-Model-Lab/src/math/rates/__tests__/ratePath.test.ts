import { describe, expect, it } from "vitest";
import { simulateHW, projectHWToTenor } from "../simulateHw";
import { StochasticRatePath } from "../ratePath";
import type { ZeroCurve } from "../bootstrap";

/**
 * Synthetic flat-ish curve. The HW forward cross-check only requires that
 * simulateHW, projectHWToTenor, and hwForwardRate all read the SAME
 * discountFactor, so a stub with a smooth DF is sufficient and fast.
 */
const FLAT_RATE = 0.04;
const curve = {
  discountFactor: (t: number) => Math.exp(-FLAT_RATE * t),
  forwardSwapRate: () => FLAT_RATE,
  zeroRate: () => FLAT_RATE,
  forwardRate: () => FLAT_RATE,
} as unknown as ZeroCurve;

describe("StochasticRatePath HW-aware forwardRateAt", () => {
  const a = 0.03;
  const sigma = 0.009;
  const dt = 1 / 12;
  const sim = simulateHW(curve, a, sigma, {
    horizonYears: 3,
    dtYears: dt,
    nPairs: 8,
    seed: 20250930n,
  });
  const nSteps = sim.times.length;

  // Cover both branches of hwForwardRate: sub-1Y (simple-comp) and >=1Y (par swap).
  for (const tenor of [1 / 12, 0.5, 1, 5, 10]) {
    it(`reproduces projectHWToTenor for tenor=${tenor}y: forwardRateAt(k+1) === swap[k]`, () => {
      const swap = projectHWToTenor(sim, curve, tenor);
      for (let p = 0; p < sim.nPaths; p++) {
        const rp = new StochasticRatePath(Array.from(sim.rPaths[p]), dt, {
          xPath: Array.from(sim.XPaths[p]),
          a,
          sigma,
          curve,
        });
        for (let k = 0; k < nSteps; k++) {
          // step s = k+1 uses t = s*dt and X = xPath[s-1] = XPaths[p][k],
          // which is exactly the (t, X) projectHWToTenor uses at sim index k.
          expect(rp.forwardRateAt(k + 1, tenor)).toBeCloseTo(swap[p][k], 10);
        }
      }
    });
  }

  it("step <= 0 returns the deterministic t=0 forward (month-1 coupon locked)", () => {
    const rp = new StochasticRatePath(Array.from(sim.rPaths[0]), dt, {
      xPath: Array.from(sim.XPaths[0]),
      a,
      sigma,
      curve,
    });
    expect(rp.forwardRateAt(0, 10)).toBe(FLAT_RATE);
    expect(rp.forwardRateAt(-3, 10)).toBe(FLAT_RATE);
  });

  it("without HW state falls back to averaging the spot 1M window", () => {
    const path = [0.03, 0.04, 0.05, 0.06];
    const rp = new StochasticRatePath(path); // no hw -> averaging fallback
    // 3-month tenor at step 1 averages path[1..3].
    expect(rp.forwardRateAt(1, 3 / 12)).toBeCloseTo((0.04 + 0.05 + 0.06) / 3, 12);
  });
});
