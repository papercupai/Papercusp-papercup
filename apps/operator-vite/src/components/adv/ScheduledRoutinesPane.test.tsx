// @vitest-environment jsdom
/**
 * ScheduledRoutinesPane render coverage (scheduled-recurring-plans-2026-06-16
 * P-026) — the ops list of scheduled plans. Pins: the loading vs honest-empty
 * states, the summary, the active-first/soonest-fire sort + per-plan
 * collapse to one row (the byPlan reducer keeps the soonest fire), the
 * explicit active/paused + last-run labels, the relative-when label, and the onSelect
 * click handler. The `plans.scheduledOccurrences` sync query is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({
  result: { data: [], loading: false, error: null } as { data: unknown[]; loading: boolean; error?: Error | null },
  invalidate: vi.fn(),
}));

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: () => ({ ...H.result, invalidate: H.invalidate }),
}));

import ScheduledRoutinesPane from './ScheduledRoutinesPane';

const HOUR = 60 * 60 * 1000;

function occ(over: Record<string, unknown> = {}) {
  return {
    templateSlug: 'plan-a',
    title: 'Plan A',
    harnessSlug: 'pot-x',
    occurrenceMs: Date.now() + 2 * HOUR,
    kind: 'recurring',
    scheduleActive: true,
    lastOutcome: null,
    ...over,
  };
}

beforeEach(() => {
  H.result = { data: [], loading: false, error: null };
  H.invalidate.mockReset();
});
afterEach(cleanup);

describe('<ScheduledRoutinesPane>', () => {
  it('shows a denied read instead of an empty routine list or stale active counts', () => {
    H.result = { data: [occ()], loading: false, error: new Error('read denied') };
    render(<ScheduledRoutinesPane />);
    expect(screen.getByRole('alert').textContent).toContain('Scheduled routines are unavailable.');
    expect(screen.queryByText(/No routines scheduled/)).toBeNull();
    expect(screen.queryByText('1 active')).toBeNull();
    expect(screen.queryByText('Plan A')).toBeNull();
  });

  it('retries a failed read and restores the routine list when it succeeds', () => {
    H.result = { data: [], loading: false, error: new Error('read denied') };
    const view = render(<ScheduledRoutinesPane />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(H.invalidate).toHaveBeenCalledTimes(1);
    H.result = { data: [occ()], loading: false, error: null };
    view.rerender(<ScheduledRoutinesPane />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Plan A')).toBeTruthy();
    expect(screen.getByText('1 active')).toBeTruthy();
  });

  it('shows the loading state while fetching with no data', () => {
    H.result = { data: [], loading: true };
    render(<ScheduledRoutinesPane />);
    expect(screen.getByText(/Loading routines…/)).toBeTruthy();
  });

  it('shows the honest empty state when there are no occurrences', () => {
    render(<ScheduledRoutinesPane />);
    expect(screen.getByText(/No routines scheduled in the next 30 days/)).toBeTruthy();
  });

  it('renders the header count and one row per plan', () => {
    H.result = {
      data: [occ({ templateSlug: 'plan-a', title: 'Plan A' }), occ({ templateSlug: 'plan-b', title: 'Plan B' })],
      loading: false,
    };
    render(<ScheduledRoutinesPane />);
    expect(screen.getByText('2 scheduled')).toBeTruthy();
    expect(screen.getByText('2 active')).toBeTruthy();
    expect(screen.getByText('Plan A')).toBeTruthy();
    expect(screen.getByText('Plan B')).toBeTruthy();
  });

  it('collapses multiple occurrences of one plan into a single row', () => {
    const now = Date.now();
    H.result = {
      data: [
        occ({ templateSlug: 'plan-a', occurrenceMs: now + 5 * HOUR }),
        occ({ templateSlug: 'plan-a', occurrenceMs: now + 1 * HOUR }),
      ],
      loading: false,
    };
    render(<ScheduledRoutinesPane />);
    // single row → one title node
    expect(screen.getAllByText('Plan A').length).toBe(1);
    expect(screen.getByText('1 scheduled')).toBeTruthy();
  });

  it('sorts armed plans before paused ones', () => {
    H.result = {
      data: [
        occ({ templateSlug: 'paused', title: 'Paused Plan', scheduleActive: false, occurrenceMs: Date.now() + 1 * HOUR }),
        occ({ templateSlug: 'armed', title: 'Armed Plan', scheduleActive: true, occurrenceMs: Date.now() + 10 * HOUR }),
      ],
      loading: false,
    };
    render(<ScheduledRoutinesPane />);
    const items = document.querySelectorAll('li');
    expect(items[0].textContent).toContain('Armed Plan');
    expect(items[1].textContent).toContain('Paused Plan');
  });

  it('renders a readable last-run outcome', () => {
    H.result = {
      data: [occ({ lastOutcome: 'success', occurrenceMs: Date.now() + 2 * HOUR })],
      loading: false,
    };
    render(<ScheduledRoutinesPane />);
    expect(screen.getByText('Last: Success')).toBeTruthy();
  });

  it('renders the active state and emphasizes overdue past fires', () => {
    H.result = {
      data: [occ({ scheduleActive: true, occurrenceMs: Date.now() - 1 * HOUR })],
      loading: false,
    };
    render(<ScheduledRoutinesPane />);
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Overdue')).toBeTruthy();
    expect(screen.getByText('Overdue').getAttribute('data-tone')).toBe('overdue');
  });

  it('labels an active future fire as the next run', () => {
    H.result = {
      data: [occ({ scheduleActive: true, occurrenceMs: Date.now() + 2 * HOUR })],
      loading: false,
    };
    render(<ScheduledRoutinesPane />);
    expect(screen.getByText('Next in 2h').getAttribute('data-tone')).toBe('upcoming');
  });

  it('says a paused routine is not running instead of showing its stored future fire', () => {
    H.result = {
      data: [occ({ scheduleActive: false, occurrenceMs: Date.now() + 2 * HOUR })],
      loading: false,
    };
    render(<ScheduledRoutinesPane />);
    expect(screen.getByText('Not running').getAttribute('data-tone')).toBe('paused');
    expect(screen.queryByText(/Next in/)).toBeNull();
  });

  it('calls onSelect with the templateSlug when a row is clicked', () => {
    const onSelect = vi.fn();
    H.result = { data: [occ({ templateSlug: 'plan-z', title: 'Plan Z' })], loading: false };
    render(<ScheduledRoutinesPane onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Plan Z'));
    expect(onSelect).toHaveBeenCalledWith('plan-z');
    expect(document.querySelector('.pc-routines__chevron')).toBeTruthy();
  });
});
