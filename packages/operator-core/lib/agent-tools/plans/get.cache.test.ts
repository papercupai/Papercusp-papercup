/**
 * plans:get cache integration (cache-expensive-tool-reads-round2-2026-06-23 P-001).
 *
 * Drives the REAL handler against a mocked source/decoration layer + the REAL operator
 * cache to pin the caching CONTRACT specific to plans:get: a repeat call for the same
 * slug HITS (readPlanBySlug runs once); a plan-table write busts it (tag invalidation);
 * different slug / mode / workspace never share an entry (no cross-key / cross-workspace
 * leak); the CACHE_LAYER kill-switch disables caching. (Generic SWR/key semantics are
 * pinned in cache/cached-read.test.ts; this file proves the wiring — right tags, right key,
 * per-slug granularity.)
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const M = vi.hoisted(() => {
  // The real readPlanBySlug (source.ts:1419) returns `{…} | null` — null IS the
  // miss. Keeping the fixture's return type honest lets a test install a miss
  // without an `as never`, which would silently stop typechecking this fixture
  // against the real signature.
  const planFixture = (slug: string) => ({
    parsed: {
      isLegacy: false,
      slug,
      prose: '## Now\nbody\n',
      raw: `slug: ${slug}\n`,
      frontmatter: { slug },
      now: { state: 's', next: 'n', raw: 's\nn', lineNumber: 1 },
      decisions: [
        {
          id: 'D-001',
          title: 'First ruling',
          body: 'The complete first ruling body must remain intact.',
          date: '2026-08-20',
          itemRefs: ['P-001'],
        },
        {
          id: 'D-009',
          title: 'Selected ruling',
          body: 'The complete selected ruling body must remain intact, including its final sentence.',
          date: '2026-08-21',
          itemRefs: ['P-009'],
        },
      ],
      items: [
        {
          id: 'P-001',
          text: 'first item',
          storedStatus: 'todo',
          importance: 'normal',
          blockedBy: [],
          decisionRefs: [],
          phase: null,
          lineNumber: 1,
          rawLine: '- **P-001** `todo` — first item',
        },
        {
          id: 'P-009',
          text: 'the item requested from a large plan',
          storedStatus: 'todo',
          importance: 'normal',
          blockedBy: [],
          decisionRefs: [],
          phase: null,
          lineNumber: 2,
          rawLine: '- **P-009** `todo` — the item requested from a large plan',
        },
      ],
    },
    archived: false,
    row: {
      workspaceId: 'ws-get',
      planSlug: slug,
      content: `---\nslug: ${slug}\n---\n\n## Items\n\n- **P-001** \`todo\` first item\n`,
      harnessSlug: 'papercup',
      version: 1,
      promotePolicy: null,
      forcedPast: {
        count: 1,
        latest: {
          reason: 'auditor unavailable',
          checks: ['acceptance_unaudited'],
          forcedAt: '2026-08-20T22:30:00.000Z',
          forcedBy: { ownerId: 'su-forcer', ownerLabel: 'Forcing agent' },
          legacy: false,
        },
      },
    },
  });
  type PlanRead = ReturnType<typeof planFixture> | null;
  return {
    history: vi.fn(async () => ({
      status: 'available',
      brief: {
        fingerprint: 'history-1',
        attempts: [{ rawRef: 'WI-child#checkpoint', text: 'Root cause: child lesson survives.' }],
      },
      recovery: { tool: 'plans:get', args: { slug: 'alpha', harness: 'papercup', heading: 'History' } },
    })),
    historyRefs: vi.fn(async () => ({
      records: [{ rawRef: 'WI-child#checkpoint', text: 'Complete child lesson.' }],
      unresolved: [],
    })),
    planHarnessesForSlugs: vi.fn(async () => new Map<string, string[]>()),
    readPlanBySlug: vi.fn(async (slug: string): Promise<PlanRead> => planFixture(slug)),
    ctxToPlanSourceOpts: vi.fn(async (ctx: { harnessSlug?: string; workspaceId?: string }) => ({
      harnessSlug: ctx.harnessSlug ?? 'papercup',
      ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
    })),
    resolveCtxHarnessSlug: vi.fn(() => 'papercup'),
    resolveEffectiveHarnessSlug: vi.fn(() => 'papercup'),
    previewPlanStartConsult: vi.fn(),
    getAcceptanceRubricForPlan: vi.fn(async (slug: string) => ({
      rubricId: `rubric-${slug}`,
      status: 'ratified',
      criteria: [{ id: 'criterion-1' }],
      classRef: 'plan-class-code',
    })),
    getLatestPlanAudit: vi.fn(async (slug: string) => ({
      planSlug: slug,
      harnessSlug: 'papercup',
      auditSeq: 7,
      createdBy: 'su-auditor',
      createdAt: '2026-08-20T23:00:00.000Z',
      auditedSha: 'abc123',
      items: [
        {
          itemId: 'P-001',
          verdict: 'implemented',
          citations: [{ kind: 'code', path: 'src/a.ts', blobSha: 'blob-a' }],
          auditedSha: 'abc123',
          auditedAt: '2026-08-20T23:00:00.000Z',
          itemTextHash: 'item-hash',
        },
      ],
      findings: [],
      summary: 'code truth verified',
    })),
    getLatestActivationAudit: vi.fn(async (slug: string) => ({
      planSlug: slug,
      harnessSlug: 'papercup',
      auditSeq: 8,
      createdBy: 'su-activation-auditor',
      createdAt: '2026-08-21T00:00:00.000Z',
      auditKind: 'activation',
      auditedSha: 'def456',
      activation: {
        sourceRanges: [],
        mappings: [{
          id: 'M-001',
          sourceRefs: ['session_turn:codex:owner-session:17'],
          requirement: 'Keep this plan item traceable to the owner request.',
          planTargets: ['P-009'],
          disposition: 'covered',
        }],
        repairedOmissions: [],
        rejectedOrSuperseded: [],
        unresolvedBlockers: [],
      },
      auditedPlanRevision: { id: 9, seq: 9, contentHash: 'plan-hash' },
      items: [],
      findings: [],
      summary: 'owner request mapped to plan item',
    })),
    overlayIssueBlocksForPlan: vi.fn(async (_slug: string, items: unknown[]) => ({
      items,
      blockingIssues: {},
    })),
  };
});

vi.mock('../../prior-attempt-context', async (original) => ({
  ...(await original<typeof import('../../prior-attempt-context')>()),
  readPlanHistoryContext: M.history,
  resolvePriorAttemptRefs: M.historyRefs,
}));

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
    overlayIssueBlocksForPlan: M.overlayIssueBlocksForPlan,
  };
});
// The lifecycle / linkedFeatures decorations query PG via withWorkspace; in the
// unit test there's no DB, so make it throw — both reads are wrapped in a non-fatal
// try/catch and degrade to empty, which is exactly the path we want to exercise.
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
vi.mock('./get-activation-readiness', () => ({
  previewPlanStartConsult: M.previewPlanStartConsult,
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-reader' }),
}));

import tool from './get';
import { withWorkspace } from '@papercusp/db-org';
import {
  getOperatorCache,
  resetOperatorCacheForTests,
  resetCachedReadStatsForTests,
  __setCachedReadEnabledForTests,
} from '../../cache';
import { _refreshCacheLayerForTests } from '../../cache/instance';

const CACHE_LAYER = 'papercusp-cache-layer';

const ctx = (workspaceId: string, harnessSlug = 'papercup', role?: string) =>
  ({
    workspaceId,
    harnessSlug,
    ...(role ? { role } : {}),
    metadata: vi.fn(),
    log: vi.fn(),
    progress: vi.fn(),
  });

const run = async (
  args: Record<string, unknown>,
  workspaceId = 'ws-get',
  harnessSlug = 'papercup',
  role?: string,
): Promise<{ results: Array<Record<string, unknown>> }> =>
  (
    (await tool.handler(args as never, ctx(workspaceId, harnessSlug, role) as never)) as {
      data: { results: Array<Record<string, unknown>> };
    }
  ).data;

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(true);
  M.readPlanBySlug.mockClear();
  M.planHarnessesForSlugs.mockReset();
  M.planHarnessesForSlugs.mockResolvedValue(new Map());
  M.ctxToPlanSourceOpts.mockClear();
  M.getAcceptanceRubricForPlan.mockClear();
  M.getLatestPlanAudit.mockClear();
  M.overlayIssueBlocksForPlan.mockClear();
  vi.mocked(withWorkspace).mockClear();
  M.previewPlanStartConsult.mockClear();
  M.previewPlanStartConsult.mockResolvedValue({
    outcome: 'proceed',
    verdict: 'all_responders_paused',
  });
  M.history.mockClear();
  M.historyRefs.mockClear();
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

describe('plans:get — cache wiring', () => {
  it.each([
    { mode: 'meta' },
    { mode: 'sections' },
    { mode: 'full' },
    { heading: 'Now' },
  ])('discloses State narration that went stale after an item completed: %j', async (selection) => {
    const read = M.readPlanBySlug.getMockImplementation()!;
    M.readPlanBySlug.mockImplementationOnce(async (slug) => {
      const fixture = (await read(slug))!;
      fixture.parsed.now.state = 'P-001 remains open; P-009 reconciliation remains open.';
      fixture.parsed.now.next = 'Read the existing source checkpoint.';
      fixture.parsed.now.raw = '**State:** ' + fixture.parsed.now.state + '\n\n**Next:** ' + fixture.parsed.now.next;
      fixture.parsed.prose = '## Now\n\n' + fixture.parsed.now.raw + '\n';
      fixture.parsed.items[0].storedStatus = 'done';
      return fixture;
    });

    const result = (await run({ slug: 'stale-state', ...selection, includeEnrichments: false })).results[0];
    if ('heading' in selection) {
      expect(result.section).toMatchObject({ body: expect.stringContaining('P-001 [done]') });
      expect((result.section as { body: string }).body).toContain('Stored State');
      expect((result.section as { body: string }).body).toContain('P-009 reconciliation remains open.');
      expect(result).not.toHaveProperty('now');
    } else {
      expect(result.now).toMatchObject({
        state: expect.stringContaining('P-001 [done]'),
        stateDerivation: { contradictions: [expect.objectContaining({ id: 'P-001', status: 'done' })] },
        next: 'Read the existing source checkpoint.',
        raw: expect.stringContaining('P-001 remains open; P-009 reconciliation remains open.'),
      });
    }
  });

  it('CONTROL: preserves the same State narration while the named item is open', async () => {
    const read = M.readPlanBySlug.getMockImplementation()!;
    M.readPlanBySlug.mockImplementationOnce(async (slug) => {
      const fixture = (await read(slug))!;
      fixture.parsed.now.state = 'P-001 remains open; P-009 reconciliation remains open.';
      return fixture;
    });
    const result = (await run({ slug: 'live-state', mode: 'meta', includeEnrichments: false })).results[0];
    expect(result.now).toMatchObject({ state: 'P-001 remains open; P-009 reconciliation remains open.' });
  });

  it('delivers fresh child history outside the cached plan and resolves the exact recovery read', async () => {
    const first = await run({ slug: 'alpha', mode: 'full' });
    expect(JSON.stringify(first)).toContain('child lesson survives');
    await run({ slug: 'alpha', mode: 'full' });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(1);
    expect(M.history).toHaveBeenCalledTimes(2);
    const recovered = await run({ slug: 'alpha', heading: 'History', priorAttemptRefs: ['WI-child#checkpoint'] });
    expect(recovered.results[0]).toMatchObject({
      history: { status: 'available' },
      priorAttemptRecords: { records: [{ rawRef: 'WI-child#checkpoint', text: 'Complete child lesson.' }] },
    });
    expect(M.historyRefs).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'plan', ref: 'alpha', harness: 'papercup' },
        rawRefs: ['WI-child#checkpoint'],
      }),
    );
  });

  it('does not run descendant history for member item reads or metadata', async () => {
    await run({ slug: 'alpha', mode: 'meta' });
    await run({ slug: 'alpha', mode: 'full', items: ['P-001'] });
    await run({ slug: 'alpha', heading: 'Decisions' });
    expect(M.history).not.toHaveBeenCalled();
  });
  it('can omit unused history without losing full document fields or poisoning subsequent full reads', async () => {
    const full = await run({ slug: 'alpha', mode: 'full', includeRaw: true });
    const { history: _history, ...document } = full.results[0];
    M.history.mockClear();
    const bodyOnly = await run({ slug: 'alpha', mode: 'full', includeRaw: true, includeHistory: false });
    expect(bodyOnly.results[0]).toEqual(document);
    expect(bodyOnly.results[0].raw).toBeTruthy();
    expect(bodyOnly.results[0].version).toBe(1);
    expect(M.history).not.toHaveBeenCalled();
    const again = await run({ slug: 'alpha', mode: 'full', includeRaw: true });
    expect(again.results[0].history).toEqual(_history);
    expect(M.history).toHaveBeenCalledOnce();
    expect(M.readPlanBySlug).toHaveBeenCalledOnce();
  });

  it('returns the full body before optional decorations and keeps the full cache key separate', async () => {
    const first = await run({
      slug: 'alpha',
      mode: 'full',
      includeRaw: true,
      includeHistory: false,
      includeEnrichments: false,
    });
    expect(first.results[0]).toMatchObject({ ok: true, raw: 'slug: alpha\n', enrichmentsDeferred: true });
    expect(first.results[0].items).toBeTruthy();
    expect(M.overlayIssueBlocksForPlan).not.toHaveBeenCalled();
    expect(M.getAcceptanceRubricForPlan).not.toHaveBeenCalled();
    expect(M.getLatestPlanAudit).not.toHaveBeenCalled();
    // A fast body defers lifecycle as well as the optional feature/test reads.
    expect(withWorkspace).not.toHaveBeenCalled();

    const decorated = await run({ slug: 'alpha', mode: 'full', includeRaw: true, includeHistory: false });
    expect(decorated.results[0].enrichmentsDeferred).toBeUndefined();
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(2);
    expect(M.overlayIssueBlocksForPlan).toHaveBeenCalledOnce();
    expect(M.getAcceptanceRubricForPlan).toHaveBeenCalledOnce();
    expect(M.getLatestPlanAudit).toHaveBeenCalledOnce();
    // Lifecycle + linkedFeatures; the planItemTests read is retired with inline VAL-*
    // (verification-system-improvements-2026-10-10 P-003).
    expect(withWorkspace).toHaveBeenCalledTimes(2);
  });

  it('still honors explicit history requests when the UI default omits incidental history', async () => {
    await run({ slug: 'alpha', heading: 'History', includeHistory: false });
    await run({ slug: 'alpha', priorAttemptRefs: ['WI-child#checkpoint'], includeHistory: false });
    expect(M.history).toHaveBeenCalledTimes(2);
    expect(M.historyRefs).toHaveBeenCalledOnce();
  });
  it('recovers a missing harness from an exact slug before reading the plan', async () => {
    M.planHarnessesForSlugs.mockResolvedValueOnce(new Map([['alpha', ['recovered-harness']]]));

    const body = await run({ slug: 'alpha' }, 'ws-get', '*');

    expect(M.planHarnessesForSlugs).toHaveBeenCalledWith('ws-get', ['alpha']);
    expect(M.ctxToPlanSourceOpts).toHaveBeenCalledWith(expect.objectContaining({ harnessSlug: 'recovered-harness' }));
    expect(body.results[0]).toMatchObject({ ok: true, slug: 'alpha' });
  });

  it('a repeat call for the same slug HITS (readPlanBySlug runs once)', async () => {
    await run({ slug: 'alpha' });
    await run({ slug: 'alpha' });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(1);
  });

  it('does not cache a not_found result when a later read succeeds', async () => {
    M.readPlanBySlug.mockResolvedValueOnce(null);

    const missing = await run({ slug: 'eventually-present' });
    expect(missing.results[0]).toMatchObject({
      ok: false,
      slug: 'eventually-present',
      error: 'not_found',
    });

    const recovered = await run({ slug: 'eventually-present' });
    expect(recovered.results[0]).toMatchObject({
      ok: true,
      slug: 'eventually-present',
    });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(2);
  });

  it('discloses an ambient-harness mismatch for an exact slug instead of a bare not_found', async () => {
    M.planHarnessesForSlugs.mockResolvedValueOnce(new Map([['foreign-plan', ['papercusp']]]));

    const body = await run({ slug: 'foreign-plan' }, 'ws-get', 'sb-devboard-hive');

    expect(body.results[0]).toMatchObject({
      ok: false,
      slug: 'foreign-plan',
      error: 'not_found',
      harness: 'sb-devboard-hive',
      harnessMismatch: {
        callerHarness: 'sb-devboard-hive',
        reportedHarness: 'papercusp',
        availableHarnesses: ['papercusp'],
      },
    });
    expect((body.results[0]?.harnessMismatch as { warning: string }).warning).toContain("Pass harness:'papercusp'");
    expect(M.readPlanBySlug).not.toHaveBeenCalled();
  });

  /**
   * EI-21449048020722730. The disclosure above used to be gated on `!args.harness`,
   * so naming the harness EXPLICITLY — what a carried checkpoint tells you to do —
   * returned a bare `not_found`. That reads as "no such plan" when the plan exists
   * in another harness, and it got the tool filed as broken. The more specific call
   * must not be the less informative one.
   */
  it('explains an EXPLICIT-harness miss instead of a bare not_found', async () => {
    M.readPlanBySlug.mockResolvedValueOnce(null);
    M.planHarnessesForSlugs.mockResolvedValueOnce(new Map([['foreign-plan', ['papercusp']]]));

    const body = await run({ slug: 'foreign-plan', harness: 'sb-devboard-hive' }, 'ws-get', 'sb-devboard-hive');

    expect(body.results[0]).toMatchObject({
      ok: false,
      slug: 'foreign-plan',
      error: 'not_found',
      harness: 'sb-devboard-hive',
      harnessMismatch: {
        callerHarness: 'sb-devboard-hive',
        reportedHarness: 'papercusp',
        availableHarnesses: ['papercusp'],
        harnessSource: 'explicit',
      },
    });
    // The remedy differs from the ambient one: an explicit caller can also just
    // drop the arg and let the slug index resolve the owner.
    expect((body.results[0]?.harnessMismatch as { warning: string }).warning).toContain('omit harness to auto-resolve');
    // Unlike the ambient pre-read check, the read IS attempted first.
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(1);
  });

  /**
   * Falsifiability control for the check's PLACEMENT (post-read, not pre-read).
   * If the explicit disclosure were hoisted to a pre-read check like the ambient
   * one, every explicit plans:get — the common case — would pay an uncached
   * slug-index round-trip ahead of a cache that exists to avoid exactly that.
   * This test fails if that happens; the test above cannot detect it.
   */
  it('an explicit-harness HIT consults no slug index', async () => {
    const body = await run({ slug: 'alpha', harness: 'papercup' }, 'ws-get', 'papercup');

    expect(body.results[0]).toMatchObject({ ok: true, slug: 'alpha' });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(1);
    expect(M.planHarnessesForSlugs).not.toHaveBeenCalled();
  });

  it('a harness_plans write BUSTS the entry (tag invalidation rebuilds)', async () => {
    await run({ slug: 'alpha' });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(1);
    getOperatorCache().invalidateByTags('ws-get', ['harness_plans']);
    await run({ slug: 'alpha' });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(2);
  });

  it('a plan_revisions write also busts (every tagged table invalidates)', async () => {
    await run({ slug: 'alpha' });
    getOperatorCache().invalidateByTags('ws-get', ['plan_revisions']);
    await run({ slug: 'alpha' });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(2);
  });

  it('a plan_audits write busts the entry so latestAudit cannot stay stale', async () => {
    await run({ slug: 'alpha' });
    expect(M.getLatestPlanAudit).toHaveBeenCalledTimes(1);
    getOperatorCache().invalidateByTags('ws-get', ['plan_audits']);
    await run({ slug: 'alpha' });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(2);
    expect(M.getLatestPlanAudit).toHaveBeenCalledTimes(2);
  });

  it('surfaces latestAudit beside acceptanceRubric in the structured read', async () => {
    const body = await run({ slug: 'alpha' });
    expect(body.results[0]).toMatchObject({
      acceptanceRubric: {
        rubricId: 'rubric-alpha',
        status: 'ratified',
        criteriaCount: 1,
        classRef: 'plan-class-code',
      },
      latestAudit: {
        planSlug: 'alpha',
        auditSeq: 7,
        auditedSha: 'abc123',
        items: [
          {
            itemId: 'P-001',
            auditedSha: 'abc123',
            citations: [{ kind: 'code', path: 'src/a.ts', blobSha: 'blob-a' }],
          },
        ],
      },
    });
    // EI-21124863090048444: harnessSlug is deliberately NOT passed — see the
    // comment on this call site in get.ts. `row.harnessSlug` is the plan's
    // Hive-home slug, not the audit's citation-context harness, so filtering on
    // it would silently drop a real audit recorded from a member/sub-harness.
    expect(M.getLatestPlanAudit).toHaveBeenCalledWith('alpha', {
      workspaceId: 'ws-get',
    });
  });

  it('surfaces exact activation-audit provenance only to judge callers', async () => {
    const ordinary = await run({ slug: 'alpha' });
    expect(ordinary.results[0]).not.toHaveProperty('latestActivationAudit');
    expect(M.getLatestActivationAudit).not.toHaveBeenCalled();

    const judged = await run({ slug: 'alpha' }, 'ws-get', 'papercup', 'judge');
    expect(judged.results[0]).toMatchObject({
      latestActivationAudit: {
        planSlug: 'alpha',
        auditSeq: 8,
        auditKind: 'activation',
        activation: {
          mappings: [{
            id: 'M-001',
            sourceRefs: ['session_turn:codex:owner-session:17'],
            requirement: 'Keep this plan item traceable to the owner request.',
            planTargets: ['P-009'],
            disposition: 'covered',
          }],
        },
      },
    });
    expect(M.getLatestActivationAudit).toHaveBeenCalledWith('alpha', { workspaceId: 'ws-get' });
  });

  it('opts into a fresh activation consult preview without caching its time-varying result', async () => {
    const first = await run({ slug: 'alpha', activationReadiness: true });

    expect(first.results[0]).toMatchObject({
      activationReadiness: {
        consult: { outcome: 'proceed', verdict: 'all_responders_paused' },
      },
    });
    expect(M.previewPlanStartConsult).toHaveBeenCalledWith({
      workspaceId: 'ws-get',
      requesterId: 'su-reader',
      planSlug: 'alpha',
      planContent: expect.stringContaining('slug: alpha'),
    });

    M.previewPlanStartConsult.mockResolvedValueOnce({
      outcome: 'nudge',
      candidates: [{ ownerId: 'su-peer', liveness: 'live' }],
      selection: { min: 1, max: 3, selected: [{ ownerId: 'su-peer', via: 'floor' }] },
    });
    const second = await run({ slug: 'alpha', activationReadiness: true });

    expect(second.results[0]).toMatchObject({
      activationReadiness: {
        consult: { outcome: 'nudge', candidates: [{ ownerId: 'su-peer' }] },
      },
    });
    expect(M.previewPlanStartConsult).toHaveBeenCalledTimes(2);
    // The ordinary plan body remains cached; the preview's uncached source read
    // is the deliberate time-varying boundary.
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(3);
  });

  it('does not evaluate activation readiness unless explicitly requested', async () => {
    await run({ slug: 'alpha' });
    expect(M.previewPlanStartConsult).not.toHaveBeenCalled();
  });

  it('surfaces the permanent forced-past marker on ordinary and meta reads', async () => {
    const sections = await run({ slug: 'alpha' });
    expect(sections.results[0]).toMatchObject({
      forcedPast: {
        count: 1,
        latest: {
          reason: 'auditor unavailable',
          checks: ['acceptance_unaudited'],
          forcedBy: { ownerId: 'su-forcer' },
        },
      },
    });

    const meta = await run({ slug: 'alpha', mode: 'meta' });
    expect(meta.results[0]).toMatchObject({ forcedPast: { count: 1 } });
  });

  it('keeps meta reads lean and does not fetch rubric/audit decorations', async () => {
    const body = await run({ slug: 'alpha', mode: 'meta' });
    expect(body.results[0]).not.toHaveProperty('acceptanceRubric');
    expect(body.results[0]).not.toHaveProperty('latestAudit');
    expect(M.getAcceptanceRubricForPlan).not.toHaveBeenCalled();
    expect(M.getLatestPlanAudit).not.toHaveBeenCalled();
  });

  it('different slugs do NOT share an entry (per-slug key)', async () => {
    await run({ slug: 'alpha' });
    await run({ slug: 'beta' });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(2);
    // each independently cached on repeat
    await run({ slug: 'alpha' });
    await run({ slug: 'beta' });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(2);
  });

  it('different mode does NOT share an entry (mode is in the key)', async () => {
    await run({ slug: 'alpha', mode: 'meta' });
    await run({ slug: 'alpha', mode: 'full' });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(2);
  });

  it('returns only requested plan items and reports missing ids without hiding the plan total', async () => {
    const body = await run({ slug: 'alpha', items: ['P-009', 'P-404'] });
    expect(body.results[0]).toMatchObject({
      counts: { items: 2 },
      itemSelection: {
        requested: ['P-009', 'P-404'],
        matched: ['P-009'],
        missing: ['P-404'],
      },
      items: [{ id: 'P-009', text: 'the item requested from a large plan' }],
    });
  });

  it('keeps item selections in separate cache entries', async () => {
    await run({ slug: 'alpha', items: ['P-001'] });
    await run({ slug: 'alpha', items: ['P-009'] });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(2);
  });

  it('returns selected decisions at full body with a narrow identity/CAS envelope', async () => {
    const body = await run({ slug: 'alpha', mode: 'full', decisionId: 'D-009' });
    const result = body.results[0]!;

    expect(result).toMatchObject({
      slug: 'alpha',
      harness: 'papercup',
      contentHash: expect.any(String),
      version: 1,
      counts: { items: 2, decisions: 2 },
      decisions: [
        {
          id: 'D-009',
          title: 'Selected ruling',
          body: 'The complete selected ruling body must remain intact, including its final sentence.',
          date: '2026-08-21',
          itemRefs: ['P-009'],
        },
      ],
      decisionSelection: {
        requested: ['D-009'],
        matched: ['D-009'],
        missing: [],
      },
    });
    expect(result).not.toHaveProperty('now');
    expect(result).not.toHaveProperty('items');
    expect(result).not.toHaveProperty('prose');
    expect(result).not.toHaveProperty('sectionIndex');
    expect(result).not.toHaveProperty('linkedFeatures');
    expect(result).not.toHaveProperty('latestAudit');
  });

  it('supports several decision ids and reports missing ids without truncating matched bodies', async () => {
    const body = await run({
      slug: 'alpha',
      decisions: ['D-009', 'D-404', 'D-001', 'D-009'],
    });

    expect(body.results[0]).toMatchObject({
      decisions: [
        { id: 'D-001', body: 'The complete first ruling body must remain intact.' },
        {
          id: 'D-009',
          body: 'The complete selected ruling body must remain intact, including its final sentence.',
        },
      ],
      decisionSelection: {
        requested: ['D-009', 'D-404', 'D-001'],
        matched: ['D-001', 'D-009'],
        missing: ['D-404'],
      },
    });
  });

  it('keeps decision selections in separate cache entries', async () => {
    await run({ slug: 'alpha', decisionId: 'D-001' });
    await run({ slug: 'alpha', decisionId: 'D-009' });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(2);
  });

  it('different workspaces do NOT share an entry (no cross-workspace leak)', async () => {
    await run({ slug: 'alpha' }, 'ws-A');
    await run({ slug: 'alpha' }, 'ws-B');
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(2);
    getOperatorCache().invalidateByTags('ws-A', ['harness_plans']);
    await run({ slug: 'alpha' }, 'ws-A');
    await run({ slug: 'alpha' }, 'ws-B');
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(3);
  });

  it('CACHE_LAYER OFF ⇒ bypass: readPlanBySlug runs on every call', async () => {
    setFlagOverridesForTest({ [CACHE_LAYER]: false });
    await _refreshCacheLayerForTests();
    await run({ slug: 'alpha' });
    await run({ slug: 'alpha' });
    await run({ slug: 'alpha' });
    expect(M.readPlanBySlug).toHaveBeenCalledTimes(3);
  });
});
