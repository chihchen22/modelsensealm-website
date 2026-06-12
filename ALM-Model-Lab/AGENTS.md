# ALM Model Lab Instructions

This is the Codex adapter for ALM Model Lab, the internal Model Sense rate-model dashboard and research sandbox.

## Required First Reads

For any ALM Model Lab task, read in order:

1. `C:\Users\deech\AI\context\identity-core.md`
2. `C:\Users\deech\AI\context\identity-quant.md`
3. `C:\Users\deech\AI\Model-Sense\AGENTS.md`
4. `package.json`
5. Relevant source files under `src\` or `research\` for the task

Read `identity-style.md` only when changing public-facing copy, documentation, or explanatory prose.

## Project Shape

ALM Model Lab is a Vite, React, TypeScript application with Python research scripts. It includes HW1F, BGM/LMM, SABR, curve construction, instrument analytics, SEG/EBP, FTP, gap analytics, and related ALM demonstrations.

Important folders:

- `src\` for application code.
- `src\ui\` for React UI.
- `src\workers\` for simulation and calibration workers.
- `src\storage\` for import, export, and run bundle handling.
- `research\` for Python reference and validation scripts.
- `public\` for static assets and market data.
- `runs\` for generated run outputs.

Do not edit `node_modules`, `dist`, `runs`, or generated build artifacts unless Chih explicitly asks.

## Development Commands

Use the narrowest meaningful check:

- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run dev` for local app checks when a UI change needs browser verification

If dependencies are missing or a command fails due network or sandbox restrictions, report the blocker or request the required permission.

## Engineering Rules

Match the existing React and TypeScript style. Keep changes small and tied to the requested model or UI behavior.

For modeling changes, preserve units, sign conventions, day-count assumptions, path dimensions, and calibration tolerances. If a relevant `alm-*` skill has not yet been ported to Codex, consult the Claude skill in `C:\Users\deech\.claude\skills\` as a reference before changing model logic.

For UI changes, follow the existing dashboard design and verify with a browser when practical. Do not turn internal tools into marketing pages.

Protect workbooks and source data. Do not overwrite `.xlsx` or `.xlsm` files. Version new outputs when needed.
