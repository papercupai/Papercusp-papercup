/** Host-launch behavior without provider calls. SQL/clone/native IO are substituted;
 * the production selector, assignment loop, cancellation and persistence ordering run. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import type { BenchHarnessDriver } from './run-loop';
import type { BenchTask } from './types';
import { currentProtocolFixture, allCapabilities } from './reproducibility/_protocol-test-fixture';
import { PROXIMUS_CLIENT_VERSION, PROXIMUS_SOURCE_REVISION } from './reproducibility/schema';

const io = vi.hoisted(() => ({ prereg: vi.fn(), committed: vi.fn(), register: vi.fn(),
  upsert: vi.fn(), task: vi.fn(), status: vi.fn(), completion: vi.fn(), events: vi.fn(), snapshot: vi.fn(),
  legacyBind: vi.fn(), legacyRun: vi.fn(), kill: vi.fn(), list: vi.fn(), emit: vi.fn() }));
vi.mock('./reproducibility/emit', () => ({ emitRollout: io.emit }));
vi.mock('./reproducibility/store', () => ({ getPrereg: io.prereg }));
vi.mock('./reproducibility/prereg', () => ({ requireCommittedPreregistration: io.committed }));
vi.mock('../learning-governor/store', async original => ({ ...await original<Record<string, unknown>>(), registerLearningLoop: io.register }));
vi.mock('./run-store', async original => ({ ...await original<Record<string, unknown>>(),
  upsertBenchRun: io.upsert, upsertBenchRunTask: io.task, setBenchRunStatus: io.status,
  recordRunCompletion: io.completion, setBenchRunEvents: io.events }));
vi.mock('./run-snapshot', () => ({ writeRunSnapshot: io.snapshot }));
vi.mock('./hive-backlog-realqueen', () => ({ bindRealQueenBacklogDriver: io.legacyBind, dissolveBenchHive: vi.fn() }));
vi.mock('./hive-backlog', async original => ({ ...await original<Record<string, unknown>>(), runHiveBacklog: io.legacyRun }));
vi.mock('../task-manager/store', () => ({ listTasks: io.list }));
vi.mock('../task-manager/control', () => ({ killTask: io.kill }));

import { currentBenchLaunchSelection, launchBenchRun, cancelBenchRun, _resetActiveRunsForTests,
  currentBenchSessionRequestDelta,
  startFrontierSweProximusAssignment,
  type LaunchBenchRunInput, type CurrentTaskInput } from './run-launcher';

const workspaceId = 'bench-host-launch-private';
const context = { workspaceId, principal: { slug: 'verified-caller', workspaceId,
  capabilities: new Set(['capability:terminal']) }, log: () => {}, signal: new AbortController().signal,
  progress: () => {}, emit: () => {} } satisfies PapercuspUnifiedToolContext;
let config: ReturnType<typeof currentProtocolFixture>;
let input: LaunchBenchRunInput;
let sql: ReturnType<typeof vi.fn> & { begin: ReturnType<typeof vi.fn> };
const task = (id: string): BenchTask => ({ benchmark: 'swe-bench-pro', instanceId: id,
  problemStatement: `Repair ${id}`, graderMeta: {} });
const scope = () => ({ workspaceId, sql: sql as never });
const driver: BenchHarnessDriver = { spinRunAndCost: async req => ({ worktreePath: req.checkout.dir,
  telemetry: { tokensIn: 10, tokensOut: 20, costUsd: 0.001, turns: 1, wallClockMs: 1,
    stopReason: 'done', trajectoryRef: 'private:test' } }) };

beforeEach(() => {
  vi.clearAllMocks(); _resetActiveRunsForTests();
  config = currentProtocolFixture('frozen-host-study', 1000);
  config.taskIds = ['t1', 't2']; config.seeds = [1, 2, 3];
  config.sampling!.taskRepositories.t2 = 'fixture-repo';
  config.priceSchedule.rates[0].inputTokenCeiling = 1000;
  config.priceSchedule.rates[0].inputTokenCeilingSourceSha256 = 'e'.repeat(64);
  const preregHash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  input = { arm: 'papercusp', taskSetId: 'custom', current: { workspaceId, protocolRunId: config.runId,
    preregHash, seed: 3, observation: { runtimeWorkspaceId: 'host-runtime', workerUnit: 'host', gatewayUnit: 'gateway' } } };
  io.prereg.mockResolvedValue({ preregHash, config });
  io.committed.mockResolvedValue({ preregHash, gitCommitSha: 'frozen-source', receiptRef: 'prereg:private' });
  io.register.mockImplementation(async (_sql, value) => value);
  io.list.mockResolvedValue([]); io.kill.mockResolvedValue({ ok: true });
  sql = Object.assign(vi.fn(async () => []), { begin: vi.fn() });
  sql.begin.mockImplementation(async fn => fn(sql));
});
afterEach(() => _resetActiveRunsForTests());

describe.each(['legacy', 'current'] as const)('Minecraft admission through the %s launcher', route => {
  it.each([
    { taskSetId: 'minecraft-pilot' },
    { taskSetId: 'minecraft-ender-dragon' },
    { taskSetId: 'minecraft-unknown' },
    { taskSetId: 'custom', suite: 'minecraft' },
  ])('refuses a gameplay task before allocating generic launch resources: %j', async selection => {
    const assertEnabled = vi.fn(), loadBacklog = vi.fn();
    const request = { ...input, ...selection,
      ...(route === 'legacy' ? { arm: 'su-independent', current: undefined } : {}) };
    await expect(launchBenchRun(request, { scope: scope(), assertEnabled, loadBacklog }))
      .rejects.toThrow(/Minecraft.*frozen gameplay runtime/);
    expect(assertEnabled).not.toHaveBeenCalled();
    expect(loadBacklog).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
    expect(io.prereg).not.toHaveBeenCalled();
    expect(io.register).not.toHaveBeenCalled();
    expect(io.upsert).not.toHaveBeenCalled();
    expect(io.legacyBind).not.toHaveBeenCalled();
    expect(io.legacyRun).not.toHaveBeenCalled();
  });
});

describe('current host selection', () => {
  it('separates each frozen seed and workspace while deriving the exact controls', () => {
    const selected = currentBenchLaunchSelection(input, config);
    expect(selected.arm.model).toBe('configured-alias');
    expect(selected.arm.generationBudget.maxUsd).toBe(3);
    const otherSeed = currentBenchLaunchSelection({ ...input, current: { ...input.current!, seed: 2 } }, config);
    expect(otherSeed.runId).not.toBe(selected.runId);
    const otherWorkspace = currentBenchLaunchSelection({ ...input, current: { ...input.current!, workspaceId: 'bench-other' } }, config);
    expect(otherWorkspace.runId).not.toBe(selected.runId);
  });
  it.each([{ model: 'opus' }, { cap: 2 }, { maxUsdPerTask: 4 }, { maxUsdPerRun: 61 }, { taskIds: ['t1'] }])
    ('refuses drift before running anything: %j', changed => {
      expect(() => currentBenchLaunchSelection({ ...input, ...changed }, config)).toThrow(/drift/);
    });
  it('refuses unregistered seeds and selects the frozen stock arm independently', () => {
    expect(() => currentBenchLaunchSelection({ ...input, current: { ...input.current!, seed: 4 } }, config)).toThrow(/frozen protocol/);
    expect(currentBenchLaunchSelection({ ...input, arm: 'baseline' }, config).arm.id).toBe('baseline');
  });
});

describe('repeated native session census', () => {
  const binding = Object.freeze({ workspaceId: 'bench', loopId: 'loop', runId: 'run', preregHash: 'a'.repeat(64), assignmentId: 'bench-assignment:run:arm:task:1' });
  const row = (reservationId: string, nativeSessionId: string) => Object.freeze({
    reservationId, nativeSessionId, nativeTurnId: `turn-${reservationId}`, bodySha256: 'b'.repeat(64),
  });
  it('returns only the new session-owned requests from a monotone census', () => {
    const empty = Object.freeze({ binding, populationSha256: 'c'.repeat(64), requests: Object.freeze([]) });
    const first = row('reservation-1', '11111111-1111-4111-8111-111111111111');
    const second = row('reservation-2', '22222222-2222-4222-8222-222222222222');
    const one = Object.freeze({ ...empty, requests: Object.freeze([first]) });
    const two = Object.freeze({ ...empty, requests: Object.freeze([first, second]) });
    expect(currentBenchSessionRequestDelta(empty, one, first.nativeSessionId)).toEqual({
      modelCalls: 1, reservationIds: ['reservation-1'],
    });
    expect(currentBenchSessionRequestDelta(one, two, second.nativeSessionId)).toEqual({
      modelCalls: 1, reservationIds: ['reservation-2'],
    });
  });
  it.each(['reused session', 'shrinking census'])('%s is refused', scenario => {
    const one = row('reservation-1', '11111111-1111-4111-8111-111111111111');
    const two = row('reservation-2', '22222222-2222-4222-8222-222222222222');
    const before = { binding, populationSha256: 'c'.repeat(64), requests: [one] };
    const after = { ...before, requests: scenario === 'reused session' ? [one, two] : [] };
    expect(() => currentBenchSessionRequestDelta(before, after,
      scenario === 'reused session' ? one.nativeSessionId : two.nativeSessionId)).toThrow(/reused|non-monotone/);
  });
});

describe('frozen Proximus host assignment factory', () => {
  type FactoryPorts = Required<NonNullable<Parameters<typeof startFrontierSweProximusAssignment>[2]>>;
  const trialDirs: string[] = [];
  afterEach(() => { for (const dir of trialDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  function fixture() {
    config = currentProtocolFixture('host-proximus-factory', 1_000);
    for (const arm of config.arms) {
      arm.account = 'pinned-account';
      arm.control = { topology: arm.id === 'baseline' ? 'stock-native-reference' : 'solo',
        solverGroup: arm.id, solverToolsHash: 'a'.repeat(64), capabilities: allCapabilities(arm.id === 'baseline' ? 'off' : 'on') };
    }
    const arm = config.arms[1];
    arm.agent = 'proximus';
    arm.runtime = { sourceRevision: PROXIMUS_SOURCE_REVISION, clientVersion: PROXIMUS_CLIENT_VERSION,
      runtimeRevision: 'b'.repeat(64), promptHash: 'c'.repeat(64), toolsHash: 'd'.repeat(64),
      proximus: { provider: 'openai', harborVersion: '0.23.0', maxInputTokens: 20_000, supportsVision: false } };
    Object.assign(config.priceSchedule.rates[0], { inputTokenCeiling: 1_000,
      inputTokenCeilingSourceSha256: 'e'.repeat(64), outputTokenCeiling: 64 });
    config.grader.images = { t1: `registry.example/task@sha256:${'f'.repeat(64)}` };
    const preregHash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    const host: Parameters<typeof startFrontierSweProximusAssignment>[1] = {
      options: { workspaceId, runId: config.runId, armId: 'baseline', agent: 'proximus', seed: 1,
        model: arm.model, effort: 'high', account: arm.account, driveTimeoutMs: 1_000,
        preregistration: { preregHash, config } },
      protocol: config, context, scope: scope(), loopId: 'factory-loop', hostRunId: 'factory-host-run',
      resources: { inputTokens: 64_000, outputTokens: 4096, requestsPerArm: 64,
        armIds: [], usdPerArm: arm.generationBudget.maxUsd }, pythonBin: '/offline/python',
    };
    const trial: Parameters<typeof startFrontierSweProximusAssignment>[0] = {
      arm: 'baseline', task: { ...task('t1'), benchmark: 'frontier-swe', graderMeta: { networkMode: 'allowlist' } },
      handle: { containerId: 'exact-task', instanceId: 't1', image: config.grader.images.t1 }, role: 'solver',
      teamKey: 'baseline', topic: 'repair', directive: 'Repair t1', forbidTools: [],
      attemptBudget: { maxCostUsd: arm.generationBudget.maxUsd, maxTokens: arm.generationBudget.maxTokens, maxWallMs: 1_000 },
    };
    const binding = { workspaceId, loopId: host.loopId, runId: config.runId, preregHash,
      assignmentId: `bench-assignment:${config.runId}:baseline:t1:1` };
    const order: string[] = [];
    const gateway = { agent: 'proximus' as const, accountingBinding: binding,
      gateway: { baseURL: 'http://127.0.0.1:12345', token: 'test-gateway-token' },
      stop: vi.fn(async () => { order.push('gateway-stop'); }) };
    const capture = vi.fn<FactoryPorts['capture']>(async input => {
      trialDirs.push(input.checkout.dir);
      return { captureProviderInput: vi.fn(async () => {}) };
    });
    const auth = { authenticateProvider: vi.fn(async () => null), revoke: vi.fn() };
    const controller = { startHostGateway: vi.fn(async () => gateway), startNativeGateway: vi.fn(), revoke: vi.fn() };
    const run = vi.fn<FactoryPorts['run']>(async () => ({
      status: 'completed', runtime: { schemaVersion: 1, runtimeRevision: 'b'.repeat(64), sourceRevision: PROXIMUS_SOURCE_REVISION,
        clientVersion: PROXIMUS_CLIENT_VERSION, harborVersion: '0.23.0', fileCount: 10 },
      diagnosticContext: { cost_usd: 100 }, billingStatus: 'unreconciled',
      // Structural fixture only; it has no receipt issuance identity.
      confinement: { schemaVersion: 1, source: 'confined-host-process', executionId: 'unissued-factory-fixture',
        pythonBin: host.pythonBin, maxWallClockMs: 1_000, payloadSha256: '0'.repeat(64), workerResultSha256: '0'.repeat(64),
        trialDir: '/offline/trial', gatewayBaseURL: gateway.gateway.baseURL,
        task: { containerId: trial.handle.containerId, image: trial.handle.image, network: 'none', networkMode: 'allowlist' } } }));
    const population = vi.fn<FactoryPorts['population']>(async () => {
      order.push('population'); return { status: 'unavailable', reason: 'no-attempts' };
    });
    const billing = vi.fn<FactoryPorts['billing']>(async () => {
      order.push('billing'); return { status: 'unavailable', reason: 'no-attempts' };
    });
    const ports = { capture, run, population, billing, authenticate: vi.fn(() => auth),
      controller: vi.fn<FactoryPorts['controller']>(() => controller as unknown as ReturnType<FactoryPorts['controller']>) };
    return { host, trial, ports, auth, controller, gateway, order, run, capture, population, billing };
  }
  it('issues one host execution, seals sends before accounting and retains official trajectory artifacts', async () => {
    const f = fixture(), assignment = await startFrontierSweProximusAssignment(f.trial, f.host, f.ports);
    expect(assignment).toMatchObject({ agent: 'proximus', runId: config.runId, workspaceId, armId: 'baseline', containerId: 'exact-task' });
    expect(f.controller.startNativeGateway).not.toHaveBeenCalled();
    expect(f.capture.mock.calls[0][0]).not.toHaveProperty('observation');
    expect(f.ports.controller.mock.calls[0][0]).toMatchObject({ outputTokenLimit: 64,
      armId: 'baseline', authenticateProvider: f.auth.authenticateProvider });
    const evidence = await assignment.execute();
    expect(f.run.mock.calls[0][1]).toMatchObject({ instruction: 'Repair t1', network: 'none', networkMode: 'allowlist',
      agent: 'proximus', topology: 'stock-native-reference', maxWallClockMs: 1_000, gateway: f.gateway });
    expect(f.order).toEqual(['gateway-stop', 'population', 'billing']);
    expect(f.billing.mock.calls[0][2]).toBe(f.population.mock.calls[0][1]);
    expect(evidence.billing.status).toBe('unavailable');
    expect(evidence.pricing).toEqual({ status: 'unavailable', reason: 'no-attempts' });
    await expect(assignment.execute()).rejects.toThrow(/consumed|stopped/);
    await Promise.all([assignment.stop(), assignment.stop()]);
    expect(f.gateway.stop).toHaveBeenCalledOnce();
    expect(existsSync(trialDirs[0])).toBe(true);
  });
  it('prices authenticated attempts from the detached protocol even if the caller changes its price schedule', async () => {
    const f = fixture();
    f.population.mockResolvedValue({ status: 'terminal', source: 'learning-spend-reservations', populationSha256: 'c'.repeat(64),
      attempts: [{ attemptId: 'priced-attempt', gatewayRequestId: '11111111-1111-4111-8111-111111111111:1',
        accountId: 'pinned-account', transport: 'bearer-http', bodySha256: 'a'.repeat(64),
        outcome: 'response-completed', responseStatus: 200, providerCompletion: {
          responseId: 'priced-response', model: config.arms[1].model, providerEffort: 'high',
          usage: { inputTokenBasis: 'inclusive', inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 0 } } }],
      requests: [], usageComplete: true, billingStatus: 'unreconciled',
      knownUsage: { modelCalls: 1, tokensIn: 7, tokensOut: 2, tokensCacheRead: 3, tokensCacheWrite: 0 } });
    const assignment = await startFrontierSweProximusAssignment(f.trial, f.host, f.ports);
    config.priceSchedule.rates[0].outputUsdPerMillion = 999;
    try {
      expect((await assignment.execute()).pricing).toMatchObject({ status: 'complete',
        priceTableVersion: 'frozen-prices-v1', normalizedCostUsd: 0.0000125, missingAttemptIds: [] });
    } finally { await assignment.stop(); }
  });
  it.each(['image', 'native handle', 'model', 'account', 'workspace', 'cost', 'tokens', 'wall', 'seed', 'instruction'] as const)
  ('rejects %s drift before capture or provider authority', async change => {
    const f = fixture();
    if (change === 'image') f.trial.handle.image = 'foreign-image';
    if (change === 'native handle') f.trial.handle.taskNetwork = 'native-only';
    if (change === 'model') f.host.options.model = 'other-model';
    if (change === 'account') f.host.options.account = 'auto';
    if (change === 'workspace') f.host.scope.workspaceId = 'bench-other';
    if (change === 'cost') f.trial.attemptBudget.maxCostUsd = 99;
    if (change === 'tokens') f.trial.attemptBudget.maxTokens = 99;
    if (change === 'wall') f.trial.attemptBudget.maxWallMs = 1_001;
    if (change === 'seed') f.host.options.seed = 99;
    if (change === 'instruction') f.trial.task.problemStatement = ' ';
    await expect(startFrontierSweProximusAssignment(f.trial, f.host, f.ports)).rejects.toThrow();
    expect(f.capture).not.toHaveBeenCalled(); expect(f.ports.authenticate).not.toHaveBeenCalled();
  });
  it('detaches task, protocol, interpreter and resources before awaiting capture', async () => {
    const f = fixture();
    let release!: () => void, captured!: () => void;
    const entered = new Promise<void>(resolve => { captured = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    f.capture.mockImplementationOnce(async input => { trialDirs.push(input.checkout.dir); captured(); await blocked;
      return { captureProviderInput: vi.fn(async () => {}) }; });
    const pending = startFrontierSweProximusAssignment(f.trial, f.host, f.ports);
    await entered;
    f.trial.task.problemStatement = 'foreign instruction'; f.trial.handle.containerId = 'foreign-container';
    f.host.protocol.arms[1].model = 'foreign-model'; f.host.options.account = 'foreign-account';
    f.host.pythonBin = '/foreign/python'; f.host.resources.inputTokens = 999;
    release();
    const assignment = await pending;
    await assignment.execute(); await assignment.stop();
    expect(f.run.mock.calls[0][1]).toMatchObject({ instruction: 'Repair t1', handle: { containerId: 'exact-task' },
      pythonBin: '/offline/python', account: 'pinned-account', model: 'configured-alias' });
    expect(f.ports.controller.mock.calls[0][0].resources.inputTokens).toBe(64_000);
  });
  it('revokes authentication on gateway startup failure and closes after process failure', async () => {
    const f = fixture();
    f.controller.startHostGateway.mockRejectedValueOnce(new Error('listener failed'));
    await expect(startFrontierSweProximusAssignment(f.trial, f.host, f.ports)).rejects.toThrow(/listener failed/);
    expect(f.auth.revoke).toHaveBeenCalled(); expect(f.controller.revoke).toHaveBeenCalled();
    const second = fixture(), assignment = await startFrontierSweProximusAssignment(second.trial, second.host, second.ports);
    second.run.mockRejectedValueOnce(new Error('process failed'));
    await expect(assignment.execute()).rejects.toThrow(/process failed/);
    await assignment.stop(); expect(second.gateway.stop).toHaveBeenCalledOnce();
  });
  it('cancels the executing process and waits for it before stop completes', async () => {
    const f = fixture(), parent = new AbortController(); f.host.options.signal = parent.signal;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.run.mockImplementationOnce(async (_protocol, execution) => {
      entered(); await new Promise<void>(resolve => execution.signal!.addEventListener('abort', () => resolve(), { once: true }));
      f.order.push('process-reaped'); throw new Error('aborted');
    });
    const assignment = await startFrontierSweProximusAssignment(f.trial, f.host, f.ports);
    const result = assignment.execute(); const rejection = expect(result).rejects.toThrow(/aborted/);
    await started; parent.abort(); await assignment.stop(); await rejection;
    expect(f.order).toContain('process-reaped'); expect(f.gateway.stop).toHaveBeenCalledOnce();
    await expect(assignment.execute()).rejects.toThrow(/consumed|stopped|cancelled/);
  });
  it('refuses a completed process after cancellation even when that process ignores its abort signal', async () => {
    const f = fixture(), parent = new AbortController(); f.host.options.signal = parent.signal;
    const result = await f.run(config, {} as never);
    f.run.mockImplementationOnce(async () => { parent.abort(); return result; });
    const assignment = await startFrontierSweProximusAssignment(f.trial, f.host, f.ports);
    await expect(assignment.execute()).rejects.toThrow(/cancelled|deadline/);
    await assignment.stop(); expect(f.gateway.stop).toHaveBeenCalledOnce();
  });
});

describe('current launcher owns its assignment runtime', () => {
  const deps = () => ({ scope: scope(), currentContext: context, assertEnabled: async () => {},
    loadBacklog: async () => [task('t2'), task('t1')],
    currentGeneration: { clone: async (t: BenchTask) => ({ dir: `/private/${t.instanceId}`, repo: 'fixture', baseCommit: 'a'.repeat(40), cleanup: async () => {} }),
      extractDiff: async () => 'diff --git a/a b/a' },
  });
  function proximus() {
    config.grader.family = 'frontier-swe';
    const arm = config.arms[1];
    arm.agent = 'proximus'; arm.account = config.arms[0].account = 'pinned-account';
    for (const value of config.arms) value.control = {
      topology: value.id === 'baseline' ? 'stock-native-reference' : 'solo', solverGroup: value.id,
      solverToolsHash: 'a'.repeat(64), capabilities: allCapabilities(value.id === 'baseline' ? 'off' : 'on'),
    };
    config.priceSchedule.rates[0].outputTokenCeiling = 64;
    config.grader.images = Object.fromEntries(config.taskIds.map(id => [id, `registry.example/${id}@sha256:${'f'.repeat(64)}`]));
    arm.runtime = { ...arm.runtime, sourceRevision: PROXIMUS_SOURCE_REVISION, clientVersion: PROXIMUS_CLIENT_VERSION,
      runtimeRevision: 'b'.repeat(64),
      proximus: { provider: 'openai', harborVersion: '0.23.0', maxInputTokens: 20_000, supportsVision: false } };
    const prepared = { pythonBin: '/private/venv/bin/python', runtime: { schemaVersion: 1 as const,
      sourceRevision: arm.runtime.sourceRevision, clientVersion: arm.runtime.clientVersion,
      runtimeRevision: arm.runtime.runtimeRevision, harborVersion: '0.23.0', fileCount: 42 } };
    const prepare = vi.fn(async () => {
      expect(io.register).not.toHaveBeenCalled(); expect(io.upsert).not.toHaveBeenCalled(); expect(io.task).not.toHaveBeenCalled();
      return prepared;
    });
    const loadBacklog = async () => [task('t1'), task('t2')].map(value => ({ ...value, benchmark: 'frontier-swe' }));
    return { prepared, prepare, loadBacklog, request: { ...input, arm: 'baseline', suite: 'frontier-swe' } };
  }
  function claude() {
    config.grader.family = 'frontier-swe';
    config.arms[1].agent = 'claude';
    config.arms[1].runtime.clientVersion = 'claude/2.1.293';
    config.arms[1].account = 'pinned-claude-account';
    for (const arm of config.arms) arm.control = { topology: arm.id === 'baseline' ? 'stock-native-reference' : 'solo',
      solverGroup: arm.id, solverToolsHash: 'a'.repeat(64), capabilities: allCapabilities(arm.id === 'baseline' ? 'off' : 'on') };
    return { request: { ...input, arm: 'baseline', suite: 'frontier-swe' },
      loadBacklog: async () => [task('t1'), task('t2')].map(value => ({ ...value, benchmark: 'frontier-swe' })) };
  }
  it.each(['suite', 'treatment', 'topology', 'auto-account', 'default-account', 'client-version', 'subscription'])
    ('refuses unsupported Claude %s before allocation or binary access', async scenario => {
      const f = claude(), resolveClaudeBinary = vi.fn();
      if (scenario === 'suite') f.request.suite = 'swe-bench-pro';
      if (scenario === 'treatment') { config.arms[0].agent = 'claude'; f.request.arm = 'papercusp'; }
      if (scenario === 'topology') config.arms[1].control!.topology = 'solo';
      if (scenario === 'auto-account') config.arms[1].account = 'auto';
      if (scenario === 'default-account') config.arms[1].account = 'default';
      if (scenario === 'client-version') config.arms[1].runtime.clientVersion = 'unfrozen';
      if (scenario === 'subscription') for (const arm of config.arms) arm.payer = 'subscription';
      await expect(launchBenchRun(f.request, { ...deps(), loadBacklog: f.loadBacklog,
        currentNative: { resolveClaudeBinary } })).rejects.toThrow();
      expect(resolveClaudeBinary).not.toHaveBeenCalled(); expect(io.register).not.toHaveBeenCalled();
      expect(io.upsert).not.toHaveBeenCalled(); expect(io.task).not.toHaveBeenCalled();
    });
  it('refuses unavailable Claude bytes before durable allocation', async () => {
    const f = claude();
    await expect(launchBenchRun(f.request, { ...deps(), loadBacklog: f.loadBacklog,
      currentNative: { resolveClaudeBinary: () => { throw new Error('missing native binary'); } } })).rejects.toThrow('missing native binary');
    expect(io.register).not.toHaveBeenCalled(); expect(io.upsert).not.toHaveBeenCalled(); expect(io.task).not.toHaveBeenCalled();
  });
  it('binds pinned Claude bytes, stock assignment and evidence without a Codex fallback', async () => {
    const f = claude(), root = mkdtempSync(join(tmpdir(), 'claude-selector-'));
    const binary = join(root, 'claude'), bytes = 'private fixture bytes; never executed';
    writeFileSync(binary, bytes, { mode: 0o700 });
    const stop = vi.fn(async () => {});
    const start = vi.fn<NonNullable<NonNullable<NonNullable<Parameters<typeof launchBenchRun>[1]>['currentNative']>['start']>>(
      async (_trial, host) => ({ options: host.options,
        observations: { admit: async () => ({ admitted: false, receiptRef: 'fixture:no-launch' }), observeIdentity: async () => null },
        checkout: { dir: '/private/observer', repo: 'fixture', baseCommit: 'a'.repeat(40), cleanup: async () => {} },
        readModelCalls: async () => 0, stop }));
    const currentFrontierArm: NonNullable<Parameters<typeof launchBenchRun>[1]>['currentFrontierArm'] = vi.fn(async req => {
      expect(req.launch.execution).toBe('claude-native');
      expect(req.launch.seam).toEqual({ inContainerClaude: { claudeBinary: realpathSync(binary), version: '2.1.293',
        sha256: createHash('sha256').update(bytes).digest('hex') } });
      expect(io.register).toHaveBeenCalledOnce();
      const assignment = await req.launch.startAssignment({ task: req.backlog![0] } as never);
      await assignment.stop();
      await req.onResult!({ runId: req.runId, suite: 'frontier-swe', modality: 'in-container', taskId: 't1',
        arm: 'baseline', seed: 3, resolved: false, score: 0.5, graderStatus: 'failed', graderFamily: 'frontier-swe',
        graderVersion: config.grader.version, tokensIn: 10, tokensOut: 20, tokensTotal: 30, costUsd: 0.001,
        priceTableVersion: config.priceSchedule.version, wallClockMs: 100, turns: 2, budgetTokens: null,
        capped: false, generationStatus: 'completed', generationError: null,
        armMeta: { nativeUsage: { stopReason: 'done', tokensCacheRead: 5, tokensCacheWrite: 7 } },
        modelId: config.arms[1].model, harnessVersion: config.arms[1].runtime.sourceRevision,
        preregHash: input.current!.preregHash, rolloutId: req.runId });
      return { arm: req.spec.arm, runId: req.runId, startedAtMs: 0, finishedAtMs: 1, rows: [], modelCallsSpent: 0,
        tokensSpent: 0, costUsdSpent: 0, accountingUnknown: false, budgetExhausted: false, attemptedTaskIds: ['t1'], skippedTaskIds: ['t2'] };
    });
    try {
      expect(currentBenchLaunchSelection(f.request, config).arm.agent).toBe('claude');
      await (await launchBenchRun(f.request, { ...deps(), loadBacklog: f.loadBacklog,
        currentNative: { resolveClaudeBinary: () => binary, start }, currentFrontierArm })).done;
      expect(start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        options: expect.objectContaining({ agent: 'claude', account: 'pinned-claude-account' }) }));
      expect(stop).toHaveBeenCalledOnce();
      expect(io.emit.mock.calls[0][0].generation).toMatchObject({ trajectoryKind: 'native-claude', tokensCacheRead: 5, tokensCacheWrite: 7 });
      expect(io.snapshot.mock.calls[0][0].result.taskResults[0].attempt.blueprintId).toBe('native-claude');
      expect(io.legacyRun).not.toHaveBeenCalled(); expect(io.legacyBind).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['sourceRevision', 'clientVersion', 'runtimeRevision', 'harborVersion'] as const)
    ('refuses a Proximus %s mismatch before durable allocations', async field => {
      const f = proximus(); f.prepared.runtime[field] = 'different';
      await expect(launchBenchRun(f.request, { ...deps(), loadBacklog: f.loadBacklog,
        currentProximus: { prepare: f.prepare } })).rejects.toThrow(/prepared runtime/);
      expect(io.register).not.toHaveBeenCalled(); expect(io.upsert).not.toHaveBeenCalled(); expect(io.task).not.toHaveBeenCalled();
    });
  it('propagates Proximus preparation failure before creating a run', async () => {
    const f = proximus(); f.prepare.mockRejectedValueOnce(new Error('installation failed'));
    await expect(launchBenchRun(f.request, { ...deps(), loadBacklog: f.loadBacklog,
      currentProximus: { prepare: f.prepare } })).rejects.toThrow('installation failed');
    expect(io.register).not.toHaveBeenCalled(); expect(io.upsert).not.toHaveBeenCalled(); expect(io.task).not.toHaveBeenCalled();
  });
  it('limits the Proximus selector to the frozen FrontierSWE baseline', () => {
    const f = proximus();
    expect(currentBenchLaunchSelection(f.request, config).arm.agent).toBe('proximus');
    expect(() => currentBenchLaunchSelection({ ...f.request, suite: 'swe-bench-pro' }, config)).toThrow(/execution/);
    config.arms[0].agent = 'proximus'; config.arms[0].runtime = { ...config.arms[1].runtime };
    expect(() => currentBenchLaunchSelection({ ...f.request, arm: 'papercusp' }, config)).toThrow();
  });
  it('binds the prepared host interpreter and records Proximus usage without native identity', async () => {
    const f = proximus(), stop = vi.fn(async () => {});
    const start = vi.fn(async () => ({ agent: 'proximus' as const, runId: config.runId, armId: 'baseline' as const,
      workspaceId, taskId: 't1', containerId: 'task-container', image: 'frozen-image', execute: vi.fn(), stop }));
    const currentFrontierArm: NonNullable<Parameters<typeof launchBenchRun>[1]>['currentFrontierArm'] = vi.fn(async req => {
      expect(req.launch.execution).toBe('proximus-host');
      expect(req.launch).not.toHaveProperty('mcpOrigin'); expect(req.launch).not.toHaveProperty('hookRecordDir');
      const assignment = await req.launch.startAssignment({ task: req.backlog![0] } as never);
      await assignment.stop();
      await req.onResult!({ runId: req.runId, suite: 'frontier-swe', modality: 'in-container', taskId: 't1',
        arm: 'baseline', seed: 3, resolved: false, score: 0.5, graderStatus: 'failed', graderFamily: 'frontier-swe',
        graderVersion: config.grader.version, tokensIn: 10, tokensOut: 20, tokensTotal: 30, costUsd: 0.001,
        priceTableVersion: config.priceSchedule.version, wallClockMs: 100, turns: 2, budgetTokens: null,
        capped: false, generationStatus: 'completed', generationError: null,
        armMeta: { hostReference: { attempts: { knownUsage: { tokensCacheRead: 5, tokensCacheWrite: 7 } } } },
        modelId: config.arms[1].model, harnessVersion: config.arms[1].runtime.sourceRevision,
        preregHash: input.current!.preregHash, rolloutId: req.runId });
      return { arm: req.spec.arm, runId: req.runId, startedAtMs: 0, finishedAtMs: 1, rows: [], modelCallsSpent: 0,
        tokensSpent: 0, costUsdSpent: 0, accountingUnknown: false, budgetExhausted: false, attemptedTaskIds: ['t1'], skippedTaskIds: ['t2'] };
    });
    await (await launchBenchRun(f.request, { ...deps(), loadBacklog: f.loadBacklog,
      currentProximus: { prepare: f.prepare, start }, currentFrontierArm })).done;
    expect(f.prepare).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      pythonBin: f.prepared.pythonBin, options: expect.objectContaining({ agent: 'proximus', account: 'pinned-account' }),
    }));
    expect(stop).toHaveBeenCalledOnce();
    expect(io.emit.mock.calls[0][0].generation).toMatchObject({ trajectoryKind: 'proximus-host', tokensCacheRead: 5, tokensCacheWrite: 7 });
    expect(io.legacyRun).not.toHaveBeenCalled(); expect(io.legacyBind).not.toHaveBeenCalled();
  });
  it('routes FrontierSWE v2 through the current container arm and persists its graded native evidence', async () => {
    config.grader.family = 'frontier-swe';
    const currentTask = vi.fn();
    const generation = { clone: vi.fn(), extractDiff: vi.fn() };
    const loadBacklog = vi.fn(async () => [task('t1'), task('t2')].map(value => ({ ...value, benchmark: 'frontier-swe' })));
    const currentFrontierArm: NonNullable<Parameters<typeof launchBenchRun>[1]>['currentFrontierArm'] = vi.fn(async req => {
      for (const value of req.backlog!) await req.onResult!({ runId: req.runId, suite: 'frontier-swe',
        modality: 'in-container', taskId: value.instanceId, arm: 'papercusp', seed: 3,
        resolved: false, score: 0.5, graderStatus: 'failed', graderFamily: 'frontier-swe', graderVersion: config.grader.version,
        tokensIn: 10, tokensOut: 20, tokensTotal: 30, costUsd: 0.001, priceTableVersion: config.priceSchedule.version,
        wallClockMs: 100, turns: 2, budgetTokens: null, capped: false, generationStatus: 'completed', generationError: null,
        armMeta: { executionPath: 'modernization-launch-adapter', nativeUsage: { stopReason: 'done', tokensCacheRead: 5 },
          currentExecution: { protocolIdentity: { status: 'matched' } } },
        modelId: config.arms[0].model, harnessVersion: config.arms[0].runtime.sourceRevision,
        preregHash: input.current!.preregHash, rolloutId: 'fixture-rollout', createdAt: new Date().toISOString() });
      return { arm: 'papercusp', runId: req.runId, startedAtMs: 0, finishedAtMs: 100, rows: [],
        modelCallsSpent: 2, tokensSpent: 60, costUsdSpent: 0.002, accountingUnknown: false, budgetExhausted: false,
        attemptedTaskIds: ['t1', 't2'], skippedTaskIds: [] };
    });
    await (await launchBenchRun({ ...input, suite: 'frontier-swe' }, { ...deps(), loadBacklog,
      currentTask, currentGeneration: generation, currentFrontierArm })).done;
    expect(loadBacklog).toHaveBeenCalledWith('frontier-swe-v2-custom', ['t1', 't2']);
    expect(currentTask).not.toHaveBeenCalled(); expect(generation.clone).not.toHaveBeenCalled();
    expect(io.legacyRun).not.toHaveBeenCalled(); expect(io.legacyBind).not.toHaveBeenCalled();
    expect(io.emit).toHaveBeenCalledTimes(2);
    expect(io.emit.mock.calls[0][0]).toMatchObject({ runId: config.runId, modality: 'in-container',
      generation: { tokensCacheRead: 5, armMeta: { executionPath: 'modernization-launch-adapter' } },
      grading: { score: 0.5, status: 'failed', family: 'frontier-swe' } });
    expect(io.task.mock.calls.some(([, row]) => row.taskStatus === 'graded' && row.resolved === false)).toBe(true);
  });
  it('routes the bound FrontierSWE stock reference through the current container arm without a legacy launch', async () => {
    config.grader.family = 'frontier-swe';
    const currentFrontierArm: NonNullable<Parameters<typeof launchBenchRun>[1]>['currentFrontierArm'] = vi.fn(async req => ({
      arm: req.spec.arm, runId: req.runId, startedAtMs: 0, finishedAtMs: 1, rows: [], modelCallsSpent: 0,
      tokensSpent: 0, costUsdSpent: 0, accountingUnknown: false, budgetExhausted: false, attemptedTaskIds: [], skippedTaskIds: ['t1', 't2'],
    }));
    const loadBacklog = async () => [task('t1'), task('t2')].map(value => ({ ...value, benchmark: 'frontier-swe' }));
    await (await launchBenchRun({ ...input, arm: 'baseline', suite: 'frontier-swe' },
      { ...deps(), loadBacklog, currentFrontierArm })).done;
    expect(currentFrontierArm).toHaveBeenCalledWith(expect.objectContaining({
      spec: expect.objectContaining({ arm: 'baseline' }), launch: expect.objectContaining({ protocolRunId: config.runId }),
    }));
    expect(io.upsert).toHaveBeenCalled(); expect(io.legacyRun).not.toHaveBeenCalled(); expect(io.legacyBind).not.toHaveBeenCalled();
  });
  it('passes native-codex to the stock assignment driver and never binds a Queen', async () => {
    const requests: string[] = [];
    const stock: BenchHarnessDriver = { spinRunAndCost: async req => { requests.push(req.blueprintId); return driver.spinRunAndCost(req); } };
    const stop = vi.fn(async () => {});
    const currentTask = vi.fn(async (_input: CurrentTaskInput) => ({ driver: stock, stop }));
    await (await launchBenchRun({ ...input, arm: 'baseline' }, { ...deps(), currentTask })).done;
    expect(requests).toEqual(['native-codex', 'native-codex']);
    expect(currentTask.mock.calls.every(([i]) => i.options.armId === 'baseline')).toBe(true);
    expect(io.legacyBind).not.toHaveBeenCalled(); expect(io.legacyRun).not.toHaveBeenCalled();
  });
  it('refuses a native-CLI reference on a different model before any durable write or launch (FSWE-P018-SAMEMODEL)', async () => {
    config.arms[1].model = 'other-model';
    config.priceSchedule.rates.push({ ...config.priceSchedule.rates[0], model: 'other-model' });
    const currentTask = vi.fn();
    await expect(launchBenchRun({ ...input, arm: 'baseline' }, { ...deps(), currentTask })).rejects.toThrow(/native-CLI reference/);
    expect(io.committed).not.toHaveBeenCalled(); expect(io.upsert).not.toHaveBeenCalled(); expect(currentTask).not.toHaveBeenCalled();
  });
  it('runs the exact seed/task controls, persists assignments, and shares one lifetime budget across the full study', async () => {
    const stop = vi.fn(async () => {}), currentTask = vi.fn(async (_input: CurrentTaskInput) => ({ driver, stop }));
    const launched = await launchBenchRun(input, { ...deps(), currentTask });
    await launched.done;
    expect(currentTask.mock.calls.map(([i]) => i.task.instanceId)).toEqual(['t1', 't2']);
    for (const [i] of currentTask.mock.calls) {
      expect(i.context).toBe(context);
      expect(i.options).toMatchObject({ runId: config.runId, armId: 'papercusp', seed: 3, model: 'configured-alias', effort: 'high', account: 'auto' });
      expect(i.resources.armIds).toHaveLength(12);
      expect(i.resources).toMatchObject({ usdPerArm: 3, maxOpenUsd: 3 });
    }
    expect(io.register.mock.calls[0][1]).toMatchObject({ ifMissing: true, budgetKind: 'lifetime', budgetUsd: 60 });
    expect(io.task.mock.calls.filter(([_, row]) => row.taskStatus === 'todo')).toHaveLength(2);
    expect(io.task.mock.calls.filter(([_, row]) => row.taskStatus === 'collected')).toHaveLength(2);
    expect(io.snapshot.mock.calls[0][0].result.seed).toBe(3);
    expect(io.completion).toHaveBeenCalled(); expect(stop).toHaveBeenCalledTimes(2);
    expect(io.legacyRun).not.toHaveBeenCalled(); expect(io.legacyBind).not.toHaveBeenCalled();
  });
  it('allocates the host with the actual clone and stops it before checkout cleanup', async () => {
    const order: string[] = [];
    const generation = { clone: async (t: BenchTask) => {
      order.push(`clone:${t.instanceId}`);
      return { dir: `/allocated/${t.instanceId}`, repo: 'fixture', baseCommit: 'a'.repeat(40),
        cleanup: async () => { order.push(`cleanup:${t.instanceId}`); } };
    }, extractDiff: async () => 'diff' };
    const currentTask = vi.fn(async (i: CurrentTaskInput) => {
      expect(i.checkout.dir).toBe(`/allocated/${i.task.instanceId}`);
      expect(i.hostRunId).toMatch(/^current-/);
      order.push(`host:${i.task.instanceId}`);
      return { driver, stop: async () => { order.push(`stop:${i.task.instanceId}`); } };
    });
    await (await launchBenchRun(input, { ...deps(), currentGeneration: generation, currentTask })).done;
    expect(order).toEqual(['clone:t1', 'host:t1', 'stop:t1', 'cleanup:t1',
      'clone:t2', 'host:t2', 'stop:t2', 'cleanup:t2']);
  });
  it('creates no gateway when cloning fails and retires a host whose driver fails', async () => {
    const currentTask = vi.fn(async () => ({ driver: { spinRunAndCost: async () => { throw new Error('driver fault'); } },
      stop: vi.fn(async () => {}) }));
    await (await launchBenchRun(input, { ...deps(), currentTask,
      currentGeneration: { ...deps().currentGeneration, clone: async () => { throw new Error('clone fault'); } } })).done;
    expect(currentTask).not.toHaveBeenCalled();
    _resetActiveRunsForTests();
    await (await launchBenchRun(input, { ...deps(), currentTask })).done;
    expect(currentTask).toHaveBeenCalledTimes(2);
    for (const result of currentTask.mock.results) expect((await result.value).stop).toHaveBeenCalledOnce();
  });
  it('rejects missing authentication and uncommitted protocols before creating a run or gateway', async () => {
    const currentTask = vi.fn();
    await expect(launchBenchRun(input, { ...deps(), currentContext: undefined, currentTask })).rejects.toThrow(/authenticated/);
    io.committed.mockRejectedValueOnce(new Error('not committed'));
    await expect(launchBenchRun(input, { ...deps(), currentTask })).rejects.toThrow(/not committed/);
    expect(io.upsert).not.toHaveBeenCalled(); expect(currentTask).not.toHaveBeenCalled();
  });
  it('does not launch or reset spend when an existing governor policy differs', async () => {
    io.register.mockImplementationOnce(async (_sql, value) => ({ ...value, budgetUsd: 61 }));
    const currentTask = vi.fn();
    await expect(launchBenchRun(input, { ...deps(), currentTask })).rejects.toThrow(/governor registration/);
    expect(io.upsert).not.toHaveBeenCalled(); expect(currentTask).not.toHaveBeenCalled();
  });
  it('does not launch a duplicate durable arm/seed attempt', async () => {
    // Distinguish the duplicate lookup from the multiline active-run census.
    sql.mockImplementation(async strings => String(strings[0]).includes('SELECT id FROM harness_shared.bench_runs WHERE') ? [{ id: 'existing' }] : []);
    const currentTask = vi.fn();
    await expect(launchBenchRun(input, { ...deps(), currentTask })).rejects.toThrow(/already has a durable attempt/);
    expect(currentTask).not.toHaveBeenCalled(); expect(io.upsert).not.toHaveBeenCalled();
  });
  it('stops a current gateway on cancellation and does not start the next assignment', async () => {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const stop = vi.fn(async () => { release(); });
    const owned: BenchHarnessDriver = { spinRunAndCost: async req => { entered(); await blocked; return driver.spinRunAndCost(req); } };
    const currentTask = vi.fn(async (_input: CurrentTaskInput) => ({ driver: owned, stop }));
    const launched = await launchBenchRun(input, { ...deps(), currentTask });
    await started;
    sql.mockResolvedValue([{ status: 'running', pot_slug: null, config: null }]);
    await cancelBenchRun(launched.runId, { scope: scope() });
    await launched.done;
    expect(currentTask).toHaveBeenCalledTimes(1);
    expect(currentTask.mock.calls[0][0].options.signal?.aborted).toBe(true);
    expect(stop).toHaveBeenCalled(); expect(io.completion).not.toHaveBeenCalled();
  });
  it('refuses a current treatment without its frozen protocol rather than selecting the old Queen', async () => {
    await expect(launchBenchRun({ arm: 'papercusp', taskSetId: 'custom' }, deps())).rejects.toThrow(/frozen protocol/);
    expect(io.legacyRun).not.toHaveBeenCalled(); expect(io.legacyBind).not.toHaveBeenCalled();
  });
});
