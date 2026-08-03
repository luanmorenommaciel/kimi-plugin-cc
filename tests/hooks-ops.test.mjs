import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDir, cleanupTempDir } from './helpers.mjs';
import { notifyCompletion } from '../plugins/kimi/scripts/lib/notify.mjs';
import { enableReviewGate, disableReviewGate, reviewGateStatus } from '../plugins/kimi/scripts/lib/review-gate.mjs';
import { getHandler } from '../plugins/kimi/scripts/lib/commands.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

// ------------------------------------------------------------------
// notify.mjs
// ------------------------------------------------------------------

test('notifyCompletion uses KIMI_NOTIFY_CMD with title/message env', async () => {
  const prev = process.env.KIMI_NOTIFY_CMD;
  process.env.KIMI_NOTIFY_CMD = 'my-notifier';
  const calls = [];
  try {
    const ok = await notifyCompletion('crank done', 'sess-1', {
      runImpl: async (cmd, args, opts) => { calls.push({ cmd, opts }); },
    });
    assert.equal(ok, true);
    assert.equal(calls[0].cmd, 'my-notifier');
    assert.equal(calls[0].opts.env.KIMI_NOTIFY_TITLE, 'crank done');
    assert.equal(calls[0].opts.env.KIMI_NOTIFY_MESSAGE, 'sess-1');
  } finally {
    if (prev === undefined) delete process.env.KIMI_NOTIFY_CMD;
    else process.env.KIMI_NOTIFY_CMD = prev;
  }
});

test('notifyCompletion swallows notifier failures', async () => {
  const prev = process.env.KIMI_NOTIFY_CMD;
  process.env.KIMI_NOTIFY_CMD = 'broken-notifier';
  try {
    const ok = await notifyCompletion('t', 'm', { runImpl: async () => { throw new Error('boom'); } });
    assert.equal(ok, false, 'failure maps to false, never throws');
  } finally {
    if (prev === undefined) delete process.env.KIMI_NOTIFY_CMD;
    else process.env.KIMI_NOTIFY_CMD = prev;
  }
});

// ------------------------------------------------------------------
// review-gate enable/disable wiring
// ------------------------------------------------------------------

test('review gate enable/status/disable round-trips a valid hooks.json', async () => {
  const tmp = makeTempDir();
  const hooksFile = path.join(tmp, 'hooks.json');
  fs.writeFileSync(hooksFile, '{\n  "description": "Kimi plugin hooks — review gate disabled by default",\n  "hooks": {}\n}\n');

  try {
    assert.equal((await reviewGateStatus(hooksFile)).enabled, false);

    const enabled = await enableReviewGate(hooksFile);
    assert.match(enabled.note, /\/reload-plugins/, 'enable output must mention the reload requirement');
    const cfg = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
    assert.ok(Array.isArray(cfg.hooks.Stop), 'Stop array must exist');
    const cmd = cfg.hooks.Stop[0].hooks[0].command;
    assert.match(cmd, /review-gate\.mjs/);
    assert.match(cmd, /\$\{CLAUDE_PLUGIN_ROOT\}/);
    assert.equal(cfg.hooks.Stop[0].hooks[0].type, 'command');
    assert.equal((await reviewGateStatus(hooksFile)).enabled, true);
    // enable twice — no duplicate entry
    await enableReviewGate(hooksFile);
    const cfg2 = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
    assert.equal(cfg2.hooks.Stop.length, 1);

    await disableReviewGate(hooksFile);
    const cfg3 = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
    assert.equal(cfg3.hooks.Stop, undefined);
    assert.equal((await reviewGateStatus(hooksFile)).enabled, false);
  } finally {
    cleanupTempDir(tmp);
  }
});

// ------------------------------------------------------------------
// review-gate.mjs Stop-hook script (end to end with a fake kimi)
// ------------------------------------------------------------------

function makeVerdictKimi(binDir, payloadDir, verdict) {
  const payload = path.join(payloadDir, 'kimi-out.jsonl');
  fs.writeFileSync(payload, JSON.stringify({ role: 'assistant', content: JSON.stringify(verdict) }) + '\n');
  const shim = path.join(binDir, 'kimi');
  fs.writeFileSync(shim, `#!/usr/bin/env bash\ncat '${payload}'\n`);
  fs.chmodSync(shim, 0o755);
  return shim;
}

function runGate(stdinPayload, env) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, 'plugins/kimi/scripts/review-gate.mjs')],
      { env }
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      resolve({ code: 1, stdout, stderr });
    }, 15000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr });
    });
    child.stdin.write(stdinPayload);
    child.stdin.end();
  });
}

const TRANSCRIPT = [
  '{"type":"user","message":{"role":"user","content":"fix it"}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I hardcoded the API key in source."}]}}',
].join('\n');

test('review-gate blocks the stop when Kimi reports a critical issue', async () => {
  const binDir = makeTempDir();
  const tmp = makeTempDir();
  makeVerdictKimi(binDir, tmp, { block: true, reason: 'leaks secrets' });
  const transcript = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(transcript, TRANSCRIPT);
  try {
    const r = await runGate(JSON.stringify({ transcript_path: transcript }), {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      KIMI_PLUGIN_DATA: tmp,
    });
    assert.equal(r.code, 0, 'gate always exits 0 (fail-open contract)');
    const decision = JSON.parse(r.stdout.trim());
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /leaks secrets/);
  } finally {
    cleanupTempDir(binDir);
    cleanupTempDir(tmp);
  }
});

test('review-gate stays silent when Kimi finds nothing', async () => {
  const binDir = makeTempDir();
  const tmp = makeTempDir();
  makeVerdictKimi(binDir, tmp, { block: false });
  const transcript = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(transcript, TRANSCRIPT);
  try {
    const r = await runGate(JSON.stringify({ transcript_path: transcript }), {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      KIMI_PLUGIN_DATA: tmp,
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '', 'no decision output when not blocking');
  } finally {
    cleanupTempDir(binDir);
    cleanupTempDir(tmp);
  }
});

// Like makeVerdictKimi, but the shim records its argv and the gate-injected
// env so tests can assert how Kimi was invoked.
function makeRecordingKimi(binDir, payloadDir, verdict) {
  const payload = path.join(payloadDir, 'kimi-out.jsonl');
  fs.writeFileSync(payload, JSON.stringify({ role: 'assistant', content: JSON.stringify(verdict) }) + '\n');
  const recordDir = path.join(payloadDir, 'record');
  fs.mkdirSync(recordDir, { recursive: true });
  const shim = path.join(binDir, 'kimi');
  fs.writeFileSync(shim, [
    '#!/usr/bin/env bash',
    `printf '%s\n' "$@" > '${path.join(recordDir, 'argv.txt')}'`,
    `printf 'KIMI_MODEL_THINKING_EFFORT=%s\n' "$KIMI_MODEL_THINKING_EFFORT" > '${path.join(recordDir, 'env.txt')}'`,
    `cat '${payload}'`,
    '',
  ].join('\n'));
  fs.chmodSync(shim, 0o755);
  return { recordDir };
}

function gateEnv(binDir, dataDir, extra = {}) {
  // Ambient values would leak into assertions about gate-injected env.
  const base = { ...process.env };
  delete base.KIMI_MODEL_THINKING_EFFORT;
  delete base.KIMI_REVIEW_GATE_MODEL;
  delete base.KIMI_REVIEW_GATE_MAX_BLOCKS;
  return {
    ...base,
    PATH: `${binDir}:${process.env.PATH}`,
    KIMI_PLUGIN_DATA: dataDir,
    ...extra,
  };
}

test('review-gate exits immediately on stop_hook_active without spawning kimi', async () => {
  const binDir = makeTempDir();
  const tmp = makeTempDir();
  const dataDir = makeTempDir();
  const { recordDir } = makeRecordingKimi(binDir, tmp, { block: true, reason: 'would block' });
  const transcript = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(transcript, TRANSCRIPT);
  try {
    const r = await runGate(JSON.stringify({
      stop_hook_active: true,
      transcript_path: transcript,
      session_id: 'sess-loop',
    }), gateEnv(binDir, dataDir));
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '', 'no decision output on stop_hook_active');
    assert.ok(!fs.existsSync(path.join(recordDir, 'argv.txt')), 'kimi must not be spawned');
  } finally {
    cleanupTempDir(binDir);
    cleanupTempDir(tmp);
    cleanupTempDir(dataDir);
  }
});

test('review-gate circuit breaker trips at KIMI_REVIEW_GATE_MAX_BLOCKS and resets on pass', async () => {
  const binDir = makeTempDir();
  const tmp = makeTempDir();
  const dataDir = makeTempDir();
  makeRecordingKimi(binDir, tmp, { block: true, reason: 'bad' });
  const transcript = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(transcript, TRANSCRIPT);
  const env = gateEnv(binDir, dataDir, { KIMI_REVIEW_GATE_MAX_BLOCKS: '2' });
  const payload = JSON.stringify({ transcript_path: transcript, session_id: 'sess-cb' });
  const counterFile = path.join(dataDir, 'review-gate', 'sess-cb.json');
  try {
    const r1 = await runGate(payload, env);
    assert.equal(JSON.parse(r1.stdout.trim()).decision, 'block');
    const r2 = await runGate(payload, env);
    assert.equal(JSON.parse(r2.stdout.trim()).decision, 'block');

    // Third consecutive block: circuit breaker allows the stop, with a note.
    const r3 = await runGate(payload, env);
    assert.equal(r3.code, 0);
    assert.equal(r3.stdout.trim(), '', 'breaker-tripped stop is allowed');
    assert.match(r3.stderr, /circuit breaker/i);

    // A pass resets the counter...
    makeRecordingKimi(binDir, tmp, { block: false });
    const r4 = await runGate(payload, env);
    assert.equal(r4.stdout.trim(), '');
    assert.ok(!fs.existsSync(counterFile), 'pass must reset the block counter');

    // ...so the gate blocks again afterwards instead of staying tripped.
    makeRecordingKimi(binDir, tmp, { block: true, reason: 'bad' });
    const r5 = await runGate(payload, env);
    assert.equal(JSON.parse(r5.stdout.trim()).decision, 'block');
  } finally {
    cleanupTempDir(binDir);
    cleanupTempDir(tmp);
    cleanupTempDir(dataDir);
  }
});

test('review-gate prompt is read-only and kimi runs at low thinking effort', async () => {
  const binDir = makeTempDir();
  const tmp = makeTempDir();
  const dataDir = makeTempDir();
  const { recordDir } = makeRecordingKimi(binDir, tmp, { block: false });
  const transcript = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(transcript, TRANSCRIPT);
  try {
    const r = await runGate(JSON.stringify({ transcript_path: transcript, session_id: 'sess-ro' }), gateEnv(binDir, dataDir));
    assert.equal(r.code, 0);
    const argv = fs.readFileSync(path.join(recordDir, 'argv.txt'), 'utf-8');
    assert.match(argv, /read-only/i, 'gate prompt must carry the read-only constraint');
    const shimEnv = fs.readFileSync(path.join(recordDir, 'env.txt'), 'utf-8');
    assert.match(shimEnv, /KIMI_MODEL_THINKING_EFFORT=low/, 'effort must default to low');
  } finally {
    cleanupTempDir(binDir);
    cleanupTempDir(tmp);
    cleanupTempDir(dataDir);
  }
});

test('review-gate passes --model when KIMI_REVIEW_GATE_MODEL is set', async () => {
  const binDir = makeTempDir();
  const tmp = makeTempDir();
  const dataDir = makeTempDir();
  const { recordDir } = makeRecordingKimi(binDir, tmp, { block: false });
  const transcript = path.join(tmp, 'transcript.jsonl');
  fs.writeFileSync(transcript, TRANSCRIPT);
  try {
    const env = gateEnv(binDir, dataDir, { KIMI_REVIEW_GATE_MODEL: 'k-test-model' });
    const r = await runGate(JSON.stringify({ transcript_path: transcript, session_id: 'sess-model' }), env);
    assert.equal(r.code, 0);
    const argv = fs.readFileSync(path.join(recordDir, 'argv.txt'), 'utf-8').trim().split('\n');
    const i = argv.indexOf('--model');
    assert.notEqual(i, -1, '--model flag must be present');
    assert.equal(argv[i + 1], 'k-test-model');
  } finally {
    cleanupTempDir(binDir);
    cleanupTempDir(tmp);
    cleanupTempDir(dataDir);
  }
});

// ------------------------------------------------------------------
// export-debug (degraded broker-bundle path)
// ------------------------------------------------------------------

test('export-debug bundles the broker session dir when no kimi session id exists', async () => {
  const tmpPlugin = makeTempDir();
  const outDir = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmpPlugin;

  const sessDir = path.join(tmpPlugin, 'sessions', 'sess-exp1');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, 'meta.json'), JSON.stringify({ session_id: 'sess-exp1' }));
  fs.writeFileSync(path.join(sessDir, 'output.jsonl'), '{"role":"assistant","content":"x"}\n');

  const lines = [];
  const origLog = console.log;
  console.log = (s) => lines.push(s);
  try {
    await getHandler('export-debug')({ session_id: 'sess-exp1', output: path.join(outDir, 'bundle.zip') });
  } finally {
    console.log = origLog;
    process.env.KIMI_PLUGIN_DATA = prevEnv;
  }
  const result = JSON.parse(lines.join('\n'));
  assert.equal(result.ok, true);
  assert.equal(result.via, 'broker-bundle');
  assert.ok(fs.existsSync(result.bundle), `bundle should exist at ${result.bundle}`);
  assert.match(result.bundle, /\.tar\.gz$/);
  cleanupTempDir(tmpPlugin);
  cleanupTempDir(outDir);
});
