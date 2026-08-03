import test from 'node:test';
import assert from 'node:assert/strict';

import { parseExternalDocs, crawlDocs } from '../plugins/kimi/scripts/lib/research.mjs';

test('parseExternalDocs handles bare URLs, instruction lines, and mixes', () => {
  const spec = `---
external_docs:
  - https://docs.example.com/quickstart
  - https://docs.example.com "find all pages about authentication"
  - https://plain-url-no-quotes.example.com/page
---
`;
  const entries = parseExternalDocs(spec);
  assert.deepEqual(entries, [
    { url: 'https://docs.example.com/quickstart', instruction: '' },
    { url: 'https://docs.example.com', instruction: 'find all pages about authentication' },
    { url: 'https://plain-url-no-quotes.example.com/page', instruction: '' },
  ]);
});

test('parseExternalDocs returns [] without the frontmatter key', () => {
  assert.deepEqual(parseExternalDocs('no external docs here'), []);
});

function withKey(t) {
  const prev = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = 'tvly-test';
  t.after(() => {
    if (prev === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = prev;
  });
}

test('crawlDocs posts instructions and returns urls + combined content', async (t) => {
  withKey(t);
  const prevFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, body: JSON.parse(opts.body) });
    return {
      json: async () => ({
        results: [
          { url: 'https://docs.example.com/auth/intro', raw_content: 'Auth intro content' },
          { url: 'https://docs.example.com/auth/tokens', raw_content: 'Token content' },
        ],
      }),
    };
  };
  try {
    const r = await crawlDocs('https://docs.example.com', 'find all pages about authentication');
    assert.ok(r);
    assert.deepEqual(r.urls, ['https://docs.example.com/auth/intro', 'https://docs.example.com/auth/tokens']);
    assert.match(r.content, /Auth intro content/);
    assert.match(r.content, /Token content/);
    assert.equal(seen[0].body.instructions, 'find all pages about authentication');
    assert.equal(seen[0].body.limit, 8, 'crawl is capped');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('crawlDocs returns null without a key or on empty results', async (t) => {
  const prev = process.env.TAVILY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  try {
    assert.equal(await crawlDocs('https://x.example.com', 'y'), null);
  } finally {
    process.env.TAVILY_API_KEY = 'tvly-test';
    t.after(() => {
      if (prev === undefined) delete process.env.TAVILY_API_KEY;
      else process.env.TAVILY_API_KEY = prev;
    });
  }
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ results: [] }) });
  try {
    assert.equal(await crawlDocs('https://x.example.com', 'y'), null);
  } finally {
    globalThis.fetch = prevFetch;
  }
});
