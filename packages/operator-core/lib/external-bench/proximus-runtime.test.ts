import { createHash } from 'node:crypto';
import { spawn as realSpawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { currentProtocolFixture, allCapabilities } from './reproducibility/_protocol-test-fixture';
import { currentBenchmarkProtocolSchema, currentBenchProviderAgent, PROXIMUS_CLIENT_VERSION,
  PROXIMUS_SOURCE_REVISION, type CurrentBenchmarkProtocol } from './reproducibility/schema';
import { measureProximusRuntime, prepareProximusRuntime, proximusHostProcess, proximusRunSpec, runProximusHost,
  readProximusAttemptPopulation, readProximusBilling, requireProximusHostConfinement,
  priceProximusAttempts, readProximusTurns } from './proximus-runtime';
import { currentBenchAssignmentId, currentBenchGatewayController, currentBenchProviderAuthenticator,
  requireCurrentBenchHostReferenceGateway, type CurrentBenchNativeInputCeiling } from './current-su';
import { processMonotonicClock } from '../process-monotonic-clock';
import type { GatewayCarryTrialAttempt } from '../inference-gateway/gateway';
import { currentBenchLaunchSelection } from './run-launcher';
import type { LearningSpendReservation, LearningSpendReservationCensus, ReserveLearningSpendInput } from '../learning-governor/store';
import type { Sql } from 'postgres';
import { createProximusTaskBroker } from './proximus-confinement';

// This file qualifies the process protocol, accounting and frozen assignments.
// proximus-confinement.test.ts separately exercises the real OS boundary.
vi.mock('./proximus-confinement', async importOriginal => {
  const original = await importOriginal<typeof import('./proximus-confinement')>();
  return { ...original, createProximusTaskBroker: vi.fn(original.createProximusTaskBroker),
    prepareProximusSandbox: (input: { pythonBin: string }) => ({
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' }, cwd: process.cwd(), cleanup() {},
    wrap(argv: string[]) { return { command: input.pythonBin, argv }; },
  }) };
});

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

describe('Proximus terminal provider-attempt population', () => {
  const binding = { workspaceId: 'offline-workspace', loopId: 'offline-loop', runId: 'offline-run',
    preregHash: digest('frozen-protocol'), assignmentId: 'bench-assignment:proximus-task' };
  const requestId = '11111111-1111-4111-8111-111111111111:1';
  const reservation = (id: string, outcome: string, gatewayRequestId = requestId): LearningSpendReservation => {
    const identity = { attemptId: id, gatewayRequestId, manifestSha256: binding.preregHash,
      armId: binding.assignmentId, transport: 'bearer-http', accountId: 'offline-account',
      credentialHeader: 'authorization', credentialSha256: digest('credential'),
      target: 'https://api.openai.com/v1/responses', bodySha256: digest('request'), clockId: 'host-clock' };
    const result = { ...identity, reservationRef: id, outcome, responseStatus: outcome === 'send-refused' || outcome === 'fetch-failed' ? null : 200,
      costUsdMeasurementMissing: outcome !== 'send-refused', ...(outcome === 'send-refused' ? { costUsd: 0 } : {}),
      ...(['response-completed', 'response-incomplete'].includes(outcome) ? { responseSha256: digest(id), responseBytes: 100 } : {}),
      ...(outcome === 'response-completed' ? { providerCompletion: { responseId: `response-${id}`, model: 'offline-model', providerEffort: 'high',
        usage: { inputTokenBasis: 'inclusive', inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 0 } } } : {}) };
    return { id, workspaceId: binding.workspaceId, loopId: binding.loopId, potSlug: null, attemptKind: 'evaluation',
      requestedUsd: 1, reservedUsd: 1, usedUsd: 0, status: outcome === 'send-refused' ? 'cancelled' : 'open',
      signalOrigin: 'organic', runRef: `manifest:${binding.preregHash}/attempt:${id}`,
      note: JSON.stringify({ nativeGatewayAttempt: identity, nativeGatewayAttemptResult: result }),
      resources: { armId: binding.assignmentId, inputTokens: 100, outputTokens: 10 }, createdAt: 1,
      settledAt: outcome === 'send-refused' ? 2 : null };
  };
  const census = (reservations: LearningSpendReservation[]): Extract<LearningSpendReservationCensus, { status: 'complete' }> => ({ status: 'complete',
    source: 'learning-spend-reservations', reservations, populationSha256: digest(JSON.stringify({ version: 1,
      workspaceId: binding.workspaceId, loopId: binding.loopId, sinceMs: null, reservations })) });
  function changeNote(row: LearningSpendReservation, change: (note: any) => void) {
    const note = JSON.parse(row.note!); change(note); row.note = JSON.stringify(note);
  }
  const billRow = (id: string) => ({ sample_id: `sample-${id}`, gateway_request_id: requestId,
    gateway_attempt_id: id, provider_response_id: `response-${id}`, manifest_sha256: binding.preregHash,
    assignment_id: binding.assignmentId, run_id: binding.runId, account_id: 'offline-account',
    provider: 'openai', model: 'offline-model', cost_source: 'provider', cost_bound: null,
    price_table_version: null, cost_micros: '250000.000000',
    response_id_source: 'authenticated-gateway-provider-response', grain: 'request' });
  const billSql = (rows: unknown[]) => vi.fn(async () => rows) as unknown as Sql;
  it('counts gateway requests once and sums all provider attempts without double-counting cached input', async () => {
    const rows = [reservation('refused', 'send-refused'), reservation('a', 'response-completed'),
      reservation('retry', 'response-completed'), reservation('next', 'response-completed', requestId.replace(':1', ':2'))];
    expect(await readProximusAttemptPopulation(binding, async () => census(rows)))
      .toMatchObject({ usageComplete: true, knownUsage: { modelCalls: 2, tokensIn: 21,
        tokensOut: 6, tokensCacheRead: 9, tokensCacheWrite: 0 } });
  });
  it('preserves measured token subtotals while failed/partial sends and unknown cache splits remain incomplete', async () => {
    const rows = [reservation('known', 'response-completed'), reservation('unknown-cache', 'response-completed'),
      reservation('failed', 'fetch-failed'), reservation('partial', 'response-incomplete')];
    changeNote(rows[1], n => { n.nativeGatewayAttemptResult.providerCompletion.usage.cacheCreationTokens = null; });
    expect(await readProximusAttemptPopulation(binding, async () => census(rows)))
      .toMatchObject({ usageComplete: false, knownUsage: { modelCalls: 1, tokensIn: 7,
        tokensOut: 4, tokensCacheRead: 6, tokensCacheWrite: 0 } });
    expect(await readProximusAttemptPopulation(binding, async () => census([reservation('refused', 'send-refused')])))
      .toMatchObject({ usageComplete: true, knownUsage: { modelCalls: 1, tokensIn: 0,
        tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 } });
  });
  it('normalizes Anthropic cache creation and refuses aggregate token overflow', async () => {
    const rows = [reservation('a', 'response-completed'), reservation('b', 'response-completed')];
    changeNote(rows[0], n => {
      for (const value of [n.nativeGatewayAttempt, n.nativeGatewayAttemptResult])
        Object.assign(value, { transport: 'anthropic-http', credentialHeader: 'x-api-key', target: 'https://api.anthropic.com/v1/messages' });
      n.nativeGatewayAttemptResult.providerCompletion.usage.cacheCreationTokens = 4;
    });
    expect(await readProximusAttemptPopulation(binding, async () => census(rows)))
      .toMatchObject({ usageComplete: true, knownUsage: { modelCalls: 1, tokensIn: 10,
        tokensOut: 4, tokensCacheRead: 6, tokensCacheWrite: 4 } });
    for (const row of rows) changeNote(row, n => { n.nativeGatewayAttemptResult.providerCompletion.usage.outputTokens = Number.MAX_SAFE_INTEGER; });
    expect(await readProximusAttemptPopulation(binding, async () => census(rows)))
      .toEqual({ status: 'unavailable', reason: 'invalid-ledger' });
  });
  it('prices every authenticated retry with frozen uncached/cache rates, independently of actual bills', async () => {
    const protocol = currentProtocolFixture();
    protocol.priceSchedule.rates = [{ model: 'offline-model', inputUsdPerMillion: 2,
      outputUsdPerMillion: 10, cachedInputUsdPerMillion: 1, cacheWriteUsdPerMillion: 4 }];
    const retry = reservation('retry', 'response-completed');
    changeNote(retry, n => { n.nativeGatewayAttemptResult.providerCompletion.usage.cacheCreationTokens = 2; });
    const population = await readProximusAttemptPopulation(binding, async () => census([
      reservation('refused', 'send-refused'), reservation('a', 'response-completed'), retry]));
    expect(priceProximusAttempts(protocol, population)).toEqual({ status: 'complete',
      populationSha256: expect.any(String), priceTableVersion: protocol.priceSchedule.version,
      knownSubtotalUsd: 0.000078, normalizedCostUsd: 0.000078, missingAttemptIds: [], attempts: [
        { attemptId: 'refused', model: null, knownSubtotalUsd: 0, complete: true },
        { attemptId: 'a', model: 'offline-model', knownSubtotalUsd: 0.000037, complete: true },
        { attemptId: 'retry', model: 'offline-model', knownSubtotalUsd: 0.000041, complete: true }] });
  });
  it.each(['failed', 'partial', 'unknown cache', 'unpriced model', 'unpriced cache write'] as const)
  ('retains only known normalized cost when a provider attempt is %s', async change => {
    const protocol = currentProtocolFixture();
    protocol.priceSchedule.rates = [{ model: 'offline-model', inputUsdPerMillion: 2,
      outputUsdPerMillion: 10, cachedInputUsdPerMillion: 1 }];
    const bad = reservation('missing', change === 'failed' ? 'fetch-failed' :
      change === 'partial' ? 'response-incomplete' : 'response-completed');
    if (change === 'unknown cache') changeNote(bad, n => { n.nativeGatewayAttemptResult.providerCompletion.usage.cacheCreationTokens = null; });
    if (change === 'unpriced model') changeNote(bad, n => { n.nativeGatewayAttemptResult.providerCompletion.model = 'not-frozen'; });
    if (change === 'unpriced cache write') changeNote(bad, n => { n.nativeGatewayAttemptResult.providerCompletion.usage.cacheCreationTokens = 1; });
    const population = await readProximusAttemptPopulation(binding, async () => census([reservation('known', 'response-completed'), bad]));
    const priced = priceProximusAttempts(protocol, population);
    expect(priced).toMatchObject({ status: 'incomplete', normalizedCostUsd: null, missingAttemptIds: ['missing'] });
    if (priced.status !== 'unavailable') expect(priced.knownSubtotalUsd).toBeCloseTo(change === 'unknown cache' ? 0.000060 : 0.000037, 12);
  });
  it('keeps missing accounting unavailable rather than assigning a zero price', () => {
    expect(priceProximusAttempts(currentProtocolFixture(), { status: 'unavailable', reason: 'ledger-changed' }))
      .toEqual({ status: 'unavailable', reason: 'ledger-changed' });
  });
  it.each([undefined, null, {}, { n_turns: 4 }, { metadata: {} }, { metadata: { n_turns: '4' } },
    { metadata: { n_turns: -1 } }, { metadata: { n_turns: 0.5 } }, { metadata: { n_turns: Infinity } }])
  ('does not infer official turns from missing or invalid metadata: %j', context => {
    expect(readProximusTurns(context)).toBeNull();
  });
  it.each([0, 3])('reads official metadata.n_turns=%s without borrowing context cost or request counts', turns => {
    expect(readProximusTurns({ metadata: { n_turns: turns }, cost_usd: 999, tokens: 888, n_turns: 777 })).toBe(turns);
  });
  it('reconciles distinct provider attempts using exact canonical samples, with zero only for unsent refusals', async () => {
    const rows = [reservation('refused', 'send-refused'), reservation('a', 'response-completed'), reservation('b', 'response-completed')];
    const sql = billSql([billRow('a'), { ...billRow('b'), cost_micros: '0.000000' }]);
    const result = await readProximusBilling(sql, binding, async () => census(rows));
    expect(result).toEqual({ status: 'complete', knownSubtotalMicros: '250000', billedInferenceMicros: '250000',
      missingAttemptIds: [], samples: [
        { attemptId: 'a', sampleId: 'sample-a', billedInferenceMicros: '250000' },
        { attemptId: 'b', sampleId: 'sample-b', billedInferenceMicros: '0' }], populationSha256: census(rows).populationSha256 });
    expect((sql as unknown as ReturnType<typeof vi.fn>).mock.calls[0].slice(1)).toEqual([binding.workspaceId, [requestId]]);
  });
  it('retains known subtotal while failed, partial or missing sends keep the total unknown', async () => {
    const rows = [reservation('failed', 'fetch-failed'), reservation('partial', 'response-incomplete'),
      reservation('missing', 'response-completed'), reservation('known', 'response-completed')];
    expect(await readProximusBilling(billSql([billRow('known')]), binding, async () => census(rows)))
      .toMatchObject({ status: 'incomplete', knownSubtotalMicros: '250000', billedInferenceMicros: null,
        missingAttemptIds: ['failed', 'partial', 'missing'] });
  });
  it('allows exact zero for an entirely refused population and reconciles Anthropic without native IDs', async () => {
    expect(await readProximusBilling(billSql([]), binding, async () => census([reservation('refused', 'send-refused')])))
      .toMatchObject({ status: 'complete', knownSubtotalMicros: '0', billedInferenceMicros: '0', samples: [] });
    const rows = [reservation('anthropic', 'response-completed')];
    changeNote(rows[0], n => {
      for (const value of [n.nativeGatewayAttempt, n.nativeGatewayAttemptResult])
        Object.assign(value, { transport: 'anthropic-http', credentialHeader: 'x-api-key', target: 'https://api.anthropic.com/v1/messages' });
    });
    expect(await readProximusBilling(billSql([{ ...billRow('anthropic'), provider: 'anthropic' }]), binding, async () => census(rows)))
      .toMatchObject({ status: 'complete', billedInferenceMicros: '250000' });
  });
  it('detaches billing rows and assignment identity before awaiting later evidence', async () => {
    const rows = [reservation('a', 'response-completed')], bills = [billRow('a')], callerBinding = { ...binding };
    const sql = vi.fn(async () => { callerBinding.workspaceId = 'changed'; return bills; }) as unknown as Sql;
    let reads = 0;
    const result = await readProximusBilling(sql, callerBinding, async () => {
      if (++reads > 2) bills[0].cost_micros = '999999';
      return census(rows);
    });
    expect(result).toMatchObject({ status: 'complete', billedInferenceMicros: '250000' });
    expect((sql as unknown as ReturnType<typeof vi.fn>).mock.calls[0].slice(1)).toEqual([binding.workspaceId, [requestId]]);
  });
  it.each(['estimated', 'bound', 'version', 'account', 'model', 'provider', 'request', 'attempt', 'response',
    'manifest', 'assignment', 'run', 'source', 'grain', 'negative', 'fractional', 'nan', 'duplicate sample', 'duplicate attempt', 'foreign row'])
    ('refuses ambiguous or non-bill-grade samples: %s', async change => {
      const rows = [reservation('a', 'response-completed')], bill = billRow('a'), bills = [bill];
      if (change === 'estimated') bill.cost_source = 'estimated';
      if (change === 'bound') Object.assign(bill, { cost_bound: 'lower' });
      if (change === 'version') Object.assign(bill, { price_table_version: 'estimated-table' });
      if (change === 'account') bill.account_id = 'other';
      if (change === 'model') bill.model = 'other';
      if (change === 'provider') bill.provider = 'anthropic';
      if (change === 'request') bill.gateway_request_id = requestId.replace(':1', ':2');
      if (change === 'attempt') bill.gateway_attempt_id = 'other';
      if (change === 'response') bill.provider_response_id = 'other';
      if (change === 'manifest') bill.manifest_sha256 = digest('other');
      if (change === 'assignment') bill.assignment_id = 'bench-assignment:other';
      if (change === 'run') bill.run_id = 'other';
      if (change === 'source') bill.response_id_source = 'caller';
      if (change === 'grain') bill.grain = 'session';
      if (change === 'negative') bill.cost_micros = '-1';
      if (change === 'fractional') bill.cost_micros = '0.1';
      if (change === 'nan') bill.cost_micros = 'NaN';
      if (change === 'duplicate sample') bills.push({ ...bill });
      if (change === 'duplicate attempt') bills.push({ ...bill, sample_id: 'different-sample' });
      if (change === 'foreign row') bills.push(billRow('other'));
      expect(await readProximusBilling(billSql(bills), binding, async () => census(rows)))
        .toEqual({ status: 'unavailable', reason: 'invalid-billing' });
    });
  it('does not convert a missing ledger, failed bill read or changing population into a zero bill', async () => {
    const rows = [reservation('a', 'response-completed')];
    expect(await readProximusBilling(billSql([]), binding, async () => undefined))
      .toEqual({ status: 'unavailable', reason: 'ledger-unavailable' });
    expect(await readProximusBilling(vi.fn(async () => { throw new Error('offline'); }) as unknown as Sql, binding, async () => census(rows)))
      .toEqual({ status: 'unavailable', reason: 'billing-unavailable' });
    let reads = 0;
    expect(await readProximusBilling(billSql([billRow('a')]), binding, async () => census(++reads > 2 ?
      [...rows, reservation('late', 'fetch-failed')] : rows)))
      .toEqual({ status: 'unavailable', reason: 'ledger-changed' });
  });
  it('retains retries under one server request and accepts terminal unknown usage without claiming a bill', async () => {
    const rows = [reservation('refused', 'send-refused'), reservation('failed', 'fetch-failed'),
      reservation('incomplete', 'response-incomplete'), reservation('success', 'response-completed')];
    // Even a settled amount or a caller quote cannot become actual billing evidence.
    rows[3].usedUsd = 0.75; rows[3].status = 'settled'; rows[3].settledAt = 2;
    changeNote(rows[3], n => { n.nativeGatewayAttemptResult.costUsd = 99; n.diagnosticContext = { cost_usd: 99 }; });
    const read = vi.fn(async () => census(rows));
    const result = await readProximusAttemptPopulation(binding, read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'terminal', usageComplete: false, billingStatus: 'unreconciled',
      requests: [{ gatewayRequestId: requestId, attemptIds: rows.map(r => r.id) }],
      attempts: rows.map(r => ({ attemptId: r.id })) });
    expect(JSON.stringify(result)).not.toMatch(/credential|costUsd|cost_usd|nativeSessionId/);
  });
  it('counts distinct successful requests even when their token signatures are identical', async () => {
    const rows = [reservation('first', 'response-completed'), reservation('second', 'response-completed', requestId.replace(':1', ':2'))];
    const result = await readProximusAttemptPopulation(binding, async () => census(rows));
    expect(result).toMatchObject({ status: 'terminal', usageComplete: true, billingStatus: 'unreconciled' });
    if (result.status === 'terminal') expect(result.requests).toHaveLength(2);
  });
  it('retains the authenticated Anthropic transport and exact cache usage', async () => {
    const rows = [reservation('anthropic', 'response-completed')];
    changeNote(rows[0], n => {
      for (const value of [n.nativeGatewayAttempt, n.nativeGatewayAttemptResult])
        Object.assign(value, { transport: 'anthropic-http', credentialHeader: 'x-api-key', target: 'https://api.anthropic.com/v1/messages' });
      n.nativeGatewayAttemptResult.providerCompletion.usage.cacheCreationTokens = 4;
    });
    expect(await readProximusAttemptPopulation(binding, async () => census(rows)))
      .toMatchObject({ status: 'terminal', usageComplete: true, attempts: [{ transport: 'anthropic-http',
        providerCompletion: { usage: { inputTokens: 10, cacheReadTokens: 3, cacheCreationTokens: 4 } } }] });
  });
  it('keeps unknown cache usage explicit and strips extra nested provider fields', async () => {
    const rows = [reservation('success', 'response-completed')];
    changeNote(rows[0], n => {
      n.nativeGatewayAttemptResult.providerCompletion.usage.cacheReadTokens = null;
      n.nativeGatewayAttemptResult.providerCompletion.costUsd = 42;
      n.nativeGatewayAttemptResult.providerCompletion.usage.body = 'private';
    });
    const result = await readProximusAttemptPopulation(binding, async () => census(rows));
    expect(result).toMatchObject({ status: 'terminal', usageComplete: false, billingStatus: 'unreconciled' });
    expect(JSON.stringify(result)).not.toMatch(/private|costUsd/);
  });
  it.each(['missing result', 'missing request id', 'mismatched identity', 'native identity', 'nonterminal',
    'invalid tokens', 'duplicate provider response', 'foreign workspace', 'duplicate reservation', 'borrowed request',
    'invalid digest', 'wrong ledger scope', 'invalid refusal'] as const)('refuses %s instead of asserting a terminal population', async change => {
    const rows = [reservation('success', 'response-completed')];
    if (change === 'missing result') changeNote(rows[0], n => { delete n.nativeGatewayAttemptResult; });
    if (change === 'missing request id') changeNote(rows[0], n => { delete n.nativeGatewayAttempt.gatewayRequestId; delete n.nativeGatewayAttemptResult.gatewayRequestId; });
    if (change === 'mismatched identity') changeNote(rows[0], n => { n.nativeGatewayAttemptResult.gatewayRequestId = requestId.replace(':1', ':2'); });
    if (change === 'native identity') changeNote(rows[0], n => { n.nativeGatewayAttempt.nativeSessionId = 'invented'; n.nativeGatewayAttemptResult.nativeSessionId = 'invented'; });
    if (change === 'nonterminal') rows[0] = reservation('success', 'response-headers');
    if (change === 'invalid tokens') changeNote(rows[0], n => { n.nativeGatewayAttemptResult.providerCompletion.usage.cacheReadTokens = 11; });
    if (change === 'duplicate provider response') { rows.push(reservation('duplicate', 'response-completed'));
      changeNote(rows[1], n => { n.nativeGatewayAttemptResult.providerCompletion.responseId = 'response-success'; }); }
    if (change === 'foreign workspace') rows[0].workspaceId = 'other-workspace';
    if (change === 'duplicate reservation') rows.push(structuredClone(rows[0]));
    if (change === 'borrowed request') { rows.push(reservation('other-arm', 'response-completed'));
      rows[1].resources!.armId = 'bench-assignment:other';
      changeNote(rows[1], n => { n.nativeGatewayAttempt.armId = n.nativeGatewayAttemptResult.armId = rows[1].resources!.armId; }); }
    if (change === 'invalid refusal') { rows[0] = reservation('refused', 'send-refused'); rows[0].usedUsd = 1; }
    const snapshot = census(rows);
    if (change === 'invalid digest') snapshot.populationSha256 = digest('unrelated');
    if (change === 'wrong ledger scope') snapshot.populationSha256 = digest(JSON.stringify({ version: 1,
      workspaceId: binding.workspaceId, loopId: binding.loopId, sinceMs: 1, reservations: rows }));
    expect((await readProximusAttemptPopulation(binding, async () => snapshot)).status).toBe('unavailable');
  });
  it('refuses a population that changes across reads, including an in-place mutation by a shared reader', async () => {
    const snapshot = census([reservation('success', 'response-completed')]);
    let reads = 0;
    const result = await readProximusAttemptPopulation(binding, async () => {
      if (reads++) Object.assign(snapshot, census([...snapshot.reservations, reservation('late', 'fetch-failed')]));
      return snapshot;
    });
    expect(result).toEqual({ status: 'unavailable', reason: 'ledger-changed' });
  });
  it('keeps other assignments separate and refuses missing or unreadable ledger evidence', async () => {
    const rows = [reservation('success', 'response-completed'), reservation('other', 'response-headers', requestId.replace(':1', ':2'))];
    rows[1].resources!.armId = 'bench-assignment:other';
    changeNote(rows[1], n => { n.nativeGatewayAttempt.armId = n.nativeGatewayAttemptResult.armId = rows[1].resources!.armId; });
    expect(await readProximusAttemptPopulation(binding, async () => census(rows)))
      .toMatchObject({ status: 'terminal', attempts: [{ attemptId: 'success' }] });
    expect(await readProximusAttemptPopulation(binding, async () => census([])))
      .toEqual({ status: 'unavailable', reason: 'no-attempts' });
    expect(await readProximusAttemptPopulation(binding, async () => { throw new Error('offline'); }))
      .toEqual({ status: 'unavailable', reason: 'ledger-unavailable' });
  });
});
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: vi.fn(original.spawn) };
});
function fixture(provider: 'openai' | 'anthropic' = 'openai') {
  const protocol = currentProtocolFixture('proximus-offline-fixture', 1_000);
  for (const arm of protocol.arms) arm.control = { topology: arm.id === 'baseline' ? 'stock-native-reference' : 'solo',
    solverGroup: arm.id, solverToolsHash: digest(arm.id), capabilities: allCapabilities(arm.id === 'baseline' ? 'off' : 'on') };
  const arm = protocol.arms[1];
  arm.agent = 'proximus';
  arm.runtime = { sourceRevision: PROXIMUS_SOURCE_REVISION, clientVersion: PROXIMUS_CLIENT_VERSION,
    runtimeRevision: digest('installed-python-harbor-litellm-lock'), promptHash: digest('prompt'), toolsHash: digest('tools'),
    proximus: { provider, harborVersion: '0.23.0', maxInputTokens: 20_000, supportsVision: false } };
  const rate = protocol.priceSchedule.rates[0];
  Object.assign(rate, { inputTokenCeiling: 10_000, inputTokenCeilingSourceSha256: digest('input-authority'),
    outputTokenCeiling: 64, ...(provider === 'anthropic' ? { cacheWriteUsdPerMillion: 1.25 } : {}) });
  protocol.grader.images = { t1: `registry.example/task@sha256:${digest('task-image')}` };
  const execution = { runId: protocol.runId, armId: arm.id, taskId: 't1', seed: 1, agent: 'proximus',
    model: arm.model, effort: arm.effort, account: arm.account, budget: { ...arm.generationBudget },
    topology: 'stock-native-reference' as const, runtimeRevision: arm.runtime.runtimeRevision,
    handle: { containerId: 'existing-frontier-task', instanceId: 't1', image: protocol.grader.images.t1 },
    maxWallClockMs: 1_000, outputTokenLimit: 10 };
  return { protocol, arm, rate, execution };
}

describe('official Proximus protocol identity', () => {
  it('keeps the reference distinct from its credential family and preserves historical Codex protocols', () => {
    expect(currentBenchmarkProtocolSchema.parse(currentProtocolFixture()).arms[1].agent).toBe('codex');
    for (const provider of ['openai', 'anthropic'] as const) {
      const { protocol } = fixture(provider), parsed = currentBenchmarkProtocolSchema.parse(protocol);
      expect(parsed.arms[1].agent).toBe('proximus');
      expect(currentBenchProviderAgent(parsed.arms[1])).toBe(provider === 'openai' ? 'codex' : 'claude');
    }
  });
  const mutations: Record<string, (p: CurrentBenchmarkProtocol) => void> = {
    'missing runtime': p => { delete p.arms[1].runtime.proximus; },
    'relabel as Codex': p => { p.arms[1].agent = 'codex'; },
    'treatment topology': p => { p.arms[1].control!.topology = 'solo'; },
    'capability enabled': p => { p.arms[1].control!.capabilities['memory-recall'] = 'on'; },
    'source drift': p => { p.arms[1].runtime.sourceRevision = 'b'.repeat(40); },
    'package drift': p => { p.arms[1].runtime.clientVersion = 'harbor-proximus@latest'; },
    'unpinned dependencies': p => { p.arms[1].runtime.runtimeRevision = 'latest'; },
    'Codex prompt template': p => { p.arms[1].runtime.promptHashMode = 'codex-native-template-v1'; },
    'unmatched model': p => { p.arms[1].model = 'other-model'; },
    'wider USD cap': p => { p.arms[1].generationBudget.maxUsd++; },
    'wider time cap': p => { p.arms[1].generationBudget.maxWallClockMs++; },
    'missing image manifest': p => { delete p.grader.images; },
    'missing task image': p => { p.grader.images = {}; },
    'unknown context capacity': p => { p.arms[1].runtime.proximus!.maxInputTokens = 0; },
    'input wider than context': p => { p.arms[1].runtime.proximus!.maxInputTokens = 9_999; },
    'unbounded output': p => { delete p.priceSchedule.rates[0].outputTokenCeiling; },
    'unproven input ceiling': p => { delete p.priceSchedule.rates[0].inputTokenCeilingSourceSha256; },
    'subscription payer': p => { for (const a of p.arms) a.payer = 'subscription'; },
    'missing Anthropic cache price': p => { p.arms[1].runtime.proximus!.provider = 'anthropic'; },
    'same solver as Codex': p => { p.arms[1].control!.solverGroup = p.arms[0].control!.solverGroup; },
    'no treatment': p => { p.arms[0].control!.topology = 'stock-native-reference';
      p.arms[0].control!.capabilities = allCapabilities('off'); },
  };
  it.each(Object.keys(mutations))('refuses %s before runtime preparation', change => {
    const { protocol, execution } = fixture(); mutations[change](protocol);
    expect(currentBenchmarkProtocolSchema.safeParse(protocol).success).toBe(false);
    expect(() => proximusRunSpec(protocol, execution)).toThrow();
  });
});

describe('Proximus frozen runtime preparation', () => {
  const measured = () => ({ schemaVersion: 1 as const, runtimeRevision: digest('installed-runtime'),
    sourceRevision: PROXIMUS_SOURCE_REVISION, clientVersion: PROXIMUS_CLIENT_VERSION, harborVersion: '0.23.0', fileCount: 100 });
  type Installer = NonNullable<NonNullable<Parameters<typeof prepareProximusRuntime>[1]>['install']>;
  const installer = () => vi.fn<Installer>(async (_command, _args, options) =>
    `${options.env!.UV_PROJECT_ENVIRONMENT}/bin/python\n`);

  it('uses the frozen vendored project without inheriting credentials, and remeasures existing runtimes', async () => {
    const install = installer(), measure = vi.fn(async () => measured());
    const first = await prepareProximusRuntime({}, { install, measure });
    const second = await prepareProximusRuntime({}, { install, measure });
    expect(first).toEqual(second);
    expect(measure).toHaveBeenCalledTimes(2);
    const [command, args, options] = install.mock.calls[0];
    expect(command).toBe('uv');
    expect(args).toEqual(['run', '--frozen', '--no-dev', '--python', '3.12', '--project',
      expect.stringMatching(/\/vendor\/proximus$/), 'python', '-I', '-c', 'import sys;print(sys.executable)']);
    expect(options).toMatchObject({ timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 65536 });
    expect(options.env!.UV_PROJECT_ENVIRONMENT).toMatch(/\/papercusp-proximus-[a-f0-9]{16}$/);
    expect(Object.keys(options.env!)).not.toEqual(expect.arrayContaining(['OPENAI_API_KEY']));
    expect(Object.keys(options.env!)).toEqual(expect.arrayContaining(['UV_PROJECT_ENVIRONMENT', 'PYTHONDONTWRITEBYTECODE']));
    expect(Object.keys(options.env!).every(key => ['UV_PROJECT_ENVIRONMENT', 'PYTHONDONTWRITEBYTECODE',
      'PATH', 'HOME', 'TMPDIR', 'UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR', 'XDG_CACHE_HOME'].includes(key))).toBe(true);
    expect(measure).toHaveBeenCalledWith({ pythonBin: first.pythonBin, signal: undefined });
    expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.runtime)).toBe(true);
  });
  it.each(['python', '/usr/bin/python', '/tmp/foreign/bin/python', '/tmp/a\n/tmp/b'])
    ('refuses an unbound interpreter before measurement: %s', async stdout => {
      const measure = vi.fn();
      await expect(prepareProximusRuntime({}, { install: async () => stdout, measure })).rejects.toThrow(/interpreter/);
      expect(measure).not.toHaveBeenCalled();
    });
  it('propagates install failure and refuses incomplete byte measurements', async () => {
    const measure = vi.fn();
    await expect(prepareProximusRuntime({}, { install: async () => { throw new Error('uv failed'); }, measure }))
      .rejects.toThrow('uv failed');
    expect(measure).not.toHaveBeenCalled();
    await expect(prepareProximusRuntime({}, { install: installer(), measure: async () => ({ ...measured(), fileCount: 0 }) }))
      .rejects.toThrow(/incomplete/);
  });
  it('does not install after cancellation or measure after cancellation during installation', async () => {
    const abort = new AbortController(), install = installer(), measure = vi.fn();
    abort.abort();
    await expect(prepareProximusRuntime({ signal: abort.signal }, { install, measure })).rejects.toThrow();
    expect(install).not.toHaveBeenCalled();
    const during = new AbortController();
    install.mockImplementationOnce(async (_command, _args, options) => {
      during.abort(); return `${options.env!.UV_PROJECT_ENVIRONMENT}/bin/python\n`;
    });
    await expect(prepareProximusRuntime({ signal: during.signal }, { install, measure })).rejects.toThrow();
    expect(install.mock.calls[0][2].signal).toBe(during.signal);
    expect(measure).not.toHaveBeenCalled();
  });
});

describe('Proximus measured host execution', () => {
  const measured = () => ({ schemaVersion: 1 as const, runtimeRevision: digest('installed-python-harbor-litellm-lock'),
    sourceRevision: PROXIMUS_SOURCE_REVISION, clientVersion: PROXIMUS_CLIENT_VERSION, harborVersion: '0.23.0', fileCount: 100 });
  const workerResult = () => ({ schemaVersion: 1, status: 'completed', runtime: measured(),
    diagnosticContext: { cost_usd: 0.001 }, billingStatus: 'unreconciled' });
  // Exercise the actual parent lifecycle/receipt issuer with a deterministic
  // child. OS policy and the unchanged official loop have separate acceptance
  // tests; this fixture grants neither provider access nor a real task.
  async function completedWorker(input: Parameters<typeof proximusHostProcess>[0]) {
    const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(createProximusTaskBroker).mockResolvedValueOnce({ command: vi.fn(), stop: vi.fn(async () => {}) });
    vi.mocked(realSpawn).mockImplementationOnce((_command, _args, options) => original.spawn(process.execPath,
      ['-e', `require('node:readline').createInterface({input:process.stdin}).once('line',()=>{
        process.stdout.write(JSON.stringify(${JSON.stringify(workerResult())}));process.exit(0)});`], options));
    return proximusHostProcess(input);
  }
  async function host() {
    const f = providerFixture('openai');
    const controller = currentBenchGatewayController({ ...f.input,
      loopId: 'offline-loop', token: digest('offline-gateway-token'), authenticateProvider: f.auth.authenticateProvider,
      resources: { inputTokens: 20_000, outputTokens: 100, requestsPerArm: 2,
        armIds: f.protocol.arms.map(a => currentBenchAssignmentId(f.protocol.runId, a.id, 't1', 1)),
        usdPerArm: 3, maxOpenUsd: 3, wallClockMs: 2_000, wallClockMsPerArm: 1_000 } });
    const receipt = await controller.startHostGateway(() => {}, async () => ({ port: 32105, stop: async () => {} } as never));
    const execution = { ...f.execution, handle: { ...f.execution.handle, containerId: 'a'.repeat(64) },
      pythonBin: '/offline/venv/bin/python', trialDir: '/offline/trial', instruction: 'solve the exact task',
      network: 'none', networkMode: 'no-network' as const, gateway: receipt };
    return { ...f, controller, execution, receipt, cleanup: async () => { await receipt.stop(); f.auth.revoke(); } };
  }
  it('prepares without any gateway and refuses incomplete installed-byte evidence', async () => {
    const execute = vi.fn(async () => measured());
    expect(await measureProximusRuntime({ pythonBin: '/offline/python' }, execute)).toEqual(measured());
    expect(execute).toHaveBeenCalledWith({ pythonBin: '/offline/python', operation: 'measure', maxWallClockMs: 120_000 });
    await expect(measureProximusRuntime({ pythonBin: '/offline/python' }, async () => ({ runtimeRevision: 'claimed' })))
      .rejects.toThrow(/incomplete/);
  });
  it('binds the official host to measured bytes and its issued gateway, retaining diagnostic cost as unreconciled', async () => {
    const f = await host();
    const execute = vi.fn<NonNullable<Parameters<typeof measureProximusRuntime>[1]>>(async input => input.operation === 'measure' ? measured()
      : completedWorker(input));
    try {
      const result = await runProximusHost(f.protocol, f.execution, execute);
      expect(result.billingStatus).toBe('unreconciled');
      expect(result.diagnosticContext).toEqual({ cost_usd: 0.001 });
      expect(requireProximusHostConfinement(result)).toMatchObject({ source: 'confined-host-process',
        pythonBin: f.execution.pythonBin, trialDir: f.execution.trialDir, maxWallClockMs: 1_000,
        task: { containerId: f.execution.handle.containerId, image: f.execution.handle.image } });
      expect(JSON.stringify(result.confinement)).not.toContain(f.receipt.gateway.token);
      expect(() => requireProximusHostConfinement(structuredClone(result))).toThrow(/host-issued/);
      const run = execute.mock.calls[1][0], body = JSON.parse(run.stdin!);
      expect(run).toMatchObject({ operation: 'run', maxWallClockMs: 1_000, pythonBin: '/offline/venv/bin/python' });
      expect(body.gateway).toEqual(f.receipt.gateway);
      expect(body.spec).toMatchObject({ runtimeRevision: measured().runtimeRevision, modelName: `openai/${f.arm.model}` });
      expect(body).not.toHaveProperty('account');
    } finally { await f.cleanup(); }
  });
  it.each(['worker JSON', 'copied receipt', 'changed worker result', 'container', 'image', 'network',
    'trial', 'gateway', 'interpreter', 'deadline', 'payload', 'caller input mutation'] as const)
  ('refuses terminal evidence without its exact parent issuance: %s', async change => {
    const f = await host();
    const execute = async (input: Parameters<typeof proximusHostProcess>[0]) => {
      if (input.operation === 'measure') return measured();
      if (change === 'worker JSON') return workerResult();
      if (change === 'caller input mutation') input.confinement!.task.containerId = 'b'.repeat(64);
      const changed = { ...input, confinement: structuredClone(input.confinement!) };
      if (change === 'container') changed.confinement.task.containerId = 'b'.repeat(64);
      if (change === 'image') changed.confinement.task.image += '-other';
      if (change === 'network') changed.confinement.task.network = 'bridge';
      if (change === 'trial') changed.confinement.trialDir += '-other';
      if (change === 'gateway') changed.confinement.gatewayBaseURL = 'http://127.0.0.1:32106';
      if (change === 'interpreter') changed.pythonBin += '-other';
      if (change === 'deadline') changed.maxWallClockMs++;
      if (change === 'payload') changed.stdin += ' ';
      const result = await completedWorker(changed);
      if (change === 'copied receipt') return structuredClone(result);
      if (change === 'changed worker result') (result as ReturnType<typeof workerResult>).diagnosticContext.cost_usd++;
      return result;
    };
    try { await expect(runProximusHost(f.protocol, f.execution, execute)).rejects.toThrow(/host-issued/); }
    finally { await f.cleanup(); }
  });
  it('consumes a worker receipt once and detects later mutation of accepted diagnostic evidence', async () => {
    const f = await host();
    let worker: unknown;
    const execute = async (input: Parameters<typeof proximusHostProcess>[0]) => input.operation === 'measure' ? measured()
      : worker ??= await completedWorker(input);
    try {
      const result = await runProximusHost(f.protocol, f.execution, execute);
      await expect(runProximusHost(f.protocol, f.execution, execute)).rejects.toThrow(/single-use/);
      (result.diagnosticContext as ReturnType<typeof workerResult>['diagnosticContext']).cost_usd++;
      expect(() => requireProximusHostConfinement(result)).toThrow(/unchanged/);
    } finally { await f.cleanup(); }
  });
  it.each(['copied grant', 'runtime drift', 'revoked during measurement', 'result drift'] as const)
  ('refuses %s before accepting any terminal result', async change => {
    const f = await host();
    const execute = vi.fn<NonNullable<Parameters<typeof measureProximusRuntime>[1]>>(async input => {
      if (input.operation === 'measure') {
        if (change === 'revoked during measurement') await f.receipt.stop();
        return { ...measured(), ...(change === 'runtime drift' ? { runtimeRevision: digest('changed') } : {}) };
      }
      return { schemaVersion: 1, status: 'completed', runtime: { ...measured(), runtimeRevision: digest('changed') },
        diagnosticContext: { cost_usd: 0 }, billingStatus: 'unreconciled' };
    });
    if (change === 'copied grant') f.execution.gateway = { ...f.receipt };
    try {
      await expect(runProximusHost(f.protocol, f.execution, execute)).rejects.toThrow();
      expect(execute).toHaveBeenCalledTimes(change === 'copied grant' ? 0 : change === 'result drift' ? 2 : 1);
    } finally { await f.cleanup(); }
  });
  it('refuses invalid process inputs or an already aborted run without starting a child', async () => {
    await expect(proximusHostProcess({ pythonBin: 'python', operation: 'run', maxWallClockMs: 1 })).rejects.toThrow(/Invalid/);
    await expect(proximusHostProcess({ pythonBin: '/python', operation: 'run', maxWallClockMs: 1,
      signal: AbortSignal.abort() })).rejects.toThrow(/aborted/);
  });
  it.each(['deadline', 'output'] as const)('kills and reaps the actual host child on %s failure', async cause => {
    const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    let child: ReturnType<typeof original.spawn> | undefined;
    vi.mocked(realSpawn).mockImplementationOnce((_command, _args, options) => {
      const program = cause === 'deadline' ? 'setInterval(() => {}, 1000)'
        : 'process.stdout.write("x".repeat(3 * 1024 * 1024));setInterval(() => {}, 1000)';
      child = original.spawn(process.execPath, ['-e', program], options);
      return child;
    });
    await expect(proximusHostProcess({ pythonBin: '/offline/python', operation: 'measure',
      maxWallClockMs: cause === 'deadline' ? 100 : 5_000 })).rejects.toThrow(cause === 'deadline' ? /deadline/ : /output limit/);
    expect(child!.signalCode).toBe('SIGKILL');
    expect(() => process.kill(child!.pid!, 0)).toThrow();
  });
  it('strips inherited credentials/proxies and sends the payload on stdin without exposing diagnostics', async () => {
    const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.stubEnv('OPENAI_API_KEY', 'host-provider-secret');
    vi.stubEnv('HTTPS_PROXY', 'http://unscoped-proxy');
    let command: string | undefined, args: readonly string[] | undefined;
    vi.mocked(realSpawn).mockImplementationOnce((bin, argv, options) => {
      command = bin; args = argv;
      const program = 'let data="";process.stdin.on("data",b=>{data+=b;if(data.includes("\\n")){process.stderr.write("private-request-diagnostic");process.stdout.write(JSON.stringify({secret:process.env.OPENAI_API_KEY??null,proxy:process.env.HTTPS_PROXY??null,payload:JSON.parse(data)}));process.exit(0)}})';
      return original.spawn(process.execPath, ['-e', program], options);
    });
    try {
      const result = await proximusHostProcess({ pythonBin: '/offline/python', operation: 'measure', maxWallClockMs: 5_000,
        stdin: JSON.stringify({ token: 'gateway-only-token' }) });
      expect(result).toEqual({ secret: null, proxy: null, payload: { token: 'gateway-only-token' } });
      expect(command).toBe('/offline/python');
      expect(args).toEqual(['-I', '-B', expect.stringMatching(/proximus-host.py$/), 'measure']);
      expect(args!.join(' ')).not.toContain('gateway-only-token');
    } finally { vi.unstubAllEnvs(); }
  });
  it('refuses an unconfined run before spawning any worker', async () => {
    await expect(proximusHostProcess({ pythonBin: '/offline/python', operation: 'run', maxWallClockMs: 1_000 }))
      .rejects.toThrow(/confined task binding/);
  });
  it.each(['valid', 'refused', 'wrong id'] as const)('correlates real process pipes and reaps the worker: %s', async mode => {
    const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const broker = { command: vi.fn(async (_args: unknown, _timeout: unknown) => {
      if (mode === 'refused') throw new Error('no lifecycle authority');
      return { return_code: 0, stdout: '猫', stderr: '' };
    }), stop: vi.fn(async () => {}) };
    vi.mocked(createProximusTaskBroker).mockResolvedValueOnce(broker);
    let child: ReturnType<typeof original.spawn> | undefined;
    vi.mocked(realSpawn).mockImplementationOnce((_bin, _argv, options) => {
      const program = `let n=0;require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        if(n++===0)process.stdout.write(JSON.stringify({kind:'task-command',id:${mode === 'wrong id' ? 2 : 1},args:['inspect','bound-task'],timeout:1})+'\\n');
        else{const value=JSON.parse(line);const out=Buffer.from(JSON.stringify({label:value.stdout}));
          const split=out.indexOf(Buffer.from('猫'))+1;process.stdout.write(out.subarray(0,split));
          setTimeout(()=>{process.stdout.write(out.subarray(split));process.exit(0)},5)}
      });`;
      return child = original.spawn(process.execPath, ['-e', program], options);
    });
    const result = proximusHostProcess({ pythonBin: '/offline/python', operation: 'run', maxWallClockMs: 5_000,
      stdin: JSON.stringify({ token: 'private-gateway-token' }), confinement: { trialDir: '/offline/trial',
        gatewayBaseURL: 'http://127.0.0.1:32105', task: { containerId: 'a'.repeat(64),
          image: 'task@sha256:' + 'b'.repeat(64), network: 'none', networkMode: 'no-network' } } });
    if (mode === 'valid') {
      await expect(result).resolves.toEqual({ label: '猫' });
      expect(broker.command).toHaveBeenCalledWith(['inspect', 'bound-task'], 1);
    } else {
      await expect(result).rejects.toThrow(mode === 'refused' ? /task command refused/ : /sequence/);
      expect(child!.signalCode).toBe('SIGKILL');
    }
    expect(broker.stop).toHaveBeenCalled();
    expect(() => process.kill(child!.pid!, 0)).toThrow();
  });
});

describe('Proximus attachment specification', () => {
  it('targets the existing immutable task and holds the hard deadline independently of upstream finalization', () => {
    const { protocol, execution } = fixture();
    const spec = proximusRunSpec(protocol, execution);
    expect(spec).toMatchObject({ agent: 'harbor_proximus:Proximus', sourceRevision: PROXIMUS_SOURCE_REVISION,
      harborVersion: '0.23.0', containerId: execution.handle.containerId, image: execution.handle.image,
      model: execution.model, modelName: `openai/${execution.model}`, maxWallClockMs: 1_000, maxUsd: 3,
      options: { time_budget_sec: 1, reasoning_effort: 'high', model_info: { max_input_tokens: 20_000, mode: 'responses' },
        llm_call_kwargs: { max_tokens: 10 } } });
    expect(Object.isFrozen(spec.options.llm_call_kwargs)).toBe(true);
    expect(spec.options).not.toHaveProperty('api_key');
    expect(spec.options).not.toHaveProperty('load_trajectory');
    expect(proximusRunSpec(protocol, { ...execution, maxWallClockMs: 500 }).maxWallClockMs).toBe(500);
  });
  it.each(['image', 'task', 'runtime', 'time', 'output', 'model', 'dollars'] as const)('refuses %s drift before spawn', change => {
    const { protocol, execution } = fixture();
    if (change === 'image') execution.handle.image = 'registry.example/task:latest';
    if (change === 'task') execution.handle.instanceId = 'other';
    if (change === 'runtime') execution.runtimeRevision = digest('other-installed-runtime');
    if (change === 'time') execution.maxWallClockMs++;
    if (change === 'output') execution.outputTokenLimit = 65;
    if (change === 'model') execution.model = 'other-model';
    if (change === 'dollars') execution.budget.maxUsd++;
    expect(() => proximusRunSpec(protocol, execution)).toThrow();
  });
  it('refuses the native-CLI launcher before any task or provider starts', () => {
    const { protocol, arm } = fixture();
    expect(() => currentBenchLaunchSelection({ arm: arm.id, taskSetId: 'custom', current: {
      workspaceId: 'bench-private', protocolRunId: protocol.runId, preregHash: digest('offline-preregistration'), seed: 1,
      observation: { runtimeWorkspaceId: 'bench-private', workerUnit: 'offline-worker', gatewayUnit: 'offline-gateway' },
    } }, protocol)).toThrow(/Unsupported current benchmark execution arm/);
  });
});

function providerFixture(provider: 'openai' | 'anthropic') {
  const f = fixture(provider), preregHash = digest('offline-preregistration'), secret = 'offline-test-credential';
  const claude = provider === 'anthropic';
  const credentialHeader = claude ? 'x-api-key' : 'authorization';
  const body = JSON.stringify({ model: f.arm.model, ...(claude ? { output_config: { effort: f.arm.effort }, max_tokens: 10 }
    : { reasoning: { effort: f.arm.effort }, max_output_tokens: 10 }) });
  const attempt: GatewayCarryTrialAttempt = { attemptId: 'offline-attempt', manifestSha256: preregHash,
    armId: currentBenchAssignmentId(f.protocol.runId, f.arm.id, 't1', 1),
    transport: claude ? 'anthropic-http' : 'bearer-http', accountId: 'offline-account',
    credentialHeader, credentialSha256: digest(claude ? secret : `Bearer ${secret}`),
    target: claude ? 'https://api.anthropic.com/v1/messages' : 'https://api.openai.com/v1/responses',
    body, bodySha256: digest(body), clockId: processMonotonicClock.id, signal: new AbortController().signal };
  const ceiling: CurrentBenchNativeInputCeiling = { model: f.arm.model, inputTokens: 10_000,
    sourceSha256: f.rate.inputTokenCeilingSourceSha256!, validUntilMonotonicMs: processMonotonicClock.now() + 10_000,
    validateAuthorization: vi.fn(() => {}) };
  type Ports = NonNullable<Parameters<typeof currentBenchProviderAuthenticator>[1]>;
  const ports: Ports = { readAccount: vi.fn<Ports['readAccount']>(async () => ({ id: attempt.accountId, provider: claude ? 'claude' : 'codex',
    credentialRef: 'token:offline' })), credentialResolver: vi.fn<Ports['credentialResolver']>(() => ({ kind: 'token', authMode: claude ? 'api-key' : 'oauth',
      current: async () => secret, invalidate: () => {} })) };
  const input = { workspaceId: 'bench-private', preregHash, protocol: f.protocol, armId: f.arm.id, taskId: 't1', seed: 1,
    readNativeInputCeiling: vi.fn(async () => ceiling) };
  const auth = currentBenchProviderAuthenticator(input, ports);
  return { ...f, input, ports, attempt, ceiling, auth };
}

describe('Proximus uses existing final-provider accounting authority', () => {
  it.each(['openai', 'anthropic'] as const)('reserves the authenticated %s request on the existing assignment ledger', async provider => {
    const f = providerFixture(provider);
    const reserve = vi.fn(async (_sql: Sql, q: ReserveLearningSpendInput) => {
      const reservation: LearningSpendReservation = { id: q.exact!.reservationId, workspaceId: q.workspaceId,
        loopId: q.loopId, potSlug: null, attemptKind: q.attemptKind!, requestedUsd: q.requestedUsd,
        reservedUsd: q.requestedUsd, usedUsd: 0, status: 'open', signalOrigin: 'organic',
        runRef: `manifest:${q.exact!.binding}/attempt:${q.exact!.reservationId}`, resources: { ...q.exact!.resources! },
        note: q.note ?? null, createdAt: Date.now(), settledAt: null };
      return { ok: true as const, clamped: false, headroomUsd: 60, reservation };
    });
    const controller = currentBenchGatewayController({ ...f.input,
      loopId: 'offline-loop', token: digest('offline-gateway-token'), authenticateProvider: f.auth.authenticateProvider,
      resources: { inputTokens: 20_000, outputTokens: 100, requestsPerArm: 2,
        armIds: f.protocol.arms.map(a => currentBenchAssignmentId(f.protocol.runId, a.id, 't1', 1)),
        usdPerArm: 3, maxOpenUsd: 3, wallClockMs: 2_000, wallClockMsPerArm: 1_000 } }, {
      enabled: async () => true, getSql: async () => ({} as Sql), reserve,
      settle: vi.fn(async () => ({ ok: false as const, reason: 'not-found' as const, reservation: null })),
      recordAttemptResult: vi.fn(async () => ({ ok: true })), log: () => {},
    });
    try {
      const receipt = await controller.gateway.carryTrial.authorizeAttempt(f.attempt);
      expect(receipt).not.toBeNull();
      expect(reserve).toHaveBeenCalledTimes(1);
      const saved = reserve.mock.calls[0][1];
      expect(saved.exact!.resources!.armId).toBe(f.attempt.armId);
      expect(saved.requestedUsd).toBe(provider === 'openai' ? 0.01002 : 0.01252);
      const note = JSON.parse(saved.note!);
      expect(note.nativeGatewayAttempt).toMatchObject({ bodySha256: f.attempt.bodySha256, transport: f.attempt.transport });
      expect(saved.note).not.toContain('offline-test-credential');
      // This deliberately leaves the provider result unknown: admission is not
      // a response, bill, terminal usage census or native acceptance claim.
    } finally { controller.revoke(); f.auth.revoke(); }
  });
  it.each(['openai', 'anthropic'] as const)('authorizes %s only with the final credential and counted frozen input', async provider => {
    const f = providerFixture(provider);
    try {
      const authority = await f.auth.authenticateProvider(f.attempt);
      expect(authority).toMatchObject({ attemptKind: 'evaluation', inputTokens: 10_000, outputTokens: 10 });
      expect(authority!.requestedUsd).toBeGreaterThan(0);
      expect(f.input.readNativeInputCeiling).toHaveBeenCalledTimes(1);
      expect(f.ports.credentialResolver).toHaveBeenCalledWith(provider === 'openai' ? 'codex' : 'claude', 'token:offline');
      authority!.validateAuthorization(); f.auth.revoke();
      expect(() => authority!.validateAuthorization()).toThrow(/revoked/);
    } finally { f.auth.revoke(); }
  });
  it.each(['route', 'model', 'effort', 'credential', 'input-proof', 'foreign-assignment'] as const)
  ('refuses %s drift through the same authenticator', async change => {
    const f = providerFixture('openai');
    let attempt = f.attempt;
    if (change === 'route') attempt = { ...attempt, target: 'https://api.openai.com/v1/chat/completions' };
    if (change === 'model' || change === 'effort') {
      const body = JSON.parse(f.attempt.body);
      if (change === 'model') body.model = 'other-model'; else body.reasoning.effort = 'low';
      const text = JSON.stringify(body); attempt = { ...attempt, body: text, bodySha256: digest(text) };
    }
    if (change === 'credential') attempt = { ...attempt, credentialSha256: digest('other-credential') };
    if (change === 'input-proof') f.ceiling.sourceSha256 = digest('other-count-source');
    if (change === 'foreign-assignment') attempt = { ...attempt, armId: 'other-assignment' };
    try { expect(await f.auth.authenticateProvider(attempt)).toBeNull(); } finally { f.auth.revoke(); }
  });
  it('cannot start a Codex native gateway as a Proximus runtime', async () => {
    const f = providerFixture('openai'), start = vi.fn();
    const controller = currentBenchGatewayController({ ...f.input,
      loopId: 'offline-loop', token: digest('offline-gateway-token'), authenticateProvider: async () => null,
      resources: { inputTokens: 20_000, outputTokens: 100, requestsPerArm: 2,
        armIds: f.protocol.arms.map(a => currentBenchAssignmentId(f.protocol.runId, a.id, 't1', 1)),
        usdPerArm: 3, maxOpenUsd: 3, wallClockMs: 2_000, wallClockMsPerArm: 1_000 } });
    try {
      await expect(controller.startNativeGateway(() => {}, start)).rejects.toThrow(/unsupported/);
      expect(start).not.toHaveBeenCalled();
    } finally { controller.revoke(); f.auth.revoke(); }
  });
  it.each(['openai', 'anthropic'] as const)('issues an explicit %s host grant and revokes copied/stale/foreign grants', async provider => {
    const f = providerFixture(provider), stop = vi.fn(async () => {});
    const controller = currentBenchGatewayController({ ...f.input,
      loopId: 'offline-loop', token: digest('offline-gateway-token'), authenticateProvider: f.auth.authenticateProvider,
      resources: { inputTokens: 20_000, outputTokens: 100, requestsPerArm: 2,
        armIds: f.protocol.arms.map(a => currentBenchAssignmentId(f.protocol.runId, a.id, 't1', 1)),
        usdPerArm: 3, maxOpenUsd: 3, wallClockMs: 2_000, wallClockMsPerArm: 1_000 } });
    const start = vi.fn(async () => ({ port: 32105, stop } as never));
    try {
      const hosted = await controller.startHostGateway(() => {}, start);
      const assignment = { armId: f.arm.id, taskId: 't1', seed: 1 };
      expect(requireCurrentBenchHostReferenceGateway(hosted, f.protocol, assignment)).toBe(hosted);
      expect(hosted.agent).toBe('proximus');
      expect(hosted.gateway.baseURL).toBe('http://127.0.0.1:32105');
      expect('nativeGateway' in hosted).toBe(false);
      expect('issueSessionBudget' in hosted).toBe(false);
      expect(() => requireCurrentBenchHostReferenceGateway({ ...hosted }, f.protocol, assignment)).toThrow(/controller-issued/);
      expect(() => requireCurrentBenchHostReferenceGateway(hosted, f.protocol, { ...assignment, seed: 2 })).toThrow(/assignment/);
      const changed = structuredClone(f.protocol); changed.runId = 'another-run';
      expect(() => requireCurrentBenchHostReferenceGateway(hosted, changed, assignment)).toThrow(/assignment/);
      await expect(controller.startHostGateway(() => {}, start)).rejects.toThrow(/already started/);
      expect(start).toHaveBeenCalledTimes(1);
      await hosted.stop(); await hosted.stop();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(() => requireCurrentBenchHostReferenceGateway(hosted, f.protocol, assignment)).toThrow(/live/);
    } finally { controller.revoke(); f.auth.revoke(); }
  });
  it('closes a host listener if authority is revoked while it starts', async () => {
    const f = providerFixture('openai'), stop = vi.fn(async () => {});
    const controller = currentBenchGatewayController({ ...f.input,
      loopId: 'offline-loop', token: digest('offline-gateway-token'), authenticateProvider: f.auth.authenticateProvider,
      resources: { inputTokens: 20_000, outputTokens: 100, requestsPerArm: 2,
        armIds: f.protocol.arms.map(a => currentBenchAssignmentId(f.protocol.runId, a.id, 't1', 1)),
        usdPerArm: 3, maxOpenUsd: 3, wallClockMs: 2_000, wallClockMsPerArm: 1_000 } });
    try {
      await expect(controller.startHostGateway(() => {}, async () => {
        controller.revoke(); return { port: 32106, stop } as never;
      })).rejects.toThrow(/revoked during startup/);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally { controller.revoke(); f.auth.revoke(); }
  });
});
