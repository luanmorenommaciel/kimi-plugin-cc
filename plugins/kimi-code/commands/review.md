---
description: Structured code review of current changes (optionally against a base ref) — read-only
---

Run a structured code review. Target: $ARGUMENTS (empty = uncommitted changes; a ref like `main` = compare the branch against it).

1. Run `git diff` for uncommitted changes, or `git diff <ref>...HEAD` when a base ref was given.
2. Review for correctness, security, performance, and maintainability. Cite specific files and line numbers.
3. Return ONLY a JSON object:

```json
{
  "summary": "One-line verdict",
  "findings": [
    {
      "severity": "info|warning|critical",
      "file": "relative/path",
      "line": 42,
      "message": "What the issue is",
      "suggestion": "How to fix it"
    }
  ]
}
```

Rules: strictly read-only — do not modify any files. `critical` for bugs/security, `warning` for maintainability or missed edge cases, `info` for style. Actionable suggestions only.
