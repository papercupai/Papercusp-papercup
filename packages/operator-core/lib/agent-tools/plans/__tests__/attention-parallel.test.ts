/**
 * attention-parallel.test.ts — characterization test for plans:attention
 * (infra-perf-robustness-audit-2026-06-18 P-005). The handler aggregates ~10
 * independent sources; P-005 made the source reads CONCURRENT (Promise.all) to
 * cut the p50 ~2s latency. This is the safety net the (previously untested)
 * handler lacked: it pins that EVERY parallel source still contributes to the
 * output (a dropped/broken block would lose its items) and that the result shape
 * is intact. The mappers + grouping are REAL (pure); only the data sources are
 * mocked. Sources not under test return empty so the assertions are unambiguous.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock the source-helpers + every data source. The two under test
//    (escalations, conversations) return identifiable items; the rest are empty.
const M = vi.hoisted(() => ({
  readAllPlans: vi.fn(async () => [] as unknown[]),
  ctxToPlanSourceOpts: vi.fn(async () => ({})),
  planItemsToAttention: vi.fn(() => [] as unknown[]),
  ownerAttentionSourcesFor: vi.fn(() => [
    'needs-human-work-items',
    'owner-walls',
    'open-owner-questions',
    'open-owner-escalations',
    'pending-owner-gates',
  ]),
  listEscalations: vi.fn(async () => [] as unknown[]),
  listConversations: vi.fn(async () => [] as unknown[]),
  readInbox: vi.fn(async () => [] as unknown[]),
  readAckedMsgIds: vi.fn(async () => new Set<string>()),
  readNeedsHumanWorkItems: vi.fn(async () => [] as unknown[]),
  listOwnerWalls: vi.fn(async () => ({ walls: [] as unknown[] })),
  listPendingGates: vi.fn(async () => [] as unknown[]),
  resolveSessionStates: vi.fn(async () => new Map()),
}));

// NOTE: vi.mock paths resolve relative to THIS test file (one level deeper, in
// __tests__/), so they carry an extra `../` vs attention.ts's own import paths.
vi.mock('../source', () => ({ readAllPlans: M.readAllPlans }));
vi.mock('../_ctx-opts', () => ({ ctxToPlanSourceOpts: M.ctxToPlanSourceOpts }));
vi.mock('../../_harness-scope', async (orig) => {
  const actual = await orig<typeof import('../../_harness-scope')>();
  return { ...actual, harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx };
});
vi.mock('../../../attention/sources', async (orig) => {
  const actual = await orig<typeof import('../../../attention/sources')>();
  return { ...actual, planItemsToAttention: M.planItemsToAttention };
});
vi.mock('../../../interest-profiles', async (orig) => {
  const actual = await orig<typeof import('../../../interest-profiles')>();
  return { ...actual, ownerAttentionSourcesFor: M.ownerAttentionSourcesFor };
});
vi.mock('../../coordination/escalations', () => ({ listEscalations: M.listEscalations }));
vi.mock('../../coordination/conversations', () => ({ listConversationsWithTopics: M.listConversations }));
// Remaining sources → empty (no PG in the unit env).
vi.mock('../../coordination/messages', () => ({
  readInbox: M.readInbox,
  readAckedMsgIds: M.readAckedMsgIds,
}));
vi.mock('../../coordination/identity', () => ({ ADMIN_COORD_UI_OWNER: 'admin' }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: async () => [] }) };
});
vi.mock('../../../attention/operator-report-source', () => ({ readRecentOperatorReports: vi.fn(async () => []) }));
vi.mock('../../../attention/needs-human-work-items-source', () => ({
  readNeedsHumanWorkItems: M.readNeedsHumanWorkItems,
}));
// P-005b's owner-walls source reads live session briefs via coord — empty it out
// like every other not-under-test source (it would leak whatever walls agents
// happen to hold when the suite runs).
vi.mock('../../coordination/tools/walls', () => ({ listOwnerWalls: M.listOwnerWalls }));
vi.mock('../../../attention/gate-store', () => ({ listPendingGates: M.listPendingGates }));
vi.mock('../../coordination/liveness-oracle', async (orig) => {
  const actual = await orig<typeof import('../../coordination/liveness-oracle')>();
  return { ...actual, resolveSessionStates: M.resolveSessionStates };
});
vi.mock('../../../harness/improvements/read-items', () => ({ readImprovementItems: vi.fn(async () => []) }));
vi.mock('../../../operator-standing-candidates', () => ({ readCandidates: vi.fn(async () => []) }));
vi.mock('../../../scout/routed-ledger', () => ({ readRoutedIdeas: vi.fn(async () => []) }));
vi.mock('../../../plan-items/convert', () => ({ listConvertedPlanItemRefs: vi.fn(async () => new Set()) }));
vi.mock('../../../attention/triage-store', () => ({ readTriageByWorkspace: vi.fn(async () => new Map()) }));
// P-005c's dark-flag source reads the REAL static DARK_FLAGS map (no PG, so the
// db-org mock above doesn't intercept it) — empty it out here so it stays
// consistent with every other "not under test" source returning nothing.
vi.mock('@papercusp/flags', async (orig) => {
  const actual = await orig<typeof import('@papercusp/flags')>();
  return { ...actual, DARK_FLAGS: new Map() };
});

import tool from '../attention';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { resetOperatorCacheForTests } from '../../../cache';
import { _refreshCacheLayerForTests } from '../../../cache/instance';
import { currentRequestWorkspaceId } from '../../../workspace-als';

const CTX = {
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  metadata: vi.fn(),
  workspaceId: 'ws',
  role: 'operator' as const,
  principal: { slug: 'agent-test' },
} as never;

const run = async () => {
  // The handler returns a {data} envelope (context-trimming-tiers P-021) — the
  // dispatch layer serializes it per payload tier; tests read the data directly.
  const res = (await tool.handler({} as never, CTX)) as {
    data: {
      groups: Array<{
        items: Array<{
          id: string;
          kind: string;
          tier: string;
          needsHuman: boolean;
          status: string;
          body: string;
        }>;
      }>;
      tierCounts: Record<string, number>;
    };
  };
  return res.data;
};

const allItems = (p: Awaited<ReturnType<typeof run>>) => p.groups.flatMap((g) => g.items);

beforeEach(async () => {
  vi.clearAllMocks();
  M.readAllPlans.mockResolvedValue([]);
  M.ctxToPlanSourceOpts.mockResolvedValue({});
  M.planItemsToAttention.mockReturnValue([]);
  M.ownerAttentionSourcesFor.mockReturnValue([
    'needs-human-work-items',
    'owner-walls',
    'open-owner-questions',
    'open-owner-escalations',
    'pending-owner-gates',
  ]);
  M.listEscalations.mockResolvedValue([]);
  M.listConversations.mockResolvedValue([]);
  M.readInbox.mockResolvedValue([]);
  M.readAckedMsgIds.mockResolvedValue(new Set());
  M.readNeedsHumanWorkItems.mockResolvedValue([]);
  M.listOwnerWalls.mockResolvedValue({ walls: [] });
  M.listPendingGates.mockResolvedValue([]);
  M.resolveSessionStates.mockResolvedValue(new Map());
  // plans:attention now caches its aggregation (cache-expensive-tool-reads P-003);
  // this test characterizes the RAW source aggregation, so disable the cache (bypass)
  // + reset the singleton so each case re-runs every source with its freshly-set mocks.
  setFlagOverridesForTest({ 'papercusp-cache-layer': false });
  resetOperatorCacheForTests();
  await _refreshCacheLayerForTests();
});

// EI-18138040328678826: this suite never reset the flag override it sets above,
// leaking `{ 'papercusp-cache-layer': false }` into the module-level `overrides`
// singleton in `@papercusp/flags/test` — which is a real external-package module
// instance, NOT reset by vitest's per-file isolation for files sharing a forked
// worker (unlike this project's own local modules). Every sibling *.cache.test.ts
// in this repo resets via `afterEach(() => setFlagOverridesForTest(null))`; this
// file was the one outlier missing it, so it silently forced
// 'papercusp-cache-layer' off for whatever unit test file vitest happened to run
// next in the same worker.
afterEach(() => {
  setFlagOverridesForTest(null);
});

describe('plans:attention — parallel source aggregation (P-005)', () => {
  it('returns a well-formed { groups, tierCounts } shape even when every source is empty', async () => {
    const p = await run();
    expect(Array.isArray(p.groups)).toBe(true);
    expect(p.tierCounts).toBeTypeOf('object');
    expect(allItems(p)).toHaveLength(0);
  });

  it('consumes every canonical owner-present source row', async () => {
    await run();
    expect(M.ownerAttentionSourcesFor).toHaveBeenCalledWith('owner-present');
    expect(M.listEscalations).toHaveBeenCalledTimes(1);
    expect(M.listConversations).toHaveBeenCalledTimes(1);
    expect(M.readNeedsHumanWorkItems).toHaveBeenCalledTimes(1);
    expect(M.listOwnerWalls).toHaveBeenCalledTimes(1);
    expect(M.listPendingGates).toHaveBeenCalledTimes(1);
  });

  it('runs only the owner-attention source legs selected by the registry', async () => {
    M.ownerAttentionSourcesFor.mockReturnValue(['open-owner-questions']);
    await run();
    expect(M.listConversations).toHaveBeenCalledTimes(1);
    expect(M.listEscalations).not.toHaveBeenCalled();
    expect(M.readNeedsHumanWorkItems).not.toHaveBeenCalled();
    expect(M.listOwnerWalls).not.toHaveBeenCalled();
    expect(M.listPendingGates).not.toHaveBeenCalled();
  });

  it('passes pending-gate owners through the liveness oracle before projecting attention', async () => {
    const openedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    M.listPendingGates.mockResolvedValue([
      {
        session_id: 'sess-live',
        client: 'codex',
        ref_id: 'ref-live',
        kind: 'ask',
        question: 'continue?',
        owner_id: 'su-live',
        harness_slug: 'papercusp',
        opened_at: openedAt,
      },
      {
        session_id: 'sess-ended',
        client: 'codex',
        ref_id: 'ref-ended',
        kind: 'ask',
        question: 'old question',
        owner_id: 'su-ended',
        harness_slug: 'papercusp',
        opened_at: openedAt,
      },
    ]);
    M.resolveSessionStates.mockResolvedValue(
      new Map([
        ['su-live', { ownerId: 'su-live', sessionState: 'live' }],
        ['su-ended', { ownerId: 'su-ended', sessionState: 'ended' }],
      ]),
    );

    const items = allItems(await run()).filter((item) => item.kind === 'blocked-session');
    expect(items).toHaveLength(2);
    expect(M.resolveSessionStates).toHaveBeenCalledWith(
      [{ ownerId: 'su-live' }, { ownerId: 'su-ended' }],
      { hydratePerId: true },
    );

    const live = items.find((item) => item.id.includes('sess-live'))!;
    expect(live.tier).toBe('decision');
    expect(live.needsHuman).toBe(true);
    expect(live.status).toBe('blocked (codex)');

    const ended = items.find((item) => item.id.includes('sess-ended'))!;
    expect(ended.tier).toBe('alert');
    expect(ended.needsHuman).toBe(false);
    expect(ended.status).toBe('stranded (codex)');
    expect(ended.body).toContain('STRANDED');
  });

  // Owner-attention ledger (EI-23783029010995961): the owner's card says what happens if they never answer.
  it('discloses the default-if-unanswered on a needs-human work-item card, and says so when none is declared', async () => {
    const human = (ref: string, extra: Record<string, unknown> = {}) => ({
      kind: 'human',
      capability: 'product-decision',
      capabilitySource: 'explicit',
      ref,
      summary: 'Pick the pricing tier.',
      nextVerb: 'work_items:set_blocker { clear: true }',
      status: 'active',
      createdAt: '2026-10-01T00:00:00.000Z',
      createdBy: 'su-asker',
      updatedAt: '2026-10-01T00:00:00.000Z',
      ...extra,
    });
    const row = (id: string, summary: string | null, blocker: Record<string, unknown> | null) => ({
      feature_id: id,
      title: `title of ${id}`,
      summary,
      harness_slug: 'papercusp',
      item_kind: 'change',
      taken_by: null,
      payload: { needsHuman: true, ...(blocker ? { externalBlockers: [blocker] } : {}) },
      updated_ts: '2026-10-01T00:00:00.000Z',
      state_changed_at: '2026-10-01T00:00:00.000Z',
      status: 'open',
    });
    M.readNeedsHumanWorkItems.mockResolvedValue([
      row('WI-declared', 'The pricing question.', human('decision:a', { defaultIfUnanswered: 'proceeds with the cheaper tier', decideBy: '2026-10-15T00:00:00Z' })),
      row('WI-legacy', 'A legacy ask.', human('decision:b')),
      row('WI-no-blocker', null, null),
    ]);

    const items = allItems(await run()).filter((item) => item.kind === 'work-item-needs-human');
    const byId = (id: string) => items.find((item) => item.id === `work-item-needs-human:${id}`)!;
    expect(byId('WI-declared').body).toBe(
      'The pricing question.\n\nDefault if unanswered: proceeds with the cheaper tier (decide by 2026-10-15T00:00:00Z)',
    );
    expect(byId('WI-legacy').body).toBe(
      'A legacy ask.\n\nNo default declared — the item stays parked until you answer.',
    );
    // No summary and no typed ask: the card keeps its pre-existing title fallback, no invented disclosure.
    expect(byId('WI-no-blocker').body).toBe('title of WI-no-blocker');
  });

  it('aggregates items from MULTIPLE independent parallel sources (none dropped)', async () => {
    M.listEscalations.mockResolvedValue([
      { msg_id: 'esc-1', severity: 'critical', summary: 'an escalation', plan_slug: null, options: [], from: 'su-x' },
    ]);
    M.listConversations.mockResolvedValue([
      { id: 'conv-1', title: 'an open question', body: 'q?', asker_id: 'su-y', harness_slug: null, accepted_answer: null },
    ]);
    const p = await run();
    const ids = allItems(p).map((i) => i.id);
    // Both the escalation (block 2) AND the conversation (block 9) must surface —
    // proving the parallelized blocks each ran and contributed.
    expect(ids.some((id) => id.includes('esc-1'))).toBe(true);
    expect(ids.some((id) => id.includes('conv-1'))).toBe(true);
  });

  it('a source that throws does not block or fail the others (best-effort preserved)', async () => {
    M.listEscalations.mockRejectedValue(new Error('escalations source down'));
    M.listConversations.mockResolvedValue([
      { id: 'conv-2', title: 'still here', body: null, asker_id: null, harness_slug: null, accepted_answer: null },
    ]);
    const p = await run(); // must not throw despite block 2 rejecting
    const ids = allItems(p).map((i) => i.id);
    expect(ids.some((id) => id.includes('esc-1'))).toBe(false);
    expect(ids.some((id) => id.includes('conv-2'))).toBe(true); // the healthy parallel source still contributes
  });

  it('runs the source reads CONCURRENTLY, not sequentially', async () => {
    // Gate each source on a deferred promise; resolve them out of order. If the
    // handler awaited them sequentially it would deadlock (the 2nd never starts
    // until the 1st resolves) — concurrent start lets both be in-flight at once.
    let escStarted = false;
    let convStarted = false;
    M.listEscalations.mockImplementation(async () => {
      escStarted = true;
      // wait until the OTHER source has also started — only possible if concurrent
      for (let i = 0; i < 50 && !convStarted; i++) await Promise.resolve();
      return [];
    });
    M.listConversations.mockImplementation(async () => {
      convStarted = true;
      for (let i = 0; i < 50 && !escStarted; i++) await Promise.resolve();
      return [];
    });
    await run();
    expect(escStarted && convStarted).toBe(true);
  });

  it('EI-1541 regression: escalations + messages reads are pinned to the REQUEST workspace, not the ambient global', async () => {
    // The bug: listEscalations/readInbox read through coordLog, which resolves
    // its workspace partition from an AMBIENT (request-ALS) lookup with no
    // parameter of its own — so a source that forgot to pin the ALS around the
    // call would silently read whatever workspace happened to be ambient
    // (often the process-global registry workspace, not this request's ws).
    // Assert the ALS observed INSIDE each mocked read is exactly CTX.workspaceId.
    let seenDuringEscalations: string | undefined;
    let seenDuringInbox: string | undefined;
    M.listEscalations.mockImplementation(async () => {
      seenDuringEscalations = currentRequestWorkspaceId();
      return [];
    });
    M.readInbox.mockImplementation(async () => {
      seenDuringInbox = currentRequestWorkspaceId();
      return [];
    });
    await run(); // CTX.workspaceId = 'ws'
    expect(seenDuringEscalations).toBe('ws');
    expect(seenDuringInbox).toBe('ws');
  });
});
