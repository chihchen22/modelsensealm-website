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
  type MBSParams,
  runMBSOnPaths,
  sCurveData,
  seasoningCurve,
  seasonalityCurve,
  burnoutCurve,
  type MBSScenarioOutput,
} from "../../math/behavioral/mbsModel";
import { Mortgage, type MortgageTerms } from "../../math/instruments/mortgage";
import { DeterministicRatePath } from "../../math/rates/ratePath";
import {
  DriverPath,
  effectiveDurationOnPaths,
  type DurationResult,
} from "../../math/analytics/duration";

const MORTGAGE_TENOR_YEARS = 10;
const BGM_10Y_TENOR_IDX = 8; // 1D=0,1M=1,3M=2,6M=3,1Y=4,2Y=5,5Y=6,7Y=7,10Y=8

const ROW_CARD_HEIGHT = 320;
const FAN_CARD_HEIGHT = 540;

const LEGEND_STYLE = {
  fontSize: 12,
  fontFamily: "var(--font-sans)",
  color: "var(--obsidian)",
};

function darkLegendFormatter(value: string) {
  return <span style={{ color: "var(--obsidian)", fontWeight: 500 }}>{value}</span>;
}

const tooltipNumberFormatter = (suffix: string) => (v: unknown, name: string) => {
  if (typeof v === "number" && Number.isFinite(v)) return [`${v.toFixed(2)}${suffix}`, name];
  if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number") {
    return [`${v[0].toFixed(2)} – ${v[1].toFixed(2)}${suffix}`, name];
  }
  return ["—", name];
};

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

export function MbsTab() {
  const { hwSim, bgmSim, curve, tlpCurve } = useApp();
  const { mortgage, patchMortgage } = useInstruments();
  const params = mortgage.cprParams;

  const [results, setResults] = useState<{
    base: MBSScenarioOutput;
    hw: MBSScenarioOutput;
    bgm: MBSScenarioOutput;
    dur: { base: DurationResult; hw: DurationResult; bgm: DurationResult };
  } | null>(null);
  const [stale, setStale] = useState(true);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    setStale(true);
  }, [params, hwSim, bgmSim]);

  const setT = <K extends keyof MortgageTerms>(k: K, v: MortgageTerms[K]) => {
    patchMortgage({ [k]: v } as Partial<MortgageTerms>);
  };
  // Always keep remaining term consistent with originalTerm − age unless user
  // overrides explicitly via maturityMonths. We expose all three to the user;
  // when originalTerm or age changes we recompute maturityMonths.
  const updateTerm = (originalTerm: number, age: number) => {
    const remaining = Math.max(1, originalTerm - age);
    patchMortgage({ originalTermMonths: originalTerm, ageMonths: age, maturityMonths: remaining });
  };

  const sCurve = useMemo(() => sCurveData(params), [params]);
  const seasoning = useMemo(() => seasoningCurve(params), [params]);
  const seasonality = useMemo(() => seasonalityCurve(params), [params]);

  const currentRateDiff = useMemo(() => {
    if (!curve) return 0;
    const baseFwd = curve.forwardSwapRate(0, MORTGAGE_TENOR_YEARS);
    const totalSpread = (params.secSpread + params.primSpread) / 1e4;
    return params.wac - (baseFwd + totalSpread) * 100;
  }, [curve, params]);

  // Burnout uses the current ITM as a constant exposure proxy for the diagnostic.
  const burnout = useMemo(
    () => burnoutCurve(params, Math.max(0.01, currentRateDiff)),
    [params, currentRateDiff],
  );

  const setP = <K extends keyof MBSParams>(k: K, v: MBSParams[K]) => {
    patchMortgage({ cprParams: { ...mortgage.cprParams, [k]: v } });
  };

  // Cashflow projection under the deterministic forward path. This is the same
  // `Mortgage.generateCashflows(path)` that drives the ALM analytics tabs, so
  // what you see here is what Repricing Gap, Liquidity Gap, and FTP consume.
  const cashflowData = useMemo(() => {
    if (!curve) return [];
    const horizon = mortgage.maturityMonths;
    const path = new DeterministicRatePath(curve, horizon);
    const cf = new Mortgage(mortgage).generateCashflows(path);
    return cf.map((c) => ({
      month: c.monthOffset,
      balance: c.balance,
      principalPaid: c.principalPaid,
      interestPaid: c.interestPaid,
    }));
  }, [curve, mortgage]);

  const cashflowSummary = useMemo(() => {
    let totalPrincipal = 0;
    let totalInterest = 0;
    let walNum = 0;
    let walDen = 0;
    for (const r of cashflowData) {
      totalPrincipal += r.principalPaid;
      totalInterest += r.interestPaid;
      walNum += (r.month / 12) * r.principalPaid;
      walDen += r.principalPaid;
    }
    return {
      nMonths: cashflowData.length,
      totalPrincipal,
      totalInterest,
      walYears: walDen > 1e-12 ? walNum / walDen : 0,
    };
  }, [cashflowData]);

  const runAnalytics = async () => {
    if (!hwSim || !bgmSim || !curve || !tlpCurve) return;
    setRunning(true);
    try {
      const nSteps = hwSim.times.length;
      const basePath = new Float64Array(nSteps);
      for (let t = 0; t < nSteps; t++) {
        const time = t / 12;
        basePath[t] = curve.forwardSwapRate(time, time + MORTGAGE_TENOR_YEARS);
      }
      const hwPaths = projectHWToTenor(hwSim, curve, MORTGAGE_TENOR_YEARS);
      const bgmPaths: Float64Array[] = [];
      const nT = bgmSim.tenors.length;
      const bgmNSteps = bgmSim.times.length;
      for (let p = 0; p < bgmSim.nPaths; p++) {
        const path = new Float64Array(bgmNSteps);
        for (let t = 0; t < bgmNSteps; t++) {
          path[t] = bgmSim.rates[(p * bgmNSteps + t) * nT + BGM_10Y_TENOR_IDX];
        }
        bgmPaths.push(path);
      }

      await new Promise((r) => setTimeout(r, 50));
      const base = runMBSOnPaths([basePath], params);
      const hw = runMBSOnPaths(hwPaths, params);
      const bgm = runMBSOnPaths(bgmPaths, params);
      // Effective duration per scenario: ±100bp parallel bump on the 10Y
      // driver path; the Richard-Roll prepayment response re-fires under the
      // bump (down-shock → refi wave → contraction). PV on the all-in
      // SOFR+TLP curve rebuilt from the shifted zero curve.
      const instr = new Mortgage(mortgage);
      // parAnchor: PV is anchored to par at base by a solved spread (static
      // spread on the deterministic path, OAS under MC), held fixed for the
      // ±100bp legs. Without it a premium pool shows near-zero duration
      // because the down-shock refi wave destroys the premium.
      const durOf = (arrs: ReadonlyArray<ArrayLike<number>>) =>
        effectiveDurationOnPaths(
          (p) => instr.generateCashflows(p),
          arrs.map((a) => new DriverPath(a)),
          curve,
          tlpCurve,
          { parAnchor: mortgage.notional },
        );
      const dur = { base: durOf([basePath]), hw: durOf(hwPaths), bgm: durOf(bgmPaths) };
      setResults({ base, hw, bgm, dur });
      setStale(false);
    } finally {
      setRunning(false);
    }
  };

  const mcReady = Boolean(hwSim && bgmSim);

  const chartData: Array<{
    month: number;
    cprBase: number;
    cprHW: number;
    cprHWBand: [number, number];
    cprBGM: number;
    cprBGMBand: [number, number];
    balBase: number;
    balHW: number;
    balHWBand: [number, number];
    balBGM: number;
    balBGMBand: [number, number];
  }> = [];
  if (results) {
    // Anchor balance series at 100 by prepending t=0.
    chartData.push({
      month: 0,
      cprBase: 0,
      cprHW: 0,
      cprHWBand: [0, 0],
      cprBGM: 0,
      cprBGMBand: [0, 0],
      balBase: 100,
      balHW: 100,
      balHWBand: [100, 100],
      balBGM: 100,
      balBGMBand: [100, 100],
    });
    for (let i = 0; i < results.hw.cprMean.length; i++) {
      chartData.push({
        month: i + 1,
        cprBase: results.base.cprMean[i],
        cprHW: results.hw.cprMean[i],
        cprHWBand: [results.hw.cprP5[i], results.hw.cprP95[i]],
        cprBGM: results.bgm.cprMean[i],
        cprBGMBand: [results.bgm.cprP5[i], results.bgm.cprP95[i]],
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
          cpr: results.base.lifeCpr,
        },
        {
          scenario: "Hull-White 1F",
          wal: results.hw.wal,
          effDur: results.dur.hw.effectiveDuration,
          cpr: results.hw.lifeCpr,
        },
        {
          scenario: "BGM / LMM",
          wal: results.bgm.wal,
          effDur: results.dur.bgm.effectiveDuration,
          cpr: results.bgm.lifeCpr,
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

  return (
    <div>
      <h1 className="section-title">Mortgage</h1>
      <p className="section-subtitle">
        Fixed-rate mortgage with a four-factor prepayment overlay (Richard-Roll). The loan
        terms below feed the deterministic-forward cashflows that the ALM Analytics tabs
        consume; the path-driven Monte Carlo at the bottom shows WAL and CPR dispersion
        under HW and BGM rate scenarios.
      </p>

      {/* Loan terms ------------------------------------------------- */}
      <div className="dash-card">
        <div className="group-label">Loan terms</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 24 }}>
          <NumberField
            label="Current balance ($)"
            value={mortgage.notional}
            step={10_000}
            onChange={(v) => setT("notional", v)}
          />
          <NumberField
            label="Original balance ($)"
            value={mortgage.originalBalance}
            step={10_000}
            onChange={(v) => setT("originalBalance", v)}
          />
          <NumberField
            label="Note rate (%)"
            value={mortgage.noteRate * 100}
            step={0.125}
            onChange={(v) => setT("noteRate", v / 100)}
          />
          <NumberField
            label="Original term (mo)"
            value={mortgage.originalTermMonths}
            step={12}
            onChange={(v) => updateTerm(Math.max(1, Math.round(v)), mortgage.ageMonths)}
          />
          <NumberField
            label="Age (mo)"
            value={mortgage.ageMonths}
            step={1}
            onChange={(v) => updateTerm(mortgage.originalTermMonths, Math.max(0, Math.round(v)))}
          />
        </div>
        <div className="form-helper" style={{ marginTop: 12, fontStyle: "italic" }}>
          Remaining term = {mortgage.maturityMonths} months. Note rate is the locked coupon
          on the loan; WAC below is the rate the prepayment model uses to compute the refi
          incentive against the prevailing 10Y benchmark. Set them equal unless stressing
          the CPR layer independently.
        </div>
      </div>

      {/* Cashflow projection (deterministic forward path) ----------- */}
      {curve && cashflowData.length > 0 && (
        <>
          <div className="dash-card" style={{ marginTop: 16 }}>
            <div className="group-label">Cashflow summary (deterministic forward path)</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 24, fontSize: 13 }}>
              <KVP label="Months projected" value={`${cashflowSummary.nMonths}`} />
              <KVP label="Total interest" value={formatDollar(cashflowSummary.totalInterest)} />
              <KVP label="Total principal" value={formatDollar(cashflowSummary.totalPrincipal)} />
              <KVP label="WAL (years)" value={`${cashflowSummary.walYears.toFixed(2)}y`} />
            </div>
          </div>

          <div className="row" style={{ marginTop: 16 }}>
            <div className="dash-card grow" style={{ height: 400 }}>
              <div className="group-label">Outstanding balance</div>
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
              <div className="group-label">Monthly cashflow (scheduled + prepay principal, interest)</div>
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
                  <Bar dataKey="interestPaid" stackId="cf" fill={COLORS.nodeTeal} isAnimationActive={false} name="Interest" />
                  <Bar dataKey="principalPaid" stackId="cf" fill={COLORS.nodeOrange} isAnimationActive={false} name="Principal (sched + prepay)" />
                  <Legend verticalAlign="top" height={28} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="dash-card" style={{ marginTop: 16 }}>
            <div className="group-label">Monthly cashflow detail</div>
            <p className="form-helper" style={{ marginTop: -4, marginBottom: 8 }}>
              Principal column combines scheduled level-pay principal and prepayment principal
              from the four-factor CPR. Under the deterministic forward path the projection is
              what the gap and FTP analytics see.
            </p>
            <div style={{ maxHeight: 280, overflowY: "auto", border: "1px solid rgba(18,19,18,0.08)" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead style={{ position: "sticky", top: 0, background: "var(--cloud-dancer)", boxShadow: "inset 0 -1px 0 rgba(18,19,18,0.15)" }}>
                  <tr>
                    <th style={{ padding: "6px 12px", textAlign: "right", fontWeight: 500, color: "var(--obsidian)" }}>Month</th>
                    <th style={{ padding: "6px 12px", textAlign: "right", fontWeight: 500, color: "var(--obsidian)" }}>Opening balance</th>
                    <th style={{ padding: "6px 12px", textAlign: "right", fontWeight: 500, color: "var(--obsidian)" }}>Interest</th>
                    <th style={{ padding: "6px 12px", textAlign: "right", fontWeight: 500, color: "var(--obsidian)" }}>Principal (sched + prepay)</th>
                    <th style={{ padding: "6px 12px", textAlign: "right", fontWeight: 500, color: "var(--obsidian)" }}>Total payment</th>
                  </tr>
                </thead>
                <tbody>
                  {cashflowData.map((c) => (
                    <tr key={c.month} style={{ borderTop: "1px solid rgba(18,19,18,0.04)" }}>
                      <td style={{ padding: "4px 12px", textAlign: "right", color: "var(--obsidian)" }}>{c.month}</td>
                      <td style={{ padding: "4px 12px", textAlign: "right", color: "var(--obsidian)" }}>{formatDollar2(c.balance)}</td>
                      <td style={{ padding: "4px 12px", textAlign: "right", color: "var(--obsidian)" }}>{formatDollar2(c.interestPaid)}</td>
                      <td style={{ padding: "4px 12px", textAlign: "right", color: "var(--obsidian)" }}>{formatDollar2(c.principalPaid)}</td>
                      <td style={{ padding: "4px 12px", textAlign: "right", color: "var(--obsidian)" }}>{formatDollar2(c.interestPaid + c.principalPaid)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <h2 className="section-title" style={{ fontSize: 22, marginTop: 32, fontStyle: "italic" }}>
        Prepayment model: internals
      </h2>

      {/* Model description ------------------------------------------ */}
      <div className="dash-card">
        <div className="group-label">Model &amp; math</div>
        <div style={{ fontSize: 13, lineHeight: 1.65, color: "rgba(18,19,18,0.85)" }}>
          <p style={{ marginBottom: 12 }}>
            Per-month conditional prepayment rate is a product of four factors per Richard &amp; Roll (1989):
          </p>
          <p style={{ fontFamily: "Georgia, serif", fontStyle: "italic", marginBottom: 12, paddingLeft: 16 }}>
            CPR(t) = R(rate_diff) · S<sub>g</sub>(t) · S<sub>s</sub>(month) · B(cum_ITM)
          </p>
          <ol style={{ paddingLeft: 24, marginBottom: 12 }}>
            <li style={{ marginBottom: 8 }}>
              <strong>Refi incentive R</strong> is a logistic S-curve on rate differential:
              <div style={{ fontFamily: "Georgia, serif", fontStyle: "italic", paddingLeft: 16, marginTop: 4 }}>
                R = min_CPR + (max_CPR − min_CPR) / [1 + exp(−steepness · (rate_diff − inflection))]
              </div>
              <div style={{ paddingLeft: 16, fontSize: 12, color: "rgba(18,19,18,0.6)" }}>
                rate_diff = WAC − (10Y forward + sec_spread + prim_spread)
              </div>
            </li>
            <li style={{ marginBottom: 8 }}>
              <strong>Seasoning S<sub>g</sub></strong> is a linear ramp from 0 to 1 over the seasoning period:
              <div style={{ fontFamily: "Georgia, serif", fontStyle: "italic", paddingLeft: 16, marginTop: 4 }}>
                S<sub>g</sub>(t) = min(1, t / seasoning_ramp)
              </div>
            </li>
            <li style={{ marginBottom: 8 }}>
              <strong>Seasonality S<sub>s</sub></strong> is a sinusoidal cycle peaking in summer:
              <div style={{ fontFamily: "Georgia, serif", fontStyle: "italic", paddingLeft: 16, marginTop: 4 }}>
                S<sub>s</sub>(month) = 1 + amplitude · sin(π(month − 4)/6)
              </div>
            </li>
            <li style={{ marginBottom: 8 }}>
              <strong>Burnout B</strong> is exponential damping against cumulative in-the-money exposure:
              <div style={{ fontFamily: "Georgia, serif", fontStyle: "italic", paddingLeft: 16, marginTop: 4 }}>
                B(t) = exp(−burnout_decay · Σ ITM<sub>τ</sub>) for τ ≤ t
              </div>
            </li>
          </ol>
          <p style={{ marginBottom: 8 }}>Single Monthly Mortality:</p>
          <p style={{ fontFamily: "Georgia, serif", fontStyle: "italic", paddingLeft: 16, marginBottom: 12 }}>
            SMM(t) = 1 − (1 − CPR(t))<sup>1/12</sup>
          </p>
          <p style={{ marginBottom: 8 }}>Balance amortization (scheduled principal + prepayment):</p>
          <div style={{ fontFamily: "Georgia, serif", fontStyle: "italic", paddingLeft: 16, marginBottom: 12 }}>
            sp(t) = bal(t) · WAC<sub>m</sub> / [(1 + WAC<sub>m</sub>)<sup>n−t+1</sup> − 1]<br />
            pp(t) = (bal(t) − sp(t)) · SMM(t)<br />
            bal(t+1) = bal(t) − sp(t) − pp(t)
          </div>
          <p style={{ fontSize: 12, color: "rgba(18,19,18,0.55)", fontStyle: "italic" }}>
            Reference: Richard, S.F. &amp; Roll, R. (1989). Prepayments on fixed-rate mortgage-backed securities.
            <em> Journal of Portfolio Management</em>, 15(3), 73–82. Logistic substituted for the original arctan
            refi function (functionally equivalent S-curve shape).
          </p>
        </div>
      </div>

      {/* Parameter cards (equal height) ------------------------------ */}
      <div className="row" style={{ marginTop: 16 }}>
        <div className="dash-card grow" style={{ height: ROW_CARD_HEIGHT, display: "flex", flexDirection: "column" }}>
          <div className="group-label">Spread &amp; rate</div>
          <NumberRow label="Sec OAS spread (bps)" value={params.secSpread} onChange={(v) => setP("secSpread", v)} />
          <NumberRow label="Primary spread (bps)" value={params.primSpread} onChange={(v) => setP("primSpread", v)} />
          <NumberRow label="WAC (%)" step={0.05} value={params.wac} onChange={(v) => setP("wac", v)} />
          <div className="form-helper" style={{ marginTop: 12, fontStyle: "italic" }}>
            Mortgage rate at simulation time t = 10Y forward(t) + sec_spread + primary_spread.
            WAC fixed across the pool.
          </div>
        </div>
        <div className="dash-card grow" style={{ height: ROW_CARD_HEIGHT, display: "flex", flexDirection: "column" }}>
          <div className="group-label">Refi-incentive S-curve</div>
          <NumberRow label="Min CPR (%)" step={0.5} value={params.minCpr} onChange={(v) => setP("minCpr", v)} />
          <NumberRow label="Max CPR (%)" step={0.5} value={params.maxCpr} onChange={(v) => setP("maxCpr", v)} />
          <NumberRow label="Steepness" step={0.1} value={params.steepness} onChange={(v) => setP("steepness", v)} />
          <NumberRow label="Inflection (% above WAC)" value={params.inflection} onChange={(v) => setP("inflection", v)} />
        </div>
        <div className="dash-card grow" style={{ height: ROW_CARD_HEIGHT, display: "flex", flexDirection: "column" }}>
          <div className="group-label">Multipliers</div>
          <NumberRow label="Seasoning ramp (mo)" value={params.seasoningRamp} onChange={(v) => setP("seasoningRamp", v)} />
          <NumberRow label="Seasonality amp (%)" step={1} value={params.seasonalityAmp} onChange={(v) => setP("seasonalityAmp", v)} />
          <NumberRow label="Burnout decay" step={0.01} value={params.burnoutDecay} onChange={(v) => setP("burnoutDecay", v)} />
          <div className="form-helper" style={{ marginTop: 12, fontStyle: "italic" }}>
            Seasoning runs over the first N months (default 30). Seasonality peaks in July/Aug,
            troughs in Jan. Burnout damps refi as cumulative ITM rises.
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
            {running ? "Computing…" : "Run Mortgage Analytics →"}
          </button>
          {!mcReady && (
            <span className="form-helper" style={{ marginLeft: 12, fontStyle: "italic" }}>
              Run both HW and BGM simulations on the simulator tabs to enable Monte Carlo prepayment analytics.
            </span>
          )}
          {mcReady && stale && results && (
            <span className="form-helper" style={{ color: "#C86A3A" }}>
              Controls or simulations changed since last run. Re-run for fresh results.
            </span>
          )}
        </div>
      </div>

      {/* Diagnostic charts (4 in a row) ----------------------------- */}
      <h2 className="section-title" style={{ fontSize: 22, marginTop: 32, fontStyle: "italic" }}>
        Parameter shape diagnostics
      </h2>
      <p className="section-subtitle">Move the controls above; these update live to show how each factor responds.</p>
      <div className="row">
        <div className="dash-card grow" style={{ height: ROW_CARD_HEIGHT }}>
          <div className="group-label">Refi-incentive S-curve</div>
          <ResponsiveContainer width="100%" height="80%">
            <ComposedChart data={sCurve} margin={{ top: 8, right: 16, bottom: 32, left: 36 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
              <XAxis
                dataKey="diffBps"
                type="number"
                domain={[-300, 400]}
                tickFormatter={(v) => `${v}`}
                stroke={COLORS.obsidian}
                tick={{ fontSize: 11, fill: COLORS.obsidian }}
                label={{ value: "WAC − rate (bps)", position: "insideBottom", offset: -8, style: { fontSize: 11, fill: "rgba(18,19,18,0.65)" } }}
              />
              <YAxis
                stroke={COLORS.obsidian}
                tick={{ fontSize: 11, fill: COLORS.obsidian }}
                tickFormatter={(v) => `${v.toFixed(0)}`}
                label={{ value: "CPR (%)", angle: -90, position: "insideLeft", style: { fontSize: 11, fill: "rgba(18,19,18,0.65)" } }}
              />
              <Tooltip
                formatter={tooltipNumberFormatter("%")}
                labelFormatter={(v) => (typeof v === "number" ? `WAC − rate = ${v} bp` : "")}
              />
              <Line dataKey="cpr" stroke={COLORS.obsidian} strokeWidth={2} dot={false} isAnimationActive={false} name="CPR" />
              <ReferenceLine x={currentRateDiff * 100} stroke={SERIES.hw} strokeDasharray="3 3" label={{ value: "current", position: "top", fontSize: 10, fill: SERIES.hw }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <div className="dash-card grow" style={{ height: ROW_CARD_HEIGHT }}>
          <div className="group-label">Seasoning ramp</div>
          <ResponsiveContainer width="100%" height="80%">
            <ComposedChart data={seasoning} margin={{ top: 8, right: 16, bottom: 32, left: 36 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
              <XAxis
                dataKey="month"
                type="number"
                domain={[1, 60]}
                stroke={COLORS.obsidian}
                tick={{ fontSize: 11, fill: COLORS.obsidian }}
                label={{ value: "Loan age (months)", position: "insideBottom", offset: -8, style: { fontSize: 11, fill: "rgba(18,19,18,0.65)" } }}
              />
              <YAxis
                domain={[0, 1.05]}
                stroke={COLORS.obsidian}
                tick={{ fontSize: 11, fill: COLORS.obsidian }}
                tickFormatter={(v) => v.toFixed(1)}
                label={{ value: "Multiplier", angle: -90, position: "insideLeft", style: { fontSize: 11, fill: "rgba(18,19,18,0.65)" } }}
              />
              <Tooltip
                formatter={tooltipNumberFormatter("")}
                labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")}
              />
              <Line dataKey="factor" stroke={SERIES.hw} strokeWidth={2} dot={false} isAnimationActive={false} name="Seasoning" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <div className="dash-card grow" style={{ height: ROW_CARD_HEIGHT }}>
          <div className="group-label">Seasonality</div>
          <ResponsiveContainer width="100%" height="80%">
            <ComposedChart data={seasonality} margin={{ top: 8, right: 16, bottom: 32, left: 36 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
              <XAxis
                dataKey="month"
                type="number"
                domain={[1, 12]}
                ticks={[1, 3, 6, 9, 12]}
                stroke={COLORS.obsidian}
                tick={{ fontSize: 11, fill: COLORS.obsidian }}
                label={{ value: "Calendar month", position: "insideBottom", offset: -8, style: { fontSize: 11, fill: "rgba(18,19,18,0.65)" } }}
              />
              <YAxis
                stroke={COLORS.obsidian}
                tick={{ fontSize: 11, fill: COLORS.obsidian }}
                tickFormatter={(v) => v.toFixed(2)}
                label={{ value: "Multiplier", angle: -90, position: "insideLeft", style: { fontSize: 11, fill: "rgba(18,19,18,0.65)" } }}
              />
              <Tooltip
                formatter={tooltipNumberFormatter("")}
                labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")}
              />
              <ReferenceLine y={1} stroke="rgba(18,19,18,0.18)" />
              <Line dataKey="factor" stroke={SERIES.bgm} strokeWidth={2} dot={false} isAnimationActive={false} name="Seasonality" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <div className="dash-card grow" style={{ height: ROW_CARD_HEIGHT }}>
          <div className="group-label">Burnout decay</div>
          <ResponsiveContainer width="100%" height="80%">
            <ComposedChart data={burnout} margin={{ top: 8, right: 16, bottom: 32, left: 36 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
              <XAxis
                dataKey="month"
                type="number"
                domain={[1, 120]}
                stroke={COLORS.obsidian}
                tick={{ fontSize: 11, fill: COLORS.obsidian }}
                label={{ value: "Months at current ITM", position: "insideBottom", offset: -8, style: { fontSize: 11, fill: "rgba(18,19,18,0.65)" } }}
              />
              <YAxis
                domain={[0, 1.05]}
                stroke={COLORS.obsidian}
                tick={{ fontSize: 11, fill: COLORS.obsidian }}
                tickFormatter={(v) => v.toFixed(2)}
                label={{ value: "Multiplier", angle: -90, position: "insideLeft", style: { fontSize: 11, fill: "rgba(18,19,18,0.65)" } }}
              />
              <Tooltip
                formatter={tooltipNumberFormatter("")}
                labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")}
              />
              <Line dataKey="factor" stroke={SERIES.sabr} strokeWidth={2} dot={false} isAnimationActive={false} name="Burnout" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Result charts ---------------------------------------------- */}
      {results && (
        <ChartErrorBoundary label="MBS analytics charts">
          <div className="dash-card" style={{ height: FAN_CARD_HEIGHT, marginTop: 24 }}>
            <div className="group-label">CPR fan</div>
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
                  label={{ value: "Loan age (years)", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                />
                <YAxis
                  stroke={COLORS.obsidian}
                  tick={{ fontSize: 12, fill: COLORS.obsidian }}
                  tickFormatter={(v) => `${v.toFixed(0)}%`}
                  label={{ value: "CPR (%)", angle: -90, position: "insideLeft", style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                />
                <Tooltip
                  formatter={tooltipNumberFormatter("%")}
                  labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")}
                />
                <Area dataKey="cprHWBand" fill={SERIES.hwBandFill} stroke="none" isAnimationActive={false} name="HW p5–p95" />
                <Area dataKey="cprBGMBand" fill={SERIES.bgmBandFill} stroke="none" isAnimationActive={false} name="BGM p5–p95" />
                <Line dataKey="cprBase" stroke={SERIES.deterministic} strokeWidth={1.5} dot={false} isAnimationActive={false} name="Base (deterministic)" />
                <Line dataKey="cprHW" stroke={SERIES.hw} strokeWidth={2} dot={false} isAnimationActive={false} name="HW mean" />
                <Line dataKey="cprBGM" stroke={SERIES.bgm} strokeWidth={2} dot={false} isAnimationActive={false} name="BGM mean" />
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
                  label={{ value: "Loan age (years)", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                />
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, 25, 50, 75, 100]}
                  allowDataOverflow={true}
                  stroke={COLORS.obsidian}
                  tick={{ fontSize: 12, fill: COLORS.obsidian }}
                  label={{ value: "Outstanding balance (par = 100)", angle: -90, position: "insideLeft", style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                />
                <Tooltip
                  formatter={tooltipNumberFormatter("")}
                  labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")}
                />
                <Area dataKey="balHWBand" fill={SERIES.hwBandFill} stroke="none" isAnimationActive={false} name="HW p5–p95" />
                <Area dataKey="balBGMBand" fill={SERIES.bgmBandFill} stroke="none" isAnimationActive={false} name="BGM p5–p95" />
                <Line dataKey="balBase" stroke={SERIES.deterministic} strokeWidth={1.5} dot={false} isAnimationActive={false} name="Base (deterministic)" />
                <Line dataKey="balHW" stroke={SERIES.hw} strokeWidth={2} dot={false} isAnimationActive={false} name="HW mean" />
                <Line dataKey="balBGM" stroke={SERIES.bgm} strokeWidth={2} dot={false} isAnimationActive={false} name="BGM mean" />
                <Legend verticalAlign="top" height={28} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="dash-card" style={{ height: 360, marginTop: 16 }}>
            <div className="group-label">WAL and effective duration by scenario</div>
            <ResponsiveContainer width="100%" height="82%">
              <BarChart data={walData} margin={{ top: 32, right: 32, bottom: 36, left: 32 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
                <XAxis
                  dataKey="scenario"
                  stroke={COLORS.obsidian}
                  tick={{ fontSize: 12, fill: COLORS.obsidian }}
                />
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
              Effective duration: ±100bp parallel shock on the 10Y driver, prepayment
              re-simulated per path, PV on the all-in (SOFR + TLP) curve. The S-curve makes
              it sit well below WAL (negative convexity: down-shocks trigger the refi wave).
              Life CPR (%):{" "}
              {walData.map((d) => `${d.scenario.split(" ")[0]} ${d.cpr.toFixed(2)}`).join(" · ")}.
            </div>
          </div>

          <div className="dash-card" style={{ marginTop: 16 }}>
            <div className="group-label">PV under ±100bp · all-in (SOFR + TLP) curve + solved spread</div>
            <table className="preview" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Scenario</th>
                  <th>Spread (bp)</th>
                  <th>PV −100bp</th>
                  <th>PV base (par)</th>
                  <th>PV +100bp</th>
                </tr>
              </thead>
              <tbody>
                {pvData.map((d) => (
                  <tr key={d.scenario}>
                    <td>{d.scenario}</td>
                    <td>{d.spreadBp.toFixed(0)}</td>
                    <td>{formatDollar(d.pvDown)}</td>
                    <td>{formatDollar(d.pvBase)}</td>
                    <td>{formatDollar(d.pvUp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="form-helper" style={{ marginTop: 8 }}>
              Base PV is anchored to par by a solved spread over the all-in curve: a static
              spread on the deterministic path, an option-adjusted spread (OAS) under HW and
              BGM. The spread is held fixed for the ±100bp legs, so the duration reads option
              cost, not premium amortization. Compare the solved spread to the modeled
              securitization + primary spreads ({mortgage.cprParams.secSpread} +{" "}
              {mortgage.cprParams.primSpread} bp): the gap is the prepay-option cost the
              scenario prices in. The compressed PV gain under −100bp versus the full loss
              under +100bp is the negative convexity the duration bar summarises.
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
