// @vitest-environment jsdom
//
// Click-flow regression for the curated Conversations (unified inbox). The main
// AdvConversationsTab suite mocks nuqs with a NO-OP setter, so it can only prove
// "click calls setRoute" and "a manually-set route renders the detail" as two
// SEPARATE facts — it never flows a real click end to end. This suite uses a
// STATEFUL nuqs mock (setRoute writes a store and re-renders subscribers), so a
// real fireEvent.click threads through route → detail exactly like the app.
//
// Guards WI-4216: clicking a left-pane row must bring the item into the main
// pane. In particular, when the source detail query resolves EMPTY (a webview
// race where the SSE cache answers before the row is materialized), the clicked
// row's ANCHOR must stay visible — never a bare "Select a thread" that reads as
// "the click did nothing" (the symptom the owner reported). ThreadsView/
// DeliberationsView/AgentChatsView did not have this list-row fallback.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

// ---- stateful nuqs mock: setRoute updates a store and re-renders subscribers ----
const store: Record<string, unknown> = {};
const listeners = new Set<() => void>();
const emit = () => { for (const l of [...listeners]) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapCache = new Map<object, { sig: string; val: Record<string, unknown> }>();

vi.mock('nuqs', () => {
  const useQueryState = (key: string) => {
    const value = React.useSyncExternalStore(subscribe, () => store[key], () => store[key]);
    const set = React.useCallback((v: unknown) => {
      store[key] = typeof v === 'function' ? (v as (p: unknown) => unknown)(store[key]) : v;
      emit();
    }, [key]);
    return [value, set];
  };
  const useQueryStates = (parsers: Record<string, unknown>) => {
    const keys = Object.keys(parsers);
    const getSnap = () => {
      const sig = keys.map((k) => `${k}=${JSON.stringify(store[k])}`).join('&');
      const cached = snapCache.get(parsers);
      if (cached && cached.sig === sig) return cached.val;
      const val = Object.fromEntries(keys.map((k) => [k, store[k]]));
      snapCache.set(parsers, { sig, val });
      return val;
    };
    const value = React.useSyncExternalStore(subscribe, getSnap, getSnap);
    const set = React.useCallback((patch: Record<string, unknown>) => {
      Object.assign(store, patch);
      emit();
    }, []);
    return [value, set];
  };
  const p: Record<string, unknown> = {};
  p.withDefault = () => p;
  return {
    useQueryState,
    useQueryStates,
    parseAsString: p,
    parseAsStringLiteral: () => p,
    parseAsStringEnum: () => p,
    parseAsArrayOf: () => p,
    createParser: () => p,
  };
});

const ready = (data: unknown[] = []): Record<string, unknown> => ({
  data, loading: false, fetching: false, error: null, invalidate: vi.fn(), transport: 'SSE',
});
const syncKey = (q: string, a: Record<string, unknown> = {}) => `${q}:${JSON.stringify(a)}`;
let syncResults: Record<string, Record<string, unknown>> = {};
let syncQueryCalls: Array<{ queryName: string; enabled: boolean }> = [];
/* Spread the original — see the identical note in AdvConversationsTab.test.tsx
   (WI-38242's class: a from-scratch factory strips lazyWithRetry and the file
   fails to collect). */
vi.mock('@papercusp/sync', async (orig) => ({
  ...(await orig<typeof import('@papercusp/sync')>()),
  onSyncBusEvent: () => () => {},
  useSyncQuery: ({ queryName, args = {}, enabled = true }: { queryName: string; args?: Record<string, unknown>; enabled?: boolean }) => {
    syncQueryCalls.push({ queryName, enabled });
    if (!enabled) return ready();
    return syncResults[syncKey(queryName, args)] ?? syncResults[queryName] ?? ready();
  },
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey?: (i: number) => string | number }) => {
    const ROW = 104;
    const items = Array.from({ length: count }, (_, index) => ({
      index, key: getItemKey?.(index) ?? `vrow-${index}`, start: index * ROW, end: index * ROW + ROW, size: ROW, lane: 0,
    }));
    return { getVirtualItems: () => items, getTotalSize: () => count * ROW, measureElement: () => {}, measure: () => {}, scrollToIndex: () => {} };
  },
}));

vi.mock('@/app/harness/ChatPanel', () => ({ default: () => <div data-testid="chat-panel-stub" /> }));

import AdvConversationsTab from './AdvConversationsTab';

const THREAD_TITLE = 'why does the watchdog recycle the host?';

beforeEach(() => {
  Object.assign(store, {
    conv: 'inbox', fkind: [], fadvanced: 'closed', fagent: '', fplan: '', fq: '', fmsg: null,
    cq: '', cvf: {}, conversation: null, cstate: 'open', ckind: 'all', ctopic: '', thread: null,
    acharness: '', acrole: '', chat: null, cmsg: null, opc: null,
  });
  snapCache.clear();
  syncQueryCalls = [];
  syncResults = {
    'conversations.questionsList': ready([{
      id: 'c-1', kind: 'question', state: 'open', scope: 'harness', harness_slug: 'papercusp',
      title: THREAD_TITLE, asker_id: 'oracle', topics: ['infra'], promoted_issue_id: null,
      created_ts: new Date(Date.now() - 120_000).toISOString(), updated_ts: new Date(Date.now() - 120_000).toISOString(),
    }]),
    'conversations.deliberationList': ready(),
    'conversations.agentChatList': ready(),
    'dev.coordFeed': ready([]),
    [syncKey('conversations.questionDetail', { id: 'c-1' })]: ready([{
      id: 'c-1', kind: 'question', state: 'open', scope: 'harness', harness_slug: 'papercusp',
      title: THREAD_TITLE, asker_id: 'oracle', subscriber_count: 2, topics: ['infra'],
      body: 'the host keeps recycling every few minutes', accepted_answer: null, promoted_issue_id: null, posts: [],
    }]),
  };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('curated Conversations — a row click reaches the main pane (WI-4216)', () => {
  it('renders the selected detail in the main pane after a real click', async () => {
    render(<AdvConversationsTab />);
    expect(store.conv).toBe('inbox');

    fireEvent.click(screen.getByRole('button', { name: `Open ${THREAD_TITLE}` }));

    // The click atomically switches the source + selection…
    expect(store.conv).toBe('threads');
    expect(store.conversation).toBe('c-1');
    // …and the detail lands in the main pane.
    expect(await screen.findByRole('heading', { level: 2, name: THREAD_TITLE })).toBeTruthy();
  });

  it('keeps exactly one enabled source-list subscription when a unified detail opens', async () => {
    render(<AdvConversationsTab />);
    syncQueryCalls = [];

    fireEvent.click(screen.getByRole('button', { name: `Open ${THREAD_TITLE}` }));
    expect(await screen.findByRole('heading', { level: 2, name: THREAD_TITLE })).toBeTruthy();

    // UnifiedInboxView stays mounted and owns the one warm questions list.
    // ThreadsView mounts as detailOnly and must not start a second enabled list
    // read on the same click; it only enables the selected id's detail query.
    const enabledListCalls = (queryName: string) => syncQueryCalls.filter((call) => (
      call.queryName === queryName && call.enabled
    )).length;
    // React may render the mounted parent more than once. Compare it with a
    // sibling unified-list hook from that same parent: a detail-owned duplicate
    // questions read would make this count larger than deliberations.
    expect(enabledListCalls('conversations.questionsList')).toBe(
      enabledListCalls('conversations.deliberationList'),
    );
    expect(syncQueryCalls.some((call) => (
      call.queryName === 'conversations.questionsList' && !call.enabled
    ))).toBe(true);
    expect(syncQueryCalls.some((call) => (
      call.queryName === 'conversations.questionDetail' && call.enabled
    ))).toBe(true);
  });

  it('keeps the clicked row anchored in the main pane even when its detail resolves empty', async () => {
    // Webview race: the detail query answers empty (loading:false, no row) before
    // the row materializes. The clicked item must still occupy the main pane via
    // its anchor — NOT fall through to the "Select a thread" no-selection state.
    syncResults[syncKey('conversations.questionDetail', { id: 'c-1' })] = ready([]);
    render(<AdvConversationsTab />);

    fireEvent.click(screen.getByRole('button', { name: `Open ${THREAD_TITLE}` }));

    expect(store.conv).toBe('threads');
    expect(await screen.findByRole('heading', { level: 2, name: THREAD_TITLE })).toBeTruthy();
    // The generic "nothing selected" empty state must NOT be what the user sees.
    expect(screen.queryByText('Select a thread')).toBeNull();
  });
});

// WI-4142: production Conversations flashing. createUsePollingQuery sets
// `placeholderData: keepPreviousData` (libs/generic/sync usePollingQuery.ts) on
// EVERY useSyncQuery, including id-scoped DETAIL queries — so react-query hands
// back the PREVIOUSLY-selected entity's full detail row as the "data" for a
// brand-new selection's query key until that new id's own fetch resolves. This
// suite's sync mock doesn't reproduce react-query's internals, so it simulates
// the exact observable shape of that placeholder window directly: the detail
// query for the NEWLY selected id resolves to a row whose OWN `id` still belongs
// to the PREVIOUS selection (precisely what keepPreviousData serves up mid-flight).
const OTHER_THREAD_TITLE = 'why did the deploy pipeline stall for an hour?';

describe('curated Conversations — agent-message selection survives normalization (WI-6554700010009158)', () => {
  const message = {
    msg_id: 'agent-message-1', kind: 'message', from: 'su-aabbccdd-sender', to: ['su-eeff0011-recipient'],
    summary: 'private message selection', body: 'the selected agent message body',
    harness_slug: 'papercusp', plan_slug: null, lifecycle: null, audience: [], broadcast: false,
    reply_count: 0, ts: new Date().toISOString(), last_reply_ts: null,
  };

  beforeEach(() => {
    syncResults['conversations.agentMessageList'] = ready([message]);
    syncResults[syncKey('conversations.agentMessageDetail', { id: message.msg_id })] = ready([
      { message, replies: [] },
    ]);
  });

  it('keeps the clicked agent message selected and renders its exact body', async () => {
    render(<AdvConversationsTab />);
    fireEvent.click(screen.getByRole('button', { name: `Open ${message.summary}` }));
    expect(store.conv).toBe('messages');
    expect(store.cmsg).toBe(message.msg_id);
    expect(await within(screen.getByRole('tabpanel')).findByText(message.body)).toBeTruthy();
  });

  it('keeps an agent-message deep link selected after mounting', async () => {
    Object.assign(store, { conv: 'messages', cmsg: message.msg_id });
    render(<AdvConversationsTab />);
    expect(store.conv).toBe('messages');
    expect(store.cmsg).toBe(message.msg_id);
    expect(await within(screen.getByRole('tabpanel')).findByText(message.body)).toBeTruthy();
  });

  it('normalizes a message route without an id back to the inbox', () => {
    Object.assign(store, { conv: 'messages', cmsg: null });
    render(<AdvConversationsTab />);
    expect(store.conv).toBe('inbox');
    expect(store.cmsg).toBeNull();
    expect(screen.getByRole('button', { name: `Open ${message.summary}` })).toBeTruthy();
  });
});

describe('curated Conversations — a cross-id keepPreviousData placeholder never renders as the current detail (WI-4142)', () => {
  it('does not show the previous thread\'s stale detail while a new thread is loading', async () => {
    syncResults['conversations.questionsList'] = ready([
      {
        id: 'c-1', kind: 'question', state: 'open', scope: 'harness', harness_slug: 'papercusp',
        title: THREAD_TITLE, asker_id: 'oracle', topics: ['infra'], promoted_issue_id: null,
        created_ts: new Date(Date.now() - 180_000).toISOString(), updated_ts: new Date(Date.now() - 180_000).toISOString(),
      },
      {
        id: 'c-2', kind: 'question', state: 'open', scope: 'harness', harness_slug: 'papercusp',
        title: OTHER_THREAD_TITLE, asker_id: 'oracle', topics: ['deploy'], promoted_issue_id: null,
        created_ts: new Date(Date.now() - 60_000).toISOString(), updated_ts: new Date(Date.now() - 60_000).toISOString(),
      },
    ]);
    // The c-2 detail query is still "in flight": the mock answers with c-1's row
    // (id: 'c-1') under the { id: 'c-2' } args key — the keepPreviousData shape.
    syncResults[syncKey('conversations.questionDetail', { id: 'c-2' })] = ready([{
      id: 'c-1', kind: 'question', state: 'open', scope: 'harness', harness_slug: 'papercusp',
      title: THREAD_TITLE, asker_id: 'oracle', subscriber_count: 2, topics: ['infra'],
      body: 'the host keeps recycling every few minutes', accepted_answer: null, promoted_issue_id: null, posts: [],
    }]);
    render(<AdvConversationsTab />);

    fireEvent.click(screen.getByRole('button', { name: `Open ${OTHER_THREAD_TITLE}` }));
    expect(store.conv).toBe('threads');
    expect(store.conversation).toBe('c-2');

    // The stale c-1 detail body must never render as if it were c-2's content —
    // that flash of wrong content, then a snap to the right one, is WI-4142.
    expect(screen.queryByText('the host keeps recycling every few minutes')).toBeNull();
    // The anchor (from the already-cached list row) keeps the correct title
    // visible immediately, even while the true c-2 detail is still loading.
    expect(await screen.findByRole('heading', { level: 2, name: OTHER_THREAD_TITLE })).toBeTruthy();
  });
});
