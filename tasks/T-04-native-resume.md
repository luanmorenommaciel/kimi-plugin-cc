---
format_version: "1"
id: T-04
title: Native session resume — real Kimi session IDs
priority: P1
status: done
depends_on:
  - T-01
touches_paths:
  - plugins/kimi/scripts/lib/kimi.mjs
  - plugins/kimi/scripts/lib/job-control.mjs
  - plugins/kimi/scripts/lib/state.mjs
  - plugins/kimi/scripts/lib/commands.mjs
---

## Goal

`--resume` currently fakes continuity by prepending "Continue from previous session <broker-uuid>" to the prompt, and the README-advertised `kimi resume <session-id>` handoff never works because the broker never learns the real Kimi session ID. Use 0.x native resume.

## Scope

- Capture the real Kimi session ID: prefer parsing it from the stream-json output if 0.28.1 emits it; otherwise resolve it after completion from `~/.kimi-code/sessions/<workDirKey>/` (most recent session matching cwd). Verify empirically with one minimal real dispatch and record what the stream actually contains.
- Store it in meta.json as `kimi_session_id` alongside the broker session id.
- `--resume`: invoke `kimi --session <kimi_session_id> -p <followup> --output-format stream-json` instead of prompt-text fakery (verify the flag combination is accepted; fall back to the old behavior with a warning only if native resume is impossible headlessly).
- `/kimi:result` and `/kimi:status` print the real handoff command (`kimi --session <id>`), replacing the stale `kimi resume` wording.

## Success Criteria

1. meta.json contains `kimi_session_id` for new sessions.
2. A resumed crank continues the actual Kimi session (or the fallback is explicit and tested).
3. Tests cover ID capture (fixture stream-json / session-dir scan) and the resume arg shape.
4. `npm test` passes.

## Anti-patterns

- Do not break resume for sessions created before this change (missing kimi_session_id → clear error, not a crash).
- One real probe dispatch maximum; everything else mocked/fixtured.

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
