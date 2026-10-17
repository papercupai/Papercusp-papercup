/**
 * operator-state-cache.test.ts — the readOperatorState cache
 * (infra-perf-robustness-audit-2026-06-18 P-004). harness_registry is read on hot
 * paths (~13.8M seq-scans/window) but written rarely; P-008 measured the same
 * amplification on operator_account_pool (1.43M reads / ~19.5 days for one
 * 6.2KB row). A tiny per-(table,ws) TTL cache cuts the round-trips. These pin:
 * (a) a cache HIT avoids a 2nd SELECT, (b) a write INVALIDATES so the same
 * process never reads stale (read-after-write), (c) only the explicit allowlist
 * is cached, (d) PAPERCUSP_OPSTATE_CACHE_MS=0 is the kill-switch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
const counters = { selects: 0 };
const readFailures = { remaining: 0, error: null as Error | null };

vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws' }));
vi.mock('./db-encryption', () => ({ ENCRYPTED_TABLES: new Set<string>(), getDbEncryptionKey: () => 'unused' }));
vi.mock('@papercusp/db-org', async (orig) => {
  function tagged(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    const sqlText = strings.join('?');
    const tableName = (values[0] as { _table?: string })?._table ?? null;
    const ws = typeof values[1] === 'string' ? values[1] : 'ws';
    const key = `${tableName}:${ws}`;
    if (/SELECT payload FROM/.test(sqlText)) {
      counters.selects += 1;
      if (readFailures.remaining > 0) {
        readFailures.remaining -= 1;
        return Promise.reject(readFailures.error ?? new Error('unexpected test read failure'));
      }
      const row = store.get(key);
      return Promise.resolve(row !== undefined ? [{ payload: row }] : []);
    }
    if (/INSERT INTO/.test(sqlText)) {
      const raw = values[2];
      store.set(key, typeof raw === 'string' ? JSON.parse(raw) : raw);
      return Promise.resolve(/RETURNING workspace_id/.test(sqlText) ? [{ workspace_id: ws }] : []);
    }
    return Promise.resolve([]);
  }
  function sqlCallable(strs: TemplateStringsArray | string, ..._rest: unknown[]): unknown {
    if (typeof strs === 'string') return { _table: /harness_shared\.([a-zA-Z0-9_]+)/.exec(strs)?.[1] ?? null };
    return tagged(strs as TemplateStringsArray, ..._rest);
  }
  const wrapped = sqlCallable as unknown as typeof tagged;
  (wrapped as unknown as { begin: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T> }).begin = async <T>(
    cb: (tx: unknown) => Promise<T>,
  ) => cb(wrapped);
  return { ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: wrapped, db: {} }) };
});

// WI-1383 companion test seam: joinerPotHomeSlug's registry-not-hive fallback would
// otherwise reach real ./hive-store / ./hive-directory-meta modules (org-PG-backed) —
// neither is exercised by the registry-only scenario below (potHomeSlugForHarness
// answers from the registry entry directly), so these are trivial stand-ins purely to
// let the import graph resolve without a real DB, mirroring hive-federation.test.ts.
vi.mock('./hive-store', () => ({ getHiveBySlug: async () => null }));
vi.mock('./hive-directory-meta', () => ({ getOwnedHiveMeta: async () => null }));

// WI-10004071: a fake sync_invalidate bus — captures subscribers, (re)LISTEN hooks
// and every published notify, so the coherence tests can play "another process".
const bus = vi.hoisted(() => ({
  subscribers: [] as Array<(e: { name: string }) => void>,
  hooks: [] as Array<() => void>,
  notify: [] as Array<{ name: string; opts?: unknown }>,
}));
vi.mock('./sync-sse', () => ({
  subscribe: vi.fn(async (send: (e: { name: string }) => void) => {
    bus.subscribers.push(send);
    return { unsubscribe: () => {} };
  }),
  registerInvalidationListenHook: vi.fn((hook: () => void) => {
    bus.hooks.push(hook);
    return () => {};
  }),
  notifySyncInvalidate: vi.fn(async (name: string, _args?: unknown, _data?: unknown, opts?: unknown) => {
    bus.notify.push({ name, opts });
  }),
}));

import {
  readOperatorState,
  writeOperatorState,
  invalidateOperatorStateCache,
  startOperatorStateCacheCoherence,
  _resetOperatorStateCacheCoherenceForTests,
} from './operator-state-pg';
import { loadHarnessRegistry, saveHarnessRegistry } from './harness-registry';
import { joinerPotHomeSlug } from './hive-federation';

beforeEach(() => {
  store.clear();
  counters.selects = 0;
  readFailures.remaining = 0;
  readFailures.error = null;
  delete process.env.PAPERCUSP_OPSTATE_CACHE_MS;
  // Start each test with a clean cache for the keys it uses.
  invalidateOperatorStateCache('harness_registry' as never, 'ws');
  invalidateOperatorStateCache('operator_account_pool' as never, 'ws');
  invalidateOperatorStateCache('operator_budget' as never, 'ws');
});
afterEach(() => {
  delete process.env.PAPERCUSP_OPSTATE_CACHE_MS;
});

describe('readOperatorState cache (P-004)', () => {
  it('retries a read-only operator-state SELECT after SQLSTATE 55P03', async () => {
    store.set('operator_account_pool:ws', { accounts: [{ id: 'a' }] });
    readFailures.remaining = 1;
    readFailures.error = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });

    await expect(readOperatorState<{ accounts: { id: string }[] }>('operator_account_pool')).resolves.toEqual({
      accounts: [{ id: 'a' }],
    });
    expect(counters.selects).toBe(2);
    expect(readFailures.remaining).toBe(0);
  });

  it('caches an allowlisted table: a 2nd read within TTL hits the cache (no 2nd SELECT)', async () => {
    store.set('harness_registry:ws', { projects: [{ slug: 'a' }] });
    const first = await readOperatorState<{ projects: unknown[] }>('harness_registry');
    const second = await readOperatorState<{ projects: unknown[] }>('harness_registry');
    expect(first).toEqual({ projects: [{ slug: 'a' }] });
    expect(second).toEqual(first);
    expect(counters.selects).toBe(1); // 2nd served from cache
  });

  it('a write invalidates: the next read re-SELECTs and sees the new value (read-after-write)', async () => {
    store.set('harness_registry:ws', { projects: [] });
    await readOperatorState('harness_registry'); // populates cache (select #1)
    await writeOperatorState('harness_registry', { projects: [{ slug: 'new' }] }); // invalidates
    const after = await readOperatorState<{ projects: { slug: string }[] }>('harness_registry'); // select #2
    expect(after).toEqual({ projects: [{ slug: 'new' }] });
    expect(counters.selects).toBe(2); // not served stale from cache
  });

  it('caches the hot account-pool row and invalidates it on a same-process write', async () => {
    store.set('operator_account_pool:ws', { accounts: [{ id: 'a' }] });
    const first = await readOperatorState<{ accounts: { id: string }[] }>('operator_account_pool');
    const cached = await readOperatorState<{ accounts: { id: string }[] }>('operator_account_pool');
    expect(cached).toEqual(first);
    expect(counters.selects).toBe(1);

    await writeOperatorState('operator_account_pool', { accounts: [{ id: 'b' }] });
    const after = await readOperatorState<{ accounts: { id: string }[] }>('operator_account_pool');
    expect(after).toEqual({ accounts: [{ id: 'b' }] });
    expect(counters.selects).toBe(2);
  });

  it('does NOT cache a non-allowlisted table (always SELECTs)', async () => {
    store.set('operator_budget:ws', { spent: 1 });
    await readOperatorState('operator_budget');
    await readOperatorState('operator_budget');
    expect(counters.selects).toBe(2); // every read hits PG
  });

  it('PAPERCUSP_OPSTATE_CACHE_MS=0 is the kill-switch (caching disabled)', async () => {
    process.env.PAPERCUSP_OPSTATE_CACHE_MS = '0';
    store.set('harness_registry:ws', { projects: [] });
    await readOperatorState('harness_registry');
    await readOperatorState('harness_registry');
    expect(counters.selects).toBe(2); // no caching with TTL=0
  });
});

/**
 * WI-1383 — in-process regression for the WI-1378 federation roster-empty bug
 * (companion to owner-roster-rebind-race.repro.integration.test.ts, which reproduces
 * the SAME symptom via a full real-swarm boot; this file reproduces the actual ROOT
 * CAUSE — the cross-process opStateCache staleness itself — with no PG/swarm needed).
 *
 * ## The bug
 * `resolveHiveHomeProjectionSlug` (boot.ts) runs on the in-place rekey INSIDE the
 * substrate SIDECAR process (SUBSTRATE_SIDECAR) — a DIFFERENT process from join-hive's
 * registry WRITE. `invalidateOperatorStateCache` only clears the CACHE OF THE PROCESS
 * THAT WROTE — it can't reach the sidecar's own in-memory `opStateCache`. So if the
 * sidecar had already warmed its cache with the pre-join registry (any earlier
 * `loadHarnessRegistry` call, e.g. at boot), a DEFAULT (non-`fresh`) read after the
 * join still returns the STALE pre-join registry: `joinerPotHomeSlug` sees no
 * `hive_slug`/`remote_hive` yet → resolves null → the rekey rebind block skips →
 * `forceReFold` never fires → the member-slug projection binding latches → the
 * owner's `hive_members` rows drop forever (roster empty until a restart cold-read).
 *
 * ## The fix
 * `resolveHiveHomeProjectionSlug` passes `{ fresh: true }` through
 * `joinerPotHomeSlug` → `potHomeSlugForHarness` → `loadHarnessRegistry` →
 * `readOperatorState`, bypassing the cache READ (while still refreshing the cache
 * entry) so the sidecar sees the just-committed cross-process write immediately.
 *
 * ## Teeth
 * Dropping `{ fresh: true }` anywhere on that call chain (or reverting the
 * `!opts?.fresh` cache-bypass gate in `readOperatorState`) makes the "default resolve
 * stays stale" assertions below pass but the "`{ fresh: true }` sees the join"
 * assertions FAIL — pinning the fix's teeth without needing a live 2-process rig.
 */
describe('WI-1378/WI-1383: cross-process opStateCache staleness — the no-restart federation roster-empty repro', () => {
  it('readOperatorState: a default (cached) read stays stale after a cross-process write; { fresh:true } sees it immediately and refreshes the cache', async () => {
    // "Process A" (this test) warms the cache with the PRE-join registry — mirrors the
    // sidecar's own hot loadHarnessRegistry() call at boot, before the join happens.
    store.set('harness_registry:ws', { projects: [{ slug: 'member-a' }] });
    const primed = await readOperatorState<{ projects: Array<{ slug: string; hive_slug?: string }> }>(
      'harness_registry',
    );
    expect(primed?.projects[0]?.hive_slug).toBeUndefined();
    expect(counters.selects).toBe(1);

    // "Process B" (the main operator's join-hive flow, in production) commits the join
    // DIRECTLY on the backing store — simulating a write from a DIFFERENT process,
    // which never invalidates THIS process's in-memory opStateCache (that
    // invalidation is same-process only; see readOperatorState's WI-1378 comment).
    store.set('harness_registry:ws', {
      projects: [{ slug: 'member-a', hive_slug: 'the-hive' }],
    });

    // BUG repro: a default (cached) read is still served from the warm cache and does
    // NOT see the just-committed cross-process join.
    const staleRead = await readOperatorState<{ projects: Array<{ slug: string; hive_slug?: string }> }>(
      'harness_registry',
    );
    expect(
      staleRead?.projects[0]?.hive_slug,
      'a default (cached) read must still see the PRE-join registry — else this test no ' +
        'longer reproduces the cross-process staleness the WI-1378 bug depended on',
    ).toBeUndefined();
    expect(counters.selects, 'served from cache — no 2nd SELECT').toBe(1);

    // FIX: { fresh:true } (as boot.ts's sidecar rekey resolve now passes) bypasses the
    // stale cache and sees the committed join immediately.
    const freshRead = await readOperatorState<{ projects: Array<{ slug: string; hive_slug?: string }> }>(
      'harness_registry',
      undefined,
      { fresh: true },
    );
    expect(freshRead?.projects[0]?.hive_slug).toBe('the-hive');
    expect(counters.selects, 'fresh:true forces a real SELECT').toBe(2);

    // The fresh read also REFRESHES the cache entry, so a subsequent default reader
    // (e.g. the hot loadHarnessRegistry() callers that never pass fresh) now sees it too.
    const afterFresh = await readOperatorState<{ projects: Array<{ slug: string; hive_slug?: string }> }>(
      'harness_registry',
    );
    expect(afterFresh?.projects[0]?.hive_slug).toBe('the-hive');
    expect(counters.selects, 'served from the now-refreshed cache — no 3rd SELECT').toBe(2);
  });

  it('joinerPotHomeSlug: the joiner-home gate stays null on the stale cache (the live "roster stays empty" symptom); { fresh:true } resolves it', async () => {
    // Pre-join: member-a is a plain (non-member) harness. Prime the cache via a
    // loadHarnessRegistry() call, mirroring a hot boot-time read.
    store.set('harness_registry:ws', { projects: [{ slug: 'member-a' }] });
    await loadHarnessRegistry('ws');

    // The join commits from a DIFFERENT process (see the test above) — member-a
    // becomes a member of the-hive, a remote_hive (joined) view.
    store.set('harness_registry:ws', {
      projects: [
        { slug: 'the-hive', harness_kind: 'hive', remote_hive: true },
        { slug: 'member-a', hive_slug: 'the-hive' },
      ],
    });

    // BUG repro: the default resolve (no fresh) — what boot.ts's rekey resolve did
    // BEFORE the WI-1378 fix — still reads the stale pre-join registry, so the
    // joiner-home rebind gate stays null. This is the exact live symptom: the rekey
    // rebind block skips, forceReFold never fires, the owner's roster rows drop
    // forever.
    expect(
      await joinerPotHomeSlug('ws', 'member-a'),
      'a default (non-fresh) resolve must reproduce the stale-cache null — the ' +
        'pre-WI-1378 behavior that left the joiner roster empty',
    ).toBeNull();

    // FIX: { fresh:true } (boot.ts resolveHiveHomeProjectionSlug's WI-1378 fix) sees
    // the committed join immediately and resolves the hive-home slug — the rebind can
    // now engage.
    expect(await joinerPotHomeSlug('ws', 'member-a', { fresh: true })).toBe('the-hive');
  });
});

/**
 * WI-7032 — the SAME-process, SAME-workspace staleness variant of WI-1378/WI-1383
 * above, but caused by a DIFFERENT mechanism: not a genuinely separate OS process,
 * but two coexisting JS instances of `operator-state-pg.ts` loaded through two
 * different specifier paths in ONE process (the tsx-direct dual-module-load trap
 * already documented + fixed for orchestrator-workflow.ts's InjectedPipelineHooks,
 * WI-3830/WI-4015). Before this fix, `opStateCache` was a plain module-level `Map` —
 * each loaded instance got its OWN Map, so a registration write's
 * `invalidateOperatorStateCache` call on instance A never reached instance B's warm
 * cache, and a `resolveProject` running on instance B could see NULL for a harness
 * that had just committed successfully on instance A (reproduced live as
 * "resolveProject NULL — unknown harness slug=gymbaseline…" for freshly-registered
 * gym throwaway harnesses).
 *
 * The fix stores the cache Map on `globalThis` (Symbol.for-keyed, the same
 * hot-reload-safe-singleton idiom `pipelineHooks()` uses) so every module instance
 * in the process shares ONE cache regardless of which specifier space it loaded
 * through. `vi.resetModules()` + a fresh dynamic `import()` simulates the
 * dual-instance load: a genuinely distinct module instantiation, same process.
 */
describe('WI-7032: dual-module-load opStateCache staleness (tsx-direct trap)', () => {
  it('a cache entry warmed by one module instance is visible to a freshly re-imported second instance (globalThis-shared)', async () => {
    store.set('harness_registry:ws', { projects: [{ slug: 'warmed-by-a' }] });
    // Instance A: the top-level static import already bound at file load.
    const warmed = await readOperatorState<{ projects: Array<{ slug: string }> }>('harness_registry');
    expect(warmed?.projects[0]?.slug).toBe('warmed-by-a');
    expect(counters.selects).toBe(1);

    // Instance B: force Vitest to hand back a DISTINCT module instantiation for the
    // same file path — mirrors two specifier-spaces resolving the same source file
    // to two live instances under tsx-direct.
    vi.resetModules();
    const instanceB = await import('./operator-state-pg');
    expect(instanceB.readOperatorState).not.toBe(readOperatorState); // genuinely a different instance

    // With the OLD plain-module-Map cache this would have missed (instance B's own
    // empty Map) and re-SELECTed. With the globalThis-backed cache it hits instance
    // A's already-warmed entry — no 2nd SELECT.
    const seenByB = await instanceB.readOperatorState<{ projects: Array<{ slug: string }> }>('harness_registry');
    expect(seenByB?.projects[0]?.slug).toBe('warmed-by-a');
    expect(counters.selects, 'served from the globalThis-shared cache — no 2nd SELECT').toBe(1);
  });

  it('a write+invalidate on one module instance is honored by a freshly re-imported second instance (no stale read)', async () => {
    store.set('harness_registry:ws', { projects: [{ slug: 'pre-write' }] });
    await readOperatorState('harness_registry'); // instance A warms the cache (select #1)

    vi.resetModules();
    const instanceB = await import('./operator-state-pg');

    // Instance B writes a fresh value — its invalidate() must reach the SAME
    // globalThis-backed cache instance A's warm entry lives in.
    await instanceB.writeOperatorState('harness_registry', { projects: [{ slug: 'written-by-b' }] });

    // Instance A's next default (cached) read must see the write, not its own stale
    // pre-write cache entry — this is exactly the "resolveProject NULL" shape: a
    // registration commits on one module instance, a resolve on another must see it.
    const afterWrite = await readOperatorState<{ projects: Array<{ slug: string }> }>('harness_registry');
    expect(
      afterWrite?.projects[0]?.slug,
      'instance A must see instance B\'s committed write immediately, not a stale cached miss',
    ).toBe('written-by-b');
    expect(counters.selects, 'select #1 (warm) + select #2 (post-invalidate re-read)').toBe(2);
  });
});

describe('WI-10004071: cache coherence across cluster workers', () => {
  type Reg = { projects: Array<{ slug: string }> };
  const deliver = (name: string): void => bus.subscribers.forEach((send) => send({ name }));
  const slug = async (ws = 'ws'): Promise<string | undefined> =>
    (await readOperatorState<Reg>('harness_registry', ws))?.projects[0]?.slug;

  beforeEach(() => {
    bus.subscribers.length = 0;
    bus.hooks.length = 0;
    bus.notify.length = 0;
    _resetOperatorStateCacheCoherenceForTests();
    invalidateOperatorStateCache('harness_registry' as never, 'ws2');
  });

  it('CONTROL: without coherence, another process\'s write stays invisible for the TTL', async () => {
    store.set('harness_registry:ws', { projects: [{ slug: 'old' }] });
    expect(await slug()).toBe('old');
    store.set('harness_registry:ws', { projects: [{ slug: 'new' }] }); // written by a sibling worker
    deliver('harnessProjects.lite'); // nobody subscribed
    expect(await slug()).toBe('old');
  });

  it('a coherence event drops that table in every workspace; other events and tables are untouched', async () => {
    await startOperatorStateCacheCoherence();
    store.set('harness_registry:ws', { projects: [{ slug: 'old' }] });
    store.set('harness_registry:ws2', { projects: [{ slug: 'old2' }] });
    store.set('operator_account_pool:ws', { gen: 1 });
    await slug();
    await slug('ws2');
    await readOperatorState('operator_account_pool');
    store.set('harness_registry:ws', { projects: [{ slug: 'new' }] });
    store.set('harness_registry:ws2', { projects: [{ slug: 'new2' }] });
    store.set('operator_account_pool:ws', { gen: 2 });

    deliver('some.unrelated.query');
    expect(await slug()).toBe('old');

    deliver('harnessProjects.lite');
    expect(await slug()).toBe('new');
    expect(await slug('ws2')).toBe('new2');
    expect(await readOperatorState('operator_account_pool')).toEqual({ gen: 1 });

    deliver('accounts.pool');
    expect(await readOperatorState('operator_account_pool')).toEqual({ gen: 2 });
  });

  it('a (re)LISTEN drops every cacheable table (catch-up for NOTIFYs missed while disconnected)', async () => {
    await startOperatorStateCacheCoherence();
    store.set('harness_registry:ws', { projects: [{ slug: 'old' }] });
    await slug();
    store.set('harness_registry:ws', { projects: [{ slug: 'new' }] });
    expect(bus.hooks).toHaveLength(1);
    bus.hooks[0]!();
    expect(await slug()).toBe('new');
  });

  it('starting twice subscribes once', async () => {
    await startOperatorStateCacheCoherence();
    await startOperatorStateCacheCoherence();
    expect(bus.subscribers).toHaveLength(1);
    expect(bus.hooks).toHaveLength(1);
  });

  it('every registry write publishes its notify, un-deduped, before the write returns', async () => {
    await saveHarnessRegistry({ projects: [] } as never);
    await saveHarnessRegistry({ projects: [] } as never);
    const published = bus.notify.filter((n) => n.name === 'harnessProjects.lite');
    expect(published).toHaveLength(2);
    expect(published.every((n) => JSON.stringify(n.opts) === JSON.stringify({ dedupeWindowMs: 0 }))).toBe(true);
  });
});
