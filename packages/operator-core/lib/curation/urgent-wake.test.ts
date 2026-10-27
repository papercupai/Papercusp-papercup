import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The wake module imports the production deps + coord bus at module load; mock
// them so this is a clean unit test of the debounce coalescing (makeDebouncedRunner).
vi.mock('../coord-inbox-bus', () => ({ onCoordInbox: vi.fn(() => () => {}) }));
vi.mock('./deps', () => ({ buildCurationDeps: vi.fn() }));
vi.mock('../workspace-als', () => ({ runWithWorkspace: vi.fn() }));
vi.mock('../dbos/orchestrator-loop', () => ({ orchestratorWorkspaceIds: vi.fn(() => []) }));
vi.mock('./curation-state', () => ({ writeCurationState: vi.fn() }));

import { makeDebouncedRunner } from './urgent-wake';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('makeDebouncedRunner — leading-edge coalescing', () => {
  it('fires immediately on the first trigger', () => {
    const runner = vi.fn();
    const { trigger } = makeDebouncedRunner(runner, 1000);
    trigger();
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst into one leading + one trailing fire', () => {
    const runner = vi.fn();
    const { trigger } = makeDebouncedRunner(runner, 1000);
    trigger(); // leading fire
    trigger();
    trigger(); // these collapse into one pending trailing fire
    expect(runner).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('does not fire a trailing tick when no extra triggers arrived', () => {
    const runner = vi.fn();
    const { trigger } = makeDebouncedRunner(runner, 1000);
    trigger();
    vi.advanceTimersByTime(1000);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('cancel() suppresses the pending trailing fire', () => {
    const runner = vi.fn();
    const { trigger, cancel } = makeDebouncedRunner(runner, 1000);
    trigger();
    trigger(); // schedules a trailing fire
    cancel();
    vi.advanceTimersByTime(5000);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('never overlaps a slow async tick and coalesces its extra triggers into one follow-up', async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const runner = vi.fn(() => {
      active++;
      peak = Math.max(peak, active);
      return new Promise<void>(resolve => releases.push(() => { active--; resolve(); }));
    });
    const { trigger, cancel } = makeDebouncedRunner(runner, 1000);
    trigger();
    for (let i = 0; i < 3; i++) {
      trigger();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(runner).toHaveBeenCalledTimes(1);
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
    cancel();
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('releases async single-flight state after rejection and runs the pending follow-up', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let reject!: (error: Error) => void;
    const runner = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }))
      .mockResolvedValue(undefined);
    const { trigger, cancel } = makeDebouncedRunner(runner, 1000);
    try {
      trigger();
      trigger();
      await vi.advanceTimersByTimeAsync(1000);
      expect(runner).toHaveBeenCalledTimes(1);
      reject(new Error('tick failed'));
      await vi.advanceTimersByTimeAsync(0);
      expect(runner).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      cancel();
      warnSpy.mockRestore();
    }
  });

  it('cancels a queued follow-up even when the running async tick settles later', async () => {
    let finish!: () => void;
    const runner = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const { trigger, cancel } = makeDebouncedRunner(runner, 1000);
    trigger();
    trigger();
    await vi.advanceTimersByTimeAsync(1000);
    cancel();
    finish();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('debounces notifications emitted by the async runner itself across trailing fires', async () => {
    const runner = vi.fn(async () => {
      await Promise.resolve();
      debounced.trigger();
    });
    const debounced = makeDebouncedRunner(runner, 1000);
    try {
      debounced.trigger();
      await vi.advanceTimersByTimeAsync(999);
      expect(runner).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(runner).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(999);
      expect(runner).toHaveBeenCalledTimes(2);
    } finally {
      debounced.cancel();
    }
  });

  it('a runner that throws does not break the debounce', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = vi.fn(() => {
      throw new Error('boom');
    });
    const { trigger } = makeDebouncedRunner(runner, 1000);
    expect(() => trigger()).not.toThrow();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
