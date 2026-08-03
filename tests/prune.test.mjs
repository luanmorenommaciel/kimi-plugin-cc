import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDir, cleanupTempDir } from './helpers.mjs';
import { parseAge, pruneSessions } from '../plugins/kimi/scripts/lib/state.mjs';

function withPluginData(t, dir) {
  const prev = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.KIMI_PLUGIN_DATA;
    else process.env.KIMI_PLUGIN_DATA = prev;
  });
}

function makeSession(root, id, { startedAt, withPid } = {}) {
  const dir = path.join(root, 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ session_id: id, ...(startedAt ? { started_at: startedAt } : {}) })
  );
  if (withPid) fs.writeFileSync(path.join(dir, 'pid'), String(withPid));
  return dir;
}

test('parseAge converts h/d/w and rejects garbage', () => {
  assert.equal(parseAge('12h'), 12 * 3_600_000);
  assert.equal(parseAge('30d'), 30 * 86_400_000);
  assert.equal(parseAge('2w'), 2 * 604_800_000);
  assert.throws(() => parseAge('30'), /Invalid age/);
  assert.throws(() => parseAge('soon'), /Invalid age/);
});

test('pruneSessions dry-run lists old sessions without deleting', async (t) => {
  const root = makeTempDir();
  withPluginData(t, root);
  const old = makeSession(root, 'old-1', { startedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() });
  makeSession(root, 'new-1', { startedAt: new Date().toISOString() });
  try {
    const r = await pruneSessions({ olderThanMs: 30 * 86_400_000, execute: false });
    assert.equal(r.dry_run, true);
    assert.deepEqual(r.candidates.map((c) => c.session_id), ['old-1']);
    assert.deepEqual(r.deleted, []);
    assert.ok(fs.existsSync(old), 'dry-run must not delete');
  } finally {
    cleanupTempDir(root);
  }
});

test('pruneSessions --yes deletes only old, non-running sessions', async (t) => {
  const root = makeTempDir();
  withPluginData(t, root);
  const old = makeSession(root, 'old-1', { startedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() });
  const running = makeSession(root, 'old-running', {
    startedAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
    withPid: process.pid, // alive — isRunning() sees it
  });
  const recent = makeSession(root, 'new-1', { startedAt: new Date().toISOString() });
  try {
    const r = await pruneSessions({ olderThanMs: 30 * 86_400_000, execute: true });
    assert.deepEqual(r.deleted, ['old-1']);
    assert.deepEqual(r.skipped_running, ['old-running']);
    assert.ok(!fs.existsSync(old), 'old session deleted');
    assert.ok(fs.existsSync(running), 'running session spared');
    assert.ok(fs.existsSync(recent), 'recent session spared');
  } finally {
    cleanupTempDir(root);
  }
});

test('pruneSessions never prunes a session whose meta.json is corrupt', async (t) => {
  const root = makeTempDir();
  withPluginData(t, root);
  const corruptDir = path.join(root, 'sessions', 'old-corrupt');
  fs.mkdirSync(corruptDir, { recursive: true });
  fs.writeFileSync(path.join(corruptDir, 'meta.json'), '{not json');
  // Backdate the dir so even the mtime fallback would make it a candidate.
  const old = new Date(Date.now() - 40 * 86_400_000);
  fs.utimesSync(corruptDir, old, old);
  try {
    const r = await pruneSessions({ olderThanMs: 30 * 86_400_000, execute: true });
    assert.deepEqual(r.skipped_corrupt, ['old-corrupt']);
    assert.deepEqual(r.deleted, []);
    assert.ok(fs.existsSync(corruptDir), 'corrupt session must survive pruning');
  } finally {
    cleanupTempDir(root);
  }
});
