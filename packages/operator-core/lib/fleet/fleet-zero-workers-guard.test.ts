/**
 * P-005 / D-030 step 7: the fleet_zero_workers guard behind loop:checkpoint.
 * Refuses only on a fully MEASURED empty fleet; every unknown fails open.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FleetStaffingRow } from './fleet-staffing-read';
import type { FleetUnderStaffedEvaluation } from './under-staffed-alert';
import {
  FLEET_ZERO_WORKERS_REPAIRS,
  checkFleetZeroWorkers,
  decideFleetZeroWorkers,
  type FleetZeroWorkersGuardDeps,
} from './fleet-zero-workers-guard';

function evaluation(over: Partial<FleetUnderStaffedEvaluation> = {}): FleetUnderStaffedEvaluation {
  return {
    alert: true,
    current: 0,
    target: 2,
    shortfall: 2,
    held: false,
    notHeldBecause: 'supervise-not-granted',
    topUpRule: null,
    ...over,
  };
}

const row = (e: FleetUnderStaffedEvaluation | null, unknownReason?: string): FleetStaffingRow => ({
  fleetSlug: 'fleet-x',
  evaluation: e,
  ...(unknownReason ? { unknownReason } : {}),
});

describe('decideFleetZeroWorkers (P-005 / D-030 step 7)', () => {
  it('refuses a quiet wake on a measured empty fleet the monitor leads, naming the repairs', () => {
    const v = decideFleetZeroWorkers({ monitorDelta: false, fleetSlug: 'fleet-x', row: row(evaluation()) });
    expect(v.action).toBe('refuse');
    if (v.action !== 'refuse') throw new Error('unreachable');
    expect(v.fleetSlug).toBe('fleet-x');
    expect(v.repairs).toEqual(FLEET_ZERO_WORKERS_REPAIRS);
    expect(v.message).toContain('0 productive workers against target 2');
    expect(v.message).toContain('supervise-not-granted');
    expect(v.message).toContain('monitorDelta:true');
  });

  it('still refuses an empty fleet the governor holds, saying its relaunch is failing', () => {
    const v = decideFleetZeroWorkers({
      monitorDelta: false,
      fleetSlug: 'fleet-x',
      row: row(evaluation({ held: true, notHeldBecause: null })),
    });
    expect(v.action).toBe('refuse');
    if (v.action === 'refuse') expect(v.message).toContain('relaunch is failing');
  });

  it('allows a delta, a non-fleet monitor, a fleet no longer led, and a staffed fleet', () => {
    expect(decideFleetZeroWorkers({ monitorDelta: true, fleetSlug: 'fleet-x', row: row(evaluation()) })).toEqual({
      action: 'allow',
    });
    expect(decideFleetZeroWorkers({ monitorDelta: false, fleetSlug: null, row: null })).toEqual({ action: 'allow' });
    expect(decideFleetZeroWorkers({ monitorDelta: false, fleetSlug: 'fleet-x', row: null })).toEqual({
      action: 'allow',
    });
    expect(
      decideFleetZeroWorkers({
        monitorDelta: false,
        fleetSlug: 'fleet-x',
        row: row(evaluation({ current: 1, shortfall: 1 })),
      }),
    ).toEqual({ action: 'allow' });
  });

  it('fails OPEN with a warning when headcount is unmeasured: unknown is not zero', () => {
    const unmeasured = decideFleetZeroWorkers({
      monitorDelta: false,
      fleetSlug: 'fleet-x',
      row: row(null, 'the live roster could not be read'),
    });
    expect(unmeasured.action).toBe('allow');
    expect(unmeasured.action === 'allow' && unmeasured.warning).toContain('the live roster could not be read');
    const failed = decideFleetZeroWorkers({ monitorDelta: false, fleetSlug: 'fleet-x', row: 'unknown' });
    expect(failed.action === 'allow' && failed.warning).toContain('the staffing read failed');
    const noMonitorRead = decideFleetZeroWorkers({ monitorDelta: false, fleetSlug: 'unknown', row: null });
    expect(noMonitorRead.action === 'allow' && noMonitorRead.warning).toContain('could not be read');
  });
});

describe('checkFleetZeroWorkers (reads, then decides)', () => {
  const deps = (over: Partial<FleetZeroWorkersGuardDeps> = {}): FleetZeroWorkersGuardDeps => ({
    monitorFleet: async () => 'fleet-x',
    staffing: async () => row(evaluation()),
    ...over,
  });
  const input = { workspaceId: 'ws', ownerId: 'su-leader', monitorDelta: false };

  it('refuses end to end and measures only the monitored fleet', async () => {
    const staffing = vi.fn(async () => row(evaluation()));
    const v = await checkFleetZeroWorkers(input, deps({ staffing }));
    expect(v.action).toBe('refuse');
    expect(staffing).toHaveBeenCalledWith({ workspaceId: 'ws', ownerId: 'su-leader', fleetSlug: 'fleet-x' });
  });

  it('reads nothing for a delta', async () => {
    const monitorFleet = vi.fn(async () => 'fleet-x');
    expect(await checkFleetZeroWorkers({ ...input, monitorDelta: true }, deps({ monitorFleet }))).toEqual({
      action: 'allow',
    });
    expect(monitorFleet).not.toHaveBeenCalled();
  });

  it('does not measure staffing when the loop is not a fleet-leader monitor', async () => {
    const staffing = vi.fn(async () => row(evaluation()));
    expect(await checkFleetZeroWorkers(input, deps({ monitorFleet: async () => null, staffing }))).toEqual({
      action: 'allow',
    });
    expect(staffing).not.toHaveBeenCalled();
  });

  it('never throws: failed reads become fail-open warnings', async () => {
    const boom = async () => {
      throw new Error('db down');
    };
    const a = await checkFleetZeroWorkers(input, deps({ monitorFleet: boom }));
    expect(a.action).toBe('allow');
    expect(a.action === 'allow' && a.warning).toBeTruthy();
    const b = await checkFleetZeroWorkers(input, deps({ staffing: boom }));
    expect(b.action).toBe('allow');
    expect(b.action === 'allow' && b.warning).toContain('the staffing read failed');
  });
});
