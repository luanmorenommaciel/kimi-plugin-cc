#!/usr/bin/env node
/**
 * Release CLI — validates the plugin is ready to ship.
 *
 * Usage:
 *   node scripts/release.mjs [--bump <patch|minor|major>] [--dry-run] [--tag]
 *
 * Checks performed:
 *   1. Git working tree clean (no uncommitted changes)
 *   2. Version consistency across package.json, plugin.json,
 *      marketplace.json, kimi.plugin.json, and CHANGELOG.md
 *   3. All .mjs files parse (syntax lint)
 *   4. Unit + integration tests pass
 *   5. Plugin manifest validation (plugin.json, required files)
 *   6. Broker CLI smoke test (usage lists every registered command)
 *   7. Role prompt validation (plugins/kimi/roles/*.md)
 *   8. Command file validation (all .md commands present)
 *   9. kimi-code plugin validation (kimi.plugin.json pointers resolve)
 *  10. npm pack dry-run (verify package contents)
 *  11. (Optional) Version bump + git tag + npm publish
 */

import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile, rename, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readVersionFiles,
  findVersionDrift,
  computeVersionBump,
  parseRegisteredCommands,
  parseUsageCommands,
  FALLBACK_BROKER_COMMANDS,
} from './lib/release-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

async function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: ROOT, encoding: 'utf-8', ...opts }, (err, stdout, stderr) => {
      if (err && !opts.allowError) {
        reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr || err.message}`));
      } else {
        resolve({ stdout, stderr, code: err ? err.code : 0 });
      }
    });
  });
}

function log(step, message, type = 'info') {
  const icons = { info: 'ℹ', pass: '✔', fail: '✖', warn: '⚠' };
  const color = type === 'fail' ? '\x1b[31m' : type === 'pass' ? '\x1b[32m' : type === 'warn' ? '\x1b[33m' : '\x1b[36m';
  const reset = '\x1b[0m';
  console.log(`${color}${icons[type]} [${step}]${reset} ${message}`);
}

async function fileExists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------
// Checks
// ------------------------------------------------------------------

async function checkGitClean() {
  const { stdout } = await run('git', ['status', '--porcelain']);
  if (stdout.trim()) {
    throw new Error('Working tree has uncommitted changes:\n' + stdout);
  }
}

async function checkLint() {
  const { code, stderr } = await run('node', ['scripts/lint.mjs']);
  if (code !== 0) {
    throw new Error('Lint failed: ' + stderr);
  }
}

async function checkTests() {
  const timeout = Number(process.env.RELEASE_TEST_TIMEOUT_MS) || 300000;
  const { code, stderr } = await run('node', ['--test', '--test-concurrency=1'], { timeout });
  if (code !== 0) {
    throw new Error('Tests failed: ' + stderr);
  }
}

async function checkPluginManifest() {
  const manifestPath = path.join(ROOT, 'plugins', 'kimi', '.claude-plugin', 'plugin.json');
  if (!await fileExists(manifestPath)) {
    throw new Error('plugin.json not found');
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
  if (!manifest.name || !manifest.version) {
    throw new Error('plugin.json missing required fields (name, version)');
  }
  return manifest;
}

async function checkRequiredFiles() {
  const required = [
    'plugins/kimi/scripts/broker.mjs',
    'plugins/kimi/scripts/lib/kimi-cli.mjs',
    'plugins/kimi/scripts/lib/roles.mjs',
    'plugins/kimi/roles/coder.md',
    'plugins/kimi/roles/explore.md',
    'plugins/kimi/agents/kimi-delegate.md',
    'plugins/kimi/.claude-plugin/plugin.json',
    'plugins/kimi-code/skills/crank-loop/SKILL.md',
    '.claude-plugin/marketplace.json',
    'kimi.plugin.json',
    '.env.example',
    'README.md',
    'CHANGELOG.md',
  ];

  const missing = [];
  for (const f of required) {
    if (!await fileExists(path.join(ROOT, f))) {
      missing.push(f);
    }
  }

  if (missing.length > 0) {
    throw new Error('Missing required files: ' + missing.join(', '));
  }
}

async function checkBrokerSmoke() {
  const broker = path.join(ROOT, 'plugins', 'kimi', 'scripts', 'broker.mjs');

  // Verify broker exits with usage on no args
  const { code, stdout } = await run('node', [broker], { allowError: true });
  if (code === 0) {
    throw new Error('Broker should exit with error on no args');
  }
  if (!stdout.includes('Usage:')) {
    throw new Error('Broker did not print usage on no args');
  }

  // Verify every registered command is listed in usage. The expected list
  // is derived from the command registry in lib/commands.mjs (falling back
  // to a static list if the registry cannot be read).
  const expected = await expectedBrokerCommands();
  const listed = new Set(parseUsageCommands(stdout));
  for (const cmd of expected) {
    if (!listed.has(cmd)) {
      throw new Error(`Usage text missing command: ${cmd}`);
    }
  }
}

async function expectedBrokerCommands() {
  try {
    const src = await readFile(path.join(ROOT, 'plugins', 'kimi', 'scripts', 'lib', 'commands.mjs'), 'utf-8');
    const commands = parseRegisteredCommands(src);
    if (commands.length > 0) return commands;
  } catch {
    // fall through to the static list
  }
  return FALLBACK_BROKER_COMMANDS;
}

async function checkAgentFiles() {
  // Roles are Markdown system prompts composed into the dispatch prompt
  // (Kimi Code 0.x has no YAML agent-file mechanism).
  const rolesDir = path.join(ROOT, 'plugins', 'kimi', 'roles');
  const entries = await readdir(rolesDir);
  for (const role of ['coder.md', 'explore.md']) {
    if (!entries.includes(role)) {
      throw new Error(`Role prompt missing: plugins/kimi/roles/${role}`);
    }
    const content = await readFile(path.join(rolesDir, role), 'utf-8');
    if (!content.includes('${KIMI_WORK_DIR}')) {
      throw new Error(`Role prompt ${role} must reference \${KIMI_WORK_DIR}`);
    }
  }
}

async function checkCommandFiles() {
  const commandsDir = path.join(ROOT, 'plugins', 'kimi', 'commands');
  const entries = await readdir(commandsDir);
  const mdFiles = entries.filter((f) => f.endsWith('.md'));

  // Every command file should have frontmatter with name and description
  for (const f of mdFiles) {
    const content = await readFile(path.join(commandsDir, f), 'utf-8');
    if (!content.match(/^---\s*\n/)) {
      throw new Error(`Command file ${f} missing frontmatter`);
    }
    if (!content.includes('name:')) {
      throw new Error(`Command file ${f} missing 'name' in frontmatter`);
    }
  }
}

async function checkKimiCodePlugin() {
  // Root kimi.plugin.json points at the kimi-code plugin's commands/skills
  // directories — validate the pointers resolve to real paths.
  const manifestPath = path.join(ROOT, 'kimi.plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));

  for (const field of ['commands', 'skills']) {
    if (typeof manifest[field] !== 'string') {
      throw new Error(`kimi.plugin.json missing '${field}' pointer`);
    }
    if (!await fileExists(path.join(ROOT, manifest[field]))) {
      throw new Error(`kimi.plugin.json '${field}' does not resolve: ${manifest[field]}`);
    }
  }

  const commandsDir = path.join(ROOT, manifest.commands);
  const mdFiles = (await readdir(commandsDir)).filter((f) => f.endsWith('.md'));
  if (mdFiles.length === 0) {
    throw new Error('plugins/kimi-code/commands has no .md command files');
  }

  if (!await fileExists(path.join(ROOT, 'plugins', 'kimi-code', 'skills', 'crank-loop', 'SKILL.md'))) {
    throw new Error('Missing plugins/kimi-code/skills/crank-loop/SKILL.md');
  }
}

async function checkNpmPack() {
  const { code, stdout, stderr } = await run('npm', ['pack', '--dry-run'], { allowError: true });
  if (code !== 0) {
    throw new Error('npm pack dry-run failed: ' + stderr);
  }

  // Verify key files would be included
  const packOutput = stdout + stderr;
  const mustInclude = ['broker.mjs', 'commands.mjs', 'coder.md', 'plugin.json', '.env.example'];
  const missing = mustInclude.filter((f) => !packOutput.includes(f));
  if (missing.length > 0) {
    throw new Error('npm pack would exclude: ' + missing.join(', '));
  }
}

async function checkVersionConsistency() {
  const versionFiles = await readVersionFiles(ROOT);
  const drift = findVersionDrift(versionFiles);
  if (drift.length > 0) {
    const details = drift.map((d) => `${d.rel}=${d.version}`).join(', ');
    throw new Error(`Version mismatch (expected ${drift[0].reference}): ${details}`);
  }

  const version = versionFiles[0].versions[0];
  const changelog = await readFile(path.join(ROOT, 'CHANGELOG.md'), 'utf-8');
  if (!changelog.includes(`## ${version}`)) {
    throw new Error(`CHANGELOG.md missing section for v${version}`);
  }

  return version;
}

// ------------------------------------------------------------------
// Version bump
// ------------------------------------------------------------------

function bumpVersion(current, type) {
  const [major, minor, patch] = current.split('.').map(Number);
  if (type === 'major') return `${major + 1}.0.0`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

async function doBump(newVersion) {
  // Compute every new file content first; only start writing once all four
  // files parsed and bumped cleanly, so a failure mid-bump writes nothing.
  const versionFiles = await readVersionFiles(ROOT);
  const bumped = computeVersionBump(versionFiles, newVersion);

  for (const file of bumped) {
    await writeFileAtomic(file.abs, file.content);
  }

  log('Bump', `Version bumped to ${newVersion} (${bumped.map((f) => f.rel).join(', ')})`, 'pass');
}

async function writeFileAtomic(filePath, content) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, filePath);
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const doTag = args.includes('--tag');
  const skipGitClean = args.includes('--skip-git-check');
  const bumpArg = args.find((a) => a.startsWith('--bump='));
  const bumpType = bumpArg ? bumpArg.split('=')[1] : null;

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║     Kimi Plugin CC — Release Validation CLI              ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  if (dryRun) {
    log('Config', 'Running in DRY-RUN mode — no changes will be made', 'warn');
  }

  const checks = [
    ...(skipGitClean ? [] : [{ name: 'Git clean', fn: checkGitClean }]),
    { name: 'Version consistency', fn: checkVersionConsistency },
    { name: 'Syntax lint', fn: checkLint },
    { name: 'Tests', fn: checkTests },
    { name: 'Plugin manifest', fn: checkPluginManifest },
    { name: 'Required files', fn: checkRequiredFiles },
    { name: 'Broker smoke test', fn: checkBrokerSmoke },
    { name: 'Agent files', fn: checkAgentFiles },
    { name: 'Command files', fn: checkCommandFiles },
    { name: 'kimi-code plugin', fn: checkKimiCodePlugin },
    { name: 'npm pack', fn: checkNpmPack },
  ];

  let version;
  let failed = 0;

  for (const check of checks) {
    try {
      const result = await check.fn();
      if (check.name === 'Version consistency') version = result;
      log(check.name, 'PASS', 'pass');
    } catch (e) {
      log(check.name, `FAIL — ${e.message}`, 'fail');
      failed++;
    }
  }

  console.log('');
  if (failed > 0) {
    log('Result', `${failed}/${checks.length} checks failed. Release BLOCKED.`, 'fail');
    process.exit(1);
  }

  log('Result', `${checks.length}/${checks.length} checks passed. Ready to ship.`, 'pass');

  if (!bumpType && !doTag) {
    console.log('\nTip: Use --bump=patch|minor|major to auto-bump version');
    console.log('Tip: Use --tag to create git tag after bump');
    return;
  }

  if (bumpType) {
    const newVersion = bumpVersion(version, bumpType);
    log('Bump', `${version} → ${newVersion} (${bumpType})`);

    if (dryRun) {
      log('Bump', 'Skipped (dry-run)', 'warn');
    } else {
      await doBump(newVersion);
      version = newVersion;
    }
  }

  if (doTag) {
    log('Tag', `Creating git tag v${version}`);
    if (dryRun) {
      log('Tag', 'Skipped (dry-run)', 'warn');
    } else {
      // Stage only the version-bearing files + CHANGELOG so unrelated
      // dirty files in the working tree are not swept into the commit.
      await run('git', ['add', '--',
        'package.json',
        'plugins/kimi/.claude-plugin/plugin.json',
        '.claude-plugin/marketplace.json',
        'kimi.plugin.json',
        'CHANGELOG.md',
      ]);
      await run('git', ['commit', '-m', `release: v${version}`]);
      await run('git', ['tag', `v${version}`]);
      log('Tag', `Created tag v${version}`, 'pass');
      console.log(`\n  git push origin main --tags`);
      console.log(`  npm publish`);
    }
  }
}

main().catch((err) => {
  console.error('\nUnexpected error:', err.message);
  process.exit(1);
});
