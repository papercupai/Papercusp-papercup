// @vitest-environment jsdom
//
// AdvConversationsTab render coverage — the /adv Conversations tab's simplified
// design. Mounts the tab against a realistic dev.coordFeed snapshot (useSyncQuery
// + nuqs mocked, the pinned sibling pattern — see admin/GitClient.test.tsx) and
// asserts:
//   - the unified inbox is the default front door,
//   - the stale "Needs you" pill is gone (its home is now Create → Queue),
//   - the Raw events log is set apart but keeps raw traffic reachable,
//   - human category filters replace the raw 12-kind wall by default,
//   - a BROADCAST row is marked, and a "→ human" escalation is highlighted,
//   - the plan-slug chip renders,
//   - an ack groups under its parent as a reply (related_msg_id chain),
//   - one curated Conversations view replaces the source-specific sub-tabs,
//   - each source remains legible through a type pill on its unified row.
// Guards against render-time crashes the typecheck can't catch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// nuqs: every useQueryState call needs the adapter context — stub each param to
// a stable [value, noop]. The component reads `conv` (view), the activity filters
// (fkind array, fadvanced, fagent/fplan/fq strings, fmsg selection). Default view is inbox.
const nuqsState: Record<string, unknown> = {
  conv: 'inbox',
  fkind: [],
  fadvanced: 'closed',
  fagent: '',
  fplan: '',
  fq: '',
  fmsg: null,
  fsys: 'system', // feed sender scope: system-origin only (default) | all (WI-4462)
  // the new communication views' selection/filter params
  conversation: null,
  cstate: 'open',
  ckind: 'all',
  ctopic: '',
  thread: null,
  acharness: '',
  acrole: '',
  chat: null,
  cq: '',
  cvf: {},
  opc: null,
};
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
const { setQueryStates } = vi.hoisted(() => ({ setQueryStates: vi.fn() }));
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => [nuqsState[key], vi.fn()],
  useQueryStates: (parsers: Record<string, unknown>) => [
    Object.fromEntries(Object.keys(parsers).map((key) => [key, nuqsState[key]])),
    setQueryStates,
  ],
  parseAsString: { withDefault: () => ({}) },
  parseAsStringEnum: () => ({ withDefault: () => ({}) }),
  parseAsArrayOf: () => ({ withDefault: () => ({}) }),
  createParser: () => ({ withDefault: () => ({}) }),
}));

const TS = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
/** The moment the fixtures below froze (module import). The day-separator test
 *  pins Date to THIS so "minutes-old" rows and the component's "today" always
 *  share a UTC day — see the ⏰ note on that test. */
const FIXTURE_NOW = Date.now();

// A cross-channel snapshot: one of every salient kind, newest-first, with an ack
// whose related_msg_id points at the direct message (the thread-grouping case).
const directMsg = {
  ts: TS(9),
  msg_id: 'm-direct',
  from: 'system:coordinator',
  to: ['worker'],
  kind: 'message',
  surface: 'messages',
  broadcast: false,
  summary: 'please pick up the auth refactor',
};
const feedRows = [
  {
    ts: TS(1),
    msg_id: 'm-bc',
    from: 'system:release',
    to: ['*'],
    kind: 'message',
    surface: 'messages',
    broadcast: true,
    summary: 'fleet-wide: staging is green',
    // _meta rides on row[0] (the resolver contract).
    _meta: {
      total: 6,
      byKind: { message: 2, ack: 1, notify: 1, handoff: 1, escalation: 1 },
      nextCursor: TS(99),
    },
  },
  {
    ts: TS(2),
    msg_id: 'm-esc',
    from: 'system:gate',
    to: ['human'],
    kind: 'escalation',
    surface: 'escalations',
    broadcast: false,
    summary: 'need a decision on the schema migration',
    plan_slug: 'auth-refactor-2026',
  },
  {
    ts: TS(3),
    msg_id: 'm-notify',
    from: 'system:build',
    to: ['architect'],
    kind: 'notify',
    surface: 'messages',
    broadcast: false,
    summary: 'build finished',
  },
  {
    ts: TS(4),
    msg_id: 'm-handoff',
    from: 'system:scheduler',
    to: ['worker'],
    kind: 'handoff',
    surface: 'handoffs',
    broadcast: false,
    summary: 'handing off the UI work',
    plan_slug: 'auth-refactor-2026',
  },
  {
    ts: TS(8),
    msg_id: 'm-ack',
    from: 'system:delivery',
    to: ['architect'],
    kind: 'ack',
    surface: 'messages',
    broadcast: false,
    related_msg_id: 'm-direct', // groups under directMsg
    summary: 'got it',
  },
  directMsg,
];

let mockResult: Record<string, unknown> = {
  data: feedRows,
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
  transport: 'SSE',
};
const ready = (data: unknown[] = []): Record<string, unknown> => ({
  data,
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
  transport: 'SSE',
});
const syncKey = (queryName: string, args: Record<string, unknown> = {}) => `${queryName}:${JSON.stringify(args)}`;
let syncResults: Record<string, Record<string, unknown>> = {};
// The ARGS the feed last asked the server for — the sender-scope contract
// (system_only) is invisible in the DOM, so it's asserted here (WI-4462).
let lastFeedArgs: Record<string, unknown> | null = null;
/* Spread the original (WI-38242's class): a from-scratch factory strips the
   package's other exports — including lazyWithRetry, which operator-core
   re-exports and this render graph reaches (PlansPane → PlanDashboardHost,
   plan-visibility-revamp P-005) — and the file fails to COLLECT. */
vi.mock('@papercusp/sync', async (orig) => ({
  ...(await orig<typeof import('@papercusp/sync')>()),
  onSyncBusEvent: () => () => {},
  useSyncQuery: ({ queryName, args = {}, enabled = true }: { queryName: string; args?: Record<string, unknown>; enabled?: boolean }) => {
    if (queryName === 'dev.coordFeed') {
      lastFeedArgs = args;
      return mockResult;
    }
    if (!enabled) return ready();
    return syncResults[syncKey(queryName, args)] ?? syncResults[queryName] ?? ready();
  },
}));

// @tanstack/react-virtual: the agent-chats rail (U1) renders through a
// virtualized RichGrid (virtualMode). jsdom has no layout engine, so the REAL
// virtualizer sees a zero-height scroll container and yields no virtual items —
// the rail renders nothing and the row text can't be found. Mock useVirtualizer
// to yield one VirtualItem per row so the full window mounts under test. This
// mirrors grid-core's own RichGrid.virtual.test.tsx, which feeds a stub
// virtualizer rather than faking DOM geometry (jsdom can't drive the real one).
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey?: (index: number) => string | number }) => {
    const ROW = 104;
    const items = Array.from({ length: count }, (_, index) => ({
      index,
      key: getItemKey?.(index) ?? `vrow-${index}`,
      start: index * ROW,
      end: index * ROW + ROW,
      size: ROW,
      lane: 0,
    }));
    return {
      getVirtualItems: () => items,
      getTotalSize: () => count * ROW,
      measureElement: () => {},
      measure: () => {},
      scrollToIndex: () => {},
    };
  },
}));

// WI-125: a LIVE agent chat embeds the real interactive <ChatPanel>; stub it so
// these tests assert the tab's live-vs-archived routing, not ChatPanel itself
// (it has its own data needs + suite).
vi.mock('@/app/harness/ChatPanel', () => ({
  default: ({ slug, chatId }: { slug: string; chatId: string }) => (
    <div data-testid="chat-panel-stub">{`live-chat:${slug}:${chatId}`}</div>
  ),
}));

import AdvConversationsTab, { composeUnifiedConversationRows, isSystemConversationActor } from './AdvConversationsTab';

beforeEach(() => {
  setQueryStates.mockReset();
  lastFeedArgs = null;
  nuqsState.conv = 'inbox';
  nuqsState.fkind = [];
  nuqsState.fadvanced = 'closed';
  nuqsState.fagent = '';
  nuqsState.fplan = '';
  nuqsState.fq = '';
  nuqsState.fmsg = null;
  nuqsState.fsys = 'system';
  nuqsState.cq = '';
  nuqsState.cvf = {};
  nuqsState.conversation = null;
  nuqsState.cstate = 'open';
  nuqsState.ckind = 'all';
  nuqsState.ctopic = '';
  nuqsState.thread = null;
  nuqsState.acharness = '';
  nuqsState.acrole = '';
  nuqsState.chat = null;
  nuqsState.opc = null;
  mockResult = { data: feedRows, loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'SSE' };
  syncResults = {
    'conversations.questionsList': ready([{
      id: 'c-1', kind: 'question', state: 'open', scope: 'harness', harness_slug: 'papercusp',
      title: 'why does the watchdog recycle the host?', asker_id: 'oracle', topics: ['infra'],
      promoted_issue_id: null, created_ts: new Date(Date.now() - 120_000).toISOString(),
      updated_ts: new Date(Date.now() - 120_000).toISOString(),
    }]),
    'conversations.deliberationList': ready(),
    'conversations.agentChatList': ready([{
      id: 'chat-mail-thread', harness_slug: 'papercusp', role: 'worker', feature_id: 'F-042', title: 'pick up the UI work',
      created_at: Date.now() - 60_000, updated_at: Date.now() - 60_000, archived_at: Date.now() - 60_000,
      total_input_tokens: 0, total_output_tokens: 0, total_cost_usd_cents: 0, turns: 1,
    }]),
  };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ conversations: [] }) })));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
});

describe('AdvConversationsTab — Create-style shell', () => {
  it('opens on the unified inbox with the compact source rail and + Ask action', () => {
    render(<AdvConversationsTab />);

    // design-pass (2026-06-23): the tab now mirrors the Create dock's sidebar│main
    // model. The in-body <h1> is gone — the page title lives in the AdvShell header
    // (same as Create) — so there is no heading inside the tab body.
    expect(screen.queryByRole('heading', { name: 'Conversations' })).toBeNull();
    // The Create-style primary action ("+ New plan" ⇒ "+ Ask").
    expect(screen.getByRole('button', { name: /Ask the agents/i })).toBeTruthy();
    // The view switcher moved into the sidebar rail (still role=tab).
    expect(screen.getByRole('tab', { name: 'Conversations', selected: true })).toBeTruthy();
    // The raw event log is relabelled + set apart, but still reachable.
    expect(screen.getByRole('tab', { name: 'Raw events' })).toBeTruthy();
    // The stale "Needs you" pill is removed — its canonical home is Create → Queue.
    expect(screen.queryByRole('button', { name: /Needs you/i })).toBeNull();
    // The active view's section header still labels the rail.
    expect(screen.getByText('pick up the UI work')).toBeTruthy();
    expect(screen.getByText('why does the watchdog recycle the host?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open pick up the UI work' })).toBeTruthy();
  });

  it('opens a unified row with one atomic view + selection route update', () => {
    render(<AdvConversationsTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Open pick up the UI work' }));
    expect(setQueryStates).toHaveBeenCalledTimes(1);
    expect(setQueryStates).toHaveBeenCalledWith({
      conv: 'agentchats',
      conversation: null,
      thread: null,
      chat: 'chat-mail-thread',
      cmsg: null,
      fmsg: null,
    });
  });

  it('keeps the same conversation list DOM mounted while the selected detail changes', async () => {
    syncResults[syncKey('conversations.agentChatDetail', { id: 'chat-mail-thread' })] = ready([{
      id: 'chat-mail-thread', harness_slug: 'papercusp', role: 'worker', feature_id: 'F-042', title: 'pick up the UI work',
      created_at: Date.now() - 60_000, archived_at: Date.now() - 60_000,
      total_input_tokens: 0, total_output_tokens: 0, total_cost_usd_cents: 0, turns: 1,
      transcript: [],
    }]);
    const { rerender } = render(<AdvConversationsTab />);
    const listBefore = screen.getByRole('region', { name: 'Conversation list' });
    const rowBefore = screen.getByRole('button', { name: 'Open pick up the UI work' });

    nuqsState.conv = 'agentchats';
    nuqsState.chat = 'chat-mail-thread';
    rerender(<AdvConversationsTab />);

    expect(screen.getByRole('region', { name: 'Conversation list' })).toBe(listBefore);
    expect(screen.getByRole('button', { name: 'Open pick up the UI work' })).toBe(rowBefore);
    expect(rowBefore.getAttribute('aria-current')).toBe('true');
    expect(await screen.findByRole('heading', { name: 'pick up the UI work' })).toBeTruthy();
  });

  it('clears every source-owned selection atomically when returning to Conversations', () => {
    nuqsState.conv = 'deliberations';
    nuqsState.thread = 'issue-thread-EI-9534';
    nuqsState.conversation = 'conv-from-an-earlier-qa-visit';
    nuqsState.chat = 'chat-from-an-earlier-agent-visit';
    nuqsState.fmsg = 'event-from-an-earlier-feed-visit';

    render(<AdvConversationsTab />);
    fireEvent.click(screen.getByRole('tab', { name: 'Conversations' }));

    expect(setQueryStates).toHaveBeenCalledWith({
      conv: 'inbox',
      conversation: null,
      thread: null,
      chat: null,
      cmsg: null,
      fmsg: null,
    });
  });

  it('turns an indefinitely pending initial inbox read into a retryable state', async () => {
    vi.useFakeTimers();
    for (const name of [
      'conversations.questionsList',
      'conversations.deliberationList',
      'conversations.agentChatList',
    ]) {
      syncResults[name] = { data: [], loading: true, fetching: true, error: null, invalidate: vi.fn(), transport: 'SSE' };
    }
    render(<AdvConversationsTab />);
    expect(screen.getByRole('status', { name: 'Loading conversations' })).toBeTruthy();

    await act(async () => { vi.advanceTimersByTime(8_000); });

    expect(screen.getByText("Couldn't load")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload conversations' }).hasAttribute('disabled')).toBe(false);
  });

  it('keeps one curated view and one subordinate diagnostic view in the rail', () => {
    render(<AdvConversationsTab />);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('tab', { name: 'Conversations' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Raw events' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Q&A' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Deliberations' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Agent chats' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Messages' })).toBeNull();
  });

  // The primary communication surfaces form one visual set; the diagnostic raw
  // stream is subordinate inside the same accessible tablist. No heading/copy is
  // added to explain the split — hierarchy does that work.
  it('groups primary views separately from the subordinate diagnostic view', () => {
    render(<AdvConversationsTab />);
    const styles = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    expect(styles).not.toContain('pc-advconv__viewtabs');
    const navRule = styles.match(/\.pc-advconv__nav\s*{[^}]*}/)?.[0] ?? '';
    expect(navRule).toContain('width:');
    const tablist = screen.getByRole('tablist', { name: 'Conversations view' });
    const primary = tablist.querySelector('.pc-advconv__nav-primary');
    const diagnostic = tablist.querySelector('.pc-advconv__nav-diagnostic');
    const conversations = screen.getByRole('tab', { name: 'Conversations' });
    const raw = screen.getByRole('tab', { name: 'Raw events' });
    expect(primary?.contains(conversations)).toBe(true);
    expect(primary?.contains(raw)).toBe(false);
    expect(diagnostic?.contains(raw)).toBe(true);
    const btnRule = styles.match(/\.pc-advconv__navbtn\s*{[^}]*}/)?.[0] ?? '';
    expect(btnRule).toContain('width: 40px');
    expect(styles).toContain('.pc-advconv__navbtn.is-active::before');
    expect(styles).toContain('.pc-advconv__navlabel { display: none; }');
    const shellRule = styles.match(/\.pc-advconv__shell\s*{[^}]*}/)?.[0] ?? '';
    expect(shellRule).toContain('min-width: 760px');
    expect(styles).not.toContain('.pc-advconv__shell:not(.is-detail-open) .pc-advconv__main:not(.pc-advconv__main--wide)');
    expect(styles).not.toContain('.pc-advconv__shell.is-detail-open .pc-advconv__inbox');
    expect(styles).not.toContain('.pc-advconv__shell.is-detail-open .pc-advconv__back');
  });

  // P-003 regression coverage (plan conversations-tab-intuitive-hierarchy-2026-07-10,
  // decisions D-001 + D-002). The shell is min-width:760px inside an overflow-x:auto
  // root and the /adv content column is routinely narrower than that, so the shell
  // scrolls horizontally at ordinary window sizes -- measured on an isolated verifier
  // rig 2026-08-30: a 648px scroll container (112px of scroll) at the desktop's own
  // 800px minimum window, and a 470px container (290px of scroll) at 1200px. Unpinned,
  // the nav rail scrolled to left:-8px at maximum scroll, i.e. navigation went
  // off-screen exactly when the user scrolled to read the detail pane. These
  // assertions pin the fix that keeps navigation usable WITHOUT a drill-in, which the
  // negative assertions above forbid.
  // The pinning predicate is factored out of the guard so the falsifiability control
  // below can exercise the SAME function the guard runs. Keeping one copy is the whole
  // point: a control that re-implements the assertions proves only that the copy fails.
  function expectNavRailPinnedAndUncapped(navRule: string) {
    expect(navRule).not.toBe('');

    // The rail must stay pinned to the horizontal scrollport. Without all three of
    // these the rail scrolls away with the panes and P-003's "navigation remains
    // usable" fails at every width where the shell overflows.
    expect(navRule).toContain('position: sticky');
    expect(navRule).toContain('left: 0');
    expect(navRule).toContain('z-index:');

    // .pc-plans__rail's own background is a translucent gradient, so a sticky rail
    // needs an opaque base colour or the inbox shows through it while scrolling.
    // background-color (not the background shorthand) so the gradient survives.
    expect(navRule).toContain('background-color:');

    // plans.css is imported globally by routes/adv/index.tsx, and its
    // "@media (max-width: 980px) .pc-plans__rail" rule -- written for the plans
    // page's single-column collapse -- otherwise capped THIS rail at max-height 58vh
    // (measured 522px at both 900px and 800px windows, against 800px-tall panes).
    // This shell does not collapse, so the cap must stay reset.
    expect(navRule).toContain('max-height: none');

    // The SAME plans.css rule (plans.css:4217-4221) leaks TWO declarations onto this
    // rail, not one: 'max-height: 58vh' above and 'border-bottom: 1px solid' here. Both
    // resets are load-bearing across 800-980px, which is inside this shell's reachable
    // range (tauri.conf.json minWidth 800). Guarding only the cap left a real 1px rule
    // under the rail unprotected -- the gap EI-21905445364010877 found.
    expect(navRule).toContain('border-bottom: none');
  }

  // The .pc-advconv__nav rule EXACTLY as it stood at 66d7970942 (2026-08-30T18:01:51Z),
  // the last commit before the P-003 fix -- a real observed negative, not an invented one.
  const NAV_RULE_BEFORE_P003_FIX = `.pc-advconv__nav {
        flex: 0 0 auto;
        width: 64px;
        min-height: 0;
        border-right: 1px solid var(--advconv-border);
      }`;

  const readNavRule = () =>
    [...document.querySelectorAll('style')]
      .map((s) => s.textContent)
      .join('\n')
      .match(/\.pc-advconv__nav\s*{[^}]*}/)?.[0] ?? '';

  it('keeps the narrow-width nav rail pinned and un-capped while the panes scroll', () => {
    render(<AdvConversationsTab />);
    const styles = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    expectNavRailPinnedAndUncapped(styles.match(/\.pc-advconv__nav\s*{[^}]*}/)?.[0] ?? '');

    // The horizontal scroll itself is the sanctioned narrow-width behaviour (D-001):
    // the root scrolls rather than changing the information architecture.
    const rootRule = styles.match(/\.pc-advconv\s*{[^}]*}/)?.[0] ?? '';
    expect(rootRule).toContain('overflow-x: auto');
  });

  // P-004 falsifiability control. A guard that has never failed is not yet a guard, and
  // the obvious way to prove one -- mutating the tracked component in place and re-running
  // -- is unsafe here: git-sync commits the WHOLE working tree on a schedule, so an
  // in-tree mutant can be committed even when nothing goes wrong and no restore handler
  // fails. CLAUDE.md ("Proving a guard is falsifiable") puts a subject the test IMPORTS on
  // the permanent-in-test-control tier for exactly that reason, so the control lives here
  // and re-proves itself on every run instead of once, in a session nobody can re-read.
  it('P-004: the nav-rail guard is falsifiable -- pre-fix CSS and every single-declaration mutant fail it', () => {
    render(<AdvConversationsTab />);
    const navRule = readNavRule();

    // Calibration. The REAL subject must pass, or a predicate broken into vacuity would
    // let every control below "fail" for the wrong reason and still look like proof.
    expectNavRailPinnedAndUncapped(navRule);

    // The real historical negative: the rule as it actually shipped before the fix.
    expect(() => expectNavRailPinnedAndUncapped(NAV_RULE_BEFORE_P003_FIX)).toThrow();

    // ...and each pinning declaration is INDEPENDENTLY load-bearing. Without this matrix,
    // deleting any assertion except 'position: sticky' would leave the historical control
    // still throwing -- i.e. still green while that property had stopped being guarded.
    for (const declaration of [
      'position: sticky',
      'left: 0',
      'z-index:',
      'background-color:',
      'max-height: none',
      'border-bottom: none',
    ]) {
      const escaped = declaration.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const mutant = navRule.replace(new RegExp(`^.*${escaped}.*\\n?`, 'm'), '');
      // A mutation that changed nothing makes any guard look strong -- the same no-op
      // refusal scripts/mutation-probe.sh applies before it will report a verdict.
      expect(mutant, `removing "${declaration}" changed nothing`).not.toBe(navRule);
      expect(() => expectNavRailPinnedAndUncapped(mutant)).toThrow();
    }
  });

  it('connects the selected tab to one labelled detail panel', () => {
    render(<AdvConversationsTab />);
    const selected = screen.getByRole('tab', { name: 'Conversations', selected: true });
    const panel = screen.getByRole('tabpanel');
    expect(selected.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(selected.id);
  });

  it('opens the Ask composer from the + Ask action', async () => {
    render(<AdvConversationsTab />);
    fireEvent.click(screen.getByRole('button', { name: /Ask the agents/i }));
    // The composer is recipient-directed (an ask targets one named agent), so the
    // question field is no longer fleet-addressed copy.
    expect(await screen.findByPlaceholderText(/What do you want to ask\?/i)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('requires picking a specific recipient before the ask can be sent', async () => {
    render(<AdvConversationsTab />);
    fireEvent.click(screen.getByRole('button', { name: /Ask the agents/i }));
    const question = await screen.findByPlaceholderText(/What do you want to ask\?/i);
    fireEvent.change(question, { target: { value: 'who owns the sync resolver?' } });
    // A filled question alone is not enough: with no agent chosen, Ask stays disabled.
    expect(screen.getByRole('button', { name: /^Ask$/i }).hasAttribute('disabled')).toBe(true);
  });

  it('uses the semantic accent token instead of a component-local brand color', () => {
    render(<AdvConversationsTab />);
    const styles = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    const rootRule = styles.match(/\.pc-advconv\s*{[^}]*}/)?.[0] ?? '';
    expect(rootRule).toContain('--advconv-accent: var(--accent)');
    expect(rootRule).not.toContain('#ec4899');
  });

  it('shows the Raw events log as the set-apart view with grouped filters', () => {
    nuqsState.conv = 'feed';
    render(<AdvConversationsTab />);

    expect(screen.getByText(/System coordination messages for debugging/i)).toBeTruthy();
    expect(screen.getByText(/6 matching/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Messages/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Handoffs/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Escalations/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Plan events/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Advanced \/ all kinds/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^ack/i })).toBeNull();
  });

  it('keeps Activity search compact instead of using the old wide field', () => {
    nuqsState.conv = 'feed';
    render(<AdvConversationsTab />);

    const search = screen.getByLabelText('Free-text search');
    expect(search.getAttribute('type')).toBe('search');
    expect(search.closest('label')?.className).toContain('pc-advfeed__field--search');
    expect(search.closest('label')?.className).not.toContain('pc-advfeed__field--wide');
  });

  it('shows raw kind filters only when the advanced URL state is open', () => {
    nuqsState.conv = 'feed';
    nuqsState.fadvanced = 'open';
    render(<AdvConversationsTab />);

    expect(screen.getByRole('button', { name: /^ack/i })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /handoff/i }).length).toBeGreaterThan(1);
  });

  it('shows channel summaries and kind badges in the Raw events log', () => {
    nuqsState.conv = 'feed';
    render(<AdvConversationsTab />);

    // Summaries from each surface render.
    expect(screen.getByText('fleet-wide: staging is green')).toBeTruthy();
    expect(screen.getByText('need a decision on the schema migration')).toBeTruthy();
    expect(screen.getByText('build finished')).toBeTruthy();
    expect(screen.getByText('handing off the UI work')).toBeTruthy();

    // Row badges still carry the raw event kind.
    const handoffChips = screen.getAllByText('handoff');
    expect(handoffChips.length).toBeGreaterThan(0);
  });

  it('marks a broadcast row and highlights a "→ human" escalation', () => {
    nuqsState.conv = 'feed';
    render(<AdvConversationsTab />);

    expect(screen.getByText('BROADCAST')).toBeTruthy();
    expect(screen.getByText('→ human')).toBeTruthy();
  });

  it('renders the plan-slug chip on plan-scoped rows', () => {
    nuqsState.conv = 'feed';
    render(<AdvConversationsTab />);
    // Two rows carry the slug (escalation + handoff) → at least one chip.
    expect(screen.getAllByText('auth-refactor-2026').length).toBeGreaterThan(0);
  });

  it('groups an ack under its parent message as a reply (related_msg_id chain)', () => {
    nuqsState.conv = 'feed';
    render(<AdvConversationsTab />);

    // The ack is a CHILD of m-direct → it must NOT be a top-level summary row,
    // but the parent shows a "1 reply" marker.
    expect(screen.getByText('please pick up the auth refactor')).toBeTruthy();
    expect(screen.getByText(/1 reply/i)).toBeTruthy();
    // The ack's own summary ("got it") is not a standalone root row.
    expect(screen.queryByText('got it')).toBeNull();
  });

  // Regression: a Colony/Swarm message click deep-links with ?conv=feed&fmsg=<msg>.
  // When that message is a folded reply/ack (related_msg_id chain), there is no
  // top-level row for the child id — so the expand-set must resolve child→ROOT and
  // open the PARENT conversation. Before the fix, ?fmsg=<childId> matched no row and
  // nothing expanded ("clicking the message brings up the wrong/no conversation").
  it('expands the parent conversation when ?fmsg targets a folded reply (child→root)', () => {
    nuqsState.conv = 'feed';
    nuqsState.fmsg = 'm-ack'; // m-ack is a CHILD of m-direct (folded under it)
    render(<AdvConversationsTab />);
    // The parent conversation opens in the master/detail pane (WI-4216 redesign —
    // NOT an inline expand), so the parent summary legitimately appears twice
    // (list row + detail pane). Scope to the detail pane to assert the PARENT
    // opened there…
    const detail = document.querySelector('.pc-advfeed__detailpane') as HTMLElement | null;
    expect(detail).toBeTruthy();
    expect(within(detail!).getByText('please pick up the auth refactor')).toBeTruthy();
    // …and the clicked reply is now revealed inside the expanded conversation.
    expect(within(detail!).getByText('got it')).toBeTruthy();
  });

  // Regression (WI-4462, owner 2026-07-12: "clicking some of the messages brings up
  // the conversations tab opened to the clicked message but some of them don't").
  // The feed's sender scope was HARDCODED to system_only — so it could only ever
  // contain envelopes from system-* actors (isSystemCoordActor). A Fleet-sidebar
  // click on an AGENT-authored message deep-linked (?fmsg=<id>) to a row the server
  // had filtered out: nothing to scroll to, nothing to expand, while the
  // system-watchdog row directly above it in the same list worked fine. The scope is
  // now URL-backed, and the sidebar deep-links with fsys=all.
  it('defaults the feed to system-origin envelopes only', () => {
    nuqsState.conv = 'feed';
    render(<AdvConversationsTab />);
    expect(lastFeedArgs?.system_only).toBe(true);
  });

  it('?fsys=all widens the feed to agent traffic, so a deep-linked agent message can resolve', () => {
    nuqsState.conv = 'feed';
    nuqsState.fsys = 'all'; // what a Fleet-sidebar message click sets
    render(<AdvConversationsTab />);
    expect(lastFeedArgs?.system_only).toBe(false);
    // …and the widened scope is visible + reversible, never a silent mode.
    expect(screen.getByTestId('feed-system-only-chip').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText(/incl\. agent traffic/i)).toBeTruthy();
  });

  it('shows the empty state when no traffic matches', () => {
    nuqsState.conv = 'feed';
    mockResult = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'SSE' };
    render(<AdvConversationsTab />);
    expect(screen.getByText(/No matching traffic/i)).toBeTruthy();
    expect(screen.getByText(/broaden the search/i)).toBeTruthy();
  });

  it('shows a "Load older" control when the server reports more rows', () => {
    nuqsState.conv = 'feed';
    render(<AdvConversationsTab />);
    expect(screen.getByText(/Load older/i)).toBeTruthy();
  });

  // U1 (operator-vite-ui-consolidation): the feed is flattened into a single
  // virtualized RichGrid stream where each day contributes a separator row before
  // its events. All snapshot rows are minutes old → one "Today" separator.
  //
  // ⏰ Date is PINNED to the fixtures' freeze moment (Date-only fake; real timers
  // stay live for the virtualizer): the fixtures freeze at module IMPORT while the
  // component computes UTC day-keys at RENDER — on an EDT box from 20:00 local
  // (00:00 UTC) the "minutes-old" rows land on the PREVIOUS UTC day, the component
  // correctly says "Yesterday", and the bare getByText('Today') red-pinned the
  // whole green gate every evening (12h red, 2026-07-01).
  it('renders a day separator row in the virtualized activity stream', () => {
    vi.useFakeTimers({ now: FIXTURE_NOW, toFake: ['Date'] });
    try {
      nuqsState.conv = 'feed';
      render(<AdvConversationsTab />);
      expect(screen.getByText('Today')).toBeTruthy();
      // The events still render beneath it (the flatten preserved the items).
      expect(screen.getByText('fleet-wide: staging is green')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── The unified communication views (every type, not just coord threads) ──────
//
// the-conversations-tab-surfaces-every-comm-type: the tab gained two views that
// read the shared named-query cache: agent chats and deliberations. These guard
// the new views against render-time crashes the typecheck can't catch and
// assert each one surfaces its data.

/** Adapt the old endpoint-shaped fixtures into the named-query row contract. */
function stubComms(byUrl: Record<string, unknown>) {
  for (const [path, raw] of Object.entries(byUrl)) {
    const payload = raw as Record<string, unknown>;
    if (path.includes('/threads/list')) syncResults['conversations.deliberationList'] = ready((payload.items as unknown[]) ?? []);
    if (path.includes('/threads/get')) syncResults['conversations.deliberationDetail'] = ready([payload]);
    if (path.includes('/agent-chats/list')) syncResults['conversations.agentChatList'] = ready((payload.items as unknown[]) ?? []);
    if (path.includes('/agent-chats/get')) syncResults['conversations.agentChatDetail'] = ready(payload.chat ? [payload.chat] : []);
    if (path.includes('/coordination/conversations/list')) syncResults['conversations.questionsList'] = ready((payload.conversations as unknown[]) ?? []);
    if (path.includes('/coordination/conversations/get')) {
      const conversation = payload.conversation as Record<string, unknown> | undefined;
      syncResults['conversations.questionDetail'] = ready(conversation ? [{
        ...conversation,
        topics: payload.topics ?? [],
        posts: payload.posts ?? [],
        subscriber_count: payload.subscriber_count ?? 0,
      }] : []);
    }
  }
}

describe('AdvConversationsTab — unified communication views', () => {
  it('exposes each communication type as a pill instead of a navigation tab', () => {
    syncResults['conversations.deliberationList'] = ready([{
      thread_id: 'th-pill', parent_kind: 'decision', parent_ref: 'WI-7', title: 'choose the release path',
      created_by: 'architect', harness_slug: 'papercusp', created_at: TS(4), last_post_at: TS(3), post_count: 3,
    }]);
    syncResults['conversations.agentChatList'] = ready([{
      id: 'chat-pill', harness_slug: 'papercusp', role: 'worker', feature_id: 'WI-8', title: 'implement the release path',
      created_at: Date.now() - 120_000, archived_at: null, total_input_tokens: 0, total_output_tokens: 0,
      total_cost_usd_cents: 0, turns: 6,
    }]);
    const { container } = render(<AdvConversationsTab />);
    // Each communication type shows as a kind PILL in the list. (The always-
    // visible facet filter chips also carry these labels now, so scope the
    // assertion to the list pills rather than a whole-document text match.)
    const kindPills = Array.from(
      container.querySelectorAll('.pc-advconv__unified-kind'),
    ).map((el) => el.textContent);
    expect(kindPills).toContain('Questions & discussions');
    expect(kindPills).toContain('Group decisions');
    expect(kindPills).toContain('Agent chat');
    expect(screen.queryByRole('tab', { name: /Agent chats/i })).toBeNull();
    expect(screen.getByRole('tab', { name: /Raw events/i })).toBeTruthy();
  });

  it('deduplicates by identity but keeps same-source rows that merely share a title', () => {
    // REGRESSION (conversations-agent-messages-2026-07-27 P-005). The semantic
    // signature used to collapse ANY two rows sharing title/actor/pot — even
    // two DIFFERENT ids from the SAME store. Measured on live data that ate 42%
    // of agent chats (100 fetched → 58 signatures), which is why the pane read
    // "Chat 51" while 100 rows had loaded (owner, 2026-07-27). Two chat sessions
    // with the same title are two conversations; only a cross-store MIRROR of
    // one conversation may collapse (asserted in the next test).
    const base = {
      id: 'chat-a', harness_slug: 'papercusp', role: 'worker', feature_id: 'WI-7',
      title: 'release path', created_at: '2026-07-11T12:00:00.000Z', updated_at: '2026-07-11T12:00:00.000Z',
      archived_at: null, total_input_tokens: 0, total_output_tokens: 0, total_cost_usd_cents: 0, turns: 1,
    };
    const rows = composeUnifiedConversationRows({ agentChats: [
      base,
      { ...base },
      { ...base, id: 'chat-b', created_at: '2026-07-11T13:00:00.000Z', updated_at: '2026-07-11T13:00:00.000Z' },
      { ...base, id: 'chat-c', title: 'a separate follow-up' },
    ] }, 50);

    // chat-b (newest) then chat-a; the exact-id repeat of chat-a is dropped by
    // IDENTITY dedup, which is the collapse that was always correct.
    expect(rows.map((row) => row.sourceId)).toEqual(['chat-b', 'chat-a', 'chat-c']);
  });

  it('still collapses one conversation mirrored into two different stores', () => {
    // The case the semantic signature exists for, and the one it must keep
    // handling after P-005 narrowed it to CROSS-source only: a coord thread can
    // be a standalone deliberation OR the timeline attached to a Q&A
    // conversation, and in the second case both stores describe ONE thing.
    const rows = composeUnifiedConversationRows({
      questions: [{
        id: 'conv-mirror', kind: 'question', state: 'open', scope: 'harness', harness_slug: 'papercusp',
        title: 'shared subject', asker_id: 'architect', topics: [], promoted_issue_id: null,
        created_ts: TS(6), updated_ts: TS(6),
      }],
      deliberations: [{
        thread_id: 'th-mirror', parent_kind: null, parent_ref: null, title: 'shared subject',
        created_by: 'architect', harness_slug: 'papercusp', created_at: TS(5), last_post_at: TS(5), post_count: 2,
      }],
    }, 50);

    // Same title/actor/pot and no distinguishing related ref → one row survives,
    // and it is the one with the most recent activity (TS counts BACK from now,
    // so the thread's TS(5) is newer than the question's TS(6)).
    expect(rows.map((row) => row.sourceId)).toEqual(['th-mirror']);
  });

  it('composes agent↔agent coord messages as a curated source with routing and reply counts', () => {
    // The source that did not exist before P-004: 82,440 agent-authored
    // envelopes had no curated home at all (owner, 2026-07-27: "I see agents
    // sending messages to each other all the time").
    const rows = composeUnifiedConversationRows({ agentMessages: [
      {
        msg_id: 'ms-direct', kind: 'message', from: 'su-alpha', to: ['su-beta'],
        summary: 'the release gate is red', body: 'full body text',
        harness_slug: 'papercusp', plan_slug: 'some-plan', lifecycle: 'finding',
        audience: ['@object:issue:WI-42'], broadcast: false, reply_count: 3,
        ts: TS(4), last_reply_ts: TS(2),
      },
      {
        msg_id: 'ms-cast', kind: 'message', from: 'su-gamma', to: ['*'],
        summary: 'facts:assert is down fleet-wide', body: null,
        harness_slug: null, plan_slug: null, lifecycle: null,
        audience: [], broadcast: true, reply_count: 0, ts: TS(8), last_reply_ts: null,
      },
      // System-origin traffic is telemetry, never a curated conversation.
      {
        msg_id: 'ms-sys', kind: 'message', from: 'system-watchdog', to: ['*'],
        summary: 'infra-liveness tick', body: null, harness_slug: null, plan_slug: null,
        lifecycle: null, audience: [], broadcast: true, reply_count: 0, ts: TS(1), last_reply_ts: null,
      },
    ] }, 50);

    expect(rows.map((row) => row.sourceId)).toEqual(['ms-direct', 'ms-cast']);
    const [direct, cast] = rows;
    expect(direct.typeLabel).toBe('Agent messages');
    expect(direct.actor).toBe('su-alpha');
    expect(direct.recipient).toBe('su-beta');
    expect(direct.count).toBe(3);
    // The audience selector — not the plan — is the openable related object.
    expect({ kind: direct.relatedKind, ref: direct.relatedRef }).toEqual({ kind: 'issue', ref: 'WI-42' });
    // A broadcast has no single recipient; naming one would be a lie.
    expect(cast.recipient).toBe('broadcast');
    // Sorted by last ACTIVITY: ms-direct's reply at TS(2) beats ms-cast at TS(8).
    expect(direct.updatedAt).toBeGreaterThan(cast.updatedAt);
  });

  it('types each source’s related ref so it can be linked to the right destination', () => {
    // Feeds ConversationRefLink (P-009/P-010): a ref with no KIND is text we
    // cannot safely route, and must stay plain rather than guess.
    const rows = composeUnifiedConversationRows({
      questions: [{
        id: 'q-promoted', kind: 'question', state: 'resolved', scope: 'workspace', harness_slug: null,
        title: 'promoted question', asker_id: 'oracle', topics: [], promoted_issue_id: 'EI-77',
        created_ts: TS(9), updated_ts: TS(9),
      }],
      deliberations: [{
        thread_id: 'th-feature', parent_kind: 'feature', parent_ref: 'hive-canary#F-CANARY-1',
        title: 'feature thread', created_by: 'architect', harness_slug: 'papercusp',
        created_at: TS(8), last_post_at: TS(8), post_count: 1,
      }, {
        thread_id: 'th-untyped', parent_kind: 'something-new', parent_ref: 'X-1',
        title: 'unknown parent', created_by: 'architect', harness_slug: 'papercusp',
        created_at: TS(7), last_post_at: TS(7), post_count: 1,
      }],
    }, 50);

    const byId = Object.fromEntries(rows.map((r) => [r.sourceId, r]));
    expect(byId['q-promoted'].relatedKind).toBe('issue');
    expect(byId['th-feature'].relatedKind).toBe('feature');
    expect(byId['th-untyped'].relatedKind).toBeNull();
  });

  it('positions virtual rows without compositor transforms and keys them by conversation identity', () => {
    render(<AdvConversationsTab />);
    const row = screen.getByRole('button', { name: 'Open pick up the UI work' });
    expect(row.style.top).not.toBe('');
    expect(row.style.transform).toBe('');
  });

  it('shows the selected synchronized row in the detail pane while its detail query warms', () => {
    nuqsState.conv = 'threads';
    nuqsState.conversation = 'c-1';
    syncResults['conversations.questionDetail'] = {
      data: [], loading: true, fetching: true, error: null, invalidate: vi.fn(), transport: 'SSE',
    };

    render(<AdvConversationsTab />);

    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByRole('heading', { name: 'why does the watchdog recycle the host?' })).toBeTruthy();
    expect(within(panel).getByRole('status', { name: 'Loading conversation' })).toBeTruthy();
  });

  it('partitions system-origin records out of every curated conversation source', () => {
    expect(isSystemConversationActor('system:watchdog')).toBe(true);
    expect(isSystemConversationActor('system-release')).toBe(true);
    expect(isSystemConversationActor('architect')).toBe(false);
    const rows = composeUnifiedConversationRows(
      {
        questions: [{ id: 'system-question', kind: 'question', state: 'open', scope: 'workspace', harness_slug: null, title: 'health tick', asker_id: 'system:watchdog', topics: [], promoted_issue_id: null, created_ts: TS(1), updated_ts: TS(1) }],
        deliberations: [{ thread_id: 'agent-thread', parent_kind: null, parent_ref: null, title: 'agent decision', created_by: 'architect', harness_slug: null, created_at: TS(2), last_post_at: null, post_count: 1 }],
        agentChats: [{ id: 'system-chat', harness_slug: null, role: 'system:scheduler', feature_id: null, title: 'tick', created_at: TS(3), updated_at: TS(3), archived_at: null, total_input_tokens: 0, total_output_tokens: 0, total_cost_usd_cents: 0, turns: 0 }],
        agentMessages: [{ msg_id: 'system-msg', kind: 'message', from: 'system-watchdog', to: ['*'], summary: 'tick', body: null, harness_slug: null, plan_slug: null, lifecycle: null, audience: [], broadcast: true, reply_count: 0, ts: TS(4), last_reply_ts: null }],
      },
      50,
    );
    expect(rows.map((row) => row.sourceId)).toEqual(['agent-thread']);
  });

  it('does not let a busy source crowd other conversation types out of the merged window', () => {
    syncResults['conversations.deliberationList'] = ready(Array.from({ length: 100 }, (_, index) => ({
      thread_id: `th-${index}`,
      parent_kind: 'issue',
      parent_ref: `WI-${index}`,
      title: `decision ${index}`,
      created_by: 'architect',
      harness_slug: 'papercusp',
      created_at: new Date(Date.now() - index * 1_000).toISOString(),
      last_post_at: new Date(Date.now() - index * 1_000).toISOString(),
      post_count: 1,
    })));
    syncResults['conversations.agentChatList'] = ready([{
      id: 'older-chat', harness_slug: 'papercusp', role: 'worker', feature_id: 'WI-older',
      title: 'older agent chat remains discoverable', created_at: Date.now() - 86_400_000,
      archived_at: null, total_input_tokens: 0, total_output_tokens: 0, total_cost_usd_cents: 0, turns: 2,
    }]);

    const { container } = render(<AdvConversationsTab />);

    expect(screen.getByText('older agent chat remains discoverable')).toBeTruthy();
    // The rail header count reflects every merged row. (A facet chip's live
    // count may coincide with this number, so scope to the rail-head total.)
    const railHead = container.querySelector('.pc-advconv__railhead--unified');
    expect(railHead?.querySelector('strong')?.textContent).toBe(
      '102 · the latest bounded conversation window (up to 100 per source)',
    );
    expect(railHead?.querySelector('strong')?.getAttribute('aria-label')).toBe(
      '102 conversations in the latest bounded conversation window (up to 100 per source)',
    );
  });

  it('Deliberations view lists threads and opens its posts', async () => {
    nuqsState.conv = 'deliberations';
    nuqsState.thread = 'th-1';
    stubComms({
      '/comms/threads/list': {
        items: [
          {
            thread_id: 'th-1',
            parent_kind: 'issue',
            parent_ref: 'ISS-7',
            title: 'memory-watchdog recycles the host',
            created_by: 'oracle',
            harness_slug: 'papercup',
            created_at: new Date().toISOString(),
            last_post_at: new Date().toISOString(),
            post_count: 2,
          },
        ],
      },
      '/comms/threads/get': {
        thread: {
          thread_id: 'th-1',
          parent_kind: 'issue',
          parent_ref: 'ISS-7',
          title: 'memory-watchdog recycles the host',
          created_by: 'oracle',
          harness_slug: 'papercup',
          created_at: new Date().toISOString(),
          last_post_at: new Date().toISOString(),
          post_count: 2,
        },
        posts: [
          { id: 1, author_id: 'oracle', body: 'the host recycles every 12m', created_at: new Date().toISOString(), harness_slug: 'papercup' },
          { id: 2, author_id: 'worker', body: 'looks like the watchdog threshold', created_at: new Date().toISOString(), harness_slug: 'papercup' },
        ],
      },
    });
    render(<AdvConversationsTab />);
    expect(await screen.findByText('the host recycles every 12m')).toBeTruthy();
    expect(screen.getByText('looks like the watchdog threshold')).toBeTruthy();
  });

  it('keys deliberation detail by the current selected id', async () => {
    nuqsState.conv = 'deliberations';
    nuqsState.thread = 'th-a';
    const detail = (id: string, body: string) => ({
      thread: { thread_id: id, title: id, parent_kind: null, parent_ref: null, created_by: null, harness_slug: null, created_at: new Date().toISOString(), last_post_at: null, post_count: 1 },
      posts: [{ id: id === 'th-a' ? 1 : 2, author_id: 'worker', body, created_at: new Date().toISOString(), harness_slug: null }],
    });
    syncResults[syncKey('conversations.deliberationDetail', { id: 'th-a' })] = ready([detail('th-a', 'stale detail')]);
    syncResults[syncKey('conversations.deliberationDetail', { id: 'th-b' })] = ready([detail('th-b', 'newest detail')]);
    const { rerender } = render(<AdvConversationsTab />);
    expect(await screen.findByText('stale detail')).toBeTruthy();
    nuqsState.thread = 'th-b';
    rerender(<AdvConversationsTab />);
    expect(await screen.findByText('newest detail')).toBeTruthy();
    expect(screen.queryByText('stale detail')).toBeNull();
  });

  it('keeps agent chats in Conversations after removing their standalone view', async () => {
    stubComms({
      '/comms/agent-chats/list': {
        items: [
          {
            id: 'chat-1',
            harness_slug: 'papercup',
            role: 'worker',
            feature_id: 'F-042',
            title: 'implement the auth refactor',
            created_at: Date.now() - 3_600_000,
            archived_at: null,
            total_input_tokens: 1200,
            total_output_tokens: 800,
            total_cost_usd_cents: 34,
            turns: 6,
          },
        ],
      },
    });
    const { container } = render(<AdvConversationsTab />);
    expect(await screen.findByText('implement the auth refactor')).toBeTruthy();
    expect(screen.getAllByText('worker').length).toBeGreaterThan(0);
    // "Agent chat" appears as a list kind-pill (the facet chips carry the same
    // label now, so scope to the list pills).
    const kindPills = Array.from(
      container.querySelectorAll('.pc-advconv__unified-kind'),
    ).map((el) => el.textContent);
    expect(kindPills).toContain('Agent chat');
    expect(screen.queryByText('Agent Chat Sessions')).toBeNull();
  });

  it('keeps the unified list mounted while a source refresh is in flight', async () => {
    const invalidate = vi.fn();
    syncResults['conversations.agentChatList'] = {
      ...ready([{
        id: 'chat-stable',
        harness_slug: 'papercusp',
        role: 'worker',
        feature_id: 'F-100',
        title: 'stable conversation row',
        created_at: Date.now(),
        archived_at: null,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost_usd_cents: 0,
        turns: 1,
      }]),
      fetching: true,
      invalidate,
    };

    render(<AdvConversationsTab />);
    expect(await screen.findByText('stable conversation row')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload conversations' }));

    // The previous implementation swapped the complete rail for skeletons here,
    // producing the visible button flash on every slow refresh.
    expect(screen.getByText('stable conversation row')).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('Agent chats view renders an ARCHIVED transcript read-only (no composer)', async () => {
    nuqsState.conv = 'agentchats';
    nuqsState.chat = 'chat-1';
    stubComms({
      '/comms/agent-chats/list': { items: [] },
      '/comms/agent-chats/get': {
        chat: {
          id: 'chat-1',
          harness_slug: 'papercup',
          role: 'worker',
          feature_id: 'F-042',
          title: 'implement the auth refactor',
          created_at: Date.now(),
          archived_at: Date.now(),
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cost_usd_cents: 0,
          transcript: [
            { ts: new Date().toISOString(), role: 'user', content: 'start the refactor' },
            { ts: new Date().toISOString(), role: 'assistant', content: 'on it — opening the module' },
          ],
        },
      },
    });
    const rawError = 'codex exited 1: internal backend path and provider details';
    syncResults[syncKey('conversations.agentChatDetail', { id: 'chat-1' })] = ready([{
      id: 'chat-1',
      harness_slug: 'papercup',
      role: 'worker',
      feature_id: 'F-042',
      title: 'implement the auth refactor',
      created_at: Date.now(),
      archived_at: Date.now(),
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_usd_cents: 0,
      turns: 3,
      transcript: [
        { ts: new Date().toISOString(), role: 'user', content: 'start the refactor' },
        { ts: new Date().toISOString(), role: 'assistant', content: 'on it — opening the module' },
        { ts: new Date().toISOString(), role: 'assistant', content: rawError, error: true },
      ],
    }]);
    render(<AdvConversationsTab />);
    expect(await screen.findByText('start the refactor')).toBeTruthy();
    expect(screen.getByText('on it — opening the module')).toBeTruthy();
    expect(screen.getByText('That turn did not complete. Try asking again.')).toBeTruthy();
    expect(screen.queryByText(/internal backend path/i)).toBeNull();
    // archived → no interactive panel
    expect(screen.queryByTestId('advconv-live-chat')).toBeNull();
  });

  it('keys agent-chat detail by the current selected id', async () => {
    nuqsState.conv = 'agentchats';
    nuqsState.chat = 'chat-a';
    const chat = (id: string, content: string) => ({
      id,
      harness_slug: null,
      role: 'worker',
      feature_id: null,
      title: id,
      created_at: Date.now(),
      archived_at: Date.now(),
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_usd_cents: 0,
      turns: 1,
      transcript: [{ role: 'assistant', content }],
    });
    syncResults[syncKey('conversations.agentChatDetail', { id: 'chat-a' })] = ready([chat('chat-a', 'stale chat detail')]);
    syncResults[syncKey('conversations.agentChatDetail', { id: 'chat-b' })] = ready([chat('chat-b', 'newest chat detail')]);
    const { rerender } = render(<AdvConversationsTab />);
    expect(await screen.findByText('stale chat detail')).toBeTruthy();
    nuqsState.chat = 'chat-b';
    rerender(<AdvConversationsTab />);
    expect(await screen.findByText('newest chat detail')).toBeTruthy();
    expect(screen.queryByText('stale chat detail')).toBeNull();
  });

  // WI-125: the conversations tab is no longer a read-only transcript browser —
  // a LIVE chat embeds the interactive ChatPanel (transcript + composer).
  it('Agent chats view embeds the interactive ChatPanel for a LIVE chat', async () => {
    nuqsState.conv = 'agentchats';
    nuqsState.chat = 'chat-1';
    stubComms({
      '/comms/agent-chats/list': { items: [] },
      '/comms/agent-chats/get': {
        chat: {
          id: 'chat-1',
          harness_slug: 'papercup',
          role: 'worker',
          feature_id: 'F-042',
          title: 'implement the auth refactor',
          created_at: Date.now(),
          archived_at: null,
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cost_usd_cents: 0,
          transcript: [{ ts: new Date().toISOString(), role: 'user', content: 'start the refactor' }],
        },
      },
    });
    render(<AdvConversationsTab />);
    expect(await screen.findByTestId('advconv-live-chat')).toBeTruthy();
    // the real ChatPanel (stubbed) gets the harness + chat id
    expect(screen.getByText('live-chat:papercup:chat-1')).toBeTruthy();
    // the read-only transcript is replaced by the live panel
    expect(screen.queryByText('start the refactor')).toBeNull();
  });

  it('a live chat WITHOUT a harness slug falls back to the read-only transcript', async () => {
    nuqsState.conv = 'agentchats';
    nuqsState.chat = 'chat-2';
    stubComms({
      '/comms/agent-chats/list': { items: [] },
      '/comms/agent-chats/get': {
        chat: {
          id: 'chat-2',
          harness_slug: null,
          role: 'worker',
          feature_id: null,
          title: 'workspace chat',
          created_at: Date.now(),
          archived_at: null,
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cost_usd_cents: 0,
          transcript: [{ ts: new Date().toISOString(), role: 'user', content: 'hello there' }],
        },
      },
    });
    render(<AdvConversationsTab />);
    expect(await screen.findByText('hello there')).toBeTruthy();
    expect(screen.queryByTestId('advconv-live-chat')).toBeNull();
  });

  // U1 (operator-vite-ui-consolidation): the threads + deliberations rails now
  // render through the shared virtualized RichGrid (the agent-chats template).
  // This pins that a populated thread rail surfaces its row — title, state pill,
  // and the variable-height topic-tag line — through the grid cell.
  it('Threads view lists conversations through the virtualized rail', async () => {
    nuqsState.conv = 'threads';
    stubComms({
      '/coordination/conversations/list': {
        conversations: [
          {
            id: 'c-1',
            kind: 'question',
            state: 'open',
            scope: 'harness',
            harness_slug: 'papercup',
            title: 'why does the watchdog recycle the host?',
            asker_id: 'oracle',
            topics: ['infra'],
            created_ts: new Date().toISOString(),
          },
        ],
      },
    });
    render(<AdvConversationsTab />);
    expect(await screen.findByText('why does the watchdog recycle the host?')).toBeTruthy();
    // the topic tag (the variable-height part of the row) renders in the cell —
    // `#infra` shows up both as the rail's topic-filter chip and the in-row tag.
    expect(screen.getAllByText('#infra').length).toBeGreaterThan(0);
  });

  it('the unified view degrades to one empty state with no data', () => {
    syncResults['conversations.questionsList'] = ready();
    syncResults['conversations.deliberationList'] = ready();
    syncResults['conversations.agentChatList'] = ready();
    render(<AdvConversationsTab />);
    expect(screen.getByText('No conversations')).toBeTruthy();
  });

  it('a failed source query surfaces one retryable unified-list error', () => {
    syncResults['conversations.questionsList'] = ready();
    syncResults['conversations.deliberationList'] = {
      ...ready(),
      error: new Error('HTTP 500'),
    };
    syncResults['conversations.agentChatList'] = ready();
    render(<AdvConversationsTab />);
    expect(screen.getByText(/Couldn't load/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeTruthy();
    expect(screen.getByText(/HTTP 500/)).toBeTruthy();
  });
});

// ─── P-008 stress regressions (conversations-sync-migration-and-app-audit-2026-07-11) ──
//
// WI-4142 differential (D-001) left one hypothesis UNCONFIRMED: does
// composeUnifiedConversationRows's global re-sort on every single-source
// invalidation cause rows from OTHER, unchanged sources to visibly reshuffle
// more often than a single-source list ever would? These regressions confirm
// or refute it deterministically (no timers, no flakiness), plus cover the
// three other P-008 targets: rapid cross-source selection, row/DOM identity
// continuity across invalidations, and no request-storm on selection.
describe('AdvConversationsTab — P-008 stress regressions', () => {
  it('repeated invalidation of one source does not reorder or change the identity of unrelated rows (reorder-churn hypothesis: REFUTED)', () => {
    const deliberation = {
      thread_id: 'th-static', parent_kind: 'issue', parent_ref: 'WI-1', title: 'static deliberation',
      created_by: 'architect', harness_slug: 'papercusp', created_at: TS(10), last_post_at: TS(10), post_count: 1,
    };
    const chat = {
      id: 'chat-static', harness_slug: 'papercusp', role: 'worker', feature_id: null, title: 'static agent chat',
      created_at: TS(5), updated_at: TS(5), archived_at: null, total_input_tokens: 0, total_output_tokens: 0,
      total_cost_usd_cents: 0, turns: 1,
    };
    // A newly-arriving question is always the most recent row (TS(1)), so the
    // unrelated pair's relative order — agent chat (TS5) ahead of deliberation
    // (TS10) — is the only thing under test across every recompute below.
    for (let i = 0; i < 20; i += 1) {
      const questions = [{
        id: `q-${i}`, kind: 'question', state: 'open', scope: 'harness', harness_slug: 'papercusp',
        title: `live question ${i}`, asker_id: 'oracle', topics: [], promoted_issue_id: null,
        created_ts: TS(1), updated_ts: TS(1),
      }];
      // A brand-new array reference each pass, as a real background refetch hands back.
      const rows = composeUnifiedConversationRows({ questions, deliberations: [deliberation], agentChats: [chat] }, 50);
      expect(rows.map((row) => row.id)).toEqual(['threads:' + `q-${i}`, 'agentchats:chat-static', 'deliberations:th-static']);
    }
  });

  it('a genuine timestamp change on one row moves only that row, leaving other rows in their prior relative order', () => {
    const oldest = { thread_id: 'th-a', parent_kind: null, parent_ref: null, title: 'a', created_by: 'architect', harness_slug: 'papercusp', created_at: TS(30), last_post_at: TS(30), post_count: 1 };
    const middle = { thread_id: 'th-b', parent_kind: null, parent_ref: null, title: 'b', created_by: 'architect', harness_slug: 'papercusp', created_at: TS(20), last_post_at: TS(20), post_count: 1 };
    const newest = { thread_id: 'th-c', parent_kind: null, parent_ref: null, title: 'c', created_by: 'architect', harness_slug: 'papercusp', created_at: TS(10), last_post_at: TS(10), post_count: 1 };

    const before = composeUnifiedConversationRows({ deliberations: [oldest, middle, newest] }, 50);
    expect(before.map((row) => row.sourceId)).toEqual(['th-c', 'th-b', 'th-a']);

    // th-a gets a fresh reply and jumps to the front; th-b/th-c are untouched
    // and must keep their relative order (b before c) even though the array
    // position shifted underneath them.
    const afterOldestUpdated = { ...oldest, last_post_at: TS(0.1) };
    const after = composeUnifiedConversationRows({ deliberations: [afterOldestUpdated, middle, newest] }, 50);
    expect(after.map((row) => row.sourceId)).toEqual(['th-a', 'th-c', 'th-b']);
  });

  it('resolves to exactly the final selection after a rapid multi-source selection burst, never a stale cross-source flash', async () => {
    nuqsState.conv = 'threads';
    nuqsState.conversation = 'c-1'; // beforeEach fixture: "why does the watchdog recycle the host?"
    syncResults['conversations.deliberationList'] = ready([{
      thread_id: 'th-x', parent_kind: null, parent_ref: null, title: 'deliberation detail row',
      created_by: 'architect', harness_slug: 'papercusp', created_at: TS(2), last_post_at: TS(2), post_count: 1,
    }]);
    syncResults[syncKey('conversations.deliberationDetail', { id: 'th-x' })] = ready([{
      thread: { thread_id: 'th-x', title: 'deliberation detail row', parent_kind: null, parent_ref: null, created_by: null, harness_slug: null, created_at: TS(2), last_post_at: null, post_count: 1 },
      posts: [{ id: 1, author_id: 'architect', body: 'deliberation body', created_at: TS(2), harness_slug: null }],
    }]);
    syncResults['conversations.agentChatList'] = ready([{
      id: 'chat-x', harness_slug: 'papercusp', role: 'worker', feature_id: null, title: 'agent chat detail row',
      created_at: Date.now(), archived_at: Date.now(), total_input_tokens: 0, total_output_tokens: 0, total_cost_usd_cents: 0, turns: 1,
    }]);
    syncResults[syncKey('conversations.agentChatDetail', { id: 'chat-x' })] = ready([{
      id: 'chat-x', harness_slug: null, role: 'worker', feature_id: null, title: 'chat-x', created_at: Date.now(), archived_at: Date.now(),
      total_input_tokens: 0, total_output_tokens: 0, total_cost_usd_cents: 0, turns: 1, transcript: [{ role: 'assistant', content: 'chat body' }],
    }]);

    const { rerender } = render(<AdvConversationsTab />);
    expect(await screen.findByRole('heading', { name: 'why does the watchdog recycle the host?' })).toBeTruthy();

    // Rapid burst: thread -> deliberation -> agent chat -> back to thread,
    // without awaiting each detail query's settle — a user double/triple
    // clicking through the rail faster than a per-id fetch can resolve.
    nuqsState.conv = 'deliberations'; nuqsState.conversation = null; nuqsState.thread = 'th-x';
    rerender(<AdvConversationsTab />);
    nuqsState.conv = 'agentchats'; nuqsState.thread = null; nuqsState.chat = 'chat-x';
    rerender(<AdvConversationsTab />);
    nuqsState.conv = 'threads'; nuqsState.chat = null; nuqsState.conversation = 'c-1';
    rerender(<AdvConversationsTab />);

    expect(await screen.findByRole('heading', { name: 'why does the watchdog recycle the host?' })).toBeTruthy();
    expect(screen.queryByText('deliberation body')).toBeNull();
    expect(screen.queryByText('chat body')).toBeNull();
  });

  it('keeps the same DOM row node across repeated unrelated-source invalidations (no remount flash)', () => {
    const { rerender } = render(<AdvConversationsTab />);
    const before = screen.getByRole('button', { name: 'Open pick up the UI work' });
    for (let i = 0; i < 5; i += 1) {
      // A brand-new array reference each pass (as a real background refetch
      // hands back), for an UNRELATED source — the messages row's own data
      // never changes, so its DOM node (keyed by conversation identity) must
      // survive every invalidation rather than being torn down and remounted.
      syncResults['conversations.deliberationList'] = ready([{
        thread_id: `th-churn-${i}`, parent_kind: 'issue', parent_ref: `WI-${i}`, title: `churn ${i}`,
        created_by: 'architect', harness_slug: 'papercusp', created_at: TS(1), last_post_at: TS(1), post_count: 1,
      }]);
      rerender(<AdvConversationsTab />);
    }
    const after = screen.getByRole('button', { name: 'Open pick up the UI work' });
    expect(after).toBe(before);
  });

  it('a rapid selection burst never triggers a list refetch on any source (no request storm)', () => {
    const invalidateQuestions = vi.fn();
    const invalidateDeliberations = vi.fn();
    syncResults['conversations.questionsList'] = { ...(syncResults['conversations.questionsList'] as Record<string, unknown>), invalidate: invalidateQuestions };
    syncResults['conversations.deliberationList'] = { ...(syncResults['conversations.deliberationList'] as Record<string, unknown>), invalidate: invalidateDeliberations };

    const { rerender } = render(<AdvConversationsTab />);
    for (let i = 0; i < 10; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Open pick up the UI work' }));
      rerender(<AdvConversationsTab />);
    }

    expect(invalidateQuestions).not.toHaveBeenCalled();
    expect(invalidateDeliberations).not.toHaveBeenCalled();
  });
});

// ─── picker-kit adoption — the shared Create⇄Conversations visual vocabulary ──────
//
// adopt-picker-kit-in-conversations: the tab adopts the shared picker-kit
// primitives (EmptyState / ErrorBanner / Pill / inputStyle) so it looks + works
// like the Create flow. These pin the user-visible results of that adoption:
// standardized empty states, deep-linkable thread detail (nuqs `?conversation`),
// and the filter chips still toggling via aria-pressed.

describe('AdvConversationsTab — picker-kit adoption', () => {
  it('renders the shared EmptyState (icon + title + desc) for an empty unified view', () => {
    syncResults['conversations.questionsList'] = ready();
    syncResults['conversations.deliberationList'] = ready();
    syncResults['conversations.agentChatList'] = ready();
    syncResults['conversations.messageList'] = ready();
    render(<AdvConversationsTab />);
    expect(screen.getByText('No conversations')).toBeTruthy();
    expect(screen.getByText(/No curated communication is recorded/i)).toBeTruthy();
  });

  it('renders the shared EmptyState for the Raw events log when no traffic matches', () => {
    nuqsState.conv = 'feed';
    mockResult = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'SSE' };
    render(<AdvConversationsTab />);
    expect(screen.getByText('No matching traffic')).toBeTruthy();
    expect(screen.getByText(/broaden the search/i)).toBeTruthy();
  });

  // P2.5: the OPEN thread is fully driven by the nuqs `conversation` id, so a
  // refresh / pasted deep-link with `?conversation=<id>` reloads that thread.
  it('deep-links the open Q&A thread from the nuqs `conversation` id', async () => {
    nuqsState.conv = 'threads';
    nuqsState.conversation = 'c-1';
    stubComms({
      '/coordination/conversations/list': { conversations: [] },
      '/coordination/conversations/get': {
        conversation: {
          id: 'c-1',
          kind: 'question',
          state: 'open',
          scope: 'harness',
          harness_slug: 'papercup',
          title: 'why does the watchdog recycle the host?',
          body: 'it recycles roughly every 12 minutes',
          asker_id: 'oracle',
          accepted_answer: null,
          promoted_issue_id: null,
        },
        topics: ['infra'],
        posts: [{ id: 1, author_id: 'worker', body: 'looks like the watchdog threshold', created_ts: new Date().toISOString() }],
        subscriber_count: 2,
      },
    });
    render(<AdvConversationsTab />);
    // The detail pane loaded purely from the URL id — no list click needed.
    expect(await screen.findByText('it recycles roughly every 12 minutes')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /why does the watchdog recycle the host\?/i })).toBeTruthy();
    expect(screen.getByText('looks like the watchdog threshold')).toBeTruthy();
  });

  it('searches the unified projection and exposes the shared advanced filter bar', () => {
    nuqsState.cq = 'watchdog';
    const { container } = render(<AdvConversationsTab />);
    expect(screen.getByRole('searchbox', { name: 'Search conversations' })).toHaveProperty('value', 'watchdog');
    expect(screen.getByText('why does the watchdog recycle the host?')).toBeTruthy();
    expect(screen.queryByText('pick up the UI work')).toBeNull();
    expect(
      screen.getByText(
        '1 of 2 · the latest bounded conversation window (up to 100 per source)',
      ),
    ).toBeTruthy();
    // The shared filter bar renders as always-visible facet chip-groups
    // (layout="facets"), not the collapsed "Add filter…" combobox.
    const facetBar = container.querySelector('.pc-advpanel__filterbar--facets');
    expect(facetBar).toBeTruthy();
    expect(facetBar!.querySelectorAll('.pc-advpanel__chip').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Reset' })).toBeTruthy();
  });
});
