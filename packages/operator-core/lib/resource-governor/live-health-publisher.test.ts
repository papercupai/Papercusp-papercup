import { describe, expect, it, vi } from 'vitest';
import { parseProcessIoCounters, ProcessLiveHealthPublisher } from './live-health-publisher';
import type { LiveHealthPaths } from './live-health-monitor';

const PATHS: LiveHealthPaths = {
  rootDir: '/tmp/health',
  fragmentsDir: '/tmp/health/fragments',
  snapshotPath: '/tmp/health/live-health.json',
};

describe('ProcessLiveHealthPublisher', () => {
  it('parses complete process I/O counters and rejects missing or unsafe values', () => {
    expect(parseProcessIoCounters('rchar: 300\nread_bytes: 100\nwrite_bytes: 200\n')).toEqual({
      readBytes: 100,
      writeBytes: 200,
    });
    expect(parseProcessIoCounters('read_bytes: 100\n')).toBeNull();
    expect(parseProcessIoCounters('read_bytes: 9007199254740992\nwrite_bytes: 200\n')).toBeNull();
  });

  it('publishes true process deltas, including negative working-set growth, with correct CPU units', async () => {
    const samples = [
      { atMs: 1_000, cpuMicros: 100_000, rssBytes: 1_000, minorFaults: 10, majorFaults: 2 },
      { atMs: 3_000, cpuMicros: 1_100_000, rssBytes: 500, minorFaults: 30, majorFaults: 4 },
    ];
    const ioSamples = [
      { readBytes: 1_000, writeBytes: 2_000 },
      { readBytes: 2_000, writeBytes: 2_500 },
    ];
    const writeFragment = vi.fn(async () => {});
    const publisher = new ProcessLiveHealthPublisher({
      paths: PATHS,
      cadenceMs: 2_000,
      now: () => 1,
      pid: 77,
      readCounters: () => samples.shift()!,
      readIoCounters: async () => ioSamples.shift() ?? null,
      readDescriptorCount: async () => 12,
      readLoopLag: () => ({
        p50Ms: 1,
        p95Ms: 7,
        p99Ms: 9,
        maxMs: 10,
        sampleCount: 20,
        windowMs: 2_000,
        windowMature: true,
      }),
      writeFragment,
    });
    const first = await publisher.publishOnce();
    expect(first.signals['cpu.processUtilizationPct']).toMatchObject({ state: 'unknown', value: null });
    expect(first.signals['io.processReadBytesPerSec']).toMatchObject({ state: 'unknown', value: null });

    const second = await publisher.publishOnce();
    expect(second.signals['cpu.processUtilizationPct']?.value).toBe(50);
    expect(second.signals['memory.workingSetGrowthBytesPerSec']?.value).toBe(-250);
    expect(second.signals['memory.minorFaultsPerSec']?.value).toBe(10);
    expect(second.signals['memory.majorFaultsPerSec']?.value).toBe(1);
    expect(second.signals['latency.eventLoopP95Ms']?.value).toBe(7);
    expect(second.signals['descriptor.openCount']?.value).toBe(12);
    expect(second.signals['io.processReadBytesPerSec']).toMatchObject({ state: 'measured', value: 500 });
    expect(second.signals['io.processWriteBytesPerSec']).toMatchObject({ state: 'measured', value: 250 });
    expect(writeFragment).toHaveBeenCalledTimes(2);
  });
});
