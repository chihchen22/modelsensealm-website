# Model Sense Website — Overview

*Loaded by Phil and Allen when website project context is needed. Not loaded for routine task routing.*

---

## Purpose

The Model Sense website is the public face of the brand — the destination for practitioners who encounter Chih's LinkedIn articles, book, or masterclass and want to know more. It is not a portfolio site or a brochure. It is a practitioner resource that reflects the Model Sense brand: intellectually honest, technically credible, no filler.

---

## Brand Constraints

These apply to all website content and design decisions:

- **Tone:** Senior practitioner writing to peers. Accessible without being promotional. No "cutting-edge solutions" language, no consultancy boilerplate.
- **Anti-AI quality gate:** All copy passes the checklist in `C:\Users\deech\AI\context\identity-style.md` before publication.
- **No em-dashes** in any copy.
- **Word bans:** delve, landscape (abstract), leverage (verb), robust, holistic, synergy, ecosystem (business contexts), best-in-class, groundbreaking, "it's worth noting", "arguably", "notably", "crucially".
- **Domain target:** modelsense.com (verify availability before any design work references the domain).

---

## Site Architecture (Working Draft)

| Page | Purpose |
|---|---|
| Home | Brand statement, current projects, primary CTA (book and/or masterclass) |
| About | Chih's background, career journey, Model Sense mission — practitioner story, not resume |
| Book | ALM Behavioral Modeling — description, table of contents, publisher status, pre-order/notification |
| Masterclass | Deposit Modeling for Bank ALM — curriculum overview, Marcus Evans link, registration |
| Writing | Curated selection of LinkedIn articles, organized by topic |
| Contact | Simple form or email link |

Architecture and scope are working drafts. They will be refined during requirements elicitation (Workflow 1 in `team-workflows.md`).

---

## Design Philosophy

Clean typography, restrained color palette, generous whitespace, fast load times. Nothing that looks like a generic consulting firm template.

References to draw from (not copy):
- Academic department sites with strong typography
- Practitioner finance sites that lead with substance (Risk.net, GARP, BIS research pages)
- Author sites that center the work, not the person

Anti-patterns to avoid:
- Hero sections with stock photography of handshakes or city skylines
- Testimonial carousels
- "Our proprietary methodology" language
- Animations that serve no informational purpose
- Dark mode by default (bank practitioners read in office environments)

---

## Technical Standards

- **Performance:** Pages load in under 2 seconds on a typical office connection.
- **Accessibility:** WCAG 2.1 AA minimum.
- **SEO basics:** Descriptive page titles, meta descriptions, clean URL structure, no broken links at launch.
- **Mobile:** Responsive at all standard breakpoints. Design for desktop first.
- **Static site preference:** Markdown-based content where possible so Chih can update copy without touching code.

---

## Current State

**Status:** Project folder established. Requirements not yet elicited. Domain availability not yet confirmed.

**First step:** Allen elicits requirements from Chih (tech stack, design references, priority pages, timeline). See Workflow 1 in `team-workflows.md`.

*Last updated: 2026-04-28.*
