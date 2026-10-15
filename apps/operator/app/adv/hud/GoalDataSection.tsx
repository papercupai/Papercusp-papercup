'use client';

import { useEffect, useRef, useState } from 'react';
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Checkbox } from '@/app/harness/Checkbox';
import { PANEL_TOOLBAR_BUTTON_STYLE } from '@/app/_components/chat/PanelToggleButton';
import type { OrderedSelectionPolicy } from '@papercusp/operator-core/lib/typed-properties';
import type { GoalDetailInput } from './goal-detail-model';

type Collection = NonNullable<GoalDetailInput['goalData']>['collections'][string];
type Row = Collection['rows'][number];

function CollectionRow({ row, index, count, disabled, selectable, move, select }: {
  row: Row; index: number; count: number; disabled: boolean; selectable: boolean;
  move: (from: number, to: number) => void; select: (id: string, selected: boolean) => void;
}) {
  const sortable = useSortable({ id: row.id, disabled });
  const buttonStyle = { ...PANEL_TOOLBAR_BUTTON_STYLE, flexShrink: 0 };
  return <li ref={sortable.setNodeRef} style={{ display: 'flex', alignItems: 'center', gap: 8,
    flexWrap: 'wrap', padding: '8px 0', borderBottom: '1px solid var(--border)',
    transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}>
    <button type="button" style={buttonStyle} disabled={disabled} aria-label={`Drag ${row.label}`}
      {...sortable.attributes} {...sortable.listeners}>↕</button>
    {selectable ? <Checkbox checked={row.selected} disabled={disabled}
      ariaLabel={`Include ${row.label}`} onChange={(checked) => select(row.id, checked)} /> : null}
    <span style={{ flex: '1 1 160px', minWidth: 0, overflowWrap: 'anywhere' }}>
      {row.label}{!row.selected ? ' · Excluded' : ''}
      {row.reason ? <small style={{ display: 'block', color: 'var(--fg-mute)' }}>{row.reason}</small> : null}
    </span>
    <button type="button" style={buttonStyle} aria-label={`Move ${row.label} up`}
      disabled={disabled || index === 0} onClick={() => move(index, index - 1)}>↑</button>
    <button type="button" style={buttonStyle} aria-label={`Move ${row.label} down`}
      disabled={disabled || index === count - 1} onClick={() => move(index, index + 1)}>↓</button>
  </li>;
}

function CollectionEditor({ goalId, property, data }: { goalId: string; property: string; data: Collection }) {
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [awaitingVersion, setAwaitingVersion] = useState<number | null>(null);
  const busy = useRef(false);
  const selection = data.selection;
  const version = selection.ok && selection.configured ? selection.policyVersion : null;
  // A successful write is acknowledged by the canonical sync snapshot. Until
  // then, retain the old rows and disable another write with the stale revision.
  useEffect(() => { if (version !== awaitingVersion) setAwaitingVersion(null); }, [version, awaitingVersion]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  if (!selection.ok) return <div role="alert">{property}: {selection.reason}</div>;
  if (!selection.configured) return null;
  const configured = selection;
  const disabled = saving || awaitingVersion !== null;

  async function save(policy: OrderedSelectionPolicy) {
    if (busy.current || disabled || !selection.ok || !selection.configured) return;
    busy.current = true;
    setSaving(true);
    setProblem(null);
    try {
      const response = await fetch('/api/admin/goals/set-property', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goalId,
          property: selection.collection.policy, value: policy, expectedVersion: selection.policyVersion }) });
      const result = await response.json();
      if (!response.ok || result.ok === false || result.error) {
        throw new Error(result.message ?? (typeof result.error === 'string' ? result.error : result.error?.message)
          ?? result.detail ?? result.code ?? `HTTP ${response.status}`);
      }
      setAwaitingVersion(selection.policyVersion);
    } catch (error) { setProblem(error instanceof Error ? error.message : String(error)); }
    finally { busy.current = false; setSaving(false); }
  }

  function move(from: number, to: number) {
    if (from < 0 || to < 0 || from === to || from >= data.rows.length || to >= data.rows.length) return;
    const ids = data.rows.map((row) => row.id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id);
    // Never discard preferences for ids temporarily absent from the source.
    const dormant = configured.policy.order.filter((id) => !ids.includes(id));
    void save({ ...configured.policy, order: [...ids, ...dormant] });
  }
  function select(id: string, checked: boolean) {
    const policy = configured.policy;
    void save({ ...policy,
      excluded: checked ? policy.excluded.filter((item) => item !== id) : [...new Set([...policy.excluded, id])],
      ...(!configured.collection.defaultSelected || policy.included ? {
        included: checked ? [...new Set([...(policy.included ?? []), id])] : (policy.included ?? []).filter((item) => item !== id),
      } : {}) });
  }

  return <div style={{ marginBottom: 16 }} aria-busy={saving}>
    <h4>{property.replace(/[_-]/g, ' ')}</h4>
    <p className="hud-goal__note">{selection.collection.order === 'priority' ? 'Order sets priority.' : 'Order sets display order.'}
      {selection.collection.selectable ? ' Uncheck an item to exclude it from future work.' : ''}</p>
    {problem ? <p role="alert">Could not save: {problem}. Refresh before retrying a changed list.</p> : null}
    {saving || awaitingVersion !== null ? <p role="status" aria-label="Save status">{saving ? 'Saving…' : 'Saved. Waiting for the refreshed list…'}</p> : null}
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
      if (over && active.id !== over.id) move(data.rows.findIndex((row) => row.id === active.id), data.rows.findIndex((row) => row.id === over.id));
    }}>
      <SortableContext items={data.rows.map((row) => row.id)} strategy={verticalListSortingStrategy}>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {data.rows.map((row, index) => <CollectionRow key={row.id} row={row} index={index} count={data.rows.length}
            disabled={disabled} selectable={selection.collection.selectable} move={move} select={select} />)}
        </ul>
      </SortableContext>
    </DndContext>
    {data.rows.length === 0 ? <p>No items are available.</p> : null}
  </div>;
}

export default function GoalDataSection({ goalId, data }: { goalId: string; data?: GoalDetailInput['goalData'] }) {
  if (!data || (!data.error && Object.keys(data.collections).length === 0)) return null;
  return <section className="hud-goal__section" data-testid="goal-data">
    <h3 className="pc-zone-title">Goal data</h3>
    {data.error ? <p role="alert">{data.error}</p> : Object.entries(data.collections).map(([property, collection]) =>
      <CollectionEditor key={`${goalId}/${property}`} goalId={goalId} property={property} data={collection} />)}
  </section>;
}
