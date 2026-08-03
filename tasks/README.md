# Tasks — kimi-plugin-cc enhancement program

These are this repo's own development specs (input for `/kimi:crank` during development), not user-facing examples.

Generated 2026-07-19 from the repo review + Kimi Code 0.28.1 / K3 capability research.

Execution order (dependencies encoded in each file's `depends_on`):

| # | Task | Priority | Summary |
|---|------|----------|---------|
| T-01 | New-CLI spawn compat | P0 | Unified flag builder; `kimi -p --output-format stream-json` for Kimi Code 0.x; drop `--print/--yolo/--work-dir/--agent-file`; CLI generation detection |
| T-02 | Agent layer | P0 | Replace `--agent-file` YAMLs with role system prompts injected into the prompt |
| T-03 | Setup overhaul | P1 | Version/doctor/auth validation for Kimi Code 0.x; install docs |
| T-04 | Native resume | P1 | Real Kimi session IDs; `--session <id>` resume; working handoff |
| T-05 | Real telemetry | P1 | Token usage from `wire.jsonl`; estimation fallback |
| T-06 | K3 surfacing | P1 | `--effort`, K3 model docs, env-configurable context caps |
| T-07 | Hooks & ops | P2 | Completion notify, real review-gate wiring, debug bundles, `kimi vis` hint |
| T-08 | Kimi Code plugin | P2 | Dual distribution via `kimi.plugin.json` |
| T-09 | Bug-fix sweep | P2 | Background wall-clock cap, `KIMI_PLUGIN_DATA`, cross-repo leak, plugin-root paths, multi-glob, codex verdicts, dead code |
| T-10 | Docs & hygiene | P2 | Doc drift, repositioning, `.kimi/` state, 0.4.0 bump |
| T-11 | Test coverage | P2 | Behavior tests for the new/changed modules |

Second batch (P0–P2 hardening + feature expansion):

| # | Task | Priority | Summary |
|---|------|----------|---------|
| T-12 | Monitor changeTracking | P0 | Firecrawl `changeTracking` replaces hand-rolled hash/string diff; per-field JSON diffs |
| T-13 | CLI version floor | P0 | `MIN_KIMI_CODE_VERSION` 0.28.0; doctor warns below floor (native resume/telemetry degrade) |
| T-14 | Review-schema validation | P0 | Broker enforces review/challenge JSON contracts with one correction retry |
| T-15 | --deep-research | P1 | Tavily async `/research` task → cited brief injected pre-crank |
| T-16 | Context7 docs provider | P1 | `--docs-provider context7\|firecrawl`; Context7 default, Firecrawl/Tavily fallback |
| T-17 | Status auto-transition | P1 | Broker flips task `status:` ready → in-progress → completed/failed |
| T-18 | --max-cost watchdog | P2 | Live estimated-cost cap kills runaway cranks (reason `max-cost`, exit 6) |
| T-19 | broker prune | P2 | `--older-than 30d [--yes]`; dry-run default; running sessions spared |
| T-20 | Effort defaults | P2 | review/explore → low, crank/plan → high; explicit flag wins |
| T-21 | external_docs crawl | P2 | `URL "instruction"` lines crawled via Tavily and injected into context |

## Deferred (not in this pass)

- **`kimi web` REST/WebSocket dispatch backend** — replace PID-file job control with the local API (`GET /openapi.json`). A deliberate architectural project of its own; the PID-file design works and every fix above keeps it coherent. Revisit after 0.4.0 has soaked.
