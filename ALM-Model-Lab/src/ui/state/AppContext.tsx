/**
 * Top-level shared state for the ALM Model Lab.
 *
 * Holds the active market snapshot, bootstrapped curve, calibration result,
 * HW + BGM simulation results, and the current run-id. Tabs read from this
 * context; control actions dispatch through it.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  isDefaultCalibrationSwaption,
  loadMarketSnapshot,
  type MarketSnapshot,
} from "../../math/rates/marketData";
import { bootstrapZeroCurve, type ZeroCurve } from "../../math/rates/bootstrap";
import {
  DEFAULT_TLP_CURVE,
  buildTLPCurve,
  parseTLPCurveCSV,
  type TLPCurve,
  type TLPNode,
} from "../../math/rates/tlpCurve";
import type { HWCalibrationResult } from "../../math/rates/hwCalibrate";
import type { BGMCalibrationResult } from "../../math/rates/bgmCalibrate";
import type { HWSimulationResult } from "../../math/rates/simulateHw";
import type { BGMSimulationResult } from "../../math/rates/simulateBgm";
import {
  sabrHeuristic,
  SABR_DEFAULT,
  type SabrParams,
} from "../../math/rates/sabrHeuristic";
import { runInWorker } from "../hooks/useWorkerOnce";
import type { CalibrateRequest, CalibrateResponse } from "../../workers/calibrate.worker";
import type { HWSimulateRequest } from "../../workers/hw.worker";
import type { BGMSimulateRequest } from "../../workers/bgm.worker";
import {
  buildRunBundle,
  parseRunBundle,
  triggerDownload,
  type LoadedRun,
} from "../../storage/runBundle";

export type AsyncStatus = "idle" | "running" | "ready" | "error";

export interface SimSettings {
  nPaths: number;
  seed: number;
  horizonYears: number;
  fCeiling: number;
  /** Shifted-lognormal LMM displacement δ. δ=0 = pure LMM. */
  bgmDisplacement: number;
  /** Shifted-CEV LMM exponent β_cev. β=1 = shifted lognormal LMM. */
  bgmCEV: number;
  /** Tenor labels included when saving a run bundle. */
  selectedTenorLabels: ReadonlyArray<string>;
}

export interface AppState {
  snapshot: MarketSnapshot | null;
  curve: ZeroCurve | null;
  calibrationDate: string;
  hw: HWCalibrationResult | null;
  bgm: BGMCalibrationResult | null;
  sabr: SabrParams;
  hwSim: HWSimulationResult | null;
  bgmSim: BGMSimulationResult | null;
  calibStatus: AsyncStatus;
  hwSimStatus: AsyncStatus;
  bgmSimStatus: AsyncStatus;
  errorMessage: string | null;
  settings: SimSettings;
  /** Subset of cap surface keys included in the calibration. Format: `${expiryYears}_${strike|"ATM"}` */
  selectedCapKeys: ReadonlySet<string>;
  /** Subset of swaption ATM keys included in the calibration. Format: `${expiryYears}_${tenorYears}` */
  selectedSwaptionKeys: ReadonlySet<string>;
  /** Term Liquidity Premium curve (FHLB - SOFR by tenor). Default = the active snapshot's tlp_nodes; built-in 9/30/2025 nodes only for legacy snapshots without a TLP block. */
  tlpCurve: TLPCurve;
  /** Whether the active TLP curve is the snapshot default (vs user-uploaded). */
  tlpIsDefault: boolean;
}

export function capQuoteKey(expiryYears: number, strikeOrAtm: number | null): string {
  return `${expiryYears}_${strikeOrAtm === null ? "ATM" : strikeOrAtm}`;
}

export function swaptionQuoteKey(expiryYears: number, tenorYears: number): string {
  return `${expiryYears}_${tenorYears}`;
}

export interface AppActions {
  loadDefaultSnapshot(): Promise<void>;
  /** Install an imported snapshot: bootstrap, SABR heuristic, selections, TLP, reset downstream. */
  installSnapshot(snap: MarketSnapshot): void;
  setSettings(update: Partial<SimSettings>): void;
  setCalibrationDate(date: string): void;
  setSabr(update: Partial<SabrParams>): void;
  toggleCapKey(key: string): void;
  toggleSwaptionKey(key: string): void;
  setAllCapsSelected(selected: boolean): void;
  setAllSwaptionsSelected(selected: boolean): void;
  calibrate(): Promise<void>;
  runHWSimulation(): Promise<void>;
  runBGMSimulation(): Promise<void>;
  saveRun(): void;
  loadRunFromZip(zipBytes: Uint8Array): LoadedRun;
  /** Replace the active TLP curve with the supplied node list. */
  setTLPCurve(nodes: ReadonlyArray<TLPNode>): void;
  /** Reset the TLP curve back to the snapshot's tlp_nodes (or the built-in legacy default). */
  resetTLPCurveToDefault(): void;
  /** Parse a CSV upload and install it as the active TLP curve. Throws on parse failure. */
  loadTLPCurveFromCSV(csv: string): void;
}

type AppContextValue = AppState & AppActions;

const DEFAULT_SETTINGS: SimSettings = {
  nPaths: 100,
  seed: 20250930,
  horizonYears: 30.0,
  fCeiling: 2.0,
  bgmDisplacement: 0.015,
  bgmCEV: 0.7,
  selectedTenorLabels: ["1M", "3M", "6M", "1Y", "2Y", "5Y", "7Y", "10Y"],
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [curve, setCurve] = useState<ZeroCurve | null>(null);
  const [calibrationDate, setCalibrationDate] = useState<string>("2026-03-31");
  const [hw, setHw] = useState<HWCalibrationResult | null>(null);
  const [bgm, setBgm] = useState<BGMCalibrationResult | null>(null);
  const [sabr, setSabrState] = useState<SabrParams>(SABR_DEFAULT);
  const [selectedCapKeys, setSelectedCapKeys] = useState<ReadonlySet<string>>(new Set());
  const [selectedSwaptionKeys, setSelectedSwaptionKeys] = useState<ReadonlySet<string>>(new Set());
  const [hwSim, setHwSim] = useState<HWSimulationResult | null>(null);
  const [bgmSim, setBgmSim] = useState<BGMSimulationResult | null>(null);
  const [calibStatus, setCalibStatus] = useState<AsyncStatus>("idle");
  const [hwSimStatus, setHwSimStatus] = useState<AsyncStatus>("idle");
  const [bgmSimStatus, setBgmSimStatus] = useState<AsyncStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [settings, setSettingsState] = useState<SimSettings>(DEFAULT_SETTINGS);
  const [tlpCurve, setTLPCurveState] = useState<TLPCurve>(DEFAULT_TLP_CURVE);
  const [tlpIsDefault, setTLPIsDefault] = useState<boolean>(true);

  const setTLPCurve = useCallback((nodes: ReadonlyArray<TLPNode>) => {
    if (nodes.length < 2) {
      throw new Error("TLP curve needs at least two tenor nodes.");
    }
    setTLPCurveState(buildTLPCurve(nodes));
    setTLPIsDefault(false);
  }, []);

  const resetTLPCurveToDefault = useCallback(() => {
    setTLPCurveState(
      snapshot && snapshot.tlpNodes.length >= 2 ? buildTLPCurve(snapshot.tlpNodes) : DEFAULT_TLP_CURVE,
    );
    setTLPIsDefault(true);
  }, [snapshot]);

  const loadTLPCurveFromCSV = useCallback((csv: string) => {
    const nodes = parseTLPCurveCSV(csv);
    if (nodes.length < 2) {
      throw new Error(
        "Could not parse a usable TLP curve from the upload. Expected rows of `tenor_years,tlp_decimal` (or %).",
      );
    }
    setTLPCurveState(buildTLPCurve(nodes));
    setTLPIsDefault(false);
  }, []);

  const installSnapshot = useCallback((snap: MarketSnapshot) => {
    const z = bootstrapZeroCurve(snap);
    setSnapshot(snap);
    setCurve(z);
    setCalibrationDate(snap.calibrationDate);
    setSabrState(sabrHeuristic(snap));
    // TLP from the snapshot's tlp_nodes (FHLB - SOFR); legacy snapshots
    // without the block keep the built-in default until a CSV is uploaded.
    if (snap.tlpNodes.length >= 2) {
      setTLPCurveState(buildTLPCurve(snap.tlpNodes));
      setTLPIsDefault(true);
    }
    // Default: every cap quote, and the standard liquid swaption calibration
    // subset (full 21 x 15 surfaces make the BGM fit non-interactive; the
    // rest stays selectable on the SABR tab). Legacy snapshots whose grid
    // misses the subset fall back to everything.
    const capKeys = new Set(snap.capQuotes.map((q) => capQuoteKey(q.expiryYears, q.strike)));
    const calibSwpns = snap.swaptionATMQuotes.filter(isDefaultCalibrationSwaption);
    const swpnKeys = new Set(
      (calibSwpns.length > 0 ? calibSwpns : snap.swaptionATMQuotes).map((q) =>
        swaptionQuoteKey(q.expiryYears, q.tenorYears),
      ),
    );
    setSelectedCapKeys(capKeys);
    setSelectedSwaptionKeys(swpnKeys);
    // Reset downstream state.
    setHw(null);
    setBgm(null);
    setHwSim(null);
    setBgmSim(null);
    setCalibStatus("idle");
    setHwSimStatus("idle");
    setBgmSimStatus("idle");
  }, []);

  const loadDefaultSnapshot = useCallback(async () => {
    try {
      const snap = await loadMarketSnapshot(import.meta.env.BASE_URL + "market_2026-03-31.json");
      installSnapshot(snap);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }, [installSnapshot]);

  const setSettings = useCallback((update: Partial<SimSettings>) => {
    setSettingsState((s) => ({ ...s, ...update }));
  }, []);

  const setSabr = useCallback((update: Partial<SabrParams>) => {
    setSabrState((s) => ({ ...s, ...update }));
  }, []);

  const toggleCapKey = useCallback((key: string) => {
    setSelectedCapKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const toggleSwaptionKey = useCallback((key: string) => {
    setSelectedSwaptionKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const setAllCapsSelected = useCallback(
    (selected: boolean) => {
      if (!snapshot) return;
      setSelectedCapKeys(
        selected
          ? new Set(snapshot.capQuotes.map((q) => capQuoteKey(q.expiryYears, q.strike)))
          : new Set(),
      );
    },
    [snapshot],
  );
  const setAllSwaptionsSelected = useCallback(
    (selected: boolean) => {
      if (!snapshot) return;
      setSelectedSwaptionKeys(
        selected
          ? new Set(snapshot.swaptionATMQuotes.map((q) => swaptionQuoteKey(q.expiryYears, q.tenorYears)))
          : new Set(),
      );
    },
    [snapshot],
  );

  const calibrate = useCallback(async () => {
    if (!snapshot || !curve) return;
    setCalibStatus("running");
    setErrorMessage(null);
    try {
      // Build a filtered snapshot: only quotes the user has toggled on.
      const filteredCaps = snapshot.capQuotes.filter((q) =>
        selectedCapKeys.has(capQuoteKey(q.expiryYears, q.strike)),
      );
      const filteredSwpns = snapshot.swaptionATMQuotes.filter((q) =>
        selectedSwaptionKeys.has(swaptionQuoteKey(q.expiryYears, q.tenorYears)),
      );
      // HW needs at least one ATM cap; BGM needs at least one swaption.
      if (filteredCaps.filter((q) => q.isAtm).length === 0) {
        throw new Error("Select at least one ATM cap quote for HW calibration.");
      }
      if (filteredSwpns.length === 0) {
        throw new Error("Select at least one swaption quote for BGM calibration.");
      }
      const filteredSnapshot: MarketSnapshot = {
        ...snapshot,
        capQuotes: filteredCaps,
        swaptionATMQuotes: filteredSwpns,
      };
      const response = await runInWorker<CalibrateRequest, CalibrateResponse>(
        () => new Worker(new URL("../../workers/calibrate.worker.ts", import.meta.url), { type: "module" }),
        {
          type: "calibrate",
          snapshot: filteredSnapshot,
          curvePayload: { t: curve.t, z: curve.z },
          bgmOptions: { displacement: settings.bgmDisplacement, cevBeta: settings.bgmCEV },
        },
        (r): r is { type: "error"; message: string } =>
          typeof r === "object" && r !== null && (r as { type?: string }).type === "error",
      );
      setHw(response.hw);
      setBgm(response.bgm);
      setCalibStatus("ready");
      // Calibration changes invalidate prior simulation results.
      setHwSim(null);
      setBgmSim(null);
      setHwSimStatus("idle");
      setBgmSimStatus("idle");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setCalibStatus("error");
    }
  }, [snapshot, curve, selectedCapKeys, selectedSwaptionKeys, settings.bgmDisplacement, settings.bgmCEV]);

  const runHWSimulation = useCallback(async () => {
    if (!curve || !hw) return;
    setHwSimStatus("running");
    setErrorMessage(null);
    try {
      const response = await runInWorker<HWSimulateRequest, { type: "simulated"; result: HWSimulationResult }>(
        () => new Worker(new URL("../../workers/hw.worker.ts", import.meta.url), { type: "module" }),
        {
          type: "simulate",
          curve: { t: curve.t, z: curve.z },
          a: hw.a,
          sigma: hw.sigma,
          options: {
            horizonYears: settings.horizonYears,
            dtYears: 1 / 12,
            nPairs: Math.floor(settings.nPaths / 2),
            seed: BigInt(settings.seed),
          },
        },
        (r): r is { type: "error"; message: string } =>
          typeof r === "object" && r !== null && (r as { type?: string }).type === "error",
      );
      setHwSim(response.result);
      setHwSimStatus("ready");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setHwSimStatus("error");
    }
  }, [curve, hw, settings]);

  const runBGMSimulation = useCallback(async () => {
    if (!curve || !bgm) return;
    setBgmSimStatus("running");
    setErrorMessage(null);
    try {
      const response = await runInWorker<BGMSimulateRequest, { type: "simulated"; result: BGMSimulationResult }>(
        () => new Worker(new URL("../../workers/bgm.worker.ts", import.meta.url), { type: "module" }),
        {
          type: "simulate",
          curve: { t: curve.t, z: curve.z },
          params: {
            a: bgm.a,
            b: bgm.b,
            c: bgm.c,
            d: bgm.d,
            beta: bgm.beta,
            volScalar: bgm.volScalar,
            displacement: bgm.displacement ?? 0,
            cevBeta: bgm.cevBeta ?? 1.0,
          },
          options: {
            horizonYears: settings.horizonYears,
            dtYears: 1 / 12,
            nPairs: Math.floor(settings.nPaths / 2),
            seed: BigInt(settings.seed),
            fCeiling: settings.fCeiling,
          },
        },
        (r): r is { type: "error"; message: string } =>
          typeof r === "object" && r !== null && (r as { type?: string }).type === "error",
      );
      setBgmSim(response.result);
      setBgmSimStatus("ready");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setBgmSimStatus("error");
    }
  }, [curve, bgm, settings]);

  const saveRun = useCallback(() => {
    if (!snapshot || !curve || !hw || !bgm || !hwSim || !bgmSim) {
      setErrorMessage("Run all of calibrate, HW simulate, and BGM simulate before saving.");
      return;
    }
    try {
      const { runId, zipBytes } = buildRunBundle({
        snapshot,
        curve,
        hw,
        bgm,
        hwSim,
        bgmSim,
        seed: settings.seed,
        selectedTenorLabels: settings.selectedTenorLabels,
      });
      triggerDownload(zipBytes, `alm-model-lab_${runId}.zip`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }, [snapshot, curve, hw, bgm, hwSim, bgmSim, settings.seed]);

  const loadRunFromZip = useCallback((zipBytes: Uint8Array): LoadedRun => {
    const loaded = parseRunBundle(zipBytes);
    const { manifest } = loaded;
    setCalibrationDate(manifest.calibrationDate);
    setSettingsState((s) => ({
      ...s,
      seed: manifest.seed,
      nPaths: manifest.nPaths,
      horizonYears: manifest.horizonYears,
      fCeiling: manifest.fCeiling,
    }));
    // Restore calibration parameters so sim tabs can run without re-calibrating.
    setHw({
      a: manifest.hw.a,
      sigma: manifest.hw.sigma,
      rmseBp: manifest.hw.rmseBp,
      residualsBp: [],
      expiries: [],
      marketVols: [],
      modelVols: [],
      forwards: [],
      iterations: 0,
      underlyingTau: 0.25,
    });
    setBgm({
      a: manifest.bgm.a,
      b: manifest.bgm.b,
      c: manifest.bgm.c,
      d: manifest.bgm.d,
      beta: manifest.bgm.beta,
      volScalar: manifest.bgm.volScalar,
      displacement: manifest.bgm.displacement,
      cevBeta: manifest.bgm.cevBeta,
      rmseBp: manifest.bgm.rmseBp,
      residualsBp: [],
      expiries: [],
      tenors: [],
      parRates: [],
      marketVols: [],
      modelVols: [],
      iterations: 0,
    });
    setCalibStatus("ready");
    return loaded;
  }, []);

  // Load default snapshot on first mount.
  useEffect(() => {
    void loadDefaultSnapshot();
  }, [loadDefaultSnapshot]);

  const value = useMemo<AppContextValue>(
    () => ({
      snapshot,
      curve,
      calibrationDate,
      hw,
      bgm,
      sabr,
      hwSim,
      bgmSim,
      calibStatus,
      hwSimStatus,
      bgmSimStatus,
      errorMessage,
      settings,
      selectedCapKeys,
      selectedSwaptionKeys,
      tlpCurve,
      tlpIsDefault,
      loadDefaultSnapshot,
      installSnapshot,
      setSettings,
      setCalibrationDate,
      setSabr,
      toggleCapKey,
      toggleSwaptionKey,
      setAllCapsSelected,
      setAllSwaptionsSelected,
      calibrate,
      runHWSimulation,
      runBGMSimulation,
      saveRun,
      loadRunFromZip,
      setTLPCurve,
      resetTLPCurveToDefault,
      loadTLPCurveFromCSV,
    }),
    [
      snapshot,
      curve,
      calibrationDate,
      hw,
      bgm,
      sabr,
      hwSim,
      bgmSim,
      calibStatus,
      hwSimStatus,
      bgmSimStatus,
      errorMessage,
      settings,
      selectedCapKeys,
      selectedSwaptionKeys,
      loadDefaultSnapshot,
      installSnapshot,
      setSettings,
      setSabr,
      toggleCapKey,
      toggleSwaptionKey,
      setAllCapsSelected,
      setAllSwaptionsSelected,
      calibrate,
      runHWSimulation,
      runBGMSimulation,
      saveRun,
      loadRunFromZip,
      tlpCurve,
      tlpIsDefault,
      setTLPCurve,
      resetTLPCurveToDefault,
      loadTLPCurveFromCSV,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}
