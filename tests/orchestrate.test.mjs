import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDir, cleanupTempDir } from './helpers.mjs';
import { buildGraph, rollupBatch } from '../plugins/kimi/scripts/lib/orchestrate.mjs';

function writeTask(dir, id, { priority = 'P2', dependsOn = [], touches = [] } = {}) {
  const p = path.join(dir, `${id}.md`);
  const deps = dependsOn.length ? `depends_on:\n${dependsOn.map((d) => `  - ${d}`).join('\n')}\n` : 'depends_on: []\n';
  const tp = touches.length ? `touches_paths:\n${touches.map((t) => `  - ${t}`).join('\n')}\n` : 'touches_paths: []\n';
  fs.writeFileSync(p, `---\nformat_version: "1"\nid: ${id}\ntitle: ${id} title\npriority: ${priority}\nstatus: ready\n${deps}${tp}---\n\n## Goal\n\nDo ${id}.\n`);
  return p;
}

test('buildGraph orders dependency chains into sequential waves', async () => {
  const dir = makeTempDir();
  try {
    const a = writeTask(dir, 'A', { touches: ['src/a.js'] });
    const b = writeTask(dir, 'B', { dependsOn: ['A'], touches: ['src/b.js'] });
    const c = writeTask(dir, 'C', { dependsOn: ['B'], touches: ['src/c.js'] });
    const { waves } = await buildGraph([c, b, a]); // deliberately unordered input
    assert.equal(waves.length, 3);
    assert.deepEqual(waves.map((w) => w.map((t) => t.id)), [['A'], ['B'], ['C']]);
  } finally {
    cleanupTempDir(dir);
  }
});

test('buildGraph packs independent tasks into one wave and splits on touches_paths conflicts', async () => {
  const dir = makeTempDir();
  try {
    const a = writeTask(dir, 'A', { touches: ['src/x.js'] });
    const b = writeTask(dir, 'B', { touches: ['src/y.js'] });
    const c = writeTask(dir, 'C', { touches: ['src/x.js'] }); // conflicts with A
    const { waves, conflicts } = await buildGraph([a, b, c]);
    assert.equal(waves.length, 2);
    assert.deepEqual(waves[0].map((t) => t.id).sort(), ['A', 'B']);
    assert.deepEqual(waves[1].map((t) => t.id), ['C']);
    assert.ok(conflicts.some((c) => c.includes('A -> C')), 'conflict must be reported');
  } finally {
    cleanupTempDir(dir);
  }
});

test('buildGraph allows doc-allowlist overlaps without forcing serialization', async () => {
  const dir = makeTempDir();
  try {
    const a = writeTask(dir, 'A', { touches: ['src/a.js', 'README.md'] });
    const b = writeTask(dir, 'B', { touches: ['src/b.js', 'README.md'] });
    const { waves } = await buildGraph([a, b]);
    assert.equal(waves.length, 1, 'README.md overlap is allowlisted');
  } finally {
    cleanupTempDir(dir);
  }
});

test('buildGraph parses priority and skips unreadable task files', async () => {
  const dir = makeTempDir();
  try {
    const a = writeTask(dir, 'A', { priority: 'P0' });
    const { waves } = await buildGraph([a, path.join(dir, 'missing.md')]);
    assert.equal(waves.length, 1);
    assert.equal(waves[0][0].priority, 'P0');
  } finally {
    cleanupTempDir(dir);
  }
});

test('rollupBatch aggregates status counts, durations, tokens, and cost', () => {
  const mk = (id, status, extra = {}) => ({
    session_id: id,
    status,
    started_at: '2026-07-19T00:00:00Z',
    finished_at: '2026-07-19T00:01:00Z',
    committed: true,
    commit_sha: 'abc',
    telemetry: { prompt_tokens: 100, completion_tokens: 50, estimated_cost_usd: 0.01 },
    ...extra,
  });
  const r = rollupBatch([
    mk('s1', 'completed'),
    mk('s2', 'completed'),
    mk('s3', 'failed', { telemetry: null }),
    mk('s4', 'cancelled', { telemetry: null }),
  ]);
  assert.equal(r.sessions, 4);
  assert.equal(r.completed, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.cancelled, 1);
  assert.equal(r.pass_rate, 50);
  assert.equal(r.total_duration_sec, 240);
  assert.equal(r.total_tokens, 2 * 150);
  assert.equal(r.total_cost_usd, 0.02);
  assert.equal(r.details.length, 4);
  assert.deepEqual(r.details[0], {
    id: 's1', status: 'completed', duration_sec: 60, committed: true,
    commit_sha: 'abc', tokens: 150, cost: 0.01,
  });
});
