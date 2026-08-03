import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractJson,
  validateReviewOutput,
  correctionNote,
  validateWithRetry,
} from '../plugins/kimi/scripts/lib/validate-review.mjs';

const VALID_REVIEW = JSON.stringify({
  summary: 'Looks fine overall',
  findings: [
    { severity: 'warning', file: 'src/a.js', line: 42, message: 'edge case', suggestion: 'guard it' },
  ],
});

test('extractJson handles raw, fenced, and prose-embedded JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('here you go:\n```json\n{"a":1}\n```\n'), { a: 1 });
  assert.deepEqual(extractJson('prefix {"a":1} suffix'), { a: 1 });
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson(''), null);
});

test('validateReviewOutput accepts a valid review', () => {
  const v = validateReviewOutput(VALID_REVIEW, 'review');
  assert.equal(v.ok, true);
  assert.deepEqual(v.errors, []);
});

test('validateReviewOutput reports schema violations precisely', () => {
  const v = validateReviewOutput(JSON.stringify({
    findings: [{ severity: 'fatal', message: 'x', file: 'a.js', line: '42' }],
  }), 'review');
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('"summary"')));
  assert.ok(v.errors.some((e) => e.includes('severity')));
  assert.ok(v.errors.some((e) => e.includes('line must be a number')));
});

test('validateReviewOutput enforces the challenge contract (topic, not file/line)', () => {
  const good = validateReviewOutput(JSON.stringify({
    summary: 's',
    findings: [{ severity: 'critical', topic: 'concurrency', message: 'race', alternative: 'lock' }],
  }), 'challenge');
  assert.equal(good.ok, true);

  const bad = validateReviewOutput(JSON.stringify({
    summary: 's',
    findings: [{ severity: 'critical', file: 'a.js', line: 1, message: 'race' }],
  }), 'challenge');
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('topic')));
});

test('validateReviewOutput fails cleanly on non-JSON output', () => {
  const v = validateReviewOutput('this is prose, not a review', 'review');
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /no JSON object/);
});

test('correctionNote lists the errors and demands bare JSON', () => {
  const note = correctionNote(['missing "summary"']);
  assert.match(note, /missing "summary"/);
  assert.match(note, /ONLY the corrected JSON/);
});

test('validateWithRetry passes through a valid first attempt', async () => {
  let retries = 0;
  const r = await validateWithRetry({
    mode: 'review',
    result: { finalMessage: VALID_REVIEW, exitCode: 0 },
    invokeRetry: async () => { retries++; return {}; },
  });
  assert.equal(r.retried, false);
  assert.equal(retries, 0, 'no retry when the first output is valid');
});

test('validateWithRetry resumes the session with only the correction note', async () => {
  const bad = JSON.stringify({ findings: [] });
  let retriedWith = null;
  const r = await validateWithRetry({
    mode: 'review',
    result: { finalMessage: bad, exitCode: 0, kimiSessionId: 'session_1' },
    invokeRetry: async (note, resumeId) => {
      retriedWith = { note, resumeId };
      return { finalMessage: VALID_REVIEW, exitCode: 0, kimiSessionId: 'session_1' };
    },
  });
  assert.equal(r.retried, true);
  assert.equal(r.validation.ok, true);
  assert.equal(retriedWith.resumeId, 'session_1', 'retry must resume the same session');
  assert.ok(!retriedWith.note.includes('"findings": []'), 'note must not resend the whole prompt');
});

test('validateWithRetry returns the original result when the retry also fails', async () => {
  const bad = JSON.stringify({ findings: [{ severity: 'fatal', message: 'x' }] });
  const r = await validateWithRetry({
    mode: 'review',
    result: { finalMessage: bad, exitCode: 0 },
    invokeRetry: async () => ({ finalMessage: 'still prose', exitCode: 0 }),
  });
  assert.equal(r.retried, true);
  assert.equal(r.validation.ok, false);
  assert.equal(r.result.finalMessage, bad, 'original output is delivered, flagged');
});
