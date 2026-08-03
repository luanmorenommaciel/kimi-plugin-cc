---
name: kimi:crank
description: Delegate a task file to Kimi for execution. Write-capable. Supports resume, model override, auto-commit policy, and Codex review hooks.
argument-hint: <path-to-task-md> [--background] [--model <model>] [--resume] [--fresh] [--effort low|medium|high|xhigh|max] [--max-cost <usd>] [--deep-research] [--docs-provider context7|firecrawl] [--auto-commit on|off|on-clean] [--plan-review] [--diff-review] [--force-dispatch] [--skip-preflight] [--no-context] [--task-path <path>] [--touches-paths <csv>]
allowed-tools: [Bash, Read, Write, Edit, Task]
---

# /kimi:crank

> Delegate a task to Kimi's coder agent. Captures diff and returns a session ID.

## Usage

```
/kimi:crank tasks/T-20260526-build-kimi-plugin-cc.md
/kimi:crank tasks/T-20260526-build-kimi-plugin-cc.md --background
/kimi:crank tasks/T-20260526-build-kimi-plugin-cc.md --model kimi-code/k3
/kimi:crank --resume                # continue latest session for this repo
/kimi:crank --fresh                 # start new session, ignore latest
/kimi:crank task.md --auto-commit on-clean
/kimi:crank task.md --plan-review --diff-review
```

## Process

1. **Validate input**
   - Check that the argument path exists and matches `tasks/T-*.md` pattern.
   - Handle `--resume`: continue the latest repo session natively — the broker passes the stored Kimi session id via `kimi --session <id>`.
   - Handle `--fresh`: ignore the latest session and start clean (`--fresh` and `--resume` are mutually exclusive).

2. **Pre-flight gates**
   - Origin-state check: fetch origin, abort if touched paths diverged (override with `--force-dispatch`).
   - Preflight eval check: run task-spec validator, abort if evals are buggy (override with `--skip-preflight`).
   - Context injection: prepend CLAUDE.md / AGENTS.md / scoped rules (disable with `--no-context`).

3. **Optional Codex review**
   - `--plan-review`: adversarial plan critique before dispatch.
   - `--diff-review`: adversarial diff review before commit.

4. **Read task file**
   ```
   Read(<task-path>)
   ```

5. **Capture pre-run diff**
   ```
   Bash("node plugins/kimi/scripts/broker.mjs diff-capture --session-id <id> --phase pre")
   ```

6. **Dispatch to Kimi via broker**
   ```
   Bash("node plugins/kimi/scripts/broker.mjs dispatch \
     --prompt '<task_content>' \
     --role coder \
     --session-id <id> \
     --mode crank \
     --task-path <task-path> \
     --touches-paths <csv-from-spec> \
     [--background] \
     [--model <model>] \
     [--effort low|medium|high|xhigh|max] \
     [--auto-commit on|off|on-clean]")
   ```
   - Always pass `--task-path` and `--touches-paths` — omitting them silently disables the origin-divergence check, the preflight buggy-evals gate, context injection, research/patterns/deep-research injection, and `--plan-review`.

7. **Capture post-run diff** (foreground only)
   ```
   Bash("node plugins/kimi/scripts/broker.mjs diff-capture --session-id <id> --phase post")
   ```

8. **Checkpoint recovery**
   - If a session is cancelled, in-progress work is checkpointed to `.kimi/state/checkpoints/`.
   - Restore with `broker.mjs checkpoint --session-id <id> --restore`.

9. **Surface results**
   - Foreground: final message + diff delta + session ID.
   - Background: session ID + `/kimi:status` reminder.

## Notes

- Uses the `coder` role → write-capable, scoped to working directory.
- `--resume` continues the latest repo session natively (`kimi --session <id>`); `--fresh` starts clean.
- `--effort` forces a thinking-effort level for the run (accepts `low`/`medium`/`high`/`xhigh`/`max`; it is applied via `KIMI_MODEL_THINKING_EFFORT`, never by editing your config). Without it, crank defaults to `high`, read-only modes to `low`.
- `--max-cost <usd>` kills the crank when its estimated live cost crosses the budget (reason `max-cost`, exit code 6).
- `--deep-research` injects a cited Tavily research brief (async task, polled with a 4-minute cap) before cranking.
- `--docs-provider context7|firecrawl` picks the library-docs source (Context7 default).
- Task spec `external_docs:` lines accept `https://site "instruction"` for a Tavily crawl injected into context.
- The broker flips the task file's `status:` (`in-progress` → `completed`/`failed`) automatically.
- `--auto-commit` policies: `on` (always commit), `off` (never commit), `on-clean` (default: commit only if evals pass on first try).

## Exit codes

The broker returns one of these on `dispatch`:

```
0  ok / dispatched
2  origin-diverged       (local branch diverged from origin on touched paths)
3  buggy-evals           (preflight found broken eval bodies — fix the spec)
4  review-pause          (plan-review, diff-review, or api-validation flagged it)
5  checkpoint-conflict   (resume could not re-apply the stashed checkpoint)
6  timeout               (wall-clock or idle-output watchdog killed a hung crank)
```

**Exit code 6 means the crank timed out.** It hit either the wall-clock cap (`KIMI_DISPATCH_TIMEOUT_MS`, default 30m) or the idle-output watchdog (`KIMI_IDLE_TIMEOUT_MS`, default 5m). A timeout is terminal — it is not retried. The session is marked `status: failed`, `reason: timeout`, and the work is left **uncommitted** so you can inspect the partial diff or resume with `/kimi:crank --resume`.
