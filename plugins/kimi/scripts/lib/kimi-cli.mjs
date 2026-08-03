import { execFile } from 'node:child_process';

/**
 * Kimi Code 0.x CLI surface: generation detection + the single spawn-arg
 * builder used by both foreground (kimi.mjs) and background (job-control.mjs)
 * dispatch. The legacy Python kimi-cli 1.x is NOT supported — its flags
 * (--print, --work-dir, --agent-file) do not exist on Kimi Code 0.x.
 */

// Version probing spawns a process, so cache the result for the lifetime of
// this broker process.
let cached = null;

/**
 * Minimum Kimi Code version for full feature support (native resume via the
 * `session.resume_hint` stream-json meta line, wire.jsonl usage records).
 * Below this the CLI works but those features silently degrade — doctor
 * surfaces an upgrade warning instead.
 */
export const MIN_KIMI_CODE_VERSION = '0.28.0';

/** Compare two dotted versions: negative if a < b, 0 if equal, positive if a > b. */
export function compareSemver(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/**
 * Build the argv for a headless Kimi Code run.
 *
 * Kimi Code 0.x notes:
 * - prompt mode (`-p`) runs under auto permission — `--yolo` is REJECTED in
 *   combination with `-p`, so it must never appear here.
 * - there is no `--work-dir`; the working directory is set via spawn cwd.
 * - there is no `--agent-file`; role prompts are composed into the prompt.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.model]
 * @param {string} [opts.resumeSessionId] - native Kimi session id to continue
 * @returns {string[]}
 */
export function buildKimiArgs({ prompt, model, resumeSessionId } = {}) {
  const args = ['--output-format', 'stream-json'];
  if (model) args.push('--model', model);
  if (resumeSessionId) args.push('--session', resumeSessionId);
  args.push('-p', prompt);
  return args;
}

/**
 * Detect which CLI generation the `kimi` binary is.
 *
 * @param {object} [opts]
 * @param {string} [opts.bin] - defaults to $KIMI_CLI_BIN or 'kimi'
 * @param {Function} [opts.execFileImpl] - test injection point
 * @param {boolean} [opts.fresh] - bypass the per-process cache
 * @returns {Promise<{ok: boolean, bin: string, generation: 'kimi-code'|'legacy'|'missing'|'unknown', version: string, error?: string}>}
 */
export async function detectKimiCli(opts = {}) {
  if (cached && !opts.fresh) return cached;
  const bin = opts.bin || process.env.KIMI_CLI_BIN || 'kimi';
  const execFileImpl = opts.execFileImpl || execFile;

  const result = await new Promise((resolve) => {
    execFileImpl(bin, ['--version'], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          ok: false, bin, generation: 'missing', version: '',
          error: String(stderr || err.message || 'spawn failed').trim(),
        });
        return;
      }
      const out = String(stdout).trim();
      const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
      if (!m) {
        resolve({ ok: false, bin, generation: 'unknown', version: out, error: `unrecognized version output: ${out}` });
        return;
      }
      const major = Number(m[1]);
      resolve({
        ok: major === 0,
        bin,
        generation: major === 0 ? 'kimi-code' : 'legacy',
        version: m[0],
        belowFloor: major === 0 && compareSemver(m[0], MIN_KIMI_CODE_VERSION) < 0,
      });
    });
  });

  cached = result;
  return result;
}

/**
 * Like detectKimiCli, but throws a descriptive error unless the binary is a
 * supported Kimi Code 0.x install. Returns the detection result on success.
 */
export async function assertSupportedCli(opts = {}) {
  const d = await detectKimiCli(opts);
  if (d.ok) return d;
  if (d.generation === 'legacy') {
    throw new Error(
      `Unsupported legacy kimi-cli ${d.version} at "${d.bin}". This plugin requires Kimi Code 0.x — ` +
      `install it (npm i -g @moonshot-ai/kimi-code or the native installer from https://www.kimi.com/code), ` +
      `or run "/upgrade" inside the legacy CLI to migrate.`
    );
  }
  if (d.generation === 'missing') {
    throw new Error(
      `kimi binary not usable at "${d.bin}" (${d.error}). ` +
      `Install Kimi Code (npm i -g @moonshot-ai/kimi-code) and run "kimi login".`
    );
  }
  throw new Error(`Could not determine kimi CLI generation from "${d.bin}": ${d.error}`);
}

/** Test-only: clear the per-process detection cache. */
export function resetCliDetectionCache() {
  cached = null;
}

/**
 * Thinking-effort levels accepted by Kimi Code (wire field `thinking.effort`).
 * K3 supports low/high/max; the wider set is accepted for other models.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Validate a user-supplied --effort value. Throws on invalid input.
 * @returns {string} the validated effort level
 */
export function normalizeEffort(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!EFFORT_LEVELS.includes(v)) {
    throw new Error(`Invalid --effort "${value}". Valid levels: ${EFFORT_LEVELS.join(', ')}`);
  }
  return v;
}

/**
 * Spawn environment for a kimi child process. When an effort level is given,
 * it is forced on the wire via KIMI_MODEL_THINKING_EFFORT (documented Kimi
 * Code env channel — applies to the kimi provider while Thinking is on).
 */
export function kimiSpawnEnv(opts = {}) {
  const env = { ...process.env };
  if (opts.effort) {
    env.KIMI_MODEL_THINKING_EFFORT = normalizeEffort(opts.effort);
  }
  return env;
}

/**
 * Per-mode thinking-effort defaults: read-only modes think cheap, execution
 * modes think hard. An explicit --effort always wins; the off switch
 * (--effort-default off / KIMI_EFFORT_DEFAULTS=off) restores no-default.
 */
export const MODE_EFFORT_DEFAULTS = {
  review: 'low',
  challenge: 'low',
  explore: 'low',
  crank: 'high',
  plan: 'high',
};

/**
 * Resolve the effective effort for a dispatch.
 *
 * @returns {{effort: string, source: 'explicit'|'mode-default'|'none'}}
 */
export function resolveEffort({ explicit, mode, off = false } = {}) {
  if (explicit) {
    return { effort: normalizeEffort(explicit), source: 'explicit' };
  }
  if (!off && MODE_EFFORT_DEFAULTS[mode]) {
    return { effort: MODE_EFFORT_DEFAULTS[mode], source: 'mode-default' };
  }
  return { effort: '', source: 'none' };
}
