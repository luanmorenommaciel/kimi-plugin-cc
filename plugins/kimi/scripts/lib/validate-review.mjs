/**
 * Enforcement of the review/challenge output contracts
 * (schemas/review-output.schema.json + the challenge prompt contract).
 * Hand-rolled, zero dependencies.
 */

const SEVERITIES = ['info', 'warning', 'critical'];

/**
 * Extract the first JSON object from an assistant message (raw, fenced, or
 * embedded in prose). Returns null when nothing parseable exists.
 */
export function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch { /* not raw JSON */ }
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch { /* fall through */ }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch { /* give up */ }
  }
  return null;
}

/**
 * Validate a review/challenge JSON payload against its contract.
 *
 * @param {string} text - the final assistant message
 * @param {string} [mode='review'] - 'review' | 'challenge'
 * @returns {{ok: boolean, errors: string[], json: object|null}}
 */
export function validateReviewOutput(text, mode = 'review') {
  const errors = [];
  const json = extractJson(text);
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, errors: ['no JSON object found in output'], json: null };
  }

  if (typeof json.summary !== 'string' || !json.summary.trim()) {
    errors.push('missing required "summary" string');
  }
  if (!Array.isArray(json.findings)) {
    errors.push('missing required "findings" array');
  } else {
    json.findings.forEach((f, i) => {
      if (!f || typeof f !== 'object') {
        errors.push(`findings[${i}] must be an object`);
        return;
      }
      if (!SEVERITIES.includes(f.severity)) {
        errors.push(`findings[${i}].severity must be one of ${SEVERITIES.join('|')}`);
      }
      if (typeof f.message !== 'string' || !f.message) {
        errors.push(`findings[${i}].message is required`);
      }
      if (mode === 'challenge') {
        if (typeof f.topic !== 'string' || !f.topic) {
          errors.push(`findings[${i}].topic is required (challenge contract)`);
        }
      } else {
        if (typeof f.file !== 'string' || !f.file) {
          errors.push(`findings[${i}].file is required`);
        }
        if (typeof f.line !== 'number') {
          errors.push(`findings[${i}].line must be a number`);
        }
      }
    });
  }

  return { ok: errors.length === 0, errors, json };
}

/** The correction note appended when validation fails (sent as one retry). */
export function correctionNote(errors) {
  return [
    'Your previous output failed schema validation:',
    ...errors.map((e) => `- ${e}`),
    'Return ONLY the corrected JSON object, with no prose around it.',
  ].join('\n');
}

/**
 * Run the validate-then-retry-once flow for a completed dispatch result.
 * `invokeRetry(prompt)` performs the retry invocation and returns a result
 * shaped like invokeKimi's.
 *
 * @returns {Promise<{result: object, retried: boolean, validation: {ok: boolean, errors: string[]}}>}
 */
export async function validateWithRetry({ mode, result, invokeRetry }) {
  const first = validateReviewOutput(result.finalMessage, mode);
  if (first.ok) {
    return { result, retried: false, validation: first };
  }
  const note = correctionNote(first.errors);
  // Resume the same Kimi session when we can — the correction then has full
  // context; otherwise resend the whole prompt with the note appended.
  const retry = await invokeRetry(note, result.kimiSessionId || '');
  const second = validateReviewOutput(retry.finalMessage, mode);
  if (second.ok) {
    return { result: retry, retried: true, validation: second };
  }
  return { result, retried: true, validation: second };
}
