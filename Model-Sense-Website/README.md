# Model-Sense-Website — Owner Reference

*The modelsense.com project.*

---

## What this folder is

Home for the Model Sense website — design files, copy, build artifacts, and Allen's agent definition. Phil orchestrates the website work from here when in website mode.

## Structure

```
Model-Sense-Website/
├── CLAUDE.md                ← Phil's website-mode dispatcher
├── README.md                ← this file (for me)
├── website-overview.md      ← project context (purpose, brand, architecture)
├── team-workflows.md        ← collaboration recipes for the website team
├── agents/
│   └── web-designer.md      ← Allen
├── requirements/            ← elicited requirements, wireframes pending approval
├── content/                 ← approved page copy
├── assets/                  ← images, logos, icons
└── build/                   ← site files (HTML/CSS/JS or static site generator output)
```

The subfolders (`requirements/`, `content/`, `assets/`, `build/`) get created when the project moves into each phase. Right now most of them are empty.

## Current state

- Folder established
- Domain (modelsense.com) **not yet secured**
- Requirements **not yet elicited** — Allen needs to drive this with me
- No design or build work has started

The first real activity is requirements elicitation (Workflow 1 in `team-workflows.md`).

## How I use it day-to-day

Until the project starts in earnest, I rarely open this folder. When ready to start:
1. Tell Phil "let's start the website."
2. Phil queues Allen for requirements elicitation.
3. Allen drives a meeting with me; I answer questions about tech stack, design references, priority pages, timeline.
4. Allen documents requirements; I approve.
5. Then design and build phases proceed.

## Notes for future me

- Website agent files (just Allen for now) live in this folder, not in `Model-Sense/agents/`. The pattern: cross-cutting agents are at top level; project-specific agents live in their project.
- Allen requests prose from Larry for any pages that need polished writing (About, Book intro, Masterclass intro).
- Allen requests factual content from Magic (book TOC, article summaries) — never fabricates.
- The site has to launch with the anti-AI quality gate already passed; no exceptions.

*Last updated: 2026-04-28.*
