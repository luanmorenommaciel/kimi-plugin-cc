import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { scanTextForSecrets } from './secrets.mjs';

/**
 * Wrap the local `kimi` CLI with retry logic and JSONL capture.
 */

function getPluginRoot() {
  return process.env.KIMI_PLUGIN_DATA
    ? path.join(process.env.KIMI_PLUGIN_DATA)
    : path.join(process.env.HOME, '.kimi-plugin-cc');
}

/**
 * Invoke kimi --print with structured output capture.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} opts.agentFile - absolute path to agent YAML
 * @param {string} [opts.model]
 * @param {string} [opts.sessionId]
 * @param {boolean} [opts.background=false]
 * @param {string} [opts.cwd] - working directory for the kimi process (e.g. an isolated worktree). Defaults to process.cwd().
 * @param {string} [opts.outputFile] - where to write JSONL (defaults to session dir)
 * @returns {Promise<{sessionId: string, exitCode: number, retries: number, outputFile: string, finalMessage?: string}>}
 */
export async function invokeKimi(opts) {
  // Refuse to ship a prompt carrying a credential to the provider (Moonshot/
  // Kimi is a third party). The assembled prompt includes review diffs and the
  // CLAUDE.md/AGENTS.md context preamble, which can contain secrets.
  const secretHits = scanTextForSecrets(opts.prompt);
  if (secretHits.length && !process.env.KIMI_ALLOW_SECRETS) {
    throw new Error(
      `refusing to send prompt to kimi: possible secret(s) detected — ${secretHits.join(', ')}. ` +
      'Remove them, or set KIMI_ALLOW_SECRETS=1 to override.'
    );
  }
  const sessionId = opts.sessionId || crypto.randomUUID();
  const sessDir = path.join(getPluginRoot(), 'sessions', sessionId);
  await mkdir(sessDir, { recursive: true });

  const cwd = opts.cwd || process.cwd();
  const outputFile = opts.outputFile || path.join(sessDir, 'output.jsonl');

  const args = [
    '--print',
    '--yolo',
    '--work-dir', cwd,
    '--output-format', 'stream-json',
    '--agent-file', opts.agentFile,
  ];
  if (opts.model) {
    args.push('--model', opts.model);
  }
  args.push('-p', opts.prompt);

  if (opts.background) {
    // Background: detach, write PID, return immediately
    const logFile = path.join(sessDir, 'kimi.log');
    const out = createWriteStream(outputFile);
    const err = createWriteStream(logFile);

    const child = spawn('kimi', args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(out);
    child.stderr.pipe(err);
    child.unref();

    // Write PID file
    const pidFile = path.join(sessDir, 'pid');
    await writeFile(pidFile, String(child.pid));

    return { sessionId, exitCode: null, retries: 0, outputFile, status: 'started', pid: child.pid };
  }

  // Foreground: capture with retry on exit 75 (transient). A timeout (124) is
  // terminal — never retried, since a hung crank should fail fast, not 3x.
  let exitCode = 0;
  let retries = 0;
  const maxRetries = 3;
  const limits = { totalMs: opts.totalTimeoutMs, idleMs: opts.idleTimeoutMs };

  while (true) {
    exitCode = await runOnce(args, outputFile, cwd, limits);
    if (exitCode !== 75 || retries >= maxRetries) break;
    retries++;
    await sleep(retries * 5000);
  }

  const timedOut = exitCode === TIMEOUT_EXIT_CODE;
  const finalMessage = await extractFinalMessage(outputFile);
  return { sessionId, exitCode, retries, outputFile, finalMessage, timedOut };
}

export const TIMEOUT_EXIT_CODE = 124;

function runOnce(args, outputFile, cwd, limits = {}) {
  const totalMs = limits.totalMs ?? Number(process.env.KIMI_DISPATCH_TIMEOUT_MS || 30 * 60 * 1000);
  const idleMs = limits.idleMs ?? Number(process.env.KIMI_IDLE_TIMEOUT_MS || 5 * 60 * 1000);

  return new Promise((resolve) => {
    const out = createWriteStream(outputFile);
    const child = spawn('kimi', args, {
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(out);

    // Timer handles declared before finish() so a SYNCHRONOUS spawn error
    // (e.g. ENOENT — kimi binary missing) can't hit a temporal-dead-zone
    // ReferenceError when finish() clears them.
    let settled = false;
    let lastOutput = Date.now();
    let hardTimer = null;
    let idleTimer = null;
    let killTimer = null;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (idleTimer) clearInterval(idleTimer);
      if (killTimer) clearTimeout(killTimer);
      out.end();
      resolve(code);
    };

    // SIGTERM, then SIGKILL after 2s. killTimer is tracked so finish() clears
    // it — no orphaned timer keeping the event loop alive after resolve.
    const kill = () => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 2000);
      killTimer.unref?.();
    };

    hardTimer = setTimeout(() => { kill(); finish(TIMEOUT_EXIT_CODE); }, totalMs);

    // Idle watchdog: kill if no new output for idleMs (a stalled/looping crank).
    child.stdout.on('data', () => { lastOutput = Date.now(); });
    idleTimer = setInterval(() => {
      if (Date.now() - lastOutput > idleMs) { kill(); finish(TIMEOUT_EXIT_CODE); }
    }, Math.min(idleMs, 30000));

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; lastOutput = Date.now(); });

    child.on('close', (code) => {
      // kimi --print uses exit code 75 for transient errors
      finish(code ?? 1);
    });

    child.on('error', () => {
      finish(1);
    });
  });
}

async function extractFinalMessage(outputFile) {
  try {
    const { readFile } = await import('node:fs/promises');
    const data = await readFile(outputFile, 'utf-8');
    const lines = data.trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const obj = JSON.parse(lines[i]);
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
          if (meta && ['completed', 'failed', 'cancelled'].includes(meta.status)) {
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
