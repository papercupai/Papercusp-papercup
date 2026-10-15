/**
 * Conformance suite for the embed-latency watchdog judge (EI-21491088289861649).
 *
 * Mirrors retrieval-degradation-watchdog.test.ts: the PURE classification
 * ladder is tested with no timers, no PG and no escalation surface, and the
 * sweep is exercised with injected deps. Includes a CONTROL — a deliberately-
 * naive rule that fires where the real judge correctly refuses — so the
 * min-samples guard cannot silently regress into noise.
 */

import { describe, expect, it, vi } from 'vitest';
import type { EmbedCallerLatency, EmbedLatencyWindow } from '@papercusp/search';
import { hostname } from 'node:os';

import {
  EMBED_LATENCY_MIN_SAMPLES_PER_CALLER,
  EMBED_LATENCY_UNAVAILABLE_FLOOR,
  judgeEmbedCaller,
  judgeEmbedLatency,
  runEmbedLatencySweepOnce,
  type EmbedLatencyVerdict,
} from './embed-latency-watchdog';

function caller(over: Partial<EmbedCallerLatency> = {}): EmbedCallerLatency {
  return {
    caller: 'search:semantic',
    n: EMBED_LATENCY_MIN_SAMPLES_PER_CALLER,
    ok: EMBED_LATENCY_MIN_SAMPLES_PER_CALLER,
    timeout: 0,
    error: 0,
    budgetMs: 4000,
    p50Ms: 20,
    p99Ms: 200,
    maxMs: 250,
    ...over,
  };
}

function win(callers: EmbedCallerLatency[], over: Partial<EmbedLatencyWindow> = {}): EmbedLatencyWindow {
  return {
    windowMs: 60 * 60_000,
    embeds: callers.reduce((a, c) => a + c.n, 0),
    callers,
    oldestSampleMs: 1,
    newestSampleMs: 2,
    truncatedByCapacity: false,
    ...over,
  };
}

function quietRail() {
  return { broadcast: async () => true, resolve: async () => true };
}

describe('judgeEmbedCaller — the classification ladder names the REMEDY', () => {
  it('ungraded: no recorded budget — nothing to grade against', () => {
    expect(judgeEmbedCaller(caller({ budgetMs: null }))).toMatchObject({
      kind: 'ungraded',
      reason: 'no-budget',
    });
  });

  it('ungraded: a rate over a tiny denominator is not a measurement', () => {
    expect(
      judgeEmbedCaller(caller({ n: EMBED_LATENCY_MIN_SAMPLES_PER_CALLER - 1, p99Ms: 999_999 })),
    ).toMatchObject({ kind: 'ungraded', reason: 'insufficient-samples' });
  });

  it('healthy: p99 under the caller\u2019s own budget', () => {
    expect(judgeEmbedCaller(caller()).kind).toBe('healthy');
  });

  it('cold-start-spike: p99 breaches while the median sits well under — sidecar WORKS', () => {
    const v = judgeEmbedCaller(caller({ p50Ms: 20, p99Ms: 4500, maxMs: 5000 }));
    expect(v.kind).toBe('cold-start-spike');
  });

  it('sustained-slow: even the MEDIAN exceeds budget — look at load before touching budgets', () => {
    const v = judgeEmbedCaller(caller({ p50Ms: 4500, p99Ms: 6000 }));
    expect(v.kind).toBe('sustained-slow');
  });

  it(`unavailable dominates: ${EMBED_LATENCY_UNAVAILABLE_FLOOR * 100}% outright failures is DOWN, not slow`, () => {
    const v = judgeEmbedCaller(
      caller({ timeout: Math.ceil(EMBED_LATENCY_MIN_SAMPLES_PER_CALLER / 2), ok: 5 }),
    );
    expect(v.kind).toBe('unavailable');
  });
});

describe('judgeEmbedLatency — the window verdict', () => {
  it('nothing-to-grade: a detector that measured no budgets is not a detector that passed', () => {
    expect(judgeEmbedLatency(win([caller({ budgetMs: null })])).kind).toBe('nothing-to-grade');
  });

  it('healthy with zero breaches', () => {
    const v = judgeEmbedLatency(win([caller()]));
    expect(v).toEqual({ kind: 'healthy', breaches: [] });
  });

  it('breach names ONLY the breaching callers, keeping their labels', () => {
    const v = judgeEmbedLatency(
      win([
        caller(),
        caller({ caller: 'midturn:related-context', budgetMs: 1200, p99Ms: 1900, maxMs: 1924 }),
        caller({ caller: 'docs:search', budgetMs: null }),
      ]),
    );
    expect(v.kind).toBe('breach');
    if (v.kind !== 'breach') return;
    expect(v.breaches.map((b) => b.caller)).toEqual(['midturn:related-context']);
    expect(v.breaches[0]).toMatchObject({ kind: 'cold-start-spike', budgetMs: 1200, p99Ms: 1900 });
  });

  it('CONTROL: a naive any-tail rule fires on a too-small window while the judge refuses', () => {
    const naive = (c: EmbedCallerLatency) => (c.p99Ms ?? 0) > (c.budgetMs ?? Infinity);
    const smallWindow = caller({ n: 1, p99Ms: 999_999 });
    expect(naive(smallWindow)).toBe(true);
    expect(judgeEmbedCaller(smallWindow).kind).toBe('ungraded');
  });
});

describe('runEmbedLatencySweepOnce — sweep plumbing', () => {
  it('flag OFF skips before reading anything', async () => {
    const readWindow = vi.fn(() => win([caller({ p99Ms: 999_999 })]));
    const out = await runEmbedLatencySweepOnce({
      flagEnabled: async () => false,
      readWindow,
      rail: quietRail(),
      escalate: async () => {},
    });
    expect(out).toEqual({ verdict: 'skipped', escalated: 0 });
    expect(readWindow).not.toHaveBeenCalled();
  });

  it('a breach escalates ONCE with a dedup signature naming caller:classification', async () => {
    const escalate = vi.fn(
      async (_verdict: Extract<EmbedLatencyVerdict, { kind: 'breach' }>) => {},
    );
    const out = await runEmbedLatencySweepOnce({
      flagEnabled: async () => true,
      rail: quietRail(),
      readWindow: () =>
        win([caller({ caller: 'midturn:related-context', budgetMs: 1200, p99Ms: 1900 })]),
      escalate,
    });
    expect(out.verdict).toBe('breach');
    expect(out.escalated).toBe(1);
    expect(escalate).toHaveBeenCalledTimes(1);
    const arg = escalate.mock.calls[0]![0]!;
    expect(arg.breaches[0]?.caller).toBe('midturn:related-context');
    void arg;
  });

  it('healthy and nothing-to-grade do not escalate', async () => {
    const escalate = vi.fn(async () => {});
    for (const window of [win([caller()]), win([])]) {
      const out = await runEmbedLatencySweepOnce({
        flagEnabled: async () => true,
        rail: quietRail(),
        readWindow: () => window,
        escalate,
      });
      expect(out.escalated).toBe(0);
    }
    expect(escalate).not.toHaveBeenCalled();
  });

  it('keeps a host/caller condition through unknown windows and legacy failures, then resolves measured recovery', async () => {
    const open = new Set<string>();
    const broadcast = vi.fn(async (event: { conditionKey?: string }) => {
      open.add(event.conditionKey!); return true;
    });
    const resolve = vi.fn(async (event: { conditionKey: string }) => open.delete(event.conditionKey));
    const slow = caller({ caller: 'midturn:related-context', budgetMs: 1200, p99Ms: 1900 });
    const key = `alarm:embed-latency:${encodeURIComponent(hostname())}:midturn%3Arelated-context`;
    const deps = { flagEnabled: async () => true, rail: { broadcast, resolve },
      escalate: async () => { throw new Error('legacy unavailable'); } };
    await expect(runEmbedLatencySweepOnce({ ...deps, readWindow: () => win([slow]) })).rejects.toThrow('legacy unavailable');
    expect([...open]).toEqual([key]);
    for (const window of [win([]), win([caller()]), win([{ ...slow, budgetMs: null }]),
      win([{ ...slow, n: 1 }]), win([{ ...slow, p50Ms: null, p99Ms: null }])]) {
      await runEmbedLatencySweepOnce({ ...deps, readWindow: () => window });
      expect([...open]).toEqual([key]);
    }
    await runEmbedLatencySweepOnce({ ...deps, flagEnabled: async () => false, readWindow: () => win([{ ...slow, p99Ms: 200 }]) });
    expect([...open]).toEqual([key]);
    await runEmbedLatencySweepOnce({ ...deps, readWindow: () => win([{ ...slow, p99Ms: 200 }]) });
    expect(open.size).toBe(0);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ conditionKey: key, summary: 'embed-latency-watchdog recovered' });
  });

  it('a failed condition delivery leaves the legacy notification independently executable', async () => {
    const escalate = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await runEmbedLatencySweepOnce({ flagEnabled: async () => true,
        readWindow: () => win([caller({ p99Ms: 5000 })]), escalate,
        rail: { broadcast: async () => { throw new Error('rail unavailable'); } } });
      expect(out).toEqual({ verdict: 'breach', escalated: 1 });
      expect(escalate).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('condition broadcast failed (non-fatal): Error: rail unavailable'));
    } finally { warn.mockRestore(); }
  });
});
