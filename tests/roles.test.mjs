import test from 'node:test';
import assert from 'node:assert/strict';

import { listRoles, loadRolePrompt, composePrompt } from '../plugins/kimi/scripts/lib/roles.mjs';

test('listRoles exposes coder and explore', () => {
  assert.deepEqual(listRoles().sort(), ['coder', 'explore']);
});

test('loadRolePrompt returns the coder system prompt with workDir substituted', async () => {
  const prompt = await loadRolePrompt('coder', { workDir: '/tmp/repo-x' });
  assert.match(prompt, /Kimi Coder Agent/);
  assert.ok(prompt.includes('/tmp/repo-x'), 'workDir must be substituted');
  assert.ok(!prompt.includes('${KIMI_WORK_DIR}'), 'placeholder must be fully replaced');
});

test('loadRolePrompt returns the explore system prompt and keeps it read-only', async () => {
  const prompt = await loadRolePrompt('explore', { workDir: '/tmp/repo-y' });
  assert.match(prompt, /Kimi Explore Agent/);
  assert.match(prompt, /[Rr]ead-only/);
  assert.ok(prompt.includes('/tmp/repo-y'));
});

test('loadRolePrompt rejects an unknown role with available roles listed', async () => {
  await assert.rejects(() => loadRolePrompt('nope'), /Unknown role "nope".*coder/s);
});

test('composePrompt puts the role prompt verbatim at the head', () => {
  const out = composePrompt('ROLE SYSTEM', 'USER TASK');
  assert.equal(out, 'ROLE SYSTEM\n\n---\n\nUSER TASK');
  assert.ok(out.startsWith('ROLE SYSTEM'));
});
