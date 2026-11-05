import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  register: vi.fn(),
  failOpen: vi.fn(),
  reap: vi.fn(async (_sql: unknown, _input: { workspaceId: string; reaperRunId: string; nowMs: number }) => [] as unknown[]),
  // WI-10004725: the production fail-open wiring reads promoter liveness and, only when it is
  // stale, runs the no-model pass. Healthy by default so the existing ticks skip it.
  liveness: vi.fn(async (..._args: unknown[]) => ({ stale: false, reason: 'healthy' })),
  promoter: vi.fn(async (_opts: Record<string, unknown>) => ({
    runId: 'nm', batchSize: 0, flaggedPairs: 0, promoted: 0, merged: 0, held: 0, modelCalled: false,
    tokensIn: 0, tokensOut: 0, censusBefore: 0, censusAfter: 0, writerCoverageGap: [] as string[],
    deferredToModel: 0,
  })),
  workflowID: 'durable-promoter-test',
}));
vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: {
    get workflowID() { return h.workflowID; },
    registerWorkflow: (workflow: unknown) => workflow,
  },
}));
vi.mock('./system-actions', () => ({ SYSTEM_TARGET_PREFIX: 'system:', registerSystemAction: h.register }));
// The real getOrgPg() throws without a live operator DB; the production reaper wiring only
// needs a handle to pass through to the (mocked) reaper, never one that is queried.
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: () => { throw new Error('unit test: no live operator DB'); } }),
}));
vi.mock('../../admission-runs-reaper', async (orig) => {
  const actual = await orig<typeof import('../../admission-runs-reaper')>();
  return { ...actual, reapStrandedAdmissionRuns: h.reap };
});
vi.mock('../../work-items-admission-promoter', async (orig) => {
  const actual = await orig<typeof import('../../work-items-admission-promoter')>();
  return {
    ...actual,
    runWorkItemAdmissionFailOpen: h.failOpen,
    readPromoterLiveness: h.liveness,
    runWorkItemAdmissionPromoter: h.promoter,
  };
});

const { admissionPromoterOptions, makeWorkItemAdmissionFailOpenAction, makeWorkItemAdmissionPromoterAction } =
  await import('./work-item-admission-promoter-action');
const registeredNames = h.register.mock.calls.map((call) => call[0]);

const ctx = {
  installSlug: 'papercusp',
  workspaceId: 'ws',
  triggerConfig: {},
  payloadTemplate: null,
};

beforeEach(() => vi.clearAllMocks());

describe('work-item admission routine actions', () => {
  it('threads exact targets and the durable workflow identity without widening the scheduled default', () => {
    expect(admissionPromoterOptions(ctx)).not.toHaveProperty('targetItemIds');
    expect(admissionPromoterOptions({
      ...ctx, payloadTemplate: { targetItemIds: [' WI-2 ', 'WI-1', 'WI-2'], batchSize: 2 },
    })).toMatchObject({
      workspaceId: 'ws', harnessSlug: 'papercusp', runId: 'durable-promoter-test',
      batchSize: 2, targetItemIds: ['WI-1', 'WI-2'],
    });
    for (const targetItemIds of [[], null, '', [''], [7], Array(101).fill('WI-1')]) {
      expect(() => admissionPromoterOptions({ ...ctx, payloadTemplate: { targetItemIds } }))
        .toThrow('targetItemIds');
    }
  });

  it('retains the production unit-test guard rather than exercising live screening', async () => {
    await expect(makeWorkItemAdmissionPromoterAction()(ctx))
      .rejects.toThrow('production admission promoter must not run from a unit test');
  });

  it('registers the LLM promoter and the independent fail-open action', () => {
    expect(registeredNames).toEqual(['work-item-admission-promoter', 'work-item-admission-fail-open']);
  });

  it('runs and reports one promoter tick', async () => {
    const log = vi.fn();
    const alarm = vi.fn(async () => undefined);
    const invalidate = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({
      runId: 'p1',
      batchSize: 6,
      flaggedPairs: 5,
      promoted: 1,
      merged: 5,
      held: 0,
      modelCalled: true,
      tokensIn: 100,
      tokensOut: 20,
      censusBefore: 5,
      censusAfter: 0,
      writerCoverageGap: [],
    }));
    await makeWorkItemAdmissionPromoterAction({ run, alarm, invalidate, log })(ctx);
    expect(run).toHaveBeenCalledWith(ctx);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(alarm).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('promoted=1 merged=5 held=0'));
  });

  // EI-21728201456300634 / EI-21866311570152646: a raw global census rise (concurrent corpus
  // growth, or this tick's own legitimate `hold` verdicts) is NOT a writer defect and must
  // never alarm on its own.
  it('does not alarm on a raw census rise from organic growth or a legitimate hold', async () => {
    const alarm = vi.fn(async () => undefined);
    const invalidate = vi.fn(async () => undefined);
    const base = {
      runId: 'p-rise',
      batchSize: 1,
      flaggedPairs: 1,
      promoted: 0,
      merged: 0,
      held: 1,
      modelCalled: true,
      tokensIn: 10,
      tokensOut: 2,
      censusBefore: 4,
      censusAfter: 5,
      writerCoverageGap: [] as string[],
    };
    await makeWorkItemAdmissionPromoterAction({
      run: async () => base,
      alarm,
      invalidate,
      log: vi.fn(),
    })(ctx);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(alarm).not.toHaveBeenCalled();

    // Also a zero-pair tick (nothing judged) can never carry a coverage gap, no matter how far
    // the global census moved from concurrent corpus growth.
    alarm.mockClear();
    await makeWorkItemAdmissionPromoterAction({
      run: async () => ({ ...base, flaggedPairs: 0, held: 0, modelCalled: false, censusAfter: 9 }),
      alarm,
      invalidate,
      log: vi.fn(),
    })(ctx);
    expect(alarm).not.toHaveBeenCalled();
  });

  it('raises the durable alarm only when a judged pair fails to persist its adjudication', async () => {
    const alarm = vi.fn(async () => undefined);
    const invalidate = vi.fn(async () => undefined);
    const base = {
      runId: 'p-gap',
      batchSize: 1,
      flaggedPairs: 1,
      promoted: 0,
      merged: 1,
      held: 0,
      modelCalled: true,
      tokensIn: 10,
      tokensOut: 2,
      censusBefore: 4,
      // Census can even FALL and the alarm must still fire when the writer left a genuine gap —
      // the two signals are independent.
      censusAfter: 3,
      writerCoverageGap: ['WI-1::WI-2'],
    };
    await makeWorkItemAdmissionPromoterAction({
      run: async () => base,
      alarm,
      invalidate,
      log: vi.fn(),
    })(ctx);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(alarm).toHaveBeenCalledWith(ctx, base);

    alarm.mockClear();
    await makeWorkItemAdmissionPromoterAction({
      run: async () => ({ ...base, writerCoverageGap: [] }),
      alarm,
      invalidate,
      log: vi.fn(),
    })(ctx);
    expect(alarm).not.toHaveBeenCalled();
  });

  // WIRING GUARD. The core supports both scopes, so the only thing standing between a healthy
  // fleet and every non-home harness starving forever is this one argument on the production
  // path. Without this test, deleting it keeps all other tests green and silently restores the
  // 40.7h starvation measured 2026-08-28 (WI-569147).
  it('asks for a workspace-wide sweep on the production fail-open path', async () => {
    h.failOpen.mockResolvedValue({
      runId: 'f-prod',
      autoPromoted: [],
      autoPromotedByHarness: {},
      heldByScope: {},
      scope: 'workspace',
      liveness: {
        stale: false,
        reason: 'healthy',
        active: true,
        routineExists: true,
        lastSuccessAtMs: 1,
        ageMs: 1,
        thresholdMs: 90,
      },
    });

    // deliberately NOT overriding `run` — this exercises the real productionFailOpen wiring
    await makeWorkItemAdmissionFailOpenAction({
      alarm: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined),
      log: vi.fn(),
    })(ctx);

    expect(h.failOpen).toHaveBeenCalledTimes(1);
    expect(h.failOpen.mock.calls[0]![0]).toMatchObject({ scope: 'workspace', workspaceId: 'ws' });
    // WI-10004726 P-008: the production tick also reaps stranded admission_runs,
    // workspace-wide, never reaping its own run.
    expect(h.reap).toHaveBeenCalledTimes(1);
    expect(h.reap.mock.calls[0]![1]).toMatchObject({ workspaceId: 'ws', reaperRunId: 'f-prod' });
  });

  const healthyFailOpen = {
    runId: 'f-reap',
    autoPromoted: [],
    autoPromotedByHarness: {},
    heldByScope: {},
    scope: 'workspace' as const,
    liveness: {
      stale: false,
      reason: 'healthy',
      active: true,
      routineExists: true,
      lastSuccessAtMs: 1,
      ageMs: 1,
      thresholdMs: 90,
    },
  };

  it('reaps stranded admission_runs on every fail-open tick and names each reaped row in the tick log', async () => {
    const reap = vi.fn(async () => [
      { id: 'promoter-old', harnessSlug: 'papercusp', runKind: 'promoter-tick', startedAt: '2026-09-08T18:37:02.987Z' },
      { id: 'park-old', harnessSlug: 'papercusp', runKind: 'durable-park-audit', startedAt: '2026-09-15T08:11:50.510Z' },
    ]);
    const log = vi.fn();
    await makeWorkItemAdmissionFailOpenAction({
      run: async () => healthyFailOpen,
      reap,
      alarm: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined),
      log,
    })(ctx);

    expect(reap).toHaveBeenCalledWith(ctx, 'f-reap');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('reaped-stranded=2 [promoter-tick:promoter-old,durable-park-audit:park-old]'),
    );
  });

  it('logs reaped-stranded=0 on a clean tick, so a silent reaper is distinguishable from an idle one', async () => {
    const log = vi.fn();
    await makeWorkItemAdmissionFailOpenAction({
      run: async () => healthyFailOpen,
      reap: vi.fn(async () => []),
      alarm: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined),
      log,
    })(ctx);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reaped-stranded=0'));
  });

  it('a reaper failure never costs the tick its admissions, invalidation or log line', async () => {
    const run = vi.fn(async () => healthyFailOpen);
    const invalidate = vi.fn(async () => undefined);
    const log = vi.fn();
    await makeWorkItemAdmissionFailOpenAction({
      run,
      reap: vi.fn(async () => { throw new Error('admission_runs locked'); }),
      alarm: vi.fn(async () => undefined),
      invalidate,
      log,
    })(ctx);

    expect(run).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reaped-stranded=ERROR (admission_runs locked)'));
  });

  it('raises the liveness alarm only on a stale fail-open verdict', async () => {
    const alarm = vi.fn(async () => undefined);
    const invalidate = vi.fn(async () => undefined);
    const stale = {
      runId: 'f1',
      autoPromoted: ['WI-1'],
      autoPromotedByHarness: { papercusp: ['WI-1'] },
      heldByScope: {},
      scope: 'workspace' as const,
      liveness: {
        stale: true,
        reason: 'no successful tick',
        active: true,
        routineExists: true,
        lastSuccessAtMs: 1,
        ageMs: 100,
        thresholdMs: 90,
      },
    };
    await makeWorkItemAdmissionFailOpenAction({ run: async () => stale, alarm, invalidate, log: vi.fn() })(ctx);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(alarm).toHaveBeenCalledWith(ctx, stale);

    alarm.mockClear();
    await makeWorkItemAdmissionFailOpenAction({
      run: async () => ({ ...stale, liveness: { ...stale.liveness, stale: false } }),
      alarm,
      invalidate,
      log: vi.fn(),
    })(ctx);
    expect(alarm).not.toHaveBeenCalled();
  });

  // OBSERVABILITY GUARD. The work-scope policy deliberately holds an out-of-scope harness's
  // pending rows, and that hold is CORRECT. What was not correct is that it happened in
  // total silence: the fail-open dropped those rows with a bare SQL predicate that wrote
  // nothing, while the sibling promoter path recorded a `held` decision on the policy ledger.
  // Measured 2026-09-20 the ledger read `{ held: 0, denied: 371 }` while `sb-devboard-hive`
  // held a pending row for 36.4h — so "held by policy" and "no backstop is watching this
  // harness" were indistinguishable from outside, and EI-23776069366479860 was filed against
  // the wrong cause with a remediation that had already shipped on 2026-08-28.
  it('names every scope-held harness in the tick log, and reports zero when none was held', async () => {
    const base = {
      runId: 'f-held',
      autoPromoted: [],
      autoPromotedByHarness: {},
      scope: 'workspace' as const,
      liveness: {
        stale: false,
        reason: 'healthy',
        active: true,
        routineExists: true,
        lastSuccessAtMs: 1,
        ageMs: 1,
        thresholdMs: 90,
      },
    };
    const heldByScope = { 'sb-devboard-hive': 3, email: 2 };
    const log = vi.fn();
    await makeWorkItemAdmissionFailOpenAction({
      run: async () => ({ ...base, heldByScope }),
      alarm: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined),
      log,
    })(ctx);

    const line = log.mock.calls[0]![0] as string;
    // DERIVED from the fixture, never a hand-listed spelling: adding a harness to heldByScope
    // must force this assertion to cover it, so the guard cannot rot into checking one name.
    for (const [harness, count] of Object.entries(heldByScope)) {
      expect(line).toContain(`${harness}=${count}`);
    }
    const total = Object.values(heldByScope).reduce((sum, n) => sum + n, 0);
    expect(line).toContain(`held-by-scope=${total}`);

    // CALIBRATION CONTROL. Without this, a log line that unconditionally printed every known
    // harness would satisfy the assertions above while reporting nothing real. A zero tick
    // must still SAY zero — silence is the defect, so an absent field is not an acceptable
    // way to express "nothing held".
    const quietLog = vi.fn();
    await makeWorkItemAdmissionFailOpenAction({
      run: async () => ({ ...base, heldByScope: {} }),
      alarm: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined),
      log: quietLog,
    })(ctx);
    const quietLine = quietLog.mock.calls[0]![0] as string;
    expect(quietLine).toContain('held-by-scope=0');
    expect(quietLine).not.toContain('sb-devboard-hive');

    // A harness that is in scope contributes nothing, so a zero count is never rendered as a
    // held harness — otherwise the line would cry wolf on every healthy tick.
    const zeroLog = vi.fn();
    await makeWorkItemAdmissionFailOpenAction({
      run: async () => ({ ...base, heldByScope: { papercusp: 0 } }),
      alarm: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined),
      log: zeroLog,
    })(ctx);
    const zeroLine = zeroLog.mock.calls[0]![0] as string;
    expect(zeroLine).toContain('held-by-scope=0');
    expect(zeroLine).not.toContain('papercusp=0');
  });
});

// WI-10004725 (plan work-queue-bulk-cleanup-remediation-2026-10-01 P-007): pausing the model
// promoter for LLM spend must not also stop the promotions that never needed a model.
describe('fail-open tick: no-model pass while the model promoter is paused', () => {
  const sweep = {
    runId: 'f-nm',
    autoPromoted: [],
    autoPromotedByHarness: {},
    heldByScope: {},
    scope: 'workspace' as const,
    liveness: { stale: true, reason: 'promoter routine is inactive', active: false, routineExists: true, lastSuccessAtMs: 1, ageMs: null, thresholdMs: 90 },
    reviewMoot: { closed: 7, byHarness: { papercusp: 7 }, truncatedByLimit: false },
  };

  it('runs the deterministic pass BEFORE the sweep when the promoter is stale, and never calls a model', async () => {
    h.liveness.mockResolvedValueOnce({ stale: true, reason: 'promoter routine is inactive' });
    const order: string[] = [];
    h.promoter.mockImplementationOnce(async (opts) => {
      order.push('no-model');
      // The pass must refuse to call a model even if something asked it to.
      await expect((opts.llmCall as () => Promise<unknown>)()).rejects.toThrow(/never call a model/);
      return { runId: 'nm-1', batchSize: 3, flaggedPairs: 1, promoted: 2, merged: 0, held: 1, modelCalled: false,
        tokensIn: 0, tokensOut: 0, censusBefore: 0, censusAfter: 0, writerCoverageGap: [], deferredToModel: 1 };
    });
    const log = vi.fn();
    await makeWorkItemAdmissionFailOpenAction({
      run: async () => { order.push('sweep'); return sweep; },
      alarm: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined),
      log,
    })(ctx);
    expect(order).toEqual(['no-model', 'sweep']);
    expect(h.promoter).toHaveBeenCalledTimes(1);
    expect(h.promoter.mock.calls[0]![0]).toMatchObject({ noModel: true, harnessSlug: 'papercusp', workspaceId: 'ws' });
    const line = log.mock.calls[0]![0] as string;
    expect(line).toContain('no-model run=nm-1 promoted=2 merged=0 deferred-to-model=1');
    expect(line).toContain('review-moot=7');
  });

  it('skips the pass when the model promoter is live (it runs the same path itself)', async () => {
    const log = vi.fn();
    await makeWorkItemAdmissionFailOpenAction({
      run: async () => ({ ...sweep, reviewMoot: undefined }),
      alarm: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined),
      log,
    })(ctx);
    expect(h.liveness).toHaveBeenCalledTimes(1);
    expect(h.promoter).not.toHaveBeenCalled();
    const line = log.mock.calls[0]![0] as string;
    expect(line).toContain('no-model=skipped(promoter live)');
    expect(line).toContain('review-moot=0');
  });

  it('a failing no-model pass never costs the tick its sweep, and the failure is logged', async () => {
    const run = vi.fn(async () => sweep);
    const log = vi.fn();
    await makeWorkItemAdmissionFailOpenAction({
      noModelPromote: async () => { throw new Error('pair read timed out'); },
      run,
      alarm: vi.fn(async () => undefined),
      invalidate: vi.fn(async () => undefined),
      log,
    })(ctx);
    expect(run).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain('no-model=ERROR (pair read timed out)');
  });
});
