/**
 * drain-stamp tests (work-item-claimability-clarity-2026-07-20 P-006): the
 * fleet:wind-down auto-drain stamp. The scheduler oracle (aggregateIssueClaimExclusions)
 * and the claim-spec store are mocked WHOLESALE — this asserts the harness-resolution
 * order, the summary shape, and the fail-soft contract, not the SQL (that is the
 * scheduler's own tested predicate, reused here on purpose so there is no second copy).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueClaimExclusionBreakdown } from '../../scheduler/get-next';

vi.mock('../../scheduler/claim-spec-store', () => ({
  getClaimSpecRecord: vi.fn(),
  fleetSpecBeeKey: (slug: string) => `fleet:${slug}`,
  resolveClaimSpecWorkspace: (ws: string | null) => ws ?? 'default',
}));
// EI-22180177490969530: the SQL-composing oracle stays mocked, but the PURE registry
// projection is passed through from the real module so the fixture below derives its
// per-floor zero baseline from ISSUE_CLAIM_FLOORS instead of hand-restating every bucket.
vi.mock('../../scheduler/get-next', async () => {
  const actual = await vi.importActual<typeof import('../../scheduler/get-next')>(
    '../../scheduler/get-next',
  );
  return {
    aggregateIssueClaimExclusions: vi.fn(),
    mapIssueClaimExclusionCounts: actual.mapIssueClaimExclusionCounts,
  };
});

import { buildFleetDrainStamp } from './drain-stamp';
import { getClaimSpecRecord } from '../../scheduler/claim-spec-store';
import { aggregateIssueClaimExclusions, mapIssueClaimExclusionCounts } from '../../scheduler/get-next';

const recM = vi.mocked(getClaimSpecRecord);
const aggM = vi.mocked(aggregateIssueClaimExclusions);

function breakdown(
  over: Partial<IssueClaimExclusionBreakdown['excluded']> = {},
  matched = 100,
  claimable = 0,
): IssueClaimExclusionBreakdown {
  return {
    matchedByFilter: matched,
    claimable,
    affinityCoverage: {
      denominator: claimable,
      nonEmptyPaths: 0,
      floor: 0.5,
      belowFloor: false,
    },
    excluded: {
      ...mapIssueClaimExclusionCounts(undefined),
      ...over,
    },
    queueControl: {
      activeClaims: 0,
      rawClaimHolds: 0,
      holdOpenLeases: 0,
      durableParks: 0,
      unattributedClaimHolds: 0,
      pendingAgentReview: 0,
      revisionRequestedAgentReview: 0,
      revisionReproductionValidation: 0,
      revisionContentAdoptionCandidates: 0,
      revisionLegacyException: 0,
    },
  };
}

const sentinel = (over: Record<string, unknown> = {}) => ({
  source: 'cup' as const,
  spec: { specId: 'bug-drain', revision: 4, view: { filter: { field: 'kind', op: 'eq', value: 'bug' } }, states: ['open'] },
  revision: 4,
  updatedBy: null,
  updatedAt: null,
  harnessSlug: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  recM.mockResolvedValue(sentinel() as never);
  aggM.mockResolvedValue(breakdown({ federationDetector: 60, needsOwnerAction: 40 }, 100));
});

describe('buildFleetDrainStamp', () => {
  it('scopes the breakdown to the sentinel spec filter + resolves harness from the first candidate', async () => {
    const s = await buildFleetDrainStamp({
      fleetSlug: 'bug-drain-200k',
      ownerId: 'su-leader',
      workspaceId: 'ws-1',
      harnessCandidates: ['papercusp', undefined],
    });
    expect(s).not.toBeNull();
    expect(s!.harness).toBe('papercusp');
    expect(s!.reVerifyCommand).toBe("scheduler:get_next { harness: 'papercusp' }");
    expect(s!.spec).toEqual({ specId: 'bug-drain', revision: 4, source: 'cup' });
    // the oracle was called with the sentinel's OWN filter + states + the leader as assignee.
    expect(aggM).toHaveBeenCalledWith(
      { field: 'kind', op: 'eq', value: 'bug' },
      expect.objectContaining({ harness: 'papercusp', states: ['open'], assignee: 'su-leader' }),
    );
    // the summary names the dominant floors, descending, and the re-verify command.
    expect(s!.summary).toContain('100 in-lane issue-family row(s)');
    expect(s!.summary).toContain('federationDetector=60, needsOwnerAction=40');
    expect(s!.summary).toContain("scheduler:get_next { harness: 'papercusp' }");
  });

  it('skips empty/"*" candidates and falls back to the sentinel spec harness scope', async () => {
    recM.mockResolvedValue(sentinel({ harnessSlug: 'papercusp' }) as never);
    const s = await buildFleetDrainStamp({
      fleetSlug: 'bug-drain-200k',
      ownerId: 'su-leader',
      workspaceId: 'ws-1',
      harnessCandidates: [null, '*', undefined],
    });
    expect(s!.harness).toBe('papercusp');
  });

  it('returns null when no harness is resolvable (fails soft, no stamp)', async () => {
    recM.mockResolvedValue(sentinel({ harnessSlug: null }) as never);
    const s = await buildFleetDrainStamp({
      fleetSlug: 'bug-drain-200k',
      ownerId: 'su-leader',
      workspaceId: 'ws-1',
      harnessCandidates: [null, undefined],
    });
    expect(s).toBeNull();
    expect(aggM).not.toHaveBeenCalled();
  });

  it('a spec whose filter matches ZERO rows is flagged as a spec problem, not a floor story', async () => {
    aggM.mockResolvedValue(breakdown({}, 0));
    const s = await buildFleetDrainStamp({
      fleetSlug: 'x',
      ownerId: 'su-leader',
      workspaceId: 'ws-1',
      harnessCandidates: ['papercusp'],
    });
    expect(s!.summary).toContain('the SPEC matches nothing');
  });

  it('a fully-unfloored lane warns wind-down may be premature (claimable work may remain)', async () => {
    // A lane with 12 matched rows and ZERO floors has 12 survivors by construction —
    // the fixture must say so, or it encodes an impossible breakdown (EI-22185555381915875).
    aggM.mockResolvedValue(breakdown({}, 12, 12));
    const s = await buildFleetDrainStamp({
      fleetSlug: 'x',
      ownerId: 'su-leader',
      workspaceId: 'ws-1',
      harnessCandidates: ['papercusp'],
    });
    expect(s!.summary).toContain('none floored');
    expect(s!.summary).toContain('may be premature');
  });

  // EI-22185555381915875 — the reported contradiction, reproduced with its own numbers:
  // floors are non-empty AND 583 rows survive all of them. The verdict must follow
  // `claimable`, never `top.length`, because control-core persists this string verbatim
  // into the durable control_reason.
  it('never claims "0 surviving ALL floors" while its own breakdown reports survivors', async () => {
    aggM.mockResolvedValue(
      breakdown(
        { federationDetector: 186, claimHold: 116, observationLane: 57, agentReview: 42 },
        1004,
        583,
      ),
    );
    const s = await buildFleetDrainStamp({
      fleetSlug: 'buyrestart-zero-auth-2026-09-02',
      ownerId: 'su-leader',
      workspaceId: 'ws-1',
      harnessCandidates: ['papercusp'],
    });
    // anchored on the "; " that only the floor-gated branch emits — a bare
    // '0 surviving ALL floors' would false-pass on a survivor count like 1000.
    expect(s!.summary).not.toContain('; 0 surviving ALL floors');
    expect(s!.summary).not.toContain('genuinely floor-gated');
    // it reports the real survivor count and warns the wind-down may be premature
    expect(s!.summary).toContain('583 surviving ALL floors');
    // NOT a bare 'premature': the buggy string ends "not premature", so a substring
    // check on 'premature' passes on the defect it is meant to catch.
    expect(s!.summary).toContain('may be premature');
    // the floor breakdown is still reported — it is context, not the verdict
    expect(s!.summary).toContain('federationDetector=186');
  });

  // Falsifiability control (the imported-module tier: a deliberately-wrong
  // implementation kept permanently beside the real one). It reproduces the PRE-FIX
  // discriminator — `top.length > 0` instead of `breakdown.claimable > 0` — and proves
  // the assertions above actually discriminate rather than holding for any string.
  it('control: the pre-fix top.length discriminator DOES emit the false justification', () => {
    const b = breakdown(
      { federationDetector: 186, claimHold: 116, observationLane: 57, agentReview: 42 },
      1004,
      583,
    );
    const top = Object.entries(b.excluded)
      .filter(([, n]) => (n as number) > 0)
      .sort((a, z) => (z[1] as number) - (a[1] as number));
    const legacy =
      b.matchedByFilter === 0
        ? ' — the SPEC matches nothing (not a floor story)'
        : top.length > 0
          ? `; stranded by: ${top.map(([k, n]) => `${k}=${n}`).join(', ')} (buckets independent; 0 surviving ALL floors ⇒ the lane is genuinely floor-gated, not premature)`
          : ' — none floored (claimable work may remain; wind-down may be premature)';
    // the exact contradiction reported in EI-22185555381915875: 583 survivors, yet the
    // string asserts none — and it does so while the breakdown says otherwise.
    expect(b.claimable).toBe(583);
    expect(legacy).toContain('; 0 surviving ALL floors');
    expect(legacy).toContain('genuinely floor-gated');
    expect(legacy).not.toContain('583 surviving ALL floors');
    expect(legacy).not.toContain('may be premature');
    // and the trap that made a naive assertion vacuous: it contains 'premature' anyway.
    expect(legacy).toContain('premature');
  });

  it('still calls a genuinely floor-gated lane floor-gated (0 survivors, floors non-empty)', async () => {
    aggM.mockResolvedValue(breakdown({ federationDetector: 186, claimHold: 116 }, 1004, 0));
    const s = await buildFleetDrainStamp({
      fleetSlug: 'x',
      ownerId: 'su-leader',
      workspaceId: 'ws-1',
      harnessCandidates: ['papercusp'],
    });
    expect(s!.summary).toContain('0 surviving ALL floors');
    expect(s!.summary).toContain('genuinely floor-gated, not premature');
  });

  it('fails soft to null when the oracle throws — never blocks the wind-down', async () => {
    aggM.mockRejectedValue(new Error('pg pool saturated'));
    const s = await buildFleetDrainStamp({
      fleetSlug: 'x',
      ownerId: 'su-leader',
      workspaceId: 'ws-1',
      harnessCandidates: ['papercusp'],
    });
    expect(s).toBeNull();
  });
});
