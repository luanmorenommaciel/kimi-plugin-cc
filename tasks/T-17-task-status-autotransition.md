---
format_version: "1"
id: T-17
title: Task-status auto-transition (ready → in-progress → completed/failed)
priority: P1
status: done
depends_on: []
touches_paths:
  - plugins/kimi/scripts/lib/commands.mjs
  - plugins/kimi/scripts/lib/orchestrate.mjs
---

## Goal

The task engine consumes `status:` frontmatter (`crank-next` picks `ready`, deps need `completed`) but nothing writes it — users flip statuses by hand. Close the loop: the broker transitions the task file it dispatches.

## Scope

- New `updateTaskStatus(taskPath, status)` (orchestrate.mjs or a small lib): regex-replaces `status: <word>` inside the frontmatter block only, preserving everything else; no-op (with warning log) when the file has no status field.
- `runDispatch` with `--task-path`: set `in-progress` at dispatch start; on terminal exit 0 (including `already-done` skips) set `completed`; on failure/timeout/blocked set `failed`.
- Batch/next flows inherit the same transitions (they pass task_path already).
- Document the lifecycle in `docs/getting-started.md` and `kimi:crank.md`.

## Success Criteria

1. A dispatched task file ends `completed` on success, `failed` on failure, `in-progress` while running.
2. Tests: status transitions for success and failure paths; non-frontmatter content untouched.
3. `npm test` passes.

## Anti-patterns

- Do not rewrite the whole frontmatter or reorder fields — surgical single-line replace.
- Do not touch task files when the dispatch has no task_path.

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
