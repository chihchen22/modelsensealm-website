import { useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
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

const SINGLE_TENORS: ReadonlyArray<{ label: string; value: number; bgmIdx: number }> = [
  { label: "1D", value: 1 / 360, bgmIdx: 0 },
  { label: "1M", value: 1 / 12, bgmIdx: 1 },
  { label: "3M", value: 0.25, bgmIdx: 2 },
  { label: "6M", value: 0.5, bgmIdx: 3 },
  { label: "1Y", value: 1.0, bgmIdx: 4 },
  { label: "2Y", value: 2.0, bgmIdx: 5 },
  { label: "5Y", value: 5.0, bgmIdx: 6 },
  { label: "7Y", value: 7.0, bgmIdx: 7 },
  { label: "10Y", value: 10.0, bgmIdx: 8 },
  { label: "20Y", value: 20.0, bgmIdx: 9 },
  { label: "30Y", value: 30.0, bgmIdx: 10 },
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

function bgmTenorAtIdx(
  rates: Float64Array,
  nSteps: number,
  nTenors: number,
  nPaths: number,
  step: number,
  tenorIdx: number,
): Float64Array {
  const cs = new Float64Array(nPaths);
  for (let p = 0; p < nPaths; p++) {
    cs[p] = rates[(p * nSteps + step) * nTenors + tenorIdx];
  }
  return cs;
}

export function CompareTab() {
  const { hwSim, bgmSim, curve } = useApp();
  const [singleIdx, setSingleIdx] = useState(4); // 1Y default — 1D=0,1M=1,3M=2,6M=3,1Y=4
  const [shortIdx, setShortIdx] = useState(1); // 1M default
  const [longIdx, setLongIdx] = useState(8); // 10Y default

  const singleData = useMemo(() => {
    if (!hwSim || !bgmSim || !curve) return null;
    const tenor = SINGLE_TENORS[singleIdx];
    const hwFwd = projectHWToTenor(hwSim, curve, tenor.value);
    const nSteps = hwSim.times.length;
    const nT = bgmSim.tenors.length;
    const out: Array<{
      year: number;
      hwMean: number;
      hwBand: [number, number];
      bgmMean: number;
      bgmBand: [number, number];
    }> = [];
    for (let k = 0; k < nSteps; k++) {
      const hwCs = new Float64Array(hwSim.nPaths);
      for (let p = 0; p < hwSim.nPaths; p++) hwCs[p] = hwFwd[p][k];
      const bgmCs = bgmTenorAtIdx(bgmSim.rates, nSteps, nT, bgmSim.nPaths, k, tenor.bgmIdx);
      const hwMean = Array.from(hwCs).reduce((s, v) => s + v, 0) / hwCs.length;
      const bgmMean = Array.from(bgmCs).reduce((s, v) => s + v, 0) / bgmCs.length;
      out.push({
        year: hwSim.times[k],
        hwMean: hwMean * 100,
        hwBand: [percentile(hwCs, 0.05) * 100, percentile(hwCs, 0.95) * 100],
        bgmMean: bgmMean * 100,
        bgmBand: [percentile(bgmCs, 0.05) * 100, percentile(bgmCs, 0.95) * 100],
      });
    }
    return out;
  }, [hwSim, bgmSim, curve, singleIdx]);

  const spreadData = useMemo(() => {
    if (!hwSim || !bgmSim || !curve) return null;
    if (shortIdx >= longIdx) return null;
    const shortT = SINGLE_TENORS[shortIdx];
    const longT = SINGLE_TENORS[longIdx];
    const hwShort = projectHWToTenor(hwSim, curve, shortT.value);
    const hwLong = projectHWToTenor(hwSim, curve, longT.value);
    const nSteps = hwSim.times.length;
    const nT = bgmSim.tenors.length;
    const out: Array<{
      year: number;
      hwMean: number;
      hwBand: [number, number];
      bgmMean: number;
      bgmBand: [number, number];
    }> = [];
    for (let k = 0; k < nSteps; k++) {
      const hwSpread = new Float64Array(hwSim.nPaths);
      for (let p = 0; p < hwSim.nPaths; p++) {
        hwSpread[p] = hwLong[p][k] - hwShort[p][k];
      }
      const bgmShortCs = bgmTenorAtIdx(bgmSim.rates, nSteps, nT, bgmSim.nPaths, k, shortT.bgmIdx);
      const bgmLongCs = bgmTenorAtIdx(bgmSim.rates, nSteps, nT, bgmSim.nPaths, k, longT.bgmIdx);
      const bgmSpread = new Float64Array(bgmSim.nPaths);
      for (let p = 0; p < bgmSim.nPaths; p++) {
        bgmSpread[p] = bgmLongCs[p] - bgmShortCs[p];
      }
      const hwMean = Array.from(hwSpread).reduce((s, v) => s + v, 0) / hwSpread.length;
      const bgmMean = Array.from(bgmSpread).reduce((s, v) => s + v, 0) / bgmSpread.length;
      out.push({
        year: hwSim.times[k],
        hwMean: hwMean * 1e4, // bps
        hwBand: [percentile(hwSpread, 0.05) * 1e4, percentile(hwSpread, 0.95) * 1e4],
        bgmMean: bgmMean * 1e4,
        bgmBand: [percentile(bgmSpread, 0.05) * 1e4, percentile(bgmSpread, 0.95) * 1e4],
      });
    }
    return out;
  }, [hwSim, bgmSim, curve, shortIdx, longIdx]);

  if (!hwSim || !bgmSim) {
    return (
      <div>
        <h1 className="section-title">HW vs BGM compare</h1>
        <p className="section-subtitle">Run both HW and BGM simulations to enable comparison.</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="section-title">HW vs BGM comparison</h1>
      <p className="section-subtitle">
        Same simulated horizon, same path count, two model dynamics. HW (orange) is shifted-Gaussian; BGM (teal) is lognormal LMM.
        Bands are p5/p95 across all paths at each simulation time.
      </p>

      <div className="dash-card">
        <div className="group-label">Single-tenor comparison</div>
        <div className="form-row">
          <span className="form-label">Tenor τ</span>
          <select
            className="form-input"
            value={singleIdx}
            onChange={(e) => setSingleIdx(parseInt(e.target.value, 10))}
          >
            {SINGLE_TENORS.map((t, i) => (
              <option key={t.label} value={i}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <ChartErrorBoundary label="Compare single-tenor chart">
      {singleData && (
        <div className="dash-card" style={{ height: 460, marginTop: 16 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={singleData} margin={{ top: 8, right: 24, bottom: 8, left: 16 }}>
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
                  if (typeof v === "number" && Number.isFinite(v)) return [`${v.toFixed(3)}%`, name];
                  if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number") {
                    return [`${v[0].toFixed(2)} – ${v[1].toFixed(2)}%`, name];
                  }
                  return ["—", name];
                }}
                labelFormatter={(v) =>
                  typeof v === "number" && Number.isFinite(v) ? `t = ${v.toFixed(2)}y` : ""
                }
              />
              <Area dataKey="hwBand" fill={SERIES.hwBandFill} stroke="none" isAnimationActive={false} name="HW p5/p95" />
              <Area dataKey="bgmBand" fill={SERIES.bgmBandFill} stroke="none" isAnimationActive={false} name="BGM p5/p95" />
              <Line type="monotone" dataKey="hwMean" stroke={SERIES.hw} strokeWidth={2.5} dot={false} isAnimationActive={false} name="HW mean" />
              <Line type="monotone" dataKey="bgmMean" stroke={SERIES.bgm} strokeWidth={2.5} dot={false} isAnimationActive={false} name="BGM mean" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
      </ChartErrorBoundary>

      <div className="dash-card" style={{ marginTop: 24 }}>
        <div className="group-label">Term spread</div>
        <div className="form-row">
          <span className="form-label">Short tenor</span>
          <select
            className="form-input"
            value={shortIdx}
            onChange={(e) => setShortIdx(parseInt(e.target.value, 10))}
          >
            {SINGLE_TENORS.map((t, i) => (
              <option key={t.label} value={i}>
                {t.label}
              </option>
            ))}
          </select>
          <span className="form-label" style={{ minWidth: 0, marginLeft: 24 }}>
            Long tenor
          </span>
          <select
            className="form-input"
            value={longIdx}
            onChange={(e) => setLongIdx(parseInt(e.target.value, 10))}
          >
            {SINGLE_TENORS.map((t, i) => (
              <option key={t.label} value={i}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        {shortIdx >= longIdx && (
          <div className="form-helper" style={{ color: "#b42828" }}>
            Short tenor must be less than long tenor.
          </div>
        )}
      </div>

      <ChartErrorBoundary label="Compare term-spread chart">
      {spreadData && (
        <div className="dash-card" style={{ height: 460, marginTop: 16 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={spreadData} margin={{ top: 8, right: 24, bottom: 8, left: 16 }}>
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
                domain={[-500, 1000]}
                ticks={[-500, -250, 0, 250, 500, 750, 1000]}
                allowDataOverflow={true}
                stroke={COLORS.obsidian}
                tick={{ fontSize: 13, fill: COLORS.obsidian }}
                width={64}
                tickFormatter={(v) => `${Math.round(v)}bp`}
              />
              <Tooltip
                formatter={(v: unknown, name: string) => {
                  if (typeof v === "number" && Number.isFinite(v)) return [`${v.toFixed(2)} bp`, name];
                  if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number") {
                    return [`${v[0].toFixed(1)} – ${v[1].toFixed(1)} bp`, name];
                  }
                  return ["—", name];
                }}
                labelFormatter={(v) =>
                  typeof v === "number" && Number.isFinite(v) ? `t = ${v.toFixed(2)}y` : ""
                }
              />
              <Area dataKey="hwBand" fill={SERIES.hwBandFill} stroke="none" isAnimationActive={false} name="HW p5/p95" />
              <Area dataKey="bgmBand" fill={SERIES.bgmBandFill} stroke="none" isAnimationActive={false} name="BGM p5/p95" />
              <Line type="monotone" dataKey="hwMean" stroke={SERIES.hw} strokeWidth={2.5} dot={false} isAnimationActive={false} name="HW spread" />
              <Line type="monotone" dataKey="bgmMean" stroke={SERIES.bgm} strokeWidth={2.5} dot={false} isAnimationActive={false} name="BGM spread" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
      </ChartErrorBoundary>
    </div>
  );
}
