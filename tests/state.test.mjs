import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDir, cleanupTempDir } from './helpers.mjs';
import {
  initSessionDir,
  writeMeta,
  readMeta,
  updateMeta,
  metaExists,
  safeUpdateMeta,
  listSessions,
  isRunning,
  getLatestSessionForRepo,
} from '../plugins/kimi/scripts/lib/state.mjs';

test('initSessionDir creates the sessions directory', async () => {
  const tmp = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmp;

  try {
    await initSessionDir();
    assert.equal(fs.existsSync(path.join(tmp, 'sessions')), true);
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmp);
  }
});

test('writeMeta and readMeta round-trip', async () => {
  const tmp = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmp;

  try {
    const meta = { session_id: 'sess-1', status: 'running', started_at: new Date().toISOString() };
    await writeMeta('sess-1', meta);
    const read = await readMeta('sess-1');
    assert.deepEqual(read, meta);
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmp);
  }
});

test('updateMeta merges patches', async () => {
  const tmp = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmp;

  try {
    await writeMeta('sess-2', { status: 'running' });
    await updateMeta('sess-2', { status: 'completed', finished_at: '2026-01-01T00:00:00Z' });
    const read = await readMeta('sess-2');
    assert.equal(read.status, 'completed');
    assert.equal(read.finished_at, '2026-01-01T00:00:00Z');
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmp);
  }
});

test('updateMeta preserves the initial 12-field envelope on terminal write', async () => {
  const tmp = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmp;

  try {
    const initial = {
      session_id: 'sess-preserve',
      role: 'coder',
      prompt: 'do the thing',
      model: 'kimi-k2',
      started_at: '2026-06-01T18:00:00Z',
      status: 'running',
      repo_path: '/fake/repo',
      mode: 'crank',
      auto_commit_policy: 'on-clean',
      tag: 'pilot',
      touches_paths: ['a.py', 'b.py'],
      baseline_sha: 'abc1234',
    };
    await writeMeta('sess-preserve', initial);
    await updateMeta('sess-preserve', {
      status: 'completed',
      exit_code: 0,
      finished_at: '2026-06-01T18:05:00Z',
    });
    const read = await readMeta('sess-preserve');
    for (const k of Object.keys(initial)) {
      const expected = k === 'status' ? 'completed' : initial[k];
      assert.deepEqual(read[k], expected, `field ${k} not preserved`);
    }
    assert.equal(read.exit_code, 0);
    assert.equal(read.finished_at, '2026-06-01T18:05:00Z');
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmp);
  }
});

test('metaExists returns true after write and false for unknown session', async () => {
  const tmp = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmp;

  try {
    await writeMeta('sess-exists', { session_id: 'sess-exists' });
    assert.equal(await metaExists('sess-exists'), true);
    assert.equal(await metaExists('sess-missing'), false);
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmp);
  }
});

test('safeUpdateMeta merges existing meta', async () => {
  const tmp = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmp;

  try {
    await writeMeta('sess-safe-existing', { session_id: 'sess-safe-existing', status: 'running', tag: 'pilot' });
    await safeUpdateMeta('sess-safe-existing', { status: 'failed', error: 'boom' });
    const read = await readMeta('sess-safe-existing');
    assert.equal(read.status, 'failed');
    assert.equal(read.error, 'boom');
    assert.equal(read.tag, 'pilot');
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmp);
  }
});

test('safeUpdateMeta bootstraps a missing meta with minimum envelope', async () => {
  const tmp = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmp;

  try {
    await safeUpdateMeta('sess-safe-new', {
      status: 'failed',
      error: 'thrown before writeMeta',
      finished_at: '2026-06-01T18:10:00Z',
    });
    const read = await readMeta('sess-safe-new');
    assert.equal(read.session_id, 'sess-safe-new');
    assert.equal(read.status, 'failed');
    assert.equal(read.error, 'thrown before writeMeta');
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmp);
  }
});

test('listSessions returns sorted sessions', async () => {
  const tmp = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmp;

  try {
    await writeMeta('sess-a', { started_at: '2026-01-01T10:00:00Z' });
    await writeMeta('sess-b', { started_at: '2026-01-01T12:00:00Z' });
    const sessions = await listSessions();
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].session_id || sessions[0].started_at, sessions[0].started_at);
    // Newest first
    assert.equal(new Date(sessions[0].started_at) >= new Date(sessions[1].started_at), true);
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmp);
  }
});

test('isRunning returns false for non-existent session', async () => {
  const tmp = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmp;

  try {
    const running = await isRunning('nonexistent');
    assert.equal(running, false);
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmp);
  }
});

test('getLatestSessionForRepo finds matching repo', async () => {
  const tmp = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmp;

  try {
    const repoPath = path.resolve('/fake/repo');
    await writeMeta('sess-repo', { repo_path: repoPath, started_at: '2026-01-01T10:00:00Z' });
    const found = await getLatestSessionForRepo('/fake/repo');
    assert.notEqual(found, null);
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmp);
  }
});
