/** Pure guards for the immutable plan-revision snapshot repair seam. */
import { describe, expect, it } from 'vitest';
import {
  planRevisionRepairPlanMatches,
  planRevisionRepairRevisionIdsMatch,
  type PlanRevisionRepairExpectedPlan,
  type PlanRevisionRepairPlan,
} from '../revisions-repair';

const expected: PlanRevisionRepairExpectedPlan = {
  version: 2,
  contentHash: 'body-hash',
  content: '# current body',
  owner: 'first-party-bundle',
  template: 'rubric',
  templateSlug: null,
  archived: false,
};

const actual: PlanRevisionRepairPlan = {
  workspaceId: 'workspace-a',
  harnessSlug: 'papercusp',
  planSlug: 'spec-test-adequacy',
  ...expected,
  templateData: { characteristic: 'spec-test-adequacy' },
};

describe('plan revision snapshot repair guards', () => {
  it('matches the complete current plan baseline', () => {
    expect(planRevisionRepairPlanMatches(expected, actual)).toBe(true);
    expect(planRevisionRepairPlanMatches(expected, { ...actual, version: 3 })).toBe(false);
    expect(planRevisionRepairPlanMatches(expected, { ...actual, content: '# changed body' })).toBe(false);
    expect(planRevisionRepairPlanMatches(expected, { ...actual, owner: 'human-editor' })).toBe(false);
    expect(planRevisionRepairPlanMatches(expected, { ...actual, templateSlug: 'spec-test-adequacy@run-1' })).toBe(false);
    expect(planRevisionRepairPlanMatches(expected, { ...actual, archived: true })).toBe(false);
  });

  it('matches structured template data when a backfill depends on an exact source snapshot', () => {
    const expectedWithData = { ...expected, templateData: { characteristic: 'spec-test-adequacy' } };
    expect(planRevisionRepairPlanMatches(expectedWithData, actual)).toBe(true);
    expect(planRevisionRepairPlanMatches(expectedWithData, {
      ...actual,
      templateData: { characteristic: 'different' },
    })).toBe(false);
  });

  it('requires an exact, unique revision-id set before applying a chain repair', () => {
    expect(planRevisionRepairRevisionIdsMatch([11, 12], [{ id: 11 }, { id: 12 }])).toBe(true);
    expect(planRevisionRepairRevisionIdsMatch([11, 12], [{ id: 12 }, { id: 11 }])).toBe(true);
    expect(planRevisionRepairRevisionIdsMatch([11, 12], [{ id: 11 }])).toBe(false);
    expect(planRevisionRepairRevisionIdsMatch([11, 12], [{ id: 11 }, { id: 13 }])).toBe(false);
    expect(planRevisionRepairRevisionIdsMatch([11, 11], [{ id: 11 }, { id: 11 }])).toBe(false);
  });
});
