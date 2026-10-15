/**
 * P-005 / D-030 step 6: readLedFleetStaffing, the read behind the fleet-staffing
 * obligation. Every collaborator is injected, so these cases pin the read's own
 * decisions (which fleets, which legs are unknown, what reaches the projection)
 * without vi.mock or a database.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentFleetRecord, FleetHeadcountState } from '../agent-fleets-store';
import {
  FLEET_STAFFING_MAX_FLEETS,
  readLedFleetStaffing,
  type FleetStaffingReadDeps,
} from './fleet-staffing-read';

const INPUT = { workspaceId: 'ws-test', ownerId: 'su-leader' };

function fleet(fleetSlug: string, controlState: 'active' | 'winding-down' = 'active'): AgentFleetRecord {
  return { fleetSlug, controlState, leaderOwnerId: INPUT.ownerId } as AgentFleetRecord;
}

function headcount(over: Partial<FleetHeadcountState> = {}): FleetHeadcountState {
  return {
    enabled: true,
    target: 3,
    current: 0,
    shortfall: 3,
    underStrength: true,
    verdict: 'under-strength',
    held: false,
    notHeldBecause: 'supervise-not-granted',
    topUpRule: { status: 'none', kind: null, inherited: null, ratifiedBy: null, reason: null, until: null },
    basis: {
      kind: 'agent-origin-execution-attested',
      liveRosterMembers: 0,
      executingMembers: 0,
      transactionWorkerReadyMembers: null,
    },
    countEvidence: { productive: null, liveRoster: null, transactionWorkerReady: null, note: '' },
    ...over,
  } as FleetHeadcountState;
}

function deps(over: Partial<FleetStaffingReadDeps> = {}): FleetStaffingReadDeps {
  return {
    listFleetsLedBy: async () => [fleet('fleet-a')],
    headcountTarget: async () => null,
    liveMemberIds: async () => [],
    countedMemberIds: async () => new Set<string>(),
    governorFlagOn: async () => true,
    projectHeadcount: () => headcount(),
    ...over,
  };
}

describe('readLedFleetStaffing (P-005 / D-030)', () => {
  it('returns [] when the owner leads no fleet, without reading anything else', async () => {
    const governorFlagOn = vi.fn(async () => true);
    const liveMemberIds = vi.fn(async () => []);
    const rows = await readLedFleetStaffing(
      INPUT,
      deps({ listFleetsLedBy: async () => [], governorFlagOn, liveMemberIds }),
    );
    expect(rows).toEqual([]);
    expect(governorFlagOn).not.toHaveBeenCalled();
    expect(liveMemberIds).not.toHaveBeenCalled();
  });

  it('skips winding-down fleets, so the obligation clears on wind-down', async () => {
    const liveMemberIds = vi.fn(async () => []);
    const rows = await readLedFleetStaffing(
      INPUT,
      deps({ listFleetsLedBy: async () => [fleet('fleet-done', 'winding-down'), fleet('fleet-a')], liveMemberIds }),
    );
    expect(rows.map((r) => r.fleetSlug)).toEqual(['fleet-a']);
    expect(liveMemberIds).toHaveBeenCalledTimes(1);
    expect(liveMemberIds).toHaveBeenCalledWith(INPUT.workspaceId, 'fleet-a');
  });

  it('measures an unheld empty fleet as an alert, passing the measured legs to the projection unchanged', async () => {
    const counted = new Set<string>(['m-1']);
    const projectHeadcount = vi.fn<FleetStaffingReadDeps['projectHeadcount']>(() => headcount());
    const rows = await readLedFleetStaffing(
      INPUT,
      deps({
        liveMemberIds: async () => ['m-1', 'm-2'],
        countedMemberIds: async () => counted,
        governorFlagOn: async () => false,
        projectHeadcount,
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fleetSlug: 'fleet-a',
      evaluation: { alert: true, current: 0, target: 3, shortfall: 3, held: false },
    });
    expect(rows[0]!.unknownReason).toBeUndefined();
    const [, passedFleet, passedLive, passedCounted, passedFlag, passedWs] = projectHeadcount.mock.calls[0]!;
    expect(passedFleet.fleetSlug).toBe('fleet-a');
    expect(passedLive).toEqual(['m-1', 'm-2']);
    expect(passedCounted).toBe(counted);
    expect(passedFlag).toBe(false);
    expect(passedWs).toBe(INPUT.workspaceId);
  });

  it('reports a fleet at target as measured and not alerting', async () => {
    const rows = await readLedFleetStaffing(
      INPUT,
      deps({ projectHeadcount: () => headcount({ current: 3, shortfall: 0, underStrength: false }) }),
    );
    expect(rows[0]!.evaluation).toMatchObject({ alert: false, current: 3, target: 3 });
  });

  it('an unread live roster is UNKNOWN, never zero workers', async () => {
    const projectHeadcount = vi.fn(() => headcount());
    const rows = await readLedFleetStaffing(INPUT, deps({ liveMemberIds: async () => null, projectHeadcount }));
    expect(rows).toEqual([
      { fleetSlug: 'fleet-a', evaluation: null, unknownReason: 'the live roster could not be read' },
    ]);
    expect(projectHeadcount).not.toHaveBeenCalled();
  });

  it('an unread productive set is UNKNOWN, never zero workers', async () => {
    const rows = await readLedFleetStaffing(INPUT, deps({ countedMemberIds: async () => null }));
    expect(rows[0]).toMatchObject({
      evaluation: null,
      unknownReason: 'which live members are productive could not be read',
    });
  });

  it('an unmeasured projection is UNKNOWN', async () => {
    const rows = await readLedFleetStaffing(INPUT, deps({ projectHeadcount: () => headcount({ current: null }) }));
    expect(rows[0]).toMatchObject({ evaluation: null, unknownReason: 'productive headcount is unmeasured' });
  });

  it('a failing per-fleet leg degrades that fleet only', async () => {
    const rows = await readLedFleetStaffing(
      INPUT,
      deps({
        listFleetsLedBy: async () => [fleet('fleet-a'), fleet('fleet-b')],
        headcountTarget: async (_ws, slug) => {
          if (slug === 'fleet-b') throw new Error('profile read timed out');
          return null;
        },
      }),
    );
    expect(rows[0]!.evaluation).not.toBeNull();
    expect(rows[1]).toEqual({
      fleetSlug: 'fleet-b',
      evaluation: null,
      unknownReason: 'headcount read failed: profile read timed out',
    });
  });

  it('a failing governor-flag read reaches the projection as null, not a fabricated OFF', async () => {
    const projectHeadcount = vi.fn<FleetStaffingReadDeps['projectHeadcount']>(() => headcount());
    await readLedFleetStaffing(
      INPUT,
      deps({
        governorFlagOn: async () => {
          throw new Error('flags unavailable');
        },
        projectHeadcount,
      }),
    );
    expect(projectHeadcount.mock.calls[0]![4]).toBeNull();
  });

  it('bounds the fan-out to FLEET_STAFFING_MAX_FLEETS', async () => {
    const many = Array.from({ length: FLEET_STAFFING_MAX_FLEETS + 2 }, (_, i) => fleet(`fleet-${i}`));
    const rows = await readLedFleetStaffing(INPUT, deps({ listFleetsLedBy: async () => many }));
    expect(rows).toHaveLength(FLEET_STAFFING_MAX_FLEETS);
  });

  it('a failed fleet listing REJECTS, so the caller reports the source degraded instead of "leads nothing"', async () => {
    await expect(
      readLedFleetStaffing(
        INPUT,
        deps({
          listFleetsLedBy: async () => {
            throw new Error('registry down');
          },
        }),
      ),
    ).rejects.toThrow('registry down');
  });
});
