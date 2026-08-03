import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDir, cleanupTempDir } from './helpers.mjs';
import { captureBaseline, checkForChanges } from '../plugins/kimi/scripts/lib/monitor.mjs';

function stubFetch(t, tracking, markdown = '# Doc page') {
  const calls = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return {
      json: async () => ({
        success: true,
        data: {
          markdown,
          metadata: {},
          changeTracking: tracking,
        },
      }),
    };
  };
  t.after(() => { globalThis.fetch = prevFetch; });
  return calls;
}

function withApiKey(t) {
  const prev = process.env.FIRECRAWL_API_KEY;
  process.env.FIRECRAWL_API_KEY = 'fc-test';
  t.after(() => {
    if (prev === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = prev;
  });
}

test('captureBaseline requests changeTracking formats and stores a snapshot', async (t) => {
  withApiKey(t);
  const calls = stubFetch(t, { changeStatus: 'new' });
  const dir = makeTempDir();
  try {
    const r = await captureBaseline('https://docs.example.com/guide', dir);
    assert.ok(r, 'baseline should be captured');
    assert.equal(r.status, 'new');
    assert.match(r.content, /Doc page/);
    // The v2 contract: changeTracking as a format object with both diff modes.
    const formats = calls[0].body.formats;
    const ct = formats.find((f) => typeof f === 'object' && f.type === 'changeTracking');
    assert.ok(ct, 'changeTracking format must be requested');
    assert.deepEqual(ct.modes.sort(), ['git-diff', 'json']);
    // Local portability record exists and records the status.
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    const snap = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf-8'));
    assert.equal(snap.change_status, 'new');
  } finally {
    cleanupTempDir(dir);
  }
});

test('checkForChanges reports unchanged pages via changeStatus', async (t) => {
  withApiKey(t);
  stubFetch(t, { changeStatus: 'same', previousScrapeAt: '2026-07-18T00:00:00Z' });
  const dir = makeTempDir();
  try {
    const r = await checkForChanges('https://docs.example.com/guide', dir);
    assert.equal(r.changed, false);
    assert.equal(r.status, 'same');
    assert.equal(r.diff, '');
    assert.equal(r.previousScrapeAt, '2026-07-18T00:00:00Z');
  } finally {
    cleanupTempDir(dir);
  }
});

test('checkForChanges surfaces git-diff text and per-field JSON diffs', async (t) => {
  withApiKey(t);
  stubFetch(t, {
    changeStatus: 'changed',
    previousScrapeAt: '2026-07-18T00:00:00Z',
    diff: { text: '--- previous\n+++ current\n@@\n-old line\n+new line\n' },
    json: { 'sections[2].body': { previous: 'old', current: 'new' } },
  });
  const dir = makeTempDir();
  try {
    const r = await checkForChanges('https://docs.example.com/guide', dir);
    assert.equal(r.changed, true);
    assert.equal(r.status, 'changed');
    assert.match(r.diff, /new line/);
    assert.match(r.diffText, /old line/);
    assert.deepEqual(r.diffJson['sections[2].body'], { previous: 'old', current: 'new' });
  } finally {
    cleanupTempDir(dir);
  }
});

test('monitor functions warn-and-skip without an API key', async (t) => {
  const prev = process.env.FIRECRAWL_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  t.after(() => { if (prev !== undefined) process.env.FIRECRAWL_API_KEY = prev; });
  const dir = makeTempDir();
  try {
    assert.equal(await captureBaseline('https://x.example.com', dir), null);
    assert.equal(await checkForChanges('https://x.example.com', dir), null);
  } finally {
    cleanupTempDir(dir);
  }
});
