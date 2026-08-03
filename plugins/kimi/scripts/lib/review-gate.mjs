import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Review-gate wiring: enable/disable the Stop hook in the plugin's hooks.json.
 * Uses the standard Claude Code hook schema (event-keyed), with the gate
 * command pointing at scripts/review-gate.mjs via ${CLAUDE_PLUGIN_ROOT}.
 */

export const HOOKS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'hooks.json');

const GATE_MARKER = 'review-gate.mjs';

// hooks.json is only read at plugin-load time, and a plugin update/reinstall
// ships `{"hooks": {}}` — both facts the user must hear on every toggle.
const RELOAD_NOTE = 'Run /reload-plugins (or restart Claude Code) for this change to take effect — hooks.json is only read at plugin load. Updating or reinstalling the plugin resets the gate to off.';

const STOP_HOOK_ENTRY = {
  matcher: '',
  hooks: [
    {
      type: 'command',
      command: `node \${CLAUDE_PLUGIN_ROOT}/scripts/${GATE_MARKER}`,
      timeout: 180,
    },
  ],
};

export async function reviewGateStatus(hooksFile = HOOKS_FILE) {
  const cfg = await readHooks(hooksFile);
  return { enabled: hasGate(cfg), hooksFile };
}

export async function enableReviewGate(hooksFile = HOOKS_FILE) {
  const cfg = await readHooks(hooksFile);
  cfg.hooks = cfg.hooks && typeof cfg.hooks === 'object' && !Array.isArray(cfg.hooks) ? cfg.hooks : {};
  const stops = Array.isArray(cfg.hooks.Stop) ? cfg.hooks.Stop : [];
  if (!stops.some((h) => JSON.stringify(h).includes(GATE_MARKER))) {
    stops.push(STOP_HOOK_ENTRY);
  }
  cfg.hooks.Stop = stops;
  cfg.description = 'Kimi plugin hooks — review gate ENABLED';
  await writeHooks(hooksFile, cfg);
  return { enabled: true, hooksFile, note: RELOAD_NOTE };
}

export async function disableReviewGate(hooksFile = HOOKS_FILE) {
  const cfg = await readHooks(hooksFile);
  if (cfg.hooks && typeof cfg.hooks === 'object' && Array.isArray(cfg.hooks.Stop)) {
    cfg.hooks.Stop = cfg.hooks.Stop.filter((h) => !JSON.stringify(h).includes(GATE_MARKER));
    if (cfg.hooks.Stop.length === 0) delete cfg.hooks.Stop;
  }
  cfg.description = 'Kimi plugin hooks — review gate disabled by default';
  await writeHooks(hooksFile, cfg);
  return { enabled: false, hooksFile, note: RELOAD_NOTE };
}

function hasGate(cfg) {
  return Array.isArray(cfg?.hooks?.Stop) && cfg.hooks.Stop.some((h) => JSON.stringify(h).includes(GATE_MARKER));
}

async function readHooks(file) {
  try {
    return JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    return {};
  }
}

async function writeHooks(file, cfg) {
  const text = JSON.stringify(cfg, null, 2) + '\n';
  JSON.parse(text); // never write invalid JSON
  await writeFile(file, text);
}
