/** Benchmark admission reuses the governor's durable reservation ledger.
 * Real PostgreSQL proves serialization and recovery; no inference is sent. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { registerLearningLoop, reserveLearningSpend, settleLearningSpend,
  listLearningSpendReservations, getLearningSpendPositions, cycleReservationRunRef,
  recordLearningSpendAttemptResult,
  type LearningReservationResourceBudget } from '../learning-governor/store';
import type { OrgSql } from './reproducibility/db';
import { currentBenchAssignmentId, currentBenchGatewayController, currentBenchProviderAuthenticator } from './current-su';
import { makeBearerCredentialResolver } from '../inference-gateway/credential-store';
import { currentProtocolFixture } from './reproducibility/_protocol-test-fixture';
import { processMonotonicClock } from '../process-monotonic-clock';
import type { GatewayCarryTrialAttempt, GatewayCarryTrialAttemptResult } from '../inference-gateway/gateway';

const WS = 'benchmark-budget-private-test';
const manifest = 'a'.repeat(64);
let db: FreshPgDb;
let sql: OrgSql;
beforeAll(async () => {
  db = await createFreshPgDb('benchbudget'); sql = db.sql as unknown as OrgSql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  for (const name of ['244-learning-governor.sql', '1116-learning-spend-reservations.sql', '1224-learning-reservation-resources.sql']) {
    const body = readFileSync(new URL(`../../../../libs/papercusp/libs/db/sql/${name}`, import.meta.url), 'utf8')
      .split('\n').filter(line => !/\bGRANT\b|^\s*\\/.test(line)).join('\n');
    await sql.unsafe(body);
  }
  await sql.unsafe('ALTER TABLE harness_shared.learning_governor_loops ADD COLUMN pot_slug text');
  await sql.unsafe('ALTER TABLE harness_shared.learning_spend_events ADD COLUMN pot_slug text');
  await sql.unsafe('CREATE TABLE harness_shared.operator_account_pool (workspace_id text PRIMARY KEY, payload jsonb NOT NULL)');
}, 120_000);
afterAll(async () => { await db?.cleanup(); });

const caps = (overrides: Partial<LearningReservationResourceBudget> = {}): LearningReservationResourceBudget => ({
  inputTokens: 1000, outputTokens: 1000, requestsPerArm: 50,
  armIds: ['control:t1:1', 'treatment:t1:1'], usdPerArm: 3, maxOpenUsd: 3,
  wallClockMs: 60_000, wallClockMsPerArm: 30_000, ...overrides,
});
async function setup(budget = caps(), totalUsd = 60) {
  const loopId = `benchmark:${randomUUID()}`;
  await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: totalUsd,
    enabled: true, meta: { reservationBinding: manifest, reservationResourceBudget: budget } });
  return loopId;
}
function request(loopId: string, budget = caps(), armId = budget.armIds[0], requestedUsd = 1,
  role = 'solver', resources = { inputTokens: 1, outputTokens: 1 }) {
  return { workspaceId: WS, loopId, requestedUsd, floorUsd: 0, attemptKind: 'evaluation' as const,
    note: JSON.stringify({ role }), exact: { reservationId: randomUUID(), binding: manifest,
      expectedBudgetUsd: 60, resources: { armId, ...resources }, expectedResourceBudget: budget } };
}
async function settle(input: ReturnType<typeof request>, usedUsd: number, disposition: 'used' | 'failed' | 'cancelled' = 'used') {
  return settleLearningSpend(sql, { workspaceId: WS, reservationId: input.exact.reservationId, usedUsd, disposition });
}

describe('strict benchmark aggregate reservation bounds', () => {
  it('serializes global in-flight exposure across roles and arms without partial grants', async () => {
    const budget = caps(), loop = await setup(budget);
    const results = await Promise.all(['leader', 'solver', 'reviewer', 'selector'].map((role, i) =>
      reserveLearningSpend(sql, request(loop, budget, budget.armIds[i % 2], 1, role))));
    expect(results.filter(r => r.ok)).toHaveLength(3);
    expect(results.find(r => !r.ok)).toMatchObject({ reason: 'resource-cap-exceeded' });
    const rows = await listLearningSpendReservations(sql, { workspaceId: WS, loopId: loop });
    expect(rows.reduce((n, r) => n + r.reservedUsd, 0)).toBe(3);
    expect(rows.every(r => r.status === 'open')).toBe(true);
  });

  it('preserves unknown failed-call exposure after controller restart, then releases only measured usage', async () => {
    const budget = caps(), loop = await setup(budget);
    const first = request(loop, budget, budget.armIds[0], 3, 'solver');
    expect((await reserveLearningSpend(sql, first)).ok).toBe(true);
    // No settle is authoritative after lost usage. A fresh client sees the open reservation.
    const client = await import('postgres');
    const fresh = client.default(db.url, { max: 1, prepare: false });
    try {
      expect(await reserveLearningSpend(fresh, request(loop, budget, budget.armIds[1], 1, 'retry')))
        .toMatchObject({ ok: false, reason: 'resource-cap-exceeded' });
      expect((await settle(first, 1, 'failed')).ok).toBe(true);
      expect((await reserveLearningSpend(fresh, request(loop, budget, budget.armIds[1], 2, 'reviewer'))).ok).toBe(true);
    } finally { await fresh.end(); }
  });

  it('counts paid failed work, retries and recovered work toward the same assignment cap', async () => {
    const budget = caps({ maxOpenUsd: 60 }), loop = await setup(budget);
    const first = request(loop, budget, budget.armIds[0], 2, 'leader');
    expect((await reserveLearningSpend(sql, first)).ok).toBe(true);
    expect((await settle(first, 2, 'failed')).ok).toBe(true);
    const retry = request(loop, budget, budget.armIds[0], 1, 'retry');
    expect((await reserveLearningSpend(sql, retry)).ok).toBe(true);
    expect((await settle(retry, 1)).ok).toBe(true);
    expect(await reserveLearningSpend(sql, request(loop, budget, budget.armIds[0], 0.000001, 'recovered')))
      .toMatchObject({ ok: false, reason: 'resource-cap-exceeded' });
    expect((await reserveLearningSpend(sql, request(loop, budget, budget.armIds[1], 3, 'selector'))).ok).toBe(true);
  });

  it('enforces the total dollar boundary across assignments', async () => {
    const budget = caps({ maxOpenUsd: 60, usdPerArm: 60 }), loop = await setup(budget);
    const first = request(loop, budget, budget.armIds[0], 59);
    expect((await reserveLearningSpend(sql, first)).ok).toBe(true);
    expect((await settle(first, 59)).ok).toBe(true);
    expect((await reserveLearningSpend(sql, request(loop, budget, budget.armIds[1], 1))).ok).toBe(true);
    expect(await reserveLearningSpend(sql, request(loop, budget, budget.armIds[0], 0.000001)))
      .toMatchObject({ ok: false, reason: 'insufficient-headroom' });
  });

  it('does not refund token/request bounds after a measured-zero cancellation', async () => {
    const budget = caps({ inputTokens: 1, outputTokens: 1 }), loop = await setup(budget);
    const first = request(loop, budget); expect((await reserveLearningSpend(sql, first)).ok).toBe(true);
    expect((await settle(first, 0, 'cancelled')).ok).toBe(true);
    expect(await reserveLearningSpend(sql, request(loop, budget, budget.armIds[1])))
      .toMatchObject({ ok: false, reason: 'resource-cap-exceeded' });
  });

  it('rejects combined input/output beyond an assignment cap even when each global ceiling has room', async () => {
    const budget = caps({ totalTokensPerArm: 19 }), loop = await setup(budget);
    expect(await reserveLearningSpend(sql, request(loop, budget, budget.armIds[0], 1, 'solver', { inputTokens: 10, outputTokens: 10 })))
      .toMatchObject({ ok: false, reason: 'resource-cap-exceeded' });
    expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId: loop })).toEqual([]);
  });

  it('serializes combined token bounds and retains them across failure and recovery without charging another assignment', async () => {
    const budget = caps({ totalTokensPerArm: 19, maxOpenUsd: 60 }), loop = await setup(budget);
    const attempts = ['solver', 'reviewer'].map(role => request(loop, budget, budget.armIds[0], 1, role, { inputTokens: 6, outputTokens: 4 }));
    const receipts = await Promise.all(attempts.map(q => reserveLearningSpend(sql, q)));
    expect(receipts.filter(r => r.ok)).toHaveLength(1);
    expect(receipts.filter(r => !r.ok)).toEqual([expect.objectContaining({ reason: 'resource-cap-exceeded' })]);
    const accepted = attempts[receipts.findIndex(r => r.ok)];
    expect((await settle(accepted, 0, 'failed')).ok).toBe(true);
    expect(await reserveLearningSpend(sql, request(loop, budget, budget.armIds[0], 1, 'recovered', { inputTokens: 6, outputTokens: 4 })))
      .toMatchObject({ ok: false, reason: 'resource-cap-exceeded' });
    expect((await reserveLearningSpend(sql, request(loop, budget, budget.armIds[1], 1, 'solver', { inputTokens: 6, outputTokens: 4 }))).ok).toBe(true);
  });

  it('binds the combined assignment token cap into immutable policy and the existing cycle fingerprint', async () => {
    const budget = caps({ totalTokensPerArm: 19 }), loop = await setup(budget);
    const drift = { ...budget, totalTokensPerArm: 20 };
    expect(await reserveLearningSpend(sql, request(loop, drift))).toMatchObject({ ok: false, reason: 'stale-binding' });
    const cycle = { runId: randomUUID(), budgetUsd: 60, resources: { armId: budget.armIds[0], inputTokens: 1, outputTokens: 1 }, expectedResourceBudget: budget };
    const id = randomUUID();
    expect(cycleReservationRunRef(cycle, id)).not.toBe(cycleReservationRunRef({ ...cycle, expectedResourceBudget: drift }, id));
  });

  it.each(['wallClockMs', 'wallClockMsPerArm'] as const)('persists %s across settlement/recovery', async field => {
    const budget = caps({ wallClockMs: 60_000, wallClockMsPerArm: 60_000, [field]: 1000 }), loop = await setup(budget);
    const first = request(loop, budget); expect((await reserveLearningSpend(sql, first)).ok).toBe(true);
    expect((await settle(first, 0, 'cancelled')).ok).toBe(true);
    await sql`UPDATE harness_shared.learning_spend_reservations SET created_at = now() - interval '2 seconds' WHERE id = ${first.exact.reservationId}`;
    expect(await reserveLearningSpend(sql, request(loop, budget, field === 'wallClockMs' ? budget.armIds[1] : budget.armIds[0])))
      .toMatchObject({ ok: false, reason: 'resource-cap-exceeded' });
  });

  it.each(['usdPerArm', 'maxOpenUsd', 'wallClockMs', 'wallClockMsPerArm'] as const)('rejects drift of %s instead of renewing the cap', async field => {
    const budget = caps(), loop = await setup(budget), drift = { ...budget, [field]: budget[field]! + 1 };
    expect(await reserveLearningSpend(sql, request(loop, drift))).toMatchObject({ ok: false, reason: 'stale-binding' });
    const cycle = { runId: randomUUID(), budgetUsd: 60, resources: { armId: budget.armIds[0], inputTokens: 1, outputTokens: 1 }, expectedResourceBudget: budget };
    const id = randomUUID();
    expect(cycleReservationRunRef(cycle, id)).not.toBe(cycleReservationRunRef({ ...cycle, expectedResourceBudget: drift }, id));
  });

  it.each([0, -1, NaN, Infinity, 0.0000001])('refuses invalid monetary policy %s', async usd => {
    const budget = caps({ maxOpenUsd: usd }), loop = await setup(budget);
    expect(await reserveLearningSpend(sql, request(loop, budget))).toMatchObject({ ok: false });
    expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId: loop })).toEqual([]);
  });

  it('rejects legacy or foreign-manifest history rather than giving it a zero cost', async () => {
    const budget = caps(), loop = await setup(budget), first = request(loop, budget);
    expect((await reserveLearningSpend(sql, first)).ok).toBe(true);
    await sql`UPDATE harness_shared.learning_spend_reservations SET run_ref = 'foreign-manifest' WHERE id = ${first.exact.reservationId}`;
    expect(await reserveLearningSpend(sql, request(loop, budget))).toMatchObject({ ok: false, reason: 'resource-accounting-incomplete' });
  });
});

describe('complete benchmark reservation census', () => {
  it('includes more than the list ceiling across roles, retries and recovery in one position snapshot', async () => {
    const loopId = await setup();
    // Synthetic ledger population tests the REAL production SQL reader. These
    // are not native/provider observations or proof of billed dollars.
    await sql`INSERT INTO harness_shared.learning_spend_reservations
      (workspace_id, loop_id, requested_usd, reserved_usd, used_usd, status, note)
      SELECT ${WS}, ${loopId}, 0.001, 0.001, 0, 'open',
        json_build_object('role', CASE n % 3 WHEN 0 THEN 'solver' WHEN 1 THEN 'reviewer' ELSE 'recovery' END)::text
      FROM generate_series(1, 501) n`;
    expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId, limit: 1000 })).toHaveLength(500);
    const first = await getLearningSpendPositions(sql, { workspaceId: WS, loopId, includeReservations: true });
    expect(first.census?.status).toBe('complete');
    if (first.census?.status !== 'complete') throw new Error('No complete census');
    expect(first.census.reservations).toHaveLength(501);
    expect(new Set(first.census.reservations.map(row => JSON.parse(row.note!).role))).toEqual(new Set(['solver', 'reviewer', 'recovery']));
    expect(first.positions).toMatchObject({ openAttempts: 501, usedUsd: 0 });
    expect(first.positions.unsettledUsd).toBeCloseTo(0.501);
    expect(first.spend.settledAt).toBeUndefined();
    const same = await getLearningSpendPositions(sql, { workspaceId: WS, loopId, includeReservations: true });
    expect(same.census).toEqual(first.census);
    const id = first.census.reservations[0].id;
    await sql`UPDATE harness_shared.learning_spend_reservations SET used_usd = 0.001, status = 'failed', settled_at = now() WHERE id = ${id}`;
    const after = await getLearningSpendPositions(sql, { workspaceId: WS, loopId, includeReservations: true });
    expect(after.census?.status).toBe('complete');
    if (after.census?.status !== 'complete') throw new Error('No complete census after settlement');
    expect(after.census.populationSha256).not.toBe(first.census.populationSha256);
    expect(after.positions).toMatchObject({ openAttempts: 500, usedUsd: 0.001 });
    expect(after.positions.unsettledUsd).toBeCloseTo(0.5);
  });
  it('scopes empty coverage and never treats a missing ledger as complete', async () => {
    const loopId = await setup();
    const empty = await getLearningSpendPositions(sql, { workspaceId: WS, loopId, includeReservations: true });
    expect(empty.census).toMatchObject({ status: 'complete', reservations: [] });
    await expect(getLearningSpendPositions(sql, { workspaceId: WS, includeReservations: true })).rejects.toThrow(/exact workspace and loop/);
    await sql.unsafe('ALTER TABLE harness_shared.learning_spend_reservations RENAME TO private_missing_reservations');
    try {
      const missing = await getLearningSpendPositions(sql, { workspaceId: WS, loopId, includeReservations: true });
      expect(missing.census).toEqual({ status: 'unavailable', source: 'learning-spend-reservations', reason: 'schema-unavailable' });
    } finally {
      await sql.unsafe('ALTER TABLE harness_shared.private_missing_reservations RENAME TO learning_spend_reservations');
    }
  });
});

describe('native provider authority uses real exact benchmark reservations', () => {
  // Native-contract contents are explicitly synthetic. Physical private SQL,
  // credential/contract bytes and the governor ledger use the production seams.
  async function authenticatedFixture() {
    const root = mkdtempSync(join(tmpdir(), 'bench-native-auth-pg-'));
    const key = join(root, 'key'), contract = join(root, 'provider-contract');
    writeFileSync(key, 'PRIVATE_REGISTERED_PROVIDER_KEY', { mode: 0o600 });
    const protocol = currentProtocolFixture(`auth-${randomUUID()}`, 60_000);
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    const contractBody = JSON.stringify({ model: protocol.arms[0].model, inputTokens: 1000 });
    writeFileSync(contract, contractBody, { mode: 0o600 });
    protocol.priceSchedule.rates[0].inputTokenCeiling = 1000;
    protocol.priceSchedule.rates[0].inputTokenCeilingSourceSha256 = digest(contractBody);
    protocol.maxInFlightUsd = 0.00102;
    const resources = caps({ inputTokens: 3000, maxOpenUsd: protocol.maxInFlightUsd,
      armIds: protocol.arms.map(arm => currentBenchAssignmentId(protocol.runId, arm.id, 't1', 1)), wallClockMsPerArm: 60_000 });
    const preregHash = digest(protocol.runId), loopId = `benchmark:${protocol.runId}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: 60,
      enabled: true, meta: { reservationBinding: preregHash, reservationResourceBudget: resources } });
    const accountId = `private-${randomUUID()}`;
    const account = { id: accountId, provider: 'codex' as const, credentialRef: `token:${key}` };
    await sql`INSERT INTO harness_shared.operator_account_pool VALUES (${WS}, ${sql.json({ accounts: [account] })})
      ON CONFLICT(workspace_id) DO UPDATE SET payload = EXCLUDED.payload`;
    const auth = currentBenchProviderAuthenticator({ workspaceId: WS, preregHash, protocol, armId: 'papercusp', taskId: 't1', seed: 1,
      async readNativeInputCeiling() {
        const bytes = readFileSync(contract, 'utf8'), parsed = JSON.parse(bytes), sourceSha256 = digest(bytes);
        return { ...parsed, sourceSha256, validUntilMonotonicMs: processMonotonicClock.now() + 10_000,
          validateAuthorization() { if (digest(readFileSync(contract, 'utf8')) !== sourceSha256) throw new Error('Native contract changed'); } };
      } }, {
      async readAccount(workspaceId, id) {
        const [row] = await sql<{ payload: { accounts: Array<typeof account> } }[]>`
          SELECT payload FROM harness_shared.operator_account_pool WHERE workspace_id = ${workspaceId}`;
        return row?.payload.accounts.find(value => value.id === id) ?? null;
      }, credentialResolver: (_provider, ref) => makeBearerCredentialResolver(ref),
    });
    const controller = currentBenchGatewayController({ workspaceId: WS, loopId, preregHash, token: randomUUID(), protocol,
      armId: 'papercusp', taskId: 't1', seed: 1, resources, authenticateProvider: auth.authenticateProvider },
      { enabled: async () => true, getSql: async () => sql, log: () => {} });
    const request = (): GatewayCarryTrialAttempt => {
      const body = JSON.stringify({ model: protocol.arms[0].model, reasoning: { effort: 'high' }, max_output_tokens: 10 });
      return { attemptId: randomUUID(), manifestSha256: preregHash, armId: resources.armIds[0], transport: 'bearer-http',
        accountId, credentialHeader: 'authorization', credentialSha256: digest('Bearer PRIVATE_REGISTERED_PROVIDER_KEY'),
        target: 'https://api.openai.com/v1/responses', body, bodySha256: digest(body), clockId: processMonotonicClock.id,
        signal: new AbortController().signal };
    };
    return { ...controller, request, loopId, contract, key, accountId, cleanup() {
      controller.revoke(); auth.revoke(); rmSync(root, { recursive: true, force: true });
    } };
  }

  it('serializes credential-authenticated complete input exposure and preserves unknown headers', async () => {
    const f = await authenticatedFixture();
    try {
      const attempts = [f.request(), f.request()];
      const receipts = await Promise.all(attempts.map(attempt => f.gateway.carryTrial.authorizeAttempt(attempt)));
      expect(receipts.filter(Boolean)).toHaveLength(1);
      const index = receipts.findIndex(Boolean), receipt = receipts[index]!;
      const rows = await listLearningSpendReservations(sql, { workspaceId: WS, loopId: f.loopId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'open', reservedUsd: 0.00102,
        resources: { inputTokens: 1000, outputTokens: 10 } });
      expect(rows[0].note).not.toContain('PRIVATE_REGISTERED_PROVIDER_KEY');
      receipt.validateAuthorization!();
      const { body: _body, signal: _signal, ...identity } = attempts[index];
      await receipt.observeAttemptResult!({ ...identity, reservationRef: receipt.reservationRef,
        outcome: 'response-headers', responseStatus: 200, costUsdMeasurementMissing: true });
      expect((await listLearningSpendReservations(sql, { workspaceId: WS, loopId: f.loopId }))[0].status).toBe('open');
      expect(await f.gateway.carryTrial.authorizeAttempt(f.request())).toBeNull();
    } finally { f.cleanup(); }
  });

  it('rechecks physical contract before send and releases only a proven pre-send refusal', async () => {
    const f = await authenticatedFixture();
    try {
      const attempt = f.request(), receipt = (await f.gateway.carryTrial.authorizeAttempt(attempt))!;
      expect(receipt).not.toBeNull();
      writeFileSync(f.contract, JSON.stringify({ model: 'retargeted', inputTokens: 1 }), { mode: 0o600 });
      expect(() => receipt.validateAuthorization!()).toThrow();
      const { body: _body, signal: _signal, ...identity } = attempt;
      await receipt.observeAttemptResult!({ ...identity, reservationRef: receipt.reservationRef,
        outcome: 'send-refused', responseStatus: null, costUsd: 0, costUsdMeasurementMissing: false });
      expect((await listLearningSpendReservations(sql, { workspaceId: WS, loopId: f.loopId }))[0])
        .toMatchObject({ status: 'cancelled', usedUsd: 0 });
      expect(await f.gateway.carryTrial.authorizeAttempt(f.request())).toBeNull();
      expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId: f.loopId })).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  async function nativeFixture() {
    const protocol = currentProtocolFixture(`private-${randomUUID()}`, 60_000);
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    const resources: LearningReservationResourceBudget = { ...caps(),
      armIds: protocol.arms.map(arm => currentBenchAssignmentId(protocol.runId, arm.id, 't1', 1)),
      wallClockMsPerArm: 60_000 };
    const preregHash = digest(protocol.runId), loopId = `benchmark:${protocol.runId}`;
    await registerLearningLoop(sql, { workspaceId: WS, loopId, budgetKind: 'lifetime', budgetUsd: 60,
      enabled: true, meta: { reservationBinding: preregHash, reservationResourceBudget: resources } });
    const authority = { attemptKind: 'evaluation' as const, requestedUsd: 3, inputTokens: 10, outputTokens: 10,
      validUntilMonotonicMs: processMonotonicClock.now() + 10_000, validateAuthorization: () => {} };
    const controller = (armId = 'papercusp') => currentBenchGatewayController({ workspaceId: WS, loopId, preregHash,
      token: randomUUID(), protocol, armId, taskId: 't1', seed: 1, resources, authenticateProvider: async () => authority },
      { enabled: async () => true, getSql: async () => sql, log: () => {} });
    const request = (armId = 'papercusp'): GatewayCarryTrialAttempt => {
      const body = JSON.stringify({ model: 'configured-alias', reasoning: { effort: 'high' }, max_output_tokens: 10 });
      return { attemptId: randomUUID(), manifestSha256: preregHash,
        armId: currentBenchAssignmentId(protocol.runId, armId, 't1', 1), transport: 'bearer-http', accountId: 'private-approved',
        credentialHeader: 'authorization', credentialSha256: digest('Bearer PRIVATE_SECRET'), target: 'https://provider.invalid/v1/responses',
        body, bodySha256: digest(body), clockId: processMonotonicClock.id, signal: new AbortController().signal };
    };
    const result = (request: GatewayCarryTrialAttempt, reservationRef: string, zero: boolean): GatewayCarryTrialAttemptResult => {
      const { body: _body, signal: _signal, ...identity } = request;
      return zero ? { ...identity, reservationRef, outcome: 'send-refused', responseStatus: null,
        costUsd: 0, costUsdMeasurementMissing: false } : { ...identity, reservationRef, outcome: 'fetch-failed',
        responseStatus: null, costUsdMeasurementMissing: true };
    };
    return { controller, request, result, loopId, authority };
  }

  it.each(['legacy', 'request-bound'] as const)('retains exact provider body evidence across connection restart without settling unknown dollars (%s)', async mode => {
    const f = await nativeFixture(), a = f.controller(), sent = { ...f.request(),
      ...(mode === 'request-bound' ? { gatewayRequestId: `${randomUUID()}:1` } : {}) };
    try {
      const receipt = await a.gateway.carryTrial.authorizeAttempt(sent);
      const { body: _body, signal: _signal, ...identity } = sent;
      const headers: GatewayCarryTrialAttemptResult = { ...identity, reservationRef: receipt!.reservationRef,
        outcome: 'response-headers', responseStatus: 200, costUsdMeasurementMissing: true };
      await receipt!.observeAttemptResult!(headers);
      const before = await getLearningSpendPositions(sql, { workspaceId: WS, loopId: f.loopId, includeReservations: true });
      const complete: GatewayCarryTrialAttemptResult = { ...headers, outcome: 'response-completed', responseStatus: 200, costUsdMeasurementMissing: true,
        responseSha256: createHash('sha256').update('source-bound response').digest('hex'), responseBytes: 120,
        providerCompletion: { responseId: 'provider-fixture', model: 'gpt-6-sol', providerEffort: 'high',
          usage: { inputTokens: 8, inputTokenBasis: 'inclusive', outputTokens: 3, cacheReadTokens: 2, cacheCreationTokens: 0 } } };
      await receipt!.observeAttemptCompletion!(complete);
      const postgres = (await import('postgres')).default;
      const fresh = postgres(db.url, { max: 1, prepare: false });
      try {
        const after = await getLearningSpendPositions(fresh, { workspaceId: WS, loopId: f.loopId, includeReservations: true });
        expect(after.census?.status).toBe('complete');
        if (before.census?.status !== 'complete' || after.census?.status !== 'complete') throw new Error('missing census');
        expect(after.census.populationSha256).not.toBe(before.census.populationSha256);
        expect(after.census.reservations).toHaveLength(1);
        const row = after.census.reservations[0]!;
        expect(row.status).toBe('open'); expect(row.settledAt).toBeNull();
        expect(after.positions.unsettledUsd).toBe(3);
        expect(JSON.parse(row.note!).nativeGatewayAttempt.gatewayRequestId).toBe(sent.gatewayRequestId);
        expect(JSON.parse(row.note!).nativeGatewayAttemptResult).toEqual(complete);
        expect(row.note).not.toMatch(/PRIVATE_SECRET|configured-alias|costUsd"/);
        expect(await recordLearningSpendAttemptResult(fresh, { workspaceId: WS, reservationId: row.id, result: complete })).toEqual({ ok: true });
        const identical = await getLearningSpendPositions(fresh, { workspaceId: WS, loopId: f.loopId, includeReservations: true });
        expect(identical.census?.status === 'complete' && identical.census.populationSha256).toBe(after.census.populationSha256);
        expect(await recordLearningSpendAttemptResult(fresh, { workspaceId: WS, reservationId: row.id,
          result: { ...complete, credentialSha256: 'f'.repeat(64) } })).toMatchObject({ ok: false, reason: 'identity-mismatch' });
        for (const gatewayRequestId of [undefined, `${randomUUID()}:2`]) {
          if (gatewayRequestId === sent.gatewayRequestId) continue;
          expect(await recordLearningSpendAttemptResult(fresh, { workspaceId: WS, reservationId: row.id,
            result: { ...complete, gatewayRequestId } })).toMatchObject({ ok: false, reason: 'identity-mismatch' });
        }
        for (const gatewayRequestId of ['', 'caller-selected', `${randomUUID()}:0`]) {
          expect(await recordLearningSpendAttemptResult(fresh, { workspaceId: WS, reservationId: row.id,
            result: { ...complete, gatewayRequestId } })).toMatchObject({ ok: false, reason: 'invalid-result' });
        }
        expect(await recordLearningSpendAttemptResult(fresh, { workspaceId: WS, reservationId: row.id, result: headers }))
          .toMatchObject({ ok: false, reason: 'transition-refused' });
      } finally { await fresh.end(); }
    } finally { a.revoke(); }
  });

  it('refuses unattested body closure and strips extra caller properties from the durable result', async () => {
    const f = await nativeFixture(), a = f.controller(), sent = f.request();
    try {
      const receipt = await a.gateway.carryTrial.authorizeAttempt(sent);
      const { body: _body, signal: _signal, ...identity } = sent;
      const terminal: GatewayCarryTrialAttemptResult = { ...identity, reservationRef: receipt!.reservationRef,
        outcome: 'response-incomplete', responseStatus: 200, costUsdMeasurementMissing: true,
        responseSha256: 'a'.repeat(64), responseBytes: 9 };
      expect(await recordLearningSpendAttemptResult(sql, { workspaceId: WS, reservationId: receipt!.reservationRef, result: terminal }))
        .toMatchObject({ ok: false, reason: 'transition-refused' });
      const headers: GatewayCarryTrialAttemptResult = { ...identity, reservationRef: receipt!.reservationRef,
        outcome: 'response-headers', responseStatus: 200, costUsdMeasurementMissing: true };
      await receipt!.observeAttemptResult!(headers);
      const malicious = { ...terminal, body: 'PRIVATE_BODY', credential: 'PRIVATE_CREDENTIAL', costUsd: 0 };
      expect(await recordLearningSpendAttemptResult(sql, { workspaceId: WS, reservationId: receipt!.reservationRef, result: malicious })).toEqual({ ok: true });
      const [row] = await listLearningSpendReservations(sql, { workspaceId: WS, loopId: f.loopId });
      expect(JSON.parse(row!.note!).nativeGatewayAttemptResult).toEqual(terminal);
      expect(row!.note).not.toMatch(/PRIVATE_BODY|PRIVATE_CREDENTIAL|costUsd"/);
      expect(row!.status).toBe('open');
    } finally { a.revoke(); }
  });

  it('issues only one concurrent native send when aggregate exposure is full', async () => {
    const f = await nativeFixture(), a = f.controller(), b = f.controller('baseline');
    try {
      const responses = await Promise.all([a.gateway.carryTrial.authorizeAttempt(f.request()),
        b.gateway.carryTrial.authorizeAttempt(f.request('baseline'))]);
      expect(responses.filter(Boolean)).toHaveLength(1);
      const rows = await listLearningSpendReservations(sql, { workspaceId: WS, loopId: f.loopId });
      expect(rows).toHaveLength(1); expect(rows[0].reservedUsd).toBe(3); expect(rows[0].status).toBe('open');
      expect(rows[0].id).toBe(responses.find(Boolean)!.reservationRef);
      expect(rows[0].runRef).toBe(`manifest:${JSON.parse(rows[0].note!).nativeGatewayAttempt.manifestSha256}/attempt:${rows[0].id}`);
      expect(rows[0].note).not.toContain('PRIVATE_SECRET');
    } finally { a.revoke(); b.revoke(); }
  });

  it('keeps a failed native send open through a fresh controller and connection', async () => {
    const f = await nativeFixture(), a = f.controller(), request = f.request();
    try {
      const receipt = (await a.gateway.carryTrial.authorizeAttempt(request))!;
      expect(receipt).not.toBeNull(); receipt.validateAuthorization!();
      await receipt.observeAttemptResult!(f.result(request, receipt.reservationRef, false)); a.revoke();
      const postgres = (await import('postgres')).default, fresh = postgres(db.url, { max: 1, prepare: false });
      const b = f.controller('baseline');
      try {
        expect(await b.gateway.carryTrial.authorizeAttempt(f.request('baseline'))).toBeNull();
        const rows = await listLearningSpendReservations(fresh, { workspaceId: WS, loopId: f.loopId });
        expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ status: 'open', reservedUsd: 3, usedUsd: 0 });
      } finally { b.revoke(); await fresh.end(); }
    } finally { a.revoke(); }
  });

  it('releases only a matching measured pre-send zero, preserving paid retry limits', async () => {
    const f = await nativeFixture(), a = f.controller(), request = f.request();
    try {
      const receipt = (await a.gateway.carryTrial.authorizeAttempt(request))!;
      expect(receipt).not.toBeNull();
      await receipt.observeAttemptResult!(f.result(request, receipt.reservationRef, true));
      const row = (await listLearningSpendReservations(sql, { workspaceId: WS, loopId: f.loopId }))[0];
      expect(row).toMatchObject({ id: receipt.reservationRef, status: 'cancelled', reservedUsd: 3, usedUsd: 0 });
      expect(await a.gateway.carryTrial.authorizeAttempt(request)).toBeNull();
      const next = await a.gateway.carryTrial.authorizeAttempt(f.request());
      expect(next).not.toBeNull(); expect(next!.reservationRef).not.toBe(receipt.reservationRef);
    } finally { a.revoke(); }
  });

  it('does not reserve an underpriced bound or reset exposure by reissuing authority', async () => {
    const f = await nativeFixture(), a = f.controller();
    try {
      f.authority.requestedUsd = 0.000001;
      expect(await a.gateway.carryTrial.authorizeAttempt(f.request())).toBeNull();
      expect(await listLearningSpendReservations(sql, { workspaceId: WS, loopId: f.loopId })).toEqual([]);
      f.authority.requestedUsd = 3;
      expect(await a.gateway.carryTrial.authorizeAttempt(f.request())).not.toBeNull();
      const b = f.controller();
      try { expect(await b.gateway.carryTrial.authorizeAttempt(f.request())).toBeNull(); }
      finally { b.revoke(); }
    } finally { a.revoke(); }
  });
});
