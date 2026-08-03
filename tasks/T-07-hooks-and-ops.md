---
format_version: "1"
id: T-07
title: Hooks and ops — completion notify, real review gate, debug bundles
priority: P2
status: done
depends_on:
  - T-01
touches_paths:
  - plugins/kimi/hooks/hooks.json
  - plugins/kimi/scripts/lib/commands.mjs
  - plugins/kimi/scripts/lib/job-control.mjs
  - plugins/kimi/commands/kimi:setup.md
  - plugins/kimi/commands/kimi:status.md
---

## Goal

Three ops gaps: (1) background cranks finish silently, (2) `/kimi:setup --enable-review-gate` tells the user to hand-edit hooks.json — the prompt and schema exist but nothing wires them, (3) no one-command debug bundle for failed cranks.

## Scope

- Completion notification: when a background session closes, run a best-effort notifier — `KIMI_NOTIFY_CMD` env if set, else `osascript` on darwin / `notify-send` on linux; never fail the job on notify errors.
- Review gate for real: `--enable-review-gate` writes the Stop hook entry into `plugins/kimi/hooks/hooks.json` (correct current schema) referencing `prompts/review-gate.md`; `--disable-review-gate` removes it. Validate the resulting JSON.
- Debug bundle: new broker subcommand (e.g. `export-debug <session-id>`) that wraps `kimi export <kimi_session_id>` (needs T-04's stored id; degrade to bundling the broker session dir when absent).
- `/kimi:status` output gains the `kimi vis <session-id>` hint when a kimi_session_id is known.

## Success Criteria

1. hooks.json round-trips through enable/disable and is valid per the Claude Code hook schema used by this repo.
2. Notify fires on background completion (test: injected fake notifier command).
3. export-debug produces a zip or a clear degraded message.
4. `npm test` passes.

## Anti-patterns

- Do not make notification failures affect session state.
- Do not leave the review-gate prompt orphaned again — if wiring proves impossible, remove the prompt file and docs instead.

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
