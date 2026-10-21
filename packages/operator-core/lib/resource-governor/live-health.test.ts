import { describe, expect, it } from 'vitest';
import {
  LIVE_HEALTH_FRAGMENT_SCHEMA_VERSION,
  LIVE_HEALTH_SCHEMA_VERSION,
  LIVE_HEALTH_SIGNAL_KEYS,
  LIVE_HEALTH_SIGNAL_SPECS,
  emptyLiveHealthObservations,
  emptyLiveHealthSignals,
  isLiveHealthFragment,
  liveHealthWindow,
  measuredLiveHealthReading,
  mergeLiveHealthFragments,
  unknownLiveHealthReading,
  type LiveHealthFragment,
  type LiveHealthWriter,
} from './live-health';

const NOW = 1_700_000_100_000;

function writer(id: string, kind: LiveHealthWriter['kind']): LiveHealthWriter {
  return { id, kind, instanceId: `${id}:instance`, pid: 12, platform: 'linux', startedAtMs: NOW - 60_000 };
}

describe('resource-governor live-health contract', () => {
  it('declares writer, unit, window, freshness, platform, and description for every required signal family', () => {
    expect(LIVE_HEALTH_SIGNAL_KEYS.length).toBe(Object.keys(LIVE_HEALTH_SIGNAL_SPECS).length);
    for (const key of LIVE_HEALTH_SIGNAL_KEYS) {
      const spec = LIVE_HEALTH_SIGNAL_SPECS[key];
      expect(spec.writerKind).toMatch(/^(monitor|operator|database|service|provider|queue|governor)$/);
      expect(spec.unit.length).toBeGreaterThan(0);
      expect(spec.windowKind).toMatch(/^(instant|delta|rolling)$/);
      expect(spec.freshForMs).toBeGreaterThan(0);
      expect(spec.platforms.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(10);
    }
    expect(LIVE_HEALTH_SIGNAL_KEYS).toEqual(
      expect.arrayContaining([
        'progress.heartbeatLagMs',
        'cpu.psiSomePct',
        'io.psiSomePct',
        'io.psiFullPct',
        'io.processReadBytesPerSec',
        'io.processWriteBytesPerSec',
        'latency.eventLoopP95Ms',
        'memory.workingSetGrowthBytesPerSec',
        'memory.gcPauseP95Ms',
        'memory.majorFaultsPerSec',
        'memory.swapOutBytesPerSec',
        'database.waitP95Ms',
        'service.waitP95Ms',
        'descriptor.openCount',
        'socket.closeWaitCount',
        'disk.freeBytes',
        'network.rxBytesPerSec',
        'provider.rateLimited',
        'queue.writerLatencyP95Ms',
        'governor.admissionLatencyP95Ms',
      ]),
    );
    expect(LIVE_HEALTH_SCHEMA_VERSION).toBe('resource-governor-live-health-v2');
    expect(LIVE_HEALTH_SIGNAL_SPECS['io.psiFullPct']).toMatchObject({
      unit: 'percent',
      writerKind: 'monitor',
      windowKind: 'rolling',
      platforms: ['linux'],
    });
    expect(LIVE_HEALTH_SIGNAL_SPECS['io.processReadBytesPerSec']).toMatchObject({
      unit: 'bytes-per-second',
      writerKind: 'operator',
      windowKind: 'delta',
      platforms: ['linux'],
    });
    expect(JSON.stringify(LIVE_HEALTH_SIGNAL_SPECS)).not.toMatch(/maxSimultaneous|pgPoolMax|capacityCeiling/i);
  });

  it('never turns unknown or non-finite evidence into a healthy zero', () => {
    const unknown = unknownLiveHealthReading({
      key: 'memory.psiFullPct',
      writerId: 'monitor:1',
      observedAtMs: NOW,
      reason: 'unsupported-on-win32',
    });
    expect(unknown).toMatchObject({ state: 'unknown', value: null, confidence: 0, reason: 'unsupported-on-win32' });

    const nonFinite = measuredLiveHealthReading({
      key: 'cpu.hostUtilizationPct',
      writerId: 'monitor:1',
      observedAtMs: NOW,
      window: liveHealthWindow('delta', NOW - 2_000, NOW),
      value: Number.NaN,
    });
    expect(nonFinite).toMatchObject({ state: 'unknown', value: null, reason: 'non-finite-observation' });

    const empty = emptyLiveHealthSignals(NOW);
    expect(Object.keys(empty)).toHaveLength(LIVE_HEALTH_SIGNAL_KEYS.length);
    expect(Object.values(empty).every((reading) => reading.state === 'unknown' && reading.value === null)).toBe(true);
  });

  it('rejects a fragment whose writer kind or unit does not own the signal', () => {
    const goodWriter = writer('provider:acct-a', 'provider');
    const good: LiveHealthFragment = {
      schemaVersion: LIVE_HEALTH_FRAGMENT_SCHEMA_VERSION,
      publishedAtMs: NOW,
      writer: goodWriter,
      signals: {
        'provider.rateLimited': measuredLiveHealthReading({
          key: 'provider.rateLimited',
          value: true,
          writerId: goodWriter.id,
          observedAtMs: NOW,
          window: liveHealthWindow('instant', NOW, NOW),
        }),
      },
    };
    expect(isLiveHealthFragment(good)).toBe(true);
    expect(isLiveHealthFragment({ ...good, writer: { ...good.writer, kind: 'queue' } })).toBe(false);
    expect(
      isLiveHealthFragment({
        ...good,
        signals: { 'provider.rateLimited': { ...good.signals['provider.rateLimited'], unit: 'bytes' } },
      }),
    ).toBe(false);
  });

  it('preserves every writer-scoped observation while the compact signal picks only the newest', () => {
    const newer = writer('operator.process:2', 'operator');
    const older = writer('operator.process:1', 'operator');
    const fragment = (owner: LiveHealthWriter, observedAtMs: number, value: number): LiveHealthFragment => ({
      schemaVersion: LIVE_HEALTH_FRAGMENT_SCHEMA_VERSION,
      publishedAtMs: observedAtMs,
      writer: owner,
      signals: {
        'memory.workingSetBytes': measuredLiveHealthReading({
          key: 'memory.workingSetBytes',
          value,
          writerId: owner.id,
          observedAtMs,
          window: liveHealthWindow('instant', observedAtMs, observedAtMs),
        }),
      },
    });
    const signals = emptyLiveHealthSignals(NOW);
    const observations = emptyLiveHealthObservations();
    const writers = {};
    mergeLiveHealthFragments(
      signals,
      writers,
      [fragment(older, NOW - 2_000, 10), fragment(newer, NOW - 1_000, 20)],
      NOW,
      observations,
    );
    expect(signals['memory.workingSetBytes']).toMatchObject({ writerId: newer.id, value: 20 });
    expect(Object.keys(observations['memory.workingSetBytes']).sort()).toEqual([newer.id, older.id].sort());
  });

  it('never lets a newer writer that cannot measure a signal shadow a fresh measurement from another writer', () => {
    const key = 'latency.eventLoopP95Ms' as const;
    const unmonitored = writer('operator.process:3528160', 'operator');
    const measuring = writer('operator.process:2389820', 'operator');
    const expiredWriter = writer('operator.process:77', 'operator');
    const fragment = (owner: LiveHealthWriter, publishedAtMs: number, value: number | null): LiveHealthFragment => ({
      schemaVersion: LIVE_HEALTH_FRAGMENT_SCHEMA_VERSION,
      publishedAtMs,
      writer: owner,
      signals: {
        [key]:
          value === null
            ? unknownLiveHealthReading({
                key,
                writerId: owner.id,
                observedAtMs: publishedAtMs,
                window: liveHealthWindow('rolling', publishedAtMs, publishedAtMs),
                reason: 'event-loop-monitor-unavailable',
              })
            : measuredLiveHealthReading({
                key,
                value,
                writerId: owner.id,
                observedAtMs: publishedAtMs,
                window: liveHealthWindow('rolling', publishedAtMs - 10_000, publishedAtMs),
              }),
      },
    });

    const signals = emptyLiveHealthSignals(NOW);
    const observations = emptyLiveHealthObservations();
    mergeLiveHealthFragments(
      signals,
      {},
      [fragment(measuring, NOW - 5_000, 37.3), fragment(unmonitored, NOW - 500, null)],
      NOW,
      observations,
    );
    expect(signals[key]).toMatchObject({ state: 'measured', writerId: measuring.id, value: 37.3 });
    expect(observations[key][unmonitored.id]).toMatchObject({ state: 'unknown' });

    // With no fresh measurement anywhere, expired evidence still outranks no evidence.
    const expiredAtMs = NOW - LIVE_HEALTH_SIGNAL_SPECS[key].freshForMs - 1;
    const fallback = emptyLiveHealthSignals(NOW);
    mergeLiveHealthFragments(
      fallback,
      {},
      [fragment(expiredWriter, expiredAtMs, 12), fragment(unmonitored, NOW - 500, null)],
      NOW,
    );
    expect(fallback[key]).toMatchObject({ state: 'stale', writerId: expiredWriter.id, value: null });

    // An expired UNKNOWN never carried evidence, so it must not outrank a fresh unknown.
    const neither = emptyLiveHealthSignals(NOW);
    mergeLiveHealthFragments(
      neither,
      {},
      [fragment(expiredWriter, expiredAtMs, null), fragment(unmonitored, NOW - 500, null)],
      NOW,
    );
    expect(neither[key]).toMatchObject({
      state: 'unknown',
      writerId: unmonitored.id,
      reason: 'event-loop-monitor-unavailable',
    });
  });

  it('turns an expired reading stale without carrying its numeric value forward', () => {
    const owner = writer('provider:acct-a', 'provider');
    const observedAtMs = NOW - LIVE_HEALTH_SIGNAL_SPECS['provider.waitP95Ms'].freshForMs - 1;
    const fragment: LiveHealthFragment = {
      schemaVersion: LIVE_HEALTH_FRAGMENT_SCHEMA_VERSION,
      publishedAtMs: observedAtMs,
      writer: owner,
      signals: {
        'provider.waitP95Ms': measuredLiveHealthReading({
          key: 'provider.waitP95Ms',
          value: 900,
          writerId: owner.id,
          observedAtMs,
          window: liveHealthWindow('rolling', observedAtMs - 10_000, observedAtMs),
        }),
      },
    };
    const signals = emptyLiveHealthSignals(NOW);
    mergeLiveHealthFragments(signals, {}, [fragment], NOW);
    expect(signals['provider.waitP95Ms']).toMatchObject({
      state: 'stale',
      value: null,
      lastMeasuredAtMs: observedAtMs,
      reason: 'freshness-window-expired',
    });
  });
});
