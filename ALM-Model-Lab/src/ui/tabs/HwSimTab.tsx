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
import { projectHWToTenor } from "../../math/rates/simulateHw";
import { ChartErrorBoundary } from "../components/ChartErrorBoundary";

const TENORS: ReadonlyArray<{ label: string; value: number }> = [
  { label: "1D", value: 1 / 360 },
  { label: "1M", value: 1 / 12 },
  { label: "3M", value: 0.25 },
  { label: "6M", value: 0.5 },
  { label: "1Y", value: 1.0 },
  { label: "2Y", value: 2.0 },
  { label: "5Y", value: 5.0 },
  { label: "10Y", value: 10.0 },
  { label: "20Y", value: 20.0 },
  { label: "30Y", value: 30.0 },
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

export function HwSimTab() {
  const { hw, hwSim, hwSimStatus, runHWSimulation, curve } = useApp();
  const [tenor, setTenor] = useState(1);

  const { chartData } = useMemo(() => {
    const empty = { chartData: null as ChartRow[] | null };
    if (!hwSim || !curve) return empty;
    if (hwSim.nPaths === 0 || hwSim.times.length === 0) return empty;

    const fwd = projectHWToTenor(hwSim, curve, tenor);
    if (fwd.length === 0) return empty;

    const out: ChartRow[] = [];
    const nSteps = hwSim.times.length;
    const sampleP = [
      0,
      Math.min(fwd.length - 1, Math.floor(fwd.length * 0.2)),
      Math.min(fwd.length - 1, Math.floor(fwd.length * 0.4)),
      Math.min(fwd.length - 1, Math.floor(fwd.length * 0.6)),
      Math.min(fwd.length - 1, Math.floor(fwd.length * 0.8)),
    ];
    for (let k = 0; k < nSteps; k++) {
      const cs = new Float64Array(fwd.length);
      for (let p = 0; p < fwd.length; p++) cs[p] = fwd[p][k];
      let sum = 0;
      for (let p = 0; p < cs.length; p++) sum += cs[p];
      const meanRate = sum / cs.length;
      const low = percentile(cs, 0.05);
      const high = percentile(cs, 0.95);
      const meanPct = meanRate * 100;
      const lowPct = low * 100;
      const highPct = high * 100;
      out.push({
        year: hwSim.times[k],
        mean: meanPct,
        band: [lowPct, highPct],
        sample0: fwd[sampleP[0]][k] * 100,
        sample1: fwd[sampleP[1]][k] * 100,
        sample2: fwd[sampleP[2]][k] * 100,
        sample3: fwd[sampleP[3]][k] * 100,
        sample4: fwd[sampleP[4]][k] * 100,
      });
    }

    return { chartData: out };
  }, [hwSim, curve, tenor]);

  // Martingale diagnostic — DF_market vs DF_simulated at canonical horizons.
  const martingaleRows = useMemo(() => {
    if (!hwSim) return [];
    const targetHorizons = [1, 12, 60, 120, 240, 360]; // months: 1M, 1Y, 5Y, 10Y, 20Y, 30Y
    const labels = ["1M", "1Y", "5Y", "10Y", "20Y", "30Y"];
    return targetHorizons.map((m, i) => {
      const k = Math.min(hwSim.times.length - 1, m - 1);
      const dfMkt = hwSim.dfMarket[k];
      const dfSim = hwSim.dfSimulated[k];
      const errBp = (dfSim - dfMkt) * 1e4;
      return {
        label: labels[i],
        year: hwSim.times[k],
        dfMarket: dfMkt,
        dfSim,
        errBp,
      };
    });
  }, [hwSim]);

  if (!hw) {
    return (
      <div>
        <h1 className="section-title">Hull-White 1F simulation</h1>
        <p className="section-subtitle">
          Calibrate models on the SABR tab to enable HW simulation.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="section-title">Hull-White 1F simulation</h1>
      <p className="section-subtitle">
        Exact transition for X under shifted-Gaussian HW with antithetic pairing and multiplicative martingale correction.
      </p>

      <div className="dash-card">
        <div className="group-label">Controls</div>
        <div className="form-row">
          <span className="form-label">Tenor τ for fan</span>
          <select
            className="form-input"
            value={tenor}
            onChange={(e) => setTenor(parseFloat(e.target.value))}
          >
            {TENORS.map((t) => (
              <option key={t.label} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <button
            type="button"
            className="btn btn-filled"
            onClick={() => void runHWSimulation()}
            disabled={hwSimStatus === "running"}
          >
            {hwSimStatus === "running" ? "Simulating…" : "Run HW simulation →"}
          </button>
          <span className={`status-pill status-${hwSimStatus === "idle" ? "pending" : hwSimStatus}`}>
            {hwSimStatus.toUpperCase()}
          </span>
          {hwSim && (
            <span className="form-helper">
              {hwSim.nPaths} paths · seed {String(hwSim.seed)} · {hwSim.times.length} steps
            </span>
          )}
        </div>
      </div>

      <ChartErrorBoundary label="HW Sim fan chart">
        {chartData && hwSim && (
          <div className="dash-card" style={{ height: 540, marginTop: 16 }}>
            <div className="group-label">{`Forward rate F(t, t+${tenor}y)`}</div>
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
                  fill={SERIES.hwBandFill}
                  isAnimationActive={false}
                  name="p5–p95 band"
                  connectNulls={false}
                />
                <Line type="monotone" dataKey="sample0" stroke={SERIES.hw} strokeOpacity={0.25} dot={false} strokeWidth={1} isAnimationActive={false} legendType="none" name="path 1" />
                <Line type="monotone" dataKey="sample1" stroke={SERIES.hw} strokeOpacity={0.25} dot={false} strokeWidth={1} isAnimationActive={false} legendType="none" name="path 2" />
                <Line type="monotone" dataKey="sample2" stroke={SERIES.hw} strokeOpacity={0.25} dot={false} strokeWidth={1} isAnimationActive={false} legendType="none" name="path 3" />
                <Line type="monotone" dataKey="sample3" stroke={SERIES.hw} strokeOpacity={0.25} dot={false} strokeWidth={1} isAnimationActive={false} legendType="none" name="path 4" />
                <Line type="monotone" dataKey="sample4" stroke={SERIES.hw} strokeOpacity={0.25} dot={false} strokeWidth={1} isAnimationActive={false} legendType="none" name="path 5" />
                <Line
                  type="monotone"
                  dataKey="mean"
                  stroke={SERIES.hw}
                  strokeWidth={2.5}
                  dot={false}
                  isAnimationActive={false}
                  name="HW mean"
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

      {hwSim && (
        <div className="dash-card" style={{ marginTop: 16 }}>
          <div className="group-label">Calibration parameters</div>
          <div className="form-helper">
            HW: a = {hw.a.toExponential(3)}, σ = {hw.sigma.toFixed(6)}, calibration RMSE {hw.rmseBp.toFixed(2)} bp.
          </div>
        </div>
      )}

      {hwSim && (
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
