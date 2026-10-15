import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import {
  assertGoalPlanClaimSelection,
  lockGoalPlanClaimSelections,
  type GoalPlanClaimSelection,
} from './typed-properties-db';

const ref = 'plan:hive/alpha';
const selection = (overrides: Partial<GoalPlanClaimSelection> = {}): GoalPlanClaimSelection => ({
  goalId: 'collection-goal', selected: [], ordered: [ref], attributed: [],
  appliesToActor: false, policyVersion: 4, ...overrides,
});

const applicabilityCases: Array<[string, Partial<GoalPlanClaimSelection>, { goalId?: string }]> = [
  ['actor context', { appliesToActor: true }, {}],
  ['explicit goal stamp', {}, { goalId: 'collection-goal' }],
  ['persisted plan attribution', { attributed: [ref] }, {}],
];

describe('goal selection at the assignment boundary', () => {
  it.each(applicabilityCases)('refuses excluded work through %s and permits its selected control', (_name, scope, args) => {
    const request = { harness: 'hive', planSlug: 'alpha', ...args };
    expect(() => assertGoalPlanClaimSelection([selection(scope)], request))
      .toThrow('goal_plan_excluded: plan:hive/alpha');
    expect(() => assertGoalPlanClaimSelection([selection({ ...scope, selected: [ref] })], request))
      .not.toThrow();
  });

  it('requires every applicable owner overlay to select the plan', () => {
    const allowed = selection({ appliesToActor: true, selected: [ref] });
    const excluded = selection({ goalId: 'another-goal', attributed: [ref] });
    expect(() => assertGoalPlanClaimSelection([allowed, excluded], { harness: 'hive', planSlug: 'alpha' }))
      .toThrow('another-goal');
  });

  it('keeps equal slugs in different harnesses independent', () => {
    const sameSlugElsewhere = selection({ attributed: ['plan:other-hive/alpha'] });
    expect(() => assertGoalPlanClaimSelection([sameSlugElsewhere], { harness: 'hive', planSlug: 'alpha' }))
      .not.toThrow();
    expect(() => assertGoalPlanClaimSelection([sameSlugElsewhere], { harness: 'other-hive', planSlug: 'alpha' }))
      .toThrow('goal_plan_excluded');
  });

  it('refuses unavailable policy for an applicable goal and preserves unconfigured goals', () => {
    expect(() => assertGoalPlanClaimSelection([selection({ appliesToActor: true, policyVersion: null })],
      { harness: 'hive', planSlug: 'alpha' })).toThrow('policy version unavailable');
    expect(() => assertGoalPlanClaimSelection([], { harness: 'hive', planSlug: 'alpha' })).not.toThrow();
  });

  it('reads fresh policy under the claim lock instead of reusing a pre-deselection snapshot', async () => {
    const schema = {
      worklist: { datatype: 'plan-ref-list', editable_by: 'both', default: [],
        collection: { source: 'active-workspace-plans', policy: 'worklist_policy',
          order: 'priority', selectable: true, defaultSelected: true } },
      worklist_policy: { datatype: 'ordered-selection-policy', editable_by: 'owner',
        default: { order: [], excluded: [] } },
    };
    let excluded: string[] = [];
    let version = 4;
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      expect(values[0]).toBe('fixture-workspace');
      const query = strings.join('?');
      if (query.includes('FROM harness_shared.goals')) {
        expect(query).toContain('FOR SHARE');
        return [{ id: 'collection-goal', property_schema: schema, properties: {
          worklist_policy: { value: { order: [ref], excluded }, version,
            edited_by: 'owner-ui', provenance: 'owner-edit', edited_at: '2026-10-07T00:00:00Z' },
        } }];
      }
      expect(query).toContain('FROM harness_shared.harness_plans');
      return [{ harness_slug: 'hive', plan_slug: 'alpha', goal_id: 'collection-goal',
        status: 'active', op_status: null, archived: false }];
    });
    const handle = sql as unknown as postgres.Sql;
    const request = { harness: 'hive', planSlug: 'alpha', goalId: 'collection-goal' };
    const before = await lockGoalPlanClaimSelections(handle, 'fixture-workspace');
    expect(before[0]).toMatchObject({ selected: [ref], policyVersion: 4 });
    expect(() => assertGoalPlanClaimSelection(before, request)).not.toThrow();
    excluded = [ref];
    version = 5;
    const after = await lockGoalPlanClaimSelections(handle, 'fixture-workspace');
    expect(after[0]).toMatchObject({ selected: [], ordered: [ref], policyVersion: 5 });
    expect(() => assertGoalPlanClaimSelection(after, request)).toThrow('policy version 5');
    expect(before[0].selected).toEqual([ref]);
    expect(sql).toHaveBeenCalledTimes(4);
  });
});
