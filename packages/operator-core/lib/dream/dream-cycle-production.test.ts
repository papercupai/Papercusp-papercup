import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FLAGS } from '@papercusp/flags';
import type { DreamCycleDeps, DreamCycleInput } from './dream-cycle';
import { productionDreamCycle } from './dream-cycle-action';
import { getCurrentCapabilityManifest } from './capability-catalog';

const h = vi.hoisted(() => ({
  run: vi.fn(),
  sql: vi.fn(),
  registry: vi.fn(),
  packet: vi.fn(),
  sources: vi.fn(),
  sink: vi.fn(),
  begin: vi.fn(),
  select: vi.fn(),
  settle: vi.fn(),
  review: vi.fn(),
  finish: vi.fn(),
  history: vi.fn(),
  preflight: vi.fn(),
  admit: vi.fn(),
  spend: vi.fn(),
  flag: vi.fn(),
  idle: vi.fn(),
  notify: vi.fn(),
  llm: vi.fn(),
  problems: vi.fn(),
}));
vi.mock('@dbos-inc/dbos-sdk', () => ({ DBOS: { workflowID: 'workflow-stable' } }));
vi.mock('@papercusp/db-org', async (original) => ({ ...(await original<object>()), getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: h.flag }));
vi.mock('../owner-steering', () => ({ idleActivityAllowed: h.idle }));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: h.notify }));
vi.mock('../scout/cadence-signals', () => ({ readHiveIdleRatio: vi.fn() }));
vi.mock('../llm-testing/llm-client', () => ({ llmCall: h.llm }));
vi.mock('../harness-registry', async (original) => ({
  ...(await original<object>()),
  loadHarnessRegistry: h.registry,
}));
vi.mock('./dream-cycle', () => ({ runDreamCycle: h.run }));
vi.mock('./capability-packets', () => ({ buildCapabilityPacket: h.packet }));
vi.mock('./capability-review-sources', () => ({ buildCapabilityReviewSources: h.sources }));
vi.mock('./dream-sink', () => ({ sinkDreamInsight: h.sink }));
vi.mock('./dream-sources', () => ({ readDreamProblemContext: h.problems }));
vi.mock('./dream-governor', () => ({
  preflightDreamCycle: h.preflight,
  admitDreamRunCall: h.admit,
  recordDreamRunSpend: h.spend,
}));
vi.mock('./dream-run-store', () => ({
  beginDreamRun: h.begin,
  recordDreamRunSelection: h.select,
  settleDreamRunCall: h.settle,
  recordDreamRunReview: h.review,
  finalizeDreamRun: h.finish,
  listDreamRuns: h.history,
}));

const ctx = { workspaceId: 'ws-production-test', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: null };
beforeEach(() => {
  vi.clearAllMocks();
  h.registry.mockResolvedValue({
    projects: [{ slug: 'papercusp', path: '/registered/repository', self_repo: true, harness_kind: 'hive' }],
  });
  h.flag.mockImplementation(async (flag) => flag === FLAGS.DREAM_CYCLE);
  h.sql.mockResolvedValue([{ active: true }]);
  h.idle.mockResolvedValue(true);
  h.packet.mockResolvedValue({ status: 'unavailable', reason: 'No fixture source', costUsd: 0, durationMs: 0 });
  h.run.mockResolvedValue({ reason: 'completed', cycleId: 'workflow-stable', attempts: 0, accepted: 0, costUsd: 0 });
});
function captured() {
  const [input, deps] = h.run.mock.calls[0]! as [DreamCycleInput, DreamCycleDeps];
  return { input, deps };
}

it('preserves the cycle call identity through the real production transport wrapper', async () => {
  await productionDreamCycle(ctx, { mode: 'manual' });
  const call = {
    model: 'test',
    messages: [],
    ownerId: 'system:dream:run:review',
    retryDeadlineMs: 123456,
    signal: new AbortController().signal,
  };
  await captured().deps.llmCall(call);
  expect(h.llm).toHaveBeenCalledExactlyOnceWith({
    ...call,
    priority: 'scout',
    harnessSlug: ctx.installSlug,
  });
});

describe('production capability Dream adapter', () => {
  it('binds observed-problem loading to the real cycle workspace/pot and retains the open control', async () => {
    await productionDreamCycle(ctx, { mode: 'manual', problemMode: 'open-exploration' });
    expect(captured().input.problemMode).toBe('open-exploration');
    await captured().deps.loadProblems!();
    expect(h.problems).toHaveBeenCalledWith({ workspaceId: ctx.workspaceId, potSlug: ctx.installSlug, repositoryId: ctx.installSlug });
  });
  it('records a refused cycle with no attempts and pushes the control snapshot', async () => {
    h.run.mockResolvedValue({ reason: 'governor-refused', cycleId: 'workflow-stable', attempts: 0, accepted: 0, costUsd: 0 });
    await productionDreamCycle(ctx, { mode: 'manual' });
    const write = h.sql.mock.calls.find((call) => call[0].join('').includes('dreamLastCycle'));
    expect(write).toBeDefined();
    expect(JSON.parse(write![1])).toMatchObject({ reason: 'governor-refused', attempts: 0, running: 0, mode: 'manual' });
    expect(write!.slice(2)).toEqual([ctx.workspaceId, ctx.installSlug, 'dream-cycle-manual']);
    expect(h.notify).toHaveBeenCalledWith('learning.dream');
    h.notify.mockClear();
    await captured().deps.recordSelection({ runId: 'r', pair: {} as never, dreamerModel: 'm', reviewerModel: 'r' } as never);
    expect(h.notify).toHaveBeenCalledWith('learning.dream');
  });
  it('binds the registered repository, stable workflow identity and scoped persistent adapters', async () => {
    await productionDreamCycle(ctx, { mode: 'manual' });
    const { input } = captured();
    expect(h.registry).toHaveBeenCalledWith(ctx.workspaceId);
    expect(input).toMatchObject({ workspaceId: ctx.workspaceId, potSlug: ctx.installSlug, cycleId: 'workflow-stable' });
    expect(captured().deps.exclusiveReplay).toBe(true);
    expect(input.manifest).toEqual(getCurrentCapabilityManifest());
  });

  it('loads only the capability manifest and preserves scope across every write', async () => {
    await productionDreamCycle(ctx, { mode: 'manual' });
    const { input, deps } = captured();
    expect(input).toMatchObject({
      workspaceId: ctx.workspaceId,
      potSlug: ctx.installSlug,
      rootPath: '/registered/repository',
      repositoryId: ctx.installSlug,
      cycleId: 'workflow-stable',
    });
    await deps.loadPackets(new AbortController().signal);
    expect(h.packet).toHaveBeenCalledTimes(input.manifest.units.length);
    expect(h.packet).toHaveBeenCalledWith(
      expect.objectContaining({
        rootPath: '/registered/repository',
        scope: { workspaceId: ctx.workspaceId, potSlug: ctx.installSlug, repositoryId: ctx.installSlug },
      }),
    );
    const call = { callId: 'generation', phase: 'generation' as const, model: 'test', reservedUsd: 0.1 };
    await deps.beginCall({ runId: 'run', call });
    expect(h.admit).toHaveBeenCalledWith(
      h.sql,
      expect.objectContaining({ workspaceId: ctx.workspaceId, potSlug: ctx.installSlug, runId: 'run', call }),
    );
    await deps.sink('run', []);
    expect(h.sink).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'capability',
        sql: h.sql,
        workspaceId: ctx.workspaceId,
        dreamRunId: 'run',
        rootPath: '/registered/repository',
      }),
    );
  });

  it('manual pause and feature disable stop subsequent phases; auto also rechecks the separate owner toggle', async () => {
    await productionDreamCycle(ctx, { mode: 'manual' });
    const manual = captured().deps;
    expect(await manual.canContinue!()).toBe(true);
    expect(h.idle).not.toHaveBeenCalled();
    h.sql.mockResolvedValue([{ active: false }]);
    expect(await manual.canContinue!()).toBe(false);
    h.sql.mockResolvedValue([{ active: true }]);
    h.flag.mockResolvedValue(false);
    expect(await manual.canContinue!()).toBe(false);
    h.flag.mockImplementation(async (flag) => flag === FLAGS.DREAM_CYCLE);
    h.run.mockClear();
    await productionDreamCycle(ctx, { mode: 'auto' });
    h.idle.mockResolvedValue(false);
    expect(await captured().deps.canContinue!()).toBe(false);
    expect(h.idle).toHaveBeenCalledWith(ctx.workspaceId, 'dream', ctx.installSlug, undefined, expect.any(Function));
    const queries = h.sql.mock.calls.map((c) => c.slice(1));
    expect(queries).toContainEqual([ctx.workspaceId, ctx.installSlug, 'dream-cycle-manual']);
    expect(queries).toContainEqual([ctx.workspaceId, ctx.installSlug, 'dream-cycle-auto']);
  });

  it('does not fall back to process.cwd when the requested repository is unregistered', async () => {
    h.registry.mockResolvedValue({ projects: [] });
    await expect(productionDreamCycle(ctx, { mode: 'manual' })).rejects.toThrow('registered repository');
    expect(h.run).not.toHaveBeenCalled();
  });
  it('observes the actual production governor verdict and repeated pause decisions', async () => {
    const observeAdmission = vi.fn();
    await productionDreamCycle(ctx, { mode: 'manual' }, { observeAdmission });
    h.preflight.mockResolvedValue({ allow: false, reason: 'governor-error', loopId: 'dream:papercusp',
      cycleRemainingUsd: null, rollingSpentUsd: 0, rollingRemainingUsd: 5, rollingLoopCount: 0 });
    expect((await captured().deps.preflight()).allow).toBe(false);
    expect(observeAdmission).toHaveBeenCalledWith(expect.objectContaining({ gate: 'governor', status: 'unknown',
      inputs: expect.objectContaining({ source: 'dream-governor:preflightDreamCycle', reason: 'governor-error' }) }));
    expect(await captured().deps.canContinue!()).toBe(true);
    h.sql.mockResolvedValue([{ active: false }]);
    expect(await captured().deps.canContinue!()).toBe(false);
    expect(observeAdmission).toHaveBeenLastCalledWith({ gate: 'continue', status: 'refused', inputs: { reason: 'routine-inactive', rows: [{ active: false }] } });
  });
});
