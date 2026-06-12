# Agent Dashboard — Build Brief
*Routed from Phil → Allen. This brief is approved; proceed directly to build.*

---

## What to Build

A single self-contained HTML file: the internal Model Sense agent team dashboard. One page, no backend, no CMS. Delivered as `agent-dashboard.html` in `Model-Sense-Website/build/`.

This is **not** the public modelsense.com website. It is an internal landing page Chih uses to orient himself to the team — who each agent is, what they do, and when to call them.

---

## Design Constraints

**Match the design system exactly.** Reference files:

- `assets/design-system/design-system.html` — canonical token reference (colors, type, spacing)
- `assets/design-system/brand-book-a4.pdf` — brand identity and visual language
- `assets/Model-Sense.html` — existing landing page; use this as the visual register for the overall page feel

**Token summary (from design-system.html):**

| Token | Value |
|---|---|
| Background | `--cloud-dancer: #F6F6F4` |
| Text | `--obsidian: #121312` |
| Muted accent | `--sand: #D1CBC1` |
| Node teal | `--node-teal: #2B7A78` |
| Node green | `--node-green: #3D7A42` |
| Node orange | `--node-orange: #C86A3A` |
| Node purple | `--node-purple: #7050A0` |
| Serif | `Playfair Display` (Google Fonts) |
| Sans | `Sora` (Google Fonts) |

You may use Tailwind CDN for layout utility (as Model-Sense.html does) but CSS custom properties from the design system take precedence for color and type.

---

## Header

- Logo: `assets/Logo New.png` — top-left, standard nav treatment
- Page title: "The Team" (Playfair Display, sentence case)
- Subtitle: one line, Sora light — something like "Model Sense operates as a coordinated team. Chih talks to Phil; Phil delegates."
- No nav links needed (internal page)

---

## Agent Cards

One card per agent. 12 agents total. Card contents:

| Field | Source |
|---|---|
| Portrait photo | `assets/agents/01-phil.png` … `12-john.png` |
| Agent name | First name only (e.g. "Phil") |
| Real name | In parentheses, smaller weight (e.g. "Phil Jackson") |
| Role tagline | One line, Sora, muted — see roster below |
| "Call me for" | 2–3 bullet points, tight, concrete |
| Group badge | Small label chip indicating team group |

**Card design notes:**
- Portrait at top, cropped to circle or soft-rounded square — your call, be consistent
- Clean card with subtle border or shadow; cloud-dancer card on a slightly darker or off-white section background
- Hover state: slight lift or border accent using a node color matching the agent's group
- No decorative icons, no stock imagery, no testimonial-style layout

---

## Agent Roster (card copy)

### Phil — Phil Jackson
**Tagline:** Orchestrator. Sees the whole floor.
**Group:** Orchestrator
**Call me for:** Any task. I decide whether to handle it directly or route it to the right agent. Start every session here.

### Magic — Magic Johnson
**Tagline:** Librarian. The single interface to the knowledge base.
**Group:** Knowledge Base
**Call me for:** Technical context, formulas, regulatory references, Chih's published articles, synthesis across sources. Every other agent calls me; no one reads the KB directly.

### Michael — Michael Jordan
**Tagline:** ALM Expert. Subject matter authority.
**Group:** Modeling Team
**Call me for:** Model design judgment, methodology questions, framework selection, ALCO-level interpretation. I spec the build; I don't build it.

### Kobe — Kobe Bryant
**Tagline:** Quant Modeler. Obsessive precision.
**Group:** Modeling Team
**Call me for:** Excel workbook builds, Python scripts, calibration tooling, dashboard prototypes. I inherit a spec from Michael and build the minimum that meets it.

### Steph — Steph Curry
**Tagline:** Data Scientist. Finds the non-obvious result.
**Group:** Modeling Team
**Call me for:** Stochastic simulation, calibration, scenario design, statistical analysis, exploratory data work.

### Dennis — Dennis Rodman
**Tagline:** Validator. Does the dirty work.
**Group:** Modeling Team
**Call me for:** Model validation, backtesting, sensitivity analysis, edge case probing. Nothing leaves the modeling team without my sign-off.

### Tim — Tim Duncan
**Tagline:** Documentation. The Big Fundamental.
**Group:** Modeling Team
**Call me for:** Methodology notes, assumption registries, audit trail, change logs. Every model the team ships has clean documentation because I wrote it.

### Larry — Larry Bird
**Tagline:** Ghostwriter. Writes in Chih's voice.
**Group:** Book Team
**Call me for:** Book outlines, chapter drafts, prose revisions. I consult Magic and Michael along the way; output goes to Jerry.

### Jerry — Jerry West
**Tagline:** Publisher/Editor. Wiley acquisitions perspective.
**Group:** Book Team
**Call me for:** Chapter structure review, editorial memos, market positioning, book coherence. I don't rewrite prose and I don't check formulas — those are Larry's and Michael's jobs.

### Allen — Allen Iverson
**Tagline:** Web Designer. Style in service of the work.
**Group:** Web Team
**Call me for:** Website requirements elicitation, wireframes, design mockups, site build, copy structure. I elicit requirements before any design work begins.

### David — David Robinson
**Tagline:** Legal & Business Architect. Naval Academy precision.
**Group:** Business Operations
**Call me for:** Contract intake and summary, business filing tracking, EWB compliance flags, deadline management. I flag issues for an attorney when needed.

### John — John Stockton
**Tagline:** Accountant. Fundamentals, precision, no flash.
**Group:** Business Operations
**Call me for:** Expense and revenue logging, monthly reconciliation, P&L summaries, Schedule C readiness. I keep the books so financial decisions are answerable in one query.

---

## Layout

- Phil gets a featured position: full-width or half-width hero card at the top, visually distinct from the agent grid below. He is the entry point.
- Remaining 11 agents: 3-column grid (desktop), 2-column (tablet), 1-column (mobile). Group them by team: Knowledge Base, Modeling Team (5 agents), Book Team, Web Team, Business Operations.
- Group headers: small all-caps label in `--sand`, matching the design system's section-label pattern.

---

## Technical Requirements

- Single self-contained `.html` file. All CSS inline or in `<style>`. Google Fonts via CDN link. Tailwind CDN optional.
- Portrait images referenced as relative paths from `build/` → `../assets/agents/01-phil.png`
- Logo referenced as `../assets/Logo New.png`
- No JavaScript required unless used for a subtle scroll reveal (keep it minimal)
- Loads fast. No external dependencies beyond Google Fonts and optional Tailwind CDN.

---

## Output

`Model-Sense-Website/build/agent-dashboard.html`

*Brief version 1 — 2026-05-03.*
