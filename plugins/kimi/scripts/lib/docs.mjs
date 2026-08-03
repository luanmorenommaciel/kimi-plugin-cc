import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { warn } from './warn.mjs';
import { context7Docs } from './context7.mjs';

// 8KB default cap for external docs (K3 1M context); override with
// KIMI_CTX_CAP_DOCS_BYTES.
function docsCapBytes() {
  return Number(process.env.KIMI_CTX_CAP_DOCS_BYTES || 8 * 1024);
}

const API_SCHEMA = {
  type: 'object',
  properties: {
    endpoints: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          parameters: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                required: { type: 'boolean' },
                description: { type: 'string' },
              },
            },
          },
          returns: { type: 'string' },
          examples: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

/**
 * Scan files for import/require statements and extract package names.
 *
 * @param {string[]} filePaths - absolute paths
 * @returns {Promise<Set<string>>}
 */
export async function extractPackages(filePaths) {
  const packages = new Set();
  const importRe = /(?:import\s+.*?\s+from\s+['"])([^'"./][^'"]*)(?:['"])/g;
  const requireRe = /(?:require\s*\(\s*['"])([^'"./][^'"]*)(?:['"]\s*\))/g;

  for (const fp of filePaths) {
    let content;
    try {
      content = await readFile(fp, 'utf-8');
    } catch {
      continue;
    }
    let m;
    while ((m = importRe.exec(content)) !== null) packages.add(m[1]);
    while ((m = requireRe.exec(content)) !== null) packages.add(m[1]);
  }
  return packages;
}

/**
 * Library docs lookup. Provider order: Context7 (versioned, LLM-optimized
 * docs — default), then Firecrawl structured extraction, then Tavily search.
 *
 * @param {string} packageName
 * @param {object} [opts]
 * @param {string} [opts.provider] - 'context7' | 'firecrawl' (default: $KIMI_DOCS_PROVIDER or 'context7')
 */
export async function searchLibraryDocs(packageName, opts = {}) {
  const provider = opts.provider || process.env.KIMI_DOCS_PROVIDER || 'context7';

  // 1. Context7 (default provider) — falls through when it has nothing.
  if (provider === 'context7') {
    const docs = await context7Docs(packageName);
    if (docs) return docs;
  }

  // 2. Try Firecrawl structured extraction on known docs URL
  const fcKey = process.env.FIRECRAWL_API_KEY;
  if (fcKey) {
    const docsUrl = await resolveDocsUrl(packageName);
    if (docsUrl) {
      try {
        const extracted = await firecrawlExtract(docsUrl, fcKey);
        if (extracted) {
          return { title: packageName, url: docsUrl, content: formatExtracted(extracted) };
        }
      } catch (e) {
        await warn('docs', e, 'info');
      }
    }
  }

  // 3. Fallback to Tavily search
  return tavilySearchDocs(packageName);
}

async function resolveDocsUrl(packageName) {
  // Known patterns for popular packages
  const patterns = [
    `https://www.npmjs.com/package/${packageName}`,
    `https://github.com/${packageName}/${packageName}`,
  ];
  return patterns[0];
}

async function firecrawlExtract(url, apiKey) {
  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      url,
      formats: [{ type: 'json', schema: API_SCHEMA }],
      onlyMainContent: true,
      timeout: 30000,
    }),
  });
  const data = await res.json();
  if (!data.success) return null;
  return data.data?.json || null;
}

async function tavilySearchDocs(packageName) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    await warn('docs', 'TAVILY_API_KEY not set — skipping library docs lookup', 'info');
    return null;
  }

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: `${packageName} npm documentation API reference`,
        search_depth: 'basic',
        max_results: 3,
        include_answer: true,
      }),
    });
    const data = await res.json();
    const answer = data.answer || '';
    const results = data.results || [];
    if (!answer && results.length === 0) return null;

    return {
      title: packageName,
      url: results[0]?.url || '',
      content: answer || results.map((r) => r.content).join('\n\n'),
    };
  } catch (e) {
    await warn('docs', e, 'warning');
    return null;
  }
}

function formatExtracted(json) {
  if (!json || !json.endpoints) return '';
  const lines = [];
  for (const ep of json.endpoints) {
    lines.push(`### ${ep.name || 'Unknown'}()`);
    if (ep.description) lines.push(ep.description);
    if (ep.parameters && ep.parameters.length > 0) {
      lines.push('Parameters:');
      for (const p of ep.parameters) {
        lines.push(`  - ${p.name}${p.required ? '' : '?'}: ${p.type} — ${p.description || ''}`);
      }
    }
    if (ep.returns) lines.push(`Returns: ${ep.returns}`);
    if (ep.examples && ep.examples.length > 0) {
      lines.push('Example:');
      lines.push('```js');
      lines.push(ep.examples[0]);
      lines.push('```');
    }
  }
  return lines.join('\n');
}

/**
 * Build an external docs preamble for the prompt.
 *
 * @param {string[]} touchesPaths - relative paths from repo root
 * @param {string} repoRoot
 * @returns {Promise<string>}
 */
export async function discoverLibraryDocs(touchesPaths, repoRoot, opts = {}) {
  const absPaths = touchesPaths.map((p) => path.join(repoRoot, p));
  const packages = await extractPackages(absPaths);
  if (packages.size === 0) return '';

  const blocks = [];
  for (const pkg of packages) {
    if (pkg.startsWith('.') || pkg.startsWith('/')) continue;
    const docs = await searchLibraryDocs(pkg, opts);
    if (docs) {
      blocks.push(`--- ${docs.title} ---\n${docs.content.slice(0, 1200)}${docs.content.length > 1200 ? '...' : ''}\nURL: ${docs.url}\n`);
    }
  }

  if (blocks.length === 0) return '';

  let assembled = '=== EXTERNAL DOCS (read-only reference) ===\n\n';
  let used = assembled.length;

  for (const b of blocks) {
    if (used + b.length > docsCapBytes()) {
      assembled += '... (truncated)\n';
      break;
    }
    assembled += b + '\n';
    used += b.length + 1;
  }

  return assembled.trimEnd() + '\n';
}
