import { useMemo, useState } from "react";
import {
  Area,
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
import { COLORS, SERIES } from "../tokens";
import { ChartErrorBoundary } from "../components/ChartErrorBoundary";

const TENORS: ReadonlyArray<{ label: string; value: number; idx: number }> = [
  { label: "1D", value: 1 / 360, idx: 0 },
  { label: "1M", value: 1 / 12, idx: 1 },
  { label: "3M", value: 0.25, idx: 2 },
  { label: "6M", value: 0.5, idx: 3 },
  { label: "1Y", value: 1.0, idx: 4 },
  { label: "2Y", value: 2.0, idx: 5 },
  { label: "5Y", value: 5.0, idx: 6 },
  { label: "7Y", value: 7.0, idx: 7 },
  { label: "10Y", value: 10.0, idx: 8 },
  { label: "20Y", value: 20.0, idx: 9 },
  { label: "30Y", value: 30.0, idx: 10 },
];

function percentile(arr: ArrayLike<number>, q: number): number {
  const sorted = Array.from(arr).sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

interface ChartRow {
  year: number;
  mean: number;
  band: [number, number];
  sample0: number;
  sample1: number;
  sample2: number;
  sample3: number;
  sample4: number;
}

export function BgmSimTab() {
  const { bgm, bgmSim, bgmSimStatus, runBGMSimulation } = useApp();
  const [tenorIdx, setTenorIdx] = useState(4); // 1Y by default — 1D=0,1M=1,3M=2,6M=3,1Y=4

  const { chartData } = useMemo(() => {
    const empty = { chartData: null as ChartRow[] | null };
    if (!bgmSim) return empty;
    const nSteps = bgmSim.times.length;
    const nT = bgmSim.tenors.length;
    if (nSteps === 0 || bgmSim.nPaths === 0 || tenorIdx < 0 || tenorIdx >= nT) {
      return empty;
    }

    const sampleP = [
      0,
      Math.min(bgmSim.nPaths - 1, Math.floor(bgmSim.nPaths * 0.2)),
      Math.min(bgmSim.nPaths - 1, Math.floor(bgmSim.nPaths * 0.4)),
      Math.min(bgmSim.nPaths - 1, Math.floor(bgmSim.nPaths * 0.6)),
      Math.min(bgmSim.nPaths - 1, Math.floor(bgmSim.nPaths * 0.8)),
    ];

    const out: ChartRow[] = [];
    for (let k = 0; k < nSteps; k++) {
      const cs = new Float64Array(bgmSim.nPaths);
      for (let p = 0; p < bgmSim.nPaths; p++) {
        cs[p] = bgmSim.rates[(p * nSteps + k) * nT + tenorIdx];
      }
      let sum = 0;
      for (let p = 0; p < cs.length; p++) sum += cs[p];
      const meanRate = sum / cs.length;
      const lowPct = percentile(cs, 0.05) * 100;
      const highPct = percentile(cs, 0.95) * 100;
      const meanPct = meanRate * 100;
      out.push({
        year: bgmSim.times[k],
        mean: meanPct,
        band: [lowPct, highPct],
        sample0: bgmSim.rates[(sampleP[0] * nSteps + k) * nT + tenorIdx] * 100,
        sample1: bgmSim.rates[(sampleP[1] * nSteps + k) * nT + tenorIdx] * 100,
        sample2: bgmSim.rates[(sampleP[2] * nSteps + k) * nT + tenorIdx] * 100,
        sample3: bgmSim.rates[(sampleP[3] * nSteps + k) * nT + tenorIdx] * 100,
        sample4: bgmSim.rates[(sampleP[4] * nSteps + k) * nT + tenorIdx] * 100,
      });
    }
    return { chartData: out };
  }, [bgmSim, tenorIdx]);

  const martingaleRows = useMemo(() => {
    if (!bgmSim) return [];
    const targetHorizons = [1, 12, 60, 120, 240, 360];
    const labels = ["1M", "1Y", "5Y", "10Y", "20Y", "30Y"];
    return targetHorizons.map((m, i) => {
      const k = Math.min(bgmSim.times.length - 1, m - 1);
      const dfMkt = bgmSim.dfMarket[k];
      const dfSim = bgmSim.dfSimulated[k];
      const errBp = (dfSim - dfMkt) * 1e4;
      return {
        label: labels[i],
        year: bgmSim.times[k],
        dfMarket: dfMkt,
        dfSim,
        errBp,
      };
    });
  }, [bgmSim]);

  if (!bgm) {
    return (
      <div>
        <h1 className="section-title">BGM/LMM 2-factor simulation</h1>
        <p className="section-subtitle">
          Calibrate models on the SABR tab to enable BGM simulation.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="section-title">BGM/LMM 2-factor simulation</h1>
      <p className="section-subtitle">
        Hunter-Jaeckel-Joshi 2001 predictor-corrector with martingale correction. Long-horizon tenors (≥ 20Y) inherit the F_CEILING bound.
      </p>

      <div className="dash-card">
        <div className="group-label">Controls</div>
        <div className="form-row">
          <span className="form-label">Tenor τ for fan</span>
          <select
            className="form-input"
            value={tenorIdx}
            onChange={(e) => setTenorIdx(parseInt(e.target.value, 10))}
          >
            {TENORS.map((t) => (
              <option key={t.label} value={t.idx}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <button
            type="button"
            className="btn btn-filled"
            onClick={() => void runBGMSimulation()}
            disabled={bgmSimStatus === "running"}
          >
            {bgmSimStatus === "running" ? "Simulating…" : "Run BGM simulation →"}
          </button>
          <span className={`status-pill status-${bgmSimStatus === "idle" ? "pending" : bgmSimStatus}`}>
            {bgmSimStatus.toUpperCase()}
          </span>
          {bgmSim && (
            <span className="form-helper">
              {bgmSim.nPaths} paths · cap fires {((bgmSim.nCapFires / Math.max(bgmSim.nTotalEvolutions, 1)) * 100).toFixed(3)}%
            </span>
          )}
        </div>
      </div>

      <ChartErrorBoundary label="BGM Sim fan chart">
        {chartData && bgmSim && (
          <div className="dash-card" style={{ height: 540, marginTop: 16 }}>
            <div className="group-label">{`Forward rate F(t, t+${TENORS[tenorIdx].label})`}</div>
            <ResponsiveContainer width="100%" height="92%">
              <ComposedChart data={chartData} margin={{ top: 16, right: 32, bottom: 16, left: 48 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
                <XAxis
                  dataKey="year"
                  type="number"
                  domain={[0, 30]}
                  ticks={[0, 5, 10, 15, 20, 25, 30]}
                  tickFormatter={(v) => `${Math.round(v)}y`}
                  stroke={COLORS.obsidian}
                  tick={{ fontSize: 13, fill: COLORS.obsidian }}
                />
                <YAxis
                  domain={[-5, 20]}
                  ticks={[-5, 0, 5, 10, 15, 20]}
                  allowDataOverflow={true}
                  stroke={COLORS.obsidian}
                  tick={{ fontSize: 13, fill: COLORS.obsidian }}
                  width={56}
                  tickFormatter={(v) => `${v.toFixed(0)}%`}
                />
                <Tooltip
                  formatter={(v: unknown, name: string) => {
                    if (typeof v === "number" && Number.isFinite(v)) {
                      return [`${v.toFixed(3)}%`, name];
                    }
                    if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number") {
                      return [`${v[0].toFixed(2)} – ${v[1].toFixed(2)}%`, name];
                    }
                    return ["—", name];
                  }}
                  labelFormatter={(v) =>
                    typeof v === "number" && Number.isFinite(v) ? `t = ${v.toFixed(2)}y` : ""
                  }
                />
                <Area
                  type="monotone"
                  dataKey="band"
                  stroke="none"
                  fill={SERIES.bgmBandFill}
                  isAnimationActive={false}
                  name="p5–p95 band"
                />
                <Line type="monotone" dataKey="sample0" stroke={SERIES.bgm} strokeOpacity={0.25} dot={false} strokeWidth={1} isAnimationActive={false} legendType="none" name="path 1" />
                <Line type="monotone" dataKey="sample1" stroke={SERIES.bgm} strokeOpacity={0.25} dot={false} strokeWidth={1} isAnimationActive={false} legendType="none" name="path 2" />
                <Line type="monotone" dataKey="sample2" stroke={SERIES.bgm} strokeOpacity={0.25} dot={false} strokeWidth={1} isAnimationActive={false} legendType="none" name="path 3" />
                <Line type="monotone" dataKey="sample3" stroke={SERIES.bgm} strokeOpacity={0.25} dot={false} strokeWidth={1} isAnimationActive={false} legendType="none" name="path 4" />
                <Line type="monotone" dataKey="sample4" stroke={SERIES.bgm} strokeOpacity={0.25} dot={false} strokeWidth={1} isAnimationActive={false} legendType="none" name="path 5" />
                <Line
                  type="monotone"
                  dataKey="mean"
                  stroke={SERIES.bgm}
                  strokeWidth={2.5}
                  dot={false}
                  isAnimationActive={false}
                  name="BGM mean"
                />
                <Legend
                  verticalAlign="top"
                  height={28}
                  wrapperStyle={{
                    fontSize: 12,
                    fontFamily: "var(--font-sans)",
                    color: "var(--obsidian)",
                  }}
                  formatter={(value: string) => (
                    <span style={{ color: "var(--obsidian)", fontWeight: 500 }}>{value}</span>
                  )}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </ChartErrorBoundary>

      {bgmSim && (
        <div className="dash-card" style={{ marginTop: 16 }}>
          <div className="group-label">Calibration parameters &amp; cap-fire telemetry</div>
          <div className="form-helper">
            BGM: a = {bgm.a.toFixed(4)}, b = {bgm.b.toFixed(4)}, c = {bgm.c.toFixed(4)},
            d = {bgm.d.toFixed(4)}, β = {bgm.beta.toFixed(4)}, volScalar = {bgm.volScalar.toFixed(4)}.
            RMSE {bgm.rmseBp.toFixed(2)} bp.
          </div>
          <div className="form-helper" style={{ marginTop: 4 }}>
            F_CEILING = {bgmSim.fCeiling.toFixed(2)}. Cap fires: {bgmSim.nCapFires.toLocaleString()}/
            {bgmSim.nTotalEvolutions.toLocaleString()} evolutions
            ({((bgmSim.nCapFires / Math.max(bgmSim.nTotalEvolutions, 1)) * 100).toFixed(3)}%).
          </div>
        </div>
      )}

      {bgmSim && (
        <div className="dash-card" style={{ marginTop: 16 }}>
          <div className="group-label">Martingale test (DF_market vs DF_simulated)</div>
          <div className="form-helper" style={{ marginBottom: 12 }}>
            Multiplicative martingale correction (Glasserman, Section 4.5) rescales the simulated discount factor at each
            step so the per-step expected DF matches the market exactly. A passing test shows |error| close to machine
            precision at every horizon.
          </div>
          <table className="preview">
            <thead>
              <tr>
                <th>Horizon</th>
                <th>t (years)</th>
                <th>DF market</th>
                <th>DF simulated</th>
                <th>Error (bp)</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {martingaleRows.map((r) => {
                const pass = Math.abs(r.errBp) < 0.001;
                return (
                  <tr key={r.label}>
                    <td>{r.label}</td>
                    <td>{r.year.toFixed(2)}</td>
                    <td>{r.dfMarket.toFixed(8)}</td>
                    <td>{r.dfSim.toFixed(8)}</td>
                    <td>{r.errBp.toExponential(2)}</td>
                    <td>
                      <span className={`status-pill status-${pass ? "ready" : "error"}`}>
                        {pass ? "PASS" : "FAIL"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
