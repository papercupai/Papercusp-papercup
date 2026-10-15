// @vitest-environment jsdom
/**
 * GoalDetailPanel render coverage (goal-mode-2026-08-07 P-021).
 *
 * The arithmetic is covered exhaustively in goal-detail-model.test.ts. What
 * only a DOM can prove — and what this suite therefore pins — are the four
 * claims the surface makes that a passing model test would not catch:
 *
 *   1. A KILLED pot is still on the page. This is the one the item calls
 *      out: dropping it is a one-word change (`.filter(p => !p.removed)`) that
 *      every model test still passes, and the page then only ever shows growth.
 *   2. An unmeasured tripwire does not render as a filled bar.
 *   3. The panel asks for the workspace it was GIVEN — a `'default'` fallback
 *      here renders a healthy-looking page pointed at the wrong tenant.
 *   4. A free-text criterion with no tripwires renders prose and no chart
 *      furniture — the normal case, and the one most likely to regress into an
 *      empty-state placeholder that implies something is missing.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
import { readTypedPropertyCollection, type TypedPropertySchemaDocument } from '@papercusp/operator-core/lib/typed-properties';
import type { GoalDetailInput } from './goal-detail-model';

/* P-023: the popup's two expand buttons reach the DESKTOP shell for full
   SCREEN. Mocked to spies so this suite asserts the panel's BRANCH (which
   mechanism it reaches for) — the module's own ownership/soft-fail contract is
   covered by desktop-window-fullscreen.test.ts, and the real one dynamically
   imports @tauri-apps, which jsdom cannot resolve. */
const desktopFs = vi.hoisted(() => ({
  isDesktopShell: vi.fn(() => false),
  enterDesktopWindowFullscreen: vi.fn(async () => ({ active: true, owned: true })),
  exitDesktopWindowFullscreen: vi.fn(async () => {}),
}));
vi.mock('@/lib/desktop-window-fullscreen', () => desktopFs);

const syncCalls: Array<{ queryName: string; args?: Record<string, unknown>; enabled?: boolean }> = [];
let syncResult: { data: unknown[] | null; loading: boolean; error: unknown } = {
  data: null,
  loading: false,
  error: null,
};

/* P-018 put the rail's open-state in the URL (`hudgoalrail`), which is the
   repo's rule for anything user-meaningful — so the panel now needs nuqs. Same
   local stand-in the other component suites use (OperatorChatSidebar,
   PlansPane): a real adapter would drag the router in for a param whose only
   job here is to flip a boolean. */
vi.mock('nuqs', async () => {
  const React = await import('react');
  /* The parsers come from the SHARED mock (`@papercusp/test-config/nuqs-mock`),
     which carries every parser nuqs exports and is itself pinned against the
     installed package — the fix for EI-8821's whole class.

     This file used to hand-roll them, with a comment predicting exactly how
     that fails: "the failure mode of this mock is that it silently lags the
     component's parser vocabulary, and the next parser added would otherwise
     break it the same way again". It then did, twice — `parseAsStringEnum` when
     P-009 landed, and `parseAsStringLiteral` when P-023 gave this popup the
     sessions popup's maximize hook. Spreading the shared set ends the sequence.

     `useQueryState` stays LOCAL: these tests need a real React state store so a
     toggle click re-renders, where the shared factory's store lives outside
     React and would leave the panel showing the pre-click value. */
  return {
    ...nuqsParsers,
    useQueryState(_key: string, p?: { defaultValue?: unknown }) {
      /* Explicit <unknown>: inferring from `p?.defaultValue ?? null` widens the
         state to `{} | null`, and the setter below then rejects the `unknown`
         it is handed (TS2345). Invisible to vitest, which does not typecheck —
         it reds `lint:tsc:operator` instead. */
      const [value, setValue] = React.useState<unknown>(p?.defaultValue ?? null);
      const set = React.useCallback((next: unknown) => {
        setValue(typeof next === 'function' ? (next as (prev: unknown) => unknown)(value) : next);
        return Promise.resolve(new URLSearchParams());
      }, [value]);
      return [value, set];
    },
  };
});

/* P-021 added a SECOND query to this panel (`advRoster.list`, feeding the
   borrowed Activity and Fleet rails). The mock therefore answers PER QUERY
   NAME: a single shared `syncResult` would hand the goal-detail payload to the
   roster reader too, which is not merely untidy — it would make the fleet rail
   assertions untestable, because a payload with no `active[]` derives a null
   fleet model no matter what the component does. */
let rosterResult: { data: unknown[] | null; loading: boolean; error: unknown } = {
  data: null,
  loading: false,
  error: null,
};
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: { queryName: string; args?: Record<string, unknown>; enabled?: boolean }) => {
    syncCalls.push(opts);
    const result = opts.queryName === 'advRoster.list' ? rosterResult : syncResult;
    return { ...result, fetching: false, invalidate: vi.fn() };
  },
}));

/* D-011: the popup now EMBEDS the agent conversation. These two mocks stand in
   for its network half and its renderer, so the assertions below are about what
   this panel is responsible for — mounting the right thing, with the right
   props, in each state — rather than about SSE.

   ⚠ Mocking the hook is what makes these tests DISCRIMINATING. Without it, the
   unmocked `fetch` in jsdom means the session never resolves, so "no composer
   renders" is true no matter what this component does — which is exactly how
   the retracted D-011's `offers no composer` assertion kept passing after the
   composer was added. A test that cannot fail is not evidence. */
let chatState: Record<string, unknown> = {};
const chatSends: string[] = [];
vi.mock('@/app/_components/chat/use-owner-session-chat', () => ({
  useOwnerSessionChat: (ownerId: string | null) => ({
    streamUrl: null,
    resolved: null,
    resolving: false,
    resolveError: null,
    send: (t: string) => chatSends.push(t),
    sending: false,
    sendError: null,
    sentOk: null,
    // The per-test override wins, but only when there IS an agent — passing a
    // null ownerId must stay inert regardless of what a test asked for.
    ...(ownerId ? chatState : {}),
  }),
}));
vi.mock('@/app/_components/chat/SessionChatModal', () => ({
  LiveSessionChat: (p: { streamUrl: string; sessionOwnerId: string; onSend: (t: string) => void }) => (
    <div data-testid="live-chat" data-owner={p.sessionOwnerId} data-stream={p.streamUrl}>
      <textarea aria-label="Message" />
      <button type="button" onClick={() => p.onSend('hello')}>
        Send
      </button>
    </div>
  ),
}));

// The Radix dialog renders into a portal; the assertions below read
// document.body, so no shim is needed — but jsdom lacks the pointer-capture
// APIs Radix probes on mount.
beforeEach(() => {
  syncCalls.length = 0;
  syncResult = { data: null, loading: false, error: null };
  rosterResult = { data: null, loading: false, error: null };
  // Default: no session resolved, so a test that does not opt in gets the
  // inert-chat baseline rather than another test's leftover state.
  chatState = {};
  chatSends.length = 0;
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
});
afterEach(cleanup);

// eslint-disable-next-line import/first
import GoalDetailPanel from './GoalDetailPanel';

const NOW = Date.parse('2026-08-09T12:00:00.000Z');

function detail(over: Partial<GoalDetailInput> = {}): GoalDetailInput {
  return {
    goal: {
      id: 'goal-1',
      title: 'Ship a paid app',
      status: 'active',
      killCriterion: 'Stop if no paying user by day 30.',
      spendUsd: 310,
      // The ceiling reads the enforced snapshot, not the lifetime figure (WI-1074208).
      spentCents: 31_000,
      budgetCents: 50_000,
      ...over.goal,
    },
    pots: [],
    waitingOnYou: [],
    activity: [],
    spendByDay: [],
    spendLabel: 'fleet spend',
    spendNote: 'Goal spend figures do not sum.',
    goalModeState: {
      schemaVersion: 'agent-goal-mode-state-v1',
      status: 'known',
      ownerId: 'su-goal',
      observedAt: '2026-08-09T12:00:00.000Z',
      portfolio: {
        goal: { id: 'goal-1', title: 'Ship a paid app', status: 'active' },
        queue: { total: 0, inFlight: 0, blocked: 0, needsHuman: 0, claimable: 0 },
        priorities: [],
      },
      obligations: {
        sourceGeneration: 'agenda-clean',
        projection: {
          entries: [],
          receipt: {
            sink: 'turn-start',
            entriesAvailable: 0,
            entriesDelivered: 0,
            entriesOmitted: 0,
            bodyTruncated: false,
            refused: false,
          },
        },
        detailRef: 'coord:orient for the complete obligation agenda',
      },
      degradedReasons: [],
    },
    ...over,
  };
}

function renderPanel(data: GoalDetailInput | null, props: Record<string, unknown> = {}) {
  syncResult = { data: data ? [data] : null, loading: false, error: null };
  return render(
    <GoalDetailPanel
      goalId="goal-1"
      workspaceId="ws-real"
      nowMs={NOW}
      onClose={() => {}}
      {...props}
    />,
  );
}

/** The visibility rows live in a Radix popover rather than permanently
 * occupying the toolbar. Open it only when a test needs to act on panel state;
 * leave it open when already expanded so multi-toggle tests exercise the real
 * keep-open interaction instead of accidentally closing the chooser. */
function openPanelsMenu() {
  const trigger = screen.getByTestId('goal-panels-trigger');
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  return screen.getByRole('dialog', { name: 'Panel visibility' });
}

describe('GoalDetailPanel', () => {
  it.each(['plans', 'tea'] as const)('edits an arbitrary %s declaration through the generic panel and preserves refused choices', async (kind) => {
    const property = kind === 'plans' ? 'worklist' : 'tea_choices';
    const policyName = kind === 'plans' ? 'worklist_policy' : 'tea_policy';
    const ids = kind === 'plans' ? ['plan:alpha/first', 'plan:beta/second'] : ['mint', 'chamomile'];
    // Typed so its enum fields (editable_by, collection.source/order) keep their
    // literal types; an un-annotated literal widens them to string, which tsc rejects.
    const schema: TypedPropertySchemaDocument = {
      [property]: { datatype: kind === 'plans' ? 'plan-ref-list' : 'string-list', editable_by: 'both',
        collection: { source: kind === 'plans' ? 'active-workspace-plans' : 'manual', policy: policyName,
          order: kind === 'plans' ? 'priority' : 'display', selectable: true, defaultSelected: true } },
      [policyName]: { datatype: 'ordered-selection-policy', editable_by: 'owner', default: { order: [], excluded: [] } },
    };
    let policy = { order: [...ids], excluded: [] as string[] };
    let version = 4;
    let refused = false;
    const writes = vi.fn(async (_url: string, options: RequestInit) => {
      const posted = JSON.parse(options.body as string);
      expect(posted).toMatchObject({ goalId: 'goal-1', property: policyName, expectedVersion: version });
      expect(posted).not.toHaveProperty('provenance');
      if (refused) return { ok: false, json: async () => ({ error: 'stale', actualVersion: version + 1 }) };
      policy = posted.value;
      version++;
      return { ok: true, json: async () => ({ ok: true, version }) };
    });
    vi.stubGlobal('fetch', writes);
    const snapshot = () => {
      const selection = readTypedPropertyCollection({ propertySchema: schema, property,
        properties: {
          [property]: { value: ids, version: 2, edited_by: 'agent', provenance: 'agent-edit', edited_at: '2026-10-01T00:00:00Z' },
          [policyName]: { value: policy, version, edited_by: 'owner', provenance: 'owner-edit', edited_at: '2026-10-01T00:00:00Z' },
        }, ...(kind === 'plans' ? { source: { ok: true as const, items: ids } } : {}) });
      if (!selection.ok || !selection.configured) throw new Error('Invalid collection fixture');
      const base = detail();
      return { ...base, goal: { ...base.goal!, goalPackage: { ref: 'arbitrary-collection' } },
        goalData: { propertySchema: schema, collections: { [property]: { selection,
          rows: selection.items.map((row) => ({ ...row, label: row.id, state: 'ready', reason: null })) } } } };
    };
    try {
      const view = renderPanel(snapshot());
      expect(screen.queryByTestId('work-on-everything-console')).toBeNull();
      const editor = within(screen.getByTestId('goal-data'));
      fireEvent.click(editor.getByRole('button', { name: `Move ${ids[1]} up` }));
      await waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
      expect(policy.order).toEqual([ids[1], ids[0]]);
      expect(editor.getAllByRole('listitem')[0].textContent).toContain(ids[0]);
      syncResult = { data: [snapshot()], loading: false, error: null };
      view.rerender(<GoalDetailPanel goalId="goal-1" workspaceId="ws-real" nowMs={NOW} onClose={() => {}} />);
      await waitFor(() => expect(editor.getByRole('checkbox', { name: `Include ${ids[0]}` })).toHaveProperty('disabled', false));
      expect(editor.getAllByRole('listitem')[0].textContent).toContain(ids[1]);
      fireEvent.click(editor.getByRole('checkbox', { name: `Include ${ids[0]}` }));
      await waitFor(() => expect(writes).toHaveBeenCalledTimes(2));
      expect(policy.excluded).toEqual([ids[0]]);
      syncResult = { data: [snapshot()], loading: false, error: null };
      view.rerender(<GoalDetailPanel goalId="goal-1" workspaceId="ws-real" nowMs={NOW} onClose={() => {}} />);
      await waitFor(() => expect(editor.getByRole('checkbox', { name: `Include ${ids[0]}` })).toHaveProperty('disabled', false));
      expect(editor.getByRole('checkbox', { name: `Include ${ids[0]}` }).getAttribute('aria-checked')).toBe('false');
      refused = true;
      fireEvent.click(editor.getByRole('checkbox', { name: `Include ${ids[0]}` }));
      await waitFor(() => expect(editor.getByRole('alert').textContent).toContain('stale'));
      expect(policy.excluded).toEqual([ids[0]]);
      expect(editor.getByRole('checkbox', { name: `Include ${ids[0]}` }).getAttribute('aria-checked')).toBe('false');
    } finally { vi.unstubAllGlobals(); }
  });

  it('opens the progress console for the legacy typed worklist without package-install metadata', () => {
    const base = detail();
    renderPanel({ ...base, goal: { ...base.goal!, status: 'paused', goalPackage: null }, goalData: {
      propertySchema: { worklist: { datatype: 'plan-ref-list', editable_by: 'both', collection: {
        source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority',
        selectable: true, defaultSelected: false } } }, collections: {}, error: 'Plan source unavailable.',
    } });
    expect(screen.getByTestId('work-on-everything-console')).toBeTruthy();
    // Recognition survives a degraded collection read, so the dedicated retry
    // state appears instead of silently reverting to the generic goal detail.
    expect(screen.getByRole('alert').textContent).toContain('Goal data could not be read');
    expect(screen.queryByTestId('goal-ends-section')).toBeNull();
  });
  it('opens the dedicated 02C destination only for the declared Work on Everything package', () => {
    const base = detail();
    renderPanel({ ...base, goal: { ...base.goal!, title: 'Renamed ongoing goal',
      goalPackage: { ref: 'work-on-everything' } } });
    expect(screen.getByTestId('work-on-everything-console')).toBeTruthy();
    // Never blank: a goal reply without its data section names that reason and offers Retry.
    const problem = screen.getByRole('alert');
    expect(within(problem).getByRole('heading', { name: 'Goal data did not load' })).toBeTruthy();
    expect(within(problem).getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByTestId('goal-ends-section')).toBeNull();
  });
  it('shows the ongoing work overview first for standing goals and opens actual completed work', () => {
    const base = detail();
    const onOpenWorkItem = vi.fn();
    const onOpenPlan = vi.fn();
    renderPanel({ ...base, goal: { ...base.goal!, standing: true },
      activity: [{ id: 'WI-outcome', title: 'Verified release repair', status: 'done', closedAt: '2026-08-10T12:00:00Z' }],
      goalModeState: { portfolio: { priorities: ['Reconcile the release plan', 'Place the next item'] } },
      plans: [{ planSlug: 'release', harnessSlug: 'alpha', title: 'Release plan', openItems: 3, stamped: true }],
      waitingOnYouTotal: 31 }, { onOpenWorkItem, onOpenPlan });
    const overview = screen.getByTestId('ongoing-work-overview');
    const ends = screen.getByTestId('goal-ends-section');
    expect(overview.compareDocumentPosition(ends) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(overview).getByRole('heading', { name: 'Where work is moving' })).toBeTruthy();
    expect(overview.textContent).toContain('Where work is moving');
    expect(overview.textContent).toContain('Reconcile the release plan');
    expect(overview.textContent).toContain('31 waiting on you');
    fireEvent.click(within(overview).getByRole('button', { name: 'Verified release repair' }));
    expect(onOpenWorkItem).toHaveBeenCalledWith('WI-outcome');
    fireEvent.click(within(overview).getByRole('button', { name: 'Release plan' }));
    expect(onOpenPlan).toHaveBeenCalledWith('alpha', 'release');
  });

  it('keeps ordinary goals on their existing detail without an ongoing overview', () => {
    renderPanel(detail());
    expect(screen.queryByTestId('ongoing-work-overview')).toBeNull();
    expect(screen.getByText('This goal ends when')).toBeTruthy();
  });

  it('opens a standing mobile goal with the overview unobscured and keeps the Work drawer selectable', () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: true, media: query,
      addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    try {
      const base = detail();
      renderPanel({ ...base, goal: { ...base.goal!, standing: true } });
      expect(screen.getByTestId('ongoing-work-overview')).toBeTruthy();
      expect(screen.queryByTestId('goal-work-rail')).toBeNull();
      const menu = openPanelsMenu();
      fireEvent.click(within(menu).getByRole('checkbox', { name: 'Work' }));
      expect(screen.getByTestId('goal-work-rail')).toBeTruthy();
      cleanup();
      // Control: the change does not alter an ordinary mobile goal's default.
      renderPanel(detail());
      expect(screen.getByTestId('goal-work-rail')).toBeTruthy();
    } finally {
      cleanup();
      vi.unstubAllGlobals();
    }
  });
  it('renders nothing and fires no query while closed', () => {
    render(<GoalDetailPanel goalId={null} workspaceId="ws-real" nowMs={NOW} onClose={() => {}} />);
    expect(document.body.textContent).not.toContain('This goal ends when');
    expect(syncCalls[0]?.enabled).toBe(false);
  });

  it('asks goals.detail for the workspace it was GIVEN, never a default', () => {
    // A silent 'default' here returns a real-looking empty page for the wrong
    // tenant — the failure mode that is hardest to see, because "no goals yet"
    // is a state this surface legitimately shows (the WI-5125 shape).
    renderPanel(detail());
    const call = syncCalls.find((c) => c.queryName === 'goals.detail');
    expect(call).toBeTruthy();
    expect(call?.args).toMatchObject({ workspaceId: 'ws-real', goalId: 'goal-1' });
    expect(call?.enabled).toBe(true);
  });

  it('leads with the kill criterion, verbatim', () => {
    renderPanel(detail());
    expect(screen.getByTestId('goal-kill-criterion').textContent).toBe(
      'Stop if no paying user by day 30.',
    );
  });

  it('places the goal agent’s shared obligation projection in the existing brief zone', () => {
    renderPanel(
      detail({
        goalModeState: {
          status: 'known',
          ownerId: 'su-goal',
          observedAt: '2026-08-09T12:00:00.000Z',
          portfolio: { goal: { id: 'goal-1', title: 'Ship a paid app', status: 'active' } },
          obligations: {
            sourceGeneration: 'agenda-17',
            projection: {
              entries: [
                {
                  id: 'obligation-1',
                  title: 'Report to Avi',
                  status: 'due',
                  applicableDemand: 1,
                  sourceGeneration: 'report-4',
                  action: { summary: 'Send the evidence-backed report' },
                },
              ],
              receipt: { entriesAvailable: 1, entriesDelivered: 1, entriesOmitted: 0 },
            },
            detailRef: 'coord:orient for the complete obligation agenda',
          },
        },
      }),
    );

    const brief = screen.getByTestId('goal-brief-rail');
    expect(brief.contains(screen.getByTestId('goal-mode-state'))).toBe(true);
    expect(screen.getByTestId('goal-mode-primary-action').textContent).toContain(
      'Send the evidence-backed report',
    );
    expect(screen.getByTestId('goal-mode-provenance').textContent).toContain('agenda agenda-17');
  });

  it('surfaces an absent goal-mode payload as unknown rather than hiding the section', () => {
    renderPanel(detail({ goalModeState: null }));
    expect(screen.getByTestId('goal-mode-state').getAttribute('data-status')).toBe('unknown');
    expect(screen.getByTestId('goal-mode-unknown').textContent).toContain('not included');
    expect(screen.queryByTestId('goal-mode-no-demand')).toBeNull();
  });

  it('shouts when NO kill criterion is set', () => {
    renderPanel(detail({ goal: { id: 'goal-1', title: 'g', status: 'active', killCriterion: null } }));
    const el = screen.getByTestId('goal-kill-criterion');
    expect(el.textContent).toMatch(/nothing can stop this goal/i);
    expect(el.className).toContain('hud-goal__criterion--missing');
  });

  it('renders a free-text criterion with NO tripwire furniture', () => {
    // Tripwires are optional; the no-bars case must look finished, not empty.
    renderPanel(detail());
    expect(screen.queryByTestId('goal-tripwires')).toBeNull();
    expect(screen.getByTestId('goal-kill-criterion')).toBeTruthy();
  });

  it('renders tripwire bars, and does NOT fill an unmeasured one', () => {
    renderPanel(
      detail({
        goal: {
          id: 'goal-1',
          title: 'g',
          status: 'active',
          killCriterion: 'stop at 30 days or $500',
          tripwires: [
            { metric: 'elapsed', label: 'Elapsed', threshold: 30, current: 12, unit: 'days' },
            { metric: 'spend', label: 'Spend', threshold: 500, current: 310, unit: 'usd' },
            { metric: 'builds', label: 'Shipped builds', threshold: 1 },
          ],
        },
      }),
    );
    const bars = screen.getByTestId('goal-tripwires');
    expect(bars.textContent).toContain('day 12 of 30');
    expect(bars.textContent).toContain('$310 of $500');
    expect(bars.textContent).toContain('not measured yet');

    // Three bars, but only TWO fills: the unread one must be visually distinct
    // from a real zero rather than a zero-width fill nobody can tell apart.
    expect(bars.querySelectorAll('.hud-goal__bar-fill')).toHaveLength(2);
    expect(bars.querySelectorAll('.hud-goal__bar-unread')).toHaveLength(1);

    // The same distinction, machine-readable. Styling can be restyled away;
    // this is the hook that survives it.
    expect(bars.querySelectorAll('[data-measured="true"]')).toHaveLength(2);
    expect(bars.querySelectorAll('[data-measured="false"]')).toHaveLength(1);
  });

  it('marks an UNMEASURED tripwire apart from one measured at zero, in the DOM', () => {
    // P-002's core claim: "0 of 30" for a tripwire nobody wired up is
    // indistinguishable from a real zero — and a real zero is the most
    // REASSURING reading available, so the failure points at "nothing to worry
    // about". Text alone is not enough to guard that: both bars render prose,
    // and a future copy change could quietly collapse them back together. This
    // asserts the distinction survives in a form automation can read.
    renderPanel(
      detail({
        goal: {
          id: 'goal-1',
          title: 'g',
          status: 'active',
          killCriterion: 'stop at 30 days or $500',
          tripwires: [
            // Nobody has wired this up.
            { metric: 'unwired', label: 'Unwired', threshold: 30, unit: 'days' },
            // Genuinely measured, and the reading happens to be zero.
            { metric: 'real-zero', label: 'Real zero', threshold: 30, current: 0, unit: 'days' },
          ],
        },
      }),
    );
    const bars = screen.getByTestId('goal-tripwires');
    const [unwired, realZero] = Array.from(bars.querySelectorAll('.hud-goal__bar'));

    expect(unwired.getAttribute('data-measured')).toBe('false');
    expect(realZero.getAttribute('data-measured')).toBe('true');

    // …and they must not read the same to a human either.
    expect(unwired.textContent).toContain('not measured yet');
    expect(realZero.textContent).toContain('day 0 of 30');
  });

  it('KEEPS a closed pot on the page, with its reason', () => {
    // The invariant the item singles out. A `.filter(p => !p.removed)` in the
    // component would leave every model test green and delete the only
    // evidence that the agent closes things.
    renderPanel(
      detail({
        pots: [
          { harnessSlug: 'alpha', role: 'owner', killCriterion: 'ship by day 14', servesGoals: 1 },
          {
            harnessSlug: 'beta',
            role: 'contributing',
            killCriterion: 'ship by day 14',
            servesGoals: 1,
            removedAt: '2026-08-05T00:00:00Z',
            note: 'no traction after two weeks',
          },
        ],
      }),
    );
    expect(screen.getByTestId('goal-pots').textContent).toContain('alpha');

    const closed = screen.getByTestId('goal-pots-closed');
    expect(closed.textContent).toContain('beta');
    expect(closed.textContent).toContain('no traction after two weeks');
    expect(closed.querySelector('.hud-goal__proj--removed')).toBeTruthy();
  });

  it('shows each pot its OWN kill criterion and the shared badge', () => {
    renderPanel(
      detail({
        pots: [
          { harnessSlug: 'alpha', role: 'owner', killCriterion: 'ship by day 14', servesGoals: 3 },
          { harnessSlug: 'gamma', role: 'contributing', servesGoals: 1 },
        ],
      }),
    );
    const grid = screen.getByTestId('goal-pots');
    expect(grid.textContent).toContain('ship by day 14');
    expect(grid.textContent).toContain('shared with 2 other goals');
    // Clause 4 requires one per pot — its absence is surfaced, not hidden.
    expect(grid.textContent).toContain('No kill criterion for this pot');
  });

  it('lists waiting-on-you above activity and opens an item', () => {
    const onOpenWorkItem = vi.fn();
    renderPanel(
      detail({
        waitingOnYou: [
          { id: 'WI-1', title: 'Approve the pricing page', harnessSlug: 'alpha', updatedAt: '2026-08-09T08:00:00Z' },
        ],
        activity: [
          { id: 'WI-2', title: 'Built the checkout', harnessSlug: 'alpha', closedAt: '2026-08-09T09:00:00Z' },
        ],
      }),
      { onOpenWorkItem },
    );
    const body = document.body.textContent ?? '';
    expect(body.indexOf('Waiting on you')).toBeLessThan(body.indexOf('Activity'));

    fireEvent.click(screen.getByRole('button', { name: 'Approve the pricing page' }));
    expect(onOpenWorkItem).toHaveBeenCalledWith('WI-1');
  });

  it('carries the do-not-sum caveat next to the spend chart', () => {
    // D-021: a shared pot counts in full against every goal it serves, so
    // these figures do not add up. This is the section most likely to be
    // screenshotted, so the caveat travels with it.
    renderPanel(
      detail({
        spendByDay: [
          { day: '2026-08-01', harnessSlug: 'alpha', costUsd: 3 },
          { day: '2026-08-02', harnessSlug: 'alpha', costUsd: 8 },
        ],
      }),
    );
    expect(screen.getByTestId('goal-spend-chart').querySelectorAll('.hud-goal__col')).toHaveLength(2);
    expect(document.body.textContent).toContain('Goal spend figures do not sum.');
  });

  it('says a goal is gone rather than rendering an empty shell', () => {
    syncResult = { data: [{ goal: null }], loading: false, error: null };
    render(<GoalDetailPanel goalId="goal-1" workspaceId="ws-real" nowMs={NOW} onClose={() => {}} />);
    expect(document.body.textContent).toContain('no longer exists');
  });

  it('surfaces a load error instead of an empty page', () => {
    syncResult = { data: null, loading: false, error: new Error('boom') };
    render(<GoalDetailPanel goalId="goal-1" workspaceId="ws-real" nowMs={NOW} onClose={() => {}} />);
    expect(document.body.textContent).toContain('Could not load this goal');
  });

  /* ── P-018: the SessionChatModal frame ──────────────────────────────────
     What only a DOM can prove here is STRUCTURE, not content: the vitals band
     and the rail have to sit OUTSIDE the scrolling body, or they scroll away
     with it and the "glance" the band exists to provide is gone exactly when
     the reader has scrolled down to look for detail. */
  it('puts the vitals band OUTSIDE the scrolling body, not inside it', () => {
    renderPanel(detail());
    const vitals = screen.getByTestId('goal-vitals');
    const body = screen.getByTestId('goal-detail');
    expect(vitals).toBeTruthy();
    // The bug this pins is a one-line nesting slip that looks identical on a
    // short goal and breaks completely on a long one.
    expect(body.contains(vitals)).toBe(false);
    expect(screen.getByTestId('goal-detail-modal').contains(vitals)).toBe(true);
  });

  it('leads the band with status, the stopping condition and spend-vs-ceiling', () => {
    renderPanel(detail());
    const vitals = screen.getByTestId('goal-vitals');
    expect(vitals.textContent).toContain('active');
    expect(vitals.textContent).toContain('Stop if no paying user by day 30.');
    expect(vitals.textContent).toContain('$310');
  });

  it('renders the status ONCE — the band owns it, the header no longer repeats it', () => {
    renderPanel(detail({ goal: { status: 'paused' } as never }));
    // Two copies of one status is how a stale one goes unnoticed. Asserted as
    // "the band has it, the title row does not" rather than by counting DOM
    // nodes, which is what the status word is actually claimed to be.
    expect(screen.getByTestId('goal-vitals').textContent).toContain('paused');
    const titleRow = document.body.querySelector('.hud-goal__title-row') as HTMLElement;
    expect(titleRow).toBeTruthy();
    expect(titleRow.textContent).not.toContain('paused');
  });

  /* ── D-011 (the RETRACTION): the popup EMBEDS the conversation ─────────────
     These replace an `offers no composer` test that encoded the retracted
     ruling. Note it kept PASSING after the composer was added, because jsdom
     never resolved a session — so it was asserting an absence produced by the
     test environment rather than by the design. */

  it('EMBEDS the live conversation for the goal’s agent, reusing LiveSessionChat', () => {
    chatState = { resolved: { session_id: 's1', source_kind: 'claude' }, streamUrl: '/api/adv/session/thinking?x=1' };
    renderPanel(detail({ agents: [{ ownerId: 'su-abc', setAt: null, setBy: 'operator-ui' }] }), {
      onOpenAgent: () => {},
    });
    const chat = screen.getByTestId('live-chat');
    // Wired to THIS goal's agent and THIS stream — not merely present.
    expect(chat.getAttribute('data-owner')).toBe('su-abc');
    expect(chat.getAttribute('data-stream')).toBe('/api/adv/session/thinking?x=1');
    // The composer the owner reported missing.
    expect(document.body.querySelector('textarea')).not.toBeNull();
  });

  it('sends through the SHARED wiring rather than a second send path', () => {
    chatState = { resolved: { session_id: 's1', source_kind: 'claude' }, streamUrl: '/s' };
    renderPanel(detail({ agents: [{ ownerId: 'su-abc', setAt: null, setBy: 'operator-ui' }] }), {
      onOpenAgent: () => {},
    });
    fireEvent.click(screen.getByText('Send'));
    expect(chatSends).toEqual(['hello']);
  });

  it('renders a plain statement and NO composer when no agent runs the goal', () => {
    // D-011: "a composer that looks live and can reach nobody is worse than
    // none." Unlike the test this replaced, the absence here is caused by the
    // component's own branch — the hook is mocked as resolvable.
    chatState = { resolved: { session_id: 's1', source_kind: 'claude' }, streamUrl: '/s' };
    renderPanel(detail({ agents: [] }), { onOpenAgent: () => {} });
    expect(screen.getByTestId('goal-chat-no-agent')).toBeTruthy();
    expect(screen.queryByTestId('live-chat')).toBeNull();
    expect(document.body.querySelector('textarea')).toBeNull();
  });

  it('says so, without a composer, when the agent has no recent session', () => {
    chatState = { resolved: null, streamUrl: null };
    renderPanel(detail({ agents: [{ ownerId: 'su-abc', setAt: null, setBy: 'operator-ui' }] }), {
      onOpenAgent: () => {},
    });
    expect(screen.getByTestId('goal-chat-no-session')).toBeTruthy();
    expect(document.body.querySelector('textarea')).toBeNull();
  });

  it('surfaces a resolve FAILURE instead of an empty chat that looks idle', () => {
    chatState = { resolveError: 'sessions:list → 500', resolved: null, streamUrl: null };
    renderPanel(detail({ agents: [{ ownerId: 'su-abc', setAt: null, setBy: 'operator-ui' }] }), {
      onOpenAgent: () => {},
    });
    expect(screen.getByTestId('goal-chat-error').textContent).toContain('sessions:list → 500');
  });

  it('routes to the goal’s agent when there IS one, and renders no dead button when there is not', () => {
    const seen: string[] = [];
    const { unmount } = renderPanel(
      detail({ agents: [{ ownerId: 'su-abc', setAt: null, setBy: 'operator-ui' }] }),
      { onOpenAgent: (id: string) => seen.push(id) },
    );
    const openConversation = screen.getByTestId('goal-open-agent');
    // Icon-only in the compact band: the accessible action survives while the
    // visible "Open full-size" label no longer competes with panel controls.
    expect(openConversation.textContent).toBe('');
    expect(openConversation.querySelector('svg')).toBeTruthy();
    expect(openConversation.getAttribute('aria-label')).toBe('Open conversation full-size');
    fireEvent.click(openConversation);
    expect(seen).toEqual(['su-abc']);
    unmount();
    cleanup();

    // No agent stamped on the goal ⇒ the control is ABSENT, not present-and-inert.
    renderPanel(detail({ agents: [] }), { onOpenAgent: () => {} });
    expect(screen.queryByTestId('goal-open-agent')).toBeNull();
    cleanup();

    // Host cannot route ⇒ also absent. WI-6742's dead-button shape.
    renderPanel(detail({ agents: [{ ownerId: 'su-abc' }] }));
    expect(screen.queryByTestId('goal-open-agent')).toBeNull();
  });

  /* ── P-019: the work rail ──────────────────────────────────────────────── */
  it('seats the rail as a SIBLING of the body so it does not scroll away', () => {
    renderPanel(detail());
    const rail = screen.getByTestId('goal-work-rail');
    expect(screen.getByTestId('goal-detail').contains(rail)).toBe(false);
    expect(screen.getByTestId('goal-detail-modal').contains(rail)).toBe(true);
  });

  it('lists the goal’s plans and work items, showing an overlapping item ONCE', () => {
    renderPanel(
      detail({
        plans: [
          {
            planSlug: 'ship-it',
            harnessSlug: 'papercusp',
            title: 'Ship it',
            items: 4,
            openItems: 2,
            stamped: false,
          },
        ],
        waitingOnYou: [{ id: 'WI-1', title: 'Needs a decision', harnessSlug: 'papercusp' }],
        activity: [
          { id: 'WI-1', title: 'Needs a decision', harnessSlug: 'papercusp', status: 'open' },
          { id: 'WI-2', title: 'In flight', harnessSlug: 'papercusp', status: 'wip' },
        ],
      }),
    );
    const rail = screen.getByTestId('goal-work-rail');
    expect(rail.textContent).toContain('Ship it');
    // The dedupe, asserted where the reader actually sees it: WI-1 arrives in
    // BOTH waitingOnYou and activity, and must render exactly one row.
    const rows = Array.from(rail.querySelectorAll('[data-testid="goal-rail-item"]'));
    expect(rows.filter((r) => r.getAttribute('data-id') === 'WI-1')).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });

  it('rail rows reuse the panel’s EXISTING work-item route, not a second one', () => {
    const opened: string[] = [];
    renderPanel(detail({ activity: [{ id: 'WI-7', title: 'Openable', status: 'wip' }] }), {
      onOpenWorkItem: (id: string) => opened.push(id),
    });
    const row = screen
      .getByTestId('goal-work-rail')
      .querySelector('[data-testid="goal-rail-item"][data-id="WI-7"]') as HTMLElement;
    fireEvent.click(row);
    expect(opened).toEqual(['WI-7']);
  });

  it('says WHY the rail is empty instead of rendering bare headings', () => {
    // D-010: this is the LIVE state of every goal in this workspace today, so
    // it is the state most likely to be seen — not an edge case.
    renderPanel(detail());
    const rail = screen.getByTestId('goal-work-rail');
    expect(screen.getByTestId('goal-rail-empty')).toBeTruthy();
    // Three empty section headings read as a panel that failed to load.
    expect(rail.querySelectorAll('.pc-peers__cap')).toHaveLength(0);
    expect(rail.textContent).toContain('Nothing is under this goal yet');
  });

  it('the toggle actually hides the rail', () => {
    renderPanel(detail());
    expect(screen.queryByTestId('goal-work-rail')).toBeTruthy();
    openPanelsMenu();
    fireEvent.click(screen.getByTestId('goal-rail-toggle'));
    expect(screen.queryByTestId('goal-work-rail')).toBeNull();
  });

  it('does not total the plan rows into a goal-wide figure (D-002/D-021)', () => {
    renderPanel(
      detail({
        plans: [
          { planSlug: 'a', harnessSlug: 'h', title: 'A', items: 3, openItems: 2, stamped: false },
          { planSlug: 'b', harnessSlug: 'h', title: 'B', items: 4, openItems: 3, stamped: false },
        ],
      }),
    );
    const rail = screen.getByTestId('goal-work-rail');
    // 2+3=5 and 3+4=7 must appear nowhere: these figures deliberately do not
    // sum, and a parent/child layout is the one that most tempts a reader to
    // add them. The per-row counts themselves stay visible.
    expect(rail.textContent).toContain('2 open of 3 on this goal');
    expect(rail.textContent).toContain('3 open of 4 on this goal');
    expect(rail.textContent).not.toMatch(/\b5 open\b/);
    expect(rail.textContent).not.toMatch(/\b7 (open|total)\b/);
  });

  it('says a freshly-started plan was STARTED rather than rendering it as "0 open of 0"', () => {
    // The owner-reported bug, at the moment it bites: a goal whose agent has
    // just authored its plan. The derived counts are truthfully zero, and
    // rendering them reads as "the agent did nothing" — in the first minutes of
    // a goal, which is exactly when the owner is watching.
    renderPanel(
      detail({
        plans: [
          { planSlug: 'panda-gallery-v1', harnessSlug: 'h', title: 'Panda gallery', items: 0, openItems: 0, stamped: true },
        ],
      }),
    );
    const rail = screen.getByTestId('goal-work-rail');
    expect(rail.textContent).toContain('started by this goal');
    expect(rail.textContent).not.toContain('0 open of 0 on this goal');
  });

  it('keeps the counts for a stamped plan that HAS produced work', () => {
    // The flag must not swallow a real reading: once work exists, the counts
    // are the more informative answer and stay.
    renderPanel(
      detail({
        plans: [
          { planSlug: 'p', harnessSlug: 'h', title: 'P', items: 4, openItems: 1, stamped: true },
        ],
      }),
    );
    const rail = screen.getByTestId('goal-work-rail');
    expect(rail.textContent).toContain('1 open of 4 on this goal');
    expect(rail.textContent).not.toContain('started by this goal');
  });

  it('leaves an INHERITED plan with no goal items reading as zero, not as started', () => {
    // stamped:false + zero items is a different state — the goal never authored
    // this plan — and must not borrow the reassuring copy.
    renderPanel(
      detail({
        plans: [
          { planSlug: 'inherited', harnessSlug: 'h', title: 'Inherited', items: 0, openItems: 0, stamped: false },
        ],
      }),
    );
    const rail = screen.getByTestId('goal-work-rail');
    expect(rail.textContent).toContain('0 open of 0 on this goal');
    expect(rail.textContent).not.toContain('started by this goal');
  });

  it('closing clears the selection', () => {
    const onClose = vi.fn();
    renderPanel(detail(), { onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  /* ── "Waiting on you" (P-006 / D-018) ──────────────────────────────────────
     The count only the OWNER can clear. Two separate claims are pinned here,
     because they fail independently: that the number is HONEST (the resolver
     caps the rows at 25 and counts unbounded), and that it is a DESTINATION
     rather than the readout it used to be. */
  describe('waiting-on-you count', () => {
    const waiting = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `WI-${i}`, title: `Ask ${i}` }));

    it('renders the count as a CONTROL that jumps to the section it counts', () => {
      renderPanel(detail({ waitingOnYou: waiting(3), waitingOnYouTotal: 3 }));
      // A <button>, not a <span>: getByRole is what discriminates. The card's
      // chip deliberately stays a span (nested-button rule) — this band does not.
      const jump = screen.getByTestId('goal-waiting-jump');
      expect(jump.tagName).toBe('BUTTON');
      expect(jump.textContent).toContain('3 waiting on you');

      // jsdom implements neither, and their ABSENCE is what the old dead-text
      // version relied on — so stub and assert they are actually called.
      const section = screen.getByTestId('goal-waiting-section');
      const scrollIntoView = vi.fn();
      const focus = vi.fn();
      section.scrollIntoView = scrollIntoView;
      section.focus = focus;

      fireEvent.click(jump);
      expect(scrollIntoView).toHaveBeenCalled();
      // Focus MUST move with the scroll: a scroll alone strands a keyboard
      // user's focus in the band, which is the accessibility half of "the
      // count goes nowhere".
      expect(focus).toHaveBeenCalled();
    });

    it('shows the TOTAL and discloses the cap when rows are truncated', () => {
      // The resolver's LIMIT 25 against a true 31. Before D-018 the panel
      // rendered `waiting.length`, so it said 25 while the goal card — which
      // counts unbounded — said 31, with nothing explaining the difference.
      renderPanel(detail({ waitingOnYou: waiting(25), waitingOnYouTotal: 31 }));
      expect(screen.getByTestId('goal-waiting-jump').textContent).toContain('31 waiting on you');
      expect(screen.getByTestId('goal-waiting-note').textContent).toBe('showing 25 of 31');
      const section = screen.getByTestId('goal-waiting-section');
      // The capped length must not appear as the headline anywhere.
      expect(section.querySelector('.hud__chip')?.textContent).toBe('31');
    });

    it('adds no cap note when the list is complete', () => {
      renderPanel(detail({ waitingOnYou: waiting(2), waitingOnYouTotal: 2 }));
      expect(screen.queryByTestId('goal-waiting-note')).toBeNull();
      expect(screen.getByTestId('goal-waiting-jump').textContent).toContain('2 waiting on you');
    });

    it('keeps the brief BESIDE the conversation, never wrapping it (P-022)', () => {
      // The owner's ask was "the conversation takes up the full height", and the
      // mechanism is structural: the brief is a SIBLING zone, so the chat column
      // has nothing stacked above it. Asserted as containment rather than by
      // reading a flex value, because a style assertion would still pass if the
      // brief were nested back inside the conversation column.
      renderPanel(detail());
      const brief = screen.getByTestId('goal-brief-rail');
      const chat = screen.getByTestId('goal-chat');
      expect(brief.contains(chat)).toBe(false);
      expect(chat.contains(brief)).toBe(false);
      // Same invariant SessionChatModal states twice for its own rails: a zone
      // that becomes a PARENT of the conversation silently breaks the layout
      // contract, and nothing else in the tree would catch it.
      expect(screen.getByTestId('goal-detail-modal').contains(brief)).toBe(true);
    });

    it('the brief zone can be closed, and closing it leaves the conversation mounted', () => {
      renderPanel(detail());
      expect(screen.getByTestId('goal-brief-rail')).toBeTruthy();
      openPanelsMenu();
      fireEvent.click(screen.getByTestId('goal-brief-toggle'));
      expect(screen.queryByTestId('goal-brief-rail')).toBeNull();
      // The point of the toggle is more room for the conversation — so the
      // conversation must survive it.
      expect(screen.getByTestId('goal-chat')).toBeTruthy();
    });

    it('stays silent at zero — no control, no note', () => {
      renderPanel(detail({ waitingOnYou: [], waitingOnYouTotal: 0 }));
      expect(screen.queryByTestId('goal-waiting-jump')).toBeNull();
      expect(screen.queryByTestId('goal-waiting-note')).toBeNull();
      expect(document.body.textContent).toContain('Nothing is parked on you.');
    });
  });

  /* ── P-021: the sessions popup's rails, IN ADDITION ───────────────────────
     [owner 2026-08-10, verbatim] "the conversation popup for goals should
     ahve all the smae left and right panels as the conversation popup in the
     sessions tab. the additional ones shoudl be IN ADDITION not instead of."

     These guards are written against STRUCTURE, not against widths or flex
     values. A test that reads a computed style passes just as happily when a
     zone has been nested back inside the conversation — which is precisely the
     regression that would undo P-022's full-height contract while every number
     still looked right. */
  describe('P-021: the borrowed session rails', () => {
    const AGENT = { ownerId: 'su-abc', setAt: null, setBy: 'operator-ui' };
    const withAgent = () => detail({ agents: [AGENT] });

    /** A roster row, complete enough to survive `toHudSession`.
     *
     *  Built from a factory rather than written inline: several of these fields
     *  are REQUIRED on `HudRosterEntry` (`claims`, `currentFiles`, `modes`), so
     *  the server always sends them and the real derivation dereferences them
     *  unguarded — `e.claims.length`. A hand-thinned literal therefore throws
     *  inside `deriveFleetPeers`, which looks like a product bug and is not.
     *  ⚠ The right fix for that throw is THIS, not a `?? []` in the component:
     *  defaulting a required field in production would hide a genuinely
     *  malformed payload behind an empty rail. */
    function rosterEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        ownerId: 'su-abc',
        label: 'su · abc',
        source: 'presence',
        intent: 'working the goal',
        currentFiles: [],
        liveness: 'live',
        sessionState: 'live',
        stale: false,
        lastActiveAt: new Date(NOW).toISOString(),
        intentDeclaredAt: new Date(NOW).toISOString(),
        loopArmed: true,
        modes: [],
        pidAlive: true,
        claims: [],
        declaredUnclaimed: false,
        currentPlanSlug: null,
        harnessSlug: 'papercusp',
        agentPaneKind: 'claude',
        role: 'su',
        agent: 'claude',
        advSessionId: 1,
        windowId: null,
        wakeMode: 'auto',
        pendingWakes: 0,
        /** The field that decides whether there is a fleet at all — absent, and
         *  `deriveFleetPeers` returns null, which is the common case for a
         *  goal's single directed agent. */
        fleetSlug: null,
        fleetColor: null,
        fleetRole: null,
        contextTokens: 1000,
        compactionLimit: 400_000,
        openAwait: null,
        thinking: false,
        ...over,
      };
    }
    function rosterRows(rows: Array<Record<string, unknown>>) {
      rosterResult = { data: [{ active: rows }], loading: false, error: null };
    }
    const inFleet = [rosterEntry({ fleetSlug: 'fleet-x' })];

    it('renders the three borrowed zones IN ADDITION to the goal’s own two, never instead of them', () => {
      rosterRows(inFleet);
      renderPanel(withAgent());
      // The goal's own two — the thing "in addition, not instead of" protects.
      expect(screen.getByTestId('goal-brief-rail')).toBeTruthy();
      expect(screen.getByTestId('goal-work-rail')).toBeTruthy();
      // …and the three borrowed from the sessions popup.
      expect(screen.getByTestId('goal-orders-rail')).toBeTruthy();
      expect(screen.getByTestId('goal-dossier-rail')).toBeTruthy();
      expect(screen.getByTestId('goal-peers-rail')).toBeTruthy();
    });

    it('seats every borrowed zone as a SIBLING of the conversation, never inside or around it', () => {
      rosterRows(inFleet);
      renderPanel(withAgent());
      const chat = screen.getByTestId('goal-chat');
      for (const id of ['goal-orders-rail', 'goal-dossier-rail', 'goal-peers-rail']) {
        const zone = screen.getByTestId(id);
        // Containment asserted BOTH ways: nesting a zone inside the
        // conversation, or wrapping the conversation in one, are the two shapes
        // that break the layout contract while still rendering something
        // plausible at one particular width.
        expect(chat.contains(zone)).toBe(false);
        expect(zone.contains(chat)).toBe(false);
      }
    });

    it('keeps DOM order equal to the promised reading order, so tab order cannot contradict the layout', () => {
      rosterRows(inFleet);
      renderPanel(withAgent());
      /* Orders │ Brief │ conversation │ Sessions │ Work │ Activity │ Fleet.
         This is the guard that forbids reaching for CSS `order` to place a
         zone: `order` moves the pixels and leaves the tab sequence behind,
         which is the a11y failure this codebase already rejects elsewhere.

         P-024 inserted Sessions at position 4 rather than appending it, because
         the owner placed it "to the left of the WORK pane" — and a list that
         merely CONTAINED the new id in any position would pass with the zone
         seated at the far edge, which is the one placement that was ruled out
         explicitly. */
      const nodes = [
        'goal-orders-rail',
        'goal-brief-rail',
        'goal-chat',
        'goal-sessions-rail',
        'goal-work-rail',
        'goal-dossier-rail',
        'goal-peers-rail',
      ].map((id) => screen.getByTestId(id));
      for (let i = 1; i < nodes.length; i += 1) {
        const rel = nodes[i - 1]!.compareDocumentPosition(nodes[i]!);
        expect(rel & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    });

    it('renders no borrowed zone and no toggle for one when the goal has no agent', () => {
      rosterRows(inFleet);
      renderPanel(detail({ agents: [] }));
      openPanelsMenu();
      // Absent, not present-and-inert — WI-6742's dead-control shape, which
      // this popup has already been filed against once.
      for (const id of [
        'goal-orders-rail',
        'goal-dossier-rail',
        'goal-peers-rail',
        'goal-orders-toggle',
        'goal-activity-toggle',
        'goal-fleet-toggle',
        /* P-024's zone goes with them. It is not a BORROWED rail — it describes
           the goal, not the agent — but its five sections exist to report
           coverage gaps in a goal that is RUNNING, and a goal with no agent
           stamp has none to report. Five empty sections beside the popup's own
           "no agent is running this goal yet" sentence would be saying that a
           sixth time, in a shape that reads as a fault. */
        'goal-sessions-rail',
        'goal-sessions-toggle',
      ]) {
        expect(screen.queryByTestId(id)).toBeNull();
      }
      // The goal's own zones are untouched: the borrowed rails are context
      // ABOUT an agent, never a precondition for showing the goal.
      expect(screen.getByTestId('goal-brief-rail')).toBeTruthy();
      expect(screen.getByTestId('goal-work-rail')).toBeTruthy();
    });

    it('shows the fleet zone only when the agent is actually in a fleet — never an empty column', () => {
      rosterRows(inFleet);
      const { unmount } = renderPanel(withAgent());
      expect(screen.getByTestId('goal-peers-rail')).toBeTruthy();
      openPanelsMenu();
      expect(screen.getByTestId('goal-fleet-toggle')).toBeTruthy();
      unmount();
      cleanup();

      // Same agent, no fleet. The zone AND its toggle go away together.
      rosterRows([rosterEntry({ fleetSlug: null })]);
      renderPanel(withAgent());
      expect(screen.queryByTestId('goal-peers-rail')).toBeNull();
      openPanelsMenu();
      expect(screen.queryByTestId('goal-fleet-toggle')).toBeNull();
      // …while the two that need no fleet stay. A regression that gated all
      // three on the fleet model would pass the previous assertions alone.
      expect(screen.getByTestId('goal-orders-rail')).toBeTruthy();
      expect(screen.getByTestId('goal-dossier-rail')).toBeTruthy();
    });

    it('closing a borrowed zone leaves the conversation and the other zones mounted', () => {
      rosterRows(inFleet);
      renderPanel(withAgent());
      openPanelsMenu();
      fireEvent.click(screen.getByTestId('goal-orders-toggle'));
      expect(screen.queryByTestId('goal-orders-rail')).toBeNull();
      // The point of every toggle here is more room for the conversation, so
      // the conversation must survive each one.
      expect(screen.getByTestId('goal-chat')).toBeTruthy();
      expect(screen.getByTestId('goal-dossier-rail')).toBeTruthy();
      expect(screen.getByTestId('goal-peers-rail')).toBeTruthy();
    });

    it('adds exactly ONE query of its own for the borrowed rails — the shared roster read', () => {
      rosterRows(inFleet);
      renderPanel(withAgent());
      /* The reuse-first claim, pinned — and stated honestly. The two rails are
         SELF-SUFFICIENT components (that is what makes them reusable), so
         `agentOrders.byOwner` and `agentDetail.byOwner` are theirs and appear
         here by design. What this panel adds is exactly ONE read,
         `advRoster.list`, serving the dossier's entry and the fleet derivation
         both — `useSyncQuery` caches by {queryName, args}, so a second reader
         is free.

         Pinned as the whole SET rather than as a count, so it fails in both
         directions: a rail given a redundant panel-level fetch shows up as a
         fifth name, and a rail that stopped fetching shows up as a missing one.
         A set, not a tally, because React re-renders re-issue the same calls
         and a raw count would be flaky. */
      expect([...new Set(syncCalls.map((c) => c.queryName))].sort()).toEqual([
        'advRoster.list',
        'agentDetail.byOwner',
        'agentOrders.byOwner',
        'goals.detail',
      ]);
    });

    /* ── P-024: the SESSIONS zone ────────────────────────────────────────────
       [owner 2026-08-10] "just put the pane on the right side, to the left of
       the 'WORK — what sits under this goal' pane."

       The grouping, ordering and classification are covered exhaustively in
       goal-sessions.test.ts. What only THIS suite can prove is the seam between
       the panel and that derivation — which roster rows the panel actually
       hands it, and where the result is seated. Every case below is a
       one-expression regression that leaves a plausible-looking rail on screen,
       which is exactly the class a passing model test cannot see. Nested inside
       the P-021 block for its `withAgent`/`rosterEntry` fixtures. */
    describe('P-024: the sessions zone', () => {
      /** `rosterRows` sets `active` only; the panel reads BOTH legs. */
      function rosterLegs(legs: {
        active?: Array<Record<string, unknown>>;
        pending?: Array<Record<string, unknown>>;
      }) {
        rosterResult = { data: [legs], loading: false, error: null };
      }
      const owners = () =>
        screen.queryAllByTestId('goal-session-row').map((n) => n.getAttribute('data-owner'));

      it('seats the zone IMMEDIATELY left of the work rail, not merely somewhere before it', () => {
        rosterRows(inFleet);
        renderPanel(withAgent());
        /* The owner's placement was specific, and "somewhere to the left" is
           satisfied by seating it against the conversation with Work three
           columns away. Asserted as ADJACENCY so that a later zone inserted
           between the two fails here rather than silently re-reading the
           instruction. Both zones are open in this fixture, so the sibling
           relation is the real one and not an artefact of a closed neighbour. */
        expect(screen.getByTestId('goal-sessions-rail').nextElementSibling).toBe(
          screen.getByTestId('goal-work-rail'),
        );
      });

      it('counts a session that is still LAUNCHING — the pending leg, not just the live one', () => {
        /* `payload.active ?? []` is the natural thing to write here (it is what
           the fleet rail beside it does) and it silently drops every agent that
           has been spawned but has not yet taken a turn — precisely the window
           in which a reader opens this popup to ask whether the goal is moving.
           The rail would render, correctly shaped, one row short. */
        rosterLegs({
          active: [rosterEntry({ ownerId: 'su-abc', fleetSlug: 'fleet-x' })],
          /* In the goal's fleet, so it is genuinely ON the goal by membership
             leg 2 — a launching MEMBER, which is what `pending` mostly holds.
             (A pending row that is neither stamped nor in the fleet is
             correctly absent, and an earlier draft of this test asserted
             exactly that and failed: worth stating, because "pending rows are
             dropped" and "this pending row does not belong" produce the same
             empty rail and only one of them is a bug.) */
          pending: [
            rosterEntry({ ownerId: 'su-booting', label: 'su · booting', fleetSlug: 'fleet-x' }),
          ],
        });
        renderPanel(withAgent());
        expect(owners()).toContain('su-booting');
      });

      it('keeps a SECOND stamped agent’s fleet, not just the primary’s', () => {
        /* D-006's "one directed agent" is the normal case, not a guarantee — the
           resolver surfaces a second stamp rather than hiding it. Passing only
           `agentOwnerId` (which is `agents[0]`, and is what the dossier and the
           fleet rail beside this one legitimately use) drops the second agent's
           WHOLE FLEET from the answer to "who is working on this goal", because
           membership leg 2 walks the fleets of the stamped set. */
        rosterLegs({
          active: [
            rosterEntry({ ownerId: 'su-abc', fleetSlug: 'fleet-x' }),
            rosterEntry({ ownerId: 'su-def', fleetSlug: 'fleet-y' }),
            // Stamped by NEITHER. It is on the goal only because it shares
            // fleet-y with the second stamped agent.
            rosterEntry({ ownerId: 'su-member-y', fleetSlug: 'fleet-y' }),
          ],
        });
        renderPanel(
          detail({
            agents: [
              { ownerId: 'su-abc', setAt: null, setBy: 'operator-ui' },
              { ownerId: 'su-def', setAt: null, setBy: 'operator-ui' },
            ],
          }),
        );
        expect(owners()).toContain('su-member-y');
      });

      it('closing it leaves the conversation and both neighbours mounted', () => {
        rosterRows(inFleet);
        renderPanel(withAgent());
        openPanelsMenu();
        fireEvent.click(screen.getByTestId('goal-sessions-toggle'));
        expect(screen.queryByTestId('goal-sessions-rail')).toBeNull();
        // The point of the toggle is room for the conversation, so it survives —
        // as do the zones on either side, which a mis-scoped visibility test
        // would take down with it.
        expect(screen.getByTestId('goal-chat')).toBeTruthy();
        expect(screen.getByTestId('goal-work-rail')).toBeTruthy();
      });

      it('adds NO query of its own — it is a third reader of the roster row', () => {
        rosterRows(inFleet);
        renderPanel(withAgent());
        /* The reuse-first claim for this zone specifically. `useSyncQuery`
           caches by {queryName, args}, so deriving the sessions model from the
           row the dossier and fleet rail already hold costs nothing; a
           panel-level fetch added for it would appear here as a fifth name. */
        expect([...new Set(syncCalls.map((c) => c.queryName))].sort()).toEqual([
          'advRoster.list',
          'agentDetail.byOwner',
          'agentOrders.byOwner',
          'goals.detail',
        ]);
      });
    });

    /* ── P-025: one panel chooser; P-023: the unchanged expand pair ──────────
       [owner 2026-08-13] the confusing controls are the individual
       Orders/Brief/Sessions/Work/Activity/Fleet chevrons, not the full-window
       and full-screen pair. The six panel states now live in one checked
       chooser grouped by physical side; the expand pair remains exactly the
       shared P-023 behavior below. */
    describe('P-025: panel visibility chooser + the P-023 expand pair', () => {
      it('keeps the trailing controls in one end-aligned cluster above every panel overlay', () => {
        rosterRows(inFleet);
        renderPanel(withAgent(), { onOpenAgent: () => {} });
        const toolbar = screen.getByTestId('goal-panel-toolbar');
        const controls = [
          'goal-open-agent',
          'goal-full-window',
          'goal-full-screen',
          'goal-panels-trigger',
        ].map((id) => screen.getByTestId(id));

        for (const control of controls) expect(toolbar.contains(control)).toBe(true);
        for (let i = 1; i < controls.length; i += 1) {
          expect(
            controls[i - 1]!.compareDocumentPosition(controls[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
          ).toBeTruthy();
        }

        // At the Tauri shell's 1280px width the former four independent flex
        // items split 3+1; Panels wrapped to the band's left edge underneath
        // the Orders overlay and could no longer close it. The unit must wrap
        // as a whole to the clear END edge, and it must remain above Fleet's
        // outermost overlay (z-index 7) if a right rail overlays too.
        expect(toolbar.style.display).toBe('flex');
        expect(toolbar.style.flexWrap).toBe('nowrap');
        expect(toolbar.style.marginLeft).toBe('auto');
        expect(toolbar.style.position).toBe('relative');
        expect(Number(toolbar.style.zIndex)).toBeGreaterThan(7);
      });

      it('groups every available panel by the side it occupies, in layout order', () => {
        rosterRows(inFleet);
        renderPanel(withAgent());
        const menu = openPanelsMenu();
        const left = within(menu).getByRole('group', { name: 'Left side' });
        const right = within(menu).getByRole('group', { name: 'Right side' });
        expect(within(left).getAllByRole('checkbox').map((box) => box.parentElement?.textContent)).toEqual([
          'Orders',
          'Brief',
        ]);
        expect(within(right).getAllByRole('checkbox').map((box) => box.parentElement?.textContent)).toEqual([
          'Sessions',
          'Work',
          'Activity',
          'Fleet',
        ]);
      });

      it('shows checked visibility state and stays open while several panels are changed', () => {
        rosterRows(inFleet);
        renderPanel(withAgent());
        const menu = openPanelsMenu();
        const brief = within(menu).getByRole('checkbox', { name: 'Brief' });
        const work = within(menu).getByRole('checkbox', { name: 'Work' });
        expect(brief.getAttribute('aria-checked')).toBe('true');
        expect(work.getAttribute('aria-checked')).toBe('true');

        fireEvent.click(brief);
        expect(screen.getByRole('dialog', { name: 'Panel visibility' })).toBe(menu);
        expect(screen.getByTestId('goal-panels-trigger').getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByRole('checkbox', { name: 'Brief' }).getAttribute('aria-checked')).toBe('false');
        expect(screen.queryByTestId('goal-brief-rail')).toBeNull();

        fireEvent.click(screen.getByRole('checkbox', { name: 'Work' }));
        expect(screen.getByRole('dialog', { name: 'Panel visibility' })).toBe(menu);
        expect(screen.queryByTestId('goal-work-rail')).toBeNull();
      });

      it('offers BOTH expand modes, and they are not the same control', () => {
        rosterRows(inFleet);
        renderPanel(withAgent());
        const win = screen.getByTestId('goal-full-window');
        const scr = screen.getByTestId('goal-full-screen');
        // Distinct affordances, not one duplicated: full WINDOW and full SCREEN
        // are different modes on the desktop, which is why there are two.
        expect(win.getAttribute('aria-label')).toBe('Full window');
        expect(scr.getAttribute('aria-label')).toBe('Full screen');
        expect(win.getAttribute('aria-pressed')).toBe('false');
      });

      it('full window maximizes the popup and grows the ✕ that maximize makes necessary', () => {
        rosterRows(inFleet);
        renderPanel(withAgent());
        /* Unmaximized, the Modal's backdrop and Esc are the exits, so a ✕ would
           be a third one. Maximized, the popup COVERS the backdrop — without
           this control there is no way out but the expand buttons themselves. */
        expect(screen.queryByTestId('goal-close')).toBeNull();
        fireEvent.click(screen.getByTestId('goal-full-window'));
        expect(screen.getByTestId('goal-full-window').getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('goal-full-window').getAttribute('aria-label')).toBe(
          'Exit full window',
        );
        expect(screen.getByTestId('goal-close')).toBeTruthy();
      });

      it('full screen falls back to full WINDOW when the host cannot paint us fullscreen', async () => {
        rosterRows(inFleet);
        renderPanel(withAgent());
        /* jsdom implements no Fullscreen API, which is the same shape as a
           webview with it switched off: the hook must land on the
           bigger-we-still-have rather than doing nothing. A dead "make it
           bigger" button is the worse failure — and this is the branch the
           sessions popup was filed against. */
        fireEvent.click(screen.getByTestId('goal-full-screen'));
        await screen.findByTestId('goal-close');
        expect(screen.getByTestId('goal-full-window').getAttribute('aria-pressed')).toBe('true');
      });

      it('does not gate the expand pair on there being an agent', () => {
        rosterRows(inFleet);
        renderPanel(detail({ agents: [] }));
        /* The three BORROWED toggles are absent without an agent (asserted
           above) — but maximize acts on the POPUP, which exists either way.
           Hiding it here would be the mirror of the WI-6742 dead-control bug:
           a live control missing rather than a dead one present. */
        expect(screen.getByTestId('goal-full-window')).toBeTruthy();
        expect(screen.getByTestId('goal-full-screen')).toBeTruthy();
      });
    });
  });

  /* ── P-012: tripwire bar accessibility ─────────────────────────────────────
     Two defects, one widget: the bar carried no progressbar semantics at all,
     and BREACH — the state it exists to announce — was conveyed by colour
     alone, so it reached neither a screen reader nor anyone who cannot
     distinguish the colour. */
  describe('P-012: tripwire bars are readable by assistive tech', () => {
    function withTripwires(tripwires: unknown[]) {
      return detail({
        goal: {
          id: 'goal-1',
          title: 'g',
          status: 'active',
          killCriterion: 'stop at 30 days or $500',
          tripwires,
        } as GoalDetailInput['goal'],
      });
    }

    it('exposes each bar as a progressbar named by its label', () => {
      renderPanel(withTripwires([
        { metric: 'spend', label: 'Spend', threshold: 500, current: 310, unit: 'usd' },
      ]));
      const bar = screen.getByRole('progressbar', { name: 'Spend' });
      expect(bar.getAttribute('aria-valuemin')).toBe('0');
      expect(bar.getAttribute('aria-valuemax')).toBe('100');
      expect(bar.getAttribute('aria-valuenow')).toBe('62');
      // The figures, not just the ratio — a bare "62" is not the reading.
      expect(bar.getAttribute('aria-valuetext')).toBe('$310 of $500');
    });

    it('reports the TRUE figures for an OVERSHOT tripwire, though the bar is clamped', () => {
      /* The item's specific requirement, and the subtlest one. The fill is
         deliberately capped at 100% so it cannot render past its track — that
         clamp stays. But ARIA requires `aria-valuenow` to sit within
         valuemin..valuemax, so it CANNOT carry 120 either; `aria-valuetext` is
         the sanctioned carrier and screen readers prefer it. This asserts the
         listener hears the real overshoot rather than a comfortable "100". */
      renderPanel(withTripwires([
        { metric: 'spend', label: 'Spend', threshold: 500, current: 600, unit: 'usd' },
      ]));
      const bar = screen.getByRole('progressbar', { name: 'Spend' });
      expect(bar.getAttribute('aria-valuenow')).toBe('100');
      expect(bar.getAttribute('aria-valuetext')).toBe('$600 of $500 — past limit');
      // …and the visual clamp it must not have broken.
      const fill = bar.querySelector('.hud-goal__bar-fill') as HTMLElement | null;
      expect(fill?.style.width).toBe('100%');
    });

    it('announces BREACH in text, not by colour alone', () => {
      renderPanel(withTripwires([
        { metric: 'spend', label: 'Spend', threshold: 500, current: 600, unit: 'usd' },
        { metric: 'elapsed', label: 'Elapsed', threshold: 30, current: 12, unit: 'days' },
      ]));
      /* Exactly one of the two is breached, so this fails both if the marker
         disappears AND if it starts rendering on every bar. Asserting TEXT
         rather than a class is the point: a class is still a colour hook, and
         the whole defect was that the state lived only in the styling. */
      const breaches = screen.getAllByTestId('goal-tripwire-breach');
      expect(breaches).toHaveLength(1);
      expect(breaches[0]!.textContent).toMatch(/past limit/i);
      expect(screen.getByTestId('goal-tripwires').textContent).toMatch(/past limit/i);
    });

    it('marks a HAND-SET reading in text, so it cannot pass for a measurement', () => {
      /* EI-21605510614702802. Both bars carry a number, so before provenance
         existed they were indistinguishable on screen — one is refreshed by the
         platform every five minutes, the other was typed by an agent and may be
         weeks stale. Exactly one is stamped, so this fails both if the marker
         vanishes AND if it starts appearing on measured bars too. */
      renderPanel(
        withTripwires([
          {
            metric: 'spend',
            label: 'Spend',
            threshold: 500,
            current: 310,
            unit: 'usd',
            measuredBy: { source: 'resolver:spend_usd', atMs: 1_700_000, value: 310 },
          },
          { metric: 'surfaces_verified', label: 'Surfaces', threshold: 30, current: 0 },
        ]),
      );

      const handSet = screen.getAllByTestId('goal-tripwire-handset');
      expect(handSet).toHaveLength(1);
      expect(handSet[0]!.textContent).toMatch(/hand-set/i);

      // The machine-readable half, on the row rather than the chip: a hand-set
      // reading is still `measured` (a reading exists) but is not `derived`.
      const rows = screen.getByTestId('goal-tripwires').querySelectorAll('.hud-goal__bar');
      const byDerived = [...rows].map((r) => r.getAttribute('data-derived'));
      expect(byDerived).toEqual(['true', 'false']);
      expect([...rows].map((r) => r.getAttribute('data-measured'))).toEqual(['true', 'true']);
    });

    it('leaves an INDETERMINATE bar with no aria-valuenow — never a comfortable 0', () => {
      /* `pct` is null for TWO different reasons and both are genuinely
         indeterminate: nobody took a reading, OR there is a reading but no
         threshold to measure it against. Sending 0 for either would re-import
         the unmeasured-reads-as-zero defect (P-002) into the a11y tree, where
         it is harder to notice — 0 is the most REASSURING value available, so
         the failure points at "nothing to worry about". */
      renderPanel(withTripwires([
        { metric: 'builds', label: 'Shipped builds', threshold: 1 },
        { metric: 'signups', label: 'Signups', current: 5 },
        { metric: 'elapsed', label: 'Elapsed', threshold: 30, current: 0, unit: 'days' },
      ]));
      const unread = screen.getByRole('progressbar', { name: 'Shipped builds' });
      expect(unread.hasAttribute('aria-valuenow')).toBe(false);
      expect(unread.getAttribute('aria-valuetext')).toMatch(/not measured yet/i);

      const noThreshold = screen.getByRole('progressbar', { name: 'Signups' });
      expect(noThreshold.hasAttribute('aria-valuenow')).toBe(false);

      // …while a genuine zero DOES report one. This is the pair that makes the
      // assertion above meaningful rather than vacuous.
      const realZero = screen.getByRole('progressbar', { name: 'Elapsed' });
      expect(realZero.getAttribute('aria-valuenow')).toBe('0');
    });
  });
});
