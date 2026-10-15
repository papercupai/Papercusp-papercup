import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  EFFORT_CLAMP_TTL_MS,
  chooseSupportedEffort,
  createEffortClampCache,
  parseUnsupportedEffortError,
  readRequestEffort,
  rewriteRequestEffort,
} from './effort-clamp';

/** Verbatim upstream 400 that ended five su-da584eff turns on 2026-10-03 (WI-10005833). */
const REAL_MESSAGE = "This model does not support effort level 'xhigh'. Supported levels: high, low, max, medium.";
const REAL_ENVELOPE = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: REAL_MESSAGE } });

const body = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');

describe('parseUnsupportedEffortError', () => {
  test('reads the real Anthropic error envelope', () => {
    assert.deepEqual(parseUnsupportedEffortError(REAL_ENVELOPE), {
      requested: 'xhigh',
      supported: ['high', 'low', 'max', 'medium'],
    });
  });

  test('reads the bare message text (a CLI-rendered "API Error: 400 …" line)', () => {
    assert.deepEqual(parseUnsupportedEffortError(`API Error: 400 ${REAL_MESSAGE}`), {
      requested: 'xhigh',
      supported: ['high', 'low', 'max', 'medium'],
    });
  });

  test('drops off-ladder and duplicate supported levels', () => {
    const parsed = parseUnsupportedEffortError(
      "does not support effort level 'MAX'. Supported levels: High, turbo, high, low",
    );
    assert.deepEqual(parsed, { requested: 'max', supported: ['high', 'low'] });
  });

  test('returns null when there is nothing safe to clamp to', () => {
    // No supported list (e.g. a peek cut before it) — the clamp has no basis.
    assert.equal(parseUnsupportedEffortError("This model does not support effort level 'xhigh'."), null);
    // Only off-ladder levels.
    assert.equal(parseUnsupportedEffortError("does not support effort level 'xhigh'. Supported levels: turbo"), null);
    // Any other 400.
    assert.equal(
      parseUnsupportedEffortError('{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}'),
      null,
    );
    assert.equal(parseUnsupportedEffortError(''), null);
  });
});

describe('chooseSupportedEffort', () => {
  test('rounds UP to the nearest supported level: xhigh on Opus 5.5 → max', () => {
    assert.equal(chooseSupportedEffort('xhigh', ['high', 'low', 'max', 'medium']), 'max');
  });

  test('falls back to the highest level below when nothing above is supported', () => {
    assert.equal(chooseSupportedEffort('max', ['low', 'medium', 'high']), 'high');
    assert.equal(chooseSupportedEffort('ultra', ['low', 'high', 'max']), 'max');
  });

  test('picks the NEAREST level above, not the highest', () => {
    assert.equal(chooseSupportedEffort('low', ['medium', 'max', 'ultra']), 'medium');
  });

  test('null when there is no substitution to make', () => {
    assert.equal(chooseSupportedEffort('high', ['low', 'high']), null, 'already supported');
    assert.equal(chooseSupportedEffort('turbo', ['low', 'high']), null, 'requested level is off-ladder');
    assert.equal(chooseSupportedEffort('xhigh', ['turbo']), null, 'no on-ladder supported level');
    assert.equal(chooseSupportedEffort('xhigh', []), null);
  });
});

describe('readRequestEffort / rewriteRequestEffort', () => {
  test('reads output_config.effort, trimmed and lower-cased', () => {
    assert.equal(readRequestEffort(body({ output_config: { effort: ' XHigh ' } })), 'xhigh');
    assert.equal(readRequestEffort(body({ output_config: {} })), null);
    assert.equal(readRequestEffort(body({ model: 'claude-opus-5-5' })), null);
    assert.equal(readRequestEffort(Buffer.from('not json')), null);
    assert.equal(readRequestEffort(Buffer.alloc(0)), null);
  });

  test('rewrites only the effort and keeps every other field', () => {
    const original = {
      model: 'claude-opus-5-5',
      max_tokens: 64,
      output_config: { effort: 'xhigh', format: { type: 'text' } },
      messages: [{ role: 'user', content: 'x' }],
      metadata: { user_id: 'u' },
    };
    const rewritten = rewriteRequestEffort(body(original), 'max');
    assert.ok(rewritten);
    assert.deepEqual(JSON.parse(rewritten.toString('utf8')), {
      ...original,
      output_config: { effort: 'max', format: { type: 'text' } },
    });
  });

  test('null when there is no string effort to rewrite', () => {
    assert.equal(rewriteRequestEffort(body({ model: 'm' }), 'max'), null);
    assert.equal(rewriteRequestEffort(body({ output_config: { effort: 3 } }), 'max'), null);
    assert.equal(rewriteRequestEffort(body({ output_config: ['xhigh'] }), 'max'), null);
    assert.equal(rewriteRequestEffort(Buffer.from('{not json'), 'max'), null);
    assert.equal(rewriteRequestEffort(Buffer.alloc(0), 'max'), null);
  });
});

describe('createEffortClampCache', () => {
  test('applies a learned substitution per (model, level) and counts hits', () => {
    const cache = createEffortClampCache({ now: () => 1_000 });
    assert.equal(cache.apply('claude-opus-5-5', 'xhigh'), null);
    cache.learn('claude-opus-5-5', 'xhigh', 'max');
    assert.equal(cache.apply('CLAUDE-OPUS-5-5', 'XHIGH'), 'max', 'model and level match case-insensitively');
    assert.equal(cache.apply('claude-opus-5-5', 'high'), null, 'another level is not affected');
    assert.equal(cache.apply('claude-sonnet-5', 'xhigh'), null, 'another model is not affected');
    assert.deepEqual(cache.entries(), [
      { model: 'claude-opus-5-5', from: 'xhigh', to: 'max', learnedAt: 1_000, applied: 1 },
    ]);
  });

  test('a learned clamp expires, so a model that gains the level is used at it again', () => {
    let now = 0;
    const cache = createEffortClampCache({ now: () => now });
    cache.learn('m', 'xhigh', 'max');
    now = EFFORT_CLAMP_TTL_MS;
    assert.equal(cache.apply('m', 'xhigh'), 'max', 'still live at exactly the TTL');
    now = EFFORT_CLAMP_TTL_MS + 1;
    assert.equal(cache.apply('m', 'xhigh'), null);
    assert.deepEqual(cache.entries(), []);
  });

  test('is bounded: the oldest learned entry is evicted first', () => {
    const cache = createEffortClampCache({ maxEntries: 2, now: () => 0 });
    cache.learn('a', 'xhigh', 'max');
    cache.learn('b', 'xhigh', 'max');
    cache.learn('c', 'xhigh', 'max');
    assert.deepEqual(
      cache.entries().map((entry) => entry.model),
      ['b', 'c'],
    );
  });
});
