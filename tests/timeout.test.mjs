import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDir, cleanupTempDir } from './helpers.mjs';
import { invokeKimi, TIMEOUT_EXIT_CODE } from '../plugins/kimi/scripts/lib/kimi.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

test('TIMEOUT_EXIT_CODE is the documented sentinel (124)', () => {
  assert.equal(TIMEOUT_EXIT_CODE, 124);
});

test('invokeKimi hard-timeout kills a hung kimi and returns timedOut with sentinel exit', async () => {
  const tmpPlugin = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  const prevTotal = process.env.KIMI_DISPATCH_TIMEOUT_MS;
  process.env.KIMI_PLUGIN_DATA = tmpPlugin;
  // Force the kimi binary lookup to a shim that sleeps forever, with a tiny timeout.
  process.env.KIMI_DISPATCH_TIMEOUT_MS = '300';

  // Shadow 'kimi' on PATH with a hang-forever script.
  const binDir = makeTempDir();
  const shim = path.join(binDir, 'kimi');
  fs.writeFileSync(shim, '#!/usr/bin/env bash\nsleep 60\n');
  fs.chmodSync(shim, 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = `${binDir}:${prevPath}`;

  try {
    const result = await invokeKimi({
      prompt: 'hang',
      role: 'coder',
      sessionId: 'timeout-test-1',
      background: false,
      cwd: tmpPlugin,
    });
    assert.equal(result.timedOut, true, 'should report timedOut');
    assert.equal(result.exitCode, TIMEOUT_EXIT_CODE, `exit should be ${TIMEOUT_EXIT_CODE}`);
  } finally {
    process.env.PATH = prevPath;
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    if (prevTotal === undefined) delete process.env.KIMI_DISPATCH_TIMEOUT_MS;
    else process.env.KIMI_DISPATCH_TIMEOUT_MS = prevTotal;
    cleanupTempDir(tmpPlugin);
    cleanupTempDir(binDir);
  }
});

test('invokeKimi survives a synchronous spawn error (missing binary) without TDZ crash', async () => {
  const tmpPlugin = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  const prevPath = process.env.PATH;
  process.env.KIMI_PLUGIN_DATA = tmpPlugin;
  // Empty PATH so 'kimi' is not found → spawn emits 'error' (ENOENT).
  process.env.PATH = makeTempDir();

  try {
    const result = await invokeKimi({
      prompt: 'x',
      role: 'coder',
      sessionId: 'enoent-test-1',
      background: false,
      cwd: tmpPlugin,
    });
    // Must resolve cleanly (exit 1), not throw a ReferenceError from the TDZ.
    assert.equal(result.exitCode, 1);
    assert.equal(result.timedOut, false);
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    process.env.PATH = prevPath;
    cleanupTempDir(tmpPlugin);
  }
});

test('broker documents exit code 6 as timeout (not reserved)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'plugins/kimi/scripts/broker.mjs'), 'utf-8');
  assert.match(src, /\n\s*6\s+timeout/);
  assert.doesNotMatch(src, /6\s+reserved/);
});

test('commands.mjs surfaces a timeout as exitCode 6 with status failed/timeout', () => {
  const src = fs.readFileSync(path.join(ROOT, 'plugins/kimi/scripts/lib/commands.mjs'), 'utf-8');
  assert.match(src, /result\.timedOut/);
  // reason is 'max-cost' on a budget breach, 'timeout' otherwise; both exit 6.
  assert.match(src, /timeoutReason === 'max-cost' \? 'max-cost' : 'timeout'/);
  assert.match(src, /reason, committed: false, exitCode: 6/);
});

test('waitForSessions actively cancels stuck sessions instead of only warning', () => {
  const src = fs.readFileSync(path.join(ROOT, 'plugins/kimi/scripts/lib/commands.mjs'), 'utf-8');
  const fn = src.slice(src.indexOf('async function waitForSessions'));
  assert.match(fn.slice(0, 2500), /cancelSession\(id\)/);
});
