import { useMemo } from "react";
import {
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
import { COLORS } from "../tokens";
import { FloatingLoan } from "../../math/instruments/floatingLoan";
import { DeterministicRatePath } from "../../math/rates/ratePath";
import type { FloatingLoanTerms } from "../../math/instruments/floatingLoan";

const LEGEND_STYLE = {
  fontSize: 12,
  fontFamily: "var(--font-sans)",
  color: "var(--obsidian)",
};
function darkLegendFormatter(value: string) {
  return <span style={{ color: "var(--obsidian)", fontWeight: 500 }}>{value}</span>;
}
const formatDollar = (v: number) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const formatDollar2 = (v: number) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
/** Compact tick label: $1.2M / $250K / $500. */
const formatDollarTick = (v: number): string => {
  const abs = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
};

const cashflowTooltipFormatter = (v: unknown, name: string) => {
  if (typeof v === "number" && Number.isFinite(v)) return [formatDollar2(v), name];
  return ["—", name];
};
const percentTooltipFormatter = (v: unknown, name: string) => {
  if (typeof v === "number" && Number.isFinite(v)) return [`${(v * 100).toFixed(3)}%`, name];
  return ["—", name];
};

export function FloatingLoanTab() {
  const { curve } = useApp();
  const { floatingLoan, patchFloatingLoan } = useInstruments();

  const setT = <K extends keyof FloatingLoanTerms>(k: K, v: FloatingLoanTerms[K]) => {
    patchFloatingLoan({ [k]: v } as Partial<FloatingLoanTerms>);
  };

  const { cashflows, summaryRow } = useMemo(() => {
    const instr = new FloatingLoan(floatingLoan);
    const path = curve
      ? new DeterministicRatePath(curve, floatingLoan.maturityMonths)
      : ({ rateAt: () => 0, forwardRateAt: () => 0, nSteps: 0, times: [] } as never);
    const cf = instr.generateCashflows(path);
    const totalPrincipal = cf.reduce((s, c) => s + c.principalPaid, 0);
    const totalInterest = cf.reduce((s, c) => s + c.interestPaid, 0);
    const wavgCoupon =
      cf.reduce((s, c) => s + c.couponRate * c.balance, 0) /
      Math.max(cf.reduce((s, c) => s + c.balance, 0), 1e-12);
    return {
      cashflows: cf,
      summaryRow: { totalPrincipal, totalInterest, wavgCoupon, n: cf.length },
    };
  }, [floatingLoan, curve]);

  const chartData = useMemo(
    () =>
      cashflows.map((c) => ({
        month: c.monthOffset,
        balance: c.balance,
        principalPaid: c.principalPaid,
        interestPaid: c.interestPaid,
        coupon: c.couponRate,
      })),
    [cashflows],
  );

  return (
    <div>
      <h1 className="section-title">Floating-rate loan</h1>
      <p className="section-subtitle">
        Indexed to 1M SOFR with a static margin. Coupon resets on each reset month; level-pay
        re-amortizes against the remaining balance and remaining term at every reset. The rate path
        is the deterministic forward curve from the bootstrapped zero curve.
      </p>

      {/* Parameter card -------------------------------------------- */}
      <div className="dash-card">
        <div className="group-label">Loan terms</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 24 }}>
          <NumberField
            label="Notional ($)"
            value={floatingLoan.notional}
            onChange={(v) => setT("notional", v)}
            step={50_000}
          />
          <NumberField
            label="Maturity (months)"
            value={floatingLoan.maturityMonths}
            onChange={(v) => setT("maturityMonths", v)}
            step={1}
          />
          <NumberField
            label="Margin (%)"
            value={floatingLoan.margin * 100}
            onChange={(v) => setT("margin", v / 100)}
            step={0.05}
          />
          <NumberField
            label="Reset every (months)"
            value={floatingLoan.resetFrequencyMonths}
            onChange={(v) => setT("resetFrequencyMonths", Math.max(1, Math.round(v)))}
            step={1}
          />
        </div>
        <div className="form-row" style={{ marginTop: 16 }}>
          <span className="form-label">Amortization</span>
          <label style={{ marginRight: 16 }}>
            <input
              type="radio"
              name="floating-amort"
              checked={floatingLoan.amortType === "level-pay"}
              onChange={() => setT("amortType", "level-pay")}
              style={{ marginRight: 6 }}
            />
            Level-pay
          </label>
          <label>
            <input
              type="radio"
              name="floating-amort"
              checked={floatingLoan.amortType === "bullet"}
              onChange={() => setT("amortType", "bullet")}
              style={{ marginRight: 6 }}
            />
            Bullet
          </label>
        </div>
        <div className="form-helper" style={{ marginTop: 12, fontStyle: "italic" }}>
          Index = 1M SOFR (Phase 2 only supports 1M). The all-in coupon at any reset = path 1M rate
          + margin. Floor / cap features are out of scope for the simple example.
        </div>
      </div>

      {/* Summary card ---------------------------------------------- */}
      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="group-label">Schedule summary</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 24, fontSize: 13 }}>
          <KVP label="Months" value={`${summaryRow.n}`} />
          <KVP label="Total interest" value={formatDollar(summaryRow.totalInterest)} />
          <KVP label="Total principal" value={formatDollar(summaryRow.totalPrincipal)} />
          <KVP label="Bal-weighted avg coupon" value={`${(summaryRow.wavgCoupon * 100).toFixed(3)}%`} />
        </div>
      </div>

      {/* Charts -------------------------------------------------- */}
      <div className="row" style={{ marginTop: 24 }}>
        <div className="dash-card grow" style={{ height: 420 }}>
          <div className="group-label">Outstanding balance</div>
          <ResponsiveContainer width="100%" height="88%">
            <ComposedChart data={chartData} margin={{ top: 16, right: 16, bottom: 36, left: 88 }}>
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
                formatter={cashflowTooltipFormatter}
                labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")}
              />
              <Line dataKey="balance" stroke={COLORS.obsidian} strokeWidth={2} dot={false} isAnimationActive={false} name="Balance" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="dash-card grow" style={{ height: 420 }}>
          <div className="group-label">Coupon rate path (resets on schedule)</div>
          <ResponsiveContainer width="100%" height="88%">
            <ComposedChart data={chartData} margin={{ top: 16, right: 16, bottom: 36, left: 56 }}>
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
                tickFormatter={(v) => `${(v * 100).toFixed(2)}%`}
                label={{ value: "Coupon (%)", angle: -90, position: "insideLeft", dx: -12, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
              />
              <Tooltip
                formatter={percentTooltipFormatter}
                labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")}
              />
              <Line
                type="stepAfter"
                dataKey="coupon"
                stroke={COLORS.nodeOrange}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                name="All-in coupon"
              />
              <ReferenceLine y={floatingLoan.margin} stroke="rgba(18,19,18,0.25)" strokeDasharray="3 3" label={{ value: "margin", position: "insideTopLeft", fontSize: 10 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Cashflow waterfall ------------------------------------- */}
      <div className="dash-card" style={{ marginTop: 16, height: 420 }}>
        <div className="group-label">Monthly cashflow waterfall</div>
        <ResponsiveContainer width="100%" height="92%">
          <ComposedChart data={chartData} margin={{ top: 32, right: 24, bottom: 36, left: 88 }}>
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
              formatter={cashflowTooltipFormatter}
              labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")}
            />
            <Bar
              dataKey="interestPaid"
              stackId="cf"
              fill={COLORS.nodeTeal}
              isAnimationActive={false}
              name="Interest"
            />
            <Bar
              dataKey="principalPaid"
              stackId="cf"
              fill={COLORS.nodeOrange}
              isAnimationActive={false}
              name="Principal"
            />
            <Legend verticalAlign="top" height={28} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Monthly cashflow detail table -------------------------- */}
      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="group-label">Monthly cashflow detail</div>
        <p className="form-helper" style={{ marginTop: -4, marginBottom: 8 }}>
          Bullet floaters accrue interest every month at the prevailing reset coupon; the
          principal spike at maturity dwarfs monthly interest in the chart above, but each
          row below shows the all-in coupon, interest, and principal for that month.
        </p>
        <div style={{ maxHeight: 280, overflowY: "auto", border: "1px solid rgba(18,19,18,0.08)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead style={{ position: "sticky", top: 0, background: "var(--cloud-dancer)", boxShadow: "inset 0 -1px 0 rgba(18,19,18,0.15)" }}>
              <tr>
                <th style={{ padding: "6px 12px", textAlign: "right", fontWeight: 500, color: "var(--obsidian)" }}>Month</th>
                <th style={{ padding: "6px 12px", textAlign: "right", fontWeight: 500, color: "var(--obsidian)" }}>Opening balance</th>
                <th style={{ padding: "6px 12px", textAlign: "right", fontWeight: 500, color: "var(--obsidian)" }}>All-in coupon</th>
                <th style={{ padding: "6px 12px", textAlign: "right", fontWeight: 500, color: "var(--obsidian)" }}>Interest</th>
                <th style={{ padding: "6px 12px", textAlign: "right", fontWeight: 500, color: "var(--obsidian)" }}>Principal</th>
                <th style={{ padding: "6px 12px", textAlign: "right", fontWeight: 500, color: "var(--obsidian)" }}>Total payment</th>
              </tr>
            </thead>
            <tbody>
              {cashflows.map((c) => (
                <tr key={c.monthOffset} style={{ borderTop: "1px solid rgba(18,19,18,0.04)" }}>
                  <td style={{ padding: "4px 12px", textAlign: "right", color: "var(--obsidian)" }}>{c.monthOffset}</td>
                  <td style={{ padding: "4px 12px", textAlign: "right", color: "var(--obsidian)" }}>{formatDollar2(c.balance)}</td>
                  <td style={{ padding: "4px 12px", textAlign: "right", color: "var(--obsidian)" }}>{`${(c.couponRate * 100).toFixed(3)}%`}</td>
                  <td style={{ padding: "4px 12px", textAlign: "right", color: "var(--obsidian)" }}>{formatDollar2(c.interestPaid)}</td>
                  <td style={{ padding: "4px 12px", textAlign: "right", color: "var(--obsidian)" }}>{formatDollar2(c.principalPaid)}</td>
                  <td style={{ padding: "4px 12px", textAlign: "right", color: "var(--obsidian)" }}>{formatDollar2(c.interestPaid + c.principalPaid)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  step?: number;
  onChange: (v: number) => void;
}
function NumberField({ label, value, step, onChange }: NumberFieldProps) {
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
