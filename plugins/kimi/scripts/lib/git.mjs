import { execFile } from 'node:child_process';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { warn } from './warn.mjs';

function getPluginRoot() {
  return process.env.KIMI_PLUGIN_DATA
    ? path.join(process.env.KIMI_PLUGIN_DATA)
    : path.join(process.env.HOME, '.kimi-plugin-cc');
}

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    // Large diffs are the norm for cranks — the 1MB default silently
    // truncated them. Reject on ANY non-zero exit/kill; callers decide how
    // to degrade (and must warn when they fall back to '').
    execFile('git', args, { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** Degrade a git failure to '' for diff capture, but never silently. */
async function diffOrEmpty(promise) {
  try {
    return await promise;
  } catch (e) {
    await warn('git', e, 'warning');
    return '';
  }
}

/**
 * Capture pre/post diff for a session.
 */
export async function captureDiff(sessionId, phase, repoPath = process.cwd()) {
  const sessDir = path.join(getPluginRoot(), 'sessions', sessionId);
  await mkdir(sessDir, { recursive: true });

  const diff = await diffOrEmpty(runGit(['diff', 'HEAD'], repoPath));
  const status = await diffOrEmpty(runGit(['status', '--short'], repoPath));

  await writeFile(path.join(sessDir, `${phase}.diff`), diff);
  await writeFile(path.join(sessDir, `${phase}.status`), status);
}

/**
 * Get diff against a base ref. Throws on git failure (e.g. an invalid ref)
 * so callers can surface the error instead of emitting an empty diff.
 */
export async function getBranchDiff(baseRef, repoPath = process.cwd()) {
  return runGit(['diff', `${baseRef}...HEAD`], repoPath);
}

/**
 * Get diff of uncommitted changes.
 */
export async function getWorkingDiff(repoPath = process.cwd()) {
  return diffOrEmpty(runGit(['diff'], repoPath));
}

/**
 * Find the repository root.
 */
export async function findRepoRoot(start = process.cwd()) {
  try {
    const out = await runGit(['rev-parse', '--show-toplevel'], start);
    return out.trim();
  } catch {
    return start;
  }
}

/**
 * Get current branch name.
 */
export async function getCurrentBranch(repoPath = process.cwd()) {
  try {
    const out = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
    return out.trim();
  } catch {
    return 'main';
  }
}

/**
 * Fetch origin and compare touches_paths for divergence.
 *
 * @param {string[]} touchesPaths
 * @param {string} repoPath
 * @returns {Promise<{diverged: boolean, conflicting_paths: string[], origin_sha: string}>}
 */
export async function fetchAndCompare(touchesPaths, repoPath = process.cwd()) {
  const branch = await getCurrentBranch(repoPath);
  const stateDir = path.join(repoPath, '.kimi', 'state');
  await mkdir(stateDir, { recursive: true });

  const stateFile = path.join(stateDir, `origin-${branch}.json`);
  let cached;
  try {
    cached = JSON.parse(await readFile(stateFile, 'utf-8'));
  } catch {
    cached = null;
  }

  const now = Date.now();
  const stale = !cached || (now - new Date(cached.fetched_at).getTime() > 60000);

  let originSha;
  if (stale) {
    try {
      await runGit(['fetch', 'origin', branch], repoPath);
      originSha = (await runGit(['rev-parse', `origin/${branch}`], repoPath)).trim();
      await writeFile(stateFile, JSON.stringify({ branch, origin_sha: originSha, fetched_at: new Date().toISOString() }, null, 2));
    } catch (e) {
      await warn('git', e, 'warning');
      originSha = cached?.origin_sha || '';
    }
  } else {
    originSha = cached.origin_sha;
  }

  if (!originSha) {
    return { diverged: false, conflicting_paths: [], origin_sha: '' };
  }

  const localSha = (await runGit(['rev-parse', 'HEAD'], repoPath).catch(() => '')).trim();
  if (localSha === originSha) {
    return { diverged: false, conflicting_paths: [], origin_sha: originSha };
  }

  const conflicting = [];
  for (const tp of touchesPaths) {
    try {
      const diff = await runGit(['diff', `${originSha}...${localSha}`, '--', tp], repoPath);
      if (diff.trim()) {
        conflicting.push(tp);
      }
    } catch (e) {
      await warn('git', e, 'info');
    }
  }

  return {
    diverged: conflicting.length > 0,
    conflicting_paths: conflicting,
    origin_sha: originSha,
  };
}
