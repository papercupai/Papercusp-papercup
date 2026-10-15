import { beforeEach, describe, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({
  withPlanLock: vi.fn(),
  bumpUpdatedDate: vi.fn((body: string) => body.replace('updated: 2026-10-01', 'updated: 2026-10-02')),
  emitPlanEventForCaller: vi.fn(async () => {}),
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
const tool = (await import('./set-status')).default;

type Mutation = { newBody: string | null; value: { ok: boolean; oldStatus: string | null } };
let mutation: Mutation | undefined;

function planBody(status: string, note?: string): string {
  const suffix = note ? ` — note: ${note}` : '';
  return `---\ntitle: demo\nupdated: 2026-10-01\n---\n\n- **P-007** \`${status}\` external blocker${suffix}\n`;
}

function driveLock(current: string): void {
  lockM.mockImplementation(async (_ctx: unknown, _opts: unknown, mutate: unknown) => {
    mutation = await (mutate as (body: string) => Promise<Mutation>)(current);
    return {
      kind: 'ok',
      value: mutation.value,
      filePath: 'demo-plan.md',
      scope: { workspaceId: 'ws-1', harnessSlug: 'papercup' },
    } as never;
  });
}

async function setStatus(status: string, note?: string) {
  return (await tool.handler(
    { slug: 'demo-plan', item: 'P-007', status, ...(note ? { note } : {}) } as never,
    {} as never,
  )) as { data: unknown };
}

beforeEach(() => {
  vi.clearAllMocks();
  mutation = undefined;
});

describe('plans:set-status no-op writes', () => {
  it('does not bump the plan revision or emit a status event when blocker reflection repeats identical content', async () => {
    const note = 'blocked (1 external blocker)';
    driveLock(planBody('blocked', note));

    await setStatus('blocked', note);

    expect(mutation?.value).toMatchObject({ ok: true, oldStatus: 'blocked' });
    expect(mutation?.newBody).toBeNull();
    expect(doubles.bumpUpdatedDate).not.toHaveBeenCalled();
    expect(doubles.emitPlanEventForCaller).not.toHaveBeenCalled();
  });

  it('persists a changed blocker note without reporting a status transition', async () => {
    driveLock(planBody('blocked', 'blocked (1 external blocker)'));

    await setStatus('blocked', 'blocked (2 external blockers)');

    expect(mutation?.newBody).toContain('updated: 2026-10-02');
    expect(mutation?.newBody).toContain('blocked (2 external blockers)');
    expect(doubles.bumpUpdatedDate).toHaveBeenCalledTimes(1);
    expect(doubles.emitPlanEventForCaller).not.toHaveBeenCalled();
  });

  it('emits the status event for a real transition', async () => {
    driveLock(planBody('todo'));

    await setStatus('blocked');

    expect(mutation?.newBody).toContain('`blocked`');
    expect(doubles.emitPlanEventForCaller).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: 'item_status_changed', before: 'todo', after: 'blocked' }),
    );
  });
});
