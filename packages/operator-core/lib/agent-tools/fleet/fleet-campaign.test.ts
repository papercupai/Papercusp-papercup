import { describe, expect, it } from 'vitest';
import {
  FLEET_CAMPAIGN_RECENT_ROW_CAP,
  partitionTerminalGroups,
  projectFleetTerminalCompletion,
  recentEvidence,
  resolveFleetCampaignBoundary,
  FLEET_CAMPAIGN_AXIS_READ_CONCURRENCY,
  runFleetCampaignAxisReads,
} from './fleet-campaign';

describe('fleet campaign pure contracts', () => {
  it('runs independent campaign axes concurrently with a bounded stable width', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const reads = Array.from({ length: 7 }, (_, index) => async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return index;
    });

    await expect(runFleetCampaignAxisReads(reads)).resolves.toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(peakInFlight).toBe(FLEET_CAMPAIGN_AXIS_READ_CONCURRENCY);
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
