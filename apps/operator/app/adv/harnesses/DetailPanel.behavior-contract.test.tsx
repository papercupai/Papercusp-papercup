// @vitest-environment jsdom
/**
 * DetailPanel — behavior-contract panel (P-011).
 *
 * P-016 made applicability behavior-owned rather than plan-owned, so a work item's
 * real contract spans plan namespaces — but that resolution was legible only to the
 * completion gate. A human could see THAT a completion was refused and never WHICH
 * promise, at WHICH revision. This section renders the same resolver port.
 *
 * TWO CLASSES ARE PINNED HERE, and the second is the one this plan exists for:
 *
 *  1. The SUBSCRIPTION contract, mirroring the P-017 prior-attempts suite: resolution
 *     is multi-table, so the section must compute NOTHING until a human opens it. A
 *     regression that drops the `enabled` gate changes no rendered output and only
 *     shows up as every work-item selection paying for a read it never displays.
 *
 *  2. The ADVISORY contract (plan D-017/D-018). The resolver REPORTS; P-013 owns
 *     turning any of it into a refusal. So a populated `impact.report` must render as
 *     a NOTICE, never as a failure — showing a human a blocking-looking error for a
 *     clause no gate blocks on is exactly what D-017 was written to prevent. And a
 *     clause's REVISION must never be rendered without it, since a coverage claim
 *     detached from the revision it was earned against is the defect this whole plan
 *     is about.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

type SyncCall = { queryName: string; enabled?: boolean; args?: Record<string, unknown> };
const { syncCalls, contractRow, workItemOverrides } = vi.hoisted(() => ({
  syncCalls: [] as SyncCall[],
  contractRow: { current: null as unknown },
  workItemOverrides: { current: {} as Record<string, unknown> },
}));

const WORK_ITEM = {
  id: 'WI-1',
  harness: 'h1',
  family: 'issue',
  kind: 'bug',
  title: 'a selected work item',
  state: 'open',
};

vi.mock('@papercusp/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/sync')>()),
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: { queryName: string; enabled?: boolean; args?: Record<string, unknown> }) => {
    syncCalls.push({ queryName: opts.queryName, enabled: opts.enabled, args: opts.args });
    const enabled = opts.enabled !== false;
    let data: unknown[] = [];
    if (enabled && opts.queryName === 'workItems.detail') data = [{ ...WORK_ITEM, ...workItemOverrides.current }];
    if (enabled && opts.queryName === 'workItems.behaviorContract' && contractRow.current) {
      data = [contractRow.current];
    }
    return {
      data,
      loading: false,
      fetching: false,
      transport: 'sse' as const,
      invalidate: () => {},
      error: null,
    };
  },
}));
vi.mock('./useHarnessData', () => ({
  useHarnessFeature: () => ({ feature: null, loading: false, error: null, patchFeature: vi.fn() }),
  useHarnessIssues: () => ({ issues: [], patchIssue: vi.fn() }),
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('@papercusp/papercusp-shared', () => ({ openFeatureChat: vi.fn() }));
vi.mock('../../harness/FeatureEditor', () => ({ default: () => null }));

import DetailPanel from './DetailPanel';
import { CHAT_PLAN_POPUP_PARAM } from '../../_components/chat/chat-ref-popup-params';

function renderDetail(searchParams: string, onUrlUpdate = vi.fn()) {
  return render(
    <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
      <DetailPanel
        panelId={'p1' as never}
        panelType={'detail' as never}
        params={{ harnessSlug: 'h1' } as never}
        api={{ setTitle: vi.fn() } as never}
      />
    </NuqsTestingAdapter>,
  );
}

const contractCalls = () => syncCalls.filter((c) => c.queryName === 'workItems.behaviorContract');

/** 'h1::WI-1' is encodeScopedRef(slug, id) — the section follows the SELECTED item. */
const OPEN = '?sel=WI-1&wibc=h1%3A%3AWI-1';

function clause(over: Record<string, unknown> = {}) {
  return {
    specId: 'SPEC-1',
    revision: 3,
    planItemId: 'P-001',
    behavior: 'the gate refuses a stale proof',
    behaviorClass: 'functional',
    lifecycleStatus: 'active',
    enforceable: true,
    falsifier: { observation: 'a ship succeeds with proof only at r1' },
    mutationRequired: false,
    ...over,
  };
}

function row(over: Record<string, unknown> = {}) {
  return {
    workItemId: 'WI-1',
    groups: [{ planSlug: 'plan-a', via: 'plan-stamp', clauses: [clause()], staleEdges: [] }],
    enforceableCount: 1,
    stampedPlanSlug: 'plan-a',
    impact: { required: true, resolved: true, report: null, reason: 'resolved' },
    unavailableReason: null,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  syncCalls.length = 0;
  contractRow.current = null;
  workItemOverrides.current = {};
});

describe('DetailPanel intake acceptance evidence (R-10)', () => {
  it('renders evidence, completion provenance and the governing plan as navigable links', async () => {
    const onUrlUpdate = vi.fn();
    workItemOverrides.current = {
      planSlug: 'intake-plan',
      presentation: {
        stage: 'accepted-ready',
        label: 'Accepted ready',
        reason: 'current acceptance',
        evidenceRefs: ['WI-42', 'https://example.test/evidence', 'test-run:20403529'],
        completionRef: 'test-run:20403528',
      },
    };
    renderDetail('?sel=WI-1', onUrlUpdate);
    expect(screen.getByRole('link', { name: 'https://example.test/evidence' }).getAttribute('href'))
      .toBe('https://example.test/evidence');
    expect(screen.getByText('test-run:20403529').tagName).toBe('CODE');
    expect(screen.getByText('test-run:20403528').tagName).toBe('CODE');
    fireEvent.click(screen.getByRole('button', { name: 'intake-plan · decisions' }));
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    expect(onUrlUpdate.mock.lastCall?.[0].searchParams.get(CHAT_PLAN_POPUP_PARAM)).toBe('h1::intake-plan');
    fireEvent.click(screen.getByRole('button', { name: 'WI-42' }));
    await waitFor(() => expect(onUrlUpdate.mock.lastCall?.[0].searchParams.get('sel')).toBe('WI-42'));
  });
});

describe('DetailPanel behavior-contract subscription (P-011)', () => {
  it('subscribes but stays DISABLED while the section is closed', () => {
    renderDetail('?sel=WI-1');

    const calls = contractCalls();
    // The subscription must EXIST, or the next assertion is vacuous.
    expect(calls.length, 'the behavior-contract query must be wired on a selected work item').toBeGreaterThan(0);
    expect(
      calls.every((c) => c.enabled === false),
      'multi-table clause resolution must not run until a human opens the section',
    ).toBe(true);
  });

  it('ENABLES the query with item-scoped args once the scoped ref opens it', () => {
    renderDetail(OPEN);

    const enabled = contractCalls().find((c) => c.enabled !== false);
    expect(enabled, 'opening the section must enable the query').toBeTruthy();
    expect(enabled?.args).toEqual({ harnessSlug: 'h1', workItemId: 'WI-1' });
  });

  it('stays closed when the scoped ref names a DIFFERENT work item', () => {
    renderDetail('?sel=WI-1&wibc=h1%3A%3AWI-999');
    expect(contractCalls().every((c) => c.enabled === false)).toBe(true);
  });
});

describe('DetailPanel behavior-contract rendering (D-017 advisory contract)', () => {
  it('renders a populated impact.report as an ADVISORY notice, never as a failure', () => {
    // THE D-017 GUARD. `work_items:complete` returns impactReport on the SUCCESS path
    // too, populated independently of `ok`. Rendering it as an error shows a human a
    // blocking failure for a clause nothing enforces yet. Widening this to a failure
    // state must fail this test.
    contractRow.current = row({
      impact: {
        required: true,
        resolved: false,
        report: 'WI-1 is a behavior-changing bug that resolves no active behavior clause.',
        reason: 'unresolved',
      },
    });
    renderDetail(OPEN);

    const advisory = screen.getByTestId('wi-behavior-contract-impact');
    expect(advisory.textContent).toContain('resolves no active behavior clause');
    // The copy itself must say it is not enforced — a bare report reads as a verdict.
    expect(advisory.textContent).toContain('reported, not enforced');
  });

  it('never renders a specId without the revision it was earned against', () => {
    contractRow.current = row();
    renderDetail(OPEN);

    // A coverage claim detached from its revision is the defect this plan exists to
    // end, so the rendered token carries both.
    expect(document.body.textContent).toContain('SPEC-1@r3');
  });

  it('surfaces a stale edge with BOTH revisions, and marks it advisory', () => {
    contractRow.current = row({
      groups: [
        {
          planSlug: 'plan-a',
          via: 'edge',
          clauses: [clause({ revision: 4 })],
          staleEdges: [{ specId: 'SPEC-1', edgeRevision: 2, currentRevision: 4 }],
        },
      ],
    });
    renderDetail(OPEN);

    const stale = screen.getByTestId('wi-behavior-contract-stale');
    expect(stale.textContent).toContain('proof at r2');
    expect(stale.textContent).toContain('clause now r4');
    expect(stale.textContent).toContain('advisory');
  });

  it('shows an undeclared falsifier as an explicit gap rather than a blank (D-016)', () => {
    contractRow.current = row({
      groups: [
        { planSlug: 'plan-a', via: 'plan-stamp', clauses: [clause({ falsifier: null })], staleEdges: [] },
      ],
    });
    renderDetail(OPEN);

    // Blank would read as "declared". D-016: null is an honest, gradeable gap.
    expect(document.body.textContent).toContain('No falsifier declared');
  });

  it('a FAILED resolve does not render as "this item resolves no clauses"', () => {
    // The two are different facts, and collapsing them turns an outage into a false
    // all-clear — the same failure mode the prior-attempts panel guards.
    contractRow.current = row({
      groups: [],
      enforceableCount: 0,
      impact: null,
      unavailableReason: 'resolver-unavailable',
    });
    renderDetail(OPEN);

    const unavailable = screen.getByTestId('wi-behavior-contract-unavailable');
    expect(unavailable.textContent).toContain('NOT evidence');
    expect(document.body.textContent).not.toContain('This item resolves no behavior clauses');
  });
});
