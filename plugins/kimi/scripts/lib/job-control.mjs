import { spawn } from 'node:child_process';
import { createWriteStream, openSync, closeSync } from 'node:fs';
import { writeFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { findRepoRoot, writeRepoSession } from './workspace.mjs';
import { attachTelemetry, estimateTranscriptCostUsd } from './telemetry.mjs';
import { warn } from './warn.mjs';
import { updateMeta, readMeta, safeUpdateMeta, touchedRecently } from './state.mjs';
import { commitWork } from './commit.mjs';
import { buildKimiArgs, kimiSpawnEnv } from './kimi-cli.mjs';
import { extractKimiSessionId } from './kimi.mjs';
import { notifyCompletion } from './notify.mjs';
import { updateTaskStatus } from './orchestrate.mjs';
import { signalGroup } from './kill.mjs';

// Tuning env var each timeout reason is controlled by — surfaced in meta so
// /kimi:status tells the operator which knob to turn, not just "timed out".
const TIMEOUT_TUNING = {
  'idle-timeout': 'KIMI_IDLE_TIMEOUT_MS',
  'wall-clock-timeout': 'KIMI_DISPATCH_TIMEOUT_MS',
  'max-cost': 'KIMI_MAX_COST_USD',
};

// Statuses a session never leaves — cancel and the close handler must not
// downgrade these.
const TERMINAL_STATUSES = new Set(['cancelled', 'completed', 'failed', 'interrupted']);

function getPluginRoot() {
  return process.env.KIMI_PLUGIN_DATA
    ? path.join(process.env.KIMI_PLUGIN_DATA)
    : path.join(process.env.HOME, '.kimi-plugin-cc');
}

export function getSessionsDir() {
  return path.join(getPluginRoot(), 'sessions');
}

/**
 * Spawn the detached supervisor for a background session and return
 * IMMEDIATELY. The supervisor is a re-exec of this same broker
 * (`broker.mjs supervise --session-id <id>`) so all dispatch logic is
 * reused; it stays alive for the whole crank and runs the close-handler
 * duties (terminal status, auto-commit, telemetry).
 *
 * stdio goes to FILE DESCRIPTORS on the session's output/log files — never
 * pipes. A pipe back to this (calling) process would keep the caller alive
 * as an accidental supervisor for the whole crank, and the caller's death
 * would then orphan the session (meta stuck at running, kimi child dies of
 * EPIPE on its next write).
 *
 * The pid file records "<supervisorPid> <epoch_ms>" — reconciliation
 * (state.mjs) treats a dead supervisor pid as proof the session died.
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.repoPath
 * @returns {Promise<{sessionId: string, status: 'started', pid: number}>}
 */
export async function spawnSupervisor({ sessionId, repoPath }) {
  const sessDir = path.join(getSessionsDir(), sessionId);
  await mkdir(sessDir, { recursive: true });

  const outFd = openSync(path.join(sessDir, 'output.jsonl'), 'a');
  const errFd = openSync(path.join(sessDir, 'kimi.log'), 'a');
  let child;
  try {
    const brokerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'broker.mjs');
    child = spawn(process.execPath, [brokerPath, 'supervise', '--session-id', sessionId], {
      cwd: repoPath || process.cwd(),
      detached: true,
      stdio: ['ignore', outFd, errFd],
      env: process.env,
    });
    child.unref();
  } finally {
    // Parent must not hold the fds open — only the supervisor owns them now.
    closeSync(outFd);
    closeSync(errFd);
  }

  await writeFile(path.join(sessDir, 'pid'), `${child.pid} ${Date.now()}`);
  if (repoPath) await writeRepoSession(repoPath, sessionId);
  return { sessionId, status: 'started', pid: child.pid };
}

export async function startBackground(opts) {
  const sessionId = opts.sessionId || crypto.randomUUID();
  const sessDir = path.join(getSessionsDir(), sessionId);
  await mkdir(sessDir, { recursive: true });

  const repoPath = opts.repoPath || await findRepoRoot();

  const meta = {
    session_id: sessionId,
    role: opts.role || '',
    prompt: opts.prompt,
    model: opts.model || '',
    effort: opts.effort || '',
    started_at: new Date().toISOString(),
    status: 'running',
    repo_path: repoPath,
    mode: opts.mode || 'crank',
    auto_commit_policy: opts.autoCommitPolicy || 'on-clean',
    tag: opts.tag || '',
    task_path: opts.taskPath || '',
    touches_paths: opts.touchesPaths || [],
    baseline_sha: opts.baselineSha || '',
  };
  // Merge (never blind-overwrite): the dispatcher already wrote the full
  // envelope — including fields this function doesn't know about
  // (resume_session_id, max_cost_usd, effort_source).
  await safeUpdateMeta(sessionId, meta);

  const args = buildKimiArgs({ prompt: opts.prompt, model: opts.model, resumeSessionId: opts.resumeSessionId });

  const outFile = path.join(sessDir, 'output.jsonl');
  const logFile = path.join(sessDir, 'kimi.log');
  const out = createWriteStream(outFile);
  const err = createWriteStream(logFile);

  const spawnFn = opts.spawnFn || spawn;
  const child = spawnFn('kimi', args, {
    cwd: repoPath,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: kimiSpawnEnv({ effort: opts.effort }),
  });
  child.stdout.pipe(out);
  child.stderr.pipe(err);
  child.unref();

  // kimi.pid records the crank's own pid (a process-group leader — the
  // child is detached). The session's main `pid` file belongs to the
  // SUPERVISOR (written by spawnSupervisor); cancel kills both groups.
  await writeFile(path.join(sessDir, 'kimi.pid'), String(child.pid));

  // Idle-output watchdog AND hard wall-clock cap for the detached background
  // crank (same two limits as the foreground path): if no new output for
  // KIMI_IDLE_TIMEOUT_MS (default 5m), or total runtime exceeds
  // KIMI_DISPATCH_TIMEOUT_MS (default 30m), the crank's process GROUP is
  // killed — SIGTERM, SIGKILL after 2s — and the close handler marks it
  // failed:timeout. (Skipped for injected spawnFn in tests, which has no
  // real pid.)
  const idleMs = Number(process.env.KIMI_IDLE_TIMEOUT_MS || 5 * 60 * 1000);
  const hardMs = Number(process.env.KIMI_DISPATCH_TIMEOUT_MS || 30 * 60 * 1000);
  const maxCostUsd = Number(opts.maxCostUsd ?? process.env.KIMI_MAX_COST_USD ?? 0);
  if (!opts.spawnFn && child.pid) {
    let lastOutput = Date.now();
    child.stdout.on('data', () => { lastOutput = Date.now(); });
    child.stderr.on('data', () => { lastOutput = Date.now(); });

    let fired = false;
    const killStuck = (reason) => {
      if (fired) return;
      fired = true;
      // Group-first: the detached child is a group leader; its tool
      // subprocesses (test suites, builds) must die with it.
      signalGroup(child.pid, 'SIGTERM');
      const t = setTimeout(() => { signalGroup(child.pid, 'SIGKILL'); }, 2000);
      t.unref?.();
      updateMeta(sessionId, {
        timed_out: true,
        reason,
        hint: `${reason} — raise ${TIMEOUT_TUNING[reason] || 'KIMI_IDLE_TIMEOUT_MS'} to allow longer cranks`,
      }).catch(() => {});
    };

    const idleTimer = setInterval(async () => {
      // mtime liveness: a quiet long-running Shell tool emits no transcript
      // bytes but the CLI still touches its log/output files — that is
      // activity too, not idleness.
      if (Date.now() - lastOutput > idleMs && !(await touchedRecently([outFile, logFile], idleMs))) {
        killStuck('idle-timeout');
        return;
      }
      // --max-cost watchdog: rough live estimate from transcript growth.
      if (maxCostUsd > 0) {
        try {
          const s = await stat(outFile);
          if (estimateTranscriptCostUsd(s.size) >= maxCostUsd) killStuck('max-cost');
        } catch { /* transcript not readable this tick — next tick retries */ }
      }
    }, Math.min(idleMs, 30000));
    idleTimer.unref?.();

    const hardTimer = setTimeout(() => {
      killStuck('wall-clock-timeout');
    }, hardMs);
    hardTimer.unref?.();

    child.on('close', () => {
      clearInterval(idleTimer);
      clearTimeout(hardTimer);
    });
  }

  // Track as latest session for this repo
  await writeRepoSession(repoPath, sessionId);

  // Watch for completion and update meta + telemetry.
  // updateMeta preserves the 12 initial-write fields (session_id, role,
  // prompt, model, started_at, repo_path, mode, auto_commit_policy, tag,
  // touches_paths, baseline_sha) by reading-then-merging.
  child.on('close', async (code) => {
    try {
      // Never downgrade a terminal status written by someone else (e.g.
      // cancelSession's 'cancelled') — the close event races with cancel.
      const current = await readMeta(sessionId).catch(() => null);
      if (!current || !TERMINAL_STATUSES.has(current.status)) {
        await updateMeta(sessionId, {
          status: code === 0 ? 'completed' : 'failed',
          exit_code: code ?? 1,
          finished_at: new Date().toISOString(),
        });
      }
      try {
        const m = await readMeta(sessionId);
        const c = await commitWork(repoPath, sessionId, m, { exitCode: code ?? 1, retries: 0 });
        await updateMeta(sessionId, { committed: c.committed, commit_sha: c.commit_sha, commit_reason: c.reason });
      } catch (e) {
        await warn('commit', e, 'warning', repoPath);
      }
      // Capture the real Kimi Code session id for native --session resume.
      const kimiSessionId = await extractKimiSessionId(outFile);
      if (kimiSessionId) {
        await updateMeta(sessionId, { kimi_session_id: kimiSessionId });
      }
      await attachTelemetry(sessionId, getSessionsDir());
      // Task-status transition for background cranks (mirrors runDispatch).
      try {
        const done = await readMeta(sessionId);
        if (done.task_path) {
          await updateTaskStatus(done.task_path, done.status === 'completed' ? 'completed' : 'failed');
        }
      } catch (e) {
        await warn('task-status', e, 'info', repoPath);
      }
      // Desktop notification (best-effort; never affects session state).
      try {
        const done = await readMeta(sessionId);
        await notifyCompletion(
          `kimi ${done.mode || 'crank'} ${done.status}`,
          `${sessionId.slice(0, 8)} — ${done.repo_path || ''}`
        );
      } catch { /* notify must never fail the close handler */ }
    } catch (e) {
      await warn('job-control', e, 'error', repoPath);
    }
  });

  return { sessionId, status: 'started', pid: child.pid };
}

export async function cancelSession(sessionId) {
  const sessionsDir = getSessionsDir();
  const sessDir = path.join(sessionsDir, sessionId);
  // A session that already reached a terminal status must not be
  // "cancelled" — there is nothing to kill and downgrading its recorded
  // outcome (e.g. completed → cancelled) would falsify reports.
  try {
    const meta = JSON.parse(await readFile(path.join(sessDir, 'meta.json'), 'utf-8'));
    if (TERMINAL_STATUSES.has(meta.status)) {
      return { sessionId, status: meta.status, already_terminal: true };
    }
  } catch {
    // meta missing/unreadable — fall through and best-effort cancel
  }
  // New-format sessions have TWO pids: kimi.pid (the crank, a process-group
  // leader) and pid (the detached supervisor). Legacy sessions have only
  // pid, holding the crank itself. Kill every group we can identify —
  // group-first so tool subprocesses die with their leader.
  const pids = [];
  for (const f of ['kimi.pid', 'pid']) {
    try {
      const raw = (await readFile(path.join(sessDir, f), 'utf-8')).trim();
      const pid = parseInt(raw.split(/\s+/)[0], 10);
      if (Number.isInteger(pid) && pid > 0) pids.push(pid);
    } catch {
      // no such pid file
    }
  }
  for (const pid of pids) signalGroup(pid, 'SIGTERM');
  await new Promise((r) => setTimeout(r, 1000));
  for (const pid of pids) signalGroup(pid, 'SIGKILL');

  // Checkpoint: stash touched files if any
  await stashCheckpoint(sessionId);

  let repoPath;
  try {
    repoPath = (await readMeta(sessionId)).repo_path;
  } catch { /* meta unreadable — warn falls back to cwd */ }

  try {
    await updateMeta(sessionId, {
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
    });
  } catch (e) {
    await warn('job-control', e, 'error', repoPath);
  }

  return { sessionId, status: 'cancelled' };
}

async function stashCheckpoint(sessionId) {
  const sessionsDir = getSessionsDir();
  let meta;
  try {
    meta = JSON.parse(await readFile(path.join(sessionsDir, sessionId, 'meta.json'), 'utf-8'));
  } catch (e) {
    await warn('job-control', e, 'warning');
    return;
  }
  const repoPath = meta.repo_path;
  const touches = meta.touches_paths || [];
  if (!repoPath || touches.length === 0) return;

  const checkpointDir = path.join(repoPath, '.kimi', 'state', 'checkpoints');
  await mkdir(checkpointDir, { recursive: true });

  try {
    const { execFile } = await import('node:child_process');
    const diff = await new Promise((resolve) => {
      execFile('git', ['diff', '--', ...touches], { cwd: repoPath, encoding: 'utf-8' }, (err, stdout) => {
        resolve(stdout || '');
      });
    });
    if (!diff.trim()) return;

    const patchFile = path.join(checkpointDir, `${sessionId}.patch`);
    await writeFile(patchFile, diff);

    const checkpointMeta = {
      session_id: sessionId,
      created_at: new Date().toISOString(),
      touches_paths: touches,
      patch_file: patchFile,
    };
    await writeFile(
      path.join(checkpointDir, `${sessionId}.json`),
      JSON.stringify(checkpointMeta, null, 2)
    );
  } catch (e) {
    await warn('job-control', e, 'warning', repoPath);
  }
}

export async function listCheckpoints(repoPath) {
  const checkpointDir = path.join(repoPath, '.kimi', 'state', 'checkpoints');
  const checkpoints = [];
  try {
    const files = await readdir(checkpointDir);
    for (const f of files) {
      if (f.endsWith('.json')) {
        const data = JSON.parse(await readFile(path.join(checkpointDir, f), 'utf-8'));
        checkpoints.push(data);
      }
    }
  } catch {
    // none
  }
  return checkpoints.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

export async function restoreCheckpoint(sessionId, repoPath) {
  const checkpointDir = path.join(repoPath, '.kimi', 'state', 'checkpoints');
  const patchFile = path.join(checkpointDir, `${sessionId}.patch`);
  try {
    const { execFile } = await import('node:child_process');
    await new Promise((resolve, reject) => {
      execFile('git', ['apply', patchFile], { cwd: repoPath }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });
    return { ok: true, sessionId };
  } catch (e) {
    return { ok: false, sessionId, error: e.message };
  }
}
