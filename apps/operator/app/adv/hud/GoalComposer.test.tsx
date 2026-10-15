// @vitest-environment jsdom
/**
 * EI-20049126246088530 — the composer must hand its caller the SPAWNED AGENT'S
 * ownerId, not just the goal id.
 *
 * THE BUG THIS GUARDS. `goals:start` has always returned the new agent's
 * ownerId (start.ts:353 `agent_owner_id`), and `postGoalStart` has always
 * parsed it into `GoalStartResult.agentOwnerId` — goal-composer-model.test.ts
 * already asserts that. The value was then DROPPED at the last hop:
 * `onStarted(res.goalId)`. With no ownerId the HUD could not seed
 * `pendingLaunch`, so `SessionChatModal`'s `launchedByThisView` was false; and
 * its other leg, `startingEntry`, is null for a goal agent because
 * `listStartingTerminalLaunches` filters `WHERE display = 'terminal'` and the
 * console-spawn path goals use never stamps a display. Both legs false ⇒
 * `startingUp` false ⇒ the owner saw "No recent Claude session found for this
 * agent" for the agent's ENTIRE boot window, while the agent was alive and
 * working. Owner-reported 2026-08-10.
 *
 * WHY IT IS TESTED HERE. The defect was never in the model (covered) nor in the
 * modal (its derivation was correct given its inputs) — it was one dropped
 * argument at the seam between them. So the assertion is on the ARGUMENT the
 * seam forwards. A test that rendered the modal and looked for the banner would
 * be testing the wrong layer and would keep passing if this hop regressed.
 *
 * ON VACUITY, which is a live hazard in this file. `validateGoalDraft` runs for
 * REAL — it is not mocked — and when it fails, `postGoalStart` is never called,
 * the submit no-ops, and every assertion below would pass against a component
 * that forwards nothing. The fixtures therefore fill every field it can reject
 * on, and the first test asserts `postGoalStart` was actually REACHED. That
 * reached-assertion is the load-bearing part: it holds no matter which field
 * the validator starts rejecting later.
 *
 * ⚠ CORRECTION 2026-08-10 (su-0d1fb) — an earlier revision of this comment said
 * the hazard was a kill criterion shorter than KILL_CRITERION_MIN_CHARS (12)
 * being "REJECTED before postGoalStart". THAT IS FALSE, and it is worth stating
 * out loud rather than quietly deleting, because the false version is the more
 * plausible-sounding one. `validateGoalDraft` (goal-composer-model.ts:83)
 * rejects ONLY an empty `title` and an unparseable `ceiling`; it applies NO rule
 * whatsoever to `killCriterion` — `grep 'errors.killCriterion'` in that module
 * returns nothing, even though GoalComposer.tsx:162 renders that error slot.
 * The shared rule (`killCriterionProblem`, operator-core/lib/goals/kill-criterion.ts)
 * has exactly TWO callers, `goals:propose` and `goals:update`, and this composer
 * is not one of them. So a 3-char criterion sails through this path to the
 * server. The 3-char trap that red-pinned goals/update.test.ts on 2026-08-10 was
 * real, but it fired in the `goals:update` HANDLER, not in this validator.
 * Tracked as EI-20049757392342975.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const postGoalStart = vi.fn();

vi.mock('./goal-composer-model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./goal-composer-model')>()),
  postGoalStart: (...args: unknown[]) => postGoalStart(...args),
}));

const GoalComposer = (await import('./GoalComposer')).default;

/**
 * A realistic criterion. NOTE it is not load-bearing for validation — this path
 * applies no length rule (see the CORRECTION above); it is realistic so the
 * fixture reads like a real submission.
 */
const KILL = 'no paying user by day 30';

function fillAndSubmit() {
  fireEvent.change(screen.getByTestId('goal-composer-title'), {
    target: { value: 'Ship a paid app' },
  });
  fireEvent.change(screen.getByTestId('goal-composer-kill'), { target: { value: KILL } });
  fireEvent.change(screen.getByTestId('goal-composer-ceiling'), { target: { value: '500' } });
  fireEvent.click(screen.getByTestId('goal-composer-submit'));
}

function mount(onStarted: (goalId: string, agentOwnerId: string | null) => void) {
  return render(
    <GoalComposer
      open
      workspaceId="papercusp-workspace"
      harnessSlug="papercusp"
      onClose={() => {}}
      onStarted={onStarted}
    />,
  );
}

describe('EI-20049126246088530 — GoalComposer forwards the spawned agent ownerId', () => {
  beforeEach(() => {
    postGoalStart.mockReset();
  });

  // Explicit: this project's vitest setup does not register testing-library's
  // auto-cleanup, so without this each render STACKS in the document and every
  // getByTestId after the first test fails with "Found multiple elements".
  afterEach(() => {
    cleanup();
  });

  it('passes the agent ownerId through to onStarted, not just the goal id', async () => {
    postGoalStart.mockResolvedValue({
      ok: true,
      goalId: 'ship-a-paid-app-3f9a1c',
      agentOwnerId: 'su-abc-123',
    });
    const onStarted = vi.fn();
    mount(onStarted);

    fillAndSubmit();

    // Proves the submit actually got past validation — without this the
    // assertion below could pass against a form that never submitted.
    await waitFor(() => expect(postGoalStart).toHaveBeenCalledTimes(1));

    // THE REGRESSION: `onStarted(res.goalId)` alone leaves arg 2 undefined.
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith('ship-a-paid-app-3f9a1c', 'su-abc-123'));
  });

  it('forwards a null ownerId as null rather than dropping the argument', async () => {
    // The control for the test above: it shows the second argument genuinely
    // VARIES with the response, so the assertion there is discriminating rather
    // than matching a constant. It also pins the contract the caller relies on —
    // HudView only seeds pendingLaunch `if (agentOwnerId)`, so an absent id must
    // arrive as a falsy value, never as a missing parameter.
    postGoalStart.mockResolvedValue({
      ok: true,
      goalId: 'ship-a-paid-app-3f9a1c',
      agentOwnerId: null,
    });
    const onStarted = vi.fn();
    mount(onStarted);

    fillAndSubmit();

    await waitFor(() => expect(postGoalStart).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith('ship-a-paid-app-3f9a1c', null));
  });

  it('does not call onStarted at all when the start fails', async () => {
    postGoalStart.mockResolvedValue({ ok: false, error: 'spawn failed and rolled back' });
    const onStarted = vi.fn();
    mount(onStarted);

    fillAndSubmit();

    await waitFor(() => expect(postGoalStart).toHaveBeenCalledTimes(1));
    // Paired with the positive cases above, so this absence means something:
    // those prove onStarted CAN fire from this fixture.
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('reuses the same request key after a failed response when the validated draft is unchanged', async () => {
    postGoalStart
      .mockResolvedValueOnce({ ok: false, error: 'operator timeout' })
      .mockResolvedValueOnce({ ok: true, goalId: 'g-1', agentOwnerId: 'su-g1' });
    mount(vi.fn());

    fillAndSubmit();
    await waitFor(() => expect(postGoalStart).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((screen.getByTestId('goal-composer-submit') as HTMLButtonElement).disabled).toBe(false),
    );

    fillAndSubmit();
    await waitFor(() => expect(postGoalStart).toHaveBeenCalledTimes(2));

    const first = postGoalStart.mock.calls[0]?.[1] as { requestKey?: string };
    const retry = postGoalStart.mock.calls[1]?.[1] as { requestKey?: string };
    expect(first.requestKey).toBeTruthy();
    expect(retry.requestKey).toBe(first.requestKey);
  });

  it('rotates the request key after the normalized draft changes', async () => {
    postGoalStart
      .mockResolvedValueOnce({ ok: false, error: 'operator timeout' })
      .mockResolvedValueOnce({ ok: false, error: 'operator timeout' });
    mount(vi.fn());

    fillAndSubmit();
    await waitFor(() => expect(postGoalStart).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((screen.getByTestId('goal-composer-submit') as HTMLButtonElement).disabled).toBe(false),
    );

    fireEvent.change(screen.getByTestId('goal-composer-title'), { target: { value: 'Ship a different app' } });
    fireEvent.click(screen.getByTestId('goal-composer-submit'));
    await waitFor(() => expect(postGoalStart).toHaveBeenCalledTimes(2));

    const first = postGoalStart.mock.calls[0]?.[1] as { requestKey?: string };
    const changed = postGoalStart.mock.calls[1]?.[1] as { requestKey?: string };
    expect(changed.requestKey).not.toBe(first.requestKey);
  });
});
