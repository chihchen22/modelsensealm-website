import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ComposedChart,
} from "recharts";

import { buildCurveWorkbook, downloadXlsx } from "../../storage/analyticsExport";
import { useApp } from "../state/AppContext";
import { COLORS, SERIES } from "../tokens";

type ViewMode = "zero" | "forward" | "discount";

const FORWARD_TENORS: ReadonlyArray<{ label: string; value: number }> = [
  { label: "1D", value: 1 / 360 },
  { label: "1M", value: 1 / 12 },
  { label: "3M", value: 0.25 },
  { label: "6M", value: 0.5 },
  { label: "1Y", value: 1.0 },
  { label: "2Y", value: 2.0 },
  { label: "5Y", value: 5.0 },
  { label: "10Y", value: 10.0 },
];

const ACT_360_ANNUAL = 365 / 360;

/**
 * All-in forward rate matching the ZeroCurve.forwardSwapRate convention:
 *   τ < 1Y → simple-compounded forward
 *   τ ≥ 1Y integer → par swap rate on annual ACT/360 fixed schedule
 * Operates on the synthetic all-in DF P_AI(t) = exp(-(z(t) + tlp(t)) · t).
 */
function allInForward(
  dfAI: (u: number) => number,
  t1: number,
  t2: number,
): number {
  const tau = t2 - t1;
  if (tau <= 1.0 + 1e-9) {
    return (dfAI(t1) / dfAI(t2) - 1) / tau;
  }
  const n = Math.round(tau);
  let annuity = 0;
  for (let k = 1; k <= n; k++) annuity += ACT_360_ANNUAL * dfAI(t1 + k);
  return (dfAI(t1) - dfAI(t1 + n)) / annuity;
}

export function CurveTab() {
  const { snapshot, curve, tlpCurve } = useApp();
  const [view, setView] = useState<ViewMode>("forward");
  const [forwardTenor, setForwardTenor] = useState(1.0);

  const data = useMemo(() => {
    if (!curve) return [];
    const out: Array<{
      year: number;
      zero: number;
      forward: number;
      df: number;
      aiZero: number;
      aiForward: number;
      aiDf: number;
    }> = [];
    const aiDf = (u: number) => Math.exp(-(curve.zeroRate(u) + tlpCurve.tlp(u)) * u);
    for (let m = 1; m <= 360; m++) {
      const t = m / 12;
      const z = curve.zeroRate(t);
      const fwd = curve.forwardSwapRate(t, t + forwardTenor);
      const df = curve.discountFactor(t);
      const spread = tlpCurve.tlp(t);
      const aiDft = aiDf(t);
      const aiFwd = allInForward(aiDf, t, t + forwardTenor);
      out.push({
        year: t,
        zero: z * 100,
        forward: fwd * 100,
        df,
        aiZero: (z + spread) * 100,
        aiForward: aiFwd * 100,
        aiDf: aiDft,
      });
    }
    return out;
  }, [curve, tlpCurve, forwardTenor]);

  const marketDots = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.curveQuotes.map((q) => ({
      year: q.tYears,
      zero: q.rate * 100,
    }));
  }, [snapshot]);

  if (!snapshot || !curve) {
    return (
      <div>
        <h1 className="section-title">Curve</h1>
        <p className="section-subtitle">Load market data to see the bootstrapped curve.</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="section-title">Bootstrapped zero curve</h1>
      <p className="section-subtitle">
        SOFR OIS, ACT/360 day count, annual fixed schedule, Brent root finding. Forwards quoted as
        par swap rates (annual ACT/360 fixed) for τ ≥ 1Y; simple-compounded for τ &lt; 1Y. All-in = SOFR + TLP.
      </p>

      <div className="form-row" style={{ marginBottom: 16 }}>
        <div role="tablist" style={{ display: "flex", gap: 4 }}>
          {(["zero", "forward", "discount"] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={`btn ${view === v ? "btn-filled" : "btn-ghost"}`}
              onClick={() => setView(v)}
            >
              {v === "zero" ? "Zero" : v === "forward" ? "Forward" : "Discount"}
            </button>
          ))}
        </div>
        {view === "forward" && (
          <>
            <span className="form-label" style={{ minWidth: 0, marginLeft: 24 }}>
              Tenor τ
            </span>
            <select
              className="form-input"
              value={forwardTenor}
              onChange={(e) => setForwardTenor(parseFloat(e.target.value))}
            >
              {FORWARD_TENORS.map((t) => (
                <option key={t.label} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </>
        )}
        <button
          type="button"
          className="btn btn-ghost"
          style={{ marginLeft: "auto" }}
          onClick={() => {
            const bytes = buildCurveWorkbook({ curve, forwardTenor, tlp: tlpCurve });
            downloadXlsx(bytes, "curve.xlsx");
          }}
        >
          Export to Excel
        </button>
      </div>

      <div className="dash-card" style={{ height: 420 }}>
        <ResponsiveContainer width="100%" height="100%">
          {view === "discount" ? (
            <LineChart data={data} margin={{ top: 16, right: 24, bottom: 16, left: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
              <XAxis
                dataKey="year"
                tickFormatter={(v) => `${v.toFixed(0)}y`}
                stroke={COLORS.obsidian}
                style={{ fontSize: 12 }}
              />
              <YAxis stroke={COLORS.obsidian} style={{ fontSize: 12 }} domain={[0, 1]} />
              <Tooltip formatter={(v: number) => v.toFixed(4)} labelFormatter={(v: number) => `t = ${v.toFixed(2)}y`} />
              <Legend />
              <Line type="monotone" dataKey="df" stroke={COLORS.obsidian} dot={false} strokeWidth={2} name="SOFR DF(0,t)" isAnimationActive={false} />
              <Line type="monotone" dataKey="aiDf" stroke={COLORS.nodeGreen} dot={false} strokeWidth={2} name="All-in DF(0,t)" isAnimationActive={false} />
            </LineChart>
          ) : (
            <ComposedChart data={data} margin={{ top: 16, right: 24, bottom: 16, left: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
              <XAxis
                dataKey="year"
                type="number"
                domain={[0, 30]}
                tickFormatter={(v) => `${v.toFixed(0)}y`}
                stroke={COLORS.obsidian}
                style={{ fontSize: 12 }}
              />
              <YAxis stroke={COLORS.obsidian} style={{ fontSize: 12 }} tickFormatter={(v) => `${v.toFixed(2)}%`} />
              <Tooltip
                formatter={(v: number) => `${v.toFixed(4)}%`}
                labelFormatter={(v: number) => `t = ${v.toFixed(2)}y`}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey={view === "zero" ? "zero" : "forward"}
                stroke={COLORS.obsidian}
                dot={false}
                strokeWidth={2}
                name={
                  view === "zero"
                    ? "SOFR zero"
                    : `SOFR ${forwardTenor > 1 ? "swap" : "forward"} (τ = ${forwardTenor < 1 ? `${forwardTenor.toFixed(4)}y` : `${forwardTenor}y`})`
                }
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey={view === "zero" ? "aiZero" : "aiForward"}
                stroke={COLORS.nodeGreen}
                dot={false}
                strokeWidth={2}
                name={
                  view === "zero"
                    ? "All-in zero"
                    : `All-in ${forwardTenor > 1 ? "swap" : "forward"} (τ = ${forwardTenor < 1 ? `${forwardTenor.toFixed(4)}y` : `${forwardTenor}y`})`
                }
                isAnimationActive={false}
              />
            </ComposedChart>
          )}
        </ResponsiveContainer>
      </div>

      {view === "zero" && (
        <div className="dash-card" style={{ height: 280, marginTop: 16 }}>
          <div className="group-label">Market quotes</div>
          <ResponsiveContainer width="100%" height="80%">
            <ScatterChart margin={{ top: 8, right: 24, bottom: 8, left: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
              <XAxis
                dataKey="year"
                type="number"
                domain={[0, 30]}
                tickFormatter={(v) => `${v.toFixed(0)}y`}
                stroke={COLORS.obsidian}
                style={{ fontSize: 12 }}
              />
              <YAxis dataKey="zero" stroke={COLORS.obsidian} style={{ fontSize: 12 }} tickFormatter={(v) => `${v.toFixed(2)}%`} />
              <Tooltip formatter={(v: number) => `${v.toFixed(4)}%`} />
              <Scatter data={marketDots} fill={SERIES.market} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
