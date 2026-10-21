// @vitest-environment jsdom
//
// PlanDashboard render (plan-visibility-revamp-2026-08-23 P-003): the option-C
// app-pane surface — header (bucket/title/✎⚒ meta/progress/needs-you),
// Working-now session cards (planSessions.list ⋈ advRoster.list), the
// Recent-activity feed (planActivity.list), and the action wiring (back,
// Open full plan → ?wppop, Search transcripts → ?wppop+?ppv, Launch agent,
// Open session → ?pdsess, work-row deep link → ?wpop). Data hooks are mocked;
// nuqs is a seeded store (same seams as PlansPane.test.tsx).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PlanGetResult, PlanItem } from '@/app/admin/plans/plans-api';

const {
  nuqs,
  setters,
  setQueryStatesSpy,
  planData,
  attentionItems,
  syncData,
  launchAgentSpy,
  beginInteractionSpy,
  markInteractionPhaseSpy,
  preloadVditorSpy,
  preloadPlanPopupSpy,
  preparePlanDocumentSpy,
  toastSpies,
  cleanupFlag,
} = vi.hoisted(() => ({
  nuqs: {} as Record<string, unknown>,
  setters: {} as Record<string, ReturnType<typeof vi.fn>>,
  setQueryStatesSpy: vi.fn(async (values: Record<string, unknown>) => {
    Object.assign(nuqs, values);
  }),
  // plans-list-windowing-cardinality-fix-2026-08-30 P-003: this surface reads
  // its OWN plan via a targeted `usePlan(slug, {live:true})` fetch now, not a
  // slice of the shared `plans.list` cache — so the fixture is a single
  // `PlanGetResult`, not a `{ plans: [...] }` collection.
  planData: { value: null as PlanGetResult | null },
  attentionItems: {
    value: [] as Array<{ planSlug: string | null; tier: string }>,
  },
  // Branched by queryName — the dashboard runs FOUR sync queries; a
  // queryName-blind mock would cross-feed them (the PlansPane P-002 lesson).
  syncData: {
    value: {} as Record<string, { data: unknown[]; loading?: boolean }>,
  },
  launchAgentSpy: vi.fn(async (_a?: unknown) => ({ ok: true as const })),
  beginInteractionSpy: vi.fn(),
  markInteractionPhaseSpy: vi.fn(),
  preloadVditorSpy: vi.fn(() => Promise.resolve(true)),
  preloadPlanPopupSpy: vi.fn(() => Promise.resolve({})),
  preparePlanDocumentSpy: vi.fn(() => Promise.resolve(true)),
  toastSpies: { success: vi.fn(), error: vi.fn() },
  cleanupFlag: { value: true },
}));
function mkSetter(key: string) {
  if (!setters[key]) setters[key] = vi.fn(async (v: unknown) => { nuqs[key] = v; });
  return setters[key];
}

import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string, parser?: { _d?: unknown }) => [
    nuqs[key] !== undefined ? nuqs[key] : (parser?._d ?? null),
    mkSetter(key),
  ],
  useQueryStates: (parsers: Record<string, { _d?: unknown }>) => [
    Object.fromEntries(
      Object.entries(parsers).map(([key, parser]) => [
        key,
        nuqs[key] !== undefined ? nuqs[key] : (parser?._d ?? null),
      ]),
    ),
    setQueryStatesSpy,
  ],
  parseAsString: { withDefault: (d: unknown) => ({ _d: d }) },
}));
/* ⚠ SPREAD THE ORIGINAL, never a from-scratch factory: operator-core's
   `lib/lazy-with-retry` RE-EXPORTS from `@papercusp/sync`, and PlansPane (which
   PlanDashboard imports for agoLabel/progressOf) reaches it through
   PlanDashboardHost's module-scope `lazy(...)` call. A partial mock makes that
   binding undefined and the whole suite fails to COLLECT with
   "lazyWithRetry is not a function" — exactly what red-flagged this file in the
   2026-08-23 P-003/P-005 affected run. */
vi.mock('@papercusp/sync', async (orig) => ({
  ...(await orig<typeof import('@papercusp/sync')>()),
  onSyncBusEvent: () => () => {},
  useSyncQuery: ({ queryName }: { queryName: string }) => ({
    data: syncData.value[queryName]?.data ?? [],
    loading: syncData.value[queryName]?.loading ?? false,
    error: null,
    invalidate: vi.fn(),
  }),
}));
vi.mock('@/lib/use-workspace-id', () => ({ useWorkspaceId: () => 'ws-1' }));
vi.mock('@/lib/flag-hooks', () => ({ useFlag: () => cleanupFlag.value }));
// Keep bucketOf real — only stub the data hook.
vi.mock('@/app/admin/plans/plans-api', async (orig) => ({
  ...(await orig<typeof import('@/app/admin/plans/plans-api')>()),
  usePlan: () => ({
    data: planData.value,
    loading: planData.value === null,
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock('../inbox/use-inbox-pending', () => ({
  effectiveTier: (i: { tier?: string }) => i.tier ?? 'activity',
  useInboxAttention: () => ({ items: attentionItems.value, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock('@papercusp/operator-core/lib/launch-agent', () => ({
  launchAgent: (a: unknown) => launchAgentSpy(a),
}));
vi.mock('../perf/perf-marks', () => ({
  beginInteraction: beginInteractionSpy,
  markInteractionPhase: markInteractionPhaseSpy,
  PERF_INTERACTIONS: { planPopupOpen: 'plan-popup-open' },
}));
vi.mock('@/app/_components/MarkdownEditor', () => ({
  preloadVditor: preloadVditorSpy,
}));
vi.mock('../chat/ChatRefPopupHost', () => ({
  preloadPlanPopupModal: preloadPlanPopupSpy,
}));
vi.mock('@papercusp/ui-primitives', async (importOriginal) => ({
  ...await importOriginal<typeof import('@papercusp/ui-primitives')>(),
  preparePlanDocument: preparePlanDocumentSpy,
}));
vi.mock('sonner', () => ({ toast: toastSpies }));
// The session chat is a heavy modal stack — assert the prop seam only.
vi.mock('../chat/SessionChatModal', () => ({
  default: ({ sessionOwnerId }: { sessionOwnerId: string | null }) =>
    sessionOwnerId ? <div data-testid="session-chat-open">{sessionOwnerId}</div> : null,
}));

import PlanDashboard, { avatarColor, shortOwnerId } from './PlanDashboard';

/** N stub `PlanItem`s per requested `effectiveStatus` — the `plans:get`
 *  full-mode row list this surface derives progress from (P-003), in place
 *  of the pre-aggregated `itemCounts` histogram the old `plans.list`-backed
 *  fixture used. `{done:3, todo:6}` → 9 items, 3 of them `effectiveStatus:
 *  'done'` — the same "3 of 9 items done" the header asserts. */
function itemsOf(counts: Record<string, number>): PlanItem[] {
  const out: PlanItem[] = [];
  let i = 0;
  for (const [status, n] of Object.entries(counts)) {
    for (let k = 0; k < n; k++) {
      i += 1;
      out.push({
        id: `P-${String(i).padStart(3, '0')}`,
        storedStatus: status as PlanItem['storedStatus'],
        effectiveStatus: status as PlanItem['effectiveStatus'],
        text: `item ${i}`,
      });
    }
  }
  return out;
}

function plan(over: {
  slug: string;
  title?: string;
  status?: PlanGetResult['status'];
  startStatus?: PlanGetResult['startStatus'];
  updated?: string;
  harness?: string;
  items?: PlanItem[];
  now?: PlanGetResult['now'];
  derivedStatus?: PlanGetResult['derivedStatus'];
  decisions?: PlanGetResult['decisions'];
  linkedFeatures?: PlanGetResult['linkedFeatures'];
}): PlanGetResult {
  return {
    slug: over.slug,
    title: over.title ?? over.slug,
    status: over.status ?? 'active',
    startStatus: over.startStatus,
    archived: false,
    legacy: false,
    harness: over.harness ?? 'papercusp',
    // `updated` is a `## Now`-adjacent frontmatter field on `plans:get`, not a
    // top-level `PlanGetResult` field (unlike `plans.list`'s `PlanListRow`) —
    // mirror the real shape so PlanDashboard's `frontmatter?.updated` read is
    // exercised, not bypassed.
    frontmatter: { updated: over.updated ?? new Date(Date.now() - 2 * 60_000).toISOString() },
    items: over.items ?? [],
    now: over.now,
    derivedStatus: over.derivedStatus,
    decisions: over.decisions,
    linkedFeatures: over.linkedFeatures,
  };
}

const OWNER_A = 'su-76a83f00-1111-2222-3333-444455556666';
const OWNER_B = 'su-82be7d00-aaaa-bbbb-cccc-ddddeeeeffff';

function seed(opts?: {
  liveSessions?: boolean;
  activity?: boolean;
  needsYou?: boolean;
  worked?: boolean;
}) {
  planData.value = plan({
    slug: 'p1',
    title: 'Security posture closure',
    startStatus: 'started',
    items: itemsOf({ done: 3, todo: 6 }),
  });
  attentionItems.value = opts?.needsYou
    ? [
        { planSlug: 'p1', tier: 'decision' },
        { planSlug: 'p1', tier: 'activity' }, // non-decision — must not count
        { planSlug: 'other', tier: 'decision' }, // other plan — must not count
      ]
    : [];
  syncData.value = {
    'planWorkActivity.list': {
      data: opts?.worked === false ? [] : [{ slug: 'p1', lastWorkAtMs: Date.now() - 41_000 }],
    },
    'planSessions.list': {
      data: opts?.liveSessions === false
        ? []
        : [
            {
              coordOwnerId: OWNER_A,
              sessionId: 's-1',
              agent: 'claude',
              role: 'su',
              label: 'lane A',
              startedAt: new Date(Date.now() - 3_600_000).toISOString(),
              endedAt: null,
              live: true,
              via: 'plan',
            },
            {
              coordOwnerId: OWNER_B,
              sessionId: 's-2',
              agent: 'codex',
              role: 'su',
              label: null,
              startedAt: new Date(Date.now() - 7_200_000).toISOString(),
              endedAt: null,
              live: true,
              via: 'claim',
            },
            {
              coordOwnerId: 'su-dead0000-0000-0000-0000-000000000000',
              sessionId: 's-3',
              agent: 'claude',
              role: 'su',
              label: null,
              startedAt: new Date(Date.now() - 9_000_000).toISOString(),
              endedAt: new Date(Date.now() - 8_000_000).toISOString(),
              live: false, // ended — must NOT render a card
              via: 'plan',
            },
          ],
    },
    'advRoster.list': {
      data: [
        {
          active: [
            {
              ownerId: OWNER_A,
              intent: 'Recording D-001 — reuse route-tier auth',
              sessionState: 'live',
              lastActiveAt: new Date(Date.now() - 41_000).toISOString(),
              agent: 'claude',
            },
            {
              ownerId: OWNER_B,
              intent: 'Holds WI-40971 open',
              sessionState: 'parked',
              lastActiveAt: new Date(Date.now() - 3_600_000).toISOString(),
              agent: 'codex',
            },
          ],
        },
      ],
    },
    'planActivity.list': {
      data: opts?.activity === false
        ? []
        : [
            {
              kind: 'work',
              tsMs: Date.now() - 41_000,
              text: 'WI-40729 wip — serializer verified',
              who: OWNER_A,
              ref: 'WI-40729',
            },
            {
              kind: 'edit',
              tsMs: Date.now() - 120_000,
              text: 'Plan edited (rev 12)',
              who: OWNER_A,
              ref: 'rev:12',
            },
          ],
    },
  };
}

function renderDash(onBack = vi.fn()) {
  const utils = render(
    <PlanDashboard planSlug="p1" harnessSlug="papercusp" onBack={onBack} />,
  );
  return { onBack, ...utils };
}

afterEach(() => {
  cleanup();
  for (const k of Object.keys(nuqs)) delete nuqs[k];
  for (const setter of Object.values(setters)) setter.mockClear();
  setQueryStatesSpy.mockClear();
  launchAgentSpy.mockClear();
  beginInteractionSpy.mockClear();
  markInteractionPhaseSpy.mockClear();
  preloadVditorSpy.mockClear();
  preloadPlanPopupSpy.mockReset().mockResolvedValue({});
  preparePlanDocumentSpy.mockReset().mockResolvedValue(true);
  toastSpies.success.mockClear();
  toastSpies.error.mockClear();
  cleanupFlag.value = true;
  vi.unstubAllGlobals();
});

describe('PlanDashboard header', () => {
  it('warms popup code independently of a click and marks only successful preparation', async () => {
    const mark = vi.fn();
    vi.stubGlobal('performance', { mark, clearMarks: vi.fn() });
    let finish!: (module: {}) => void;
    preloadPlanPopupSpy.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    seed();
    renderDash();
    expect(preloadPlanPopupSpy).toHaveBeenCalledTimes(1);
    expect(setQueryStatesSpy).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalledWith('plan-dashboard-popup-module-ready-success-v1');
    finish({});
    await waitFor(() => expect(mark).toHaveBeenCalledWith('plan-dashboard-popup-module-ready-success-v1'));
  });

  it('leaves failed popup warm-up to the click retry and ignores completion after unmount', async () => {
    const mark = vi.fn();
    vi.stubGlobal('performance', { mark, clearMarks: vi.fn() });
    preloadPlanPopupSpy.mockRejectedValueOnce(new Error('chunk unavailable'));
    seed();
    const failed = renderDash();
    await Promise.resolve();
    await Promise.resolve();
    expect(mark).not.toHaveBeenCalledWith('plan-dashboard-popup-module-ready-success-v1');
    failed.unmount();
    let finish!: (module: {}) => void;
    preloadPlanPopupSpy.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = renderDash();
    pending.unmount();
    finish({});
    await Promise.resolve();
    expect(mark).not.toHaveBeenCalledWith('plan-dashboard-popup-module-ready-success-v1');
  });
  it('prepares the exact read body from its existing live plan query and refreshes changed content', async () => {
    const mark = vi.fn();
    vi.stubGlobal('performance', { mark, clearMarks: vi.fn() });
    seed();
    planData.value!.raw = '---\ntitle: First\n---\n# First';
    const mounted = renderDash();
    await waitFor(() => expect(preparePlanDocumentSpy).toHaveBeenCalledWith('# First'));
    await waitFor(() => expect(mark).toHaveBeenCalledWith('plan-dashboard-document-ready-success-v1'));
    planData.value!.raw = '---\ntitle: Next\n---\n# Next';
    mounted.rerender(<PlanDashboard planSlug="p1" harnessSlug="papercusp" onBack={mounted.onBack} />);
    await waitFor(() => expect(preparePlanDocumentSpy).toHaveBeenLastCalledWith('# Next'));
  });

  it('does not mark document readiness after a failed or superseded preparation', async () => {
    const mark = vi.fn();
    vi.stubGlobal('performance', { mark, clearMarks: vi.fn() });
    let finish!: (value: boolean) => void;
    preparePlanDocumentSpy.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    preparePlanDocumentSpy.mockResolvedValueOnce(false);
    seed();
    planData.value!.raw = '# Old';
    const mounted = renderDash();
    planData.value!.raw = '# Failed';
    mounted.rerender(<PlanDashboard planSlug="p1" harnessSlug="papercusp" onBack={mounted.onBack} />);
    finish(true);
    await Promise.resolve();
    expect(mark.mock.calls.some(([name]) => name === 'plan-dashboard-document-ready-success-v1')).toBe(false);
  });

  it('marks Vditor ready only after the independently deep-linkable dashboard warms it', async () => {
    const mark = vi.fn();
    const clearMarks = vi.fn();
    vi.stubGlobal('performance', { mark, clearMarks });
    seed();
    renderDash();
    expect(preloadVditorSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(clearMarks).toHaveBeenCalledWith('plan-dashboard-vditor-ready-success-v1');
      expect(mark).toHaveBeenCalledWith('plan-dashboard-vditor-ready-success-v1');
    });
  });

  it('does not publish warm readiness when the Vditor preload attempt fails', async () => {
    const mark = vi.fn();
    vi.stubGlobal('performance', { mark, clearMarks: vi.fn() });
    preloadVditorSpy.mockResolvedValueOnce(false);
    seed();
    renderDash();
    await waitFor(() => expect(preloadVditorSpy).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(mark).not.toHaveBeenCalledWith('plan-dashboard-vditor-ready-success-v1');
  });

  it('renders title, bucket, ✎/⚒ meta, progress and the needs-you line', () => {
    seed({ needsYou: true });
    renderDash();
    expect(screen.getByText('Security posture closure')).toBeTruthy();
    // startStatus 'started' + active ⇒ bucketOf = running, rendered as "plan".
    expect(screen.getByText('plan')).toBeTruthy();
    expect(screen.getByTestId('plan-dash-edit-t').textContent).toContain('edited 2m');
    // ⚒ worked 41s ago ⇒ "now" bucket, hot (< 1h).
    const workT = screen.getByTestId('plan-dash-work-t');
    expect(workT.textContent).toContain('worked now');
    expect(workT.className).toContain('plan-dash__t--hot');
    expect(screen.getByTestId('plan-dash-progress').textContent).toBe('3 of 9 items done');
    // Exactly ONE decision-tier item on THIS plan counts.
    expect(screen.getByTestId('plan-dash-needs').textContent).toBe('1 decision needs you');
  });

  it('renders the dim never-worked ⚒ and omits needs-you when zero', () => {
    seed({ worked: false, needsYou: false });
    renderDash();
    const workT = screen.getByTestId('plan-dash-work-t');
    expect(workT.textContent).toContain('worked —');
    expect(workT.className).toContain('plan-dash__t--dim');
    expect(screen.queryByTestId('plan-dash-needs')).toBeNull();
  });

  it('renders sanely when the plan is not (yet) resolved by its own targeted fetch', () => {
    // plans-list-windowing-cardinality-fix-2026-08-30 P-003 regression guard:
    // this surface used to derive `plan` via
    // `usePlanList({}).data.plans.find((p) => p.slug === planSlug)` — a plan
    // absent from that SHARED, potentially windowed/truncated harness-wide
    // list (e.g. a large harness's `plans.list` returning only a bounded
    // slice) silently produced `plan: null` even though the plan genuinely
    // existed. Now `plan` comes from its OWN targeted `usePlan(slug,
    // {live:true})` fetch, so "not present in some other list's window" can
    // no longer be the reason this surface can't find its own plan — the
    // only way `plan` is null here is the dedicated fetch itself not having
    // resolved yet (or a real 404), which this asserts degrades gracefully:
    // title falls back to the slug, no bucket/progress render, nothing
    // throws — rather than replaying the old cache-shape-coincidence bug.
    seed({ activity: false, liveSessions: false });
    planData.value = null;
    renderDash();
    expect(screen.getByText('p1')).toBeTruthy();
    expect(screen.queryByText('plan')).toBeNull();
    expect(screen.queryByTestId('plan-dash-progress')).toBeNull();
    expect(screen.getByTestId('plan-dash-edit-t').textContent).toContain('edited —');
  });

  it('back clears ?pdsess and calls onBack', () => {
    seed();
    nuqs['pdsess'] = OWNER_A;
    const { onBack } = renderDash();
    fireEvent.click(screen.getByTestId('plan-dash-back'));
    expect(setters['pdsess']).toHaveBeenCalledWith(null);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('Open full plan starts timing before one atomic popup URL transition', () => {
    seed();
    renderDash();
    const primary = screen.getByTestId('plan-dash-open-full');
    expect(primary.className).toContain('pc-btn-primary');
    expect(screen.getByTestId('plan-dash-launch').className).not.toContain('pc-btn-primary');
    expect(screen.getByTestId('plan-dash-search-transcripts').className).not.toContain(
      'pc-btn-primary',
    );
    fireEvent.click(primary);
    expect(beginInteractionSpy).toHaveBeenCalledWith('plan-popup-open');
    expect(beginInteractionSpy.mock.invocationCallOrder[0]).toBeLessThan(
      setQueryStatesSpy.mock.invocationCallOrder[0]!,
    );
    expect(setQueryStatesSpy).toHaveBeenCalledTimes(1);
    expect(setQueryStatesSpy).toHaveBeenCalledWith({
      wppop: 'papercusp::p1',
      ppv: 'plan',
      jump: null,
    });
    expect(markInteractionPhaseSpy).toHaveBeenCalledWith(
      'plan-popup-open', 'popup-url-update-queued',
    );
    expect(markInteractionPhaseSpy.mock.invocationCallOrder[0]).toBeGreaterThan(
      setQueryStatesSpy.mock.invocationCallOrder[0]!,
    );
  });

  it('Search transcripts opens the popup onto its Sessions tab', () => {
    seed();
    renderDash();
    fireEvent.click(screen.getByTestId('plan-dash-search-transcripts'));
    expect(setQueryStatesSpy).toHaveBeenCalledTimes(1);
    expect(setQueryStatesSpy).toHaveBeenCalledWith({
      wppop: 'papercusp::p1',
      ppv: 'sessions',
      jump: null,
    });
  });

  it('starts a one-plan clean-up from the header and deep-links its run', async () => {
    seed();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input) === '/api/agent-config'
        ? {
            ok: true,
            json: async () => ({
              config: {
                resolverProfiles: {
                  'plan-cleanup': {
                    model: null,
                    effort: null,
                    account: 'default',
                    carry: 'warm',
                  },
                },
              },
            }),
          }
        : {
            ok: true,
            json: async () => ({
              ok: true,
              runId: 'cleanup-dash-1',
              launched: true,
              resolverNeeded: true,
            }),
          },
    );
    vi.stubGlobal('fetch', fetchMock);
    renderDash();

    const start = screen.getByTestId('plan-dash-cleanup') as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);

    await waitFor(() => expect(setters.opcln).toHaveBeenCalledWith('cleanup-dash-1'));
    const startCall = fetchMock.mock.calls.find(([url]) => url === '/api/admin/plan-cleanup')!;
    expect(JSON.parse((startCall[1] as RequestInit).body as string)).toEqual({
      op: 'start',
      planSlugs: ['p1'],
      filter: {
        scope: 'single-plan',
        entryPoint: 'plan-dashboard',
        shownCount: 1,
        planSlug: 'p1',
        harness: 'papercusp',
      },
      harness: 'papercusp',
      launch: { model: null, effort: null, account: 'default', carry: 'warm' },
    });
  });

  it('hides the header clean-up action when the plan-cleanup flag is off', () => {
    cleanupFlag.value = false;
    seed();
    renderDash();
    expect(screen.queryByTestId('plan-dash-cleanup')).toBeNull();
  });

  it('Launch agent fires the plan-bound launch', () => {
    seed();
    renderDash();
    fireEvent.click(screen.getByTestId('plan-dash-launch'));
    expect(launchAgentSpy).toHaveBeenCalledWith({
      slug: 'papercusp',
      planSlug: 'p1',
      label: 'plan · p1',
    });
  });
});

describe('PlanDashboard working-now cards', () => {
  it('renders one card per LIVE session, roster-enriched', () => {
    seed();
    renderDash();
    const grid = screen.getByTestId('plan-dash-sessions');
    expect(grid.querySelectorAll('.plan-dash__scard').length).toBe(2);
    // Ended session renders no card.
    expect(screen.queryByTestId('plan-dash-session-su-dead0000-0000-0000-0000-000000000000')).toBeNull();
    const a = screen.getByTestId(`plan-dash-session-${OWNER_A}`);
    expect(a.textContent).toContain('su-76a83');
    expect(a.textContent).toContain('claude');
    expect(a.textContent).toContain('live');
    expect(a.textContent).toContain('Recording D-001');
    expect(a.textContent).toContain('last active just now'); // 41s → "now" → agoPhrase
    const b = screen.getByTestId(`plan-dash-session-${OWNER_B}`);
    expect(b.textContent).toContain('parked');
    expect(b.textContent).toContain('idle 1h');
  });

  it('Open session writes ?pdsess and the chat modal mounts on it', () => {
    seed();
    renderDash();
    fireEvent.click(screen.getByTestId(`plan-dash-open-session-${OWNER_A}`));
    expect(setters['pdsess']).toHaveBeenCalledWith(OWNER_A);
    // The modal renders from the (seeded) param.
    cleanup();
    nuqs['pdsess'] = OWNER_A;
    seed();
    renderDash();
    expect(screen.getByTestId('session-chat-open').textContent).toBe(OWNER_A);
  });

  it('renders the empty state when no live sessions', () => {
    seed({ liveSessions: false });
    renderDash();
    expect(screen.getByTestId('plan-dash-no-sessions')).toBeTruthy();
  });
});

describe('PlanDashboard activity feed', () => {
  it('renders work + edit rows; only the work row deep-links to ?wpop', () => {
    seed();
    renderDash();
    const feed = screen.getByTestId('plan-dash-feed');
    expect(feed.querySelectorAll('.plan-dash__fitem').length).toBe(2);
    const workRow = screen.getByTestId('plan-dash-feed-ref-WI-40729');
    expect(workRow.tagName).toBe('BUTTON');
    fireEvent.click(workRow);
    expect(setters['wpop']).toHaveBeenCalledWith('papercusp::WI-40729');
    // The edit row is not a button (rev refs have no popup target).
    expect(screen.getByText('Plan edited (rev 12)').closest('button')).toBeNull();
  });

  it('renders the empty state when no activity', () => {
    seed({ activity: false });
    renderDash();
    expect(screen.getByTestId('plan-dash-no-activity')).toBeTruthy();
  });
});

describe('PlanDashboard direction-A surfaces (plan-dashboard-mission-control-2026-08-31)', () => {
  it("renders the Now card, the segmented band, and every decision as a full-detail action", () => {
    seed();
    planData.value = plan({
      slug: "p1",
      title: "Security posture closure",
      startStatus: "started",
      items: itemsOf({ done: 3, wip: 2, todo: 4 }),
      now: { state: "Closing the last leg.", next: "P-006 measure it" },
      decisions: [
        { id: "D-001", title: "Oldest ruling" },
        { id: "D-007", title: "Latest ruling" },
        { id: "D-003", title: "Middle ruling" },
      ],
    });
    renderDash();
    const now = screen.getByTestId("plan-dash-now");
    expect(now.textContent).toContain("Closing the last leg.");
    expect(now.textContent).toContain("next: P-006 measure it");
    // Band: count text (same testid/format as ever) + one segment per bucket.
    const band = screen.getByTestId("plan-dash-band");
    expect(screen.getByTestId("plan-dash-progress").textContent).toBe(
      "3 of 9 items done",
    );
    expect(band.querySelectorAll(".plan-dash__band-seg").length).toBe(3); // done, wip, todo
    expect(band.textContent).toContain("2 in progress");
    expect(band.textContent).toContain("nothing needs you");
    // Decisions: every D-entry stays available, newest first, and opens the
    // canonical full plan at its exact anchor.
    const dec = screen.getByTestId("plan-dash-decisions");
    const refs = Array.from(dec.querySelectorAll(".plan-dash__dref")).map(
      (n) => n.textContent,
    );
    expect(refs).toEqual(["D-007", "D-003", "D-001"]);
    expect(dec.textContent).toContain("3 decisions");
    fireEvent.click(screen.getByTestId("plan-dash-decision-D-001"));
    expect(setQueryStatesSpy).toHaveBeenCalledWith({
      wppop: "papercusp::p1",
      ppv: "plan",
      jump: "D-001",
    });
  });

  it("opens every P-item in the full plan and keeps a separate linked-work-item action", () => {
    seed();
    planData.value = plan({
      slug: "p1",
      startStatus: "started",
      items: [
        {
          id: "P-001",
          storedStatus: "done",
          effectiveStatus: "done",
          text: "shipped bit",
        },
        {
          id: "P-002",
          storedStatus: "wip",
          effectiveStatus: "wip",
          text: "active bit",
        },
        {
          id: "P-003",
          storedStatus: "todo",
          effectiveStatus: "todo",
          text: "queued bit",
        },
        {
          id: "P-004",
          storedStatus: "blocked",
          effectiveStatus: "blocked",
          text: "stuck bit",
        },
      ],
      linkedFeatures: { "P-002": { featureId: "WI-77", status: "wip" } },
    });
    renderDash();
    const items = screen.getByTestId("plan-dash-items");
    // Group order: attention → wip → todo → done; labels carry counts.
    expect(items.textContent).toContain("Needs attention · 1");
    expect(items.textContent).toContain("In progress · 1");
    expect(items.textContent).toContain("Up next · 1");
    expect(items.textContent).toContain("Done · 1");
    // The promoted item retains both identities. Its main action opens P-002
    // in the canonical plan; the separate work action opens WI-77.
    const promoted = screen.getByTestId("plan-dash-item-P-002");
    expect(promoted.textContent).toContain("WI-77");
    fireEvent.click(screen.getByTestId("plan-dash-item-detail-P-002"));
    expect(setQueryStatesSpy).toHaveBeenCalledWith({
      wppop: "papercusp::p1",
      ppv: "plan",
      jump: "P-002",
    });
    expect(setters["wpop"]).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("plan-dash-item-work-P-002"));
    expect(setters["wpop"]).toHaveBeenCalledWith("papercusp::WI-77");

    // An unpromoted row is equally actionable and targets its own P-anchor.
    expect(screen.getByTestId("plan-dash-item-P-003").textContent).toContain(
      "P-003",
    );
    fireEvent.click(screen.getByTestId("plan-dash-item-detail-P-003"));
    expect(setQueryStatesSpy).toHaveBeenLastCalledWith({
      wppop: "papercusp::p1",
      ppv: "plan",
      jump: "P-003",
    });
  });

  it('collapses consecutive generic edit rows into a run and promotes rationales to notes', () => {
    seed();
    const t = Date.now();
    syncData.value['planActivity.list'] = {
      data: [
        { kind: 'work', tsMs: t - 10_000, text: 'WI-40729 wip — serializer verified', who: OWNER_A, ref: 'WI-40729' },
        { kind: 'edit', tsMs: t - 20_000, text: 'Plan edited (rev 5)', who: OWNER_A, ref: 'rev:5' },
        { kind: 'edit', tsMs: t - 30_000, text: 'Plan edited (rev 4)', who: OWNER_A, ref: 'rev:4' },
        { kind: 'edit', tsMs: t - 40_000, text: 'Plan edited (rev 3)', who: OWNER_A, ref: 'rev:3' },
        { kind: 'edit', tsMs: t - 50_000, text: 'Recorded the first acceptance measurement.', who: OWNER_A, ref: 'rev:2' },
        { kind: 'edit', tsMs: t - 60_000, text: 'Plan edited (rev 1)', who: OWNER_B, ref: 'rev:1' },
      ],
    };
    renderDash();
    // One run row folding rev 3–5; the rationale is a note card; the
    // other-author singleton stays a plain verbatim row.
    const run = screen.getByTestId('plan-dash-feed-run');
    expect(run.textContent).toContain('Plan edited ×3');
    expect(run.textContent).toContain('rev 3–5');
    const note = screen.getByTestId('plan-dash-feed-note');
    expect(note.textContent).toContain('Recorded the first acceptance measurement.');
    expect(note.textContent).toContain('su-76a83'); // author short id on the note meta line
    expect(screen.getByText('Plan edited (rev 1)')).toBeTruthy();
    // Header note reports how much noise was folded.
    expect(screen.getByText('3 edits collapsed')).toBeTruthy();
    // The work row still deep-links.
    expect(screen.getByTestId('plan-dash-feed-ref-WI-40729').tagName).toBe('BUTTON');
  });
});

// plan-item-types-registry-cupboard-2026-10-20 SPEC-P-007: the open type panel (and its completion
// form) lives in the URL as ?pdtype=<item id>, so an agent reading the URL sees which item is open.
describe('PlanDashboard item-type panel URL state (SPEC-P-007)', () => {
  function seedTypes() {
    seed();
    planData.value = plan({
      slug: 'p1',
      startStatus: 'started',
      items: [
        { id: 'P-001', storedStatus: 'todo', effectiveStatus: 'todo', text: 'first bit' },
        { id: 'P-002', storedStatus: 'todo', effectiveStatus: 'todo', text: 'second bit' },
      ],
    });
    const typed = (itemId: string) => ({
      itemId,
      itemType: 'acme/legal-review',
      revision: 2,
      builtIn: false,
      modules: ['generic-core', 'acme/legal-review'],
      completion: { kind: 'schema' as const },
      completionSchema: { type: 'object', properties: { reviewer: { type: 'string' } }, required: ['reviewer'] },
      completionUnresolved: false,
      criteria: [],
      rubricRef: null,
    });
    syncData.value['plans.itemTypeView'] = {
      data: [{ planSlug: 'p1', planType: null, profile: 'code', items: [typed('P-001'), typed('P-002')] }],
    };
  }

  it('opening an item type records the open item id in ?pdtype, and opening it again clears it', () => {
    seedTypes();
    renderDash();
    expect(screen.queryByTestId('plan-dash-type-panel-P-002')).toBeNull();
    fireEvent.click(screen.getByTestId('plan-dash-item-type-P-002'));
    expect(setters['pdtype']).toHaveBeenCalledWith('P-002');

    cleanup();
    renderDash();
    fireEvent.click(screen.getByTestId('plan-dash-item-type-P-002'));
    expect(setters['pdtype']).toHaveBeenLastCalledWith(null);
  });

  it('?pdtype alone reopens that item\'s panel and its completion form', () => {
    seedTypes();
    nuqs['pdtype'] = 'P-002';
    renderDash();
    expect(screen.getByTestId('plan-dash-type-panel-P-002')).toBeTruthy();
    expect(screen.getByTestId('plan-dash-type-form-P-002')).toBeTruthy();
    expect(screen.queryByTestId('plan-dash-type-panel-P-001')).toBeNull();
  });
});

describe('PlanDashboard helpers', () => {
  it('shortOwnerId trims to the roster convention', () => {
    expect(shortOwnerId(OWNER_A)).toBe('su-76a83');
    expect(shortOwnerId('weird')).toBe('weird');
  });

  it('avatarColor is deterministic', () => {
    expect(avatarColor(OWNER_A)).toBe(avatarColor(OWNER_A));
  });
});

// derived-status-not-hand-written-2026-10-12 P-005: the dashboard renders the
// status DERIVED from the item graph and the Now note with its age, marking a
// note the plan has moved past.
type DerivedStatusFixture = NonNullable<PlanGetResult['derivedStatus']>;
type StalenessFixture = NonNullable<NonNullable<PlanGetResult['now']>['staleness']>;

function noteStaleness(transitionsSinceNote: number | null): StalenessFixture {
  return {
    transitionsSinceNote,
    noteWrittenAt: transitionsSinceNote === null ? null : new Date(Date.now() - 3 * 3_600_000).toISOString(),
    basis: transitionsSinceNote === null ? 'note-not-in-event-log' : 'events-after-note',
    itemStatusChanges: transitionsSinceNote ?? 0,
    planStatusChanges: 0,
    truncatedByLimit: false,
    text:
      transitionsSinceNote === null
        ? 'note age unknown: the note was not written through plans:set-now'
        : `${transitionsSinceNote} status changes since this note was written`,
  };
}

function derivedStatusFixture(shipGate?: DerivedStatusFixture['shipGate']): DerivedStatusFixture {
  const si = (id: string, effectiveStatus: 'todo' | 'wip' | 'blocked', heldBy: string[] = []) => ({
    id,
    effectiveStatus,
    importance: 'normal' as const,
    phase: null,
    heldBy,
  });
  return {
    counts: { todo: 1, wip: 1, blocked: 1, 'needs-human': 0, done: 3, dropped: 0, total: 6, terminal: 3, nonTerminal: 3 } as DerivedStatusFixture['counts'],
    actionable: [si('P-007', 'todo', [OWNER_B])],
    inFlight: [si('P-005', 'wip', [OWNER_A])],
    blocked: [{ ...si('P-008', 'blocked'), blockedOn: ['P-005'], external: false }],
    awaitingHuman: [],
    truncated: { actionable: false, inFlight: false, blocked: false, awaitingHuman: false },
    next: { itemId: 'P-007', reason: 'actionable', text: 'next: P-007' } as DerivedStatusFixture['next'],
    latestDecision: null,
    lifecycle: null,
    holdersMeasured: true,
    text: '3 of 6 done; 1 in flight, 1 actionable, 1 blocked',
    ...(shipGate ? { shipGate } : {}),
  };
}

function seedNote(staleness: StalenessFixture | undefined, derivedStatus?: DerivedStatusFixture) {
  seed();
  planData.value = plan({
    slug: 'p1',
    title: 'Security posture closure',
    startStatus: 'started',
    items: itemsOf({ done: 3, todo: 3 }),
    now: { state: 'P-005 is underway.', next: 'finish P-005', staleness },
    derivedStatus,
  });
}

describe('PlanDashboard derived status and note age (P-005)', () => {
  it('PlanDashboard renders derivedStatus (actionable items, holders, blockers, ship-gate step)', () => {
    seedNote(
      noteStaleness(0),
      derivedStatusFixture({
        source: 'plan-acceptance-gate',
        satisfied: false,
        code: 'acceptance_ungraded',
        skipped: null,
        message: 'no independent grade',
        nextRepair: { kind: 'grade', verb: 'scorecards:emit', nextVerb: null, instruction: 'grade it' },
        guardsNotChecked: [],
        confirmWith: { name: 'plans:set-plan-status', args: {} },
        reusedShipReadiness: false,
        unavailableReason: null,
        text: 'ship refused: acceptance_ungraded',
      }),
    );
    renderDash();
    const card = screen.getByTestId('plan-dash-status');
    expect(within(card).getByTestId('plan-dash-status-text').textContent).toBe(
      '3 of 6 done; 1 in flight, 1 actionable, 1 blocked',
    );
    const rows = within(card).getAllByTestId('plan-dash-status-row');
    expect(rows.map((r) => [r.getAttribute('data-kind'), r.getAttribute('data-item')])).toEqual([
      ['in-flight', 'P-005'],
      ['actionable', 'P-007'],
      ['blocked', 'P-008'],
    ]);
    expect(rows[0]!.textContent).toContain(`held by ${shortOwnerId(OWNER_A)}`);
    expect(rows[1]!.textContent).toContain(`held by ${shortOwnerId(OWNER_B)}`);
    expect(rows[2]!.textContent).toContain('blocked on P-005');
    const gate = within(card).getByTestId('plan-dash-status-gate');
    expect(gate.textContent).toContain('ship refused: acceptance_ungraded');
    expect(gate.textContent).toContain('scorecards:emit');
    expect(gate.className).toContain('plan-dash__status-gate--refused');
  });

  it('PlanDashboard marks the note stale when transitionsSinceNote is above zero', () => {
    seedNote(noteStaleness(2), derivedStatusFixture());
    renderDash();
    const now = screen.getByTestId('plan-dash-now');
    expect(now.getAttribute('data-note-age')).toBe('moved-past');
    expect(now.className).toContain('plan-dash__now--stale');
    expect(within(now).getByTestId('plan-dash-now-stale').textContent).toBe('moved past');
    expect(within(now).getByTestId('plan-dash-now-age').textContent).toContain(
      '2 status changes since this note was written',
    );
  });

  it('renders the note with its age and no stale marker when nothing changed after it', () => {
    seedNote(noteStaleness(0), derivedStatusFixture());
    renderDash();
    const now = screen.getByTestId('plan-dash-now');
    expect(now.getAttribute('data-note-age')).toBe('current');
    expect(now.className).not.toContain('plan-dash__now--stale');
    expect(within(now).queryByTestId('plan-dash-now-stale')).toBeNull();
    const age = within(now).getByTestId('plan-dash-now-age').textContent ?? '';
    expect(age).toContain('written 3h ago');
    expect(age).toContain('0 status changes since this note was written');
  });

  it('shows an unknown note age as unknown, never as current', () => {
    seedNote(noteStaleness(null), derivedStatusFixture());
    renderDash();
    const now = screen.getByTestId('plan-dash-now');
    expect(now.getAttribute('data-note-age')).toBe('unknown');
    expect(within(now).queryByTestId('plan-dash-now-stale')).toBeNull();
    expect(within(now).getByTestId('plan-dash-now-age').textContent).toContain('note age unknown');
  });

  it('renders no status card or age line when the read carried neither', () => {
    seedNote(undefined);
    renderDash();
    expect(screen.queryByTestId('plan-dash-status')).toBeNull();
    expect(screen.getByTestId('plan-dash-now').getAttribute('data-note-age')).toBe('none');
    expect(screen.queryByTestId('plan-dash-now-age')).toBeNull();
  });
});
