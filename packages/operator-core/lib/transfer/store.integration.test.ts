/**
 * store.integration.test.ts — transfer-lesson SQL over migration 250
 * (self-learning-frontier P-022 / FB-08). Provisions a throwaway DB with the
 * full live schema (provisionGymDatabase applies 000-baseline + every pending
 * migration, so 250's transfer_lessons exists), then round-trips: free
 * probationary admission + signature dedup, the test queue's ordering
 * (probationary-first, stalest-first, validated re-validation), gate
 * transitions (promote / demote / retire), error marking, and the
 * memory/pack links.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { getTestPg, teardownTestPg } from '@papercusp/test-config/pg';
import { provisionGymDatabase } from '../gym/gym-db-init';
import { adaptTransferOutput } from '../experiment/lifecycle-adapter';
import { readProducerObservations } from '../experiment/producer-lifecycle-store';
import type { TransferLesson, TransferReplayEvidence } from './types';
import { transferReplayPort } from './replay-adapter';
import { runReplayBattery } from '../replay';
import {
  admitTransferLesson,
  getLessonBySignature,
  getTransferLesson,
  listLessonsForTesting,
  listTransferLessons,
  markTransferError,
  recordTransferOutcome,
  setLessonMemoryId,
  setLessonPackCandidate,
  transferLessonArtifactHash,
} from './store';

let sql: postgres.Sql;
let containerUri: string;
const dbName = `transfer_${randomBytes(5).toString('hex')}`;
const WS = 'ws-transfer-test';

/** Fully measured controlled producer evidence; no provider calls. */
function evaluated(lesson: TransferLesson): TransferReplayEvidence {
  const batteryId = `transfer:${lesson.id}:t${lesson.testCount + 1}`;
  const completedAt = '2026-10-03T09:00:00.000Z';
  const experiment = { batteryId, testId: 'replay', baselineId: 'baseline', challengerId: 'with-lesson',
    taskHash: 'controlled-task', modelHash: 'controlled-model', promptHash: 'controlled-prompt',
    rubricHash: 'controlled-rubric', codeHash: 'controlled-code', repeats: 1,
    startedAt: '2026-10-03T08:59:00.000Z', completedAt };
  const outcomes = ['baseline', 'with-lesson'].map((variantId, index) => ({
    runId: `${batteryId}:${variantId}`, variantId, caseId: lesson.id, caseRef: lesson.sourceRef!, repeat: 0,
    status: 'scored' as const, d1: 6 + index * 1.2, d2: 6 + index * 1.2, d3: 6 + index * 1.2,
    composite: 6 + index * 1.2, divergence: null, runUsd: 0.01, judgeUsd: 0.01, replayed: true,
  }));
  const reservation = { id: `reservation:${batteryId}`, workspaceId: WS, loopId: 'frontier:replay-harness',
    potSlug: lesson.potSlug, attemptKind: 'evaluation', requestedUsd: 0.5, reservedUsd: 0.5, usedUsd: 0.04,
    status: 'settled' as const, signalOrigin: 'replay', runRef: batteryId, note: 'controlled test',
    createdAt: Date.parse(experiment.startedAt), settledAt: Date.parse(completedAt) };
  const artifactRefs = [`transfer:${lesson.id}`, `learning-reservation:${reservation.id}`,
    ...outcomes.map((cell) => `replay-run:${cell.runId}`)];
  const contract = adaptTransferOutput({
    candidate: { id: lesson.id, version: lesson.signature, parentVersion: 'controlled-baseline',
      variantHash: transferLessonArtifactHash(lesson), actor: { kind: 'system', id: 'controlled-producer' },
      potScope: { workspaceId: WS, potId: lesson.potSlug! }, createdAt: lesson.createdAt },
    experiment, evidence: (['objective', 'judgment', 'regression', 'probe', 'cost', 'rollback'] as const)
      .map((kind) => ({ id: `${batteryId}:${kind}`, kind, status: 'pass',
        coverage: { required: 2, measured: 2 }, artifactRefs, recordedAt: completedAt })),
    spend: { requestedUsd: 0.5, reservedUsd: 0.5, usedUsd: 0.04, unsettledUsd: 0, settledAt: completedAt },
    verdict: 'accept', authority: { kind: 'system', id: 'controlled-decision' },
    reason: 'controlled measured pair meets gate', decidedAt: completedAt,
  }).contract;
  return { experiment, outcomes, reservation, contract, costMeasured: true, budgetExhausted: false,
    invocations: [], loadedCode: { adapter: null, battery: null } };
}

beforeAll(async () => {
  containerUri = await getTestPg();
  const { databaseUri } = await provisionGymDatabase({ maintenanceUri: containerUri, dbName });
  sql = postgres(databaseUri, { max: 2, onnotice: () => {}, prepare: false });
}, 180_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const maint = postgres(containerUri, { max: 1, onnotice: () => {} });
  try {
    await maint.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await maint.end({ timeout: 5 });
  }
  // Best-effort: the reused test container is shared across vitest processes
  // on the dev box — a concurrent suite's teardown can stop it first (404).
  if (!process.env.KEEP_TEST_PG) await teardownTestPg().catch(() => {});
});

describe('admission (D-006: free, probationary, signature-deduped)', () => {
  it('admits a lesson probationary with origin=replay defaults', async () => {
    const result = await admitTransferLesson(sql, {
      workspaceId: WS,
      signature: 'sig-a',
      title: 'Run tests first',
      lessonText: 'Always run the affected tests.',
      sourceRef: '/logs/a.jsonl',
    });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    expect(result.lesson).toMatchObject({
      workspaceId: WS,
      signature: 'sig-a',
      tier: 'probationary',
      status: 'candidate',
      sourceKind: 'transcript',
      signalOrigin: 'replay',
      testCount: 0,
      memoryId: null,
    });
  });

  it('a duplicate signature is a no-op returning the existing row', async () => {
    const dup = await admitTransferLesson(sql, {
      workspaceId: WS,
      signature: 'sig-a',
      lessonText: 'Always run the affected tests. (reworded)',
    });
    expect(dup.admitted).toBe(false);
    if (dup.admitted) return;
    expect(dup.lesson?.lessonText).toBe('Always run the affected tests.');
    expect(await getLessonBySignature(sql, { workspaceId: WS, signature: 'sig-a' })).not.toBeNull();
  });
});

describe('the test queue + gate transitions', () => {
  it('orders probationary-first, never-tested leading; validated rows trail for re-validation', async () => {
    const b = await admitTransferLesson(sql, { workspaceId: WS, signature: 'sig-b', lessonText: 'B' });
    const c = await admitTransferLesson(sql, { workspaceId: WS, signature: 'sig-c', lessonText: 'C', potSlug: 'test-pot' });
    expect(b.admitted && c.admitted).toBe(true);
    if (!b.admitted || !c.admitted) return;

    // Promote C (pass) → validated; B + sig-a stay probationary untested.
    await recordTransferOutcome(sql, {
      workspaceId: WS,
      id: c.lesson.id,
      transition: { tier: 'validated', status: 'passed', passCount: 1, failCount: 0, forgetMemory: false },
      batteryId: `transfer:${c.lesson.id}:t1`,
      delta: 1.2,
      evaluation: evaluated(c.lesson),
    });

    const queue = await listLessonsForTesting(sql, { workspaceId: WS, limit: 10 });
    const tiers = queue.map((l) => l.tier);
    expect(tiers.slice(0, tiers.filter((t) => t === 'probationary').length).every((t) => t === 'probationary')).toBe(
      true,
    );
    expect(tiers[tiers.length - 1]).toBe('validated'); // re-validation tail
    const promoted = await getTransferLesson(sql, { workspaceId: WS, id: c.lesson.id });
    expect(promoted).toMatchObject({ tier: 'validated', status: 'passed', testCount: 1, lastBatteryId: `transfer:${c.lesson.id}:t1` });
    expect(promoted?.lastDelta).toBeCloseTo(1.2);
    expect(promoted?.lastTestedAt).toBeTruthy();
  });

  it('a retire transition leaves the queue (retired rows are never re-tested)', async () => {
    const d = await admitTransferLesson(sql, { workspaceId: WS, signature: 'sig-d', lessonText: 'D' });
    expect(d.admitted).toBe(true);
    if (!d.admitted) return;
    await recordTransferOutcome(sql, {
      workspaceId: WS,
      id: d.lesson.id,
      transition: { tier: 'retired', status: 'failed', passCount: 0, failCount: 3, forgetMemory: true },
      batteryId: 'bat-2',
      delta: -0.4,
    });
    const queue = await listLessonsForTesting(sql, { workspaceId: WS, limit: 50 });
    expect(queue.find((l) => l.id === d.lesson.id)).toBeUndefined();
    expect(await listTransferLessons(sql, { workspaceId: WS, tier: 'retired' })).toHaveLength(1);
  });

  it('markTransferError records the attempt without a fail-count bump', async () => {
    const e = await admitTransferLesson(sql, { workspaceId: WS, signature: 'sig-e', lessonText: 'E' });
    expect(e.admitted).toBe(true);
    if (!e.admitted) return;
    await markTransferError(sql, { workspaceId: WS, id: e.lesson.id });
    const row = await getTransferLesson(sql, { workspaceId: WS, id: e.lesson.id });
    expect(row).toMatchObject({ status: 'error', testCount: 1, failCount: 0, tier: 'probationary' });
  });
});

describe('common decision promotion boundary', () => {
  let sequence = 0;
  const proposal = (lesson: TransferLesson, evaluation?: TransferReplayEvidence) => ({
    workspaceId: WS, id: lesson.id,
    transition: { tier: 'validated' as const, status: 'passed' as const,
      passCount: lesson.passCount + 1, failCount: lesson.failCount, forgetMemory: false },
    batteryId: `transfer:${lesson.id}:t${lesson.testCount + 1}`, delta: 1.2, evaluation,
  });

  it('round-trips actual runner artifacts without turning narrative evidence into promotion', async () => {
    const admitted = await admitTransferLesson(sql, { workspaceId: WS, signature: 'runner-artifact-receipt',
      lessonText: 'Controlled lesson bytes', sourceRef: '/controlled/artifacts', potSlug: 'test-pot' });
    if (!admitted.admitted) throw new Error('fixture admission failed');
    const port = transferReplayPort({ workspaceId: WS,
      runner: async () => ({ outputText: 'controlled runner response bytes', costUsd: 0.01,
        inputTokens: 3, outputTokens: 4, replayed: true,
        execution: { model: 'controlled-student', codeHash: null, unresolved: ['remote-runtime'] } }),
      llmCall: async ({ messages }) => {
        const score = messages[0].content.includes('variant: Controlled lesson bytes') ? 8 : 6;
        return { text: JSON.stringify({ d1: score, d2: score, d3: score, rationale: 'controlled judge bytes' }),
          inputTokens: 1, outputTokens: 1, costUsd: 0.01 };
      },
      runGoverned: async ({ config }, deps) => ({ verdict: { allow: true, remainingUsd: 1 },
        result: await runReplayBattery(config, deps), reservation: evaluated(admitted.lesson).reservation! }),
    });
    const outcome = await port({ lesson: admitted.lesson, transcript: { ref: admitted.lesson.sourceRef!, turns: [
      { index: 0, role: 'user', text: 'controlled source task bytes' },
      { index: 1, role: 'assistant', text: 'controlled historical continuation bytes' },
    ] } });
    const proof = outcome.evaluation!;
    expect(await recordTransferOutcome(sql, { ...proposal(admitted.lesson, proof),
      delta: outcome.withComposite - outcome.baselineComposite })).toMatchObject({ tier: 'probationary', status: 'error' });
    const receipts = await readProducerObservations(sql, { producer: 'transfer', workspaceId: WS, limit: 100 });
    const receipt = receipts.find((r) => r.sourceRef === `transfer:${admitted.lesson.id}`);
    expect(receipt).toMatchObject({ promotionAllowed: false, sourceCurrent: true, evaluationCurrent: true });
    expect(receipt?.evaluation).toEqual(proof);
    expect(receipt?.evaluation).toMatchObject({ source: { lesson: admitted.lesson },
      invocations: [{ response: { outputText: 'controlled runner response bytes' } },
        { response: { outputText: 'controlled runner response bytes' } }],
      experiment: { codeHash: null }, contract: { decision: { verdict: 'inconclusive' } } });
  });

  it('persists the complete common decision atomically and invalidates its authority on later source drift', async () => {
    const admitted = await admitTransferLesson(sql, { workspaceId: WS, signature: 'common-accepted',
      lessonText: 'Accepted controlled lesson', sourceRef: '/controlled/transcript', potSlug: 'test-pot' });
    if (!admitted.admitted) throw new Error('fixture admission failed');
    const proof = evaluated(admitted.lesson);
    expect(await recordTransferOutcome(sql, proposal(admitted.lesson, proof))).toMatchObject({ tier: 'validated', passCount: 1 });
    let receipts = await readProducerObservations(sql, { producer: 'transfer', workspaceId: WS, limit: 100 });
    expect(receipts.find((r) => r.sourceRef === `transfer:${admitted.lesson.id}`)).toMatchObject({
      stage: 'decision', contract: proof.contract, promotionAllowed: true, sourceCurrent: true });
    await sql`UPDATE harness_shared.transfer_lessons SET lesson_text = 'changed artifact' WHERE id = ${admitted.lesson.id}`;
    receipts = await readProducerObservations(sql, { producer: 'transfer', workspaceId: WS, limit: 100 });
    expect(receipts.find((r) => r.sourceRef === `transfer:${admitted.lesson.id}`)).toMatchObject({ promotionAllowed: false, sourceCurrent: false });
  });

  it('does not publish an accepted contract receipt when the producer cost gate rejects promotion', async () => {
    const admitted = await admitTransferLesson(sql, { workspaceId: WS, signature: 'common-cost-denied',
      lessonText: 'Cost denial must stay non-promotable', sourceRef: '/controlled/transcript', potSlug: 'test-pot' });
    if (!admitted.admitted) throw new Error('fixture admission failed');
    const proof = evaluated(admitted.lesson);
    proof.costMeasured = false;
    expect(await recordTransferOutcome(sql, proposal(admitted.lesson, proof))).toMatchObject({
      tier: 'probationary', status: 'error', testCount: 1, passCount: 0, failCount: 0 });
    const receipt = (await readProducerObservations(sql, { producer: 'transfer', workspaceId: WS, limit: 100 }))
      .find((row) => row.sourceRef === `transfer:${admitted.lesson.id}`);
    expect(receipt).toMatchObject({ contract: null, promotionAllowed: false, sourceCurrent: true,
      source: { tier: 'probationary', status: 'error' },
      lifecycle: { decision: { status: 'partial', value: { verdict: 'inconclusive' } } },
      evaluation: { costMeasured: false, contract: { decision: { verdict: 'accepted' } } } });
  });

  it.each(['absent', 'artifact', 'workspace', 'pot', 'pin', 'open', 'unknown-cost', 'cap', 'cells', 'spend', 'rejected', 'references', 'missing-gate'] as const)(
    'retains the attempt without promoting when %s evidence is invalid', async (kind) => {
      const admitted = await admitTransferLesson(sql, { workspaceId: WS, signature: `guard-${++sequence}`,
        lessonText: 'Controlled guarded lesson', sourceRef: '/controlled/transcript', potSlug: 'test-pot' });
      if (!admitted.admitted) throw new Error('fixture admission failed');
      const proof = evaluated(admitted.lesson);
      const contract = proof.contract!;
      if (kind === 'artifact') proof.contract = { ...contract, candidate: { ...contract.candidate, variantHash: 'other' } };
      if (kind === 'workspace' || kind === 'pot') proof.contract = { ...contract, candidate: { ...contract.candidate,
        potScope: { workspaceId: kind === 'workspace' ? 'foreign' : WS, potId: kind === 'pot' ? 'foreign' : 'test-pot' } } };
      if (kind === 'pin') proof.experiment = { ...proof.experiment, codeHash: null };
      if (kind === 'open') proof.reservation = { ...proof.reservation!, status: 'open', settledAt: null };
      if (kind === 'unknown-cost') proof.costMeasured = false;
      if (kind === 'cap') proof.budgetExhausted = true;
      if (kind === 'cells') proof.outcomes = proof.outcomes.slice(0, 1);
      if (kind === 'spend') proof.reservation = { ...proof.reservation!, usedUsd: 0.02 };
      if (kind === 'rejected') proof.contract = { ...contract, decision: { ...contract.decision, verdict: 'rejected' } };
      if (kind === 'references') proof.contract = { ...contract, evidence: contract.evidence.map((e) => ({ ...e, artifactRefs: ['unrelated'] })) };
      if (kind === 'missing-gate') proof.contract = { ...contract, evidence: contract.evidence.filter((e) => e.kind !== 'objective'),
        decision: { ...contract.decision, evidenceIds: contract.decision.evidenceIds.filter((id) => id !== `${proof.experiment.batteryId}:objective`) } };
      expect(await recordTransferOutcome(sql, proposal(admitted.lesson, kind === 'absent' ? undefined : proof))).toMatchObject({
        tier: 'probationary', status: 'error', testCount: 1, passCount: 0, failCount: 0 });
    });

  it('does not reuse an accepted battery to increment the pass counter again', async () => {
    const admitted = await admitTransferLesson(sql, { workspaceId: WS, signature: 'guard-repeated', lessonText: 'Controlled',
      sourceRef: '/controlled/transcript', potSlug: 'test-pot' });
    if (!admitted.admitted) throw new Error('fixture admission failed');
    const q = proposal(admitted.lesson, evaluated(admitted.lesson));
    expect(await recordTransferOutcome(sql, q)).toMatchObject({ passCount: 1, status: 'passed' });
    expect(await recordTransferOutcome(sql, q)).toMatchObject({ passCount: 1, status: 'error' });
    const receipt = (await readProducerObservations(sql, { producer: 'transfer', workspaceId: WS, limit: 100 }))
      .find((row) => row.sourceRef === `transfer:${admitted.lesson.id}`);
    expect(receipt).toMatchObject({ contract: null, promotionAllowed: false, sourceCurrent: true });
    expect(receipt?.decisions?.map((decision) => decision.contract)).toEqual([q.evaluation?.contract]);
  });
});

describe('links', () => {
  it('memory + pack-candidate links round-trip (and memory clears on retire)', async () => {
    const f = await admitTransferLesson(sql, { workspaceId: WS, signature: 'sig-f', lessonText: 'F' });
    expect(f.admitted).toBe(true);
    if (!f.admitted) return;
    const memoryId = '00000000-0000-4000-8000-000000000001';
    const candidateId = '00000000-0000-4000-8000-000000000002';
    await setLessonMemoryId(sql, { workspaceId: WS, id: f.lesson.id, memoryId });
    await setLessonPackCandidate(sql, { workspaceId: WS, id: f.lesson.id, packCandidateId: candidateId });
    let row = await getTransferLesson(sql, { workspaceId: WS, id: f.lesson.id });
    expect(row).toMatchObject({ memoryId, packCandidateId: candidateId });
    await setLessonMemoryId(sql, { workspaceId: WS, id: f.lesson.id, memoryId: null });
    row = await getTransferLesson(sql, { workspaceId: WS, id: f.lesson.id });
    expect(row?.memoryId).toBeNull();
  });
});
