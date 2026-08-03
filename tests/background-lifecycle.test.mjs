import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDir, cleanupTempDir } from './helpers.mjs';
import {
  writeMeta,
  readMeta,
  listSessions,
  isRunning,
  reconcileDeadSession,
} from '../plugins/kimi/scripts/lib/state.mjs';
import { spawnSupervisor } from '../plugins/kimi/scripts/lib/job-control.mjs';
import { invokeKimi, watchSession } from '../plugins/kimi/scripts/lib/kimi.mjs';
import { batchWaitDefaultMs } from '../plugins/kimi/scripts/lib/commands.mjs';
import { warn, readWarnings } from '../plugins/kimi/scripts/lib/warn.mjs';

function withEnv(t, key, value) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

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

function makeSessionDir(pluginRoot, id) {
  const dir = path.join(pluginRoot, 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// pid that does not exist (macOS max pid is 99998; matches existing tests)
const DEAD_PID = 99999;

// ------------------------------------------------------------------
// Reconciliation janitor (dead supervisor pid → interrupted + salvage commit)
// ------------------------------------------------------------------

test('listSessions reconciles a running session whose supervisor pid is dead', async (t) => {
  const tmpPlugin = makeTempDir();
  const repo = initRepo();
  withEnv(t, 'KIMI_PLUGIN_DATA', tmpPlugin);
  t.after(() => { cleanupTempDir(tmpPlugin); cleanupTempDir(repo); });

  // Partial work left behind by the dead crank.
  fs.writeFileSync(path.join(repo, 'partial.txt'), 'unfinished\n');

  const sessDir = makeSessionDir(tmpPlugin, 'reconcile-1');
  fs.writeFileSync(path.join(sessDir, 'meta.json'), JSON.stringify({
    session_id: 'reconcile-1',
    status: 'running',
    started_at: new Date().toISOString(),
    repo_path: repo,
    auto_commit_policy: 'on',
    tag: 'reconcile-test',
    touches_paths: [],
  }));
  fs.writeFileSync(path.join(sessDir, 'pid'), `${DEAD_PID} ${Date.now()}`);

  const sessions = await listSessions();
  const s = sessions.find((x) => x.session_id === 'reconcile-1');
  assert.ok(s, 'session listed');
  assert.equal(s.status, 'interrupted');
  assert.equal(s.reason, 'supervisor-died');
  assert.ok(s.finished_at);
  assert.equal(s.running, false);

  // Salvage commit happened per the session's own policy ('on').
  const meta = await readMeta('reconcile-1');
  assert.equal(meta.committed, true);
  assert.match(meta.commit_sha, /^[0-9a-f]{40}$/);
  const committedFiles = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: repo, encoding: 'utf-8' });
  assert.match(committedFiles, /partial\.txt/);
});

test('janitor leaves a session with a LIVE pid alone', async (t) => {
  const tmpPlugin = makeTempDir();
  withEnv(t, 'KIMI_PLUGIN_DATA', tmpPlugin);
  t.after(() => cleanupTempDir(tmpPlugin));

  const sessDir = makeSessionDir(tmpPlugin, 'live-1');
  fs.writeFileSync(path.join(sessDir, 'meta.json'), JSON.stringify({
    session_id: 'live-1',
    status: 'running',
    started_at: new Date().toISOString(),
  }));
  // This test process is alive — a valid supervisor stand-in.
  fs.writeFileSync(path.join(sessDir, 'pid'), `${process.pid} ${Date.now()}`);

  const sessions = await listSessions();
  const s = sessions.find((x) => x.session_id === 'live-1');
  assert.equal(s.status, 'running', 'live session must not be reconciled');
  assert.equal(s.running, true);
});

test('janitor leaves a running session with NO pid file alone (foreground crank)', async (t) => {
  const tmpPlugin = makeTempDir();
  withEnv(t, 'KIMI_PLUGIN_DATA', tmpPlugin);
  t.after(() => cleanupTempDir(tmpPlugin));

  const sessDir = makeSessionDir(tmpPlugin, 'fg-1');
  fs.writeFileSync(path.join(sessDir, 'meta.json'), JSON.stringify({
    session_id: 'fg-1',
    status: 'running',
    started_at: new Date().toISOString(),
  }));

  const sessions = await listSessions();
  const s = sessions.find((x) => x.session_id === 'fg-1');
  assert.equal(s.status, 'running', 'no pid file ≠ dead — foreground sessions have no pid');
});

// ------------------------------------------------------------------
// watchSession exits on a dead pid even when meta says running
// ------------------------------------------------------------------

test('watchSession exits when the supervisor pid is dead', async (t) => {
  const tmpPlugin = makeTempDir();
  withEnv(t, 'KIMI_PLUGIN_DATA', tmpPlugin);
  t.after(() => cleanupTempDir(tmpPlugin));

  const sessDir = makeSessionDir(tmpPlugin, 'watch-dead-1');
  fs.writeFileSync(path.join(sessDir, 'output.jsonl'), '');
  fs.writeFileSync(path.join(sessDir, 'meta.json'), JSON.stringify({
    session_id: 'watch-dead-1',
    status: 'running',
    started_at: new Date().toISOString(),
  }));
  fs.writeFileSync(path.join(sessDir, 'pid'), String(DEAD_PID));

  const events = [];
  const result = await Promise.race([
    watchSession('watch-dead-1', { onEvent: (l) => events.push(l) }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('watchSession did not exit on dead pid')), 8000)),
  ]);

  assert.equal(result.exitCode, 0);
  assert.ok(events.some((l) => l.includes('interrupted')), `expected [done] interrupted, got: ${events.join(', ')}`);
  const meta = await readMeta('watch-dead-1');
  assert.equal(meta.status, 'interrupted');
  assert.equal(meta.reason, 'supervisor-died');
});

// ------------------------------------------------------------------
// Detached supervisor end-to-end (real broker re-exec + shim kimi)
// ------------------------------------------------------------------

test('spawnSupervisor returns immediately and the detached supervisor drives the crank to completion', async (t) => {
  const tmpPlugin = makeTempDir();
  const repo = initRepo();
  const binDir = makeTempDir();
  withEnv(t, 'KIMI_PLUGIN_DATA', tmpPlugin);
  withEnv(t, 'PATH', `${binDir}:${process.env.PATH}`);
  withEnv(t, 'KIMI_NOTIFY_CMD', '/usr/bin/true');
  t.after(() => { cleanupTempDir(tmpPlugin); cleanupTempDir(repo); cleanupTempDir(binDir); });

  const shim = path.join(binDir, 'kimi');
  fs.writeFileSync(shim, '#!/usr/bin/env bash\necho \'{"role":"assistant","content":"supervised ok"}\'\nexit 0\n');
  fs.chmodSync(shim, 0o755);

  await writeMeta('sup-1', {
    session_id: 'sup-1',
    role: 'coder',
    prompt: 'do it',
    model: '',
    started_at: new Date().toISOString(),
    status: 'running',
    repo_path: repo,
    mode: 'crank',
    auto_commit_policy: 'off',
    tag: '',
    touches_paths: [],
    baseline_sha: '',
  });

  const result = await spawnSupervisor({ sessionId: 'sup-1', repoPath: repo });
  assert.equal(result.status, 'started');
  assert.ok(result.pid > 0);

  // pid file: new "<pid> <epoch_ms>" format, and it is the SUPERVISOR's pid.
  const pidRaw = fs.readFileSync(path.join(tmpPlugin, 'sessions', 'sup-1', 'pid'), 'utf-8').trim();
  assert.match(pidRaw, /^\d+ \d+$/);
  assert.equal(Number(pidRaw.split(' ')[0]), result.pid);

  // Poll until the supervisor finishes the crank (or time out).
  let meta;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    meta = await readMeta('sup-1');
    if (meta.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(meta.status, 'completed', `crank should complete, got ${meta.status}`);
  assert.equal(meta.exit_code, 0);

  const output = fs.readFileSync(path.join(tmpPlugin, 'sessions', 'sup-1', 'output.jsonl'), 'utf-8');
  assert.match(output, /supervised ok/);

  // The supervisor must EXIT when the crank is done — no lingering process.
  let supervisorGone = false;
  const exitDeadline = Date.now() + 10000;
  while (Date.now() < exitDeadline) {
    try {
      process.kill(result.pid, 0);
      await new Promise((r) => setTimeout(r, 250));
    } catch {
      supervisorGone = true;
      break;
    }
  }
  assert.equal(supervisorGone, true, 'detached supervisor should exit after the crank closes');
});

// ------------------------------------------------------------------
// Batch wait default honors KIMI_DISPATCH_TIMEOUT_MS + 60s margin
// ------------------------------------------------------------------

test('batchWaitDefaultMs is the crank hard cap plus a 60s margin', (t) => {
  withEnv(t, 'KIMI_DISPATCH_TIMEOUT_MS', undefined);
  assert.equal(batchWaitDefaultMs(), 30 * 60 * 1000 + 60000);

  process.env.KIMI_DISPATCH_TIMEOUT_MS = '5000';
  assert.equal(batchWaitDefaultMs(), 65000);
});

// ------------------------------------------------------------------
// Idle watchdog: mtime liveness (quiet stdout, active log file)
// ------------------------------------------------------------------

test('idle watchdog treats recent kimi.log mtime as activity', async (t) => {
  const tmpPlugin = makeTempDir();
  const binDir = makeTempDir();
  withEnv(t, 'KIMI_PLUGIN_DATA', tmpPlugin);
  withEnv(t, 'PATH', `${binDir}:${process.env.PATH}`);
  withEnv(t, 'KIMI_IDLE_TIMEOUT_MS', '400');
  t.after(() => { cleanupTempDir(tmpPlugin); cleanupTempDir(binDir); });

  const sessionId = 'idle-mtime-1';
  const logFile = path.join(tmpPlugin, 'sessions', sessionId, 'kimi.log');
  // Quiet on stdout for ~2s (4x the idle window) but touches kimi.log
  // constantly — a stand-in for a long quiet Shell tool call.
  const shim = path.join(binDir, 'kimi');
  fs.writeFileSync(shim, `#!/usr/bin/env bash
echo '{"role":"assistant","content":"start"}'
end=$((SECONDS+2))
while [ $SECONDS -lt $end ]; do touch "$KIMI_SHIM_TOUCH"; sleep 0.1; done
echo '{"role":"assistant","content":"survived"}'
exit 0
`);
  fs.chmodSync(shim, 0o755);
  withEnv(t, 'KIMI_SHIM_TOUCH', logFile);

  const result = await invokeKimi({ prompt: 'quiet-tool', sessionId, cwd: tmpPlugin });
  assert.equal(result.timedOut, false, 'mtime activity must not count as idle');
  assert.equal(result.exitCode, 0);
  assert.equal(result.finalMessage, 'survived');
});

// ------------------------------------------------------------------
// Retry on exit 75: transcript survives across attempts
// ------------------------------------------------------------------

test('exit 75 retries with an APPENDED transcript and honors KIMI_RETRY_BACKOFF_MS', async (t) => {
  const tmpPlugin = makeTempDir();
  const binDir = makeTempDir();
  withEnv(t, 'KIMI_PLUGIN_DATA', tmpPlugin);
  withEnv(t, 'PATH', `${binDir}:${process.env.PATH}`);
  withEnv(t, 'KIMI_RETRY_BACKOFF_MS', '1');
  t.after(() => { cleanupTempDir(tmpPlugin); cleanupTempDir(binDir); });

  const countFile = path.join(tmpPlugin, 'shim-count');
  const shim = path.join(binDir, 'kimi');
  fs.writeFileSync(shim, `#!/usr/bin/env bash
n=$(cat "$KIMI_SHIM_COUNT" 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > "$KIMI_SHIM_COUNT"
echo "{\"role\":\"assistant\",\"content\":\"attempt $n\"}"
if [ "$n" -eq 1 ]; then exit 75; fi
exit 0
`);
  fs.chmodSync(shim, 0o755);
  withEnv(t, 'KIMI_SHIM_COUNT', countFile);

  const sessionId = 'retry-75-1';
  const result = await invokeKimi({ prompt: 'flaky', sessionId, cwd: tmpPlugin });
  assert.equal(result.retries, 1, 'one transient failure → one retry');
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);

  const transcript = fs.readFileSync(result.outputFile, 'utf-8');
  assert.match(transcript, /attempt 1/, 'attempt-1 output must survive the retry');
  assert.match(transcript, /attempt 2/);
});

// ------------------------------------------------------------------
// isRunning hardening (pid reuse / stale / garbage pid files)
// ------------------------------------------------------------------

test('isRunning trusts an old-format plain pid that is alive', async (t) => {
  const tmpPlugin = makeTempDir();
  withEnv(t, 'KIMI_PLUGIN_DATA', tmpPlugin);
  t.after(() => cleanupTempDir(tmpPlugin));

  const sessDir = makeSessionDir(tmpPlugin, 'pid-legacy');
  fs.writeFileSync(path.join(sessDir, 'pid'), String(process.pid)); // no epoch
  assert.equal(await isRunning('pid-legacy'), true);
});

test('isRunning trusts the new "<pid> <epoch>" format', async (t) => {
  const tmpPlugin = makeTempDir();
  withEnv(t, 'KIMI_PLUGIN_DATA', tmpPlugin);
  t.after(() => cleanupTempDir(tmpPlugin));

  const sessDir = makeSessionDir(tmpPlugin, 'pid-new');
  fs.writeFileSync(path.join(sessDir, 'pid'), `${process.pid} ${Date.now()}`);
  assert.equal(await isRunning('pid-new'), true);
});

test('isRunning rejects a garbage pid file and a stale dead pid', async (t) => {
  const tmpPlugin = makeTempDir();
  withEnv(t, 'KIMI_PLUGIN_DATA', tmpPlugin);
  t.after(() => cleanupTempDir(tmpPlugin));

  const garbage = makeSessionDir(tmpPlugin, 'pid-garbage');
  fs.writeFileSync(path.join(garbage, 'pid'), 'not-a-pid');
  assert.equal(await isRunning('pid-garbage'), false);

  const stale = makeSessionDir(tmpPlugin, 'pid-stale');
  fs.writeFileSync(path.join(stale, 'pid'), `${DEAD_PID} 1700000000000`);
  assert.equal(await isRunning('pid-stale'), false);
});

test('reconcileDeadSession is a no-op for a terminal session', async (t) => {
  const tmpPlugin = makeTempDir();
  withEnv(t, 'KIMI_PLUGIN_DATA', tmpPlugin);
  t.after(() => cleanupTempDir(tmpPlugin));

  await writeMeta('term-1', { session_id: 'term-1', status: 'completed', started_at: new Date().toISOString() });
  const sessDir = makeSessionDir(tmpPlugin, 'term-1');
  fs.writeFileSync(path.join(sessDir, 'pid'), String(DEAD_PID));

  const meta = await reconcileDeadSession('term-1');
  assert.equal(meta.status, 'completed');
});

// ------------------------------------------------------------------
// Single-session `broker status <id>` reconciles a dead supervisor too
// (the readMeta path used to bypass the listSessions janitor)
// ------------------------------------------------------------------

test('broker status <id> marks a dead-supervisor session interrupted', async (t) => {
  const tmpPlugin = makeTempDir();
  withEnv(t, 'KIMI_PLUGIN_DATA', tmpPlugin);
  t.after(() => cleanupTempDir(tmpPlugin));

  const sessDir = makeSessionDir(tmpPlugin, 'cli-dead');
  fs.writeFileSync(
    path.join(sessDir, 'meta.json'),
    JSON.stringify({ session_id: 'cli-dead', status: 'running', started_at: new Date().toISOString() })
  );
  fs.writeFileSync(path.join(sessDir, 'pid'), `${DEAD_PID} 1700000000000`);

  const brokerPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'plugins/kimi/scripts/broker.mjs');
  const out = execFileSync('node', [brokerPath, 'status', 'cli-dead'], {
    env: { ...process.env, KIMI_PLUGIN_DATA: tmpPlugin },
    encoding: 'utf-8',
  });
  const meta = JSON.parse(out);
  assert.equal(meta.status, 'interrupted');
  assert.equal(meta.reason, 'supervisor-died');
  assert.equal(meta.running, false);
});

// ------------------------------------------------------------------
// warn() lands under the session's repo, not process.cwd()
// ------------------------------------------------------------------

test('warn() writes under the given repo path .kimi/state', async (t) => {
  const tmpRepo = makeTempDir();
  t.after(() => cleanupTempDir(tmpRepo));

  await warn('close-handler', new Error('boom'), 'warning', tmpRepo);
  const warnings = await readWarnings(tmpRepo);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].module, 'close-handler');
  assert.equal(warnings[0].error, 'boom');
  assert.equal(warnings[0].severity, 'warning');
});
