/**
 * plans:get — `shipReadiness`, the opt-in ship-blocker verdict (EI-21967410937471873).
 *
 * WHY THE FIELD EXISTS. The verdict was already computed read-only, but only the UI
 * could reach it (the `plans.acceptanceGate` sync resolver). An agent's sole route to
 * the same answer was to ATTEMPT `plans:set-plan-status` and read the refusal — so
 * agents guessed the blocker instead and wrote the guess into `## Now`, where
 * successors inherited it unverified. Measured on dead-target-routine-reaper-2026-08-30:
 * ~11h waiting on a green-checkpoint gate that was never the blocker (the real one was
 * `audit_coverage_stale`).
 *
 * WHAT THIS PINS, and each case is a failure that would make the field WORSE than not
 * having it — because every one of them reports a plan as shippable when it is not:
 *
 *   - absent unless asked, so absence is never read as "nothing is blocking";
 *   - the verdict is the shared evaluator's, returned verbatim — not re-derived, so it
 *     cannot drift from what set-plan-status actually enforces;
 *   - NOT SERVED FROM CACHE. This is the load-bearing one. A gate verdict is
 *     TIME-VARYING in a way the plan body is not: on a shared tree many agents commit
 *     to, audit citations go stale with nobody touching the plan, so
 *     `audit_coverage_stale` can appear or clear with no plan revision at all. The
 *     first draft of this feature computed the verdict INSIDE cachedRead, whose key
 *     (slug + harness + mode + heading + includeRaw + selections) does not fold
 *     `shipReadiness` — which would have both served a `shipReadiness:true` caller an
 *     entry that never had the field, and pinned a stale `satisfied:true` for the whole
 *     soft TTL. The test asserts the plan read is still cached while the verdict is not;
 *     moving the call back inside the cache fails here loudly;
 *   - a gate that cannot run reports `unavailableReason`, never a silent omission and
 *     never a green, and never fails the surrounding plans:get.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const M = vi.hoisted(() => {
  const planFixture = (slug: string) => ({
    parsed: {
      isLegacy: false,
      slug,
      prose: '## Now\nbody\n',
      raw: `slug: ${slug}\n`,
      frontmatter: { slug },
      now: { state: 's', next: 'n' },
      decisions: [],
      items: [],
    },
    archived: false,
    row: {
      workspaceId: 'ws-ship-readiness',
      planSlug: slug,
      harnessSlug: 'papercup',
      version: 1,
      promotePolicy: null,
      forcedPast: null,
    },
  });
  type PlanRead = ReturnType<typeof planFixture> | null;
  return {
    planHarnessesForSlugs: vi.fn(async () => new Map<string, string[]>()),
    readPlanBySlug: vi.fn(async (slug: string, _opts?: unknown, _timings?: Record<string, number>): Promise<PlanRead> => planFixture(slug)),
    ctxToPlanSourceOpts: vi.fn(async (ctx: { harnessSlug?: string }) => ({
      harnessSlug: ctx.harnessSlug ?? 'papercup',
    })),
    resolveCtxHarnessSlug: vi.fn(() => 'papercup'),
    resolveEffectiveHarnessSlug: vi.fn(() => 'papercup'),
    getAcceptanceRubricForPlan: vi.fn(async () => null),
    getLatestPlanAudit: vi.fn(async () => null),
    getLatestActivationAudit: vi.fn(async () => null),
    // The REAL refusal shape this feature exists to surface — the same code that
    // actually blocked dead-target-routine-reaper-2026-08-30.
    resolvePlanAcceptanceGateVerdict: vi.fn(async ({ planSlug }: { planSlug: string }) => [
      {
        planSlug,
        buildProvenance: { sha: 'gate-sha', version: '1.2.3' },
        satisfied: false,
        skipped: null,
        code: 'audit_coverage_stale',
        message: '3 item audit(s) are missing or stale — P-002; P-004; P-005.',
        rubricId: null,
        gradedBy: null,
        gradedVia: null,
        forcedPast: null,
        vettedUnderWaiver: null,
        unavailableReason: null,
        acceptanceBarContractSnapshot: {
          schemaVersion: 1,
          contentHash: 'snapshot-hash',
          planSlug,
          bars: [{ barKey: 'R-1', readiness: { state: 'blocked', codes: ['bar_snapshot_method_missing'] } }],
          readiness: {
            state: 'blocked',
            codes: ['bar_snapshot_method_missing'],
            nextRepair: { code: 'bar_snapshot_method_missing', barKey: 'R-1', action: 'Fill METHOD.' },
          },
        },
        acceptanceBarContractSnapshotUnavailableReason: null,
      },
    ]),
  };
});

vi.mock('./source', async (orig) => {
  const actual = await orig<typeof import('./source')>();
  return {
    ...actual,
    planHarnessesForSlugs: M.planHarnessesForSlugs,
    readPlanBySlug: M.readPlanBySlug,
  };
});
vi.mock('./_ctx-opts', () => ({
  ctxToPlanSourceOpts: M.ctxToPlanSourceOpts,
  resolveCtxHarnessSlug: M.resolveCtxHarnessSlug,
  resolveEffectiveHarnessSlug: M.resolveEffectiveHarnessSlug,
}));
vi.mock('../../issue-blocks-merge', async (orig) => {
  const actual = await orig<typeof import('../../issue-blocks-merge')>();
  return {
    ...actual,
    overlayIssueBlocksForPlan: vi.fn(async (_slug: string, items: unknown[]) => ({
      items,
      blockingIssues: {},
    })),
  };
});
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    withWorkspace: vi.fn(async () => {
      throw new Error('no-db-in-unit-test');
    }),
  };
});
vi.mock('../../rubrics', () => ({
  getAcceptanceRubricForPlan: M.getAcceptanceRubricForPlan,
}));
vi.mock('../../plan-audits', () => ({
  getLatestPlanAudit: M.getLatestPlanAudit,
  getLatestActivationAudit: M.getLatestActivationAudit,
}));
vi.mock('../../sync-resolver/plan-acceptance-gate-verdict', () => ({
  resolvePlanAcceptanceGateVerdict: M.resolvePlanAcceptanceGateVerdict,
}));

import tool from './get';
import { resetOperatorCacheForTests, resetCachedReadStatsForTests, __setCachedReadEnabledForTests } from '../../cache';
import { _refreshCacheLayerForTests } from '../../cache/instance';

const CACHE_LAYER = 'papercusp-cache-layer';

const ctx = (workspaceId = 'ws-ship-readiness', harnessSlug = 'papercup'): never =>
  ({
    workspaceId,
    harnessSlug,
    metadata: vi.fn(),
    log: vi.fn(),
    progress: vi.fn(),
  }) as never;

const run = async (args: Record<string, unknown>) =>
  (
    (await tool.handler(args as never, ctx())) as {
      data: { results: Array<Record<string, unknown>> };
    }
  ).data;

function installStoredBarReadinessSnapshot() {
  const read = M.readPlanBySlug.getMockImplementation();
  if (!read) throw new Error('plans:get fixture reader is unavailable');
  M.readPlanBySlug.mockImplementationOnce(async (slug, opts, timings) => {
    const plan = await read(slug, opts, timings);
    if (!plan) return plan;
    const state =
      '⚠ BAR READINESS BLOCKED (2026-10-22, after decision-added): bar_snapshot_work_contract_missing, ' +
      'bar_snapshot_vetting_missing. Next repair: Promote the BAR/spec revision into the relevant work-item contract.';
    const next = 'Repair the server-owned adoption epoch/cohort seed on the subject plan.';
    const raw = `**State:** ${state}\n\n**Next:** ${next}`;
    return {
      ...plan,
      parsed: {
        ...plan.parsed,
        prose: `## Now\n\n${raw}\n`,
        now: { state, next, raw, lineNumber: 1 },
      },
    };
  });
}

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(true);
  M.readPlanBySlug.mockClear();
  M.resolvePlanAcceptanceGateVerdict.mockClear();
  M.getLatestActivationAudit.mockClear();
  M.planHarnessesForSlugs.mockReset();
  M.planHarnessesForSlugs.mockResolvedValue(new Map());
  setFlagOverridesForTest({ [CACHE_LAYER]: true });
  await _refreshCacheLayerForTests();
});

afterEach(async () => {
  __setCachedReadEnabledForTests(false);
  setFlagOverridesForTest(null);
  await _refreshCacheLayerForTests();
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
});

describe('plans:get — shipReadiness', () => {
  it('rejects the nested dispatcher default in a broken control (EI-21665387998856992)', () => {
    const hasDedicatedNestedBudget = (timeoutSec: number | undefined) =>
      typeof timeoutSec === 'number' && timeoutSec > 55;
    // Counterexample control: the old flat nested-call deadline is insufficient.
    const brokenRegistration = { timeoutSec: 55 };
    expect(hasDedicatedNestedBudget(brokenRegistration.timeoutSec)).toBe(false);
    // Calibration: the imported production registration must satisfy the same guard.
    expect(hasDedicatedNestedBudget(tool.timeoutSec)).toBe(true);
  });

  it('attributes cold source latency and never replays build timings on a cache hit', async () => {
    const fixture = await M.readPlanBySlug('timing');
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    M.readPlanBySlug.mockImplementationOnce(async (_slug, _opts, timings) => {
      clock += 75;
      if (timings) Object.assign(timings, { 'source.acquireAndSetup': 70, 'source.query': 5 });
      return fixture;
    });
    M.getLatestPlanAudit.mockImplementationOnce(async () => {
      clock += 125;
      return null;
    });
    const metadata = vi.fn();
    const context = { workspaceId: 'ws-timing', harnessSlug: 'papercup', metadata,
      log: vi.fn(), progress: vi.fn() };
    const read = () => tool.handler({ slug: 'timing', harness: 'papercup', includeHistory: false } as never, context as never);
    try {
      const cold = await read();
      const coldTiming = metadata.mock.calls.find(([m]) => m.plansGetRead)?.[0].plansGetRead;
      expect(coldTiming).toMatchObject({ unit: 'ms', reads: [{ slug: 'timing', buildState: 'complete',
        waitMs: 200, stagesMs: { source: 75, rubricAndAudit: 125 },
        detailMs: { 'source.acquireAndSetup': 70, 'source.query': 5 } }] });
      metadata.mockClear();
      const warm = await read();
      const warmTiming = metadata.mock.calls.find(([m]) => m.plansGetRead)?.[0].plansGetRead;
      expect(warmTiming).toMatchObject({ reads: [{ buildState: 'not-started', waitMs: 0, stagesMs: {}, detailMs: {} }] });
      expect(warm).toEqual(cold);
      expect(JSON.stringify(warm)).not.toContain('plansGetRead');
    } finally {
      now.mockRestore();
    }
  });

  it('records judge-only activation-audit wall time outside the cached plan read', async () => {
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    M.getLatestActivationAudit.mockImplementationOnce(async () => {
      clock += 42;
      return null;
    });
    const metadata = vi.fn();
    const judgeContext = {
      workspaceId: 'ws-timing',
      harnessSlug: 'papercup',
      role: 'judge',
      principal: { slug: 'system:judge' },
      metadata,
      log: vi.fn(),
      progress: vi.fn(),
    };
    try {
      const judgeResponse = await tool.handler(
        { slug: 'judge-timing', harness: 'papercup', includeHistory: false } as never,
        judgeContext as never,
      ) as { data: { results: Array<Record<string, unknown>> } };
      const auditTiming = metadata.mock.calls
        .find(([entry]) => entry.plansGetActivationAudit)?.[0].plansGetActivationAudit;

      expect(judgeResponse.data.results[0]).toHaveProperty('latestActivationAudit', null);
      expect(M.getLatestActivationAudit).toHaveBeenCalledOnce();
      expect(auditTiming).toMatchObject({
        unit: 'ms',
        timing: 'wall-time-per-plan',
        reads: [{ slug: 'judge-timing', elapsedMs: 42 }],
      });

      const ordinaryMetadata = vi.fn();
      await tool.handler(
        { slug: 'ordinary-timing', harness: 'papercup', includeHistory: false } as never,
        { ...judgeContext, role: 'worker', principal: { slug: 'system:worker' }, metadata: ordinaryMetadata } as never,
      );
      expect(M.getLatestActivationAudit).toHaveBeenCalledOnce();
      expect(ordinaryMetadata.mock.calls.some(([entry]) => entry.plansGetActivationAudit)).toBe(false);
    } finally {
      now.mockRestore();
    }
  });

  it('accepts a boolean and rejects the string a caller might guess', () => {
    expect(tool.args.safeParse({ slug: 'alpha', shipReadiness: true }).success).toBe(true);
    expect(tool.args.safeParse({ slug: 'alpha', shipReadiness: 'yes' }).success).toBe(false);
  });

  it('accepts and threads the same current proof cohort as the ship write', async () => {
    const current = [
      {
        evidenceKind: 'test',
        evidenceRef: 'testing-run:current#R-1',
        sourceFingerprint: 'source-current',
        testFingerprint: 'test-current',
      },
    ];
    expect(tool.args.safeParse({ slug: 'alpha', shipReadiness: true, current }).success).toBe(true);

    await run({ slug: 'alpha', shipReadiness: true, current });

    expect(M.resolvePlanAcceptanceGateVerdict).toHaveBeenCalledWith(
      expect.objectContaining({ planSlug: 'alpha', harnessSlug: 'papercup', current }),
    );
  });

  it('is ABSENT when not requested — and the gate is never even evaluated', async () => {
    const result = await run({ slug: 'alpha' });
    expect(result.results[0]).not.toHaveProperty('shipReadiness');
    // Not merely absent from the payload: the five-check-family gate must not
    // have run at all, or every plans:get would silently pay for it.
    expect(M.resolvePlanAcceptanceGateVerdict).not.toHaveBeenCalled();
  });

  it("returns the shared evaluator's verdict VERBATIM when requested", async () => {
    const result = await run({ slug: 'alpha', shipReadiness: true });
    expect(M.resolvePlanAcceptanceGateVerdict).toHaveBeenCalledWith(expect.objectContaining({ planSlug: 'alpha' }));
    // The teaching message is passed through unsummarized — an agent acts on the
    // named repair, so paraphrasing it here would defeat the point.
    expect(result.results[0].shipReadiness).toMatchObject({
      satisfied: false,
      code: 'audit_coverage_stale',
      message: '3 item audit(s) are missing or stale — P-002; P-004; P-005.',
      buildProvenance: { sha: 'gate-sha', version: '1.2.3' },
      acceptanceBarContractSnapshot: {
        schemaVersion: 1,
        contentHash: 'snapshot-hash',
        readiness: {
          nextRepair: { code: 'bar_snapshot_method_missing', barKey: 'R-1' },
        },
      },
    });
  });

  it('rides on meta mode too, so a cheap read can still ask what is blocking', async () => {
    const result = await run({ slug: 'alpha', mode: 'meta', shipReadiness: true });
    expect(result.results[0].shipReadiness).toMatchObject({ code: 'audit_coverage_stale' });
  });

  it('labels the stored BAR repair as a dated snapshot in a Now heading read', async () => {
    installStoredBarReadinessSnapshot();
    const result = await run({ slug: 'stale-bar', heading: 'Now' });
    const body = (result.results[0]!.section as { body: string }).body;

    expect(body).toContain('Stored BAR readiness snapshot (last evaluated 2026-10-22)');
    expect(body).toContain('its blocker codes and repair advice may be outdated');
    expect(body).toContain('plans:get { slug: "stale-bar", shipReadiness: true }');
    expect(body).toContain('Promote the BAR/spec revision into the relevant work-item contract');
    expect(result.results[0]).not.toHaveProperty('shipReadiness');
    expect(M.resolvePlanAcceptanceGateVerdict).not.toHaveBeenCalled();
  });

  it('keeps a stored Now snapshot distinct from a requested current proof-readiness verdict', async () => {
    installStoredBarReadinessSnapshot();
    const evaluate = M.resolvePlanAcceptanceGateVerdict.getMockImplementation();
    if (!evaluate) throw new Error('acceptance gate fixture is unavailable');
    const current = (await evaluate({ planSlug: 'stale-bar' }))[0]!;
    const snapshot = current.acceptanceBarContractSnapshot as Record<string, unknown>;
    M.resolvePlanAcceptanceGateVerdict.mockResolvedValueOnce([{
      ...current,
      acceptanceBarContractSnapshot: {
        ...snapshot,
        grading: { vetting: { state: 'current' } },
        readiness: {
          state: 'blocked',
          codes: ['bar_snapshot_proof_missing'],
          nextRepair: {
            code: 'bar_snapshot_proof_missing',
            barKey: 'R-1',
            action: 'Bind evidence at the current spec revision on the declared evidence plane.',
          },
        },
      },
    } as never]);

    const result = await run({ slug: 'stale-bar', heading: 'Now', shipReadiness: true });
    const body = (result.results[0]!.section as { body: string }).body;
    const shipReadiness = result.results[0]!.shipReadiness as {
      acceptanceBarContractSnapshot: {
        grading: { vetting: { state: string } };
        readiness: { nextRepair: { code: string; barKey: string; action: string } };
      };
    };

    expect(body).toContain('Stored BAR readiness snapshot (last evaluated 2026-10-22)');
    expect(body).toContain('Promote the BAR/spec revision into the relevant work-item contract');
    expect(shipReadiness.acceptanceBarContractSnapshot.grading.vetting.state).toBe('current');
    expect(shipReadiness.acceptanceBarContractSnapshot.readiness.nextRepair).toEqual({
      code: 'bar_snapshot_proof_missing',
      barKey: 'R-1',
      action: 'Bind evidence at the current spec revision on the declared evidence plane.',
    });
  });

  it('evaluates the gate PER CALL even though the plan read is cached', async () => {
    // The regression guard for the bug this feature nearly shipped with. The plan
    // body is cacheable; the verdict is not, because audit citations go stale on a
    // shared tree with no plan revision at all. If the verdict is ever moved back
    // inside cachedRead, the second call returns the FIRST call's verdict and this
    // fails — which is the whole point, since the stale value would be a green.
    await run({ slug: 'alpha', shipReadiness: true });
    await run({ slug: 'alpha', shipReadiness: true });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(1); // plan read: cached
    expect(M.resolvePlanAcceptanceGateVerdict).toHaveBeenCalledTimes(2); // verdict: fresh
  });

  it('a cached plan read still gains the field when a later caller asks for it', async () => {
    // The other half of the cache hazard: the entry populated by the first call
    // never carried shipReadiness, so serving it unchanged would answer the second
    // caller's explicit question with silence.
    const without = await run({ slug: 'alpha' });
    expect(without.results[0]).not.toHaveProperty('shipReadiness');
    const withField = await run({ slug: 'alpha', shipReadiness: true });
    expect(withField.results[0].shipReadiness).toMatchObject({ code: 'audit_coverage_stale' });
  });

  it('reports unavailableReason rather than a green when the gate cannot be evaluated', async () => {
    M.resolvePlanAcceptanceGateVerdict.mockRejectedValueOnce(new Error('gate exploded'));
    const result = await run({ slug: 'alpha', shipReadiness: true });
    // plans:get itself must still succeed — this is an advisory field on an
    // unrelated payload.
    expect(result.results[0].ok).toBe(true);
    // ...and the failure must be legible AS a failure. `satisfied:false` plus an
    // explicit unavailableReason keeps "could not evaluate" distinguishable from
    // "passed"; omitting the field would have read as "nothing is blocking".
    expect(result.results[0].shipReadiness).toMatchObject({
      satisfied: false,
      unavailableReason: 'resolver-unavailable',
      buildProvenance: { version: expect.any(String) },
    });
    expect(result.results[0].shipReadiness).toHaveProperty('buildProvenance.sha');
  });
});
