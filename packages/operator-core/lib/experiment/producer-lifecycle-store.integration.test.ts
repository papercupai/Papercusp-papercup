/** Actual six producer writers, real migrated PG, no fabricated experiment fixtures. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
import { readProducerObservations, recordProducerObservation } from './producer-lifecycle-store';

const h = vi.hoisted(() => ({ sql: null as unknown, commitAndReproject: vi.fn() }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('../change-ledger/change-ledger', () => ({ recordBehaviorChange: vi.fn(async () => {}) }));
vi.mock('../blueprint/commit-reproject', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../blueprint/commit-reproject')>()),
  commitAndReproject: h.commitAndReproject,
}));

const { recordRoutedIdea, gradeRoutedIdea, propagateWorkItemOutcome, propagatePlanOutcome, refreshScoutOutcomes } = await import('../scout/routed-ledger');
const { recordProposal, decideProposal } = await import('../gym/control-plane');
const { acceptProposalViaCommit } = await import('../blueprint/commit-reproject-real');
const { insertPrediction, resolvePrediction, voidPrediction } = await import('../calibration/store');
const { admitTransferLesson, recordTransferOutcome, markTransferError, setLessonMemoryId, setLessonPackCandidate } = await import('../transfer/store');
const { applyTransferVerdict } = await import('../transfer/gate');
const { upsertFinding, recordReplayScores, markReportFiled } = await import('../replay/regret/store');
const { insertDrillRow, updateDrillDetected, updateDrillTriaged, updateDrillResolved, markDrillFailed, expireStaleDrills } = await import('../red-queen/store');
const { passingCandidateVerdict } = await import('../gym/__tests__/_candidate-verdict');

let db: OrgTestDb;
const WS = 'ws-producer-lifecycle';
const migrationPath = fileURLToPath(new URL('../../../../libs/papercusp/libs/db/sql/1349-producer-learning-lifecycle-receipts.sql', import.meta.url));

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
  // Exercise the reserved draft before it is armed; after arming this is idempotent.
  await db.adminSql.unsafe(readFileSync(existsSync(migrationPath) ? migrationPath : `${migrationPath}.DRAFT`, 'utf8'));
  // Preflight native identity/receipt types before any producer battery runs.
  // String-shaped application IDs do not establish whether PG wants uuid/bigint/text.
  const columns = await db.adminSql`
    SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'harness_shared'
       AND table_name IN ('scout_routed_ideas','gym_proposals','calibration_predictions','transfer_lessons','regret_findings','red_queen_drills')
       AND column_name IN ('id','idea_id','run_id','memory_id','pack_candidate_id','learning_lifecycle')`;
  const types = new Map(columns.map((row) => [`${row.table_name}.${row.column_name}`, row.data_type]));
  for (const [column, expected] of Object.entries({
    'scout_routed_ideas.idea_id': 'text', 'gym_proposals.id': 'text',
    'calibration_predictions.id': 'bigint', 'transfer_lessons.id': 'uuid',
    'regret_findings.run_id': 'text', 'red_queen_drills.id': 'uuid',
    'transfer_lessons.memory_id': 'uuid', 'transfer_lessons.pack_candidate_id': 'uuid',
  })) expect(types.get(column), column).toBe(expected);
  for (const table of ['scout_routed_ideas','gym_proposals','calibration_predictions','transfer_lessons','regret_findings','red_queen_drills']) {
    expect(types.get(`${table}.learning_lifecycle`), table).toBe('jsonb');
  }
}, 180_000);
afterAll(async () => { await db?.cleanup(); });

async function observation(producer: Parameters<typeof readProducerObservations>[1]['producer']) {
  const rows = await readProducerObservations(db.adminSql, { producer, workspaceId: WS });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ contract: null, promotionAllowed: false, sourceCurrent: true });
  expect(rows[0]!.stage).toBe(rows[0]!.lifecycle.stage);
  expect(rows[0]!.lifecycle.sourceRef).toBe(rows[0]!.sourceRef);
  expect(rows[0]!.lifecycle.sourceHash).toBe(rows[0]!.sourceHash);
  return rows[0]!;
}

describe('six actual producer boundaries', () => {
  it('records Scout source identity and resolved provenance; enrollment cannot overwrite an SU source', async () => {
    await recordRoutedIdea({ workspaceId: WS, ideaId: 'scout-output', harnessSlug: 'papercusp', sourceHive: 'papercusp', lens: 'analogical', rail: 'improvement', routedRef: 'wi:EI-test', modelSpec: 'resolved-model', modelConfig: { temperature: 0.2 } });
    const row = await observation('scout');
    expect(row.source).toMatchObject({ idea_id: 'scout-output', routed_ref: 'wi:EI-test', model_spec: 'resolved-model', origin: 'scout' });
    expect(row.lifecycle).toMatchObject({ stage: 'candidate', producer: 'scout',
      candidate: { status: 'partial', values: [{ id: 'scout-output', potScope: { workspaceId: WS, potId: null } }] },
      experiment: { status: 'not-applicable' }, decision: { status: 'not-applicable' } });
    await recordRoutedIdea({ workspaceId: WS, ideaId: 'su-output', harnessSlug: 'papercusp', sourceHive: 'papercusp', lens: 'su-ideate', rail: 'improvement', routedRef: 'wi:EI-su', origin: 'su-ideate' });
    await recordRoutedIdea({ workspaceId: WS, ideaId: 'su-output', harnessSlug: 'papercusp', sourceHive: 'papercusp', lens: 'analogical', rail: 'improvement', routedRef: 'wi:EI-su', preserveExisting: true });
    expect((await readProducerObservations(db.adminSql, { producer: 'scout', workspaceId: WS })).map((r) => r.sourceRef)).toEqual(['scout:scout-output']);
  });

  it('preserves Gym immutable verdicts and actual decisions without upgrading them to common acceptance', async () => {
    const id = await recordProposal(db.adminSql, { workspaceId: WS, harnessSlug: 'papercusp', cycle: 1, variantId: 'gym-output', role: 'worker', proposedMd: 'candidate prompt', candidateVersion: passingCandidateVerdict('gym-output') });
    expect((await observation('gym')).source.status).toBe('pending');
    const decision = await decideProposal(db.adminSql, { workspaceId: WS, harnessSlug: 'papercusp', id, decision: 'accepted' });
    expect(decision).toMatchObject({ ok: true, promoted: true });
    const row = await observation('gym');
    expect(row.source).toMatchObject({ status: 'accepted', candidate_verdict: { candidateId: 'gym-output', verdict: 'accept' } });
    expect(row.lifecycle).toMatchObject({ stage: 'activation',
      evidence: { values: expect.arrayContaining([expect.objectContaining({ id: expect.stringContaining('real-anchor-no-regress'), status: 'pass' })]) },
      decision: { status: 'partial', value: { verdict: 'accepted', authority: null } },
      spend: { status: 'unknown', value: null }, activation: { status: 'partial' } });
    expect(row.promotionAllowed).toBe(false);
    await recordProposal(db.adminSql, { workspaceId: WS, harnessSlug: 'papercusp', id, cycle: 2, role: 'worker', proposedMd: 'must not resurrect' });
    expect((await observation('gym')).source.proposed_md).toBe('candidate prompt');
    expect((await decideProposal(db.adminSql, { workspaceId: WS, harnessSlug: 'papercusp', id, decision: 'rejected' })).ok).toBe(false);
  });

  it('records the blueprint commit/reproject acceptance in the same real producer receipt store', async () => {
    const workspaceId = 'ws-gym-commit-reproject';
    const id = await recordProposal(db.adminSql, { workspaceId, harnessSlug: 'papercusp', cycle: 1,
      id: 'gym-commit-reproject', role: 'worker', proposedMd: 'accepted prompt',
      candidateVersion: passingCandidateVerdict('gym-commit-reproject') });
    h.commitAndReproject.mockResolvedValue({
      ok: true, committed: true, commit: 'commit-1', contentHash: 'hash-1',
      editedPath: '.papercusp/prompts/worker.md', blueprintPath: '.papercusp/blueprint.yaml',
    });

    const accepted = await acceptProposalViaCommit(db.adminSql, {
      workspaceId, harnessSlug: 'papercusp', harnessDir: '/test/harness',
      proposalId: id, role: 'worker', proposedMd: 'accepted prompt', now: 1,
    });
    const replay = await acceptProposalViaCommit(db.adminSql, {
      workspaceId, harnessSlug: 'papercusp', harnessDir: '/test/harness',
      proposalId: id, role: 'worker', proposedMd: 'accepted prompt', now: 2,
    });

    expect(accepted).toMatchObject({ ok: true, proposalMarked: true });
    expect(replay).toMatchObject({ ok: true, proposalMarked: false });
    const [receipt] = await readProducerObservations(db.adminSql, { producer: 'gym', workspaceId });
    expect(receipt).toMatchObject({ producer: 'gym', sourceRef: `gym:${id}`, sourceCurrent: true,
      contract: null, promotionAllowed: false,
      lifecycle: { stage: 'activation', decision: { status: 'partial', value: { verdict: 'accepted', authority: null } },
        activation: { status: 'partial' } } });
  });

  it('captures evaluation before the source read yields and retains it through a later native write', async () => {
    const workspaceId = 'ws-gym-evaluation-alias';
    const id = await recordProposal(db.adminSql, { workspaceId, harnessSlug: 'papercusp', cycle: 1,
      id: 'gym-evaluation-alias', role: 'worker', proposedMd: 'original prompt' });
    const evaluation = { codeHash: null, runs: [{ id: 'original-run', score: 0.8 }] };
    const scope = { producer: 'gym' as const, workspaceId, sourceId: id, evaluation };
    let reachedRead!: () => void;
    let releaseRead!: () => void;
    const reading = new Promise<void>((resolve) => { reachedRead = resolve; });
    const released = new Promise<void>((resolve) => { releaseRead = resolve; });
    const writing = db.adminSql.begin(async (tx) => {
      // Both statements use real private PG; only the scheduling boundary is held.
      const gatedSql = { unsafe: async (query: string, params: never[]) => {
        const rows = await tx.unsafe(query, params);
        if (query.startsWith('SELECT')) {
          reachedRead();
          await released;
        }
        return rows;
      } } as unknown as typeof db.adminSql;
      await recordProducerObservation(gatedSql, scope);
    });
    await reading;
    try {
      evaluation.runs[0]!.id = 'unrelated-run';
      evaluation.runs[0]!.score = -1;
    } finally {
      releaseRead();
    }
    await writing;
    const [captured] = await readProducerObservations(db.adminSql, { producer: 'gym', workspaceId });
    expect(captured).toMatchObject({ contract: null, promotionAllowed: false, evaluationCurrent: true,
      evaluation: { codeHash: null, runs: [{ id: 'original-run', score: 0.8 }] } });
    await recordProposal(db.adminSql, { workspaceId, harnessSlug: 'papercusp', cycle: 2,
      id, role: 'worker', proposedMd: 'later prompt' });
    const [updated] = await readProducerObservations(db.adminSql, { producer: 'gym', workspaceId });
    expect(updated).toMatchObject({ sourceCurrent: true, evaluationCurrent: false, promotionAllowed: false,
      evaluation: captured!.evaluation, evaluationSourceHash: captured!.evaluationSourceHash });
  });

  it('captures scored and void calibration outcomes; a duplicate open prediction remains a no-op', async () => {
    const input = { workspaceId: WS, predictor: 'predictor', domain: 'fix-survival', subjectKind: 'work-item', subjectId: 'EI-test', claim: 'fix survives', probability: 0.8, stated: true, origin: 'organic' as const, horizonTs: '2026-10-03T00:00:00Z', potSlug: null };
    const first = await insertPrediction(db.adminSql, input);
    expect(first.created).toBe(true);
    expect(await insertPrediction(db.adminSql, input)).toEqual({ created: false, id: null });
    expect((await observation('calibration')).source.outcome).toBeNull();
    expect(await resolvePrediction(db.adminSql, { id: first.id!, outcome: false, nowIso: '2026-10-03T01:00:00Z' })).toBe(true);
    const scored = await observation('calibration');
    expect(scored.source).toMatchObject({ outcome: false, probability: 0.8, pot_slug: null });
    expect(scored.lifecycle).toMatchObject({ stage: 'outcome', candidate: { status: 'not-applicable' },
      evidence: { values: [{ kind: 'objective', status: 'fail', coverage: { required: 1, measured: 1 } }] },
      outcomes: { values: [{ status: 'matured', value: 0 }] } });
    const other = await insertPrediction(db.adminSql, { ...input, subjectId: 'EI-void' });
    expect(await voidPrediction(db.adminSql, { id: other.id!, note: 'undetermined', nowIso: '2026-10-03T01:00:00Z' })).toBe(true);
    const rows = await readProducerObservations(db.adminSql, { producer: 'calibration', workspaceId: WS });
    expect(rows.find((r) => r.sourceRef === `calibration:${other.id}`)?.source).toMatchObject({ outcome: null, resolution_note: 'undetermined' });
  });

  it('captures transfer admission and refuses scored promotion without a complete common decision', async () => {
    const result = await admitTransferLesson(db.adminSql, { workspaceId: WS, signature: 'transfer-output', lessonText: 'preserve provenance', potSlug: 'papercusp', sourceRef: 'transcript:original' });
    expect(result.admitted).toBe(true);
    if (!result.admitted) throw new Error('fixture admission failed');
    const id = result.lesson.id;
    expect((await observation('transfer')).source).toMatchObject({ tier: 'probationary', source_ref: 'transcript:original' });
    await recordTransferOutcome(db.adminSql, { workspaceId: WS, id, batteryId: 'actual-test-battery', delta: 0.1, transition: applyTransferVerdict(result.lesson, 'passed') });
    expect((await observation('transfer')).source).toMatchObject({ tier: 'probationary', status: 'error', pass_count: 0,
      last_battery_id: 'actual-test-battery', test_count: 1 });
  });

  it('captures regret replay/report output from persisted rows, including paid-for carry-forward on re-mine', async () => {
    const finding = { workspaceId: WS, runId: 'regret-output', harnessSlug: 'papercusp', role: 'worker', badnessScore: 0.7, badnessReasons: ['timeout'], divergenceTurn: 2, divergenceKind: 'error-loop', divergenceEvidence: null,
      candidateChanges: [{ id: 'stop-retry', title: 'Stop retrying', promptDelta: 'stop after two failures', rationale: 'avoid repeated failures', fromTurn: 2 }],
      replayStatus: 'pending' as const, replayScores: null, reportImprovementId: null, minedAt: '2026-10-03T00:00:00Z' };
    await upsertFinding(db.adminSql, finding);
    await recordReplayScores(db.adminSql, WS, finding.runId, [{ candidateId: 'stop-retry', improvementScore: 0.2, summary: 'fewer retries', costUsd: 0.01 }]);
    await markReportFiled(db.adminSql, WS, finding.runId, 'EI-report');
    await upsertFinding(db.adminSql, { ...finding, badnessScore: 0.8 });
    const row = await observation('regret');
    expect(row.source).toMatchObject({ replay_status: 'replayed', replay_scores: [{ candidateId: 'stop-retry' }], report_improvement_id: 'EI-report', badness_score: 0.8 });
    expect(row.lifecycle).toMatchObject({ stage: 'outcome', candidate: { values: [{ id: 'stop-retry' }] },
      evidence: { values: [{ kind: 'objective', status: 'pass' }] },
      outcomes: { values: [{ status: 'matured', value: 0.2 }] }, spend: { status: 'unknown', value: null } });
  });

  it('retains Red Queen planted and resolved drill provenance without claiming a production experiment', async () => {
    const { drillId } = await insertDrillRow(db.adminSql, { workspaceId: WS, drillClass: 'class-output', collectorFamily: 'test', expectedWatchdogKey: 'test:drill', expectedKind: 'bug', expectedSeverity: 'major', artifacts: { ref: 'drill:planted' } });
    expect((await observation('red-queen')).source).toMatchObject({ status: 'planted', planted_artifacts: { ref: 'drill:planted' } });
    await updateDrillResolved(db.adminSql, drillId, { resolvedAt: '2026-10-03T01:00:00Z', resolvedWithEvidence: false, mttsh: { totalMs: 100 }, leakCheck: { passed: true, organicReadClean: true, liveCollectorClean: true, capturedOriginIsDrill: true } });
    const row = await observation('red-queen');
    expect(row.source).toMatchObject({ status: 'resolved', resolved_with_evidence: false, leak_check_passed: true });
    expect(row.lifecycle).toMatchObject({ stage: 'outcome', candidate: { status: 'not-applicable' },
      evidence: { values: expect.arrayContaining([expect.objectContaining({ kind: 'regression', status: 'pass' })]) },
      outcomes: { values: [{ status: 'matured', value: 100 }] }, decision: { status: 'not-applicable' } });
  });
});

describe('transaction and freshness guards', () => {
  it('keeps Scout grades, terminal routes and batched reconciliation in the common receipt', async () => {
    const workspaceId = 'ws-scout-state';
    await recordRoutedIdea({ workspaceId, ideaId: 'state-wi', harnessSlug: 'papercusp', sourceHive: 'papercusp', lens: 'analogical', rail: 'improvement', routedRef: 'wi:EI-state' });
    await recordRoutedIdea({ workspaceId, ideaId: 'state-plan', harnessSlug: 'papercusp', sourceHive: 'papercusp', lens: 'analogical', rail: 'plan', routedRef: 'plan:state-plan' });
    expect(await gradeRoutedIdea({ ideaId: 'state-wi', grade: 4, gradedBy: 'owner', feedback: 'useful' })).toMatchObject({ applied: true });
    expect(await gradeRoutedIdea({ ideaId: 'state-wi', grade: 1, gradedBy: 'auto-grader' })).toMatchObject({ applied: false, reason: 'owner-grade-sovereign' });
    expect(await propagateWorkItemOutcome({ workspaceId, workItemId: 'EI-state', state: 'done' })).toBe(1);
    expect(await propagatePlanOutcome({ workspaceId, planSlug: 'state-plan', status: 'shipped' })).toBe(1);
    const before = await readProducerObservations(db.adminSql, { producer: 'scout', workspaceId });
    expect(before).toHaveLength(2);
    expect(before.every((row) => row.sourceCurrent)).toBe(true);
    expect(before.find((row) => row.sourceRef === 'scout:state-wi')?.source).toMatchObject({ human_grade: 4, graded_by: 'owner', outcome: 'won' });
    await refreshScoutOutcomes({ workspaceId, harnessSlug: 'papercusp', potSlug: 'papercusp', ideaIds: ['state-wi', 'state-plan'] });
    const after = await readProducerObservations(db.adminSql, { producer: 'scout', workspaceId });
    expect(after).toHaveLength(2);
    expect(after.every((row) => row.sourceCurrent && !row.promotionAllowed)).toBe(true);
  });

  it('keeps transfer error and memory/pack links current without inventing evaluation pins', async () => {
    const workspaceId = 'ws-transfer-state';
    const result = await admitTransferLesson(db.adminSql, { workspaceId, signature: 'state-transfer', lessonText: 'state', potSlug: 'papercusp' });
    if (!result.admitted) throw new Error('fixture admission failed');
    const id = result.lesson.id;
    const memoryId = randomUUID();
    const candidateId = randomUUID();
    await markTransferError(db.adminSql, { workspaceId, id });
    await setLessonMemoryId(db.adminSql, { workspaceId, id, memoryId });
    await setLessonPackCandidate(db.adminSql, { workspaceId, id, packCandidateId: candidateId });
    const rows = await readProducerObservations(db.adminSql, { producer: 'transfer', workspaceId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceCurrent: true, contract: null, source: { status: 'error', memory_id: memoryId, pack_candidate_id: candidateId, last_battery_id: null } });
    await expect(markTransferError(db.adminSql, { workspaceId, id: '00000000-0000-0000-0000-000000000000' })).resolves.toBeUndefined();
  });

  it('keeps Red Queen intermediate, failure and batched expiry output current and isolated', async () => {
    const workspaceId = 'ws-redqueen-state';
    const plant = (drillClass: string) => insertDrillRow(db.adminSql, { workspaceId, drillClass, collectorFamily: 'test', expectedWatchdogKey: 'test:state', expectedKind: 'bug', expectedSeverity: 'major', artifacts: {} });
    const first = await plant('state-first');
    await updateDrillDetected(db.adminSql, first.drillId, { detectedAt: '2026-10-03T00:00:00Z', detectedWatchdogKey: 'test:state', issueId: 'EI-drill' });
    await updateDrillTriaged(db.adminSql, first.drillId, { triagedAt: '2026-10-03T01:00:00Z', triagedDecision: 'implement' });
    expect((await readProducerObservations(db.adminSql, { producer: 'red-queen', workspaceId }))[0]).toMatchObject({ sourceCurrent: true, source: { status: 'triaged', issue_id: 'EI-drill', triaged_decision: 'implement' } });
    await markDrillFailed(db.adminSql, first.drillId, 'test failure');
    expect((await readProducerObservations(db.adminSql, { producer: 'red-queen', workspaceId }))[0]).toMatchObject({ sourceCurrent: true, source: { status: 'failed', error: 'test failure' } });
    const second = await plant('state-second');
    const third = await plant('state-third');
    await db.adminSql`UPDATE harness_shared.red_queen_drills SET planted_at = '2026-01-01' WHERE id IN (${second.drillId}, ${third.drillId})`;
    expect(await expireStaleDrills(db.adminSql, workspaceId, 24)).toBe(2);
    const rows = await readProducerObservations(db.adminSql, { producer: 'red-queen', workspaceId });
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.sourceCurrent && !row.promotionAllowed)).toBe(true);
    expect(rows.filter((row) => row.source.status === 'expired')).toHaveLength(2);
  });

  it('rolls back the source write if the common receipt cannot persist', async () => {
    await db.adminSql.unsafe(`ALTER TABLE harness_shared.calibration_predictions ADD CONSTRAINT receipt_failure_test CHECK (learning_lifecycle IS NULL) NOT VALID`);
    try {
      await expect(insertPrediction(db.adminSql, { workspaceId: WS, predictor: 'rollback', domain: 'fix-survival', subjectKind: 'work-item', subjectId: 'EI-rollback', claim: 'rollback', probability: 0.5, stated: false, origin: 'drill', horizonTs: '2026-10-03T00:00:00Z', potSlug: null })).rejects.toThrow();
      const rows = await db.adminSql`SELECT id FROM harness_shared.calibration_predictions WHERE workspace_id = ${WS} AND predictor = 'rollback'`;
      expect(rows).toHaveLength(0);
    } finally {
      await db.adminSql.unsafe(`ALTER TABLE harness_shared.calibration_predictions DROP CONSTRAINT receipt_failure_test`);
    }
  });

  it('reuses an outer transaction and reports stale receipts after an unadapted source update', async () => {
    await db.adminSql.begin(async (tx) => {
      const id = await recordProposal(tx as unknown as typeof db.adminSql, { workspaceId: 'ws-outer', harnessSlug: 'papercusp', cycle: 1, id: 'outer-output', role: 'worker', proposedMd: 'outer' });
      expect(id).toBe('outer-output');
    });
    expect((await readProducerObservations(db.adminSql, { producer: 'gym', workspaceId: 'ws-outer' }))[0]?.sourceCurrent).toBe(true);
    await db.adminSql`UPDATE harness_shared.gym_proposals SET proposed_md = 'changed' WHERE id = 'outer-output'`;
    expect((await readProducerObservations(db.adminSql, { producer: 'gym', workspaceId: 'ws-outer' }))[0]).toMatchObject({ sourceCurrent: false, promotionAllowed: false, source: { proposed_md: 'outer' } });
    expect(await readProducerObservations(db.adminSql, { producer: 'gym', workspaceId: 'ws-unrelated' })).toEqual([]);
  });
});
