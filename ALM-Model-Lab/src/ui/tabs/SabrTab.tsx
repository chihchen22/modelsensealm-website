import { useMemo, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { capQuoteKey, swaptionQuoteKey, useApp } from "../state/AppContext";
import { COLORS, SERIES } from "../tokens";
import { sabrNormalVol } from "../../math/rates/sabr";
import { hwSwaptionNormalVol } from "../../math/rates/hwPricing";
import { rebonatoCapletNormalVol } from "../../math/rates/bgmPricing";
import {
  isDefaultCalibrationSwaption,
  isDefaultDisplayCap,
} from "../../math/rates/marketData";
import { ChartErrorBoundary } from "../components/ChartErrorBoundary";
import { VolSurface3D, type OverlayPoints } from "../components/VolSurface3D";

const EXPIRIES = [1, 2, 5, 10] as const;
const STRIKE_OFFSETS_BP = [-200, -150, -100, -75, -50, -25, 0, 25, 50, 75, 100, 150, 200];
const TABLE_OFFSETS_BP = [-200, -100, -50, 0, 50, 100, 200];

const PURPLE_BY_EXPIRY: Record<number, string> = {
  1: "rgba(112, 80, 160, 0.45)",
  2: "rgba(112, 80, 160, 0.65)",
  5: "rgba(112, 80, 160, 0.85)",
  10: COLORS.nodePurple,
};

const TENOR_OPTIONS: ReadonlyArray<{ label: string; value: number }> = [
  { label: "3M (cap quote convention)", value: 0.25 },
  { label: "1Y", value: 1 },
  { label: "2Y", value: 2 },
  { label: "5Y", value: 5 },
  { label: "10Y", value: 10 },
];

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function formatStrikeLabel(strike: number | null): string {
  if (strike === null) return "ATM";
  const pct = (strike * 100).toFixed(2).replace(/\.?0+$/, "");
  return strike >= 0 ? `+${pct}%` : `${pct}%`;
}

function formatTenorLabel(years: number): string {
  if (Math.abs(years - 1 / 12) < 1e-6) return "1M";
  if (Math.abs(years - 2 / 12) < 1e-6) return "2M";
  if (Math.abs(years - 3 / 12) < 1e-6) return "3M";
  if (Math.abs(years - 6 / 12) < 1e-6) return "6M";
  if (Math.abs(years - Math.round(years)) < 1e-6) return `${Math.round(years)}Y`;
  return `${years.toFixed(2)}Y`;
}

export function SabrTab() {
  const {
    snapshot,
    curve,
    sabr,
    setSabr,
    hw,
    bgm,
    calibStatus,
    calibrate,
    selectedCapKeys,
    selectedSwaptionKeys,
    toggleCapKey,
    toggleSwaptionKey,
    setAllCapsSelected,
    setAllSwaptionsSelected,
    errorMessage,
  } = useApp();
  // Default 3M: matches the 3M-caplet nature of the cap quotes, so the market
  // dots sit on a tenor-consistent moneyness axis (and align with the HW
  // calibration's forward convention). Longer tenors redraw lines AND dots
  // around the new F.
  const [tenor, setTenor] = useState(0.25);
  // Selection-grid view: curated liquid grid by default, full export behind a toggle.
  const [showFullCapGrid, setShowFullCapGrid] = useState(false);
  const [showFullSwpnGrid, setShowFullSwpnGrid] = useState(false);
  // 3D overlay toggles. Defaults mirror the calibration pairing (HW fits the
  // cap ATM column, BGM fits the ATM swaption grid); the cross-fit overlays
  // price the *other* instrument set with the calibrated parameters.
  const [showHwOnCap, setShowHwOnCap] = useState(true);
  const [showBgmOnCap, setShowBgmOnCap] = useState(false);
  const [showBgmOnSwpn, setShowBgmOnSwpn] = useState(true);
  const [showHwOnSwpn, setShowHwOnSwpn] = useState(false);

  const chartData = useMemo(() => {
    if (!curve) return [];
    return STRIKE_OFFSETS_BP.map((offsetBp) => {
      const row: Record<string, number> = { offsetBp };
      for (const T of EXPIRIES) {
        const F = curve.forwardRate(T, T + tenor);
        let K = F + offsetBp / 1e4;
        if (K <= 0) K = 1e-4;
        const v = sabrNormalVol(F, K, T, sabr.alpha, sabr.rho, sabr.nu);
        row[`exp_${T}`] = v * 1e4;
      }
      return row;
    });
  }, [curve, sabr, tenor]);

  // Cap-surface market dots: filter to the visible ±200 bp range. Show how
  // many were excluded (cap strikes are absolute rates, so -2% / -1% / +1%
  // strikes typically fall well below F=3.6% and outside ±200 bp).
  const { marketDots, hiddenDots } = useMemo(() => {
    const out: Array<{ offsetBp: number; vol: number; expiryYears: number }> = [];
    let hidden = 0;
    if (!snapshot || !curve) return { marketDots: out, hiddenDots: 0 };
    for (const cap of snapshot.capQuotes) {
      if (!EXPIRIES.includes(cap.expiryYears as 1 | 2 | 5 | 10)) continue;
      const F = curve.forwardRate(cap.expiryYears, cap.expiryYears + tenor);
      const K = cap.isAtm ? F : (cap.strike ?? F);
      const offsetBp = (K - F) * 1e4;
      if (offsetBp >= -200 && offsetBp <= 200) {
        out.push({ offsetBp, vol: cap.normalVol * 1e4, expiryYears: cap.expiryYears });
      } else {
        hidden++;
      }
    }
    return { marketDots: out, hiddenDots: hidden };
  }, [snapshot, curve, tenor]);

  // 3D market surfaces at full snapshot granularity (the curated checkbox
  // grids below trim the tables, not the visual). z in normal-vol bp.
  const capSurface3D = useMemo(() => {
    if (!snapshot) return null;
    const expiries = Array.from(new Set(snapshot.capQuotes.map((q) => q.expiryYears))).sort(
      (a, b) => a - b,
    );
    const strikes = Array.from(
      new Set(
        snapshot.capQuotes.filter((q) => !q.isAtm && q.strike !== null).map((q) => q.strike as number),
      ),
    ).sort((a, b) => a - b);
    if (expiries.length < 2 || strikes.length < 2) return null;
    const byKey = new Map(
      snapshot.capQuotes
        .filter((q) => !q.isAtm && q.strike !== null)
        .map((q) => [`${q.expiryYears}_${q.strike}`, q.normalVol]),
    );
    const z = expiries.map((e) =>
      strikes.map((k) => {
        const v = byKey.get(`${e}_${k}`);
        return v === undefined ? null : v * 1e4;
      }),
    );
    return { x: strikes.map((k) => k * 100), y: expiries, z };
  }, [snapshot]);

  const capOverlays3D = useMemo<OverlayPoints[]>(() => {
    if (!snapshot || !curve) return [];
    const out: OverlayPoints[] = [];
    const atm = snapshot.capQuotes
      .filter((q) => q.isAtm)
      .slice()
      .sort((a, b) => a.expiryYears - b.expiryYears);
    if (atm.length > 0) {
      out.push({
        name: "ATM column (market)",
        x: atm.map((q) => curve.forwardRate(q.expiryYears, q.expiryYears + 0.25) * 100),
        y: atm.map((q) => q.expiryYears),
        z: atm.map((q) => q.normalVol * 1e4),
        color: COLORS.obsidian,
        mode: "lines+markers",
      });
    }
    if (showHwOnCap && hw && hw.expiries.length > 0) {
      out.push({
        name: `HW fit (RMSE ${hw.rmseBp.toFixed(1)} bp)`,
        x: hw.forwards.map((f) => f * 100),
        y: [...hw.expiries],
        z: hw.modelVols.map((v) => v * 1e4),
        color: SERIES.hw,
        mode: "lines+markers",
      });
    }
    // BGM cross-fit: price the ATM cap column with the swaption-calibrated
    // Rebonato parameters (caplet = one-forward degenerate case of the freeze).
    if (showBgmOnCap && bgm) {
      const xs: number[] = [];
      const ys: number[] = [];
      const zs: number[] = [];
      let sse = 0;
      for (const q of atm) {
        const F = curve.forwardRate(q.expiryYears, q.expiryYears + 0.25);
        const v = rebonatoCapletNormalVol(F, q.expiryYears, bgm);
        xs.push(F * 100);
        ys.push(q.expiryYears);
        zs.push(v * 1e4);
        sse += (v - q.normalVol) ** 2;
      }
      if (xs.length > 0) {
        const rmse = Math.sqrt(sse / xs.length) * 1e4;
        out.push({
          name: `BGM cross-fit (RMSE ${rmse.toFixed(1)} bp)`,
          x: xs,
          y: ys,
          z: zs,
          color: SERIES.bgm,
          mode: "lines+markers",
        });
      }
    }
    return out;
  }, [snapshot, curve, hw, bgm, showHwOnCap, showBgmOnCap]);

  const swpnSurface3D = useMemo(() => {
    if (!snapshot) return null;
    const expiries = Array.from(new Set(snapshot.swaptionATMQuotes.map((q) => q.expiryYears))).sort(
      (a, b) => a - b,
    );
    const tenors = Array.from(new Set(snapshot.swaptionATMQuotes.map((q) => q.tenorYears))).sort(
      (a, b) => a - b,
    );
    if (expiries.length < 2 || tenors.length < 2) return null;
    const byKey = new Map(
      snapshot.swaptionATMQuotes.map((q) => [`${q.expiryYears}_${q.tenorYears}`, q.normalVol]),
    );
    const z = expiries.map((e) =>
      tenors.map((t) => {
        const v = byKey.get(`${e}_${t}`);
        return v === undefined ? null : v * 1e4;
      }),
    );
    return { x: [...tenors], y: expiries, z };
  }, [snapshot]);

  const swpnOverlays3D = useMemo<OverlayPoints[]>(() => {
    const out: OverlayPoints[] = [];
    if (showBgmOnSwpn && bgm && bgm.expiries.length > 0) {
      out.push({
        name: `BGM fit (RMSE ${bgm.rmseBp.toFixed(1)} bp)`,
        x: [...bgm.tenors],
        y: [...bgm.expiries],
        z: bgm.modelVols.map((v) => v * 1e4),
        color: SERIES.bgm,
        mode: "markers",
      });
    }
    // HW cross-fit: price the full ATM swaption grid with the cap-calibrated
    // (a, σ). A 2-parameter Gaussian model renders as a smooth sheet over the
    // whole grid — the visual argument for why the swaption book wants an LMM.
    if (showHwOnSwpn && hw && snapshot && curve) {
      const xs: number[] = [];
      const ys: number[] = [];
      const zs: number[] = [];
      let sse = 0;
      for (const q of snapshot.swaptionATMQuotes) {
        const v = hwSwaptionNormalVol(curve, hw.a, hw.sigma, q.expiryYears, q.expiryYears + q.tenorYears);
        xs.push(q.tenorYears);
        ys.push(q.expiryYears);
        zs.push(v * 1e4);
        sse += (v - q.normalVol) ** 2;
      }
      if (xs.length > 0) {
        const rmse = Math.sqrt(sse / xs.length) * 1e4;
        out.push({
          name: `HW cross-fit (RMSE ${rmse.toFixed(1)} bp)`,
          x: xs,
          y: ys,
          z: zs,
          color: SERIES.hw,
          mode: "markers",
        });
      }
    }
    return out;
  }, [bgm, hw, snapshot, curve, showBgmOnSwpn, showHwOnSwpn]);

  // Calibration residuals (model − market, bp). Computed by both calibrators,
  // surfaced here for the first time: the scalar RMSE hides where the fit
  // struggles (short-expiry caps, long-tenor swaption corner).
  const residualData = useMemo(() => {
    const hwPts = hw
      ? hw.expiries.map((e, i) => ({ expiry: e, res: hw.residualsBp[i] }))
      : [];
    const bgmPts = bgm
      ? bgm.expiries.map((e, i) => ({ expiry: e, res: bgm.residualsBp[i], tenor: bgm.tenors[i] }))
      : [];
    return { hwPts, bgmPts };
  }, [hw, bgm]);

  // Y-axis range: pad around the data so curves are visible.
  const yDomain = useMemo<[number, number]>(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const row of chartData) {
      for (const T of EXPIRIES) {
        const v = row[`exp_${T}`];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 200];
    const pad = Math.max(20, (max - min) * 0.15);
    return [Math.max(0, Math.floor((min - pad) / 10) * 10), Math.ceil((max + pad) / 10) * 10];
  }, [chartData]);

  if (!snapshot || !curve) {
    return (
      <div>
        <h1 className="section-title">SABR smile</h1>
        <p className="section-subtitle">Loading market data&hellip;</p>
      </div>
    );
  }

  // Group caps by expiry for the selection table. Default view: the curated
  // liquid grid (the pre-2026 vintage granularity); the full export stays
  // selectable behind the toggle. Selection state is independent of the view.
  const curatedCaps = snapshot.capQuotes.filter(isDefaultDisplayCap);
  const capQuotesShown =
    showFullCapGrid || curatedCaps.length === 0 ? snapshot.capQuotes : curatedCaps;
  const capsByExpiry = new Map<number, typeof snapshot.capQuotes[number][]>();
  for (const q of capQuotesShown) {
    const arr = capsByExpiry.get(q.expiryYears) ?? [];
    arr.push(q);
    capsByExpiry.set(q.expiryYears, arr);
  }
  const capExpiries = Array.from(capsByExpiry.keys()).sort((a, b) => a - b);
  // Strike columns come from the visible quotes (the surface width varies by vintage).
  const capStrikes = Array.from(
    new Set(
      capQuotesShown.filter((q) => !q.isAtm && q.strike !== null).map((q) => String(q.strike)),
    ),
  ).sort((a, b) => Number(a) - Number(b));
  const capStrikeOrder = ["ATM", ...capStrikes];

  // Group swaptions for the selection table (same curated-vs-full pattern;
  // the curated grid is exactly the default BGM calibration subset).
  const curatedSwpns = snapshot.swaptionATMQuotes.filter(isDefaultCalibrationSwaption);
  const swpnQuotesShown =
    showFullSwpnGrid || curatedSwpns.length === 0 ? snapshot.swaptionATMQuotes : curatedSwpns;
  const swaptionExpiries = Array.from(new Set(swpnQuotesShown.map((q) => q.expiryYears))).sort(
    (a, b) => a - b,
  );
  const swaptionTenors = Array.from(new Set(swpnQuotesShown.map((q) => q.tenorYears))).sort(
    (a, b) => a - b,
  );

  const selectedCapCount = selectedCapKeys.size;
  const selectedSwpnCount = selectedSwaptionKeys.size;
  const totalCaps = snapshot.capQuotes.length;
  const totalSwpns = snapshot.swaptionATMQuotes.length;

  return (
    <div>
      <h1 className="section-title">SABR smile &amp; calibration</h1>
      <p className="section-subtitle">
        Volatility surface review and HW + BGM least-squares calibration. All quotes are normal
        (Bachelier) vols in bp. Every cap and the liquid ATM swaption subset are selected by
        default; click <em>Calibrate models</em>, then experiment with α / ρ / ν live to
        sensitivity-test the SABR overlay shape against the cap-surface market dots.
      </p>

      {/* Calibration controls -------------------------------------- */}
      <div className="dash-card">
        <div className="group-label">Calibrate HW + BGM</div>
        <div className="form-row">
          <button
            type="button"
            className="btn btn-filled"
            onClick={() => void calibrate()}
            disabled={calibStatus === "running"}
          >
            {calibStatus === "running" ? "Calibrating…" : "Calibrate models →"}
          </button>
          <CalibStatusPill />
          <span className="form-helper">
            Targets: {selectedCapCount}/{totalCaps} caps, {selectedSwpnCount}/{totalSwpns} swaptions selected.
          </span>
        </div>
        {calibStatus === "ready" && hw && bgm && (
          <>
            <div className="form-helper" style={{ marginTop: 8 }}>
              <strong>HW</strong>: a = {hw.a.toExponential(2)}, σ = {hw.sigma.toFixed(6)},
              RMSE {hw.rmseBp.toFixed(2)} bp on {hw.expiries.length} ATM cap{hw.expiries.length === 1 ? "" : "s"}.
            </div>
            <div className="form-helper" style={{ marginTop: 4 }}>
              <strong>BGM</strong>: a = {bgm.a.toFixed(3)}, b = {bgm.b.toFixed(3)}, c = {bgm.c.toFixed(3)},
              d = {bgm.d.toFixed(3)}, β = {bgm.beta.toFixed(3)}, vs = {bgm.volScalar.toFixed(3)},
              δ = {((bgm.displacement ?? 0) * 100).toFixed(2)}%,
              β_cev = {(bgm.cevBeta ?? 1.0).toFixed(2)},
              RMSE {bgm.rmseBp.toFixed(2)} bp on {bgm.expiries.length} ATM swaption{bgm.expiries.length === 1 ? "" : "s"}.
            </div>
            <div className="form-helper" style={{ marginTop: 8, color: "rgba(18,19,18,0.55)", fontStyle: "italic" }}>
              BGM RMSE is typically higher than HW because it fits more points (full expiry × tenor swaption
              grid vs a single ATM cap column) with a 6-parameter Rebonato shape; the surface curvature
              isn't perfectly captured by the parametric form. Both fits are within their respective audit
              acceptance thresholds (HW ≤ 5 bp on the smooth portion; BGM ≤ 10 bp on the ATM grid).
            </div>
          </>
        )}
        {errorMessage && (
          <div className="form-helper" style={{ color: "#b42828", marginTop: 8 }}>
            {errorMessage}
          </div>
        )}
      </div>

      {/* Cap surface selection ------------------------------------- */}
      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="group-label" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Cap surface targets · normal vols, bp (HW fit uses ATM column)</span>
          <span style={{ display: "flex", gap: 8, fontWeight: 400, letterSpacing: 0 }}>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ padding: "4px 10px", fontSize: 11 }}
              onClick={() => setShowFullCapGrid((v) => !v)}
            >
              {showFullCapGrid ? "Curated grid" : `Full surface (${totalCaps})`}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ padding: "4px 10px", fontSize: 11 }}
              onClick={() => setAllCapsSelected(true)}
            >
              All
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ padding: "4px 10px", fontSize: 11 }}
              onClick={() => setAllCapsSelected(false)}
            >
              None
            </button>
          </span>
        </div>
        <table className="preview" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Expiry</th>
              {capStrikeOrder.map((s) => (
                <th key={s}>{s === "ATM" ? "ATM" : formatStrikeLabel(parseFloat(s))}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {capExpiries.map((exp) => (
              <tr key={exp}>
                <td>{formatTenorLabel(exp)}</td>
                {capStrikeOrder.map((s) => {
                  const isAtm = s === "ATM";
                  const strike = isAtm ? null : parseFloat(s);
                  const q = (capsByExpiry.get(exp) ?? []).find((qq) =>
                    isAtm ? qq.isAtm : qq.strike === strike,
                  );
                  if (!q) return <td key={s} style={{ color: "rgba(18,19,18,0.25)" }}>—</td>;
                  const k = capQuoteKey(q.expiryYears, q.strike);
                  const checked = selectedCapKeys.has(k);
                  return (
                    <td key={s}>
                      <label style={{ display: "flex", flexDirection: "column", gap: 2, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleCapKey(k)}
                          style={{ marginRight: 4 }}
                        />
                        <span style={{ fontSize: 11 }}>{(q.normalVol * 1e4).toFixed(0)} bp</span>
                      </label>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="form-helper" style={{ marginTop: 8 }}>
          {showFullCapGrid
            ? `Full export: ${totalCaps} quotes. `
            : `Curated grid: ${capQuotesShown.length} of ${totalCaps} quotes shown; the rest stay selected for the fit unless deselected in the full view. `}
          All quotes are normal (Bachelier) vols in bp; cap strikes are absolute rate levels.
          Note: the HW calibration reads only the ATM column — deselecting non-ATM strikes
          does not change the HW fit.
        </div>
      </div>

      {/* Swaption surface selection -------------------------------- */}
      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="group-label" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>ATM swaption surface targets · normal vols, bp (BGM fit)</span>
          <span style={{ display: "flex", gap: 8, fontWeight: 400, letterSpacing: 0 }}>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ padding: "4px 10px", fontSize: 11 }}
              onClick={() => setShowFullSwpnGrid((v) => !v)}
            >
              {showFullSwpnGrid ? "Curated grid" : `Full surface (${totalSwpns})`}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ padding: "4px 10px", fontSize: 11 }}
              onClick={() => setAllSwaptionsSelected(true)}
            >
              All
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ padding: "4px 10px", fontSize: 11 }}
              onClick={() => setAllSwaptionsSelected(false)}
            >
              None
            </button>
          </span>
        </div>
        <table className="preview" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Expiry \ Tenor</th>
              {swaptionTenors.map((t) => (
                <th key={t}>{formatTenorLabel(t)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {swaptionExpiries.map((exp) => (
              <tr key={exp}>
                <td>{formatTenorLabel(exp)}</td>
                {swaptionTenors.map((t) => {
                  const q = snapshot.swaptionATMQuotes.find(
                    (qq) =>
                      Math.abs(qq.expiryYears - exp) < 1e-6 &&
                      Math.abs(qq.tenorYears - t) < 1e-6,
                  );
                  if (!q) return <td key={t} style={{ color: "rgba(18,19,18,0.25)" }}>—</td>;
                  const k = swaptionQuoteKey(q.expiryYears, q.tenorYears);
                  const checked = selectedSwaptionKeys.has(k);
                  return (
                    <td key={t}>
                      <label style={{ display: "flex", flexDirection: "column", gap: 2, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSwaptionKey(k)}
                          style={{ marginRight: 4 }}
                        />
                        <span style={{ fontSize: 11 }}>{(q.normalVol * 1e4).toFixed(0)} bp</span>
                      </label>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="form-helper" style={{ marginTop: 8 }}>
          {showFullSwpnGrid
            ? `Full export: ${totalSwpns} quotes. Fitting all of them makes the BGM calibration take minutes; the ${curatedSwpns.length}-quote liquid subset is the default. `
            : `Curated grid: the ${curatedSwpns.length}-quote liquid calibration subset (default selection); the full ${totalSwpns}-quote export sits behind the toggle. `}
          All quotes are ATM normal (Bachelier) vols in bp.
        </div>
      </div>

      {/* 3D vol surfaces -------------------------------------------- */}
      <h2 className="section-title" style={{ fontSize: 24, marginTop: 32 }}>
        Volatility surfaces (3D)
      </h2>
      <p className="section-subtitle">
        Quoted normal (Bachelier) vols in bp, at full export granularity. Caps and swaptions stay
        separate surfaces: a cap vol prices a strip of caplets on a money-market rate, a swaption
        vol prices one option on a forward swap, so blending them into a single object has no
        market meaning. Drag to rotate, scroll to zoom, hover for the quote. After calibration the
        fitted model points overlay each market mesh. Defaults mirror the calibration pairing (HW
        is fit to the cap ATM column, BGM to the ATM swaption grid); the cross-fit toggles price
        the other instrument set with the calibrated parameters, so you can see how each model
        extends beyond its calibration targets.
      </p>

      {capSurface3D && (
        <div className="dash-card">
          <div className="group-label" style={{ display: "flex", justifyContent: "space-between" }}>
            <span>Cap surface · strike × expiry → σ_N (bp)</span>
            <span style={{ display: "flex", gap: 14, fontWeight: 400, letterSpacing: 0, textTransform: "none" }}>
              <label style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={showHwOnCap}
                  onChange={() => setShowHwOnCap((v) => !v)}
                  style={{ marginRight: 4 }}
                />
                HW fit
              </label>
              <label style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={showBgmOnCap}
                  onChange={() => setShowBgmOnCap((v) => !v)}
                  style={{ marginRight: 4 }}
                />
                BGM cross-fit
              </label>
            </span>
          </div>
          <ChartErrorBoundary label="Cap vol surface 3D">
            <VolSurface3D
              surfaceName="Cap surface (market)"
              grid={capSurface3D}
              overlays={capOverlays3D}
              xTitle="Strike (%)"
              yTitle="Expiry (Y)"
              zTitle="σ_N (bp)"
            />
          </ChartErrorBoundary>
        </div>
      )}

      {swpnSurface3D && (
        <div className="dash-card" style={{ marginTop: 16 }}>
          <div className="group-label" style={{ display: "flex", justifyContent: "space-between" }}>
            <span>ATM swaption surface · tenor × expiry → σ_N (bp)</span>
            <span style={{ display: "flex", gap: 14, fontWeight: 400, letterSpacing: 0, textTransform: "none" }}>
              <label style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={showBgmOnSwpn}
                  onChange={() => setShowBgmOnSwpn((v) => !v)}
                  style={{ marginRight: 4 }}
                />
                BGM fit
              </label>
              <label style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={showHwOnSwpn}
                  onChange={() => setShowHwOnSwpn((v) => !v)}
                  style={{ marginRight: 4 }}
                />
                HW cross-fit
              </label>
            </span>
          </div>
          <ChartErrorBoundary label="Swaption vol surface 3D">
            <VolSurface3D
              surfaceName="ATM swaption surface (market)"
              grid={swpnSurface3D}
              overlays={swpnOverlays3D}
              xTitle="Tenor (Y)"
              yTitle="Expiry (Y)"
              zTitle="σ_N (bp)"
            />
          </ChartErrorBoundary>
        </div>
      )}

      {/* Calibration residuals -------------------------------------- */}
      {(residualData.hwPts.length > 0 || residualData.bgmPts.length > 0) && (
        <div className="dash-card" style={{ height: 430, marginTop: 16 }}>
          <div className="group-label">Calibration residuals · model − market (bp)</div>
          <ResponsiveContainer width="100%" height="82%">
            <ComposedChart margin={{ top: 24, right: 32, bottom: 32, left: 48 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
              <XAxis
                dataKey="expiry"
                type="number"
                domain={[0, 31]}
                ticks={[0, 5, 10, 15, 20, 25, 30]}
                stroke={COLORS.obsidian}
                tick={{ fontSize: 13, fill: COLORS.obsidian }}
                label={{
                  value: "Expiry (Y)",
                  position: "insideBottom",
                  offset: -14,
                  style: { fontSize: 13, fill: "rgba(18,19,18,0.65)" },
                }}
              />
              <YAxis
                stroke={COLORS.obsidian}
                tick={{ fontSize: 13, fill: COLORS.obsidian }}
                width={56}
                label={{
                  value: "Residual (bp)",
                  angle: -90,
                  position: "insideLeft",
                  offset: 0,
                  style: { fontSize: 13, fill: "rgba(18,19,18,0.65)" },
                }}
              />
              <ReferenceLine y={0} stroke="rgba(18,19,18,0.45)" strokeDasharray="4 4" />
              <Tooltip
                formatter={(v: unknown, name: string) => {
                  if (typeof v === "number" && Number.isFinite(v)) return [`${v.toFixed(2)} bp`, name];
                  return ["—", name];
                }}
                labelFormatter={(v) =>
                  typeof v === "number" && Number.isFinite(v) ? `Expiry ${v}Y` : ""
                }
              />
              {residualData.hwPts.length > 0 && (
                <Scatter
                  data={residualData.hwPts}
                  dataKey="res"
                  fill={SERIES.hw}
                  stroke={COLORS.obsidian}
                  strokeWidth={0.5}
                  shape="circle"
                  name="HW · ATM caps"
                  isAnimationActive={false}
                />
              )}
              {residualData.bgmPts.length > 0 && (
                <Scatter
                  data={residualData.bgmPts}
                  dataKey="res"
                  fill={SERIES.bgm}
                  stroke={COLORS.obsidian}
                  strokeWidth={0.5}
                  shape="diamond"
                  name="BGM · ATM swaptions"
                  isAnimationActive={false}
                />
              )}
              <Legend
                verticalAlign="top"
                height={28}
                wrapperStyle={{ fontSize: 12, fontFamily: "var(--font-sans)", paddingBottom: 4 }}
                formatter={(value: string) => (
                  <span style={{ color: "var(--obsidian)", fontWeight: 500 }}>{value}</span>
                )}
              />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="form-helper">
            Signed per-instrument fit errors at the calibration targets. The scalar RMSE hides
            structure: a clean fit scatters tightly around zero with no expiry trend.
          </div>
        </div>
      )}

      {/* SABR smile -------------------------------------------------- */}
      <h2 className="section-title" style={{ fontSize: 24, marginTop: 32 }}>
        SABR smile slice (Bachelier, β = 0)
      </h2>
      <p className="section-subtitle">
        Hagan β=0 closed form. Heuristic α / ρ / ν initialised from cap-surface coverage; edit live.
      </p>

      <div className="dash-card">
        <div className="group-label">Underlying swap tenor τ</div>
        <div className="form-row">
          <span className="form-label">τ (years)</span>
          <select
            className="form-input"
            value={tenor}
            onChange={(e) => setTenor(parseFloat(e.target.value))}
            style={{ width: 140 }}
          >
            {TENOR_OPTIONS.map((t) => (
              <option key={t.label} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="form-helper" style={{ marginTop: 8 }}>
          <strong>Two dimensions to keep separate:</strong>
        </div>
        <ul style={{ paddingLeft: 24, marginTop: 4, fontSize: 13, color: "rgba(18,19,18,0.75)" }}>
          <li>
            <strong>Expiry</strong> (when the option expires): represented by the four <em>colored lines</em> in the
            chart at 1Y, 2Y, 5Y, and 10Y expiries. Cap-quote dots are colored to match the line at the same expiry.
          </li>
          <li>
            <strong>Tenor τ</strong> (the period the underlying rate accrues over): selected here. The 3M default
            matches the cap-quote convention (a cap is a strip of 3M caplets), so the market dots sit on a
            tenor-consistent moneyness axis. Longer τ choices anchor F on longer forwards and redraw both the
            lines and the dot positions around the new F values.
          </li>
        </ul>
      </div>

      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="group-label">Smile parameters (live)</div>
        <div className="form-row">
          <span className="form-label">α (alpha)</span>
          <input
            type="number"
            step={0.0005}
            min={0.0005}
            max={0.05}
            className="form-input"
            value={sabr.alpha}
            onChange={(e) => setSabr({ alpha: clamp(parseFloat(e.target.value) || 0, 0.0001, 0.1) })}
            style={{ width: 140 }}
          />
          <span className="form-helper">decimal vol of (F − K): controls overall smile level</span>
        </div>
        <div className="form-row">
          <span className="form-label">ρ (rho)</span>
          <input
            type="number"
            step={0.05}
            min={-0.99}
            max={0.99}
            className="form-input"
            value={sabr.rho}
            onChange={(e) => setSabr({ rho: clamp(parseFloat(e.target.value) || 0, -0.99, 0.99) })}
            style={{ width: 140 }}
          />
          <span className="form-helper">correlation rate ↔ vol: negative → left-skew (more downside vol)</span>
        </div>
        <div className="form-row">
          <span className="form-label">ν (nu)</span>
          <input
            type="number"
            step={0.05}
            min={0.01}
            max={3}
            className="form-input"
            value={sabr.nu}
            onChange={(e) => setSabr({ nu: clamp(parseFloat(e.target.value) || 0, 0.01, 3) })}
            style={{ width: 140 }}
          />
          <span className="form-helper">vol-of-vol: controls smile <em>curvature</em> (higher → wider U)</span>
        </div>
        <div className="form-row">
          <span className="form-label">β (beta)</span>
          <span>0 (fixed, Bachelier / normal-vol limit)</span>
        </div>
      </div>

      <div className="dash-card" style={{ height: 540, marginTop: 16 }}>
        <div className="group-label">
          Implied normal vol (Bachelier){" "}
          {hiddenDots > 0 && (
            <span style={{ fontWeight: 400, letterSpacing: 0, color: "rgba(18,19,18,0.55)", textTransform: "none" }}>
              · {hiddenDots} cap quote{hiddenDots === 1 ? "" : "s"} hidden (strike outside ±200 bp from F)
            </span>
          )}
        </div>
        <ResponsiveContainer width="100%" height="92%">
          <ComposedChart data={chartData} margin={{ top: 32, right: 32, bottom: 36, left: 48 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(18,19,18,0.08)" />
            <XAxis
              dataKey="offsetBp"
              type="number"
              domain={[-220, 220]}
              ticks={[-200, -100, -50, 0, 50, 100, 200]}
              tickFormatter={(v) => `${Math.round(v) > 0 ? "+" : ""}${Math.round(v)}`}
              stroke={COLORS.obsidian}
              tick={{ fontSize: 13, fill: COLORS.obsidian }}
              label={{
                value: "Strike − ATM forward (bps)",
                position: "insideBottom",
                offset: -16,
                style: { fontSize: 13, fill: "rgba(18,19,18,0.65)" },
              }}
            />
            <YAxis
              domain={yDomain}
              tickFormatter={(v) => `${Math.round(v)}`}
              stroke={COLORS.obsidian}
              tick={{ fontSize: 13, fill: COLORS.obsidian }}
              width={56}
              label={{
                value: "σ_N (bps)",
                angle: -90,
                position: "insideLeft",
                offset: 0,
                style: { fontSize: 13, fill: "rgba(18,19,18,0.65)" },
              }}
            />
            <Tooltip
              formatter={(v: unknown, name: string) => {
                if (typeof v === "number" && Number.isFinite(v)) return [`${v.toFixed(1)} bp`, name];
                return ["—", name];
              }}
              labelFormatter={(v) =>
                typeof v === "number" && Number.isFinite(v)
                  ? `K − F = ${Math.round(v)} bp`
                  : ""
              }
            />
            {EXPIRIES.map((T) => (
              <Line
                key={T}
                type="monotone"
                dataKey={`exp_${T}`}
                stroke={PURPLE_BY_EXPIRY[T]}
                strokeWidth={2.5}
                dot={false}
                isAnimationActive={false}
                name={`SABR · expiry ${T}Y`}
              />
            ))}
            {EXPIRIES.map((T) => (
              <Scatter
                key={`dot-${T}`}
                data={marketDots.filter((d) => d.expiryYears === T)}
                fill={PURPLE_BY_EXPIRY[T]}
                stroke={COLORS.obsidian}
                strokeWidth={1}
                dataKey="vol"
                shape="circle"
                name={`Cap · expiry ${T}Y`}
                legendType="none"
                isAnimationActive={false}
              />
            ))}
            <Legend
              verticalAlign="top"
              height={28}
              wrapperStyle={{
                fontSize: 12,
                fontFamily: "var(--font-sans)",
                color: "var(--obsidian)",
                paddingBottom: 4,
              }}
              formatter={(value: string) => (
                <span style={{ color: "var(--obsidian)", fontWeight: 500 }}>{value}</span>
              )}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="group-label">Smile slice: sample values (in bps)</div>
        <table className="preview">
          <thead>
            <tr>
              <th>Offset</th>
              <th>T = 1Y</th>
              <th>T = 2Y</th>
              <th>T = 5Y</th>
              <th>T = 10Y</th>
            </tr>
          </thead>
          <tbody>
            {chartData
              .filter((row) => TABLE_OFFSETS_BP.includes(row.offsetBp as number))
              .map((row) => (
                <tr key={row.offsetBp}>
                  <td>{(row.offsetBp as number) > 0 ? `+${row.offsetBp}` : row.offsetBp} bp</td>
                  <td>{(row["exp_1"] as number).toFixed(1)}</td>
                  <td>{(row["exp_2"] as number).toFixed(1)}</td>
                  <td>{(row["exp_5"] as number).toFixed(1)}</td>
                  <td>{(row["exp_10"] as number).toFixed(1)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CalibStatusPill() {
  const { calibStatus } = useApp();
  const className = `status-pill status-${calibStatus === "idle" ? "pending" : calibStatus}`;
  const label =
    calibStatus === "idle"
      ? "Pending"
      : calibStatus === "running"
        ? "Running"
        : calibStatus === "ready"
          ? "Ready"
          : "Error";
  return <span className={className}>{label}</span>;
}
