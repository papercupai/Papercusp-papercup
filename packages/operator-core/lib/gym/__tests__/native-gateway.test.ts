import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { bindNativeGymLlmCalls, createNativeGymGatewayController, snapshotNativeGymGatewayConfig, startNativeGymGateway,
  type NativeGymGatewayConfig, type NativeGymProviderAuthorization } from '../proposer';
import { startGatewayService, type GatewayServiceOptions, type RunningGatewayService } from '../../inference-gateway/launch';
import type { GatewayCarryTrialAttempt, GatewayCarryTrialAttemptResult } from '../../inference-gateway/gateway';
import { processMonotonicClock } from '../../process-monotonic-clock';
import { cycleReservationRunRef, type LearningSpendReservation, type ReserveLearningSpendInput,
  type SettleLearningSpendInput } from '../../learning-governor/store';
import type { GovernorGlueDeps } from '../../learning-governor/registrants';
import type { Sql } from 'postgres';

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => false) }));

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const token = 'PRIVATE_NATIVE_TOKEN_0123456789abcdef0123456789abcdef';
it('preserves and freezes the host native output ceiling through authority snapshots', () => {
  const base = config();
  const cfg = { ...base, carryTrial: { ...base.carryTrial, outputTokenLimit: 23 } };
  const frozen = snapshotNativeGymGatewayConfig(cfg);
  cfg.carryTrial.outputTokenLimit = 999;
  expect(frozen.carryTrial.outputTokenLimit).toBe(23);
  expect(Object.isFrozen(frozen.carryTrial)).toBe(true);
  expect(() => snapshotNativeGymGatewayConfig({ ...base, carryTrial: { ...base.carryTrial, outputTokenLimit: 0 } })).toThrow(/authority/);
});
function config(): NativeGymGatewayConfig {
  return { token, carryTrial: { manifestSha256: digest('native manifest'), armId: 'native-cycle',
    protocols: ['anthropic-messages', 'openai-responses'], requestTokenSha256: digest(token),
    authorizeAttempt: async attempt => ({ attemptId: attempt.attemptId, reservationRef: 'native-reservation',
      clockId: attempt.clockId, validUntilMonotonicMs: processMonotonicClock.now() + 5_000,
      validateAuthorization: () => {} }) } };
}
const service = (stop = vi.fn(async () => {})) => ({ port: 12345, stop } as unknown as RunningGatewayService);
const attempt = (cfg: NativeGymGatewayConfig): GatewayCarryTrialAttempt => ({ attemptId: 'provider-attempt',
  manifestSha256: cfg.carryTrial.manifestSha256, armId: cfg.carryTrial.armId, transport: 'anthropic-http',
  accountId: 'selected-account', credentialHeader: 'authorization', credentialSha256: digest('Bearer PRIVATE_SELECTED_TOKEN'),
  target: 'https://provider.invalid/v1/messages', body: '{}', bodySha256: digest('{}'),
  clockId: processMonotonicClock.id, signal: new AbortController().signal });

function controllerFixture() {
  const authority: NativeGymProviderAuthorization = { attemptKind: 'evaluation', requestedUsd: 0.25,
    inputTokens: 100, outputTokens: 41, validUntilMonotonicMs: processMonotonicClock.now() + 5_000,
    validateAuthorization: vi.fn(() => {}) };
  let admitted: LearningSpendReservation;
  const reserve = vi.fn(async (_sql: Sql, input: ReserveLearningSpendInput) => {
    const id = randomUUID();
    return { ok: true as const, clamped: false, headroomUsd: 1,
      reservation: { id, workspaceId: input.workspaceId, loopId: input.loopId, potSlug: input.potSlug ?? null,
        attemptKind: input.attemptKind!, requestedUsd: input.requestedUsd, reservedUsd: input.requestedUsd,
        usedUsd: 0, status: 'open' as const, signalOrigin: 'organic' as const,
        runRef: cycleReservationRunRef(input.cycle!, id), resources: { ...input.cycle!.resources! },
        note: input.note ?? null, createdAt: Date.now(), settledAt: null } };
  });
  const settle = vi.fn(async (_sql: Sql, input: SettleLearningSpendInput) => ({ ok: true as const,
    reservation: { ...admitted, usedUsd: input.usedUsd ?? 0,
      status: input.disposition === 'used' ? 'settled' as const : input.disposition, settledAt: Date.now() },
    event: null, releasedUsd: admitted.reservedUsd - (input.usedUsd ?? 0), overrunUsd: 0 }));
  const originalReserve = reserve.getMockImplementation()!;
  reserve.mockImplementation(async (sql, input) => { const result = await originalReserve(sql, input);
    admitted = result.reservation; return result; });
  const recordAttemptResult = vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true }));
  const governor: GovernorGlueDeps = { enabled: async () => true, getSql: async () => ({} as Sql), reserve,
    settle, recordAttemptResult, log: () => {} };
  const input = { workspaceId: 'private-workspace', loopId: 'gym:private', potSlug: 'private-pot', token,
    manifestSha256: digest('native manifest'), armId: 'native-cycle',
    cycle: { runId: randomUUID(), budgetUsd: 1,
      resourceBudget: { inputTokens: 1000, outputTokens: 500, requestsPerArm: 3, armIds: ['native-cycle'] } },
    authorizeProviderAttempt: vi.fn(async (_attempt: GatewayCarryTrialAttempt) => authority) };
  const controller = createNativeGymGatewayController(input, governor);
  const body = JSON.stringify({ model: 'approved-model', max_tokens: 41, messages: [] });
  const request = { ...attempt(controller.gateway), body, bodySha256: digest(body) };
  return { ...controller, input, governor, reserve, settle, recordAttemptResult, authority, request };
}

function attemptResult(request: GatewayCarryTrialAttempt, reservationRef: string,
  outcome: 'send-refused' | 'fetch-failed' | 'response-headers'): GatewayCarryTrialAttemptResult {
  const { body: _body, signal: _signal, ...identity } = request;
  return { ...identity, reservationRef, outcome, responseStatus: outcome === 'response-headers' ? 200 : null,
    ...(outcome === 'send-refused' ? { costUsd: 0, costUsdMeasurementMissing: false } : { costUsdMeasurementMissing: true }) } as GatewayCarryTrialAttemptResult;
}

describe('native Gym governor-backed provider controller', () => {
  it('durably preserves header and provider completion evidence without treating token usage as a bill', async () => {
    const f = controllerFixture();
    const receipt = await f.gateway.carryTrial.authorizeAttempt(f.request);
    const headers = attemptResult(f.request, receipt!.reservationRef, 'response-headers');
    await receipt!.observeAttemptResult!(headers);
    expect(f.recordAttemptResult).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      workspaceId: f.input.workspaceId, reservationId: receipt!.reservationRef, result: headers }));
    const completion = { ...headers, outcome: 'response-completed', responseStatus: 200, costUsdMeasurementMissing: true,
      responseSha256: digest('provider source'), responseBytes: 123,
      providerCompletion: { responseId: 'provider-response', model: 'approved-model', providerEffort: null,
        usage: { inputTokens: 30, inputTokenBasis: 'inclusive', outputTokens: 9, cacheReadTokens: 0, cacheCreationTokens: 0 } } } as const;
    await receipt!.observeAttemptCompletion!(completion);
    expect(f.recordAttemptResult).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ result: completion }));
    expect(f.settle).not.toHaveBeenCalled();
    f.revoke();
  });

  it('refuses the route when durable per-attempt evidence cannot be saved', async () => {
    const f = controllerFixture();
    f.recordAttemptResult.mockResolvedValue({ ok: false });
    const receipt = await f.gateway.carryTrial.authorizeAttempt(f.request);
    await expect(receipt!.observeAttemptResult!(attemptResult(f.request, receipt!.reservationRef, 'response-headers')))
      .rejects.toThrow();
    expect(f.settle).not.toHaveBeenCalled();
    f.revoke();
  });
  it.each(['evaluation', 'proposer'] as const)('reserves the authenticated exact attempt before issuing authority (%s)', async attemptKind => {
    const f = controllerFixture(); f.authority.attemptKind = attemptKind;
    const receipt = await f.gateway.carryTrial.authorizeAttempt(f.request);
    expect(receipt).not.toBeNull();
    expect(f.input.authorizeProviderAttempt).toHaveBeenCalledWith(f.request);
    expect(f.reserve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ attemptKind,
      workspaceId: 'private-workspace', loopId: 'gym:private', requestedUsd: 0.25,
      cycle: { runId: f.input.cycle.runId, budgetUsd: 1, resources: { armId: 'native-cycle', inputTokens: 100, outputTokens: 41 },
        expectedResourceBudget: f.input.cycle.resourceBudget } }));
    expect(f.settle).not.toHaveBeenCalled(); receipt!.validateAuthorization!();
    const note = f.reserve.mock.calls[0]![1].note!;
    expect(JSON.parse(note).nativeGatewayAttempt).toMatchObject({ attemptId: f.request.attemptId,
      credentialSha256: f.request.credentialSha256, bodySha256: f.request.bodySha256 });
    expect(note).not.toContain('PRIVATE_SELECTED_TOKEN');
    expect(JSON.parse(note).nativeGatewayAttempt).not.toHaveProperty('body');
    expect(JSON.parse(note).nativeGatewayAttempt).not.toHaveProperty('signal');
    expect(f.authority.validateAuthorization).toHaveBeenCalledTimes(1);
    await receipt!.observeAttemptResult!(attemptResult(f.request, receipt!.reservationRef, 'response-headers'));
    expect(f.settle).not.toHaveBeenCalled(); f.revoke();
  });

  it.each(['send-refused', 'fetch-failed', 'response-headers'] as const)('reconciles only no-fetch zero (%s)', async outcome => {
    const f = controllerFixture(); const receipt = (await f.gateway.carryTrial.authorizeAttempt(f.request))!;
    if (outcome !== 'send-refused') receipt.validateAuthorization!();
    await receipt.observeAttemptResult!(attemptResult(f.request, receipt.reservationRef, outcome));
    expect(f.settle).toHaveBeenCalledTimes(outcome === 'send-refused' ? 1 : 0);
    if (outcome === 'send-refused') expect(f.settle).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ reservationId: receipt.reservationRef, usedUsd: 0, disposition: 'cancelled' }));
    await expect(receipt.observeAttemptResult!(attemptResult(f.request, receipt.reservationRef, outcome))).rejects.toThrow();
    expect(f.settle).toHaveBeenCalledTimes(outcome === 'send-refused' ? 1 : 0); f.revoke();
  });

  it.each(['accountId', 'attemptId', 'bodySha256', 'credentialSha256', 'clockId', 'reservationRef'] as const)(
    'does not refund mismatched observer identity (%s)', async key => {
      const f = controllerFixture(); const receipt = (await f.gateway.carryTrial.authorizeAttempt(f.request))!;
      const result = { ...attemptResult(f.request, receipt.reservationRef, 'send-refused'), [key]: 'foreign' };
      await expect(receipt.observeAttemptResult!(result)).rejects.toThrow();
      expect(f.settle).not.toHaveBeenCalled(); f.revoke();
    });

  it.each([{ requestedUsd: 2 }, { requestedUsd: 0 }, { requestedUsd: NaN }, { inputTokens: 1001 },
    { outputTokens: 42 }, { outputTokens: 0 }, { validUntilMonotonicMs: -1 },
    { validateAuthorization: undefined }, { attemptKind: 'unknown' }])('refuses invalid approved bounds before reserve (%j)', async patch => {
    const f = controllerFixture(); Object.assign(f.authority, patch);
    expect(await f.gateway.carryTrial.authorizeAttempt(f.request)).toBeNull();
    expect(f.reserve).not.toHaveBeenCalled(); f.revoke();
  });

  // benchmark-coverage-frontierswe-v2-2026-10-10#D-023: the ChatGPT subscription backend
  // rejects max_output_tokens, so only host evidence of the provider's own frozen limits
  // may stand in for the per-request output field, and only on that oauth-http route.
  function intrinsicFixture() {
    const f = controllerFixture();
    const body = JSON.stringify({ model: 'approved-model', input: [], reasoning: { effort: 'high' } });
    const request = { ...f.request, transport: 'oauth-http' as const,
      target: 'https://chatgpt.com/backend-api/codex/responses', body, bodySha256: digest(body) };
    f.authority.inputEvidence = { kind: 'provider-intrinsic-limit', sourceSha256: digest('subscription contract'),
      bodySha256: request.bodySha256, inputTokens: 100, outputTokens: 41 };
    return { ...f, request };
  }
  it('reserves the frozen provider output limit for a subscription body without an output field', async () => {
    const f = intrinsicFixture();
    expect(await f.gateway.carryTrial.authorizeAttempt(f.request)).not.toBeNull();
    expect(f.reserve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      cycle: expect.objectContaining({ resources: { armId: 'native-cycle', inputTokens: 100, outputTokens: 41 } }) }));
    expect(JSON.parse(f.reserve.mock.calls[0]![1].note!).inputEvidence).toEqual({ kind: 'provider-intrinsic-limit',
      sourceSha256: digest('subscription contract'), bodySha256: f.request.bodySha256, inputTokens: 100, outputTokens: 41 });
    f.revoke();
  });
  it.each(['output-field', 'bearer-route', 'output-mismatch', 'input-mismatch', 'foreign-body', 'bad-source'] as const)(
    'refuses intrinsic-limit evidence with %s before reserve', async changed => {
      const f = intrinsicFixture(); const proof = f.authority.inputEvidence as Extract<
        NonNullable<NativeGymProviderAuthorization['inputEvidence']>, { kind: 'provider-intrinsic-limit' }>;
      let request: GatewayCarryTrialAttempt = f.request;
      if (changed === 'output-field' || changed === 'bearer-route') {
        // An output field would satisfy the output check on its own; the evidence must still refuse it.
        const body = changed === 'output-field' ? JSON.stringify({ ...JSON.parse(request.body), max_output_tokens: 41 }) : request.body;
        request = { ...request, body, bodySha256: digest(body),
          ...(changed === 'bearer-route' ? { transport: 'bearer-http' as const, target: 'https://api.openai.com/v1/responses' } : {}) };
        proof.bodySha256 = request.bodySha256;
      }
      if (changed === 'output-mismatch') proof.outputTokens = 40;
      if (changed === 'input-mismatch') proof.inputTokens = 99;
      if (changed === 'foreign-body') proof.bodySha256 = digest('another body');
      if (changed === 'bad-source') proof.sourceSha256 = 'not-a-digest';
      expect(await f.gateway.carryTrial.authorizeAttempt(request)).toBeNull();
      expect(f.reserve).not.toHaveBeenCalled(); f.revoke();
    });

  it('refuses missing registered policy without inventing defaults', () => {
    const f = controllerFixture(); Object.assign(f.input.cycle, { resourceBudget: undefined });
    expect(() => createNativeGymGatewayController(f.input, f.governor)).toThrow(/approved policy/); f.revoke();
  });

  it('refuses ledger rejection or a foreign admitted receipt', async () => {
    for (const mode of ['refused', 'foreign'] as const) {
      const f = controllerFixture(); const original = f.reserve.getMockImplementation()!;
      f.reserve.mockImplementation(async (sql, input) => {
        if (mode === 'refused') return { ok: false, reason: 'no-headroom', headroomUsd: 0, requestedUsd: input.requestedUsd } as never;
        const result = await original(sql, input); result.reservation.resources.armId = 'foreign'; return result;
      });
      expect(await f.gateway.carryTrial.authorizeAttempt(f.request)).toBeNull();
      expect(f.settle).not.toHaveBeenCalled(); f.revoke();
    }
  });

  it('snapshots actual supplied policy and authority before asynchronous reservation', async () => {
    const f = controllerFixture(); const original = f.reserve.getMockImplementation()!;
    f.reserve.mockImplementation(async (sql, input) => {
      f.input.cycle.budgetUsd = 100; f.input.cycle.resourceBudget.armIds.push('foreign');
      f.authority.outputTokens = 400; f.authority.validateAuthorization = () => { throw new Error('mutated'); };
      return original(sql, input);
    });
    const receipt = (await f.gateway.carryTrial.authorizeAttempt(f.request))!;
    expect(f.reserve.mock.calls[0]![1].cycle!.budgetUsd).toBe(1);
    expect(f.reserve.mock.calls[0]![1].cycle!.expectedResourceBudget!.armIds).toEqual(['native-cycle']);
    expect(() => receipt.validateAuthorization!()).not.toThrow();
    await receipt.observeAttemptResult!(attemptResult(f.request, receipt.reservationRef, 'response-headers')); f.revoke();
  });

  it('revokes issued send authority and preserves unknown reservations', async () => {
    const f = controllerFixture(); const receipt = (await f.gateway.carryTrial.authorizeAttempt(f.request))!;
    f.revoke(); expect(() => receipt.validateAuthorization!()).toThrow();
    expect(await f.gateway.carryTrial.authorizeAttempt({ ...f.request, attemptId: 'next' })).toBeNull();
    await expect(receipt.observeAttemptResult!(attemptResult(f.request, receipt.reservationRef, 'send-refused'))).rejects.toThrow();
    expect(f.settle).not.toHaveBeenCalled();
  });

  it('assigns different reservations to retries and refuses repeated attempt IDs', async () => {
    const f = controllerFixture(); const a = (await f.gateway.carryTrial.authorizeAttempt(f.request))!;
    expect(await f.gateway.carryTrial.authorizeAttempt(f.request)).toBeNull();
    const next = { ...f.request, attemptId: 'retry' }; const b = (await f.gateway.carryTrial.authorizeAttempt(next))!;
    expect(a.reservationRef).not.toBe(b.reservationRef); expect(f.reserve).toHaveBeenCalledTimes(2);
    await a.observeAttemptResult!(attemptResult(f.request, a.reservationRef, 'fetch-failed'));
    await b.observeAttemptResult!(attemptResult(next, b.reservationRef, 'send-refused'));
    expect(f.settle).toHaveBeenCalledTimes(1);
    expect(f.settle.mock.calls[0]).toEqual([expect.anything(), expect.objectContaining({ reservationId: b.reservationRef })]); f.revoke();
  });

  it.each(['async', 'revoked'] as const)('rejects invalid final authority before fetch (%s)', async state => {
    const f = controllerFixture();
    f.authority.validateAuthorization = state === 'async' ? async () => {} : () => { throw new Error('PRIVATE_REVOKED'); };
    const receipt = (await f.gateway.carryTrial.authorizeAttempt(f.request))!;
    expect(() => receipt.validateAuthorization!()).toThrow();
    await receipt.observeAttemptResult!(attemptResult(f.request, receipt.reservationRef, 'send-refused'));
    expect(f.settle).toHaveBeenCalledTimes(1); f.revoke();
  });

  it.each(['authorized', 'revoked'] as const)(
    'uses the real private HTTP service with governor admission before send (%s)', async state => {
      const f = controllerFixture(); let requests = 0;
      const upstream = http.createServer((_req, res) => { requests++;
        expect(f.reserve).toHaveBeenCalledTimes(1);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const upstreamBase = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
      f.input.authorizeProviderAttempt.mockImplementation(async actual => {
        expect(actual.accountId).toBe('selected-account');
        expect(actual.credentialSha256).toBe(digest('Bearer PRIVATE_SELECTED_TOKEN'));
        expect(actual.bodySha256).toBe(digest(actual.body));
        expect(actual.target).toBe(`${upstreamBase}/v1/messages`);
        return f.authority;
      });
      f.authority.validateAuthorization = () => { if (state === 'revoked') throw new Error('PRIVATE_REVOKED'); };
      let native: Awaited<ReturnType<typeof startNativeGymGateway>> | undefined;
      try {
        native = await startNativeGymGateway(f.gateway, f.input.workspaceId, () => {}, options =>
          startGatewayService({ ...options, upstreamBase,
            resolveAccount: async () => ({ accountId: 'selected-account', credentialRef: 'token:/dev/null', source: 'env' }),
            makeResolver: () => ({ kind: 'token', authMode: 'oauth', current: async () => 'PRIVATE_SELECTED_TOKEN', invalidate: () => {} }),
            observePool: () => () => {}, refreshIntervalMs: 0, poolReloadIntervalMs: 0, localBackendReloadIntervalMs: 0 }));
        const response = await fetch(`${native.transport.statelessGateway!.baseURL}/v1/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: f.request.body });
        expect(response.status).toBe(state === 'authorized' ? 200 : 403);
        expect(await response.text()).not.toMatch(/PRIVATE_/);
        expect(f.input.authorizeProviderAttempt).toHaveBeenCalledTimes(1);
        expect(requests).toBe(state === 'authorized' ? 1 : 0);
        expect(f.settle).toHaveBeenCalledTimes(state === 'authorized' ? 0 : 1);
      } finally { f.revoke(); await native?.stop(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
    });
});

describe('native Gym scoped gateway lifecycle', () => {
  it.each([undefined, null, {}, { token }, { ...config(), token: 'wrong' },
    { ...config(), carryTrial: { ...config().carryTrial, protocols: ['openai-responses'] } },
    { ...config(), carryTrial: { ...config().carryTrial, protocols: ['anthropic-messages'] } },
    { ...config(), carryTrial: { ...config().carryTrial, authorizeAttempt: null } }])(
    'refuses incomplete authority before service setup: %j', async value => {
      const start = vi.fn(async () => service());
      await expect(startNativeGymGateway(value as NativeGymGatewayConfig, 'workspace', () => {}, start))
        .rejects.toMatchObject({ costUsd: 0 });
      expect(start).not.toHaveBeenCalled();
    });

  it('copies authority before the first setup await and uses the maintained service on a private port', async () => {
    const cfg = config(); const providerAttempt = attempt(cfg);
    const authorize = vi.fn(cfg.carryTrial.authorizeAttempt);
    Object.assign(cfg.carryTrial, { authorizeAttempt: authorize });
    let supplied!: GatewayServiceOptions;
    const start = vi.fn(async (options: GatewayServiceOptions) => {
      supplied = options;
      cfg.token = 'substituted';
      Object.assign(cfg.carryTrial, { armId: 'substituted', manifestSha256: digest('substituted'),
        protocols: ['anthropic-messages'], authorizeAttempt: async () => null });
      return service();
    });
    const native = await startNativeGymGateway(cfg, 'credential-workspace', () => {}, start);
    expect(supplied).toMatchObject({ workspace: 'credential-workspace', port: 0,
      carryTrial: { armId: 'native-cycle', manifestSha256: digest('native manifest'),
        requestTokenSha256: digest(token), protocols: ['anthropic-messages', 'openai-responses'] } });
    expect(supplied.carryTrial!.authorizeAttempt).not.toBe(cfg.carryTrial.authorizeAttempt);
    const receipt = await supplied.carryTrial!.authorizeAttempt(providerAttempt);
    expect(receipt).not.toBeNull(); receipt!.validateAuthorization!();
    expect(authorize).toHaveBeenCalledWith(providerAttempt);
    expect(native.transport.statelessGateway).toEqual({ baseURL: 'http://127.0.0.1:12345', token });
    await native.stop();
  });

  it('requires a synchronous final provider authority check in each copied receipt', async () => {
    const cfg = config();
    Object.assign(cfg.carryTrial, { authorizeAttempt: async (attempt: Parameters<NativeGymGatewayConfig['carryTrial']['authorizeAttempt']>[0]) =>
      ({ attemptId: attempt.attemptId, reservationRef: 'reservation', clockId: attempt.clockId, validUntilMonotonicMs: 999999 }) });
    const frozen = snapshotNativeGymGatewayConfig(cfg);
    await expect(frozen.carryTrial.authorizeAttempt(attempt(cfg))).resolves.toBeNull();
  });

  it.each(['anthropic', 'codex'] as const)('authorizes only its exact loopback bearer request (%s)', async protocol => {
    const native = await startNativeGymGateway(config(), 'workspace', () => {}, async () => service());
    const body = JSON.stringify(protocol === 'anthropic' ? { max_tokens: 500 } : { max_output_tokens: 500 });
    const request = { attemptId: 'attempt', callId: 'call', attempt: 1, method: 'POST',
      url: `http://127.0.0.1:12345/v1/${protocol === 'anthropic' ? 'messages' : 'responses'}`,
      body, bodySha256: digest(body), credentialSha256: digest(JSON.stringify({ authorization: `Bearer ${token}`, apiKey: null })),
      signal: new AbortController().signal };
    const authorize = native.transport.authorizeStatelessRequest!;
    const check = await authorize(request); expect(check).toBeTypeOf('function'); check!();
    for (const patch of [{ url: 'https://remote.invalid/v1/messages' }, { method: 'GET' },
      { bodySha256: digest('substituted') }, { credentialSha256: digest('foreign') },
      { url: request.url + '?credential=private' }, { url: 'http://127.0.0.1:12345/stats' }]) {
      await expect(authorize({ ...request, ...patch })).resolves.toBeNull();
    }
    await native.stop();
    expect(() => check!()).toThrow();
    await expect(authorize(request)).resolves.toBeNull();
  });

  it('revokes before teardown and stops the service once', async () => {
    const stop = vi.fn(async () => {});
    const native = await startNativeGymGateway(config(), 'workspace', () => {}, async () => service(stop));
    await native.stop(); await native.stop(); expect(stop).toHaveBeenCalledTimes(1);
  });

  it.each(['authorized', 'revoked', 'missing-final-check'] as const)(
    'binds the actual selected credential and body through the maintained private HTTP service (%s)', async state => {
      let requests = 0; let providerAuth: string | undefined;
      const upstream = http.createServer((req, res) => {
        requests++; providerAuth = req.headers.authorization;
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
      });
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const upstreamBase = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
      const cfg = config(); let finalChecks = 0;
      const authorize = vi.fn(async (actual: GatewayCarryTrialAttempt) => {
        expect(actual.credentialSha256).toBe(digest('Bearer PRIVATE_SELECTED_TOKEN'));
        expect(actual.credentialSha256).not.toBe(cfg.carryTrial.requestTokenSha256);
        expect(actual.accountId).toBe('selected-account');
        expect(actual.bodySha256).toBe(digest(actual.body));
        expect(JSON.parse(actual.body)).toMatchObject({ max_tokens: 41,
          messages: [{ role: 'user', content: 'PRIVATE_TASK' }] });
        const base = { attemptId: actual.attemptId, reservationRef: 'native-reservation', clockId: actual.clockId,
          validUntilMonotonicMs: processMonotonicClock.now() + 5_000 };
        return state === 'missing-final-check' ? base : { ...base, validateAuthorization: () => {
          finalChecks++; expect(requests).toBe(0);
          if (state === 'revoked') throw new Error('PRIVATE_REVOKED_AUTHORITY');
        } };
      });
      Object.assign(cfg.carryTrial, { authorizeAttempt: authorize });
      let native: Awaited<ReturnType<typeof startNativeGymGateway>> | undefined;
      try {
        native = await startNativeGymGateway(cfg, 'private-test-workspace', () => {}, options =>
          startGatewayService({ ...options, upstreamBase,
            resolveAccount: async () => ({ accountId: 'selected-account', credentialRef: 'token:/dev/null', source: 'env' }),
            makeResolver: () => ({ kind: 'token', authMode: 'oauth', current: async () => 'PRIVATE_SELECTED_TOKEN', invalidate: () => {} }),
            observePool: () => () => {}, refreshIntervalMs: 0, poolReloadIntervalMs: 0, localBackendReloadIntervalMs: 0 }));
        const response = await fetch(`${native.transport.statelessGateway!.baseURL}/v1/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ model: 'claude-opus-4', max_tokens: 41, messages: [{ role: 'user', content: 'PRIVATE_TASK' }] }),
        });
        expect(response.status).toBe(state === 'authorized' ? 200 : 403);
        expect(await response.text()).not.toMatch(/PRIVATE_/);
        expect(authorize).toHaveBeenCalledTimes(1);
        expect(finalChecks).toBe(state === 'missing-final-check' ? 0 : 1);
        expect(requests).toBe(state === 'authorized' ? 1 : 0);
        expect(providerAuth).toBe(state === 'authorized' ? 'Bearer PRIVATE_SELECTED_TOKEN' : undefined);
      } finally {
        await native?.stop();
        await new Promise<void>(resolve => upstream.close(() => resolve()));
      }
    });

  it('binds both real consumers to a private transport copied before a retry', async () => {
    const native = await startNativeGymGateway(config(), 'workspace', () => {}, async () => service());
    const receipt = { text: '{}', costUsd: 0, inputTokens: 0, outputTokens: 0 };
    const call = vi.fn().mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { costUsd: 0 })).mockResolvedValue(receipt);
    const original = { ...native.transport.statelessGateway! };
    const guard = native.transport.authorizeStatelessRequest;
    const bound = bindNativeGymLlmCalls(call, 'harness', { log: () => {}, transport: native.transport,
      sleep: async () => { native.transport.statelessGateway!.token = 'substituted';
        native.transport.authorizeStatelessRequest = async () => null; } });
    const request = { model: 'claude-fixture', maxTokens: 500, messages: [{ role: 'user' as const, content: 'PRIVATE_REQUEST' }] };
    await bound.judge(request); await bound.proposer(request);
    for (const [sent] of call.mock.calls) expect(sent).toMatchObject({ statelessGateway: original,
      authorizeStatelessRequest: guard, requireOutputTokenLimit: true, priority: 'gym', harnessSlug: 'harness' });
    await native.stop();
  });
});
