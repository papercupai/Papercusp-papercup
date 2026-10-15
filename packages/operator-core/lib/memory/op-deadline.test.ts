/**
 * op-deadline.test.ts — the memory degraded latch (self-healing) + deadline race.
 *
 * The latch was previously a permanent boolean cleared only on restart: one transient
 * memory timeout (a load spike / a client cold-init window) disabled memory
 * auto-injection for the whole process lifetime. These tests pin the self-healing
 * cooldown behavior so a transient timeout can never again permanently starve
 * injection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MemoryTimeoutError,
  isMemoryDegraded,
  noteMemoryFailure,
  resetMemoryDegradedForTest,
  memoryDegradedCooldownMs,
  withMemoryTimeout,
  withMemoryWriteRetry,
  memoryWriteMaxAttempts,
  memoryWriteRetryBackoffMs,
  embedFailureReason,
  runWithTrackedMemoryTimeouts,
  createMemoryWorkDeadline,
} from './op-deadline';

describe('memory degraded latch — self-healing', () => {
  beforeEach(() => {
    resetMemoryDegradedForTest();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetMemoryDegradedForTest();
  });

  it('starts not-degraded', () => {
    expect(isMemoryDegraded()).toBe(false);
  });

  it('a memory timeout arms the latch, then it AUTO-CLEARS after the cooldown (no restart)', () => {
    noteMemoryFailure(new MemoryTimeoutError('memory search exceeded 10000ms'));
    expect(isMemoryDegraded()).toBe(true);
    vi.advanceTimersByTime(memoryDegradedCooldownMs() - 1);
    expect(isMemoryDegraded()).toBe(true); // still inside the cooldown
    vi.advanceTimersByTime(2);
    expect(isMemoryDegraded()).toBe(false); // self-healed — the key fix
  });

  it('a NON-timeout error does not arm the latch', () => {
    noteMemoryFailure(new Error('connection reset'));
    expect(isMemoryDegraded()).toBe(false);
  });

  it('request-budget expiry cannot arm or extend a backend cooldown', () => {
    const requestTimeout = new MemoryTimeoutError('shared prompt budget expired', 'request-budget');
    noteMemoryFailure(requestTimeout);
    expect(isMemoryDegraded()).toBe(false);
    noteMemoryFailure(new MemoryTimeoutError('explicit tool search hung'));
    vi.advanceTimersByTime(memoryDegradedCooldownMs() - 100);
    noteMemoryFailure(requestTimeout);
    vi.advanceTimersByTime(101);
    expect(isMemoryDegraded()).toBe(false);
  });

  it('a fresh timeout during the cooldown re-arms (extends) the quiet window', () => {
    noteMemoryFailure(new MemoryTimeoutError('t1'));
    vi.advanceTimersByTime(memoryDegradedCooldownMs() - 100);
    noteMemoryFailure(new MemoryTimeoutError('t2')); // re-arm near the end of the window
    vi.advanceTimersByTime(200); // past the FIRST window…
    expect(isMemoryDegraded()).toBe(true); // …but still inside the re-armed one
    vi.advanceTimersByTime(memoryDegradedCooldownMs());
    expect(isMemoryDegraded()).toBe(false);
  });

  it('the cooldown is env-tunable', () => {
    const prev = process.env.PAPERCUSP_MEMORY_DEGRADED_COOLDOWN_MS;
    process.env.PAPERCUSP_MEMORY_DEGRADED_COOLDOWN_MS = '5000';
    try {
      expect(memoryDegradedCooldownMs()).toBe(5000);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_MEMORY_DEGRADED_COOLDOWN_MS;
      else process.env.PAPERCUSP_MEMORY_DEGRADED_COOLDOWN_MS = prev;
    }
  });

  it('an invalid/zero env cooldown falls back to the 60s default', () => {
    const prev = process.env.PAPERCUSP_MEMORY_DEGRADED_COOLDOWN_MS;
    process.env.PAPERCUSP_MEMORY_DEGRADED_COOLDOWN_MS = '0';
    try {
      expect(memoryDegradedCooldownMs()).toBe(60_000);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_MEMORY_DEGRADED_COOLDOWN_MS;
      else process.env.PAPERCUSP_MEMORY_DEGRADED_COOLDOWN_MS = prev;
    }
  });
});

describe('withMemoryTimeout — deadline race', () => {
  it('distinguishes a shared lifetime from a shorter backend-operation cap', async () => {
    vi.useFakeTimers();
    const shared = createMemoryWorkDeadline(100);
    const capped = createMemoryWorkDeadline(100);
    try {
      const sharedFailure = shared.run(() => new Promise(() => {}), 'shared search')
        .catch((error: unknown) => error);
      const cappedFailure = capped.run(() => new Promise(() => {}), 'search', 20)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20);
      expect(await cappedFailure).toMatchObject({
        scope: 'backend-operation', phase: 'memory-search', elapsedMs: 20,
      });
      await vi.advanceTimersByTimeAsync(80);
      expect(await sharedFailure).toMatchObject({
        scope: 'request-budget', phase: 'shared-budget', elapsedMs: 100,
      });
    } finally { shared.close(); capped.close(); vi.useRealTimers(); }
  });

  it('uses the closed phase vocabulary instead of persisting arbitrary timeout labels', async () => {
    vi.useFakeTimers();
    try {
      const failed = withMemoryTimeout(new Promise(() => {}), 'raw request label', 12)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(12);
      expect(await failed).toMatchObject({
        scope: 'backend-operation', phase: 'other', elapsedMs: 12,
      });
    } finally { vi.useRealTimers(); }
  });

  it('preserves an explicitly disabled local bound while honoring parent cancellation', async () => {
    const parent = new AbortController();
    const deadline = createMemoryWorkDeadline(Number.POSITIVE_INFINITY, parent.signal);
    try {
      await expect(deadline.run(async () => 'ready', 'unbounded local')).resolves.toBe('ready');
      const pending = deadline.run(() => new Promise<string>(() => {}), 'parent-bound');
      const rejected = expect(pending).rejects.toThrow('parent expired');
      parent.abort(new Error('parent expired'));
      await rejected;
    } finally { deadline.close(); }
  });

  it('spends one deadline across phases and never starts work after expiry', async () => {
    vi.useFakeTimers();
    const deadline = createMemoryWorkDeadline(100);
    try {
      const first = deadline.run(() => new Promise<string>((resolve) => setTimeout(() => resolve('ready'), 70)), 'admission');
      await vi.advanceTimersByTimeAsync(70);
      await expect(first).resolves.toBe('ready');
      const second = deadline.run(() => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 70)), 'embed');
      const rejected = expect(second).rejects.toBeInstanceOf(MemoryTimeoutError);
      await vi.advanceTimersByTimeAsync(30);
      await rejected;
      const lexical = vi.fn(async () => 'late');
      await expect(deadline.run(lexical, 'lexical')).rejects.toBeInstanceOf(MemoryTimeoutError);
      expect(lexical).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
    } finally { deadline.close(); vi.useRealTimers(); }
  });

  // The Jev memory gate sizes its own wait from this, so its own timeout (which the
  // decision ledger records) fires before the deadline cuts it off (WI-10004485).
  it('reports the time left: counting down, 0 once expired or aborted, Infinity when unbounded', async () => {
    vi.useFakeTimers();
    const deadline = createMemoryWorkDeadline(100);
    const unbounded = createMemoryWorkDeadline(Number.POSITIVE_INFINITY);
    const parent = new AbortController();
    const child = createMemoryWorkDeadline(1_000, parent.signal);
    try {
      expect(deadline.remainingMs()).toBe(100);
      await vi.advanceTimersByTimeAsync(40);
      expect(deadline.remainingMs()).toBe(60);
      await vi.advanceTimersByTimeAsync(60);
      expect(deadline.remainingMs()).toBe(0);
      await vi.advanceTimersByTimeAsync(50);
      expect(deadline.remainingMs()).toBe(0);
      expect(unbounded.remainingMs()).toBe(Number.POSITIVE_INFINITY);
      expect(child.remainingMs()).toBe(850);
      parent.abort();
      expect(child.remainingMs()).toBe(0);
    } finally { deadline.close(); unbounded.close(); child.close(); vi.useRealTimers(); }
  });

  it('cancels a child immediately when its parent lifetime expires', async () => {
    const parent = new AbortController();
    const deadline = createMemoryWorkDeadline(5000, parent.signal);
    const p = deadline.run(() => new Promise<string>(() => {}), 'corpus');
    const rejected = expect(p).rejects.toThrow('obsolete');
    parent.abort(new Error('obsolete'));
    await rejected;
    expect(deadline.signal.aborted).toBe(true);
    deadline.close();
  });

  it('forwards expiry while retaining non-cooperative raw work until it settles', async () => {
    const controller = new AbortController();
    let resolve!: (v: string) => void;
    const raw = new Promise<string>((res) => { resolve = res; });
    const tracked = await runWithTrackedMemoryTimeouts(async () => {
      await expect(withMemoryTimeout(raw, 'search', 5, controller)).rejects.toBeInstanceOf(MemoryTimeoutError);
    });
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(MemoryTimeoutError);
    expect(tracked.pending).not.toBeNull();
    let drained = false;
    void tracked.pending!.then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    resolve('late');
    await tracked.pending;
    expect(drained).toBe(true);
  });

  it('never cancels a completed operation after its deadline', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      await expect(withMemoryTimeout(Promise.resolve('ok'), 'search', 5, controller)).resolves.toBe('ok');
      await vi.advanceTimersByTimeAsync(10);
      expect(controller.signal.aborted).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('rejects with MemoryTimeoutError when the op exceeds the deadline', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 1000));
    await expect(withMemoryTimeout(slow, 'slow-op', 10)).rejects.toBeInstanceOf(MemoryTimeoutError);
  });

  it('resolves with the value when the op beats the deadline', async () => {
    await expect(withMemoryTimeout(Promise.resolve('ok'), 'fast-op', 1000)).resolves.toBe('ok');
  });

  it('exposes raw work that outlives the caller deadline until that work really settles', async () => {
    let resolveUnderlying!: (value: string) => void;
    const underlying = new Promise<string>((resolve) => {
      resolveUnderlying = resolve;
    });

    const tracked = await runWithTrackedMemoryTimeouts(async () => {
      await expect(withMemoryTimeout(underlying, 'slow-op', 5)).rejects.toBeInstanceOf(MemoryTimeoutError);
      return 'fail-soft';
    });

    expect(tracked.outcome).toEqual({ ok: true, value: 'fail-soft' });
    expect(tracked.pending).not.toBeNull();
    let drained = false;
    void tracked.pending!.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    resolveUnderlying('late-result');
    await tracked.pending;
    expect(drained).toBe(true);
  });
});

describe('withMemoryWriteRetry — bounded retry so a transient timeout does not silently drop the fact (EI-6684)', () => {
  // A never-settling promise simulates a wedged write; the tool deadline is
  // shrunk so it fires in ~20ms (real timers) instead of 10s.
  const NEVER = <T>(): Promise<T> => new Promise<T>(() => {});
  const noSleep = async () => {};
  let prevTimeout: string | undefined;

  beforeEach(() => {
    resetMemoryDegradedForTest();
    prevTimeout = process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS;
    process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS = '20';
  });
  afterEach(() => {
    resetMemoryDegradedForTest();
    if (prevTimeout === undefined) delete process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS;
    else process.env.PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS = prevTimeout;
    delete process.env.PAPERCUSP_MEMORY_WRITE_MAX_ATTEMPTS;
  });

  it('RETRIES a transient timeout and succeeds on the second attempt — the fact is NOT dropped', async () => {
    let calls = 0;
    const attempt = () => {
      calls += 1;
      // First attempt hangs past the deadline (the "transient stall"); the retry succeeds.
      return calls === 1 ? NEVER<{ ids: string[] }>() : Promise.resolve({ ids: ['m1'] });
    };
    await expect(withMemoryWriteRetry(attempt, 'write', { sleep: noSleep })).resolves.toEqual({ ids: ['m1'] });
    expect(calls).toBe(2); // 1 timed-out + 1 success — the drop the incident reported is now recovered
  });

  it('gives up with MemoryTimeoutError after the bounded attempts on a SUSTAINED wedge — never hangs', async () => {
    let calls = 0;
    const attempt = () => { calls += 1; return NEVER<unknown>(); };
    await expect(withMemoryWriteRetry(attempt, 'write', { sleep: noSleep })).rejects.toBeInstanceOf(
      MemoryTimeoutError,
    );
    expect(calls).toBe(2); // default maxAttempts — bounded, not an unbounded storm
  });

  it('does NOT retry a NON-timeout failure (store down / bad key) — fails fast, one attempt', async () => {
    let calls = 0;
    const attempt = () => { calls += 1; return Promise.reject(new Error('mem0_unavailable')); };
    await expect(withMemoryWriteRetry(attempt, 'write', { sleep: noSleep })).rejects.toThrow('mem0_unavailable');
    expect(calls).toBe(1); // deterministic failure — retrying it just adds latency
  });

  it('does NOT retry when the process was ALREADY degraded before the write — a sustained wedge fails fast', async () => {
    noteMemoryFailure(new MemoryTimeoutError('an earlier memory op timed out')); // arm the latch first
    expect(isMemoryDegraded()).toBe(true);
    let calls = 0;
    const attempt = () => { calls += 1; return NEVER<unknown>(); };
    await expect(withMemoryWriteRetry(attempt, 'write', { sleep: noSleep })).rejects.toBeInstanceOf(
      MemoryTimeoutError,
    );
    expect(calls).toBe(1); // already-degraded skip — don't pile retries on a known-wedged backend
  });

  it('a first-attempt SUCCESS runs exactly once (no wasted retry)', async () => {
    let calls = 0;
    const attempt = () => { calls += 1; return Promise.resolve({ ids: ['ok'] }); };
    await expect(withMemoryWriteRetry(attempt, 'write', { sleep: noSleep })).resolves.toEqual({ ids: ['ok'] });
    expect(calls).toBe(1);
  });

  it('honors PAPERCUSP_MEMORY_WRITE_MAX_ATTEMPTS', async () => {
    process.env.PAPERCUSP_MEMORY_WRITE_MAX_ATTEMPTS = '3';
    let calls = 0;
    const attempt = () => { calls += 1; return NEVER<unknown>(); };
    await expect(withMemoryWriteRetry(attempt, 'write', { sleep: noSleep })).rejects.toBeInstanceOf(
      MemoryTimeoutError,
    );
    expect(calls).toBe(3);
  });

  it('max attempts = 1 opts OUT of retry (a timeout is surfaced on the first attempt)', async () => {
    process.env.PAPERCUSP_MEMORY_WRITE_MAX_ATTEMPTS = '1';
    let calls = 0;
    const attempt = () => { calls += 1; return NEVER<unknown>(); };
    await expect(withMemoryWriteRetry(attempt, 'write', { sleep: noSleep })).rejects.toBeInstanceOf(
      MemoryTimeoutError,
    );
    expect(calls).toBe(1);
  });
});

describe('memoryWriteMaxAttempts / memoryWriteRetryBackoffMs — tunables', () => {
  afterEach(() => {
    delete process.env.PAPERCUSP_MEMORY_WRITE_MAX_ATTEMPTS;
    delete process.env.PAPERCUSP_MEMORY_WRITE_RETRY_BACKOFF_MS;
  });

  it('defaults: 2 attempts, 250ms backoff', () => {
    expect(memoryWriteMaxAttempts()).toBe(2);
    expect(memoryWriteRetryBackoffMs()).toBe(250);
  });

  it('clamps max attempts to [1, 5] and floors fractionals; invalid → default', () => {
    process.env.PAPERCUSP_MEMORY_WRITE_MAX_ATTEMPTS = '99';
    expect(memoryWriteMaxAttempts()).toBe(5);
    process.env.PAPERCUSP_MEMORY_WRITE_MAX_ATTEMPTS = '3.9';
    expect(memoryWriteMaxAttempts()).toBe(3);
    process.env.PAPERCUSP_MEMORY_WRITE_MAX_ATTEMPTS = '0';
    expect(memoryWriteMaxAttempts()).toBe(2); // < 1 → default
    process.env.PAPERCUSP_MEMORY_WRITE_MAX_ATTEMPTS = 'junk';
    expect(memoryWriteMaxAttempts()).toBe(2); // NaN → default
  });

  it('backoff honors env, accepts 0 (no backoff), rejects negatives/junk', () => {
    process.env.PAPERCUSP_MEMORY_WRITE_RETRY_BACKOFF_MS = '1000';
    expect(memoryWriteRetryBackoffMs()).toBe(1000);
    process.env.PAPERCUSP_MEMORY_WRITE_RETRY_BACKOFF_MS = '0';
    expect(memoryWriteRetryBackoffMs()).toBe(0);
    process.env.PAPERCUSP_MEMORY_WRITE_RETRY_BACKOFF_MS = '-5';
    expect(memoryWriteRetryBackoffMs()).toBe(250); // negative → default
    process.env.PAPERCUSP_MEMORY_WRITE_RETRY_BACKOFF_MS = 'junk';
    expect(memoryWriteRetryBackoffMs()).toBe(250);
  });
});

describe('embedFailureReason — embed failure → clean degraded reason', () => {
  it('maps a hard insufficient_quota (billing) stop to embed_quota_exhausted, NOT rate-limited', () => {
    // mem0-embed-insufficient-quota-classification: the billing stop must NOT be shadowed by
    // the generic 429 branch — the agent narrates "check billing" (owner action), not "retrying".
    expect(embedFailureReason(new Error('openai_embed_quota_exhausted: {"error":{"type":"insufficient_quota"}}')))
      .toBe('embed_quota_exhausted');
  });

  it('maps a transient 429 rate-limit to embed_rate_limited', () => {
    expect(embedFailureReason(new Error('openai_embed_failed_429: rate limited'))).toBe('embed_rate_limited');
  });

  it('maps other embed failures (5xx / exhausted retries) to embed_unavailable', () => {
    expect(embedFailureReason(new Error('openai_embed_failed_503: boom'))).toBe('embed_unavailable');
    expect(embedFailureReason(new Error('openai_embed_failed: retries exhausted'))).toBe('embed_unavailable');
  });

  it('returns null for a non-embed error (let it propagate to handler_error)', () => {
    expect(embedFailureReason(new Error('some other failure'))).toBeNull();
    expect(embedFailureReason('a string error')).toBeNull();
  });

  it('EI-21348316803580175: maps a blown query-embed budget (embed_budget_exceeded) to embed_timeout', () => {
    // The exact message shape libs/generic/memory's EmbedBudgetExceededError throws when the
    // query embed blows SearchOptions.embedTimeoutMs. Classifying it is load-bearing: it is what
    // routes memory:search into its embed-free lexical fallback (WI-4214). Unclassified, it would
    // fall through to the raw `throw err` and become an opaque handler_error — turning a
    // slow-but-successful search into a failed one, i.e. worse than the regression it fixes.
    expect(
      embedFailureReason(new Error('embed_budget_exceeded: query embed exceeded 4000ms budget')),
    ).toBe('embed_timeout');
  });

  it('WI-4183: maps a dead-sidecar throw (sidecar_required_unavailable) to sidecar_unavailable', () => {
    // The exact message shape buildSidecarFirstEmbedder / embed-sidecar-wiring.ts throws when a
    // configured sidecar is unreachable (WI-4021 D-003: required, no in-process fallback) — a
    // plain Error, NOT a MemoryUnavailableError instance, so it must be caught here rather than
    // falling through to a raw handler_error.
    expect(
      embedFailureReason(
        new Error('sidecar_required_unavailable: fetch failed (http://127.0.0.1:3384, harrier:document, budget 15000ms)'),
      ),
    ).toBe('sidecar_unavailable');
  });
});
