/**
 * `scripts/lib/task-exit-class.mjs` decides whether a finished task's non-zero exit GATES
 * the affected-tests run — and, since EI-20107132436867486, whether it is worth retrying.
 *
 * WHY THIS FILE EXISTS (WI-37830): in-process, every one of these branches runs ONLY after a
 * task has already failed, which on a healthy tree is never. So the logic that protects the
 * gate was reachable by no test and verifiable only by reading it — the same argument
 * batch-watchdog.test.ts and the vitest-summary tests make for their own subjects.
 *
 * The assertions below are deliberately two-sided. A guard that only proves "the forgiven
 * case is forgiven" passes just as happily when the helper forgives EVERYTHING, which would
 * silently disarm the gate for the whole repo — so each forgiving case is paired with the
 * neighbouring case that must still fail.
 */
import { describe, expect, it } from 'vitest';

import {
  ADMISSION_DEFERRAL_DELAYS_MS,
  classifyTaskExit,
  formatAdmissionDeferralLine,
  isGatingFailure,
  isTransientAdmissionPersistFailure,
  parseAdmissionDeferralDelays,
  runWithAdmissionDeferral,
} from '../../../../scripts/lib/task-exit-class.mjs';

// The caller's mirror (scripts/affected-tests.mjs), passed in as a parameter so this module
// stays import-free — see the module header for why that coupling is deliberate.
const EXIT_NOT_CHECKED = 2;

describe('classifyTaskExit', () => {
  it('classifies a clean exit as a pass', () => {
    expect(classifyTaskExit({ status: 0, notCheckedExitCode: EXIT_NOT_CHECKED })).toBe('pass');
  });

  it('classifies an ordinary non-zero exit as a failure', () => {
    expect(classifyTaskExit({ status: 1, notCheckedExitCode: EXIT_NOT_CHECKED })).toBe('failed');
  });

  it('forgives "I could not look" for a task whose registration opts in', () => {
    expect(
      classifyTaskExit({
        status: EXIT_NOT_CHECKED,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        notCheckedIsNonGating: true,
      }),
    ).toBe('not-checked');
  });

  // THE OVER-BROADNESS GUARD. If this ever returns 'not-checked', the helper has started
  // forgiving exit 2 for every task in the repo rather than only the ones registered as
  // non-gating — a silently disarmed gate, which is far worse than the red it replaced.
  it('does NOT forgive exit 2 for a task that never opted in', () => {
    expect(
      classifyTaskExit({
        status: EXIT_NOT_CHECKED,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        notCheckedIsNonGating: false,
      }),
    ).toBe('failed');
  });

  // The opt-in forgives ONLY the "could not look" code. A registered guard that genuinely
  // found a violation (exit 1) must still red the run.
  it('forgives only the not-checked code, not every non-zero exit, for an opted-in task', () => {
    expect(
      classifyTaskExit({
        status: 1,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        notCheckedIsNonGating: true,
      }),
    ).toBe('failed');
  });

  it('classifies a quarantined failure as quarantined', () => {
    expect(
      classifyTaskExit({ status: 1, notCheckedExitCode: EXIT_NOT_CHECKED, quarantined: true }),
    ).toBe('quarantined');
  });

  // Precedence: "examined nothing" is decided BEFORE quarantine, so the honest explanation
  // wins over the vaguer bucket. This pins the ordering the reporting branch had.
  it('prefers not-checked over quarantined when both apply', () => {
    expect(
      classifyTaskExit({
        status: EXIT_NOT_CHECKED,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        notCheckedIsNonGating: true,
        quarantined: true,
      }),
    ).toBe('not-checked');
  });

  // The code is a parameter, not a constant baked in here: a caller whose mirror said 3
  // must have 3 forgiven and 2 NOT forgiven.
  it('honours the caller-supplied not-checked code rather than assuming 2', () => {
    expect(
      classifyTaskExit({ status: 3, notCheckedExitCode: 3, notCheckedIsNonGating: true }),
    ).toBe('not-checked');
    expect(
      classifyTaskExit({ status: 2, notCheckedExitCode: 3, notCheckedIsNonGating: true }),
    ).toBe('failed');
  });

  it('classifies explicit fork/resource exhaustion output as undetermined', () => {
    expect(
      classifyTaskExit({
        status: 245,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        stderr: '/usr/bin/bash: fork: retry: Resource temporarily unavailable',
      }),
    ).toBe('undetermined');
  });

  it('classifies a short, zero-output death of a long-estimated task as undetermined', () => {
    expect(
      classifyTaskExit({
        status: null,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        capturedBytes: 0,
        elapsedMs: 3_000,
        durationEstimateMs: 22 * 60 * 1_000,
      }),
    ).toBe('undetermined');
  });

  it('does not over-classify short tasks, captured output, or ordinary failures', () => {
    expect(
      classifyTaskExit({
        status: 1,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        capturedBytes: 0,
        elapsedMs: 3_000,
        durationEstimateMs: 9 * 60 * 1_000,
      }),
    ).toBe('failed');
    expect(
      classifyTaskExit({
        status: 1,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        capturedBytes: 1,
        elapsedMs: 3_000,
        durationEstimateMs: 22 * 60 * 1_000,
      }),
    ).toBe('failed');
    expect(
      classifyTaskExit({
        status: 1,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        stderr: 'test assertion failed: expected 1 to be 2',
      }),
    ).toBe('failed');
  });
});

describe('isGatingFailure — the retry decision (EI-20107132436867486)', () => {
  // The bug: the retry branch tested `status !== 0 && !isQuarantined`, so a task the run was
  // about to forgive four branches later was re-run first, printing a WORKSPACE-shaped
  // "<workspace> FAILED — retrying once" for one guard that had examined nothing. On a
  // git-sync-swept tree — the normal state — that fired on every run.
  it('does not count a non-gating "examined nothing" as a failure worth retrying', () => {
    expect(isGatingFailure('not-checked')).toBe(false);
  });

  it('still retries a real failure', () => {
    expect(isGatingFailure('failed')).toBe(true);
  });

  it('does not retry a pass or a quarantined failure', () => {
    expect(isGatingFailure('pass')).toBe(false);
    expect(isGatingFailure('quarantined')).toBe(false);
  });

  it('does not treat an undetermined task as a retryable gating failure', () => {
    expect(isGatingFailure('undetermined')).toBe(false);
  });

  // End-to-end over the two decisions the runner actually makes, in the exact shape that
  // produced the misleading log line: a registered non-gating guard on a clean checkout.
  it('agrees with the reporting branch on the case that produced the bug', () => {
    const cls = classifyTaskExit({
      status: EXIT_NOT_CHECKED,
      notCheckedExitCode: EXIT_NOT_CHECKED,
      notCheckedIsNonGating: true,
      quarantined: false,
    });
    expect(cls).toBe('not-checked');
    // Reported as "examined NOTHING — not gating", and NOT retried. One honest message
    // instead of a scary one plus a pointless re-run.
    expect(isGatingFailure(cls)).toBe(false);
  });
});

// EI-21878448249294823: the message the governor emitted on drill run 2026-10-28T10-19-19
// for @papercusp/web, @papercusp/desktop and @papercusp/operator-vite while migration 1601
// held AccessExclusive on work_items for ~12 minutes.
const ADMISSION_PERSIST_55P03 =
  'durable admission record could not be persisted after 4 attempts (transient pg contention did not clear): ' +
  'operator write timed out waiting for a row/advisory lock (pg 55P03 lock_timeout) — retry shortly';

describe('admission-persist deferral (EI-21878448249294823)', () => {
  it('recognizes only the admission-time persist refusal as transient', () => {
    expect(isTransientAdmissionPersistFailure(ADMISSION_PERSIST_55P03)).toBe(true);
    expect(isTransientAdmissionPersistFailure('durable admission record could not be persisted')).toBe(true);
    expect(isTransientAdmissionPersistFailure('resource governor refused: over budget')).toBe(false);
    expect(isTransientAdmissionPersistFailure(undefined)).toBe(false);
  });

  it('classifies a never-admitted task as admission-deferred, ahead of every forgiving flag', () => {
    const cls = classifyTaskExit({
      status: 1,
      notCheckedExitCode: EXIT_NOT_CHECKED,
      notCheckedIsNonGating: true,
      quarantined: true,
      capturedBytes: 0,
      elapsedMs: 0,
      admissionErrorMessage: ADMISSION_PERSIST_55P03,
    });
    expect(cls).toBe('admission-deferred');
    // Not retried by the flake-absorption pass: the deferral already ran at admission.
    expect(isGatingFailure(cls)).toBe(false);
  });

  it('leaves an unrelated admission refusal on its existing classification', () => {
    expect(
      classifyTaskExit({
        status: 1,
        notCheckedExitCode: EXIT_NOT_CHECKED,
        admissionErrorMessage: 'resource governor refused: over budget',
      }),
    ).toBe('failed');
  });

  it('re-runs after a wall-clock delay until admission succeeds', async () => {
    const slept: number[] = [];
    const deferred: number[] = [];
    let calls = 0;
    const result = await runWithAdmissionDeferral({
      delaysMs: [30_000, 60_000, 120_000],
      sleep: async (ms) => {
        slept.push(ms);
      },
      onDefer: ({ attempt }) => deferred.push(attempt),
      run: async () => {
        calls++;
        if (calls < 3) throw new Error(ADMISSION_PERSIST_55P03);
        return 'ran';
      },
    });
    expect(result).toBe('ran');
    expect(calls).toBe(3);
    expect(slept).toEqual([30_000, 60_000]);
    expect(deferred).toEqual([1, 2]);
  });

  it('propagates the last refusal, with the deferral count, once the window is exhausted', async () => {
    let calls = 0;
    const failure = await runWithAdmissionDeferral({
      delaysMs: [10, 20],
      sleep: async () => {},
      run: async () => {
        calls++;
        throw new Error(ADMISSION_PERSIST_55P03);
      },
    }).catch((error: Error & { admissionDeferrals?: number }) => error);
    expect(calls).toBe(3);
    expect((failure as Error).message).toBe(ADMISSION_PERSIST_55P03);
    expect((failure as Error & { admissionDeferrals?: number }).admissionDeferrals).toBe(2);
  });

  it('never defers a different failure', async () => {
    let calls = 0;
    const sleep = async () => {
      throw new Error('must not sleep');
    };
    await expect(
      runWithAdmissionDeferral({
        delaysMs: [10],
        sleep,
        run: async () => {
          calls++;
          throw new Error('run-group guard failed');
        },
      }),
    ).rejects.toThrow('run-group guard failed');
    expect(calls).toBe(1);
  });

  it('parses the override: default, off, explicit list, and garbage keeps the default', () => {
    expect(parseAdmissionDeferralDelays(undefined)).toBe(ADMISSION_DEFERRAL_DELAYS_MS);
    expect(parseAdmissionDeferralDelays('off')).toEqual([]);
    expect(parseAdmissionDeferralDelays('0')).toEqual([]);
    expect(parseAdmissionDeferralDelays('1000, 2000')).toEqual([1000, 2000]);
    expect(parseAdmissionDeferralDelays('1000,abc')).toBe(ADMISSION_DEFERRAL_DELAYS_MS);
    // The default window must outlast the measured 12-minute migration lock.
    expect(ADMISSION_DEFERRAL_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeGreaterThan(12 * 60_000);
  });

  it('renders one greppable deferral line', () => {
    expect(
      formatAdmissionDeferralLine({ task: '@papercusp/web :: test', attempt: 1, of: 5, delayMs: 30_000, reason: 'x' }),
    ).toBe('AFFECTED_ADMISSION_DEFERRED task="@papercusp/web :: test" attempt=1/5 delayMs=30000 reason="x"');
  });
});
