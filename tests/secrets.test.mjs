import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanTextForSecrets, scanDiffForSecrets } from '../plugins/kimi/scripts/lib/secrets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('scanTextForSecrets flags common credentials', () => {
  assert.ok(scanTextForSecrets('AKIAIOSFODNN7EXAMPLE').length);
  assert.ok(scanTextForSecrets('key sk-ant-' + 'a'.repeat(24)).length);
  assert.ok(scanTextForSecrets('sk-' + 'a'.repeat(30)).length);
  assert.ok(scanTextForSecrets('ghp_' + 'a'.repeat(36)).length);
  assert.ok(scanTextForSecrets('api_key = "' + 'x'.repeat(20) + '"').length);
  assert.ok(scanTextForSecrets('-----BEGIN RSA PRIVATE KEY-----').length);
});

test('scanTextForSecrets is quiet on clean text', () => {
  assert.deepEqual(scanTextForSecrets('just review this function please'), []);
  assert.deepEqual(scanTextForSecrets(''), []);
});

test('scanDiffForSecrets only flags ADDED lines', () => {
  const secret = 'sk-' + 'a'.repeat(30);
  assert.ok(scanDiffForSecrets(`--- a\n+++ b\n-old\n+ ${secret}\n context`).length);
  assert.deepEqual(scanDiffForSecrets(`--- a\n+++ b\n-${secret}`), []); // removed line, not shipped
});

test('explore.yaml is a fail-CLOSED allow-list (read-only)', () => {
  const y = readFileSync(path.join(__dirname, '../plugins/kimi/agent-files/explore.yaml'), 'utf8');
  // Ignore comments — check the actual config, not the explanatory prose.
  const code = y.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.match(code, /^\s*tools:/m, 'must use a tools: allow-list');
  assert.doesNotMatch(code, /^\s*exclude_tools:/m, 'must not use a fail-open deny-list');
  const grants = code.split('\n').filter((l) => /^\s*-\s*"kimi_cli/.test(l));
  assert.ok(grants.length, 'must grant at least one read tool');
  for (const g of grants) {
    for (const forbidden of ['WriteFile', 'StrReplaceFile', ':Shell', ':Agent']) {
      assert.ok(!g.includes(forbidden), `read-only explore agent must not grant ${forbidden}`);
    }
  }
});
