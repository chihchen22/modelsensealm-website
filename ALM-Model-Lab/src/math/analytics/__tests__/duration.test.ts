import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadMarketSnapshot } from "../../rates/marketData";
import { bootstrapZeroCurve, shockCurve, type ZeroCurve } from "../../rates/bootstrap";
import { buildTLPCurve, type TLPCurve } from "../../rates/tlpCurve";
import { DeterministicRatePath } from "../../rates/ratePath";
import { NMDeposit, NMD_TERMS_DEFAULTS } from "../../instruments/nmd";
import { NMDBeta, NMD_B_TERMS_DEFAULTS, ibStaticRunoffDuration } from "../../instruments/nmdBeta";
import {
  ParallelShockPath,
  effectiveDurationOnPaths,
  walFromCashflows,
} from "../duration";
import type { Cashflow, RatePath } from "../../instruments/types";

const MARKET_PATH = resolve(__dirname, "..", "..", "..", "..", "public", "market_2026-03-31.json");
const ZERO_TLP: TLPCurve = buildTLPCurve([{ tYears: 1, spread: 0 }]);

async function loadCurve(): Promise<ZeroCurve> {
  return bootstrapZeroCurve(await loadMarketSnapshot(MARKET_PATH));
}

describe("shockCurve", () => {
  it("shifts every zero rate by exactly the bump; DFs scale by exp(-s t)", async () => {
    const curve = await loadCurve();
    const up = shockCurve(curve, 100);
    const down = shockCurve(curve, -100);
    for (const t of [0.25, 1, 5, 17.3, 30]) {
      expect(up.zeroRate(t) - curve.zeroRate(t)).toBeCloseTo(0.01, 12);
      expect(down.zeroRate(t) - curve.zeroRate(t)).toBeCloseTo(-0.01, 12);
      expect(up.discountFactor(t) / curve.discountFactor(t)).toBeCloseTo(Math.exp(-0.01 * t), 12);
    }
  });
});

describe("effective duration engine", () => {
  it("ParallelShockPath bumps spot and forwards uniformly from step 0", async () => {
    const curve = await loadCurve();
    const base = new DeterministicRatePath(curve, 120);
    const up = new ParallelShockPath(base, 100);
    expect(up.rateAt(0) - base.rateAt(0)).toBeCloseTo(0.01, 12);
    expect(up.rateAt(60) - base.rateAt(60)).toBeCloseTo(0.01, 12);
    expect(up.forwardRateAt(24, 5) - base.forwardRateAt(24, 5)).toBeCloseTo(0.01, 12);
  });

  it("zero-coupon bullet reproduces the analytic duration ~T", async () => {
    // A 5Y bullet with no rate-dependent cashflows: D_eff = sinh(sT)/s ≈ T to
    // second order (5.002 at s = 100 bp). Pins the engine arithmetic.
    const curve = await loadCurve();
    const bullet = (_path: RatePath): Cashflow[] => [
      { monthOffset: 60, balance: 100, principalPaid: 100, interestPaid: 0, couponRate: 0 },
    ];
    const paths = [new DeterministicRatePath(curve, 60)];
    const r = effectiveDurationOnPaths(bullet, paths, curve, ZERO_TLP, { discountBasis: "sofr" });
    expect(r.pvBase).toBeCloseTo(100 * curve.discountFactor(5), 10);
    expect(r.effectiveDuration).toBeCloseTo(5.0, 1);
    expect(r.pvDown).toBeGreaterThan(r.pvBase);
    expect(r.pvBase).toBeGreaterThan(r.pvUp);
  });

  it("par anchor solves a positive spread and leaves a bullet's duration unchanged", async () => {
    // PV0 of the 5Y bullet ≈ 81 > 80, so anchoring to 80 forces a positive
    // spread; e^{-sT} scales all three legs of a single bullet equally, so
    // the effective duration is invariant to the anchor.
    const curve = await loadCurve();
    const bullet = (_path: RatePath): Cashflow[] => [
      { monthOffset: 60, balance: 100, principalPaid: 100, interestPaid: 0, couponRate: 0 },
    ];
    const paths = [new DeterministicRatePath(curve, 60)];
    const r = effectiveDurationOnPaths(bullet, paths, curve, ZERO_TLP, {
      discountBasis: "sofr",
      parAnchor: 80,
    });
    expect(r.pvBase).toBeCloseTo(80, 6);
    expect(r.spreadBp).toBeGreaterThan(0);
    expect(r.effectiveDuration).toBeCloseTo(5.0, 1);
  });

  it("Non-IB NMD: effective duration is positive and below the runoff WAL", async () => {
    // The behavioral response (up-shock accelerates decay, down-shock slows
    // it) plus discounting both push effective duration below WAL — the
    // negative-convexity story the NMD tabs will chart.
    const curve = await loadCurve();
    const nmd = new NMDeposit(NMD_TERMS_DEFAULTS);
    const basePath = new DeterministicRatePath(curve, NMD_TERMS_DEFAULTS.maturityMonths);
    const r = effectiveDurationOnPaths(
      (p) => nmd.generateCashflows(p),
      [basePath],
      curve,
      ZERO_TLP,
    );
    const wal = walFromCashflows(nmd.generateCashflows(basePath), NMD_TERMS_DEFAULTS.notional);
    expect(wal).toBeGreaterThan(1);
    expect(r.effectiveDuration).toBeGreaterThan(0);
    expect(r.effectiveDuration).toBeLessThan(wal);
    expect(r.pvDown).toBeGreaterThan(r.pvUp);
  });

  it("IB NMD static-runoff duration is positive and below Non-IB duration", async () => {
    // Static-runoff method: principal frozen at base path, only the interest
    // leg reprices via β(r±Δ)·(r±Δ). Expected: D_IB ≈ (1−β)·D_principal,
    // positive, below Non-IB whose coupon is zero and runoff is rate-invariant.
    const curve = await loadCurve();
    const basePath = new DeterministicRatePath(curve, NMD_B_TERMS_DEFAULTS.maturityMonths);

    const nonIb = new NMDeposit(NMD_TERMS_DEFAULTS);
    const nonIbDur = effectiveDurationOnPaths(
      (p) => nonIb.generateCashflows(p),
      [new DeterministicRatePath(curve, NMD_TERMS_DEFAULTS.maturityMonths)],
      curve,
      ZERO_TLP,
    );

    const ibInstr = new NMDBeta(NMD_B_TERMS_DEFAULTS);
    const ibDur = ibStaticRunoffDuration(ibInstr, [basePath], curve, ZERO_TLP);

    expect(ibDur.effectiveDuration).toBeGreaterThan(0);
    expect(ibDur.effectiveDuration).toBeLessThan(nonIbDur.effectiveDuration);
  });
});
