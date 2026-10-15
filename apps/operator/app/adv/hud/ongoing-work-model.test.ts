import { describe, expect, it } from 'vitest';
import { ongoingStatus, ongoingWorkView, representedOngoingGoalIds } from './ongoing-work-model';
import type { GoalDetailInput } from './goal-detail-model';
import type { GoalPackageRailEntry } from './GoalPackagesRail';

const goal = { id: 'g-current', title: 'Renamed steward', status: 'active', standing: true };
const detail: GoalDetailInput = {
  goal, holderLiveness: 'held', effectiveStatus: 'active',
  goalModeState: { portfolio: { priorities: ['Place the next priority item', 'Review blocked work'] } },
  waitingOnYouTotal: 31, waitingOnYou: [{ id: 'WI-1', title: 'Choose scope' }],
  activity: [
    { id: 'WI-2', title: 'Actually completed', status: 'done', closedAt: '2026-10-06T12:00:00Z' },
    { id: 'WI-3', title: 'Stopped', status: 'killed', closedAt: '2026-10-07T12:00:00Z' },
    { id: 'WI-4', title: 'Recently edited', status: 'wip', updatedAt: '2026-10-07T13:00:00Z' },
  ],
};

describe('ongoing goal presentation', () => {
  it('uses canonical liveness; an active declaration alone is not Running', () => {
    expect(ongoingStatus('active', 'active', 'unknown').label).toBe('Status unavailable');
    expect(ongoingStatus('active', 'dormant', 'lost').label).toBe('Not running');
    expect(ongoingStatus('active', 'active', 'held').label).toBe('Running');
    expect(ongoingStatus('paused', 'paused', 'held').label).toBe('Paused');
  });
  it('reads real ordered priorities, completed outcomes and the uncapped attention total', () => {
    const view = ongoingWorkView(goal, detail);
    expect(view.focus).toBe('Place the next priority item');
    expect(view.priorities).toEqual(['Place the next priority item', 'Review blocked work']);
    expect(view.latest?.id).toBe('WI-2');
    expect(view.attention).toBe(31);
  });
  it('does not turn missing data into health, spend or progress', () => {
    const view = ongoingWorkView(goal);
    expect(view.focus).toBeNull(); expect(view.latest).toBeNull();
    expect(view.attention).toBeNull(); expect(view.spend).toBeNull();
    expect(ongoingWorkView(goal, { ...detail, goal: { ...goal, id: 'older' } }).focus).toBeNull();
    expect(ongoingWorkView(null, { ...detail, goal: null }).latest).toBeNull();
  });
  it('labels spend and budget by their independent windows, including measured zero', () => {
    const view = ongoingWorkView({ ...goal, spendRecentUsd: 0, spendRecentWindowDays: 3,
      budgetCents: 10000, budgetWindowSec: 604800 });
    expect(view.spend).toBe('$0.00 in the last 3 days');
    expect(view.budget).toBe('$100.00 / 7 days');
    expect(ongoingWorkView({ ...goal, spendRecentUsd: 42 }).spend).toBeNull();
    expect(ongoingWorkView({ ...goal, budgetCents: 10000 }).budget).toBe('$100.00 / window unavailable');
    expect(ongoingWorkView({ ...goal, budgetCents: 10000, budgetWindowSec: null }).budget).toBe('$100.00 / lifetime');
  });
  it('suppresses only represented standing instance ids, independent of title', () => {
    const entries = [
      { ref: 'woe', standing: true, activeGoalId: 'g-current', title: 'Renamed' },
      { ref: 'ordinary', standing: false, activeGoalId: 'g-other', title: 'Work on everything' },
      { ref: 'stub', standing: true, activeGoalId: null },
    ] as GoalPackageRailEntry[];
    expect([...representedOngoingGoalIds(entries)]).toEqual(['g-current']);
  });
});
