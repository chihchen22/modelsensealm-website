# Model Sense Website — Team Workflows

*Loaded by Phil when starting a multi-agent task on the website. Authoritative collaboration recipes for the website project.*

---

## Workflow 1 — Requirements Elicitation

Trigger: Project kickoff. Must complete before any design or build work.

1. **Phil** confirms with Chih that requirements work is starting. Routes to Allen.
2. **Allen** drafts a requirements questionnaire covering: tech stack, domain status, design references, priority pages, contact mechanism, analytics preference, timeline, constraints.
3. **Allen → Chih directly** (Phil facilitates the meeting) — Allen drives the questions, captures answers in real time.
4. **Allen** documents answers in `requirements/website-requirements_v1.md`.
5. **Allen** routes the document to `Model-Sense/owner-inbox/website/` for Chih's formal sign-off.
6. **Chih** approves or returns revisions. Approved version is locked; subsequent design work references it.

---

## Workflow 2 — Page Wireframe and Outline

Trigger: Approved requirements. Chih queues a specific page for design.

1. **Allen** reads `website-overview.md`, the approved requirements doc, and any prior page wireframes for design system consistency.
2. **Allen → Magic (if applicable):** technical content the page references — book TOC, article summaries, framework descriptions. Allen does not fabricate factual content.
3. **Allen** drafts the wireframe (visual or content outline) with copy structure indicated for each section.
4. **Allen** routes to `Model-Sense/owner-inbox/website/` as `website-wireframe-[page]_v1.md`.
5. **Chih** approves or revises. Approved wireframe → triggers Workflow 3 (copy) and/or Workflow 4 (build).

---

## Workflow 3 — Page Copy

Trigger: Approved wireframe. Page needs polished prose.

1. **Allen** specs the copy needs: section by section, target word count, tone, key claims, CTAs.
2. **Allen → Larry:** copy request with the spec. Larry drafts in Chih's voice, applies the anti-AI quality gate.
3. **Allen → Magic (as needed):** any factual content Larry needs (book TOC details, article summaries, dates, etc.) routes through Magic.
4. **Larry** delivers copy → Allen integrates into the page structure.
5. **Allen** runs anti-AI gate one more time on the full integrated page.
6. **Allen** routes to `Model-Sense/owner-inbox/website/` as `website-copy-[page]_v1.md` for Chih's approval.
7. After approval, copy moves to `Model-Sense-Website/content/[page-name].md` (or equivalent for the chosen tech stack).

---

## Workflow 4 — Page Build

Trigger: Approved wireframe + approved copy. Page is ready to build.

1. **Allen** implements the page in the chosen tech stack (static site / Webflow / custom HTML+CSS).
2. **Allen** runs technical checks: load time under 2 seconds, accessibility (WCAG 2.1 AA), responsive breakpoints, no broken links.
3. **Allen** delivers a preview link or local build to `Model-Sense/owner-inbox/website/` with note: `[page] preview ready for review`.
4. **Chih** reviews and approves, or returns with revisions.
5. After approval, the page is committed to `Model-Sense-Website/build/`.

---

## Workflow 5 — Reference Content (Factual)

Trigger: Any page needs technical or factual content (book details, article summaries, masterclass curriculum).

1. **Allen → Magic:** request specific factual content with format and length spec. Allen never fabricates.
2. **Magic** returns synthesized content from the KB and Chih's published work.
3. **Allen** integrates into the page; if the content needs polishing into prose, routes to Larry per Workflow 3.
4. Allen verifies factual accuracy with Chih if the content is novel (e.g., new article descriptions, updated curriculum).

---

## Inbox Protocol (Website-Specific)

**`team-inbox/`** (at Model-Sense root) — Chih drops website-related material here. Phil routes website-tagged items to `Model-Sense-Website/` for Allen to handle.

**`owner-inbox/website/`** — Deliverables for Chih's review (requirements doc, wireframes, copy drafts, preview links). Subfolder created on demand when concurrent output across projects warrants. Date subfolders only when daily volume warrants.

Standard delivery payload:
- The artifact (requirements doc, wireframe, copy draft, preview link)
- A short note stating what review is needed and what the next step is

**Questions vs. deliverables.** Owner-inbox is for deliverables only. When Allen needs a decision from Chih to proceed — tech stack, design direction, page priorities, copy choices — Phil uses AskUserQuestion to surface the question. Allen flags questions to Phil; Phil bundles and asks. No standalone question files in owner-inbox.

---

## Common Failure Modes (Watch For)

- **Allen designing before requirements approval.** Symptom: design work that misses Chih's actual constraints. Phil enforces Workflow 1 completion first.
- **Allen fabricating book or article descriptions.** Symptom: factual claims that don't match Chih's actual work. Magic is the source of truth; Allen requests through Magic.
- **Copy that doesn't pass the anti-AI gate.** Symptom: word ban violations, em-dashes, "robust/leverage/holistic". Allen runs the gate; Larry runs it again on prose drafts.
- **Pages launched without accessibility checks.** Symptom: WCAG failures, contrast issues, keyboard nav broken. Allen runs technical checks before owner-inbox delivery.

*Last updated: 2026-04-28.*
