/**
 * P-005 of deterministic-plan-state-derivation-2026-08-31.
 *
 * The DECISION these tests are about is already covered where it lives
 * (`plan-status-transition.test.ts` in @papercusp/plan-parser). What is tested
 * here is everything the sweep adds AROUND that decision — the candidate
 * superset, the exclusions, the cap, and the staleness absorption — because each
 * of those is a place where a sweep can be silently wrong rather than loudly
 * broken.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanItem } from '@papercusp/plan-parser';

const M = vi.hoisted(() => ({
  list: vi.fn(),
  apply: vi.fn(),
  inScope: vi.fn(),
}));

vi.mock('./source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source')>();
  return { ...actual, listPlanIndexRowsForWorkspace: M.list };
});
vi.mock('./plan-drain-transition', () => ({ applyPlanDrainTransition: M.apply }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-under-test' }));
vi.mock('../../work-scope-policy', () => ({
  isHarnessInScope: M.inScope,
  primeWorkScopePolicy: vi.fn(),
}));

import {
  DEFAULT_PLAN_DRAIN_SWEEP_CAP,
  PLAN_DRAIN_SWEEP_SOURCE_STATUSES,
  planDrainSweepCandidate,
  sweepDrainedPlanStatuses,
} from './plan-drain-sweep';

const item = (id: string, status: string): PlanItem =>
  ({
    id,
    text: id,
    storedStatus: status,
    importance: 'normal',
    blockedBy: [],
    decisionRefs: [],
    phase: null,
    lineNumber: 0,
    rawLine: '',
  }) as unknown as PlanItem;

/** A minimal index row — only the fields the sweep reads are load-bearing. */
const row = (planSlug: string, status: string, itemStatuses: string[]) =>
  ({
    planSlug,
    harnessSlug: 'papercusp',
    status,
    items: itemStatuses.map((s, i) => ({
      id: `P-00${i + 1}`,
      text: `item ${i + 1}`,
      status: s,
      importance: 'normal',
      blockedBy: [],
      decisionRefs: [],
      phase: null,
    })),
  }) as never;

beforeEach(() => {
  M.list.mockReset();
  M.apply.mockReset();
  M.inScope.mockReset();
  M.inScope.mockReturnValue(true);
  M.list.mockResolvedValue([]);
  M.apply.mockResolvedValue({ applied: true, from: 'ready', to: 'awaiting-acceptance', reason: 'r' });
});

describe('planDrainSweepCandidate', () => {
  it('warrants the forward edge on a drained ready plan', () => {
    expect(planDrainSweepCandidate('ready', [item('P-001', 'done'), item('P-002', 'dropped')])).toEqual({
      from: 'ready',
      to: 'awaiting-acceptance',
    });
  });

  it('warrants the reverse edge when an item is live again', () => {
    expect(
      planDrainSweepCandidate('awaiting-acceptance', [item('P-001', 'done'), item('P-002', 'todo')]),
    ).toEqual({ from: 'awaiting-acceptance', to: 'ready' });
  });

  // CONTROL for the exclusion that matters most (D-005 point 4): a `draft` plan
  // is drained by exactly the same graph the forward-edge case above uses, so if
  // this ever returns a transition, the draft exclusion has silently died while
  // every other test still passes.
  it('abstains on a DRAFT plan whose graph is drained', () => {
    expect(planDrainSweepCandidate('draft', [item('P-001', 'done')])).toBeNull();
  });

  it('abstains on terminal statuses and on an itemless plan', () => {
    expect(planDrainSweepCandidate('shipped', [item('P-001', 'done')])).toBeNull();
    expect(planDrainSweepCandidate('superseded', [item('P-001', 'done')])).toBeNull();
    expect(planDrainSweepCandidate('ready', [])).toBeNull();
  });
});

describe('sweepDrainedPlanStatuses candidate enumeration', () => {
  it('queries exactly the three stored statuses the decision can move a plan off, non-archived', async () => {
    await sweepDrainedPlanStatuses();
    expect(M.list).toHaveBeenCalledTimes(PLAN_DRAIN_SWEEP_SOURCE_STATUSES.length);
    for (const status of PLAN_DRAIN_SWEEP_SOURCE_STATUSES) {
      expect(M.list).toHaveBeenCalledWith({
        workspaceId: 'ws-under-test',
        status,
        includeArchived: false,
        includeItems: true,
      });
    }
  });

  // `draft` is the one live status deliberately outside the sweep's jurisdiction,
  // and the cheapest way to leak it would be to add it to the query list.
  it('never queries draft', async () => {
    await sweepDrainedPlanStatuses();
    expect(M.list).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
  });

  // The instance exclusion is load-bearing: reconcile-plan-runs supersedes a
  // finished scheduled-plan instance under a literal `AND status = 'active'`
  // guard, which an `awaiting-acceptance` flip would silently defeat. The reader
  // excludes instances by DEFAULT, so the guard is "we never opt in".
  it('never opts into scheduled-plan instances', async () => {
    await sweepDrainedPlanStatuses();
    for (const call of M.list.mock.calls) {
      expect(call[0].includeInstances).toBeUndefined();
      expect(call[0].templateSlug).toBeUndefined();
    }
  });

  it('records a scope refusal against the plan that was refused', async () => {
    M.list.mockImplementation(async ({ status }: { status: string }) =>
      status === 'ready' ? [row('out-of-scope', 'ready', ['done'])] : [],
    );
    M.inScope.mockReturnValue(false);

    const result = await sweepDrainedPlanStatuses();

    expect(result.skipped).toEqual({ scope_denied: 1 });
    expect(result.outcomes).toEqual([
      {
        planSlug: 'out-of-scope',
        harnessSlug: 'papercusp',
        outcome: 'scope_denied',
        reason: 'out_of_scope',
      },
    ]);
    expect(M.apply).not.toHaveBeenCalled();
  });

  it('applies only the rows whose graph warrants a move', async () => {
    M.list.mockImplementation(async ({ status }: { status: string }) =>
      status === 'ready'
        ? [row('drained', 'ready', ['done', 'done']), row('still-live', 'ready', ['done', 'wip'])]
        : [],
    );

    const result = await sweepDrainedPlanStatuses();

    expect(result.scanned).toBe(2);
    expect(result.warranted).toBe(1);
    expect(M.apply).toHaveBeenCalledExactlyOnceWith('drained', 'papercusp');
    expect(result.applied).toEqual([
      { planSlug: 'drained', harnessSlug: 'papercusp', from: 'ready', to: 'awaiting-acceptance', reason: 'r' },
    ]);
    expect(result.outcomes).toEqual([
      {
        planSlug: 'drained',
        harnessSlug: 'papercusp',
        outcome: 'applied',
        from: 'ready',
        to: 'awaiting-acceptance',
        reason: 'r',
      },
    ]);
  });
});

describe('sweepDrainedPlanStatuses bounding and staleness', () => {
  const drainedRows = (n: number) =>
    Array.from({ length: n }, (_, i) => row(`plan-${i}`, 'ready', ['done']));

  it('flips at most `cap` plans and reports the rest as deferred, not lost', async () => {
    M.list.mockImplementation(async ({ status }: { status: string }) =>
      status === 'ready' ? drainedRows(7) : [],
    );

    const result = await sweepDrainedPlanStatuses({ cap: 3 });

    expect(result.warranted).toBe(7);
    expect(result.applied).toHaveLength(3);
    expect(result.deferredToNextTick).toBe(4);
    expect(M.apply).toHaveBeenCalledTimes(3);
    expect(result.outcomes.filter((outcome) => outcome.outcome === 'deferred')).toHaveLength(4);
    expect(result.outcomes.filter((outcome) => outcome.outcome === 'applied')).toHaveLength(3);
  });

  // CONTROL for the cap: without it the same input would flip all 7. If the cap
  // is ever dropped, the test above fails AND this one shows the uncapped shape
  // is what the sweep would otherwise do — so the failure reads as "the cap went
  // missing", not "the fixture changed".
  it('flips every warranted plan when the cap exceeds the backlog', async () => {
    M.list.mockImplementation(async ({ status }: { status: string }) =>
      status === 'ready' ? drainedRows(7) : [],
    );

    const result = await sweepDrainedPlanStatuses({ cap: 100 });

    expect(result.applied).toHaveLength(7);
    expect(result.deferredToNextTick).toBe(0);
  });

  it('defaults the cap rather than running unbounded', async () => {
    M.list.mockImplementation(async ({ status }: { status: string }) =>
      status === 'ready' ? drainedRows(DEFAULT_PLAN_DRAIN_SWEEP_CAP + 4) : [],
    );

    const result = await sweepDrainedPlanStatuses();

    expect(result.applied).toHaveLength(DEFAULT_PLAN_DRAIN_SWEEP_CAP);
    expect(result.deferredToNextTick).toBe(4);
  });

  // The whole point of re-deriving inside the plan lock: a candidate that went
  // stale between the two reads must cost one wasted lock and write NOTHING —
  // and must be reported, not counted as applied.
  it('absorbs a locked re-derivation that disagrees with the pre-derivation', async () => {
    M.list.mockImplementation(async ({ status }: { status: string }) =>
      status === 'ready' ? drainedRows(2) : [],
    );
    M.apply.mockResolvedValue({ applied: false, skipped: 'no_transition_warranted' });

    const result = await sweepDrainedPlanStatuses();

    expect(result.warranted).toBe(2);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual({ no_transition_warranted: 2 });
    expect(result.outcomes).toEqual([
      { planSlug: 'plan-0', harnessSlug: 'papercusp', outcome: 'skipped', reason: 'no_transition_warranted' },
      { planSlug: 'plan-1', harnessSlug: 'papercusp', outcome: 'skipped', reason: 'no_transition_warranted' },
    ]);
  });

  it('records a lock contention as busy and keeps sweeping the rest', async () => {
    M.list.mockImplementation(async ({ status }: { status: string }) =>
      status === 'ready' ? drainedRows(3) : [],
    );
    M.apply
      .mockResolvedValueOnce({ applied: false, skipped: 'busy' })
      .mockResolvedValue({ applied: true, from: 'ready', to: 'awaiting-acceptance', reason: 'r' });

    const result = await sweepDrainedPlanStatuses();

    expect(result.skipped).toEqual({ busy: 1 });
    expect(result.applied).toHaveLength(2);
    expect(result.outcomes).toEqual(
      expect.arrayContaining([
        { planSlug: 'plan-0', harnessSlug: 'papercusp', outcome: 'skipped', reason: 'busy' },
      ]),
    );
  });
});
