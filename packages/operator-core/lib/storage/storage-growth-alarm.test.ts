import { describe, it, expect, vi } from 'vitest';
vi.mock('../severe-event-broadcast', () => ({ broadcastSevereEvent: vi.fn(async () => true),
  broadcastSevereEventResolved: vi.fn(async () => true) }));
vi.mock('../agent-tools/coordination/tools/conditions', () => ({ readConditionEnvelopes: async () => [],
  readLatestConditionEnvelope: async () => null,
  computeConditionStates: () => [] }));
import {
  detectBreaches,
  detectUndeclaredGrowth,
  detectUndeclaredDiskGrowth,
  formatBreachToast,
  formatGrowthEscalation,
  formatUndeclaredToast,
  formatUndeclaredDiskToast,
  runStorageGrowthAlarmOnce as runStorageGrowthAlarmWithDefaults,
  runDiskHeadroomAlarmOnce,
  detectDiskHeadroom,
  detectDiskGrowthWarnings,
  assessNativeDiskHeadroomAlarm,
  formatDiskHeadroomToast,
  DISK_HEADROOM_FLOORS,
  categoryCeilingBytes,
  RETENTION_COVERED_ELSEWHERE,
  detectExemptSubsetGrowth,
  formatExemptSubsetToast,
  unprunedByDesignTables,
  EXEMPT_SUBSET_PROBES,
  NO_EPHEMERAL_SUBSET,
  NOT_AGE_PRUNABLE,
  RETENTION_WINDOWS,
  NO_ROW_AGE_WINDOW,
  detectRetentionLag,
  formatRetentionLagToast,
  type RetentionAgeReading,
  type StorageBreach,
  type TableSizeRow,
  type ExemptSubsetCount,
  type ExemptSubsetProbe,
  type ExemptSubsetGrowth,
} from './storage-growth-alarm';
import type { DiskEntry, DiskRootChildScan } from './disk';
import type { StorageUsageRow } from './usage';
import type { CensusDeviceView } from './disk-consumer-census';

const GIB = 1024 ** 3;

describe('native headroom acceptance evidence', () => {
  function fixture() {
    const now = Date.parse('2026-10-16T12:00:00Z');
    const devices: CensusDeviceView[] = ['/', '/mnt/data', '/mnt/cold-a', '/mnt/cold-b'].map(device => ({
      device, host: 'native-host', runId: `latest:${device}`, baselineRunId: `base:${device}`,
      producerBuildSha: 'build', baselineProducerBuildSha: 'build', truncatedByLimit: false,
      complete: true, stale: false, coverageGap: false, sizeBytes: 2e12, availBytes: 200e9,
      sampledAt: new Date(now - 60_000).toISOString(), baselineAt: new Date(now - 60_000 - 86400_000).toISOString(),
      baselineSizeBytes: 2e12, baselineAvailBytes: 300e9,
      consumers: [{ consumer: `${device}/grower`, kind: 'dir', depth: 1, bytes: 200e9,
        baselineBytes: 100e9, growth24hBytes: 100e9 }],
    }));
    const breaches = detectDiskHeadroom(devices), growth = detectDiskGrowthWarnings(devices);
    const notification = { id: '42', ...formatDiskHeadroomToast(breaches, growth) };
    const observation = { schemaVersion: 1, observedAt: new Date(now).toISOString(),
      runtime: { host: 'native-host', pid: 123, startedAt: new Date(now - 3600_000).toISOString(), buildSha: 'build' },
      floors: { ...DISK_HEADROOM_FLOORS }, horizonDays: 7, devices: structuredClone(devices),
      breaches, growth, projectionUnknown: [] as string[], notification: { ...notification } };
    const scope = { host: 'native-host', buildSha: 'build', now, hourlyCoverage: true };
    return { devices, notification, observation, scope };
  }
  const assess = (s: ReturnType<typeof fixture>) => assessNativeDiskHeadroomAlarm(s.observation, s.devices, s.notification, s.scope);
  it('recomputes exact native floors, forecast and top growers and matches the persisted notification', () => {
    expect(assess(fixture()).verdict).toBe('pass');
  });
  it.each(['host', 'build', 'producer', 'baseline-producer', 'legacy-producer', 'truncated', 'unknown-truncation', 'future', 'stale', 'coverage', 'device', 'duplicate', 'baseline', 'partial', 'attribution', 'run', 'notification'])(
    'refuses missing or mismatched %s evidence', missing => {
      const s = fixture();
      if (missing === 'host') s.observation.runtime.host = 'other';
      if (missing === 'build') s.observation.runtime.buildSha = 'other';
      if (missing === 'producer') s.devices[0]!.producerBuildSha = 'older-build';
      if (missing === 'baseline-producer') s.devices[0]!.baselineProducerBuildSha = 'older-build';
      if (missing === 'legacy-producer') delete s.devices[0]!.producerBuildSha;
      if (missing === 'truncated') s.devices[0]!.truncatedByLimit = true;
      if (missing === 'unknown-truncation') delete s.devices[0]!.truncatedByLimit;
      if (missing === 'future') s.scope.now -= 1;
      if (missing === 'stale') s.scope.now += 91 * 60_000;
      if (missing === 'coverage') s.scope.hourlyCoverage = false;
      if (missing === 'device') s.devices.pop();
      if (missing === 'duplicate') s.devices.push(s.devices[0]!);
      if (missing === 'baseline') s.devices[0]!.baselineRunId = null;
      if (missing === 'partial') s.devices[0]!.complete = false;
      if (missing === 'attribution') s.devices[0]!.coverageGap = true;
      if (missing === 'run') s.observation.devices[0]!.runId = 'unrelated';
      if (missing === 'notification') s.notification.id = 'missing';
      expect(assess(s).verdict).toBe('unknown');
    });
  it('ignores an unrelated unmeasured native device outside the four-volume population', () => {
    const s = fixture();
    s.devices.push({ device: '/mnt/unrelated', missing: true });
    expect(assess(s).verdict).toBe('pass');
  });
  it('verifies the same saved notification when native device query order changes', () => {
    const s = fixture();
    s.devices.reverse();
    expect(assess(s).verdict).toBe('pass');
  });
  it.each(['floor', 'forecast', 'grower', 'unknown'])( 'rejects a false native %s decision', wrong => {
    const s = fixture();
    if (wrong === 'floor') Object.assign(s.observation.floors, { rootBytes: 1 });
    if (wrong === 'forecast') s.observation.growth[0]!.daysToFull = 8;
    if (wrong === 'grower') s.observation.growth[0]!.topGrowers[0]!.consumer = '/invented';
    if (wrong === 'unknown') s.observation.projectionUnknown.push('/');
    expect(assess(s).verdict).toBe('fail');
  });
});

// Other alarm legs must not read the live host's census during unit tests.
function runStorageGrowthAlarmOnce(deps: Parameters<typeof runStorageGrowthAlarmWithDefaults>[0] = {}) {
  return runStorageGrowthAlarmWithDefaults({
    readDiskCensus: async () => [],
    // Unit tests must never fall through to defaultCountExemptSubsets(), which
    // opens the live org PG connection. Keep the exempt-table leg measured and
    // deterministic unless a test explicitly overrides it.
    countExemptSubsets: healthySubsetCounts,
    ...deps,
  });
}

describe('disk durable headroom (P-011 / R-9)', () => {
  const census = (over: Partial<CensusDeviceView> = {}): CensusDeviceView => ({
    device: '/', complete: true, stale: false, sizeBytes: 2e12, availBytes: 600e9,
    sampledAt: '2026-10-16T12:00:00Z', baselineAt: '2026-10-15T12:00:00Z',
    baselineSizeBytes: 2e12, baselineAvailBytes: 700e9,
    consumers: [
      { consumer: '/parent', kind: 'dir', depth: 1, bytes: 400e9, baselineBytes: 300e9, growth24hBytes: 100e9 },
      { consumer: '/parent/child', kind: 'dir', depth: 2, bytes: 400e9, baselineBytes: 300e9, growth24hBytes: 100e9 },
    ], ...over,
  });

  it('alarms at the decimal root/data floors and both real cold-tier mount names; equality passes', () => {
    const bad = [census({ availBytes: 250e9 - 1 }), census({ device: '/mnt/data', availBytes: 1e12 - 1 }),
      census({ device: '/mnt/cold-a', availBytes: 400e9 - 1 }), census({ device: '/mnt/cold-b', availBytes: 400e9 - 1 })];
    expect(detectDiskHeadroom(bad).map(b => b.device)).toEqual(['/', '/mnt/data', '/mnt/cold-a', '/mnt/cold-b']);
    expect(detectDiskHeadroom([census({ availBytes: 250e9 }), census({ device: '/mnt/data', availBytes: 1e12 }),
      census({ device: '/mnt/cold-a', availBytes: 400e9 })])).toEqual([]);
  });

  it('projects total free-space consumption and names top growers without summing nested paths', () => {
    const warning = detectDiskGrowthWarnings([census()]);
    expect(warning).toHaveLength(1);
    expect(warning[0]).toMatchObject({ device: '/', daysToFull: 6, growthBytesPerDay: 100e9,
      topGrowers: [{ consumer: '/parent', growthBytes: 100e9 }, { consumer: '/parent/child', growthBytes: 100e9 }] });
    // No alarm at 7 days; counting the nested directories twice would produce 3.5d.
    expect(detectDiskGrowthWarnings([census({ availBytes: 700e9, baselineAvailBytes: 800e9 })])).toEqual([]);
    expect(detectDiskGrowthWarnings([census({ availBytes: 600e9, baselineAvailBytes: 600e9 })])).toEqual([]);
    expect(detectDiskGrowthWarnings([census({ baselineAvailBytes: 500e9 })])).toEqual([]);
  });

  it('uses actual elapsed time and detects a full filesystem independently of consumer availability', () => {
    expect(detectDiskGrowthWarnings([census({ baselineAt: '2026-10-15T18:00:00Z', consumers: [] })])[0]!.daysToFull).toBe(4.5);
    expect(detectDiskGrowthWarnings([census({ availBytes: 0 })])[0]!.daysToFull).toBe(0);
  });

  it('keeps unmeasured, stale, resized and non-comparable histories unknown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const change of [{ missing: true }, { stale: true }, { complete: false }, { complete: undefined },
      { baselineAvailBytes: null }, { baselineAt: null }, { baselineSizeBytes: 3e12 },
      { baselineAt: '2026-10-16T13:00:00Z' }, { baselineAt: '2026-10-10T12:00:00Z' }]) {
      expect(detectDiskGrowthWarnings([census(change as Partial<CensusDeviceView>)])).toEqual([]);
    }
    const emitToast = vi.fn(async () => {});
    const result = await runDiskHeadroomAlarmOnce({ readDiskCensus: async () => [census({ missing: true })], emitToast });
    expect(result.diskProjectionUnknown).toEqual(['/']); expect(emitToast).not.toHaveBeenCalled();
    expect((await runDiskHeadroomAlarmOnce({ readDiskCensus: async () => { throw new Error('read failed'); }, emitToast })).diskProjectionUnknown)
      .toEqual(['census read failed']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk headroom projection skipped (UNKNOWN'));
  });

  it('emits the new warning even when the independent category scan fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emitToast = vi.fn(async (_toast: { level: string; message: string; description: string }) => {});
    const result = await runStorageGrowthAlarmOnce({ computeUsage: async () => { throw new Error('category unavailable'); },
      listTableSizes: async () => [], listDiskRootChildren: emptyDiskScan, countExemptSubsets: async () => [],
      readRetentionAges: healthyRetentionAges, readDiskCensus: async () => [census({ availBytes: 200e9, baselineAvailBytes: 300e9 })], emitToast });
    expect(result.diskHeadroom).toHaveLength(1); expect(result.diskGrowth).toHaveLength(1);
    expect(emitToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Disk headroom alarm'),
      description: expect.stringContaining('full in 2.0d') }), expect.objectContaining({ schemaVersion: 1 }));
    expect(emitToast.mock.calls.some(([t]) => t.description.includes('/parent/child'))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('usage scan skipped'));
  });

  it('binds the alarm decision to saved census identities and retains unknown inputs', async () => {
    const emitToast = vi.fn(async () => {});
    const devices = [census({ host: 'saved-host', runId: 'latest', baselineRunId: 'baseline' }),
      census({ device: '/mnt/cold-b', missing: true, host: undefined, runId: undefined, baselineRunId: null })];
    await runDiskHeadroomAlarmOnce({ readDiskCensus: async () => devices, emitToast });
    expect(emitToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Disk headroom alarm') }),
      expect.objectContaining({ schemaVersion: 1, devices,
        projectionUnknown: ['/mnt/cold-b'], horizonDays: 7,
        runtime: expect.objectContaining({ pid: process.pid }),
        growth: [expect.objectContaining({ device: '/', daysToFull: 6 })] }));
  });

  it('does not report an emitted alarm when notification persistence fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runDiskHeadroomAlarmOnce({ readDiskCensus: async () => [census()],
      emitToast: async () => { throw new Error('notification refused'); } });
    expect(result.diskGrowth).toEqual([]);
    expect(result.diskProjectionUnknown).toEqual(['census read failed']);
  });
});

/** Keep legacy alarm-leg tests independent from the host filesystem. */
const emptyDiskScan = async (_registeredPaths: readonly string[]): Promise<DiskRootChildScan> => ({
  entries: [],
  truncated: false,
});

/** Keep the other legs' tests independent of the retention-lag leg: every window
 *  measured, every table freshly pruned. */
const healthyRetentionAges = async (): Promise<RetentionAgeReading[]> =>
  RETENTION_WINDOWS.map((w) => ({ table: w.table, measured: true, oldestAgeDays: 0 }));

function pgRow(id: string, gb: number, extra: Partial<StorageUsageRow> = {}): StorageUsageRow {
  return {
    id,
    label: id.replace(/-/g, ' '),
    kind: 'pg',
    federation: 'local-diagnostic',
    trimmable: true,
    bloats: false,
    totalBytes: Math.round(gb * GIB),
    totalRows: 1,
    ageBuckets: [],
    description: 'test',
    ...extra,
  };
}

describe('categoryCeilingBytes', () => {
  it('uses workload-specific ceilings without widening the general 10 GiB limit', () => {
    expect(categoryCeilingBytes('decision-ledger')).toBe(10 * GIB);
    expect(categoryCeilingBytes('substrate-outbox')).toBe(3 * GIB);
    expect(categoryCeilingBytes('tool-invocations')).toBe(48 * GIB);
  });
});

describe('detectBreaches', () => {
  it('flags PG categories strictly over their ceiling, leaves under-ceiling alone', () => {
    const breaches = detectBreaches([
      pgRow('decision-ledger', 12), // > 10 GiB default → breach
      pgRow('agent-activity', 6), //   < 10 GiB → ok
      pgRow('substrate-outbox', 4), // > 3 GiB outbox ceiling → breach
      pgRow('tool-invocations', 22.3), // 14-day history is below its measured-workload ceiling
    ]);
    expect(breaches.map((b) => b.id).sort()).toEqual(['decision-ledger', 'substrate-outbox']);
  });

  it('still flags tool-invocations above its 48 GiB retained-history ceiling', () => {
    expect(detectBreaches([pgRow('tool-invocations', 48)])).toEqual([]);
    expect(detectBreaches([pgRow('tool-invocations', 48.1)]).map((b) => b.id)).toEqual(['tool-invocations']);
  });

  it('does NOT flag the substrate-outbox queue while it is small (the EI-126 guard, pre-runaway)', () => {
    expect(detectBreaches([pgRow('substrate-outbox', 2)])).toEqual([]);
  });

  it('ignores non-PG (disk) categories — the guarded runaway class is a Postgres table', () => {
    const huge = pgRow('scratch', 999, { kind: 'disk' });
    expect(detectBreaches([huge])).toEqual([]);
  });

  it('does not treat an unavailable PG size as a measured zero or breach', () => {
    const unavailable = pgRow('decision-ledger', 0, { totalBytes: null });
    expect(detectBreaches([unavailable])).toEqual([]);
  });
});

describe('formatBreachToast', () => {
  it('produces a warning toast naming each over-ceiling table', () => {
    const breaches: StorageBreach[] = [
      { id: 'substrate-outbox', label: 'Substrate outbox', bytes: 5 * GIB, ceilingBytes: 3 * GIB, trimmable: true },
    ];
    const t = formatBreachToast(breaches);
    expect(t.level).toBe('warning');
    expect(t.message).toContain('1 table(s)');
    expect(t.description).toContain('Substrate outbox (substrate-outbox)');
    expect(t.description).toContain('5.0 GiB');
    expect(t.description).toContain('3.0 GiB ceiling');
  });
});

describe('formatGrowthEscalation', () => {
  it('names the largest explicit ceiling breach and gives an action', () => {
    const t = formatGrowthEscalation([
      { id: 'small', label: 'Small', bytes: 4 * GIB, ceilingBytes: 3 * GIB, trimmable: true },
      { id: 'large', label: 'Large', bytes: 12 * GIB, ceilingBytes: 10 * GIB, trimmable: false },
    ]);
    expect(t.title).toBe('Storage growth critical');
    expect(t.body).toContain('Large (large)');
    expect(t.body).toContain('Investigate the read-only/federated retention path');
  });
});

describe('runStorageGrowthAlarmOnce', () => {
  it('emits exactly one toast when a category breaches, and returns the breaches', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => [pgRow('decision-ledger', 12), pgRow('agent-activity', 1)],
      emitToast,
      // Isolate the CATEGORY leg: the undeclared sweep is a second, independent
      // leg with its own tests below. Without this it would hit a live catalog
      // and the host filesystem.
      listTableSizes: async () => [],
      listDiskRootChildren: emptyDiskScan,
      readRetentionAges: healthyRetentionAges,
      escalate: async () => {},
      recentlyEscalated: async () => false,
    });
    expect(res.checked).toBe(2);
    expect(res.breaches.map((b) => b.id)).toEqual(['decision-ledger']);
    expect(emitToast).toHaveBeenCalledTimes(1);
    expect(emitToast.mock.calls[0][0].level).toBe('warning');
  });

  it('escalates an explicit category ceiling breach once', async () => {
    const escalate = vi.fn(async (_t: { title: string; body: string }) => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => [pgRow('substrate-outbox', 4)],
      emitToast: async () => {},
      listTableSizes: async () => [],
      listDiskRootChildren: emptyDiskScan,
      readRetentionAges: healthyRetentionAges,
      escalate,
      recentlyEscalated: async () => false,
    });
    expect(res.breaches).toHaveLength(1);
    expect(escalate).toHaveBeenCalledWith(expect.objectContaining({ title: 'Storage growth critical' }));
  });

  it('emits NO toast when every category is under its ceiling', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => [pgRow('decision-ledger', 1), pgRow('substrate-outbox', 1)],
      emitToast,
      listTableSizes: async () => [],
      listDiskRootChildren: emptyDiskScan,
      readRetentionAges: healthyRetentionAges,
    });
    expect(res.breaches).toEqual([]);
    expect(emitToast).not.toHaveBeenCalled();
  });
});

// ── The undeclared sweep ────────────────────────────────────────────────────
// Regression guard for the blind spot: the category-ceiling alarm walks
// STORAGE_CATEGORIES, so a table nobody registered produces no row and can
// never breach AT ANY SIZE — an alarm whose job is catching unwatched growth
// was itself scoped to the watched set.

const MB = 1024 * 1024;
function tbl(table: string, mb: number, rows = 1000): TableSizeRow {
  return { table, totalBytes: mb * MB, rows };
}

function diskEntry(path: string, mb: number): DiskEntry {
  return { path, mtimeMs: 0, sizeBytes: mb * MB };
}

describe('detectUndeclaredDiskGrowth', () => {
  it('flags an over-floor unregistered child and sorts the largest first', () => {
    const result = detectUndeclaredDiskGrowth(
      [diskEntry('/papercusp/small', 200), diskEntry('/papercusp/big', 900)],
      [],
      128 * MB,
    );
    expect(result.undeclared.map((entry) => entry.path)).toEqual(['/papercusp/big', '/papercusp/small']);
    expect(result.incomplete).toBe(false);
  });

  it('does not flag a registered path or any registered descendant, however large', () => {
    const result = detectUndeclaredDiskGrowth(
      [diskEntry('/papercusp/owned', 9_000), diskEntry('/papercusp/owned/nested', 9_000)],
      ['/papercusp/owned'],
      128 * MB,
    );
    expect(result.undeclared).toEqual([]);
  });

  it('deduplicates overlapping snapshots and exposes a truncated walk as incomplete', () => {
    const result = detectUndeclaredDiskGrowth(
      [diskEntry('/papercusp/unknown', 500), diskEntry('/papercusp/unknown', 500)],
      [],
      128 * MB,
      true,
    );
    expect(result.undeclared).toHaveLength(1);
    expect(result.incomplete).toBe(true);
  });
});

describe('formatUndeclaredDiskToast', () => {
  it('names offenders and says a partial result is UNKNOWN, not healthy', () => {
    const toast = formatUndeclaredDiskToast(
      [diskEntry('/papercusp/unknown', 500)].map((entry) => ({
        path: entry.path,
        bytes: entry.sizeBytes,
        floorBytes: 128 * MB,
      })),
      true,
    );
    expect(toast.message).toContain('1 unowned disk entry');
    expect(toast.description).toContain('/papercusp/unknown');
    expect(toast.description).toContain('UNKNOWN, not healthy');
  });
});

describe('runStorageGrowthAlarmOnce — disk undeclared leg', () => {
  it('runs the injected disk sweep and reports its offenders independently', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const scanDiskRootChildren = vi.fn(
      async (_registeredPaths: readonly string[]): Promise<DiskRootChildScan> => ({
        entries: [diskEntry('/papercusp/unowned', 900)],
        truncated: false,
      }),
    );
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => [],
      listTableSizes: async () => [],
      listDiskRootChildren: scanDiskRootChildren,
      readRetentionAges: healthyRetentionAges,
      emitToast,
      countExemptSubsets: healthySubsetCounts,
    });

    expect(scanDiskRootChildren).toHaveBeenCalledOnce();
    expect(res.undeclaredDisk.map((entry) => entry.path)).toEqual(['/papercusp/unowned']);
    expect(res.diskScanIncomplete).toBe(false);
    expect(emitToast).toHaveBeenCalledTimes(1);
    expect(emitToast.mock.calls[0][0].description).toContain('/papercusp/unowned');
  });

  it('emits an UNKNOWN toast when the bounded disk walk is incomplete', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => [],
      listTableSizes: async () => [],
      listDiskRootChildren: async () => ({ entries: [], truncated: true }),
      readRetentionAges: healthyRetentionAges,
      emitToast,
      countExemptSubsets: healthySubsetCounts,
    });

    expect(res.undeclaredDisk).toEqual([]);
    expect(res.diskScanIncomplete).toBe(true);
    expect(emitToast).toHaveBeenCalledTimes(1);
    expect(emitToast.mock.calls[0][0].message).toContain('incomplete');
    expect(emitToast.mock.calls[0][0].description).toContain('UNKNOWN, not healthy');
  });
});

/** A real declared category table (storage/categories.ts) — the covered control. */
const DECLARED = ['tool_invocations', 'route_invocations', 'agent_activity'];

describe('detectUndeclaredGrowth', () => {
  it('flags an over-floor table that carries no retention decision', () => {
    // pot_throughput_ticks, measured live 2026-08-03: 167 MB / 410,510 rows,
    // no storage category and zero DELETE sites anywhere in the tree.
    const { undeclared } = detectUndeclaredGrowth([tbl('pot_throughput_ticks', 167, 410_510)], DECLARED, 128 * MB);
    expect(undeclared.map((u) => u.table)).toEqual(['pot_throughput_ticks']);
    expect(undeclared[0].rows).toBe(410_510);
  });

  it('THE BLIND SPOT: a huge undeclared table yields zero category breaches but IS swept', () => {
    // The falsifiability control — it fails if the two legs are ever collapsed
    // into one. detectBreaches cannot see this table at ANY size because it is
    // not a category; only the catalog sweep can.
    const huge = tbl('pot_throughput_ticks', 500_000, 9_000_000); // ~488 GB
    expect(detectBreaches([])).toEqual([]);
    expect(detectUndeclaredGrowth([huge], DECLARED, 128 * MB).undeclared).toHaveLength(1);
  });

  it('does NOT flag a declared category table, however large', () => {
    const { undeclared } = detectUndeclaredGrowth([tbl('tool_invocations', 2313)], DECLARED, 128 * MB);
    expect(undeclared).toEqual([]);
  });

  it('does NOT flag a table whose retention lives in a bespoke GC actor', () => {
    // operator_turns is pruned by operator-turns-gc.ts, not by a category —
    // without RETENTION_COVERED_ELSEWHERE this would be a false "nothing prunes this".
    expect(RETENTION_COVERED_ELSEWHERE).toHaveProperty('operator_turns');
    const { undeclared } = detectUndeclaredGrowth([tbl('operator_turns', 337)], DECLARED, 128 * MB);
    expect(undeclared).toEqual([]);
  });

  it('surfaces thread-post growth without borrowing the message-log retention decision', () => {
    // message-log-gc deletes coord_event_log messages, not their canonical posts.
    // Its verified retention cannot suppress an unrelated table's policy gap.
    const { undeclared } = detectUndeclaredGrowth(
      [tbl('coord_thread_posts', 512), tbl('coord_event_log', 512)],
      [...DECLARED, 'coord_event_log'],
      128 * MB,
    );
    expect(undeclared.map((entry) => entry.table)).toEqual(['coord_thread_posts']);
    expect(undeclared[0].bytes).toBe(512 * MB);
  });

  it('does NOT flag the four measured session archive/index tables with verified retention owners', () => {
    const sessionTables = [
      tbl('session_archive_files', 7_000),
      tbl('session_turns', 5_000),
      tbl('session_turn_chunks', 2_600),
      tbl('session_turn_parts', 800),
    ];
    const { undeclared } = detectUndeclaredGrowth(sessionTables, DECLARED, 128 * MB);

    expect(undeclared).toEqual([]);
    expect(RETENTION_COVERED_ELSEWHERE.session_archive_files).toContain('session-archive.ts');
    expect(RETENTION_COVERED_ELSEWHERE.session_turns).toContain('RETENTION_DAYS=45');
    expect(RETENTION_COVERED_ELSEWHERE.session_turn_parts).toContain('PART_RETENTION_DAYS=14');
    expect(RETENTION_COVERED_ELSEWHERE.session_turn_chunks).toContain('migration 749');
  });

  it('does NOT flag an undeclared table under the floor', () => {
    const { undeclared } = detectUndeclaredGrowth([tbl('scout_ticks', 2)], DECLARED, 128 * MB);
    expect(undeclared).toEqual([]);
  });

  it('skips frozen bak_* pre-migration snapshots structurally', () => {
    const { undeclared } = detectUndeclaredGrowth([tbl('bak_20260713_compound_vecs', 900)], DECLARED, 128 * MB);
    expect(undeclared).toEqual([]);
  });

  it('sorts the biggest offender first', () => {
    const { undeclared } = detectUndeclaredGrowth(
      [tbl('small_one', 200), tbl('big_one', 900), tbl('mid_one', 400)],
      DECLARED,
      128 * MB,
    );
    expect(undeclared.map((u) => u.table)).toEqual(['big_one', 'mid_one', 'small_one']);
  });

  it('treats an EMPTY catalog as unknown, not as "every covered table was dropped"', () => {
    // Regression guard: deriving staleness from an empty scan named the whole
    // coverage map as rot and fired a confident, entirely false alarm.
    const { undeclared, staleCovered } = detectUndeclaredGrowth([], DECLARED, 128 * MB);
    expect(undeclared).toEqual([]);
    expect(staleCovered).toEqual([]);
  });

  it('flags a coverage-map entry that names no live table, so the map cannot rot', () => {
    const { staleCovered } = detectUndeclaredGrowth([tbl('pot_throughput_ticks', 167)], DECLARED, 128 * MB);
    // Every RETENTION_COVERED_ELSEWHERE key is absent from this one-row catalog.
    expect(staleCovered).toEqual(Object.keys(RETENTION_COVERED_ELSEWHERE).sort());
  });
});

describe('formatUndeclaredToast', () => {
  it('names each unowned table in ONE toast, not one toast per table', () => {
    const { undeclared } = detectUndeclaredGrowth(
      [tbl('pot_throughput_ticks', 167, 410_510), tbl('memory_recall_stats', 91, 117_828)],
      DECLARED,
      64 * MB,
    );
    const t = formatUndeclaredToast(undeclared, []);
    expect(t.level).toBe('warning');
    expect(t.message).toContain('2 unowned table(s)');
    expect(t.description).toContain('harness_shared.pot_throughput_ticks');
    expect(t.description).toContain('harness_shared.memory_recall_stats');
    // Says what it does NOT mean — an unowned table is an unrecorded decision,
    // not a proven-unpruned one.
    expect(t.description).toContain('not an accusation');
  });

  it('reports a stale coverage map even when nothing is over the floor', () => {
    const t = formatUndeclaredToast([], ['renamed_table']);
    expect(t.message).toContain('stale');
    expect(t.description).toContain('renamed_table');
  });
});

describe('runStorageGrowthAlarmOnce — undeclared leg', () => {
  it('sweeps the catalog even when the category usage scan throws', async () => {
    // The category path IS the blind spot, so its failure must not also blind
    // the catalog sweep.
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => {
        throw new Error('usage scan down');
      },
      emitToast,
      listTableSizes: async () => [tbl('pot_throughput_ticks', 900, 410_510)],
      listDiskRootChildren: emptyDiskScan,
      readRetentionAges: healthyRetentionAges,
      countExemptSubsets: healthySubsetCounts,
    });
    // The category leg degrades loudly but non-fatally...
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('usage scan skipped'));
    warn.mockRestore();
    // ...and the catalog sweep still ran.
    expect(res.breaches).toEqual([]);
    expect(res.undeclared.map((u) => u.table)).toEqual(['pot_throughput_ticks']);
    expect(emitToast).toHaveBeenCalledTimes(1);
  });

  it('emits no undeclared toast when every table is declared or under the floor', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => [],
      emitToast,
      listTableSizes: async () => [
        tbl('tool_invocations', 2313),
        ...Object.keys(RETENTION_COVERED_ELSEWHERE).map((t) => tbl(t, 1)),
      ],
      listDiskRootChildren: emptyDiskScan,
      readRetentionAges: healthyRetentionAges,
      countExemptSubsets: healthySubsetCounts,
    });
    expect(res.undeclared).toEqual([]);
    expect(emitToast).not.toHaveBeenCalled();
  });
});

/* ───────────────── THE THIRD LEG — exempt-subset growth (WI-936229) ─────────────────
 *
 * The motivating incident: ~776k ephemeral resource-governor admission receipts
 * accumulated inside `harness_shared.work_items` in two days (measured
 * 2026-08-29, +429/min) while BOTH existing legs reported nothing — leg 1
 * because work_items is not a registered storage category, leg 2 because it
 * carries a retention exemption. A table that is unregistered AND exempt was
 * invisible to this alarm at any size.
 */

/** Every declared probe, measured and comfortably under its ceiling. */
function healthySubsetCounts(): Promise<ExemptSubsetCount[]> {
  return Promise.resolve(EXEMPT_SUBSET_PROBES.map((p) => ({ table: p.table, subset: p.subset, rows: 0 })));
}

function count(table: string, subset: string, rows: number | null): ExemptSubsetCount {
  return { table, subset, rows };
}

const PROBE: ExemptSubsetProbe = {
  table: 'work_items',
  subset: 'test receipts',
  predicateSql: `payload ? 'test'`,
  rowCeiling: 100,
  why: 'receipts are not work',
};

describe('detectExemptSubsetGrowth', () => {
  it('flags a subset strictly over its ceiling and leaves an under-ceiling one alone', () => {
    const over = detectExemptSubsetGrowth([count('work_items', 'test receipts', 101)], [PROBE]);
    expect(over.over.map((o) => o.rows)).toEqual([101]);
    expect(over.unknown).toEqual([]);

    const under = detectExemptSubsetGrowth([count('work_items', 'test receipts', 100)], [PROBE]);
    expect(under.over).toEqual([]);
    expect(under.unknown).toEqual([]);
  });

  it('catches the real incident shape: a huge ephemeral subset inside an EXEMPT, UNREGISTERED table', () => {
    // 776,382 receipts in work_items — the exact population both other legs missed.
    const res = detectExemptSubsetGrowth(
      [count('work_items', 'resource-governor admission receipts', 776_382)],
      EXEMPT_SUBSET_PROBES,
    );
    expect(res.over).toHaveLength(1);
    expect(res.over[0].table).toBe('work_items');
    expect(res.over[0].rows).toBe(776_382);
    // ...and the table really is exempt, which is WHY leg 2 cannot see it.
    expect(RETENTION_COVERED_ELSEWHERE.work_items).toContain(NOT_AGE_PRUNABLE);
  });

  it('reports a FAILED count as unknown, never as zero — an unmeasured subset must not read as healthy', () => {
    const res = detectExemptSubsetGrowth([count('work_items', 'test receipts', null)], [PROBE]);
    expect(res.over).toEqual([]);
    expect(res.unknown).toEqual(['work_items/test receipts']);
  });

  it('reports a probe with NO count row at all as unknown, rather than silently dropping it', () => {
    const res = detectExemptSubsetGrowth([], [PROBE]);
    expect(res.unknown).toEqual(['work_items/test receipts']);
  });

  it('sorts the over-ceiling set largest-first so the worst offender leads the toast', () => {
    const probes: ExemptSubsetProbe[] = [
      { ...PROBE, subset: 'small' },
      { ...PROBE, subset: 'large' },
    ];
    const res = detectExemptSubsetGrowth(
      [count('work_items', 'small', 500), count('work_items', 'large', 900_000)],
      probes,
    );
    expect(res.over.map((o) => o.subset)).toEqual(['large', 'small']);
  });
});

describe('EXEMPT_SUBSET_PROBES registry integrity — the recurrence guard', () => {
  it('every unpruned-by-design exemption declares its ephemeral subset, or declares that it has none', () => {
    // THIS is the guard for the class. Adding a new blanket "nothing prunes
    // this" exemption without answering "what ephemeral rows land in here?"
    // fails right here, which is the question nobody asked about work_items.
    const probed = new Set(EXEMPT_SUBSET_PROBES.map((p) => p.table));
    const unanswered = unprunedByDesignTables().filter((t) => !probed.has(t) && !(t in NO_EPHEMERAL_SUBSET));
    expect(
      unanswered,
      `${unanswered.join(', ')} is declared "${NOT_AGE_PRUNABLE}" but names neither an EXEMPT_SUBSET_PROBES ` +
        `entry nor a NO_EPHEMERAL_SUBSET reason. A table nothing prunes needs an explicit answer to ` +
        `"which rows in here are not the canonical population?" — work_items had none, and 776k receipt ` +
        `rows accumulated unseen.`,
    ).toEqual([]);
  });

  it('pins the motivating case: work_items is exempt AND carries a receipt probe', () => {
    expect(unprunedByDesignTables()).toContain('work_items');
    const probe = EXEMPT_SUBSET_PROBES.find((p) => p.table === 'work_items');
    expect(probe, 'the resource-governor receipt probe must survive refactors').toBeTruthy();
    expect(probe!.predicateSql).toContain('resource_governor');
    expect(probe!.rowCeiling).toBeGreaterThan(0);
  });

  it('every probe targets a table that is actually EXEMPT — otherwise leg 2 already covers it', () => {
    for (const p of EXEMPT_SUBSET_PROBES) {
      expect(
        p.table in RETENTION_COVERED_ELSEWHERE,
        `probe ${p.table}/${p.subset} targets a table with no exemption — the undeclared leg already sweeps it`,
      ).toBe(true);
    }
  });

  it('no table is BOTH probed and declared subset-free — that is a contradiction, not a belt-and-braces', () => {
    for (const p of EXEMPT_SUBSET_PROBES) {
      expect(p.table in NO_EPHEMERAL_SUBSET, `${p.table} both has a probe and claims no ephemeral subset`).toBe(false);
    }
  });

  it('unprunedByDesignTables derives from the map text, so a reworded exemption cannot escape the guard', () => {
    expect(
      unprunedByDesignTables({
        some_table: `canonical thing — ${NOT_AGE_PRUNABLE}`,
        other_table: 'pruned by something-gc.ts',
      }),
    ).toEqual(['some_table']);
  });
});

describe('detectExemptSubsetGrowth falsifiability control', () => {
  // A PERMANENT wrong implementation, kept in-tree per the repo's mutation
  // discipline (never mutate the shared tree to prove a guard can fail). This
  // is the pre-fix behaviour: a table-level exemption answers for every row.
  function blanketExemptionOnly(
    counts: readonly ExemptSubsetCount[],
    _probes: readonly ExemptSubsetProbe[],
  ): { over: ExemptSubsetGrowth[]; unknown: string[] } {
    // The old world: work_items is exempt, so nothing inside it is ever reported.
    void counts;
    return { over: [], unknown: [] };
  }

  const incident = [count('work_items', 'resource-governor admission receipts', 776_382)];

  it('the CONTROL misses the incident (this is what shipped, and why it went unseen for two days)', () => {
    expect(blanketExemptionOnly(incident, EXEMPT_SUBSET_PROBES).over).toEqual([]);
  });

  it('the REAL implementation catches it — so this suite can distinguish the two', () => {
    expect(detectExemptSubsetGrowth(incident, EXEMPT_SUBSET_PROBES).over).toHaveLength(1);
  });

  it('CALIBRATION: both agree that a healthy subset is silent, so the split above is the defect, not noise', () => {
    const healthy = [count('work_items', 'resource-governor admission receipts', 12)];
    expect(blanketExemptionOnly(healthy, EXEMPT_SUBSET_PROBES).over).toEqual([]);
    expect(detectExemptSubsetGrowth(healthy, EXEMPT_SUBSET_PROBES).over).toEqual([]);
  });
});

describe('formatExemptSubsetToast', () => {
  it('names the table, the subset, the count, the ceiling and WHY the exemption does not cover it', () => {
    const t = formatExemptSubsetToast([
      {
        table: 'work_items',
        subset: 'resource-governor admission receipts',
        rows: 776_382,
        rowCeiling: 50_000,
        why: 'receipts are queue telemetry, not work',
      },
    ]);
    expect(t.level).toBe('warning');
    expect(t.message).toContain('1 ephemeral subset(s)');
    expect(t.description).toContain('harness_shared.work_items');
    expect(t.description).toContain('776,382 rows');
    expect(t.description).toContain('50,000 ceiling');
    expect(t.description).toContain('receipts are queue telemetry, not work');
  });

  it('says UNMEASURED out loud when a probe could not be counted, rather than implying health', () => {
    const t = formatExemptSubsetToast([], ['work_items/resource-governor admission receipts']);
    expect(t.message).toContain('incomplete');
    expect(t.description).toContain('UNKNOWN');
    expect(t.description).toContain('not as healthy');
  });
});

describe('runStorageGrowthAlarmOnce — exempt-subset leg', () => {
  it('runs even when BOTH other legs throw — it is blind to this class by construction', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => {
        throw new Error('usage scan down');
      },
      listTableSizes: async () => {
        throw new Error('catalog scan down');
      },
      listDiskRootChildren: emptyDiskScan,
      readRetentionAges: healthyRetentionAges,
      emitToast,
      countExemptSubsets: async () => [count('work_items', 'resource-governor admission receipts', 776_382)],
    });
    warn.mockRestore();
    expect(res.exemptSubsets.map((o) => o.rows)).toEqual([776_382]);
    expect(emitToast).toHaveBeenCalledTimes(1);
    expect(emitToast.mock.calls[0][0].description).toContain('resource-governor admission receipts');
  });

  it('stays silent when every declared subset is measured and under its ceiling', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => [],
      listTableSizes: async () => [],
      listDiskRootChildren: emptyDiskScan,
      readRetentionAges: healthyRetentionAges,
      emitToast,
      countExemptSubsets: healthySubsetCounts,
    });
    expect(res.exemptSubsets).toEqual([]);
    expect(res.exemptUnknown).toEqual([]);
    expect(emitToast).not.toHaveBeenCalled();
  });

  it('toasts when a subset cannot be measured — a hole in the guard is reported, not swallowed', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => [],
      listTableSizes: async () => [],
      listDiskRootChildren: emptyDiskScan,
      readRetentionAges: healthyRetentionAges,
      emitToast,
      countExemptSubsets: async () => [count('work_items', 'resource-governor admission receipts', null)],
    });
    expect(res.exemptUnknown).toEqual(['work_items/resource-governor admission receipts']);
    expect(emitToast).toHaveBeenCalledTimes(1);
  });

  it('a throwing counter degrades loudly and non-fatally, leaving the other legs intact', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runStorageGrowthAlarmOnce({
      computeUsage: async () => [],
      listTableSizes: async () => [],
      listDiskRootChildren: emptyDiskScan,
      readRetentionAges: healthyRetentionAges,
      emitToast,
      countExemptSubsets: async () => {
        throw new Error('subset count down');
      },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exempt-subset sweep skipped'));
    warn.mockRestore();
    expect(res.exemptSubsets).toEqual([]);
    expect(emitToast).not.toHaveBeenCalled();
  });
});

// ── The retention-lag leg (WI-6554700010009732) ─────────────────────────────
// Regression guard for the blind spot: RETENTION_COVERED_ELSEWHERE recorded that
// session_turn_parts was pruned at 14 days while its oldest row was 41.7 days old,
// and every other leg read the table as covered.

function age(table: string, oldestAgeDays: number | null, measured = true): RetentionAgeReading {
  return { table, measured, oldestAgeDays };
}
const WINDOW = RETENTION_WINDOWS.find((w) => w.table === 'session_turn_parts')!;

describe('detectRetentionLag', () => {
  it('reports a table whose oldest row is past window + grace (the 2026-10-13 measurement)', () => {
    const { lagging, unknown } = detectRetentionLag([age('session_turn_parts', 41.7)], [WINDOW]);
    expect(unknown).toEqual([]);
    expect(lagging).toHaveLength(1);
    expect(lagging[0]).toMatchObject({ table: 'session_turn_parts', windowDays: 14 });
    expect(lagging[0].lagDays).toBeCloseTo(27.7, 5);
  });

  it('tolerates lag up to the grace (a daily pruner one run late) and reports just past it', () => {
    const edge = WINDOW.windowDays + WINDOW.graceDays;
    expect(detectRetentionLag([age(WINDOW.table, edge)], [WINDOW]).lagging).toEqual([]);
    expect(detectRetentionLag([age(WINDOW.table, edge + 0.01)], [WINDOW]).lagging).toHaveLength(1);
  });

  it('treats an empty table as healthy, not unknown', () => {
    expect(detectRetentionLag([age(WINDOW.table, null)], [WINDOW])).toEqual({ lagging: [], unknown: [] });
  });

  it('reports a failed, missing or non-finite reading as UNKNOWN, never healthy', () => {
    const windows = RETENTION_WINDOWS.slice(0, 3);
    const { lagging, unknown } = detectRetentionLag(
      [age(windows[0].table, null, false), age(windows[1].table, Number.NaN)],
      windows,
    );
    expect(lagging).toEqual([]);
    expect(unknown).toEqual(windows.map((w) => w.table).sort());
  });

  it('sorts the worst lag first', () => {
    const { lagging } = detectRetentionLag(
      RETENTION_WINDOWS.map((w, i) => age(w.table, w.windowDays + w.graceDays + 1 + i)),
    );
    expect(lagging.map((l) => l.lagDays)).toEqual([...lagging.map((l) => l.lagDays)].sort((a, b) => b - a));
    expect(lagging).toHaveLength(RETENTION_WINDOWS.length);
  });
});

describe('formatRetentionLagToast', () => {
  it('names the table, its age, its window and its pruner, and flags unmeasured windows', () => {
    const { lagging } = detectRetentionLag([age('session_turn_parts', 41.7)], [WINDOW]);
    const t = formatRetentionLagToast(lagging, ['session_turns']);
    expect(t.level).toBe('warning');
    expect(t.message).toContain('1 table(s)');
    expect(t.description).toContain('session_turn_parts: oldest row 41.7d vs a 14d window');
    expect(t.description).toContain(WINDOW.prunedBy);
    expect(t.description).toContain('FAILED (age unknown, not healthy) for: session_turns');
  });
});

describe('RETENTION_WINDOWS registry integrity — the recurrence guard', () => {
  it('pairs every window with a recorded retention claim, and every age claim with a window', () => {
    const windowed = new Set(RETENTION_WINDOWS.map((w) => w.table));
    for (const w of RETENTION_WINDOWS) expect(RETENTION_COVERED_ELSEWHERE).toHaveProperty(w.table);
    const ageClaims = Object.entries(RETENTION_COVERED_ELSEWHERE)
      .filter(([, why]) => /_DAYS\b|_DAYS=|_MS=|\b\d+d\b/.test(why))
      .map(([table]) => table);
    expect(ageClaims.length).toBeGreaterThan(0);
    const unchecked = ageClaims.filter((t) => !windowed.has(t) && !(t in NO_ROW_AGE_WINDOW));
    expect(unchecked).toEqual([]);
  });

  it('declares sane, unique, SQL-safe windows', () => {
    const tables = RETENTION_WINDOWS.map((w) => w.table);
    expect(new Set(tables).size).toBe(tables.length);
    for (const w of RETENTION_WINDOWS) {
      expect(w.table).toMatch(/^[a-z_][a-z0-9_]*$/);
      expect(w.ageColumn).toMatch(/^[a-z_][a-z0-9_]*$/);
      expect(Number.isFinite(w.windowDays) && w.windowDays > 0).toBe(true);
      expect(w.graceDays).toBeGreaterThan(0);
      expect(w.graceDays).toBeLessThan(w.windowDays);
    }
  });
});

describe('runStorageGrowthAlarmOnce — retention-lag leg', () => {
  const quiet = {
    computeUsage: async () => [],
    listTableSizes: async () => [],
    listDiskRootChildren: emptyDiskScan,
    countExemptSubsets: healthySubsetCounts,
  };

  it('emits exactly one toast and returns the lag when a pruner has fallen behind', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runStorageGrowthAlarmOnce({
      ...quiet,
      emitToast,
      readRetentionAges: async () =>
        RETENTION_WINDOWS.map((w) => age(w.table, w.table === 'session_turn_parts' ? 41.7 : 0)),
    });
    expect(res.retentionLag.map((l) => l.table)).toEqual(['session_turn_parts']);
    expect(res.retentionUnknown).toEqual([]);
    expect(emitToast).toHaveBeenCalledTimes(1);
    expect(emitToast.mock.calls[0][0].message).toContain('Retention lag');
  });

  it('emits NO toast when every pruner is within its window', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runStorageGrowthAlarmOnce({ ...quiet, emitToast, readRetentionAges: healthyRetentionAges });
    expect(res.retentionLag).toEqual([]);
    expect(emitToast).not.toHaveBeenCalled();
  });

  it('reports every window UNKNOWN when the probe throws, without blinding the other legs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runStorageGrowthAlarmOnce({
      ...quiet,
      emitToast: async () => {},
      readRetentionAges: async () => {
        throw new Error('pool down');
      },
    });
    warn.mockRestore();
    expect(res.retentionUnknown).toEqual(RETENTION_WINDOWS.map((w) => w.table).sort());
    expect(res.retentionLag).toEqual([]);
    expect(res.exemptUnknown).toEqual([]);
  });
});
