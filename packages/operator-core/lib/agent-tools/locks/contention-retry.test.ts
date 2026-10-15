/**
 * contention-retry — unit coverage for the PURE retry-with-backoff that rides out
 * transient PG lock contention (55P03 lock_timeout / 57014 statement_timeout).
 *
 * Correctness matters both ways: misclassifying a TRANSIENT timeout as fatal stalls
 * git-sync / fail-opens file-locking (EI-1720); misclassifying a REAL error as
 * contention masks a bug / a DB-down. Sleep + backoffs are injected — no real timers.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  isWorkspaceContended,
  acquireWithContentionRetry,
  LOCK_CONTENTION_BACKOFFS_MS,
} from './contention-retry';

describe('isWorkspaceContended', () => {
  it('classifies the transient PG contention SQLSTATEs + the named error as retryable', () => {
    expect(isWorkspaceContended({ name: 'WorkspaceContendedError' })).toBe(true);
    expect(isWorkspaceContended({ pgCode: '57014' })).toBe(true); // statement_timeout
    expect(isWorkspaceContended({ pgCode: '55P03' })).toBe(true); // lock_timeout
    expect(isWorkspaceContended({ code: '57014' })).toBe(true); // raw pg error.code
    expect(isWorkspaceContended({ code: '55P03' })).toBe(true);
  });

  // EI-22803020855465174: the acceptance-grading sweep's bounded scorecard read failed with a
  // pool-ACQUISITION deadline (DbCallDeadlineError, no SQLSTATE) and was rethrown on attempt 0.
  it('classifies a pool-measured retryable DbCallDeadlineError as transient contention', () => {
    expect(
      isWorkspaceContended({
        name: 'DbCallDeadlineError',
        label: 'boundedPgReadTxn:acquire(admin)',
        pool: 'org-admin',
        retryable: true,
      }),
    ).toBe(true);
  });

  it('keeps an UNMEASURED / dead-endpoint DbCallDeadlineError fail-closed (not retried)', () => {
    // retryable:false = no recent acquisition measured — may be a dead endpoint (WI-7097).
    expect(
      isWorkspaceContended({ name: 'DbCallDeadlineError', label: 'boundedPgReadTxn:acquire(admin)', retryable: false }),
    ).toBe(false);
    // A missing / non-boolean flag is never promoted to retryable.
    expect(isWorkspaceContended({ name: 'DbCallDeadlineError', label: 'x' })).toBe(false);
    expect(isWorkspaceContended({ name: 'DbCallDeadlineError', retryable: 'true' })).toBe(false);
    // The flag alone, without the deadline error's name, is not contention either.
    expect(isWorkspaceContended({ name: 'Error', retryable: true })).toBe(false);
  });

  it('does NOT classify a real error / non-object as contention (it must surface immediately)', () => {
    expect(isWorkspaceContended({ name: 'Error', code: '23505' })).toBe(false); // unique violation
    expect(isWorkspaceContended({ pgCode: '00000' })).toBe(false);
    expect(isWorkspaceContended(new Error('boom'))).toBe(false);
    expect(isWorkspaceContended(null)).toBe(false);
    expect(isWorkspaceContended(undefined)).toBe(false);
    expect(isWorkspaceContended('57014')).toBe(false); // a string, not an error object
  });
});

describe('acquireWithContentionRetry', () => {
  const contended = () => ({ name: 'WorkspaceContendedError' });

  it('returns the result on first success without sleeping', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const run = vi.fn(async () => 'ok');
    expect(await acquireWithContentionRetry(run, { sleep })).toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('propagates a NON-contention error immediately (no retry, no sleep)', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const real = Object.assign(new Error('dup'), { code: '23505' });
    const run = vi.fn(async () => {
      throw real;
    });
    await expect(acquireWithContentionRetry(run, { sleep })).rejects.toBe(real);
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a transient contention then succeeds, sleeping the configured backoff', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    let calls = 0;
    const run = vi.fn(async () => {
      calls++;
      if (calls < 3) throw contended();
      return 'recovered';
    });
    expect(await acquireWithContentionRetry(run, { sleep, backoffsMs: [10, 20, 30] })).toBe('recovered');
    expect(run).toHaveBeenCalledTimes(3); // failed twice, succeeded on the 3rd
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10, 20]); // backoff[0], backoff[1]
  });

  it('exhausts the backoffs then throws the LAST contention error', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const errs = [1, 2, 3, 4].map((n) => ({ name: 'WorkspaceContendedError', n }));
    let i = 0;
    const run = vi.fn(async () => {
      throw errs[i++];
    });
    await expect(acquireWithContentionRetry(run, { sleep, backoffsMs: [1, 2, 3] })).rejects.toMatchObject({ n: 4 });
    // backoffs.length=3 retries → run called 4 times (initial + 3), sleep called 3 times.
    expect(run).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  });

  it('defaults to LOCK_CONTENTION_BACKOFFS_MS ([500,1500,4000], ~6s over 3 retries)', () => {
    expect([...LOCK_CONTENTION_BACKOFFS_MS]).toEqual([500, 1500, 4000]);
    expect(LOCK_CONTENTION_BACKOFFS_MS.reduce((a, b) => a + b, 0)).toBe(6000);
  });

  it('honours a narrowed isRetryable predicate: excluded contention codes propagate at once (WI-10004951)', async () => {
    const sleep = vi.fn(async () => {});
    const only55P03 = (e: unknown) => (e as { code?: string }).code === '55P03';

    // 57014 IS contention by default, but a caller with a deliberately long
    // statement_timeout must not retry it.
    const timedOut = vi.fn(async () => {
      throw { code: '57014' };
    });
    await expect(
      acquireWithContentionRetry(timedOut, { sleep, backoffsMs: [1, 2], isRetryable: only55P03 }),
    ).rejects.toEqual({ code: '57014' });
    expect(timedOut).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();

    let calls = 0;
    const refusedOnce = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw { code: '55P03' };
      return 'ok';
    });
    await expect(
      acquireWithContentionRetry(refusedOnce, { sleep, backoffsMs: [1, 2], isRetryable: only55P03 }),
    ).resolves.toBe('ok');
    expect(refusedOnce).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([1]);
  });
});
