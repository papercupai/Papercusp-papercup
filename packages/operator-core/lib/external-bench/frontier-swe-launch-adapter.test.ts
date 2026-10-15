import { describe, expect, it, vi } from 'vitest';
import { currentNativeCostFixture } from './reproducibility/_protocol-test-fixture';
import type { CurrentBenchTaskRequestCensus } from './run-launcher';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import type { CurrentSuBenchOptions, CurrentSuBenchObservations } from './current-su';
import { requireCurrentBenchNativeRunCost } from './current-su';
import type { BenchEgress } from './bench-egress';
import type { CodexHookBridge } from './codex-hook-bridge';
import type { RunAgentInput } from './run-topology';
import type { FrontierSweEnvHandle } from './frontier-swe-seam';
import { makeFrontierSweCloneGradeSeam } from './frontier-swe-seam';
import { runTopology } from './run-topology';
import { resolveCoordinationSpec } from './coordination-topology';
import type { BenchHarnessRun } from './types';
import { startFrontierSweLaunchAdapter, type FrontierSweLaunchAdapterPorts,
  type FrontierSweLaunchAdapterConfig, type FrontierSweNativeAssignment } from './frontier-swe-launch-adapter';

vi.mock('./frontier-swe-seam', () => ({ makeFrontierSweCloneGradeSeam: vi.fn(config => ({ modality: 'in-container', config })) }));

function fixture() {
  const order: string[] = [];
  const bridge = { port: 32001, recordDir: '/tmp/private-hook-records', stop: vi.fn(async () => { order.push('bridge-stop'); }) } as unknown as CodexHookBridge;
  const unbind = vi.fn(() => { order.push('unbind'); });
  const egress = {
    originFor: (name: string) => `http://papercusp-egress:${{ gw: 8788, mcp: 9071, hooks: 9081 }[name]}`,
    bindTaskEndpoint: vi.fn(() => { order.push('bind'); return unbind; }),
    stop: vi.fn(async () => { order.push('egress-stop'); return { errors: [] }; }),
  } as unknown as BenchEgress;
  const options = { runId: 'run-fixture', armId: 'papercusp', workspaceId: 'benchmarks', agent: 'codex',
    seed: 0, model: 'fixture-model', effort: 'max', account: 'default',
    preregistration: { preregHash: 'a'.repeat(64), config: {} } } as CurrentSuBenchOptions;
  const observations = { nativeGateway: { baseURL: 'http://127.0.0.1:32002' } } as CurrentSuBenchObservations;
  const output: BenchHarnessRun = { worktreePath: '/tmp/observer-fixture', telemetry: {
    tokensIn: 100, tokensOut: 10, costUsd: 0.2, turns: 3, wallClockMs: 20,
    trajectoryRef: '/private/native-fixture.jsonl', stopReason: 'done',
  } };
  const spinRunAndCost = vi.fn(async (_input: Parameters<import('./run-loop').BenchHarnessDriver['spinRunAndCost']>[0]) => { order.push('drive'); return output; });
  const assignment: FrontierSweNativeAssignment = { options, observations,
    checkout: { dir: '/tmp/observer-fixture', repo: 'fixture/repo', baseCommit: 'fixture', cleanup: vi.fn(async () => { order.push('checkout-cleanup'); }) },
    readModelCalls: vi.fn(async () => 4), stop: vi.fn(async () => { order.push('assignment-stop'); }) };
  const ports: FrontierSweLaunchAdapterPorts = {
    startBridge: vi.fn(async () => { order.push('bridge-start'); return bridge; }),
    startEgress: vi.fn(async () => { order.push('egress-start'); return egress; }),
    sweep: vi.fn(async () => { order.push('sweep'); return { errors: [] }; }),
    createDriver: vi.fn(() => ({ spinRunAndCost })),
  };
  const config: FrontierSweLaunchAdapterConfig = {
    runId: options.runId, context: { workspaceId: 'benchmarks' } as PapercuspUnifiedToolContext,
    mcpOrigin: 'http://127.0.0.1:9071', hookRecordDir: bridge.recordDir,
    startAssignment: vi.fn(async () => { order.push('assignment-start'); return assignment; }),
  };
  const input: RunAgentInput<FrontierSweEnvHandle> = {
    task: { benchmark: 'frontier-swe', instanceId: 'fixture-task', problemStatement: 'Do the task', graderMeta: {} },
    handle: { containerId: 'fixture-container', instanceId: 'fixture-task', image: 'fixture-image', taskNetwork: 'task-net',
      inContainerCodex: { binPath: '/opt/papercusp/codex', roots: [
        { hostRoot: '/tmp/shared-homes', perTaskDir: '/tmp/task-homes' },
        { hostRoot: '/tmp/shared-sqlite', perTaskDir: '/tmp/task-sqlite' },
      ], hostOwner: { uid: 1000, gid: 1000 } } },
    role: 'worker', arm: 'papercusp', teamKey: 'fixture-team', topic: '', directive: '', forbidTools: [],
    attemptBudget: { maxCostUsd: 5, maxTokens: 1000, maxWallMs: 2000 },
  };
  return { order, bridge, egress, unbind, options, observations, output, spinRunAndCost, assignment, ports, config, input };
}

describe('FSWE-P006-ADAPTER maintained native launch composition', () => {
  function repeatedFixture() {
    const f = fixture(); f.options.armId = 'baseline'; f.input.arm = 'baseline';
    f.assignment.repeatedSession = { treatmentCostUsd: 0.4, maxSessions: 4 };
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const binding = { workspaceId: 'benchmarks', runId: f.options.runId, preregHash: 'a'.repeat(64),
      assignmentId: 'paired-assignment', loopId: 'paired-loop' };
    let completed = 0;
    const census = (): CurrentBenchTaskRequestCensus => ({ binding, populationSha256: 'f'.repeat(64),
      requests: ids.slice(0, completed).map(id => ({ reservationId: `reservation:${id}`, nativeSessionId: id,
        nativeTurnId: `${id}:turn`, bodySha256: 'b'.repeat(64) })) });
    f.assignment.readRequestCensus = vi.fn(async () => census());
    f.assignment.issueSessionBudget = vi.fn((budget, beforeCost) => Object.freeze({ index: completed, binding, budget,
      ...(beforeCost ? { priorUsage: beforeCost } : {}) }));
    f.spinRunAndCost.mockImplementation(async () => {
      completed++;
      return { ...f.output, telemetry: { ...f.output.telemetry, ...currentNativeCostFixture(ids.slice(0, completed)),
        trajectoryRef: `native:${ids[completed - 1]}` } };
    });
    return { ...f, ids };
  }

  it('retains the task container submission at zero matched spend without opening a native session', async () => {
    const f = repeatedFixture(); f.assignment.repeatedSession = { treatmentCostUsd: 0, maxSessions: 4 };
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    try {
      const result = await adapter.runAgent(f.input);
      expect(result).toMatchObject({
        submission: { containerId: f.input.handle.containerId, instanceId: f.input.task.instanceId },
        status: 'completed', costUsd: 0, modelCalls: 0, tokensIn: 0, tokensOut: 0,
        capped: false, armMeta: { repeatedSession: { stop: 'matched-cost', sessions: [] } },
      });
      expect(f.assignment.readRequestCensus).toHaveBeenCalledOnce();
      expect(f.assignment.issueSessionBudget).not.toHaveBeenCalled();
      expect(f.ports.createDriver).not.toHaveBeenCalled();
      expect(f.spinRunAndCost).not.toHaveBeenCalled();
      expect(f.assignment.stop).toHaveBeenCalledOnce();
      expect(f.assignment.checkout.cleanup).toHaveBeenCalledOnce();
      expect(f.unbind).toHaveBeenCalledOnce();
    } finally { await adapter.stop(); }
  });

  it('keeps one gateway/workspace across fresh native sessions and charges only new source/request deltas', async () => {
    const f = repeatedFixture(), adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    try {
      const result = await adapter.runAgent(f.input);
      expect(f.config.startAssignment).toHaveBeenCalledOnce(); expect(f.egress.bindTaskEndpoint).toHaveBeenCalledOnce();
      expect(f.ports.createDriver).toHaveBeenCalledTimes(2);
      const grants = vi.mocked(f.assignment.issueSessionBudget!).mock.calls;
      expect(grants.map(([budget]) => budget.maxUsd)).toEqual([0.4, 0.2]);
      expect(grants.map(([budget]) => budget.maxTokens)).toEqual([1000, 984]);
      expect(grants[0][1]).toBeNull(); expect(grants[1][1]).toMatchObject({ costUsd: 0.2 });
      const spins = f.spinRunAndCost.mock.calls.map(([request]) => request);
      expect(spins.every(request => request.checkout === f.assignment.checkout && request.task.problemStatement.includes('What is not done yet?'))).toBe(true);
      expect(vi.mocked(f.ports.createDriver).mock.calls.map(([, , observations]) => observations.sessionBudget?.index)).toEqual([0, 1]);
      expect(result).toMatchObject({ status: 'completed', modelCalls: 2, costUsd: 0.4,
        tokensIn: 16, tokensOut: 4, tokensCacheRead: 10, tokensCacheWrite: 2,
        armMeta: { repeatedSession: { stop: 'matched-cost', sessions: [{ costUsd: 0.2 }, { costUsd: 0.2 }] } } });
      expect(f.assignment.stop).toHaveBeenCalledOnce(); expect(f.assignment.checkout.cleanup).toHaveBeenCalledOnce();
    } finally { await adapter.stop(); }
  });

  it.each(['source', 'request'] as const)('stops fresh launches when cumulative %s accounting changes', async kind => {
    const f = repeatedFixture();
    const drive = f.spinRunAndCost.getMockImplementation()!;
    f.spinRunAndCost.mockImplementation(async request => {
      const result = await drive(request);
      if (f.spinRunAndCost.mock.calls.length === 2) {
        if (kind === 'source') requireCurrentBenchNativeRunCost(result.telemetry).armMeta.nativeCostAccounting.sources[0].sourceSha256 = '0'.repeat(64);
        else vi.mocked(f.assignment.readRequestCensus!).mockImplementation(async () => ({
          binding: { workspaceId: 'other' } as CurrentBenchTaskRequestCensus['binding'], populationSha256: 'f'.repeat(64), requests: [] }));
      }
      return result;
    });
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    try {
      const result = await adapter.runAgent(f.input);
      expect(result.status).toBe('error'); expect(f.spinRunAndCost).toHaveBeenCalledTimes(2);
      expect(result.costUsd).toBe(0.4);
      expect(result.error).toMatch(/non-monotone|request census/);
      expect(f.assignment.stop).toHaveBeenCalledOnce(); expect(f.assignment.checkout.cleanup).toHaveBeenCalledOnce();
    } finally { await adapter.stop(); }
  });

  it('stops once after a session overshoots the actual treatment spend', async () => {
    const f = repeatedFixture(); f.assignment.repeatedSession = { treatmentCostUsd: 0.1, maxSessions: 4 };
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    try {
      const result = await adapter.runAgent(f.input);
      expect(result.costUsd).toBe(0.2); expect(result.armMeta).toMatchObject({ repeatedSession: { stop: 'matched-cost' } });
      expect(f.spinRunAndCost).toHaveBeenCalledOnce();
    } finally { await adapter.stop(); }
  });

  it('drives the stock native reference without persona, MCP rewrite or host hooks in its target', async () => {
    const f = fixture(); f.options.armId = 'baseline'; f.input.arm = 'baseline';
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    try {
      const result = await adapter.runAgent(f.input);
      expect(result.executionPath).toBe('stock-native-reference');
      expect(f.spinRunAndCost).toHaveBeenCalledWith(expect.objectContaining({ blueprintId: 'native-codex' }));
      const target = vi.mocked(f.ports.createDriver).mock.calls[0][2].containerExec!;
      expect(target).toMatchObject({ containerId: f.input.handle.containerId, workdir: '/app',
        sessionRelocation: { roots: f.input.handle.inContainerCodex!.roots },
        originRewrites: [{ from: 'http://127.0.0.1:32002', to: 'http://papercusp-egress:8788' }] });
      expect(target.hookBridge).toBeUndefined();
      expect(f.assignment.readModelCalls).toHaveBeenCalledOnce();
    } finally { await adapter.stop(); }
  });

  it('emits a dry scored row through the shared topology with native identity, usage and execution-path evidence', async () => {
    const f = fixture();
    f.output.telemetry.armMeta = { currentExecution: { identityStatus: 'measured', protocolIdentity: { status: 'matched' } } };
    f.output.telemetry.tokensCacheRead = 40;
    f.output.telemetry.tokensCacheWrite = 5;
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    const grade = vi.fn(async () => ({ resolved: false, score: 0.5, graderStatus: 'failed' as const }));
    const teardown = vi.fn(async () => {});
    try {
      const result = await runTopology({ spec: resolveCoordinationSpec({ id: 'papercusp', spine: {} }),
        backlog: [f.input.task], seam: { modality: 'in-container', clone: async () => f.input.handle, grade, teardown },
        budget: f.input.attemptBudget, runId: f.config.runId, seed: 0, now: () => 1000,
        rowMeta: { suite: 'frontier-swe', modelId: 'fixture-model', harnessVersion: 'fixture-version',
          preregHash: 'a'.repeat(64), rolloutId: 'fixture-rollout', graderFamily: 'frontier-swe', graderVersion: 'v2', priceTableVersion: 'frozen-prices' },
        runAgent: adapter.runAgent });
      expect(result.modelCallsSpent).toBe(4);
      expect(result.tokensSpent).toBe(155);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ score: 0.5, generationStatus: 'completed', costUsd: 0.2,
        tokensIn: 100, tokensOut: 10, tokensTotal: 155,
        armMeta: { executionPath: 'modernization-launch-adapter', nativeUsage: { tokensCacheRead: 40 },
          currentExecution: { protocolIdentity: { status: 'matched' } } } });
      expect(grade).toHaveBeenCalledWith(f.input.task, f.input.handle);
      expect(teardown).toHaveBeenCalledWith(f.input.handle);
    } finally { await adapter.stop(); }
  });

  it('separates the runtime run id from the frozen protocol and preserves its exact caps', async () => {
    const f = fixture();
    f.config.protocolRunId = f.options.runId; f.config.runId = 'separate-runtime-run';
    f.assignment.generationBudget = { maxUsd: 5, maxTokens: 1000, maxWallClockMs: 2000 };
    f.options.driveTimeoutMs = 1500; f.input.attemptBudget.maxWallMs = 1500;
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    await adapter.runAgent(f.input);
    expect(f.spinRunAndCost.mock.calls[0]?.[0]).toMatchObject({ budget: f.assignment.generationBudget });
    expect(f.ports.createDriver).toHaveBeenCalledWith(expect.objectContaining({ driveTimeoutMs: 1500 }),
      f.config.context, expect.anything());
    await adapter.stop();
  });

  it('passes the exact task container, relocation, hook bridge and origin map to the current-su driver', async () => {
    const f = fixture(), adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    const result = await adapter.runAgent(f.input);
    expect(f.ports.startEgress).toHaveBeenCalledWith(expect.objectContaining({ endpoints: [
      { name: 'gw', listenPort: 8788, perTask: true }, { name: 'mcp', listenPort: 9071, targetPort: 9071 },
      { name: 'hooks', listenPort: 9081, targetPort: 32001 },
    ] }));
    expect(f.egress.bindTaskEndpoint).toHaveBeenCalledWith('task-net', 'gw', 32002);
    expect(f.ports.createDriver).toHaveBeenCalledWith(f.options, f.config.context, expect.objectContaining({ containerExec: {
      kind: 'docker-exec', containerId: 'fixture-container', workdir: '/app', binPath: '/opt/papercusp/codex',
      sessionRelocation: { sessionEnv: 'CODEX_HOME', roots: f.input.handle.inContainerCodex!.roots },
      hookBridge: { url: 'http://papercusp-egress:9081', recordDir: '/tmp/private-hook-records' },
      originRewrites: [
        { from: 'http://127.0.0.1:32002', to: 'http://papercusp-egress:8788' },
        { from: 'http://127.0.0.1:9071', to: 'http://papercusp-egress:9071' },
      ],
    } }));
    expect(f.spinRunAndCost).toHaveBeenCalledWith({ blueprintId: 'su', task: f.input.task, checkout: f.assignment.checkout,
      budget: { maxUsd: 5, maxTokens: 1000, maxWallClockMs: 2000 } });
    expect(result).toMatchObject({ status: 'completed', costUsd: 0.2, modelCalls: 4, turns: 3,
      executionPath: 'modernization-launch-adapter', traceRef: '/private/native-fixture.jsonl' });
    expect(f.order.slice(2)).toEqual(['assignment-start', 'bind', 'drive', 'unbind', 'assignment-stop', 'checkout-cleanup']);
    await adapter.stop();
    expect(f.order.slice(-3)).toEqual(['egress-stop', 'sweep', 'bridge-stop']);
  });

  it('unbinds and stops the assignment even when the maintained driver throws', async () => {
    const f = fixture(); f.spinRunAndCost.mockRejectedValueOnce(new Error('driver failure'));
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    await expect(adapter.runAgent(f.input)).rejects.toThrow('driver failure');
    expect(f.unbind).toHaveBeenCalledTimes(1);
    expect(f.assignment.stop).toHaveBeenCalledTimes(1);
    expect(f.assignment.checkout.cleanup).toHaveBeenCalledTimes(1);
    await adapter.stop();
  });

  it('refuses host-only handles and unsupported coordination roles before opening a gateway', async () => {
    const f = fixture(), adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    await expect(adapter.runAgent({ ...f.input, handle: { ...f.input.handle, inContainerCodex: undefined } })).rejects.toThrow('host-only');
    await expect(adapter.runAgent({ ...f.input, role: 'judge' })).rejects.toThrow('single solver');
    expect(f.config.startAssignment).not.toHaveBeenCalled();
    await adapter.stop();
  });

  it.each(['http://example.com:9000', 'http://127.0.0.1:9000/other', 'https://127.0.0.1:9000'])('refuses non-local gateway %s and still cleans up', async baseURL => {
    const f = fixture(); f.observations.nativeGateway = { baseURL } as CurrentSuBenchObservations['nativeGateway'];
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    await expect(adapter.runAgent(f.input)).rejects.toThrow('loopback');
    expect(f.ports.createDriver).not.toHaveBeenCalled();
    expect(f.assignment.stop).toHaveBeenCalledTimes(1);
    await adapter.stop();
  });

  it('rejects a different arm or workspace without launching', async () => {
    const f = fixture(); f.options.armId = 'other';
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    await expect(adapter.runAgent(f.input)).rejects.toThrow('differs');
    expect(f.spinRunAndCost).not.toHaveBeenCalled();
    await adapter.stop();
  });

  it('serializes metered assignments and waits for the in-flight trial before run teardown', async () => {
    const f = fixture(); let release!: (value: BenchHarnessRun) => void;
    f.spinRunAndCost.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    const running = adapter.runAgent(f.input);
    await vi.waitFor(() => expect(f.spinRunAndCost).toHaveBeenCalled());
    await expect(adapter.runAgent(f.input)).rejects.toThrow('one metered assignment');
    const stopped = adapter.stop();
    expect(f.egress.stop).not.toHaveBeenCalled();
    release(f.output); await running; await stopped;
    await expect(adapter.runAgent(f.input)).rejects.toThrow('stopped');
    await adapter.stop(); expect(f.bridge.stop).toHaveBeenCalledTimes(1);
  });

  it('sweeps abandoned egress and stops hooks on a failed sidecar start', async () => {
    const f = fixture(); vi.mocked(f.ports.startEgress).mockRejectedValueOnce(new Error('sidecar failed'));
    await expect(startFrontierSweLaunchAdapter(f.config, f.ports)).rejects.toThrow('sidecar failed');
    expect(f.order).toEqual(['bridge-start', 'sweep', 'bridge-stop']);
  });

  it('marks missing native cost measurement as infra, retaining the known subtotal', async () => {
    const f = fixture(); f.output.telemetry.armMeta = { costUsdMeasurementMissing: true };
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    expect(await adapter.runAgent(f.input)).toMatchObject({ status: 'error', costUsd: 0.2 });
    await adapter.stop();
  });

  it('retains measured native usage and identity evidence when the request census fails', async () => {
    const f = fixture();
    f.output.telemetry.armMeta = { currentExecution: { identityStatus: 'measured' } };
    vi.mocked(f.assignment.readModelCalls).mockRejectedValueOnce(new Error('request ledger unavailable'));
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    expect(await adapter.runAgent(f.input)).toMatchObject({ status: 'error', costUsd: 0.2, tokensIn: 100,
      error: 'request ledger unavailable', armMeta: { modelCallsMeasurementMissing: true,
        currentExecution: { identityStatus: 'measured' } } });
    await adapter.stop();
  });

  it('refuses the production workspace before starting any services', async () => {
    const f = fixture(); f.config.context.workspaceId = 'papercusp-workspace';
    await expect(startFrontierSweLaunchAdapter(f.config, f.ports)).rejects.toThrow('PRODUCTION');
    expect(f.ports.startBridge).not.toHaveBeenCalled();
  });

  it('tears down services if task-seam preparation fails', async () => {
    const f = fixture(); vi.mocked(makeFrontierSweCloneGradeSeam).mockImplementationOnce(() => { throw new Error('missing musl binary'); });
    await expect(startFrontierSweLaunchAdapter(f.config, f.ports)).rejects.toThrow('missing musl binary');
    expect(f.order).toEqual(['bridge-start', 'egress-start', 'egress-stop', 'sweep', 'bridge-stop']);
  });
});
