---
name: kimi:review
description: Run a read-only peer review of uncommitted changes or a branch diff.
argument-hint: [--base <ref>] [--background]
allowed-tools: [Bash, Read, Task]
---

# /kimi:review

> Peer-review uncommitted changes or a branch diff. Read-only; no mutations.

## Usage

```
/kimi:review
/kimi:review --base main
/kimi:review --background --base main
```

## Process

1. **Determine review target**
   - If `--base <ref>`: capture `git diff <ref>...HEAD`
   - Otherwise: capture `git diff` (uncommitted changes)

2. **Load review prompt template**
   ```
   Read("plugins/kimi/prompts/review.md")
   ```

3. **Dispatch to Kimi via broker**
   ```
   Bash("node plugins/kimi/scripts/broker.mjs dispatch \
     --prompt 'Review this diff: ...' \
     --role explore \
     --mode review \
     [--background]")
   ```

4. **Parse and validate**
   - Parse JSON output.
   - Validate against `schemas/review-output.schema.json`.
   - Render findings with `renderReview()`.

## Output

```json
{
  "summary": "string",
  "findings": [
    {"severity": "info|warning|critical", "file": "string", "line": 42, "message": "string", "suggestion": "string"}
  ]
}
```

## Notes

- Uses `--role explore` → read-only by prompt contract (the `roles/explore.md` prompt forbids writes and mutating shell commands).
- Validates output against JSON schema for consistency.
