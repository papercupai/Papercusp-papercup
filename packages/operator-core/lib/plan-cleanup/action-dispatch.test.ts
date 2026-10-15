import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sql: { tag: 'sql' },
  reclaimExpiredPlanItemClaims: vi.fn(),
  call: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../plan-items/stale-claims', () => ({
  reclaimExpiredPlanItemClaims: h.reclaimExpiredPlanItemClaims,
}));

import { dispatchCleanupFindingAction } from './action-dispatch';
import type { CleanupFinding } from './scanner';

const run = {
  runId: 'cleanup-1',
  workspaceId: 'ws-1',
  harnessSlug: 'papercusp',
} as never;

function finding(kind: string, itemId: string | null = 'P-001') {
  return {
    findingId: `${kind}:papercusp/plan-a${itemId ? `#${itemId}` : ''}`,
    kind,
    workspaceId: 'ws-1',
    harnessSlug: 'papercusp',
    planSlug: 'plan-a',
    itemId,
    target: 'target',
    from: 'from',
    to: 'to',
    confidence: kind === 'archive-candidate' || kind === 'stale-now' ? 'recommended' : 'provable',
    autoApply: kind !== 'archive-candidate' && kind !== 'stale-now',
    autoApplyBlockedBy: null,
    evidence: [],
  } as CleanupFinding;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.call.mockResolvedValue({ ok: true });
  h.reclaimExpiredPlanItemClaims.mockResolvedValue({
    released: [{ workspace_id: 'ws-1', harness_slug: 'papercusp', plan_slug: 'plan-a', item_id: 'P-001' }],
  });
});

describe('dispatchCleanupFindingAction', () => {
  it('appends an enlist-plan ref through the typed worklist compare-and-set', async () => {
    await dispatchCleanupFindingAction({
      run,
      finding: {
        ...finding('enlist-plan', null),
        action: {
          kind: 'enlist-plan',
          goalId: 'goal-everything',
          planRef: 'plan:papercusp/plan-a',
          worklist: ['plan:papercusp/plan-b'],
          expectedVersion: 4,
        },
      },
      call: h.call,
    });

    expect(h.call).toHaveBeenCalledWith('goals:set-property', {
      goalId: 'goal-everything',
      property: 'worklist',
      value: ['plan:papercusp/plan-b', 'plan:papercusp/plan-a'],
      expectedVersion: 4,
    });
  });

  it.each([
    // Both status flips carry `expectedStatus` — the compare-and-set precondition
    // added by bulk-review-report-legibility-and-lifecycle-2026-08-31 P-011. Its
    // value is the finding's own `from` (what the SCAN saw), which the fixture
    // above sets to the literal 'from', so asserting it here proves the dispatcher
    // FORWARDS the scanned status rather than inventing or dropping it.
    [
      'flip-to-done',
      'plans:set-status',
      { slug: 'plan-a', item: 'P-001', status: 'done', expectedStatus: 'from', harness: 'papercusp' },
    ],
    [
      'cleared-blocker',
      'plans:set-status',
      { slug: 'plan-a', item: 'P-001', status: 'todo', expectedStatus: 'from', harness: 'papercusp' },
    ],
    ['finish-plan', 'plans:set-plan-status', { slug: 'plan-a', status: 'shipped', harness: 'papercusp' }],
    ['archive-candidate', 'plans:set-archived', { slug: 'plan-a', archived: true, harness: 'papercusp' }],
  ])('routes %s through the canonical %s tool', async (kind, tool, args) => {
    await dispatchCleanupFindingAction({
      run,
      finding: finding(kind, kind === 'finish-plan' || kind === 'archive-candidate' ? null : 'P-001'),
      call: h.call,
    });
    expect(h.call).toHaveBeenCalledWith(tool, args);
  });

  it('preserves a failed member detail when the outer bulk envelope is also failed', async () => {
    h.call.mockResolvedValue({
      ok: false,
      results: [{ ok: false, slug: 'plan-a', error: 'acceptance_unaudited', detail: 'no code-truth audit' }],
      counts: { ok: 0, failed: 1 },
    });

    await expect(
      dispatchCleanupFindingAction({
        run,
        finding: finding('finish-plan', null),
        call: h.call,
      }),
    ).rejects.toThrow('plans:set-plan-status: acceptance_unaudited: no code-truth audit');
  });

  it('targets exactly one orphaned claim through the canonical stale-claim reaper', async () => {
    await dispatchCleanupFindingAction({ run, finding: finding('orphaned-claim'), call: h.call });
    expect(h.reclaimExpiredPlanItemClaims).toHaveBeenCalledWith(h.sql, {
      key: {
        workspaceId: 'ws-1',
        harnessSlug: 'papercusp',
        planSlug: 'plan-a',
        itemId: 'P-001',
      },
    });
    expect(h.call).not.toHaveBeenCalled();
  });

  it('keeps stale-Now recommend-only until an authored proposal exists', async () => {
    await expect(
      dispatchCleanupFindingAction({ run, finding: finding('stale-now', null), call: h.call }),
    ).rejects.toThrow(/requires an authored state\/next proposal/);
    expect(h.call).not.toHaveBeenCalled();
  });

  it('dispatches an authored Now update through the canonical validator', async () => {
    await dispatchCleanupFindingAction({
      run, finding: finding('stale-now', null), call: h.call,
      proposal: { state: 'P-002 remains open.', next: 'Implement P-002 and verify its acceptance.' },
    });
    expect(h.call).toHaveBeenCalledWith('plans:set-now', {
      slug: 'plan-a', harness: 'papercusp', state: 'P-002 remains open.',
      next: 'Implement P-002 and verify its acceptance.',
    });
  });
});
