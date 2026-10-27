/**
 * WI-10003306 — the per-(account, model) refusal registry that lets the gateway route around a
 * ChatGPT account for ONE model without removing it from the pool or parking it for others.
 */
import { describe, expect, it } from 'vitest';
import {
  CODEX_MODEL_REFUSAL_RE,
  codexModelRefusalDetail,
  createCodexModelRefusalRegistry,
  isCodexModelRefusal,
} from './codex-model-refusals';

const LIVE_BODY = `{"detail":"The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account."}`;

describe('isCodexModelRefusal', () => {
  it('recognises the live backend refusal body (captured 2026-09-26)', () => {
    expect(isCodexModelRefusal(400, LIVE_BODY)).toBe(true);
    expect(CODEX_MODEL_REFUSAL_RE.test(LIVE_BODY)).toBe(true);
  });

  it('ignores auth, rate-limit and server statuses even when the wording matches', () => {
    for (const status of [200, 401, 403, 429, 500, 503]) expect(isCodexModelRefusal(status, LIVE_BODY)).toBe(false);
  });

  it('ignores an ordinary 4xx that is not about the model', () => {
    expect(isCodexModelRefusal(400, '{"detail":"Input must be a list"}')).toBe(false);
  });

  it('extracts the backend detail for logs and stats', () => {
    expect(codexModelRefusalDetail(LIVE_BODY)).toBe(
      "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.",
    );
    expect(codexModelRefusalDetail('plain text refusal')).toBe('plain text refusal');
  });
});

describe('createCodexModelRefusalRegistry', () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it('marks exactly the refused (account, model) pair — other models and accounts stay eligible', () => {
    const c = clock();
    const reg = createCodexModelRefusalRegistry({ ttlMs: 60_000, now: c.now });

    expect(reg.record('aviynw3_codex', 'gpt-6-sol', 'refused')).toBe(true);

    expect(reg.isRefused('aviynw3_codex', 'gpt-6-sol')).toBe(true);
    expect(reg.isRefused('aviynw3_codex', 'GPT-6-SOL ')).toBe(true);
    expect(reg.isRefused('aviynw3_codex', 'gpt-5.6-luna')).toBe(false);
    expect(reg.isRefused('aviynw6_codex', 'gpt-6-sol')).toBe(false);
  });

  it('reports a transition only once per episode, extending the window on repeats', () => {
    const c = clock();
    const reg = createCodexModelRefusalRegistry({ ttlMs: 60_000, now: c.now });

    expect(reg.record('a', 'm', 'first')).toBe(true);
    c.advance(50_000);
    expect(reg.record('a', 'm', 'again')).toBe(false);
    c.advance(50_000); // 100s after the first hit, 50s after the repeat
    expect(reg.isRefused('a', 'm')).toBe(true);
    expect(reg.snapshot()).toEqual([expect.objectContaining({ accountId: 'a', model: 'm', hits: 2, detail: 'again' })]);
  });

  it('recovers automatically: the mark lapses after the TTL, and a 2xx clears it at once', () => {
    const c = clock();
    const reg = createCodexModelRefusalRegistry({ ttlMs: 60_000, now: c.now });

    reg.record('a', 'm', 'x');
    c.advance(60_001);
    expect(reg.isRefused('a', 'm')).toBe(false);
    expect(reg.snapshot()).toEqual([]);

    reg.record('b', 'm', 'x');
    expect(reg.clear('b', 'm')).toBe(true);
    expect(reg.isRefused('b', 'm')).toBe(false);
    expect(reg.clear('b', 'm')).toBe(false);
  });

  // WI-6554700010030462: measured 2026-10-27 — the only healthy account refused gpt-5.6-sol, the
  // mark lapsed with the 30-minute re-check window, /stats dropped the model, and both launch
  // preflights read "unknown" and paid a convert that 429-aborted. Re-check and belief are separate.
  it('keeps BELIEVING a refusal after the selection re-check window lapses', () => {
    const c = clock();
    const reg = createCodexModelRefusalRegistry({ ttlMs: 60_000, reportHorizonMs: 600_000, now: c.now });

    reg.record('a', 'gpt-5.6-sol', 'refused');
    c.advance(60_001);
    // Selection may re-try the account (cheap, in-request failover)…
    expect(reg.isRefused('a', 'gpt-5.6-sol')).toBe(false);
    expect(reg.snapshot()).toEqual([]);
    // …but the launch preflights are still told it refuses.
    expect(reg.isBelievedRefused('a', 'gpt-5.6-sol')).toBe(true);
    expect(reg.believedSnapshot()).toEqual([expect.objectContaining({ accountId: 'a', model: 'gpt-5.6-sol', hits: 1 })]);

    // The belief ends at the report horizon when nothing re-confirms it.
    c.advance(600_000 - 60_001);
    expect(reg.isBelievedRefused('a', 'gpt-5.6-sol')).toBe(false);
    expect(reg.believedSnapshot()).toEqual([]);
  });

  it('re-arms both horizons when a lapsed re-check is refused again, and logs that as a new exclusion', () => {
    const c = clock();
    const reg = createCodexModelRefusalRegistry({ ttlMs: 60_000, reportHorizonMs: 600_000, now: c.now });

    reg.record('a', 'm', 'first');
    c.advance(30_000);
    expect(reg.record('a', 'm', 'inside the window')).toBe(false);
    c.advance(100_000); // re-check window lapsed, belief still held
    expect(reg.record('a', 'm', 'refused on re-check')).toBe(true);
    expect(reg.isRefused('a', 'm')).toBe(true);
    c.advance(599_999); // the belief horizon restarted at the re-confirmation
    expect(reg.isBelievedRefused('a', 'm')).toBe(true);
    expect(reg.believedSnapshot()).toEqual([
      expect.objectContaining({ since: 1_000_000, hits: 3, detail: 'refused on re-check' }),
    ]);
  });

  it('a 2xx clears the belief too, and the report horizon is never shorter than the re-check TTL', () => {
    const c = clock();
    const reg = createCodexModelRefusalRegistry({ ttlMs: 60_000, reportHorizonMs: 1_000, now: c.now });

    reg.record('a', 'm', 'x');
    c.advance(30_000);
    expect(reg.isBelievedRefused('a', 'm')).toBe(true);
    expect(reg.clear('a', 'm')).toBe(true);
    expect(reg.isBelievedRefused('a', 'm')).toBe(false);
    expect(reg.believedSnapshot()).toEqual([]);
  });

  it('stays bounded under a flood of distinct pairs', () => {
    const reg = createCodexModelRefusalRegistry({ ttlMs: 60_000, maxEntries: 3 });
    for (let i = 0; i < 10; i++) reg.record(`acct-${i}`, 'm', 'x');
    expect(reg.snapshot()).toHaveLength(3);
  });
});
