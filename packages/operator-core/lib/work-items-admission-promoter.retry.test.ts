import { describe, expect, it, vi } from 'vitest';
import { LlmCallError } from '@papercusp/testing-shell/llm';
import { classifyHttpError } from './agent-chat-stream';
import { callPromoterLlmWithTransientRetry } from './work-items-admission-promoter';

const transientFetchFailure = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });

describe('admission promoter LLM transport retry', () => {
  it('retries bounded transient fetch failures across a gateway restart window', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const call = vi.fn()
      .mockRejectedValueOnce(transientFetchFailure())
      .mockRejectedValueOnce(transientFetchFailure())
      .mockResolvedValueOnce('judgement');

    await expect(callPromoterLlmWithTransientRetry(call, sleep)).resolves.toBe('judgement');
    expect(call).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 9_000]);
  });

  it('does not retry semantic/model errors', async () => {
    const error = new Error('model returned invalid JSON');
    const call = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(async (_ms: number) => undefined);

    await expect(callPromoterLlmWithTransientRetry(call, sleep)).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a gateway 502 terminated response from its structured classifier result', async () => {
    const error = new LlmCallError(classifyHttpError({
      status: 502,
      message: 'inference-gateway: codex OAuth upstream failed: terminated',
    }, 'openai'));
    expect(error.turn).toMatchObject({ class: 'overloaded', retryable: true });

    const call = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce('judgement');
    const sleep = vi.fn(async (_ms: number) => undefined);

    await expect(callPromoterLlmWithTransientRetry(call, sleep)).resolves.toBe('judgement');
    expect(call).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000]);
  });

  it('lets an explicit non-retryable LlmCallError verdict override network-like message text', async () => {
    const error = new LlmCallError({
      class: 'auth',
      message: 'authentication failed after fetch ECONNRESET',
      retryable: false,
    });
    const call = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(async (_ms: number) => undefined);

    await expect(callPromoterLlmWithTransientRetry(call, sleep)).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('propagates the last transient error after its fixed retry budget', async () => {
    const first = transientFetchFailure();
    const second = transientFetchFailure();
    const final = transientFetchFailure();
    const call = vi.fn()
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(second)
      .mockRejectedValueOnce(final);
    const sleep = vi.fn(async (_ms: number) => undefined);

    await expect(callPromoterLlmWithTransientRetry(call, sleep)).rejects.toBe(final);
    expect(call).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 9_000]);
  });
});
