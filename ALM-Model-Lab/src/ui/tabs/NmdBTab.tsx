/**
 * NMD-B (interest-bearing, β-driven) — Phase 7 tab.
 *
 * Pairs a static-rate NMD-A cohort with a dynamic deposit-rate model: the
 * coupon D(t) tracks the market index (1M SOFR forward) through a logistic
 * S-curve on β. Three diagnostic views:
 *   1. Deposit-terms inputs and S-curve params card
 *   2. β vs market-rate diagnostic (the S-curve itself)
 *   3. Deposit-rate path D(t) vs market r(t) under the deterministic forward
 *   4. Outstanding balance + monthly cashflow chart and detail table
 *
 * The cashflows produced here feed the same Repricing Gap / Liquidity Gap /
 * FTP analytics as NMD-A; the difference is that the coupon column carries
 * the time-varying D(t) instead of a flat 0%.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useApp } from "../state/AppContext";
import { useInstruments } from "../state/InstrumentContext";
import { ChartErrorBoundary } from "../components/ChartErrorBoundary";
import { COLORS, SERIES } from "../tokens";
import {
  betaAtRate,
  ibStaticRunoffDuration,
  NMDBeta,
  runNMDBetaOnPaths,
  type BetaSCurveParams,
  type NMDBetaScenarioOutput,
  type NMDBetaTerms,
} from "../../math/instruments/nmdBeta";
import { DeterministicRatePath } from "../../math/rates/ratePath";
import { projectHWToTenor } from "../../math/rates/simulateHw";
import {
  DriverPath,
  type DurationResult,
} from "../../math/analytics/duration";
import {
  nmdSCurveData,
  nmdClosureRampData,
  type NMDParams,
} from "../../math/behavioral/nmdModel";

const NMD_B_TENOR_YEARS = 1 / 12;
const BGM_1M_TENOR_IDX = 1; // 1D=0,1M=1 (1D added back to BGM saved tenors)
const ROW_CARD_HEIGHT = 320;
const DIAGNOSTIC_CARD_HEIGHT = 420;
const FAN_CARD_HEIGHT = 540;

const tooltipNumberFormatter = (suffix: string, decimals: number) => (v: unknown, name: string) => {
  if (typeof v === "number" && Number.isFinite(v)) return [`${v.toFixed(decimals)}${suffix}`, name];
  if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number") {
    return [`${v[0].toFixed(decimals)} – ${v[1].toFixed(decimals)}${suffix}`, name];
  }
  return ["—", name];
};

const LEGEND_STYLE = {
  fontSize: 12,
  fontFamily: "var(--font-sans)",
  color: "var(--obsidian)",
};

function darkLegendFormatter(value: string) {
  return <span style={{ color: "var(--obsidian)", fontWeight: 500 }}>{value}</span>;
}

const formatDollar = (v: number) =>
  `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const formatDollar2 = (v: number) =>
  `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const formatDollarTick = (v: number): string => {
  const abs = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
};

export function NmdBTab() {
  const { curve, hwSim, bgmSim, tlpCurve } = useApp();
  const { nmdBeta, patchNmdBeta } = useInstruments();

  const [results, setResults] = useState<{
    base: NMDBetaScenarioOutput;
    hw: NMDBetaScenarioOutput;
    bgm: NMDBetaScenarioOutput;
    dur: { base: DurationResult; hw: DurationResult; bgm: DurationResult };
  } | null>(null);
  const [stale, setStale] = useState(true);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    setStale(true);
  }, [nmdBeta, hwSim, bgmSim]);

  const mcReady = Boolean(hwSim && bgmSim && curve);

  const runAnalytics = async () => {
    if (!hwSim || !bgmSim || !curve || !tlpCurve) return;
    setRunning(true);
    try {
      const nSteps = hwSim.times.length;
      const basePath = new Float64Array(nSteps);
      for (let t = 0; t < nSteps; t++) {
        const time = t / 12;
        basePath[t] = curve.forwardRate(time, time + NMD_B_TENOR_YEARS);
      }
      const hwPaths = projectHWToTenor(hwSim, curve, NMD_B_TENOR_YEARS);
      const bgmPaths: Float64Array[] = [];
      const nT = bgmSim.tenors.length;
      const bgmNSteps = bgmSim.times.length;
      for (let p = 0; p < bgmSim.nPaths; p++) {
        const path = new Float64Array(bgmNSteps);
        for (let t = 0; t < bgmNSteps; t++) {
          path[t] = bgmSim.rates[(p * bgmNSteps + t) * nT + BGM_1M_TENOR_IDX];
        }
        bgmPaths.push(path);
      }
      await new Promise((r) => setTimeout(r, 50));
      const base = runNMDBetaOnPaths([basePath], nmdBeta);
      const hw = runNMDBetaOnPaths(hwPaths, nmdBeta);
      const bgm = runNMDBetaOnPaths(bgmPaths, nmdBeta);
      // Static-runoff effective duration: principal frozen at the base path,
      // deposit-rate repriced via β(r±Δ)·(r±Δ) on the shifted curve.
      const instr = new NMDBeta(nmdBeta);
      const durOf = (arrs: ReadonlyArray<ArrayLike<number>>) =>
        ibStaticRunoffDuration(
          instr,
          arrs.map((a) => new DriverPath(a)),
          curve,
          tlpCurve,
        );
      const dur = { base: durOf([basePath]), hw: durOf(hwPaths), bgm: durOf(bgmPaths) };
      setResults({ base, hw, bgm, dur });
      setStale(false);
    } finally {
      setRunning(false);
    }
  };

  // Build chart data anchored at t=0 with balance=100 and decay=0.
  const fanData = useMemo(() => {
    if (!results) return [];
    const out: Array<{
      month: number;
      decayBase: number;
      decayHW: number;
      decayHWBand: [number, number];
      decayBGM: number;
      decayBGMBand: [number, number];
      balBase: number;
      balHW: number;
      balHWBand: [number, number];
      balBGM: number;
      balBGMBand: [number, number];
      depBase: number;
      depHW: number;
      depHWBand: [number, number];
      depBGM: number;
      depBGMBand: [number, number];
    }> = [];
    // t=0 anchor: balances are 100; decay is 0 (no decay has happened yet);
    // deposit rate uses the first-step β·r from each scenario's own results.
    out.push({
      month: 0,
      decayBase: 0,
      decayHW: 0,
      decayHWBand: [0, 0],
      decayBGM: 0,
      decayBGMBand: [0, 0],
      balBase: 100,
      balHW: 100,
      balHWBand: [100, 100],
      balBGM: 100,
      balBGMBand: [100, 100],
      depBase: results.base.depositRateMean[0] ?? 0,
      depHW: results.hw.depositRateMean[0] ?? 0,
      depHWBand: [results.hw.depositRateP5[0] ?? 0, results.hw.depositRateP95[0] ?? 0],
      depBGM: results.bgm.depositRateMean[0] ?? 0,
      depBGMBand: [results.bgm.depositRateP5[0] ?? 0, results.bgm.depositRateP95[0] ?? 0],
    });
    for (let i = 0; i < results.hw.decayMean.length; i++) {
      out.push({
        month: i + 1,
        decayBase: results.base.decayMean[i],
        decayHW: results.hw.decayMean[i],
        decayHWBand: [results.hw.decayP5[i], results.hw.decayP95[i]],
        decayBGM: results.bgm.decayMean[i],
        decayBGMBand: [results.bgm.decayP5[i], results.bgm.decayP95[i]],
        balBase: results.base.balMean[i],
        balHW: results.hw.balMean[i],
        balHWBand: [results.hw.balP5[i], results.hw.balP95[i]],
        balBGM: results.bgm.balMean[i],
        balBGMBand: [results.bgm.balP5[i], results.bgm.balP95[i]],
        depBase: results.base.depositRateMean[i],
        depHW: results.hw.depositRateMean[i],
        depHWBand: [results.hw.depositRateP5[i], results.hw.depositRateP95[i]],
        depBGM: results.bgm.depositRateMean[i],
        depBGMBand: [results.bgm.depositRateP5[i], results.bgm.depositRateP95[i]],
      });
    }
    return out;
  }, [results]);

  const walData = results
    ? [
        {
          scenario: "Base deterministic",
          wal: results.base.wal,
          effDur: results.dur.base.effectiveDuration,
          decay: results.base.lifeDecay,
        },
        {
          scenario: "Hull-White 1F",
          wal: results.hw.wal,
          effDur: results.dur.hw.effectiveDuration,
          decay: results.hw.lifeDecay,
        },
        {
          scenario: "BGM / LMM",
          wal: results.bgm.wal,
          effDur: results.dur.bgm.effectiveDuration,
          decay: results.bgm.lifeDecay,
        },
      ]
    : [];

  const pvData = results
    ? [
        { scenario: "Base deterministic", ...results.dur.base },
        { scenario: "Hull-White 1F", ...results.dur.hw },
        { scenario: "BGM / LMM", ...results.dur.bgm },
      ]
    : [];

  const setT = <K extends keyof NMDBetaTerms>(k: K, v: NMDBetaTerms[K]) => {
    patchNmdBeta({ [k]: v } as Partial<NMDBetaTerms>);
  };
  const setS = <K extends keyof BetaSCurveParams>(k: K, v: BetaSCurveParams[K]) => {
    patchNmdBeta({ sCurve: { ...nmdBeta.sCurve, [k]: v } });
  };
  const setNmdParam = <K extends keyof NMDParams>(k: K, v: NMDParams[K]) => {
    patchNmdBeta({ nmdParams: { ...nmdBeta.nmdParams, [k]: v } });
  };
  const setNotional = (v: number) => {
    patchNmdBeta({
      notional: v,
      nmdParams: { ...nmdBeta.nmdParams, balanceSize: v },
    });
  };

  // β S-curve diagnostic: β vs market rate from 0% to 10%.
  const sCurveDiag = useMemo(() => {
    const out: Array<{ rPct: number; beta: number }> = [];
    for (let r = 0; r <= 10; r += 0.1) {
      out.push({ rPct: Number(r.toFixed(2)), beta: betaAtRate(r, nmdBeta.sCurve) });
    }
    return out;
  }, [nmdBeta.sCurve]);

  // Closure-model diagnostics — same shape as Non-IB NMD, parameterised by
  // the IB NMD's own nmdParams instance. The decay-incentive S-curve uses
  // spread = r − D rather than r − MA on the IB tab (axis label adjusted).
  const decaySCurve = useMemo(() => nmdSCurveData(nmdBeta.nmdParams), [nmdBeta.nmdParams]);
  const closureRampData = useMemo(() => nmdClosureRampData(nmdBeta.nmdParams), [nmdBeta.nmdParams]);

  // Deterministic-forward projection: deposit rate path, market rate path,
  // initial β, and the monthly cashflow stream.
  const projection = useMemo(() => {
    if (!curve) return null;
    const path = new DeterministicRatePath(curve, nmdBeta.maturityMonths);
    const inst = new NMDBeta(nmdBeta);
    const betaInit = inst.initialBeta(path);
    const ratePath = inst.depositRatePath(path);
    const sim = inst.simulateTranches(path);
    const series = ratePath.rPct.map((r, i) => ({
      month: i + 1,
      marketPct: r,
      depositPct: ratePath.dPct[i],
      betaT: ratePath.betaPct[i],
    }));
    const cashflowData = sim.map((s) => ({
      month: s.monthOffset,
      balance: s.balIns + s.balUnins,
      principalPaid: s.principalPaid,
      interestPaid: s.interestPaid,
      depositRate: s.couponRate,
    }));
    const trancheData = sim.map((s) => {
      const total = s.balIns + s.balUnins;
      return {
        month: s.monthOffset,
        uninsured: total > 0 ? (s.balUnins / total) * 100 : 0,
        balIns: s.balIns,
        balUnins: s.balUnins,
      };
    });
    return { betaInit, series, cashflowData, trancheData };
  }, [curve, nmdBeta]);

  const summary = useMemo(() => {
    if (!projection) return null;
    let totalDecay = 0;
    let totalInterest = 0;
    let walNum = 0;
    let walDen = 0;
    for (const r of projection.cashflowData) {
      totalDecay += r.principalPaid;
      totalInterest += r.interestPaid;
      walNum += (r.month / 12) * r.principalPaid;
      walDen += r.principalPaid;
    }
    const last = projection.cashflowData[projection.cashflowData.length - 1];
    const residual = last ? Math.max(0, last.balance - last.principalPaid) : 0;
    const horizonYears = nmdBeta.maturityMonths / 12;
    return {
      nMonths: projection.cashflowData.length,
      totalDecay,
      totalInterest,
      walYears:
        walDen + residual > 1e-12
          ? (walNum + residual * horizonYears) / (walDen + residual)
          : 0,
      depositRateInitialPct: projection.series[0]?.depositPct ?? 0,
      depositRateFinalPct: projection.series[projection.series.length - 1]?.depositPct ?? 0,
    };
  }, [projection, nmdBeta.maturityMonths]);

  return (
    <div>
      <h1 className="section-title">Interest-Bearing NMD (β-driven)</h1>
      <p className="section-subtitle">
        Interest-bearing deposit cohort with dynamic repricing layered on top of the
        same closure decay model used by Non-IB NMD. Two model layers stack: a
        β-driven deposit-rate forecast that drives D(t) up and down with the SOFR
        market index, and the four-factor closure decay model that runs against the
        spread r − D (per the audit memo, replacing the r − MA spread used by Non-IB
        NMD).
      </p>

      <h2 className="section-title" style={{ fontSize: 22, marginTop: 24, fontStyle: "italic" }}>
        Dynamic β and deposit-rate forecast
      </h2>

      {/* Forecast model description ------------------------------ */}
      <div className="dash-card">
        <div className="group-label">Model &amp; math: deposit-rate forecast</div>
        <div style={{ fontSize: 13, lineHeight: 1.65, color: "rgba(18,19,18,0.85)" }}>
          <p style={{ marginBottom: 12 }}>
            The deposit rate D(t) tracks the 1M SOFR market index as a <strong>level
            ratio</strong> through a logistic S-curve on β. Two equations govern the
            forecast: first the β level at the current rate, then the per-step deposit
            rate update with optional Nerlove partial adjustment toward the target:
          </p>
          <div style={{ fontFamily: "Georgia, serif", fontStyle: "italic", marginBottom: 8, paddingLeft: 16 }}>
            β(r) = β<sub>min</sub> + (β<sub>max</sub> − β<sub>min</sub>) / (1 + exp(−k · (r − m)))
          </div>
          <div style={{ fontFamily: "Georgia, serif", fontStyle: "italic", marginBottom: 8, paddingLeft: 16 }}>
            D<sub>target</sub>(t) = β(r(t)) · r(t)
          </div>
          <div style={{ fontFamily: "Georgia, serif", fontStyle: "italic", marginBottom: 8, paddingLeft: 16 }}>
            D(t) = D(t−1) + λ · (D<sub>target</sub>(t) − D(t−1)), &nbsp; D(0) = D<sub>target</sub>(0)
          </div>
          <div style={{ paddingLeft: 16, fontSize: 12, color: "rgba(18,19,18,0.6)", marginTop: 4 }}>
            Inputs: r(t) = 1M SOFR (% pa) at month t; β<sub>min</sub>, β<sub>max</sub> = lower/upper β
            asymptotes; k = logistic steepness; m = inflection rate level (% pa); λ ∈ (0, 1] = Nerlove
            partial-adjustment factor (1.0 = full snap to target; ≈ 0.47 in Chen 2026).
          </div>
          <p style={{ marginTop: 12, marginBottom: 0 }}>
            With β ≈ 0.5 and SOFR ≈ 4%, D ≈ 2%, so the spread r − D ≈ 2% feeding the closure
            decay model's rate-driven incentive sits near its midpoint, the same regime as
            Non-IB NMD's r − MA spread of ≈ 0.
          </p>
          <p style={{ fontSize: 12, color: "rgba(18,19,18,0.55)", fontStyle: "italic", marginTop: 12 }}>
            Reference: Chen (2026), &quot;Dynamic Deposit Betas,&quot; SSRN Working Paper 6269838 (
            <a href="https://github.com/chihchen22/NMD_Beta" target="_blank" rel="noopener noreferrer" style={{ color: "var(--obsidian)" }}>
              chihchen22/NMD_Beta
            </a>
            ). In-sample MMDA estimates: β<sub>min</sub> = 0.433, β<sub>max</sub> = 0.800, k = 0.566,
            m = 3.919%, λ ≈ 0.47.
          </p>
        </div>
      </div>

      {/* Deposit terms ------------------------------------------- */}
      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="group-label">Deposit terms</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 24 }}>
          <NumberField
            label="Cohort balance ($)"
            value={nmdBeta.notional}
            step={100_000}
            onChange={setNotional}
          />
          <NumberField
            label="Projection horizon (mo)"
            value={nmdBeta.maturityMonths}
            step={12}
            onChange={(v) => setT("maturityMonths", Math.max(1, Math.round(v)))}
          />
        </div>
        <div className="form-helper" style={{ marginTop: 12, fontStyle: "italic" }}>
          Initial deposit rate D₀ is fully derived from β(r₀) · r₀, the level pass-through
          at t = 0. With λ = 1 (full snap) D(t) equals β(r) · r every period; with λ &lt; 1
          D smooths toward the target. Edit β<sub>min</sub>, β<sub>max</sub>, k, m, λ
          below to tune.
        </div>
      </div>

      {/* β S-curve params ---------------------------------------- */}
      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="group-label">β S-curve parameters (deposit-rate forecast)</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 24 }}>
          <NumberField
            label="β_min"
            value={nmdBeta.sCurve.betaMin}
            step={0.05}
            onChange={(v) => setS("betaMin", Math.max(0, Math.min(1, v)))}
          />
          <NumberField
            label="β_max"
            value={nmdBeta.sCurve.betaMax}
            step={0.05}
            onChange={(v) => setS("betaMax", Math.max(0, Math.min(1, v)))}
          />
          <NumberField
            label="k (steepness)"
            value={nmdBeta.sCurve.k}
            step={0.05}
            onChange={(v) => setS("k", Math.max(0.01, v))}
          />
          <NumberField
            label="m (inflection, %)"
            value={nmdBeta.sCurve.m}
            step={0.1}
            onChange={(v) => setS("m", v)}
          />
          <NumberField
            label="λ (Nerlove)"
            value={nmdBeta.sCurve.lambda}
            step={0.05}
            onChange={(v) => setS("lambda", Math.max(0.01, Math.min(1, v)))}
          />
        </div>
        <div className="form-helper" style={{ marginTop: 12, fontStyle: "italic" }}>
          Defaults are the in-sample MMDA estimates from{" "}
          <a
            href="https://github.com/chihchen22/NMD_Beta"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--obsidian)" }}
          >
            chihchen22/NMD_Beta
          </a>{" "}
          (Jan 2017 – Mar 2025): β<sub>min</sub> = 0.433, β<sub>max</sub> = 0.800, k = 0.566,
          m = 3.919%. λ defaults to 1.0 (full pass-through); the paper estimates the
          Nerlove partial-adjustment factor at ≈ 0.47; set λ in that range to smooth
          the deposit-rate trajectory.
        </div>
      </div>

      {/* β S-curve + deposit-rate path diagnostics --------------- */}
      <div className="row" style={{ marginTop: 16 }}>
        <div className="dash-card grow" style={{ height: 380 }}>
          <div className="group-label">β S-curve diagnostic</div>
          <ResponsiveContainer width="100%" height="86%">
            <LineChart data={sCurveDiag} margin={{ top: 16, right: 24, bottom: 36, left: 56 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
              <XAxis
                dataKey="rPct"
                type="number"
                domain={[0, 10]}
                ticks={[0, 2, 4, 6, 8, 10]}
                stroke={COLORS.obsidian}
                tick={{ fontSize: 12, fill: COLORS.obsidian }}
                tickFormatter={(v) => `${v}%`}
                label={{ value: "Market rate r (% pa)", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
              />
              <YAxis
                domain={[0, 1]}
                stroke={COLORS.obsidian}
                tick={{ fontSize: 12, fill: COLORS.obsidian }}
                tickFormatter={(v) => v.toFixed(2)}
                label={{ value: "β", angle: -90, position: "insideLeft", style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
              />
              <Tooltip
                formatter={(v: unknown, name: string) =>
                  typeof v === "number" && Number.isFinite(v) ? [v.toFixed(3), name] : ["—", name]
                }
                labelFormatter={(v) => (typeof v === "number" ? `r = ${v}%` : "")}
              />
              <ReferenceLine x={nmdBeta.sCurve.m} stroke="rgba(18,19,18,0.25)" strokeDasharray="3 3" label={{ value: "inflection m", position: "top", fontSize: 10 }} />
              <ReferenceLine y={nmdBeta.sCurve.betaMin} stroke="rgba(18,19,18,0.18)" strokeDasharray="2 4" />
              <ReferenceLine y={nmdBeta.sCurve.betaMax} stroke="rgba(18,19,18,0.18)" strokeDasharray="2 4" />
              <Line dataKey="beta" stroke={COLORS.obsidian} strokeWidth={2} dot={false} isAnimationActive={false} name="β(r)" />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="dash-card grow" style={{ height: 380 }}>
          <div className="group-label">Deposit rate path D(t) vs market r(t)</div>
          {projection ? (
            <ResponsiveContainer width="100%" height="86%">
              <LineChart data={projection.series} margin={{ top: 16, right: 24, bottom: 36, left: 56 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
                <XAxis
                  dataKey="month"
                  stroke={COLORS.obsidian}
                  tick={{ fontSize: 12, fill: COLORS.obsidian }}
                  label={{ value: "Months", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                />
                <YAxis
                  stroke={COLORS.obsidian}
                  tick={{ fontSize: 12, fill: COLORS.obsidian }}
                  tickFormatter={(v) => `${v.toFixed(2)}%`}
                  label={{ value: "Rate (% pa)", angle: -90, position: "insideLeft", dx: -12, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                />
                <Tooltip
                  formatter={(v: unknown, name: string) =>
                    typeof v === "number" && Number.isFinite(v) ? [`${v.toFixed(3)}%`, name] : ["—", name]
                  }
                  labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")}
                />
                <Line type="monotone" dataKey="marketPct" stroke={COLORS.obsidian} strokeWidth={2} dot={false} isAnimationActive={false} name="Market r(t)" />
                <Line type="monotone" dataKey="depositPct" stroke={COLORS.nodeTeal} strokeWidth={2} dot={false} isAnimationActive={false} name="Deposit D(t)" />
                <Legend verticalAlign="top" height={28} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p style={{ fontStyle: "italic", color: "var(--obsidian)", padding: 16 }}>
              Bootstrap a SOFR curve on the Curve tab to populate the deterministic-forward
              deposit rate path.
            </p>
          )}
        </div>
      </div>

      {/* Cashflow projection ------------------------------------- */}
      {projection && summary && (
        <>
          <div className="dash-card" style={{ marginTop: 16 }}>
            <div className="group-label">Cashflow summary (deterministic forward path)</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 24, fontSize: 13 }}>
              <KVP label="Months projected" value={`${summary.nMonths}`} />
              <KVP label="Initial β at r₀" value={projection.betaInit.toFixed(3)} />
              <KVP label="D(0) → D(T)" value={`${summary.depositRateInitialPct.toFixed(3)}% → ${summary.depositRateFinalPct.toFixed(3)}%`} />
              <KVP label="Total interest paid" value={formatDollar(summary.totalInterest)} />
              <KVP label="WAL (years)" value={`${summary.walYears.toFixed(2)}y`} />
            </div>
          </div>

          <div className="row" style={{ marginTop: 16 }}>
            <div className="dash-card grow" style={{ height: 400 }}>
              <div className="group-label">Outstanding deposit balance</div>
              <ResponsiveContainer width="100%" height="88%">
                <ComposedChart data={projection.cashflowData} margin={{ top: 16, right: 16, bottom: 36, left: 88 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
                  <XAxis dataKey="month" stroke={COLORS.obsidian} tick={{ fontSize: 12, fill: COLORS.obsidian }} label={{ value: "Months", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }} />
                  <YAxis
                    stroke={COLORS.obsidian}
                    tick={{ fontSize: 12, fill: COLORS.obsidian }}
                    tickFormatter={(v) => formatDollarTick(v)}
                    label={{ value: "Balance ($)", angle: -90, position: "insideLeft", dx: -20, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                  />
                  <Tooltip
                    formatter={(v: unknown, name: string) =>
                      typeof v === "number" && Number.isFinite(v) ? [formatDollar2(v), name] : ["—", name]
                    }
                    labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")}
                  />
                  <Line dataKey="balance" stroke={COLORS.obsidian} strokeWidth={2} dot={false} isAnimationActive={false} name="Balance" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="dash-card grow" style={{ height: 400 }}>
              <div className="group-label">Monthly cashflow (decay + interest paid)</div>
              <ResponsiveContainer width="100%" height="88%">
                <ComposedChart data={projection.cashflowData} margin={{ top: 32, right: 16, bottom: 36, left: 88 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
                  <XAxis dataKey="month" stroke={COLORS.obsidian} tick={{ fontSize: 12, fill: COLORS.obsidian }} label={{ value: "Months", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }} />
                  <YAxis
                    stroke={COLORS.obsidian}
                    tick={{ fontSize: 12, fill: COLORS.obsidian }}
                    tickFormatter={(v) => formatDollarTick(v)}
                    label={{ value: "Cashflow ($)", angle: -90, position: "insideLeft", dx: -20, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                  />
                  <Tooltip
                    formatter={(v: unknown, name: string) =>
                      typeof v === "number" && Number.isFinite(v) ? [formatDollar2(v), name] : ["—", name]
                    }
                    labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")}
                  />
                  <Bar dataKey="interestPaid" stackId="cf" fill={COLORS.nodeTeal} isAnimationActive={false} name="Interest paid" />
                  <Bar dataKey="principalPaid" stackId="cf" fill={COLORS.nodeOrange} isAnimationActive={false} name="Decay" />
                  <Legend verticalAlign="top" height={28} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="dash-card" style={{ marginTop: 16 }}>
            <div className="group-label">Monthly cashflow detail</div>
            <p className="form-helper" style={{ marginTop: -4, marginBottom: 8 }}>
              Deposit rate column is the time-varying D(t) realized by the β S-curve under
              the deterministic-forward 1M SOFR path. Interest paid each month is
              balance × D(t) / 12. Decay column is dollar outflow from closure +
              rate-incentive (using r − D as the depositor switching spread).
            </p>
            <div style={{ maxHeight: 280, overflowY: "auto", border: "1px solid rgba(18,19,18,0.08)" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead style={{ position: "sticky", top: 0, background: "var(--cloud-dancer)", boxShadow: "inset 0 -1px 0 rgba(18,19,18,0.15)" }}>
                  <tr>
                    <Th align="right">Month</Th>
                    <Th align="right">Opening balance</Th>
                    <Th align="right">Deposit rate D(t)</Th>
                    <Th align="right">Interest paid</Th>
                    <Th align="right">Decay</Th>
                  </tr>
                </thead>
                <tbody>
                  {projection.cashflowData.map((c) => (
                    <tr key={c.month} style={{ borderTop: "1px solid rgba(18,19,18,0.04)" }}>
                      <Td align="right">{c.month}</Td>
                      <Td align="right">{formatDollar2(c.balance)}</Td>
                      <Td align="right">{`${(c.depositRate * 100).toFixed(3)}%`}</Td>
                      <Td align="right">{formatDollar2(c.interestPaid)}</Td>
                      <Td align="right">{formatDollar2(c.principalPaid)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <h2 className="section-title" style={{ fontSize: 22, marginTop: 32, fontStyle: "italic" }}>
        Closure decay model: internals
      </h2>

      {/* Closure model description ------------------------------- */}
      <div className="dash-card">
        <div className="group-label">Model &amp; math: closure decay</div>
        <div style={{ fontSize: 13, lineHeight: 1.65, color: "rgba(18,19,18,0.85)" }}>
          <p style={{ marginBottom: 12 }}>
            Prepayment-form, two-tranche decay model. The cohort splits at the FDIC insured
            threshold D<sub>ref</sub>: the insured tranche min(D<sub>ref</sub>, balance) decays at
            the baseline closure rate only (the turnover analog of a mortgage model); the
            uninsured tranche additionally carries a one-sided rate incentive (the refi analog).
            The incentive's spread is r<sub>1M</sub> − D (the depositor's switching incentive
            against the current deposit rate) rather than Non-IB NMD's r<sub>1M</sub> − MA.
          </p>
          <p style={{ fontFamily: "Georgia, serif", fontStyle: "italic", marginBottom: 4, paddingLeft: 16 }}>
            decay<sub>ins</sub>(t) = closure(t)
          </p>
          <p style={{ fontFamily: "Georgia, serif", fontStyle: "italic", marginBottom: 12, paddingLeft: 16 }}>
            decay<sub>unins</sub>(t) = 1 − (1 − closure(t)) · (1 − base_incentive(t) · (r(t)/r<sub>ref</sub>) · B(t))
          </p>
          <ol style={{ paddingLeft: 24, marginBottom: 12 }}>
            <li style={{ marginBottom: 8 }}>
              <strong>Baseline closure (age-ramped)</strong>: relationship-driven account closures.
              Front-loaded; decays from <em>closure_initial</em> toward <em>closure_steady</em> with
              time-constant τ:
              <div style={{ fontFamily: "Georgia, serif", fontStyle: "italic", paddingLeft: 16, marginTop: 4 }}>
                closure(t) = closure_steady + (closure_initial − closure_steady) · exp(−t / τ)
              </div>
            </li>
            <li style={{ marginBottom: 8 }}>
              <strong>Rate-driven incentive (uninsured tranche only)</strong>: a one-sided logistic of
              spread, scaled by the cash-sorting salience r/r<sub>ref</sub>:
              <div style={{ fontFamily: "Georgia, serif", fontStyle: "italic", paddingLeft: 16, marginTop: 4 }}>
                spread(t) = r<sub>1M</sub>(t) − D(t) &nbsp; <span style={{ fontStyle: "normal", color: "rgba(18,19,18,0.55)" }}>(IB NMD substitution)</span>
              </div>
              <div style={{ fontFamily: "Georgia, serif", fontStyle: "italic", paddingLeft: 16, marginTop: 4 }}>
                base_incentive(t) = max_growth + (max_decay − max_growth) / (1 + exp(−K · (spread − midpoint)))
              </div>
              <div style={{ fontFamily: "Georgia, serif", fontStyle: "italic", paddingLeft: 16, marginTop: 4 }}>
                B(t) = exp(−λ<sub>b</sub> · C(t)),   C(t) = Σ<sub>s&lt;t</sub> max(0, base_incentive(s))
              </div>
              <div style={{ paddingLeft: 16, fontSize: 12, color: "rgba(18,19,18,0.6)", marginTop: 4 }}>
                With max_growth = 0 (the IB default) the logistic runs one-sided from 0 to max_decay,
                the same shape as a mortgage refi-incentive curve: hot money leaves fast when the
                market out-pays the deposit, and simply stays parked when it doesn't. The salience
                factor r/r<sub>ref</sub> (default r<sub>ref</sub> = 4%) is the cash-sorting effect — a
                given spread moves money much faster at 6% short rates than at 1%. Burnout
                B(t) is disabled by default (λ<sub>b</sub> = 0): commercial money does not exhaust
                its rate sensitivity.
              </div>
            </li>
          </ol>
          <div className="form-helper" style={{ paddingTop: 12, borderTop: "1px solid rgba(18,19,18,0.08)" }}>
            <strong>What is different here vs Non-IB NMD:</strong> the spread switches from r − MA
            to r − D; the cohort splits into insured/uninsured tranches at D<sub>ref</sub> with the
            rate incentive confined to the uninsured tranche (it self-extinguishes as the hot money
            leaves and only the insured core remains); the incentive runs one-sided (max_growth = 0,
            prepayment-style) with no burnout (λ<sub>b</sub> = 0) and a rate-level salience
            multiplier r/r<sub>ref</sub>. Defaults (max_decay 16, midpoint 2.0, K 1.5) put the
            deterministic-forward WAL near 3y on the 3/31 curve: the uninsured 75% drains in roughly
            two years, the insured core runs off at closure-only over a decade.
          </div>
          <div className="form-helper" style={{ marginTop: 8 }}>
            <strong>Cohort-decay convention:</strong> the rate-driven term is clamped at zero, so a
            single cohort's balance is monotonically non-increasing. When rates fall, depositors
            don't add money to this cohort — they keep it parked and the decay collapses toward the
            closure-only floor. Sustained inflows in low-rate environments belong to <em>new</em>
            cohorts and aren't modelled in this instrument.
          </div>
        </div>
      </div>

      {/* Parameter cards (4-up) ---------------------------------- */}
      <div className="row" style={{ marginTop: 16 }}>
        <div className="dash-card grow" style={{ height: ROW_CARD_HEIGHT, display: "flex", flexDirection: "column" }}>
          <div className="group-label">Decay levels</div>
          <NumberRow label="Closure steady (%/mo)" step={0.05} value={nmdBeta.nmdParams.closureSteady} onChange={(v) => setNmdParam("closureSteady", v)} />
          <NumberRow label="Max rate decay (%)" step={0.1} value={nmdBeta.nmdParams.maxRateDecay} onChange={(v) => setNmdParam("maxRateDecay", v)} />
          <NumberRow label="Max rate growth (%)" step={0.1} value={nmdBeta.nmdParams.maxRateGrowth} onChange={(v) => setNmdParam("maxRateGrowth", v)} />
          <div className="form-helper" style={{ marginTop: 12, fontStyle: "italic" }}>
            Closure-steady is the long-run baseline rate (after the age ramp settles). Max decay caps
            the high-spread end of the logistic. Max growth defaults to 0 here — the curve runs
            one-sided, prepayment-style; negative values re-enable the inflow-damping lower tail.
          </div>
        </div>
        <div className="dash-card grow" style={{ height: ROW_CARD_HEIGHT, display: "flex", flexDirection: "column" }}>
          <div className="group-label">Logistic shape</div>
          <NumberRow label="K (steepness)" step={0.1} value={nmdBeta.nmdParams.logisticK} onChange={(v) => setNmdParam("logisticK", v)} />
          <NumberRow label="Midpoint (spread %)" step={0.05} value={nmdBeta.nmdParams.logisticMidpoint} onChange={(v) => setNmdParam("logisticMidpoint", v)} />
          <NumberRow label="MA period (months)" value={nmdBeta.nmdParams.maPeriod} onChange={(v) => setNmdParam("maPeriod", v)} />
          <div className="form-helper" style={{ marginTop: 12, fontStyle: "italic" }}>
            K controls how sharply incentive transitions; midpoint shifts the inflection in spread
            units. The MA period field is retained for parity with Non-IB NMD but isn't used
            here: IB NMD's spread is r − D, computed each step without an MA window.
          </div>
        </div>
        <div className="dash-card grow" style={{ height: ROW_CARD_HEIGHT, display: "flex", flexDirection: "column" }}>
          <div className="group-label">Tranche scaling</div>
          <NumberRow label="Initial balance ($)" value={nmdBeta.nmdParams.balanceSize} onChange={(v) => setNmdParam("balanceSize", v)} />
          <NumberRow label="Insured threshold D ($)" value={nmdBeta.nmdParams.balanceDenominator} onChange={(v) => setNmdParam("balanceDenominator", v)} />
          <NumberRow label="Salience ref r (%)" step={0.5} value={nmdBeta.salienceRefPct ?? 4} onChange={(v) => setT("salienceRefPct", Math.max(0.1, v))} />
          <div className="form-helper" style={{ marginTop: 12, fontStyle: "italic" }}>
            The cohort splits at D<sub>ref</sub> (default $250k FDIC): rate incentive fires only on
            the uninsured tranche, scaled by the cash-sorting salience r/r<sub>ref</sub>. Bigger
            balances carry a larger uninsured share — more funds left on the table.
          </div>
        </div>
        <div className="dash-card grow" style={{ height: ROW_CARD_HEIGHT, display: "flex", flexDirection: "column" }}>
          <div className="group-label">Path dependency</div>
          <NumberRow label="Closure initial (%/mo)" step={0.1} value={nmdBeta.nmdParams.closureInitial} onChange={(v) => setNmdParam("closureInitial", v)} />
          <NumberRow label="Closure τ (months)" step={1} value={nmdBeta.nmdParams.closureTauMonths} onChange={(v) => setNmdParam("closureTauMonths", Math.max(0.01, v))} />
          <NumberRow label="Burnout λ" step={0.05} value={nmdBeta.nmdParams.burnoutLambda} onChange={(v) => setNmdParam("burnoutLambda", Math.max(0, v))} />
          <div className="form-helper" style={{ marginTop: 12, fontStyle: "italic" }}>
            Closure age-ramp: closure(t) decays from initial → steady with time-constant τ. Burnout
            B(t) = exp(−λ · cum positive incentive) defaults to OFF (λ = 0) for IB NMD: commercial
            money stays rate-responsive; it does not exhaust like mortgage refi burnout.
          </div>
        </div>
      </div>

      {/* Diagnostic charts: row 1 = decay S-curve + balance scaling */}
      <div className="row" style={{ marginTop: 24 }}>
        <div className="dash-card grow" style={{ height: DIAGNOSTIC_CARD_HEIGHT }}>
          <div className="group-label">Decay incentive vs spread</div>
          <ResponsiveContainer width="100%" height="88%">
            <ComposedChart data={decaySCurve} margin={{ top: 16, right: 16, bottom: 36, left: 48 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
              <XAxis
                dataKey="spread"
                type="number"
                domain={[-4, 4]}
                tickFormatter={(v) => `${v.toFixed(1)}`}
                stroke={COLORS.obsidian}
                tick={{ fontSize: 12, fill: COLORS.obsidian }}
                label={{ value: "Spread r₁ₘ − D (%)", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
              />
              <YAxis
                stroke={COLORS.obsidian}
                tick={{ fontSize: 12, fill: COLORS.obsidian }}
                tickFormatter={(v) => `${v.toFixed(1)}%`}
                label={{ value: "Rate-driven decay (%/mo)", angle: -90, position: "insideLeft", style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
              />
              <Tooltip
                formatter={tooltipNumberFormatter("%", 3)}
                labelFormatter={(v) => (typeof v === "number" ? `spread = ${v.toFixed(2)}%` : "")}
              />
              <Line dataKey="incentive" stroke={COLORS.obsidian} strokeWidth={2} dot={false} isAnimationActive={false} name="Incentive" />
              <ReferenceLine y={0} stroke="rgba(18,19,18,0.18)" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <div className="dash-card grow" style={{ height: DIAGNOSTIC_CARD_HEIGHT }}>
          <div className="group-label">Uninsured tranche share (deterministic path)</div>
          {projection ? (
            <ResponsiveContainer width="100%" height="88%">
              <ComposedChart data={projection.trancheData} margin={{ top: 32, right: 16, bottom: 36, left: 48 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
                <XAxis
                  dataKey="month"
                  type="number"
                  stroke={COLORS.obsidian}
                  tick={{ fontSize: 12, fill: COLORS.obsidian }}
                  label={{ value: "Months from cohort origination", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                />
                <YAxis
                  domain={[0, 100]}
                  stroke={COLORS.obsidian}
                  tick={{ fontSize: 12, fill: COLORS.obsidian }}
                  tickFormatter={(v) => `${(v as number).toFixed(0)}%`}
                  label={{ value: "Uninsured share (%)", angle: -90, position: "insideLeft", style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                />
                <Tooltip
                  formatter={tooltipNumberFormatter("%", 1)}
                  labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")}
                />
                <ReferenceLine y={0} stroke="rgba(18,19,18,0.18)" />
                <Line dataKey="uninsured" stroke={SERIES.hw} strokeWidth={2} dot={false} isAnimationActive={false} name="Uninsured share of remaining balance" />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <p style={{ fontStyle: "italic", color: "var(--obsidian)", padding: 16 }}>
              Bootstrap a SOFR curve on the Curve tab to populate the uninsured-tranche trajectory.
            </p>
          )}
        </div>
      </div>

      {/* Diagnostic charts: row 2 = closure age ramp ------------- */}
      <div className="row" style={{ marginTop: 16 }}>
        <div className="dash-card grow" style={{ height: DIAGNOSTIC_CARD_HEIGHT }}>
          <div className="group-label">Closure age ramp</div>
          <ResponsiveContainer width="100%" height="88%">
            <ComposedChart data={closureRampData} margin={{ top: 32, right: 16, bottom: 36, left: 48 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
              <XAxis
                dataKey="month"
                type="number"
                domain={[0, 120]}
                ticks={[0, 12, 24, 36, 48, 60, 72, 84, 96, 108, 120]}
                tickFormatter={(v) => `${v}m`}
                stroke={COLORS.obsidian}
                tick={{ fontSize: 12, fill: COLORS.obsidian }}
                label={{ value: "Months from cohort origination", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
              />
              <YAxis
                stroke={COLORS.obsidian}
                tick={{ fontSize: 12, fill: COLORS.obsidian }}
                tickFormatter={(v) => `${v.toFixed(2)}%`}
                label={{ value: "Closure rate (%/mo)", angle: -90, position: "insideLeft", style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
              />
              <Tooltip
                formatter={tooltipNumberFormatter("%", 3)}
                labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")}
              />
              <Line dataKey="steady" stroke="rgba(18,19,18,0.35)" strokeDasharray="4 4" strokeWidth={1.5} dot={false} isAnimationActive={false} name="Steady-state" />
              <Line dataKey="closure" stroke={COLORS.obsidian} strokeWidth={2} dot={false} isAnimationActive={false} name="closure(t)" />
              <Legend verticalAlign="top" height={28} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Path-driven MC analytics -------------------------------- */}
      <h2 className="section-title" style={{ fontSize: 22, marginTop: 32, fontStyle: "italic" }}>
        IB NMD analytics: Monte Carlo
      </h2>
      <p className="section-subtitle">
        Each path realisation drives both the deposit-rate evolution D(t) (through the β
        S-curve on the simulated 1M SOFR) and the closure overlay (decay against
        spread = r − D). Same shape as the Non-IB NMD analytics: balance fan, decay-rate
        fan, and WAL / life-decay by scenario.
      </p>

      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="form-row">
          <button
            type="button"
            className="btn btn-filled"
            onClick={() => void runAnalytics()}
            disabled={running || !mcReady}
          >
            {running ? "Computing…" : "Run IB NMD analytics →"}
          </button>
          {!mcReady && (
            <span className="form-helper" style={{ marginLeft: 12, fontStyle: "italic" }}>
              Run both HW and BGM simulations on the simulator tabs to enable Monte Carlo
              analytics.
            </span>
          )}
          {mcReady && stale && results && (
            <span className="form-helper" style={{ color: "#C86A3A" }}>
              Controls or simulations changed since last run. Re-run for fresh results.
            </span>
          )}
        </div>
      </div>

      {results && (
        <ChartErrorBoundary label="IB NMD analytics charts">
          <div className="dash-card" style={{ height: FAN_CARD_HEIGHT, marginTop: 16 }}>
            <div className="group-label">Outstanding balance fan (start = 100)</div>
            <ResponsiveContainer width="100%" height="92%">
              <ComposedChart data={fanData} margin={{ top: 32, right: 24, bottom: 36, left: 56 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
                <XAxis
                  dataKey="month"
                  type="number"
                  domain={[0, 360]}
                  ticks={[0, 60, 120, 180, 240, 300, 360]}
                  tickFormatter={(v) => `${(v / 12).toFixed(0)}y`}
                  stroke={COLORS.obsidian}
                  tick={{ fontSize: 12, fill: COLORS.obsidian }}
                  label={{ value: "Months from sim start", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                />
                <YAxis
                  domain={[0, 120]}
                  ticks={[0, 20, 40, 60, 80, 100, 120]}
                  allowDataOverflow={true}
                  stroke={COLORS.obsidian}
                  tick={{ fontSize: 12, fill: COLORS.obsidian }}
                  label={{ value: "Outstanding balance (start = 100)", angle: -90, position: "insideLeft", style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                />
                <Tooltip
                  formatter={(v: unknown, name: string) => {
                    if (typeof v === "number" && Number.isFinite(v)) return [v.toFixed(2), name];
                    if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number") {
                      return [`${v[0].toFixed(2)} – ${v[1].toFixed(2)}`, name];
                    }
                    return ["—", name];
                  }}
                  labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")}
                />
                <Area dataKey="balHWBand" fill={SERIES.hwBandFill} stroke={SERIES.hw} strokeOpacity={0.45} strokeWidth={1} isAnimationActive={false} name="HW p5–p95" />
                <Area dataKey="balBGMBand" fill={SERIES.bgmBandFill} stroke={SERIES.bgm} strokeOpacity={0.45} strokeWidth={1} isAnimationActive={false} name="BGM p5–p95" />
                <Line dataKey="balBase" stroke={SERIES.deterministic} strokeWidth={1.5} dot={false} isAnimationActive={false} name="Base (deterministic)" />
                <Line dataKey="balHW" stroke={SERIES.hw} strokeWidth={2} dot={false} isAnimationActive={false} name="HW mean" />
                <Line dataKey="balBGM" stroke={SERIES.bgm} strokeWidth={2} dot={false} isAnimationActive={false} name="BGM mean" />
                <Legend verticalAlign="top" height={28} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="dash-card" style={{ height: FAN_CARD_HEIGHT, marginTop: 16 }}>
            <div className="group-label">Decay rate fan (% per month)</div>
            <ResponsiveContainer width="100%" height="92%">
              <ComposedChart data={fanData} margin={{ top: 32, right: 24, bottom: 36, left: 56 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
                <XAxis
                  dataKey="month"
                  type="number"
                  domain={[0, 360]}
                  ticks={[0, 60, 120, 180, 240, 300, 360]}
                  tickFormatter={(v) => `${(v / 12).toFixed(0)}y`}
                  stroke={COLORS.obsidian}
                  tick={{ fontSize: 12, fill: COLORS.obsidian }}
                  label={{ value: "Months from sim start", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                />
                <YAxis
                  stroke={COLORS.obsidian}
                  tick={{ fontSize: 12, fill: COLORS.obsidian }}
                  tickFormatter={(v) => `${v.toFixed(2)}%`}
                  label={{ value: "Decay rate (%/mo)", angle: -90, position: "insideLeft", style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                />
                <Tooltip
                  formatter={(v: unknown, name: string) => {
                    if (typeof v === "number" && Number.isFinite(v)) return [`${v.toFixed(3)}%`, name];
                    if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number") {
                      return [`${v[0].toFixed(3)}% – ${v[1].toFixed(3)}%`, name];
                    }
                    return ["—", name];
                  }}
                  labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")}
                />
                <Area dataKey="decayHWBand" fill={SERIES.hwBandFill} stroke={SERIES.hw} strokeOpacity={0.45} strokeWidth={1} isAnimationActive={false} name="HW p5–p95" />
                <Area dataKey="decayBGMBand" fill={SERIES.bgmBandFill} stroke={SERIES.bgm} strokeOpacity={0.45} strokeWidth={1} isAnimationActive={false} name="BGM p5–p95" />
                <Line dataKey="decayBase" stroke={SERIES.deterministic} strokeWidth={1.5} dot={false} isAnimationActive={false} name="Base (deterministic)" />
                <Line dataKey="decayHW" stroke={SERIES.hw} strokeWidth={2} dot={false} isAnimationActive={false} name="HW mean" />
                <Line dataKey="decayBGM" stroke={SERIES.bgm} strokeWidth={2} dot={false} isAnimationActive={false} name="BGM mean" />
                <Legend verticalAlign="top" height={28} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="dash-card" style={{ height: FAN_CARD_HEIGHT, marginTop: 16 }}>
            <div className="group-label">Deposit rate fan D(t) (% per annum)</div>
            <ResponsiveContainer width="100%" height="92%">
              <ComposedChart data={fanData} margin={{ top: 32, right: 24, bottom: 36, left: 56 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
                <XAxis
                  dataKey="month"
                  type="number"
                  domain={[0, 360]}
                  ticks={[0, 60, 120, 180, 240, 300, 360]}
                  tickFormatter={(v) => `${(v / 12).toFixed(0)}y`}
                  stroke={COLORS.obsidian}
                  tick={{ fontSize: 12, fill: COLORS.obsidian }}
                  label={{ value: "Months from sim start", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                />
                <YAxis
                  stroke={COLORS.obsidian}
                  tick={{ fontSize: 12, fill: COLORS.obsidian }}
                  tickFormatter={(v) => `${v.toFixed(2)}%`}
                  label={{ value: "D(t) (% pa)", angle: -90, position: "insideLeft", style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                />
                <Tooltip
                  formatter={(v: unknown, name: string) => {
                    if (typeof v === "number" && Number.isFinite(v)) return [`${v.toFixed(3)}%`, name];
                    if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number") {
                      return [`${v[0].toFixed(3)}% – ${v[1].toFixed(3)}%`, name];
                    }
                    return ["—", name];
                  }}
                  labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")}
                />
                <Area dataKey="depHWBand" fill={SERIES.hwBandFill} stroke={SERIES.hw} strokeOpacity={0.45} strokeWidth={1} isAnimationActive={false} name="HW p5–p95" />
                <Area dataKey="depBGMBand" fill={SERIES.bgmBandFill} stroke={SERIES.bgm} strokeOpacity={0.45} strokeWidth={1} isAnimationActive={false} name="BGM p5–p95" />
                <Line dataKey="depBase" stroke={SERIES.deterministic} strokeWidth={1.5} dot={false} isAnimationActive={false} name="Base (deterministic)" />
                <Line dataKey="depHW" stroke={SERIES.hw} strokeWidth={2} dot={false} isAnimationActive={false} name="HW mean" />
                <Line dataKey="depBGM" stroke={SERIES.bgm} strokeWidth={2} dot={false} isAnimationActive={false} name="BGM mean" />
                <Legend verticalAlign="top" height={28} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="dash-card" style={{ marginTop: 16 }}>
            <div className="group-label">WAL and effective duration by scenario</div>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={walData} margin={{ top: 32, right: 32, bottom: 36, left: 32 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
                <XAxis dataKey="scenario" stroke={COLORS.obsidian} tick={{ fontSize: 12, fill: COLORS.obsidian }} />
                <YAxis
                  stroke={COLORS.obsidian}
                  tick={{ fontSize: 12, fill: COLORS.obsidian }}
                  tickFormatter={(v) => `${v.toFixed(1)}y`}
                  label={{ value: "Years", angle: -90, position: "insideLeft", style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                />
                <Tooltip
                  formatter={(v: unknown, name: string) => {
                    if (typeof v !== "number" || !Number.isFinite(v)) return ["—", name];
                    return [`${v.toFixed(2)} years`, name];
                  }}
                />
                <Bar dataKey="wal" name="WAL (years)" fill={COLORS.obsidian} />
                <Bar dataKey="effDur" name="Effective duration (years)" fill={SERIES.hw} />
                <Legend verticalAlign="top" height={28} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
              </BarChart>
            </ResponsiveContainer>
            <div className="form-helper">
              Static-runoff effective duration: principal frozen at the base path, deposit rate
              repriced via β(r±Δ)·(r±Δ) on the shifted FHLB curve — so D_IB ≈ (1−β)·D_principal,
              positive, below Non-IB. Life decay (%/mo):{" "}
              {walData.map((d) => `${d.scenario.split(" ")[0]} ${d.decay.toFixed(3)}`).join(" · ")}.
            </div>
          </div>

          <div className="dash-card" style={{ marginTop: 16 }}>
            <div className="group-label">PV under ±100bp · FHLB advance curve (SOFR + TLP)</div>
            <table className="preview" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>PV −100bp</th>
                  <th>PV base</th>
                  <th>PV +100bp</th>
                </tr>
              </thead>
              <tbody>
                {pvData.map((d) => (
                  <tr key={d.scenario}>
                    <td>{d.scenario}</td>
                    <td>{formatDollar(d.pvDown)}</td>
                    <td>{formatDollar(d.pvBase)}</td>
                    <td>{formatDollar(d.pvUp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="form-helper" style={{ marginTop: 8 }}>
              PV of principal runoff plus β-driven interest on the funding curve. Raising β_max
              pushes PV toward notional and compresses duration: a fully repriced deposit is
              economically short-dated regardless of how slowly balances run off.
            </div>
          </div>
        </ChartErrorBoundary>
      )}
    </div>
  );
}

function NumberField({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="form-label" style={{ marginBottom: 6 }}>{label}</div>
      <input
        type="number"
        className="form-input"
        step={step ?? 1}
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
        style={{ width: "100%" }}
      />
    </div>
  );
}

/** Compact label-and-input row used inside the 4-up parameter cards. Mirrors
 *  the equivalent helper on NmdTab so the two tabs share the same look. */
function NumberRow({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="form-row">
      <span className="form-label">{label}</span>
      <input
        type="number"
        className="form-input"
        step={step ?? 1}
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
        style={{ width: 120 }}
      />
    </div>
  );
}

function KVP({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="form-label" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 500, color: "var(--obsidian)" }}>{value}</div>
    </div>
  );
}

function Th({ children, align = "left" }: { children: ReactNode; align?: "left" | "right" }) {
  return (
    <th style={{ padding: "6px 12px", textAlign: align, fontWeight: 500, color: "var(--obsidian)" }}>
      {children}
    </th>
  );
}

function Td({ children, align = "left" }: { children: ReactNode; align?: "left" | "right" }) {
  return (
    <td style={{ padding: "4px 12px", textAlign: align, color: "var(--obsidian)" }}>
      {children}
    </td>
  );
}
