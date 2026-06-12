# ALM Skills Improvement + Engine Build — Handoff v1

Date: 2026-06-07. Status: skill-improvement pass COMPLETE (all 24 skills + alm-engine restructured and verified clean); engine code build not started (incremental, deferred).

## Update 2026-06-07 (second session): skills pass finished
All 21 previously-unfinished skills were restructured to the lean template (gotcha-fix + progressive disclosure, heavy detail moved to per-skill `references/`) via a re-run of the restructure workflow with cost pre-approved. A follow-up em-dash sweep cleared all em-dashes from 14 files (foundation files included an en/em-dash-as-separator habit). Final verification passes on all 25 skill folders: Rate-Lab=0, section-symbol=0, banned-words=0, em-dash=0; every SKILL.md has frontmatter + Gotchas + Combine-with; no phantom cross-refs; all `references/` pointers resolve. The "REMAINING" section below is now historical. Only the `alm_engine` code build (phases at the bottom) and the Chen-citation decision remain open. NOTE: only `C:/Users/deech/.claude/skills/` was updated; the `.codex/` and `.gemini/` mirrors are stale.

## Decisions already made (do not relitigate)

- Canonical compute substrate: **Python-first** `alm_engine` package at `ALM-Model-Lab/python/alm_engine/` (does not exist yet, built incrementally). TypeScript lab is the parity-checked mirror (static site, no backend).
- Parameters are **data, not prose**: typed schema in engine code; default values in a versioned `assumptions.yaml` composed from per-skill fragments; the judgment about each parameter in the skill's `references/`. Resolution cascade: engine default -> house assumptions.yaml -> scenario/run file -> explicit call argument; AskUserQuestion if a required parameter has no defensible default.
- v1 engine scope: **static balance sheet with reinvestment** (NII and EVE). Principal recycles into the same instrument type at new-volume defaults; new vintages re-originated at market (note rate = new-client rate, age 0, origination profile reset). Full going-concern growth/mix is v2.
- EVE discounting is a parameter with three conventions: `risk-free-leg`, `full-coupon+spread`, `all-in-curve` (default).
- Skill structure follows Anthropic best practice: lean SKILL.md + `references/` (progressive disclosure), trigger-only "Use when..." descriptions, gotchas are the highest-signal section.

## DONE (on disk)

- All 24 skills: `Rate-Lab` -> `ALM-Model-Lab` path fix (verified 0 remaining).
- `alm-conventions/`: SKILL.md restructured; `references/recipes.md`, `references/validation-gate.md`; new Parameter-architecture section; alm-engine added to catalog; ShockedPath note corrected to seg.ts:64.
- `alm-engine/` (NEW keystone): `SKILL.md`, `references/contract.md` (full Python contract: Cashflow, RatePath + adapters, Instrument, PrepayModel injection seam, Book, NiiSettings, ReinvestmentPolicy, NewVolumeDefaults, NewVolumeRate, OriginationProfile, EveSettings, run_alm_engine, AlmResult), `references/parameters.md`, `config/assumptions.yaml`.
- `alm-market-data/`: SKILL.md + `references/schema.md` (gotchas: TS public/ vs Python research/data/ split; TENOR_TO_YEARS omits 7Y/20Y/30Y, toYears throws).
- `alm-yield-curve/`: SKILL.md + `references/bootstrap-detail.md` (removed phantom alm-rate-path; Python forward_swap_rate absent; brentq tolerance divergence; tau=1.0 epsilon).

## REMAINING: 20 skills need the gotcha-fix + lean-restructure pass

Full spec (template + style rules + per-skill findings) is in the workflow script:
`C:\Users\deech\.claude\projects\C--Users-deech-AI-Model-Sense\15844e67-c536-4a33-884b-981c396825ff\workflows\scripts\alm-skills-restructure-wf_5e7acbd1-4e7.js`

Cheapest path to finish: re-run that workflow but (a) restrict to the unfinished skills below, (b) tell agents cost is pre-approved and to complete all writes without halting on cost warnings. Or edit each SKILL.md directly.

### Style rules (these skills ship with the book)
No em-dash (use comma/colon/semicolon). Never the section symbol (write "Section"). Banned: delve, navigate, landscape, leverage (verb), robust, streamline, holistic, synergy, "it's worth noting", arguably, notably, crucially, paradigm shift, ecosystem, best-in-class, groundbreaking, innovative. Never write "Rate-Lab". Surgical: preserve correct content, MOVE heavy detail to references/ (don't delete). Don't invent code/classes/citations. Descriptions lead with "Use when...", triggers only.

### Lean SKILL.md template
Frontmatter (name, "Use when..." description + trigger phrases) -> Source line -> Overview -> When to use -> Key spec (heavy detail to references/) -> Parameters and defaults (table + "Overridable via the cascade in alm-engine", only where the skill owns params) -> Gotchas -> Calling pattern (one example) -> Combine with (exact skill ids; name alm-engine + alm-conventions).

### Per-skill findings to apply

**alm-tlp-overlay** (data-curve, only one left in that cluster): ADD a Gotchas section (it has none): flat extrapolation beyond node range returns endpoint spread silently; buildTLPCurve dedups keeping last spread silently; all-zero-spread CSV returns 0 silently; no Python TLP implementation.

**alm-hull-white**: keep RMSE <= 5 bp but WARN not throw; note 9/30/2025 surface is borderline ~5.4 bp for 1-factor. Gotchas: TS/Python paths not bit-identical (PCG32 vs PCG64), cross-validate on moments; Python project_hw_to_tenor is simple-comp all tenors while TS switches to par swap at tau>=1Y (~5 bp lower). Fix the section-symbol violations on line 24 (Section 10.1.6, Section 3, Section 4.5).
**alm-bgm-lmm**: Gotchas: savedTenors must be in grid-resolved order (drift is a forward-time running sum; reorder corrupts silently); beta rotation angle weakly identified from ATM-only, treat as nuisance.
**alm-sabr**: ADD Gotchas (none today): arg<=0 regulariser clamps silently far-OTM with large nu; sabrHeuristic averages alpha across expiries (collapses term structure); expiry=0 returns alpha not 0; heuristic is not calibration, no gate. Add "Vol cube roadmap": current code is single-smile point evaluator; a cube needs per-expiry-per-tenor params stored + interpolation + ~5 bp/expiry gate.

**alm-fixed-loan**: ADD Gotchas: originationOffsetMonths stored but never read in generateCashflows (silent wrong output if set).
**alm-floating-loan**: light; make rate-path source cross-ref actionable.
**alm-mortgage**: ADD Gotchas: one loan at a time (portfolio needs N instances aggregated, cross-ref alm-engine Book); noteRate and cprParams.wac must stay in sync; promote the stochastic 10Y-forward proxy caveat to a flagged gotcha. Note the PrepayModel injection seam (cross-ref alm-mortgage-prepayment, alm-engine).
**alm-nmd-noninterest-bearing**: ADD Gotchas: balanceDenominator vs balanceSize (computeBalMult reads balanceDenominator); MA warmup needs maPeriod <= historical length or constructor throws.
**alm-nmd-interest-bearing**: ADD Gotchas. Rewrite the dangling "Steph's audit memo Section 9" reference (drop or call it an internal audit note; no section symbol).
**alm-term-funding**: frontmatter description must state methodology-only conventions overlay (no TermFunding class; uses FixedLoan/FloatingLoan with side=liability).
**alm-revolving-facility**: PROMINENT gotcha that 'revolving-facility' is not in the InstrumentType union (won't compile until added); make alm-draw-rate-model cross-ref actionable.

**alm-mortgage-prepayment**: document composability honestly (four-factor CPR inlined in Mortgage; BehavioralOverlay in types.ts is dead code; planned seam is a user-supplied PrepayModel). Parameter provenance: Richard-Roll family, defaults illustrative not pool-calibrated (mark conservatively). New-volume note: even static balance needs default origination FICO/balance; new vintages start at market.
**alm-deposit-decay**: ADD high-value gotcha: runNMDOnPaths does NOT clamp rateIncentiveDecay at 0 but runNMDBetaOnPaths does; calling runNMDOnPaths with NMD-B params (logisticMidpoint=2.0) silently allows balance growth (use runNMDBetaOnPaths). Explain maxRateGrowth=-1.0 sign. Fix section-symbol on line 19 ("Section 9"). Provenance conservative.
**alm-deposit-beta**: ADD gotcha "lambda default vs calibrated": BETA_S_CURVE_DEFAULTS.lambda=1.0 is pedagogical, calibrated ~0.47. SOFTEN the "Chen (2025)" attribution to "Model Sense working estimate (Chen); external citation unconfirmed, confirm before publication" in description and body. (See open decision below.)
**alm-draw-rate-model**: PROMINENT callout that UtilizationSCurveModel/DrawPaydownModel/StochasticUtilizationModel are PLANNED, not shipped (import fails).

**alm-nii**: keep "pattern today"; becomes alm_engine analytics/nii.py; v1 semantics = static balance + reinvestment (cross-ref alm-engine NiiSettings/ReinvestmentPolicy). ShockedPath is real/importable.
**alm-seg**: FIX stale MC-vintage prose (vintages run on each MC path, not deterministic; seg.ts retired that). Gotcha: SHOCK_BP hardcoded at 10 bp, so regulatory +/-100/200 feasible via ShockedPath but not what SEG itself runs.
**alm-ftp**: ADD mitigation to NMD-B initial-beta gotcha (run computeFTP per scenario via ShockedPath, report beta-weighted average).
**alm-eve**: UPDATE discount section to the three conventions as a parameter (default all-in-curve). Gotcha: shockCurve(curve, shockBp)->ZeroCurve does not exist yet and is the prerequisite for EVE sensitivity (ShockedPath shifts rate path only). Cross-ref alm-engine EveSettings.
**alm-gap-analytics**: be honest: no repricingGap()/gap.py module; export uses isFloater/initialBeta heuristic, per-instrument not netted. Target = netted gap module in alm_engine.
**alm-replicating-portfolio**: gotcha that methodology C needs a constrained QP solver dependency not installed; start with A or B.

## Verification (run after edits, use Bash not the Grep tool inside .claude)
1. `grep -rl "Rate-Lab"` across all alm-*/ MUST be empty.
2. No em-dash (U+2014) and no section symbol anywhere in SKILL.md or references/.
3. No banned words.
4. Every SKILL.md: frontmatter name+description ("Use when"), a Gotchas/Common-bugs section, a Combine-with section.
5. No cross-reference to a non-existent skill folder (catch phantom refs).
6. Every "see references/..." pointer resolves to a real file.

## Open decision needed from Chih
- "Chen (2025) MMDA pricing study" in alm-deposit-beta: is it a real citable external source or an internal working note? Engine files currently tag it conservatively. Resolve before any public/book/plugin release.

## Engine build (later, incremental phases)
Phase 1 Python spine (promote research/ to alm_engine; add RatePath, forward_swap_rate; port instruments + behavioral with injection seam; port FTP + SEG). Phase 2 missing analytics (nii.py, eve.py + shockCurve, netted gap.py, Book, engine.py). Phase 3 parity gate (fixtures + pytest/vitest) + TS port. Phase 4 plugin manifest (.claude-plugin/plugin.json) + eval + usage logging. Contract is already fixed in `alm-engine/references/contract.md`.
