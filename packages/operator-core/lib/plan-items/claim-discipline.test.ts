import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimForWork, releaseOwnClaim, reconcileDeclaredClaims } from './claim-discipline';
import { getClaim, listClaimsForPlan, releaseClaim, type PlanItemClaim } from './claims';
import { claimPlanItem } from './liveness';
import { findImplementingWorkItem } from './convert';
import { releaseWorkItem } from '../work-items';
import { workItemFixture } from '../testing/work-item-fixture';

vi.mock('./claims', () => ({
  getClaim: vi.fn(),
  listClaimsForPlan: vi.fn(),
  releaseClaim: vi.fn(),
}));
vi.mock('./liveness', () => ({
  claimPlanItem: vi.fn(),
}));
vi.mock('./convert', () => ({
  findImplementingWorkItem: vi.fn(),
  TERMINAL_WORK_ITEM_STATES: new Set(['passed', 'resolved', 'closed', 'done', 'deprecated', 'dropped']),
}));
vi.mock('../work-items', () => ({
  releaseWorkItem: vi.fn(),
}));

const mockGetClaim = vi.mocked(getClaim);
const mockListClaims = vi.mocked(listClaimsForPlan);
const mockReleaseClaim = vi.mocked(releaseClaim);
const mockClaimPlanItem = vi.mocked(claimPlanItem);
const mockFindImplementingWorkItem = vi.mocked(findImplementingWorkItem);
const mockReleaseWorkItem = vi.mocked(releaseWorkItem);

function fakeClaim(over: Partial<PlanItemClaim> = {}): PlanItemClaim {
  return {
    workspaceId: 'ws',
    harnessSlug: 'papercup',
    planSlug: 'plan-a',
    itemId: 'P-001',
    claimId: '11111111-1111-1111-1111-111111111111',
    owner: 'su-me',
    ownerLabel: 'su · me',
    ownerName: null,
    intent: '',
    livenessMode: 'availability',
    ttlSec: 1200,
    acquiredTs: '2026-06-10T00:00:00Z',
    expiresTs: '2026-06-10T01:00:00Z',
    lastActivityTs: '2026-06-10T00:00:00Z',
    expired: false,
    ...over,
  };
}

const scope = {
  workspaceId: 'ws',
  harnessSlug: 'papercup',
  planSlug: 'plan-a',
  owner: 'su-me',
  ownerUser: 'me@example.com',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindImplementingWorkItem.mockResolvedValue(null);
  mockReleaseWorkItem.mockResolvedValue(null);
});

describe('claimForWork', () => {
  it('short-circuits on the caller own live claim (alreadyHeld)', async () => {
    mockGetClaim.mockResolvedValue(fakeClaim());
    const out = await claimForWork({ ...scope, itemId: 'P-001' });
    expect(out).toEqual({ ok: true, claimId: fakeClaim().claimId, alreadyHeld: true });
    expect(mockClaimPlanItem).not.toHaveBeenCalled();
  });

  it('claims when unheld', async () => {
    mockGetClaim.mockResolvedValue(null);
    mockClaimPlanItem.mockResolvedValue({
      status: 'claimed',
      claim: fakeClaim({ claimId: '22222222-2222-2222-2222-222222222222' }),
      mode: 'availability',
      viaAssignment: false,
    });
    const out = await claimForWork({ ...scope, itemId: 'P-001' });
    expect(out).toEqual({
      ok: true,
      claimId: '22222222-2222-2222-2222-222222222222',
      alreadyHeld: false,
    });
  });

  it('re-acquires through policy when the existing claim is the caller own but LAPSED', async () => {
    mockGetClaim.mockResolvedValue(fakeClaim({ expired: true }));
    mockClaimPlanItem.mockResolvedValue({
      status: 'claimed',
      claim: fakeClaim({ claimId: '33333333-3333-3333-3333-333333333333' }),
      mode: 'availability',
      viaAssignment: false,
    });
    const out = await claimForWork({ ...scope, itemId: 'P-001' });
    expect(out.ok).toBe(true);
    expect(mockClaimPlanItem).toHaveBeenCalled();
  });

  it('rejects with the holder on a live peer claim', async () => {
    const peer = fakeClaim({ owner: 'su-peer', ownerLabel: 'su · peer', intent: 'doing P-001' });
    mockGetClaim.mockResolvedValue(peer);
    mockClaimPlanItem.mockResolvedValue({ status: 'conflict', conflict: peer });
    const out = await claimForWork({ ...scope, itemId: 'P-001' });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.holder?.owner).toBe('su-peer');
      expect(out.reason).toContain('su · peer');
    }
  });

  it('surfaces an assignment-policy refusal', async () => {
    mockGetClaim.mockResolvedValue(null);
    mockClaimPlanItem.mockResolvedValue({
      status: 'refused',
      reason: 'assigned to bob',
      assignee: 'bob',
    });
    const out = await claimForWork({ ...scope, itemId: 'P-001' });
    expect(out).toEqual({ ok: false, reason: 'assigned to bob' });
  });

  it('preserves linked claim-hold context on a holderless refusal', async () => {
    mockGetClaim.mockResolvedValue(null);
    const claimHold = {
      workItemId: 'WI-anonymous-park',
      provenance: { heldOpen: null, parked: null, attributed: false },
    };
    mockClaimPlanItem.mockResolvedValue({
      status: 'refused',
      reason: 'work item WI-anonymous-park is parked by claimHold',
      claimHold,
    });

    const out = await claimForWork({ ...scope, itemId: 'P-001' });

    expect(out).toEqual({
      ok: false,
      reason: 'work item WI-anonymous-park is parked by claimHold',
      claimHold,
    });
  });
});

describe('releaseOwnClaim', () => {
  it('releases the caller own claim', async () => {
    mockGetClaim.mockResolvedValue(fakeClaim());
    mockReleaseClaim.mockResolvedValue(true);
    const released = await releaseOwnClaim('ws', 'papercup', 'plan-a', 'P-001', 'su-me');
    expect(released).toBe(true);
    expect(mockReleaseClaim).toHaveBeenCalledWith(
      'ws',
      'papercup',
      'plan-a',
      'P-001',
      fakeClaim().claimId,
      'su-me',
    );
  });

  it('also releases the caller-owned linked work item', async () => {
    mockGetClaim.mockResolvedValue(fakeClaim());
    mockReleaseClaim.mockResolvedValue(true);
    mockFindImplementingWorkItem.mockResolvedValue(workItemFixture({
      id: 'WI-001',
      harness: 'papercup',
      state: 'wip',
      assignee: 'su-me',
    }));
    mockReleaseWorkItem.mockResolvedValue(workItemFixture({ id: 'WI-001' }));

    await releaseOwnClaim('ws', 'papercup', 'plan-a', 'P-001', 'su-me');

    expect(mockReleaseWorkItem).toHaveBeenCalledWith('WI-001', {
      harness: 'papercup',
      expectedAssignee: 'su-me',
      releasingOwnerId: 'su-me',
    });
  });

  it('leaves a peer claim alone', async () => {
    mockGetClaim.mockResolvedValue(fakeClaim({ owner: 'su-peer' }));
    const released = await releaseOwnClaim('ws', 'papercup', 'plan-a', 'P-001', 'su-me');
    expect(released).toBe(false);
    expect(mockReleaseClaim).not.toHaveBeenCalled();
  });

  it('no-ops when unclaimed', async () => {
    mockGetClaim.mockResolvedValue(null);
    expect(await releaseOwnClaim('ws', 'papercup', 'plan-a', 'P-001', 'su-me')).toBe(false);
  });
});

describe('reconcileDeclaredClaims', () => {
  it('claims the lane, reports conflicts, releases items outside the lane', async () => {
    // P-001 claims fresh; P-002 conflicts with a peer; P-009 (held, outside lane) releases.
    mockGetClaim.mockResolvedValue(null);
    const peer = fakeClaim({ itemId: 'P-002', owner: 'su-peer', ownerLabel: 'su · peer' });
    mockClaimPlanItem.mockImplementation(async (opts) =>
      opts.itemId === 'P-002'
        ? { status: 'conflict', conflict: peer }
        : {
            status: 'claimed',
            claim: fakeClaim({ itemId: opts.itemId }),
            mode: 'availability',
            viaAssignment: false,
          },
    );
    mockListClaims.mockResolvedValue([
      fakeClaim({ itemId: 'P-001' }),
      fakeClaim({ itemId: 'P-009' }),
      peer,
    ]);
    mockReleaseClaim.mockResolvedValue(true);

    const res = await reconcileDeclaredClaims({
      ...scope,
      items: ['P-001', 'P-002'],
    });
    expect(res.claimed).toEqual(['P-001']);
    expect(res.conflicts).toEqual([
      { item: 'P-002', reason: expect.stringContaining('su · peer'), holder: 'su · peer' },
    ]);
    expect(res.released).toEqual(['P-009']);
  });

  it('an empty lane releases all of the caller claims in the plan', async () => {
    mockListClaims.mockResolvedValue([
      fakeClaim({ itemId: 'P-003' }),
      fakeClaim({ itemId: 'P-004', owner: 'su-peer' }), // peer's — untouched
    ]);
    mockReleaseClaim.mockResolvedValue(true);
    const res = await reconcileDeclaredClaims({ ...scope, items: [] });
    expect(res.released).toEqual(['P-003']);
    expect(mockReleaseClaim).toHaveBeenCalledTimes(1);
  });

  it('releases linked execution records when narrowing the declared lane', async () => {
    mockGetClaim.mockResolvedValue(null);
    mockListClaims.mockResolvedValue([fakeClaim({ itemId: 'P-009' })]);
    mockReleaseClaim.mockResolvedValue(true);
    mockFindImplementingWorkItem.mockResolvedValue(workItemFixture({
      id: 'WI-009',
      harness: 'papercup',
      state: 'wip',
      assignee: 'su-me',
    }));
    mockReleaseWorkItem.mockResolvedValue(workItemFixture({ id: 'WI-009' }));

    await reconcileDeclaredClaims({ ...scope, items: [] });

    expect(mockReleaseWorkItem).toHaveBeenCalledWith('WI-009', {
      harness: 'papercup',
      expectedAssignee: 'su-me',
      releasingOwnerId: 'su-me',
    });
  });
});
