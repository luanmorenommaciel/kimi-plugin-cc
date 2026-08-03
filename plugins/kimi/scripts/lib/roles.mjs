import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Dispatch roles for Kimi Code 0.x.
 *
 * The legacy kimi-cli supported `--agent-file <yaml>` for role/tool selection;
 * Kimi Code 0.x does not. Roles are now Markdown system prompts composed into
 * the head of the `-p` prompt. Resolution is relative to this module, so it
 * works regardless of where the plugin is installed (marketplace or dev repo).
 */

const ROLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'roles');

export const ROLES = {
  coder: 'coder.md',
  explore: 'explore.md',
};

export function listRoles() {
  return Object.keys(ROLES);
}

/**
 * Load a role's system prompt, substituting the working directory.
 *
 * @param {string} role - one of listRoles()
 * @param {object} [opts]
 * @param {string} [opts.workDir] - replaces ${KIMI_WORK_DIR}
 * @returns {Promise<string>}
 */
export async function loadRolePrompt(role, opts = {}) {
  const file = ROLES[role];
  if (!file) {
    throw new Error(`Unknown role "${role}". Available roles: ${listRoles().join(', ')}`);
  }
  let content = await readFile(path.join(ROLES_DIR, file), 'utf-8');
  if (opts.workDir) {
    content = content.replaceAll('${KIMI_WORK_DIR}', opts.workDir);
  }
  return content.trim();
}

/**
 * Compose the final headless prompt: role system prompt first, then the task.
 */
export function composePrompt(rolePrompt, userPrompt) {
  return `${rolePrompt}\n\n---\n\n${userPrompt}`;
}
