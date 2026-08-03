import { execFile, spawnSync } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const VERDICTS = ['APPROVE', 'APPROVE_COMMIT', 'CONCERN', 'DIFFERENT_APPROACH', 'REVISE', 'REJECT'];

function detectCodexCmd() {
  if (process.env.CODEX_CMD) return process.env.CODEX_CMD;
  // Probe common Codex CLI entrypoints in order; fall back to 'codex' and let
  // codexReview degrade to SKIP when it is not actually installed.
  const candidates = ['codex', 'codex-cli'];
  for (const c of candidates) {
    const r = spawnSync('which', [c], { stdio: 'ignore' });
    if (r.status === 0) return c;
  }
  return candidates[0];
}

/**
 * Send a prompt to Codex and parse a verdict.
 *
 * @param {string} prompt - the structured prompt to send
 * @param {object} [opts]
 * @param {string} [opts.outputDir] - where to write verdict JSON
 * @returns {Promise<{verdict: string, reason: string, raw: string}>}
 */
export async function codexReview(prompt, opts = {}) {
  const cmd = detectCodexCmd();
  const args = ['--print', '--yolo', '-p', prompt];

  let raw = '';
  try {
    raw = await new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 300000, shell: true }, (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error(stderr || err.message));
        } else {
          resolve(stdout || stderr || '');
        }
      });
    });
  } catch (e) {
    return {
      verdict: 'SKIP',
      reason: `Codex unavailable: ${e.message}`,
      raw: '',
    };
  }

  // Parse verdict from final line. Longest-first so APPROVE_COMMIT is not
  // swallowed by the APPROVE substring; match at line end, not anywhere.
  let verdict = 'CONCERN';
  const lines = raw.trim().split('\n');
  const byLength = [...VERDICTS].sort((a, b) => b.length - a.length);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    const v = byLength.find((x) => line === x || line.endsWith(`VERDICT: ${x}`));
    if (v) {
      verdict = v;
      break;
    }
  }

  const result = { verdict, reason: extractReason(raw), raw };

  if (opts.outputDir) {
    await mkdir(opts.outputDir, { recursive: true });
    const outFile = path.join(
      opts.outputDir,
      `codex-verdict-${opts.taskId || Date.now()}.json`
    );
    await writeFile(outFile, JSON.stringify(result, null, 2));
  }

  return result;
}

function extractReason(raw) {
  const lines = raw.trim().split('\n');
  // Look for a "Reason:" or bullet after VERDICT
  for (const line of lines) {
    if (line.toLowerCase().startsWith('reason:')) {
      return line.replace(/^reason:\s*/i, '').trim();
    }
  }
  return '';
}

/**
 * Build a plan-review prompt for Codex.
 *
 * @param {string} taskSpec - the task markdown content
 * @param {string} projectContext - brief project description
 * @returns {string}
 */
export function buildPlanReviewPrompt(taskSpec, projectContext) {
  return `You are an adversarial reviewer. A worker agent is about to execute the following task. Review the plan and approach. Flag risks, missing steps, or better alternatives.

PROJECT CONTEXT:
${projectContext || '(none provided)'}

TASK SPEC:
${taskSpec.slice(0, 4000)}

End your response with exactly one line: VERDICT: APPROVE | CONCERN | DIFFERENT_APPROACH
If CONCERN or DIFFERENT_APPROACH, briefly explain why.`;
}

/**
 * Build a diff-review prompt for Codex.
 *
 * @param {string} diff - git diff output
 * @param {string} taskTitle - task title
 * @returns {string}
 */
export function buildDiffReviewPrompt(diff, taskTitle) {
  return `You are an adversarial reviewer. A worker agent has produced the following diff for task "${taskTitle}". Review the changes for correctness, safety, and completeness.

DIFF:
\`\`\`diff
${diff.slice(0, 6000)}
\`\`\`

End your response with exactly one line: VERDICT: APPROVE_COMMIT | REVISE | REJECT
If REVISE or REJECT, briefly explain why.`;
}
