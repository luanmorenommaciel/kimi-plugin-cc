---
format_version: "1"
id: T-21
title: external_docs with crawl instructions (Tavily crawl/map)
priority: P2
status: done
depends_on: []
touches_paths:
  - plugins/kimi/scripts/lib/research.mjs
  - plugins/kimi/scripts/lib/monitor.mjs
  - plugins/kimi/scripts/lib/commands.mjs
---

## Goal

Task-spec `external_docs:` lines are single URLs that get scraped once. Let a line carry an instruction — `https://docs.example.com "find all pages about authentication"` — and pull the whole relevant doc set via Tavily `/crawl` (or `/map` + `/extract`).

## Scope

- Parse `external_docs` lines: bare URL (current behavior: baseline + one-shot scrape) vs URL + quoted instruction (crawl with instructions, inject collected content into the dispatch context under `KIMI_CTX_CAP_DOCS_BYTES`, and baseline each discovered URL for monitoring).
- Tavily-first (`/crawl` with `instructions`, capped depth/limit); warn-and-skip without TAVILY_API_KEY.
- Document the syntax in `docs/getting-started.md` and `kimi:crank.md`.

## Success Criteria

1. Instruction lines produce crawled, injected content (stubbed HTTP test) and monitor baselines for discovered URLs.
2. Bare-URL behavior unchanged.
3. `npm test` passes.

## Anti-patterns

- Cap crawl depth/limit and total injected bytes — a doc site must not blow the context budget.
- Keep bare-URL parsing backward compatible.

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
