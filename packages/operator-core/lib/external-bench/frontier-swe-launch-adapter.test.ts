import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeDockerExecWrapper } from './container-exec-target';
import { currentNativeCostFixture, currentProtocolFixture } from './reproducibility/_protocol-test-fixture';
import type { CurrentBenchTaskRequestCensus } from './run-launcher';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import type { CurrentSuBenchOptions, CurrentSuBenchObservations } from './current-su';
import { currentBenchAssignmentId, currentBenchGatewayController, requireCurrentBenchNativeRunCost } from './current-su';
import { requireProximusHostConfinement } from './proximus-runtime';
import type { BenchEgress } from './bench-egress';
import type { CodexHookBridge } from './codex-hook-bridge';
import type { RunAgentInput } from './run-topology';
import type { FrontierSweEnvHandle } from './frontier-swe-seam';
import { makeFrontierSweCloneGradeSeam } from './frontier-swe-seam';
import { runTopology } from './run-topology';
import { resolveCoordinationSpec } from './coordination-topology';
import type { BenchHarnessRun } from './types';
import { frontierSweDockerTarget, startFrontierSweLaunchAdapter, type FrontierSweLaunchAdapterPorts,
  type FrontierSweNativeLaunchAdapterConfig, type FrontierSweNativeAssignment,
  type FrontierSweProximusLaunchAdapterConfig, type FrontierSweProximusAssignment } from './frontier-swe-launch-adapter';

vi.mock('./frontier-swe-seam', () => ({ makeFrontierSweCloneGradeSeam: vi.fn(config => ({ modality: 'in-container', config })) }));
vi.mock('./proximus-runtime', async original => {
  const runtime = await original<typeof import('./proximus-runtime')>();
  return { ...runtime, requireProximusHostConfinement: vi.fn(runtime.requireProximusHostConfinement) };
});

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
  const config: FrontierSweNativeLaunchAdapterConfig = {
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
  async function claudeFixture(clientVersion = 'claude/2.1.293') {
    const f = fixture(), protocol = currentProtocolFixture(f.config.runId);
    const arm = protocol.arms[1]; arm.agent = 'claude'; arm.runtime.clientVersion = clientVersion;
    protocol.priceSchedule.rates[0].cacheWriteUsdPerMillion = 1.25;
    Object.assign(f.options, { armId: 'baseline', agent: 'claude', seed: 1, model: arm.model,
      effort: arm.effort, account: arm.account, preregistration: { preregHash: 'a'.repeat(64), config: protocol } });
    f.input.arm = 'baseline'; f.input.task.instanceId = 't1';
    delete f.input.handle.inContainerCodex;
    f.input.handle.inContainerClaude = { binPath: '/opt/papercusp/claude', version: '2.1.293', sha256: 'f'.repeat(64),
      roots: [{ hostRoot: '/tmp/shared-claude', perTaskDir: '/tmp/task-claude' }], hostOwner: { uid: 1000, gid: 1000 } };
    f.config.execution = 'claude-native';
    f.config.seam = { inContainerClaude: { version: '2.1.293', sha256: 'f'.repeat(64), homesRoot: '/tmp/shared-claude' } };
    const provider = vi.fn(async () => null), reserve = vi.fn(async () => { throw new Error('No provider execution in this test'); });
    const governor: Parameters<typeof currentBenchGatewayController>[1] = {
      enabled: async () => true, getSql: async () => ({} as never), reserve,
      settle: vi.fn(async () => ({ ok: false as const, reason: 'not-found' as const, reservation: null })),
      recordAttemptResult: vi.fn(async () => ({ ok: true })), log: () => {},
    };
    const controller = currentBenchGatewayController({ workspaceId: f.options.workspaceId, loopId: 'claude-adapter-loop',
      token: 'a'.repeat(64), preregHash: f.options.preregistration.preregHash, protocol, armId: 'baseline', taskId: 't1', seed: 1,
      resources: { inputTokens: 10_000, outputTokens: 1000, requestsPerArm: 50,
        armIds: protocol.arms.map(a => currentBenchAssignmentId(protocol.runId, a.id, 't1', 1)),
        usdPerArm: 3, maxOpenUsd: 3, wallClockMs: 1000, wallClockMsPerArm: 100 },
      authenticateProvider: provider }, governor);
    const hosted = await controller.startNativeGateway(() => {}, async () => ({ port: 32002, stop: async () => {} } as never));
    Object.assign(f.observations, hosted);
    f.assignment.stop = vi.fn(async () => { f.order.push('assignment-stop'); await hosted.stop(); });
    f.assignment.readRequestCensus = vi.fn(async () => ({ binding: hosted.nativeAccountingBinding, populationSha256: 'e'.repeat(64),
      requests: [{ reservationId: 'request-1', nativeSessionId: '11111111-1111-4111-8111-111111111111',
        nativeTurnId: '', bodySha256: 'b'.repeat(64) }] }));
    return { ...f, protocol, hosted, controller, provider, reserve };
  }
  it('starts the frozen stock Claude seam and composes the existing metered native driver with gateway-only egress', async () => {
    const f = await claudeFixture();
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    try {
      expect(vi.mocked(makeFrontierSweCloneGradeSeam).mock.calls.at(-1)?.[0]).toMatchObject({
        inContainerClaude: { version: '2.1.293', sha256: 'f'.repeat(64) } });
      expect(vi.mocked(makeFrontierSweCloneGradeSeam).mock.calls.at(-1)?.[0]?.inContainerCodex).toBeUndefined();
      expect(vi.mocked(f.ports.startEgress).mock.calls[0][0].endpoints).toEqual([{ name: 'gw', listenPort: 8788, perTask: true }]);
      const result = await adapter.runAgent(f.input);
      expect(result).toMatchObject({ status: 'completed', modelCalls: 1, costUsd: 0.2, executionPath: 'stock-native-reference' });
      expect(f.spinRunAndCost.mock.calls[0][0].blueprintId).toBe('native-claude');
      const [opts, , observed] = vi.mocked(f.ports.createDriver).mock.calls[0];
      expect(opts.agent).toBe('claude'); expect(observed.nativeGateway).toBe(f.hosted.nativeGateway);
      expect(observed.containerExec).toMatchObject({ binPath: '/opt/papercusp/claude',
        sessionRelocation: { sessionEnv: 'CLAUDE_CONFIG_DIR' } });
      expect(observed.containerExec?.hookBridge).toBeUndefined();
      expect(observed.containerExec?.originRewrites?.every(r => r.to === f.egress.originFor('gw'))).toBe(true);
      expect(f.assignment.readModelCalls).not.toHaveBeenCalled();
      expect(f.provider).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
      expect(f.assignment.stop).toHaveBeenCalledOnce(); expect(f.assignment.checkout.cleanup).toHaveBeenCalledOnce();
      expect(f.unbind).toHaveBeenCalledOnce();
    } finally { await adapter.stop(); f.controller.revoke(); }
  });
  it.each(['missing', 'invalid-version', 'invalid-hash', 'implicit-codex'])('refuses %s Claude startup before allocating services', async fault => {
    const f = fixture(); f.config.execution = 'claude-native';
    f.config.seam = { inContainerClaude: { version: '2.1.293', sha256: 'f'.repeat(64) } };
    if (fault === 'missing') delete f.config.seam.inContainerClaude;
    if (fault === 'invalid-version') f.config.seam.inContainerClaude!.version = 'latest';
    if (fault === 'invalid-hash') f.config.seam.inContainerClaude!.sha256 = 'unknown';
    if (fault === 'implicit-codex') delete f.config.execution;
    await expect(startFrontierSweLaunchAdapter(f.config, f.ports)).rejects.toThrow(/explicitly selected frozen CLI/);
    expect(f.ports.startBridge).not.toHaveBeenCalled(); expect(f.ports.startEgress).not.toHaveBeenCalled();
  });
  it.each(['treatment', 'agent', 'model', 'effort', 'account', 'client-version', 'mount-version', 'mount-hash', 'task',
    'missing-census', 'unissued-gateway', 'copied-gateway', 'revoked-gateway', 'binding', 'protocol'])('refuses %s Claude assignment before driving and still cleans it', async fault => {
    const f = await claudeFixture(fault === 'client-version' ? 'claude/1.0.0' : undefined);
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    if (fault === 'treatment') { f.options.armId = 'papercusp'; f.input.arm = 'papercusp'; }
    if (fault === 'agent') f.options.agent = 'codex';
    if (fault === 'model') f.options.model = 'foreign';
    if (fault === 'effort') f.options.effort = 'low';
    if (fault === 'account') f.options.account = 'foreign';
    if (fault === 'mount-version') f.input.handle.inContainerClaude!.version = '1.0.0';
    if (fault === 'mount-hash') f.input.handle.inContainerClaude!.sha256 = 'e'.repeat(64);
    if (fault === 'task') f.input.task.instanceId = 'foreign';
    if (fault === 'missing-census') delete f.assignment.readRequestCensus;
    if (fault === 'unissued-gateway') f.observations.nativeGateway = { baseURL: 'http://127.0.0.1:32002', token: 'b'.repeat(64) };
    if (fault === 'copied-gateway') f.observations.nativeGateway = { ...f.hosted.nativeGateway };
    if (fault === 'revoked-gateway') await f.hosted.stop();
    if (fault === 'binding') f.observations.nativeAccountingBinding = { ...f.hosted.nativeAccountingBinding, loopId: 'foreign' };
    if (fault === 'protocol') f.options.preregistration.config = { ...f.protocol, runId: 'foreign' };
    try {
      await expect(adapter.runAgent(f.input)).rejects.toThrow();
      expect(f.ports.createDriver).not.toHaveBeenCalled(); expect(f.egress.bindTaskEndpoint).not.toHaveBeenCalled();
      expect(f.assignment.stop).toHaveBeenCalledOnce(); expect(f.assignment.checkout.cleanup).toHaveBeenCalledOnce();
      expect(f.provider).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled();
    } finally { await adapter.stop(); f.controller.revoke(); }
  });
  it('retains the startup binary pins after caller and seam-config mutation', async () => {
    const f = await claudeFixture(), adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    f.config.seam!.inContainerClaude!.sha256 = 'e'.repeat(64);
    vi.mocked(makeFrontierSweCloneGradeSeam).mock.calls.at(-1)![0]!.inContainerClaude!.version = '1.0.0';
    try { expect((await adapter.runAgent(f.input)).status).toBe('completed'); }
    finally { await adapter.stop(); f.controller.revoke(); }
  });
  it('preserves measured Claude spend but refuses completion when the host request census is unavailable', async () => {
    const f = await claudeFixture(), adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    f.assignment.readRequestCensus = vi.fn(async () => { throw new Error('Incomplete host request census'); });
    try {
      expect(await adapter.runAgent(f.input)).toMatchObject({ status: 'error', modelCalls: 0, costUsd: 0.2,
        error: 'Incomplete host request census', armMeta: { modelCallsMeasurementMissing: true } });
      expect(f.assignment.readModelCalls).not.toHaveBeenCalled();
      expect(f.assignment.stop).toHaveBeenCalledOnce(); expect(f.unbind).toHaveBeenCalledOnce();
      expect(f.assignment.checkout.cleanup).toHaveBeenCalledOnce();
    } finally { await adapter.stop(); f.controller.revoke(); }
  });
  it('builds a stock Claude target with its isolated home and gateway, without hook or MCP access', () => {
    const f = fixture();
    delete f.input.handle.inContainerCodex;
    f.input.handle.inContainerClaude = { binPath: '/opt/papercusp/claude', version: '2.1.293', sha256: 'f'.repeat(64),
      roots: [{ hostRoot: '/tmp/shared-claude', perTaskDir: '/tmp/task-claude' }], hostOwner: { uid: 1000, gid: 1000 } };
    const target = frontierSweDockerTarget(f.input.handle, f.bridge, f.egress, 'http://127.0.0.1:32002', f.config.mcpOrigin, true, 'claude');
    expect(target).toMatchObject({ binPath: '/opt/papercusp/claude', sessionRelocation: {
      sessionEnv: 'CLAUDE_CONFIG_DIR', roots: f.input.handle.inContainerClaude.roots } });
    expect(target.hookBridge).toBeUndefined();
    expect(target.originRewrites).toHaveLength(3);
    expect(target.originRewrites?.every(r => r.to === f.egress.originFor('gw'))).toBe(true);
  });
  it.each(['treatment', 'mixed', 'missing', 'unfrozen', 'wrong-bin', 'multiple-roots'])('refuses a %s Claude target', change => {
    const f = fixture();
    delete f.input.handle.inContainerCodex;
    f.input.handle.inContainerClaude = { binPath: '/opt/papercusp/claude', version: '2.1.293', sha256: 'f'.repeat(64),
      roots: [{ hostRoot: '/tmp/shared-claude', perTaskDir: '/tmp/task-claude' }], hostOwner: { uid: 1000, gid: 1000 } };
    if (change === 'mixed') f.input.handle.inContainerCodex = fixture().input.handle.inContainerCodex;
    if (change === 'missing') delete f.input.handle.inContainerClaude;
    if (change === 'unfrozen') f.input.handle.inContainerClaude!.sha256 = 'unknown';
    if (change === 'wrong-bin') f.input.handle.inContainerClaude!.binPath = '/usr/bin/claude';
    if (change === 'multiple-roots') f.input.handle.inContainerClaude!.roots.push({ hostRoot: '/tmp/other', perTaskDir: '/tmp/other-task' });
    expect(() => frontierSweDockerTarget(f.input.handle, f.bridge, f.egress, 'http://127.0.0.1:32002', f.config.mcpOrigin, change !== 'treatment', 'claude')).toThrow();
  });
  it.each(['localhost', '[::1]'])('runs the generated wrapper when the private MCP config spells loopback as %s', hostname => {
    const f = fixture(), root = mkdtempSync(join(tmpdir(), 'fswe-origin-'));
    try {
      const homes = join(root, 'homes'), home = join(homes, 'session-1');
      mkdirSync(home, { recursive: true });
      f.input.handle.inContainerCodex!.roots = [{ hostRoot: homes, perTaskDir: join(root, 'task-homes') }];
      const config = `model_provider = "fixture"\n[model_providers.fixture]\nbase_url = "http://127.0.0.1:32002/v1"\n[mcp_servers.papercusp-su]\nurl = "http://${hostname}:9071/api/mcp?client=su-fixture"\n`;
      writeFileSync(join(home, 'config.toml'), config);
      const docker = join(root, 'docker');
      writeFileSync(docker, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const target = frontierSweDockerTarget(f.input.handle, f.bridge, f.egress,
        f.observations.nativeGateway!.baseURL, f.config.mcpOrigin);
      const { wrapperPath } = materializeDockerExecWrapper(target, { dir: root, dockerBin: docker });
      const result = spawnSync(wrapperPath, [], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: home } });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(config
        .replace('http://127.0.0.1:32002', 'http://papercusp-egress:8788')
        .replace(`http://${hostname}:9071`, 'http://papercusp-egress:9071'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

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
    expectTypeOf(adapter.egress).toMatchTypeOf<BenchEgress>();
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
        originRewrites: [
          { from: 'http://127.0.0.1:32002', to: 'http://papercusp-egress:8788' },
          { from: 'http://localhost:32002', to: 'http://papercusp-egress:8788' },
          { from: 'http://[::1]:32002', to: 'http://papercusp-egress:8788' },
        ] });
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
      { name: 'gw', listenPort: 8788, perTask: true }, { name: 'mcp', listenPort: 9071, targetPort: 9071, transport: 'http' },
      { name: 'hooks', listenPort: 9081, targetPort: 32001 },
    ] }));
    expect(f.egress.bindTaskEndpoint).toHaveBeenCalledWith('task-net', 'gw', 32002);
    expect(f.ports.createDriver).toHaveBeenCalledWith(f.options, f.config.context, expect.objectContaining({ containerExec: {
      kind: 'docker-exec', containerId: 'fixture-container', workdir: '/app', binPath: '/opt/papercusp/codex',
      sessionRelocation: { sessionEnv: 'CODEX_HOME', roots: f.input.handle.inContainerCodex!.roots },
      hookBridge: { url: 'http://papercusp-egress:9081', recordDir: '/tmp/private-hook-records' },
      originRewrites: [
        { from: 'http://127.0.0.1:32002', to: 'http://papercusp-egress:8788' },
        { from: 'http://localhost:32002', to: 'http://papercusp-egress:8788' },
        { from: 'http://[::1]:32002', to: 'http://papercusp-egress:8788' },
        { from: 'http://127.0.0.1:9071', to: 'http://papercusp-egress:9071' },
        { from: 'http://localhost:9071', to: 'http://papercusp-egress:9071' },
        { from: 'http://[::1]:9071', to: 'http://papercusp-egress:9071' },
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

describe('FrontierSWE typed Proximus host lifecycle', () => {
  function hostFixture() {
    const native = fixture(), input = { ...native.input, arm: 'baseline', handle: {
      containerId: 'host-task-container', instanceId: native.input.task.instanceId, image: 'immutable-host-task-image',
    } };
    const evidence: Awaited<ReturnType<FrontierSweProximusAssignment['execute']>> = {
      process: { status: 'completed', runtime: { schemaVersion: 1, runtimeRevision: 'a'.repeat(64),
        sourceRevision: 'b'.repeat(40), clientVersion: 'harbor-proximus@0.1.0a1', harborVersion: '0.23.0', fileCount: 100 },
        diagnosticContext: { cost_usd: 999, tokens: 999 }, billingStatus: 'unreconciled',
        // Copied metadata is deliberately unissued and cannot open acceptance.
        confinement: { schemaVersion: 1, source: 'confined-host-process', executionId: 'unissued-adapter-fixture',
          pythonBin: '/offline/python', maxWallClockMs: 1_000, payloadSha256: '0'.repeat(64), workerResultSha256: '0'.repeat(64),
          trialDir: '/offline/trial', gatewayBaseURL: 'http://127.0.0.1:12345',
          task: { containerId: input.handle.containerId, image: input.handle.image, network: 'none', networkMode: 'no-network' } } },
      attempts: { status: 'unavailable', reason: 'no-attempts' },
      billing: { status: 'unavailable', reason: 'no-attempts' },
      pricing: { status: 'unavailable', reason: 'no-attempts' },
    };
    const assignment: FrontierSweProximusAssignment = {
      agent: 'proximus', runId: 'host-protocol', armId: 'baseline', workspaceId: 'benchmarks',
      taskId: input.task.instanceId, containerId: input.handle.containerId, image: input.handle.image,
      execute: vi.fn(async () => evidence), stop: vi.fn(async () => {}),
    };
    const config: FrontierSweProximusLaunchAdapterConfig = {
      execution: 'proximus-host', runId: 'host-arm-runtime', protocolRunId: 'host-protocol',
      context: { workspaceId: 'benchmarks' } as PapercuspUnifiedToolContext,
      startAssignment: vi.fn(async () => assignment),
    };
    return { ...native, input, assignment, config, evidence };
  }

  it('uses the plain shared seam without starting native hooks, relays, drivers or home mounts', async () => {
    const f = hostFixture();
    Object.assign(f.config, { seam: { version: 'frozen-grader', extraRunArgs: ['--cpus=2'],
      inContainerCodex: true, inContainerClaude: { version: '2.1.293', sha256: 'f'.repeat(64) }, egress: f.egress } });
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    expect(vi.mocked(makeFrontierSweCloneGradeSeam).mock.calls.at(-1)?.[0]).toEqual({
      version: 'frozen-grader', extraRunArgs: ['--cpus=2'],
    });
    const result = await adapter.runAgent(f.input);
    expect(result).toMatchObject({ status: 'error', modelCalls: 0, tokensIn: 0, costUsd: 0,
      submission: { containerId: f.input.handle.containerId, instanceId: f.input.task.instanceId },
      executionPath: 'stock-native-reference', armMeta: { costUsdMeasurementMissing: true,
        requestConfinementMeasurementMissing: true, modelCallsMeasurementMissing: true,
        hostReference: { agent: 'proximus', processStatus: 'completed', billing: { status: 'unavailable' } } } });
    expect(result.armMeta).not.toHaveProperty('nativeUsage');
    expect(result.armMeta).not.toHaveProperty('nativeCostAccounting');
    expect(result.armMeta?.hostReference).not.toHaveProperty('diagnosticContext');
    for (const port of Object.values(f.ports)) expect(port).not.toHaveBeenCalled();
    expect(f.assignment.stop).toHaveBeenCalledOnce();
    expect(await adapter.stop()).toEqual({ errors: [] });
  });

  it('withholds official grading and tears down the task when host acceptance is incomplete', async () => {
    const f = hostFixture(), grade = vi.fn(), teardown = vi.fn(async () => {});
    vi.mocked(makeFrontierSweCloneGradeSeam).mockReturnValueOnce({ modality: 'in-container',
      clone: async () => f.input.handle, grade, teardown });
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    try {
      const result = await runTopology({ runId: f.config.runId, seed: 0, cap: 1, now: Date.now,
        spec: resolveCoordinationSpec({ id: 'baseline', spine: { claimModel: 'self-claim-fifo' } }),
        backlog: [f.input.task], budget: f.input.attemptBudget, seam: adapter.seam, runAgent: adapter.runAgent,
        rowMeta: { suite: 'frontier-swe', modelId: 'offline-model', harnessVersion: 'offline-source',
          preregHash: 'a'.repeat(64), rolloutId: f.config.runId, graderFamily: 'frontier-swe', graderVersion: 'frozen-grader',
          priceTableVersion: 'offline-prices' },
      });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ generationStatus: 'error', armMeta: { costUsdMeasurementMissing: true } });
      expect(grade).not.toHaveBeenCalled(); expect(teardown).toHaveBeenCalledOnce();
      expect(f.assignment.stop).toHaveBeenCalledOnce();
    } finally { await adapter.stop(); }
  });

  it.each([true, false])('retains exact census and billing subtotals without accepting the host run (complete=%s)', async complete => {
    const f = hostFixture();
    f.evidence.attempts = { status: 'terminal', source: 'learning-spend-reservations', populationSha256: 'c'.repeat(64),
      attempts: [], requests: [], usageComplete: complete, billingStatus: 'unreconciled',
      knownUsage: { modelCalls: 2, tokensIn: 7, tokensOut: 4, tokensCacheRead: 6, tokensCacheWrite: 0 } };
    f.evidence.billing = { status: complete ? 'complete' : 'incomplete', knownSubtotalMicros: '250000',
      billedInferenceMicros: complete ? '250000' : null, missingAttemptIds: complete ? [] : ['missing'],
      populationSha256: 'c'.repeat(64), samples: [] };
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    try {
      expect(await adapter.runAgent(f.input)).toMatchObject({ status: 'error', modelCalls: 2, tokensIn: 7,
        tokensOut: 4, tokensCacheRead: 6, costUsd: 0, turns: 0,
        armMeta: { modelCallsMeasurementMissing: false, tokenUsageMeasurementMissing: !complete,
          costUsdMeasurementMissing: true, turnsMeasurementMissing: true, requestConfinementMeasurementMissing: true,
          hostReference: { billedKnownSubtotalUsd: 0.25, billedInferenceUsd: complete ? 0.25 : null } } });
    } finally { await adapter.stop(); }
  });

  it.each(['different population', 'fractional micros', 'overflow'])('does not borrow an unusable bill: %s', async change => {
    const f = hostFixture();
    f.evidence.attempts = { status: 'terminal', source: 'learning-spend-reservations', populationSha256: 'c'.repeat(64),
      attempts: [], requests: [], usageComplete: true, billingStatus: 'unreconciled',
      knownUsage: { modelCalls: 1, tokensIn: 7, tokensOut: 2, tokensCacheRead: 3, tokensCacheWrite: 0 } };
    f.evidence.billing = { status: 'complete', knownSubtotalMicros: change === 'fractional micros' ? '0.5' :
      change === 'overflow' ? '9007199254740992' : '250000', billedInferenceMicros: '250000', missingAttemptIds: [],
      populationSha256: (change === 'different population' ? 'd' : 'c').repeat(64), samples: [] };
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    try {
      expect(await adapter.runAgent(f.input)).toMatchObject({ status: 'error', modelCalls: 1,
        costUsd: 0, armMeta: { costUsdMeasurementMissing: true } });
    } finally { await adapter.stop(); }
  });

  function acceptedFixture() {
    const f = hostFixture();
    f.evidence.process = { ...f.evidence.process, diagnosticContext: { metadata: { n_turns: 3 }, cost_usd: 999 } };
    f.evidence.attempts = { status: 'terminal', source: 'learning-spend-reservations', populationSha256: 'c'.repeat(64),
      attempts: [], requests: [], usageComplete: true, billingStatus: 'unreconciled',
      knownUsage: { modelCalls: 2, tokensIn: 7, tokensOut: 4, tokensCacheRead: 6, tokensCacheWrite: 0 } };
    f.evidence.billing = { status: 'complete', knownSubtotalMicros: '250000', billedInferenceMicros: '250000',
      missingAttemptIds: [], populationSha256: 'c'.repeat(64), samples: [] };
    f.evidence.pricing = { status: 'complete', priceTableVersion: 'frozen-test-prices', populationSha256: 'c'.repeat(64),
      knownSubtotalUsd: 0.125, normalizedCostUsd: 0.125, missingAttemptIds: [], attempts: [] };
    return f;
  }
  // Only receipt issuance is substituted here. The runtime suite independently
  // proves actual parent issuance and refusal of copied/changed process objects.
  function allowReceipt(f: ReturnType<typeof hostFixture>) {
    vi.mocked(requireProximusHostConfinement).mockImplementationOnce(value => {
      expect(value).toBe(f.evidence.process);
      return f.evidence.process.confinement;
    });
  }
  it('checks original receipt identity before copying, then reports frozen cost, actual bill and official turns separately', async () => {
    const f = acceptedFixture(); allowReceipt(f);
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    try {
      expect(await adapter.runAgent(f.input)).toMatchObject({ status: 'completed', error: null, modelCalls: 2,
        costUsd: 0.125, turns: 3, armMeta: { costUsdMeasurementMissing: false,
          requestConfinementMeasurementMissing: false, turnsMeasurementMissing: false,
          hostReference: { billedInferenceUsd: 0.25, pricing: { priceTableVersion: 'frozen-test-prices' } } } });
    } finally { await adapter.stop(); }
  });
  it('grades a fully measured host submission through the shared topology and tears down its task', async () => {
    const f = acceptedFixture(); allowReceipt(f);
    const grade = vi.fn(async () => ({ resolved: true, score: 1, graderStatus: 'passed' as const }));
    const teardown = vi.fn(async () => {});
    vi.mocked(makeFrontierSweCloneGradeSeam).mockReturnValueOnce({ modality: 'in-container',
      clone: async () => f.input.handle, grade, teardown });
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    try {
      const result = await runTopology({ spec: resolveCoordinationSpec({ id: 'baseline', spine: {} }),
        backlog: [f.input.task], seam: adapter.seam, budget: f.input.attemptBudget,
        runId: f.config.runId, seed: 0, now: () => 1000, runAgent: adapter.runAgent,
        rowMeta: { suite: 'frontier-swe', modelId: 'fixture-model', harnessVersion: 'fixture-version',
          preregHash: 'a'.repeat(64), rolloutId: 'host-rollout', graderFamily: 'frontier-swe',
          graderVersion: 'frozen-grader', priceTableVersion: 'frozen-test-prices' } });
      expect(result.modelCallsSpent).toBe(2);
      expect(result.costUsdSpent).toBe(0.125);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ generationStatus: 'completed', graderStatus: 'passed',
        score: 1, turns: 3, tokensTotal: 17, costUsd: 0.125,
        armMeta: { hostReference: { billedInferenceUsd: 0.25 }, executionPath: 'stock-native-reference' } });
      expect(grade).toHaveBeenCalledWith(f.input.task, f.input.handle);
      expect(teardown).toHaveBeenCalledWith(f.input.handle);
      expect(f.assignment.stop).toHaveBeenCalledOnce();
    } finally { await adapter.stop(); }
  });
  it.each(['copied receipt', 'foreign container', 'foreign image', 'missing turns', 'unknown usage',
    'unknown price', 'foreign pricing', 'price mismatch', 'invalid price', 'unknown bill', 'bill mismatch'] as const)
  ('withholds completed status for %s while preserving measured subtotals', async change => {
    const f = acceptedFixture();
    if (change !== 'copied receipt') allowReceipt(f);
    if (change === 'foreign container') f.evidence.process.confinement.task = { ...f.evidence.process.confinement.task, containerId: 'other' };
    if (change === 'foreign image') f.evidence.process.confinement.task = { ...f.evidence.process.confinement.task, image: 'other' };
    if (change === 'missing turns') f.evidence.process = { ...f.evidence.process, diagnosticContext: { n_turns: 3 } };
    if (f.evidence.attempts.status === 'terminal' && change === 'unknown usage') f.evidence.attempts.usageComplete = false;
    if (f.evidence.pricing.status !== 'unavailable') {
      if (change === 'unknown price') { f.evidence.pricing.status = 'incomplete'; f.evidence.pricing.normalizedCostUsd = null; }
      if (change === 'foreign pricing') f.evidence.pricing.populationSha256 = 'd'.repeat(64);
      if (change === 'price mismatch') f.evidence.pricing.normalizedCostUsd = 999;
      if (change === 'invalid price') f.evidence.pricing.knownSubtotalUsd = NaN;
    }
    if (f.evidence.billing.status !== 'unavailable') {
      if (change === 'unknown bill') { f.evidence.billing.status = 'incomplete'; f.evidence.billing.billedInferenceMicros = null; }
      if (change === 'bill mismatch') f.evidence.billing.billedInferenceMicros = '999999';
    }
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    try { expect(await adapter.runAgent(f.input)).toMatchObject({ status: 'error' }); }
    finally { await adapter.stop(); }
  });
  it.each(['agent', 'runId', 'armId', 'workspaceId', 'taskId', 'containerId', 'image'])
  ('stops a foreign %s assignment before executing it', async field => {
    const f = hostFixture(); Object.assign(f.assignment, { [field]: 'foreign' });
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    await expect(adapter.runAgent(f.input)).rejects.toThrow('differs');
    expect(f.assignment.execute).not.toHaveBeenCalled(); expect(f.assignment.stop).toHaveBeenCalledOnce();
    await adapter.stop();
  });

  it.each(['native mounts', 'Claude mounts', 'native network', 'treatment', 'judge', 'candidates', 'foreign task'])
  ('refuses %s before preparing any host assignment', async change => {
    const f = hostFixture();
    if (change === 'native mounts') Object.assign(f.input.handle, { inContainerCodex: fixture().input.handle.inContainerCodex });
    if (change === 'Claude mounts') Object.assign(f.input.handle, { inContainerClaude: { version: '2.1.293' } });
    if (change === 'native network') Object.assign(f.input.handle, { taskNetwork: 'native-task-network' });
    if (change === 'treatment') f.input.arm = 'papercusp';
    if (change === 'judge') f.input.role = 'judge';
    if (change === 'candidates') f.input.candidates = [{ index: 0, submission: {} }];
    if (change === 'foreign task') f.input.handle.instanceId = 'foreign';
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    await expect(adapter.runAgent(f.input)).rejects.toThrow('plain task handle');
    expect(f.config.startAssignment).not.toHaveBeenCalled(); await adapter.stop();
  });

  it('detaches host evidence and never treats diagnostic context cost as accounting', async () => {
    const f = hostFixture(), adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    const result = await adapter.runAgent(f.input);
    f.evidence.process.runtime.fileCount = 999;
    expect(result.armMeta?.hostReference).toMatchObject({ runtime: { fileCount: 100 } });
    expect(result.costUsd).toBe(0); expect(result.tokensIn).toBe(0);
    expect(result.armMeta?.costUsdMeasurementMissing).toBe(true); await adapter.stop();
  });

  it('rechecks cancellation after preparation and still stops the issued assignment', async () => {
    const f = hostFixture(), abort = new AbortController(); f.config.signal = abort.signal;
    vi.mocked(f.config.startAssignment).mockImplementationOnce(async () => { abort.abort(); return f.assignment; });
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    await expect(adapter.runAgent(f.input)).rejects.toThrow('cancelled');
    expect(f.assignment.execute).not.toHaveBeenCalled(); expect(f.assignment.stop).toHaveBeenCalledOnce();
    await adapter.stop();
  });

  it('passes a detached task to preparation and preserves the original submission identity across awaits', async () => {
    const f = hostFixture();
    vi.mocked(f.config.startAssignment).mockImplementationOnce(async trial => {
      f.input.task.instanceId = 'changed-by-caller'; f.input.handle.containerId = 'changed-by-caller';
      expect(trial.task.instanceId).toBe(f.assignment.taskId);
      expect(trial.handle.containerId).toBe(f.assignment.containerId);
      return f.assignment;
    });
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    const result = await adapter.runAgent(f.input);
    expect(result.submission).toEqual({ containerId: f.assignment.containerId, instanceId: f.assignment.taskId });
    await adapter.stop();
  });

  it('stops the host assignment after a process failure', async () => {
    const f = hostFixture(); vi.mocked(f.assignment.execute).mockRejectedValueOnce(new Error('process failed'));
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    await expect(adapter.runAgent(f.input)).rejects.toThrow('process failed');
    expect(f.assignment.stop).toHaveBeenCalledOnce(); await adapter.stop();
  });

  it('reports failed assignment cleanup to both the trial and adapter owner', async () => {
    const f = hostFixture(); vi.mocked(f.assignment.stop).mockRejectedValueOnce(new Error('gateway remains live'));
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports);
    await expect(adapter.runAgent(f.input)).rejects.toThrow('gateway remains live');
    expect(await adapter.stop()).toEqual({ errors: ['Error: gateway remains live'] });
  });

  it('serializes host trials and waits for their cleanup before adapter shutdown', async () => {
    const f = hostFixture(); let release!: () => void;
    vi.mocked(f.assignment.execute).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(f.evidence); }));
    const adapter = await startFrontierSweLaunchAdapter(f.config, f.ports), running = adapter.runAgent(f.input);
    await vi.waitFor(() => expect(f.assignment.execute).toHaveBeenCalledOnce());
    await expect(adapter.runAgent(f.input)).rejects.toThrow('one metered assignment');
    const stopped = adapter.stop(); expect(f.assignment.stop).not.toHaveBeenCalled();
    release(); await running; expect(await stopped).toEqual({ errors: [] });
    expect(adapter.stop()).toBe(stopped); expect(f.assignment.stop).toHaveBeenCalledOnce();
    await expect(adapter.runAgent(f.input)).rejects.toThrow('stopped');
  });
});
