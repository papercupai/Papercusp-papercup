import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureScheduledRegistry, managedSetInterval, resetScheduledRegistry } from '@papercusp/scheduled-registry';
import { installManagedTickAlarm } from './managed-tick-alarm';
import { workspaceBackgroundActivityAllowed } from '../device-operator-actions';

vi.mock('@dbos-inc/dbos-sdk', () => { throw new Error('DBOS unavailable'); });
vi.mock('../device-operator-actions', () => ({ workspaceBackgroundActivityAllowed: vi.fn() }));

afterEach(() => {
  resetScheduledRegistry();
  vi.mocked(workspaceBackgroundActivityAllowed).mockReset();
  vi.useRealTimers();
});

describe('production managed tick alarm adapter', () => {
  it('checks the declared workspace before fireOnArm and each later fire, including watchdog categories', async () => {
    vi.useFakeTimers();
    vi.mocked(workspaceBackgroundActivityAllowed).mockResolvedValue(false);
    installManagedTickAlarm();
    const tick = vi.fn();
    const featureId = `activity-${'a'.repeat(64)}`;
    managedSetInterval('workspace-optional', 1000, tick, {
      category: 'watchdog', classification: 'must-sample', fireOnArm: true,
      activity: { kind: 'workspace', workspaceId: 'workspace-a', featureId },
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(workspaceBackgroundActivityAllowed).toHaveBeenCalledOnce());
    expect(tick).not.toHaveBeenCalled();
    expect(workspaceBackgroundActivityAllowed).toHaveBeenLastCalledWith('workspace-a', featureId);
    vi.mocked(workspaceBackgroundActivityAllowed).mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(tick).toHaveBeenCalledOnce());
    vi.mocked(workspaceBackgroundActivityAllowed).mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledOnce();
    expect(workspaceBackgroundActivityAllowed).toHaveBeenCalledTimes(3);
  });

  it('keeps explicitly justified control ticks synchronous without consulting optional policy', () => {
    let fire!: () => void;
    configureScheduledRegistry({ setIntervalImpl: callback => { fire = callback; return {}; } });
    installManagedTickAlarm();
    const tick = vi.fn();
    managedSetInterval('control', 1000, tick, {
      category: 'global-sweep',
      activity: { kind: 'required-control', reason: 'Restores the settings control channel.' },
    });
    fire();
    expect(tick).toHaveBeenCalledOnce();
    expect(workspaceBackgroundActivityAllowed).not.toHaveBeenCalled();
  });

  it('withholds malformed scoped registrations before reading any workspace policy', async () => {
    vi.useFakeTimers();
    installManagedTickAlarm();
    vi.mocked(workspaceBackgroundActivityAllowed).mockResolvedValue(true);
    const tick = vi.fn();
    for (const [name, workspaceId, featureId] of [
      ['unknown-workspace', '*', `activity-${'a'.repeat(64)}`],
      ['missing-feature', 'workspace-a', ''],
    ]) managedSetInterval(name, 1000, tick, {
      category: 'global-sweep', activity: { kind: 'workspace', workspaceId, featureId },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).not.toHaveBeenCalled();
    expect(workspaceBackgroundActivityAllowed).not.toHaveBeenCalled();
  });

  it('withholds control declarations without a reason and failed optional-policy reads', async () => {
    vi.useFakeTimers();
    configureScheduledRegistry({ log: vi.fn() });
    installManagedTickAlarm();
    const tick = vi.fn();
    managedSetInterval('empty-control', 1000, tick, {
      category: 'watchdog', activity: { kind: 'required-control', reason: ' ' },
    });
    vi.mocked(workspaceBackgroundActivityAllowed).mockRejectedValue(new Error('private policy body'));
    managedSetInterval('unreadable-policy', 1000, tick, {
      category: 'global-sweep', activity: { kind: 'workspace', workspaceId: 'workspace-a', featureId: `activity-${'b'.repeat(64)}` },
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(workspaceBackgroundActivityAllowed).toHaveBeenCalledOnce());
    expect(tick).not.toHaveBeenCalled();
  });

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
