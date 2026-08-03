import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { warn } from './warn.mjs';

/**
 * External-doc monitoring backed by Firecrawl's v2 changeTracking.
 *
 * Each scrape with the `changeTracking` format makes Firecrawl retain a
 * server-side snapshot of the page; the next scrape returns
 * `changeStatus` (new|same|changed|removed) plus a git-style markdown diff
 * and — when a schema is supplied — per-field JSON diffs. A local snapshot
 * copy is kept as a portability record, but the comparison itself is
 * Firecrawl's, not local hashing.
 */

const SCRAPE_URL = 'https://api.firecrawl.dev/v2/scrape';

/**
 * Capture a baseline snapshot of an external doc.
 *
 * @param {string} url
 * @param {string} snapshotDir
 * @returns {Promise<{snapshotFile: string, content: string, status: string}|null>}
 */
export async function captureBaseline(url, snapshotDir) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    await warn('monitor', 'FIRECRAWL_API_KEY not set — skipping doc monitor', 'info');
    return null;
  }

  await mkdir(snapshotDir, { recursive: true });
  const snapshotFile = path.join(snapshotDir, `snapshot-${hashUrl(url)}.json`);

  try {
    const data = await scrapeWithChangeTracking(url, apiKey);
    if (!data) return null;

    const snapshot = {
      url,
      captured_at: new Date().toISOString(),
      change_status: data.changeTracking?.changeStatus || 'new',
      markdown: data.markdown || '',
      metadata: data.metadata || {},
    };
    await writeFile(snapshotFile, JSON.stringify(snapshot, null, 2));
    return { snapshotFile, content: snapshot.markdown, status: snapshot.change_status };
  } catch (e) {
    await warn('monitor', e, 'warning');
    return null;
  }
}

/**
 * Check an external doc for changes since its last retained snapshot.
 *
 * @param {string} url
 * @param {string} snapshotDir
 * @returns {Promise<null|{changed: boolean, status: string, diff: string, diffText: string, diffJson: object|null, previousScrapeAt: string|null}>}
 */
export async function checkForChanges(url, snapshotDir) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return null;

  try {
    const data = await scrapeWithChangeTracking(url, apiKey);
    if (!data) return null;

    const tracking = data.changeTracking || {};
    const status = tracking.changeStatus || 'same';
    const diffText = tracking.diff?.text || '';
    const diffJson = tracking.json || tracking.diff?.json || null;

    // Refresh the local portability record.
    const snapshotFile = path.join(snapshotDir, `snapshot-${hashUrl(url)}.json`);
    try {
      await writeFile(
        snapshotFile,
        JSON.stringify({
          url,
          captured_at: new Date().toISOString(),
          change_status: status,
          markdown: data.markdown || '',
          metadata: data.metadata || {},
        }, null, 2)
      );
    } catch { /* local record is best-effort */ }

    const changed = status === 'changed' || status === 'removed';
    return {
      changed,
      status,
      diff: changed ? (diffText || `External doc ${status} since ${tracking.previousScrapeAt || 'baseline'}`) : '',
      diffText,
      diffJson,
      previousScrapeAt: tracking.previousScrapeAt || null,
    };
  } catch (e) {
    await warn('monitor', e, 'warning');
    return null;
  }
}

/**
 * POST /v2/scrape with markdown + changeTracking formats (git-diff and JSON
 * modes). Returns the scrape `data` object or null on API failure.
 */
async function scrapeWithChangeTracking(url, apiKey, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  const res = await doFetch(SCRAPE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      url,
      formats: [
        'markdown',
        { type: 'changeTracking', modes: ['json', 'git-diff'] },
      ],
      onlyMainContent: true,
      timeout: 30000,
    }),
  });
  const body = await res.json();
  if (!body.success) return null;
  return body.data || null;
}

function hashUrl(url) {
  let h = 0;
  for (let i = 0; i < url.length; i++) {
    h = ((h << 5) - h + url.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
