---
format_version: "1"
id: T-16
title: Context7 as the library-docs provider (--docs-provider)
priority: P1
status: done
depends_on: []
touches_paths:
  - plugins/kimi/scripts/lib/docs.mjs
  - plugins/kimi/scripts/lib/commands.mjs
---

## Goal

`docs.mjs` guesses documentation URLs and scrapes them. Context7 exists for exactly this: versioned, LLM-optimized library docs (`resolve-library-id` → `query-docs`). Make it the default docs provider.

## Scope

- New `lib/context7.mjs`: HTTP client for the Context7 API — search the library by name, then fetch topic-targeted snippets. Uses `CONTEXT7_API_KEY` when present; still attempts unauthenticated (rate-limited); warn-and-skip on failure like the other providers.
- `discoverLibraryDocs` gains a provider switch: `--docs-provider context7|firecrawl` (default `context7`), falling back to the Firecrawl path when Context7 yields nothing. Library detection from touched files stays as-is.
- Respect the existing `KIMI_CTX_CAP_DOCS_BYTES` cap; document the flag in usage + README.

## Success Criteria

1. Context7 snippets land in the prompt by default (stubbed HTTP test).
2. Firecrawl fallback still works when Context7 returns nothing.
3. `npm test` passes.

## Anti-patterns

- Do not remove the Firecrawl provider — it covers doc sites Context7 doesn't index.
- No hard dependency on a Context7 key.

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
