import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDir, cleanupTempDir } from './helpers.mjs';
import {
  buildKimiArgs,
  detectKimiCli,
  assertSupportedCli,
  resetCliDetectionCache,
  normalizeEffort,
  kimiSpawnEnv,
  resolveEffort,
  compareSemver,
  MIN_KIMI_CODE_VERSION,
} from '../plugins/kimi/scripts/lib/kimi-cli.mjs';
import { invokeKimi, extractKimiSessionId } from '../plugins/kimi/scripts/lib/kimi.mjs';
import { startBackground } from '../plugins/kimi/scripts/lib/job-control.mjs';

// ------------------------------------------------------------------
// buildKimiArgs
// ------------------------------------------------------------------

test('buildKimiArgs produces the 0.x headless invocation', () => {
  const args = buildKimiArgs({ prompt: 'hello' });
  assert.deepEqual(args, ['--output-format', 'stream-json', '-p', 'hello']);
});

test('buildKimiArgs includes --model only when set', () => {
  assert.deepEqual(
    buildKimiArgs({ prompt: 'p', model: 'k3' }),
    ['--output-format', 'stream-json', '--model', 'k3', '-p', 'p']
  );
  assert.ok(!buildKimiArgs({ prompt: 'p' }).includes('--model'));
});

test('buildKimiArgs never emits legacy 1.x flags', () => {
  const args = buildKimiArgs({ prompt: 'p', model: 'm', resumeSessionId: 's1' });
  for (const legacy of ['--print', '--yolo', '--work-dir', '--agent-file']) {
    assert.ok(!args.includes(legacy), `must not emit ${legacy}`);
  }
});

test('buildKimiArgs supports native resume via --session', () => {
  const args = buildKimiArgs({ prompt: 'p', resumeSessionId: 'abc123' });
  const i = args.indexOf('--session');
  assert.ok(i >= 0 && args[i + 1] === 'abc123');
});

// ------------------------------------------------------------------
// detectKimiCli / assertSupportedCli
// ------------------------------------------------------------------

function fakeExec(stdout, err = null) {
  return (bin, args, opts, cb) => cb(err, stdout, '');
}

test('detectKimiCli classifies a 0.x binary as kimi-code', async () => {
  resetCliDetectionCache();
  const d = await detectKimiCli({ execFileImpl: fakeExec('0.28.1\n'), fresh: true });
  assert.equal(d.ok, true);
  assert.equal(d.generation, 'kimi-code');
  assert.equal(d.version, '0.28.1');
});

test('detectKimiCli classifies a 1.x binary as legacy (unsupported)', async () => {
  resetCliDetectionCache();
  const d = await detectKimiCli({ execFileImpl: fakeExec('kimi, version 1.49.0\n'), fresh: true });
  assert.equal(d.ok, false);
  assert.equal(d.generation, 'legacy');
  assert.equal(d.version, '1.49.0');
});

test('compareSemver orders dotted versions', () => {
  assert.ok(compareSemver('0.20.0', '0.28.0') < 0);
  assert.ok(compareSemver('0.28.0', '0.28.0') === 0);
  assert.ok(compareSemver('0.28.1', '0.28.0') > 0);
  assert.ok(compareSemver('1.0.0', '0.99.9') > 0);
});

test('detectKimiCli flags below-floor 0.x versions without rejecting them', async () => {
  resetCliDetectionCache();
  const below = await detectKimiCli({ execFileImpl: fakeExec('0.20.0\n'), fresh: true });
  assert.equal(below.ok, true, 'still a supported generation');
  assert.equal(below.belowFloor, true, 'but flagged below the feature floor');
  resetCliDetectionCache();
  const above = await detectKimiCli({ execFileImpl: fakeExec(`${MIN_KIMI_CODE_VERSION}\n`), fresh: true });
  assert.equal(above.belowFloor, false);
  resetCliDetectionCache();
});

test('detectKimiCli reports a missing binary', async () => {
  resetCliDetectionCache();
  const d = await detectKimiCli({ execFileImpl: fakeExec('', new Error('spawn kimi ENOENT')), fresh: true });
  assert.equal(d.ok, false);
  assert.equal(d.generation, 'missing');
});

test('detectKimiCli reports unrecognized version output', async () => {
  resetCliDetectionCache();
  const d = await detectKimiCli({ execFileImpl: fakeExec('weird\n'), fresh: true });
  assert.equal(d.ok, false);
  assert.equal(d.generation, 'unknown');
});

test('detectKimiCli caches the probe per process', async () => {
  resetCliDetectionCache();
  let calls = 0;
  const counting = (bin, args, opts, cb) => { calls++; cb(null, '0.28.1\n', ''); };
  await detectKimiCli({ execFileImpl: counting });
  await detectKimiCli({ execFileImpl: counting });
  assert.equal(calls, 1, 'second call must be served from cache');
  resetCliDetectionCache();
});

test('assertSupportedCli throws a migration message for legacy 1.x', async () => {
  resetCliDetectionCache();
  await assert.rejects(
    () => assertSupportedCli({ execFileImpl: fakeExec('1.44.0\n'), fresh: true }),
    /Unsupported legacy kimi-cli 1\.44\.0.*Kimi Code 0\.x/s
  );
  resetCliDetectionCache();
});

test('assertSupportedCli throws install guidance when kimi is missing', async () => {
  resetCliDetectionCache();
  await assert.rejects(
    () => assertSupportedCli({ execFileImpl: fakeExec('', new Error('ENOENT')), fresh: true }),
    /kimi binary not usable/
  );
  resetCliDetectionCache();
});

// ------------------------------------------------------------------
// Foreground/background parity — both paths must emit identical args
// ------------------------------------------------------------------

function fakeChild() {
  return {
    stdout: { pipe: () => {}, on: () => {} },
    stderr: { pipe: () => {}, on: () => {} },
    unref: () => {},
    on: () => {},
    pid: 4242,
  };
}

test('foreground and background dispatch use the same args (no drift)', async () => {
  const tmpPlugin = makeTempDir();
  const tmpRepo = makeTempDir();
  const binDir = makeTempDir();
  const argsLog = path.join(tmpPlugin, 'fg-args.txt');
  const shim = path.join(binDir, 'kimi');
  fs.writeFileSync(
    shim,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argsLog}"\necho '{"role":"assistant","content":"ok"}'\n`
  );
  fs.chmodSync(shim, 0o755);

  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  const prevPath = process.env.PATH;
  process.env.KIMI_PLUGIN_DATA = tmpPlugin;
  process.env.PATH = `${binDir}:${prevPath}`;

  let bgArgs = null;
  try {
    await startBackground({
      sessionId: 'parity-bg',
      prompt: 'parity check',
      model: 'k3',
      repoPath: tmpRepo,
      spawnFn: (cmd, args) => { bgArgs = args; return fakeChild(); },
    });
    const fg = await invokeKimi({
      prompt: 'parity check',
      model: 'k3',
      sessionId: 'parity-fg',
      cwd: tmpRepo,
    });
    assert.equal(fg.exitCode, 0, `shim should exit 0, got ${fg.exitCode}`);
    const fgArgs = fs.readFileSync(argsLog, 'utf-8').trim().split('\n');
    assert.deepEqual(fgArgs, bgArgs, 'foreground and background must build identical argv');
  } finally {
    process.env.PATH = prevPath;
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmpPlugin);
    cleanupTempDir(tmpRepo);
    cleanupTempDir(binDir);
  }
});

// ------------------------------------------------------------------
// Native resume (T-04): real session id capture + --session passthrough
// ------------------------------------------------------------------

test('extractKimiSessionId parses the resume_hint meta line', async () => {
  const tmp = makeTempDir();
  const f = path.join(tmp, 'output.jsonl');
  fs.writeFileSync(
    f,
    '{"role":"assistant","content":"ok"}\n' +
      '{"role":"meta","type":"session.resume_hint","session_id":"session_abc-123","command":"kimi -r session_abc-123"}\n'
  );
  try {
    assert.equal(await extractKimiSessionId(f), 'session_abc-123');
  } finally {
    cleanupTempDir(tmp);
  }
});

test('extractKimiSessionId returns empty string when no hint exists', async () => {
  const tmp = makeTempDir();
  const f = path.join(tmp, 'output.jsonl');
  fs.writeFileSync(f, '{"role":"assistant","content":"ok"}\nnot json\n');
  try {
    assert.equal(await extractKimiSessionId(f), '');
    assert.equal(await extractKimiSessionId(path.join(tmp, 'missing.jsonl')), '');
  } finally {
    cleanupTempDir(tmp);
  }
});

test('startBackground passes --session through for native resume', async () => {
  const tmpPlugin = makeTempDir();
  const tmpRepo = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmpPlugin;

  let captured = null;
  try {
    await startBackground({
      sessionId: 'resume-args-1',
      prompt: 'follow up',
      repoPath: tmpRepo,
      resumeSessionId: 'session_xyz-789',
      spawnFn: (cmd, args) => { captured = args; return fakeChild(); },
    });
    const i = captured.indexOf('--session');
    assert.ok(i >= 0, '--session must be present');
    assert.equal(captured[i + 1], 'session_xyz-789');
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmpPlugin);
    cleanupTempDir(tmpRepo);
  }
});

// ------------------------------------------------------------------
// K3 thinking effort (T-06)
// ------------------------------------------------------------------

test('normalizeEffort accepts documented levels and rejects garbage', () => {
  for (const ok of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(normalizeEffort(ok), ok);
  }
  assert.equal(normalizeEffort(' HIGH '), 'high');
  assert.throws(() => normalizeEffort('ultra'), /Invalid --effort "ultra".*low, medium, high, xhigh, max/);
  assert.throws(() => normalizeEffort(''), /Invalid --effort/);
});

test('kimiSpawnEnv forces KIMI_MODEL_THINKING_EFFORT only when set', () => {
  const withEffort = kimiSpawnEnv({ effort: 'max' });
  assert.equal(withEffort.KIMI_MODEL_THINKING_EFFORT, 'max');
  const without = kimiSpawnEnv({});
  assert.equal(without.KIMI_MODEL_THINKING_EFFORT, undefined);
});

test('resolveEffort applies per-mode defaults unless explicit or off', () => {
  assert.deepEqual(resolveEffort({ mode: 'review' }), { effort: 'low', source: 'mode-default' });
  assert.deepEqual(resolveEffort({ mode: 'crank' }), { effort: 'high', source: 'mode-default' });
  assert.deepEqual(resolveEffort({ mode: 'explore' }), { effort: 'low', source: 'mode-default' });
  // Explicit flag always wins
  assert.deepEqual(resolveEffort({ explicit: 'max', mode: 'review' }), { effort: 'max', source: 'explicit' });
  // Off switch restores no-default
  assert.deepEqual(resolveEffort({ mode: 'review', off: true }), { effort: '', source: 'none' });
  // Unknown modes get no default
  assert.deepEqual(resolveEffort({ mode: 'custom-mode' }), { effort: '', source: 'none' });
  // Invalid explicit still validated
  assert.throws(() => resolveEffort({ explicit: 'ultra', mode: 'crank' }), /Invalid --effort/);
});

test('startBackground injects the effort env var into the kimi process', async () => {
  const tmpPlugin = makeTempDir();
  const tmpRepo = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmpPlugin;

  let capturedOpts = null;
  try {
    await startBackground({
      sessionId: 'effort-env-1',
      prompt: 'p',
      repoPath: tmpRepo,
      effort: 'max',
      spawnFn: (cmd, args, opts) => { capturedOpts = opts; return fakeChild(); },
    });
    assert.equal(capturedOpts.env.KIMI_MODEL_THINKING_EFFORT, 'max');
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmpPlugin);
    cleanupTempDir(tmpRepo);
  }
});
