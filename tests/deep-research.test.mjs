import test from 'node:test';
import assert from 'node:assert/strict';

import { deepResearch } from '../plugins/kimi/scripts/lib/research.mjs';

function withKey(t) {
  const prev = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = 'tvly-test';
  t.after(() => {
    if (prev === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = prev;
  });
}

function stubFetchSequence(t, steps) {
  const calls = [];
  const prevFetch = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const body = steps[Math.min(i++, steps.length - 1)];
    return { json: async () => body };
  };
  t.after(() => { globalThis.fetch = prevFetch; });
  return calls;
}

test('deepResearch creates a task, polls, and returns the capped brief', async (t) => {
  withKey(t);
  const report = 'R'.repeat(20 * 1024);
  const calls = stubFetchSequence(t, [
    { request_id: 'req-1', status: 'pending' },
    { status: 'pending' },
    { status: 'completed', content: report },
  ]);
  const prevCap = process.env.KIMI_CTX_CAP_DEEP_RESEARCH_BYTES;
  process.env.KIMI_CTX_CAP_DEEP_RESEARCH_BYTES = '1024';
  try {
    const brief = await deepResearch(['kimi', 'k3']);
    assert.match(brief, /DEEP RESEARCH BRIEF/);
    assert.ok(brief.length < 1200, 'brief must be capped (1KB + header)');
    // create call used the Bearer header and auto model
    const create = calls[0];
    assert.match(create.opts.headers.Authorization, /Bearer tvly-test/);
    assert.equal(JSON.parse(create.opts.body).model, 'auto');
    // polled the task id
    assert.ok(calls.some((c) => c.url.endsWith('/research/req-1')));
  } finally {
    if (prevCap === undefined) delete process.env.KIMI_CTX_CAP_DEEP_RESEARCH_BYTES;
    else process.env.KIMI_CTX_CAP_DEEP_RESEARCH_BYTES = prevCap;
  }
});

test('deepResearch returns empty on task failure', async (t) => {
  withKey(t);
  stubFetchSequence(t, [{ request_id: 'req-2', status: 'pending' }, { status: 'failed' }]);
  assert.equal(await deepResearch(['x']), '');
});

test('deepResearch returns empty without an API key', async (t) => {
  const prev = process.env.TAVILY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  t.after(() => { if (prev !== undefined) process.env.TAVILY_API_KEY = prev; });
  assert.equal(await deepResearch(['x']), '');
});

test('deepResearch times out instead of hanging', async (t) => {
  withKey(t);
  stubFetchSequence(t, [{ request_id: 'req-3', status: 'pending' }, { status: 'pending' }]);
  const prevTimeout = process.env.KIMI_DEEP_RESEARCH_TIMEOUT_MS;
  process.env.KIMI_DEEP_RESEARCH_TIMEOUT_MS = '120';
  try {
    const started = Date.now();
    const brief = await deepResearch(['x']);
    assert.equal(brief, '');
    assert.ok(Date.now() - started < 5000, 'must not wait the full poll backoff');
  } finally {
    if (prevTimeout === undefined) delete process.env.KIMI_DEEP_RESEARCH_TIMEOUT_MS;
    else process.env.KIMI_DEEP_RESEARCH_TIMEOUT_MS = prevTimeout;
  }
});
