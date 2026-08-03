import { execFile } from 'node:child_process';
import path from 'node:path';

export async function findRepoRoot(start = process.cwd()) {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd: start, encoding: 'utf-8' }, (err, stdout) => {
      if (err) resolve(start);
      else resolve(stdout.trim());
    });
  });
}

export async function readRepoSession(repoPath) {
  try {
    const { readFile } = await import('node:fs/promises');
    const file = path.join(repoPath, '.kimi', '.session');
    const data = await readFile(file, 'utf-8');
    return data.trim();
  } catch {
    return null;
  }
}

export async function writeRepoSession(repoPath, sessionId) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = path.join(repoPath, '.kimi');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '.session'), sessionId);
}
