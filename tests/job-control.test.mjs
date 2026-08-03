import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDir, cleanupTempDir } from './helpers.mjs';
import {
  getSessionsDir,
  startBackground,
  cancelSession,
} from '../plugins/kimi/scripts/lib/job-control.mjs';

test('getSessionsDir respects KIMI_PLUGIN_DATA override', () => {
  const tmp = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmp;

  try {
    const dir = getSessionsDir();
    assert.equal(dir, path.join(tmp, 'sessions'));
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmp);
  }
});

test('getSessionsDir falls back to HOME when env unset', (t) => {
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  delete process.env.KIMI_PLUGIN_DATA;
  t.after(() => {
    if (prevEnv === undefined) delete process.env.KIMI_PLUGIN_DATA;
    else process.env.KIMI_PLUGIN_DATA = prevEnv;
  });

  const dir = getSessionsDir();
  assert.ok(dir.includes('.kimi-plugin-cc'));
  assert.ok(dir.endsWith('sessions'));
});

test('startBackground writes meta.json and kimi.pid file', async () => {
  const tmp = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmp;

  try {
    const fakeSpawn = () => {
      const emitter = {
        stdout: { pipe: () => {} },
        stderr: { pipe: () => {} },
        unref: () => {},
        on: () => {},
        pid: 12345,
      };
      return emitter;
    };

    const result = await startBackground({
      sessionId: 'test-sess-1',
      role: 'coder',
      prompt: 'test prompt',
      model: 'kimi-k2',
      mode: 'crank',
      spawnFn: fakeSpawn,
    });

    assert.equal(result.sessionId, 'test-sess-1');
    assert.equal(result.status, 'started');

    const metaPath = path.join(tmp, 'sessions', 'test-sess-1', 'meta.json');
    assert.equal(fs.existsSync(metaPath), true);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    assert.equal(meta.session_id, 'test-sess-1');
    assert.equal(meta.status, 'running');
    assert.equal(meta.mode, 'crank');

    // The crank's own pid lives in kimi.pid; the session's main `pid` file
    // belongs to the detached supervisor (written by spawnSupervisor).
    const pidPath = path.join(tmp, 'sessions', 'test-sess-1', 'kimi.pid');
    assert.equal(fs.existsSync(pidPath), true);
    assert.equal(fs.readFileSync(pidPath, 'utf-8').trim(), '12345');
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmp);
  }
});

test('cancelSession updates meta to cancelled', async () => {
  const tmp = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmp;

  try {
    // Write a fake session with meta + pid
    const sessDir = path.join(tmp, 'sessions', 'test-sess-2');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessDir, 'meta.json'),
      JSON.stringify({ session_id: 'test-sess-2', status: 'running' })
    );
    // Use a pid that doesn't exist (kill will throw, caught)
    fs.writeFileSync(path.join(sessDir, 'pid'), '99999');

    const result = await cancelSession('test-sess-2');
    assert.equal(result.status, 'cancelled');

    const meta = JSON.parse(fs.readFileSync(path.join(sessDir, 'meta.json'), 'utf-8'));
    assert.equal(meta.status, 'cancelled');
    assert.ok(meta.cancelled_at);
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmp);
  }
});

test('cancelSession handles missing session gracefully', async () => {
  const tmp = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmp;

  try {
    const result = await cancelSession('nonexistent-session');
    assert.equal(result.status, 'cancelled');
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmp);
  }
});

test('cancelSession never downgrades a terminal session', async () => {
  const tmp = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmp;

  try {
    const sessDir = path.join(tmp, 'sessions', 'test-sess-done');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessDir, 'meta.json'),
      JSON.stringify({ session_id: 'test-sess-done', status: 'completed', exit_code: 0 })
    );

    const result = await cancelSession('test-sess-done');
    assert.equal(result.status, 'completed');
    assert.equal(result.already_terminal, true);

    const meta = JSON.parse(fs.readFileSync(path.join(sessDir, 'meta.json'), 'utf-8'));
    assert.equal(meta.status, 'completed');
    assert.equal(meta.cancelled_at, undefined);
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmp);
  }
});
