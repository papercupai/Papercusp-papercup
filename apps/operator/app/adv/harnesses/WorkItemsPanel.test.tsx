// @vitest-environment jsdom
/**
 * WorkItemsPanel.test.tsx — the unified /adv work-items table panel. Covers the
 * no-slug guard, the loading / error / empty / populated render branches, the
 * panel-title effect, the global quick-search (`wq`) substring filter (incl. the
 * "matches nothing" message), the refresh invalidate, and row-click → `?sel`.
 *
 * Seams (the app/operator RTL recipe — see agent-insights/component-rtl-testing):
 * @papercusp/sync useSyncQuery (per-queryName), @papercusp/grid-core RichGrid +
 * usePersistedColumnWidths, the column-filter hook/bar, Tooltip, the pills + the
 * trust badge — all stubbed. nuqs via NuqsTestingAdapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactNode } from 'react';

interface SyncState { loading?: boolean; fetching?: boolean; data?: unknown; error?: { message: string } | null }
let wiState: SyncState;
let summaryState: SyncState;
let rowArgs: unknown;
const invalidateMock = vi.fn();
const summaryInvalidateMock = vi.fn();
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: ({ queryName, args }: { queryName: string; args?: unknown }) => {
    if (queryName === 'trust.list') return { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    if (queryName === 'workItems.summary') return { ...summaryState, invalidate: summaryInvalidateMock };
    rowArgs = args;
    return { ...wiState, invalidate: invalidateMock };
  },
}));
vi.mock('@papercusp/grid-core', () => ({
  // The panel renders via VirtualGrid (RichGrid + an owned virtualizer); the mock
  // just renders `rows` so the assertions key off the same row buttons.
  VirtualGrid: ({ rows, onRowClick, onEndReached }: {
    rows: { id: string }[];
    onRowClick?: (r: { id: string }) => void;
    onEndReached?: () => void;
  }) => (
    <div data-testid="grid">
      {rows.map((r) => (
        <button key={r.id} data-testid={`row-${r.id}`} onClick={() => onRowClick?.(r)}>{r.id}</button>
      ))}
      {onEndReached ? <button onClick={onEndReached}>load-more</button> : null}
    </div>
  ),
  usePersistedColumnWidths: () => [{}, vi.fn()],
}));
// list-meta (readListTotal/listCountLabel) is pure — used REAL, not mocked, so the
// "N of TOTAL" assertion exercises the actual count logic.
// `filterCountLabel` is deliberately the REAL implementation, not a stub: the
// panel renders its output into the badge this file asserts on, so stubbing it
// would make those assertions test the stub. Only the stateful/visual members
// (the hook, the bar) are faked.
vi.mock('../../harness/filters', async () => ({
  useColumnFilterState: () => ({ state: {}, setValue: vi.fn(), remove: vi.fn(), clearAll: vi.fn() }),
  useColumnFiltersFromState: (_cols: unknown, rows: unknown[]) => ({
    rows, controller: {}, activeChips: [], hasActive: false, clearAll: vi.fn(),
  }),
  ColumnFilterBar: () => <div data-testid="filter-bar" />,
  filterCountLabel: (await vi.importActual<typeof import('../../harness/filters/filter-count-label')>(
    '../../harness/filters/filter-count-label',
  )).filterCountLabel,
}));
vi.mock('../../harness/Tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('../../harness/primitives', () => ({
  IssueStatusPill: () => <span />, KindPill: () => <span />, SeverityPill: () => <span />, StatusPill: () => <span />,
}));
vi.mock('../../harness/TrustBadge', () => ({ TrustBadge: () => <span />, trustBadgeState: () => null }));
vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (key: string, opts?: { plural?: boolean; lower?: boolean }) => {
    const label = key === 'workUnit' ? (opts?.plural ? 'Deliverables' : 'Deliverable') : key;
    return opts?.lower ? label.toLowerCase() : label;
  },
}));

import WorkItemsPanel from './WorkItemsPanel';
// The label moved to the shared filters module (owner ask 2026-08-17: the Learning
// tab must "mimic how it works in the work queue"), so these cases now pin the
// SHARED helper every filterable pane renders — not a work-items-only copy.
import { filterCountLabel } from '../../harness/filters/filter-count-label';
import type { WorkItemRow } from './WorkItemsPanel';

function row(over: Partial<WorkItemRow> & { id: string }): WorkItemRow {
  return {
    kind: 'bug', family: 'issue', title: 'x', summary: null, state: 'open', assignee: null,
    assignedBy: null, severity: null, priority: null, rank: null, planSlug: null, spineRole: null,
    spineStatus: null, updatedAt: '', origin: null, auditVerdict: null, verifiedAuthorGithubUserId: null,
    ...over,
  };
}
const ROWS: WorkItemRow[] = [
  row({ id: 'WI-1', title: 'Login crash', state: 'open', assignee: 'ada' }),
  row({ id: 'F-2', kind: 'feature', family: 'feature', title: 'Dark mode', state: 'in_progress', planSlug: 'plan-x' }),
];

const setTitle = vi.fn();
function renderPanel(slug = 'alpha', searchParams = '', onUrlUpdate?: (e: unknown) => void) {
  return render(
    <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
      <WorkItemsPanel panelId="p010-work-items" panelType="harness:work-items" params={{ harnessSlug: slug }} api={{ setTitle } as never} />
    </NuqsTestingAdapter>,
  );
}

beforeEach(() => {
  wiState = { loading: false, fetching: false, data: ROWS, error: null };
  summaryState = {
    loading: false,
    fetching: false,
    data: [{ total: 2, matched: 2, facets: [] }],
    error: null,
  };
  rowArgs = undefined;
  setTitle.mockReset();
  invalidateMock.mockReset();
  summaryInvalidateMock.mockReset();
});
afterEach(cleanup);

describe('WorkItemsPanel', () => {
  it('shows the pick-a-harness empty state when no slug is set', () => {
    renderPanel('');
    expect(screen.getByText(/Pick a harness to view its deliverables/i)).toBeTruthy();
    expect(screen.queryByTestId('grid')).toBeNull();
  });

  it('shows the loading state while the query is loading', () => {
    wiState = { loading: true, fetching: true, data: null, error: null };
    renderPanel();
    expect(screen.getByText(/Loading deliverables/i)).toBeTruthy();
  });

  it('shows an error state when the query errors', () => {
    wiState = { loading: false, fetching: false, data: null, error: { message: 'boom' } };
    renderPanel();
    expect(screen.getByText(/Could not load deliverables: boom/i)).toBeTruthy();
  });

  it('shows the no-items message when the harness has none', () => {
    wiState = { loading: false, fetching: false, data: [], error: null };
    renderPanel();
    expect(screen.getByText(/No deliverables for this harness/i)).toBeTruthy();
  });

  it('renders the grid and sets the panel title from the row count', () => {
    renderPanel();
    expect(screen.getByTestId('grid')).toBeTruthy();
    expect(screen.getByTestId('row-WI-1')).toBeTruthy();
    expect(screen.getByTestId('row-F-2')).toBeTruthy();
    expect(setTitle).toHaveBeenCalledWith('Deliverables · alpha (2)');
    // In-pane badge: not capped, not filtered → the plain total.
    expect(screen.getByTestId('wi-count').textContent).toContain('2 deliverables');
  });

  it('keeps the DB total and load-more when a delta merge relocates _meta off row 0', async () => {
    // The resolver initially stashes the true total on row 0, but the
    // order-insensitive delta client may relocate that row while reconstructing
    // a newly sorted page. The panel must still report 57 and keep paging.
    wiState = {
      loading: false, fetching: false, error: null,
      data: [ROWS[0], { ...ROWS[1], _meta: { nextCursor: 'cursor-2', hasMore: true } }],
    };
    summaryState = { loading: false, fetching: false, data: [{ total: 57, matched: 57, facets: [] }], error: null };
    renderPanel();
    expect(setTitle).toHaveBeenCalledWith('Deliverables · alpha (57)');
    expect(screen.getByTestId('wi-count').textContent).toContain('57 deliverables');
    expect(screen.getByTestId('wi-count').textContent).not.toContain('loaded');
    expect(rowArgs).toEqual({ harnessSlug: 'alpha', q: '', filters: {}, limit: 500 });
    fireEvent.click(screen.getByRole('button', { name: 'load-more' }));
    await waitFor(() => expect(rowArgs).toEqual({
      harnessSlug: 'alpha', q: '', filters: {}, limit: 500, cursor: 'cursor-2',
    }));
  });

  it('reflects the filter in the title + badge (shown of store total)', () => {
    summaryState = { loading: false, fetching: false, data: [{ total: 2, matched: 1, facets: [] }], error: null };
    renderPanel('alpha', '?wq=login'); // matches WI-1 only → 1 of 2 loaded
    expect(setTitle).toHaveBeenCalledWith('Deliverables · alpha (1 of 2)');
    expect(screen.getByTestId('wi-count').textContent).toContain('1 of 2 match');
    expect(screen.getByTestId('wi-count').getAttribute('aria-label')).toContain(
      'selected harness deliverable corpus',
    );
  });

  it('applies the quick-search substring filter (wq)', () => {
    renderPanel('alpha', '?wq=login');
    expect(screen.getByTestId('row-WI-1')).toBeTruthy();
    expect(screen.queryByTestId('row-F-2')).toBeNull();
  });

  it('shows the no-match message when the filter excludes everything', () => {
    summaryState = { loading: false, fetching: false, data: [{ total: 2, matched: 0, facets: [] }], error: null };
    renderPanel('alpha', '?wq=zzzznope');
    expect(screen.getByText(/No deliverables match the filter/i)).toBeTruthy();
  });

  it('invokes the query invalidate on the refresh button', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh deliverables' }));
    expect(invalidateMock).toHaveBeenCalledTimes(1);
    expect(summaryInvalidateMock).toHaveBeenCalledTimes(1);
  });

  it('writes the clicked row id into ?sel', async () => {
    const onUrlUpdate = vi.fn();
    renderPanel('alpha', '', onUrlUpdate);
    fireEvent.click(screen.getByTestId('row-WI-1'));
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    const ev = onUrlUpdate.mock.calls.at(-1)![0] as { searchParams: URLSearchParams };
    expect(ev.searchParams.get('sel')).toBe('WI-1');
  });
});

describe('filterCountLabel integration', () => {
  it('keeps the panel-facing corpus label grouped and scope-aware', () => {
    const label = filterCountLabel({ kind: 'corpus', count: 36_096 });
    expect(label.summary).toBe('36,096 items');
    expect(label.ariaLabel).toBe('36,096 items in the full corpus');
  });
});
