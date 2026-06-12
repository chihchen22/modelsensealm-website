import { useEffect, useMemo, useState } from "react";
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
import { COLORS, SERIES } from "../tokens";
import {
  firstCompleteIndex,
  loadRateHistoryOnce,
  trailingMASeries,
  type RateHistory,
} from "../../math/rates/rateHistory";

/**
 * Historical rate viewer: Oct 2008 - Mar 2026 month-end series with a
 * trailing-MA overlay. The MA(k) of the k-month tenor IS the deposit-tractor
 * replicating pillar's steady-state yield, so the overlay doubles as the
 * teaching device for the upcoming Replicating Portfolio tab.
 */

type Family = "sofr" | "fhlb" | "policy";

const PILLAR_KS = [3, 6, 12, 24, 36, 60, 120, 180] as const;

function fmtTenor(m: number): string {
  return m >= 12 && m % 12 === 0 ? `${m / 12}Y` : `${m}M`;
}

const fmtPct = (v: number) => `${v.toFixed(3)}%`;

export function RateHistoryTab() {
  const { snapshot } = useApp();
  const [history, setHistory] = useState<RateHistory | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const [family, setFamily] = useState<Family>("sofr");
  const [tenor, setTenor] = useState(12);
  const [maOn, setMaOn] = useState(true);
  const [maWindow, setMaWindow] = useState(12);
  const [fromMonth, setFromMonth] = useState("2008-10");
  const [toMonth, setToMonth] = useState("2026-03");
  const [pillarK, setPillarK] = useState(12);

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

  // Primary series for the chart and MA overlay, in decimal.
  const primary = useMemo(() => {
    if (!history) return null;
    if (family === "sofr") {
      return { label: `SOFR ${fmtTenor(tenor)}`, values: history.sofrTermSeries(tenor) };
    }
    if (family === "fhlb") {
      return { label: `FHLB ${fmtTenor(tenor)}`, values: history.fhlbTermSeries(tenor) };
    }
    return { label: "O/N SOFR", values: [...history.sofrON] };
  }, [history, family, tenor]);

  const chartData = useMemo(() => {
    if (!history || !primary) return [];
    const ma = maOn ? trailingMASeries(primary.values, maWindow) : null;
    const i0 = Math.max(0, history.indexOfMonth(fromMonth));
    const i1raw = history.indexOfMonth(toMonth);
    const i1 = i1raw === -1 ? history.months.length - 1 : i1raw;
    const out: Array<{
      m: string;
      spot: number;
      ma?: number | null;
      fedTarget?: number;
      effr?: number;
    }> = [];
    for (let i = i0; i <= i1; i++) {
      const row: (typeof out)[number] = {
        m: history.months[i],
        spot: primary.values[i] * 100,
        ma: ma && Number.isFinite(ma[i]) ? ma[i] * 100 : null,
      };
      if (family === "policy") {
        row.fedTarget = history.fedTarget[i] * 100;
        row.effr = history.effr[i] * 100;
      }
      out.push(row);
    }
    return out;
  }, [history, primary, maOn, maWindow, fromMonth, toMonth, family]);

  // Tractor pillar preview at the as-of month (snapshot calibration date,
  // falling back to the last history month).
  const pillar = useMemo(() => {
    if (!history) return null;
    const calIso = snapshot ? snapshot.calibrationDate.slice(0, 7) : null;
    let asOfIdx = calIso ? history.indexOfMonth(calIso) : -1;
    if (asOfIdx === -1) asOfIdx = history.months.length - 1;
    const k = pillarK;
    const yieldDec = history.pillarYield(asOfIdx, k);
    const spotDec = history.sofrTermRate(asOfIdx, k);
    return {
      asOfMonth: history.months[asOfIdx],
      asOfIsCalibration: calIso !== null && history.indexOfMonth(calIso) !== -1,
      k,
      walMonths: (k + 1) / 2,
      yieldDec,
      spotDec,
      lagBp: Number.isFinite(yieldDec) ? (yieldDec - spotDec) * 1e4 : NaN,
      firstComplete: history.months[firstCompleteIndex(k)] ?? null,
    };
  }, [history, snapshot, pillarK]);

  if (loadError) {
    return (
      <div>
        <h1 className="section-title">Rate history</h1>
        <div className="banner-illustrative">
          <span>Failed to load the rate history dataset: {loadError}</span>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ marginLeft: 12 }}
            onClick={() => setRetryToken((t) => t + 1)}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!history || !primary || !pillar) {
    return (
      <div>
        <h1 className="section-title">Rate history</h1>
        <p className="section-subtitle">Loading the historical rate dataset…</p>
      </div>
    );
  }

  const tenorChoices = history.tenorsMonths;

  return (
    <div>
      <h1 className="section-title">Rate history</h1>
      <p className="section-subtitle">
        {history.months.length} month-end observations, {history.months[0]} to{" "}
        {history.months[history.months.length - 1]}: Fed Funds target, EFFR, overnight SOFR, the
        SOFR term curve (1M–360M), and the FHLB advance curve. SOFR publication began Apr 2018;
        earlier SOFR values are an OIS/EFFR-based proxy splice. The trailing moving average of the
        k-month tenor is the steady-state yield of a k-month replicating pillar (deposit tractor).
      </p>

      <div className="form-row" style={{ marginBottom: 16, flexWrap: "wrap" }}>
        <div role="tablist" style={{ display: "flex", gap: 4 }}>
          {(
            [
              ["sofr", "SOFR term"],
              ["fhlb", "FHLB term"],
              ["policy", "O/N & policy"],
            ] as const
          ).map(([f, label]) => (
            <button
              key={f}
              type="button"
              className={`btn ${family === f ? "btn-filled" : "btn-ghost"}`}
              onClick={() => setFamily(f)}
            >
              {label}
            </button>
          ))}
        </div>
        {family !== "policy" && (
          <>
            <span className="form-label" style={{ minWidth: 0, marginLeft: 16 }}>
              Tenor
            </span>
            <select
              className="form-input"
              value={tenor}
              onChange={(e) => setTenor(parseInt(e.target.value, 10))}
            >
              {tenorChoices.map((t) => (
                <option key={t} value={t}>
                  {fmtTenor(t)}
                </option>
              ))}
            </select>
          </>
        )}
        <label className="form-label" style={{ minWidth: 0, marginLeft: 16 }}>
          <input
            type="checkbox"
            checked={maOn}
            onChange={(e) => setMaOn(e.target.checked)}
            style={{ marginRight: 6 }}
          />
          MA overlay
        </label>
        {maOn && (
          <>
            <span className="form-label" style={{ minWidth: 0 }}>
              k (months)
            </span>
            <input
              className="form-input"
              type="number"
              min={2}
              max={240}
              step={1}
              value={maWindow}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (Number.isFinite(v) && v >= 2 && v <= 240) setMaWindow(v);
              }}
              style={{ width: 80 }}
            />
          </>
        )}
        <span className="form-label" style={{ minWidth: 0, marginLeft: 16 }}>
          From
        </span>
        <input
          className="form-input"
          type="month"
          min={history.months[0]}
          max={history.months[history.months.length - 1]}
          value={fromMonth}
          onChange={(e) => e.target.value && setFromMonth(e.target.value)}
        />
        <span className="form-label" style={{ minWidth: 0 }}>
          To
        </span>
        <input
          className="form-input"
          type="month"
          min={history.months[0]}
          max={history.months[history.months.length - 1]}
          value={toMonth}
          onChange={(e) => e.target.value && setToMonth(e.target.value)}
        />
      </div>

      <div className="dash-card" style={{ height: 420 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 16, right: 24, bottom: 16, left: 16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
            <XAxis
              dataKey="m"
              tickFormatter={(v: string) => v.slice(0, 4)}
              interval={Math.max(0, Math.floor(chartData.length / 10))}
              stroke={COLORS.obsidian}
              style={{ fontSize: 12 }}
            />
            <YAxis
              stroke={COLORS.obsidian}
              style={{ fontSize: 12 }}
              tickFormatter={(v: number) => `${v.toFixed(1)}%`}
            />
            <Tooltip formatter={(v: number) => fmtPct(v)} labelFormatter={(v: string) => v} />
            <Legend />
            <Line
              type="monotone"
              dataKey="spot"
              stroke={COLORS.obsidian}
              dot={false}
              strokeWidth={2}
              name={`${primary.label} (spot)`}
              isAnimationActive={false}
            />
            {maOn && (
              <Line
                type="monotone"
                dataKey="ma"
                stroke={SERIES.hw}
                strokeDasharray="6 3"
                dot={false}
                strokeWidth={2}
                name={`${maWindow}M trailing MA`}
                connectNulls={false}
                isAnimationActive={false}
              />
            )}
            {family === "policy" && (
              <Line
                type="stepAfter"
                dataKey="fedTarget"
                stroke={SERIES.bgm}
                dot={false}
                strokeWidth={1.5}
                name="Fed target"
                isAnimationActive={false}
              />
            )}
            {family === "policy" && (
              <Line
                type="monotone"
                dataKey="effr"
                stroke={SERIES.sabr}
                dot={false}
                strokeWidth={1.5}
                name="EFFR"
                isAnimationActive={false}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="dash-card" style={{ marginTop: 16, maxWidth: 720 }}>
        <div className="group-label">Tractor pillar preview</div>
        <p className="form-helper" style={{ marginBottom: 12 }}>
          A k-month replicating pillar is k equal rolling bullets in the k-month tenor: a
          linear-amortizing runoff with WAL = (k+1)/2 months whose steady-state yield is the
          trailing k-month average of the k-month rate. New-money yield comes from the live curve
          on the Curve tab; the figures below are steady-state.
        </p>
        <div className="form-row" style={{ marginBottom: 12 }}>
          <span className="form-label" style={{ minWidth: 0 }}>
            Pillar k
          </span>
          <select
            className="form-input"
            value={pillarK}
            onChange={(e) => setPillarK(parseInt(e.target.value, 10))}
          >
            {PILLAR_KS.map((k) => (
              <option key={k} value={k}>
                {fmtTenor(k)} MA of {fmtTenor(k)}
              </option>
            ))}
          </select>
        </div>
        <div className="kvp-row">
          <span className="kvp-key">As-of month</span>
          <span className="kvp-value">
            {pillar.asOfMonth}
            {pillar.asOfIsCalibration ? " (calibration date)" : " (latest observation)"}
          </span>
        </div>
        <div className="kvp-row">
          <span className="kvp-key">Pillar WAL</span>
          <span className="kvp-value">
            {pillar.walMonths.toFixed(1)} months ({(pillar.walMonths / 12).toFixed(2)}y)
          </span>
        </div>
        <div className="kvp-row">
          <span className="kvp-key">Steady-state pillar yield</span>
          <span className="kvp-value">
            {Number.isFinite(pillar.yieldDec)
              ? fmtPct(pillar.yieldDec * 100)
              : `insufficient history (first complete window ${pillar.firstComplete})`}
          </span>
        </div>
        <div className="kvp-row">
          <span className="kvp-key">Spot {fmtTenor(pillar.k)} SOFR at as-of</span>
          <span className="kvp-value">{fmtPct(pillar.spotDec * 100)}</span>
        </div>
        <div className="kvp-row">
          <span className="kvp-key">Carry lag (pillar − spot)</span>
          <span className="kvp-value">
            {Number.isFinite(pillar.lagBp) ? `${pillar.lagBp.toFixed(1)} bp` : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}
