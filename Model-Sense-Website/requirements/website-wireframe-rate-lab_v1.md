# ALM Model Lab — Wireframe (Allen, v1)

**Status:** draft for Chih's review.
**Author:** Allen.
**Date:** 2026-05-05.
**Predecessor:** [`rate-lab-requirements_v1.md`](rate-lab-requirements_v1.md) (approved 2026-05-05).
**Next step on approval:** Phase 3c build at [`Model-Sense/ALM-Model-Lab/src/ui/`](../../ALM-Model-Lab/src/ui/).

This wireframe describes layout, content, and interaction for every screen. No visuals beyond ASCII; the design system tokens carry the actual look.

---

## Global chrome

Every tab shares the same outer layout.

```
+------------------------------------------------------------------+
|  [LOGO]  Model Sense ALM Model Lab                  Run: 2025-09-30   |
|                                                500 paths  [ⓘ]   |
+------------------------------------------------------------------+
|                                                                  |
|  Import   Curve   SABR   HW Sim   BGM Sim   Compare   MBS   NMD  |
|                                                                  |
+------------------------------------------------------------------+
|                                                                  |
|                       [ active tab content ]                     |
|                                                                  |
+------------------------------------------------------------------+
|  [ Save Run ↓ ]  [ Load Run ↑ ]                  [ ⚙ Settings ]  |
+------------------------------------------------------------------+
```

**Header (sticky, 72px)**
- Left: `<img src="../assets/Logo New.png">` 32px tall, then page title in Playfair Display italic 24px (`color: var(--obsidian)`).
- Right: active run summary — calibration date in Sora 600, path count in Sora 400, then an `ⓘ` info icon. The icon hover-opens the **Run Info Panel** (see below).

**Tab bar (sticky, 56px)**
- Eight tabs left-aligned, Sora 500 14px, uppercase tracking 0.05em. Active tab gets the obsidian underline (3px) plus `color: var(--obsidian)`. Inactive tabs `color: rgba(18,19,18,0.55)`.
- Keyboard: `←` / `→` cycle tabs; numeric `1`-`8` jumps to tab N.

**Toolbar (footer, 56px, always visible)**
- `Save Run ↓` — primary filled button, obsidian background. Triggers explicit disk export.
- `Load Run ↑` — ghost button. Opens file picker for `.zip` or extracted folder.
- `⚙ Settings` — ghost button right-aligned. Opens the **Settings Drawer**.

**Run Info Panel (hover/focus on ⓘ)** — content per Chih's decision §5:
- Calibration date, run ID, seed (internal mode only), path count.
- HW: a, σ, RMSE.
- BGM: a, b, c, d, β, volScalar, RMSE.
- Known limitations block (always visible, both modes):
  - "1Y ATM cap is anomalously low (72 bp vs 82-88 bp elsewhere). HW absorbs this as a +11 bp residual at 1Y; rest of the surface fits within ±5 bp."
  - "BGM long-horizon tail (>10Y horizon × ≥20Y tenor) inherits the F_CEILING bound. Use HW for 20Y+ stress work or wait for Phase 4+ Glasserman-Zhao port."

**Settings Drawer (slide-in from right, 360px wide)** — internal-mode-only sections marked **(internal)**:
- Seed *(internal)*. Numeric input. Default 20250930.
- F_CEILING *(internal)*. Decimal input. Default 2.0.
- Tenor list for export (checkbox set, both modes). Default: 1D, 1M, 3M, 6M, 1Y, 2Y, 5Y, 7Y, 10Y, 20Y, 30Y.
- Show raw martingale diagnostic *(internal)*. Toggle. When on, HW Sim and BGM Sim tabs reveal the per-step DF-error chart.
- Mode indicator (read-only): "Internal" or "Public". Driven by build flag.

---

## Tab 1 — Import

The entry point. On first load the bundled 9/30/2025 data populates everything; this tab shows it and allows override.

```
+------------------------------------------------------------------+
|                                                                  |
|  Import market data                                              |
|                                                                  |
|  +------------------+  +------------------------------------+    |
|  | Calibration date |  |  Currently loaded: 2025-09-30      |    |
|  | [ 2025-09-30  📅 ]|  |  Discounting index: SOFR_OIS       |    |
|  +------------------+  |  Currency: USD                     |    |
|                        +------------------------------------+    |
|                                                                  |
|  Path count                                                      |
|  [  500   ▲▼ ]   100 quick · 500 canonical · 1000-10000 stress   |
|                                                                  |
|  Upload data                                                     |
|  +-----------------------+  +-----------------------+            |
|  | SOFR OIS curve        |  | Cap volatility surface|            |
|  |  Drop CSV or [browse] |  |  Drop CSV or [browse] |            |
|  |  Format ⓘ Template ↓  |  |  Format ⓘ Template ↓  |            |
|  +-----------------------+  +-----------------------+            |
|  +-----------------------+                                       |
|  | ATM swaption surface  |                                       |
|  |  Drop CSV or [browse] |                                       |
|  |  Format ⓘ Template ↓  |                                       |
|  +-----------------------+                                       |
|                                                                  |
|  +------------------ Curve quotes (preview) -----------------+   |
|  |  Term     t (yrs)   Type   Rate                           |   |
|  |  1D       0.0028    CASH   3.6300%                        |   |
|  |  1M       0.0833    SWAP   3.6600%                        |   |
|  |  ...                                                      |   |
|  +-----------------------------------------------------------+   |
|                                                                  |
|  +------- Cap surface (preview) -----+ +-- Swpn ATM (preview) -+ |
|  |  matrix table, ATM column shaded   | |  matrix table         | |
|  +------------------------------------+ +-----------------------+ |
|                                                                  |
|                                          [ Calibrate models → ]  |
|                                                                  |
+------------------------------------------------------------------+
```

**Calibration date input**: HTML `<input type="date">`, default 2025-09-30, max = today. Required. Re-calibration triggers a "Recalibrate?" confirmation if a run is already active and the date changes.

**Path count input**: numeric stepper, even integers only, range 100-10000. Soft warning above 5000.

**Upload card** (one per surface): drag-drop or browse. **Format ⓘ** opens a modal with the exact column convention (Term / InstType / Mid for the curve; Expiry + strike columns for cap; Expiry + tenor columns for swaption). **Template ↓** downloads a sample CSV. On successful parse, the relevant preview table refreshes and a green "Loaded N rows" toast appears under the card.

**Calibrate models** button: prominent, obsidian filled, bottom-right of the tab. Disabled until all three surfaces are present. Click triggers the calibrate Web Worker; progress shown as a toast at top-right (HW step → BGM step → done).

---

## Tab 2 — Curve

Three sub-views toggled by segmented control: **Zero curve** | **Forward curve** | **Discount factors**.

```
+------------------------------------------------------------------+
|                                                                  |
|  Bootstrapped zero curve                                         |
|  ( Zero | Forward | Discount )                                   |
|                                                                  |
|  +-------------------------------------------------+ +--------+  |
|  |                                                  | |        | |
|  |          chart (line + market dots)              | | tenor  | |
|  |                                                  | | for    | |
|  |                                                  | | fwd:   | |
|  |                                                  | | [1Y ▼] | |
|  +-------------------------------------------------+ +--------+  |
|                                                                  |
|  +---- Curve nodes table -----+                                  |
|  |  t (yrs)   z       DF       |                                 |
|  |  ...                        |                                 |
|  +-----------------------------+                                 |
|                                                                  |
+------------------------------------------------------------------+
```

**Zero view**: line chart of `z(t)` from t=0 to t=30Y. Sand-coloured dots for each input curve quote. X axis: years (0, 1, 2, 5, 10, 20, 30 ticks). Y axis: percentage (auto-scaled).

**Forward view**: line chart of `F(t, t+τ)` with τ chosen by the side panel selector (default 1Y). Same x/y conventions.

**Discount view**: line chart of `DF(0, t)`, log-y option toggle.

Tenor selector for forward chart: dropdown 1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y, 30Y.

---

## Tab 3 — SABR

```
+------------------------------------------------------------------+
|                                                                  |
|  SABR smile (Bachelier, β = 0)                                   |
|                                                                  |
|  Tenor τ for ATM forward:  [1Y ▼]                                |
|                                                                  |
|  +-------------------------------------------------+             |
|  |  4 lines: T = 1Y, 2Y, 5Y, 10Y                    |            |
|  |  X axis: strike offset from ATM (-150 to +150 bp)|            |
|  |  Y axis: implied normal vol (bp)                 |            |
|  |  Each line uses node-purple at varying lightness |            |
|  +-------------------------------------------------+             |
|                                                                  |
|  Fitted SABR parameters                                          |
|  α = 0.0085   β = 0.00 (fixed)   ρ = -0.30   ν = 0.70            |
|                                                                  |
+------------------------------------------------------------------+
```

Tenor selector restricted to the swaption surface tenors (1Y, 2Y, 5Y, 10Y for the bundled data).

---

## Tab 4 — HW Sim

```
+------------------------------------------------------------------+
|                                                                  |
|  Hull-White 1F simulation                                        |
|                                                                  |
|  +------------- Controls -------------+                          |
|  |  Tenor τ for forward chart [1Y ▼]  |   [ Run HW simulation → ] |
|  +------------------------------------+                          |
|                                                                  |
|  +-------------------------------------------------+             |
|  |  Fan chart: 25 sample paths in node-orange-15%, |             |
|  |  mean as solid node-orange, p5/p95 band sand-30%,|            |
|  |  market expectation overlay as dashed obsidian   |            |
|  +-------------------------------------------------+             |
|                                                                  |
|  +-- Percentile cross-sections at 1M, 1Y, 5Y, 10Y, 20Y, 30Y --+  |
|  |  table: month, mean, p5, p25, p75, p95                       | |
|  +--------------------------------------------------------------+ |
|                                                                  |
|  +-- Martingale diagnostic (internal mode only) ---------------+  |
|  |  bar chart: per-step DF error in bp, corrected vs uncorrected|  |
|  +--------------------------------------------------------------+ |
|                                                                  |
+------------------------------------------------------------------+
```

**Run HW simulation** button: prominent, obsidian filled. Disabled until calibration completes. Click posts to `hw.worker.ts`. While running, button shows a spinner and progress percentage; tab content stays interactive but a top toast tracks state.

**Tenor selector**: 1D, 1M, 3M, 6M, 1Y, 2Y, 5Y, 7Y, 10Y, 20Y, 30Y. Changes the fan chart projection without re-running the simulation (the HW analytical projection is closed-form on stored X paths).

**Fan chart**: x = simulation time in years (0-30), y = forward rate in %. 25 thin sample paths drawn from the full 500. Solid mean line. p5/p95 band as an Area component.

**Martingale diagnostic**: only visible when Settings → "Show raw martingale diagnostic" is on. Obsidian + sand bars, ±10 bp range visible.

---

## Tab 5 — BGM Sim

Identical structural layout to HW Sim but for BGM. Series colour is node-teal instead of node-orange.

Notable difference: the **Run BGM simulation** button shows a longer-running progress (predictor-corrector is heavier than HW). Progress emitted from the worker every 12 steps.

The Run Info Panel notes the long-horizon caveat; the BGM Sim tab additionally shows a small inline note above the fan chart in italic Sora 12px:

> Long-horizon tenors (≥ 20Y) inherit the F_CEILING bound; use HW for 20Y+ stress work.

This note is shown in both modes (per Chih's §5 decision).

---

## Tab 6 — Compare

Two stacked panels.

```
+------------------------------------------------------------------+
|                                                                  |
|  HW vs BGM comparison                                            |
|                                                                  |
|  +-- Single tenor --------------------------------+              |
|  |  Tenor τ:  [1Y ▼]                              |              |
|  |  +-------------------------------------------+ |              |
|  |  | line + band: HW mean orange, BGM mean teal|  |             |
|  |  | bands: orange-30% and teal-30%            |  |             |
|  |  | x: time, y: rate                          |  |             |
|  |  +-------------------------------------------+ |              |
|  +------------------------------------------------+              |
|                                                                  |
|  +-- Term spread ---------------------------------+              |
|  |  Short tenor:  [1M ▼]    Long tenor:  [10Y ▼]  |              |
|  |  +-------------------------------------------+ |              |
|  |  | line + band: HW spread orange, BGM teal   |  |             |
|  |  | x: time, y: spread (bp)                    |  |             |
|  |  +-------------------------------------------+ |              |
|  +------------------------------------------------+              |
|                                                                  |
+------------------------------------------------------------------+
```

Both panels disabled until BOTH simulations have run. The two tenor selectors in the spread panel must satisfy short < long; UI rejects invalid selections with a small inline error.

---

## Tab 7 — MBS

```
+------------------------------------------------------------------+
|                                                                  |
|  MBS prepayment model                                            |
|                                                                  |
|  +- Controls -----------------+ +- S-curve diagnostic --------+   |
|  |  Sec OAS spread   [ 120 ]   | |  CPR vs rate-diff line plot| |
|  |  Prim spread      [ 130 ]   | |  obsidian line; vertical   | |
|  |  WAC              [ 6.50 ]  | |  obsidian rule at the      | |
|  |  Min CPR          [ 2.0 ]   | |  current rate diff         | |
|  |  Max CPR          [ 65.0 ]  | +----------------------------+ |
|  |  Steepness        [ 1.5 ]   |                                |
|  |  Inflection       [ 50 ]    |                                |
|  |  Seasoning ramp   [ 30 ]    | +- Aux diagnostic plots ----+   |
|  |  Seasonality amp  [ 20 ]    | | seasoning, seasonality,   |   |
|  |  Burnout decay    [ 0.1 ]   | | burnout (small multiples) |   |
|  |  [Run MBS analytics →]      | +----------------------------+ |
|  +-----------------------------+                                |
|                                                                  |
|  Stale flag: yellow banner if controls changed since last run    |
|                                                                  |
|  +------------- Output charts and tables ---------------------+  |
|  |  CPR fan chart (mean + p5/p95 band) for HW and BGM scenarios| |
|  |  Balance fan chart                                          |  |
|  |  WAL bar chart: Base / HW / BGM                             |  |
|  +------------------------------------------------------------+ |
|                                                                  |
+------------------------------------------------------------------+
```

Same control set as the prototype. Run analytics button disabled until both HW and BGM simulations are complete.

---

## Tab 8 — NMD

Identical layout pattern to MBS but with NMD-specific controls. **Top of tab carries an "Illustrative only" banner** per Chih's §2 decision:

```
+------------------------------------------------------------------+
|  ⚠  Illustrative only. The Model Sense canonical deposit         |
|     decay framework lands in Chapter 4+ work; this tab uses a    |
|     simple logistic spread-driven decay for engine demonstration.|
+------------------------------------------------------------------+
```

Banner uses sand background at 50%, obsidian text, 12px padding, ⚠ icon left-aligned. Cannot be dismissed (information not nuisance).

NMD-specific controls:
- Closure rate (% per month)
- Max rate decay
- Max rate growth
- Logistic K (steepness)
- Logistic midpoint
- MA period (months)
- Balance size, balance denominator

Output: same fan chart pattern (decay rate, balance) plus WAL bar chart.

Historical SOFR overlay: the warmup window (24-month MA from real history) is shown as a small reference chart in the bottom-left, with a vertical line marking the simulation start.

---

## Save Run flow (modal)

Triggered by toolbar "Save Run ↓":

```
+------------------- Save Run -------------------+
|                                                |
|  Run ID: 2025-09-30_20250930_500paths          |
|                                                |
|  This run is auto-saved to OPFS. Click below   |
|  to download a portable copy.                  |
|                                                |
|  Tenors to include in the export:              |
|  [✓] 1D [✓] 1M [✓] 3M [✓] 6M [✓] 1Y           |
|  [✓] 2Y [✓] 5Y [✓] 7Y [✓] 10Y [ ] 20Y [ ] 30Y |
|                                                |
|  Format: [✓] Manifest JSON  [✓] Path CSVs      |
|          [✓] Calibration report                |
|          [ ] Raw martingale diagnostic (int.)  |
|                                                |
|                  [ Cancel ]   [ Download ↓ ]   |
+------------------------------------------------+
```

Tenor checkboxes default to the Settings Drawer values (the user's saved preference). 20Y/30Y unchecked by default per the long-horizon caveat — the user can opt in.

The download is a single `.zip` packaged in-browser, named `rate-lab_{runID}.zip`.

---

## Load Run flow

Toolbar "Load Run ↑" opens the OS file picker for `.zip` files. On selection:
1. Extract in-memory.
2. Validate manifest.json exists and has the expected schema.
3. Parse path CSVs into the same internal data structures the simulator produces.
4. Update the active run banner.
5. All tabs refresh; charts redraw from the loaded data without re-running calibration or simulation.

If validation fails, a modal explains which file failed and why. No partial loads.

---

## Responsive behaviour

- Above 1280px: full layout as drawn.
- 1024px-1280px: side panels (tenor selectors, control columns) compress; chart areas hold their aspect ratio. No content removed.
- Below 1024px: blocking banner — *"Model Sense ALM Model Lab is designed for desktop. Please widen your window or use a larger screen."* — followed by the page collapsed into a single-column read-only summary.

Per Allen's persona anti-pattern, no mobile build in v1.

---

## Build-stage notes for Phase 3c

- React component tree mirrors the tab structure: `<App>` → `<TabContainer>` → one component per tab. Shared chart wrapper component to centralise Recharts theming.
- All chart colour values pull from a `tokens.ts` module that re-exports the design system CSS custom properties so a single token edit propagates.
- Settings Drawer state lives at the App level (lifted shared state).
- Run history (auto-save records) is a small useReducer; OPFS reads/writes are async via a `storage/` module (already scaffolded).
- Internal vs public mode driven by `import.meta.env.MODE` plus a `VITE_PUBLIC_DEPLOY` env flag. Build pipeline produces two artefacts when the public version ships: `dist-internal/` and `dist-public/`.

---

*Wireframe ready for Chih's review. Build (Phase 3c) starts on approval.*
