// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetOriginSchedulersForTests,
  getOriginScheduler,
} from '@papercusp/sync';
import {
  _resetOriginSchedulerFetchDedupeForTests,
  backgroundRequest,
  classifyOriginSchedulerFetch,
  installOriginSchedulerFetch,
  isIdempotentReadMethod,
  schedulerTimeoutForMethod,
} from './origin-scheduler-fetch';

const ORIGIN = 'http://127.0.0.1:3070';

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function response(headers: Record<string, string> = {}): Response {
  return {
    headers: new Headers(headers),
  } as unknown as Response;
}

function stubWindow(fetchImpl: typeof fetch): void {
  vi.stubGlobal('window', {
    location: {
      href: `${ORIGIN}/adv`,
      origin: ORIGIN,
    },
    fetch: fetchImpl,
  });
}

afterEach(() => {
  _resetOriginSchedulersForTests();
  _resetOriginSchedulerFetchDedupeForTests();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  _resetOriginSchedulersForTests();
  _resetOriginSchedulerFetchDedupeForTests();
});

/**
 * A response double that models real body-consumption semantics: each object
 * may be read once, and `clone()` yields an independently readable copy. A
 * coalesced caller handed the SAME object as its peer therefore fails here,
 * which is the property the single-flight tests below actually check.
 */
function cloneableResponse(body: string, headers: Record<string, string> = {}): Response {
  const make = (): Response => {
    let used = false;
    return {
      headers: new Headers(headers),
      get bodyUsed() {
        return used;
      },
      clone: () => make(),
      text: async () => {
        if (used) throw new TypeError('body already read');
        used = true;
        return body;
      },
    } as unknown as Response;
  };
  return make();
}

describe('classifyOriginSchedulerFetch', () => {
  it('classifies safe reads as foreground and mutations as interactive', () => {
    stubWindow(vi.fn(async () => response()) as unknown as typeof fetch);
    expect(classifyOriginSchedulerFetch('/api/profile')).toMatchObject({
      schedule: true,
      origin: ORIGIN,
      requestClass: 'foreground-read',
      method: 'GET',
    });
    expect(
      classifyOriginSchedulerFetch('/api/profile', { method: 'POST' }),
    ).toMatchObject({
      schedule: true,
      requestClass: 'interactive-control',
      method: 'POST',
    });
  });

  it('honours a caller criticality hint that DEMOTES a read out of the visible lane', () => {
    stubWindow(vi.fn(async () => response()) as unknown as typeof fetch);
    // The whole point of the signal: a hidden global-chrome read stops sharing
    // the `foreground-read` lane with the read the visible view waits on.
    expect(
      classifyOriginSchedulerFetch('/api/profile', backgroundRequest()),
    ).toMatchObject({
      schedule: true,
      requestClass: 'background-sync',
      requestClassHint: 'background-sync',
      method: 'GET',
    });
    // The standard Fetch Priority hint means the same thing, so a caller that
    // already marks a read low-priority does not need a papercusp-specific field.
    expect(
      classifyOriginSchedulerFetch('/api/profile', {
        priority: 'low',
      } as RequestInit),
    ).toMatchObject({ requestClass: 'background-sync', requestClassHint: 'background-sync' });
    // A write may also be demoted — fire-and-forget telemetry is a real case.
    expect(
      classifyOriginSchedulerFetch('/api/telemetry', {
        ...backgroundRequest(),
        method: 'POST',
      }),
    ).toMatchObject({ requestClass: 'background-sync', method: 'POST' });
  });

  it('never lets a caller hint ESCALATE into the reserved interactive lane', () => {
    stubWindow(vi.fn(async () => response()) as unknown as typeof fetch);
    // `interactive-control` is reserved so a read wave cannot starve a user's
    // write. The wrapper sees every operator API call in the app, so if a hint
    // could raise priority the reservation would protect nothing. A hint may
    // only ever lower it.
    expect(
      classifyOriginSchedulerFetch('/api/profile', {
        papercuspRequestClass: 'interactive-control',
      } as RequestInit),
    ).toMatchObject({
      requestClass: 'foreground-read',
      requestClassHint: 'interactive-control',
      method: 'GET',
    });
    // Same rule one rung down: background may not promote itself to foreground.
    expect(
      classifyOriginSchedulerFetch('/api/profile', {
        papercuspRequestClass: 'foreground-read',
        priority: 'low',
      } as RequestInit),
    ).toMatchObject({ requestClass: 'foreground-read' });
    // `priority: 'high'` is read but earns no promotion.
    expect(
      classifyOriginSchedulerFetch('/api/profile', { priority: 'high' } as RequestInit),
    ).toMatchObject({ requestClass: 'foreground-read' });
    // A write keeps its own lane; the hint is not a way to give one away by accident.
    expect(
      classifyOriginSchedulerFetch('/api/profile', { method: 'POST' }),
    ).toMatchObject({ requestClass: 'interactive-control' });
  });

  it('ignores an unrecognised class hint rather than trusting it', () => {
    stubWindow(vi.fn(async () => response()) as unknown as typeof fetch);
    const decision = classifyOriginSchedulerFetch('/api/profile', {
      papercuspRequestClass: 'totally-made-up',
    } as unknown as RequestInit);
    expect(decision).toMatchObject({ requestClass: 'foreground-read' });
    // No hint was understood, so none is reported — a caller reading this back
    // must not see a class the wrapper never actually applied.
    expect(decision.requestClassHint).toBeUndefined();
  });

  it('leaves sync-owned, streaming, bulk, and foreign requests untouched', () => {
    stubWindow(vi.fn(async () => response()) as unknown as typeof fetch);
    expect(classifyOriginSchedulerFetch('/api/zero-harness/rest-query')).toMatchObject({
      schedule: false,
      reason: 'sync-query',
    });
    expect(classifyOriginSchedulerFetch('/api/zero-harness/sse')).toMatchObject({
      schedule: false,
      reason: 'stream',
    });
    expect(
      classifyOriginSchedulerFetch('/api/agent-mcp/stream', {
        headers: { accept: 'text/event-stream' },
      }),
    ).toMatchObject({ schedule: false, reason: 'stream' });
    expect(
      classifyOriginSchedulerFetch('/api/files/download', {
        headers: { range: 'bytes=0-' },
      }),
    ).toMatchObject({ schedule: false, reason: 'bulk' });
    expect(classifyOriginSchedulerFetch('/api/updates/download')).toMatchObject({
      schedule: false,
      reason: 'bulk',
    });
    // `/events` is not a stream marker by itself: backups/events returns a
    // bounded JSON history page and must share the finite origin queue.
    expect(classifyOriginSchedulerFetch('/api/backups/events?limit=5')).toMatchObject({
      schedule: true,
      requestClass: 'foreground-read',
    });
    expect(classifyOriginSchedulerFetch('/api/agent-mcp/events')).toMatchObject({
      schedule: false,
      reason: 'stream',
    });
    expect(classifyOriginSchedulerFetch('/api/activity/stream')).toMatchObject({
      schedule: false,
      reason: 'stream',
    });
    expect(classifyOriginSchedulerFetch('/api/operator/state-snapshot')).toMatchObject({
      schedule: false,
      reason: 'stream',
    });
    expect(classifyOriginSchedulerFetch('/api/deploy/demo/frame-view')).toMatchObject({
      schedule: false,
      reason: 'stream',
    });
    expect(classifyOriginSchedulerFetch('https://external.example/api/x')).toMatchObject({
      schedule: false,
      reason: 'not-operator-api',
    });
  });

  it('gives writes no scheduler deadline and leaves reads on the default', () => {
    expect(schedulerTimeoutForMethod('POST')).toBe(0);
    expect(schedulerTimeoutForMethod('put')).toBe(0);
    expect(schedulerTimeoutForMethod('PATCH')).toBe(0);
    expect(schedulerTimeoutForMethod('DELETE')).toBe(0);
    expect(schedulerTimeoutForMethod('GET')).toBeUndefined();
    expect(schedulerTimeoutForMethod('HEAD')).toBeUndefined();
    expect(schedulerTimeoutForMethod('OPTIONS')).toBeUndefined();
  });

  it('keeps the retry boundary limited to GET and HEAD', () => {
    expect(isIdempotentReadMethod('GET')).toBe(true);
    expect(isIdempotentReadMethod('HEAD')).toBe(true);
    expect(isIdempotentReadMethod('OPTIONS')).toBe(false);
    expect(isIdempotentReadMethod('POST')).toBe(false);
    expect(isIdempotentReadMethod('DELETE')).toBe(false);
  });
});

describe('installOriginSchedulerFetch', () => {
  it('attributes finite slot occupants without recording URL credentials or query secrets', async () => {
    const held = deferred<Response>();
    stubWindow(vi.fn(() => held.promise) as unknown as typeof fetch);
    const scheduler = getOriginScheduler(ORIGIN, { limit: 1, requestTimeoutMs: 0 });
    installOriginSchedulerFetch();
    const first = window.fetch(`${ORIGIN}/api/profile?token=private`);
    const duplicate = window.fetch(`${ORIGIN}/api/profile?token=private`);
    const queued = window.fetch(`${ORIGIN}/api/bootstrap?password=secret`);
    await tick();
    const samples = scheduler.snapshot().tasks!;
    expect(samples).toMatchObject([
      { label: 'GET /api/profile', state: 'running' },
      { label: 'GET /api/bootstrap', state: 'queued' },
    ]);
    expect(JSON.stringify(samples)).not.toMatch(/token|private|password|secret/);
    held.resolve(response());
    await Promise.all([first, duplicate, queued]);
    expect(scheduler.snapshot().tasks!.map((sample) => sample.state)).toEqual(['ok', 'ok']);
  });

  it('shares one origin-wide queue across raw fetch callers', async () => {
    const hold = deferred<void>();
    const inner = vi.fn(async () => {
      await hold.promise;
      return response({ 'content-length': '12', 'x-papercusp-protocol': 'h1' });
    });
    stubWindow(inner as unknown as typeof fetch);
    const scheduler = getOriginScheduler(ORIGIN, {
      limit: 1,
      reservedInteractive: 0,
      requestTimeoutMs: 1_000,
    });
    const handle = installOriginSchedulerFetch();
    expect(handle).not.toBeNull();

    const first = window.fetch('/api/first');
    await tick();
    const second = window.fetch('/api/second');
    await tick();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(scheduler.snapshot()).toMatchObject({ inFlight: 1, queued: 1 });

    hold.resolve();
    await Promise.all([first, second]);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(scheduler.snapshot().byClass['foreground-read']).toMatchObject({
      admitted: 2,
      completed: 2,
      bytes: 24,
    });
    handle?.uninstall();
  });

  it('runs an interactive mutation ahead of queued foreground reads', async () => {
    const hold = deferred<void>();
    const calls: string[] = [];
    const inner = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), ORIGIN);
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (calls.length === 1) await hold.promise;
      return response();
    });
    stubWindow(inner as unknown as typeof fetch);
    getOriginScheduler(ORIGIN, { limit: 1, reservedInteractive: 0, requestTimeoutMs: 1_000 });
    const handle = installOriginSchedulerFetch();

    const first = window.fetch('/api/read-1');
    await tick();
    const second = window.fetch('/api/read-2');
    const mutation = window.fetch('/api/mutate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await tick();
    hold.resolve();
    await Promise.all([first, second, mutation]);

    expect(calls).toEqual(['GET /api/read-1', 'POST /api/mutate', 'GET /api/read-2']);
    handle?.uninstall();
  });

  it('cancels a queued caller before it reaches the underlying IPC/native fetch', async () => {
    const hold = deferred<void>();
    const inner = vi.fn(async () => {
      await hold.promise;
      return response();
    });
    stubWindow(inner as unknown as typeof fetch);
    getOriginScheduler(ORIGIN, { limit: 1, reservedInteractive: 0, requestTimeoutMs: 1_000 });
    const handle = installOriginSchedulerFetch();

    const first = window.fetch('/api/holding');
    await tick();
    const controller = new AbortController();
    const queued = window.fetch('/api/unmounted', { signal: controller.signal });
    await tick();
    controller.abort();
    await expect(queued).rejects.toBeDefined();
    expect(inner).toHaveBeenCalledTimes(1);

    hold.resolve();
    await first;
    handle?.uninstall();
  });

  it('preserves the captured transport and never replays an unsafe write', async () => {
    const inner = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new TypeError('ambiguous transport failure');
    });
    stubWindow(inner as unknown as typeof fetch);
    getOriginScheduler(ORIGIN, { limit: 2, reservedInteractive: 1, requestTimeoutMs: 1_000 });
    const handle = installOriginSchedulerFetch();

    await expect(
      window.fetch('/api/lifecycle', { method: 'POST', body: '{}' }),
    ).rejects.toThrow('ambiguous transport failure');
    expect(inner).toHaveBeenCalledTimes(1);
    handle?.uninstall();
  });

  // WI-10003268: pot create takes 10–25s, and the scheduler's 20s default
  // reported "timed out" for pots the server went on to create.
  it('does not abort a slow write at the scheduler deadline, but still aborts a slow read', async () => {
    const hold = deferred<void>();
    const inner = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await Promise.race([
        hold.promise,
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      ]);
      return response();
    });
    stubWindow(inner as unknown as typeof fetch);
    getOriginScheduler(ORIGIN, { limit: 2, reservedInteractive: 0, requestTimeoutMs: 20 });
    const handle = installOriginSchedulerFetch();

    let writeSettled = false;
    const write = window.fetch('/api/harness/pots', { method: 'POST', body: '{}' });
    void write.then(
      () => { writeSettled = true; },
      () => { writeSettled = true; },
    );
    const read = window.fetch('/api/slow-read');

    await expect(read).rejects.toThrow(/timed out/);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(writeSettled).toBe(false);

    hold.resolve();
    await expect(write).resolves.toBeDefined();
    handle?.uninstall();
  });

  it('is idempotent and bypasses explicitly-owned paths without nesting', async () => {
    const inner = vi.fn(async () => response());
    stubWindow(inner as unknown as typeof fetch);
    const first = installOriginSchedulerFetch();
    const second = installOriginSchedulerFetch();
    expect(first).not.toBeNull();
    expect(second).toBeNull();

    await window.fetch('/api/zero-harness/rest-query');
    await window.fetch('/api/zero-harness/sse');
    await window.fetch('/assets/app.js');
    await window.fetch('https://external.example/api/x');
    expect(inner).toHaveBeenCalledTimes(4);
    first?.uninstall();
  });
});

/**
 * EI-22367004519166693 / EI-22365555120139128: startup repeats the same
 * bootstrap, auth and profile reads, and each duplicate consumes one of only
 * two connection-capped slots that visible reads also need.
 */
describe('installOriginSchedulerFetch single-flight read coalescing', () => {
  it('collapses identical concurrent reads into one underlying request', async () => {
    const hold = deferred<void>();
    const inner = vi.fn(async () => {
      await hold.promise;
      return response({ 'content-length': '10' });
    });
    stubWindow(inner as unknown as typeof fetch);
    getOriginScheduler(ORIGIN, { limit: 2, reservedInteractive: 0, requestTimeoutMs: 1_000 });
    const handle = installOriginSchedulerFetch();

    const first = window.fetch('/api/bootstrap');
    const second = window.fetch('/api/bootstrap');
    const third = window.fetch('/api/bootstrap');
    await tick();

    // The duplicates never reach the transport, so they never take a slot.
    expect(inner).toHaveBeenCalledTimes(1);

    hold.resolve();
    await expect(Promise.all([first, second, third])).resolves.toHaveLength(3);
    expect(inner).toHaveBeenCalledTimes(1);
    handle?.uninstall();
  });

  it('does NOT merge a visible read into an in-flight background read', async () => {
    const hold = deferred<void>();
    const inner = vi.fn(async () => {
      await hold.promise;
      return response({ 'content-length': '10' });
    });
    stubWindow(inner as unknown as typeof fetch);
    getOriginScheduler(ORIGIN, { limit: 2, reservedInteractive: 0, requestTimeoutMs: 1_000 });
    const handle = installOriginSchedulerFetch();

    // Hidden chrome starts a demoted read; the visible view then wants the same
    // URL. Coalescing hands a joiner the class of whichever read started FIRST,
    // so merging these would silently park the visible read in the background
    // lane — the exact inversion the criticality hint exists to prevent.
    const hidden = window.fetch('/api/bootstrap', backgroundRequest());
    const visible = window.fetch('/api/bootstrap');
    await tick();

    expect(inner).toHaveBeenCalledTimes(2);

    hold.resolve();
    await expect(Promise.all([hidden, visible])).resolves.toHaveLength(2);
    handle?.uninstall();
  });

  it('still collapses duplicates that share a demoted class', async () => {
    const hold = deferred<void>();
    const inner = vi.fn(async () => {
      await hold.promise;
      return response({ 'content-length': '10' });
    });
    stubWindow(inner as unknown as typeof fetch);
    getOriginScheduler(ORIGIN, { limit: 2, reservedInteractive: 0, requestTimeoutMs: 1_000 });
    const handle = installOriginSchedulerFetch();

    // The observed duplicates were one hidden caller issuing the same read
    // repeatedly, so splitting by class must not cost the dedup win there.
    const a = window.fetch('/api/bootstrap', backgroundRequest());
    const b = window.fetch('/api/bootstrap', backgroundRequest());
    await tick();

    expect(inner).toHaveBeenCalledTimes(1);

    hold.resolve();
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
    handle?.uninstall();
  });

  it('gives every coalesced caller an independently readable body', async () => {
    const hold = deferred<void>();
    const inner = vi.fn(async () => {
      await hold.promise;
      return cloneableResponse('{"ok":true}');
    });
    stubWindow(inner as unknown as typeof fetch);
    getOriginScheduler(ORIGIN, { limit: 2, reservedInteractive: 0, requestTimeoutMs: 1_000 });
    const handle = installOriginSchedulerFetch();

    const first = window.fetch('/api/profile');
    const second = window.fetch('/api/profile');
    await tick();
    hold.resolve();

    const [a, b] = await Promise.all([first, second]);
    // Handing both callers the same Response would make the second read throw.
    await expect(a.text()).resolves.toBe('{"ok":true}');
    await expect(b.text()).resolves.toBe('{"ok":true}');
    expect(inner).toHaveBeenCalledTimes(1);
    handle?.uninstall();
  });

  it('never merges requests that could legitimately differ', async () => {
    const inner = vi.fn(async () => response());
    stubWindow(inner as unknown as typeof fetch);
    getOriginScheduler(ORIGIN, { limit: 4, reservedInteractive: 0, requestTimeoutMs: 1_000 });
    const handle = installOriginSchedulerFetch();

    await Promise.all([
      // Differing auth header: a shared response could cross privilege.
      window.fetch('/api/whoami', { headers: { authorization: 'a' } }),
      window.fetch('/api/whoami', { headers: { authorization: 'b' } }),
      // Differing query string.
      window.fetch('/api/list?page=1'),
      window.fetch('/api/list?page=2'),
      // Mutations are never idempotent.
      window.fetch('/api/act', { method: 'POST', body: '{}' }),
      window.fetch('/api/act', { method: 'POST', body: '{}' }),
    ]);

    expect(inner).toHaveBeenCalledTimes(6);
    handle?.uninstall();
  });

  it('coalesces in flight only — it is not a response cache', async () => {
    const inner = vi.fn(async () => response());
    stubWindow(inner as unknown as typeof fetch);
    getOriginScheduler(ORIGIN, { limit: 2, reservedInteractive: 0, requestTimeoutMs: 1_000 });
    const handle = installOriginSchedulerFetch();

    await window.fetch('/api/options');
    await window.fetch('/api/options');

    expect(inner).toHaveBeenCalledTimes(2);
    handle?.uninstall();
  });

  it.each(['immediate', 'active'])('starts a fresh read when the last %s caller cancels before an immediate replacement', async phase => {
    const hold = deferred<void>();
    const inner = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      await hold.promise;
      return response();
    });
    stubWindow(inner as unknown as typeof fetch);
    getOriginScheduler(ORIGIN, { limit: 2, reservedInteractive: 0, requestTimeoutMs: 1_000 });
    const handle = installOriginSchedulerFetch();
    const controller = new AbortController();
    const abandoned = window.fetch('/api/tutorial-progress', { signal: controller.signal });
    void abandoned.catch(() => {});
    if (phase === 'active') await tick();
    controller.abort();
    // React StrictMode restarts the effect synchronously, before the old
    // rejected request's promise cleanup has removed its single-flight entry.
    const replacement = window.fetch('/api/tutorial-progress');
    void replacement.catch(() => {});
    await tick();
    hold.resolve();
    await expect(abandoned).rejects.toBeDefined();
    await expect(replacement).resolves.toBeDefined();
    expect(inner).toHaveBeenCalledTimes(2);
    handle?.uninstall();
  });

  it('lets one caller cancel without cancelling the read its peer awaits', async () => {
    const hold = deferred<void>();
    const inner = vi.fn(async () => {
      await hold.promise;
      return response();
    });
    stubWindow(inner as unknown as typeof fetch);
    getOriginScheduler(ORIGIN, { limit: 2, reservedInteractive: 0, requestTimeoutMs: 1_000 });
    const handle = installOriginSchedulerFetch();

    const controller = new AbortController();
    const abandoned = window.fetch('/api/auth', { signal: controller.signal });
    const kept = window.fetch('/api/auth');
    await tick();
    expect(inner).toHaveBeenCalledTimes(1);

    controller.abort();
    await expect(abandoned).rejects.toBeDefined();

    hold.resolve();
    await expect(kept).resolves.toBeDefined();
    handle?.uninstall();
  });
});
