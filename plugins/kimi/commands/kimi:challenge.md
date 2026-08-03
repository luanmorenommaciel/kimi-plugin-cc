---
name: kimi:challenge
description: Run an adversarial review that questions design decisions, trade-offs, and hidden assumptions. Read-only.
argument-hint: [--base <ref>] [--background] [focus text]
allowed-tools: [Bash, Read, Task]
---

# /kimi:challenge

> Steerable adversarial review. Pressure-test assumptions and challenge the chosen approach.

## Usage

```
/kimi:challenge
/kimi:challenge --base main
/kimi:challenge --background look for race conditions and question the caching design
```

## Process

1. **Capture diff**
   ```
   Bash("node plugins/kimi/scripts/broker.mjs branch-diff --base <ref>")
   ```

2. **Load challenge prompt template**
   ```
   Read("plugins/kimi/prompts/challenge.md")
   ```

3. **Dispatch to Kimi**
   - Combine prompt template + diff + optional focus text.
   - Use the `explore` role (`--role explore`).
   - Invoke via broker:
   ```
   Bash("node plugins/kimi/scripts/broker.mjs dispatch \
     --prompt '<combined>' \
     --role explore \
     --mode challenge \
     [--background]")
   ```

4. **Parse output**
   - Validate against `schemas/review-output.schema.json`.
   - Render findings grouped by severity.

## Output

```json
{
  "summary": "string",
  "findings": [
    {"severity": "warning", "topic": "concurrency", "message": "...", "alternative": "..."}
  ]
}
```

## Notes

- Read-only. Does not fix code.
- Use before shipping to pressure-test design choices.
