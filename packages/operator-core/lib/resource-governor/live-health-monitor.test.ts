import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { ResourceProfile } from '@papercusp/resource-profile';
import {
  LiveHealthHistoryWriter,
  LiveHealthMonitor,
  applyHostLiveHealthReadings,
  collectLiveHealthStorage,
  decodeLiveHealthHistorySnapshot,
  decodeLiveHealthStorageHistorySample,
  liveHealthStorageHistorySample,
  parseCloseWaitCount,
  parseMemoryKernel,
  parseNetworkCounters,
  parseProcStat,
  parsePsi,
  type HostLiveHealthCounters,
  type LiveHealthPaths,
} from './live-health-monitor';
import {
  LIVE_HEALTH_SCHEMA_VERSION,
  emptyLiveHealthObservations,
  emptyLiveHealthSignals,
  isLiveHealthSnapshot,
  type LiveHealthSnapshot,
} from './live-health';

const PATHS: LiveHealthPaths = {
  rootDir: '/tmp/health',
  fragmentsDir: '/tmp/health/fragments',
  snapshotPath: '/tmp/health/live-health.json',
};

function counters(overrides: Partial<HostLiveHealthCounters> = {}): HostLiveHealthCounters {
  return {
    atMs: 2_000,
    cpu: { idleMs: 400, totalMs: 1_000 },
    totalMemoryBytes: 1_000,
    freeMemoryBytes: 250,
    cpuPsi: { some60: 2.5, full60: null },
    memoryPsi: { some60: 3.5, full60: 1.5 },
    ioPsi: { some60: 0.25, full60: 0.05 },
    scheduler: { runnable: 4, blocked: 1 },
    memoryKernel: { swapUsedBytes: 100, swapInPages: 20, swapOutPages: 40 },
    network: { rxBytes: 2_000, txBytes: 4_000 },
    closeWaitCount: 3,
    diskFreeBytes: 5_000,
    ...overrides,
  };
}

function historySnapshot(sequence: number): LiveHealthSnapshot {
  const sampledAtMs = sequence * 2_000;
  return {
    schemaVersion: LIVE_HEALTH_SCHEMA_VERSION,
    sequence,
    sampledAtMs,
    monitorStartedAtMs: 2_000,
    cadenceMs: 2_000,
    profile: {
      platform: 'linux',
      arch: 'x64',
      release: 'fixture',
      effectiveCores: 1,
      physicalCores: 1,
      totalMemoryBytes: 1_024,
      embeddedPg: false,
      hostRole: 'test',
      source: '@papercusp/resource-profile',
    },
    writers: {},
    observations: emptyLiveHealthObservations(),
    signals: emptyLiveHealthSignals(sampledAtMs),
  };
}

describe('compact storage interval history', () => {
  it.each([[true, true], [true, false], [false, true]])(
    'records future sample custody and preserves it in both codecs (%s, %s)', async (before, after) => {
      const root = await mkdtemp(join(tmpdir(), 'papercusp-source-custody-'));
      const pin = { pid: process.pid, processIdentity: 'fixture-process', entry: '/fixture/entry.mjs',
        entryStat: 'fixture-stat', sha256: 'a'.repeat(64) };
      const capture = vi.fn(() => pin);
      const current = vi.fn().mockReturnValueOnce(before).mockReturnValueOnce(after);
      const storage = await collectLiveHealthStorage(['/'], () => 2_000, {
        filesystem: async () => ({ dev: 1, totalBytes: 100, availableBytes: 90, totalInodes: 100, freeInodes: 90 }),
        reservations: () => ({ state: 'measured', deviceKey: 'dev-1', reservedBytes: 0, knownReservedBytes: 0, issues: [] }),
      });
      const monitor = new LiveHealthMonitor({ paths: { rootDir: root, fragmentsDir: join(root, 'fragments'),
        snapshotPath: join(root, 'live-health.json') }, now: () => 2_000,
        collectHost: async () => counters({ storage }), readFragments: async () => [], sourceWitness: { capture, current } });
      try {
        const actual = await monitor.sampleOnce();
        expect(capture).toHaveBeenCalledExactlyOnceWith(process.pid);
        expect(actual.sourceCustody).toEqual({ kind: 'node-entry-sha256', nativePid: process.pid,
          processIdentity: pin.processIdentity, sha256: pin.sha256, sampleStartedAtMs: 2_000, sampleCompletedAtMs: 2_000,
          stableDuringSample: before && after });
        const full = decodeLiveHealthHistorySnapshot((await readFile(join(root, 'live-health-history.jsonl'), 'utf8')).trim().split('\n'))!;
        const compact = decodeLiveHealthStorageHistorySample((await readFile(join(root, 'live-health-storage-history.jsonl'), 'utf8')).trim().split('\n'))!;
        expect(full.sourceCustody).toEqual(actual.sourceCustody);
        expect(compact.sourceCustody).toEqual(actual.sourceCustody);
        expect(decodeLiveHealthHistorySnapshot([JSON.stringify({ ...full,
          writers: { ...full.writers, [monitor.writer.id]: { ...monitor.writer, pid: process.pid + 1 } } })])).toBeNull();
        for (const corrupt of [{ sha256: 'bad' }, { nativePid: process.pid + 1 }, { sampleStartedAtMs: 1_999 },
          { sampleCompletedAtMs: 1_999 }, { stableDuringSample: 'true' }]) {
          const custody = { ...actual.sourceCustody, ...corrupt };
          expect(decodeLiveHealthStorageHistorySample([JSON.stringify({ ...compact, sourceCustody: custody })])).toBeNull();
          expect(decodeLiveHealthHistorySnapshot([JSON.stringify({ ...full, sourceCustody: custody })])).toBeNull();
        }
        const { sourceCustody: omitted, ...legacy } = compact;
        expect(omitted).toBeDefined();
        expect(decodeLiveHealthStorageHistorySample([JSON.stringify(legacy)]))
          .not.toHaveProperty('sourceCustody');
        current.mockReturnValue(true);
        await monitor.sampleOnce();
        expect(capture).toHaveBeenCalledTimes(1);
      } finally { await monitor.stop(); await rm(root, { recursive: true, force: true }); }
    });

  it('keeps unsupported source custody explicitly unknown instead of hashing today’s checkout', async () => {
    const capture = vi.fn(() => null);
    const current = vi.fn(() => true);
    const monitor = new LiveHealthMonitor({ paths: PATHS, now: () => 2_000,
      collectHost: async () => counters(), readFragments: async () => [], writeSnapshot: async () => {},
      writeHistory: async () => {}, sourceWitness: { capture, current } });
    try {
      expect((await monitor.sampleOnce()).sourceCustody).toBeNull();
      expect((await monitor.sampleOnce()).sourceCustody).toBeNull();
      expect(capture).toHaveBeenCalledTimes(1);
      expect(current).not.toHaveBeenCalled();
    } finally { await monitor.stop(); }
  });

  it.each([false, true])('preserves full producer history when compact storage persistence fails: %s', async (failCompact) => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-storage-producer-'));
    try {
      const storage = await collectLiveHealthStorage(['/', '/mnt/data', '/tmp/pcv'], () => 2_000, {
        filesystem: async () => ({ dev: 1, totalBytes: 100, availableBytes: 90, totalInodes: 100, freeInodes: 90 }),
        reservations: () => ({ state: 'measured', deviceKey: 'dev-1', reservedBytes: 0, knownReservedBytes: 0, issues: [] }),
      });
      if (failCompact) await mkdir(join(root, 'live-health-storage-history.jsonl'));
      const log = vi.fn();
      const monitor = new LiveHealthMonitor({ paths: { rootDir: root, fragmentsDir: join(root, 'fragments'),
        snapshotPath: join(root, 'live-health.json') }, now: () => 2_000,
        collectHost: async () => counters({ storage }), readFragments: async () => [], log });
      const actual = await monitor.sampleOnce();
      const full = decodeLiveHealthHistorySnapshot((await readFile(join(root, 'live-health-history.jsonl'), 'utf8')).trim().split('\n'))!;
      expect(full.observations).toEqual(actual.observations);
      if (failCompact) {
        expect(log).toHaveBeenCalledWith(expect.stringContaining('storage history write failed:'));
        return;
      }
      const compact = decodeLiveHealthStorageHistorySample((await readFile(join(root, 'live-health-storage-history.jsonl'), 'utf8')).trim().split('\n'))!;
      expect(compact).toMatchObject({ writer: monitor.writer, sequence: actual.sequence, sampledAtMs: actual.sampledAtMs });
      expect(compact.storage).toEqual(actual.storage);
      expect(compact).not.toHaveProperty('observations');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('retains an hour across bounded compaction and restart independently of fleet snapshot size', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-storage-history-'));
    try {
      const storage = await collectLiveHealthStorage(['/', '/mnt/data', '/tmp/pcv'], () => 2_000, {
        filesystem: async () => ({ dev: 1, totalBytes: 100, availableBytes: 90, totalInodes: 100, freeInodes: 90 }),
        reservations: () => ({ state: 'unknown', deviceKey: 'dev-1', reservedBytes: null, knownReservedBytes: 0, issues: ['unreadable'] }),
      });
      const snapshot = historySnapshot(1);
      const monitor = { id: 'monitor.host:1', kind: 'monitor' as const, instanceId: 'native-fixture',
        pid: 1, platform: 'linux' as const, startedAtMs: 2_000 };
      const fleet = { ...snapshot, storage, writers: { [monitor.id]: monitor },
        unrelatedFleetPayload: 'fleet-observations'.repeat(100_000) };
      const row = liveHealthStorageHistorySample(fleet)!;
      expect(JSON.stringify(row).length).toBeLessThan(4_096);
      expect(row).not.toHaveProperty('unrelatedFleetPayload');
      const path = join(root, 'storage.jsonl');
      let writer = new LiveHealthHistoryWriter(path);
      for (let sequence = 1; sequence <= 3_601; sequence += 1) {
        const at = sequence * 2_000;
        if (sequence === 2_000) writer = new LiveHealthHistoryWriter(path);
        expect(await writer.append({ ...row, sequence, sampledAtMs: at,
          storage: { ...storage, startedAtMs: at, collectedAtMs: at } })).toBe(true);
      }
      const rows = (await readFile(path, 'utf8')).trim().split('\n');
      const decoded = rows.map((line) => decodeLiveHealthStorageHistorySample([line])!);
      expect(decoded.every(Boolean)).toBe(true);
      expect(decoded.at(-1)!.sampledAtMs - decoded[0]!.sampledAtMs).toBeGreaterThanOrEqual(3_600_000);
      expect((await stat(path)).size).toBeLessThanOrEqual(writer.maxBytes);
      expect(decoded.at(-1)!.storage.snapshots[0]).toMatchObject({ reservationState: 'unknown', reservedBytes: null });
      expect(decodeLiveHealthHistorySnapshot([rows[0]!])).toBeNull();
      const invalid = structuredClone(decoded[0]!);
      (invalid.storage.snapshots[0] as { reservedBytes: number | null }).reservedBytes = 0;
      expect(decodeLiveHealthStorageHistorySample([JSON.stringify(invalid)])).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});

describe('live-health host parsers', () => {
  it('parses PSI, scheduler, swap, network, and socket counters with unknown-preserving failures', () => {
    expect(parsePsi('some avg10=1.0 avg60=2.5 avg300=3 total=4\nfull avg10=0 avg60=1.5 avg300=2 total=3')).toEqual({
      some60: 2.5,
      full60: 1.5,
    });
    expect(parsePsi(null)).toEqual({ some60: null, full60: null });
    expect(parseProcStat('cpu 1 2 3\nprocs_running 7\nprocs_blocked 2\n')).toEqual({ runnable: 7, blocked: 2 });
    expect(parseMemoryKernel('SwapTotal: 100 kB\nSwapFree: 40 kB\n', 'pswpin 9\npswpout 11\n')).toEqual({
      swapUsedBytes: 60 * 1_024,
      swapInPages: 9,
      swapOutPages: 11,
    });
    expect(
      parseNetworkCounters(
        'Inter-|...\n eth0: 100 0 0 0 0 0 0 0 250 0 0 0 0 0 0 0\n lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0',
      ),
    ).toEqual({ rxBytes: 100, txBytes: 250 });
    expect(parseCloseWaitCount('sl local remote st\n0: a b 08\n1: a b 01\n', null)).toBe(1);
    expect(parseCloseWaitCount(null, null)).toBeNull();
  });

  it('uses deltas for CPU, swap, and network and leaves the first window unknown', () => {
    const firstSignals = emptyLiveHealthSignals(1_000);
    const first = counters({
      atMs: 1_000,
      cpu: { idleMs: 100, totalMs: 400 },
      memoryKernel: { swapUsedBytes: 80, swapInPages: 10, swapOutPages: 20 },
      network: { rxBytes: 1_000, txBytes: 2_000 },
    });
    applyHostLiveHealthReadings(firstSignals, 'monitor:1', first, null);
    expect(firstSignals['cpu.hostUtilizationPct'].state).toBe('unknown');
    expect(firstSignals['memory.swapInBytesPerSec'].value).toBeNull();

    const secondSignals = emptyLiveHealthSignals(2_000);
    applyHostLiveHealthReadings(secondSignals, 'monitor:1', counters({ ioPsi: { some60: 8, full60: 3 } }), first);
    expect(secondSignals['cpu.hostUtilizationPct'].value).toBeCloseTo(50);
    expect(secondSignals['memory.swapInBytesPerSec'].value).toBe(10 * 4_096);
    expect(secondSignals['network.rxBytesPerSec'].value).toBe(1_000);
    expect(secondSignals['memory.hostUsedBytes'].value).toBe(750);
    expect(secondSignals['io.psiSomePct']).toMatchObject({ state: 'measured', value: 8 });
    expect(secondSignals['io.psiFullPct']).toMatchObject({ state: 'measured', value: 3 });
  });

  it('retains complete history within both configured sample and byte caps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-live-health-history-'));
    try {
      const samplePath = join(root, 'samples.jsonl');
      const sampleWriter = new LiveHealthHistoryWriter(samplePath, { maxSamples: 2, maxBytes: 1_000_000 });
      for (let sequence = 1; sequence <= 4; sequence += 1) await sampleWriter.append(historySnapshot(sequence));
      const sampleRows = (await readFile(samplePath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as LiveHealthSnapshot);
      expect(sampleRows.map((row) => row.sequence)).toEqual([3, 4]);

      const bytePath = join(root, 'bytes.jsonl');
      const rowBytes = Buffer.byteLength(JSON.stringify(historySnapshot(1)) + '\n');
      const byteWriter = new LiveHealthHistoryWriter(bytePath, {
        maxSamples: 20,
        maxBytes: rowBytes * 2,
        maxRecordBytes: rowBytes,
      });
      for (let sequence = 1; sequence <= 4; sequence += 1) await byteWriter.append(historySnapshot(sequence));
      const bytes = await readFile(bytePath, 'utf8');
      const byteRows = bytes.trim().split('\n').map((line) => JSON.parse(line) as LiveHealthSnapshot);
      expect((await stat(bytePath)).size).toBeLessThanOrEqual(rowBytes * 2);
      expect(byteRows.map((row) => row.sequence)).toEqual([3, 4]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains an oversized fleet snapshot instead of permanently skipping history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-live-health-history-fleet-'));
    try {
      const snapshot = historySnapshot(1);
      const writers: Record<string, LiveHealthSnapshot['writers'][string]> = {};
      const observations = emptyLiveHealthObservations();
      for (let index = 0; index < 700; index += 1) {
        const id = `monitor.host:${index}`;
        writers[id] = { id, kind: 'monitor', instanceId: `fleet-${index}`, pid: index + 1, platform: 'linux', startedAtMs: 1_000 };
        observations['disk.freeBytes'][id] = {
          ...snapshot.signals['disk.freeBytes'], state: 'measured', value: index + 1, writerId: id,
          reason: null, lastMeasuredAtMs: snapshot.sampledAtMs,
        };
      }
      const fleet = { ...snapshot, writers, observations };
      expect(Buffer.byteLength(JSON.stringify(fleet))).toBeGreaterThan(256 * 1024);
      const writer = new LiveHealthHistoryWriter(join(root, 'samples.jsonl'));
      expect(await writer.append(fleet)).toBe(true);
      expect((await stat(writer.path)).size).toBeLessThanOrEqual(writer.maxRecordBytes);
      expect(decodeLiveHealthHistorySnapshot((await readFile(writer.path, 'utf8')).trim().split('\n'))).toEqual(fleet);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains complete multi-row samples across restart and sample-count compaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-live-health-history-parts-'));
    try {
      const path = join(root, 'samples.jsonl');
      const options = { maxRecordBytes: 512, maxBytes: 100_000, maxSamples: 2 };
      const writer = new LiveHealthHistoryWriter(path, options);
      expect(await writer.append(historySnapshot(1))).toBe(true);
      const firstRows = (await readFile(path, 'utf8')).trim().split('\n');
      expect(firstRows.length).toBeGreaterThan(1);
      expect(firstRows.every((row) => Buffer.byteLength(row) + 1 <= 512)).toBe(true);
      expect(decodeLiveHealthHistorySnapshot(firstRows)).toEqual(historySnapshot(1));
      const restarted = new LiveHealthHistoryWriter(path, options);
      expect(await restarted.append(historySnapshot(2))).toBe(true);
      expect(await restarted.append(historySnapshot(3))).toBe(true);
      const rows = (await readFile(path, 'utf8')).trim().split('\n');
      const secondParts = JSON.parse(rows[0]!).parts as number;
      expect(decodeLiveHealthHistorySnapshot(rows.slice(0, secondParts))).toEqual(historySnapshot(2));
      expect(decodeLiveHealthHistorySnapshot(rows.slice(secondParts))).toEqual(historySnapshot(3));
      expect((await stat(path)).size).toBeLessThanOrEqual(options.maxBytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads legacy snapshots and rejects missing, altered or reordered encoded parts', async () => {
    expect(decodeLiveHealthHistorySnapshot([JSON.stringify(historySnapshot(1))])).toEqual(historySnapshot(1));
    const root = await mkdtemp(join(tmpdir(), 'papercusp-live-health-history-integrity-'));
    try {
      const writer = new LiveHealthHistoryWriter(join(root, 'samples.jsonl'), { maxRecordBytes: 512 });
      expect(await writer.append(historySnapshot(1))).toBe(true);
      const rows = (await readFile(writer.path, 'utf8')).trim().split('\n');
      expect(decodeLiveHealthHistorySnapshot(rows.slice(1))).toBeNull();
      expect(decodeLiveHealthHistorySnapshot([...rows].reverse())).toBeNull();
      const damaged = JSON.parse(rows[0]!); damaged.sha256 = '0'.repeat(64);
      expect(decodeLiveHealthHistorySnapshot([JSON.stringify(damaged), ...rows.slice(1)])).toBeNull();
      damaged.sourceBytes = 64 * 1024 * 1024;
      expect(decodeLiveHealthHistorySnapshot([JSON.stringify(damaged), ...rows.slice(1)])).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never retains a partial encoded sample when byte compaction or an interrupted append cuts a frame', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-live-health-history-byte-parts-'));
    try {
      const path = join(root, 'samples.jsonl');
      const first = new LiveHealthHistoryWriter(path, { maxRecordBytes: 512 });
      expect(await first.append(historySnapshot(1))).toBe(true);
      const frame = (await readFile(path, 'utf8')).trim().split('\n');
      const bytes = (await stat(path)).size;
      const bounded = new LiveHealthHistoryWriter(path, { maxRecordBytes: 512, maxBytes: bytes * 2 + 128, maxSamples: 20 });
      expect(await bounded.append(historySnapshot(2))).toBe(true);
      expect(await bounded.append(historySnapshot(3))).toBe(true);
      const rows = (await readFile(path, 'utf8')).trim().split('\n');
      for (let index = 0; index < rows.length;) {
        const parts = JSON.parse(rows[index]!).parts as number;
        expect(decodeLiveHealthHistorySnapshot(rows.slice(index, index + parts))).not.toBeNull();
        index += parts;
      }
      expect((await stat(path)).size).toBeLessThanOrEqual(bytes * 2 + 128);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, frame.slice(1).join('\n') + '\n');
      const recovered = new LiveHealthHistoryWriter(path, { maxRecordBytes: 512 });
      expect(await recovered.append(historySnapshot(4))).toBe(true);
      expect(decodeLiveHealthHistorySnapshot((await readFile(path, 'utf8')).trim().split('\n'))).toEqual(historySnapshot(4));
      const tooSmall = new LiveHealthHistoryWriter(join(root, 'too-small.jsonl'), { maxBytes: 100, maxRecordBytes: 100 });
      expect(await tooSmall.append(historySnapshot(4))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('LiveHealthMonitor composition', () => {
  it.each([false, true])('diagnoses slow archival success/failure and separates subsequent idle delay: %s', async (failHistory) => {
    let tick = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => tick);
    const log = vi.fn();
    const monitor = new LiveHealthMonitor({ paths: PATHS, now: () => 2_000 + tick,
      collectHost: async () => { tick += 40; return counters(); },
      readFragments: async () => { tick += 60; return []; },
      writeSnapshot: async () => { tick += 100; },
      writeHistory: async () => { tick += 16_000; if (failHistory) throw new Error('archive unavailable'); }, log });
    try {
      await monitor.sampleOnce();
      const slow = log.mock.calls.find(([line]) => line.startsWith('[resource-governor-health] sample exceeded freshness: '))![0];
      expect(JSON.parse(slow.slice(slow.indexOf('{')))).toEqual({
        sequence: 1, outcome: 'complete', sampleMs: 16_200,
        phases: { collectHost: 40, readFragments: 60, compose: 0, writeSnapshot: 100, historyYield: 0, history: 16_000 },
      });
      expect(log.mock.calls.some(([line]) => line.includes('history write failed: archive unavailable'))).toBe(failHistory);
      tick += 1_200;
      await monitor.sampleOnce();
      const gap = log.mock.calls.find(([line]) => line.startsWith('[resource-governor-health] sample gap exceeded freshness: '))![0];
      expect(JSON.parse(gap.slice(gap.indexOf('{')))).toMatchObject({
        gapMs: 17_400, previousSampleMs: 16_200, sinceCompletionMs: 1_200,
        previousPhases: { history: 16_000 },
      });
    } finally { await monitor.stop(); clock.mockRestore(); }
  });

  it('detects an idle cadence gap after a fast sample without blaming archival work', async () => {
    let tick = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => tick);
    const log = vi.fn();
    const monitor = new LiveHealthMonitor({ paths: PATHS, now: () => 2_000 + tick,
      collectHost: async () => counters(), readFragments: async () => [],
      writeSnapshot: async () => { tick += 100; }, writeHistory: async () => { tick += 100; }, log });
    try {
      await monitor.sampleOnce();
      expect(log).not.toHaveBeenCalled();
      tick += 20_000;
      await monitor.sampleOnce();
      expect(log).toHaveBeenCalledTimes(1);
      const line = log.mock.calls[0]![0];
      expect(line).toContain('sample gap exceeded freshness: ');
      expect(JSON.parse(line.slice(line.indexOf('{')))).toMatchObject({
        gapMs: 20_200, previousSampleMs: 200, sinceCompletionMs: 20_000,
        previousPhases: { history: 100, writeSnapshot: 100 },
      });
    } finally { await monitor.stop(); clock.mockRestore(); }
  });

  it('records the slow failing phase without reporting unexecuted history', async () => {
    let tick = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => tick);
    const log = vi.fn();
    const writeHistory = vi.fn(async () => {});
    const monitor = new LiveHealthMonitor({ paths: PATHS, now: () => 2_000 + tick,
      collectHost: async () => counters(), readFragments: async () => [],
      writeSnapshot: async () => { tick += 16_000; throw new Error('snapshot unavailable'); }, writeHistory, log });
    try {
      await expect(monitor.sampleOnce()).rejects.toThrow('snapshot unavailable');
      expect(writeHistory).not.toHaveBeenCalled();
      const line = log.mock.calls[0]![0];
      const diagnostic = JSON.parse(line.slice(line.indexOf('{')));
      expect(diagnostic).toMatchObject({ outcome: 'failed', sampleMs: 16_000, phases: { writeSnapshot: 16_000 } });
      expect(diagnostic.phases).not.toHaveProperty('history');
    } finally { await monitor.stop(); clock.mockRestore(); }
  });

  it.each([false, true])('publishes readiness before stalled history and coalesces ticks until persistence settles: %s', async (failHistory) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let settleHistory!: () => void;
    const gate = new Promise<void>((resolve, reject) => {
      settleHistory = failHistory ? () => reject(new Error('history unavailable')) : resolve;
    });
    const collectHost = vi.fn(async () => counters());
    const writeSnapshot = vi.fn(async () => {});
    const writeHistory = vi.fn(async () => gate);
    const log = vi.fn();
    const monitor = new LiveHealthMonitor({ paths: PATHS, now: () => 2_000, cadenceMs: 250,
      collectHost, readFragments: async () => [], writeSnapshot, writeHistory, log });
    try {
      const [first, concurrentStart] = await Promise.all([monitor.start(), monitor.start()]);
      expect(concurrentStart).toBe(first);
      expect(writeSnapshot).toHaveBeenCalledWith(PATHS.snapshotPath, first);
      await yieldToEventLoop();
      expect(writeHistory).toHaveBeenCalledExactlyOnceWith(first);
      const pendingSample = monitor.sampleOnce();
      let completed = false;
      void pendingSample.then(() => { completed = true; });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(completed).toBe(false);
      expect(collectHost).toHaveBeenCalledTimes(1);
      expect(writeSnapshot).toHaveBeenCalledTimes(1);
      expect(writeHistory).toHaveBeenCalledTimes(1);
      let stopped = false;
      const stopping = monitor.stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      settleHistory();
      expect(await pendingSample).toBe(first);
      await stopping;
      expect(stopped).toBe(true);
      expect(log.mock.calls).toEqual(failHistory
        ? [['[resource-governor-health] history write failed: history unavailable']] : []);
      const second = await monitor.sampleOnce();
      expect(second.sequence).toBe(2);
      expect(collectHost).toHaveBeenCalledTimes(2);
      expect(writeHistory).toHaveBeenCalledTimes(2);
    } finally {
      settleHistory();
      await monitor.stop();
      vi.useRealTimers();
    }
  });

  it('refuses readiness when atomic publication fails and permits a fresh sample after recovery', async () => {
    const writeHistory = vi.fn(async () => {});
    const writeSnapshot = vi.fn().mockRejectedValueOnce(new Error('snapshot unavailable')).mockResolvedValue(undefined);
    const monitor = new LiveHealthMonitor({ paths: PATHS, now: () => 2_000,
      collectHost: async () => counters(), readFragments: async () => [], writeSnapshot, writeHistory });
    try {
      await expect(monitor.start()).rejects.toThrow('snapshot unavailable');
      expect(writeHistory).not.toHaveBeenCalled();
      const recovered = await monitor.start();
      expect(recovered.sequence).toBe(2);
      await monitor.sampleOnce();
      expect(writeHistory).toHaveBeenCalledExactlyOnceWith(recovered);
    } finally { await monitor.stop(); }
  });

  it('does not arm cadence after shutdown while the first collection is pending', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let releaseCollection!: () => void;
    const gate = new Promise<void>((resolve) => { releaseCollection = resolve; });
    const collectHost = vi.fn(async () => { await gate; return counters(); });
    const monitor = new LiveHealthMonitor({ paths: PATHS, now: () => 2_000, cadenceMs: 250,
      collectHost, readFragments: async () => [], writeSnapshot: async () => {}, writeHistory: async () => {} });
    try {
      const starting = monitor.start();
      const stopping = monitor.stop();
      releaseCollection();
      await starting;
      await stopping;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(collectHost).toHaveBeenCalledTimes(1);
    } finally {
      releaseCollection();
      await monitor.stop();
      vi.useRealTimers();
    }
  });

  it('records byte/inode counters and one reservation budget per physical device, retaining failed paths', async () => {
    const reservations = vi.fn((path: string) => ({ state: 'measured' as const, deviceKey: `dev-${path === '/' ? 1 : 2}`,
      reservedBytes: path === '/' ? 10 : 20, knownReservedBytes: path === '/' ? 10 : 20, issues: [] }));
    const storage = await collectLiveHealthStorage(['/', '/data', '/data-alias', '/missing'], () => 2_000, {
      filesystem: async (path) => {
        if (path === '/missing') throw new Error('ENOENT');
        return { dev: path === '/' ? 1 : 2, totalBytes: 1_000, availableBytes: 100, totalInodes: 50, freeInodes: 5 };
      }, reservations,
    });
    expect(reservations).toHaveBeenCalledTimes(2);
    expect(storage.snapshots.filter((row) => row.dev === 2).map((row) => row.reservedBytes)).toEqual([20, 20]);
    expect(storage.snapshots.find((row) => row.path === '/missing')).toMatchObject({
      state: 'unknown', availableBytes: null, totalInodes: null, reservedBytes: null, issues: ['ENOENT'],
    });
    const root = await mkdtemp(join(tmpdir(), 'live-health-storage-'));
    try {
      const monitor = new LiveHealthMonitor({ paths: PATHS, now: () => 2_000,
        collectHost: async () => counters({ storage }), readFragments: async () => [],
        writeSnapshot: async () => {}, writeHistory: async (snapshot) => {
          await new LiveHealthHistoryWriter(join(root, 'history.jsonl')).append(snapshot);
        } });
      const snapshot = await monitor.sampleOnce();
      expect(snapshot.storage).toEqual(storage);
      const decoded = decodeLiveHealthHistorySnapshot((await readFile(join(root, 'history.jsonl'), 'utf8')).trim().split('\n'));
      expect(decoded?.storage).toEqual(storage);
      expect(decoded?.observations).toEqual(snapshot.observations);
      const invalid = structuredClone(snapshot);
      (invalid.storage!.snapshots[3] as { availableBytes: number | null }).availableBytes = 0;
      expect(isLiveHealthSnapshot(invalid)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not turn unreadable reservations, invalid counters or changed device identity into healthy capacity', async () => {
    const unknown = await collectLiveHealthStorage(['/'], () => 2_000, {
      filesystem: async () => ({ dev: 1, totalBytes: 100, availableBytes: 10, totalInodes: 0, freeInodes: 0 }),
      reservations: () => ({ state: 'unknown', deviceKey: 'dev-1', reservedBytes: null, knownReservedBytes: 0, issues: ['unreadable'] }),
    });
    expect(unknown.snapshots[0]).toMatchObject({ state: 'measured', reservationState: 'unknown', reservedBytes: null, totalInodes: 0 });
    const changed = await collectLiveHealthStorage(['/'], () => 2_000, {
      filesystem: async () => ({ dev: 1, totalBytes: 100, availableBytes: 10, totalInodes: 5, freeInodes: 1 }),
      reservations: () => ({ state: 'measured', deviceKey: 'dev-2', reservedBytes: 0, knownReservedBytes: 0, issues: [] }),
    });
    expect(changed.snapshots[0]).toMatchObject({ state: 'unknown', reservedBytes: null, issues: ['reservation-device-changed'] });
    const invalid = await collectLiveHealthStorage(['/'], () => 2_000, {
      filesystem: async () => ({ dev: 1, totalBytes: 100, availableBytes: 101, totalInodes: 0, freeInodes: 1 }),
      reservations: () => { throw new Error('must not read invalid counters'); },
    });
    expect(invalid.snapshots[0]).toMatchObject({ state: 'unknown', issues: ['invalid-counters'] });
  });

  it('writes one versioned snapshot with resource-profile normalization and explicit observations', async () => {
    const writeSnapshot = vi.fn(async () => {});
    const writeHistory = vi.fn(async () => {});
    const profile = {
      signals: {
        cores: 6,
        physicalCores: 8,
        totalMemBytes: 10_000,
        freeMemBytes: 2_000,
        embeddedPg: false,
        hostRole: 'full',
      },
    } as ResourceProfile;
    const monitor = new LiveHealthMonitor({
      paths: PATHS,
      cadenceMs: 2_000,
      now: () => 2_000,
      resourceProfile: profile,
      collectHost: async () => counters(),
      readFragments: async () => [],
      writeSnapshot,
      writeHistory,
    });
    const snapshot = await monitor.sampleOnce();
    expect(snapshot.schemaVersion).toBe(LIVE_HEALTH_SCHEMA_VERSION);
    expect(snapshot.profile).toMatchObject({
      effectiveCores: 6,
      physicalCores: 8,
      source: '@papercusp/resource-profile',
    });
    expect(snapshot.signals['memory.hostUsedBytes']).toMatchObject({
      state: 'measured',
      value: 750,
      writerId: monitor.writer.id,
    });
    expect(snapshot.observations['memory.hostUsedBytes'][monitor.writer.id]).toEqual(
      snapshot.signals['memory.hostUsedBytes'],
    );
    expect(snapshot.signals['database.waitP95Ms']).toMatchObject({
      state: 'unknown',
      value: null,
      reason: 'writer-not-observed',
    });
    expect(writeSnapshot).toHaveBeenCalledWith(PATHS.snapshotPath, snapshot);
    expect(writeHistory).toHaveBeenCalledWith(snapshot);
  });
});
