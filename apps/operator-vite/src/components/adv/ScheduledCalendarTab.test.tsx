// @vitest-environment jsdom
/**
 * ScheduledCalendarTab render coverage (scheduled-recurring-plans-2026-06-16
 * P-018/P-019). The component's own logic — the masthead `stats` reducer over
 * the occurrence rows, the legend, the selected-plan aside (driven by the
 * `calPlan` nuqs param), and the SchedulePicker filter/sort — sits above a
 * heavy FullCalendar canvas + modal children, all of which are stubbed:
 *   • FullCalendar / its plugins → inert;
 *   • ScheduledRoutinesPane / ScheduleEditor / Modal / Tooltip → light stubs;
 *   • `plans.scheduledOccurrences` + `plans.list` + `plans.schedule` sync
 *     queries are mocked by queryName;
 *   • nuqs `useQueryState` is mocked with H-state so `calPlan` is settable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({
  occurrences: [] as unknown[],
  occurrenceError: null as Error | null,
  invalidateOccurrences: vi.fn(),
  planList: [] as unknown[],
  queries: [] as Array<{ queryName: string; args: unknown }>,
  nuqs: { calView: 'dayGridMonth', calPlan: null } as Record<string, unknown>,
}));

// FullCalendar is a heavy canvas/virtualized grid — stub to an inert marker.
vi.mock('@fullcalendar/react', () => ({ default: () => <div data-testid="fullcalendar" /> }));
vi.mock('@fullcalendar/daygrid', () => ({ default: {} }));
vi.mock('@fullcalendar/timegrid', () => ({ default: {} }));
vi.mock('@fullcalendar/interaction', () => ({ default: {} }));

vi.mock('./ScheduledRoutinesPane', () => ({ default: () => <div data-testid="routines-pane" /> }));
vi.mock('./ScheduleEditor', () => ({
  default: () => <div data-testid="schedule-editor" />,
  runScheduleTool: vi.fn(async () => ({ ok: true })),
}));
// The harness Modal/Tooltip just render children inline so the picker is assertable.
vi.mock('@/app/harness/Modal', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div data-testid="modal">{children}</div>,
}));
vi.mock('@/app/harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: { queryName: string; args: unknown }) => {
    H.queries.push({ queryName: opts.queryName, args: opts.args });
    if (opts.queryName === 'plans.scheduledOccurrences')
      return { data: H.occurrences, loading: false, error: H.occurrenceError, invalidate: H.invalidateOccurrences };
    if (opts.queryName === 'plans.list') return { data: H.planList, loading: false, invalidate: vi.fn() };
    if (opts.queryName === 'plans.schedule') return { data: [], loading: false, invalidate: vi.fn() };
    return { data: [], loading: false, invalidate: vi.fn() };
  },
}));

import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => {
    const setter = vi.fn((v: unknown) => {
      H.nuqs[key] = typeof v === 'function' ? (v as (p: unknown) => unknown)(H.nuqs[key]) : v;
    });
    return [H.nuqs[key], setter];
  },
  parseAsString: {},
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
}));

import ScheduledCalendarTab from './ScheduledCalendarTab';

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
  H.occurrences = [];
  H.occurrenceError = null;
  H.invalidateOccurrences.mockReset();
  H.planList = [];
  H.queries = [];
  H.nuqs = { calView: 'dayGridMonth', calPlan: null };
});
afterEach(cleanup);

describe('<ScheduledCalendarTab> occurrence read recovery', () => {
  it('shows a denied read instead of healthy counts or stale selected-plan details', () => {
    H.occurrenceError = new Error('read denied');
    H.occurrences = [occ()];
    H.nuqs.calPlan = 'plan-a';
    render(<ScheduledCalendarTab />);
    expect(screen.getByRole('alert').textContent).toContain('Calendar is unavailable.');
    expect(screen.queryByLabelText('Calendar occurrence summary')).toBeNull();
    expect(screen.queryByLabelText('Close selected plan')).toBeNull();
    expect(screen.getByTestId('fullcalendar')).toBeTruthy();
  });

  it('retries the occurrence read and restores counts and selection after recovery', () => {
    H.occurrenceError = new Error('read denied');
    H.nuqs.calPlan = 'plan-a';
    const view = render(<ScheduledCalendarTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(H.invalidateOccurrences).toHaveBeenCalledTimes(1);
    H.occurrenceError = null;
    H.occurrences = [occ()];
    view.rerender(<ScheduledCalendarTab />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Calendar occurrence summary').textContent).toContain('1 in view');
    expect(screen.getByLabelText('Close selected plan')).toBeTruthy();
  });

  it('keeps a successful empty occurrence result distinct from a failed read', () => {
    render(<ScheduledCalendarTab />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Calendar occurrence summary').textContent).toContain('0 in view');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('<ScheduledCalendarTab> masthead + frame', () => {
  it('renders the masthead, legend, routines pane and the stubbed calendar', () => {
    render(<ScheduledCalendarTab />);
    expect(screen.getByText('Calendar')).toBeTruthy();
    expect(screen.getByText('Scheduled plans')).toBeTruthy();
    expect(screen.getByLabelText('Calendar status legend')).toBeTruthy();
    expect(screen.getByTestId('routines-pane')).toBeTruthy();
    expect(screen.getByTestId('fullcalendar')).toBeTruthy();
  });

  it('counts in-view + armed and omits the zero-count danger/warn/paused/one-shot stats', () => {
    H.occurrences = [occ({ scheduleActive: true }), occ({ templateSlug: 'b', scheduleActive: true })];
    render(<ScheduledCalendarTab />);
    const summary = screen.getByLabelText('Calendar occurrence summary');
    expect(summary.textContent).toContain('2 in view');
    expect(summary.textContent).toContain('2 armed');
    // none failed/partial/paused/one-shot → those spans are not rendered
    expect(summary.textContent).not.toContain('failed');
    expect(summary.textContent).not.toContain('partial');
    expect(summary.textContent).not.toContain('paused');
    expect(summary.textContent).not.toContain('one-shot');
  });

  it('surfaces failed / partial / paused / one-shot counts when present', () => {
    H.occurrences = [
      occ({ templateSlug: 'a', scheduleActive: true, lastOutcome: 'failed' }),
      occ({ templateSlug: 'b', scheduleActive: false, kind: 'one-shot', lastOutcome: 'partial' }),
      occ({ templateSlug: 'c', scheduleActive: true, lastOutcome: 'timed-out' }),
    ];
    render(<ScheduledCalendarTab />);
    const summary = screen.getByLabelText('Calendar occurrence summary');
    expect(summary.textContent).toContain('failed');
    expect(summary.textContent).toContain('partial');
    expect(summary.textContent).toContain('paused');
    expect(summary.textContent).toContain('one-shot');
  });
});

describe('<ScheduledCalendarTab> selected-plan aside', () => {
  it('does not render the aside when no plan is selected', () => {
    H.occurrences = [occ()];
    render(<ScheduledCalendarTab />);
    expect(screen.queryByLabelText('Close selected plan')).toBeNull();
  });

  it('renders the selected-plan aside when calPlan matches an occurrence', () => {
    H.nuqs = { calView: 'dayGridMonth', calPlan: 'plan-a' };
    H.occurrences = [occ({ templateSlug: 'plan-a', title: 'Plan A', scheduleActive: true, kind: 'recurring', lastOutcome: 'success' })];
    render(<ScheduledCalendarTab />);
    expect(screen.getByLabelText('Close selected plan')).toBeTruthy();
    // detail dl shows the plan's pot + armed state + kind + last run
    expect(screen.getByText('pot-x')).toBeTruthy();
    expect(screen.getByText('Armed (firing)')).toBeTruthy();
    expect(screen.getByText('Recurring')).toBeTruthy();
    expect(screen.getByText('success')).toBeTruthy();
    // the "Open plan" deep link
    expect(screen.getByText('Open plan')).toBeTruthy();
  });

  it('shows the paused / one-shot / no-upcoming detail variant', () => {
    H.nuqs = { calView: 'dayGridMonth', calPlan: 'past-plan' };
    H.occurrences = [
      occ({ templateSlug: 'past-plan', title: 'Past', scheduleActive: false, kind: 'one-shot', lastOutcome: null, occurrenceMs: Date.now() - 5 * HOUR }),
    ];
    render(<ScheduledCalendarTab />);
    expect(screen.getByText('Paused (disarmed)')).toBeTruthy();
    expect(screen.getByText('One-shot')).toBeTruthy();
    // lastOutcome null → em dash
    expect(screen.getByText('—')).toBeTruthy();
    // all occurrences are in the past → no upcoming
    expect(screen.getByText(/No upcoming occurrences in view/)).toBeTruthy();
  });
});

describe('<ScheduledCalendarTab> schedule picker', () => {
  it('opens the picker from the Schedule button and lists plans', () => {
    H.planList = [
      { slug: 'sp-1', title: 'Alpha Plan', scheduled: false, scheduleActive: false, harness: 'pot-x' },
      { slug: 'sp-2', title: 'Beta Plan', scheduled: true, scheduleActive: true, harness: 'pot-x' },
    ];
    render(<ScheduledCalendarTab />);
    fireEvent.click(screen.getByText('Schedule'));
    expect(H.queries.some(({ queryName, args }) => queryName === 'plans.list' && JSON.stringify(args) === '{}')).toBe(true);
    expect(H.queries.some(({ queryName }) => queryName === 'harnessProjects.lite')).toBe(false);
    // picker modal mounts with both plans + the armed glance on the scheduled one
    expect(screen.getByText('Schedule a plan')).toBeTruthy();
    expect(screen.getByText('Alpha Plan')).toBeTruthy();
    expect(screen.getByText('Beta Plan')).toBeTruthy();
    // the scheduled+active plan shows the "armed" glance em in its picker row
    const armedEm = document.querySelector('.pc-sched-cal__picker-row em.is-armed');
    expect(armedEm?.textContent).toBe('armed');
  });

  it('filters the picker list by the search input', () => {
    H.planList = [
      { slug: 'sp-1', title: 'Alpha Plan', scheduled: false, scheduleActive: false, harness: 'pot-x' },
      { slug: 'sp-2', title: 'Beta Plan', scheduled: false, scheduleActive: false, harness: 'pot-x' },
    ];
    render(<ScheduledCalendarTab />);
    fireEvent.click(screen.getByText('Schedule'));
    fireEvent.change(screen.getByLabelText('Filter plans'), { target: { value: 'beta' } });
    expect(screen.queryByText('Alpha Plan')).toBeNull();
    expect(screen.getByText('Beta Plan')).toBeTruthy();
  });

  it('shows the no-match empty state when the filter excludes everything', () => {
    H.planList = [{ slug: 'sp-1', title: 'Alpha Plan', scheduled: false, scheduleActive: false, harness: 'pot-x' }];
    render(<ScheduledCalendarTab />);
    fireEvent.click(screen.getByText('Schedule'));
    fireEvent.change(screen.getByLabelText('Filter plans'), { target: { value: 'zzz-nope' } });
    expect(screen.getByText('No plans match.')).toBeTruthy();
  });
});
