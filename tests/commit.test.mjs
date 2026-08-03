import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDir, cleanupTempDir } from './helpers.mjs';
import { shouldCommit, commitWork } from '../plugins/kimi/scripts/lib/commit.mjs';

function initRepo() {
  const dir = makeTempDir();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });
  return dir;
}

function head(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
}

test('shouldCommit honors policy + clean conditions', () => {
  assert.equal(shouldCommit('off', { exitCode: 0, retries: 0 }), false);
  assert.equal(shouldCommit('on', { exitCode: 1, retries: 2 }), true);
  assert.equal(shouldCommit('on-clean', { exitCode: 0, retries: 0 }), true);
  assert.equal(shouldCommit('on-clean', { exitCode: 1, retries: 0 }), false);
  assert.equal(shouldCommit('on-clean', { exitCode: 0, retries: 2 }), false);
});

test("policy 'on' commits a dirty tree and returns a 40-hex SHA", async () => {
  const dir = initRepo();
  try {
    const before = head(dir);
    fs.writeFileSync(path.join(dir, 'work.txt'), 'kimi did this\n');
    const r = await commitWork(dir, 'abcdef12-0000', { auto_commit_policy: 'on', tag: 'pilot' }, { exitCode: 0, retries: 0 });
    assert.equal(r.committed, true);
    assert.match(r.commit_sha, /^[0-9a-f]{40}$/);
    assert.notEqual(head(dir), before);
  } finally {
    cleanupTempDir(dir);
  }
});

test("policy 'on-clean' with non-zero exit does NOT commit", async () => {
  const dir = initRepo();
  try {
    const before = head(dir);
    fs.writeFileSync(path.join(dir, 'work.txt'), 'incomplete\n');
    const r = await commitWork(dir, 'abcdef12-0000', { auto_commit_policy: 'on-clean' }, { exitCode: 1, retries: 0 });
    assert.equal(r.committed, false);
    assert.equal(r.commit_sha, null);
    assert.equal(head(dir), before);
  } finally {
    cleanupTempDir(dir);
  }
});

test("policy 'off' never commits", async () => {
  const dir = initRepo();
  try {
    const before = head(dir);
    fs.writeFileSync(path.join(dir, 'work.txt'), 'x\n');
    const r = await commitWork(dir, 'abcdef12-0000', { auto_commit_policy: 'off' }, { exitCode: 0, retries: 0 });
    assert.equal(r.committed, false);
    assert.equal(head(dir), before);
  } finally {
    cleanupTempDir(dir);
  }
});

test('empty diff is a no-op even under policy on', async () => {
  const dir = initRepo();
  try {
    const before = head(dir);
    const r = await commitWork(dir, 'abcdef12-0000', { auto_commit_policy: 'on' }, { exitCode: 0, retries: 0 });
    assert.equal(r.committed, false);
    assert.match(r.reason, /no changes/);
    assert.equal(head(dir), before);
  } finally {
    cleanupTempDir(dir);
  }
});

test('touches_paths scopes the add to listed files only', async () => {
  const dir = initRepo();
  try {
    fs.writeFileSync(path.join(dir, 'in-scope.txt'), 'a\n');
    fs.writeFileSync(path.join(dir, 'out-of-scope.txt'), 'b\n');
    const r = await commitWork(dir, 'abcdef12-0000', { auto_commit_policy: 'on', touches_paths: ['in-scope.txt'] }, { exitCode: 0, retries: 0 });
    assert.equal(r.committed, true);
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8' });
    assert.match(status, /out-of-scope\.txt/);
    assert.doesNotMatch(status, /in-scope\.txt/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('empty touches_paths stages exactly the paths changed since baseline_sha', async () => {
  const dir = initRepo();
  try {
    // Baseline: one tracked file committed.
    fs.writeFileSync(path.join(dir, 'kimi-target.txt'), 'v1\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir });
    const baseline = head(dir);

    // Kimi's own work (tracked change since baseline).
    fs.writeFileSync(path.join(dir, 'kimi-target.txt'), 'v2\n');
    // An unrelated untracked file in the same tree — `git add -A` would
    // sweep it in; the baseline-scoped add must not.
    fs.writeFileSync(path.join(dir, 'user-notes.txt'), 'untracked\n');

    const r = await commitWork(dir, 'abcdef12-0000', { auto_commit_policy: 'on', baseline_sha: baseline }, { exitCode: 0, retries: 0 });
    assert.equal(r.committed, true);

    // The commit contains ONLY the baseline-changed tracked path.
    const committedFiles = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: dir, encoding: 'utf-8' });
    assert.match(committedFiles, /kimi-target\.txt/);
    assert.doesNotMatch(committedFiles, /user-notes\.txt/);

    // The untracked file survives, still untracked.
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8' });
    assert.match(status, /^\?\? user-notes\.txt/m);
  } finally {
    cleanupTempDir(dir);
  }
});

test('empty touches_paths with only untracked changes since baseline skips the commit', async () => {
  const dir = initRepo();
  try {
    // Only an untracked file — `git diff --name-only <baseline> --` sees
    // nothing, so nothing is staged and the commit is skipped rather than
    // sweeping the untracked file in.
    fs.writeFileSync(path.join(dir, 'stray.txt'), 'untracked\n');
    const before = head(dir);
    const r = await commitWork(dir, 'abcdef12-0000', { auto_commit_policy: 'on', baseline_sha: before }, { exitCode: 0, retries: 0 });
    assert.equal(r.committed, false);
    assert.match(r.reason, /no tracked changes since baseline/);
    assert.equal(head(dir), before);
    assert.equal(fs.existsSync(path.join(dir, 'stray.txt')), true, 'untracked file untouched');
  } finally {
    cleanupTempDir(dir);
  }
});
