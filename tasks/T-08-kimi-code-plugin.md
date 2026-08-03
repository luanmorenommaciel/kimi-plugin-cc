---
format_version: "1"
id: T-08
title: Dual distribution — ship as a Kimi Code plugin (kimi.plugin.json)
priority: P2
status: done
depends_on:
  - T-02
touches_paths:
  - plugins/kimi-code
---

## Goal

Kimi Code 0.x has its own plugin system (`kimi.plugin.json` with skills, commands, MCP servers, hooks, sessionStart). Package the crank-loop workflows natively so Kimi Code users get them without Claude Code, and so we can dogfood.

## Scope

- New directory `plugins/kimi-code/` with a valid `kimi.plugin.json` manifest (name, version, interface metadata).
- Port the Claude Code command prompts to Kimi Code plugin slash commands (`commands/*.md` with frontmatter + `$ARGUMENTS`): review, challenge, explore, plan, crank at minimum — adapted to run natively (no broker; direct prompts).
- Add a `skills/crank-loop/SKILL.md` capturing the crank-loop methodology from docs/crank-loop-blueprint.md, wired as `sessionStart.skill` only if it adds value without being noisy — otherwise leave sessionStart out.
- README section: install via `/plugins install <github-url>` and trust-tier note.

## Success Criteria

1. Manifest validates against the documented schema (fields, name regex).
2. Each command file has frontmatter description and uses `$ARGUMENTS` correctly.
3. No Claude-Code-specific paths (`${CLAUDE_PLUGIN_ROOT}`, broker scripts) referenced from the Kimi Code plugin.
4. `npm test` passes.

## Anti-patterns

- Do not duplicate the broker into the Kimi Code plugin — it is prompt-only.
- Do not declare mcpServers/hooks that are not actually shipped.

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
