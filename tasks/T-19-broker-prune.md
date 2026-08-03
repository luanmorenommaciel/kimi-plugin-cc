---
format_version: "1"
id: T-19
title: broker prune — session-dir hygiene
priority: P2
status: done
depends_on: []
touches_paths:
  - plugins/kimi/scripts/lib/state.mjs
  - plugins/kimi/scripts/lib/commands.mjs
---

## Goal

`~/.kimi-plugin-cc/sessions/` grows forever. Add `broker prune` to reclaim it safely.

## Scope

- `broker prune [--older-than 30d] [--yes]`: lists/deletes session dirs whose `meta.started_at` (fallback: dir mtime) is older than the threshold. Never deletes running sessions (pid-alive check). Default is a dry-run report; `--yes` executes deletion.
- Age parsing accepts `30d`, `12h`, `2w`.
- Register in usage + release smoke list; document in README.

## Success Criteria

1. Dry-run lists candidates without deleting; `--yes` deletes only old, non-running sessions.
2. Tests: old vs new dirs, running session spared, bad age value errors.
3. `npm test` passes.

## Anti-patterns

- Never delete a running or pid-less-but-recent session.
- No deletion without the explicit `--yes`.

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
