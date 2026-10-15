import { describe, expect, it } from 'vitest';
import {
  GatewayRequestTelemetry,
  type GatewayRequestTimeline,
} from './request-stage-telemetry';
import {
  GATEWAY_REQUEST_OUTCOME_RETENTION_MS,
  InMemoryGatewayRequestOutcomeStore,
  gatewayRequestOutcomeRecord,
} from './gateway-request-outcome-store';
import { activeWorkspaceId } from '../workspace-registry';

const BASE = Date.parse('2026-10-13T09:00:00.000Z');
const workspaceId = activeWorkspaceId();

function timeline(input: {
  requestId: number;
  ownerId?: string | null;
  startedAt: number;
  outcome: GatewayRequestTimeline['outcome'];
  finalStatus: number | null;
}): GatewayRequestTimeline {
  return {
    requestId: input.requestId,
    ownerId: input.ownerId ?? 'su-owner-a',
    provider: 'claude',
    protocol: 'anthropic-messages',
    transport: 'oauth-http',
    model: 'claude-sonnet-4',
    providerIdentity: null,
    cacheRouting: 'not-applicable',
    cache: {
      servingAccountId: 'account-a', providerRequestId: null, inputTokens: null,
      cacheReadTokens: null, cacheWriteTokens: null, reuse: 'unobserved',
      missReason: 'unobserved', shape: 'unobserved', tools: null, instructions: null,
      nativeInstructionTemplate: null, layout: null,
    },
    nativeCorrelation: { status: 'missing', sessionId: null, threadId: null, turnId: null, windowId: null },
    upstreamWrites: { calls: [], droppedCalls: 0 },
    previousObservedRequestGapMs: null,
    cacheObservationMs: 0,
    startedAt: input.startedAt,
    finalizedAt: input.startedAt + 250,
    attempts: input.outcome === 'shed' ? 0 : 1,
    failovers: 0,
    finalStatus: input.finalStatus,
    outcome: input.outcome,
    streaming: false,
    durationsMs: { total: 250 },
    admission: {},
    events: [],
    missingStages: [],
  };
}

describe('gateway request outcome store', () => {
  it('captures each completed telemetry span without waiting for durable storage', () => {
    const completed: GatewayRequestTimeline[] = [];
    const telemetry = new GatewayRequestTelemetry({ now: () => BASE, onCompleted: value => { completed.push(value); } });
    const span = telemetry.begin({
      ownerId: 'su-owner-a', provider: 'claude', protocol: 'anthropic-messages', transport: 'oauth-http',
    });

    expect(span.finish('shed', 429)?.outcome).toBe('shed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ ownerId: 'su-owner-a', finalStatus: 429, attempts: 0 });
  });

  it('filters owner and request-time window and returns mixed outcomes after a gateway restart', async () => {
    const durableRows: ReturnType<typeof gatewayRequestOutcomeRecord>[] = [];
    const writer = new InMemoryGatewayRequestOutcomeStore(durableRows);
    const outcomes: GatewayRequestTimeline['outcome'][] = [
      ...Array<GatewayRequestTimeline['outcome']>(13).fill('upstream-429'),
      'shed', 'shed', 'client-error', 'upstream-error',
    ];
    for (let index = 0; index < outcomes.length; index++) {
      const at = BASE + index * 10 * 60_000;
      await writer.record(gatewayRequestOutcomeRecord(
        'gateway-process-before-restart',
        timeline({ requestId: index + 1, startedAt: at, outcome: outcomes[index],
          finalStatus: outcomes[index] === 'upstream-429' || outcomes[index] === 'shed' ? 429
            : outcomes[index] === 'client-error' ? 400 : 502 }),
        workspaceId,
      ));
    }
    await writer.record(gatewayRequestOutcomeRecord('another-process',
      timeline({ requestId: 1, ownerId: 'su-other-owner', startedAt: BASE + 2_000_000,
        outcome: 'ok', finalStatus: 200 }), workspaceId));

    // A new store instance represents a new gateway process reading the persistent table.
    const restartedReader = new InMemoryGatewayRequestOutcomeStore(durableRows);
    const report = await restartedReader.report({ ownerId: 'su-owner-a', fromMs: BASE, toMs: BASE + 3 * 60 * 60_000,
      nowMs: BASE + 5 * 60 * 60_000, limit: 50 });
    expect(report.total).toBe(17);
    expect(report.rows).toHaveLength(17);
    expect(report.byOutcome).toMatchObject({ 'upstream-429': 13, shed: 2, 'client-error': 1, 'upstream-error': 1 });
    expect(report.rows[0].gatewayProcessInstanceId).toBe('gateway-process-before-restart');
    expect(report.rows[0].selectedAccountId).toBe('account-a');
    expect(report.rows.every(row => row.ownerId === 'su-owner-a')).toBe(true);

    const outsideWindow = await restartedReader.report({ ownerId: 'su-owner-a', fromMs: BASE, toMs: BASE + 10,
      nowMs: BASE + 5 * 60 * 60_000 });
    expect(outsideWindow.total).toBe(1);
    expect(outsideWindow.rows[0].outcomeClass).toBe('upstream-429');
  });

  it('retains incident rows beyond the gateway stall-event four-hour window and prunes after 14 days', async () => {
    const store = new InMemoryGatewayRequestOutcomeStore();
    const old = timeline({ requestId: 1, startedAt: BASE, outcome: 'upstream-error', finalStatus: 502 });
    await store.record(gatewayRequestOutcomeRecord('gateway-before-restart', old, workspaceId));
    const afterFiveHours = BASE + 5 * 60 * 60_000;
    expect((await store.report({ ownerId: 'su-owner-a', nowMs: afterFiveHours })).rows).toHaveLength(1);
    expect(GATEWAY_REQUEST_OUTCOME_RETENTION_MS).toBe(14 * 24 * 60 * 60_000);

    const later = afterFiveHours + GATEWAY_REQUEST_OUTCOME_RETENTION_MS;
    await store.record(gatewayRequestOutcomeRecord('gateway-later',
      timeline({ requestId: 1, startedAt: later, outcome: 'ok', finalStatus: 200 }), workspaceId));
    expect(store.rows.some(row => row.gatewayProcessInstanceId === 'gateway-before-restart')).toBe(false);
  });
});
