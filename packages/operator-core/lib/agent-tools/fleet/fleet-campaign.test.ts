import { describe, expect, it, vi } from 'vitest';
import {
  FLEET_CAMPAIGN_RECENT_ROW_CAP,
  partitionTerminalGroups,
  projectFleetTerminalCompletion,
  recentEvidence,
  resolveFleetCampaignBoundary,
  FLEET_CAMPAIGN_AXIS_READ_CONCURRENCY,
  FLEET_CAMPAIGN_SLOW_AXIS_LOG_THRESHOLD_MS,
  runFleetCampaignAxisReads,
} from './fleet-campaign';

describe('fleet campaign pure contracts', () => {
  it('runs independent campaign axes concurrently with a bounded stable width', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const reads = Array.from({ length: 7 }, (_, index) => ({
      axis: 'speaking' as const,
      read: async () => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return index;
      },
    }));

    const results = await runFleetCampaignAxisReads(reads);
    expect(results.map(({ value }) => value)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(results.every(({ elapsedMs }) => elapsedMs >= 0)).toBe(true);
    expect(peakInFlight).toBe(FLEET_CAMPAIGN_AXIS_READ_CONCURRENCY);
  });

  it('logs a slow axis duration with the parent campaign correlation id', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const correlationId = 'b497d96b-f582-49b0-9397-94610fd9b04e';
    const elapsedMs = FLEET_CAMPAIGN_SLOW_AXIS_LOG_THRESHOLD_MS + 1;
    try {
      const pending = runFleetCampaignAxisReads([
        { axis: 'terminals' as const, read: () => new Promise<string>((resolve) => setTimeout(() => resolve('ready'), elapsedMs)) },
      ], { correlationId });
      await vi.advanceTimersByTimeAsync(elapsedMs);
      await expect(pending).resolves.toEqual([
        { axis: 'terminals', value: 'ready', elapsedMs },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(correlationId));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"axis":"terminals"'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`"elapsedMs":${elapsedMs}`));
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it('uses a valid explicit since boundary and otherwise falls back to fleet creation', () => {
    expect(resolveFleetCampaignBoundary('2026-08-13T10:00:00Z', 1)).toEqual({
      at: '2026-08-13T10:00:00.000Z',
      source: 'explicit-since',
    });
    expect(resolveFleetCampaignBoundary('not-a-date', Date.UTC(2026, 7, 12))).toEqual({
      at: '2026-08-12T00:00:00.000Z',
      source: 'fleet-created-at',
    });
  });

  it('caps recent evidence without capping or disguising the exact total', () => {
    const rows = Array.from({ length: 20 }, (_, id) => ({ id }));
    expect(recentEvidence(rows, 20)).toEqual({
      total: 20,
      shown: FLEET_CAMPAIGN_RECENT_ROW_CAP,
      truncated: true,
      rows: rows.slice(0, FLEET_CAMPAIGN_RECENT_ROW_CAP),
    });
  });

  it('partitions terminal flow by owner class, fleet membership, and authority', () => {
    const out = partitionTerminalGroups(
      [
        { terminal_owner: 'su-member', authority: 'committed', count: 3 },
        { terminal_owner: 'su-outsider', authority: 'proposed', count: 2 },
        { terminal_owner: 'system:reconciler', authority: 'validated', count: 1 },
        { terminal_owner: null, authority: null, count: 4 },
      ],
      new Set(['su-member']),
    );

    expect(out).toMatchObject({
      total: 10,
      counted: 8,
      notCounted: 2,
      byOwnerClass: { agent: 5, system: 1, unattributed: 4 },
      byFleetMembership: { member: 3, nonMember: 3, unattributed: 4 },
      byAuthority: { committed: 3, proposed: 2, validated: 1, 'legacy-null': 4 },
    });
  });

  it('projects the fleet audit row from durable terminal attribution and structured evidence', () => {
    expect(
      projectFleetTerminalCompletion({
        feature_id: 'WI-42',
        item_kind: 'change',
        title: 'Add the fleet completion feed',
        status: 'done',
        terminal_owner: 'su-member',
        terminal_completion_ref: 'verified implementation',
        completion_evidence: {
          verifiedHow: 'unit',
          testsRun: 'npm run test:file -- fleet-campaign.test.ts',
          testResult: 'green',
          addedTests: true,
          filesChanged: ['fleet-campaign.ts'],
        },
        authority: 'committed',
        closed_ts: Date.UTC(2026, 7, 23),
      }),
    ).toEqual({
      id: 'WI-42',
      kind: 'change',
      title: 'Add the fleet completion feed',
      status: 'done',
      terminalOwner: 'su-member',
      terminalCompletionRef: 'verified implementation',
      completionEvidence: {
        verifiedHow: 'unit',
        testsRun: 'npm run test:file -- fleet-campaign.test.ts',
        testResult: 'green',
        addedTests: true,
        filesChanged: ['fleet-campaign.ts'],
      },
      verifiedHow: 'unit',
      addedTests: true,
      completionAuthority: 'committed',
      countsTowardBurnDown: true,
      terminalizedAt: '2026-08-23T00:00:00.000Z',
    });
  });

  it('drops malformed legacy completion evidence without losing attribution', () => {
    expect(
      projectFleetTerminalCompletion({
        feature_id: 'EI-legacy',
        item_kind: 'bug',
        title: null,
        status: 'resolved',
        terminal_owner: 'su-member',
        terminal_completion_ref: null,
        completion_evidence: { filesChanged: 'not-an-array' },
        authority: null,
        closed_ts: 0,
      }),
    ).toMatchObject({
      id: 'EI-legacy',
      terminalOwner: 'su-member',
      completionEvidence: null,
      verifiedHow: null,
      addedTests: null,
      completionAuthority: null,
      countsTowardBurnDown: true,
    });
  });
});
