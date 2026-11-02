import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanItem } from '@papercusp/plan-parser';
import type { FleetLaneHealth } from '../../fleet/lane-health';

const mocks = vi.hoisted(() => ({
  getPlanRow: vi.fn(),
  planItemsForRow: vi.fn(),
  listWorkItems: vi.fn(),
  readClaimSpecLaneHealth: vi.fn(),
}));

vi.mock('./source', () => ({
  getPlanRow: (...args: unknown[]) => mocks.getPlanRow(...args),
  planItemsForRow: (...args: unknown[]) => mocks.planItemsForRow(...args),
}));

vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  WORK_ITEMS_MAX_LIMIT: 2_000,
  listWorkItems: (...args: unknown[]) => mocks.listWorkItems(...args),
}));

vi.mock('../../fleet/lane-health', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readClaimSpecLaneHealth: (...args: unknown[]) => mocks.readClaimSpecLaneHealth(...args),
  // The real diagnosed reader calls the raw reader through a module-internal
  // binding the mock above cannot intercept, so route it through the same mock
  // with the real wrapper's contract: exact read → unavailable:null; null or a
  // thrown read → laneHealth as read plus a detail naming the cause.
  readClaimSpecLaneHealthDiagnosed: async (args: Record<string, unknown>) => {
    try {
      const laneHealth = (await mocks.readClaimSpecLaneHealth(args)) as FleetLaneHealth | null;
      if (laneHealth?.effective.claimable != null) return { laneHealth, unavailable: null };
      return { laneHealth, unavailable: { code: 'lane-health-unavailable', detail: 'no exact measurement' } };
    } catch (error) {
      return {
        laneHealth: null,
        unavailable: { code: 'lane-health-unavailable', detail: `Cause: ${(error as Error).message}` },
      };
    }
  },
}));

import {
  buildExactPlanClaimSpec,
  deriveExactPlanClaimKinds,
  evaluateExactPlanAdmission,
  preflightExactPlanLaneHealth,
  preflightExactPlanAdmission,
} from './plan-admission-preflight';
import { validateClaimSpec } from '../../scheduler/claim-spec';
import { stopTheLineExplanation } from '../../work-items-admission';
import { ISSUE_FAMILY_KINDS } from '../../work-items';

const item = (id: string, storedStatus: PlanItem['storedStatus'] = 'todo', blockedBy: string[] = []): PlanItem => ({
  id,
  text: id,
  storedStatus,
  importance: 'normal',
  blockedBy,
  decisionRefs: [],
  phase: null,
  lineNumber: 1,
  rawLine: `- **${id}** \`${storedStatus}\` ${id}`,
});

const lane = (args: {
  issue?: number;
  issueMatchedByFilter?: number;
  issueExcluded?: Record<string, number>;
  feature?: number | null;
  featureMatchedByFilter?: number | null;
  featureExcluded?: Record<string, number> | null;
  issueReachable?: boolean;
  featureReachable?: boolean;
  assigneeScoped?: string | null;
}): FleetLaneHealth => {
  const issueReachable = args.issueReachable ?? true;
  const featureReachable = args.featureReachable ?? true;
  const issue = issueReachable ? (args.issue ?? 0) : 0;
  const issueMatchedByFilter = args.issueMatchedByFilter ?? issue;
  const issueExcluded = args.issueExcluded ?? {};
  const feature = featureReachable ? (args.feature ?? 0) : null;
  const featureMatchedByFilter = args.featureMatchedByFilter ?? null;
  const featureExcluded = args.featureExcluded ?? null;
  const mixed = issueReachable && featureReachable;
  return {
    claimable: issue,
    matchedByFilter: issueMatchedByFilter,
    excluded: issueExcluded,
    issueFamily: { claimable: issue, matchedByFilter: issueMatchedByFilter, excluded: issueExcluded },
    featureFamily: featureReachable
      ? { claimable: feature, matchedByFilter: featureMatchedByFilter, excluded: featureExcluded }
      : null,
    effective: mixed
      ? {
          claimable: feature == null ? null : issue + feature,
          matchedByFilter: featureMatchedByFilter == null ? null : issueMatchedByFilter + featureMatchedByFilter,
          excluded: featureExcluded == null ? null : { ...issueExcluded, ...featureExcluded },
          basis: 'issue+feature-family',
        }
      : featureReachable
        ? { claimable: feature, matchedByFilter: featureMatchedByFilter, excluded: featureExcluded, basis: 'feature-family' }
        : issueReachable
          ? {
              claimable: issue,
              matchedByFilter: issueMatchedByFilter,
              excluded: issueExcluded,
              basis: 'issue-family',
            }
          : { claimable: 0, matchedByFilter: 0, excluded: {}, basis: 'no-family' },
    familyReachability: { issue: issueReachable, feature: featureReachable },
    spec: {
      ref: 'exact-plan@1',
      specId: 'exact-plan',
      revision: 1,
      matchedBy: 'test',
      harness: 'papercusp',
      assigneeScoped: args.assigneeScoped === undefined ? 'su-test' : args.assigneeScoped,
    },
  };
};

describe('evaluateExactPlanAdmission', () => {
  it('counts reconciled live parent and child coverage as one execution lane', () => {
    const result = evaluateExactPlanAdmission({
      planSlug: 'plan-a', planItems: [item('P-001')],
      workItems: [
        { id: 'WI-node', family: 'feature', state: 'open', sourcePlanItemIds: ['P-001'], payload: null },
        { id: 'WI-legacy', family: 'issue', state: 'open', parent: 'WI-node', sourcePlanItemIds: ['P-001'], payload: null },
      ],
      laneHealth: lane({ feature: 1, issue: 0 }),
    });
    expect(result).toMatchObject({ ready: true, promotion: { rows: 2, duplicateActionable: [] },
      actionableRows: [{ planItemId: 'P-001', workItemId: 'WI-node' }] });
  });

  it('retains an unfinished child when its parent is settled', () => {
    expect(evaluateExactPlanAdmission({
      planSlug: 'plan-a', planItems: [item('P-001')],
      workItems: [
        { id: 'WI-node', family: 'feature', state: 'done', sourcePlanItemIds: ['P-001'], payload: null },
        { id: 'WI-residue', family: 'issue', state: 'open', parent: 'WI-node', sourcePlanItemIds: ['P-001'], payload: null },
      ],
      laneHealth: lane({ issue: 1 }),
    })).toMatchObject({ ready: true,
      actionableRows: [{ planItemId: 'P-001', workItemId: 'WI-residue' }] });
  });

  it('still rejects unrelated competing rows even when one has a parent', () => {
    expect(evaluateExactPlanAdmission({
      planSlug: 'plan-a', planItems: [item('P-001'), item('P-002')],
      workItems: [
        { id: 'WI-node', family: 'feature', sourcePlanItemIds: ['P-001'], payload: null },
        { id: 'WI-other', family: 'feature', sourcePlanItemIds: ['P-002'], payload: null },
        { id: 'WI-competing', family: 'issue', parent: 'WI-other', sourcePlanItemIds: ['P-001'], payload: null },
      ],
      laneHealth: lane({ feature: 2, issue: 1 }),
    })).toMatchObject({ ready: false, reason: 'duplicate-coverage', promotion: {
      duplicateActionable: [{ planItemId: 'P-001', workItemIds: ['WI-node', 'WI-competing'] }],
    } });
  });

  it('checks only targeted coverage while resolving dependencies against the whole plan', () => {
    const args = {
      planSlug: 'plan-a',
      planItems: [item('P-001'), item('P-002'), item('P-003', 'todo', ['P-004']), item('P-004', 'done')],
      workItems: [
        { id: 'WI-1a', family: 'issue' as const, sourcePlanItemIds: ['P-001'], payload: null },
        { id: 'WI-1b', family: 'issue' as const, sourcePlanItemIds: ['P-001'], payload: null },
        { id: 'WI-3', family: 'issue' as const, sourcePlanItemIds: ['P-003'], payload: null },
      ],
      laneHealth: lane({ issue: 1, featureReachable: false }),
      requestedSeats: 1,
    };
    expect(evaluateExactPlanAdmission({ ...args, planItemIds: ['P-003'] })).toMatchObject({
      ready: true, promotion: { duplicateActionable: [], missingActionableItemIds: [] },
      parallelism: { readyWidth: 1, readyItemIds: ['P-003'] },
    });
    expect(evaluateExactPlanAdmission({ ...args, planItemIds: ['P-001'] })).toMatchObject({
      ready: false, reason: 'duplicate-coverage',
    });
    expect(evaluateExactPlanAdmission({ ...args, planItems: args.planItems.map((row) =>
      row.id === 'P-004' ? item('P-004', 'wip') : row), planItemIds: ['P-003'] })).toMatchObject({
      ready: false, reason: 'no-actionable-plan-items',
      parallelism: { nonReadyItems: [{ itemId: 'P-003', blockerIds: ['P-004'] }] },
    });
  });

  it('refuses unknown item targets and preserves whole-plan admission by default', () => {
    const args = { planSlug: 'plan-a', planItems: [item('P-001')],
      workItems: [], laneHealth: null };
    expect(evaluateExactPlanAdmission({ ...args, planItemIds: ['P-999'] })).toMatchObject({
      ready: false, reason: 'invalid-plan-item-scope',
    });
    expect(evaluateExactPlanAdmission(args)).toMatchObject({ ready: false, reason: 'promotion-lag' });
  });

  it('surfaces probable-mistake findings without changing an otherwise ready verdict', () => {
    const planItems = [
      item('P-001'),
      item('P-002', 'todo', ['P-001']),
      item('P-003', 'todo', ['P-002']),
    ];
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems,
      workItems: [{ id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({ issue: 1, featureReachable: false }),
    });

    expect(verdict.status).toBe('ready');
    expect(verdict.findings).toContainEqual(expect.objectContaining({ code: 'narrow-or-deep-topology' }));
  });
  it('ignores terminal historical promotions when checking duplicate actionable coverage', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [
        {
          id: 'WI-live',
          family: 'issue',
          state: 'open',
          sourcePlanItemIds: ['P-001'],
          payload: null,
        },
        {
          id: 'WI-dropped',
          family: 'issue',
          state: 'dropped',
          sourcePlanItemIds: ['P-001'],
          payload: null,
        },
      ],
      laneHealth: lane({ issue: 1, featureReachable: false }),
    });

    expect(verdict).toMatchObject({
      ready: true,
      status: 'ready',
      reason: 'ready',
      promotion: {
        rows: 2,
        coveredActionable: 1,
        duplicateActionable: [],
      },
    });
  });

  it.each([undefined, 'WI-shadow'])('ignores a parked migration node beside its execution row (parent=%s)', (parent) => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [
        { id: 'WI-shadow', family: 'feature', state: 'open', sourcePlanItemIds: ['P-001'],
          payload: { _claimHold: true, claim_hold_by: 'migration:plan-line-work-item-nodes' } },
        { id: 'WI-execution', family: 'issue', state: 'open', parent, sourcePlanItemIds: ['P-001'], payload: null },
      ],
      laneHealth: lane({ issue: 1, feature: 0 }),
    });

    expect(verdict).toMatchObject({ ready: true, reason: 'ready',
      promotion: { rows: 2, byFamily: { feature: 1, issue: 1 }, duplicateActionable: [] },
      actionableRows: [{ planItemId: 'P-001', workItemId: 'WI-execution' }] });
    expect(verdict.claimKinds).toEqual([...ISSUE_FAMILY_KINDS]);
  });

  it.each([
    { _claimHold: false, claim_hold_by: 'migration:plan-line-work-item-nodes' },
    { _claimHold: true, claim_hold_by: 'su-reviewer' },
  ])('still rejects an actual competing row with hold metadata %j', (payload) => {
    expect(evaluateExactPlanAdmission({
      planSlug: 'plan-a', planItems: [item('P-001')],
      workItems: [
        { id: 'WI-other', family: 'feature', state: 'open', sourcePlanItemIds: ['P-001'], payload },
        { id: 'WI-execution', family: 'issue', state: 'open', sourcePlanItemIds: ['P-001'], payload: null },
      ],
      laneHealth: lane({ issue: 1, feature: 0 }),
    })).toMatchObject({ ready: false, reason: 'duplicate-coverage', promotion: {
      duplicateActionable: [{ planItemId: 'P-001', workItemIds: ['WI-other', 'WI-execution'] }],
    } });
  });

  it('does not admit a plan whose only coverage is a parked migration node', () => {
    expect(evaluateExactPlanAdmission({
      planSlug: 'plan-a', planItems: [item('P-001')],
      workItems: [{ id: 'WI-shadow', family: 'feature', state: 'open', sourcePlanItemIds: ['P-001'],
        payload: { _claimHold: true, claim_hold_by: 'migration:plan-line-work-item-nodes' } }],
      laneHealth: lane({ issue: 0, feature: 0, featureMatchedByFilter: 1, featureExcluded: { claimHold: 1 } }),
    })).toMatchObject({ ready: false, promotion: { rows: 1 } });
  });

  it('admits a feature-only exact-plan lane from feature-family truth', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'F-1', family: 'feature', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({ issueReachable: false, feature: 1 }),
    });

    expect(verdict).toMatchObject({
      ready: true,
      status: 'ready',
      reason: 'ready',
      promotion: {
        rows: 1,
        byFamily: { feature: 1, issue: 0 },
        coveredActionable: 1,
      },
      lane: { effective: { claimable: 1, basis: 'feature-family' } },
    });
  });

  it('admits an issue-only lane and recognizes the legacy payload.plan_item provenance fallback', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [
        {
          id: 'WI-1',
          family: 'issue',
          sourcePlanItemIds: null,
          payload: { plan_item: { item_id: 'P-001' } },
        },
      ],
      laneHealth: lane({ issue: 1, featureReachable: false }),
    });

    expect(verdict).toMatchObject({
      ready: true,
      reason: 'ready',
      promotion: { byFamily: { feature: 0, issue: 1 }, coveredActionable: 1 },
      lane: { effective: { claimable: 1, basis: 'issue-family' } },
    });
  });

  it('derives a family lane only from active promoted rows and preserves mixed-family plans', () => {
    expect(
      deriveExactPlanClaimKinds([
        { family: 'issue', state: 'open' },
        { family: 'issue', state: 'done' },
      ]),
    ).toEqual(ISSUE_FAMILY_KINDS);
    expect(
      deriveExactPlanClaimKinds([
        { family: 'issue', state: 'open' },
        { family: 'feature', state: 'open' },
      ]),
    ).toBeUndefined();
    expect(deriveExactPlanClaimKinds([{ family: 'feature', state: 'done' }])).toBeUndefined();
  });

  it('reports a fully blocked DAG with structural root classes instead of treating zero as drained', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001', 'wip'), item('P-002', 'todo', ['P-001'])],
      workItems: [],
      laneHealth: lane({ issue: 0, feature: 0 }),
    });

    expect(verdict).toMatchObject({
      ready: false,
      status: 'blocked',
      reason: 'no-actionable-plan-items',
      planItems: {
        actionable: 0,
        rootClasses: { dependency: 1, 'non-actionable-status': 1 },
      },
    });
  });

  it('refuses promotion lag before interpreting the scheduler lane count', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [],
      laneHealth: lane({ issue: 1, feature: 1 }),
    });

    expect(verdict).toMatchObject({
      ready: false,
      status: 'refused',
      reason: 'promotion-lag',
      promotion: { missingActionableItemIds: ['P-001'] },
    });
  });

  it('D-055: refuses an actionable promoted feature without inventing a floor diagnosis', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'F-1', family: 'feature', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({ issue: 0, feature: 0 }),
    });

    expect(verdict).toMatchObject({
      ready: false,
      status: 'refused',
      reason: 'floor-diagnostics-unavailable',
      planItems: { actionable: 1 },
      promotion: {
        byFamily: { feature: 1, issue: 0 },
        coveredActionable: 1,
      },
      lane: { effective: { claimable: 0 } },
    });
    expect(verdict.message).toContain('diagnostics do not expose matched-row or exclusion-floor counts');
    expect(verdict.message).toContain('cannot identify whether the filter matched rows or which claim floor excluded them');
    expect(verdict.message).not.toContain('every matched row is excluded by claim floors');
  });

  it('names the feature-family reservation floor when exact-plan diagnostics measure it', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'F-1', family: 'feature', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({
        issueReachable: false,
        feature: 0,
        featureMatchedByFilter: 2,
        featureExcluded: { claimFloors: 2, reservedPlanLane: 2 },
      }),
    });

    expect(verdict).toMatchObject({
      ready: false,
      status: 'refused',
      reason: 'floor-gated',
      lane: { effective: { claimable: 0, matchedByFilter: 2, excluded: { claimFloors: 2, reservedPlanLane: 2 } } },
    });
    expect(verdict.message).toContain('claimFloors=2');
    expect(verdict.message).toContain('reservedPlanLane=2');
    expect(verdict.message).not.toContain('diagnostics do not expose');
    expect(verdict.actionableRows).toEqual([{ planItemId: 'P-001', workItemId: 'F-1' }]);
  });

  it('explains an all-match stop-the-line block and gives the by-ID plan-start route', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'F-1', family: 'feature', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({
        issueReachable: false,
        feature: 0,
        featureMatchedByFilter: 3,
        featureExcluded: { claimFloors: 3, reservedPlanLane: 0, stopTheLine: 3 },
      }),
    });

    expect(verdict).toMatchObject({ ready: false, status: 'refused', reason: 'floor-gated' });
    expect(verdict.message).toContain('stopTheLine=3');
    expect(verdict.message).toContain(stopTheLineExplanation('papercusp'));
    expect(verdict.message).toContain('work_items:claim');
    expect(verdict.message).toContain('claim otherwise-ready rows by ID');
    expect(verdict.message).toContain('plans:start accepts rows already held by this caller');

    const partial = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'F-1', family: 'feature', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({
        issueReachable: false,
        feature: 0,
        featureMatchedByFilter: 3,
        featureExcluded: { claimFloors: 3, reservedPlanLane: 0, stopTheLine: 2 },
      }),
    });
    expect(partial.message).toContain('stopTheLine=2');
    expect(partial.message).not.toContain(stopTheLineExplanation('papercusp'));
  });

  it('keeps caller-held plan-start recovery out of a new-member fleet launch', () => {
    const common = {
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'F-1', family: 'feature' as const, sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({ issueReachable: false, feature: 0, featureMatchedByFilter: 1,
        featureExcluded: { claimFloors: 1, stopTheLine: 1 } }),
    };
    const launch = evaluateExactPlanAdmission({ ...common, requestedSeats: 1 });
    expect(launch).toMatchObject({ ready: false, reason: 'floor-gated' });
    expect(launch.message).toContain('Launching new fleet members requires rows those members can claim');
    expect(launch.message).toContain('Claiming a row for the leader does not satisfy this launch');
    expect(launch.message).not.toContain('then retry plans:start');

    const held = { ...common, assignee: 'leader', allowCallerHeld: true,
      workItems: [{ ...common.workItems[0], assignee: 'leader', state: 'open' as const }],
      laneHealth: lane({ issueReachable: false, feature: 0, featureMatchedByFilter: 1,
        featureExcluded: { claimFloors: 1, taken: 1 } }),
    };
    expect(evaluateExactPlanAdmission({ ...held, requestedSeats: 1 })).toMatchObject({
      ready: false, reason: 'floor-gated', executableWidth: 0,
    });
    expect(evaluateExactPlanAdmission(held)).toMatchObject({ ready: true });
  });

  it('names the exact-plan filter when it matches no rows instead of blaming claim floors', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({ issue: 0, featureReachable: false }),
    });

    expect(verdict).toMatchObject({ ready: false, status: 'refused', reason: 'floor-gated' });
    expect(verdict.message).toContain("exact-plan filter (plan = 'plan-a') matches no rows");
    expect(verdict.message).toContain('no row reached the claim floors');
    expect(verdict.message).not.toContain('every row is excluded');
  });

  it('reports internally inconsistent zero-claimable counters instead of inventing a floor cause', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({
        issue: 0,
        issueMatchedByFilter: 3,
        issueExcluded: {},
        featureReachable: false,
      }),
    });

    expect(verdict).toMatchObject({ ready: false, status: 'refused', reason: 'floor-gated' });
    expect(verdict.message).toContain('INTERNAL INCONSISTENCY');
    expect(verdict.message).toContain("filter (plan = 'plan-a') matched 3 row(s)");
    expect(verdict.message).toContain('every reported exclusion bucket is zero');
    expect(verdict.message).toContain('do not support a floor-gated diagnosis');
  });

  it('keeps the floor-gated diagnosis when a nonzero exclusion bucket explains the zero', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({
        issue: 0,
        issueMatchedByFilter: 3,
        issueExcluded: { claimHold: 3 },
        featureReachable: false,
      }),
    });

    expect(verdict).toMatchObject({ ready: false, status: 'refused', reason: 'floor-gated' });
    expect(verdict.message).toContain("claimant scope 'su-test'");
    expect(verdict.message).toContain('every matched row is excluded by claim floors');
    expect(verdict.message).not.toContain('INTERNAL INCONSISTENCY');
  });

  it('names the caller-neutral population when fleet-wide floors exclude every row', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({
        issue: 0,
        issueMatchedByFilter: 1,
        issueExcluded: { claimHold: 1 },
        featureReachable: false,
        assigneeScoped: null,
      }),
    });

    expect(verdict).toMatchObject({ ready: false, status: 'refused', reason: 'floor-gated' });
    expect(verdict.message).toContain('the caller-neutral fleet population');
    expect(verdict.message).toContain('every matched row is excluded by claim floors');
  });

  it('refuses when one actionable promoted family is zero while the other is claimable', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001'), item('P-002')],
      workItems: [
        { id: 'F-1', family: 'feature', sourcePlanItemIds: ['P-001'], payload: null },
        { id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-002'], payload: null },
      ],
      laneHealth: lane({ issue: 1, feature: 0 }),
    });

    expect(verdict).toMatchObject({
      ready: false,
      status: 'refused',
      reason: 'family-disagreement',
      promotion: { byFamily: { feature: 1, issue: 1 } },
    });
  });

  it('admits a capacity-satisfied seat request when the other promoted family is zero', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001'), item('P-002')],
      workItems: [
        { id: 'F-1', family: 'feature', sourcePlanItemIds: ['P-001'], payload: null },
        { id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-002'], payload: null },
      ],
      laneHealth: lane({ issue: 0, feature: 1 }),
      requestedSeats: 1,
    });

    expect(verdict).toMatchObject({
      ready: true,
      status: 'ready',
      reason: 'ready',
      requestedSeats: 1,
      executableWidth: 1,
      seatShortfall: 0,
      promotion: { byFamily: { feature: 1, issue: 1 } },
    });
  });

  it('refuses a seat request wider than the executable DAG frontier and names exact blockers', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001'), item('P-002', 'todo', ['P-001']), item('P-003', 'todo', ['P-002'])],
      workItems: [{ id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({ issue: 1, featureReachable: false }),
      requestedSeats: 3,
    });

    expect(verdict).toMatchObject({
      ready: false,
      status: 'refused',
      reason: 'insufficient-executable-width',
      requestedSeats: 3,
      executableWidth: 1,
      seatShortfall: 2,
      parallelism: {
        readyWidth: 1,
        readyItemIds: ['P-001'],
        criticalPathDepth: 3,
      },
    });
    expect(verdict.message).toContain('P-002<-P-001(todo)');
    expect(verdict.message).toContain('P-003<-P-002(todo)');
  });

  it('counts assigned WIP lanes as occupied width for a wider target request', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [
        item('P-028'),
        item('P-029', 'wip'),
        item('P-030', 'wip'),
        item('P-037', 'wip'),
        item('P-038'),
        item('P-039'),
      ],
      workItems: [
        { id: 'WI-028', family: 'issue', sourcePlanItemIds: ['P-028'], payload: null },
        {
          id: 'WI-029',
          family: 'issue',
          sourcePlanItemIds: ['P-029'],
          payload: null,
          assignee: 'su-live-1',
        },
        {
          id: 'WI-030',
          family: 'issue',
          sourcePlanItemIds: ['P-030'],
          payload: null,
          assignee: 'su-live-2',
        },
        {
          id: 'WI-037',
          family: 'issue',
          sourcePlanItemIds: ['P-037'],
          payload: null,
          assignee: 'su-live-3',
        },
        { id: 'WI-038', family: 'issue', sourcePlanItemIds: ['P-038'], payload: null },
        { id: 'WI-039', family: 'issue', sourcePlanItemIds: ['P-039'], payload: null },
      ],
      laneHealth: lane({ issue: 3, featureReachable: false }),
      requestedSeats: 4,
    });

    expect(verdict).toMatchObject({
      ready: true,
      status: 'ready',
      reason: 'ready',
      requestedSeats: 4,
      occupiedWidth: 3,
      executableWidth: 6,
      seatShortfall: 0,
    });
  });

  it('emits held ready rows with their holder and claim time when the executable frontier is narrower', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001'), item('P-002')],
      workItems: [
        { id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'], payload: null },
        {
          id: 'WI-2',
          family: 'issue',
          sourcePlanItemIds: ['P-002'],
          payload: null,
          assignee: 'su-holder',
          takenAt: '2026-08-24T02:10:42.079Z',
        },
      ],
      laneHealth: lane({ issue: 1, featureReachable: false }),
      requestedSeats: 2,
    });

    expect(verdict).toMatchObject({
      ready: false,
      reason: 'insufficient-executable-width',
      parallelism: { readyWidth: 2, readyItemIds: ['P-001', 'P-002'] },
      executableWidth: 1,
      blockingRows: [
        {
          planItemId: 'P-002',
          workItemId: 'WI-2',
          holder: 'su-holder',
          takenAt: '2026-08-24T02:10:42.079Z',
        },
      ],
    });
    expect(verdict.message).toContain(
      'Held ready rows: P-002->WI-2(holder=su-holder, takenAt=2026-08-24T02:10:42.079Z).',
    );
  });

  it('keeps seat diagnostics optional for existing callers', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'], payload: null }],
      laneHealth: lane({ issue: 1, featureReachable: false }),
    });

    expect(verdict).toMatchObject({
      ready: true,
      requestedSeats: null,
      executableWidth: 1,
      seatShortfall: null,
    });
  });

  it('admits plans:start when the caller already holds every actionable ready row', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [
        {
          id: 'WI-1',
          family: 'issue',
          sourcePlanItemIds: ['P-001'],
          payload: null,
          assignee: 'su-caller',
          takenAt: '2026-08-24T02:10:42.079Z',
        },
      ],
      laneHealth: lane({
        issue: 0,
        issueMatchedByFilter: 1,
        issueExcluded: { taken: 1 },
        featureReachable: false,
      }),
      assignee: 'su-caller',
      allowCallerHeld: true,
    });

    expect(verdict).toMatchObject({
      ready: true,
      status: 'ready',
      reason: 'ready',
      executableWidth: 0,
      blockingRows: [
        {
          planItemId: 'P-001',
          workItemId: 'WI-1',
          holder: 'su-caller',
        },
      ],
    });
    expect(verdict.message).toContain('caller already holds all 1 actionable ready row(s)');
  });

  it('does not let plans:start bypass a row held by another caller', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [
        {
          id: 'WI-1',
          family: 'issue',
          sourcePlanItemIds: ['P-001'],
          payload: null,
          assignee: 'su-other',
          takenAt: '2026-08-24T02:10:42.079Z',
        },
      ],
      laneHealth: lane({
        issue: 0,
        issueMatchedByFilter: 1,
        issueExcluded: { taken: 1 },
        featureReachable: false,
      }),
      assignee: 'su-caller',
      allowCallerHeld: true,
    });

    expect(verdict).toMatchObject({ ready: false, reason: 'floor-gated' });
  });

  it.each([
    { label: 'sole unfinished lane', planItems: [item('P-001', 'wip')] },
    { label: 'lane beside a blocked successor', planItems: [item('P-001', 'wip'), item('P-002', 'todo', ['P-001'])] },
  ])('admits plans:start for the caller-owned WIP $label', ({ planItems }) => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems,
      workItems: [{ id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'],
        payload: null, assignee: 'su-caller', state: 'wip' }],
      laneHealth: lane({ issue: 0, issueMatchedByFilter: 1,
        issueExcluded: { taken: 1 }, featureReachable: false }),
      assignee: 'su-caller',
      allowCallerHeld: true,
    });

    expect(verdict).toMatchObject({ ready: true, reason: 'ready', planItems: { actionable: 0 } });
    expect(verdict.message).toContain('caller already owns 1 active non-final lane(s)');
  });

  it.each([
    { label: 'unclaimed WIP', holder: undefined, allowCallerHeld: true, requestedSeats: undefined },
    { label: 'foreign WIP', holder: 'su-other', allowCallerHeld: true, requestedSeats: undefined },
    { label: 'caller-neutral fleet', holder: 'su-caller', allowCallerHeld: false, requestedSeats: undefined },
    { label: 'new fleet seat', holder: 'su-caller', allowCallerHeld: true, requestedSeats: 1 },
  ])('does not admit a new lane from $label', ({ holder, allowCallerHeld, requestedSeats }) => {
    expect(evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001', 'wip')],
      workItems: [{ id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'],
        payload: null, assignee: holder, state: 'wip' }],
      laneHealth: lane({ issue: 0, issueMatchedByFilter: 1, featureReachable: false }),
      assignee: 'su-caller',
      allowCallerHeld,
      requestedSeats,
    })).toMatchObject({ ready: false, reason: 'no-actionable-plan-items' });
  });

  it('admits plans:start when the caller owns active non-final lanes beside a blocked frontier', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001', 'wip'), item('P-002', 'wip'), item('P-003')],
      workItems: [
        {
          id: 'WI-1',
          family: 'issue',
          sourcePlanItemIds: ['P-001'],
          payload: null,
          assignee: 'su-caller',
        },
        {
          id: 'WI-2',
          family: 'issue',
          sourcePlanItemIds: ['P-002'],
          payload: null,
          assignee: 'su-caller',
        },
        {
          id: 'WI-3',
          family: 'issue',
          sourcePlanItemIds: ['P-003'],
          payload: null,
          assignee: 'su-other',
        },
      ],
      laneHealth: lane({
        issue: 0,
        issueMatchedByFilter: 3,
        issueExcluded: { planLaneReserved: 2, stopTheLine: 1 },
        featureReachable: false,
      }),
      assignee: 'su-caller',
      allowCallerHeld: true,
    });

    expect(verdict).toMatchObject({ ready: true, status: 'ready', reason: 'ready' });
    expect(verdict.message).toContain('caller already owns 2 active non-final lane(s)');
  });
});

describe('preflightExactPlanAdmission IO wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPlanRow.mockResolvedValue({ planSlug: 'plan-a' });
    mocks.planItemsForRow.mockReturnValue([item('P-001')]);
    mocks.listWorkItems.mockResolvedValue([
      {
        id: 'WI-1',
        family: 'issue',
        sourcePlanItemIds: undefined,
        payload: { planItem: { itemId: 'P-001' } },
      },
    ]);
    mocks.readClaimSpecLaneHealth.mockResolvedValue(lane({ issue: 1, featureReachable: false }));
  });

  it('reads lane health before admitting a caller whose only unfinished item is WIP', async () => {
    mocks.planItemsForRow.mockReturnValue([item('P-001', 'done'), item('P-002', 'wip')]);
    mocks.listWorkItems.mockResolvedValue([{ id: 'WI-2', family: 'issue', state: 'wip',
      sourcePlanItemIds: ['P-002'], payload: null, assignee: 'su-test' }]);
    mocks.readClaimSpecLaneHealth.mockResolvedValue(lane({ issue: 0,
      issueMatchedByFilter: 1, issueExcluded: { taken: 1 }, featureReachable: false }));
    const args = { workspaceId: 'ws-1', harnessSlug: 'papercusp', planSlug: 'plan-a',
      actor: 'su-test', claimant: 'su-test', specId: 'plans-start-plan-a', allowCallerHeld: true };

    expect(await preflightExactPlanAdmission(args)).toMatchObject({ ready: true, reason: 'ready' });
    expect(mocks.readClaimSpecLaneHealth).toHaveBeenCalledOnce();

    mocks.readClaimSpecLaneHealth.mockResolvedValue(null);
    expect(await preflightExactPlanAdmission(args)).toMatchObject({ ready: false, reason: 'lane-unknown' });
  });

  it('does not read plan claim floors or promotions for an explicit lanes-only scope', async () => {
    mocks.listWorkItems.mockRejectedValue(new Error('unrelated promotion census unavailable'));
    mocks.readClaimSpecLaneHealth.mockRejectedValue(new Error('unrelated floor measurement unavailable'));
    expect(await preflightExactPlanAdmission({ workspaceId: 'ws-1', harnessSlug: 'papercusp',
      planSlug: 'plan-a', actor: 'su-test', specId: 'lane-only', planItemIds: [], requestedSeats: 4,
    })).toMatchObject({ ready: true, reason: 'ready', planItems: { total: 0 }, lane: null });
    expect(mocks.listWorkItems).not.toHaveBeenCalled();
    expect(mocks.readClaimSpecLaneHealth).not.toHaveBeenCalled();
    mocks.getPlanRow.mockResolvedValue(null);
    expect(await preflightExactPlanAdmission({ workspaceId: 'ws-1', harnessSlug: 'papercusp',
      planSlug: 'missing', actor: 'su-test', specId: 'lane-only', planItemIds: [],
    })).toMatchObject({ ready: false, reason: 'plan-not-found' });
  });

  it('uses the normalized execution tree for the scheduler family filter too', async () => {
    mocks.planItemsForRow.mockReturnValue([item('P-001')]);
    mocks.listWorkItems.mockResolvedValue([
      { id: 'WI-node', family: 'feature', state: 'open', sourcePlanItemIds: ['P-001'], payload: null },
      { id: 'WI-legacy', family: 'issue', state: 'open', parent: 'WI-node', sourcePlanItemIds: ['P-001'], payload: null },
    ]);
    mocks.readClaimSpecLaneHealth.mockResolvedValueOnce(lane({ feature: 1, issue: 0 }));
    expect(await preflightExactPlanAdmission({ workspaceId: 'ws-1', harnessSlug: 'papercusp',
      planSlug: 'plan-a', actor: 'su-test', specId: 'canonical-line',
    })).toMatchObject({ ready: true, claimKinds: ['feature'] });
    expect(mocks.readClaimSpecLaneHealth.mock.calls.at(-1)?.[0].spec.view.filter).toEqual({ all: [
      { field: 'plan', op: '=', value: 'plan-a' },
      { field: 'kind', op: 'in', value: ['feature'] },
    ] });
  });

  it('narrows both coverage and the scheduler floor read to exactly the targeted items', async () => {
    mocks.planItemsForRow.mockReturnValue([item('P-001'), item('P-002')]);
    mocks.listWorkItems.mockResolvedValue([
      { id: 'WI-1', family: 'issue', sourcePlanItemIds: ['P-001'], payload: null },
      { id: 'F-2a', family: 'feature', sourcePlanItemIds: ['P-002'], payload: null },
      { id: 'F-2b', family: 'feature', sourcePlanItemIds: ['P-002'], payload: null },
    ]);
    mocks.readClaimSpecLaneHealth.mockImplementationOnce(async ({ spec }) => {
      expect(spec.view.filter).toEqual({ all: [
        { field: 'plan', op: '=', value: 'plan-a' },
        { field: 'plan_item', op: 'in', value: ['P-001'] },
        { field: 'kind', op: 'in', value: [...ISSUE_FAMILY_KINDS] },
      ] });
      expect(validateClaimSpec(spec)).toMatchObject({ ok: true });
      return lane({ issue: 0, issueMatchedByFilter: 1, issueExcluded: { stopTheLine: 1 },
        featureReachable: false });
    });
    expect(await preflightExactPlanAdmission({ workspaceId: 'ws-1', harnessSlug: 'papercusp',
      planSlug: 'plan-a', actor: 'su-test', specId: 'scoped', planItemIds: ['P-001'],
    })).toMatchObject({ ready: false, reason: 'floor-gated', claimKinds: [...ISSUE_FAMILY_KINDS],
      promotion: { duplicateActionable: [] }, actionableRows: [{ planItemId: 'P-001', workItemId: 'WI-1' }] });
  });

  it('reads the exact plan census, validates the generated spec, and wires scope into lane health', async () => {
    const verdict = await preflightExactPlanAdmission({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      actor: 'su-test',
      claimant: 'su-test',
      specId: 'plans-start-plan-a',
      fleetSlug: 'fleet-a',
      claimKinds: ['bug'],
      requestedSeats: 1,
    });

    expect(verdict).toMatchObject({ ready: true, reason: 'ready' });
    expect(mocks.getPlanRow).toHaveBeenCalledWith('plan-a', {
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
    });
    expect(mocks.planItemsForRow).toHaveBeenCalledWith({ planSlug: 'plan-a' });
    expect(mocks.listWorkItems).toHaveBeenCalledWith({
      harness: 'papercusp',
      sourcePlanSlug: 'plan-a',
      includeChildren: true,
      limit: 2_000,
    });
    expect(mocks.readClaimSpecLaneHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        fleet: 'fleet-a',
        harness: 'papercusp',
        workspaceId: 'ws-1',
        assignee: 'su-test',
        matchedBy: 'exact-plan-preflight',
        spec: expect.objectContaining({ specId: 'plans-start-plan-a', states: ['open'] }),
        record: expect.objectContaining({ fleetSlug: 'fleet-a', harnessSlug: 'papercusp' }),
      }),
    );
    expect(verdict.requestedSeats).toBe(1);
  });

  it('keeps a released ready row launchable by omitting the leader from the fleet population read', async () => {
    mocks.readClaimSpecLaneHealth.mockImplementationOnce(async (args: { assignee?: string }) =>
      args.assignee
        ? lane({ issue: 0, issueMatchedByFilter: 1, issueExcluded: { cooldown: 1 }, featureReachable: false })
        : lane({ issue: 1, issueMatchedByFilter: 1, featureReachable: false, assigneeScoped: null }),
    );

    const verdict = await preflightExactPlanAdmission({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      actor: 'su-leader',
      specId: 'fleet-launch-fleet-a-plan',
      fleetSlug: 'fleet-a',
      requestedSeats: 1,
    });

    expect(verdict).toMatchObject({ ready: true, reason: 'ready', executableWidth: 1 });
    expect(mocks.readClaimSpecLaneHealth).toHaveBeenCalledWith(
      expect.objectContaining({ assignee: undefined, fleet: 'fleet-a' }),
    );
    expect(mocks.readClaimSpecLaneHealth.mock.calls[0][0].record).toEqual(
      expect.objectContaining({ updatedBy: 'su-leader' }),
    );
  });

  it('narrows a single-family plan census but leaves mixed-family plans broad', async () => {
    const issueOnly = await preflightExactPlanAdmission({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      actor: 'su-test',
      claimant: 'su-test',
      specId: 'plans-start-plan-a',
    });

    expect(issueOnly).toMatchObject({ claimKinds: [...ISSUE_FAMILY_KINDS] });
    expect(mocks.readClaimSpecLaneHealth.mock.calls.at(-1)?.[0].spec.view.filter).toEqual({
      all: [
        { field: 'plan', op: '=', value: 'plan-a' },
        { field: 'kind', op: 'in', value: [...ISSUE_FAMILY_KINDS] },
      ],
    });

    mocks.planItemsForRow.mockReturnValue([item('P-001'), item('P-002')]);
    mocks.listWorkItems.mockResolvedValue([
      { id: 'WI-1', family: 'issue', state: 'open', sourcePlanItemIds: ['P-001'], payload: null },
      { id: 'F-1', family: 'feature', state: 'open', sourcePlanItemIds: ['P-002'], payload: null },
    ]);
    mocks.readClaimSpecLaneHealth.mockResolvedValueOnce(lane({ issue: 1, feature: 1 }));

    const mixed = await preflightExactPlanAdmission({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      actor: 'su-test',
      claimant: 'su-test',
      specId: 'plans-start-plan-a',
    });

    expect(mixed).toMatchObject({ ready: true, claimKinds: null });
    expect(mocks.readClaimSpecLaneHealth.mock.calls.at(-1)?.[0].spec.view.filter).toEqual({
      field: 'plan',
      op: '=',
      value: 'plan-a',
    });
  });

  it('builds a validator-clean plan-only claim spec', () => {
    const spec = buildExactPlanClaimSpec('exact-plan', 'plan-a');
    expect(validateClaimSpec(spec)).toMatchObject({ ok: true });
    expect(spec.view.filter).toEqual({ field: 'plan', op: '=', value: 'plan-a' });
  });
});

describe('preflightExactPlanLaneHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readClaimSpecLaneHealth.mockResolvedValue(lane({ issue: 0, feature: 0 }));
  });

  it('reads the broad exact-plan lane without requiring promoted-row coverage', async () => {
    const laneHealth = await preflightExactPlanLaneHealth({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      actor: 'su-test',
      claimant: 'su-test',
      specId: 'plans-start-plan-a-lane-health',
      fleetSlug: 'exact-plan:plan-a',
    });

    expect(laneHealth).toMatchObject({ effective: { claimable: 0 } });
    expect(mocks.getPlanRow).not.toHaveBeenCalled();
    expect(mocks.listWorkItems).not.toHaveBeenCalled();
    expect(mocks.readClaimSpecLaneHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        fleet: 'exact-plan:plan-a',
        harness: 'papercusp',
        workspaceId: 'ws-1',
        assignee: 'su-test',
        matchedBy: 'exact-plan-lane-health-preflight',
        spec: expect.objectContaining({
          specId: 'plans-start-plan-a-lane-health',
          view: { filter: { field: 'plan', op: '=', value: 'plan-a' } },
        }),
      }),
    );
  });

  it('names the lane-read failure cause in the lane-unknown refusal (WI-10004851)', async () => {
    mocks.readClaimSpecLaneHealth.mockRejectedValueOnce(new Error('issue-family aggregate timed out'));
    const verdict = await preflightExactPlanAdmission({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      actor: 'su-test',
      claimant: 'su-test',
      specId: 'plans-start-plan-a',
      claimKinds: ['bug'],
    });
    expect(verdict).toMatchObject({ ready: false, reason: 'lane-unknown' });
    expect(verdict.message).toContain('could not be read completely');
    expect(verdict.message).toContain('issue-family aggregate timed out');
  });

  it('keeps the lane-unknown message unchanged when no cause is known', () => {
    const verdict = evaluateExactPlanAdmission({
      planSlug: 'plan-a',
      planItems: [item('P-001')],
      workItems: [{ id: 'WI-1', family: 'issue', sourcePlanItemIds: undefined, payload: { planItem: { itemId: 'P-001' } } }],
      laneHealth: null,
    } as Parameters<typeof evaluateExactPlanAdmission>[0]);
    expect(verdict).toMatchObject({ reason: 'lane-unknown' });
    expect(verdict.message).toBe('The exact-plan claim lane could not be read completely.');
  });

  it('preserves UNKNOWN instead of converting an unavailable lane read to zero', async () => {
    mocks.readClaimSpecLaneHealth.mockResolvedValue(null);

    await expect(
      preflightExactPlanLaneHealth({
        workspaceId: 'ws-1',
        harnessSlug: 'papercusp',
        planSlug: 'plan-a',
        actor: 'su-test',
        specId: 'plans-start-plan-a-lane-health',
      }),
    ).resolves.toBeNull();
  });
});
