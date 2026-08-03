/**
 * Pure helpers for the release CLI (scripts/release.mjs), extracted so the
 * version-sync and broker-command logic can be unit-tested without invoking
 * the full release flow.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// ------------------------------------------------------------------
// Version sync — the four version-bearing files
// ------------------------------------------------------------------

export const VERSION_FILE_SPECS = [
  {
    rel: 'package.json',
    getVersions: (json) => [json.version],
    setVersion: (json, v) => { json.version = v; },
  },
  {
    rel: 'plugins/kimi/.claude-plugin/plugin.json',
    getVersions: (json) => [json.version],
    setVersion: (json, v) => { json.version = v; },
  },
  {
    rel: '.claude-plugin/marketplace.json',
    getVersions: (json) => [json.metadata?.version, json.plugins?.[0]?.version],
    setVersion: (json, v) => {
      if (json.metadata) json.metadata.version = v;
      if (json.plugins?.[0]) json.plugins[0].version = v;
    },
  },
  {
    rel: 'kimi.plugin.json',
    getVersions: (json) => [json.version],
    setVersion: (json, v) => { json.version = v; },
  },
];

/**
 * Read and parse every version-bearing file under `root`.
 * Returns [{ spec, abs, json, versions }] in VERSION_FILE_SPECS order.
 */
export async function readVersionFiles(root) {
  const files = [];
  for (const spec of VERSION_FILE_SPECS) {
    const abs = path.join(root, spec.rel);
    const json = JSON.parse(await readFile(abs, 'utf-8'));
    files.push({ spec, abs, json, versions: spec.getVersions(json) });
  }
  return files;
}

/**
 * Compare every version field against the reference (package.json, the first
 * spec). Returns a list of { rel, version, reference } for each drifted
 * field — empty when all four files agree.
 */
export function findVersionDrift(versionFiles) {
  const reference = versionFiles[0].versions[0];
  const drift = [];
  for (const f of versionFiles) {
    for (const version of f.versions) {
      if (version !== reference) {
        drift.push({ rel: f.spec.rel, version, reference });
      }
    }
  }
  return drift;
}

/**
 * Compute the new file contents for a bump without writing anything.
 * Callers should write all returned files only after every content has
 * been computed successfully (atomic-ish bump).
 * Returns [{ rel, abs, content }].
 */
export function computeVersionBump(versionFiles, newVersion) {
  return versionFiles.map((f) => {
    const json = JSON.parse(JSON.stringify(f.json));
    f.spec.setVersion(json, newVersion);
    return { rel: f.spec.rel, abs: f.abs, content: JSON.stringify(json, null, 2) + '\n' };
  });
}

// ------------------------------------------------------------------
// Broker command list — derived from the command registry
// ------------------------------------------------------------------

// Registered in lib/commands.mjs but deliberately absent from usage/README
// (internal re-exec target for detached background cranks).
const INTERNAL_COMMANDS = new Set(['supervise']);

// Last-resort list used only when the registry cannot be read or parsed.
export const FALLBACK_BROKER_COMMANDS = [
  'doctor', 'dispatch', 'status', 'result', 'cancel', 'diff-capture',
  'branch-diff', 'working-diff', 'latest-session', 'watch', 'report',
  'batch', 'next', 'telemetry', 'checkpoint', 'monitor', 'prune',
  'review-gate', 'export-debug', 'warnings', 'check-update',
];

/**
 * Parse `register('name', ...)` calls out of lib/commands.mjs source.
 * Internal commands (see above) are excluded.
 */
export function parseRegisteredCommands(commandsSource) {
  const names = [...commandsSource.matchAll(/^register\('([a-z0-9-]+)'/gm)].map((m) => m[1]);
  return names.filter((n) => !INTERNAL_COMMANDS.has(n));
}

/**
 * Parse command names out of broker usage text: two-space-indented lines in
 * the "Commands:" section (continuation lines start with a flag or deeper
 * indent and are ignored).
 */
export function parseUsageCommands(usageText) {
  const names = [];
  for (const line of usageText.split('\n')) {
    const m = line.match(/^ {2}([a-z][a-z0-9-]*)(?=\s|$)/);
    if (m) names.push(m[1]);
  }
  return names;
}
