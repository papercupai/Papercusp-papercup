import { describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBearerCredentialResolver } from '../inference-gateway/credential-store';
import {
  currentBenchLaunchRequest, currentBenchRunLabel, currentBenchAttemptLabel, currentSuBenchHarnessDriver, currentStockBenchHarnessDriver,
  liveCurrentSuBenchPorts, recoverCurrentBenchRun, beginCurrentBenchNativeSession,
  currentBenchIdentityFromObservation, type CurrentBenchIdentityObservation,
  currentBenchObservationReader, liveCurrentBenchObservationReaderPorts, type CurrentBenchObservationReaderPorts,
  currentBenchAssignmentId, currentBenchGatewayController, currentBenchProviderAuthenticator,
  currentBenchOpenAiInputContract, currentBenchOpenAiInputReader,
  currentBenchCodexSubscriptionContract, currentBenchCodexSubscriptionInputReader, currentBenchCodexSubscriptionTarget,
  currentBenchNativeCostReader, currentBenchNativeSessionCostDelta, type CurrentBenchNativeCostReaderPorts,
  currentBenchAttemptPopulationMatches,
  type CurrentBenchNativeInputCeiling,
  type CurrentBenchIdentity, type CurrentBenchTask, type CurrentSuBenchOptions, type CurrentSuBenchPorts,
} from './current-su';
import { closedCodexSessionPopulation } from '../interactive-usage/ingest-adapters';
import type { BenchHarnessOps } from './bench-harness-live';
import type { BenchmarkContextReceipt } from './reproducibility/context';
import { evaluateSessionConfinement, type SessionToolConfinement } from '../capability-envelope/session-confinement';

const NEVER_EMIT_MARKER = 'never-emit-me';

describe('source-bound current benchmark cost', () => {
  function costFixture() {
    const protocol = currentProtocolFixture('run-1');
    const transcript = [
      { type: 'session_meta', payload: { id: 'native-cost-1' } },
      { type: 'turn_context', payload: { turn_id: 'turn-cost-1', model: 'configured-alias' } },
      { type: 'event_msg', payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: 100, output_tokens: 10 },
        last_token_usage: { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10 },
      } } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-cost-1' } },
    ].map(record => JSON.stringify(record) + '\n').join('');
    const population = closedCodexSessionPopulation({ transcript, file: '/private/native-cost-1.jsonl', fileGeneration: 0, nativeSessionId: 'native-cost-1' });
    if (!population.ok) throw new Error(population.detail);
    const usage = { ...population, file: '/private/native-cost-1.jsonl', sourceSha256: createHash('sha256').update(transcript).digest('hex') };
    const participant = { taskId: 'solver-task', ownerId: 'solver-owner', codexHome: '/private/home', terminal: true,
      startedAtMs: 100, endedAtMs: 200 };
    const runtime = { complete: true, sessions: [{ nativeSessionId: 'native-cost-1', usage }] };
    const ports: CurrentBenchNativeCostReaderPorts = {
      readParticipants: vi.fn(async () => [participant]), readRuntime: vi.fn(async () => runtime),
      readBilled: vi.fn(async () => ({ knownSubtotalUsd: 0.002, complete: true })),
      readAttemptAccountingComplete: vi.fn(async () => true),
    };
    return { protocol, participant, runtime, usage, ports, read: () => currentBenchNativeCostReader(protocol, ports)() };
  }
  it('keeps frozen normalized tokens and actual billed cost separately labelled', async () => {
    const f = costFixture(), result = await f.read();
    expect(result).toMatchObject({ tokensIn: 80, tokensOut: 10, tokensCacheRead: 20, tokensCacheWrite: 0, turns: 1, costUsdMeasurementMissing: false });
    expect(result.costUsd).toBeCloseTo(0.00011, 10);
    expect(result.armMeta).toMatchObject({ nativeCostAccounting: { basis: 'frozen-normalized-native-source',
      normalizedCostUsd: result.costUsd, billedCostUsd: 0.002, billedKnownSubtotalUsd: 0.002, missingSources: 0, missingBills: 0,
      sources: [{ nativeSessionId: 'native-cost-1', sourceSha256: f.usage.sourceSha256, sourceComplete: true,
        usageEventKeys: f.usage.events.map(event => event.usageEventKey), nativeTurnIds: ['turn-cost-1'],
        tokensIn: 80, tokensOut: 10, tokensCacheRead: 20, tokensCacheWrite: 0, turns: 1,
        normalizedCostUsd: result.costUsd, billedKnownSubtotalUsd: 0.002, billedCostUsd: 0.002 }] } });
  });
  it('retains separately metered fresh-session rows across cumulative reads', async () => {
    const f = costFixture(), first = await f.read();
    const secondUsage = structuredClone(f.usage);
    secondUsage.sourceSha256 = 'b'.repeat(64);
    secondUsage.nativeTurnIds = ['turn-cost-2'];
    secondUsage.events = secondUsage.events.map(event => ({ ...event, usageEventKey: event.usageEventKey + '/second',
      turnId: 'turn-cost-2', usage: { ...event.usage, inputTokens: 160, outputTokens: 20, cacheReadTokens: 40 } }));
    f.runtime.sessions.push({ nativeSessionId: 'native-cost-2', usage: secondUsage });
    vi.mocked(f.ports.readBilled).mockImplementation(async (_participant, id) =>
      ({ knownSubtotalUsd: id === 'native-cost-2' ? 0.005 : 0.002, complete: true }));
    const second = await f.read();
    expect(first).toMatchObject({ tokensIn: 80, tokensOut: 10, turns: 1 });
    expect(second).toMatchObject({ tokensIn: 240, tokensOut: 30, tokensCacheRead: 60, turns: 2,
      armMeta: { nativeCostAccounting: { billedCostUsd: 0.007, sources: [
        { nativeSessionId: 'native-cost-1', tokensIn: 80, tokensOut: 10, billedCostUsd: 0.002 },
        { nativeSessionId: 'native-cost-2', sourceSha256: 'b'.repeat(64), sourceComplete: true,
          usageEventKeys: secondUsage.events.map(event => event.usageEventKey), nativeTurnIds: ['turn-cost-2'],
          tokensIn: 160, tokensOut: 20, tokensCacheRead: 40, turns: 1,
          normalizedCostUsd: expect.closeTo(first.costUsd * 2, 10), billedCostUsd: 0.005 },
      ] } } });
    // The retained first read must not acquire the next session's identities.
    expect(first.armMeta).toMatchObject({ nativeCostAccounting: { sources: [
      { nativeSessionId: 'native-cost-1', nativeTurnIds: ['turn-cost-1'] },
    ] } });
    const delta = currentBenchNativeSessionCostDelta(first, second, 'native-cost-2');
    expect(delta).toMatchObject({ nativeSessionId: 'native-cost-2', tokensIn: 160, tokensOut: 20,
      tokensCacheRead: 40, turns: 1, normalizedCostUsd: expect.closeTo(first.costUsd * 2, 10), billedCostUsd: 0.005 });
    // A consumer cannot mutate either retained cumulative receipt through the delta.
    delta.nativeTurnIds.push('untrusted-turn');
    expect(second.armMeta.nativeCostAccounting.sources[1].nativeTurnIds).toEqual(['turn-cost-2']);
    expect(() => currentBenchNativeSessionCostDelta(second, second, 'native-cost-2')).toThrow(/reused/);
    expect(() => currentBenchNativeSessionCostDelta(null, second, 'native-cost-2')).toThrow(/non-monotone/);
  });
  it('selects a first session from a complete source receipt without conflating normalized and billed cost', async () => {
    const f = costFixture(), first = await f.read();
    expect(currentBenchNativeSessionCostDelta(null, first, 'native-cost-1')).toMatchObject({
      tokensIn: 80, tokensCacheRead: 20, tokensOut: 10, billedCostUsd: 0.002,
      normalizedCostUsd: expect.closeTo(0.00011, 10),
    });
  });
  it.each(['bill', 'attempts', 'census', 'aggregate', 'duplicate-event', 'source-hash', 'turns', 'price', 'source-total', 'protocol-hash'] as const)(
    'refuses a fresh-session delta with invalid %s evidence', async field => {
      const f = costFixture(), cost = await f.read(), a = cost.armMeta.nativeCostAccounting;
      if (field === 'bill') a.sources[0].billedCostUsd = null;
      if (field === 'attempts') a.attemptAccountingComplete = false;
      if (field === 'census') a.sourceCensusComplete = false;
      if (field === 'aggregate') cost.tokensIn++;
      if (field === 'duplicate-event') a.sources[0].usageEventKeys.push(a.sources[0].usageEventKeys[0]);
      if (field === 'source-hash') a.sources[0].sourceSha256 = '';
      if (field === 'turns') a.sources[0].nativeTurnIds.push(a.sources[0].nativeTurnIds[0]);
      if (field === 'price') a.normalizedCostUsd += 1;
      if (field === 'source-total') a.sources[0].tokensCacheRead++;
      if (field === 'protocol-hash') a.preregHash = '';
      expect(() => currentBenchNativeSessionCostDelta(null, cost, 'native-cost-1')).toThrow(/incomplete/);
    });
  it('refuses changed historical source evidence and a changed frozen price schedule', async () => {
    const f = costFixture(), first = await f.read();
    const secondUsage = structuredClone(f.usage);
    secondUsage.sourceSha256 = 'b'.repeat(64);
    secondUsage.nativeTurnIds = ['turn-cost-2'];
    secondUsage.events = secondUsage.events.map(event => ({ ...event,
      usageEventKey: event.usageEventKey + '/second', turnId: 'turn-cost-2' }));
    f.runtime.sessions.push({ nativeSessionId: 'native-cost-2', usage: secondUsage });
    const second = await f.read();
    expect(currentBenchNativeSessionCostDelta(first, second, 'native-cost-2').tokensIn).toBe(80);
    const altered = structuredClone(second);
    altered.armMeta.nativeCostAccounting.sources[0].sourceSha256 = 'c'.repeat(64);
    expect(() => currentBenchNativeSessionCostDelta(first, altered, 'native-cost-2')).toThrow(/non-monotone/);
    altered.armMeta.nativeCostAccounting.sources[0].sourceSha256 = f.usage.sourceSha256;
    altered.armMeta.nativeCostAccounting.priceTableVersion = 'other-price-schedule';
    expect(() => currentBenchNativeSessionCostDelta(first, altered, 'native-cost-2')).toThrow(/non-monotone/);
    altered.armMeta.nativeCostAccounting.priceTableVersion = first.armMeta.nativeCostAccounting.priceTableVersion;
    altered.armMeta.nativeCostAccounting.preregHash = 'd'.repeat(64);
    expect(() => currentBenchNativeSessionCostDelta(first, altered, 'native-cost-2')).toThrow(/non-monotone/);
    expect(() => currentBenchNativeSessionCostDelta(second, first, 'native-cost-3')).toThrow(/non-monotone/);
  });
  it.each(['bill', 'attempts', 'census'] as const)('does not certify a session bill from incomplete %s evidence', async missing => {
    const f = costFixture();
    if (missing === 'bill') vi.mocked(f.ports.readBilled).mockResolvedValue({ knownSubtotalUsd: 0.001, complete: false });
    if (missing === 'attempts') vi.mocked(f.ports.readAttemptAccountingComplete!).mockResolvedValue(false);
    if (missing === 'census') f.runtime.complete = false;
    expect(await f.read()).toMatchObject({ costUsdMeasurementMissing: true, armMeta: { nativeCostAccounting: {
      billedCostUsd: null, sources: [{ nativeSessionId: 'native-cost-1', tokensIn: 80, tokensOut: 10,
        billedKnownSubtotalUsd: missing === 'bill' ? 0.001 : 0.002, billedCostUsd: null }],
    } } });
  });
  it('preserves a known billed subtotal without treating an incomplete provider bill as complete', async () => {
    const f = costFixture(); vi.mocked(f.ports.readBilled).mockResolvedValue({ knownSubtotalUsd: 0.001, complete: false });
    const result = await f.read();
    expect(result.costUsd).toBeCloseTo(0.00011, 10);
    expect(result).toMatchObject({ costUsdMeasurementMissing: true, armMeta: { nativeCostAccounting: { billedCostUsd: null, billedKnownSubtotalUsd: 0.001, missingBills: 1 } } });
  });
  it('keeps efficiency claims closed when native usage is complete but gateway attempts are unreconciled', async () => {
    const f = costFixture(); delete f.ports.readAttemptAccountingComplete;
    expect(await f.read()).toMatchObject({ costUsdMeasurementMissing: true,
      armMeta: { nativeCostAccounting: { sourceCensusComplete: true, attemptAccountingComplete: false, billedCostUsd: null } } });
  });
  it('retains known sources while a recovered predecessor source is unavailable', async () => {
    const f = costFixture(); f.runtime.complete = false;
    f.runtime.sessions.push({ nativeSessionId: 'old-native', usage: { ok: false, detail: 'source missing' } as never });
    const result = await f.read(); expect(result.costUsd).toBeCloseTo(0.00011, 10);
    expect(result).toMatchObject({ costUsdMeasurementMissing: true, armMeta: { nativeCostAccounting: { missingSources: 1, billedCostUsd: null } } });
  });
  it('retains source-proven closed-turn tokens and bills while a later turn remains unknown', async () => {
    const f = costFixture();
    vi.mocked(f.ports.readRuntime).mockResolvedValue({ complete: false,
      sessions: [{ nativeSessionId: 'native-cost-1', usage: { ok: false, detail: 'later turn incomplete', knownSubtotal: f.usage } }] });
    const result = await f.read();
    expect(result.costUsd).toBeCloseTo(0.00011, 10);
    expect(result).toMatchObject({ tokensIn: 80, tokensOut: 10, tokensCacheRead: 20, costUsdMeasurementMissing: true,
      armMeta: { nativeCostAccounting: { billedCostUsd: null, billedKnownSubtotalUsd: 0.002, missingSources: 1 } } });
    expect(f.ports.readBilled).toHaveBeenCalledWith(f.participant, 'native-cost-1', f.usage);
  });
  it('charges one shared recovery home once while retaining each participating task', async () => {
    const f = costFixture(); vi.mocked(f.ports.readParticipants).mockResolvedValue([f.participant, { ...f.participant, taskId: 'recovery-task' }]);
    const result = await f.read(); expect(result.costUsd).toBeCloseTo(0.00011, 10); expect(f.ports.readRuntime).toHaveBeenCalledOnce();
    expect(result.armMeta).toMatchObject({ nativeCostAccounting: { participantTaskIds: ['recovery-task', 'solver-task'] } });
  });
  it('keeps overlapping recovery lifetimes separate while charging their shared native home once', async () => {
    const f = costFixture();
    vi.mocked(f.ports.readParticipants).mockResolvedValue([f.participant,
      { ...f.participant, taskId: 'recovery-task', startedAtMs: 190, endedAtMs: 210 }]);
    const result = await f.read();
    expect(result.costUsd).toBeCloseTo(0.00011, 10);
    expect(result.armMeta).toMatchObject({ nativeCostAccounting: { taskLedgerConcurrency: {
      basis: 'task-ledger-lifetime', averageBasis: 'time-weighted', complete: true,
      wallClockMs: 110, participantWallClockMs: 120,
      concurrencyTimeline: { peakConcurrent: 2, avgConcurrent: 120 / 110,
        samples: [{ tMs: 0, live: 1 }, { tMs: 90, live: 2 }, { tMs: 100, live: 1 }, { tMs: 110, live: 0 }] } } } });
  });
  it('BM-P-005-wall-concurrency: reports elapsed wall-clock and concurrency for overlapping versus sequential participants with equal calls', async () => {
    const run = async (second: { startedAtMs: number; endedAtMs: number }) => {
      const f = costFixture();
      vi.mocked(f.ports.readParticipants).mockResolvedValue([f.participant, { ...f.participant, taskId: 'reviewer-task', ...second }]);
      return f.read();
    };
    const overlapping = await run({ startedAtMs: 100, endedAtMs: 200 });
    const sequential = await run({ startedAtMs: 200, endedAtMs: 300 });
    // Same participants, same native calls and cost: only the schedule differs.
    expect(overlapping.turns).toBe(sequential.turns);
    expect(overlapping.costUsd).toBeCloseTo(sequential.costUsd, 12);
    expect(overlapping.armMeta).toMatchObject({ nativeCostAccounting: { taskLedgerConcurrency: { complete: true,
      wallClockMs: 100, participantWallClockMs: 200, concurrencyTimeline: { peakConcurrent: 2, avgConcurrent: 2 } } } });
    expect(sequential.armMeta).toMatchObject({ nativeCostAccounting: { taskLedgerConcurrency: { complete: true,
      wallClockMs: 200, participantWallClockMs: 200, concurrencyTimeline: { peakConcurrent: 1, avgConcurrent: 1 } } } });
  });
  it('BM-P-005-normalized-cost: prices one measured token ledger with the recorded schedule, not a later live schedule', async () => {
    const f = costFixture();
    const reader = currentBenchNativeCostReader(f.protocol, f.ports);
    const recorded = await reader();
    expect(recorded.costUsd).toBeCloseTo((80 * 1 + 20 * 0.5 + 10 * 2) / 1e6, 12);
    // The live schedule changes after the run froze its prices. Replaying the same ledger keeps the recorded prices.
    const rate = f.protocol.priceSchedule.rates[0];
    rate.inputUsdPerMillion = 100; rate.outputUsdPerMillion = 200; f.protocol.priceSchedule.version = 'live-prices-v2';
    const replay = await reader();
    expect(replay).toMatchObject({ tokensIn: recorded.tokensIn, tokensOut: recorded.tokensOut, tokensCacheRead: recorded.tokensCacheRead });
    expect(replay.costUsd).toBeCloseTo(recorded.costUsd, 12);
    expect(replay.armMeta).toMatchObject({ nativeCostAccounting: { priceTableVersion: 'frozen-prices-v1', normalizedCostUsd: recorded.costUsd } });
    // A run frozen under the changed schedule prices the same ledger differently, so the equality above is
    // the recorded schedule at work rather than a constant.
    const changed = await currentBenchNativeCostReader(f.protocol, f.ports)();
    expect(changed.costUsd).toBeCloseTo((80 * 100 + 20 * 0.5 + 10 * 200) / 1e6, 12);
    expect(changed.armMeta).toMatchObject({ nativeCostAccounting: { priceTableVersion: 'live-prices-v2' } });
  });
  it.each(['missing-end', 'invalid-start', 'live', 'census-drift', 'duplicate-task'] as const)
  ('keeps task lifetime measurement unknown for %s', async change => {
    const f = costFixture();
    if (change === 'missing-end') delete (f.participant as Partial<typeof f.participant>).endedAtMs;
    if (change === 'invalid-start') f.participant.startedAtMs = NaN;
    if (change === 'live') f.participant.terminal = false;
    if (change === 'census-drift') vi.mocked(f.ports.readParticipants).mockResolvedValueOnce([f.participant]).mockResolvedValue([]);
    if (change === 'duplicate-task') vi.mocked(f.ports.readParticipants).mockResolvedValue([f.participant, { ...f.participant }]);
    expect(await f.read()).toMatchObject({ armMeta: { nativeCostAccounting: { taskLedgerConcurrency: {
      complete: false, wallClockMs: null, participantWallClockMs: null, concurrencyTimeline: null } } } });
  });
  it.each(['live', 'changed-census', 'foreign-owner-home', 'duplicate-source', 'unknown-price', 'invalid-bill'] as const)('refuses completeness for %s', async changed => {
    const f = costFixture();
    if (changed === 'live') f.participant.terminal = false;
    if (changed === 'changed-census') vi.mocked(f.ports.readParticipants).mockResolvedValueOnce([f.participant]).mockResolvedValueOnce([]);
    if (changed === 'foreign-owner-home') vi.mocked(f.ports.readParticipants).mockResolvedValue([f.participant, { ...f.participant, taskId: 'other-task', ownerId: 'foreign-owner' }]);
    if (changed === 'duplicate-source') f.runtime.sessions.push(f.runtime.sessions[0]);
    if (changed === 'unknown-price') f.usage.events[0].model = 'unregistered-model';
    if (changed === 'invalid-bill') vi.mocked(f.ports.readBilled).mockResolvedValue({ knownSubtotalUsd: NaN, complete: true });
    expect(await f.read()).toMatchObject({ costUsdMeasurementMissing: true, armMeta: { nativeCostAccounting: { billedCostUsd: null } } });
  });
  it('passes native cache and source metadata through the maintained driver without consulting the legacy subtotal', async () => {
    const f = fixture();
    f.ports.collectCost = vi.fn(async () => ({ tokensIn: 80, tokensOut: 10, tokensCacheRead: 20, tokensCacheWrite: 5,
      costUsd: 0.00012, turns: 1, costUsdMeasurementMissing: true, armMeta: { nativeCostAccounting: { billedCostUsd: null } } }));
    const result = await f.run();
    expect(result.telemetry).toMatchObject({ tokensIn: 80, tokensCacheRead: 20, tokensCacheWrite: 5, costUsd: 0.00012,
      armMeta: { costUsdMeasurementMissing: true, nativeCostAccounting: { billedCostUsd: null }, currentExecution: expect.any(Object) } });
    expect(f.lifecycle.collectCost).not.toHaveBeenCalled();
  });

  function attemptFixture() {
    const f = costFixture();
    const binding = { workspaceId: 'bench-private', loopId: 'exact-private-loop', runId: 'run-1',
      preregHash: 'a'.repeat(64), assignmentId: currentBenchAssignmentId('run-1', 'papercusp', 't1', 1) };
    const identity = { attemptId: 'provider-attempt-1', manifestSha256: binding.preregHash, armId: binding.assignmentId,
      nativeSessionId: 'native-cost-1', nativeTurnId: 'turn-cost-1', transport: 'bearer-http',
      accountId: 'provider-account', credentialHeader: 'authorization', credentialSha256: 'b'.repeat(64),
      target: 'https://api.openai.com/v1/responses', bodySha256: 'c'.repeat(64), clockId: 'host-clock' };
    const result = { ...identity, reservationRef: identity.attemptId, outcome: 'response-completed', responseStatus: 200,
      costUsdMeasurementMissing: true, responseSha256: 'd'.repeat(64), responseBytes: 300,
      providerCompletion: { responseId: 'response-1', model: 'configured-alias', providerEffort: 'high',
        usage: { inputTokenBasis: 'inclusive', inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheCreationTokens: 0 } } };
    const row: LearningSpendReservation = { id: identity.attemptId, workspaceId: binding.workspaceId, loopId: binding.loopId,
      potSlug: null, attemptKind: 'evaluation', requestedUsd: 0.003, reservedUsd: 0.003, usedUsd: 0,
      status: 'open', signalOrigin: 'organic', runRef: `manifest:${binding.preregHash}/attempt:${identity.attemptId}`,
      note: JSON.stringify({ nativeGatewayAttempt: identity, nativeGatewayAttemptResult: result }), createdAt: 1, settledAt: null,
      resources: { armId: binding.assignmentId, inputTokens: 200, outputTokens: 100 } };
    const population = { participants: [f.participant], sources: [{ participant: f.participant, nativeSessionId: 'native-cost-1', usage: f.usage }] };
    const census = { status: 'complete' as const, source: 'learning-spend-reservations' as const,
      populationSha256: 'e'.repeat(64), reservations: [row] };
    const save = () => { row.note = JSON.stringify({ nativeGatewayAttempt: identity, nativeGatewayAttemptResult: result }); };
    return { ...f, binding, identity, result, row, population, census, save,
      matches: () => currentBenchAttemptPopulationMatches(binding, population, census, structuredClone(census)) };
  }
  it('joins provider request evidence to host-native turn/model/inclusive cache usage without releasing unknown billing headroom', () => {
    const f = attemptFixture(); expect(f.matches()).toBe(true);
    expect(f.row.status).toBe('open'); expect(f.row.usedUsd).toBe(0);
  });
  it.each(['missing', 'extra', 'wrong-turn', 'wrong-session', 'wrong-model', 'wrong-cache', 'unknown-cache',
    'failed-fetch', 'headers-only', 'incomplete-response', 'live', 'foreign-loop', 'foreign-workspace',
    'wrong-manifest', 'foreign-arm', 'identity-drift', 'missing-source-hash', 'duplicate-native-key',
    'ambiguous-native-requests', 'duplicate-provider-response', 'unknown-refused-charge', 'invalid-json'] as const)
  ('refuses request population completeness for %s', change => {
    const f = attemptFixture();
    if (change === 'missing') f.census.reservations = [];
    if (change === 'extra') {
      const second = structuredClone(f.row), note = JSON.parse(second.note!);
      second.id = 'extra-attempt'; second.runRef = `manifest:${f.binding.preregHash}/attempt:${second.id}`;
      note.nativeGatewayAttempt.attemptId = second.id;
      note.nativeGatewayAttemptResult.attemptId = second.id; note.nativeGatewayAttemptResult.reservationRef = second.id;
      note.nativeGatewayAttemptResult.providerCompletion.responseId = 'response-extra'; second.note = JSON.stringify(note);
      f.census.reservations.push(second);
    }
    if (change === 'wrong-turn') { f.identity.nativeTurnId = 'foreign-turn'; f.result.nativeTurnId = 'foreign-turn'; }
    if (change === 'wrong-session') { f.identity.nativeSessionId = 'foreign-session'; f.result.nativeSessionId = 'foreign-session'; }
    if (change === 'wrong-model') f.result.providerCompletion.model = 'foreign-model';
    if (change === 'wrong-cache') f.result.providerCompletion.usage.cacheReadTokens++;
    if (change === 'unknown-cache') f.result.providerCompletion.usage.cacheReadTokens = null as never;
    if (change === 'failed-fetch') f.result.outcome = 'fetch-failed';
    if (change === 'headers-only') f.result.outcome = 'response-headers';
    if (change === 'incomplete-response') f.result.outcome = 'response-incomplete';
    if (change === 'live') f.participant.terminal = false;
    if (change === 'foreign-loop') f.row.loopId = 'wrong-loop';
    if (change === 'foreign-workspace') f.row.workspaceId = 'wrong-workspace';
    if (change === 'wrong-manifest') f.identity.manifestSha256 = 'f'.repeat(64);
    if (change === 'foreign-arm') { f.identity.armId = currentBenchAssignmentId('run-1', 'baseline', 't1', 1);
      f.result.armId = f.identity.armId; f.row.resources!.armId = f.identity.armId; }
    if (change === 'identity-drift') f.result.bodySha256 = 'f'.repeat(64);
    if (change === 'missing-source-hash') f.usage.sourceSha256 = '';
    if (change === 'duplicate-native-key') f.usage.events = [...f.usage.events, f.usage.events[0]];
    if (change === 'ambiguous-native-requests') f.usage.events = [...f.usage.events,
      { ...f.usage.events[0], usageEventKey: 'distinct-native-request' }];
    if (change === 'duplicate-provider-response') f.census.reservations.push(structuredClone(f.row));
    if (change === 'unknown-refused-charge') { f.result.outcome = 'send-refused'; f.row.status = 'cancelled'; }
    f.save();
    if (change === 'invalid-json') f.row.note = '{';
    expect(f.matches()).toBe(false);
  });
  it('requires the same complete reservation population before and after native source validation', () => {
    const f = attemptFixture(), after = structuredClone(f.census);
    after.populationSha256 = 'f'.repeat(64);
    expect(currentBenchAttemptPopulationMatches(f.binding, f.population, f.census, after)).toBe(false);
    after.populationSha256 = f.census.populationSha256; after.reservations[0].usedUsd = 0.001;
    expect(currentBenchAttemptPopulationMatches(f.binding, f.population, f.census, after)).toBe(false);
    expect(currentBenchAttemptPopulationMatches(f.binding, f.population, f.census,
      { status: 'unavailable', source: 'learning-spend-reservations', reason: 'schema-unavailable' })).toBe(false);
  });
  it('includes an explicitly zero-charge refusal alongside completed native requests', () => {
    const f = attemptFixture(), refused = structuredClone(f.row), note = JSON.parse(refused.note!);
    refused.id = 'pre-fetch-refusal'; refused.status = 'cancelled';
    refused.runRef = `manifest:${f.binding.preregHash}/attempt:${refused.id}`;
    note.nativeGatewayAttempt.attemptId = refused.id;
    note.nativeGatewayAttemptResult = { ...note.nativeGatewayAttempt, reservationRef: refused.id,
      outcome: 'send-refused', responseStatus: null, costUsd: 0, costUsdMeasurementMissing: false };
    refused.note = JSON.stringify(note); f.census.reservations.push(refused);
    expect(f.matches()).toBe(true);
  });
  it('retains another assignment in the full loop census without charging its distinct native session twice', () => {
    const f = attemptFixture(), other = structuredClone(f.row), note = JSON.parse(other.note!);
    other.id = 'other-assignment-attempt'; other.resources!.armId = currentBenchAssignmentId('run-1', 'baseline', 't1', 1);
    other.runRef = `manifest:${f.binding.preregHash}/attempt:${other.id}`;
    Object.assign(note.nativeGatewayAttempt, { attemptId: other.id, armId: other.resources!.armId, nativeSessionId: 'other-native' });
    other.note = JSON.stringify(note); f.census.reservations.push(other);
    expect(f.matches()).toBe(true);
  });
  it('passes the exact host-native population to the accounting verifier', async () => {
    const f = costFixture(); await f.read();
    expect(f.ports.readAttemptAccountingComplete).toHaveBeenCalledWith({ participants: [f.participant],
      sources: [{ participant: f.participant, nativeSessionId: 'native-cost-1', usage: f.usage,
        billed: { knownSubtotalUsd: 0.002, complete: true } }] });
  });
  it('rejects a new participant appearing during gateway reconciliation', async () => {
    const f = costFixture();
    vi.mocked(f.ports.readAttemptAccountingComplete!).mockImplementation(async () => {
      vi.mocked(f.ports.readParticipants).mockResolvedValue([f.participant, { ...f.participant, taskId: 'late-reviewer' }]);
      return true;
    });
    expect(await f.read()).toMatchObject({ costUsdMeasurementMissing: true,
      armMeta: { nativeCostAccounting: { sourceCensusComplete: false, billedCostUsd: null } } });
  });
});
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import { allCapabilities, currentProtocolFixture, controlledProtocolFixture, currentNativeCostFixture } from './reproducibility/_protocol-test-fixture';
import { GatewayRequestTelemetry } from '../inference-gateway/request-stage-telemetry';
import type { RuntimeVintageRow } from '../runtime-vintage';
import { processMonotonicClock } from '../process-monotonic-clock';
import type { GatewayCarryTrialAttempt, GatewayCarryTrialAttemptResult } from '../inference-gateway/gateway';
import type { NativeGymProviderAuthorization } from '../gym/proposer';
import type { LearningSpendReservation, ReserveLearningSpendInput, SettleLearningSpendInput } from '../learning-governor/store';
import type { Sql } from 'postgres';

function budgetFixture() {
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  const protocol = currentProtocolFixture();
  const resources = { inputTokens: 10_000, outputTokens: 1000, requestsPerArm: 50,
    armIds: protocol.arms.map(arm => currentBenchAssignmentId(protocol.runId, arm.id, 't1', 1)),
    usdPerArm: 3, maxOpenUsd: 3, wallClockMs: 1000, wallClockMsPerArm: 100 };
  const authority: NativeGymProviderAuthorization = { attemptKind: 'evaluation', requestedUsd: 0.001,
    inputTokens: 100, outputTokens: 10, validUntilMonotonicMs: processMonotonicClock.now() + 10_000,
    validateAuthorization: vi.fn(() => {}) };
  const reserve = vi.fn(async (_sql: Sql, q: ReserveLearningSpendInput) => {
    const reservation: LearningSpendReservation = { id: q.exact!.reservationId, workspaceId: q.workspaceId,
      loopId: q.loopId, potSlug: null, attemptKind: q.attemptKind!, requestedUsd: q.requestedUsd,
      reservedUsd: q.requestedUsd, usedUsd: 0, status: 'open', signalOrigin: 'organic',
      runRef: `manifest:${q.exact!.binding}/attempt:${q.exact!.reservationId}`, resources: { ...q.exact!.resources! },
      note: q.note ?? null, createdAt: Date.now(), settledAt: null };
    return { ok: true as const, clamped: false, headroomUsd: 60, reservation };
  });
  const settle = vi.fn(async (_sql: Sql, q: SettleLearningSpendInput) => ({ ok: false as const,
    reason: 'not-found' as const, reservation: null }));
  const input = { workspaceId: 'bench-private', loopId: 'benchmark-run-1', token: randomUUID(), preregHash: digest('frozen'),
    protocol, resources, armId: 'papercusp', taskId: 't1', seed: 1,
    authenticateProvider: vi.fn(async (): Promise<NativeGymProviderAuthorization | null> => authority) };
  const governor = { enabled: async () => true, getSql: async () => ({} as Sql), reserve, settle,
    recordAttemptResult: vi.fn(async () => ({ ok: true })), log: () => {} };
  const controller = currentBenchGatewayController(input, governor);
  const body = JSON.stringify({ model: 'configured-alias', reasoning: { effort: 'high' }, max_output_tokens: 10 });
  const attempt: GatewayCarryTrialAttempt = { attemptId: randomUUID(), manifestSha256: input.preregHash,
    armId: controller.gateway.carryTrial.armId, transport: 'bearer-http', accountId: 'authenticated-account',
    credentialHeader: 'authorization', credentialSha256: digest(`Bearer ${NEVER_EMIT_MARKER}`),
    target: 'https://provider.invalid/v1/responses', body, bodySha256: digest(body),
    clockId: processMonotonicClock.id, signal: new AbortController().signal };
  const result = (request: GatewayCarryTrialAttempt, reservationRef: string, outcome: 'send-refused' | 'fetch-failed' | 'response-headers') => {
    const { body: _body, signal: _signal, ...identity } = request;
    return { ...identity, reservationRef, outcome, responseStatus: outcome === 'response-headers' ? 200 : null,
      ...(outcome === 'send-refused' ? { costUsd: 0, costUsdMeasurementMissing: false } : { costUsdMeasurementMissing: true }) } as GatewayCarryTrialAttemptResult;
  };
  return { ...controller, input, governor, reserve, settle, authority, attempt, digest, result };
}

describe('frozen benchmark native provider admission', () => {
  it('captures the immutable authenticated request at the host before reserving or sending', async () => {
    const f = budgetFixture();
    const captureProviderInput = vi.fn(async (request: Readonly<GatewayCarryTrialAttempt>) => {
      expect(Object.isFrozen(request)).toBe(true);
      expect(request.body).toBe(f.attempt.body);
      expect(request.bodySha256).toBe(f.digest(request.body));
      expect(f.input.authenticateProvider).toHaveBeenCalledOnce();
      expect(f.reserve).not.toHaveBeenCalled();
    });
    const controller = currentBenchGatewayController({ ...f.input, captureProviderInput }, f.governor);
    try {
      const receipt = await controller.gateway.carryTrial.authorizeAttempt(f.attempt);
      expect(receipt).not.toBeNull(); expect(captureProviderInput).toHaveBeenCalledOnce();
      expect(f.reserve).toHaveBeenCalledOnce();
      await receipt!.observeAttemptResult!(f.result(f.attempt, receipt!.reservationRef, 'send-refused'));
    } finally { controller.revoke(); f.revoke(); }
  });
  it.each(['capture-failed', 'protocol-refused'])('refuses %s without a reservation or an inferred send', async fault => {
    const f = budgetFixture(), captureProviderInput = vi.fn(async () => { throw new Error('Private capture failed'); });
    const controller = currentBenchGatewayController({ ...f.input, captureProviderInput }, f.governor);
    const request = fault === 'protocol-refused' ? { ...f.attempt,
      body: JSON.stringify({ model: 'foreign-model', reasoning: { effort: 'high' }, max_output_tokens: 10 }) } : f.attempt;
    try {
      expect(await controller.gateway.carryTrial.authorizeAttempt(request)).toBeNull();
      expect(captureProviderInput).toHaveBeenCalledTimes(fault === 'capture-failed' ? 1 : 0);
      expect(f.reserve).not.toHaveBeenCalled();
    } finally { controller.revoke(); f.revoke(); }
  });

  it('requires the atomic combined-token policy to match the frozen generation cap', () => {
    const f = budgetFixture();
    const protocol = structuredClone(f.input.protocol);
    for (const arm of protocol.arms) arm.generationBudget.maxTokens = 110;
    for (const totalTokensPerArm of [undefined, 109, 111]) {
      expect(() => currentBenchGatewayController({ ...f.input, protocol,
        resources: { ...f.input.resources, totalTokensPerArm } }, f.governor)).toThrow(/frozen protocol/);
    }
    f.revoke();
  });

  it('refuses a request whose complete input plus output exceeds the frozen assignment token cap', async () => {
    const f = budgetFixture();
    for (const limit of [109, 110]) {
      const protocol = structuredClone(f.input.protocol);
      for (const arm of protocol.arms) arm.generationBudget.maxTokens = limit;
      const totalTokensPerArm = limit;
      const controller = currentBenchGatewayController({ ...f.input, protocol,
        resources: { ...f.input.resources, totalTokensPerArm } }, f.governor);
      try {
        const receipt = await controller.gateway.carryTrial.authorizeAttempt(f.attempt);
        if (limit === 109) expect(receipt).toBeNull();
        else expect(receipt).not.toBeNull();
      } finally { controller.revoke(); }
    }
  });

  it('preserves count provenance on the existing reservation and excludes extra host credential fields', async () => {
    const f = budgetFixture();
    f.authority.inputEvidence = { kind: 'provider-input-count', sourceSha256: f.digest('contract'),
      bodySha256: f.attempt.bodySha256, countBodySha256: f.digest('count-body'), responseSha256: f.digest('count-response'),
      requestId: 'req_provider_count', measuredInputTokens: 100, secret: 'DO_NOT_RECORD_HOST_SECRET' } as never;
    try {
      const receipt = await f.gateway.carryTrial.authorizeAttempt(f.attempt);
      expect(receipt).not.toBeNull();
      const note = JSON.parse(f.reserve.mock.calls[0][1].note!);
      expect(note.inputEvidence).toEqual({ kind: 'provider-input-count', sourceSha256: f.digest('contract'),
        bodySha256: f.attempt.bodySha256, countBodySha256: f.digest('count-body'), responseSha256: f.digest('count-response'),
        requestId: 'req_provider_count', measuredInputTokens: 100 });
      expect(f.reserve.mock.calls[0][1].note).not.toContain('DO_NOT_RECORD_HOST_SECRET');
    } finally { f.revoke(); }
  });
  it.each(['body', 'over-cap', 'source', 'request-id'] as const)('rejects %s count evidence before a reservation', async changed => {
    const f = budgetFixture();
    const proof = { kind: 'provider-input-count' as const, sourceSha256: f.digest('contract'), bodySha256: f.attempt.bodySha256,
      countBodySha256: f.digest('count-body'), responseSha256: f.digest('count-response'), requestId: 'req_count', measuredInputTokens: 100 };
    if (changed === 'body') proof.bodySha256 = f.digest('foreign-body');
    if (changed === 'over-cap') proof.measuredInputTokens = 101;
    if (changed === 'source') proof.sourceSha256 = 'not-a-digest';
    if (changed === 'request-id') proof.requestId = 'secret unsafe\nheader';
    f.authority.inputEvidence = proof;
    try {
      expect(await f.gateway.carryTrial.authorizeAttempt(f.attempt)).toBeNull();
      expect(f.reserve).not.toHaveBeenCalled();
    } finally { f.revoke(); }
  });
  it('binds the host native output ceiling to the frozen resource allowance', () => {
    const f = budgetFixture();
    expect(f.gateway.carryTrial.outputTokenLimit).toBe(1000);
    f.input.resources.outputTokens = 9999;
    expect(f.gateway.carryTrial.outputTokenLimit).toBe(1000);
    f.revoke();
  });
  it('keeps a tighter per-request output ceiling independent of the aggregate allowance', async () => {
    const f = budgetFixture();
    const input = { ...f.input, outputTokenLimit: 10 };
    const controller = currentBenchGatewayController(input, f.governor);
    try {
      expect(controller.gateway.carryTrial.outputTokenLimit).toBe(10);
      input.outputTokenLimit = 1000;
      expect(controller.gateway.carryTrial.outputTokenLimit).toBe(10);
      expect(await controller.gateway.carryTrial.authorizeAttempt(f.attempt)).not.toBeNull();
      expect(f.reserve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        exact: expect.objectContaining({ expectedResourceBudget: f.input.resources,
          resources: expect.objectContaining({ outputTokens: 10 }) }),
      }));
    } finally { controller.revoke(); f.revoke(); }
  });
  it.each([0, -1, 1.5, NaN, Infinity, 1001])('refuses invalid per-request output ceiling %s before admission', outputTokenLimit => {
    const f = budgetFixture();
    try {
      expect(() => currentBenchGatewayController({ ...f.input, outputTokenLimit }, f.governor)).toThrow(/output ceiling/);
      expect(f.reserve).not.toHaveBeenCalled();
    } finally { f.revoke(); }
  });
  it('refuses a per-request output ceiling beyond the frozen combined token cap', () => {
    const f = budgetFixture();
    const protocol = structuredClone(f.input.protocol);
    for (const arm of protocol.arms) arm.generationBudget.maxTokens = 110;
    try {
      expect(() => currentBenchGatewayController({ ...f.input, protocol, outputTokenLimit: 111,
        resources: { ...f.input.resources, totalTokensPerArm: 110 } }, f.governor)).toThrow(/output ceiling/);
    } finally { f.revoke(); }
  });
  it('refuses a request beyond the tighter output ceiling before authentication or reservation', async () => {
    const f = budgetFixture();
    const controller = currentBenchGatewayController({ ...f.input, outputTokenLimit: 10 }, f.governor);
    const body = JSON.stringify({ ...JSON.parse(f.attempt.body), max_output_tokens: 11 });
    f.authority.outputTokens = 11;
    try {
      expect(await controller.gateway.carryTrial.authorizeAttempt({ ...f.attempt, body, bodySha256: f.digest(body) })).toBeNull();
      expect(f.input.authenticateProvider).not.toHaveBeenCalled();
      expect(f.reserve).not.toHaveBeenCalled();
    } finally { controller.revoke(); f.revoke(); }
  });
  it('binds every provider attempt to the existing exact lifetime ledger and assignment cap', async () => {
    const f = budgetFixture();
    try {
      const receipt = await f.gateway.carryTrial.authorizeAttempt(f.attempt);
      expect(receipt).not.toBeNull();
      expect(receipt!.reservationRef).toBe(f.attempt.attemptId);
      expect(f.reserve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        workspaceId: 'bench-private', loopId: 'benchmark-run-1', floorUsd: 0, requestedUsd: 0.001,
        exact: { reservationId: f.attempt.attemptId, binding: f.input.preregHash, expectedBudgetUsd: 60,
          resources: { armId: f.attempt.armId, inputTokens: 100, outputTokens: 10 }, expectedResourceBudget: f.input.resources },
      }));
      expect(f.reserve.mock.calls[0][1].cycle).toBeUndefined();
      const note = f.reserve.mock.calls[0][1].note!;
      expect(note).not.toContain(NEVER_EMIT_MARKER); expect(note).not.toContain('configured-alias');
      receipt!.validateAuthorization!();
      await receipt!.observeAttemptResult!(f.result(f.attempt, receipt!.reservationRef, 'response-headers'));
      expect(f.settle).not.toHaveBeenCalled();
    } finally { f.revoke(); }
  });
  it.each(['send-refused', 'fetch-failed', 'response-headers'] as const)('keeps unknown usage reserved for %s', async outcome => {
    const f = budgetFixture();
    try {
      const receipt = (await f.gateway.carryTrial.authorizeAttempt(f.attempt))!;
      expect(receipt).not.toBeNull();
      if (outcome !== 'send-refused') receipt.validateAuthorization!();
      await receipt.observeAttemptResult!(f.result(f.attempt, receipt.reservationRef, outcome));
      expect(f.settle).toHaveBeenCalledTimes(outcome === 'send-refused' ? 1 : 0);
      if (outcome === 'send-refused') expect(f.settle).toHaveBeenCalledWith(expect.anything(),
        expect.objectContaining({ reservationId: f.attempt.attemptId, usedUsd: 0, disposition: 'cancelled' }));
    } finally { f.revoke(); }
  });
  it.each(['body', 'effort', 'model', 'output', 'missing-output', 'auth', 'price', 'expired', 'foreign-manifest', 'foreign-assignment', 'fractional-usd'])('refuses %s before reservation', async changed => {
    const f = budgetFixture();
    try {
      const body = JSON.parse(f.attempt.body);
      if (changed === 'body') f.attempt = { ...f.attempt, body: '{' };
      if (changed === 'effort') body.reasoning.effort = 'low';
      if (changed === 'model') body.model = 'other-model';
      if (changed === 'output') body.max_output_tokens = 11;
      if (changed === 'missing-output') delete body.max_output_tokens;
      if (changed === 'auth') f.input.authenticateProvider.mockResolvedValue(null);
      if (changed === 'price') f.authority.requestedUsd = 0.000001;
      if (changed === 'expired') f.authority.validUntilMonotonicMs = -1;
      if (changed === 'foreign-manifest') f.attempt = { ...f.attempt, manifestSha256: 'd'.repeat(64) };
      if (changed === 'foreign-assignment') f.attempt = { ...f.attempt, armId: 'other' };
      if (changed === 'fractional-usd') f.authority.requestedUsd = 0.0000011;
      if (['effort', 'model', 'output', 'missing-output'].includes(changed)) {
        const text = JSON.stringify(body); f.attempt = { ...f.attempt, body: text, bodySha256: f.digest(text) };
      }
      expect(await f.gateway.carryTrial.authorizeAttempt(f.attempt)).toBeNull();
      expect(f.reserve).not.toHaveBeenCalled();
    } finally { f.revoke(); }
  });
  it.each(['total', 'assignment', 'inflight', 'roster', 'time'] as const)('rejects drifted frozen %s resource policy', changed => {
    const f = budgetFixture();
    try {
      if (changed === 'total') f.input.protocol.aggregateBudgetUsd = 0.5;
      if (changed === 'assignment') f.input.resources.usdPerArm = 4;
      if (changed === 'inflight') f.input.resources.maxOpenUsd = 4;
      if (changed === 'roster') f.input.resources.armIds.pop();
      if (changed === 'time') f.input.resources.wallClockMsPerArm++;
      expect(() => currentBenchGatewayController(f.input, f.governor)).toThrow();
    } finally { f.revoke(); }
  });
  it('refuses replay, rechecks revocation at send and snapshots the frozen protocol', async () => {
    const f = budgetFixture();
    try {
      f.input.protocol.arms[0].model = 'mutated'; f.input.protocol.aggregateBudgetUsd = 600;
      f.input.resources.usdPerArm = 30;
      const receipt = (await f.gateway.carryTrial.authorizeAttempt(f.attempt))!;
      expect(receipt).not.toBeNull();
      expect(f.reserve.mock.calls[0][1].exact!.expectedBudgetUsd).toBe(60);
      expect(await f.gateway.carryTrial.authorizeAttempt(f.attempt)).toBeNull();
      expect(f.reserve).toHaveBeenCalledTimes(1);
      f.revoke(); expect(() => receipt.validateAuthorization!()).toThrow();
    } finally { f.revoke(); }
  });
  it.each(['missing-rate', 'under-reserved', 'reserved'] as const)('bounds modern OpenAI cache-write exposure (%s)', async mode => {
    const f = budgetFixture();
    f.input.protocol.arms.forEach(arm => { arm.model = 'gpt-6-sol'; });
    const rate = f.input.protocol.priceSchedule.rates[0]; rate.model = 'gpt-6-sol';
    if (mode !== 'missing-rate') rate.cacheWriteUsdPerMillion = 5;
    const c = currentBenchGatewayController(f.input, f.governor);
    try {
      const body = JSON.stringify({ model: rate.model, reasoning: { effort: 'high' }, max_output_tokens: 10,
        prompt_cache_options: { ttl: '30m' } });
      const attempt = { ...f.attempt, body, bodySha256: f.digest(body) };
      f.authority.requestedUsd = mode === 'reserved' ? 0.00052 : 0.00012;
      const receipt = await c.gateway.carryTrial.authorizeAttempt(attempt);
      if (mode === 'reserved') expect(receipt).not.toBeNull();
      else { expect(receipt).toBeNull(); expect(f.reserve).not.toHaveBeenCalled(); }
    } finally { c.revoke(); f.revoke(); }
  });
  it('does not price Anthropic cache-write exposure as ordinary input', async () => {
    const f = budgetFixture();
    try {
      f.input.protocol.arms[0].agent = 'claude';
      const c = currentBenchGatewayController(f.input, f.governor);
      const body = JSON.stringify({ model: 'configured-alias', output_config: { effort: 'high' }, max_tokens: 10 });
      expect(await c.gateway.carryTrial.authorizeAttempt({ ...f.attempt, transport: 'anthropic-http', body, bodySha256: f.digest(body) })).toBeNull();
      expect(f.reserve).not.toHaveBeenCalled(); c.revoke();
    } finally { f.revoke(); }
  });
  it('admits Claude only with its frozen maximum cache-write price', async () => {
    const f = budgetFixture();
    f.input.protocol.arms[0].agent = 'claude';
    f.input.protocol.priceSchedule.rates[0].cacheWriteUsdPerMillion = 10;
    const c = currentBenchGatewayController(f.input, f.governor);
    try {
      const body = JSON.stringify({ model: 'configured-alias', output_config: { effort: 'high' }, max_tokens: 10 });
      const attempt = { ...f.attempt, transport: 'anthropic-http' as const, body, bodySha256: f.digest(body) };
      f.authority.requestedUsd = 0.00012; // Enough for ordinary input; below the cache-write bound.
      expect(await c.gateway.carryTrial.authorizeAttempt(attempt)).toBeNull();
      expect(f.reserve).not.toHaveBeenCalled();
      f.authority.requestedUsd = 0.00102;
      const receipt = await c.gateway.carryTrial.authorizeAttempt({ ...attempt, attemptId: randomUUID() });
      expect(receipt).not.toBeNull();
      expect(f.reserve.mock.calls[0][1].requestedUsd).toBe(0.00102);
    } finally { c.revoke(); f.revoke(); }
  });
  it('refuses an authority that understates the frozen complete input ceiling', async () => {
    const f = budgetFixture();
    f.input.protocol.priceSchedule.rates[0].inputTokenCeiling = 101;
    f.input.protocol.priceSchedule.rates[0].inputTokenCeilingSourceSha256 = f.digest('native-bound');
    const c = currentBenchGatewayController(f.input, f.governor);
    try {
      expect(await c.gateway.carryTrial.authorizeAttempt(f.attempt)).toBeNull();
      expect(f.reserve).not.toHaveBeenCalled();
    } finally { c.revoke(); f.revoke(); }
  });
});

function providerAuthFixture() {
  const f = budgetFixture();
  f.revoke();
  const rate = f.input.protocol.priceSchedule.rates[0];
  rate.inputTokenCeiling = 10_000;
  rate.inputTokenCeilingSourceSha256 = f.digest('native-provider-contract');
  const ceiling: CurrentBenchNativeInputCeiling = { model: rate.model, inputTokens: 10_000,
    sourceSha256: rate.inputTokenCeilingSourceSha256, validUntilMonotonicMs: processMonotonicClock.now() + 10_000,
    validateAuthorization: vi.fn(() => {}) };
  const account = { id: f.attempt.accountId, provider: 'codex' as const, credentialRef: 'token:fixture-private-key' };
  const resolver = { current: vi.fn(async () => NEVER_EMIT_MARKER), invalidate: vi.fn(),
    kind: 'token' as const, authMode: 'oauth' as const };
  type AuthPorts = NonNullable<Parameters<typeof currentBenchProviderAuthenticator>[1]>;
  const ports = { readAccount: vi.fn<AuthPorts['readAccount']>(async () => account),
    credentialResolver: vi.fn<AuthPorts['credentialResolver']>(() => resolver) };
  const input = { workspaceId: f.input.workspaceId, preregHash: f.input.preregHash, protocol: f.input.protocol,
    armId: f.input.armId, taskId: f.input.taskId, seed: f.input.seed,
    readNativeInputCeiling: vi.fn(async (): Promise<CurrentBenchNativeInputCeiling | null> => ceiling) };
  const auth = currentBenchProviderAuthenticator(input, ports);
  const attempt = { ...f.attempt, target: 'https://api.openai.com/v1/responses' };
  return { ...f, ...auth, input, ports, ceiling, account, resolver, attempt };
}

describe('provider-counted complete native input', () => {
  function fixture() {
    const f = providerAuthFixture();
    const input = { model: f.ceiling.model, inputTokens: f.ceiling.inputTokens };
    const body = JSON.stringify({ model: input.model, input: [{ role: 'user', content: 'native input' }],
      instructions: 'same instructions', reasoning: { effort: 'high' },
      tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }], max_output_tokens: 10, stream: true });
    const attempt = { ...f.attempt, body, bodySha256: f.digest(body) };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ object: 'response.input_tokens', input_tokens: 100 }));
    const reader = currentBenchOpenAiInputReader(input, { fetch });
    return { ...f, input, attempt, fetch, reader, credential: { secret: NEVER_EMIT_MARKER } };
  }
  it.each([
    { ttl: '30m' }, { ttl: '30m', mode: 'implicit' }, { ttl: '30m', mode: 'explicit' },
    { ttl: '24h' }, { ttl: '30m', prewarm: true }, { ttl: '30m', comparison_response_id: 'foreign' },
    { ttl: '30m', unknown: 'uncounted' }, '30m', null,
  ])('admits only bounded native prompt-cache options %j', async options => {
    const f = fixture();
    const body = JSON.parse(f.attempt.body); body.prompt_cache_options = options;
    f.attempt.body = JSON.stringify(body); f.attempt.bodySha256 = f.digest(f.attempt.body);
    const accepted = options !== null && typeof options === 'object' && options.ttl === '30m' &&
      Object.keys(options).every(key => key === 'ttl' || key === 'mode');
    try {
      const proof = await f.reader.read(f.attempt, f.credential);
      if (accepted) {
        expect(proof).not.toBeNull();
        expect(proof!.evidence!.bodySha256).toBe(f.attempt.bodySha256);
        expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body as string)).not.toHaveProperty('prompt_cache_options');
      } else { expect(proof).toBeNull(); expect(f.fetch).not.toHaveBeenCalled(); }
    } finally { f.reader.revoke(); f.revoke(); }
  });
  it.each(['valid', 'unknown-metadata', 'malformed-metadata'] as const)(
    'counts native input with bounded source correlation (%s)', async mode => {
      const f = fixture();
      const body = JSON.parse(f.attempt.body);
      body.client_metadata = { 'x-codex-turn-metadata': JSON.stringify({
        thread_id: '11111111-1111-1111-1111-111111111111', turn_id: '22222222-2222-2222-2222-222222222222' }) };
      if (mode === 'unknown-metadata') body.client_metadata.unreviewed_context = 'PRIVATE_CONTEXT';
      if (mode === 'malformed-metadata') body.client_metadata['x-codex-turn-metadata'] = '{broken';
      f.attempt.body = JSON.stringify(body); f.attempt.bodySha256 = f.digest(f.attempt.body);
      try {
        const proof = await f.reader.read(f.attempt, f.credential);
        if (mode !== 'valid') { expect(proof).toBeNull(); expect(f.fetch).not.toHaveBeenCalled(); return; }
        expect(proof?.evidence?.bodySha256).toBe(f.attempt.bodySha256);
        expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body as string)).not.toHaveProperty('client_metadata');
      } finally { f.reader.revoke(); f.revoke(); }
    });

  it.each(['valid', 'turn-mismatch', 'thread-mismatch', 'session-mismatch', 'window-mismatch',
    'installation-mismatch', 'root-mismatch', 'invalid-id', 'unknown'] as const)(
    'bounds installed Codex metadata aliases (%s)', async mode => {
      const f = fixture();
      const session = '11111111-1111-1111-1111-111111111111', turn = '22222222-2222-2222-2222-222222222222';
      const installation = '33333333-3333-3333-3333-333333333333', other = '44444444-4444-4444-4444-444444444444';
      const body = JSON.parse(f.attempt.body);
      body.client_metadata = { session_id: session, thread_id: session, turn_id: turn, root_turn_id: turn,
        'x-codex-installation-id': installation, 'x-codex-window-id': `${session}:0`,
        'x-codex-turn-metadata': JSON.stringify({ session_id: session, thread_id: session, turn_id: turn,
          root_turn_id: turn, installation_id: installation, window_id: `${session}:0`, model: f.input.model }) };
      const key = ({ 'turn-mismatch': 'turn_id', 'thread-mismatch': 'thread_id', 'session-mismatch': 'session_id',
        'window-mismatch': 'x-codex-window-id', 'installation-mismatch': 'x-codex-installation-id',
        'root-mismatch': 'root_turn_id' } as Record<string, string>)[mode];
      if (key) body.client_metadata[key] = other;
      if (mode === 'invalid-id') body.client_metadata['x-codex-installation-id'] = 'PRIVATE_UNCOUNTED_CONTEXT';
      if (mode === 'unknown') body.client_metadata.unreviewed_context = 'PRIVATE_UNCOUNTED_CONTEXT';
      f.attempt.body = JSON.stringify(body); f.attempt.bodySha256 = f.digest(f.attempt.body);
      try {
        const proof = await f.reader.read(f.attempt, f.credential);
        if (mode === 'valid') {
          expect(proof?.evidence?.bodySha256).toBe(f.attempt.bodySha256);
          expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body as string)).not.toHaveProperty('client_metadata');
        } else { expect(proof).toBeNull(); expect(f.fetch).not.toHaveBeenCalled(); }
      } finally { f.reader.revoke(); f.revoke(); }
    });
  it.each(['valid', 'empty-result', 'server-declaration', 'missing-execution', 'missing-schema', 'unknown-field',
    'server-call', 'server-output', 'missing-call-id', 'hosted-result', 'nested-hosted-result', 'search-result'] as const)(
    'counts only client discovery and complete returned local definitions (%s)', async mode => {
      const f = fixture(), body = JSON.parse(f.attempt.body);
      const declaration: Record<string, unknown> = { type: 'tool_search', execution: 'client',
        description: 'Search installed deferred tools', parameters: { type: 'object', properties: {
          query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'], additionalProperties: false } };
      const call = { type: 'tool_search_call', execution: 'client', call_id: 'local-search', status: 'completed',
        arguments: { query: 'work_items:get', limit: 4 } };
      const output: Record<string, unknown> = { type: 'tool_search_output', execution: 'client', call_id: 'local-search',
        status: 'completed', tools: [{ type: 'function', name: 'work_items_get', defer_loading: true,
          description: 'Full maintained local tool', parameters: { type: 'object', properties: { id: { type: 'string' } } } }] };
      if (mode === 'server-declaration') declaration.execution = 'server';
      if (mode === 'missing-execution') delete declaration.execution;
      if (mode === 'missing-schema') delete declaration.parameters;
      if (mode === 'unknown-field') declaration.remote_context = 'unmeasured';
      if (mode === 'server-call') call.execution = 'server';
      if (mode === 'server-output') output.execution = 'server';
      if (mode === 'missing-call-id') output.call_id = '';
      if (mode === 'empty-result') output.tools = [];
      if (mode === 'hosted-result') output.tools = [{ type: 'web_search' }];
      if (mode === 'nested-hosted-result') output.tools = [{ type: 'namespace', name: 'hosted', tools: [{ type: 'web_search' }] }];
      if (mode === 'search-result') output.tools = [declaration];
      body.tools.push(declaration); body.input.push(call, output);
      f.attempt.body = JSON.stringify(body); f.attempt.bodySha256 = f.digest(f.attempt.body);
      try {
        const proof = await f.reader.read(f.attempt, f.credential);
        if (mode === 'valid' || mode === 'empty-result') {
          expect(proof?.evidence?.bodySha256).toBe(f.attempt.bodySha256);
          const counted = JSON.parse(f.fetch.mock.calls[0]![1]!.body as string);
          expect(counted.tools).toEqual(body.tools); expect(counted.input).toEqual(body.input);
        } else { expect(proof).toBeNull(); expect(f.fetch).not.toHaveBeenCalled(); }
      } finally { f.reader.revoke(); f.revoke(); }
    });

  it('counts the entire native payload with the final registered credential and reserves the frozen ceiling', async () => {
    const f = fixture();
    try {
      const proof = await f.reader.read(f.attempt, f.credential);
      expect(proof).toMatchObject({ model: f.input.model, inputTokens: 10_000,
        sourceSha256: currentBenchOpenAiInputContract(f.input.model, 10_000) });
      const [target, init] = f.fetch.mock.calls[0];
      expect(target).toBe('https://api.openai.com/v1/responses/input_tokens');
      expect(init).toMatchObject({ redirect: 'error', method: 'POST', headers: { authorization: `Bearer ${NEVER_EMIT_MARKER}` } });
      expect(JSON.parse(init!.body as string)).toEqual({ model: f.input.model, input: [{ role: 'user', content: 'native input' }],
        instructions: 'same instructions', reasoning: { effort: 'high' },
        tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }] });
      expect(JSON.stringify(proof)).not.toContain(NEVER_EMIT_MARKER);
      expect(proof!.evidence).toMatchObject({ kind: 'provider-input-count', measuredInputTokens: 100,
        bodySha256: f.attempt.bodySha256, requestId: null });
      proof!.validateAuthorization(); f.reader.revoke(); expect(() => proof!.validateAuthorization()).toThrow(/revoked/);
    } finally { f.reader.revoke(); f.revoke(); }
  });
  it.each(['inline', 'top-level', 'after-user'] as const)('counts complete native local tool namespaces (%s)', async form => {
    const f = fixture();
    try {
      const body = JSON.parse(f.attempt.body);
      const tools = [{ type: 'namespace', name: 'functions', description: 'Native executor', tools: [
        { type: 'custom', name: 'exec', description: 'Exact native guidance', format: { type: 'text' } },
        { type: 'function', name: 'wait', parameters: { type: 'object', properties: {} } },
      ] }];
      if (form !== 'top-level') {
        delete body.tools;
        const entry = { id: 'tools-native', type: 'additional_tools', role: 'developer', tools };
        if (form === 'after-user') body.input.push(entry); else body.input.unshift(entry);
      } else body.tools = tools;
      f.attempt.body = JSON.stringify(body); f.attempt.bodySha256 = f.digest(f.attempt.body);
      const proof = await f.reader.read(f.attempt, f.credential);
      expect(proof?.evidence?.bodySha256).toBe(f.attempt.bodySha256);
      const counted = JSON.parse(f.fetch.mock.calls[0]![1]!.body as string);
      expect(counted.input).toEqual(body.input);
      expect(counted.tools).toEqual(body.tools);
    } finally { f.reader.revoke(); f.revoke(); }
  });
  it.each(['hosted', 'nested-namespace', 'missing-name', 'missing-tools', 'user-role', 'empty'] as const)(
    'refuses invalid native inline tools (%s) before counting', async changed => {
      const f = fixture();
      try {
        const body = JSON.parse(f.attempt.body);
        const namespace: Record<string, unknown> = { type: 'namespace', name: 'functions', tools: [
          { type: 'custom', name: 'exec' },
        ] };
        if (changed === 'hosted') namespace.tools = [{ type: 'web_search' }];
        if (changed === 'nested-namespace') namespace.tools = [{ type: 'namespace', name: 'nested', tools: [] }];
        if (changed === 'missing-name') delete namespace.name;
        if (changed === 'missing-tools') delete namespace.tools;
        if (changed === 'empty') namespace.tools = [];
        const entry = { type: 'additional_tools', role: changed === 'user-role' ? 'user' : 'developer', tools: [namespace] };
        body.input.unshift(entry);
        f.attempt.body = JSON.stringify(body); f.attempt.bodySha256 = f.digest(f.attempt.body);
        expect(await f.reader.read(f.attempt, f.credential)).toBeNull();
        expect(f.fetch).not.toHaveBeenCalled();
      } finally { f.reader.revoke(); f.revoke(); }
    });
  it.each(['previous', 'conversation', 'remote-image', 'remote-file', 'reference', 'hosted-tool', 'unknown-field',
    'paid-tier', 'background', 'credential', 'target', 'body', 'aborted'] as const)('refuses %s before the counting request', async changed => {
    const f = fixture();
    try {
      const body = JSON.parse(f.attempt.body);
      if (changed === 'previous') body.previous_response_id = 'mutable';
      if (changed === 'conversation') body.conversation = { id: 'mutable' };
      if (changed === 'remote-image') body.input[0].content = [{ type: 'input_image', image_url: 'https://mutable.invalid/img' }];
      if (changed === 'remote-file') body.input[0].content = [{ type: 'input_file', file_id: 'mutable' }];
      if (changed === 'reference') body.input = [{ type: 'item_reference', id: 'mutable' }];
      if (changed === 'hosted-tool') body.tools = [{ type: 'web_search' }];
      if (changed === 'unknown-field') body.new_context_field = 'uncounted';
      if (changed === 'paid-tier') body.service_tier = 'priority';
      if (changed === 'background') body.background = true;
      const text = JSON.stringify(body), attempt = { ...f.attempt, body: text, bodySha256: f.digest(text) };
      if (changed === 'credential') attempt.credentialSha256 = f.digest('Bearer another');
      if (changed === 'target') attempt.target = 'https://api.openai.com.evil.invalid/v1/responses';
      if (changed === 'body') attempt.bodySha256 = f.digest('another body');
      if (changed === 'aborted') attempt.signal = AbortSignal.abort();
      expect(await f.reader.read(attempt, f.credential)).toBeNull(); expect(f.fetch).not.toHaveBeenCalled();
    } finally { f.reader.revoke(); f.revoke(); }
  });
  it.each([10_001, -1, 1.5, '100', null] as const)('refuses incomplete or over-cap provider input %s', async input_tokens => {
    const f = fixture();
    try {
      f.fetch.mockImplementation(async () => Response.json({ object: 'response.input_tokens', input_tokens }));
      expect(await f.reader.read(f.attempt, f.credential)).toBeNull();
    } finally { f.reader.revoke(); f.revoke(); }
  });
  it.each(['http', 'object', 'oversize', 'network', 'revoked'] as const)('refuses %s counting evidence', async changed => {
    const f = fixture();
    try {
      if (changed === 'http') f.fetch.mockImplementation(async () => new Response('{}', { status: 503 }));
      if (changed === 'object') f.fetch.mockImplementation(async () => Response.json({ input_tokens: 100 }));
      if (changed === 'oversize') f.fetch.mockImplementation(async () => new Response(' '.repeat(4097)));
      if (changed === 'network') f.fetch.mockRejectedValue(new Error('network unavailable'));
      if (changed === 'revoked') f.fetch.mockImplementation(async () => { f.reader.revoke(); return Response.json({ object: 'response.input_tokens', input_tokens: 100 }); });
      expect(await f.reader.read(f.attempt, f.credential)).toBeNull();
    } finally { f.reader.revoke(); f.revoke(); }
  });
  it('expires or aborts a counted proof synchronously before generation', async () => {
    const f = fixture(); const abort = new AbortController();
    try {
      const proof = await f.reader.read({ ...f.attempt, signal: abort.signal }, f.credential);
      expect(proof).not.toBeNull(); abort.abort(); expect(() => proof!.validateAuthorization()).toThrow(/revoked/);
    } finally { f.reader.revoke(); f.revoke(); }
  });
  it('binds the default production reader to the preregistered source and final credential', async () => {
    const f = fixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(f.fetch);
    try {
      const protocol = currentProtocolFixture();
      protocol.priceSchedule.rates[0].inputTokenCeiling = 10_000;
      protocol.priceSchedule.rates[0].inputTokenCeilingSourceSha256 = currentBenchOpenAiInputContract(protocol.arms[0].model, 10_000);
      const auth = currentBenchProviderAuthenticator({ workspaceId: 'bench-private', preregHash: f.attempt.manifestSha256,
        protocol, armId: 'papercusp', taskId: 't1', seed: 1 }, f.ports);
      try {
        const authority = await auth.authenticateProvider(f.attempt);
        expect(authority).toMatchObject({ inputTokens: 10_000, requestedUsd: 0.01002,
          inputEvidence: { kind: 'provider-input-count', measuredInputTokens: 100 } });
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally { auth.revoke(); }
    } finally { fetch.mockRestore(); f.reader.revoke(); f.revoke(); }
  });
});

describe('registered benchmark provider authentication', () => {
  it('refuses complete native input plus output beyond the frozen token cap before granting authority', async () => {
    const f = providerAuthFixture();
    const protocol = structuredClone(f.input.protocol);
    for (const arm of protocol.arms) arm.generationBudget.maxTokens = 10_009;
    const auth = currentBenchProviderAuthenticator({ ...f.input, protocol }, f.ports);
    try { expect(await auth.authenticateProvider(f.attempt)).toBeNull(); }
    finally { auth.revoke(); f.revoke(); }
  });

  it('uses the maintained physical credential-file resolver and refuses a changed credential', async () => {
    const f = providerAuthFixture();
    const root = mkdtempSync(join(tmpdir(), 'benchmark-provider-credential-'));
    const path = join(root, 'provider-key');
    writeFileSync(path, NEVER_EMIT_MARKER, { mode: 0o600 });
    const account = { ...f.account, credentialRef: `token:${path}` };
    f.ports.readAccount.mockResolvedValue(account);
    const auth = currentBenchProviderAuthenticator(f.input, { readAccount: f.ports.readAccount,
      credentialResolver: (_provider, ref) => makeBearerCredentialResolver(ref) });
    try {
      expect(await auth.authenticateProvider(f.attempt)).toMatchObject({ inputTokens: 10_000, requestedUsd: 0.01002 });
      writeFileSync(path, 'ROTATED_PROVIDER_KEY', { mode: 0o600 });
      expect(await auth.authenticateProvider({ ...f.attempt, attemptId: randomUUID() })).toBeNull();
    } finally { auth.revoke(); f.revoke(); rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['ceiling', 'source'] as const)('requires a paired frozen native %s', changed => {
    const f = providerAuthFixture();
    try {
      if (changed === 'ceiling') delete f.input.protocol.priceSchedule.rates[0].inputTokenCeiling;
      else delete f.input.protocol.priceSchedule.rates[0].inputTokenCeilingSourceSha256;
      expect(() => currentBenchProviderAuthenticator(f.input, f.ports)).toThrow(/frozen together/);
    } finally { f.revoke(); }
  });
  it('refuses a protocol with no frozen native ceiling before reading a provider credential', async () => {
    const f = providerAuthFixture();
    delete f.input.protocol.priceSchedule.rates[0].inputTokenCeiling;
    delete f.input.protocol.priceSchedule.rates[0].inputTokenCeilingSourceSha256;
    const auth = currentBenchProviderAuthenticator(f.input, f.ports);
    try {
      expect(await auth.authenticateProvider(f.attempt)).toBeNull();
      expect(f.resolver.current).not.toHaveBeenCalled();
    } finally { auth.revoke(); f.revoke(); }
  });
  it('authenticates Claude API-key shape and prices the full frozen cache-write ceiling', async () => {
    const f = providerAuthFixture();
    f.input.protocol.arms[0].agent = 'claude';
    f.input.protocol.priceSchedule.rates[0].cacheWriteUsdPerMillion = 25;
    f.ports.readAccount.mockResolvedValue({ ...f.account, provider: 'claude' });
    f.ports.credentialResolver.mockReturnValue({ ...f.resolver, kind: 'apikey', authMode: 'api-key' });
    const body = JSON.stringify({ model: 'configured-alias', output_config: { effort: 'high' }, max_tokens: 10 });
    const attempt = { ...f.attempt, target: 'https://api.anthropic.com/v1/messages', transport: 'anthropic-http' as const,
      credentialHeader: 'x-api-key' as const, credentialSha256: f.digest(NEVER_EMIT_MARKER), body, bodySha256: f.digest(body) };
    const auth = currentBenchProviderAuthenticator(f.input, f.ports);
    try {
      expect(await auth.authenticateProvider(attempt)).toMatchObject({ inputTokens: 10_000, requestedUsd: 0.25002 });
      expect(await auth.authenticateProvider({ ...attempt, credentialHeader: 'authorization' })).toBeNull();
    } finally { auth.revoke(); f.revoke(); }
  });
  it('authenticates the final registered credential and reserves the full native ceiling', async () => {
    const f = providerAuthFixture();
    try {
      const authority = await f.authenticateProvider(f.attempt);
      expect(authority).toMatchObject({ inputTokens: 10_000, outputTokens: 10, requestedUsd: 0.01002 });
      expect(f.ports.readAccount).toHaveBeenCalledTimes(2);
      expect(f.ports.readAccount).toHaveBeenCalledWith('bench-private', f.attempt.accountId);
      expect(JSON.stringify(authority)).not.toContain(NEVER_EMIT_MARKER);
      expect(authority!.validUntilMonotonicMs).toBeLessThanOrEqual(processMonotonicClock.now() + 5000);
      authority!.validateAuthorization();
      f.revoke(); expect(() => authority!.validateAuthorization()).toThrow(/revoked/);
    } finally { f.revoke(); }
  });
  it.each(['credential', 'header', 'target', 'transport', 'clock', 'manifest', 'assignment', 'body', 'model', 'effort', 'output', 'account', 'provider', 'unregistered', 'missing-ceiling', 'source', 'ceiling', 'expired', 'asynchronous-check', 'aborted'] as const)(
    'refuses %s without granting provider authority', async changed => {
      const f = providerAuthFixture();
      try {
        let attempt = { ...f.attempt };
        const body = JSON.parse(attempt.body);
        if (changed === 'credential') attempt.credentialSha256 = f.digest('Bearer foreign-key');
        if (changed === 'header') attempt.credentialHeader = 'x-api-key';
        if (changed === 'target') attempt.target = 'https://api.openai.com.evil.invalid/v1/responses';
        if (changed === 'transport') attempt.transport = 'oauth-http';
        if (changed === 'clock') attempt.clockId = 'foreign-clock';
        if (changed === 'manifest') attempt.manifestSha256 = f.digest('other-manifest');
        if (changed === 'assignment') attempt.armId = 'other-assignment';
        if (changed === 'body') attempt.bodySha256 = f.digest('different-body');
        if (changed === 'model') body.model = 'other-model';
        if (changed === 'effort') body.reasoning.effort = 'low';
        if (changed === 'output') body.max_output_tokens = 0;
        if (['model', 'effort', 'output'].includes(changed)) {
          attempt.body = JSON.stringify(body); attempt.bodySha256 = f.digest(attempt.body);
        }
        if (changed === 'account') attempt.accountId = 'other-account';
        if (changed === 'provider') f.ports.readAccount.mockResolvedValue({ ...f.account, provider: 'claude' });
        if (changed === 'unregistered') f.ports.readAccount.mockResolvedValue(null);
        if (changed === 'missing-ceiling') f.input.readNativeInputCeiling.mockResolvedValue(null);
        if (changed === 'source') f.ceiling.sourceSha256 = f.digest('other-contract');
        if (changed === 'ceiling') f.ceiling.inputTokens = 9999;
        if (changed === 'expired') f.ceiling.validUntilMonotonicMs = -1;
        if (changed === 'asynchronous-check') f.ceiling.validateAuthorization = (() => Promise.resolve()) as unknown as () => void;
        if (changed === 'aborted') attempt.signal = AbortSignal.abort();
        expect(await f.authenticateProvider(attempt)).toBeNull();
      } finally { f.revoke(); }
    });
  it('rejects a registry retarget during credential/input proof reads', async () => {
    const f = providerAuthFixture();
    try {
      f.ports.readAccount.mockResolvedValueOnce(f.account).mockResolvedValueOnce({ ...f.account, credentialRef: 'token:retargeted' });
      expect(await f.authenticateProvider(f.attempt)).toBeNull();
    } finally { f.revoke(); }
  });
  it('snapshots protocol and native proof, and rechecks proof revocation synchronously at send', async () => {
    const f = providerAuthFixture();
    try {
      f.input.protocol.priceSchedule.rates[0].inputUsdPerMillion = 0;
      const authority = (await f.authenticateProvider(f.attempt))!;
      expect(authority).not.toBeNull(); expect(authority.requestedUsd).toBe(0.01002);
      f.ceiling.inputTokens = 1;
      expect(authority.inputTokens).toBe(10_000);
      vi.mocked(f.ceiling.validateAuthorization).mockImplementation(() => { throw new Error('native contract revoked'); });
      expect(() => authority.validateAuthorization()).toThrow(/native contract revoked/);
    } finally { f.revoke(); }
  });
});

// benchmark-coverage-frontierswe-v2-2026-10-10#D-023: a Codex arm frozen with the
// subscription payer sends only through the ChatGPT backend (oauth-http), only with a
// registered codex-cli account, and reserves the provider's own frozen input and output
// limits because that backend rejects max_output_tokens and has no count endpoint.
function subscriptionAuthFixture() {
  const f = budgetFixture();
  f.revoke();
  const rate = f.input.protocol.priceSchedule.rates[0];
  for (const arm of f.input.protocol.arms) arm.payer = 'subscription';
  rate.inputTokenCeiling = 10_000; rate.outputTokenCeiling = 128;
  rate.inputTokenCeilingSourceSha256 = currentBenchCodexSubscriptionContract(rate.model, 10_000, 128);
  const account = { id: f.attempt.accountId, provider: 'codex' as const, credentialRef: 'codex-cli:/private/codex-home' };
  const resolver = { current: vi.fn(async () => NEVER_EMIT_MARKER), invalidate: vi.fn(),
    kind: 'file' as const, authMode: 'oauth' as const };
  type AuthPorts = NonNullable<Parameters<typeof currentBenchProviderAuthenticator>[1]>;
  const ports = { readAccount: vi.fn<AuthPorts['readAccount']>(async () => account),
    credentialResolver: vi.fn<AuthPorts['credentialResolver']>(() => resolver) };
  const input = { workspaceId: f.input.workspaceId, preregHash: f.input.preregHash, protocol: f.input.protocol,
    armId: f.input.armId, taskId: f.input.taskId, seed: f.input.seed };
  // Accepts any route, so a refusal under it is owed to the authenticator's own gates.
  const permissive = vi.fn(async (): Promise<CurrentBenchNativeInputCeiling | null> => ({ model: rate.model, inputTokens: 10_000,
    sourceSha256: rate.inputTokenCeilingSourceSha256!, validUntilMonotonicMs: processMonotonicClock.now() + 10_000,
    validateAuthorization: () => {} }));
  const body = JSON.stringify({ model: rate.model, input: [{ role: 'user', content: 'native input' }],
    instructions: 'same instructions', reasoning: { effort: 'high' },
    tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }], stream: true });
  const attempt: GatewayCarryTrialAttempt = { ...f.attempt, transport: 'oauth-http', target: currentBenchCodexSubscriptionTarget,
    body, bodySha256: f.digest(body) };
  return { ...f, budgetInput: f.input, input, ports, account, resolver, permissive, attempt, rate };
}

describe('D-023 Codex subscription payer', () => {
  it('freezes a contract distinct from the API-key contract and bound to both provider limits', () => {
    const contract = currentBenchCodexSubscriptionContract('configured-alias', 10_000, 128);
    expect(contract).toMatch(/^[a-f0-9]{64}$/);
    expect(contract).not.toBe(currentBenchOpenAiInputContract('configured-alias', 10_000));
    expect(contract).not.toBe(currentBenchCodexSubscriptionContract('configured-alias', 10_000, 129));
    expect(contract).not.toBe(currentBenchCodexSubscriptionContract('configured-alias', 10_001, 128));
    expect(() => currentBenchCodexSubscriptionContract('configured-alias', 10_000, 0)).toThrow(/subscription input contract/);
  });

  it('authenticates the ChatGPT route with the default provider-limit reader and reserves the model maximum output', async () => {
    const f = subscriptionAuthFixture();
    const auth = currentBenchProviderAuthenticator(f.input, f.ports);
    try {
      const authority = await auth.authenticateProvider(f.attempt);
      expect(authority).toMatchObject({ inputTokens: 10_000, outputTokens: 128, requestedUsd: 0.010256,
        inputEvidence: { kind: 'provider-intrinsic-limit', sourceSha256: f.rate.inputTokenCeilingSourceSha256,
          bodySha256: f.attempt.bodySha256, inputTokens: 10_000, outputTokens: 128 } });
      expect(f.ports.credentialResolver).toHaveBeenCalledWith('codex', 'codex-cli:/private/codex-home');
      expect(JSON.stringify(authority)).not.toContain(NEVER_EMIT_MARKER);
      authority!.validateAuthorization();
      auth.revoke(); expect(() => authority!.validateAuthorization()).toThrow(/revoked/);
    } finally { auth.revoke(); }
  });

  it('reads only the final ChatGPT body that omits the output field, until revoked', async () => {
    const f = subscriptionAuthFixture();
    const reader = currentBenchCodexSubscriptionInputReader({ model: f.rate.model, inputTokens: 10_000, outputTokens: 128 });
    const proof = await reader.read(f.attempt);
    expect(proof).toMatchObject({ model: f.rate.model, inputTokens: 10_000, sourceSha256: f.rate.inputTokenCeilingSourceSha256 });
    const body = JSON.stringify({ ...JSON.parse(f.attempt.body), max_output_tokens: 128 });
    expect(await reader.read({ ...f.attempt, body, bodySha256: f.digest(body) })).toBeNull();
    expect(await reader.read({ ...f.attempt, transport: 'bearer-http' })).toBeNull();
    expect(await reader.read({ ...f.attempt, target: 'https://api.openai.com/v1/responses' })).toBeNull();
    reader.revoke();
    expect(() => proof!.validateAuthorization()).toThrow(/revoked/);
    expect(await reader.read(f.attempt)).toBeNull();
  });

  it.each(['bearer-route', 'target', 'output-field', 'api-key-account', 'contract', 'api-arm-subscription-account'] as const)(
    'refuses %s without granting provider authority', async changed => {
      const f = subscriptionAuthFixture();
      if (changed === 'contract') f.rate.inputTokenCeilingSourceSha256 = currentBenchOpenAiInputContract(f.rate.model, 10_000);
      if (changed === 'api-arm-subscription-account') {
        for (const arm of f.input.protocol.arms) delete arm.payer;
        f.rate.inputTokenCeilingSourceSha256 = currentBenchOpenAiInputContract(f.rate.model, 10_000);
      }
      const auth = currentBenchProviderAuthenticator(changed === 'contract' ? f.input
        : { ...f.input, readNativeInputCeiling: f.permissive }, f.ports);
      try {
        // Positive control: the same authenticator grants the unmodified subscription request.
        if (changed !== 'contract' && changed !== 'api-arm-subscription-account') {
          expect(await auth.authenticateProvider({ ...f.attempt, attemptId: randomUUID() })).not.toBeNull();
        }
        let attempt: GatewayCarryTrialAttempt = { ...f.attempt };
        if (changed === 'bearer-route' || changed === 'api-arm-subscription-account') {
          attempt = { ...attempt, transport: 'bearer-http', target: 'https://api.openai.com/v1/responses' };
        }
        if (changed === 'target') attempt = { ...attempt, target: 'https://api.openai.com/v1/responses' };
        if (changed === 'output-field' || changed === 'api-arm-subscription-account') {
          const body = JSON.stringify({ ...JSON.parse(attempt.body), max_output_tokens: 128 });
          attempt = { ...attempt, body, bodySha256: f.digest(body) };
        }
        if (changed === 'api-key-account') f.ports.readAccount.mockResolvedValue({ ...f.account, credentialRef: 'token:/private/key' });
        f.resolver.current.mockClear();
        expect(await auth.authenticateProvider(attempt)).toBeNull();
        if (changed === 'api-key-account' || changed === 'api-arm-subscription-account') expect(f.resolver.current).not.toHaveBeenCalled();
      } finally { auth.revoke(); }
    });

  it('reserves the frozen provider output ceiling on the gateway and refuses a host output limit', async () => {
    const f = subscriptionAuthFixture();
    expect(() => currentBenchGatewayController({ ...f.budgetInput, outputTokenLimit: 128 }, f.governor)).toThrow(/subscription arm/);
    const controller = currentBenchGatewayController(f.budgetInput, f.governor);
    try {
      expect(controller.gateway.carryTrial.outputTokenLimit).toBeUndefined();
      Object.assign(f.authority, { inputTokens: 10_000, outputTokens: 128, requestedUsd: 0.010256,
        inputEvidence: { kind: 'provider-intrinsic-limit', sourceSha256: f.rate.inputTokenCeilingSourceSha256,
          bodySha256: f.attempt.bodySha256, inputTokens: 10_000, outputTokens: 128 } });
      expect(await controller.gateway.carryTrial.authorizeAttempt(f.attempt)).not.toBeNull();
      expect(f.reserve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        exact: expect.objectContaining({ resources: expect.objectContaining({ inputTokens: 10_000, outputTokens: 128 }) }) }));
      const body = JSON.stringify({ ...JSON.parse(f.attempt.body), max_output_tokens: 128 });
      expect(await controller.gateway.carryTrial.authorizeAttempt({ ...f.attempt, attemptId: randomUUID(),
        body, bodySha256: f.digest(body) })).toBeNull();
    } finally { controller.revoke(); }
  });
});

const native = vi.hoisted(() => ({ launch: vi.fn(), kill: vi.fn() }));
vi.mock('../agent-tools/capability/launch-agent', () => ({ default: { handler: native.launch },
  INTERNAL_SCOPED_INFERENCE_GATEWAY: Symbol.for('benchmark-test-private-route'),
  INTERNAL_SCOPED_SESSION_CONFINEMENT: Symbol.for('benchmark-test-server-ceiling'),
  INTERNAL_BACKEND_BIN_OVERRIDE: Symbol.for('benchmark-test-backend-bin') }));
vi.mock('../task-manager/control', () => ({ killTask: native.kill }));

const options: CurrentSuBenchOptions = {
  workspaceId: 'bench-private', runId: 'run-1', armId: 'papercusp', seed: 1, agent: 'codex', model: 'configured-alias',
  effort: 'high', account: 'auto', pollIntervalMs: 10, driveTimeoutMs: 100,
  preregistration: { preregHash: 'frozen-protocol', config: currentProtocolFixture() },
};
const handle = { slug: 'xbench-current-1', featureId: 'xbench-feature-1', worktreePath: '/scratch/task' };
const request = {
  blueprintId: 'su', task: { benchmark: 'swe-bench-pro', instanceId: 't1', problemStatement: 'Fix the public issue.', graderMeta: { hidden: 'SECRET' } },
  checkout: { dir: '/scratch/task', repo: 'a/b', baseCommit: 'base', cleanup: async () => {} },
  budget: { maxUsd: 3, maxWallClockMs: 100 },
};
const identity: CurrentBenchIdentity = {
  measuredBy: 'runtime-observation', runtimeRevision: 'fixture-runtime', sourceRevision: 'fixture-source',
  model: 'served-model', effort: 'high', clientVersion: 'fixture-client',
  promptHash: 'a'.repeat(64), toolsHash: 'b'.repeat(64), observedAt: '2026-10-09T20:00:00Z', evidenceRefs: ['usage:actual-task'],
};
function observedFixture() {
  const nativeSessionId = '00000000-0000-0000-0000-000000000001';
  const turnId = '00000000-0000-0000-0000-000000000002';
  const task: CurrentBenchTask = { taskId: 'task-observed', workspaceId: 'bench-private', state: 'exited', exitCode: 0, detail: {} };
  const telemetry = new GatewayRequestTelemetry({ now: () => Date.parse('2026-10-09T20:00:00Z') });
  const span = telemetry.begin({ ownerId: 'su-exact', provider: 'codex', protocol: 'openai-responses' });
  span.setModel('native-requested-model');
  span.setCacheShape(Buffer.from(JSON.stringify({ instructions: 'PRIVATE_SYSTEM_PROMPT', tools: [{ name: 'tool-exact' }], reasoning: { effort: 'high' } })));
  span.setNativeCorrelation({ client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: nativeSessionId, turn_id: turnId }) } });
  span.setServingAccount('actual-account');
  span.recordProviderIdentity('resp-exact', 'actual-provider-model', null, 'actual-account');
  span.recordCacheUsage(10, 0, 0, 'resp-exact');
  const observation: CurrentBenchIdentityObservation = {
    worker: { taskId: task.taskId, workspaceId: task.workspaceId, ownerId: 'su-exact', nativeSessionId,
      runtimeRevision: 'a'.repeat(40), sourceRevision: 'b'.repeat(40), evidenceRef: 'loaded-runtime:task-observed' },
    nativeTranscript: [
      { type: 'session_meta', payload: { id: nativeSessionId, cli_version: '0.162.0' } },
      { type: 'turn_context', payload: { turn_id: turnId, model: 'native-requested-model', effort: 'high' } },
    ].map(record => JSON.stringify(record)).join('\n'),
    gateway: { processRef: 'gateway:exact-process', timeline: span.finish('ok', 200)! },
  };
  return { task, observation };
}

describe('exact native benchmark identity observation', () => {
  it('joins native version and turn with a provider response and complete exposure hashes', () => {
    const { task, observation } = observedFixture();
    const result = currentBenchIdentityFromObservation(task, observation);
    expect(result).toMatchObject({ model: 'actual-provider-model', effort: 'high', effortSource: 'forwarded-request',
      clientVersion: 'codex/0.162.0', accountId: 'actual-account', providerResponseId: 'resp-exact' });
    expect(result?.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result?.toolsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SYSTEM_PROMPT');
    observation.gateway.timeline.providerIdentity!.effort = 'high';
    expect(currentBenchIdentityFromObservation(task, observation)?.effortSource).toBe('provider-response');
  });
  it('binds the instruction template to the host-owned native home while retaining the exact request hash', () => {
    const { task, observation } = observedFixture();
    observation.worker.codexHome = '/host/owned-native-home';
    observation.gateway.timeline.cache.nativeInstructionTemplate = {
      version: 'codex-native-template-v1', fingerprint: { sha256: 'e'.repeat(64), bytes: 100, hashedBytes: 100 },
      skillsRootHash: createHash('sha256').update('/host/owned-native-home/skills/.system').digest('hex'),
    };
    const measured = currentBenchIdentityFromObservation(task, observation);
    expect(measured?.promptTemplateHash).toBe('e'.repeat(64));
    expect(measured?.promptHash).not.toBe(measured?.promptTemplateHash);
    observation.worker.codexHome = '/host/foreign-native-home';
    expect(currentBenchIdentityFromObservation(task, observation)).toBeNull();
    delete observation.worker.codexHome;
    expect(currentBenchIdentityFromObservation(task, observation)).toBeNull();
  });
  it.each(['workspace', 'task', 'owner', 'native', 'response', 'account', 'effort', 'partial-prompt', 'partial-tools', 'missing-provider', 'runtime', 'native-version', 'native-turn', 'native-model', 'native-effort', 'malformed-transcript'])('leaves %s drift or incomplete evidence unknown', changed => {
    const { task, observation: o } = observedFixture();
    const row = o.gateway.timeline;
    if (changed === 'workspace') o.worker.workspaceId = 'other';
    if (changed === 'task') o.worker.taskId = 'other';
    if (changed === 'owner') row.ownerId = 'other';
    if (changed === 'native') row.nativeCorrelation.threadId = '00000000-0000-0000-0000-000000000003';
    if (changed === 'response') row.cache.providerRequestId = 'resp-other';
    if (changed === 'account') row.cache.servingAccountId = 'other';
    if (changed === 'effort') row.providerIdentity!.effort = 'low';
    if (changed === 'partial-prompt') row.cache.instructions!.hashedBytes--;
    if (changed === 'partial-tools') row.cache.tools!.hashedBytes--;
    if (changed === 'missing-provider') row.providerIdentity = null;
    if (changed === 'runtime') o.worker.runtimeRevision = 'configured-alias';
    if (changed === 'native-version') o.nativeTranscript = o.nativeTranscript.replace('0.162.0', '');
    if (changed === 'native-turn') o.nativeTranscript = o.nativeTranscript.replace('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003');
    if (changed === 'native-model') o.nativeTranscript = o.nativeTranscript.replace('native-requested-model', 'configured-alias');
    if (changed === 'native-effort') o.nativeTranscript = o.nativeTranscript.replace('high', 'low');
    if (changed === 'malformed-transcript') o.nativeTranscript += '\n{';
    expect(currentBenchIdentityFromObservation(task, o)).toBeNull();
  });
});
function hostObservationFixture() {
  const { task, observation } = observedFixture();
  task.detail.coordOwnerId = observation.worker.ownerId;
  task.sessionId = observation.worker.nativeSessionId;
  task.startedAt = new Date(observation.gateway.timeline.startedAt - 1).toISOString();
  const rows: RuntimeVintageRow[] = ['worker', 'gateway'].map((unit, i) => ({
    workspaceId: 'host-ledger', unit, host: 'measured-host', treeSha: 'b'.repeat(40), buildTime: null,
    bundleVersion: null, pid: 100 + i, reportedAt: new Date(observation.gateway.timeline.startedAt - 2).toISOString(),
    extra: { kernelProcessIdentity: `kernel:${unit}`, ...(unit === 'gateway' ? { port: 8788 } : {}) },
  }));
  const report = { owner: observation.worker.ownerId,
    process: { pid: 101, identity: 'kernel:gateway', startedAt: observation.gateway.timeline.startedAt - 3 },
    stageTelemetry: { ownerId: observation.worker.ownerId, recent: [observation.gateway.timeline] } };
  const ports: CurrentBenchObservationReaderPorts = {
    readBinding: vi.fn(async () => ({ ownerId: observation.worker.ownerId, nativeSessionId: observation.worker.nativeSessionId, codexHome: '/host/native-home' })),
    readRuntimes: vi.fn(async () => rows), measureRuntimes: vi.fn(() => 'a'.repeat(64)),
    readTranscript: vi.fn(async () => observation.nativeTranscript), readGateway: vi.fn(async () => report),
  };
  const opts = { workspaceId: task.workspaceId, runtimeWorkspaceId: 'host-ledger', workerUnit: 'worker', gatewayUnit: 'gateway', gatewayBaseUrl: 'http://127.0.0.1:8788' };
  return { task, rows, report, ports, opts };
}
describe('host-backed benchmark observation reader', () => {
  async function privateHostFixture() {
    const f = hostObservationFixture(), protocol = currentProtocolFixture();
    const controller = currentBenchGatewayController({ workspaceId: f.task.workspaceId, loopId: 'private-observation-loop',
      token: 'b'.repeat(64), preregHash: 'a'.repeat(64), protocol, armId: 'papercusp', taskId: 't1', seed: 1,
      resources: { inputTokens: 1000, outputTokens: 100, requestsPerArm: 50, usdPerArm: 3, maxOpenUsd: 3,
        wallClockMs: 1000, wallClockMsPerArm: 100,
        armIds: protocol.arms.map(a => currentBenchAssignmentId(protocol.runId, a.id, 't1', 1)) },
      authenticateProvider: async () => null });
    const hosted = await controller.startNativeGateway(() => {}, async () => ({ port: 8788, stop: async () => {} } as never));
    f.rows.splice(1); f.rows[0].pid = process.pid;
    f.report.process.pid = process.pid; f.report.process.identity = 'kernel:worker';
    return { ...f, hosted };
  }
  it('observes the controller-issued private service against the same execution-host boot record', async () => {
    const f = await privateHostFixture();
    try {
      expect(await currentBenchObservationReader(f.opts, f.ports)(f.task)).toBeNull();
      const observation = await currentBenchObservationReader(f.opts, f.ports, f.hosted)(f.task);
      expect(currentBenchIdentityFromObservation(f.task, observation!)).toMatchObject({ sourceRevision: 'b'.repeat(40), model: 'actual-provider-model' });
      expect(vi.mocked(f.ports.measureRuntimes).mock.calls.at(-1)?.[1]).toEqual(['worker']);
    } finally { await f.hosted.stop(); }
  });
  it('refuses an unissued private credential and prevents report IO after revocation', async () => {
    const f = await privateHostFixture();
    try {
      const forged = { ...f.hosted, nativeGateway: { ...f.hosted.nativeGateway } };
      expect(() => liveCurrentBenchObservationReaderPorts(f.opts, forged)).toThrow(/controller-issued/);
      const io = liveCurrentBenchObservationReaderPorts(f.opts, f.hosted);
      await f.hosted.stop();
      expect(await io.readGateway(f.task.detail.coordOwnerId as string)).toBeNull();
    } finally { await f.hosted.stop(); }
  });
  it.each(['forged', 'workspace', 'port', 'worker-process', 'gateway-process', 'revoked', 'revoked-during-read'])(
    'refuses private service observation drift: %s', async changed => {
      const f = await privateHostFixture();
      try {
        if (changed === 'worker-process') f.rows[0].pid = process.pid + 1;
        if (changed === 'gateway-process') f.report.process.identity = 'replacement';
        if (changed === 'revoked') await f.hosted.stop();
        if (changed === 'revoked-during-read') f.ports.readTranscript = vi.fn(async () => {
          await f.hosted.stop(); return observedFixture().observation.nativeTranscript;
        });
        const opts = { ...f.opts,
          ...(changed === 'workspace' ? { workspaceId: 'bench-other' } : {}),
          ...(changed === 'port' ? { gatewayBaseUrl: 'http://127.0.0.1:8789' } : {}) };
        const hosted = changed === 'forged' ? { ...f.hosted, nativeGateway: { ...f.hosted.nativeGateway } } : f.hosted;
        if (['forged', 'workspace', 'port', 'revoked'].includes(changed))
          expect(() => currentBenchObservationReader(opts, f.ports, hosted)).toThrow(/controller-issued/);
        else expect(await currentBenchObservationReader(opts, f.ports, hosted)(f.task)).toBeNull();
      } finally { await f.hosted.stop(); }
    });
  it('joins exact native binding, execution-host boot pins and a process-matched gateway request', async () => {
    const f = hostObservationFixture();
    const observation = await currentBenchObservationReader(f.opts, f.ports)(f.task);
    expect(currentBenchIdentityFromObservation(f.task, observation!)).toMatchObject({ sourceRevision: 'b'.repeat(40), runtimeRevision: 'a'.repeat(64), model: 'actual-provider-model' });
    expect(f.ports.readRuntimes).toHaveBeenCalledTimes(2);
    expect(f.ports.readTranscript).toHaveBeenCalledWith(f.task.sessionId, '/host/native-home');
  });
  it.each(['task-workspace', 'missing-native', 'owner', 'kernel', 'pid', 'port', 'old-request', 'restarted', 'missing-transcript', 'abbreviated-source', 'runtime-workspace'])('refuses %s rather than fabricating loaded identity', async changed => {
    const f = hostObservationFixture();
    if (changed === 'task-workspace') f.task.workspaceId = 'production';
    if (changed === 'missing-native') f.task.sessionId = null;
    if (changed === 'owner') f.report.owner = 'other';
    if (changed === 'kernel') f.report.process.identity = 'new-process';
    if (changed === 'pid') f.report.process.pid++;
    if (changed === 'port') f.rows[1].extra.port = 1234;
    if (changed === 'old-request') f.task.startedAt = new Date(f.report.stageTelemetry.recent[0].finalizedAt + 1).toISOString();
    if (changed === 'restarted') f.ports.measureRuntimes = vi.fn().mockReturnValueOnce('a'.repeat(64)).mockReturnValueOnce('a'.repeat(64)).mockReturnValue('c'.repeat(64));
    if (changed === 'missing-transcript') f.ports.readTranscript = vi.fn(async () => null);
    if (changed === 'abbreviated-source') f.rows[0].treeSha = 'abcdef0';
    if (changed === 'runtime-workspace') f.rows[0].workspaceId = 'other';
    expect(await currentBenchObservationReader(f.opts, f.ports)(f.task)).toBeNull();
  });
  it('requires an explicit local observation endpoint without an embedded credential', () => {
    const f = hostObservationFixture();
    for (const gatewayBaseUrl of ['https://example.com', 'http://secret@127.0.0.1:8788', 'http://127.0.0.1:8788/other']) {
      expect(() => currentBenchObservationReader({ ...f.opts, gatewayBaseUrl }, f.ports)).toThrow(/explicit local/);
    }
  });
});
function fixture(opts = options) {
  let clock = 0;
  const row: CurrentBenchTask = {
    taskId: 'task-own', workspaceId: opts.workspaceId, state: 'exited', exitCode: 0,
    detail: { label: `${currentBenchAttemptLabel(opts.runId, handle)}solver` },
  };
  const lifecycle: BenchHarnessOps = {
    now: () => clock,
    createHarness: vi.fn(async () => handle), addFeature: vi.fn(async () => {}),
    driveToDone: vi.fn(async () => ({ disposition: 'error' as const })),
    collectCost: vi.fn(async () => ({ costUsd: 0.25, tokensIn: 20, tokensOut: 10, turns: 1 })),
    teardown: vi.fn(async () => {}),
  };
  const frozen = opts.preregistration.config as unknown as ReturnType<typeof currentProtocolFixture>;
  const contextText = '\n\nSynthetic permitted frozen context.';
  const context: BenchmarkContextReceipt = { schemaVersion: 1, workspaceId: opts.workspaceId,
    runId: opts.runId, preregHash: opts.preregistration.preregHash,
    assignmentId: currentBenchAssignmentId(opts.runId, opts.armId, 't1', opts.seed), harnessSlug: handle.slug,
    worktreePath: handle.worktreePath, corpusHash: frozen.context.corpusHash, memoryHash: frozen.context.memoryHash,
    corpusPath: `${handle.worktreePath}/corpus.json`, memoryPath: `${handle.worktreePath}/memory.json`,
    receiptPath: `${handle.worktreePath}/receipt.json`, receiptRef: `sha256:${'e'.repeat(64)}`,
    contextText, contextTextSha256: createHash('sha256').update(contextText).digest('hex') };
  const ports: CurrentSuBenchPorts = {
    verifyPreregistration: vi.fn(async () => ({ preregHash: 'frozen-protocol', gitCommitSha: 'a'.repeat(40), receiptRef: 'prereg:committed' })),
    admit: vi.fn(async () => ({ admitted: true, receiptRef: 'budget:reservation-1' })),
    restoreContext: vi.fn(async () => context), verifyContext: vi.fn(async () => context),
    launch: vi.fn(async () => ({ agentStarted: true, tasks: [{ taskId: row.taskId, ownerId: 'su-native' }] })),
    getTask: vi.fn(async () => row), listTasks: vi.fn(async () => [row]),
    killTask: vi.fn(async (id: string) => ({ ok: true as const, taskId: id, action: 'kill' })),
    sleep: vi.fn(async ms => { clock += ms; }),
    readCompletion: vi.fn(async () => null), readIdentity: vi.fn(async () => identity),
  };
  return { row, ports, lifecycle, context, run: () => currentSuBenchHarnessDriver(lifecycle, ports, opts).spinRunAndCost(request) };
}
describe('current native benchmark execution', () => {
  it('stock shares protocol/context/accounting checks without invoking a su launch or accepting its blueprint', async () => {
    const opts = { ...options, armId: 'baseline' };
    const f = fixture(opts), launchNative = vi.fn(async () => ({ agentStarted: true, tasks: [{ taskId: f.row.taskId }] }));
    const { launch, ...common } = f.ports;
    const stock = currentStockBenchHarnessDriver(f.lifecycle, { ...common, launchNative }, opts);
    const rejected = await stock.spinRunAndCost(request);
    expect(rejected.telemetry.stopReason).toBe('error');
    expect(launchNative).not.toHaveBeenCalled();
    const result = await stock.spinRunAndCost({ ...request, blueprintId: 'native-codex' });
    expect(result.telemetry.stopReason).toBe('done');
    expect(launchNative).toHaveBeenCalledWith({ handle, task: request.task, context: f.context });
    expect(launch).not.toHaveBeenCalled();
    expect(f.ports.verifyPreregistration).toHaveBeenCalled(); expect(f.ports.verifyContext).toHaveBeenCalled();
    expect(f.ports.killTask).toHaveBeenCalledWith(f.row.taskId);
  });
  // BM-P-004-equal-solver: in a controlled protocol each runner must declare the topology it executes.
  // The stock driver is the stock-native reference; the su driver cannot yet derive its delivered
  // capabilities under confinement, so its controlled arm refuses before any launch or spend.
  it('declares stock-native-reference for the stock driver and refuses a controlled su arm before launch', async () => {
    const protocol = currentProtocolFixture();
    const solverToolsHash = 'f'.repeat(64);
    protocol.arms[0].control = { topology: 'solo', solverGroup: 'su-solver', solverToolsHash, capabilities: allCapabilities('on') };
    protocol.arms[1].control = { topology: 'stock-native-reference', solverGroup: 'stock-solver', solverToolsHash, capabilities: allCapabilities('off') };
    const controlled = { ...options, preregistration: { ...options.preregistration, config: protocol } };

    const stockOpts = { ...controlled, armId: 'baseline' };
    const s = fixture(stockOpts), launchNative = vi.fn(async () => ({ agentStarted: true, tasks: [{ taskId: s.row.taskId }] }));
    const { launch: suLaunch, ...common } = s.ports;
    const stock = await currentStockBenchHarnessDriver(s.lifecycle, { ...common, launchNative }, stockOpts)
      .spinRunAndCost({ ...request, blueprintId: 'native-codex' });
    expect(stock.telemetry.stopReason).toBe('done');
    expect(launchNative).toHaveBeenCalledOnce();
    expect(suLaunch).not.toHaveBeenCalled();

    const su = fixture(controlled), refused = await su.run();
    expect(refused.telemetry.stopReason).toBe('error');
    expect(refused.telemetry.generationError).toMatch(/frozen as solo; the runner did not declare that topology/);
    expect(su.ports.admit).not.toHaveBeenCalled();
    expect(su.ports.launch).not.toHaveBeenCalled();
  });
  it('restores after committed protocol verification and re-reads after admission before launching the complete frozen context', async () => {
    const f = fixture(), result = await f.run();
    const order = (mock: unknown) => vi.mocked(mock as typeof f.ports.verifyPreregistration).mock.invocationCallOrder[0];
    expect(order(f.ports.verifyPreregistration)).toBeLessThan(order(f.ports.restoreContext));
    expect(order(f.ports.restoreContext)).toBeLessThan(order(f.ports.admit));
    expect(order(f.ports.admit)).toBeLessThan(order(f.ports.verifyContext));
    expect(order(f.ports.verifyContext)).toBeLessThan(order(f.ports.launch));
    expect(vi.mocked(f.ports.launch).mock.calls[0][0].brief).toContain(f.context.contextText);
    expect(result.telemetry.armMeta?.currentExecution).toMatchObject({
      initialContext: { status: 'verified-before-generation', corpusHash: f.context.corpusHash,
        memoryHash: f.context.memoryHash, assignmentId: f.context.assignmentId, receiptRef: f.context.receiptRef } });
    expect((result.telemetry.armMeta?.currentExecution as Record<string, unknown>).initialContext).not.toHaveProperty('contextText');
  });
  it.each(['workspaceId', 'runId', 'preregHash', 'assignmentId', 'harnessSlug', 'corpusHash', 'memoryHash', 'contextText', 'receiptRef'] as const)
  ('rejects a drifted %s restoration receipt before budget admission or generation', async field => {
    const f = fixture(); vi.mocked(f.ports.restoreContext).mockResolvedValue({ ...f.context, [field]: 'foreign-context' });
    expect((await f.run()).telemetry.generationError).toMatch(/initial context receipt/);
    expect(f.ports.admit).not.toHaveBeenCalled(); expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it('refuses context contamination between admission and launch without starting a native task', async () => {
    const f = fixture(); vi.mocked(f.ports.verifyContext).mockRejectedValue(new Error('snapshot bytes differ'));
    expect((await f.run()).telemetry.generationError).toMatch(/snapshot bytes differ/);
    expect(f.ports.admit).toHaveBeenCalledOnce(); expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it.each(['su', 'stock'] as const)('refuses a valid changed context re-read before native generation: %s', async kind => {
    const opts = kind === 'stock' ? { ...options, armId: 'baseline' } : options;
    const f = fixture(opts), contextText = f.context.contextText + '\nUnexpected additional context.';
    vi.mocked(f.ports.verifyContext).mockResolvedValue({ ...f.context, contextText,
      contextTextSha256: createHash('sha256').update(contextText).digest('hex') });
    const launchNative = vi.fn(async () => ({ agentStarted: true, tasks: [{ taskId: f.row.taskId }] }));
    const { launch, ...common } = f.ports;
    const result = kind === 'stock'
      ? await currentStockBenchHarnessDriver(f.lifecycle, { ...common, launchNative }, opts)
        .spinRunAndCost({ ...request, blueprintId: 'native-codex' })
      : await f.run();
    expect(result.telemetry.generationError).toMatch(/initial context changed before native generation/);
    expect(f.ports.admit).toHaveBeenCalledOnce();
    expect(f.ports.verifyContext).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
    expect(launchNative).not.toHaveBeenCalled();
    expect(result.telemetry.armMeta?.currentExecution).toMatchObject({ initialContext: { status: 'restored' } });
  });
  it.each([false, true])('releases the host gateway after cost collection even when lifecycle teardown fails=%s', async fails => {
    const f = fixture(), events: string[] = [];
    vi.mocked(f.lifecycle.collectCost).mockImplementation(async () => {
      events.push('cost'); return { costUsd: 0.25, tokensIn: 20, tokensOut: 10, turns: 1 };
    });
    vi.mocked(f.lifecycle.teardown).mockImplementation(async () => {
      events.push('teardown'); if (fails) throw new Error('private lifecycle teardown failed');
    });
    f.ports.releaseGateway = vi.fn(async () => { events.push('release'); });
    expect((await f.run()).telemetry.costUsd).toBe(0.25);
    expect(events).toEqual(['cost', 'teardown', 'release']);
    expect(f.ports.releaseGateway).toHaveBeenCalledOnce();
  });
  it('verifies the frozen protocol before reserving budget or launching', async () => {
    const f = fixture();
    const result = await f.run();
    expect(f.ports.verifyPreregistration).toHaveBeenCalledOnce();
    expect(vi.mocked(f.ports.verifyPreregistration).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.ports.admit).mock.invocationCallOrder[0]);
    expect(result.telemetry.armMeta?.currentExecution).toMatchObject({ preregistration: { preregHash: 'frozen-protocol', receiptRef: 'prereg:committed' } });
  });
  it('refuses uncommitted protocol before admission and generation', async () => {
    const f = fixture();
    vi.mocked(f.ports.verifyPreregistration).mockRejectedValue(new Error('protocol is not committed'));
    expect((await f.run()).telemetry.generationError).toMatch(/not committed/);
    expect(f.ports.admit).not.toHaveBeenCalled();
    expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it.each([
    { preregHash: 'different-protocol', gitCommitSha: 'a'.repeat(40), receiptRef: 'prereg:other' },
    { preregHash: 'frozen-protocol', gitCommitSha: '', receiptRef: 'prereg:missing-commit' },
    { preregHash: 'frozen-protocol', gitCommitSha: 'a'.repeat(40), receiptRef: '' },
  ])('refuses an unverifiable protocol receipt before budget admission: %j', async receipt => {
    const f = fixture();
    vi.mocked(f.ports.verifyPreregistration).mockResolvedValue(receipt);
    expect((await f.run()).telemetry.generationError).toMatch(/pre-registration receipt/);
    expect(f.ports.admit).not.toHaveBeenCalled();
    expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it.each(['data', 'structuredContent'])('reads the maintained launcher receipt from %s.launch', async field => {
    const f = fixture();
    vi.mocked(f.ports.launch).mockResolvedValue({
      content: [{ type: 'text', text: 'Opened one headless native solver.' }],
      [field]: { launch: { agentStarted: true, tasks: [{ taskId: f.row.taskId }] } },
    });
    const result = await f.run();
    expect(result.telemetry.stopReason).toBe('done');
    expect(result.telemetry.armMeta?.currentExecution).toMatchObject({
      launchReceipt: { agentStarted: true, tasks: [{ taskId: f.row.taskId }] },
      terminalReceipt: { taskId: f.row.taskId }, retiredTaskIds: [f.row.taskId],
    });
  });
  it('uses the maintained native su request, pins explicit controls and excludes hidden grader inputs', async () => {
    const f = fixture();
    const result = await f.run();
    expect(f.ports.launch).toHaveBeenCalledWith(expect.objectContaining({
      harness: handle.slug, cwd: handle.worktreePath, feature: handle.featureId, workItem: handle.featureId,
      independent: true, headless: true, count: 1, mcpTarget: 'spawn-host',
      extraArgs: ['--auto'],
      members: [{ role: 'su', agent: 'codex', model: 'configured-alias', effort: 'high', account: 'auto' }],
    }));
    const args = vi.mocked(f.ports.launch).mock.calls[0][0];
    expect(args.brief).toContain(request.task.problemStatement);
    expect(args.brief).not.toContain('SECRET');
    expect(result.telemetry.stopReason).toBe('done');
    expect(result.telemetry.armMeta?.currentExecution).toMatchObject({
      configured: { model: 'configured-alias', effort: 'high' }, measured: identity, identityStatus: 'measured',
      launchReceipt: { tasks: [{ taskId: 'task-own' }] }, terminalReceipt: { taskId: 'task-own', exitCode: 0 }, retiredTaskIds: ['task-own'],
    });
    expect(f.lifecycle.driveToDone).not.toHaveBeenCalled();
    expect(f.lifecycle.teardown).toHaveBeenCalledOnce();
  });
  it('compares only an explicitly frozen, source-bound native template and never falls back to the request hash', async () => {
    const opts = structuredClone(options);
    const protocol = opts.preregistration.config as unknown as ReturnType<typeof currentProtocolFixture>;
    const arm = protocol.arms.find(value => value.id === opts.armId)!;
    arm.runtime.promptHashMode = 'codex-native-template-v1'; arm.runtime.promptHash = 'e'.repeat(64);
    const f = fixture(opts);
    vi.mocked(f.ports.readIdentity).mockResolvedValue({ ...identity, promptTemplateHash: 'e'.repeat(64) });
    expect((await f.run()).telemetry.stopReason).toBe('done');
    vi.mocked(f.ports.readIdentity).mockResolvedValue({ ...identity, promptHash: 'e'.repeat(64) });
    const missing = await f.run();
    expect(missing.telemetry.stopReason).toBe('error');
    expect(missing.telemetry.generationError).toMatch(/promptHash/);
    vi.mocked(f.ports.readIdentity).mockResolvedValue({ ...identity, promptTemplateHash: 'f'.repeat(64) });
    expect((await f.run()).telemetry.stopReason).toBe('error');
  });
  it.each(['sourceRevision', 'runtimeRevision', 'clientVersion', 'promptHash', 'toolsHash', 'effort'] as const)(
    'rejects observed %s drift from the frozen arm and retains cleanup/cost evidence', async field => {
      const f = fixture();
      vi.mocked(f.ports.readIdentity).mockResolvedValue({ ...identity, [field]: 'different-observation' });
      const result = await f.run();
      expect(result.telemetry.stopReason).toBe('error');
      expect(result.telemetry.generationError).toMatch(/observed identity.*frozen protocol/i);
      expect(result.telemetry.armMeta?.currentExecution).toMatchObject({
        identityStatus: 'measured', protocolIdentity: { status: 'mismatch', mismatchFields: [field] },
        measured: { [field]: 'different-observation' }, retiredTaskIds: ['task-own'],
      });
      expect(result.telemetry.costUsd).toBe(0.25);
      expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
    },
  );
  it('detects changed tool exposure after an earlier matching native turn', async () => {
    const f = fixture(); f.row.state = 'running'; f.row.exitCode = null;
    vi.mocked(f.ports.readIdentity).mockResolvedValueOnce(identity).mockResolvedValue({ ...identity, toolsHash: 'c'.repeat(64) });
    const result = await f.run();
    expect(result.telemetry.generationError).toMatch(/toolsHash/);
    expect(result.telemetry.armMeta?.currentExecution).toMatchObject({
      protocolIdentity: { status: 'mismatch', mismatchFields: ['toolsHash'] }, retiredTaskIds: ['task-own'],
    });
  });
  it('does not reuse an earlier matching observation when completion has no current identity', async () => {
    const f = fixture(); f.row.state = 'running'; f.row.exitCode = null;
    vi.mocked(f.ports.readIdentity).mockResolvedValueOnce(identity).mockResolvedValue(null);
    vi.mocked(f.ports.readCompletion).mockResolvedValueOnce(null).mockResolvedValue('done');
    const result = await f.run();
    expect(result.telemetry.generationError).toMatch(/identity.*unobserved/i);
    expect(result.telemetry.armMeta?.currentExecution).toMatchObject({
      identityStatus: 'unknown', measured: null, protocolIdentity: { status: 'unobserved' }, retiredTaskIds: ['task-own'],
    });
  });
  it.each([null, { ...identity, measuredBy: 'configuration' }, { ...identity, toolsHash: '' }, { ...identity, evidenceRefs: [] }])(
    'does not convert missing or configured identity into a runtime measurement: %j', async value => {
      const f = fixture();
      vi.mocked(f.ports.readIdentity).mockResolvedValue(value as CurrentBenchIdentity | null);
      const result = await f.run();
      expect(result.telemetry.armMeta?.currentExecution).toMatchObject({ identityStatus: 'unknown', measured: null });
      expect(result.telemetry.stopReason).toBe('error');
      expect(result.telemetry.generationError).toMatch(/identity.*unobserved/i);
    },
  );
  it('refuses production workspace before registration or process launch', () => {
    const f = fixture();
    expect(() => currentSuBenchHarnessDriver(f.lifecycle, f.ports, { ...options, workspaceId: ' papercusp-workspace ' })).toThrow(/PRODUCTION/);
    expect(f.lifecycle.createHarness).not.toHaveBeenCalled();
    expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it('refuses retired treatment dispatch rather than reconstructing its blueprint', async () => {
    const f = fixture();
    const result = await currentSuBenchHarnessDriver(f.lifecycle, f.ports, options).spinRunAndCost({ ...request, blueprintId: 'external-bench' });
    expect(result.telemetry.generationError).toMatch(/retired treatment/);
    expect(f.lifecycle.createHarness).not.toHaveBeenCalled();
    expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it('records declined admission as a cap outcome and launches no process', async () => {
    const f = fixture();
    vi.mocked(f.ports.admit).mockResolvedValue({ admitted: false, receiptRef: 'budget:full' });
    expect((await f.run()).telemetry.stopReason).toBe('budget-exhausted');
    expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it('requires a durable budget receipt before launch', async () => {
    const f = fixture();
    vi.mocked(f.ports.admit).mockResolvedValue({ admitted: true, receiptRef: '' });
    expect((await f.run()).telemetry.generationError).toMatch(/no durable receipt/);
    expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it.each([{ model: 'changed' }, { effort: 'low' }, { account: 'other' }, { seed: 2 }, { armId: 'other' }] as const)(
    'refuses launch control or assignment drift before protocol read/admission: %j', async changed => {
      const f = fixture({ ...options, ...changed });
      expect((await f.run()).telemetry.generationError).toMatch(/frozen protocol/);
      expect(f.ports.verifyPreregistration).not.toHaveBeenCalled();
      expect(f.ports.admit).not.toHaveBeenCalled(); expect(f.ports.launch).not.toHaveBeenCalled();
    },
  );
  it('refuses undeclared task and budget drift before generation', async () => {
    for (const altered of [
      { ...request, task: { ...request.task, instanceId: 'unassigned' } },
      { ...request, budget: { ...request.budget, maxUsd: 4 } },
    ]) {
      const f = fixture();
      const result = await currentSuBenchHarnessDriver(f.lifecycle, f.ports, options).spinRunAndCost(altered);
      expect(result.telemetry.generationError).toMatch(/frozen protocol/);
      expect(f.ports.admit).not.toHaveBeenCalled(); expect(f.ports.launch).not.toHaveBeenCalled();
    }
  });
  it('cancels before launch without admitting or spending', async () => {
    const ac = new AbortController(); ac.abort();
    const f = fixture({ ...options, signal: ac.signal });
    expect((await f.run()).telemetry.stopReason).toBe('timeout');
    expect(f.ports.admit).not.toHaveBeenCalled();
    expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it('cancels a process whose launch completes after cancellation and retains its receipt', async () => {
    const ac = new AbortController();
    const f = fixture({ ...options, signal: ac.signal });
    vi.mocked(f.ports.launch).mockImplementation(async () => { ac.abort(); return { agentStarted: true, tasks: [{ taskId: 'task-own' }] }; });
    const result = await f.run();
    expect(result.telemetry.generationError).toMatch(/cancelled during/);
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
    expect(result.telemetry.armMeta?.currentExecution).toMatchObject({ retiredTaskIds: ['task-own'] });
  });
  it('uses the attempt wall-clock cap and retires its live task', async () => {
    const capped = { ...options, preregistration: { ...options.preregistration, config: currentProtocolFixture('run-1', 20) } };
    const f = fixture(capped); f.row.state = 'running'; f.row.exitCode = null;
    const result = await currentSuBenchHarnessDriver(f.lifecycle, f.ports, capped).spinRunAndCost({ ...request, budget: { maxUsd: 3, maxWallClockMs: 20 } });
    expect(result.telemetry.stopReason).toBe('timeout');
    expect(result.telemetry.wallClockMs).toBe(20);
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
  });
  it('preserves completed work while stopping a still-live native host', async () => {
    const f = fixture(); f.row.state = 'running'; f.row.exitCode = null;
    vi.mocked(f.ports.readCompletion).mockResolvedValue('done');
    expect((await f.run()).telemetry.stopReason).toBe('done');
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
  });
  it('stops at the metered attempt cap and retains the total cost', async () => {
    const f = fixture(); f.row.state = 'running'; f.row.exitCode = null;
    vi.mocked(f.lifecycle.collectCost).mockResolvedValue({ costUsd: 3, tokensIn: 20, tokensOut: 10, turns: 1 });
    const result = await f.run();
    expect(result.telemetry.stopReason).toBe('budget-exhausted');
    expect(result.telemetry.costUsd).toBe(3);
    expect(result.telemetry.armMeta).toMatchObject({ costUsdMeasurementMissing: true });
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
    expect(f.ports.launch).toHaveBeenCalledOnce();
  });
  it('stops at the complete native token cap including cache reads and writes', async () => {
    const protocol = currentProtocolFixture();
    for (const arm of protocol.arms) arm.generationBudget.maxTokens = 100;
    const capped = { ...options, preregistration: { ...options.preregistration, config: protocol } };
    const f = fixture(capped); f.row.state = 'running'; f.row.exitCode = null;
    f.ports.collectCost = vi.fn(async () => ({ costUsd: 0.001, tokensIn: 20, tokensOut: 10,
      tokensCacheRead: 60, tokensCacheWrite: 10, turns: 1 }));
    const result = await currentSuBenchHarnessDriver(f.lifecycle, f.ports, capped).spinRunAndCost({
      ...request, budget: { ...request.budget, maxTokens: 100 } });
    expect(result.telemetry.stopReason).toBe('budget-exhausted');
    expect(result.telemetry).toMatchObject({ tokensIn: 20, tokensOut: 10, tokensCacheRead: 60, tokensCacheWrite: 10 });
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
    expect(f.ports.sleep).not.toHaveBeenCalled();
  });
  it.each([
    ['negative-dollars', { costUsd: -1 }],
    ['nonfinite-dollars', { costUsd: Number.NaN }],
    ['absent-input', { tokensIn: undefined }],
    ['negative-input', { tokensIn: -1 }],
    ['fractional-output', { tokensOut: 0.5 }],
    ['unsafe-cache-read', { tokensCacheRead: Number.MAX_SAFE_INTEGER + 1 }],
    ['nonfinite-cache-write', { tokensCacheWrite: Number.POSITIVE_INFINITY }],
    ['null-cache-read', { tokensCacheRead: null }],
    ['null-cache-write', { tokensCacheWrite: null }],
    ['negative-turns', { turns: -1 }],
    ['unsafe-combined-tokens', { tokensIn: Number.MAX_SAFE_INTEGER, tokensOut: 1 }],
  ])('retires the live native task on invalid spend telemetry: %s', async (_name, changed) => {
    const f = fixture(); f.row.state = 'running'; f.row.exitCode = null;
    f.ports.collectCost = vi.fn(async () => ({ costUsd: 0.25, tokensIn: 20, tokensOut: 10, turns: 1,
      ...changed } as Awaited<ReturnType<BenchHarnessOps['collectCost']>>));
    const result = await f.run();
    expect(result.telemetry.stopReason).toBe('error');
    expect(result.telemetry.generationError).toMatch(/invalid.*spend measurement/i);
    expect(f.ports.sleep).not.toHaveBeenCalled();
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
    expect(f.ports.launch).toHaveBeenCalledOnce();
  });
  it('keeps a valid incomplete native subtotal while waiting for terminal accounting', async () => {
    const f = fixture(); f.row.state = 'running'; f.row.exitCode = null;
    f.ports.collectCost = vi.fn(async () => ({ costUsd: 0.25, tokensIn: 20, tokensOut: 10, turns: 1,
      costUsdMeasurementMissing: true }));
    f.ports.sleep = vi.fn(async () => { f.row.state = 'exited'; f.row.exitCode = 0; });
    const result = await f.run();
    expect(result.telemetry.stopReason).toBe('done');
    expect(result.telemetry.costUsd).toBe(0.25);
    expect(result.telemetry.armMeta).toMatchObject({ costUsdMeasurementMissing: true });
    expect(f.ports.sleep).toHaveBeenCalledOnce();
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
  });
  it('refuses a task receipt pointing to another workspace', async () => {
    const f = fixture(); f.row.workspaceId = 'papercusp-workspace';
    expect((await f.run()).telemetry.generationError).toMatch(/identity\/scope/);
    expect(f.ports.killTask).not.toHaveBeenCalled();
  });
  it('reports unobserved termination as an error rather than a clean exit', async () => {
    const f = fixture(); f.row.state = 'ended_unobserved'; f.row.exitCode = null;
    expect((await f.run()).telemetry.generationError).toMatch(/unobserved/);
  });
  it('cleans a partially launched task using durable labels when the launch reply is lost', async () => {
    const f = fixture(); vi.mocked(f.ports.launch).mockRejectedValue(new Error('transport lost receipt'));
    expect((await f.run()).telemetry.generationError).toMatch(/lost receipt/);
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
  });
  it('refuses a launch receipt without observed native start and cleans its task', async () => {
    const f = fixture(); vi.mocked(f.ports.launch).mockResolvedValue({ agentStarted: false, tasks: [{ taskId: 'task-own' }] });
    expect((await f.run()).telemetry.generationError).toMatch(/no verified single-agent start/);
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
  });
  function pendingLaunch(f: ReturnType<typeof fixture>) {
    f.row.detail.coordOwnerId = 'su-native';
    return { agentStarted: null, opened: 1, failed: 0, partial: false,
      launchEvidence: { processOpened: 1, sessionRegistered: 1, firstTurn: null },
      tasks: [{ taskId: f.row.taskId, ownerId: 'su-native', label: f.row.detail.label,
        kickoffProof: { persisted: true, nativeRef: '/private/native/rollout.jsonl' } }] };
  }
  it('waits for measured identity after a registered pending native kickoff', async () => {
    const f = fixture(); f.row.state = 'pending'; f.row.exitCode = null;
    vi.mocked(f.ports.launch).mockResolvedValue(pendingLaunch(f));
    vi.mocked(f.ports.readIdentity).mockResolvedValueOnce(null).mockResolvedValue(identity);
    f.ports.sleep = vi.fn(async () => { f.row.state = 'exited'; f.row.exitCode = 0; });
    const result = await f.run();
    expect(result.telemetry.stopReason).toBe('done');
    expect(f.ports.sleep).toHaveBeenCalledOnce();
    expect(result.telemetry.armMeta?.currentExecution).toMatchObject({
      launchReceipt: { agentStarted: null }, nativeStart: { status: 'measured' }, identityStatus: 'measured',
      retiredTaskIds: [f.row.taskId],
    });
  });
  it.each(['missing-proof', 'missing-ref', 'unregistered', 'multiple', 'explicit-failure', 'missing-verdict'])(
    'refuses invalid pending native kickoff evidence: %s', async invalid => {
      const f = fixture(); const receipt = pendingLaunch(f);
      if (invalid === 'missing-proof') receipt.tasks[0].kickoffProof.persisted = false;
      if (invalid === 'missing-ref') receipt.tasks[0].kickoffProof.nativeRef = '';
      if (invalid === 'unregistered') receipt.launchEvidence.sessionRegistered = 0;
      if (invalid === 'multiple') receipt.tasks.push({ ...receipt.tasks[0], taskId: 'peer' });
      const reply = { ...receipt, agentStarted: invalid === 'explicit-failure' ? false : invalid === 'missing-verdict' ? undefined : null };
      vi.mocked(f.ports.launch).mockResolvedValue(reply);
      expect((await f.run()).telemetry.generationError).toMatch(/no verified single-agent start/);
      expect(f.ports.readIdentity).not.toHaveBeenCalled();
      expect(f.ports.killTask).toHaveBeenCalledWith(f.row.taskId);
    });
  it.each(['owner', 'workspace', 'label'])('refuses pending native kickoff with wrong task %s', async invalid => {
    const f = fixture(); const receipt = pendingLaunch(f);
    if (invalid === 'owner') f.row.detail.coordOwnerId = 'su-peer';
    if (invalid === 'workspace') f.row.workspaceId = 'peer-workspace';
    if (invalid === 'label') f.row.detail.label = 'peer-label';
    vi.mocked(f.ports.launch).mockResolvedValue(receipt);
    expect((await f.run()).telemetry.generationError).toMatch(/identity\/scope/);
    expect(f.ports.readIdentity).not.toHaveBeenCalled();
  });
  it('bounds pending native kickoff with the existing wall-clock deadline and retires it', async () => {
    const f = fixture(); f.row.state = 'pending'; f.row.exitCode = null;
    vi.mocked(f.ports.launch).mockResolvedValue(pendingLaunch(f));
    vi.mocked(f.ports.readIdentity).mockResolvedValue(null);
    const result = await f.run();
    expect(result.telemetry.stopReason).toBe('timeout');
    expect(result.telemetry.armMeta?.currentExecution).toMatchObject({
      nativeStart: { status: 'pending' }, identityStatus: 'unknown', retiredTaskIds: [f.row.taskId],
    });
    expect(f.ports.sleep).toHaveBeenCalled();
  });
  it('does not claim successful generation when process cleanup fails', async () => {
    const f = fixture();
    vi.mocked(f.ports.killTask).mockResolvedValue({ ok: false, taskId: 'task-own', action: 'kill', error: 'not_live' });
    const result = await f.run();
    expect(result.telemetry.stopReason).toBe('error');
    expect(result.telemetry.generationError).toMatch(/cleanup failed/);
  });
});
describe('current benchmark restart and live binding', () => {
  it('recovers only tasks belonging to the exact interrupted run and workspace', async () => {
    const f = fixture();
    const peer = { ...f.row, taskId: 'peer', detail: { label: `${currentBenchRunLabel('run-2')}solver` } };
    const production = { ...f.row, taskId: 'production', workspaceId: 'papercusp-workspace' };
    vi.mocked(f.ports.listTasks).mockResolvedValue([f.row, peer, production]);
    expect(await recoverCurrentBenchRun(f.ports, options)).toEqual(['task-own']);
    expect(f.ports.listTasks).toHaveBeenCalledWith({ workspaceId: 'bench-private', labelPrefix: currentBenchRunLabel('run-1'), includeEnded: true, limit: 1000 });
    expect(f.ports.killTask).toHaveBeenCalledExactlyOnceWith('task-own');
  });
  it('fails closed on a truncated cleanup census', async () => {
    const f = fixture(); vi.mocked(f.ports.listTasks).mockResolvedValue(Array.from({ length: 1000 }, () => f.row));
    await expect(recoverCurrentBenchRun(f.ports, options)).rejects.toThrow(/census exceeded/);
    expect(f.ports.killTask).not.toHaveBeenCalled();
  });
  it.each([undefined, 'on', 'off'] as const)('binds native ledger exposure %s while retaining authenticated observer ownership', async ledger => {
    const f = fixture();
    const ctx = { workspaceId: 'bench-private', authenticatedPrincipal: { retained: true } } as unknown as PapercuspUnifiedToolContext;
    const protocol = currentProtocolFixture(), preregHash = 'a'.repeat(64);
    if (ledger) {
      protocol.arms[0].control = { topology: 'solo', solverGroup: 'ledger-control',
        solverToolsHash: 'f'.repeat(64), capabilities: { ...allCapabilities('off'), 'work-item-ledger': ledger } };
      protocol.arms[1].control = { topology: 'stock-native-reference', solverGroup: 'stock-control',
        solverToolsHash: 'f'.repeat(64), capabilities: allCapabilities('off') };
    }
    const snapshotRoot = mkdtempSync(join(tmpdir(), 'bench-launch-context-'));
    const checkout = join(snapshotRoot, 'assignment'); mkdirSync(checkout);
    const snapshot = JSON.stringify({ entries: [{ key: 'permitted:fixture', text: 'Frozen initial context.' }] });
    for (const name of ['corpus', 'memory']) writeFileSync(join(snapshotRoot, `${name}.json`), snapshot);
    protocol.context = { ...protocol.context, corpusRef: 'corpus.json', memoryRef: 'memory.json',
      corpusHash: createHash('sha256').update(snapshot).digest('hex'), memoryHash: createHash('sha256').update(snapshot).digest('hex') };
    const restoredHandle = { ...handle, worktreePath: checkout };
    const controller = currentBenchGatewayController({ workspaceId: options.workspaceId, loopId: 'private-host-loop',
      token: 'b'.repeat(64), preregHash, protocol, armId: 'papercusp', taskId: 't1', seed: 1,
      resources: { inputTokens: 1000, outputTokens: 100, requestsPerArm: 50, usdPerArm: 3, maxOpenUsd: 3,
        wallClockMs: 1000, wallClockMsPerArm: 100,
        armIds: protocol.arms.map(a => currentBenchAssignmentId(protocol.runId, a.id, 't1', 1)) },
      authenticateProvider: async () => null });
    const stop = vi.fn(async () => {});
    const hosted = await controller.startNativeGateway(() => {}, async () => ({ port: 32101, stop } as never));
    const opts = { ...options, preregistration: { preregHash, config: protocol, repoRoot: snapshotRoot } };
    const ports = liveCurrentSuBenchPorts(ctx, { admit: f.ports.admit, observeIdentity: async () => null, ...hosted }, opts);
    const context = await ports.restoreContext(restoredHandle, 't1');
    const args = currentBenchLaunchRequest(opts, restoredHandle, 'issue', context);
    try { await ports.launch(args);
    const forwarded = native.launch.mock.calls.at(-1)![1];
    expect(forwarded.authenticatedPrincipal).toBe((ctx as unknown as { authenticatedPrincipal: unknown }).authenticatedPrincipal);
    expect(forwarded.workspaceId).toBe(ctx.workspaceId);
    expect(forwarded[Symbol.for('benchmark-test-private-route')]).toEqual(hosted.nativeGateway);
    expect(forwarded[Symbol.for('benchmark-test-server-ceiling')]).toMatchObject({
      denyTools: [], denyAmbientContext: true,
      denyOutside: ledger === 'off' ? ['coord:whoami'] : ['coord:whoami', 'work_items:get', 'work_items:checkpoint', 'work_items:complete'],
      denyWorkItemsOutside: { id: restoredHandle.featureId, harness: restoredHandle.slug, checkout },
      imposedBy: expect.stringContaining('benchmark-host') });
    expect(Object.getOwnPropertySymbols(ctx)).not.toContain(Symbol.for('benchmark-test-private-route'));
    // A host launch (no containerExec) never pins the backend binary.
    expect(forwarded[Symbol.for('benchmark-test-backend-bin')]).toBeUndefined();
    const launched = native.launch.mock.calls.at(-1)![0];
    // The worker's binding remains for observer admission/cancellation, even
    // when its experimental ledger prompt and tools are withheld.
    expect(launched).toMatchObject({ workItem: restoredHandle.featureId, feature: restoredHandle.featureId });
    expect(launched.brief.includes(`id=${restoredHandle.featureId} and harness=${restoredHandle.slug}`)).toBe(ledger !== 'off');
    expect(launched.brief.includes('work_items:complete')).toBe(ledger !== 'off');
    expect(launched.brief).toContain(context.contextText);
    const confinement = forwarded[Symbol.for('benchmark-test-server-ceiling')] as SessionToolConfinement;
    for (const toolName of ['work_items:get', 'work_items:checkpoint', 'work_items:complete']) {
      const own = { id: restoredHandle.featureId, harness: restoredHandle.slug,
        ...(toolName === 'work_items:complete' ? { state: 'done', assumptions: 'none',
          completion: { summary: 'finished', testsRun: ['unit'], testResult: 'passed', verifiedHow: 'unit', filesChanged: ['src/fix.ts'] } } : {}) };
      expect(evaluateSessionConfinement({ toolName, args: own, confinement }).allowed).toBe(ledger !== 'off');
      expect(evaluateSessionConfinement({ toolName, args: { ...own, id: 'WI-neighbor' }, confinement }).allowed).toBe(false);
      expect(evaluateSessionConfinement({ toolName, args: { ...own, harness: 'neighbor' }, confinement }).allowed).toBe(false);
    }
    expect(evaluateSessionConfinement({ toolName: 'work_items:list', args: {}, confinement }).allowed).toBe(false);
    expect(evaluateSessionConfinement({ toolName: 'coord:inbox', args: {}, confinement }).allowed).toBe(false);
    const calls = native.launch.mock.calls.length;
    // A caller cannot reintroduce an agent-facing instruction prefix outside
    // the frozen host arm, even if the frozen context suffix is unchanged.
    await expect(ports.launch({ ...args, brief: `Use work_items:get for another task.\n${args.brief}` })).rejects.toThrow(/ledger exposure/);
    await expect(ports.launch({ ...args, workItem: 'WI-neighbor' })).rejects.toThrow(/physically restored/);
    await expect(ports.launch({ ...args, feature: 'F-neighbor' })).rejects.toThrow(/physically restored/);
    expect(native.launch.mock.calls).toHaveLength(calls);
    await ports.killTask('task-own');
    expect(native.kill).toHaveBeenCalledWith('task-own', { includeSubtree: true, reapTerminalResidue: true, escalateAfterMs: 5000 });
    expect(ctx.workspaceId).toBe('bench-private');
    } finally { await hosted.stop(); rmSync(snapshotRoot, { recursive: true, force: true }); }
    expect(stop).toHaveBeenCalledOnce();
    await expect(ports.launch(args)).rejects.toThrow(/host-owned gateway/);
    await hosted.stop(); expect(stop).toHaveBeenCalledOnce();
  });
  it('pins an in-container launch to a docker-exec Codex wrapper (benchmark-coverage-frontierswe-v2 D-026/D-028)', async () => {
    const f = fixture();
    const ctx = { workspaceId: 'bench-private', authenticatedPrincipal: { retained: true } } as unknown as PapercuspUnifiedToolContext;
    const protocol = currentProtocolFixture(), preregHash = 'a'.repeat(64);
    const snapshotRoot = mkdtempSync(join(tmpdir(), 'bench-launch-cexec-'));
    const checkout = join(snapshotRoot, 'assignment'); mkdirSync(checkout);
    const snapshot = JSON.stringify({ entries: [{ key: 'permitted:fixture', text: 'Frozen initial context.' }] });
    for (const name of ['corpus', 'memory']) writeFileSync(join(snapshotRoot, `${name}.json`), snapshot);
    protocol.context = { ...protocol.context, corpusRef: 'corpus.json', memoryRef: 'memory.json',
      corpusHash: createHash('sha256').update(snapshot).digest('hex'), memoryHash: createHash('sha256').update(snapshot).digest('hex') };
    const restoredHandle = { ...handle, worktreePath: checkout };
    const controller = currentBenchGatewayController({ workspaceId: options.workspaceId, loopId: 'private-host-loop',
      token: 'b'.repeat(64), preregHash, protocol, armId: 'papercusp', taskId: 't1', seed: 1,
      resources: { inputTokens: 1000, outputTokens: 100, requestsPerArm: 50, usdPerArm: 3, maxOpenUsd: 3,
        wallClockMs: 1000, wallClockMsPerArm: 100,
        armIds: protocol.arms.map(a => currentBenchAssignmentId(protocol.runId, a.id, 't1', 1)) },
      authenticateProvider: async () => null });
    const hosted = await controller.startNativeGateway(() => {}, async () => ({ port: 32102, stop: vi.fn(async () => {}) } as never));
    const opts = { ...options, preregistration: { preregHash, config: protocol, repoRoot: snapshotRoot } };
    const containerExec = { kind: 'docker-exec' as const, containerId: 'fswe-task-1', workdir: '/app', binPath: '/opt/papercusp/codex' };
    try {
      expect(() => liveCurrentSuBenchPorts(ctx, { admit: f.ports.admit, observeIdentity: async () => null, ...hosted,
        containerExec: { ...containerExec, workdir: 'app' } }, opts)).toThrow(/workdir must be absolute/);
      const ports = liveCurrentSuBenchPorts(ctx, { admit: f.ports.admit, observeIdentity: async () => null, ...hosted, containerExec }, opts);
      const context = await ports.restoreContext(restoredHandle, 't1');
      const args = currentBenchLaunchRequest(opts, restoredHandle, 'issue', context);
      await ports.launch(args);
      const forwarded = native.launch.mock.calls.at(-1)![1];
      const override = forwarded[Symbol.for('benchmark-test-backend-bin')] as Record<string, { kind: string; command: string; sha256: string }>;
      expect(Object.keys(override)).toEqual(['codex']);
      expect(override.codex).toMatchObject({ kind: 'docker-exec', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      const wrapper = readFileSync(override.codex.command, 'utf8');
      expect(wrapper).toContain('fswe-task-1');
      expect(wrapper).toContain('/opt/papercusp/codex');
      expect(statSync(override.codex.command).mode & 0o111).not.toBe(0);
      // The in-container launch keeps the private gateway route and the session ceiling.
      expect(forwarded[Symbol.for('benchmark-test-private-route')]).toEqual(hosted.nativeGateway);
      expect(forwarded[Symbol.for('benchmark-test-server-ceiling')]).toMatchObject({ denyAmbientContext: true });
      // A carry-respawn re-launch re-execs the same wrapper against the same container.
      await ports.launch(args);
      expect(native.launch.mock.calls.at(-1)![1][Symbol.for('benchmark-test-backend-bin')]).toEqual({ codex: override.codex });
      // A swept temp file is re-materialized rather than handed to psu as a dead path.
      rmSync(override.codex.command);
      await ports.launch(args);
      const again = native.launch.mock.calls.at(-1)![1][Symbol.for('benchmark-test-backend-bin')] as typeof override;
      expect(readFileSync(again.codex.command, 'utf8')).toContain('fswe-task-1');
    } finally { await hosted.stop(); rmSync(snapshotRoot, { recursive: true, force: true }); }
  });
  it('refuses an unsupported native client before starting a service', async () => {
    const f = budgetFixture(); f.input.protocol.arms[0].agent = 'claude';
    const controller = currentBenchGatewayController(f.input, f.governor), start = vi.fn();
    try { await expect(controller.startNativeGateway(() => {}, start)).rejects.toThrow(/unsupported/);
      expect(start).not.toHaveBeenCalled();
    } finally { controller.revoke(); f.revoke(); }
  });
  it('refuses a production launch without the host private route before invoking the native handler', async () => {
    const ctx = { workspaceId: 'bench-private' } as PapercuspUnifiedToolContext;
    const ports = liveCurrentSuBenchPorts(ctx, { admit: fixture().ports.admit, observeIdentity: async () => null }, options);
    const before = native.launch.mock.calls.length;
    await expect(ports.launch(currentBenchLaunchRequest(options, handle, 'issue'))).rejects.toThrow(/host-owned gateway/);
    expect(native.launch.mock.calls.length).toBe(before);
  });
  it.each(['absent', 'plausible', 'foreign'] as const)('refuses an unissued private route with %s accounting before native launch', async mode => {
    const ctx = { workspaceId: options.workspaceId } as PapercuspUnifiedToolContext;
    const nativeAccountingBinding = mode === 'absent' ? undefined : {
      workspaceId: mode === 'foreign' ? 'other-private' : options.workspaceId,
      runId: options.runId, loopId: 'unissued-host-loop', preregHash: options.preregistration.preregHash,
      assignmentId: currentBenchAssignmentId(options.runId, options.armId, 't1', options.seed),
    };
    const ports = liveCurrentSuBenchPorts(ctx, { admit: fixture().ports.admit, observeIdentity: async () => null,
      nativeGateway: { baseURL: 'http://127.0.0.1:32101', token: 'a'.repeat(64) }, nativeAccountingBinding }, options);
    const before = native.launch.mock.calls.length;
    await expect(ports.launch(currentBenchLaunchRequest(options, handle, 'issue'))).rejects.toThrow(/host-owned gateway/);
    expect(native.launch.mock.calls.length).toBe(before);
  });
  it.each(['cloned-route', 'foreign-loop', 'other-arm', 'other-seed', 'protocol-drift', 'wrong-model', 'wrong-effort', 'wrong-account', 'revoked'] as const)(
    'refuses host gateway drift before native launch: %s', async changed => {
      const b = budgetFixture(), stop = vi.fn(async () => {});
      const hosted = await b.startNativeGateway(() => {}, async () => ({ port: 32102, stop } as never));
      const opts = { ...options, preregistration: { preregHash: b.input.preregHash, config: b.input.protocol } };
      const observations = { admit: fixture().ports.admit, observeIdentity: async () => null, ...hosted };
      const args = currentBenchLaunchRequest(opts, handle, 'issue');
      if (changed === 'cloned-route') observations.nativeGateway = { ...hosted.nativeGateway };
      if (changed === 'foreign-loop') observations.nativeAccountingBinding = { ...hosted.nativeAccountingBinding, loopId: 'foreign' };
      if (changed === 'other-arm') opts.armId = 'baseline';
      if (changed === 'other-seed') opts.seed = 2;
      if (changed === 'protocol-drift') opts.preregistration.config.grader.version = 'post-outcome';
      if (changed === 'wrong-model') args.members![0].model = 'unregistered-model';
      if (changed === 'wrong-effort') args.members![0].effort = 'low';
      if (changed === 'wrong-account') args.members![0].account = 'foreign-account';
      if (changed === 'revoked') b.revoke();
      const before = native.launch.mock.calls.length;
      try { await expect(liveCurrentSuBenchPorts({ workspaceId: options.workspaceId } as PapercuspUnifiedToolContext,
        observations, opts).launch(args)).rejects.toThrow(/host-owned gateway/);
        expect(native.launch.mock.calls.length).toBe(before);
      } finally { await hosted.stop(); }
      expect(stop).toHaveBeenCalledOnce();
    });
  it.each(['task', 'budget', 'revoked-during-admission'] as const)('refuses admission drift: %s', async changed => {
    const b = budgetFixture();
    const hosted = await b.startNativeGateway(() => {}, async () => ({ port: 32103, stop: async () => {} } as never));
    const opts = { ...options, preregistration: { preregHash: b.input.preregHash, config: b.input.protocol } };
    const admit = vi.fn(async () => { if (changed === 'revoked-during-admission') b.revoke();
      return { admitted: true, receiptRef: 'private-host-admission' }; });
    const ports = liveCurrentSuBenchPorts({ workspaceId: options.workspaceId } as PapercuspUnifiedToolContext,
      { ...hosted, admit, observeIdentity: async () => null }, opts);
    try { await expect(ports.admit(handle, changed === 'budget' ? { maxUsd: 4 } : b.input.protocol.arms[0].generationBudget,
      changed === 'task' ? 'foreign-task' : 't1')).rejects.toThrow(/host assignment|host-owned gateway/);
      expect(admit).toHaveBeenCalledTimes(changed === 'revoked-during-admission' ? 1 : 0);
    } finally { await hosted.stop(); }
  });
  it('revokes a controller and closes a service that finishes startup after cancellation', async () => {
    const b = budgetFixture(), stop = vi.fn(async () => {});
    const start = vi.fn(async () => { b.revoke(); return { port: 32104, stop } as never; });
    await expect(b.startNativeGateway(() => {}, start)).rejects.toThrow(/revoked during startup/);
    expect(stop).toHaveBeenCalledOnce();
    await expect(b.startNativeGateway(() => {}, start)).rejects.toThrow(/revoked/);
    expect(start).toHaveBeenCalledOnce();
    expect(await b.gateway.carryTrial.authorizeAttempt(b.attempt)).toBeNull();
  });
  it('allows only one service startup and revokes authority before an idempotent failing shutdown', async () => {
    const b = budgetFixture();
    const stop = vi.fn(async () => { throw new Error('private shutdown failed'); });
    const start = vi.fn(async () => ({ port: 32105, stop } as never));
    const opening = b.startNativeGateway(() => {}, start);
    await expect(b.startNativeGateway(() => {}, start)).rejects.toThrow(/already started/);
    const hosted = await opening;
    const a = hosted.stop(), c = hosted.stop(); expect(a).toBe(c);
    await expect(a).rejects.toThrow(/private shutdown failed/);
    expect(stop).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledOnce();
    expect(await b.gateway.carryTrial.authorizeAttempt(b.attempt)).toBeNull();
  });
  it('production ports derive identity from scoped observations instead of accepting a configured measurement', async () => {
    const { task, observation } = observedFixture();
    const ctx = { workspaceId: 'bench-private' } as PapercuspUnifiedToolContext;
    const observeIdentity = vi.fn(async () => observation);
    const ports = liveCurrentSuBenchPorts(ctx, { admit: fixture().ports.admit, observeIdentity }, options);
    expect(await ports.readIdentity(task)).toMatchObject({ model: 'actual-provider-model', clientVersion: 'codex/0.162.0' });
    expect(observeIdentity).toHaveBeenCalledWith(task);
    observation.worker.workspaceId = 'other';
    expect(await ports.readIdentity(task)).toBeNull();
  });
});

describe('P-019 host-issued fresh native session allowances', () => {
  async function sessionFixture(snapshotRoot?: string) {
    const protocol = controlledProtocolFixture();
    protocol.arms.find(arm => arm.id === 'repeated-session')!.id = 'baseline';
    for (const arm of protocol.arms) arm.generationBudget.maxTokens = 100;
    if (snapshotRoot) {
      const snapshot = readFileSync(join(snapshotRoot, 'corpus.json'));
      protocol.context = { ...protocol.context, corpusRef: 'corpus.json', memoryRef: 'memory.json',
        corpusHash: createHash('sha256').update(snapshot).digest('hex'),
        memoryHash: createHash('sha256').update(readFileSync(join(snapshotRoot, 'memory.json'))).digest('hex') };
    }
    const opts = { ...options, armId: 'baseline', preregistration: { preregHash: 'a'.repeat(64), config: protocol,
      ...(snapshotRoot ? { repoRoot: snapshotRoot } : {}) } };
    const controller = currentBenchGatewayController({ workspaceId: opts.workspaceId, loopId: 'session-budget-loop',
      token: 'b'.repeat(64), preregHash: opts.preregistration.preregHash, protocol, armId: opts.armId, taskId: 't1', seed: 1,
      resources: { inputTokens: 1000, outputTokens: 100, requestsPerArm: 50, usdPerArm: 3, maxOpenUsd: 3,
        totalTokensPerArm: 100, wallClockMs: 1000, wallClockMsPerArm: 100,
        armIds: protocol.arms.map(arm => currentBenchAssignmentId(protocol.runId, arm.id, 't1', 1)) },
      authenticateProvider: async () => null });
    const stop = vi.fn(async () => {});
    const hosted = await controller.startNativeGateway(() => {}, async () => ({ port: 32109, stop } as never));
    const admit = vi.fn(async () => ({ admitted: true, receiptRef: 'host-admission' }));
    const observation = (sessionBudget?: ReturnType<typeof hosted.issueSessionBudget>) =>
      ({ ...hosted, sessionBudget, admit, observeIdentity: async () => null });
    const ports = (sessionBudget?: ReturnType<typeof hosted.issueSessionBudget>) =>
      liveCurrentSuBenchPorts({ workspaceId: opts.workspaceId } as PapercuspUnifiedToolContext, observation(sessionBudget), opts);
    const budget = { maxUsd: 2, maxTokens: 80, maxWallClockMs: 75 };
    return { protocol, opts, hosted, admit, ports, observation, budget, stop };
  }

  it('reuses and revalidates the same frozen context across fresh native sessions without resetting task edits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bench-fresh-context-')), checkout = join(root, 'assignment');
    mkdirSync(checkout);
    const snapshot = JSON.stringify({ entries: [{ key: 'permitted:test', text: 'Frozen initial task context.' }] });
    for (const name of ['corpus', 'memory']) writeFileSync(join(root, `${name}.json`), snapshot);
    const f = await sessionFixture(root), sameHandle = { ...handle, worktreePath: checkout };
    try {
      const first = f.ports(f.hosted.issueSessionBudget(f.budget));
      const context = await first.restoreContext(sameHandle, 't1');
      await first.releaseGateway!();
      writeFileSync(join(checkout, 'task-edit.txt'), 'Retain completed task work.');
      const second = f.ports(f.hosted.issueSessionBudget(f.budget));
      expect(await second.restoreContext(sameHandle, 't1')).toEqual(context);
      expect(await second.verifyContext(sameHandle, 't1')).toEqual(context);
      expect(readFileSync(join(checkout, 'task-edit.txt'), 'utf8')).toBe('Retain completed task work.');
      writeFileSync(context.corpusPath, 'Changed context must not be silently restored.');
      await expect(second.restoreContext(sameHandle, 't1')).rejects.toThrow(/snapshot bytes differ/);
      expect(readFileSync(context.corpusPath, 'utf8')).toBe('Changed context must not be silently restored.');
    } finally { await f.hosted.stop(); rmSync(root, { recursive: true, force: true }); }
  });

  it('pins tightened execution caps separately from the frozen protocol and consumes one native start', async () => {
    const f = await sessionFixture();
    try {
      const receipt = f.hosted.issueSessionBudget(f.budget), ports = f.ports(receipt);
      f.budget.maxUsd = 1; // Caller mutation cannot change the issued allowance.
      expect(Object.isFrozen(receipt)).toBe(true); expect(Object.isFrozen(receipt.budget)).toBe(true);
      expect(ports.verifyGenerationBudget!(receipt.budget, 't1')).toMatchObject({
        frozenBudget: { maxUsd: 3, maxTokens: 100, maxWallClockMs: 100 }, topology: 'repeated-session', sessionBudget: receipt });
      expect(() => ports.verifyGenerationBudget!({ ...receipt.budget, maxUsd: 3 }, 't1')).toThrow(/allowance/);
      expect(() => beginCurrentBenchNativeSession(f.observation(receipt), f.opts, handle)).toThrow(/not admitted/);
      await ports.admit(handle, receipt.budget, 't1');
      await expect(ports.admit(handle, receipt.budget, 't1')).rejects.toThrow(/already admitted/);
      expect(() => beginCurrentBenchNativeSession(f.observation(receipt), f.opts, { ...handle, slug: 'other' })).toThrow(/not admitted/);
      const spawn = beginCurrentBenchNativeSession(f.observation(receipt), f.opts, handle);
      expect(() => beginCurrentBenchNativeSession(f.observation(receipt), f.opts, handle)).toThrow(/already used/);
      spawn(); expect(() => spawn()).toThrow(/already spawned/);
      await ports.releaseGateway!(); expect(f.stop).not.toHaveBeenCalled();
      expect(() => ports.verifyGenerationBudget!(receipt.budget, 't1')).toThrow(/active host-issued/);
      const next = f.hosted.issueSessionBudget({ ...f.budget, maxUsd: 0.5 });
      expect(next.index).toBe(1); expect(next.binding).toEqual(receipt.binding);
      expect(() => beginCurrentBenchNativeSession(f.observation(receipt), f.opts, handle)).toThrow(/active host-issued/);
    } finally { await f.hosted.stop(); }
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it.each(['missing', 'copied', 'foreign'] as const)('refuses a %s allowance before admission', async mode => {
    const f = await sessionFixture(), peer = await sessionFixture();
    try {
      const receipt = f.hosted.issueSessionBudget(f.budget);
      const invalid = mode === 'missing' ? undefined : mode === 'copied' ? { ...receipt } : peer.hosted.issueSessionBudget(peer.budget);
      await expect(f.ports(invalid).admit(handle, f.budget, 't1')).rejects.toThrow(/active host-issued/);
      expect(f.admit).not.toHaveBeenCalled();
    } finally { await f.hosted.stop(); await peer.hosted.stop(); }
  });

  it.each([
    { maxUsd: 4, maxTokens: 80, maxWallClockMs: 75 },
    { maxUsd: 2, maxTokens: 101, maxWallClockMs: 75 },
    { maxUsd: 2, maxTokens: 80, maxWallClockMs: 101 },
    { maxUsd: 2, maxTokens: 80 },
    { maxUsd: 0, maxTokens: 80, maxWallClockMs: 75 },
    { maxUsd: NaN, maxTokens: 80, maxWallClockMs: 75 },
    { maxUsd: 2, maxTokens: 1.5, maxWallClockMs: 75 },
    { maxUsd: 2, maxTokens: 80, maxWallClockMs: 75, unrelated: 1 },
  ])('refuses invalid or widened remaining caps %j without consuming a slot', async budget => {
    const f = await sessionFixture();
    try {
      expect(() => f.hosted.issueSessionBudget(budget)).toThrow(/missing, invalid or wider/);
      expect(f.hosted.issueSessionBudget(f.budget).index).toBe(0);
    } finally { await f.hosted.stop(); }
  });

  it('refuses overlap, honors the preregistered session limit and revokes on host shutdown', async () => {
    const f = await sessionFixture();
    try {
      for (let i = 0; i < 4; i++) {
        const receipt = f.hosted.issueSessionBudget(f.budget);
        expect(receipt.index).toBe(i);
        expect(() => f.hosted.issueSessionBudget(f.budget)).toThrow(/overlapping or exhausted/);
        await f.ports(receipt).releaseGateway!();
      }
      expect(() => f.hosted.issueSessionBudget(f.budget)).toThrow(/exhausted/);
    } finally { await f.hosted.stop(); }
    expect(() => f.hosted.issueSessionBudget(f.budget)).toThrow(/unavailable/);
  });

  it('rejects retirement during asynchronous admission and before native process creation', async () => {
    const f = await sessionFixture();
    try {
      const receipt = f.hosted.issueSessionBudget(f.budget), ports = f.ports(receipt);
      let finish!: () => void;
      f.admit.mockImplementation(async () => { await new Promise<void>(resolve => { finish = resolve; });
        return { admitted: true, receiptRef: 'late-admission' }; });
      const pending = ports.admit(handle, receipt.budget, 't1');
      expect(() => beginCurrentBenchNativeSession(f.observation(receipt), f.opts, handle)).toThrow(/not admitted/);
      await ports.releaseGateway!(); finish();
      await expect(pending).rejects.toThrow(/active host-issued/);
      const next = f.hosted.issueSessionBudget(f.budget), nextPorts = f.ports(next);
      f.admit.mockResolvedValue({ admitted: true, receiptRef: 'next-admission' });
      await nextPorts.admit(handle, next.budget, 't1');
      const spawn = beginCurrentBenchNativeSession(f.observation(next), f.opts, handle);
      await nextPorts.releaseGateway!();
      expect(() => spawn()).toThrow(/active host-issued/);
    } finally { await f.hosted.stop(); }
  });

  it('subtracts already charged usage for live caps while retaining cumulative final accounting', async () => {
    const f = await sessionFixture();
    try {
      const before = currentNativeCostFixture(['11111111-1111-4111-8111-111111111111']);
      const receipt = f.hosted.issueSessionBudget({ maxUsd: 0.15, maxTokens: 20, maxWallClockMs: 75 }, before);
      expect(Object.isFrozen(receipt.priorUsage)).toBe(true);
      before.costUsd = 2;
      expect(receipt.priorUsage?.costUsd).toBe(0.2);
      const live = f.ports(receipt), driver = fixture(f.opts);
      const { launch, ...common } = driver.ports;
      common.verifyGenerationBudget = live.verifyGenerationBudget;
      common.admit = live.admit; common.releaseGateway = live.releaseGateway;
      common.verifyPreregistration = async () => ({ preregHash: f.opts.preregistration.preregHash,
        gitCommitSha: 'a'.repeat(40), receiptRef: 'prereg:committed' });
      common.getTask = vi.fn().mockResolvedValueOnce({ ...driver.row, state: 'running', exitCode: null }).mockResolvedValue(driver.row);
      common.sleep = vi.fn(async () => {});
      const launchNative = vi.fn(async () => {
        beginCurrentBenchNativeSession(f.observation(receipt), f.opts, handle)();
        return { agentStarted: true, tasks: [{ taskId: driver.row.taskId }] };
      });
      const result = await currentStockBenchHarnessDriver(driver.lifecycle, { ...common, launchNative }, f.opts)
        .spinRunAndCost({ ...request, blueprintId: 'native-codex', budget: receipt.budget });
      expect(common.sleep).toHaveBeenCalledOnce(); expect(result.telemetry.stopReason).toBe('done');
      expect(result.telemetry.costUsd).toBe(0.25); expect(launch).not.toHaveBeenCalled();
    } finally { await f.hosted.stop(); }
  });

  it('refuses a foreign or incomplete prior usage receipt before issuing an allowance', async () => {
    const f = await sessionFixture();
    try {
      const before = currentNativeCostFixture(['11111111-1111-4111-8111-111111111111']);
      before.armMeta.nativeCostAccounting.attemptAccountingComplete = false;
      expect(() => f.hosted.issueSessionBudget(f.budget, before)).toThrow(/incomplete/);
      before.armMeta.nativeCostAccounting.attemptAccountingComplete = true;
      before.armMeta.nativeCostAccounting.preregHash = 'b'.repeat(64);
      expect(() => f.hosted.issueSessionBudget(f.budget, before)).toThrow(/frozen protocol/);
      expect(f.hosted.issueSessionBudget(f.budget).index).toBe(0);
    } finally { await f.hosted.stop(); }
  });

  it('uses the stock driver with the original protocol pins and a separately admitted reduced budget', async () => {
    const f = await sessionFixture();
    try {
      const receipt = f.hosted.issueSessionBudget(f.budget), live = f.ports(receipt), driver = fixture(f.opts);
      const { launch, ...common } = driver.ports;
      common.verifyGenerationBudget = live.verifyGenerationBudget;
      common.admit = live.admit; common.releaseGateway = live.releaseGateway;
      common.verifyPreregistration = async () => ({ preregHash: f.opts.preregistration.preregHash,
        gitCommitSha: 'a'.repeat(40), receiptRef: 'prereg:committed' });
      const launchNative = vi.fn(async () => {
        beginCurrentBenchNativeSession(f.observation(receipt), f.opts, handle)();
        return { agentStarted: true, tasks: [{ taskId: driver.row.taskId }] };
      });
      const result = await currentStockBenchHarnessDriver(driver.lifecycle, { ...common, launchNative }, f.opts)
        .spinRunAndCost({ ...request, blueprintId: 'native-codex', budget: receipt.budget });
      expect(result.telemetry.stopReason).toBe('done'); expect(launchNative).toHaveBeenCalledOnce();
      expect(launch).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
      expect(result.telemetry.armMeta?.currentExecution).toMatchObject({ sessionBudget: receipt });
    } finally { await f.hosted.stop(); }
  });
});
