/**
 * live-integration.ts — pure-logic coverage (EI-52). No live host involved:
 * these pin isLiveTransient's classification and liveTest/probeLive's control
 * flow against synthetic errors/timers.
 */
import { describe, expect, it, vi } from 'vitest';
import { isLiveTransient, liveTest, probeLive, retryRejectedLiveRead } from './live-integration';

describe('isLiveTransient', () => {
  it('classifies AbortError / TimeoutError as transient', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(isLiveTransient(abort)).toBe(true);

    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    expect(isLiveTransient(timeout)).toBe(true);
  });

  it('classifies connection-refused/reset/hangup messages as transient', () => {
    expect(isLiveTransient(new Error('connect ECONNREFUSED 127.0.0.1:3070'))).toBe(true);
    expect(isLiveTransient(new Error('read ECONNRESET'))).toBe(true);
    expect(isLiveTransient(new Error('fetch failed'))).toBe(true);
    expect(isLiveTransient(new Error('socket hang up'))).toBe(true);
  });

  it('does NOT classify a real assertion failure as transient', () => {
    expect(isLiveTransient(new Error('expected true to be false'))).toBe(false);
  });

  it('does NOT classify a non-Error throw as transient', () => {
    expect(isLiveTransient('plain string throw')).toBe(false);
    expect(isLiveTransient(undefined)).toBe(false);
  });
});

describe('liveTest', () => {
  it('runs the body and never calls skip on success', async () => {
    const skip = vi.fn();
    const wrapped = liveTest(async () => {
      /* passes */
    });
    await wrapped({ skip: skip as never });
    expect(skip).not.toHaveBeenCalled();
  });

  it('calls ctx.skip() (and swallows the error) on a live-transient failure', async () => {
    const skip = vi.fn();
    const timeoutErr = new Error('timed out');
    timeoutErr.name = 'TimeoutError';
    const wrapped = liveTest(async () => {
      throw timeoutErr;
    });
    await expect(wrapped({ skip: skip as never })).resolves.toBeUndefined();
    expect(skip).toHaveBeenCalledTimes(1);
    expect(skip.mock.calls[0][0]).toMatch(/live host degraded mid-test/);
  });

  it('re-throws a non-transient failure (a real bug) instead of skipping', async () => {
    const skip = vi.fn();
    const wrapped = liveTest(async () => {
      throw new Error('expected 1 to be 2');
    });
    await expect(wrapped({ skip: skip as never })).rejects.toThrow('expected 1 to be 2');
    expect(skip).not.toHaveBeenCalled();
  });
});

describe('probeLive', () => {
  it('returns true when check() resolves true within the bound', async () => {
    const ok = await probeLive(async () => true, 50);
    expect(ok).toBe(true);
  });

  it('returns false when check() resolves false', async () => {
    const ok = await probeLive(async () => false, 50);
    expect(ok).toBe(false);
  });

  it('returns false when check() throws', async () => {
    const ok = await probeLive(async () => {
      throw new Error('ECONNREFUSED');
    }, 50);
    expect(ok).toBe(false);
  });

  it('returns false when check() hangs past the timeout (does not hang the caller)', async () => {
    const ok = await probeLive(
      () => new Promise<boolean>(() => {}), // never resolves
      30,
    );
    expect(ok).toBe(false);
  });
});

describe('retryRejectedLiveRead', () => {
  const refused = () => Object.assign(new Error('CLI refused before dispatch'), {
    code: 1,
    stderr: 'MCP_ERROR: ' + JSON.stringify({ code: -32000,
      data: { retryable: true, reason: 'loop_pressure_critical' } }),
  });

  it('preserves the measured result after explicit pre-dispatch refusals', async () => {
    let attempts = 0; const waits: number[] = [];
    expect(await retryRejectedLiveRead(async () => {
      if (++attempts < 3) throw refused();
      return { digest: 'recorded', pages: 163 };
    }, async ms => { waits.push(ms); })).toEqual({ digest: 'recorded', pages: 163 });
    expect(attempts).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });

  it('bounds persistent refusals and propagates the final failure', async () => {
    let attempts = 0; const waits: number[] = [];
    await expect(retryRejectedLiveRead(async () => {
      attempts++; throw refused();
    }, async ms => { waits.push(ms); })).rejects.toThrow('CLI refused before dispatch');
    expect(attempts).toBe(6);
    expect(waits).toEqual([1000, 2000, 4000, 8000, 10_000]);
  });

  it('never retries semantic failures, unknown outcomes, or unproven refusal text', async () => {
    const failures = [new Error('expected report digest to match'), new Error('ECONNRESET'),
      new Error('loop_pressure_critical'), Object.assign(refused(), { code: 5 }),
      Object.assign(refused(), { stderr: 'MCP_ERROR: unreadable' }),
      Object.assign(refused(), { stderr: 'MCP_ERROR: ' + JSON.stringify({ code: -32000,
        data: { retryable: false, reason: 'loop_pressure_critical' } }) })];
    for (const failure of failures) {
      let attempts = 0;
      const wait = vi.fn(async () => {});
      await expect(retryRejectedLiveRead(async () => {
        attempts++; throw failure;
      }, wait)).rejects.toBe(failure);
      expect(attempts).toBe(1);
      expect(wait).not.toHaveBeenCalled();
    }
  });
});
