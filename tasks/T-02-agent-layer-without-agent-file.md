---
format_version: "1"
id: T-02
title: Agent layer for Kimi Code 0.x — replace --agent-file with role system prompts
priority: P0
status: done
depends_on:
  - T-01
touches_paths:
  - plugins/kimi/scripts/lib/kimi.mjs
  - plugins/kimi/scripts/lib/commands.mjs
  - plugins/kimi/agent-files
---

## Goal

Kimi Code 0.x has no `--agent-file`. The broker currently relies on `agent-files/*.yaml` (coder/explore + sub variants) for role selection and tool restriction. Replace that mechanism.

## Scope

- Introduce a role layer: each dispatch role (`coder`, `explore`, `plan`, `review`) maps to a Markdown system-prompt file; the broker prepends that file's contents to the `-p` prompt (with a clear delimiter), replacing `${KIMI_WORK_DIR}` with the real repo path as today.
- Reuse the existing `agent-files/*-system.md` content — move/rename to a `roles/` layout only if it stays simple; delete the now-unused YAML files (0.x cannot consume them).
- Read-only enforcement for explore/review roles is now prompt-level discipline (0.x `-p` runs auto permission; `--plan` conflicts with `-p` so it cannot be used). State this tradeoff explicitly in the role prompt and in the README.
- Update every commands.mjs call site that passes `agentFile` to pass a role instead.

## Success Criteria

1. No code references `--agent-file` or the YAML files.
2. Each role's system prompt reaches the model verbatim at the head of the prompt.
3. Tests assert the composed prompt for at least coder and explore roles.
4. `npm test` passes.

## Anti-patterns

- Do not leave orphaned YAML agent files in the repo.
- Do not attempt to emulate `exclude_tools` via config.toml mutation.

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
