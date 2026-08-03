#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Stop-hook command for the Kimi review gate.
 *
 * Claude Code invokes this with the Stop event payload on stdin. We take the
 * last assistant message from the transcript, ask Kimi (headless, read-only,
 * low effort) whether it contains a critical issue, and emit a block decision
 * when it does. ANY failure is fail-open (exit 0, no output) — the gate must
 * never deadlock a session.
 */

const TIMEOUT_MS = Number(process.env.KIMI_REVIEW_GATE_TIMEOUT_MS || 150000);
const MAX_CONSECUTIVE_BLOCKS = Number(process.env.KIMI_REVIEW_GATE_MAX_BLOCKS || 3);
const MAX_REVIEW_CHARS = 6000;

// Kimi Code 0.x cannot enforce read-only at the tool level in headless mode,
// so the constraint is binding on behavior via the prompt (see roles/explore.md).
const READ_ONLY_PREAMBLE = 'You are read-only: do not modify files, run mutating commands, or start subagents. Inspect and report only.';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_FILE = path.join(here, '..', 'prompts', 'review-gate.md');

async function main() {
  const payload = JSON.parse(await readStdin());
  // Loop safeguard: never re-fire on a stop this hook itself caused.
  if (payload.stop_hook_active) process.exit(0);

  const responseText = await lastAssistantText(payload.transcript_path);
  if (!responseText) process.exit(0);

  const gatePrompt = await readFile(PROMPT_FILE, 'utf-8');
  const prompt = `${READ_ONLY_PREAMBLE}\n\n${gatePrompt.trim()}\n\n---\n\nReview the following proposed response:\n\n${responseText.slice(0, MAX_REVIEW_CHARS)}`;

  const finalText = await runKimi(prompt);
  const verdict = parseVerdict(finalText);
  if (!verdict?.block) {
    await resetBlockCounter(payload.session_id); // any pass clears the streak
    process.exit(0);
  }

  // Circuit breaker: after MAX_CONSECUTIVE_BLOCKS consecutive blocks for the
  // same Claude session, allow the stop — a stuck gate must never deadlock.
  const blocks = await readBlockCounter(payload.session_id);
  if (blocks >= MAX_CONSECUTIVE_BLOCKS) {
    console.error(`Kimi review gate: circuit breaker tripped after ${blocks} consecutive blocks — allowing stop.`);
    process.exit(0);
  }
  await writeBlockCounter(payload.session_id, blocks + 1);
  // Claude Code Stop-hook decision protocol.
  console.log(JSON.stringify({
    decision: 'block',
    reason: `Kimi review gate: ${verdict.reason || 'critical issue found'}`,
  }));
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data || '{}'));
    process.stdin.on('error', () => resolve('{}'));
  });
}

/** Extract the last assistant text from a Claude Code transcript (JSONL). */
async function lastAssistantText(transcriptPath) {
  if (!transcriptPath) return '';
  let data;
  try {
    data = await readFile(transcriptPath, 'utf-8');
  } catch {
    return '';
  }
  const lines = data.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const content = obj.message?.content ?? obj.content;
    const role = obj.message?.role ?? obj.role ?? obj.type;
    if (role !== 'assistant') continue;
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) {
      const text = content
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

/** Consecutive-block counter, persisted per Claude session in the plugin data dir. */
function counterFile(sessionId) {
  const root = process.env.KIMI_PLUGIN_DATA || path.join(process.env.HOME, '.kimi-plugin-cc');
  const key = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(root, 'review-gate', `${key}.json`);
}

async function readBlockCounter(sessionId) {
  try {
    const data = JSON.parse(await readFile(counterFile(sessionId), 'utf-8'));
    return Number(data.blocks) || 0;
  } catch {
    return 0;
  }
}

async function writeBlockCounter(sessionId, blocks) {
  try {
    const file = counterFile(sessionId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ blocks }));
  } catch { /* fail-open */ }
}

async function resetBlockCounter(sessionId) {
  try {
    await rm(counterFile(sessionId), { force: true });
  } catch { /* fail-open */ }
}

function runKimi(prompt) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'stream-json'];
    if (process.env.KIMI_REVIEW_GATE_MODEL) args.push('--model', process.env.KIMI_REVIEW_GATE_MODEL);
    const child = spawn('kimi', args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...process.env,
        // Gate calls should be cheap and fast; a user-set effort wins.
        KIMI_MODEL_THINKING_EFFORT: process.env.KIMI_MODEL_THINKING_EFFORT || 'low',
      },
    });
    let out = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      resolve('');
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      clearTimeout(timer);
      // Last assistant message in the JSONL stream is the gate's answer.
      let finalText = '';
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.role === 'assistant' && typeof obj.content === 'string') finalText = obj.content;
        } catch { /* skip */ }
      }
      resolve(finalText);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
  });
}

function parseVerdict(text) {
  if (!text) return null;
  const m = text.match(/\{[^{}]*"block"[^{}]*\}/s);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

main().catch(() => process.exit(0)); // fail-open, always
