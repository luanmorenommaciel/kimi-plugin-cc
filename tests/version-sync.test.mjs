import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir, cleanupTempDir } from './helpers.mjs';
import {
  readVersionFiles,
  findVersionDrift,
  computeVersionBump,
  parseRegisteredCommands,
  parseUsageCommands,
  FALLBACK_BROKER_COMMANDS,
} from '../scripts/lib/release-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function writeVersionFixtures(root, versions) {
  const pkg = { name: 'fixture', version: versions.pkg };
  const plugin = { name: 'kimi', version: versions.plugin ?? versions.pkg };
  const marketplace = {
    name: 'fixture-marketplace',
    metadata: { version: versions.marketplaceMeta ?? versions.pkg },
    plugins: [{ name: 'kimi', version: versions.marketplacePlugin ?? versions.pkg }],
  };
  const kimiPlugin = { name: 'crank', version: versions.kimiPlugin ?? versions.pkg };

  const files = {
    'package.json': pkg,
    'plugins/kimi/.claude-plugin/plugin.json': plugin,
    '.claude-plugin/marketplace.json': marketplace,
    'kimi.plugin.json': kimiPlugin,
  };
  for (const [rel, json] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(json, null, 2) + '\n');
  }
}

test('version check passes when all four files agree', async () => {
  const dir = makeTempDir();
  try {
    writeVersionFixtures(dir, { pkg: '1.2.3' });
    const files = await readVersionFiles(dir);
    assert.equal(files.length, 4);
    assert.deepEqual(findVersionDrift(files), []);
  } finally {
    cleanupTempDir(dir);
  }
});

test('version check fails naming the drifted file', async () => {
  const dir = makeTempDir();
  try {
    writeVersionFixtures(dir, { pkg: '1.2.3', kimiPlugin: '9.9.9' });
    const drift = findVersionDrift(await readVersionFiles(dir));
    assert.equal(drift.length, 1);
    assert.equal(drift[0].rel, 'kimi.plugin.json');
    assert.equal(drift[0].version, '9.9.9');
    assert.equal(drift[0].reference, '1.2.3');
  } finally {
    cleanupTempDir(dir);
  }
});

test('version check catches drift in either marketplace.json field', async () => {
  const dir = makeTempDir();
  try {
    writeVersionFixtures(dir, { pkg: '1.2.3', marketplacePlugin: '1.2.2' });
    const drift = findVersionDrift(await readVersionFiles(dir));
    assert.equal(drift.length, 1);
    assert.equal(drift[0].rel, '.claude-plugin/marketplace.json');
  } finally {
    cleanupTempDir(dir);
  }
});

test('bump computes consistent contents for all four files', async () => {
  const dir = makeTempDir();
  try {
    writeVersionFixtures(dir, { pkg: '1.2.3' });
    const files = await readVersionFiles(dir);
    const bumped = computeVersionBump(files, '2.0.0');
    assert.equal(bumped.length, 4);

    for (const file of bumped) {
      fs.writeFileSync(file.abs, file.content);
    }

    const after = await readVersionFiles(dir);
    assert.deepEqual(findVersionDrift(after), []);
    for (const f of after) {
      assert.deepEqual(f.versions, f.versions.map(() => '2.0.0'), `${f.spec.rel} fully bumped`);
    }
    // marketplace.json carries two version fields — both must move
    const marketplace = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin/marketplace.json'), 'utf-8'));
    assert.equal(marketplace.metadata.version, '2.0.0');
    assert.equal(marketplace.plugins[0].version, '2.0.0');
  } finally {
    cleanupTempDir(dir);
  }
});

test('parseUsageCommands reads command names from real broker usage', async () => {
  const broker = path.join(ROOT, 'plugins', 'kimi', 'scripts', 'broker.mjs');
  const { stdout, code } = await new Promise((resolve) => {
    execFile('node', [broker, '--help'], (err, stdout) => {
      resolve({ stdout, code: err ? err.code : 0 });
    });
  });
  assert.equal(code, 0, 'broker --help exits 0');

  const commands = parseUsageCommands(stdout);
  for (const expected of ['check-update', 'diff-capture', 'branch-diff', 'working-diff', 'latest-session', 'dispatch', 'doctor']) {
    assert.ok(commands.includes(expected), `usage lists ${expected}`);
  }
  // continuation lines (indented flags) must not be mistaken for commands
  assert.ok(!commands.includes('--effort'));
});

test('registered broker commands all appear in real broker usage', async () => {
  const broker = path.join(ROOT, 'plugins', 'kimi', 'scripts', 'broker.mjs');
  const registrySrc = fs.readFileSync(path.join(ROOT, 'plugins', 'kimi', 'scripts', 'lib', 'commands.mjs'), 'utf-8');
  const registered = parseRegisteredCommands(registrySrc);

  assert.ok(registered.length >= FALLBACK_BROKER_COMMANDS.length, 'registry yields at least the fallback list');
  assert.ok(!registered.includes('supervise'), 'internal command excluded');

  const { stdout } = await new Promise((resolve) => {
    execFile('node', [broker], (err, stdout) => resolve({ stdout }));
  });
  const listed = new Set(parseUsageCommands(stdout));
  for (const cmd of registered) {
    assert.ok(listed.has(cmd), `usage lists registered command: ${cmd}`);
  }
});
