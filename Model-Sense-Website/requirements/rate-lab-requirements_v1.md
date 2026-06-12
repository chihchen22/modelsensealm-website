# ALM Model Lab — Requirements (Allen, v1)

**Status:** draft for Chih's review.
**Author:** Allen (web designer) — Phil routed.
**Date:** 2026-05-05.
**Plan:** `C:\Users\deech\.claude\plans\i-want-to-build-quiet-alpaca.md`.
**Math layer (already built):** `Model-Sense/ALM-Model-Lab/src/math/` and `src/workers/`. 22/22 tests passing; production build at 143 KB JS / 46 KB gzipped.

This document captures what the dashboard does, what's settled, and what's open. No mockups or build work begins until Chih signs off.

---

## 1. What this tool is

A single-page web application that recreates the Gemini-built rate simulator with the same calculations and the Model Sense visual identity applied. The dashboard ingests SOFR OIS curve and cap/swaption volatility surfaces, calibrates Hull-White 1F and BGM/LMM 2-factor models, runs Monte Carlo simulations, and produces forecasts with downstream behavioral examples (MBS prepayment, NMD decay).

**Internal first, public later.** The tool ships as an internal Vite project at `Model-Sense/ALM-Model-Lab/`. The same codebase produces a static `dist/` artefact that drops into `Model-Sense-Website/build/rate-lab/` when the public version is ready. One codebase, two deployments. The internal version may surface engineering controls (seed, F_CEILING, raw diagnostics) that the public version hides; otherwise content is identical.

## 2. Tech stack (locked)

- **Vite + React 18 + TypeScript.** Project scaffolded; npm install clean; production build clean.
- **Recharts** for charts (matches the prototype). **lucide-react** for icons (matches the prototype).
- **Web Workers** for the calibration and Monte Carlo loops to keep the main thread responsive.
- **OPFS** for in-session run persistence; falls back to IndexedDB if OPFS unavailable.
- **No external state libraries** (Redux, Zustand) for v1. React useState plus a small useReducer for the run history. Reassess in v2 if state surface grows.
- **Math layer**: `ml-levenberg-marquardt` (npm) for least-squares. PCG32 PRNG inlined (no extra dep). Brent root finder inlined.

## 3. Visual identity (Model Sense design system)

Reference files:
- Tokens: `Model-Sense-Website/assets/design-system/design-system.html`.
- Reference component: `Model-Sense-Website/build/agent-dashboard.html` (Allen's prior work; the "clean" pattern Chih asked for).
- Logo: `Model-Sense-Website/assets/Logo New.png`.

**Palette mapping:**
- `--obsidian` (#121312) — primary text, axis labels, deterministic-curve series.
- `--cloud-dancer` (#F6F6F4) — page background.
- `--sand` (#D1CBC1) — accent on labels, hover states, percentile-band fills (alpha 30%).
- Node colours from the design system for chart series:
  - HW model series — node-orange.
  - BGM model series — node-teal.
  - SABR fitted curve — node-purple.
  - Initial deterministic curve — obsidian.
  - Market data points — sand outline, no fill.

**Typography:**
- Playfair Display serif (italic) — page title, tab headings, dashboard hero.
- Sora sans — body text, control labels, table content.
- Numerical content uses Sora 400 weight with tabular-nums for column alignment.

**Spacing and components:**
- 96px section gutters, 48px column gutters, 24px control gutters (matches design system).
- `dash-card` for parameter panel groupings.
- Top nav with left-aligned logo, right-aligned tab links plus an "i" info icon that surfaces calibration date and run ID.
- No dark mode in v1 (per Allen persona anti-pattern: "bank practitioners read in office environments").

## 4. Information architecture

Eight tabs, byte-for-byte parity with the Gemini prototype's structure. Tab order and labels:

| # | Tab | Purpose |
|---|---|---|
| 1 | **Import** | Upload curve + cap + swaption CSVs; **set calibration date**; **set path count**; download templates; review uploaded data tables. |
| 2 | **Curve** | Bootstrapped zero / forward / discount-factor visualisation; tenor selector for the forward chart. |
| 3 | **SABR** | Smile slice for selected swaption tenor; per-expiry vol curves at selected strikes. |
| 4 | **HW Sim** | HW1F simulation panel: launch button, progress, rate fan chart at selected tenor, percentile band, expectation overlay, martingale diagnostic. |
| 5 | **BGM Sim** | Same as HW Sim but for BGM/LMM. |
| 6 | **Compare** | Side-by-side HW vs BGM at selected single tenor; HW vs BGM term spread between two tenors. |
| 7 | **MBS** | Logistic CPR model, S-curve diagnostic, deterministic + stochastic CPR / balance fan chart, WAL summary. |
| 8 | **NMD** | Logistic closure model, S-curve diagnostic, historical SOFR overlay (warmup window), decay + balance fan chart. |

**Settings drawer** (slide-in from right, accessible from any tab): seed, F_CEILING, default tenor list for Save Run export. Internal-only controls live here.

## 5. New controls on the Import tab

These are net-new vs the Gemini prototype, per Chih's earlier ask.

**Calibration Date** — date picker. Default 2025-09-30 (canonical reference). Required field; the simulator manifest records the value, and the disk-export filename includes it.

**Path count (n_paths)** — numeric input with stepper. Default 500. Even integer (antithetic pairing); the form rejects odd numbers with a clear error. Guidance copy beneath: *"100 for quick exhibits, 500 for the canonical run, 1000-10000 for stress runs."* Above 5000 the form shows a soft warning about computation time and memory.

**F_CEILING** (Settings drawer, internal-only) — numeric input, decimal. Default 2.0. Tooltip: *"BGM forward-rate cap to prevent overflow. The lognormal model is theoretically infinite-tailed; a cap is needed for numerical stability. 2.0 keeps p95 unbiased across the full 30Y horizon at 9/30/2025-calibrated vol."*

**Tenor list for export** (Settings drawer) — checkbox set. Default: 1D, 1M, 3M, 6M, 1Y, 2Y, 5Y, 7Y, 10Y, 20Y, 30Y. Save Run writes one CSV per checked tenor per model.

## 6. Run management

**Save Run** — prominent button on every tab (toolbar). Action:
1. Writes per-tenor path CSVs to OPFS keyed by `run-id` (= `{calibrationDate}_{seed}_{nPaths}paths`).
2. Triggers the user's browser download dialog with a `runs.zip` containing the manifest + per-tenor path CSVs. The user picks where to save it on disk; from there other agents (Larry, Kobe, masterclass) consume the CSVs through the standard file-handoff protocol.

**Load Run** — file picker accepts a `runs.zip` exported earlier. Restores the state of every tab (calibration parameters, path projections) without re-running the simulation. Useful for sharing canonical runs across team members.

**Active Run indicator** — top-right of the nav. Shows the current run-id, with a hover tooltip listing the calibration date, path count, RMSEs, and a link to the manifest viewer.

## 7. Memory and performance targets

| Metric | Target | Note |
|---|---|---|
| Initial page load (cold cache) | < 2s on a corporate LAN | Vite production bundle is 143 KB JS / 46 KB gzipped. Headroom for the design system assets. |
| Cold calibration (HW + BGM, 9/30/2025 surface) | < 5s end-to-end | LM iteration counts 500-4000; experimentally 3.5s in vitest run. |
| HW Monte Carlo (500 paths, 30Y, monthly) | < 8s | Pure-function path; off main thread. |
| BGM Monte Carlo (500 paths, 30Y, monthly) | < 30s | Predictor-corrector is 2x cost vs Euler; off main thread; progress updates via postMessage. |
| Peak browser memory during BGM run | < 350 MB | Streamed projection drops the 360x360 forward grid as it advances. |
| Resident memory after run completes | < 80 MB | Path projections live in OPFS, not React state. |

## 8. CSV export format (handoff protocol)

Compatible with Steph's existing convention at `ALM-Modeling-Book/chapters/ch03/sofr_paths_100x_v1.csv`:
- Filename: `paths_{model}_{tenorLabel}.csv`. Models: `hw`, `bgm`. Tenor labels: `1D`, `1M`, ..., `30Y`.
- Header row: `Month, Year, path_001, path_002, ..., path_N`.
- Data rows: 360 monthly observations (or `nSteps` if the user reduces horizon).
- Decimal annualised rates (e.g. `0.036486` for 3.6486%).

Manifest JSON additionally includes calibration date, fitted parameters, RMSEs, seed, F_CEILING, run timestamp.

## 9. Accessibility and responsiveness

- WCAG 2.1 AA contrast across the palette (verified for obsidian-on-cloud-dancer; sand-on-cloud-dancer needs verification at small sizes — Allen will run a contrast audit during build).
- Keyboard navigation across tabs (arrow keys), input focus rings, ARIA labels on controls.
- **Desktop-first**, breakpoint at 1024px. Below 1024px the dashboard renders a "best viewed on a wider screen" banner and stacks tabs vertically. Bank practitioners read on desktop.

## 10. Out of scope for v1

- Authentication / user accounts. Internal tool, single user.
- Multi-currency. USD SOFR only; the loader's dataclass is currency-tagged so v2 can extend.
- Model versioning. v1 ships one HW + one BGM model. Adding HJM or G2++ is v2.
- Historical replay. v1 is a calibration-date snapshot tool.
- Server-side persistence. OPFS only; the user can export to disk for sharing.
- Mobile. Desktop-only.

## 11. Decisions (Chih, 2026-05-05)

All six questions resolved.

1. **Default market data**: ship `market_2025-09-30.json` pre-loaded. Provide an upload path; the upload UI must specify the CSV format AND prompt for the market data date.
2. **NMD module**: visible with an "Illustrative only" banner pending the Ch4+ deposit framework.
3. **Save Run UX**: auto-save every completed run to OPFS plus an explicit "Download Run" button for disk export.
4. **Series colours**: approved as proposed (HW = node-orange, BGM = node-teal, deterministic = obsidian, percentile bands = sand at 30% alpha).
5. **"i" info panel**: surface known limitations inline (1Y HW outlier; long-horizon BGM tail bias). Don't assume the user has read the memos.
6. **Internal-vs-public differences**: hide in the public deployment — seed input, F_CEILING setting, raw martingale diagnostic CSV. Build with a `mode = "internal" | "public"` flag.

## 11a. Original open questions (resolved)

1. **Default initial market data.** Ship with the bundled `market_2025-09-30.json` pre-loaded so the dashboard works on first launch without an upload, or require the user to upload before any tab populates? My recommendation: ship the bundled file; first-time users see immediate output, power users overwrite via upload.
2. **NMD module scope.** Steph's audit memo flagged the NMD logistic closure as illustrative only, with the canonical Model Sense deposit framework deferred to Ch4+ rework. Show the NMD tab in v1 (with a banner labelling it illustrative), or hide it until the proper framework lands?
3. **Save Run UX.** Auto-save every completed run to OPFS plus an explicit "Download Run" button for disk export, OR explicit "Save Run" button only? My recommendation: auto-save to OPFS (cheap, recoverable on tab close), explicit click for disk export.
4. **Visible model series colours.** Confirm or override the proposed mapping (HW = orange, BGM = teal, deterministic = obsidian, percentile bands = sand at 30%). The agent-dashboard.html groups already use these node colours; this preserves the brand mapping, but if you have a preference for HW vs BGM it's worth fixing now.
5. **"i" info dialog content.** Beyond the calibration date and run ID, what else should surface? The Phase 2b Dennis memo flagged the long-horizon BGM tail bias and the 1Y HW outlier; should the dashboard surface those caveats inline (with a "known limitations" panel), or assume the user has read the memos?
6. **Public-version differences.** When this becomes a public site page on modelsense.com, are there controls or output detail you'd want hidden from public view? Likely candidates: seed, F_CEILING setting, raw martingale diagnostic CSV. I'll build with a `mode = "internal" | "public"` flag from the start so we don't refactor later.

## 12. Next step

Chih signed off the six decisions on 2026-05-05. Allen produces the wireframe at `Model-Sense-Website/requirements/website-wireframe-rate-lab_v1.md` next. Build (Phase 3c) starts after wireframe approval.

---

*Requirements doc approved 2026-05-05.*
