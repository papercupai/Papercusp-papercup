// @vitest-environment jsdom
/**
 * HydratedWorkRefPill (chat-ref-pills-2026-07-26 P-005) — live status/title
 * hydration through a mocked useSyncQuery. Asserts: the right queryName is
 * used per `kind`, the irrelevant query is `enabled: false` (no double
 * fetch), a live match renders the resolved state/title, and every
 * unresolvable case (no context, no match, still loading) degrades to the
 * plain 'unknown' pill rather than an error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const { syncResults, syncCalls } = vi.hoisted(() => ({
  syncResults: {} as Record<string, unknown[]>,
  syncCalls: [] as Array<{ queryName: string; enabled?: boolean; args?: unknown }>,
}));

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: { queryName: string; enabled?: boolean; args?: unknown }) => {
    syncCalls.push({ queryName: opts.queryName, enabled: opts.enabled, args: opts.args });
    const enabled = opts.enabled !== false;
    return {
      data: enabled ? (syncResults[opts.queryName] ?? []) : [],
      loading: false,
      fetching: false,
      transport: 'sse' as const,
      invalidate: () => {},
      error: null,
    };
  },
}));

import { HydratedWorkRefPill } from './HydratedWorkRefPill';

afterEach(() => {
  cleanup();
  for (const k of Object.keys(syncResults)) delete syncResults[k];
  syncCalls.length = 0;
  vi.unstubAllGlobals();
});

describe('HydratedWorkRefPill — viewport admission', () => {
  it('admits nearby references, pauses offscreen reads, and still hydrates on keyboard focus', () => {
    let notify: IntersectionObserverCallback;
    let target: Element;
    const disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { notify = callback; }
      observe(element: Element) { target = element; }
      disconnect = disconnect;
    });
    syncResults['workItems.detail'] = [{ id: 'WI-1', state: 'wip', title: 'Visible work' }];
    const view = render(<HydratedWorkRefPill kind="work-item" id="WI-1" harnessSlug="papercusp" href="/adv?sel=WI-1" />);
    const latest = () => syncCalls.filter((call) => call.queryName === 'workItems.detail').at(-1);
    expect(latest()?.enabled).toBe(false);
    const intersection = (isIntersecting: boolean) => act(() => notify([
      { target, isIntersecting } as IntersectionObserverEntry,
    ], {} as IntersectionObserver));
    intersection(true);
    expect(latest()?.enabled).toBe(true);
    expect(screen.getByRole('link', { name: 'WI-1 — Visible work' })).toBeTruthy();
    intersection(false);
    expect(latest()?.enabled).toBe(false);
    fireEvent.focus(screen.getByRole('link'));
    expect(latest()?.enabled).toBe(true);
    fireEvent.blur(screen.getByRole('link'));
    expect(latest()?.enabled).toBe(false);
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('gates plan-item hydration by the same viewport while preserving the message plan scope', () => {
    let notify: IntersectionObserverCallback;
    let target: Element;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { notify = callback; }
      observe(element: Element) { target = element; }
      disconnect() {}
    });
    render(<HydratedWorkRefPill kind="plan-item" id="P-003" harnessSlug="papercusp" planSlug="own-plan" />);
    const latest = () => syncCalls.filter((call) => call.queryName === 'plans.items').at(-1);
    expect(latest()).toMatchObject({ enabled: false, args: { slug: 'own-plan' } });
    act(() => notify([{ target, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(latest()).toMatchObject({ enabled: true, args: { slug: 'own-plan' } });
  });
});

describe('HydratedWorkRefPill — work-item refs', () => {
  it('queries workItems.detail scoped to the harness + id, plan-item query disabled', () => {
    syncResults['workItems.detail'] = [{ id: 'WI-5927', state: 'wip', title: 'Do the thing' }];
    render(<HydratedWorkRefPill kind="work-item" id="WI-5927" harnessSlug="papercusp" />);

    expect(screen.getByLabelText('WI-5927 — Do the thing')).toBeTruthy();
    const workCall = syncCalls.find((c) => c.queryName === 'workItems.detail');
    expect(workCall).toMatchObject({ enabled: true, args: { harnessSlug: 'papercusp', id: 'WI-5927' } });
    const planCall = syncCalls.find((c) => c.queryName === 'plans.items');
    expect(planCall?.enabled).toBe(false);
  });

  it('falls back to `summary` when the row has no `title`', () => {
    syncResults['workItems.detail'] = [{ id: 'EI-42', state: 'done', summary: 'A fixed bug' }];
    render(<HydratedWorkRefPill kind="work-item" id="EI-42" harnessSlug="papercusp" />);
    expect(screen.getByLabelText('EI-42 — A fixed bug')).toBeTruthy();
  });

  it('no live row yet (still loading / unresolved) degrades to the plain unknown pill', () => {
    syncResults['workItems.detail'] = [];
    render(<HydratedWorkRefPill kind="work-item" id="WI-9999" harnessSlug="papercusp" />);
    expect(screen.getByLabelText('WI-9999')).toBeTruthy();
  });
});

describe('HydratedWorkRefPill — plan-item refs (P-006-adjacent scoping)', () => {
  const PLAN_ITEMS_ROWS = [
    // No `archived` — the plans:items UI projection drops it (WI-7086).
    { plan: 'chat-ref-pills-2026-07-26', item: { id: 'P-003', effectiveStatus: 'done', text: 'WorkRefPill component' } },
    { plan: 'chat-ref-pills-2026-07-26', item: { id: 'P-006', effectiveStatus: 'wip', text: 'P-NNN scoping' } },
  ];

  it('queries plans.items scoped to the message planSlug, work-item query disabled', () => {
    syncResults['plans.items'] = PLAN_ITEMS_ROWS;
    render(
      <HydratedWorkRefPill kind="plan-item" id="P-003" harnessSlug="papercusp" planSlug="chat-ref-pills-2026-07-26" />,
    );
    expect(screen.getByLabelText('P-003 — WorkRefPill component')).toBeTruthy();
    const planCall = syncCalls.find((c) => c.queryName === 'plans.items');
    expect(planCall).toMatchObject({ enabled: true, args: { slug: 'chat-ref-pills-2026-07-26' } });
    const workCall = syncCalls.find((c) => c.queryName === 'workItems.detail');
    expect(workCall?.enabled).toBe(false);
  });

  it('no message plan_slug context → unknown pill, plans.items query disabled entirely', () => {
    syncResults['plans.items'] = PLAN_ITEMS_ROWS;
    render(<HydratedWorkRefPill kind="plan-item" id="P-003" harnessSlug="papercusp" planSlug={null} />);
    expect(screen.getByLabelText('P-003')).toBeTruthy();
    const planCall = syncCalls.find((c) => c.queryName === 'plans.items');
    expect(planCall?.enabled).toBe(false);
  });

  it('a P-ref with no live item on the scoped plan degrades to unknown (not a crash)', () => {
    syncResults['plans.items'] = PLAN_ITEMS_ROWS;
    render(
      <HydratedWorkRefPill kind="plan-item" id="P-999" harnessSlug="papercusp" planSlug="chat-ref-pills-2026-07-26" />,
    );
    expect(screen.getByLabelText('P-999')).toBeTruthy();
  });
});

describe('HydratedWorkRefPill — prop forwarding', () => {
  it('forwards href/size/className through to WorkRefPill unchanged', () => {
    syncResults['workItems.detail'] = [{ id: 'WI-1', state: 'open', title: 'X' }];
    render(
      <HydratedWorkRefPill
        kind="work-item"
        id="WI-1"
        harnessSlug="papercusp"
        href="/adv?sel=WI-1"
        size="xs"
        className="my-pill"
      />,
    );
    const link = screen.getByLabelText('WI-1 — X') as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/adv?sel=WI-1');
    expect(link.className).toBe('my-pill');
  });
});
