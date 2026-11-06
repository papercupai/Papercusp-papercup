// @vitest-environment jsdom
/**
 * ReportBlockCard component tests — renders the shared ReportBlock
 * (two-tier plan→item) as a card body. The same renderer serves the
 * Inbox detail pane (operator-report attention items) and any
 * CardSpec.report body inside AskChoiceCard.
 *
 * Plan: report-cards-inbox-reconciliation-2026-06-05 (P-006; formerly
 * structured-report-protocol P-007's OperatorReportCard test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { createHash, webcrypto } from 'node:crypto';
import { serializeGoalOwnerReportSnapshot } from '@papercusp/chat-protocol';
import { goalOwnerReportFixture } from '../../../../../packages/operator-core/test/fixtures/goal-owner-report';
import type { ReactElement } from 'react';

const fetchSyncQuery = vi.hoisted(() => vi.fn());
const reportMarkdownParses = vi.hoisted(() => vi.fn());
const render = (ui: ReactElement) => rtlRender(<NuqsTestingAdapter searchParams="">{ui}</NuqsTestingAdapter>);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('resolves a bare report reference in a report line without opening another window', async () => {
  const reportId = 'rpt_c6a650d3-4b68-4bef-9169-8bf4fe69f998';
  const { container } = render(<ReportBlockCard report={{
    title: 'Audit results',
    plans: [{ slug: 'reference-links', title: 'Reference links', status: 'active',
      items: [{ id: 'P-001', status: 'done', text: `Read ${reportId}.` }] }],
  }} />);
  const link = await screen.findByRole('link', { name: reportId });
  expect(link.getAttribute('href')).toBe(`/reports?sel=${reportId}`);
  expect(link.getAttribute('target')).toBeNull();
  expect(container.textContent).toContain(`Read ${reportId}.`);
});

vi.mock('@papercusp/sync', () => ({
  fetchSyncQuery,
  onSyncBusEvent: () => () => {},
  useSyncQuery: () => ({
    data: [],
    loading: false,
    fetching: false,
    transport: 'sse' as const,
    invalidate: () => {},
    error: null,
  }),
}));

vi.mock('./remark-work-refs', async (importOriginal) => {
  const original = await importOriginal<typeof import('./remark-work-refs')>();
  return {
    ...original,
    remarkWorkRefs: (...args: Parameters<typeof original.remarkWorkRefs>) => {
      reportMarkdownParses();
      return original.remarkWorkRefs(...args);
    },
  };
});

import { ReportBlockCard } from './ReportBlockCard';
import type { ReportBlock } from '@papercusp/chat-protocol';

const report: ReportBlock = {
  title: 'Fleet status',
  plans: [
    {
      slug: 'rate-limit-layer-v2',
      title: 'Rate-limit v2',
      status: 'active',
      summary: 'top half of the layer',
      items: [
        { id: 'P-001', text: 'Error classifier', status: 'done' },
        { id: 'P-003', text: 'Per-call pacing', status: 'wip' },
      ],
    },
    { title: 'Header-only plan', status: 'blocked' },
  ],
};

describe('REPORT-PINNED-DETAIL-P003 operator expansion', () => {
  const snapshot = goalOwnerReportFixture('workspace-card');
  const bodyMd = serializeGoalOwnerReportSnapshot(snapshot);
  const bodySha256 = createHash('sha256').update(bodyMd).digest('hex');
  const reference = { schemaVersion: 1 as const, reportId: 'report-original', goalId: snapshot.goalId, bodySha256 };
  const pinned: ReportBlock = { title: 'Goal progress', plans: [], goalReport: reference };
  beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    fetchSyncQuery.mockReset().mockResolvedValue([{ report_id: reference.reportId, workspace_id: snapshot.workspaceId,
      body_md: bodyMd, body_sha256: bodySha256, goal_owner_report: snapshot, subject: { kind: 'goal', ref: snapshot.goalId } }]);
  });
  it('expands the persisted pin through the named sync seam and the registry Button', async () => {
    const { container } = render(<ReportBlockCard report={pinned} />);
    const button = screen.getByRole('button', { name: 'Expand full report' });
    expect(button.classList.contains('pc-btn')).toBe(true);
    expect(fetchSyncQuery).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(container.querySelector('.report-block-goal-body')?.textContent).toBe(bodyMd));
    expect(fetchSyncQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ queryName: 'reports.get', args: { reportId: reference.reportId }, staleTime: Infinity }));
    for (const wall of snapshot.ownerWalls) expect(container.textContent).toContain(wall.exactAction);
    expect(container.querySelector('.report-block-plan')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse full report' }));
    expect(container.querySelector('.report-block-goal-body')).toBeNull();
  });
  it('restores the pinned expansion from URL state and clears only its own pin on collapse', async () => {
    const onUrlUpdate = vi.fn();
    rtlRender(<NuqsTestingAdapter searchParams="?goalReport=report-original" onUrlUpdate={onUrlUpdate}>
      <ReportBlockCard report={pinned} />
    </NuqsTestingAdapter>);
    await screen.findByText(`Historical snapshot · observed at ${snapshot.observedAt}`);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse full report' }));
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    expect(onUrlUpdate.mock.lastCall?.[0].queryString).not.toContain('goalReport');
  });
  it.each([
    { label: 'missing', rows: [] },
    { label: 'substituted', rows: [{ report_id: 'report-successor' }] },
  ])('shows a recoverable error for $label pins', async ({ rows }) => {
    fetchSyncQuery.mockResolvedValue(rows);
    const { container } = render(<ReportBlockCard report={pinned} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand full report' }));
    await screen.findByRole('alert');
    expect(container.querySelector('.report-block-goal-body')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry loading report' })).toBeTruthy();
  });
});

describe('ReportBlockCard', () => {
  it('defers first report parsing, then reuses unchanged markdown across status refreshes', async () => {
    reportMarkdownParses.mockClear();
    const firstActivate = vi.fn();
    const nextActivate = vi.fn();
    const makeReport = (status: string, text = 'See **WI-37945**'): ReportBlock => ({
      plans: [{ title: 'Progress', items: [{ id: 'P-001', text, status }] }],
    });
    const { container, rerender } = rtlRender(<ReportBlockCard report={makeReport('wip')} harnessSlug="papercusp" onWorkRefActivate={firstActivate} />);
    expect(reportMarkdownParses).not.toHaveBeenCalled();
    expect(container.querySelector('.report-block-item-text')?.textContent).toBe('See **WI-37945**');
    await waitFor(() => expect(reportMarkdownParses).toHaveBeenCalled());
    const initialParses = reportMarkdownParses.mock.calls.length;
    expect(initialParses).toBeGreaterThan(0);
    rerender(<ReportBlockCard report={makeReport('done')} harnessSlug="papercusp" onWorkRefActivate={firstActivate} />);
    expect(reportMarkdownParses).toHaveBeenCalledTimes(initialParses);
    expect(screen.getByTitle('done')).toBeTruthy();

    rerender(<ReportBlockCard report={makeReport('done', 'Updated **WI-6601**')} harnessSlug="papercusp" onWorkRefActivate={nextActivate} />);
    await waitFor(() => expect(reportMarkdownParses.mock.calls.length).toBeGreaterThan(initialParses));
    expect(screen.queryByLabelText('WI-37945')).toBeNull();
    fireEvent.click(screen.getByLabelText('WI-6601'));
    expect(nextActivate).toHaveBeenCalledWith({ id: 'WI-6601', kind: 'work-item', planSlug: undefined });
    expect(firstActivate).not.toHaveBeenCalled();
  });

  it('renders the title, plan titles, statuses, summary, and item rows', () => {
    render(<ReportBlockCard report={report} />);
    expect(screen.getByText('Fleet status')).toBeTruthy();
    expect(screen.getByText('Rate-limit v2')).toBeTruthy();
    expect(screen.getByText('top half of the layer')).toBeTruthy();
    expect(screen.getByText('Error classifier')).toBeTruthy();
    expect(screen.getByText('Per-call pacing')).toBeTruthy();
    expect(screen.getByText('P-001')).toBeTruthy();
    // A header-only plan (no items) still renders its title.
    expect(screen.getByText('Header-only plan')).toBeTruthy();
  });

  it('maps known statuses to a tone (glyph data-tone)', () => {
    const { container } = render(<ReportBlockCard report={report} />);
    // done → good tone, wip → accent tone somewhere in the tree.
    expect(container.querySelector('.report-block-glyph[data-tone="good"]')).toBeTruthy();
    expect(container.querySelector('.report-block-glyph[data-tone="accent"]')).toBeTruthy();
    expect(container.querySelector('.report-block-glyph[data-tone="bad"]')).toBeTruthy();
  });

  it('renders nothing when there are no plans', () => {
    const { container } = render(<ReportBlockCard report={{ plans: [] }} />);
    expect(container.querySelector('.report-block-card')).toBeNull();
  });

  // deterministic-status-cards-2026-07-17 P-003/D-004: the curator card's
  // actionable drill-in — the row `ref` renders as a real button.
  const curatorCard: ReportBlock = {
    plans: [
      {
        title: 'Fleet status',
        items: [
          { text: '**Blocked** [infra-liveness] — no bees running', status: 'blocked', ref: 'escalation:e1' },
          { text: 'a row with no ref', status: 'wip' },
        ],
      },
    ],
  };

  it('renders a drill-in button for a row with a ref when onDrillIn is provided, and fires it with the ref', () => {
    const onDrillIn = vi.fn();
    render(<ReportBlockCard report={curatorCard} onDrillIn={onDrillIn} />);
    const btn = screen.getByRole('button', { name: /open/i });
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onDrillIn).toHaveBeenCalledWith('escalation:e1');
  });

  it('renders item markdown instead of exposing the producer syntax', async () => {
    const { container } = render(<ReportBlockCard report={curatorCard} />);
    await waitFor(() => expect(container.querySelector('.report-block-item-text strong')?.textContent).toBe('Blocked'));
    const itemText = container.querySelector('.report-block-item-text');
    expect(itemText?.querySelector('strong')?.textContent).toBe('Blocked');
    expect(itemText?.textContent).toContain('Blocked');
    expect(itemText?.textContent).not.toContain('**');
  });

  it('uses the existing work-ref markdown plugin and hydrated pill renderer', async () => {
    const refReport: ReportBlock = {
      plans: [{ title: 'Refs', items: [{ text: 'See WI-37945 and P-003', status: 'wip' }] }],
    };
    render(<ReportBlockCard report={refReport} harnessSlug="papercusp" planSlug="nonp2p-bug-drain-2026-08-08" />);
    await screen.findByLabelText('WI-37945');
    expect(screen.getByLabelText('P-003')).toBeTruthy();
  });

  it('renders NO drill-in for a row without a ref (only the ref row gets a button)', () => {
    const onDrillIn = vi.fn();
    const { container } = render(<ReportBlockCard report={curatorCard} onDrillIn={onDrillIn} />);
    // exactly one drill button (the ref row), not one per row.
    expect(container.querySelectorAll('.report-block-item-drill')).toHaveLength(1);
  });

  it('renders inert (no buttons) when onDrillIn is omitted — the inbox/report uses are unchanged', () => {
    const { container } = render(<ReportBlockCard report={curatorCard} />);
    expect(container.querySelector('.report-block-item-drill')).toBeNull();
  });
});

/**
 * WI-10001541 — the report card is the THIRD pill site on the same seam.
 *
 * `ChatMarkdown` and `ReportItemText` (both in @papercusp/operator-ui) were
 * gated on `canOpenWorkRef`; this renderer is the operator's own copy of that
 * splice, wired to the SAME `handleWorkRefActivate` in OperatorChat, and it
 * still decided a pill's tag from "did the host wire a seam?" instead of "does
 * this ref resolve to anywhere?". Its `planSlug` comes from `turn?.planSlug`,
 * which is null for essentially every real turn — so this was the site most
 * likely to render the dead `<button>` in practice, not the least.
 *
 * Fixing two of three sites would have left the bug reachable while every test
 * passed, which is precisely what these assertions exist to prevent.
 */
describe('ReportBlockCard — an unopenable ref must not render as a control (WI-10001541)', () => {
  const refReport: ReportBlock = {
    plans: [{ title: 'Refs', items: [{ text: 'See WI-6601 and P-003', status: 'wip' }] }],
  };

  it('renders an openable work-item ref as a button and an unscoped plan-item ref as inert text, in the SAME card', async () => {
    // One card, one wired seam, one harness — so the ONLY thing separating the
    // two pills is whether the ref resolves to somewhere to go.
    render(
      <ReportBlockCard report={refReport} harnessSlug="papercusp" onWorkRefActivate={() => {}} />,
    );
    await screen.findByLabelText('WI-6601');

    expect(screen.getByLabelText('WI-6601').tagName).toBe('BUTTON');
    expect(screen.getByLabelText('P-003').tagName).toBe('SPAN');
  });

  it('renders a plan-item ref as a real control once the card carries its plan', async () => {
    // The mirror: the pill is inert because the ref cannot be resolved, NOT
    // because plan refs are second-class. Without this, making every plan pill
    // inert unconditionally would also pass.
    render(
      <ReportBlockCard
        report={refReport}
        harnessSlug="papercusp"
        planSlug="portal-parity-2026-09-05"
        onWorkRefActivate={() => {}}
      />,
    );

    await screen.findByLabelText('P-003');
    expect(screen.getByLabelText('P-003').tagName).toBe('BUTTON');
  });

  it('renders no control at all when the host wired no seam', async () => {
    render(<ReportBlockCard report={refReport} harnessSlug="papercusp" />);

    expect((await screen.findByLabelText('WI-6601')).tagName).toBe('SPAN');
    expect(screen.getByLabelText('P-003').tagName).toBe('SPAN');
  });
});
