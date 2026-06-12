import { useRef, useState } from "react";

import { useApp } from "../state/AppContext";
import { importMarketWorkbook, type ImportSummary } from "../../math/rates/importWorkbook";

export function ImportTab() {
  const {
    snapshot,
    calibrationDate,
    settings,
    setSettings,
    setCalibrationDate,
    installSnapshot,
    tlpCurve,
    tlpIsDefault,
    loadTLPCurveFromCSV,
    resetTLPCurveToDefault,
  } = useApp();

  const tlpFileRef = useRef<HTMLInputElement | null>(null);
  const [tlpStatus, setTlpStatus] = useState<{ kind: "idle" | "ok" | "err"; msg: string }>({
    kind: "idle",
    msg: "",
  });

  const wbFileRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [wbStatus, setWbStatus] = useState<
    { kind: "idle" } | { kind: "err"; msg: string } | { kind: "ok"; summary: ImportSummary }
  >({ kind: "idle" });

  const importWorkbookFile = async (file: File) => {
    try {
      const bytes = await file.arrayBuffer();
      const { snapshot: snap, summary } = importMarketWorkbook(bytes, file.name, calibrationDate);
      installSnapshot(snap);
      setWbStatus({ kind: "ok", summary });
      setTlpStatus({ kind: "idle", msg: "" });
    } catch (err) {
      setWbStatus({ kind: "err", msg: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleWorkbookPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await importWorkbookFile(file);
    if (wbFileRef.current) wbFileRef.current.value = "";
  };

  const handleWorkbookDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) await importWorkbookFile(file);
  };

  const handleTLPUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      loadTLPCurveFromCSV(text);
      setTlpStatus({ kind: "ok", msg: `Loaded ${file.name}.` });
    } catch (err) {
      setTlpStatus({
        kind: "err",
        msg: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (tlpFileRef.current) tlpFileRef.current.value = "";
    }
  };

  const handleTLPReset = () => {
    resetTLPCurveToDefault();
    setTlpStatus({ kind: "ok", msg: "Reset to the snapshot's FHLB − SOFR default." });
  };

  if (!snapshot) {
    return (
      <div>
        <h1 className="section-title">Import</h1>
        <p className="section-subtitle">Loading bundled market data&hellip;</p>
      </div>
    );
  }

  const handleNPathsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseInt(e.target.value, 10);
    if (Number.isFinite(v) && v > 0) setSettings({ nPaths: v });
  };

  const nPathsValid = settings.nPaths >= 50 && settings.nPaths <= 1000 && settings.nPaths % 2 === 0;

  return (
    <div>
      <div className="banner-illustrative">
        <span className="banner-illustrative-icon">ⓘ</span>
        <span>
          <strong>For educational and illustrative purposes only.</strong> The ALM Model Lab is a
          teaching tool. Its calibrations, simulations, and analytics do not constitute financial,
          investment, or regulatory advice and are not intended for use in actual risk-management
          decisions. Any data you import stays in your browser and is never uploaded or shared.
        </span>
      </div>
      <h1 className="section-title">Import market data</h1>
      <p className="section-subtitle">
        Default surface is the bundled 3/31/2026 SOFR + FHLB + cap + ATM swaption set. Override
        below or drop in a market-data workbook.
      </p>

      <div
        className="dash-card"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleWorkbookDrop}
        style={{
          marginBottom: 16,
          border: dragOver ? "2px dashed #7050a0" : "2px dashed rgba(18,19,18,0.25)",
          background: dragOver ? "rgba(112,80,160,0.06)" : undefined,
        }}
      >
        <div className="group-label">Market-data workbook (.xlsx)</div>
        <div className="form-helper" style={{ marginBottom: 8 }}>
          Drop a 4-sheet market-data workbook here (SOFR_OIS_Curve, FHLB_Curve, Cap_Volatility,
          ATM_Swaption_Volatility; the <code>SOFR_Market_Data_YYYYMMDD.xlsx</code> export format),
          or browse. Parsing happens entirely in your browser with the same contract as
          <code style={{ marginLeft: 4 }}>research/convert_market_data.py</code>. The as-of date is
          read from the filename; the Term LP curve is derived as FHLB − SOFR per tenor.
        </div>
        <div className="form-row" style={{ gap: 12, alignItems: "center" }}>
          <input
            ref={wbFileRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={handleWorkbookPick}
            style={{ fontSize: 13 }}
          />
        </div>
        {wbStatus.kind === "err" && (
          <div className="form-helper" style={{ marginTop: 6, color: "#b42828" }}>
            {wbStatus.msg}
          </div>
        )}
        {wbStatus.kind === "ok" && (
          <div className="form-helper" style={{ marginTop: 6, color: "#3a7a3a" }}>
            Loaded {wbStatus.summary.sourceFile} as of {wbStatus.summary.calibrationDate}
            {wbStatus.summary.dateFromFilename ? " (date from filename)" : " (date from the field above)"}:{" "}
            {wbStatus.summary.curveNodes} curve nodes, {wbStatus.summary.fhlbNodes} FHLB nodes,{" "}
            {wbStatus.summary.tlpNodes} TLP nodes, {wbStatus.summary.capExpiries}×
            {wbStatus.summary.capStrikes} cap surface, {wbStatus.summary.swaptionExpiries}×
            {wbStatus.summary.swaptionTenors} swaption surface. Calibration state reset.
          </div>
        )}
      </div>

      <div className="row">
        <div className="dash-card grow">
          <div className="group-label">Calibration date</div>
          <div className="form-row">
            <label className="form-label">Date</label>
            <input
              type="date"
              className="form-input"
              value={calibrationDate}
              onChange={(e) => setCalibrationDate(e.target.value)}
              max={new Date().toISOString().slice(0, 10)}
            />
          </div>
          <div className="form-helper">
            Pre-filled from the imported snapshot. Used as the manifest date and export filename. Override manually when importing a workbook whose filename does not contain a date.
          </div>
        </div>

        <div className="dash-card grow">
          <div className="group-label">Path count</div>
          <div className="form-row">
            <label className="form-label">n_paths</label>
            <input
              type="number"
              className="form-input"
              min={50}
              max={1000}
              step={2}
              value={settings.nPaths}
              onChange={handleNPathsChange}
            />
          </div>
          <div className="form-helper">
            Even integer between 50 and 1,000. Antithetic pairing requires evens.
            100 default &middot; 500 canonical &middot; 1000 stress ceiling.
          </div>
          {!nPathsValid && (
            <div className="form-helper" style={{ color: "#b42828" }}>
              Path count must be an even integer between 50 and 1,000.
            </div>
          )}
          {settings.nPaths > 500 && (
            <div className="form-helper" style={{ color: "#C86A3A" }}>
              Heads up: {settings.nPaths} paths will run noticeably slower.
            </div>
          )}
        </div>
      </div>

      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="group-label">Currently loaded</div>
        <div className="form-row">
          <span className="form-label">Calibration date</span>
          <span>{snapshot.calibrationDate}</span>
        </div>
        <div className="form-row">
          <span className="form-label">Currency</span>
          <span>{snapshot.currency}</span>
        </div>
        <div className="form-row">
          <span className="form-label">Discounting index</span>
          <span>{snapshot.discountingIndex}</span>
        </div>
        <div className="form-row">
          <span className="form-label">Curve nodes</span>
          <span>{snapshot.curveQuotes.length}</span>
        </div>
        <div className="form-row">
          <span className="form-label">Cap quotes</span>
          <span>{snapshot.capQuotes.length}</span>
        </div>
        <div className="form-row">
          <span className="form-label">Swaption ATM quotes</span>
          <span>{snapshot.swaptionATMQuotes.length}</span>
        </div>
      </div>

      <div className="dash-card" style={{ marginTop: 16 }}>
        <div className="group-label">Term Liquidity Premium (FHLB − SOFR)</div>
        <div className="form-helper" style={{ marginBottom: 8 }}>
          The bank's term-funding cost above SOFR. Combines additively with the SOFR zero
          curve to produce the all-in funding curve used by FTP. Default is derived from the
          active snapshot's FHLB − SOFR spread per tenor. Upload your own CSV with rows of
          <code style={{ marginLeft: 4 }}>tenor_years,tlp_decimal</code> (or a percent value
          like 0.21 for 21 bps; the parser detects the convention). Set the overnight tenor
          (t = 0) to 0 by convention.
        </div>
        <div className="form-row" style={{ gap: 12, alignItems: "center" }}>
          <span className="form-label">Source</span>
          <span>{tlpIsDefault ? "Snapshot default (FHLB − SOFR)" : "User-uploaded"}</span>
        </div>
        <div className="form-row" style={{ gap: 12, alignItems: "center", marginTop: 6 }}>
          <input
            ref={tlpFileRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={handleTLPUpload}
            style={{ fontSize: 13 }}
          />
          {!tlpIsDefault && (
            <button
              type="button"
              className="ghost-button"
              onClick={handleTLPReset}
              style={{ marginLeft: 12 }}
            >
              Reset to default
            </button>
          )}
        </div>
        {tlpStatus.kind !== "idle" && (
          <div
            className="form-helper"
            style={{ marginTop: 6, color: tlpStatus.kind === "err" ? "#b42828" : "#3a7a3a" }}
          >
            {tlpStatus.msg}
          </div>
        )}

        <table className="preview" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Tenor (years)</th>
              <th>TLP (bps)</th>
            </tr>
          </thead>
          <tbody>
            {tlpCurve.t.map((t, i) => (
              <tr key={i}>
                <td>{t === 0 ? "0 (1D)" : t.toFixed(4)}</td>
                <td>{(tlpCurve.spread[i] * 10000).toFixed(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="dash-card" style={{ marginTop: 24 }}>
        <div className="group-label">Curve quotes</div>
        <table className="preview">
          <thead>
            <tr>
              <th>Term</th>
              <th>t (years)</th>
              <th>Type</th>
              <th>Rate</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.curveQuotes.map((q) => (
              <tr key={q.term}>
                <td>{q.term}</td>
                <td>{q.tYears.toFixed(4)}</td>
                <td>{q.instrumentType}</td>
                <td>{(q.rate * 100).toFixed(4)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

