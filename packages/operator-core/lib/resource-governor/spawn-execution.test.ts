import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalLaunchResolution } from '../goal-launch-settings';

const beginGovernedExecutionMock = vi.fn();
const registerGoalLaunchMock = vi.fn();
vi.mock('../goal-launch-settings', () => ({
  registerGoalLaunch: (...args: unknown[]) => registerGoalLaunchMock(...args),
}));
const governedExecutionRuntimeMock = vi.fn((_workspaceId?: string, _namespace?: string) => ({
  governor: {},
  driver: {},
}));

vi.mock('./execution', () => ({
  beginGovernedExecution: (...args: unknown[]) => beginGovernedExecutionMock(...args),
  governedExecutionRuntime: (workspaceId: string, namespace?: string) =>
    governedExecutionRuntimeMock(workspaceId, namespace),
}));

import { spawnGovernedAgentProcess } from './spawn-execution';

const context = {
  contractVersion: 1 as const,
  requestId: 'request-1',
  rootRequestId: 'request-1',
  parentRequestId: null,
  parentReceiptId: null,
  receiptId: 'WI-1',
  idempotencyKey: 'spawn-1',
  admissionClass: 'agent',
  priority: 0,
  demand: { cpuWeight: 1 },
  depth: 0,
  createdAtMs: 1,
  decisionGeneration: 2,
  leaseId: 'lease-1',
};

const finalResolution: GoalLaunchResolution = {
  goalId: 'goal-final', settings: null, goalBrief: null, effective: {},
  ceilings: { maxAgents: 6, maxPerFleet: 3 }, headcount: { total: 5, fleet: 2 },
  headcountMeasurement: {
    measuredAt: '2026-10-05T18:40:16Z', populationComplete: true,
    candidate: { total: 6, fleet: 3 },
    counted: Array.from({ length: 5 }, (_, index) => ({
      ownerId: `existing-${index}`, inFleet: index < 2, basis: 'launch-reservation' as const,
      heartbeatAt: null, briefUpdatedAt: null,
    })),
    oracleEndedOwnerIds: ['ended'], excludedOwnerIds: ['replacement', 'target'],
  },
  budget: null, refusal: null, degraded: false, degradedReasons: [],
};

describe('spawnGovernedAgentProcess', () => {
  const finish = vi.fn(async () => true);
  const cancel = vi.fn(async () => true);

  beforeEach(() => {
    vi.clearAllMocks();
    beginGovernedExecutionMock.mockImplementation(async (request) => ({
      context: request.metadata?.launchedBy ? { ...context, metadata: request.metadata } : context, finish, cancel,
    }));
    registerGoalLaunchMock.mockImplementation(async (_args, register) => ({
      value: await register('goal-fixture'), resolution: null, degradedReason: null,
    }));
  });

  it('admits before spawning, passes nested context, and releases on child exit', async () => {
    const child = new EventEmitter();
    const spawn = vi.fn(async (received) => ({
      status: 'ok' as const,
      pid: 42,
      terminal: 'xterm',
      child,
      display: ':0',
      desktopEnvResolvedVia: 'active-seat' as const,
    }));
    const result = await spawnGovernedAgentProcess(
      { workspaceId: 'ws', idempotencyKey: 'spawn-1', owner: 'launcher', parent: context },
      spawn as never,
    );

    expect(beginGovernedExecutionMock).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'spawn-1', admissionClass: 'agent', parent: context }),
      { owner: 'launcher' },
      expect.anything(),
    );
    expect(spawn).toHaveBeenCalledWith(context);
    expect(result).toMatchObject({ status: 'ok', admissionContext: context });
    child.emit('exit', 0, null);
    await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());
  });

  it('cancels the durable receipt when the spawn returns an error', async () => {
    const result = await spawnGovernedAgentProcess(
      { workspaceId: 'ws', idempotencyKey: 'spawn-1', owner: 'launcher' },
      async () => ({ status: 'error', error: 'no terminal', code: 502 }),
    );
    expect(result).toEqual({ status: 'error', error: 'no terminal', code: 502 });
    expect(cancel).toHaveBeenCalledWith('no terminal');
    expect(finish).not.toHaveBeenCalled();
  });

  it('uses the persistent headless childExit observer when available', async () => {
    let resolveExit!: (value: { code: number; signal: null }) => void;
    const childExit = new Promise<{ code: number; signal: null }>((resolve) => { resolveExit = resolve; });
    await spawnGovernedAgentProcess(
      { workspaceId: 'ws', idempotencyKey: 'spawn-1', owner: 'launcher' },
      async () => ({
        status: 'ok',
        pid: 43,
        terminal: 'headless',
        child: null,
        childExit,
        display: null,
        desktopEnvResolvedVia: null,
      }),
    );
    resolveExit({ code: 0, signal: null });
    await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());
  });

  it('registers the goal reservation at the shared door before starting a process', async () => {
    const spawn = vi.fn(async () => ({ status: 'error' as const, error: 'fixture spawn failure', code: 502 }));
    await spawnGovernedAgentProcess({
      workspaceId: 'ws', idempotencyKey: 'spawn-1', owner: 'target',
      metadata: { launchedBy: 'launcher', targetOwnerId: 'target', fleetSlug: 'fleet', replacesOwnerId: 'old-owner' },
    }, spawn);
    expect(registerGoalLaunchMock).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws', launcherOwnerId: 'launcher', targetOwnerId: 'target', fleetSlug: 'fleet', excludeOwnerIds: ['old-owner'],
    }), expect.any(Function));
    expect(beginGovernedExecutionMock).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ goalId: 'goal-fixture', goalReservation: true, targetOwnerId: 'target' }),
    }), expect.anything(), expect.anything());
    expect(spawn).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith('fixture spawn failure');
  });

  it.each(['ok', 'error'] as const)('persists and returns the same final admission population after spawn %s', async (status) => {
    registerGoalLaunchMock.mockImplementation(async (_args, register) => ({
      value: await register('goal-final', finalResolution, null), resolution: finalResolution, degradedReason: null,
    }));
    const result = await spawnGovernedAgentProcess({
      workspaceId: 'ws', idempotencyKey: 'spawn-1', owner: 'target',
      metadata: { launchedBy: 'launcher', targetOwnerId: 'target', fleetSlug: 'fleet' },
    }, async () => status === 'ok'
      ? { status: 'ok', pid: 42, terminal: 'headless', child: null, display: null, desktopEnvResolvedVia: null }
      : { status: 'error', error: 'late boot failure', code: 502 });
    const persisted = JSON.parse(beginGovernedExecutionMock.mock.calls[0][0].metadata.goalAdmission);
    expect(persisted).toMatchObject({
      stage: 'final', goalId: 'goal-final', launcherOwnerId: 'launcher', targetOwnerId: 'target',
      fleet: 'fleet', requested: 1, decision: 'admitted', capacityStatus: 'enforced',
      ceilings: finalResolution.ceilings, headcount: finalResolution.headcount,
      measurement: finalResolution.headcountMeasurement, degraded: false, degradedReasons: [],
    });
    expect(result).toMatchObject({ goalAdmission: persisted,
      admissionContext: { ...context, metadata: beginGovernedExecutionMock.mock.calls[0][0].metadata } });
    expect(beginGovernedExecutionMock).toHaveBeenCalledOnce();
    if (status === 'error') expect(cancel).toHaveBeenCalledWith('late boot failure');
  });

  it('persists unknown final admission on a fail-open lock error instead of manufacturing a zero population', async () => {
    registerGoalLaunchMock.mockImplementation(async (_args, register) => ({
      value: await register('goal-final', null, 'fixture lock unavailable'), resolution: null,
      degradedReason: 'fixture lock unavailable',
    }));
    const result = await spawnGovernedAgentProcess({
      workspaceId: 'ws', idempotencyKey: 'spawn-1', owner: 'target', metadata: { launchedBy: 'launcher' },
    }, async () => ({ status: 'error', error: 'late boot failure', code: 502 }));
    const persisted = JSON.parse(beginGovernedExecutionMock.mock.calls[0][0].metadata.goalAdmission);
    expect(persisted).toMatchObject({
      decision: 'unknown', capacityStatus: 'unknown', headcount: null, measurement: null,
      degraded: true, degradedReasons: ['fixture lock unavailable'],
    });
    expect(result).toMatchObject({ goalAdmission: persisted });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('returns the original receipt observation when the final resolver measures a retry', async () => {
    const input = { workspaceId: 'ws', idempotencyKey: 'spawn-1', owner: 'target',
      metadata: { launchedBy: 'launcher', targetOwnerId: 'target', fleetSlug: 'fleet' } };
    registerGoalLaunchMock.mockImplementation(async (_args, register) => ({
      value: await register('goal-final', finalResolution, null), resolution: finalResolution, degradedReason: null,
    }));
    let originalMetadata: Record<string, string> | undefined;
    beginGovernedExecutionMock.mockImplementation(async (request) => {
      originalMetadata ??= request.metadata;
      return { context: { ...context, metadata: originalMetadata }, finish, cancel };
    });
    const spawn = async () => ({ status: 'ok' as const, pid: 42, terminal: 'headless', child: null,
      display: null, desktopEnvResolvedVia: null });
    const first = await spawnGovernedAgentProcess(input, spawn);
    const retryResolution = { ...finalResolution, headcount: { total: 1, fleet: 0 },
      headcountMeasurement: { ...finalResolution.headcountMeasurement!, measuredAt: '2026-10-05T18:41:16Z' } };
    registerGoalLaunchMock.mockImplementation(async (_args, register) => ({
      value: await register('goal-final', retryResolution, null), resolution: retryResolution, degradedReason: null,
    }));
    const retry = await spawnGovernedAgentProcess(input, spawn);
    expect(retry.goalAdmission).toEqual(first.goalAdmission);
    expect(retry.goalAdmission).toEqual(JSON.parse(originalMetadata!.goalAdmission));
    expect(retry.admissionContext?.metadata?.goalAdmission).toBe(originalMetadata!.goalAdmission);
  });

  it('refuses before governor registration and process start when the serialized count has no seat', async () => {
    registerGoalLaunchMock.mockResolvedValue({ value: null,
      resolution: { refusal: { message: 'goal seat already reserved' } }, degradedReason: null });
    const spawn = vi.fn();
    const result = await spawnGovernedAgentProcess({
      workspaceId: 'ws', idempotencyKey: 'spawn-1', owner: 'target', metadata: { launchedBy: 'launcher' },
    }, spawn);
    expect(result).toMatchObject({ status: 'error', error: 'goal seat already reserved', code: 409,
      goalAdmission: { decision: 'refused', stage: 'final' } });
    expect(beginGovernedExecutionMock).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['missing', 'malformed'])('reports unknown proof for a %s receipt snapshot instead of returning fresh measurement', async (kind) => {
    registerGoalLaunchMock.mockImplementation(async (_args, register) => ({
      value: await register('goal-final', finalResolution, null), resolution: finalResolution, degradedReason: null,
    }));
    beginGovernedExecutionMock.mockResolvedValue({ context: { ...context,
      metadata: kind === 'missing' ? {} : { goalAdmission: '{broken' } }, finish, cancel });
    const result = await spawnGovernedAgentProcess({ workspaceId: 'ws', idempotencyKey: 'spawn-1', owner: 'target',
      metadata: { launchedBy: 'launcher', targetOwnerId: 'target', fleetSlug: 'fleet' } },
    async () => ({ status: 'error', error: 'late boot failure', code: 502 }));
    expect(result).toMatchObject({ goalAdmission: { decision: 'unknown', capacityStatus: 'unknown',
      measurement: null, headcount: null, degraded: true },
    goalAdmissionDegraded: ['final goal admission snapshot unavailable in durable receipt'] });
    expect(cancel).toHaveBeenCalledWith('late boot failure');
  });

  it('surfaces a degraded admission read without hiding a successful process result', async () => {
    registerGoalLaunchMock.mockImplementation(async (_args, register) => ({
      value: await register('goal-fixture'), resolution: null, degradedReason: 'fixture lock unavailable',
    }));
    const result = await spawnGovernedAgentProcess({
      workspaceId: 'ws', idempotencyKey: 'spawn-1', owner: 'target', metadata: { launchedBy: 'launcher' },
    }, async () => ({ status: 'ok', pid: 42, terminal: 'headless', child: null, display: null, desktopEnvResolvedVia: null }));
    expect(result).toMatchObject({ status: 'ok', goalAdmissionDegraded: ['fixture lock unavailable'] });
  });

  it('retains the degraded admission reason when the process fails and the reservation is cancelled', async () => {
    registerGoalLaunchMock.mockImplementation(async (_args, register) => ({
      value: await register('goal-fixture'), resolution: null, degradedReason: 'fixture lock unavailable',
    }));
    const result = await spawnGovernedAgentProcess({
      workspaceId: 'ws', idempotencyKey: 'spawn-1', owner: 'target', metadata: { launchedBy: 'launcher' },
    }, async () => ({ status: 'error', error: 'fixture boot failure', code: 502 }));
    expect(result).toMatchObject({ status: 'error', error: 'fixture boot failure', code: 502,
      goalAdmissionDegraded: ['fixture lock unavailable'] });
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith('fixture boot failure');
    expect(finish).not.toHaveBeenCalled();
  });

  it('cancels a throwing process start exactly once and preserves the original exception', async () => {
    const error = new Error('fixture thrown boot failure');
    await expect(spawnGovernedAgentProcess({
      workspaceId: 'ws', idempotencyKey: 'spawn-1', owner: 'target', metadata: { launchedBy: 'launcher' },
    }, async () => { throw error; })).rejects.toBe(error);
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith('spawn threw: fixture thrown boot failure');
    expect(finish).not.toHaveBeenCalled();
  });
});
