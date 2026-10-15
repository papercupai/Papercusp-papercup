// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
import type { GoalDetailInput } from './goal-detail-model';

vi.mock('nuqs', async () => {
  const React = await import('react');
  return { ...nuqsParsers, useQueryState: (_key: string, p?: { defaultValue?: unknown }) =>
    React.useState<unknown>(p?.defaultValue ?? null) };
});
vi.mock('@/app/harness/Modal', () => ({
  Modal: ({ open, children, title }: { open: boolean; children: React.ReactNode; title: string }) =>
    open ? <div role="dialog" aria-label={title}>{children}</div> : null,
}));
vi.mock('@/app/harness/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('./GoalStatusControl', () => ({ default: () => <span>Goal control</span> }));
vi.mock('./GoalSettingsSection', () => ({ default: () => <span>Goal settings</span> }));
import WorkOnEverythingPanel from './WorkOnEverythingPanel';

const counts = (todo: number, wip: number, done: number, extra: Partial<{ blocked: number; needsHuman: number }> = {}) =>
  ({ todo, wip, done, blocked: extra.blocked ?? 0, needsHuman: extra.needsHuman ?? 0 });

function fixture(): GoalDetailInput {
  return { goal: { id: 'g1', title: 'Work on everything', status: 'active', goalPackage: { ref: 'work-on-everything' } },
    effectiveStatus: 'active', holderLiveness: 'held', goalData: { collections: { worklist: {
      selection: { ok: true, configured: true, policyVersion: 7,
        collection: { source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority', selectable: true, defaultSelected: false },
        policy: { order: ['plan:h/a', 'plan:h/b'], excluded: [], included: ['plan:h/a', 'plan:h/b'] },
        items: [{ id: 'plan:h/a', selected: true }, { id: 'plan:h/b', selected: true }, { id: 'plan:h/out', selected: false },
          { id: 'plan:h/empty', selected: false }],
        selected: ['plan:h/a', 'plan:h/b'] },
      rows: [{ id: 'plan:h/a', selected: true, label: 'Cloud setup', harness: 'h', planSlug: 'a', state: 'working', reason: null,
          counts: counts(2, 1, 3), nextStep: 'Verify the deployment configuration' },
        { id: 'plan:h/b', selected: true, label: 'Search reliability', harness: 'h', planSlug: 'b', state: 'unplaced', reason: null,
          counts: counts(0, 0, 1, { needsHuman: 2 }) },
        { id: 'plan:h/out', selected: false, label: 'Mobile', harness: 'h', planSlug: 'out', state: 'blocked',
          reason: 'Not in the worklist: the owner has not picked this plan for this goal.', counts: counts(4, 0, 6) },
        { id: 'plan:h/empty', selected: false, label: 'Placeholder', harness: 'h', planSlug: 'empty', state: 'blocked',
          reason: null, counts: counts(0, 0, 0) }] } } },
    completedByDay: { windowDays: 3, days: [{ day: '2026-10-07', done: 4 }] },
    agents: [{ ownerId: 'holder', live: true }] };
}
const props = () => ({ nowMs: Date.parse('2026-10-08T12:00:00Z'), onClose: vi.fn(), refresh: vi.fn() });
const rowLabels = () => screen.getAllByTestId('ongoing-worklist-row').map((r) => within(r).getAllByRole('cell')[1].textContent);
const openEditor = () => fireEvent.click(screen.getByRole('button', { name: /^Edit priorities/ }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Work on everything: progress table (WI-10007603)', () => {
  it('surfaces the three duties while absent evidence stays explicitly unmeasured', () => {
    render(<WorkOnEverythingPanel data={fixture()} {...props()} />);
    const quality = screen.getByRole('region', { name: 'Rubric stewardship' });
    expect(within(quality).getByText('Maintain rubric coverage')).toBeTruthy();
    expect(within(quality).getByText('Improve rubric quality')).toBeTruthy();
    expect(within(quality).getByText('Grade, improve and re-grade')).toBeTruthy();
    expect(within(quality).getAllByText('Not measured')).toHaveLength(3);
    expect(within(quality).queryByText('Improvement verified')).toBeNull();
  });

  it('shows comparable-cycle state, canonical references and bounded evidence without claiming completion', () => {
    const data = fixture();
    data.rubricStewardship = { measuredAt: '2026-10-09T12:00:00Z', windowStart: '2026-10-02T12:00:00Z',
      complete: false, rubricRef: 'work-on-everything-stewardship-health', rubricRevision: 46,
      criteria: { 'rubric-coverage-stewardship': null, 'rubric-quality-stewardship': null,
        'grading-correction-closure': { rating: 'partial', evidence: 'Re-grade still needed', scorecardRef: 'EI-4' } },
      cycles: [{ target: 'Search', rubricRef: 'quality', rubricRevision: 2, baselineRef: 'EI-1', scorecardRef: 'EI-2',
        repairRefs: ['WI-12'], status: 'incomparable', reason: 'Target or rubric revision changed; record a fresh baseline.' }], error: null };
    const open = vi.fn();
    render(<WorkOnEverythingPanel data={data} {...props()} onOpenWorkItem={open} />);
    expect(screen.getByRole('table', { name: 'Grading cycles' })).toBeTruthy();
    expect(screen.getByText('Fresh baseline needed')).toBeTruthy();
    expect(screen.getByText(/limited recent page/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Baseline' }));
    expect(open).toHaveBeenLastCalledWith('EI-1');
    fireEvent.click(screen.getByRole('button', { name: 'WI-12' }));
    expect(open).toHaveBeenLastCalledWith('WI-12');
    expect(screen.queryByText('Improvement verified')).toBeNull();
  });

  it.each([
    ['baseline', 'Baseline recorded'],
    ['needs-repair', 'Repairs needed'],
    ['needs-regrade', 'Re-grade needed'],
    ['unverified', 'Needs verification'],
    ['incomparable', 'Fresh baseline needed'],
    ['verified', 'Improvement verified'],
  ] as const)('renders supplied cycle status %s and preserves its evidence targets', (status, label) => {
    const data = fixture();
    data.rubricStewardship = {
      measuredAt: '2026-10-09T12:00:00Z', windowStart: '2026-10-02T12:00:00Z',
      complete: true, rubricRef: 'work-on-everything-stewardship-health', rubricRevision: 47,
      criteria: { 'rubric-coverage-stewardship': null, 'rubric-quality-stewardship': null,
        'grading-correction-closure': null },
      cycles: [{ target: 'Measured target', rubricRef: 'target-quality', rubricRevision: 8,
        baselineRef: 'EI-baseline', scorecardRef: 'EI-regrade', repairRefs: ['WI-repair'],
        status, reason: 'Canonical cycle reason' }], error: null,
    };
    const open = vi.fn();
    render(<WorkOnEverythingPanel data={data} {...props()} onOpenWorkItem={open} />);
    const quality = screen.getByRole('region', { name: 'Rubric stewardship' });
    const table = within(quality).getByRole('table', { name: 'Grading cycles' });
    expect(within(table).getByText(label).getAttribute('data-state')).toBe(status);
    expect(within(table).getByText('Canonical cycle reason')).toBeTruthy();
    expect(within(table).getByText('target-quality · revision 8')).toBeTruthy();
    expect(within(quality).getByRole('link', { name: /Browse rubrics/ }).textContent).toContain('revision 47');
    expect(within(quality).queryByText(/limited recent page/)).toBeNull();
    for (const [button, ref] of [['Baseline', 'EI-baseline'], ['Scorecard', 'EI-regrade'],
      ['WI-repair', 'WI-repair']]) {
      fireEvent.click(within(table).getByRole('button', { name: button }));
      expect(open).toHaveBeenLastCalledWith(ref);
    }
    if (status !== 'verified') expect(within(table).queryByText('Improvement verified')).toBeNull();
  });

  it('renders measured criterion ratings and opens canonical scorecard references', () => {
    const data = fixture();
    data.rubricStewardship = {
      measuredAt: '2026-10-09T12:00:00Z', windowStart: '2026-10-02T12:00:00Z',
      complete: false, rubricRef: 'work-on-everything-stewardship-health', rubricRevision: 47,
      criteria: {
        'rubric-coverage-stewardship': { rating: 'pass', evidence: 'Coverage measured', scorecardRef: 'EI-coverage' },
        'rubric-quality-stewardship': { rating: 'unknown', evidence: 'Quality not exercised', scorecardRef: 'EI-quality' },
        'grading-correction-closure': { rating: 'partial', evidence: 'Repair still open', scorecardRef: 'EI-correction' },
      }, cycles: [], error: null,
    };
    const open = vi.fn();
    render(<WorkOnEverythingPanel data={data} {...props()} onOpenWorkItem={open} />);
    const quality = screen.getByRole('region', { name: 'Rubric stewardship' });
    expect(within(quality).getByText('pass')).toBeTruthy();
    expect(within(quality).getByText('unknown')).toBeTruthy();
    expect(within(quality).getByText('partial')).toBeTruthy();
    expect(within(quality).getByText(/limited recent page/)).toBeTruthy();
    const evidenceButtons = within(quality).getAllByRole('button', { name: 'View evidence' });
    const refs = ['EI-coverage', 'EI-quality', 'EI-correction'];
    expect(evidenceButtons).toHaveLength(refs.length);
    for (const [index, ref] of refs.entries()) {
      fireEvent.click(evidenceButtons[index]);
      expect(open).toHaveBeenLastCalledWith(ref);
    }
    expect(within(quality).queryByText('Improvement verified')).toBeNull();
  });

  it('keeps a canonical evidence read error visible without promoting missing measurements', () => {
    const data = fixture();
    data.rubricStewardship = {
      measuredAt: '2026-10-09T12:00:00Z', windowStart: '2026-10-02T12:00:00Z',
      complete: false, rubricRef: 'work-on-everything-stewardship-health', rubricRevision: null,
      criteria: { 'rubric-coverage-stewardship': null, 'rubric-quality-stewardship': null,
        'grading-correction-closure': null }, cycles: [], error: 'Canonical evidence query unavailable',
    };
    render(<WorkOnEverythingPanel data={data} {...props()} />);
    const quality = screen.getByRole('region', { name: 'Rubric stewardship' });
    expect(within(quality).getByRole('alert').textContent).toBe('Canonical evidence query unavailable');
    expect(within(quality).getAllByText('Not measured')).toHaveLength(3);
    expect(within(quality).queryByText('Improvement verified')).toBeNull();
  });

  it('shows every plan with progress, keeps unpicked plans visible, and hides empty plans by default', async () => {
    render(<WorkOnEverythingPanel data={fixture()} {...props()} />);
    openEditor();
    expect(rowLabels().map((t) => t?.split('h ·')[0])).toEqual(['Cloud setup', 'Search reliability', 'Mobile']);
    expect(screen.getAllByTestId('ongoing-worklist-row').map(row => row.getAttribute('data-worklist-id')))
      .toEqual(['plan:h/a', 'plan:h/b', 'plan:h/out']);
    const mobile = screen.getAllByTestId('ongoing-worklist-row')[2];
    expect(within(mobile).getByRole('button', { name: 'Add Mobile' })).toBeTruthy();
    expect(within(mobile).getByRole('img', { name: '6 of 10 items done' })).toBeTruthy();
    expect(within(mobile).getByText(/add it to the worklist/)).toBeTruthy();
    expect(screen.getByText(/1 with no items hidden/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('checkbox', { name: /Show plans with no items/ }));
    expect(screen.getAllByTestId('ongoing-worklist-row')).toHaveLength(4);
    expect(screen.getByRole('img', { name: '4 work items finished in the last 3 days' })).toBeTruthy();
  });

  it('totals filter the table, and scope narrows to the worklist or the rest', () => {
    render(<WorkOnEverythingPanel data={fixture()} {...props()} />);
    openEditor();
    const totals = screen.getByRole('group', { name: 'Totals' });
    expect(within(totals).getAllByRole('button')[0].textContent).toContain('10 of 19 items done');
    fireEvent.click(within(totals).getByRole('button', { name: /Waiting on you/ }));
    expect(rowLabels()).toHaveLength(1);
    expect(rowLabels()[0]).toContain('Search reliability');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    fireEvent.click(screen.getByRole('button', { name: /Not in worklist · 1/ }));
    expect(rowLabels()).toHaveLength(1);
    expect(rowLabels()[0]).toContain('Mobile');
  });

  it('adds a plan through draft, review and apply, then waits for the confirmed version', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, version: 8 }) });
    vi.stubGlobal('fetch', fetch);
    const data = fixture(), p = props();
    const view = render(<WorkOnEverythingPanel data={data} {...p} />);
    openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Add Mobile' }));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Pending changes' })).toBeTruthy();
    fireEvent.click(screen.getByText('Review & apply'));
    fireEvent.change(screen.getByRole('textbox', { name: /Why/ }), { target: { value: 'Ship mobile' } });
    fireEvent.click(screen.getByText('Apply changes'));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ goalId: 'g1', property: 'worklist_policy', expectedVersion: 7, reason: 'Ship mobile' });
    expect(body.value.included).toEqual(['plan:h/a', 'plan:h/b', 'plan:h/out']);
    await waitFor(() => expect(p.refresh).toHaveBeenCalledOnce());
    const updated = structuredClone(data);
    const c = updated.goalData!.collections.worklist;
    if (!c.selection.ok || !c.selection.configured) throw new Error('fixture');
    c.selection.policyVersion = 8; c.selection.policy = body.value; c.rows[2].selected = true;
    view.rerender(<WorkOnEverythingPanel data={updated} {...p} />);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Pending changes' })).toBeNull());
    expect(screen.getByText(/Worklist applied/)).toBeTruthy();
  });

  it('discard never writes; a stale snapshot keeps the draft and blocks apply; a failed save keeps the reason', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'stale', message: 'Another owner edited this worklist' }) });
    vi.stubGlobal('fetch', fetch);
    const data = fixture(), p = props();
    const view = render(<WorkOnEverythingPanel data={data} {...p} />);
    openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cloud setup' }));
    // Removing a plan is a draft until review: no write yet.
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Pending changes' })).toBeTruthy();
    fireEvent.click(screen.getByText('Discard'));
    expect(screen.queryByRole('region', { name: 'Pending changes' })).toBeNull();
    // Discard drops the draft without ever writing.
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cloud setup' }));
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Review & apply'));
    fireEvent.click(screen.getByText('Apply changes'));
    await waitFor(() => expect(screen.getAllByRole('alert')[0].textContent).toContain('Another owner'));
    expect(screen.getByRole('region', { name: 'Pending changes' })).toBeTruthy();
    const changed = structuredClone(data);
    const c = changed.goalData!.collections.worklist;
    if (!c.selection.ok || !c.selection.configured) throw new Error('fixture');
    c.selection.policyVersion = 9;
    view.rerender(<WorkOnEverythingPanel data={changed} {...p} />);
    expect(screen.getAllByRole('alert').some((a) => a.textContent?.includes('changed while you were editing'))).toBe(true);
    expect((screen.getByText('Review & apply') as HTMLButtonElement).disabled).toBe(true);
  });

  it('reorders in worklist order and opens a plan by its title', async () => {
    const open = vi.fn();
    render(<WorkOnEverythingPanel data={fixture()} {...props()} onOpenPlan={open} />);
    openEditor();
    expect(screen.queryByRole('button', { name: 'Move Search reliability up' })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Sort plans' }));
    await user.click(screen.getByRole('option', { name: 'Worklist order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Search reliability up' }));
    expect(rowLabels()[0]).toContain('Search reliability');
    expect(screen.getByText('Priority 2 → 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mobile' }));
    expect(open).toHaveBeenCalledWith('h', 'out');
  });

  it('says where the worklist came from when the picks are derived from the saved list', () => {
    const data = fixture(), s = data.goalData!.collections.worklist.selection;
    if (!s.ok || !s.configured) throw new Error('fixture');
    s.seededFromList = true; s.policyVersion = 0;
    render(<WorkOnEverythingPanel data={data} {...props()} />);
    openEditor();
    expect(screen.getByRole('status').textContent).toContain('starts from the 2 plans saved on this goal');
  });

  it('never renders blank: each unloaded case names its reason and offers Retry', () => {
    const p = props();
    const cases: Array<[(d: GoalDetailInput) => void, RegExp]> = [
      [(d) => { delete (d.goalData as { collections?: unknown }).collections; }, /server is older than this app/],
      [(d) => { d.goalData!.collections.worklist.selection = { ok: false, configured: true, reason: 'provider offline' }; },
        /Plans could not be loaded/],
      [(d) => { d.goalData = null; }, /Goal data did not load/],
      [(d) => { d.goalData!.collections = {}; }, /no plan worklist/],
      [(d) => { d.goalData!.collections = {}; d.goalData!.error = 'permission denied for goal data'; },
        /Goal data could not be read/],
    ];
    for (const [mutate, title] of cases) {
      const data = fixture(); mutate(data);
      const view = render(<WorkOnEverythingPanel data={data} {...p} />);
      expect(screen.getByRole('alert').textContent).toMatch(title);
      expect(screen.queryByRole('table')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      view.unmount();
    }
    expect(p.refresh).toHaveBeenCalledTimes(cases.length);
  });
});

describe('Design C goal cockpit (WI-10007959)', () => {
  it('opens on saved priorities and lets the owner inspect unpicked plans without starting a draft', () => {
    const fetch = vi.fn(), openPlan = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<WorkOnEverythingPanel data={fixture()} {...props()} onOpenPlan={openPlan} />);
    const priorities = screen.getByRole('region', { name: 'Priority plans' });
    expect(within(priorities).getAllByTestId('ongoing-priority-row').map(r => r.getAttribute('data-worklist-id')))
      .toEqual(['plan:h/a', 'plan:h/b']);
    expect(screen.queryByRole('button', { name: 'Remove Cloud setup' })).toBeNull();
    expect(screen.queryByRole('table', { name: 'Plans' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Selected plan progress' }).textContent).toContain('4 of 9 items done');
    fireEvent.click(screen.getByRole('button', { name: 'Browse all plans' }));
    fireEvent.click(within(priorities).getByRole('button', { name: 'Mobile' }));
    expect(openPlan).toHaveBeenCalledWith('h', 'out');
    expect(screen.queryByRole('region', { name: 'Pending changes' })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps draft priorities separate from the saved overview and retains them when returning to edit', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    render(<WorkOnEverythingPanel data={fixture()} {...props()} />);
    openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cloud setup' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to overview' }));
    expect(screen.getAllByTestId('ongoing-priority-row').map(r => r.getAttribute('data-worklist-id')))
      .toEqual(['plan:h/a', 'plan:h/b']);
    openEditor();
    expect(screen.getByRole('button', { name: 'Add Cloud setup' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Pending changes' })).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows the real paused state, unbounded attention total and existing question/plan/steward actions', () => {
    const data = fixture(); data.goal!.status = 'paused';
    data.waitingOnYouTotal = 28;
    data.waitingOnYou = [{ id: 'WI-question', title: 'Choose the search scope', harnessSlug: 'h' }];
    const openItem = vi.fn(), openPlan = vi.fn(), openAgent = vi.fn();
    render(<WorkOnEverythingPanel data={data} {...props()} onOpenWorkItem={openItem} onOpenPlan={openPlan} onOpenAgent={openAgent} />);
    const health = screen.getByRole('region', { name: 'Goal health' });
    expect(health.textContent).toContain('Paused');
    expect(health.textContent).toContain('Resuming alone will not answer them');
    expect(within(health).getByText('Goal control')).toBeTruthy();
    const needs = screen.getByRole('region', { name: 'Needs you' });
    expect(needs.textContent).toContain('Showing 1 of 28 items');
    fireEvent.click(within(needs).getByRole('button', { name: 'Open question' }));
    expect(openItem).toHaveBeenCalledWith('WI-question');
    fireEvent.click(within(needs).getByRole('button', { name: 'Open plan' }));
    expect(openPlan).toHaveBeenCalledWith('h', 'b');
    fireEvent.click(screen.getByRole('button', { name: 'Ask steward' }));
    expect(openAgent).toHaveBeenCalledWith('holder');
  });

  it('does not turn missing progress, budget or attention into a measured zero', () => {
    const data = fixture(); data.goalData!.collections.worklist.rows[0].counts = null;
    data.waitingOnYou = [{ id: 'WI-unknown', title: 'Question without a total' }];
    render(<WorkOnEverythingPanel data={data} {...props()} />);
    const progress = screen.getByRole('region', { name: 'Selected plan progress' });
    expect(progress.textContent).toContain('1 of 3 items done');
    expect(progress.textContent).toContain('totals are partial');
    const needs = screen.getByRole('region', { name: 'Needs you' });
    expect(needs.textContent).toContain('Not measured');
    expect(needs.textContent).toContain('decision total unavailable');
    expect(needs.textContent).not.toContain('No items are waiting');
    expect(screen.getByText('Budget unavailable')).toBeTruthy();
    expect(screen.getByText('Spend unavailable')).toBeTruthy();
    openEditor();
    expect(screen.getByText(/totals count measured plans only/)).toBeTruthy();
  });

  it('keeps finished plans inspectable while unknown plans remain visible', () => {
    const data = fixture(), rows = data.goalData!.collections.worklist.rows;
    rows[0].counts = counts(0, 0, 6); rows[1].counts = null;
    render(<WorkOnEverythingPanel data={data} {...props()} />);
    expect(screen.getAllByTestId('ongoing-priority-row').map(r => r.getAttribute('data-worklist-id'))).toEqual(['plan:h/b']);
    fireEvent.click(screen.getByRole('button', { name: 'Show finished' }));
    expect(screen.getAllByTestId('ongoing-priority-row').map(r => r.getAttribute('data-worklist-id'))).toEqual(['plan:h/a', 'plan:h/b']);
    expect(screen.getByText('Finished · needs sign-off')).toBeTruthy();
  });

  it('orders real history and work activity by their source dates, without claiming stopped or undated work completed', () => {
    const data = fixture();
    data.goalData!.worklistHistory = [{ id: 'edit', ref: 'plan:h/a', at: '2026-10-08T11:00:00Z', actor: 'human',
      label: 'Worklist priority changed', detail: 'Search moved first' }];
    data.activity = [
      { id: 'WI-stop', title: 'Stopped task', status: 'killed', updatedAt: '2026-10-08T10:00:00Z' },
      { id: 'WI-done', title: 'Verified repair', status: 'done', closedAt: '2026-10-08T12:00:00Z' },
      { id: 'WI-undated', title: 'Undated task', status: 'done' },
    ];
    const open = vi.fn(), openPlan = vi.fn();
    render(<WorkOnEverythingPanel data={data} {...props()} onOpenWorkItem={open} onOpenPlan={openPlan} />);
    const activity = screen.getByRole('region', { name: 'Recent activity' });
    expect(within(activity).getAllByRole('button').map(b => b.textContent))
      .toEqual(['Verified repair', 'Worklist priority changed', 'Stopped task']);
    expect(within(activity).getAllByText('Completed')).toHaveLength(1);
    expect(within(activity).queryByText('Undated task')).toBeNull();
    fireEvent.click(within(activity).getByRole('button', { name: 'Worklist priority changed' }));
    expect(openPlan).toHaveBeenCalledWith('h', 'a');
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(within(activity).getByRole('button', { name: 'Verified repair' }));
    expect(open).toHaveBeenCalledWith('WI-done');
    expect(activity.querySelector('time')?.dateTime).toBe('2026-10-08T12:00:00Z');
  });
});
