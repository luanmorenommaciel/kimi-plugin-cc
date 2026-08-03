---
name: kimi:plan
description: Generate a structured implementation plan via the broker's plan mode. Read-only by prompt contract.
argument-hint: <feature-description>
allowed-tools: [Bash, Read, Task]
---

# /kimi:plan

> Produce a detailed implementation plan for a feature or task.

## Usage

```
/kimi:plan "Add OAuth2 authentication"
```

## Process

1. **Gather context**
   - Read `CLAUDE.md`, `README.md`, and relevant source files.
   - Identify extension points, hooks, and existing patterns.

2. **Dispatch to Kimi**
   - Use `--role coder` with `--mode plan` — the prompt instructs planning only, no file changes.
   - Prompt includes feature description + gathered context.
   ```
   Bash("node plugins/kimi/scripts/broker.mjs dispatch \
     --prompt 'Create an implementation plan for: <feature>. Context: ...' \
     --role coder \
     --mode plan")
   ```

3. **Render plan**
   - Parse structured output.
   - Output as markdown.

## Output

- State machine (Mermaid)
- API signatures
- File modification list
- Edge cases table
- Test requirements

## Notes

- Planning is enforced by the prompt (`--mode plan`), not by tool exclusion — Kimi Code 0.x cannot exclude tools headlessly.
- Can be fed into `/kimi:crank` for execution.
