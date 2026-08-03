---
description: Execute a tasks/T-*.md spec — implement, verify with its Exit Check, report
---

Execute the task spec at: $ARGUMENTS

1. Read the spec file (frontmatter: goal, success criteria, anti-patterns, touches_paths, Exit Check).
2. Implement the smallest change that satisfies the goal and every success criterion — nothing more. Honor the anti-patterns and stay inside touches_paths.
3. Run the spec's ```bash # Exit Check``` block. If it fails, fix and re-run until it passes or you can explain precisely why it cannot pass.
4. Report: files changed, Exit Check result, and any deviations from the spec.

Discipline: plan all edits before writing when the task spans multiple files; verify once at the end; do not refactor unrelated code; do not git-commit unless the spec says to.
