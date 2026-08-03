---
format_version: "1"
id: T-10
title: Doc drift, repositioning, and repo hygiene — v0.4.0
priority: P2
status: done
depends_on:
  - T-01
  - T-06
touches_paths:
  - README.md
  - CHANGELOG.md
  - plugins/kimi/CHANGELOG.md
  - docs
  - package.json
  - .claude-plugin/marketplace.json
  - plugins/kimi/.claude-plugin/plugin.json
---

## Goal

Docs have drifted from code (Node 18.18 vs engines 20.17, README advertises a nonexistent `--wait` flag, "16 broker commands" vs 17, plugin CHANGELOG stuck at 0.3.0, typo "citical", empty `docs/getting-started/` dir, committed `.kimi/` test state). The CLI migration also changes the plugin's positioning.

## Scope

- Sweep README + docs: correct requirements, remove/replace `--wait` references with the real foreground/background story, fix counts and typos, delete the empty `docs/getting-started/` directory.
- Positioning: state the multi-agent value prop (second opinion, isolated context/quota, adversarial gates) and note Claude Code can also run directly on K3 via `ANTHROPIC_BASE_URL` — one short section, not a rewrite.
- Remove committed dev state (`.kimi/.session`, `.kimi/state/warnings.jsonl`) and gitignore them.
- Version bump to 0.4.0 across package.json, marketplace.json, plugin.json; sync both CHANGELOGs with a 0.4.0 entry summarizing the CLI migration and fixes.
- Update `agents/kimi-delegate.md` exit-code table to include codes 2–6.

## Success Criteria

1. No doc statement contradicts the code (spot-check: requirements, flags, command counts, exit codes).
2. `.kimi/` dev state gone from git and ignored.
3. Versions consistent at 0.4.0 everywhere; CHANGELOGs in sync.
4. `npm test` passes.

## Anti-patterns

- Do not rewrite README sections not affected by drift.
- Do not tag or release — files only.

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
