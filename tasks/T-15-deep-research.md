---
format_version: "1"
id: T-15
title: --deep-research via Tavily /research async endpoint
priority: P1
status: done
depends_on: []
touches_paths:
  - plugins/kimi/scripts/lib/research.mjs
  - plugins/kimi/scripts/lib/commands.mjs
---

## Goal

`--research` does one shallow Tavily search call. Tavily's `/research` endpoint runs a real async research agent (create task → poll → cited multi-source report). Add `--deep-research` for cranks that need a serious brief.

## Scope

- `research.mjs`: add `deepResearch(topics)`: POST `https://api.tavily.com/research` `{query, model: "auto"}`, poll `GET /research/{request_id}` with backoff until completed/failed (cap total wait, default 4 min, env `KIMI_DEEP_RESEARCH_TIMEOUT_MS`). Warn-and-skip without TAVILY_API_KEY or on failure, same as today.
- Inject the report into the dispatch prompt under its own cap (`KIMI_CTX_CAP_DEEP_RESEARCH_BYTES`, default 16KB).
- Broker flag `--deep-research` on dispatch (composes with `--research`; deep runs when both set), documented in usage + `kimi:crank.md`.

## Success Criteria

1. Flag end-to-end: prompt includes the research brief when the stubbed API completes.
2. Polling stops on timeout with a warn-and-skip, never hangs dispatch.
3. Tests with stubbed fetch: create→poll→inject, failed task, missing key.
4. `npm test` passes.

## Anti-patterns

- No synchronous fire-and-forget of the research task — the brief must reach the prompt or be explicitly skipped.

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
