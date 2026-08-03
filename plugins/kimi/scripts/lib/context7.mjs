import { warn } from './warn.mjs';

/**
 * Context7 HTTP client — versioned, LLM-optimized library documentation.
 * Uses CONTEXT7_API_KEY when present (higher limits); the public API also
 * works unauthenticated at a lower rate. Warn-and-skip on any failure,
 * matching the other research providers.
 */

const API_BASE = 'https://context7.com/api/v1';

/**
 * Fetch documentation snippets for a package via Context7.
 *
 * @param {string} packageName - e.g. 'react', 'express', '@scope/pkg'
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] - test injection point
 * @param {string} [opts.topic] - focus the returned snippets
 * @returns {Promise<null|{title: string, url: string, content: string}>}
 */
export async function context7Docs(packageName, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const headers = { 'Accept': 'application/json, text/plain' };
  if (process.env.CONTEXT7_API_KEY) {
    headers.Authorization = `Bearer ${process.env.CONTEXT7_API_KEY}`;
  }

  try {
    // 1. Resolve the Context7 library id (/org/project[/version])
    const searchRes = await fetchImpl(
      `${API_BASE}/search?query=${encodeURIComponent(packageName)}`,
      { headers }
    );
    const searchData = await searchRes.json();
    const libs = searchData.results || searchData.libraries || [];
    const lower = packageName.toLowerCase();
    const best =
      libs.find((l) => (l.id || '').toLowerCase().endsWith(`/${lower}`)) ||
      libs.find((l) => (l.id || '').toLowerCase().includes(lower)) ||
      libs[0];
    if (!best?.id) return null;

    // 2. Fetch topic-targeted doc snippets as plain text
    const topicParam = opts.topic ? `?topic=${encodeURIComponent(opts.topic)}` : '';
    const docsRes = await fetchImpl(`${API_BASE}${best.id}${topicParam}`, {
      headers: { ...headers, 'Accept': 'text/plain' },
    });
    const text = await docsRes.text();
    if (!text || text.trim().length < 40 || text.trimStart().startsWith('{')) {
      return null; // empty or an error payload
    }

    return {
      title: best.title || best.name || packageName,
      url: `https://context7.com${best.id}`,
      content: text.trim(),
    };
  } catch (e) {
    await warn('context7', e, 'info');
    return null;
  }
}
