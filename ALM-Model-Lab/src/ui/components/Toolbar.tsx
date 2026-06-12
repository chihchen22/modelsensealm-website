interface ToolbarProps {
  onSaveRun?: () => void;
  onLoadRun?: () => void;
  onOpenSettings?: () => void;
  saveDisabled?: boolean;
}

export function Toolbar({
  onSaveRun,
  onLoadRun,
  onOpenSettings,
  saveDisabled,
}: ToolbarProps) {
  return (
    <footer className="toolbar">
      <div className="chrome-inner">
        <button
          type="button"
          className="btn btn-filled"
          onClick={onSaveRun}
          disabled={saveDisabled || !onSaveRun}
          title={
            saveDisabled
              ? "Run HW + BGM simulations to enable"
              : "Save the rate-model run only: HW + BGM calibration parameters, fitted residuals, and per-tenor MC path matrices. Does not include instrument-level cashflows or analytics; use the Export to Excel button on each Analytics tab (SEG/EBP, Repricing, Liquidity, FTP) for those."
          }
        >
          Save Run (rate model) ↓
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onLoadRun}
          disabled={!onLoadRun}
          title="Reload a previously saved rate-model run zip (manifest + path CSVs)."
        >
          Load Run ↑
        </button>
        <span className="toolbar-helper">
          Save Run captures rate paths only. Instrument analytics export from each Analytics tab.
        </span>
        <div className="toolbar-spacer" />
        <button type="button" className="btn btn-ghost" onClick={onOpenSettings} disabled={!onOpenSettings}>
          ⚙ Settings
        </button>
      </div>
    </footer>
  );
}
