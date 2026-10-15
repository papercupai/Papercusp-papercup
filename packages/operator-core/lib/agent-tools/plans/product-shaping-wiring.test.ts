import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promptWeight, BUDGET } from '../tool-guidance-budget';
const { readPlan, lock } = vi.hoisted(() => ({ readPlan: vi.fn(), lock: vi.fn() }));
vi.mock('./source', async original => ({ ...await original<typeof import('./source')>(), getPlanRow: readPlan,
  listPlanIndexRows: vi.fn(async () => []) }));
// R-9 drives the REAL plans:new / plans:set-content handlers; only persistence
// and best-effort side channels are stubbed.
vi.mock('./with-plan-lock', () => ({ withPlanLock: lock }));
vi.mock('./revisions', () => ({ planRevisionCapture: vi.fn(() => ({ recorded: { current: { seq: 1 } }, afterWrite: vi.fn() })) }));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: vi.fn(async () => {}) }));
vi.mock('../../harness/usage-emitters', () => ({ emitPlanAuthored: vi.fn(async () => {}) }));
vi.mock('../../modes/goal-context', () => ({ resolveGoalContext: vi.fn(async () => null), stampPlanGoalProvenance: vi.fn(async () => null) }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => { throw new Error('no transport identity in unit test'); }) }));
vi.mock('../../plan-items/text-drift-report', () => ({ planItemTextDriftForWrite: vi.fn(async () => null) }));
import audit from './audit';
import create, { buildTemplate } from './new';
import setContent from './set-content';
import { productShapingScaffold } from './product-shaping';

const scope = { workspaceId: 'test-workspace', harnessSlug: 'papercusp' };
const ctx = { metadata: vi.fn(), harnessSlug: 'papercusp', workspaceId: 'test-workspace' } as never;
type Out = { content: { text: string }[]; isError?: boolean };
const payload = (out: unknown) => JSON.parse((out as Out).content[0]!.text) as Record<string, any>;
const unshapedBody = '## Background\nOwner supplied content.\n\n## Phase 1\n\n- **P-001** `todo` Build it\n';

describe('product shaping authoring and audit consumer paths', () => {
  beforeEach(() => vi.clearAllMocks());

  it('puts product intent before task decomposition in the default scaffold', () => {
    const body = buildTemplate({ slug: 'new-feature', title: 'Feature', status: 'draft', owner: null, date: '2026-10-09' });
    expect(body).toContain('## Product shaping');
    expect(body.indexOf('## Product shaping')).toBeLessThan(body.indexOf('## Phase 1'));
    expect(body).toContain('"sourceRefs"');
    expect(body).toContain('"scenarios"');
  });

  it('preserves custom owner content verbatim rather than inventing a brief', () => {
    const body = buildTemplate({ slug: 'feature', title: 'Feature', status: 'draft', owner: null, date: '2026-10-09', body: '## Background\nOwner supplied content.' });
    expect(body).not.toContain('## Product shaping');
    expect(body).toContain('Owner supplied content.');
  });

  it('runs the actual read-only shaping handler without completion items or an activation class', async () => {
    readPlan.mockResolvedValue({ content: '# Legacy\n## Build\n- **P-001** `todo` Work' });
    const args = audit.args.parse({ harness: 'papercusp', slug: 'legacy', phase: 'shaping' });
    const result = await audit.handler(args, { harnessSlug: 'papercusp', workspaceId: 'test-workspace' } as Parameters<typeof audit.handler>[1]);
    expect(result).toMatchObject({ data: { ok: true, phase: 'shaping', dryRun: true, preview: true, productShaping: {
      status: 'missing', advisory: true, reviewerBrief: { sourceRefs: [] },
    } } });
    expect(readPlan).toHaveBeenCalledWith('legacy', { harnessSlug: 'papercusp' });
  });

  it('fails explicitly when the canonical plan cannot be read', async () => {
    readPlan.mockResolvedValue(null);
    const args = audit.args.parse({ harness: 'papercusp', slug: 'missing', phase: 'shaping', dryRun: false });
    const result = await audit.handler(args, { harnessSlug: 'papercusp', workspaceId: 'test-workspace' } as Parameters<typeof audit.handler>[1]);
    expect(result).toMatchObject({ data: { ok: false, error: 'plan_not_found' } });
  });

  it('rejects write payloads on shaping without loosening the old audit phases', () => {
    expect(audit.args.safeParse({ slug: 'p', phase: 'shaping', items: [] }).success).toBe(false);
    expect(audit.args.safeParse({ slug: 'p', phase: 'completion' }).success).toBe(false);
    // A bare activation is valid since P-003 (plan-verification-friction-reduction-2026-10-11)
    // derives classRef; a completion-only payload on activation is still refused.
    expect(audit.args.safeParse({ slug: 'p', phase: 'activation', items: [] }).success).toBe(false);
  });

  describe('content writes surface missing shaping without refusing (R-9)', () => {
    it('plans:new with a supplied unshaped body persists it verbatim and returns the preview with scaffold', async () => {
      let written = '';
      lock.mockImplementation(async (_ctx: unknown, _opts: unknown, fn: (current: string | null, meta: unknown) => Promise<{ newBody: string | null; value: unknown }>) => {
        const out = await fn(null, {});
        written = out.newBody ?? '';
        return { kind: 'applied', value: out.value, filePath: 'x', version: 1, scope };
      });
      const out = await create.handler({ harness: 'papercusp', slug: 'unshaped', title: 'Unshaped', force: true, content: unshapedBody } as never, ctx);
      expect((out as Out).isError).toBeFalsy();
      expect(written).toContain('Owner supplied content.');
      expect(written).not.toContain('## Product shaping');
      const body = payload(out);
      expect(body.ok).toBe(true);
      expect(body.productShaping).toMatchObject({ advisory: true, status: 'missing' });
      expect(body.productShaping.scaffold).toContain('```product-shaping');
      expect(body.productShaping.diagnostics[0].code).toBe('shaping_missing');
    });

    it('plans:new without a body uses the shaped template and carries no advisory', async () => {
      lock.mockImplementation(async (_ctx: unknown, _opts: unknown, fn: (current: string | null, meta: unknown) => Promise<{ value: unknown }>) =>
        ({ kind: 'applied', value: (await fn(null, {})).value, filePath: 'x', version: 1, scope }));
      const body = payload(await create.handler({ harness: 'papercusp', slug: 'templated', title: 'Templated', force: true } as never, ctx));
      expect(body.ok).toBe(true);
      expect(body.productShaping).toBeUndefined();
    });

    it('plans:set-content persists an unshaped body and returns the preview; a shaped body gets none', async () => {
      lock.mockResolvedValue({ kind: 'applied', value: { ok: true, slug: 'p', contentHash: 'h', parseFeedback: {} }, filePath: 'x', version: 2, scope });
      const unshaped = payload(await setContent.handler({ harness: 'papercusp', slug: 'p', content: '---\nstatus: draft\n---\n' + unshapedBody } as never, ctx));
      expect(unshaped).toMatchObject({ ok: true, slug: 'p', productShaping: { advisory: true, status: 'missing' } });
      expect(unshaped.productShaping.scaffold).toContain('```product-shaping');
      expect(lock).toHaveBeenCalledTimes(1);
      const shaped = payload(await setContent.handler({ harness: 'papercusp', slug: 'p', content: '---\nstatus: draft\n---\n' + productShapingScaffold() + '\n' + unshapedBody } as never, ctx));
      expect(shaped.ok).toBe(true);
      expect(shaped.productShaping).toBeUndefined();
    });

    it('a malformed shaping block is reported as invalid, still without refusing the write', async () => {
      lock.mockResolvedValue({ kind: 'applied', value: { ok: true, slug: 'p', contentHash: 'h', parseFeedback: {} }, filePath: 'x', version: 2, scope });
      const out = payload(await setContent.handler({ harness: 'papercusp', slug: 'p', content: '## Product shaping\n```product-shaping\n{oops\n```\n' + unshapedBody } as never, ctx));
      expect(out).toMatchObject({ ok: true, productShaping: { status: 'invalid' } });
    });
  });

  it('keeps the changed tools within the existing guidance budget', () => {
    expect(promptWeight(audit as unknown as Parameters<typeof promptWeight>[0])).toBeLessThanOrEqual(BUDGET);
    expect(promptWeight(create as unknown as Parameters<typeof promptWeight>[0])).toBeLessThanOrEqual(BUDGET);
  });
});
