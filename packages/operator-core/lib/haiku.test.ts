/**
 * haiku.test.ts — runHaiku, the best-effort single-turn LLM primitive.
 *
 * Contract: returns the trimmed final text; OVERWRITES on each delta/result
 * (never accumulates → no doubled output); returns null on an error event, on a
 * thrown iterator, and on empty output; passes maxTokens through. runAgentChat is
 * mocked as an async generator so no real LLM call happens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runAgentChatMock = vi.fn();
vi.mock('./agent-chat-stream', () => ({
  runAgentChat: (...a: unknown[]) => runAgentChatMock(...a),
}));

import { runHaiku, runHaikuTurn, runHaikuAttempt } from './haiku';

// runHaiku logs failures loudly (by design); suppress the warn so
// vitest-fail-on-console doesn't treat the expected log as a failure.
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  vi.useRealTimers();
});

/** Make runAgentChat yield the given events as an async generator. */
function emits(...events: Array<Record<string, unknown>>) {
  runAgentChatMock.mockImplementation(async function* () {
    for (const ev of events) yield ev;
  });
}

describe('runHaiku', () => {
  it('retains measured liability when a provider emits usage then fails', async () => {
    emits({ type: 'result', finalText: 'uncommitted', costUsd: 0.002, tokensIn: 30, tokensOut: 8 },
      { type: 'error', message: 'stream failed' });
    await expect(runHaikuAttempt('summarize')).resolves.toMatchObject({
      status: 'failed', costUsd: 0.002, tokensIn: 30, tokensOut: 8,
    });
    await expect(runHaikuTurn('summarize')).resolves.toBeNull();
  });

  it('distinguishes unknown usage from measured zero after an iterator failure', async () => {
    runAgentChatMock.mockImplementation(async function* () { throw new Error('offline'); yield {}; });
    const unknown = await runHaikuAttempt('summary');
    expect(unknown).toEqual({ status: 'failed', model: expect.any(String) });
    emits({ type: 'result', finalText: '', costUsd: 0, tokensIn: 0, tokensOut: 0 });
    await expect(runHaikuAttempt('summary')).resolves.toMatchObject({ status: 'failed', costUsd: 0, tokensIn: 0, tokensOut: 0 });
  });

  it('settles caller cancellation with the usage already observed and no coverage text', async () => {
    const controller = new AbortController();
    runAgentChatMock.mockImplementation(async function* () {
      yield { type: 'result', finalText: 'draft', costUsd: 0.003, tokensIn: 40 };
      controller.abort();
      await new Promise(() => {});
    });
    const result = await runHaikuAttempt('summary', { signal: controller.signal });
    expect(result).toMatchObject({ status: 'incomplete', costUsd: 0.003, tokensIn: 40 });
    expect(result).not.toHaveProperty('text');
  });
  it('settles at the caller deadline even when the iterator ignores cancellation', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    runAgentChatMock.mockImplementation(async function* (opts) {
      signal = opts.signal;
      yield { type: 'delta', text: 'unfinished draft' };
      await new Promise(() => {});
    });
    const result = runHaikuTurn('write release notes', { timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline after a completed turn instead of later aborting it', async () => {
    vi.useFakeTimers();
    emits({ type: 'result', finalText: 'reviewable draft' });
    await expect(runHaikuTurn('notes', { timeoutMs: 25 })).resolves.toMatchObject({ text: 'reviewable draft' });
    const signal = runAgentChatMock.mock.lastCall?.[0].signal as AbortSignal;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(25);
    expect(signal.aborted).toBe(false);
  });

  it('returns the trimmed final text from the result event', async () => {
    emits({ type: 'delta', text: 'partial' }, { type: 'result', finalText: '  the answer  ' });
    expect(await runHaiku('summarise this')).toBe('the answer');
  });

  it('overwrites rather than accumulates across delta/result (no doubling)', async () => {
    // anthropic-direct emits the full text in the delta, then the same in result.
    emits({ type: 'delta', text: 'full text' }, { type: 'result', finalText: 'full text' });
    expect(await runHaiku('x')).toBe('full text'); // not "full textfull text"
  });

  it('falls back to the last delta when result carries no finalText', async () => {
    emits({ type: 'delta', text: 'only-delta' }, { type: 'result', finalText: '' });
    expect(await runHaiku('x')).toBe('only-delta');
  });

  it('returns null on an error event', async () => {
    emits({ type: 'delta', text: 'ignored' }, { type: 'error', message: 'boom' });
    expect(await runHaiku('x')).toBeNull();
    expect(warnSpy).toHaveBeenCalled(); // logs loudly on failure
  });

  it('returns null when the iterator throws (best-effort, never surfaces)', async () => {
    runAgentChatMock.mockImplementation(async function* () {
      throw new Error('transport died');

      yield {};
    });
    await expect(runHaiku('x')).resolves.toBeNull();
  });

  it('returns null for empty/whitespace output', async () => {
    emits({ type: 'result', finalText: '   ' });
    expect(await runHaiku('x')).toBeNull();
  });

  it('passes maxTokens through to runAgentChat (default 200)', async () => {
    emits({ type: 'result', finalText: 'ok' });
    await runHaiku('x');
    expect(runAgentChatMock).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 200, backend: 'anthropic-direct' }),
    );
    await runHaiku('x', 50);
    expect(runAgentChatMock).toHaveBeenLastCalledWith(expect.objectContaining({ maxTokens: 50 }));
  });
});
