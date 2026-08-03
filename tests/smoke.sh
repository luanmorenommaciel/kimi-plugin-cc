#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BROKER="node ${PLUGIN_DIR}/plugins/kimi/scripts/broker.mjs"
FIXTURE="${PLUGIN_DIR}/tests/fixtures/test-fixture.md"
TMP_WORKDIR="$(mktemp -d)"

# Cleanup trap
cleanup() {
  rm -rf "$TMP_WORKDIR"
}
trap cleanup EXIT

cd "$TMP_WORKDIR"
git init -q

echo "=== kimi-plugin-cc smoke test (v0.2.0) ==="
echo "Working in: $TMP_WORKDIR"

# --- Test 1: broker dispatch foreground with explore agent (read-only) ---
echo "--- Test 1: explore agent (read-only) ---"
RESULT="$($BROKER dispatch \
  --prompt "List all files in the current directory" \
  --role explore \
  --mode explore 2>&1)" || true

SESSION_ID="$(echo "$RESULT" | python3 -c 'import sys,json; print(json.loads(sys.stdin.read()).get("sessionId",""))' 2>/dev/null || true)"
EXIT_CODE="$(echo "$RESULT" | python3 -c 'import sys,json; print(json.loads(sys.stdin.read()).get("exitCode",""))' 2>/dev/null || true)"

if [[ -z "$SESSION_ID" ]]; then
  echo "FAIL: No session ID returned"
  echo "$RESULT"
  exit 1
fi

echo "Session ID: $SESSION_ID"
echo "Exit code: $EXIT_CODE"

if [[ "$EXIT_CODE" != "0" ]]; then
  echo "FAIL: Non-zero exit code from explore dispatch"
  exit 1
fi

# --- Test 2: broker dispatch foreground with coder agent (write) ---
echo "--- Test 2: coder agent (write) ---"
TASK_CONTENT="$(cat "$FIXTURE")"
RESULT2="$($BROKER dispatch \
  --prompt "$TASK_CONTENT" \
  --role coder \
  --mode crank 2>&1)" || true

SESSION_ID2="$(echo "$RESULT2" | python3 -c 'import sys,json; print(json.loads(sys.stdin.read()).get("sessionId",""))' 2>/dev/null || true)"
EXIT_CODE2="$(echo "$RESULT2" | python3 -c 'import sys,json; print(json.loads(sys.stdin.read()).get("exitCode",""))' 2>/dev/null || true)"

echo "Session ID: $SESSION_ID2"
echo "Exit code: $EXIT_CODE2"

if [[ "$EXIT_CODE2" != "0" ]]; then
  echo "FAIL: Non-zero exit code from coder dispatch"
  echo "$RESULT2"
  exit 1
fi

# Verify file was created
if [[ ! -f "${TMP_WORKDIR}/hello-from-kimi.txt" ]]; then
  echo "FAIL: Expected hello-from-kimi.txt was not created"
  exit 1
fi

FILE_CONTENT="$(cat "${TMP_WORKDIR}/hello-from-kimi.txt")"
if [[ "$FILE_CONTENT" != "Hello from Kimi headless mode!" ]]; then
  echo "FAIL: File content mismatch"
  echo "Got: $FILE_CONTENT"
  exit 1
fi

echo "File created and content verified."

# --- Test 3: diff capture ---
echo "--- Test 3: diff capture ---"
DC_SID="diff-test-$$"
$BROKER diff-capture --session-id "$DC_SID" --phase pre
$BROKER diff-capture --session-id "$DC_SID" --phase post
if [[ -f "${HOME}/.kimi-plugin-cc/sessions/${DC_SID}/pre.diff" && -f "${HOME}/.kimi-plugin-cc/sessions/${DC_SID}/post.diff" ]]; then
  echo "Diff capture OK"
else
  echo "FAIL: diff files missing"
  exit 1
fi

# Cleanup diff session
rm -rf "${HOME}/.kimi-plugin-cc/sessions/${DC_SID}"

# --- Test 4: status and result ---
echo "--- Test 4: status and result ---"
STATUS_OUT="$($BROKER status --session-id "$SESSION_ID2" 2>&1)"
echo "Status: $STATUS_OUT"

RESULT_OUT="$($BROKER result --session-id "$SESSION_ID2" 2>&1)"
echo "Result preview: $(echo "$RESULT_OUT" | head -c 100)..."

# --- Test 5: latest-session tracking ---
echo "--- Test 5: latest-session ---"
LATEST="$($BROKER latest-session 2>&1)"
echo "Latest session: $LATEST"

# --- Test 6: schema validation ---
echo "--- Test 6: schema exists ---"
if [[ -f "${PLUGIN_DIR}/plugins/kimi/schemas/review-output.schema.json" ]]; then
  echo "Schema OK"
else
  echo "FAIL: schema missing"
  exit 1
fi

# --- Test 7: hooks exist ---
echo "--- Test 7: hooks exist ---"
if [[ -f "${PLUGIN_DIR}/plugins/kimi/hooks/hooks.json" ]]; then
  echo "Hooks OK"
else
  echo "FAIL: hooks missing"
  exit 1
fi

# --- Test 8: prompts exist ---
echo "--- Test 8: prompts exist ---"
for p in review challenge explore; do
  if [[ -f "${PLUGIN_DIR}/plugins/kimi/prompts/${p}.md" ]]; then
    echo "Prompt $p OK"
  else
    echo "FAIL: prompt $p missing"
    exit 1
  fi
done

# --- Test 9: skills exist ---
echo "--- Test 9: skills exist ---"
for s in kimi-cli-runtime kimi-result-handling; do
  if [[ -f "${PLUGIN_DIR}/plugins/kimi/skills/${s}/SKILL.md" ]]; then
    echo "Skill $s OK"
  else
    echo "FAIL: skill $s missing"
    exit 1
  fi
done

echo ""
echo "==================================="
echo "Plugin smoke test PASSED (v0.2.0)"
echo "==================================="
