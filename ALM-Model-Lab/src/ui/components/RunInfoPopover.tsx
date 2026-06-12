import { useEffect, useRef } from "react";
import { useApp } from "../state/AppContext";
import { getMode } from "../tokens";

interface RunInfoPopoverProps {
  open: boolean;
  onClose: () => void;
}

export function RunInfoPopover({ open, onClose }: RunInfoPopoverProps) {
  const { snapshot, hw, bgm, hwSim, bgmSim, settings, calibrationDate } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const mode = getMode();
  const isInternal = mode === "internal";

  // Click-outside dismiss.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // Defer registration so the click that opened the popover doesn't immediately close it.
    const id = window.setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", handler);
    };
  }, [open, onClose]);

  if (!open) return null;

  const runId = `${calibrationDate}_${settings.seed}_${settings.nPaths}paths`;

  return (
    <div className="popover" ref={ref} role="dialog" aria-label="Run information">
      <div className="popover-section">
        <div className="popover-title">Run</div>
        <div className="kvp-row">
          <span className="kvp-key">Run ID</span>
          <span className="kvp-value" style={{ fontFamily: "monospace", fontSize: 12 }}>
            {runId}
          </span>
        </div>
        <div className="kvp-row">
          <span className="kvp-key">Calibration date</span>
          <span className="kvp-value">{calibrationDate}</span>
        </div>
        <div className="kvp-row">
          <span className="kvp-key">Path count</span>
          <span className="kvp-value">{settings.nPaths}</span>
        </div>
        {isInternal && (
          <>
            <div className="kvp-row">
              <span className="kvp-key">Seed</span>
              <span className="kvp-value">{settings.seed}</span>
            </div>
            <div className="kvp-row">
              <span className="kvp-key">F_CEILING</span>
              <span className="kvp-value">{settings.fCeiling.toFixed(2)}</span>
            </div>
          </>
        )}
      </div>

      {hw && (
        <div className="popover-section">
          <div className="popover-title">Hull-White 1F</div>
          <div className="kvp-row">
            <span className="kvp-key">a</span>
            <span className="kvp-value">{hw.a.toExponential(3)}</span>
          </div>
          <div className="kvp-row">
            <span className="kvp-key">σ</span>
            <span className="kvp-value">{hw.sigma.toFixed(6)}</span>
          </div>
          <div className="kvp-row">
            <span className="kvp-key">RMSE</span>
            <span className="kvp-value">{hw.rmseBp.toFixed(2)} bp</span>
          </div>
        </div>
      )}

      {bgm && (
        <div className="popover-section">
          <div className="popover-title">BGM Rebonato 2F</div>
          <div className="kvp-row">
            <span className="kvp-key">a / b / c / d</span>
            <span className="kvp-value">
              {bgm.a.toFixed(3)} / {bgm.b.toFixed(3)} / {bgm.c.toFixed(3)} / {bgm.d.toFixed(3)}
            </span>
          </div>
          <div className="kvp-row">
            <span className="kvp-key">β</span>
            <span className="kvp-value">{bgm.beta.toFixed(4)}</span>
          </div>
          <div className="kvp-row">
            <span className="kvp-key">volScalar</span>
            <span className="kvp-value">{bgm.volScalar.toFixed(4)}</span>
          </div>
          <div className="kvp-row">
            <span className="kvp-key">displacement δ</span>
            <span className="kvp-value">{((bgm.displacement ?? 0) * 100).toFixed(2)}%</span>
          </div>
          <div className="kvp-row">
            <span className="kvp-key">CEV β</span>
            <span className="kvp-value">{(bgm.cevBeta ?? 1.0).toFixed(2)}</span>
          </div>
          <div className="kvp-row">
            <span className="kvp-key">RMSE</span>
            <span className="kvp-value">{bgm.rmseBp.toFixed(2)} bp</span>
          </div>
        </div>
      )}

      {(hwSim || bgmSim) && (
        <div className="popover-section">
          <div className="popover-title">Simulation</div>
          {hwSim && (
            <div className="kvp-row">
              <span className="kvp-key">HW status</span>
              <span className="kvp-value">{hwSim.nPaths} paths · martingale-corrected</span>
            </div>
          )}
          {bgmSim && (
            <>
              <div className="kvp-row">
                <span className="kvp-key">BGM status</span>
                <span className="kvp-value">{bgmSim.nPaths} paths · predictor-corrector</span>
              </div>
              <div className="kvp-row">
                <span className="kvp-key">BGM cap fires</span>
                <span className="kvp-value">
                  {((bgmSim.nCapFires / Math.max(bgmSim.nTotalEvolutions, 1)) * 100).toFixed(3)}%
                </span>
              </div>
            </>
          )}
        </div>
      )}

      <div className="popover-section">
        <div className="popover-title">Known limitations</div>
        <div style={{ fontSize: 12, color: "rgba(18,19,18,0.85)", lineHeight: 1.55 }}>
          <p style={{ marginBottom: 8 }}>
            <strong>1Y HW outlier.</strong> The 1Y ATM cap (
            {snapshot
              ? snapshot.capQuotes.find((q) => q.isAtm && Math.abs(q.expiryYears - 1) < 1e-6)
                  ? `${(snapshot.capQuotes.find((q) => q.isAtm && Math.abs(q.expiryYears - 1) < 1e-6)!.normalVol * 1e4).toFixed(0)} bp`
                  : "?"
              : "?"}
            ) is anomalously low against ≥82 bp at every other expiry. HW absorbs this as a +11 bp residual at 1Y;
            the rest of the surface fits within ±5 bp.
          </p>
          <p>
            <strong>Long-horizon BGM tail.</strong> Simulated rates at horizons {`>`} 10Y combined with 20Y / 30Y
            tenor projections inherit the F_CEILING bound. Use HW for 20Y+ stress work or wait for a Glasserman-Zhao
            arbitrage-free discretisation in a later iteration.
          </p>
        </div>
      </div>
    </div>
  );
}
