import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDir, cleanupTempDir } from './helpers.mjs';
import { getLatestSessionForRepo } from '../plugins/kimi/scripts/lib/state.mjs';
import { getHandler } from '../plugins/kimi/scripts/lib/commands.mjs';
import { codexReview } from '../plugins/kimi/scripts/lib/codex-bridge.mjs';
import { discoverContext } from '../plugins/kimi/scripts/lib/context.mjs';
import { startBackground } from '../plugins/kimi/scripts/lib/job-control.mjs';

function withPluginData(t, dir) {
  const prev = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.KIMI_PLUGIN_DATA;
    else process.env.KIMI_PLUGIN_DATA = prev;
  });
}

// ------------------------------------------------------------------
// 1. getLatestSessionForRepo must not leak sessions across repos
// ------------------------------------------------------------------

test('getLatestSessionForRepo returns null instead of another repo\'s session', async (t) => {
  const tmp = makeTempDir();
  withPluginData(t, tmp);
  const sessDir = path.join(tmp, 'sessions', 'sess-a');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessDir, 'meta.json'),
    JSON.stringify({ session_id: 'sess-a', repo_path: path.resolve('/repo/a'), started_at: '2026-07-19T00:00:00Z', status: 'completed' })
  );
  try {
    assert.equal(await getLatestSessionForRepo('/repo/b'), null, 'cross-repo fallback must be gone');
    const own = await getLatestSessionForRepo('/repo/a');
    assert.equal(own?.session_id, 'sess-a', 'same-repo lookup still works');
  } finally {
    cleanupTempDir(tmp);
  }
});

// ------------------------------------------------------------------
// 2. cmdResult honors KIMI_PLUGIN_DATA
// ------------------------------------------------------------------

test('result reads sessions from KIMI_PLUGIN_DATA, not a hardcoded home path', async (t) => {
  const tmp = makeTempDir();
  withPluginData(t, tmp);
  const sessDir = path.join(tmp, 'sessions', 'sess-res');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, 'output.jsonl'), '{"role":"assistant","content":"RESULT-BODY"}\n');
  fs.writeFileSync(path.join(sessDir, 'meta.json'), JSON.stringify({ session_id: 'sess-res' }));

  const lines = [];
  const origLog = console.log;
  console.log = (s) => lines.push(s);
  try {
    await getHandler('result')({ session_id: 'sess-res' });
  } finally {
    console.log = origLog;
    cleanupTempDir(tmp);
  }
  assert.ok(lines.some((l) => l.includes('RESULT-BODY')), 'result body must come from the plugin-data session dir');
});

// ------------------------------------------------------------------
// 3. codex-bridge verdict parsing
// ------------------------------------------------------------------

function codexShim(t, body) {
  const dir = makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const shim = path.join(dir, 'codex-fake');
  fs.writeFileSync(shim, `#!/usr/bin/env bash\ncat <<'EOF'\n${body}\nEOF\n`);
  fs.chmodSync(shim, 0o755);
  return shim;
}

test('codexReview parses APPROVE_COMMIT as a first-class verdict', async (t) => {
  const prev = process.env.CODEX_CMD;
  process.env.CODEX_CMD = codexShim(t, 'looks fine\nVERDICT: APPROVE_COMMIT');
  try {
    const r = await codexReview('review this');
    assert.equal(r.verdict, 'APPROVE_COMMIT');
  } finally {
    if (prev === undefined) delete process.env.CODEX_CMD;
    else process.env.CODEX_CMD = prev;
  }
});

test('codexReview degrades to SKIP when the binary is missing', async (t) => {
  const prev = process.env.CODEX_CMD;
  process.env.CODEX_CMD = '/nonexistent/codex-bin';
  try {
    const r = await codexReview('review this');
    assert.equal(r.verdict, 'SKIP');
    assert.match(r.reason, /Codex unavailable/);
  } finally {
    if (prev === undefined) delete process.env.CODEX_CMD;
    else process.env.CODEX_CMD = prev;
  }
});

// ------------------------------------------------------------------
// 4. context.mjs applies ALL globs of a rule, not just the first
// ------------------------------------------------------------------

test('discoverContext matches a rule via any of its globs', async () => {
  const repo = makeTempDir();
  const rulesDir = path.join(repo, '.claude', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.writeFileSync(
    path.join(rulesDir, 'multi.md'),
    '---\nglobs:\n  - "src/**"\n  - "lib/**"\n---\n\n# Multi rule\n\n- rule body here\n'
  );
  try {
    const ctx = await discoverContext(['lib/parsers/x.js'], repo);
    assert.match(ctx, /Multi rule/, 'rule must match via its SECOND glob');
  } finally {
    cleanupTempDir(repo);
  }
});

// ------------------------------------------------------------------
// 5. background dispatch enforces the wall-clock cap (not just idle)
// ------------------------------------------------------------------

test('startBackground kills a chatty-but-endless crank at the wall-clock cap', async () => {
  const tmpPlugin = makeTempDir();
  const tmpRepo = makeTempDir();
  const binDir = makeTempDir();
  // Shim that chatters every 50ms (never idle) but never exits.
  const shim = path.join(binDir, 'kimi');
  fs.writeFileSync(shim, '#!/usr/bin/env bash\nwhile true; do echo "{\\"role\\":\\"assistant\\",\\"content\\":\\"tick\\"}"; sleep 0.05; done\n');
  fs.chmodSync(shim, 0o755);

  const prevData = process.env.KIMI_PLUGIN_DATA;
  const prevHard = process.env.KIMI_DISPATCH_TIMEOUT_MS;
  const prevIdle = process.env.KIMI_IDLE_TIMEOUT_MS;
  const prevPath = process.env.PATH;
  process.env.KIMI_PLUGIN_DATA = tmpPlugin;
  process.env.KIMI_DISPATCH_TIMEOUT_MS = '400';
  process.env.KIMI_IDLE_TIMEOUT_MS = '60000'; // idle must NOT fire first
  process.env.PATH = `${binDir}:${prevPath}`;

  try {
    await startBackground({ sessionId: 'wallclock-1', prompt: 'p', repoPath: tmpRepo });
    // Wait for the close handler to settle into a terminal state (cap 400ms +
    // kill + serialized meta writes). Poll on terminal status, not just the
    // timed_out flag — the flag lands before the close handler finishes.
    let meta = null;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        meta = JSON.parse(fs.readFileSync(path.join(tmpPlugin, 'sessions', 'wallclock-1', 'meta.json'), 'utf-8'));
        if (['failed', 'completed', 'cancelled'].includes(meta.status)) break;
      } catch { /* not yet */ }
    }
    assert.ok(meta, 'meta should exist');
    assert.equal(meta.timed_out, true, 'crank must be flagged timed_out');
    assert.equal(meta.reason, 'wall-clock-timeout', 'the wall clock (not the idle watchdog) must fire');
    assert.equal(meta.status, 'failed');
  } finally {
    process.env.PATH = prevPath;
    process.env.KIMI_PLUGIN_DATA = prevData;
    if (prevHard === undefined) delete process.env.KIMI_DISPATCH_TIMEOUT_MS;
    else process.env.KIMI_DISPATCH_TIMEOUT_MS = prevHard;
    if (prevIdle === undefined) delete process.env.KIMI_IDLE_TIMEOUT_MS;
    else process.env.KIMI_IDLE_TIMEOUT_MS = prevIdle;
    cleanupTempDir(tmpPlugin);
    cleanupTempDir(tmpRepo);
    cleanupTempDir(binDir);
  }
});
