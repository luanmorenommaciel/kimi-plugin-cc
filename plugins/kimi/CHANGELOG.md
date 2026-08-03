# Changelog

## Unreleased

- **Flag validation**: per-command flag allowlists; unknown flags error with a did-you-mean suggestion; `--help`/`help` exits 0
- **Positional session ids** for `status`/`result`/`cancel` (`--session-id` still accepted); `--fresh` + `--resume` is rejected
- **Detached background supervisor**: background cranks re-exec as an internal `supervise` command; orphaned sessions reconcile to `status: 'interrupted'` with `reason: 'supervisor-died'`; crank pid in `kimi.pid`, supervisor pid in `pid`
- **Process-group kills**: cancel/timeout SIGTERM→SIGKILL the whole process tree, not just the direct child
- **Baseline-scoped auto-commit**: with empty `touches_paths`, stages only paths changed since `baseline_sha` (no `git add -A` sweeps); commit skipped when nothing changed since baseline
- **Foreground stderr capture**: piped to `<sessDir>/kimi.log`, with the tail surfaced in `meta.error` on failure
- **Atomic meta writes + corrupt surfacing**: status list shows `prompt_preview`/`prompt_bytes` instead of full prompts; unreadable metas report `status: 'corrupt'`; `prune` skips them (`skipped_corrupt`)
- **Diff capture**: 64MB git buffer; `branch-diff` errors loudly on an invalid base ref
- **`check-update` targets the plugin repo** — resolved from the broker's own location, never the caller's cwd — and prints an `update_command` for that path
- **Batch deadline** defaults to `KIMI_DISPATCH_TIMEOUT_MS` + 60s; idle watchdog treats recent session-file mtime as activity and names `KIMI_IDLE_TIMEOUT_MS`/`KIMI_DISPATCH_TIMEOUT_MS` in its timeout `hint`
- **`report --tag`** no longer applies the default 24h window

## 0.4.0

- **Kimi Code 0.x migration (breaking)**: broker spawns `kimi -p --output-format stream-json`; legacy kimi-cli 1.x detected and rejected with migration guidance; `--agent-file` replaced by `--role coder|explore` (`roles/*.md` composed into the prompt)
- **Native resume**: real Kimi session ids captured from stream-json (`meta.kimi_session_id`); `--resume` uses `kimi --session <id>`; status/result print the handoff + `kimi vis` hint
- **Real telemetry** from `wire.jsonl` `usage.record` events (`estimated: false`), estimate kept as fallback
- **`--effort`** thinking-level flag (K3: low/high/max) via `KIMI_MODEL_THINKING_EFFORT`
- Env-configurable context caps (`KIMI_CTX_CAP_*`), K3-sized defaults
- New broker commands: `doctor`, `review-gate` (real Stop-hook wiring), `export-debug` (kimi export or tar bundle) — 21 total
- Completion notifications for background cranks (`KIMI_NOTIFY_CMD`/osascript/notify-send)
- Native Kimi Code plugin distribution (`kimi.plugin.json` + `plugins/kimi-code/`, `/crank:*` commands + crank-loop skill)
- Second batch: `--deep-research` (Tavily async research briefs), `--docs-provider context7|firecrawl` (Context7 default), `--max-cost` budget watchdog, `broker prune`, per-mode effort defaults, task-status auto-transition, review/challenge JSON validation with one retry, external_docs crawl syntax, CLI version floor warning, Firecrawl changeTracking monitor (per-field JSON diffs)
- Fixes: background wall-clock cap, `KIMI_PLUGIN_DATA` in result, cross-repo session leak, batch/next path resolution, multi-glob rules, codex verdict parsing, dead code, doc drift

## 0.3.4

- Dual subprocess timeouts: wall-clock cap (`KIMI_DISPATCH_TIMEOUT_MS`, 30m) + idle-output watchdog (`KIMI_IDLE_TIMEOUT_MS`, 5m) on foreground and background paths; terminal exit code 6 on timeout
- `waitForSessions` actively cancels stuck sessions so one hung task can't pin a batch wave
- Hardened the timeout path against TDZ crash on missing binary and leaked SIGKILL timer

## 0.3.3

- Real-world crank fallout: worktree-safe cwd isolation, durable auto-commit (`commit.mjs`), telemetry rewritten against the actual stream-json schema (estimated tokens), documented exit-code contract

## 0.3.1–0.3.2

- Zero-runtime-deps fix (picomatch → `path.matchesGlob`; marketplace install crash), meta-preservation + pipeline try/catch/finally

## 0.3.0

- Node.js broker with 16 subcommands and command registry pattern
- MCP integrations: Tavily (research/docs/validation), Firecrawl (structured extraction/monitoring), Exa (semantic patterns)
- 12-stage dispatch pipeline with preflight sandboxing, origin-state checks, and graceful degradation
- Wave-based batch orchestration with topological sort and path-conflict detection
- Checkpoint/resume with automatic diff stashing
- Structured warning system (JSONL)
- Telemetry parsing with token usage and cost estimation
- Codex adversarial review gates (plan + diff)
- Live progress streaming via output.jsonl polling
- Scoped context injection with picomatch glob rules
- Auto `.env` loading with `.env.example` template

## 0.2.1

- Node.js broker rewrite with 6 library modules
- 9 slash commands: crank, review, challenge, explore, plan, status, result, cancel, setup
- AFK/YOLO support for unattended execution
- Workspace-aware sessions with per-repo resume
- Structured output parsing from Kimi stream-json
- Optional review gate via Stop hook
- Agent security boundaries: coder (write), explore (read-only), plan (no shell)

## 0.1.0

- Initial version with bash-based implementation
- 6 commands: crank, review, status, result, cancel, setup
