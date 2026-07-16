# Security notes — the read-only guarantee (honest version)

This fork adopts the hardening approach from
[limeflash/antigravity-plugin-cc](https://github.com/limeflash/antigravity-plugin-cc)
(the `agy` plugin). This document states the **real** guarantee level, including
its current gaps, rather than an optimistic one.

## How "read-only" works today, and where it's thin

`/kimi:review`, `/kimi:challenge`, `/kimi:explore` run:

```
kimi --print --yolo --work-dir <YOUR REPO> --agent-file <explore.yaml> -p "…"
```

- **`--yolo` auto-approves every tool call.** So "no approval prompt" is NOT what
  makes these read-only.
- **`--work-dir` is your real repository.** kimi runs *inside* your repo.
- The **only** thing making them read-only is that the agent-file
  (`agent-files/explore.yaml`) lists `exclude_tools:` — a **deny-list** that
  removes `WriteFile`, `StrReplaceFile`, `Shell`, `Agent`, `SetTodoList`,
  plan-mode, and background-task tools.

Two consequences worth knowing:

1. **The deny-list is fail-open.** It enumerates *specific* forbidden tools. If a
   future Kimi version (or a loaded MCP server) adds another write-capable tool
   that isn't on the list, `--yolo` auto-approves it. An **allow-list** (grant
   only read tools) would fail *closed*.
2. **No filesystem backstop.** The guarantee rests entirely on Kimi honoring the
   agent-file. There is no isolation, so a single gap (agent-file wrong, a tool
   slips through, Kimi doesn't gate strictly) means writes land in your working
   tree — `--work-dir` is the repo. The `agy` plugin learned this the hard way
   (a CRITICAL bug): removing auto-approve / restricting the agent is not enough
   on its own; the robust move is to run the CLI **outside** the repo.
3. Even today, read-only commands write `.kimi/.session` into your repo
   (`workspace.mjs writeRepoSession`) — plugin bookkeeping, not your code, but
   not literally "touches nothing."

## Hardening roadmap (agy-derived)

- [x] **Secret scan.** `plugins/kimi/scripts/lib/secrets.mjs` — scans prompts /
  diffs / file bodies for leaked credentials (AWS, GitHub, Slack, Anthropic,
  OpenAI/Moonshot `sk-`, PEM, inline assignments) before material is shipped to
  Kimi → Moonshot. Ported and unit-tested from the agy plugin. **Next: wire it as
  a preflight in `cmdDispatch` so a detected secret aborts the send.**
- [ ] **Allow-list agents (fail-closed).** Replace `exclude_tools` with an
  explicit read-only tool set (Read/Grep/Glob/List/…). Requires enumerating the
  Kimi tool catalog (`kimi` `--help` / agent schema) to avoid over-restricting
  and breaking exploration — **needs a live Kimi install to validate.**
- [ ] **Filesystem isolation (the backstop).** Run kimi *outside* your working
  tree, per command:
  - `explore` (needs whole-repo read): a **detached git worktree** — full read
    access, writes can't reach your tree.
  - `review` / `challenge` (need your **uncommitted** diff, which a HEAD worktree
    would NOT contain): **stage the diff + changed files** into a temp dir and
    point `--work-dir` there — the same design agy uses.
  - Strip repo-locating env (`GIT_DIR`, `GIT_WORK_TREE`, …) as defense in depth.
  - **Needs a live Kimi install to dogfood** (verify explore/review still read
    what they need, and that 0 changes land in the real repo).

## Honest guarantee levels

- **Today:** read-only *by agent-file* only — strong if Kimi strictly gates
  tools per agent, but fail-open and with no backstop.
- **After the roadmap:** read-only *by construction* (kimi can't reach the repo
  to write) + fail-closed allow-list + secret scan — the agy tier.

## Reporting

Security issues in this plugin (not Kimi/Moonshot itself): open a private
advisory or issue on this fork.
