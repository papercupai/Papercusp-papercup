// @vitest-environment jsdom
/**
 * AgentsRunningPill — the workspace-wide "N agents running" header pill that
 * expands into a fleet-grouped, fleet-colored roster (agents-running-roster).
 * The advRoster.list sync query, nuqs, and LivenessDot are mocked so this
 * isolates the pill's count/guards + the pure grouping helpers. The shared
 * <Popover> needs a TooltipProvider ancestor (same as PotsRunningPill.test).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider as TooltipProvider } from '@radix-ui/react-tooltip';
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
import { lexiconFor } from '@papercusp/lexicon';
import { projectAdvRoster, type RosterSnapshot } from '@papercusp/operator-core/lib/sync-resolver/adv-roster-read';

const H = vi.hoisted(() => ({
  active: [] as unknown[],
  hasData: true,
  error: null as Error | null,
  failureCount: 0,
  queryOpts: null as Record<string, unknown> | null,
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: Record<string, unknown>) => {
    H.queryOpts = opts;
    return { data: H.hasData ? [{ active: H.active }] : [], error: H.error, failureCount: H.failureCount };
  },
  onSyncBusEvent: () => () => {},
}));
vi.mock('@/app/coord/presence-ui', () => ({
  LivenessDot: ({ liveness }: { liveness: string }) => <span data-testid={`dot-${liveness}`} />,
}));
vi.mock('@/app/harness/AgentInspectorModal', () => ({
  default: ({ runId, streamUrl }: { runId: string; streamUrl?: string }) => (
    <div data-testid="inspector-modal" data-run={runId} data-url={streamUrl} />
  ),
}));
vi.mock('@/app/harness/AgentThinkingStream', () => ({
  ThinkingDot: ({ title }: { title?: string }) => <span data-testid="thinking-dot" aria-label={title ?? 'thinking'} />,
}));

// EI-8821: this suite's own bare `parseAsString: {}` stub is exactly what let
// AgentsRunningPill.tsx wiring `parseAsString.withDefault('')` into an
// always-rendered path throw here (and 40 other tests) before the component
// switched to a plain `useQueryState(key)`. Parsers now come from the shared
// complete mock so that class of break can't recur.
//
// This mock must be KEY-AWARE, not a single shared value: the popover renders
// InactiveSessionsSection (WI-3881), whose "View inactive sessions" expander
// is its own independent `agentsInactiveOpen` nuqs key. A key-blind stub
// returning the SAME `[nuqs.open, nuqs.set]` for every key — as this used to
// — makes that expander's `expanded` collapse onto the pill's own open/closed
// state, so every test that opens the pill (`nuqs.open = true`) ALSO renders
// the inactive-sessions list expanded (and its uncontrolled `fetch()`),
// silently breaking assertions in totally unrelated tests (exactly the class
// of break this file's own comment above warns about). `agentsRoster` keeps
// its dedicated spy-friendly `nuqs.open`/`nuqs.set` (nothing here asserts on
// `nuqs.set` calls, but tests read/set `nuqs.open` directly); every other key
// gets its own independent, parser-defaulted slot.
const nuqs = vi.hoisted(() => ({ open: false, set: vi.fn() }));
const nuqsOther = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string, parser?: { defaultValue?: unknown }) => {
    if (key === 'agentsRoster') return [nuqs.open, nuqs.set];
    if (!(key in nuqsOther.state)) nuqsOther.state[key] = parser?.defaultValue ?? null;
    return [
      nuqsOther.state[key],
      (v: unknown) => {
        nuqsOther.state[key] = typeof v === 'function'
          ? (v as (prev: unknown) => unknown)(nuqsOther.state[key])
          : v;
        return Promise.resolve(true);
      },
    ];
  },
}));

import AgentsRunningPill, { groupByFleet, agentGlyph, shortOwner, displayName, hasThinking, isTranscriptFresh, thinkingStreamUrl, fmtCompactAge, activityLiveness, activityLivenessTitle, LIVE_TURN_MS, distinctMachineCount, machineKey, machineTabs, canFocusWindow, resumableSessionId, canForkSession, type RosterAgent } from './AgentsRunningPill';

function agent(over: Partial<RosterAgent> = {}): RosterAgent {
  return {
    ownerId: 'o1', label: 'a1', agent: 'a1', role: 'bee', intent: 'working', feature: null,
    currentPlanSlug: null, liveness: 'live', sessionState: 'live', heartbeatAt: '',
    fleetSlug: null, fleetColor: null, ...over,
  };
}

const Pill = () => (<TooltipProvider><AgentsRunningPill /></TooltipProvider>);

beforeEach(() => {
  H.hasData = true;
  H.error = null;
  H.failureCount = 0;
  H.active = [
    agent({ ownerId: 'q1', agent: 'queen', role: 'queen', fleetSlug: null }),
    agent({ ownerId: 'b1', agent: 'gizmo', role: 'bee', fleetSlug: 'atlas-fleet', fleetColor: '#d8b4fe', feature: 'F-1' }),
    agent({ ownerId: 'b2', agent: 'nova', role: 'bee', fleetSlug: 'atlas-fleet', fleetColor: '#d8b4fe', liveness: 'stale', sessionState: 'ended' }),
    agent({ ownerId: 's1', agent: 'sky', role: 'planner', fleetSlug: 'zzz-fleet', fleetColor: '#86efac' }),
  ];
  nuqs.open = false;
  nuqs.set = vi.fn();
  for (const key of Object.keys(nuqsOther.state)) delete nuqsOther.state[key];
});
afterEach(() => cleanup());

describe('groupByFleet (pure)', () => {
  it('groups by fleet, fleeted alphabetical, "No fleet" last', () => {
    const groups = groupByFleet([
      agent({ ownerId: 'x', fleetSlug: null }),
      agent({ ownerId: 'y', fleetSlug: 'zzz', fleetColor: '#111' }),
      agent({ ownerId: 'z', fleetSlug: 'aaa', fleetColor: '#222' }),
    ]);
    expect(groups.map((g) => g.slug)).toEqual(['aaa', 'zzz', null]);
    expect(groups[0].color).toBe('#222');
    expect(groups[2].color).toBe(null); // No-fleet group has no color
  });

  it('collects multiple agents into one fleet group', () => {
    const groups = groupByFleet([
      agent({ ownerId: 'a', fleetSlug: 'f', fleetColor: '#abc' }),
      agent({ ownerId: 'b', fleetSlug: 'f', fleetColor: '#abc' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].agents.map((a) => a.ownerId)).toEqual(['a', 'b']);
  });
});

describe('displayName / shortOwner (pure — the name fix)', () => {
  it('shortOwner shortens a long owner id, keeping the prefix', () => {
    expect(shortOwner('su-5577c5df-e2a2-49d2-85a7')).toMatch(/^su-5577/);
    expect(shortOwner('short-id')).toBe('short-id'); // already short → unchanged
  });
  it('displayName prefers the human label, never the agent type', () => {
    // A real label wins (even though agent='claude' would be the type).
    expect(displayName({ label: 'su · su-5577c', ownerId: 'su-5577c5df-e2a2' })).toBe('su · su-5577c');
    // No label → a short owner id, NOT the raw long id and NOT "claude".
    expect(displayName({ label: '', ownerId: 'su-5577c5df-e2a2-49d2' })).toMatch(/^su-5577/);
  });

  it('normalizes a generated legacy label when a display lexicon is supplied', () => {
    expect(displayName(
      { label: 'overwatch · papercusp/kettle', ownerId: 'overwatch-1' },
      lexiconFor('classic'),
    )).toBe('Kettle · papercusp/Kettle');
  });
});

describe('fmtCompactAge (pure — last-active pill)', () => {
  const base = Date.parse('2026-07-01T12:00:00Z');
  it('formats seconds/minutes/hours/days compactly', () => {
    expect(fmtCompactAge('2026-07-01T11:59:57Z', base)).toBe('3s');
    expect(fmtCompactAge('2026-07-01T11:58:00Z', base)).toBe('2m');
    expect(fmtCompactAge('2026-07-01T08:00:00Z', base)).toBe('4h');
    expect(fmtCompactAge('2026-06-29T12:00:00Z', base)).toBe('2d');
  });
  it('empty for missing/invalid; clamps a slightly-future ts to 0s', () => {
    expect(fmtCompactAge('', base)).toBe('');
    expect(fmtCompactAge(undefined, base)).toBe('');
    expect(fmtCompactAge('nonsense', base)).toBe('');
    expect(fmtCompactAge('2026-07-01T12:00:05Z', base)).toBe('0s');
  });
});

describe('canFocusWindow (pure — focus-button guard)', () => {
  it('true with a stored windowId (direct wmctrl target)', () => {
    expect(canFocusWindow({ windowId: '0x0185e0d2' })).toBe(true);
    expect(canFocusWindow({ windowId: '0x0185e0d2', advSessionId: null })).toBe(true);
  });
  it('true with an advSessionId even when windowId is unresolved — the focus endpoint resolves the window by adv row / [adv:<id>] title (owner ask 2026-07-11)', () => {
    expect(canFocusWindow({ windowId: null, advSessionId: 42 })).toBe(true);
    expect(canFocusWindow({ windowId: undefined, advSessionId: 7 })).toBe(true);
  });
  it('false when neither a windowId nor an advSessionId is present (pid alone is NOT enough — shared server pid)', () => {
    expect(canFocusWindow({ windowId: null, advSessionId: null })).toBe(false);
    expect(canFocusWindow({ windowId: null })).toBe(false);
    expect(canFocusWindow({ windowId: undefined })).toBe(false);
  });
});

describe('resumableSessionId (pure — Fork/Resume-button guard, WI-3882)', () => {
  it('claude: returns sessionId', () => {
    expect(resumableSessionId({ agent: 'claude', sessionId: 'sess-1', ompThreadId: null })).toBe('sess-1');
  });
  it('omp: returns ompThreadId when sessionId is absent', () => {
    expect(resumableSessionId({ agent: 'omp', sessionId: null, ompThreadId: 'thread-1' })).toBe('thread-1');
  });
  it('codex: always null — rollout resume is a different mechanism than `-r`', () => {
    expect(resumableSessionId({ agent: 'codex', sessionId: 'sess-1', ompThreadId: 'thread-1' })).toBeNull();
  });
  it('null when neither id is present', () => {
    expect(resumableSessionId({ agent: 'claude', sessionId: null, ompThreadId: null })).toBeNull();
  });
});

describe('canForkSession (pure — Fork-button backend guard, WI-4009; active+inactive 2026-07-11)', () => {
  it('claude: forkable (--fork-session)', () => {
    expect(canForkSession({ agent: 'claude' })).toBe(true);
  });
  it('omp: NOT forkable — no --fork-session support', () => {
    expect(canForkSession({ agent: 'omp' })).toBe(false);
  });
  it('codex: NOT forkable', () => {
    expect(canForkSession({ agent: 'codex' })).toBe(false);
  });
  it('null/unknown agent: NOT forkable (fail closed, never a dead Fork button)', () => {
    expect(canForkSession({ agent: null })).toBe(false);
  });
});

describe('agentGlyph (pure)', () => {
  // Owner 2026-07-12: the Mug takes the coffee-mug ☕ and the worker Cup the
  // teacup 🍵 — D-006 had these two swapped. Must match apps/tui
  // agent_pane_kind.rs `glyph()` and primitives.tsx AGENT_KIND_GLYPH.
  it('maps kind/role to the cup-cast glyph, · for unknown', () => {
    expect(agentGlyph({ agentPaneKind: 'queen', role: null })).toBe('☕');
    expect(agentGlyph({ agentPaneKind: null, role: 'bee' })).toBe('🍵');
    expect(agentGlyph({ agentPaneKind: null, role: 'sentinel' })).toBe('🥤');
    expect(agentGlyph({ agentPaneKind: null, role: 'overwatch' })).toBe('🫖');
    expect(agentGlyph({ agentPaneKind: null, role: 'mystery' })).toBe('·');
  });

  // The roster is MIXED-GENERATION (WI-2932): agentPaneKind may arrive as either
  // the pre-rename wire word or the renamed one. Both must render identically —
  // an alias that drifts shows two different glyphs for the same role in one list.
  it('renders the renamed kind ids identically to their pre-rename twins', () => {
    const glyph = (kind: string) => agentGlyph({ agentPaneKind: kind, role: null });
    expect(glyph('mug')).toBe(glyph('queen'));
    expect(glyph('kettle')).toBe(glyph('overwatch'));
    expect(glyph('cup')).toBe(glyph('bee'));
    expect(glyph('papercup')).toBe(glyph('sentinel'));
  });
});

describe('hasThinking (pure — WI-2680: transcript-resolvability veto)', () => {
  it('true for each real handle when resolvability is not vetoed', () => {
    expect(hasThinking({ runId: 'r1', harnessSlug: 'h' })).toBe(true); // bee run-log
    expect(hasThinking({ sessionId: 's1' })).toBe(true); // claude interactive
    expect(hasThinking({ agent: 'codex', advSessionId: 42 })).toBe(true); // codex rollout
    expect(hasThinking({ ompThreadId: 't1' })).toBe(true); // omp thread
  });

  it('false with no handle at all', () => {
    expect(hasThinking({ ownerId: 'su-x' } as never)).toBe(false);
    expect(hasThinking({ runId: 'r1' })).toBe(false); // runId needs harnessSlug
  });

  it('thinkingResolvable===false VETOES even a present claude session handle (the empty-pane fix)', () => {
    // A parked/ended claude agent whose transcript is gone: server stamped resolvable
    // false so the client offers the honest "unavailable" note, never an empty modal.
    expect(hasThinking({ sessionId: 's1', thinkingResolvable: false })).toBe(false);
    // The veto is unconditional across backends when explicitly false.
    expect(hasThinking({ runId: 'r1', harnessSlug: 'h', thinkingResolvable: false })).toBe(false);
  });

  it('resolvable true / undefined does NOT hide a working pane (no regression)', () => {
    expect(hasThinking({ sessionId: 's1', thinkingResolvable: true })).toBe(true);
    expect(hasThinking({ sessionId: 's1', thinkingResolvable: undefined })).toBe(true);
  });
});

describe('thinkingStreamUrl (pure — EI-16982: ended=1 for archive-rematerialize fallback)', () => {
  it('appends &ended=1 for a claude session the server stamped unresolvable (thinkingResolvable===false)', () => {
    const url = thinkingStreamUrl({ sessionId: 's1', thinkingResolvable: false });
    expect(url).toContain('/api/adv/session/thinking?sessionId=s1');
    expect(url).toContain('&ended=1');
  });

  it('does NOT append ended for a resolvable (true) or unknown (omitted/undefined) session — no regression', () => {
    expect(thinkingStreamUrl({ sessionId: 's1', thinkingResolvable: true })).not.toContain('ended=');
    expect(thinkingStreamUrl({ sessionId: 's1' })).not.toContain('ended=');
    expect(thinkingStreamUrl({ sessionId: 's1', thinkingResolvable: undefined })).not.toContain('ended=');
  });

  it('composes with the owner hint (both params present) when both are available', () => {
    const url = thinkingStreamUrl({ sessionId: 's1', ownerId: 'su-x', thinkingResolvable: false });
    expect(url).toBe('/api/adv/session/thinking?sessionId=s1&owner=su-x&ended=1');
  });

  it('thinkingResolvable is irrelevant to non-claude backends (bee run-log / codex / omp)', () => {
    expect(thinkingStreamUrl({ runId: 'r1', harnessSlug: 'h', thinkingResolvable: false })).not.toContain('ended=');
    expect(thinkingStreamUrl({ agent: 'codex', advSessionId: 42, thinkingResolvable: false })).not.toContain('ended=');
    expect(thinkingStreamUrl({ ompThreadId: 't1', thinkingResolvable: false })).not.toContain('ended=');
  });
});

describe('<AgentsRunningPill>', () => {
  it.each([false, true])('does not report zero while the roster is loading, open=%s', (open) => {
    H.hasData = false;
    nuqs.open = open;
    render(<Pill />);
    const pill = screen.getByTestId('agents-running-pill');
    expect(pill.textContent).toContain('Loading agents…');
    expect(pill.textContent).not.toContain('0 agents running');
    expect(pill.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('agents-running-empty')).toBeNull();
    if (open) expect(screen.getByTestId('agents-roster-status').textContent).toContain('Loading agents…');
  });

  it.each([false, true])('shows an unavailable roster instead of zero after a failed read, open=%s', (open) => {
    H.hasData = false;
    H.error = new Error('HTTP 500');
    nuqs.open = open;
    render(<Pill />);
    const pill = screen.getByTestId('agents-running-pill');
    expect(pill.textContent).toContain('Agents unavailable');
    expect(pill.textContent).not.toContain('0 agents running');
    expect(pill.getAttribute('aria-busy')).toBe('false');
    expect(screen.queryByTestId('agents-running-empty')).toBeNull();
    if (open) expect(screen.getByTestId('agents-roster-status').textContent).toContain('Agents unavailable');
  });

  it('exposes a failed initial attempt while the query is still retrying without a terminal error', () => {
    H.hasData = false;
    H.failureCount = 1;
    nuqs.open = true;
    render(<Pill />);
    expect(screen.getByTestId('agents-running-pill').textContent).toContain('Agents unavailable');
    expect(screen.getByTestId('agents-running-pill').getAttribute('aria-busy')).toBe('false');
    expect(screen.getByTestId('agents-roster-status').textContent).toContain('Agents unavailable');
    expect(screen.queryByTestId('agents-running-empty')).toBeNull();
  });

  it.each(['retrying', 'exhausted'])('marks retained counts as outdated during a %s refresh, then clears the warning on recovery', (phase) => {
    nuqs.open = true;
    H.error = phase === 'exhausted' ? new Error('HTTP 500') : null;
    H.failureCount = 1;
    const view = render(<Pill />);
    expect(screen.getByTestId('agents-running-pill').textContent).toContain('3 agents running');
    expect(screen.getByTestId('agents-running-pill').textContent).toContain('update failed');
    expect(screen.getByText('Could not refresh agents. Showing the last loaded roster.')).toBeTruthy();
    H.error = null;
    H.failureCount = 0;
    view.rerender(<Pill />);
    expect(screen.getByTestId('agents-running-pill').textContent).not.toContain('update failed');
    expect(screen.queryByText('Could not refresh agents. Showing the last loaded roster.')).toBeNull();
  });

  it('reports a measured zero only after a successful empty response replaces a failed initial read', () => {
    H.hasData = false;
    H.error = new Error('HTTP 500');
    nuqs.open = true;
    const view = render(<Pill />);
    expect(screen.getByTestId('agents-running-pill').textContent).toContain('Agents unavailable');
    H.hasData = true;
    H.error = null;
    H.active = [];
    view.rerender(<Pill />);
    expect(screen.getByTestId('agents-running-pill').textContent).toContain('0 agents running');
    expect(screen.getByTestId('agents-running-empty').textContent).toContain('No agents running');
    expect(screen.queryByTestId('agents-roster-status')).toBeNull();
  });

  it('refreshes lifecycle-derived thinking between database invalidations', () => {
    render(<Pill />);
    expect(H.queryOpts).toMatchObject({
      queryName: 'advRoster.list',
      pollIntervalMs: 5_000,
      args: { workspaceId: null, endedLimit: 50, view: 'header' },
    });
  });

  it('loads the full roster when opened and returns to the compact badge read when closed', () => {
    const view = render(<Pill />);
    expect(H.queryOpts?.args).toMatchObject({ view: 'header' });
    nuqs.open = true;
    view.rerender(<Pill />);
    expect(H.queryOpts?.args).toEqual({ workspaceId: null, endedLimit: 50 });
    nuqs.open = false;
    view.rerender(<Pill />);
    expect(H.queryOpts?.args).toMatchObject({ view: 'header' });
  });

  // [owner 2026-09-15] "if there are no agents running the pill disappears
  // entirely it should instead say 0 agents running" — the pill used to
  // `return null` at zero, which read as a missing feature during the post-boot
  // hydration window (WI-37363).
  it('stays mounted at zero and reads "0 agents running", without the is-running state class', () => {
    H.active = [agent({ liveness: 'live', sessionState: 'ended', loopArmed: true })];
    render(<Pill />);
    const pill = screen.getByTestId('agents-running-pill');
    expect(pill.textContent).toContain('0 agents running');
    expect(pill.classList.contains('is-running')).toBe(false);
  });

  it('at zero, the popover shows an honest empty note instead of a blank roster', () => {
    H.active = [agent({ liveness: 'live', sessionState: null })];
    nuqs.open = true;
    render(<Pill />);
    expect(screen.getByTestId('agents-running-empty').textContent).toContain('No agents running');
  });

  // EI-23336692339406030 [owner 2026-09-15]: now that the pill stays mounted at
  // zero, the `is-running` class must actually LOOK different, and its styles must
  // live in the SHARED sheet (quick-panel-status-pills D-001) so the Quick Panel
  // popup — which never mounts AdvShell — renders the same state. Pin the rule
  // set, and pin the ring's survival of AdvShell's body `box-shadow: none`
  // reset (the pots pill lost its ring to exactly that flattening).
  it('carries a shared-sheet running-state style for the is-running class', () => {
    const css = readFileSync(
      resolve(__dirname, 'adv-header-pills.css'),
      'utf8',
    );
    expect(css).toMatch(/\.pc-advshell__action--agents\s*{[^}]*color:\s*var\(--fg-mute\)/s);
    expect(css).toMatch(/\.pc-advshell__action--agents\.is-running\s*{[^}]*color:\s*var\(--good\)/s);
    expect(css).toMatch(
      /\.pc-advshell__action--agents\.is-running:not\(:focus-visible\)\s*{[^}]*box-shadow:[^}]*!important/s,
    );
  });

  it.each([false, true])('distinguishes living sessions from ongoing turns with the roster open=%s', (open) => {
    nuqs.open = open;
    const live = Array.from({ length: 120 }, (_, i) => agent({
      ownerId: `live-${i}`, agent: ['claude', 'codex', 'omp'][i % 3],
      transcriptFresh: i < 20, thinkingResolvable: i < 20,
      machineLabel: i % 2 ? 'remote' : 'desktop', isLocal: i % 2 === 0,
    }));
    const betweenTurns = Array.from({ length: 80 }, (_, i) => agent({
      ownerId: `idle-${i}`, agent: ['claude', 'codex', 'omp'][i % 3],
      sessionState: i % 2 ? 'parked' : 'recorded', liveness: 'stale', loopArmed: false,
      transcriptFresh: true,
    }));
    const active = [...live, ...betweenTurns, ...['draining', 'suspect', 'ended'].map(
      (sessionState) => agent({ ownerId: sessionState, sessionState, transcriptFresh: true, loopArmed: true }),
    ), agent({ ownerId: 'unknown', sessionState: null, transcriptFresh: true })];
    H.active = projectAdvRoster({ active } as RosterSnapshot, open ? 'full' : 'header').active;
    // Control: the old gauge reports exactly the misleading twenty, even
    // though the authoritative roster has 120 ongoing turns across backends.
    expect(live.filter(isTranscriptFresh)).toHaveLength(20);
    render(<Pill />);
    expect(screen.getByTestId('agents-running-pill').textContent).toContain('200 agents running');
    expect(screen.getByTestId('agents-thinking-count').textContent).toContain('120 thinking');
  });

  it('updates the count when a turn parks or ends despite recent transcript output', () => {
    H.active = [agent({ ownerId: 'a1', transcriptFresh: false }), agent({ ownerId: 'a2', transcriptFresh: false })];
    const view = render(<Pill />);
    expect(screen.getByTestId('agents-thinking-count').textContent).toContain('2 thinking');
    H.active = [agent({ ownerId: 'a1', sessionState: 'parked', transcriptFresh: true }),
      agent({ ownerId: 'a2', transcriptFresh: false })];
    view.rerender(<Pill />);
    expect(screen.getByTestId('agents-running-pill').textContent).toContain('2 agents running');
    expect(screen.getByTestId('agents-thinking-count').textContent).toContain('1 thinking');
    H.active = [agent({ ownerId: 'a1', sessionState: 'parked', liveness: 'stale' }),
      agent({ ownerId: 'a2', sessionState: 'recorded', liveness: 'stale' })];
    view.rerender(<Pill />);
    expect(screen.getByTestId('agents-running-pill').textContent).toContain('2 agents running');
    expect(screen.queryByTestId('agents-thinking-count')).toBeNull();
    H.active = [agent({ sessionState: 'ended', transcriptFresh: true })];
    view.rerender(<Pill />);
    expect(screen.getByTestId('agents-running-pill').textContent).toContain('0 agents running');
    expect(screen.queryByTestId('agents-thinking-count')).toBeNull();
  });

  it('renders a pulsing thinking dot on an actively-thinking row', () => {
    H.active = [agent({ ownerId: 'a1', transcriptFresh: false, thinkingResolvable: false })];
    nuqs.open = true;
    render(<Pill />);
    expect(screen.getAllByTestId('thinking-dot').length).toBeGreaterThan(0);
  });

  it('prefers transcriptFresh but accepts the deprecated thinking alias during payload skew', () => {
    expect(isTranscriptFresh({ transcriptFresh: false, thinking: true })).toBe(false);
    expect(isTranscriptFresh({ thinking: true })).toBe(true);
  });

  it('shows a compact last-active pill next to the liveness dot', () => {
    H.active = [agent({ ownerId: 'a1', heartbeatAt: new Date(Date.now() - 5_000).toISOString() })];
    nuqs.open = true;
    render(<Pill />);
    const row = screen.getByTestId('agent-row-a1');
    expect(row.querySelector('.pc-agents-roster__age')?.textContent).toMatch(/^\d+s$/);
  });

  it('uses authoritative sessionState for membership, regardless of heartbeat or loop state', () => {
    H.active = [
      agent({ ownerId: 'live-stale-heartbeat', liveness: 'stale', sessionState: 'live' }),
      agent({ ownerId: 'parked-fresh-heartbeat', liveness: 'live', sessionState: 'parked' }),
      agent({ ownerId: 'ended-loop', liveness: 'live', loopArmed: true, sessionState: 'ended' }),
    ];
    render(<Pill />);
    const pill = screen.getByTestId('agents-running-pill');
    expect(pill.textContent).toContain('2 agents running');
    expect(screen.getByTestId('agents-thinking-count').textContent).toContain('1 thinking');
  });

  it('opens the fleet-grouped roster popover with headers + rows', () => {
    nuqs.open = true;
    render(<Pill />);
    expect(screen.getByTestId('agents-running-pop')).toBeTruthy();
    // Fleet headers (alpha; No fleet last).
    expect(screen.getByText(/atlas-fleet/)).toBeTruthy();
    expect(screen.getByText(/zzz-fleet/)).toBeTruthy();
    expect(screen.getByText(/No fleet/)).toBeTruthy();
    // Rows for the running agents.
    expect(screen.getByTestId('agent-row-b1')).toBeTruthy();
    expect(screen.getByTestId('agent-row-q1')).toBeTruthy();
  });

  // OWNER-REPORTED REGRESSION 2026-07-12: the kind legend was rendered straight from
  // `Object.entries(KIND_GLYPH)`, so it printed the INTERNAL pane-kind ids at the owner
  // — "🍵 queen · 🫖 overwatch · ☕ bee · 🥤 sentinel". The cast words must come from the
  // lexicon (mug/kettle/cup/papercup), exactly as AdvAgentsPanel's kindLegend already did.
  it('the kind legend speaks the LEXICON cast words, never the raw wire kinds', () => {
    nuqs.open = true;
    render(<Pill />);
    const legend = document.querySelector('.pc-agents-roster__legend');
    expect(legend).toBeTruthy();
    const text = legend!.textContent ?? '';

    // The cast, in the owner-facing vocabulary.
    for (const word of ['mug', 'kettle', 'cup', 'papercup', 'planner', 'su']) {
      expect(text.toLowerCase()).toContain(word);
    }
    // ...and NONE of the retired internal vocabulary leaks through.
    for (const dead of ['queen', 'overwatch', 'bee', 'sentinel']) {
      expect(text.toLowerCase()).not.toContain(dead);
    }
    // The Mug carries the coffee-mug; the worker Cup carries the teacup.
    expect(text).toContain('☕');
    expect(text).toContain('🍵');
  });

  it('hovering an agent row previews its plan/work-item in the detail strip', () => {
    nuqs.open = true;
    render(<Pill />);
    fireEvent.mouseEnter(screen.getByTestId('agent-row-b1'));
    const detail = screen.getByTestId('agent-detail');
    expect(detail.textContent).toContain('gizmo');
    expect(detail.textContent).toContain('F-1'); // its work item
  });

  it('keeps the detail strip mounted before hover and after leaving the roster', () => {
    nuqs.open = true;
    render(<Pill />);

    // A stable default is visible immediately, so the area above inactive
    // sessions never collapses while push-driven roster data refreshes.
    expect(screen.getByTestId('agent-detail')).toBeTruthy();

    fireEvent.mouseEnter(screen.getByTestId('agent-row-b1'));
    expect(screen.getByTestId('agent-detail').textContent).toContain('F-1');
    fireEvent.mouseLeave(screen.getByTestId('agents-roster'));

    // Moving toward the detail/inactive-session controls retains the last
    // preview instead of making the section disappear and reappear.
    expect(screen.getByTestId('agent-detail').textContent).toContain('F-1');
  });

  it('keeps the detail strip mounted when the previewed agent drops out of a live-roster refresh (WI-3881)', () => {
    nuqs.open = true;
    const { rerender } = render(<Pill />);

    // Preview a specific agent — the strip now tracks it.
    fireEvent.mouseEnter(screen.getByTestId('agent-row-b1'));
    expect(screen.getByTestId('agent-detail').textContent).toContain('gizmo');

    // A push-driven refresh where that agent's heartbeat aged to 'stale', so it
    // is filtered out of the running roster (and thus out of the strip's
    // previewed selection). Before the sticky-fallback fix this collapsed
    // `active` to null and the strip disappeared until the next push.
    H.active = [
      agent({ ownerId: 'q1', agent: 'queen', role: 'queen', fleetSlug: null }),
      agent({ ownerId: 'b2', agent: 'nova', role: 'bee', fleetSlug: 'atlas-fleet', fleetColor: '#d8b4fe', liveness: 'live', feature: 'F-9' }),
    ];
    rerender(<Pill />);

    // The strip must NOT vanish — it stays mounted, falling back to a still-present
    // agent instead of blanking (the disappear/reappear bug).
    expect(screen.getByTestId('agent-detail')).toBeTruthy();
  });

  it('clicking an agent row pins it', () => {
    nuqs.open = true;
    render(<Pill />);
    fireEvent.click(screen.getByTestId('agent-row-q1'));
    expect(screen.getByTestId('agent-detail').textContent).toContain('pinned');
  });

  it('the hover preview (and its inspect button) stays reachable after leaving the roster', () => {
    // Superseded expectation, WI-EI-9256: the roster used to dismiss the preview
    // on mouseleave, but that made the detail strip (and the inactive-sessions
    // section right below it) blink out while the user moved the cursor toward
    // it — see the "Keep the most recently previewed agent selected" comment on
    // AgentsRoster. There is now no onMouseLeave handler at all: hovering a row
    // sets the preview and it stays mounted (falling back to the first agent),
    // so moving from a row into the detail pane to click its button never loses
    // the preview.
    H.active = [agent({ ownerId: 'bee1', role: 'bee', runId: 'r1', harnessSlug: 'papercusp' })];
    nuqs.open = true;
    render(<Pill />);
    fireEvent.mouseEnter(screen.getByTestId('agent-row-bee1'));
    expect(screen.getByTestId('agent-detail')).toBeTruthy();
    expect(screen.getByTestId('agent-inspect-btn')).toBeTruthy();
    fireEvent.mouseLeave(screen.getByTestId('agents-roster'));
    expect(screen.getByTestId('agent-detail')).toBeTruthy();
    expect(screen.getByTestId('agent-inspect-btn')).toBeTruthy();
  });

  it('shows a Live-thinking action ONLY for an agent with a resolvable run (guarded — no dead button)', () => {
    H.active = [
      agent({ ownerId: 'bee1', role: 'bee', runId: 'launch-123', harnessSlug: 'papercusp' }),
      agent({ ownerId: 'su1', role: 'su' }), // no runId → no action
    ];
    nuqs.open = true;
    render(<Pill />);
    fireEvent.mouseEnter(screen.getByTestId('agent-row-bee1'));
    expect(screen.getByTestId('agent-inspect-btn')).toBeTruthy();
    fireEvent.mouseEnter(screen.getByTestId('agent-row-su1'));
    expect(screen.queryByTestId('agent-inspect-btn')).toBeNull();
  });

  it('an agent WITHOUT any thinking source shows an explicit unavailable note (not a silently-inert row)', () => {
    // A presence-only process with no session row / run-log / thread id — the
    // pane can't stream it. The detail strip must SAY so, so "clicking does
    // nothing" reads as a known limitation, not a broken pane.
    H.active = [agent({ ownerId: 'qx1', role: 'queen', agent: 'codex', runId: null, harnessSlug: null, sessionId: null })];
    nuqs.open = true;
    render(<Pill />);
    fireEvent.mouseEnter(screen.getByTestId('agent-row-qx1'));
    const note = screen.getByTestId('agent-no-thinking-note');
    expect(note.textContent).toContain('Live thinking unavailable');
    expect(note.textContent).toContain('codex');
    expect(screen.queryByTestId('agent-inspect-btn')).toBeNull();
  });

  it('WI-2680: a claude session WHOSE TRANSCRIPT DOESN\'T RESOLVE (thinkingResolvable:false) shows the honest note, not an empty inspector', () => {
    // The reported bug: parked/ended backlog-clearance agents (loop-armed, transcript
    // gone) sort to the top of the roster; clicking one opened an EMPTY pane. The server
    // now stamps thinkingResolvable:false; the client must offer the honest note and
    // NEVER open the (empty) inspector modal.
    H.active = [agent({ ownerId: 'zx1', role: 'su', agent: 'claude', sessionId: 'stale-sess-abc', runId: null, harnessSlug: null, thinkingResolvable: false })];
    nuqs.open = true;
    render(<Pill />);
    fireEvent.mouseEnter(screen.getByTestId('agent-row-zx1'));
    const note = screen.getByTestId('agent-no-thinking-note');
    expect(note.textContent).toContain('Live thinking unavailable');
    expect(note.textContent).toMatch(/ended|rotated away/); // the accurate "gone transcript" copy, not "no handle"
    expect(screen.queryByTestId('agent-inspect-btn')).toBeNull();
    // Clicking the row must NOT open the empty inspector.
    fireEvent.click(screen.getByTestId('agent-row-zx1'));
    expect(screen.queryByTestId('inspector-modal')).toBeNull();
  });

  it('WI-2680: a claude session WITH a resolvable transcript (thinkingResolvable:true) still opens the inspector (no regression)', () => {
    H.active = [agent({ ownerId: 'lv1', role: 'su', agent: 'claude', sessionId: 'live-sess-xyz', runId: null, harnessSlug: null, thinkingResolvable: true })];
    nuqs.open = true;
    render(<Pill />);
    fireEvent.click(screen.getByTestId('agent-row-lv1'));
    const modal = screen.getByTestId('inspector-modal');
    expect(modal.getAttribute('data-url')).toContain('/api/adv/session/thinking?sessionId=live-sess-xyz');
  });

  it('opens the canonical inspector from the portal agentsInspect deep-link', async () => {
    H.active = [agent({ ownerId: 'portal-agent', role: 'su', agent: 'claude', sessionId: 'portal-session', thinkingResolvable: true })];
    nuqs.open = true;
    nuqsOther.state.agentsInspect = 'portal-agent';
    render(<Pill />);
    await waitFor(() => expect(screen.getByTestId('inspector-modal')).toBeTruthy());
    expect(screen.getByTestId('inspector-modal').getAttribute('data-url'))
      .toContain('/api/adv/session/thinking?sessionId=portal-session');
  });

  it('a CODEX session (adv row id, no claude sessionId) streams via codexSessionKey', () => {
    H.active = [agent({ ownerId: 'cq1', role: 'queen', agent: 'codex', advSessionId: 9444, runId: null, harnessSlug: null, sessionId: null })];
    nuqs.open = true;
    render(<Pill />);
    fireEvent.click(screen.getByTestId('agent-row-cq1'));
    const modal = screen.getByTestId('inspector-modal');
    expect(modal.getAttribute('data-url')).toBe('/api/adv/session/thinking?codexSessionKey=9444');
  });

  it('an OMP session (thread id) streams via ompThreadId', () => {
    H.active = [agent({ ownerId: 'om1', role: 'su', agent: 'omp', ompThreadId: '019f1de3-19b8-7000-90a3-a36f8c343ac6', runId: null, harnessSlug: null, sessionId: null })];
    nuqs.open = true;
    render(<Pill />);
    fireEvent.click(screen.getByTestId('agent-row-om1'));
    const modal = screen.getByTestId('inspector-modal');
    expect(modal.getAttribute('data-url')).toBe('/api/adv/session/thinking?ompThreadId=019f1de3-19b8-7000-90a3-a36f8c343ac6');
  });

  it('clicking Live thinking opens the inspector for that run', () => {
    H.active = [agent({ ownerId: 'bee1', role: 'bee', runId: 'launch-xyz', harnessSlug: 'papercusp' })];
    nuqs.open = true;
    render(<Pill />);
    fireEvent.mouseEnter(screen.getByTestId('agent-row-bee1'));
    fireEvent.click(screen.getByTestId('agent-inspect-btn'));
    expect(screen.getByTestId('inspector-modal').getAttribute('data-run')).toBe('launch-xyz');
  });

  it('an INTERACTIVE session (sessionId, no run) also gets thinking → the transcript stream', () => {
    H.active = [agent({ ownerId: 'q1', role: 'queen', sessionId: 'sess-abc', runId: null, harnessSlug: null })];
    nuqs.open = true;
    render(<Pill />);
    // Row click opens the inspector pointed at the session-transcript endpoint.
    fireEvent.click(screen.getByTestId('agent-row-q1'));
    const modal = screen.getByTestId('inspector-modal');
    expect(modal.getAttribute('data-run')).toBe('sess-abc');
    const url = modal.getAttribute('data-url') ?? '';
    expect(url).toContain('/api/adv/session/thinking?sessionId=sess-abc');
    // The owner hint lets the backend jump straight to the session's isolation
    // dir instead of sweeping all of them (the ~3s → ms fix).
    expect(url).toContain('&owner=q1');
  });

  it('clicking the ROW opens thinking for an agent with a run; pins for one without', () => {
    H.active = [
      agent({ ownerId: 'bee1', role: 'bee', runId: 'launch-row', harnessSlug: 'papercusp' }),
      agent({ ownerId: 'su1', role: 'su' }), // no run → pin, no inspector
    ];
    nuqs.open = true;
    render(<Pill />);
    // Clicking the bee row opens the inspector directly (the user's "click → thinking").
    fireEvent.click(screen.getByTestId('agent-row-bee1'));
    expect(screen.getByTestId('inspector-modal').getAttribute('data-run')).toBe('launch-row');
    // Clicking a run-less agent pins its detail instead (no inspector).
    fireEvent.click(screen.getByTestId('agent-row-su1'));
    expect(screen.getByTestId('agent-detail').textContent).toContain('pinned');
  });
});

describe('activityLiveness (pure — displayed liveness from GENUINE activity, not keepalive or armed loop; owner 2026-07-17)', () => {
  const NOW = Date.parse('2026-07-01T12:00:00Z');
  const mk = (o: Partial<RosterAgent>): Pick<RosterAgent, 'lastActiveAt' | 'loopArmed'> => ({
    lastActiveAt: null,
    loopArmed: false,
    ...o,
  });

  it('live when a turn happened within the last minute', () => {
    expect(activityLiveness(mk({ lastActiveAt: new Date(NOW - 30_000).toISOString() }), NOW)).toBe('live');
  });

  it('idle when the last turn is 1–10 minutes old', () => {
    expect(activityLiveness(mk({ lastActiveAt: new Date(NOW - 120_000).toISOString() }), NOW)).toBe('idle');
    expect(activityLiveness(mk({ lastActiveAt: new Date(NOW - (LIVE_TURN_MS - 1_000)).toISOString() }), NOW)).toBe('idle');
  });

  it('stale when the last turn is older than 10 minutes', () => {
    expect(activityLiveness(mk({ lastActiveAt: new Date(NOW - (LIVE_TURN_MS + 1_000)).toISOString() }), NOW)).toBe('stale');
  });

  it('an ARMED LOOP does NOT force live — a loop-armed session whose last turn is hours stale reads stale (the owner-reported bug: "it thought you were still live even though you didn\'t have a turn in a few hours")', () => {
    // Healthy loop: fresh activity ⇒ live/idle from the activity alone (no loop rescue needed).
    expect(activityLiveness(mk({ loopArmed: true, lastActiveAt: new Date(NOW - 30_000).toISOString() }), NOW)).toBe('live');
    // Dead/killed loop: armed but not firing ⇒ stale, NOT a false "live".
    expect(activityLiveness(mk({ loopArmed: true, lastActiveAt: new Date(NOW - 3_600_000).toISOString() }), NOW)).toBe('stale');
    expect(activityLiveness(mk({ loopArmed: true, lastActiveAt: null }), NOW)).toBe('stale');
  });

  it('stale with no activity stamp (does NOT fall back to the keepalive heartbeat)', () => {
    expect(activityLiveness(mk({ lastActiveAt: null }), NOW)).toBe('stale');
  });

  it('stale for an unparseable lastActiveAt', () => {
    expect(activityLiveness(mk({ lastActiveAt: 'not-a-date' }), NOW)).toBe('stale');
  });

  it('activityLivenessTitle: a stalled armed loop is called out as "loop armed but not firing"', () => {
    expect(activityLivenessTitle(mk({ loopArmed: true, lastActiveAt: new Date(NOW - 3_600_000).toISOString() }), NOW))
      .toContain('loop armed but not firing');
    expect(activityLivenessTitle(mk({ loopArmed: true, lastActiveAt: new Date(NOW - 30_000).toISOString() }), NOW))
      .toContain('live');
  });
});

describe('machine grouping (shared-hive per-machine tabs)', () => {
  const a = (o: Partial<RosterAgent>): RosterAgent =>
    ({ ownerId: 'x', label: 'x', agent: null, role: null, intent: '', feature: null, currentPlanSlug: null, liveness: 'live', heartbeatAt: '', ...o }) as RosterAgent;

  it('distinctMachineCount counts local + each remote machine', () => {
    expect(distinctMachineCount([
      a({ isLocal: true, machineLabel: 'boxA' }),
      a({ isLocal: true, machineLabel: 'boxA' }),
      a({ isLocal: false, machineLabel: 'boxB' }),
      a({ isLocal: false, machineLabel: 'boxC' }),
    ])).toBe(3);
  });

  it('machineKey buckets unlabeled local vs remote rows', () => {
    expect(machineKey(a({ isLocal: true }))).toBe('__local__');
    expect(machineKey(a({ isLocal: false }))).toBe('__remote__');
    expect(machineKey(a({ machineLabel: 'boxB', isLocal: false }))).toBe('boxB');
  });

  it('machineTabs puts Local first, then remotes alphabetical, with counts', () => {
    const tabs = machineTabs([
      a({ isLocal: false, machineLabel: 'zeta' }),
      a({ isLocal: true, machineLabel: 'boxA' }),
      a({ isLocal: false, machineLabel: 'alpha' }),
      a({ isLocal: false, machineLabel: 'alpha' }),
    ]);
    expect(tabs.map((t) => t.label)).toEqual(['Local', 'alpha', 'zeta']);
    expect(tabs[0].isLocal).toBe(true);
    expect(tabs.find((t) => t.label === 'alpha')?.count).toBe(2);
  });
});

// ── Multi-select + bulk actions in the roster (owner ask 2026-07-11) ─────────
describe('AgentsRoster — multi-select + bulk actions', () => {
  // Two windowed agents (advSessionId ⇒ focusable/killable) + one headless.
  function seed() {
    H.active = [
      agent({ ownerId: 'w1', label: 'w1', agent: 'claude', advSessionId: 11, windowId: '0xa1' }),
      agent({ ownerId: 'w2', label: 'w2', agent: 'omp', advSessionId: 12 }),
      agent({ ownerId: 'h3', label: 'h3', agent: 'gizmo' }), // no window handle
    ];
    nuqs.open = true;
  }
  function stubFetch(impl?: (url: string, init: RequestInit) => unknown) {
    const spy = vi.fn().mockImplementation((url: string, init: RequestInit) =>
      Promise.resolve(impl?.(url, init) ?? { ok: true, status: 200, json: () => Promise.resolve({ status: 'ok' }) }),
    );
    vi.stubGlobal('fetch', spy);
    return spy;
  }
  afterEach(() => vi.unstubAllGlobals());

  it('shows no bulk bar until a row is selected, then reports the count', () => {
    seed();
    render(<Pill />);
    expect(screen.queryByTestId('agents-bulk-bar')).toBeNull();
    fireEvent.click(screen.getByTestId('agent-select-w1'));
    expect(screen.getByTestId('agents-bulk-bar')).toBeTruthy();
    expect(screen.getByTestId('agents-bulk-count').textContent).toBe('1 selected');
    fireEvent.click(screen.getByTestId('agent-select-w2'));
    expect(screen.getByTestId('agents-bulk-count').textContent).toBe('2 selected');
  });

  it('ticking a row checkbox selects it WITHOUT opening the inspector', () => {
    H.active = [agent({ ownerId: 'w1', agent: 'claude', sessionId: 'sid-1', advSessionId: 11 })];
    nuqs.open = true;
    render(<Pill />);
    fireEvent.click(screen.getByTestId('agent-select-w1'));
    // selected (bar shows) but the inspector modal did NOT open
    expect(screen.getByTestId('agents-bulk-bar')).toBeTruthy();
    expect(screen.queryByTestId('inspector-modal')).toBeNull();
  });

  it('Message → compose → Send POSTs coord/send to all selected ownerIds (text/plain)', async () => {
    seed();
    const spy = stubFetch();
    render(<Pill />);
    fireEvent.click(screen.getByTestId('agent-select-w1'));
    fireEvent.click(screen.getByTestId('agent-select-w2'));
    fireEvent.click(screen.getByTestId('agents-bulk-message'));
    fireEvent.change(screen.getByTestId('agents-bulk-msg'), { target: { value: 'standup in 5' } });
    fireEvent.click(screen.getByTestId('agents-bulk-msg-send'));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('/api/admin/coord/send');
    expect(init.headers['content-type']).toBe('text/plain');
    expect(JSON.parse(init.body)).toEqual({ to: ['w1', 'w2'], summary: 'standup in 5', body: 'standup in 5' });
    await screen.findByText(/Sent to 2/);
  });

  it('Wake POSTs coord/send with wake:required to the selected', async () => {
    seed();
    const spy = stubFetch();
    render(<Pill />);
    fireEvent.click(screen.getByTestId('agent-select-w1'));
    fireEvent.click(screen.getByTestId('agents-bulk-wake'));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('/api/admin/coord/send');
    const body = JSON.parse(init.body);
    expect(body.to).toEqual(['w1']);
    expect(body.wake).toBe('required');
    await screen.findByText(/Nudged 1/);
  });

  it('Focus all POSTs to the focus endpoint once per WINDOWED selected agent (skips headless)', async () => {
    seed();
    const spy = stubFetch();
    render(<Pill />);
    fireEvent.click(screen.getByTestId('agent-select-w1'));
    fireEvent.click(screen.getByTestId('agent-select-h3')); // headless — no window
    fireEvent.click(screen.getByTestId('agents-bulk-focus'));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1)); // only w1
    expect(spy.mock.calls[0][0]).toBe('/api/adv/sessions/focus');
    expect(JSON.parse(spy.mock.calls[0][1].body).id).toBe(11);
    await screen.findByText(/Focused 1\/1/);
  });

  it('Kill is confirm-armed: first click arms (no request), second closes the windows', async () => {
    seed();
    const spy = stubFetch();
    render(<Pill />);
    fireEvent.click(screen.getByTestId('agent-select-w1'));
    fireEvent.click(screen.getByTestId('agent-select-w2'));
    const kill = screen.getByTestId('agents-bulk-kill');
    // 1st click: arm only, no request fired
    fireEvent.click(kill);
    expect(spy).not.toHaveBeenCalled();
    expect(kill.textContent).toMatch(/Confirm kill 2/);
    // 2nd click: fire close-window for each windowed agent
    fireEvent.click(kill);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls.every((c) => c[0] === '/api/adv/sessions/close-window')).toBe(true);
    // selection cleared afterward ⇒ bar gone
    await waitFor(() => expect(screen.queryByTestId('agents-bulk-bar')).toBeNull());
  });

  it('Copy ids writes the selected owner ids to the clipboard', async () => {
    seed();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<Pill />);
    fireEvent.click(screen.getByTestId('agent-select-w1'));
    fireEvent.click(screen.getByTestId('agent-select-w2'));
    fireEvent.click(screen.getByTestId('agents-bulk-copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('w1\nw2'));
    await screen.findByText(/Copied 2 ids/);
  });

  it('Select all / Clear toggle the whole shown roster', () => {
    seed();
    render(<Pill />);
    // Seed one selection so the bar (with Select all) is visible.
    fireEvent.click(screen.getByTestId('agent-select-w1'));
    fireEvent.click(screen.getByTestId('agents-bulk-selectall'));
    expect(screen.getByTestId('agents-bulk-count').textContent).toBe('3 selected');
    fireEvent.click(screen.getByTestId('agents-bulk-clear'));
    expect(screen.queryByTestId('agents-bulk-bar')).toBeNull();
  });
});

/* ── Instant id matches (WI-37204, owner ask 2026-08-08) ────────────────────
   At >=2 chars this popover REPLACES the roster with the server's transcript
   search, which searches turn TEXT — so an id query used to answer NOTHING
   (measured live pre-fix: `?q=su-bc38a419` → totalHits 0, sessions []). The
   answer for a LIVE agent is already in this component's roster payload, so it
   is resolved here on the keystroke and the server's pass (which additionally
   reaches ENDED sessions) merges in behind it. */
describe('instant id matches (WI-37204)', () => {
  const SU = 'su-bc38a419-8dc6-4040-a63e-2dc0515e42be';
  const SID = '073c5a1e-d280-4c37-866c-fedcaf096c9e';

  const openWithQuery = (q: string) => {
    nuqs.open = true;
    nuqsOther.state.agentsQ = q;
    // The server leg is irrelevant to these assertions — a never-settling fetch
    // proves what renders came from the ROSTER, not from a round-trip.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<Pill />);
  };

  afterEach(() => vi.unstubAllGlobals());

  it('resolves a live agent by its full su id with no round-trip', async () => {
    H.active = [agent({ ownerId: SU, agent: 'su', role: 'engineer', sessionId: SID })];
    openWithQuery(SU);
    expect((await screen.findByTestId('id-match-chip')).textContent).toBe('matched su id');
  });

  it('resolves it by the SHORT HANDLE the roster actually renders', async () => {
    H.active = [agent({ ownerId: SU, agent: 'su', role: 'engineer', sessionId: SID })];
    openWithQuery('su-bc38a419');
    expect(await screen.findByTestId('id-match-chip')).toBeTruthy();
  });

  it('resolves a live agent by its NATIVE session id', async () => {
    H.active = [agent({ ownerId: SU, agent: 'su', role: 'engineer', sessionId: SID })];
    openWithQuery(SID);
    expect((await screen.findByTestId('id-match-chip')).textContent).toBe('matched session id');
  });

  it('matches a STALE agent too — addressing a session by id is not browsing', async () => {
    // `running` drops stale entries, which is right for browsing the roster and
    // wrong here: a human holding an id wants that session in any state.
    H.active = [
      agent({ ownerId: 'q1', agent: 'queen', role: 'queen' }), // keeps the pill rendered
      agent({ ownerId: SU, agent: 'su', role: 'engineer', sessionId: SID, liveness: 'stale' }),
    ];
    openWithQuery(SU);
    expect(await screen.findByTestId('id-match-chip')).toBeTruthy();
  });

  it('stays out of the way for a PROSE query — no id chip, just the text search', async () => {
    H.active = [agent({ ownerId: SU, agent: 'su', role: 'engineer', sessionId: SID })];
    openWithQuery('escalation');
    await screen.findByTestId('search-pending');
    expect(screen.queryByTestId('id-match-chip')).toBeNull();
  });
});
