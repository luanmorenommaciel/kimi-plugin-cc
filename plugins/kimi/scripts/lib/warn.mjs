import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Append a warning line to <repoPath>/.kimi/state/warnings.jsonl.
 *
 * @param {string} module
 * @param {Error|string} error
 * @param {string} [severity='warning']
 * @param {string} [repoPath] - repo whose .kimi/state receives the warning.
 *   Callers that know the session's repo (close handler, reconciliation)
 *   MUST pass it: the broker may be launched from any cwd (including a
 *   detached supervisor), and warnings must land with the session's repo.
 */
export async function warn(module, error, severity = 'warning', repoPath = process.cwd()) {
  const warnDir = path.join(repoPath, '.kimi', 'state');
  await mkdir(warnDir, { recursive: true });

  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    module,
    error: error?.message || String(error),
    severity,
  }) + '\n';

  const warnFile = path.join(warnDir, 'warnings.jsonl');
  try {
    await writeFile(warnFile, line, { flag: 'a' });
  } catch {
    // last resort: stderr
    process.stderr.write(`[${module}] ${severity}: ${error?.message || String(error)}\n`);
  }
}

export async function readWarnings(repoPath, since) {
  const warnFile = path.join(repoPath, '.kimi', 'state', 'warnings.jsonl');
  let data;
  try {
    data = await readFile(warnFile, 'utf-8');
  } catch {
    return [];
  }

  const sinceDate = since ? new Date(since) : null;
  return data
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((w) => w && (!sinceDate || new Date(w.timestamp) >= sinceDate));
}
