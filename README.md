# Kimi plugin for Claude Code

Use [Kimi](https://kimi.ai) from inside Claude Code for code reviews, codebase exploration, or to delegate tasks to Kimi.

This plugin is for Claude Code users who want an easy way to start using Kimi from the workflow they already have.

## What You Get

- `/kimi:review` for a normal read-only code review
- `/kimi:challenge` for a steerable adversarial review that questions your design
- `/kimi:explore` for read-only codebase exploration and architecture analysis
- `/kimi:crank` to delegate a task file (`tasks/T-*.md`) to Kimi for execution
- `/kimi:crank-batch` to run a batch of task files in dependency-ordered waves (parallel where safe)
- `/kimi:crank-next` to pick and run the single highest-priority ready task
- `/kimi:plan` to generate a structured implementation plan from a task description
- `/kimi:status`, `/kimi:result`, and `/kimi:cancel` to manage background jobs
- `/kimi:setup` to verify the Kimi install and manage the review gate and AFK default
- `/kimi:update` to check for and install plugin updates

## Why Delegate To Kimi At All?

Claude Code can run directly on Kimi's K3 model (`ANTHROPIC_BASE_URL=https://api.kimi.com/coding/`), so this plugin is not about model access — it is about **multi-agent orchestration**:

- **Second opinion** — a different agent harness reviews or challenges Claude's work with fresh, isolated context
- **Separate quota and context window** — cranks run on your Kimi membership, with K3's 1M-token context, without touching Claude's session
- **Adversarial gates** — optional Codex plan/diff reviews and a Kimi Stop-hook gate around Claude's own responses
- **Full session handoff** — every run is a native Kimi Code session you can reopen with `kimi --session <id>` or inspect with `kimi vis <id>`

## Requirements

- **Kimi Code CLI 0.x** (tested against 0.28.x).
  - Install with: `npm i -g @moonshot-ai/kimi-code`, or the native installer from [kimi.com/code](https://www.kimi.com/code)
  - Already on the legacy Python `kimi-cli` 1.x? Run `/upgrade` inside it to migrate config and sessions automatically.
  - Verify with: `kimi --version`
- **Node.js 20.17 or later**
  - The broker that dispatches commands to Kimi is a Node.js application.
- **A Kimi account with API access.**
  - Run `kimi login` to authenticate.

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add luanmorenommaciel/kimi-plugin-cc
```

Install the plugin:

```bash
/plugin install kimi@luanmorenommaciel-kimi
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/kimi:setup
```

## Update

Check for updates:

```bash
/kimi:update --check-only
```

Install the latest version:

```bash
/kimi:update
```

Or manually — `check-update` resolves the plugin repo from the broker's own location (never your project's repo) and prints the exact command as `update_command`:

```bash
/kimi:update --check-only
# → prints e.g. "update_command": "cd \"/path/to/kimi-plugin-cc\" && git pull && /reload-plugins"
cd /path/to/kimi-plugin-cc && git pull
/reload-plugins
```

`/kimi:setup` will tell you whether Kimi is ready. If Kimi CLI is missing, it will guide you to install it. If Kimi is installed but not logged in yet, run:

```bash
!kimi login
```

After install, you should see:

- the slash commands listed below
- the `kimi:kimi-delegate` subagent in `/agents`

One simple first run is:

```bash
/kimi:review --background
/kimi:status
/kimi:result
```

## Usage

### `/kimi:review`

Runs a normal code review on your current work. It gives you the same quality of code review as running `/review` inside Kimi directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It runs in the foreground by default; use `--background` for long reviews and check in with `/kimi:status` + `/kimi:result`. It is not steerable and does not take custom focus text. Use [`/kimi:challenge`](#kimichallenge) when you want to challenge a specific decision or risk area.

Examples:

```bash
/kimi:review
/kimi:review --base main
/kimi:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/kimi:status`](#kimistatus) to check on the progress and [`/kimi:cancel`](#kimicancel) to cancel the ongoing task.

### `/kimi:challenge`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/kimi:review`, including `--base <ref>` for branch review. It also supports `--background`. Unlike `/kimi:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/kimi:challenge
/kimi:challenge --base main challenge whether this was the right caching and retry design
/kimi:challenge --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/kimi:explore`

Runs a read-only codebase exploration and architecture analysis.

Use it when you want:

- to understand a new codebase or module
- to find all call sites of a function or API
- to answer questions about how a feature works
- to generate an architecture overview before making changes

It uses a prompt-enforced read-only role: the explore role prompt forbids writing, editing, or deleting files and forbids mutating shell commands. Kimi Code 0.x cannot exclude tools in headless mode, so this is a behavioral contract rather than a hard sandbox — see `plugins/kimi/roles/explore.md`.

Examples:

```bash
/kimi:explore how does the auth module work?
/kimi:explore find all database connection code
/kimi:explore --background give me an architecture overview
```

### `/kimi:crank`

Delegates a task to Kimi through the `kimi:kimi-delegate` subagent.

Use it when you want Kimi to:

- implement a feature from a task spec file (`tasks/T-*.md`)
- investigate a bug
- try a fix
- continue a previous Kimi task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest task thread for this repo.

It also supports `--model <alias>` to choose a specific Kimi model (e.g. `kimi-code/k3`), `--effort <level>` to force a thinking level, `--deep-research` to inject a cited Tavily research brief before cranking, `--max-cost <usd>` to kill a runaway crank at a budget, and `--docs-provider context7|firecrawl` to pick where library docs come from.

Examples:

```bash
/kimi:crank tasks/T-20260521-xref-descriptions-merge-pipeline.md
/kimi:crank --resume apply the top fix from the last run
/kimi:crank --model kimi-code/k3 --effort max --background implement the bronze layer parser
/kimi:crank --fresh investigate why the tests started failing
```

You can also just ask for a task to be delegated to Kimi:

```text
Ask Kimi to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model`, the plugin uses the default model from your Kimi config.
- follow-up crank requests can continue the latest Kimi task in the repo

### `/kimi:crank-batch`

Runs a batch of task files in dependency-respecting waves — parallel where safe, sequential where `touches_paths` overlap.

Examples:

```bash
/kimi:crank-batch tasks/T-*.md
/kimi:crank-batch tasks/T-*.md --max-parallel 2
/kimi:crank-batch tasks/T-*.md --force-dispatch --skip-preflight
```

Notes:

- tasks with overlapping non-doc `touches_paths` never run in the same wave
- `--max-parallel` caps concurrency (default: 4)
- the batch wait deadline defaults to `KIMI_DISPATCH_TIMEOUT_MS` + 60s; any session still running at the deadline is auto-cancelled so one hung task can't pin the whole wave

### `/kimi:crank-next`

Picks the single highest-priority task in `tasks/` with `status: ready` whose `depends_on` are all completed, and dispatches it with the same preflight and origin-state gates as `/kimi:crank`.

Examples:

```bash
/kimi:crank-next
/kimi:crank-next --model kimi-code/k3 --skip-preflight
```

### `/kimi:plan`

Generates a structured implementation plan from a task description.

Use it when you want:

- a step-by-step implementation plan before writing code
- to identify key files and architectural decisions
- to estimate scope and risk before committing to a task

The plan agent is read-only and will not write any files. It outputs a structured plan you can review before delegating to `/kimi:crank`.

Examples:

```bash
/kimi:plan "Add a new file type parser for the TDDF module"
/kimi:plan --background "Refactor the bronze layer to use a single table"
```

### `/kimi:status`

Shows running and recent Kimi jobs for the current repository.

Examples:

```bash
/kimi:status
/kimi:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

Notes:

- the list view shows a prompt preview (`prompt_preview`) and byte count (`prompt_bytes`) instead of full prompts
- sessions with unreadable metadata surface as `status: 'corrupt'` and are skipped by `prune` (`skipped_corrupt`)

### `/kimi:result`

Shows the final stored Kimi output for a finished job.
When available, it also includes the Kimi session ID and the exact handoff command so you can reopen that run directly in Kimi with `kimi --session <session-id>`.

Examples:

```bash
/kimi:result
/kimi:result task-abc123
```

### `/kimi:cancel`

Cancels an active background Kimi job.

Examples:

```bash
/kimi:cancel
/kimi:cancel task-abc123
```

### `/kimi:setup`

Checks whether Kimi CLI is installed and authenticated.
If Kimi CLI is missing, it will guide you to install it.

You can also use `/kimi:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/kimi:setup --enable-review-gate
/kimi:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Kimi review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Kimi loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

#### Enabling AFK/YOLO default

```bash
/kimi:setup --enable-afk-default
/kimi:setup --disable-afk-default
```

When AFK default is enabled, the plugin sets `default_permission_mode = "auto"` in your `~/.kimi-code/config.toml` (disabling sets it back to `"default"`), so interactive Kimi sessions stop prompting for tool-call confirmation. Broker dispatches are unaffected either way — they already run headless via `kimi -p`, which executes under auto permission (`--yolo` is rejected in prompt mode). This is useful for long-running background tasks.

## Typical Flows

### Also available as a native Kimi Code plugin

The same workflows ship for Kimi Code itself (no Claude Code needed). Inside `kimi`:

```text
/plugins install https://github.com/luanmorenommaciel/kimi-plugin-cc
/reload
```

That gives you `/crank:review`, `/crank:challenge`, `/crank:explore`, `/crank:plan`, `/crank:run <task-spec>`, and the `crank-loop` skill. Third-party installs show a trust confirmation — that is expected.

### Review Before Shipping

```bash
/kimi:review
```

### Hand A Problem To Kimi

```bash
/kimi:crank investigate why the build is failing in CI
```

### Explore A New Codebase

```bash
/kimi:explore give me an architecture overview
```

### Start Something Long-Running

```bash
/kimi:challenge --background
/kimi:crank --background investigate the flaky test
```

Then check in with:

```bash
/kimi:status
/kimi:result
```

## Kimi Integration

The Kimi plugin wraps the [Kimi Code CLI](https://www.kimi.com/code/docs/en/) (0.x). It uses the global `kimi` binary installed in your environment and applies the same configuration.

### Common Configurations

The plugin uses your standard Kimi Code config at `~/.kimi-code/config.toml`. For example, to default to K3:

```toml
default_model = "kimi-code/k3"
default_effort = "high"
```

Notes:

- `--effort` accepts `low` / `medium` / `high` / `xhigh` / `max`. Allegretto members and above unlock K3's 1M-token context window.
- Per crank, `/kimi:crank --model <alias>` overrides the model and `--effort <level>` forces a thinking level (applied via `KIMI_MODEL_THINKING_EFFORT` — your config is never edited). Without `--effort`, modes get sensible defaults: review/challenge/explore run `low`, crank/plan run `high` (disable with `KIMI_EFFORT_DEFAULTS=off`).
- Library docs come from Context7 by default (versioned, LLM-optimized snippets); `--docs-provider firecrawl` switches back to scrape-based extraction.
- Switching models invalidates the existing prompt cache, so the first run after a switch costs more input tokens.
- Context-injection caps default to K3-sized values and are overridable via env: `KIMI_CTX_CAP_CONTEXT_BYTES` (16K), `KIMI_CTX_CAP_DOCS_BYTES` (8K), `KIMI_CTX_CAP_RESEARCH_BYTES` (4K), `KIMI_CTX_CAP_PATTERNS_BYTES` (6K). Drop them back to 8K/4K/2K/3K on 256K tiers.

### Optional API keys

Some features call third-party services and need a key. All are optional — the broker degrades gracefully (skips the feature with a warning) when a key is missing. Put keys in a `.env` file; the broker auto-loads it starting from your current directory and walking up to the repository root. See `.env.example` for the full template.

| Env var | Enables |
|---|---|
| `TAVILY_API_KEY` | `--research` / `--deep-research` research briefs, `external_docs:` crawl lines, library-docs fallback, API validation |
| `FIRECRAWL_API_KEY` | `--docs-provider firecrawl` scrape-based library docs, external-doc change monitoring (`broker monitor`) |
| `EXA_API_KEY` | `--patterns` semantic code-pattern search |
| `CONTEXT7_API_KEY` | Optional — higher rate limits for Context7, the default docs provider (works without a key) |

### Reliability & timeouts

Every crank runs under two limits so a hung or looping Kimi process can't block you forever:

- `KIMI_DISPATCH_TIMEOUT_MS` — hard wall-clock cap on a single crank. Default 30 minutes (`1800000`). This is the absolute ceiling, no matter what Kimi is doing.
- `KIMI_IDLE_TIMEOUT_MS` — idle-output watchdog. Default 5 minutes (`300000`). If Kimi stops emitting output for this long, the crank is treated as stalled and killed — this catches loops and hangs that the wall-clock cap alone would let run for the full 30 minutes.

When either limit fires, the crank's whole process group is terminated (SIGTERM, then SIGKILL after 2s) — child processes Kimi spawned can't outlive the kill — and the crank **fails fast with exit code 6**. A timeout is terminal — it is not retried. The session is marked `status: failed`, `reason: timeout`, and your work is left **uncommitted** so you can inspect the partial diff or resume it with `/kimi:crank --resume`.

Background cranks run under a detached supervisor process. If the supervisor itself dies (machine restart, crash, `kill -9`), the next broker command reconciles the orphaned session to `status: 'interrupted'` with `reason: 'supervisor-died'` and attempts a salvage commit per the session's auto-commit policy — the work is never silently lost.

A third guard is budget-based: `--max-cost <usd>` (or `KIMI_MAX_COST_USD`) kills a crank whose estimated live cost crosses the cap, marked `reason: max-cost` with the same exit code 6 contract. The live estimate uses transcript growth; post-run telemetry reconciles with real usage.

Old sessions accumulate in `~/.kimi-plugin-cc/sessions/` — reclaim with `node plugins/kimi/scripts/broker.mjs prune --older-than 30d` (dry-run by default; `--yes` deletes; running sessions are always spared).

In a `crank-batch` wave, the batch wait deadline defaults to `KIMI_DISPATCH_TIMEOUT_MS` + 60s. Any session still stuck at the deadline is auto-cancelled (killed and marked `cancelled`) so one hung task can't pin the whole wave.

Override a default per-task when you expect a long run:

```bash
export KIMI_DISPATCH_TIMEOUT_MS=5400000   # 90 minutes for a big refactor
/kimi:crank tasks/T-large-migration.md
```

### Moving The Work Over To Kimi

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can be reopened directly in Kimi Code: `/kimi:result` and `/kimi:status` print the exact `kimi --session <session-id>` handoff command for the run.

This way you can review the Kimi work or continue the work there.

## FAQ

### Do I need a separate Kimi account for this plugin?

If you are already signed into Kimi on this machine, that account should work immediately here too. This plugin uses your local Kimi CLI authentication.

If you only use Claude Code today and have not used Kimi yet, you will also need to sign in to Kimi. Run `/kimi:setup` to check whether Kimi is ready, and use `!kimi login` if it is not.

### Does the plugin use a separate Kimi runtime?

No. This plugin delegates through your local [Kimi Code CLI](https://www.kimi.com/code/docs/en/) on the same machine.

That means:

- it uses the same Kimi install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Kimi config I already have?

Yes. If you already use Kimi, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Kimi CLI, your existing sign-in method and config still apply.

If you need to point Kimi at a different endpoint, configure a custom provider in your [Kimi Code config](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers.html).

### What is the difference between `/kimi:review` and `/kimi:challenge`?

`/kimi:review` is a standard code review — it finds bugs, style issues, and suggests improvements.

`/kimi:challenge` is an adversarial review — it questions your design decisions, finds hidden assumptions, and suggests alternative approaches. Use it before shipping anything critical.

### What is the difference between `/kimi:explore` and `/kimi:crank`?

`/kimi:explore` is read-only by prompt contract — the explore role prompt forbids writing files and mutating shell commands (Kimi Code 0.x cannot exclude tools in headless mode, so enforcement is behavioral, not a sandbox). Use it to understand code safely.

`/kimi:crank` is write-capable. It can modify files, run tests, and implement features. Use it when you want Kimi to actually do work.

### What does the review gate do?

When enabled, every time Claude stops to ask you something, the plugin runs a quick Kimi review on Claude's proposed response. If Kimi finds issues, the stop is blocked and Claude is asked to fix them first. This creates an extra safety net but can be slow.

### What does AFK/YOLO mode do?

When enabled via `/kimi:setup --enable-afk-default`, the plugin sets `default_permission_mode = "auto"` in `~/.kimi-code/config.toml`, so Kimi does not prompt for confirmation on tool calls. Broker dispatches already run headless (`kimi -p`, auto permission — `--yolo` is rejected in prompt mode), so the toggle mainly matters for interactive Kimi sessions. Use with caution on production code.
