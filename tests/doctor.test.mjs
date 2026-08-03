import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDir, cleanupTempDir } from './helpers.mjs';
import { getHandler } from '../plugins/kimi/scripts/lib/commands.mjs';
import { resetCliDetectionCache } from '../plugins/kimi/scripts/lib/kimi-cli.mjs';

function makeKimiShim(binDir, version = '0.28.1') {
  const shim = path.join(binDir, 'kimi-fake');
  fs.writeFileSync(
    shim,
    '#!/usr/bin/env bash\n' +
      `if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\n` +
      'if [ "$1" = "doctor" ]; then echo "All checked config files are valid."; exit 0; fi\n' +
      'exit 0\n'
  );
  fs.chmodSync(shim, 0o755);
  return shim;
}

async function runDoctor() {
  const lines = [];
  const origLog = console.log;
  console.log = (s) => lines.push(s);
  const prevExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    await getHandler('doctor')({});
  } finally {
    console.log = origLog;
  }
  const exitCode = process.exitCode;
  process.exitCode = prevExitCode || 0;
  return { report: JSON.parse(lines.join('\n')), exitCode };
}

function setupEnv(t) {
  const binDir = makeTempDir();
  const home = makeTempDir();
  const shim = makeKimiShim(binDir);
  const prevBin = process.env.KIMI_CLI_BIN;
  const prevHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CLI_BIN = shim;
  process.env.KIMI_CODE_HOME = home;
  resetCliDetectionCache();
  t.after(() => {
    if (prevBin === undefined) delete process.env.KIMI_CLI_BIN;
    else process.env.KIMI_CLI_BIN = prevBin;
    if (prevHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = prevHome;
    resetCliDetectionCache();
    cleanupTempDir(binDir);
    cleanupTempDir(home);
  });
  return { shim, home };
}

test('doctor reports a healthy Kimi Code 0.x install', async (t) => {
  const { home } = setupEnv(t);
  fs.mkdirSync(path.join(home, 'credentials', 'kimi-code'), { recursive: true });
  fs.writeFileSync(path.join(home, 'mcp.json'), JSON.stringify({ mcpServers: { exa: {}, tavily: {} } }));

  const { report, exitCode } = await runDoctor();
  assert.equal(report.ok, true);
  assert.equal(exitCode, 0);
  assert.equal(report.checks.binary.generation, 'kimi-code');
  assert.equal(report.checks.binary.version, '0.28.1');
  assert.equal(report.checks.config.ok, true);
  assert.match(report.checks.config.output, /valid/);
  assert.equal(report.checks.auth.ok, true);
  assert.deepEqual(report.checks.mcp.names.sort(), ['exa', 'tavily']);
  assert.equal(report.checks.roles.ok, true);
});

test('doctor fails when not authenticated (without spending quota)', async (t) => {
  setupEnv(t); // no credentials dir created

  const { report, exitCode } = await runDoctor();
  assert.equal(report.ok, false);
  assert.equal(exitCode, 1);
  assert.equal(report.checks.auth.ok, false);
  assert.match(report.checks.auth.hint, /kimi login/);
  // Binary and roles still report fine — the failure is scoped to auth.
  assert.equal(report.checks.binary.ok, true);
  assert.equal(report.checks.roles.ok, true);
});

test('doctor warns when the CLI is below the feature floor', async (t) => {
  const binDir = makeTempDir();
  const home = makeTempDir();
  const shim = makeKimiShim(binDir, '0.20.0');
  const prevBin = process.env.KIMI_CLI_BIN;
  const prevHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CLI_BIN = shim;
  process.env.KIMI_CODE_HOME = home;
  resetCliDetectionCache();
  fs.mkdirSync(path.join(home, 'credentials', 'kimi-code'), { recursive: true });
  t.after(() => {
    if (prevBin === undefined) delete process.env.KIMI_CLI_BIN;
    else process.env.KIMI_CLI_BIN = prevBin;
    if (prevHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = prevHome;
    resetCliDetectionCache();
    cleanupTempDir(binDir);
    cleanupTempDir(home);
  });

  const { report } = await runDoctor();
  assert.equal(report.checks.binary.ok, true, '0.20.0 is still a supported generation');
  assert.match(report.checks.binary.upgrade_recommended, />= 0\.28\.0.*0\.20\.0/s);
});
