// @vitest-environment jsdom
/**
 * DetailPanel — work-item detail dedup guard.
 *
 * P-004 makes the one-row `workItems.detail` query selected-row authority.
 * Detail must never subscribe to the bounded byHarness page: a selected id can
 * sit beyond page one or outside the active filter and still has to resolve.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { resolveSelectionKind } from './DetailPanel';

type SyncCall = { queryName: string; enabled?: boolean; args?: Record<string, unknown>; requestClass?: string };
const { syncCalls, detailState, issueState } = vi.hoisted(() => ({
  syncCalls: [] as SyncCall[],
  detailState: { loading: false, error: null as Error | null, data: [] as unknown[],
    failureCount: 0, failureReason: null as Error | null },
  issueState: { issues: [] as unknown[] | null },
}));

vi.mock('@papercusp/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/sync')>()),
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: SyncCall) => {
    syncCalls.push({ queryName: opts.queryName, enabled: opts.enabled, args: opts.args, requestClass: opts.requestClass });
    const enabled = opts.enabled !== false;
    const detail = enabled && opts.queryName === 'workItems.detail';
    return {
      data: detail ? detailState.data : [],
      loading: detail && detailState.loading,
      fetching: false,
      transport: 'sse' as const,
      invalidate: () => {},
      error: detail ? detailState.error : null,
      failureCount: detail ? detailState.failureCount : 0,
      failureReason: detail ? detailState.failureReason : null,
    };
  },
}));
vi.mock('./useHarnessData', () => ({
  useHarnessFeature: () => ({ feature: null, loading: false, error: null, patchFeature: vi.fn() }),
  useHarnessIssues: () => ({ issues: issueState.issues, patchIssue: vi.fn() }),
}));
vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (key: string, opts?: { plural?: boolean; lower?: boolean }) => {
    const label = key === 'workUnit' ? (opts?.plural ? 'Deliverables' : 'Deliverable') : key;
    return opts?.lower ? label.toLowerCase() : label;
  },
}));
vi.mock('@papercusp/papercusp-shared', () => ({ openFeatureChat: vi.fn() }));
// FeatureEditor pulls a rich editor at import — not needed for the empty/not-found
// branch this test renders; stub it so module load stays jsdom-light.
vi.mock('../../harness/FeatureEditor', () => ({ default: () => null }));

import DetailPanel from './DetailPanel';

afterEach(() => {
  cleanup();
  syncCalls.length = 0;
  detailState.loading = false;
  detailState.error = null;
  detailState.data = [];
  detailState.failureCount = 0;
  detailState.failureReason = null;
  issueState.issues = [];
});

function renderSelected() {
  return render(
    <NuqsTestingAdapter searchParams="?sel=WI-1">
      <DetailPanel panelId={'p1' as never} panelType={'detail' as never}
        params={{ harnessSlug: 'h1' } as never} api={{ setTitle: vi.fn() } as never} />
    </NuqsTestingAdapter>,
  );
}

describe('DetailPanel work-item detail subscription', () => {
  it('reveals a resolver failure during retries before the terminal query error exists', () => {
    detailState.loading = true;
    detailState.failureCount = 1;
    detailState.failureReason = new Error('resolver timeout');
    renderSelected();
    expect(screen.getByText('Unable to load WI-1: resolver timeout')).toBeTruthy();
    expect(screen.queryByText('Loading WI-1…')).toBeNull();
  });

  it('shows a failed detail read even while unrelated legacy issues and a retry are loading', () => {
    issueState.issues = null;
    detailState.loading = true;
    detailState.error = new Error('resolver timeout');
    renderSelected();
    expect(screen.getByText('Unable to load WI-1: resolver timeout')).toBeTruthy();
    expect(screen.queryByText('Loading WI-1…')).toBeNull();
  });

  it('settles a missing unified item independently of an unresolved legacy issue feed', () => {
    issueState.issues = null;
    renderSelected();
    expect(screen.getByText('No deliverable found for WI-1.')).toBeTruthy();
    expect(screen.queryByText('Loading WI-1…')).toBeNull();
  });

  it('keeps the selected item loading while its own first read is pending', () => {
    detailState.loading = true;
    renderSelected();
    expect(screen.getByText('Loading WI-1…')).toBeTruthy();
    expect(screen.queryByText('No deliverable found for WI-1.')).toBeNull();
  });

  it('routes a WI- selection to the workItem kind', () => {
    expect(resolveSelectionKind('WI-42')).toBe('workItem');
  });

  it('EI-19917451944474469: the no-selection empty state renders under a stable, addressable class', () => {
    // Regression guard for the second, independent defect filed on
    // EI-19917451944474469: adv-dep-graph-interlock.spec.ts asserted the
    // "Pick a work item…" placeholder INSIDE `.pc-adv-detail`, but that root
    // only mounts once something is selected — DetailPanel early-returns
    // `<Empty>` before it, so the assertion could never pass. The fix gives
    // `Empty` its own stable class (`pc-adv-detail__empty`) instead of
    // nesting the placeholder under a root that structurally cannot exist
    // yet. This test pins BOTH halves of that contract at the component
    // level, cheaper and faster than the full Playwright mount.
    const { container } = render(
      <NuqsTestingAdapter searchParams="">
        <DetailPanel
          panelId={'p1' as never}
          panelType={'detail' as never}
          params={{ harnessSlug: 'h1' } as never}
          api={{ setTitle: vi.fn() } as never}
        />
      </NuqsTestingAdapter>,
    );
    // `.pc-adv-detail` must NOT exist with nothing selected — its presence/absence
    // is itself a signal other code (and this same work item's live-webview
    // measurement) relies on to mean "something is selected".
    expect(container.querySelector('.pc-adv-detail')).toBeNull();
    const empty = container.querySelector('.pc-adv-detail__empty');
    expect(empty, 'the empty state must render under .pc-adv-detail__empty').toBeTruthy();
    expect(empty!.textContent).toBe('Pick a deliverable from the list to inspect.');
  });

  it('uses one-row detail authority and never depends on byHarness page membership', () => {
    render(
      <NuqsTestingAdapter searchParams="?sel=WI-1">
        <DetailPanel
          panelId={'p1' as never}
          panelType={'detail' as never}
          params={{ harnessSlug: 'h1' } as never}
          api={{ setTitle: vi.fn() } as never}
        />
      </NuqsTestingAdapter>,
    );
    const list = syncCalls.find((c) => c.queryName === 'workItems.byHarness' && c.enabled !== false);
    expect(list, 'detail must not depend on a bounded list page').toBeUndefined();
    const detail = syncCalls.find((c) => c.queryName === 'workItems.detail' && c.enabled !== false);
    expect(detail?.args).toEqual({ harnessSlug: 'h1', id: 'WI-1' });
    expect(detail?.requestClass, 'selected detail must use the shared scheduler interactive reservation').toBe('interactive-control');
  });
});
