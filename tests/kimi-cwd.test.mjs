import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDir, cleanupTempDir } from './helpers.mjs';
import { startBackground } from '../plugins/kimi/scripts/lib/job-control.mjs';

function fakeChild() {
  return {
    stdout: { pipe: () => {} },
    stderr: { pipe: () => {} },
    unref: () => {},
    on: () => {},
    pid: 4242,
  };
}

test('startBackground spawns kimi with cwd set to the provided repoPath (worktree isolation)', async () => {
  const tmpPlugin = makeTempDir();
  const tmpRepo = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmpPlugin;

  let capturedOpts = null;
  let capturedArgs = null;
  const spawnFn = (cmd, args, opts) => {
    assert.equal(cmd, 'kimi');
    capturedArgs = args;
    capturedOpts = opts;
    return fakeChild();
  };

  try {
    await startBackground({
      sessionId: 'cwd-test-1',
      role: 'coder',
      prompt: 'p',
      repoPath: tmpRepo,
      spawnFn,
    });
    assert.equal(capturedOpts.cwd, tmpRepo, 'spawn cwd must equal the worktree repoPath');
    // Kimi Code 0.x: no --work-dir flag — the repo path travels via spawn cwd.
    assert.ok(!capturedArgs.includes('--work-dir'), '0.x must not use --work-dir');
    for (const legacy of ['--print', '--yolo', '--agent-file']) {
      assert.ok(!capturedArgs.includes(legacy), `0.x must not use ${legacy}`);
    }
    assert.deepEqual(capturedArgs.slice(0, 2), ['--output-format', 'stream-json']);
    const pIdx = capturedArgs.indexOf('-p');
    assert.ok(pIdx >= 0 && capturedArgs[pIdx + 1] === 'p', 'prompt must follow -p');
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmpPlugin);
    cleanupTempDir(tmpRepo);
  }
});

test('startBackground does NOT re-resolve repoPath when the caller provides it', async () => {
  const tmpPlugin = makeTempDir();
  const tmpRepo = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmpPlugin;

  let capturedOpts = null;
  const spawnFn = (cmd, args, opts) => { capturedOpts = opts; return fakeChild(); };

  try {
    const result = await startBackground({
      sessionId: 'cwd-test-2',
      role: 'coder',
      prompt: 'p',
      repoPath: tmpRepo,
      spawnFn,
    });
    assert.equal(result.status, 'started');
    assert.equal(capturedOpts.cwd, tmpRepo, 'must honor caller repoPath, not findRepoRoot');
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmpPlugin);
    cleanupTempDir(tmpRepo);
  }
});
