// @vitest-environment jsdom
/**
 * GoalPackagesRail behaviour coverage (work-on-everything-goal-2026-08-23 P-009).
 *
 * Same discipline as GoalStatusControl.test.tsx and for its stated reason:
 * several of the rail's properties are ABSENCES (no Start on a live package, no
 * spend line without a reading, no optimistic flip after a failed write), and
 * an absence assertion in jsdom passes vacuously unless paired with a control
 * proving the thing CAN happen.
 *
 * The claims:
 *   1. Start renders exactly when no NON-STUB instance exists — a catalog-only
 *      package and a stub-only package both offer it (install ≠ start, D-002);
 *      a live instance replaces it with the readout.
 *   2. The write is POST /api/admin/goals/start-from-package with body {ref},
 *      and NOTHING moves locally on failure (P-016 inherited: the store, not
 *      the component, flips the card).
 *   3. A `degraded` success warns stickily; a clean one reports plain success.
 *   4. Spend is labeled by the PAYLOAD's own window and the budget by the
 *      PACKAGE's declared window — the two may differ (P-004); no reading
 *      renders no spend line, never $0.
 *   5. Start does not bubble into the surrounding surface (stopPropagation);
 *      clicking a live card opens its goal.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { toast } from 'sonner';
import GoalPackagesRail, {
  type GoalPackageRailEntry,
  type GoalPackageRailInstance,
} from './GoalPackagesRail';
import type { HudGoalInput } from './hud-entity-board';
import type { GoalDetailInput } from './goal-detail-model';

const sync = vi.hoisted(() => ({ data: null as GoalDetailInput[] | null, error: null as Error | null }));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => ({ data: sync.data, loading: false, error: sync.error }) }));
vi.mock('@/app/harness/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: vi.fn(), element: null }) }));

const fetchMock = vi.fn();

function reply(body: Record<string, unknown>, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sync.data = null;
  sync.error = null;
  fetchMock.mockResolvedValue(reply({ data: { id: 'G-NEW' } }));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(cleanup);

function entry(over: Partial<GoalPackageRailEntry> = {}): GoalPackageRailEntry {
  return {
    ref: 'woe',
    title: 'Work on everything',
    description: 'the standing steward',
    layer: 'bundled',
    version: '1.0.0',
    standing: true,
    budgetCents: 10_000,
    budgetWindowSec: 604_800,
    instances: [],
    activeGoalId: null,
    featured: true,
    ...over,
  };
}

const stub: GoalPackageRailInstance = { goalId: 'G-1', status: 'paused', adoptableStub: true };
const live: GoalPackageRailInstance = { goalId: 'G-9', status: 'active', adoptableStub: false };

function goalRow(over: Partial<HudGoalInput> = {}): HudGoalInput {
  return { id: 'G-9', title: 'Work on everything', status: 'active', holderLiveness: 'held', ...over };
}

describe('GoalPackagesRail — when Start is offered', () => {
  it('offers one-click Start for a package with no instance at all', () => {
    render(<GoalPackagesRail entries={[entry()]} goals={[]} />);
    expect(screen.getByTestId('pkg-start-woe')).toBeTruthy();
    expect(screen.queryByTestId('pkg-status-woe')).toBeNull();
  });

  it('still offers Start when only the seeded stub exists (installed is not started)', () => {
    render(
      <GoalPackagesRail entries={[entry({ instances: [stub], activeGoalId: null })]} goals={[]} />,
    );
    expect(screen.getByTestId('pkg-start-woe')).toBeTruthy();
  });

  it('CONTROL: a live instance replaces Start with the status readout', () => {
    render(
      <GoalPackagesRail
        entries={[entry({ instances: [live], activeGoalId: 'G-9' })]}
        goals={[goalRow()]}
      />,
    );
    expect(screen.queryByTestId('pkg-start-woe')).toBeNull();
    expect(screen.getByTestId('ongoing-status').textContent).toBe('Running');
  });

  it('renders nothing at all with no packages — an older payload keeps the plain board', () => {
    render(<GoalPackagesRail entries={[]} goals={[]} />);
    expect(screen.queryByTestId('goal-packages-rail')).toBeNull();
  });
});

describe('GoalPackagesRail — the write, and no optimistic state (P-016 inherited)', () => {
  it('POSTs {ref} to the start-from-package route', async () => {
    render(<GoalPackagesRail entries={[entry()]} goals={[]} />);
    fireEvent.click(screen.getByTestId('pkg-start-woe'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/goals/start-from-package');
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as {
      ref?: string;
    };
    expect(body).toEqual({ ref: 'woe' });
  });

  it('moves NOTHING when the write fails — the card still offers Start', async () => {
    fetchMock.mockResolvedValue(
      reply(
        { error: { message: "no goal package 'woe' in the local store" } },
        { ok: false, status: 400 },
      ),
    );

    render(<GoalPackagesRail entries={[entry()]} goals={[]} />);
    fireEvent.click(screen.getByTestId('pkg-start-woe'));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // Nothing was moved locally, so nothing rolls back — and the button still
    // offers the start that did not happen (the in-flight "…" is cleared in a
    // `finally` that runs after the toast, hence waitFor).
    await waitFor(() =>
      expect(screen.getByTestId('pkg-start-woe').textContent).toBe('Start'),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('does not flip the card after a SUCCESSFUL write either — the store repaints it', async () => {
    render(<GoalPackagesRail entries={[entry()]} goals={[]} />);
    fireEvent.click(screen.getByTestId('pkg-start-woe'));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    // The props have not changed and the component keeps no copy: still Start.
    // goals.list invalidation → re-pull → the parent re-renders with the
    // instance row is the ONLY path to the readout.
    expect(screen.getByTestId('pkg-start-woe')).toBeTruthy();
    expect(screen.queryByTestId('pkg-status-woe')).toBeNull();
  });

  it('a degraded success warns stickily and is not a clean success', async () => {
    fetchMock.mockResolvedValue(
      reply({
        data: { id: 'G-2' },
        degraded: true,
        degradedReasons: ['holder spawn deferred: launch ceiling reached'],
      }),
    );

    render(<GoalPackagesRail entries={[entry()]} goals={[]} />);
    fireEvent.click(screen.getByTestId('pkg-start-woe'));

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    const [title, opts] = (toast.warning as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, { description?: string; duration?: number }];
    expect(title).toMatch(/not completely/i);
    expect(opts.description).toContain('launch ceiling');
    expect(opts.duration).toBe(Infinity);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('CONTROL: a clean write reports a plain success', async () => {
    render(<GoalPackagesRail entries={[entry()]} goals={[]} />);
    fireEvent.click(screen.getByTestId('pkg-start-woe'));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('GoalPackagesRail — spend + budget labels (P-004: each figure under its OWN window)', () => {
  it('labels spend by the payload window and budget by the package window, even when they differ', () => {
    render(
      <GoalPackagesRail
        entries={[
          entry({ instances: [live], activeGoalId: 'G-9', budgetCents: 10_000, budgetWindowSec: 604_800 }),
        ]}
        goals={[goalRow({ spendRecentUsd: 12.34, spendRecentWindowDays: 14, budgetCents: 10_000, budgetWindowSec: 604_800 })]}
      />,
    );
    // 14, straight off the payload — a hardcoded "7" here would be the drift
    // the resolver put the window on the wire to prevent.
    expect(screen.getByText(/Spend: \$12.34 in the last 14 days/)).toBeTruthy();
    // The budget keeps the PACKAGE's own declared 7d window beside it.
    expect(screen.getByText(/Budget: \$100.00 \/ 7 days/)).toBeTruthy();
  });

  it('renders NO spend line without a reading — never $0', () => {
    render(
      <GoalPackagesRail
        entries={[entry({ instances: [live], activeGoalId: 'G-9' })]}
        goals={[goalRow()]}
      />,
    );
    expect(screen.getByText(/Spend unavailable/)).toBeTruthy();
    // (The CONTROL that a reading DOES render is the labeled test above.)
  });

  it('a windowless budget renders without inventing a window label', () => {
    render(
      <GoalPackagesRail
        entries={[entry({ budgetCents: 5_000, budgetWindowSec: null })]}
        goals={[]}
      />,
    );
    expect(screen.getByTestId('pkg-budget-woe').textContent).toBe('budget $50.00');
  });
});

describe('GoalPackagesRail — clicks go where they say', () => {
  it.each([
    ['active', 'active', 'held', 'Running'],
    ['active', 'active', 'unknown', 'Status unavailable'],
    ['active', 'dormant', 'lost', 'Not running'],
    ['paused', 'paused', 'held', 'Paused'],
    ['achieved', 'achieved', 'unheld', 'Achieved'],
    ['killed', 'killed', 'unheld', 'Stopped'],
  ])('renders canonical %s/%s/%s liveness as %s', (status, effectiveStatus, holderLiveness, label) => {
    sync.data = [{ goal: goalRow({ status }), effectiveStatus, holderLiveness }];
    render(<GoalPackagesRail entries={[entry({ activeGoalId: 'G-9', instances: [live] })]}
      goals={[goalRow()]} workspaceId="workspace-under-test" />);
    expect(screen.getByTestId('ongoing-status').textContent).toBe(label);
  });

  it('discloses a detail query error and keeps navigation on the current instance', () => {
    const onOpenGoal = vi.fn();
    sync.error = new Error('Detail unavailable for this test');
    render(<GoalPackagesRail entries={[entry({ activeGoalId: 'G-9', instances: [live] })]}
      goals={[goalRow()]} workspaceId="workspace-under-test" onOpenGoal={onOpenGoal} />);
    expect(screen.getByRole('status').textContent).toBe('Ongoing work details unavailable.');
    expect(screen.getByText('Priorities unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View ongoing work' }));
    expect(onOpenGoal).toHaveBeenCalledWith('G-9');
  });

  it('gives the standing goal a labeled featured region and ongoing identity', () => {
    render(<GoalPackagesRail entries={[entry({ activeGoalId: 'G-9', instances: [live] })]}
      goals={[goalRow()]} />);
    const region = screen.getByRole('region', { name: 'Ongoing work: Work on everything' });
    expect(region.classList.contains('hud-ongoing--featured')).toBe(true);
    expect(region.querySelector('svg.lucide-infinity')).not.toBeNull();
    expect(region.querySelectorAll('button').length).toBeGreaterThan(0);
    expect(region.querySelector('button button')).toBeNull();
    expect(screen.getByRole('button', { name: 'View ongoing work' })).toBeTruthy();
  });

  it('keeps ongoing work in the compact strip and leaves ordinary packages for Goals', () => {
    const onOpenGoal = vi.fn();
    render(<GoalPackagesRail entries={[entry({ activeGoalId: 'G-9', instances: [live] }),
      entry({ ref: 'ordinary', standing: false })]} goals={[goalRow()]}
      variant="compact" onOpenGoal={onOpenGoal} />);
    expect(screen.getByRole('button', { name: 'View work' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pause/ })).toBeTruthy();
    expect(screen.queryByTestId('pkg-card-ordinary')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View work' }));
    expect(onOpenGoal).toHaveBeenCalledWith('G-9');
  });

  it('shows the real detail focus/outcome and unbounded attention count', () => {
    sync.data = [{ goal: goalRow(), holderLiveness: 'held', effectiveStatus: 'active',
      goalModeState: { portfolio: { priorities: ['Reconcile the search plan'] } },
      activity: [{ id: 'WI-10', title: 'Search repair verified', status: 'done', closedAt: '2026-10-06T12:00:00Z' }],
      waitingOnYou: [{ id: 'WI-11', title: 'Choose release scope' }], waitingOnYouTotal: 31 }];
    render(<GoalPackagesRail entries={[entry({ activeGoalId: 'G-9', instances: [live] })]}
      goals={[goalRow()]} workspaceId="workspace-under-test" nowMs={Date.parse('2026-10-06T12:08:00Z')} />);
    expect(screen.getByText('Reconcile the search plan')).toBeTruthy();
    expect(screen.getByText('Search repair verified')).toBeTruthy();
    expect(screen.getByText('31 waiting on you')).toBeTruthy();
  });

  it('an ordinary package keeps its original start card', () => {
    render(<GoalPackagesRail entries={[entry({ ref: 'ordinary', standing: false })]} goals={[]} />);
    expect(screen.getByTestId('pkg-start-ordinary')).toBeTruthy();
    expect(screen.queryByTestId('ongoing-work-overview')).toBeNull();
  });
  it('Start does not bubble into the surrounding surface', async () => {
    const surfaceClick = vi.fn();
    render(
      <div onClick={surfaceClick}>
        <GoalPackagesRail entries={[entry()]} goals={[]} />
      </div>,
    );

    // CONTROL first: the harness genuinely propagates, so the absence below is
    // stopPropagation and not a listener that was never wired.
    fireEvent.click(screen.getByTestId('pkg-card-woe'));
    expect(surfaceClick).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('pkg-start-woe'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(surfaceClick).toHaveBeenCalledTimes(1);
  });

  it('clicking a live card opens its goal', () => {
    const onOpenGoal = vi.fn();
    render(
      <GoalPackagesRail
        entries={[entry({ instances: [live], activeGoalId: 'G-9' })]}
        goals={[goalRow()]}
        onOpenGoal={onOpenGoal}
      />,
    );
    fireEvent.click(screen.getByTestId('pkg-card-woe'));
    expect(onOpenGoal).toHaveBeenCalledWith('G-9');
  });
});
