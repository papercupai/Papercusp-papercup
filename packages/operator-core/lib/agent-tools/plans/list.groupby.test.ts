/**
 * plans:list — the groupBy/aggregateOnly aggregate path
 * (claimable-read-tool-and-sql-encapsulation-audit-2026-07-21 P-005).
 *
 * The contract this pins, in the order it can break:
 *  - the aggregate counts EVERY matched row, and `limit` bounds only the rows
 *    returned (the whole point — a limited aggregate is a WRONG answer, and it
 *    is the failure a naive "group the returned page" implementation gives);
 *  - aggregateOnly returns the groups with no rows, and skips the expensive
 *    per-plan item pass unless the dimension is item-derived (importance);
 *  - a call WITHOUT groupBy is byte-identical to before (no `groups` key);
 *  - group ordering is stable (count desc, ties alphabetical, null bucket last);
 *  - the cache does not serve a row-mode entry to an aggregate call.
 *
 * Drives the REAL handler against a mocked source layer (same seam as
 * list.cache.test.ts) so no PG is required.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const M = vi.hoisted(() => ({
  // vitest 4 infers a vi.fn mock's Parameters from its initial implementation
  // — a zero-arg arrow made `.mock.calls[N]` the empty tuple `[]`, so indexing
  // `?.[0]` on a call (below) failed to typecheck (TS2493) even though the real
  // listPlanIndexRows always takes one opts arg. An explicit unused param keeps
  // the mock body identical while giving `.mock.calls[N][0]` a real element type.
  listPlanIndexRows: vi.fn(async (_opts?: unknown) => [] as unknown[]),
  listPlanIndexRowsForWorkspace: vi.fn(async (_opts?: unknown) => [] as unknown[]),
  getPlanContentsBySlugs: vi.fn(async () => new Map<string, string>()),
  resolveHarnessPlansDir: vi.fn(async (slug: string) => ({
    harnessSlug: slug,
  })),
  ctxToPlanSourceOpts: vi.fn(async () => ({ harnessSlug: 'papercup' })),
  // P-007: the batched freshness/acceptance read is the only DB touch of the
  // derived lifecycle; the pure per-row derivation below it stays REAL.
  readPlanListLifecycleSignals: vi.fn(
    async (_input?: unknown): Promise<{
      activity: Map<string, { lastActivityAt: string | null; liveClaims: number }> | null;
      acceptance: Map<string, string> | null;
    }> => ({ activity: new Map(), acceptance: new Map() }),
  ),
}));

vi.mock('./source', async (orig) => {
  const actual = await orig<typeof import('./source')>();
  return {
    ...actual,
    listPlanIndexRows: M.listPlanIndexRows,
    listPlanIndexRowsForWorkspace: M.listPlanIndexRowsForWorkspace,
    getPlanContentsBySlugs: M.getPlanContentsBySlugs,
    resolveHarnessPlansDir: M.resolveHarnessPlansDir,
  };
});
vi.mock('./_ctx-opts', () => ({ ctxToPlanSourceOpts: M.ctxToPlanSourceOpts }));
vi.mock('./list-derived-lifecycle', async (orig) => {
  const actual = await orig<typeof import('./list-derived-lifecycle')>();
  return { ...actual, readPlanListLifecycleSignals: M.readPlanListLifecycleSignals };
});
vi.mock('../../issue-blocks-merge', async (orig) => {
  const actual = await orig<typeof import('../../issue-blocks-merge')>();
  return {
    ...actual,
    getAllBlockedPlanItems: vi.fn(async () => new Map<string, string[]>()),
  };
});
vi.mock('../../scout/routed-ledger', () => ({
  readScoutPlanRefs: vi.fn(async () => new Set<string>()),
  readRoutedIdeas: vi.fn(async () => []),
}));

import tool, { derivePlanTriggerSources } from './list';
import {
  resetOperatorCacheForTests,
  resetCachedReadStatsForTests,
  __setCachedReadEnabledForTests,
  setL2EnabledForTests,
} from '../../cache';
import { _refreshCacheLayerForTests } from '../../cache/instance';

const CACHE_LAYER = 'papercusp-cache-layer';

/** A minimal index row — only the columns plans:list projects. */
const row = (over: Record<string, unknown>): unknown => ({
  planSlug: 'p',
  title: 'P',
  status: 'active',
  created: '2026-07-01',
  updated: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  owner: null,
  initiative: null,
  template: null,
  forcedPast: null,
  archived: false,
  isLegacy: false,
  items: [],
  decisions: [],
  nowNext: null,
  opStatus: null,
  opPriority: null,
  schedule: null,
  scheduledAt: null,
  scheduleActive: false,
  hasInputSchema: false,
  hasExternalTrigger: false,
  isBlenderOrigin: false,
  harnessSlug: 'papercup',
  ...over,
});

const triggerRow = (over: Record<string, unknown> = {}) => row(over) as Parameters<typeof derivePlanTriggerSources>[0];

const ctx = (workspaceId = 'ws-groupby'): never =>
  ({
    workspaceId,
    harnessSlug: 'papercup',
    metadata: vi.fn(),
    log: vi.fn(),
    progress: vi.fn(),
  }) as never;

type ListResult = {
  data: { plans: unknown[]; groups?: Array<{ key: string | null; count: number }> };
};

const run = async (args: Record<string, unknown>): Promise<ListResult['data']> => {
  const res = (await tool.handler(args as never, ctx())) as ListResult;
  return res.data;
};

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(false);
  // This suite exercises L1 cache-key separation. plans:list also opts into
  // durable L2, whose rows intentionally survive both process restarts and
  // resetOperatorCacheForTests(); leaving it enabled lets an earlier test run's
  // ws-groupby fixture bypass today's source mock and makes this suite depend on
  // execution history instead of the key dimensions under test.
  setL2EnabledForTests(false);
  M.listPlanIndexRows.mockReset();
  M.listPlanIndexRows.mockResolvedValue([]);
  M.readPlanListLifecycleSignals.mockReset();
  M.readPlanListLifecycleSignals.mockResolvedValue({ activity: new Map(), acceptance: new Map() });
  setFlagOverridesForTest({ [CACHE_LAYER]: false });
  await _refreshCacheLayerForTests();
});

afterEach(async () => {
  setFlagOverridesForTest(null);
  await _refreshCacheLayerForTests();
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  setL2EnabledForTests(true);
});

describe('plans:list — groupBy aggregates', () => {
  it('derives one-time vs triggered from schedule, external binding, or either plan-input schema source', async () => {
    expect(derivePlanTriggerSources(triggerRow())).toEqual([]);
    expect(derivePlanTriggerSources(triggerRow({ schedule: { cron: '0 9 * * *' } }))).toEqual(['schedule']);
    expect(derivePlanTriggerSources(triggerRow({ hasExternalTrigger: true }))).toEqual(['external']);
    expect(derivePlanTriggerSources(triggerRow({ hasInputSchema: true }))).toEqual(['manual']);
    expect(derivePlanTriggerSources(triggerRow({ template: 'rubric' }))).toEqual(['manual']);

    M.listPlanIndexRows.mockResolvedValue([
      row({ planSlug: 'one-time' }),
      row({
        planSlug: 'all-three',
        schedule: { cron: '0 9 * * *' },
        hasExternalTrigger: true,
        hasInputSchema: true,
      }),
    ]);
    const { plans } = await run({});
    expect(plans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'one-time', triggered: false, triggerSources: [] }),
        expect.objectContaining({
          slug: 'all-three',
          triggered: true,
          triggerSources: ['schedule', 'external', 'manual'],
        }),
      ]),
    );
  });

  it('surfaces the permanent forced-past marker on each plan row', async () => {
    M.listPlanIndexRows.mockResolvedValue([
      row({
        planSlug: 'forced',
        forcedPast: {
          count: 1,
          latest: {
            reason: 'explicit exception',
            checks: ['audit_coverage_stale'],
            forcedAt: '2026-08-20T22:30:00.000Z',
            forcedBy: { ownerId: 'su-forcer', ownerLabel: 'Forcing agent' },
            legacy: false,
          },
        },
      }),
    ]);

    const { plans } = await run({});
    expect(plans[0]).toMatchObject({
      slug: 'forced',
      forcedPast: {
        count: 1,
        latest: { reason: 'explicit exception', checks: ['audit_coverage_stale'] },
      },
    });
  });

  it('counts every matched row per dimension value', async () => {
    M.listPlanIndexRows.mockResolvedValue([
      row({ planSlug: 'a', status: 'active' }),
      row({ planSlug: 'b', status: 'active' }),
      row({ planSlug: 'c', status: 'shipped' }),
    ]);
    const { groups } = await run({ groupBy: 'status' });
    expect(groups).toEqual([
      { key: 'active', count: 2 },
      { key: 'shipped', count: 1 },
    ]);
  });

  it('makes lifecycle contradictions filterable/groupable without misclassifying superseded plans', async () => {
    const liveItem = {
      id: 'P-001',
      text: 'still live',
      status: 'todo',
      importance: 'normal',
      blockedBy: [],
      decisionRefs: [],
      phase: null,
    };
    M.listPlanIndexRows.mockResolvedValue([
      row({ planSlug: 'superseded-abandonment', status: 'superseded', items: [liveItem] }),
      row({ planSlug: 'shipped-debt', status: 'shipped', items: [liveItem] }),
    ]);
    // A live claim on a linked work item is activity at read time, so the
    // shipped-with-live-items plan reads `active`, not merely stale.
    M.readPlanListLifecycleSignals.mockResolvedValue({
      activity: new Map([['shipped-debt', { lastActivityAt: null, liveClaims: 1 }]]),
      acceptance: new Map(),
    });

    const filtered = await run({ compact: true, lifecycleDisposition: 'contradicted', limit: 1 });
    expect(filtered.plans).toEqual([
      expect.objectContaining({
        slug: 'shipped-debt',
        derivedLifecycle: expect.objectContaining({
          verdict: 'active',
          liveClaims: 1,
          unmeasured: [],
          disposition: 'contradicted',
          contradiction: expect.objectContaining({ evidence: expect.stringContaining('1 of 1 items are still live') }),
        }),
      }),
    ]);
    // lifecycleDisposition is a JS post-filter: a SQL-side limit here would
    // inspect only the leading agreed row and fabricate an empty debt queue.
    expect(M.listPlanIndexRows.mock.calls[0]?.[0]).not.toHaveProperty('limit');

    const grouped = await run({ groupBy: 'lifecycleDisposition' });
    expect(grouped.groups).toEqual([
      { key: 'agreed', count: 1 },
      { key: 'contradicted', count: 1 },
    ]);
    expect(grouped.plans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: 'superseded-abandonment',
          derivedLifecycle: expect.objectContaining({ disposition: 'agreed' }),
        }),
      ]),
    );
  });

  it('filters and groups by the DERIVED lifecycle verdict, read from activity rather than stored status', async () => {
    const item = (status: string) => ({
      id: 'P-001',
      text: 'x',
      status,
      importance: 'normal',
      blockedBy: [],
      decisionRefs: [],
      phase: null,
    });
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    // Every plan's stored status says `active`; only the derived verdict tells them apart.
    M.listPlanIndexRows.mockResolvedValue([
      row({ planSlug: 'dormant', items: [item('todo')] }),
      row({ planSlug: 'claimed', items: [item('todo')] }),
      row({ planSlug: 'recent-work-item', items: [item('todo')] }),
      row({ planSlug: 'built', items: [item('done')] }),
      row({ planSlug: 'built-awaiting', items: [item('done')] }),
    ]);
    M.readPlanListLifecycleSignals.mockResolvedValue({
      activity: new Map([
        ['claimed', { lastActivityAt: null, liveClaims: 2 }],
        ['recent-work-item', { lastActivityAt: yesterday, liveClaims: 0 }],
      ]),
      acceptance: new Map([['built-awaiting', 'acceptance-built-awaiting']]),
    });

    // `lifecycle` is a JS post-filter, so `limit` must not be pushed into the SQL.
    const stalled = await run({ lifecycle: 'stalled', limit: 1 });
    expect(stalled.plans).toEqual([
      expect.objectContaining({
        slug: 'dormant',
        status: 'active',
        derivedLifecycle: expect.objectContaining({
          verdict: 'stalled',
          lastActivityAt: '2026-07-01T00:00:00.000Z',
          liveClaims: 0,
          unmeasured: [],
        }),
      }),
    ]);
    expect((stalled.plans[0] as { derivedLifecycle: { idleDays: number } }).derivedLifecycle.idleDays).toBeGreaterThan(30);
    expect(M.listPlanIndexRows.mock.calls[0]?.[0]).not.toHaveProperty('limit');
    expect(M.readPlanListLifecycleSignals).toHaveBeenCalledWith({
      workspaceId: 'ws-groupby',
      planSlugs: expect.arrayContaining(['dormant', 'claimed', 'recent-work-item', 'built', 'built-awaiting']),
    });

    const active = await run({ lifecycle: 'active' });
    expect(active.plans.map((p) => (p as { slug: string }).slug).sort()).toEqual(['claimed', 'recent-work-item']);

    const grouped = await run({ groupBy: 'lifecycle', aggregateOnly: true });
    expect(grouped.groups).toEqual([
      { key: 'active', count: 2 },
      { key: 'awaiting-acceptance', count: 1 },
      { key: 'implementation-complete', count: 1 },
      { key: 'stalled', count: 1 },
    ]);

    // compact rows carry the derived lifecycle too: liveness never falls back to `status`.
    const compact = await run({ compact: true });
    for (const plan of compact.plans as Array<{ itemCounts: unknown; derivedLifecycle: { verdict: string } }>) {
      expect(plan.itemCounts).toBeNull();
      expect(typeof plan.derivedLifecycle.verdict).toBe('string');
    }
  });

  it('reports a failed activity read as unmeasured instead of defaulting to no activity', async () => {
    M.listPlanIndexRows.mockResolvedValue([
      row({
        planSlug: 'unknown-activity',
        items: [{ id: 'P-001', text: 'x', status: 'todo', importance: 'normal', blockedBy: [], decisionRefs: [], phase: null }],
      }),
    ]);
    M.readPlanListLifecycleSignals.mockResolvedValue({ activity: null, acceptance: null });

    const { plans } = await run({});
    expect(plans[0]).toMatchObject({
      slug: 'unknown-activity',
      derivedLifecycle: { liveClaims: null },
    });
    expect((plans[0] as { derivedLifecycle: { unmeasured: string[] } }).derivedLifecycle.unmeasured).toContain(
      'linked-work-item',
    );
  });

  it('`limit` bounds the returned ROWS but never the aggregate', async () => {
    M.listPlanIndexRows.mockResolvedValue([
      row({ planSlug: 'a', status: 'active' }),
      row({ planSlug: 'b', status: 'active' }),
      row({ planSlug: 'c', status: 'shipped' }),
    ]);
    const { plans, groups } = await run({ groupBy: 'status', limit: 1 });
    expect(plans).toHaveLength(1);
    // The counts still cover all three — a limited aggregate would be wrong.
    expect(groups).toEqual([
      { key: 'active', count: 2 },
      { key: 'shipped', count: 1 },
    ]);
    // ...and the limit was NOT pushed into the SQL fetch (which would have
    // truncated the set the aggregate sees).
    expect(M.listPlanIndexRows.mock.calls[0]?.[0]).not.toHaveProperty('limit');
  });

  it('aggregateOnly returns the groups with no rows', async () => {
    M.listPlanIndexRows.mockResolvedValue([
      row({ planSlug: 'a', status: 'active' }),
      row({ planSlug: 'b', status: 'draft' }),
    ]);
    const { plans, groups } = await run({
      groupBy: 'status',
      aggregateOnly: true,
    });
    expect(plans).toEqual([]);
    expect(groups).toEqual([
      { key: 'active', count: 1 },
      { key: 'draft', count: 1 },
    ]);
  });

  it('aggregateOnly is ignored without groupBy (rows still come back)', async () => {
    M.listPlanIndexRows.mockResolvedValue([row({ planSlug: 'a' })]);
    const { plans, groups } = await run({ aggregateOnly: true });
    expect(plans).toHaveLength(1);
    expect(groups).toBeUndefined();
  });

  it('no groupBy ⇒ no `groups` key at all (unchanged shape)', async () => {
    M.listPlanIndexRows.mockResolvedValue([row({ planSlug: 'a' })]);
    const data = await run({});
    expect(data).not.toHaveProperty('groups');
  });

  it('buckets createdDay by UTC day, null bucket last', async () => {
    M.listPlanIndexRows.mockResolvedValue([
      row({ planSlug: 'a', created: '2026-07-01' }),
      row({ planSlug: 'b', created: '2026-07-01' }),
      row({ planSlug: 'c', created: '2026-07-02' }),
      row({ planSlug: 'd', created: null }),
    ]);
    const { groups } = await run({ groupBy: 'createdDay' });
    expect(groups).toEqual([
      { key: '2026-07-01', count: 2 },
      { key: '2026-07-02', count: 1 },
      { key: null, count: 1 },
    ]);
  });

  it('ties sort alphabetically, and the null bucket sorts last on a tie', async () => {
    M.listPlanIndexRows.mockResolvedValue([
      row({ planSlug: 'a', owner: 'zoe' }),
      row({ planSlug: 'b', owner: 'avi' }),
      row({ planSlug: 'c', owner: null }),
    ]);
    const { groups } = await run({ groupBy: 'owner' });
    expect(groups).toEqual([
      { key: 'avi', count: 1 },
      { key: 'zoe', count: 1 },
      { key: null, count: 1 },
    ]);
  });

  it('groups a boolean dimension into true/false buckets', async () => {
    M.listPlanIndexRows.mockResolvedValue([
      row({ planSlug: 'a', schedule: '0 * * * *' }),
      row({ planSlug: 'b' }),
      row({ planSlug: 'c' }),
    ]);
    const { groups } = await run({ groupBy: 'scheduled' });
    expect(groups).toEqual([
      { key: 'false', count: 2 },
      { key: 'true', count: 1 },
    ]);
  });

  it('groups origin from the canonical plan-content projection', async () => {
    M.listPlanIndexRows.mockResolvedValue([
      row({ planSlug: 'a', isBlenderOrigin: true }),
      row({ planSlug: 'b', isBlenderOrigin: false }),
      row({ planSlug: 'c' }),
    ]);
    const { groups, plans } = await run({ groupBy: 'origin' });
    expect(groups).toEqual([
      { key: null, count: 2 },
      { key: 'scout', count: 1 },
    ]);
    expect(plans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'a', origin: 'scout' }),
        expect.objectContaining({ slug: 'b', origin: null }),
      ]),
    );
  });

  it('an item-derived dimension (importance) still resolves items under aggregateOnly', async () => {
    M.listPlanIndexRows.mockResolvedValue([
      row({
        planSlug: 'a',
        items: [
          {
            id: 'P-001',
            text: 'x',
            status: 'todo',
            importance: 'high',
            blockedBy: [],
            decisionRefs: [],
            phase: null,
          },
        ],
      }),
      row({ planSlug: 'b', items: [] }),
    ]);
    const { groups } = await run({
      groupBy: 'importance',
      aggregateOnly: true,
    });
    // 'a' has an open high item; 'b' has no open items ⇒ null bucket.
    expect(groups).toEqual([
      { key: 'high', count: 1 },
      { key: null, count: 1 },
    ]);
  });
});

describe('plans:list — groupBy cache isolation', () => {
  beforeEach(async () => {
    __setCachedReadEnabledForTests(true);
    setFlagOverridesForTest({ [CACHE_LAYER]: true });
    await _refreshCacheLayerForTests();
  });

  afterEach(async () => {
    __setCachedReadEnabledForTests(false);
  });

  it('an aggregate call does NOT reuse the row-mode cache entry', async () => {
    M.listPlanIndexRows.mockResolvedValue([
      row({ planSlug: 'a', status: 'active' }),
      row({ planSlug: 'b', status: 'shipped' }),
    ]);
    const plain = await run({});
    expect(plain).not.toHaveProperty('groups');

    const agg = await run({ groupBy: 'status' });
    expect(agg.groups).toEqual([
      { key: 'active', count: 1 },
      { key: 'shipped', count: 1 },
    ]);

    // Distinct cache keys ⇒ the source was fetched once per mode.
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(2);

    // ...and each mode is independently cached on repeat.
    await run({});
    await run({ groupBy: 'status' });
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(2);
  });

  it('aggregateOnly gets its own entry (rows vs no-rows never collide)', async () => {
    M.listPlanIndexRows.mockResolvedValue([row({ planSlug: 'a' })]);
    const withRows = await run({ groupBy: 'status' });
    const noRows = await run({ groupBy: 'status', aggregateOnly: true });
    expect(withRows.plans).toHaveLength(1);
    expect(noRows.plans).toEqual([]);
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(2);
  });
});
