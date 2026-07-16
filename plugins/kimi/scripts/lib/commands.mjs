import { invokeKimi, watchSession } from './kimi.mjs';
import { captureDiff, getBranchDiff, getWorkingDiff, fetchAndCompare } from './git.mjs';
import { initSessionDir, writeMeta, readMeta, updateMeta, safeUpdateMeta, listSessions, isRunning, getLatestSessionForRepo } from './state.mjs';
import { startBackground, cancelSession, getSessionsDir, listCheckpoints, restoreCheckpoint } from './job-control.mjs';
import { findRepoRoot, readRepoSession, writeRepoSession } from './workspace.mjs';
import { renderReview, renderExplore, renderReport } from './render.mjs';
import { preflight } from './preflight.mjs';
import { discoverContext } from './context.mjs';
import { parseTelemetry, attachTelemetry } from './telemetry.mjs';
import { buildGraph, rollupBatch } from './orchestrate.mjs';
import { codexReview, buildPlanReviewPrompt, buildDiffReviewPrompt } from './codex-bridge.mjs';
import { commitWork } from './commit.mjs';
import { warn, readWarnings } from './warn.mjs';
import { discoverLibraryDocs } from './docs.mjs';
import { extractResearchTopics, researchTopics } from './research.mjs';
import { extractApiReferences, validateApiReferences } from './validate-api.mjs';
import { searchPatterns } from './patterns.mjs';
import { captureBaseline, checkForChanges } from './monitor.mjs';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { matchGlob } from './glob.mjs';

// ------------------------------------------------------------------
// Registry
// ------------------------------------------------------------------

const registry = new Map();

export function register(name, handler) {
  registry.set(name, handler);
}

export function getHandler(name) {
  return registry.get(name);
}

export function listCommands() {
  return Array.from(registry.keys());
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

async function runDispatch(opts) {
  await initSessionDir();
  const repoPath = await findRepoRoot();

  const prompt = opts.prompt;
  // Guard against parser artifacts (a --prompt whose value got swallowed as a
  // flag arrives as boolean true) — never ship a non-string prompt to kimi.
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { status: 'failed', reason: 'invalid-prompt', error: '--prompt must be a non-empty string', exitCode: 1 };
  }
  const agentFile = path.resolve(opts.agent_file);
  const background = opts.background === true || opts.background === 'true';
  const model = opts.model || '';
  const sessionId = opts.session_id || crypto.randomUUID();
  const mode = opts.mode || 'crank';
  const autoCommitPolicy = opts.auto_commit || 'on-clean';
  const forceDispatch = opts.force_dispatch === true || opts.force_dispatch === 'true';
  const skipPreflight = opts.skip_preflight === true || opts.skip_preflight === 'true';
  const noContext = opts.no_context === true || opts.no_context === 'true';
  const noDocs = opts.no_docs === true || opts.no_docs === 'true';
  const research = opts.research === true || opts.research === 'true';
  const patterns = opts.patterns === true || opts.patterns === 'true';
  const planReview = opts.plan_review === true || opts.plan_review === 'true';
  const diffReview = opts.diff_review === true || opts.diff_review === 'true';
  const tag = opts.tag || '';
  const touchesPaths = opts.touches_paths ? opts.touches_paths.split(',').map((s) => s.trim()).filter(Boolean) : [];

  // Write initial meta envelope BEFORE any awaitable that can throw — guarantees
  // safeUpdateMeta in the catch handler always has a file to merge into.
  // baseline_sha is filled in after `git rev-parse` resolves below.
  await writeMeta(sessionId, {
    session_id: sessionId,
    agent_file: agentFile,
    prompt,
    model,
    started_at: new Date().toISOString(),
    status: 'running',
    repo_path: repoPath,
    mode,
    auto_commit_policy: autoCommitPolicy,
    tag,
    touches_paths: touchesPaths,
    baseline_sha: '',
  });

  try {
    // Handle --resume: read latest session and optionally restore checkpoint
    if (opts.resume === true || opts.resume === 'true') {
      const latest = await readRepoSession(repoPath);
      if (latest) {
        const forceResume = opts.force_resume === true || opts.force_resume === 'true';
        if (!forceResume) {
          const checkpoints = await listCheckpoints(repoPath);
          const cp = checkpoints.find((c) => c.session_id === latest);
          if (cp) {
            const restored = await restoreCheckpoint(latest, repoPath);
            if (!restored.ok) {
              await updateMeta(sessionId, { status: 'blocked', reason: 'checkpoint-conflict', finished_at: new Date().toISOString() });
              return { status: 'blocked', reason: 'checkpoint-conflict', session_id: latest, error: restored.error, exitCode: 5 };
            }
          }
        }
        const resumePrompt = `Continue from previous session ${latest}.\n\n${prompt}`;
        opts.prompt = resumePrompt;
      }
    }

    // Resolve baseline SHA
    let baselineSha = '';
    try {
      const { execFile } = await import('node:child_process');
      baselineSha = (await new Promise((resolve) => {
        execFile('git', ['rev-parse', 'HEAD'], { cwd: repoPath }, (err, stdout) => {
          resolve(err ? '' : stdout.trim());
        });
      })) || '';
    } catch (e) {
      await warn('broker', e, 'info');
      baselineSha = '';
    }
    await updateMeta(sessionId, { baseline_sha: baselineSha });

    // Origin-state awareness
    if (!forceDispatch && touchesPaths.length > 0) {
      const origin = await fetchAndCompare(touchesPaths, repoPath);
      if (origin.diverged) {
        await updateMeta(sessionId, { status: 'blocked', reason: 'origin-diverged', finished_at: new Date().toISOString() });
        return { status: 'blocked', reason: 'origin-diverged', conflicting_paths: origin.conflicting_paths, exitCode: 2 };
      }
    }

    // Preflight checks
    if (!skipPreflight && opts.task_path) {
      const pf = await preflight(path.resolve(opts.task_path), repoPath);
      if (pf.status === 'already-done') {
        await updateMeta(sessionId, { status: 'skipped', reason: 'already-done', finished_at: new Date().toISOString() });
        return { status: 'skipped', reason: 'already-done', findings: pf.findings, exitCode: 0 };
      }
      if (pf.status === 'buggy-evals') {
        await updateMeta(sessionId, { status: 'blocked', reason: 'buggy-evals', finished_at: new Date().toISOString() });
        return { status: 'blocked', reason: 'buggy-evals', findings: pf.findings, exitCode: 3 };
      }
    }

  // Context injection
  let finalPrompt = opts.prompt;
  if (!noContext && touchesPaths.length > 0) {
    try {
      const ctx = await discoverContext(touchesPaths, repoPath);
      if (ctx) finalPrompt = ctx + '\n' + finalPrompt;
    } catch (e) {
      await warn('context', e, 'warning');
    }
  }

  // Library docs injection (Context7/Tavily)
  if (!noDocs && touchesPaths.length > 0) {
    try {
      const docs = await discoverLibraryDocs(touchesPaths, repoPath);
      if (docs) finalPrompt = docs + '\n' + finalPrompt;
    } catch (e) {
      await warn('docs', e, 'warning');
    }
  }

  // Web research (Tavily/Exa)
  if (research && opts.task_path) {
    try {
      const taskSpec = await readFile(path.resolve(opts.task_path), 'utf-8');
      const topics = extractResearchTopics(taskSpec);
      if (topics.length > 0) {
        const researchCtx = await researchTopics(topics);
        if (researchCtx) finalPrompt = researchCtx + '\n' + finalPrompt;
      }
    } catch (e) {
      await warn('research', e, 'warning');
    }
  }

  // Code patterns (Exa semantic search)
  if (patterns && opts.task_path) {
    try {
      const taskSpec = await readFile(path.resolve(opts.task_path), 'utf-8');
      const topics = extractResearchTopics(taskSpec);
      if (topics.length > 0) {
        const patternCtx = await searchPatterns(topics);
        if (patternCtx) finalPrompt = patternCtx + '\n' + finalPrompt;
      }
    } catch (e) {
      await warn('patterns', e, 'warning');
    }
  }

  // External doc monitoring: capture baseline before dispatch
  const externalDocs = [];
  if (opts.task_path) {
    try {
      const taskSpec = await readFile(path.resolve(opts.task_path), 'utf-8');
      const docMatch = taskSpec.match(/external_docs:\s*\n((?:\s+-\s+.*\n?)+)/);
      if (docMatch) {
        const lines = docMatch[1].split('\n').filter((l) => l.trim().startsWith('-'));
        for (const line of lines) {
          const url = line.replace(/^\s+-\s+/, '').trim();
          if (url) externalDocs.push(url);
        }
      }
      const snapshotDir = path.join(repoPath, '.kimi', 'state', 'monitors');
      for (const url of externalDocs) {
        await captureBaseline(url, snapshotDir);
      }
    } catch (e) {
      await warn('monitor', e, 'info');
    }
  }

    // Plan review via Codex (optional)
    if (planReview && opts.task_path) {
      try {
        const taskSpec = await readFile(path.resolve(opts.task_path), 'utf-8');
        const review = await codexReview(buildPlanReviewPrompt(taskSpec, ''), {
          outputDir: path.join(repoPath, '.kimi', 'state'),
          taskId: sessionId,
        });
        if (review.verdict === 'CONCERN' || review.verdict === 'DIFFERENT_APPROACH') {
          await updateMeta(sessionId, { status: 'paused', reason: 'plan-review', verdict: review.verdict, finished_at: new Date().toISOString() });
          return { status: 'paused', reason: 'plan-review', verdict: review.verdict, detail: review.reason, exitCode: 4 };
        }
      } catch (e) {
        await warn('codex', e, 'warning');
      }
    }

    if (background) {
      // Update meta with final prompt + baseline_sha before handoff so the background
      // close handler in job-control.mjs has the current envelope to merge into.
      await updateMeta(sessionId, { prompt: finalPrompt });
      const result = await startBackground({
        sessionId, agentFile, prompt: finalPrompt, model, mode,
        autoCommitPolicy, tag, touchesPaths, baselineSha, repoPath,
      });
      return { ...result, exitCode: 0 };
    }

    // Foreground: merge the assembled prompt into the already-written meta
    await updateMeta(sessionId, { prompt: finalPrompt });

    const result = await invokeKimi({ prompt: finalPrompt, agentFile, model, sessionId, background: false, cwd: repoPath });

    // Timeout / idle-watchdog kill is terminal — fail fast with exit code 6,
    // leave work uncommitted so the supervisor can inspect or resume.
    if (result.timedOut) {
      await updateMeta(sessionId, {
        status: 'failed', reason: 'timeout', exit_code: result.exitCode,
        committed: false, finished_at: new Date().toISOString(),
      });
      await writeRepoSession(repoPath, sessionId);
      return { ...result, status: 'failed', reason: 'timeout', committed: false, exitCode: 6 };
    }

    // Capture diff immediately after Kimi returns
    const postDiff = await getWorkingDiff(repoPath);

    // Post-write API validation (Tavily)
    const forceCommit = opts.force_commit === true || opts.force_commit === 'true';
    if (postDiff.trim()) {
      try {
        const refs = extractApiReferences(postDiff);
        if (refs.length > 0) {
          const validation = await validateApiReferences(refs);
          if (!validation.valid && !forceCommit) {
            await updateMeta(sessionId, {
              status: result.exitCode === 0 ? 'completed' : 'failed',
              exit_code: result.exitCode, finished_at: new Date().toISOString(),
              api_validation_concerns: validation.concerns, committed: false,
            });
            await writeRepoSession(repoPath, sessionId);
            return { ...result, status: 'paused', reason: 'api-validation', api_validation: validation.concerns, committed: false, exitCode: 4 };
          }
        }
      } catch (e) {
        await warn('validate-api', e, 'warning');
      }
    }

    // Diff review via Codex (optional)
    if (diffReview) {
      try {
        if (postDiff.trim()) {
          const review = await codexReview(buildDiffReviewPrompt(postDiff, sessionId), {
            outputDir: path.join(repoPath, '.kimi', 'state'), taskId: sessionId,
          });
          if (review.verdict === 'REVISE' || review.verdict === 'REJECT') {
            await updateMeta(sessionId, {
              status: result.exitCode === 0 ? 'completed' : 'failed',
              exit_code: result.exitCode, finished_at: new Date().toISOString(),
              diff_review_verdict: review.verdict, committed: false,
            });
            await writeRepoSession(repoPath, sessionId);
            return { ...result, status: 'paused', reason: 'diff-review', diff_review: review.verdict, committed: false, exitCode: 4 };
          }
        }
      } catch (e) {
        await warn('codex', e, 'warning');
      }
    }

    await updateMeta(sessionId, {
      status: result.exitCode === 0 ? 'completed' : 'failed',
      exit_code: result.exitCode, finished_at: new Date().toISOString(),
    });

    // Durably commit Kimi's work per auto_commit_policy. Reaching here means
    // no review/validation early-return fired, so the diff is clean to commit.
    try {
      const m = await readMeta(sessionId);
      const c = await commitWork(repoPath, sessionId, m, { exitCode: result.exitCode, retries: result.retries ?? 0 });
      await updateMeta(sessionId, { committed: c.committed, commit_sha: c.commit_sha, commit_reason: c.reason });
    } catch (e) {
      await warn('commit', e, 'warning');
    }

    await writeRepoSession(repoPath, sessionId);

    // External doc monitoring: check for changes before commit
    if (externalDocs.length > 0) {
      try {
        const snapshotDir = path.join(repoPath, '.kimi', 'state', 'monitors');
        for (const url of externalDocs) {
          const check = await checkForChanges(url, snapshotDir);
          if (check && check.changed) {
            await warn('monitor', `External docs changed during session: ${url}`, 'warning');
          }
        }
      } catch (e) {
        await warn('monitor', e, 'info');
      }
    }

    return { ...result, exitCode: 0 };
  } catch (err) {
    // Bootstrap-safe: writeMeta at the top of runDispatch guarantees meta exists,
    // but safeUpdateMeta falls back to writeMeta if the file was deleted/missing.
    try {
      await safeUpdateMeta(sessionId, {
        status: 'failed',
        error: err.message,
        finished_at: new Date().toISOString(),
      });
    } catch (innerErr) {
      await warn('broker', innerErr, 'error');
    }
    throw err;
  } finally {
    // Always attempt to attach telemetry (warns-not-throws preserves prior behavior).
    // Skips silently for background dispatches where Kimi is still running — the
    // background close handler in job-control.mjs:71 attaches telemetry on close.
    if (!background) {
      try {
        await attachTelemetry(sessionId, getSessionsDir());
      } catch (e) {
        await warn('telemetry', e, 'warning');
      }
    }
  }
}

async function waitForSessions(sessionIds, timeoutMs = 600000) {
  const start = Date.now();
  const pending = new Set(sessionIds);
  while (pending.size > 0) {
    if (Date.now() - start > timeoutMs) break;
    for (const id of Array.from(pending)) {
      const running = await isRunning(id);
      if (!running) {
        try {
          const meta = await readMeta(id);
          if (['completed', 'failed', 'cancelled'].includes(meta.status)) {
            pending.delete(id);
          }
        } catch {
          pending.delete(id);
        }
      }
    }
    if (pending.size > 0) await new Promise((r) => setTimeout(r, 2000));
  }
  // Anything still pending at the deadline is stuck — actively cancel it
  // (kills the process + marks meta cancelled) rather than leaking a hung
  // child and an indeterminate working tree.
  const stuck = Array.from(pending);
  for (const id of stuck) {
    try {
      await cancelSession(id);
    } catch (e) {
      await warn('batch', e, 'warning');
    }
  }
  return stuck;
}

async function parseTaskFile(taskPath) {
  let content;
  try {
    content = await readFile(taskPath, 'utf-8');
  } catch {
    return null;
  }
  const id = content.match(/^id:\s*(.+)$/m)?.[1]?.trim() || path.basename(taskPath, '.md');
  const status = content.match(/^status:\s*(.+)$/m)?.[1]?.trim() || 'ready';
  const priority = content.match(/^priority:\s*(.+)$/m)?.[1]?.trim() || 'P2';
  const title = content.match(/^title:\s*(.+)$/m)?.[1]?.trim() || id;

  const dependsOn = [];
  const depMatch = content.match(/depends_on:\s*\n((?:\s+-\s+.*\n?)+)/);
  if (depMatch) {
    const lines = depMatch[1].split('\n').filter((l) => l.trim().startsWith('-'));
    for (const line of lines) {
      const v = line.replace(/^\s+-\s+/, '').trim();
      if (v && v !== '[]') dependsOn.push(v);
    }
  }

  const touchesPaths = [];
  const tpMatch = content.match(/touches_paths:\s*\n((?:\s+-\s+.*\n?)+)/);
  if (tpMatch) {
    const lines = tpMatch[1].split('\n').filter((l) => l.trim().startsWith('-'));
    for (const line of lines) {
      const v = line.replace(/^\s+-\s+/, '').trim();
      if (v) touchesPaths.push(v);
    }
  }

  return { id, status, priority, title, depends_on: dependsOn, touches_paths: touchesPaths, path: taskPath };
}

function priorityValue(p) {
  if (p === 'P0') return 0;
  if (p === 'P1') return 1;
  return 2;
}

// ------------------------------------------------------------------
// Command handlers
// ------------------------------------------------------------------

async function cmdDispatch(opts) {
  const result = await runDispatch(opts);
  if (result.exitCode && result.exitCode !== 0) {
    console.log(JSON.stringify(result));
    process.exit(result.exitCode);
  }
  console.log(JSON.stringify(result));
}

async function cmdStatus(opts) {
  await initSessionDir();
  const sessionId = opts.session_id;
  if (sessionId) {
    try {
      const meta = await readMeta(sessionId);
      meta.running = await isRunning(sessionId);
      console.log(JSON.stringify(meta));
    } catch {
      console.log(JSON.stringify({ error: 'Session not found' }));
      process.exit(1);
    }
  } else {
    const sessions = await listSessions();
    console.log(JSON.stringify({ sessions }));
  }
}

async function cmdResult(opts) {
  const sessionId = opts.session_id;
  const raw = opts.raw === true || opts.raw === 'true';

  if (!sessionId) {
    const repoPath = await findRepoRoot();
    const latest = await readRepoSession(repoPath) || (await getLatestSessionForRepo(repoPath))?.session_id;
    if (!latest) {
      console.log(JSON.stringify({ error: 'No session found' }));
      process.exit(1);
    }
    return cmdResult({ ...opts, session_id: latest });
  }

  const sessDir = path.join(process.env.HOME, '.kimi-plugin-cc', 'sessions', sessionId);
  const outputFile = path.join(sessDir, 'output.jsonl');

  if (raw) {
    try {
      const data = await readFile(outputFile, 'utf-8');
      console.log(data);
    } catch {
      console.log(JSON.stringify({ error: 'No output captured yet' }));
      process.exit(1);
    }
    return;
  }

  try {
    const data = await readFile(outputFile, 'utf-8');
    const lines = data.trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const obj = JSON.parse(lines[i]);
      if (obj.role === 'assistant' && obj.content) {
        console.log(obj.content);
        return;
      }
    }
    console.log('(no assistant message found)');
  } catch {
    console.log(JSON.stringify({ error: 'No output captured yet' }));
    process.exit(1);
  }
}

async function cmdCancel(opts) {
  const sessionId = opts.session_id;
  if (!sessionId) {
    const repoPath = await findRepoRoot();
    const latest = await readRepoSession(repoPath) || (await getLatestSessionForRepo(repoPath))?.session_id;
    if (!latest) {
      console.log(JSON.stringify({ error: 'No session found' }));
      process.exit(1);
    }
    return cmdCancel({ ...opts, session_id: latest });
  }
  const result = await cancelSession(sessionId);
  console.log(JSON.stringify(result));
}

async function cmdDiffCapture(opts) {
  const sessionId = opts.session_id;
  const phase = opts.phase;
  const repoPath = await findRepoRoot();
  await captureDiff(sessionId, phase, repoPath);
}

async function cmdBranchDiff(opts) {
  const base = opts.base || 'main';
  const diff = await getBranchDiff(base);
  console.log(diff);
}

async function cmdWorkingDiff() {
  const diff = await getWorkingDiff();
  console.log(diff);
}

async function cmdLatestSession() {
  const repoPath = await findRepoRoot();
  const id = await readRepoSession(repoPath) || (await getLatestSessionForRepo(repoPath))?.session_id;
  console.log(JSON.stringify({ session_id: id || null }));
}

async function cmdWatch(opts) {
  const sessionId = opts.session_id;
  const verbose = opts.verbose === true || opts.verbose === 'true';
  if (!sessionId) {
    console.log(JSON.stringify({ error: 'Missing --session-id' }));
    process.exit(1);
  }
  await watchSession(sessionId, { verbose });
}

async function cmdReport(opts) {
  const since = opts.since;
  const tag = opts.tag;
  const format = opts.format || 'md';
  const sessions = await listSessions();
  let filtered = sessions;

  if (since) {
    const sinceDate = new Date(since);
    filtered = filtered.filter((s) => new Date(s.started_at) >= sinceDate);
  } else {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    filtered = filtered.filter((s) => new Date(s.started_at) >= dayAgo);
  }

  if (tag) filtered = filtered.filter((s) => s.tag === tag);
  filtered.sort((a, b) => new Date(a.started_at) - new Date(b.started_at));

  if (format === 'json') {
    console.log(JSON.stringify(rollupBatch(filtered)));
  } else if (format === 'table') {
    for (const s of filtered) {
      const dur = s.started_at && s.finished_at
        ? Math.round((new Date(s.finished_at) - new Date(s.started_at)) / 1000) + 's' : '-';
      const tok = s.telemetry ? (s.telemetry.prompt_tokens + s.telemetry.completion_tokens) : '-';
      console.log(`${s.session_id?.slice(0,8)}\t${s.status}\t${dur}\t${s.committed ? 'yes' : 'no'}\t${s.commit_sha?.slice(0,7) || '-'}\t${tok}`);
    }
  } else {
    console.log(renderReport(filtered));
  }
}

async function cmdTelemetry(opts) {
  const sessionId = opts.session_id;
  if (!sessionId) {
    console.log(JSON.stringify({ error: 'Missing --session-id' }));
    process.exit(1);
  }
  const sessionsDir = getSessionsDir();
  const telem = await parseTelemetry(path.join(sessionsDir, sessionId, 'output.jsonl'));
  if (!telem) {
    console.log(JSON.stringify({ error: 'No telemetry found' }));
    process.exit(1);
  }
  console.log(JSON.stringify(telem));
}

async function cmdCheckpoint(opts) {
  const sessionId = opts.session_id;
  const doRestore = opts.restore === true || opts.restore === 'true';
  const doList = opts.list === true || opts.list === 'true';
  const repoPath = await findRepoRoot();

  if (doList) {
    console.log(JSON.stringify(await listCheckpoints(repoPath)));
    return;
  }
  if (doRestore && sessionId) {
    console.log(JSON.stringify(await restoreCheckpoint(sessionId, repoPath)));
    return;
  }
  if (sessionId) {
    const checkpoints = await listCheckpoints(repoPath);
    const cp = checkpoints.find((c) => c.session_id === sessionId);
    if (cp) {
      console.log(JSON.stringify(cp));
    } else {
      console.log(JSON.stringify({ error: 'Checkpoint not found' }));
      process.exit(1);
    }
    return;
  }
  console.log(JSON.stringify({ error: 'Usage: checkpoint --session-id <id> [--restore|--list]' }));
  process.exit(1);
}

async function cmdMonitor(opts) {
  const repoPath = await findRepoRoot();
  const taskPath = opts.task_path;
  const doCheck = opts.check === true || opts.check === 'true';

  if (!taskPath) {
    console.log(JSON.stringify({ error: 'Missing --task-path' }));
    process.exit(1);
  }

  let content;
  try {
    content = await readFile(path.resolve(taskPath), 'utf-8');
  } catch {
    console.log(JSON.stringify({ error: 'Cannot read task file' }));
    process.exit(1);
  }

  const docMatch = content.match(/external_docs:\s*\n((?:\s+-\s+.*\n?)+)/);
  const urls = [];
  if (docMatch) {
    const lines = docMatch[1].split('\n').filter((l) => l.trim().startsWith('-'));
    for (const line of lines) {
      const url = line.replace(/^\s+-\s+/, '').trim();
      if (url) urls.push(url);
    }
  }

  const snapshotDir = path.join(repoPath, '.kimi', 'state', 'monitors');

  if (doCheck) {
    const results = [];
    for (const url of urls) {
      const check = await checkForChanges(url, snapshotDir);
      results.push({ url, changed: check?.changed || false, diff: check?.diff || '' });
    }
    console.log(JSON.stringify(results));
    return;
  }

  // Capture baselines
  const results = [];
  for (const url of urls) {
    const captured = await captureBaseline(url, snapshotDir);
    results.push({ url, captured: !!captured });
  }
  console.log(JSON.stringify(results));
}

async function cmdWarnings(opts) {
  const repoPath = await findRepoRoot();
  const since = opts.since;
  const warnings = await readWarnings(repoPath, since);
  console.log(JSON.stringify(warnings));
}

async function cmdCheckUpdate() {
  const { execFile } = await import('node:child_process');
  const repoPath = await findRepoRoot();
  const pkg = JSON.parse(await readFile(path.join(repoPath, 'package.json'), 'utf-8'));
  const localVersion = pkg.version;

  let latestTag = 'v' + localVersion;
  let behind = false;
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile('git', ['ls-remote', '--tags', '--sort=-v:refname', 'origin'], { timeout: 10000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
    const lines = stdout.trim().split('\n');
    for (const line of lines) {
      const m = line.match(/refs\/tags\/(v[\d.]+)$/);
      if (m) {
        latestTag = m[1];
        break;
      }
    }
    behind = latestTag !== `v${localVersion}`;
  } catch {
    // offline or no git remote — skip
  }

  console.log(JSON.stringify({
    local_version: localVersion,
    latest_tag: latestTag.replace(/^v/, ''),
    behind,
    update_command: 'cd $(git rev-parse --show-toplevel) && git pull && /reload-plugins',
  }));
}

async function cmdBatch(opts, positional) {
  const repoPath = await findRepoRoot();
  const pattern = positional[1];
  if (!pattern) {
    console.log(JSON.stringify({ error: 'Missing glob pattern' }));
    process.exit(1);
  }

  const maxParallel = parseInt(opts.max_parallel || '4', 10);
  const forceDispatch = opts.force_dispatch === true || opts.force_dispatch === 'true';
  const skipPreflight = opts.skip_preflight === true || opts.skip_preflight === 'true';

  const taskPaths = [];
  const baseDir = path.resolve(repoPath, path.dirname(pattern));
  const baseName = path.basename(pattern);
  try {
    const entries = await readdir(baseDir);
    for (const e of entries) {
      if (matchGlob(e, baseName)) taskPaths.push(path.join(baseDir, e));
    }
  } catch (e) {
    await warn('batch', e, 'error');
    console.log(JSON.stringify({ error: 'Cannot read task directory' }));
    process.exit(1);
  }

  if (taskPaths.length === 0) {
    console.log(JSON.stringify({ error: 'No tasks matched', pattern }));
    process.exit(1);
  }

  const { waves } = await buildGraph(taskPaths, maxParallel);
  const dispatched = [];

  for (let w = 0; w < waves.length; w++) {
    const wave = waves[w];
    console.log(JSON.stringify({ wave: w + 1, total: waves.length, tasks: wave.map((t) => t.id) }));

    const waveResults = await Promise.all(
      wave.map((task) =>
        runDispatch({
          ...opts,
          prompt: `Execute the following task:\n\nTask ID: ${task.id}\nTitle: ${task.title}\n\n${task.path}`,
          agent_file: path.join(repoPath, 'plugins', 'kimi', 'agent-files', 'coder.yaml'),
          task_path: task.path,
          touches_paths: task.touches_paths.join(','),
          background: true,
          force_dispatch: forceDispatch,
          skip_preflight: skipPreflight,
        })
      )
    );

    const sessionIds = waveResults.map((r) => r.sessionId).filter(Boolean);
    dispatched.push(...waveResults);

    const stuck = await waitForSessions(sessionIds);
    if (stuck.length > 0) {
      console.log(JSON.stringify({ warning: 'Some sessions did not complete', stuck }));
    }
  }

  const allSessions = await listSessions();
  const relevant = allSessions.filter((s) => dispatched.some((d) => d.sessionId === s.session_id));
  console.log(JSON.stringify(rollupBatch(relevant)));
}

async function cmdNext(opts) {
  const repoPath = await findRepoRoot();
  const tasksDir = path.resolve(opts.tasks_dir || path.join(repoPath, 'tasks'));

  let files;
  try {
    files = await readdir(tasksDir);
  } catch {
    console.log(JSON.stringify({ status: 'no-ready-tasks', tasks_dir: tasksDir }));
    return;
  }

  const tasks = [];
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const t = await parseTaskFile(path.join(tasksDir, f));
    if (t && t.status === 'ready') tasks.push(t);
  }

  tasks.sort((a, b) => priorityValue(a.priority) - priorityValue(b.priority));

  const allTasks = new Map();
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const t = await parseTaskFile(path.join(tasksDir, f));
    if (t) allTasks.set(t.id, t);
  }

  for (const task of tasks) {
    const depsSatisfied = task.depends_on.every((depId) => {
      const dep = allTasks.get(depId);
      return dep && dep.status === 'completed';
    });
    if (depsSatisfied) {
      const result = await runDispatch({
        ...opts,
        prompt: `Execute the following task:\n\nTask ID: ${task.id}\nTitle: ${task.title}\n\n${task.path}`,
        agent_file: path.join(repoPath, 'plugins', 'kimi', 'agent-files', 'coder.yaml'),
        task_path: task.path,
        touches_paths: task.touches_paths.join(','),
      });
      console.log(JSON.stringify(result));
      return;
    }
  }

  console.log(JSON.stringify({ status: 'no-ready-tasks' }));
}

// ------------------------------------------------------------------
// Register all commands
// ------------------------------------------------------------------

register('dispatch', cmdDispatch);
register('status', cmdStatus);
register('result', cmdResult);
register('cancel', cmdCancel);
register('diff-capture', cmdDiffCapture);
register('branch-diff', cmdBranchDiff);
register('working-diff', cmdWorkingDiff);
register('latest-session', cmdLatestSession);
register('watch', cmdWatch);
register('report', cmdReport);
register('telemetry', cmdTelemetry);
register('checkpoint', cmdCheckpoint);
register('warnings', cmdWarnings);
register('batch', cmdBatch);
register('next', cmdNext);
register('monitor', cmdMonitor);
register('check-update', cmdCheckUpdate);
