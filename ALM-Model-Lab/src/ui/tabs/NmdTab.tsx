import { useEffect, useMemo, useState } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useApp } from "../state/AppContext";
import { useInstruments } from "../state/InstrumentContext";
import { COLORS, SERIES } from "../tokens";
import { projectHWToTenor } from "../../math/rates/simulateHw";
import { ChartErrorBoundary } from "../components/ChartErrorBoundary";
import {
  buildWarmupSOFR1M,
  type NMDParams,
  type NMDScenarioOutput,
  nmdSCurveData,
  nmdBalanceScalingData,
  nmdClosureRampData,
  runNMDOnPaths,
} from "../../math/behavioral/nmdModel";
import { NMDeposit, type NMDTerms } from "../../math/instruments/nmd";
import { DeterministicRatePath } from "../../math/rates/ratePath";
import {
  DriverPath,
  effectiveDurationOnPaths,
  type DurationResult,
} from "../../math/analytics/duration";

const NMD_TENOR_YEARS = 1 / 12;
const BGM_1M_TENOR_IDX = 0; // 1M is at index 0 after 1D removal

const ROW_CARD_HEIGHT = 320;
const DIAGNOSTIC_CARD_HEIGHT = 420;
const FAN_CARD_HEIGHT = 540;

const LEGEND_STYLE = {
  fontSize: 12,
  fontFamily: "var(--font-sans)",
  color: "var(--obsidian)",
};

function darkLegendFormatter(value: string) {
  return <span style={{ color: "var(--obsidian)", fontWeight: 500 }}>{value}</span>;
}

const tooltipNumberFormatter = (suffix: string, decimals: number) => (v: unknown, name: string) => {
  if (typeof v === "number" && Number.isFinite(v)) return [`${v.toFixed(decimals)}${suffix}`, name];
  if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number") {
    return [`${v[0].toFixed(decimals)} – ${v[1].toFixed(decimals)}${suffix}`, name];
  }
  return ["—", name];
};

function percentile(arr: ArrayLike<number>, q: number): number {
  const sorted = Array.from(arr).sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
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

export function NmdTab() {
  const { hwSim, bgmSim, curve, tlpCurve } = useApp();
  const { nmd, patchNmd } = useInstruments();
  const params = nmd.nmdParams;
  const [results, setResults] = useState<{
    base: NMDScenarioOutput;
    hw: NMDScenarioOutput;
    bgm: NMDScenarioOutput;
    dur: { base: DurationResult; hw: DurationResult; bgm: DurationResult };
  } | null>(null);
  const [stale, setStale] = useState(true);
  const [running, setRunning] = useState(false);

  // Warmup truncated at the Sep 2025 calibration date: the chart's history
  // segment and the MC warmup must both stop where the simulation begins.
  const historical = useMemo(() => buildWarmupSOFR1M(), []);
  const sCurve = useMemo(() => nmdSCurveData(params), [params]);
  const balScaleData = useMemo(() => nmdBalanceScalingData(params), [params]);
  const closureRampData = useMemo(() => nmdClosureRampData(params), [params]);

  useEffect(() => {
    setStale(true);
  }, [params, hwSim, bgmSim]);

  const setP = <K extends keyof NMDParams>(k: K, v: NMDParams[K]) => {
    patchNmd({ nmdParams: { ...nmd.nmdParams, [k]: v } });
  };
  const setT = <K extends keyof NMDTerms>(k: K, v: NMDTerms[K]) => {
    patchNmd({ [k]: v } as Partial<NMDTerms>);
  };
  // Keep the cohort size used by the closure model (params.balanceSize) in
  // sync with the instrument-level notional. The user edits one number;
  // both stay aligned.
  const setNotional = (v: number) => {
    patchNmd({
      notional: v,
      nmdParams: { ...nmd.nmdParams, balanceSize: v },
    });
  };

  // Cashflow + tranche projection under the deterministic forward path.
  const { cashflowData, trancheData } = useMemo(() => {
    if (!curve) return { cashflowData: [], trancheData: [] };
    const horizon = nmd.maturityMonths;
    const path = new DeterministicRatePath(curve, horizon);
    const sim = new NMDeposit(nmd, historical).simulateTranches(path);
    const cashflowData = sim.map((s) => ({
      month: s.monthOffset,
      balance: s.balIns + s.balUnins,
      principalPaid: s.principalPaid,
      interestPaid: s.interestPaid,
    }));
    const trancheData = sim.map((s) => {
      const total = s.balIns + s.balUnins;
      return {
        month: s.monthOffset,
        uninsuredPct: total > 0 ? (s.balUnins / total) * 100 : 0,
        balIns: s.balIns,
        balUnins: s.balUnins,
      };
    });
    return { cashflowData, trancheData };
  }, [curve, nmd, historical]);

  const cashflowSummary = useMemo(() => {
    let totalDecay = 0;
    let totalInterest = 0;
    let walNum = 0;
    let walDen = 0;
    for (const r of cashflowData) {
      totalDecay += r.principalPaid;
      totalInterest += r.interestPaid;
      walNum += (r.month / 12) * r.principalPaid;
      walDen += r.principalPaid;
    }
    // Tail piece: any balance still alive at the projection horizon is treated
    // as if it left at t = horizon. Mirrors the MC NMD WAL convention so the
    // deterministic-forward WAL here matches the base-deterministic WAL in
    // the analytics block below to within rounding.
    const lastRow = cashflowData[cashflowData.length - 1];
    const residual = lastRow ? Math.max(0, lastRow.balance - lastRow.principalPaid) : 0;
    const horizonYears = nmd.maturityMonths / 12;
    const walNumWithTail = walNum + residual * horizonYears;
    const walDenWithTail = walDen + residual;
    return {
      nMonths: cashflowData.length,
      totalDecay,
      totalInterest,
      residual,
      walYears: walDenWithTail > 1e-12 ? walNumWithTail / walDenWithTail : 0,
    };
  }, [cashflowData, nmd.maturityMonths]);

  const runAnalytics = async () => {
    if (!hwSim || !bgmSim || !curve || !tlpCurve) return;
    setRunning(true);
    try {
      const nSteps = hwSim.times.length;
      const basePath = new Float64Array(nSteps);
      for (let t = 0; t < nSteps; t++) {
        const time = t / 12;
        basePath[t] = curve.forwardRate(time, time + NMD_TENOR_YEARS);
      }
      const hwPaths = projectHWToTenor(hwSim, curve, NMD_TENOR_YEARS);
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
      const sRef = nmd.salienceRefPct ?? 4;
      const base = runNMDOnPaths([basePath], params, historical, sRef);
      const hw = runNMDOnPaths(hwPaths, params, historical, sRef);
      const bgm = runNMDOnPaths(bgmPaths, params, historical, sRef);
      // Effective duration per scenario: ±100bp parallel LEVEL shock. The
      // Non-IB driver is spread = r − MA(r), so a consistent level shift must
      // move the trailing-MA warmup history by the same amount as the path;
      // otherwise the un-shocked warmup makes the spread spike for the first
      // ~24 months (current rate shocked, average still on old history),
      // which spuriously front-loads runoff and collapses the duration. With
      // the warmup shocked too, the spread is invariant to a parallel shift
      // and the duration is the discounting duration of the runoff (just
      // under WAL), plus the genuine convexity from the LEVEL-dependent parts
      // of the model. Warmup is in % p.a., so the bp shock is bp/100.
      const durOf = (arrs: ReadonlyArray<ArrayLike<number>>) =>
        effectiveDurationOnPaths(
          (p, shockBp) => {
            const hist =
              shockBp === 0 ? historical : historical.map((h) => h + shockBp / 100);
            return new NMDeposit(nmd, hist).generateCashflows(p);
          },
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

  // Combined historical + simulated 1M rate chart for regime context.
  // Months are plotted as integer offsets from "now" (=0). Negative = past, positive = simulated future.
  const regimeData = useMemo(() => {
    const histMonthsToShow = 60;
    const histTail = historical.slice(-histMonthsToShow);
    const out: Array<{
      monthOffset: number;
      historical?: number;
      hwMean?: number;
      bgmMean?: number;
      hwBand?: [number, number];
      bgmBand?: [number, number];
    }> = [];

    histTail.forEach((r, i) => {
      out.push({ monthOffset: i - (histMonthsToShow - 1), historical: r });
    });

    if (hwSim && bgmSim && curve) {
      const horizonSteps = Math.min(120, hwSim.times.length); // show first 10 years of forward sim
      const hwFwd = projectHWToTenor(hwSim, curve, NMD_TENOR_YEARS);
      for (let k = 0; k < horizonSteps; k++) {
        const cs = new Float64Array(hwSim.nPaths);
        for (let p = 0; p < hwSim.nPaths; p++) cs[p] = hwFwd[p][k];
        const hwMean = (Array.from(cs).reduce((s, v) => s + v, 0) / cs.length) * 100;
        const hwLow = percentile(cs, 0.05) * 100;
        const hwHigh = percentile(cs, 0.95) * 100;

        const csB = new Float64Array(bgmSim.nPaths);
        const nT = bgmSim.tenors.length;
        const bgmNSteps = bgmSim.times.length;
        for (let p = 0; p < bgmSim.nPaths; p++) {
          csB[p] = bgmSim.rates[(p * bgmNSteps + k) * nT + BGM_1M_TENOR_IDX];
        }
        const bgmMean = (Array.from(csB).reduce((s, v) => s + v, 0) / csB.length) * 100;
        const bgmLow = percentile(csB, 0.05) * 100;
        const bgmHigh = percentile(csB, 0.95) * 100;

        out.push({
          monthOffset: k + 1,
          hwMean,
          bgmMean,
          hwBand: [hwLow, hwHigh],
          bgmBand: [bgmLow, bgmHigh],
        });
      }
    }
    return out;
  }, [historical, hwSim, bgmSim, curve]);

  // Build chart data with t=0 anchor at balance=100.
  const chartData: Array<{
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
  }> = [];
  if (results) {
    chartData.push({
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
    });
    for (let i = 0; i < results.hw.decayMean.length; i++) {
      chartData.push({
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
      });
    }
  }

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

  const mcReady = Boolean(hwSim && bgmSim);

  return (
    <div>
      <h1 className="section-title">Non-Interest-Bearing NMD</h1>
      <p className="section-subtitle">
        Static-rate liability (D = 0%) with a four-factor closure overlay. The terms below
        feed the deterministic-forward attrition cashflows that the ALM Analytics tabs
        consume; the path-driven Monte Carlo at the bottom shows decay and balance
        dispersion under HW and BGM 1M scenarios.
      </p>

      {/* Deposit terms --------------------------------------------- */}
      <div className="dash-card">
        <div className="group-label">Deposit terms: Non-IB NMD (D ≡ 0%)</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24 }}>
          <NumberField
            label="Cohort balance ($)"
            value={nmd.notional}
            step={100_000}
            onChange={setNotional}
          />
          <div>
            <div className="form-label" style={{ marginBottom: 6 }}>Deposit rate (%)</div>
            <input
              type="number"
              className="form-input"
              value={(nmd.depositRate * 100).toFixed(3)}
              readOnly
              disabled
              style={{ width: "100%", background: "rgba(18,19,18,0.04)", color: "rgba(18,19,18,0.65)" }}
            />
            <div className="form-helper" style={{ marginTop: 4, fontSize: 11 }}>
              Locked at 0%: NMD-A is non-interest-bearing.
            </div>
          </div>
          <NumberField
            label="Projection horizon (mo)"
            value={nmd.maturityMonths}
            step={12}
            onChange={(v) => setT("maturityMonths", Math.max(1, Math.round(v)))}
          />
        </div>
        <div className="form-helper" style={{ marginTop: 12, fontStyle: "italic" }}>
          Balance-sheet side: <strong>liability</strong>. NMD-A pays no interest, so the
          full FTP credit on the all-in funding curve flows to the deposit franchise as
          NIM. Cohort balance feeds the closure model's <code>balanceSize</code>
          automatically. The interest-bearing NMD-B with β-driven repricing against
          a market index is a separate instrument (Phase 7).
        </div>
      </div>

      {/* Cashflow projection (deterministic forward path) ----------- */}
      {curve && cashflowData.length > 0 && (
        <>
          <div className="dash-card" style={{ marginTop: 16 }}>
            <div className="group-label">Cashflow summary (deterministic forward path)</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 24, fontSize: 13 }}>
              <KVP label="Months projected" value={`${cashflowSummary.nMonths}`} />
              <KVP label="Total interest paid" value={formatDollar(cashflowSummary.totalInterest)} />
              <KVP label="Total decay" value={formatDollar(cashflowSummary.totalDecay)} />
              <KVP label="WAL (years)" value={`${cashflowSummary.walYears.toFixed(2)}y`} />
            </div>
          </div>

          <div className="row" style={{ marginTop: 16 }}>
            <div className="dash-card grow" style={{ height: 400 }}>
              <div className="group-label">Outstanding deposit balance</div>
              <ResponsiveContainer width="100%" height="88%">
                <ComposedChart data={cashflowData} margin={{ top: 16, right: 16, bottom: 36, left: 88 }}>
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
                <ComposedChart data={cashflowData} margin={{ top: 32, right: 16, bottom: 36, left: 88 }}>
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
              Decay column is the dollar outflow from the cohort that month; interest is
              the deposit rate × running balance / 12 paid by the bank to depositors.
              Under the deterministic forward path this projection is what the gap and FTP
              analytics see.
            </p>
            <div style={{ maxHeight: 280, overflowY: "auto", border: "1px solid rgba(18,19,18,0.08)" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead style={{ position: "sticky", top: 0, background: "var(--cloud-dancer)", boxShadow: "inset 0 -1px 0 rgba(18,19,18,0.15)" }}>
                  <tr>
                    <th style={{ padding: "6px 12px", textAlign: "right", fontWeight: 500, color: "var(--obsidian)" }}>Month</th>
                    <th style={{ padding: "6px 12px", textAlign: "right", fontWeight: 500, color: "var(--obsidian)" }}>Opening balance</th>
                    <th style={{ padding: "6px 12px", textAlign: "right", fontWeight: 500, color: "var(--obsidian)" }}>Interest paid</th>
                    <th style={{ padding: "6px 12px", textAlign: "right", fontWeight: 500, color: "var(--obsidian)" }}>Decay</th>
                  </tr>
                </thead>
                <tbody>
                  {cashflowData.map((c) => (
                    <tr key={c.month} style={{ borderTop: "1px solid rgba(18,19,18,0.04)" }}>
                      <td style={{ padding: "4px 12px", textAlign: "right", color: "var(--obsidian)" }}>{c.month}</td>
                      <td style={{ padding: "4px 12px", textAlign: "right", color: "var(--obsidian)" }}>{formatDollar2(c.balance)}</td>
                      <td style={{ padding: "4px 12px", textAlign: "right", color: "var(--obsidian)" }}>{formatDollar2(c.interestPaid)}</td>
                      <td style={{ padding: "4px 12px", textAlign: "right", color: "var(--obsidian)" }}>{formatDollar2(c.principalPaid)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <h2 className="section-title" style={{ fontSize: 22, marginTop: 32, fontStyle: "italic" }}>
        Decay model: internals
      </h2>

      {/* Model description ------------------------------------------ */}
      <div className="dash-card">
        <div className="group-label">Model &amp; math</div>
        <div style={{ fontSize: 13, lineHeight: 1.65, color: "rgba(18,19,18,0.85)" }}>
          <p style={{ marginBottom: 12 }}>
            Prepayment-form two-tranche decay model. The cohort splits at the FDIC insured threshold
            D<sub>ref</sub> (default $250k): the insured tranche min(D<sub>ref</sub>, balance) decays at
            the baseline closure rate only; the uninsured tranche additionally carries a one-sided
            rate incentive (the refi analog). The spread driving the incentive is
            r<sub>1M</sub> − MA<sub>P</sub>(r<sub>1M</sub>) — the rate-surprise spread — keeping
            the MA warmup history that anchors the model in actual rate regimes.
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
              the rate-surprise spread, scaled by the cash-sorting salience r/r<sub>ref</sub>:
              <div style={{ fontFamily: "Georgia, serif", fontStyle: "italic", paddingLeft: 16, marginTop: 4 }}>
                spread(t) = r<sub>1M</sub>(t) − MA<sub>P</sub>(r<sub>1M</sub>; t)
              </div>
              <div style={{ fontFamily: "Georgia, serif", fontStyle: "italic", paddingLeft: 16, marginTop: 4 }}>
                base_incentive(t) = max_growth + (max_decay − max_growth) / (1 + exp(−K · (spread − midpoint)))
              </div>
              <div style={{ fontFamily: "Georgia, serif", fontStyle: "italic", paddingLeft: 16, marginTop: 4 }}>
                B(t) = exp(−λ<sub>b</sub> · C(t)),   C(t) = Σ<sub>s&lt;t</sub> max(0, base_incentive(s))
              </div>
              <div style={{ paddingLeft: 16, fontSize: 12, color: "rgba(18,19,18,0.6)", marginTop: 4 }}>
                With max_growth = 0 (default) the logistic runs one-sided from 0 to max_decay,
                the same shape as a mortgage refi-incentive curve: depositors leave fast when rates
                surprise to the upside, and simply stay parked when they don't. The salience factor
                r/r<sub>ref</sub> (default r<sub>ref</sub> = 4%) is the cash-sorting effect — a given
                spread moves money much faster at 6% short rates than at 1%. Burnout B(t) is disabled
                by default (λ<sub>b</sub> = 0): uninsured money stays rate-responsive throughout.
              </div>
            </li>
          </ol>
          <div className="form-helper" style={{ paddingTop: 12, borderTop: "1px solid rgba(18,19,18,0.08)" }}>
            <strong>Spread driver vs IB NMD:</strong> the spread here is r − MA (rate-surprise),
            not r − D (rate-level-minus-deposit-rate). The MA warmup is retained so early-projection
            months reference actual rate regimes. On the 3/31 curve the 24-month MA is elevated from
            the 2023-24 hiking cycle; the spread starts negative, gradually normalising toward zero as
            the MA refreshes with new lower rates. This regime path, not a parameter choice, determines
            where the logistic operates during the first two years.
          </div>
        </div>
      </div>

      {/* Parameter cards (equal height, 4-up) ------------------------ */}
      <div className="row" style={{ marginTop: 16 }}>
        <div className="dash-card grow" style={{ height: ROW_CARD_HEIGHT, display: "flex", flexDirection: "column" }}>
          <div className="group-label">Decay levels</div>
          <NumberRow label="Closure steady (%/mo)" step={0.05} value={params.closureSteady} onChange={(v) => setP("closureSteady", v)} />
          <NumberRow label="Max rate decay (%)" step={0.1} value={params.maxRateDecay} onChange={(v) => setP("maxRateDecay", v)} />
          <NumberRow label="Max rate growth (%)" step={0.1} value={params.maxRateGrowth} onChange={(v) => setP("maxRateGrowth", v)} />
          <div className="form-helper" style={{ marginTop: 12, fontStyle: "italic" }}>
            Closure-steady is the long-run baseline (after the age ramp settles). Max decay caps the
            high-spread plateau of the one-sided logistic. Max growth defaults to 0 — one-sided,
            prepayment-style; negative values re-enable the inflow-damping lower tail.
          </div>
        </div>
        <div className="dash-card grow" style={{ height: ROW_CARD_HEIGHT, display: "flex", flexDirection: "column" }}>
          <div className="group-label">Logistic shape</div>
          <NumberRow label="K (steepness)" step={0.1} value={params.logisticK} onChange={(v) => setP("logisticK", v)} />
          <NumberRow label="Midpoint (spread %)" step={0.05} value={params.logisticMidpoint} onChange={(v) => setP("logisticMidpoint", v)} />
          <NumberRow label="MA period (months)" value={params.maPeriod} onChange={(v) => setP("maPeriod", v)} />
          <NumberRow label="Salience ref (%)" step={0.5} value={nmd.salienceRefPct ?? 4} onChange={(v) => setT("salienceRefPct", Math.max(0.1, v))} />
          <div className="form-helper" style={{ marginTop: 12, fontStyle: "italic" }}>
            K controls steepness; midpoint is in spread (r−MA) units — keep near 0 for Non-IB.
            MA period feeds the warmup window. Salience ref r<sub>ref</sub> normalises the
            cash-sorting multiplier r/r<sub>ref</sub> on the uninsured incentive.
          </div>
        </div>
        <div className="dash-card grow" style={{ height: ROW_CARD_HEIGHT, display: "flex", flexDirection: "column" }}>
          <div className="group-label">Tranche split</div>
          <NumberRow label="Initial balance ($)" value={params.balanceSize} onChange={(v) => setP("balanceSize", v)} />
          <NumberRow label="D_ref insured threshold ($)" value={params.balanceDenominator} onChange={(v) => setP("balanceDenominator", v)} />
          <div className="form-helper" style={{ marginTop: 12, fontStyle: "italic" }}>
            D<sub>ref</sub> = FDIC insured threshold (default $250k). Insured tranche = min(D<sub>ref</sub>,
            balance); uninsured = remainder. The insured tranche decays at closure only; the uninsured
            carries the full rate incentive. As the uninsured runs off, total rate sensitivity
            self-extinguishes — the remaining core is insured deposits insensitive to rate.
          </div>
        </div>
        <div className="dash-card grow" style={{ height: ROW_CARD_HEIGHT, display: "flex", flexDirection: "column" }}>
          <div className="group-label">Path dependency</div>
          <NumberRow label="Closure initial (%/mo)" step={0.1} value={params.closureInitial} onChange={(v) => setP("closureInitial", v)} />
          <NumberRow label="Closure τ (months)" step={1} value={params.closureTauMonths} onChange={(v) => setP("closureTauMonths", v)} />
          <NumberRow label="Burnout λ" step={0.05} value={params.burnoutLambda} onChange={(v) => setP("burnoutLambda", v)} />
          <div className="form-helper" style={{ marginTop: 12, fontStyle: "italic" }}>
            Closure age-ramp: closure(t) decays from initial → steady with time-constant τ. Burnout
            B(t) = exp(−λ · cum positive incentive) damps rate sensitivity after high-incentive history.
            λ = 0 disables burnout; initial = steady disables the ramp.
          </div>
        </div>
      </div>

      {/* Run --------------------------------------------------------- */}
      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="form-row">
          <button
            type="button"
            className="btn btn-filled"
            onClick={() => void runAnalytics()}
            disabled={running || !mcReady}
          >
            {running ? "Computing…" : "Run NMD analytics →"}
          </button>
          {!mcReady && (
            <span className="form-helper" style={{ marginLeft: 12, fontStyle: "italic" }}>
              Run both HW and BGM simulations on the simulator tabs to enable Monte Carlo decay analytics.
            </span>
          )}
          {mcReady && stale && results && (
            <span className="form-helper" style={{ color: "#C86A3A" }}>
              Controls or simulations changed since last run. Re-run for fresh results.
            </span>
          )}
        </div>
      </div>

      {/* Diagnostic charts: row 1 = S-curve + balance scaling --------- */}
      <div className="row" style={{ marginTop: 24 }}>
        <div className="dash-card grow" style={{ height: DIAGNOSTIC_CARD_HEIGHT }}>
          <div className="group-label">Decay incentive vs spread</div>
          <ResponsiveContainer width="100%" height="88%">
            <ComposedChart data={sCurve} margin={{ top: 16, right: 16, bottom: 36, left: 48 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
              <XAxis
                dataKey="spread"
                type="number"
                domain={[-4, 4]}
                tickFormatter={(v) => `${v.toFixed(1)}`}
                stroke={COLORS.obsidian}
                tick={{ fontSize: 12, fill: COLORS.obsidian }}
                label={{ value: "Spread r₁ₘ − MA (%)", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
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
          <div className="group-label">Balance scaling vs decay impact</div>
          <ResponsiveContainer width="100%" height="88%">
            <ComposedChart data={balScaleData} margin={{ top: 32, right: 16, bottom: 36, left: 48 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
              <XAxis
                dataKey="ratio"
                type="number"
                scale="log"
                domain={[0.1, 10]}
                ticks={[0.1, 0.25, 0.5, 1, 2, 4, 10]}
                tickFormatter={(v) => (v < 1 ? `${v}×` : `${v}×`)}
                stroke={COLORS.obsidian}
                tick={{ fontSize: 12, fill: COLORS.obsidian }}
                label={{ value: "Balance ratio S / S₀ (log scale)", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
              />
              <YAxis
                stroke={COLORS.obsidian}
                tick={{ fontSize: 12, fill: COLORS.obsidian }}
                tickFormatter={(v) => `${v.toFixed(1)}%`}
                label={{ value: "Rate-driven decay (%/mo)", angle: -90, position: "insideLeft", style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
              />
              <Tooltip
                formatter={tooltipNumberFormatter("%", 3)}
                labelFormatter={(v) => (typeof v === "number" ? `S / S₀ = ${v.toFixed(2)}×` : "")}
              />
              <ReferenceLine y={0} stroke="rgba(18,19,18,0.18)" />
              <ReferenceLine x={1} stroke="rgba(18,19,18,0.25)" strokeDasharray="3 3" label={{ value: "S = S₀", position: "top", fontSize: 10 }} />
              <Line dataKey="spreadDown" stroke={SERIES.bgm} strokeWidth={2} dot={false} isAnimationActive={false} name="spread = −2% (inflows)" />
              <Line dataKey="spreadFlat" stroke={COLORS.obsidian} strokeWidth={2} dot={false} isAnimationActive={false} name="spread = 0%" />
              <Line dataKey="spreadUp" stroke={SERIES.hw} strokeWidth={2} dot={false} isAnimationActive={false} name="spread = +2% (outflows)" />
              <Legend verticalAlign="top" height={28} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Diagnostic charts: row 2 = closure age ramp ------------------ */}
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

      {/* Diagnostic charts: row 3 = full-width regime overlay --------- */}
      <div style={{ marginTop: 16 }}>
        <div className="dash-card" style={{ height: DIAGNOSTIC_CARD_HEIGHT }}>
          <div className="group-label">Historical 1M SOFR + simulated regime</div>
          <ResponsiveContainer width="100%" height="88%">
            <ComposedChart data={regimeData} margin={{ top: 32, right: 16, bottom: 36, left: 48 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
              <XAxis
                dataKey="monthOffset"
                type="number"
                domain={[-60, 120]}
                ticks={[-60, -36, -12, 0, 12, 36, 60, 120]}
                tickFormatter={(v) => `${v}m`}
                stroke={COLORS.obsidian}
                tick={{ fontSize: 12, fill: COLORS.obsidian }}
                label={{ value: "Months from now (−past, +future)", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
              />
              <YAxis
                domain={[0, 8]}
                ticks={[0, 2, 4, 6, 8]}
                allowDataOverflow={true}
                stroke={COLORS.obsidian}
                tick={{ fontSize: 12, fill: COLORS.obsidian }}
                tickFormatter={(v) => `${v.toFixed(0)}%`}
                label={{ value: "1M SOFR (%)", angle: -90, position: "insideLeft", style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
              />
              <Tooltip
                formatter={tooltipNumberFormatter("%", 2)}
                labelFormatter={(v) =>
                  typeof v === "number"
                    ? v >= 0
                      ? `${v} months forward`
                      : `${-v} months ago`
                    : ""
                }
              />
              <Area dataKey="hwBand" fill={SERIES.hwBandFill} stroke={SERIES.hw} strokeOpacity={0.45} strokeWidth={1} isAnimationActive={false} name="HW p5–p95" />
              <Area dataKey="bgmBand" fill={SERIES.bgmBandFill} stroke={SERIES.bgm} strokeOpacity={0.45} strokeWidth={1} isAnimationActive={false} name="BGM p5–p95" />
              <Line dataKey="historical" stroke={SERIES.deterministic} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} name="Historical (FOMC anchors)" />
              <Line dataKey="hwMean" stroke={SERIES.hw} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} name="HW forward mean" />
              <Line dataKey="bgmMean" stroke={SERIES.bgm} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} name="BGM forward mean" />
              <ReferenceLine x={0} stroke={COLORS.obsidian} strokeDasharray="3 3" label={{ value: "now", position: "top", fontSize: 10 }} />
              <Legend verticalAlign="top" height={28} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Result fans ------------------------------------------------- */}
      {results && (
        <ChartErrorBoundary label="NMD analytics charts">
          <div className="dash-card" style={{ height: FAN_CARD_HEIGHT, marginTop: 24 }}>
            <div className="group-label">Decay rate fan</div>
            <ResponsiveContainer width="100%" height="92%">
              <ComposedChart data={chartData} margin={{ top: 32, right: 24, bottom: 36, left: 56 }}>
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
                  tickFormatter={(v) => `${v.toFixed(1)}%`}
                  label={{ value: "Decay rate (%/mo)", angle: -90, position: "insideLeft", style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                />
                <Tooltip
                  formatter={tooltipNumberFormatter("%", 3)}
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
            <div className="group-label">Balance fan</div>
            <ResponsiveContainer width="100%" height="92%">
              <ComposedChart data={chartData} margin={{ top: 32, right: 24, bottom: 36, left: 56 }}>
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
                  formatter={tooltipNumberFormatter("", 2)}
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
                <Bar dataKey="effDur" name="Effective duration (years)" fill={SERIES.bgm} />
                <Legend verticalAlign="top" height={28} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
              </BarChart>
            </ResponsiveContainer>
            <div className="form-helper">
              Effective duration: ±100bp parallel LEVEL shock (path and the trailing-MA warmup
              history both shifted), PV discounted on the FHLB advance curve (SOFR + the TLP
              spread). The TLP spread over SOFR is held static across simulated paths and rate
              shocks: the FHLB curve inherits the SOFR simulation, it is not simulated directly.
              Because the Non-IB driver is the spread r − MA(r), a parallel shift leaves it
              unchanged, so the runoff profile is invariant and the duration is purely the
              discounting duration of that runoff. It sits below WAL by the standard discounting
              wedge (D ≈ WAL / (1 + r·WAL)), not by optionality. This is the longest-duration
              NMD: a 0% coupon with no repricing. Life decay (%/mo):{" "}
              {walData.map((d) => `${d.scenario.split(" ")[0]} ${d.decay.toFixed(3)}`).join(" · ")}.
            </div>
          </div>

          <div className="dash-card" style={{ marginTop: 16 }}>
            <div className="group-label">PV of runoff under ±100bp · FHLB advance curve (SOFR + TLP)</div>
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
              PV of the projected principal runoff on the funding curve. The gap between notional
              and PV is the economic value of holding a 0% liability against term funding rates;
              the FTP tab prices the same franchise as a running margin.
            </div>
          </div>

          <div className="dash-card" style={{ height: DIAGNOSTIC_CARD_HEIGHT, marginTop: 16 }}>
            <div className="group-label">Uninsured tranche share (deterministic path)</div>
            <ResponsiveContainer width="100%" height="88%">
              <ComposedChart data={trancheData} margin={{ top: 32, right: 16, bottom: 36, left: 48 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
                <XAxis
                  dataKey="month"
                  type="number"
                  stroke={COLORS.obsidian}
                  tick={{ fontSize: 12, fill: COLORS.obsidian }}
                  label={{ value: "Months from sim start", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
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
                <Line dataKey="uninsuredPct" stroke={SERIES.hw} strokeWidth={2} dot={false} isAnimationActive={false} name="Uninsured share of remaining balance" />
              </ComposedChart>
            </ResponsiveContainer>
            <div className="form-helper">
              As rate incentive drains the uninsured tranche (balance above D<sub>ref</sub> = $250k), the
              remaining cohort converges to the insured core, which decays at closure-only. The
              asymptote reflects the initial insured share min(D<sub>ref</sub>, notional) / notional.
            </div>
          </div>
        </ChartErrorBoundary>
      )}
    </div>
  );
}

interface NumberRowProps {
  label: string;
  value: number;
  step?: number;
  onChange: (v: number) => void;
}

function NumberRow({ label, value, step, onChange }: NumberRowProps) {
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

function KVP({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="form-label" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 500, color: "var(--obsidian)" }}>{value}</div>
    </div>
  );
}
