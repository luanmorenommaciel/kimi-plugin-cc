#!/usr/bin/env node
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { getHandler, listCommands } from './lib/commands.mjs';

// Locate .env: cwd first (historic behavior), then walk UP toward the git
// repo root so invoking the broker from a subdirectory still finds it.
// Stops at the first directory containing .git (the repo root) and never
// reads anything above it.
async function findEnvFile() {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, '.env');
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not here — keep walking
    }
    try {
      await access(path.join(dir, '.git'));
      return null; // repo root reached without finding .env — stop
    } catch {
      // not the root yet
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

// Load .env if present (Node 20+ --env-file is preferred, but this works everywhere)
async function loadEnv() {
  try {
    const data = await readFile(await findEnvFile() || '.env', 'utf-8');
    for (const line of data.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      // Remove surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env not found — ignore
  }
}

await loadEnv();

function usage(exitCode = 1) {
  console.log(`Usage: broker.mjs <command> [options]
Commands:
  doctor             verify Kimi Code 0.x binary, config, auth, MCPs, and role prompts
  dispatch --prompt <text> [--role coder|explore] [--background] [--model] [--session-id] [--mode]
           [--effort low|medium|high|xhigh|max] [--max-cost <usd>]
           [--auto-commit on|off|on-clean] [--force-dispatch] [--skip-preflight] [--no-context]
           [--plan-review] [--diff-review] [--tag <tag>] [--touches-paths <csv>]
           [--no-docs] [--docs-provider context7|firecrawl] [--research] [--deep-research] [--patterns] [--force-commit] [--resume] [--force-resume]
  status [--session-id <id>]
  result [--session-id <id>] [--raw]
  cancel [--session-id <id>]
  diff-capture --session-id <id> --phase <pre|post>
  branch-diff --base <ref>
  working-diff
  latest-session
  watch --session-id <id> [--verbose]
  report [--since <iso>] [--tag <tag>] [--format table|json|md]
  batch <glob> [--max-parallel N] [--force-dispatch] [--skip-preflight]
  next [--tasks-dir <dir>] [--force-dispatch] [--skip-preflight] [--model <model>]
  telemetry --session-id <id>
  checkpoint --session-id <id> [--restore] [--list]
  monitor --task-path <path> [--check]
  prune [--older-than 30d] [--yes]
  review-gate [--enable|--disable]
  export-debug [--session-id <id>] [--output <path>]
  warnings [--since <iso>]
  check-update

Exit codes (dispatch):
  0  ok / dispatched
  2  origin-diverged   (local branch diverged from origin on touches_paths)
  3  buggy-evals       (preflight found broken eval bodies — fix the spec)
  4  review-pause      (plan-review or diff-review returned CONCERN/REVISE/REJECT)
  5  checkpoint-conflict (resume could not re-apply the stashed checkpoint)
  6  timeout           (wall-clock or idle-output watchdog killed a hung crank)
`);
  process.exit(exitCode);
}

// Known flags per command (derived from what each cmd* handler actually
// reads). parseArgs normalizes `--foo-bar` to `foo_bar`; validation runs on
// the normalized names and reports them back in --kebab-case.
const DISPATCH_FLAGS = [
  'prompt', 'role', 'background', 'model', 'session_id', 'mode',
  'effort', 'effort_default', 'max_cost', 'auto_commit', 'force_dispatch',
  'skip_preflight', 'no_context', 'plan_review', 'diff_review', 'tag',
  'touches_paths', 'no_docs', 'docs_provider', 'research', 'deep_research',
  'patterns', 'force_commit', 'resume', 'force_resume', 'fresh', 'task_path',
];

const KNOWN_FLAGS = {
  dispatch: DISPATCH_FLAGS,
  // INTERNAL: re-exec target for detached background cranks — not in usage/README.
  supervise: ['session_id'],
  doctor: [],
  status: ['session_id'],
  result: ['session_id', 'raw'],
  cancel: ['session_id'],
  'diff-capture': ['session_id', 'phase'],
  'branch-diff': ['base'],
  'working-diff': [],
  'latest-session': [],
  watch: ['session_id', 'verbose'],
  report: ['since', 'tag', 'format'],
  batch: [...DISPATCH_FLAGS, 'max_parallel'],
  next: [...DISPATCH_FLAGS, 'tasks_dir'],
  telemetry: ['session_id'],
  checkpoint: ['session_id', 'restore', 'list'],
  monitor: ['task_path', 'check'],
  prune: ['older_than', 'yes'],
  'review-gate': ['enable', 'disable'],
  'export-debug': ['session_id', 'output'],
  warnings: ['since'],
  'check-update': [],
};

// Tiny Levenshtein for "did you mean" suggestions on near-miss flags.
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

function validateFlags(cmd, args) {
  const known = KNOWN_FLAGS[cmd];
  if (!known) return;
  for (const key of Object.keys(args)) {
    if (known.includes(key)) continue;
    const flag = `--${key.replace(/_/g, '-')}`;
    const valid = known.map((f) => `--${f.replace(/_/g, '-')}`);
    let suggestion = '';
    let best = null;
    for (const f of known) {
      const d = levenshtein(key, f);
      if (d <= 2 && (best === null || d < best.d)) best = { f, d };
    }
    if (best) suggestion = ` Did you mean --${best.f.replace(/_/g, '-')}?`;
    console.error(`Unknown flag ${flag} for "${cmd}".${suggestion}\nValid flags: ${valid.length ? valid.join(', ') : '(none)'}`);
    process.exit(1);
  }
}

function parseArgs(argv) {
  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-/g, '_');
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, args };
}

async function main() {
  const { positional, args } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  if (cmd === 'help' || args.help) {
    usage(0);
  }

  const handler = getHandler(cmd);

  if (!handler) {
    usage();
  }

  validateFlags(cmd, args);

  await handler(args, positional);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
