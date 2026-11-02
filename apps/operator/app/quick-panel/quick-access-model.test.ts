import { describe, expect, it } from 'vitest';
import { quickResults, quickSelection, quickVisibleResults, quickFocusReason, type QuickAgent, type QuickPlan, type QuickReport } from './quick-access-model';

const plan: QuickPlan = { slug: 'launch', harness: 'alpha', title: 'Launch', status: 'active' };
export const agent: QuickAgent = {
  ownerId: 'su-exact', label: 'Maya', intent: 'Building the launcher', agent: 'codex',
  currentPlanSlug: 'launch', sessionState: 'live', advSessionId: 42, windowId: 'exact-window',
  pid: 7, stale: false, revoked: false, isLocal: true,
  claims: [{ harnessSlug: 'alpha', planSlug: 'launch', active: true }],
};
const report = { report_id: 'rpt-exact', title: 'Launch review', summary: 'Keyboard review',
  kind: 'review', published_at: '2026-10-26T10:00:00Z', subject: { kind: 'plan', ref: 'launch' } } as QuickReport;

describe('Quick Access discovery', () => {
  it('keeps identically named plans and agents distinct by canonical identity', () => {
    const rows = quickResults([plan, { ...plan, harness: 'beta' }], [agent, { ...agent, ownerId: 'su-other' }], [report], '', 'all');
    expect(new Set(rows.map(r => r.key)).size).toBe(5);
    const selected = quickSelection(rows, rows[3].key);
    expect(selected?.kind === 'agents' && selected.agent.ownerId).toBe('su-other');
  });
  it('searches across types and honors scope without matching unrelated results', () => {
    expect(quickResults([plan], [agent], [report], 'maya', 'plans')).toHaveLength(1);
    expect(quickResults([plan], [agent], [report], 'keyboard REVIEW', 'all').map(r => r.kind)).toEqual(['reports']);
    expect(quickResults([plan], [agent], [report], 'missing', 'all')).toEqual([]);
  });
  it('associates a person only with the harness-qualified plan in their active claims', () => {
    const rows = quickResults([plan, { ...plan, harness: 'beta' }], [agent], [], 'maya', 'plans');
    expect(rows.map(row => row.kind === 'plans' && row.plan.harness)).toEqual(['alpha']);
  });
  it('does not infer membership from an unqualified presence slug or an inactive claim', () => {
    const people = [
      { ...agent, claims: undefined },
      { ...agent, ownerId: 'su-inactive', claims: [{ harnessSlug: 'alpha', planSlug: 'launch', active: false }] },
    ];
    expect(quickResults([plan], people, [], 'maya', 'plans')).toEqual([]);
    expect(quickResults([plan], people, [], 'maya', 'agents')).toHaveLength(2);
  });
  it('drops stale selection when a query or live update removes the target', () => {
    const rows = quickResults([plan], [agent], [], '', 'all');
    expect(quickSelection(rows.slice(0, 1), rows[1].key)?.kind).toBe('plans');
    expect(quickSelection([], rows[1].key)).toBeNull();
  });
  it('keeps people and reports reachable when plans exceed the visible result budget', () => {
    const catalog = Array.from({ length: 100 }, (_, i) => ({ ...plan, slug: `plan-${i}` }));
    const all = quickResults(catalog, [agent], [report], '', 'all');
    const visible = quickVisibleResults(all, 'all');
    expect(visible.filter(r => r.kind === 'plans')).toHaveLength(26);
    expect(visible.filter(r => r.kind === 'agents')).toHaveLength(1);
    expect(visible.filter(r => r.kind === 'reports')).toHaveLength(1);
    expect(quickSelection(visible, all[90].key)?.key).toBe(visible[0].key);
    expect(quickVisibleResults(quickResults(catalog, [], [], '', 'plans'), 'plans')).toHaveLength(80);
  });
});

describe('Quick Access window availability', () => {
  it.each([
    [{ sessionState: 'ended' }, 'no longer live'],
    [{ stale: true }, 'no longer live'],
    [{ revoked: true }, 'no longer live'],
    [{ isLocal: false }, 'another machine'],
    [{ windowId: null, advSessionId: null }, 'No desktop window'],
  ])('refuses unsafe or unavailable targets %j', (change, reason) => {
    expect(quickFocusReason({ ...agent, ...change })).toContain(reason);
  });
  it('permits launch-record resolution without guessing from a shared process pid', () => {
    expect(quickFocusReason({ ...agent, windowId: null })).toBeNull();
    expect(quickFocusReason({ ...agent, windowId: null, advSessionId: null, pid: 7 })).not.toBeNull();
  });
});
