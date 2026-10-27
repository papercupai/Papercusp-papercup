/**
 * set-status.bar-readiness.test.ts — guard for review-system-rework-reduction-2026-09-23
 * P-030 (P-031 merged in by D-005), spec RSR-P-030-A: DROPPING a plan item is a scope write,
 * so the plans:set-status HANDLER re-evaluates the plan's live BAR readiness in the SAME call
 * and carries the blocking codes on its response (the Now stamp itself is pinned in
 * plan-scope-cascade.test.ts; the real-evaluator chain in acceptance-bar-contract-snapshot.test.ts).
 *
 * Pure unit test (no PG): the lock, revision, identity and lane-sync seams are mocked exactly
 * as in set-status.bulk.test.ts, and the cascade's production deps are replaced by a fake
 * whose readiness reads `bar_snapshot_mapping_dropped_only` — what the snapshot reports once
 * a BAR's last live item is dropped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx,
}));
vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: () => null }));
// WI-10008137: the draft-plan item-start gate has its own suite (draft-item-start-gate.test.ts).
vi.mock('./draft-item-start-gate', () => ({ checkDraftItemStartGateLive: vi.fn(async () => null) }));
vi.mock('./revisions', () => ({
  planRevisionCapture: () => ({ afterWrite: undefined, recorded: { current: null } }),
}));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: vi.fn(async () => {}) }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => {
    throw new Error('no identity in this test');
  },
}));
vi.mock('./with-plan-lock', () => ({
  withPlanLock: vi.fn(),
  bumpUpdatedDate: (s: string) => s,
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('../../plan-items/reconcile-linked-work-items', () => ({
  findAllLinkedWorkItems: vi.fn(async () => []),
  reconcileLinkedWorkItemsForPlanItem: vi.fn(async () => ({
    planSlug: 'plan-a',
    itemId: 'P-001',
    reconciled: [],
    skippedInFlight: [],
    skippedAlreadyTerminal: [],
    skippedUnprovenLink: [],
    skippedGatedState: [],
  })),
  resyncPlanItemLaneNow: vi.fn(async () => null),
  resyncDependentPlanItemLanesNow: vi.fn(async () => [] as string[]),
}));

const cascade = vi.hoisted(() => ({
  read: vi.fn(async () => ({
    state: 'blocked' as const,
    codes: ['bar_snapshot_mapping_dropped_only'],
    nextRepair: {
      code: 'bar_snapshot_mapping_dropped_only',
      barKey: 'R-1',
      action: 'Map the outstanding BAR to a live replacement item or amend the BAR.',
    },
  })),
  restamp: vi.fn(async (): Promise<boolean | { stamped: boolean; activationAudit?: any }> => true),
}));
vi.mock('./plan-scope-cascade-deps', async (orig) => ({
  ...(await orig<typeof import('./plan-scope-cascade-deps')>()),
  defaultBarReadinessDeps: () => ({ readBarReadiness: cascade.read, restampNow: cascade.restamp }),
}));

import { withPlanLock } from './with-plan-lock';
const lockM = vi.mocked(withPlanLock);
const tool = (await import('./set-status')).default;

const body = async (args: Record<string, unknown>) =>
  ((await tool.handler(args as never, {} as never)) as { data: any }).data;

/** A successful lock that resolved the plan's scope, as the real withPlanLock does. */
function lockOk(fromStatus: string, extraValue: Record<string, unknown> = {}) {
  lockM.mockImplementation(async (_ctx: unknown, _opts: unknown, mutate: unknown) => {
    const scope = { workspaceId: 'ws-1', harnessSlug: 'papercusp' };
    const { value } = await (mutate as (b: string, meta: unknown, lockScope: typeof scope) => Promise<{ value: unknown }>)(
      `- **P-001** \`${fromStatus}\` outcome`,
      {},
      scope,
    );
    return {
      kind: 'ok',
      value: { ...(value as Record<string, unknown>), ...extraValue },
      filePath: 'plan.md',
      scope,
    } as never;
  });
}

beforeEach(() => vi.clearAllMocks());

describe('plans:set-status — a drop re-evaluates BAR readiness in the same write (P-031)', () => {
  it('dropping the item carries the live blocking code and restamps the plan Now', async () => {
    lockOk('todo');
    const out = await body({ slug: 'plan-a', item: 'P-001', status: 'dropped', note: 'moot after D-019' });
    expect(out).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(cascade.read).toHaveBeenCalledTimes(1);
    expect(cascade.read).toHaveBeenCalledWith('plan-a', 'papercusp');
    expect(cascade.restamp).toHaveBeenCalledTimes(1);
    expect(out.results[0].barReadiness).toMatchObject({
      slug: 'plan-a',
      cause: 'item-dropped',
      state: 'blocked',
      codes: ['bar_snapshot_mapping_dropped_only'],
      nowStamped: true,
    });
  });

  it('returns the activation-audit notice from the follow-up BAR restamp write', async () => {
    const earlierAudit = { currentPlanRevision: { planVersion: 13 } };
    const latestAudit = { currentPlanRevision: { planVersion: 14 } };
    lockOk('todo', { activationAudit: earlierAudit });
    cascade.restamp.mockResolvedValueOnce({ stamped: true, activationAudit: latestAudit });

    const out = await body({ slug: 'plan-a', item: 'P-001', status: 'dropped', note: 'moot' });

    expect(out.results[0]).toMatchObject({
      activationAudit: latestAudit,
      barReadiness: { nowStamped: true },
    });
    expect(out.results[0].barReadiness).not.toHaveProperty('activationAudit');
  });

  it('a non-scope flip (todo → wip) does not re-evaluate readiness', async () => {
    lockOk('todo');
    const out = await body({ slug: 'plan-a', item: 'P-001', status: 'wip' });
    expect(out).toMatchObject({ ok: true });
    expect(cascade.read).not.toHaveBeenCalled();
    expect(out.results[0].barReadiness).toBeUndefined();
  });

  it('a failed readiness read never fails the drop itself', async () => {
    lockOk('todo');
    cascade.read.mockRejectedValueOnce(new Error('pool exhausted'));
    const out = await body({ slug: 'plan-a', item: 'P-001', status: 'dropped', note: 'moot' });
    expect(out).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(out.results[0].barReadiness).toMatchObject({ state: null, nowStamped: false });
    expect(out.results[0].barReadiness.error).toContain('pool exhausted');
    expect(cascade.restamp).not.toHaveBeenCalled();
  });
});
