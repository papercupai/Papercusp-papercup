// WI-10006208: plans:evaluate-spec-quality must not demand a spec contract for a
// deliberately DROPPED plan item. Before the fix the handler fed every item id to
// the evaluator, so a plan with a dropped item failed item-contract-coverage and
// its author had to file a fake exemption clause just to start it. This drives
// the real handler (only its reads are stubbed) so the guard covers the call site,
// not just the helper.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpecClauseRevision } from './spec-clauses-store';
import { hashPlanContent } from './content-hash';

const snapshotBody = () => '---\ntitle: Quality plan\nstatus: ready\n---\n## Items\n' +
  reads.items.map((item) => `- **${item.id}** \`${item.storedStatus}\` Contract`).join('\n');

const reads = vi.hoisted(() => ({
  items: [] as Array<{ id: string; storedStatus: string }>,
  clauses: [] as unknown[],
  discoveryReady: true,
  planReads: 0,
}));

vi.mock('../../plan-audits', async (original) => ({
  ...(await original<typeof import('../../plan-audits')>()),
  withCurrentDiscovery: async (_input: unknown, accept: () => Promise<unknown>) => reads.discoveryReady
    ? { ok: true, result: await accept() }
    : { ok: false, error: 'discovery_not_ready', nextAction: 'Finalize discovery.' },
}));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'su-quality-test' }) }));

vi.mock('../_harness-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_harness: unknown, ctx: unknown) => ctx,
}));
vi.mock('./_ctx-opts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_ctx-opts')>()),
  ctxToPlanSourceOpts: async () => ({}),
  resolveEffectiveHarnessSlug: () => 'papercusp',
}));
vi.mock('./source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./source')>()),
  readPlanBySlug: async () => { reads.planReads++; return ({
    row: { items: reads.items, templateData: null, contentHash: hashPlanContent(snapshotBody()) },
    parsed: { items: reads.items },
  }); },
}));
vi.mock('./revisions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./revisions')>()),
  getPlanRevisionSnapshot: async () => ({ contentSnapshot: snapshotBody(), contentSnapshotHash: hashPlanContent(snapshotBody()) }),
}));
vi.mock('./plan-input-validation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./plan-input-validation')>()),
  evaluatePlanStartReadiness: () => ({ ready: true }),
}));
vi.mock('./spec-clauses-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./spec-clauses-store')>()),
  listSpecClauses: async () => reads.clauses,
}));
vi.mock('../../rubrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../rubrics')>()),
  getAcceptanceRubricsForPlan: async () => [],
}));
vi.mock('./plan-spec-quality-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./plan-spec-quality-gate')>()),
  resolvePersistedClassRef: () => ({ ok: true, classRef: 'plan-class-feature-ship' }),
}));

import evaluateSpecQualityTool from './evaluate-spec-quality';

function clause(planItemId: string): SpecClauseRevision {
  return {
    planSlug: 'quality-plan',
    specId: `SPEC-${planItemId}`,
    sourceValId: `VAL-${planItemId}`,
    currentRevision: 1,
    revision: 1,
    planItemId,
    behavior: 'POST /events returns 202 for a valid request',
    behaviorClass: 'happy-path',
    requiredEvidence: [],
    requiredTestLayers: ['integration'],
    mutationRequired: false,
    lifecycleStatus: 'active',
    supersedes: null,
    exemption: null,
    falsifier: null,
    contentHash: `sha256:${planItemId}`,
    createdBy: 'author',
    createdAt: '2026-08-20T00:00:00.000Z',
    acceptedBy: 'reviewer',
    acceptedAt: '2026-08-20T00:01:00.000Z',
    acceptanceRef: 'D-001',
  };
}

type Graded = {
  ok: boolean;
  planItemCount?: number;
  wouldBlock?: string[];
  details?: { uncoveredPlanItemIds?: string[] };
};

async function evaluate(): Promise<Graded> {
  const out = (await evaluateSpecQualityTool.handler(
    { slug: 'quality-plan', harness: 'papercusp' } as never,
    {} as never,
  )) as { data: Graded };
  return out.data;
}

describe('plans:evaluate-spec-quality and dropped plan items (WI-10006208)', () => {
  beforeEach(() => {
    reads.discoveryReady = true;
    reads.planReads = 0;
    reads.clauses = [clause('P-001')];
  });

  it('refuses live evaluation before reading/grading clauses when discovery is not ready', async () => {
    reads.discoveryReady = false;
    const result = await evaluate();
    expect(result).toMatchObject({ ok: false, error: 'discovery_not_ready' });
    expect(result).not.toHaveProperty('scorecardDraft');
    expect(reads.planReads).toBe(0);
  });

  it('does not require a contract for a dropped item', async () => {
    reads.items = [
      { id: 'P-001', storedStatus: 'todo' },
      { id: 'P-002', storedStatus: 'dropped' },
    ];
    const result = await evaluate();
    expect(result.ok).toBe(true);
    expect(result.planItemCount).toBe(1);
    expect(result.details?.uncoveredPlanItemIds).toEqual([]);
    expect(result.wouldBlock).not.toContain('item-contract-coverage');
  });

  it('still requires a contract for a live item that has none', async () => {
    reads.items = [
      { id: 'P-001', storedStatus: 'todo' },
      { id: 'P-002', storedStatus: 'done' },
    ];
    const result = await evaluate();
    expect(result.ok).toBe(true);
    expect(result.planItemCount).toBe(2);
    expect(result.details?.uncoveredPlanItemIds).toEqual(['P-002']);
    expect(result.wouldBlock).toContain('item-contract-coverage');
  });
});
