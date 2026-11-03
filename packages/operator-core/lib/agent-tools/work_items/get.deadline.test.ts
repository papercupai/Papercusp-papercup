/**
 * work_items:get — bounded read deadline (EI-22462490203993359).
 *
 * A pool-stalled base read must return a keyed, retryable timeout result before
 * the MCP request deadline. It must never be rendered as not-found, because
 * that would invite a caller to act on an item whose read never completed.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DbCallDeadlineError } from '@papercusp/db-org';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { WorkItemIdAmbiguousError } from '../../work-items-physical-row';
import { runToolOrchestration } from '@papercusp/agent-mcp';
import type { ProjectedTool } from '@papercusp/tooldef';
import { bindCurrentCallerDispatch } from '../orchestration/current-caller-dispatch';
import { applyNestedProjection } from '../../result-projection';

const getWorkItem = vi.fn();
const getWorkItemsByIds = vi.fn();
const getWorkItemDetail = vi.fn();
const getWorkItemThreadWindow = vi.fn();
const getWorkItemCheckpointWithMeta = vi.fn();
const getWorkItemCheckpointFreshness = vi.fn();
const readChangeKinds = vi.fn();
const listSpecEvidence = vi.fn();
const getClaimTimePriorWorkHint = vi.fn();
const planItemLaneBlockReason = vi.fn();
const planItemClaimCollision = vi.fn();
const planItemTextDriftForWorkItem = vi.fn();
const readCorroborationSummary = vi.fn();

vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-items')>()),
  getWorkItem: (...args: unknown[]) => getWorkItem(...args),
  getWorkItemsByIds: (...args: unknown[]) => getWorkItemsByIds(...args),
  getWorkItemDetail: (...args: unknown[]) => getWorkItemDetail(...args),
  getWorkItemThreadWindow: (...args: unknown[]) => getWorkItemThreadWindow(...args),
  SETTLED_WORK_ITEM_STATES: ['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped'],
}));

vi.mock('../../work-item-checkpoint', () => ({
  getWorkItemCheckpointWithMeta: (...args: unknown[]) => getWorkItemCheckpointWithMeta(...args),
  getWorkItemCheckpointFreshness: (...args: unknown[]) => getWorkItemCheckpointFreshness(...args),
}));

vi.mock('../../work-item-change-kinds', () => ({
  readChangeKinds: (...args: unknown[]) => readChangeKinds(...args),
}));

vi.mock('../../work-item-prior-work', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-item-prior-work')>()),
  getClaimTimePriorWorkHint: (...args: unknown[]) => getClaimTimePriorWorkHint(...args),
}));

vi.mock('../../scheduler/plan-item-lane-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/plan-item-lane-guard')>()),
  planItemLaneBlockReason: (...args: unknown[]) => planItemLaneBlockReason(...args),
}));

vi.mock('../../scheduler/plan-item-claim-collision', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/plan-item-claim-collision')>()),
  planItemClaimCollision: (...args: unknown[]) => planItemClaimCollision(...args),
}));

vi.mock('../../plan-items/text-drift-report', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../plan-items/text-drift-report')>()),
  planItemTextDriftForWorkItem: (...args: unknown[]) => planItemTextDriftForWorkItem(...args),
}));

vi.mock('../../harness/improvements/corroboration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness/improvements/corroboration')>()),
  readCorroborationSummary: (...args: unknown[]) => readCorroborationSummary(...args),
}));

vi.mock('../plans/spec-evidence-store', async (original) => ({
  ...(await original<typeof import('../plans/spec-evidence-store')>()),
  listSpecEvidence: (...args: unknown[]) => listSpecEvidence(...args),
}));

import get, { WORK_ITEMS_GET_BUDGET_MS, WORK_ITEMS_GET_MAX_CONCURRENCY, workItemsGetSourceReadOptions } from './get';
import { projectWorkItemOperationalBrief } from '../../operational-brief/work-item-brief';

type Out = { data: { results: Array<Record<string, unknown>> } };
const ctx = { uiClientId: 'su-deadline-test', workspaceId: 'default' };

describe('work_items:get bounded read deadline (EI-22462490203993359)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // operationalBrief requests a complete source row and therefore reads the checkpoint.
    // clearAllMocks preserves implementations, so reset the hanging implementation from
    // the timeout case before the next test exercises that complete-read path.
    getWorkItemCheckpointWithMeta.mockResolvedValue({
      checkpoint: null,
      updatedAtMs: null,
      checkpointChecks: null,
      checkpointBody: null,
      checkpointContentHash: null,
      latestUpdate: undefined,
      subjectFingerprint: undefined,
      readFailed: false,
    });
    readChangeKinds.mockResolvedValue(new Map());
    getClaimTimePriorWorkHint.mockResolvedValue(null);
    planItemLaneBlockReason.mockResolvedValue(null);
    planItemClaimCollision.mockResolvedValue(null);
    planItemTextDriftForWorkItem.mockResolvedValue(null);
    readCorroborationSummary.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps completion proof in nested A/B/C reads regardless of the outer code:run pick', async () => {
    vi.useRealTimers();
    const evidence = { summary: 'unchanged stored completion proof' };
    const stored = {
      id: 'WI-nested-proof', kind: 'feature', family: 'feature', harness: 'papercusp',
      state: 'done', title: 'Nested proof', updatedAt: '2026-10-25T02:07:54.505Z',
      payload: { _completionEvidence: evidence }, terminalCompletionEvidence: evidence,
    };
    const read = (_id: string, _harness?: string, options?: { payloadProjection?: string }) => ({
      ...stored,
      ...(options?.payloadProjection === 'none'
        ? { payload: null, terminalCompletionEvidence: undefined }
        : {}),
    });
    getWorkItem.mockImplementation(async (...args) => read(...args as [string]));
    getWorkItemsByIds.mockImplementation(async (ids: string[], harness?: string, options?: { payloadProjection?: string }) =>
      ids.map(id => read(id, harness, options)));
    const parentProjection = { pick: ['ok', 'summary', 'childFailures'] };
    const childProjection = {
      pick: ['results[].hasCompletionEvidence', 'results[].workItem.terminalCompletionEvidence.summary'],
    };
    const tx = { currentCaller: true };
    const principal = { slug: 'current-caller' };
    const authenticatedPrincipal = { ownerId: 'su-nested-proof' };
    const custody = Symbol('custody');
    const observed: Array<Record<string | symbol, unknown>> = [];
    const tool = {
      pluginName: 'nested-proof', description: 'Real work_items:get handler',
      inputSchema: { type: 'object' }, capabilities: [], effect: 'read', needsWorkspaceTx: true,
      expose: { mcp: { name: 'work_items:get' } },
      fn: async (args: unknown, callCtx: Record<string | symbol, unknown>) => {
        observed.push(callCtx);
        const result = await get.handler(args as never, callCtx as never) as Out;
        return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
      },
    } as unknown as ProjectedTool;
    const run = async (outerPick: boolean, childPick: boolean) => {
      const result = await runToolOrchestration(
        `const r = await tools.workItems.get(${JSON.stringify({
          id: stored.id, ...(childPick ? { projection: childProjection } : {}),
        })}); return { has: r.results[0].hasCompletionEvidence, proof: r.results[0].workItem.terminalCompletionEvidence?.summary };`,
        {
          ctx: {
            ...ctx, log: vi.fn(), role: 'su', isSuperuser: true, tx, principal, authenticatedPrincipal,
            [custody]: 'original-custody',
            ...(outerPick ? {
              sourceProjection: parentProjection,
              sourceMaterialization: { trigger: 'projection', pickPaths: 3, promotedToFull: true, structuredSource: true },
            } : {}),
          } as never,
          deps: {}, tools: [tool], allowed: new Set(['work_items:get']),
          wrapDispatch: bindCurrentCallerDispatch,
        },
      );
      return applyNestedProjection(result, outerPick ? parentProjection : null);
    };

    // Same stored row, changing only outer and explicit child projection controls.
    for (const result of [await run(false, false), await run(true, false), await run(true, true)]) {
      expect(result).toMatchObject({ ok: true, summary: { has: true, proof: evidence.summary }, childFailures: [] });
    }
    expect(stored.payload._completionEvidence).toBe(evidence);
    for (const callCtx of observed) {
      expect(callCtx.tx).toBe(tx);
      expect(callCtx.principal).toBe(principal);
      expect(callCtx.authenticatedPrincipal).toBe(authenticatedPrincipal);
      expect(callCtx[custody]).toBe('original-custody');
      expect(callCtx.uiClientId).toBe(ctx.uiClientId);
      expect(callCtx.workspaceId).toBe(ctx.workspaceId);
    }
    expect(observed[1]?.sourceProjection).toBeUndefined();
    expect(observed[1]?.sourceMaterialization).toBeUndefined();
    expect(observed[2]?.sourceProjection).toEqual(childProjection);
    expect(observed[2]?.sourceMaterialization).toMatchObject({ pickPaths: 2 });
    expect(parentProjection).toEqual({ pick: ['ok', 'summary', 'childFailures'] });
  });

  it('returns a retryable timeout instead of not-found when the base read never settles', async () => {
    getWorkItem.mockImplementation(() => new Promise(() => {}));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const pending = get.handler({ id: 'WI-timeout' } as never, ctx as never) as Promise<
      Out & { data: { read: Record<string, unknown> } }
    >;
    await vi.advanceTimersByTimeAsync(WORK_ITEMS_GET_BUDGET_MS + 100);

    const out = await pending;
    expect(out.data.results[0]).toMatchObject({
      ok: false,
      id: 'WI-timeout',
      error: 'timeout',
      retryable: true,
      phase: 'read',
      budgetMs: WORK_ITEMS_GET_BUDGET_MS,
    });
    expect(out.data.results[0]).not.toMatchObject({ error: expect.stringContaining('not found') });
    expect(out.data).toMatchObject({ counts: { ok: 0, failed: 1 }, read: {
      schemaVersion: 'work-items-get-read-v1', requested: 1, available: 0, absent: 0, unavailable: 1,
      outerStageAttribution: expect.any(String),
    } });
    expect(out.data.read.baseReadDiagnostics).toEqual([
      expect.objectContaining({
        id: 'WI-timeout',
        status: 'pending',
        elapsedMs: expect.any(Number),
      }),
    ]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('work_items:get:WI-timeout exceeded'));

    warnSpy.mockRestore();
  });

  it('reports per-ID pending base-read status when a projected batch read never settles', async () => {
    const ids = ['WI-projected-timeout-1', 'WI-projected-timeout-2'];
    getWorkItemsByIds.mockImplementation(() => new Promise(() => {}));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const pending = get.handler(
      { ids, detail: true, threadLimit: 0 } as never,
      { ...ctx, sourceProjection: { pick: ['results[].id', 'read'] } } as never,
    ) as Promise<Out & { data: { read: Record<string, unknown> } }>;
    await vi.advanceTimersByTimeAsync(WORK_ITEMS_GET_BUDGET_MS + 100);

    const out = await pending;
    expect(out.data.results).toHaveLength(ids.length);
    expect(out.data.results.every((row) => row.availability === 'unavailable')).toBe(true);
    expect(out.data.results.map((row) => row.id)).toEqual(ids);
    expect(out.data.results.every((row) => row.ok === false && row.retryable === true && row.error === 'timeout')).toBe(true);
    expect(out.data).toMatchObject({ counts: { ok: 0, failed: ids.length }, read: {
      schemaVersion: 'work-items-get-read-v1', mode: 'projected', requested: ids.length,
      available: 0, absent: 0, unavailable: ids.length, outerStageAttribution: expect.any(String),
    } });
    expect(out.data.read.baseReadDiagnostics).toEqual(expect.arrayContaining(
      ids.map((id) => expect.objectContaining({
        id,
        status: 'pending',
        elapsedMs: expect.any(Number),
      })),
    ));

    warnSpy.mockRestore();
  });

  it('bounds a full-detail read that never settles instead of waiting for the MCP deadline', async () => {
    getWorkItemDetail.mockImplementation(() => new Promise(() => {}));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const pending = get.handler({ id: 'WI-detail-timeout', detail: true } as never, ctx as never) as Promise<Out>;
    await vi.advanceTimersByTimeAsync(WORK_ITEMS_GET_BUDGET_MS + 100);

    const out = await pending;
    expect(out.data.results[0]).toMatchObject({
      ok: false,
      id: 'WI-detail-timeout',
      availability: 'unavailable',
      error: 'timeout',
      retryable: true,
      phase: 'read',
      budgetMs: WORK_ITEMS_GET_BUDGET_MS,
    });
    expect(out.data.results[0]).not.toMatchObject({ error: expect.stringContaining('not found') });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('work_items:get:WI-detail-timeout exceeded'));

    warnSpy.mockRestore();
  });

  it('reports the pending enrichment leg and elapsed budget when enrichment times out', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-enrichment-timeout',
      kind: 'bug',
      family: 'issue',
      harness: 'papercusp',
      state: 'open',
      title: 'enrichment timeout',
    });
    getWorkItemCheckpointWithMeta.mockImplementation(() => new Promise(() => {}));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const pending = get.handler({ id: 'WI-enrichment-timeout' } as never, ctx as never) as Promise<
      Out & { data: { read: Record<string, unknown> } }
    >;
    await vi.advanceTimersByTimeAsync(WORK_ITEMS_GET_BUDGET_MS + 100);

    const out = await pending;
    expect(out.data.results[0]).toMatchObject({
      ok: false,
      id: 'WI-enrichment-timeout',
      availability: 'unavailable',
      error: 'timeout',
    });
    expect(out.data.read.enrichmentMaxMs).toBeGreaterThan(0);
    expect(out.data.read.enrichmentDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'WI-enrichment-timeout',
        stage: 'checkpoint',
        status: 'pending',
        elapsedMs: expect.any(Number),
      }),
    ]));

    warnSpy.mockRestore();
  });

  it('bounds the post-read change-kind lookup within the shared work_items:get budget', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-change-kinds-timeout',
      kind: 'bug',
      family: 'issue',
      harness: 'papercusp',
      state: 'open',
      title: 'change-kind lookup timeout',
    });
    readChangeKinds.mockImplementation(() => new Promise(() => {}));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const metadata = vi.fn();

    const pending = get.handler(
      { id: 'WI-change-kinds-timeout' } as never,
      {
        ...ctx,
        metadata,
        sourceProjection: { pick: ['results[].id', 'results[].workItem.state', 'read'] },
      } as never,
    ) as Promise<Out & { data: { read: Record<string, unknown> } }>;
    await vi.advanceTimersByTimeAsync(WORK_ITEMS_GET_BUDGET_MS + 100);

    const out = await pending;
    expect(out.data.results[0]).toMatchObject({
      ok: true,
      id: 'WI-change-kinds-timeout',
      availability: 'available',
      changeKinds: { current: null, history: [], readFailed: true },
    });
    expect(out.data.read.changeKindsReadMs).toBeGreaterThan(0);
    expect(out.data.read.elapsedMs).toBeLessThanOrEqual(WORK_ITEMS_GET_BUDGET_MS + 100);
    expect(metadata).toHaveBeenCalledWith({ workItemsGet: out.data.read });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('work_items:get:changeKinds exceeded'));

    warnSpy.mockRestore();
  });

  it('bounds resume enrichment when a checkpoint dependency never settles', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-resume-timeout',
      kind: 'bug',
      family: 'issue',
      harness: 'papercusp',
      state: 'open',
      title: 'resume timeout',
      assignee: 'su-test',
    });
    getWorkItemCheckpointWithMeta.mockImplementation(() => new Promise(() => {}));
    getWorkItemCheckpointFreshness.mockResolvedValue({ verdict: 'fresh' });
    listSpecEvidence.mockResolvedValue([]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const pending = get.handler(
      { id: 'WI-resume-timeout', resume: true } as never,
      ctx as never,
    ) as Promise<Out>;
    await vi.advanceTimersByTimeAsync(WORK_ITEMS_GET_BUDGET_MS + 100);

    const out = await pending;
    expect(out.data.results[0]).toMatchObject({
      ok: false,
      id: 'WI-resume-timeout',
      availability: 'unavailable',
      error: 'timeout',
      retryable: true,
      phase: 'read',
      budgetMs: WORK_ITEMS_GET_BUDGET_MS,
    });
    expect(getWorkItemCheckpointWithMeta).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('work_items:get:WI-resume-timeout exceeded'));

    warnSpy.mockRestore();
  });

  it('keeps a completed not-found read distinct from timeout', async () => {
    getWorkItem.mockResolvedValue(null);

    const out = (await get.handler({ id: 'WI-missing' } as never, ctx as never)) as Out;
    expect(out.data.results[0]).toMatchObject({
      ok: false,
      id: 'WI-missing',
      error: "work_item 'WI-missing' not found",
    });
    expect(out.data.results[0]).not.toHaveProperty('retryable');
    expect(out.data.results[0]).toMatchObject({ availability: 'absent' });
  });

  it('runs a payload-dependent 10-item summary in a bounded concurrent pool and skips historical enrichments', async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `WI-${index + 1}`);
    let active = 0;
    let peak = 0;
    getWorkItem.mockImplementation(async (id: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      active -= 1;
      return { id, kind: 'feature', family: 'feature', harness: 'papercusp', state: 'open', title: id };
    });
    const metadata = vi.fn();
    const pending = get.handler(
      { ids } as never,
      {
        ...ctx,
        signal: new AbortController().signal,
        metadata,
        sourceProjection: {
          pick: [
            'results[].id',
            'results[].workItem.state',
            'results[].workItem.title',
            'results[].workItem.payload.futureField',
            'counts',
            'read',
          ],
        },
      } as never,
    ) as Promise<Out & { data: { read: Record<string, unknown> } }>;

    await vi.advanceTimersByTimeAsync(3_001);
    const out = await pending;

    expect(getWorkItem).toHaveBeenCalledTimes(10);
    expect(peak).toBe(WORK_ITEMS_GET_MAX_CONCURRENCY);
    expect(getWorkItemCheckpointWithMeta).not.toHaveBeenCalled();
    expect(out.data.results).toHaveLength(10);
    expect(out.data.results.every((row) => row.availability === 'available')).toBe(true);
    expect(out.data.read).toMatchObject({
      schemaVersion: 'work-items-get-read-v1',
      mode: 'projected',
      requested: 10,
      available: 10,
      absent: 0,
      unavailable: 0,
      baseReadMaxMs: 1_000,
      enrichmentMaxMs: 0,
    });
    expect(Number(out.data.read.elapsedMs)).toBeLessThan(4_000);
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({ workItemsGet: out.data.read }));
  });

  // P-013 (plan scope-unique-identifiers-2026-07-26, R-5): an id held by twin rows is REPORTED
  // with its candidate harnesses — never read as not-found and never resolved to one twin.
  it('P-013: reports an ambiguous id with its candidates on the per-id path', async () => {
    getWorkItem.mockRejectedValue(
      new WorkItemIdAmbiguousError('WI-twin', 'papercusp-workspace', ['papercup', 'papercusp'], null),
    );
    const out = (await get.handler({ id: 'WI-twin' } as never, ctx as never)) as Out & {
      data: { read: Record<string, unknown> };
    };
    expect(out.data.results[0]).toMatchObject({
      ok: false,
      id: 'WI-twin',
      availability: 'ambiguous',
      error: 'ambiguous_id',
      retryable: false,
      candidates: ['papercup', 'papercusp'],
    });
    expect(String(out.data.results[0]!.message)).toContain('Pass harness');
    expect(out.data.read).toMatchObject({ ambiguous: 1, absent: 0, available: 0 });
  });

  it('P-013: reports an ambiguous id on the projected batch path, not as absent', async () => {
    getWorkItemsByIds.mockImplementation(
      async (_ids: string[], _harness: unknown, _opts: unknown, report?: { ambiguous: unknown[] }) => {
        report?.ambiguous.push(new WorkItemIdAmbiguousError('WI-twin', 'ws', ['a', 'b'], null));
        return [{ id: 'WI-one', kind: 'bug', family: 'issue', harness: 'papercusp', state: 'done', title: 'one' }];
      },
    );
    const out = (await get.handler(
      { ids: ['WI-one', 'WI-twin', 'WI-missing'], detail: true, threadLimit: 0 } as never,
      { ...ctx, sourceProjection: { pick: ['results[].id', 'read'] } } as never,
    )) as Out & { data: { receipt: Array<Record<string, unknown>>; read: Record<string, unknown> } };
    const byId = new Map(out.data.results.map((r) => [r.id, r]));
    expect(byId.get('WI-one')).toMatchObject({ ok: true, availability: 'available' });
    expect(byId.get('WI-twin')).toMatchObject({ ok: false, availability: 'ambiguous', candidates: ['a', 'b'] });
    expect(byId.get('WI-missing')).toMatchObject({ ok: false, availability: 'absent' });
    expect(out.data.receipt).toEqual([
      { id: 'WI-one', delivered: true },
      { id: 'WI-twin', delivered: true },
      { id: 'WI-missing', delivered: true },
    ]);
    expect(out.data.read.receiptComplete).toBe(true);
  });

  it('uses one set-based read for projected multi-id completion evidence', async () => {
    const ids = ['WI-batch-1', 'WI-batch-2', 'WI-batch-3', 'WI-batch-4', 'WI-batch-5', 'WI-batch-6'];
    getWorkItemsByIds.mockResolvedValue(
      ids.map((id) => ({
        id,
        kind: 'bug',
        family: 'issue',
        harness: 'papercusp',
        state: 'done',
        title: id,
        terminalCompletionEvidence: { summary: `${id} complete` },
      })),
    );

    const out = (await get.handler(
      { ids, detail: true, threadLimit: 0 } as never,
      {
        ...ctx,
        sourceProjection: {
          pick: [
            'results[].id',
            'results[].workItem.state',
            'results[].completion.filesChanged',
            'results[].completion.testsRun',
            'results[].completion.testResult',
            'read',
          ],
        },
      } as never,
    )) as Out & { data: { read: Record<string, unknown> } };

    expect(getWorkItemsByIds).toHaveBeenCalledOnce();
    expect(getWorkItemsByIds).toHaveBeenCalledWith(
      ids,
      undefined,
      { includeBody: false, payloadProjection: 'completionEvidence' },
      // P-013: the batch read reports ids held by twin rows here instead of picking one.
      { ambiguous: [] },
    );
    expect(getWorkItem).not.toHaveBeenCalled();
    expect(out.data.results).toHaveLength(ids.length);
    expect(out.data.results.every((row) => row.availability === 'available')).toBe(true);
    expect(out.data.read).toMatchObject({ requested: ids.length, available: ids.length, unavailable: 0 });
  });

  it('keeps operationalBrief completion evidence under outer field projections for one and many ids', async () => {
    const ids = [
      'WI-brief-projection-1',
      'WI-brief-projection-2',
      'WI-brief-projection-3',
      'WI-brief-projection-4',
      'WI-brief-projection-5',
    ];
    const evidence = { summary: 'verified completion', verifiedHow: 'focused regression guard' };
    getWorkItem.mockImplementation(async (id: string, _harness?: string, options?: { payloadProjection?: string }) => ({
      id,
      kind: 'bug',
      family: 'issue',
      harness: 'papercup',
      state: 'done',
      title: id,
      closedAt: '2026-10-09T17:00:00.000Z',
      updatedAt: '2026-10-09T17:00:00.000Z',
      ...(options === undefined || options.payloadProjection === 'completionEvidence'
        ? { terminalCompletionEvidence: evidence }
        : {}),
    }));
    const projectedCtx = {
      ...ctx,
      sourceProjection: {
        pick: ['results[].id', 'results[].operationalBrief.lastVerified', 'read'],
      },
    };

    const single = await get.handler(
      { id: ids[0], operationalBrief: true } as never,
      projectedCtx as never,
    ) as Out;
    const batch = await get.handler(
      { ids, operationalBrief: true } as never,
      projectedCtx as never,
    ) as Out;

    for (const row of [...single.data.results, ...batch.data.results]) {
      expect(row.operationalBrief).toMatchObject({
        lastVerified: {
          status: 'known',
          value: { ref: `${row.id}#completion`, summary: 'focused regression guard' },
        },
      });
    }
    expect(getWorkItem.mock.calls.every(([, , options]) => options === undefined)).toBe(true);
    expect(getWorkItemsByIds).not.toHaveBeenCalled();
  });

  it.each([
    ['blocker-only', ['results[].operationalBrief.blockers']],
    ['identity-and-brief', ['results[].id', 'results[].workItem.state', 'results[].operationalBrief']],
  ])('keeps operationalBrief active blocker reasons under %s projections for one and many ids', async (_label, pick) => {
    const ids = ['WI-runtime-blocker-1', 'WI-runtime-blocker-2', 'WI-runtime-blocker-3'];
    const blocker = {
      kind: 'runtime',
      capability: 'live-dependency',
      capabilitySource: 'explicit',
      ref: 'authoring-peer:goal-attribution',
      summary: 'The authoring peer must apply the goal attribution update.',
      evidence: 'The guarded update refused a remote-authored row.',
      nextVerb: 'On the authoring peer, validate ownership then work_items:update {id,goal}.',
      status: 'active',
      createdAt: '2026-10-11T04:40:24.219Z',
      createdBy: 'su-reporter',
      updatedAt: '2026-10-11T04:40:24.219Z',
    };
    const makeWorkItem = (id: string, options?: { payloadProjection?: string }) => ({
      id, kind: 'feature', family: 'feature', harness: 'papercup', state: 'blocked', title: id,
      // The source reader's narrowed path returns NULL payload. Preserve that
      // behavior here so the old handler recipe cannot pass on a rich fixture.
      payload: options === undefined ? {
        externalBlockers: [blocker, { ...blocker, ref: 'cleared-history', status: 'cleared' }],
      } : null,
    });
    const expected = [`runtime blocker ${blocker.ref}: ${blocker.summary} (next: ${blocker.nextVerb})`];
    const projectedCtx = { ...ctx, sourceProjection: { pick } };

    // Permanent wrong control: before 42ead3e6b0 the handler applied this
    // narrowing recipe even when the brief required the complete payload.
    // Calibrate the same projector on both inputs to distinguish source loss
    // from a parser that rejects the reporter's valid runtime blocker.
    const oldOptions = workItemsGetSourceReadOptions(projectedCtx.sourceProjection, false);
    expect(oldOptions).toEqual({ includeBody: false, payloadProjection: 'none' });
    const project = (options?: { payloadProjection?: string }) => projectWorkItemOperationalBrief(
      { id: ids[0], workItem: makeWorkItem(ids[0]!, options) }, { linksRead: false },
    );
    expect(project(oldOptions).blockers).toMatchObject({
      status: 'known', value: ['state is blocked but no blocker reason is recorded'],
    });
    expect(project().blockers).toMatchObject({ status: 'known', value: expected });

    getWorkItem.mockImplementation(async (id: string, _harness?: string, options?: { payloadProjection?: string }) => makeWorkItem(id, options));
    const single = await get.handler({ id: ids[0], operationalBrief: true } as never, projectedCtx as never) as Out;
    const batch = await get.handler({ ids, operationalBrief: true } as never, projectedCtx as never) as Out;

    expect(single.data.results).toHaveLength(1);
    expect(batch.data.results).toHaveLength(ids.length);
    for (const row of [...single.data.results, ...batch.data.results]) {
      expect(row.operationalBrief).toMatchObject({ blockers: { status: 'known', value: expected } });
    }
    expect(getWorkItem.mock.calls.every(([, , options]) => options === undefined)).toBe(true);
    expect(getWorkItemsByIds).not.toHaveBeenCalled();
  });

  it('runs detail=true with threadLimit in the bounded pool instead of serializing the batch', async () => {
    const ids = ['WI-detail-1', 'WI-detail-2', 'WI-detail-3', 'WI-detail-4'];
    let active = 0;
    let peak = 0;
    getWorkItem.mockImplementation(async (id: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      active -= 1;
      return { id, kind: 'bug', family: 'issue', harness: 'papercusp', state: 'open', title: id };
    });
    getWorkItemThreadWindow.mockResolvedValue({ total: 1, posts: [], topics: [] });

    const pending = get.handler(
      { ids, detail: true, threadLimit: 5 } as never,
      {
        ...ctx,
        sourceProjection: {
          pick: ['results[].id', 'results[].workItem.state', 'results[].threadWindow', 'counts', 'read'],
        },
      } as never,
    ) as Promise<Out>;

    await vi.advanceTimersByTimeAsync(1_001);
    const out = await pending;

    expect(getWorkItemDetail).not.toHaveBeenCalled();
    expect(getWorkItem).toHaveBeenCalledTimes(ids.length);
    expect(getWorkItemThreadWindow).toHaveBeenCalledTimes(ids.length);
    expect(peak).toBe(Math.min(ids.length, WORK_ITEMS_GET_MAX_CONCURRENCY));
    expect(out.data.results).toHaveLength(ids.length);
    expect(out.data.results.every((row) => row.availability === 'available')).toBe(true);
    expect(
      out.data.results.every(
        (row) => (row.threadWindow as { total?: number } | undefined)?.total === 1,
      ),
    ).toBe(true);
  });

  it('keeps detail:true with threadLimit:0 on the lean completion-evidence source path', async () => {
    getWorkItem.mockResolvedValue({
      id: 'WI-terminal-detail-projection',
      kind: 'bug',
      family: 'issue',
      harness: 'papercusp',
      state: 'resolved',
      title: 'terminal item',
      terminalCompletionEvidence: { summary: 'already verified' },
    });

    const out = await get.handler(
      {
        id: 'WI-terminal-detail-projection',
        detail: true,
        threadLimit: 0,
      } as never,
      {
        ...ctx,
        sourceProjection: {
          pick: [
            'results[].id',
            'results[].workItem.terminalCompletionEvidence',
            'counts',
            'read',
          ],
        },
      } as never,
    ) as Out;

    expect(getWorkItemDetail).not.toHaveBeenCalled();
    expect(getWorkItem).toHaveBeenCalledWith(
      'WI-terminal-detail-projection',
      undefined,
      { includeBody: false, payloadProjection: 'completionEvidence' },
    );
    expect(out.data.results[0]).toMatchObject({
      ok: true,
      id: 'WI-terminal-detail-projection',
      availability: 'available',
    });
  });

  it.each([
    { name: 'single summary', args: { id: 'WI-pre-cancelled' }, projected: true },
    { name: 'batch summary', args: { ids: ['WI-pre-cancelled', 'WI-pre-cancelled-missing'] }, projected: true },
    { name: 'full detail', args: { id: 'WI-pre-cancelled', detail: true }, projected: false },
    { name: 'resume', args: { id: 'WI-pre-cancelled', resume: true }, projected: false },
    { name: 'checkpoint checks', args: { id: 'WI-pre-cancelled', checksOnly: true }, projected: false },
  ])('does not start storage for an already-cancelled $name request', async ({ args, projected }) => {
    getWorkItem.mockImplementation(() => new Promise(() => {}));
    getWorkItemsByIds.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    controller.abort();
    const ids = 'ids' in args ? args.ids! : [args.id!];
    const out = await get.handler(args as never, {
      ...ctx,
      signal: controller.signal,
      ...(projected ? { sourceProjection: { pick: ['results[].id', 'results[].availability',
        'results[].error', 'results[].retryable', 'counts', 'read'] } } : {}),
    } as never) as Out;

    expect(out.data).toMatchObject({ ok: false, counts: { ok: 0, failed: ids.length },
      results: ids.map(id => ({ id, ok: false, availability: 'unavailable', error: 'cancelled', retryable: true })),
      read: { requested: ids.length, available: 0, absent: 0, unavailable: ids.length } });
    expect(getWorkItem).not.toHaveBeenCalled();
    expect(getWorkItemsByIds).not.toHaveBeenCalled();
    expect(getWorkItemDetail).not.toHaveBeenCalled();
    expect(getWorkItemCheckpointWithMeta).not.toHaveBeenCalled();
    expect(getWorkItemThreadWindow).not.toHaveBeenCalled();
  });

  it('does not start queued item reads after cancellation drains the active workers', async () => {
    getWorkItem.mockImplementation(() => new Promise(() => {}));
    const ids = Array.from({ length: WORK_ITEMS_GET_MAX_CONCURRENCY + 2 }, (_, index) => `WI-queued-cancel-${index}`);
    const controller = new AbortController();
    const pending = get.handler({ ids } as never, { ...ctx, signal: controller.signal } as never) as Promise<Out>;
    await vi.advanceTimersByTimeAsync(0);
    expect(getWorkItem).toHaveBeenCalledTimes(WORK_ITEMS_GET_MAX_CONCURRENCY);

    controller.abort();
    const out = await pending;
    expect(out.data.results).toEqual(ids.map(id => expect.objectContaining({
      id, ok: false, availability: 'unavailable', error: 'cancelled', retryable: true,
    })));
    expect(getWorkItem).toHaveBeenCalledTimes(WORK_ITEMS_GET_MAX_CONCURRENCY);
    expect(getWorkItemCheckpointWithMeta).not.toHaveBeenCalled();
  });

  it('keeps in-flight projected batch cancellation distinct from a timeout', async () => {
    getWorkItemsByIds.mockImplementation(() => new Promise(() => {}));
    const ids = ['WI-batch-cancelled', 'WI-batch-cancelled-missing'];
    const controller = new AbortController();
    const pending = get.handler({ ids } as never, { ...ctx, signal: controller.signal,
      sourceProjection: { pick: ['results[].id', 'results[].availability', 'read'] },
    } as never) as Promise<Out>;
    expect(getWorkItemsByIds).toHaveBeenCalledTimes(1);

    controller.abort();
    const out = await pending;
    expect(out.data).toMatchObject({ counts: { ok: 0, failed: ids.length },
      results: ids.map(id => ({ id, ok: false, availability: 'unavailable', error: 'cancelled', retryable: true })),
      read: { requested: ids.length, available: 0, absent: 0, unavailable: ids.length } });
    expect(getWorkItem).not.toHaveBeenCalled();
  });

  it('returns cancelled as unavailable and consumes a late storage rejection', async () => {
    let rejectRead!: (error: Error) => void;
    getWorkItem.mockImplementation(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
    const controller = new AbortController();
    const pending = get.handler(
      { id: 'WI-cancelled' } as never,
      {
        ...ctx,
        signal: controller.signal,
        sourceProjection: { pick: ['results[].id', 'results[].workItem.state', 'read'] },
      } as never,
    ) as Promise<Out>;

    controller.abort();
    const out = await pending;
    expect(out.data.results[0]).toMatchObject({
      id: 'WI-cancelled',
      availability: 'unavailable',
      error: 'cancelled',
      retryable: true,
      phase: 'read',
    });
    expect(out.data).toMatchObject({ counts: { ok: 0, failed: 1 }, read: {
      schemaVersion: 'work-items-get-read-v1', mode: 'projected', requested: 1,
      available: 0, absent: 0, unavailable: 1, outerStageAttribution: expect.any(String),
    } });

    rejectRead(new Error('late storage failure'));
    await Promise.resolve();
  });

  it.each([
    ['bounded transaction lock timeout', () => new OrgTxnTimeoutError('55P03', new Error('lock timeout')), '55P03'],
    ['raw PostgreSQL statement timeout', () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }), '57014'],
  ])('maps %s to a retryable unavailable result instead of a generic bulk error', async (_label, makeError, pgCode) => {
    getWorkItem.mockRejectedValueOnce(makeError());

    const out = (await get.handler({ id: 'WI-contention' } as never, {
      ...ctx, sourceProjection: { pick: ['results[].id', 'results[].workItem.state',
        'results[].availability', 'results[].error', 'results[].retryable', 'results[].pgCode', 'counts', 'read'] },
    } as never)) as Out;
    expect(out.data.results[0]).toMatchObject({
      ok: false,
      id: 'WI-contention',
      availability: 'unavailable',
      error: 'timeout',
      retryable: true,
      phase: 'read',
      pgCode,
    });
    expect(out.data.results[0].message).toContain('retry shortly');
    expect(out.data).toMatchObject({ counts: { ok: 0, failed: 1 }, read: {
      schemaVersion: 'work-items-get-read-v1', mode: 'projected', requested: 1, available: 0, absent: 0, unavailable: 1,
      outerStageAttribution: expect.any(String),
    } });
  });

  it('maps a pool acquisition deadline to the same retryable unavailable contract without inventing a PG code', async () => {
    getWorkItem.mockRejectedValueOnce(
      new DbCallDeadlineError('work_items:get:acquire', 8_000, 8_000, 'org-admin'),
    );

    const out = (await get.handler({ id: 'WI-pool-deadline' } as never, ctx as never)) as Out;
    expect(out.data.results[0]).toMatchObject({
      ok: false,
      id: 'WI-pool-deadline',
      availability: 'unavailable',
      error: 'timeout',
      retryable: true,
      phase: 'read',
    });
    expect(out.data.results[0].pgCode).toBeUndefined();
    expect(out.data.results[0].message).toContain('retry shortly');
  });
});
