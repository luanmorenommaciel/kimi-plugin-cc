---
format_version: "1"
id: T-12
title: Monitor via Firecrawl changeTracking (per-field JSON diffs)
priority: P0
status: done
depends_on: []
touches_paths:
  - plugins/kimi/scripts/lib/monitor.mjs
  - plugins/kimi/scripts/lib/commands.mjs
---

## Goal

`monitor.mjs` watches task `external_docs` URLs with a weak 32-bit hash and naive string diff. Firecrawl's `changeTracking` format returns `changeStatus` (new/same/changed/removed) plus git-diff text and per-field JSON diffs. Replace the hand-rolled comparison.

## Scope

- `captureBaseline`: scrape with `changeTracking` so Firecrawl retains a server-side snapshot; keep the local snapshot file as a portability record.
- `checkForChanges`: re-scrape with `formats: [{type:"changeTracking", modes:["json","git-diff"]}]` and report `changeStatus`, `diff.text` (markdown diff), and `diff.json` (per-field when a schema is configured). First-ever check reports `new` (baseline established, not "changed").
- Preserve the warn-and-skip contract when FIRECRAWL_API_KEY is missing, and never fail a dispatch on monitor errors.
- Remove the weak hashUrl comparison path.

## Success Criteria

1. Change detection comes from Firecrawl `changeStatus`, not local hashing.
2. Tests (stubbed HTTP) cover: new → baseline, unchanged → same, changed → diff payloads surfaced.
3. `npm test` passes.

## Anti-patterns

- Do not keep the old hash comparison as a "fallback" — one comparison engine.
- No dispatch failures from monitor errors.

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
