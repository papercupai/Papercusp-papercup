/**
 * WI-10005199 — `plans:set-status` attests its consumer read, exception-only.
 *
 * `ok` from the handler proves only the plan BODY write. The response must grow a
 * `consumerView` exactly when the read a consumer performs (the derived items index +
 * blocked-by graph) disagrees with the status that was written — and must be byte-for-byte
 * the ordinary response when it agrees. The reader is stubbed at the `plan-item-consumer-read`
 * seam; the attestation logic itself is pinned in plan-item-consumer-view.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanItemConsumerReader } from './plan-item-consumer-view';

const doubles = vi.hoisted(() => ({
  withPlanLock: vi.fn(),
  bumpUpdatedDate: vi.fn((body: string) => body.replace('updated: 2026-10-01', 'updated: 2026-10-02')),
  emitPlanEventForCaller: vi.fn(async () => {}),
  readItems: vi.fn(),
  readerFor: vi.fn(),
}));

vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx,
}));
vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: () => null }));
vi.mock('./revisions', () => ({
  planRevisionCapture: () => ({ afterWrite: undefined, recorded: { current: null } }),
}));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: doubles.emitPlanEventForCaller }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => {
    throw new Error('no identity in this test');
  },
}));
vi.mock('./with-plan-lock', () => ({
  withPlanLock: doubles.withPlanLock,
  bumpUpdatedDate: doubles.bumpUpdatedDate,
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('./source', () => ({
  resolvePlanScope: vi.fn(async () => ({ workspaceId: 'ws-1', harnessSlug: 'papercup' })),
}));
vi.mock('./plan-item-consumer-read', () => ({
  planItemConsumerReaderFor: (sctx: unknown) => {
    doubles.readerFor(sctx);
    return doubles.readItems;
  },
}));
vi.mock('../../plan-items/convert', async (orig) => ({
  ...(await orig<typeof import('../../plan-items/convert')>()),
  findConvertedWorkItemByStamp: vi.fn(async () => null),
  findCoverageWorkItems: vi.fn(async () => []),
}));
vi.mock('../../plan-items/reconcile-linked-work-items', () => ({
  findAllLinkedWorkItems: vi.fn(async () => []),
  reconcileLinkedWorkItemsForPlanItem: vi.fn(async () => ({
    planSlug: 'demo-plan',
    itemId: 'P-007',
    reconciled: [],
    skippedInFlight: [],
    skippedAlreadyTerminal: [],
    skippedUnprovenLink: [],
    skippedGatedState: [],
  })),
  resyncPlanItemLaneNow: vi.fn(async () => null),
  resyncDependentPlanItemLanesNow: vi.fn(async () => []),
}));
vi.mock('../../plan-items/assignments', () => ({ unassignItem: vi.fn(async () => null) }));

import { withPlanLock } from './with-plan-lock';
const lockM = vi.mocked(withPlanLock);
const readItems = doubles.readItems.mockName('readItems') as ReturnType<typeof vi.fn<PlanItemConsumerReader>>;
const tool = (await import('./set-status')).default;

function planBody(status: string): string {
  return `---\ntitle: demo\nupdated: 2026-10-01\n---\n\n- **P-007** \`${status}\` external blocker\n`;
}

function driveLock(current: string, opts: { ok?: boolean } = {}): void {
  lockM.mockImplementation(async (_ctx: unknown, _opts: unknown, mutate: unknown) => {
    const mutation = await (mutate as (body: string) => Promise<{ value: { ok: boolean; oldStatus: string | null } }>)(
      current,
    );
    return {
      kind: 'ok',
      value: opts.ok === false ? { ...mutation.value, ok: false } : mutation.value,
      filePath: 'demo-plan.md',
      scope: { workspaceId: 'ws-1', harnessSlug: 'papercup' },
    } as never;
  });
}

type Result = { ok: boolean; itemId: string; consumerView?: unknown };
async function setStatus(status: string): Promise<Result> {
  const out = (await tool.handler({ slug: 'demo-plan', item: 'P-007', status } as never, {} as never)) as {
    data: { results: Result[] };
  };
  return out.data.results[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  readItems.mockReset();
});

describe('plans:set-status consumerView attestation', () => {
  it('leaves the response unchanged (no consumerView key) when the consumer read agrees', async () => {
    driveLock(planBody('todo'));
    readItems.mockResolvedValueOnce([{ id: 'P-007', effectiveStatus: 'blocked' }]);

    const result = await setStatus('blocked');

    expect(result).toMatchObject({ ok: true, itemId: 'P-007' });
    expect('consumerView' in result).toBe(false);
    expect(readItems).toHaveBeenCalledTimes(1);
    expect(readItems).toHaveBeenCalledWith('demo-plan');
  });

  it('surfaces consumerView when the derived index still reads the OLD status after the flip', async () => {
    driveLock(planBody('todo'));
    readItems.mockResolvedValueOnce([{ id: 'P-007', effectiveStatus: 'todo' }]);

    const result = await setStatus('blocked');

    expect(result).toMatchObject({
      ok: true,
      itemId: 'P-007',
      consumerView: { divergedFromWrite: true, value: { itemId: 'P-007', status: 'todo' } },
    });
  });

  it('surfaces consumerView (status null) when the consumer read is unreadable — it never claims agreement', async () => {
    driveLock(planBody('todo'));
    readItems.mockRejectedValueOnce(new Error('pg unavailable'));

    const result = await setStatus('blocked');

    expect(result).toMatchObject({
      ok: true,
      consumerView: { divergedFromWrite: true, value: { itemId: 'P-007', status: null } },
    });
  });

  it('builds the reader from the same scoped ctx the write used', async () => {
    driveLock(planBody('todo'));
    readItems.mockResolvedValueOnce([{ id: 'P-007', effectiveStatus: 'blocked' }]);

    await setStatus('blocked');

    expect(doubles.readerFor).toHaveBeenCalledTimes(1);
  });

  it('does not read at all when the write did not land (value.ok false)', async () => {
    driveLock(planBody('todo'), { ok: false });

    await setStatus('blocked');

    expect(readItems).not.toHaveBeenCalled();
  });

  it('refuses reopening a finished child while its parent plan remains terminal', async () => {
    const terminalBody = planBody('done').replace(
      'title: demo',
      'title: demo' + String.fromCharCode(10) + 'status: shipped',
    );
    driveLock(terminalBody);

    const result = await setStatus('todo');

    expect(result).toMatchObject({
      ok: false,
      itemId: 'P-007',
      error: 'terminal_parent_child_mutation',
      parentStatus: 'shipped',
      changes: [{ itemId: 'P-007', kind: 'reopened', from: 'done', to: 'todo' }],
    });
    expect(readItems).not.toHaveBeenCalled();
  });
});
