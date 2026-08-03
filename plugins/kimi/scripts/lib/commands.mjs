import { invokeKimi, watchSession } from './kimi.mjs';
import { captureDiff, getBranchDiff, getWorkingDiff, fetchAndCompare } from './git.mjs';
import { initSessionDir, writeMeta, readMeta, updateMeta, safeUpdateMeta, listSessions, isRunning, getLatestSessionForRepo, parseAge, pruneSessions, metaExists, reconcileDeadSession } from './state.mjs';
import { startBackground, spawnSupervisor, cancelSession, getSessionsDir, listCheckpoints, restoreCheckpoint } from './job-control.mjs';
import { findRepoRoot, readRepoSession, writeRepoSession } from './workspace.mjs';
import { renderReport } from './render.mjs';
import { preflight } from './preflight.mjs';
import { discoverContext } from './context.mjs';
import { parseTelemetry, attachTelemetry } from './telemetry.mjs';
import { buildGraph, rollupBatch, updateTaskStatus } from './orchestrate.mjs';
import { codexReview, buildPlanReviewPrompt, buildDiffReviewPrompt } from './codex-bridge.mjs';
import { commitWork } from './commit.mjs';
import { warn, readWarnings } from './warn.mjs';
import { discoverLibraryDocs } from './docs.mjs';
import { extractResearchTopics, researchTopics, deepResearch, parseExternalDocs, crawlDocs } from './research.mjs';
import { extractApiReferences, validateApiReferences } from './validate-api.mjs';
import { searchPatterns } from './patterns.mjs';
import { captureBaseline, checkForChanges } from './monitor.mjs';
import { enableReviewGate, disableReviewGate, reviewGateStatus } from './review-gate.mjs';
import { validateWithRetry } from './validate-review.mjs';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { matchGlob } from './glob.mjs';
import { assertSupportedCli, detectKimiCli, resolveEffort, MIN_KIMI_CODE_VERSION } from './kimi-cli.mjs';
import { loadRolePrompt, composePrompt, listRoles } from './roles.mjs';

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
  // Fail fast on an unsupported/missing CLI before any state is written.
  await assertSupportedCli();
  await initSessionDir();
  const repoPath = await findRepoRoot();

  const prompt = opts.prompt;
  const role = opts.role || 'coder';
  const maxCostUsd = opts.max_cost !== undefined && opts.max_cost !== false
    ? Number(opts.max_cost)
    : Number(process.env.KIMI_MAX_COST_USD || 0);
  if (Number.isNaN(maxCostUsd) || maxCostUsd < 0) {
    throw new Error(`Invalid --max-cost "${opts.max_cost}" — expected a positive USD number`);
  }
  const background = opts.background === true || opts.background === 'true';
  const model = opts.model || '';
  const sessionId = opts.session_id || crypto.randomUUID();
  const mode = opts.mode || 'crank';
  // Per-mode effort defaults (T-20); explicit --effort always wins.
  const { effort, source: effortSource } = resolveEffort({
    explicit: opts.effort,
    mode,
    off: opts.effort_default === 'off' || process.env.KIMI_EFFORT_DEFAULTS === 'off',
  });
  const autoCommitPolicy = opts.auto_commit || 'on-clean';
  const forceDispatch = opts.force_dispatch === true || opts.force_dispatch === 'true';
  const skipPreflight = opts.skip_preflight === true || opts.skip_preflight === 'true';
  const noContext = opts.no_context === true || opts.no_context === 'true';
  const noDocs = opts.no_docs === true || opts.no_docs === 'true';
  const research = opts.research === true || opts.research === 'true';
  const deepResearchFlag = opts.deep_research === true || opts.deep_research === 'true';
  const patterns = opts.patterns === true || opts.patterns === 'true';
  const planReview = opts.plan_review === true || opts.plan_review === 'true';
  const diffReview = opts.diff_review === true || opts.diff_review === 'true';
  const tag = opts.tag || '';
  const touchesPaths = opts.touches_paths ? opts.touches_paths.split(',').map((s) => s.trim()).filter(Boolean) : [];

  const taskPath = opts.task_path ? path.resolve(opts.task_path) : null;
  // Task-status auto-transition (T-17): the engine consumes status:
  // frontmatter (crank-next picks 'ready', deps wait on 'completed'), so the
  // broker writes it too. A status-write failure never breaks a dispatch.
  const setTask = async (status) => {
    if (!taskPath) return;
    try {
      await updateTaskStatus(taskPath, status);
    } catch (e) {
      await warn('task-status', e, 'info');
    }
  };

  // Write initial meta envelope BEFORE any awaitable that can throw — guarantees
  // safeUpdateMeta in the catch handler always has a file to merge into.
  // baseline_sha is filled in after `git rev-parse` resolves below.
  await writeMeta(sessionId, {
    session_id: sessionId,
    role,
    effort,
    effort_source: effortSource,
    task_path: taskPath || '',
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
    // Handle --resume: read latest session and optionally restore checkpoint.
    // Native resume (Kimi Code 0.x `--session <id>`) continues the actual Kimi
    // session; it replaces the old "Continue from previous session" prompt hack.
    let resumeSessionId = '';
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
              await setTask('failed');
              return { status: 'blocked', reason: 'checkpoint-conflict', session_id: sessionId, resume_target: latest, error: restored.error, exitCode: 5 };
            }
          }
        }
        let kimiSessionId = '';
        try {
          kimiSessionId = (await readMeta(latest)).kimi_session_id || '';
        } catch { /* meta unreadable — treated as missing */ }
        if (!kimiSessionId) {
          const error = `Latest session ${latest} has no recorded Kimi session id (it predates native resume). Start a fresh crank instead of --resume.`;
          await updateMeta(sessionId, { status: 'failed', reason: 'resume-unavailable', finished_at: new Date().toISOString() });
          return { status: 'failed', reason: 'resume-unavailable', session_id: sessionId, error, exitCode: 1 };
        }
        resumeSessionId = kimiSessionId;
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
        await setTask('failed');
        return { status: 'blocked', reason: 'origin-diverged', session_id: sessionId, conflicting_paths: origin.conflicting_paths, exitCode: 2 };
      }
    }

    // Preflight checks
    if (!skipPreflight && opts.task_path) {
      const pf = await preflight(path.resolve(opts.task_path), repoPath);
      if (pf.status === 'already-done') {
        await updateMeta(sessionId, { status: 'skipped', reason: 'already-done', finished_at: new Date().toISOString() });
        await setTask('completed');
        return { status: 'skipped', reason: 'already-done', session_id: sessionId, findings: pf.findings, exitCode: 0 };
      }
      if (pf.status === 'buggy-evals') {
        await updateMeta(sessionId, { status: 'blocked', reason: 'buggy-evals', finished_at: new Date().toISOString() });
        await setTask('failed');
        return { status: 'blocked', reason: 'buggy-evals', session_id: sessionId, findings: pf.findings, exitCode: 3 };
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

  // Library docs injection (Context7 default; Firecrawl/Tavily fallback)
  if (!noDocs && touchesPaths.length > 0) {
    try {
      const docs = await discoverLibraryDocs(touchesPaths, repoPath, { provider: opts.docs_provider });
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

  // Deep research (Tavily async /research task → cited brief)
  if (deepResearchFlag && opts.task_path) {
    try {
      const taskSpec = await readFile(path.resolve(opts.task_path), 'utf-8');
      const topics = extractResearchTopics(taskSpec);
      if (topics.length > 0) {
        const brief = await deepResearch(topics);
        if (brief) finalPrompt = brief + '\n' + finalPrompt;
      }
    } catch (e) {
      await warn('research', e, 'warning');
    }
  }

  // External docs: baseline every URL for monitoring; lines carrying a
  // quoted instruction (https://site "find pages on X") are crawled via
  // Tavily and the collected docs injected into the prompt (capped).
  const externalDocs = [];
  if (opts.task_path) {
    try {
      const taskSpec = await readFile(path.resolve(opts.task_path), 'utf-8');
      const entries = parseExternalDocs(taskSpec);
      const snapshotDir = path.join(repoPath, '.kimi', 'state', 'monitors');
      const crawlCap = Number(process.env.KIMI_CTX_CAP_DOCS_BYTES || 8 * 1024);
      for (const entry of entries) {
        externalDocs.push(entry.url);
        await captureBaseline(entry.url, snapshotDir);
        if (entry.instruction) {
          const crawled = await crawlDocs(entry.url, entry.instruction);
          if (crawled && crawled.content) {
            const body = crawled.content.slice(0, crawlCap);
            finalPrompt =
              `=== CRAWLED DOCS: ${entry.url} — "${entry.instruction}" (read-only reference) ===\n\n` +
              `${body}${crawled.content.length > crawlCap ? '...' : ''}\n` + finalPrompt;
            for (const u of crawled.urls.slice(0, 5)) {
              externalDocs.push(u);
              await captureBaseline(u, snapshotDir);
            }
          }
        }
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
          await setTask('failed');
          return { status: 'paused', reason: 'plan-review', session_id: sessionId, verdict: review.verdict, detail: review.reason, exitCode: 4 };
        }
      } catch (e) {
        await warn('codex', e, 'warning');
      }
    }

    // Role system prompt goes at the head of the composed prompt — this
    // replaces the legacy `--agent-file` mechanism on Kimi Code 0.x.
    const rolePrompt = await loadRolePrompt(role, { workDir: repoPath });
    finalPrompt = composePrompt(rolePrompt, finalPrompt);

    // All gates passed — the task is genuinely underway now.
    await setTask('in-progress');

    if (background) {
      // Hand off to a DETACHED supervisor (re-exec of this broker running
      // `supervise`): it owns the crank for its whole life — watchdogs,
      // close-handler terminal status, auto-commit, telemetry — while this
      // process exits immediately. Persist everything the supervisor needs
      // in meta; it re-reads the envelope from there.
      await updateMeta(sessionId, {
        prompt: finalPrompt,
        resume_session_id: resumeSessionId,
        max_cost_usd: maxCostUsd,
      });
      const result = await spawnSupervisor({ sessionId, repoPath });
      return { ...result, exitCode: 0 };
    }

    // Foreground: merge the assembled prompt into the already-written meta
    await updateMeta(sessionId, { prompt: finalPrompt });

    let result = await invokeKimi({ prompt: finalPrompt, model, sessionId, background: false, cwd: repoPath, resumeSessionId, effort, maxCostUsd });

    // Record the real Kimi session id for native resume/handoff.
    if (result.kimiSessionId) {
      await updateMeta(sessionId, { kimi_session_id: result.kimiSessionId });
    }

    // Timeout / idle-watchdog / max-cost kill is terminal — fail fast with
    // exit code 6, leave work uncommitted so the supervisor can inspect.
    if (result.timedOut) {
      const reason = result.timeoutReason === 'max-cost' ? 'max-cost' : 'timeout';
      await updateMeta(sessionId, {
        status: 'failed', reason, exit_code: result.exitCode,
        committed: false, finished_at: new Date().toISOString(),
        hint: `${reason} — raise KIMI_IDLE_TIMEOUT_MS (idle) or KIMI_DISPATCH_TIMEOUT_MS (wall-clock) to allow longer cranks`,
      });
      await setTask('failed');
      await writeRepoSession(repoPath, sessionId);
      return { ...result, status: 'failed', reason, committed: false, exitCode: 6 };
    }

    // Structured review/challenge output is schema-validated: one correction
    // retry, then a flagged pass-through (a malformed review is still delivered).
    if ((mode === 'review' || mode === 'challenge') && result.exitCode === 0) {
      const outcome = await validateWithRetry({
        mode,
        result,
        invokeRetry: (note, resumeId) =>
          invokeKimi({
            prompt: resumeId ? note : finalPrompt + '\n\n' + note,
            model, sessionId, background: false, cwd: repoPath,
            resumeSessionId: resumeId, effort,
          }),
      });
      if (outcome.retried) {
        if (outcome.validation.ok) {
          if (outcome.result.kimiSessionId) {
            await updateMeta(sessionId, { kimi_session_id: outcome.result.kimiSessionId });
          }
          await updateMeta(sessionId, { validation_retried: true });
          result = outcome.result;
        } else {
          await updateMeta(sessionId, { validation_failed: true, validation_errors: outcome.validation.errors });
          await warn('validate', `Review output failed schema validation after retry: ${outcome.validation.errors.join('; ')}`, 'warning');
        }
      }
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
            await setTask('failed');
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
            await setTask('failed');
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
      // A non-zero exit carries the stderr tail so /kimi:status shows a real
      // diagnostic instead of a bare "failed".
      ...(result.exitCode !== 0 && result.stderrTail ? { error: result.stderrTail } : {}),
    });
    await setTask(result.exitCode === 0 ? 'completed' : 'failed');

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

/**
 * Default batch-wave wait budget: the per-crank hard cap
 * (KIMI_DISPATCH_TIMEOUT_MS, default 30m) plus a 60s margin so a healthy
 * crank is never cancelled at the old flat 10-minute deadline. Read at call
 * time so env overrides apply.
 */
export function batchWaitDefaultMs() {
  return Number(process.env.KIMI_DISPATCH_TIMEOUT_MS || 30 * 60 * 1000) + 60000;
}

async function waitForSessions(sessionIds, timeoutMs = batchWaitDefaultMs()) {
  const start = Date.now();
  const pending = new Set(sessionIds);
  while (pending.size > 0) {
    if (Date.now() - start > timeoutMs) break;
    for (const id of Array.from(pending)) {
      const running = await isRunning(id);
      if (!running) {
        try {
          let meta = await readMeta(id);
          // Supervisor died before its close handler ran → reconcile
          // (interrupted + salvage commit) instead of waiting for the
          // deadline and force-cancelling a session that is already gone.
          if (['running', 'pending'].includes(meta.status)) {
            meta = await reconcileDeadSession(id, meta);
          }
          if (['completed', 'failed', 'cancelled', 'interrupted'].includes(meta.status)) {
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
  if (!opts.prompt) {
    console.log(JSON.stringify({ error: 'Missing required --prompt <text>' }));
    process.exit(1);
  }
  const wantsFresh = opts.fresh === true || opts.fresh === 'true';
  const wantsResume = opts.resume === true || opts.resume === 'true';
  if (wantsFresh && wantsResume) {
    console.log(JSON.stringify({ error: '--fresh and --resume are contradictory — pick one' }));
    process.exit(1);
  }
  const result = await runDispatch(opts);
  if (result.exitCode && result.exitCode !== 0) {
    console.log(JSON.stringify(result));
    process.exit(result.exitCode);
  }
  console.log(JSON.stringify(result));
}

async function cmdStatus(opts, positional) {
  await initSessionDir();
  // Explicit --session-id wins; otherwise the first positional is the id
  // (README: /kimi:status task-abc123).
  const sessionId = opts.session_id || positional?.[1];
  if (sessionId) {
    try {
      let meta = await readMeta(sessionId);
      meta.running = await isRunning(sessionId);
      // A dead supervisor must not leave the session reporting 'running'
      // forever — reconcile to 'interrupted' (and salvage per policy).
      if (!meta.running && ['running', 'pending'].includes(meta.status)) {
        meta = await reconcileDeadSession(sessionId, meta);
        meta.running = false;
      }
      if (meta.kimi_session_id) {
        meta.handoff = `kimi --session ${meta.kimi_session_id}`;
        meta.visualize = `kimi vis ${meta.kimi_session_id}`;
      }
      console.log(JSON.stringify(meta));
    } catch (e) {
      // A present-but-unparseable meta.json is NOT "not found" — say so.
      const corrupted = e && e.code !== 'ENOENT' && (await metaExists(sessionId));
      console.log(JSON.stringify(corrupted
        ? { error: 'Session meta corrupted', session_id: sessionId, detail: e.message }
        : { error: 'Session not found' }));
      process.exit(1);
    }
  } else {
    const sessions = await listSessions();
    console.log(JSON.stringify({ sessions }));
  }
}

async function cmdResult(opts, positional) {
  const sessionId = opts.session_id || positional?.[1];
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

  const sessDir = path.join(getSessionsDir(), sessionId);
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

  let data;
  try {
    data = await readFile(outputFile, 'utf-8');
  } catch {
    console.log(JSON.stringify({ error: 'No output captured yet' }));
    process.exit(1);
  }
  const lines = data.trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue; // one malformed line must not abort the scan
    }
    if (obj.role === 'assistant' && obj.content) {
      console.log(obj.content);
      // Surface the native Kimi resume handoff (stderr keeps stdout pipe-clean).
      try {
        const meta = await readMeta(sessionId);
        if (meta.kimi_session_id) {
          console.error(`[handoff] reopen this run in Kimi: kimi --session ${meta.kimi_session_id}`);
        }
      } catch { /* meta missing — no handoff */ }
      return;
    }
  }
  console.log('(no assistant message found)');
}

async function cmdCancel(opts, positional) {
  const sessionId = opts.session_id || positional?.[1];
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
  try {
    const diff = await getBranchDiff(base);
    console.log(diff);
  } catch (e) {
    // An invalid ref (e.g. --base mian) must be loud, not an empty diff.
    console.log(JSON.stringify({ error: `branch-diff failed for base "${base}": ${e.message}` }));
    process.exit(1);
  }
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

// ------------------------------------------------------------------
// supervise — INTERNAL. Runs the background crank for a session dispatched
// with --background. Spawned detached by spawnSupervisor (job-control.mjs)
// as a re-exec of this broker; never invoked by users, not in the README.
// Its stdout/stderr are file descriptors on the session's output/log files,
// so this handler writes NOTHING to stdout — diagnostics go to stderr
// (which lands in kimi.log).
// ------------------------------------------------------------------

async function cmdSupervise(opts) {
  const sessionId = opts.session_id;
  if (!sessionId) {
    process.stderr.write('supervise: missing --session-id\n');
    process.exit(1);
  }
  try {
    const meta = await readMeta(sessionId);
    await startBackground({
      sessionId,
      role: meta.role || '',
      prompt: meta.prompt,
      model: meta.model || '',
      effort: meta.effort || '',
      mode: meta.mode || 'crank',
      autoCommitPolicy: meta.auto_commit_policy || 'on-clean',
      tag: meta.tag || '',
      taskPath: meta.task_path || '',
      touchesPaths: meta.touches_paths || [],
      baselineSha: meta.baseline_sha || '',
      repoPath: meta.repo_path,
      resumeSessionId: meta.resume_session_id || '',
      maxCostUsd: meta.max_cost_usd ?? 0,
    });
    // Do NOT exit here: the crank's pipes/timers/close handler own the rest
    // of this process's lifetime. It exits naturally when they settle.
  } catch (e) {
    process.stderr.write(`supervise: ${e.message}\n`);
    try {
      await updateMeta(sessionId, {
        status: 'failed',
        error: `supervise failed to start: ${e.message}`,
        finished_at: new Date().toISOString(),
      });
    } catch { /* meta gone — nothing left to do */ }
    process.exit(1);
  }
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
  } else if (!tag) {
    // The 24h default window applies only when NEITHER --since nor --tag was
    // given — a tag lookup must search all history, not just today.
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
      const tok = s.telemetry ? ((s.telemetry.prompt_tokens || 0) + (s.telemetry.completion_tokens || 0)) : '-';
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

  const urls = parseExternalDocs(content).map((e) => e.url);

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
  // The plugin repo root is resolved from THIS script's location, never from
  // the caller's cwd — check-update/update must operate on kimi-plugin-cc,
  // not on whatever repo the user happens to be working in.
  const repoPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const pkg = JSON.parse(await readFile(path.join(repoPath, 'package.json'), 'utf-8'));
  const localVersion = pkg.version;

  let latestTag = 'v' + localVersion;
  let behind = false;
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile('git', ['ls-remote', '--tags', '--sort=-v:refname', 'origin'], { timeout: 10000, cwd: repoPath }, (err, stdout) => {
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
    update_command: `cd ${JSON.stringify(repoPath)} && git pull && /reload-plugins`,
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
          role: 'coder',
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
        role: 'coder',
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
// doctor — verify the Kimi Code 0.x install end to end (no quota spent)
// ------------------------------------------------------------------

async function cmdDoctor() {
  const os = await import('node:os');
  const { execFile } = await import('node:child_process');
  const kimiHome = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');

  const report = { checks: {} };

  // 1. Binary + generation (0.x required)
  const cli = await detectKimiCli({ fresh: true });
  report.checks.binary = {
    ok: cli.ok,
    bin: cli.bin,
    version: cli.version || null,
    generation: cli.generation,
    ...(cli.error ? { error: cli.error } : {}),
    ...(cli.generation === 'legacy'
      ? { hint: 'Migrate: npm i -g @moonshot-ai/kimi-code, or run "/upgrade" inside the legacy CLI' }
      : {}),
    ...(cli.belowFloor
      ? { upgrade_recommended: `Kimi Code >= ${MIN_KIMI_CODE_VERSION} recommended for native resume and real telemetry (detected ${cli.version})` }
      : {}),
  };

  // 2. `kimi doctor` config validation (only with a supported binary)
  if (cli.ok) {
    report.checks.config = await new Promise((resolve) => {
      execFile(cli.bin, ['doctor'], { timeout: 30000 }, (err, stdout, stderr) => {
        resolve({ ok: !err, output: String(stdout + stderr).trim() });
      });
    });
  }

  // 3. Auth state — credentials dir non-empty (no model call, no quota spent)
  const credDir = path.join(kimiHome, 'credentials');
  try {
    const entries = await readdir(credDir);
    report.checks.auth = { ok: entries.length > 0, path: credDir, providers: entries };
    if (entries.length === 0) report.checks.auth.hint = 'Run: kimi login';
  } catch {
    report.checks.auth = { ok: false, path: credDir, hint: 'Run: kimi login' };
  }

  // 4. Configured MCP servers
  try {
    const mcp = JSON.parse(await readFile(path.join(kimiHome, 'mcp.json'), 'utf-8'));
    const names = Object.keys(mcp.mcpServers || {});
    report.checks.mcp = { ok: true, servers: names.length, names };
  } catch {
    report.checks.mcp = { ok: true, servers: 0, names: [] };
  }

  // 5. Plugin role prompts load
  const roles = {};
  for (const role of listRoles()) {
    try {
      await loadRolePrompt(role);
      roles[role] = true;
    } catch {
      roles[role] = false;
    }
  }
  report.checks.roles = { ok: Object.values(roles).every(Boolean), roles };

  report.ok = report.checks.binary.ok && report.checks.auth.ok && report.checks.roles.ok;
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

// ------------------------------------------------------------------
// review-gate — enable/disable the Stop-hook review gate
// ------------------------------------------------------------------

async function cmdReviewGate(opts) {
  if (opts.enable) {
    console.log(JSON.stringify(await enableReviewGate()));
    return;
  }
  if (opts.disable) {
    console.log(JSON.stringify(await disableReviewGate()));
    return;
  }
  console.log(JSON.stringify(await reviewGateStatus()));
}

// ------------------------------------------------------------------
// export-debug — one-command debug bundle for a session
// ------------------------------------------------------------------

async function cmdExportDebug(opts) {
  let sessionId = opts.session_id;
  if (!sessionId) {
    const repoPath = await findRepoRoot();
    sessionId = await readRepoSession(repoPath) || (await getLatestSessionForRepo(repoPath))?.session_id;
    if (!sessionId) {
      console.log(JSON.stringify({ ok: false, error: 'No session found' }));
      process.exit(1);
    }
  }

  let meta = null;
  try {
    meta = await readMeta(sessionId);
  } catch { /* missing meta — degraded path still bundles the session dir */ }

  const out = opts.output || `kimi-debug-${sessionId.slice(0, 8)}-${Date.now()}.zip`;
  const { execFile } = await import('node:child_process');

  // Preferred: native `kimi export` on the real Kimi session (full wire data).
  if (meta?.kimi_session_id) {
    const r = await new Promise((resolve) => {
      execFile('kimi', ['export', meta.kimi_session_id, '-o', out, '-y'], { timeout: 120000 }, (err, stdout, stderr) => {
        resolve({ ok: !err, output: String(stdout + stderr).trim() });
      });
    });
    if (r.ok) {
      console.log(JSON.stringify({ ok: true, bundle: path.resolve(out), via: 'kimi export', kimi_session_id: meta.kimi_session_id }));
      return;
    }
  }

  // Degraded: tar the broker session dir (meta, output.jsonl, logs, diffs).
  const tarOut = out.replace(/\.zip$/, '') + '.tar.gz';
  const r = await new Promise((resolve) => {
    execFile('tar', ['-czf', tarOut, '-C', getSessionsDir(), sessionId], { timeout: 60000 }, (err) => {
      resolve({ ok: !err });
    });
  });
  if (!r.ok) {
    console.log(JSON.stringify({ ok: false, error: 'export failed (no kimi session id and tar fallback failed)' }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, bundle: path.resolve(tarOut), via: 'broker-bundle' }));
}

// ------------------------------------------------------------------
// prune — reclaim old session directories (dry-run unless --yes)
// ------------------------------------------------------------------

async function cmdPrune(opts) {
  const olderThanMs = parseAge(opts.older_than || '30d');
  const execute = opts.yes === true || opts.yes === 'true';
  const report = await pruneSessions({ olderThanMs, execute });
  if (report.dry_run && report.candidates.length > 0) {
    report.hint = 'dry-run only — re-run with --yes to delete';
  }
  console.log(JSON.stringify(report, null, 2));
}

// ------------------------------------------------------------------
// Register all commands
// ------------------------------------------------------------------

register('dispatch', cmdDispatch);
register('supervise', cmdSupervise);
register('doctor', cmdDoctor);
register('prune', cmdPrune);
register('review-gate', cmdReviewGate);
register('export-debug', cmdExportDebug);
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
