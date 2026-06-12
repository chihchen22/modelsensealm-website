import { useMemo, useState, type ReactNode } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
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
import { computeFTP } from "../../math/analytics/ftp";
import type { Instrument } from "../../math/instruments/types";
import type { FtpInstrumentRow } from "../../math/analytics/types";
import type { ZeroCurve } from "../../math/rates/bootstrap";
import type { TLPCurve } from "../../math/rates/tlpCurve";
import { buildFtpWorkbook, downloadXlsx } from "../../storage/analyticsExport";

type InstrumentKey = "fixed" | "floating" | "mortgage" | "nmd" | "nmdBeta";

const KEY_TO_ID: Record<InstrumentKey, string> = {
  fixed: "fixed-loan-1",
  floating: "floating-loan-1",
  mortgage: "mortgage-1",
  nmd: "nmd-1",
  nmdBeta: "nmd-b-1",
};

const INSTRUMENT_OPTIONS: ReadonlyArray<[InstrumentKey, string]> = [
  ["fixed", "Fixed loan"],
  ["floating", "Floating loan"],
  ["mortgage", "Mortgage"],
  ["nmd", "Non-IB NMD"],
  ["nmdBeta", "IB NMD"],
];

const LEGEND_STYLE = {
  fontSize: 12,
  fontFamily: "var(--font-sans)",
  color: "var(--obsidian)",
};
const fmtPct = (v: number) => `${(v * 100).toFixed(3)}%`;
const fmtBps = (v: number) => `${(v * 10000).toFixed(0)} bps`;
function darkLegendFormatter(value: string) {
  return <span style={{ color: "var(--obsidian)", fontWeight: 500 }}>{value}</span>;
}

export function FtpTab() {
  const { curve, tlpCurve } = useApp();
  const { fixedLoan, floatingLoan, mortgage, nmd, nmdBeta } = useInstruments();
  const [exportSelection, setExportSelection] = useState<Record<InstrumentKey, boolean>>({
    fixed: true,
    floating: true,
    mortgage: true,
    nmd: true,
    nmdBeta: true,
  });

  const computed = useMemo(() => {
    if (!curve) return null;
    const instruments: Instrument[] = [
      new FixedLoan(fixedLoan),
      new FloatingLoan(floatingLoan),
      new Mortgage(mortgage),
      new NMDeposit(nmd),
      new NMDBeta(nmdBeta),
    ];
    const horizon = Math.max(
      fixedLoan.maturityMonths,
      floatingLoan.maturityMonths,
      mortgage.maturityMonths,
      nmd.maturityMonths,
      nmdBeta.maturityMonths,
    );
    const path = new DeterministicRatePath(curve, horizon);
    return computeFTP(instruments, curve, tlpCurve, path);
  }, [curve, tlpCurve, fixedLoan, floatingLoan, mortgage, nmd, nmdBeta]);

  if (!curve || !computed) {
    return (
      <div>
        <h1 className="section-title">Funds transfer pricing</h1>
        <p className="section-subtitle">
          Par-matched static-strip transfer rate per instrument with TLP overlay. Decomposed
          into interest-rate FTP, liquidity-premium FTP, and the FTP margin (locked NIM).
        </p>
        <div className="dash-card">
          <p style={{ fontStyle: "italic", color: "var(--obsidian)" }}>
            No bootstrapped curve loaded. Visit the Curve tab to bootstrap the SOFR OIS strip
            before running FTP.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="section-title">Funds transfer pricing</h1>
      <p className="section-subtitle">
        Par-matched static-strip method with TLP overlay. The bank's all-in funding curve
        is SOFR + TLP (FHLB − SOFR). For each instrument we par-match against SOFR alone
        (interest-rate FTP), against the all-in curve (all-in FTP), and decompose the
        residual as the liquidity-premium FTP. FTP margin reads as positive franchise
        value on both sides: asset rate − all-in FTP for assets, all-in FTP − deposit rate
        for liabilities (the deposit-franchise FTP credit).
      </p>

      <FundingCurveChart curve={curve} tlp={tlpCurve} />

      <FundingCurveTable curve={curve} tlp={tlpCurve} />

      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="group-label">Excel export</div>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 13, alignItems: "center" }}>
          {INSTRUMENT_OPTIONS.map(([key, label]) => (
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
          <button
            type="button"
            className="tab-button"
            onClick={() => {
              const ids = INSTRUMENT_OPTIONS.filter(([k]) => exportSelection[k]).map(
                ([k]) => KEY_TO_ID[k],
              );
              if (ids.length === 0) return;
              const bytes = buildFtpWorkbook({
                perInstrument: computed.perInstrument,
                bookNim: computed.bookNim,
                curve,
                tlp: tlpCurve,
                selectedIds: ids,
              });
              downloadXlsx(bytes, "ftp.xlsx");
            }}
          >
            Export to Excel
          </button>
        </div>
        <div className="form-helper" style={{ marginTop: 8 }}>
          One workbook with a Summary tab (per-instrument decomposition + book NIM), a
          Curves tab (SOFR / TLP / All-in across the standard tenor grid), and one tab
          per selected instrument carrying the monthly coupon vs all-in FTP series.
        </div>
      </div>

      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="group-label">Per-instrument FTP decomposition</div>
        <table className="ftp-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(18,19,18,0.15)" }}>
              <Th>Instrument</Th>
              <Th>Side</Th>
              <Th align="right">Coupon rate</Th>
              <Th align="right">IR FTP</Th>
              <Th align="right">LP FTP</Th>
              <Th align="right">All-in FTP</Th>
              <Th align="right">FTP margin</Th>
              <Th align="right">Margin (bps)</Th>
            </tr>
          </thead>
          <tbody>
            {computed.perInstrument.map((row) => (
              <tr key={row.instrumentId} style={{ borderBottom: "1px solid rgba(18,19,18,0.06)" }}>
                <Td>{row.label}</Td>
                <Td>{row.side}</Td>
                <Td align="right">{fmtPct(row.assetRate)}</Td>
                <Td align="right">{fmtPct(row.irFtpRate)}</Td>
                <Td align="right">{fmtPct(row.lpFtpRate)}</Td>
                <Td align="right">{fmtPct(row.allInFtpRate)}</Td>
                <Td align="right">{fmtPct(row.ftpMargin)}</Td>
                <Td align="right">{fmtBps(row.ftpMargin)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="form-helper" style={{ marginTop: 8 }}>
          IR FTP = par-match against SOFR alone. All-in FTP = par-match against SOFR + TLP.
          LP FTP = all-in − IR (additive decomposition). FTP margin reads positive franchise
          value on both sides: for assets it is the locked NIM; for liabilities it is the
          deposit-franchise FTP credit (all-in FTP earned by the desk minus the deposit
          rate the bank pays).
        </div>
        <div className="form-helper" style={{ marginTop: 4, fontStyle: "italic" }}>
          NMD note: the par-matched static-strip shown here is the matched-funding method
          applied to the deposit's deterministic decay schedule: every dollar of the cohort
          is treated as <strong>stable core</strong> and credited the all-in funding rate at
          its behavioral tenor. No portion is carved out for a stress / liquidity buffer
          (HQLA, contingency liquidity, run-rate haircut), so the FTP credit shown here is
          the gross franchise value before any liquidity reserve is netted. Because the
          behavioral maturity is stochastic in practice, the production alternative is a
          replicating portfolio, a tenor mix of SOFR / FHLB instruments calibrated to the
          cohort's mean and dispersion of decay across rate scenarios. The static-strip and
          replicating-portfolio rates agree in expectation under the deterministic forward
          but diverge once rate-driven decay variability is priced in.
        </div>
      </div>

      {computed.perInstrument.map((row) => (
        <CouponVsFtpChart key={row.instrumentId} row={row} />
      ))}
    </div>
  );
}

/** Plots SOFR zero curve, TLP, and the all-in funding curve (SOFR + TLP) across a
 *  dense tenor grid out to 30Y. Rates on the left axis, TLP on the right axis in
 *  bps so the relatively-small spread is legible alongside the absolute curves. */
function FundingCurveChart({ curve, tlp }: { curve: ZeroCurve; tlp: TLPCurve }) {
  const data = useMemo(() => {
    const tenors = [
      1 / 12, 3 / 12, 6 / 12, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10,
      12, 15, 18, 20, 25, 30,
    ];
    return tenors.map((t) => {
      const sofr = curve.zeroRate(t);
      const lp = tlp.tlp(t);
      return {
        t,
        sofr,
        allIn: sofr + lp,
        tlpBps: lp * 10000,
      };
    });
  }, [curve, tlp]);

  return (
    <div className="dash-card" style={{ marginTop: 16, height: 380 }}>
      <div className="group-label">Funding curve: SOFR, TLP, all-in (SOFR + TLP)</div>
      <p className="form-helper" style={{ marginTop: -4, marginBottom: 8 }}>
        SOFR is the bank's risk-free funding benchmark. TLP (FHLB − SOFR) is the term
        liquidity premium the bank actually pays for matched-tenor funding. The all-in
        curve = SOFR + TLP is the funding cost an instrument is par-matched against
        for FTP. Right axis shows TLP in bps so the spread is legible.
      </p>
      <ResponsiveContainer width="100%" height="80%">
        <LineChart data={data} margin={{ top: 16, right: 72, bottom: 36, left: 72 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
          <XAxis
            dataKey="t"
            type="number"
            domain={[0, 30]}
            ticks={[0, 1, 2, 3, 5, 7, 10, 15, 20, 25, 30]}
            stroke={COLORS.obsidian}
            tick={{ fontSize: 12, fill: COLORS.obsidian }}
            tickFormatter={(v) => `${v}Y`}
            label={{ value: "Tenor (years)", position: "insideBottom", offset: -8, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
          />
          <YAxis
            yAxisId="rate"
            stroke={COLORS.obsidian}
            tick={{ fontSize: 12, fill: COLORS.obsidian }}
            tickFormatter={(v) => `${(v * 100).toFixed(2)}%`}
            label={{ value: "Rate", angle: -90, position: "insideLeft", dx: -16, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
          />
          <YAxis
            yAxisId="tlp"
            orientation="right"
            stroke={COLORS.obsidian}
            tick={{ fontSize: 12, fill: COLORS.obsidian }}
            tickFormatter={(v) => `${v.toFixed(0)} bps`}
            label={{ value: "TLP (bps)", angle: 90, position: "insideRight", dx: 16, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
          />
          <Tooltip
            formatter={(v: unknown, name: string) => {
              if (typeof v !== "number" || !Number.isFinite(v)) return ["—", name];
              if (name === "TLP") return [`${v.toFixed(0)} bps`, name];
              return [`${(v * 100).toFixed(3)}%`, name];
            }}
            labelFormatter={(v) => (typeof v === "number" ? `${v.toFixed(2)}Y` : "")}
          />
          <Line
            yAxisId="rate"
            type="monotone"
            dataKey="sofr"
            stroke={COLORS.obsidian}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            name="SOFR"
          />
          <Line
            yAxisId="rate"
            type="monotone"
            dataKey="allIn"
            stroke={COLORS.nodeTeal}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            name="All-in (SOFR + TLP)"
          />
          <Line
            yAxisId="tlp"
            type="monotone"
            dataKey="tlpBps"
            stroke={COLORS.nodeOrange}
            strokeWidth={2}
            strokeDasharray="4 4"
            dot={false}
            isAnimationActive={false}
            name="TLP"
          />
          <Legend verticalAlign="top" height={28} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function CouponVsFtpChart({ row }: { row: FtpInstrumentRow }) {
  const data = row.monthlySeries;
  const isFixed = data.length > 0 && data.every((r) => Math.abs(r.couponRate - data[0].couponRate) < 1e-12);
  const isLiability = row.side === "liability";
  let helperText: string;
  if (isLiability && isFixed) {
    // NMD-A: zero coupon (non-interest-bearing). The all-in FTP credit is the
    // franchise value the deposit earns by funding longer-tenor assets. The
    // credit assumes the entire balance is stable / core — no carve-out for
    // stress, HQLA, or run-rate haircuts (see the disclosure under the
    // decomposition table above).
    helperText =
      "Coupon line is flat at 0% because NMD-A is non-interest-bearing. The all-in FTP line is the matched-funding credit the deposit franchise earns under the assumption that the entire cohort is stable core funding; no portion is haircut for stress or liquidity buffer. The vertical gap is the gross FTP credit captured as positive franchise value (NIM contribution from the deposit).";
  } else if (isLiability) {
    // IB NMD: the deposit funds in two slices — a (1 − β) rate-locked slice
    // that earns the long-tenor par-matched all-in credit (NMD-A-style), and
    // a β slice that funds at 1M SOFR + 1M TLP and reprices monthly. Both
    // lines move: D(t) rises with the market via β · Δr, and the FTP line
    // rises because the β fraction tracks the 1M forward. The closing gap is
    // the franchise compression from β-driven repricing.
    helperText =
      "IB NMD funds in two slices: (1 − β) is rate-locked at the long-tenor par-matched credit; β reprices each month at 1M SOFR + 1M TLP. The FTP line is the blend (1 − β) · fixed + β · 1M SOFR, so it rises with the 1M forward. The deposit rate D(t) rises in lockstep via ΔD = λ · β · Δr. The closing vertical gap is franchise-value compression as deposit pricing catches up to market: β-driven repricing risk realised through NIM.";
  } else if (isFixed) {
    helperText =
      "Both lines are flat: a fixed coupon is match-funded at a fixed all-in rate, locking the FTP margin in for the life of the loan.";
  } else {
    helperText =
      "Both lines float in lockstep at each reset: the floating coupon picks up SOFR + margin, the funding rate picks up SOFR + TLP at the reset tenor. The vertical gap (coupon − FTP) is the locked FTP margin.";
  }
  return (
    <div className="dash-card" style={{ marginTop: 16, height: 380 }}>
      <div className="group-label">{row.label}: coupon vs FTP funding rate</div>
      <p className="form-helper" style={{ marginTop: -4, marginBottom: 8 }}>
        {helperText}
      </p>
      <ResponsiveContainer width="100%" height="80%">
        <LineChart data={data} margin={{ top: 16, right: 24, bottom: 36, left: 72 }}>
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
            label={{ value: "Rate", angle: -90, position: "insideLeft", dx: -16, style: { fontSize: 12, fill: "rgba(18,19,18,0.65)" } }}
          />
          <Tooltip
            formatter={(v: unknown, name: string) =>
              typeof v === "number" && Number.isFinite(v) ? [fmtPct(v), name] : ["—", name]
            }
            labelFormatter={(v) => (typeof v === "number" ? `month ${v}` : "")}
          />
          <Line
            type={isFixed ? "linear" : "stepAfter"}
            dataKey="couponRate"
            stroke={COLORS.nodeOrange}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            name="Coupon"
          />
          <Line
            type={isFixed ? "linear" : "stepAfter"}
            dataKey="ftpRate"
            stroke={COLORS.nodeTeal}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            name="All-in FTP funding rate"
          />
          <Legend verticalAlign="top" height={28} wrapperStyle={LEGEND_STYLE} formatter={darkLegendFormatter} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function FundingCurveTable({ curve, tlp }: { curve: ZeroCurve; tlp: TLPCurve }) {
  const tenors = useMemo(
    () => [
      1 / 12, 3 / 12, 6 / 12, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10,
      12, 15, 18, 20, 25, 30,
    ],
    [],
  );
  const rows = tenors.map((t) => {
    const sofr = curve.zeroRate(t);
    const lp = tlp.tlp(t);
    return { t, sofr, allIn: sofr + lp, lpBps: lp * 1e4 };
  });
  const fmtTenor = (t: number) => (t < 1 ? `${Math.round(t * 12)}M` : `${t}Y`);
  return (
    <div className="dash-card" style={{ marginTop: 16 }}>
      <div className="group-label">Funding curve: data table</div>
      <p className="form-helper" style={{ marginTop: -4, marginBottom: 8 }}>
        SOFR zero rate, TLP (FHLB − SOFR), and the all-in (SOFR + TLP) funding curve at the
        same tenor grid plotted above. All-in is the discount basis used for par-matching
        each instrument's all-in FTP rate.
      </p>
      <div style={{ maxHeight: 280, overflowY: "auto", border: "1px solid rgba(18,19,18,0.08)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
          <thead style={{ position: "sticky", top: 0, background: "var(--cloud-dancer)", boxShadow: "inset 0 -1px 0 rgba(18,19,18,0.15)" }}>
            <tr>
              <Th align="right">Tenor</Th>
              <Th align="right">SOFR zero</Th>
              <Th align="right">TLP (bps)</Th>
              <Th align="right">All-in (SOFR + TLP)</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.t} style={{ borderTop: "1px solid rgba(18,19,18,0.04)" }}>
                <Td align="right">{fmtTenor(r.t)}</Td>
                <Td align="right">{(r.sofr * 100).toFixed(3)}%</Td>
                <Td align="right">{r.lpBps.toFixed(0)}</Td>
                <Td align="right">{(r.allIn * 100).toFixed(3)}%</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, align = "left" }: { children: ReactNode; align?: "left" | "right" }) {
  return (
    <th style={{ padding: "8px 12px", textAlign: align, fontWeight: 500, color: "var(--obsidian)", fontFamily: "var(--font-sans)" }}>
      {children}
    </th>
  );
}

function Td({ children, align = "left" }: { children: ReactNode; align?: "left" | "right" }) {
  return (
    <td style={{ padding: "8px 12px", textAlign: align, color: "var(--obsidian)" }}>
      {children}
    </td>
  );
}

