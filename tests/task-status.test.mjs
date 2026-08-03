import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDir, cleanupTempDir } from './helpers.mjs';
import { updateTaskStatus } from '../plugins/kimi/scripts/lib/orchestrate.mjs';

const TASK = `---
format_version: "1"
id: T-99
title: sample
priority: P1
status: ready
depends_on:
  - T-01
touches_paths:
  - src/x.js
---

## Goal

Do the thing.
`;

function writeTaskFile(t, content = TASK) {
  const dir = makeTempDir();
  t.after(() => cleanupTempDir(dir));
  const p = path.join(dir, 'T-99.md');
  fs.writeFileSync(p, content);
  return p;
}

test('updateTaskStatus transitions status inside the frontmatter only', async (t) => {
  const p = writeTaskFile(t);

  assert.equal(await updateTaskStatus(p, 'in-progress'), true);
  let text = fs.readFileSync(p, 'utf-8');
  assert.match(text, /^status: in-progress$/m);
  assert.ok(text.includes('## Goal'), 'body preserved');
  assert.ok(text.includes('touches_paths:\n  - src/x.js'), 'other fields preserved');

  assert.equal(await updateTaskStatus(p, 'completed'), true);
  text = fs.readFileSync(p, 'utf-8');
  assert.match(text, /^status: completed$/m);
  assert.equal(text.match(/^status:/gm).length, 1, 'exactly one status line');
});

test('updateTaskStatus returns false for a file without a status field', async (t) => {
  const p = writeTaskFile(t, '---\nid: T-1\n---\n\nno status here\n');
  assert.equal(await updateTaskStatus(p, 'completed'), false);
  // content untouched
  assert.ok(fs.readFileSync(p, 'utf-8').includes('no status here'));
});

test('updateTaskStatus returns false for a missing file', async (t) => {
  const dir = makeTempDir();
  t.after(() => cleanupTempDir(dir));
  assert.equal(await updateTaskStatus(path.join(dir, 'nope.md'), 'failed'), false);
});

test('updateTaskStatus does not touch status-like text in the body', async (t) => {
  const p = writeTaskFile(t, TASK + '\nstatus: this-is-body-text-not-frontmatter\n');
  await updateTaskStatus(p, 'failed');
  const text = fs.readFileSync(p, 'utf-8');
  assert.match(text.split('---')[1], /status: failed/, 'frontmatter updated');
  assert.ok(text.includes('status: this-is-body-text-not-frontmatter'), 'body line untouched');
});
