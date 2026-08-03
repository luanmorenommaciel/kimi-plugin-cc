# Getting Started with kimi-plugin-cc

This guide will get you from zero to your first Kimi delegation inside Claude Code in under 5 minutes.

## Prerequisites

1. **Claude Code** — installed and running
2. **Node.js 20.17+** — the broker is a Node.js app
3. **Kimi Code CLI 0.x** — install with `npm i -g @moonshot-ai/kimi-code` (legacy `kimi-cli` 1.x users: run `/upgrade` inside it to migrate)
4. **Kimi account** — sign up at [kimi.ai](https://kimi.ai) and run `kimi login`

## Install the Plugin

```bash
# Add the marketplace
/plugin marketplace add luanmorenommaciel/kimi-plugin-cc

# Install the plugin
/plugin install kimi@luanmorenommaciel-kimi

# Reload
/reload-plugins
```

## Verify Setup

```bash
/kimi:setup
```

You should see a message confirming Kimi CLI is installed and authenticated.

## Your First Review

```bash
/kimi:review
```

This reviews your current uncommitted changes. For a branch comparison:

```bash
/kimi:review --base main
```

## Your First Delegation

Create a task file in your project's `tasks/` directory:

```markdown
# tasks/T-my-first-task.md

## Goal

Refactor the authentication module to use JWT tokens.

## Success Criteria

1. All existing tests pass
2. No hardcoded secrets
3. Token expiration is configurable

## Anti-patterns

- Do not store tokens in localStorage
- Do not use synchronous bcrypt in request handlers
```

Then delegate it:

```bash
/kimi:crank tasks/T-my-first-task.md
```

The broker manages the task's `status:` field for you: it flips to `in-progress` at dispatch, `completed` on success, and `failed` on failure — which is what `/kimi:crank-batch` and `/kimi:crank-next` use to schedule waves and dependency chains.

Task specs can also pin external documentation to watch and pull in:

```markdown
external_docs:
  - https://docs.example.com/quickstart
  - https://docs.example.com "find all pages about authentication"
```

A bare URL is baselined and re-checked for changes (via Firecrawl changeTracking). A URL with a quoted instruction is crawled (via Tavily), and the collected pages are injected into the crank's context.


## Explore Before You Change

Before modifying unfamiliar code:

```bash
/kimi:explore how does the auth module work?
```

This is read-only and safe to run anywhere.

## Background Tasks

For long-running work, use `--background`:

```bash
/kimi:crank --background tasks/T-my-first-task.md
```

Check progress:

```bash
/kimi:status
```

Get results:

```bash
/kimi:result
```

## Next Steps

- Read the [full command reference](../README.md#usage)
- Learn about [AFK/YOLO mode](../README.md#enabling-afkyolo-default) for unattended execution
- Explore the [review gate](../README.md#enabling-review-gate) for extra safety
