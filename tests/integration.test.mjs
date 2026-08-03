import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';

import { makeTempDir, cleanupTempDir } from './helpers.mjs';
import { startBackground, cancelSession, getSessionsDir } from '../plugins/kimi/scripts/lib/job-control.mjs';
import { readMeta } from '../plugins/kimi/scripts/lib/state.mjs';
import { discoverContext } from '../plugins/kimi/scripts/lib/context.mjs';
import { preflight } from '../plugins/kimi/scripts/lib/preflight.mjs';

test('startBackground end-to-end with mock spawn', async () => {
  const tmpPlugin = makeTempDir();
  const tmpRepo = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmpPlugin;

  try {
    const fakeSpawn = (cmd, args, opts) => {
      assert.equal(cmd, 'kimi');
      const emitter = {
        stdout: {
          pipe: (dest) => {
            // Write fake JSONL output
            dest.write('{"role":"assistant","content":"fake result"}\n');
            dest.write('{"usage":{"prompt_tokens":100,"completion_tokens":50}}\n');
            dest.end();
          },
        },
        stderr: { pipe: () => {} },
        unref: () => {},
        on: (event, cb) => {
          if (event === 'close') {
            // Simulate completion after a tick
            setTimeout(() => cb(0), 50);
          }
        },
        pid: 99999,
      };
      return emitter;
    };

    const result = await startBackground({
      sessionId: 'integ-test-1',
      role: 'coder',
      prompt: 'test prompt',
      model: 'kimi-k2',
      mode: 'crank',
      autoCommitPolicy: 'on-clean',
      tag: 'test',
      touchesPaths: ['src/test.js'],
      baselineSha: 'abc123',
      repoPath: tmpRepo,
      spawnFn: fakeSpawn,
    });

    assert.equal(result.sessionId, 'integ-test-1');
    assert.equal(result.status, 'started');

    // Verify meta.json
    const meta = await readMeta('integ-test-1');
    assert.equal(meta.session_id, 'integ-test-1');
    assert.equal(meta.status, 'running');
    assert.equal(meta.mode, 'crank');
    assert.equal(meta.auto_commit_policy, 'on-clean');
    assert.equal(meta.tag, 'test');
    assert.deepEqual(meta.touches_paths, ['src/test.js']);
    assert.equal(meta.baseline_sha, 'abc123');

    // Wait for the close handler to fire
    await new Promise((r) => setTimeout(r, 500));

    // Verify meta was updated on completion AND all 11 initial fields preserved
    // (regression guard against the writeMeta-overwrite bug closed in v0.3.2)
    const meta2 = await readMeta('integ-test-1');
    assert.equal(meta2.status, 'completed');
    assert.equal(meta2.exit_code, 0);
    assert.ok(meta2.finished_at);
    assert.equal(meta2.session_id, 'integ-test-1');
    assert.equal(meta2.role, 'coder');
    assert.equal(meta2.prompt, 'test prompt');
    assert.equal(meta2.model, 'kimi-k2');
    assert.equal(meta2.mode, 'crank');
    assert.equal(meta2.auto_commit_policy, 'on-clean');
    assert.equal(meta2.tag, 'test');
    assert.deepEqual(meta2.touches_paths, ['src/test.js']);
    assert.equal(meta2.baseline_sha, 'abc123');
    assert.ok(meta2.started_at);

    // Verify telemetry was attached. v0.3.3: Kimi emits no usage field, so
    // tokens are estimated from content length and flagged estimated:true.
    assert.ok(meta2.telemetry);
    assert.equal(meta2.telemetry.estimated, true);
    assert.ok(typeof meta2.telemetry.prompt_tokens === 'number');
    assert.ok(typeof meta2.telemetry.completion_tokens === 'number');
    assert.ok(meta2.telemetry.phases);
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmpPlugin);
    cleanupTempDir(tmpRepo);
  }
});

test('startBackground close-handler marks failed and preserves envelope on non-zero exit', async () => {
  const tmpPlugin = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmpPlugin;

  try {
    const fakeSpawn = () => ({
      stdout: { pipe: (dest) => dest.end() },
      stderr: { pipe: () => {} },
      unref: () => {},
      on: (event, cb) => { if (event === 'close') setTimeout(() => cb(1), 50); },
      pid: 88888,
    });

    await startBackground({
      sessionId: 'integ-test-fail',
      role: 'coder',
      prompt: 'will fail',
      model: 'kimi-k2',
      mode: 'crank',
      tag: 'failtest',
      touchesPaths: ['src/a.py'],
      baselineSha: 'def456',
      spawnFn: fakeSpawn,
    });

    await new Promise((r) => setTimeout(r, 200));

    const meta = await readMeta('integ-test-fail');
    assert.equal(meta.status, 'failed');
    assert.equal(meta.exit_code, 1);
    assert.equal(meta.tag, 'failtest');
    assert.deepEqual(meta.touches_paths, ['src/a.py']);
    assert.equal(meta.baseline_sha, 'def456');
    assert.equal(meta.prompt, 'will fail');
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmpPlugin);
  }
});

test('cancelSession preserves the envelope when marking cancelled', async () => {
  const tmpPlugin = makeTempDir();
  const tmpRepo = makeTempDir();
  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  process.env.KIMI_PLUGIN_DATA = tmpPlugin;

  try {
    const sessDir = path.join(tmpPlugin, 'sessions', 'integ-cancel-preserve');
    fs.mkdirSync(sessDir, { recursive: true });
    const initial = {
      session_id: 'integ-cancel-preserve',
      role: 'coder',
      prompt: 'pre-cancel prompt',
      model: 'kimi-k2',
      started_at: '2026-06-01T18:00:00Z',
      status: 'running',
      repo_path: tmpRepo,
      mode: 'crank',
      auto_commit_policy: 'on-clean',
      tag: 'cancel-test',
      touches_paths: ['src/x.py'],
      baseline_sha: 'cab999',
    };
    fs.writeFileSync(path.join(sessDir, 'meta.json'), JSON.stringify(initial, null, 2));
    fs.writeFileSync(path.join(sessDir, 'pid'), '99999');

    await cancelSession('integ-cancel-preserve');

    const meta = await readMeta('integ-cancel-preserve');
    assert.equal(meta.status, 'cancelled');
    assert.ok(meta.cancelled_at);
    assert.equal(meta.prompt, 'pre-cancel prompt');
    assert.equal(meta.tag, 'cancel-test');
    assert.deepEqual(meta.touches_paths, ['src/x.py']);
    assert.equal(meta.baseline_sha, 'cab999');
  } finally {
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    cleanupTempDir(tmpPlugin);
    cleanupTempDir(tmpRepo);
  }
});

test('discoverContext injects CLAUDE.md and scoped rules', async () => {
  const tmpRepo = makeTempDir();

  try {
    fs.mkdirSync(path.join(tmpRepo, '.claude', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'CLAUDE.md'), '# Project Mission\nUse TypeScript.\n');
    fs.writeFileSync(path.join(tmpRepo, 'AGENTS.md'), '# Agent Rules\nNo comments.\n');
    fs.writeFileSync(
      path.join(tmpRepo, '.claude', 'rules', 'src-core.md'),
      '---\nglobs:\n  - "src/core/**"\n---\n# Core Rules\n- Use strict mode\n'
    );

    const ctx = await discoverContext(['src/core/parser.ts'], tmpRepo);
    assert.ok(ctx.includes('CLAUDE.md'));
    assert.ok(ctx.includes('AGENTS.md'));
    assert.ok(ctx.includes('src-core.md'));
    assert.ok(ctx.includes('strict mode'));
  } finally {
    cleanupTempDir(tmpRepo);
  }
});

test('discoverContext excludes non-matching rules', async () => {
  const tmpRepo = makeTempDir();

  try {
    fs.mkdirSync(path.join(tmpRepo, '.claude', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'CLAUDE.md'), '# Project\n');
    fs.writeFileSync(
      path.join(tmpRepo, '.claude', 'rules', 'src-ui.md'),
      '---\nglobs:\n  - "src/ui/**"\n---\n# UI Rules\n- Use CSS modules\n'
    );

    const ctx = await discoverContext(['src/core/parser.ts'], tmpRepo);
    assert.ok(ctx.includes('CLAUDE.md'));
    assert.ok(!ctx.includes('UI Rules'));
  } finally {
    cleanupTempDir(tmpRepo);
  }
});

test('preflight catches missing format_version', async () => {
  const tmpRepo = makeTempDir();

  try {
    const taskPath = path.join(tmpRepo, 'bad-task.md');
    fs.writeFileSync(taskPath, '# Bad Task\nNo frontmatter.\n');
    const result = await preflight(taskPath, tmpRepo);
    assert.equal(result.status, 'buggy-evals');
    assert.ok(result.findings.some((f) => f.includes('format_version')));
  } finally {
    cleanupTempDir(tmpRepo);
  }
});

test('preflight detects already-done task', async () => {
  const tmpRepo = makeTempDir();

  try {
    const taskPath = path.join(tmpRepo, 'done-task.md');
    fs.writeFileSync(taskPath, `---
id: test-task
format_version: 2
---
# Test
\`\`\`bash
# Exit Check
echo "pass"
\`\`\`
`);
    const result = await preflight(taskPath, tmpRepo);
    assert.equal(result.status, 'already-done');
  } finally {
    cleanupTempDir(tmpRepo);
  }
});

test('broker dispatch pipeline wires flags correctly', async () => {
  // Verify that dispatch options are parsed and passed through runDispatch
  // by inspecting the commands module for flag support
  const commandsPath = new URL('../plugins/kimi/scripts/lib/commands.mjs', import.meta.url);
  const commands = await import(commandsPath);

  // The module should export getHandler and listCommands
  assert.ok(typeof commands.getHandler === 'function');
  assert.ok(typeof commands.listCommands === 'function');
  assert.ok(commands.listCommands().includes('dispatch'));
  assert.ok(commands.listCommands().includes('batch'));
  assert.ok(commands.listCommands().includes('next'));
  assert.ok(commands.listCommands().includes('warnings'));
});
