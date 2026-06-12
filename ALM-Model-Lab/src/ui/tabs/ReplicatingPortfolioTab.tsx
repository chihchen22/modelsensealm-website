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
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";

import { useApp } from "../state/AppContext";
import { useInstruments } from "../state/InstrumentContext";
import { ChartErrorBoundary } from "../components/ChartErrorBoundary";
import { COLORS, SERIES } from "../tokens";
import {
  loadRateHistoryOnce,
  type RateHistory,
} from "../../math/rates/rateHistory";
import {
  FORECAST_HORIZON_MONTHS,
  blendWalMonths,
  buildFrontier,
  buildMarginFrontier,
  historicalRpPerformance,
  newMoneyFlowLadder,
  newMoneyYield,
  pillarLadderCashflows,
  pillarWalMonths,
  regressOnSamples,
  sampleCovariance,
  sampleMean,
  simulatedClientRateSamples,
  simulatedPillarYieldSamples,
  stackedLadderByPillar,
  synthesizeClientRateSeries,
  type FrontierPoint,
  type FrontierResult,
} from "../../math/analytics/tractor";
import { runNMDBetaOnPaths, type NMDBetaScenarioOutput } from "../../math/instruments/nmdBeta";
import { projectHWToTenor } from "../../math/rates/simulateHw";

const NMD_B_TENOR_YEARS = 1 / 12;
const BGM_1M_TENOR_IDX = 1; // 1D=0, 1M=1 (1D added back to BGM saved tenors)

// Pillar universes (≤120M optimization cap — the 180M MA window is data-thin).
// Non-IB is fully non-repricing (β=0), so no overnight pillar; IB carries the
// overnight pillar for its β repricing slice.
const NONIB_PILLARS = [3, 12, 24, 60, 120] as const;
const IB_PILLARS = [1, 3, 12, 24, 60, 120] as const;

/** Non-IB blend WAL bound: the modeled liquidity WAL (~5y). Invest no longer
 *  than the deposits structurally stick. */
const NONIB_WAL_CAP_MONTHS = 60;
/** IB has no separate liquidity-WAL cap; the 120M pillar bounds WAL at 60.5m. */
const IB_WAL_CAP_MONTHS = pillarWalMonths(120);

const LADDER_KS = [3, 6, 12, 24, 60, 120, 180] as const;
/** Teaching-ladder x-axis lock (months): always show 1→180 so single-pillar
 *  amortizing profiles are directly comparable across the dropdown. */
const LADDER_X_MONTHS = 180;
/** Blended-runoff stock-view x-axis lock (months): 10Y, matching the 120M
 *  optimization cap so every optimized portfolio's runoff is comparable. */
const STOCK_X_MONTHS = 120;
const STOCK_X_TICKS = [0, 12, 24, 36, 48, 60, 72, 84, 96, 108, 120];

/** Pillar fill colors, shortest -> longest, for the stacked runoff bars. */
const PILLAR_COLORS = [
  COLORS.nodeTeal,
  COLORS.nodeGreen,
  COLORS.nodeOrange,
  COLORS.nodePurple,
  COLORS.bookSteel,
  COLORS.sand,
  COLORS.bookNavy,
] as const;

const LEGEND_STYLE = { fontSize: 12, fontFamily: "var(--font-sans)", color: "var(--obsidian)" };
function darkLegendFormatter(value: string) {
  return <span style={{ color: "var(--obsidian)", fontWeight: 500 }}>{value}</span>;
}

const fanTooltip = (v: unknown, name: string): [string, string] => {
  if (typeof v === "number" && Number.isFinite(v)) return [`${v.toFixed(3)}%`, name];
  if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number") {
    return [`${v[0].toFixed(3)}% – ${v[1].toFixed(3)}%`, name];
  }
  return ["—", name];
};

function fmtTenor(m: number): string {
  if (m <= 1) return "O/N";
  return m >= 12 && m % 12 === 0 ? `${m / 12}Y` : `${m}M`;
}

const fmtPct = (dec: number) => (Number.isFinite(dec) ? `${(dec * 100).toFixed(3)}%` : "n/a");
const fmtBp = (dec: number) => (Number.isFinite(dec) ? `${(dec * 1e4).toFixed(0)} bp` : "n/a");
const fmtW = (w: number) => `${(w * 100).toFixed(1)}%`;

function dot(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

const thStyle: React.CSSProperties = {
  textAlign: "right",
  padding: "6px 10px",
  borderBottom: `1px solid ${COLORS.sand}`,
  fontWeight: 600,
};
const tdStyle: React.CSSProperties = {
  textAlign: "right",
  padding: "5px 10px",
  borderBottom: "1px solid rgba(18,19,18,0.06)",
  fontVariantNumeric: "tabular-nums",
};

type CornerKey = "minVol" | "maxSharpe" | "maxRet" | "liqCapped";

/**
 * One stacked-runoff bar chart for a single RP solution: each pillar's
 * linear-amortizing ladder stacked by tenor (notional 100), the composite the
 * blended portfolio's expected amortization. X-axis locked to 10Y so every
 * optimized portfolio is comparable. Pure presentation off `stackedLadderByPillar`.
 */
function StackedLadderCard({
  pillars,
  weights,
  walMonths,
  feasible,
}: {
  pillars: ReadonlyArray<number>;
  weights: ReadonlyArray<number>;
  walMonths: number;
  feasible: boolean;
}) {
  const labels = pillars.map((k) => fmtTenor(k));
  const data = useMemo(() => {
    if (!feasible || weights.some((w) => !Number.isFinite(w))) return [];
    return stackedLadderByPillar(pillars, weights, 100).map((r) => {
      const o: Record<string, number> = { month: r.month };
      r.byPillar.forEach((b, i) => {
        o[fmtTenor(pillars[i])] = b;
      });
      return o;
    });
  }, [pillars, weights, feasible]);

  if (data.length === 0) {
    return (
      <div className="banner-illustrative">
        <span>Solution infeasible at the current settings.</span>
      </div>
    );
  }
  return (
    <>
      <div style={{ height: 280 }}>
        <ChartErrorBoundary label="rp-stock-runoff">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 24, bottom: 16, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
              <XAxis
                dataKey="month"
                type="number"
                domain={[0, STOCK_X_MONTHS]}
                ticks={STOCK_X_TICKS}
                allowDataOverflow
                stroke={COLORS.obsidian}
                style={{ fontSize: 12 }}
                tickFormatter={(v: number) => `${Math.round(v / 12)}y`}
                label={{ value: "year", position: "insideBottom", offset: -8, fontSize: 12 }}
              />
              <YAxis
                domain={[0, 100]}
                stroke={COLORS.obsidian}
                style={{ fontSize: 12 }}
                tickFormatter={(v: number) => `${v.toFixed(0)}%`}
              />
              <Tooltip
                formatter={(v: number, n: string) => [`${v.toFixed(2)}% of notional`, n]}
                labelFormatter={(v: number) => `month ${v}`}
              />
              <Legend verticalAlign="top" height={24} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
              {labels.map((lab, i) => (
                <Area
                  key={lab}
                  dataKey={lab}
                  stackId="rp"
                  stroke={PILLAR_COLORS[i % PILLAR_COLORS.length]}
                  fill={PILLAR_COLORS[i % PILLAR_COLORS.length]}
                  fillOpacity={0.75}
                  strokeWidth={0.5}
                  isAnimationActive={false}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </ChartErrorBoundary>
      </div>
      <p className="form-helper" style={{ marginTop: 8 }}>
        Stock view — the portfolio&apos;s expected monthly amortization (drives the IR repricing gap
        and EVE). Blended WAL {walMonths.toFixed(1)} months ({(walMonths / 12).toFixed(2)}y); bars
        stack shortest to longest pillar.
      </p>
    </>
  );
}

/**
 * Flow view: the steady-state new-money mix. Each month 1/k of pillar k matures
 * and reinvests, so the bullet ladder share at tenor k is (w_k/k)/Σ(w_j/j) —
 * what new money actually buys. Shorter pillars draw more because they turn
 * over faster.
 */
function FlowLadderCard({
  pillars,
  weights,
  feasible,
}: {
  pillars: ReadonlyArray<number>;
  weights: ReadonlyArray<number>;
  feasible: boolean;
}) {
  const data = useMemo(() => {
    if (!feasible || weights.some((w) => !Number.isFinite(w))) return [];
    return newMoneyFlowLadder(pillars, weights).map((r) => ({
      tenor: fmtTenor(r.tenorMonths),
      share: r.share * 100,
    }));
  }, [pillars, weights, feasible]);

  if (data.length === 0) {
    return (
      <div className="banner-illustrative">
        <span>Solution infeasible at the current settings.</span>
      </div>
    );
  }
  return (
    <>
      <div style={{ height: 280 }}>
        <ChartErrorBoundary label="rp-flow-ladder">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 24, bottom: 16, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
              <XAxis
                dataKey="tenor"
                stroke={COLORS.obsidian}
                style={{ fontSize: 12 }}
                label={{ value: "bullet tenor", position: "insideBottom", offset: -8, fontSize: 12 }}
              />
              <YAxis
                stroke={COLORS.obsidian}
                style={{ fontSize: 12 }}
                tickFormatter={(v: number) => `${v.toFixed(0)}%`}
              />
              <Tooltip formatter={(v: number) => [`${v.toFixed(1)}% of new money`, "share"]} />
              <Bar dataKey="share" fill={SERIES.sabr} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartErrorBoundary>
      </div>
      <p className="form-helper" style={{ marginTop: 8 }}>
        Flow view — the steady-state new-money allocation: what each month&apos;s reinvestment buys
        as bullet fixed income. Shorter tenors take a larger share because they roll over faster.
      </p>
    </>
  );
}

const CORNER_ORDER: ReadonlyArray<{ key: CornerKey; defLabel: string }> = [
  { key: "minVol", defLabel: "Min-vol" },
  { key: "maxSharpe", defLabel: "Max-Sharpe ★" },
  { key: "maxRet", defLabel: "Max-yield" },
  { key: "liqCapped", defLabel: "Liquidity-capped" },
];

/**
 * Frontier panel: a mean-variance scatter (cloud + four curated corners) with
 * selectable corner cards that drive the stock-view runoff and flow-view bullet
 * ladder below. Parameterized for the yield space (Non-IB) and the margin space
 * (IB); the optional regression point is the IB tracking portfolio.
 */
function FrontierPanel({
  pillars,
  frontier,
  selected,
  onSelect,
  yUnit,
  yLabel,
  maxRetLabel,
  regression,
  historical,
}: {
  pillars: ReadonlyArray<number>;
  frontier: FrontierResult;
  selected: CornerKey;
  onSelect: (k: CornerKey) => void;
  yUnit: "pct" | "bp";
  yLabel: string;
  maxRetLabel: string;
  regression?: { point: FrontierPoint; label: string } | null;
  historical: { history: RateHistory; asOfIdx: number; clientRate: number[] | null; title: string; note: string };
}) {
  const toY = (ret: number) => (yUnit === "pct" ? ret * 100 : ret * 1e4);
  const fmtRet = (ret: number) => (yUnit === "pct" ? fmtPct(ret) : fmtBp(ret));
  const cloudData = frontier.cloud.map((p) => ({ x: p.vol * 1e4, y: toY(p.ret) }));
  const cornerPt = (k: CornerKey) => frontier[k];
  const cornerData = (k: CornerKey) => {
    const p = cornerPt(k);
    return [{ x: p.vol * 1e4, y: toY(p.ret) }];
  };
  const cornerColor: Record<CornerKey, string> = {
    minVol: SERIES.bgm,
    maxSharpe: SERIES.hw,
    maxRet: SERIES.sabr,
    liqCapped: COLORS.nodeGreen,
  };
  const sel = cornerPt(selected);

  const perf = historicalRpPerformance(
    historical.history,
    pillars,
    sel.weights,
    historical.asOfIdx,
    historical.clientRate,
  );
  const perfData = perf.months.map((m, i) => ({ month: m, val: perf.series[i] * 100 }));

  return (
    <>
      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="group-label">Efficient frontier — sample portfolios over the 5Y forecast</div>
        <p className="form-helper" style={{ marginBottom: 8 }}>
          Each grey dot is a feasible blend (weights ≥ 0, sum 100%, WAL within the cap), scored on
          the simulated paths. {yLabel} on the vertical axis, yield volatility (bp) on the
          horizontal. The starred max-Sharpe blend is the best risk-adjusted point.
        </p>
        <div style={{ height: 320 }}>
          <ChartErrorBoundary label="rp-frontier">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 16, right: 24, bottom: 24, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name="vol"
                  stroke={COLORS.obsidian}
                  tick={{ fontSize: 12, fill: COLORS.obsidian }}
                  tickFormatter={(v: number) => `${v.toFixed(0)}`}
                  label={{ value: "yield volatility (bp)", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name="ret"
                  stroke={COLORS.obsidian}
                  tick={{ fontSize: 12, fill: COLORS.obsidian }}
                  tickFormatter={(v: number) => (yUnit === "pct" ? `${v.toFixed(2)}%` : `${v.toFixed(0)}`)}
                  label={{ value: yLabel, angle: -90, position: "insideLeft", style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                />
                <ZAxis range={[40, 40]} />
                <Tooltip
                  cursor={{ strokeDasharray: "3 3" }}
                  formatter={(v: number, n: string) => [
                    n === "ret" ? (yUnit === "pct" ? `${v.toFixed(3)}%` : `${v.toFixed(0)} bp`) : `${v.toFixed(1)} bp`,
                    n === "ret" ? "return" : "vol",
                  ]}
                />
                <Legend verticalAlign="top" height={24} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
                <Scatter name="Sample blends" data={cloudData} fill={COLORS.sand} fillOpacity={0.55} />
                {regression && (
                  <Scatter
                    name={regression.label}
                    data={[{ x: regression.point.vol * 1e4, y: toY(regression.point.ret) }]}
                    fill={COLORS.obsidian}
                    shape="cross"
                  />
                )}
                <Scatter name="Min-vol" data={cornerData("minVol")} fill={cornerColor.minVol} />
                <Scatter name="Max-Sharpe ★" data={cornerData("maxSharpe")} fill={cornerColor.maxSharpe} shape="star" />
                <Scatter name={maxRetLabel} data={cornerData("maxRet")} fill={cornerColor.maxRet} />
                <Scatter name="Liquidity-capped" data={cornerData("liqCapped")} fill={cornerColor.liqCapped} />
              </ScatterChart>
            </ResponsiveContainer>
          </ChartErrorBoundary>
        </div>
      </div>

      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="group-label">Sample portfolios — pick one to drive the runoff charts</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 8 }}>
          {CORNER_ORDER.map(({ key, defLabel }) => {
            const p = cornerPt(key);
            const label = key === "maxRet" ? maxRetLabel : defLabel;
            const active = key === selected;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onSelect(key)}
                style={{
                  textAlign: "left",
                  cursor: "pointer",
                  borderRadius: 6,
                  padding: "12px 14px",
                  background: active ? "rgba(18,19,18,0.04)" : "transparent",
                  border: `2px solid ${active ? cornerColor[key] : "rgba(18,19,18,0.12)"}`,
                  fontFamily: "var(--font-sans)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: cornerColor[key], display: "inline-block" }} />
                  <span style={{ fontWeight: 600, color: COLORS.obsidian }}>{label}</span>
                </div>
                <div style={{ fontSize: 12, color: "rgba(18,19,18,0.7)", fontVariantNumeric: "tabular-nums" }}>
                  <div>{yUnit === "pct" ? "Yield" : "Margin"} {fmtRet(p.ret)}</div>
                  <div>Vol {(p.vol * 1e4).toFixed(0)} bp · Sharpe {p.sharpe.toFixed(2)}</div>
                  <div>WAL {p.walMonths.toFixed(1)}m ({(p.walMonths / 12).toFixed(2)}y)</div>
                </div>
                <div style={{ fontSize: 11, color: "rgba(18,19,18,0.55)", marginTop: 6 }}>
                  {pillars.map((k, i) => (p.weights[i] > 0.005 ? `${fmtTenor(k)} ${fmtW(p.weights[i])}` : null))
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="group-label">Stock view (balance runoff) vs flow view (new-money ladder)</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, marginTop: 8 }}>
          <div>
            <StackedLadderCard pillars={pillars} weights={sel.weights} walMonths={sel.walMonths} feasible={frontier.feasible} />
          </div>
          <div>
            <FlowLadderCard pillars={pillars} weights={sel.weights} feasible={frontier.feasible} />
          </div>
        </div>
      </div>

      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="group-label">{historical.title}</div>
        <p className="form-helper" style={{ marginBottom: 8 }}>
          Backtest of the selected fixed-weight portfolio on the real rate history: the realized
          franchise margin (RP credit {historical.clientRate ? "− client rate" : "; client rate is 0 so the margin equals the RP yield"}),
          month by month. {historical.note}
        </p>
        <div className="kvp-row">
          <span className="kvp-key">Realized mean</span>
          <span className="kvp-value">{fmtPct(perf.meanDec)}</span>
        </div>
        <div className="kvp-row">
          <span className="kvp-key">Realized volatility (annualized, monthly changes)</span>
          <span className="kvp-value">{Number.isFinite(perf.volBp) ? `${perf.volBp.toFixed(1)} bp` : "n/a"}</span>
        </div>
        <div className="kvp-row">
          <span className="kvp-key">Window</span>
          <span className="kvp-value">
            {perf.months[0]} to {perf.months[perf.nObs - 1]} ({perf.nObs} months)
          </span>
        </div>
        <div style={{ height: 300, marginTop: 12 }}>
          <ChartErrorBoundary label="rp-historical">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={perfData} margin={{ top: 16, right: 24, bottom: 16, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
                <XAxis
                  dataKey="month"
                  stroke={COLORS.obsidian}
                  style={{ fontSize: 11 }}
                  interval={Math.max(0, Math.floor(perfData.length / 12))}
                  label={{ value: "month", position: "insideBottom", offset: -8, fontSize: 12 }}
                />
                <YAxis
                  stroke={COLORS.obsidian}
                  style={{ fontSize: 12 }}
                  tickFormatter={(v: number) => `${v.toFixed(2)}%`}
                  label={{ value: "realized margin (% pa)", angle: -90, position: "insideLeft", style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                />
                <Tooltip formatter={(v: number) => [`${v.toFixed(3)}%`, "margin"]} />
                <ReferenceLine
                  y={perf.meanDec * 100}
                  stroke={SERIES.hw}
                  strokeDasharray="6 3"
                  strokeWidth={1.5}
                  label={{ value: `mean ${(perf.meanDec * 100).toFixed(2)}%`, fill: SERIES.hw, fontSize: 12, position: "right" }}
                />
                {historical.clientRate && (
                  <ReferenceLine y={0} stroke={COLORS.obsidian} strokeOpacity={0.4} strokeDasharray="4 4" />
                )}
                <Line dataKey="val" stroke={SERIES.bgm} strokeWidth={2} dot={false} isAnimationActive={false} name="Realized margin" />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartErrorBoundary>
        </div>
      </div>
    </>
  );
}

/**
 * Deposit-tractor replicating portfolio. The NMD balance is decomposed into
 * stable/non-stable and repricing/non-repricing slices; the core (stable,
 * non-repricing) franchise is replicated by a blend of moving-average pillars.
 * Both books are optimized over the 5Y simulated forecast: Non-IB maximizes
 * yield per unit yield-volatility under a liquidity-WAL cap (efficient
 * frontier, max-Sharpe), IB minimizes the franchise-margin volatility tracking
 * the client rate (margin-space frontier + NNLS regression). Selecting a sample
 * portfolio drives the stock-view runoff and the flow-view new-money ladder.
 */
export function ReplicatingPortfolioTab() {
  const { snapshot, curve, hwSim, bgmSim } = useApp();
  const { nmdBeta } = useInstruments();

  const [history, setHistory] = useState<RateHistory | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const [ladderK, setLadderK] = useState<number>(60);
  const [nonIbSel, setNonIbSel] = useState<CornerKey>("maxSharpe");
  const [ibSel, setIbSel] = useState<CornerKey>("maxSharpe");

  // Stochastic client-rate / margin projection (HW + BGM 1M paths through the
  // live NMD-B S-curve), separate from the frontier (which needs only HW).
  const [simResults, setSimResults] = useState<{
    base: NMDBetaScenarioOutput;
    hw: NMDBetaScenarioOutput;
    bgm: NMDBetaScenarioOutput;
  } | null>(null);
  const [simRunning, setSimRunning] = useState(false);
  const [simStale, setSimStale] = useState(true);
  useEffect(() => {
    setSimStale(true);
  }, [hwSim, bgmSim, nmdBeta]);
  const simReady = Boolean(hwSim && bgmSim && curve);

  const runProjection = async () => {
    if (!hwSim || !bgmSim || !curve) return;
    setSimRunning(true);
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
      setSimResults({
        base: runNMDBetaOnPaths([basePath], nmdBeta),
        hw: runNMDBetaOnPaths(hwPaths, nmdBeta),
        bgm: runNMDBetaOnPaths(bgmPaths, nmdBeta),
      });
      setSimStale(false);
    } finally {
      setSimRunning(false);
    }
  };

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    loadRateHistoryOnce(import.meta.env.BASE_URL)
      .then((h) => {
        if (alive) setHistory(h);
      })
      .catch((err) => {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [retryToken]);

  // As-of month: snapshot calibration date, falling back to the latest observation.
  const asOf = useMemo(() => {
    if (!history) return null;
    const calIso = snapshot ? snapshot.calibrationDate.slice(0, 7) : null;
    let idx = calIso ? history.indexOfMonth(calIso) : -1;
    const isCalibration = idx !== -1;
    if (idx === -1) idx = history.months.length - 1;
    return { idx, month: history.months[idx], isCalibration };
  }, [history, snapshot]);

  // Pillar yields table (new-money vs steady-state, carry lag).
  const pillarRows = useMemo(() => {
    if (!history || !asOf || !snapshot) return null;
    return [1, 3, 6, 12, 24, 60, 120, 180].map((k) => {
      const nm = newMoneyYield(k, snapshot.curveQuotes);
      const ss = k <= 1 ? nm : history.pillarYield(asOf.idx, k);
      return {
        k,
        walMonths: pillarWalMonths(k),
        newMoney: nm,
        steady: ss,
        lagBp: Number.isFinite(ss) ? (ss - nm) * 1e4 : NaN,
      };
    });
  }, [history, asOf, snapshot]);

  // Teaching ladder: one pillar's amortizing stock, x-axis locked to 180m.
  const ladder = useMemo(() => {
    const cf = pillarLadderCashflows(ladderK, 100);
    const data: Array<{ m: number; balance: number }> = [];
    for (let m = 1; m <= LADDER_X_MONTHS; m++) {
      data.push({ m, balance: m <= cf.length ? cf[m - 1].balance : 0 });
    }
    return { data, walMonths: pillarWalMonths(ladderK) };
  }, [ladderK]);

  // Simulated-path frontiers for both books (needs only the HW simulation).
  const frontiers = useMemo(() => {
    if (!history || !asOf || !snapshot || !hwSim || !curve) return null;
    try {
      const horizon = FORECAST_HORIZON_MONTHS;
      const union = [1, 3, 12, 24, 60, 120];
      const py = simulatedPillarYieldSamples(history, union, hwSim, curve, asOf.idx, horizon);
      const muU = sampleMean(py.samples);
      const covU = sampleCovariance(py.samples);
      const idxOf = (k: number) => union.indexOf(k);

      // Non-IB: yield-space frontier. rf = the forecast-mean overnight yield
      // (the rolled-O/N alternative over the SAME horizon) — consistent with
      // the forecast-mean returns, so Sharpe is a term-premium-per-risk measure.
      // Using the spot O/N quote here would mismatch spot vs forecast and push
      // every Sharpe negative under mean reversion.
      const nibIdx = NONIB_PILLARS.map(idxOf);
      const nibMu = nibIdx.map((i) => muU[i]);
      const nibCov = nibIdx.map((i) => nibIdx.map((j) => covU[i][j]));
      const rf = muU[idxOf(1)];
      const nibFrontier = buildFrontier(NONIB_PILLARS, nibMu, nibCov, NONIB_WAL_CAP_MONTHS, rf, {
        seed: 0xa11ce,
      });

      // IB: margin-space frontier + NNLS tracking portfolio.
      const ibIdx = IB_PILLARS.map(idxOf);
      const ibMu = ibIdx.map((i) => muU[i]);
      const ibCov = ibIdx.map((i) => ibIdx.map((j) => covU[i][j]));
      const ibYsamples = ibIdx.map((i) => py.samples[i]);
      const dSamples = simulatedClientRateSamples(history, hwSim, curve, nmdBeta.sCurve, asOf.idx, horizon);
      const joint = sampleCovariance([...ibYsamples, dSamples]);
      const covYD = ibIdx.map((_, i) => joint[i][ibYsamples.length]);
      const varD = joint[ibYsamples.length][ibYsamples.length];
      const muD = sampleMean([dSamples])[0];
      const ibFrontier = buildMarginFrontier(IB_PILLARS, ibMu, ibCov, covYD, varD, muD, IB_WAL_CAP_MONTHS, {
        seed: 0x1b2c3,
      });
      const ibReg = regressOnSamples(ibYsamples, dSamples);
      // The regression portfolio as a margin-space point (mean margin / vol).
      let regRet = -muD;
      let regVar = varD;
      for (let i = 0; i < IB_PILLARS.length; i++) {
        regRet += ibReg.weights[i] * ibMu[i];
        regVar -= 2 * ibReg.weights[i] * covYD[i];
        for (let j = 0; j < IB_PILLARS.length; j++) regVar += ibReg.weights[i] * ibCov[i][j] * ibReg.weights[j];
      }
      const regVol = Math.sqrt(Math.max(0, regVar));
      const ibRegPoint: FrontierPoint = {
        weights: ibReg.weights,
        ret: regRet,
        vol: regVol,
        walMonths: blendWalMonths(IB_PILLARS, ibReg.weights),
        sharpe: regVol > 0 ? regRet / regVol : 0,
      };
      return { nibFrontier, ibFrontier, ibReg, ibRegPoint, ibMu, nSamples: py.nSamples };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, [history, asOf, snapshot, hwSim, curve, nmdBeta.sCurve]);

  // Synthesized client-rate history for the IB backtest (β S-curve on the
  // historical overnight SOFR), shared by the historical-performance card.
  const ibClientRate = useMemo(
    () => (history ? synthesizeClientRateSeries(history, nmdBeta.sCurve) : null),
    [history, nmdBeta.sCurve],
  );

  const ibCreditPct = useMemo(() => {
    if (!frontiers || "error" in frontiers) return null;
    const sel = frontiers.ibFrontier[ibSel];
    return dot(sel.weights, frontiers.ibMu) * 100;
  }, [frontiers, ibSel]);

  // Stochastic fan: client rate and franchise margin off the projection.
  const simFan = useMemo(() => {
    if (!simResults || ibCreditPct === null) return null;
    const creditPct = ibCreditPct;
    const n = simResults.hw.depositRateMean.length;
    type RatePt = {
      month: number;
      depBase: number;
      depHW: number;
      depHWBand: [number, number];
      depBGM: number;
      depBGMBand: [number, number];
    };
    type MarPt = {
      month: number;
      marBase: number;
      marHW: number;
      marHWBand: [number, number];
      marBGM: number;
      marBGMBand: [number, number];
    };
    const rate: RatePt[] = [];
    const margin: MarPt[] = [];
    for (let i = 0; i < n; i++) {
      const m = i + 1;
      const dB = simResults.base.depositRateMean[i];
      const dH = simResults.hw.depositRateMean[i];
      const dG = simResults.bgm.depositRateMean[i];
      const hLo = simResults.hw.depositRateP5[i];
      const hHi = simResults.hw.depositRateP95[i];
      const gLo = simResults.bgm.depositRateP5[i];
      const gHi = simResults.bgm.depositRateP95[i];
      rate.push({ month: m, depBase: dB, depHW: dH, depHWBand: [hLo, hHi], depBGM: dG, depBGMBand: [gLo, gHi] });
      margin.push({
        month: m,
        marBase: creditPct - dB,
        marHW: creditPct - dH,
        marHWBand: [creditPct - hHi, creditPct - hLo],
        marBGM: creditPct - dG,
        marBGMBand: [creditPct - gHi, creditPct - gLo],
      });
    }
    return { creditPct, rate, margin };
  }, [simResults, ibCreditPct]);

  if (loadError) {
    return (
      <div>
        <h1 className="section-title">Replicating portfolio</h1>
        <div className="banner-illustrative">
          <span>Failed to load the rate history dataset: {loadError}</span>
          <button type="button" className="btn btn-ghost" style={{ marginLeft: 12 }} onClick={() => setRetryToken((t) => t + 1)}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!history || !asOf || !snapshot || !pillarRows) {
    return (
      <div>
        <h1 className="section-title">Replicating portfolio</h1>
        <p className="section-subtitle">
          {!snapshot && history ? "Waiting for the market snapshot (Import tab)…" : "Loading the historical rate dataset…"}
        </p>
      </div>
    );
  }

  const frontierError = frontiers && "error" in frontiers ? frontiers.error : null;
  const ready = frontiers && !("error" in frontiers) ? frontiers : null;

  return (
    <div>
      <h1 className="section-title">Replicating portfolio</h1>
      <p className="section-subtitle">
        The deposit tractor: the core NMD balance as a ladder of moving-average pillars. A k-month
        pillar is k equal rolling bullets in the k-month tenor — a linear-amortizing runoff with
        WAL = (k+1)/2 months earning the trailing k-month average of the k-month rate. New-money
        yields come from the {snapshot.calibrationDate} curve; the frontier is optimized over the
        first {FORECAST_HORIZON_MONTHS / 12} years of the Hull-White simulated paths.
      </p>

      {/* NMD decomposition flowchart */}
      <div className="dash-card">
        <div className="group-label">From NMD balance to replicating pillars</div>
        <p className="form-helper" style={{ marginBottom: 12 }}>
          The total balance splits into stable vs non-stable, then each into a repricing (β) slice
          and a non-repricing (1 − β) slice. The stable non-repricing slice is the core franchise —
          invested long, up to the liquidity-WAL cap. The repricing slice (stable or not) follows
          the IB-NMD repricing function: overnight if indexed to the overnight rate, longer tenors
          if blended. The non-stable non-repricing slice could go slightly longer, but for
          conservatism sits at overnight.
        </p>
        <img
          src={`${import.meta.env.BASE_URL}rp_nmd_decomposition.svg`}
          alt="NMD balance decomposition into stable/non-stable, repricing/non-repricing, and replicating tenors"
          style={{ width: "100%", maxWidth: 720, display: "block", margin: "0 auto" }}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      </div>

      {/* Pillar yields table */}
      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="group-label">Pillar yields</div>
        <p className="form-helper" style={{ marginBottom: 8 }}>
          New-money is today&apos;s curve par rate at the pillar tenor; steady-state is the trailing
          k-month MA of the k-month tenor (a book that has been rolling). The carry lag between them
          is why the tractor credit is sticky. The 180M pillar is shown for reference only — the
          optimization caps at 120M, where the moving-average window has enough history.
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, textAlign: "left" }}>Pillar</th>
              <th style={thStyle}>WAL</th>
              <th style={thStyle}>New-money</th>
              <th style={thStyle}>Steady-state</th>
              <th style={thStyle}>Carry lag</th>
            </tr>
          </thead>
          <tbody>
            {pillarRows.map((r) => (
              <tr key={r.k}>
                <td style={{ ...tdStyle, textAlign: "left" }}>
                  {r.k <= 1 ? "Overnight" : `${fmtTenor(r.k)} MA of ${fmtTenor(r.k)}`}
                  {r.k === 180 ? " (display only)" : ""}
                </td>
                <td style={tdStyle}>
                  {r.walMonths.toFixed(1)}m ({(r.walMonths / 12).toFixed(2)}y)
                </td>
                <td style={tdStyle}>{fmtPct(r.newMoney)}</td>
                <td style={tdStyle}>{Number.isFinite(r.steady) ? fmtPct(r.steady) : "window incomplete"}</td>
                <td style={tdStyle}>{Number.isFinite(r.lagBp) ? `${r.lagBp.toFixed(1)} bp` : "n/a"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Teaching ladder — immediately below the yields, x-axis locked at 180m */}
      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="group-label">Pillar ladder runoff (stock view)</div>
        <p className="form-helper" style={{ marginBottom: 12 }}>
          The steady-state stock of a k-month pillar: k equal tranches with remaining lives 1 to k
          months, a linear-amortizing runoff. The x-axis is locked at 180 months so profiles are
          comparable across the dropdown; the dashed marker is the WAL midpoint.
        </p>
        <div className="form-row" style={{ marginBottom: 12 }}>
          <span className="form-label" style={{ minWidth: 0 }}>
            Pillar k
          </span>
          <select className="form-input" value={ladderK} onChange={(e) => setLadderK(parseInt(e.target.value, 10))}>
            {LADDER_KS.map((k) => (
              <option key={k} value={k}>
                {fmtTenor(k)} MA of {fmtTenor(k)}
              </option>
            ))}
          </select>
          <span className="form-helper" style={{ marginLeft: 12 }}>
            WAL {ladder.walMonths.toFixed(1)}m ({(ladder.walMonths / 12).toFixed(2)}y)
          </span>
        </div>
        <div style={{ height: 300 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={ladder.data} margin={{ top: 16, right: 24, bottom: 16, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
              <XAxis
                dataKey="m"
                stroke={COLORS.obsidian}
                style={{ fontSize: 12 }}
                label={{ value: "month", position: "insideBottom", offset: -8, fontSize: 12 }}
                interval={Math.max(0, Math.floor(LADDER_X_MONTHS / 24) - 1)}
              />
              <YAxis stroke={COLORS.obsidian} style={{ fontSize: 12 }} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
              <Tooltip formatter={(v: number) => `${v.toFixed(1)}% of notional`} labelFormatter={(v: number) => `month ${v}`} />
              <Bar dataKey="balance" fill={SERIES.bgm} isAnimationActive={false} />
              <ReferenceLine
                x={Math.ceil(ladder.walMonths)}
                position={Number.isInteger(ladder.walMonths) ? "middle" : "start"}
                stroke={SERIES.hw}
                strokeWidth={2.5}
                strokeDasharray="6 3"
                label={{ value: `WAL ${ladder.walMonths.toFixed(1)}m`, fill: SERIES.hw, fontSize: 16, fontWeight: 700, position: "top" }}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ============================ NON-IB NMD ============================ */}
      <h2 className="section-title" style={{ marginTop: 36, fontSize: 22 }}>
        Non-interest-bearing NMD — structural IRR
      </h2>
      <p className="section-subtitle">
        With no client rate, the whole portfolio yield is structural interest-rate risk. The
        replicating blend is capped at the book&apos;s modeled liquidity WAL (≈{" "}
        {(NONIB_WAL_CAP_MONTHS / 12).toFixed(0)}y): invest no longer than the deposits structurally
        stick. Across the simulated paths we solve for the pillar weights (≥ 0, summing to 100%)
        that maximize the average yield for the lowest yield variance — an efficient frontier built
        from the simulated lagged moving averages of each pillar rather than from thin history.
      </p>

      {frontierError ? (
        <div className="banner-illustrative">
          <span>Frontier unavailable: {frontierError}</span>
        </div>
      ) : !hwSim ? (
        <div className="banner-illustrative">
          <span>Run a Hull-White simulation first (HW Sim tab) to build the simulated-path frontier.</span>
        </div>
      ) : ready ? (
        <FrontierPanel
          pillars={NONIB_PILLARS}
          frontier={ready.nibFrontier}
          selected={nonIbSel}
          onSelect={setNonIbSel}
          yUnit="pct"
          yLabel="mean yield (% pa)"
          maxRetLabel="Max-yield"
          historical={{
            history,
            asOfIdx: asOf.idx,
            clientRate: null,
            title: "Historical realized performance (yield = margin)",
            note: "With no client rate the whole RP yield is franchise margin / structural IRR.",
          }}
        />
      ) : null}

      {/* ============================== IB NMD ============================== */}
      <h2 className="section-title" style={{ marginTop: 36, fontSize: 22 }}>
        Interest-bearing NMD — tracking the client rate
      </h2>
      <p className="section-subtitle">
        The deposit rate D(t) = β(r)·r tracks the market through the live S-curve. The replicating
        portfolio tracks that client rate: across the simulated paths we regress D(t) on the pillar
        yields (weights ≥ 0, summing to 100% — the β allocation) and trace the margin-space frontier
        (RP credit − client rate). The optimal blend maximizes mean franchise margin per unit of
        margin volatility over the {FORECAST_HORIZON_MONTHS / 12}-year forecast.
      </p>

      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="form-row" style={{ alignItems: "center", gap: 12 }}>
          <button type="button" className="btn btn-filled" onClick={() => void runProjection()} disabled={!simReady || simRunning}>
            {simRunning ? "Running…" : simResults ? "Re-run projection" : "Run stochastic projection →"}
          </button>
          {!simReady && (
            <span className="form-helper" style={{ fontStyle: "italic" }}>
              Run a Hull-White and a BGM simulation first (HW Sim / BGM Sim tabs).
            </span>
          )}
          {simReady && simStale && simResults && (
            <span className="form-helper" style={{ fontStyle: "italic" }}>
              Inputs changed — re-run to refresh.
            </span>
          )}
        </div>
      </div>

      {simFan && (
        <>
          <div className="dash-card" style={{ marginTop: 16 }}>
            <div className="group-label">Client-rate fan D(t) vs RP credit (% per annum)</div>
            <p className="form-helper" style={{ marginBottom: 8 }}>
              The RP credit line is the selected IB portfolio&apos;s mean simulated yield
              ({simFan.creditPct.toFixed(3)}%). Pick a different sample portfolio below to move it.
            </p>
            <div style={{ height: 360 }}>
              <ChartErrorBoundary label="rp-clientrate-fan">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={simFan.rate} margin={{ top: 24, right: 24, bottom: 24, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
                    <XAxis
                      dataKey="month"
                      type="number"
                      domain={[0, 360]}
                      ticks={[0, 60, 120, 180, 240, 300, 360]}
                      tickFormatter={(v: number) => `${(v / 12).toFixed(0)}y`}
                      stroke={COLORS.obsidian}
                      tick={{ fontSize: 12, fill: COLORS.obsidian }}
                      label={{ value: "Months from sim start", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                    />
                    <YAxis stroke={COLORS.obsidian} tick={{ fontSize: 12, fill: COLORS.obsidian }} tickFormatter={(v: number) => `${v.toFixed(2)}%`} />
                    <Tooltip formatter={fanTooltip} labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")} />
                    <Area dataKey="depHWBand" fill={SERIES.hwBandFill} stroke={SERIES.hw} strokeOpacity={0.45} strokeWidth={1} isAnimationActive={false} name="HW p5–p95" />
                    <Area dataKey="depBGMBand" fill={SERIES.bgmBandFill} stroke={SERIES.bgm} strokeOpacity={0.45} strokeWidth={1} isAnimationActive={false} name="BGM p5–p95" />
                    <Line dataKey="depBase" stroke={SERIES.deterministic} strokeWidth={1.5} dot={false} isAnimationActive={false} name="Base (deterministic)" />
                    <Line dataKey="depHW" stroke={SERIES.hw} strokeWidth={2} dot={false} isAnimationActive={false} name="HW mean" />
                    <Line dataKey="depBGM" stroke={SERIES.bgm} strokeWidth={2} dot={false} isAnimationActive={false} name="BGM mean" />
                    <ReferenceLine y={simFan.creditPct} stroke={SERIES.sabr} strokeDasharray="6 3" strokeWidth={1.5} label={{ value: "RP credit", fill: SERIES.sabr, fontSize: 12, position: "right" }} />
                    <Legend verticalAlign="top" height={28} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
                  </ComposedChart>
                </ResponsiveContainer>
              </ChartErrorBoundary>
            </div>
          </div>

          <div className="dash-card" style={{ marginTop: 16 }}>
            <div className="group-label">Franchise margin fan: RP credit − client rate (% per annum)</div>
            <div style={{ height: 360 }}>
              <ChartErrorBoundary label="rp-margin-fan">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={simFan.margin} margin={{ top: 24, right: 24, bottom: 24, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
                    <XAxis
                      dataKey="month"
                      type="number"
                      domain={[0, 360]}
                      ticks={[0, 60, 120, 180, 240, 300, 360]}
                      tickFormatter={(v: number) => `${(v / 12).toFixed(0)}y`}
                      stroke={COLORS.obsidian}
                      tick={{ fontSize: 12, fill: COLORS.obsidian }}
                      label={{ value: "Months from sim start", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
                    />
                    <YAxis stroke={COLORS.obsidian} tick={{ fontSize: 12, fill: COLORS.obsidian }} tickFormatter={(v: number) => `${v.toFixed(2)}%`} />
                    <Tooltip formatter={fanTooltip} labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")} />
                    <Area dataKey="marHWBand" fill={SERIES.hwBandFill} stroke={SERIES.hw} strokeOpacity={0.45} strokeWidth={1} isAnimationActive={false} name="HW p5–p95" />
                    <Area dataKey="marBGMBand" fill={SERIES.bgmBandFill} stroke={SERIES.bgm} strokeOpacity={0.45} strokeWidth={1} isAnimationActive={false} name="BGM p5–p95" />
                    <Line dataKey="marBase" stroke={SERIES.deterministic} strokeWidth={1.5} dot={false} isAnimationActive={false} name="Base margin" />
                    <Line dataKey="marHW" stroke={SERIES.hw} strokeWidth={2} dot={false} isAnimationActive={false} name="HW mean" />
                    <Line dataKey="marBGM" stroke={SERIES.bgm} strokeWidth={2} dot={false} isAnimationActive={false} name="BGM mean" />
                    <ReferenceLine y={0} stroke={COLORS.obsidian} strokeOpacity={0.4} strokeDasharray="4 4" />
                    <Legend verticalAlign="top" height={28} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
                  </ComposedChart>
                </ResponsiveContainer>
              </ChartErrorBoundary>
            </div>
          </div>
        </>
      )}

      {!hwSim ? (
        <div className="banner-illustrative" style={{ marginTop: 16 }}>
          <span>Run a Hull-White simulation to build the IB margin-space frontier.</span>
        </div>
      ) : ready ? (
        <>
          <div className="dash-card" style={{ marginTop: 16 }}>
            <div className="group-label">Client-rate regression on the simulated paths (Σβ = 100%)</div>
            <p className="form-helper" style={{ marginBottom: 8 }}>
              The nonnegative pillar weights that best track the simulated client rate, summing to
              100%. The overnight weight estimates the effective β; the complement lands on the
              smoother long pillars as the quasi-fixed slice.
            </p>
            {ready.ibReg.feasible ? (
              <>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr>
                      {IB_PILLARS.map((k) => (
                        <th key={k} style={thStyle}>
                          {fmtTenor(k)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      {ready.ibReg.weights.map((w, i) => (
                        <td key={IB_PILLARS[i]} style={tdStyle}>
                          {fmtW(w)}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
                <div className="kvp-row" style={{ marginTop: 8 }}>
                  <span className="kvp-key">Fit</span>
                  <span className="kvp-value">
                    R² {ready.ibReg.r2.toFixed(3)}, RMSE {ready.ibReg.rmseBp.toFixed(1)} bp ·{" "}
                    {ready.nSamples.toLocaleString()} path-months
                  </span>
                </div>
              </>
            ) : (
              <div className="banner-illustrative">
                <span>No feasible regression on these paths.</span>
              </div>
            )}
          </div>

          <FrontierPanel
            pillars={IB_PILLARS}
            frontier={ready.ibFrontier}
            selected={ibSel}
            onSelect={setIbSel}
            yUnit="bp"
            yLabel="mean franchise margin (bp)"
            maxRetLabel="Max-margin"
            regression={ready.ibReg.feasible ? { point: ready.ibRegPoint, label: "NNLS tracking" } : null}
            historical={{
              history,
              asOfIdx: asOf.idx,
              clientRate: ibClientRate,
              title: "Historical realized franchise margin",
              note: "Client rate is the β S-curve applied to the historical overnight SOFR.",
            }}
          />
        </>
      ) : null}
    </div>
  );
}
