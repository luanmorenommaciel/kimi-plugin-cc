---
description: Read-only codebase exploration and architecture analysis
---

Perform a structured, read-only analysis of this repository to answer: $ARGUMENTS

Process:

1. Scan root structure and key config files.
2. Identify the tech stack and frameworks.
3. Read the core modules needed to answer the question.
4. Check test coverage and documentation as relevant.
5. Assess code-health indicators.

Return a JSON object:

```json
{
  "summary": "One-paragraph answer to the question",
  "healthScore": 8,
  "techStack": { "Language": "...", "Framework": "..." },
  "insights": [
    { "type": "strength|concern|opportunity", "message": "..." }
  ],
  "architecture": {
    "layers": ["..."],
    "entryPoints": ["..."],
    "dataFlow": "..."
  }
}
```

Constraints: do not write or edit any files; do not run mutating shell commands. Read-only exploration only.
