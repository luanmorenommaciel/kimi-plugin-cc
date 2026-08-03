---
format_version: "1"
id: T-18
title: --max-cost live budget watchdog
priority: P2
status: done
depends_on: []
touches_paths:
  - plugins/kimi/scripts/lib/kimi.mjs
  - plugins/kimi/scripts/lib/job-control.mjs
  - plugins/kimi/scripts/lib/commands.mjs
---

## Goal

A runaway crank can burn quota until the wall-clock cap fires. Add `--max-cost <usd>`: a live watchdog that kills the crank when the estimated cost of the run so far exceeds the budget.

## Scope

- Live estimate from the growing `output.jsonl` transcript (chars/4 × the existing `KIMI_COST_PER_1M_*` rates) — the real wire.jsonl session id is only known post-run, so the live cap is estimate-based and documented as such; post-run telemetry reconciles with real usage.
- Foreground: checked alongside the idle watchdog in `runOnce`. Background: same check in the job-control watchdog. On breach: SIGTERM→SIGKILL, meta `reason: 'max-cost'`, broker exit code 6 (same terminal-timeout contract).
- `--max-cost` flag on dispatch + `KIMI_MAX_COST_USD` env default; usage + README docs.

## Success Criteria

1. A shim emitting endless output is killed once the estimate crosses a tiny cap, with reason `max-cost`.
2. Post-run meta still gets real telemetry when available.
3. Tests: foreground kill path + estimate math.
4. `npm test` passes.

## Anti-patterns

- Do not block the dispatch loop on cost computation (cheap incremental check).
- No cost cap when the flag/env is unset — behavior unchanged by default.

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
