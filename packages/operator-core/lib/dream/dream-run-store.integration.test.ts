/**
 * Migration 862 + dream-run/store/spend integration against real migrated PG.
 * Resolves the real migration in either parked or armed form so the same test
 * protects authoring, arming, and post-apply states.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { teardownTestPg } from '@papercusp/test-config/pg';
import type { OrgTestDb } from '../../test/_org-test-db';
import {
  dreamRegistrationInput,
  recordDreamRunSpend,
  admitDreamRunCall,
  sumDreamSpendSince,
  type DreamGovernorDeps,
} from './dream-governor';
import {
  beginDreamRun,
  finalizeDreamRun,
  getDreamRun,
  listDreamRuns,
  recordDreamRunSelection,
} from './dream-run-store';
import type { DreamFragmentPair } from './fragment-sampler';
import { registerLearningLoop } from '../learning-governor/store';
import { rm } from 'node:fs/promises';
import { createDreamCapabilityFixture } from '../../test/dream-capability-fixture';
import { beginDreamRunCall, settleDreamRunCall, recordDreamRunReview } from './dream-run-store';
import { dreamCapabilityRun, dreamCallTotals } from './dream-run-provenance';
import { runDreamCycle, type DreamCycleDeps } from './dream-cycle';
import { buildCapabilityReviewSources } from './capability-review-sources';
import { readDreamDetail } from './dream-read';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARMED = path.resolve(HERE, '../../../../libs/papercusp/libs/db/sql/862-dream-runs-ledger.sql');
const MIGRATION_PATH = existsSync(ARMED) ? ARMED : `${ARMED}.DRAFT`;
if (!existsSync(MIGRATION_PATH)) throw new Error(`migration 862 not found at ${ARMED}[.DRAFT]`);
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, 'utf8');

const { createOrgTestDb } = await import('../../test/_org-test-db');

const WS = 'ws-dream-run-store';
const POT = 'papercusp';
const DATABASE_ENV_KEYS = ['HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL', 'DATABASE_URL'] as const;
const savedDatabaseEnv = Object.fromEntries(DATABASE_ENV_KEYS.map(key => [key, process.env[key]]));
const PAIR: DreamFragmentPair = {
  anchor: {
    id: 'recent-observation',
    kind: 'observation',
    ref: 'observation:EI-1',
    text: 'A repeated recovery wake was observed.',
    createdAt: '2026-08-20T12:00:00.000Z',
    harness: POT,
  },
  partner: {
    id: 'remote-memory',
    kind: 'memory',
    ref: 'memory:watermark',
    text: 'A completion watermark suppressed an older replay.',
    createdAt: '2026-07-01T12:00:00.000Z',
    harness: POT,
  },
  pairing: 'banded',
  similarity: 0.61,
};

describe('migration 862 + dream run accounting (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    // The canonical plan and Scout readers resolve their own db-org pools.
    // Pin them to the same disposable database as the injected Dream readers.
    process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
    process.env.HARNESS_DATABASE_URL = db.appDsn;
    process.env.DATABASE_URL = db.adminDsn;
    const { _resetForTests } = await import('@papercusp/db-org');
    await _resetForTests();
    // Before arming, the normal fixture deliberately ignores *.DRAFT. After
    // arming, this is an idempotency replay over the already-migrated template.
    await db.adminSql.unsafe(MIGRATION_SQL);
  }, 180_000);

  afterAll(async () => {
    try {
      const { _resetForTests } = await import('@papercusp/db-org');
      await _resetForTests();
    } finally {
      for (const key of DATABASE_ENV_KEYS) {
        if (savedDatabaseEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedDatabaseEnv[key];
      }
      await db?.cleanup();
      if (!process.env.KEEP_TEST_PG) await teardownTestPg();
    }
  });

  it('DREAM-REVIEW-PREFLIGHT: persists a no-spend refusal through real source readers, phase ledger and detail projection', async () => {
    const workspaceId = WS + '-preflight';
    const f = await createDreamCapabilityFixture(workspaceId, POT);
    const sql = db.adminSql;
    try {
      const llmCall = vi.fn<DreamCycleDeps['llmCall']>(async () => { throw new Error('Must not pay for generation'); });
      const sink = vi.fn<DreamCycleDeps['sink']>(async () => { throw new Error('Must not route an unreviewed proposal'); });
      const rerank = vi.fn<NonNullable<DreamCycleDeps['rerank']>>(async (_query, priors) => ({ priors, outcome: { attempted: false, reason: 'Scorer offline' } }));
      const result = await runDreamCycle({ ...f.scope, rootPath: f.root, manifest: f.manifest, mode: 'manual', cycleId: 'preflight-pg', cycle: { maxDreamsPerCycle: 3 }, pass: { model: 'generator' }, review: { model: 'reviewer' } }, {
        llmCall, sink,
        preflight: async () => ({ allow: true, loopId: 'test', cycleRemainingUsd: 1, rollingSpentUsd: 0, rollingRemainingUsd: 5, rollingLoopCount: 0 }),
        loadPackets: async () => f.packets,
        loadHistory: () => listDreamRuns(sql, { workspaceId, potSlug: POT }),
        sample: () => f.sampling,
        reviewSources: packets => buildCapabilityReviewSources({ sql, scope: f.scope, rootPath: f.root, manifest: f.manifest, packets }),
        beginRun: input => beginDreamRun(sql, { ...input, workspaceId, potSlug: POT, mode: 'manual' }),
        recordSelection: input => recordDreamRunSelection(sql, { ...input, workspaceId }),
        beginCall: input => beginDreamRunCall(sql, { ...input, workspaceId }),
        settleCall: input => settleDreamRunCall(sql, { ...input, workspaceId }),
        recordReview: input => recordDreamRunReview(sql, { ...input, workspaceId }),
        finalizeRun: input => finalizeDreamRun(sql, { ...input, workspaceId }),
        recordSpend: run => recordDreamRunSpend(sql, { workspaceId, potSlug: POT, runId: run.runId }),
        rerank,
      });
      expect(result).toMatchObject({ reason: 'review-unavailable', attempts: 1, accepted: 0, costUsd: 0 });
      const detail = await readDreamDetail(sql, { workspaceId, potSlug: POT, runId: result.runs[0]!.runId });
      expect(detail?.run.review, JSON.stringify(detail?.run.review)).toMatchObject({ verdict: 'unverified', reason: 'rerank-unavailable' });
      expect(detail?.run.outcome).toMatchObject({ generationSkipped: true });
      expect(detail?.nextCheck).toMatchObject({ kind: 'dependency', maxSourceQueries: 2 });
      expect(detail?.proposal).toBeNull();
      expect(detail?.provenance!.calls.map(c => c.callId)).toContain('rerank:preflight');
      expect(detail?.provenance!.calls.every(c => c.reservedUsd === 0 && c.status === 'settled')).toBe(true);
      expect(rerank).toHaveBeenCalledOnce();
      expect(llmCall).not.toHaveBeenCalled(); expect(sink).not.toHaveBeenCalled();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('applies idempotently and keeps the declared mode/status checks armed', async () => {
    await expect(db.adminSql.unsafe(MIGRATION_SQL)).resolves.toBeDefined();
    await expect(
      db.adminSql`
        INSERT INTO harness_shared.dream_runs (workspace_id, run_id, cycle_id, pot_slug, mode)
        VALUES (${WS}, 'invalid-mode', 'cycle-invalid', ${POT}, 'background')`,
    ).rejects.toThrow(/dream_runs_mode_check/);
    await expect(
      db.adminSql`
        INSERT INTO harness_shared.dream_runs (workspace_id, run_id, cycle_id, pot_slug, mode, status)
        VALUES (${WS}, 'invalid-status', 'cycle-invalid', ${POT}, 'manual', 'forgotten')`,
    ).rejects.toThrow(/dream_runs_status_check/);
  });

  it('persists the frozen evaluation pin and refuses a different pin on the same attempt identity', async () => {
    const pilotWorkspace = WS + '-pilot';
    const fixture = await createDreamCapabilityFixture(pilotWorkspace, POT);
    try {
      const evaluation = { protocolPin: 'a'.repeat(64), arm: 'structured-pair' as const };
      const input = {
        workspaceId: pilotWorkspace,
        potSlug: POT,
        mode: 'manual' as const,
        runId: 'protocol-pg:dream:1',
        cycleId: 'protocol-pg',
        capability: { ...fixture.header, evaluation },
      };
      await beginDreamRun(db.adminSql, input);
      const stored = await getDreamRun(db.adminSql, { workspaceId: pilotWorkspace, runId: input.runId });
      expect(dreamCapabilityRun(stored!)?.evaluation).toEqual(evaluation);
      await expect(beginDreamRun(db.adminSql, input)).resolves.toMatchObject({ created: false });
      await expect(
        beginDreamRun(db.adminSql, {
          ...input,
          capability: { ...input.capability, evaluation: { ...evaluation, protocolPin: 'b'.repeat(64) } },
        }),
      ).rejects.toThrow();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('persists selection/finalization and makes replayed spend accounting exactly once', async () => {
    await registerLearningLoop(db.adminSql, dreamRegistrationInput({ workspaceId: WS, potSlug: POT }));

    const begun = await beginDreamRun(db.adminSql, {
      workspaceId: WS,
      runId: 'cycle-pg:dream:1',
      cycleId: 'cycle-pg',
      potSlug: POT,
      mode: 'manual',
    });
    expect(begun.created).toBe(true);
    expect(begun.run.status).toBe('running');

    await recordDreamRunSelection(db.adminSql, {
      workspaceId: WS,
      runId: begun.run.runId,
      pair: PAIR,
      dreamerModel: 'claude-haiku-4-5',
    });
    const finalized = await finalizeDreamRun(db.adminSql, {
      workspaceId: WS,
      runId: begun.run.runId,
      status: 'accepted',
      dreamUsage: { model: 'claude-haiku-4-5', costUsd: 0.01, inputTokens: 100, outputTokens: 20 },
      reviewUsage: { model: 'claude-opus-5', costUsd: 0.02, inputTokens: 200, outputTokens: 30 },
      outcome: { verdict: 'insight' },
      review: { verdict: 'accept' },
      routedRef: 'wi:WI-DREAM-PG',
    });
    expect(finalized).toMatchObject({
      status: 'accepted',
      fragmentRefs: [PAIR.anchor.ref, PAIR.partner.ref],
      fragmentKinds: ['observation', 'memory'],
      dreamerModel: 'claude-haiku-4-5',
      reviewerModel: 'claude-opus-5',
      inputTokens: 300,
      outputTokens: 50,
      costUsd: 0.03,
      routedRef: 'wi:WI-DREAM-PG',
    });

    await expect(
      finalizeDreamRun(db.adminSql, {
        workspaceId: WS,
        runId: begun.run.runId,
        status: 'error',
        error: 'replay must not replace accepted',
      }),
    ).resolves.toMatchObject({ status: 'accepted', costUsd: 0.03, routedRef: 'wi:WI-DREAM-PG' });

    await expect(
      recordDreamRunSpend(db.adminSql, { workspaceId: WS, runId: begun.run.runId, potSlug: POT }),
    ).resolves.toEqual({
      recorded: true,
      costUsd: 0.03,
    });
    await expect(
      recordDreamRunSpend(db.adminSql, { workspaceId: WS, runId: begun.run.runId, potSlug: POT }),
    ).resolves.toEqual({
      recorded: false,
      costUsd: 0.03,
      reason: 'already-recorded',
    });

    const [eventCount] = await db.adminSql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
        FROM harness_shared.learning_spend_events
       WHERE workspace_id = ${WS} AND loop_id = 'dream:papercusp' AND run_ref = ${begun.run.runId}`;
    const [registration] = await db.adminSql<{ spent_usd: number }[]>`
      SELECT spent_usd
        FROM harness_shared.learning_governor_loops
       WHERE workspace_id = ${WS} AND loop_id = 'dream:papercusp'`;
    expect(eventCount?.count).toBe(1);
    expect(Number(registration?.spent_usd)).toBeCloseTo(0.03);

    await expect(getDreamRun(db.adminSql, { workspaceId: WS, runId: begun.run.runId })).resolves.toMatchObject({
      status: 'accepted',
      spendRecordedAt: expect.any(String),
    });
    await expect(listDreamRuns(db.adminSql, { workspaceId: WS, potSlug: POT })).resolves.toHaveLength(1);
  });

  it('refuses stable run-id reuse with different provenance', async () => {
    await expect(
      beginDreamRun(db.adminSql, {
        workspaceId: WS,
        runId: 'cycle-pg:dream:1',
        cycleId: 'different-cycle',
        potSlug: POT,
        mode: 'manual',
      }),
    ).rejects.toThrow('reused with different provenance');
  });

  it('stores old/new rows together and reconciles every governed phase without double-counting aggregates', async () => {
    const f = await createDreamCapabilityFixture(WS, POT);
    try {
      const key = { workspaceId: WS, runId: 'capability-accounting' };
      await beginDreamRun(db.adminSql, {
        ...key,
        cycleId: 'cap-cycle',
        potSlug: POT,
        mode: 'manual',
        capability: f.header,
      });
      await recordDreamRunSelection(db.adminSql, { ...key, capability: f.sampling });
      for (const call of f.provenance.calls) {
        const input = {
          ...key,
          call: { callId: call.callId, phase: call.phase, model: call.model, reservedUsd: call.reservedUsd },
        };
        const admissions = await Promise.all([
          beginDreamRunCall(db.adminSql, input),
          beginDreamRunCall(db.adminSql, input),
        ]);
        expect(admissions.filter((r) => r.started)).toHaveLength(1);
        await settleDreamRunCall(db.adminSql, { ...key, callId: call.callId, usage: call.usage });
        await settleDreamRunCall(db.adminSql, { ...key, callId: call.callId, usage: call.usage });
      }
      for (const phase of ['packet', 'retrieval', 'rerank'] as const) {
        await beginDreamRunCall(db.adminSql, {
          ...key,
          call: { callId: phase, phase, model: 'source-service', reservedUsd: 0.02 },
        });
        await settleDreamRunCall(db.adminSql, {
          ...key,
          callId: phase,
          usage: { model: 'source-service', costUsd: 0.005, inputTokens: 20, outputTokens: 0 },
        });
      }
      await expect(
        finalizeDreamRun(db.adminSql, {
          ...key,
          status: 'rejected',
          dreamUsage: { model: 'dreamer', costUsd: 999, inputTokens: 100, outputTokens: 10 },
        }),
      ).rejects.toThrow('does not reconcile');
      const result = await finalizeDreamRun(db.adminSql, {
        ...key,
        status: 'rejected',
        outcome: { verdict: 'insight', insight: f.insight },
        review: { ...f.review, verdict: 'reject', reason: 'counterexample' },
        dreamUsage: f.provenance.calls[0]!.usage,
        reviewUsage: f.review.usage,
      });
      expect(result.costUsd).toBeCloseTo(0.085);
      expect(result.inputTokens).toBe(460);
      expect(result.outputTokens).toBe(40);
      expect(dreamCapabilityRun(result)?.sampling).toEqual(f.sampling);
      expect(dreamCapabilityRun(result)?.calls).toHaveLength(7);
      expect(dreamCallTotals(dreamCapabilityRun(result)!.calls).costBasis).toBe('actual');
      const replay = await finalizeDreamRun(db.adminSql, { ...key, status: 'error', outcome: { replaced: true } });
      expect(replay).toEqual(result);
      expect(
        dreamCapabilityRun((await getDreamRun(db.adminSql, { workspaceId: WS, runId: 'cycle-pg:dream:1' }))!),
      ).toBeNull();
      expect((await listDreamRuns(db.adminSql, { workspaceId: WS, potSlug: POT })).map((r) => r.runId)).toContain(
        key.runId,
      );
      await expect(
        recordDreamRunSelection(db.adminSql, {
          ...key,
          capability: { ...f.sampling, log: { ...f.sampling.log, seed: 'changed' } },
        }),
      ).rejects.toThrow('already frozen');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('reserves an interrupted call exactly once and keeps unknown spend visible after terminal replay', async () => {
    const f = await createDreamCapabilityFixture(WS, POT);
    try {
      const key = { workspaceId: WS, runId: 'capability-crashed-call' };
      await beginDreamRun(db.adminSql, {
        ...key,
        cycleId: 'crash-cycle',
        potSlug: POT,
        mode: 'manual',
        capability: f.header,
      });
      const admission = {
        ...key,
        call: { callId: 'generation', phase: 'generation' as const, model: 'dreamer', reservedUsd: 0.3 },
      };
      expect((await beginDreamRunCall(db.adminSql, admission)).started).toBe(true);
      expect((await beginDreamRunCall(db.adminSql, admission)).started).toBe(false);
      await expect(
        beginDreamRunCall(db.adminSql, { ...admission, call: { ...admission.call, reservedUsd: 0.4 } }),
      ).rejects.toThrow('different admission');
      const result = await finalizeDreamRun(db.adminSql, {
        ...key,
        status: 'error',
        error: 'Process died before provider usage returned.',
      });
      expect(result.costUsd).toBe(0.3);
      expect(dreamCallTotals(dreamCapabilityRun(result)!.calls)).toMatchObject({
        costBasis: 'conservative-bound',
        unknownCallIds: ['generation'],
      });
      expect((await beginDreamRunCall(db.adminSql, admission)).started).toBe(false);
      await expect(
        settleDreamRunCall(db.adminSql, {
          ...key,
          callId: 'generation',
          usage: { model: 'dreamer', costUsd: 0.1, inputTokens: 20, outputTokens: 10 },
        }),
      ).rejects.toThrow('terminal');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('bounds legacy tiered zero settlements before and after spend recording without changing history', async () => {
    const workspaceId = 'ws-dream-legacy-tiered-cost';
    const fixture = await createDreamCapabilityFixture(workspaceId, POT);
    const key = { workspaceId, runId: 'legacy-tiered:dream:1' };
    try {
      await registerLearningLoop(db.adminSql, dreamRegistrationInput({ workspaceId, potSlug: POT }));
      await beginDreamRun(db.adminSql, { ...key, potSlug: POT, cycleId: 'legacy-tiered', mode: 'manual',
        capability: { ...fixture.header, dreamerModel: 'gpt-6.1-sol', reviewerModel: 'gpt-6.1-sol' } });
      await beginDreamRunCall(db.adminSql, { ...key, call: { callId: 'generation', phase: 'generation',
        model: 'gpt-6.1-sol', reservedUsd: 0.1 } });
      await settleDreamRunCall(db.adminSql, { ...key, callId: 'generation',
        usage: { model: 'gpt-6.1-sol', costUsd: 0, inputTokens: 6670, outputTokens: 446 } });
      await finalizeDreamRun(db.adminSql, { ...key, status: 'abstained' });
      const window = { workspaceId, sinceMs: Date.now() - 86400000 };
      const before = await sumDreamSpendSince(db.adminSql, window);
      expect(before.totalUsd).toBeGreaterThan(0);
      expect(before.totalUsd).toBeLessThanOrEqual(0.1);
      expect(before.loopCount).toBe(1);
      await recordDreamRunSpend(db.adminSql, { ...key, potSlug: POT });
      expect(await sumDreamSpendSince(db.adminSql, window)).toEqual(before);
      const stored = await getDreamRun(db.adminSql, key);
      expect(stored?.costUsd).toBe(0);
      expect(dreamCapabilityRun(stored!)?.calls[0]?.usage?.costUsd).toBe(0);
      await db.adminSql`UPDATE harness_shared.dream_runs SET completed_at = now() - interval '25 hours'
        WHERE workspace_id = ${workspaceId} AND run_id = ${key.runId}`;
      expect((await sumDreamSpendSince(db.adminSql, window)).totalUsd).toBe(0);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  it.each([1, 10])(
    'AUTO-REQ-M-002-P-005-admission: concurrent pots share a $%s rolling cap and settlement never double counts',
    async (cap) => {
      const workspaceId = 'ws-dream-concurrent-cap-' + cap;
      const fixture = await createDreamCapabilityFixture(workspaceId, POT);
      try {
        const deps: DreamGovernorDeps = {
          enabled: async () => true,
          register: registerLearningLoop,
          check: async () => ({ allow: true, remainingUsd: cap }),
          sumSince: sumDreamSpendSince,
          now: Date.now,
        };
        const make = async (potSlug: string) => {
          const runId = 'cycle-' + potSlug + ':dream:1';
          await beginDreamRun(db.adminSql, {
            workspaceId,
            potSlug,
            runId,
            cycleId: 'cycle-' + potSlug,
            mode: 'manual',
            capability: fixture.header,
          });
          return {
            workspaceId,
            potSlug,
            runId,
            config: { maxCostUsd: cap, rolling24hCostUsd: cap },
            call: { callId: 'generation', phase: 'generation' as const, model: 'dreamer', reservedUsd: 0.6 * cap },
          };
        };
        const inputs = await Promise.all([make('pot-a'), make('pot-b')]);
        const attempts = await Promise.allSettled(inputs.map((i) => admitDreamRunCall(db.adminSql, i, deps)));
        expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
        const loser = attempts.find((a) => a.status === 'rejected');
        expect(loser).toMatchObject({ status: 'rejected', reason: { reason: 'rolling-cost-cap' } });
        const winnerIndex = attempts.findIndex((a) => a.status === 'fulfilled');
        const winner = inputs[winnerIndex]!,
          second = inputs[1 - winnerIndex]!;
        expect(await sumDreamSpendSince(db.adminSql, { workspaceId, sinceMs: Date.now() - 86400000 })).toMatchObject({
          totalUsd: 0.6 * cap,
        });
        expect(await admitDreamRunCall(db.adminSql, winner, deps)).toMatchObject({ started: false });
        await settleDreamRunCall(db.adminSql, {
          workspaceId,
          runId: winner.runId,
          callId: 'generation',
          usage: { model: 'dreamer', costUsd: 0.2 * cap, inputTokens: 100, outputTokens: 10 },
        });
        await admitDreamRunCall(db.adminSql, second, deps);
        await finalizeDreamRun(db.adminSql, { workspaceId, runId: winner.runId, status: 'abstained' });
        expect(await sumDreamSpendSince(db.adminSql, { workspaceId, sinceMs: Date.now() - 86400000 })).toMatchObject({
          totalUsd: 0.8 * cap,
        });
        await expect(recordDreamRunSpend(db.adminSql, { ...winner, potSlug: 'wrong-pot' })).rejects.toThrow('scope');
        await recordDreamRunSpend(db.adminSql, winner);
        expect(await sumDreamSpendSince(db.adminSql, { workspaceId, sinceMs: Date.now() - 86400000 })).toMatchObject({
          totalUsd: 0.8 * cap,
        });
        expect(await recordDreamRunSpend(db.adminSql, winner)).toMatchObject({ recorded: false });
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it.each([1, 10])(
    'bounds two simultaneous phases by the same $%s cycle cap and rejects foreign admission',
    async (cap) => {
      const workspaceId = 'ws-dream-cycle-cap-' + cap;
      const fixture = await createDreamCapabilityFixture(workspaceId, POT);
      try {
        const runId = 'cycle-reserve:dream:1';
        await beginDreamRun(db.adminSql, {
          workspaceId,
          potSlug: POT,
          runId,
          cycleId: 'cycle-reserve',
          mode: 'manual',
          capability: fixture.header,
        });
        const deps: DreamGovernorDeps = {
          enabled: async () => true,
          register: registerLearningLoop,
          check: async () => ({ allow: true, remainingUsd: cap }),
          sumSince: sumDreamSpendSince,
          now: Date.now,
        };
        const calls = (['control-a', 'control-b'] as const).map((phase) => ({
          workspaceId,
          potSlug: POT,
          runId,
          config: { maxCostUsd: cap, rolling24hCostUsd: 5 * cap },
          call: { callId: phase, phase, model: 'reviewer', reservedUsd: 0.6 * cap },
        }));
        const results = await Promise.allSettled(calls.map((i) => admitDreamRunCall(db.adminSql, i, deps)));
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { reason: 'cycle-cost-cap' } });
        await expect(admitDreamRunCall(db.adminSql, { ...calls[0]!, potSlug: 'foreign' }, deps)).rejects.toThrow(
          'scope',
        );
        expect((await getDreamRun(db.adminSql, { workspaceId, runId }))?.costUsd).toBeCloseTo(0.6 * cap);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it('retains invalid-review diagnostics through freeze and terminal readback without accepting them', async () => {
    const f = await createDreamCapabilityFixture(WS, POT);
    try {
      const key = { workspaceId: WS, runId: 'capability-invalid-review-diagnostics' };
      await beginDreamRun(db.adminSql, {
        ...key,
        cycleId: 'diagnostic-cycle',
        potSlug: POT,
        mode: 'manual',
        capability: f.header,
      });
      await recordDreamRunSelection(db.adminSql, { ...key, capability: f.sampling });
      for (const call of f.provenance.calls) {
        await beginDreamRunCall(db.adminSql, {
          ...key,
          call: { callId: call.callId, phase: call.phase, model: call.model, reservedUsd: call.reservedUsd },
        });
        await settleDreamRunCall(db.adminSql, { ...key, callId: call.callId, usage: call.usage });
      }
      const failures = {
        review: {
          stage: 'grounding',
          message: 'Skeptical review cites missing or unsupported evidence.',
          response: { preview: '{"verdict":"accept"}', chars: 20, sha256: 'a'.repeat(64), truncated: false },
          invalidEvidence: {
            total: 1,
            entries: [
              { path: 'feasibility.evidence[0]', ref: 'B:missing', quote: 'unsupported', reason: 'missing-ref' },
            ],
          },
        },
      };
      const review = { ...f.review, verdict: 'unverified', reason: 'review-unavailable', judgment: null, failures };
      const outcome = { verdict: 'insight', insight: f.insight };
      await recordDreamRunReview(db.adminSql, { ...key, outcome, review });
      expect((await getDreamRun(db.adminSql, key))!.review).toEqual(review);
      await expect(finalizeDreamRun(db.adminSql, { ...key, status: 'accepted' })).rejects.toThrow();
      await finalizeDreamRun(db.adminSql, { ...key, status: 'rejected', outcome, review });
      const saved = await getDreamRun(db.adminSql, key);
      expect(saved).toMatchObject({ status: 'rejected', review: { verdict: 'unverified', judgment: null, failures } });
      await expect(
        recordDreamRunReview(db.adminSql, { ...key, outcome, review: { ...review, failures: {} } }),
      ).rejects.toThrow('already frozen');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('freezes the reviewed candidate before the sink and refuses accepted finalization without routing', async () => {
    const f = await createDreamCapabilityFixture(WS, POT);
    try {
      const key = { workspaceId: WS, runId: 'capability-frozen-review' };
      await beginDreamRun(db.adminSql, {
        ...key,
        cycleId: 'freeze-cycle',
        potSlug: POT,
        mode: 'manual',
        capability: f.header,
      });
      await recordDreamRunSelection(db.adminSql, { ...key, capability: f.sampling });
      const review = { ...key, outcome: { verdict: 'insight', insight: f.insight }, review: { ...f.review } };
      await expect(recordDreamRunReview(db.adminSql, review)).rejects.toThrow('usage does not reconcile');
      for (const call of f.provenance.calls) {
        await beginDreamRunCall(db.adminSql, {
          ...key,
          call: { callId: call.callId, phase: call.phase, model: call.model, reservedUsd: call.reservedUsd },
        });
        await settleDreamRunCall(db.adminSql, { ...key, callId: call.callId, usage: call.usage });
      }
      const first = await recordDreamRunReview(db.adminSql, review);
      expect(await recordDreamRunReview(db.adminSql, review)).toEqual(first);
      await expect(
        recordDreamRunReview(db.adminSql, { ...review, review: { ...f.review, note: 'changed' } }),
      ).rejects.toThrow('already frozen');
      await expect(finalizeDreamRun(db.adminSql, { ...key, status: 'accepted' })).rejects.toThrow('reviewed and sunk');
      await expect(
        beginDreamRunCall(db.adminSql, {
          ...key,
          call: { callId: 'late', phase: 'review', model: 'reviewer', reservedUsd: 0.1 },
        }),
      ).rejects.toThrow('after review');
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
