import { describe, expect, it, vi } from 'vitest';
import { LoopCpuRecorder, LOOP_CPU_SAMPLING_INTERVAL_US } from './event-loop-cpu-recorder';

function fixture() {
  let now = 0;
  let threadUser = 0;
  let threadSystem = 0;
  const live = new Set<string>();
  const events: string[] = [];
  const session = {
    connect: vi.fn(),
    disconnect: vi.fn(() => { live.clear(); events.push('disconnect'); }),
    post: vi.fn(async (method: string, _params?: Record<string, number>): Promise<unknown> => {
      events.push(method);
      if (method === 'Profiler.enable') {
        threadUser += 1234;
        threadSystem += 56;
      }
      return method === 'Profiler.stop' ? { profile: { nodes: [], samples: [1, 2, 3] } } : {};
    }),
  };
  const threadCpuUsage = vi.fn((previous?: { user: number; system: number }) => {
    const current = { user: threadUser, system: threadSystem };
    return previous
      ? { user: current.user - previous.user, system: current.system - previous.system }
      : current;
  });
  let maxLive = 0;
  const make = vi.fn(async () => session);
  const log = vi.fn();
  const recorder = new LoopCpuRecorder(300, log, {
    session: make,
    begin: (name) => { live.add(name); maxLive = Math.max(maxLive, live.size); events.push('begin'); },
    end: (name) => { live.delete(name); events.push('end'); },
    now: () => now,
    threadCpuUsage,
  });
  return { recorder, session, make, log, events, live, threadCpuUsage, advance: (ms: number) => { now += ms; }, maxLive: () => maxLive };
}

describe('monitor-owned warm CPU recorder', () => {
  it('keeps cold initialization out of repeated captures and overlaps bounded anchors', async () => {
    const f = fixture();
    try {
      expect(await f.recorder.update(false, true)).toBe(false);
      expect(f.make).not.toHaveBeenCalled();
      expect(await f.recorder.update(true, true)).toBe(true);
      expect(f.session.post).toHaveBeenCalledWith('Profiler.setSamplingInterval', { interval: LOOP_CPU_SAMPLING_INTERVAL_US });
      for (let i = 0; i < 4; i++) {
        f.advance(100);
        expect(await f.recorder.update(true, true)).toBe(true);
        expect((await f.recorder.record(1)).profile).toEqual({ nodes: [], samples: [1, 2, 3] });
      }
      expect(f.make).toHaveBeenCalledTimes(1);
      expect(f.maxLive()).toBe(2);
      expect(f.live.size).toBe(1);
      expect(f.events.slice(2, 5)).toEqual(['begin', 'begin', 'end']);
    } finally { f.recorder.stop(); }
    expect(f.live.size).toBe(0);
  });

  it('logs bounded main-thread CPU deltas only around cold initialization', async () => {
    const f = fixture();
    try {
      expect(await f.recorder.update(true, true)).toBe(true);
      expect(f.log).toHaveBeenCalledWith('[event-loop-lag] CPU recorder observer cost', expect.objectContaining({
        warmupMainThreadUserCpuUs: 1234,
        warmupMainThreadSystemCpuUs: 56,
        samplingIntervalUs: LOOP_CPU_SAMPLING_INTERVAL_US,
      }));
      expect(f.threadCpuUsage).toHaveBeenCalledTimes(2);

      expect(await f.recorder.update(true, true)).toBe(true);
      expect(f.threadCpuUsage).toHaveBeenCalledTimes(2);
    } finally { f.recorder.stop(); }
  });

  it.each(['disabled', 'unsafe', 'stop', 'overdue'] as const)('revokes active sampling on %s without serializing the old anchor', async (reason) => {
    const f = fixture();
    await f.recorder.update(true, true);
    const capture = f.recorder.record(60_000);
    const rejected = expect(capture).rejects.toThrow();
    await vi.waitFor(() => expect(f.session.post).toHaveBeenCalledWith('Profiler.start'));
    if (reason === 'stop') f.recorder.stop();
    else {
      if (reason === 'overdue') f.advance(301);
      expect(await f.recorder.update(reason !== 'disabled', reason !== 'unsafe')).toBe(false);
    }
    await rejected;
    expect(f.live.size).toBe(0);
    expect(f.events).not.toContain('end');
    expect(f.session.disconnect).toHaveBeenCalled();
    if (reason === 'stop') {
      expect(await f.recorder.update(true, true)).toBe(false);
      expect(f.make).toHaveBeenCalledTimes(1);
    } else {
      expect(await f.recorder.update(true, true)).toBe(true);
      expect(f.make).toHaveBeenCalledTimes(2);
    }
    f.recorder.stop();
  });

  it('does not start an asynchronously created session after stop', async () => {
    const f = fixture();
    let resolve!: (session: typeof f.session) => void;
    f.make.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const starting = f.recorder.update(true, true);
    f.recorder.stop();
    resolve(f.session);
    expect(await starting).toBe(false);
    expect(f.session.connect).not.toHaveBeenCalled();
    expect(f.events).not.toContain('begin');
    expect(f.session.disconnect).toHaveBeenCalled();
  });

  it('revokes setup while enable is pending and never starts its anchor later', async () => {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    f.session.post.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const starting = f.recorder.update(true, true);
    await vi.waitFor(() => expect(f.session.connect).toHaveBeenCalled());
    await f.recorder.update(false, true);
    resolve({});
    expect(await starting).toBe(false);
    expect(f.events).not.toContain('begin');
    f.recorder.stop();
  });

  it('cleans up failed initialization and allows a later safe attempt', async () => {
    const f = fixture();
    f.session.post.mockRejectedValueOnce(new Error('inspector failed'));
    expect(await f.recorder.update(true, true)).toBe(false);
    expect(f.session.disconnect).toHaveBeenCalled();
    expect(await f.recorder.update(true, true)).toBe(true);
    f.recorder.stop();
  });

  it('caller cancellation stops only the foreground recording and preserves the warm anchor', async () => {
    const f = fixture();
    try {
      await f.recorder.update(true, true);
      const controller = new AbortController();
      const capture = f.recorder.record(60_000, controller.signal);
      const rejected = expect(capture).rejects.toThrow();
      await vi.waitFor(() => expect(f.session.post).toHaveBeenCalledWith('Profiler.start'));
      controller.abort();
      await rejected;
      expect(f.session.post).toHaveBeenCalledWith('Profiler.stop');
      expect(f.live.size).toBe(1);
      expect(f.session.disconnect).not.toHaveBeenCalled();
      expect((await f.recorder.record(1)).samplingIntervalUs).toBe(10_000);
    } finally { f.recorder.stop(); }
  });

  it('rejects a second simultaneous foreground recording', async () => {
    const f = fixture();
    await f.recorder.update(true, true);
    const first = f.recorder.record(60_000);
    const rejected = expect(first).rejects.toThrow();
    await expect(f.recorder.record(1)).rejects.toThrow('unavailable');
    f.recorder.stop();
    await rejected;
  });
});
