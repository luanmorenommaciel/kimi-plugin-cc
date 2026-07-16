#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { getHandler, listCommands } from './lib/commands.mjs';

// Load .env if present (Node 20+ --env-file is preferred, but this works everywhere)
async function loadEnv() {
  try {
    const data = await readFile('.env', 'utf-8');
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

function usage() {
  console.log(`Usage: broker.mjs <command> [options]
Commands:
  dispatch --prompt <text> --agent-file <path> [--background] [--model] [--session-id] [--mode]
           [--auto-commit on|off|on-clean] [--force-dispatch] [--skip-preflight] [--no-context]
           [--plan-review] [--diff-review] [--tag <tag>] [--touches-paths <csv>]
           [--no-docs] [--research] [--patterns] [--force-commit] [--resume] [--force-resume]
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
  process.exit(1);
}

// A token is only an OPTION if it looks like one: `--` followed by a letter.
// A value that merely STARTS with dashes (e.g. a --prompt whose text begins
// with YAML frontmatter `---`) must be consumed as the value, not swallowed
// as a flag — that bug turned `--prompt "$TASK"` into `prompt: true` and
// shipped the literal string "true" to kimi.
const OPTION_RE = /^--[a-zA-Z]/;

function parseArgs(argv) {
  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (OPTION_RE.test(a)) {
      const key = a.slice(2).replace(/-/g, '_');
      const next = argv[i + 1];
      if (next !== undefined && !OPTION_RE.test(next)) {
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
  const handler = getHandler(cmd);

  if (!handler) {
    usage();
  }

  await handler(args, positional);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
