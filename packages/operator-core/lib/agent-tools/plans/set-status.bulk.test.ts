/**
 * set-status.bulk.test.ts — the plans:set-status HANDLER bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Sibling to set-status.test.ts (which
 * pins the pure helpers). Pins: inline { slug, item, status } → one result; the
 * itemIds:[…] (one plan) + items:[…] (heterogeneous) fan-out keyed by { slug, itemId
 * }; and a partial failure (one item_not_found) that fails ONLY itself — top-level
 * ok:true, counts.failed===1.
 *
 * The lock + revision + identity deps are mocked so this is a pure unit test (no PG).
 * resolveAgentIdentity is mocked to throw → agentId=null, which (by design) skips the
 * claim / auto-convert / terminal-grip discipline so the core flip + envelope is what
 * we exercise here; the discipline itself is covered by set-status.test.ts +
 * integration tests.
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/set-status.bulk.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRealPgRailBlocks } from '@papercusp/test-config/silenced-console-census';

afterAll(() => {
  const rail = readRealPgRailBlocks();
  expect(rail.blocked, `real-PG attempts blocked: ${rail.callers.join(' | ')}`).toBe(0);
});

// Keep the real `harnessArg` zod schema; only stub `harnessScopedCtx` so the test
// ctx (which carries no harnessSlug) does not trip the harness-required gate.
vi.mock('../_harness-scope', async (orig) => {
  const actual = await orig<typeof import('../_harness-scope')>();
  return {
    ...actual,
    harnessScopedCtx: (h: string | undefined, ctx: { workspaceId?: string; harnessSlug?: string }) =>
      ctx.workspaceId ? actual.harnessScopedCtx(h, ctx) : ctx,
  };
});
vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: (ctx: { harnessSlug?: string }) => ctx.harnessSlug ?? null }));
// WI-10008137: the draft-plan item-start gate has its own suite (draft-item-start-gate.test.ts).
vi.mock('./draft-item-start-gate', () => ({ checkDraftItemStartGateLive: vi.fn(async () => null) }));
const slugScopeM = vi.hoisted(() => ({ recover: vi.fn() }));
vi.mock('./slug-scope', async (orig) => ({
  ...(await orig<typeof import('./slug-scope')>()),
  recoverHarnessFromSlugs: slugScopeM.recover,
}));
vi.mock('./revisions', () => ({
  planRevisionCapture: () => ({ afterWrite: undefined, recorded: { current: null } }),
}));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: vi.fn(async () => {}) }));
vi.mock('./plan-item-events', () => ({ emitPlanItemDoneEvent: vi.fn(async () => {}) }));
vi.mock('../../plan-items/assignments', () => ({ unassignItem: vi.fn(async () => null) }));
// Control IO outcomes per case without re-importing the whole server graph.
const callerMocks = vi.hoisted(() => ({
  identity: vi.fn<() => { ownerId: string; ownerLabel: string; source: string }>(() => {
    throw new Error('no identity in this test');
  }),
  claimForWork: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  releaseOwnClaim: vi.fn(async () => true),
  convertPlanItem: vi.fn(),
  getFlag: vi.fn(async () => true),
}));
vi.mock('../../plan-items/convert', () => ({
  convertPlanItem: callerMocks.convertPlanItem,
  findConvertedWorkItemByStamp: vi.fn(async () => null),
  findCoverageWorkItems: vi.fn(async () => []),
  looksLikeResidualClosure: vi.fn(() => false),
  TERMINAL_WORK_ITEM_STATES: new Set(['passed', 'resolved', 'closed', 'done', 'deprecated', 'dropped']),
}));
// Ordinary envelope cases have no identity; the discipline cases opt in below.
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: callerMocks.identity,
  isEphemeralMcpCallIdentity: (id: string) => id.startsWith('mcp-call-'),
}));
vi.mock('../../plan-items/claim-discipline', () => ({
  claimForWork: callerMocks.claimForWork,
  releaseOwnClaim: callerMocks.releaseOwnClaim,
}));
vi.mock('./source', () => ({
  resolvePlanScope: vi.fn(async () => ({ workspaceId: 'default', harnessSlug: 'papercup' })),
}));
vi.mock('../../plan-items/agent-names', () => ({
  bestEffortOwnerUser: () => 'reader@example.com',
  resolveAdoptedName: vi.fn(async () => null),
  listSessionsForAgentName: vi.fn(async () => []),
}));
vi.mock('@papercusp/flags/server', () => ({ getFlag: callerMocks.getFlag }));
vi.mock('../coordination/holder-advisory', () => ({
  holderContextReader: () => null,
  resolveHolderAdvisory: vi.fn(async () => null),
}));
// The lock helper is the single seam: it invokes the mutator and we shape its result.
vi.mock('./with-plan-lock', () => ({
  withPlanLock: vi.fn(),
  bumpUpdatedDate: (s: string) => s,
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
const laneSync = vi.hoisted(() => ({
  item: vi.fn(async () => null),
  dependents: vi.fn(async () => [] as string[]),
  terminal: vi.fn(async () => ({
    planSlug: 'plan-a',
    itemId: 'P-001',
    reconciled: [],
    skippedInFlight: [],
    skippedAlreadyTerminal: [],
    skippedUnprovenLink: [],
    skippedGatedState: [],
  })),
}));
const planDrainMocks = vi.hoisted(() => ({
  planDrainTransitionMutationGated: vi.fn(async () => ({
    newBody: null,
    value: { applied: false, to: null },
  })),
}));
vi.mock('./plan-drain-transition', () => ({
  planDrainTransitionMutationGated: planDrainMocks.planDrainTransitionMutationGated,
}));
vi.mock('../../plan-items/reconcile-linked-work-items', () => ({
  findAllLinkedWorkItems: vi.fn(async () => []),
  reconcileLinkedWorkItemsForPlanItem: laneSync.terminal,
  resyncPlanItemLaneNow: laneSync.item,
  resyncDependentPlanItemLanesNow: laneSync.dependents,
}));

import { withPlanLock } from './with-plan-lock';
const lockM = vi.mocked(withPlanLock);
const tool = (await import('./set-status')).default;

type Out = { data: any };
const body = async (args: Record<string, unknown>, ctx: Record<string, unknown> = {}) =>
  (((await tool.handler(args as never, ctx as never)) as Out).data);

beforeEach(() => {
  vi.clearAllMocks();
  callerMocks.identity.mockImplementation(() => {
    throw new Error('no identity in this test');
  });
});

/** Drive the lock: run the mutator against a fake body, then return its ok-value as a
 *  successful lock outcome (or a not_found mutator-value for an unknown item). */
function lockReturnsMutatorValue(
  knownItems: Set<string>,
  options: { importanceByItem?: Record<string, string>; statusByItem?: Record<string, string> } = {},
) {
  lockM.mockImplementation(async (_ctx: unknown, opts: unknown, mutate: unknown) => {
    // `intent` carries the item id we're flipping: "plans:set-status P-NNN → status".
    const intent = (opts as { intent: string }).intent;
    const itemId = /P-\d{3,}/.exec(intent)?.[0] ?? '';
    const status = options.statusByItem?.[itemId] ?? 'todo';
    const importance = options.importanceByItem?.[itemId];
    const fakeBody = knownItems.has(itemId)
      ? `- **${itemId}** \`${status}\` x${importance ? ` importance: ${importance}` : ''}`
      : '';
    const lockScope = { workspaceId: 'default', harnessSlug: 'papercup' };
    const { value } = await (mutate as (
      body: string | null,
      metadata: unknown,
      scope: { workspaceId: string; harnessSlug: string },
    ) => Promise<{ value: unknown }>)(fakeBody, undefined, lockScope);
    return { kind: 'ok', value, filePath: 'plan.md' } as never;
  });
}

describe('plans:set-status handler (bulk keyed-array)', () => {
  it('recovers an unambiguous exact plan slug before a workspace-scoped status write', async () => {
    lockReturnsMutatorValue(new Set(['P-001']));
    slugScopeM.recover.mockResolvedValue({
      status: 'resolved',
      harnessSlug: 'papercusp',
      bySlug: { 'plan-a': 'papercusp' },
    });
    const metadata = vi.fn();
    const result = await body(
      { slug: 'plan-a', item: 'P-001', status: 'todo' },
      { workspaceId: 'papercusp-workspace', harnessSlug: '*', metadata },
    );
    expect(result.results[0]).toMatchObject({ ok: true, slug: 'plan-a', itemId: 'P-001' });
    expect(slugScopeM.recover).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'papercusp-workspace' }), ['plan-a']);
    expect(lockM).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ harnessSlug: 'papercusp' }), expect.anything());
    expect(metadata).toHaveBeenCalledWith({ harnessAutoResolved: { 'plan-a': 'papercusp' } });
  });

  it('refuses an ambiguous exact slug before any status write', async () => {
    slugScopeM.recover.mockResolvedValue({
      status: 'ambiguous',
      candidates: { 'plan-a': ['papercusp', 'other-harness'] },
      workspaceId: 'papercusp-workspace',
    });
    const result = await body(
      { slug: 'plan-a', item: 'P-001', status: 'todo' },
      { workspaceId: 'papercusp-workspace', harnessSlug: '*' },
    );
    expect(result.results[0]).toMatchObject({
      ok: false,
      error: 'plan_slug_ambiguous_across_harnesses',
      slug: 'plan-a',
      itemId: 'P-001',
    });
    expect(lockM).not.toHaveBeenCalled();
  });

  it('inline { slug, item, status } returns a single result', async () => {
    lockReturnsMutatorValue(new Set(['P-001']));
    const b = await body({ slug: 'plan-a', item: 'P-001', status: 'wip' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({
      ok: true,
      slug: 'plan-a',
      itemId: 'P-001',
      oldStatus: 'todo',
      newStatus: 'wip',
    });
    expect(laneSync.item).toHaveBeenCalledWith('plan-a', 'P-001', null, undefined);
    expect(laneSync.dependents).not.toHaveBeenCalled();
  });

  it('surfaces and logs a phase breakdown for a slow completed status write', async () => {
    lockReturnsMutatorValue(new Set(['P-001']));
    let tickMs = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
      tickMs += 3_000;
      return tickMs;
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const b = await body({ slug: 'plan-a', item: 'P-001', status: 'wip' });
      expect(b.results[0].slowPathTiming).toMatchObject({
        totalMs: expect.any(Number),
        phasesMs: {
          preWrite: expect.any(Number),
          planWrite: expect.any(Number),
          autoConvert: expect.any(Number),
          eventAndReconcile: expect.any(Number),
          finalize: expect.any(Number),
        },
      });
      expect(b.results[0].slowPathTiming.totalMs).toBeGreaterThanOrEqual(10_000);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('[plans:set-status] slow plan-a#P-001'));
    } finally {
      clock.mockRestore();
      warning.mockRestore();
    }
  });

  it('returns each item\'s stored importance for ordinary and terminal same-status flips', async () => {
    lockReturnsMutatorValue(new Set(['P-020', 'P-019']), {
      importanceByItem: { 'P-020': 'high', 'P-019': 'high' },
      statusByItem: { 'P-019': 'done' },
    });
    const b = await body({
      items: [
        { slug: 'plan-a', item: 'P-020', status: 'todo' },
        { slug: 'plan-a', item: 'P-019', status: 'done' },
      ],
    });

    expect(b.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: 'P-020', oldStatus: 'todo', newStatus: 'todo', importance: 'high' }),
        expect.objectContaining({ itemId: 'P-019', oldStatus: 'done', newStatus: 'done', importance: 'high' }),
      ]),
    );
  });

  it('itemIds:[…] flips many of one plan to the same status', async () => {
    lockReturnsMutatorValue(new Set(['P-001', 'P-002']));
    const b = await body({ slug: 'plan-a', itemIds: ['P-001', 'P-002'], status: 'done' });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { itemId: string }) => r.itemId)).toEqual(['P-001', 'P-002']);
    expect(b.results.every((r: { newStatus: string }) => r.newStatus === 'done')).toBe(true);
    expect(laneSync.item).not.toHaveBeenCalled();
    expect(laneSync.terminal).toHaveBeenNthCalledWith(
      1,
      { planSlug: 'plan-a', itemId: 'P-001', harnessSlug: null },
      { knownTerminalStatus: 'done' },
    );
    expect(laneSync.terminal).toHaveBeenNthCalledWith(
      2,
      { planSlug: 'plan-a', itemId: 'P-002', harnessSlug: null },
      { knownTerminalStatus: 'done' },
    );
    expect(laneSync.dependents).toHaveBeenNthCalledWith(1, 'plan-a', 'P-001', null, undefined);
    expect(laneSync.dependents).toHaveBeenNthCalledWith(2, 'plan-a', 'P-002', null, undefined);
  });

  it('awaits terminal reconciliation for dropped before returning', async () => {
    lockReturnsMutatorValue(new Set(['P-003']));
    const b = await body({
      slug: 'plan-a',
      item: 'P-003',
      status: 'dropped',
      note: 'Synthetic verification run is intentionally abandoned.',
    });

    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(planDrainMocks.planDrainTransitionMutationGated).toHaveBeenCalledWith(
      expect.any(String),
      { planSlug: 'plan-a', harnessSlug: 'papercup', workspaceId: 'default' },
    );
    expect(laneSync.terminal).toHaveBeenCalledWith(
      { planSlug: 'plan-a', itemId: 'P-003', harnessSlug: null },
      { knownTerminalStatus: 'dropped' },
    );
    expect(laneSync.item).not.toHaveBeenCalled();
    expect(laneSync.terminal.mock.invocationCallOrder[0]).toBeLessThan(
      laneSync.dependents.mock.invocationCallOrder[0]!,
    );
  });

  it('items:[…] heterogeneous; per-item status overrides the batch default', async () => {
    lockReturnsMutatorValue(new Set(['P-001', 'P-002']));
    const b = await body({
      slug: 'plan-a',
      status: 'done',
      items: [
        { slug: 'plan-a', item: 'P-001' },
        { slug: 'plan-b', item: 'P-002', status: 'blocked' },
      ],
    });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results[0]).toMatchObject({ slug: 'plan-a', itemId: 'P-001', newStatus: 'done' });
    expect(b.results[1]).toMatchObject({ slug: 'plan-b', itemId: 'P-002', newStatus: 'blocked' });
  });

  it('a partial failure (one unknown item) fails ONLY itself — batch survives', async () => {
    lockReturnsMutatorValue(new Set(['P-001'])); // P-099 is unknown → item_not_found
    const b = await body({ slug: 'plan-a', itemIds: ['P-001', 'P-099'], status: 'wip' });
    expect(b.ok).toBe(false); // DERIVED from counts.failed — one item failed
    expect(b.counts).toEqual({ ok: 1, failed: 1 }); // …but the batch still RAN: P-001 succeeded
    expect(b.results[0]).toMatchObject({ ok: true, itemId: 'P-001' });
    expect(b.results[1]).toMatchObject({ ok: false, slug: 'plan-a', itemId: 'P-099', error: 'item_not_found' });
  });

  it('a busy lock maps to that item\'s { ok:false, error:"busy" } without throwing', async () => {
    lockM.mockResolvedValue({ kind: 'busy', busy: [{ path: 'p', owner: 'o', owner_label: 'o', intent: 'i', expires_ts: new Date(1), holder_snapshot: null }] });
    const b = await body({ slug: 'plan-a', item: 'P-001', status: 'wip' });
    expect(b.ok).toBe(false); // DERIVED from counts.failed — the sole item failed
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, slug: 'plan-a', itemId: 'P-001', error: 'busy' });
  });

  it('requires a nonblank reason for dropped before any write-side work', async () => {
    lockReturnsMutatorValue(new Set(['P-001']));
    const b = await body({
      slug: 'plan-a',
      item: 'P-001',
      status: 'dropped',
      note: '   ',
      rationale: '\n',
    });
    expect(b).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({
      ok: false,
      slug: 'plan-a',
      itemId: 'P-001',
      error: 'dropped_reason_required',
    });
    expect(b.results[0].hint).toMatch(/note.*rationale/);
    expect(lockM).not.toHaveBeenCalled();
  });

  it.each([
    ['note', { note: 'Superseded by the recorded D-009 decision.' }],
    ['rationale', { rationale: 'Scope deliberately moved to a follow-up plan.' }],
  ])('accepts a dropped reason supplied via %s', async (_label, reason) => {
    lockReturnsMutatorValue(new Set(['P-001']));
    const b = await body({ slug: 'plan-a', item: 'P-001', status: 'dropped', ...reason });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, itemId: 'P-001', newStatus: 'dropped' });
  });

  it('fails only the reasonless drop in a heterogeneous batch', async () => {
    lockReturnsMutatorValue(new Set(['P-001', 'P-002']));
    const b = await body({
      items: [
        { slug: 'plan-a', item: 'P-001', status: 'dropped' },
        { slug: 'plan-a', item: 'P-002', status: 'done' },
      ],
    });
    expect(b).toMatchObject({ ok: false, counts: { ok: 1, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: false, itemId: 'P-001', error: 'dropped_reason_required' });
    expect(b.results[1]).toMatchObject({ ok: true, itemId: 'P-002', newStatus: 'done' });
  });
});

// EI-8509: refuse ephemeral identities before writing or claiming. All cases
// reuse the real handler and controllable IO seams; resetting the module graph
// repeats unrelated server startup and breaks the fixture's zero-PG contract.
describe('plans:set-status →wip auto-claim refuses the mcp-call.mjs fallback identity (EI-8509)', () => {
  it('refuses the wip flip and never reaches the lock/claim path', async () => {
    callerMocks.identity.mockReturnValue({ ownerId: 'mcp-call-42', ownerLabel: 'su · mcp-call-42', source: 'omp-hook-session' });
    const b = await body({ slug: 'plan-a', item: 'P-001', status: 'wip' });

    expect(b).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({
      ok: false,
      slug: 'plan-a',
      itemId: 'P-001',
      error: 'ephemeral_mcp_call_identity',
    });
    expect(b.results[0].hint).toMatch(/mcp-call\.mjs/);
    expect(lockM).not.toHaveBeenCalled();
    expect(callerMocks.claimForWork).not.toHaveBeenCalled();
  });
});

describe('plans:set-status failed wip flips release new claims (WI-10002606)', () => {
  it('releases a new claim and skips auto-conversion when the plan is missing', async () => {
    callerMocks.identity.mockReturnValue({ ownerId: 'su-test-owner', ownerLabel: 'su · test', source: 'omp-hook-session' });
    lockM.mockResolvedValue({ kind: 'ok', value: { ok: false, code: 'not_found' } } as never);
    callerMocks.claimForWork.mockResolvedValue({ ok: true, claimId: 'claim-1', alreadyHeld: false });
    const b = await body({ slug: 'missing-plan', item: 'P-999', status: 'wip' });

    expect(b).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({
      ok: false,
      slug: 'missing-plan',
      itemId: 'P-999',
      error: 'not_found',
      claimReleased: true,
    });
    expect(callerMocks.claimForWork).toHaveBeenCalledTimes(1);
    expect(callerMocks.releaseOwnClaim).toHaveBeenCalledWith('default', 'papercup', 'missing-plan', 'P-999', 'su-test-owner');
    expect(callerMocks.getFlag).not.toHaveBeenCalled();
    expect(callerMocks.convertPlanItem).not.toHaveBeenCalled();
  });
});

describe('plans:set-status claim-conflict guidance for linked claim holds', () => {
  async function invokeWipRefusal(claimOutcome: unknown) {
    callerMocks.identity.mockReturnValue({ ownerId: 'su-reader', ownerLabel: 'su · reader', source: 'omp-hook-session' });
    callerMocks.claimForWork.mockResolvedValue(claimOutcome);
    return (await body({ slug: 'plan-a', item: 'P-001', status: 'wip' })).results[0];
  }

  it('names the hold_open repair instead of inventing a live peer for a holderless park', async () => {
    const claimHold = {
      workItemId: 'WI-anonymous-park',
      provenance: { heldOpen: null, parked: null, attributed: false },
    };
    const result = await invokeWipRefusal({
      ok: false,
      reason: 'work item WI-anonymous-park is parked by claimHold',
      claimHold,
    });

    expect(result).toMatchObject({
      error: 'claim_conflict',
      holder: null,
      claimHold,
    });
    expect(result.hint).toContain('work_items:hold_open');
    expect(result.hint).toContain('WI-anonymous-park');
    expect(result.hint).not.toMatch(/live peer/i);
  });

  it('checks holder presence before peer coordination when the refusal returns a lease', async () => {
    const result = await invokeWipRefusal({
      ok: false,
      reason: 'claimed by su · peer — coordinate with the holder or pick another item',
      holder: { owner: 'su-peer', ownerLabel: 'su · peer', intent: 'working P-001', expiresTs: 'later' },
    });

    expect(result.hint).toContain('coord:presence');
    expect(result.hint).toContain('coordinate with the holder if that session is live');
    expect(result.hint).toContain('coord:send');
    expect(result).not.toHaveProperty('claimHold');
  });
});
