import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTempDir, cleanupTempDir } from './helpers.mjs';
import { invokeKimi, TIMEOUT_EXIT_CODE } from '../plugins/kimi/scripts/lib/kimi.mjs';
import { estimateTranscriptCostUsd } from '../plugins/kimi/scripts/lib/telemetry.mjs';

test('estimateTranscriptCostUsd converts bytes to USD at the output rate', () => {
  // (bytes/4)/1e6 × $2.0 default output rate
  assert.equal(estimateTranscriptCostUsd(4_000_000), 2.0);
  assert.equal(estimateTranscriptCostUsd(0), 0);
});

test('--max-cost kills a runaway crank with reason max-cost', async () => {
  const tmpPlugin = makeTempDir();
  const binDir = makeTempDir();
  // Shim that spews output forever — cost estimate crosses any cap fast.
  const shim = path.join(binDir, 'kimi');
  fs.writeFileSync(
    shim,
    '#!/usr/bin/env bash\nwhile true; do head -c 2000 /dev/zero | tr \'\\0\' \'x\'; echo; done\n'
  );
  fs.chmodSync(shim, 0o755);

  const prevEnv = process.env.KIMI_PLUGIN_DATA;
  const prevCost = process.env.KIMI_MAX_COST_USD;
  const prevPath = process.env.PATH;
  process.env.KIMI_PLUGIN_DATA = tmpPlugin;
  process.env.KIMI_MAX_COST_USD = '0.000001';
  process.env.PATH = `${binDir}:${prevPath}`;

  try {
    const result = await invokeKimi({
      prompt: 'burn budget',
      sessionId: 'maxcost-1',
      cwd: tmpPlugin,
    });
    assert.equal(result.timedOut, true, 'must be treated as a terminal kill');
    assert.equal(result.exitCode, TIMEOUT_EXIT_CODE, 'same exit-6 contract as timeouts');
    assert.equal(result.timeoutReason, 'max-cost', 'reason must identify the budget breach');
  } finally {
    process.env.PATH = prevPath;
    process.env.KIMI_PLUGIN_DATA = prevEnv;
    if (prevCost === undefined) delete process.env.KIMI_MAX_COST_USD;
    else process.env.KIMI_MAX_COST_USD = prevCost;
    cleanupTempDir(tmpPlugin);
    cleanupTempDir(binDir);
  }
});
