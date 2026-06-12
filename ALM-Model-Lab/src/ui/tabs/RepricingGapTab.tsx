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
  buildRepricingGapWorkbook,
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

/** Fixed loan: rate-locked balance = outstanding balance; principal repayments are
 *  the repricing events (each repaid dollar must be reinvested at the prevailing rate). */
function buildFixedRows(cf: ReadonlyArray<Cashflow>): ChartRow[] {
  return cf.map((c) => ({
    month: c.monthOffset,
    outstanding: c.balance,
    periodic: c.principalPaid,
  }));
}

/** Floating loan with a frequent reset: the rate is locked only through the first
 *  reset event. From a repricing-gap standpoint the entire notional reprices at
 *  month 1 — including any principal that would otherwise be repaid later, since
 *  the bank's reinvestment is at the new SOFR. After month 1 the loan carries no
 *  rate-locked exposure; the rate-locked balance line drops to zero and stays
 *  there for the rest of the horizon. */
function buildFloatingRows(
  cf: ReadonlyArray<Cashflow>,
  notional: number,
): ChartRow[] {
  return cf.map((c, i) => ({
    month: c.monthOffset,
    outstanding: i === 0 ? notional : 0,
    periodic: i === 0 ? notional : 0,
  }));
}

/** NMD repricing split. At month 1 (the first observed cashflow) the cohort
 *  is still entirely under the initial deposit rate, so the rate-locked
 *  outstanding equals the full notional. The β slice (β × notional) reprices
 *  during month 1; from month 2 onward only the (1 − β) slice remains
 *  rate-locked, and that slice declines via decay: balance(t) × (1 − β).
 *  For Non-IB NMD (β = 0) (1 − β) = 1 so the line equals the outstanding
 *  balance throughout, with no repricing events. */
function buildNmdRows(
  cf: ReadonlyArray<Cashflow>,
  notional: number,
  beta: number,
): ChartRow[] {
  const b = Math.max(0, Math.min(1, beta));
  return cf.map((c, i) => ({
    month: c.monthOffset,
    outstanding: i === 0 ? notional : c.balance * (1 - b),
    periodic: i === 0 ? b * notional : 0,
  }));
}

export function RepricingGapTab() {
  const { curve } = useApp();
  const { fixedLoan, floatingLoan, mortgage, nmd, nmdBeta } = useInstruments();

  const {
    fixedRows,
    floatingRows,
    mortgageRows,
    nmdRows,
    nmdBetaRows,
    nmdBetaInitialBeta,
    totalAssets,
    totalLiabilities,
    fixedCf,
    floatCf,
    mortgageCf,
    nmdCf,
    nmdBetaCf,
  } = useMemo(() => {
    const fixedInstr: Instrument = new FixedLoan(fixedLoan);
    const floatInstr = new FloatingLoan(floatingLoan);
    const mortgageInstr = new Mortgage(mortgage);
    const nmdInstr = new NMDeposit(nmd);
    const nmdBetaInstr = new NMDBeta(nmdBeta);
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
    const nmdBetaInitialBeta = curve ? nmdBetaInstr.initialBeta(path) : 0;
    return {
      fixedRows: buildFixedRows(fixedCf),
      floatingRows: buildFloatingRows(floatCf, floatingLoan.notional),
      mortgageRows: buildFixedRows(mortgageCf),
      nmdRows: buildNmdRows(nmdCf, nmd.notional, nmd.beta ?? 0),
      nmdBetaRows: buildNmdRows(nmdBetaCf, nmdBeta.notional, nmdBetaInitialBeta),
      nmdBetaInitialBeta,
      totalAssets: fixedLoan.notional + floatingLoan.notional + mortgage.notional,
      totalLiabilities: nmd.notional + nmdBeta.notional,
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
      {
        key: "fixed",
        series: {
          label: fixedLoan.label ?? "Fixed loan",
          cashflows: fixedCf,
          notional: fixedLoan.notional,
          side: "asset",
        },
      },
      {
        key: "floating",
        series: {
          label: floatingLoan.label ?? "Floating loan",
          cashflows: floatCf,
          notional: floatingLoan.notional,
          side: "asset",
          isFloater: true,
        },
      },
      {
        key: "mortgage",
        series: {
          label: mortgage.label ?? "Mortgage",
          cashflows: mortgageCf,
          notional: mortgage.notional,
          side: "asset",
        },
      },
      {
        key: "nmd",
        series: {
          label: nmd.label ?? "Non-IB NMD",
          cashflows: nmdCf,
          notional: nmd.notional,
          side: "liability",
          initialBeta: nmd.beta ?? 0,
        },
      },
      {
        key: "nmdBeta",
        series: {
          label: nmdBeta.label ?? "IB NMD",
          cashflows: nmdBetaCf,
          notional: nmdBeta.notional,
          side: "liability",
          initialBeta: nmdBetaInitialBeta,
        },
      },
    ];
    const selected = all.filter((t) => exportSelection[t.key]).map((t) => t.series);
    if (selected.length === 0) return;
    const bytes = buildRepricingGapWorkbook(selected);
    downloadXlsx(bytes, "repricing_gap.xlsx");
  };

  return (
    <div>
      <h1 className="section-title">Repricing gap</h1>
      <p className="section-subtitle">
        Repricing profile, principal only, at monthly intervals. The line shows outstanding
        rate-locked principal at each month; the bars show principal repricing in that
        month. For fixed-rate loans every principal repayment is a repricing event. For
        floaters with a monthly reset the full notional reprices on the first reset
        regardless of amortization type. Mortgages add prepayment principal on top of
        scheduled. NMDs split by deposit-rate β: rate-locked = balance × (1 − β), and the
        β slice reprices in the next monthly bucket (β × initial balance). NMD-A is
        non-interest-bearing (β = 0), so the whole cohort sits as rate-locked.
      </p>

      <div className="dash-card">
        <div className="group-label">Book composition</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 24, fontSize: 13 }}>
          <KVP label="Total assets" value={formatDollar(totalAssets)} />
          <KVP label="Fixed loan" value={formatDollar(fixedLoan.notional)} />
          <KVP label="Floating loan" value={formatDollar(floatingLoan.notional)} />
          <KVP label="Mortgage" value={formatDollar(mortgage.notional)} />
          <KVP label="Non-IB NMD" value={formatDollar(nmd.notional)} />
          <KVP label="IB NMD (β-driven)" value={formatDollar(nmdBeta.notional)} />
        </div>
        <div className="form-helper" style={{ marginTop: 6 }}>
          Total liabilities: {formatDollar(totalLiabilities)}.
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
        title="Fixed-rate loan: repricing profile"
        rows={fixedRows}
        outstandingLabel="Outstanding rate-locked principal"
        periodicLabel="Principal repricing in month"
      />

      <GapChart
        title="Floating-rate loan: repricing profile"
        rows={floatingRows}
        outstandingLabel="Outstanding rate-locked principal"
        periodicLabel="Principal repricing in month"
      />

      <GapChart
        title="Mortgage: repricing profile (scheduled + prepayment principal)"
        rows={mortgageRows}
        outstandingLabel="Outstanding rate-locked principal"
        periodicLabel="Principal repricing in month"
      />

      <GapChart
        title={`Non-IB NMD: repricing profile (β = ${(nmd.beta ?? 0).toFixed(2)})`}
        rows={nmdRows}
        outstandingLabel="Rate-locked deposits = balance × (1 − β)"
        periodicLabel="β-slice repricing"
      />

      <GapChart
        title={`IB NMD: repricing profile (β at t=0 = ${nmdBetaInitialBeta.toFixed(3)})`}
        rows={nmdBetaRows}
        outstandingLabel="Rate-locked deposits: full notional at month 1, drops to balance × (1 − β) thereafter"
        periodicLabel="β-slice repricing"
      />
    </div>
  );
}

interface GapChartProps {
  title: string;
  rows: ChartRow[];
  outstandingLabel: string;
  periodicLabel: string;
}

function GapChart({ title, rows, outstandingLabel, periodicLabel }: GapChartProps) {
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
            label={{ value: "Periodic ($)", angle: 90, position: "insideRight", style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
          />
          <Tooltip
            formatter={(v: unknown, name: string) =>
              typeof v === "number" && Number.isFinite(v) ? [formatDollar(v), name] : ["—", name]
            }
            labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")}
          />
          <Bar
            yAxisId="periodic"
            dataKey="periodic"
            name={periodicLabel}
            fill={COLORS.nodeOrange}
            isAnimationActive={false}
          />
          <Line
            yAxisId="bal"
            type="monotone"
            dataKey="outstanding"
            name={outstandingLabel}
            stroke={COLORS.obsidian}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
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
