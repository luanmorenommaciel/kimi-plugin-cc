import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildKimiArgs, kimiSpawnEnv } from './kimi-cli.mjs';
import { estimateTranscriptCostUsd } from './telemetry.mjs';
import { signalGroup } from './kill.mjs';
import { touchedRecently, isRunning, reconcileDeadSession } from './state.mjs';

/**
 * Wrap the local Kimi Code 0.x `kimi` CLI with retry logic and JSONL capture.
 */

function getPluginRoot() {
  return process.env.KIMI_PLUGIN_DATA
    ? path.join(process.env.KIMI_PLUGIN_DATA)
    : path.join(process.env.HOME, '.kimi-plugin-cc');
}

/**
 * Invoke `kimi -p` (headless, stream-json) with structured output capture.
 *
 * @param {object} opts
 * @param {string} opts.prompt - fully composed prompt (role system prompt included)
 * @param {string} [opts.model]
 * @param {string} [opts.sessionId]
 * @param {string} [opts.cwd] - working directory for the kimi process (e.g. an isolated worktree). Defaults to process.cwd().
 * @param {string} [opts.outputFile] - where to write JSONL (defaults to session dir)
 * @returns {Promise<{sessionId: string, exitCode: number, retries: number, outputFile: string, finalMessage?: string}>}
 */
export async function invokeKimi(opts) {
  const sessionId = opts.sessionId || crypto.randomUUID();
  const sessDir = path.join(getPluginRoot(), 'sessions', sessionId);
  await mkdir(sessDir, { recursive: true });

  const cwd = opts.cwd || process.cwd();
  const outputFile = opts.outputFile || path.join(sessDir, 'output.jsonl');

  const args = buildKimiArgs({ prompt: opts.prompt, model: opts.model, resumeSessionId: opts.resumeSessionId });

  // Foreground: capture with retry on exit 75 (transient). Exit 75 is
  // EX_TEMPFAIL in the sysexits convention — the CLI uses it for transient
  // upstream failures (rate limit / overload / gateway hiccup) that may
  // succeed on a fresh attempt, unlike deterministic errors. A timeout
  // (124) is terminal — never retried, since a hung crank should fail fast,
  // not 3x.
  let exitCode = 0;
  let retries = 0;
  let timeoutReason = null;
  let stderrTail = '';
  const maxRetries = 3;
  const limits = { totalMs: opts.totalTimeoutMs, idleMs: opts.idleTimeoutMs, maxCostUsd: opts.maxCostUsd };

  while (true) {
    // Attempt 1 truncates the transcript; retries APPEND so a transient
    // failure's partial output is not lost from the record.
    const r = await runOnce(args, outputFile, cwd, limits, opts.effort, { append: retries > 0 });
    exitCode = r.code;
    timeoutReason = r.reason;
    stderrTail = r.stderrTail || '';
    if (exitCode !== 75 || retries >= maxRetries) break;
    retries++;
    // KIMI_RETRY_BACKOFF_MS overrides the backoff (tests must not wait real
    // seconds); unset → linear 5s/10s/15s.
    const backoffMs = Number(process.env.KIMI_RETRY_BACKOFF_MS || retries * 5000);
    await sleep(backoffMs);
  }

  const timedOut = exitCode === TIMEOUT_EXIT_CODE;
  const finalMessage = await extractFinalMessage(outputFile);
  const kimiSessionId = await extractKimiSessionId(outputFile);
  return { sessionId, exitCode, retries, outputFile, finalMessage, timedOut, timeoutReason, kimiSessionId, stderrTail };
}

export const TIMEOUT_EXIT_CODE = 124;

/**
 * Extract the real Kimi Code session id from a stream-json transcript.
 * 0.x ends each run with a {"role":"meta","type":"session.resume_hint",
 * "session_id":"session_..."} line — that id enables native `--session` resume.
 *
 * @param {string} outputFile - path to the JSONL transcript
 * @returns {Promise<string>} the kimi session id, or '' when not found
 */
export async function extractKimiSessionId(outputFile) {
  try {
    const data = await readFile(outputFile, 'utf-8');
    const lines = data.trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let obj;
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (obj.role === 'meta' && obj.type === 'session.resume_hint' && obj.session_id) {
        return obj.session_id;
      }
    }
  } catch {
    // ignore — no transcript (or unreadable) means no id
  }
  return '';
}

function runOnce(args, outputFile, cwd, limits = {}, effort, { append = false } = {}) {
  const totalMs = limits.totalMs ?? Number(process.env.KIMI_DISPATCH_TIMEOUT_MS || 30 * 60 * 1000);
  const idleMs = limits.idleMs ?? Number(process.env.KIMI_IDLE_TIMEOUT_MS || 5 * 60 * 1000);
  const maxCostUsd = limits.maxCostUsd ?? Number(process.env.KIMI_MAX_COST_USD || 0);

  return new Promise((resolve) => {
    const streamOpts = append ? { flags: 'a' } : undefined;
    const out = createWriteStream(outputFile, streamOpts);
    // Foreground stderr gets the same treatment as the background path:
    // piped to <sessDir>/kimi.log, with a small tail kept in memory so a
    // non-zero exit can surface a real diagnostic in meta.error.
    const logFile = path.join(path.dirname(outputFile), 'kimi.log');
    const errLog = createWriteStream(logFile, streamOpts);
    let stderrTail = '';
    // detached: the child becomes a process-group leader, so a watchdog
    // kill can signal the whole group (tool subprocesses included) instead
    // of orphaning them.
    const child = spawn('kimi', args, {
      cwd: cwd || process.cwd(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: kimiSpawnEnv({ effort }),
    });
    child.stdout.pipe(out);
    child.stderr.pipe(errLog);

    // Timer handles declared before finish() so a SYNCHRONOUS spawn error
    // (e.g. ENOENT — kimi binary missing) can't hit a temporal-dead-zone
    // ReferenceError when finish() clears them.
    let settled = false;
    let lastOutput = Date.now();
    let outBytes = 0;
    let killReason = null;
    let hardTimer = null;
    let idleTimer = null;
    let killTimer = null;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (idleTimer) clearInterval(idleTimer);
      if (killTimer) clearTimeout(killTimer);
      // Unpipe before ending: a kill fired inside a 'data' handler would
      // otherwise crash with ERR_STREAM_WRITE_AFTER_END on the next chunk.
      try { child.stdout.unpipe(out); } catch { /* never piped */ }
      try { child.stderr.unpipe(errLog); } catch { /* never piped */ }
      out.end();
      errLog.end();
      resolve({ code, reason: killReason, stderrTail });
    };

    // SIGTERM to the process GROUP, then SIGKILL after 2s. killTimer is
    // tracked so finish() clears it — no orphaned timer keeping the event
    // loop alive after resolve.
    const kill = (reason) => {
      if (killReason) return; // first cause wins
      killReason = reason;
      signalGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => { signalGroup(child.pid, 'SIGKILL'); }, 2000);
      killTimer.unref?.();
    };

    hardTimer = setTimeout(() => { kill('wall-clock'); finish(TIMEOUT_EXIT_CODE); }, totalMs);

    // Idle watchdog: kill if no new output for idleMs (a stalled/looping
    // crank). Also the --max-cost watchdog: kill when the rough live cost
    // estimate (transcript bytes → tokens at the output rate) crosses the
    // budget.
    child.stdout.on('data', (d) => {
      lastOutput = Date.now();
      outBytes += d.length;
      if (maxCostUsd > 0 && estimateTranscriptCostUsd(outBytes) >= maxCostUsd) {
        kill('max-cost');
        finish(TIMEOUT_EXIT_CODE);
      }
    });
    idleTimer = setInterval(async () => {
      if (Date.now() - lastOutput <= idleMs) return;
      // mtime liveness: a quiet long-running Shell tool (test suite, build)
      // emits no transcript bytes, but the CLI still touches its log/output
      // files — that is activity, not idleness.
      if (await touchedRecently([outputFile, logFile], idleMs)) {
        lastOutput = Date.now();
        return;
      }
      kill('idle');
      finish(TIMEOUT_EXIT_CODE);
    }, Math.min(idleMs, 30000));

    child.stderr.on('data', (d) => {
      stderrTail += d;
      // Keep only the tail — a long crank can spew MBs of stderr.
      if (stderrTail.length > 500) stderrTail = stderrTail.slice(-500);
      lastOutput = Date.now();
    });

    child.on('close', (code) => {
      finish(code ?? 1);
    });

    child.on('error', () => {
      finish(1);
    });
  });
}

async function extractFinalMessage(outputFile) {
  try {
    const data = await readFile(outputFile, 'utf-8');
    const lines = data.trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let obj;
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        continue; // one malformed line must not abort the scan
      }
      if (obj.role === 'assistant' && obj.content) {
        return obj.content;
      }
    }
  } catch {
    // ignore
  }
  return '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Watch a session's output.jsonl and emit progress events.
 *
 * @param {string} sessionId
 * @param {object} [opts]
 * @param {boolean} [opts.verbose=false]
 * @param {function} [opts.onEvent] - called with each progress line
 * @returns {Promise<{exitCode: number}>}
 */
export async function watchSession(sessionId, opts = {}) {
  const sessDir = path.join(getPluginRoot(), 'sessions', sessionId);
  const outputFile = path.join(sessDir, 'output.jsonl');
  const metaFile = path.join(sessDir, 'meta.json');

  let lastSize = 0;
  try {
    const s = await stat(outputFile);
    lastSize = s.size;
  } catch {
    lastSize = 0;
  }

  const emit = opts.onEvent || ((line) => console.log(line));

  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      let data;
      try {
        const s = await stat(outputFile);
        if (s.size <= lastSize) {
          // Check if session completed
          let meta;
          try {
            meta = JSON.parse(await readFile(metaFile, 'utf-8'));
          } catch {
            meta = null;
          }
          // Janitor: meta still says running but the supervisor pid is dead
          // → the session will never close on its own. Reconcile it
          // (marks interrupted + salvage-commit per policy) and exit.
          if (meta && ['running', 'pending'].includes(meta.status) && !(await isRunning(sessionId))) {
            meta = await reconcileDeadSession(sessionId, meta);
          }
          if (meta && ['completed', 'failed', 'cancelled', 'interrupted'].includes(meta.status)) {
            clearInterval(interval);
            emit(`[done] ${meta.status}${meta.commit_sha ? ' ' + meta.commit_sha : ''}`);
            resolve({ exitCode: meta.exit_code ?? 0 });
          }
          return;
        }

        data = await readFile(outputFile, 'utf-8');
      } catch {
        return;
      }

      const chunk = data.slice(lastSize);
      lastSize = data.length;

      const lines = chunk.split('\n').filter(Boolean);
      for (const line of lines) {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }

        if (obj.tool_calls && Array.isArray(obj.tool_calls)) {
          for (const tc of obj.tool_calls) {
            const name = tc.name || tc.function?.name || '';
            const args = tc.arguments || tc.args || {};
            if (name === 'ReadFile' || name === 'Read') {
              const p = args.path || '';
              emit(`[exploring] reading ${path.basename(p) || p}`);
            } else if (name === 'WriteFile' || name === 'Edit' || name === 'StrReplaceFile') {
              const p = args.path || '';
              emit(`[editing] ${path.basename(p) || p}`);
            } else if (name === 'Shell' || name === 'Bash') {
              const cmd = args.command || args.cmd || '';
              if (/eval_\d|eval\d/.test(cmd)) {
                const m = cmd.match(/eval[_-]?\w+/);
                emit(`[verifying] running ${m ? m[0] : 'eval'}`);
              }
            }
          }
        }

        if (opts.verbose && obj.role === 'assistant' && obj.think) {
          const think = obj.think.slice(0, 60).replace(/\n/g, ' ');
          emit(`[thinking] ${think}${obj.think.length > 60 ? '...' : ''}`);
        }
      }
    }, 1000);
  });
}
