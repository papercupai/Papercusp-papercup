import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildOpenAiEmbedder,
  EMBED_MAX_ATTEMPTS,
  EMBED_TOTAL_BUDGET_MS,
  parseOpenAiDurationMs,
  retryDelayFromHeaders,
  nextEmbedBackoffMs,
} from './configure';
import { memoryToolTimeoutMs } from './op-deadline';
import { buildOpenAiEmbedderCore as buildWorkerSafeOpenAiEmbedder } from './openai-embedder-core';

// The OpenAI embedder used to throw on the FIRST non-OK response with no retry,
// so a burst of memory writes (knowledge-pack seeding fires items in concurrent
// batches) failed wholesale the instant OpenAI rate-limited or hiccupped —
// surfacing to the user as "N write(s) failed". A sustained org-wide TPM 429
// (text-embedding-3-small, 1M TPM) then hard-failed memory:remember/search
// FLEET-WIDE on 2026-06-17. These pin the resilience: a TRANSIENT error
// (429 / 5xx / network) retries with HEADER-AWARE jittered backoff on the SAME
// embedder (no fallback); a NON-retryable client error (401 bad key) fails fast.
// (watchdog-embed-resilience-and-dedup-2026-06-17 P-001.)

afterEach(() => vi.restoreAllMocks());

const okEmbed = (v: number[]) => new Response(JSON.stringify({ data: [{ embedding: v }] }), { status: 200 });
const noSleep = async () => {}; // assert attempt counts without real delays

describe('worker-safe OpenAI embedder core', () => {
  it('runs without operator admission and accepts a host-injected admission seam', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okEmbed([0.4, 0.5]))
      .mockResolvedValueOnce(okEmbed([0.4, 0.5]));
    vi.stubGlobal('fetch', fetchMock);
    const admission = {
      acquire: vi.fn(async () => ({ release: vi.fn() })),
      recordResponse: vi.fn(),
      penalize: vi.fn(),
    };

    expect(await buildWorkerSafeOpenAiEmbedder('sk-worker', { sleep: noSleep })('plain')).toEqual([0.4, 0.5]);
    expect(await buildWorkerSafeOpenAiEmbedder('sk-operator', { sleep: noSleep }, {
      admission: () => admission,
    })('governed')).toEqual([0.4, 0.5]);
    expect(admission.acquire).toHaveBeenCalledWith('governed', 'memory');
    expect(admission.recordResponse).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('buildOpenAiEmbedder — transient-failure resilience', () => {
  it('retries a 429 rate-limit then succeeds (the seeding-burst case)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(okEmbed([0.1, 0.2, 0.3]));
    vi.stubGlobal('fetch', fetchMock);
    const v = await buildOpenAiEmbedder('sk-test', { sleep: noSleep })('hello');
    expect(v).toEqual([0.1, 0.2, 0.3]);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 failed (429) + 1 success
  });

  it('retries a 5xx then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(okEmbed([1]));
    vi.stubGlobal('fetch', fetchMock);
    expect(await buildOpenAiEmbedder('sk', { sleep: noSleep })('x')).toEqual([1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a network/fetch error then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(okEmbed([9]));
    vi.stubGlobal('fetch', fetchMock);
    expect(await buildOpenAiEmbedder('sk', { sleep: noSleep })('x')).toEqual([9]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails FAST on a 401 (bad/expired key) — exactly one attempt, no retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(buildOpenAiEmbedder('sk-bad', { sleep: noSleep })('x')).rejects.toThrow(/openai_embed_failed_401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // mem0-embed-insufficient-quota-classification: OpenAI returns HTTP 429 for BOTH a
  // transient rate-limit AND a hard `insufficient_quota` (account out of credit / billing
  // cap hit). The billing stop fails identically on every retry regardless of load, so it
  // must fail FAST (like a 401) and be tagged DISTINCTLY — NOT ridden out as a rate-limit.
  // This conflation once sent a multi-hour investigation down the throughput path.
  it('fails FAST on a 429 `insufficient_quota` (billing stop) — one attempt, distinct tag', async () => {
    const quotaBody = JSON.stringify({
      error: {
        type: 'insufficient_quota',
        code: 'insufficient_quota',
        message: 'You exceeded your current quota, please check your plan and billing details.',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(quotaBody, { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      // rand:()=>1 would maximize any backoff — proves we don't even reach the backoff path
      buildOpenAiEmbedder('sk', { sleep: noSleep, rand: () => 1 })('x'),
    ).rejects.toThrow(/openai_embed_quota_exhausted/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // hard stop — no doomed retries
  });

  it('still RETRIES a 429 that is a true rate-limit (no insufficient_quota in body)', async () => {
    // Guard against over-matching: a plain rate-limit 429 must keep its transient behavior.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: 'rate_limit_exceeded' } }), { status: 429 }))
      .mockResolvedValueOnce(okEmbed([0.4, 0.5]));
    vi.stubGlobal('fetch', fetchMock);
    expect(await buildOpenAiEmbedder('sk', { sleep: noSleep })('x')).toEqual([0.4, 0.5]);
    expect(fetchMock).toHaveBeenCalledTimes(2); // retried, then succeeded
  });

  it('rides out a SUSTAINED hintless 429 until the wall-clock BUDGET is spent, then gives up', async () => {
    // mem0-timeout-fix-2026-06-24: the embed budget is now coupled UNDER the 10s memory-tool
    // deadline (EMBED_TOTAL_BUDGET_MS), so a sustained 429 with NO server reset hint gives up
    // when the budget is exhausted — FEWER than EMBED_MAX_ATTEMPTS tries — rather than riding a
    // 50s retry well past the deadline (which surfaced as `memory_timeout`).
    const fetchMock = vi.fn().mockResolvedValue(new Response('still rate limited', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      buildOpenAiEmbedder('sk', { sleep: noSleep, rand: () => 1 })('x'),
    ).rejects.toThrow(/openai_embed_failed_429/);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1); // it DID retry
    expect(fetchMock.mock.calls.length).toBeLessThan(EMBED_MAX_ATTEMPTS); // but budget-bounded, not attempt-bounded
  });

  it('gives up FAST (one attempt) when the server reset window exceeds the remaining budget', async () => {
    // The org-wide 1M-TPM drain returns 429 with `x-ratelimit-reset-tokens` ~15m — far longer
    // than the embed budget. Sleeping the whole budget for a reset that won't arrive in time is
    // pure latency, so we give up immediately with a clean failure (mem0-timeout-fix-2026-06-24).
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('drained', { status: 429, headers: { 'x-ratelimit-reset-tokens': '900s' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(buildOpenAiEmbedder('sk', { sleep: noSleep })('x')).rejects.toThrow(/openai_embed_failed_429/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no doomed wait — fail fast & clean
  });

  it('honors the server Retry-After hint for the backoff wait', async () => {
    const waits: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(okEmbed([7]));
    vi.stubGlobal('fetch', fetchMock);
    const sleep = async (ms: number) => { waits.push(ms); };
    const v = await buildOpenAiEmbedder('sk', { sleep, rand: () => 0 })('x');
    expect(v).toEqual([7]);
    expect(waits[0]).toBeGreaterThanOrEqual(2000); // Retry-After: 2s honored (rand:0 → no extra jitter)
  });

  it('stops retrying once the total-wait budget is spent (never blocks forever)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('rl', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    // baseMs 200 > budget 100 → first wait clamps to 100, the next backoff returns null → stop.
    await expect(
      buildOpenAiEmbedder('sk', { sleep: noSleep, maxTotalWaitMs: 100, baseMs: 200, rand: () => 1 })('x'),
    ).rejects.toThrow(/openai_embed_failed_429/);
    expect(fetchMock.mock.calls.length).toBeLessThan(EMBED_MAX_ATTEMPTS);
  });
});

describe('parseOpenAiDurationMs', () => {
  it('parses bare seconds, compact durations, and rejects junk', () => {
    expect(parseOpenAiDurationMs('2')).toBe(2000);
    expect(parseOpenAiDurationMs('1.5s')).toBe(1500);
    expect(parseOpenAiDurationMs('6ms')).toBe(6);
    expect(parseOpenAiDurationMs('2m59.56s')).toBe(2 * 60_000 + Math.round(59.56 * 1000));
    expect(parseOpenAiDurationMs('')).toBeNull();
    expect(parseOpenAiDurationMs(null)).toBeNull();
    expect(parseOpenAiDurationMs('soon')).toBeNull();
  });
});

describe('retryDelayFromHeaders', () => {
  it('prefers Retry-After, then x-ratelimit-reset-tokens, else null', () => {
    expect(retryDelayFromHeaders(new Headers({ 'retry-after': '3' }))).toBe(3000);
    expect(retryDelayFromHeaders(new Headers({ 'x-ratelimit-reset-tokens': '1.2s' }))).toBe(1200);
    expect(retryDelayFromHeaders(new Headers())).toBeNull();
  });
});

describe('nextEmbedBackoffMs', () => {
  it('returns null when the total-wait budget is spent', () => {
    expect(nextEmbedBackoffMs(0, null, 30_000, { maxTotalWaitMs: 30_000 })).toBeNull();
  });
  it('clamps the wait to the remaining budget', () => {
    const w = nextEmbedBackoffMs(5, null, 29_500, { maxTotalWaitMs: 30_000, rand: () => 1 });
    expect(w).toBeLessThanOrEqual(500);
    expect(w).toBeGreaterThan(0);
  });
  it('honors a server hint over exponential backoff', () => {
    expect(nextEmbedBackoffMs(0, 2000, 0, { rand: () => 0 })).toBe(2000);
  });

  it('gives up (null) when the server reset hint is LONGER than the remaining budget', () => {
    // The doomed-wait case (mem0-timeout-fix-2026-06-24): reset 900s ≫ 5s remaining budget →
    // the reset can't arrive before we must give up, so don't sleep for it — fail fast.
    expect(nextEmbedBackoffMs(0, 900_000, 0, { maxTotalWaitMs: 5_000 })).toBeNull();
    // But a hint that FITS the budget is still honored.
    expect(nextEmbedBackoffMs(0, 2_000, 0, { maxTotalWaitMs: 5_000, rand: () => 0 })).toBe(2_000);
  });

  it('widens reset-moment jitter so clients on the SAME reset window do not re-fire in sync (anti-herd)', () => {
    // Two clients both told "reset in 5s" get DIFFERENT waits — spread across the jitter
    // window — so they don't all hammer OpenAI at the exact reset boundary.
    const a = nextEmbedBackoffMs(0, 5000, 0, { rand: () => 0 });
    const b = nextEmbedBackoffMs(0, 5000, 0, { rand: () => 0.99 });
    expect(a).toBe(5000); // reset honored exactly when jitter draws 0
    expect(b).toBeGreaterThan(6000); // a different client is jittered later
    expect((b as number) - (a as number)).toBeGreaterThan(1000); // spread > 1s across the herd
  });
});

describe('embed budget ↔ memory deadline coupling (anti-drift)', () => {
  it('keeps EMBED_TOTAL_BUDGET_MS under the memory-tool deadline so a throttled embed fails CLEAN, not as memory_timeout', () => {
    // ROOT CAUSE of the 2026-06-24 mem0 timeouts: the embed retry budget (~50s, sized for the
    // old 60s transport cap) outlived the 10s memory-tool deadline (B1) after it was added, so a
    // 429/slow embed rode past the deadline and surfaced as `memory_timeout`. This guard fails the
    // build if the two drift apart again.
    expect(EMBED_TOTAL_BUDGET_MS).toBeLessThan(memoryToolTimeoutMs());
  });
});
