import { describe, expect, it } from "vitest";
import { sabrNormalVol } from "../sabr";

describe("sabrNormalVol", () => {
  it("ATM continuity: F == K limit equals near-ATM evaluation", () => {
    const F = 0.036;
    const T = 5.0;
    const alpha = 0.008;
    const rho = -0.2;
    const nu = 0.6;
    const atm = sabrNormalVol(F, F, T, alpha, rho, nu);
    const near = sabrNormalVol(F, F + 1e-9, T, alpha, rho, nu);
    expect(Math.abs(atm - near)).toBeLessThan(1e-6);
  });

  it("rho=0 produces a symmetric smile around ATM", () => {
    const F = 0.036;
    const T = 5.0;
    const alpha = 0.008;
    const nu = 0.4;
    const up = sabrNormalVol(F, F + 0.005, T, alpha, 0.0, nu);
    const dn = sabrNormalVol(F, F - 0.005, T, alpha, 0.0, nu);
    expect(Math.abs(up - dn)).toBeLessThan(1e-6);
  });

  it("matches Python reference at sample points (research/sabr.py self-test slice)", () => {
    // Values produced by `python sabr.py` at F=0.036, T=5, alpha=0.008,
    // rho=-0.30, nu=0.70 (the script's __main__ block).
    const F = 0.036;
    const T = 5.0;
    const alpha = 0.008;
    const rho = -0.3;
    const nu = 0.7;
    const expected: Array<[number, number]> = [
      [-0.0150, 0.012525], // -150 bp
      [-0.0100, 0.011335],
      [-0.0050, 0.010244],
      [-0.0025, 0.009781],
      [+0.0000, 0.009413],
      [+0.0025, 0.009174],
      [+0.0050, 0.009087],
      [+0.0100, 0.009352],
      [+0.0150, 0.010015],
    ];
    for (const [offset, expectedVol] of expected) {
      const K = F + offset;
      const v = sabrNormalVol(F, K, T, alpha, rho, nu);
      expect(v).toBeCloseTo(expectedVol, 5);
    }
  });
});
