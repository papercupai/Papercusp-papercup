/** Real replay cells and governor reservations on a private, migrated PG. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
import { registerReplayLoop, runGovernedReplay } from './governed';
import { REPLAY_BASELINE_VARIANT } from './battery';
import { REPLAY_LOOP_ID, type ReplayRunner } from './types';
import { getLearningLoop, listLearningSpendEvents, listLearningSpendReservations } from '../learning-governor/store';
import { LEARNING_GOVERNOR_BUDGET_FLOOR_USD } from '../learning-governor/core';
import { transferReplayPort } from '../transfer/replay-adapter';
import { admitTransferLesson, recordTransferOutcome, setLessonMemoryId } from '../transfer/store';
import { applyTransferVerdict } from '../transfer/gate';
import { readProducerObservations } from '../experiment/producer-lifecycle-store';

let db: OrgTestDb;
beforeAll(async () => {
  db = await createOrgTestDb();
  const columns = await db.adminSql`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'harness_shared'
       AND table_name IN ('learning_spend_reservations', 'learning_spend_events', 'replay_runs')`;
  const names = new Set(columns.map((row) => `${row.table_name}.${row.column_name}`));
  for (const column of ['learning_spend_reservations.reserved_usd', 'learning_spend_reservations.settled_at',
    'learning_spend_events.reservation_id', 'replay_runs.status']) expect(names.has(column)).toBe(true);
}, 240_000);
afterAll(async () => { await db?.cleanup(); });

const config = (batteryId: string) => ({ batteryId, variants: [REPLAY_BASELINE_VARIANT],
  cases: [{ kind: 'synthetic' as const, caseId: 'task', context: 'existing task', intent: 'complete the task' }], repeats: 1 });
const judge = async () => ({ text: JSON.stringify({ d1: 7, d2: 7, d3: 7, rationale: 'fixture verdict' }),
  costUsd: 0.01, inputTokens: 1, outputTokens: 1 });
const run: ReplayRunner = async () => ({ outputText: 'completed task', costUsd: 0.05,
  inputTokens: 1, outputTokens: 1, replayed: true });
const glue = () => ({ enabled: async () => true, getSql: async () => db.adminSql,
  preflight: async () => ({ allow: true, remainingUsd: 1 }), log: (message: string) => { throw new Error(message); } });

describe('governed replay durable spend boundary', () => {
  it('carries the actual settled reservation and scored cell identities through the production transfer adapter', async () => {
    const workspaceId = `ws-transfer-${randomUUID()}`;
    await registerReplayLoop(db.adminSql, { workspaceId, budgetUsd: 1 });
    const admitted = await admitTransferLesson(db.adminSql, { workspaceId, signature: 'provenance',
      lessonText: 'verify the result', sourceRef: 'fixture:transfer-source', potSlug: 'test-transfer' });
    if (!admitted.admitted) throw new Error('fixture admission failed');
    const port = transferReplayPort({ workspaceId,
      runner: async (input) => ({ ...await run(input), execution: { model: 'fixture-student', codeHash: 'fixture-runner' } }),
      llmCall: async (input) => {
        const score = input.messages[0].content.includes('variant: with lesson') ? 8 : 6;
        return { ...await judge(), text: JSON.stringify({ d1: score, d2: score, d3: score, rationale: 'fixture verdict' }) };
      }, runGoverned: (q, deps) => runGovernedReplay(q, deps, glue()),
    });
    const outcome = await port({ lesson: admitted.lesson, transcript: { ref: 'fixture:transfer-source',
      turns: [{ index: 0, role: 'user', text: 'complete the task' }, { index: 1, role: 'assistant', text: 'historical continuation' }] } });
    const reservations = await listLearningSpendReservations(db.adminSql, { workspaceId });
    expect(reservations).toHaveLength(1);
    expect(outcome.evaluation!.reservation).toEqual(reservations[0]);
    expect(outcome.evaluation!.reservation).toMatchObject({ status: 'settled', potSlug: 'test-transfer', runRef: outcome.batteryId });
    expect(outcome.evaluation!.reservation!.usedUsd).toBeCloseTo(outcome.costUsd);
    expect(outcome.costUsd).toBeCloseTo(0.12);
    const cells = await db.adminSql`SELECT run_id AS id, status FROM harness_shared.replay_runs WHERE workspace_id = ${workspaceId} ORDER BY run_id`;
    expect(outcome.evaluation!.outcomes.map((cell) => ({ id: cell.runId, status: cell.status })).sort((a, b) => a.id.localeCompare(b.id))).toEqual(cells);
    expect(outcome.evaluation!.experiment.modelHash).toMatch(/^[a-f0-9]{64}$/);
    expect(outcome.evaluation!.experiment.codeHash).toBeNull();
    expect(outcome.evaluation!.costMeasured).toBe(true);
    const contract = outcome.evaluation!.contract!;
    expect(contract).toMatchObject({ candidate: { id: admitted.lesson.id,
      actor: { kind: 'system', id: 'frontier:transfer-harness' },
      potScope: { workspaceId, potId: 'test-transfer' } },
      experiment: { codeHash: null }, decision: { verdict: 'inconclusive' },
      spend: { usedUsd: reservations[0].usedUsd, unsettledUsd: 0 } });
    expect(contract.activation).toBeUndefined();
    expect(contract.evidence.find((item) => item.kind === 'judgment')).toMatchObject({ status: 'pass', coverage: { required: 1, measured: 1 } });
    expect(contract.evidence.filter((item) => item.status === 'not-measured').map((item) => item.kind))
      .toEqual(['objective', 'regression', 'probe', 'rollback']);
    expect(contract.evidence.find((item) => item.kind === 'cost')?.artifactRefs)
      .toEqual([`learning-reservation:${reservations[0].id}`]);
    expect(await listLearningSpendEvents(db.adminSql, { workspaceId })).toHaveLength(1);
    await recordTransferOutcome(db.adminSql, { workspaceId, id: admitted.lesson.id, batteryId: outcome.batteryId,
      delta: outcome.withComposite - outcome.baselineComposite, transition: applyTransferVerdict(admitted.lesson, 'passed'),
      evaluation: outcome.evaluation });
    const receipt = (await readProducerObservations(db.adminSql, { producer: 'transfer', workspaceId }))[0];
    expect(receipt).toMatchObject({ evaluationCurrent: true, sourceCurrent: true, contract: null, promotionAllowed: false,
      source: { tier: 'probationary', status: 'error', pass_count: 0 } });
    expect(receipt.evaluation).toEqual(outcome.evaluation);
    await setLessonMemoryId(db.adminSql, { workspaceId, id: admitted.lesson.id, memoryId: randomUUID() });
    const linked = (await readProducerObservations(db.adminSql, { producer: 'transfer', workspaceId }))[0];
    expect(linked).toMatchObject({ evaluationCurrent: false, sourceCurrent: true, contract: null, promotionAllowed: false });
    expect(linked.evaluation).toEqual(outcome.evaluation);
  });

  it('records a reservation before actual replay execution and charges the battery once', async () => {
    const workspaceId = `ws-replay-${randomUUID()}`;
    await registerReplayLoop(db.adminSql, { workspaceId, budgetUsd: 1 });
    const batteryId = 'replay-reserve-first';
    const runner: ReplayRunner = async (input) => {
      const rows = await listLearningSpendReservations(db.adminSql, { workspaceId, loopId: REPLAY_LOOP_ID });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'open', attemptKind: 'evaluation', runRef: batteryId, usedUsd: 0 });
      expect(await listLearningSpendEvents(db.adminSql, { workspaceId })).toHaveLength(0);
      return run(input);
    };
    const out = await runGovernedReplay({ workspaceId, config: config(batteryId) },
      { runner, llmCall: judge, now: () => Date.now() }, glue());
    expect(out.result?.outcomes[0].status).toBe('scored');
    expect(out.reservation).toMatchObject({ status: 'settled', usedUsd: out.result!.totalCostUsd, signalOrigin: 'replay' });
    expect(out.reservation!.usedUsd).toBeCloseTo(0.06);
    expect(out.reservation?.settledAt).toEqual(expect.any(Number));
    const events = await listLearningSpendEvents(db.adminSql, { workspaceId });
    expect(events).toHaveLength(1);
    // The public event projection omits reservation_id; inspect the persisted
    // join rather than asserting a field its mapper does not publish.
    expect(events[0]).toMatchObject({ runRef: batteryId, costUsd: out.result!.totalCostUsd });
    const links = await db.adminSql`SELECT reservation_id FROM harness_shared.learning_spend_events
      WHERE workspace_id = ${workspaceId} AND run_ref = ${batteryId}`;
    expect(links).toEqual([{ reservation_id: out.reservation!.id }]);
    expect((await getLearningLoop(db.adminSql, { workspaceId, loopId: REPLAY_LOOP_ID }))?.spentUsd).toBeCloseTo(0.06);
    const cells = await db.adminSql`SELECT status FROM harness_shared.replay_runs WHERE workspace_id = ${workspaceId}`;
    expect(cells).toEqual([{ status: 'scored' }]);
  });

  it('two overlapping batteries reserve within shared headroom despite identical preflight snapshots', async () => {
    const workspaceId = `ws-replay-${randomUUID()}`;
    // Reserve above the real governor floor; each request fits alone and the
    // pair exceeds the available dollar. No guessed floor can deadlock the test.
    await registerReplayLoop(db.adminSql, { workspaceId, budgetUsd: 1 + LEARNING_GOVERNOR_BUDGET_FLOOR_USD });
    let started = 0;
    let bothStarted!: () => void;
    let didNotStart!: (error: Error) => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve, reject) => { bothStarted = resolve; didNotStart = reject; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner: ReplayRunner = async (input) => {
      if (++started === 2) bothStarted();
      await gate;
      return run(input);
    };
    const pending = Promise.all(['a', 'b'].map((batteryId) => runGovernedReplay(
      { workspaceId, config: { ...config(batteryId), maxSpendUsd: 0.8 } },
      { runner, llmCall: judge, now: () => Date.now() }, glue(),
    ).then((out) => {
      if (started < 2) didNotStart(new Error(`overlap fixture did not start both batteries: ${JSON.stringify(out.verdict)}`));
      return out;
    }, (error) => { didNotStart(error); throw error; })));
    // Observe early rejections even while waiting for both execution hooks.
    void pending.catch(() => {});
    try {
      await ready;
      const rows = await listLearningSpendReservations(db.adminSql, { workspaceId, status: 'open' });
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.runRef).sort()).toEqual(['a', 'b']);
      const reservedUsd = rows.reduce((sum, row) => sum + row.reservedUsd, 0);
      expect(reservedUsd).toBeCloseTo(1);
      expect(rows.some((row) => row.reservedUsd < row.requestedUsd)).toBe(true);
      expect(await listLearningSpendEvents(db.adminSql, { workspaceId })).toHaveLength(0);
    } finally { release(); }
    const results = await pending;
    expect(results.every((result) => result.reservation?.status === 'settled')).toBe(true);
    expect(await listLearningSpendEvents(db.adminSql, { workspaceId })).toHaveLength(2);
    expect((await getLearningLoop(db.adminSql, { workspaceId, loopId: REPLAY_LOOP_ID }))?.spentUsd).toBeCloseTo(0.12);
  });

  it('settles known judge charges after every invalid-output repair is exhausted', async () => {
    const workspaceId = `ws-replay-${randomUUID()}`;
    const batteryId = `failed-judge-${randomUUID()}`;
    await registerReplayLoop(db.adminSql, { workspaceId, budgetUsd: 1 });
    const receipts: number[] = [];
    const out = await runGovernedReplay({ workspaceId, config: config(batteryId) }, {
      runner: run,
      llmCall: async () => {
        receipts.push(0.01);
        return { text: 'unscoreable fixture reply', costUsd: 0.01, inputTokens: 2, outputTokens: 3 };
      },
      now: () => Date.now(),
    }, glue());
    expect(receipts).toHaveLength(2);
    expect(out.result?.outcomes[0]).toMatchObject({ status: 'errored' });
    const events = await listLearningSpendEvents(db.adminSql, { workspaceId });
    expect(events).toHaveLength(1);
    const providerUsd = 0.05 + receipts.reduce((sum, cost) => sum + cost, 0);
    expect({
      providerUsd, batteryUsd: out.result?.totalCostUsd,
      reservationUsd: out.reservation?.usedUsd, eventUsd: events[0].costUsd,
    }).toEqual({ providerUsd: 0.07, batteryUsd: 0.07, reservationUsd: 0.07, eventUsd: 0.07 });
    expect((await getLearningLoop(db.adminSql, { workspaceId, loopId: REPLAY_LOOP_ID }))?.spentUsd).toBeCloseTo(providerUsd);
    expect(await db.adminSql`SELECT status FROM harness_shared.replay_runs WHERE workspace_id = ${workspaceId}`)
      .toEqual([{ status: 'errored' }]);
  });

  it('keeps unknown judge charges reserved without emitting a falsely complete charge event', async () => {
    const workspaceId = `ws-replay-${randomUUID()}`;
    await registerReplayLoop(db.adminSql, { workspaceId, budgetUsd: 1 });
    const out = await runGovernedReplay({ workspaceId, config: config('unknown-charge') }, {
      runner: run, llmCall: async () => { throw new Error('unmeasured provider failure'); }, now: () => Date.now(),
    }, glue());
    expect(out.result).toMatchObject({ totalCostUsd: 0.05, costMeasured: false });
    expect(out.reservation).toMatchObject({ status: 'open', usedUsd: 0 });
    expect(await listLearningSpendEvents(db.adminSql, { workspaceId })).toHaveLength(0);
    expect(await listLearningSpendReservations(db.adminSql, { workspaceId, status: 'open' })).toHaveLength(1);
  });

  it('a genuinely free battery still leaves a settled evaluation reservation and no charge event', async () => {
    const workspaceId = `ws-replay-${randomUUID()}`;
    await registerReplayLoop(db.adminSql, { workspaceId, budgetUsd: 1 });
    const out = await runGovernedReplay({ workspaceId, config: config('free') }, {
      runner: async (input) => ({ ...await run(input), costUsd: 0 }),
      llmCall: async () => ({ ...await judge(), costUsd: 0 }), now: () => Date.now(),
    }, glue());
    expect(out.result?.outcomes[0].status).toBe('scored');
    expect(out.reservation).toMatchObject({ status: 'settled', usedUsd: 0 });
    expect(await listLearningSpendReservations(db.adminSql, { workspaceId })).toHaveLength(1);
    expect(await listLearningSpendEvents(db.adminSql, { workspaceId })).toHaveLength(0);
  });
});
