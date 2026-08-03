import { execFile } from 'node:child_process';

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/**
 * Resolve whether a session's work should be committed, per its auto_commit_policy.
 *
 * @param {string} policy - 'on' | 'off' | 'on-clean'
 * @param {object} ctx
 * @param {number} ctx.exitCode - the Kimi exit code (0 = success)
 * @param {number} ctx.retries - number of retries the crank needed
 * @returns {boolean}
 */
export function shouldCommit(policy, ctx = {}) {
  if (policy === 'off') return false;
  if (policy === 'on') return true;
  return (ctx.exitCode === 0) && ((ctx.retries ?? 0) === 0);
}

/**
 * Durably commit the working-tree changes a Kimi session produced.
 *
 * Honors meta.auto_commit_policy. Returns the commit result without throwing —
 * git failures warn-not-throw and leave committed:false so the supervisor can
 * still see (and recover) the uncommitted diff.
 *
 * @param {string} repoPath - absolute path to the repo/worktree root
 * @param {string} sessionId
 * @param {object} meta - the session meta (reads auto_commit_policy, tag, touches_paths, title)
 * @param {object} ctx - { exitCode, retries }
 * @returns {Promise<{committed: boolean, commit_sha: string|null, reason: string}>}
 */
export async function commitWork(repoPath, sessionId, meta, ctx = {}) {
  const policy = meta.auto_commit_policy || 'on-clean';

  if (!shouldCommit(policy, ctx)) {
    return { committed: false, commit_sha: null, reason: `policy=${policy} not satisfied` };
  }

  const status = await git(['status', '--porcelain'], repoPath);
  if (status.code !== 0) {
    return { committed: false, commit_sha: null, reason: `git status failed: ${status.stderr.trim()}` };
  }
  if (!status.stdout.trim()) {
    return { committed: false, commit_sha: null, reason: 'no changes to commit' };
  }

  const touches = Array.isArray(meta.touches_paths) ? meta.touches_paths.filter(Boolean) : [];
  let addArgs;
  if (touches.length > 0) {
    addArgs = ['add', '--', ...touches];
  } else if (meta.baseline_sha) {
    // No touches_paths: stage ONLY what changed since the session baseline.
    // `git add -A` here would sweep unrelated user edits into Kimi's commit.
    const changed = await git(['diff', '--name-only', meta.baseline_sha, '--'], repoPath);
    const paths = changed.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (paths.length === 0) {
      return { committed: false, commit_sha: null, reason: 'no tracked changes since baseline' };
    }
    addArgs = ['add', '--', ...paths];
  } else {
    addArgs = ['add', '-A'];
  }
  const add = await git(addArgs, repoPath);
  if (add.code !== 0) {
    return { committed: false, commit_sha: null, reason: `git add failed: ${add.stderr.trim()}` };
  }

  const staged = await git(['diff', '--cached', '--name-only'], repoPath);
  if (!staged.stdout.trim()) {
    return { committed: false, commit_sha: null, reason: 'nothing staged after add (paths outside touches_paths?)' };
  }

  const id8 = sessionId.slice(0, 8);
  const label = meta.tag || meta.title || meta.session_id || id8;
  const subject = `${label}: kimi session ${id8}`;
  const commit = await git(['commit', '--no-verify', '-m', subject], repoPath);
  if (commit.code !== 0) {
    return { committed: false, commit_sha: null, reason: `git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}` };
  }

  const head = await git(['rev-parse', 'HEAD'], repoPath);
  const sha = head.code === 0 ? head.stdout.trim() : null;
  return { committed: true, commit_sha: sha, reason: `committed via policy=${policy}` };
}
