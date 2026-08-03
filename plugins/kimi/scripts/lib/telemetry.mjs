import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { warn } from './warn.mjs';

const DEFAULT_COST_PER_1M_INPUT = Number(process.env.KIMI_COST_PER_1M_INPUT || 0.5);
const DEFAULT_COST_PER_1M_OUTPUT = Number(process.env.KIMI_COST_PER_1M_OUTPUT || 2.0);
const DEFAULT_COST_PER_1M_CACHED = Number(process.env.KIMI_COST_PER_1M_CACHED || 0.1);

/**
 * Cost in USD for a token mix, at the configured KIMI_COST_PER_1M_* rates.
 */
export function estimateCostUsd(promptTokens, completionTokens, cachedTokens = 0) {
  return ((promptTokens - cachedTokens) / 1_000_000) * DEFAULT_COST_PER_1M_INPUT +
    (completionTokens / 1_000_000) * DEFAULT_COST_PER_1M_OUTPUT +
    (cachedTokens / 1_000_000) * DEFAULT_COST_PER_1M_CACHED;
}

/**
 * Rough live-cost estimate for a RUNNING crank from its transcript size in
 * bytes (chars/4 → tokens at the output rate). Used by the --max-cost
 * watchdog; real input costs are typically higher, so caps need headroom.
 * Post-run telemetry with real usage reconciles the accounting.
 */
export function estimateTranscriptCostUsd(transcriptBytes) {
  return ((transcriptBytes / 4) / 1_000_000) * DEFAULT_COST_PER_1M_OUTPUT;
}

const READ_TOOLS = new Set(['ReadFile', 'Read', 'Grep', 'Glob', 'LS', 'ListFiles']);
const WRITE_TOOLS = new Set(['WriteFile', 'Edit', 'StrReplaceFile', 'CreateFile', 'ApplyPatch']);

function textLen(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((n, part) => {
      if (typeof part === 'string') return n + part.length;
      if (part && typeof part.text === 'string') return n + part.text.length;
      if (part && typeof part.think === 'string') return n + part.think.length;
      return n;
    }, 0);
  }
  return 0;
}

/**
 * Parse an output.jsonl file and return a telemetry rollup.
 *
 * Kimi's stream-json transcript contains NO token-usage field — each line is
 * only `{role, content, tool_calls|tool_call_id}`. (Real usage lives in the
 * Kimi Code session's wire.jsonl; see parseWireUsage.) Token counts here are
 * therefore ESTIMATED from content length (~4 chars/token) and flagged
 * `estimated: true` so the supervisor is never misled that they are exact.
 * Phases are derived from the ordering of real tool calls (read/grep → exploration,
 * write/edit → implementation, eval/test shell → verification).
 *
 * @param {string} outputFile - path to output.jsonl
 * @returns {Promise<{prompt_tokens:number, completion_tokens:number, cached_tokens:number, estimated:boolean, estimated_cost_usd:number, tool_calls:{read:number,write:number,verify:number}, phases:{exploration_sec:number, implementation_sec:number, verification_sec:number}}>}
 */
export async function parseTelemetry(outputFile) {
  let inputChars = 0;
  let outputChars = 0;
  const order = [];

  let data;
  try {
    data = await readFile(outputFile, 'utf-8');
  } catch (e) {
    await warn('telemetry', e, 'warning');
    return null;
  }

  const lines = data.trim().split('\n').filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    const len = textLen(obj.content);
    if (obj.role === 'assistant') outputChars += len;
    else inputChars += len;

    if (Array.isArray(obj.tool_calls)) {
      for (const tc of obj.tool_calls) {
        const name = tc.function?.name || tc.name || '';
        if (READ_TOOLS.has(name)) {
          order.push('read');
        } else if (WRITE_TOOLS.has(name)) {
          order.push('write');
        } else if (name === 'Shell' || name === 'Bash') {
          const rawArgs = tc.function?.arguments ?? tc.arguments ?? '';
          const cmd = typeof rawArgs === 'string' ? rawArgs : (rawArgs.command || rawArgs.cmd || '');
          order.push(/eval_?\d|eval\b|pytest|\btest\b|--test/.test(cmd) ? 'verify' : 'write');
        }
      }
    }
  }

  const promptTokens = Math.round(inputChars / 4);
  const completionTokens = Math.round(outputChars / 4);
  const cachedTokens = 0;

  const inputCost = (promptTokens / 1_000_000) * DEFAULT_COST_PER_1M_INPUT;
  const outputCost = (completionTokens / 1_000_000) * DEFAULT_COST_PER_1M_OUTPUT;
  const cachedCost = (cachedTokens / 1_000_000) * DEFAULT_COST_PER_1M_CACHED;
  const estimatedCost = inputCost + outputCost + cachedCost;

  const counts = { read: 0, write: 0, verify: 0 };
  for (const p of order) counts[p]++;
  const total = order.length || 1;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    cached_tokens: cachedTokens,
    estimated: true,
    estimated_cost_usd: Math.round(estimatedCost * 10000) / 10000,
    tool_calls: counts,
    phases: phaseSeconds(counts, total),
  };
}

/**
 * Apportion phase wall-clock from tool-call counts. Kimi emits no per-event
 * timestamps, so phases are weighted by how many read/write/verify tool calls
 * fired. The absolute duration is unknown at parse time; attachTelemetry scales
 * this against meta.started_at..finished_at when both are present.
 */
function phaseSeconds(counts, total) {
  return {
    exploration_sec: counts.read,
    implementation_sec: counts.write,
    verification_sec: counts.verify,
  };
}

/**
 * Parse REAL token usage from a Kimi Code 0.x session's wire.jsonl files.
 *
 * 0.x persists every session under
 * `<KIMI_CODE_HOME>/sessions/<workDirKey>/<sessionId>/agents/<agent>/wire.jsonl`
 * and records `{"type":"usage.record","usage":{inputOther,output,inputCacheRead,
 * inputCacheCreation}}` events — the exact token accounting the stream-json
 * transcript lacks. The workDirKey encoding is an internal detail, so the
 * session is located by scanning for the session-id directory instead.
 *
 * @param {string} kimiSessionId - the `session_...` id captured from stream-json
 * @param {object} [opts]
 * @param {string} [opts.kimiCodeHome] - defaults to $KIMI_CODE_HOME or ~/.kimi-code
 * @returns {Promise<null|{prompt_tokens:number, completion_tokens:number, cached_tokens:number, records:number}>}
 */
export async function parseWireUsage(kimiSessionId, opts = {}) {
  if (!kimiSessionId) return null;
  const home = opts.kimiCodeHome || process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');

  // Locate <home>/sessions/*/<kimiSessionId>/agents/*/wire.jsonl
  const wireFiles = [];
  let workDirs;
  try {
    workDirs = await readdir(path.join(home, 'sessions'));
  } catch {
    return null;
  }
  for (const wd of workDirs) {
    let agents;
    try {
      agents = await readdir(path.join(home, 'sessions', wd, kimiSessionId, 'agents'));
    } catch {
      continue; // session not under this workdir
    }
    for (const agent of agents) {
      wireFiles.push(path.join(home, 'sessions', wd, kimiSessionId, 'agents', agent, 'wire.jsonl'));
    }
  }
  if (wireFiles.length === 0) return null;

  let input = 0;
  let output = 0;
  let cached = 0;
  let records = 0;
  for (const file of wireFiles) {
    let data;
    try {
      data = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    for (const line of data.split('\n')) {
      if (!line.includes('"usage.record"')) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.type !== 'usage.record' || !obj.usage) continue;
      const u = obj.usage;
      input += (u.inputOther || 0) + (u.inputCacheRead || 0) + (u.inputCacheCreation || 0);
      output += u.output || 0;
      cached += u.inputCacheRead || 0;
      records++;
    }
  }
  if (records === 0) return null;
  return { prompt_tokens: input, completion_tokens: output, cached_tokens: cached, records };
}

/**
 * Attach telemetry to a session's meta.json.
 *
 * @param {string} sessionId
 * @param {string} sessionsDir
 */
export async function attachTelemetry(sessionId, sessionsDir) {
  const outputFile = path.join(sessionsDir, sessionId, 'output.jsonl');
  const metaFile = path.join(sessionsDir, sessionId, 'meta.json');

  const telemetry = await parseTelemetry(outputFile);
  if (!telemetry) return;

  let meta;
  try {
    meta = JSON.parse(await readFile(metaFile, 'utf-8'));
  } catch (e) {
    await warn('telemetry', e, 'warning');
    return;
  }

  // Prefer REAL token usage from the Kimi Code session's wire.jsonl (available
  // since 0.x) over the chars/4 estimate. Telemetry is best-effort: any failure
  // here just keeps the estimate.
  if (meta.kimi_session_id) {
    try {
      const real = await parseWireUsage(meta.kimi_session_id);
      if (real) {
        telemetry.prompt_tokens = real.prompt_tokens;
        telemetry.completion_tokens = real.completion_tokens;
        telemetry.cached_tokens = real.cached_tokens;
        telemetry.estimated = false;
        telemetry.usage_records = real.records;
        telemetry.estimated_cost_usd = Math.round(
          (((real.prompt_tokens - real.cached_tokens) / 1_000_000) * DEFAULT_COST_PER_1M_INPUT +
            (real.completion_tokens / 1_000_000) * DEFAULT_COST_PER_1M_OUTPUT +
            (real.cached_tokens / 1_000_000) * DEFAULT_COST_PER_1M_CACHED) * 10000
        ) / 10000;
      }
    } catch (e) {
      await warn('telemetry', e, 'info');
    }
  }

  // Scale the count-weighted phases into real wall-clock seconds using the
  // session's actual elapsed time (started_at..finished_at), apportioned by
  // tool-call mix. Falls back to the raw counts when timestamps are absent.
  if (meta.started_at && meta.finished_at) {
    const elapsed = Math.max(0, (new Date(meta.finished_at) - new Date(meta.started_at)) / 1000);
    const p = telemetry.phases;
    const sum = p.exploration_sec + p.implementation_sec + p.verification_sec;
    if (sum > 0 && elapsed > 0) {
      telemetry.phases = {
        exploration_sec: Math.round((p.exploration_sec / sum) * elapsed),
        implementation_sec: Math.round((p.implementation_sec / sum) * elapsed),
        verification_sec: Math.round((p.verification_sec / sum) * elapsed),
      };
      telemetry.elapsed_sec = Math.round(elapsed);
    }
  }

  meta.telemetry = telemetry;
  await writeFile(metaFile, JSON.stringify(meta, null, 2));
}
