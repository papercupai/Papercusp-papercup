import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpecClauseRevision } from './spec-clauses-store';
import { hashPlanContent } from './content-hash';
import { evaluatePlanSpecQuality } from './spec-quality';

const reads = vi.hoisted(() => ({ plan: vi.fn(), clauses: vi.fn(), snapshot: vi.fn(), rubrics: vi.fn() }));
vi.mock('./source', async (original) => ({ ...await original<typeof import('./source')>(), readPlanBySlug: reads.plan }));
vi.mock('./revisions', async (original) => ({ ...await original<typeof import('./revisions')>(), getPlanRevisionSnapshot: reads.snapshot }));
vi.mock('./spec-clauses-store', async (original) => ({ ...await original<typeof import('./spec-clauses-store')>(), listSpecClauses: reads.clauses }));
vi.mock('../../rubrics', async (original) => ({ ...await original<typeof import('../../rubrics')>(), getAcceptanceRubricsForPlan: reads.rubrics }));
vi.mock('./_ctx-opts', async (original) => ({ ...await original<typeof import('./_ctx-opts')>(),
  ctxToPlanSourceOpts: async () => ({}), resolveEffectiveHarnessSlug: () => 'papercusp' }));
vi.mock('../_harness-scope', async (original) => ({ ...await original<typeof import('../_harness-scope')>(), harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx }));
import tool from './evaluate-spec-quality';

const oldBody = '---\ntitle: Replay fixture\nstatus: ready\n---\n## Items\n- **P-001** `todo` Accept an event';
const newBody = oldBody + '\n- **P-002** `todo` Validate an event';
const oldHash = hashPlanContent(oldBody);
const oldClause: SpecClauseRevision = {
  planSlug: 'quality-plan', specId: 'SPEC-001', sourceValId: 'VAL-001', currentRevision: 1, revision: 1,
  planItemId: 'P-001', behavior: 'POST /events returns 202 for a valid event', behaviorClass: 'happy-path',
  requiredEvidence: [], requiredTestLayers: ['integration'], mutationRequired: false,
  lifecycleStatus: 'active', supersedes: null, exemption: null, falsifier: null,
  contentHash: 'a'.repeat(64), createdBy: 'author', createdAt: '2026-08-20T00:00:00.000Z',
  acceptedBy: 'reviewer', acceptedAt: '2026-08-20T00:00:00.000Z', acceptanceRef: 'D-001',
};
const newClause = { ...oldClause, currentRevision: 2, revision: 2, contentHash: 'b'.repeat(64),
  behavior: 'POST /events returns 201 for a valid event', createdAt: '2026-08-21T00:00:00.000Z',
  acceptedAt: '2026-08-21T00:00:00.010Z' };
const oldEvaluation = evaluatePlanSpecQuality({ planSlug: 'quality-plan', harnessSlug: 'papercusp',
  planItemIds: ['P-001'], clauses: [oldClause], classRef: 'plan-class-feature-ship' });
const replaySnapshot = { planContentHash: oldHash, clausesAsOf: '2026-08-20T00:00:00.001Z' };
const replayArgs = { slug: 'quality-plan', harness: 'papercusp', classRef: 'plan-class-feature-ship' as const,
  expectedSpecSetHash: oldEvaluation.specSetHash, replaySnapshot };
const call = async (args: Record<string, unknown>) => {
  const result = await tool.handler(tool.args.parse(args), {} as never);
  return (result as { data: Record<string, any> }).data;
};

beforeEach(() => {
  vi.resetAllMocks();
  reads.plan.mockResolvedValue({ row: { items: [{ id: 'P-001' }, { id: 'P-002' }], template: null,
    templateData: null, inputSchema: null, contentHash: hashPlanContent(newBody) }, parsed: { items: [] } });
  reads.rubrics.mockResolvedValue([{ classRef: 'plan-class-feature-ship' }]);
  reads.snapshot.mockImplementation(async (_slug, hash) => ({ contentSnapshot: hash === oldHash ? oldBody : newBody,
    contentSnapshotHash: hash === oldHash ? oldHash : hashPlanContent(newBody) }));
  reads.clauses.mockImplementation(async (args) => args.asOf === replaySnapshot.clausesAsOf ? [oldClause] : [newClause]);
});

describe('immutable spec-quality replay (WI-10007284)', () => {
  it('reproduces all eight historical findings after both the clause and live item population change', async () => {
    const replay = await call(replayArgs);
    expect(replay).toMatchObject({ ok: true, verdict: 'pass', specSetHash: oldEvaluation.specSetHash, planItemCount: 1 });
    expect(Object.keys(replay.ratings)).toHaveLength(8);
    for (const [key, value] of Object.entries(oldEvaluation.ratings)) {
      expect(replay.ratings[key].rating).toBe(value.rating);
      expect(replay.ratings[key].evidence).toContain(value.evidence);
      const marker = ' Historical replay (same rated snapshot): plans:evaluate-spec-quality ';
      const probe = JSON.parse(replay.ratings[key].evidence.split(marker)[1].slice(0, -1));
      expect((await call(probe)).ratings).toEqual(replay.ratings);
    }
    expect(reads.plan).not.toHaveBeenCalled();
    expect(reads.rubrics).not.toHaveBeenCalled();
  });

  it('retains the live hash refusal and never offers a draft for a newer set', async () => {
    const result = await call({ ...replayArgs, replaySnapshot: undefined });
    expect(result).toMatchObject({ ok: false, error: 'spec_set_hash_mismatch' });
    expect(result.specSetHash).not.toBe(oldEvaluation.specSetHash);
    expect(result).not.toHaveProperty('scorecardDraft');
  });

  it('rejects a later clause-set hash paired with an earlier replay cutoff', async () => {
    const laterEvaluation = evaluatePlanSpecQuality({ planSlug: 'quality-plan', harnessSlug: 'papercusp',
      planItemIds: ['P-001'], clauses: [newClause], classRef: 'plan-class-feature-ship' });
    expect(Date.parse(newClause.acceptedAt)).toBeGreaterThan(Date.parse(replaySnapshot.clausesAsOf));

    const replay = await call({ ...replayArgs, expectedSpecSetHash: laterEvaluation.specSetHash });
    expect(replay).toMatchObject({
      ok: false,
      error: 'spec_set_hash_mismatch',
      expectedSpecSetHash: laterEvaluation.specSetHash,
      specSetHash: oldEvaluation.specSetHash,
    });
    expect(replay).not.toHaveProperty('scorecardDraft');
  });

  it('issues a deterministic, already-reconstructed replay recipe for fresh grades', async () => {
    const first = await call({ slug: 'quality-plan', harness: 'papercusp' });
    const second = await call({ slug: 'quality-plan', harness: 'papercusp' });
    expect(first.ok).toBe(true);
    expect(first).toEqual(second);
    expect(Date.parse(first.replaySnapshot.clausesAsOf)).toBeGreaterThanOrEqual(Date.parse(newClause.acceptedAt));
    const replay = await call({ slug: 'quality-plan', harness: 'papercusp', classRef: first.classRef,
      expectedSpecSetHash: first.specSetHash, replaySnapshot: first.replaySnapshot });
    expect(replay.ratings).toEqual(first.ratings);
  });

  it.each(['missing-plan', 'corrupt-plan', 'missing-clauses', 'store-unavailable', 'wrong-cutoff', 'future-cutoff'])(
    'fails closed for %s without falling back to live data', async (failure) => {
      let args = replayArgs;
      if (failure === 'missing-plan') reads.snapshot.mockResolvedValue(null);
      if (failure === 'corrupt-plan') reads.snapshot.mockResolvedValue({ contentSnapshot: newBody, contentSnapshotHash: hashPlanContent(newBody) });
      if (failure === 'missing-clauses') reads.clauses.mockResolvedValue([]);
      if (failure === 'store-unavailable') reads.snapshot.mockRejectedValue(new Error('store offline'));
      if (failure === 'wrong-cutoff') args = { ...args, replaySnapshot: { ...replaySnapshot, clausesAsOf: '2026-08-21T00:00:00.001Z' } };
      if (failure === 'future-cutoff') args = { ...args, replaySnapshot: { ...replaySnapshot, clausesAsOf: '2999-08-21T00:00:00.001Z' } };
      const result = await call(args);
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('scorecardDraft');
      expect(reads.plan).not.toHaveBeenCalled();
    });

  it('refuses incomplete snapshot identities before any store read', () => {
    expect(tool.args.safeParse({ slug: 'quality-plan', replaySnapshot }).success).toBe(false);
    expect(tool.args.safeParse({ ...replayArgs, expectedSpecSetHash: undefined }).success).toBe(false);
    expect(tool.args.safeParse({ ...replayArgs, replaySnapshot: { ...replaySnapshot, clausesAsOf: 'invalid' } }).success).toBe(false);
    expect(reads.snapshot).not.toHaveBeenCalled();
  });
});
