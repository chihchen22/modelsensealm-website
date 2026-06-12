/**
 * Two-level navigation: Section selector + section-scoped tab bar.
 *
 * Sections group related tabs. Selecting a section reveals its tabs and
 * restores the last tab visited in that section (Shell passes the memory
 * via `lastTabBySection`; first visit lands on the section's defaultTab).
 */

export type SectionId = "calibration" | "rateModels" | "instruments" | "analytics";

export type TabId =
  // Market Data (section id "calibration" kept for continuity)
  | "import"
  | "rateHistory"
  | "curve"
  | "sabr"
  // Rate Models
  | "hwSim"
  | "bgmSim"
  | "compare"
  // Instruments
  | "fixedLoan"
  | "floatingLoan"
  | "mortgage"
  | "nmd"
  | "nmdBeta"
  | "replicatingPortfolio"
  // Analytics
  | "repricingGap"
  | "liquidityGap"
  | "ftp"
  | "segEbp";

export interface TabSpec {
  id: TabId;
  label: string;
}

export interface SectionSpec {
  id: SectionId;
  label: string;
  defaultTab: TabId;
  tabs: ReadonlyArray<TabSpec>;
}

export const SECTIONS: ReadonlyArray<SectionSpec> = [
  {
    id: "calibration",
    label: "Market Data",
    defaultTab: "import",
    tabs: [
      { id: "import", label: "Import" },
      { id: "rateHistory", label: "Rate History" },
      { id: "curve", label: "Curve" },
      { id: "sabr", label: "SABR" },
    ],
  },
  {
    id: "rateModels",
    label: "Rate Models",
    defaultTab: "hwSim",
    tabs: [
      { id: "hwSim", label: "HW Sim" },
      { id: "bgmSim", label: "BGM Sim" },
      { id: "compare", label: "Compare" },
    ],
  },
  {
    id: "instruments",
    label: "Instruments",
    defaultTab: "mortgage",
    tabs: [
      { id: "fixedLoan", label: "Fixed Loan" },
      { id: "floatingLoan", label: "Floating Loan" },
      { id: "mortgage", label: "Mortgage" },
      { id: "nmd", label: "Non-IB NMD" },
      { id: "nmdBeta", label: "IB NMD" },
      { id: "replicatingPortfolio", label: "Replicating Pf" },
    ],
  },
  {
    id: "analytics",
    label: "ALM Analytics",
    defaultTab: "repricingGap",
    tabs: [
      { id: "repricingGap", label: "Repricing Gap" },
      { id: "liquidityGap", label: "Liquidity Gap" },
      { id: "ftp", label: "FTP" },
      { id: "segEbp", label: "SEG / EBP" },
    ],
  },
];

/** Map every tab to its parent section for active-section inference. */
export function sectionOfTab(tabId: TabId): SectionId {
  for (const s of SECTIONS) {
    if (s.tabs.some((t) => t.id === tabId)) return s.id;
  }
  return "calibration";
}

interface TabBarProps {
  active: TabId;
  onChange: (id: TabId) => void;
  /** Last tab visited per section; section clicks restore it over defaultTab. */
  lastTabBySection?: Partial<Record<SectionId, TabId>>;
}

export function TabBar({ active, onChange, lastTabBySection }: TabBarProps) {
  const activeSectionId = sectionOfTab(active);
  const activeSection = SECTIONS.find((s) => s.id === activeSectionId)!;

  const onSectionClick = (s: SectionSpec) => {
    if (s.id === activeSectionId) return;
    onChange(lastTabBySection?.[s.id] ?? s.defaultTab);
  };

  return (
    <>
      <nav className="section-bar" role="tablist" aria-label="ALM Model Lab sections">
        <div className="chrome-inner">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === activeSectionId}
              className={`section-button${s.id === activeSectionId ? " active" : ""}`}
              onClick={() => onSectionClick(s)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </nav>
      <nav className="tab-bar" role="tablist" aria-label={`${activeSection.label} tabs`}>
        <div className="chrome-inner">
          {activeSection.tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active === t.id}
              className={`tab-button${active === t.id ? " active" : ""}`}
              onClick={() => onChange(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>
    </>
  );
}
