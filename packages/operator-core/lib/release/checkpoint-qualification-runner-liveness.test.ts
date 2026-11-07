import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  beginQualificationTransaction,
  checkpointPidIdentity,
  configureRunnerLivenessProber,
  probeRunnerLiveness,
  observeQualificationProgress,
  qualificationProgressFence,
  projectCheckpointQualificationState,
  parseCheckpointQualificationTransaction,
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

describe('independent qualification semantic progress (P-002)', () => {
  const target = { workspaceId: 'observer-workspace', installSlug: 'observer-install' };
  function fixture() {
    const tx = runningWithRunner('root.scope');
    tx.runId = 'run-1';
    tx.currentPhysicalRunner = { ...tx.currentPhysicalRunner!, pid: 42, pidIdentity: 'boot:100',
      phase: 'suite', phaseEnteredAtMs: 1000, heartbeatAtMs: 1000,
      childScopeUnits: ['pc-child123.scope'], childScopeReservedAtMs: 1000 };
    tx.continuation = { schemaVersion: 1, attemptId: tx.attemptId, candidate: tx.candidate!,
      repairHead: tx.repairHead, root: '/source', taskKey: 'full-gate', retryStates: [],
      manifest: { schemaVersion: 1, units: [{ id: 'test:a', kind: 'test', path: 'a.test.ts' },
        { id: 'test:b', kind: 'test', path: 'b.test.ts' }, { id: 'post:c', kind: 'post-suite', path: 'post.ts' }] },
      receipts: [], supersededReceipts: [] };
    return tx;
  }
  function sample(tx: CheckpointQualificationTransaction, sequence: number, generation = 'observer-1',
    telemetryHealthy = true, wallOffset = 0) {
    return observeQualificationProgress(tx, target, { fence: qualificationProgressFence(tx, target),
      observerGeneration: generation, sequence, sampledAtMs: 10_000 + sequence * 1000 + wallOffset,
      monotonicAtMs: sequence * 1000, telemetryHealthy }).transaction;
  }

  it('quiet-progress: only a new relevant selected completion renews useful progress', () => {
    let tx = sample(fixture(), 1);
    expect(tx.progressObservation).toMatchObject({ health: 'baseline', semantic: 'unknown' });
    tx.continuation!.receipts.push({ unitId: 'test:a', completionId: 'first', observedAtMs: 11_500, state: 'pass' });
    tx = sample(tx, 2);
    expect(tx.progressObservation).toMatchObject({ health: 'healthy', semantic: 'advancing',
      completedUnits: ['test:a'], lastUsefulProgressMonotonicMs: 2000 });
    const runner = structuredClone(tx.currentPhysicalRunner);
    tx = sample(tx, 3);
    expect(tx.progressObservation).toMatchObject({ semantic: 'unchanged', lastUsefulProgressMonotonicMs: 2000 });
    expect(tx.currentPhysicalRunner).toEqual(runner);
    expect(tx.phase).toBe('running');
    expect(tx.outcome).toEqual({ kind: 'pending' });
  });

  it.each(['irrelevant-counter', 'chatter-spin', 'repeated-completion', 'other-phase', 'future-receipt'])(
    '%s cannot renew useful progress', kind => {
      let tx = fixture();
      tx.continuation!.receipts.push({ unitId: 'test:a', completionId: 'first', observedAtMs: 2000, state: 'pass' });
      tx = sample(tx, 1);
      tx.currentPhysicalRunner!.heartbeatAtMs = 12_000;
      tx.lastProgressAtMs = 12_000; // activity writer is deliberately not semantic evidence
      if (kind === 'repeated-completion') tx.continuation!.receipts[0]!.completionId = 'retried';
      else tx.continuation!.receipts.push({ unitId: kind === 'other-phase' ? 'post:c'
        : kind === 'future-receipt' ? 'test:b' : 'unselected', completionId: 'noise',
        observedAtMs: kind === 'future-receipt' ? 99_000 : 11_500, state: 'pass' });
      tx = sample(tx, 2);
      expect(tx.progressObservation).toMatchObject({ health: 'healthy', semantic: 'unchanged',
        completedUnits: ['test:a'], lastUsefulProgressMonotonicMs: null });
    });

  it.each(['launching', 'materializing'] as const)('opaque %s remains unknown with custody', phase => {
    let tx = fixture();
    tx.currentPhysicalRunner!.phase = phase;
    tx = sample(sample(tx, 1), 2);
    expect(tx.progressObservation).toMatchObject({ health: 'healthy', semantic: 'unknown' });
    expect(tx.currentPhysicalRunner?.childScopeUnits).toEqual(['pc-child123.scope']);
  });

  it.each(['attempt', 'candidate', 'repair', 'run', 'runner', 'pid', 'boot', 'scope', 'phase', 'epoch', 'workspace', 'install'])(
    'phase-progress-fence: rejects an old %s probe', identity => {
      const tx = fixture();
      const oldFence = qualificationProgressFence(tx, target);
      const changedTarget = { ...target };
      if (identity === 'attempt') tx.attemptId = 'successor';
      if (identity === 'candidate') tx.candidate = 'successor';
      if (identity === 'repair') tx.repairHead = 'successor';
      if (identity === 'run') tx.runId = 'successor';
      if (identity === 'runner') tx.currentPhysicalRunner!.id = 'successor';
      if (identity === 'pid') tx.currentPhysicalRunner!.pid = 43;
      if (identity === 'boot') tx.currentPhysicalRunner!.pidIdentity = 'new-boot:100';
      if (identity === 'scope') tx.currentPhysicalRunner!.childScopeUnits!.push('late.scope');
      if (identity === 'phase') tx.currentPhysicalRunner!.phase = 'delivering';
      if (identity === 'epoch') tx.currentPhysicalRunner!.phaseEnteredAtMs = 1001;
      if (identity === 'workspace') changedTarget.workspaceId = 'other';
      if (identity === 'install') changedTarget.installSlug = 'other';
      const result = observeQualificationProgress(tx, changedTarget, { fence: oldFence,
        observerGeneration: 'observer-1', sequence: 1, sampledAtMs: 11_000, monotonicAtMs: 1000, telemetryHealthy: true });
      expect(result).toMatchObject({ status: 'conflict', refusalReason: 'observer-fence-mismatch' });
      expect(result.transaction).toBe(tx);
    });

  it('observer-partition-restart requires two fresh healthy observations', () => {
    let tx = sample(sample(fixture(), 1), 2, 'observer-1', false);
    expect(tx.progressObservation?.health).toBe('unknown');
    tx = sample(tx, 3);
    expect(tx.progressObservation?.health).toBe('baseline');
    tx = sample(tx, 4);
    expect(tx.progressObservation?.health).toBe('healthy');
    tx = sample(tx, 1, 'observer-2');
    expect(tx.progressObservation).toMatchObject({ health: 'baseline', semantic: 'unknown' });
    tx = sample(tx, 2, 'observer-2');
    expect(tx.progressObservation?.health).toBe('healthy');
    const replay = observeQualificationProgress(tx, target, { fence: qualificationProgressFence(tx, target),
      observerGeneration: 'observer-1', sequence: 99, sampledAtMs: 109_000,
      monotonicAtMs: 99_000, telemetryHealthy: true });
    expect(replay).toMatchObject({ status: 'conflict', refusalReason: 'observer-retired-generation' });
  });

  it('stale-sample-replay and non-increasing monotonic samples are rejected', () => {
    const tx = sample(fixture(), 2);
    const base = { fence: qualificationProgressFence(tx, target), observerGeneration: 'observer-1',
      sampledAtMs: 13_000, monotonicAtMs: 3000, sequence: 2, telemetryHealthy: true };
    expect(observeQualificationProgress(tx, target, base)).toMatchObject({ refusalReason: 'observer-sample-replay' });
    expect(observeQualificationProgress(tx, target, { ...base, sequence: 3, monotonicAtMs: 2000 }))
      .toMatchObject({ refusalReason: 'observer-sample-order' });
  });

  it('unlimited-horizon-restart retains the same payload and requires fresh observer evidence', () => {
    let tx = sample(sample(fixture(), 1), 2);
    const horizon = 3 * (2 ** 31 - 1);
    // Persisted state crosses several former aggregate timer horizons before a
    // replacement observer starts with its own monotonic clock and sequence.
    tx = parseCheckpointQualificationTransaction(JSON.parse(JSON.stringify({ ...tx,
      continuation: undefined })))!;
    expect(tx).not.toBeNull();
    const payload = structuredClone(tx.currentPhysicalRunner);
    const restarted = observeQualificationProgress(tx, target, {
      fence: qualificationProgressFence(tx, target), observerGeneration: 'replacement-after-horizon',
      sequence: 1, sampledAtMs: horizon, monotonicAtMs: 1, telemetryHealthy: true,
    });
    expect(restarted.status).toBe('updated');
    tx = restarted.transaction;
    expect(tx.progressObservation).toMatchObject({ health: 'baseline', semantic: 'unknown',
      lastUsefulProgressMonotonicMs: null, retiredObserverGenerations: ['observer-1'] });
    expect(observeQualificationProgress(tx, target, {
      fence: qualificationProgressFence(tx, target), observerGeneration: 'observer-1',
      sequence: 99, sampledAtMs: horizon + 1, monotonicAtMs: horizon, telemetryHealthy: true,
    })).toMatchObject({ status: 'conflict', refusalReason: 'observer-retired-generation' });
    tx = observeQualificationProgress(tx, target, {
      fence: qualificationProgressFence(tx, target), observerGeneration: 'replacement-after-horizon',
      sequence: 2, sampledAtMs: horizon + 1000, monotonicAtMs: 1001, telemetryHealthy: true,
    }).transaction;
    expect(tx.progressObservation).toMatchObject({ health: 'healthy', semantic: 'unknown' });
    expect(tx.currentPhysicalRunner).toEqual(payload);
    expect(tx.outcome).toEqual({ kind: 'pending' });
    expect(reserveQualificationRunner(tx, { attemptId: tx.attemptId, runnerId: 'duplicate',
      candidate: tx.candidate, incumbentLiveness: 'live', leaseDurationMs: LEASE_MS,
      nowMs: horizon + 1000 }).status).toBe('conflict');
  });

  it.each([-60_000, 60_000, 200_000])('clock-rebase or missed pass (%sms) demands a baseline', offset => {
    let tx = sample(fixture(), 1);
    tx = sample(tx, offset === 200_000 ? 202 : 2, 'observer-1', true, offset === 200_000 ? 0 : offset);
    expect(tx.progressObservation).toMatchObject({ health: 'baseline', semantic: 'unknown', lastUsefulProgressMonotonicMs: null });
  });

  it('changed frozen manifest cannot silently become new useful progress on the next pass', () => {
    let tx = sample(fixture(), 1);
    tx.continuation!.manifest.units.push({ id: 'new', kind: 'test', path: 'new.test.ts' });
    tx = sample(tx, 2);
    expect(tx.progressObservation).toMatchObject({ health: 'unknown', reason: 'observer-manifest-changed' });
    tx = sample(tx, 3);
    expect(tx.progressObservation).toMatchObject({ health: 'unknown', reason: 'observer-manifest-changed' });
  });

  it('exposes a missed observer pass independently of a fresh controller heartbeat', () => {
    // A real-schema row without continuation proof keeps this focused on telemetry projection.
    let tx = fixture();
    delete tx.continuation;
    tx = sample(sample(tx, 1), 2);
    expect(parseCheckpointQualificationTransaction(tx), 'observer projection fixture must pass the stored schema').not.toBeNull();
    tx.currentPhysicalRunner!.heartbeatAtMs = 140_000;
    const state = projectCheckpointQualificationState(tx, 140_000, 'live');
    expect(state.runnerHealth.state).toBe('progressing');
    expect(state.runnerHealth.observer).toMatchObject({ health: 'unknown', semantic: 'unknown',
      reason: 'observer-missed-pass-or-identity-changed' });
  });
});

it.each(['live', 'unknown', 'dead'] as const)('checks the confined payload after parent death: %s', async childState => {
  const runner = { ...runningWithRunner('parent.scope').currentPhysicalRunner!,
    childScopeUnits: ['pc-child123.scope'], childScopeReservedAtMs: 1000 };
  const observed: string[] = [];
  configureRunnerLivenessProber(async candidate => {
    observed.push(candidate.unit!);
    return candidate.unit === 'pc-child123.scope' ? childState : 'dead';
  });
  try {
    await expect(probeRunnerLiveness(runner, DURING_LEASE)).resolves.toBe(childState);
    expect(observed[0]).toBe('pc-child123.scope');
    if (childState !== 'dead') expect(observed).toHaveLength(1);
  } finally { configureRunnerLivenessProber(null); }
});

it('does not reclaim a dead parent while an enrolled child may still be starting', async () => {
  const runner = { ...runningWithRunner('parent.scope').currentPhysicalRunner!,
    childScopeUnits: ['pc-child123.scope'], childScopeReservedAtMs: 1000 };
  configureRunnerLivenessProber(() => 'dead');
  try {
    await expect(probeRunnerLiveness(runner, 1000 + QUALIFICATION_LAUNCH_GRACE_MS - 1)).resolves.toBe('unknown');
    await expect(probeRunnerLiveness(runner, 1000 + QUALIFICATION_LAUNCH_GRACE_MS)).resolves.toBe('dead');
  } finally { configureRunnerLivenessProber(null); }
});

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

it.each([
  ['dead', 'live', 'live'], ['dead', 'unknown', 'unknown'], ['dead', 'dead', 'dead'],
  ['unknown', 'live', 'live'], ['unknown', 'dead', 'unknown'], ['unknown', 'unknown', 'unknown'],
  ['live', 'dead', 'live'], ['live', 'unknown', 'live'], ['live', 'live', 'live'],
] as const)('retains root scope custody after lease expiry: PID %s, scope %s => %s', async (pidState, scopeState, expected) => {
  const current = runningWithRunner('root.scope');
  const runner = { ...current.currentPhysicalRunner!, pid: 4242, pidIdentity: 'original-process' };
  current.currentPhysicalRunner = runner;
  const nowMs = runner.leaseExpiresAtMs! + 1;
  const probes: Array<number | null> = [];
  configureRunnerLivenessProber(candidate => {
    probes.push(candidate.pid ?? null);
    return candidate.pid == null ? scopeState : pidState;
  });
  try {
    const liveness = await probeRunnerLiveness(runner, nowMs);
    expect(liveness).toBe(expected);
    expect(probes).toEqual([4242, null]);
    const successor = reserveQualificationRunner(current, {
      attemptId: 'attempt-1', runnerId: 'successor', leaseDurationMs: LEASE_MS,
      incumbentLiveness: liveness, nowMs,
    });
    expect(successor.status).toBe(expected === 'dead' ? 'updated' : 'conflict');
  } finally { configureRunnerLivenessProber(null); }
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

it.skipIf(process.platform !== 'linux').each(['active', 'deactivating'])('keeps %s systemctl units live without blocking the event loop', async state => {
  configureRunnerLivenessProber(null);
  const bin = mkdtempSync(join(tmpdir(), 'qualification-systemctl-'));
  const previousPath = process.env.PATH;
  try {
    const fakeSystemctl = join(bin, 'systemctl');
    writeFileSync(fakeSystemctl, `#!/bin/sh\nsleep 0.25\nprintf "${state}\\n"\n`);
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
