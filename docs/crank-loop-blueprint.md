# The Kimi Crank Loop — Reproducible Blueprint

> **Historical record (2026-08):** this is the v0.3.x-era blueprint. The
> current repo is 0.4.0 — see `CHANGELOG.md` and `README.md` for what
> changed. The body below is kept as-is for reference.

> **Goal:** A reproducible, organized process to develop kimi-plugin-cc to
> production-grade perfection for autonomous, Claude-Code-supervised Kimi
> cranking. This document is the blueprint other workstreams replicate.

## The Loop (one cycle)

```
┌─────────────────────────────────────────────────────────────┐
│  CYCLE N                                                     │
├─────────────────────────────────────────────────────────────┤
│  1. PREP    isolated git worktree off origin/master         │
│  2. SPEC    Task-Spec v2 with runnable bash evals           │
│  3. GATE    safe-to-delegate.sh → DELEGATE + --stamp        │
│  4. CRANK   v0.3.x broker → Kimi (background, --diff-review) │
│  5. MEASURE telemetry envelope + meta preservation + evals  │
│  6. DIAGNOSE workflow: RCA each defect + adversarial review  │
│  7. DESIGN  judge-panel the fixes → v0.3.(x+1) plan          │
│  8. APPLY   fix plugin repo + tests + 9/9 guardrail          │
│  9. SHIP    PR + tag + marketplace refresh                   │
│  10. SCORE  re-crank fresh task, measure delta vs target     │
│  → repeat until score ≥ 9.0                                  │
└─────────────────────────────────────────────────────────────┘
```

## Cycle journey

The plugin reached 10/10 across three measured cycles. Each cycle cranked a
real task, measured the result against the rubric below, and fed the defects
into the next version.

### Cycle 0 — baseline (v0.3.2)

**Task:** fix 34 broken markdown links in a host repo.

**Result:** Kimi did the work correctly — 34 → 0 broken links, all evals pass,
sound decisions (renamed-dir links repointed, genuinely-dead links converted to
plain text, zero fabricated paths, zero scope creep).

**Confirmed in production:** Meta preservation — 11/11 initial fields survived
the completion write.

**Defects surfaced (→ v0.3.3):**
- DEFECT 1 — Telemetry envelope all-zeros. `broker telemetry` returned
  `{prompt_tokens:0, ...}` despite real work; usage was not parsed from the
  kimi CLI stream-json.
- DEFECT 2 — Worktree isolation leak. A crank dispatched from a worktree cwd
  landed Kimi's edits in the MAIN checkout, because repoPath resolution followed
  the worktree's `.git` file to the main repo root.

### Cycle 1 — substrate (v0.3.3)

Fixed both cycle-0 defects: real telemetry parsing from the kimi stream-json,
and worktree-safe cwd isolation so edits land in the dispatching tree. Added
durable auto-commit and documented broker exit codes. Scored ~9.4/10. The one
remaining gap: a hung or looping crank could block indefinitely.

### Cycle 2 — reliability (v0.3.4)

Closed the last gap. Added a hard wall-clock timeout (`KIMI_DISPATCH_TIMEOUT_MS`,
30m) and an idle-output watchdog (`KIMI_IDLE_TIMEOUT_MS`, 5m) on both the
foreground and detached-background paths — SIGTERM then SIGKILL after 2s. A
timeout is terminal (never retried), surfaces as broker exit code 6
(`status: failed`, `reason: timeout`), and leaves work uncommitted for
inspection or resume. `waitForSessions` now actively cancels stuck sessions so a
single hung task can't pin a `crank-batch` wave. Hardened the timeout path
itself against a temporal-dead-zone crash on synchronous spawn errors (missing
binary) and a leaked SIGKILL timer. Scored 10/10.

## Scoring rubric (target ≥ 9.0)

| Dimension | Weight | v0.3.2 | v0.3.3 | v0.3.4 |
|-----------|--------|--------|--------|--------|
| Work correctness (Kimi does the task right) | 25% | 10/10 | 10/10 | 10/10 |
| Meta preservation (no zombie sessions) | 15% | 10/10 | 10/10 | 10/10 |
| Telemetry capture (measurable runs) | 15% | 0/10 | 10/10 | 10/10 |
| Isolation (worktree-safe) | 20% | 0/10 | 10/10 | 10/10 |
| Scope discipline (no creep) | 15% | 10/10 | 10/10 | 10/10 |
| Auto-commit (work lands committed) | 10% | n/a | 10/10 | 10/10 |
| Reliability (no crank can hang) | — | — | partial | 10/10 |
| **Weighted score** | | **~5.9** | **~9.4** | **10/10** |

## Reproducible commands (per cycle)

```bash
# 1. PREP — isolated worktree
bash scripts/git-worktree.sh <session description>

# 3. GATE
bash .claude/skills/task-spec/scripts/safe-to-delegate.sh --stamp tasks/T-*.md

# 4. CRANK (from inside the worktree)
node <plugin>/scripts/broker.mjs dispatch \
  --task-path tasks/T-*.md --touches-paths "..." --diff-review --tag <tag> --background

# 5. MEASURE
node <broker> status --session-id <id>      # 11/11 fields present?
node <broker> telemetry --session-id <id>   # non-zero envelope?
bash .claude/skills/task-spec/scripts/safe-to-delegate.sh tasks/T-*.md  # evals pass?
```

## What "done" looks like

Each release closes its cycle's defects, lands tests that lock them, and passes
the 9/9 release guardrail (`npm run release:dry`) before shipping. The substrate
is trustworthy when no crank can leak, hang, edit the wrong tree, lose its work,
or go unmeasured — reached at v0.3.4.
