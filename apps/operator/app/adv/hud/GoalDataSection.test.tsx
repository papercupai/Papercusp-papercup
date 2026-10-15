// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readTypedPropertyCollection } from '@papercusp/operator-core/lib/typed-properties';
import GoalDataSection from './GoalDataSection';
import type { GoalDetailInput } from './goal-detail-model';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function fixture(kind: 'plans' | 'tea', version = 4, defaultSelected = true): NonNullable<GoalDetailInput['goalData']> {
  const property = kind === 'plans' ? 'worklist' : 'tea_choices';
  const policyName = kind === 'plans' ? 'worklist_policy' : 'tea_policy';
  const ids = kind === 'plans' ? ['plan:alpha/first', 'plan:beta/second'] : ['mint', 'chamomile'];
  const dormant = kind === 'plans' ? 'plan:alpha/dormant' : 'rooibos';
  const schema = { [property]: { datatype: kind === 'plans' ? 'plan-ref-list' : 'list', default: [], editable_by: 'both',
    collection: { source: kind === 'plans' ? 'active-workspace-plans' : 'manual', policy: policyName,
      order: kind === 'plans' ? 'priority' : 'display', selectable: true, defaultSelected } },
  [policyName]: { datatype: 'ordered-selection-policy', editable_by: 'owner', default: { order: [], excluded: [] } } };
  const selection = readTypedPropertyCollection({ propertySchema: schema, property,
    properties: { [property]: { value: ids, version: 2, edited_by: 'agent', provenance: 'agent-edit', edited_at: '2026-10-01T00:00:00Z' },
      [policyName]: { value: { order: [ids[0], dormant], excluded: [dormant] }, version,
        edited_by: 'owner', provenance: 'owner-edit', edited_at: '2026-10-01T00:00:00Z' } },
    ...(kind === 'plans' ? { source: { ok: true as const, items: ids } } : {}) });
  if (!selection.ok || !selection.configured) throw new Error(JSON.stringify(selection));
  return { collections: { [property]: { selection,
    rows: selection.items.map((row, index) => ({ ...row, label: ids[index], state: index ? 'blocked' : 'ready',
      reason: index ? 'Waiting for dependency' : null })) } } };
}

describe('generic declared goal collection controls', () => {
  it.each(['plans', 'tea'] as const)('persists priority and exclusion for %s through the owner CAS door, retaining dormant preferences', async (kind) => {
    const writes = vi.fn(async (_url: string, _options: RequestInit) => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', writes);
    const data = fixture(kind);
    const property = Object.keys(data.collections)[0];
    const rows = data.collections[property].rows;
    const { rerender } = render(<GoalDataSection goalId="arbitrary-goal" data={data} />);
    expect(screen.getByText('Waiting for dependency')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `Move ${rows[1].label} up` }));
    await waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
    const posted = JSON.parse(writes.mock.calls[0][1].body as string);
    expect(writes.mock.calls[0][0]).toBe('/api/admin/goals/set-property');
    expect(posted).toMatchObject({ goalId: 'arbitrary-goal', property: kind === 'plans' ? 'worklist_policy' : 'tea_policy',
      expectedVersion: 4, value: { order: [rows[1].id, rows[0].id, kind === 'plans' ? 'plan:alpha/dormant' : 'rooibos'],
        excluded: [kind === 'plans' ? 'plan:alpha/dormant' : 'rooibos'] } });
    await waitFor(() => expect(screen.getByRole('status', { name: 'Save status' }).textContent).toContain('Waiting for the refreshed list'));
    expect(screen.getByRole('checkbox', { name: `Include ${rows[0].label}` })).toHaveProperty('disabled', true);
    rerender(<GoalDataSection goalId="arbitrary-goal" data={fixture(kind, 5)} />);
    fireEvent.click(screen.getByRole('checkbox', { name: `Include ${rows[0].label}` }));
    await waitFor(() => expect(writes).toHaveBeenCalledTimes(2));
    const exclusion = JSON.parse(writes.mock.calls[1][1].body as string);
    expect(exclusion.expectedVersion).toBe(5);
    expect(exclusion.value.excluded).toContain(rows[0].id);
    expect(exclusion.value.excluded).toContain(kind === 'plans' ? 'plan:alpha/dormant' : 'rooibos');
    expect(exclusion).not.toHaveProperty('provenance');
  });

  it('reselects an initially unchecked non-plan collection using the same policy', async () => {
    const writes = vi.fn(async (_url: string, _options: RequestInit) => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', writes);
    render(<GoalDataSection goalId="tea-goal" data={fixture('tea', 4, false)} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include mint' }));
    await waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
    expect(JSON.parse(writes.mock.calls[0][1].body as string).value.included).toEqual(['mint']);
  });

  it('keeps the authoritative list on a save failure and exposes the refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ error: 'stale', actualVersion: 9 }) })));
    render(<GoalDataSection goalId="tea-goal" data={fixture('tea')} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include mint' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('stale'));
    expect(screen.getByRole('checkbox', { name: 'Include mint' }).getAttribute('aria-checked')).toBe('true');
  });

  it('waits for the write response when canonical readback arrives before acknowledgement', async () => {
    let acknowledge!: () => void;
    const response = new Promise<{ ok: boolean; json: () => Promise<{ ok: boolean; version: number }> }>((resolve) => {
      acknowledge = () => resolve({ ok: true, json: async () => ({ ok: true, version: 5 }) });
    });
    const writes = vi.fn(() => response);
    vi.stubGlobal('fetch', writes);
    const view = render(<GoalDataSection goalId="tea-goal" data={fixture('tea')} />);
    const checkbox = screen.getByRole('checkbox', { name: 'Include mint' });
    fireEvent.click(checkbox);
    await waitFor(() => expect(writes).toHaveBeenCalledOnce());
    view.rerender(<GoalDataSection goalId="tea-goal" data={fixture('tea', 5)} />);
    expect(checkbox).toHaveProperty('disabled', true);
    fireEvent.click(checkbox);
    expect(writes).toHaveBeenCalledOnce();
    acknowledge();
    await waitFor(() => expect(checkbox).toHaveProperty('disabled', false));
    expect(screen.queryByRole('status', { name: 'Save status' })).toBeNull();
  });

  it('renders source failure visibly and never enables an empty-list write', () => {
    const writes = vi.fn();
    vi.stubGlobal('fetch', writes);
    render(<GoalDataSection goalId="any-goal" data={{ collections: { any_property: {
      selection: { ok: false, configured: true, reason: 'source unavailable' }, rows: [] } } }} />);
    expect(screen.getByRole('alert').textContent).toContain('source unavailable');
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(writes).not.toHaveBeenCalled();
  });

  it.each(['plans', 'tea'] as const)('renders the refreshed canonical %s order after save acknowledgement', async (kind) => {
    const writes = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, version: 5 }) }));
    vi.stubGlobal('fetch', writes);
    const data = fixture(kind);
    const property = Object.keys(data.collections)[0];
    const rows = data.collections[property].rows;
    const view = render(<GoalDataSection goalId="arbitrary-goal" data={data} />);
    fireEvent.click(screen.getByRole('button', { name: `Move ${rows[1].label} up` }));
    await waitFor(() => expect(writes).toHaveBeenCalledOnce());
    expect(screen.getAllByRole('listitem')[0].textContent).toContain(rows[0].label);
    expect(screen.getByRole('checkbox', { name: `Include ${rows[0].label}` })).toHaveProperty('disabled', true);
    const confirmed = structuredClone(data);
    const collection = confirmed.collections[property];
    if (!collection.selection.ok || !collection.selection.configured) throw new Error('Invalid fixture');
    const dormant = kind === 'plans' ? 'plan:alpha/dormant' : 'rooibos';
    collection.selection.policyVersion = 5;
    collection.selection.policy.order = [rows[1].id, rows[0].id, dormant];
    collection.selection.items = [collection.selection.items[1], collection.selection.items[0]];
    collection.selection.selected = [rows[1].id, rows[0].id];
    collection.rows = [collection.rows[1], collection.rows[0]];
    view.rerender(<GoalDataSection goalId="arbitrary-goal" data={confirmed} />);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: `Include ${rows[0].label}` })).toHaveProperty('disabled', false));
    expect(screen.getAllByRole('listitem')[0].textContent).toContain(rows[1].label);
  });

});
