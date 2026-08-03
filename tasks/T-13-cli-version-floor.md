---
format_version: "1"
id: T-13
title: CLI version floor for native-resume features
priority: P0
status: done
depends_on: []
touches_paths:
  - plugins/kimi/scripts/lib/kimi-cli.mjs
  - plugins/kimi/scripts/lib/commands.mjs
---

## Goal

`detectKimiCli` accepts any 0.x, but native resume (`session.resume_hint` in stream-json) only exists on newer 0.x releases. On an old 0.x the broker silently loses resume/telemetry instead of telling the user to upgrade.

## Scope

- Add `MIN_KIMI_CODE_VERSION = '0.28.0'` and a semver-compare helper.
- Detection result gains `belowFloor: true` when version < floor. Dispatch still proceeds (features degrade: no resume id captured → the T-04 clear-error path), but `broker doctor` reports a loud `upgrade recommended` warning with the floor and current version.
- `assertSupportedCli` message stays hard-fail only for legacy/missing.

## Success Criteria

1. `doctor` output includes the floor warning for 0.x < 0.28.0 and is clean above it.
2. Tests: semver compare + doctor warning on a 0.20.0 shim.
3. `npm test` passes.

## Anti-patterns

- Do not hard-fail dispatch for below-floor 0.x (degraded ≠ broken).

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
