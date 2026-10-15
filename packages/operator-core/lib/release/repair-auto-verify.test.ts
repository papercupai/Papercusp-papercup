/**
 * D-131: debounced auto-verify after a persisted repair admit. Required coverage per the
 * decision: debounce reset, run-lock skip, per-head idempotence — plus the phase guard and the
 * scheduling seam's never-throw contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFrozenCandidateRepairQueue,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';
import {
  REPAIR_AUTO_VERIFY_QUIET_MS,
  decideRepairAutoVerify,
  repairAutoVerifyWorkflowId,
  runRepairAutoVerify,
  scheduleRepairAutoVerify,
  setRepairAutoVerifyRunner,
  type RepairAutoVerifyDeps,
} from './repair-auto-verify';

it('keeps auto-verification workflow identities separate for equal heads in two harnesses', () => {
  const head = 'a'.repeat(40);
  const home = { workspaceId: 'workspace', installSlug: 'papercusp' };
  const drill = { workspaceId: 'workspace', installSlug: 'slack-asana-bug-drill' };
  expect(repairAutoVerifyWorkflowId(head, home)).not.toBe(repairAutoVerifyWorkflowId(head, drill));
  expect(repairAutoVerifyWorkflowId(head)).toBe(`repair-auto-verify:${head}`);
});

const CAND = 'c'.repeat(40);
const HEAD1 = '1'.repeat(40);
const HEAD2 = '2'.repeat(40);

function queueAt(overrides: Partial<FrozenCandidateRepairQueue>): FrozenCandidateRepairQueue {
  const base = createFrozenCandidateRepairQueue({
    candidate: CAND,
    failingTests: ['packages/x/a.test.ts'],
    nowMs: 1_000,
    base: null,
  });
  return { ...base, phase: 'ready-to-verify', repairHead: HEAD1, ...overrides } as FrozenCandidateRepairQueue;
}

function deps(queue: () => FrozenCandidateRepairQueue | null, opts: { lock?: boolean } = {}) {
  const launch = vi.fn(async () => ({ launched: true, unit: 'unit-x' }));
  const runLockHeld = vi.fn(() => opts.lock ?? false);
  const sleep = vi.fn(async () => {});
  const d: RepairAutoVerifyDeps = {
    sleep,
    readQueue: async () => {
      const q = queue();
      return q ? { status: 'value', queue: q } : { status: 'absent' };
    },
    runLockHeld,
    launch,
  };
  return { d, launch, runLockHeld, sleep };
}

describe('D-131 repair auto-verify', () => {
  afterEach(() => setRepairAutoVerifyRunner(null));

  it('launches after the quiet window when the head is still ready-to-verify and no run holds the lock', async () => {
    const { d, launch, sleep } = deps(() => queueAt({}));
    const out = await runRepairAutoVerify({ candidate: CAND, repairHead: HEAD1, admittedAtMs: 0 }, d);
    expect(sleep).toHaveBeenCalledWith(REPAIR_AUTO_VERIFY_QUIET_MS);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ status: 'launched', repairHead: HEAD1, unit: 'unit-x' });
  });

  it('debounce reset: a later admit moves the head, so the earlier waiter stands down and only the newest launches', async () => {
    let current = queueAt({ repairHead: HEAD1 });
    const first = deps(() => current);
    // Second admit lands during the first waiter's sleep.
    first.d.sleep = vi.fn(async () => {
      current = queueAt({ repairHead: HEAD2 });
    });
    const out1 = await runRepairAutoVerify({ candidate: CAND, repairHead: HEAD1, admittedAtMs: 0 }, first.d);
    expect(out1).toMatchObject({ status: 'skipped', reason: 'superseded' });
    expect(first.launch).not.toHaveBeenCalled();
    expect(first.runLockHeld).not.toHaveBeenCalled();

    const second = deps(() => current);
    const out2 = await runRepairAutoVerify({ candidate: CAND, repairHead: HEAD2, admittedAtMs: 1 }, second.d);
    expect(out2).toMatchObject({ status: 'launched', repairHead: HEAD2 });
    expect(second.launch).toHaveBeenCalledTimes(1);
  });

  it('run-lock skip: never launches while a gate run holds the run lock', async () => {
    const { d, launch } = deps(() => queueAt({}), { lock: true });
    const out = await runRepairAutoVerify({ candidate: CAND, repairHead: HEAD1, admittedAtMs: 0 }, d);
    expect(out).toMatchObject({ status: 'skipped', reason: 'run-lock-held' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('per-head idempotence: a head whose verification already started or already has a round is not launched again', async () => {
    const started = deps(() => queueAt({ lastResumeRunStartedAtMs: 5 }));
    expect(await runRepairAutoVerify({ candidate: CAND, repairHead: HEAD1, admittedAtMs: 0 }, started.d))
      .toMatchObject({ status: 'skipped', reason: 'already-verifying' });
    expect(started.launch).not.toHaveBeenCalled();

    const judged = queueAt({ convergenceRounds: [{ head: HEAD1 }] as unknown as FrozenCandidateRepairQueue['convergenceRounds'] });
    expect(decideRepairAutoVerify({ candidate: CAND, repairHead: HEAD1 }, { status: 'value', queue: judged }, false))
      .toMatchObject({ reason: 'already-verifying' });

    // One durable workflow per head: the dedupe key is a pure function of the head.
    expect(repairAutoVerifyWorkflowId(HEAD1)).toBe(repairAutoVerifyWorkflowId(HEAD1));
    expect(repairAutoVerifyWorkflowId(HEAD1)).not.toBe(repairAutoVerifyWorkflowId(HEAD2));
  });

  it('skips a queue not in ready-to-verify, a vanished queue, and a re-frozen candidate', () => {
    const at = { candidate: CAND, repairHead: HEAD1 };
    expect(decideRepairAutoVerify(at, { status: 'value', queue: queueAt({ phase: 'ready-to-test' }) }, false))
      .toMatchObject({ reason: 'not-ready-to-verify' });
    expect(decideRepairAutoVerify(at, { status: 'absent' }, false)).toEqual({ reason: 'no-queue' });
    expect(decideRepairAutoVerify(at, { status: 'value', queue: queueAt({ candidate: 'd'.repeat(40) }) }, false))
      .toMatchObject({ reason: 'candidate-changed' });
    // Calibration: the same inputs with every guard satisfied DO launch.
    expect(decideRepairAutoVerify(at, { status: 'value', queue: queueAt({}) }, false)).toBeNull();
  });

  it('reports not-launched when the launch itself refuses', async () => {
    const { d } = deps(() => queueAt({}));
    d.launch = async () => ({ launched: false, reason: 'already_running' });
    expect(await runRepairAutoVerify({ candidate: CAND, repairHead: HEAD1, admittedAtMs: 0 }, d))
      .toEqual({ status: 'not-launched', repairHead: HEAD1, reason: 'already_running' });
  });

  it('scheduling never throws: unwired and failing runners degrade to scheduled:false', async () => {
    const req = { candidate: CAND, repairHead: HEAD1, admittedAtMs: 100 };
    expect(await scheduleRepairAutoVerify(req)).toMatchObject({ scheduled: false });
    setRepairAutoVerifyRunner(async () => {
      throw new Error('boom');
    });
    expect(await scheduleRepairAutoVerify(req)).toMatchObject({ scheduled: false, reason: expect.stringContaining('boom') });
    const runner = vi.fn(async (i: { repairHead: string }) => ({ workflowId: repairAutoVerifyWorkflowId(i.repairHead) }));
    setRepairAutoVerifyRunner(runner);
    expect(await scheduleRepairAutoVerify(req)).toEqual({
      scheduled: true,
      workflowId: repairAutoVerifyWorkflowId(HEAD1),
      repairHead: HEAD1,
      quietMs: REPAIR_AUTO_VERIFY_QUIET_MS,
      fireAfterMs: 100 + REPAIR_AUTO_VERIFY_QUIET_MS,
    });
    expect(runner).toHaveBeenCalledWith({ ...req, quietMs: REPAIR_AUTO_VERIFY_QUIET_MS });
  });
});
