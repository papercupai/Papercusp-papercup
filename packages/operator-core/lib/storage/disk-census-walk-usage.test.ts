/**
 * The disk consumer census reconciles each walk against statfs samples taken around that
 * walk, not against numbers resolved at the start of the pass
 * (disk-headroom-standing-reclaim-2026-10-12 P-001, R-1; WI-6554700010008933).
 *
 * Measured 2026-10-12: devices were resolved once and walked one after another, so the
 * second device's `used` was ~95 min older than its walk and `/mnt/data` moved +16.8 GB
 * in that window; `(unattributed)` absorbed the drift.
 */
import { describe, expect, it } from 'vitest';
import {
  CENSUS_USAGE_DRIFT_NOTE_BYTES,
  type CensusDevice,
  type CensusDeviceUsage,
  type CensusSql,
  type DuRun,
  reconcileWalkUsage,
  runDiskConsumerCensusOnce,
} from './disk-consumer-census';

const GIB = 1024 ** 3;

const resolved: CensusDevice = { device: '/mnt/x', majorMinor: '259:0', sizeBytes: 1000 * GIB, usedBytes: 500 * GIB, availBytes: 500 * GIB };
const usage = (usedGiB: number, availGiB = 1000 - usedGiB): CensusDeviceUsage => ({
  sizeBytes: 1000 * GIB,
  usedBytes: usedGiB * GIB,
  availBytes: availGiB * GIB,
});

describe('reconcileWalkUsage', () => {
  it('reconciles against the midpoint of the before/after samples and notes a drift of 1 GiB or more', () => {
    const { device, note } = reconcileWalkUsage(resolved, usage(600), usage(610));
    expect(device).toEqual({ ...resolved, usedBytes: 605 * GIB, availBytes: 390 * GIB });
    expect(note).toBe('used moved +10.0 GiB during the walk; reconciled against the midpoint');
  });

  it('reports a shrinking device with a minus sign', () => {
    expect(reconcileWalkUsage(resolved, usage(610), usage(600)).note).toBe(
      'used moved -10.0 GiB during the walk; reconciled against the midpoint',
    );
  });

  it('leaves no note when the device moved by less than the threshold', () => {
    const after = { ...usage(600), usedBytes: 600 * GIB + CENSUS_USAGE_DRIFT_NOTE_BYTES - 1 };
    expect(reconcileWalkUsage(resolved, usage(600), after).note).toBeNull();
  });

  it('uses the one sample it has, and the resolved numbers when it has none', () => {
    expect(reconcileWalkUsage(resolved, null, usage(620)).device.usedBytes).toBe(620 * GIB);
    expect(reconcileWalkUsage(resolved, usage(630), null).device.usedBytes).toBe(630 * GIB);
    expect(reconcileWalkUsage(resolved, null, null)).toEqual({ device: resolved, note: null });
  });
});

function fakeSql(): CensusSql {
  const sql = (async () => []) as unknown as CensusSql;
  (sql as { begin: CensusSql['begin'] }).begin = async (fn) => fn(sql);
  return sql;
}

function duRun(rootBytes: number): DuRun {
  return {
    summary: { consumers: [], ownFiles: [], rootBytes } as unknown as DuRun['summary'],
    deniedCount: 0,
    deniedSample: [],
    timedOut: false,
    exitCode: 0,
    privileged: true,
  };
}

describe('runDiskConsumerCensusOnce device usage', () => {
  const base = {
    sql: fakeSql(),
    host: 'walk-usage-test',
    devices: [resolved],
    measurePostgres: async () => null,
    measureDocker: async () => null,
    resolveSudo: async () => null,
    now: () => new Date('2026-10-12T21:00:00Z'),
  };

  it('samples statfs immediately before and after each walk and reconciles against the midpoint', async () => {
    const events: string[] = [];
    const samples = [usage(600), usage(620)];
    const result = await runDiskConsumerCensusOnce({
      ...base,
      statDevice: async (root) => {
        events.push(`stat ${root}`);
        return samples.shift()!;
      },
      runDu: async (root) => {
        events.push(`du ${root}`);
        return duRun(590 * GIB);
      },
    });
    expect(result.failures).toEqual([]);
    expect(events).toEqual(['stat /mnt/x', 'du /mnt/x', 'stat /mnt/x']);
    expect(result.runs[0]).toMatchObject({ usedBytes: 610 * GIB, attributedBytes: 590 * GIB, unattributedBytes: 20 * GIB });
    expect(result.runs[0]?.complete).toBe(true);
  });

  it('keeps the resolved numbers when statDevice is null', async () => {
    const result = await runDiskConsumerCensusOnce({ ...base, statDevice: null, runDu: async () => duRun(490 * GIB) });
    expect(result.runs[0]).toMatchObject({ usedBytes: 500 * GIB, unattributedBytes: 10 * GIB });
  });

  it.each([1, null])('marks a walk incomplete when du exits with status %s', async (exitCode) => {
    const result = await runDiskConsumerCensusOnce({
      ...base,
      statDevice: null,
      runDu: async () => ({ ...duRun(490 * GIB), exitCode }),
    });
    expect(result.failures).toEqual([]);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({ complete: false });
  });

  it('falls back to the resolved numbers when statfs fails around the walk', async () => {
    const result = await runDiskConsumerCensusOnce({
      ...base,
      statDevice: async () => {
        throw new Error('EACCES');
      },
      runDu: async () => duRun(495 * GIB),
    });
    expect(result.failures).toEqual([]);
    expect(result.runs[0]).toMatchObject({ usedBytes: 500 * GIB, unattributedBytes: 5 * GIB });
  });
});
