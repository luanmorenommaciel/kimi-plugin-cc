---
format_version: "1"
id: T-03
title: Setup overhaul — CLI detection, kimi doctor, install docs
priority: P1
status: done
depends_on:
  - T-01
touches_paths:
  - plugins/kimi/scripts/lib/commands.mjs
  - plugins/kimi/scripts/lib/preflight.mjs
  - plugins/kimi/commands/kimi:setup.md
  - README.md
  - docs/getting-started.md
---

## Goal

`/kimi:setup` currently assumes the legacy Python kimi-cli (pip install, v1.44+ check). Make it validate a Kimi Code 0.x install end to end.

## Scope

- Detect the `kimi` binary, parse `--version`, classify: 0.x OK / 1.x unsupported-with-migration-steps / missing-with-install-steps (npm `@moonshot-ai/kimi-code` or native installer).
- Run `kimi doctor` as a config-validation step and surface its output.
- Check authentication state without spending quota (config/credential presence under `~/.kimi-code`; fall back to instructing `kimi login`).
- Keep the review-gate and AFK toggles working; AFK/`default_yolo` semantics changed (prompt mode is auto by default) — update the toggle docs accordingly.
- Update README + docs/getting-started.md prerequisites (Kimi Code 0.x, Node 20.17+ per package.json engines).

## Success Criteria

1. Setup output names the detected CLI version and generation explicitly.
2. `kimi doctor` failures are shown verbatim with a fix hint.
3. Docs no longer mention `pip install kimi-cli` as the primary path.
4. `npm test` passes.

## Anti-patterns

- Do not probe auth by running a real model call.
- Do not edit the user's `~/.kimi-code/config.toml` from setup.

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
