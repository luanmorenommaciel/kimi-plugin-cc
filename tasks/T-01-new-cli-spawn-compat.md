---
format_version: "1"
id: T-01
title: Kimi Code 0.x spawn compatibility — unified flag builder
priority: P0
status: done
depends_on: []
touches_paths:
  - plugins/kimi/scripts/lib/kimi.mjs
  - plugins/kimi/scripts/lib/job-control.mjs
  - plugins/kimi/scripts/lib/commands.mjs
---

## Goal

The broker currently spawns `kimi --print --yolo --work-dir <cwd> --agent-file <yaml> -p <prompt>`, which fails against Kimi Code 0.x (verified on 0.28.1: `--print` and `--agent-file` are unknown options; `--yolo` conflicts with `-p`). Make the broker work against the new CLI.

## Scope

- Add a single shared arg builder (e.g. `buildKimiArgs()`) used by BOTH the foreground path (`lib/kimi.mjs:38`) and the background path (`lib/job-control.mjs:45`) — they are currently duplicated and have drifted (background was missing `--yolo`).
- New invocation: `kimi -p <prompt> --output-format stream-json [--model <m>]`, working directory via spawn `cwd` (no `--work-dir`).
- Do NOT pass `--yolo` in prompt mode (0.x rejects the combination; prompt mode already runs under auto permission).
- `--agent-file` is removed here; the replacement lives in T-02 (call site must tolerate its absence).
- Add CLI generation detection (`kimi --version`): 0.x = supported; 1.x = hard error with a migration message pointing at the new Kimi Code install. Cache the detection per process.
- Keep stream-json parsing, retry-on-75, and the dual timeout/watchdog behavior intact.

## Success Criteria

1. One arg-builder function is the single source of truth; foreground and background use identical flags.
2. `kimi --version` 1.x produces a clear "unsupported legacy CLI, install Kimi Code" error, not a spawn failure.
3. Existing unit tests updated; new unit tests cover the arg builder for both modes.
4. `npm test` passes.

## Anti-patterns

- Do not keep a legacy-1.x code path "just in case" — one supported generation, detected and enforced.
- Do not silently swallow the version-detection failure into a generic spawn error.

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
