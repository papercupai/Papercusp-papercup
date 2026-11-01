/**
 * liveness.test.ts — EI-7189 (previous-holder-still-live warning on a plan-item
 * claim steal). Unit-tests the PURE decision (`priorHolderStillLive`) only — the
 * presence/wakeability FETCH that produces a real `SessionState` is the untested IO
 * seam, exactly mirroring presence-wakeability.ts's own fetchWakeability/
 * deriveSessionState split (fetchWakeability is documented best-effort IO; only
 * deriveSessionState is unit-tested there). `claimPlanItem` itself is covered by the
 * existing PG-backed integration tests (claims.integration.test.ts,
 * convert.integration.test.ts) — this file adds no PG dependency.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    plans: new Map<string, { items: { id: string; status: string; blockedBy?: string[] }[] }>(),
    assignments: [] as Array<{ itemId: string; assigneeName: string }>,
    claims: [] as Array<{ itemId: string; expired: boolean }>,
    implementing: new Map<string, unknown>(),
    admission: { decision: null as unknown },
  };
  return {
    ...state,
    admission: state.admission,
    admitSubjectForFleetTarget: vi.fn(async () => state.admission.decision ?? { allowed: true, scoped: false }),
    findImplementingWorkItem: vi.fn(async (_planSlug: string, itemId: string) => state.implementing.get(itemId) ?? null),
  };
});

vi.mock('../agent-tools/plans/source', () => ({
  readPlanBySlug: async (slug: string) => {
    const plan = h.plans.get(slug);
    if (!plan) return null;
    return {
      row: { items: plan.items },
      parsed: { items: plan.items.map((item) => ({ ...item, storedStatus: item.status })) },
    };
  },
}));
vi.mock('./assignments', () => ({
  listAssignmentsForPlan: async () => h.assignments,
  getAssignment: async () => null,
}));
vi.mock('./claims', () => ({
  listClaimsForPlan: async () => h.claims,
  getClaim: async () => null,
  acquireClaim: async () => { throw new Error('unexpected claim acquisition'); },
  forceTakeoverClaim: async () => { throw new Error('unexpected force takeover'); },
  releaseClaim: async () => false,
}));
vi.mock('./convert', () => ({
  findImplementingWorkItem: (...args: [string, string]) => h.findImplementingWorkItem(...args),
  TERMINAL_WORK_ITEM_STATES: new Set(['done', 'dropped', 'closed', 'resolved']),
}));
vi.mock('./work-group', () => ({
  workGroupExists: async () => false,
  isWorkGroupMember: async () => true,
}));
vi.mock('../scheduler/fleet-scope-admission', () => ({
  admitSubjectForFleetTarget: h.admitSubjectForFleetTarget,
}));
vi.mock('../work-items', () => ({
  isClaimHoldParked: (payload: unknown) => String((payload as { _claimHold?: unknown } | null)?._claimHold) === 'true',
  readWorkItemClaimHoldProvenance: (payload: unknown) => {
    const p = (payload ?? {}) as {
      held_open_by?: string;
      held_open_reason?: string;
      held_open_at?: string;
      claim_hold_by?: string;
      claim_hold_reason?: string;
      claim_hold_at?: string;
    };
    const heldOpen = p.held_open_by
      ? { by: p.held_open_by, reason: p.held_open_reason ?? null, at: p.held_open_at ?? null }
      : null;
    const parked = p.claim_hold_by
      ? { by: p.claim_hold_by, reason: p.claim_hold_reason ?? null, at: p.claim_hold_at ?? null }
      : null;
    return { heldOpen, parked, attributed: Boolean(heldOpen || parked) };
  },
}));
import { claimPlanItem, mergedPlanItemStates, priorHolderStillLive } from './liveness';
import type { PlanItemClaim } from './claims';

const lapsedClaim = (owner: string): Pick<PlanItemClaim, 'owner' | 'expired'> => ({ owner, expired: true });
const liveClaim = (owner: string): Pick<PlanItemClaim, 'owner' | 'expired'> => ({ owner, expired: false });

beforeEach(() => {
  h.plans.clear();
  h.plans.set('plan', { items: [{ id: 'P-001', status: 'todo' }, { id: 'P-002', status: 'todo' }] });
  h.assignments = [];
  h.claims = [];
  h.implementing.clear();
  h.admission.decision = null;
  h.admitSubjectForFleetTarget.mockClear();
});

describe('priorHolderStillLive (EI-7189)', () => {
  it('warns when the prior claim LAPSED and its owner still looks live', () => {
    expect(priorHolderStillLive(lapsedClaim('su-A'), 'su-B', 'live')).toBe(true);
  });

  it('warns when the prior claim LAPSED and its owner looks parked (idle but alive)', () => {
    expect(priorHolderStillLive(lapsedClaim('su-A'), 'su-B', 'parked')).toBe(true);
  });

  it('does NOT warn when the prior owner looks ended (genuinely dead — the normal case)', () => {
    expect(priorHolderStillLive(lapsedClaim('su-A'), 'su-B', 'ended')).toBe(false);
  });

  it('does NOT warn when presence is unknown (a lookup failure or no row — never block on uncertainty)', () => {
    expect(priorHolderStillLive(lapsedClaim('su-A'), 'su-B', null)).toBe(false);
  });

  it('does NOT warn when there is no prior claim at all (a fresh, never-claimed item)', () => {
    expect(priorHolderStillLive(null, 'su-B', 'live')).toBe(false);
  });

  it('does NOT warn when the prior claim is still LIVE, not lapsed (that path is a conflict, not a steal)', () => {
    expect(priorHolderStillLive(liveClaim('su-A'), 'su-B', 'live')).toBe(false);
  });

  it('does NOT warn when the caller is reclaiming their OWN lapsed lease', () => {
    expect(priorHolderStillLive(lapsedClaim('su-A'), 'su-A', 'live')).toBe(false);
  });
});

describe('mergedPlanItemStates implementing-work-item projection (EI-22024943221800341)', () => {
  it('exposes a linked durable claim-hold without changing the pooled disposition', async () => {
    h.implementing.set('P-001', {
      id: 'WI-parked',
      state: 'open',
      payload: {
        _claimHold: true,
        claim_hold_by: 'su-parker',
        claim_hold_reason: 'D-051: canonical wrapper owns this execution record',
        claim_hold_at: '2026-09-01T08:00:00.000Z',
      },
    });

    const [row] = await mergedPlanItemStates('default', 'papercusp', 'plan');

    expect(row).toMatchObject({
      itemId: 'P-001',
      disposition: 'pooled',
      implementingWorkItem: {
        id: 'WI-parked',
        state: 'open',
        claimHold: true,
        claimHoldBy: 'su-parker',
        claimHoldReason: 'D-051: canonical wrapper owns this execution record',
        claimHoldAt: '2026-09-01T08:00:00.000Z',
        provenance: {
          heldOpen: null,
          parked: {
            by: 'su-parker',
            reason: 'D-051: canonical wrapper owns this execution record',
            at: '2026-09-01T08:00:00.000Z',
          },
          attributed: true,
        },
      },
    });
  });

  it('reports an unparked linked record and leaves an unlinked item null', async () => {
    h.implementing.set('P-001', { id: 'WI-open', state: 'wip', payload: { _claimHold: false } });

    const rows = await mergedPlanItemStates('default', 'papercusp', 'plan');
    expect(rows.find((row) => row.itemId === 'P-001')?.implementingWorkItem).toMatchObject({
      id: 'WI-open',
      state: 'wip',
      claimHold: false,
      claimHoldBy: null,
      claimHoldReason: null,
      claimHoldAt: null,
      provenance: { heldOpen: null, parked: null, attributed: false },
    });
    expect(rows.find((row) => row.itemId === 'P-002')?.implementingWorkItem).toBeNull();
  });

  it('fails open when the optional linked-record lookup errors', async () => {
    h.findImplementingWorkItem.mockRejectedValueOnce(new Error('coord_links unavailable'));

    const rows = await mergedPlanItemStates('default', 'papercusp', 'plan');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.implementingWorkItem).toBeNull();
    expect(rows[0]?.disposition).toBe('pooled');
  });
});

describe('claimPlanItem linked claim-hold refusal', () => {
  it('returns the parked work-item id and makes missing provenance explicit', async () => {
    h.implementing.set('P-001', {
      id: 'WI-anonymous-park',
      state: 'open',
      payload: { _claimHold: true },
    });

    const result = await claimPlanItem({
      workspaceId: 'default',
      harnessSlug: 'papercusp',
      planSlug: 'plan',
      itemId: 'P-001',
      owner: 'su-reader',
      ownerUser: 'reader@example.com',
      livenessMode: 'availability',
    });

    expect(result).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('work item WI-anonymous-park is parked by claimHold'),
      claimHold: {
        workItemId: 'WI-anonymous-park',
        provenance: { heldOpen: null, parked: null, attributed: false },
      },
    });
  });
});

describe('claimPlanItem fleet admission', () => {
  it('refuses a new plan-item lease while the target fleet is winding down', async () => {
    h.admission.decision = {
      allowed: false,
      scoped: true,
      code: 'fleet_winding_down',
      reason: "fleet 'code-intel-reuse-signals' is winding-down (paused)",
    };

    const result = await claimPlanItem({
      workspaceId: 'default',
      harnessSlug: 'papercusp',
      planSlug: 'plan',
      itemId: 'P-001',
      owner: 'su-paused-member',
      ownerUser: 'member@example.com',
      livenessMode: 'availability',
    });

    expect(result).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('fleet_winding_down: fleet'),
    });
    expect(h.admitSubjectForFleetTarget).toHaveBeenCalledWith(expect.objectContaining({
      target: 'su-paused-member',
      workspaceId: 'default',
      subject: expect.objectContaining({
        kind: 'feature',
        plan: 'plan',
        planItem: ['P-001'],
        itemClass: 'work',
      }),
    }));
  });
});
