import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDir, cleanupTempDir } from './helpers.mjs';
import { getHandler } from '../plugins/kimi/scripts/lib/commands.mjs';
import { writeMeta, readMeta, listSessions } from '../plugins/kimi/scripts/lib/state.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const brokerPath = path.join(here, '..', 'plugins', 'kimi', 'scripts', 'broker.mjs');

function withPluginData(t, dir) {
  const prev = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.KIMI_PLUGIN_DATA;
    else process.env.KIMI_PLUGIN_DATA = prev;
  });
}

function runBroker(args, env = {}) {
  return new Promise((resolve) => {
    execFile('node', [brokerPath, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

function makeSession(root, id, meta = {}) {
  const dir = path.join(root, 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ session_id: id, status: 'completed', ...meta })
  );
  return dir;
}

async function captureConsole(fn) {
  const lines = [];
  const origLog = console.log;
  console.log = (s) => lines.push(String(s));
  try {
    await fn();
  } finally {
    console.log = origLog;
  }
  return lines;
}

// ------------------------------------------------------------------
// Positional session ids (README: /kimi:status task-abc123)
// ------------------------------------------------------------------

test('status accepts a positional session id', async (t) => {
  const tmp = makeTempDir();
  withPluginData(t, tmp);
  makeSession(tmp, 'task-abc123', { prompt: 'p' });
  try {
    const lines = await captureConsole(() => getHandler('status')({}, ['status', 'task-abc123']));
    const meta = JSON.parse(lines[0]);
    assert.equal(meta.session_id, 'task-abc123');
  } finally {
    cleanupTempDir(tmp);
  }
});

test('explicit --session-id wins over a positional id', async (t) => {
  const tmp = makeTempDir();
  withPluginData(t, tmp);
  makeSession(tmp, 'sess-flag');
  makeSession(tmp, 'sess-positional');
  try {
    const lines = await captureConsole(() =>
      getHandler('status')({ session_id: 'sess-flag' }, ['status', 'sess-positional']));
    const meta = JSON.parse(lines[0]);
    assert.equal(meta.session_id, 'sess-flag');
  } finally {
    cleanupTempDir(tmp);
  }
});

test('result accepts a positional session id', async (t) => {
  const tmp = makeTempDir();
  withPluginData(t, tmp);
  const dir = makeSession(tmp, 'sess-pos-result');
  fs.writeFileSync(path.join(dir, 'output.jsonl'), '{"role":"assistant","content":"POS-RESULT"}\n');
  try {
    const lines = await captureConsole(() => getHandler('result')({}, ['result', 'sess-pos-result']));
    assert.ok(lines.some((l) => l.includes('POS-RESULT')));
  } finally {
    cleanupTempDir(tmp);
  }
});

test('cancel accepts a positional session id and reports the resolved target', async (t) => {
  const tmp = makeTempDir();
  withPluginData(t, tmp);
  makeSession(tmp, 'sess-pos-cancel', { status: 'running' });
  try {
    const lines = await captureConsole(() => getHandler('cancel')({}, ['cancel', 'sess-pos-cancel']));
    const out = JSON.parse(lines[0]);
    assert.equal(out.status, 'cancelled');
    assert.equal(out.sessionId, 'sess-pos-cancel', 'envelope names the killed session');
    const meta = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions', 'sess-pos-cancel', 'meta.json'), 'utf-8'));
    assert.equal(meta.status, 'cancelled');
  } finally {
    cleanupTempDir(tmp);
  }
});

// ------------------------------------------------------------------
// Unknown-flag validation + required --prompt (broker subprocess)
// ------------------------------------------------------------------

test('unknown flag exits 1 with an actionable message and a suggestion', async () => {
  const r = await runBroker(['status', '--sesson-id', 'x']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Unknown flag --sesson-id for "status"/);
  assert.match(r.stderr, /Did you mean --session-id\?/);
  assert.match(r.stderr, /Valid flags: --session-id/);
});

test('unknown flag on a flagless command lists (none)', async () => {
  const r = await runBroker(['check-update', '--wat']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Unknown flag --wat for "check-update"/);
  assert.match(r.stderr, /Valid flags: \(none\)/);
});

test('dispatch without --prompt fails with a clear error', async () => {
  const r = await runBroker(['dispatch', '--background']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Missing required --prompt/);
});

test('dispatch --fresh with --resume is rejected as contradictory', async () => {
  const r = await runBroker(['dispatch', '--prompt', 'x', '--fresh', '--resume']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /--fresh and --resume are contradictory/);
});

test('--help and help exit 0', async () => {
  const a = await runBroker(['--help']);
  assert.equal(a.code, 0);
  assert.match(a.stdout, /Usage: broker\.mjs/);
  const b = await runBroker(['help']);
  assert.equal(b.code, 0);
});

// ------------------------------------------------------------------
// Corrupt meta.json: surfaced, not dropped, not "not found"
// ------------------------------------------------------------------

test('listSessions surfaces a corrupt meta as status corrupt with the parse error', async (t) => {
  const tmp = makeTempDir();
  withPluginData(t, tmp);
  makeSession(tmp, 'sess-good');
  const bad = path.join(tmp, 'sessions', 'sess-bad');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'meta.json'), '{not json');
  try {
    const sessions = await listSessions();
    const corrupt = sessions.find((s) => s.session_id === 'sess-bad');
    assert.ok(corrupt, 'corrupt session must not be dropped');
    assert.equal(corrupt.status, 'corrupt');
    assert.ok(corrupt.error, 'raw parse error preserved');
    assert.ok(sessions.some((s) => s.session_id === 'sess-good'), 'good sessions unaffected');
  } finally {
    cleanupTempDir(tmp);
  }
});

test('status on a corrupt meta says "Session meta corrupted", not "Session not found"', async () => {
  const tmp = makeTempDir();
  const bad = path.join(tmp, 'sessions', 'sess-corrupt');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'meta.json'), '{"truncated":');
  try {
    const r = await runBroker(['status', 'sess-corrupt'], { KIMI_PLUGIN_DATA: tmp });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Session meta corrupted/);
    assert.doesNotMatch(r.stdout, /Session not found/);
  } finally {
    cleanupTempDir(tmp);
  }
});

// ------------------------------------------------------------------
// Atomic writeMeta
// ------------------------------------------------------------------

test('writeMeta is atomic: no .tmp left behind, meta readable', async (t) => {
  const tmp = makeTempDir();
  withPluginData(t, tmp);
  try {
    await writeMeta('sess-atomic', { session_id: 'sess-atomic', status: 'running' });
    const dir = path.join(tmp, 'sessions', 'sess-atomic');
    assert.equal(fs.existsSync(path.join(dir, 'meta.json.tmp')), false, 'tmp file renamed away');
    const meta = await readMeta('sess-atomic');
    assert.equal(meta.status, 'running');
  } finally {
    cleanupTempDir(tmp);
  }
});

// ------------------------------------------------------------------
// Per-line JSONL fault tolerance in result extraction
// ------------------------------------------------------------------

test('result skips malformed JSONL lines instead of aborting the scan', async (t) => {
  const tmp = makeTempDir();
  withPluginData(t, tmp);
  const dir = makeSession(tmp, 'sess-jsonl');
  fs.writeFileSync(
    path.join(dir, 'output.jsonl'),
    '{"role":"assistant","content":"FIRST"}\n{"role":"assistant","content":"SECOND"}\n{broken line\n'
  );
  try {
    const lines = await captureConsole(() => getHandler('result')({ session_id: 'sess-jsonl' }));
    assert.ok(lines.some((l) => l.includes('SECOND')), 'malformed tail line must not hide the last good message');
  } finally {
    cleanupTempDir(tmp);
  }
});

// ------------------------------------------------------------------
// report --tag must not apply the default 24h window
// ------------------------------------------------------------------

test('report --tag finds sessions older than 24h', async (t) => {
  const tmp = makeTempDir();
  withPluginData(t, tmp);
  makeSession(tmp, 'sess-old-tagged', {
    tag: 'pilot',
    started_at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
  });
  try {
    const lines = await captureConsole(() => getHandler('report')({ tag: 'pilot', format: 'json' }));
    const rollup = JSON.parse(lines[0]);
    assert.equal(rollup.sessions, 1, 'tag lookup must search all history, not just the last 24h');
    assert.equal(rollup.details[0].id, 'sess-old-tagged');
  } finally {
    cleanupTempDir(tmp);
  }
});
