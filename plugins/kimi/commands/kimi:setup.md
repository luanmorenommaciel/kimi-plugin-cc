---
name: kimi:setup
description: Verify Kimi Code install, auth, role prompts, MCPs, review gate, and AFK defaults.
argument-hint: [--enable-review-gate] [--disable-review-gate] [--enable-afk-default] [--disable-afk-default]
allowed-tools: [Bash, Read, Write, Edit]
---

# /kimi:setup

> Verify the Kimi Code 0.x installation, auth, MCP config, and configure the review gate and AFK defaults.

## Process

1. **Run the broker doctor**
   ```
   Bash("node plugins/kimi/scripts/broker.mjs doctor")
   ```
   This reports, as JSON: binary generation + version, `kimi doctor` config validation, auth state (no quota spent), configured MCP servers, and role-prompt availability.

2. **Interpret the binary check**
   - `generation: "kimi-code"` (0.x) → OK.
   - `generation: "legacy"` (1.x) → tell the user to migrate: `npm i -g @moonshot-ai/kimi-code`, or run `/upgrade` inside the legacy CLI (it migrates config and sessions automatically).
   - `generation: "missing"` → install Kimi Code: `npm i -g @moonshot-ai/kimi-code` (or the native installer from https://www.kimi.com/code), then `kimi login`.

3. **Interpret auth**
   - `auth.ok: false` → instruct the user to run `!kimi login` (device-code flow, no TUI needed).

4. **Interpret MCP + roles**
   - Report the configured MCP server count and names.
   - `roles.ok: false` means the plugin install is damaged — recommend reinstalling the plugin.

5. **Review gate toggle** (if flags provided)
   ```
   Bash("node plugins/kimi/scripts/broker.mjs review-gate --enable")
   Bash("node plugins/kimi/scripts/broker.mjs review-gate --disable")
   Bash("node plugins/kimi/scripts/broker.mjs review-gate")   # status
   ```
   - The gate wires a real Claude Code `Stop` hook running `scripts/review-gate.mjs`, which asks Kimi to sanity-check each proposed response and blocks the stop on critical findings. It is fail-open (hook errors never block).
   - After enabling or disabling, tell the user to run `/reload-plugins` (or restart Claude Code) — `hooks.json` is only read at plugin-load time. Updating or reinstalling the plugin resets the gate to off (the shipped `hooks.json` is `{"hooks": {}}`).
   - The gate runs Kimi read-only (prompt-level constraint: no file writes, no mutating commands, no subagents) at low thinking effort. `KIMI_REVIEW_GATE_MODEL` overrides the model, `KIMI_REVIEW_GATE_TIMEOUT_MS` the timeout.
   - Loop safeguards: the gate exits immediately when the Stop payload has `stop_hook_active`, and a circuit breaker allows the stop after 3 consecutive blocks for the same Claude session (`KIMI_REVIEW_GATE_MAX_BLOCKS` to override).

6. **AFK default toggle** (if flags provided)
   - `--enable-afk-default`: set `default_permission_mode = "auto"` in `~/.kimi-code/config.toml` (edit the existing key if present).
   - `--disable-afk-default`: set it back to `"default"`.
   - Note: broker dispatches already run headless with auto permission — this toggle governs *interactive* `kimi` sessions.

7. **Report status**

   ```
   | Check         | Status |
   |---------------|--------|
   | Binary        | kimi-code 0.28.1 |
   | Config        | PASS (kimi doctor) |
   | Auth          | PASS   |
   | MCPs          | 3      |
   | Roles         | PASS   |
   | Review gate   | off    |
   | AFK default   | on     |
   ```

## Notes

- Does not mutate user config without explicit flags.
- Never probes auth by making a model call — the credentials directory is the source of truth.
- Safe to run at any time.
