---
format_version: "1"
id: T-06
title: K3 surfacing — effort flag, model docs, 1M-context caps
priority: P1
status: done
depends_on:
  - T-01
touches_paths:
  - plugins/kimi/scripts/lib/commands.mjs
  - plugins/kimi/scripts/lib/kimi.mjs
  - plugins/kimi/scripts/lib/context.mjs
  - README.md
---

## Goal

Kimi K3 (1M context, thinking effort low/high/max) is the current flagship; the plugin still documents k2-era models and hardcodes small injection caps sized for 256K.

## Scope

- Verify how thinking effort is set non-interactively on 0.28.1 (config.toml key or env; check official docs) and wire a broker-level `--effort low|high|max` that applies per crank. If no headless channel exists, document the config.toml path and have `--effort` write nothing — fail with a clear message instead of pretending.
- Update model examples/docs to `k3` and the `kimi-for-coding` aliases; note the 1M-context tier requirement.
- Make the context-injection caps (8KB context / 4KB docs / 2KB research / 3KB patterns) configurable via env (`KIMI_CTX_CAP_*`) with raised-but-sane defaults for K3, instead of hardcoded constants.
- README: model/thinking-effort section, including the cache-invalidation caveat when switching models.

## Success Criteria

1. `--effort` is accepted by crank/review/challenge and either demonstrably applied or loudly unsupported.
2. Caps are env-overridable; defaults documented.
3. Docs show K3 as the default recommendation.
4. `npm test` passes.

## Anti-patterns

- Do not invent config keys — verify against the official docs/local `kimi doctor` before wiring.
- Do not raise defaults so high that prompts blow up on 256K tiers.

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
