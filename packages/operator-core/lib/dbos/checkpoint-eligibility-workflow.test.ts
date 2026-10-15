import { describe, expect, it, vi } from 'vitest';
import type { PreLaunchExclusion } from '../release-checkpoint-launch';

const mocks = vi.hoisted(() => {
  class FakeWorkflowQueue {
    constructor(public readonly name: string, _config?: unknown) {}
  }

  return {
    dbosSleep: vi.fn(async (_ms: number) => {}),
    dbosRunStep: vi.fn(async (fn: () => unknown) => fn()),
    dbosRegisterWorkflow: vi.fn((fn: unknown) => fn),
    dbosStartWorkflow: vi.fn(async () => {}),
    FakeWorkflowQueue,
  };
});

vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    sleep: mocks.dbosSleep,
    runStep: mocks.dbosRunStep,
    registerWorkflow: mocks.dbosRegisterWorkflow,
    startWorkflow: mocks.dbosStartWorkflow,
  },
  WorkflowQueue: mocks.FakeWorkflowQueue,
}));

import { runCheckpointEligibilityWait } from './checkpoint-eligibility-workflow';

const INCONCLUSIVE_SIBLING_KEYS = [
  'release:green',
  'release:green:papercusp',
  'green-checkpoint:red',
  'green-checkpoint:red:papercusp',
];

const REFUSAL: PreLaunchExclusion = {
  refuse: true,
  proceedReason: null,
  candidate: 'aaaaaaaaaaaa',
  tip: 'ffffffffffff',
  quietCutSec: 240,
  blockedPaths: [{ path: 'mine.ts', commits: ['bbb1111'], eligibleInSec: 120 }],
  waitSec: 120,
};

describe('checkpoint eligibility waiter', () => {
  it('rechecks after the durable delay and emits inconclusive when the path is still excluded', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const assess = vi.fn(async () => REFUSAL);
    const launch = vi.fn(async () => ({
      launched: true,
      unit: 'checkpoint-unit',
      argv: [],
      logPath: '/tmp/checkpoint.log',
    }));
    const emit = vi.fn(async () => ({ ok: true }));

    const result = await runCheckpointEligibilityWait(
      {
        pendingId: 'pending-1',
        paths: ['mine.ts'],
        waitSec: 120,
        root: '/tmp/papercusp',
      },
      { sleep, assess, launch, emit },
    );

    expect(sleep).toHaveBeenCalledWith(122_000);
    expect(assess).toHaveBeenCalledWith({ paths: ['mine.ts'], force: undefined, root: '/tmp/papercusp' });
    expect(launch).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'green-checkpoint:inconclusive:papercusp',
        source: 'checkpoint-eligibility-wait',
        cancelSiblingKeysFor: INCONCLUSIVE_SIBLING_KEYS,
      }),
    );
    expect(result).toEqual({ status: 'not-launched', reason: 'still-would-exclude-declared-paths' });
  });

  it('launches only after the recheck allows the declared paths', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const assess = vi.fn(async () => ({
      ...REFUSAL,
      refuse: false,
      proceedReason: 'declared-paths-in-candidate' as const,
      blockedPaths: [],
      waitSec: null,
    }));
    const launch = vi.fn(async () => ({
      launched: true,
      unit: 'checkpoint-unit',
      argv: ['systemd-run'],
      logPath: '/tmp/checkpoint.log',
    }));
    const emit = vi.fn(async () => ({ ok: true }));

    const result = await runCheckpointEligibilityWait(
      {
        pendingId: 'pending-2',
        paths: ['mine.ts'],
        waitSec: 2,
        root: '/tmp/papercusp',
        force: false,
        replaceStale: true,
      },
      { sleep, assess, launch, emit },
    );

    expect(sleep).toHaveBeenCalledWith(4_000);
    expect(launch).toHaveBeenCalledWith({ force: false, replaceStale: true, root: '/tmp/papercusp' });
    expect(emit).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'launched', result: { launched: true, unit: 'checkpoint-unit' } });
  });

  it('rechecks required ancestor lineage after the quiet-cut delay and fails closed before launch', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const assess = vi.fn(async () => ({
      ...REFUSAL,
      refuse: false,
      proceedReason: 'declared-paths-in-candidate' as const,
      blockedPaths: [],
      waitSec: null,
    }));
    const assessRequiredAncestor = vi.fn(async () => ({
      ok: false,
      reason: 'not-ancestor' as const,
      requiredAncestor: 'repair-sha',
      candidate: 'new-candidate',
      candidateSource: 'current-quiet-cut' as const,
      repairQueue: null,
      queueDecision: 'run-normal-gate' as const,
      fixerAlive: null,
    }));
    const launch = vi.fn(async () => ({
      launched: true,
      unit: 'should-not-launch',
      argv: [],
      logPath: '/tmp/checkpoint.log',
    }));
    const emit = vi.fn(async () => ({ ok: true }));

    const result = await runCheckpointEligibilityWait(
      {
        pendingId: 'pending-lineage-miss',
        paths: ['mine.ts'],
        waitSec: 120,
        root: '/tmp/papercusp',
        requiredAncestorSha: 'repair-sha',
      },
      { sleep, assess, assessRequiredAncestor, launch, emit },
    );

    expect(assessRequiredAncestor).toHaveBeenCalledWith({
      requiredAncestor: 'repair-sha',
      predictedCandidate: 'aaaaaaaaaaaa',
      root: '/tmp/papercusp',
    });
    expect(launch).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'green-checkpoint:inconclusive:papercusp',
        source: 'checkpoint-eligibility-wait',
        payload: expect.objectContaining({ reason: 'required-ancestor-missing', requiredAncestorSha: 'repair-sha' }),
        cancelSiblingKeysFor: INCONCLUSIVE_SIBLING_KEYS,
      }),
    );
    expect(result).toEqual({ status: 'not-launched', reason: 'required-ancestor-missing' });
  });

  it('launches after the deferred lineage guard passes', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const assess = vi.fn(async () => ({
      ...REFUSAL,
      refuse: false,
      proceedReason: 'declared-paths-in-candidate' as const,
      blockedPaths: [],
      waitSec: null,
    }));
    const assessRequiredAncestor = vi.fn(async () => ({
      ok: true,
      reason: 'contained' as const,
      requiredAncestor: 'repair-sha',
      candidate: 'new-candidate',
      candidateSource: 'current-quiet-cut' as const,
      repairQueue: null,
      queueDecision: 'run-normal-gate' as const,
      fixerAlive: null,
    }));
    const launch = vi.fn(async () => ({
      launched: true,
      unit: 'checkpoint-unit',
      argv: ['systemd-run'],
      logPath: '/tmp/checkpoint.log',
    }));
    const emit = vi.fn(async () => ({ ok: true }));

    const result = await runCheckpointEligibilityWait(
      {
        pendingId: 'pending-lineage-pass',
        paths: ['mine.ts'],
        waitSec: 0,
        root: '/tmp/papercusp',
        target: { workspaceId: 'ws-drill', installSlug: 'slack-asana-bug-drill' },
        requiredAncestorSha: 'repair-sha',
      },
      { sleep, assess, assessRequiredAncestor, launch, emit },
    );

    expect(assessRequiredAncestor).toHaveBeenCalledWith(expect.objectContaining({
      target: { workspaceId: 'ws-drill', installSlug: 'slack-asana-bug-drill' },
    }));

    expect(assessRequiredAncestor).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith({ root: '/tmp/papercusp', force: undefined, replaceStale: undefined });
    expect(result).toMatchObject({ status: 'launched', result: { unit: 'checkpoint-unit' } });
  });

  it('reserves one physical runner for the same logical attempt and records a launch no-verdict', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const assess = vi.fn(async () => ({
      ...REFUSAL,
      refuse: false,
      proceedReason: 'declared-paths-in-candidate' as const,
      blockedPaths: [],
      waitSec: null,
    }));
    const reserveQualification = vi.fn(async () => ({
      status: 'updated' as const,
      transaction: {} as never,
    }));
    const waitQualification = vi.fn(async () => ({
      status: 'updated' as const,
      transaction: {} as never,
    }));
    const launch = vi.fn(async () => ({
      launched: false,
      unit: 'checkpoint-unit',
      argv: [],
      logPath: '/tmp/checkpoint.log',
      reason: 'already_running',
    }));
    const emit = vi.fn(async () => ({ ok: true }));

    const result = await runCheckpointEligibilityWait(
      {
        pendingId: 'pending-logical',
        logicalAttemptId: 'attempt-logical',
        paths: ['mine.ts'],
        waitSec: 0,
        root: '/tmp/papercusp',
      },
      { sleep, assess, reserveQualification, waitQualification, launch, emit },
    );

    expect(reserveQualification).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'attempt-logical',
      runnerId: 'eligibility:pending-logical',
      candidate: 'aaaaaaaaaaaa',
    }));
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ logicalAttemptId: 'attempt-logical' }));
    expect(waitQualification).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'attempt-logical',
      reason: 'already-running',
      blockers: [expect.objectContaining({ code: 'detached-launch' })],
    }));
    expect(result).toMatchObject({ status: 'not-launched', reason: 'already_running' });
  });

  it('emits a completion event when transaction reservation refuses, so a durable receipt never hangs', async () => {
    const emit = vi.fn(async () => ({ ok: true }));
    const launch = vi.fn(async () => ({
      launched: true,
      unit: 'must-not-launch',
      argv: [],
      logPath: '/tmp/checkpoint.log',
    }));
    const result = await runCheckpointEligibilityWait(
      {
        pendingId: 'pending-conflict',
        logicalAttemptId: 'attempt-conflict',
        paths: ['mine.ts'],
        waitSec: 0,
        root: '/tmp/papercusp',
      },
      {
        sleep: async () => {},
        assess: async () => ({
          ...REFUSAL,
          refuse: false,
          proceedReason: 'declared-paths-in-candidate',
          blockedPaths: [],
          waitSec: null,
        }),
        reserveQualification: async () => ({
          status: 'conflict',
          transaction: {} as never,
        }),
        launch,
        emit,
      },
    );

    expect(launch).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'not-launched', reason: 'qualification-reservation-conflict' });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      key: 'green-checkpoint:inconclusive:papercusp',
      cancelSiblingKeysFor: INCONCLUSIVE_SIBLING_KEYS,
      payload: expect.objectContaining({
        logicalAttemptId: 'attempt-conflict',
        reason: 'qualification-reservation-conflict',
      }),
    }));
  });
});
