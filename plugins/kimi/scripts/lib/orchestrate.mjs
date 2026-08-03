import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Surgically update the `status:` field of a task spec's frontmatter.
 * Single-line replace inside the --- block only; everything else is
 * preserved byte-for-byte. Returns false when the file has no status field.
 *
 * @param {string} taskPath - absolute path to the task markdown file
 * @param {string} status - e.g. 'ready' | 'in-progress' | 'completed' | 'failed'
 * @returns {Promise<boolean>}
 */
export async function updateTaskStatus(taskPath, status) {
  let content;
  try {
    content = await readFile(taskPath, 'utf-8');
  } catch {
    return false;
  }
  const fm = content.match(/^(---\n[\s\S]*?\n---)/);
  if (!fm) return false;
  const block = fm[1];
  if (!/^status:\s*.+$/m.test(block)) return false;
  const updated = block.replace(/^status:\s*.+$/m, `status: ${status}`);
  await writeFile(taskPath, updated + content.slice(block.length));
  return true;
}

/**
 * Build an execution graph from task files.
 *
 * @param {string[]} taskPaths - absolute paths to task markdown files
 * @returns {{waves: Array<Array<object>>, conflicts: string[]}}
 */
export async function buildGraph(taskPaths, maxParallel = 4) {
  const tasks = [];
  for (const p of taskPaths) {
    const t = await parseTask(p);
    if (t) tasks.push(t);
  }

  // Topological sort by depends_on
  const sorted = topoSort(tasks);

  // Assign waves: earliest wave where deps are in prior waves
  // and touches_paths don't overlap with other tasks in the same wave
  const waves = [];
  const allowlist = new Set([
    'SKILL.md', 'README.md', 'CHANGELOG.md', 'CLAUDE.md', 'AGENTS.md',
  ]);

  for (const task of sorted) {
    let placed = false;
    for (let w = 0; w < waves.length; w++) {
      const wave = waves[w];
      // All deps must be in earlier waves
      const depsSatisfied = task.depends_on.every((depId) =>
        waves.slice(0, w).some((earlier) => earlier.some((t) => t.id === depId))
      );
      if (!depsSatisfied) continue;

      // touches_paths must be disjoint (except allowlisted docs)
      const conflict = wave.some((t) => pathsOverlap(task.touches_paths, t.touches_paths, allowlist));
      if (!conflict) {
        wave.push(task);
        placed = true;
        break;
      }
    }
    if (!placed) {
      waves.push([task]);
    }
  }

  // Detect any conflicts that forced serialization
  const conflicts = [];
  for (let w = 0; w < waves.length; w++) {
    for (const task of waves[w]) {
      for (let prev = 0; prev < w; prev++) {
        for (const pt of waves[prev]) {
          if (pathsOverlap(task.touches_paths, pt.touches_paths, allowlist)) {
            conflicts.push(`${pt.id} -> ${task.id} (shared paths)`);
          }
        }
      }
    }
  }

  return { waves, conflicts: [...new Set(conflicts)] };
}

async function parseTask(taskPath) {
  let content;
  try {
    content = await readFile(taskPath, 'utf-8');
  } catch {
    return null;
  }

  const id = extractFrontmatter(content, 'id') || path.basename(taskPath, '.md');
  const title = extractFrontmatter(content, 'title') || id;
  const priority = extractFrontmatter(content, 'priority') || 'P2';

  // depends_on
  const dependsOn = [];
  const depMatch = content.match(/depends_on:\s*\n((?:\s+-\s+.*\n?)+)/);
  if (depMatch) {
    const lines = depMatch[1].split('\n').filter((l) => l.trim().startsWith('-'));
    for (const line of lines) {
      const v = line.replace(/^\s+-\s+/, '').trim();
      if (v && v !== '[]') dependsOn.push(v);
    }
  }

  // touches_paths
  const touchesPaths = [];
  const tpMatch = content.match(/touches_paths:\s*\n((?:\s+-\s+.*\n?)+)/);
  if (tpMatch) {
    const lines = tpMatch[1].split('\n').filter((l) => l.trim().startsWith('-'));
    for (const line of lines) {
      const v = line.replace(/^\s+-\s+/, '').trim();
      if (v) touchesPaths.push(v);
    }
  }

  return { id, title, priority, depends_on: dependsOn, touches_paths: touchesPaths, path: taskPath };
}

function extractFrontmatter(content, key) {
  const re = new RegExp(`^${key}:\\s*(.+)$`, 'm');
  const m = content.match(re);
  return m ? m[1].trim() : null;
}

function topoSort(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set();
  const result = [];

  function visit(t) {
    if (visited.has(t.id)) return;
    visited.add(t.id);
    for (const depId of t.depends_on) {
      const dep = byId.get(depId);
      if (dep) visit(dep);
    }
    result.push(t);
  }

  for (const t of tasks) visit(t);
  return result;
}

function pathsOverlap(a, b, allowlist) {
  for (const pa of a) {
    const baseA = path.basename(pa);
    if (allowlist.has(baseA)) continue;
    for (const pb of b) {
      const baseB = path.basename(pb);
      if (allowlist.has(baseB)) continue;
      if (pa === pb || pa.startsWith(pb + '/') || pb.startsWith(pa + '/')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Roll up batch results from a set of session IDs.
 *
 * @param {object[]} sessions - session meta objects
 * @returns {object}
 */
export function rollupBatch(sessions) {
  const total = sessions.length;
  const completed = sessions.filter((s) => s.status === 'completed').length;
  const failed = sessions.filter((s) => s.status === 'failed').length;
  const cancelled = sessions.filter((s) => s.status === 'cancelled').length;

  let totalDurationSec = 0;
  let totalTokens = 0;
  let totalCost = 0;

  for (const s of sessions) {
    if (s.started_at && s.finished_at) {
      totalDurationSec += (new Date(s.finished_at) - new Date(s.started_at)) / 1000;
    }
    if (s.telemetry) {
      totalTokens += (s.telemetry.prompt_tokens || 0) + (s.telemetry.completion_tokens || 0);
      totalCost += s.telemetry.estimated_cost_usd || 0;
    }
  }

  return {
    sessions: total,
    completed,
    failed,
    cancelled,
    pass_rate: total > 0 ? Math.round((completed / total) * 1000) / 10 : 0,
    total_duration_sec: Math.round(totalDurationSec),
    total_tokens: totalTokens,
    total_cost_usd: Math.round(totalCost * 10000) / 10000,
    details: sessions.map((s) => ({
      id: s.session_id,
      status: s.status,
      duration_sec: s.started_at && s.finished_at
        ? Math.round((new Date(s.finished_at) - new Date(s.started_at)) / 1000)
        : null,
      committed: s.committed || false,
      commit_sha: s.commit_sha || null,
      tokens: s.telemetry
        ? (s.telemetry.prompt_tokens || 0) + (s.telemetry.completion_tokens || 0)
        : null,
      cost: s.telemetry?.estimated_cost_usd || null,
    })),
  };
}
