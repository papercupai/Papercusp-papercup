import type { GoalDetailInput } from './goal-detail-model';
import type { OrderedSelectionPolicy } from '@papercusp/operator-core/lib/typed-properties';

export type WorklistCollection = NonNullable<GoalDetailInput['goalData']>['collections'][string];
export type WorklistRow = WorklistCollection['rows'][number];
export type WorklistDraft = { version: number; policy: OrderedSelectionPolicy };

export function beginWorklistDraft(collection: WorklistCollection): WorklistDraft | null {
  const s = collection.selection;
  if (!s.ok || !s.configured) return null;
  const visible = collection.rows.map((r) => r.id);
  return { version: s.policyVersion, policy: { ...s.policy,
    order: [...visible, ...s.policy.order.filter((id) => !visible.includes(id))],
    excluded: [...s.policy.excluded], ...(s.policy.included ? { included: [...s.policy.included] } : {}) } };
}

export function draftRows(collection: WorklistCollection, draft: WorklistDraft | null) {
  if (!draft) return collection.rows;
  const s = collection.selection;
  if (!s.ok || !s.configured) return collection.rows;
  const ordered = [...draft.policy.order, ...collection.rows.map((r) => r.id)
    .filter((id) => !draft.policy.order.includes(id))];
  return ordered.flatMap((id) => {
    const row = collection.rows.find((r) => r.id === id);
    if (!row) return [];
    const selected = !draft.policy.excluded.includes(id) &&
      (s.collection.defaultSelected || !!draft.policy.included?.includes(id));
    return [{ ...row, selected }];
  });
}

export function moveDraft(collection: WorklistCollection, current: WorklistDraft | null, id: string, offset: number) {
  const draft = current ?? beginWorklistDraft(collection);
  if (!draft) return current;
  const included = draftRows(collection, draft).filter((r) => r.selected).map((r) => r.id);
  const index = included.indexOf(id), other = included[index + offset];
  if (index < 0 || !other) return current;
  const order = [...draft.policy.order], a = order.indexOf(id), b = order.indexOf(other);
  [order[a], order[b]] = [order[b], order[a]];
  return { ...draft, policy: { ...draft.policy, order } };
}

export function toggleDraft(collection: WorklistCollection, current: WorklistDraft | null, id: string) {
  const draft = current ?? beginWorklistDraft(collection), s = collection.selection;
  if (!draft || !s.ok || !s.configured) return current;
  const on = !draftRows(collection, draft).find((r) => r.id === id)?.selected;
  return { ...draft, policy: { ...draft.policy,
    excluded: on ? draft.policy.excluded.filter((x) => x !== id) : [...new Set([...draft.policy.excluded, id])],
    ...(!s.collection.defaultSelected || draft.policy.included ? {
      included: on ? [...new Set([...(draft.policy.included ?? []), id])]
        : (draft.policy.included ?? []).filter((x) => x !== id),
    } : {}) } };
}

export function worklistChanges(collection: WorklistCollection, draft: WorklistDraft | null) {
  const before = collection.rows.filter((r) => r.selected).map((r) => r.id);
  const afterRows = draftRows(collection, draft), after = afterRows.filter((r) => r.selected).map((r) => r.id);
  return afterRows.flatMap((r) => {
    const old = collection.rows.find((x) => x.id === r.id)!;
    if (old.selected !== r.selected) return [{ id: r.id, label: r.selected ? 'Adding' : 'Removing' }];
    if (r.selected && before.indexOf(r.id) !== after.indexOf(r.id)) return [{ id: r.id, label: `Priority ${before.indexOf(r.id) + 1} → ${after.indexOf(r.id) + 1}` }];
    return [];
  });
}

export function isWorkOnEverything(data: GoalDetailInput | null | undefined) {
  if (data?.goal?.goalPackage?.ref === 'work-on-everything') return true;
  // Legacy goals predate package installs. Their existing typed worklist is
  // the same contract this console edits; do not manufacture package metadata
  // or infer identity from a title. An explicit different package still wins.
  if (!data?.goal || data.goal.goalPackage) return false;
  const declaration = data.goalData?.propertySchema?.worklist;
  return declaration?.datatype === 'plan-ref-list' &&
    declaration.collection?.source === 'active-workspace-plans' &&
    declaration.collection.policy === 'worklist_policy' && declaration.collection.selectable;
}
