---
format_version: "1"
id: T-20
title: Per-mode effort defaults
priority: P2
status: done
depends_on: []
touches_paths:
  - plugins/kimi/scripts/lib/commands.mjs
---

## Goal

`--effort` is all-or-nothing: read-only reviews burn the same thinking budget as cranks unless the user remembers the flag. Add sensible per-mode defaults.

## Scope

- Default map: `review`/`challenge`/`explore` → `low`; `crank`/`plan` → `high`. Explicit `--effort` always wins; `--effort-default off` (or env `KIMI_EFFORT_DEFAULTS=off`) restores the no-default behavior.
- meta gains `effort_source: explicit|mode-default|none` alongside `effort`.
- Document in README + `kimi:crank.md`.

## Success Criteria

1. Dispatch with no flag records the mode default and its source; explicit flag records `explicit`.
2. Tests: default map, override, off-switch.
3. `npm test` passes.

## Anti-patterns

- Never override an explicit `--effort`.
- Do not change behavior for custom/unknown modes (no default).

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
