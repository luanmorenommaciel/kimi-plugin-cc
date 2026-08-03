import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDir, cleanupTempDir } from './helpers.mjs';
import {
  findRepoRoot,
  readRepoSession,
  writeRepoSession,
} from '../plugins/kimi/scripts/lib/workspace.mjs';

test('findRepoRoot returns start when not in a git repo', async () => {
  const tmp = makeTempDir();
  try {
    const root = await findRepoRoot(tmp);
    assert.equal(root, tmp);
  } finally {
    cleanupTempDir(tmp);
  }
});

test('findRepoRoot finds git repo root', async () => {
  const tmp = makeTempDir();
  try {
    fs.mkdirSync(path.join(tmp, 'sub', 'dir'), { recursive: true });
    execFileSync('git', ['init'], { cwd: tmp });
    const root = await findRepoRoot(path.join(tmp, 'sub', 'dir'));
    assert.equal(root, fs.realpathSync(tmp));
  } finally {
    cleanupTempDir(tmp);
  }
});

test('writeRepoSession and readRepoSession round-trip', async () => {
  const tmp = makeTempDir();
  try {
    await writeRepoSession(tmp, 'sess-123');
    const read = await readRepoSession(tmp);
    assert.equal(read, 'sess-123');
  } finally {
    cleanupTempDir(tmp);
  }
});

test('readRepoSession returns null for missing file', async () => {
  const tmp = makeTempDir();
  try {
    const read = await readRepoSession(tmp);
    assert.equal(read, null);
  } finally {
    cleanupTempDir(tmp);
  }
});
