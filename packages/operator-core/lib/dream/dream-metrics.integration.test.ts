import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createDreamCapabilityFixture } from '../../test/dream-capability-fixture';
import {
  beginDreamRun, beginDreamRunCall, finalizeDreamRun, getDreamRun,
  recordDreamRunAssessment, recordDreamRunReview, recordDreamRunSelection, settleDreamRunCall,
} from './dream-run-store';
import { dreamRunAssessments, type DreamRunAssessment } from './dream-run-provenance';
import { readDreamMetrics, type DreamMetricsScope } from './dream-metrics';
import { PgExperimentLedger } from '../experiment/ledger';
import { summarizeDreamGraphComparison } from './dream-evaluation';

const scope: DreamMetricsScope = {
  workspaceId: 'metrics-pg', potSlug: 'papercusp', since: '2026-09-07T00:00:00Z', until: '2026-09-08T00:00:00Z',
};
describe('Dream metrics and post-run assessments (real PG)', () => {
  let db: OrgTestDb;
  let fixture: Awaited<ReturnType<typeof createDreamCapabilityFixture>>;
  beforeAll(async () => {
    db = await createOrgTestDb();
    fixture = await createDreamCapabilityFixture(scope.workspaceId, scope.potSlug);
  }, 180_000);
  afterAll(async () => {
    if (fixture) await rm(fixture.root, { recursive: true, force: true });
    await db?.cleanup();
    if (!process.env.KEEP_TEST_PG) await teardownTestPg();
  });
  const ref = (runId: string) => ({ workspaceId: scope.workspaceId, runId });
  function assessment(id: string): Omit<DreamRunAssessment, 'recordedAt'> {
    return {
      schemaVersion: 'dream-run-assessment-v1', id, assessor: 'human:fixture-reviewer',
      candidateHash: fixture.review.candidateHash, evidenceHash: fixture.review.evidenceHash,
      familyId: 'composed-output-check', novelty: 'supported', usefulness: 'supported', maintainability: 'unknown',
      evidenceRefs: ['test:independently-labeled-fixture'], experimentBatteryIds: [],
    };
  }
  async function reviewed(runId: string) {
    await beginDreamRun(db.adminSql, { ...ref(runId), cycleId: runId, potSlug: scope.potSlug, mode: 'manual', capability: fixture.header });
    await recordDreamRunSelection(db.adminSql, { ...ref(runId), capability: fixture.sampling });
    for (const call of fixture.provenance.calls) {
      await beginDreamRunCall(db.adminSql, { ...ref(runId), call });
      await settleDreamRunCall(db.adminSql, { ...ref(runId), callId: call.callId, usage: call.usage });
    }
    await recordDreamRunReview(db.adminSql, {
      ...ref(runId), outcome: { verdict: 'insight', insight: fixture.insight },
      review: { ...fixture.review, verdict: 'reject' },
    });
    await db.adminSql`UPDATE harness_shared.dream_runs SET started_at = '2026-09-07T14:00:00Z' WHERE workspace_id = ${scope.workspaceId} AND run_id = ${runId}`;
  }

  it('streams all 501 attempts and excludes another pot/workspace without applying list limits', async () => {
    const ws = 'metrics-pg-population';
    await db.adminSql`
      INSERT INTO harness_shared.dream_runs (workspace_id, run_id, cycle_id, pot_slug, mode, status, started_at)
      SELECT ${ws}, 'attempt-' || n, 'cycle-' || n, ${scope.potSlug}, 'manual', 'no-pair', '2026-09-07T12:00:00Z'
      FROM generate_series(1,501) n`;
    await db.adminSql`
      INSERT INTO harness_shared.dream_runs (workspace_id, run_id, cycle_id, pot_slug, mode, status, started_at)
      VALUES (${ws}, 'other-pot', 'other', 'other-pot', 'manual', 'error', '2026-09-07T12:00:00Z'),
             ('other-workspace', 'other-workspace', 'other', ${scope.potSlug}, 'manual', 'error', '2026-09-07T12:00:00Z')`;
    const report = await readDreamMetrics(db.adminSql, { ...scope, workspaceId: ws });
    expect(report.population).toMatchObject({ complete: true, attempts: 501, legacy: 501 });
    expect(report.funnel.statuses['no-pair']).toBe(501);
    expect(report.funnel.statuses.error).toBe(0);
    expect(report.funnel.noPairRate).toEqual({ numerator: 501, denominator: 501, value: 1 });
  });

  it('appends immutable evidence-bound assessments only after terminal review without changing cost', async () => {
    const id = 'assessments';
    await reviewed(id);
    await expect(recordDreamRunAssessment(db.adminSql, { ...ref(id), assessment: assessment('a1') })).rejects.toThrow(/terminal/);
    const terminal = await finalizeDreamRun(db.adminSql, { ...ref(id), status: 'rejected' });
    await expect(recordDreamRunAssessment(db.adminSql, {
      ...ref(id), assessment: { ...assessment('wrong'), candidateHash: '0'.repeat(64) },
    })).rejects.toThrow(/bind/);
    const first = await recordDreamRunAssessment(db.adminSql, { ...ref(id), assessment: assessment('a1') });
    const replay = await recordDreamRunAssessment(db.adminSql, { ...ref(id), assessment: assessment('a1') });
    expect(dreamRunAssessments(first)).toEqual(dreamRunAssessments(replay));
    expect(dreamRunAssessments(replay)).toHaveLength(1);
    expect(replay.costUsd).toBe(terminal.costUsd);
    expect(replay.status).toBe('rejected');
    await expect(recordDreamRunAssessment(db.adminSql, {
      ...ref(id), assessment: { ...assessment('a1'), usefulness: 'disproven' },
    })).rejects.toThrow(/immutable/);
    await expect(recordDreamRunAssessment(db.adminSql, {
      ...ref(id), assessment: { ...assessment('same-model'), assessor: fixture.header.dreamerModel },
    })).rejects.toThrow(/separate assessor/);
    expect((await getDreamRun(db.adminSql, ref(id)))?.costUsd).toBeCloseTo(0.07);
  });

  it('reads exact Dream routes and linked experiment results without multiplying spend', async () => {
    const id = 'joins';
    await reviewed(id);
    await finalizeDreamRun(db.adminSql, { ...ref(id), status: 'rejected', routedRef: 'wi:EI-901' });
    await recordDreamRunAssessment(db.adminSql, {
      ...ref(id), assessment: { ...assessment('joins-assessment'), experimentBatteryIds: ['dream-fixture-battery'] },
    });
    await db.adminSql`
      INSERT INTO harness_shared.scout_routed_ideas
        (workspace_id, harness_slug, idea_id, lens, rail, routed_ref, routed_at, origin, human_grade, outcome)
      VALUES (${scope.workspaceId}, ${scope.potSlug}, ${'dream:' + id}, 'dream', 'improvement', 'wi:EI-901', 1788790000000, 'dream', 4, 'won')`;
    await new PgExperimentLedger(db.adminSql).record({
      workspaceId: scope.workspaceId, batteryId: 'dream-fixture-battery', testId: 'replay', tier: 'offline',
      arms: [
        { id: 'baseline', label: 'Baseline', meanScore: 0.4, cells: 4, scored: 4, costUsd: 0.02 },
        { id: 'candidate', label: 'Candidate', meanScore: 0.9, cells: 4, scored: 4, costUsd: 0.03 },
      ],
      baselineId: 'baseline', winner: 'candidate', comparison: { verdict: 'winner' }, totalCostUsd: 0.05, budgetExhausted: false,
    });
    const report = await readDreamMetrics(db.adminSql, scope);
    expect(report.population.attempts).toBe(2);
    expect(report.cost.knownCallUsd).toBeCloseTo(0.14);
    expect(report.downstream).toEqual({ routes: { improvement: 1 }, grades: { '4': 1 }, outcomes: { won: 1 } });
    expect(report.experiments).toMatchObject({ linked: 1, executed: 1, winning: 1, recordedCostUsd: 0.05 });
    expect(report.funnel.qualifiedFamilies).toBe(0); // Rejected proposals are not qualified by a good later grade.
  });

  it('P025: round-trips frozen trial accounting through isolated PG without inventing qualified or executed outcomes', async () => {
    const read = (file: string) => JSON.parse(readFileSync(new URL('./study/' + file, import.meta.url), 'utf8'));
    const saved = read('native-graph-evidence-summary.json');
    const protocol = read('native-graph-protocol.json');
    const blindReview = read('native-graph-calibration-review-2026-10-14.json');
    const unblinded = read('native-graph-calibration-unblinded-review-2026-10-14.json');
    const workspaceId = 'metrics-native-study-replay';
    // Fixture provenance supplies the store envelope only. Frozen calls, costs,
    // terminal statuses and independent outcomes are replayed verbatim; this
    // isolated database is not another scientific trial or a production write.
    for (const row of saved.dreams) {
      // The publication view adds derived accounting fields; the strict store
      // envelope contains the original call fields and outcome-level assessments.
      const calls = row.calls.map(({ accountedUsd: _cost, unknownCost: _unknown, ...call }: Record<string, unknown>) => call);
      const provenance = { ...fixture.provenance, calls };
      await db.adminSql`INSERT INTO harness_shared.dream_runs
        (workspace_id, run_id, cycle_id, pot_slug, mode, status, started_at, completed_at, cost_usd, outcome)
        VALUES (${workspaceId}, ${row.runId}, ${row.runId}, ${scope.potSlug}, 'manual', ${row.status},
          '2026-09-07T14:00:00Z', '2026-09-07T14:01:00Z', ${row.accountedUsd},
          ${db.adminSql.json(JSON.parse(JSON.stringify({ capabilityRun: provenance, assessments: row.assessments,
            generationSkipped: row.treatment === 'graph' })))})`;
    }
    const stored = await Promise.all(saved.dreams.map((row: { runId: string }) =>
      getDreamRun(db.adminSql, { workspaceId, runId: row.runId })));
    expect(stored.every(row => row?.status === 'rejected')).toBe(true);
    const metrics = await readDreamMetrics(db.adminSql, { ...scope, workspaceId });
    expect(metrics.population.attempts).toBe(4);
    expect(metrics.cost.knownCallUsd).toBeCloseTo(0.949124, 8);
    expect(metrics.cost.unknownUsageCount).toBe(0);
    expect(metrics.funnel.qualifiedFamilies).toBe(0);
    expect(metrics.experiments).toMatchObject({ linked: 0, executed: 0, winning: 0 });
    const independent = { ref: 'native-graph-calibration-unblinded-review-2026-10-14.json',
      labels: blindReview.cases.map((label: { caseId: string }) => ({ ...label,
        ...unblinded.cases.find((row: { caseId: string }) => row.caseId === label.caseId) })) };
    const rebuilt = summarizeDreamGraphComparison({ protocol: protocol.protocol,
      attempts: saved.dreams.map((row: Parameters<typeof summarizeDreamGraphComparison>[0]['attempts'][number]) => ({ ...row,
        accountedUsd: stored.find(run => run?.runId === row.runId)!.costUsd })), independent });
    expect(rebuilt.treatments).toEqual(saved.treatments);
    expect(rebuilt.matchedPairs).toEqual(saved.matchedPairs);
    expect(rebuilt.verdict).toBe('inconclusive');
    expect(rebuilt.usefulOutcomesPerDollar).toBeNull();
    expect(rebuilt.treatments.map(row => row.qualifiedFamilies)).toEqual([0, 0]);
    const incomplete = summarizeDreamGraphComparison({ protocol: protocol.protocol,
      attempts: saved.dreams.slice(1), independent });
    expect(incomplete.completeAttempts).toBe(false);
    expect(incomplete.verdict).toBe('inconclusive');
  });
});
