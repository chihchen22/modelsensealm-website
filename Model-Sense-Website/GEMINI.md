# Model Sense Website - Sub-Orchestrator

*Project-level dispatcher. Phil orchestrates website tasks here.*

*Always load: `C:\Users\deech\AI\context\identity-core.md`*

---

## Read on Demand

- **`website-overview.md`** - purpose, brand constraints, site architecture, technical standards. Load when project context is needed.
- **`team-workflows.md`** - collaboration recipes (requirements, wireframe, copy, build, reference content). Load when starting a multi-agent task.

---

## Project Agent Roster

| Agent | Role | File |
|---|---|---|
| Allen | Web Designer - design, copy structure, build | `agents/web-designer.md` |
| Larry | Ghostwriter - polished prose for pages that need it | `../ALM-Modeling-Book/agents/ghostwriter.md` |
| Magic | Librarian - factual content (book, articles, frameworks) | `../ALM-Knowledge-Base/CLAUDE.md` |

---

## Folder Structure

```
Model-Sense-Website/
├── CLAUDE.md                  ← this file
├── website-overview.md        ← project context (lazy-load)
├── team-workflows.md          ← collaboration recipes (lazy-load)
├── agents/
│   └── web-designer.md        ← Allen
├── requirements/              ← elicited requirements, wireframes pending approval
├── content/                   ← approved copy per page
├── assets/                    ← images, logos, icons
└── build/                     ← site files (HTML/CSS/JS or static site generator output)
```

Subfolders are created when the project moves into each phase.

---

## Project Standing Rules

- **Requirements before design.** No mockups or code until `requirements/website-requirements_v1.md` is approved.
- **Wireframe before build.** Each page goes through wireframe approval before implementation.
- **Anti-AI gate** on all copy before delivery.
- **Magic for facts.** Allen never fabricates book TOC, article descriptions, or framework details - those come through Magic.
- **Larry for polished prose.** About page, book intro, masterclass intro and any other prose-heavy section routes through Larry.

---

## Inbox Protocol (Website-Specific)

**Inbound:** Chih drops website material in `Model-Sense/team-inbox/`. Phil routes website-tagged items into this project.

**Outbound (deliverables):** Website team output for Chih's review goes to `Model-Sense/owner-inbox/website/`. Flat by default; date subfolders only when volume warrants. Standard delivery payload: artifact + short note stating what review is needed and the next step.

**Questions for Chih → AskUserQuestion, not owner-inbox.** Decisions the team needs from Chih to proceed (tech stack, design choices, page priorities, copy direction) go through the AskUserQuestion tool via Phil. Allen flags questions back to Phil; Phil bundles and asks. Standalone "question" files do not belong in `owner-inbox/website/`.

---

## File Naming

- Requirements: `website-requirements_v[N].md`
- Wireframes: `website-wireframe-[page]_v[N].md`
- Copy drafts: `website-copy-[page]_v[N].md`
- Approved copy: `[page-name].md` (in `content/`)

Increment versions; never overwrite.

*Last updated: 2026-04-28.*
