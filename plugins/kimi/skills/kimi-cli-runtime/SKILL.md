# Kimi CLI Runtime

Reference skill for the `kimi-plugin-cc` plugin. Documents how the Kimi Code 0.x CLI is invoked in headless mode.

## Headless invocation

```bash
kimi -p "<prompt>" --output-format stream-json [--model <alias>]
```

The working directory is set via the spawn `cwd` — there is no `--work-dir` flag. Do NOT pass `--yolo`: prompt mode already runs under auto permission, and 0.x rejects the `--yolo` + `-p` combination.

## Flags

| Flag | Description |
|------|-------------|
| `-p "<text>"` | Run one prompt non-interactively |
| `--output-format stream-json` | JSONL output (one JSON per line) |
| `--model <alias>` | Override model (e.g. `k3`) |
| `--session <id>` | Resume a previous Kimi session natively |
| `--continue` | Continue the most recent session for the working directory |

Legacy 1.x flags that no longer exist and must never be emitted: `--print`, `--quiet`, `--work-dir`, `--agent-file`.

## Exit codes

| Code | Meaning | Action |
|------|---------|--------|
| 0 | Success | Proceed |
| 1 | Permanent failure | Fail fast |
| 75 | Transient failure | Retry with backoff (max 3) |

Broker-level dispatch exit codes (2 origin-diverged, 3 buggy-evals, 4 review-pause, 5 checkpoint-conflict, 6 timeout) are documented in `agents/kimi-delegate.md`.

## Roles (replaces agent files)

Roles are Markdown system prompts under `plugins/kimi/roles/`, composed into the head of the `-p` prompt by the broker:

- `coder` — general software engineering (read/write/shell)
- `explore` — read-only codebase exploration (prompt-level constraint; 0.x cannot exclude tools headlessly)

Built-in Kimi Code subagents (`coder`, `explore`, `plan`) are scheduled by the Kimi agent itself inside the session — the broker does not select them.
