---
format_version: "1"
id: T-14
title: Review-output JSON schema validation (enforced, with one retry)
priority: P0
status: done
depends_on: []
touches_paths:
  - plugins/kimi/scripts/lib/commands.mjs
  - plugins/kimi/schemas/review-output.schema.json
---

## Goal

`schemas/review-output.schema.json` exists but no code enforces it — validation is an instruction to the operator LLM. Enforce it in the broker for review/challenge dispatches.

## Scope

- New `lib/validate-review.mjs`: extract the JSON object from the final assistant message, validate against the schema contract (required `summary`; `findings[]` with severity enum info|warning|critical, file, line, message; hand-rolled, zero new deps), return `{ok, errors[], json}`.
- Foreground `runDispatch` for modes `review`/`challenge`: on validation failure, retry the dispatch ONCE with a correction note appended (previous errors listed); on second failure mark `meta.validation_failed: true` and return the raw output with a warning (exit 0 — a malformed review is still reported, never lost).
- Challenge mode's findings use `topic`/`alternative` instead of `file`/`line`/`suggestion` — validate against the challenge contract instead of forcing the review schema onto it.

## Success Criteria

1. Invalid review output triggers exactly one correction retry, then a flagged pass-through.
2. Tests: valid passes, invalid retries once (mocked invoke), challenge validated against its own contract.
3. `npm test` passes.

## Anti-patterns

- No ajv/dependency additions.
- Do not hard-fail the dispatch on malformed output — flag and deliver.

```bash
# Exit Check
cd /Users/luanmorenomaciel/GitHub/kimi-plugin-cc && npm test
```
