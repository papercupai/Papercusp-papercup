/**
 * run-now.test.ts — the plans:run-now HANDLER control flow (getPlanRow +
 * runScheduledPlanFire are mocked; getOrgPg returns a throwaway sql the handler only
 * passes through). Pins: not_found when the plan is unknown, the trigger:'manual'
 * delegation with the plan's install/workspace, the success projection, and the
 * typed-refusal mapping (a non-started fire result preserves its reason/detail and
 * becomes an isError). A regression that drops a guard or mislabels the trigger is
 * what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/run-now.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => ({ sql: {} })),
}));
vi.mock('./source', () => ({ getPlanRow: vi.fn() }));
vi.mock('./_ctx-opts', () => ({ ctxToPlanSourceOpts: vi.fn(async () => ({ workspaceId: 'default', harnessSlug: 'web' })) }));
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: string, ctx: unknown) => ctx,
}));
vi.mock('../../harness/routines/plan-run-action', () => ({ runScheduledPlanFire: vi.fn() }));
// These handler fixtures do not read registry/pin storage; plan-types tests cover that seam.
vi.mock('../../plan-types/pins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../plan-types/pins')>()),
  withPinnedPlanTypes: <T>(_scope: unknown, fn: () => Promise<T>) => fn(),
}));
vi.mock('../../acceptance-bar-lifecycle-evaluator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../acceptance-bar-lifecycle-evaluator')>()),
  readAndEvaluateAcceptanceBarLifecycle: vi.fn(async () => ({ satisfied: true })),
}));

import { getPlanRow } from './source';
import { runScheduledPlanFire } from '../../harness/routines/plan-run-action';
import { configurePlanAdmissionPolicySource } from './plan-admission-gate';
// P-004 admission: checkPlanStartable now ends in checkPlanAdmission, whose default
// policy source reads the pot's governance section through hive-federation →
// harness-registry → PG. A unit test has no PG, so pin the source to "no policy"
// (admitted, skipped:'no-admission-policy') through the gate's own seam.
configurePlanAdmissionPolicySource(async () => null);
const getRow = vi.mocked(getPlanRow);
const fire = vi.mocked(runScheduledPlanFire);
const tool = (await import('./run-now')).default;

type Out = { content: { text: string }[]; isError?: boolean };
const call = (slug = 'p1') => tool.handler({ harness: 'web', slug } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  getRow.mockReset();
  fire.mockReset();
});

describe('plans:run-now handler', () => {
  it('returns not_found for an unknown plan and does not fire', async () => {
    getRow.mockResolvedValue(null as never);
    const out = await call();
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ error: 'not_found', slug: 'p1' });
    expect(fire).not.toHaveBeenCalled();
  });

  it('fires a manual run with the plan install/workspace and returns the run', async () => {
    getRow.mockResolvedValue({ harnessSlug: 'web', workspaceId: 'default' } as never);
    fire.mockResolvedValue({ started: true, runId: 5, instanceSlug: 'p1-run-5' } as never);
    const out = await call();
    expect(out.isError).toBeUndefined();
    expect(body(out)).toMatchObject({ ok: true, runId: 5, instanceSlug: 'p1-run-5' });
    expect(fire.mock.calls[0]![1]).toMatchObject({
      installSlug: 'web', workspaceId: 'default', templateSlug: 'p1', trigger: 'manual',
    });
  });

  it('maps a typed fire refusal to an isError result without losing its diagnosis', async () => {
    getRow.mockResolvedValue({ harnessSlug: 'web', workspaceId: 'default' } as never);
    fire.mockResolvedValue({
      started: false,
      instanceSlug: '',
      runId: -1,
      runSeq: -1,
      minted: 0,
      workItemIds: [],
      actionableWorkItemIds: [],
      replayed: false,
      reason: 'not-startable',
      detail: 'The supplied inputs do not satisfy this plan schema',
      retryable: false,
      readiness: {
        ready: false,
        code: 'invalid_data',
        source: 'input-schema',
        missing: [],
        issues: ['/trigger/payload/end must be object'],
        hint: 'Fix the trigger payload before starting this plan.',
      },
    } as never);
    const out = await call();
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({
      ok: false,
      slug: 'p1',
      started: false,
      reason: 'not-startable',
      detail: 'The supplied inputs do not satisfy this plan schema',
      retryable: false,
      readiness: {
        code: 'invalid_data',
        issues: ['/trigger/payload/end must be object'],
      },
    });
  });
});
