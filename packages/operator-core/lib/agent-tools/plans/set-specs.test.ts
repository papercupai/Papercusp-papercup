import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RECORDED_TEST_LAYERS } from '@papercusp/test-config/execution-details';
import { verifyPlanAcceptanceRef } from './spec-clause-compiler';

const handlerMocks = vi.hoisted(() => ({
  getPlanRevisionSnapshot: vi.fn(),
  listSpecClauses: vi.fn(),
  setSpecClause: vi.fn(),
}));

vi.mock('./revisions', () => ({
  getPlanRevisionSnapshot: handlerMocks.getPlanRevisionSnapshot,
}));
vi.mock('./spec-clauses-store', async (original) => {
  const actual = await original<typeof import('./spec-clauses-store')>();
  return {
    ...actual,
    listSpecClauses: handlerMocks.listSpecClauses,
    setSpecClause: handlerMocks.setSpecClause,
  };
});
vi.mock('../_harness-scope', async (original) => {
  const actual = await original<typeof import('../_harness-scope')>();
  return {
    ...actual,
    harnessScopedCtx: (harness: string | undefined, ctx: Record<string, unknown>) => ({
      ...ctx,
      harnessSlug: harness ?? ctx.harnessSlug ?? 'papercusp',
    }),
  };
});
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'acceptance-ref-test-agent', ownerLabel: 'test', source: 'omp-hook-session' }),
}));

import tool from './set-specs';

beforeEach(() => {
  handlerMocks.getPlanRevisionSnapshot.mockReset().mockResolvedValue(null);
  handlerMocks.listSpecClauses.mockReset().mockResolvedValue([]);
  handlerMocks.setSpecClause.mockReset();
});

const clause = {
  specId: 'SPEC-personal-desktop',
  expectedRevision: 0,
  planItemId: 'P-006',
  behavior: 'The personal desktop survives reconnect on a real host.',
  behaviorClass: 'lifecycle',
  lifecycleStatus: 'active',
  requiredEvidence: ['live'],
};

describe('plans:set-specs recorded test layers (EI-25307246967369800)', () => {
  it.each(['live', 'component', 'mutation', 'unknown-layer'])(
    'refuses an unrecordable %s layer in single and bulk writes',
    (layer) => {
      const spec = { ...clause, requiredTestLayers: ['e2e', layer] };
      for (const payload of [{ spec }, { items: [spec] }]) {
        const result = tool.args.safeParse({ slug: 'personal-desktop', ...payload });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues.some((issue) => issue.path.includes('requiredTestLayers'))).toBe(true);
        }
      }
    },
  );

  it('accepts every recorded layer while keeping the live evidence plane', () => {
    const parsed = tool.args.parse({
      slug: 'personal-desktop',
      spec: { ...clause, requiredTestLayers: [...RECORDED_TEST_LAYERS] },
    });
    expect(parsed.spec?.requiredTestLayers).toEqual([...RECORDED_TEST_LAYERS]);
    expect(parsed.spec?.requiredEvidence).toEqual(['live']);
  });

  it('requires an outer plan slug for bulk items so plan-bound clauses cannot fall back to ad-hoc scope', () => {
    const missingSlug = tool.args.safeParse({ items: [clause] });
    expect(missingSlug.success).toBe(false);
    if (!missingSlug.success) {
      expect(missingSlug.error.issues.some((issue) => issue.path.includes('slug'))).toBe(true);
    }

    expect(tool.args.safeParse({ spec: clause }).success).toBe(true);
    expect(tool.args.safeParse({ slug: 'adhoc-work-item-specs', items: [clause] }).success).toBe(true);
  });
});

describe('plans:set-specs structured plan acceptance references', () => {
  it('accepts a structured reference only when its positive revision exists and its item matches', async () => {
    const revisionExists = vi.fn(async () => true);
    await expect(
      verifyPlanAcceptanceRef('plan:accepted-plan@10#P-006', 'P-006', revisionExists),
    ).resolves.toEqual({ ok: true });
    expect(revisionExists).toHaveBeenCalledWith('accepted-plan', 10);
  });

  it.each([
    ['plan:accepted-plan@undefined#P-006', 'malformed-plan-acceptance-ref'],
    ['plan:accepted-plan@0#P-006', 'invalid-plan-acceptance-ref-revision'],
    ['plan:accepted-plan@10#P-007', 'plan-acceptance-ref-item-mismatch'],
  ])('rejects invalid structured references %s', async (ref, code) => {
    const revisionExists = vi.fn(async () => true);
    await expect(verifyPlanAcceptanceRef(ref, 'P-006', revisionExists)).resolves.toMatchObject({
      ok: false,
      code,
      reason: expect.any(String),
    });
    expect(revisionExists).not.toHaveBeenCalled();
  });

  it('refuses a syntactically valid reference when the referenced plan revision is missing', async () => {
    await expect(
      verifyPlanAcceptanceRef('plan:accepted-plan@11#P-006', 'P-006', async () => false),
    ).resolves.toMatchObject({
      ok: false,
      code: 'plan-acceptance-ref-revision-not-found',
      reason: expect.stringContaining('accepted-plan@11'),
    });
  });

  it('refuses a missing referenced revision through the writer before persistence and gives a repair hint', async () => {
    const args = tool.args.parse({
      harness: 'papercusp',
      spec: { ...clause, acceptanceRef: 'plan:accepted-plan@11#P-006' },
    });
    const result = await tool.handler(args as never, { workspaceId: 'test-workspace' } as never);

    expect(handlerMocks.getPlanRevisionSnapshot).toHaveBeenCalledWith('accepted-plan', 11, {
      harnessSlug: 'papercusp',
    });
    expect(handlerMocks.setSpecClause).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain('plan-acceptance-ref-revision-not-found');
    expect(JSON.stringify(result)).toContain('Use an existing positive plan revision');
  });

  it('preserves existing free-form acceptance references without a plan lookup', async () => {
    const revisionExists = vi.fn(async () => false);
    await expect(verifyPlanAcceptanceRef('D-001', 'P-006', revisionExists)).resolves.toEqual({ ok: true });
    expect(revisionExists).not.toHaveBeenCalled();
  });
});
