import { useState } from "react";
import { useApp } from "../state/AppContext";
import { RunInfoPopover } from "./RunInfoPopover";

export function Header() {
  const { calibrationDate, settings } = useApp();
  const [popoverOpen, setPopoverOpen] = useState(false);
  return (
    <header className="header">
      <div className="chrome-inner">
        <div className="header-left">
          <img src={import.meta.env.BASE_URL + "logo.png"} alt="Model Sense" className="header-logo" />
          <div className="header-title">ALM Model Lab</div>
        </div>
        <div className="header-right">
          {/* In production the Lab is served at modelsensealm.com/alm-model-lab/, so "../" lands
              on the site root. In dev there is no parent site (Vite redirects "/" back to the
              base), so point at the live site instead of a dead bounce. */}
          <a
            href={import.meta.env.DEV ? "https://modelsensealm.com/" : "../"}
            className="header-back"
            title="Return to the Model Sense website and close the Lab"
          >
            ← Model Sense
          </a>
          <div>
            <div className="header-run-label">Calibration</div>
            <div className="header-run-value">{calibrationDate}</div>
          </div>
          <div>
            <div className="header-run-label">Paths</div>
            <div className="header-run-value">{settings.nPaths}</div>
          </div>
          <div className="popover-anchor">
            <button
              type="button"
              className="icon-button"
              aria-label="Run information"
              onClick={() => setPopoverOpen((o) => !o)}
            >
              i
            </button>
            <RunInfoPopover open={popoverOpen} onClose={() => setPopoverOpen(false)} />
          </div>
        </div>
      </div>
    </header>
  );
}
