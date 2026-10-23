import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withBoundedTimeout } from './bounded-timeout';
import * as recorder from './degradation/fallback-observations';
import { runWithWorkspace } from './workspace-als';

describe('withBoundedTimeout (WI-3818)', () => {
  beforeEach(() => {
    vi.spyOn(recorder, 'observeFallback').mockReturnValue(true);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('resolves with the real value when the work finishes before the deadline', async () => {
    const p = withBoundedTimeout(Promise.resolve('real-value'), {
      fallback: 'fallback-value',
      timeoutMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await p;
    expect(result).toEqual(
      expect.objectContaining({ value: 'real-value', degraded: false }),
    );
    expect(result.reason).toBeUndefined();
  });

  it('records bounded-operation observations in the active workspace', async () => {
    const result = await runWithWorkspace('workspace-from-context', () => withBoundedTimeout(Promise.resolve('real-value'), {
      fallback: 'fallback-value',
      timeoutMs: 5000,
      label: 'workspace-scoped-read',
    }));
    expect(result.degraded).toBe(false);
    expect(recorder.observeFallback).toHaveBeenCalledWith(
      'bounded-operation',
      { eligible: 1, applied: 1, reason: 'applied', scope: 'workspace-scoped-read' },
      { workspaceId: 'workspace-from-context' },
    );
  });

  it('degrades to the fallback with reason "timeout" when the work never settles in time', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const neverSettles = new Promise<string>(() => {});
    const correlationId = 'b497d96b-f582-49b0-9397-94610fd9b04e';
    const resultPromise = withBoundedTimeout(neverSettles, {
      fallback: 'fallback-value',
      timeoutMs: 5000,
      label: 'orient:coord:inbox',
      correlationId,
    });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;
    expect(result.value).toBe('fallback-value');
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('timeout');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(recorder.observeFallback).toHaveBeenCalledWith(
      'bounded-operation',
      { eligible: 1, applied: 0, reason: 'timeout', scope: 'orient:coord:inbox' },
      expect.objectContaining({ correlationId }),
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('can keep an expected optional fallback quiet while retaining its degradation result', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resultPromise = withBoundedTimeout(new Promise<string>(() => {}), {
      fallback: 'fallback-value',
      timeoutMs: 5000,
      label: 'optional-read',
      warn: false,
    });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;
    expect(result).toMatchObject({ value: 'fallback-value', degraded: true, reason: 'timeout' });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('degrades to the fallback with reason "error" when the work rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = new Error('boom');
    const p = withBoundedTimeout(Promise.reject(error), {
      fallback: 'fallback-value',
      timeoutMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await p;
    expect(result.value).toBe('fallback-value');
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('error');
    expect(result.errorMessage).toBe('boom');
    expect(result.error).toBe(error);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('accepts a thunk and never lets a late resolution become an unhandled rejection', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let resolveLate: ((v: string) => void) | undefined;
    const late = new Promise<string>((resolve) => {
      resolveLate = resolve;
    });
    const resultPromise = withBoundedTimeout(() => late, {
      fallback: 'fallback-value',
      timeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('timeout');
    // Resolving after the deadline must not throw / reject anywhere.
    resolveLate?.('too-late');
    await vi.advanceTimersByTimeAsync(0);
    warnSpy.mockRestore();
  });

  it('supports a rejecting thunk resolved late without an unhandled rejection', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let rejectLate: ((e: Error) => void) | undefined;
    const late = new Promise<string>((_resolve, reject) => {
      rejectLate = reject;
    });
    const resultPromise = withBoundedTimeout(() => late, {
      fallback: 'fallback-value',
      timeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await resultPromise;
    rejectLate?.(new Error('too-late-error'));
    await vi.advanceTimersByTimeAsync(0);
    warnSpy.mockRestore();
  });
});
