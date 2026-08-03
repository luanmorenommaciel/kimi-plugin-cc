---
description: Generate a structured implementation plan from a task description — read-only
---

Produce a step-by-step implementation plan for: $ARGUMENTS

Explore the codebase first (read-only), then return:

1. **Key files** — exact paths that will be created or modified, with why.
2. **Steps** — ordered, concrete, verifiable implementation steps.
3. **Architectural decisions** — the choices that matter, with trade-offs.
4. **Risks** — what could break, and how each step is verified.
5. **Scope estimate** — small / medium / large, with reasoning.

Do not write or edit any files. The plan is the deliverable; execution comes later.
