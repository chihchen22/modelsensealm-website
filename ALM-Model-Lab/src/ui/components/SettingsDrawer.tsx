import { useApp } from "../state/AppContext";
import { getMode } from "../tokens";

interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
}

const TENORS_FOR_EXPORT: ReadonlyArray<{ label: string; value: number }> = [
  { label: "1M", value: 1 / 12 },
  { label: "3M", value: 0.25 },
  { label: "6M", value: 0.5 },
  { label: "1Y", value: 1.0 },
  { label: "2Y", value: 2.0 },
  { label: "5Y", value: 5.0 },
  { label: "7Y", value: 7.0 },
  { label: "10Y", value: 10.0 },
  { label: "20Y", value: 20.0 },
  { label: "30Y", value: 30.0 },
];

export function SettingsDrawer({ open, onClose }: SettingsDrawerProps) {
  const { settings, setSettings } = useApp();
  const mode = getMode();
  const isInternal = mode === "internal";

  if (!open) return null;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Settings">
        <div className="drawer-header">
          <div className="drawer-title">
            Settings <span className={`mode-tag${isInternal ? "" : " public"}`}>{mode}</span>
          </div>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>

        {isInternal && (
          <section style={{ marginBottom: 24 }}>
            <div className="group-label">Engineering controls (internal only)</div>
            <div className="form-row">
              <span className="form-label">Seed</span>
              <input
                type="number"
                className="form-input"
                value={settings.seed}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (Number.isFinite(v)) setSettings({ seed: v });
                }}
                style={{ width: 140 }}
              />
            </div>
            <div className="form-row">
              <span className="form-label">F_CEILING</span>
              <input
                type="number"
                step={0.5}
                min={0.1}
                max={10}
                className="form-input"
                value={settings.fCeiling}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (Number.isFinite(v) && v >= 0.1 && v <= 10) setSettings({ fCeiling: v });
                }}
                style={{ width: 140 }}
              />
            </div>
            <div className="form-helper">
              BGM forward-rate cap. Default 2.0 (200%) keeps p95 unbiased across the full 30Y horizon at 9/30/2025-calibrated vol.
            </div>
            <div className="form-row">
              <span className="form-label">BGM displacement δ</span>
              <input
                type="number"
                step={0.005}
                min={0}
                max={0.05}
                className="form-input"
                value={settings.bgmDisplacement}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (Number.isFinite(v) && v >= 0 && v <= 0.05) setSettings({ bgmDisplacement: v });
                }}
                style={{ width: 140 }}
              />
            </div>
            <div className="form-helper">
              Shifted-lognormal LMM: dynamics on F+δ rather than F. δ=0 recovers pure lognormal. Default 0.015 (1.5%) tames the upper tail by lowering effective F-vol at high F. Re-calibrate after changing.
            </div>
            <div className="form-row">
              <span className="form-label">BGM CEV β</span>
              <input
                type="number"
                step={0.05}
                min={0.3}
                max={1.0}
                className="form-input"
                value={settings.bgmCEV}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (Number.isFinite(v) && v >= 0.3 && v <= 1.0) setSettings({ bgmCEV: v });
                }}
                style={{ width: 140 }}
              />
            </div>
            <div className="form-helper">
              Shifted-CEV LMM exponent: dynamics dF̂ = F̂^β · σ · dW. β=1 recovers shifted lognormal; β&lt;1 dampens the upper tail because effective F-vol scales as F̂^(β−1) → 0 as F̂ rises. Default 0.7 is the practitioner standard. Re-calibrate after changing.
            </div>
          </section>
        )}

        <section style={{ marginBottom: 24 }}>
          <div className="group-label">Run defaults</div>
          <div className="form-row">
            <span className="form-label">Horizon (years)</span>
            <input
              type="number"
              step={1}
              min={1}
              max={30}
              className="form-input"
              value={settings.horizonYears}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (Number.isFinite(v) && v >= 1 && v <= 30) setSettings({ horizonYears: v });
              }}
              style={{ width: 140 }}
            />
          </div>
        </section>

        <section style={{ marginBottom: 24 }}>
          <div className="group-label">Tenors for export (Save Run)</div>
          <div className="form-helper" style={{ marginBottom: 12 }}>
            Default selection covers the in-scope range. 20Y / 30Y are unchecked because the BGM long-horizon tail
            inherits the F_CEILING bound (see Run Info).
          </div>
          {TENORS_FOR_EXPORT.map((t) => (
            <label
              key={t.label}
              style={{ display: "block", padding: "4px 0", fontSize: 13 }}
            >
              <input
                type="checkbox"
                checked={settings.selectedTenorLabels.includes(t.label)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...settings.selectedTenorLabels, t.label]
                    : settings.selectedTenorLabels.filter((l) => l !== t.label);
                  setSettings({ selectedTenorLabels: next });
                }}
                style={{ marginRight: 8 }}
              />
              {t.label}
            </label>
          ))}
        </section>

        {!isInternal && (
          <section>
            <div className="form-helper">
              Public deployment: engineering controls (seed, F_CEILING) and the raw martingale diagnostic export are hidden by design.
            </div>
          </section>
        )}
      </aside>
    </>
  );
}
