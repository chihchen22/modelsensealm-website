# ALM Model Lab — 3/31/2026 Market-Data Re-baseline (Handoff v1)

Status: **planned + approved, not started.** Paused on cost 2026-06-10. A fresh
session should resume at Phase 0. Nothing for this rebuild is committed yet.

This document is self-contained: every source path, verified data structure, and
file/function touch-point is recorded so the build needs no re-inspection.

---

## Goal

Re-baseline the lab from 9/30/2025 to **3/31/2026** everywhere (SOFR curve, FHLB
curve, cap + swaption vol surfaces, rate history ending 3/31/2026), make market-data
import reproducible (kill the hand-edit failure mode that corrupted the 9/30 short
end), and add the two pieces the user's FTP workbook has that the lab lacks. Book
example scripts stay on 9/30/2025 and are untouched.

## Approved decisions (from AskUserQuestion, 2026-06-10)

1. **Scope:** re-baseline + add FTP-calc pieces (Prime floating instrument + FTP
   static-strip parity harness vs the user's four loan sheets).
2. **Import:** browser xlsx drop-zone in the Import tab **and** an offline Python
   converter, sharing one parsing contract.
3. **FHLB/TLP:** derive Term LP = FHLB − SOFR per tenor from the workbook's explicit
   FHLB curve; bake the FHLB curve into the snapshot; retire the hardcoded TLP
   default; keep the manual CSV override as a fallback.

Open sub-decision deferred to implementation: Prime/SOFR basis defaults to the
constant that reproduces the workbook's month-1 Prime coupon, exposed as an editable
parameter (unless the user later pins it to a convention like Prime = EFFR + 300 bp).

---

## Source files (uploads), verified structures

### `C:\Users\deech\Downloads\SOFR_Market_Data_20260331.xlsx`
The new vintage. Same 4-sheet format as the existing `SOFR_Market_Data_20250930.xlsx`
(in Downloads), which is the true source for the 9/30 snapshot.

**Sheet `SOFR_OIS_Curve`** — cols: Term | InstType | Mid. Tenor labels are spaced
("1 D", "1 MO", "1 YR"). Rows (decimal):
```
1 D  CASH 0.0368 | 1 MO 0.036609 | 3 MO 0.036768 | 6 MO 0.03683 | 1 YR 0.03701
2 YR 0.03621 | 3 YR 0.03578 | 4 YR 0.035852 | 5 YR 0.036215 | 10 YR 0.038664
20 YR 0.041642 | 30 YR 0.041332
```
Tenor set vs current lab: **adds 4Y/20Y/30Y, drops 15Y and 2M.**

**Sheet `FHLB_Curve`** — cols: Term | Mid. Same tenors:
```
1 D 0.0368 | 1 MO 0.0388 | 3 MO 0.0389 | 6 MO 0.0387 | 1 YR 0.0393 | 2 YR 0.0398
3 YR 0.0401 | 4 YR 0.0409 | 5 YR 0.0413 | 10 YR 0.0461 | 20 YR 0.0534 | 30 YR 0.0548
```
Derived **Term LP = FHLB − SOFR** (decimal), 1D pinned to 0 by convention:
```
1D 0 | 1M 0.002191 | 3M 0.002132 | 6M 0.00187 | 1Y 0.00229 | 2Y 0.00359
3Y 0.00432 | 4Y 0.005048 | 5Y 0.005085 | 10Y 0.007436 | 20Y 0.011758 | 30Y 0.013468
```
These match the FTP workbook's BBG "Term LP" column exactly (cross-check confirmed).

**Sheet `Cap_Volatility`** — dims A1:AA17 (27 cols, 15 expiry rows). Row 1 "Strikes",
row 2 header. **Strikes are RELATIVE MONEYNESS OFFSETS**, not absolute, with a
SEPARATE explicit `ATM` column. Header begins:
`Expiry | -2.00% | -1.50% | -1.25% | -1.00% | -0.75% | -0.50% | -0.25% | ATM | 0.00% | 0.25% | 0.50% | 0.75% | 1.00% | ...`
NOTE: the inspection dump capped at 14 cols; there are **27 columns total**, so strikes
continue past +1.00% (read the full header). Expiries: 1,2,3,4,5,6,7,8,9,10,12,15,20,25,30 Yr.
ATM normal vols are much lower than the smile wings (e.g. 1Yr ATM 0.000646 vs 0.00%
column 0.001471) — classic normal-vol ATM trough; do not conflate the `ATM` column with
the `0.00%` offset column.

**Sheet `ATM_Swaption_Volatility`** — dims A1:P23 (21 expiry rows). Row 2 header
`Expiry | 1Yr | 2Yr | ... | 20Yr` (tenors 1,2,3,4,5,6,7,8,9,10,12,15,20 Yr). Expiries:
1Mo,2Mo,3Mo,6Mo,9Mo,1Yr,18Mo,2Yr,3Yr,4Yr,5Yr,6Yr,7Yr,8Yr,9Yr,10Yr,12Yr,15Yr,20Yr,25Yr,30Yr.
Current lab `TENOR_TO_YEARS` lacks 9Mo/18Mo/2Mo/25Yr/30Yr/20Yr etc. — extend it.

### `C:\Users\deech\Downloads\Static_Strip_FTP_example_BBG_YC.xlsm`
The user's static-strip FTP reference (Bloomberg-bootstrapped). Sheets:
- **`Sheet1`** — canonical input layout: `Tenor | InstType | RFR Tickers | SOFR Rates |
  FHLB Tickers | FHLB Rates | Term LP`. (Shows static 9/30 vintage values; the live
  BBG sheets are 3/31.) This layout is the mental model for the importer.
- **`BBG_Curves_Values`** / `BBG_Curves_Link` — Curve_Dt 2026-03-31; RFR curve + FTP
  curve (SOFR+TLP) each with dated maturities and discount factors (`Df.Mid`); 634
  rows incl. a monthly forward strip. Values match `SOFR_Market_Data_20260331.xlsx`
  (1D 3.68, 1M 3.66085, …) exactly.
- **`Fixed_Rate_Loan`** (24mo bullet, 6%), **`Fixed_Rate_Loan_amort`** (60mo, CPR
  16.4%, level-pay), **`Floating_Rate_Loan`** (24mo bullet, margin +2.25% over 1M
  SOFR), **`Floating_Rate_Loan_Prime`** (360mo, margin −0.75% over Prime, CPR 10%).
  Monthly schedules begin 2026-03-31. Columns: months | Date | beg bal | loan coupon |
  loan pmt | loan interest | sched amort cf | maturity cf | cpr | smm | prepay cf.
  Floating coupons reset monthly off the forward SOFR strip; Prime loan month-1
  coupon 0.0671 (margin −0.0075 ⇒ Prime ≈ 0.0746; implied Prime−SOFR basis ≈ 3.2%,
  fit precisely against the floating-SOFR sheet's month-1 reset during the build).

### `C:\Users\deech\AI\Model-Sense\ALM-Model-Lab\research\data\Rate_History.xlsx`
Protected, owner-curated — **never edit.** 212 month-end rows Oct-2008…May-2026.
Trim to 2026-03 by FILTER in the converter (EndMonth ≤ 2026-03), not by editing it.

---

## Current lab architecture (touch-points with line refs)

- `src/math/rates/marketData.ts` — `TENOR_TO_YEARS` (currently 1D,1M,2M,3M,6M,1Y,2Y,3Y,5Y,10Y,15Y),
  `parseMarketSnapshot`, `RawSnapshot`. capQuotes `{expiryYears, strike|null, normalVol, isAtm}`
  (currently absolute strike — CHANGE to moneyness offset). swaptionATMQuotes
  `{expiryYears, tenorYears, normalVol}`. **Extend tenor map; redefine cap representation;
  add `fhlb_curve` + `tlp_nodes` to the snapshot type + parse.**
- `src/math/rates/bootstrap.ts` — handles arbitrary ascending tenors; CASH or tYears≤1 →
  simple comp, >1Y integer → annual par-swap brentq. 4Y/20Y/30Y already fine, no change.
- `src/math/rates/tlpCurve.ts` — `DEFAULT_TLP_NODES` (9/30 hardcoded, lines 37-50),
  `buildTLPCurve`, `parseTLPCurveCSV`. **Replace default with workbook-derived nodes
  (or source from snapshot).**
- `src/ui/state/AppContext.tsx` — loads `market_2025-09-30.json` (line ~176); default
  `calibrationDate`; `snapshot` state; `selectedCapKeys`/`selectedSwaptionKeys` +
  `capQuoteKey`/`swaptionQuoteKey`; filtered snapshot for calibration (~248-294).
  **Point default to `market_2026-03-31.json`, calibrationDate 2026-03-31, wire
  FHLB/TLP from snapshot.**
- `src/ui/tabs/ImportTab.tsx` — TLP CSV upload + calibration date + nPaths; hardcoded
  "9/30/2025" strings (lines 43, 75, 160, 167). **Add xlsx drop-zone; update copy.**
- `src/math/rates/rateHistory.ts` — `RATE_HISTORY_FILENAME = "rate_history_2008-10_2026-05.json"`
  (line ~230), `loadRateHistoryOnce`. **Rename to `..._2026-03.json`.**
- `research/convert_rate_history.py` — reads Rate_History.xlsx; SOFR_{k}M (SOFR_48Y typo
  for 48M), FHLB_{k}M, Fed Target, FEFF_1D, SOFR_1D; tenors
  [1,3,6,12,24,36,48,60,72,84,96,108,120,180,240,300,360]. **Add EndMonth ≤ 2026-03
  filter + new output filename.**
- `src/ui/components/TabBar.tsx` — `SECTIONS`, `TabId` union, instruments section.
  **Add Prime instrument tab id + label.**
- `src/ui/App.tsx` — `TAB_COMPONENTS` registry. **Register Prime tab.**
- `src/math/analytics/tractor.ts` + tests — uses `snapshot.curveQuotes` for
  `newMoneyYield`; covariance/as-of off `history.months.length-1`.

---

## Phase plan (task list IDs #1–#7)

**Phase 0 — converter + schema.** `research/convert_market_data.py` (mirror
`convert_rate_history.py`): read the 4 sheets, normalize spaced labels, compute Term LP,
emit `public/market_2026-03-31.json` with curve + fhlb_curve + tlp_nodes + cap (moneyness)
+ swaption blocks. Redefine `marketData.ts` schema (tenor map, cap moneyness, fhlb/tlp).

**Phase 1 — regenerate data.** Run converter → `market_2026-03-31.json` (+ dist copy).
Add EndMonth ≤ 2026-03 filter to `convert_rate_history.py` → `rate_history_2008-10_2026-03.json`
(210 months, + dist copy). Update `RATE_HISTORY_FILENAME`. Consistency-check the 2026-03
history SOFR-term row against the 3/31 snapshot.

**Phase 2 — consumers + defaults.** AppContext default path + calibrationDate + FHLB/TLP
from snapshot. SABR (`sabr.ts`, `SabrTab.tsx`) consumes moneyness smile correctly.
Verify HW/BGM calibration target (swaptions vs caps) and adapt only if needed.
RateHistoryTab / ReplicatingPortfolioTab as-of + month bounds → 2026-03.

**Phase 3 — Import drop-zone.** In-browser xlsx parse (the `xlsx` dep is already in
package.json) rebuilding the live snapshot client-side, SAME contract as the Python
converter, with a validation summary + clear errors.

**Phase 4 — Prime instrument.** Coupon = (SOFR-forward + Prime/SOFR basis) + loan margin;
basis configurable, defaulted to reconcile with the workbook. New tab + registry + tests.

**Phase 5 — FTP parity harness.** `research/` script checking `ftp.ts` against the four
loan sheets on the 3/31 curve; quantify + document convention diffs (BBG dated DFs vs
month/12 ACT/360).

**Phase 6 — re-pin + verify.** Re-pin all calibration-dependent test expectations to the
3/31 curve, rebuild dist, full suite green, typecheck, em-dash sweep, live preview.
Commit in phase-sized chunks.

---

## Gotchas / must-not-forget

1. **Cap surface is relative moneyness, not absolute strikes.** New schema: store ATM
   vol per expiry + smile as moneyness offset (decimal, 0 = ATM); SABR strike = forward
   + offset. Read the FULL 27-col header (the dump only showed 14 cols).
2. **Trim history by filter in the converter**, never edit `Rate_History.xlsx`.
3. **Both snapshots coexist.** Keep `market_2025-09-30.json` for `research/ch04_*`
   (book, deferred). Lab default → `market_2026-03-31.json`. Optional once the converter
   exists: regenerate `market_2025-09-30.json` from its TRUE workbook
   (`SOFR_Market_Data_20250930.xlsx`, short end 4.34/4.269/4.161/4.007) so it is correct
   for the eventual book rerun — only if the user confirms; it moves 9/30 numbers again.
4. **`dist/` copies** of both regenerated JSONs must be refreshed; remove stale
   `dist/market_2025-09-30.json` only if the default is fully repointed (keep if book
   scripts or a vintage selector still need it — they don't fetch dist, so safe to leave).
5. **Two parsers, one contract.** Browser xlsx parser and Python converter must produce
   identical JSON; share the field names/conventions.
6. **Prime basis** fit against the workbook's month-1 coupons (floating-SOFR sheet gives
   the SOFR reset; Prime sheet gives Prime; basis = difference). Expose as a parameter.

## Re-pin list (Phase 6) — every number below moves to the 3/31 curve
- `src/math/rates/__tests__/bgmPricing.test.ts` — smoke vols (currently 0.007163…),
  calibration params (a=0.5543…), sigma-curve reference. Regenerate via
  `research/bgm_pricing.py` + `research/bgm_calibrate.py`.
- `src/math/analytics/__tests__/tractor.test.ts` — max-yield structure (currently
  61.6% 3M + 38.4% 180M on the repaired 9/30 curve), IB credit, covariance window
  (history end moves to 2026-03). Regenerate via `research/rp_tractor_verify.py`
  (it reads `research/data/market_2025-09-30.json` — add a 3/31 copy or parameterize).
- `src/math/rates/__tests__/rateHistory.test.ts` — 212→210, "2026-05"→"2026-03",
  `indexOfMonth("2026-05")=211` → `("2026-03")=209`, `sofrTermRate(211,12)` and the
  May-2026 / FHLB-360 pins → 2026-03 values, `tenorsMonths` unchanged.
- Any **15Y** swaption references in `hwPricing`/`bgm` tests (15Y dropped from curve;
  still present in vol surfaces — verify).
- `simulators.test.ts` (1Y mean ≈ 3.66% may shift), `csvFormat.test.ts` (path pin
  0.036486 — check provenance), `seg` tests if curve-dependent.

## Verification commands
- kb-env python (UTF-8 console for β etc.):
  `$env:PYTHONIOENCODING='utf-8'; & "C:\Users\deech\AI\Model-Sense\ALM-Knowledge-Base\ALM-Modeling\.kb-env\Scripts\python.exe" <script>`
- Build/test: `npm run build` · `npx vitest run` · `npx tsc -b --noEmit` (cwd = ALM-Model-Lab)
- Preview: `mcp__Claude_Preview__preview_start name=alm-model-lab` then snapshot/eval.

## Session context this builds on
- Phase 3 tractor (replicating portfolio) shipped earlier this session: commits
  `12a28eb` (tab) + `0288806` (dist). Tests 131/131 green pre-rebaseline.
- 9/30 short-end repair committed `c405fed` (set to rate-history-workbook values
  4.24/4.133/3.970/3.830 — NOTE: differs from the TRUE 9/30 market workbook
  4.34/4.269/4.161/4.007; see gotcha 3). Ch4 rerun dependency tracked in
  `project_ch04_ftp_compute_contradiction` memory.
