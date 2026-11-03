// @vitest-environment jsdom
//
// AdvOverviewTab mount coverage — Brief 23's Overview dashboard (the /adv
// default landing surface, overview-dashboard-2026-06-05). The pure selectors
// (planProgress / selectActivePlans / selectDecisions / countAlerts /
// selectAgentRows / OVERVIEW_TILE_TARGETS) are pinned in
// __tests__/adv-overview-logic.test.ts; THIS file mounts the tab against
// mocked usePlanList/usePlanAttention + a per-query useSyncQuery dispatcher
// (roster → dev.coordPresence, activity → userActions.byHarness; LIVE sync,
// no longer polled — data-sync-push-completion P-006) and asserts the four
// tiles, the alerts badge, empty/loading states, and the tile→tab
// click-through wiring. FleetRateControl is covered by its own test file and
// stubbed out here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';

// nuqs: writers (tab / inboxTier) + the `slug` reader (the selected harness,
// which scopes the activity query). Stable per-key setter spies so the
// click-through wiring is assertable. Parsers from the shared complete mock
// (EI-8821) so a new parseAsX call elsewhere can't silently red this suite.
const nuqsState: Record<string, unknown> = { tab: null, inboxTier: null, slug: null };
const nuqsSetters: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => {
    nuqsSetters[key] ??= vi.fn(async () => {});
    return [nuqsState[key], nuqsSetters[key]];
  },
  // The activity deep-link writes {conv, fmsg, fsys} in ONE useQueryStates
  // batch; expose it as a single spy keyed '__states'.
  useQueryStates: (parsers: Record<string, unknown>) => {
    nuqsSetters.__states ??= vi.fn(async () => {});
    return [
      Object.fromEntries(Object.keys(parsers).map((k) => [k, nuqsState[k] ?? null])),
      nuqsSetters.__states,
    ];
  },
}));

// Brief 20's control has its own test file — stub it out so this one only
// exercises the Overview composition.
vi.mock('./FleetRateControl', () => ({
  default: () => <div data-testid="fleet-rate-control" />,
}));
let advScope = {
  allMode: true,
  scopeMode: 'all',
  slug: null as string | null,
  hive: '',
  harnessSlugs: null as string[] | null,
  ready: true,
};
vi.mock('./AdvShell', () => ({ useAdvScope: () => advScope }));
vi.mock('@/lib/useLexicon', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/lexicon')>('@papercusp/lexicon');
  return { useLexicon: () => actual.lexiconFor('classic') };
});

let planListResult: Record<string, unknown> = { data: { plans: [] }, loading: false, error: null, refresh: vi.fn() };
let attentionResult: Record<string, unknown> = { data: { groups: [] }, loading: false, error: null, refresh: vi.fn() };
vi.mock('@/app/admin/plans/plans-api', () => ({
  usePlanList: () => planListResult,
  usePlanAttention: () => attentionResult,
  // Same dedupe-by-id semantics as the real export (plans-api.ts) — mocked
  // inline rather than importActual so this file stays free of the real
  // module's other side effects.
  flattenAttentionItems: (groups: Array<{ items: Array<{ id: string }> }>) => {
    const seen = new Set<string>();
    const out: Array<{ id: string }> = [];
    for (const g of groups) {
      for (const it of g.items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        out.push(it);
      }
    }
    return out;
  },
}));

// Per-query sync mock — the tab subscribes to two distinct LIVE queries
// (WI-5517 rewire): advRoster.list (the pill's roster, SERVER-derived
// liveness) · dev.coordFeed (the coordination stream).
let rosterResult: { data?: unknown[]; loading?: boolean } = { data: [{ active: [] }], loading: false };
let activityResult: { data?: unknown[]; loading?: boolean } = { data: [], loading: false };
// Owner ask 2026-07-19: the three stat tiles' reads.
let statsResult: { data?: unknown[]; loading?: boolean } = { data: [], loading: false };
let healthResult: { data?: unknown[]; loading?: boolean } = { data: undefined, loading: false };
let readinessResult: { data?: unknown[]; loading?: boolean } = { data: undefined, loading: false };
// P-001: the Deploy tile's dev.gitPipeline snapshot (1-element array).
let pipelineResult: { data?: unknown[]; loading?: boolean } = { data: undefined, loading: false };
// P-002: the Work-items tile's 24h burn-down companion.
let deltaResult: { data?: unknown[]; loading?: boolean } = { data: [], loading: false };
// P-003: the Spend tile's usage envelope + account pool.
let spendResult: { data?: unknown[]; loading?: boolean } = { data: undefined, loading: false };
let accountsResult: { data?: unknown[]; loading?: boolean } = { data: [], loading: false };
// P-004: the Operator-report tile's latest <report> turns.
let reportsResult: { data?: unknown[]; loading?: boolean } = { data: [], loading: false };
const syncEnabled: Record<string, boolean | undefined> = {};
const syncArgs: Record<string, unknown> = {};
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: ({
    queryName,
    args,
    enabled,
  }: {
    queryName: string;
    args?: unknown;
    enabled?: boolean;
  }) => {
    syncEnabled[queryName] = enabled;
    syncArgs[queryName] = args;
    if (enabled === false) return { data: undefined, loading: false, error: null };
    switch (queryName) {
      case 'advRoster.list':
        return { ...rosterResult, error: null };
      case 'dev.coordFeed':
        return { ...activityResult, error: null };
      case 'workItems.stats':
        return { ...statsResult, error: null };
      case 'health.snapshot':
        return { ...healthResult, error: null };
      case 'learning.releaseReadiness':
        return { ...readinessResult, error: null };
      case 'dev.gitPipeline':
        return { ...pipelineResult, error: null };
      case 'workItems.delta24h':
        return { ...deltaResult, error: null };
      case 'usage.spend':
        return { ...spendResult, error: null };
      case 'accounts.pool':
        return { ...accountsResult, error: null };
      case 'operatorReports.latest':
        return { ...reportsResult, error: null };
      default:
        return { data: undefined, loading: false, error: null };
    }
  },
}));

import AdvOverviewTab from './AdvOverviewTab';
import ServerConnectionGate from '../ServerConnectionGate';
import type { AttentionItem, PlanListRow } from '@/app/admin/plans/plans-api';
import { advRosterArgs } from '@/lib/adv-roster-args';
import { configureOperatorUi } from '@papercusp/operator-ui/seam';
import * as perfMarks from '@/app/_components/perf/perf-marks';
import { ADV_TAB_SURFACE_KINDS } from '@papercusp/operator-ui/adv-navigation';

const plan = (over: Partial<PlanListRow>): PlanListRow =>
  ({
    slug: 'p',
    title: 'plan',
    status: 'active',
    startStatus: null,
    archived: false,
    updated: '2026-06-01T00:00:00Z',
    itemCounts: { todo: 1, wip: 1, blocked: 0, 'needs-human': 0, done: 2, dropped: 1 },
    ...over,
  }) as PlanListRow;

const attn = (over: Partial<AttentionItem> & { tier?: string }): AttentionItem =>
  ({
    id: `a-${Math.random()}`,
    kind: 'plan-question',
    title: 'an item',
    body: '',
    importance: 'normal',
    needsHuman: false,
    harnessSlug: null,
    ...over,
  }) as AttentionItem;

// An advRoster.list ACTIVE entry (RosterAgent — the fields the tab maps).
// Liveness is server-derived on the entry; membership = isRunningAgent
// (liveness !== 'stale' OR loopArmed) — the pill's shared predicate.
const rosterEntry = (
  over: Partial<{
    ownerId: string;
    label: string;
    agent: string | null;
    role: string | null;
    intent: string;
    feature: string | null;
    currentPlanSlug: string | null;
    liveness: string;
    loopArmed: boolean;
  }>,
) => ({
  ownerId: `o-${Math.random()}`,
  label: 'agent',
  agent: 'claude',
  role: null,
  intent: '',
  feature: null,
  currentPlanSlug: null,
  liveness: 'live',
  heartbeatAt: new Date().toISOString(),
  loopArmed: false,
  ...over,
});

// A dev.coordFeed row (the coordination-stream fields the tab reads).
const feedRow = (
  over: Partial<{
    msg_id: string;
    from: string;
    kind: string;
    summary: string | null;
    body: string | null;
    ts: string;
  }>,
) => ({
  ts: new Date().toISOString(),
  msg_id: `m-${Math.random()}`,
  from: 'su-worker',
  kind: 'message',
  summary: null,
  body: null,
  ...over,
});

describe('AdvOverviewTab component', () => {
  beforeEach(() => {
    configureOperatorUi({ advNavigation: undefined });
    nuqsState.tab = null;
    nuqsState.inboxTier = null;
    nuqsState.slug = null;
    for (const k of Object.keys(nuqsSetters)) delete nuqsSetters[k];
    for (const k of Object.keys(syncEnabled)) delete syncEnabled[k];
    for (const k of Object.keys(syncArgs)) delete syncArgs[k];
    planListResult = { data: { plans: [] }, loading: false, error: null, refresh: vi.fn() };
    attentionResult = { data: { groups: [] }, loading: false, error: null, refresh: vi.fn() };
    rosterResult = { data: [{ active: [] }], loading: false };
    activityResult = { data: [], loading: false };
    statsResult = { data: [], loading: false };
    healthResult = { data: undefined, loading: false };
    readinessResult = { data: undefined, loading: false };
    pipelineResult = { data: undefined, loading: false };
    deltaResult = { data: [], loading: false };
    spendResult = { data: undefined, loading: false };
    accountsResult = { data: [], loading: false };
    reportsResult = { data: [], loading: false };
    advScope = { allMode: true, scopeMode: 'all', slug: null, hive: '', harnessSlugs: null, ready: true };
  });

  afterEach(() => {
    configureOperatorUi({ advNavigation: undefined });
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete window.__papercuspServerConnectionRestored;
    delete window.__papercuspServerConnectionRequired;
    delete window.__papercuspBootError;
  });

  const makeStartupContentReady = () => {
    healthResult = { data: [], loading: false };
    readinessResult = { data: [], loading: false };
    pipelineResult = { data: [], loading: false };
    spendResult = { data: [], loading: false };
  };

  it('ends startup only after the last primary data state has committed', () => {
    const end = vi.spyOn(perfMarks, 'endStartupUsable').mockImplementation(() => {
      expect(document.querySelector('.pc-overview')).toBeTruthy();
      expect(screen.getByText('No active plans')).toBeTruthy();
      return null;
    });
    const view = render(<AdvOverviewTab />);
    expect(end).not.toHaveBeenCalled();
    makeStartupContentReady();
    activityResult = { data: undefined, loading: true };
    view.rerender(<AdvOverviewTab />);
    expect(end).not.toHaveBeenCalled();
    activityResult = { data: [], loading: false };
    view.rerender(<AdvOverviewTab />);
    expect(end).toHaveBeenCalledTimes(1);
    view.rerender(<AdvOverviewTab />);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('does not count a failed read, unresolved scope, or hidden Overview as usable', () => {
    const end = vi.spyOn(perfMarks, 'endStartupUsable').mockReturnValue(null);
    makeStartupContentReady();
    planListResult.error = 'read failed';
    const view = render(<AdvOverviewTab />);
    expect(end).not.toHaveBeenCalled();
    planListResult.error = null;
    advScope.ready = false;
    view.rerender(<AdvOverviewTab />);
    expect(end).not.toHaveBeenCalled();
    advScope.ready = true;
    nuqsState.tab = 'harnesses';
    view.rerender(<AdvOverviewTab />);
    expect(end).not.toHaveBeenCalled();
  });

  it('retries cached committed content on native attach and removes its listener on unmount', () => {
    const end = vi.spyOn(perfMarks, 'endStartupUsable').mockReturnValue(null);
    makeStartupContentReady();
    rosterResult.loading = true; // valid cached rows remain usable
    const view = render(<AdvOverviewTab />);
    expect(end).toHaveBeenCalledTimes(1);
    act(() => window.dispatchEvent(new Event('papercusp:server-connection-restored')));
    expect(end).toHaveBeenCalledTimes(2);
    view.unmount();
    act(() => window.dispatchEvent(new Event('papercusp:server-connection-restored')));
    expect(end).toHaveBeenCalledTimes(2);
  });

  it('records restored startup after the real ServerConnectionGate releases input', () => {
    makeStartupContentReady();
    window.__papercuspServerConnectionRestored = false;
    window.__papercuspServerConnectionRequired = 'Waiting for the Server';
    const end = vi.spyOn(perfMarks, 'endStartupUsable').mockReturnValue(null);
    render(<><ServerConnectionGate /><AdvOverviewTab /></>);
    expect(screen.getByTestId('server-connection-reason')).toBeTruthy();
    end.mockImplementation(() => {
      expect(window.__papercuspServerConnectionRestored).toBe(true);
      expect(screen.queryByTestId('server-connection-reason')).toBeNull();
      expect(document.querySelector('.pc-overview')).toBeTruthy();
      return null;
    });
    end.mockClear();
    act(() => window.dispatchEvent(new Event('papercusp:server-connection-restored')));
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('renders the ten tiles, the top-bar rate control, and the empty states', async () => {
    render(<AdvOverviewTab />);
    expect(screen.getByTestId('fleet-rate-control')).toBeTruthy();
    expect(screen.getByText('Plans')).toBeTruthy();
    expect(screen.getByText('Needs you')).toBeTruthy();
    expect(screen.getByText('Agents')).toBeTruthy();
    expect(screen.getByText('Activity')).toBeTruthy();
    expect(screen.getByText('Work items')).toBeTruthy();
    expect(screen.getByText('Spend')).toBeTruthy();
    expect(screen.getByText('Deploy')).toBeTruthy();
    expect(screen.getByText('Operator report')).toBeTruthy();
    expect(screen.getByText('Health')).toBeTruthy();
    expect(screen.getByText('Learning')).toBeTruthy();
    expect(screen.getByText('No usage telemetry yet')).toBeTruthy();
    expect(screen.getByText('No operator report in the last 48h')).toBeTruthy();
    expect(screen.getByText('No active plans')).toBeTruthy();
    expect(screen.getByText('Nothing needs you right now')).toBeTruthy();
    expect(screen.getByText('No live agents')).toBeTruthy();
    expect(screen.getByText('No recent agent activity')).toBeTruthy();
    expect(screen.getByText('No work items')).toBeTruthy();
    expect(screen.getByText('No pipeline snapshot yet')).toBeTruthy();
    expect(screen.getByText('No health snapshot yet')).toBeTruthy();
    expect(screen.getByText('No release-readiness report yet')).toBeTruthy();
    // WI-5517: the roster MUST be the pill's own query with IDENTICAL args (one
    // shared cache entry + one shared membership rule) — never a client-side
    // heartbeat re-derivation (PG-text timestamps are NaN under WebKit, which
    // read every agent as 'stale' and blanked this tile).
    //
    // P-026: assert against `advRosterArgs()` rather than a hand-written
    // literal. The literal was the whole defect — this file pinned
    // `endedLimit: 20` while HudView/SessionChatModal pinned 50, so two tests
    // could BOTH pass while the app minted two 240 KB cache entries for the
    // same roster. Comparing to the canonical builder means a call site that
    // drifts back to a bespoke shape fails here.
    expect(syncArgs['advRoster.list']).toMatchObject(advRosterArgs(null));
    // The activity feed asks for the WHOLE stream explicitly (system_only:false)
    // and filters actors client-side — the server default must not decide.
    expect(syncArgs['dev.coordFeed']).toMatchObject({ system_only: false });
  });

  it('fills the Activity tile from the coord stream, filtering system-origin telemetry out', () => {
    activityResult = {
      data: [
        feedRow({ msg_id: 'f1', from: 'mug', kind: 'message', summary: 'placed WI-900' }),
        feedRow({ msg_id: 'f2', from: 'system-watchdog', summary: 'infra-liveness sweep' }),
      ],
      loading: false,
    };
    render(<AdvOverviewTab />);
    expect(screen.getByText('placed WI-900')).toBeTruthy();
    expect(screen.queryByText('infra-liveness sweep')).toBeNull();
  });

  it('scopes both work-item aggregates to the shell-resolved descendant set', () => {
    advScope = {
      allMode: false,
      scopeMode: 'expanded',
      slug: 'pot-a',
      hive: 'pot-a',
      harnessSlugs: ['pot-a', 'pot-a-child'],
      ready: true,
    };
    render(<AdvOverviewTab />);
    expect(syncArgs['workItems.stats']).toEqual({ harnessSlugs: ['pot-a', 'pot-a-child'] });
    expect(syncArgs['workItems.delta24h']).toEqual({ harnessSlugs: ['pot-a', 'pot-a-child'] });
  });

  it('renders plan rows with the done/total fraction and the active-count badge', () => {
    planListResult = {
      data: {
        plans: [
          plan({ slug: 'auth', title: 'Auth refactor', status: 'active' }),
          plan({ slug: 'shipped', title: 'Old', status: 'shipped' }),
          plan({ slug: 'going', title: 'In flight', status: 'ready', startStatus: 'started' }),
        ],
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
    render(<AdvOverviewTab />);
    const authTitle = screen.getByText('Auth refactor');
    expect(authTitle).toBeTruthy();
    expect(getComputedStyle(authTitle).textAlign).toBe('left');
    expect(screen.getByText('In flight')).toBeTruthy();
    expect(screen.queryByText('Old')).toBeNull();
    // both visible plans carry the same 2/4 item counts
    expect(screen.getAllByText('2/4')).toHaveLength(2);
    // count badge = active + started
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('surfaces decision-tier attention items with harness tags and the alert badge count', () => {
    attentionResult = {
      data: {
        groups: [
          {
            items: [
              attn({ id: 'd1', tier: 'decision', title: 'Approve the migration', harnessSlug: 'papercup' }),
              attn({ id: 'a1', tier: 'alert', title: 'smoke failed' }),
              attn({ id: 'a2', tier: 'alert', title: 'escalation' }),
            ],
          },
        ],
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
    render(<AdvOverviewTab />);
    expect(screen.getByText('Approve the migration')).toBeTruthy();
    expect(screen.getByText('papercup')).toBeTruthy();
    const alerts = screen.getByRole('button', { name: 'Open alerts' });
    expect(alerts.textContent).toContain('2');
    expect(alerts.getAttribute('data-has-alerts')).toBe('true');
  });

  it('dedupes a non-plan-scoped attention item repeated across groups (WI-5337 / EI-19373923898562595)', () => {
    // A cross-plan item (owner-wall, loop-carry-note) is present in every
    // group server-side — same shape the live suite reproduced (6 duplicate
    // React-key console errors). A bare flatMap would render it once per
    // group; flattenAttentionItems must collapse it to exactly one.
    const dup = attn({ id: 'owner-wall:loop-carry-note:su-x', tier: 'decision', title: 'Carry note pending' });
    attentionResult = {
      data: {
        groups: [
          { items: [dup] },
          { items: [dup] },
          { items: [dup, attn({ id: 'a1', tier: 'alert', title: 'smoke failed' })] },
        ],
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
    render(<AdvOverviewTab />);
    expect(screen.getAllByText('Carry note pending')).toHaveLength(1);
    // The alert count also reads off the same deduped list — 1 alert, not 3.
    const alerts = screen.getByRole('button', { name: 'Open alerts' });
    expect(alerts.textContent).toContain('1');
  });

  it('renders running roster agents (advRoster.list, server liveness) and coord-stream activity', async () => {
    rosterResult = {
      data: [{
        active: [
          rosterEntry({ ownerId: 'o1', intent: 'wiring the sync query', role: 'worker', liveness: 'live' }),
          rosterEntry({ ownerId: 'o2', label: 'architect-1', intent: '', liveness: 'idle' }),
          rosterEntry({ ownerId: 'o3', intent: 'gone', liveness: 'stale' }), // not running → excluded
          rosterEntry({ ownerId: 'o4', intent: 'looping', liveness: 'stale', loopArmed: true }), // loop-armed → included
        ],
      }],
      loading: false,
    };
    activityResult = {
      data: [feedRow({ msg_id: 'act1', from: 'worker', kind: 'message', summary: 'listed the plans' })],
      loading: false,
    };
    render(<AdvOverviewTab />);
    expect(await screen.findByText('wiring the sync query')).toBeTruthy();
    expect(screen.getByText('architect-1')).toBeTruthy(); // label fallback when no intent
    expect(screen.getByText('looping')).toBeTruthy(); // isRunningAgent: stale-but-loop-armed stays
    expect(screen.queryByText('gone')).toBeNull(); // stale + no loop → excluded
    // 'worker' appears as both the roster role tag and the activity actor.
    expect(screen.getAllByText('worker').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('listed the plans')).toBeTruthy();
  });

  it('falls back to `kind` for an activity row with no summary/body', async () => {
    activityResult = {
      data: [feedRow({ msg_id: 'act2', from: 'mug', kind: 'handoff', summary: null, body: null })],
      loading: false,
    };
    render(<AdvOverviewTab />);
    expect(await screen.findByText('handoff')).toBeTruthy();
    expect(screen.getByText('mug')).toBeTruthy();
  });

  it('rolls workItems.stats cells into per-kind rows with an OPEN headline count (owner ask 2026-07-19)', () => {
    statsResult = {
      data: [
        { kind: 'bug', state: 'open', n: 4, terminal: false },
        { kind: 'bug', state: 'resolved', n: 10, terminal: true },
        { kind: 'change', state: 'open', n: 2, terminal: false },
      ],
      loading: false,
    };
    render(<AdvOverviewTab />);
    // Kinds render via the canonical KindPill (owner ask 2026-07-19: per-kind
    // icons everywhere) — capitalized table labels, not raw wire names.
    expect(screen.getByText('Bug')).toBeTruthy();
    expect(screen.getByText('4 open · 14 all')).toBeTruthy();
    expect(screen.getByText('Change')).toBeTruthy();
    expect(screen.getByText('2 open · 2 all')).toBeTruthy();
    // no deltas → no 24h headline row and no +/− suffixes
    expect(screen.queryByText(/24h/)).toBeNull();
  });

  it('renders the 24h burn-down headline + per-kind +N/−N suffixes from workItems.delta24h (P-002)', () => {
    statsResult = {
      data: [
        { kind: 'bug', state: 'open', n: 4, terminal: false },
        { kind: 'change', state: 'open', n: 2, terminal: false },
      ],
      loading: false,
    };
    deltaResult = {
      data: [
        { kind: 'bug', opened: 3, closed: 9 },
        { kind: 'task', opened: 0, closed: 2 },
      ],
      loading: false,
    };
    render(<AdvOverviewTab />);
    // headline sums ALL kinds (bug 3/9 + task 0/2), not just rendered rows
    expect(screen.getByText('+3 opened · −11 closed')).toBeTruthy();
    expect(screen.getByText('4 open · 4 all · +3/−9')).toBeTruthy();
    // a kind with no delta keeps the plain tag
    expect(screen.getByText('2 open · 2 all')).toBeTruthy();
  });

  it('shows only warn/crit health panels, crit first; an all-ok snapshot reads healthy (owner ask 2026-07-19)', () => {
    healthResult = {
      data: [
        {
          overall: 'warn',
          panels: {
            queen: { key: 'queen', label: 'Queen', status: 'ok', summary: 'looping' },
            deploy: { key: 'deploy', label: 'Deploy', status: 'warn', summary: 'gate red 2 ticks' },
            infra: { key: 'infra', label: 'Infra', status: 'crit', summary: 'pg pool saturated' },
          },
        },
      ],
      loading: false,
    };
    render(<AdvOverviewTab />);
    expect(screen.getByText('Infra — pg pool saturated')).toBeTruthy();
    expect(screen.getByText('Deploy — gate red 2 ticks')).toBeTruthy();
    expect(screen.queryByText(/Queen — /)).toBeNull(); // ok panels stay out of the way
  });

  it('surfaces the infra-liveness/PSI condition class on the Health tile — the coord-alarm signals ride the SAME snapshot (P-006 audit pin)', () => {
    // The [infra-liveness] coord alarms (PER-THREAD WEDGE / REAPER WEDGED) are
    // DERIVED from health.snapshot's panels (liveness-alarm.ts reads
    // health.panels.*) — so a crit panel here IS the active condition, and the
    // tile showing warn/crit panels IS the fold. This test pins that with the
    // real panel summaries so the coverage can't silently regress.
    healthResult = {
      data: [
        {
          overall: 'crit',
          panels: {
            infra: {
              key: 'infra',
              label: 'Infra',
              status: 'crit',
              summary: 'PER-THREAD WEDGE: PSI memory full avg60 6.6% ≥ 5 — tasks stalled on memory reclaim/swap',
            },
            workItems: {
              key: 'workItems',
              label: 'Work items',
              status: 'warn',
              summary: '2000 items — 1 stuck — REAPER WEDGED',
            },
            queen: { key: 'queen', label: 'Mug', status: 'ok', summary: 'looping' },
          },
        },
      ],
      loading: false,
    };
    render(<AdvOverviewTab />);
    expect(screen.getByText(/Infra — PER-THREAD WEDGE: PSI memory full/)).toBeTruthy();
    expect(screen.getByText(/Work items — 2000 items — 1 stuck — REAPER WEDGED/)).toBeTruthy();
    expect(screen.queryByText(/Mug — looping/)).toBeNull(); // ok panels stay off the tile
  });

  it('renders the learning release-gate verdict + bars from learning.releaseReadiness (owner ask 2026-07-19)', () => {
    readinessResult = {
      data: [
        {
          report: {
            verdict: 'incomplete',
            passed: 1,
            criteria: [
              { key: 'routed-ideas', status: 'pass' },
              { key: 'win-rate', status: 'fail' },
            ],
          },
        },
      ],
      loading: false,
    };
    render(<AdvOverviewTab />);
    expect(screen.getByText('release gate: incomplete')).toBeTruthy();
    expect(screen.getByText('1/2 bars')).toBeTruthy();
    expect(screen.getByText('routed-ideas')).toBeTruthy();
    expect(screen.getByText('win-rate')).toBeTruthy();
  });

  it('renders the Deploy tile from dev.gitPipeline: gate line, judging tag, refs, and the git deep-link (P-001)', async () => {
    pipelineResult = {
      data: [
        {
          gitSync: { headSha: 'aaaa111122223333', lastSyncedAtMs: Date.now() - 60_000 },
          gate: {
            consecutiveReds: 2,
            stalled: false,
            verdictStale: false,
            verdictObservedAtMs: Date.now() - 8 * 60_000,
            lastGreenAtMs: Date.now() - 60 * 60_000,
            failingTests: ['x.test.ts', 'y.test.ts', 'z.test.ts'],
          },
          activeRun: { active: true, candidate: '06a0eb9577dead', elapsedSec: 300 },
          deploy: {
            stagingHead: { sha: 'aaaa111122223333' },
            greenPin: { sha: 'bbbb444455556666' },
            deployed: { sha: 'cccc777788889999' },
            deployedAtMs: Date.now() - 3 * 60 * 60_000,
            greenPinBehindStaging: 4,
            deployedBehindGreenPin: 1,
          },
        },
      ],
      loading: false,
    };
    render(<AdvOverviewTab />);
    expect(screen.getByText(/gate RED — 3 failing/)).toBeTruthy();
    expect(screen.getByText(/judging 06a0eb95/)).toBeTruthy();
    expect(screen.getByText('aaaa1111')).toBeTruthy();
    expect(screen.getByText('bbbb4444')).toBeTruthy();
    expect(screen.getByText('cccc7777')).toBeTruthy();
    expect(screen.getByText('+4 unjudged')).toBeTruthy();
    expect(screen.getByText('1 behind green')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Deploy' }));
    await waitFor(() => expect(nuqsSetters.tab).toHaveBeenCalledWith('git'));
  });

  it('renders the Spend tile: 1h/24h headline, per-account utilization, and the accounts-rail deep-link (P-003)', async () => {
    spendResult = { data: [{ h1: { spendUsd: 1.23, calls: 42 }, h24: { spendUsd: 18.4, calls: 900 } }], loading: false };
    accountsResult = {
      data: [
        {
          id: 'max-1',
          label: 'Max A',
          provider: 'anthropic',
          available: true,
          usageWalled: false,
          edgeThrottled: false,
          rate: { pausedUntil: 0, utilization: 0.62, utilization7d: 0.4 },
        },
        {
          id: 'max-2',
          label: 'Max B',
          provider: 'anthropic',
          available: false,
          usageWalled: true,
          edgeThrottled: false,
          rate: { pausedUntil: 0, utilization: 1.02 },
        },
      ],
      loading: false,
    };
    render(<AdvOverviewTab />);
    expect(screen.getByText('$1.23 1h · $18.40 24h')).toBeTruthy();
    // most-burned first, walled state surfaced on the tag
    expect(screen.getByText('102% · walled')).toBeTruthy();
    expect(screen.getByText('62%')).toBeTruthy();
    // unavailable-count badge (1 walled account)
    expect(screen.getByText('1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Spend' }));
    await waitFor(() => expect(nuqsSetters.__states).toHaveBeenCalledWith({ lsb: true, lst: 'accounts' }));
  });

  it('renders the Operator-report tile: title+excerpt, narrative label, ages, and the inbox deep-link (P-004)', async () => {
    reportsResult = {
      data: [
        {
          turnId: 't-1',
          conversationId: 'c-1',
          createdAt: Date.now() - 20 * 60_000,
          title: 'Overnight status',
          excerpt: 'All lanes green; two items deferred',
          planCount: 2,
        },
        {
          turnId: 't-0',
          conversationId: 'c-1',
          createdAt: Date.now() - 5 * 60 * 60_000,
          title: 'Earlier report',
          excerpt: null,
          planCount: 1,
        },
      ],
      loading: false,
    };
    render(<AdvOverviewTab />);
    // newest report carries the excerpt inline + the explicit narrative label
    expect(screen.getByText('Overnight status — All lanes green; two items deferred')).toBeTruthy();
    expect(screen.getByText('narrative')).toBeTruthy();
    expect(screen.getByText('20m ago')).toBeTruthy();
    // older reports render title + age only
    expect(screen.getByText('Earlier report')).toBeTruthy();
    expect(screen.getByText('5h ago')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Operator report' }));
    await waitFor(() => expect(nuqsSetters.tab).toHaveBeenCalledWith('plans'));
    expect(nuqsSetters.inboxTier).toHaveBeenCalledWith('activity');
  });

  it('shows the Agents loading state while advRoster.list is in flight', () => {
    rosterResult = { data: undefined, loading: true };
    render(<AdvOverviewTab />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('a plan row click deep-links the Plans tab to that plan (WI-5517)', async () => {
    planListResult = {
      data: { plans: [plan({ slug: 'auth', title: 'Auth refactor', status: 'active' })] },
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
    render(<AdvOverviewTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Open plan Auth refactor' }));
    await waitFor(() => expect(nuqsSetters.plan).toHaveBeenCalledWith('auth'));
    expect(nuqsSetters.tab).toHaveBeenCalledWith('plans');
  });

  it('an agent row click opens the Agents-running dropdown focused on that agent (WI-5517)', async () => {
    rosterResult = {
      data: [{ active: [rosterEntry({ ownerId: 'su-abc', intent: 'building the thing', liveness: 'live' })] }],
      loading: false,
    };
    render(<AdvOverviewTab />);
    fireEvent.click(screen.getByRole('button', { name: /session history/ }));
    await waitFor(() => expect(nuqsSetters.agentsFocus).toHaveBeenCalledWith('su-abc'));
    expect(nuqsSetters.agentsRoster).toHaveBeenCalledWith(true);
  });

  it('an activity row click deep-links the event into Conversations → Raw events (WI-5517)', async () => {
    activityResult = {
      data: [feedRow({ msg_id: 'msg-9', from: 'worker', summary: 'finished WI-1' })],
      loading: false,
    };
    render(<AdvOverviewTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Open this event in Conversations' }));
    await waitFor(() =>
      expect(nuqsSetters.__states).toHaveBeenCalledWith({ conv: 'feed', fmsg: 'msg-9', fsys: 'all' }),
    );
    expect(nuqsSetters.tab).toHaveBeenCalledWith('conversations');
  });

  it('clicking a tile open button writes the target tab to the URL', () => {
    render(<AdvOverviewTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Plans' }));
    expect(nuqsSetters.tab).toHaveBeenCalledWith('plans');
    fireEvent.click(screen.getByRole('button', { name: 'Open Agents' }));
    expect(nuqsSetters.tab).toHaveBeenCalledWith('harnesses');
  });

  it('Portal tiles select their mapped app instead of the desktop tab', () => {
    configureOperatorUi({ advNavigation: { param: 'app', targets: ADV_TAB_SURFACE_KINDS } });
    render(<AdvOverviewTab />);
    for (const [label, target] of [['Plans', 'create'], ['Agents', 'work'], ['Activity', 'conversations'],
      ['Work items', 'work'], ['Deploy', 'git'], ['Health', 'health'], ['Learning', 'learning']]) {
      fireEvent.click(screen.getByRole('button', { name: `Open ${label}` }));
      expect(nuqsSetters.app).toHaveBeenLastCalledWith(target);
    }
    expect(nuqsSetters.tab).toBeUndefined();
  });

  it('Portal row navigation keeps the selected plan and exact activity event', async () => {
    configureOperatorUi({ advNavigation: { param: 'app', targets: ADV_TAB_SURFACE_KINDS } });
    planListResult = { data: { plans: [plan({ slug: 'auth', title: 'Auth refactor', status: 'active' })] },
      loading: false, error: null, refresh: vi.fn() };
    activityResult = { data: [feedRow({ msg_id: 'msg-9', from: 'worker', summary: 'finished WI-1' })], loading: false };
    render(<AdvOverviewTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Open plan Auth refactor' }));
    await waitFor(() => expect(nuqsSetters.plan).toHaveBeenCalledWith('auth'));
    expect(nuqsSetters.app).toHaveBeenLastCalledWith('create');
    fireEvent.click(screen.getByRole('button', { name: 'Open this event in Conversations' }));
    await waitFor(() => expect(nuqsSetters.__states).toHaveBeenCalledWith({ conv: 'feed', fmsg: 'msg-9', fsys: 'all' }));
    expect(nuqsSetters.app).toHaveBeenLastCalledWith('conversations');
    expect(nuqsSetters.tab).toBeUndefined();
  });

  it('the alerts button deep-links the inbox alert tier (sequential writes)', async () => {
    render(<AdvOverviewTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Open alerts' }));
    await waitFor(() => expect(nuqsSetters.inboxTier).toHaveBeenCalledWith('alert'));
    expect(nuqsSetters.tab).toHaveBeenCalledWith('plans');
  });

  it('the Needs-you open button deep-links the decision tier', async () => {
    render(<AdvOverviewTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Needs you' }));
    await waitFor(() => expect(nuqsSetters.inboxTier).toHaveBeenCalledWith('decision'));
    expect(nuqsSetters.tab).toHaveBeenCalledWith('plans');
  });

  it('shows the loading state while a query is in flight without data', () => {
    planListResult = { data: undefined, loading: true, error: null, refresh: vi.fn() };
    render(<AdvOverviewTab />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('shows a query error in the tile body', () => {
    attentionResult = { data: undefined, loading: false, error: 'attention exploded', refresh: vi.fn() };
    render(<AdvOverviewTab />);
    expect(screen.getByText('attention exploded')).toBeTruthy();
  });
});
