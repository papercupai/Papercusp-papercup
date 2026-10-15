import { describe, expect, it } from 'vitest';
import {
  formatFrame,
  hotStackFields,
  shouldCaptureStallProfile,
  STALL_PROFILE_DEFAULTS,
  summarizeHotStacks,
  type CpuProfileLike,
  type StallCaptureInput,
} from './event-loop-stall-profile';

const cfg = { afterMs: 4_000, cooldownMs: 600_000 };
const base: StallCaptureInput = {
  stalenessMs: 4_500,
  cpuKind: 'spinning',
  capturedThisStall: false,
  inFlight: false,
  lastCaptureAtMs: null,
  nowMs: 1_000_000,
};

describe('shouldCaptureStallProfile', () => {
  it('captures a spinning stall past the threshold', () => {
    expect(shouldCaptureStallProfile(base, cfg)).toBe(true);
  });

  it('captures a partial stall too (the sample straddles the stall start)', () => {
    expect(shouldCaptureStallProfile({ ...base, cpuKind: 'partial' }, cfg)).toBe(true);
  });

  it('probes a parked thread too: low CPU cannot distinguish idle from a native wait', () => {
    expect(shouldCaptureStallProfile({ ...base, cpuKind: 'parked' }, cfg)).toBe(true);
  });

  it('never captures an unknown thread without a trustworthy CPU baseline', () => {
    expect(shouldCaptureStallProfile({ ...base, cpuKind: 'unknown' }, cfg)).toBe(false);
  });

  it('waits for the staleness threshold', () => {
    expect(shouldCaptureStallProfile({ ...base, stalenessMs: 3_999 }, cfg)).toBe(false);
    expect(shouldCaptureStallProfile({ ...base, stalenessMs: 4_000 }, cfg)).toBe(true);
    expect(shouldCaptureStallProfile({ ...base, stalenessMs: Number.NaN }, cfg)).toBe(false);
  });

  it('one capture per stall, never two at once', () => {
    expect(shouldCaptureStallProfile({ ...base, capturedThisStall: true }, cfg)).toBe(false);
    expect(shouldCaptureStallProfile({ ...base, inFlight: true }, cfg)).toBe(false);
  });

  it('honours the per-process cooldown', () => {
    expect(
      shouldCaptureStallProfile({ ...base, lastCaptureAtMs: base.nowMs - 599_999 }, cfg),
    ).toBe(false);
    expect(
      shouldCaptureStallProfile({ ...base, lastCaptureAtMs: base.nowMs - 600_000 }, cfg),
    ).toBe(true);
  });

  it('defaults capture inside the warn window and before the 20 s kill', () => {
    // First observation past afterMs lands within one 2 s observe tick, and the
    // window must END before the 10 s STALLED line, so it describes the stall
    // rather than whatever ran after it.
    expect(STALL_PROFILE_DEFAULTS.afterMs + 2_000 + STALL_PROFILE_DEFAULTS.captureMs).toBeLessThan(
      10_000,
    );
  });
});

/** Tiny profile: root → main → handler → { spin (leaf), now (native leaf) }. */
function profile(samples: number[]): CpuProfileLike {
  return {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2, 6] },
      {
        id: 2,
        callFrame: { functionName: 'listOnTimeout', url: 'node:internal/timers', lineNumber: 544, columnNumber: 7 },
        children: [3],
      },
      {
        id: 3,
        callFrame: { functionName: 'handler', url: 'file:///srv/dist-host/hono-host.mjs', lineNumber: 99, columnNumber: 4 },
        children: [4, 5],
      },
      { id: 4, callFrame: { functionName: 'spin', url: 'file:///srv/dist-host/hono-host.mjs', lineNumber: 9, columnNumber: 0 } },
      { id: 5, callFrame: { functionName: 'now', url: '', lineNumber: -1 } },
      { id: 6, callFrame: { functionName: '(garbage collector)', url: '', lineNumber: -1 } },
    ],
    samples,
  };
}

describe('summarizeHotStacks', () => {
  it('ranks leaf stacks by self samples, leaf first, root dropped, 1-based positions', () => {
    const s = summarizeHotStacks(profile([4, 4, 4, 5, 6]), { top: 3, depth: 6 });
    expect(s.samples).toBe(5);
    expect(s.hot[0]).toEqual({
      count: 3,
      pct: 60,
      stack: 'spin@hono-host.mjs:10:1 < handler@hono-host.mjs:100:5 < listOnTimeout@timers:545:8',
    });
    expect(s.hot.map((h) => h.count)).toEqual([3, 1, 1]);
    expect(s.hot.some((h) => h.stack === '(garbage collector)')).toBe(true);
  });

  it('merges stacks that read the same once depth truncates them', () => {
    // depth 1 keeps only the leaf, so spin and now stay distinct...
    expect(summarizeHotStacks(profile([4, 5]), { depth: 1 }).hot).toHaveLength(2);
    // ...but a profile whose two leaves are the SAME frame under one caller merges.
    const p = profile([4, 7]);
    p.nodes[2].children = [4, 5, 7];
    p.nodes.push({ id: 7, callFrame: { ...p.nodes[3].callFrame } });
    const s = summarizeHotStacks(p, { depth: 3 });
    expect(s.hot[0].count).toBe(2);
  });

  it('never throws on a malformed profile', () => {
    expect(summarizeHotStacks({} as CpuProfileLike)).toEqual({ samples: 0, hot: [] });
    expect(summarizeHotStacks({ nodes: [], samples: [1, 2] })).toEqual({ samples: 0, hot: [] });
    // A sample id with no node, and a cyclic parent map, still terminate.
    const cyclic: CpuProfileLike = {
      nodes: [
        { id: 1, callFrame: { functionName: 'a', url: 'file:///x.js', lineNumber: 0 }, children: [2] },
        { id: 2, callFrame: { functionName: 'b', url: 'file:///x.js', lineNumber: 1 }, children: [1] },
      ],
      samples: [1, 99],
    };
    const s = summarizeHotStacks(cyclic, { depth: 10 });
    expect(s.samples).toBe(2);
    expect(s.hot.map((h) => h.stack)).toContain('(unknown)');
  });
});

describe('summarizeHotStacks — hottest line', () => {
  it('marks only the LEAF with its hottest positionTicks line, so an inlined callee is still located', () => {
    const p = profile([4, 4]);
    p.nodes[3].positionTicks = [
      { line: 12, ticks: 1 },
      { line: 15, ticks: 9 },
    ];
    p.nodes[2].positionTicks = [{ line: 101, ticks: 3 }];
    expect(summarizeHotStacks(p).hot[0].stack).toBe(
      'spin@hono-host.mjs:10:1#L15 < handler@hono-host.mjs:100:5 < listOnTimeout@timers:545:8',
    );
  });
});

describe('formatFrame / hotStackFields', () => {
  it('formats native frames by name only and strips url query/hash', () => {
    expect(formatFrame({ functionName: 'now', url: '', lineNumber: -1 })).toBe('now');
    expect(formatFrame({ functionName: '', url: 'file:///a/b.mjs?v=1', lineNumber: 0, columnNumber: 2 })).toBe(
      '(anonymous)@b.mjs:1:3',
    );
  });

  it('emits hot1..hotN with share and count, clipped for the journal', () => {
    const f = hotStackFields(summarizeHotStacks(profile([4, 4, 5])), 40);
    expect(f.samples).toBe(3);
    expect(String(f.hot1).startsWith('66.7% (2) spin@hono-host.mjs:10:1')).toBe(true);
    expect(String(f.hot1).length).toBeLessThanOrEqual(40);
    expect(String(f.hot2).startsWith('33.3% (1) now < handler@')).toBe(true);
    // Unclipped at the default budget.
    expect(hotStackFields(summarizeHotStacks(profile([4, 4, 5]))).hot2).toBe(
      '33.3% (1) now < handler@hono-host.mjs:100:5 < listOnTimeout@timers:545:8',
    );
  });
});

describe('Profiler.start budget (WI-10006344)', () => {
  // Profiler.start logs every compiled code object first, so on bg-host's
  // multi-GB heap it took longer than the old hard-coded 3 s and every spinning
  // stall logged `Profiler.start not answered within 3000ms`. Measured cost:
  // 6.3 s at 1M functions (see STALL_PROFILE_DEFAULTS.startTimeoutMs).
  it('defaults to a budget well above the measured large-heap start cost', () => {
    expect(STALL_PROFILE_DEFAULTS.startTimeoutMs).toBeGreaterThanOrEqual(15_000);
  });

  it('reaches the worker through the resolved sentinel config', async () => {
    const { resolveSentinelConfig } = await import('./event-loop-sentinel-host');
    expect(resolveSentinelConfig({}).stallProfile.startTimeoutMs).toBe(
      STALL_PROFILE_DEFAULTS.startTimeoutMs,
    );
  });

  it('the worker uses the configured budget, not a literal, for Profiler.start', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./event-loop-sentinel.worker.ts', import.meta.url), 'utf8');
    const startCalls = src.split('\n').filter((l) => l.includes("'Profiler.start'"));
    expect(startCalls.length).toBe(1);
    expect(startCalls[0]).toContain('cfg.startTimeoutMs');
    expect(startCalls[0]).not.toMatch(/'Profiler\.start',\s*\d/);
  });
});
