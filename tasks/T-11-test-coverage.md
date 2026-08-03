---
format_version: "1"
id: T-11
title: Test coverage — spawn builder, telemetry, orchestrate, codex-bridge
priority: P2
status: done
depends_on:
  - T-01
  - T-02
  - T-05
  - T-09
touches_paths:
  - tests
---

## Goal

Close the test gaps left by the migration and the pre-existing untested modules, converting source-text regex assertions into behavior tests where feasible.

## Scope

- Behavior tests for the unified spawn-arg builder (T-01): foreground/background parity, model flag, no legacy flags.
- Role prompt composition tests (T-02) if not already added there.
- Telemetry: real wire.jsonl fixture parse + estimation fallback (T-05).
- `orchestrate.mjs`: topoSort ordering, wave packing with touches_paths conflicts, rollupBatch aggregation — pure-function tests.
- `codex-bridge.mjs`: verdict parsing (all VERDICTS values, missing binary SKIP path, timeout) with a stubbed codex binary.
- `job-control` background wall-clock cap regression test (T-09) with the fake-kimi shim pattern already used in timeout tests.

## Success Criteria

1. New tests exercise behavior (spawned shims/fixtures), not source-text regexes.
2. Coverage additions are all green alongside the existing 74 tests.
3. `npm test` passes with no skipped tests.

## Anti-patterns

- Do not rewrite existing passing tests "for style".
- No network access in any test.

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
