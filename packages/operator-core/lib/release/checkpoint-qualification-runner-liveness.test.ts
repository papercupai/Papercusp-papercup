import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  beginQualificationTransaction,
  checkpointPidIdentity,
  configureRunnerLivenessProber,
  probeRunnerLiveness,
  QUALIFICATION_LAUNCH_GRACE_MS,
  QUALIFICATION_OWNER_ABANDONED_MS,
  reserveQualificationRunner,
  type CheckpointQualificationTransaction,
} from './checkpoint-qualification-transaction';

/**
 * A qualification lease is evidence of INTENT, never of life.
 *
 * Measured 2026-08-30 (EI-21860862169665913 / WI-871887): a manual green-checkpoint run died at
 * 07:29:08Z without settling. Its 3h lease stayed "valid" until 10:05Z, so every scheduled fire in
 * that window returned `conflict` and was skipped. The gate reported `writer-starved` and read as
 * red while in fact rendering NO verdict at all — a state no amount of fixing tests can move.
 *
 * The same incident then exposed the second half: an attempt left non-terminal by a dead owner is
 * also non-RETRYABLE, so `begin` refused every new attempt id, the scheduled routine included.
 *
 * These tests pin BOTH reclaim paths and, just as importantly, pin what must NOT be reclaimed. The
 * dangerous failure here is not a wedge, it is two runners on one candidate — so every 'live' and
 * 'unknown' case below is a real falsifier, not decoration.
 */

const LEASE_MS = 3 * 60 * 60 * 1_000;

const runningWithRunner = (unit: string | null): CheckpointQualificationTransaction => {
  const begun = beginQualificationTransaction(null, {
    attemptId: 'attempt-1',
    candidate: 'candidate-1',
    nowMs: 1_000,
  }).transaction;
  const reserved = reserveQualificationRunner(begun, {
    attemptId: 'attempt-1',
    runnerId: 'manual:attempt-1:1000',
    candidate: 'candidate-1',
    leaseDurationMs: LEASE_MS,
    unit,
    nowMs: 1_000,
  });
  return reserved.transaction;
};

// Well inside the 3h lease: without a liveness term every case below would be a `conflict`.
const DURING_LEASE = 1_000 + 60_000;

it('keeps a not-yet-created named scope single-flight, then recovers its dead reservation', async () => {
  const begun = beginQualificationTransaction(null, { attemptId: 'scheduled-attempt', nowMs: 1_000 }).transaction;
  const reserved = reserveQualificationRunner(begun, {
    attemptId: 'scheduled-attempt', runnerId: 'fire-1', unit: 'papercusp-checkpoint-fire-1.scope',
    leaseDurationMs: LEASE_MS, started: false, nowMs: 1_000,
  }).transaction;
  const runner = reserved.currentPhysicalRunner!;
  configureRunnerLivenessProber(() => 'dead');
  try {
    const duringLaunch = 1_000 + QUALIFICATION_LAUNCH_GRACE_MS - 1;
    await expect(probeRunnerLiveness(runner, duringLaunch)).resolves.toBe('unknown');
    expect(reserveQualificationRunner(reserved, {
      attemptId: 'scheduled-attempt', runnerId: 'fire-2', leaseDurationMs: LEASE_MS,
      incumbentLiveness: 'dead', nowMs: duringLaunch,
    }).status).toBe('conflict');
    expect(beginQualificationTransaction(reserved, {
      attemptId: 'successor-attempt', incumbentLiveness: 'dead', nowMs: duringLaunch,
    }).status).toBe('conflict');

    const afterLaunch = 1_000 + QUALIFICATION_LAUNCH_GRACE_MS;
    await expect(probeRunnerLiveness(runner, afterLaunch)).resolves.toBe('dead');
    const reclaimed = reserveQualificationRunner(reserved, {
      attemptId: 'scheduled-attempt', runnerId: 'fire-2', leaseDurationMs: LEASE_MS,
      incumbentLiveness: 'dead', nowMs: afterLaunch,
    });
    expect(reclaimed.status).toBe('updated');
    expect(reclaimed.transaction.consumedPhysicalRuns?.at(-1)?.outcome).toEqual({
      kind: 'pre-suite-no-verdict', reason: 'runner-vanished',
    });
  } finally {
    configureRunnerLivenessProber(null);
  }
});

it('proves a scheduled CLI runner by PID boot/start identity, including recycled and unknown cases', async () => {
  configureRunnerLivenessProber(null);
  const identity = checkpointPidIdentity(process.pid);
  expect(identity).toMatch(/^[0-9a-f-]+:\d+$/);
  const current = runningWithRunner(null).currentPhysicalRunner!;
  const runner = { ...current, pid: process.pid, pidIdentity: identity };
  await expect(probeRunnerLiveness(runner)).resolves.toBe('live');
  await expect(probeRunnerLiveness({ ...runner, pidIdentity: `${identity}-recycled` })).resolves.toBe('dead');
  await expect(probeRunnerLiveness({ ...runner, pidIdentity: null })).resolves.toBe('unknown');
});

it('declares an UNBOUND launch reservation (no pid, no unit) dead only once it outlived the runner ceiling (WI-10004694)', async () => {
  // The prober would answer 'unknown' for this row; it must never be consulted past the ceiling.
  configureRunnerLivenessProber(() => 'unknown');
  try {
    const reserved = runningWithRunner(null);
    const runner = { ...reserved.currentPhysicalRunner!, phase: 'launching' as const, pid: null, unit: null };
    const lastSign = Math.max(runner.reservedAtMs, runner.leaseExpiresAtMs ?? 0);
    // Fails closed inside the ceiling: an unbound reservation is not yet proof of death.
    await expect(probeRunnerLiveness(runner, lastSign + QUALIFICATION_OWNER_ABANDONED_MS)).resolves.toBe('unknown');
    const past = lastSign + QUALIFICATION_OWNER_ABANDONED_MS + 1;
    await expect(probeRunnerLiveness(runner, past)).resolves.toBe('dead');
    // A recent heartbeat extends the evidence of life.
    await expect(probeRunnerLiveness({ ...runner, heartbeatAtMs: past - 1 }, past)).resolves.toBe('unknown');
    // A bound runner (unit or pid) is NEVER judged by age — only its probe can falsify it.
    await expect(probeRunnerLiveness({ ...runner, unit: 'papercusp-checkpoint-x.scope' }, past)).resolves.toBe('unknown');
    await expect(probeRunnerLiveness({ ...runner, pid: 4242 }, past)).resolves.toBe('unknown');
    // And the wedge clears: a successor attempt can take over with the probed verdict.
    expect(beginQualificationTransaction(reserved, {
      attemptId: 'successor-attempt', incumbentLiveness: await probeRunnerLiveness(runner, past), nowMs: past,
    }).status).not.toBe('conflict');
  } finally {
    configureRunnerLivenessProber(null);
  }
});

it.skipIf(process.platform !== 'linux')('runs systemctl liveness checks without blocking the event loop', async () => {
  configureRunnerLivenessProber(null);
  const bin = mkdtempSync(join(tmpdir(), 'qualification-systemctl-'));
  const previousPath = process.env.PATH;
  try {
    const fakeSystemctl = join(bin, 'systemctl');
    writeFileSync(fakeSystemctl, '#!/bin/sh\nsleep 0.25\nprintf "active\\n"\n');
    chmodSync(fakeSystemctl, 0o755);
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;

    let eventLoopAdvanced = false;
    const timer = setTimeout(() => { eventLoopAdvanced = true; }, 25);
    const liveness = await probeRunnerLiveness(runningWithRunner('papercusp-checkpoint-test.service').currentPhysicalRunner);
    clearTimeout(timer);

    expect(liveness).toBe('live');
    expect(eventLoopAdvanced).toBe(true);
  } finally {
    process.env.PATH = previousPath;
    rmSync(bin, { recursive: true, force: true });
    configureRunnerLivenessProber(null);
  }
});

describe('reserveQualificationRunner — a lease is not proof of life', () => {
  it('RECLAIMS a lease whose runner was proved dead, even though the lease has hours left', () => {
    const current = runningWithRunner('papercup-green-checkpoint-manual-1fxzuva.service');
    expect(current.currentPhysicalRunner?.leaseExpiresAtMs).toBeGreaterThan(DURING_LEASE);

    const result = reserveQualificationRunner(current, {
      attemptId: 'attempt-1',
      runnerId: 'manual:attempt-1:2000',
      leaseDurationMs: LEASE_MS,
      incumbentLiveness: 'dead',
      nowMs: DURING_LEASE,
    });

    expect(result.status).toBe('updated');
    expect(result.transaction.currentPhysicalRunner?.id).toBe('manual:attempt-1:2000');
  });

  it('records the displaced runner as runner-vanished, NOT as a runner that merely overran', () => {
    const current = runningWithRunner('unit.service');
    const result = reserveQualificationRunner(current, {
      attemptId: 'attempt-1',
      runnerId: 'manual:attempt-1:2000',
      leaseDurationMs: LEASE_MS,
      incumbentLiveness: 'dead',
      nowMs: DURING_LEASE,
    });

    const displaced = result.transaction.consumedPhysicalRuns?.at(-1);
    expect(displaced?.id).toBe('manual:attempt-1:1000');
    expect(displaced?.outcome).toEqual({ kind: 'pre-suite-no-verdict', reason: 'runner-vanished' });
  });

  // The falsifiers. If these ever pass as 'updated', the reaper is handing one candidate to two
  // concurrent runners, which is strictly worse than the wedge it replaced.
  it('REFUSES to displace a runner that is alive', () => {
    const current = runningWithRunner('unit.service');
    expect(reserveQualificationRunner(current, {
      attemptId: 'attempt-1',
      runnerId: 'manual:attempt-1:2000',
      leaseDurationMs: LEASE_MS,
      incumbentLiveness: 'live',
      nowMs: DURING_LEASE,
    }).status).toBe('conflict');
  });

  it('REFUSES to displace a runner whose liveness is unknown (fails closed to the old behaviour)', () => {
    const current = runningWithRunner(null);
    expect(reserveQualificationRunner(current, {
      attemptId: 'attempt-1',
      runnerId: 'manual:attempt-1:2000',
      leaseDurationMs: LEASE_MS,
      incumbentLiveness: 'unknown',
      nowMs: DURING_LEASE,
    }).status).toBe('conflict');

    // Omitting the field entirely must be identical to 'unknown' — that is what makes every
    // pre-existing caller safe without being updated.
    expect(reserveQualificationRunner(current, {
      attemptId: 'attempt-1',
      runnerId: 'manual:attempt-1:2000',
      leaseDurationMs: LEASE_MS,
      nowMs: DURING_LEASE,
    }).status).toBe('conflict');
  });

  it('does not treat an expired lease as proof that an unknown runner is dead', () => {
    const current = runningWithRunner('unit.service');
    expect(reserveQualificationRunner(current, {
      attemptId: 'attempt-1',
      runnerId: 'manual:attempt-1:2000',
      leaseDurationMs: LEASE_MS,
      incumbentLiveness: 'unknown',
      nowMs: 1_000 + LEASE_MS + 1,
    }).status).toBe('conflict');
  });
});

describe('beginQualificationTransaction — an owner that died must not hold the singleton forever', () => {
  it('lets a NEW attempt take over when the incumbent runner is proved dead', () => {
    const current = runningWithRunner('unit.service');
    const result = beginQualificationTransaction(current, {
      attemptId: 'attempt-2',
      incumbentLiveness: 'dead',
      nowMs: DURING_LEASE,
    });

    expect(result.status).toBe('updated');
    expect(result.transaction.attemptId).toBe('attempt-2');
    expect(result.transaction.previousAttemptId).toBe('attempt-1');
  });

  it('REFUSES a takeover while the incumbent runner is alive or unproven', () => {
    const current = runningWithRunner('unit.service');
    expect(beginQualificationTransaction(current, {
      attemptId: 'attempt-2',
      incumbentLiveness: 'live',
      nowMs: DURING_LEASE,
    }).status).toBe('conflict');
    expect(beginQualificationTransaction(current, {
      attemptId: 'attempt-2',
      nowMs: DURING_LEASE,
    }).status).toBe('conflict');
  });

  it('reclaims a runnerless attempt only after no owner could still legally be alive', () => {
    // This is the shape that wedged the gate on 2026-08-30: phase `waiting`, no runner, and a
    // pre-suite reason that is neither terminal nor in the single retryable-wait allowlist.
    const stranded: CheckpointQualificationTransaction = {
      ...runningWithRunner('unit.service'),
      phase: 'waiting',
      outcome: { kind: 'pre-suite-no-verdict', reason: 'source-mutated' },
      currentPhysicalRunner: null,
      updatedAtMs: 1_000,
    };

    // Just inside the window an owner could still be working; the claim stands.
    expect(beginQualificationTransaction(stranded, {
      attemptId: 'attempt-2',
      nowMs: 1_000 + QUALIFICATION_OWNER_ABANDONED_MS,
    }).status).toBe('conflict');

    // Past it, no runner can legally still be alive, so nobody is coming to advance it.
    expect(beginQualificationTransaction(stranded, {
      attemptId: 'attempt-2',
      nowMs: 1_000 + QUALIFICATION_OWNER_ABANDONED_MS + 1,
    }).status).toBe('updated');
  });

  it('never reclaims a TERMINAL attempt through the abandoned path', () => {
    const settled: CheckpointQualificationTransaction = {
      ...runningWithRunner('unit.service'),
      phase: 'terminal',
      outcome: { kind: 'green', reason: 'advanced' },
      currentPhysicalRunner: null,
      updatedAtMs: 1_000,
    };
    // A terminal attempt is legitimately superseded, but via the terminal path, not the reaper —
    // begin() must still hand back a fresh attempt rather than report a conflict.
    const result = beginQualificationTransaction(settled, {
      attemptId: 'attempt-2',
      nowMs: 1_000 + QUALIFICATION_OWNER_ABANDONED_MS + 1,
    });
    expect(result.status).toBe('updated');
    expect(result.transaction.attemptId).toBe('attempt-2');
  });
});
