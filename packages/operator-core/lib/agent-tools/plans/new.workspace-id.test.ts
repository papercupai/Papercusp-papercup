/**
 * plans:new — explicit `workspaceId` opt-in passthrough (EI-1543).
 *
 * `resolvePlanScope` already accepts an explicit `workspaceId` override (it
 * refuses to silently default one for an UNREGISTERED harness — WI-148 — but
 * happily honors an explicit one), and `withPlanLock` already threads it
 * through. The gap EI-1543 reported was that `plans:new`'s own args schema
 * never exposed the field, so a caller hitting the unregistered-harness
 * throw (e.g. `offsite-planner-demo`) had no escape hatch even though
 * `work_items:create` succeeds against the same harness via a different
 * resolution path. This pins that the new `workspaceId` arg actually reaches
 * `withPlanLock`'s opts — the one thing this change adds.
 *
 * Mocks every collaborator new.ts touches so this stays a pure handler-shape
 * unit test (no DB). Run:
 *   cd packages/operator-core && npx vitest run lib/agent-tools/plans/new.workspace-id.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppliedResult, WithPlanLockResult } from './with-plan-lock';
import type { NewPlanVerificationProfile } from './plan-verification-profile-stamp';

/** Mirrors new.ts's own (unexported) `NewPlanValue`: success and the slug_exists refusal. */
type NewPlanValue = { ok: true; slug: string } | { ok: false; code: 'slug_exists' };

vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: vi.fn(() => 'offsite-planner-demo') }));
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: string, ctx: unknown) => ctx,
}));
vi.mock('./source', () => ({ listPlanIndexRows: vi.fn(async () => []),
  resolvePlanScope: vi.fn(async (opts: { workspaceId?: string; harnessSlug: string }) => ({
    workspaceId: opts.workspaceId ?? 'default', harnessSlug: opts.harnessSlug,
  })),
}));
vi.mock('./semantic-dedup', () => ({ confirmSimilarPlans: vi.fn(async () => ({ verdict: false })) }));
vi.mock('./revisions', () => ({
  planRevisionCapture: vi.fn(() => ({ recorded: { current: null }, afterWrite: vi.fn() })),
}));
vi.mock('./plan-verification-profile-stamp', () => ({
  resolveNewPlanVerificationProfile: vi.fn(async (): Promise<NewPlanVerificationProfile> => ({
    profile: 'general', source: 'declared', basis: 'declared',
  })),
  stampNewPlanVerificationProfile: vi.fn(async () => {}),
}));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: vi.fn(async () => {}) }));
vi.mock('../../harness/usage-emitters', () => ({ emitPlanAuthored: vi.fn(async () => {}) }));
vi.mock('./item-parse-feedback', () => ({ summarizeItemParse: vi.fn(() => ({})) }));
// The mock MUST mirror `AppliedResult` exactly — `kind:'applied'` plus the
// `scope` pair. with-plan-lock.ts has exactly ONE applied-kind return and it
// always carries `scope`, so every caller is entitled to read `result.scope`
// unconditionally (new.ts:497 does, for stampPlanGoalProvenance). A fixture
// that invents a `kind:'ok'` with no `scope` is not a simplification — it is a
// shape the production code can never receive, and it red-pinned the gate the
// day migration 791 started reading that field.
// NOT cast to `never`/`any`: typing the fixture as the real `WithPlanLockResult`
// is the recurrence guard. The next required field added to `AppliedResult`
// then strands HERE at `tsc`, where it is a one-line fix, instead of at runtime
// in the green gate, where it blocks every agent's deploys.
const appliedResult = (): AppliedResult<NewPlanValue> => ({
  kind: 'applied',
  value: { ok: true, slug: 'demo-plan-2026-07-18' },
  filePath: 'x',
  version: 1,
  scope: { workspaceId: 'default', harnessSlug: 'offsite-planner-demo' },
});

vi.mock('./with-plan-lock', () => ({
  withPlanLock: vi.fn(async () => ({
    kind: 'applied',
    value: { ok: true, slug: 'demo-plan-2026-07-18' },
    filePath: 'x',
    version: 1,
    scope: { workspaceId: 'default', harnessSlug: 'offsite-planner-demo' },
  })),
}));

const { withPlanLock } = await import('./with-plan-lock');
const { listPlanIndexRows } = await import('./source');
const withPlanLockM = vi.mocked(withPlanLock);
const tool = (await import('./new')).default;

type Out = { content: { text: string }[]; isError?: boolean };
const meta = vi.fn();
const call = (extra: Record<string, unknown> = {}) =>
  tool.handler(
    { harness: 'offsite-planner-demo', slug: 'demo-plan', title: 'Demo plan', force: true, ...extra } as never,
    { metadata: meta } as never,
  ) as Promise<Out>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listPlanIndexRows).mockResolvedValue([]);
  withPlanLockM.mockResolvedValue(appliedResult());
});

describe('plans:new workspaceId opt-in (EI-1543)', () => {
  it('refuses an existing suitable plan before any write, including a different proposed slug', async () => {
    vi.mocked(listPlanIndexRows).mockResolvedValue([{
      planSlug: 'demo-existing-2026-09-23', title: 'Demo checkout recovery', status: 'active', archived: false,
    }] as Awaited<ReturnType<typeof listPlanIndexRows>>);
    const result = await call({ force: false, slug: 'demo-continuation-2026-09-26', title: 'Demo checkout recovery' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: 'similar_exists' });
    expect(result.content[0]!.text).toContain('demo-existing-2026-09-23');
    expect(withPlanLockM).not.toHaveBeenCalled();
  });

  it('WI-10004345: an exact-slug re-create reaches the locked create (slug_exists), not similar_exists naming itself', async () => {
    // A dated slug is kept as given (an undated one gets today's date appended).
    vi.mocked(listPlanIndexRows).mockResolvedValue([{
      planSlug: 'demo-plan-2026-07-18', title: 'Demo plan', status: 'draft', archived: false,
    }] as Awaited<ReturnType<typeof listPlanIndexRows>>);
    const exists: WithPlanLockResult<NewPlanValue> = { ...appliedResult(), value: { ok: false, code: 'slug_exists' } };
    withPlanLockM.mockResolvedValueOnce(exists);
    const result = await call({ force: false, slug: 'demo-plan-2026-07-18' });
    expect(result.content[0]!.text).not.toContain('similar_exists');
    expect(withPlanLockM).toHaveBeenCalledTimes(1);
    expect(result.content[0]!.text).toContain('slug_exists');
  });

  it('omits workspaceId from withPlanLock opts when not passed (unchanged default behavior)', async () => {
    await call();
    const opts = withPlanLockM.mock.calls[0]?.[1] as unknown as Record<string, unknown>;
    expect(opts).not.toHaveProperty('workspaceId');
  });

  it('threads an explicit workspaceId through to withPlanLock so an unregistered harness can opt in', async () => {
    await call({ workspaceId: 'default' });
    const opts = withPlanLockM.mock.calls[0]?.[1] as unknown as Record<string, unknown>;
    expect(opts).toMatchObject({ workspaceId: 'default', harnessSlug: 'offsite-planner-demo' });
  });
});
