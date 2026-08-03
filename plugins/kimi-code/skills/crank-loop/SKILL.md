---
name: crank-loop
description: The crank-loop methodology — a measured, iterative loop for delegating implementation tasks to an agent with specs, gates, telemetry, and scoring. Use when running or improving task-spec-driven delegation workflows.
---

# The Crank Loop

A reproducible process for autonomous, supervised agent cranking. One cycle:

1. **PREP** — isolate work (git worktree or clean branch off origin).
2. **SPEC** — write a task spec (`tasks/T-*.md`): goal, success criteria, anti-patterns, `touches_paths`, and a runnable `# Exit Check` bash block.
3. **GATE** — only delegate specs whose evals are runnable and side-effect-free.
4. **CRANK** — execute the spec (e.g. `/crank:run`), preferring background execution for long tasks.
5. **MEASURE** — capture duration, tokens/cost, tool-call mix, and eval pass/fail for every run.
6. **DIAGNOSE** — root-cause every defect; adversarially review the result (`/crank:challenge`).
7. **DESIGN** — decide the fixes; plan them (`/crank:plan`).
8. **APPLY** — implement fixes with tests.
9. **SHIP** — commit, tag, release.
10. **SCORE** — re-crank a fresh task and score against the rubric; repeat until ≥ 9/10.

## Scoring rubric

| Dimension | Weight |
|---|---|
| Work correctness (task done right) | 25% |
| Isolation (edits land in the right tree) | 20% |
| State preservation (no lost/zombie sessions) | 15% |
| Telemetry (every run measurable) | 15% |
| Scope discipline (no creep) | 15% |
| Auto-commit (work lands committed) | 10% |

## Hard-won rules

- A hung crank must die: always run with a wall-clock cap AND an idle-output watchdog; a timeout is terminal, never retried.
- Sessions must be resumable natively (`kimi --session <id>`) — prompt-text "continue" hacks lose context.
- Tokens come from the session's real usage records, never from char-count estimates, when available.
- Read-only roles are a behavior contract (review/explore never write); enforce in the prompt and verify in review.
