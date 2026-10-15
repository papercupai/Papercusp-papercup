import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { compileJsonSchema } from '../json-schema-validation';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { GatewayRequestTelemetry } from '../inference-gateway/request-stage-telemetry';
import type { RpcFrame, SuStdioReceipt } from '../su-session-stdio-peer';

import {
  DEFAULT_MIN_PROMPT_TOKENS,
  diagnoseCarryUsage,
  evaluateCarryStartup,
  type CarryStartupObservation,
  evaluateCarryTaskPairs,
  evaluateCarryBudgetReservation,
  measureCarryArmTiming,
  inspectCarryNativeTurn,
  inspectCarrySourceRead,
  createCarryTrialRecipe,
  inspectCarryTaskResponse,
  inspectCarryPreparationResponse,
  inspectCarryRequestPopulation,
  inspectCarryNativePopulation,
  type CarryTaskEvaluation,
  extractLaunchUsage,
  extractSampleContext,
  isLaunchCandidate,
  median,
  percentile,
  summarizeByDay,
  summarizeOverall,
  summarizeStartupCacheEvidence,
  utcDay,
  type LaunchSample,
} from './launch-cost-metrics';

describe('carry closed native population', () => {
  function fixture(status: 'completed' | 'failed' | 'interrupted' = 'completed') {
    const receipts: SuStdioReceipt[] = [];
    const push = (phase: SuStdioReceipt['phase'], frame: RpcFrame) => receipts.push({ phase, frame,
      peerId: 'peer', clockId: 'clock', sequence: receipts.length + 1, atMs: receipts.length });
    const rpc = (id: string, method: string, params: RpcFrame, result: RpcFrame) => {
      push('write-started', { id, method, params }); push('write-completed', { id, method, params });
      push('received', { id, result });
    };
    rpc('open', 'thread/fork', { threadId: 'predecessor' }, { thread: { id: 'thread', path: '/native/rollout',
      turns: [{ id: 'inherited', status: 'completed' }] } });
    rpc('turn', 'turn/start', { threadId: 'thread' }, { turn: { id: 'new', status: 'inProgress' } });
    push('received', { method: 'turn/started', params: { threadId: 'thread', turn: { id: 'new', status: 'inProgress' } } });
    push('received', { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'new', status } } });
    rpc('read', 'thread/read', { threadId: 'thread', includeTurns: true }, { thread: { id: 'thread', path: '/native/rollout',
      turns: [{ id: 'inherited', status: 'completed' }, { id: 'new', status }] } });
    return { receipts, state: { peerId: 'peer', clockId: 'clock', emitted: receipts.length,
      enabled: true, sinkFailed: false, exited: true, pendingWrites: 0 }, arms: [{ armId: 'arm', threadId: 'thread' }] };
  }

  it.each(['completed', 'failed', 'interrupted'] as const)('derives %s turns without charging inherited history', status => {
    const input = fixture(status), before = structuredClone(input);
    expect(inspectCarryNativePopulation(input)).toEqual({ status: 'closed-peer-reconciled', missing: [], violations: [],
      turns: [{ armId: 'arm', threadId: 'thread', turnId: 'new', status }],
      threads: [{ threadId: 'thread', sourcePath: '/native/rollout', inheritedTurnIds: ['inherited'] }], accountingComplete: false });
    expect(input).toEqual(before);
  });

  it.each(['prefix', 'middle', 'tail', 'count', 'open', 'sink', 'disabled', 'write', 'state'] as const)(
    'rejects an incomplete local capture (%s)', kind => {
      const input: Parameters<typeof inspectCarryNativePopulation>[0] = fixture();
      if (kind === 'prefix') input.receipts = input.receipts.slice(1);
      if (kind === 'middle') input.receipts = input.receipts.filter((_, i) => i !== 4);
      if (kind === 'tail') input.receipts = input.receipts.slice(0, -1);
      if (kind === 'count') input.state!.emitted++;
      if (kind === 'open') input.state!.exited = false;
      if (kind === 'sink') input.state!.sinkFailed = true;
      if (kind === 'disabled') input.state!.enabled = false;
      if (kind === 'write') input.state!.pendingWrites++;
      if (kind === 'state') input.state = undefined;
      expect(inspectCarryNativePopulation(input).status).not.toBe('closed-peer-reconciled');
    });

  it.each(['peer', 'clock', 'time', 'sequence', 'unassigned', 'extra-persisted', 'missing-persisted',
    'status', 'source', 'summary', 'unknown-rpc', 'duplicate-reply', 'foreign-event'] as const)(
    'rejects conflicting population evidence (%s)', kind => {
      const input = fixture(), final = (input.receipts.at(-1)!.frame.result as RpcFrame).thread as RpcFrame;
      if (kind === 'peer') input.receipts[2].peerId = 'another-peer';
      if (kind === 'clock') input.receipts[2].clockId = 'another-clock';
      if (kind === 'time') input.receipts[2].atMs = -1;
      if (kind === 'sequence') input.receipts[2].sequence++;
      if (kind === 'unassigned') input.arms = [];
      if (kind === 'extra-persisted') (final.turns as RpcFrame[]).push({ id: 'unobserved', status: 'completed' });
      if (kind === 'missing-persisted') (final.turns as RpcFrame[]).pop();
      if (kind === 'status') (final.turns as RpcFrame[])[1].status = 'failed';
      if (kind === 'source') final.path = '/another/rollout';
      if (kind === 'summary') delete final.turns;
      if (kind === 'unknown-rpc') { input.receipts[3].frame.method = 'thread/compact/start'; input.receipts[4].frame.method = 'thread/compact/start'; }
      if (kind === 'duplicate-reply') input.receipts[5].frame.id = 'open';
      if (kind === 'foreign-event') (input.receipts[6].frame.params as RpcFrame).threadId = 'foreign';
      expect(inspectCarryNativePopulation(input).status).not.toBe('closed-peer-reconciled');
    });

  it('keeps rejection and unknown delivery incomplete without inventing a completed turn', () => {
    const input = fixture(); input.receipts[5].frame = { id: 'turn', error: { message: 'rejected' } };
    expect(inspectCarryNativePopulation(input)).toMatchObject({ status: 'invalid', turns: [], accountingComplete: false });
  });
});

describe('carry controller request population', () => {
  function fixture(): Parameters<typeof inspectCarryRequestPopulation>[0] {
    const telemetry = new GatewayRequestTelemetry();
    const span = telemetry.begin({ ownerId: 'su-fixture', provider: 'codex', protocol: 'openai-responses', transport: 'bearer-http' });
    span.recordAttempt(); span.finish('ok', 200);
    const gateway = telemetry.snapshot(), row = gateway.recent[0];
    row.nativeCorrelation = { status: 'observed', sessionId: 'thread', threadId: 'thread', turnId: 'turn', windowId: null };
    row.upstreamWrites.calls = [{ ordinal: 1, accountId: 'routing-label', clockId: 'fixture', clock: 'performance.now',
      outcome: 'returned', responseStatus: 200, matchedRequests: 1, unexpectedRequests: 0,
      droppedRequests: 0, droppedEvents: 0, events: [{ phase: 'created', requestOrdinal: 1, atMs: 1 }] }];
    return { ownerId: 'su-fixture', turns: [{ armId: 'arm', threadId: 'thread', turnId: 'turn', status: 'completed' }],
      gateway, usage: [{ session_id: 'thread', usage_event_key: 'a'.repeat(64), usage_provenance: { turnId: 'turn' } }] };
  }

  it('links exact observations without promoting them to authenticated charges', () => {
    const input = fixture(), before = structuredClone(input);
    const result = inspectCarryRequestPopulation(input);
    expect(result).toMatchObject({ populationStatus: 'linked', missing: [], violations: [],
      chargeJoin: 'unavailable', accountingComplete: false,
      nativePopulationCoverage: 'not-established', canonicalQueryCoverage: 'not-established',
      turns: [{ gatewayRequestIds: [1], usageEventKeys: ['a'.repeat(64)], upstreamAttempts: [
        { requestId: 1, ordinal: 1, routingAccountId: 'routing-label', responseStatus: 200 } ] }] });
    result.turns[0].gatewayRequestIds.push(99);
    expect(input).toEqual(before);
  });

  it('keeps failure and retry attempts even with fewer or no canonical samples', () => {
    const input = fixture(), row = input.gateway.recent[0];
    row.attempts = 2;
    row.upstreamWrites.calls.push({ ...row.upstreamWrites.calls[0], ordinal: 2 });
    row.upstreamWrites.calls[0].responseStatus = 429;
    expect(inspectCarryRequestPopulation(input).turns[0]).toMatchObject({
      upstreamAttempts: [{ responseStatus: 429 }, { responseStatus: 200 }], usageEventKeys: ['a'.repeat(64)] });
    input.turns[0].status = 'failed'; input.usage = [];
    const result = inspectCarryRequestPopulation(input);
    expect(result).toMatchObject({ populationStatus: 'linked', chargeJoin: 'unavailable', accountingComplete: false,
      turns: [{ status: 'failed', usageEventKeys: [] }] });
    expect(result.turns[0].upstreamAttempts).toHaveLength(2);
    expect(result).not.toHaveProperty('costUsd');
  });

  it.each(['ring', 'active', 'calls', 'requests', 'events', 'missing-events', 'pending', 'unsupported'] as const)(
    'refuses an incomplete observation population (%s)', kind => {
      const input = fixture(), row = input.gateway.recent[0];
      if (kind === 'ring') { input.gateway.requests.started++; input.gateway.requests.finalized++;
        input.gateway.requests.sampled++; input.gateway.outcomes.ok++; }
      if (kind === 'active') { input.gateway.requests.active++; input.gateway.requests.started++; }
      if (kind === 'calls') row.upstreamWrites.droppedCalls++;
      if (kind === 'requests') row.upstreamWrites.calls[0].unexpectedRequests++;
      if (kind === 'events') row.upstreamWrites.calls[0].droppedEvents++;
      if (kind === 'missing-events') row.upstreamWrites.calls[0].events = [];
      if (kind === 'pending') row.upstreamWrites.calls[0].outcome = 'pending';
      if (kind === 'unsupported') row.upstreamWrites.calls = [];
      expect(inspectCarryRequestPopulation(input)).toMatchObject({ populationStatus: 'incomplete', accountingComplete: false });
    });

  it.each(['native', 'request', 'call', 'usage', 'counter'] as const)('rejects ambiguous or inconsistent identities (%s)', kind => {
    const input = fixture(), row = input.gateway.recent[0];
    if (kind === 'native') input.turns = [...input.turns, { ...input.turns[0], armId: 'other-arm' }];
    if (kind === 'request') input.gateway.recent.push(structuredClone(row));
    if (kind === 'call') row.upstreamWrites.calls.push(structuredClone(row.upstreamWrites.calls[0]));
    if (kind === 'usage') input.usage = [...input.usage, input.usage[0]];
    if (kind === 'counter') input.gateway.requests.sampled++;
    expect(inspectCarryRequestPopulation(input)).toMatchObject({ populationStatus: 'invalid', accountingComplete: false });
  });

  it('does not substitute owner, row count or time proximity for exact native keys', () => {
    const input = fixture(); input.gateway.recent[0].nativeCorrelation.turnId = 'nearby-turn';
    input.usage[0].usage_provenance!.turnId = 'nearby-turn';
    const result = inspectCarryRequestPopulation(input);
    expect(result).toMatchObject({ populationStatus: 'incomplete', unmatchedGatewayRequestIds: [1], unmatchedUsageRows: [0],
      turns: [{ gatewayRequestIds: [], usageEventKeys: [] }] });
    const foreign = fixture(); foreign.gateway.recent[0].ownerId = 'other-owner';
    expect(inspectCarryRequestPopulation(foreign).unmatchedGatewayRequestIds).toEqual([1]);
  });

  it('marks missing completed-turn usage incomplete without inventing a zero-cost sample', () => {
    const input = fixture(); input.usage = [];
    expect(inspectCarryRequestPopulation(input)).toMatchObject({ populationStatus: 'incomplete', accountingComplete: false,
      turns: [{ status: 'completed', usageEventKeys: [] }] });
  });

  it('handles several requests in one turn and projects only its public receipt', () => {
    const input = fixture(), row = structuredClone(input.gateway.recent[0]); row.requestId = 2;
    input.gateway.recent.push(row); input.gateway.requests.started++; input.gateway.requests.finalized++;
    input.gateway.requests.sampled++; input.gateway.outcomes.ok++;
    Object.assign(input.turns[0], { rawCredential: 'PRIVATE_TOKEN' });
    expect(inspectCarryRequestPopulation(input)).toMatchObject({ populationStatus: 'linked',
      turns: [{ gatewayRequestIds: [1, 2], usageEventKeys: ['a'.repeat(64)] }] });
    expect(JSON.stringify(inspectCarryRequestPopulation(input))).not.toContain('PRIVATE_TOKEN');
  });
});

describe('carry preparation and idle clock boundaries', () => {
  const receipt = (atMs: number) => ({ atMs, clockId: 'controller-origin', evidenceRef: `fixture:clock:${atMs}` });
  const fixture = (): Parameters<typeof measureCarryArmTiming>[0] => ({
    preparationStarted: receipt(100), predecessorCompleted: receipt(1100), armStarted: receipt(1200),
    firstRequestDispatched: receipt(1300), firstUsefulResponse: receipt(1500),
    preparationAllocation: 'this-arm', allocationEvidenceRef: 'fixture:allocation', idleBand: 'under-60s',
  });

  it('keeps preparation, mandated idle and launch in the assigned elapsed boundary', () => {
    expect(measureCarryArmTiming(fixture())).toEqual({ status: 'measured', missing: [], violations: [], metrics: {
      preparationMs: 1000, beforeArmMs: 100, armLaunchMs: 100, afterDispatchMs: 200,
      observedIdleMs: 200, armElapsedMs: 300, elapsedSincePreparationMs: 1400, allocatedElapsedMs: 1400,
    } });
    const input = fixture(); input.preparationAllocation = 'other-arm';
    expect(measureCarryArmTiming(input).metrics).toMatchObject({ allocatedElapsedMs: 300, elapsedSincePreparationMs: 1400 });
    expect(measureCarryArmTiming(input)).not.toHaveProperty('accepted');
  });

  it.each([
    ['under-60s', 59_999, 'measured'], ['under-60s', 60_000, 'out-of-band'],
    ['6-10min', 359_999, 'out-of-band'], ['6-10min', 360_000, 'measured'],
    ['6-10min', 600_000, 'measured'], ['6-10min', 600_001, 'out-of-band'],
    ['65-75min', 3_899_999, 'out-of-band'], ['65-75min', 3_900_000, 'measured'],
    ['65-75min', 4_500_000, 'measured'], ['65-75min', 4_500_001, 'out-of-band'],
  ] as const)('retains observations at %s idle boundary %s', (idleBand, idle, status) => {
    const input = fixture(); input.idleBand = idleBand;
    input.armStarted = receipt(1100 + idle - 100);
    input.firstRequestDispatched = receipt(1100 + idle);
    input.firstUsefulResponse = receipt(1100 + idle + 200);
    const result = measureCarryArmTiming(input);
    expect(result.status).toBe(status);
    expect(result.metrics).toMatchObject({ observedIdleMs: idle, allocatedElapsedMs: 1000 + idle + 200 });
  });

  it.each(['preparationStarted', 'predecessorCompleted', 'armStarted', 'firstRequestDispatched', 'firstUsefulResponse'] as const)(
    'requires a complete comparable receipt for %s', name => {
      const input = fixture(); input[name].atMs = null;
      expect(measureCarryArmTiming(input)).toMatchObject({ status: 'incomplete', metrics: null });
      input[name] = { ...fixture()[name], evidenceRef: '' };
      expect(measureCarryArmTiming(input)).toMatchObject({ status: 'incomplete', metrics: null });
      input[name] = { ...fixture()[name], clockId: 'another-process-origin' };
      expect(measureCarryArmTiming(input)).toMatchObject({ status: 'invalid', metrics: null });
    });

  it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])('refuses invalid monotonic time %s', atMs => {
    const input = fixture(); input.firstUsefulResponse.atMs = atMs;
    expect(measureCarryArmTiming(input)).toMatchObject({ status: 'invalid', metrics: null });
  });

  it('rejects reversed events instead of clamping elapsed time to zero', () => {
    const input = fixture(); input.armStarted.atMs = 1000;
    expect(measureCarryArmTiming(input)).toMatchObject({ status: 'invalid', metrics: null,
      violations: ['clock-order:predecessorCompleted:armStarted'] });
  });

  it('requires allocation evidence and a known idle band', () => {
    const input = fixture(); input.preparationAllocation = null;
    expect(measureCarryArmTiming(input)).toMatchObject({ status: 'incomplete', metrics: null });
    input.preparationAllocation = 'this-arm'; input.allocationEvidenceRef = '';
    expect(measureCarryArmTiming(input)).toMatchObject({ status: 'incomplete', metrics: null });
    input.allocationEvidenceRef = 'fixture:allocation'; input.idleBand = 'toString' as never;
    expect(measureCarryArmTiming(input)).toMatchObject({ status: 'incomplete', metrics: null });
  });

  it('does not coerce wire values into allocation or idle-band enums', () => {
    const input = fixture(); input.preparationAllocation = ['this-arm'] as never;
    expect(measureCarryArmTiming(input)).toMatchObject({ status: 'incomplete', metrics: null });
    input.preparationAllocation = 'this-arm'; input.idleBand = ['under-60s'] as never;
    expect(measureCarryArmTiming(input)).toMatchObject({ status: 'incomplete', metrics: null });
  });
});

describe('carry conservative request reservation', () => {
  const request = (id = 'next', armId = 'candidate') => ({ id, armId, model: 'gpt-6-sol',
    inputTokenLimit: 100_000, outputTokenLimit: 1000, boundsVerified: true, boundsEvidenceRef: 'fixture:native-bound' });
  const fixture = (): Parameters<typeof evaluateCarryBudgetReservation>[0] => ({ accountingComplete: true, remainingRequestsComplete: true,
    spent: [{ id: 'preparation', armId: 'candidate', inputTokens: 10_000, outputTokens: 100, estimatedListUsd: 0.01 }],
    remaining: [request()],
    limits: { inputTokens: 50_000_000, outputTokens: 1_000_000, estimatedListUsd: 250, chargedRequestsPerArm: 8 } });

  it('reserves worst-case writes and all spent preparation, never claims dispatch authorization', () => {
    const result = evaluateCarryBudgetReservation(fixture());
    expect(result).toEqual({ fitsBudget: true, missing: [], exceeded: [], projected: {
      inputTokens: 110_000, outputTokens: 1100, estimatedListUsd: 0.27, chargedRequestsByArm: { candidate: 2 },
    } });
    expect(result).not.toHaveProperty('authorized');
    expect(result).not.toHaveProperty('accountingComplete');
  });

  it('prices the full request above the long-context threshold, including output multiplier', () => {
    const input = fixture(); input.spent = []; input.remaining[0].inputTokenLimit = 272_001;
    const result = evaluateCarryBudgetReservation(input);
    expect(result.projected?.estimatedListUsd).toBeCloseTo(1.375005, 6);
    input.remaining[0].inputTokenLimit = 272_000;
    expect(evaluateCarryBudgetReservation(input).projected?.estimatedListUsd).toBe(0.69);
  });

  it('reserves Anthropic one-hour writes but does not apply that tier to Codex', () => {
    const input = fixture(); input.spent = []; input.remaining[0].model = 'anthropic/claude-opus-5:high';
    expect(evaluateCarryBudgetReservation(input).projected?.estimatedListUsd).toBe(1.025);
  });

  it.each(['accountingComplete', 'remainingRequestsComplete'] as const)('refuses incomplete %s', field => {
    const input = fixture(); input[field] = false;
    expect(evaluateCarryBudgetReservation(input)).toMatchObject({ fitsBudget: false, projected: null });
  });

  it.each(['id', 'armId', 'boundsEvidenceRef'] as const)('refuses an empty request %s', field => {
    const input = fixture(); input.remaining[0][field] = '';
    expect(evaluateCarryBudgetReservation(input)).toMatchObject({ fitsBudget: false, projected: null });
  });

  it('refuses unverified native limits and unknown model prices', () => {
    const input = fixture(); input.remaining[0].boundsVerified = false;
    expect(evaluateCarryBudgetReservation(input).missing).toContain('unverified-native-bounds:next');
    input.remaining[0].boundsVerified = true; input.remaining[0].model = 'gpt-future-unpriced';
    expect(evaluateCarryBudgetReservation(input)).toMatchObject({ fitsBudget: false, projected: null,
      missing: ['unpriceable-request:next'] });
  });

  it.each([null, NaN, Infinity, -1, 1.5])('refuses malformed/unknown token counts (%s)', value => {
    const input = fixture(); input.remaining[0].outputTokenLimit = value;
    expect(evaluateCarryBudgetReservation(input)).toMatchObject({ fitsBudget: false, projected: null });
    input.remaining = [request()]; input.spent = [{ ...input.spent[0], inputTokens: value }];
    expect(evaluateCarryBudgetReservation(input)).toMatchObject({ fitsBudget: false, projected: null });
  });

  it('does not substitute zero for missing charged cost', () => {
    const input = fixture(); input.spent[0].estimatedListUsd = null;
    expect(evaluateCarryBudgetReservation(input)).toMatchObject({ fitsBudget: false, projected: null });
  });

  it('rejects duplicate identities across spent and reserved requests', () => {
    const input = fixture(); input.remaining[0].id = 'preparation';
    expect(evaluateCarryBudgetReservation(input).missing).toContain('duplicate-request:preparation');
    input.remaining = [request(), request()];
    expect(evaluateCarryBudgetReservation(input).missing).toContain('duplicate-request:next');
  });

  it.each(['inputTokens', 'outputTokens', 'estimatedListUsd'] as const)('enforces %s including the next request', field => {
    const input = fixture(); input.limits[field] = 0;
    expect(evaluateCarryBudgetReservation(input).fitsBudget).toBe(false);
  });

  it('counts spent and reserved requests per arm, including failed attempts retained by the caller', () => {
    const input = fixture(); input.remaining = Array.from({ length: 8 }, (_, i) => request(`slot-${i}`));
    expect(evaluateCarryBudgetReservation(input).exceeded).toContain('request-cap:candidate');
    input.remaining[7].armId = 'control';
    expect(evaluateCarryBudgetReservation(input).fitsBudget).toBe(true);
  });

  it('reserves unstarted required work rather than admitting only an affordable first request', () => {
    const input = fixture(); input.spent = [];
    input.remaining = Array.from({ length: 60 }, (_, i) => ({ ...request(`slot-${i}`, `arm-${i}`), outputTokenLimit: 128_000 }));
    const result = evaluateCarryBudgetReservation(input);
    expect(result.fitsBudget).toBe(false);
    expect(result.exceeded).toContain('output-token-cap');
    expect(result.projected?.outputTokens).toBe(7_680_000);
  });

  it('rounds each tiny expense upward and never rounds a hard budget upward', () => {
    const input = fixture(); input.spent[0].estimatedListUsd = 0.0000001;
    input.limits.estimatedListUsd = 0.2600009;
    expect(evaluateCarryBudgetReservation(input).exceeded).toContain('estimated-list-cost-cap');
  });

  it('fails closed for overflow, malformed limits and an empty remaining population', () => {
    const input = fixture(); input.remaining[0].inputTokenLimit = Number.MAX_SAFE_INTEGER;
    expect(evaluateCarryBudgetReservation(input)).toMatchObject({ fitsBudget: false, projected: null });
    input.remaining = [request()]; input.limits.chargedRequestsPerArm = NaN;
    expect(evaluateCarryBudgetReservation(input)).toMatchObject({ fitsBudget: false, projected: null });
    input.limits.chargedRequestsPerArm = 8; input.remaining = [];
    expect(evaluateCarryBudgetReservation(input).missing).toContain('no-next-request');
  });

  it.each(['accountingComplete', 'remainingRequestsComplete', 'boundsVerified'])('rejects truthy non-boolean %s', field => {
    const input = fixture();
    if (field === 'boundsVerified') input.remaining[0].boundsVerified = 'false' as unknown as boolean;
    else input[field as 'accountingComplete'] = 'false' as unknown as boolean;
    expect(evaluateCarryBudgetReservation(input)).toMatchObject({ fitsBudget: false, projected: null });
  });
});

describe('carry native action evidence (unpaid trial preparation)', () => {
  const allowed = { server: 'papercusp-su', tool: 'capability:read', arguments: { file_path: '/fixture/source', byte_offset: 0 } };
  const fixture = () => {
    const items = [
      { id: 'input', type: 'userMessage', content: [{ type: 'text', text: 'Recover the source.' }] },
      { id: 'read', type: 'mcpToolCall', ...allowed, status: 'completed', result: { content: [] }, error: null },
      { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '{"sourceRef":"fixture:cut"}' },
    ];
    const turn = { id: 'turn', status: 'completed', itemsView: 'full', items };
    const events: Array<Record<string, unknown>> = [
      { method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn', status: 'inProgress' } } },
      ...items.flatMap(item => ['item/started', 'item/completed'].map(method => ({
        method, params: { threadId: 'thread', turnId: 'turn', item },
      }))),
      { method: 'turn/completed', params: { threadId: 'thread', turn } },
    ];
    return { threadId: 'thread', turnId: 'turn', events,
      threadRead: { thread: { id: 'thread', turns: [turn] } }, allowedMcpCalls: [allowed] };
  };
  const edit = (input: ReturnType<typeof fixture>, change: (turn: ReturnType<typeof fixture>['threadRead']['thread']['turns'][number]) => void) => {
    change(input.threadRead.thread.turns[0]);
    return input;
  };

  it('verifies a complete native trace without turning it into a quality or billing pass', () => {
    const result = inspectCarryNativeTurn(fixture());
    expect(result).toEqual({ status: 'verified', violations: [], missing: [],
      finalResponse: '{"sourceRef":"fixture:cut"}', mcpItemIds: ['read'] });
    expect(result).not.toHaveProperty('quality');
    expect(result).not.toHaveProperty('accountingComplete');
  });

  it('binds exact text-only native input across started, completed and persisted witnesses', () => {
    const input = { ...fixture(), expectedInputText: 'Recover the source.' };
    Object.assign(input.threadRead.thread.turns[0].items[0].content![0], { text_elements: [] });
    expect(inspectCarryNativeTurn(input)).toMatchObject({ status: 'verified',
      inputSha256: createHash('sha256').update(input.expectedInputText).digest('hex') });
    expect(inspectCarryNativeTurn(fixture())).not.toHaveProperty('inputSha256');
  });

  it.each(['wrong-text', 'whitespace-drift', 'extra-part', 'image', 'text-element', 'extra-field',
    'duplicate-input', 'missing-input', 'started-only-drift'])('refuses %s native input despite a correct final answer', fault => {
    const input = { ...fixture(), expectedInputText: 'Recover the source.' };
    const items = input.threadRead.thread.turns[0].items, content = items[0].content!;
    if (fault === 'wrong-text') content[0].text = 'Different seed.';
    if (fault === 'whitespace-drift') content[0].text += ' ';
    if (fault === 'extra-part') content.push({ type: 'text', text: 'Extra instructions.' });
    if (fault === 'image') Object.assign(items[0], { content: [{ type: 'image', url: 'fixture' }] });
    if (fault === 'text-element') Object.assign(content[0], { text_elements: [{ placeholder: 'hidden attachment' }] });
    if (fault === 'extra-field') Object.assign(content[0], { extra: 'unbound input' });
    if (fault === 'duplicate-input') items.push({ ...items[0], id: 'input2' });
    if (fault === 'missing-input') items.shift();
    if (fault === 'started-only-drift') input.events[1] = { method: 'item/started', params: { threadId: 'thread', turnId: 'turn',
      item: { id: 'input', type: 'userMessage', content: [{ type: 'text', text: 'Different submitted seed.' }] } } };
    const result = inspectCarryNativeTurn(input);
    expect(result.status).not.toBe('verified');
    expect(result.finalResponse).toBeNull();
    expect(result.inputSha256).toBeNull();
  });

  it.each([{ label: 'empty', value: '' }, { label: 'blank', value: ' ' },
    { label: 'oversized', value: 'x'.repeat(64 * 1024 + 1) }])('refuses $label expected native input', ({ value: expectedInputText }) => {
    expect(inspectCarryNativeTurn({ ...fixture(), expectedInputText }).missing).toContain('invalid-expected-input');
  });

  it('honors the native schema full-items default for older rollouts', () => {
    const input = fixture();
    delete (input.threadRead.thread.turns[0] as { itemsView?: string }).itemsView;
    expect(inspectCarryNativeTurn(input).status).toBe('verified');
  });

  it.each(['summary', 'notLoaded'])('rejects persisted itemsView=%s even when its visible items agree', view => {
    expect(inspectCarryNativeTurn(edit(fixture(), turn => { turn.itemsView = view; })).status).toBe('incomplete');
  });

  it.each(['commandExecution', 'fileChange', 'dynamicToolCall', 'collabAgentToolCall', 'collabToolCall',
    'subAgentActivity', 'webSearch', 'imageView', 'imageGeneration', 'sleep'])('catches forbidden %s even without a UI tool card', type => {
    const input = fixture();
    input.threadRead.thread.turns[0].items.push({ id: 'forbidden', type } as never);
    expect(inspectCarryNativeTurn(input)).toMatchObject({ status: 'violation', violations: [`forbidden-item:${type}:forbidden`] });
  });

  it('does not let a final snapshot hide a forbidden started action', () => {
    const input = fixture();
    input.events.splice(1, 0, { method: 'item/started', params: { threadId: 'thread', turnId: 'turn',
      item: { id: 'hidden', type: 'fileChange', changes: [] } } });
    expect(inspectCarryNativeTurn(input).status).toBe('violation');
  });

  it('catches an action seen only in the terminal event, despite a truncated persisted witness', () => {
    const input = fixture();
    const turn = input.threadRead.thread.turns[0];
    input.events[input.events.length - 1] = { method: 'turn/completed', params: { threadId: 'thread',
      turn: { ...turn, items: [...turn.items, { id: 'hidden', type: 'commandExecution' }] } } };
    expect(inspectCarryNativeTurn(input).status).toBe('violation');
  });

  it('uses full persisted history and item receipts when the terminal notification intentionally omits items', () => {
    const input = fixture();
    input.events[input.events.length - 1] = { method: 'turn/completed', params: { threadId: 'thread',
      turn: { id: 'turn', status: 'completed', itemsView: 'notLoaded', items: [] } } };
    expect(inspectCarryNativeTurn(input).status).toBe('verified');
    input.events.splice(2, 1);
    expect(inspectCarryNativeTurn(input).status).toBe('incomplete');
  });

  it('checks native terminal summaries as a subset without confusing them with full persisted history', () => {
    const input = fixture();
    const turn = input.threadRead.thread.turns[0];
    input.events[input.events.length - 1] = { method: 'turn/completed', params: { threadId: 'thread',
      turn: { ...turn, itemsView: 'summary', items: [turn.items[2]] } } };
    expect(inspectCarryNativeTurn(input).status).toBe('verified');
    input.events.splice(2, 1);
    expect(inspectCarryNativeTurn(input).status).toBe('incomplete');
  });

  it('accepts one terminal unphased message but never ambiguous legacy messages or explicit commentary', () => {
    const input = fixture();
    delete (input.threadRead.thread.turns[0].items[2] as { phase?: string }).phase;
    expect(inspectCarryNativeTurn(input).status).toBe('verified');
    input.threadRead.thread.turns[0].items.push({ id: 'other', type: 'agentMessage', text: 'ambiguous' } as never);
    expect(inspectCarryNativeTurn(input).status).toBe('incomplete');
  });

  it.each(['server', 'tool', 'arguments'] as const)('checks the exact allowed MCP %s, not its read-only hint', field => {
    const input = fixture();
    const item = input.threadRead.thread.turns[0].items[1] as Record<string, unknown>;
    item[field] = field === 'arguments' ? { ...allowed.arguments, file_path: '/another/source' } : 'unapproved';
    item.readOnlyHint = true;
    expect(inspectCarryNativeTurn(input).status).toBe('violation');
  });

  it('ignores object key order but rejects additional MCP arguments', () => {
    const input = fixture();
    const item = input.threadRead.thread.turns[0].items[1] as Record<string, unknown>;
    item.arguments = { byte_offset: 0, file_path: '/fixture/source' };
    expect(inspectCarryNativeTurn(input).status).toBe('verified');
    item.arguments = { ...allowed.arguments, follow_symlinks: true };
    expect(inspectCarryNativeTurn(input).status).toBe('violation');
  });

  it.each(['missing-start', 'missing-terminal', 'missing-item', 'duplicate-terminal', 'wrong-thread', 'wrong-turn',
    'changed-item', 'unknown-item', 'failed-tool', 'failed-turn', 'no-final', 'duplicate-id'])('fails closed for %s', fault => {
    const input = fixture();
    if (fault === 'missing-start') input.events.shift();
    if (fault === 'missing-terminal') input.events.pop();
    if (fault === 'missing-item') input.events.splice(2, 1);
    if (fault === 'duplicate-terminal') input.events.push(input.events.at(-1)!);
    if (fault === 'wrong-thread') input.threadRead.thread.id = 'other-thread';
    if (fault === 'wrong-turn') input.turnId = 'other-turn';
    if (fault === 'changed-item') input.events[4] = { method: 'item/completed', params: {
      threadId: 'thread', turnId: 'turn', item: { ...input.threadRead.thread.turns[0].items[1], result: { content: ['different'] } },
    } };
    if (fault === 'unknown-item') input.threadRead.thread.turns[0].items.push({ id: 'new', type: 'futureNativeAction' } as never);
    if (fault === 'failed-tool') (input.threadRead.thread.turns[0].items[1] as Record<string, unknown>).status = 'failed';
    if (fault === 'failed-turn') input.threadRead.thread.turns[0].status = 'failed';
    if (fault === 'no-final') input.threadRead.thread.turns[0].items[2].phase = 'commentary';
    if (fault === 'duplicate-id') input.threadRead.thread.turns[0].items.push(input.threadRead.thread.turns[0].items[0]);
    expect(inspectCarryNativeTurn(input).status).toBe('incomplete');
  });

  it('rejects native approval/dynamic-tool requests rather than silently treating them as notifications', () => {
    const input = fixture();
    input.events.splice(1, 0, { id: 'request', method: 'item/tool/call', params: { threadId: 'thread', turnId: 'turn' } });
    expect(inspectCarryNativeTurn(input).status).toBe('violation');
  });
});

describe('carry frozen source-window receipts (T2)', () => {
  const fixture = (eof = true) => {
    const bytes = Buffer.from('exact source sentinel: cèdre 🌲');
    const source = { sourceRef: 'native:predecessor/cut', server: 'papercusp-su', tool: 'capability_read',
      filePath: '/fixture/frozen.jsonl', byteOffset: 100, byteLength: bytes.length,
      totalBytes: 100 + bytes.length + (eof ? 0 : 50), sha256: createHash('sha256').update(bytes).digest('hex') };
    const args = { file_path: source.filePath, byte_offset: source.byteOffset, byte_limit: bytes.length };
    const page = { ok: true, file_path: source.filePath, encoding: 'base64', byte_offset: source.byteOffset,
      byte_length: bytes.length, total_bytes: source.totalBytes, data: bytes.toString('base64'), eof,
      next_cursor: eof ? null : { tool: 'capability:read', args: { ...args, byte_offset: 100 + bytes.length } } };
    const read = { id: 'read', type: 'mcpToolCall', server: source.server, tool: source.tool, arguments: args,
      status: 'completed', error: null, result: { isError: false, content: [{ type: 'text', text: JSON.stringify(page) }] } };
    const items = [read, { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '{"sourceSentinel":"wrong"}' }];
    const turn = { id: 'turn', status: 'completed', itemsView: 'full', items };
    const input = { threadId: 'thread', turnId: 'turn', allowedMcpCalls: [{ server: source.server, tool: source.tool, arguments: args }],
      threadRead: { thread: { id: 'thread', turns: [turn] } }, events: [
        { method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn', status: 'inProgress' } } },
        ...items.flatMap(item => ['item/started', 'item/completed'].map(method => ({ method, params: { threadId: 'thread', turnId: 'turn', item } }))),
        { method: 'turn/completed', params: { threadId: 'thread', turn } },
      ] };
    return { source, input, page, read };
  };

  it.each([true, false])('verifies exact UTF-8 bytes at a nonzero offset (EOF %s), independently of response quality', eof => {
    const { source, input } = fixture(eof);
    expect(inspectCarrySourceRead(input, source)).toEqual({ status: 'verified', missing: [], violations: [],
      sourceRef: source.sourceRef, itemId: 'read' });
    expect(inspectCarrySourceRead(input, source)).not.toHaveProperty('quality');
  });

  it.each(['valid', 'wrong-target', 'missing-args', 'wrong-path', 'extra-args', 'unapproved-wrapper', 'bad-bytes'])(
    'checks attributed dispatcher source reads: %s', fault => {
    const { source, input, read, page } = fixture();
    source.tool = 'tools:invoke'; read.tool = source.tool;
    const args: Record<string, unknown> = { name: 'capability:read', args: { ...read.arguments } };
    read.arguments = args as typeof read.arguments;
    input.allowedMcpCalls = [{ server: source.server, tool: source.tool,
      arguments: structuredClone(args) as typeof read.arguments }];
    if (fault === 'wrong-target') {
      args.name = 'capability:write';
      input.allowedMcpCalls[0].arguments = structuredClone(args) as typeof read.arguments;
    }
    if (fault === 'missing-args') delete args.args;
    if (fault === 'wrong-path') (args.args as Record<string, unknown>).file_path = '/different';
    if (fault === 'extra-args') args.unexpected = true;
    if (fault === 'unapproved-wrapper') input.allowedMcpCalls = [];
    if (fault === 'bad-bytes') {
      page.data = Buffer.alloc(source.byteLength, 65).toString('base64');
      read.result.content[0].text = JSON.stringify(page);
    }
    expect(inspectCarrySourceRead(input, source).status === 'verified').toBe(fault === 'valid');
  });

  it.each(['wrong-path', 'wrong-offset', 'wrong-total', 'changed-bytes', 'truncated', 'base64-garbage', 'base64-whitespace',
    'wrong-length', 'false-ok', 'wrong-encoding', 'missing-data', 'wrong-eof', 'wrong-cursor', 'missing-page', 'duplicate-page',
    'tool-error', 'tool-failure', 'unapproved', 'missing-native-event', 'wrong-thread', 'no-read', 'duplicate-read',
    'invalid-hash', 'invalid-window'])('does not accept %s as source-read proof', fault => {
    const { source, input, read, page } = fixture();
    if (fault === 'wrong-path') page.file_path += '.different';
    if (fault === 'wrong-offset') page.byte_offset++;
    if (fault === 'wrong-total') page.total_bytes++;
    if (fault === 'changed-bytes') page.data = Buffer.alloc(source.byteLength, 65).toString('base64');
    if (fault === 'truncated') page.data = page.data.slice(0, -4);
    if (fault === 'base64-garbage') page.data += '!';
    if (fault === 'base64-whitespace') page.data += '\n';
    if (fault === 'wrong-length') page.byte_length++;
    if (fault === 'false-ok') page.ok = false;
    if (fault === 'wrong-encoding') page.encoding = 'utf8';
    if (fault === 'missing-data') delete (page as Partial<typeof page>).data;
    if (fault === 'wrong-eof') page.eof = false;
    if (fault === 'wrong-cursor') page.next_cursor = { tool: 'capability:read', args: { ...read.arguments, byte_offset: 0 } };
    read.result.content[0].text = JSON.stringify(page);
    if (fault === 'missing-page') read.result.content = [{ type: 'text', text: 'See also: capability:read' }];
    if (fault === 'duplicate-page') read.result.content.push(read.result.content[0]);
    if (fault === 'tool-error') read.result.isError = true;
    if (fault === 'tool-failure') read.status = 'failed';
    if (fault === 'unapproved') input.allowedMcpCalls = [];
    if (fault === 'missing-native-event') input.events.splice(1, 1);
    if (fault === 'wrong-thread') input.threadId = 'different';
    if (fault === 'no-read') read.arguments = { ...read.arguments, file_path: '/another' };
    if (fault === 'duplicate-read') input.threadRead.thread.turns[0].items.push(read);
    if (fault === 'invalid-hash') source.sha256 = 'unknown';
    if (fault === 'invalid-window') source.byteOffset = Number.MAX_SAFE_INTEGER;
    expect(inspectCarrySourceRead(input, source).status).not.toBe('verified');
  });

  it('rejects an inconsistent continuation cursor before EOF', () => {
    const { source, input, read, page } = fixture(false);
    page.next_cursor!.args.byte_offset--;
    read.result.content[0].text = JSON.stringify(page);
    expect(inspectCarrySourceRead(input, source).missing).toContain('source-window-cursor-mismatch');
  });
});

describe('frozen carry task recipe (D017 proposals 1143163/1143234)', () => {
  it('freezes the exact preparation prompt, seed acknowledgement and historical large-cut proposal', () => {
    const recipe = createCarryTrialRecipe(), preparation = recipe.sourcePreparation;
    expect(preparation.status).toBe('proposal-only');
    expect(preparation.prompt).toContain(`Seed JSON:\n${recipe.seedText}\n\nAcknowledgement JSON:`);
    expect(preparation.prompt).toContain('Do not use tools');
    expect(preparation.promptSha256).toBe(createHash('sha256').update(preparation.prompt).digest('hex'));
    expect(preparation.expectedAcknowledgement).toEqual({ seedSha256: recipe.seedSha256, sourceSentinel: 'cedar-48f6e9a2' });
    expect(preparation.largeInput).toEqual({ kind: 'proposed-existing-native-cut',
      threadId: '01a0cf6d-3062-7782-b6c3-c9c43179b7cc', turnId: '01a0cf6d-a2ba-7b43-b095-f73f45732d30',
      prefixEndBytes: 600697, prefixSha256: '7239216af4e2f05d8ef07269bb49dffdfc215732750b8ae134d3911be28f631a' });
    expect(preparation.requiredWitnesses).toContain('canonical-preparation-charge');
    preparation.expectedAcknowledgement.sourceSentinel = 'mutated';
    expect(createCarryTrialRecipe().sourcePreparation.expectedAcknowledgement.sourceSentinel).toBe('cedar-48f6e9a2');
  });

  it('checks acknowledgement JSON without claiming source qualification', () => {
    const recipe = createCarryTrialRecipe();
    const response = JSON.stringify({ sourceSentinel: 'cedar-48f6e9a2', seedSha256: recipe.seedSha256 });
    const proof = inspectCarryPreparationResponse(response);
    expect(proof).toMatchObject({ evidenceKind: 'response-only', phase: 'source-preparation', matches: true,
      missing: [], violations: [], recipeSha256: recipe.sha256 });
    expect(proof.oracleSha256).toBe(createHash('sha256').update(canonicalJson({
      recipeSha256: recipe.sha256, phase: 'source-preparation', expected: recipe.sourcePreparation.expectedAcknowledgement,
    })).digest('hex'));
    expect(proof).not.toHaveProperty('qualified');
    expect(proof).not.toHaveProperty('quality');
  });

  it.each(['missing', 'extra', 'wrong-hash', 'wrong-sentinel', 'non-object', 'invalid-json'])(
    'rejects %s seed acknowledgement', fault => {
      const expected: Record<string, unknown> = { ...createCarryTrialRecipe().sourcePreparation.expectedAcknowledgement };
      if (fault === 'missing') delete expected.seedSha256;
      if (fault === 'extra') expected.extra = true;
      if (fault === 'wrong-hash') expected.seedSha256 = '0'.repeat(64);
      if (fault === 'wrong-sentinel') expected.sourceSentinel = 'UNKNOWN';
      const response = fault === 'invalid-json' ? '{' : JSON.stringify(fault === 'non-object' ? [expected] : expected);
      expect(inspectCarryPreparationResponse(response).matches).toBe(false);
    });

  it('keeps oversized acknowledgement evidence unknown', () => {
    expect(inspectCarryPreparationResponse('x'.repeat(64 * 1024 + 1))).toMatchObject({ matches: null,
      missing: ['missing-or-oversized-response'] });
  });

  it('enumerates exactly the named blocks/tasks with alternating pair order and one whole preparation allocation per block', () => {
    const recipe = createCarryTrialRecipe();
    const expected = ['S-I0', 'S-I1', 'S-I2', 'L-I0', 'L-I1', 'L-I2'];
    expect(recipe.sources.map(s => s.id)).toEqual(expected);
    expect(recipe.sources.map(s => s.chargeToArmId)).toEqual(expected.map(block => `${block}-T1:candidate`));
    expect(recipe.pairs.map(p => p.id)).toEqual(expected.flatMap(block => ['T1', 'T2', 'T3', 'T4', 'T5'].map(task => `${block}-${task}`)));
    expect(new Set(recipe.pairs.flatMap(p => p.arms.map(a => a.id))).size).toBe(60);
    for (const [id, order] of [
      ['S-I0-T1', ['control', 'candidate']], ['S-I0-T2', ['candidate', 'control']],
      ['S-I1-T1', ['candidate', 'control']], ['L-I0-T1', ['candidate', 'control']], ['L-I2-T5', ['candidate', 'control']],
    ] as const) expect(recipe.pairs.find(p => p.id === id)!.arms.map(a => a.arm)).toEqual(order);
    expect(recipe.sources.every(s => recipe.pairs.flatMap(p => p.arms).filter(a => a.id === s.chargeToArmId).length === 1)).toBe(true);
    expect(recipe.sources[0].history).toEqual({ id: 'S', minInputTokens: 20000, maxInputTokens: 80000 });
    expect(recipe.sources[3].history).toEqual({ id: 'L', minInputTokens: 600000, maxInputTokens: 750000 });
    expect(recipe.sources.slice(0, 3).map(s => s.idle)).toEqual([
      { id: 'I0', minMs: 0, maxMs: 60000, maxInclusive: false },
      { id: 'I1', minMs: 360000, maxMs: 600000, maxInclusive: true },
      { id: 'I2', minMs: 3900000, maxMs: 4500000, maxInclusive: true },
    ]);
  });

  it('binds exact seed bytes and every proposed task/ordering/limit field without claiming admission or native bounds', () => {
    const { sha256, ...body } = createCarryTrialRecipe();
    expect(sha256).toBe(createHash('sha256').update(canonicalJson(body)).digest('hex'));
    expect(body.seedSha256).toBe(createHash('sha256').update(body.seedText).digest('hex'));
    expect(body.status).toBe('proposal-only');
    expect(body.outputTokenLimit).toBeNull();
    expect(body.firstTwoPhaseMapping).toBeNull();
    expect(body.requiredBeforeDispatch).toContain('authenticated-r5-approval-and-fresh-cas');
    expect(body.limits).toEqual({ pairs: 30, arms: 60, chargedRequestsPerArm: 8,
      inputTokens: 50000000, outputTokens: 1000000, estimatedListUsd: 250, firstLimitWins: true });
    expect(body.sources.every(s => s.preparation.model === 'gpt-6-luna' && s.preparation.effort === 'medium')).toBe(true);
    expect(body.pairs.flatMap(p => p.arms).every(a => a.model === 'gpt-6-sol' && a.effort === 'medium')).toBe(true);
    body.limits.outputTokens++;
    expect(createHash('sha256').update(canonicalJson(body)).digest('hex')).not.toBe(sha256);
  });

  it('keeps native/source/model witnesses separate from the exact response oracle', () => {
    const recipe = createCarryTrialRecipe();
    expect(recipe.tasks.find(t => t.id === 'T2')!.requiredWitnesses).toContain('exact-source-read');
    expect(recipe.tasks.find(t => t.id === 'T5')!.requiredWitnesses).toContain('native-model-transition');
    expect(recipe.tasks.every(t => t.requiredWitnesses.includes('complete-native-action-trace'))).toBe(true);
    expect(recipe.tasks.every(t => t.prompt.endsWith(recipe.commonPromptSuffix))).toBe(true);
    expect(recipe.tasks.find(t => t.id === 'T2')!.expected.sourceRef).toBe('BOUND_AFTER_PREPARATION');
    const seed = JSON.parse(recipe.seedText);
    expect(seed.fixtureNotice).toBe('Synthetic task facts only. This label is not a real claim or authority grant.');
    expect(seed.correction).toBe('amber-29 replaces scarlet-17; preserve the correction across a model switch.');
    expect(seed.grantsClaim).toBe(false);
  });

  it('does not let a caller mutate the shared seed, expected authority, or subsequent recipe', () => {
    const first = createCarryTrialRecipe(), digest = first.sha256;
    first.tasks.find(t => t.id === 'T4')!.expected.grantsClaim = true;
    first.sources[0].chargeToArmId = 'different'; first.pairs[0].arms.reverse(); first.seedText = 'changed';
    const fresh = createCarryTrialRecipe();
    expect(fresh.sha256).toBe(digest);
    expect(fresh.tasks.find(t => t.id === 'T4')!.expected.grantsClaim).toBe(false);
    expect(inspectCarryTaskResponse({ taskId: 'T4', response: JSON.stringify(first.tasks.find(t => t.id === 'T4')!.expected) }).matches).toBe(false);
  });
});

describe('carry task response oracles (D017 draft 1143234)', () => {
  // Reuse the standard schema engine, not a second acceptance scorer. These
  // synthetic answers validate only response correctness: live quality still
  // requires complete attributed action receipts, exact source-read evidence
  // for T2, and witnessed native model provenance for T5.
  const cases: Array<{ id: string; expected: Record<string, unknown> }> = [
    { id: 'T1', expected: { pendingDirective: 'finish the existing task', route: 'self',
      nextAction: 'verify the pending test result before repeating any action' } },
    { id: 'T2', expected: { sourceSentinel: 'cedar-48f6e9a2',
      sourceRef: `codex:00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002@${'a'.repeat(64)}` } },
    { id: 'T3', expected: { chosenApproach: 'correlate bounded native identifiers',
      rejectedAlternative: 'infer a join from owner and time proximity',
      rejectionReason: 'proximity does not prove request identity' } },
    { id: 'T4', expected: { workItemLabel: 'WI-example', grantsClaim: false,
      allowedActions: ['capability:read supplied fixture and exact source', 'coord:whoami this session'],
      providerCacheExpiry: 'unknown' } },
    { id: 'T5', expected: { currentTarget: 'amber-29', supersededTarget: 'scarlet-17' } },
  ];

  it.each(cases)('$id production checker matches the independent proposed facts, without calling them live quality', ({ id, expected }) => {
    const result = inspectCarryTaskResponse({ taskId: id, response: JSON.stringify(Object.fromEntries(Object.entries(expected).reverse())),
      boundSourceRef: id === 'T2' ? String(expected.sourceRef) : undefined });
    expect(result).toMatchObject({ evidenceKind: 'response-only', taskId: id, matches: true, missing: [], violations: [] });
    expect(result.recipeSha256).toBe(createCarryTrialRecipe().sha256);
    expect(result.oracleSha256).toBe(createHash('sha256').update(canonicalJson({
      recipeSha256: result.recipeSha256, taskId: id, expected,
    })).digest('hex'));
    expect(result).not.toHaveProperty('quality');
    expect(result).not.toHaveProperty('accepted');
  });

  it.each(cases)('$id production checker rejects missing, extra, contradictory and unknown facts', ({ id, expected }) => {
    const check = (answer: unknown) => inspectCarryTaskResponse({ taskId: id, response: JSON.stringify(answer),
      boundSourceRef: id === 'T2' ? String(expected.sourceRef) : undefined });
    for (const key of Object.keys(expected)) {
      const missing = { ...expected }; delete missing[key];
      expect(check(missing).matches).toBe(false);
      expect(check({ ...expected, [key]: 'UNKNOWN' }).matches).toBe(false);
      expect(check({ ...expected, [key]: null }).matches).toBe(false);
    }
    expect(check({ ...expected, selfRatedQuality: 'pass' }).matches).toBe(false);
    expect(check(JSON.stringify(expected)).matches).toBe(false);
    expect(check([expected]).matches).toBe(false);
  });

  it('refuses missing or placeholder source binding even when an answer repeats the placeholder', () => {
    const response = JSON.stringify(createCarryTrialRecipe().tasks.find(t => t.id === 'T2')!.expected);
    for (const boundSourceRef of [undefined, null, '', 'BOUND_AFTER_PREPARATION', 'UNKNOWN', 'nearby-session']) {
      expect(inspectCarryTaskResponse({ taskId: 'T2', response, boundSourceRef })).toMatchObject({
        matches: null, missing: ['unbound-native-source-cut'], violations: [],
      });
    }
    const expected = cases.find(t => t.id === 'T2')!.expected;
    const correct = inspectCarryTaskResponse({ taskId: 'T2', response: JSON.stringify(expected), boundSourceRef: String(expected.sourceRef) });
    const otherCut = inspectCarryTaskResponse({ taskId: 'T2', response: JSON.stringify(expected),
      boundSourceRef: String(expected.sourceRef).replace(/a$/, 'b') });
    expect(otherCut.matches).toBe(false);
    expect(otherCut.oracleSha256).not.toBe(correct.oracleSha256);
    expect(otherCut.recipeSha256).toBe(correct.recipeSha256);
  });

  it('does not silently strip prose/fences, truncate an answer, or select an unknown task', () => {
    expect(inspectCarryTaskResponse({ taskId: 'T1', response: '```json\n{}\n```' }))
      .toMatchObject({ matches: false, violations: ['invalid-json-response'] });
    expect(inspectCarryTaskResponse({ taskId: 'T1', response: '{} trailing prose' }).matches).toBe(false);
    expect(inspectCarryTaskResponse({ taskId: 'T1', response: 'x'.repeat(65537) }))
      .toMatchObject({ matches: null, missing: ['missing-or-oversized-response'] });
    expect(inspectCarryTaskResponse({ taskId: 'T0', response: '{}' }))
      .toMatchObject({ matches: null, missing: ['unknown-task'] });
  });

  it.each(cases)('$id accepts the exact response regardless of object key order', ({ expected }) => {
    const validate = compileJsonSchema({ type: 'object', const: expected });
    const reordered = Object.fromEntries(Object.entries(expected).reverse());
    expect(validate(JSON.parse(JSON.stringify(reordered)))).toBe(true);
  });

  it.each(cases)('$id rejects missing, invented, unknown and wrong-typed facts', ({ expected }) => {
    const validate = compileJsonSchema({ type: 'object', const: expected });
    for (const key of Object.keys(expected)) {
      const missing = { ...expected }; delete missing[key];
      expect(validate(missing), `missing ${key}`).toBe(false);
      expect(validate({ ...expected, [key]: 'UNKNOWN' }), `unknown ${key}`).toBe(false);
      expect(validate({ ...expected, [key]: null }), `null ${key}`).toBe(false);
    }
    expect(validate({ ...expected, selfRatedQuality: 'pass' })).toBe(false);
    expect(validate(JSON.stringify(expected))).toBe(false);
    expect(validate([expected])).toBe(false);
  });

  it('rejects false authority, a different source cut, and a superseded model-switch fact', () => {
    const validate = (id: string, changes: Record<string, unknown>) => {
      const expected = cases.find(row => row.id === id)!.expected;
      return compileJsonSchema({ type: 'object', const: expected })({ ...expected, ...changes });
    };
    expect(validate('T2', { sourceRef: 'fixture:source/later-cut' })).toBe(false);
    expect(validate('T4', { grantsClaim: true })).toBe(false);
    expect(validate('T4', { allowedActions: ['work_items:claim'] })).toBe(false);
    expect(validate('T4', { providerCacheExpiry: 'warm' })).toBe(false);
    expect(validate('T5', { currentTarget: 'scarlet-17', supersededTarget: 'amber-29' })).toBe(false);
  });
});

describe('carry startup recurrence detectors (P-009)', () => {
  const rows = (): CarryStartupObservation[] => [
    { requestOrdinal: 1, inputTotalTokens: 691102, cacheReadTokens: 0, cacheWriteTokens: null, contextGeneration: 0, predecessorSessionId: 'parent' },
    { requestOrdinal: 2, inputTotalTokens: 690650, cacheReadTokens: 2816, cacheWriteTokens: null, contextGeneration: 0, predecessorSessionId: 'parent' },
    { requestOrdinal: 3, inputTotalTokens: 90205, cacheReadTokens: 7936, cacheWriteTokens: null, contextGeneration: 1, predecessorSessionId: 'parent' },
  ];
  it('detects measured cold inheritance and immediate compaction without inventing write counts or causes', () => {
    expect(evaluateCarryStartup(rows().reverse())).toMatchObject({ state: 'regression',
      signals: ['cold-inherited-startup', 'oversized-startup-immediately-compacted'], unknown: [],
      firstTwoTotalInput: 1381752, firstTwoUncachedInput: null, cacheMissCause: 'undetermined' });
  });
  it('does not alarm on fresh large workloads or cheap short-lived sessions with low reuse', () => {
    expect(evaluateCarryStartup(rows().map(row => ({ ...row, predecessorSessionId: null }))).signals).toEqual([]);
    expect(evaluateCarryStartup(rows().map(row => ({ ...row, inputTotalTokens: 50000 }))).state).toBe('ok');
    expect(evaluateCarryStartup(rows().slice(0, 2).map(row => ({ ...row, inputTotalTokens: 50000 }))))
      .toMatchObject({ state: 'unknown', signals: [], unknown: ['third-request-unavailable'] });
  });
  it('distinguishes a warm inherited prefix from cold reads and late compaction from immediate compaction', () => {
    expect(evaluateCarryStartup(rows().map(row => ({ ...row, cacheReadTokens: row.inputTotalTokens! * 0.99 | 0 }))).signals)
      .toEqual(['oversized-startup-immediately-compacted']);
    expect(evaluateCarryStartup(rows().map(row => ({ ...row, contextGeneration: 0 }))).signals)
      .toEqual(['cold-inherited-startup']);
    expect(evaluateCarryStartup(rows().map(row => ({ ...row, requestOrdinal: row.requestOrdinal === 3 ? 30 : row.requestOrdinal }))).signals)
      .toEqual(['cold-inherited-startup']);
  });
  it('fails closed for partial prefixes, duplicate requests, impossible reads, and inconsistent lineage', () => {
    for (const input of [[], rows().slice(1), [rows()[0], ...rows()],
      rows().map(row => ({ ...row, requestOrdinal: null })),
      rows().map((row, i) => ({ ...row, predecessorSessionId: i === 0 ? 'other' : row.predecessorSessionId }))]) {
      expect(evaluateCarryStartup(input)).toMatchObject({ state: 'unknown', signals: [], firstTwoTotalInput: null });
    }
    expect(evaluateCarryStartup(rows().map(row => ({ ...row, cacheReadTokens: 999999 }))).signals)
      .toEqual(['oversized-startup-immediately-compacted']);
    expect(evaluateCarryStartup(rows().map(row => ({ ...row, contextGeneration: null }))).state).toBe('unknown');
  });
});

describe('matched carry acceptance: cost, quality and latency (R-4/R-8)', () => {
  const recipe = createCarryTrialRecipe();
  const cohort = (): CarryTaskEvaluation[] => recipe.pairs.flatMap((pair, n) => ['control', 'candidate'].map(arm => ({
    taskId: pair.id, sourceId: pair.sourceId, sourceRef: `fixture:${pair.sourceId}`,
    measuredHistoryInputTokens: pair.sourceId.startsWith('L-') ? 650_000 : 50_000,
    historyEvidenceRef: `fixture:history:${pair.sourceId}`,
    observedIdleMs: pair.sourceId.endsWith('I0') ? 30_000 : pair.sourceId.endsWith('I1') ? 480_000 : 4_200_000,
    idleEvidenceRef: `fixture:idle:${pair.id}:${arm}`,
    arm: arm as 'control' | 'candidate', model: 'gpt-6-sol', transport: 'subscription',
    authorizationScope: 'tenant-a/account-a', workloadFingerprint: 'fixture-v1', completed: true,
    quality: 'pass' as const, qualityEvidenceRef: `fixture:test-${n}-${arm}`, firstUsefulResponseMs: 1000,
    accountingComplete: true, requests: [
      { id: `${n}-${arm}-one`, phase: 'startup' as const, uncachedInputTokens: arm === 'control' ? 700000 : 50000 },
      { id: `${n}-${arm}-two`, phase: 'startup' as const, uncachedInputTokens: arm === 'control' ? 690000 : 50000 },
      { id: `${n}-${arm}-work`, phase: 'work' as const, uncachedInputTokens: 100000 },
    ],
  }))).flat();
  it('computes adopted thresholds on a complete paired cohort', () => {
    const result = evaluateCarryTaskPairs(cohort());
    expect(result.status).toBe('pass');
    expect(result.pairs).toBe(30);
    expect(result.metrics?.controlTotal).toBe(44_700_000);
    expect(result.metrics?.candidateTotal).toBe(6_000_000);
    expect(result.metrics?.uncertainty).toMatchObject({ method: 'paired-bootstrap-mean-difference',
      resamplingUnit: 'task-pair', ci: 0.95, iterations: 10000, seed: 12345 });
    expect(result.metrics?.uncertainty.firstTwo.delta).toEqual({ point: -1_290_000, lower: -1_290_000, upper: -1_290_000, ci: 0.95 });
    expect(result.metrics?.uncertainty.task.delta).toEqual({ point: -1_290_000, lower: -1_290_000, upper: -1_290_000, ci: 0.95 });
    expect(result.metrics?.strata.map(stratum => [stratum.sourceId, stratum.pairs])).toEqual(
      recipe.sources.map(source => [source.id, 5]));
  });
  it('requires the exact six measured history and idle strata from the frozen recipe', () => {
    const full = cohort(), first = recipe.pairs[0].id, another = recipe.pairs[1].id;
    expect(evaluateCarryTaskPairs(full.map(row => row.taskId === first ? { ...row, taskId: another } : row)).insufficient)
      .toContain(`missing-recipe-pair:${first}`);
    for (const changed of [
      { measuredHistoryInputTokens: null }, { measuredHistoryInputTokens: 599_999 },
      { historyEvidenceRef: '' }, { observedIdleMs: 60_000 }, { idleEvidenceRef: '' },
      { sourceRef: '' }, { sourceId: 'L-I2' },
    ]) {
      const rows = full.map((row, index) => index === 0 ? { ...row, ...changed } : row);
      expect(evaluateCarryTaskPairs(rows).status).toBe('insufficient');
    }
    const drift = full.map(row => row.taskId === another ? { ...row, sourceRef: 'fixture:different-cut' } : row);
    expect(evaluateCarryTaskPairs(drift).insufficient).toContain(`inconsistent-source-cut:${recipe.pairs[0].sourceId}`);
    const evidenceDrift = full.map(row => row.taskId === another ? { ...row, historyEvidenceRef: 'fixture:other-measurement' } : row);
    expect(evaluateCarryTaskPairs(evidenceDrift).insufficient).toContain(`inconsistent-source-cut:${recipe.pairs[0].sourceId}`);
  });
  it.each([
    ['S-I0', 20_000, 59_999, 19_999, 60_000],
    ['S-I1', 80_000, 600_000, 80_001, 600_001],
    ['L-I2', 600_000, 4_500_000, 599_999, 4_500_001],
  ] as const)('honors measured boundaries for %s without relabeling an out-of-band source',
    (sourceId, historyInBand, idleInBand, historyOutOfBand, idleOutOfBand) => {
      const base = cohort();
      const changed = (history: number, idle: number) => base.map(row => row.sourceId === sourceId
        ? { ...row, measuredHistoryInputTokens: history, observedIdleMs: idle } : row);
      expect(evaluateCarryTaskPairs(changed(historyInBand, idleInBand)).status).toBe('pass');
      expect(evaluateCarryTaskPairs(changed(historyOutOfBand, idleInBand)).status).toBe('insufficient');
      expect(evaluateCarryTaskPairs(changed(historyInBand, idleOutOfBand)).status).toBe('insufficient');
    });
  it('fails relocated cost in preparation/compaction/recovery/retry even when startup looks cheap', () => {
    for (const phase of ['preparation', 'compaction', 'recovery', 'retry'] as const) {
      const rows = cohort().map(row => row.arm === 'candidate' ? { ...row,
        requests: [...row.requests, { id: `${row.taskId}-hidden-cost`, phase, uncachedInputTokens: 1_400_000 }] } : row);
      const result = evaluateCarryTaskPairs(rows);
      expect(result.status).toBe('fail');
      expect(result.failures).toContain('task-reduction-below-25-percent');
    }
  });
  it('rejects cherry-picked, duplicate, incomplete or mismatched pairs', () => {
    const full = cohort();
    expect(evaluateCarryTaskPairs(full.slice(0, -1)).status).toBe('insufficient');
    expect(evaluateCarryTaskPairs([...full, full[0]]).status).toBe('insufficient');
    expect(evaluateCarryTaskPairs(full.map((row, n) => n === 0 ? { ...row, accountingComplete: false } : row)).status).toBe('insufficient');
    for (const dimension of ['model', 'transport', 'authorizationScope', 'workloadFingerprint'] as const) {
      expect(evaluateCarryTaskPairs(full.map((row, n) => n === 0 ? { ...row, [dimension]: 'different' } : row)).status).toBe('insufficient');
    }
  });
  it('fails quality/completion and p95 latency regressions despite token savings', () => {
    const full = cohort();
    expect(evaluateCarryTaskPairs(full.map((row, n) => n === 1 ? { ...row, completed: false } : row)).status).toBe('fail');
    expect(evaluateCarryTaskPairs(full.map((row, n) => n === 1 ? { ...row, quality: 'fail' } : row)).status).toBe('fail');
    expect(evaluateCarryTaskPairs(full.map(row => row.arm === 'candidate' ? { ...row, firstUsefulResponseMs: 1101 } : row)).failures)
      .toContain('p95-latency-regression-above-10-percent');
  });
  it('does not pass unknown counts, duplicate request ids, missing quality evidence, or empty cohorts', () => {
    expect(evaluateCarryTaskPairs([]).status).toBe('insufficient');
    expect(evaluateCarryTaskPairs(cohort().map(row => ({ ...row, qualityEvidenceRef: null }))).status).toBe('insufficient');
    expect(evaluateCarryTaskPairs(cohort().map(row => ({ ...row, requests: [...row.requests, row.requests[0]] }))).status).toBe('insufficient');
    expect(evaluateCarryTaskPairs(cohort().map(row => ({ ...row, requests: row.requests.map(request => ({ ...request, uncachedInputTokens: null })) }))).status).toBe('insufficient');
  });
  it('requires the registered initial 30 pairs by default', () => {
    expect(evaluateCarryTaskPairs(cohort().slice(0, 58)).status).toBe('insufficient');
  });
  it('does not inflate the cohort by reusing one charged event under another task or arm', () => {
    for (const target of [1, 2]) {
      const rows = cohort();
      rows[target] = { ...rows[target], requests: rows[target].requests.map((request, n) =>
        n === 0 ? { ...request, id: rows[0].requests[0].id } : request) };
      expect(evaluateCarryTaskPairs(rows).status).toBe('insufficient');
    }
  });
  it('does not pass savings supported only by one outlier when the paired interval includes zero', () => {
    const rows = cohort().map(row => row.taskId === recipe.pairs[0].id ? row : { ...row,
      requests: row.requests.map(request => ({ ...request, uncachedInputTokens: 10 })) });
    const result = evaluateCarryTaskPairs(rows);
    expect(result.status).toBe('insufficient');
    expect(result.failures).toEqual([]);
    expect(result.metrics?.uncertainty.task.delta.upper).toBe(0);
    expect(result.insufficient).toContain('task-improvement-not-supported-by-paired-95-ci');
    expect(evaluateCarryTaskPairs([...rows].reverse()).metrics?.uncertainty).toEqual(result.metrics?.uncertainty);
  });
  it('rejects unsafe aggregate token sums even when individual counts are safe integers', () => {
    // Cover overflow within one task and only after summing otherwise-safe tasks.
    for (const tokens of [Number.MAX_SAFE_INTEGER, 1_000_000_000_000_000]) {
      const rows = cohort().map(row => ({ ...row, requests: row.requests.map(request => ({ ...request,
        uncachedInputTokens: row.arm === 'control' ? tokens : 10 })) }));
      expect(evaluateCarryTaskPairs(rows).status).toBe('insufficient');
    }
  });
});

describe('carry input volume versus remote cache miss (P-004)', () => {
  // Counts reproduced from audit session01a0cd8f; fixture contains no prompt text.
  const observations = [
    { inputTotalTokens: 691102, cacheReadTokens: 0, cacheWriteTokens: 0, contextGeneration: 0 },
    { inputTotalTokens: 690650, cacheReadTokens: 2816, cacheWriteTokens: 0, contextGeneration: 0 },
    { inputTotalTokens: 90205, cacheReadTokens: 7936, cacheWriteTokens: 0, contextGeneration: 1 },
    { inputTotalTokens: 90825, cacheReadTokens: 89856, cacheWriteTokens: 0, contextGeneration: 1 },
  ];
  it('measures the 600k–700k inherited-prefix then compaction class without asserting a routing cause', () => {
    expect(diagnoseCarryUsage(observations, true)).toMatchObject({
      firstTwoTotalInput: 1381752, firstTwoUncachedInput: 1378936,
      firstAfterCompactionInput: 90205, oversizedThenCompacted: true, cacheMissCause: 'undetermined',
    });
  });
  it('distinguishes a cache-only counterfactual from removing inherited input', () => {
    const cached = observations.map(event => ({ ...event, cacheReadTokens: Math.floor(event.inputTotalTokens * 0.99) }));
    const baseline = diagnoseCarryUsage(observations, true);
    const routeOrTtlOnly = diagnoseCarryUsage(cached, true);
    expect(routeOrTtlOnly.firstTwoTotalInput).toBe(baseline.firstTwoTotalInput);
    expect(routeOrTtlOnly.firstTwoUncachedInput).toBeLessThan(baseline.firstTwoUncachedInput!);
    expect(routeOrTtlOnly.oversizedThenCompacted).toBe(true);
    const boundedCarry = observations.map(event => ({ ...event, inputTotalTokens: 50000,
      cacheReadTokens: 0, contextGeneration: 0 }));
    expect(diagnoseCarryUsage(boundedCarry, false)).toMatchObject({ firstTwoTotalInput: 100000,
      oversizedThenCompacted: false, cacheMissCause: 'undetermined' });
  });
  it('does not turn unknown splits, missing evidence or a short cohort into a saving', () => {
    expect(diagnoseCarryUsage([], null)).toMatchObject({ firstTwoTotalInput: null, firstTwoUncachedInput: null,
      oversizedThenCompacted: false });
    expect(diagnoseCarryUsage(observations.map(event => ({ ...event, cacheWriteTokens: null })), true))
      .toMatchObject({ firstTwoTotalInput: 1381752, firstTwoUncachedInput: null });
    expect(diagnoseCarryUsage(observations, null).oversizedThenCompacted).toBe(false);
    expect(diagnoseCarryUsage(observations.map(event => ({ ...event, contextGeneration: null })), true).oversizedThenCompacted).toBe(false);
  });
  it('rejects impossible cache decompositions and does not label a large fresh task as inherited-history waste', () => {
    expect(diagnoseCarryUsage(observations.map(event => ({ ...event, cacheReadTokens: 999999 })), true)
      .firstTwoUncachedInput).toBeNull();
    expect(diagnoseCarryUsage(observations, false).oversizedThenCompacted).toBe(false);
  });
});

function sample(overrides: Partial<LaunchSample> & { totalPromptTokens: number }): LaunchSample {
  return {
    ownerId: 'su-test',
    sessionId: 'session-test',
    filePath: '/tmp/session-test.jsonl',
    timestamp: '2026-09-18T06:00:00.000Z',
    day: '2026-09-18',
    model: 'claude-opus-5',
    entrypoint: 'cli',
    cliVersion: '1.0.0',
    cwd: '/repo',
    lineNumber: 20,
    bytesBeforeSample: 0,
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    ...overrides,
  };
}

describe('percentile', () => {
  it('uses linear interpolation between closest ranks (R type 7 / numpy default)', () => {
    // Hand-computed against the type-7 definition so the constants are independently checkable:
    // for n=5, rank = p*(n-1). p=0.10 -> rank 0.4 -> 1 + (2-1)*0.4 = 1.4.
    const values = [1, 2, 3, 4, 5];
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 0.1)).toBeCloseTo(1.4, 10);
    expect(percentile(values, 0.5)).toBe(3);
    expect(percentile(values, 0.9)).toBeCloseTo(4.6, 10);
    expect(percentile(values, 1)).toBe(5);
  });

  it('returns the conventional mean-of-two-middles median for an even sample', () => {
    // This is the property that motivated type-7 over nearest-rank: a nearest-rank median of
    // [10,20,30,40] is 20, which would silently disagree with any median computed elsewhere.
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it('does not require sorted input', () => {
    expect(median([40, 10, 30, 20])).toBe(25);
  });

  it('handles a single sample', () => {
    expect(percentile([7], 0.9)).toBe(7);
  });

  it('throws rather than inventing a value for an empty sample set', () => {
    // A percentile over no data must not be representable as a number: the whole plan is graded
    // on a median moving DOWN, so a zero here would read as total success.
    expect(() => percentile([], 0.5)).toThrow(/empty sample set/);
  });

  it('rejects an out-of-range p', () => {
    expect(() => percentile([1, 2, 3], 1.5)).toThrow(/\[0,1\]/);
  });
});

describe('extractLaunchUsage', () => {
  it('sums all three prompt-side fields, not input_tokens alone', () => {
    // The measured real shape: a cached launch turn reports input_tokens: 2 while actually
    // paying ~232k. Reading input_tokens alone reports that launch as 2.
    const usage = extractLaunchUsage({
      message: {
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 128_745,
          cache_read_input_tokens: 103_666,
          output_tokens: 296,
        },
      },
    });
    expect(usage).toEqual({
      usageCountsComplete: true,
      inputTokens: 2,
      cacheCreationTokens: 128_745,
      cacheReadTokens: 103_666,
      totalPromptTokens: 232_413,
    });
  });

  it('returns null when there is no usage object', () => {
    expect(extractLaunchUsage({ type: 'user', message: { content: 'hi' } })).toBeNull();
    expect(extractLaunchUsage({ type: 'user' })).toBeNull();
    expect(extractLaunchUsage(null)).toBeNull();
    expect(extractLaunchUsage('not an object')).toBeNull();
    expect(extractLaunchUsage([{ message: { usage: {} } }])).toBeNull();
  });

  it('marks missing individual fields as incomplete rather than claiming a complete prompt sum', () => {
    const usage = extractLaunchUsage({ message: { usage: { input_tokens: 5 } } });
    expect(usage).toEqual({
      usageCountsComplete: false,
      inputTokens: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalPromptTokens: 5,
    });
  });

  it('ignores non-numeric and non-finite field values', () => {
    const usage = extractLaunchUsage({
      message: { usage: { input_tokens: '900', cache_read_input_tokens: Number.NaN } },
    });
    expect(usage?.totalPromptTokens).toBe(0);
  });
});

describe('isLaunchCandidate', () => {
  const big = {
    inputTokens: 2,
    cacheCreationTokens: 100_000,
    cacheReadTokens: 100_000,
    totalPromptTokens: 200_002,
  };
  const tiny = {
    inputTokens: 40,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalPromptTokens: 40,
  };

  it('accepts a large non-sidechain turn', () => {
    expect(isLaunchCandidate({ isSidechain: false }, big)).toBe(true);
  });

  it('rejects a turn at or below the token floor', () => {
    expect(isLaunchCandidate({}, tiny)).toBe(false);
    expect(
      isLaunchCandidate({}, { ...tiny, totalPromptTokens: DEFAULT_MIN_PROMPT_TOKENS }),
    ).toBe(false);
    expect(
      isLaunchCandidate({}, { ...tiny, totalPromptTokens: DEFAULT_MIN_PROMPT_TOKENS + 1 }),
    ).toBe(true);
  });

  it('rejects sidechain turns by default and accepts them when asked', () => {
    expect(isLaunchCandidate({ isSidechain: true }, big)).toBe(false);
    expect(isLaunchCandidate({ isSidechain: true }, big, { includeSidechains: true })).toBe(true);
  });
});

describe('utcDay', () => {
  it('derives a UTC day, not a local one', () => {
    // 03:00Z on the 18th is still the 17th in this box's local -04:00 offset. The instrument
    // groups in UTC so its days line up with Papercusp timestamps rather than the host's TZ.
    expect(utcDay('2026-09-18T03:00:00.000Z')).toBe('2026-09-18');
    expect(utcDay('2026-09-18T00:30:00.000Z')).toBe('2026-09-18');
  });

  it('returns null rather than inventing a day for an unparseable timestamp', () => {
    expect(utcDay('not a date')).toBeNull();
    expect(utcDay(null)).toBeNull();
    expect(utcDay(undefined)).toBeNull();
    expect(utcDay('')).toBeNull();
  });
});

describe('extractSampleContext', () => {
  it('reads the descriptive fields and falls back from sessionId to session_id', () => {
    expect(
      extractSampleContext({
        timestamp: '2026-09-18T06:31:53.858Z',
        entrypoint: 'cli',
        version: '2.1.0',
        cwd: '/repo',
        session_id: 'legacy-id',
        message: { model: 'claude-opus-5' },
      }),
    ).toEqual({
      timestamp: '2026-09-18T06:31:53.858Z',
      model: 'claude-opus-5',
      entrypoint: 'cli',
      cliVersion: '2.1.0',
      cwd: '/repo',
      sessionId: 'legacy-id',
    });
  });

  it('returns nulls, not undefined or empty strings, for absent fields', () => {
    expect(extractSampleContext({})).toEqual({
      timestamp: null,
      model: null,
      entrypoint: null,
      cliVersion: null,
      cwd: null,
      sessionId: null,
    });
  });
});

describe('summarizeOverall', () => {
  it('discloses missing usage counters in aggregate lower bounds', () => {
    const complete = sample({ totalPromptTokens: 10, usageCountsComplete: true });
    const partial = sample({ totalPromptTokens: 5, usageCountsComplete: false });
    expect(summarizeOverall([complete, partial])?.incompleteCount).toBe(1);
    expect(summarizeByDay([complete, partial])[0]?.incompleteCount).toBe(1);
  });
  it('returns null for an empty sample set instead of a zero-filled record', () => {
    // The load-bearing assertion of this file. A zero-filled summary over no data reads as
    // "launch cost is 0" — a spectacular apparent success — and is indistinguishable at the
    // call site from a real measurement.
    expect(summarizeOverall([])).toBeNull();
  });

  it('computes totals and the cache split', () => {
    const stats = summarizeOverall([
      sample({ totalPromptTokens: 100, cacheReadTokens: 60, cacheCreationTokens: 40 }),
      sample({ totalPromptTokens: 200, cacheReadTokens: 120, cacheCreationTokens: 80 }),
      sample({ totalPromptTokens: 300, cacheReadTokens: 180, cacheCreationTokens: 120 }),
    ]);
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(3);
    expect(stats!.medianTotal).toBe(200);
    expect(stats!.minTotal).toBe(100);
    expect(stats!.maxTotal).toBe(300);
    expect(stats!.medianCacheRead).toBe(120);
    expect(stats!.medianCacheCreation).toBe(80);
  });
});

describe('summarizeByDay', () => {
  it('groups by UTC day, ascending, without zero-filling absent days', () => {
    const days = summarizeByDay([
      sample({ day: '2026-09-18', totalPromptTokens: 300 }),
      sample({ day: '2026-09-11', totalPromptTokens: 100 }),
      sample({ day: '2026-09-11', totalPromptTokens: 200 }),
    ]);
    expect(days.map((d) => d.day)).toEqual(['2026-09-11', '2026-09-18']);
    expect(days[0]!.count).toBe(2);
    expect(days[0]!.medianTotal).toBe(150);
    expect(days[1]!.count).toBe(1);
    expect(days[1]!.medianTotal).toBe(300);
    // 2026-09-12..17 had no samples and must be ABSENT, not present with zeros — a zero-valued
    // day in a downward-trending report would look like the best day on record.
    expect(days).toHaveLength(2);
  });

  it('returns an empty array, not a fabricated day, for no samples', () => {
    expect(summarizeByDay([])).toEqual([]);
  });
});

describe('summarizeStartupCacheEvidence — token-efficiency-prompts-cache-and-behavior-2026-10-11 P-001', () => {
  const hash = (seed: string, bytes = 100) => ({ sha16: seed.padEnd(16, '0').slice(0, 16), bytes });
  type Over = {
    ownerId?: string; requestId?: number; startedAt?: number; model?: string; messages?: number; tools?: number;
    systemBlocks?: number; markers?: Array<{ section: 'tools' | 'system' | 'messages'; index: number; block: number | null; ttl: '5m' | '1h' | 'default' }>;
    read?: number | null; write?: number | null; input?: number | null; layout?: null; outcome?: string;
    /** Byte sizes of messages[0] content blocks; omitted = no first-message layout recorded. */
    firstBlocks?: number[];
  };
  const line = (o: Over = {}) => {
    const systemBlocks = o.systemBlocks ?? 2;
    const record = {
      schema: 'startup-cache-evidence/v1', requestId: o.requestId ?? 1, ownerId: o.ownerId ?? 'su-a',
      provider: 'claude', protocol: 'anthropic-messages', transport: 'oauth-http', model: o.model ?? 'claude-opus-test',
      authorizationScope: 'acct', tools: null, instructions: null,
      layout: o.layout === null ? null : {
        tools: { count: o.tools ?? 90, deferred: 0 },
        system: { form: 'blocks', blockCount: systemBlocks, blocks: Array.from({ length: systemBlocks }, (_, i) => hash(`s${i}`)) },
        messages: {
          count: o.messages ?? 1,
          first: o.firstBlocks
            ? {
              role: 'user', blockCount: o.firstBlocks.length, hash: hash('m0', o.firstBlocks.reduce((a, b) => a + b, 0)),
              blocks: o.firstBlocks.map((bytes, i) => hash(`m0b${i}`, bytes)),
            }
            : null,
        },
        markers: o.markers ?? [{ section: 'system', index: 0, block: null, ttl: '1h' }],
        truncated: false,
      },
      native: { sessionId: null, threadId: null }, startedAt: o.startedAt ?? 1000, finalizedAt: 2000,
      inputTokens: o.input === undefined ? 3 : o.input,
      cacheReadTokens: o.read === undefined ? 4000 : o.read,
      cacheWriteTokens: o.write === undefined ? 80000 : o.write,
      reuse: 'unobserved', outcome: o.outcome ?? 'ok', finalStatus: 200,
    };
    // journald -o cat prints the payload alone; other formats prefix it — both must parse.
    return `Oct 12 01:00:00 host gateway[1]: startup-cache-evidence/v1 ${JSON.stringify(record)}`;
  };

  it('counts a journal line repeated by the reader once, and says how many it dropped', () => {
    const a = line({ ownerId: 'su-a', requestId: 1 });
    const summary = summarizeStartupCacheEvidence([a, a, line({ ownerId: 'su-b', requestId: 2 })]);
    expect(summary).toMatchObject({ evidenceLines: 3, duplicates: 1, requests: 2 });
    expect(summary.startup).toMatchObject({ requests: 2, owners: 2, measured: 2, cacheWriteTokens: 160000 });
    // Same owner and request counter but a different start = a gateway restart reused the counter: NOT a duplicate.
    expect(summarizeStartupCacheEvidence([a, line({ ownerId: 'su-a', requestId: 1, startedAt: 9999 })]).duplicates).toBe(0);
  });

  it('keeps a row with a missing counter as unknown — never a zero in totals or medians', () => {
    const summary = summarizeStartupCacheEvidence([
      line({ ownerId: 'su-a', write: 90000, read: 1000, input: 5 }),
      line({ ownerId: 'su-b', write: null, read: null, input: null, outcome: 'upstream-429' }),
      line({ ownerId: 'su-c', write: 70000, read: null, input: 5 }),
    ]);
    expect(summary.startup).toMatchObject({
      requests: 3, measured: 1, unknownUsage: 2,
      cacheWriteTokens: 90000, cacheReadTokens: 1000, uncachedInputTokens: 5,
      medianCacheWriteTokens: 90000, medianCacheReadTokens: 1000,
    });
    // A median over an empty measured set is null, not 0.
    const none = summarizeStartupCacheEvidence([line({ write: null })]);
    expect(none.startup.medianCacheWriteTokens).toBeNull();
    expect(none.startupWriteShare).toBeNull();
  });

  it('applies the gateway startup predicate: mid-conversation and tool-less rows are not startups', () => {
    const summary = summarizeStartupCacheEvidence([
      line({ ownerId: 'su-a', write: 80000 }),
      line({ ownerId: 'su-b', messages: 40, write: 20000 }),
      line({ ownerId: 'su-c', tools: 0, write: 0 }),
      line({ ownerId: 'su-d', layout: null, write: 5000 }),
    ]);
    expect(summary).toMatchObject({ requests: 4, noLayout: 1 });
    expect(summary.startup).toMatchObject({ requests: 1, cacheWriteTokens: 80000 });
    expect(summary.all).toMatchObject({ requests: 4, cacheWriteTokens: 105000 });
    expect(summary.startupWriteShare).toBeCloseTo(80000 / 105000, 6);
  });

  it('groups startups by model, transport, system block count and breakpoint layout, largest first', () => {
    const boundary = [{ section: 'system' as const, index: 1, block: null, ttl: '1h' as const }];
    const summary = summarizeStartupCacheEvidence([
      line({ ownerId: 'su-a', write: 78000, read: 3700 }),
      line({ ownerId: 'su-b', write: 79000, read: 3600 }),
      line({ ownerId: 'su-c', write: 77000, read: 3800 }),
      line({ ownerId: 'su-d', systemBlocks: 3, markers: boundary, write: 2000, read: 84600 }),
      line({ ownerId: 'su-e', model: 'claude-sonnet-test', write: 1, read: 1 }),
    ]);
    expect(summary.groups.map((g) => [g.requests, g.systemBlocks, g.markers])).toEqual([
      // ties break on the key, so the opus boundary cohort precedes the sonnet one
      [3, 2, 's0:1h'], [1, 3, 's1:1h'], [1, 2, 's0:1h'],
    ]);
    expect(summary.groups[2]!.model).toBe('claude-sonnet-test');
    expect(summary.groups[0]).toMatchObject({ model: 'claude-opus-test', owners: 3, medianCacheWriteTokens: 78000, medianCacheReadTokens: 3700 });
    expect(summary.groups.find((g) => g.systemBlocks === 3)).toMatchObject({ medianCacheReadTokens: 84600, medianCacheWriteTokens: 2000 });
  });

  it('reports the median messages[0] block-0 size per cohort (the repo-guide block R-9 bounds the relocation uplift by), null when unrecorded', () => {
    const relocated = [{ section: 'system' as const, index: 1, block: null, ttl: '1h' as const }, { section: 'messages' as const, index: 0, block: 0, ttl: '1h' as const }];
    const summary = summarizeStartupCacheEvidence([
      line({ ownerId: 'su-a', markers: relocated, firstBlocks: [90000, 400] }),
      line({ ownerId: 'su-b', markers: relocated, firstBlocks: [92000, 600] }),
      line({ ownerId: 'su-c', markers: relocated, firstBlocks: [94000] }),
      // A member without a first-message layout neither counts as zero nor shifts the median.
      line({ ownerId: 'su-d', markers: relocated }),
      line({ ownerId: 'su-e' }),
    ]);
    const byMarkers = new Map(summary.groups.map((g) => [g.markers, g]));
    expect(byMarkers.get('s1:1h,m0:1h')).toMatchObject({ requests: 4, medianFirstMessageBlock0Bytes: 92000 });
    expect(byMarkers.get('s0:1h')).toMatchObject({ requests: 1, medianFirstMessageBlock0Bytes: null });
  });

  it('counts schema-marked lines that do not parse as malformed and ignores unrelated lines', () => {
    const summary = summarizeStartupCacheEvidence([
      'unrelated journal line',
      'startup-cache-evidence/v1 {not json',
      line().replace('"ownerId":"su-a"', '"ownerId":""'),
      line(),
    ]);
    expect(summary).toMatchObject({ evidenceLines: 3, malformed: 2, requests: 1 });
  });
});
