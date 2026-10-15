import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FilterNode } from '../scheduler/claim-spec';

const mocks = vi.hoisted(() => ({
  resolveFleetClaimSpec: vi.fn(),
  resolveClaimSpecWorkspace: vi.fn(() => 'ws-x'),
  aggregateIssueClaimExclusions: vi.fn(),
  diagnoseFleetScopeIssueFloorMiss: vi.fn(),
  diagnoseFleetScopeFeatureFamilyExclusions: vi.fn(),
}));

vi.mock('../scheduler/claim-spec-store', () => ({
  resolveFleetClaimSpec: mocks.resolveFleetClaimSpec,
  resolveClaimSpecWorkspace: mocks.resolveClaimSpecWorkspace,
}));
vi.mock('../scheduler/get-next', () => ({
  aggregateIssueClaimExclusions: mocks.aggregateIssueClaimExclusions,
}));
vi.mock('../scheduler/fleet-scope-admission', () => ({
  FLEET_SCOPE_ISSUE_DIAG_MIN_TOTAL_BUDGET_MS: 3_200,
  diagnoseFleetScopeIssueFloorMiss: mocks.diagnoseFleetScopeIssueFloorMiss,
  diagnoseFleetScopeFeatureFamilyExclusions: mocks.diagnoseFleetScopeFeatureFamilyExclusions,
}));

import { interpretFleetClaimability, readClaimSpecLaneHealth, readFleetLaneHealth, readFleetLaneHealthDiagnosed } from './lane-health';

const planFilter: FilterNode = { field: 'plan', op: '=', value: 'p' };

type LaneHealthTestSpec = {
  specId: string;
  revision: number;
  states: string[];
  view: { filter: FilterNode };
};

const spec: LaneHealthTestSpec = {
  specId: 'feature-plan',
  revision: 7,
  states: ['open'],
  view: { filter: planFilter },
};

const resolved = (nextSpec: LaneHealthTestSpec = spec) => ({
  fleetSlug: 'fleet-x',
  matchedBy: 'fleet-slug',
  record: {
    source: 'fleet',
    spec: nextSpec,
    revision: 7,
    updatedBy: null,
    updatedAt: null,
    harnessSlug: 'papercusp',
    fleetSlug: 'fleet-x',
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveFleetClaimSpec.mockResolvedValue(resolved());
  mocks.aggregateIssueClaimExclusions.mockResolvedValue({
    claimable: 0,
    matchedByFilter: 0,
    excluded: {},
  });
  mocks.diagnoseFleetScopeIssueFloorMiss.mockResolvedValue({
    claimable: 0,
    matchedByFilter: 0,
    excluded: {},
  });
  mocks.diagnoseFleetScopeFeatureFamilyExclusions.mockResolvedValue({
    claimable: 4,
    matchedByFilter: 6,
    excluded: { claimFloors: 2, reservedPlanLane: 2 },
  });
});

const read = () =>
  readFleetLaneHealth({
    fleet: 'fleet-x',
    harness: 'papercusp',
    workspaceId: 'ws-x',
    assignee: 'su-member',
  });

const readPopulation = () =>
  readFleetLaneHealth({
    fleet: 'fleet-x',
    harness: 'papercusp',
    workspaceId: 'ws-x',
  });

describe('readFleetLaneHealth — feature-family-aware effective verdict (EI-211885)', () => {
  it('uses only the feature oracle for an explicitly feature-only exact-plan lane', async () => {
    mocks.resolveFleetClaimSpec.mockResolvedValueOnce(resolved({
      ...spec,
      view: { filter: { all: [planFilter, { field: 'kind', op: 'in', value: ['feature', 'chunk'] }] } },
    }));
    const health = await read();

    expect(health).toMatchObject({
      claimable: 0,
      matchedByFilter: 0,
      excluded: {},
      issueFamily: { claimable: 0, matchedByFilter: 0, excluded: {} },
      featureFamily: { claimable: 4, matchedByFilter: 6, excluded: { claimFloors: 2, reservedPlanLane: 2 } },
      effective: {
        claimable: 4,
        matchedByFilter: 6,
        excluded: { claimFloors: 2, reservedPlanLane: 2 },
        basis: 'feature-family',
      },
      familyReachability: { issue: false, feature: true },
    });
    expect(mocks.aggregateIssueClaimExclusions).not.toHaveBeenCalled();
    expect(mocks.diagnoseFleetScopeFeatureFamilyExclusions).toHaveBeenCalledWith(
      expect.objectContaining({
        harness: 'papercusp',
        workspaceId: 'ws-x',
        scope: expect.objectContaining({
          ownerId: 'su-member',
          fleetSlug: 'fleet-x',
          fleetRole: 'member',
        }),
      }),
    );
    expect(health?.spec.planScoped).toBe(true);
  });

  it('fails closed to UNKNOWN when the required feature-family read fails', async () => {
    mocks.diagnoseFleetScopeFeatureFamilyExclusions.mockResolvedValue(null);

    const health = await read();

    expect(health?.featureFamily?.claimable).toBeNull();
    expect(health?.effective).toEqual({
      claimable: null,
      matchedByFilter: null,
      excluded: null,
      basis: 'issue+feature-family',
    });
  });

  it('does not probe features for an explicitly issue-family-only spec', async () => {
    mocks.resolveFleetClaimSpec.mockResolvedValueOnce(resolved({
      ...spec,
      view: { filter: { all: [planFilter, { field: 'kind', op: 'in', value: ['bug', 'task'] }] } },
    }));

    const health = await read();

    expect(mocks.diagnoseFleetScopeFeatureFamilyExclusions).not.toHaveBeenCalled();
    expect(health?.featureFamily).toBeNull();
    expect(health?.effective).toEqual({
      claimable: 0,
      matchedByFilter: 0,
      excluded: {},
      basis: 'issue-family',
    });
    expect(health?.familyReachability).toEqual({ issue: true, feature: false });
  });

  it('still probes features when the reachable issue family already matches rows', async () => {
    mocks.aggregateIssueClaimExclusions.mockResolvedValue({
      claimable: 2,
      matchedByFilter: 5,
      excluded: { taken: 3, claimFloors: 1 },
    });

    const health = await read();

    expect(mocks.diagnoseFleetScopeFeatureFamilyExclusions).toHaveBeenCalledTimes(1);
    expect(health?.effective).toEqual({
      claimable: 6,
      matchedByFilter: 11,
      excluded: { taken: 3, claimFloors: 3, reservedPlanLane: 2 },
      basis: 'issue+feature-family',
    });
  });

  it('omits caller-relative floors for a fleet population read', async () => {
    mocks.aggregateIssueClaimExclusions.mockResolvedValue({
      claimable: 2,
      matchedByFilter: 2,
      excluded: {},
    });

    const health = await readPopulation();

    expect(mocks.aggregateIssueClaimExclusions).toHaveBeenCalledWith(
      planFilter,
      expect.objectContaining({ assignee: undefined }),
    );
    expect(mocks.diagnoseFleetScopeFeatureFamilyExclusions).toHaveBeenCalledWith(
      expect.objectContaining({
        cooldownAssignee: null,
        scope: expect.objectContaining({ ownerId: '' }),
      }),
    );
    expect(health?.effective.claimable).toBe(6);
    expect(health?.spec.assigneeScoped).toBeNull();
  });

  it('does not launch a large observation-heavy issue aggregate behind a 750ms leader budget', async () => {
    const textFence: FilterNode = {
      all: [
        { field: 'kind', op: 'in', value: ['feature', 'change'] },
        {
          not: {
            any: Array.from({ length: 24 }, (_, index) => ({
              field: index % 2 === 0 ? 'title' : 'summary',
              op: 'word' as const,
              value: `excluded-term-${index}`,
            })),
          },
        },
      ],
    };
    mocks.resolveFleetClaimSpec.mockResolvedValueOnce(resolved({
      ...spec,
      view: { filter: textFence },
    }));

    const reading = await readFleetLaneHealthDiagnosed({
      fleet: 'fleet-x',
      harness: 'papercusp',
      workspaceId: 'ws-x',
      issueFamilyTotalBudgetMs: 750,
    });

    expect(reading.laneHealth).toBeNull();
    expect(reading.unavailable).toMatchObject({
      code: 'issue-family-budget-insufficient',
      stage: 'issue-family',
      basis: 'issue+feature-family',
      spec: { ref: 'feature-plan (spec rev 7)', harness: 'papercusp' },
      recoverVia: expect.stringContaining('work_items:claimable'),
    });
    expect(reading.unavailable?.detail).toContain('aggregate was not launched');
    expect(mocks.aggregateIssueClaimExclusions).not.toHaveBeenCalled();
    expect(mocks.diagnoseFleetScopeIssueFloorMiss).not.toHaveBeenCalled();
    expect(mocks.diagnoseFleetScopeFeatureFamilyExclusions).not.toHaveBeenCalled();
  });

  it('reuses the bounded fleet-scope issue diagnostic when the caller supplies a sufficient budget', async () => {
    const reading = await readFleetLaneHealthDiagnosed({
      fleet: 'fleet-x',
      harness: 'papercusp',
      workspaceId: 'ws-x',
      issueFamilyTotalBudgetMs: 5_000,
    });

    expect(reading.laneHealth?.effective.claimable).toBe(4);
    expect(reading.unavailable).toBeNull();
    expect(mocks.diagnoseFleetScopeIssueFloorMiss).toHaveBeenCalledWith(
      expect.objectContaining({
        harness: 'papercusp',
        workspaceId: 'ws-x',
        totalBudgetMs: 5_000,
      }),
    );
    expect(mocks.aggregateIssueClaimExclusions).not.toHaveBeenCalled();
  });
});

describe('lane-health read failures keep their cause (EI-24700545763161721)', () => {
  const timeout = 'canceling statement due to statement timeout';

  it('names the failed read in the diagnosed unavailable result', async () => {
    mocks.aggregateIssueClaimExclusions.mockRejectedValue(new Error(timeout));

    const reading = await readFleetLaneHealthDiagnosed({
      fleet: 'fleet-x',
      harness: 'papercusp',
      workspaceId: 'ws-x',
    });

    expect(reading.laneHealth).toBeNull();
    expect(reading.unavailable).toMatchObject({ code: 'lane-health-unavailable', stage: 'issue-family' });
    expect(reading.unavailable?.detail).toContain(`Cause: ${timeout}`);
  });

  it('adds no cause when the read returned without throwing', async () => {
    mocks.diagnoseFleetScopeFeatureFamilyExclusions.mockResolvedValue(null);

    const reading = await readFleetLaneHealthDiagnosed({
      fleet: 'fleet-x',
      harness: 'papercusp',
      workspaceId: 'ws-x',
    });

    expect(reading.unavailable?.code).toBe('lane-health-unavailable');
    expect(reading.unavailable?.detail).not.toContain('Cause:');
  });

  it('stays fail-soft by default and rethrows only when asked', async () => {
    mocks.aggregateIssueClaimExclusions.mockRejectedValue(new Error(timeout));
    const args = {
      spec: spec as never,
      record: resolved().record as never,
      fleet: 'fleet-x',
      harness: 'papercusp',
      workspaceId: 'ws-x',
    };

    await expect(readClaimSpecLaneHealth(args)).resolves.toBeNull();
    await expect(readClaimSpecLaneHealth({ ...args, throwOnError: true })).rejects.toThrow(timeout);
  });
});

describe('interpretFleetClaimability — remainder held or parked (WI-6554700010010002)', () => {
  // The observed shape: an id allowlist whose rows are 16 done + 1 wip held by a peer. The
  // claimable-state breakdown reads matchedByFilter 0, which for a non-plan scope used to be
  // interpreted as `spec-empty` (the spec itself is wrong). It is not empty: its rows are with
  // their holders.
  const zeroIdLane = {
    claimable: 0,
    matchedByFilter: 0,
    excluded: {},
    fleetPaused: false,
    planScoped: false,
  };

  it('reports a non-plan zero as drained, not spec-empty, when the remainder is held or parked', () => {
    expect(interpretFleetClaimability(zeroIdLane).state).toBe('spec-empty');
    const interpretation = interpretFleetClaimability({ ...zeroIdLane, remainderUnclaimable: true });
    expect(interpretation.state).toBe('drained');
    expect(interpretation.exactness.status).toBe('exact');
    expect(interpretation.exactness.reason).toMatch(/held by an agent, or parked/);
    // Its reason is distinct from a confirmed drain, which says the lane is complete.
    expect(interpretation.exactness.reason).not.toMatch(/lane is complete/);
  });

  it('keeps a pause and a confirmed drain ahead of the held-or-parked remainder', () => {
    expect(interpretFleetClaimability({ ...zeroIdLane, fleetPaused: true, remainderUnclaimable: true }).state).toBe('paused');
    expect(
      interpretFleetClaimability({ ...zeroIdLane, drainConfirmed: true, remainderUnclaimable: true }).exactness.reason,
    ).toMatch(/lane is complete/);
  });
});
