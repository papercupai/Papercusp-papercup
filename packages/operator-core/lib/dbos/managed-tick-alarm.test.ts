import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureScheduledRegistry, managedSetInterval, resetScheduledRegistry } from '@papercusp/scheduled-registry';
import { installManagedTickAlarm } from './managed-tick-alarm';

vi.mock('@dbos-inc/dbos-sdk', () => { throw new Error('DBOS unavailable'); });

afterEach(() => {
  resetScheduledRegistry();
  vi.useRealTimers();
});

describe('production managed tick alarm adapter', () => {
  it('raises and resolves actual shared alarm state while DBOS is unavailable', async () => {
    // Load the shared rail before advancing fake time; module I/O uses real event-loop turns.
    await import('../alarm-attention');
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const log = vi.fn();
    configureScheduledRegistry({ log });
    const open = new Set<string>();
    const notify = vi.fn(async () => {});
    const broadcast = vi.fn(async ({ conditionKey }) => { open.add(conditionKey); return true; });
    const resolve = vi.fn(async ({ conditionKey }) => { open.delete(conditionKey); return true; });
    installManagedTickAlarm({ notify, broadcast, resolve, recentlyEscalated: async () => false });
    let finish!: () => void;
    managedSetInterval('production-held', 10_000, () => new Promise<void>((r) => { finish = r; }), { category: 'global-sweep' });
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(open.size).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => { expect(open.size).toBe(1); });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      importance: 'urgent', title: expect.stringContaining('production-held'),
      body: expect.stringContaining('310000ms'),
    }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(broadcast).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => { expect(open.size).toBe(0); });
    expect(resolve.mock.calls[0][0].conditionKey).toBe(broadcast.mock.calls[0][0].conditionKey);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('tick still running'));
    expect(log.mock.calls.some(([message]) => message.includes('alarm delivery failed'))).toBe(false);
  });

  it('leaves completed and empty ticks off the alarm delivery rail', async () => {
    vi.useFakeTimers();
    const broadcast = vi.fn(async () => true);
    const notify = vi.fn(async () => {});
    installManagedTickAlarm({ broadcast, notify, recentlyEscalated: async () => false });
    managedSetInterval('empty', 1_000, async () => {}, { category: 'global-sweep' });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(broadcast).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
