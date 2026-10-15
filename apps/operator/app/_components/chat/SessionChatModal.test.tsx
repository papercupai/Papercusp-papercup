// @vitest-environment jsdom
/**
 * SessionChatModal — owner-inbox-single-pane-2026-07-17 P-007's chat-grade
 * popup. The SSE transport is mocked the same way AgentInspectorModal.test.tsx
 * mocks it (so `useAgentThinkingStream` runs for real, unmodified); `fetch`
 * is mocked for the two REST hops (sessions:list owner-resolution, coord:send).
 *
 * P-008 (cards in the popup): `@papercusp/sync` and `PlanOtherList` are
 * mocked the SAME way InboxPane.test.tsx mocks them — a hoisted per-queryName
 * result table + an `OtherDetail` stub that echoes its item id/onResolved seam
 * (parity behavior is the Queue suites' job; this file only asserts the right
 * item is selected + hosted).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AttentionItem } from '@/app/admin/plans/plans-api';
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';

// chat-ref-pills-2026-07-26 P-008: OperatorChat (rendered by SessionChatModal
// via LiveSessionChat) now owns `useQueryState` calls for the ref-pill popup
// routing below — every suite rendering it needs a nuqs mock. Hand-rolled +
// resettable (same pattern PlansPane.test.tsx uses), not `createNuqsMock()`'s
// singleton, so state can't leak between this file's own test cases.
const { nuqs, nuqsSetters } = vi.hoisted(() => ({
  nuqs: {} as Record<string, unknown>,
  nuqsSetters: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
function mkNuqsSetter(key: string) {
  if (!nuqsSetters[key]) nuqsSetters[key] = vi.fn(async (v: unknown) => { nuqs[key] = v; });
  return nuqsSetters[key];
}
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string, parser?: { _d?: unknown }) => [
    nuqs[key] !== undefined ? nuqs[key] : parser?._d,
    mkNuqsSetter(key),
  ],
  parseAsString: { withDefault: (d: unknown) => ({ _d: d }) },
  // hud-first-nav-and-dossier-2026-07-26 P-003: SessionChatModal's own
  // dossier-rail open/collapsed state is a parseAsBoolean — give it the same
  // `_d`-default treatment as parseAsString above so the shared mocked
  // useQueryState honors its default (true) instead of always reading
  // undefined.
  parseAsBoolean: { withDefault: (d: unknown) => ({ _d: d }) },
}));
// The two popup DESTINATIONS (→ PlanDetail / DetailPanel) are heavy — mocked
// the SAME way PlansPane.test.tsx mocks PlanPopupModal away, to a tiny probe
// asserting only what THIS file cares about: which id/harness reached them.
let lastWorkItemPopupProps: Record<string, any> = {};
vi.mock('../work-items/WorkItemPopupModal', () => ({
  default: (props: Record<string, any>) => {
    lastWorkItemPopupProps = props;
    return null;
  },
}));
let lastPlanPopupProps: Record<string, any> | null = null;
vi.mock('../plans/PlanPopupModal', () => ({
  default: (props: Record<string, any>) => {
    lastPlanPopupProps = props;
    return null;
  },
}));
// WI-6505: the always-visible fleet-launch row. Stubbed to a marker for the same
// reason as the popups above — it owns two option fetches (the plan list and
// psu's bootstrap-su options endpoint) that have nothing to do with what this
// file asserts, and its own behavior is covered by FleetLaunchRow.test.tsx.
// The marker is NOT decoration: this suite's own "…is always visible" cases
// below assert it renders in the states where `actionCtx` is null and the chat
// action bar is therefore absent, which is the whole point of the row.
vi.mock('./FleetLaunchRow', () => ({
  default: () => <div data-testid="fleet-launch-row-stub" />,
}));
// P-001 D-003 (2026-08-02): the desktop half of full-screen. Mocked to spies so
// this file asserts the modal's BRANCH (which mechanism it reaches for, and
// whether it gives the window back) — the module's own ownership/soft-fail
// contract is covered by desktop-window-fullscreen.test.ts.
const desktopFs = vi.hoisted(() => ({
  isDesktopShell: vi.fn(() => false),
  enterDesktopWindowFullscreen: vi.fn(async () => ({ active: true, owned: true })),
  exitDesktopWindowFullscreen: vi.fn(async () => {}),
}));
vi.mock('@/lib/desktop-window-fullscreen', () => desktopFs);
// hud-first-nav-and-dossier-2026-07-26 P-003: AgentDossier's own behavior is
// covered by AgentDossier.test.tsx — stubbed here (same pattern as
// WorkItemPopupModal/PlanPopupModal above) to a tiny probe asserting only
// what THIS file owns: whether the rail mounts, and with which props.
let lastAgentDossierProps: Record<string, any> | null = null;
vi.mock('../../adv/sessions/AgentDossier', () => ({
  default: (props: Record<string, any>) => {
    lastAgentDossierProps = props;
    return (
      <div data-testid="agent-dossier-stub" data-owner={props.ownerId}>
        <header>{props.headerControl}</header>
        <button type="button" data-testid="dossier-stub-close" onClick={props.onClose} />
      </div>
    );
  },
}));

// session-chat-popup-direction-d-2026-08-02 P-015: AgentOrders' own behavior is
// covered by AgentOrders.test.tsx — stubbed here for the same reason as the
// dossier above, and for one more: the real panel runs the `agentOrders.byOwner`
// carry-brief gather on mount, so leaving it live would make this file's
// structural assertions depend on that query's fixture.
let lastAgentOrdersProps: Record<string, any> | null = null;
vi.mock('../../adv/sessions/AgentOrders', () => ({
  default: (props: Record<string, any>) => {
    lastAgentOrdersProps = props;
    return (
      <div data-testid="agent-orders-stub" data-owner={props.ownerId}>
        <header>{props.headerControl}</header>
        <button type="button" data-testid="orders-stub-close" onClick={props.onClose} />
      </div>
    );
  },
}));

// jsdom-vs-virtualization seam (same as PapercupChat's shared-view tests): the real
// @tanstack/react-virtual renders nothing without real layout, and the
// scroll-to-bottom / load-earlier effects need stand-ins for APIs jsdom lacks.
const scrollToIndexSpy = vi.fn();
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: opts.count }, (_, i) => ({ index: i, key: `vk-${i}`, start: i * 64, size: 64 })),
    getTotalSize: () => opts.count * 64,
    measureElement: () => {},
    scrollToIndex: scrollToIndexSpy,
  }),
}));

type Handlers = Record<string, (data: string, ev?: unknown) => void>;
let captured: { handlers: Handlers; onError?: (e: Error) => void; url: string } | null = null;
const closeSpy = vi.fn();
vi.mock('@papercusp/sse', () => ({
  // Mirror the transport ceilings consumed by stream-freshness.ts.
  DEFAULT_ZOMBIE_TIMEOUT_MS: 45_000,
  DESKTOP_IPC_STREAM_IDLE_TIMEOUT_MS: 32_000,
  createResilientEventSource: (opts: { url: string; handlers: Handlers; onError?: (e: Error) => void }) => {
    // EI-14216: OperatorChat transitively imports OperatorConversationProvider
    // (for CardAnswerError), which imports voice-mode.ts, which — on some
    // renders — async-inits a cross-tab "leader bridge" that ALSO calls
    // createResilientEventSource, for an unrelated
    // /api/agent-mcp/run-command/sse?workspace=default&sessionId=tab-... URL.
    // That call has nothing to do with this component's own live-session
    // stream and must never clobber `captured` — only the session/thinking
    // stream this file actually asserts on should be captured.
    if (!opts.url.startsWith('/api/adv/session/thinking')) {
      return { close: vi.fn() };
    }
    captured = { handlers: opts.handlers, onError: opts.onError, url: opts.url };
    return { close: closeSpy };
  },
}));

// P-008: the shared sync layer, mocked exactly like InboxPane.test.tsx —
// keyed by queryName, defaulting to an empty/blank result so every existing
// (pre-P-008) test in this file keeps rendering with zero pending escalations.
const H = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown[]; loading: boolean; fetching: boolean; error: unknown; invalidate: ReturnType<typeof vi.fn> }>,
  prefetch: vi.fn(),
}));
const attentionInvalidate = vi.fn();
vi.mock('@papercusp/sync', () => ({
  ORIGIN_SCHEDULER_CLASSES: [
    'interactive-control',
    'foreground-read',
    'background-sync',
    'bulk',
  ],
  onSyncBusEvent: () => () => {},
  useSyncPrefetch: () => H.prefetch,
  useSyncQuery: ({ queryName }: { queryName: string }) =>
    H.results[queryName] ?? { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() },
}));
// OtherDetail is the Queue's own component (its behavior is covered by the
// Queue's own suites) — stub it to a marker that echoes the hosted item id
// and exposes the onResolved seam, mirroring InboxPane.test.tsx's stub.
// The `.ask-choice-card` div is not decoration: DecisionCard measures THAT
// element to decide whether the request text is clipped, so a stub without it
// would silently exercise the "nothing overflows" branch forever.
vi.mock('@/app/admin/plans/PlanOtherList', () => ({
  OtherDetail: ({ item, onResolved }: { item: { id: string }; onResolved: () => void }) => (
    <div data-testid="other-detail" data-item={item.id}>
      <div className="ask-choice-card">request text</div>
      <button type="button" data-testid="stub-resolve" onClick={onResolved} />
    </div>
  ),
}));

import SessionChatModal from './SessionChatModal';
// P-006: the zombie wording is asserted against the BOARD's exported constant,
// never a retyped copy — a retyped string would pass this test on the day the
// two surfaces started disagreeing, which is the only day it matters.
import { ZOMBIE_REASON } from '../../adv/hud/hud-board-model';

function mkEscalation(id: string, over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    kind: 'coord-escalation',
    source: 'coord',
    harnessSlug: 'papercusp',
    planSlug: null,
    itemRef: null,
    title: `Escalation ${id}`,
    body: `Body of ${id}`,
    status: 'open',
    importance: 'normal',
    tier: 'decision',
    needsHuman: true,
    ownerAgentId: 'su-live-1',
    ownerLabel: 'su · live-1',
    triageState: 'untriaged',
    triageNote: null,
    triagedBy: null,
    triagedAt: null,
    actions: [{ id: 'resolve', label: 'Resolve', primary: true }],
    ref: { kind: 'coord-escalation', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] },
    ...over,
  } as AttentionItem;
}

function seedAttention(items: AttentionItem[]) {
  H.results['plans.attention'] = {
    data: [
      { key: 'g1', kind: 'plan', planSlug: 'plan-x', harnessSlug: 'papercusp', title: 'plan-x', items, maxImportance: 'normal' },
    ],
    loading: false,
    fetching: false,
    error: null,
    invalidate: attentionInvalidate,
  };
}

const fetchMock = vi.fn();

function mockFetchOnce(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
}

beforeEach(() => {
  captured = null;
  closeSpy.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('IntersectionObserver', class {
    observe() {} unobserve() {} disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class {
    observe() {} unobserve() {} disconnect() {}
  });
  H.results = {};
  H.prefetch.mockClear();
  attentionInvalidate.mockClear();
  lastWorkItemPopupProps = {};
  lastPlanPopupProps = null;
  lastAgentDossierProps = null;
  lastAgentOrdersProps = null;
  for (const k of Object.keys(nuqs)) delete nuqs[k];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SessionChatModal', () => {
  it('renders nothing (closed) when sessionOwnerId is null', () => {
    const { container } = render(<SessionChatModal sessionOwnerId={null} onClose={vi.fn()} />);
    expect(screen.queryByText(/Chat —/)).toBeNull();
    expect(H.prefetch).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('resolves the owner’s newest native session without assuming the backend is Claude', async () => {
    mockFetchOnce(200, {
      sessions: [
        { source_kind: 'omp', session_id: 'omp-1', last_ts: null },
        { source_kind: 'claude', session_id: 'claude-abc', last_ts: '2026-07-17T00:00:00Z' },
      ],
    });
    render(<SessionChatModal sessionOwnerId="su-live-1" ownerLabel="su · live-1" onClose={vi.fn()} />);

    expect(screen.getByText("Finding this agent's session…")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/coordination/sessions/list',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ owner: 'su-live-1', limit: 10 }),
      }),
    );

    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.url).toBe('/api/adv/session/thinking?ompThreadId=omp-1&historyOwner=su-live-1');
    expect(screen.getByText('Chat — su · live-1')).toBeTruthy();
  });

  it('prefers the active/live row over an older claude session (EI-11403 synthetic fallback)', async () => {
    mockFetchOnce(200, {
      sessions: [
        { source_kind: 'claude', session_id: 'claude-old', last_ts: '2026-07-01T00:00:00Z' },
        { source_kind: 'claude', session_id: 'claude-live', active: true, last_ts: null },
      ],
    });
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.url).toContain('sessionId=claude-live');
  });

  it('EI-16982: appends &ended=1 when the resolved session is not active, so the backend rematerializes the archived transcript', async () => {
    mockFetchOnce(200, {
      sessions: [{ source_kind: 'claude', session_id: 'claude-ended', active: false, last_ts: '2026-07-01T00:00:00Z' }],
    });
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.url).toBe('/api/adv/session/thinking?sessionId=claude-ended&owner=su-live-1&historyOwner=su-live-1&ended=1');
  });

  it('does NOT append ended for an active/live session (no regression)', async () => {
    mockFetchOnce(200, {
      sessions: [{ source_kind: 'claude', session_id: 'claude-live', active: true, last_ts: null }],
    });
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.url).not.toContain('ended=');
  });

  it('shows a not-found state when the owner has no native transcript', async () => {
    mockFetchOnce(200, { sessions: [] });
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText('No recent session found for this agent.')).toBeTruthy(),
    );
    expect(captured).toBeNull(); // never opened a stream with no session id
  });

  it('streams a live Codex card and exposes the one-click Focus window action', async () => {
    H.results['advRoster.list'] = {
      data: [
        {
          active: [
            {
              ownerId: 'su-live-1',
              agent: 'codex',
              advSessionId: 9444,
              sessionState: 'live',
              liveness: 'live',
              modes: [],
              claims: [],
              currentFiles: [],
              openAwait: null,
              nativeSession: {
                backend: 'codex',
                source: 'adv_sessions',
                ownerId: 'su-live-1',
                codexHome: '/tmp/codex-home',
                rolloutId: '019f-rollout-1',
                exactResumeSupported: true,
                missingReason: null,
              },
            },
          ],
          pending: [],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.url).toBe(
      '/api/adv/session/thinking?codexRolloutId=019f-rollout-1&historyOwner=su-live-1',
    );
    expect(screen.getByPlaceholderText(/Reply|Type to wake/i)).toBeTruthy();

    const focus = screen.getByRole('button', { name: 'Focus window' });
    mockFetchOnce(200, { status: 'ok', windowId: '0xabc' });
    fireEvent.click(focus);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/adv/sessions/focus',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ id: 9444 }),
        }),
      ),
    );
    expect(await screen.findByText('✓ Focus window applied')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/admin/coordination/sessions/list',
      expect.anything(),
    );
  });

  it('does not advertise Focus window when the live Codex row has no focus handle', async () => {
    H.results['advRoster.list'] = {
      data: [{
        active: [{
          ownerId: 'su-live-1', agent: 'codex', sessionState: 'live', liveness: 'live',
          modes: [], claims: [], currentFiles: [], openAwait: null,
          nativeSession: {
            backend: 'codex', source: 'adv_sessions', ownerId: 'su-live-1',
            codexHome: '/tmp/codex-home', rolloutId: '019f-rollout-1',
            exactResumeSupported: true, missingReason: null,
          },
        }],
        pending: [],
      }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };

    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(captured).not.toBeNull());
    expect(screen.queryByRole('button', { name: 'Focus window' })).toBeNull();
  });

  it('streams a live OMP card through its native thread handle', async () => {
    H.results['advRoster.list'] = {
      data: [{
        active: [{
          ownerId: 'su-live-1', agent: 'omp', sessionState: 'live', liveness: 'live',
          modes: [], claims: [], currentFiles: [], openAwait: null, ompThreadId: '019f-thread-1',
          nativeSession: {
            backend: 'omp', source: 'adv_sessions', ownerId: 'su-live-1',
            ompThreadId: '019f-thread-1', agentHome: '/tmp/omp-home',
            exactResumeSupported: true, missingReason: null,
          },
        }],
        pending: [],
      }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.url).toBe('/api/adv/session/thinking?ompThreadId=019f-thread-1&historyOwner=su-live-1');
    expect(screen.getByPlaceholderText(/Reply|Type to wake/i)).toBeTruthy();
  });

  /* popup-agent-state-coverage-2026-08-18 P-012 / D-011 — an unresolvable
     transcript is a PROPERTY of the record, so it is said out loud rather than
     left to present as an empty pane. */
  it('says so, and requests the archive fallback, when the roster stamped thinkingResolvable:false', async () => {
    H.results['advRoster.list'] = {
      data: [{
        active: [{
          ownerId: 'su-live-1', agent: 'claude', sessionState: 'parked', liveness: 'live',
          modes: [], claims: [], currentFiles: [], openAwait: null,
          thinkingResolvable: false,
          nativeSession: {
            backend: 'claude', source: 'adv_sessions', ownerId: 'su-live-1',
            sessionId: 'sess-gone-1', configDir: '/tmp/cfg',
            exactResumeSupported: true, missingReason: null,
          },
        }],
        pending: [],
      }],
      loading: false, fetching: false, error: null, invalidate: vi.fn(),
    };
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

    await waitFor(() => expect(captured).not.toBeNull());
    // The roster's verdict reached the URL: `sessionTargetFromRoster` stamps
    // active:true for every claude handle, so ONLY the new leg can set this.
    expect(captured!.url).toContain('ended=1');

    const note = await screen.findByTestId('session-chat-thinking-unresolvable');
    // The load-bearing half: an empty pane must not read as a silent agent.
    expect(note.textContent).toMatch(/NOT that this agent has gone quiet/i);
    // MARK, never suppress — the composer and the stream still render.
    expect(screen.getByPlaceholderText(/Reply|Type to wake/i)).toBeTruthy();
  });

  it('shows no such note when the transcript resolves — absent must not act like false', async () => {
    H.results['advRoster.list'] = {
      data: [{
        active: [{
          ownerId: 'su-live-1', agent: 'omp', sessionState: 'live', liveness: 'live',
          modes: [], claims: [], currentFiles: [], openAwait: null, ompThreadId: '019f-thread-1',
          nativeSession: {
            backend: 'omp', source: 'adv_sessions', ownerId: 'su-live-1',
            ompThreadId: '019f-thread-1', agentHome: '/tmp/omp-home',
            exactResumeSupported: true, missingReason: null,
          },
        }],
        pending: [],
      }],
      loading: false, fetching: false, error: null, invalidate: vi.fn(),
    };
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.url).not.toContain('ended=');
    expect(screen.queryByTestId('session-chat-thinking-unresolvable')).toBeNull();
  });

  it('surfaces a sessions:list resolution failure', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    // WI-5364: friendly headline leads; the raw transport error rides below it
    // in muted mono (both live inside the same testid'd banner).
    await waitFor(() => expect(screen.getByText(/Couldn't load this agent's conversation/)).toBeTruthy());
    expect(screen.getByTestId('session-chat-resolve-error').textContent).toContain('500');
  });

  /**
   * WI-6505 [owner ask 2026-07-27]: "make this fleet launching its own always
   * visible row".
   *
   * ALWAYS means in the degraded states too, and those are the cases that make
   * this more than a placement detail. The chat action bar (Grade and friends)
   * only mounts once `actionCtx` resolves — a live session with a known owner
   * id — so in every state below it is ABSENT. Those are exactly the moments a
   * human is most likely to give up on this agent and launch a fleet instead,
   * so the row has to outlive the bar rather than share its gate.
   */
  describe('WI-6505: the fleet-launch row is always visible', () => {
    it('renders when the session resolves normally', async () => {
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(screen.getByTestId('fleet-launch-row-stub')).toBeTruthy());
    });

    it('renders when the owner has no native transcript (no action bar to sit beside)', async () => {
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() =>
        expect(screen.getByText('No recent session found for this agent.')).toBeTruthy(),
      );
      expect(screen.getByTestId('fleet-launch-row-stub')).toBeTruthy();
    });

    it('renders even when session resolution FAILS outright', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(screen.getByTestId('session-chat-resolve-error')).toBeTruthy());
      expect(screen.getByTestId('fleet-launch-row-stub')).toBeTruthy();
    });

    it('is NOT rendered while the popup is closed', () => {
      render(<SessionChatModal sessionOwnerId={null} onClose={vi.fn()} />);
      expect(screen.queryByTestId('fleet-launch-row-stub')).toBeNull();
    });
  });

  describe('EI-21590502169409362 roster-derived pills distinguish loading from missing', () => {
    const loadingRoster = () => {
      H.results['advRoster.list'] = {
        data: [],
        loading: true,
        fetching: true,
        error: null,
        invalidate: vi.fn(),
      };
    };

    it('shows disabled loading placeholders, then removes them for a resolved-missing target', async () => {
      loadingRoster();
      mockFetchOnce(200, { sessions: [] });
      const { rerender } = render(
        <SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />,
      );

      const account = await screen.findByTestId('chat-mode-mode-account');
      const model = await screen.findByTestId('chat-mode-mode-model');
      expect((account as HTMLButtonElement).disabled).toBe(true);
      expect((model as HTMLButtonElement).disabled).toBe(true);
      expect(account.textContent).toMatch(/loading/i);
      expect(model.textContent).toMatch(/loading/i);

      H.results['advRoster.list'] = {
        data: [{ active: [], pending: [] }],
        loading: false,
        fetching: false,
        error: null,
        invalidate: vi.fn(),
      };
      rerender(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => {
        expect(screen.queryByTestId('chat-mode-mode-account')).toBeNull();
        expect(screen.queryByTestId('chat-mode-mode-model')).toBeNull();
      });
    });

    it('replaces the loading placeholders with enabled controls when the target row arrives', async () => {
      loadingRoster();
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      const { rerender } = render(
        <SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />,
      );

      await screen.findByTestId('chat-mode-mode-account');
      await screen.findByTestId('chat-mode-mode-model');
      H.results['advRoster.list'] = {
        data: [{
          active: [{
            ownerId: 'su-live-1',
            agent: 'claude',
            sessionId: 'claude-abc',
            accountPin: { account: 'max-3', hard: false },
            launchArgv: ['psu', '--model=sonnet[1m]:high'],
          }],
          pending: [],
        }],
        loading: false,
        fetching: false,
        error: null,
        invalidate: vi.fn(),
      };
      rerender(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => {
        const account = screen.getByTestId('chat-mode-mode-account') as HTMLButtonElement;
        const model = screen.getByTestId('chat-mode-mode-model') as HTMLButtonElement;
        expect(account.disabled).toBe(false);
        expect(model.disabled).toBe(false);
        expect(account.textContent).toContain('max-3');
        expect(model.textContent).toContain('sonnet[1m]:high');
      });
    });
  });

  it('maps the live backfill through the tool-noise-filtering layer and renders it as chat', async () => {
    mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(captured).not.toBeNull());

    act(() => {
      captured!.handlers.backfill!(
        JSON.stringify([
          { kind: 'prompt', text: 'owner asks something' },
          { kind: 'tool_use', toolName: 'Read', toolInput: { file_path: '/a.ts' } },
          { kind: 'tool_result', text: 'A'.repeat(20_000) },
          { kind: 'text', text: 'Here is my answer.' },
        ]),
      );
    });

    /* Scoped to the TRANSCRIPT, not the whole modal. Since the turn rail
       (chat-popup-turn-rail-2026-08-31) the question also appears as a rail
       preview, so an unscoped `getByText` matches twice and throws — and the
       claim this case is making has always been about what the MAPPER put in
       the conversation, not about how many places the popup shows a question. */
    const conversation = within(screen.getByTestId('session-chat-conversation'));
    expect(conversation.getByText('owner asks something')).toBeTruthy();
    expect(conversation.getByText('Here is my answer.')).toBeTruthy();
    // The 20KB tool_result never reaches the DOM — the tool-noise filter.
    expect(screen.queryByText(/A{100,}/)).toBeNull();
  });

  it('loads and prepends older stable-owner pages until the beginning of retained history', async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('historyPage=1')
        ? {
            entries: [
              { kind: 'prompt', text: 'prior epoch question', ts: '2026-08-01T00:00:00Z' },
              { kind: 'text', text: 'prior epoch answer', ts: '2026-08-01T00:00:01Z' },
            ],
            hasMore: false,
            cursor: null,
          }
        : url.includes('/api/admin/coordination/sessions/list')
          ? { sessions: [{ source_kind: 'claude', session_id: 'claude-current', last_ts: null }] }
          : {};
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    });
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(captured).not.toBeNull());
    act(() => {
      captured!.handlers.backfill!(JSON.stringify([
        { kind: 'prompt', text: 'current epoch question', ts: '2026-09-01T00:00:00Z' },
        { kind: 'text', text: 'current epoch answer', ts: '2026-09-01T00:00:01Z' },
      ]));
    });
    const conversation = within(screen.getByTestId('session-chat-conversation'));
    expect(await conversation.findByText('current epoch question')).toBeTruthy();
    act(() => {
      captured!.handlers.history!(JSON.stringify({ hasMore: true, cursor: 'page-2' }));
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Load earlier messages' }));

    expect(await conversation.findByText('prior epoch question')).toBeTruthy();
    expect(conversation.getByText('current epoch question')).toBeTruthy();
    expect(screen.getByText('Beginning of conversation')).toBeTruthy();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/adv/session/thinking?historyPage=1&historyOwner=su-live-1&historyCursor=page-2',
      { headers: { accept: 'application/json' } },
    );
  });

  it('makes every T# click target that turn answer, with the newest rapid click winning', async () => {
    mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-turns', last_ts: null }] });
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(captured).not.toBeNull());
    act(() => {
      captured!.handlers.backfill!(JSON.stringify([
        { kind: 'prompt', text: 'first question' },
        { kind: 'text', text: 'first answer' },
        { kind: 'prompt', text: 'second question' },
        { kind: 'text', text: 'second answer' },
        { kind: 'prompt', text: 'third question' },
        { kind: 'text', text: 'third answer' },
      ]));
    });

    const rail = await screen.findByTestId('turn-rail');
    const rows = within(rail).getAllByTestId('turn-rail-row');
    expect(rows.map((row) => row.getAttribute('data-turn'))).toEqual(['1', '2', '3']);
    scrollToIndexSpy.mockClear();

    fireEvent.click(rows[1]);
    await waitFor(() => expect(scrollToIndexSpy).toHaveBeenCalledWith(3, { align: 'start' }));

    // The owner-reported race: a second click on the same T# must still issue
    // another request, and a rapid different click must supersede it.
    const callsAfterFirst = scrollToIndexSpy.mock.calls.length;
    fireEvent.click(rows[1]);
    await waitFor(() => expect(scrollToIndexSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst));
    fireEvent.click(rows[0]);
    fireEvent.click(rows[2]);
    await waitFor(() => expect(scrollToIndexSpy.mock.calls.at(-1)?.[0]).toBe(5));
  });

  it('renders hidden machine prompts as automatic rail turns without exposing their bodies', async () => {
    mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-turns', last_ts: null }] });
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(captured).not.toBeNull());
    act(() => {
      captured!.handlers.backfill!(JSON.stringify([
        { kind: 'prompt', text: 'owner question' },
        { kind: 'text', text: 'owner answer' },
        { kind: 'prompt', text: '⟦turn-origin:wake-pump nonce:abc123ef⟧\n[await-event] secret machine body' },
        { kind: 'text', text: 'automatic answer' },
      ]));
    });

    const rows = within(await screen.findByTestId('turn-rail')).getAllByTestId('turn-rail-row');
    expect(rows.map((row) => row.getAttribute('data-turn'))).toEqual(['1', '2']);
    expect(rows[1].textContent).toContain('Automatic continuation.');
    expect(screen.queryByText(/secret machine body/)).toBeNull();
    scrollToIndexSpy.mockClear();
    fireEvent.click(rows[1]);
    await waitFor(() => expect(scrollToIndexSpy).toHaveBeenCalledWith(2, { align: 'start' }));
  });

  describe('P-012 identity chip', () => {
    function seedRoster(entries: Array<Record<string, unknown>>) {
      H.results['advRoster.list'] = {
        data: [{ active: entries, pending: [] }],
        loading: false,
        fetching: false,
        error: null,
        invalidate: vi.fn(),
      };
    }

    it('renders the roster handle + LEAD marker on the assistant avatar for a fleet leader', async () => {
      seedRoster([
        { ownerId: 'su-live-1', fleetColor: '#86efac', fleetRole: 'leader' },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'Here is my answer.' }]));
      });

      await waitFor(() => expect(screen.getByText('Here is my answer.')).toBeTruthy());
      // Scoped to the identity-chip avatar specifically: P-007's footer (below
      // the composer) also renders the handle now, so a page-wide getByText
      // would ambiguously match both.
      const chip = document.querySelector('.oracle-msg-avatar--identity') as HTMLElement;
      expect(chip).toBeTruthy();
      expect(within(chip).getByText('su-live-1')).toBeTruthy();
      expect(within(chip).getByLabelText('Fleet leader')).toBeTruthy();
    });

    it('omits the LEAD marker for a non-leader member, and falls back to the default icon avatar when the owner has no roster row', async () => {
      seedRoster([{ ownerId: 'su-live-1', fleetColor: null, fleetRole: 'member' }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'member reply' }]));
      });

      await waitFor(() => expect(screen.getByText('member reply')).toBeTruthy());
      const chip = document.querySelector('.oracle-msg-avatar--identity') as HTMLElement;
      expect(chip).toBeTruthy();
      expect(within(chip).getByText('su-live-1')).toBeTruthy();
      expect(within(chip).queryByLabelText('Fleet leader')).toBeNull();
    });

    it('falls back to the default icon avatar when the roster has no matching entry', async () => {
      seedRoster([{ ownerId: 'su-someone-else', fleetColor: null, fleetRole: null }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'no roster row' }]));
      });

      await waitFor(() => expect(screen.getByText('no roster row')).toBeTruthy());
      expect(document.querySelector('.oracle-msg-avatar--identity')).toBeNull();

      // WI-6503 [owner 2026-07-27]: "remove the papercup icon from the chatbox
      // for the chatboces where the conversation isnt with papercup." THIS is
      // the leak — with no roster row the identity chip bows out and the row
      // takes the pane's fallback icon, which used to be the hard-coded
      // Papercup brand mark. Measured live before the fix: 11 of 12 avatars in
      // a conversation with an su agent were this mark. Asserting on the brand
      // SVG's own viewBox (uniquely "18 12 92 92") is the same signal the live
      // probe used, so the guard and the live check agree.
      const avatarSvgs = [...document.querySelectorAll('.oracle-msg-avatar svg')];
      expect(avatarSvgs.length).toBeGreaterThan(0);
      for (const svg of avatarSvgs) {
        expect(svg.getAttribute('viewBox')).not.toBe('18 12 92 92');
      }
    });

    it('WI-6503: a counterparty that IS papercup still gets the papercup mark — resolved from the roster entry, not a title match', async () => {
      seedRoster([{ ownerId: 'su-live-1', fleetColor: null, fleetRole: null, agent: 'papercup' }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'papercup reply' }]));
      });

      await waitFor(() => expect(screen.getByText('papercup reply')).toBeTruthy());
      // The fix must not over-correct into "never show a cup": when the
      // counterparty's own agent kind IS papercup, the cup is the CORRECT mark.
      // That is the point of resolving from the roster entry instead of
      // suppressing the icon wholesale — the item forbids a title match in
      // either direction.
      //
      // Observed via the pane icon's always-rendered instance: PapercupChat
      // uses `emptyState.icon` as the composer's input icon too, so this holds
      // whether or not the transcript has rows. lucide stamps `lucide-<name>`.
      expect(document.querySelector('.lucide-cup-soda')).toBeTruthy();
      expect(document.querySelector('.lucide-terminal')).toBeNull();
    });

    it('WI-6503: a plain su counterparty (no agent kind) gets the neutral terminal mark, never the papercup cup', async () => {
      seedRoster([{ ownerId: 'su-live-1', fleetColor: null, fleetRole: null, agent: null }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'su reply' }]));
      });

      await waitFor(() => expect(screen.getByText('su reply')).toBeTruthy());
      // The owner's actual case. Both directions asserted so neither a revert
      // to the brand mark nor a wholesale suppression passes.
      expect(document.querySelector('.lucide-terminal')).toBeTruthy();
      expect(document.querySelector('.lucide-cup-soda')).toBeNull();
      for (const svg of document.querySelectorAll('.oracle-msg-avatar svg')) {
        expect(svg.getAttribute('viewBox')).not.toBe('18 12 92 92');
      }
    });
  });

  /**
   * Direction D P-004 moved this surface: the read-only facts that used to sit
   * in a footer UNDER the composer now render as the status band ABOVE the
   * transcript (`session-chat-state-header`), because description belongs above
   * the transcript and operation below it. The assertions are the P-007/D-002
   * ones, re-pointed — plus one new invariant that is the whole point of the
   * move: MODE chips must NOT appear here, because a mode is now a control in
   * the band below, and having it in both places is the duplicate pair
   * ("AUTO" + "Autonomy") the owner reported as confusing.
   */
  describe('P-004 session status band (was the P-007 footer)', () => {
    function seedRoster(entries: Array<Record<string, unknown>>) {
      H.results['advRoster.list'] = {
        data: [{ active: entries, pending: [] }],
        loading: false,
        fetching: false,
        error: null,
        invalidate: vi.fn(),
      };
    }

    it('renders liveness/context/current-claim from the SAME roster entry the identity chip reads (D-002 glance fields)', async () => {
      seedRoster([
        {
          ownerId: 'su-live-1',
          liveness: 'live',
          fleetSlug: 'gui-chat-controls',
          fleetColor: '#86efac',
          fleetRole: 'leader',
          currentPlanSlug: 'gui-chat-session-controls-2026-07-25',
          contextTokens: 40_000,
          compactionLimit: 200_000,
          modes: ['auto'],
          claims: [{ id: 'WI-1', status: 'done' }, { id: 'WI-2', status: 'wip' }],
          currentFiles: [],
          intent: 'Building the session footer',
          openAwait: null,
        },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      const band = await waitFor(() => screen.getByTestId('session-chat-state-header'));
      // D-002 glance fields: liveness, context %, the held claim, awaiting-gate.
      expect(band.textContent).toContain('live');
      expect(band.textContent).toContain('ctx 20%');
      // P-004: the claim renders by IDENTITY, not as a bare done/total — "which
      // item is it holding" is the useful question, and "1/2" never answered it.
      expect(band.textContent).toContain('WI-1');
      expect(band.textContent).toContain('+1');
      expect(band.textContent).not.toContain('1/2');
      // THE Direction D invariant: a mode is a CONTROL now, so it must not also
      // appear here as a fact. If this ever fails, the AUTO/Autonomy duplicate
      // the owner complained about has come back.
      expect(band.textContent).not.toContain('AUTO');
      // Identity/reference fields that duplicated the AgentDossier panel
      // (P-003) moved there exclusively — this band never repeats them.
      expect(band.textContent).not.toContain('gui-chat-controls');
      expect(band.textContent).not.toContain('👑');
      expect(band.textContent).not.toContain('gui-chat-session-controls-2026-07-25');
      expect(band.textContent).not.toContain('Building the session footer');
    });

    /**
     * popup-agent-state-coverage-2026-08-18 P-006. `pidAlive` reached this
     * component on every roster payload and was read ZERO times across the whole
     * popup tree, so a zombie — fresh heartbeat, dead process — rendered as an
     * ordinary live session with a composer under it. You type, see "Sent", and
     * nothing ever comes back.
     */
    it('flags a ZOMBIE inline in the band — fresh heartbeat, dead process', async () => {
      seedRoster([
        {
          ownerId: 'su-live-1',
          liveness: 'live',
          sessionState: 'live',
          pidAlive: false,
          stale: false,
          modes: [],
          claims: [],
          currentFiles: [],
          openAwait: null,
        },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      const chip = await waitFor(() => screen.getByTestId('session-chat-state-zombie'));
      expect(chip.textContent).toContain('process gone');
      // The board's exact wording, imported rather than retyped — if these two
      // surfaces ever describe the same session differently, this fails.
      expect(chip.getAttribute('title')).toBe(ZOMBIE_REASON);
      // It sits INLINE, beside the status chip it contradicts — not behind the
      // right-edge alert affordance (D-007). An alert you have to click is the
      // wrong home for the fact that invalidates the composer below it.
      const band = screen.getByTestId('session-chat-state-header');
      expect(band.contains(chip)).toBe(true);
    });

    it('does NOT flag a zombie when liveness could not be checked (pidAlive null)', async () => {
      seedRoster([
        {
          ownerId: 'su-live-1',
          liveness: 'live',
          sessionState: 'live',
          // A federated peer, a row with no pid, a different host. "Could not
          // check" is not a death claim, and rendering it as one would put a ☠
          // on every remote agent on the board.
          pidAlive: null,
          stale: false,
          modes: [],
          claims: [],
          currentFiles: [],
          openAwait: null,
        },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      await waitFor(() => expect(screen.getByTestId('session-chat-state-header')).toBeTruthy());
      expect(screen.queryByTestId('session-chat-state-zombie')).toBeNull();
    });

    /**
     * P-008 / D-004. The ctx pill had no provenance at all. That is how a frozen
     * estimate went unnoticed across 48 sessions (one at 2.7× its true usage) —
     * the value stopped moving while its timestamp kept refreshing. So the pill
     * renders the AGE OF THE READING and never a freshness claim.
     */
    it('renders the AGE of the context reading, never a freshness claim', async () => {
      seedRoster([
        {
          ownerId: 'su-live-1',
          liveness: 'live',
          contextTokens: 94_000,
          compactionLimit: 200_000,
          contextEstimatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
          modes: [],
          claims: [],
          currentFiles: [],
          openAwait: null,
        },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      const band = await waitFor(() => screen.getByTestId('session-chat-state-header'));
      expect(band.textContent).toContain('ctx 47%');
      expect(band.textContent).toContain('measured 3m ago');
      // The words that would make this a lie. A fresh STAMP does not prove a
      // fresh VALUE, and the pill must never imply that it does.
      expect(band.textContent).not.toMatch(/\bfresh\b/i);
      expect(band.textContent).not.toMatch(/\bcurrent\b/i);
    });

    it('omits the reading age entirely when the roster carries no stamp', async () => {
      seedRoster([
        {
          ownerId: 'su-live-1',
          liveness: 'live',
          contextTokens: 94_000,
          compactionLimit: 200_000,
          // An older operator's payload, a federated peer, or a row the watchdog
          // has never sampled. Saying nothing is honest; "measured just now"
          // would be the same lie the age exists to prevent, in a shorter form.
          modes: [],
          claims: [],
          currentFiles: [],
          openAwait: null,
        },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      const band = await waitFor(() => screen.getByTestId('session-chat-state-header'));
      expect(band.textContent).toContain('ctx 47%');
      expect(band.textContent).not.toContain('measured');
    });

    it('renders the authoritative sessionState instead of heartbeat liveness', async () => {
      seedRoster([
        {
          ownerId: 'su-live-1',
          // A parked/ended session can keep a fresh heartbeat briefly. This is
          // the exact disagreement that made the old chip say "live".
          liveness: 'live',
          sessionState: 'ended',
          lastActiveAt: new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString(),
          modes: [],
          claims: [],
          currentFiles: [],
          openAwait: null,
        },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      const band = await waitFor(() => screen.getByTestId('session-chat-state-header'));
      const status = band.querySelector('[data-session-state="ended"]');
      expect(status).toBeTruthy();
      expect(status!.textContent).toContain('ended');
      expect(status!.textContent).not.toMatch(/\blive\b/);
      expect(status!.getAttribute('title')).toContain('Session state: ended');
      expect(status!.getAttribute('title')).toContain('last activity: 2d ago');

      // WI-38052's sibling affordance must consume the same terminal oracle:
      // an ended session cannot receive a wake, so the composer is hidden and
      // explains the relaunch/resume path instead of inviting a dead send.
      expect(screen.getByTestId('session-chat-composer-unavailable').textContent).toContain(
        'session has ended',
      );
      expect(screen.queryByPlaceholderText(/Type to wake/i)).toBeNull();

      const dot = status!.querySelector('[role="img"]');
      expect(dot?.getAttribute('data-session-state')).toBe('ended');
      expect(dot?.getAttribute('data-liveness')).toBe('stale');
      expect(dot?.getAttribute('aria-label')).toBe('ended agent');
    });

    it.each([
      {
        state: 'live',
        liveness: 'live',
        placeholder: /Reply to su · live-1/i,
        dotLiveness: 'live',
      },
      {
        state: 'parked',
        // A parked session may retain a fresh heartbeat; sessionState is the
        // authoritative value for both the status chip and composer affordance.
        liveness: 'live',
        placeholder: /Type to wake su · live-1/i,
        dotLiveness: 'idle',
      },
    ])('maps $state to the matching composer affordance', async ({ state, liveness, placeholder, dotLiveness }) => {
      seedRoster([
        {
          ownerId: 'su-live-1',
          liveness,
          sessionState: state,
          modes: [],
          claims: [],
          currentFiles: [],
          openAwait: null,
        },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(
        <SessionChatModal
          sessionOwnerId="su-live-1"
          ownerLabel="su · live-1"
          onClose={vi.fn()}
        />,
      );
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      const band = await waitFor(() => screen.getByTestId('session-chat-state-header'));
      const status = band.querySelector(`[data-session-state="${state}"]`);
      expect(status).toBeTruthy();
      expect(status!.textContent).toContain(state);
      expect(status!.getAttribute('title')).toContain(`Session state: ${state}`);
      expect(status!.querySelector('[role="img"]')?.getAttribute('data-liveness')).toBe(dotLiveness);
      expect(screen.getByPlaceholderText(placeholder)).toBeTruthy();
      expect(screen.queryByTestId('session-chat-composer-unavailable')).toBeNull();
    });

    it('never renders the always-armed inbox-wake as a blocked-on gate (isInfrastructureAwait)', async () => {
      seedRoster([
        {
          ownerId: 'su-live-1',
          modes: [],
          claims: [],
          currentFiles: [],
          openAwait: {
            eventKey: 'coord:inbox-wake:su-live-1',
            note: null,
            sinceIso: new Date().toISOString(),
            expiresIso: null,
          },
        },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      const band = await waitFor(() => screen.getByTestId('session-chat-state-header'));
      expect(band.textContent).not.toContain('Waiting on');
      expect(band.textContent).not.toContain('coord:inbox-wake');
    });

    it('renders a real open-await note as the blocked-on line', async () => {
      seedRoster([
        {
          ownerId: 'su-live-1',
          modes: [],
          claims: [],
          currentFiles: [],
          openAwait: {
            eventKey: 'some:real:gate',
            note: 'waiting for review',
            sinceIso: new Date().toISOString(),
            expiresIso: null,
          },
        },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      const band = await waitFor(() => screen.getByTestId('session-chat-state-header'));
      expect(band.textContent).toContain('waiting for review');
    });

    /* popup-agent-state-coverage-2026-08-18 P-009. The chip said WHAT the agent
       is waiting on and never for how long — and the duration is the half that
       decides whether to intervene. `sinceIso` was already on the payload with
       no reader. */
    it('renders how long the await has been open, from openAwait.sinceIso', async () => {
      seedRoster([
        {
          ownerId: 'su-live-1',
          modes: [],
          claims: [],
          currentFiles: [],
          openAwait: {
            eventKey: 'some:real:gate',
            note: 'waiting for review',
            sinceIso: new Date(Date.now() - 41 * 60_000).toISOString(),
            expiresIso: null,
          },
        },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      const age = await waitFor(() => screen.getByTestId('session-chat-state-await-age'));
      expect(age.textContent).toContain('41m');
      // The age is a FACT, not a verdict: the chip must not decide for the
      // reader that 41m is too long. That judgement belongs to the leader-brief
      // alerts in the peers rail, which carry their evidence with them.
      expect(age.textContent).not.toMatch(/stuck|stalled|too long/i);
      const chip = screen.getByTestId('session-chat-state-await');
      expect(chip.getAttribute('title')).toContain('Open for 41m.');
      // No recorded timeout is NOT "no timeout" — the tooltip says which.
      expect(chip.getAttribute('title')).toContain('No timeout on record');
      expect(screen.queryByTestId('session-chat-state-await-expiry')).toBeNull();
    });

    it('renders NO age — never "0s" — when the await carries no start time', async () => {
      // The honesty rule this pins: a duration we could not compute renders as
      // nothing. "0s" would say the wait just started, about a wait we never
      // dated, and it is the reading most likely to stop someone intervening.
      seedRoster([
        {
          ownerId: 'su-live-1',
          modes: [],
          claims: [],
          currentFiles: [],
          openAwait: {
            eventKey: 'some:real:gate',
            note: 'waiting for review',
            sinceIso: 'definitely not a date',
            expiresIso: null,
          },
        },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      const chip = await waitFor(() => screen.getByTestId('session-chat-state-await'));
      expect(chip.textContent).toContain('waiting for review');
      expect(screen.queryByTestId('session-chat-state-await-age')).toBeNull();
      expect(chip.textContent).not.toContain('0s');
      expect(chip.getAttribute('title')).toContain('No start time on record');
    });

    it('marks an await whose timeout has already passed', async () => {
      seedRoster([
        {
          ownerId: 'su-live-1',
          modes: [],
          claims: [],
          currentFiles: [],
          openAwait: {
            eventKey: 'some:real:gate',
            note: 'waiting for review',
            sinceIso: new Date(Date.now() - 3 * 3_600_000).toISOString(),
            expiresIso: new Date(Date.now() - 60_000).toISOString(),
          },
        },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      const expiry = await waitFor(() => screen.getByTestId('session-chat-state-await-expiry'));
      expect(expiry.textContent).toContain('timed out');
      const chip = screen.getByTestId('session-chat-state-await');
      expect(chip.getAttribute('title')).toContain('Its timeout has already passed.');
      expect(screen.getByTestId('session-chat-state-await-age').textContent).toContain('3h');
    });

    it('puts a live timeout in the tooltip without crowding the chip', async () => {
      seedRoster([
        {
          ownerId: 'su-live-1',
          modes: [],
          claims: [],
          currentFiles: [],
          openAwait: {
            eventKey: 'some:real:gate',
            note: 'waiting for review',
            sinceIso: new Date(Date.now() - 5 * 60_000).toISOString(),
            expiresIso: new Date(Date.now() + 25 * 60_000).toISOString(),
          },
        },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      const chip = await waitFor(() => screen.getByTestId('session-chat-state-await'));
      expect(chip.getAttribute('title')).toContain('Times out in 25m.');
      // A still-live timeout is not an alarm, so it does not take chip space —
      // only the elapsed age does. Only "timed out" earns a visible mark.
      expect(screen.queryByTestId('session-chat-state-await-expiry')).toBeNull();
    });

    /* [owner 2026-08-02, screenshotted] `openAwait.note` is agent-authored free
       text with no length bound — a real one was a 400-character carry-note. The
       chip is `white-space: nowrap`, so it grew to the width of the whole string
       and ran off the right edge of the popup, pushing the chips after it onto a
       second row. Both halves of the fix are pinned here: the text must be
       CLIPPABLE, and clipping must not LOSE it. */
    it('clips a long await note to one line and keeps the full text in the tooltip', async () => {
      const longNote =
        'RE-ARM #3. Shipping EI-19361771982678588. STATE 20:50Z: gate is HEALTHY again ' +
        '(verdicts ~19min apart: 20:02Z, 20:21Z, 20:40Z) — my earlier "wedged" conclusion ' +
        'is CORRECTED and superseded. My change is IN the judged candidates and GREEN there.';
      seedRoster([
        {
          ownerId: 'su-live-1',
          modes: [],
          claims: [],
          currentFiles: [],
          openAwait: {
            eventKey: 'some:real:gate',
            note: longNote,
            sinceIso: new Date().toISOString(),
            expiresIso: null,
          },
        },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      const chip = await waitFor(() => screen.getByTestId('session-chat-state-await'));
      // The variable-length text sits in its own clipping element. Without this
      // element `text-overflow: ellipsis` is inert on an inline-flex chip, so
      // the string would clip with no ellipsis — or not clip at all.
      const clip = chip.querySelector('.pc-ctl-state__clip');
      expect(clip).toBeTruthy();
      expect(clip!.textContent).toBe(longNote);
      // Nothing is lost to the clip: the tooltip carries the event key AND the
      // whole note. The key comes first because that is what you search for.
      const title = chip.getAttribute('title') ?? '';
      expect(title).toContain('some:real:gate');
      expect(title).toContain('CORRECTED and superseded');
    });

    it('the state chip declares a width ceiling, so no free-text chip can overflow the band', () => {
      // Guards the CSS half. `white-space: nowrap` without a max-width is the
      // exact combination that produced the overflow, and it is easy to
      // reintroduce by "tidying" the base class.
      const css = readFileSync(
        resolve(__dirname, 'chat-controls.css'),
        'utf8',
      );
      const base = css.split('}').find((b) => b.includes('.pc-ctl-state {'));
      expect(base).toMatch(/max-width:\s*\d/);
      const clip = css.split('}').find((b) => b.includes('.pc-ctl-state__clip'));
      expect(clip).toMatch(/text-overflow:\s*ellipsis/);
      expect(clip).toMatch(/overflow:\s*hidden/);
    });

    it('omits the band entirely when there is no matching roster row (same fallback as the identity chip)', async () => {
      seedRoster([{ ownerId: 'su-someone-else' }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      await waitFor(() => expect(screen.getByText('hi')).toBeTruthy());
      expect(screen.queryByTestId('session-chat-state-header')).toBeNull();
    });

    it('P-004: the "N locks / M unread" summary chip renders from agentDetail.byOwner and opens the dossier rail on click (D-002 deliberate duplicate)', async () => {
      seedRoster([{ ownerId: 'su-live-1', liveness: 'live', modes: [], claims: [], currentFiles: [], openAwait: null }]);
      H.results['agentDetail.byOwner'] = {
        data: [
          {
            ownerId: 'su-live-1',
            locks: { held: [{ path: 'a.ts' }], waiting: [], error: null },
            // `unread` is REQUIRED on the coord detail (adv-agent-detail.ts). This fixture
            // predates it. Empty is legal against a non-zero count — the contract is that
            // `unreadCount` stays the TRUE total while `unread` is bounded server-side, so
            // `unreadCount > unread.length` means "showing N of M", not a disagreement.
            coord: { lastMessage: null, unreadCount: 3, unread: [], openHandoffs: [], openEscalations: [], error: null },
            nativeSession: null,
            codex: null,
          },
        ],
        loading: false,
        fetching: false,
        error: null,
        invalidate: vi.fn(),
      };
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      // P-004 splits the old single summary chip into TWO alerts, because they
      // route to two different rail sections and one merged chip could only
      // ever open one of them.
      const locks = await waitFor(() => screen.getByTestId('session-chat-alert-locks'));
      expect(locks.textContent).toContain('1 lock');

      const coord = screen.getByTestId('session-chat-alert-coord');
      // WI-6504: the count must NAME its corpus. A bare "3 unread" beside the
      // transcript reads as "this conversation has 3 unread messages", but it
      // counts COORD messages — the owner reported "32 unread" beside a single
      // rendered message. Assert the visible qualifier so the ambiguous label
      // cannot come back.
      expect(coord.textContent).toContain('3 coord unread');
      // The full distinction now rides on aria-label rather than a `title`
      // attribute: these are Tooltip triggers (design-primitives forbids a
      // title-only tooltip on a button), and aria-label is the half that is
      // actually announced rather than only revealed on hover.
      expect(coord.getAttribute('aria-label')).toContain('coord message');
      expect(coord.getAttribute('aria-label')).toContain('separate list');

      fireEvent.click(locks);
      expect(nuqsSetters['chatDossier']).toHaveBeenCalledWith(true);
    });

    it('omits both alerts when there are no locks and nothing unread', async () => {
      seedRoster([{ ownerId: 'su-live-1', liveness: 'live', modes: [], claims: [], currentFiles: [], openAwait: null }]);
      H.results['agentDetail.byOwner'] = {
        data: [
          {
            ownerId: 'su-live-1',
            locks: { held: [], waiting: [], error: null },
            coord: { lastMessage: null, unreadCount: 0, unread: [], openHandoffs: [], openEscalations: [], error: null },
            nativeSession: null,
            codex: null,
          },
        ],
        loading: false,
        fetching: false,
        error: null,
        invalidate: vi.fn(),
      };
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'hi' }]));
      });

      // The band itself still renders — it is the ALERTS that are conditional.
      // Asserting the band is present first is what keeps this a real check
      // rather than one that would pass against a surface that vanished.
      await waitFor(() => expect(screen.getByTestId('session-chat-state-header')).toBeTruthy());
      expect(screen.queryByTestId('session-chat-alert-locks')).toBeNull();
      expect(screen.queryByTestId('session-chat-alert-coord')).toBeNull();
    });
  });

  it('the composer sends a coord:send to the resolved owner with wake:"required"', async () => {
    mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
    render(<SessionChatModal sessionOwnerId="su-live-1" ownerLabel="su · live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(captured).not.toBeNull());
    act(() => {
      captured!.handlers.backfill!(JSON.stringify([]));
    });

    mockFetchOnce(200, { ok: true, msg_id: 'm1' });
    const input = screen.getByPlaceholderText(/Type to wake su · live-1/i);
    fireEvent.change(input, { target: { value: 'hey, can you clarify X?' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        '/api/admin/coord/send',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            to: ['su-live-1'],
            summary: 'hey, can you clarify X?',
            body: 'hey, can you clarify X?',
            wake: 'required',
          }),
        }),
      ),
    );
    /* The banner is OUTCOME-SPECIFIC (see the note above SendDelivery): this send is
       mocked as a bare { ok, msg_id } with no wake report, which is the QUEUED outcome,
       not the woken one. The old assertion here expected "Sent — the agent is woken",
       the unconditional banner that was REMOVED precisely because it claimed a wake
       that had not happened — so asserting it again would re-pin the lie. */
    await waitFor(() =>
      expect(screen.getByTestId('session-chat-send-outcome').getAttribute('data-delivery')).toBe('queued'),
    );
    expect(screen.getByText(/Delivered to the agent’s inbox/)).toBeTruthy();
  });

  /* The other three delivery outcomes had NO coverage at all, which is how the stale
     assertion above survived: the whole point of this banner is that it must not claim
     a wake that did not happen, and nothing was pinning that. One case per branch. */
  it('reports a real wake as woken when the send reports woken > 0', async () => {
    mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
    render(<SessionChatModal sessionOwnerId="su-live-1" ownerLabel="su · live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(captured).not.toBeNull());
    act(() => {
      captured!.handlers.backfill!(JSON.stringify([]));
    });

    mockFetchOnce(200, { ok: true, results: [{ ok: true, wake: { woken: 1 } }] });
    fireEvent.change(screen.getByPlaceholderText(/Type to wake su · live-1/i), {
      target: { value: 'ping' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByTestId('session-chat-send-outcome').getAttribute('data-delivery')).toBe('woken'),
    );
    expect(screen.getByText(/was woken and is working on it/)).toBeTruthy();
  });

  it('does NOT claim a wake when the recipient was absent', async () => {
    mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
    render(<SessionChatModal sessionOwnerId="su-live-1" ownerLabel="su · live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(captured).not.toBeNull());
    act(() => {
      captured!.handlers.backfill!(JSON.stringify([]));
    });

    mockFetchOnce(200, { ok: true, results: [{ ok: true, recipient_absent: true }] });
    fireEvent.change(screen.getByPlaceholderText(/Type to wake su · live-1/i), {
      target: { value: 'ping' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByTestId('session-chat-send-outcome').getAttribute('data-delivery')).toBe('absent'),
    );
    expect(screen.getByText(/no live session picked it up/)).toBeTruthy();
  });

  it('reports a manual-wake recipient as staged, not delivered', async () => {
    mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
    render(<SessionChatModal sessionOwnerId="su-live-1" ownerLabel="su · live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(captured).not.toBeNull());
    act(() => {
      captured!.handlers.backfill!(JSON.stringify([]));
    });

    mockFetchOnce(200, { ok: true, results: [{ ok: true, staged: true }] });
    fireEvent.change(screen.getByPlaceholderText(/Type to wake su · live-1/i), {
      target: { value: 'ping' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByTestId('session-chat-send-outcome').getAttribute('data-delivery')).toBe('staged'),
    );
    expect(screen.getByText(/held until you release it/)).toBeTruthy();
  });

  it('surfaces a coord:send failure instead of silently dropping the message', async () => {
    mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(captured).not.toBeNull());
    act(() => {
      captured!.handlers.backfill!(JSON.stringify([]));
    });

    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'send failed' });
    const input = screen.getByPlaceholderText(/Type to wake/i);
    fireEvent.change(input, { target: { value: 'ping' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(screen.getByText(/coord:send.*500/)).toBeTruthy());
  });

  it('calls onClose when the dialog is dismissed', async () => {
    mockFetchOnce(200, { sessions: [] });
    const onClose = vi.fn();
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('No recent session found for this agent.')).toBeTruthy());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  describe('P-008 chat:ask_choice card rendering (mcp-mangled tool names)', () => {
    it('renders the AskChoiceCard (not a plain chip) for a raw mcp-mangled tool_use in the live transcript', async () => {
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());

      act(() => {
        captured!.handlers.backfill!(
          JSON.stringify([
            { kind: 'prompt', text: 'owner asks something' },
            {
              // What Claude's own tool_use block actually carries for an
              // MCP-routed call — the client-mangled id, never the registry's
              // canonical colon-form 'chat:ask_choice' (gui-chat-session-controls
              // -2026-07-25 P-008: this is why the card silently never rendered).
              kind: 'tool_use',
              toolName: 'mcp__papercusp-su__chat_ask_choice',
              toolInput: {
                question: 'Which route?',
                options: [{ id: 'a', label: 'Option A' }, { id: 'b', label: 'Option B' }],
              },
            },
          ]),
        );
      });

      await waitFor(() => expect(screen.getByText('Which route?')).toBeTruthy());
      expect(screen.getByText('Option A')).toBeTruthy();
      expect(screen.getByText('Option B')).toBeTruthy();
    });
  });

  describe('P-008 cards in the popup', () => {
    it('renders this owner\'s pending coord-escalation-with-options inline via the shared OtherDetail card', async () => {
      seedAttention([mkEscalation('esc-1')]);
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-pending-escalations')).toBeTruthy());
      const card = screen.getByTestId('other-detail');
      expect(card.getAttribute('data-item')).toBe('esc-1');
    });

    /* [owner 2026-08-09, verbatim: "those decision buttons at the top of the
       conversation should be displayed at the bottom instead"]. Nothing pinned
       the ORDER before this — every existing assertion here checks only that
       the block EXISTS, so the block could migrate back above the transcript
       with the whole suite still green. These two are the recurrence guard. */
    it('[owner 2026-08-09] docks the decisions shelf BELOW the transcript, never above it', async () => {
      seedAttention([mkEscalation('esc-1')]);
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-pending-escalations')).toBeTruthy());
      const shelf = screen.getByTestId('session-chat-pending-escalations');
      // With no resolved session the transcript slot renders this banner, so it
      // stands in for "where the conversation goes" without needing a live stream.
      const transcriptSlot = screen.getByText('No recent session found for this agent.');

      expect(
        transcriptSlot.compareDocumentPosition(shelf) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('[owner 2026-08-09] the shelf is a .pc-zone (else its title cap fill silently resolves to unset) and states the open count', async () => {
      seedAttention([mkEscalation('esc-1'), mkEscalation('esc-2')]);
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-pending-escalations')).toBeTruthy());
      const shelf = screen.getByTestId('session-chat-pending-escalations');
      // Not cosmetic: chat-controls.css defines the zone vars ON the zone roots,
      // so dropping this class renders an INVISIBLE cap rather than failing loudly.
      expect(shelf.className.split(/\s+/)).toContain('pc-zone');
      expect(shelf.querySelector('.pc-chat-decisions__count')?.textContent).toBe('2');
    });

    /* D-007 step 5 (WI-7323): "see where this was asked ↑".
       The link is only shippable because it REFUSES: nothing on an escalation
       record names a transcript position (no session id, no message index —
       key census over the live coord_open_escalations, 2026-09-04), so the
       target is DERIVED by bracketing the ask's `occurredAt` into the turn that
       was running. A wrong target is worse than no link AND passes a
       presence-only check, so the three refusals below carry more weight than
       the positive case. The bracket itself is unit-tested in
       session-turn-index.test.ts; what these pin is that the popup feeds the
       right item's stamp to it and renders nothing when it declines. */
    const ASK_T0 = Date.parse('2026-09-04T12:00:00.000Z');
    const askAt = (msAfter: number) => new Date(ASK_T0 + msAfter).toISOString();

    /** A settled two-turn transcript (Q 0s / A 60s, Q 120s / A 180s). */
    async function renderWithTranscript(items: AttentionItem[]) {
      seedAttention(items);
      mockFetchOnce(200, {
        sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }],
      });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(
          JSON.stringify([
            { kind: 'prompt', text: 'first question', ts: askAt(0) },
            { kind: 'text', text: 'first answer', ts: askAt(60_000) },
            { kind: 'prompt', text: 'second question', ts: askAt(120_000) },
            { kind: 'text', text: 'second answer', ts: askAt(180_000) },
          ]),
        );
      });
      await waitFor(() =>
        expect(screen.getByTestId('session-chat-pending-escalations')).toBeTruthy(),
      );
    }

    it('offers "see where this was asked" when the ask lands inside a turn of THIS transcript', async () => {
      await renderWithTranscript([mkEscalation('esc-1', { occurredAt: askAt(30_000) })]);
      await waitFor(() => expect(screen.getByTestId('decision-asked-at')).toBeTruthy());
      expect(screen.getByTestId('decision-asked-at').textContent).toMatch(
        /see where this was asked/i,
      );
    });

    it('offers NO link when the ask predates this transcript (the carry-respawn case)', async () => {
      await renderWithTranscript([mkEscalation('esc-1', { occurredAt: askAt(-3_600_000) })]);
      expect(screen.queryByTestId('decision-asked-at')).toBeNull();
    });

    /* The fourth refusal — an ask filed AFTER the session settled — is pinned in
       session-turn-index.test.ts and deliberately NOT re-asserted here. This
       file's message list accumulates ACROSS its tests (a run of the whole file
       hands this render six turns: the two seeded above plus four leaked from
       earlier cases, stamped at real wall-clock time and unanswered), so the
       component fixture cannot express "the transcript ends here" — the instant
       always lands in a gap between a seeded turn and a leaked one. Measured
       2026-09-04: the case passes filtered and fails in a full-file run, which
       is a property of the fixture, not of the derivation. Do not "fix" it by
       adding the case back; it would be a flake, and the rule it guards is
       already covered where the input is isolated. */

    it('offers NO link when the item carries no timestamp at all', async () => {
      await renderWithTranscript([mkEscalation('esc-1')]);
      expect(screen.queryByTestId('decision-asked-at')).toBeNull();
    });

    it('resolves each card against its OWN stamp rather than the shelf as a whole', async () => {
      await renderWithTranscript([
        mkEscalation('esc-1', { occurredAt: askAt(30_000) }),
        mkEscalation('esc-2', { occurredAt: askAt(-3_600_000) }),
      ]);
      await waitFor(() => expect(screen.getAllByTestId('other-detail')).toHaveLength(2));
      expect(screen.getAllByTestId('decision-asked-at')).toHaveLength(1);
    });

    /* [owner 2026-08-09] "What do those buttons actually do its unclear."
       The legend is the only thing on this surface that distinguishes an
       ANSWER (terminal — replies to the agent, wakes it, closes the record)
       from Discuss (opens a thread, touches no server state). Both claims are
       checked against the dispatch in attention-card.test.ts; this pins that
       the sentence is actually RENDERED, because a legend that silently stops
       shipping looks identical to the confusion it was added to fix. */
    it('[owner 2026-08-09] the shelf states what a pick does, and that Discuss answers nothing', async () => {
      seedAttention([mkEscalation('esc-1')]);
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-pending-escalations')).toBeTruthy());
      const legend = screen
        .getByTestId('session-chat-pending-escalations')
        .querySelector('.pc-chat-decisions__legend');
      expect(legend).toBeTruthy();
      const text = legend?.textContent ?? '';
      // The terminal side: all three effects named, none of them implied.
      expect(text).toMatch(/replies to the agent/i);
      expect(text).toMatch(/wakes it/i);
      expect(text).toMatch(/closes the decision/i);
      // The non-terminal side — the half that caused EI-13037 when it was invisible.
      expect(text).toMatch(/answers nothing/i);
    });

    /* Each decision is wrapped so the SHELF owns the only scroll (the card is
       intrinsic-height, its body no longer scrolls — chat-controls.css). The
       wrapper is what those rules hang off, so losing it silently restores the
       24px-tall scroll port inside a scroll that the owner reported. */
    it('[owner 2026-08-09] wraps every decision in the single-scroll card wrapper', async () => {
      seedAttention([mkEscalation('esc-1'), mkEscalation('esc-2')]);
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-pending-escalations')).toBeTruthy());
      const shelf = screen.getByTestId('session-chat-pending-escalations');
      const cards = shelf.querySelectorAll('.pc-chat-decisions__card');
      expect(cards.length).toBe(2);
      // Wrapper must CONTAIN the card, not sit beside it — a sibling would
      // leave the CSS matching nothing while this count still passed.
      for (const card of cards) expect(card.querySelector('[data-testid="other-detail"]')).toBeTruthy();
    });

    /* RECURRENCE GUARD for a bug this pass shipped and then caught by DRIVING
       the control in the live shell rather than asserting it exists.

       Expanding removes the clamp, so the next measurement legitimately reports
       "fits" — which set `overflowing` false and UNMOUNTED the toggle, stranding
       the card open with no way back. A live `check` asserting only that the
       toggle EXISTS passed against a card in exactly that state, because the
       toggle does exist... until you use it. jsdom has no layout, so scroll
       geometry is stubbed here; what is under test is the state machine, which
       is where the defect was. */
    it('[owner 2026-08-09] the expand toggle survives its own click — expand must be reversible', async () => {
      const proto = window.HTMLElement.prototype;
      const scrollDesc = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
      const clientDesc = Object.getOwnPropertyDescriptor(proto, 'clientHeight');
      // Clipped only while COLLAPSED — exactly how the real CSS behaves, and the
      // condition under which the bug appeared. Reporting a constant overflow
      // would make this test pass against the broken code.
      Object.defineProperty(proto, 'scrollHeight', {
        configurable: true,
        get(this: HTMLElement) {
          return this.classList.contains('ask-choice-card') ? 500 : 0;
        },
      });
      Object.defineProperty(proto, 'clientHeight', {
        configurable: true,
        get(this: HTMLElement) {
          if (!this.classList.contains('ask-choice-card')) return 0;
          return this.closest('.pc-chat-decisions__card')?.classList.contains('is-expanded')
            ? 500
            : 132;
        },
      });
      try {
        seedAttention([mkEscalation('esc-1')]);
        mockFetchOnce(200, { sessions: [] });
        render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

        await waitFor(() => expect(screen.getByTestId('decision-expand')).toBeTruthy());
        expect(screen.getByTestId('decision-expand').textContent).toMatch(/show full request/i);

        fireEvent.click(screen.getByTestId('decision-expand'));
        // THE ASSERTION THAT FAILS ON THE BUG: still mounted, now offering the
        // way back. Before the fix this query threw — the control vanished.
        await waitFor(() =>
          expect(screen.getByTestId('decision-expand').textContent).toMatch(/show less/i),
        );
        expect(screen.getByTestId('decision-expand').getAttribute('aria-expanded')).toBe('true');

        fireEvent.click(screen.getByTestId('decision-expand'));
        await waitFor(() =>
          expect(screen.getByTestId('decision-expand').textContent).toMatch(/show full request/i),
        );
      } finally {
        if (scrollDesc) Object.defineProperty(proto, 'scrollHeight', scrollDesc);
        if (clientDesc) Object.defineProperty(proto, 'clientHeight', clientDesc);
      }
    });

    it('answering the inline card (onResolved) refreshes the shared attention feed', async () => {
      seedAttention([mkEscalation('esc-1')]);
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('other-detail')).toBeTruthy());
      fireEvent.click(screen.getByTestId('stub-resolve'));
      expect(attentionInvalidate).toHaveBeenCalled();
    });

    it('ignores an escalation belonging to a DIFFERENT agent', async () => {
      seedAttention([mkEscalation('esc-other', { ownerAgentId: 'su-someone-else' })]);
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByText('No recent session found for this agent.')).toBeTruthy());
      expect(screen.queryByTestId('session-chat-pending-escalations')).toBeNull();
    });

    it('ignores an already-handled escalation', async () => {
      seedAttention([mkEscalation('esc-handled', { tier: 'handled' })]);
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByText('No recent session found for this agent.')).toBeTruthy());
      expect(screen.queryByTestId('session-chat-pending-escalations')).toBeNull();
    });

    it('EI-19403137552594870: still renders a coord-escalation with no named options (OtherDetail falls back to its generic actions bar)', async () => {
      seedAttention([mkEscalation('esc-no-opts', { ref: { kind: 'coord-escalation', options: [] } })]);
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-pending-escalations')).toBeTruthy());
      expect(screen.getByTestId('other-detail').getAttribute('data-item')).toBe('esc-no-opts');
    });

    it('EI-19403137552594870: renders this owner\'s own kind:\'conversation\' question to the owner inline — previously invisible here', async () => {
      seedAttention([
        mkEscalation('convo-1', {
          kind: 'conversation',
          ref: { kind: 'conversation', conversationId: 'c1' },
          actions: [{ id: 'answer', label: 'Answer' }],
        }),
      ]);
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-pending-escalations')).toBeTruthy());
      expect(screen.getByTestId('other-detail').getAttribute('data-item')).toBe('convo-1');
    });

    it('ignores a non-escalation, non-conversation attention item (e.g. a coord-message) for the same owner', async () => {
      seedAttention([mkEscalation('msg-1', { kind: 'coord-message', ref: { kind: 'coord-message', msgId: 'm1' } })]);
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByText('No recent session found for this agent.')).toBeTruthy());
      expect(screen.queryByTestId('session-chat-pending-escalations')).toBeNull();
    });

    it('EI-19403137552594870: caps the pending-cards region at PENDING_CARDS_MAX so a large backlog cannot swallow the transcript', async () => {
      seedAttention(Array.from({ length: 9 }, (_, n) => mkEscalation(`esc-${n}`)));
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-pending-escalations')).toBeTruthy());
      expect(screen.getAllByTestId('other-detail')).toHaveLength(5);
    });

    it('renders no pending-escalations section while closed (sessionOwnerId null)', () => {
      seedAttention([mkEscalation('esc-1')]);
      render(<SessionChatModal sessionOwnerId={null} onClose={vi.fn()} />);
      expect(screen.queryByTestId('session-chat-pending-escalations')).toBeNull();
    });

    /**
     * WI-2144754: a FAILED attention read must not render as an empty shelf.
     *
     * The two states are pixel-identical without this: the shelf renders
     * nothing when there is nothing pending, so a rejected query silently
     * tells the owner "nothing needs you" — the one reading never safe to
     * guess (the same principle AttentionCountsRow.degraded already encodes
     * for the badge).
     *
     * Measured cause, 2026-09-05: the scoped read sends `ownerAgentId`, and a
     * server predating that arg rejects the WHOLE call (`invalid_args:
     * Unrecognized key` — undeclared args are rejected, not ignored,
     * EI-10883). Every running operator did that, so the shelf was empty for
     * every owner, including one with 81 matching rows. The empty shelf was a
     * failing query wearing an empty queue's clothes.
     */
    function seedAttentionError(message: string) {
      H.results['plans.attention'] = {
        data: [],
        loading: false,
        fetching: false,
        error: new Error(message),
        invalidate: attentionInvalidate,
      };
    }

    // FALSIFIABLE BY CONSTRUCTION: this seeds `data: []`, so `pendingEscalations`
    // is provably empty and the OLD gate (`pendingEscalations.length > 0`) could
    // not render the section at all. The shelf is therefore reachable here only
    // through the `|| attentionError` clause — revert that clause and this test
    // fails on the first getByTestId. The calibration test below pins the other
    // direction, so the error branch cannot be made unconditional either.
    it('WI-2144754: surfaces a FAILED attention read instead of rendering an empty shelf', async () => {
      seedAttentionError('invalid_args: Unrecognized key: "ownerAgentId"');
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-pending-escalations')).toBeTruthy());
      const err = screen.getByTestId('session-chat-pending-escalations-error');
      // The distinction itself is the assertion: "couldn't load" must never be
      // presentable as "you have none".
      expect(err.textContent).toContain('Couldn’t load decisions');
      expect(err.textContent).toContain('not the same as having none');
      // The underlying reason is shown, not swallowed — this is what turns a
      // silent empty region into a diagnosable one.
      expect(err.textContent).toContain('Unrecognized key');
      // No cards, and crucially no count badge asserting a total we could not
      // measure. Scoped to the shelf's own count element rather than a bare
      // text query for "0" — the popup renders other counters (the turns
      // count), so a global text match would assert something else entirely.
      expect(screen.queryAllByTestId('other-detail')).toHaveLength(0);
      expect(
        screen.getByTestId('session-chat-pending-escalations').querySelector('.pc-chat-decisions__count'),
      ).toBeNull();
    });

    it('WI-2144754: the error shelf offers a retry that re-asks the feed', async () => {
      seedAttentionError('boom');
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-pending-escalations-error')).toBeTruthy());
      attentionInvalidate.mockClear();
      fireEvent.click(screen.getByText('Retry'));
      expect(attentionInvalidate).toHaveBeenCalled();
    });

    /**
     * CALIBRATION for the two tests above. They assert the presence of an
     * error node; that alone would still pass if the shelf rendered the error
     * branch unconditionally and never showed a decision again. This pins the
     * other side: a HEALTHY read shows cards and no error node.
     */
    it('WI-2144754 calibration: a healthy read renders cards and NO error node', async () => {
      seedAttention([mkEscalation('esc-1')]);
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-pending-escalations')).toBeTruthy());
      expect(screen.getAllByTestId('other-detail')).toHaveLength(1);
      expect(screen.queryByTestId('session-chat-pending-escalations-error')).toBeNull();
    });
  });

  describe('P-008 ref-pill popup routing (chat-ref-pills-2026-07-26, D-002 seam)', () => {
    function seedRoster(entries: Array<Record<string, unknown>>) {
      H.results['advRoster.list'] = {
        data: [{ active: entries, pending: [] }],
        loading: false,
        fetching: false,
        error: null,
        invalidate: vi.fn(),
      };
    }

    it('scopes a WI- ref pill click to the roster entry\'s harnessSlug', async () => {
      seedRoster([{ ownerId: 'su-live-1', fleetColor: null, fleetRole: 'member', harnessSlug: 'papercusp' }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      const { rerender } = render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'see WI-1234 for detail' }]));
      });

      const pill = await waitFor(() => screen.getByLabelText('WI-1234'));
      fireEvent.click(pill);
      rerender(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      // WI-6601: the chat WRITES the param; `chat/ChatRefPopupHost` renders it
      // once at the router root. The harness rides in the value, which is what
      // lets this popup open on a surface with no `?slug` at all.
      expect(nuqs.wpop).toBe('papercusp::WI-1234');
    });

    it('renders a static (non-clickable) pill when the roster entry has no harnessSlug', async () => {
      seedRoster([{ ownerId: 'su-live-1', fleetColor: null, fleetRole: 'member', harnessSlug: null }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'see WI-1234 for detail' }]));
      });

      const pill = await waitFor(() => screen.getByLabelText('WI-1234'));
      // No harnessSlug ⇒ OperatorChat's handleWorkRefActivate no-ops rather
      // than opening a popup pointed at no harness — but PapercupChat
      // still WIRES onWorkRefActivate (renders an interactive <button>); the
      // click itself is the thing that safely does nothing.
      fireEvent.click(pill);
      expect(nuqs.wpop).toBeUndefined();
    });

    // WI-5997: a real transcript click on a P- ref pill previously no-op'd —
    // session-transcript-mapping.ts never set ChatMessage.planSlug, so
    // handleWorkRefActivate's `if (ref.planSlug) …` branch always skipped.
    // This is the end-to-end regression test for that fix: roster
    // currentPlanSlug → mapped message planSlug → pill click → PlanPopupModal.
    it('a P- ref pill click opens PlanPopupModal, scoped to the roster entry\'s currentPlanSlug (WI-5997)', async () => {
      seedRoster([
        {
          ownerId: 'su-live-1',
          fleetColor: null,
          fleetRole: 'member',
          // harnessSlug is real roster data every live session carries, and
          // since WI-6601 it is what gets ENCODED into the `wppop` value (the
          // popup itself is mounted once at the router root, not here). It
          // stays in this fixture because the plan query is harness-scoped.
          harnessSlug: 'papercusp',
          currentPlanSlug: 'gui-chat-session-controls-2026-07-25',
        },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      const { rerender } = render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'see P-001 for the plan item' }]));
      });

      const pill = await waitFor(() => screen.getByLabelText('P-001'));
      fireEvent.click(pill);
      rerender(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      expect(nuqs.wppop).toBe('papercusp::gui-chat-session-controls-2026-07-25');
    });

    it('a P- ref pill click no-ops when the roster entry carries no currentPlanSlug (no plan context to open)', async () => {
      seedRoster([{ ownerId: 'su-live-1', fleetColor: null, fleetRole: 'member', currentPlanSlug: null }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      const { rerender } = render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      act(() => {
        captured!.handlers.backfill!(JSON.stringify([{ kind: 'text', text: 'see P-001 for the plan item' }]));
      });

      const pill = await waitFor(() => screen.getByLabelText('P-001'));
      fireEvent.click(pill);
      rerender(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      expect(nuqs.wppop).toBeUndefined();
    });
  });

  describe('P-003 AgentDossier right rail (hud-first-nav-and-dossier-2026-07-26)', () => {
    function seedRoster(
      entries: Array<Record<string, unknown>>,
      extra: Record<string, unknown> = {},
    ) {
      H.results['advRoster.list'] = {
        data: [{ active: entries, pending: [], ...extra }],
        loading: false,
        fetching: false,
        error: null,
        invalidate: vi.fn(),
      };
    }

    it('leaves room for the conversation on a laptop and keeps the side-panel toggles reachable', async () => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: ['(max-width: 1400px)', '(max-width: 1760px)', '(max-width: 2100px)'].includes(query),
        media: query, onchange: null, addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {}, dispatchEvent: () => true,
      }));
      seedRoster([{ ownerId: 'su-live-1' }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      expect(screen.queryByTestId('session-chat-dossier-rail')).toBeNull();
      expect(screen.queryByTestId('session-chat-orders-rail')).toBeNull();
      expect(screen.getByTestId('session-chat-dossier-toggle')).toBeTruthy();
      expect(screen.getByTestId('session-chat-orders-toggle')).toBeTruthy();
      expect(screen.getByText('Launch a fleet').closest('details')?.open).toBe(true);
      expect(screen.getByTestId('fleet-launch-row-stub')).toBeTruthy();
      nuqsSetters.chatLaunchFleet.mockClear();
      fireEvent.click(screen.getByText('Launch a fleet'));
      expect(nuqsSetters.chatLaunchFleet).toHaveBeenCalledWith(false);
    });

    it('respects an explicit ?chatLaunchFleet=false URL choice while defaulting open', async () => {
      nuqs.chatLaunchFleet = false;
      seedRoster([{ ownerId: 'su-live-1' }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());

      expect(screen.getByText('Launch a fleet').closest('details')?.open).toBe(false);
      expect(screen.queryByTestId('fleet-launch-row-stub')).toBeNull();
    });

    it('mounts the dossier rail by default when the viewport has room for it', async () => {
      seedRoster([{ ownerId: 'su-live-1', fleetColor: null, fleetRole: 'member' }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());

      const rail = await waitFor(() => screen.getByTestId('session-chat-dossier-rail'));
      expect(within(rail).getByTestId('agent-dossier-stub')).toBeTruthy();
      expect(lastAgentDossierProps?.ownerId).toBe('su-live-1');
      // Reuses the SAME already-fetched advRoster.list row (no forked
      // dossier, no second query) — the stubbed entry's ownerId round-trips.
      expect(lastAgentDossierProps?.entry?.ownerId).toBe('su-live-1');
    });

    it('passes an ended roster row to the dossier as terminal evidence, including its timestamp', async () => {
      const endedAt = '2026-08-11T23:16:59.000Z';
      seedRoster([], {
        ended: [{ coordOwnerId: 'su-ended-1', endedAt }],
      });
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-ended-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-dossier-rail')).toBeTruthy());
      await waitFor(() => expect(lastAgentDossierProps?.sessionEnded).toBe(true));
      expect(lastAgentDossierProps?.sessionEndedAt).toBe(endedAt);
      expect(lastAgentDossierProps?.unknownSession).toBe(false);
    });

    it('passes roster-ready absence to the dossier as unknown and marks Orders ownerKnown=false', async () => {
      seedRoster([]);
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-unknown-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-unknown-session')).toBeTruthy());
      await waitFor(() => expect(lastAgentDossierProps?.unknownSession).toBe(true));
      expect(lastAgentDossierProps?.sessionEnded).toBe(false);
      await waitFor(() => expect(lastAgentOrdersProps?.ownerKnown).toBe(false));
    });

    it('renders no rail while the modal is closed (sessionOwnerId null)', () => {
      render(<SessionChatModal sessionOwnerId={null} onClose={vi.fn()} />);
      expect(screen.queryByTestId('session-chat-dossier-rail')).toBeNull();
      expect(screen.queryByTestId('session-chat-dossier-toggle')).toBeNull();
    });

    it('the toggle button collapses and reopens the rail via the chatDossier nuqs key', async () => {
      seedRoster([{ ownerId: 'su-live-1' }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      const { rerender } = render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(screen.getByTestId('session-chat-dossier-rail')).toBeTruthy());

      fireEvent.click(screen.getByTestId('session-chat-dossier-toggle'));
      expect(nuqsSetters.chatDossier).toHaveBeenCalled();
      // The mock setter mutates the shared nuqs store synchronously but that
      // alone doesn't trigger a re-render — force one (same pattern the
      // ref-pill routing suite above uses for the same reason).
      rerender(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      expect(screen.queryByTestId('session-chat-dossier-rail')).toBeNull();

      fireEvent.click(screen.getByTestId('session-chat-dossier-toggle'));
      rerender(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      expect(screen.getByTestId('session-chat-dossier-rail')).toBeTruthy();
    });

    it.each([
      ['orders', 'session-chat-orders-toggle', 'session-chat-orders-rail', 'chatOrders'],
      ['activity', 'session-chat-dossier-toggle', 'session-chat-dossier-rail', 'chatDossier'],
      ['fleet', 'session-chat-fleet-toggle', 'session-chat-peers-rail', 'chatFleet'],
    ])('keeps %s reachable at its edge and preserves keyboard focus when closing and reopening', async (panel, toggleId, railId, queryKey) => {
      seedRoster([
        { ownerId: 'su-live-1', fleetSlug: 'popup-fleet', fleetRole: 'leader', claims: [], modes: [], currentFiles: [] },
        { ownerId: 'su-peer-1', fleetSlug: 'popup-fleet', fleetRole: 'member', claims: [], modes: [], currentFiles: [] },
      ]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      const { rerender } = render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      const toggle = await screen.findByTestId(toggleId);
      expect(screen.getByTestId(railId).contains(toggle)).toBe(true);
      toggle.focus();
      fireEvent.click(toggle);
      rerender(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      expect(nuqs[queryKey]).toBe(false);
      expect(screen.queryByTestId(railId)).toBeNull();
      const edge = within(screen.getByTestId('session-chat-' + panel + '-dock')).getByTestId(toggleId);
      expect(edge.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(edge);
      expect(screen.getAllByTestId(toggleId)).toHaveLength(1);
      expect(screen.getByTestId('session-chat-conversation').contains(edge)).toBe(false);

      fireEvent.click(edge);
      rerender(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      const reopened = within(screen.getByTestId(railId)).getByTestId(toggleId);
      expect(reopened.getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(reopened);
      expect(screen.getAllByTestId(toggleId)).toHaveLength(1);
    });

    /* ── WI-7110: the owner's own words about these two controls ─────────────
       Every assertion below was un-covered when the owner filed it, which is
       why each was silently wrong in shipped UI. They are asserted on the
       VISIBLE text and the CONTAINER, not on a testid, because a testid is
       exactly what a well-meaning rewrite keeps while changing the thing the
       owner actually looks at. Same reason FleetLaunchRow.test.tsx's
       "renders unconditionally" test exists: it already caught one revert of a
       verbatim owner ask on this very surface (P-007). ── */
    it('WI-7110: the Activity toggle is labelled "Activity" in BOTH states, and never says "Hide"', async () => {
      seedRoster([{ ownerId: 'su-live-1' }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      const { rerender } = render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(screen.getByTestId('session-chat-dossier-rail')).toBeTruthy());

      // Open: the label is the panel's NAME only — [owner 2026-08-02] "dont add
      // the hide when its expanded".
      const openLabel = screen.getByTestId('session-chat-dossier-toggle').textContent ?? '';
      expect(openLabel.trim()).toBe('Activity');
      expect(openLabel.toLowerCase()).not.toContain('hide');
      expect(openLabel.toLowerCase()).not.toContain('detail');

      // Collapsed: same word, so the hit target never changes width as it is
      // pressed. Only the chevron's direction differs.
      fireEvent.click(screen.getByTestId('session-chat-dossier-toggle'));
      rerender(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      const closedLabel = screen.getByTestId('session-chat-dossier-toggle').textContent ?? '';
      expect(closedLabel.trim()).toBe('Activity');
      expect(closedLabel.toLowerCase()).not.toContain('hide');
    });

    it('WI-7110: each toggle carries a rendered chevron ICON, not a typographic ‹ ›', async () => {
      seedRoster([{ ownerId: 'su-live-1' }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(screen.getByTestId('session-chat-dossier-rail')).toBeTruthy());

      // [owner 2026-08-02] "just make the open/close arror more visible". The
      // old control drew "‹"/"›" as TEXT at the button's 11px font size; an
      // <svg> is the thing that is actually visible, so assert the element
      // rather than a size that a stylesheet could quietly drop.
      for (const testid of ['session-chat-dossier-toggle', 'session-chat-orders-toggle']) {
        const btn = screen.getByTestId(testid);
        expect(btn.querySelector('svg')).toBeTruthy();
        expect(btn.textContent ?? '').not.toMatch(/[‹›]/);
      }
    });

    it('keeps Orders and Activity controls on their own surfaces, outside the conversation', async () => {
      seedRoster([{ ownerId: 'su-live-1' }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(screen.getByTestId('session-chat-dossier-rail')).toBeTruthy());

      const conversation = screen.getByTestId('session-chat-conversation');
      expect(within(conversation).queryByTestId('session-chat-orders-toggle')).toBeNull();
      expect(within(conversation).queryByTestId('session-chat-dossier-toggle')).toBeNull();
      expect(within(screen.getByTestId('session-chat-orders-rail')).getByTestId('session-chat-orders-toggle')).toBeTruthy();
      expect(within(screen.getByTestId('session-chat-dossier-rail')).getByTestId('session-chat-dossier-toggle')).toBeTruthy();
    });

    /* ── The Framed look: six NAMED zones (owner-approved 2026-08-02, artifact
       6379bb65) ──────────────────────────────────────────────────────────────
       The design's whole claim is that every region is named and ruled, and its
       one non-obvious constraint is that naming the three HORIZONTAL zones costs
       ZERO added height — the cap shares the band's existing row instead of
       taking a header row of its own. That is exactly the kind of promise a
       later "tidy-up" breaks silently (someone lifts the cap into its own div
       "for alignment"), and no behavioural test would notice, so it is asserted
       structurally: the cap must be a DIRECT CHILD of the band. */
    it('names the Status zone with an inline cap INSIDE the band — zero added rows', async () => {
      seedRoster([{ ownerId: 'su-live-1', liveness: 'live' }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

      const band = await waitFor(() => screen.getByTestId('session-chat-state-header'));
      const cap = band.querySelector(':scope > .pc-zone-cap');
      expect(cap).toBeTruthy();
      expect(cap!.textContent).toBe('Status');
      // A child of the BAND, not a wrapper around it: a cap in its own row would
      // add a row to a popup the owner had just asked to compact.
      expect(cap!.parentElement).toBe(band);
    });

    it('gives the Activity rail its zone title — but only in the popup, never in the /adv two-pane', async () => {
      seedRoster([{ ownerId: 'su-live-1' }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(screen.getByTestId('session-chat-dossier-rail')).toBeTruthy());

      // A PROP rather than always-on: the same component is the detail pane of a
      // board that already says what it is, where a second title bar is noise.
      // Asserting the prop (not the stub's markup) is what keeps this a claim
      // about the popup's decision rather than about AgentDossier's rendering.
      expect(lastAgentDossierProps?.zoneTitle).toBe(true);
      // …and the rail carries the class the zone treatment is scoped to, which
      // is what keeps the two-pane's own look untouched.
      expect(screen.getByTestId('session-chat-dossier-rail').className).toContain('pc-zone--activity');
    });

    it('honors an explicit chatDossier=false (deep link) by hiding the rail even though the default is open', async () => {
      nuqs.chatDossier = false;
      seedRoster([{ ownerId: 'su-live-1' }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      expect(screen.queryByTestId('session-chat-dossier-rail')).toBeNull();
      // The toggle itself stays available so the viewer can still reopen it.
      expect(screen.getByTestId('session-chat-dossier-toggle')).toBeTruthy();
    });

    it('closing the dossier from its own onClose collapses the rail (chatDossier flips false)', async () => {
      seedRoster([{ ownerId: 'su-live-1' }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      const { rerender } = render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(screen.getByTestId('session-chat-dossier-rail')).toBeTruthy());

      fireEvent.click(screen.getByTestId('dossier-stub-close'));
      rerender(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      expect(screen.queryByTestId('session-chat-dossier-rail')).toBeNull();
    });
  });

  /* ── P-015: the Orders panel, the LEFT column of the three-column shell ─────
     The rail itself (`session-chat-orders-rail`) had NO coverage at all until
     this suite — only its toolbar BUTTON did, via the WI-7110 cases above. That
     is the dangerous half to leave untested, because P-015's load-bearing
     promise is not "a panel appears": it is that the panel is a SIBLING of the
     conversation region rather than a child of it.

     That sibling relationship is still the contract under D-007, which reversed
     what it BUYS: `requestFullscreen()` now targets the popup container that
     holds all three columns, so a sibling is INCLUDED in maximize rather than
     excluded from it. Nesting Orders inside the conversation would still be a
     silent break — it would change the column layout while every presence test
     stayed green — so the containment assertion below is kept, now guarding the
     three-column shell rather than a hide boundary. ── */
  describe('P-015 Orders panel (three-column shell)', () => {
    function seedRoster(entries: Array<Record<string, unknown>>) {
      H.results['advRoster.list'] = {
        data: [{ active: entries, pending: [] }],
        loading: false,
        fetching: false,
        error: null,
        invalidate: vi.fn(),
      };
    }

    async function renderResolved() {
      seedRoster([{ ownerId: 'su-live-1' }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      const r = render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
      await waitFor(() => expect(captured).not.toBeNull());
      return r;
    }

    const rerenderOpen = (rerender: (ui: React.ReactElement) => void) =>
      rerender(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);

    /* [owner 2026-08-03, verbatim]: "In the HUD tab when opening a conversation
       the 'ORDERS — what they were told' should be expanded by default." This
       case is the direct inversion of the one that used to assert the opposite
       default to the dossier; the cost reasoning that justified opt-in (the
       agentOrders.byOwner carry-brief gather) survives only as the CLOSED half
       below. */
    it('is OPEN by default — the panel and its gather mount with the conversation', async () => {
      await renderResolved();
      // Asserting the stub and its `enabled` prop (not just the wrapper) is what
      // makes this a claim about the FETCH and not merely about layout: `enabled`
      // is what gates the agentOrders.byOwner gather.
      const rail = screen.getByTestId('session-chat-orders-rail');
      expect(within(rail).getByTestId('agent-orders-stub')).toBeTruthy();
      expect(lastAgentOrdersProps?.enabled).toBe(true);
      expect(lastAgentOrdersProps?.ownerId).toBe('su-live-1');
      expect(screen.getByTestId('session-chat-orders-toggle')).toBeTruthy();
    });

    /* ── the room-aware half of that default (WI-35470 / D-009) ───────────────
       Below ORDERS_NARROW_MEDIA_QUERY the rail has no column to take and renders
       as an OVERLAY, so a blanket default-open covers the transcript the reader
       just opened (measured live at 1100px: rail x=28→328 over a conversation
       x=28→772). Only the NO-CHOICE case is room-sensitive; an explicit param
       still wins at every width, which is what keeps P-015's overlay rationale
       intact rather than making the toggle a no-op on a narrow window.

       jsdom's own matchMedia answers `matches:false` to everything, which is why
       the wide cases above need no stub — and why the narrow ones need this one.
       It must be installed BEFORE render(): the hook seeds its state from
       matchMedia synchronously on first render precisely so a narrow window
       never mounts the panel (and fires the gather) for one frame. */
    const NARROW_ORDERS_MQ = '(max-width: 1760px)';
    function stubViewportMatching(query: string) {
      vi.stubGlobal('matchMedia', (q: string) => ({
        matches: q === query,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
    }

    it('narrow viewport: CLOSED by default — there, "expanded" would mean covering the transcript', async () => {
      stubViewportMatching(NARROW_ORDERS_MQ);
      await renderResolved();
      expect(screen.queryByTestId('session-chat-orders-rail')).toBeNull();
      // The live rail stays unsubscribed while its exact owner query is warmed.
      expect(screen.queryByTestId('agent-orders-stub')).toBeNull();
      expect(lastAgentOrdersProps).toBeNull();
      expect(H.prefetch).toHaveBeenCalledExactlyOnceWith({
        queryName: 'agentOrders.byOwner',
        args: { ownerId: 'su-live-1' },
      });
      // The way back is still offered; this is a default, not a removal.
      expect(screen.getByTestId('session-chat-orders-toggle')).toBeTruthy();
    });

    it('narrow viewport: an EXPLICIT chatOrders wins anyway — the toggle is never a no-op', async () => {
      stubViewportMatching(NARROW_ORDERS_MQ);
      nuqs.chatOrders = true;
      await renderResolved();
      const rail = screen.getByTestId('session-chat-orders-rail');
      expect(within(rail).getByTestId('agent-orders-stub')).toBeTruthy();
      expect(lastAgentOrdersProps?.enabled).toBe(true);
    });

    it('an explicit chatOrders=false is honored, not overwritten by the derived default', async () => {
      // `??` not `||`: false is a real choice a reader made. Guarding this
      // because the bug it prevents is invisible — the panel would simply
      // reappear on every open for a reader who keeps closing it.
      nuqs.chatOrders = false;
      await renderResolved();
      expect(screen.queryByTestId('session-chat-orders-rail')).toBeNull();
      expect(screen.queryByTestId('agent-orders-stub')).toBeNull();
      expect(H.prefetch).toHaveBeenCalledExactlyOnceWith({
        queryName: 'agentOrders.byOwner',
        args: { ownerId: 'su-live-1' },
      });
    });

    it('closing it stops the live subscription after the one-time prefetch', async () => {
      // The half of the pre-2026-08-03 opt-in rationale that outlived the
      // default flip, and the reason agentOrders.byOwner stays a SEPARATE named
      // query rather than another leg on agentDetail.byOwner: a reader who
      // closes the panel must stop paying for the carry-brief gather. Folding it
      // in would make that cost unconditional and nothing here would notice.
      const { rerender } = await renderResolved();
      expect(screen.getByTestId('agent-orders-stub')).toBeTruthy();

      nuqs.chatOrders = false;
      rerenderOpen(rerender);
      expect(screen.queryByTestId('session-chat-orders-rail')).toBeNull();
      expect(screen.queryByTestId('agent-orders-stub')).toBeNull();
      expect(H.prefetch).toHaveBeenCalledTimes(1);
      // The toggle survives the panel — a reader who closed it must be able to
      // get it back.
      expect(screen.getByTestId('session-chat-orders-toggle')).toBeTruthy();
    });

    it('the toggle mounts the panel via the chatOrders nuqs key, scoped to the session owner', async () => {
      // Starts from CLOSED so the click under test is the one that OPENS —
      // since the default flip, a click from the default state would close it.
      nuqs.chatOrders = false;
      const { rerender } = await renderResolved();
      expect(screen.queryByTestId('session-chat-orders-rail')).toBeNull();

      fireEvent.click(screen.getByTestId('session-chat-orders-toggle'));
      expect(nuqsSetters.chatOrders).toHaveBeenCalledWith(true);
      // The mocked setter mutates the shared store synchronously but does not
      // itself re-render — force one, same as the dossier suite above.
      rerenderOpen(rerender);

      const rail = screen.getByTestId('session-chat-orders-rail');
      expect(within(rail).getByTestId('agent-orders-stub')).toBeTruthy();
      expect(lastAgentOrdersProps?.ownerId).toBe('su-live-1');
      expect(lastAgentOrdersProps?.enabled).toBe(true);
    });

    it('D-007: the panel is a SIBLING of the conversation region, never inside it', async () => {
      nuqs.chatOrders = true;
      await renderResolved();

      const conversation = screen.getByTestId('session-chat-conversation');
      // Present in the document…
      expect(screen.getByTestId('session-chat-orders-rail')).toBeTruthy();
      // …and OUTSIDE the conversation, which is what makes this a column beside
      // the transcript rather than something scrolling within it. Nesting it
      // would keep every presence test in this file green while collapsing the
      // three-column shell.
      expect(within(conversation).queryByTestId('session-chat-orders-rail')).toBeNull();
      expect(within(conversation).queryByTestId('agent-orders-stub')).toBeNull();
      // Positive control for the two nulls above — a scoped query that can only
      // ever return null is not evidence of anything. The composer IS inside the
      // conversation, so the same `within` finds it, which is what makes the
      // nulls a statement about the DOM shape rather than about a typo'd testid.
      expect(within(conversation).getByPlaceholderText(/Type to wake/)).toBeTruthy();
      // Same control from the other side: the dossier is the OTHER sibling, so
      // it is outside too — if this ever passed while the rail assertion failed,
      // the two panels would have diverged on the one rule that governs both.
      expect(within(conversation).queryByTestId('session-chat-dossier-rail')).toBeNull();
    });

    /* D-007 [owner 2026-08-02, verbatim]: "lets actually make the left panel and
       right panel and bottom and top panel all show in both full screen views."
       These two cases are the direct inversion of the pair that used to assert
       the panel and its toggle were DROPPED by maximize. */
    it('full window KEEPS the panel and its toggle', async () => {
      nuqs.chatOrders = true;
      const { rerender } = await renderResolved();
      expect(screen.getByTestId('session-chat-orders-rail')).toBeTruthy();

      nuqs.chatMax = 'window';
      rerenderOpen(rerender);
      expect(screen.getByTestId('session-chat-orders-rail')).toBeTruthy();
      expect(screen.getByTestId('agent-orders-stub')).toBeTruthy();
      // The toggle stays with it — a panel you can see but cannot close is worse
      // than one that was never there.
      expect(screen.getByTestId('session-chat-orders-toggle')).toBeTruthy();
      expect(within(screen.getByTestId('session-chat-orders-rail')).getByTestId('session-chat-orders-toggle')).toBeTruthy();
      expect(screen.getByPlaceholderText(/Type to wake/)).toBeTruthy();
    });

    it('full SCREEN keeps it too — both modes carry the same set', async () => {
      nuqs.chatOrders = true;
      nuqs.chatMax = 'screen';
      await renderResolved();
      expect(screen.getByTestId('session-chat-orders-rail')).toBeTruthy();
      expect(screen.getByTestId('session-chat-orders-toggle')).toBeTruthy();
      expect(screen.getByTestId('session-chat-conversation')).toBeTruthy();
      expect(screen.getByPlaceholderText(/Type to wake/)).toBeTruthy();
    });

    it('a panel the user closed stays closed in maximize — the mode never re-opens it', async () => {
      // The other half of D-007: "always shown" means maximize stops HIDING it,
      // not that maximize starts SHOWING it. `chatOrders` remains the only
      // authority on whether this panel is up.
      nuqs.chatOrders = false;
      nuqs.chatMax = 'screen';
      await renderResolved();
      expect(screen.queryByTestId('session-chat-orders-rail')).toBeNull();
      expect(screen.getByTestId('session-chat-orders-toggle')).toBeTruthy();
    });

    it('closing the panel from its own onClose collapses it (chatOrders flips false)', async () => {
      nuqs.chatOrders = true;
      const { rerender } = await renderResolved();

      fireEvent.click(screen.getByTestId('orders-stub-close'));
      expect(nuqsSetters.chatOrders).toHaveBeenCalledWith(false);
      rerenderOpen(rerender);
      expect(screen.queryByTestId('session-chat-orders-rail')).toBeNull();
    });

    it('renders neither the panel nor its toggle while the modal is closed', () => {
      nuqs.chatOrders = true;
      render(<SessionChatModal sessionOwnerId={null} onClose={vi.fn()} />);
      expect(screen.queryByTestId('session-chat-orders-rail')).toBeNull();
      expect(screen.queryByTestId('session-chat-orders-toggle')).toBeNull();
    });

    it('both panels can be open at once — Orders left, Activity right, conversation between', async () => {
      nuqs.chatOrders = true;
      await renderResolved();
      // The DOM order IS the reading order the layout promises (told →
      // conversation → did), so assert the sequence rather than mere presence.
      const modal = screen.getByTestId('session-chat-modal');
      const order = Array.from(
        modal.querySelectorAll<HTMLElement>(
          '[data-testid="session-chat-orders-rail"],[data-testid="session-chat-conversation"],[data-testid="session-chat-dossier-rail"]',
        ),
      ).map((el) => el.dataset.testid);
      expect(order).toEqual([
        'session-chat-orders-rail',
        'session-chat-conversation',
        'session-chat-dossier-rail',
      ]);
    });
  });

  // WI-6367 — a session launched seconds ago and a session that ended long ago
  // are the SAME shape here (no roster row, no resolvable transcript), so the
  // modal used to greet a brand-new session with past-tense "gone away" copy.
  // These assert the rendered TEXT, not merely that a branch was taken: the
  // WI-6363 postmortem was exactly a test that checked a callback had fired
  // without ever checking what it fired with.
  describe('WI-6367 starting-up state for a just-launched session', () => {
    const GONE = 'No recent session found for this agent.';
    const STARTING = /Starting up — waiting for this session to come online/;
    const FAILED = /This session hasn't come online/;

    function seedRoster(entries: Array<Record<string, unknown>>) {
      H.results['advRoster.list'] = {
        data: [{ active: entries, pending: [] }],
        loading: false,
        fetching: false,
        error: null,
        invalidate: vi.fn(),
      };
    }

    it('says "starting up" (not the gone-away copy) for the session that was just launched', async () => {
      mockFetchOnce(200, { sessions: [] });
      render(
        <SessionChatModal
          sessionOwnerId="su-new-1"
          onClose={vi.fn()}
          pendingLaunch={{ ownerId: 'su-new-1', startedAtMs: Date.now() }}
        />,
      );

      await waitFor(() => expect(screen.getByTestId('session-chat-starting-up')).toBeTruthy());
      expect(screen.getByText(STARTING)).toBeTruthy();
      // The specific regression: the past-tense copy must be GONE, not merely
      // accompanied by the new line.
      expect(screen.queryByText(GONE)).toBeNull();
    });

    it('keeps the boot copy while sessions:list resolves before the live roster', async () => {
      // The launch row can produce a native session result before the owner has
      // self-registered in coord_presence. `resolved` is therefore not proof
      // that the roster's active leg has caught up; the dossier must remain in
      // the starting state until that authoritative live row arrives.
      seedRoster([]);
      let responseRead = false;
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => {
          responseRead = true;
          return JSON.stringify({
            sessions: [
              { source_kind: 'claude', session_id: 'claude-live', active: true, last_ts: null },
            ],
          });
        },
      });
      render(
        <SessionChatModal
          sessionOwnerId="su-new-1"
          onClose={vi.fn()}
          pendingLaunch={{ ownerId: 'su-new-1', startedAtMs: Date.now() }}
        />,
      );

      await waitFor(() => expect(screen.getByTestId('session-chat-starting-up')).toBeTruthy());
      // Flush past the resolver response. Before this point the old `!resolved`
      // formula also passes, so asserting only the initial banner would be
      // vacuous; once the live native row resolves, that formula drops the
      // banner and exposes the gone-away dossier copy.
      await waitFor(() => expect(responseRead).toBe(true));
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText(STARTING)).toBeTruthy();
      expect(lastAgentDossierProps?.startingUp).toBe(true);
      expect(screen.queryByText(GONE)).toBeNull();
    });

    // Non-vacuity guard: identical inputs minus `pendingLaunch` must still take
    // the old branch. Without this, a bug making `startingUp` always-true would
    // pass the test above.
    it('still shows the gone-away copy for the SAME inputs when there was no launch', async () => {
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-new-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByText(GONE)).toBeTruthy());
      expect(screen.queryByTestId('session-chat-starting-up')).toBeNull();
    });

    it('does not hijack the empty state of a DIFFERENT session than the one launched', async () => {
      mockFetchOnce(200, { sessions: [] });
      render(
        <SessionChatModal
          sessionOwnerId="su-someone-else"
          onClose={vi.fn()}
          pendingLaunch={{ ownerId: 'su-new-1', startedAtMs: Date.now() }}
        />,
      );

      await waitFor(() => expect(screen.getByText(GONE)).toBeTruthy());
      expect(screen.queryByTestId('session-chat-starting-up')).toBeNull();
    });

    it('stops saying "starting up" once the session registers in the roster', async () => {
      seedRoster([{ ownerId: 'su-new-1' }]);
      mockFetchOnce(200, { sessions: [] });
      render(
        <SessionChatModal
          sessionOwnerId="su-new-1"
          onClose={vi.fn()}
          pendingLaunch={{ ownerId: 'su-new-1', startedAtMs: Date.now() }}
        />,
      );

      await waitFor(() => expect(screen.getByText(GONE)).toBeTruthy());
      expect(screen.queryByTestId('session-chat-starting-up')).toBeNull();
    });

    it('admits the launch failed once the grace window elapses without the session coming online', async () => {
      // Seeding a HEALTHY (but empty) roster is load-bearing, not decoration:
      // "the launch failed" is only a supportable verdict when the roster was
      // actually readable and the session simply was not in it. With no roster
      // at all the modal now correctly reports an unreachable operator instead
      // — see the "unreachable backend vs failed launch" block below.
      seedRoster([]);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        mockFetchOnce(200, { sessions: [] });
        render(
          <SessionChatModal
            sessionOwnerId="su-new-1"
            onClose={vi.fn()}
            pendingLaunch={{ ownerId: 'su-new-1', startedAtMs: Date.now() }}
          />,
        );
        await waitFor(() => expect(screen.getByText(STARTING)).toBeTruthy());

        await act(async () => {
          await vi.advanceTimersByTimeAsync(61_000);
        });

        expect(screen.getByText(FAILED)).toBeTruthy();
        expect(screen.queryByText(STARTING)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('passes startingUp through to the dossier rail, so it does not say "no longer in the live roster" either', async () => {
      mockFetchOnce(200, { sessions: [] });
      render(
        <SessionChatModal
          sessionOwnerId="su-new-1"
          onClose={vi.fn()}
          pendingLaunch={{ ownerId: 'su-new-1', startedAtMs: Date.now() }}
        />,
      );

      await waitFor(() => expect(screen.getByTestId('session-chat-dossier-rail')).toBeTruthy());
      expect(lastAgentDossierProps?.startingUp).toBe(true);
    });

    it('passes startingUp:false to the dossier for an ordinary (not just-launched) session', async () => {
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-new-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-dossier-rail')).toBeTruthy());
      expect(lastAgentDossierProps?.startingUp).toBe(false);
    });
  });

  // WI-6440: the reload half of the same window. `pendingLaunch` is client-local
  // and dies with the page, so a reload during boot dropped the modal back onto
  // the gone-away copy while the BOARD, reading the durable `starting` tier, was
  // concurrently calling the same session "Fresh session — launched, not started
  // yet". Every case below passes NO pendingLaunch — that is the point.
  describe('WI-6440 starting-up survives a reload (durable `starting` tier)', () => {
    const GONE = 'No recent session found for this agent.';
    const UNKNOWN = /No agent with this id was found in the current roster or session history/;
    const STARTING = /Starting up — waiting for this session to come online/;
    const FAILED = /This session hasn't come online/;

    function seedTiers(tiers: {
      active?: Array<Record<string, unknown>>;
      starting?: Array<Record<string, unknown>>;
    }) {
      H.results['advRoster.list'] = {
        data: [{ active: tiers.active ?? [], pending: [], starting: tiers.starting ?? [] }],
        loading: false,
        fetching: false,
        error: null,
        invalidate: vi.fn(),
      };
    }

    it('says "starting up" for a session the server still lists as starting, with no pendingLaunch', async () => {
      seedTiers({ starting: [{ ownerId: 'su-new-1', startedAt: new Date().toISOString() }] });
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-new-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-starting-up')).toBeTruthy());
      expect(screen.getByText(STARTING)).toBeTruthy();
      expect(screen.queryByText(GONE)).toBeNull();
    });

    // The literal reported symptom: the rail said "This agent is no longer in
    // the live roster" about a session launched ~10s earlier.
    it('passes startingUp:true to the dossier rail, so the rail does not call it gone', async () => {
      seedTiers({ starting: [{ ownerId: 'su-new-1', startedAt: new Date().toISOString() }] });
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-new-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-dossier-rail')).toBeTruthy());
      expect(lastAgentDossierProps?.startingUp).toBe(true);
    });

    // Non-vacuity: the tier is matched by ownerId, not merely "is the tier
    // non-empty". Without this a bug reading `starting.length > 0` would pass.
    it('does not claim a DIFFERENT session is starting just because the tier is non-empty', async () => {
      seedTiers({ starting: [{ ownerId: 'su-someone-else', startedAt: new Date().toISOString() }] });
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-new-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-unknown-session')).toBeTruthy());
      expect(screen.getByTestId('session-chat-unknown-session').textContent).toMatch(UNKNOWN);
      expect(screen.queryByTestId('session-chat-starting-up')).toBeNull();
    });

    // A registered session outranks a stale `starting` row (the tiers are
    // deduped server-side; this pins the client's behaviour if that ever slips).
    it('treats a session present in `active` as registered even if it also appears in `starting`', async () => {
      seedTiers({
        active: [{ ownerId: 'su-new-1' }],
        starting: [{ ownerId: 'su-new-1', startedAt: new Date().toISOString() }],
      });
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-new-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByText(GONE)).toBeTruthy());
      expect(screen.queryByTestId('session-chat-starting-up')).toBeNull();
    });

    // The did-not-come-online fallback has to work off the DURABLE timestamp
    // too — otherwise a reload resets the 60s window and the modal promises
    // forever that a dead launch is on its way.
    it('admits the launch failed when the record\'s own startedAt is already past the grace window', async () => {
      seedTiers({
        starting: [
          { ownerId: 'su-new-1', startedAt: new Date(Date.now() - 61_000).toISOString() },
        ],
      });
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-new-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByText(FAILED)).toBeTruthy());
      expect(screen.queryByText(STARTING)).toBeNull();
    });

    // ── WI-6821: an OBSERVED death, not a timeout ────────────────────────────
    // The owner's report: "clicking new session is still showing 'Starting up —
    // waiting for this session to come online…'". Nothing ever stamped the dead
    // launch's row, so the roster advertised it as starting for the whole 15min
    // window and only a 60s client timer ever softened the copy — to a HEDGE
    // ("may have failed"), because the client genuinely did not know. Now the
    // server observes the terminal process is gone and says so at once.
    const OBSERVED_FAILED = /This session’s launch failed — its terminal closed/;

    it('reports an observed launch failure IMMEDIATELY, without waiting out the grace window', async () => {
      seedTiers({
        // startedAt is seconds ago: the 60s timer has NOT fired. Only the
        // server's observation can produce the failure copy here.
        starting: [
          { ownerId: 'su-new-1', startedAt: new Date().toISOString(), launchFailed: true },
        ],
      });
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-new-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByText(OBSERVED_FAILED)).toBeTruthy());
      expect(screen.queryByText(STARTING)).toBeNull();
      // Not the timer's hedge — we OBSERVED this one, so it is stated flatly.
      expect(screen.queryByText(FAILED)).toBeNull();
    });

    // ── WI-37841: say WHY it failed ──────────────────────────────────────────
    // `launchFailed` is derived (ended, never registered), so it can only ever
    // produce a fixed string. That string has cost two full forensic sessions
    // for two DIFFERENT root causes — psu printed the reason both times, into a
    // window nobody could read afterwards. The reason now rides the roster.
    it('shows psu\'s own words when the server captured them', async () => {
      seedTiers({
        starting: [
          {
            ownerId: 'su-new-1',
            startedAt: new Date().toISOString(),
            launchFailed: true,
            launchFailureHint: 'psu: operator at http://127.0.0.1:9 unreachable — exiting',
          },
        ],
      });
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-new-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-launch-failure-hint')).toBeTruthy());
      expect(screen.getByTestId('session-chat-launch-failure-hint').textContent).toContain(
        'operator at http://127.0.0.1:9 unreachable',
      );
      // The headline still leads — the cause is detail BELOW it, not a replacement.
      expect(screen.getByText(OBSERVED_FAILED)).toBeTruthy();
    });

    it('drops "Try launching it again" once a cause is on screen', async () => {
      // The retry advice is actively harmful when the failure is deterministic:
      // it sends the owner to re-run a launch that will fail identically every
      // time, which is exactly what happened on both prior investigations.
      seedTiers({
        starting: [
          {
            ownerId: 'su-new-1',
            startedAt: new Date().toISOString(),
            launchFailed: true,
            launchFailureHint: 'psu: refusing to boot',
          },
        ],
      });
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-new-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-launch-failure-hint')).toBeTruthy());
      expect(screen.queryByText(/Try launching it again/)).toBeNull();
    });

    it('KEEPS the retry advice when no cause was captured (non-vacuity)', async () => {
      // Without this, the test above would pass against a build that had simply
      // deleted the retry sentence outright.
      seedTiers({
        starting: [
          { ownerId: 'su-new-1', startedAt: new Date().toISOString(), launchFailed: true },
        ],
      });
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-new-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByText(OBSERVED_FAILED)).toBeTruthy());
      expect(screen.getByText(/Try launching it again/)).toBeTruthy();
      expect(screen.queryByTestId('session-chat-launch-failure-hint')).toBeNull();
    });

    it('never shows a cause for a launch that has NOT failed', async () => {
      // A hint on a still-booting session would turn ordinary boot chatter into
      // a failure report — the fabricated-diagnosis failure mode this whole
      // area exists to avoid.
      seedTiers({
        starting: [
          {
            ownerId: 'su-new-1',
            startedAt: new Date().toISOString(),
            launchFailed: false,
            launchFailureHint: 'psu: some routine boot chatter',
          },
        ],
      });
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-new-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-starting-up')).toBeTruthy());
      expect(screen.queryByTestId('session-chat-launch-failure-hint')).toBeNull();
    });

    it('tells the dossier rail too, so the rail beside the banner cannot contradict it', async () => {
      seedTiers({
        starting: [
          { ownerId: 'su-new-1', startedAt: new Date().toISOString(), launchFailed: true },
        ],
      });
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-new-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-dossier-rail')).toBeTruthy());
      expect(lastAgentDossierProps?.launchFailed).toBe(true);
    });

    // Non-vacuity, and the property that keeps the honest copy leading: a
    // still-booting launch must NOT pick up the failure copy just because the
    // field exists on the payload.
    it('does not report failure for a launch the server has not called failed', async () => {
      seedTiers({
        starting: [
          { ownerId: 'su-new-1', startedAt: new Date().toISOString(), launchFailed: false },
        ],
      });
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-new-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByText(STARTING)).toBeTruthy());
      expect(screen.queryByText(OBSERVED_FAILED)).toBeNull();
    });

    // A headless native client can stay alive forever at a provider dialog. It
    // is not a dead launch, and the 60s timeout is not the source of truth.
    it('reports a recognized live usage-limit block immediately and actionably', async () => {
      seedTiers({
        starting: [
          {
            ownerId: 'su-new-1',
            startedAt: new Date().toISOString(),
            launchFailed: false,
            launchBlocked: true,
            launchBlockedHint:
              "Claude's weekly usage limit was reached; it resets 7am. Launch with Codex or an available account, or retry after the reset.",
          },
        ],
      });
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-new-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-launch-blocked')).toBeTruthy());
      expect(screen.getByTestId('session-chat-launch-blocked-hint').textContent).toContain(
        'Launch with Codex or an available account',
      );
      expect(screen.queryByText(STARTING)).toBeNull();
      expect(screen.queryByText(OBSERVED_FAILED)).toBeNull();
    });

    it('tells the dossier rail the launch is blocked, not merely starting', async () => {
      seedTiers({
        starting: [
          {
            ownerId: 'su-new-1',
            startedAt: new Date().toISOString(),
            launchBlocked: true,
            launchBlockedHint: 'Choose another account.',
          },
        ],
      });
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-new-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByTestId('session-chat-dossier-rail')).toBeTruthy());
      expect(lastAgentDossierProps?.launchBlocked).toBe(true);
      expect(lastAgentDossierProps?.launchFailed).toBe(false);
    });

    // An older operator (or a mid-deploy SSE push) sends no such field. That must
    // degrade to today's behaviour, never to a fabricated failure.
    it('degrades to the timer path when the payload omits launchFailed entirely', async () => {
      seedTiers({ starting: [{ ownerId: 'su-new-1', startedAt: new Date().toISOString() }] });
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-new-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByText(STARTING)).toBeTruthy());
      expect(screen.queryByText(OBSERVED_FAILED)).toBeNull();
    });

    // An undateable launch must not be reported as a FAILED one — the board
    // makes the same call (ageSec(null) falls through rather than accusing).
    it('stays on "starting up" when the record carries no usable startedAt', async () => {
      seedTiers({ starting: [{ ownerId: 'su-new-1', startedAt: null }] });
      mockFetchOnce(200, { sessions: [] });
      render(<SessionChatModal sessionOwnerId="su-new-1" onClose={vi.fn()} />);

      await waitFor(() => expect(screen.getByText(STARTING)).toBeTruthy());
      expect(screen.queryByText(FAILED)).toBeNull();
    });
  });

  // The startup-timeout banner must not invent a diagnosis it cannot support.
  //
  // [owner 2026-08-01, verbatim] "in the hud tab I tried launching a new session
  // and the conversation window came up but I got that error." The launch was
  // fine — the operator's Postgres discovery file pointed at a dead port, so the
  // roster could never be read and the session could never register. The banner
  // nonetheless told the owner "the launch may have failed — try launching it
  // again", advice that could not work and that blamed their action rather than
  // the backend. The roster is the ONLY evidence the modal has about coming
  // online, so when it is unreadable the honest report is "cannot reach the
  // operator", not a verdict on the launch.
  describe('startup timeout distinguishes an unreachable backend from a failed launch', () => {
    const STARTING = /Starting up — waiting for this session to come online/;
    const FAILED = /This session hasn't come online/;
    const UNREACHABLE = /Can't reach the operator to check on this session/;

    /** A roster read that came back healthy — the session simply is not in it. */
    function seedReadableRoster() {
      H.results['advRoster.list'] = {
        data: [{ active: [], pending: [], starting: [] }],
        loading: false,
        fetching: false,
        error: null,
        invalidate: vi.fn(),
      };
    }

    async function renderTimedOutLaunch() {
      mockFetchOnce(200, { sessions: [] });
      render(
        <SessionChatModal
          sessionOwnerId="su-new-1"
          onClose={vi.fn()}
          // Already past the 60s grace window, so the banner is in its
          // timed-out state without needing fake timers.
          pendingLaunch={{ ownerId: 'su-new-1', startedAtMs: Date.now() - 61_000 }}
        />,
      );
      await waitFor(() => expect(screen.getByTestId('session-chat-starting-up')).toBeTruthy());
    }

    it('says the operator is unreachable — not that the launch failed — when the roster query ERRORED', async () => {
      // Payload present AND an error set, so ONLY the error term of
      // `rosterUnreadable` can be doing the work here — this isolates that
      // disjunct from the missing-payload one exercised by the next test.
      H.results['advRoster.list'] = {
        data: [{ active: [], pending: [], starting: [] }],
        loading: false,
        fetching: false,
        error: new Error('connect ECONNREFUSED 127.0.0.1:20216'),
        invalidate: vi.fn(),
      };
      await renderTimedOutLaunch();

      expect(screen.getByText(UNREACHABLE)).toBeTruthy();
      // The specific regression: the retry advice must be GONE, not merely
      // accompanied by the new line. Retrying cannot help here.
      expect(screen.queryByText(FAILED)).toBeNull();
    });

    it('also says unreachable when the roster returned NO payload at all', async () => {
      // The outage shape that does not surface as an Error: the query resolves
      // but carries nothing, so there is still no evidence either way.
      H.results['advRoster.list'] = {
        data: [],
        loading: false,
        fetching: false,
        error: null,
        invalidate: vi.fn(),
      };
      await renderTimedOutLaunch();

      expect(screen.getByText(UNREACHABLE)).toBeTruthy();
      expect(screen.queryByText(FAILED)).toBeNull();
    });

    // NON-VACUITY CONTROL. Identical inputs except the roster READ FINE. A bug
    // that routed every timeout to the unreachable copy would pass both tests
    // above while destroying the real did-not-come-online signal WI-6367 added.
    it('STILL blames the launch when the roster read fine and the session is simply absent', async () => {
      seedReadableRoster();
      await renderTimedOutLaunch();

      expect(screen.getByText(FAILED)).toBeTruthy();
      expect(screen.queryByText(UNREACHABLE)).toBeNull();
    });

    // The unreachable branch must not leak into the pre-timeout window either:
    // a launch seconds old is still legitimately "starting up" even if the
    // roster is momentarily unreadable.
    it('stays on "starting up" before the grace window expires, even with an unreadable roster', async () => {
      H.results['advRoster.list'] = {
        data: [],
        loading: false,
        fetching: false,
        error: new Error('connect ECONNREFUSED 127.0.0.1:20216'),
        invalidate: vi.fn(),
      };
      mockFetchOnce(200, { sessions: [] });
      render(
        <SessionChatModal
          sessionOwnerId="su-new-1"
          onClose={vi.fn()}
          pendingLaunch={{ ownerId: 'su-new-1', startedAtMs: Date.now() }}
        />,
      );

      await waitFor(() => expect(screen.getByText(STARTING)).toBeTruthy());
      expect(screen.queryByText(UNREACHABLE)).toBeNull();
      expect(screen.queryByText(FAILED)).toBeNull();
    });
  });

  // WI-6513 / D-006: there is deliberately NO structural test here for the
  // Grade card's placement inside the popup, and that absence is a finding
  // rather than a gap.
  //
  // D-004 reported the card overflowing the popup's bottom edge by 80px and
  // this suite briefly guarded a wrapper meant to bound it. Both were wrong:
  // D-004 resolved `.pc-modal-content` and `.local-card-host-select` with two
  // INDEPENDENT unscoped querySelectors, and two card hosts render the same
  // global askUserLocal queue at once — one in this modal, one in the
  // `.op-chat-sidebar`. It measured the SIDEBAR's card (h=131 top=669 bot=800)
  // against THIS modal's box (bot=720) and read the difference as overflow.
  //
  // Scoped to the modal, measured live (app pid 1349850, viewport 1280x800):
  // card h=89 top=593 bot=682 vs modal bottom 720 — 38px of clearance, 13.9%
  // of the popup, listbox unclipped, 25 options. A live A/B that stripped the
  // wrapper's bound produced byte-identical geometry, proving the modal's
  // existing flex column already contains the card and the wrapper was inert.
  //
  // jsdom computes no layout, so no unit test here can measure any of that —
  // which is exactly why the false conclusion survived unit-green for a full
  // cycle. The guard for this invariant is the scoped live measurement recorded
  // on the plan, and the lesson is to scope a geometry selector to the surface
  // under test whenever more than one host can render the same component.

  /**
   * session-chat-popup-direction-d-2026-08-02 P-001 — full-window / full-screen.
   *
   * ⚠ THE ASK REVERSED ON 2026-08-02 — D-007 supersedes D-002.
   * Originally [owner 2026-08-01 22:29] maximize was to show "the actual
   * conversation not the panes to the left and belo, but it should also include
   * the chatbox". Then [owner 2026-08-02, verbatim] "lets actually make the left
   * panel and right panel and bottom and top panel all show in both full screen
   * views". Maximize now means the WHOLE POPUP, bigger.
   *
   * The assertions that matter are still about WHAT IS ON SCREEN rather than
   * that a state flag flipped — a test that only checked `chatMax` was set would
   * pass against a build showing none of it. What changed is the expected set:
   * every zone, in both modes, plus the composer that was never in question.
   */
  describe('P-001 maximize: full window + full screen', () => {
    const COMPOSER = /Type to wake/;

    // The file's top-level beforeEach clears the nuqs VALUE store but not the
    // setter spies, which are created lazily and then live for the whole file.
    // Every assertion below is `toHaveBeenCalledWith(<a specific mode>)`, so a
    // call left over from an earlier case would satisfy it without this — the
    // test would pass whether or not the click did anything.
    beforeEach(() => {
      for (const s of Object.values(nuqsSetters)) s.mockClear();
      desktopFs.isDesktopShell.mockReset().mockReturnValue(false);
      desktopFs.enterDesktopWindowFullscreen.mockReset().mockResolvedValue({ active: true, owned: true });
      desktopFs.exitDesktopWindowFullscreen.mockReset().mockResolvedValue(undefined);
    });

    function seedRoster(entries: Array<Record<string, unknown>>) {
      H.results['advRoster.list'] = {
        data: [{ active: entries, pending: [] }],
        loading: false,
        fetching: false,
        error: null,
        invalidate: vi.fn(),
      };
    }

    /** Render a resolved, live conversation — the state all of these act on. */
    async function renderResolved(onClose = vi.fn()) {
      seedRoster([{ ownerId: 'su-live-1' }]);
      mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
      const r = render(<SessionChatModal sessionOwnerId="su-live-1" onClose={onClose} />);
      await waitFor(() => expect(captured).not.toBeNull());
      return r;
    }

    const rerenderOpen = (rerender: (ui: React.ReactElement) => void, onClose = vi.fn()) =>
      rerender(<SessionChatModal sessionOwnerId="su-live-1" onClose={onClose} />);

    it('offers both maximize buttons while open, and neither while closed', async () => {
      await renderResolved();
      expect(screen.getByTestId('session-chat-full-window')).toBeTruthy();
      expect(screen.getByTestId('session-chat-full-screen')).toBeTruthy();

      cleanup();
      render(<SessionChatModal sessionOwnerId={null} onClose={vi.fn()} />);
      expect(screen.queryByTestId('session-chat-full-window')).toBeNull();
      expect(screen.queryByTestId('session-chat-full-screen')).toBeNull();
    });

    /* D-007's central claim, asserted for BOTH modes below: every zone the owner
       named survives maximize. Written as one shared expectation so the two
       modes cannot silently drift apart — which is the failure the owner
       reported the first time round ("both fullscreen buttons do the same
       thing"), just pointing the other way. */
    function expectEveryZonePresent() {
      // left · right · bottom · top, plus the conversation between them.
      expect(screen.getByTestId('session-chat-orders-rail')).toBeTruthy();
      expect(screen.getByTestId('session-chat-dossier-rail')).toBeTruthy();
      expect(screen.getByTestId('fleet-launch-row-stub')).toBeTruthy();
      expect(screen.getByTestId('session-chat-state-header')).toBeTruthy();
      expect(screen.getByTestId('session-chat-conversation')).toBeTruthy();
      expect(screen.getByPlaceholderText(COMPOSER)).toBeTruthy();
      // …and the controls that operate the two side panels, which are useless
      // to have on screen without.
      expect(screen.getByTestId('session-chat-orders-toggle')).toBeTruthy();
      expect(screen.getByTestId('session-chat-dossier-toggle')).toBeTruthy();
    }

    it('full window keeps EVERY zone — left, right, bottom, top (D-007)', async () => {
      nuqs.chatOrders = true;
      const { rerender } = await renderResolved();
      // Baseline, so a presence assertion below cannot be satisfied by a
      // fixture that renders these regardless of mode.
      expectEveryZonePresent();

      fireEvent.click(screen.getByTestId('session-chat-full-window'));
      expect(nuqsSetters.chatMax).toHaveBeenCalledWith('window');
      nuqs.chatMax = 'window';
      rerenderOpen(rerender);

      expectEveryZonePresent();
    });

    it('full screen keeps EVERY zone too — the two modes carry the same set', async () => {
      nuqs.chatOrders = true;
      nuqs.chatMax = 'screen';
      await renderResolved();
      expectEveryZonePresent();
    });

    it('exposes a close button ONLY while maximized — the backdrop it would otherwise be dismissed by is covered', async () => {
      const onClose = vi.fn();
      const { rerender } = await renderResolved(onClose);
      expect(screen.queryByTestId('session-chat-close')).toBeNull();

      nuqs.chatMax = 'window';
      rerenderOpen(rerender, onClose);
      fireEvent.click(screen.getByTestId('session-chat-close'));
      expect(onClose).toHaveBeenCalled();
      // and it clears the mode, so reopening any session is not stuck maximized
      expect(nuqsSetters.chatMax).toHaveBeenCalledWith(null);
    });

    it('toggling full window back off returns to the normal popup with everything still there', async () => {
      nuqs.chatOrders = true;
      nuqs.chatMax = 'window';
      const { rerender } = await renderResolved();

      fireEvent.click(screen.getByTestId('session-chat-full-window'));
      expect(nuqsSetters.chatMax).toHaveBeenCalledWith(null);
      nuqs.chatMax = null;
      rerenderOpen(rerender);
      // Under D-007 nothing is restored on exit because nothing was taken away
      // — the guard is that the exit path did not LOSE a zone either.
      expectEveryZonePresent();
    });

    it('full screen requests fullscreen on the POPUP CONTAINER, not the conversation — that element IS the spec (D-007)', async () => {
      const requestFullscreen = vi.fn().mockResolvedValue(undefined);
      // jsdom implements no Fullscreen API at all, so the element under test
      // gets one. Attached to the prototype (not one node) because the assert
      // below is about WHICH node received the call.
      (HTMLElement.prototype as unknown as { requestFullscreen: unknown }).requestFullscreen =
        function (this: HTMLElement) {
          return requestFullscreen(this);
        };
      try {
        nuqs.chatOrders = true;
        await renderResolved();
        const popup = screen.getByTestId('session-chat-modal');
        fireEvent.click(screen.getByTestId('session-chat-full-screen'));

        await waitFor(() => expect(requestFullscreen).toHaveBeenCalled());
        // THE regression guard for D-007. The browser paints exactly this
        // element's subtree, so the target is what decides whether full screen
        // shows the four panels at all — no layout gate can override it. If this
        // is ever re-pointed at `session-chat-conversation` (its pre-D-007
        // value), full screen silently drops Orders, Activity, the action band
        // and the fleet row, and every presence test above would still pass
        // because they never enter real fullscreen in jsdom.
        expect(requestFullscreen).toHaveBeenCalledWith(popup);
        expect(requestFullscreen).not.toHaveBeenCalledWith(
          screen.getByTestId('session-chat-conversation'),
        );
        // Positive control on the target itself: the container really does hold
        // every zone, so fullscreening it delivers them.
        expect(within(popup).getByTestId('session-chat-orders-rail')).toBeTruthy();
        expect(within(popup).getByTestId('session-chat-dossier-rail')).toBeTruthy();
        expect(within(popup).getByTestId('fleet-launch-row-stub')).toBeTruthy();
        await waitFor(() => expect(nuqsSetters.chatMax).toHaveBeenCalledWith('screen'));
      } finally {
        delete (HTMLElement.prototype as unknown as { requestFullscreen?: unknown }).requestFullscreen;
      }
    });

    it('falls back to full window when the webview has no Fullscreen API — never a dead button', async () => {
      // No requestFullscreen on the prototype: exactly jsdom's default, and the
      // shape of a webview with fullscreen disabled.
      expect((HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen).toBeUndefined();
      await renderResolved();

      fireEvent.click(screen.getByTestId('session-chat-full-screen'));
      // The user asked for bigger and gets bigger, rather than one click that
      // visibly does nothing.
      expect(nuqsSetters.chatMax).toHaveBeenCalledWith('window');
    });

    it('a rejected fullscreen request also lands in full window rather than nowhere', async () => {
      (HTMLElement.prototype as unknown as { requestFullscreen: unknown }).requestFullscreen = () =>
        Promise.reject(new Error('permissions policy'));
      try {
        await renderResolved();
        fireEvent.click(screen.getByTestId('session-chat-full-screen'));
        await waitFor(() => expect(nuqsSetters.chatMax).toHaveBeenCalledWith('window'));
      } finally {
        delete (HTMLElement.prototype as unknown as { requestFullscreen?: unknown }).requestFullscreen;
      }
    });

    /**
     * Regression guard for a bug the maximize toolbar CAUSED and the
     * pre-existing "calls onClose when the dialog is dismissed" test caught.
     *
     * The toolbar's buttons are Radix Tooltip triggers. Radix Dialog focuses
     * the first TABBABLE descendant on open, which made that the full-window
     * button; focusing a tooltip trigger OPENS the tooltip, which mounts its
     * own dismissable layer and SWALLOWS the first Escape — so the popup
     * ignored the user's first Escape press entirely.
     *
     * Asserting the fix at the level of the invariant (where does focus land)
     * rather than re-asserting onClose, so this still fails if someone
     * reintroduces the problem via a different control.
     */
    it('lands initial focus on the conversation, never on a window control (Escape-thief guard)', async () => {
      await renderResolved();
      const region = screen.getByTestId('session-chat-conversation');
      await waitFor(() => expect(document.activeElement).toBe(region));
      expect(document.activeElement).not.toBe(screen.getByTestId('session-chat-full-window'));
      // Focusable for the redirect, but never a Tab stop of its own.
      expect(region.getAttribute('tabindex')).toBe('-1');
    });

    /**
     * D-003 — the desktop half, and the bug that produced it.
     *
     * [owner 2026-08-02, verbatim] "both fullscreen buttons do the same thing.
     * one of them is supposed to full screen on the full desktop display not
     * just the window".
     *
     * The DOM Fullscreen API is conditional on transient activation, and every
     * way it can fail falls through to `setChatMax('window')` — the OTHER
     * button's mode. A control that degrades into its neighbour reads as a
     * duplicate. The assertion that guards the fix is therefore about WHICH
     * MECHANISM is reached for: a test that only checked `chatMax === 'screen'`
     * passes against a build that never left the window.
     */
    describe('D-003 desktop: full screen must leave the webview', () => {
      /** Give jsdom a Fullscreen API so "the DOM path was NOT taken" is a real
       *  assertion rather than one satisfied by jsdom's missing implementation. */
      function withDomFullscreen(fn: (spy: ReturnType<typeof vi.fn>) => Promise<void>) {
        const spy = vi.fn().mockResolvedValue(undefined);
        (HTMLElement.prototype as unknown as { requestFullscreen: unknown }).requestFullscreen =
          function (this: HTMLElement) {
            return spy(this);
          };
        return fn(spy).finally(() => {
          delete (HTMLElement.prototype as unknown as { requestFullscreen?: unknown }).requestFullscreen;
        });
      }

      it('drives the WINDOW and never the document', async () => {
        desktopFs.isDesktopShell.mockReturnValue(true);
        await withDomFullscreen(async (requestFullscreen) => {
          await renderResolved();
          fireEvent.click(screen.getByTestId('session-chat-full-screen'));

          await waitFor(() => expect(desktopFs.enterDesktopWindowFullscreen).toHaveBeenCalled());
          // The whole fix: on the desktop this must not go through the DOM API,
          // whose failure modes all land on full-window.
          expect(requestFullscreen).not.toHaveBeenCalled();
          await waitFor(() => expect(nuqsSetters.chatMax).toHaveBeenCalledWith('screen'));
        });
      });

      it('falls back to full window when the window refuses — an older shell whose baked ACL lacks set-fullscreen', async () => {
        desktopFs.isDesktopShell.mockReturnValue(true);
        desktopFs.enterDesktopWindowFullscreen.mockResolvedValue({ active: false, owned: false });
        await renderResolved();

        fireEvent.click(screen.getByTestId('session-chat-full-screen'));
        // Never a dead button — same rule as the browser fallback above.
        await waitFor(() => expect(nuqsSetters.chatMax).toHaveBeenCalledWith('window'));
      });

      it('gives the window back when full screen is toggled off', async () => {
        desktopFs.isDesktopShell.mockReturnValue(true);
        const { rerender } = await renderResolved();
        fireEvent.click(screen.getByTestId('session-chat-full-screen'));
        await waitFor(() => expect(nuqsSetters.chatMax).toHaveBeenCalledWith('screen'));

        nuqs.chatMax = 'screen';
        rerenderOpen(rerender);
        fireEvent.click(screen.getByTestId('session-chat-full-screen'));
        await waitFor(() => expect(desktopFs.exitDesktopWindowFullscreen).toHaveBeenCalled());
        await waitFor(() => expect(nuqsSetters.chatMax).toHaveBeenCalledWith(null));
      });

      it('never takes away a fullscreen the user set themselves (adopted, not owned)', async () => {
        desktopFs.isDesktopShell.mockReturnValue(true);
        desktopFs.enterDesktopWindowFullscreen.mockResolvedValue({ active: true, owned: false });
        const { rerender } = await renderResolved();
        fireEvent.click(screen.getByTestId('session-chat-full-screen'));
        await waitFor(() => expect(nuqsSetters.chatMax).toHaveBeenCalledWith('screen'));

        nuqs.chatMax = 'screen';
        rerenderOpen(rerender);
        fireEvent.click(screen.getByTestId('session-chat-full-screen'));
        // The layout mode goes away; the window the user had already
        // fullscreened does NOT.
        await waitFor(() => expect(nuqsSetters.chatMax).toHaveBeenCalledWith(null));
        expect(desktopFs.exitDesktopWindowFullscreen).not.toHaveBeenCalled();
      });

      it('releases the window when the popup closes — never strands the app fullscreen', async () => {
        desktopFs.isDesktopShell.mockReturnValue(true);
        const { rerender } = await renderResolved();
        fireEvent.click(screen.getByTestId('session-chat-full-screen'));
        await waitFor(() => expect(desktopFs.enterDesktopWindowFullscreen).toHaveBeenCalled());

        nuqs.chatMax = 'screen';
        rerenderOpen(rerender);
        fireEvent.click(screen.getByTestId('session-chat-close'));
        // Otherwise the whole app stays on the display with the control that
        // would undo it no longer rendered.
        await waitFor(() => expect(desktopFs.exitDesktopWindowFullscreen).toHaveBeenCalled());
      });

      it('Escape leaves desktop full screen instead of doing nothing', async () => {
        // The dialog's own Escape handler is disarmed while `screen` is active
        // (in the browser the UA consumes the key). On the desktop nothing
        // consumes it, so without this the only way out is one corner icon on a
        // fullscreen window.
        desktopFs.isDesktopShell.mockReturnValue(true);
        const { rerender } = await renderResolved();
        fireEvent.click(screen.getByTestId('session-chat-full-screen'));
        await waitFor(() => expect(desktopFs.enterDesktopWindowFullscreen).toHaveBeenCalled());
        nuqs.chatMax = 'screen';
        rerenderOpen(rerender);
        nuqsSetters.chatMax.mockClear();

        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() => expect(desktopFs.exitDesktopWindowFullscreen).toHaveBeenCalled());
        await waitFor(() => expect(nuqsSetters.chatMax).toHaveBeenCalledWith(null));
      });

      it('leaves the browser on the DOM path — the desktop branch must not swallow it', async () => {
        // isDesktopShell() stays false (the beforeEach default).
        await withDomFullscreen(async (requestFullscreen) => {
          await renderResolved();
          fireEvent.click(screen.getByTestId('session-chat-full-screen'));
          await waitFor(() => expect(requestFullscreen).toHaveBeenCalled());
          expect(desktopFs.enterDesktopWindowFullscreen).not.toHaveBeenCalled();
        });
      });
    });

    it('leaving fullscreen by Esc/F11 clears the mode (the DOM is the authority, not our own flag)', async () => {
      const { rerender } = await renderResolved();
      nuqs.chatMax = 'screen';
      rerenderOpen(rerender);
      nuqsSetters.chatMax.mockClear();

      // document.fullscreenElement stays null — i.e. the browser is not
      // painting anything fullscreen — and the event fires as it does on Esc.
      act(() => {
        document.dispatchEvent(new Event('fullscreenchange'));
      });
      expect(nuqsSetters.chatMax).toHaveBeenCalled();
      const setTo = nuqsSetters.chatMax.mock.calls.at(-1)?.[0];
      // The setter takes an updater here (prev => prev === 'screen' ? null …).
      expect(typeof setTo === 'function' ? setTo('screen') : setTo).toBeNull();
    });
  });
});

/**
 * Renaming a session from the popup header
 * (hud-session-display-names-2026-08-31 P-008, D-002 — this is the product's
 * ONLY rename affordance; the HUD card stays read-only).
 */
describe('SessionChatModal — the session name (P-008)', () => {
  function seedRoster(entries: Array<Record<string, unknown>>) {
    H.results['advRoster.list'] = {
      data: [{ active: entries, pending: [] }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
  }

  /** `mockFetchOnce` supplies only `text()`; the rename action reads `json()`. */
  function mockFetchJsonOnce(status: number, body: unknown) {
    fetchMock.mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    });
  }

  async function openPopup(entry: Record<string, unknown>) {
    seedRoster([{ ownerId: 'su-live-1', fleetColor: null, fleetRole: null, ...entry }]);
    mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
    const view = render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('session-chat-name')).toBeTruthy());
    return view;
  }

  const renameCalls = () =>
    fetchMock.mock.calls.filter(([url]) => String(url) === '/api/adv/sessions/rename');

  it('shows a named session’s name as the popup title', async () => {
    await openPopup({ displayName: 'release wrangler', intent: 'greening the release gate' });
    const name = screen.getByTestId('session-chat-name');
    expect(name.textContent).toBe('release wrangler');
    expect(name.getAttribute('data-named')).toBe('true');
  });

  /* P-004/D-002 removed the identity/reference fields this band used to repeat
     from the dossier panel — and an UNNAMED session's resolved headline IS one
     of them (its intent, or its handle). So the unnamed case offers the name
     without printing the fallback. */
  it('offers to name an unnamed session without reprinting its intent', async () => {
    await openPopup({ intent: 'greening the release gate' });
    const name = screen.getByTestId('session-chat-name');
    expect(name.textContent).toBe('Name this session');
    expect(name.getAttribute('data-named')).toBe('false');
    expect(screen.getByTestId('session-chat-state-header').textContent).not.toContain(
      'greening the release gate',
    );
  });

  it('opens an input seeded with the current name, and commits it on Enter', async () => {
    await openPopup({ displayName: 'release wrangler' });
    fireEvent.click(screen.getByTestId('session-chat-name'));
    const input = screen.getByLabelText(/Session name/i) as HTMLInputElement;
    expect(input.value).toBe('release wrangler');

    mockFetchJsonOnce(200, { status: 'ok', displayName: 'gate wrangler', cleared: false });
    fireEvent.change(input, { target: { value: 'gate wrangler' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(renameCalls()).toHaveLength(1));
    expect(JSON.parse(String(renameCalls()[0][1].body))).toEqual({
      ownerId: 'su-live-1',
      name: 'gate wrangler',
    });
  });

  /* THE trap this guards: seeding the field with the resolved HEADLINE would
     make "open it, press Enter" silently freeze the objective as a manual name,
     after which the card stops tracking what the session is doing. */
  it('opens EMPTY for an unnamed session — never seeded with the fallback headline', async () => {
    await openPopup({ intent: 'greening the release gate' });
    fireEvent.click(screen.getByTestId('session-chat-name'));
    const input = screen.getByLabelText(/Session name/i) as HTMLInputElement;
    expect(input.value).toBe('');
    // The fallback is SHOWN as the placeholder — "this is what you get instead"
    // — rather than filled in, where Enter would commit it.
    expect(input.placeholder).toBe('greening the release gate');
  });

  it('clears the name on a blank commit rather than storing an empty one (R6)', async () => {
    await openPopup({ displayName: 'release wrangler' });
    fireEvent.click(screen.getByTestId('session-chat-name'));
    const input = screen.getByLabelText(/Session name/i);
    mockFetchJsonOnce(200, { status: 'ok', displayName: null, cleared: true });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(renameCalls()).toHaveLength(1));
    expect(JSON.parse(String(renameCalls()[0][1].body)).name).toBe('   ');
  });

  it('cancels on Escape without writing, and without closing the popup', async () => {
    const onClose = vi.fn();
    seedRoster([{ ownerId: 'su-live-1', displayName: 'release wrangler' }]);
    mockFetchOnce(200, { sessions: [{ source_kind: 'claude', session_id: 'claude-abc', last_ts: null }] });
    render(<SessionChatModal sessionOwnerId="su-live-1" onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId('session-chat-name')).toBeTruthy());
    fireEvent.click(screen.getByTestId('session-chat-name'));
    const input = screen.getByLabelText(/Session name/i);
    fireEvent.change(input, { target: { value: 'discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('session-chat-name').textContent).toBe('release wrangler'));
    expect(renameCalls()).toHaveLength(0);
    // The keypress that meant "cancel this edit" must not also close the
    // conversation the user was reading.
    expect(onClose).not.toHaveBeenCalled();
  });

  /* Blur DISCARDS. A blank commit clears the name, so a blur-submit would make
     clicking anywhere else a silent destructive act. */
  it('discards the draft on blur instead of submitting it', async () => {
    await openPopup({ displayName: 'release wrangler' });
    fireEvent.click(screen.getByTestId('session-chat-name'));
    const input = screen.getByLabelText(/Session name/i);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByTestId('session-chat-name').textContent).toBe('release wrangler'));
    expect(renameCalls()).toHaveLength(0);
  });

  it('keeps the edit open and reports the failure when the write is rejected', async () => {
    await openPopup({ displayName: 'release wrangler' });
    fireEvent.click(screen.getByTestId('session-chat-name'));
    const input = screen.getByLabelText(/Session name/i);
    mockFetchJsonOnce(500, { status: 'error', error: 'nope' });
    fireEvent.change(input, { target: { value: 'gate wrangler' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const err = await waitFor(() => screen.getByTestId('session-chat-name-error'));
    expect(err.textContent).toContain('nope');
    // Still editing — the typed value is not thrown away on a failed write.
    expect((screen.getByLabelText(/Session name/i) as HTMLInputElement).value).toBe('gate wrangler');
  });

  /* The accessible dialog name is what a screen reader announces on open, and
     announcing a raw owner id is the regression this plan exists to fix. It is
     resolved through the SHARED chain (D-003), so it can fall back to the
     objective where the visible band deliberately does not. */
  it('leads the accessible dialog title with the resolved name, not the owner id', async () => {
    await openPopup({ displayName: 'release wrangler' });
    expect(screen.getByText('Chat — release wrangler')).toBeTruthy();
    cleanup();
    await openPopup({ intent: 'greening the release gate' });
    expect(screen.getByText('Chat — greening the release gate')).toBeTruthy();
  });
});

/* ── The turn rail's layout invariant ────────────────────────────────────────
   Plan chat-popup-turn-rail-2026-08-31, D-002 (NOT the `D-002` of
   chat-ref-pills-2026-07-26 cited elsewhere in this file, and NOT the
   `D-007 superseded D-002` fullscreen note in SessionChatModal.tsx — bare
   decision ids collide across plans, so this block names its plan).

   D-002 says the rail is a SIBLING of the conversation region, never a child,
   because maximize paints the popup container and the scoping rule depends on
   that shape. It also says, in the source comment at the mount: "Do NOT move it
   into the conversation element to make something line up."

   That instruction had NO test behind it. Peer vetting of this plan's
   acceptance rubric (su-3b0568df, consult conv-mthfb0sc) established that the
   rubric criterion grading this invariant was bound to THIS FILE while this
   file contained zero references to TurnRail — a path binding masquerading as a
   detection binding. This block is that missing detection: it fails if the rail
   is re-nested inside the conversation region, which is exactly the refactor
   D-002 warns "nothing in the tree would catch". ── */
describe('chat-popup-turn-rail-2026-08-31 D-002 — the turn rail is a sibling of the conversation region', () => {
  async function openWithRail() {
    mockFetchOnce(200, {
      sessions: [{ source_kind: 'claude', session_id: 'claude-rail', active: true, last_ts: null }],
    });
    const view = render(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    await waitFor(() => expect(captured).not.toBeNull());
    return view;
  }

  it('mounts the rail OUTSIDE the conversation region, and the conversation outside the rail', async () => {
    await openWithRail();

    const rail = screen.getByTestId('session-chat-turn-rail');
    const conversation = screen.getByTestId('session-chat-conversation');

    // The invariant itself, stated both ways so neither nesting direction slips through.
    expect(conversation.contains(rail)).toBe(false);
    expect(rail.contains(conversation)).toBe(false);
  });

  it('keeps the rail inside the popup container, so it stays within the maximize target', async () => {
    await openWithRail();

    const modal = screen.getByTestId('session-chat-modal');
    const rail = screen.getByTestId('session-chat-turn-rail');

    // Sibling-of-conversation must not be achieved by hoisting the rail out of
    // the popup entirely — that would satisfy the containment check above while
    // dropping the rail out of what maximize paints.
    expect(modal.contains(rail)).toBe(true);
  });

  it('P-004: chatTurns behaviorally controls rail visibility, including the close path', async () => {
    const { rerender } = await openWithRail();

    // The default is open, and the rail's own close control must drive the
    // same nuqs state that governs the conditional render in SessionChatModal.
    const rail = screen.getByTestId('session-chat-turn-rail');
    fireEvent.click(within(rail).getByRole('button', { name: 'Hide the turn rail' }));
    expect(nuqsSetters.chatTurns).toHaveBeenCalledWith(false);

    // The test mock's setter intentionally does not schedule React work; a
    // rerender makes this a real render-binding assertion rather than merely a
    // spy on the callback. If the component stopped consulting chatTurns, the
    // rail would remain mounted here.
    rerender(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    expect(screen.queryByTestId('session-chat-turn-rail')).toBeNull();

    // Positive control: an explicit deep-link/open choice must restore the
    // rail, proving the key is not only read on the initial render.
    nuqs.chatTurns = true;
    rerender(<SessionChatModal sessionOwnerId="su-live-1" onClose={vi.fn()} />);
    expect(screen.getByTestId('session-chat-turn-rail')).toBeTruthy();
  });

  it('D-004: the shipped turn rail has no flags-catalog gate', () => {
    const flagsSource = readFileSync(
      resolve(__dirname, '../../../../../libs/flags/src/types.ts'),
      'utf8',
    );

    // Positive control for the source guard: this is the real flags catalog,
    // not an empty/mis-resolved file whose absence assertion passes vacuously.
    expect(flagsSource).toContain('KNOWN_DARK_FLAGS');
    expect(flagsSource).not.toMatch(/chatTurns|turnrail|turn_rail|turn-rail/i);
  });
});
