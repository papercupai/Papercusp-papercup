/** Hermetic composition smoke for the gateway service (P-013) — injected account + resolver. */
import { test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGatewayService, resolvePriorityTiers, type RunningGatewayService } from './launch';
import type { GatewayCarryTrialAttempt, GatewayDeps } from './gateway';
import { processMonotonicClock } from '../process-monotonic-clock';
import { INITIAL_PROVIDER_ADMISSION_WINDOW } from './provider-admission-lifecycle';
import type { GatewayPayloadSpool } from './payload-spool';
import * as burnAlert from './burn-alert';
import type { GatewayRequestOutcomeQuery, GatewayRequestOutcomeReport } from './gateway-request-outcome-store';

// Keep the service composition real while binding the DB boundaries added
// after these hermetic fixtures: no accepted support budget exists here, and
// request outcome persistence/reporting belongs to its own store tests.
const db = vi.hoisted(() => ({
  budget: vi.fn(async (_workspace: string, _owner: string) => null),
  recordOutcome: vi.fn(async () => {}),
  reportOutcomes: vi.fn(async (_query: GatewayRequestOutcomeQuery): Promise<GatewayRequestOutcomeReport> => ({
    rows: [], total: 0, byOutcome: { ok: 0, 'client-error': 0, 'upstream-429': 0,
      'upstream-error': 0, shed: 0, cancelled: 0, 'gateway-error': 0, unclassified: 0 },
    firstRequestTimestampMs: null, lastFinalizedAtMs: null, truncated: false, retentionMs: 0,
  })),
}));
vi.mock('../blueprint/support-workflow-budget', () => ({ readSupportOperationBudgetBinding: db.budget }));
vi.mock('./gateway-request-outcome-store', async original => ({
  ...await original<typeof import('./gateway-request-outcome-store')>(),
  recordGatewayRequestOutcome: db.recordOutcome,
  reportGatewayRequestOutcomes: db.reportOutcomes,
}));

beforeEach(() => {
  db.budget.mockClear();
  db.recordOutcome.mockClear();
  db.reportOutcomes.mockClear();
});

/** The per-account multiplier P-010 deleted along with `accountScaledCodexConcurrency`.
 *  Spelled here only so the falsifier below can name the number that must not return. */
const RETIRED_CODEX_SLOTS_PER_ACCOUNT = 4;

let upstream: http.Server | undefined;
let svc: RunningGatewayService | undefined;
let tempDir: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await svc?.stop();
  svc = undefined;
  await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
  upstream = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  delete process.env.OPENAI_BASE_URL_UPSTREAM;
});

async function startUpstream(): Promise<{ base: string; lastAuth: () => string | undefined; lastWorkspace: () => string | undefined; requests: () => number }> {
  let lastAuth: string | undefined;
  let lastWorkspace: string | undefined;
  let requests = 0;
  upstream = http.createServer((req, res) => {
    requests++;
    lastAuth = req.headers['authorization'] as string | undefined;
    lastWorkspace = req.headers['anthropic-workspace-id'] as string | undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => upstream!.listen(0, '127.0.0.1', () => r()));
  const port = (upstream!.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, lastAuth: () => lastAuth, lastWorkspace: () => lastWorkspace, requests: () => requests };
}

const bindingDigest = (s: string) => createHash('sha256').update(s).digest('hex');
const scopedGatewayToken = 'PRIVATE_NATIVE_GATEWAY_TOKEN';
const sendScopedMessage = (port: number, token = scopedGatewayToken) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 4, messages: [{ role: 'user', content: 'PRIVATE_NATIVE_TASK' }] }),
});
const scopedBinding = (authorizeAttempt: (attempt: GatewayCarryTrialAttempt) => Promise<{
  attemptId: string; reservationRef: string; clockId: string; validUntilMonotonicMs: number;
  validateAuthorization?: () => void;
} | null>) => ({ manifestSha256: bindingDigest('native fixture'), armId: 'native-judge',
  requestTokenSha256: bindingDigest(scopedGatewayToken), protocols: ['anthropic-messages'] as Array<'anthropic-messages' | 'openai-responses'>,
  authorizeAttempt });
const nativeFixtureReceipt = (attempt: GatewayCarryTrialAttempt) => ({ attemptId: attempt.attemptId,
  reservationRef: `native-fixture:${attempt.attemptId}`, clockId: attempt.clockId,
  validUntilMonotonicMs: processMonotonicClock.now() + 5_000 });

test.each(['goal-denied', 'policy-unavailable', 'policy-throws', 'model-denied', 'budget-unavailable', 'attestation-fails', 'accepted'] as const)(
  'startGatewayService scopes authorization IO without bypassing its guards (%s)', async state => {
    if (state === 'budget-unavailable') db.budget.mockRejectedValueOnce(new Error('private budget unavailable'));
    tempDir = mkdtempSync(join(tmpdir(), 'gateway-service-authority-'));
    const tokenPath = join(tempDir, 'provider.token');
    writeFileSync(tokenPath, 'PRIVATE_SCOPED_PROVIDER_TOKEN', { mode: 0o600 });
    const policy = vi.fn<NonNullable<GatewayDeps['readAcceptedOperationModelPolicy']>>(async () => {
      if (state === 'policy-throws') throw new Error('private authority unavailable');
      if (state === 'policy-unavailable') return { status: 'unavailable', reason: 'private authority unavailable' };
      return { status: 'bound', policy: {
        mode: 'exact', models: ['gpt-5.6-sol'], effort: 'high', onUnavailable: 'fail',
      }, attestation: {
        operationReceiptId: 12, advSessionId: 34, nativeSessionId: 'private-native-worker',
        workspaceId: 'private-service-workspace', ownerId: 'private-service-owner', harnessSlug: 'private-harness',
        workItemId: 'WI-private-service', operationId: 'run', specificationRevision: 'a'.repeat(64),
      } };
    });
    const record = vi.fn<NonNullable<GatewayDeps['recordAcceptedOperationModelAttestation']>>(async () => {
      if (state === 'attestation-fails') throw new Error('private attestation unavailable');
    });
    const provider = vi.fn<typeof fetch>(async (_target, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer PRIVATE_SCOPED_PROVIDER_TOKEN');
      return Response.json({ id: 'private-service-response', model: 'gpt-5.6-sol', status: 'completed',
        output: [], usage: { input_tokens: 12, output_tokens: 3 } });
    });
    const goal = vi.fn<NonNullable<GatewayDeps['checkGoalInferenceAdmission']>>(async () => state === 'goal-denied'
      ? { allowed: false, goalId: 'private-goal', status: 403, code: 'goal_budget_exhausted', message: 'Private goal denied.' }
      : { allowed: true, goalId: null, reason: 'no-goal' });
    svc = await startGatewayService({ port: 0, workspace: 'private-service-workspace', log: () => {},
      checkGoalInferenceAdmission: goal, readAcceptedOperationModelPolicy: policy,
      recordAcceptedOperationModelAttestation: record, fetchImpl: provider,
      resolveAccounts: async () => [{ accountId: 'private-service-account', credentialRef: `token:${tokenPath}`, source: 'env' }],
      observePool: () => () => {}, refreshIntervalMs: 0, poolReloadIntervalMs: 0, localBackendReloadIntervalMs: 0,
    });
    const response = await fetch(`http://127.0.0.1:${svc.port}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-papercusp-owner': 'private-service-owner' },
      body: JSON.stringify({ model: state === 'model-denied' ? 'gpt-5.6-luna' : 'gpt-5.6-sol',
        input: 'private task', reasoning: { effort: 'high' } }),
    });
    const body = await response.text();
    assert.equal(response.status, state === 'accepted' ? 200 : state === 'attestation-fails' ? 502
      : state === 'goal-denied' || state === 'model-denied' || state === 'budget-unavailable' ? 403 : 503, body);
    assert.equal(goal.mock.calls.length, 1);
    assert.deepEqual(goal.mock.calls[0], ['private-service-owner']);
    assert.equal(policy.mock.calls.length, state === 'goal-denied' ? 0 : 1);
    if (state !== 'goal-denied') assert.deepEqual(policy.mock.calls[0], ['private-service-owner', 'codex']);
    const forwarded = state === 'accepted' || state === 'attestation-fails';
    assert.equal(db.budget.mock.calls.length, forwarded || state === 'budget-unavailable' ? 1 : 0);
    if (db.budget.mock.calls.length) assert.deepEqual(db.budget.mock.calls[0], ['private-service-workspace', 'private-service-owner']);
    assert.equal(provider.mock.calls.length, forwarded ? 1 : 0);
    assert.equal(record.mock.calls.length, forwarded ? 1 : 0);
    if (forwarded) {
      assert.equal(record.mock.calls[0]![0].workspaceId, 'private-service-workspace');
      assert.equal(record.mock.calls[0]![1].actualModel, 'gpt-5.6-sol');
    }
  },
);

test.each(['authorized', 'revoked'] as const)('startGatewayService carries trial authority to the final provider send (%s)', async state => {
  const up = await startUpstream();
  let checks = 0;
  const authorize = vi.fn(async (attempt: GatewayCarryTrialAttempt) => ({ ...nativeFixtureReceipt(attempt),
    validateAuthorization: () => {
      checks++;
      assert.equal(up.requests(), 0, 'controller runs before any upstream write');
      assert.equal(attempt.accountId, 'native-account');
      assert.equal(attempt.credentialSha256, bindingDigest('Bearer PRIVATE_SELECTED_TOKEN'));
      assert.equal(attempt.bodySha256, bindingDigest(attempt.body));
      assert.equal(attempt.manifestSha256, bindingDigest('native fixture'));
      assert.equal(attempt.armId, 'native-judge');
      if (state === 'revoked') throw new Error('PRIVATE_REVOKED_AUTHORITY');
    },
  }));
  svc = await startGatewayService({ port: 0, upstreamBase: up.base, log: () => {},
    carryTrial: scopedBinding(authorize),
    resolveAccount: async () => ({ accountId: 'native-account', credentialRef: 'token:/dev/null', source: 'env' }),
    makeResolver: () => ({ kind: 'token', authMode: 'oauth', current: async () => 'PRIVATE_SELECTED_TOKEN', invalidate: () => {} }),
    observePool: () => () => {}, poolReloadIntervalMs: 0, localBackendReloadIntervalMs: 0,
  });
  const unauthenticated = await sendScopedMessage(svc.port, 'wrong-token');
  assert.equal(unauthenticated.status, 403); await unauthenticated.text();
  assert.equal(up.requests(), 0); assert.equal(authorize.mock.calls.length, 0);
  const response = await sendScopedMessage(svc.port);
  assert.equal(response.status, state === 'authorized' ? 200 : 403);
  assert.doesNotMatch(await response.text(), /PRIVATE_/);
  assert.equal(checks, 1); assert.equal(authorize.mock.calls.length, 1);
  assert.equal(up.requests(), state === 'authorized' ? 1 : 0);
  // The same scoped credential permits exact owner evidence, while every
  // unscoped report and other admin route stays outside its authority.
  for (const [path, token, status] of [
    ['/admin/owner-report?owner=private-native-owner', scopedGatewayToken, 200],
    ['/admin/owner-report?owner=private-native-owner', 'wrong-token', 403],
    ['/admin/owner-report', scopedGatewayToken, 403],
    ['/admin/owner-report?owner=', scopedGatewayToken, 403],
    ['/admin/owner-report?owner=a&owner=b', scopedGatewayToken, 403],
    ['/admin/config', scopedGatewayToken, 403],
    ['/admin/reload', scopedGatewayToken, 403],
  ] as const) {
    const report: Response = await fetch(`http://127.0.0.1:${svc.port}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await report.text(); assert.equal(report.status, status, body);
    if (status === 200) assert.equal(JSON.parse(body).owner, 'private-native-owner');
  }
  assert.equal(up.requests(), state === 'authorized' ? 1 : 0);
  assert.equal(db.reportOutcomes.mock.calls.length, 1, 'only the authorized exact-owner report reaches storage');
  assert.equal(db.reportOutcomes.mock.calls[0]![0].ownerId, 'private-native-owner');
});

test('startGatewayService snapshots trial binding before asynchronous account resolution', async () => {
  const up = await startUpstream();
  let entered!: () => void, resume!: () => void;
  const resolving = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const authorize = vi.fn(async (attempt: GatewayCarryTrialAttempt) => nativeFixtureReceipt(attempt));
  const binding = scopedBinding(authorize);
  const options = { port: 0, upstreamBase: up.base, log: () => {}, carryTrial: binding,
    resolveAccount: async () => { entered(); await gate; return { accountId: 'native-account', credentialRef: 'token:/dev/null', source: 'env' as const }; },
    makeResolver: () => ({ kind: 'token' as const, authMode: 'oauth' as const, current: async () => 'PRIVATE_SELECTED_TOKEN', invalidate: () => {} }),
    observePool: () => () => {}, poolReloadIntervalMs: 0, localBackendReloadIntervalMs: 0,
  };
  const pending = startGatewayService(options);
  await resolving;
  binding.armId = 'substituted'; binding.manifestSha256 = bindingDigest('substituted');
  binding.requestTokenSha256 = bindingDigest('wrong-token'); binding.protocols.push('openai-responses');
  binding.authorizeAttempt = async () => null;
  resume();
  svc = await pending;
  const response = await sendScopedMessage(svc.port);
  assert.equal(response.status, 200); await response.text();
  assert.equal(authorize.mock.calls.length, 1);
  assert.equal(authorize.mock.calls[0][0].armId, 'native-judge');
  assert.equal(authorize.mock.calls[0][0].manifestSha256, bindingDigest('native fixture'));
  const otherProtocol = await fetch(`http://127.0.0.1:${svc.port}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${scopedGatewayToken}` },
    body: JSON.stringify({ model: 'gpt-6-sol', input: 'PRIVATE_TASK' }),
  });
  assert.equal(otherProtocol.status, 403); await otherProtocol.text();
  assert.equal(up.requests(), 1);
});

test.each([null, false, []])('startGatewayService refuses an invalid trial binding (%j) before resolving accounts', async binding => {
  const resolveAccount = vi.fn();
  await assert.rejects(startGatewayService({ carryTrial: binding as never, resolveAccount, log: () => {} }),
    /invalid carry trial binding/);
  assert.equal(resolveAccount.mock.calls.length, 0);
});

test('startGatewayService composes account → resolver → proxy; /healthz + a proxied request work', async () => {
  const up = await startUpstream();
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccount: async () => ({ accountId: 'test-acct', credentialRef: 'token:/dev/null', source: 'env' }),
    makeResolver: () => ({ kind: 'token', authMode: 'oauth', current: async () => 'bound-token', invalidate: () => {} }),
    observePool: () => () => {},
  });

  const health = await fetch(`http://127.0.0.1:${svc.port}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { accountId: string }).accountId, 'test-acct');

  const res = await fetch(`http://127.0.0.1:${svc.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(up.lastAuth(), 'Bearer bound-token', 'gateway injected the bound account token');
});

test('payload-spool lifecycle sweep is injectable, bounded, and stopped with the gateway', async () => {
  const up = await startUpstream();
  const limits: number[] = [];
  const payloadSpool: GatewayPayloadSpool = {
    spool: async () => ({ payloadRef: null, bytes: 0, deduped: false }),
    read: async () => null,
    retain: async () => {},
    release: async () => {},
    sweep: async (options) => {
      limits.push(options?.limit ?? -1);
      return 0;
    },
  };

  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccount: async () => ({ accountId: 'test-acct', credentialRef: 'token:/dev/null', source: 'env' }),
    makeResolver: () => ({ kind: 'token', authMode: 'oauth', current: async () => 'bound-token', invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
    localBackendReloadIntervalMs: 0,
    payloadSpool,
    payloadSpoolSweepIntervalMs: 10,
    payloadSpoolSweepLimit: 7,
  });

  await new Promise((resolve) => setTimeout(resolve, 35));
  const callsBeforeStop = limits.length;
  assert.ok(callsBeforeStop >= 2, 'startup sweep plus at least one lifecycle tick ran');
  assert.ok(limits.every((limit) => limit === 7), 'every lifecycle sweep uses the configured bound');

  await svc.stop();
  svc = undefined;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(limits.length, callsBeforeStop, 'stop clears the payload-spool lifecycle timer');
});

test('startGatewayService sizes both provider priority-tier layers from the ONE shared admission seed', async () => {
  const flagEnv = 'PAPERCUSP_FLAG_PAPERCUSP_GATEWAY_PRIORITY_TIERS';
  const previousFlag = process.env[flagEnv];
  process.env[flagEnv] = '1';
  try {
    const up = await startUpstream();
    const claudeDb = [{ accountId: 'claude-main', credentialRef: 'token:/claude', source: 'pool' as const }];
    const codexDb = [{ accountId: 'codex-main', credentialRef: 'token:/codex', source: 'pool' as const }];
    const logs: string[] = [];
    svc = await startGatewayService({
      port: 0,
      upstreamBase: up.base,
      log: (_level, message) => logs.push(message),
      resolveAccounts: async (_ws, provider) => (provider === 'codex' ? codexDb : claudeDb),
      makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
      // P-010: ONE seed feeds both lanes. There is no Codex-only size to pass, so the
      // observable property flips from "each lane sized from its own pool" to "both
      // lanes derive the same reserve from the same seed".
      //
      // The reserve is derived TWICE, by two different rules, and this test pins both
      // (EI-21833234632961797):
      //   1. CONSTRUCTION — resolvePriorityTiers → defaultTierCaps rounds UP:
      //      max(1, ceil(8 * 0.15)) = 2. This is what the launch log reports, because
      //      the log is emitted from the resolved TierAdmissionConfig.
      //   2. SERVING — provider-admission-lifecycle publishes the starting window at
      //      lane registration ("a lane never serves traffic at whatever its queue was
      //      constructed with"), so setMaxConcurrent(8) immediately rescales the reserve
      //      from the CONFIGURED fraction: round(8 * 0.15) = 1. This is what /stats reports.
      // Before the EI-21833234632961797 fix the queue INFERRED its fraction from the
      // construction absolute (2/8 = 0.25), so the rescale was a no-op at the seed and
      // /stats also read 2 — while every later cap held 25%. Asserting 1 here is the
      // falsifier for that regression: a queue that ignores `reserveFrac` reads 2.
      concurrency: 8,
      observePool: () => () => {},
      poolReloadIntervalMs: 0,
    });

    const stats = (await (await fetch(`http://127.0.0.1:${svc.port}/stats`)).json()) as {
      concurrencyCap: number;
      codexAdmission: { maxConcurrent: number; tier1Reserve?: number };
      codexAimd: { cap: number; floor: number };
    };
    assert.equal(stats.concurrencyCap, 8, 'the compat readback reports the lane high-water mark, which starts at the seed');
    assert.equal(stats.codexAdmission.maxConcurrent, 8, 'Codex starts at the shared seed, not a Codex-specific size');
    assert.equal(
      stats.codexAdmission.tier1Reserve,
      1,
      'the SERVED Codex reserve is round(8 * 0.15) — the configured fraction rescaled onto the published window, not the ceil() construction absolute',
    );
    assert.equal(stats.codexAimd.cap, 8, 'the compat AIMD readback reports the lane high-water mark');
    assert.equal(stats.codexAimd.floor, 4, 'the AIMD floor survives P-010 — a floor is a minimum, never a ceiling');
    // The launch log reports the CONSTRUCTION reserve (rule 1 above), which is 2 and
    // deliberately differs from the served 1 asserted from /stats. Pinning both here
    // keeps that divergence a documented property instead of a latent surprise for the
    // next reader who compares the boot log against a live readback.
    assert.ok(logs.some((message) => message.includes('Claude priority-tier admission ON — reserve=2')), 'launch resolves Claude tiers from the shared seed (construction reserve, pre-publish)');
    assert.ok(logs.some((message) => message.includes('Codex priority-tier admission ON — reserve=2')), 'launch resolves Codex tiers from the same seed (construction reserve, pre-publish)');
  } finally {
    if (previousFlag === undefined) delete process.env[flagEnv];
    else process.env[flagEnv] = previousFlag;
  }
});

test('one Codex account does NOT multiply into a four-slot admission cap (D-006)', async () => {
  // The falsifier for capless-inference-gateway-2026-08-28 D-006 ("serviceability
  // informs attribution, not an admission formula"). `accountScaledCodexConcurrency`
  // used to return accounts * 4 (1 account ⇒ 4); P-010 deleted the function outright,
  // so the Codex lane now opens at the SAME seed every other lane opens at and grows
  // from its own outcomes. ONE account is the fixture that separates the two rules:
  // the retired product (4) and the shared seed are different numbers here.
  const up = await startUpstream();
  const claudeDb = [{ accountId: 'claude-main', credentialRef: 'token:/claude', source: 'pool' as const }];
  const codexDb = [{ accountId: 'codex-main', credentialRef: 'token:/codex', source: 'pool' as const }];
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async (_ws, provider) => (provider === 'codex' ? codexDb : claudeDb),
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  const stats = (await (await fetch(`http://127.0.0.1:${svc.port}/stats`)).json()) as {
    concurrencyCap: number;
    codexAdmission: { maxConcurrent: number };
    codexAimd: { cap: number };
  };
  assert.equal(
    stats.codexAdmission.maxConcurrent,
    INITIAL_PROVIDER_ADMISSION_WINDOW,
    'account count is attribution evidence, not an admission formula',
  );
  assert.equal(stats.codexAdmission.maxConcurrent, stats.concurrencyCap, 'both lanes open at the one shared seed');
  assert.notEqual(
    stats.codexAdmission.maxConcurrent,
    RETIRED_CODEX_SLOTS_PER_ACCOUNT,
    'the retired slots-per-account product must not come back',
  );
  // CALIBRATION: the assertion above is only a falsifier while the two numbers differ.
  assert.notEqual(INITIAL_PROVIDER_ADMISSION_WINDOW, RETIRED_CODEX_SLOTS_PER_ACCOUNT);
});

test.each([
  { codexAccounts: 1, expectedFloor: 4 },
  { codexAccounts: 4, expectedFloor: 4 },
  { codexAccounts: 7, expectedFloor: 7 },
])('startGatewayService shares the seed while provider floors track healthy accounts ($codexAccounts Codex accounts)', async ({ codexAccounts, expectedFloor }) => {
  const up = await startUpstream();
  const claudeDb = [{ accountId: 'claude-main', credentialRef: 'token:/claude', source: 'pool' as const }];
  const codexDb = Array.from({ length: codexAccounts }, (_, i) => ({
    accountId: `codex-${i}`,
    credentialRef: `token:/codex-${i}`,
    source: 'pool' as const,
  }));
  const resolveAccounts = async (_ws: string | undefined, provider: 'claude' | 'codex' = 'claude') =>
    provider === 'codex' ? codexDb : claudeDb;
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts,
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  const scaled = (await (await fetch(`http://127.0.0.1:${svc.port}/stats`)).json()) as {
    concurrencyCap: number;
    aimd: { floor: number };
    codexHealthyAccounts: number;
    codexAdmission: { maxConcurrent: number };
    codexAimd: { cap: number; floor: number };
  };
  // The Claude pool has one account in every case, so both provider lanes share
  // the same cold-start seed. Codex account count does not multiply that seed.
  assert.equal(
    scaled.codexAdmission.maxConcurrent,
    INITIAL_PROVIDER_ADMISSION_WINDOW,
    'the seed is the shared starting window, whatever the account count',
  );
  assert.equal(scaled.concurrencyCap, INITIAL_PROVIDER_ADMISSION_WINDOW);
  assert.equal(scaled.codexAimd.cap, INITIAL_PROVIDER_ADMISSION_WINDOW);
  // P-002 (gateway-admission-congestion-only-2026-10-13): the configured
  // minimum remains in force, but a provider's healthy accounts can raise its
  // own contraction floor. This does not raise the other provider's floor.
  assert.equal(scaled.codexHealthyAccounts, codexAccounts);
  assert.equal(scaled.codexAimd.floor, expectedFloor, 'Codex respects both the configured minimum and its healthy pool');
  assert.equal(scaled.aimd.floor, 4, 'Codex capacity does not change the Claude floor');

  await svc.stop();
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts,
    concurrency: 12,
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  const seeded = (await (await fetch(`http://127.0.0.1:${svc.port}/stats`)).json()) as {
    concurrencyCap: number;
    aimd: { floor: number };
    codexAdmission: { maxConcurrent: number };
    codexAimd: { cap: number; floor: number };
  };
  // An explicit bootstrap value still says where a COLD lane starts (D-002) — and it says
  // it for BOTH lanes, because there is no Codex-only input left to say it differently.
  assert.equal(seeded.codexAdmission.maxConcurrent, 12, 'the explicit seed opens the Codex lane');
  assert.equal(seeded.concurrencyCap, 12, 'and opens the Claude lane at exactly the same window');
  assert.equal(seeded.codexAimd.cap, 12);
  assert.equal(seeded.codexAimd.floor, expectedFloor, 'an explicit seed does not replace the healthy-account floor');
  assert.equal(seeded.aimd.floor, 4);
});

test('R-37: a gateway launched for one workspace selects only from that workspace’s pool (D-001)', async () => {
  const up = await startUpstream();
  const pools: Record<string, Array<{ accountId: string; credentialRef: string; source: 'pool' }>> = {
    'ws-a': [{ accountId: 'a-sub', credentialRef: 'token:/a-sub', source: 'pool' }],
    'ws-b': [{ accountId: 'b-key', credentialRef: 'apikey:env:WS_B_KEY', source: 'pool' }],
  };
  const askedFor: Array<string | undefined> = [];
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    workspace: 'ws-a',
    log: () => {},
    resolveAccounts: async (ws, provider = 'claude') => {
      askedFor.push(ws);
      return provider === 'claude' ? (pools[ws ?? ''] ?? []) : [];
    },
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  assert.ok(askedFor.length > 0, 'the gateway resolved its pool');
  assert.deepEqual([...new Set(askedFor)], ['ws-a'], 'every pool resolution named the launch workspace');
  const stats = (await (await fetch(`http://127.0.0.1:${svc.port}/stats`)).json()) as {
    billing?: { byAccount: Record<string, unknown> };
  };
  const ids = Object.keys(stats.billing?.byAccount ?? {});
  assert.ok(ids.includes('a-sub'), 'the launch workspace account is in the pool');
  assert.ok(!ids.includes('b-key'), 'an account registered in another workspace is never selectable here');
});

test('reloadPool HOT-SWAPS the account pool from the DB source-of-truth, no restart (B-HOT-1)', async () => {
  const up = await startUpstream();
  // The "DB" the gateway re-resolves on reload: starts [a, b], later flips to [a, c, d].
  let dbPool = [
    { accountId: 'a', credentialRef: 'token:/a', source: 'pool' as const },
    { accountId: 'b', credentialRef: 'token:/b', source: 'pool' as const },
  ];
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async () => dbPool,
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0, // disable the auto-poll; drive reloadPool() deterministically
  });

  assert.equal(svc.configVersion(), 1);
  // No DB change → reload is a no-op (same signature), version unchanged.
  const noop = await svc.reloadPool();
  assert.equal(noop.changed, false, 'an unchanged pool does not swap');
  assert.equal(svc.configVersion(), 1, 'version unchanged on a no-op reload');

  // The DB pool changes: 'b' removed, 'c' + 'd' added.
  dbPool = [
    { accountId: 'a', credentialRef: 'token:/a', source: 'pool' as const },
    { accountId: 'c', credentialRef: 'token:/c', source: 'pool' as const },
    { accountId: 'd', credentialRef: 'token:/d', source: 'pool' as const },
  ];
  const changed = await svc.reloadPool();
  assert.equal(changed.changed, true, 'a real DB change hot-reloads');
  assert.equal(svc.configVersion(), 2, 'config version bumped on a real swap');
  assert.deepEqual([...changed.accounts].sort(), ['a', 'c', 'd']);

  // PROOF the swap is LIVE with NO restart: pin a request to 'd' — an account that only exists AFTER the
  // reload — and assert its token reaches the upstream. (Impossible unless the live pool was swapped.)
  const res = await fetch(`http://127.0.0.1:${svc.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'd' },
    body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(up.lastAuth(), 'Bearer d-tok', 'a hot-reload-ADDED account serves live — pool swapped without a restart');
});

test('API workspace bindings reach upstream and a binding-only change hot-reloads', async () => {
  const up = await startUpstream();
  let workspace = 'wrkspc_first';
  svc = await startGatewayService({
    port: 0, upstreamBase: up.base, log: () => {},
    resolveAccounts: async (_ws, provider) => provider === 'codex' ? [] : [{ accountId: 'api', credentialRef: 'apikey:env:TEST_API_KEY', anthropicWorkspaceId: workspace, source: 'pool' as const }],
    makeResolver: () => ({ kind: 'apikey', authMode: 'api-key', current: async () => ['sk', 'ant', 'usr', 'fixture'].join('-'), invalidate: () => {} }),
    observePool: () => () => {}, poolReloadIntervalMs: 0,
  });
  const send = () => fetch(`http://127.0.0.1:${svc!.port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-papercusp-account': 'api' },
    body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal((await send()).status, 200);
  assert.equal(up.lastWorkspace(), 'wrkspc_first');
  workspace = 'wrkspc_second';
  assert.equal((await svc.reloadPool()).changed, true);
  assert.equal((await send()).status, 200);
  assert.equal(up.lastWorkspace(), 'wrkspc_second');
});

test('/admin/config + /admin/reload expose the live config + on-demand hot-reload (B-HOT-2)', async () => {
  const up = await startUpstream();
  let dbPool = [
    { accountId: 'a', credentialRef: 'token:/a', source: 'pool' as const },
    { accountId: 'b', credentialRef: 'token:/b', source: 'pool' as const },
  ];
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async () => dbPool,
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  const base = `http://127.0.0.1:${svc.port}`;

  // GET /admin/config reflects the live pool.
  const c1 = (await (await fetch(`${base}/admin/config`)).json()) as { version: number; accounts: string[] };
  assert.equal(c1.version, 1);
  assert.deepEqual([...c1.accounts].sort(), ['a', 'b']);

  // Change the DB pool, then trigger an ON-DEMAND reload over HTTP.
  dbPool = [
    { accountId: 'a', credentialRef: 'token:/a', source: 'pool' as const },
    { accountId: 'c', credentialRef: 'token:/c', source: 'pool' as const },
  ];
  const r = await fetch(`${base}/admin/reload`, { method: 'POST' });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { ok: boolean; changed: boolean; version: number; accounts: string[] };
  assert.equal(body.ok, true);
  assert.equal(body.changed, true);
  assert.equal(body.version, 2);
  assert.deepEqual([...body.accounts].sort(), ['a', 'c']);

  // GET /admin/config now reflects the reloaded pool — no restart.
  const c2 = (await (await fetch(`${base}/admin/config`)).json()) as { version: number; accounts: string[] };
  assert.equal(c2.version, 2);
  assert.deepEqual([...c2.accounts].sort(), ['a', 'c']);
});

test('Codex account pool can hot-reload from empty to live without a gateway restart', async () => {
  const up = await startUpstream();
  process.env.OPENAI_BASE_URL_UPSTREAM = up.base;
  tempDir = mkdtempSync(join(tmpdir(), 'codex-gw-token-'));
  const codexTokenPath = join(tempDir, 'codex-main.token');
  writeFileSync(codexTokenPath, 'codex-token\n', { mode: 0o600 });

  const claudeDb = [{ accountId: 'claude-main', credentialRef: 'token:/claude', source: 'pool' as const }];
  let codexDb: typeof claudeDb = [];
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async (_ws, provider) => (provider === 'codex' ? codexDb : claudeDb),
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  const base = `http://127.0.0.1:${svc.port}`;

  const before = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4.1', input: 'hi' }),
  });
  assert.equal(before.status, 503);

  codexDb = [{ accountId: 'codex-main', credentialRef: `token:${codexTokenPath}`, source: 'pool' as const }];
  const changed = await svc.reloadPool();
  assert.equal(changed.changed, true);

  const after = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'codex-main' },
    body: JSON.stringify({ model: 'gpt-4.1', input: 'hi' }),
  });
  assert.equal(after.status, 200);
  assert.equal(up.lastAuth(), 'Bearer codex-token');
});

test('two ChatGPT subscription accounts populate a real health pool and hot-reload without a restart', async () => {
  const up = await startUpstream();
  const claudeDb = [{ accountId: 'claude-main', credentialRef: 'token:/claude', source: 'pool' as const }];
  let codexDb = [
    { accountId: 'chatgpt-a', credentialRef: 'codex-cli:/tmp/chatgpt-a', source: 'pool' as const },
    { accountId: 'chatgpt-b', credentialRef: 'codex-cli:/tmp/chatgpt-b', source: 'pool' as const },
  ];
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async (_ws, provider) => (provider === 'codex' ? codexDb : claudeDb),
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  const base = `http://127.0.0.1:${svc.port}`;
  const before = (await (await fetch(`${base}/stats`)).json()) as { codexHealthyAccounts: number };
  assert.equal(before.codexHealthyAccounts, 2, 'both ChatGPT accounts are live routing capacity, not an unverified list count');

  codexDb = [
    { accountId: 'chatgpt-b', credentialRef: 'codex-cli:/tmp/chatgpt-b', source: 'pool' as const },
    { accountId: 'chatgpt-c', credentialRef: 'codex-cli:/tmp/chatgpt-c', source: 'pool' as const },
  ];
  const changed = await svc.reloadPool();
  assert.equal(changed.changed, true);
  const after = (await (await fetch(`${base}/stats`)).json()) as { codexHealthyAccounts: number };
  assert.equal(after.codexHealthyAccounts, 2, 'the subscription pool swaps atomically and preserves healthy capacity');
});

// ── Backlog #7: launch.ts hot-reload + composition deeper edges (continuation; su-7f3e0376) ──

test('startGatewayService throws when the initial account pool resolves empty (fail-fast)', async () => {
  await assert.rejects(
    startGatewayService({
      port: 0,
      log: () => {},
      resolveAccounts: async () => [],
      makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
      observePool: () => () => {},
    }),
    /no account resolved/,
  );
});

test('reloadPool keeps the live pool when the DB resolves EMPTY (fail-safe, no wipe)', async () => {
  const up = await startUpstream();
  let dbPool = [
    { accountId: 'a', credentialRef: 'token:/a', source: 'pool' as const },
    { accountId: 'b', credentialRef: 'token:/b', source: 'pool' as const },
  ];
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async () => dbPool,
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  assert.equal(svc.configVersion(), 1);

  // The DB momentarily resolves an empty pool (e.g. a transient read) — must NOT wipe the live pool.
  dbPool = [];
  const r = await svc.reloadPool();
  assert.equal(r.changed, false, 'an empty resolution does not swap');
  assert.equal(r.version, 1, 'version unchanged on an empty reload');
  assert.deepEqual([...r.accounts].sort(), ['a', 'b'], 'the prior pool is retained');
  assert.equal(svc.configVersion(), 1);

  // PROOF the live pool still serves: a request pinned to 'a' still reaches the upstream with its token.
  const res = await fetch(`http://127.0.0.1:${svc.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'a' },
    body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(up.lastAuth(), 'Bearer a-tok', 'live pool retained after the empty reload — no restart, no wipe');
});

test('reloadPool keeps the live CODEX pool when only codex momentarily resolves EMPTY (WI-3069 fail-safe)', async () => {
  const up = await startUpstream();
  process.env.OPENAI_BASE_URL_UPSTREAM = up.base;
  tempDir = mkdtempSync(join(tmpdir(), 'codex-gw-failsafe-'));
  const codexTokenPath = join(tempDir, 'codex-main.token');
  writeFileSync(codexTokenPath, 'codex-main-tok\n', { mode: 0o600 });
  const claudeDb = [{ accountId: 'claude-main', credentialRef: 'token:/claude', source: 'pool' as const }];
  let codexDb = [{ accountId: 'codex-main', credentialRef: `token:${codexTokenPath}`, source: 'pool' as const }];
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async (_ws, provider) => (provider === 'codex' ? codexDb : claudeDb),
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  assert.equal(svc.configVersion(), 1);

  // Claude's resolver still returns its healthy pool; codex's resolver has a transient hiccup and
  // momentarily resolves EMPTY. Before the WI-3069 fix this wiped the live codex pool to null
  // (createOptionalFailoverPool.reload(inner=null)) even though claude was fine — every subsequent
  // codex request then threw "no Codex account pool configured" until the next successful reload.
  codexDb = [];
  const r = await svc.reloadPool();
  assert.equal(r.changed, false, 'codex-only empty resolution does not count as a real change');
  assert.equal(r.version, 1, 'version unchanged');

  // PROOF the live codex pool still serves after the hiccup reload.
  const res = await fetch(`http://127.0.0.1:${svc.port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-account': 'codex-main' },
    body: JSON.stringify({ model: 'gpt-4.1', input: 'hi' }),
  });
  assert.equal(res.status, 200, 'codex pool was NOT wiped by the transient empty resolve');
  assert.equal(up.lastAuth(), 'Bearer codex-main-tok');
});

test('reloadPool follows the back-compat single resolveAccount path (re-resolves + bumps on change)', async () => {
  const up = await startUpstream();
  const acct = { accountId: 'solo', credentialRef: 'token:/s', source: 'env' as const };
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccount: async () => ({ ...acct }),
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  assert.equal(svc.configVersion(), 1);

  // Same bound account → reload is a no-op.
  const noop = await svc.reloadPool();
  assert.equal(noop.changed, false);
  assert.equal(svc.configVersion(), 1);

  // The bound account's credentialRef rotates → a real change → hot-reload bumps the version.
  acct.credentialRef = 'token:/s2';
  const changed = await svc.reloadPool();
  assert.equal(changed.changed, true, 'a changed single account hot-reloads');
  assert.equal(svc.configVersion(), 2);
  assert.deepEqual(changed.accounts, ['solo']);
});

test('credit projection records depletion immediately even when the included meter is unchanged', async () => {
  const recorded = vi.spyOn(burnAlert, 'recordAccountWindowWithBurnAlert')
    .mockResolvedValue({ pool: { accounts: [] }, transition: null });
  tempDir = mkdtempSync(join(tmpdir(), 'codex-gw-credit-projection-'));
  const codexTokenPath = join(tempDir, 'codex.token');
  writeFileSync(codexTokenPath, 'test-codex-token\n', { mode: 0o600 });
  let available = true;
  let responseStatus = 200;
  upstream = http.createServer((_req, res) => {
    res.writeHead(responseStatus, {
      'content-type': 'application/json',
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-window-minutes': '10080',
      'x-codex-credits-has-credits': available ? 'True' : 'False',
      'x-codex-credits-balance': available ? '50000' : '0',
    });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + (upstream.address() as { port: number }).port;
  process.env.OPENAI_BASE_URL_UPSTREAM = base;
  svc = await startGatewayService({
    port: 0, upstreamBase: base, log: () => {},
    resolveAccounts: async (_ws, provider) => [{
    accountId: provider === 'codex' ? 'test-codex' : 'test-claude',
      credentialRef: provider === 'codex' ? `token:${codexTokenPath}` : 'token:/test-credential', source: 'pool',
    }],
    makeResolver: () => ({ kind: 'token', authMode: 'oauth', current: async () => 'test-token', invalidate: () => {} }),
    observePool: () => () => {},
    resolveLocalBackends: async () => [],
    poolReloadIntervalMs: 0, localBackendReloadIntervalMs: 0,
  });
  const send = async (expectedStatus = 200) => {
    const response = await fetch('http://127.0.0.1:' + svc!.port + '/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-6.1-sol', input: 'credit projection' }),
    });
    const responseBody = await response.text();
    assert.equal(response.status, expectedStatus, responseBody);
  };
  await send();
  await vi.waitFor(() => assert.equal(recorded.mock.calls.length, 1));
  assert.equal(recorded.mock.calls[0]![1].usageCreditsAvailable, true);
  assert.deepEqual(recorded.mock.calls[0]![1].creditBalance, { amount: 50000, unit: 'credits', source: 'codex', unlimited: false });
  assert.equal(recorded.mock.calls[0]![1].utilization7d, 1);
  responseStatus = 429;
  await send(429);
  await vi.waitFor(() => assert.equal(recorded.mock.calls.length, 2));
  assert.equal(recorded.mock.calls[1]![1].usageCreditsAvailable, true, 'a Codex 429 with credits must preserve the parser signal');
  assert.equal(recorded.mock.calls[1]![1].creditBalance?.amount, 50000);
  responseStatus = 200;
  available = false;
  await send();
  await vi.waitFor(() => assert.equal(recorded.mock.calls.length, 3));
  assert.equal(recorded.mock.calls[2]![1].usageCreditsAvailable, false);
  assert.equal(recorded.mock.calls[2]![1].creditBalance?.amount, 0);
});

test('/admin/config exposes the live codexAccounts alongside the claude pool', async () => {
  const up = await startUpstream();
  const claudeDb = [{ accountId: 'claude-main', credentialRef: 'token:/c', source: 'pool' as const }];
  const codexDb = [{ accountId: 'codex-main', credentialRef: 'token:/x', source: 'pool' as const }];
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async (_ws, provider) => (provider === 'codex' ? codexDb : claudeDb),
    makeResolver: (_ref, id) => ({ kind: 'token', authMode: 'oauth', current: async () => `${id}-tok`, invalidate: () => {} }),
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
  });
  const cfg = (await (await fetch(`http://127.0.0.1:${svc.port}/admin/config`)).json()) as {
    version: number;
    accounts: string[];
    codexAccounts: string[];
  };
  assert.deepEqual(cfg.accounts, ['claude-main']);
  assert.deepEqual(cfg.codexAccounts, ['codex-main'], 'codex pool surfaced in the live config');
});

test('proactive refresh timer invalidates only file-kind resolvers, never token-kind', async () => {
  const up = await startUpstream();
  let fileInvalidates = 0;
  let tokenInvalidates = 0;
  svc = await startGatewayService({
    port: 0,
    upstreamBase: up.base,
    log: () => {},
    resolveAccounts: async () => [
      { accountId: 'filey', credentialRef: 'file:/f', source: 'pool' as const },
      { accountId: 'tokey', credentialRef: 'token:/t', source: 'pool' as const },
    ],
    makeResolver: (_ref, id) =>
      id === 'filey'
        ? { kind: 'file', authMode: 'oauth', current: async () => 'f-tok', invalidate: () => { fileInvalidates++; } }
        : { kind: 'token', authMode: 'oauth', current: async () => 't-tok', invalidate: () => { tokenInvalidates++; } },
    observePool: () => () => {},
    poolReloadIntervalMs: 0,
    refreshIntervalMs: 25, // tiny — drive several proactive refreshes within the test window
  });
  await new Promise<void>((r) => setTimeout(r, 250));
  assert.ok(fileInvalidates >= 1, `file-kind resolver is proactively refreshed (got ${fileInvalidates})`);
  assert.equal(tokenInvalidates, 0, 'token-kind (no-expiry) resolver is never invalidated');
});

// ── resolvePriorityTiers (gateway-priority-tiers-2026-06-22): flag + env → tier config ──

test('resolvePriorityTiers — flag OFF → null (gateway runs the flat queue)', async () => {
  assert.equal(await resolvePriorityTiers(24, { flagOverride: false }), null);
});

test('resolvePriorityTiers — flag ON → restoration lanes stay wide; benchmark/gym gets a bounded frame', async () => {
  const r = await resolvePriorityTiers(24, { flagOverride: true, env: {} });
  assert.ok(r, 'config returned when ON');
  assert.equal(r!.config.tier1Reserve, 4, 'ceil(24*0.15)=4');
  assert.equal(r!.config.caps![1], 24, 'tier 1 may use the whole pool');
  assert.equal(r!.config.caps![3], 20, 'implementation bees may use the shared pool');
  assert.equal(r!.config.caps![4], 10, 'benchmark/gym is bounded below implementation capacity');
  assert.equal(r!.config.caps![5], 7, 'unlabeled/default traffic is bounded below benchmark/gym');
  assert.equal(r!.map.queen, 1);
  assert.equal(r!.map.bee, 3);
  assert.equal(r!.map.gym, 4);
  assert.equal(r!.map.benchmark, 4);
  assert.equal(r!.map.su, 2);
});

test('resolvePriorityTiers — GATEWAY_PRIORITY_MAP + GATEWAY_T1_RESERVE_FRAC env overrides apply', async () => {
  const r = await resolvePriorityTiers(20, {
    flagOverride: true,
    env: { GATEWAY_PRIORITY_MAP: '{"cup":4,"newrole":2}', GATEWAY_T1_RESERVE_FRAC: '0.25' },
  });
  assert.equal(r!.config.tier1Reserve, 5, 'ceil(20*0.25)=5');
  // cup remapped to tier 4; newrole added at 2. The default/gym tiers remain present.
  assert.equal(r!.map.cup, 4, 'cup override applied');
  assert.equal(r!.map.newrole, 2, 'new role added');
  assert.equal(r!.config.caps![2], 15, 'tier 2 may use the shared pool');
  assert.equal(r!.config.caps![4], 8, 'tier 4 remains a bounded benchmark/gym-style frame');
});

test('resolvePriorityTiers — reserve floored at 1 for a tiny pool / zero frac', async () => {
  const r = await resolvePriorityTiers(3, { flagOverride: true, env: { GATEWAY_T1_RESERVE_FRAC: '0' } });
  assert.equal(r!.config.tier1Reserve, 1, 'reserve never below 1');
});
