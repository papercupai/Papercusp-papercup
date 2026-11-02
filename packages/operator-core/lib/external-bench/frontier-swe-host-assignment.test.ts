import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import type { TaskRunResult } from '@papercusp/bench-metrics';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import { mockResolvedTyped } from '../testing/typed-mock';
import { currentProtocolFixture, controlledProtocolFixture, currentNativeCostFixture } from './reproducibility/_protocol-test-fixture';
import { requireCurrentBenchmarkAssignment } from './reproducibility/schema';
import { startFrontierSweCurrentAssignment, readCurrentBenchRepeatedSessionControl, type CurrentTaskInput } from './run-launcher';
import type { RunAgentInput } from './run-topology';
import type { FrontierSweEnvHandle } from './frontier-swe-seam';
import type { TaskCheckout } from './types';

function fixture() {
  const protocol = currentProtocolFixture('frozen-frontier', 1000);
  const arm = protocol.arms[0]; arm.account = 'pinned-account';
  const host: Omit<CurrentTaskInput, 'task' | 'checkout'> = {
    protocol, options: { workspaceId: 'benchmarks', runId: protocol.runId, armId: 'papercusp',
      seed: 1, agent: 'codex', model: arm.model, effort: 'high', account: arm.account,
      driveTimeoutMs: 1000, preregistration: { preregHash: 'a'.repeat(64), config: protocol } },
    context: { workspaceId: 'benchmarks', principal: { slug: 'trusted-host' } } as PapercuspUnifiedToolContext,
    scope: { workspaceId: 'benchmarks' }, hostRunId: 'runtime-arm-seed', loopId: 'benchmark:frozen',
    resources: { armIds: [], requestsPerArm: 64, inputTokens: 64000, outputTokens: 64000 },
    observation: { runtimeWorkspaceId: 'host', workerUnit: 'operator', gatewayUnit: 'gateway' },
  };
  const input: RunAgentInput<FrontierSweEnvHandle> = {
    task: { benchmark: 'frontier-swe', instanceId: 't1', problemStatement: 'Implement this task', graderMeta: {} },
    handle: { containerId: 'container', instanceId: 't1', image: 'pinned-image', taskNetwork: 'private-network',
      inContainerCodex: { binPath: '/opt/papercusp/codex', roots: [], hostOwner: { uid: 1000, gid: 1000 } } },
    arm: 'papercusp', role: 'worker', teamKey: 'task', topic: '', directive: '', forbidTools: [],
    attemptBudget: { maxCostUsd: 3, maxWallMs: 750 },
  };
  const cleanup = vi.fn(async () => {});
  const observer = vi.fn(async (): Promise<TaskCheckout> => ({ dir: '/private/observer', repo: 'observer', baseCommit: 'pin', cleanup }));
  const stop = vi.fn(async () => {}), readModelCalls = vi.fn(async () => 4);
  const start = vi.fn(async (i: CurrentTaskInput) => ({ options: i.options, stop, readModelCalls,
    observations: { admit: async () => ({ admitted: true, receiptRef: 'frozen-policy' }),
      observeIdentity: async () => null } }));
  return { protocol, host, input, observer, cleanup, start, stop, readModelCalls };
}

describe('FrontierSWE production assignment binding', () => {
  function claudeFixture() {
    const f = fixture(), arm = f.protocol.arms[1];
    arm.agent = 'claude'; arm.account = 'pinned-claude-account';
    arm.runtime.clientVersion = 'claude/2.1.293';
    f.protocol.priceSchedule.rates[0].cacheWriteUsdPerMillion = 1.25;
    Object.assign(f.host.options, { armId: arm.id, agent: arm.agent, model: arm.model,
      effort: arm.effort, account: arm.account });
    f.input.arm = arm.id;
    delete f.input.handle.inContainerCodex;
    f.input.handle.inContainerClaude = { binPath: '/opt/papercusp/claude', version: '2.1.293',
      sha256: 'f'.repeat(64), roots: [{ hostRoot: '/private/claude', perTaskDir: '/private/task-claude' }],
      hostOwner: { uid: 1000, gid: 1000 } };
    return f;
  }

  it('binds the frozen Claude stock reference through the existing native assignment authority', async () => {
    const f = claudeFixture();
    const assignment = await startFrontierSweCurrentAssignment(f.input, f.host, f);
    expect(assignment.options).toMatchObject({ agent: 'claude', armId: 'baseline',
      account: 'pinned-claude-account', driveTimeoutMs: 750 });
    expect(assignment.generationBudget).toEqual(f.protocol.arms[1].generationBudget);
    expect(assignment.stop).toBe(f.stop);
    expect(assignment.readModelCalls).toBe(f.readModelCalls);
    expect(f.start).toHaveBeenCalledWith(expect.objectContaining({ protocol: f.protocol,
      options: expect.objectContaining({ agent: 'claude' }), task: f.input.task, checkout: assignment.checkout }));
    expect(() => requireCurrentBenchmarkAssignment(f.protocol, { ...assignment.options,
      taskId: f.input.task.instanceId, budget: assignment.generationBudget! })).not.toThrow();
  });

  it.each(['missing-cli', 'two-clients', 'client-version', 'binary-digest', 'agent', 'treatment',
    'account', 'model', 'protocol', 'host-only'] as const)
    ('refuses Claude %s drift before allocating observer or provider authority', async fault => {
      const f = claudeFixture();
      if (fault === 'missing-cli') delete f.input.handle.inContainerClaude;
      if (fault === 'two-clients') f.input.handle.inContainerCodex = fixture().input.handle.inContainerCodex;
      if (fault === 'client-version') f.input.handle.inContainerClaude!.version = '1.0.0';
      if (fault === 'binary-digest') f.input.handle.inContainerClaude!.sha256 = 'unmeasured';
      if (fault === 'agent') f.host.options.agent = 'codex';
      if (fault === 'treatment') {
        f.protocol.arms[1].id = 'other-reference'; f.protocol.arms[0].agent = 'claude';
        f.protocol.arms[0].runtime.clientVersion = 'claude/2.1.293';
        Object.assign(f.host.options, { armId: 'papercusp', account: f.protocol.arms[0].account });
        f.input.arm = 'papercusp';
      }
      if (fault === 'account') f.host.options.account = 'foreign-account';
      if (fault === 'model') f.host.options.model = 'foreign-model';
      if (fault === 'protocol') f.host.options.preregistration.config = structuredClone(f.protocol);
      if (fault === 'protocol') f.host.options.preregistration.config.runId = 'foreign-protocol';
      if (fault === 'host-only') delete f.input.handle.taskNetwork;
      await expect(startFrontierSweCurrentAssignment(f.input, f.host, f)).rejects.toThrow(/frozen native task/);
      expect(f.observer).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
    });

  it('cleans Claude observer metadata when native assignment startup fails', async () => {
    const f = claudeFixture(); f.start.mockRejectedValue(new Error('Claude gateway unavailable'));
    await expect(startFrontierSweCurrentAssignment(f.input, f.host, f)).rejects.toThrow('Claude gateway unavailable');
    expect(f.cleanup).toHaveBeenCalledOnce();
  });

  function pairedFixture() {
    const f = fixture(), protocol = controlledProtocolFixture();
    protocol.arms.find(arm => arm.id === 'repeated-session')!.id = 'baseline';
    f.host.protocol = protocol; f.host.options.armId = 'baseline'; f.host.options.runId = protocol.runId;
    f.host.options.preregistration.config = protocol;
    const treatment = protocol.arms.find(arm => arm.id === 'coordinated')!;
    const cost = currentNativeCostFixture(['11111111-1111-4111-8111-111111111111']);
    const row = { ...cost, runId: protocol.runId, taskId: 't1', arm: treatment.id, seed: 1,
      suite: 'frontier-swe', preregHash: f.host.options.preregistration.preregHash, modelId: treatment.model,
      harnessVersion: treatment.runtime.sourceRevision, priceTableVersion: protocol.priceSchedule.version,
      graderFamily: protocol.grader.family, graderVersion: protocol.grader.version, generationStatus: 'completed',
      modality: 'diff', resolved: true, graderStatus: 'passed', tokensTotal: 16, wallClockMs: 10,
      capped: false, rolloutId: 'paired-treatment-rollout', createdAt: '2026-10-15T00:00:00Z' } satisfies TaskRunResult;
    const read = vi.fn<typeof import('./reproducibility/store').listRunResults>(async () => [row]);
    return { ...f, row, read, input: { ...f.host, task: f.input.task } };
  }

  it('reads the exact paired treatment actual spend, including every source, rather than its frozen cap', async () => {
    const f = pairedFixture();
    const result = await readCurrentBenchRepeatedSessionControl(f.input, f.read);
    expect(result).toEqual({ treatmentCostUsd: 0.2, maxSessions: 4 });
    expect(f.read).toHaveBeenCalledWith({ workspaceId: 'benchmarks', runId: f.host.protocol.runId, suite: 'frontier-swe' });
  });

  it('reads paired spend for a named Minecraft repeated-session arm without changing its frozen identity', async () => {
    const f = pairedFixture();
    f.host.protocol.arms.find(arm => arm.id === 'baseline')!.id = 'minecraft-repeated';
    f.host.options.armId = 'minecraft-repeated';
    f.input.task = { ...f.input.task, benchmark: 'minecraft' };
    f.host.protocol.grader.family = 'minecraft';
    f.read.mockResolvedValue([{ ...f.row, suite: 'minecraft', graderFamily: 'minecraft' }]);
    expect(await readCurrentBenchRepeatedSessionControl(f.input, f.read)).toEqual({ treatmentCostUsd: 0.2, maxSessions: 4 });
    expect(f.read).toHaveBeenCalledWith({ workspaceId: 'benchmarks', runId: f.host.protocol.runId, suite: 'minecraft' });
    f.row.armMeta.nativeCostAccounting.attemptAccountingComplete = false;
    await expect(readCurrentBenchRepeatedSessionControl(f.input, f.read)).rejects.toThrow();
  });

  it.each(['missing', 'duplicate', 'foreign-protocol', 'unmeasured', 'incomplete-source', 'incomplete-requests', 'wrong-price'] as const)
    ('refuses %s paired spend before opening another native assignment', async kind => {
      const f = pairedFixture();
      if (kind === 'missing') f.read.mockResolvedValue([]);
      if (kind === 'duplicate') mockResolvedTyped(f.read, [f.row, f.row]);
      if (kind === 'foreign-protocol') f.row.preregHash = 'b'.repeat(64);
      if (kind === 'unmeasured') Object.assign(f.row.armMeta, { costUsdMeasurementMissing: true });
      if (kind === 'incomplete-source') f.row.armMeta.nativeCostAccounting.sourceCensusComplete = false;
      if (kind === 'incomplete-requests') f.row.armMeta.nativeCostAccounting.attemptAccountingComplete = false;
      if (kind === 'wrong-price') f.row.priceTableVersion = 'other-prices';
      await expect(readCurrentBenchRepeatedSessionControl(f.input, f.read)).rejects.toThrow();
      expect(f.start).not.toHaveBeenCalled();
    });

  it('binds the frozen stock reference through the same task, caps and accounting authority', async () => {
    const f = fixture(); const arm = f.protocol.arms[1];
    f.host.options = { ...f.host.options, armId: arm.id, model: arm.model, effort: arm.effort as 'high', account: arm.account };
    f.input.arm = arm.id;
    const assignment = await startFrontierSweCurrentAssignment(f.input, f.host, f);
    expect(assignment.options.armId).toBe('baseline');
    expect(assignment.generationBudget).toEqual(arm.generationBudget);
    expect(assignment.readModelCalls).toBe(f.readModelCalls);
    expect(f.start).toHaveBeenCalledWith(expect.objectContaining({ task: f.input.task, checkout: assignment.checkout }));
  });

  it('keeps exact frozen generation caps after container preparation while tightening the drive timeout', async () => {
    const f = fixture();
    // This is the integration failure: topology wall headroom differs from frozen caps.
    expect(() => requireCurrentBenchmarkAssignment(f.protocol, { ...f.host.options, taskId: 't1',
      budget: { maxUsd: 3, maxWallClockMs: 750 } })).toThrow(/budget drift/);
    const assignment = await startFrontierSweCurrentAssignment(f.input, f.host, f);
    expect(() => requireCurrentBenchmarkAssignment(f.protocol, { ...assignment.options, taskId: 't1',
      budget: assignment.generationBudget! })).not.toThrow();
    expect(assignment.options.driveTimeoutMs).toBe(750);
    expect(f.host.options.driveTimeoutMs).toBe(1000);
    expect(f.start).toHaveBeenCalledWith(expect.objectContaining({ hostRunId: 'runtime-arm-seed',
      task: f.input.task, checkout: assignment.checkout, protocol: f.protocol, resources: f.host.resources,
      context: f.host.context, observation: f.host.observation }));
    expect(assignment.readModelCalls).toBe(f.readModelCalls);
    expect(assignment.stop).toBe(f.stop);
  });

  it.each(['arm', 'model', 'account', 'workspace', 'seed', 'task', 'container-task', 'role', 'cancelled', 'host-only'])
    ('refuses %s drift before creating an observer or opening provider authority', async field => {
      const f = fixture();
      if (field === 'arm') f.input.arm = 'baseline';
      if (field === 'model') f.host.options.model = 'different';
      if (field === 'account') f.host.options.account = 'other-account';
      if (field === 'workspace') f.host.options.workspaceId = 'another-bench';
      if (field === 'seed') f.host.options.seed = 99;
      if (field === 'task') f.input.task.instanceId = 'not-frozen';
      if (field === 'container-task') f.input.handle.instanceId = 'other-task';
      if (field === 'role') f.input.role = 'judge';
      if (field === 'cancelled') { const abort = new AbortController(); abort.abort(); f.host.options.signal = abort.signal; }
      if (field === 'host-only') f.input.handle.inContainerCodex = undefined;
      await expect(startFrontierSweCurrentAssignment(f.input, f.host, f)).rejects.toThrow(/frozen native task/);
      expect(f.observer).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
    });

  it.each([undefined, 0, -1, NaN, 1001])('refuses invalid wall headroom %s before allocation', async left => {
    const f = fixture(); f.input.attemptBudget.maxWallMs = left;
    await expect(startFrontierSweCurrentAssignment(f.input, f.host, f)).rejects.toThrow(/budget/);
    expect(f.observer).not.toHaveBeenCalled();
  });

  it('refuses altered cost/token caps rather than pretending they match the pre-registration', async () => {
    const f = fixture(); f.input.attemptBudget.maxCostUsd = 2;
    await expect(startFrontierSweCurrentAssignment(f.input, f.host, f)).rejects.toThrow(/exact frozen/);
    expect(f.start).not.toHaveBeenCalled();
  });

  it('removes the observer if provider host allocation fails', async () => {
    const f = fixture(); f.start.mockRejectedValueOnce(new Error('gateway unavailable'));
    await expect(startFrontierSweCurrentAssignment(f.input, f.host, f)).rejects.toThrow('gateway unavailable');
    expect(f.cleanup).toHaveBeenCalledOnce();
  });

  it('allocates a removable host metadata directory without cloning or copying the task repository', async () => {
    const f = fixture();
    const assignment = await startFrontierSweCurrentAssignment(f.input, f.host, { start: f.start });
    try {
      expect(existsSync(assignment.checkout.dir)).toBe(true);
      expect(assignment.checkout.repo).toBe('frontier-swe:t1');
      expect(existsSync(`${assignment.checkout.dir}/app`)).toBe(false);
      expect(existsSync(`${assignment.checkout.dir}/.git`)).toBe(false);
    } finally { await assignment.checkout.cleanup(); }
    expect(existsSync(assignment.checkout.dir)).toBe(false);
  });
});
