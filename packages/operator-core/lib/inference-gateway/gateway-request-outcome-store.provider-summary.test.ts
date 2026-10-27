import { afterEach, describe, expect, it } from 'vitest';
import { activeWorkspaceId } from '../workspace-registry';
import {
  InMemoryGatewayRequestOutcomeStore,
  configureGatewayRequestOutcomeStore,
  resetGatewayRequestOutcomeStore,
  summarizeGatewayProviderOutcomes,
  summarizeProviderOutcomeCounts,
  type GatewayRequestOutcomeRecord,
} from './gateway-request-outcome-store';

/**
 * WI-6554700010029776 — the provider-wide outcome census the capacity verdict reads.
 * It must count every caller, count refusals as shed + upstream-429 only (a client
 * cancel is not a capacity signal), and stay inside the window and provider.
 */

const NOW = 1_800_000_000_000;

function row(over: Partial<GatewayRequestOutcomeRecord>, i: number): GatewayRequestOutcomeRecord {
  return {
    requestId: `r-${i}`,
    gatewayProcessInstanceId: 'gw-test',
    requestOrdinal: i,
    workspaceId: activeWorkspaceId(),
    ownerId: 'agent-a',
    provider: 'codex',
    protocol: 'openai-responses',
    transport: 'http',
    model: null,
    selectedAccountId: null,
    attemptAccountIds: [],
    outcomeClass: 'ok',
    finalStatus: 200,
    requestTimestampMs: NOW - 60_000,
    finalizedAtMs: NOW - 59_000,
    attempts: 1,
    failovers: 0,
    nativeSessionId: null,
    nativeThreadId: null,
    nativeTurnId: null,
    nativeWindowId: null,
    recordedAtMs: NOW - 59_000,
    retentionExpiresAtMs: NOW + 86_400_000,
    ...over,
  } as GatewayRequestOutcomeRecord;
}

afterEach(() => resetGatewayRequestOutcomeStore());

describe('summarizeGatewayProviderOutcomes (in-memory store)', () => {
  it('counts every caller in the window, refusals as shed + upstream-429 only', async () => {
    const rows = [
      row({ outcomeClass: 'ok' }, 1),
      row({ outcomeClass: 'ok', ownerId: 'agent-b' }, 2),
      row({ outcomeClass: 'shed', ownerId: 'sidecar' }, 3),
      row({ outcomeClass: 'shed', ownerId: 'sidecar' }, 4),
      row({ outcomeClass: 'upstream-429', ownerId: 'agent-b' }, 5),
      row({ outcomeClass: 'cancelled' }, 6),
      // outside the window, another provider, another workspace: all excluded
      row({ outcomeClass: 'shed', requestTimestampMs: NOW - 3_600_000 }, 7),
      row({ outcomeClass: 'shed', provider: 'claude' } as Partial<GatewayRequestOutcomeRecord>, 8),
      row({ outcomeClass: 'shed', workspaceId: 'some-other-workspace' }, 9),
    ];
    configureGatewayRequestOutcomeStore(new InMemoryGatewayRequestOutcomeStore(rows));
    const s = await summarizeGatewayProviderOutcomes({ provider: 'codex', fromMs: NOW - 15 * 60_000, nowMs: NOW });
    expect(s.served).toBe(2);
    expect(s.refused).toBe(3);
    expect(s.byOutcome.cancelled).toBe(1);
    expect(s.refusedOwners).toBe(2);
    expect(s.topRefusedOwner).toEqual({ ownerId: 'sidecar', refused: 2 });
  });

  it('reports no top caller when nothing was refused', async () => {
    configureGatewayRequestOutcomeStore(new InMemoryGatewayRequestOutcomeStore([row({}, 1)]));
    const s = await summarizeGatewayProviderOutcomes({ provider: 'codex', fromMs: NOW - 15 * 60_000, nowMs: NOW });
    expect(s.refused).toBe(0);
    expect(s.refusedOwners).toBe(0);
    expect(s.topRefusedOwner).toBeNull();
  });
});

describe('summarizeProviderOutcomeCounts (the fold the PG store uses)', () => {
  it('sums grouped counts and ignores non-positive or unknown rows', () => {
    const s = summarizeProviderOutcomeCounts('codex', { fromMs: 0, toMs: 1 }, [
      { outcome: 'ok', ownerId: 'a', count: 714 },
      { outcome: 'shed', ownerId: 'sidecar', count: 150 },
      { outcome: 'upstream-429', ownerId: 'sidecar', count: 14 },
      { outcome: 'shed', ownerId: null, count: 0 },
      { outcome: 'not-a-class' as never, ownerId: 'x', count: 5 },
    ]);
    expect(s.served).toBe(714);
    expect(s.refused).toBe(164);
    expect(s.refusedOwners).toBe(1);
    expect(s.topRefusedOwner).toEqual({ ownerId: 'sidecar', refused: 164 });
  });
});
