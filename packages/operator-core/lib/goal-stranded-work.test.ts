/**
 * P-005 / R-5 (plan goal-grading-live-coverage-and-holder-followthrough-2026-10-08):
 * a refused goal placement must not strand its goal-created work item.
 *
 * Falsifier from the plan: "After a refused placement the goal-created work item
 * stays open and unassigned with no queue entry, drop, or agenda flag."
 */
import { describe, expect, it, vi } from 'vitest';
import {
  GOAL_PLACEMENT_REFUSAL_MAX_IDS,
  GOAL_STRANDED_WORK_THRESHOLD_MS,
  goalPlacementRefusalNote,
  launchNamedWorkItemIds,
  recordGoalPlacementRefusal,
  type GoalPlacementRefusalMark,
  type RecordGoalPlacementRefusalDeps,
  type StrandedGoalWork,
} from './goal-stranded-work';
import { buildAgentObligationAgenda, strandedGoalWorkObligations } from './agent-obligation-providers';

const OBSERVED_AT = '2026-10-08T18:00:00.000Z';
const GOAL = 'work-on-everything-fresh-grading-and-improvement-60d3a8';

function stranded(over: Partial<StrandedGoalWork> = {}): StrandedGoalWork {
  return {
    goalId: GOAL,
    thresholdMs: GOAL_STRANDED_WORK_THRESHOLD_MS,
    total: 0,
    refusedCount: 0,
    sample: [],
    truncatedByLimit: false,
    ...over,
  };
}

function providerInput(read: StrandedGoalWork | { status: 'unknown' }) {
  return {
    workspaceId: 'papercusp-workspace',
    ownerId: 'su-holder',
    goalId: GOAL,
    observedAt: OBSERVED_AT,
    sourceGeneration: 'gen-1',
    read:
      'status' in read
        ? ({ status: 'unknown', failure: { code: 'x', detail: 'read failed', retry: 'retry it' } } as const)
        : ({ status: 'known', value: read } as const),
  };
}

describe('launchNamedWorkItemIds', () => {
  it('takes the explicit binding first, then ids from the brief, deduplicated', () => {
    expect(
      launchNamedWorkItemIds({
        feature: 'WI-10007120',
        workItem: 'WI-10007120',
        brief: 'Then advance the existing audit WI-10007120 and read EI-24828088686626514 first.',
      }),
    ).toEqual(['WI-10007120', 'EI-24828088686626514']);
  });

  it('finds the id the measured 2026-10-07 refusal named only in its brief', () => {
    expect(
      launchNamedWorkItemIds({
        brief: 'Then advance the existing audit WI-10007120 through the admitted claim rail.',
      }),
    ).toEqual(['WI-10007120']);
  });

  it('is bounded', () => {
    const brief = Array.from({ length: 30 }, (_, i) => `WI-${1000 + i}`).join(' ');
    expect(launchNamedWorkItemIds({ brief })).toHaveLength(GOAL_PLACEMENT_REFUSAL_MAX_IDS);
  });
});

describe('recordGoalPlacementRefusal (the refusal half)', () => {
  function deps(eligibleIds: string[]): RecordGoalPlacementRefusalDeps & { stamps: Array<[string, GoalPlacementRefusalMark]> } {
    const stamps: Array<[string, GoalPlacementRefusalMark]> = [];
    return {
      stamps,
      eligible: vi.fn<RecordGoalPlacementRefusalDeps['eligible']>(async ({ ids }) =>
        ids.filter((id) => eligibleIds.includes(id)).map((id) => ({ id, harness: 'papercusp' })),
      ),
      stamp: vi.fn<RecordGoalPlacementRefusalDeps['stamp']>(async (id, _harness, mark) => {
        stamps.push([id, mark]);
        return { id };
      }),
    };
  }

  it('stamps the goal-created item a refused launch named, so it is never silently stranded', async () => {
    const d = deps(['WI-10007120']);
    const record = await recordGoalPlacementRefusal(
      {
        workspaceId: 'papercusp-workspace',
        goalId: GOAL,
        launcherOwnerId: 'su-d5bfd1a5',
        reason: 'goal_max_agents',
        message: 'allows 6 concurrent agent(s); 8 live',
        source: 'capability:launch-agent',
        named: ['WI-10007120', 'WI-999'],
        at: new Date(OBSERVED_AT),
      },
      d,
    );
    expect(record).toEqual({ named: ['WI-10007120', 'WI-999'], marked: ['WI-10007120'], error: null });
    expect(d.stamps).toEqual([
      [
        'WI-10007120',
        {
          at: OBSERVED_AT,
          reason: 'goal_max_agents',
          goalId: GOAL,
          launcherOwnerId: 'su-d5bfd1a5',
          message: 'allows 6 concurrent agent(s); 8 live',
          source: 'capability:launch-agent',
        },
      ],
    ]);
    // The caller is told the item is flagged and given both lawful dispositions.
    const note = goalPlacementRefusalNote(record);
    expect(note).toContain('WI-10007120');
    expect(note).toContain('stranded-goal-work');
    expect(note).toContain("state: 'dropped'");
  });

  it('stamps nothing when the launch named no eligible item (another goal, claimed, or closed)', async () => {
    const d = deps([]);
    const record = await recordGoalPlacementRefusal(
      {
        workspaceId: 'papercusp-workspace', goalId: GOAL, launcherOwnerId: 'su-x', reason: 'goal_max_agents',
        message: 'm', source: 'capability:launch-agent', named: ['WI-1'],
      },
      d,
    );
    expect(record.marked).toEqual([]);
    expect(d.stamp).not.toHaveBeenCalled();
    expect(goalPlacementRefusalNote(record)).toBe('');
  });

  it('never queries when the launch named nothing', async () => {
    const d = deps(['WI-1']);
    await recordGoalPlacementRefusal(
      { workspaceId: 'w', goalId: GOAL, launcherOwnerId: 'su-x', reason: 'r', message: 'm', source: 's', named: [] },
      d,
    );
    expect(d.eligible).not.toHaveBeenCalled();
  });

  it('reports a failed eligibility read in band instead of claiming success', async () => {
    const record = await recordGoalPlacementRefusal(
      { workspaceId: 'w', goalId: GOAL, launcherOwnerId: 'su-x', reason: 'r', message: 'm', source: 's', named: ['WI-1'] },
      { eligible: async () => { throw new Error('db down'); }, stamp: async () => ({}) },
    );
    expect(record.marked).toEqual([]);
    expect(record.error).toContain('db down');
    expect(goalPlacementRefusalNote(record)).toContain('WI-1');
  });
});

describe('strandedGoalWorkObligations (the agenda half)', () => {
  it('flags a refusal-stamped item as a DUE, high-priority obligation naming it', () => {
    const [row] = strandedGoalWorkObligations(
      providerInput(
        stranded({
          total: 1,
          refusedCount: 1,
          sample: [{
            id: 'WI-10007120', title: 'audit', createdAt: '2026-10-07T11:07:16.215Z',
            placementRefusal: { at: '2026-10-07T12:03:40.864Z', reason: 'goal_max_agents', goalId: GOAL, launcherOwnerId: 'su-d5', message: 'm', source: 'capability:launch-agent' },
          }],
        }),
      ),
    );
    expect(row).toMatchObject({ family: 'stranded-goal-work', status: 'due', priority: 'high' });
    expect(row!.reason).toContain('WI-10007120 (launch refused goal_max_agents)');
    expect(row!.action?.summary).toContain("state: 'dropped'");
  });

  it('flags items unassigned past the threshold, with the exact total and a bounded sample', () => {
    const [row] = strandedGoalWorkObligations(
      providerInput(
        stranded({
          total: 36,
          sample: [{ id: 'WI-1', title: 't', createdAt: '2026-09-20T21:16:13.830Z', placementRefusal: null }],
          truncatedByLimit: true,
        }),
      ),
    );
    expect(row).toMatchObject({ status: 'due', priority: 'normal', applicableDemand: 36 });
    expect(row!.title).toContain('36 goal work item(s)');
    expect(row!.reason).toContain('WI-1 (17d unassigned)');
    expect(row!.reason).toContain('and 35 more');
  });

  it('produces no row when nothing is stranded — that is how the obligation clears', () => {
    expect(strandedGoalWorkObligations(providerInput(stranded()))).toEqual([]);
  });

  it('reports an unreadable source as UNKNOWN, never as nothing stranded', () => {
    const [row] = strandedGoalWorkObligations(providerInput({ status: 'unknown' }));
    expect(row).toMatchObject({ status: 'unknown', family: 'stranded-goal-work' });
    expect(row!.measurementFailure?.detail).toBe('read failed');
  });

  it('reaches the agenda primary list when stranded work exists', () => {
    const agenda = buildAgentObligationAgenda(
      { strandedGoalWork: providerInput(stranded({ total: 2, sample: [] })) },
      OBSERVED_AT,
    );
    expect(agenda.primary.map((entry) => entry.family)).toContain('stranded-goal-work');
  });
});
