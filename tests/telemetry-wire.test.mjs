import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDir, cleanupTempDir } from './helpers.mjs';
import { parseWireUsage, attachTelemetry } from '../plugins/kimi/scripts/lib/telemetry.mjs';

// Sanitized wire.jsonl lines in the real 0.28.1 format (event types observed
// from an actual session: metadata, config.update, llm.request, usage.record).
const WIRE_MAIN = [
  '{"created_at":"2026-07-19T00:00:00Z","protocol_version":1,"type":"metadata"}',
  '{"type":"llm.request","time":"2026-07-19T00:00:01Z"}',
  '{"type":"usage.record","usage":{"inputOther":30054,"output":24,"inputCacheRead":11264,"inputCacheCreation":0},"time":"2026-07-19T00:00:02Z"}',
  '{"type":"usage.record","usage":{"inputOther":100,"output":10,"inputCacheRead":0,"inputCacheCreation":50},"time":"2026-07-19T00:00:03Z"}',
].join('\n');

const WIRE_SUBAGENT = [
  '{"type":"usage.record","usage":{"inputOther":1000,"output":40,"inputCacheRead":200,"inputCacheCreation":0},"time":"2026-07-19T00:00:04Z"}',
].join('\n');

function makeKimiHome(sessionId) {
  const home = makeTempDir();
  const mainDir = path.join(home, 'sessions', 'wd_probe_abc123', sessionId, 'agents', 'main');
  const subDir = path.join(home, 'sessions', 'wd_probe_abc123', sessionId, 'agents', 'sub-1');
  fs.mkdirSync(mainDir, { recursive: true });
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(mainDir, 'wire.jsonl'), WIRE_MAIN);
  fs.writeFileSync(path.join(subDir, 'wire.jsonl'), WIRE_SUBAGENT);
  return home;
}

test('parseWireUsage sums real usage.record events across agents', async () => {
  const home = makeKimiHome('session_wire1');
  try {
    const u = await parseWireUsage('session_wire1', { kimiCodeHome: home });
    assert.ok(u, 'usage should be found');
    // main: (30054+11264+0) + (100+0+50); subagent: (1000+200+0)
    assert.equal(u.prompt_tokens, 30054 + 11264 + 100 + 50 + 1000 + 200);
    assert.equal(u.completion_tokens, 24 + 10 + 40);
    assert.equal(u.cached_tokens, 11264 + 200);
    assert.equal(u.records, 3);
  } finally {
    cleanupTempDir(home);
  }
});

test('parseWireUsage returns null for unknown sessions or empty input', async () => {
  const home = makeKimiHome('session_wire1');
  try {
    assert.equal(await parseWireUsage('session_nope', { kimiCodeHome: home }), null);
    assert.equal(await parseWireUsage('', { kimiCodeHome: home }), null);
    assert.equal(await parseWireUsage('session_wire1', { kimiCodeHome: path.join(home, 'missing') }), null);
  } finally {
    cleanupTempDir(home);
  }
});

test('attachTelemetry prefers real wire usage over the estimate', async () => {
  const home = makeKimiHome('session_wire1');
  const pluginData = makeTempDir();
  const sessDir = path.join(pluginData, 'sessions', 'sess-real');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, 'output.jsonl'), '{"role":"assistant","content":"done"}\n');
  fs.writeFileSync(
    path.join(sessDir, 'meta.json'),
    JSON.stringify({
      session_id: 'sess-real',
      kimi_session_id: 'session_wire1',
      started_at: '2026-07-19T00:00:00Z',
      finished_at: '2026-07-19T00:01:00Z',
    })
  );

  const prevHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home;
  try {
    await attachTelemetry('sess-real', path.join(pluginData, 'sessions'));
    const meta = JSON.parse(fs.readFileSync(path.join(sessDir, 'meta.json'), 'utf-8'));
    assert.equal(meta.telemetry.estimated, false, 'real usage must clear the estimated flag');
    assert.equal(meta.telemetry.prompt_tokens, 30054 + 11264 + 100 + 50 + 1000 + 200);
    assert.equal(meta.telemetry.completion_tokens, 74);
    assert.equal(meta.telemetry.usage_records, 3);
    assert.ok(meta.telemetry.estimated_cost_usd > 0);
  } finally {
    if (prevHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = prevHome;
    cleanupTempDir(home);
    cleanupTempDir(pluginData);
  }
});

test('attachTelemetry keeps the estimate when no kimi_session_id is recorded', async () => {
  const pluginData = makeTempDir();
  const sessDir = path.join(pluginData, 'sessions', 'sess-est');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, 'output.jsonl'), '{"role":"assistant","content":"some reply text"}\n');
  fs.writeFileSync(path.join(sessDir, 'meta.json'), JSON.stringify({ session_id: 'sess-est' }));

  try {
    await attachTelemetry('sess-est', path.join(pluginData, 'sessions'));
    const meta = JSON.parse(fs.readFileSync(path.join(sessDir, 'meta.json'), 'utf-8'));
    assert.equal(meta.telemetry.estimated, true);
  } finally {
    cleanupTempDir(pluginData);
  }
});
