import test from 'node:test';
import assert from 'node:assert/strict';

import { context7Docs } from '../plugins/kimi/scripts/lib/context7.mjs';
import { searchLibraryDocs } from '../plugins/kimi/scripts/lib/docs.mjs';

function fetchReturning(responses) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts });
    for (const [match, response] of responses) {
      if (String(url).includes(match)) {
        return {
          json: async () => response,
          text: async () => (typeof response === 'string' ? response : JSON.stringify(response)),
        };
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  impl.calls = calls;
  return impl;
}

const SNIPPETS = '# Express\n\n## Routing\n\n`app.get(path, handler)` registers a route...\n\n'.repeat(3);

test('context7Docs resolves a library id and returns doc snippets', async () => {
  const fetchImpl = fetchReturning([
    ['/search?query=express', { results: [{ id: '/expressjs/express', title: 'Express' }] }],
    ['/expressjs/express', SNIPPETS],
  ]);
  const docs = await context7Docs('express', { fetchImpl });
  assert.ok(docs, 'docs should be found');
  assert.equal(docs.title, 'Express');
  assert.match(docs.url, /context7\.com\/expressjs\/express/);
  assert.match(docs.content, /Routing/);
});

test('context7Docs returns null when the library is unknown', async () => {
  const fetchImpl = fetchReturning([['/search?query=nope-lib', { results: [] }]]);
  assert.equal(await context7Docs('nope-lib', { fetchImpl }), null);
});

test('searchLibraryDocs defaults to Context7 and skips other providers on hit', async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = fetchReturning([
    ['/search?query=express', { results: [{ id: '/expressjs/express', title: 'Express' }] }],
    ['/expressjs/express', SNIPPETS],
  ]);
  try {
    const docs = await searchLibraryDocs('express');
    assert.ok(docs);
    assert.match(docs.url, /context7\.com/);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('searchLibraryDocs falls back to Tavily when Context7 has nothing', async (t) => {
  const prevFetch = globalThis.fetch;
  const prevTv = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = 'tvly-test';
  t.after(() => {
    if (prevTv === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = prevTv;
  });
  globalThis.fetch = fetchReturning([
    ['/search?query=mystery-pkg', { results: [] }],
    ['api.tavily.com/search', { answer: 'Tavily answer about mystery-pkg', results: [{ url: 'https://example.com' }] }],
  ]);
  try {
    const docs = await searchLibraryDocs('mystery-pkg');
    assert.ok(docs, 'fallback should produce docs');
    assert.match(docs.content, /Tavily answer/);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('searchLibraryDocs honors provider=firecrawl (skips Context7)', async (t) => {
  const prevFetch = globalThis.fetch;
  const prevFc = process.env.FIRECRAWL_API_KEY;
  process.env.FIRECRAWL_API_KEY = 'fc-test';
  t.after(() => {
    if (prevFc === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = prevFc;
  });
  const fetchImpl = fetchReturning([
    ['api.firecrawl.dev', { success: true, data: { json: { endpoints: [{ name: 'fetch', description: 'fetches' }] } } }],
  ]);
  globalThis.fetch = fetchImpl;
  try {
    const docs = await searchLibraryDocs('node-fetch', { provider: 'firecrawl' });
    assert.ok(docs);
    assert.match(docs.content, /fetch/);
    assert.ok(!fetchImpl.calls.some((c) => String(c.url).includes('context7')), 'Context7 must not be consulted');
  } finally {
    globalThis.fetch = prevFetch;
  }
});
