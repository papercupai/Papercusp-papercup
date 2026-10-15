// @vitest-environment jsdom
/**
 * GoalStatusControl behaviour coverage (goals-tab-improvement-2026-08-09 P-016).
 *
 * The component is small; what makes it worth a suite is that three of its
 * properties are ABSENCES, and an absence assertion in jsdom passes for reasons
 * that have nothing to do with the design unless it is paired with a control
 * proving the thing CAN happen. That is not a hypothetical worry here — D-011's
 * "the panel offers no composer" assertion in GoalDetailPanel.test.tsx kept
 * passing after a composer was added, because the unmocked `fetch` meant the
 * session never resolved. So every negative below is paired.
 *
 * The four claims:
 *
 *   1. P-016's stated requirement — "do NOT let an optimistic state outlive a
 *      failed write". There is no local status at all, so the verb must not move
 *      after a FAILED write; the control is that it DOES move when the store
 *      moves. Without that control the first half passes against a component
 *      that can never change its label.
 *   2. A `degraded: true` SUCCESS must not read as a clean success. This is the
 *      whole reason the seam reports `degradedReasons` (EI-19995648221353323):
 *      pausing can leave burn it could not attribute, and a green toast over
 *      that is a steering surface lying about the state of the system.
 *   3. Reopen writes `active`, never `paused`. An earlier revision routed Reopen
 *      through `togglePause`, and since a terminal goal is not `paused` it fell
 *      through to the PAUSE branch — it would have paused an already-closed
 *      goal. That defect is invisible to a typecheck and to any test that only
 *      asserts "a write happened".
 *   4. The action does not open the card. The control sits INSIDE a clickable
 *      card; without `stopPropagation` every pause also opens the popup.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/* The repo convention for confirm-gated handlers (UpdateChip, PlanActions):
   mock the hook rather than driving the real Radix dialog, so a test about the
   WRITE is not also a test of portal focus management. `confirmFn` is the lever
   for the cancel-path assertions below. */
const confirmFn = vi.fn(async (_opts: unknown) => true);
vi.mock('@/app/harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: confirmFn, element: null }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { toast } from 'sonner';
import GoalStatusControl from './GoalStatusControl';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  confirmFn.mockResolvedValue(true);
  fetchMock.mockResolvedValue(reply({}));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(cleanup);

function reply(body: Record<string, unknown>, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  };
}

/** The JSON body of the Nth (default: only) write, as the route received it. */
function writtenBody(n = 0): { id?: string; status?: string } {
  const call = fetchMock.mock.calls[n];
  return JSON.parse((call?.[1] as { body: string }).body) as { id?: string; status?: string };
}

describe('GoalStatusControl — no optimistic status (P-016)', () => {
  it('leaves the verb where it was when the write FAILS', async () => {
    fetchMock.mockResolvedValue(
      reply({ error: { message: 'goal is owned by another workspace' } }, { ok: false, status: 403 }),
    );

    render(<GoalStatusControl goalId="G-1" status="active" variant="card" />);
    fireEvent.click(screen.getByTestId('goal-pause-resume'));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // The failure sentence takes the same past participle as the success one —
    // never "Could not paused this goal" (WI-10008179).
    expect(toast.error).toHaveBeenCalledWith('Goal not paused', expect.anything());
    // Nothing was moved locally, so there is nothing to roll back — and the
    // button still offers the move that did not happen. (`waitFor` because the
    // in-flight "…" is cleared in a `finally` that runs after the toast.)
    await waitFor(() =>
      expect(screen.getByTestId('goal-pause-resume').textContent).toBe('Pause'),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('CONTROL: the verb does move when the STORE moves (so the assertion above is not vacuous)', () => {
    const { rerender } = render(
      <GoalStatusControl goalId="G-1" status="active" variant="card" />,
    );
    expect(screen.getByTestId('goal-pause-resume').textContent).toBe('Pause');

    // The only thing that may move the label: a new status off the store.
    rerender(<GoalStatusControl goalId="G-1" status="paused" variant="card" />);
    expect(screen.getByTestId('goal-pause-resume').textContent).toBe('Resume');
  });

  it('does not move the verb after a SUCCESSFUL write either — the store is what moves it', async () => {
    render(<GoalStatusControl goalId="G-1" status="active" variant="card" />);
    fireEvent.click(screen.getByTestId('goal-pause-resume'));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    // Still "Pause": the prop has not changed, and the component keeps no copy.
    // `notifySyncInvalidate` re-pulls the query and the parent re-renders it.
    await waitFor(() =>
      expect(screen.getByTestId('goal-pause-resume').textContent).toBe('Pause'),
    );
  });
});

describe('GoalStatusControl — a degraded write is not a clean one', () => {
  it('warns (and does not auto-dismiss) when the write succeeded but did less than its label', async () => {
    fetchMock.mockResolvedValue(
      reply({
        data: { id: 'G-1', status: 'paused' },
        degraded: true,
        degradedReasons: ['3 active loops could not be attributed to this goal'],
      }),
    );

    render(<GoalStatusControl goalId="G-1" status="active" variant="card" />);
    fireEvent.click(screen.getByTestId('goal-pause-resume'));

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    const [title, opts] = (toast.warning as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, { description?: string; duration?: number }];
    expect(title).toMatch(/not completely/i);
    // The REASON has to reach the reader — a warning with no body is just a
    // differently-coloured success.
    expect(opts.description).toContain('could not be attributed');
    expect(opts.duration).toBe(Infinity);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('CONTROL: a clean write reports a plain success', async () => {
    fetchMock.mockResolvedValue(reply({ data: { id: 'G-1', status: 'paused' } }));

    render(<GoalStatusControl goalId="G-1" status="active" variant="card" />);
    fireEvent.click(screen.getByTestId('goal-pause-resume'));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('treats `degraded` with no reasons as clean — an empty warning teaches nothing', async () => {
    fetchMock.mockResolvedValue(reply({ degraded: true, degradedReasons: [] }));

    render(<GoalStatusControl goalId="G-1" status="active" variant="card" />);
    fireEvent.click(screen.getByTestId('goal-pause-resume'));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('GoalStatusControl — which move each button actually writes', () => {
  it('Reopen calls the existing-goal start route so status and holder move together', async () => {
    render(<GoalStatusControl goalId="G-1" status="killed" variant="panel" />);
    fireEvent.click(screen.getByTestId('goal-reopen'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(writtenBody()).toEqual({ id: 'G-1' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/goals/start-existing');
  });

  it('Start on a holderless active goal uses the same activation route', async () => {
    render(
      <GoalStatusControl
        goalId="G-1"
        status="active"
        effectiveStatus="dormant"
        holderLiveness="unheld"
        variant="panel"
      />,
    );
    fireEvent.click(screen.getByTestId('goal-start'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/goals/start-existing');
    expect(writtenBody()).toEqual({ id: 'G-1' });
    expect(screen.queryByTestId('goal-pause-resume')).toBeNull();
  });

  it('does not start against UNKNOWN holder liveness', () => {
    render(
      <GoalStatusControl
        goalId="G-1"
        status="active"
        effectiveStatus="active"
        holderLiveness="unknown"
        variant="panel"
      />,
    );
    expect(screen.queryByTestId('goal-start')).toBeNull();
    expect(screen.getByTestId('goal-pause-resume')).toBeTruthy();
  });

  it('Resume from paused writes `active`; Pause from active writes `paused`', async () => {
    const { unmount } = render(
      <GoalStatusControl goalId="G-1" status="paused" variant="card" />,
    );
    fireEvent.click(screen.getByTestId('goal-pause-resume'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(writtenBody(0).status).toBe('active');
    unmount();

    render(<GoalStatusControl goalId="G-1" status="active" variant="card" />);
    fireEvent.click(screen.getByTestId('goal-pause-resume'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(writtenBody(1).status).toBe('paused');
  });

  it('the terminal moves write their own status', async () => {
    render(<GoalStatusControl goalId="G-1" status="active" variant="panel" />);
    fireEvent.click(screen.getByTestId('goal-achieved'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(writtenBody(0).status).toBe('achieved');

    fireEvent.click(screen.getByTestId('goal-kill'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(writtenBody(1).status).toBe('killed');
  });

  it('writes NOTHING when the confirm is declined', async () => {
    confirmFn.mockResolvedValue(false);

    render(<GoalStatusControl goalId="G-1" status="active" variant="card" />);
    fireEvent.click(screen.getByTestId('goal-pause-resume'));

    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    // CONTROL: the same click DOES write once the confirm is accepted, so the
    // absence above is the decline and not a wiring mistake.
    confirmFn.mockResolvedValue(true);
    fireEvent.click(screen.getByTestId('goal-pause-resume'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});

describe('GoalStatusControl — which buttons exist where', () => {
  it('offers no everyday verb on a TERMINAL goal (there is nothing to pause)', () => {
    render(<GoalStatusControl goalId="G-1" status="achieved" variant="card" />);
    expect(screen.queryByTestId('goal-pause-resume')).toBeNull();
  });

  it('CONTROL: the same card variant DOES offer it on a live goal', () => {
    render(<GoalStatusControl goalId="G-1" status="active" variant="card" />);
    expect(screen.getByTestId('goal-pause-resume')).toBeTruthy();
  });

  it('keeps the TERMINAL moves off the card — a board card is a glance', () => {
    render(<GoalStatusControl goalId="G-1" status="active" variant="card" />);
    expect(screen.queryByTestId('goal-achieved')).toBeNull();
    expect(screen.queryByTestId('goal-kill')).toBeNull();
    expect(screen.queryByTestId('goal-reopen')).toBeNull();
  });

  it('CONTROL: the panel variant carries them', () => {
    render(<GoalStatusControl goalId="G-1" status="active" variant="panel" />);
    expect(screen.getByTestId('goal-achieved')).toBeTruthy();
    expect(screen.getByTestId('goal-kill')).toBeTruthy();
    // Reopen is the terminal-only move, so it is correctly absent here — the
    // control for THAT is the reopen test above, which renders a killed goal.
    expect(screen.queryByTestId('goal-reopen')).toBeNull();
  });

  it('a terminal goal in the panel offers Reopen and nothing else', () => {
    render(<GoalStatusControl goalId="G-1" status="killed" variant="panel" />);
    expect(screen.getByTestId('goal-reopen')).toBeTruthy();
    expect(screen.queryByTestId('goal-achieved')).toBeNull();
    expect(screen.queryByTestId('goal-kill')).toBeNull();
  });
});

describe('GoalStatusControl — the action does not open the card', () => {
  it('stops the click before it reaches the card', async () => {
    const cardClick = vi.fn();
    confirmFn.mockResolvedValue(false);

    render(
      <div onClick={cardClick}>
        <span data-testid="card-body">the card itself</span>
        <GoalStatusControl goalId="G-1" status="active" variant="card" />
      </div>,
    );

    // CONTROL first: the harness genuinely propagates, so the absence below is
    // `stopPropagation` and not a listener that was never wired.
    fireEvent.click(screen.getByTestId('card-body'));
    expect(cardClick).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('goal-pause-resume'));
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect(cardClick).toHaveBeenCalledTimes(1);
  });
});
