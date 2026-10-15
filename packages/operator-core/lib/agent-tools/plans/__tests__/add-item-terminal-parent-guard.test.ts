import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withPlanLock: vi.fn(),
  emitPlanEventForCaller: vi.fn(async () => {}),
}));

vi.mock('../../_harness-scope', async (original) => ({
  ...(await original<typeof import('../../_harness-scope')>()),
  harnessScopedCtx: (_harness: unknown, ctx: unknown) => ctx,
}));
vi.mock('../_ctx-opts', () => ({ resolveCtxHarnessSlug: () => null }));
vi.mock('../with-plan-lock', () => ({
  withPlanLock: mocks.withPlanLock,
  bumpUpdatedDate: (body: string) => body,
}));
vi.mock('../revisions', () => ({
  planRevisionCapture: () => ({ afterWrite: undefined, recorded: { current: null } }),
}));
vi.mock('../../coordination/plan-events', () => ({
  emitPlanEventForCaller: mocks.emitPlanEventForCaller,
}));

const tool = (await import('../add-item')).default;
const tick = String.fromCharCode(96);
const shippedPlan = [
  '---',
  'title: Terminal plan',
  'slug: terminal-plan',
  'status: shipped',
  'updated: 2026-10-02',
  '---',
  '',
  '# Terminal plan',
  '',
  '## Now',
  '**State:** Historical plan state.',
  '**Next:** No active work.',
  '',
  '## Phase 1 — Work',
  '',
  '- **P-001** ' + tick + 'done' + tick + ' Completed history',
  '',
  '## Decisions',
  '',
].join(String.fromCharCode(10));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withPlanLock.mockImplementation(async (_ctx: unknown, _opts: unknown, mutate: unknown) => {
    const result = await (mutate as (current: string) => Promise<{ value: unknown }>)(shippedPlan);
    return { kind: 'ok', value: result.value, filePath: 'terminal-plan.md' } as never;
  });
});

describe('plans:add-item terminal parent guard', () => {
  it('rejects adding a live child and preserves the parent for explicit lifecycle transition', async () => {
    const response = (await tool.handler(
      {
        slug: 'terminal-plan',
        phase: 'Phase 1 — Work',
        text: 'New live task',
        importance: 'normal',
      } as never,
      {} as never,
    )) as { data: { results: Array<Record<string, unknown>> } };

    expect(response.data.results[0]).toMatchObject({
      ok: false,
      slug: 'terminal-plan',
      error: 'terminal_parent_child_mutation',
      parentStatus: 'shipped',
      changes: [{ itemId: 'P-002', kind: 'added', from: null, to: 'todo' }],
      reason: expect.stringContaining('plans:set-plan-status'),
    });
    expect(mocks.emitPlanEventForCaller).not.toHaveBeenCalled();
  });
});
