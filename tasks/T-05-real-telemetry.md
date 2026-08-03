---
format_version: "1"
id: T-05
title: Real token telemetry from wire.jsonl
priority: P1
status: done
depends_on:
  - T-04
touches_paths:
  - plugins/kimi/scripts/lib/telemetry.mjs
---

## Goal

Telemetry currently estimates tokens as chars/4 (flagged `estimated: true`) because legacy stream-json carried no usage. Kimi Code 0.x persists per-session `~/.kimi-code/sessions/<dir>/<id>/agents/*/wire.jsonl` with request traces. Parse real usage when available.

## Scope

- Using the `kimi_session_id` from T-04, locate the session's wire.jsonl files (main + subagents) and extract real prompt/completion token counts if the format carries them.
- Keep the existing estimation path as an explicit fallback (`estimated: true` stays when real data is unavailable); real data sets `estimated: false`.
- Recompute cost from real tokens with the existing `KIMI_COST_PER_1M_*` env knobs.
- Add a checked-in fixture of a real 0.28.1 wire.jsonl (sanitized) for tests, replacing reliance on the legacy telemetry fixture where appropriate.

## Success Criteria

1. Real usage appears in meta.json telemetry when the session dir is readable.
2. Estimation fallback unchanged when it is not.
3. Tests: fixture-based real-usage parse + fallback path.
4. `npm test` passes.

## Anti-patterns

- Do not fail a completed crank because telemetry parsing failed — telemetry is best-effort.
- Do not hardcode a single wire.jsonl schema version without a tolerant parser.

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
