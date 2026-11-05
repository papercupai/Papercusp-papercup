import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getManaged, resetScheduledRegistry } from '@papercusp/scheduled-registry';
import { reconcileManagedTickAlarms, startManagedTickAlarmRecovery } from './managed-tick-alarm-recovery';

vi.mock('@dbos-inc/dbos-sdk', () => { throw new Error('DBOS unavailable'); });
vi.mock('../pg-notify-bus', () => ({ createNotifyBus: () => ({ subscribe: () => () => {} }) }));
beforeAll(async () => {
  await import('../agent-tools/coordination/condition-state');
  // Module preparation belongs to real-timer startup. The cadence controls
  // below deliberately use fake timers after this default rail is available;
  // the throwing DBOS mock still applies to this import and every test.
  await import('../severe-event-broadcast');
}, 30_000);
afterEach(() => { resetScheduledRegistry(); vi.useRealTimers(); });

function alarm(id = 1, run = 'original'): Record<string, unknown> {
  return { ts: '2026-11-03T00:00:00.000Z', msg_id: `alarm-${run}-${id}`, from: 'system-watchdog',
    condition_key: `alarm:managed-tick:${run}:${id}`, summary: 'held', one_shot: true,
    emitter: { pid: 123, startedAt: '2026-11-02T00:00:00Z', uptimeSec: 60,
      cwd: '/repo', host: 'host', processIdentity: 'kernel-original' },
    data: { id, producerRun: run, timerName: 'subject', timerKey: `subject#${id}`,
      startedAt: 0, heldMs: 310_000, thresholdMs: 300_000, watcherIntervalMs: 1000 },
  };
}

describe('managed tick original-incarnation recovery', () => {
  it('reconciles only the exact original episode after positive death', async () => {
    const resolve = vi.fn(async () => true);
    const result = await reconcileManagedTickAlarms({ read: async () => [alarm()], probe: () => 'dead', resolve });
    expect(result).toEqual({ resolved: ['alarm:managed-tick:original:1'], intervalMs: 1000 });
    expect(resolve).toHaveBeenCalledExactlyOnceWith('alarm:managed-tick:original:1');
  });

  it.each(['alive', 'unknown'] as const)('leaves an %s predecessor open even with a distinct successor', async state => {
    const resolve = vi.fn(async () => true);
    await reconcileManagedTickAlarms({ read: async () => [alarm(), alarm(1, 'successor')],
      probe: () => state, resolve });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('does not substitute quietness, missing provenance, or malformed evidence for death', async () => {
    const malformed = [
      { ...alarm(), emitter: undefined }, { ...alarm(), data: undefined },
      { ...alarm(), one_shot: false },
      { ...alarm(), data: { ...(alarm().data as object), producerRun: 'other' } },
      { ...alarm(), data: { ...(alarm().data as object), watcherIntervalMs: NaN } },
      { ...alarm(), data: { ...(alarm().data as object), heldMs: 100 } },
    ];
    const resolve = vi.fn(async () => true);
    for (const envelope of malformed)
      await reconcileManagedTickAlarms({ read: async () => [envelope], probe: () => 'dead', resolve });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('never repeats a settled episode and never claims a failed resolution as success', async () => {
    const resolve = vi.fn(async () => false);
    const original = alarm();
    const closed = { ts: '2026-11-03T00:00:01.000Z', resolves_condition: original.condition_key };
    expect((await reconcileManagedTickAlarms({ read: async () => [original, closed], probe: () => 'dead', resolve })).resolved)
      .toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
    expect((await reconcileManagedTickAlarms({ read: async () => [original], probe: () => 'dead', resolve })).resolved)
      .toEqual([]);
  });

  it('propagates an unreadable condition store instead of claiming recovery', async () => {
    await expect(reconcileManagedTickAlarms({ read: async () => { throw new Error('store unavailable'); } }))
      .rejects.toThrow('store unavailable');
  });

  it('reconciles immediately on startup and observes the shortest original/local watcher cadence', async () => {
    vi.useFakeTimers();
    const current = alarm();
    const read = vi.fn(async () => [current]);
    const control = startManagedTickAlarmRecovery({ read, probe: () => 'alive' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(getManaged('managed-tick-watch')?.intervalMs).toBe(1000);
    control.observeInterval(250);
    (current.data as Record<string, unknown>).watcherIntervalMs = 250;
    expect(getManaged('managed-tick-watch')?.intervalMs).toBe(250);
    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(2);
    control.observeInterval(10_000);
    expect(getManaged('managed-tick-watch')?.intervalMs).toBe(250);
  });

  it('returns to the idle cadence after the last persisted alarm has settled', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => [alarm()]);
    startManagedTickAlarmRecovery({ read, probe: () => 'alive' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(getManaged('managed-tick-watch')?.intervalMs).toBe(1000);
    read.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(getManaged('managed-tick-watch')?.intervalMs).toBe(60_000);
  });

  it('discovers a later external short-cadence alarm without waiting for the idle poll', async () => {
    vi.useFakeTimers();
    let changed!: () => void;
    let alive = true;
    const resolve = vi.fn(async () => true);
    const read = vi.fn(async (): Promise<Record<string, unknown>[]> => []);
    const control = startManagedTickAlarmRecovery({ read, resolve,
      probe: () => alive ? 'alive' : 'dead',
      subscribe: callback => { changed = callback; return () => {}; },
    });
    await control.ready;
    expect(getManaged('managed-tick-watch')?.intervalMs).toBe(60_000);
    read.mockResolvedValue([alarm()]);
    changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(getManaged('managed-tick-watch')?.intervalMs).toBe(1000);
    expect(resolve).not.toHaveBeenCalled();
    alive = false;
    await vi.advanceTimersByTimeAsync(999);
    expect(resolve).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(resolve).toHaveBeenCalledExactlyOnceWith('alarm:managed-tick:original:1');
    control.stop();
  });

  it('re-reads a change arriving during an older empty snapshot and stops its subscription', async () => {
    vi.useFakeTimers();
    let changed!: () => void;
    let finish!: (value: Record<string, unknown>[]) => void;
    const unsubscribe = vi.fn();
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue([alarm()]);
    const control = startManagedTickAlarmRecovery({ read, probe: () => 'alive',
      subscribe: callback => { changed = callback; return unsubscribe; },
    });
    // Let the dynamic condition-fold import reach the injected snapshot reader.
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    changed();
    finish([]);
    await control.ready;
    expect(read).toHaveBeenCalledTimes(2);
    expect(getManaged('managed-tick-watch')?.intervalMs).toBe(1000);
    control.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
    changed();
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
