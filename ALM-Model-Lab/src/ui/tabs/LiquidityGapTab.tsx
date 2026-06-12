import { useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useApp } from "../state/AppContext";
import { useInstruments } from "../state/InstrumentContext";
import { COLORS } from "../tokens";
import { FixedLoan } from "../../math/instruments/fixedLoan";
import { FloatingLoan } from "../../math/instruments/floatingLoan";
import { Mortgage } from "../../math/instruments/mortgage";
import { NMDeposit } from "../../math/instruments/nmd";
import { NMDBeta } from "../../math/instruments/nmdBeta";
import { DeterministicRatePath } from "../../math/rates/ratePath";
import type { Cashflow, Instrument, RatePath } from "../../math/instruments/types";
import {
  buildLiquidityGapWorkbook,
  downloadXlsx,
  type InstrumentSeries,
} from "../../storage/analyticsExport";

type InstrumentKey = "fixed" | "floating" | "mortgage" | "nmd" | "nmdBeta";

const LEGEND_STYLE = {
  fontSize: 12,
  fontFamily: "var(--font-sans)",
  color: "var(--obsidian)",
};
const formatDollar = (v: number) =>
  `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const formatDollarTick = (v: number): string => {
  const abs = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
};
function darkLegendFormatter(value: string) {
  return <span style={{ color: "var(--obsidian)", fontWeight: 500 }}>{value}</span>;
}

interface ChartRow {
  month: number;
  outstanding: number;
  periodic: number;
}

function buildRows(cf: ReadonlyArray<Cashflow>): ChartRow[] {
  return cf.map((c) => ({
    month: c.monthOffset,
    outstanding: c.balance,
    periodic: c.principalPaid,
  }));
}

function walYears(cf: ReadonlyArray<Cashflow>): number {
  let num = 0;
  let den = 0;
  for (const c of cf) {
    num += (c.monthOffset / 12) * c.principalPaid;
    den += c.principalPaid;
  }
  return den > 1e-12 ? num / den : 0;
}

export function LiquidityGapTab() {
  const { curve } = useApp();
  const { fixedLoan, floatingLoan, mortgage, nmd, nmdBeta } = useInstruments();

  const {
    fixedRows,
    floatingRows,
    mortgageRows,
    nmdRows,
    nmdBetaRows,
    fixedWAL,
    floatingWAL,
    mortgageWAL,
    nmdWAL,
    nmdBetaWAL,
    fixedCf,
    floatCf,
    mortgageCf,
    nmdCf,
    nmdBetaCf,
  } = useMemo(() => {
    const fixedInstr: Instrument = new FixedLoan(fixedLoan);
    const floatInstr: Instrument = new FloatingLoan(floatingLoan);
    const mortgageInstr: Instrument = new Mortgage(mortgage);
    const nmdInstr: Instrument = new NMDeposit(nmd);
    const nmdBetaInstr: Instrument = new NMDBeta(nmdBeta);
    const horizon = Math.max(
      fixedLoan.maturityMonths,
      floatingLoan.maturityMonths,
      mortgage.maturityMonths,
      nmd.maturityMonths,
      nmdBeta.maturityMonths,
    );
    const path: RatePath = curve
      ? new DeterministicRatePath(curve, horizon)
      : ({ rateAt: () => 0, forwardRateAt: () => 0, nSteps: 0, times: [] } as never);
    const fixedCf = fixedInstr.generateCashflows(path);
    const floatCf = floatInstr.generateCashflows(path);
    const mortgageCf = mortgageInstr.generateCashflows(path);
    const nmdCf = nmdInstr.generateCashflows(path);
    const nmdBetaCf = nmdBetaInstr.generateCashflows(path);
    return {
      fixedRows: buildRows(fixedCf),
      floatingRows: buildRows(floatCf),
      mortgageRows: buildRows(mortgageCf),
      nmdRows: buildRows(nmdCf),
      nmdBetaRows: buildRows(nmdBetaCf),
      fixedWAL: walYears(fixedCf),
      floatingWAL: walYears(floatCf),
      mortgageWAL: walYears(mortgageCf),
      nmdWAL: walYears(nmdCf),
      nmdBetaWAL: walYears(nmdBetaCf),
      fixedCf,
      floatCf,
      mortgageCf,
      nmdCf,
      nmdBetaCf,
    };
  }, [curve, fixedLoan, floatingLoan, mortgage, nmd, nmdBeta]);

  const [exportSelection, setExportSelection] = useState<Record<InstrumentKey, boolean>>({
    fixed: true,
    floating: true,
    mortgage: true,
    nmd: true,
    nmdBeta: true,
  });

  const onExport = () => {
    const all: Array<{ key: InstrumentKey; series: InstrumentSeries }> = [
      { key: "fixed", series: { label: fixedLoan.label ?? "Fixed loan", cashflows: fixedCf, notional: fixedLoan.notional, side: "asset" } },
      { key: "floating", series: { label: floatingLoan.label ?? "Floating loan", cashflows: floatCf, notional: floatingLoan.notional, side: "asset" } },
      { key: "mortgage", series: { label: mortgage.label ?? "Mortgage", cashflows: mortgageCf, notional: mortgage.notional, side: "asset" } },
      { key: "nmd", series: { label: nmd.label ?? "Non-IB NMD", cashflows: nmdCf, notional: nmd.notional, side: "liability" } },
      { key: "nmdBeta", series: { label: nmdBeta.label ?? "IB NMD", cashflows: nmdBetaCf, notional: nmdBeta.notional, side: "liability" } },
    ];
    const selected = all.filter((t) => exportSelection[t.key]).map((t) => t.series);
    if (selected.length === 0) return;
    const bytes = buildLiquidityGapWorkbook(selected);
    downloadXlsx(bytes, "liquidity_gap.xlsx");
  };

  return (
    <div>
      <h1 className="section-title">Liquidity gap</h1>
      <p className="section-subtitle">
        Principal cashflow profile, monthly. The line shows outstanding principal not yet
        received; the bars show principal received in each month. Level-pay loans
        contribute a smooth amortization profile; bullets concentrate principal at
        maturity. The deterministic forward curve drives the floater's principal schedule
        because re-amortization at each reset depends on the prevailing index.
      </p>

      {!curve && (
        <div className="dash-card">
          <p style={{ fontStyle: "italic", color: "var(--obsidian)" }}>
            No bootstrapped curve loaded. The fixed-rate principal schedule is curve-independent,
            but the floater's depends on the forward curve. Bootstrap on the Curve tab to populate
            the floating-rate chart.
          </p>
        </div>
      )}

      <div className="dash-card">
        <div className="group-label">Cashflow summary</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 24, fontSize: 13 }}>
          <KVP label="Fixed" value={`${formatDollar(fixedLoan.notional)} · WAL ${fixedWAL.toFixed(2)}y`} />
          <KVP label="Floating" value={`${formatDollar(floatingLoan.notional)} · WAL ${floatingWAL.toFixed(2)}y`} />
          <KVP label="Mortgage" value={`${formatDollar(mortgage.notional)} · WAL ${mortgageWAL.toFixed(2)}y`} />
          <KVP label="Non-IB NMD" value={`${formatDollar(nmd.notional)} · WAL ${nmdWAL.toFixed(2)}y`} />
          <KVP label="IB NMD" value={`${formatDollar(nmdBeta.notional)} · WAL ${nmdBetaWAL.toFixed(2)}y`} />
        </div>
      </div>

      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="group-label">Excel export</div>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 13, alignItems: "center" }}>
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
          <div style={{ flexGrow: 1 }} />
          <button type="button" className="tab-button" onClick={onExport}>
            Export to Excel
          </button>
        </div>
      </div>

      <GapChart
        title="Fixed-rate loan: principal cashflow"
        rows={fixedRows}
      />
      <GapChart
        title="Floating-rate loan: principal cashflow"
        rows={floatingRows}
      />
      <GapChart
        title="Mortgage: principal cashflow (scheduled + prepayment)"
        rows={mortgageRows}
      />
      <GapChart
        title="Non-IB NMD: decay cashflow"
        rows={nmdRows}
      />
      <GapChart
        title="IB NMD (β-driven): decay cashflow"
        rows={nmdBetaRows}
      />
    </div>
  );
}

function GapChart({ title, rows }: { title: string; rows: ChartRow[] }) {
  return (
    <div className="dash-card" style={{ marginTop: 16, height: 420 }}>
      <div className="group-label">{title}</div>
      <ResponsiveContainer width="100%" height="92%">
        <ComposedChart data={rows} margin={{ top: 32, right: 24, bottom: 36, left: 88 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
          <XAxis
            dataKey="month"
            stroke={COLORS.obsidian}
            tick={{ fontSize: 12, fill: COLORS.obsidian }}
            label={{ value: "Months", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
          />
          <YAxis
            yAxisId="bal"
            stroke={COLORS.obsidian}
            tick={{ fontSize: 12, fill: COLORS.obsidian }}
            tickFormatter={(v) => formatDollarTick(v)}
            label={{ value: "Outstanding ($)", angle: -90, position: "insideLeft", dx: -20, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
          />
          <YAxis
            yAxisId="periodic"
            orientation="right"
            stroke={COLORS.obsidian}
            tick={{ fontSize: 12, fill: COLORS.obsidian }}
            tickFormatter={(v) => formatDollarTick(v)}
            label={{ value: "Principal in month ($)", angle: 90, position: "insideRight", style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
          />
          <Tooltip
            formatter={(v: unknown, name: string) =>
              typeof v === "number" && Number.isFinite(v) ? [formatDollar(v), name] : ["—", name]
            }
            labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")}
          />
          <Bar yAxisId="periodic" dataKey="periodic" name="Principal received" fill={COLORS.nodeOrange} isAnimationActive={false} />
          <Line yAxisId="bal" type="monotone" dataKey="outstanding" name="Outstanding principal" stroke={COLORS.obsidian} strokeWidth={2} dot={false} isAnimationActive={false} />
          <Legend verticalAlign="top" height={28} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
        </ComposedChart>
      </ResponsiveContainer>
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
