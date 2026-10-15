/**
 * `runWithRatePause` — the unattended pause+resume wrapper. A near rate-limit reset is
 * waited out and retried; a far-off reset (past maxPauseMs) or a non-rate error is
 * rethrown for the caller to record + skip. Pure: clock + sleep injected (fake clock).
 */
import { describe, it, expect, vi } from 'vitest';
import { runWithRatePause, type RatePauseDeps } from './rate-pause';
import { LlmCallError } from '@papercusp/testing-shell/llm';

function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  const deps: RatePauseDeps = {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
  };
  return { deps, slept, advance: (ms: number) => (t += ms) };
}

const rateErr = (retryAfterMs?: number, resetAt?: number) =>
  Object.assign(new LlmCallError({ class: 'rate_limited', message: 'slow down', retryAfterMs, resetAt }), { costUsd: 0 });

describe('runWithRatePause', () => {
  it.each([
    ['absent', {}],
    ['positive', { costUsd: 0.23 }],
    ['NaN', { costUsd: NaN }],
    ['infinite', { costUsd: Infinity }],
    ['negative', { costUsd: -1 }],
    ['string zero', { costUsd: '0' }],
    ['incomplete zero', { costUsd: 0, costUsdMeasurementMissing: true }],
    ['incomplete subtotal', { costUsd: 0.23, costUsdMeasurementMissing: true }],
    ['unreported frames', { costUsd: 0, unreportedFrames: 1 }],
    ['invalid completeness', { costUsd: 0, costUsdMeasurementMissing: 'false' }],
    ['invalid frame count', { costUsd: 0, unreportedFrames: NaN }],
  ])('preserves %s usage without replacing it with a later rate retry', async (_label, usage) => {
    const { deps, slept } = fakeClock();
    const failure = Object.assign(new LlmCallError({ class: 'rate_limited', message: 'slow down', retryAfterMs: 1 }), usage);
    const call = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue('later success');
    const onPause = vi.fn();
    const onReset = vi.fn();
    await expect(runWithRatePause(call, { ...deps, onPause, onReset })).rejects.toBe(failure);
    expect(call).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
    expect(onPause).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });

  it('returns the fn result on success with no pause', async () => {
    const { deps, slept } = fakeClock();
    const out = await runWithRatePause(async () => 'ok', deps);
    expect(out).toBe('ok');
    expect(slept).toEqual([]);
  });

  it('waits out a near reset (retryAfterMs) then retries to success', async () => {
    const { deps, slept } = fakeClock();
    let n = 0;
    const out = await runWithRatePause(async () => {
      if (n++ === 0) throw rateErr(5_000);
      return 'recovered';
    }, deps);
    expect(out).toBe('recovered');
    expect(slept).toEqual([5_000]);
  });

  it('rethrows after exhausting retries', async () => {
    const { deps } = fakeClock();
    await expect(
      runWithRatePause(async () => {
        throw rateErr(1_000);
      }, { ...deps, maxRetries: 2 }),
    ).rejects.toBeInstanceOf(LlmCallError);
  });

  it('rethrows immediately when the reset is farther off than maxPauseMs', async () => {
    const { deps, slept } = fakeClock();
    await expect(
      runWithRatePause(async () => {
        throw rateErr(undefined, 10_000_000); // resetAt far in the future
      }, { ...deps, maxPauseMs: 1_000 }),
    ).rejects.toBeInstanceOf(LlmCallError);
    expect(slept).toEqual([]); // never paused
  });

  it('rethrows a non-rate error immediately without retrying', async () => {
    const { deps, slept } = fakeClock();
    let calls = 0;
    await expect(
      runWithRatePause(async () => {
        calls++;
        throw new Error('permanent boom');
      }, deps),
    ).rejects.toThrow('permanent boom');
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  it('fires onPause/onReset around the wait', async () => {
    const { deps } = fakeClock();
    const events: string[] = [];
    let n = 0;
    await runWithRatePause(async () => {
      if (n++ === 0) throw rateErr(2_000);
      return 1;
    }, {
      ...deps,
      onPause: (i) => events.push(`pause:${i.waitMs}`),
      onReset: (i) => events.push(`reset:${i.waitedMs}`),
    });
    expect(events).toEqual(['pause:2000', 'reset:2000']);
  });
});
