// @vitest-environment jsdom
/**
 * DepGraphPanel.test.tsx — the design pass on the Work-tab dependency-graph pane
 * (plan `dep-graph-design-pass-2026-08-08`, P-001..P-008).
 *
 * WHAT THIS SUITE IS FOR. Every assertion here pins a behaviour a READER of the pane can
 * name, because each one was a defect the owner could see: a toggle that fragmented into
 * three pieces, edges with no direction, a "Clear selection" that read as chrome, an empty
 * state that named the wrong empty thing, and a node count nobody could relate to the
 * 18,647-item list beside it. A test that merely re-states the JSX would not have caught
 * any of them — so these assert the OBSERVABLE property (class, marker, order, wording),
 * not the implementation that currently produces it.
 *
 * Seams (the app/operator RTL recipe — see agent-insights/component-rtl-testing):
 * @papercusp/sync per-queryName, the column-filter hook/bar, elkjs (lazily imported by the
 * layout effect, so it MUST be mocked or the pane never positions anything). nuqs via
 * NuqsTestingAdapter. list-meta and dep-graph-model are pure and used REAL, so the corpus
 * sentence and the scoping rule are exercised rather than stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactNode } from 'react';

interface SyncState {
  loading?: boolean;
  fetching?: boolean;
  data?: unknown;
  error?: { message: string } | null;
}
let itemsState: SyncState;
let edgesState: SyncState;
let summaryState: SyncState;
let waitsState: SyncState;
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: ({ queryName }: { queryName: string }) =>
    queryName === 'workItems.depEdges'
      ? { ...edgesState, invalidate: vi.fn() }
      : queryName === 'workItems.summary'
        ? { ...summaryState, invalidate: vi.fn() }
        : queryName === 'workItems.depWaits'
          ? { ...waitsState, invalidate: vi.fn() }
          : { ...itemsState, invalidate: vi.fn() },
}));

let filtersActive = false;
vi.mock('../../harness/filters', () => ({
  useColumnFilterState: () => ({ state: {}, setValue: vi.fn(), remove: vi.fn(), clearAll: vi.fn() }),
  useColumnFiltersFromState: (_cols: unknown, rows: unknown[]) => ({
    rows,
    controller: {},
    activeChips: [],
    hasActive: filtersActive,
    clearAll: vi.fn(),
  }),
  ColumnFilterBar: () => <div data-testid="filter-bar" />,
}));

/**
 * elkjs, stubbed to a deterministic grid. The real module is a ~1MB GWT bundle the pane
 * lazily imports (D-005) — mocking it keeps this at the fast tier AND makes positions
 * predictable, which is what lets the canvas-extent assertion below be exact rather than
 * approximate. It deliberately reports a width/height SMALLER than the nodes it placed,
 * which is the P-005 clipping condition.
 */
vi.mock('elkjs/lib/elk.bundled.js', () => ({
  default: class {
    layout(g: { children?: Array<{ id: string }> }) {
      const children = (g.children ?? []).map((c, i) => ({ id: c.id, x: i * 300, y: i * 80 }));
      return Promise.resolve({ children, width: 10, height: 10 });
    }
  },
}));

import DepGraphPanel from './DepGraphPanel';
import type { WorkItemRow } from './WorkItemsPanel';

function row(over: Partial<WorkItemRow> & { id: string }): WorkItemRow {
  return {
    kind: 'bug', family: 'issue', title: 'x', summary: null, state: 'open', assignee: null,
    assignedBy: null, severity: null, priority: null, rank: null, planSlug: null, spineRole: null,
    spineStatus: null, updatedAt: '', origin: null, auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    ...over,
  };
}

/** Two items joined by one live edge — the minimal graph that draws anything. */
const ITEMS: WorkItemRow[] = [
  row({ id: 'WI-1', title: 'A blocker with a rather long title indeed', state: 'in_progress' }),
  row({ id: 'WI-2', title: 'The blocked one', state: 'open' }),
];
const EDGES = [
  {
    blockedId: 'WI-2', blockerId: 'WI-1', blockerRef: 'WI-1',
    blockedKind: 'bug', blockerKind: 'bug', blockerStatus: 'open',
    blockedTitle: 'The blocked one', blockedStatus: 'open', blockedPlanSlug: null,
    blockerTitle: 'A blocker with a rather long title indeed', blockerPlanSlug: null,
  },
];

/** `_meta.total` on row[0] is how the resolver carries the TRUE corpus count (list-meta). */
function withTotal(rows: WorkItemRow[], total: number) {
  return rows.map((r, i) => (i === 0 ? { ...r, _meta: { total } } : r));
}

const setTitle = vi.fn();
/** The dock's real PanelComponentProps shape, so the panel is typed as the dock mounts it. */
function panelProps() {
  return {
    panelId: 'dg',
    panelType: 'dep-graph',
    params: { harnessSlug: 'alpha' } as Record<string, unknown>,
    api: { setParams: vi.fn(), setTitle, close: vi.fn() },
  };
}
function adapter(searchParams: string, onUrlUpdate?: (e: { queryString: string }) => void) {
  return ({ children }: { children: ReactNode }) => (
    <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
      {children}
    </NuqsTestingAdapter>
  );
}
function renderPanel(searchParams = '') {
  return render(<DepGraphPanel {...panelProps()} />, { wrapper: adapter(searchParams) });
}

/**
 * The SVG only exists once the (async) layout effect has resolved.
 *
 * ⚠ Selects `.pc-depgraph__svg`, NOT a bare `svg`. Since the KEY landed
 * (dep-graph-design-pass-2 P-005) the pane renders one small <svg> swatch per legend
 * row BEFORE the canvas, so `document.querySelector('svg')` returns a legend swatch —
 * which has no edges and no nodes, so every assertion below fails against a perfectly
 * healthy canvas. The assertions themselves are unchanged; only the query got specific
 * enough to name what it always meant.
 */
async function waitForCanvas(): Promise<SVGSVGElement> {
  return waitFor(() => {
    const svg = document.querySelector('.pc-depgraph__svg');
    if (!svg) throw new Error('canvas not laid out yet');
    return svg as SVGSVGElement;
  });
}

beforeEach(() => {
  itemsState = { loading: false, data: withTotal(ITEMS, 18647), error: null };
  summaryState = {
    loading: false,
    fetching: false,
    data: [{ total: 18_647, matched: 18_647, facets: [] }],
    error: null,
  };
  edgesState = { loading: false, data: EDGES, error: null };
  waitsState = { loading: false, data: [], error: null };
  filtersActive = false;
  setTitle.mockClear();
});
afterEach(cleanup);

describe('P-001 — the corpus relationship is legible in the pane', () => {
  it('states how many of the WHOLE corpus have dependencies, not just the node count', () => {
    renderPanel();
    // The owner's question was "why 18,647 items in the list but only 122 in the graph?".
    // Both numbers have to appear together or the reader is still left to guess.
    expect(screen.getByText(/2 of 18,647 items have dependencies/)).toBeTruthy();
    expect(screen.getByText(/Items with no dependency are not drawn/)).toBeTruthy();
  });

  it('WITHHOLDS the corpus sentence when the graph is scoped, rather than saying something false', () => {
    // `totalInScope` is "nodes before the budget" — it equals "items that have dependencies"
    // ONLY when nothing has narrowed the edge set first. Under a selection it is a subset,
    // so the sentence would be a confident wrong number.
    renderPanel('?sel=WI-1');
    expect(screen.queryByText(/items have dependencies/)).toBeNull();
  });

  it('WITHHOLDS it when the companion summary is absent, instead of quoting the page size', () => {
    summaryState = { loading: true, fetching: true, data: undefined, error: null };
    renderPanel();
    expect(screen.queryByText(/items have dependencies/)).toBeNull();
    expect(screen.getByText(/2 nodes/)).toBeTruthy();
  });
});

describe('P-002 — the "Issues only" toggle cannot fragment', () => {
  it('is a chip, not the fixed 28x28 icon box that wrapped its label into three pieces', () => {
    renderPanel();
    const toggle = screen.getByRole('button', { name: /Issues only/ });
    // THE regression this pins. `.pc-advpanel__iconbtn` is `width:28px;height:28px;
    // flex-shrink:0` — a text label inside it has 28px to lay out in and breaks apart.
    expect(toggle.className).toContain('pc-advpanel__chip');
    expect(toggle.className).not.toContain('pc-advpanel__iconbtn');
  });

  it('carries its state as aria-pressed rather than as a wrappable glyph in the label', () => {
    renderPanel('?dgh=issues');
    const toggle = screen.getByRole('button', { name: /Issues only/ });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    // The detached "○"/"●" in the owner's screenshot was a text node that could wrap away
    // from the words it qualified. It must not come back.
    expect(toggle.textContent).toBe('Issues only');
  });

  it('keeps the aria-label explanation (the control has no other explanation of itself)', () => {
    renderPanel();
    const toggle = screen.getByRole('button', { name: /Issues only/ });
    expect(toggle.getAttribute('aria-label')).toMatch(/edges that gate nothing/);
  });
});

describe('P-014 — integrity evidence is visible and never presented as an auto-fix', () => {
  it('renders the shared finding contract and topology-risk summary in issues mode', () => {
    edgesState = { loading: false, data: [{ ...EDGES[0]!, blockerId: null, blockerRef: 'WI-missing', blockerStatus: null }], error: null };
    renderPanel('?dgh=issues');
    expect(screen.getByLabelText('Dependency integrity findings')).toBeTruthy();
    expect(screen.getByText(/1 integrity finding/)).toBeTruthy();
    expect(screen.getByText(/hard-block: executable-endpoint-missing/)).toBeTruthy();
    expect(screen.getByText(/Advisory only — no dependency is changed automatically/)).toBeTruthy();
  });
});

describe('P-003 / P-007 — the bar wraps, and the way out of a selection is prominent', () => {
  it('opts the bar into wrapping instead of letting one row fragment its controls', () => {
    const { container } = renderPanel();
    const bar = container.querySelector('.pc-advpanel__bar');
    expect(bar?.className).toContain('pc-advpanel__bar--wrap');
  });

  it('renders Clear selection with accent emphasis and FIRST, so it cannot be buried', () => {
    const { container } = renderPanel('?sel=WI-1');
    const clear = screen.getByRole('button', { name: /Clear selection/ });
    expect(clear.className).toContain('pc-btn-accent');
    // Placement is half the fix: it used to sit last in a crowded row, reading as chrome.
    const bar = container.querySelector('.pc-advpanel__bar');
    expect(bar?.firstElementChild).toBe(clear);
  });

  it('does not render Clear selection when nothing is selected', () => {
    renderPanel();
    expect(screen.queryByRole('button', { name: /Clear selection/ })).toBeNull();
  });
});

describe('P-008 — Escape deselects', () => {
  it('clears ?sel on Escape', async () => {
    const onUrlUpdate = vi.fn();
    render(<DepGraphPanel {...panelProps()} />, { wrapper: adapter('?sel=WI-1', onUrlUpdate) });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    expect(onUrlUpdate.mock.calls.at(-1)?.[0].queryString).not.toContain('sel=WI-1');
  });

  it('does NOT fire — and does not preventDefault — when nothing is selected', () => {
    renderPanel();
    const evt = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    document.dispatchEvent(evt);
    // Swallowing Escape when this pane has nothing to clear would steal it from whatever
    // else on the page legitimately handles it.
    expect(evt.defaultPrevented).toBe(false);
  });

  it('yields to an open dialog rather than stealing its Escape', () => {
    const onUrlUpdate = vi.fn();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    try {
      render(<DepGraphPanel {...panelProps()} />, { wrapper: adapter('?sel=WI-1', onUrlUpdate) });
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onUrlUpdate).not.toHaveBeenCalled();
    } finally {
      dialog.remove();
    }
  });

  it('shares ONE code path with the button — clicking Clear clears the same param', async () => {
    const onUrlUpdate = vi.fn();
    render(<DepGraphPanel {...panelProps()} />, { wrapper: adapter('?sel=WI-1', onUrlUpdate) });
    fireEvent.click(screen.getByRole('button', { name: /Clear selection/ }));
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    expect(onUrlUpdate.mock.calls.at(-1)?.[0].queryString).not.toContain('sel=WI-1');
  });
});

describe('P-004 — edges read as a directed graph', () => {
  it('gives every edge an arrowhead, so blocker-vs-blocked is readable', async () => {
    renderPanel();
    const svg = await waitForCanvas();
    const paths = svg.querySelectorAll('.pc-depgraph__edge');
    expect(paths.length).toBe(1);
    expect(paths[0].getAttribute('marker-end')).toMatch(/^url\(#pc-dg-arrow-default-/);
  });

  it('scopes marker ids per pane, so two panes cannot steal each other\'s arrow colour', async () => {
    renderPanel();
    const svg = await waitForCanvas();
    const marker = svg.querySelector('marker');
    // A bare `id="pc-dg-arrow-default"` would collide across mounted panes; the id must
    // carry a per-instance suffix, and must stay a legal url(#…) fragment.
    expect(marker?.id).toMatch(/^pc-dg-arrow-default-.+$/);
    expect(marker?.id).not.toMatch(/[^a-zA-Z0-9_-]/);
  });
});

describe('event-wait-settlement P-009 — a holder await and an item blocker draw as different edges', () => {
  it('P-009: draws the holder\'s session await as `await` and the item\'s own event blocker as `wait`', async () => {
    waitsState = {
      loading: false,
      error: null,
      data: [
        {
          itemId: 'WI-2', waitKind: 'session-await', eventKey: 'work-item:done:WI-9',
          subscriberId: 'su-holder', subscriberIsHolder: true, certification: 'proving',
          subscriberState: 'live', stale: false,
        },
        {
          itemId: 'WI-2', waitKind: 'item-blocker', eventKey: 'release:deployed', blockerKind: 'event',
          certification: 'broad', stale: false,
        },
      ],
    };
    renderPanel();
    const svg = await waitForCanvas();
    await waitFor(() => expect(svg.querySelectorAll('path[data-wait-kind]').length).toBe(2));
    const holder = svg.querySelector('path[data-wait-kind="session-awaits-event"]');
    const blocker = svg.querySelector('path[data-wait-kind="item-waits-on-event"]');
    expect(holder?.getAttribute('class')).toContain('pc-depgraph__edge--await');
    expect(holder?.getAttribute('marker-end')).toMatch(/^url\(#pc-dg-arrow-await-/);
    expect(blocker?.getAttribute('class')).toContain('pc-depgraph__edge--wait');
    expect(blocker?.getAttribute('class')).not.toContain('pc-depgraph__edge--await');
    // The KEY names both, so the two dash patterns are readable without hovering.
    expect(screen.getByText(/holder waits on an event/)).toBeTruthy();
    expect(screen.getByText(/item blocked on an event/)).toBeTruthy();
  });

  it('P-009: a stale holder await draws as `wait-stale`, not `await`', async () => {
    waitsState = {
      loading: false,
      error: null,
      data: [
        {
          itemId: 'WI-2', waitKind: 'session-await', eventKey: 'work-item:done:WI-9',
          subscriberId: 'su-gone', subscriberIsHolder: true, certification: 'proving',
          subscriberState: 'ended', stale: true, staleReason: 'subscriber-ended',
        },
      ],
    };
    renderPanel();
    const svg = await waitForCanvas();
    const holder = await waitFor(() => {
      const p = svg.querySelector('path[data-wait-kind="session-awaits-event"]');
      if (!p) throw new Error('wait edge not drawn yet');
      return p;
    });
    expect(holder.getAttribute('class')).toContain('pc-depgraph__edge--wait-stale');
    expect(holder.getAttribute('class')).not.toContain('pc-depgraph__edge--await');
  });

  it('WI-6554700010030344: draws a runtime blocker as a CONDITION node with a `condition` edge, never as an event', async () => {
    waitsState = {
      loading: false,
      error: null,
      data: [
        {
          itemId: 'WI-2', waitKind: 'item-condition', eventKey: 'pc-heavy queue', blockerKind: 'runtime',
          capability: 'live-dependency', recheckAt: '2026-10-30T00:00:00.000Z', certification: 'not-an-event', stale: false,
        },
      ],
    };
    renderPanel();
    const svg = await waitForCanvas();
    const edge = await waitFor(() => {
      const p = svg.querySelector('path[data-wait-kind="item-waits-on-condition"]');
      if (!p) throw new Error('condition edge not drawn yet');
      return p;
    });
    expect(edge.getAttribute('class')).toContain('pc-depgraph__edge--condition');
    expect(edge.getAttribute('marker-end')).toMatch(/^url\(#pc-dg-arrow-condition-/);
    const node = svg.querySelector('g[data-node-id="condition:runtime:pc-heavy queue"]');
    expect(node?.getAttribute('class')).toContain('pc-depgraph__node--condition');
    expect(node?.getAttribute('class')).not.toContain('pc-depgraph__node--event');
    expect(node?.textContent).toContain('runtime · live-dependency · 1 wait · recheck 2026-10-30');
    expect(svg.querySelector('g[data-node-id="event:pc-heavy queue"]')).toBeNull();
    // The KEY names the condition mark, and the accessible list says what it is.
    expect(screen.getByText(/runtime or human condition no event can prove/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Condition pc-heavy queue/ })).toBeTruthy();
  });
});

describe('P-005 — no node is drawn sliced', () => {
  it('sizes the canvas from the NODES, not from the layouter\'s reported extent', async () => {
    // The elk stub reports width/height 10 while placing a node at x=300. Taking the
    // report at face value clips the rightmost card mid-draw — the owner's "F..", "Pla",
    // "Co" fragments. The canvas must cover max(x + NODE_W).
    renderPanel();
    const svg = await waitForCanvas();
    expect(Number(svg.getAttribute('width'))).toBeGreaterThanOrEqual(300 + 210);
    expect(Number(svg.getAttribute('height'))).toBeGreaterThanOrEqual(80 + 46);
  });
});

describe('P-006 — the node card is legible at a glance', () => {
  it('marks a node with its own state, and carries the full title for the truncated one', async () => {
    renderPanel();
    const svg = await waitForCanvas();
    // WI-1 is in_progress → the 'active' bucket.
    expect(svg.querySelector('.pc-depgraph__node-state--active')).toBeTruthy();
    const titles = Array.from(svg.querySelectorAll('title')).map((t) => t.textContent);
    expect(titles.some((t) => t?.includes('A blocker with a rather long title indeed'))).toBe(true);
  });
});

describe('WI-36234 — the empty state names the thing that is actually empty', () => {
  it('says the matching items have no DEPENDENCIES, not that nothing matched', () => {
    // The false statement: the grid beside it reads "432 of 18601 match" while this pane
    // claimed "No work items match the active filters". The empty set is the EDGE set.
    filtersActive = true;
    edgesState = { loading: false, data: [], error: null };
    renderPanel();
    expect(screen.getByText(/None of the 2 items matching the active filters have dependencies/)).toBeTruthy();
  });

  it('still says "nothing matched" when the filters genuinely matched nothing', () => {
    filtersActive = true;
    itemsState = { loading: false, data: [], error: null };
    edgesState = { loading: false, data: [], error: null };
    renderPanel();
    expect(screen.getByText('No work items match the active filters.')).toBeTruthy();
  });
});
