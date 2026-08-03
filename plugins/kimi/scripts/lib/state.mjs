import { readFile, writeFile, mkdir, readdir, stat, rename } from 'node:fs/promises';
import path from 'node:path';
import { commitWork } from './commit.mjs';
import { warn } from './warn.mjs';

function getPluginRoot() {
  return process.env.KIMI_PLUGIN_DATA
    ? path.join(process.env.KIMI_PLUGIN_DATA)
    : path.join(process.env.HOME, '.kimi-plugin-cc');
}

function getSessionsDir() {
  return path.join(getPluginRoot(), 'sessions');
}

export async function initSessionDir() {
  await mkdir(getSessionsDir(), { recursive: true });
}

export async function writeMeta(sessionId, meta) {
  const sessDir = path.join(getSessionsDir(), sessionId);
  await mkdir(sessDir, { recursive: true });
  // Atomic publish: write to a temp file, then rename over meta.json so a
  // crash mid-write can never leave a truncated/corrupt meta behind.
  const file = path.join(sessDir, 'meta.json');
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(meta, null, 2));
  await rename(tmp, file);
}

export async function readMeta(sessionId) {
  const file = path.join(getSessionsDir(), sessionId, 'meta.json');
  const data = await readFile(file, 'utf-8');
  return JSON.parse(data);
}

// Per-session serialization for read-merge-write meta updates. The watchdog,
// close handler, and broker all patch the same meta.json; without a queue,
// concurrent read-merge-writes can clobber each other's keys.
const metaQueues = new Map();

async function readModifyWriteMeta(sessionId, patch) {
  const meta = await readMeta(sessionId);
  Object.assign(meta, patch);
  await writeMeta(sessionId, meta);
}

export function updateMeta(sessionId, patch) {
  const prev = metaQueues.get(sessionId) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => readModifyWriteMeta(sessionId, patch));
  metaQueues.set(sessionId, next);
  return next;
}

/**
 * Idle-watchdog liveness: true when ANY of the given files was modified
 * within windowMs. A crank running a quiet 10-minute Shell tool (test suite,
 * build) emits no transcript bytes but the CLI still touches its log files —
 * mtime is activity the byte stream misses.
 *
 * @param {string[]} paths
 * @param {number} windowMs
 * @returns {Promise<boolean>}
 */
export async function touchedRecently(paths, windowMs) {
  for (const p of paths) {
    try {
      const s = await stat(p);
      if (Date.now() - s.mtimeMs <= windowMs) return true;
    } catch {
      // file missing this tick — not evidence either way
    }
  }
  return false;
}

export async function metaExists(sessionId) {
  const file = path.join(getSessionsDir(), sessionId, 'meta.json');
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function safeUpdateMeta(sessionId, patch) {
  if (await metaExists(sessionId)) {
    await updateMeta(sessionId, patch);
  } else {
    await writeMeta(sessionId, { session_id: sessionId, ...patch });
  }
}

export async function listSessions() {
  try {
    const dirs = await readdir(getSessionsDir());
    const sessions = [];
    for (const id of dirs) {
      const metaPath = path.join(getSessionsDir(), id, 'meta.json');
      try {
        const s = await stat(metaPath);
        if (!s.isFile()) continue;
        try {
          let meta = await readMeta(id);
          meta.running = await isRunning(id);
          // Janitor: a background session whose supervisor pid is dead but
          // whose meta still says running will never be closed otherwise.
          if (!meta.running && ['running', 'pending'].includes(meta.status)) {
            meta = await reconcileDeadSession(id, meta);
            meta.running = false; // reconcileDeadSession re-reads meta from disk
          }
          // List views get a preview, never the full prompt (it can be huge).
          if (typeof meta.prompt === 'string') {
            meta.prompt_bytes = Buffer.byteLength(meta.prompt);
            meta.prompt_preview = meta.prompt.slice(0, 200);
            delete meta.prompt;
          }
          sessions.push(meta);
        } catch (e) {
          // A corrupt meta.json must not silently hide the session.
          sessions.push({
            session_id: id,
            status: 'corrupt',
            error: e.message,
            running: false,
            started_at: new Date(0).toISOString(), // sorts last
          });
        }
      } catch {
        // ignore missing meta
      }
    }
    return sessions.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
  } catch {
    return [];
  }
}

/**
 * Read the session's pid file. Format is "<pid> <epoch_ms>" (supervisor pid +
 * spawn timestamp); legacy files hold a bare pid. Both parse to the pid.
 *
 * @returns {Promise<number|null>} the pid, or null when the file is missing
 *   or unparseable (a missing pid file means a foreground session or no
 *   supervisor was ever spawned — NOT proof of death).
 */
export async function readSessionPid(sessionId) {
  const pidFile = path.join(getSessionsDir(), sessionId, 'pid');
  try {
    const raw = (await readFile(pidFile, 'utf-8')).trim();
    const pid = parseInt(raw.split(/\s+/)[0], 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function isRunning(sessionId) {
  const pid = await readSessionPid(sessionId);
  if (pid === null) return false;
  // kill(pid, 0) alone trusts pid reuse: an unrelated process recycling the
  // pid would look like a live session. Verify with ps that the pid belongs
  // to a node/kimi process. Only ps successfully reporting "no such pid"
  // (or a foreign command) counts as dead; if ps itself is unavailable,
  // fall back to kill(pid, 0). Portable across macOS + Linux.
  try {
    const { execFile } = await import('node:child_process');
    const command = await new Promise((resolve, reject) => {
      execFile('ps', ['-p', String(pid), '-o', 'command='], (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout || '');
      });
    });
    if (!command.trim()) return false;
    return /node|kimi/i.test(command);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      // ps binary missing — degrade to the pre-hardening behavior.
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }
    return false; // ps ran and found no such pid
  }
}

/**
 * Reconcile a session whose meta still says running/pending but whose
 * supervisor pid is dead: the supervisor died (host reboot, OOM, kill -9)
 * before its close handler could record a terminal state. Mark the session
 * interrupted, then attempt commitWork per the session's own auto-commit
 * policy so partial work is not silently lost.
 *
 * Sessions with NO pid file are left alone — a foreground crank has no pid
 * file and must never be reconciled out from under a live broker.
 *
 * @param {string} sessionId
 * @param {object} [meta] - already-read meta (re-read when omitted)
 * @returns {Promise<object>} the (possibly updated) meta
 */
export async function reconcileDeadSession(sessionId, meta = null) {
  const current = meta || await readMeta(sessionId);
  if (!['running', 'pending'].includes(current.status)) return current;
  const pid = await readSessionPid(sessionId);
  if (pid === null) return current; // no supervisor was ever recorded
  if (await isRunning(sessionId)) return current; // live pid — hands off

  await updateMeta(sessionId, {
    status: 'interrupted',
    reason: 'supervisor-died',
    finished_at: new Date().toISOString(),
  });
  try {
    if (current.repo_path) {
      // exitCode unknown (the supervisor died before reporting); pass a
      // non-zero code so strict policies (on-clean) conservatively skip.
      const c = await commitWork(current.repo_path, sessionId, current, { exitCode: 1, retries: 0 });
      await updateMeta(sessionId, { committed: c.committed, commit_sha: c.commit_sha, commit_reason: c.reason });
    }
  } catch (e) {
    await warn('reconcile', e, 'warning', current.repo_path);
  }
  return readMeta(sessionId);
}

export async function getLatestSessionForRepo(repoPath) {
  const sessions = await listSessions();
  const normalized = path.resolve(repoPath);
  for (const s of sessions) {
    if (s.repo_path === normalized) {
      return s;
    }
  }
  // No cross-repo fallback: returning another repo's session leaks state
  // across projects (wrong diffs, wrong resume targets).
  return null;
}

/**
 * Parse an age string like '30d', '12h', '2w' into milliseconds.
 * Throws on garbage so the CLI can reject it loudly.
 */
export function parseAge(value) {
  const m = String(value).trim().match(/^(\d+)\s*([hdw])$/i);
  if (!m) throw new Error(`Invalid age "${value}" — use forms like 30d, 12h, 2w`);
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const factor = unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 604_800_000;
  return n * factor;
}

/**
 * Prune old session directories. A session is a candidate when its
 * meta.started_at (fallback: directory mtime) is older than olderThanMs.
 * Running sessions are NEVER candidates. Sessions whose meta.json cannot be
 * parsed are NEVER candidates either — pruning blind could delete work the
 * operator still needs; they are reported as skipped_corrupt.
 * Dry-run by default — pass execute: true to actually delete.
 *
 * @returns {Promise<{candidates: Array<{session_id: string, age_days: number}>, skipped_running: string[], skipped_corrupt: string[], deleted: string[], dry_run: boolean}>}
 */
export async function pruneSessions({ olderThanMs, execute = false } = {}) {
  const cutoff = Date.now() - olderThanMs;
  const result = { candidates: [], skipped_running: [], skipped_corrupt: [], deleted: [], dry_run: !execute };

  let ids;
  try {
    ids = await readdir(getSessionsDir());
  } catch {
    return result;
  }

  for (const id of ids) {
    const sessDir = path.join(getSessionsDir(), id);
    let when = NaN;
    try {
      const meta = await readMeta(id);
      when = new Date(meta.started_at).getTime();
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        // meta.json exists but won't parse — never prune what we can't read.
        result.skipped_corrupt.push(id);
        continue;
      }
      // no meta — fall back to mtime
    }
    if (Number.isNaN(when)) {
      try {
        when = (await stat(sessDir)).mtimeMs;
      } catch {
        continue;
      }
    }
    if (when >= cutoff) continue; // recent enough

    if (await isRunning(id)) {
      result.skipped_running.push(id);
      continue;
    }
    result.candidates.push({ session_id: id, age_days: Math.round(((Date.now() - when) / 86_400_000) * 10) / 10 });
    if (execute) {
      const { rm } = await import('node:fs/promises');
      await rm(sessDir, { recursive: true, force: true });
      result.deleted.push(id);
    }
  }
  return result;
}
