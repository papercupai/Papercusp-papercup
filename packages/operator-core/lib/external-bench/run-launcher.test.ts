/** Host-launch behavior without provider calls. SQL/clone/native IO are substituted;
 * the production selector, assignment loop, cancellation and persistence ordering run. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import type { BenchHarnessDriver } from './run-loop';
import type { BenchTask } from './types';
import { currentProtocolFixture } from './reproducibility/_protocol-test-fixture';

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

describe('current launcher owns its assignment runtime', () => {
  const deps = () => ({ scope: scope(), currentContext: context, assertEnabled: async () => {},
    loadBacklog: async () => [task('t2'), task('t1')],
    currentGeneration: { clone: async (t: BenchTask) => ({ dir: `/private/${t.instanceId}`, repo: 'fixture', baseCommit: 'a'.repeat(40), cleanup: async () => {} }),
      extractDiff: async () => 'diff --git a/a b/a' },
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
        modelCallsSpent: 2, tokensSpent: 60, costUsdSpent: 0.002, budgetExhausted: false,
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
      tokensSpent: 0, costUsdSpent: 0, budgetExhausted: false, attemptedTaskIds: [], skippedTaskIds: ['t1', 't2'],
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
