import { readFile } from 'node:fs/promises';
import { warn } from './warn.mjs';

// 4KB default research cap (K3 1M context); override with
// KIMI_CTX_CAP_RESEARCH_BYTES.
function researchCapBytes() {
  return Number(process.env.KIMI_CTX_CAP_RESEARCH_BYTES || 4 * 1024);
}

// 16KB default cap for deep-research briefs; override with
// KIMI_CTX_CAP_DEEP_RESEARCH_BYTES.
function deepResearchCapBytes() {
  return Number(process.env.KIMI_CTX_CAP_DEEP_RESEARCH_BYTES || 16 * 1024);
}

/**
 * Extract research topics from a task spec.
 *
 * @param {string} taskContent - markdown content
 * @returns {string[]}
 */
export function extractResearchTopics(taskContent) {
  const topics = [];

  // Explicit frontmatter
  const match = taskContent.match(/research_topics:\s*\n((?:\s+-\s+.*\n?)+)/);
  if (match) {
    const lines = match[1].split('\n').filter((l) => l.trim().startsWith('-'));
    for (const line of lines) {
      const v = line.replace(/^\s+-\s+/, '').trim();
      if (v) topics.push(v);
    }
  }

  // Heuristic: title + first paragraph keywords
  if (topics.length === 0) {
    const title = taskContent.match(/^title:\s*(.+)$/m)?.[1]?.trim() || '';
    const firstPara = taskContent.split('\n\n')[0] || '';
    const combined = `${title} ${firstPara}`;
    // Extract capitalized tech terms (naive heuristic)
    const techTerms = combined.match(/\b[A-Z][a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*\b/g) || [];
    for (const t of [...new Set(techTerms)]) {
      if (t.length > 2 && !['The', 'This', 'That', 'With', 'From', 'For', 'And'].includes(t)) {
        topics.push(t);
      }
    }
  }

  return [...new Set(topics)].slice(0, 5);
}

/**
 * Research topics via Tavily.
 *
 * @param {string[]} topics
 * @returns {Promise<string>}
 */
export async function researchTopics(topics) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    await warn('research', 'TAVILY_API_KEY not set — skipping web research', 'info');
    return '';
  }

  const query = topics.join(' ');
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: `${query} best practices 2025 2026`,
        search_depth: 'basic',
        max_results: 3,
        include_answer: true,
      }),
    });
    const data = await res.json();
    const answer = data.answer || '';
    if (!answer) return '';

    const summary = `=== CURRENT CONTEXT (read-only reference) ===\n\n${answer.slice(0, researchCapBytes())}${answer.length > researchCapBytes() ? '...' : ''}\n`;
    return summary;
  } catch (e) {
    await warn('research', e, 'warning');
    return '';
  }
}

/**
 * Deep research via Tavily's async /research endpoint: create a research
 * task, poll until it completes, and return the cited multi-source brief.
 * Warn-and-skip (returns '') on any failure — dispatch must never hang on it.
 *
 * @param {string[]} topics
 * @returns {Promise<string>}
 */
export async function deepResearch(topics) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    await warn('research', 'TAVILY_API_KEY not set — skipping deep research', 'info');
    return '';
  }

  const timeoutMs = Number(process.env.KIMI_DEEP_RESEARCH_TIMEOUT_MS || 4 * 60 * 1000);
  const deadline = Date.now() + timeoutMs;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };

  try {
    // 1. Create the research task
    const createRes = await fetch('https://api.tavily.com/research', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: `${topics.join(' ')} — best practices, pitfalls, and current recommendations`,
        model: 'auto',
      }),
    });
    const created = await createRes.json();
    const requestId = created.request_id;
    if (!requestId) {
      await warn('research', `deep research create failed: ${JSON.stringify(created).slice(0, 200)}`, 'warning');
      return '';
    }

    // 2. Poll with backoff until completed/failed or the deadline passes
    let delay = 2000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(delay, Math.max(0, deadline - Date.now()))));
      const statusRes = await fetch(`https://api.tavily.com/research/${requestId}`, { headers });
      const task = await statusRes.json();
      const status = task.status || '';
      if (status === 'completed') {
        const report = task.content || task.response || task.answer || '';
        if (!report) return '';
        const cap = deepResearchCapBytes();
        return `=== DEEP RESEARCH BRIEF (read-only reference) ===\n\n${report.slice(0, cap)}${report.length > cap ? '...' : ''}\n`;
      }
      if (status === 'failed' || status === 'error') {
        await warn('research', `deep research task ${requestId} ${status}`, 'warning');
        return '';
      }
      delay = Math.min(Math.round(delay * 1.5), 15000);
    }

    await warn('research', `deep research timed out after ${timeoutMs}ms — continuing without it`, 'warning');
    return '';
  } catch (e) {
    await warn('research', e, 'warning');
    return '';
  }
}

/**
 * Parse task-spec `external_docs:` lines into entries.
 * Two forms per line:
 *   - `https://docs.example.com/page`            → { url, instruction: '' }
 *   - `https://docs.example.com "find pages on X"` → { url, instruction }
 *
 * @param {string} taskSpec - markdown content
 * @returns {Array<{url: string, instruction: string}>}
 */
export function parseExternalDocs(taskSpec) {
  const entries = [];
  const docMatch = taskSpec.match(/external_docs:\s*\n((?:\s+-\s+.*\n?)+)/);
  if (!docMatch) return entries;
  const lines = docMatch[1].split('\n').filter((l) => l.trim().startsWith('-'));
  for (const line of lines) {
    const v = line.replace(/^\s+-\s+/, '').trim();
    if (!v) continue;
    const m = v.match(/^(\S+)\s+"([^"]+)"$/);
    if (m) entries.push({ url: m[1], instruction: m[2] });
    else entries.push({ url: v, instruction: '' });
  }
  return entries;
}

/**
 * Crawl a doc site with natural-language instructions via Tavily /crawl.
 * Returns the discovered URLs and their combined content, or null.
 *
 * @param {string} url - site root to crawl
 * @param {string} instruction - e.g. "find all pages about authentication"
 * @returns {Promise<null|{urls: string[], content: string}>}
 */
export async function crawlDocs(url, instruction) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    await warn('research', 'TAVILY_API_KEY not set — skipping doc crawl', 'info');
    return null;
  }

  try {
    const res = await fetch('https://api.tavily.com/crawl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        url,
        instructions: instruction,
        max_depth: 2,
        limit: 8,
      }),
    });
    const data = await res.json();
    const results = data.results || [];
    if (results.length === 0) return null;

    return {
      urls: results.map((r) => r.url).filter(Boolean),
      content: results
        .map((r) => r.raw_content || r.content || '')
        .filter(Boolean)
        .join('\n\n---\n\n'),
    };
  } catch (e) {
    await warn('research', e, 'warning');
    return null;
  }
}
