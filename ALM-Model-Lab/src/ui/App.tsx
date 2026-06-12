import { useState, type ComponentType } from "react";
import "./styles.css";

import { AppProvider } from "./state/AppContext";
import { InstrumentProvider } from "./state/InstrumentContext";
import { Header } from "./components/Header";
import { TabBar, sectionOfTab, type SectionId, type TabId } from "./components/TabBar";
import { Toolbar } from "./components/Toolbar";
import { ImportTab } from "./tabs/ImportTab";
import { RateHistoryTab } from "./tabs/RateHistoryTab";
import { CurveTab } from "./tabs/CurveTab";
import { SabrTab } from "./tabs/SabrTab";
import { HwSimTab } from "./tabs/HwSimTab";
import { BgmSimTab } from "./tabs/BgmSimTab";
import { CompareTab } from "./tabs/CompareTab";
import { MbsTab } from "./tabs/MbsTab";
import { NmdTab } from "./tabs/NmdTab";
import { NmdBTab } from "./tabs/NmdBTab";
import { ReplicatingPortfolioTab } from "./tabs/ReplicatingPortfolioTab";
import { FixedLoanTab } from "./tabs/FixedLoanTab";
import { FloatingLoanTab } from "./tabs/FloatingLoanTab";
import { RepricingGapTab } from "./tabs/RepricingGapTab";
import { LiquidityGapTab } from "./tabs/LiquidityGapTab";
import { FtpTab } from "./tabs/FtpTab";
import { SegEbpTab } from "./tabs/SegEbpTab";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { useApp } from "./state/AppContext";

/**
 * Single registry mapping every TabId to its component. Record<TabId, ...>
 * is exhaustiveness-checked: a TabId without a component is a compile error
 * rather than a silently blank main area.
 */
const TAB_COMPONENTS: Record<TabId, ComponentType> = {
  import: ImportTab,
  rateHistory: RateHistoryTab,
  curve: CurveTab,
  sabr: SabrTab,
  hwSim: HwSimTab,
  bgmSim: BgmSimTab,
  compare: CompareTab,
  fixedLoan: FixedLoanTab,
  floatingLoan: FloatingLoanTab,
  // The tab id "mortgage" is the new label for the legacy MBS tab. Promotes
  // to a full Mortgage instrument in Phase 5 (loan age + balance inputs).
  mortgage: MbsTab,
  nmd: NmdTab,
  nmdBeta: NmdBTab,
  replicatingPortfolio: ReplicatingPortfolioTab,
  repricingGap: RepricingGapTab,
  liquidityGap: LiquidityGapTab,
  ftp: FtpTab,
  segEbp: SegEbpTab,
};

function MobileBlock() {
  return (
    <div className="mobile-block">
      <h1 style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 24 }}>
        ALM Model Lab
      </h1>
      <p style={{ marginTop: 16 }}>
        Designed for desktop. Please widen your window or use a screen at least 1024px wide.
      </p>
    </div>
  );
}

function Shell() {
  const [tab, setTab] = useState<TabId>("import");
  // Per-section memory: switching sections restores the last tab visited
  // there instead of resetting to the section default.
  const [lastTabBySection, setLastTabBySection] = useState<Partial<Record<SectionId, TabId>>>({});

  const handleTabChange = (id: TabId) => {
    setTab(id);
    setLastTabBySection((prev) => ({ ...prev, [sectionOfTab(id)]: id }));
  };

  const [settingsOpen, setSettingsOpen] = useState(false);
  const { saveRun, loadRunFromZip, hwSim, bgmSim, hw, bgm, errorMessage } = useApp();

  const handleLoadRun = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const buf = await file.arrayBuffer();
      try {
        loadRunFromZip(new Uint8Array(buf));
        // The current implementation hydrates settings + calibration date.
        // Tabs that consume hwSim/bgmSim continue to read live state until
        // a re-run; loaded paths are surfaced via the Run Info popover.
        alert(
          "Run manifest loaded. Calibration date and settings restored. Click Calibrate then Run on each simulator tab to repopulate live charts (or open Run Info from the header to see the loaded run's parameters).",
        );
      } catch (err) {
        alert(`Failed to load run: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    input.click();
  };

  const saveDisabled = !hw || !bgm || !hwSim || !bgmSim;
  const ActiveTab = TAB_COMPONENTS[tab];

  return (
    <div className="app-shell">
      <Header />
      <TabBar active={tab} onChange={handleTabChange} lastTabBySection={lastTabBySection} />
      <main className="main">
        {errorMessage && (
          <div
            style={{
              background: "#fdf1f1",
              border: "1px solid #e0a0a0",
              borderRadius: 6,
              padding: "10px 14px",
              marginBottom: 16,
              fontSize: 13,
              color: "#8b1a1a",
              lineHeight: 1.5,
            }}
          >
            <strong>Error:</strong> {errorMessage}
          </div>
        )}
        <ActiveTab />
      </main>
      <Toolbar
        onSaveRun={saveRun}
        onLoadRun={handleLoadRun}
        onOpenSettings={() => setSettingsOpen(true)}
        saveDisabled={saveDisabled}
      />
      <div className="disclosure-bar">
        For educational and illustrative purposes only. The ALM Model Lab and its outputs do
        not constitute financial, investment, or regulatory advice and are not intended for use
        in actual risk-management decisions. Views are the creator&apos;s own and do not
        represent any employer or organization.
      </div>
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <InstrumentProvider>
        <MobileBlock />
        <Shell />
      </InstrumentProvider>
    </AppProvider>
  );
}
