/**
 * plan-item-lane-guard.test.ts — pins planItemLaneBlockReason (WI-3667): a
 * plan-linked work-item whose linked PLAN ITEM is effectively blocked (stored
 * 'blocked' token, an unresolved blocked-by dep, or a needs-human derivation)
 * must be reported as blocked; anything else (no plan_item payload, plan/item
 * not found, a lookup throw) must fail OPEN (null) — the guard is a courtesy,
 * never a hard floor that can wedge the shared claim path.
 *
 * getPlanRow + the plan-parser resolver are mocked so this is a pure unit test
 * (no PG). Run: cd packages/operator-core && npx vitest run lib/scheduler/plan-item-lane-guard.test.ts
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const getPlanRowMock = vi.fn();
const planItemsForRowMock = vi.fn((row: unknown) => (row as { items: unknown[] }).items);

vi.mock('../agent-tools/plans/source', () => ({
  getPlanRow: (...args: unknown[]) => getPlanRowMock(...args),
  // planItemsForRow is a genuine single-arg function (row: PlanRow) — spreading
  // an `unknown[]` into a fixed one-parameter mock impl is what TS2556's about
  // ("a spread argument must either have a tuple type or be passed to a rest
  // parameter"); pass the single arg straight through instead of spreading.
  planItemsForRow: (row: unknown) => planItemsForRowMock(row),
}));

// Use the REAL resolver — resolveEffectiveStatusForItems is pure and cheap, and
// exercising it end-to-end is the point (the blocked-by graph logic itself is
// pinned by plan-parser's own tests; we only need it wired correctly here).
vi.mock('@papercusp/plan-parser', async (orig) => orig<typeof import('@papercusp/plan-parser')>());

// EI-13738: the DB-column linkage half (source_plan_slug/source_plan_item_ids on
// harness_features_consolidated) — the columns the LIVE promote.ts path actually
// writes. A plain tagged-template-shaped fake: it ignores the query strings/values
// entirely (mirrors the existing work-items-urgent.test.ts fakeSql pattern), so a
// nested `sql\`...\`` fragment interpolated into the outer query just resolves to
// whatever the fake currently returns — harmless, since we never parse the SQL.
let fakeSourcePlanRow: { source_plan_slug: string | null; source_plan_item_ids: string[] | null } | null = null;
let fakeSqlError: Error | null = null;
const fakeSql = Object.assign(
  vi.fn(async () => {
    if (fakeSqlError) throw fakeSqlError;
    return fakeSourcePlanRow ? [fakeSourcePlanRow] : [];
  }),
  { unsafe: vi.fn(async () => []) },
);
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: fakeSql }),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../issues-engineer', () => ({ issuesScopeWorkspace: () => 'ws-issue-test' }));

import { planItemLaneBlockReason, planItemNeedsHumanContradiction } from './plan-item-lane-guard';

function planItem(overrides: Partial<{ id: string; storedStatus: string; blockedBy: string[]; text: string }> = {}) {
  return {
    id: 'P-001',
    text: 'an item',
    storedStatus: 'todo',
    importance: 'normal',
    blockedBy: [],
    decisionRefs: [],
    phase: null,
    ...overrides,
  };
}

// Most tests below exercise the payload-back-pointer path (extractPlanItemStampFromPayload
// succeeds first, so id/family are never actually read) — a fixed, meaningless-but-typed
// stand-in keeps every call site satisfying planItemLaneBlockReason's
// Pick<WorkItem, 'payload' | 'harness' | 'id' | 'family'> without cluttering each call.
const UNUSED_ID = 'WI-unused';
const UNUSED_FAMILY = 'feature' as const;

describe('planItemLaneBlockReason', () => {
  beforeEach(() => {
    getPlanRowMock.mockReset();
    planItemsForRowMock.mockReset();
    planItemsForRowMock.mockImplementation((row: unknown) => (row as { items: unknown[] }).items);
    fakeSourcePlanRow = null;
    fakeSqlError = null;
    fakeSql.mockClear();
  });

  it('requires complete plan evidence for audits while retaining scheduler fail-open behavior', async () => {
    const item = { payload: {}, harness: 'papercusp', sourcePlanSlug: 'audit-plan', sourcePlanItemIds: ['P-001', 'P-002'] };
    const strict = { requireCompleteEvidence: true };
    for (const row of [null, { status: 'paused', items: [planItem()] },
      { status: 'active', items: [planItem()] }]) {
      getPlanRowMock.mockResolvedValue(row);
      await expect(planItemLaneBlockReason(item, strict)).rejects.toThrow();
      await expect(planItemLaneBlockReason(item)).resolves.toBeNull();
    }
    getPlanRowMock.mockRejectedValue(new Error('plan unavailable'));
    await expect(planItemLaneBlockReason(item, strict)).rejects.toThrow('plan unavailable');
    await expect(planItemLaneBlockReason(item)).resolves.toBeNull();
    getPlanRowMock.mockResolvedValue({ status: 'active', items: [planItem(), planItem({ id: 'P-002' })], decisions: [] });
    await expect(planItemLaneBlockReason(item, strict)).resolves.toBeNull();
    getPlanRowMock.mockResolvedValue({ status: 'active', items: [planItem(), planItem({ id: 'P-002' })],
      decisions: [{ itemRefs: ['P-002'], title: 'Owner-gated', body: 'Wait for owner approval.' }] });
    await expect(planItemLaneBlockReason(item, strict)).resolves.toMatchObject({ itemId: 'P-002', reason: expect.stringContaining('owner-gated') });
  });

  it('returns null when the work-item carries no plan_item payload', async () => {
    const got = await planItemLaneBlockReason({ payload: {}, harness: 'papercusp', id: UNUSED_ID, family: UNUSED_FAMILY });
    expect(got).toBeNull();
    expect(getPlanRowMock).not.toHaveBeenCalled();
  });

  it('returns null when payload is not an object / plan_item is malformed', async () => {
    expect(
      await planItemLaneBlockReason({ payload: null, harness: 'papercusp', id: UNUSED_ID, family: UNUSED_FAMILY }),
    ).toBeNull();
    expect(
      await planItemLaneBlockReason({
        payload: { plan_item: { plan_slug: 'p' } },
        harness: 'papercusp',
        id: UNUSED_ID,
        family: UNUSED_FAMILY,
      }),
    ).toBeNull();
  });

  it('returns null when the linked plan cannot be found (fail open)', async () => {
    getPlanRowMock.mockResolvedValue(null);
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'missing-plan', item_id: 'P-001' } },
      harness: 'papercusp',
      id: UNUSED_ID,
      family: UNUSED_FAMILY,
    });
    expect(got).toBeNull();
  });

  it('returns null when the plan exists but the item id is not found (fail open)', async () => {
    getPlanRowMock.mockResolvedValue({ items: [planItem({ id: 'P-002' })] });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-001' } },
      harness: 'papercusp',
      id: UNUSED_ID,
      family: UNUSED_FAMILY,
    });
    expect(got).toBeNull();
  });

  it('reports blocked for an item carrying the stored blocked token', async () => {
    getPlanRowMock.mockResolvedValue({ items: [planItem({ id: 'P-503', storedStatus: 'blocked' })] });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'p2p-git-live-activation-2026-07-09', item_id: 'P-503' } },
      harness: 'papercusp',
      id: UNUSED_ID,
      family: UNUSED_FAMILY,
    });
    expect(got).not.toBeNull();
    expect(got?.effectiveStatus).toBe('blocked');
    expect(got?.planSlug).toBe('p2p-git-live-activation-2026-07-09');
    expect(got?.itemId).toBe('P-503');
    expect(got?.reason).toMatch(/effectively blocked/);
    expect(got).not.toHaveProperty('blockAttributedToWorkItemId');
  });

  it('marks a sole stored block as attributable only when its live note names this work-item', async () => {
    const workItemId = 'WI-1733069';
    getPlanRowMock.mockResolvedValue({
      items: [
        planItem({
          id: 'P-003',
          storedStatus: 'blocked',
          text: `an item — note: ← ${workItemId} blocked (1 external blocker)`,
        }),
      ],
    });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-003' } },
      harness: 'papercusp',
      id: workItemId,
      family: UNUSED_FAMILY,
    });
    expect(got?.effectiveStatus).toBe('blocked');
    expect(got?.blockAttributedToWorkItemId).toBe(workItemId);
  });

  it('reports blocked for an item blocked-by an unresolved dependency', async () => {
    getPlanRowMock.mockResolvedValue({
      items: [
        planItem({ id: 'P-001', storedStatus: 'todo' }), // the unresolved blocker
        planItem({ id: 'P-002', storedStatus: 'todo', blockedBy: ['P-001'] }),
      ],
    });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-002' } },
      harness: 'papercusp',
      id: UNUSED_ID,
      family: UNUSED_FAMILY,
    });
    expect(got?.reason).toMatch(/blocked-by: P-001/);
    expect(got).not.toHaveProperty('blockAttributedToWorkItemId');
  });

  it('does not mark a needs-human lane as a self-attributed clear', async () => {
    const workItemId = 'WI-1733069';
    getPlanRowMock.mockResolvedValue({
      items: [
        planItem({
          id: 'P-004',
          storedStatus: 'needs-human',
          text: `an item — note: ← ${workItemId} needs-human (owner decision)`,
        }),
      ],
    });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-004' } },
      harness: 'papercup',
      id: workItemId,
      family: UNUSED_FAMILY,
    });
    expect(got?.effectiveStatus).toBe('needs-human');
    expect(got).not.toHaveProperty('blockAttributedToWorkItemId');
  });

  it('does not attribute one blocked lane when another linked plan item is also blocked', async () => {
    const workItemId = 'WI-1733069';
    getPlanRowMock.mockResolvedValue({
      items: [
        planItem({
          id: 'P-005',
          storedStatus: 'blocked',
          text: `first item — note: ← ${workItemId} blocked (1 external blocker)`,
        }),
        planItem({ id: 'P-006', storedStatus: 'blocked', text: 'second blocked item' }),
      ],
    });
    const got = await planItemLaneBlockReason({
      payload: null,
      harness: 'papercup',
      id: workItemId,
      family: UNUSED_FAMILY,
      sourcePlanSlug: 'a-plan',
      sourcePlanItemIds: ['P-005', 'P-006'],
    });
    expect(got?.effectiveStatus).toBe('blocked');
    expect(got).not.toHaveProperty('blockAttributedToWorkItemId');
  });

  // WI-7316: the lane guard already resolves `staleBlockedHint` (resolveEffectiveStatusForItems
  // computes it in the same pass it computes effectiveStatus) and used to DROP it. Carrying it on
  // the block is what lets scheduler:get_next / work_items:claimable tell a genuinely drained lane
  // apart from one held shut by a sticky token nothing will ever clear on its own.
  //
  // The pair below is the point: the same `blocked` verdict, once WITH a contradiction and once
  // WITHOUT. If the hint were unconditionally populated (or unconditionally null) exactly one of
  // these two would still pass, which is what makes them a falsifiable pair rather than one test.
  describe('staleBlockedHint pass-through (WI-7316)', () => {
    it('carries the hint when the stored blocked token contradicts a fully-resolved blocked-by set', async () => {
      getPlanRowMock.mockResolvedValue({
        items: [
          planItem({ id: 'P-001', storedStatus: 'done' }), // resolved
          planItem({ id: 'P-002', storedStatus: 'dropped' }), // resolved
          planItem({ id: 'P-003', storedStatus: 'blocked', blockedBy: ['P-001', 'P-002'] }),
        ],
      });
      const got = await planItemLaneBlockReason({
        payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-003' } },
        harness: 'papercusp',
        id: UNUSED_ID,
        family: UNUSED_FAMILY,
      });
      expect(got?.effectiveStatus).toBe('blocked');
      expect(got?.itemId).toBe('P-003');
      // The hint must name the resolved dependencies and the remedy — this is the whole payload a
      // self-selecting member gets, and "is effectively blocked" alone is what sent it to re-poll.
      expect(got?.staleBlockedHint).toEqual(expect.stringContaining('P-001, P-002'));
      expect(got?.staleBlockedHint).toMatch(/already resolved/);
      expect(got?.staleBlockedHint).toMatch(/plans:set-status/);
      // And the trap this closes: with every blocker resolved the reason carries NO blocked-by
      // list, so the caller sees a bare "effectively blocked" with nothing to wait on. Pinning
      // the absence keeps the hint load-bearing rather than merely redundant with `reason`.
      expect(got?.reason).not.toMatch(/blocked-by:/);
    });

    it('leaves the hint null for an ORDINARY block with a genuinely unresolved dependency', async () => {
      getPlanRowMock.mockResolvedValue({
        items: [
          planItem({ id: 'P-001', storedStatus: 'todo' }), // still unresolved — a real blocker
          planItem({ id: 'P-002', storedStatus: 'blocked', blockedBy: ['P-001'] }),
        ],
      });
      const got = await planItemLaneBlockReason({
        payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-002' } },
        harness: 'papercusp',
        id: UNUSED_ID,
        family: UNUSED_FAMILY,
      });
      expect(got?.effectiveStatus).toBe('blocked');
      // Null is the load-bearing value: an honest block is correct, self-clearing, and already
      // explained by `reason`'s blocked-by list. Surfacing a hint here would turn the rare,
      // actionable "this will never clear itself" signal into routine noise on every pull.
      expect(got?.staleBlockedHint).toBeNull();
      expect(got?.reason).toMatch(/blocked-by: P-001/);
    });

    it('carries a null hint on a cleanly-terminal residue block', async () => {
      getPlanRowMock.mockResolvedValue({ items: [planItem({ id: 'P-009', storedStatus: 'done' })] });
      const got = await planItemLaneBlockReason({
        payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-009' } },
        harness: 'papercusp',
        id: UNUSED_ID,
        family: UNUSED_FAMILY,
      });
      // The field is REQUIRED on the interface, so every branch must set it explicitly — this
      // pins that the terminal/residue branch returns the resolver's value rather than
      // accidentally omitting the key (which reads as `undefined`, not `null`, to a consumer).
      expect(got?.effectiveStatus).toBe('done');
      expect(got).toHaveProperty('staleBlockedHint', null);
    });
  });

  it('returns null once the blocker resolves (done)', async () => {
    getPlanRowMock.mockResolvedValue({
      items: [
        planItem({ id: 'P-001', storedStatus: 'done' }),
        planItem({ id: 'P-002', storedStatus: 'todo', blockedBy: ['P-001'] }),
      ],
    });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-002' } },
      harness: 'papercusp',
      id: UNUSED_ID,
      family: UNUSED_FAMILY,
    });
    expect(got).toBeNull();
  });

  // EI-13337/13352/13267/14693: the linked plan item is already terminal (done),
  // but the work-item is still todo — stale residue the fleet must not re-work.
  it('reports terminal for an item whose own plan item is already done', async () => {
    getPlanRowMock.mockResolvedValue({ items: [planItem({ id: 'P-018', storedStatus: 'done' })] });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'agent-operability-improvements-implementation-2026-07-13', item_id: 'P-018' } },
      harness: 'papercusp',
      id: UNUSED_ID,
      family: UNUSED_FAMILY,
    });
    expect(got).not.toBeNull();
    expect(got?.effectiveStatus).toBe('done');
    expect(got?.itemId).toBe('P-018');
    expect(got?.reason).toMatch(/already done/);
    expect(got?.reason).toMatch(/stale residue/);
  });

  it('reports terminal for an item whose own plan item is dropped', async () => {
    getPlanRowMock.mockResolvedValue({ items: [planItem({ id: 'P-007', storedStatus: 'dropped' })] });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-007' } },
      harness: 'papercusp',
      id: UNUSED_ID,
      family: UNUSED_FAMILY,
    });
    expect(got).not.toBeNull();
    expect(got?.effectiveStatus).toBe('dropped');
    expect(got?.reason).toMatch(/already dropped/);
  });

  // The item's OWN done status blocks it; but a done item used only as a BLOCKER
  // must still UNblock its dependents (guarded by the existing blocker-resolves
  // test) — this pins that we didn't over-broaden into that case.
  it('does not report terminal for a todo item merely blocked-by a done item', async () => {
    getPlanRowMock.mockResolvedValue({
      items: [
        planItem({ id: 'P-001', storedStatus: 'done' }),
        planItem({ id: 'P-002', storedStatus: 'todo', blockedBy: ['P-001'] }),
      ],
    });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-002' } },
      harness: 'papercusp',
      id: UNUSED_ID,
      family: UNUSED_FAMILY,
    });
    expect(got).toBeNull();
  });

  it('reports needs-human for an item carrying the stored needs-human token', async () => {
    getPlanRowMock.mockResolvedValue({ items: [planItem({ id: 'P-009', storedStatus: 'needs-human' })] });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-009' } },
      harness: 'papercusp',
      id: UNUSED_ID,
      family: UNUSED_FAMILY,
    });
    expect(got?.reason).toMatch(/needs a human decision/);
  });

  it('fails open when the plan lookup throws', async () => {
    getPlanRowMock.mockRejectedValue(new Error('pg unavailable'));
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-001' } },
      harness: 'papercusp',
      id: UNUSED_ID,
      family: UNUSED_FAMILY,
    });
    expect(got).toBeNull();
  });

  it('returns null for a clear (todo, unblocked) item', async () => {
    getPlanRowMock.mockResolvedValue({ items: [planItem({ id: 'P-001', storedStatus: 'todo' })] });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-001' } },
      harness: 'papercusp',
      id: UNUSED_ID,
      family: UNUSED_FAMILY,
    });
    expect(got).toBeNull();
  });

  // EI-9108: regression, mirroring the REAL 2026-07-10 incident shape (p2p-git-live-
  // activation-2026-07-09, P-401/WI-3503) — a 7-deep blockedBy chain
  // (P-401→P-308→{P-302..P-307}→P-301→{P-205,P-101}→P-101→P-003), where P-003 (the true
  // root cause) is still `wip`. work_item.state alone (plain 'todo') would surface P-401
  // as scheduler-claimable; this pins that the guard correctly walks the FULL chain depth
  // (not just a direct one-hop blockedBy) and reports it blocked.
  it('reports blocked through a deep multi-level blockedBy chain (EI-9108, real P-401 shape)', async () => {
    getPlanRowMock.mockResolvedValue({
      items: [
        planItem({ id: 'P-003', storedStatus: 'wip' }), // true root cause: still in-flight
        planItem({ id: 'P-101', storedStatus: 'todo', blockedBy: ['P-003'] }),
        planItem({ id: 'P-205', storedStatus: 'done' }),
        planItem({ id: 'P-301', storedStatus: 'done', blockedBy: ['P-205', 'P-101'] }),
        planItem({ id: 'P-302', storedStatus: 'todo', blockedBy: ['P-301'] }),
        planItem({ id: 'P-303', storedStatus: 'todo', blockedBy: ['P-301'] }),
        planItem({ id: 'P-304', storedStatus: 'todo', blockedBy: ['P-301'] }),
        planItem({ id: 'P-305', storedStatus: 'todo', blockedBy: ['P-301'] }),
        planItem({ id: 'P-306', storedStatus: 'todo', blockedBy: ['P-301'] }),
        planItem({ id: 'P-307', storedStatus: 'done', blockedBy: ['P-301'] }),
        planItem({
          id: 'P-308',
          storedStatus: 'todo',
          blockedBy: ['P-302', 'P-303', 'P-304', 'P-305', 'P-306', 'P-307'],
        }),
        planItem({ id: 'P-401', storedStatus: 'todo', blockedBy: ['P-308'] }),
      ],
    });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'p2p-git-live-activation-2026-07-09', item_id: 'P-401' } },
      harness: 'papercusp',
      id: UNUSED_ID,
      family: UNUSED_FAMILY,
    });
    expect(got).not.toBeNull();
    expect(got?.effectiveStatus).toBe('blocked');
    expect(got?.itemId).toBe('P-401');
    // The IMMEDIATE unresolved blocker is P-308 (this level's own blockedBy) — the chain
    // walk resolves recursively, but the reported reason names the direct dependency, not
    // the transitive root (P-003). That's fine: the guard's job is "don't hand this out",
    // not "explain the whole chain" — plans:get-item/plans:items are where an agent
    // traces the full unresolvedBlockers path back to the true root cause.
    expect(got?.reason).toMatch(/blocked-by: P-308/);
  });

  // EI-9107: the TWIN incident — the same 2026-07-10 plan (p2p-git-live-activation-
  // 2026-07-09), but the item scheduler:get_next actually handed out was P-308 itself
  // (WI-3502), one level DOWN the chain from EI-9108's P-401. P-308's work_item.state was
  // plain 'todo' (rank 0, set by the mug) so the coarse SQL floors surfaced it as
  // claimable, while its plan-item is blocked-by an UNRESOLVED multi-blocker set
  // (P-302..P-306, each still todo pending P-301←P-101←P-003). This pins that the guard
  // reports P-308 blocked and names the full unresolved-blocker set — not just the deep
  // P-401 case the EI-9108 test above covers.
  it('reports blocked for P-308 with its full unresolved-blocker set (EI-9107, real WI-3502 shape)', async () => {
    getPlanRowMock.mockResolvedValue({
      items: [
        planItem({ id: 'P-003', storedStatus: 'wip' }), // true root cause: still in-flight
        planItem({ id: 'P-101', storedStatus: 'todo', blockedBy: ['P-003'] }),
        planItem({ id: 'P-205', storedStatus: 'done' }),
        planItem({ id: 'P-301', storedStatus: 'done', blockedBy: ['P-205', 'P-101'] }),
        planItem({ id: 'P-302', storedStatus: 'todo', blockedBy: ['P-301'] }),
        planItem({ id: 'P-303', storedStatus: 'todo', blockedBy: ['P-301'] }),
        planItem({ id: 'P-304', storedStatus: 'todo', blockedBy: ['P-301'] }),
        planItem({ id: 'P-305', storedStatus: 'todo', blockedBy: ['P-301'] }),
        planItem({ id: 'P-306', storedStatus: 'todo', blockedBy: ['P-301'] }),
        planItem({ id: 'P-307', storedStatus: 'done', blockedBy: ['P-301'] }),
        planItem({
          id: 'P-308',
          storedStatus: 'todo', // the live work-item state that made it scheduler-claimable
          blockedBy: ['P-302', 'P-303', 'P-304', 'P-305', 'P-306', 'P-307'],
        }),
      ],
    });
    const got = await planItemLaneBlockReason({
      payload: { plan_item: { plan_slug: 'p2p-git-live-activation-2026-07-09', item_id: 'P-308' } },
      harness: 'papercusp',
      id: UNUSED_ID,
      family: UNUSED_FAMILY,
    });
    expect(got).not.toBeNull();
    expect(got?.effectiveStatus).toBe('blocked');
    expect(got?.itemId).toBe('P-308');
    // P-307 is done, so it drops out of the unresolved set; the reason names exactly the
    // still-open blockers the incident reported (P-302..P-306).
    expect(got?.reason).toMatch(/blocked-by: P-302, P-303, P-304, P-305, P-306/);
  });

  // EI-13738: the DB-column linkage half. The LIVE promotion path (promote.ts /
  // POST /features/import) writes source_plan_slug/source_plan_item_ids on the
  // family-specific work-item view with NO payload.plan_item stamp — so a
  // work-item exactly like the real WI-3503/WI-3502 incidents (P-401/P-308, no
  // payload back-pointer) must still resolve via the DB columns.
  describe('DB-column linkage (source_plan_slug/source_plan_item_ids, EI-13738)', () => {
    it('returns null for an issue-family item with no source_plan_slug', async () => {
      fakeSourcePlanRow = { source_plan_slug: null, source_plan_item_ids: null };
      const got = await planItemLaneBlockReason({
        payload: {},
        harness: 'papercusp',
        id: 'EI-1',
        family: 'issue',
      });
      expect(got).toBeNull();
      expect(fakeSql).toHaveBeenCalled();
      expect(getPlanRowMock).not.toHaveBeenCalled();
    });

    it('returns null when the feature carries no source_plan_slug (unplanned/standalone work)', async () => {
      fakeSourcePlanRow = { source_plan_slug: null, source_plan_item_ids: null };
      const got = await planItemLaneBlockReason({
        payload: {},
        harness: 'papercusp',
        id: 'WI-9001',
        family: 'feature',
      });
      expect(got).toBeNull();
      expect(getPlanRowMock).not.toHaveBeenCalled();
    });

    it('reports blocked via the DB-column linkage — the real WI-3503/P-401 shape (no payload stamp)', async () => {
      fakeSourcePlanRow = {
        source_plan_slug: 'p2p-git-live-activation-2026-07-09',
        source_plan_item_ids: ['P-401'],
      };
      getPlanRowMock.mockResolvedValue({
        items: [
          planItem({ id: 'P-308', storedStatus: 'todo', blockedBy: [] }),
          planItem({ id: 'P-401', storedStatus: 'todo', blockedBy: ['P-308'] }),
        ],
      });
      const got = await planItemLaneBlockReason({
        payload: {}, // no payload.plan_item — the live promote.ts path never stamps it
        harness: 'papercusp',
        id: 'WI-3503',
        family: 'feature',
      });
      expect(got).not.toBeNull();
      expect(got?.effectiveStatus).toBe('blocked');
      expect(got?.planSlug).toBe('p2p-git-live-activation-2026-07-09');
      expect(got?.itemId).toBe('P-401');
      expect(getPlanRowMock).toHaveBeenCalledWith(
        'p2p-git-live-activation-2026-07-09',
        expect.objectContaining({ harnessSlug: 'papercusp' }),
      );
    });

    it('reports blocked for issue-family linkage from engineer_issues (EI-21412238917469513)', async () => {
      fakeSourcePlanRow = {
        source_plan_slug: 'handoff-release-plan',
        source_plan_item_ids: ['P-001'],
      };
      getPlanRowMock.mockResolvedValue({
        items: [planItem({ id: 'P-001', storedStatus: 'blocked' })],
      });
      const got = await planItemLaneBlockReason({
        payload: {},
        harness: 'papercup',
        id: 'EI-21412238917469513',
        family: 'issue',
      });
      expect(got).not.toBeNull();
      expect(got?.effectiveStatus).toBe('blocked');
      expect(got?.planSlug).toBe('handoff-release-plan');
      expect(got?.itemId).toBe('P-001');
      expect(fakeSql).toHaveBeenCalled();
    });

    it('prefers the payload back-pointer over the DB columns when both are present (cheap path first, no I/O)', async () => {
      getPlanRowMock.mockResolvedValue({ items: [planItem({ id: 'P-001', storedStatus: 'blocked' })] });
      const got = await planItemLaneBlockReason({
        payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-001' } },
        harness: 'papercusp',
        id: 'WI-1',
        family: 'feature',
      });
      expect(got?.effectiveStatus).toBe('blocked');
      expect(fakeSql).not.toHaveBeenCalled();
    });

    it('checks EVERY linked item id when source_plan_item_ids carries several — one blocked gates the whole work-item', async () => {
      fakeSourcePlanRow = { source_plan_slug: 'multi-plan', source_plan_item_ids: ['P-001', 'P-002'] };
      getPlanRowMock.mockResolvedValue({
        items: [
          planItem({ id: 'P-001', storedStatus: 'done' }),
          planItem({ id: 'P-002', storedStatus: 'blocked' }),
        ],
      });
      const got = await planItemLaneBlockReason({
        payload: {},
        harness: 'papercusp',
        id: 'WI-multi',
        family: 'feature',
      });
      expect(got).not.toBeNull();
      expect(got?.itemId).toBe('P-002');
      expect(got?.effectiveStatus).toBe('blocked');
    });

    it('reports stale-residue terminal ONLY when EVERY linked item id is terminal', async () => {
      fakeSourcePlanRow = { source_plan_slug: 'multi-plan', source_plan_item_ids: ['P-001', 'P-002'] };
      getPlanRowMock.mockResolvedValue({
        items: [
          planItem({ id: 'P-001', storedStatus: 'done' }),
          planItem({ id: 'P-002', storedStatus: 'todo' }), // still real open work
        ],
      });
      const got = await planItemLaneBlockReason({
        payload: {},
        harness: 'papercusp',
        id: 'WI-partial',
        family: 'feature',
      });
      expect(got).toBeNull(); // not ALL linked items are terminal — genuinely open work

      fakeSourcePlanRow = { source_plan_slug: 'multi-plan', source_plan_item_ids: ['P-003', 'P-004'] };
      getPlanRowMock.mockResolvedValue({
        items: [
          planItem({ id: 'P-003', storedStatus: 'done' }),
          planItem({ id: 'P-004', storedStatus: 'dropped' }),
        ],
      });
      const gotAllTerminal = await planItemLaneBlockReason({
        payload: {},
        harness: 'papercusp',
        id: 'WI-all-terminal',
        family: 'feature',
      });
      expect(gotAllTerminal).not.toBeNull();
      expect(gotAllTerminal?.reason).toMatch(/stale residue/);
    });

    it('fails open when the DB column lookup throws', async () => {
      fakeSqlError = new Error('pg unavailable');
      const got = await planItemLaneBlockReason({
        payload: {},
        harness: 'papercusp',
        id: 'WI-err',
        family: 'feature',
      });
      expect(got).toBeNull();
    });
  });

  // EI-13780: a `todo`-status plan item whose plan PROSE marks it owner-gated /
  // hard-deferred — no structural effectiveStatus/needsHuman signal at all — must
  // still be reported, exactly the two real near-misses (WI-357/P-008,
  // WI-1774/P-003) that motivated this.
  describe('owner-gate prose markers (EI-13780)', () => {
    it("reports owner-gated for an item whose OWN text carries an inline marker (WI-357/P-008 shape)", async () => {
      getPlanRowMock.mockResolvedValue({
        items: [
          planItem({
            id: 'P-008',
            storedStatus: 'todo',
            text: 'DS-3 SERVICE rename systemd papercup-*→papercusp-* … (Owner-gated: needs a coordinated quiescent window dev-api/inference-gateway/bg-host restarts bounce the whole live fleet. Not auto-executable. See WI-357 thread + HANDOFF runbook.)',
          }),
        ],
      });
      const got = await planItemLaneBlockReason({
        payload: { plan_item: { plan_slug: 'papercup-physical-rename-phase5-2026-06-20', item_id: 'P-008' } },
        harness: 'papercusp',
        id: UNUSED_ID,
        family: UNUSED_FAMILY,
      });
      expect(got).not.toBeNull();
      expect(got?.itemId).toBe('P-008');
      expect(got?.effectiveStatus).toBe('todo');
      expect(got?.reason).toMatch(/owner-gated \("owner-gated"\)/);
    });

    // EI-18754937921052867: an item's OWN text describing a FEATURE's semantics
    // ("...disabled when push is owner-gated.") must NOT false-gate the item —
    // the marker there is a predicate about "push", not a label about the item.
    it('does NOT gate an item whose OWN text merely describes owner-gating as a feature/spec detail', async () => {
      getPlanRowMock.mockResolvedValue({
        items: [
          planItem({
            id: 'P-002',
            storedStatus: 'todo',
            text: 'Report git-sync health via a derived enum: health=stalled when pushLagSec far exceeds the sync interval; disabled when push is owner-gated.',
          }),
        ],
      });
      const got = await planItemLaneBlockReason({
        payload: { plan_item: { plan_slug: 'git-pipeline-agent-state-2026-07-26', item_id: 'P-002' } },
        harness: 'papercusp',
        id: UNUSED_ID,
        family: UNUSED_FAMILY,
      });
      expect(got).toBeNull();
    });

    it("reports owner-gated for an item named (by id) in the plan's ## Now block (WI-1774/P-003 shape)", async () => {
      getPlanRowMock.mockResolvedValue({
        items: [planItem({ id: 'P-003', storedStatus: 'todo', text: 'W1.1 — Zero-downtime :3070 deploy' })],
        nowState: "su-01386 [AUTO, route A]. Engine loop loop:end'd — no eligible work left.",
        nowNext:
          'NOTHING for su to auto-do: the only open items are P-003 (W1.1 zero-downtime deploy) + P-004 (W5 event-loop scale-out), both HARD-DEFERRED to an owner-attended session (:3170-only, high-stakes, never auto-flip).',
      });
      const got = await planItemLaneBlockReason({
        payload: { plan_item: { plan_slug: 'backend-reliability-100pct-2026-07-03', item_id: 'P-003' } },
        harness: 'papercusp',
        id: UNUSED_ID,
        family: UNUSED_FAMILY,
      });
      expect(got).not.toBeNull();
      expect(got?.itemId).toBe('P-003');
      expect(got?.reason).toMatch(/owner-gated \("hard-deferred"\)/);
    });

    it('does NOT block an unrelated todo item merely because the Now block gates a DIFFERENT item in the same plan', async () => {
      getPlanRowMock.mockResolvedValue({
        items: [
          planItem({ id: 'P-003', storedStatus: 'todo' }),
          planItem({ id: 'P-099', storedStatus: 'todo', text: 'an unrelated, freely-workable item' }),
        ],
        nowState: '',
        nowNext: 'P-003 is HARD-DEFERRED to an owner-attended session, never auto-flip.',
      });
      const got = await planItemLaneBlockReason({
        payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-099' } },
        harness: 'papercusp',
        id: UNUSED_ID,
        family: UNUSED_FAMILY,
      });
      expect(got).toBeNull();
    });

    // EI-18718822565695446: the Now-block marker search used to be evaluated over
    // the WHOLE block independently of the item mention, so one genuinely gated
    // item false-gated every other item the block named. The real case: the
    // shared-hive plan's Now block enumerated P-007/P-008/P-009 as the next
    // actionable work AND separately noted P-019's genuine owner gate — which
    // made the plan's own declared-next work unpickable via self-select.
    describe('Now-block marker locality (EI-18718822565695446)', () => {
      const SHARED_HIVE_NOW_NEXT =
        'Phase 1 (DHT/discovery cost) is the next actionable block: P-007 (multiplex discovery.refresh() into ONE shared loop), P-008 (topic-level backoff), P-009 (drop the per-topic announce fanout).\n' +
        'P-019 remains owner-gated — it needs the live 2-machine Hetzner rig.';

      const sharedHivePlan = () => ({
        items: [
          planItem({ id: 'P-007', storedStatus: 'todo', text: 'Multiplex DHT discovery.refresh() into ONE shared loop.' }),
          planItem({ id: 'P-008', storedStatus: 'todo', text: 'Topic-level backoff.' }),
          planItem({ id: 'P-009', storedStatus: 'todo', text: 'Drop the per-topic announce fanout.' }),
          planItem({ id: 'P-019', storedStatus: 'todo', text: 'Two-machine federation soak.' }),
        ],
        nowState: '',
        nowNext: SHARED_HIVE_NOW_NEXT,
      });

      it('does NOT gate an item the Now block names as ACTIONABLE when the marker belongs to a different item', async () => {
        getPlanRowMock.mockResolvedValue(sharedHivePlan());
        const got = await planItemLaneBlockReason({
          payload: { plan_item: { plan_slug: 'shared-hive-cross-machine-scale-10k-2026-06-29', item_id: 'P-007' } },
          harness: 'papercusp',
          id: UNUSED_ID,
          family: UNUSED_FAMILY,
        });
        expect(got).toBeNull();
      });

      it('still gates the item the marker IS about, from the same Now block', async () => {
        getPlanRowMock.mockResolvedValue(sharedHivePlan());
        const got = await planItemLaneBlockReason({
          payload: { plan_item: { plan_slug: 'shared-hive-cross-machine-scale-10k-2026-06-29', item_id: 'P-019' } },
          harness: 'papercusp',
          id: UNUSED_ID,
          family: UNUSED_FAMILY,
        });
        expect(got).not.toBeNull();
        expect(got?.itemId).toBe('P-019');
        expect(got?.reason).toMatch(/owner-gated \("owner-gated"\)/);
      });

      // Guards the FALSE-NEGATIVE direction the locality fix could otherwise
      // introduce — handing genuinely owner-gated work to a self-selector is
      // worse than over-gating. When the block names no OTHER item, a marker in
      // a separate sentence is still unambiguously about the one item it names.
      it('gates when the mention and the marker are in SEPARATE sentences and no other item is named', async () => {
        getPlanRowMock.mockResolvedValue({
          items: [planItem({ id: 'P-019', storedStatus: 'todo', text: 'Two-machine federation soak.' })],
          nowState: '',
          nowNext: 'P-019 is the only remaining item. It is owner-gated until the rig exists.',
        });
        const got = await planItemLaneBlockReason({
          payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-019' } },
          harness: 'papercusp',
          id: UNUSED_ID,
          family: UNUSED_FAMILY,
        });
        expect(got).not.toBeNull();
        expect(got?.itemId).toBe('P-019');
      });

    // EI-19968471075842609: the locality fix above scopes a marker to the
    // sentence naming the item, but the marker itself was matched by SPELLING —
    // `'non-owner-gated'.includes('owner-gated')` — so a clause written to say an
    // item is explicitly NOT gated gated every item its sentence named. Measured
    // on semantic-search-fingerprint-coverage-2026-08-03, whose Now `Next` called
    // P-011 "the closest surviving non-owner-gated lever" in the sentence that
    // also named P-033 and P-012: work_items:complete then refused to close a
    // FINISHED P-033, quoting "owner-gated" as though it came from the item.
    describe('negated markers (EI-19968471075842609)', () => {
      const NEGATED_NOW_NEXT =
        'Otherwise P-033 (agent-insights docs for this plan, in progress), then P-011 (phrase-aware query building — the closest surviving non-owner-gated lever on Report 1) and P-012 (an embedding leg for the work_item source).';

      const negatedPlan = () => ({
        items: [
          planItem({ id: 'P-011', storedStatus: 'todo', text: 'Phrase-aware query building.' }),
          planItem({ id: 'P-012', storedStatus: 'todo', text: 'An embedding leg for the work_item source.' }),
          planItem({ id: 'P-033', storedStatus: 'todo', text: 'Write the agent-insights docs.' }),
        ],
        nowState: '',
        nowNext: NEGATED_NOW_NEXT,
      });

      it.each(['P-033', 'P-011', 'P-012'])(
        'does NOT gate %s on a "non-owner-gated" mention asserting the opposite',
        async (itemId) => {
          getPlanRowMock.mockResolvedValue(negatedPlan());
          const got = await planItemLaneBlockReason({
            payload: { plan_item: { plan_slug: 'semantic-search-fingerprint-coverage-2026-08-03', item_id: itemId } },
            harness: 'papercusp',
            id: UNUSED_ID,
            family: UNUSED_FAMILY,
          });
          expect(got).toBeNull();
        },
      );

      // CONTROL. Without this, the case above would also pass against a predicate
      // that had been gutted to never match anything — which is the failure mode
      // a negative-only test cannot distinguish from a working fix.
      it('CONTROL: still gates the SAME sentence shape when the marker is not negated', async () => {
        getPlanRowMock.mockResolvedValue({
          ...negatedPlan(),
          nowNext: NEGATED_NOW_NEXT.replace('non-owner-gated', 'owner-gated'),
        });
        const got = await planItemLaneBlockReason({
          payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-033' } },
          harness: 'papercusp',
          id: UNUSED_ID,
          family: UNUSED_FAMILY,
        });
        expect(got).not.toBeNull();
        expect(got?.reason).toMatch(/owner-gated \("owner-gated"\)/);
      });

      // The false-NEGATIVE direction, which the module's own doc names as the
      // more dangerous one: a negated mention must not MASK a real marker that
      // follows it in the same sentence.
      it('still gates when a REAL marker follows a negated one in the same sentence', async () => {
        getPlanRowMock.mockResolvedValue({
          items: [planItem({ id: 'P-033', storedStatus: 'todo', text: 'Write the agent-insights docs.' })],
          nowState: '',
          nowNext:
            'P-033 follows P-011 (the closest surviving non-owner-gated lever), but P-033 itself is owner-gated until the owner rules.',
        });
        const got = await planItemLaneBlockReason({
          payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-033' } },
          harness: 'papercusp',
          id: UNUSED_ID,
          family: UNUSED_FAMILY,
        });
        expect(got).not.toBeNull();
        expect(got?.reason).toMatch(/owner-gated \("owner-gated"\)/);
      });
    });

    describe('status-counts lines — a COUNT LABEL is not a predication', () => {
      // The real shape, measured 2026-08-09 on
      // semantic-search-fingerprint-coverage-2026-08-03. ONE line and ONE sentence
      // (so sentence-scoping cannot split it) with the marker NOT negated (so the
      // negation fix does not apply) — yet the marker is a COUNT whose own clause
      // attributes it to P-035, and it gated P-036/P-023/P-024: precisely the items
      // the line exists to advertise as actionable.
      const COUNTS_NOW_STATE =
        '**27 of 36 done, 4 dropped, 1 owner-gated (P-035), 4 todo** (P-036 · P-023 · P-024 · P-032).';

      const countsPlan = () => ({
        items: [
          planItem({ id: 'P-023', storedStatus: 'todo', text: 'Make plans:list invalidation-driven.' }),
          planItem({ id: 'P-032', storedStatus: 'todo', text: 'Re-examine WI-258 against dispatch starvation.' }),
          planItem({ id: 'P-035', storedStatus: 'todo', text: 'BM25 scoring via a PG extension.' }),
          planItem({ id: 'P-036', storedStatus: 'todo', text: 'Test session-level aggregation.' }),
        ],
        nowState: COUNTS_NOW_STATE,
        nowNext: '',
      });

      it.each(['P-036', 'P-023', 'P-032'])(
        'does NOT gate %s when the counts line attributes the marker to a DIFFERENT item',
        async (itemId) => {
          getPlanRowMock.mockResolvedValue(countsPlan());
          const got = await planItemLaneBlockReason({
            payload: { plan_item: { plan_slug: 'a-plan', item_id: itemId } },
            harness: 'papercusp',
            id: UNUSED_ID,
            family: UNUSED_FAMILY,
          });
          expect(got).toBeNull();
        },
      );

      // CONTROL 1 — the attribution must be HONOURED, not merely ignored. Without
      // this, the cases above would also pass against a predicate gutted to never
      // match a counts line at all, which is the failure a negative-only test
      // cannot distinguish from a working fix.
      it('CONTROL: still gates P-035, the item the counts line attributes the marker TO', async () => {
        getPlanRowMock.mockResolvedValue(countsPlan());
        const got = await planItemLaneBlockReason({
          payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-035' } },
          harness: 'papercusp',
          id: UNUSED_ID,
          family: UNUSED_FAMILY,
        });
        expect(got).not.toBeNull();
        expect(got?.itemId).toBe('P-035');
        expect(got?.reason).toMatch(/owner-gated \("owner-gated"\)/);
      });

      // CONTROL 2 — the narrowness guarantee. Strip ONLY the parenthesised
      // attribution from that same line and the marker predicates over everything
      // the sentence names again, exactly as it does today. This isolates the fix
      // to the attribution and proves it did not weaken the unattributed case.
      it('CONTROL: gates an item named on the SAME line once the attribution is removed', async () => {
        getPlanRowMock.mockResolvedValue({
          ...countsPlan(),
          nowState: COUNTS_NOW_STATE.replace(' (P-035)', ''),
        });
        const got = await planItemLaneBlockReason({
          payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-036' } },
          harness: 'papercusp',
          id: UNUSED_ID,
          family: UNUSED_FAMILY,
        });
        expect(got).not.toBeNull();
        expect(got?.itemId).toBe('P-036');
      });

      // The false-NEGATIVE direction the module's doc names as the dangerous one:
      // an attributed occurrence must not MASK a real, unattributed marker later in
      // the same text.
      it('still gates when a REAL marker follows an attributed one', async () => {
        getPlanRowMock.mockResolvedValue({
          ...countsPlan(),
          nowState: `${COUNTS_NOW_STATE} P-036 is itself owner-gated until the owner rules.`,
        });
        const got = await planItemLaneBlockReason({
          payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-036' } },
          harness: 'papercusp',
          id: UNUSED_ID,
          family: UNUSED_FAMILY,
        });
        expect(got).not.toBeNull();
        expect(got?.itemId).toBe('P-036');
      });
    });

      // The WI-1774/P-003 shape at finer granularity: several items named in ONE
      // sentence that carries the marker are ALL legitimately gated by it.
      it('gates EVERY item named in a single sentence that carries the marker', async () => {
        const plan = {
          items: [
            planItem({ id: 'P-003', storedStatus: 'todo' }),
            planItem({ id: 'P-004', storedStatus: 'todo' }),
          ],
          nowState: '',
          nowNext:
            'The only open items are P-003 (zero-downtime deploy) + P-004 (event-loop scale-out), both HARD-DEFERRED to an owner-attended session.',
        };
        for (const itemId of ['P-003', 'P-004']) {
          getPlanRowMock.mockResolvedValue(plan);
          const got = await planItemLaneBlockReason({
            payload: { plan_item: { plan_slug: 'a-plan', item_id: itemId } },
            harness: 'papercusp',
            id: UNUSED_ID,
            family: UNUSED_FAMILY,
          });
          expect(got, `expected ${itemId} to be gated`).not.toBeNull();
          expect(got?.itemId).toBe(itemId);
        }
      });
    });

    it.each([
      ['preserved unrelated wall', 'No change to owner-gated Flywheel ask, legal/spend/mainnet/credential/sign/send/publish constraints or LIVE_GATE_OPS ownership.', null],
      ['other item in a separate clause', 'P-002 remains owner-gated until the owner approves.', null],
      ['explicit marker attribution', 'One owner-gated (P-002), while P-001 remains actionable.', null],
      ['own item preservation', 'No change to owner-gated P-001; owner approval is still required.', 'owner-gated'],
      ['later genuine gate', 'No change to owner-gated Flywheel ask. P-001 is hard-deferred until owner approval.', 'hard-deferred'],
      ['unqualified genuine gate', 'Owner-gated: wait for the owner before executing.', 'owner-gated'],
      ['unqualified preserved gate', 'No change to owner-gated; owner approval remains required.', 'owner-gated'],
      ['preserved execution gate', 'No change to owner-gated execution; wait for owner approval.', 'owner-gated'],
      ['preserved closure gate', 'No change to owner-gated source closure.', 'owner-gated'],
      ['preserved approval requirement', 'No change to owner-gated approval requirement.', 'owner-gated'],
      ['preserved hard deferral', 'No change to hard-deferred status pending owner approval.', 'hard-deferred'],
      ['same named subject', 'No change to owner-gated Flywheel ask.', 'owner-gated'],
    ])('scopes Decision markers: %s', async (_name, body, marker) => {
      getPlanRowMock.mockResolvedValue({
        items: [planItem({ text: _name === 'same named subject' ? 'Flywheel ask' : 'Do the thing' }), planItem({ id: 'P-002' })],
        decisions: [{ id: 'D-003', title: 'P-001 detector amendment', body,
          date: null, itemRefs: ['P-001', 'P-002'] }],
      });
      const got = await planItemLaneBlockReason({
        payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-001' } },
        harness: 'papercusp', id: UNUSED_ID, family: UNUSED_FAMILY,
      });
      if (marker) expect(got?.reason).toContain(`owner-gated ("${marker}")`);
      else expect(got).toBeNull();
    });

    it('reports owner-gated for an item scoped to a Decision (via itemRefs) carrying a marker', async () => {
      getPlanRowMock.mockResolvedValue({
        items: [planItem({ id: 'P-006', storedStatus: 'todo' })],
        decisions: [
          {
            id: 'D-004',
            title: 'P-006 verification gate is owner-window-gated',
            body: 'blocked-by the owner-gated trio; not re-placeable.',
            date: null,
            itemRefs: ['P-006', 'P-008', 'P-009'],
          },
        ],
      });
      const got = await planItemLaneBlockReason({
        payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-006' } },
        harness: 'papercusp',
        id: UNUSED_ID,
        family: UNUSED_FAMILY,
      });
      expect(got).not.toBeNull();
      expect(got?.itemId).toBe('P-006');
      expect(got?.reason).toMatch(/owner-gated \("owner-gated"\)/);
    });

    it('returns null for a clear item even when the plan row carries Now/decisions fields with no marker text', async () => {
      getPlanRowMock.mockResolvedValue({
        items: [planItem({ id: 'P-001', storedStatus: 'todo' })],
        nowState: 'routine progress, nothing gated',
        nowNext: 'keep going',
        decisions: [
          { id: 'D-001', title: 'an ordinary decision', body: 'no gating language here', date: null, itemRefs: ['P-001'] },
        ],
      });
      const got = await planItemLaneBlockReason({
        payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-001' } },
        harness: 'papercusp',
        id: UNUSED_ID,
        family: UNUSED_FAMILY,
      });
      expect(got).toBeNull();
    });
  });
});

describe('planItemNeedsHumanContradiction (EI-13766)', () => {
  beforeEach(() => {
    getPlanRowMock.mockReset();
    planItemsForRowMock.mockReset();
    planItemsForRowMock.mockImplementation((row: unknown) => (row as { items: unknown[] }).items);
    fakeSourcePlanRow = null;
    fakeSqlError = null;
    fakeSql.mockClear();
  });

  it('rejects a payload-linked owner park when plan truth explicitly remains agent-actionable', async () => {
    getPlanRowMock.mockResolvedValue({ items: [planItem({ id: 'P-001', storedStatus: 'todo' })] });
    const got = await planItemNeedsHumanContradiction({
      payload: { plan_item: { plan_slug: 'agent-plan', item_id: 'P-001' } },
      harness: 'papercusp',
    });
    expect(got).toMatchObject({ planSlug: 'agent-plan', itemIds: ['P-001'] });
    expect(got?.reason).toContain('needsHuman=false');
  });

  it('uses the feature column linkage and requires every referenced item to resolve actionable', async () => {
    fakeSourcePlanRow = { source_plan_slug: 'column-plan', source_plan_item_ids: ['P-001', 'P-002'] };
    getPlanRowMock.mockResolvedValue({
      items: [planItem({ id: 'P-001', storedStatus: 'todo' }), planItem({ id: 'P-002', storedStatus: 'todo' })],
    });
    await expect(
      planItemNeedsHumanContradiction({ payload: {}, harness: 'papercusp', id: 'F-1', family: 'feature' }),
    ).resolves.toMatchObject({ planSlug: 'column-plan', itemIds: ['P-001', 'P-002'] });

    getPlanRowMock.mockResolvedValue({ items: [planItem({ id: 'P-001', storedStatus: 'todo' })] });
    await expect(
      planItemNeedsHumanContradiction({ payload: {}, harness: 'papercusp', id: 'F-1', family: 'feature' }),
    ).resolves.toBeNull();
  });

  it('allows a real needs-human plan lane and fails open on an unreadable plan', async () => {
    getPlanRowMock.mockResolvedValue({ items: [planItem({ id: 'P-001', storedStatus: 'needs-human' })] });
    const input = {
      payload: { plan_item: { plan_slug: 'owner-plan', item_id: 'P-001' } },
      harness: 'papercusp',
    };
    await expect(planItemNeedsHumanContradiction(input)).resolves.toBeNull();
    getPlanRowMock.mockRejectedValue(new Error('plan unavailable'));
    await expect(planItemNeedsHumanContradiction(input)).resolves.toBeNull();
  });

  it('EI-22166703532735250: dropped residue on a shipped plan does not contradict a human blocker', async () => {
    getPlanRowMock.mockResolvedValue({
      status: 'shipped',
      items: [planItem({ id: 'P-001', storedStatus: 'dropped' })],
    });
    const got = await planItemNeedsHumanContradiction({
      payload: { plan_item: { plan_slug: 'shipped-plan', item_id: 'P-001' } },
      harness: 'papercusp',
    });
    expect(got).toBeNull();
  });

  it('also ignores all-terminal linked residue when the plan itself is still active', async () => {
    getPlanRowMock.mockResolvedValue({
      status: 'active',
      items: [
        planItem({ id: 'P-001', storedStatus: 'dropped' }),
        planItem({ id: 'P-002', storedStatus: 'done' }),
      ],
    });
    fakeSourcePlanRow = { source_plan_slug: 'active-plan', source_plan_item_ids: ['P-001', 'P-002'] };
    await expect(
      planItemNeedsHumanContradiction({ payload: {}, harness: 'papercusp', id: 'F-1', family: 'feature' }),
    ).resolves.toBeNull();
  });
});
