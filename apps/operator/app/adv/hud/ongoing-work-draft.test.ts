import { describe, expect, it } from 'vitest';
import { beginWorklistDraft, draftRows, isWorkOnEverything, moveDraft, toggleDraft, worklistChanges,
  type WorklistCollection } from './ongoing-work-draft';

export function worklistFixture(): WorklistCollection {
  return { selection: { ok: true, configured: true, policyVersion: 7,
    collection: { source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority',
      selectable: true, defaultSelected: true },
    policy: { order: ['plan:h/a', 'plan:h/b', 'plan:h/out', 'plan:h/dormant'], excluded: ['plan:h/out', 'plan:h/absent'] },
    items: [{ id: 'plan:h/a', selected: true }, { id: 'plan:h/b', selected: true }, { id: 'plan:h/out', selected: false }],
    selected: ['plan:h/a', 'plan:h/b'] },
    rows: [
      { id: 'plan:h/a', selected: true, label: 'Cloud setup', harness: 'h', planSlug: 'a', state: 'active', reason: null, nextStep: 'Verify setup' },
      { id: 'plan:h/b', selected: true, label: 'Search reliability', harness: 'h', planSlug: 'b', state: 'active', reason: null },
      { id: 'plan:h/out', selected: false, label: 'Mobile', harness: 'h', planSlug: 'out', state: 'active', reason: null },
    ] };
}

describe('ongoing work staged policy', () => {
  it('moves only selected plans and preserves preferences for absent source rows', () => {
    const c = worklistFixture(), original = structuredClone(c);
    const d = moveDraft(c, null, 'plan:h/b', -1)!;
    expect(d.policy.order).toEqual(['plan:h/b', 'plan:h/a', 'plan:h/out', 'plan:h/dormant']);
    expect(d.policy.excluded).toContain('plan:h/absent');
    expect(d.version).toBe(7);
    expect(c).toEqual(original);
    expect(worklistChanges(c, d)).toHaveLength(2);
    expect(moveDraft(c, d, 'plan:h/b', -1)).toBe(d);
    expect(worklistChanges(c, moveDraft(c, d, 'plan:h/b', 1))).toEqual([]);
  });
  it('excludes and reselects without destroying the plan or its position', () => {
    const c = worklistFixture(), d = toggleDraft(c, null, 'plan:h/a')!;
    expect(draftRows(c, d)[0].selected).toBe(false);
    expect(worklistChanges(c, d)).toContainEqual({ id: 'plan:h/a', label: 'Removing' });
    expect(worklistChanges(c, toggleDraft(c, d, 'plan:h/a'))).toEqual([]);
  });
  it('new source plans remain available while an existing edit stays in a draft', () => {
    const c = worklistFixture(), d = beginWorklistDraft(c);
    c.rows.push({ id: 'plan:h/new', selected: true, label: 'New plan', state: 'active', reason: null });
    expect(draftRows(c, d).at(-1)).toMatchObject({ id: 'plan:h/new', selected: true });
  });
  it('supports an initially unchecked collection', () => {
    const c = worklistFixture();
    if (!c.selection.ok || !c.selection.configured) throw new Error('fixture');
    c.selection.collection.defaultSelected = false;
    c.selection.policy.included = ['plan:h/a', 'plan:h/b'];
    const d = toggleDraft(c, null, 'plan:h/out')!;
    expect(draftRows(c, d).at(-1)?.selected).toBe(true);
    expect(d.policy.included).toContain('plan:h/out');
    expect(d.policy.excluded).not.toContain('plan:h/out');
  });
  it('routes by package identity, never a title match or standing flag alone', () => {
    expect(isWorkOnEverything({ goal: { id: 'other', title: 'Work on everything', status: 'active', standing: true } })).toBe(false);
    expect(isWorkOnEverything({ goal: { id: 'real', title: 'Renamed', status: 'active', goalPackage: { ref: 'work-on-everything' } } })).toBe(true);
  });
  it('recognizes an unpackaged legacy worklist from its declaration even when the collection read failed', () => {
    const data = { goal: { id: 'legacy', title: 'Renamed', status: 'paused', goalPackage: null },
      goalData: { propertySchema: { worklist: { datatype: 'plan-ref-list', editable_by: 'both' as const,
        collection: { source: 'active-workspace-plans' as const, policy: 'worklist_policy',
          order: 'priority' as const, selectable: true, defaultSelected: false } } },
        collections: {} } };
    expect(isWorkOnEverything(data)).toBe(true);
    expect(isWorkOnEverything({ ...data, goal: { ...data.goal, goalPackage: { ref: 'other-package' } } })).toBe(false);
    expect(isWorkOnEverything({ ...data, goalData: { ...data.goalData, propertySchema: {
      worklist: { ...data.goalData.propertySchema.worklist, collection: {
        ...data.goalData.propertySchema.worklist.collection, source: 'manual' } } } } })).toBe(false);
  });
});
