/**
 * P-006 (R-12/R-13, WI-10007504) — Scout inference transport deaths are retried.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  isInferenceTransportDeath,
  transportRetriesFrom,
  withTransportRetry,
  type TransportRetryEvent,
} from './inference-transport-retry';
import { withCodexCapacityFallback } from './register-scout-action';
import type { CapacityFallbackEvent } from './capacity-errors';

/**
 * The 11 transport-death causes recorded on scout_ticks status='error' between 2026-10-01 and
 * 2026-10-08 (the window that put the scout cycle error rate at 12/224 = 5.4%), copied verbatim
 * from the `…transport death (0 ideas, $0 spent): <cause>` suffix. Every one of them must be
 * classified retryable — that is what takes this class out of the error rate.
 */
const MEASURED_PRODUCTION_TRANSPORT_DEATHS = [
  'inference-gateway: codex OAuth upstream failed: terminated',
  'fetch failed',
  'inference-gateway internal error',
  'inference-gateway: codex OAuth upstream failed: gateway upstream body idle exceeded 90000ms',
  'inference-gateway: codex OAuth non-stream response codex OAuth non-stream SSE ended without response.completed',
  'inference-gateway: codex OAuth upstream failed: terminated',
  'inference-gateway: codex OAuth upstream failed: terminated',
  'inference-gateway: codex OAuth upstream failed: gateway upstream body idle exceeded 90000ms',
  'fetch failed',
  'inference-gateway: codex OAuth non-stream response codex OAuth non-stream SSE ended without response.completed',
  'fetch failed',
] as const;

const capacityDenial = (): Error =>
  Object.assign(new Error('rate-limit pause exceeds maxWait'), {
    admissionDenial: { reason: 'rate-limit-blocked', via: 'governor' },
  });

const noSleep = async (): Promise<void> => {};

describe('isInferenceTransportDeath', () => {
  it.each(MEASURED_PRODUCTION_TRANSPORT_DEATHS.map((m, i) => [i, m]))(
    'classifies measured production cause #%i as a transport death: %s',
    (_i, message) => {
      expect(isInferenceTransportDeath(new Error(message))).toBe(true);
    },
  );

  it('reads the undici cause chain under a generic message', () => {
    const err = new TypeError('request failed', {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });
    expect(isInferenceTransportDeath(err)).toBe(true);
    expect(isInferenceTransportDeath(new TypeError('terminated'))).toBe(true);
    expect(isInferenceTransportDeath(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }))).toBe(true);
  });

  it('never classifies an attested capacity denial as transport — that is the capacity fallback’s job', () => {
    const err = Object.assign(new Error('fetch failed'), {
      admissionDenial: { reason: 'provider-429', via: 'http-429' },
    });
    expect(isInferenceTransportDeath(err)).toBe(false);
    expect(isInferenceTransportDeath(capacityDenial())).toBe(false);
  });

  it("never classifies Scout's own timers, cancellations or the cycle timeout as transport", () => {
    for (const message of [
      'Scout ideator analogical timed out after 180000ms',
      'Scout ideator analogical aborted',
      'Scout ideator first-principles did not receive an upstream response before the cycle deadline (local admission unobserved — transport may not expose admission; response start unobserved; queueing versus generation unknown)',
      'Scout cycle timed out after 600000ms during phase recombine',
    ]) {
      expect(isInferenceTransportDeath(new Error(message))).toBe(false);
    }
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(isInferenceTransportDeath(abort)).toBe(false);
  });

  it('does not retry deterministic failures', () => {
    for (const message of [
      'inference-gateway: codex OAuth upstream failed: 401 Unauthorized',
      'invalid_request_error: max_tokens too large',
      'model refused the request',
    ]) {
      expect(isInferenceTransportDeath(new Error(message))).toBe(false);
    }
    expect(isInferenceTransportDeath(undefined)).toBe(false);
    expect(isInferenceTransportDeath('')).toBe(false);
  });
});

describe('withTransportRetry', () => {
  it('retries a transport death on the SAME model and records the recovery', async () => {
    const events: TransportRetryEvent[] = [];
    const call = vi
      .fn<(o: { model?: string }) => Promise<string>>()
      .mockRejectedValueOnce(new Error('inference-gateway: codex OAuth upstream failed: terminated'))
      .mockResolvedValueOnce('ideas');
    const wrapped = withTransportRetry(call, { events, sleep: noSleep });

    await expect(wrapped({ model: 'gpt-6.1-sol:xhigh' })).resolves.toBe('ideas');
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls.map((c) => c[0].model)).toEqual(['gpt-6.1-sol:xhigh', 'gpt-6.1-sol:xhigh']);
    expect(events).toEqual([
      {
        model: 'gpt-6.1-sol:xhigh',
        attempt: 1,
        error: 'inference-gateway: codex OAuth upstream failed: terminated',
        succeeded: true,
      },
    ]);
  });

  it('gives up after maxRetries and rethrows the LAST error, every attempt recorded', async () => {
    const events: TransportRetryEvent[] = [];
    const call = vi.fn(async (_o: { model?: string }) => {
      throw new Error('fetch failed');
    });
    const wrapped = withTransportRetry(call, { events, sleep: noSleep, maxRetries: 2 });

    await expect(wrapped({ model: 'm' })).rejects.toThrow('fetch failed');
    expect(call).toHaveBeenCalledTimes(3);
    expect(events.map((e) => [e.attempt, e.succeeded])).toEqual([
      [1, false],
      [2, false],
    ]);
  });

  it('surfaces a DIFFERENT failure on the retry instead of the original transport message', async () => {
    const events: TransportRetryEvent[] = [];
    const denial = capacityDenial();
    const call = vi
      .fn<(o: { model?: string }) => Promise<string>>()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(denial);
    const wrapped = withTransportRetry(call, { events, sleep: noSleep });

    await expect(wrapped({ model: 'm' })).rejects.toBe(denial);
    expect(call).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
    expect(events[0]?.succeeded).toBe(false);
  });

  it('does not retry a non-transport failure', async () => {
    const events: TransportRetryEvent[] = [];
    const call = vi.fn(async (_o: { model?: string }) => {
      throw new Error('inference-gateway: codex OAuth upstream failed: 401 Unauthorized');
    });
    await expect(withTransportRetry(call, { events, sleep: noSleep })({ model: 'm' })).rejects.toThrow('401');
    expect(call).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });

  it('does not start a retry that cannot finish before the retry deadline', async () => {
    const events: TransportRetryEvent[] = [];
    const call = vi.fn(async (_o: { model?: string; retryDeadlineMs?: number }) => {
      throw new Error('fetch failed');
    });
    const wrapped = withTransportRetry(call, {
      events,
      sleep: noSleep,
      now: () => 1_000_000,
      backoffMs: [2_000],
      minRemainingMs: 30_000,
      // One retry: the clock is frozen, so a second retry would see the same headroom.
      maxRetries: 1,
    });
    // 31s left, but 2s backoff leaves 29s < 30s minimum.
    await expect(wrapped({ model: 'm', retryDeadlineMs: 1_031_000 })).rejects.toThrow('fetch failed');
    expect(call).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);

    // 33s left: 2s backoff leaves 31s, so the retry is allowed.
    call.mockClear();
    await expect(wrapped({ model: 'm', retryDeadlineMs: 1_033_000 })).rejects.toThrow('fetch failed');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not retry once the call is aborted, and an abort during backoff rethrows the transport error', async () => {
    const events: TransportRetryEvent[] = [];
    const ctrl = new AbortController();
    ctrl.abort();
    const call = vi.fn(async (_o: { model?: string; signal?: AbortSignal }) => {
      throw new Error('fetch failed');
    });
    await expect(withTransportRetry(call, { events, sleep: noSleep })({ model: 'm', signal: ctrl.signal })).rejects.toThrow(
      'fetch failed',
    );
    expect(call).toHaveBeenCalledTimes(1);

    const live = new AbortController();
    const transport = new Error('fetch failed');
    const call2 = vi.fn(async (_o: { model?: string; signal?: AbortSignal }) => {
      throw transport;
    });
    const backoffEvents: TransportRetryEvent[] = [];
    const wrapped = withTransportRetry(call2, { events: backoffEvents, backoffMs: [60_000] });
    const pending = wrapped({ model: 'm', signal: live.signal });
    const settled = pending.catch((e: unknown) => e);
    // Let the first attempt fail and the wrapper enter its (real, 60s) backoff before aborting.
    await new Promise((r) => setTimeout(r, 20));
    expect(backoffEvents).toHaveLength(1);
    live.abort();
    await expect(settled).resolves.toBe(transport);
    expect(call2).toHaveBeenCalledTimes(1);
  });

  it('composes OUTSIDE the codex capacity fallback: transport retried, capacity diverted, neither swallowed', async () => {
    const transportEvents: TransportRetryEvent[] = [];
    const fallbackEvents: CapacityFallbackEvent[] = [];
    const seen: string[] = [];
    let claudeCalls = 0;
    const raw = async (o: { model?: string }): Promise<string> => {
      seen.push(o.model ?? '');
      if (o.model === 'claude-x') {
        claudeCalls++;
        if (claudeCalls === 1) throw new Error('fetch failed');
        throw capacityDenial();
      }
      return `ok:${o.model}`;
    };
    const chain = withTransportRetry(
      withCodexCapacityFallback(raw, {
        capacity: { claudeAvailable: true, codexAvailable: true },
        backendForModel: (m) => (m?.startsWith('gpt') ? 'codex' : 'anthropic'),
        events: fallbackEvents,
        fallbackModel: 'gpt-6.1-sol:xhigh',
      }),
      { events: transportEvents, sleep: noSleep },
    );

    await expect(chain({ model: 'claude-x' })).resolves.toBe('ok:gpt-6.1-sol:xhigh');
    expect(seen).toEqual(['claude-x', 'claude-x', 'gpt-6.1-sol:xhigh']);
    expect(transportEvents).toEqual([{ model: 'claude-x', attempt: 1, error: 'fetch failed', succeeded: true }]);
    expect(fallbackEvents.map((e) => [e.from, e.to, e.succeeded])).toEqual([['claude-x', 'gpt-6.1-sol:xhigh', true]]);
  });
});

describe('transportRetriesFrom', () => {
  it('round-trips a valid trail and drops malformed entries', () => {
    const trail: TransportRetryEvent[] = [{ model: 'm', attempt: 1, error: 'fetch failed', succeeded: true }];
    expect(transportRetriesFrom({ transportRetries: trail })).toEqual(trail);
    expect(
      transportRetriesFrom({ transportRetries: [{ model: 'm', attempt: '1', error: 'x', succeeded: true }, null] }),
    ).toBeUndefined();
    expect(transportRetriesFrom(new Error('x'))).toBeUndefined();
    expect(transportRetriesFrom(undefined)).toBeUndefined();
  });
});
