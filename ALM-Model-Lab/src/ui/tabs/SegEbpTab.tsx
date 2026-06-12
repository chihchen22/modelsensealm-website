import { useMemo, useState } from "react";
import {
  Area,
  Bar,
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
import { FixedLoan } from "../../math/instruments/fixedLoan";
import { FloatingLoan } from "../../math/instruments/floatingLoan";
import { Mortgage } from "../../math/instruments/mortgage";
import { NMDeposit } from "../../math/instruments/nmd";
import { NMDBeta } from "../../math/instruments/nmdBeta";
import { DeterministicRatePath, type HWForwardBundle } from "../../math/rates/ratePath";
import { runSegOnInstrument, type SegOutput } from "../../math/analytics/seg";
import { buildSegInstrumentWorkbook, downloadXlsx } from "../../storage/segExport";
import type { Instrument, RatePath } from "../../math/instruments/types";

const BGM_1M_TENOR_IDX = 0;
const TENOR_1M_YEARS = 1 / 12;

const LEGEND_STYLE = {
  fontSize: 12,
  fontFamily: "var(--font-sans)",
  color: "var(--obsidian)",
};

function darkLegendFormatter(value: string) {
  return <span style={{ color: "var(--obsidian)", fontWeight: 500 }}>{value}</span>;
}

const formatDollarTick = (v: number): string => {
  const abs = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
};

const formatDollar = (v: number) =>
  `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

const tooltipDollar = (v: unknown, name: string) => {
  if (typeof v === "number" && Number.isFinite(v)) return [formatDollar(v), name];
  if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number") {
    return [`${formatDollar(v[0])} – ${formatDollar(v[1])}`, name];
  }
  return ["—", name];
};

type Engine = "hw" | "bgm";
type InstrumentKey = "fixed" | "floating" | "mortgage" | "nmd" | "nmdBeta";

interface PanelRow {
  t: number;
  ebpDet: number;
  ebpMcMean: number;
  ebpBand: [number, number];
  segDet: number;
  segMcMean: number;
  segBand: [number, number];
  segPeriodicDet: number;
  segPeriodicMean: number;
}

function buildRows(out: SegOutput, horizon: number): PanelRow[] {
  // SEG charts display absolute magnitudes regardless of asset/liability side
  // (matches Repricing Gap / EBP / Liquidity Gap convention). The signed
  // engine values stay available in the export for downstream attribution.
  const rows: PanelRow[] = [];
  for (let t = 0; t < horizon; t++) {
    const segP5 = Math.abs(out.outstandingSegP5[t]);
    const segP95 = Math.abs(out.outstandingSegP95[t]);
    rows.push({
      t,
      ebpDet: out.ebpDeterministic[t],
      ebpMcMean: out.ebpMcMean[t],
      ebpBand: [out.ebpMcP5[t], out.ebpMcP95[t]],
      segDet: Math.abs(out.outstandingSegDeterministic[t]),
      segMcMean: Math.abs(out.outstandingSegMean[t]),
      segBand: [Math.min(segP5, segP95), Math.max(segP5, segP95)],
      segPeriodicDet: Math.abs(out.periodicSegDeterministic[t]),
      segPeriodicMean: Math.abs(out.periodicSegMean[t]),
    });
  }
  return rows;
}

interface PanelProps {
  title: string;
  caption: string;
  rows: PanelRow[];
  horizon: number;
  initialBalance: number;
  segReference?: { value: number; label: string } | null;
}

function InstrumentPanel({
  title,
  caption,
  rows,
  horizon,
  initialBalance,
  segReference,
}: PanelProps) {
  const xTicks = useMemo(() => {
    const step = horizon <= 60 ? 12 : horizon <= 120 ? 24 : 60;
    const ticks: number[] = [];
    for (let m = 0; m <= horizon - 1; m += step) ticks.push(m);
    if (ticks[ticks.length - 1] !== horizon - 1) ticks.push(horizon - 1);
    return ticks;
  }, [horizon]);

  // Shared panel domain: floor at 0 (values are absolute magnitudes); upper
  // bound is the max across EBP, SEG Outstanding, *and* SEG Periodic so all
  // three charts in the panel share one Y-scale for visual comparison.
  const panelDomain = useMemo(() => {
    let hi = initialBalance;
    for (const r of rows) {
      hi = Math.max(hi, r.ebpBand[1], r.ebpDet, r.ebpMcMean);
      hi = Math.max(hi, r.segBand[1], r.segDet, r.segMcMean);
      hi = Math.max(hi, r.segPeriodicDet, r.segPeriodicMean);
    }
    const pad = Math.max(hi * 0.05, 1);
    return [0, hi + pad];
  }, [rows, initialBalance]);

  return (
    <div className="dash-card" style={{ marginTop: 16 }}>
      <div className="group-label">{title}</div>
      <p style={{ fontSize: 12, color: "rgba(18,19,18,0.65)", marginTop: -4, marginBottom: 12 }}>
        {caption}
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
        {/* EBP chart */}
        <div style={{ height: 280 }}>
          <div className="form-label" style={{ marginBottom: 4 }}>
            EBP: outstanding balance
          </div>
          <ResponsiveContainer width="100%" height="92%">
            <ComposedChart data={rows} margin={{ top: 16, right: 12, bottom: 28, left: 56 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
              <XAxis
                dataKey="t"
                ticks={xTicks}
                stroke={COLORS.obsidian}
                tick={{ fontSize: 11, fill: COLORS.obsidian }}
                label={{
                  value: "t (months from now)",
                  position: "insideBottom",
                  offset: -8,
                  style: { fontSize: 11, fill: "rgba(18,19,18,0.65)" },
                }}
              />
              <YAxis
                stroke={COLORS.obsidian}
                tick={{ fontSize: 11, fill: COLORS.obsidian }}
                tickFormatter={formatDollarTick}
                domain={panelDomain}
              />
              <Tooltip formatter={tooltipDollar} labelFormatter={(v) => `t = ${v}`} />
              <Area
                type="monotone"
                dataKey="ebpBand"
                name="P5–P95"
                fill={SERIES.bandFill}
                stroke="none"
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="ebpDet"
                name="Deterministic"
                stroke={SERIES.deterministic}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="ebpMcMean"
                name="MC mean"
                stroke={SERIES.hw}
                strokeWidth={2}
                strokeDasharray="6 3"
                dot={false}
                isAnimationActive={false}
              />
              <Legend verticalAlign="top" height={20} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* SEG outstanding chart */}
        <div style={{ height: 280 }}>
          <div className="form-label" style={{ marginBottom: 4 }}>
            SEG outstanding
          </div>
          <ResponsiveContainer width="100%" height="92%">
            <ComposedChart data={rows} margin={{ top: 16, right: 12, bottom: 28, left: 56 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
              <XAxis
                dataKey="t"
                ticks={xTicks}
                stroke={COLORS.obsidian}
                tick={{ fontSize: 11, fill: COLORS.obsidian }}
                label={{
                  value: "t (months from now)",
                  position: "insideBottom",
                  offset: -8,
                  style: { fontSize: 11, fill: "rgba(18,19,18,0.65)" },
                }}
              />
              <YAxis
                stroke={COLORS.obsidian}
                tick={{ fontSize: 11, fill: COLORS.obsidian }}
                tickFormatter={formatDollarTick}
                domain={panelDomain}
              />
              <Tooltip formatter={tooltipDollar} labelFormatter={(v) => `t = ${v}`} />
              <ReferenceLine y={0} stroke="rgba(18,19,18,0.35)" strokeDasharray="2 4" />
              {segReference !== null && segReference !== undefined && (
                <ReferenceLine
                  y={segReference.value}
                  stroke="rgba(112, 80, 160, 0.55)"
                  strokeDasharray="3 3"
                  label={{
                    value: segReference.label,
                    position: "insideTopLeft",
                    fontSize: 10,
                    fill: "rgba(112, 80, 160, 0.85)",
                  }}
                />
              )}
              <Area
                type="monotone"
                dataKey="segBand"
                name="P5–P95"
                fill={SERIES.bandFill}
                stroke="none"
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="segDet"
                name="Deterministic"
                stroke={SERIES.deterministic}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="segMcMean"
                name="MC mean"
                stroke={SERIES.bgm}
                strokeWidth={2}
                strokeDasharray="6 3"
                dot={false}
                isAnimationActive={false}
              />
              <Legend verticalAlign="top" height={20} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* SEG periodic chart */}
        <div style={{ height: 280 }}>
          <div className="form-label" style={{ marginBottom: 4 }}>
            SEG periodic = ΔSEG outstanding
          </div>
          <ResponsiveContainer width="100%" height="92%">
            <ComposedChart data={rows} margin={{ top: 16, right: 12, bottom: 28, left: 56 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
              <XAxis
                dataKey="t"
                ticks={xTicks}
                stroke={COLORS.obsidian}
                tick={{ fontSize: 11, fill: COLORS.obsidian }}
                label={{
                  value: "t",
                  position: "insideBottom",
                  offset: -8,
                  style: { fontSize: 11, fill: "rgba(18,19,18,0.65)" },
                }}
              />
              <YAxis
                stroke={COLORS.obsidian}
                tick={{ fontSize: 11, fill: COLORS.obsidian }}
                tickFormatter={formatDollarTick}
                domain={panelDomain}
              />
              <Tooltip formatter={tooltipDollar} labelFormatter={(v) => `t = ${v}`} />
              <Bar
                dataKey="segPeriodicDet"
                name="Deterministic"
                fill={COLORS.nodeOrange}
                isAnimationActive={false}
              />
              <Legend verticalAlign="top" height={20} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

export function SegEbpTab() {
  const { curve, hwSim, bgmSim } = useApp();
  const { fixedLoan, floatingLoan, mortgage, nmd, nmdBeta } = useInstruments();
  const [engine, setEngine] = useState<Engine>("hw");
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<{
    fixed: { out: SegOutput; horizon: number };
    floating: { out: SegOutput; horizon: number };
    mortgage: { out: SegOutput; horizon: number };
    nmd: { out: SegOutput; horizon: number };
    nmdBeta: { out: SegOutput; horizon: number };
  } | null>(null);
  const [stale, setStale] = useState(true);
  const [runError, setRunError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportSelection, setExportSelection] = useState<Record<InstrumentKey, boolean>>({
    fixed: true,
    floating: true,
    mortgage: true,
    nmd: true,
    nmdBeta: true,
  });

  const ready = !!curve && !!hwSim && !!bgmSim;

  /** Build MC paths trimmed to the requested horizon, padding with the last
   *  available value if the simulator's horizon is shorter than the
   *  instrument's maturity. */
  const buildMcPaths = (horizon: number): Float64Array[] => {
    if (!curve || !hwSim || !bgmSim) return [];
    if (engine === "hw") {
      const hwPaths = projectHWToTenor(hwSim, curve, TENOR_1M_YEARS);
      return hwPaths.map((p) => {
        const out = new Float64Array(horizon);
        const n = Math.min(horizon, p.length);
        for (let t = 0; t < n; t++) out[t] = p[t];
        const last = n > 0 ? p[n - 1] : 0;
        for (let t = n; t < horizon; t++) out[t] = last;
        return out;
      });
    }
    const nT = bgmSim.tenors.length;
    const bgmNSteps = bgmSim.times.length;
    const nUse = Math.min(horizon, bgmNSteps);
    const out: Float64Array[] = [];
    for (let p = 0; p < bgmSim.nPaths; p++) {
      const arr = new Float64Array(horizon);
      for (let t = 0; t < nUse; t++) {
        arr[t] = bgmSim.rates[(p * bgmNSteps + t) * nT + BGM_1M_TENOR_IDX];
      }
      if (horizon > nUse && nUse > 0) {
        const last = arr[nUse - 1];
        for (let t = nUse; t < horizon; t++) arr[t] = last;
      }
      out.push(arr);
    }
    return out;
  };

  /** HW latent state for analytic term forwards, only under the HW engine.
   *  xPaths are index-aligned with buildMcPaths' HW branch (both preserve
   *  projectHWToTenor / hwSim path order). BGM carries no latent X, so it
   *  stays on the StochasticRatePath averaging fallback. */
  const buildHwForward = (): HWForwardBundle | undefined => {
    if (engine !== "hw" || !hwSim || !curve) return undefined;
    return { xPaths: hwSim.XPaths, a: hwSim.a, sigma: hwSim.sigma, curve };
  };

  const runAnalytics = async () => {
    if (!curve || !hwSim || !bgmSim) return;
    setRunning(true);
    setRunError(null);
    try {
      // Each instrument runs on its own maturity-bound horizon.
      const fixedInst: Instrument = new FixedLoan(fixedLoan);
      const floatInst: Instrument = new FloatingLoan(floatingLoan);
      const mortgageInst: Instrument = new Mortgage(mortgage);
      const nmdInst: Instrument = new NMDeposit(nmd);
      const nmdBetaInst: Instrument = new NMDBeta(nmdBeta);

      const hwForward = buildHwForward();
      const runOne = (inst: Instrument, h: number) => {
        const detPath: RatePath = new DeterministicRatePath(curve, h);
        const mcPaths = buildMcPaths(h);
        return { out: runSegOnInstrument(inst, mcPaths, detPath, { horizon: h }, hwForward), horizon: h };
      };

      await new Promise((r) => setTimeout(r, 50));

      const fixed = runOne(fixedInst, fixedLoan.maturityMonths);
      const floating = runOne(floatInst, floatingLoan.maturityMonths);
      const mortgageRes = runOne(mortgageInst, mortgage.maturityMonths);
      const nmdRes = runOne(nmdInst, nmd.maturityMonths);
      const nmdBetaRes = runOne(nmdBetaInst, nmdBeta.maturityMonths);

      setResults({
        fixed,
        floating,
        mortgage: mortgageRes,
        nmd: nmdRes,
        nmdBeta: nmdBetaRes,
      });
      setStale(false);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const exportAll = async () => {
    if (!curve || !hwSim || !bgmSim) return;
    setExporting(true);
    try {

      const enginePrefix = engine === "hw" ? "hw" : "bgm";

      type Target = {
        key: InstrumentKey;
        instrument: Instrument;
        horizon: number;
        filename: string;
        label: string;
      };
      const allTargets: Target[] = [
        {
          key: "fixed",
          instrument: new FixedLoan(fixedLoan),
          horizon: fixedLoan.maturityMonths,
          filename: `seg_export_fixed_loan_${enginePrefix}.xlsx`,
          label: fixedLoan.label ?? "Fixed-rate loan",
        },
        {
          key: "floating",
          instrument: new FloatingLoan(floatingLoan),
          horizon: floatingLoan.maturityMonths,
          filename: `seg_export_floating_loan_${enginePrefix}.xlsx`,
          label: floatingLoan.label ?? "Floating-rate loan",
        },
        {
          key: "mortgage",
          instrument: new Mortgage(mortgage),
          horizon: mortgage.maturityMonths,
          filename: `seg_export_mortgage_${enginePrefix}.xlsx`,
          label: mortgage.label ?? "Mortgage",
        },
        {
          key: "nmd",
          instrument: new NMDeposit(nmd),
          horizon: nmd.maturityMonths,
          filename: `seg_export_nmd_a_${enginePrefix}.xlsx`,
          label: nmd.label ?? "Non-IB NMD",
        },
        {
          key: "nmdBeta",
          instrument: new NMDBeta(nmdBeta),
          horizon: nmdBeta.maturityMonths,
          filename: `seg_export_ib_nmd_${enginePrefix}.xlsx`,
          label: nmdBeta.label ?? "IB NMD",
        },
      ];
      const targets = allTargets.filter((t) => exportSelection[t.key]);
      if (targets.length === 0) return;

      const hwForward = buildHwForward();

      // Build and download sequentially so the browser doesn't race the
      // download dialogs. Yield between each so the UI can repaint.
      for (const t of targets) {
        const detPath: RatePath = new DeterministicRatePath(curve, t.horizon);
        const mcPaths = buildMcPaths(t.horizon);
        const bytes = buildSegInstrumentWorkbook({
          instrument: t.instrument,
          mcPaths,
          deterministicPath: detPath,
          horizon: t.horizon,
          displayLabel: t.label,
          hwForward,
        });
        downloadXlsx(bytes, t.filename);
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      setExporting(false);
    }
  };

  const fixedRows = useMemo(
    () => (results ? buildRows(results.fixed.out, results.fixed.horizon) : []),
    [results],
  );
  const floatingRows = useMemo(
    () => (results ? buildRows(results.floating.out, results.floating.horizon) : []),
    [results],
  );
  const mortgageRows = useMemo(
    () => (results ? buildRows(results.mortgage.out, results.mortgage.horizon) : []),
    [results],
  );
  const nmdRows = useMemo(
    () => (results ? buildRows(results.nmd.out, results.nmd.horizon) : []),
    [results],
  );
  const nmdBetaRows = useMemo(
    () => (results ? buildRows(results.nmdBeta.out, results.nmdBeta.horizon) : []),
    [results],
  );

  return (
    <div>
      <h1 className="section-title">SEG &amp; EBP</h1>
      <p className="section-subtitle">
        <strong>SEG</strong> (Sensitivity Equivalent Gap) is the outstanding rate-locked
        balance derived from the static-balance-sheet portfolio&apos;s total interest income
        sensitivity to a parallel ±10 bp shock applied at step ≥ 1 (the first month is
        pre-shock by convention). Cumulative SEG(t) = (NII<sub>up</sub>(t+1) −
        NII<sub>down</sub>(t+1)) × 12 / Δr is the dollar amount of the original notional that
        has *repriced* through replacement vintages or coupon resets. Outstanding SEG(t) =
        side<sub>sign</sub> × (Notional − Cumulative SEG(t)); periodic SEG(t) = ΔOutstanding.
        For vanilla rate-locked instruments, Outstanding SEG matches the Repricing Gap line;
        for convex instruments (mortgage, IB NMD β) the linear-swap-equivalent of the option
        is baked in. <strong>EBP</strong> (Equivalent Balance Profile) compares the
        deterministic existing-book balance against the Monte Carlo mean; the wedge is the
        cost of behavioral path-dependency on liquidity. Sign convention: asset SEG positive,
        liability SEG negative.
      </p>

      <div className="dash-card">
        <div className="group-label">Run</div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 4 }}>
          <div>
            <div className="form-label" style={{ marginBottom: 4 }}>Engine</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className={`tab-button${engine === "hw" ? " active" : ""}`}
                onClick={() => {
                  setEngine("hw");
                  setStale(true);
                }}
              >
                Hull-White
              </button>
              <button
                type="button"
                className={`tab-button${engine === "bgm" ? " active" : ""}`}
                onClick={() => {
                  setEngine("bgm");
                  setStale(true);
                }}
              >
                BGM
              </button>
            </div>
          </div>
          <div style={{ flexGrow: 1 }} />
          <button
            type="button"
            className="primary-button"
            onClick={runAnalytics}
            disabled={!ready || running}
          >
            {running ? "Running…" : "Run analytics"}
          </button>
          <button
            type="button"
            className="tab-button"
            onClick={exportAll}
            disabled={!ready || exporting || running}
            title="Download one .xlsx per instrument with per-path balance/rate/interest/principal under base, +10bp, and −10bp scenarios."
          >
            {exporting ? "Exporting…" : "Export to Excel"}
          </button>
        </div>
        {!ready && (
          <p style={{ fontSize: 12, color: "rgba(18,19,18,0.65)", marginTop: 12 }}>
            Calibrate and run the HW and BGM simulators first.
          </p>
        )}
        {ready && stale && (
          <p style={{ fontSize: 12, color: "rgba(18,19,18,0.65)", marginTop: 12 }}>
            Engine or terms changed. Click Run analytics to refresh.
          </p>
        )}
        {runError && (
          <p style={{ fontSize: 12, color: "#b42828", marginTop: 12 }}>
            Run failed: {runError}
          </p>
        )}

        <div style={{ marginTop: 16 }}>
          <div className="form-label" style={{ marginBottom: 6 }}>
            Excel export: instruments to include
          </div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 13 }}>
            {([
              ["fixed", "Fixed loan"],
              ["floating", "Floating loan"],
              ["mortgage", "Mortgage"],
              ["nmd", "Non-IB NMD"],
              ["nmdBeta", "IB NMD"],
            ] as Array<[InstrumentKey, string]>).map(([key, label]) => (
              <label key={key} style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={exportSelection[key]}
                  onChange={(e) =>
                    setExportSelection((prev) => ({ ...prev, [key]: e.target.checked }))
                  }
                />
                {label}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="group-label">Methodology</div>
        <ul style={{ fontSize: 13, lineHeight: 1.5, color: "var(--obsidian)", marginTop: 4, paddingLeft: 18 }}>
          <li>
            <strong>NII (asset) / NII (liability).</strong> Total interest income from the static-
            balance-sheet portfolio (existing book + all live new-business vintages). Asset side =
            interest received; liability side = interest paid. No funding offset, no opportunity
            cost: this is the raw asset/liability interest leg. Same convention as Chapters 2–3
            of the ALM book.
          </li>
          <li>
            <strong>Shock timing.</strong> ±10 bp parallel shift applied to the index rate at step
            ≥ 1; step 0 (month 1) is pre-shock so the first observation reflects the locked-in
            initial coupon. Shock takes effect at the first reset / new-volume origination.
          </li>
          <li>
            <strong>Cumulative SEG.</strong> Cumulative SEG(t) = [NII<sub>up</sub>(month t+1) −
            NII<sub>down</sub>(month t+1)] × 12 / Δr, with Δr = 20 bp. Represents the dollar amount
            of original notional repriced by time t (existing-book coupon resets + replacement
            vintages).
          </li>
          <li>
            <strong>Outstanding / Periodic SEG.</strong> Outstanding(t) = side<sub>sign</sub> × (N
            − Cumulative(t)); Outstanding(0) = side<sub>sign</sub> × N (hardcoded: full notional
            rate-locked at start). Periodic(t) = Outstanding(t−1) − Outstanding(t); Periodic(0) = 0.
          </li>
          <li>
            <strong>Static balance sheet.</strong> Each month&apos;s runoff is replaced by a new
            vintage with the same term structure but a new-volume coupon at the prevailing shocked
            rate (forward at matching tenor + carrying spread for fixed/mortgage; SOFR + margin for
            floating; β·r for IB NMD; 0% for Non-IB NMD). Total balance held at notional throughout.
          </li>
          <li>
            <strong>MC handling.</strong> Each MC path runs the full static-balance-sheet
            portfolio (existing book + replacement vintages) on the shocked path, so per-path
            New Business totals are genuinely path-dependent. The Excel export shows
            <em> per-path existing</em> and <em>per-path NB total</em> separately so
            existing NII + NB NII = total NII per path.
          </li>
          <li>
            <strong>Sign convention on charts.</strong> Engine values are signed (asset positive,
            liability negative); chart series display absolute magnitudes (matching Repricing Gap
            / EBP / Liquidity Gap). The signed values are preserved in the Excel export.
          </li>
          <li>
            <strong>Horizon.</strong> Each instrument runs to its own maturity (loans → 60 mo;
            mortgage and NMDs → 360 mo). The static balance sheet stops at maturity.
          </li>
        </ul>
      </div>

      {results && (
        <>
          <InstrumentPanel
            title="Fixed-rate loan"
            caption="Existing coupon locked; vintages reprice at the shocked new-volume rate. Outstanding SEG mirrors the existing-book amortisation (Repricing Gap line). Periodic SEG ≈ scheduled principal each month."
            rows={fixedRows}
            horizon={results.fixed.horizon}
            initialBalance={fixedLoan.notional}
            segReference={null}
          />
          <InstrumentPanel
            title="Floating-rate loan"
            caption="Coupon resets each period; under shock from step ≥ 1 the entire portfolio reprices at the first reset → Outstanding(t=0) = N, Outstanding(t≥1) ≈ 0. Periodic(t=1) = N."
            rows={floatingRows}
            horizon={results.floating.horizon}
            initialBalance={floatingLoan.notional}
            segReference={null}
          />
          <InstrumentPanel
            title="Mortgage"
            caption="Note rate locked; vintages reprice at 10Y forward + (sec_spread + prim_spread). Refi optionality bakes in via convex prepayment response; Outstanding SEG carries the linear-swap-equivalent of the embedded call."
            rows={mortgageRows}
            horizon={results.mortgage.horizon}
            initialBalance={mortgage.notional}
            segReference={null}
          />
          <InstrumentPanel
            title="Non-IB NMD"
            caption="0% deposit rate, 0% on replacement vintages → ΔNII = 0 → Cumulative SEG = 0 → Outstanding SEG = N flat; Periodic SEG = 0 (no repricing)."
            rows={nmdRows}
            horizon={results.nmd.horizon}
            initialBalance={nmd.notional}
            segReference={null}
          />
          <InstrumentPanel
            title="IB NMD (β-driven)"
            caption="Deposit rate D = β(r)·r reprices each period; vintages also β-driven. Outstanding SEG compresses toward (1 − β_eff)·N where β_eff = β + r·dβ/dr captures the marginal-β effect at the S-curve inflection."
            rows={nmdBetaRows}
            horizon={results.nmdBeta.horizon}
            initialBalance={nmdBeta.notional}
            segReference={
              results.nmdBeta.out.initialBeta !== undefined
                ? {
                    value: (1 - results.nmdBeta.out.initialBeta) * nmdBeta.notional,
                    label: `(1 − β(r₀))·N = ${formatDollar((1 - results.nmdBeta.out.initialBeta) * nmdBeta.notional)}`,
                  }
                : null
            }
          />
        </>
      )}
    </div>
  );
}
