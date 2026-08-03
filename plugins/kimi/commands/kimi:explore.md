---
name: kimi:explore
description: Deep codebase exploration via the broker's read-only --role explore. Produces Executive Summary, Health Score, and Architecture Deep Dive.
argument-hint: <question> [--background]
allowed-tools: [Bash, Read, Task]
---

# /kimi:explore

> Structured codebase analysis: Executive Summary + Health Score + Architecture Deep Dive.

## Usage

```
/kimi:explore how does the auth module work?
/kimi:explore find all database connection code
/kimi:explore --background give me an architecture overview
/kimi:explore                     # generic analysis when no question is given
```

## Process

1. **Load explore prompt template**
   ```
   Read("plugins/kimi/prompts/explore.md")
   ```

2. **Dispatch to Kimi**
   - The free-text question is the primary input; when no question is given, fall back to a generic codebase analysis.
   - Use the `explore` role (`--role explore`).
   ```
   Bash("node plugins/kimi/scripts/broker.mjs dispatch \
     --prompt '<question>' \
     --role explore \
     --mode explore \
     [--background]")
   ```
   Fallback prompt when no question: "Analyze the codebase at $(pwd). Follow the explore prompt template."

3. **Parse and render**
   - Parse JSON output for `summary`, `healthScore`, `techStack`, `insights`, `architecture`.
   - Render as a markdown report.

## Output

```markdown
## 🎯 Executive Summary
...
### Health Score: 8/10
...
### Tech Stack
...
### Key Insights
...
```

## Notes

- Runs under the broker's `--role explore`: the read-only role prompt in `plugins/kimi/roles/explore.md` is composed into the head of the `-p` prompt (`--agent-file` YAMLs no longer exist in Kimi Code 0.x).
- Read-only enforcement is a prompt-level contract — 0.x cannot exclude tools headlessly.
