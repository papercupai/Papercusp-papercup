/**
 * store.integration.test.ts — learning-governor SQL over migration 244
 * (self-learning-frontier P-003 / FB-01). Provisions a throwaway DB with the
 * full live schema (provisionGymDatabase applies 000-baseline + every pending
 * migration, so 244's learning_governor_loops / learning_spend_events exist),
 * then round-trips: register/upsert semantics (preserve vs overwrite),
 * recordLearningSpend accumulate modes, governorCheck against live rows
 * (the spend-until-exhausted lifecycle), and the ledger reads.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import postgres from 'postgres';
import { getTestPg, teardownTestPg } from '@papercusp/test-config/pg';
import { provisionGymDatabase } from '../gym/gym-db-init';
import { LEARNING_GOVERNOR_BUDGET_FLOOR_USD, summarizeLearningSpend } from './core';
import {
  deleteLearningLoop,
  getLearningLoop,
  getLearningSpendPositions,
  governorCheck,
  listLearningLoops,
  listLearningSpendEvents,
  listLearningSpendReservations,
  recordLearningSpend,
  recordLearningSpendAttemptResult,
  registerLearningLoop,
  reserveLearningSpend,
  settleLearningSpend,
  sumOpenReservedUsd,
} from './store';
import { setPotLearningScope } from '../learning/pot-gate/store';
import { runGovernedSpendAttempt } from './registrants';
import { llmCall } from '../llm-testing/llm-client';
import { buildLoopDeps } from '../gym/loop-deps';
import { createNativeGymGatewayController, withGymLlmNetworkRetry, type NativeGymProviderAuthorization } from '../gym/proposer';
import type { GatewayCarryTrialAttempt, GatewayCarryTrialAttemptResult } from '../inference-gateway/gateway';
import { processMonotonicClock } from '../process-monotonic-clock';
import { runWithRatePause } from '../gym/rate-pause';
import { LlmCallError } from '@papercusp/testing-shell/llm';
import type { AbDeps } from '../gym/ab-runner';

const failureUsage = vi.hoisted(() => ({ costUsd: 0 as number | undefined }));
const successfulUsage = vi.hoisted(() => ({ value: undefined as { costUsd?: number; unreportedFrames?: number } | undefined }));
vi.mock('../agent-chat-stream', async importOriginal => ({
  ...await importOriginal<typeof import('../agent-chat-stream')>(),
  runAgentChat: async function* () {
    if (successfulUsage.value) {
      yield { type: 'result', finalText: '{"promptOverrides":{"worker":"# worker v2"},"rationale":"r"}',
        tokensIn: 12, tokensOut: 4, ...successfulUsage.value };
      return;
    }
    yield { type: 'error', message: 'tool failed after paid inference', costUsd: failureUsage.costUsd };
  },
}));

let sql: postgres.Sql;
let containerUri: string;
let testDatabaseUri: string;
const dbName = `lgov_${randomBytes(5).toString('hex')}`;
const WS = 'ws-gov-test';

beforeAll(async () => {
  containerUri = await getTestPg();
  const { databaseUri } = await provisionGymDatabase({ maintenanceUri: containerUri, dbName });
  testDatabaseUri = databaseUri;
  sql = postgres(databaseUri, { max: 2, onnotice: () => {}, prepare: false });
  // Exercise the real additive migration while it is unarmed, too. Reapplying
  // after provision verifies idempotence once it ships with the full schema.
  const resourcesMigration = new URL('../../../../libs/papercusp/libs/db/sql/1224-learning-reservation-resources.sql', import.meta.url);
  const resourceSql = readFileSync(existsSync(resourcesMigration) ? resourcesMigration : new URL(`${resourcesMigration.href}.DRAFT`), 'utf8');
  await sql.unsafe(resourceSql);
  await sql.unsafe(resourceSql);
  // Budget is MEASURED, not guessed (2026-09-04): on this box getTestPg() returns
  // in ~1.2s and provisionGymDatabase() takes ~165s, because it re-applies all 934
  // migrations serially into a fresh database on EVERY run. Against the family's
  // customary 180_000 that leaves ~8% headroom, so ordinary fleet load tips the hook
  // over and Vitest cancels — reporting `Hook timed out` with 26 assertions COLLECTED
  // BUT NOT RUN, which reads like a red suite while actually producing no evidence
  // either way. 180_000 also exactly equals TESTCONTAINER_START_LOCK_TIMEOUT_MS, whose
  // contract asks callers to leave headroom so the lock's own diagnostic can surface
  // instead of being cancelled first. The provisioning COST is the real defect and is
  // tracked separately (template-database reuse via the existing getOrBuildTemplate);
  // this budget just stops that cost from silently masquerading as a P-005 failure.
}, 420_000);

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

describe('native gateway controller with the persisted cycle ledger', () => {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const resourceBudget = { inputTokens: 64, outputTokens: 16, requestsPerArm: 2, armIds: ['native'] };
  const fixture = async (attemptKind: 'evaluation' | 'proposer' = 'evaluation', requestedUsd = 0.25) => {
    const loopId = `gym:native-controller:${randomUUID()}`;
    const potSlug = `native-controller-pot:${randomUUID()}`;
    await setPotLearningScope(sql, { workspaceId: WS, potSlugs: [potSlug], enabled: true, setBy: 'su-test' });
    await registerLearningLoop(sql, { workspaceId: WS, loopId, potSlug, budgetKind: 'per-cycle', budgetUsd: 1,
      meta: { reservationResourceBudget: resourceBudget } });
    const authority: NativeGymProviderAuthorization = { attemptKind, requestedUsd, inputTokens: 32, outputTokens: 8,
      validUntilMonotonicMs: processMonotonicClock.now() + 60_000, validateAuthorization: vi.fn(() => {}) };
    const input = { workspaceId: WS, loopId, potSlug,
      token: 'PRIVATE_PG_NATIVE_TOKEN_0123456789abcdef0123456789abcdef',
      manifestSha256: digest('private PG native manifest'), armId: 'native',
      cycle: { runId: randomUUID(), budgetUsd: 1, resourceBudget },
      authorizeProviderAttempt: vi.fn(async (_attempt: GatewayCarryTrialAttempt) => authority) };
    // Only the flag and private pool are supplied. Reserve and settle use the
    // real store, including its transaction/registration/resource checks.
    const controller = createNativeGymGatewayController(input, {
      enabled: async () => true, getSql: async () => sql, log: () => {} });
    const body = JSON.stringify({ model: 'private-approved-model', max_tokens: 8, messages: [] });
    const request: GatewayCarryTrialAttempt = { attemptId: randomUUID(), manifestSha256: input.manifestSha256,
      armId: input.armId, transport: 'anthropic-http', accountId: 'private-selected-account',
      credentialHeader: 'authorization', credentialSha256: digest('Bearer PRIVATE_PG_PROVIDER_CREDENTIAL'),
      anthropicVersion: '2023-06-01', anthropicBeta: null,
      target: 'https://provider.invalid/v1/messages', body, bodySha256: digest(body),
      clockId: processMonotonicClock.id, signal: new AbortController().signal };
    const rows = () => listLearningSpendReservations(sql, { workspaceId: WS, loopId });
    return { ...controller, input, authority, request, rows };
  };
  const result = (request: GatewayCarryTrialAttempt, reservationRef: string,
    outcome: 'send-refused' | 'fetch-failed' | 'response-headers'): GatewayCarryTrialAttemptResult => {
    const { body: _body, signal: _signal, ...identity } = request;
    if (outcome === 'send-refused') {
      return { ...identity, reservationRef, outcome, responseStatus: null, costUsd: 0, costUsdMeasurementMissing: false };
    }
    return { ...identity, reservationRef, outcome, responseStatus: outcome === 'response-headers' ? 200 : null,
      costUsdMeasurementMissing: true };
  };

  it.each(['evaluation', 'proposer'] as const)('persists exact %s admission before exposing send authority', async kind => {
    const f = await fixture(kind);
    const fresh = postgres(testDatabaseUri, { max: 1, onnotice: () => {}, prepare: false });
    try {
      const receipt = await f.gateway.carryTrial.authorizeAttempt(f.request);
      if (!receipt) throw new Error('registered exact attempt must grant');
      const rows = await listLearningSpendReservations(fresh, { workspaceId: WS, loopId: f.input.loopId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: receipt.reservationRef, workspaceId: WS, loopId: f.input.loopId,
        potSlug: f.input.potSlug, attemptKind: kind, requestedUsd: 0.25, reservedUsd: 0.25,
        usedUsd: 0, status: 'open', settledAt: null, resources: { armId: 'native', inputTokens: 32, outputTokens: 8 } });
      expect(rows[0]!.runRef).toContain(`cycle:${f.input.cycle.runId}/cap:1000000/resources:`);
      expect(rows[0]!.runRef?.endsWith(`/attempt:${receipt.reservationRef}`)).toBe(true);
      const identity = JSON.parse(rows[0]!.note!).nativeGatewayAttempt;
      const { body: _body, signal: _signal, ...expected } = f.request;
      expect(identity).toEqual(expected);
      expect(rows[0]!.note).not.toContain('PRIVATE_PG_PROVIDER_CREDENTIAL');
      expect(identity).not.toHaveProperty('body'); expect(identity).not.toHaveProperty('signal');
      expect(f.input.authorizeProviderAttempt).toHaveBeenCalledWith(f.request);
      receipt.validateAuthorization!();
      expect(f.authority.validateAuthorization).toHaveBeenCalledTimes(1);
      await receipt.observeAttemptResult!(result(f.request, receipt.reservationRef, 'response-headers'));
      expect(await sumOpenReservedUsd(fresh, { workspaceId: WS, loopId: f.input.loopId })).toBe(0.25);
    } finally { f.revoke(); await fresh.end({ timeout: 5 }); }
  });

  it.each(['send-refused', 'fetch-failed', 'response-headers'] as const)(
    'settles only exact no-fetch refusal and retains unknown %s', async outcome => {
      const f = await fixture();
      try {
        const receipt = await f.gateway.carryTrial.authorizeAttempt(f.request);
        if (!receipt) throw new Error('registered exact attempt must grant');
        if (outcome !== 'send-refused') receipt.validateAuthorization!();
        await receipt.observeAttemptResult!(result(f.request, receipt.reservationRef, outcome));
        const row = (await f.rows())[0]!;
        expect(row).toMatchObject({ id: receipt.reservationRef, usedUsd: 0,
          status: outcome === 'send-refused' ? 'cancelled' : 'open' });
        expect(row.settledAt === null).toBe(outcome !== 'send-refused');
        expect(JSON.parse(row.note!).nativeGatewayAttemptResult).toMatchObject({
          anthropicVersion: '2023-06-01', anthropicBeta: null });
        expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId: f.input.loopId }))
          .toBe(outcome === 'send-refused' ? 0 : 0.25);
        expect(await listLearningSpendEvents(sql, { workspaceId: WS, loopId: f.input.loopId })).toEqual([]);
        await expect(receipt.observeAttemptResult!(result(f.request, receipt.reservationRef, outcome))).rejects.toThrow();
        expect((await f.rows())[0]!.status).toBe(row.status);
      } finally { f.revoke(); }
    });

  it.each(['attemptId', 'accountId', 'credentialSha256', 'bodySha256', 'clockId', 'reservationRef',
    'anthropicVersion', 'anthropicBeta'] as const)(
    'keeps real reservation open for substituted result %s', async key => {
      const f = await fixture();
      try {
        const receipt = await f.gateway.carryTrial.authorizeAttempt(f.request);
        if (!receipt) throw new Error('registered exact attempt must grant');
        await expect(receipt.observeAttemptResult!({ ...result(f.request, receipt.reservationRef, 'send-refused'),
          [key]: 'foreign' })).rejects.toThrow();
        expect((await f.rows())[0]).toMatchObject({ id: receipt.reservationRef, status: 'open', settledAt: null });
        expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId: f.input.loopId })).toBe(0.25);
      } finally { f.revoke(); }
    });
  it.each(['anthropicVersion', 'anthropicBeta'] as const)('store refuses omitted effective %s identity', async field => {
    const f = await fixture();
    try {
      const receipt = await f.gateway.carryTrial.authorizeAttempt(f.request);
      if (!receipt) throw new Error('registered exact attempt must grant');
      const value = { ...result(f.request, receipt.reservationRef, 'send-refused') }; delete value[field];
      expect(await recordLearningSpendAttemptResult(sql, { workspaceId: WS, reservationId: receipt.reservationRef,
        result: value })).toEqual({ ok: false, reason: 'invalid-result' });
      expect(JSON.parse((await f.rows())[0]!.note!).nativeGatewayAttemptResult).toBeUndefined();
    } finally { f.revoke(); }
  });
  it('store refuses header control characters before writing attempt evidence', async () => {
    const f = await fixture();
    try {
      const receipt = await f.gateway.carryTrial.authorizeAttempt(f.request);
      if (!receipt) throw new Error('registered exact attempt must grant');
      expect(await recordLearningSpendAttemptResult(sql, { workspaceId: WS, reservationId: receipt.reservationRef,
        result: { ...result(f.request, receipt.reservationRef, 'send-refused'), anthropicBeta: 'context\r\nforeign' } }))
        .toEqual({ ok: false, reason: 'invalid-result' });
      expect(JSON.parse((await f.rows())[0]!.note!).nativeGatewayAttemptResult).toBeUndefined();
    } finally { f.revoke(); }
  });

  it.each(['disabled', 'pot-disabled', 'lifetime', 'budget', 'missing-resources', 'resources'] as const)(
    'refuses actual registered %s policy before issuing a receipt', async mismatch => {
      const f = await fixture();
      try {
        if (mismatch === 'disabled') await registerLearningLoop(sql, { workspaceId: WS, loopId: f.input.loopId, enabled: false });
        if (mismatch === 'pot-disabled') await setPotLearningScope(sql, { workspaceId: WS,
          potSlugs: [f.input.potSlug], enabled: false, setBy: 'su-test' });
        if (mismatch === 'lifetime') await registerLearningLoop(sql, { workspaceId: WS, loopId: f.input.loopId, budgetKind: 'lifetime' });
        if (mismatch === 'budget') await registerLearningLoop(sql, { workspaceId: WS, loopId: f.input.loopId, budgetUsd: 2 });
        if (mismatch === 'missing-resources') await registerLearningLoop(sql, { workspaceId: WS, loopId: f.input.loopId, meta: {} });
        if (mismatch === 'resources') await registerLearningLoop(sql, { workspaceId: WS, loopId: f.input.loopId,
          meta: { reservationResourceBudget: { ...resourceBudget, outputTokens: 17 } } });
        expect(await f.gateway.carryTrial.authorizeAttempt(f.request)).toBeNull();
        expect(await f.rows()).toEqual([]);
      } finally { f.revoke(); }
    });

  it('binds retries to different persisted IDs and never refunds request resources for no-fetch zero', async () => {
    const f = await fixture();
    const ids: string[] = [];
    try {
      for (let n = 0; n < 2; n++) {
        const request = { ...f.request, attemptId: randomUUID() };
        const receipt = await f.gateway.carryTrial.authorizeAttempt(request);
        if (!receipt) throw new Error('registered retry must grant');
        ids.push(receipt.reservationRef);
        await receipt.observeAttemptResult!(result(request, receipt.reservationRef, 'send-refused'));
        expect(await f.gateway.carryTrial.authorizeAttempt(request)).toBeNull();
      }
      expect(new Set(ids).size).toBe(2);
      expect(await f.gateway.carryTrial.authorizeAttempt({ ...f.request, attemptId: randomUUID() })).toBeNull();
      const rows = await f.rows();
      expect(rows).toHaveLength(2);
      expect(rows.every(row => row.status === 'cancelled' && row.usedUsd === 0)).toBe(true);
      expect(new Set(rows.map(row => JSON.parse(row.note!).nativeGatewayAttempt.attemptId)).size).toBe(2);
      expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId: f.input.loopId })).toBe(0);
    } finally { f.revoke(); }
  });

  it('admits only registered aggregate resources across simultaneous final attempts', async () => {
    const f = await fixture();
    try {
      const requests = Array.from({ length: 3 }, () => ({ ...f.request, attemptId: randomUUID() }));
      const receipts = await Promise.all(requests.map(request => f.gateway.carryTrial.authorizeAttempt(request)));
      expect(receipts.filter(Boolean)).toHaveLength(2);
      expect(await f.rows()).toHaveLength(2);
      expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId: f.input.loopId })).toBe(0.5);
      for (let i = 0; i < receipts.length; i++) {
        const receipt = receipts[i];
        if (receipt) await receipt.observeAttemptResult!(result(requests[i]!, receipt.reservationRef, 'response-headers'));
      }
      expect((await f.rows()).every(row => row.status === 'open')).toBe(true);
    } finally { f.revoke(); }
  });

  it('never exposes a partial monetary grant during simultaneous final attempts', async () => {
    const f = await fixture('proposer', 0.6);
    try {
      const requests = Array.from({ length: 2 }, () => ({ ...f.request, attemptId: randomUUID() }));
      const receipts = await Promise.all(requests.map(request => f.gateway.carryTrial.authorizeAttempt(request)));
      expect(receipts.filter(Boolean)).toHaveLength(1);
      const rows = await f.rows();
      expect(rows).toHaveLength(2);
      expect(rows.find(row => row.status === 'open')).toMatchObject({ reservedUsd: 0.6, usedUsd: 0, settledAt: null });
      expect(rows.find(row => row.status === 'failed')).toMatchObject({ reservedUsd: 0.4, usedUsd: 0 });
      expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId: f.input.loopId })).toBe(0.6);
      for (let i = 0; i < receipts.length; i++) {
        const receipt = receipts[i];
        if (receipt) await receipt.observeAttemptResult!(result(requests[i]!, receipt.reservationRef, 'response-headers'));
      }
    } finally { f.revoke(); }
  });

  it('revokes send authority while preserving the actual unknown reservation', async () => {
    const f = await fixture();
    const receipt = await f.gateway.carryTrial.authorizeAttempt(f.request);
    if (!receipt) throw new Error('registered exact attempt must grant');
    f.revoke();
    expect(() => receipt.validateAuthorization!()).toThrow();
    await expect(receipt.observeAttemptResult!(result(f.request, receipt.reservationRef, 'send-refused'))).rejects.toThrow();
    expect((await f.rows())[0]).toMatchObject({ id: receipt.reservationRef, status: 'open', settledAt: null });
    expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId: f.input.loopId })).toBe(0.25);
  });
});

describe('per-cycle run reservations', () => {
  const register = async (budgetUsd = 10) => {
    const loopId = `native-cycle:${randomUUID()}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'per-cycle', budgetUsd });
    return loopId;
  };
  const request = (loopId: string, runId: string, requestedUsd: number, budgetUsd = 10) => ({
    workspaceId: WS, loopId, requestedUsd, cycle: { runId, budgetUsd },
  });

  const resourceBudget = { inputTokens: 24, outputTokens: 8, requestsPerArm: 2, armIds: ['judge', 'proposer'] };
  const registerResources = async (budget = resourceBudget) => {
    const loopId = await register();
    await registerLearningLoop(sql, { workspaceId: WS, loopId, meta: { reservationResourceBudget: budget } });
    return loopId;
  };
  const resourceRequest = (loopId: string, runId: string, armId = 'judge') => ({
    ...request(loopId, runId, 1), cycle: { runId, budgetUsd: 10,
      resources: { armId, inputTokens: 12, outputTokens: 4 },
      expectedResourceBudget: { ...resourceBudget, armIds: [...resourceBudget.armIds] } },
  });

  it('atomically bounds concurrent cycle resources and gives another run independent capacity', async () => {
    const loopId = await registerResources();
    const runId = randomUUID();
    const results = await Promise.all(Array.from({ length: 3 }, () =>
      reserveLearningSpend(sql, resourceRequest(loopId, runId))));
    expect(results.filter(r => r.ok)).toHaveLength(2);
    expect(results.filter(r => !r.ok)).toEqual([expect.objectContaining({ reason: 'resource-cap-exceeded' })]);
    const rows = await listLearningSpendReservations(sql, { workspaceId: WS, loopId });
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.resources?.armId === 'judge' && r.resources.inputTokens === 12 && r.resources.outputTokens === 4)).toBe(true);
    expect(await reserveLearningSpend(sql, resourceRequest(loopId, randomUUID()))).toMatchObject({ ok: true });
  });

  it.each(['used', 'failed', 'cancelled'] as const)('does not refund cycle resource bounds after %s at zero monetary cost', async disposition => {
    const loopId = await registerResources();
    const runId = randomUUID();
    for (let n = 0; n < 2; n++) {
      const admitted = await reserveLearningSpend(sql, resourceRequest(loopId, runId));
      if (!admitted.ok) throw new Error('resource attempt must grant');
      expect(await settleLearningSpend(sql, { workspaceId: WS, reservationId: admitted.reservation.id,
        disposition, usedUsd: 0, accumulate: false })).toMatchObject({ ok: true });
    }
    expect(await reserveLearningSpend(sql, resourceRequest(loopId, runId, 'proposer')))
      .toMatchObject({ ok: false, reason: 'resource-cap-exceeded' });
    expect((await getLearningLoop(sql, { workspaceId: WS, loopId }))?.spentUsd).toBe(0);
  });

  it('enforces per-arm request counts independently of the aggregate token limits', async () => {
    const budget = { ...resourceBudget, inputTokens: 120, outputTokens: 40 };
    const loopId = await registerResources(budget);
    const runId = randomUUID();
    const input = resourceRequest(loopId, runId);
    input.cycle.expectedResourceBudget = { ...budget, armIds: [...budget.armIds] };
    for (let n = 0; n < 2; n++) expect(await reserveLearningSpend(sql, input)).toMatchObject({ ok: true });
    expect(await reserveLearningSpend(sql, input)).toMatchObject({ ok: false, reason: 'resource-cap-exceeded' });
    input.cycle.resources.armId = 'proposer';
    expect(await reserveLearningSpend(sql, input)).toMatchObject({ ok: true });
  });

  it.each(['missing', 'unregistered', 'stale', 'invented-arm', 'invalid-output', 'lifetime-binding'])(
    'refuses unsupported cycle resource authority (%s) without inserting', async mismatch => {
      const loopId = mismatch === 'unregistered' ? await register() : await registerResources();
      const input = resourceRequest(loopId, randomUUID());
      const invalidInput = mismatch === 'missing' ? request(loopId, input.cycle.runId, 1) : input;
      if (mismatch === 'stale') input.cycle.expectedResourceBudget.outputTokens++;
      if (mismatch === 'invented-arm') input.cycle.resources.armId = 'invented';
      if (mismatch === 'invalid-output') input.cycle.resources.outputTokens = 0;
      if (mismatch === 'lifetime-binding') await registerLearningLoop(sql, { workspaceId: WS, loopId,
        meta: { reservationBinding: 'a'.repeat(64), reservationResourceBudget: resourceBudget } });
      expect(await reserveLearningSpend(sql, invalidInput)).toMatchObject({ ok: false });
      expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId })).toEqual([]);
    },
  );

  it('refuses resource admission when prior same-run monetary rows lack resource evidence', async () => {
    const loopId = await register();
    const runId = randomUUID();
    expect(await reserveLearningSpend(sql, request(loopId, runId, 1))).toMatchObject({ ok: true });
    await registerLearningLoop(sql, { workspaceId: WS, loopId, meta: { reservationResourceBudget: resourceBudget } });
    expect(await reserveLearningSpend(sql, resourceRequest(loopId, runId)))
      .toMatchObject({ ok: false, reason: 'resource-accounting-incomplete' });
    expect(await reserveLearningSpend(sql, resourceRequest(loopId, randomUUID()))).toMatchObject({ ok: true });
  });

  it('snapshots cycle resources before a transaction wait can mutate their caller', async () => {
    const loopId = await registerResources();
    const input = resourceRequest(loopId, randomUUID());
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const gatedSql = new Proxy(sql, { get(target, key) {
      if (key === 'begin') return async (run: (tx: postgres.TransactionSql) => Promise<unknown>) => {
        await gate; return target.begin(run);
      };
      return Reflect.get(target, key);
    } });
    const pending = reserveLearningSpend(gatedSql, input);
    input.cycle.resources.outputTokens = 999;
    input.cycle.expectedResourceBudget.outputTokens = 999;
    input.cycle.expectedResourceBudget.armIds.push('invented');
    resume();
    expect(await pending).toMatchObject({ ok: true, reservation: {
      resources: { armId: 'judge', inputTokens: 12, outputTokens: 4 },
    } });
  });

  it('cannot renew the same run resource cap by changing the registered policy', async () => {
    const loopId = await registerResources();
    const runId = randomUUID();
    const first = await reserveLearningSpend(sql, resourceRequest(loopId, runId));
    if (!first.ok) throw new Error('first resource attempt must grant');
    const largerBudget = { ...resourceBudget, inputTokens: 240, outputTokens: 80, requestsPerArm: 20 };
    await registerLearningLoop(sql, { workspaceId: WS, loopId, meta: { reservationResourceBudget: largerBudget } });
    const input = resourceRequest(loopId, runId);
    input.cycle.expectedResourceBudget = { ...largerBudget, armIds: [...largerBudget.armIds] };
    expect(await reserveLearningSpend(sql, input)).toMatchObject({ ok: false, reason: 'resource-accounting-incomplete' });
    input.cycle.runId = randomUUID();
    expect(await reserveLearningSpend(sql, input)).toMatchObject({ ok: true });
    // Settlement checks persisted admission, even after the policy changes.
    expect(await settleLearningSpend(sql, { workspaceId: WS, reservationId: first.reservation.id,
      disposition: 'used', usedUsd: 0.5, accumulate: false })).toMatchObject({ ok: true });
  });

  it('clamps simultaneous attempts to one run cap and gives another run independent capacity', async () => {
    const loopId = await register();
    const runId = randomUUID();
    const results = await Promise.all([reserveLearningSpend(sql, request(loopId, runId, 6)),
      reserveLearningSpend(sql, request(loopId, runId, 6))]);
    const granted = results.filter(r => r.ok);
    expect(granted.map(r => r.reservation.reservedUsd).sort()).toEqual([4, 6]);
    expect(granted.every(r => r.reservation.runRef === `cycle:${runId}/cap:10000000/attempt:${r.reservation.id}`)).toBe(true);
    expect(await reserveLearningSpend(sql, request(loopId, runId, 1))).toMatchObject({ ok: false, reason: 'no-headroom' });
    expect(await reserveLearningSpend(sql, request(loopId, randomUUID(), 10))).toMatchObject({ ok: true, clamped: false });
  });

  it.each(['used', 'failed', 'cancelled'] as const)('charges %s attempts against their run even with accumulate:false', async disposition => {
    const loopId = await register();
    const runId = randomUUID();
    const first = await reserveLearningSpend(sql, request(loopId, runId, 6));
    if (!first.ok) throw new Error('first attempt must grant');
    expect(await settleLearningSpend(sql, { workspaceId: WS, reservationId: first.reservation.id,
      disposition, usedUsd: 5, accumulate: false })).toMatchObject({ ok: true });
    expect(await reserveLearningSpend(sql, request(loopId, runId, 6)))
      .toMatchObject({ ok: true, clamped: true, headroomUsd: 5, reservation: { reservedUsd: 5 } });
    expect((await getLearningLoop(sql, { workspaceId: WS, loopId }))?.spentUsd).toBe(0);
  });

  it('retains unknown spend and refuses invalid settlement rather than releasing run capacity', async () => {
    const loopId = await register();
    const runId = randomUUID();
    const first = await reserveLearningSpend(sql, request(loopId, runId, 10));
    if (!first.ok) throw new Error('first attempt must grant');
    for (const usedUsd of [undefined, NaN, Infinity, -1, 0.0000001]) {
      expect(await settleLearningSpend(sql, { workspaceId: WS, reservationId: first.reservation.id,
        disposition: 'failed', usedUsd, accumulate: false }))
        .toMatchObject({ ok: false, reason: 'cycle-settlement-required', reservation: { status: 'open' } });
    }
    expect(await reserveLearningSpend(sql, request(loopId, runId, 1))).toMatchObject({ ok: false, reason: 'no-headroom' });
    expect(await settleLearningSpend(sql, { workspaceId: WS, reservationId: first.reservation.id,
      disposition: 'failed', usedUsd: 0, accumulate: false })).toMatchObject({ ok: true });
    expect(await reserveLearningSpend(sql, request(loopId, runId, 10))).toMatchObject({ ok: true, clamped: false });
  });

  it('records an overrun in full and refuses further spending in that run', async () => {
    const loopId = await register();
    const runId = randomUUID();
    const first = await reserveLearningSpend(sql, request(loopId, runId, 1));
    if (!first.ok) throw new Error('first attempt must grant');
    expect(await settleLearningSpend(sql, { workspaceId: WS, reservationId: first.reservation.id,
      disposition: 'used', usedUsd: 12, accumulate: false })).toMatchObject({ ok: true, overrunUsd: 11 });
    expect(await reserveLearningSpend(sql, request(loopId, runId, 1))).toMatchObject({ ok: false, reason: 'no-headroom' });
    expect(await reserveLearningSpend(sql, request(loopId, randomUUID(), 10))).toMatchObject({ ok: true });
  });

  it('uses microdollar arithmetic without a lifetime floor', async () => {
    const loopId = await register(0.3);
    const runId = randomUUID();
    expect(await reserveLearningSpend(sql, request(loopId, runId, 0.1, 0.3))).toMatchObject({ ok: true });
    expect(await reserveLearningSpend(sql, request(loopId, runId, 0.2, 0.3))).toMatchObject({ ok: true, clamped: false });
    expect(await reserveLearningSpend(sql, request(loopId, runId, 0.000001, 0.3))).toMatchObject({ ok: false, reason: 'no-headroom' });
  });

  it('requires a transaction and a current per-cycle registration cap', async () => {
    const loopId = await register();
    const input = request(loopId, randomUUID(), 1);
    expect(await reserveLearningSpend({} as postgres.Sql, input)).toMatchObject({ ok: false, reason: 'transaction-required' });
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetUsd: 9 });
    expect(await reserveLearningSpend(sql, input)).toMatchObject({ ok: false, reason: 'stale-cycle-budget' });
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: 10 });
    expect(await reserveLearningSpend(sql, input)).toMatchObject({ ok: false, reason: 'unsupported-budget-kind' });
  });

  it.each(['bad-run', 'bad-cap', 'bad-amount', 'ambiguous-ref', 'exact-and-cycle'])(
    'refuses invalid cycle input %s without inserting a reservation', async invalid => {
      const loopId = await register();
      const input = request(loopId, randomUUID(), 1);
      if (invalid === 'bad-run') input.cycle.runId = '../other';
      if (invalid === 'bad-cap') input.cycle.budgetUsd = NaN;
      if (invalid === 'bad-amount') input.requestedUsd = 0.0000001;
      const invalidInput = { ...input,
        ...(invalid === 'ambiguous-ref' ? { runRef: 'other-run' } : {}),
        ...(invalid === 'exact-and-cycle' ? { exact: { reservationId: randomUUID(), binding: 'a'.repeat(64), expectedBudgetUsd: 10 } } : {}),
      };
      expect(await reserveLearningSpend(sql, invalidInput)).toMatchObject({ ok: false, reason: 'invalid-cycle-request' });
      expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId })).toEqual([]);
    },
  );

  it('reserves the cycle namespace for scoped issuer requests', async () => {
    const loopId = await register();
    expect(await reserveLearningSpend(sql, { workspaceId: WS, loopId, requestedUsd: 1,
      runRef: `cycle:${randomUUID()}/attempt:${randomUUID()}` }))
      .toMatchObject({ ok: false, reason: 'cycle-binding-required' });
  });

  it('retains the frozen cap across later registration changes for the same run', async () => {
    const loopId = await register();
    const runId = randomUUID();
    expect(await reserveLearningSpend(sql, request(loopId, runId, 1))).toMatchObject({ ok: true });
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetUsd: 20 });
    expect(await reserveLearningSpend(sql, request(loopId, runId, 1))).toMatchObject({ ok: false, reason: 'stale-cycle-budget' });
    expect(await reserveLearningSpend(sql, request(loopId, runId, 1, 20)))
      .toMatchObject({ ok: false, reason: 'cycle-accounting-incomplete' });
    expect(await reserveLearningSpend(sql, request(loopId, randomUUID(), 20, 20))).toMatchObject({ ok: true });
  });

  it('copies cycle admission before a transaction wait can mutate its caller', async () => {
    const loopId = await register();
    const runId = randomUUID();
    const input = request(loopId, runId, 1);
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const gatedSql = new Proxy(sql, { get(target, key) {
      if (key === 'begin') return async (run: (tx: postgres.TransactionSql) => Promise<unknown>) => {
        await gate; return target.begin(run);
      };
      return Reflect.get(target, key);
    } });
    const pending = reserveLearningSpend(gatedSql, input);
    input.cycle.runId = randomUUID();
    input.cycle.budgetUsd = 100;
    resume();
    const receipt = await pending;
    expect(receipt).toMatchObject({ ok: true });
    if (!receipt.ok) throw new Error('original cycle must grant');
    expect(receipt.reservation.runRef).toBe(`cycle:${runId}/cap:10000000/attempt:${receipt.reservation.id}`);
  });
});

describe('exact manifest-bound reservations', () => {
  const binding = 'a'.repeat(64);
  const register = async (budgetUsd = 10) => {
    const loopId = `exact:${randomUUID()}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetUsd,
      meta: { reservationBinding: binding } });
    return loopId;
  };
  const request = (loopId: string, requestedUsd: number, reservationId = randomUUID(), expectedBudgetUsd = 10) => ({
    workspaceId: WS, loopId, requestedUsd, floorUsd: 0,
    exact: { reservationId, binding, expectedBudgetUsd },
  });

  it('grants only one of two simultaneous requests that cannot both fit in full', async () => {
    const loopId = await register();
    const results = await Promise.all([reserveLearningSpend(sql, request(loopId, 6)),
      reserveLearningSpend(sql, request(loopId, 6))]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => !r.ok)).toMatchObject({ ok: false, reason: 'insufficient-headroom' });
    const rows = await listLearningSpendReservations(sql, { workspaceId: WS, loopId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requestedUsd: 6, reservedUsd: 6, status: 'open' });
    expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId })).toBe(6);
  });

  it('refuses concurrent and settled replays instead of returning an old grant', async () => {
    const loopId = await register();
    const input = request(loopId, 1);
    const results = await Promise.all([reserveLearningSpend(sql, input), reserveLearningSpend(sql, input)]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => !r.ok)).toMatchObject({ ok: false, reason: 'already-reserved' });
    const [row] = await listLearningSpendReservations(sql, { workspaceId: WS, loopId });
    expect(row!.runRef).toBe(`manifest:${binding}/attempt:${input.exact.reservationId}`);
    await settleLearningSpend(sql, { workspaceId: WS, reservationId: row!.id, disposition: 'used', usedUsd: 1 });
    expect(await reserveLearningSpend(sql, input)).toMatchObject({ ok: false, reason: 'already-reserved' });
  });

  it('uses the existing global UUID key to prevent reuse across registration locks', async () => {
    const loops = await Promise.all([register(), register()]);
    const reservationId = randomUUID();
    const results = await Promise.all(loops.map(loop => reserveLearningSpend(sql, request(loop, 1, reservationId))));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => !r.ok)).toMatchObject({ ok: false, reason: 'already-reserved' });
  });

  it('fails closed for missing/stale bindings, cap changes, disabled loops and legacy bypass', async () => {
    const loopId = await register();
    expect(await reserveLearningSpend(sql, { ...request(loopId, 1), exact: undefined }))
      .toMatchObject({ ok: false, reason: 'binding-required' });
    expect(await reserveLearningSpend(sql, { ...request(loopId, 1), exact: {
      ...request(loopId, 1).exact, binding: 'b'.repeat(64) } })).toMatchObject({ ok: false, reason: 'stale-binding' });
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetUsd: 9 });
    expect(await reserveLearningSpend(sql, request(loopId, 1))).toMatchObject({ ok: false, reason: 'stale-binding' });
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetUsd: 10, enabled: false });
    expect(await reserveLearningSpend(sql, request(loopId, 1))).toMatchObject({ ok: false, reason: 'disabled' });
    await registerLearningLoop(sql, { workspaceId: WS, loopId, enabled: true, budgetKind: 'per-cycle' });
    expect(await reserveLearningSpend(sql, request(loopId, 1)))
      .toMatchObject({ ok: false, reason: 'unsupported-budget-kind' });
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', meta: {} });
    expect(await reserveLearningSpend(sql, request(loopId, 1))).toMatchObject({ ok: false, reason: 'stale-binding' });
    expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId })).toEqual([]);
  });

  it('uses exact microdollar headroom and refuses sub-microdollar input', async () => {
    const loopId = await register(0.3);
    expect((await reserveLearningSpend(sql, request(loopId, 0.1, randomUUID(), 0.3))).ok).toBe(true);
    expect((await reserveLearningSpend(sql, request(loopId, 0.2, randomUUID(), 0.3))).ok).toBe(true);
    expect(await reserveLearningSpend(sql, request(loopId, 0.000001, randomUUID(), 0.3)))
      .toMatchObject({ ok: false, reason: 'insufficient-headroom' });
    expect(await reserveLearningSpend(sql, request(loopId, 0.0000001, randomUUID(), 0.3)))
      .toMatchObject({ ok: false, reason: 'invalid-exact-request' });
    expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId })).toBe(0.3);
  });

  it('requires a transaction-capable connection before reading or granting', async () => {
    const input = request('does-not-exist', 1);
    expect(await reserveLearningSpend({} as postgres.Sql, input))
      .toMatchObject({ ok: false, reason: 'transaction-required' });
  });

  it('exact settlement rejects mirror accounting instead of reopening charged dollar capacity', async () => {
    const loopId = await register();
    const input = request(loopId, 10);
    expect((await reserveLearningSpend(sql, input)).ok).toBe(true);
    const settled = await settleLearningSpend(sql, { workspaceId: WS, reservationId: input.exact.reservationId,
      disposition: 'used', usedUsd: 10, accumulate: false });
    const next = await reserveLearningSpend(sql, request(loopId, 10));
    expect({ settled: settled.ok, secondGrant: next.ok }).toEqual({ settled: false, secondGrant: false });
    expect(settled).toMatchObject({ reason: 'exact-settlement-required', reservation: { status: 'open' } });
    expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId })).toBe(10);
    expect(await listLearningSpendEvents(sql, { workspaceId: WS, loopId })).toHaveLength(0);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 0.0000001])(
    'exact settlement retains reservations for an unknown or invalid charge (%s)', async usedUsd => {
      const loopId = await register();
      const input = request(loopId, 10);
      expect((await reserveLearningSpend(sql, input)).ok).toBe(true);
      expect(await settleLearningSpend(sql, { workspaceId: WS, reservationId: input.exact.reservationId,
        disposition: 'failed', usedUsd })).toMatchObject({ ok: false, reason: 'exact-settlement-required' });
      expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId })).toBe(10);
      expect(await listLearningSpendEvents(sql, { workspaceId: WS, loopId })).toHaveLength(0);
    });

  it('exact settlement records an explicit charge once, including an overrun', async () => {
    const loopId = await register();
    const input = request(loopId, 10);
    expect((await reserveLearningSpend(sql, input)).ok).toBe(true);
    const settle = { workspaceId: WS, reservationId: input.exact.reservationId,
      disposition: 'failed' as const, usedUsd: 11 };
    const results = await Promise.all([settleLearningSpend(sql, settle), settleLearningSpend(sql, settle)]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => r.ok)).toMatchObject({ overrunUsd: 1, releasedUsd: 0 });
    expect(results.find(r => !r.ok)).toMatchObject({ reason: 'already-settled' });
    expect((await getLearningLoop(sql, { workspaceId: WS, loopId }))!.spentUsd).toBe(11);
    expect(await listLearningSpendEvents(sql, { workspaceId: WS, loopId })).toHaveLength(1);
    expect((await reserveLearningSpend(sql, request(loopId, 1))).ok).toBe(false);
  });
});

describe('manifest-bound resource reservations', () => {
  const binding = 'c'.repeat(64);
  const budget = () => ({ inputTokens: 10, outputTokens: 10, requestsPerArm: 2, armIds: ['control', 'candidate'] });
  const register = async (caps = budget()) => {
    const loopId = `resources:${randomUUID()}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetUsd: 10,
      meta: { reservationBinding: binding, reservationResourceBudget: caps } });
    return loopId;
  };
  const request = (loopId: string, caps = budget(), armId = 'control', inputTokens = 1, outputTokens = 1) => ({
    workspaceId: WS, loopId, requestedUsd: 1, floorUsd: 0,
    exact: { reservationId: randomUUID(), binding, expectedBudgetUsd: 10,
      resources: { armId, inputTokens, outputTokens }, expectedResourceBudget: caps },
  });

  it('runs the governed helper only after the exact resource row exists and settles that same row', async () => {
    const loopId = await register();
    const input = request(loopId, budget(), 'control', 3, 4);
    let called = false;
    const out = await runGovernedSpendAttempt({ ...input, attemptKind: 'evaluation',
      run: async grant => {
        called = true;
        const fresh = postgres(testDatabaseUri, { max: 1, onnotice: () => {}, prepare: false });
        try {
          const rows = await listLearningSpendReservations(fresh, { workspaceId: WS, loopId });
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ id: input.exact.reservationId, status: 'open',
            runRef: `manifest:${input.exact.binding}/attempt:${input.exact.reservationId}`,
            requestedUsd: 1, reservedUsd: 1, resources: input.exact.resources });
          expect(grant).toEqual({ reservationId: input.exact.reservationId, reservedUsd: 1,
            clamped: false, resources: input.exact.resources });
          return { costUsd: 0.02, value: 'scored' };
        } finally { await fresh.end({ timeout: 5 }); }
      } }, { enabled: async () => true, getSql: async () => sql, log: () => {} });
    expect(called).toBe(true);
    expect(out).toMatchObject({ ok: true, value: 'scored', reservationId: input.exact.reservationId,
      settlement: { ok: true, reservation: { id: input.exact.reservationId, status: 'settled', usedUsd: 0.02 } } });
    expect((await getLearningLoop(sql, { workspaceId: WS, loopId }))!.spentUsd).toBe(0.02);
    expect(await listLearningSpendEvents(sql, { workspaceId: WS, loopId })).toHaveLength(1);
    expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId })).toBe(0);
  });

  it('refuses a concurrent resource-cap contender and a settled replay before either callback runs', async () => {
    const caps = { ...budget(), requestsPerArm: 1 };
    const loopId = await register(caps);
    let calls = 0;
    const run = async () => { calls += 1; return { costUsd: 0, value: 'zero-dollar completion' }; };
    const input = { ...request(loopId, caps), attemptKind: 'proposer' as const, run };
    const deps = { enabled: async () => true, getSql: async () => sql, log: () => {} };
    const results = await Promise.all([runGovernedSpendAttempt(input, deps),
      runGovernedSpendAttempt({ ...input, exact: { ...input.exact, reservationId: randomUUID() } }, deps)]);
    expect(calls).toBe(1);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => !r.ok)).toMatchObject({ reason: 'refused', refusal: 'resource-cap-exceeded' });
    const rows = await listLearningSpendReservations(sql, { workspaceId: WS, loopId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'settled', usedUsd: 0, resources: input.exact.resources });
    const fresh = postgres(testDatabaseUri, { max: 1, onnotice: () => {}, prepare: false });
    try {
      const replay = { ...input, exact: { ...input.exact, reservationId: rows[0]!.id } };
      expect(await runGovernedSpendAttempt(replay, { ...deps, getSql: async () => fresh }))
        .toMatchObject({ reason: 'refused', refusal: 'resource-cap-exceeded' });
    } finally { await fresh.end({ timeout: 5 }); }
    expect(calls).toBe(1);
    expect(await listLearningSpendEvents(sql, { workspaceId: WS, loopId })).toHaveLength(0);
  });

  it('preserves the exact-settlement refusal when a caller asks for mirror accounting', async () => {
    const loopId = await register();
    const input = request(loopId);
    const out = await runGovernedSpendAttempt({ ...input, attemptKind: 'evaluation', accumulate: false,
      run: async () => ({ costUsd: 0.02, value: 'reported work' }) },
    { enabled: async () => true, getSql: async () => sql, log: () => {} });
    expect(out).toMatchObject({ ok: true, value: 'reported work', reservationId: input.exact.reservationId,
      settlement: { ok: false, reason: 'exact-settlement-required',
        reservation: { id: input.exact.reservationId, status: 'open', usedUsd: 0, resources: input.exact.resources } } });
    expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId })).toBe(1);
    expect((await getLearningLoop(sql, { workspaceId: WS, loopId }))!.spentUsd).toBe(0);
    expect(await listLearningSpendEvents(sql, { workspaceId: WS, loopId })).toHaveLength(0);
  });

  it('retains exact resource admission after incomplete usage and refuses stale policy before dispatch', async () => {
    const loopId = await register();
    const input = request(loopId);
    let calls = 0;
    const run = async () => { calls += 1; return { costUsd: 0.02, costUsdMeasurementMissing: true, value: 'partial' }; };
    const deps = { enabled: async () => true, getSql: async () => sql, log: () => {} };
    const out = await runGovernedSpendAttempt({ ...input, attemptKind: 'evaluation', accumulate: false, run }, deps);
    expect(out).toMatchObject({ ok: true, value: 'partial', costUsd: 0.02,
      costUsdMeasurementMissing: true, settlement: null, reservationId: input.exact.reservationId });
    expect((await listLearningSpendReservations(sql, { workspaceId: WS, loopId }))[0])
      .toMatchObject({ status: 'open', usedUsd: 0, resources: input.exact.resources });
    expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId })).toBe(1);
    const stale = { ...request(loopId), attemptKind: 'evaluation' as const, run };
    stale.exact.expectedResourceBudget.outputTokens += 1;
    expect(await runGovernedSpendAttempt(stale, deps)).toMatchObject({ reason: 'refused', refusal: 'stale-binding' });
    expect(calls).toBe(1);
    expect(await listLearningSpendEvents(sql, { workspaceId: WS, loopId })).toHaveLength(0);
  });

  it.each(['input', 'output', 'requests'] as const)('serializes competing %s grants independently of dollar headroom', async axis => {
    const caps = budget();
    if (axis === 'requests') caps.requestsPerArm = 1;
    const loopId = await register(caps);
    const first = request(loopId, caps, 'control', axis === 'input' ? 6 : 1, axis === 'output' ? 6 : 1);
    const results = await Promise.all([reserveLearningSpend(sql, first),
      reserveLearningSpend(sql, { ...first, exact: { ...first.exact, reservationId: randomUUID() } })]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => !r.ok)).toMatchObject({ reason: 'resource-cap-exceeded' });
    const rows = await listLearningSpendReservations(sql, { workspaceId: WS, loopId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resources).toEqual(first.exact.resources);
    expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId })).toBe(1);
  });

  it('accepts the exact global boundary across arms and rejects an invented arm', async () => {
    const loopId = await register();
    expect((await reserveLearningSpend(sql, request(loopId, budget(), 'control', 5, 5))).ok).toBe(true);
    expect((await reserveLearningSpend(sql, request(loopId, budget(), 'candidate', 5, 5))).ok).toBe(true);
    expect(await reserveLearningSpend(sql, request(loopId))).toMatchObject({ reason: 'resource-cap-exceeded' });
    const anotherLoop = await register();
    expect(await reserveLearningSpend(sql, request(anotherLoop, budget(), 'third')))
      .toMatchObject({ reason: 'resource-cap-exceeded' });
    expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId: anotherLoop })).toEqual([]);
  });

  it.each(['cancelled', 'failed', 'used'] as const)('retains every resource after %s settlement, including a zero-dollar result', async disposition => {
    const caps = { ...budget(), requestsPerArm: 1 };
    const loopId = await register(caps);
    const input = request(loopId, caps, 'control', 5, 5);
    expect((await reserveLearningSpend(sql, input)).ok).toBe(true);
    expect((await settleLearningSpend(sql, { workspaceId: WS, reservationId: input.exact.reservationId,
      disposition, usedUsd: 0 })).ok).toBe(true);
    expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId })).toBe(0);
    // No process-local counter can establish this: the next call opens a new connection.
    const fresh = postgres(testDatabaseUri, { max: 1, onnotice: () => {}, prepare: false });
    try {
      expect(await reserveLearningSpend(fresh, request(loopId, caps))).toMatchObject({ reason: 'resource-cap-exceeded' });
      expect((await reserveLearningSpend(fresh, request(loopId, caps, 'candidate', 5, 5))).ok).toBe(true);
    } finally { await fresh.end({ timeout: 5 }); }
  });

  it('refuses omitted resources, USD-only bypass and changed expected caps', async () => {
    const loopId = await register();
    const input = request(loopId);
    expect(await reserveLearningSpend(sql, { ...input, exact: undefined })).toMatchObject({ reason: 'binding-required' });
    expect(await reserveLearningSpend(sql, { ...input, exact: { reservationId: randomUUID(), binding, expectedBudgetUsd: 10 } }))
      .toMatchObject({ reason: 'resource-binding-required' });
    for (const caps of [{ ...budget(), inputTokens: 11 }, { ...budget(), outputTokens: 11 },
      { ...budget(), requestsPerArm: 3 }, { ...budget(), armIds: ['control', 'third'] }]) {
      expect(await reserveLearningSpend(sql, request(loopId, caps))).toMatchObject({ reason: 'stale-binding' });
    }
    expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId })).toEqual([]);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('refuses invalid resource bound %s before reserving', async bad => {
    const loopId = await register();
    expect(await reserveLearningSpend(sql, request(loopId, budget(), 'control', bad)))
      .toMatchObject({ reason: 'invalid-exact-request' });
    expect(await reserveLearningSpend(sql, request(loopId, budget(), 'control', 1, bad)))
      .toMatchObject({ reason: 'invalid-exact-request' });
    expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId })).toEqual([]);
  });

  it('rejects zero output, duplicated arm policy and resources without a registered resource policy', async () => {
    const loopId = await register();
    expect(await reserveLearningSpend(sql, request(loopId, budget(), 'control', 1, 0)))
      .toMatchObject({ reason: 'invalid-exact-request' });
    expect(await reserveLearningSpend(sql, request(loopId, { ...budget(), armIds: ['control', 'control'] })))
      .toMatchObject({ reason: 'invalid-exact-request' });
    await registerLearningLoop(sql, { workspaceId: WS, loopId, meta: { reservationBinding: binding } });
    expect(await reserveLearningSpend(sql, request(loopId))).toMatchObject({ reason: 'resource-binding-required' });
  });

  it('never interprets legacy history or another manifest as a complete resource census', async () => {
    const loopId = await register();
    await registerLearningLoop(sql, { workspaceId: WS, loopId, meta: { reservationBinding: binding } });
    const legacy = request(loopId);
    expect((await reserveLearningSpend(sql, { ...legacy, exact: { reservationId: randomUUID(), binding, expectedBudgetUsd: 10 } })).ok).toBe(true);
    await registerLearningLoop(sql, { workspaceId: WS, loopId,
      meta: { reservationBinding: binding, reservationResourceBudget: budget() } });
    expect(await reserveLearningSpend(sql, request(loopId))).toMatchObject({ reason: 'resource-accounting-incomplete' });
    const otherLoop = await register();
    expect((await reserveLearningSpend(sql, request(otherLoop))).ok).toBe(true);
    const changedBinding = 'd'.repeat(64);
    await registerLearningLoop(sql, { workspaceId: WS, loopId: otherLoop,
      meta: { reservationBinding: changedBinding, reservationResourceBudget: budget() } });
    const next = request(otherLoop); next.exact.binding = changedBinding;
    expect(await reserveLearningSpend(sql, next)).toMatchObject({ reason: 'resource-accounting-incomplete' });
  });

  it('prevents replay without consuming extra resource slots or dollar headroom', async () => {
    const loopId = await register();
    const input = request(loopId);
    expect((await reserveLearningSpend(sql, input)).ok).toBe(true);
    expect(await reserveLearningSpend(sql, input)).toMatchObject({ reason: 'already-reserved' });
    expect((await reserveLearningSpend(sql, request(loopId))).ok).toBe(true);
    expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId })).toHaveLength(2);
  });

  it('the additive migration rejects partial resource rows and preserves USD-only rows', async () => {
    const loopId = await register();
    await expect(sql`INSERT INTO harness_shared.learning_spend_reservations
      (workspace_id, loop_id, requested_usd, reserved_usd, arm_id)
      VALUES (${WS}, ${loopId}, 1, 1, 'control')`).rejects.toMatchObject({ code: '23514' });
    await expect(sql`INSERT INTO harness_shared.learning_spend_reservations
      (workspace_id, loop_id, requested_usd, reserved_usd)
      VALUES (${WS}, ${loopId}, 1, 1)`).resolves.toBeDefined();
  });
});

describe('registry — register/get/list', () => {
  it('registers a loop with defaults and reads it back', async () => {
    const reg = await registerLearningLoop(sql, { workspaceId: WS, loopId: 'frontier:replay' });
    expect(reg).toMatchObject({
      workspaceId: WS,
      loopId: 'frontier:replay',
      displayName: 'frontier:replay',
      budgetKind: 'lifetime',
      budgetUsd: null,
      spentUsd: 0,
      priority: 100,
      enabled: true,
      enforcement: 'governor',
    });
    expect(reg.registeredAt).toBeGreaterThan(0);
    const got = await getLearningLoop(sql, { workspaceId: WS, loopId: 'frontier:replay' });
    expect(got?.displayName).toBe('frontier:replay');
  });

  it('upsert preserves omitted fields and registered_at; explicit fields overwrite', async () => {
    const first = await registerLearningLoop(sql, {
      workspaceId: WS,
      loopId: 'gym:alpha',
      displayName: 'Gym autoloop (alpha)',
      budgetUsd: 20,
      spentUsd: 2,
      priority: 50,
      enforcement: 'native',
    });
    const second = await registerLearningLoop(sql, { workspaceId: WS, loopId: 'gym:alpha', budgetUsd: 30 });
    expect(second.budgetUsd).toBe(30);
    expect(second.spentUsd).toBe(2); // omitted ⇒ preserved
    expect(second.displayName).toBe('Gym autoloop (alpha)');
    expect(second.priority).toBe(50);
    expect(second.enforcement).toBe('native');
    expect(second.registeredAt).toBe(first.registeredAt);
  });

  it('budgetUsd null CLEARS the cap; undefined preserves it', async () => {
    await registerLearningLoop(sql, { workspaceId: WS, loopId: 'frontier:miner', budgetUsd: 5 });
    const preserved = await registerLearningLoop(sql, { workspaceId: WS, loopId: 'frontier:miner' });
    expect(preserved.budgetUsd).toBe(5);
    const cleared = await registerLearningLoop(sql, { workspaceId: WS, loopId: 'frontier:miner', budgetUsd: null });
    expect(cleared.budgetUsd).toBeNull();
  });

  it('lists the workspace registry in priority order', async () => {
    const loops = await listLearningLoops(sql, { workspaceId: WS });
    expect(loops.length).toBeGreaterThanOrEqual(3);
    const priorities = loops.map((l) => l.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    expect(loops.some((l) => l.loopId === 'gym:alpha')).toBe(true);
  });

  it('deleteLearningLoop drops the registration (P-021 dissolve teardown) and is idempotent', async () => {
    await registerLearningLoop(sql, { workspaceId: WS, loopId: 'gym:doomed', budgetUsd: 5 });
    expect(await getLearningLoop(sql, { workspaceId: WS, loopId: 'gym:doomed' })).not.toBeNull();
    expect(await deleteLearningLoop(sql, { workspaceId: WS, loopId: 'gym:doomed' })).toEqual({ deleted: true });
    expect(await getLearningLoop(sql, { workspaceId: WS, loopId: 'gym:doomed' })).toBeNull();
    // A second delete (or a never-registered loop) is a no-op, not an error.
    expect(await deleteLearningLoop(sql, { workspaceId: WS, loopId: 'gym:doomed' })).toEqual({ deleted: false });
  });
});

describe('spend ledger — recordLearningSpend + events', () => {
  it('accumulate:true bumps the registration spent atomically with the event', async () => {
    await registerLearningLoop(sql, { workspaceId: WS, loopId: 'scout:alpha', budgetKind: 'per-cycle', budgetUsd: 1 });
    const ev = await recordLearningSpend(sql, {
      workspaceId: WS,
      loopId: 'scout:alpha',
      costUsd: 0.4,
      runRef: 'scout-1',
      note: 'scout ideation cycle',
    });
    expect(ev.costUsd).toBe(0.4);
    expect(ev.signalOrigin).toBe('organic');
    const reg = await getLearningLoop(sql, { workspaceId: WS, loopId: 'scout:alpha' });
    expect(reg?.spentUsd).toBe(0.4);
  });

  it('accumulate:false ledgers the event without touching the registration (gym mirror mode)', async () => {
    const before = await getLearningLoop(sql, { workspaceId: WS, loopId: 'gym:alpha' });
    await recordLearningSpend(sql, {
      workspaceId: WS,
      loopId: 'gym:alpha',
      costUsd: 1.25,
      runRef: 'gym-cycle:alpha',
      accumulate: false,
    });
    const after = await getLearningLoop(sql, { workspaceId: WS, loopId: 'gym:alpha' });
    expect(after?.spentUsd).toBe(before?.spentUsd);
    const events = await listLearningSpendEvents(sql, { workspaceId: WS, loopId: 'gym:alpha' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ costUsd: 1.25, runRef: 'gym-cycle:alpha' });
  });

  it('rejects a negative/NaN cost', async () => {
    await expect(
      recordLearningSpend(sql, { workspaceId: WS, loopId: 'scout:alpha', costUsd: -1 }),
    ).rejects.toThrow(/non-negative/);
    await expect(
      recordLearningSpend(sql, { workspaceId: WS, loopId: 'scout:alpha', costUsd: Number.NaN }),
    ).rejects.toThrow(/non-negative/);
  });

  it('carries non-organic provenance (P-002/D-002 vocabulary) and rejects junk origins via the CHECK', async () => {
    const ev = await recordLearningSpend(sql, {
      workspaceId: WS,
      loopId: 'frontier:replay',
      costUsd: 0.1,
      signalOrigin: 'replay',
      accumulate: false,
    });
    expect(ev.signalOrigin).toBe('replay');
    await expect(
      recordLearningSpend(sql, {
        workspaceId: WS,
        loopId: 'frontier:replay',
        costUsd: 0.1,
        // @ts-expect-error — junk origin must die at the DB CHECK too
        signalOrigin: 'synthetic',
      }),
    ).rejects.toThrow();
  });

  it('lists workspace-wide events newest-first with the loop filter', async () => {
    const all = await listLearningSpendEvents(sql, { workspaceId: WS });
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < all.length; i++) expect(all[i - 1].createdAt).toBeGreaterThanOrEqual(all[i].createdAt);
    const scoped = await listLearningSpendEvents(sql, { workspaceId: WS, loopId: 'scout:alpha' });
    expect(scoped.every((e) => e.loopId === 'scout:alpha')).toBe(true);
  });
});

describe('governorCheck — the unattended-refusal lifecycle on live rows', () => {
  it('unregistered ⇒ refuse', async () => {
    expect(await governorCheck(sql, { workspaceId: WS, loopId: 'frontier:nope' })).toEqual({
      allow: false,
      reason: 'unregistered',
      remainingUsd: null,
    });
  });

  it('registered but unbudgeted ⇒ refuse (frontier:replay has no cap yet)', async () => {
    // A focused run must establish the registration itself; another test's
    // frontier:replay fixture is deliberately outside this case's authority.
    const loopId = `frontier:unbudgeted:${randomUUID()}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetUsd: null });
    const v = await governorCheck(sql, { workspaceId: WS, loopId });
    expect(v.reason).toBe('unbudgeted');
  });

  it('budgeted ⇒ allow; spend past the floor ⇒ exhausted', async () => {
    await registerLearningLoop(sql, { workspaceId: WS, loopId: 'frontier:ekg', budgetUsd: 2 });
    expect((await governorCheck(sql, { workspaceId: WS, loopId: 'frontier:ekg' })).allow).toBe(true);
    await recordLearningSpend(sql, { workspaceId: WS, loopId: 'frontier:ekg', costUsd: 1.8 });
    const v = await governorCheck(sql, { workspaceId: WS, loopId: 'frontier:ekg' });
    expect(v).toEqual({ allow: false, reason: 'exhausted', remainingUsd: expect.closeTo(0.2, 6) });
  });

  it('disabled ⇒ refuse', async () => {
    await registerLearningLoop(sql, { workspaceId: WS, loopId: 'frontier:ekg', enabled: false });
    expect((await governorCheck(sql, { workspaceId: WS, loopId: 'frontier:ekg' })).reason).toBe('disabled');
  });
});

describe('governorCheck — the per-pot master switch (learning-pot-scope-gate D-001)', () => {
  const POT = 'gated-pot';
  const LOOP = 'frontier:in-a-pot';

  it('allows a healthy loop while its pot has no scope row (fail-open, R-5)', async () => {
    await registerLearningLoop(sql, { workspaceId: WS, loopId: LOOP, potSlug: POT, budgetUsd: 5 });
    // Control for the two assertions below: without it, a gate that refused
    // everything would look identical to a gate that works.
    expect((await governorCheck(sql, { workspaceId: WS, loopId: LOOP })).allow).toBe(true);
  });

  it('refuses with pot-disabled once the pot is switched off — through the real relation', async () => {
    await setPotLearningScope(sql, { workspaceId: WS, potSlugs: [POT], enabled: false, setBy: 'su-test' });
    const v = await governorCheck(sql, { workspaceId: WS, loopId: LOOP });
    expect(v.reason).toBe('pot-disabled');
    expect(v.allow).toBe(false);
  });

  it('leaves the loop\'s OWN registration untouched, so switching the pot back on restores it', async () => {
    // The lane never learns it was gated: `enabled` is still true and its
    // budget is intact, which is why the restore needs no bookkeeping.
    const reg = await getLearningLoop(sql, { workspaceId: WS, loopId: LOOP });
    expect(reg?.enabled).toBe(true);
    expect(reg?.budgetUsd).toBe(5);

    await setPotLearningScope(sql, { workspaceId: WS, potSlugs: [POT], enabled: true, setBy: 'su-test' });
    expect((await governorCheck(sql, { workspaceId: WS, loopId: LOOP })).allow).toBe(true);
  });

  it('does not gate a POT-LESS loop, whatever the scope table holds', async () => {
    // frontier:ekg carries no pot_slug; a disabled row for some other pot must
    // not reach it, or the gate would silently widen to every legacy loop.
    await setPotLearningScope(sql, { workspaceId: WS, potSlugs: [POT], enabled: false, setBy: 'su-test' });
    expect((await governorCheck(sql, { workspaceId: WS, loopId: 'frontier:ekg' })).reason).toBe('disabled');
  });
});

describe('the one visible number (P-003 verification)', () => {
  it('summarize over the live registry rolls every registrant into one total', async () => {
    const loops = await listLearningLoops(sql, { workspaceId: WS });
    const s = summarizeLearningSpend(loops);
    expect(s.loopCount).toBe(loops.length);
    // scout:alpha accumulated 0.4, frontier:ekg 1.8; gym mirror spend stays on its own row value.
    expect(s.totalSpentUsd).toBeCloseTo(loops.reduce((a, l) => a + l.spentUsd, 0), 6);
    expect(s.unbudgetedLoopIds).toContain('frontier:miner');
  });
});

/* ── reservation + settlement (P-005), migration 1116 ────────────────────── */

describe('governed attempt persisted settlement receipts', () => {
  it.each([
    { label: 'incomplete score', missing: true, cost: 0.3, calls: 1, status: 'open' },
    { label: 'unreported score', missing: true, cost: 0.3, calls: 1, status: 'open' },
    { label: 'incomplete repaired score', missing: true, cost: 0.5, calls: 2, status: 'open' },
    { label: 'contract failure', missing: false, cost: 0.5, calls: 2, status: 'failed' },
    { label: 'paid repair failure', missing: false, cost: 0.37, calls: 2, status: 'failed' },
    { label: 'unknown repair failure', missing: true, cost: 0.3, calls: 2, status: 'open' },
    { label: 'complete score', missing: false, cost: 0.3, calls: 1, status: 'settled' },
  ])('native judge $label preserves the same SQL reservation and mirror accounting', async fixture => {
    const loopId = `gym:judge-receipt-${randomUUID()}`;
    const runRef = `native-judge:${randomUUID()}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: 10 });
    let judgeCalls = 0;
    let pipelines = 0;
    let scores = 0;
    const unexpected = async () => { throw new Error('judge fixture must not propose'); };
    const native = buildLoopDeps({ gymSql: sql, ports: {} as never,
      proposerCall: unexpected, proposerModel: 'controlled',
      judgeCall: async () => {
        const call = ++judgeCalls;
        if (call === 2 && fixture.label.endsWith('repair failure')) {
          throw Object.assign(new Error('repair transport failed'),
            fixture.label === 'paid repair failure' ? { costUsd: 0.07 } : {});
        }
        const malformed = fixture.label === 'contract failure' || (call === 1 && fixture.calls === 2);
        return { text: malformed ? 'malformed' : '{"d1":5,"d2":5,"d3":5,"rationale":"r"}',
          costUsd: 0.2, inputTokens: 10, outputTokens: 5,
          ...(fixture.label.startsWith('incomplete') && call === 1 ? { costUsdMeasurementMissing: true } : {}),
          ...(fixture.label === 'unreported score' ? { unreportedFrames: 2 } : {}) };
      },
      tasks: [{ taskId: 'native-task', pool: 'train', repoUrl: 'r', repoCommit: 'c', spec: 's',
        intent: 'i', projectContext: 'p' }],
      baseline: { variantId: 'baseline', overlay: { promptOverrides: {} } },
      harnessCommit: 'controlled', workspaceId: WS, scratchRoot: '/unused-native-judge-fixture',
      timeoutMs: 100, pollIntervalMs: 1, maxDistillChars: 100,
      abDeps: {
        store: { upsertVariant: async () => {}, upsertTask: async () => {}, startRun: async () => {},
          finishRun: async () => {}, recordScore: async () => { scores++; }, comparison: async () => [] },
        runPipeline: async () => { pipelines++; return { harnessSlug: 'controlled', clonePath: '/unused',
          workflowID: 'controlled', outcome: 'completed', pipelineUsd: 0.1 }; },
        collectAndDistill: async () => ({ distilledTrace: 'controlled', traceRef: 'controlled', rawSignals: {} }),
        llmCall: unexpected, newRunId: () => 'unused', now: () => 0,
      },
    });
    const out = await runGovernedSpendAttempt({ workspaceId: WS, loopId, attemptKind: 'evaluation',
      requestedUsd: 1, runRef, accumulate: false, run: async grant => {
        const current = await listLearningSpendReservations(sql, { workspaceId: WS, loopId });
        expect(current).toMatchObject([{ id: grant.reservationId, status: 'open', reservedUsd: 1 }]);
        const value = await native.evaluate('baseline', { promptOverrides: {} });
        return { value, costUsd: value.costUsd };
      } }, { enabled: async () => true, getSql: async () => sql, log: () => {} });
    if ((!out.ok && out.reason !== 'failed') || !out.reservationId) throw new Error('expected admitted native judge');
    expect(out.costUsd).toBeCloseTo(fixture.cost, 6);
    expect(judgeCalls).toBe(fixture.calls);
    expect(pipelines).toBe(1);
    expect(scores).toBe(fixture.status === 'settled' ? 1 : 0);
    if (fixture.missing) expect(out).toMatchObject({ ok: false, costUsdMeasurementMissing: true, settlement: null });
    else expect(out.settlement).toMatchObject({ ok: true, reservation: { id: out.reservationId, status: fixture.status } });
    const fresh = postgres(testDatabaseUri, { max: 1, onnotice: () => {}, prepare: false });
    try {
      const rows = await listLearningSpendReservations(fresh, { workspaceId: WS, loopId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: out.reservationId, requestedUsd: 1, reservedUsd: 1,
        runRef, status: fixture.status });
      expect(rows[0].usedUsd).toBeCloseTo(fixture.missing ? 0 : fixture.cost, 6);
      expect(rows[0].settledAt === null).toBe(fixture.missing);
      expect(await listLearningSpendEvents(fresh, { workspaceId: WS, loopId })).toHaveLength(fixture.missing ? 0 : 1);
      expect(await sumOpenReservedUsd(fresh, { workspaceId: WS, loopId })).toBe(fixture.missing ? 1 : 0);
      expect((await getLearningLoop(fresh, { workspaceId: WS, loopId }))?.spentUsd).toBe(0);
    } finally { await fresh.end({ timeout: 5 }); }
  });

  it.each([
    ['unknown', {}, true, 0],
    ['positive', { costUsd: 0.23 }, false, 0.23],
    ['incomplete subtotal', { costUsd: 0.23, costUsdMeasurementMissing: true }, true, 0.23],
  ])('rate pause preserves %s spend in the original reservation', async (_label, usage, incomplete, costUsd) => {
    const loopId = `gym:rate-spend-${randomUUID()}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: 10 });
    const failure = Object.assign(new LlmCallError({ class: 'rate_limited', message: '429', retryAfterMs: 1 }), usage);
    const call = vi.fn<() => Promise<{ costUsd: number; value: string }>>()
      .mockRejectedValueOnce(failure).mockResolvedValue({ costUsd: 0.02, value: 'later success' });
    const sleep = vi.fn(async () => {});
    const out = await runGovernedSpendAttempt({ workspaceId: WS, loopId, attemptKind: 'evaluation',
      requestedUsd: 1, accumulate: false,
      run: async () => await runWithRatePause(call, { now: () => 0, sleep }),
    }, { enabled: async () => true, getSql: async () => sql, log: () => {} });
    expect(out).toMatchObject({ ok: false, reason: 'failed', costUsd });
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    if (out.ok || out.reason !== 'failed') throw new Error('expected original reserved dispatch failure');
    if (incomplete) expect(out).toMatchObject({ costUsdMeasurementMissing: true, settlement: null });
    else expect(out.settlement).toMatchObject({ ok: true, reservation: { status: 'failed', usedUsd: costUsd } });
    const fresh = postgres(testDatabaseUri, { max: 1, onnotice: () => {}, prepare: false });
    try {
      const rows = await listLearningSpendReservations(fresh, { workspaceId: WS, loopId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: out.reservationId, status: incomplete ? 'open' : 'failed',
        requestedUsd: 1, reservedUsd: 1, usedUsd: incomplete ? 0 : costUsd });
      expect(await listLearningSpendEvents(fresh, { workspaceId: WS, loopId })).toHaveLength(incomplete ? 0 : 1);
      expect((await getLearningLoop(fresh, { workspaceId: WS, loopId }))?.spentUsd).toBe(0);
    } finally { await fresh.end({ timeout: 5 }); }
  });

  it('rate pause retries a measured-zero failure and settles its successful receipt', async () => {
    const loopId = `gym:rate-zero-${randomUUID()}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: 10 });
    const failure = Object.assign(new LlmCallError({ class: 'rate_limited', message: '429', retryAfterMs: 1 }), { costUsd: 0 });
    const call = vi.fn<() => Promise<{ costUsd: number; value: string }>>()
      .mockRejectedValueOnce(failure).mockResolvedValue({ costUsd: 0.02, value: 'recovered' });
    const sleep = vi.fn(async () => {});
    const out = await runGovernedSpendAttempt({ workspaceId: WS, loopId, attemptKind: 'evaluation',
      requestedUsd: 1, accumulate: false,
      run: async () => await runWithRatePause(call, { now: () => 0, sleep }),
    }, { enabled: async () => true, getSql: async () => sql, log: () => {} });
    expect(out).toMatchObject({ ok: true, costUsd: 0.02, value: 'recovered',
      settlement: { ok: true, reservation: { status: 'settled', usedUsd: 0.02 } } });
    expect(call).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[1]]);
    if (!out.ok) throw new Error('expected measured-zero recovery');
    const fresh = postgres(testDatabaseUri, { max: 1, onnotice: () => {}, prepare: false });
    try {
      const rows = await listLearningSpendReservations(fresh, { workspaceId: WS, loopId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: out.reservationId, status: 'settled', usedUsd: 0.02 });
      expect(await listLearningSpendEvents(fresh, { workspaceId: WS, loopId })).toHaveLength(1);
      expect((await getLearningLoop(fresh, { workspaceId: WS, loopId }))?.spentUsd).toBe(0);
    } finally { await fresh.end({ timeout: 5 }); }
  });

  it.each([
    ['unknown', {}, true, 0],
    ['positive', { costUsd: 0.23 }, false, 0.23],
    ['incomplete subtotal', { costUsd: 0.23, costUsdMeasurementMissing: true }, true, 0.23],
  ])('native retry preserves %s spend and the same reservation', async (_label, usage, incomplete, costUsd) => {
    const loopId = `gym:retry-spend-${randomUUID()}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: 10 });
    const failure = Object.assign(new Error('fetch failed'), usage);
    const call = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ costUsd: 0.02, value: 'later success' });
    const sleep = vi.fn(async () => {});
    const out = await runGovernedSpendAttempt({ workspaceId: WS, loopId, attemptKind: 'proposer',
      requestedUsd: 1, accumulate: false,
      run: withGymLlmNetworkRetry(async () => await call(), { log: () => {}, sleep }),
    }, { enabled: async () => true, getSql: async () => sql, log: () => {} });
    expect(out).toMatchObject({ ok: false, reason: 'failed', costUsd });
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    if (out.ok || out.reason !== 'failed') throw new Error('expected the first reserved dispatch to fail');
    expect(out.error).toBe(failure.message);
    if (incomplete) expect(out).toMatchObject({ costUsdMeasurementMissing: true, settlement: null });
    else expect(out.settlement).toMatchObject({ ok: true, reservation: { status: 'failed', usedUsd: costUsd } });
    const fresh = postgres(testDatabaseUri, { max: 1, onnotice: () => {}, prepare: false });
    try {
      const rows = await listLearningSpendReservations(fresh, { workspaceId: WS, loopId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: out.reservationId, requestedUsd: 1, reservedUsd: 1,
        status: incomplete ? 'open' : 'failed', usedUsd: incomplete ? 0 : costUsd });
      expect(rows[0]!.settledAt === null).toBe(incomplete);
      expect(await listLearningSpendEvents(fresh, { workspaceId: WS, loopId })).toHaveLength(incomplete ? 0 : 1);
      expect((await getLearningLoop(fresh, { workspaceId: WS, loopId }))?.spentUsd).toBe(0);
      expect((await getLearningSpendPositions(fresh, { workspaceId: WS, loopId })).spend)
        .toMatchObject({ usedUsd: incomplete ? 0 : costUsd, unsettledUsd: incomplete ? 1 : 0 });
    } finally { await fresh.end({ timeout: 5 }); }
  });

  it('native retry may recover after a known-zero failure and settle only the successful receipt', async () => {
    const loopId = `gym:retry-zero-${randomUUID()}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: 10 });
    const call = vi.fn().mockRejectedValueOnce(Object.assign(new Error('ECONNREFUSED'), { costUsd: 0 }))
      .mockResolvedValue({ costUsd: 0.02, value: 'recovered' });
    const sleep = vi.fn(async () => {});
    const out = await runGovernedSpendAttempt({ workspaceId: WS, loopId, attemptKind: 'proposer',
      requestedUsd: 1, accumulate: false,
      run: withGymLlmNetworkRetry(async () => await call(), { log: () => {}, sleep }),
    }, { enabled: async () => true, getSql: async () => sql, log: () => {} });
    expect(out).toMatchObject({ ok: true, value: 'recovered', costUsd: 0.02,
      settlement: { ok: true, reservation: { status: 'settled', usedUsd: 0.02 } } });
    if (!out.ok) throw new Error('expected known-zero retry recovery');
    expect(call).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[2_000]]);
    const fresh = postgres(testDatabaseUri, { max: 1, onnotice: () => {}, prepare: false });
    try {
      const rows = await listLearningSpendReservations(fresh, { workspaceId: WS, loopId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: out.reservationId, status: 'settled', usedUsd: 0.02 });
      expect(await listLearningSpendEvents(fresh, { workspaceId: WS, loopId })).toHaveLength(1);
      expect((await getLearningLoop(fresh, { workspaceId: WS, loopId }))?.spentUsd).toBe(0);
    } finally { await fresh.end({ timeout: 5 }); }
  });

  it.each([
    { label: 'absent', usage: {}, costUsd: 0, incomplete: true },
    { label: 'NaN', usage: { costUsd: NaN }, costUsd: 0, incomplete: true },
    { label: 'infinite', usage: { costUsd: Infinity }, costUsd: 0, incomplete: true },
    { label: 'negative', usage: { costUsd: -1 }, costUsd: 0, incomplete: true },
    { label: 'partial', usage: { costUsd: 0.42, unreportedFrames: 1 }, costUsd: 0.42, incomplete: true },
    { label: 'zero', usage: { costUsd: 0 }, costUsd: 0, incomplete: false },
    { label: 'positive', usage: { costUsd: 0.42, unreportedFrames: 0 }, costUsd: 0.42, incomplete: false },
  ])('successful transport -> native proposer -> SQL keeps $label usage honest', async ({ usage, costUsd, incomplete }) => {
    const loopId = `gym:proposer-success-${randomUUID()}`;
    const runRef = `native-proposer:${randomUUID()}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: 10 });
    const unexpected = async () => { throw new Error('proposer fixture must not evaluate'); };
    const native = buildLoopDeps({ gymSql: sql, ports: {} as never, abDeps: {} as AbDeps, judgeCall: unexpected,
      proposerCall: llmCall, proposerModel: 'claude-sonnet-4-6', tasks: [],
      baseline: { variantId: 'baseline', overlay: { promptOverrides: {} } },
      harnessCommit: 'controlled', workspaceId: WS, scratchRoot: '/unused-proposer-fixture',
      timeoutMs: 100, pollIntervalMs: 1, maxDistillChars: 100 });
    successfulUsage.value = usage;
    try {
      const out = await runGovernedSpendAttempt({ workspaceId: WS, loopId, attemptKind: 'proposer',
        requestedUsd: 1, runRef, accumulate: false, run: async () => {
          const value = await native.propose({ promptOverrides: {} }, [], '');
          return { costUsd: value.costUsd, costUsdMeasurementMissing: value.costUsdMeasurementMissing, value };
        } }, { enabled: async () => true, getSql: async () => sql, log: () => {} });
      if (!out.ok || !out.reservationId) throw new Error('expected reserved successful proposal');
      expect(out.value).toMatchObject({ overlay: { promptOverrides: { worker: '# worker v2' } }, rationale: 'r' });
      expect(out.costUsd).toBe(costUsd);
      if (incomplete) expect(out).toMatchObject({ costUsdMeasurementMissing: true, settlement: null });
      else expect(out.settlement).toMatchObject({ ok: true, reservation: { status: 'settled', usedUsd: costUsd } });
      const fresh = postgres(testDatabaseUri, { max: 1, onnotice: () => {}, prepare: false });
      try {
        const rows = await listLearningSpendReservations(fresh, { workspaceId: WS, loopId });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: out.reservationId, requestedUsd: 1, reservedUsd: 1, runRef,
          status: incomplete ? 'open' : 'settled', usedUsd: incomplete ? 0 : costUsd });
        expect(rows[0]!.settledAt === null).toBe(incomplete);
        expect(await listLearningSpendEvents(fresh, { workspaceId: WS, loopId }))
          .toHaveLength(incomplete || costUsd === 0 ? 0 : 1);
        expect((await getLearningSpendPositions(fresh, { workspaceId: WS, loopId })).spend)
          .toMatchObject({ unsettledUsd: incomplete ? 1 : 0, usedUsd: incomplete ? 0 : costUsd });
        expect((await getLearningLoop(fresh, { workspaceId: WS, loopId }))?.spentUsd).toBe(0);
      } finally { await fresh.end({ timeout: 5 }); }
    } finally { successfulUsage.value = undefined; }
  });

  it.each([
    { label: 'absent', usage: {}, costUsd: 0, incomplete: true },
    { label: 'partial', usage: { costUsd: 0.42, unreportedFrames: 1 }, costUsd: 0.42, incomplete: true },
    { label: 'zero', usage: { costUsd: 0 }, costUsd: 0, incomplete: false },
    { label: 'positive', usage: { costUsd: 0.42 }, costUsd: 0.42, incomplete: false },
  ])('native proposer $label failure retains its actual SQL reservation disposition', async ({ usage, costUsd, incomplete }) => {
    const loopId = `gym:proposer-failure-${randomUUID()}`;
    const runRef = `native-proposer:${randomUUID()}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: 10 });
    const unexpected = async () => { throw new Error('proposer fixture must not evaluate'); };
    const abDeps: AbDeps = {
      store: { upsertVariant: unexpected, upsertTask: unexpected, startRun: unexpected,
        finishRun: unexpected, recordScore: unexpected, comparison: unexpected },
      runPipeline: unexpected, collectAndDistill: unexpected, llmCall: unexpected,
      newRunId: () => { throw new Error('proposer fixture must not allocate an evaluation'); }, now: () => 0,
    };
    const native = buildLoopDeps({ gymSql: sql, ports: {} as never, abDeps, judgeCall: unexpected,
      proposerCall: async () => { throw Object.assign(new Error('native proposer failed after dispatch'), usage); },
      proposerModel: 'controlled', tasks: [], baseline: { variantId: 'baseline', overlay: { promptOverrides: {} } },
      harnessCommit: 'controlled', workspaceId: WS, scratchRoot: '/unused-proposer-fixture',
      timeoutMs: 100, pollIntervalMs: 1, maxDistillChars: 100 });
    const out = await runGovernedSpendAttempt({ workspaceId: WS, loopId, attemptKind: 'proposer',
      requestedUsd: 1, runRef, accumulate: false, run: async () => {
        const value = await native.propose({ promptOverrides: {} }, [], '');
        return { costUsd: value.costUsd, value };
      } }, { enabled: async () => true, getSql: async () => sql, log: () => {} });
    if (out.ok || out.reason !== 'failed' || !out.reservationId) throw new Error('expected reserved proposer failure');
    expect(out.costUsd).toBe(costUsd);
    if (incomplete) expect(out).toMatchObject({ costUsdMeasurementMissing: true, settlement: null });
    else expect(out.settlement).toMatchObject({ ok: true, reservation: { status: 'failed', usedUsd: costUsd } });
    const fresh = postgres(testDatabaseUri, { max: 1, onnotice: () => {}, prepare: false });
    try {
      const rows = await listLearningSpendReservations(fresh, { workspaceId: WS, loopId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: out.reservationId, requestedUsd: 1, reservedUsd: 1, runRef,
        status: incomplete ? 'open' : 'failed', usedUsd: incomplete ? 0 : costUsd });
      expect(rows[0]!.settledAt === null).toBe(incomplete);
      expect(await listLearningSpendEvents(fresh, { workspaceId: WS, loopId }))
        .toHaveLength(incomplete || costUsd === 0 ? 0 : 1);
      expect((await getLearningSpendPositions(fresh, { workspaceId: WS, loopId })).spend)
        .toMatchObject({ unsettledUsd: incomplete ? 1 : 0, usedUsd: incomplete ? 0 : costUsd });
      expect((await getLearningLoop(fresh, { workspaceId: WS, loopId }))?.spentUsd).toBe(0);
    } finally { await fresh.end({ timeout: 5 }); }
  });

  it.each([0, 0.42])('retains OPEN reservations for incomplete usage with known subtotal $%s', async costUsd => {
    const loopId = `gym:unknown-usage-${randomUUID()}`;
    const runRef = `incomplete-pipeline:${randomUUID()}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: 10 });
    const native = buildLoopDeps({ gymSql: sql, ports: {} as never,
      judgeCall: async () => { throw new Error('must not judge incomplete pipeline usage'); },
      proposerCall: async () => { throw new Error('must not propose'); },
      proposerModel: 'controlled', tasks: [{ taskId: 'native-task', pool: 'train', repoUrl: 'r',
        repoCommit: 'c', spec: 's', intent: 'i', projectContext: 'p' }],
      baseline: { variantId: 'baseline', overlay: { promptOverrides: {} } },
      harnessCommit: 'controlled', workspaceId: WS, scratchRoot: '/unused-native-fixture',
      timeoutMs: 100, pollIntervalMs: 1, maxDistillChars: 100,
      abDeps: {
        store: {
          upsertVariant: async () => {}, upsertTask: async () => {},
          startRun: async () => { throw new Error('must not start an incompletely priced run'); },
          finishRun: async () => { throw new Error('must not finish an incompletely priced run'); },
          recordScore: async () => { throw new Error('must not score incomplete pipeline usage'); },
          comparison: async () => { throw new Error('must not compare incomplete pipeline usage'); },
        },
        runPipeline: async () => ({ harnessSlug: 'native-fixture', clonePath: '/unused-native-fixture',
          workflowID: 'native-workflow', outcome: 'completed', pipelineUsd: costUsd,
          pipelineSpend: { knownUsd: costUsd, providerUsd: costUsd, estimatedUsd: 0,
            complete: false, measured: false, coverageBasis: 'retained-run-output-and-usage-samples',
            missingRunIds: ['validator'], samples: [] } }),
        collectAndDistill: async () => { throw new Error('must not distill incomplete pipeline usage'); },
        llmCall: async () => { throw new Error('must not call a judge for incomplete pipeline usage'); },
        newRunId: () => runRef,
        now: () => 0,
      } satisfies AbDeps,
    });
    const out = await runGovernedSpendAttempt({ workspaceId: WS, loopId, attemptKind: 'evaluation',
      requestedUsd: 1, runRef, accumulate: false, run: async () => {
        const value = await native.evaluate('baseline', { promptOverrides: {} });
        return { value, costUsd: value.costUsd };
      },
    }, { enabled: async () => true, getSql: async () => sql, log: () => {} });
    if (out.ok || out.reason !== 'failed' || !out.reservationId) throw new Error('expected a reserved failed attempt');
    expect(out).toMatchObject({ costUsd, costUsdMeasurementMissing: true, settlement: null });
    expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId })).toMatchObject([
      { id: out.reservationId, status: 'open', usedUsd: 0, settledAt: null, runRef },
    ]);
    expect(await listLearningSpendEvents(sql, { workspaceId: WS, loopId })).toEqual([]);
    expect((await getLearningSpendPositions(sql, { workspaceId: WS, loopId })).spend)
      .toMatchObject({ requestedUsd: 1, reservedUsd: 1, usedUsd: 0, unsettledUsd: 1 });
    expect((await getLearningLoop(sql, { workspaceId: WS, loopId }))?.spentUsd).toBe(0);
    const fresh = postgres(testDatabaseUri, { max: 1, onnotice: () => {}, prepare: false });
    try {
      expect(await sumOpenReservedUsd(fresh, { workspaceId: WS, loopId })).toBe(1);
      expect(await listLearningSpendReservations(fresh, { workspaceId: WS, loopId })).toMatchObject([
        { id: out.reservationId, status: 'open', settledAt: null },
      ]);
    } finally { await fresh.end({ timeout: 5 }); }
  });

  it('leaves actual LLM failures with absent usage OPEN rather than declaring zero spend', async () => {
    failureUsage.costUsd = undefined;
    const loopId = `gym:absent-llm-usage-${randomUUID()}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: 10 });
    const out = await runGovernedSpendAttempt({ workspaceId: WS, loopId, attemptKind: 'evaluation',
      requestedUsd: 1, run: async () => {
        const value = await llmCall({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'missing usage fixture' }] });
        return { costUsd: value.costUsd, value };
      },
    }, { enabled: async () => true, getSql: async () => sql, log: () => {} });
    expect(out).toMatchObject({ ok: false, reason: 'failed', costUsdMeasurementMissing: true, settlement: null });
    expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId })).toMatchObject([
      { status: 'open', settledAt: null },
    ]);
    expect(await listLearningSpendEvents(sql, { workspaceId: WS, loopId })).toEqual([]);
  });

  it.each([0, 0.42])('persists actual LLM failure spend $%s without accumulating a mirror twice', async costUsd => {
    failureUsage.costUsd = costUsd;
    const loopId = `gym:failure-receipt-${randomUUID()}`;
    const runRef = `llm-failure:${randomUUID()}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: 10 });
    const out = await runGovernedSpendAttempt({ workspaceId: WS, loopId, attemptKind: 'evaluation',
      requestedUsd: 1, runRef, accumulate: false, run: async () => {
        const value = await llmCall({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'synthetic failure fixture' }] });
        return { costUsd: value.costUsd, value };
      },
    }, { enabled: async () => true, getSql: async () => sql, log: () => {} });
    if (out.ok || out.reason !== 'failed' || !out.reservationId) throw new Error('expected a reserved failed attempt');
    const rows = await listLearningSpendReservations(sql, { workspaceId: WS, loopId });
    const events = await listLearningSpendEvents(sql, { workspaceId: WS, loopId });
    expect(out).toMatchObject({ costUsd, settlement: { ok: true, reservation: { status: 'failed', usedUsd: costUsd } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: out.reservationId, status: 'failed', usedUsd: costUsd, runRef });
    expect(out.settlement).toMatchObject({ event: costUsd === 0 ? null : events[0] });
    expect(events).toHaveLength(costUsd === 0 ? 0 : 1);
    expect((await getLearningLoop(sql, { workspaceId: WS, loopId }))?.spentUsd).toBe(0);
  });

  it.each([
    { label: 'completed', costUsd: 0.4, status: 'settled' },
    { label: 'partial', costUsd: 0.1, status: 'settled' },
    { label: 'cancelled', costUsd: 0, status: 'cancelled' },
    { label: 'failed', costUsd: 0.02, status: 'failed' },
  ])('returns the actual $label reservation and charge event', async ({ label, costUsd, status }) => {
    const loopId = `frontier:receipt-${randomUUID()}`;
    const runRef = `receipt-run:${randomUUID()}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: 10 });
    const out = await runGovernedSpendAttempt({ workspaceId: WS, loopId, attemptKind: 'evaluation',
      requestedUsd: 1, runRef, run: async () => {
        if (label === 'failed') throw Object.assign(new Error('partial evaluation failed'), { costUsd });
        return { costUsd, value: label, cancelled: label === 'cancelled' };
      },
    }, { enabled: async () => true, getSql: async () => sql, log: () => {} });
    if ((!out.ok && out.reason !== 'failed') || !out.reservationId) throw new Error('attempt was not reserved');
    const rows = await listLearningSpendReservations(sql, { workspaceId: WS, loopId });
    const events = await listLearningSpendEvents(sql, { workspaceId: WS, loopId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: out.reservationId, requestedUsd: 1, reservedUsd: 1,
      usedUsd: costUsd, status, runRef });
    expect(out.settlement).toMatchObject({ ok: true, reservation: rows[0],
      event: costUsd === 0 ? null : events[0] });
    expect(events).toHaveLength(costUsd === 0 ? 0 : 1);
    expect(rows[0].settledAt).not.toBeNull();
    expect((await getLearningSpendPositions(sql, { workspaceId: WS, loopId })).spend)
      .toMatchObject({ requestedUsd: 1, reservedUsd: 1, usedUsd: costUsd, unsettledUsd: 0 });
  });
});

describe('spend reservation + settlement — every attempt closes', () => {
  const LOOP = 'frontier:reserve-test';

  it.each(['lifetime', 'per-cycle', 'exact'] as const)(
    'refuses a paused registered pot for %s admission despite caller pot attribution', async mode => {
      const loopId = `gym:paused-pot-${randomUUID()}`;
      const potSlug = `paused-pot-${randomUUID()}`;
      const binding = 'e'.repeat(64);
      await registerLearningLoop(sql, { workspaceId: WS, loopId, potSlug, budgetUsd: 10,
        budgetKind: mode === 'per-cycle' ? 'per-cycle' : 'lifetime',
        ...(mode === 'exact' ? { meta: { reservationBinding: binding } } : {}),
      });
      await setPotLearningScope(sql, { workspaceId: WS, potSlugs: [potSlug], enabled: false, setBy: 'su-test' });
      const request = { workspaceId: WS, loopId, requestedUsd: 1, potSlug: `other-${randomUUID()}`,
        ...(mode === 'exact' ? { exact: { reservationId: randomUUID(), binding, expectedBudgetUsd: 10 } } : {}),
      };
      expect(await reserveLearningSpend(sql, request)).toMatchObject({ ok: false, reason: 'pot-disabled' });
      expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId })).toEqual([]);
      expect(await listLearningSpendEvents(sql, { workspaceId: WS, loopId })).toEqual([]);
      expect(await getLearningLoop(sql, { workspaceId: WS, loopId })).toMatchObject({ enabled: true, budgetUsd: 10, potSlug });

      await setPotLearningScope(sql, { workspaceId: WS, potSlugs: [potSlug], enabled: true, setBy: 'su-test' });
      expect(await reserveLearningSpend(sql, request)).toMatchObject({ ok: true });
    },
  );

  it.each(['lifetime', 'per-cycle', 'exact'] as const)(
    'does not dispatch a %s attempt when its registered pot pauses after preflight', async mode => {
      const loopId = `gym:pot-revoked-preflight-${randomUUID()}`;
      const potSlug = `revoked-pot-${randomUUID()}`;
      const binding = 'f'.repeat(64);
      await registerLearningLoop(sql, { workspaceId: WS, loopId, potSlug, budgetUsd: 10,
        budgetKind: mode === 'per-cycle' ? 'per-cycle' : 'lifetime',
        ...(mode === 'exact' ? { meta: { reservationBinding: binding } } : {}),
      });
      expect(await governorCheck(sql, { workspaceId: WS, loopId })).toMatchObject({ allow: true });
      const run = vi.fn(async () => ({ costUsd: 0, value: 'dispatched' }));
      const settle = vi.fn(settleLearningSpend);
      const out = await runGovernedSpendAttempt({ workspaceId: WS, loopId, attemptKind: 'evaluation',
        requestedUsd: 1, run, accumulate: mode !== 'exact' ? false : true,
        ...(mode === 'exact' ? { exact: { reservationId: randomUUID(), binding, expectedBudgetUsd: 10 } } : {}),
      }, { enabled: async () => true, getSql: async () => {
        await setPotLearningScope(sql, { workspaceId: WS, potSlugs: [potSlug], enabled: false, setBy: 'su-test' });
        return sql;
      }, log: () => {}, settle });
      expect(out).toMatchObject({ ok: false, reason: 'refused', refusal: 'pot-disabled' });
      expect(run).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
      expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId })).toEqual([]);
      expect(await listLearningSpendEvents(sql, { workspaceId: WS, loopId })).toEqual([]);
    },
  );

  it('also refuses a zero-cost attempt for a paused registered pot', async () => {
    const loopId = `gym:paused-pot-zero-${randomUUID()}`;
    const potSlug = `zero-pot-${randomUUID()}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, potSlug, budgetKind: 'per-cycle', budgetUsd: 10 });
    await setPotLearningScope(sql, { workspaceId: WS, potSlugs: [potSlug], enabled: false, setBy: 'su-test' });
    expect(await reserveLearningSpend(sql, { workspaceId: WS, loopId, requestedUsd: 0 }))
      .toMatchObject({ ok: false, reason: 'pot-disabled' });
    expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId })).toEqual([]);
  });

  it.each(['lifetime', 'per-cycle', 'exact'] as const)(
    'preserves pre-migration pot fallback in a %s reservation transaction', async mode => {
      const loopId = `gym:pot-premigration-${randomUUID()}`;
      const binding = 'a'.repeat(64);
      await registerLearningLoop(sql, { workspaceId: WS, loopId, potSlug: 'not-migrated', budgetUsd: 10,
        budgetKind: mode === 'per-cycle' ? 'per-cycle' : 'lifetime',
        ...(mode === 'exact' ? { meta: { reservationBinding: binding } } : {}),
      });
      // This database belongs to this file; restore the relation even when
      // reserveLearningSpend rolls back its own failed transaction.
      await sql`ALTER TABLE harness_shared.learning_pot_scope RENAME TO learning_pot_scope_unavailable`;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(await reserveLearningSpend(sql, { workspaceId: WS, loopId, requestedUsd: 1,
          ...(mode === 'exact' ? { exact: { reservationId: randomUUID(), binding, expectedBudgetUsd: 10 } } : {}),
        })).toMatchObject({ ok: true });
        expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId })).toHaveLength(1);
        if (mode === 'lifetime') expect(warn).toHaveBeenCalledWith(expect.stringContaining('is answering fail-OPEN'));
        expect(warn.mock.calls.every(([message]) => String(message).includes('[learning-pot-scope]'))).toBe(true);
      } finally {
        warn.mockRestore();
        await sql`ALTER TABLE harness_shared.learning_pot_scope_unavailable RENAME TO learning_pot_scope`;
      }
    },
  );

  it.each([null, 'absent', 'other'] as const)('preserves %s pot authority when a different pot is paused', async potMode => {
    const loopId = `gym:unpaused-pot-${randomUUID()}`;
    const pausedPot = `unrelated-paused-${randomUUID()}`;
    await setPotLearningScope(sql, { workspaceId: WS, potSlugs: [pausedPot], enabled: false, setBy: 'su-test' });
    const potSlug = potMode === null ? null : `${potMode}-pot-${randomUUID()}`;
    if (potMode === 'other') {
      await setPotLearningScope(sql, { workspaceId: WS, potSlugs: [potSlug!], enabled: true, setBy: 'su-test' });
    }
    await registerLearningLoop(sql, { workspaceId: WS, loopId, potSlug, budgetKind: 'per-cycle', budgetUsd: 10 });
    expect(await reserveLearningSpend(sql, { workspaceId: WS, loopId, requestedUsd: 1 })).toMatchObject({ ok: true });
  });

  it.each([
    ['lifetime', 0], ['lifetime', 1], ['per-cycle', 0], ['per-cycle', 1],
  ] as const)('refuses disabled %s registrations before reserving $%s', async (budgetKind, requestedUsd) => {
    const loopId = `gym:disabled-reservation-${randomUUID()}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind, budgetUsd: 10, enabled: false });
    const request = { workspaceId: WS, loopId, attemptKind: 'proposer' as const, requestedUsd };
    const refusal = await reserveLearningSpend(sql, request);
    expect(refusal).toMatchObject({ ok: false, reason: 'disabled' });
    expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId })).toEqual([]);
    expect(await listLearningSpendEvents(sql, { workspaceId: WS, loopId })).toEqual([]);

    // The same budget and request become admissible when authority is restored.
    await registerLearningLoop(sql, { workspaceId: WS, loopId, enabled: true });
    expect(await reserveLearningSpend(sql, request)).toMatchObject({ ok: true,
      reservation: { workspaceId: WS, loopId, requestedUsd, reservedUsd: requestedUsd, status: 'open' } });
  });

  it.each(['lifetime', 'per-cycle'] as const)(
    'does not dispatch a %s attempt disabled after successful preflight', async budgetKind => {
      const loopId = `gym:revoked-preflight-${randomUUID()}`;
      await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind, budgetUsd: 10, enabled: true });
      expect(await governorCheck(sql, { workspaceId: WS, loopId })).toMatchObject({ allow: true });
      const run = vi.fn(async () => ({ costUsd: 0, value: 'dispatched' }));
      const settle = vi.fn(settleLearningSpend);
      const out = await runGovernedSpendAttempt({ workspaceId: WS, loopId, attemptKind: 'evaluation',
        requestedUsd: 1, accumulate: false, run,
      }, { enabled: async () => true, getSql: async () => {
        // Revoke while the helper awaits its pool, before the issuer reads the
        // registration under FOR UPDATE. An earlier allow cannot authorize it.
        await registerLearningLoop(sql, { workspaceId: WS, loopId, enabled: false });
        return sql;
      }, log: () => {}, settle });
      expect(out).toMatchObject({ ok: false, reason: 'refused', refusal: 'disabled' });
      expect(run).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
      expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId })).toEqual([]);
      expect(await listLearningSpendEvents(sql, { workspaceId: WS, loopId })).toEqual([]);
      expect((await getLearningLoop(sql, { workspaceId: WS, loopId }))?.spentUsd).toBe(0);
    },
  );

  it.each(['status', 'workspaceId', 'loopId', 'reservedUsd'] as const)(
    'does not dispatch or settle a substituted %s receipt from an actual reservation', async field => {
      const loopId = `gym:invalid-dispatch-grant-${randomUUID()}`;
      await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: 10 });
      let reservationId: string | undefined;
      let ran = false;
      const settle = vi.fn(settleLearningSpend);
      const out = await runGovernedSpendAttempt({ workspaceId: WS, loopId, attemptKind: 'proposer',
        requestedUsd: 1, accumulate: false, run: async () => {
          ran = true;
          return { costUsd: 0, value: null };
        },
      }, { enabled: async () => true, getSql: async () => sql, log: () => {}, settle,
        reserve: async (client, request) => {
          const admitted = await reserveLearningSpend(client, request);
          if (!admitted.ok) return admitted;
          reservationId = admitted.reservation.id;
          return { ...admitted, reservation: { ...admitted.reservation,
            [field]: field === 'reservedUsd' ? 2 : field === 'status' ? 'settled' : 'foreign',
          } };
        },
      });
      expect(out).toMatchObject({ ok: false, reason: 'failed', costUsd: 0,
        reservationId: null, settlement: null, error: 'governor reservation receipt does not match request' });
      expect(ran).toBe(false);
      expect(settle).not.toHaveBeenCalled();
      const rows = await listLearningSpendReservations(sql, { workspaceId: WS, loopId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: reservationId, workspaceId: WS, loopId,
        requestedUsd: 1, reservedUsd: 1, usedUsd: 0, status: 'open', settledAt: null });
      expect(await listLearningSpendEvents(sql, { workspaceId: WS, loopId })).toEqual([]);
      expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId })).toBe(1);
    },
  );

  it.each([10, LEARNING_GOVERNOR_BUDGET_FLOOR_USD + 0.25, 0])('binds dispatch to the persisted reservation before work runs (budget $%s)', async budgetUsd => {
    const loopId = `gym:dispatch-grant-${randomUUID()}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd });
    const fresh = postgres(testDatabaseUri, { max: 1, onnotice: () => {}, prepare: false });
    const seenIds: string[] = [];
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const requestedUsd = budgetUsd === 0 ? 0 : 1;
        const expectedReservedUsd = Math.min(requestedUsd, Math.max(0, budgetUsd - LEARNING_GOVERNOR_BUDGET_FLOOR_USD));
        const runRef = `native-dispatch:${randomUUID()}`;
        const out = await runGovernedSpendAttempt({ workspaceId: WS, loopId, attemptKind: 'proposer',
          requestedUsd, runRef, accumulate: false, run: async grant => {
            const rows = await listLearningSpendReservations(fresh, { workspaceId: WS, loopId });
            const row = rows.find(r => r.id === grant.reservationId);
            expect(row).toMatchObject({ id: grant.reservationId, workspaceId: WS, loopId,
              runRef, status: 'open', settledAt: null, reservedUsd: grant.reservedUsd });
            expect(grant.reservedUsd).toBe(expectedReservedUsd);
            expect(grant.clamped).toBe(expectedReservedUsd < requestedUsd);
            expect(Object.isFrozen(grant)).toBe(true);
            seenIds.push(grant.reservationId);
            return { costUsd: 0, value: grant.reservationId };
          },
        }, { enabled: async () => true, getSql: async () => sql, log: () => {} });
        expect(out).toMatchObject({ ok: true, value: seenIds[attempt], reservationId: seenIds[attempt],
          settlement: { ok: true, reservation: { id: seenIds[attempt], status: 'settled', usedUsd: 0 } } });
      }
      expect(seenIds).toHaveLength(2);
      expect(new Set(seenIds).size).toBe(2);
      expect(await listLearningSpendEvents(fresh, { workspaceId: WS, loopId })).toEqual([]);
      expect(await sumOpenReservedUsd(fresh, { workspaceId: WS, loopId })).toBe(0);
      expect((await getLearningLoop(fresh, { workspaceId: WS, loopId }))?.spentUsd).toBe(0);
    } finally { await fresh.end({ timeout: 5 }); }
  });

  beforeAll(async () => {
    await registerLearningLoop(sql, {
      workspaceId: WS,
      loopId: LOOP,
      budgetKind: 'lifetime',
      budgetUsd: 10,
    });
  });

  it('opens an attempt, and the reservation is immediately visible as unsettled', async () => {
    const res = await reserveLearningSpend(sql, {
      workspaceId: WS,
      loopId: LOOP,
      attemptKind: 'proposer',
      requestedUsd: 2,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.reservation).toMatchObject({ reservedUsd: 2, usedUsd: 0, status: 'open' });
    expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId: LOOP })).toBeCloseTo(2, 6);

    // Settling releases it from the open pool and charges the real cost.
    const settled = await settleLearningSpend(sql, {
      workspaceId: WS,
      reservationId: res.reservation.id,
      disposition: 'used',
      usedUsd: 0.5,
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.reservation).toMatchObject({ status: 'settled', usedUsd: 0.5 });
    expect(settled.releasedUsd).toBeCloseTo(1.5, 6);
    expect(settled.event?.costUsd).toBeCloseTo(0.5, 6);
    expect(await sumOpenReservedUsd(sql, { workspaceId: WS, loopId: LOOP })).toBeCloseTo(0, 6);
    // The charge accumulated onto the registration, as recordLearningSpend does.
    expect((await getLearningLoop(sql, { workspaceId: WS, loopId: LOOP }))!.spentUsd).toBeCloseTo(0.5, 6);
  });

  it('a CANCELLED attempt closes with no charge and no spend event', async () => {
    const before = (await listLearningSpendEvents(sql, { workspaceId: WS, loopId: LOOP })).length;
    const res = await reserveLearningSpend(sql, { workspaceId: WS, loopId: LOOP, requestedUsd: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const settled = await settleLearningSpend(sql, {
      workspaceId: WS,
      reservationId: res.reservation.id,
      disposition: 'cancelled',
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.reservation.status).toBe('cancelled');
    expect(settled.event).toBeNull();
    // The reservation row IS the record that the attempt happened and cost
    // nothing — exactly what the `costUsd > 0` guards used to drop.
    expect((await listLearningSpendEvents(sql, { workspaceId: WS, loopId: LOOP })).length).toBe(before);
    const cancelled = await listLearningSpendReservations(sql, {
      workspaceId: WS,
      loopId: LOOP,
      status: 'cancelled',
    });
    expect(cancelled.map((r) => r.id)).toContain(res.reservation.id);
  });

  it('a FAILED attempt still charges what it burned before throwing', async () => {
    const res = await reserveLearningSpend(sql, { workspaceId: WS, loopId: LOOP, requestedUsd: 1 });
    if (!res.ok) throw new Error('reservation refused');
    const settled = await settleLearningSpend(sql, {
      workspaceId: WS,
      reservationId: res.reservation.id,
      disposition: 'failed',
      usedUsd: 0.25,
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.reservation).toMatchObject({ status: 'failed', usedUsd: 0.25 });
    // The charge is linked back to the attempt that made it.
    expect(settled.event?.costUsd).toBeCloseTo(0.25, 6);
  });

  it('settling twice is refused rather than double-charging', async () => {
    const res = await reserveLearningSpend(sql, { workspaceId: WS, loopId: LOOP, requestedUsd: 1 });
    if (!res.ok) throw new Error('reservation refused');
    const spentBefore = (await getLearningLoop(sql, { workspaceId: WS, loopId: LOOP }))!.spentUsd;
    await settleLearningSpend(sql, {
      workspaceId: WS,
      reservationId: res.reservation.id,
      disposition: 'used',
      usedUsd: 0.3,
    });
    const again = await settleLearningSpend(sql, {
      workspaceId: WS,
      reservationId: res.reservation.id,
      disposition: 'used',
      usedUsd: 0.3,
    });
    expect(again).toMatchObject({ ok: false, reason: 'already-settled' });
    expect((await getLearningLoop(sql, { workspaceId: WS, loopId: LOOP }))!.spentUsd).toBeCloseTo(
      spentBefore + 0.3,
      6,
    );
  });

  it('governorCheck counts OPEN reservations as spend — the concurrency guarantee', async () => {
    const loopId = 'frontier:concurrency-test';
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: 4 });
    const before = await governorCheck(sql, { workspaceId: WS, loopId });
    expect(before).toMatchObject({ allow: true });
    expect(before.remainingUsd).toBeCloseTo(4, 6);

    // One attempt in flight takes the budget down to the floor: the gate now
    // refuses a SECOND attempt even though nothing has been charged yet.
    const res = await reserveLearningSpend(sql, { workspaceId: WS, loopId, requestedUsd: 4 });
    if (!res.ok) throw new Error('reservation refused');
    expect(res.reservation.reservedUsd).toBeCloseTo(3.5, 6); // 4 − 0.5 floor
    const during = await governorCheck(sql, { workspaceId: WS, loopId });
    expect(during).toMatchObject({ allow: false, reason: 'exhausted' });
    const second = await reserveLearningSpend(sql, { workspaceId: WS, loopId, requestedUsd: 1 });
    expect(second).toMatchObject({ ok: false, reason: 'no-headroom' });

    // Settling for less than reserved returns the remainder to headroom.
    await settleLearningSpend(sql, {
      workspaceId: WS,
      reservationId: res.reservation.id,
      disposition: 'used',
      usedUsd: 0.5,
    });
    const after = await governorCheck(sql, { workspaceId: WS, loopId });
    expect(after).toMatchObject({ allow: true });
    expect(after.remainingUsd).toBeCloseTo(3.5, 6);
  });

  it('refuses fail-closed on an unbudgeted loop', async () => {
    await registerLearningLoop(sql, { workspaceId: WS, loopId: 'frontier:no-budget', budgetUsd: null });
    expect(
      await reserveLearningSpend(sql, {
        workspaceId: WS,
        loopId: 'frontier:no-budget',
        requestedUsd: 1,
      }),
    ).toMatchObject({ ok: false, reason: 'unbudgeted', headroomUsd: null });
  });

  it('exposes requested, reserved, used and unsettled SEPARATELY', async () => {
    const loopId = 'frontier:positions-test';
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: 20 });
    const done = await reserveLearningSpend(sql, { workspaceId: WS, loopId, requestedUsd: 5 });
    if (!done.ok) throw new Error('reservation refused');
    await settleLearningSpend(sql, {
      workspaceId: WS,
      reservationId: done.reservation.id,
      disposition: 'used',
      usedUsd: 2,
    });
    const open = await reserveLearningSpend(sql, { workspaceId: WS, loopId, requestedUsd: 3 });
    if (!open.ok) throw new Error('reservation refused');

    const { positions, spend } = await getLearningSpendPositions(sql, { workspaceId: WS, loopId });
    expect(positions).toMatchObject({
      requestedUsd: 8,
      reservedUsd: 8,
      usedUsd: 2,
      unsettledUsd: 3,
      openAttempts: 1,
    });
    // The same four numbers, in the shape a learning contract embeds.
    expect(spend).toMatchObject({ requestedUsd: 8, reservedUsd: 8, usedUsd: 2, unsettledUsd: 3 });
    expect(spend.settledAt).toBeUndefined(); // work still in flight ⇒ not settled
  });
});
