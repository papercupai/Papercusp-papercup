// @vitest-environment jsdom
//
// MainViewPanel — the create:main view router. Real logic: it renders the
// active ?view (plans editor when a plan is open · search results when ?q is
// set · sessions / observations / queue split · loading-vs-empty placeholder)
// and auto-opens the first scoped plan when entering Plans view with none
// selected. The heavy children + the data hooks (useCreateScope /
// usePlanListMaps / useCreateView) are mocked; nuqs is a per-key store the
// tests seed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { nuqs, view, maps, setters, dialogs } = vi.hoisted(() => ({
  nuqs: {} as Record<string, unknown>,
  view: { value: 'plans' as string },
  maps: { visiblePlans: [] as Array<{ slug: string }>, planList: { loading: false }, harnessByPlan: new Map<string, string>() },
  setters: {} as Record<string, ReturnType<typeof vi.fn>>,
  dialogs: { confirmAnswer: false, confirm: vi.fn() },
}));
function mkSetter(key: string) {
  if (!setters[key]) setters[key] = vi.fn(async (v: unknown) => { nuqs[key] = v; });
  return setters[key];
}

import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => [nuqs[key], mkSetter(key)],
  parseAsString: { withDefault: () => ({}) },
}));

vi.mock('./use-create-data', () => ({
  useCreateScope: () => ({ scopeMode: 'self', harnessFilter: null, advActiveSlug: 'h', harnessSlugsForFetch: ['h'] }),
  usePlanListMaps: () => maps,
  useCreateView: () => [view.value, mkSetter('view')],
}));

vi.mock('@/app/admin/plans/PlanDetail', () => ({
  default: ({ slug, onClose, onDirtyChange }: { slug: string; onClose: () => void; onDirtyChange: (d: boolean) => void }) => (
    <div data-testid="plan-detail">
      {slug}
      <button data-testid="pd-dirty" onClick={() => onDirtyChange(true)}>dirty</button>
      <button data-testid="pd-close" onClick={onClose}>close</button>
    </div>
  ),
}));
vi.mock('@/app/admin/plans/PlanSearchResults', () => ({
  default: ({ query, onPick }: { query: string; onPick: (s: string) => void }) => (
    <div data-testid="search-results">
      {query}
      <button data-testid="sr-pick" onClick={() => onPick('picked-plan')}>pick</button>
    </div>
  ),
}));
vi.mock('@/app/_components/layout/TwoPaneShell', () => ({ default: ({ list, detail }: { list: React.ReactNode; detail: React.ReactNode }) => <div data-testid="twopane">{list}{detail}</div> }));
vi.mock('./QueuePanel', () => ({ default: () => <div data-testid="queue-panel" /> }));
vi.mock('./PreviewPanel', () => ({ default: () => <div data-testid="preview-panel" /> }));
vi.mock('./SessionsPanel', () => ({ default: () => <div data-testid="sessions-panel" /> }));
vi.mock('@/app/harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({
    confirm: dialogs.confirm,
    element: null,
  }),
}));
vi.mock('@/lib/flag-hooks', () => ({ useFlag: () => true }));
vi.mock('@/app/_components/plans/use-plan-cleanup-run', () => ({
  PLAN_CLEANUP_RUN_PARAM: 'opcln',
  usePlanCleanupRun: () => ({ reviewInventory: { total: 2, runs: [
    { runId: 'newer-review', unresolved: 1 },
    { runId: 'older-review', unresolved: 1 },
  ] } }),
}));
vi.mock('@/app/_components/plans/PlansCleanupStrip', () => ({
  PlanCleanupReviewSelector: ({ onReview }: { onReview: (id: string) => void }) => (
    <button aria-label="Unresolved cleanup reviews" onClick={() => onReview('older-review')}>Older review</button>
  ),
}));

import MainViewPanel from './MainViewPanel';

function mkProps() {
  return { panelId: 'p', panelType: 'create:main', params: {}, api: { setParams: vi.fn(), setTitle: vi.fn(), close: vi.fn() } };
}

beforeEach(() => {
  for (const k of Object.keys(nuqs)) delete nuqs[k];
  for (const k of Object.keys(setters)) delete setters[k];
  nuqs.plan = null;
  nuqs.q = '';
  view.value = 'plans';
  maps.visiblePlans = [];
  maps.planList = { loading: false };
  dialogs.confirmAnswer = false;
  dialogs.confirm.mockReset();
  dialogs.confirm.mockImplementation(async () => dialogs.confirmAnswer);
});
afterEach(() => cleanup());

describe('<MainViewPanel /> view routing', () => {
  it('keeps existing cleanup reviews reachable when the plan list is empty', () => {
    render(<MainViewPanel {...mkProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unresolved cleanup reviews' }));
    expect(setters.opcln).toHaveBeenCalledWith('older-review');
  });

  it('keeps the cleanup review selector scoped to Plans view', () => {
    view.value = 'sessions';
    render(<MainViewPanel {...mkProps()} />);
    expect(screen.queryByRole('button', { name: 'Unresolved cleanup reviews' })).toBeNull();
  });
  it('renders the full PlanDetail editor when a plan is open in Plans view', () => {
    view.value = 'plans';
    nuqs.plan = 'open-plan';
    render(<MainViewPanel {...mkProps()} />);
    expect(screen.getByTestId('plan-detail').textContent).toContain('open-plan');
  });

  it('auto-opens the first scoped plan when entering Plans view with none selected', () => {
    view.value = 'plans';
    nuqs.plan = null;
    maps.visiblePlans = [{ slug: 'first-plan' }, { slug: 'second-plan' }];
    render(<MainViewPanel {...mkProps()} />);
    expect(setters.plan).toHaveBeenCalledWith('first-plan');
  });

  it('does NOT auto-open when a search query is active', () => {
    view.value = 'plans';
    nuqs.plan = null;
    nuqs.q = 'needle';
    maps.visiblePlans = [{ slug: 'first-plan' }];
    render(<MainViewPanel {...mkProps()} />);
    expect(setters.plan).not.toHaveBeenCalled();
    // search results render instead
    expect(screen.getByTestId('search-results').textContent).toContain('needle');
  });

  it('renders the Sessions panel when view=sessions', () => {
    view.value = 'sessions';
    render(<MainViewPanel {...mkProps()} />);
    expect(screen.getByTestId('sessions-panel')).toBeTruthy();
  });


  it('renders the queue split (QueuePanel | PreviewPanel) when view=queue', () => {
    view.value = 'queue';
    render(<MainViewPanel {...mkProps()} />);
    expect(screen.getByTestId('queue-panel')).toBeTruthy();
    expect(screen.getByTestId('preview-panel')).toBeTruthy();
  });

  it('shows the loading placeholder in Plans view while the list loads with no plans', () => {
    view.value = 'plans';
    nuqs.plan = null;
    maps.visiblePlans = [];
    maps.planList = { loading: true };
    render(<MainViewPanel {...mkProps()} />);
    expect(screen.getByText(/loading plans…/i)).toBeTruthy();
  });

  it('shows the empty placeholder in Plans view when there are no plans and not loading', () => {
    view.value = 'plans';
    nuqs.plan = null;
    maps.visiblePlans = [];
    maps.planList = { loading: false };
    render(<MainViewPanel {...mkProps()} />);
    expect(screen.getByText(/no plans in this view yet/i)).toBeTruthy();
  });

  it('picking a search hit sets ?plan to the chosen slug', () => {
    view.value = 'plans';
    nuqs.plan = null;
    nuqs.q = 'needle';
    render(<MainViewPanel {...mkProps()} />);
    fireEvent.click(screen.getByTestId('sr-pick'));
    expect(setters.plan).toHaveBeenCalledWith('picked-plan');
  });
});

describe('<MainViewPanel /> open-plan close guard', () => {
  it('closes (clears ?plan) immediately when there are no unsaved edits', () => {
    view.value = 'plans';
    nuqs.plan = 'open-plan';
    render(<MainViewPanel {...mkProps()} />);
    fireEvent.click(screen.getByTestId('pd-close'));
    expect(setters.plan).toHaveBeenCalledWith(null);
  });

  it('keeps the plan open when edits are dirty and the discard prompt is declined', () => {
    dialogs.confirmAnswer = false;
    view.value = 'plans';
    nuqs.plan = 'open-plan';
    render(<MainViewPanel {...mkProps()} />);
    fireEvent.click(screen.getByTestId('pd-dirty')); // mark dirty
    fireEvent.click(screen.getByTestId('pd-close'));
    expect(dialogs.confirm).toHaveBeenCalled();
    expect(setters.plan).not.toHaveBeenCalled();
  });

  it('discards and closes when dirty but the prompt is confirmed', () => {
    dialogs.confirmAnswer = true;
    view.value = 'plans';
    nuqs.plan = 'open-plan';
    render(<MainViewPanel {...mkProps()} />);
    fireEvent.click(screen.getByTestId('pd-dirty'));
    fireEvent.click(screen.getByTestId('pd-close'));
    expect(dialogs.confirm).toHaveBeenCalled();
    return waitFor(() => expect(setters.plan).toHaveBeenCalledWith(null));
  });
});
