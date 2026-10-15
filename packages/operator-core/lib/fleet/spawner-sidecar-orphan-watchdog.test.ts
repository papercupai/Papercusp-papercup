import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as recorder from '../degradation/fallback-observations';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  armSpawnerSidecarOrphanWatchdog,
  ORPHAN_CHECK_INTERVAL_MS,
} from './spawner-sidecar-orphan-watchdog';

describe('spawner-sidecar owner-death watchdog (P-005)', () => {
  beforeEach(() => { vi.spyOn(recorder, 'observeFallback').mockReturnValue(true); });
  afterEach(() => { vi.restoreAllMocks(); });
  it('keeps the server alive for a live owner and flushes before shutting down after owner death', async () => {
    const callbacks: Array<() => void> = [];
    let ownerAlive = true;
    const schedule = vi.fn(
      (
        _name: string,
        _intervalMs: number,
        callback: () => void,
        _options: { category: 'watchdog'; classification: 'must-sample' },
      ) => callbacks.push(callback),
    );
    const shutdown = vi.fn();
    let finishFlush!: () => void;
    const flushObservations = vi.fn(() => new Promise<void>((resolve) => { finishFlush = resolve; }));
    const logger = { log: vi.fn(), warn: vi.fn() };

    armSpawnerSidecarOrphanWatchdog(
      '/tmp/papercusp-spawner-49217.sock',
      shutdown,
      {
        isPidAlive: () => ownerAlive,
        schedule,
        logger,
        flushObservations,
      },
    );

    expect(schedule).toHaveBeenCalledWith(
      'spawner-sidecar-orphan-watchdog',
      ORPHAN_CHECK_INTERVAL_MS,
      expect.any(Function),
      { category: 'watchdog', classification: 'must-sample' },
    );
    expect(callbacks).toHaveLength(1);

    callbacks[0]!();
    expect(shutdown).not.toHaveBeenCalled();

    ownerAlive = false;
    const closing = callbacks[0]!();
    await Promise.resolve(); // bounded flush starts its thunk after arming the deadline
    expect(flushObservations).toHaveBeenCalledOnce();
    expect(shutdown).not.toHaveBeenCalled();
    finishFlush();
    await closing;
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('owner pid 49217 is gone'));
    expect(shutdown).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledWith('owner-gone');
  });

  it('does not arm against an explicit socket path with no derivable owner PID', () => {
    const schedule = vi.fn();
    const shutdown = vi.fn();
    const logger = { log: vi.fn(), warn: vi.fn() };

    armSpawnerSidecarOrphanWatchdog('/tmp/spawner.sock', shutdown, { schedule, logger });

    expect(schedule).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('orphan watchdog not armed'),
    );
  });

  it('still shuts down when the observation flush never settles', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let tick!: () => void;
    const shutdown = vi.fn();
    try {
      armSpawnerSidecarOrphanWatchdog('/tmp/papercusp-spawner-49217.sock', shutdown, {
        schedule: (_name, _interval, callback) => { tick = callback; },
        isPidAlive: () => false,
        flushObservations: () => new Promise(() => {}),
        logger: { log() {}, warn() {} },
      });
      const closing = tick();
      await vi.advanceTimersByTimeAsync(999);
      expect(shutdown).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      expect(shutdown).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sidecar-orphan-flush exceeded 1000ms'));
    } finally { vi.useRealTimers(); }
  });

  it('remains wired into the shared DEV and PACKAGED server startup', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./spawner-sidecar-server.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('armSpawnerSidecarOrphanWatchdog(socketPath, shutdown)');
  });
});
