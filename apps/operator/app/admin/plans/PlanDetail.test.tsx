// @vitest-environment jsdom
/**
 * PlanDetail.test.tsx — render-tier coverage for the plan-detail main pane.
 * The data comes from usePlan (+ usePlanLock / usePlanLint / usePlanRevisions
 * from ./plans-api) and a featuresConsolidated.byPlanSlug sync query; all are
 * mocked here so the four load branches (loading / error+Retry / no-data /
 * loaded), the legacy-vs-normal split, the Now hero, the frontmatter card, and
 * the read→edit toggle render in isolation. The heavy editor/action/panel
 * children are stubbed to inert nodes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement } from 'react';

const phaseSpy = vi.hoisted(() => vi.fn());
vi.mock('@/app/_components/perf/perf-marks', () => ({
  markInteractionPhase: phaseSpy,
  PERF_INTERACTIONS: { planPopupOpen: 'plan-popup-open' },
}));

/* ── Mocks ─────────────────────────────────────────────────────────── */
// usePlan drives the load branches; the other hooks/fetchers are inert.
let planResult: {
  data: unknown;
  loading: boolean;
  error: string | null;
};
// EI-… (WI-5520 regression coverage): PlanActivityFeed (rev.diffStat) and
// FeatureSlideOver (ev.kind) are local components in PlanDetail.tsx driven
// by these two hooks — configurable per-test so a malformed row (missing
// diffStat / a null kind) can be asserted to render instead of crash.
let revisionsResult: { data: unknown[] | null; loading: boolean } = { data: [], loading: false };
let featureTimelineEvents: unknown[] = [];
const refreshSpy = vi.fn();
const setDataSpy = vi.fn();

vi.mock('./plans-api', () => ({
  usePlan: () => ({ ...planResult, refresh: refreshSpy, setData: setDataSpy }),
  usePlanLock: () => ({ data: null }),
  usePlanLint: () => ({ data: null }),
  usePlanRevisions: () => revisionsResult,
  setPlanContent: vi.fn(async () => ({ ok: true })),
  staleConflictOf: () => null,
  writeErrorOf: () => null,
}));

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: { queryName: string }) => {
    if (opts.queryName === 'featureTimeline.byFeature') {
      return { data: featureTimelineEvents, error: null, fetching: false, loading: false, invalidate: vi.fn() };
    }
    return { data: [], error: null, fetching: false, loading: false, invalidate: vi.fn() };
  },
}));

// Heavy / Vditor / IPC children — stub to inert nodes (their own tests cover them).
// The feature-badge click is exposed as a button so a test can drive
// selectedFeatureId (and thus mount FeatureSlideOver) without a real Vditor render.
vi.mock("./PlanEditor", () => ({
  default: ({
    onFeatureClick,
    readOnly,
    value,
  }: {
    onFeatureClick?: (id: string) => void;
    readOnly?: boolean;
    value?: string;
  }) => (
    <div data-testid="plan-editor" data-read-only={String(readOnly)} data-value={value}>
      {onFeatureClick ? (
        <button type="button" onClick={() => onFeatureClick("F-1")}>
          open feature
        </button>
      ) : null}
    </div>
  ),
}));
vi.mock('./PlanJumpToItem', () => ({ default: () => null }));
vi.mock('./LockBanner', () => ({ default: () => null }));
vi.mock('./LintBanner', () => ({ default: () => null }));
vi.mock("./PlanActions", () => ({
  default: ({
    disabled,
    disabledReason,
  }: {
    disabled?: boolean;
    disabledReason?: string;
  }) => (
    <div
      data-testid="plan-actions"
      data-disabled={String(disabled)}
      data-reason={disabledReason}
    />
  ),
}));
vi.mock('./AssignDialog', () => ({ default: () => null }));
vi.mock('./RevisionsPanel', () => ({ default: () => null }));
vi.mock('./RevisionDiffModal', () => ({ default: () => null }));
vi.mock('./RevisionConversationModal', () => ({ default: () => null }));
vi.mock('./AgentsPanel', () => ({ default: () => null }));
vi.mock('./RunsPanel', () => ({ default: () => null }));
vi.mock('./PlanTriggersPanel', () => ({ default: () => <div data-testid="plan-triggers-panel" /> }));
vi.mock('./PlanConflictModal', () => ({ default: () => null }));
vi.mock('./PlanKanbanView', () => ({ default: () => null }));
vi.mock('./PlanStatusPopover', () => ({
  default: () => null,
  resolveItemId: () => null,
}));
vi.mock('../../_components/AuthorBadge', () => ({ AuthorBadge: () => null }));
vi.mock('@/app/harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true), element: null }),
}));

import PlanDetail from './PlanDetail';

function renderDetail(ui: ReactElement, searchParams = '') {
  return render(<NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>);
}

function mkPlan(over: Record<string, unknown> = {}) {
  return {
    slug: 'my-plan',
    archived: false,
    legacy: false,
    frontmatter: { title: 'My Plan', status: 'active' },
    now: null,
    items: [],
    decisions: [],
    raw: '# My Plan\n\nbody',
    contentHash: 'h1',
    version: 1,
    ...over,
  };
}

beforeEach(() => {
  phaseSpy.mockClear();
  planResult = { data: null, loading: false, error: null };
  revisionsResult = { data: [], loading: false };
  featureTimelineEvents = [];
  refreshSpy.mockClear();
  setDataSpy.mockClear();
});
afterEach(cleanup);

describe('PlanDetail (plan-detail main pane)', () => {
  it('renders the loading state with the slug', () => {
    planResult = { data: null, loading: true, error: null };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />);
    expect(screen.getByText(/Loading my-plan/)).toBeTruthy();
    expect(phaseSpy.mock.calls.map((call) => call[1])).toEqual([
      'detail-render-started',
      'detail-mounted',
    ]);
  });

  it('renders the error state and Retry calls refresh', () => {
    planResult = { data: null, loading: false, error: 'kaboom' };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />);
    expect(screen.getByText(/Failed to load plan/)).toBeTruthy();
    expect(screen.getByText('kaboom')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('renders the no-data placeholder when data is null and not loading', () => {
    planResult = { data: null, loading: false, error: null };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />);
    expect(screen.getByText('No data.')).toBeTruthy();
  });

  it('surfaces a server error embedded in the data', () => {
    planResult = { data: { error: 'plan_not_found' }, loading: false, error: null };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />);
    expect(screen.getByText(/Server: plan_not_found/)).toBeTruthy();
  });

  it('renders a loaded plan: title, editor, and the structured-action strip', () => {
    planResult = { data: mkPlan(), loading: false, error: null };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />);
    // Heading uses the frontmatter title.
    expect(screen.getByRole('heading', { name: 'My Plan' })).toBeTruthy();
    expect(screen.getByTestId('plan-editor')).toBeTruthy();
    // Non-legacy plans get the PlanActions strip + an Edit toggle.
    expect(screen.getByTestId('plan-actions')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Edit/ })).toBeTruthy();
  });

  it("shows the document while status actions wait for the later decoration read", () => {
    planResult = {
      data: mkPlan({ enrichmentsDeferred: true }),
      loading: false,
      error: null,
    };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />);

    expect(
      screen.getByTestId("plan-editor").getAttribute("data-read-only"),
    ).toBe("true");
    expect(
      screen.getByTestId("plan-actions").getAttribute("data-disabled"),
    ).toBe("true");
    expect(screen.getByTestId("plan-actions").getAttribute("data-reason")).toBe(
      "Finishing plan status data",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Finishing plan status data",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('renders the Now hero when the plan has a ## Now block', () => {
    planResult = {
      data: mkPlan({ now: { state: 'Halfway through', next: 'Ship the editor' } }),
      loading: false,
      error: null,
    };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />);
    expect(screen.getByText('Halfway through')).toBeTruthy();
    expect(screen.getByText('Ship the editor')).toBeTruthy();
  });

  it('renders the legacy banner and omits PlanActions for a legacy plan', () => {
    planResult = {
      data: mkPlan({ legacy: true, frontmatter: undefined }),
      loading: false,
      error: null,
    };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />);
    expect(screen.getByText(/Legacy plan/)).toBeTruthy();
    // No action strip / edit toggle for a legacy plan.
    expect(screen.queryByTestId('plan-actions')).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
  });

  it('shows the "← All plans" back button by default and fires onClose', () => {
    planResult = { data: mkPlan(), loading: false, error: null };
    const onClose = vi.fn();
    renderDetail(<PlanDetail slug="my-plan" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /All plans/ }));
    expect(onClose).toHaveBeenCalled();
  });

  it('hides the back button when showBack is false', () => {
    planResult = { data: mkPlan(), loading: false, error: null };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} showBack={false} />);
    expect(screen.queryByRole('button', { name: /All plans/ })).toBeNull();
  });

  it('shows the source pill (you) for a user-authored draft', () => {
    planResult = {
      data: mkPlan({ frontmatter: { title: 'Draft Plan', status: 'draft' } }),
      loading: false,
      error: null,
    };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />);
    expect(screen.getByText('you')).toBeTruthy();
  });

  it('renders the editor in edit mode when ?pane=edit', () => {
    planResult = { data: mkPlan(), loading: false, error: null };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />, '?pane=edit');
    // The EditBar Save button is present in edit mode.
    expect(screen.getByRole('button', { name: /Save/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it.each(['', '?pane=edit'])('keeps code-link display metadata out of editable plan bytes: %s', search => {
    const canonical = '# My Plan\n\n- **P-001** `todo` Work';
    const displayed = canonical + '\n  ↳ code: Widget code.ts · fresh';
    planResult = { data: mkPlan({ raw: canonical, prose: displayed,
      items: [{ id: 'P-001', text: 'Work', storedStatus: 'todo', effectiveStatus: 'todo', anchors: [{ requested: 'Widget' }] }],
    }), loading: false, error: null };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />, search);
    expect(screen.getByTestId('plan-editor').getAttribute('data-value')).toBe(search ? canonical : displayed);
  });

  it('deep-links to the per-plan Triggers tab through the ptab key', () => {
    planResult = { data: mkPlan({ harness: 'papercusp' }), loading: false, error: null };
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />, '?ptab=triggers');
    expect(screen.getByRole('tab', { name: 'Triggers' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('plan-triggers-panel')).toBeTruthy();
    expect(screen.queryByTestId('plan-editor')).toBeNull();
  });

  // WI-5520 regression coverage: "PlanDetail popup crashes ('This view hit an
  // error')" when opening a plan. The exact reported plan's data no longer
  // exists to re-run the literal repro, but the report named two specific
  // unguarded accesses as suspected culprits (rev.rationale/diffStat in the
  // Activity feed, ev.kind in the feature timeline drawer) — both are hardened
  // here, and these two tests assert the malformed-row shape renders instead
  // of throwing.
  it('renders an Activity revision with neither rationale nor diffStat without crashing', () => {
    planResult = { data: mkPlan(), loading: false, error: null };
    revisionsResult = {
      data: [
        {
          id: 1,
          authorKind: 'agent',
          createdAt: Date.now(),
          rationale: null,
          // diffStat intentionally absent — older/malformed revision rows.
        },
      ],
      loading: false,
    };
    expect(() =>
      renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />, '?activity=open'),
    ).not.toThrow();
    expect(screen.getByText(/\+0 −0 lines/)).toBeTruthy();
  });

  it('renders a feature-timeline event with a null kind without crashing', () => {
    planResult = { data: mkPlan(), loading: false, error: null };
    featureTimelineEvents = [{ iso: new Date().toISOString(), kind: null, detail: null }];
    renderDetail(<PlanDetail slug="my-plan" onClose={() => {}} />);
    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: 'open feature' })),
    ).not.toThrow();
    // The slide-over mounted (its close button is present) and the null
    // kind/detail rendered as empty rather than throwing.
    expect(screen.getByLabelText('Close')).toBeTruthy();
  });
});
