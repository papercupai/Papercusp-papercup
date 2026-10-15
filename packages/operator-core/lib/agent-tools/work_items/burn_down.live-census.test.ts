/**
 * WI-6554700010008464 — the live burn_down census must keep the OPEN partition exact
 * when terminal history exceeds the row cap. The old single all-state read (capped at
 * WORK_ITEMS_MAX_LIMIT, newest `updated_ts` first) let terminal history fill the cap:
 * on 2026-10-11 it reported 543 open papercusp bugs against 2,971 real ones.
 */
import { describe, expect, it, vi } from 'vitest';
import { WORK_ITEMS_MAX_LIMIT, type WorkItem } from '../../work-items';
import {
  buildBurnDownCountEvidence,
  buildBurnDownResult,
  NON_TERMINAL_CENSUS_CEILING,
  readLiveCensus,
  type LiveCensusDeps,
} from './burn_down';

function row(id: string, state: string, updatedAt: string, extra: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    kind: 'bug',
    family: 'issue',
    harness: 'papercusp',
    state,
    title: id,
    assignee: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt,
    closedAt: state === 'open' ? null : updatedAt,
    terminalOwner: state === 'open' ? null : 'su-closer',
    completionAuthority: state === 'open' ? null : 'committed',
    payload: {},
    ...extra,
  } as unknown as WorkItem;
}

function rows(n: number, prefix: string, state: string, updatedAt: string): WorkItem[] {
  return Array.from({ length: n }, (_, i) => row(`${prefix}-${i}`, state, updatedAt));
}

describe('readLiveCensus (WI-6554700010008464)', () => {
  it('reads every open row even when terminal history alone fills the cap', async () => {
    const open = rows(2_971, 'open', 'open', '2026-10-11T05:00:00.000Z');
    const history = rows(WORK_ITEMS_MAX_LIMIT, 'done', 'done', '2026-10-11T06:00:00.000Z');
    const deps: LiveCensusDeps = {
      countWorkItems: vi.fn(async () => open.length),
      listAllWorkItemsForFileExport: vi.fn(async () => open),
      listWorkItems: vi.fn(async () => history),
      countWorkItemsByState: vi.fn(async () => ({ open: 2_971, done: 53_000, dropped: 664 })),
    };

    const live = await readLiveCensus({ harness: 'papercusp', kind: 'bug' }, { exactTerminalTotals: true }, deps);

    expect(deps.listAllWorkItemsForFileExport).toHaveBeenCalledWith({ harness: 'papercusp', kind: 'bug', notTerminal: true });
    const historyCall = vi.mocked(deps.listWorkItems).mock.calls[0]![0]!;
    expect(historyCall.states).toEqual(expect.arrayContaining(['done', 'dropped', 'resolved', 'closed']));
    expect(historyCall.notTerminal).toBeUndefined();
    expect(live.items).toHaveLength(2_971 + WORK_ITEMS_MAX_LIMIT);
    expect(live.nonTerminal).toEqual({ counted: 2_971, read: 2_971, limit: NON_TERMINAL_CENSUS_CEILING, truncatedByLimit: false });
    expect(live.terminalHistory).toEqual({
      limit: WORK_ITEMS_MAX_LIMIT,
      truncatedByLimit: true,
      oldestUpdatedAt: '2026-10-11T06:00:00.000Z',
    });

    const result = buildBurnDownResult(live.items, new Set(), {
      harness: 'papercusp',
      censusLimit: live.nonTerminal.limit,
      sourceCapExhausted: live.nonTerminal.truncatedByLimit,
      terminalStateCounts: live.terminalStateCounts,
      terminalHistory: live.terminalHistory,
    });
    expect(result.counts.unclaimed + result.counts.inFlight + result.counts.parked).toBe(2_971);
    expect(result.counts.terminal).toBe(53_664);
    expect(result.terminal.done).toBe(53_000);
    expect(result.terminal.dropped).toBe(664);
    expect(result.counts.total).toBe(2_971 + 53_664);
    expect(result.terminal.truncatedByLimit).toBe(false);
    expect(result.terminal.history).toMatchObject({
      totalsSource: 'aggregate',
      rowsRead: WORK_ITEMS_MAX_LIMIT,
      truncatedByLimit: true,
      authorityExact: false,
      deltaExact: null,
    });
    // The authority split stays slice-derived: it counts only the rows read.
    expect(result.terminal.authority.committed).toBe(WORK_ITEMS_MAX_LIMIT);

    const evidence = buildBurnDownCountEvidence(result, { requestedIds: null, kind: 'bug' });
    expect(evidence.metrics.unclaimed.exactness).toEqual({ status: 'exact' });
    expect(evidence.metrics.terminal.value).toBe(53_664);
  });

  it('falls back to a capped open read above the ceiling and says the census is bounded', async () => {
    const capped = rows(WORK_ITEMS_MAX_LIMIT, 'open', 'open', '2026-10-11T05:00:00.000Z');
    const deps: LiveCensusDeps = {
      countWorkItems: vi.fn(async () => NON_TERMINAL_CENSUS_CEILING + 1),
      listAllWorkItemsForFileExport: vi.fn(async () => {
        throw new Error('the uncapped read must not run above the ceiling');
      }),
      listWorkItems: vi.fn(async (filter) => (filter?.notTerminal ? capped : [])),
      countWorkItemsByState: vi.fn(async () => ({ open: NON_TERMINAL_CENSUS_CEILING + 1 })),
    };

    const live = await readLiveCensus({ harness: 'papercusp' }, { exactTerminalTotals: true }, deps);

    expect(deps.listAllWorkItemsForFileExport).not.toHaveBeenCalled();
    expect(live.nonTerminal).toEqual({
      counted: NON_TERMINAL_CENSUS_CEILING + 1,
      read: WORK_ITEMS_MAX_LIMIT,
      limit: WORK_ITEMS_MAX_LIMIT,
      truncatedByLimit: true,
    });
    const result = buildBurnDownResult(live.items, new Set(), {
      harness: 'papercusp',
      censusLimit: live.nonTerminal.limit,
      sourceCapExhausted: live.nonTerminal.truncatedByLimit,
      terminalStateCounts: live.terminalStateCounts,
      terminalHistory: live.terminalHistory,
    });
    const evidence = buildBurnDownCountEvidence(result, { requestedIds: null });
    expect(evidence.metrics.unclaimed.exactness).toMatchObject({ status: 'bounded', bound: 'lower', limit: WORK_ITEMS_MAX_LIMIT });
  });

  it('skips the unfenced aggregate when terminal totals must stay row-derived', async () => {
    const deps: LiveCensusDeps = {
      countWorkItems: vi.fn(async () => 0),
      listAllWorkItemsForFileExport: vi.fn(async () => []),
      listWorkItems: vi.fn(async () => []),
      countWorkItemsByState: vi.fn(async () => ({})),
    };
    const live = await readLiveCensus({ harness: 'papercusp' }, { exactTerminalTotals: false }, deps);
    expect(deps.countWorkItemsByState).not.toHaveBeenCalled();
    expect(live.terminalStateCounts).toBeUndefined();
  });
});

describe('buildBurnDownResult terminal.history delta coverage (WI-6554700010008464)', () => {
  const history = [
    row('a', 'done', '2026-10-11T06:30:00.000Z'),
    row('b', 'done', '2026-10-11T05:30:00.000Z'),
  ];
  const build = (since: string | null, truncatedByLimit: boolean) =>
    buildBurnDownResult(history, new Set(), {
      harness: 'papercusp',
      since,
      terminalStateCounts: { done: 9_999 },
      terminalHistory: { limit: 2, truncatedByLimit, oldestUpdatedAt: '2026-10-11T05:30:00.000Z' },
    });

  it('is exact when a capped slice still reaches back past `since`', () => {
    const result = build('2026-10-11T06:00:00.000Z', true);
    expect(result.terminal.history?.deltaExact).toBe(true);
    expect(result.terminal.delta).toBe(1);
    expect(result.terminal.total).toBe(9_999);
  });

  it('is not exact when the capped slice stops short of `since`', () => {
    expect(build('2026-10-11T05:00:00.000Z', true).terminal.history?.deltaExact).toBe(false);
  });

  it('is exact whenever the slice was not capped, and null without `since`', () => {
    expect(build('2026-10-11T05:00:00.000Z', false).terminal.history?.deltaExact).toBe(true);
    expect(build(null, true).terminal.history?.deltaExact).toBeNull();
  });

  it('leaves a fixed-id census unchanged: no aggregate, no history, total = rows', () => {
    const result = buildBurnDownResult(history, new Set(), { harness: 'papercusp' });
    expect(result.terminal.history).toBeUndefined();
    expect(result.counts.total).toBe(2);
    expect(result.terminal.total).toBe(2);
  });
});
