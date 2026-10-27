/**
 * sync-sse — the per-process LISTEN fan-out, ring-buffer replay, the
 * PG-trigger → camelCase bridge, and the source-side notify dedupe.
 *
 * The real module opens a long-lived `postgres()` LISTEN connection; we mock
 * `postgres` so `.listen()` just captures the callback, then drive that
 * callback directly to simulate `pg_notify('sync_invalidate', …)` deliveries.
 * getOrgPg / getHarnessAdminUrl / the bridge map are mocked too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPinnedModuleStateForTest } from '@papercusp/module-singleton';

let capturedListen: ((raw: string) => void) | null = null;
let capturedOnListen: (() => void) | null = null;
const notifySql = vi.fn(async (..._args: unknown[]) => [] as unknown[]); // called as a tagged template
const listenEnd = vi.fn(async (..._args: unknown[]) => {});
type BridgeTarget = string | { name: string; args: Record<string, unknown> };
let bridgeReturn: (name: string, args?: Record<string, unknown>) => BridgeTarget[] = () => [];
const emitSysEvt = vi.fn();
// EI-6468 (WI-1547 boot-wiring regression guard): number of REMAINING `.listen()`
// calls that should reject before one finally succeeds — lets a test simulate "PG
// still coming up at boot" without touching real timers/network.
let listenFailuresRemaining = 0;

const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.resetModules();
  capturedListen = null;
  capturedOnListen = null;
  notifySql.mockClear();
  listenEnd.mockClear();
  bridgeReturn = () => [];
  emitSysEvt.mockClear();
  listenFailuresRemaining = 0;
  // Module state is pinned to the realm and SURVIVES `vi.resetModules()` — that
  // is the whole point of the pin — so each test must clear it explicitly or the
  // LISTEN rebuild hooks leak between tests. Since the migration to
  // `pinModuleState`, the state lives under a `Symbol.for` slot that a
  // `delete globalThis[name]` cannot reach; this is the supported reset.
  resetPinnedModuleStateForTest();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock('postgres');
  vi.doUnmock('@papercusp/db-org');
  vi.doUnmock('./embedded-pg-discovery');
  vi.doUnmock('./sync-resolver/table-to-query-names');
  vi.doUnmock('./cache/instance');
  vi.doUnmock('./events/engine');
  vi.doUnmock('./pg-listen-hub');
});

async function load() {
  vi.doMock('postgres', () => ({
    default: () => ({
      listen: (_ch: string, cb: (raw: string) => void, onListen?: () => void) => {
        if (listenFailuresRemaining > 0) {
          listenFailuresRemaining--;
          return Promise.reject(new Error('simulated LISTEN failure (PG not up yet)'));
        }
        capturedListen = cb;
        capturedOnListen = onListen ?? null;
        onListen?.();
        return Promise.resolve();
      },
      end: listenEnd,
    }),
  }));
  vi.doMock('./embedded-pg-discovery', () => ({ getHarnessAdminUrl: () => 'postgres://test' }));
  vi.doMock('@papercusp/db-org', async (orig) => ({
    ...(await orig<typeof import('@papercusp/db-org')>()),
    getOrgPg: () => ({ sql: notifySql }),
    // sync-sse.ts's dedicated LISTEN connection spreads this into its `postgres()`
    // options (EI-18122461766429683 zombie-safe tagging) — the mock must export it
    // or the real module's named import throws "no export defined on the mock".
    longLivedPoolConnectionOptions: (_label: string) => ({
      onnotice: () => {},
      connection: {},
    }),
  }));
  // caching-layer-tag-eca P-017 wired a cold-bust onListen hook into sync-sse;
  // stub the cache so the LISTEN start doesn't reach the real L1 instance.
  vi.doMock('./cache/instance', () => ({ getOperatorCache: () => ({ clearL1: () => {} }) }));
  vi.doMock('./sync-resolver/table-to-query-names', () => ({
    queryNamesForTriggerEvent: (name: string, args?: Record<string, unknown>) =>
      bridgeReturn(name, args),
  }));
  vi.doMock('./events/engine', () => ({ emitSystemEvent: emitSysEvt }));
  // This file exercises sync-sse's OWN bridging/replay/cold-bust logic against
  // the dedicated-connection path (the `postgres` mock above) — hub routing is
  // covered separately by pg-listen-hub.test.ts/.integration.test.ts and the
  // "routes onto the shared hub" case below. Force the direct-connection branch
  // so `hubListen`'s real implementation (which needs a real `.end()`-capable
  // postgres client) never runs against this file's minimal `postgres` mock.
  vi.doMock('./pg-listen-hub', () => ({
    hubListen: vi.fn(async () => () => {}),
    listenHubEnabled: () => false,
  }));
  return import('./sync-sse');
}

describe('sync-sse LISTEN fan-out + replay', () => {
  it('a sync_invalidate notify is parsed and delivered to every subscriber', async () => {
    const { subscribe } = await load();
    const a = vi.fn();
    const b = vi.fn();
    await subscribe(a);
    await subscribe(b);
    capturedListen!(JSON.stringify({ name: 'harnessArchives.byHarness', args: { slug: 'x' } }));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    const ev = a.mock.calls[0][0];
    expect(ev).toMatchObject({ name: 'harnessArchives.byHarness', args: { slug: 'x' } });
    expect(typeof ev.id).toBe('number');
    expect(typeof ev.ts).toBe('number');
  });

  it('ignores a non-JSON payload and a payload with no string name', async () => {
    const { subscribe } = await load();
    const sub = vi.fn();
    await subscribe(sub);
    capturedListen!('not json');
    capturedListen!(JSON.stringify({ args: {} })); // no name
    expect(sub).not.toHaveBeenCalled();
  });

  it('bridges a PG-trigger <schema>.<table>.changed event to its camelCase query names', async () => {
    bridgeReturn = (name) => (name === 'harness_shared.feature_queue.changed' ? ['featureQueue.byHarness'] : []);
    const { subscribe } = await load();
    const sub = vi.fn();
    await subscribe(sub);
    capturedListen!(JSON.stringify({ name: 'harness_shared.feature_queue.changed', args: { workspace_id: 'w', op: 'INSERT' } }));
    // original + one bridged event
    expect(sub).toHaveBeenCalledTimes(2);
    const names = sub.mock.calls.map((c) => c[0].name);
    expect(names).toContain('harness_shared.feature_queue.changed');
    expect(names).toContain('featureQueue.byHarness');
    const bridged = sub.mock.calls.find((c) => c[0].name === 'featureQueue.byHarness')![0];
    expect(bridged.args).toBeUndefined();
  });

  it('forwards the trigger args to the bridge and SCOPES a { name, args } target by row id', async () => {
    // caching-layer-tag-eca P-006: the bus now hands the trigger args
    // (workspace_id, op, id) to the bridge; a per-row query returns a scoped
    // { name, args } so the client invalidates just that row's cache key.
    const seen: Array<Record<string, unknown> | undefined> = [];
    bridgeReturn = (name, args) => {
      seen.push(args);
      if (name !== 'harness_shared.widget.changed') return [];
      const id = args?.id;
      return typeof id === 'string' ? [{ name: 'widget.byId', args: { id } }] : ['widget.byId'];
    };
    const { subscribe } = await load();
    const sub = vi.fn();
    await subscribe(sub);
    capturedListen!(
      JSON.stringify({
        name: 'harness_shared.widget.changed',
        args: { workspace_id: 'w1', op: 'UPDATE', id: 'widget-42' },
      }),
    );
    // bridge saw the row id from the trigger payload
    expect(seen).toEqual([{ workspace_id: 'w1', op: 'UPDATE', id: 'widget-42' }]);
    const scoped = sub.mock.calls.find((c) => c[0].name === 'widget.byId')![0];
    expect(scoped.args).toEqual({ id: 'widget-42' });
  });

  it('shortens agent-mode bridge windows without weakening hot-source targets', async () => {
    const controlPlaneTargets = ['advRoster.list', 'agentDetail.byOwner', 'goals.detail'];
    bridgeReturn = (name) =>
      name === 'harness_shared.agent_modes.changed' || name === 'harness_shared.coord_presence.changed'
        ? controlPlaneTargets
        : [];
    const { subscribe } = await load();
    const sub = vi.fn();
    await subscribe(sub);

    capturedListen!(JSON.stringify({ name: 'harness_shared.agent_modes.changed', args: { id: 'm1' } }));
    vi.advanceTimersByTime(500);
    capturedListen!(JSON.stringify({ name: 'harness_shared.agent_modes.changed', args: { id: 'm2' } }));
    for (const target of controlPlaneTargets) {
      expect(sub.mock.calls.filter((c) => c[0].name === target)).toHaveLength(1);
    }

    // The operator's 1s source+target override lets the next meaningful mode
    // change through, instead of inheriting the bus-wide 90s window.
    vi.advanceTimersByTime(501);
    capturedListen!(JSON.stringify({ name: 'harness_shared.agent_modes.changed', args: { id: 'm3' } }));
    for (const target of controlPlaneTargets) {
      expect(sub.mock.calls.filter((c) => c[0].name === target)).toHaveLength(2);
    }

    // The same query names still keep the production 90s guard for heartbeat
    // events from coord_presence.
    capturedListen!(JSON.stringify({ name: 'harness_shared.coord_presence.changed', args: { id: 'p1' } }));
    vi.advanceTimersByTime(1);
    capturedListen!(JSON.stringify({ name: 'harness_shared.coord_presence.changed', args: { id: 'p2' } }));
    for (const target of controlPlaneTargets) {
      expect(sub.mock.calls.filter((c) => c[0].name === target)).toHaveLength(3);
    }
  });

  it('D-012: work-item list targets coalesce on a 10s trailing window under sustained writes; other targets keep 2s', async () => {
    const { MAX_BRIDGE_COALESCE_WINDOW_MS } = await import('@papercusp/sync/server');
    // The control target is fed by the same hot source, so the only variable is the policy.
    bridgeReturn = (name) =>
      name === 'harness_shared.work_items.changed'
        ? ['workItems.summary', 'workItems.byHarness', 'featureQueue.byHarness']
        : [];
    const { subscribe, EXPENSIVE_LIST_COALESCE_WINDOW_MS, EXPENSIVE_LIST_QUERY_NAMES } = await load();
    // The library clamps larger values silently, so pin the policy inside the ceiling.
    expect(EXPENSIVE_LIST_COALESCE_WINDOW_MS).toBe(10_000);
    expect(EXPENSIVE_LIST_COALESCE_WINDOW_MS).toBeLessThanOrEqual(MAX_BRIDGE_COALESCE_WINDOW_MS);
    expect([...EXPENSIVE_LIST_QUERY_NAMES].sort()).toEqual(['workItems.byHarness', 'workItems.summary']);

    const sub = vi.fn();
    await subscribe(sub);
    const count = (name: string) => sub.mock.calls.filter((c) => c[0].name === name).length;

    // One work_items write every 500ms for 20s (41 writes), the live shape that
    // produced ~1 list invalidation per 2s per target on 2026-10-01.
    capturedListen!(JSON.stringify({ name: 'harness_shared.work_items.changed', args: { id: 'w0' } }));
    for (let i = 1; i <= 40; i++) {
      vi.advanceTimersByTime(500);
      capturedListen!(JSON.stringify({ name: 'harness_shared.work_items.changed', args: { id: `w${i}` } }));
    }
    // Leading edge + one trailing event at +10.5s for each list target.
    expect(count('workItems.summary')).toBe(2);
    expect(count('workItems.byHarness')).toBe(2);
    // The control keeps the 2s bound: leading + trailing at +2.5s, +4.5s ... +18.5s.
    expect(count('featureQueue.byHarness')).toBe(10);

    // The final write is still delivered, within the 10s bound.
    vi.advanceTimersByTime(500);
    const summaries = sub.mock.calls.map((c) => c[0]).filter((e) => e.name === 'workItems.summary');
    expect(summaries).toHaveLength(3);
    expect(summaries[2].ts).toBe(T0 + 20_000);
    expect(count('workItems.byHarness')).toBe(3);
  });

  it('taps emitSystemEvent for a <table>.changed event so cache.bumpTags fires on real DB changes', async () => {
    // caching-layer-tag-eca KEYSTONE: a real DB change (sync_invalidate NOTIFY) must reach the
    // in-process reaction matcher so the cache.bumpTags ECA rule invalidates — otherwise the
    // cache layer is built but INERT. bridgeTriggerEvent is the tap.
    const { bridgeTriggerEvent } = await load();
    bridgeTriggerEvent('harness_shared.widget.changed', { workspace_id: 'w1', op: 'UPDATE', id: 'widget-42' });
    expect(emitSysEvt).toHaveBeenCalledTimes(1);
    expect(emitSysEvt).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'harness_shared.widget.changed',
        args: { workspace_id: 'w1', op: 'UPDATE', id: 'widget-42' },
        workspaceId: 'w1',
      }),
    );
    // a non-.changed bridged/query event is NOT fed into the reaction matcher
    bridgeTriggerEvent('featureQueue.byHarness', { slug: 'x' });
    expect(emitSysEvt).toHaveBeenCalledTimes(1);
  });

  it('backfillSince replays only events with a higher id than the last seen', async () => {
    const { subscribe, backfillSince } = await load();
    await subscribe(vi.fn());
    capturedListen!(JSON.stringify({ name: 'q.one' }));
    capturedListen!(JSON.stringify({ name: 'q.two' }));
    const all = backfillSince(0);
    expect(all.map((e) => e.name)).toEqual(['q.one', 'q.two']);
    const afterFirst = backfillSince(all[0].id);
    expect(afterFirst.map((e) => e.name)).toEqual(['q.two']);
  });

  it('prunes events older than the 60s ring-buffer window from replay', async () => {
    const { subscribe, backfillSince } = await load();
    await subscribe(vi.fn());
    capturedListen!(JSON.stringify({ name: 'q.old' }));
    vi.setSystemTime(T0 + 61_000); // advance past HISTORY_WINDOW_MS
    capturedListen!(JSON.stringify({ name: 'q.new' })); // push triggers pruneHistory
    const replay = backfillSince(0);
    expect(replay.map((e) => e.name)).toEqual(['q.new']);
  });
});

describe('ensureInvalidationListener (EI-6468 / WI-1547: cache-ECA must not be inert)', () => {
  // A cachedRead consumer (e.g. work_items:list, feeding coord:orient's
  // claimable[]) relies on the cache-ECA (table-change → cache.bumpTags) to
  // invalidate promptly. That rail rides this SAME PG LISTEN connection, which
  // otherwise starts only lazily on the first SSE subscribe — a process that
  // never gets one (a reuseport worker serving only MCP/tool HTTP) had an
  // inert cache-ECA and served arbitrarily stale reads (the exact reported
  // shape of EI-6468: a just-completed/claimed work-item still showing as
  // claimable minutes later). `hono-host.ts` calls this eagerly at boot for
  // every process specifically to close that gap — these tests pin the
  // function's OWN retry/give-up contract in isolation.

  it('starts the LISTEN on the first attempt and returns true', async () => {
    const { ensureInvalidationListener } = await load();
    const ok = await ensureInvalidationListener();
    expect(ok).toBe(true);
    expect(capturedListen).not.toBeNull();
  });

  it('runs process-local rebuild hooks on the initial LISTEN and every reconnect', async () => {
    const { ensureInvalidationListener, registerInvalidationListenHook } = await load();
    const rebuild = vi.fn();
    const remove = registerInvalidationListenHook(rebuild);

    await expect(ensureInvalidationListener()).resolves.toBe(true);
    expect(rebuild).toHaveBeenCalledTimes(1);

    capturedOnListen?.(); // postgres-js reconnects and re-establishes LISTEN
    expect(rebuild).toHaveBeenCalledTimes(2);

    remove();
    capturedOnListen?.();
    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it('retries with backoff past a transient failure and eventually succeeds', async () => {
    const { ensureInvalidationListener } = await load();
    listenFailuresRemaining = 2; // fail attempts 1 and 2; succeed on attempt 3
    const promise = ensureInvalidationListener({ attempts: 5, delayMs: 1000 });
    // Drain the retry backoffs under fake timers (2 failures ⇒ 2 delayed retries).
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const ok = await promise;
    expect(ok).toBe(true);
    expect(capturedListen).not.toBeNull();
  });

  it('gives up after exhausting all attempts, returns false, and logs loudly (cache-ECA stays inert until the next SSE subscribe retries)', async () => {
    const { ensureInvalidationListener } = await load();
    listenFailuresRemaining = 99; // never succeeds
    const errSpy = vi.spyOn(console, 'error');
    const promise = ensureInvalidationListener({ attempts: 3, delayMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const ok = await promise;
    expect(ok).toBe(false);
    expect(capturedListen).toBeNull();
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes('cache-ECA inert in this process')),
    ).toBe(true);
  });

  it('stops the process LISTEN connection explicitly during host shutdown', async () => {
    const { ensureInvalidationListener, stopInvalidationListener } = await load();
    await expect(ensureInvalidationListener()).resolves.toBe(true);

    await stopInvalidationListener();

    expect(listenEnd).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
  });
});

describe('boot wiring: hono-host.ts eagerly starts the invalidation LISTEN (EI-6468 / WI-1547 regression guard)', () => {
  // A STATIC source check, not a behavioral one: the whole WI-1547 incident class
  // (cache-ECA silently inert in a cluster worker that never got an SSE subscriber)
  // is reintroduced just as easily by someone later refactoring startRequestServers
  // and DROPPING this one call as by never adding it in the first place — the prior
  // two describe blocks pin ensureInvalidationListener's own contract, but neither
  // catches "the host stopped calling it". Pin the call site directly.
  it('startRequestServers() calls ensureInvalidationListener() at boot', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../../apps/operator/bin/hono-host.ts'),
      'utf8',
    );
    expect(src).toContain("} from '@papercusp/operator-core/lib/sync-sse'");
    expect(src).toContain('ensureInvalidationListener');
    expect(src).toContain('stopInvalidationListener');
    const fnStart = src.indexOf('function startRequestServers');
    expect(fnStart).toBeGreaterThan(-1);
    // The call must live INSIDE startRequestServers, not merely somewhere in the file —
    // slice to the next top-level function/export boundary and search within it.
    const nextBoundary = src.indexOf('\nfunction ', fnStart + 1);
    const body = nextBoundary > -1 ? src.slice(fnStart, nextBoundary) : src.slice(fnStart);
    expect(body).toContain('ensureInvalidationListener()');
    // Shutdown hands every server one host-wide closer (closeHostResources, since
    // 2026-10-25), and that closer must still stop the LISTEN connection.
    expect(body).toContain('closeAdditionalResources: closeHostResources');
    const closerStart = src.indexOf('async function closeHostResources');
    expect(closerStart).toBeGreaterThan(-1);
    const closerEnd = src.indexOf('\n}', closerStart);
    expect(src.slice(closerStart, closerEnd)).toContain('stopInvalidationListener()');
  });
});

describe('sync-sse LISTEN routes onto the shared listen-hub when enabled (EI-19285171982840672)', () => {
  it('calls hubListen with the sync_invalidate channel instead of opening its own connection, and preserves the cold-bust onListen hook through it', async () => {
    const hubListenMock = vi.fn(
      async (_channel: string, _cb: (raw: string) => void, onListen?: () => void) => {
        onListen?.(); // simulate the hub's initial connect
        return () => {}; // unsubscribe
      },
    );
    vi.doMock('./pg-listen-hub', () => ({
      hubListen: hubListenMock,
      listenHubEnabled: () => true,
    }));
    // Re-do the rest of load()'s mocks (duplicated rather than reusing `load()`
    // so this one test can override just the hub mock above).
    vi.doMock('postgres', () => ({
      default: () => {
        throw new Error('should not open a direct connection when the hub is enabled');
      },
    }));
    vi.doMock('./embedded-pg-discovery', () => ({ getHarnessAdminUrl: () => 'postgres://test' }));
    vi.doMock('@papercusp/db-org', async (orig) => ({
      ...(await orig<typeof import('@papercusp/db-org')>()),
      getOrgPg: () => ({ sql: notifySql }),
      longLivedPoolConnectionOptions: (_label: string) => ({ onnotice: () => {}, connection: {} }),
    }));
    const cache = { clearL1: vi.fn() };
    vi.doMock('./cache/instance', () => ({ getOperatorCache: () => cache }));
    vi.doMock('./sync-resolver/table-to-query-names', () => ({
      queryNamesForTriggerEvent: (name: string, args?: Record<string, unknown>) => bridgeReturn(name, args),
    }));
    vi.doMock('./events/engine', () => ({ emitSystemEvent: emitSysEvt }));

    const { subscribe } = await import('./sync-sse');
    await subscribe(vi.fn());

    expect(hubListenMock).toHaveBeenCalledTimes(1);
    expect(hubListenMock.mock.calls[0][0]).toBe('sync_invalidate');
    // The onListen we passed through fired (simulated above) — cold-bust ran.
    expect(cache.clearL1).toHaveBeenCalledTimes(1);
  });
});

describe('sync-sse notifySyncInvalidate', () => {
  it('fires pg_notify on the sync_invalidate channel with the name + args payload', async () => {
    const { notifySyncInvalidate } = await load();
    await notifySyncInvalidate('feature_queue.changed', { harnessSlug: 'sheets' });
    expect(notifySql).toHaveBeenCalledTimes(1);
    // SQL is `SELECT pg_notify(${channel}, ${payload})` — channel is bound
    // param [1], payload is [2] (the pg-adapter parameterizes the channel).
    const payload = JSON.parse(String(notifySql.mock.calls[0][2]));
    expect(payload).toMatchObject({ name: 'feature_queue.changed', args: { harnessSlug: 'sheets' } });
  });

  it('dedupes an identical (name,args) notify within the 90s window, lets it through after', async () => {
    const { notifySyncInvalidate } = await load();
    await notifySyncInvalidate('q.x', { a: 1 });
    await notifySyncInvalidate('q.x', { a: 1 }); // duplicate within window → suppressed
    expect(notifySql).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + 91_000); // past DEDUPE_WINDOW_MS
    await notifySyncInvalidate('q.x', { a: 1 });
    expect(notifySql).toHaveBeenCalledTimes(2);
  });

  it('strips an oversized (>32KB) data payload, sending only name + args', async () => {
    const { notifySyncInvalidate } = await load();
    const big = [{ blob: 'x'.repeat(40_000) }];
    await notifySyncInvalidate('q.big', { k: 'v' }, big);
    const payload = JSON.parse(String(notifySql.mock.calls[0][2]));
    expect(payload.name).toBe('q.big');
    expect(payload.args).toEqual({ k: 'v' });
    expect(payload.data).toBeUndefined();
  });

  it('keeps a small data payload inline', async () => {
    const { notifySyncInvalidate } = await load();
    await notifySyncInvalidate('q.small', undefined, [{ id: 1 }]);
    const payload = JSON.parse(String(notifySql.mock.calls[0][2]));
    expect(payload.data).toEqual([{ id: 1 }]);
  });
});
