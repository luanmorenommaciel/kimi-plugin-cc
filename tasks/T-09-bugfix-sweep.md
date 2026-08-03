---
format_version: "1"
id: T-09
title: Correctness bug-fix sweep (broker + job control + state)
priority: P2
status: done
depends_on:
  - T-01
touches_paths:
  - plugins/kimi/scripts/lib/job-control.mjs
  - plugins/kimi/scripts/lib/commands.mjs
  - plugins/kimi/scripts/lib/state.mjs
  - plugins/kimi/scripts/lib/context.mjs
  - plugins/kimi/scripts/lib/codex-bridge.mjs
---

## Goal

Fix the known correctness bugs found in the v0.3.4 code review (independent of the CLI migration).

## Scope

1. Background jobs get the same wall-clock cap as foreground (`KIMI_DISPATCH_TIMEOUT_MS`), not just the idle watchdog.
2. `cmdResult` hardcodes `~/.kimi-plugin-cc` (commands.mjs:487) — honor `KIMI_PLUGIN_DATA`.
3. `getLatestSessionForRepo` falls back to a session from ANY repo (state.mjs:96) — scope strictly or return null.
4. `cmdBatch`/`cmdNext` hardcode agent-file paths relative to the plugin dev repo (commands.mjs:778,839) — resolve via plugin root env (`CLAUDE_PLUGIN_ROOT` with repo fallback) so marketplace installs work. (Rebases onto T-02's role resolution.)
5. `context.mjs:90` uses only the first glob of a rule — apply all globs.
6. `detectCodexCmd` never iterates its candidate list; `APPROVE_COMMIT` verdict parsed only by substring accident — make both explicit.
7. Remove dead code: unreachable `invokeKimi` background branch, unused imports (`renderReview`/`renderExplore`, `getRepoSessionFile`), redundant dynamic imports.

## Success Criteria

1. Each fix has a regression test (state scoping, plugin-data dir, codex verdict parsing, multi-glob at minimum).
2. No behavior change beyond the seven items.
3. `npm test` passes.

## Anti-patterns

- No opportunistic refactors outside the list.
- No behavior changes to checkpoint/stash logic.

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
