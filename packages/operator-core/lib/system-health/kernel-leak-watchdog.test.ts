import { describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => { throw new Error('no PG in unit tests'); },
}));
vi.mock('../agent-tools/coordination/escalations', () => ({ openEscalation: vi.fn() }));
vi.mock('../severe-event-broadcast', () => ({ broadcastSevereEvent: vi.fn(async () => true) }));
vi.mock('../alarm-attention', () => ({ resolveAlarm: vi.fn(async (conditionKey, source, deps) =>
  deps?.resolve?.({ conditionKey, summary: `${source} recovered` }) ?? false) }));

import {
  DYING_DESCENDANTS_FLOOR,
  KERNEL_LEAK_RETENTION_DAYS,
  KERNEL_LEAK_SAMPLE_INTERVAL_MS,
  KERNEL_LEAK_WARMUP_MS,
  appSliceOf,
  buildHostPressureTotals,
  buildKernelMemorySample,
  contentionCgroups,
  evaluateKernelLeak,
  formatKernelLeakEscalation,
  parseCpuUsageUsec,
  parseDyingDescendants,
  parsePressureTotal,
  runHostSampleOnce,
  runKernelLeakCheckOnce,
  slopePerDay,
  slopeWindow,
  type HostContentionReading,
  type KernelMemorySample,
} from './kernel-leak-watchdog';

const GIB = 1024 ** 3;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const MEM_TOTAL = 251 * GIB;
const BOOT_AT = Date.parse('2026-09-27T02:07:37Z');

/** A series of samples every KERNEL_LEAK_SAMPLE_INTERVAL_MS (60 s) from `startMs` to `endMs`, growing linearly per day. */
function series(opts: {
  startMs: number;
  endMs: number;
  sUnreclaimStart: number;
  sUnreclaimPerDay: number;
  dyingStart?: number | null;
  dyingPerDay?: number;
  bootId?: string;
}): KernelMemorySample[] {
  const out: KernelMemorySample[] = [];
  for (let t = opts.startMs; t <= opts.endMs; t += KERNEL_LEAK_SAMPLE_INTERVAL_MS) {
    const days = (t - opts.startMs) / DAY;
    out.push({
      bootId: opts.bootId ?? 'boot-a',
      host: 'tower',
      sampledAtMs: t,
      bootedAtMs: BOOT_AT,
      memTotalBytes: MEM_TOTAL,
      sUnreclaimBytes: Math.round(opts.sUnreclaimStart + opts.sUnreclaimPerDay * days),
      slabBytes: Math.round(opts.sUnreclaimStart * 4 + opts.sUnreclaimPerDay * days),
      dyingDescendants:
        opts.dyingStart === null ? null : Math.round((opts.dyingStart ?? 300) + (opts.dyingPerDay ?? 0) * days),
    });
  }
  return out;
}

const last = <T>(xs: T[]): T => xs[xs.length - 1];

/** A distinct contention reading, so a store call is provably handed THIS one. */
const contention: HostContentionReading = {
  pressure: { cpuSomeUs: 11, ioSomeUs: 22, ioFullUs: 33, memorySomeUs: 44, memoryFullUs: 55 },
  cgroupCpuUsageUs: { '/': 1_000, 'system-postgresql.slice': 250 },
};

describe('parsing', () => {
  const meminfo = [
    'MemTotal:       263747704 kB',
    'Slab:           19405652 kB',
    'SReclaimable:   14640804 kB',
    'SUnreclaim:      4764848 kB',
  ].join('\n');

  it('builds a sample from the real /proc shapes', () => {
    const s = buildKernelMemorySample({
      meminfo,
      cgroupStat: 'nr_descendants 433\nnr_dying_descendants 278\n',
      bootId: 'd3e57b27-e60c-40f8-a6f1-a9e82e715925\n',
      uptime: '12129.38 1066899.13\n',
      host: 'tower',
      nowMs: BOOT_AT + 12_129_380,
    });
    expect(s).toEqual({
      bootId: 'd3e57b27-e60c-40f8-a6f1-a9e82e715925',
      host: 'tower',
      sampledAtMs: BOOT_AT + 12_129_380,
      bootedAtMs: BOOT_AT,
      memTotalBytes: 263747704 * 1024,
      sUnreclaimBytes: 4764848 * 1024,
      slabBytes: 19405652 * 1024,
      dyingDescendants: 278,
    });
  });

  it('does not confuse SUnreclaim with SReclaimable, or nr_descendants with nr_dying_descendants', () => {
    const s = buildKernelMemorySample({
      meminfo, cgroupStat: 'nr_descendants 433\nnr_dying_descendants 278', bootId: 'b', uptime: '10 1', host: 'h', nowMs: 1e12,
    });
    expect(s?.sUnreclaimBytes).toBe(4764848 * 1024);
    expect(s?.dyingDescendants).toBe(278);
  });

  it('drops a half-read sample instead of storing a poisoned point', () => {
    const base = { cgroupStat: null, bootId: 'b', uptime: '10 1', host: 'h', nowMs: 1e12 };
    expect(buildKernelMemorySample({ ...base, meminfo: 'MemTotal: 1 kB\nSlab: 1 kB' })).toBeNull();
    expect(buildKernelMemorySample({ ...base, meminfo, uptime: 'garbage' })).toBeNull();
    expect(buildKernelMemorySample({ ...base, meminfo, bootId: '  ' })).toBeNull();
  });

  it('reports an absent cgroup.stat as null, never as zero dying cgroups', () => {
    expect(parseDyingDescendants(null)).toBeNull();
    expect(parseDyingDescendants('nr_descendants 4\n')).toBeNull();
    expect(parseDyingDescendants('nr_dying_descendants 0\n')).toBe(0);
  });
});

describe('slopePerDay', () => {
  it('fits a straight line exactly', () => {
    const pts = [0, 1, 2, 3].map((h) => ({ tMs: h * HOUR, v: 100 + h * 10 }));
    expect(slopePerDay(pts)).toBeCloseTo(240, 6);
  });

  it('is null when time does not vary', () => {
    expect(slopePerDay([{ tMs: 5, v: 1 }])).toBeNull();
    expect(slopePerDay([{ tMs: 5, v: 1 }, { tMs: 5, v: 9 }])).toBeNull();
  });
});

describe('evaluateKernelLeak', () => {
  const warm = BOOT_AT + KERNEL_LEAK_WARMUP_MS;

  it('CALIBRATION: the measured 6.17 leak rate (~2.6 GB/day) alarms once 12 h of post-warm-up data exist', () => {
    const s = series({ startMs: warm, endMs: warm + 13 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 2.6e9 });
    const alerts = evaluateKernelLeak(s, last(s));
    expect(alerts.map((a) => a.signal)).toEqual(['sunreclaim-growth']);
    expect(alerts[0].slopePerDay! / 1e9).toBeCloseTo(2.6, 1);
  });

  it('does not alarm on a flat series (the expected 7.0 baseline)', () => {
    const s = series({ startMs: warm, endMs: warm + 20 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 0 });
    expect(evaluateKernelLeak(s, last(s))).toEqual([]);
  });

  it('does not alarm on a leak-rate climb with only 11 h of data — the slope needs a 12 h span', () => {
    const s = series({ startMs: warm, endMs: warm + 11 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 3e9 });
    expect(evaluateKernelLeak(s, last(s))).toEqual([]);
  });

  it('ignores the post-boot warm-up climb entirely', () => {
    // A steep climb during the first 6 h, then flat: the warm-up must not count.
    const early = series({ startMs: BOOT_AT, endMs: warm - 1, sUnreclaimStart: 1 * GIB, sUnreclaimPerDay: 12 * GIB });
    const flat = series({ startMs: warm, endMs: warm + 14 * HOUR, sUnreclaimStart: 4 * GIB, sUnreclaimPerDay: 0 });
    const all = [...early, ...flat];
    expect(slopeWindow(all, last(all)).every((x) => x.sampledAtMs >= warm)).toBe(true);
    expect(evaluateKernelLeak(all, last(all))).toEqual([]);
  });

  it('never fits a slope across a reboot', () => {
    const prior = series({ startMs: warm, endMs: warm + 14 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 3e9, bootId: 'old' });
    const now = series({ startMs: warm + 14 * HOUR + 1, endMs: warm + 15 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 0, bootId: 'new' });
    const all = [...prior, ...now];
    expect(slopeWindow(all, last(all)).every((x) => x.bootId === 'new')).toBe(true);
    expect(evaluateKernelLeak(all, last(all))).toEqual([]);
  });

  it('alarms on absolute SUnreclaim at 10% of RAM with no history at all (the pre-reboot 29.9 GiB state)', () => {
    const s = series({ startMs: BOOT_AT + HOUR, endMs: BOOT_AT + HOUR, sUnreclaimStart: 29.9 * GIB, sUnreclaimPerDay: 0 });
    expect(evaluateKernelLeak(s, s[0]).map((a) => a.signal)).toEqual(['sunreclaim-absolute']);
  });

  it('alarms on dying cgroups only when BOTH above the floor and still climbing', () => {
    const climbing = series({
      startMs: warm, endMs: warm + 13 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 0,
      dyingStart: DYING_DESCENDANTS_FLOOR, dyingPerDay: 900,
    });
    expect(evaluateKernelLeak(climbing, last(climbing)).map((a) => a.signal)).toEqual(['dying-growth']);

    const highButFlat = series({
      startMs: warm, endMs: warm + 13 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 0, dyingStart: 1900, dyingPerDay: 0,
    });
    expect(evaluateKernelLeak(highButFlat, last(highButFlat))).toEqual([]);

    const climbingButLow = series({
      startMs: warm, endMs: warm + 13 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 0, dyingStart: 100, dyingPerDay: 900,
    });
    expect(evaluateKernelLeak(climbingButLow, last(climbingButLow))).toEqual([]);
  });

  it('never alarms on dying cgroups when cgroup.stat is unreadable', () => {
    const s = series({
      startMs: warm, endMs: warm + 13 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 0, dyingStart: null,
    });
    expect(evaluateKernelLeak(s, last(s))).toEqual([]);
  });
});

describe('formatKernelLeakEscalation', () => {
  it('names the numbers, the size-not-name triage, and the known instance', () => {
    const s = series({ startMs: BOOT_AT + 7 * HOUR, endMs: BOOT_AT + 20 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 3 * GIB });
    const [alert] = evaluateKernelLeak(s, last(s));
    const { summary, body } = formatKernelLeakEscalation(alert);
    expect(summary).toContain('growing 3.0 GiB/day');
    expect(body).toContain("boot_id = 'boot-a'");
    expect(body).toContain('/proc/slabinfo');
    expect(body).toContain('re-randomise per boot');
    expect(body).toContain('P-001');
  });
});

describe('runKernelLeakCheckOnce', () => {
  it('opens each signal independently of legacy failures and resolves only measured healthy signals', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const high = series({ startMs: BOOT_AT + 7 * HOUR, endMs: BOOT_AT + 20 * HOUR,
      sUnreclaimStart: 30 * GIB, sUnreclaimPerDay: 3 * GIB, dyingStart: 1500, dyingPerDay: 800 });
    const low = series({ startMs: BOOT_AT + 7 * HOUR, endMs: BOOT_AT + 20 * HOUR,
      sUnreclaimStart: GIB, sUnreclaimPerDay: 0, dyingStart: 100, dyingPerDay: 0 });
    let rows = high, current: KernelMemorySample | null = last(rows), unreadable = false;
    const open = new Set<string>();
    const rail = { broadcast: vi.fn(async (event: { conditionKey?: string }) => { open.add(event.conditionKey!); return true; }),
      resolve: vi.fn(async (event: { conditionKey: string }) => open.delete(event.conditionKey)) };
    const deps = { rail, readSample: async () => current, store: async () => {}, prune: async () => {},
      loadSeries: async () => { if (unreadable) throw new Error('history unavailable'); return rows; },
      escalate: async () => { throw new Error('legacy unavailable'); } };
    try {
      await runKernelLeakCheckOnce(deps);
      expect(open.size).toBe(3);
      expect(rail.broadcast).toHaveBeenCalledTimes(3);
      current = null; await runKernelLeakCheckOnce(deps);
      expect(open.size).toBe(3);
      rows = low; current = { ...last(low), dyingDescendants: null }; unreadable = true;
      await runKernelLeakCheckOnce(deps);
      expect([...open].sort()).toEqual(['alarm:kernel-leak:tower:dying-growth', 'alarm:kernel-leak:tower:sunreclaim-growth']);
      unreadable = false; rows = [current]; await runKernelLeakCheckOnce(deps);
      expect(open.size).toBe(2); // one point is not proof that the trend recovered
      rows = low.map((row) => ({ ...row, bootId: 'other-boot' })); await runKernelLeakCheckOnce(deps);
      expect(open.size).toBe(2);
      rows = low.map((row, index) => index === 5 ? { ...row, sUnreclaimBytes: NaN } : row);
      await runKernelLeakCheckOnce(deps);
      expect(open.size).toBe(2); // malformed history is unknown, not a healthy slope
      rows = low; current = last(low); await runKernelLeakCheckOnce(deps);
      expect(open.size).toBe(0);
      expect(warn).toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('continues legacy notification when condition delivery fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const current = series({ startMs: BOOT_AT + HOUR, endMs: BOOT_AT + HOUR,
      sUnreclaimStart: 30 * GIB, sUnreclaimPerDay: 0 })[0];
    const escalate = vi.fn(async () => {});
    try {
      await runKernelLeakCheckOnce({ readSample: async () => current, store: async () => {}, prune: async () => {},
        loadSeries: async () => [], escalate, rail: { broadcast: async () => { throw new Error('rail failed'); } } });
      expect(escalate).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('condition sunreclaim-absolute failed'));
    } finally { warn.mockRestore(); }
  });

  it('skips cleanly when no sample is readable (non-Linux, missing /proc)', async () => {
    const store = vi.fn();
    const r = await runKernelLeakCheckOnce({ readSample: async () => null, store });
    expect(r).toEqual({ skipped: true, sample: null, alerts: [] });
    expect(store).not.toHaveBeenCalled();
  });

  it('stores the sample, then escalates each breached signal', async () => {
    const s = series({ startMs: BOOT_AT + 7 * HOUR, endMs: BOOT_AT + 20 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 3e9 });
    const current = last(s);
    const store = vi.fn(async () => {});
    const escalate = vi.fn(async () => {});
    const r = await runKernelLeakCheckOnce({
      readSample: async () => current,
      readContention: async () => contention,
      store,
      prune: async () => {},
      loadSeries: async () => s.slice(0, -1),
      escalate,
    });
    expect(store).toHaveBeenCalledWith(current, contention);
    expect(r.alerts.map((a) => a.signal)).toEqual(['sunreclaim-growth']);
    expect(escalate).toHaveBeenCalledTimes(1);
  });

  it('never throws: a failed store / load / escalate is logged and the tick finishes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const current = series({ startMs: BOOT_AT + HOUR, endMs: BOOT_AT + HOUR, sUnreclaimStart: 30 * GIB, sUnreclaimPerDay: 0 })[0];
    const r = await runKernelLeakCheckOnce({
      readSample: async () => current,
      store: async () => { throw new Error('pg down'); },
      prune: async () => {},
      loadSeries: async () => { throw new Error('pg down'); },
      escalate: async () => { throw new Error('escalation store down'); },
    });
    // The absolute signal still fires without history.
    expect(r.alerts.map((a) => a.signal)).toEqual(['sunreclaim-absolute']);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

// ── P-002 / D-005: contention readings (papercusp-performance-audit-2026-10-12) ──

describe('contention parsing', () => {
  // Verbatim shapes of /proc/pressure/{cpu,io,memory} on kernel 6.x. cpu "full" is
  // reported with total=0 at the system level: a real zero, not an absent line.
  const cpu = 'some avg10=1.60 avg60=2.19 avg300=2.07 total=21700182638\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
  const io = 'some avg10=44.70 avg60=44.70 avg300=30.12 total=987654321\nfull avg10=31.90 avg60=31.90 avg300=20.01 total=555555555\n';
  const memory = 'some avg10=0.00 avg60=2.99 avg300=1.00 total=4242\nfull avg10=0.00 avg60=0.50 avg300=0.10 total=1717\n';

  it('reads the cumulative total= of each PSI line kind, never an avg field', () => {
    expect(parsePressureTotal(io, 'some')).toBe(987654321);
    expect(parsePressureTotal(io, 'full')).toBe(555555555);
    expect(parsePressureTotal(cpu, 'some')).toBe(21700182638);
  });

  it('keeps a reported total=0 as zero, and an absent line or file as null', () => {
    expect(parsePressureTotal(cpu, 'full')).toBe(0);
    expect(parsePressureTotal('some avg10=0.00 avg60=0.00 avg300=0.00 total=9\n', 'full')).toBeNull();
    expect(parsePressureTotal(null, 'some')).toBeNull();
    expect(parsePressureTotal('', 'some')).toBeNull();
  });

  it('builds all five stall totals, with null only for what was unreadable', () => {
    expect(buildHostPressureTotals({ cpu, io, memory })).toEqual({
      cpuSomeUs: 21700182638,
      ioSomeUs: 987654321,
      ioFullUs: 555555555,
      memorySomeUs: 4242,
      memoryFullUs: 1717,
    });
    expect(buildHostPressureTotals({ cpu: null, io, memory: null })).toEqual({
      cpuSomeUs: null,
      ioSomeUs: 987654321,
      ioFullUs: 555555555,
      memorySomeUs: null,
      memoryFullUs: null,
    });
  });

  it('reports no pressure at all (CONFIG_PSI=n) as null, never as five zeros', () => {
    expect(buildHostPressureTotals({ cpu: null, io: null, memory: null })).toBeNull();
  });

  it('reads usage_usec from cpu.stat and does not confuse it with user_usec', () => {
    expect(parseCpuUsageUsec('user_usec 700\nusage_usec 1000\nsystem_usec 300\nnr_periods 0\n')).toBe(1000);
    expect(parseCpuUsageUsec('user_usec 700\nsystem_usec 300\n')).toBeNull();
    expect(parseCpuUsageUsec(null)).toBeNull();
  });

  it("finds this process's app.slice, and nothing for a system service or cgroup v1", () => {
    expect(appSliceOf('0::/user.slice/user-1000.slice/user@1000.service/app.slice/papercusp-dev-api.service\n')).toBe(
      'user.slice/user-1000.slice/user@1000.service/app.slice',
    );
    expect(appSliceOf('0::/system.slice/postgresql@16-main.service\n')).toBeNull();
    expect(appSliceOf('12:cpu,cpuacct:/user.slice/app.slice/x.service\n')).toBeNull();
    expect(appSliceOf(null)).toBeNull();
  });

  it('samples the root, top-level slices, postgres and only the papercusp units of the app.slice', () => {
    const appSlice = 'user.slice/user-1000.slice/user@1000.service/app.slice';
    const groups = contentionCgroups({
      appSlice,
      rootEntries: ['user.slice', 'cgroup.procs', 'system.slice', 'cpu.stat', 'init.scope', 'machine.slice'],
      appSliceEntries: [
        'papercusp-staging-api.service',
        'firefox.service',
        'papercusp-dev-api.service',
        'papercup-embed-sidecar.service',
        'papercusp-test-1470200-mv5zxogr-4.scope',
        'cgroup.procs',
      ],
    });
    expect(groups).toEqual([
      { key: '/', path: '' },
      { key: 'machine.slice', path: 'machine.slice' },
      { key: 'system.slice', path: 'system.slice' },
      { key: 'user.slice', path: 'user.slice' },
      { key: 'system-postgresql.slice', path: 'system.slice/system-postgresql.slice' },
      { key: 'app.slice', path: appSlice },
      { key: 'papercup-embed-sidecar.service', path: `${appSlice}/papercup-embed-sidecar.service` },
      { key: 'papercusp-dev-api.service', path: `${appSlice}/papercusp-dev-api.service` },
      { key: 'papercusp-staging-api.service', path: `${appSlice}/papercusp-staging-api.service` },
    ]);
  });

  it('still samples the host-wide cgroups when this process is not under an app.slice', () => {
    const keys = contentionCgroups({ appSlice: null, rootEntries: ['system.slice'], appSliceEntries: ['papercusp-dev-api.service'] })
      .map((g) => g.key);
    expect(keys).toEqual(['/', 'system.slice', 'system-postgresql.slice']);
  });
});

describe('retention (PERF-P002-RETENTION)', () => {
  it('the kernel-leak check prunes on every pass, after its sample is stored; the 60 s sampler never prunes', async () => {
    const sample = series({ startMs: BOOT_AT + 8 * HOUR, endMs: BOOT_AT + 8 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 0 })[0];
    const store = vi.fn(async () => {});
    const prune = vi.fn(async () => {});
    for (let pass = 0; pass < 2; pass++) {
      await runKernelLeakCheckOnce({
        readSample: async () => sample,
        readContention: async () => contention,
        store,
        prune,
        loadSeries: async () => [],
        escalate: async () => {},
      });
    }
    expect(prune).toHaveBeenCalledTimes(2);
    expect(store.mock.invocationCallOrder[0]).toBeLessThan(prune.mock.invocationCallOrder[0]!);
    expect(KERNEL_LEAK_RETENTION_DAYS).toBe(14);
    // runHostSampleOnce accepts no prune dependency at all: rows are bounded by the 10-minute check.
    const sampled = await runHostSampleOnce({ readSample: async () => sample, readContention: async () => contention, store });
    expect(sampled.stored).toBe(true);
    expect(prune).toHaveBeenCalledTimes(2);
  });
});

describe('runHostSampleOnce (the 60 s host-contention-sampler tick)', () => {
  const sample = series({ startMs: BOOT_AT + 8 * HOUR, endMs: BOOT_AT + 8 * HOUR, sUnreclaimStart: 5 * GIB, sUnreclaimPerDay: 0 })[0];

  it('stores the sample together with its contention reading, and nothing else', async () => {
    const store = vi.fn(async () => {});
    const r = await runHostSampleOnce({ readSample: async () => sample, readContention: async () => contention, store });
    expect(store).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledWith(sample, contention);
    expect(r).toEqual({ stored: true, sample, contention });
  });

  it('a failed contention read never costs the kernel-memory sample: it is stored without contention', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = vi.fn(async () => {});
    const r = await runHostSampleOnce({
      readSample: async () => sample,
      readContention: async () => { throw new Error('EACCES pressure/io'); },
      store,
    });
    expect(store).toHaveBeenCalledWith(sample, null);
    expect(r).toEqual({ stored: true, sample, contention: null });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/contention read failed.*EACCES/);
    warn.mockRestore();
  });

  it('stores nothing and reads no contention when no sample is readable', async () => {
    const store = vi.fn(async () => {});
    const readContention = vi.fn(async () => contention);
    const r = await runHostSampleOnce({ readSample: async () => null, readContention, store });
    expect(r).toEqual({ stored: false, sample: null, contention: null });
    expect(store).not.toHaveBeenCalled();
    expect(readContention).not.toHaveBeenCalled();
  });

  it('never throws: a failed read or store is logged and reported as not stored', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const readFailed = await runHostSampleOnce({
      readSample: async () => { throw new Error('meminfo unreadable'); },
      store: vi.fn(async () => {}),
    });
    expect(readFailed).toEqual({ stored: false, sample: null, contention: null });
    const storeFailed = await runHostSampleOnce({
      readSample: async () => sample,
      readContention: async () => contention,
      store: async () => { throw new Error('pg down'); },
    });
    expect(storeFailed).toEqual({ stored: false, sample, contention });
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
