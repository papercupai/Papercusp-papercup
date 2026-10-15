/**
 * revoked-set-cache.test.ts — WI-10005183.
 *
 * The hyperbee merge loop re-read the published revoked sets from Postgres at the
 * top of every ~1 s pass for every harness (162 identical queries/s live). The cache
 * must cut that to one read per change while never serving a set staler than the
 * last committed write this process has been told about. These cases pin both halves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _configureRevokedSetCacheForTests,
  _resetRevokedSetCacheForTests,
  readRevokedSetCached,
  REVOKED_SET_COHERENCE_RETRY_MS,
  revokedSetCacheKey,
  revokedSetCacheStats,
  type RevokedSetCoherenceHandlers,
} from '../revoked-set-cache';
import { loadRevokedPubkeysCached } from '../load-revoked-pubkeys';

const KEY = revokedSetCacheKey('contributors', 'ws-1', 'harness-a');

let clock = 1_000_000;
let handlers: RevokedSetCoherenceHandlers | null = null;
let startCalls = 0;

/** Attach coherence the way sync-sse would: capture the handlers, resolve = LISTEN live. */
function attachingStart(): (h: RevokedSetCoherenceHandlers) => Promise<void> {
  return async (h) => {
    startCalls++;
    handlers = h;
  };
}

async function becomeCoherent(): Promise<void> {
  // The first read triggers the start; let its microtasks settle.
  await readRevokedSetCached('warmup', async () => new Set());
  await vi.waitFor(() => expect(revokedSetCacheStats().coherent).toBe(true));
}

beforeEach(() => {
  _resetRevokedSetCacheForTests();
  clock = 1_000_000;
  handlers = null;
  startCalls = 0;
  _configureRevokedSetCacheForTests({ now: () => clock, startCoherence: attachingStart() });
});

afterEach(() => {
  _resetRevokedSetCacheForTests();
});

describe('revoked-set-cache (WI-10005183)', () => {
  it('reads Postgres on every call until it is attached to a live LISTEN', async () => {
    _configureRevokedSetCacheForTests({ startCoherence: () => new Promise<void>(() => {}) });
    const load = vi.fn(async () => new Set(['pk']));
    for (let i = 0; i < 5; i++) await readRevokedSetCached(KEY, load);
    expect(load).toHaveBeenCalledTimes(5);
    expect(revokedSetCacheStats().coherent).toBe(false);
  });

  it('serves N unchanged passes from at most one read once coherent', async () => {
    await becomeCoherent();
    const load = vi.fn(async () => new Set(['pk-1']));
    for (let i = 0; i < 50; i++) {
      expect(await readRevokedSetCached(KEY, load)).toEqual(new Set(['pk-1']));
    }
    expect(load).toHaveBeenCalledTimes(1);
    expect(startCalls).toBe(1);
  });

  it('returns an independent copy, so a caller mutating its set cannot poison the cache', async () => {
    await becomeCoherent();
    const load = vi.fn(async () => new Set(['pk-1']));
    const first = await readRevokedSetCached(KEY, load);
    first.add('hive-pk');
    expect(await readRevokedSetCached(KEY, load)).toEqual(new Set(['pk-1']));
  });

  it('a contributors or pot_members change is seen on the very next read', async () => {
    await becomeCoherent();
    let published = new Set<string>();
    const load = vi.fn(async () => new Set(published));
    expect(await readRevokedSetCached(KEY, load)).toEqual(new Set());

    published = new Set(['revoked-device']);
    handlers!.onEvent('harness_shared.contributors.changed');
    expect(await readRevokedSetCached(KEY, load)).toEqual(new Set(['revoked-device']));

    // Un-revoke (WI-193) travels the same way.
    published = new Set();
    handlers!.onEvent('harness_shared.pot_members.changed');
    expect(await readRevokedSetCached(KEY, load)).toEqual(new Set());
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('ignores unrelated table changes', async () => {
    await becomeCoherent();
    const load = vi.fn(async () => new Set(['pk']));
    await readRevokedSetCached(KEY, load);
    handlers!.onEvent('harness_shared.work_items.changed');
    handlers!.onEvent('workItems.summary');
    await readRevokedSetCached(KEY, load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('drops everything on a LISTEN reconnect, since NOTIFYs during the gap are lost', async () => {
    await becomeCoherent();
    const load = vi.fn(async () => new Set(['pk']));
    await readRevokedSetCached(KEY, load);
    handlers!.onListen();
    await readRevokedSetCached(KEY, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('re-reads after the fail-safe max age even with no event', async () => {
    _configureRevokedSetCacheForTests({ maxAgeMs: 30_000 });
    await becomeCoherent();
    const load = vi.fn(async () => new Set(['pk']));
    await readRevokedSetCached(KEY, load);
    clock += 29_999;
    await readRevokedSetCached(KEY, load);
    expect(load).toHaveBeenCalledTimes(1);
    clock += 2;
    await readRevokedSetCached(KEY, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not store a load that an invalidation overtook', async () => {
    await becomeCoherent();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowStale = vi.fn(async () => {
      await gate;
      return new Set(['stale']);
    });
    const inFlight = readRevokedSetCached(KEY, slowStale);
    handlers!.onEvent('harness_shared.contributors.changed'); // write committed mid-read
    release();
    expect(await inFlight).toEqual(new Set(['stale'])); // no staler than an uncached query
    const fresh = vi.fn(async () => new Set(['fresh']));
    expect(await readRevokedSetCached(KEY, fresh)).toEqual(new Set(['fresh']));
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('shares one read between concurrent misses for the same scope', async () => {
    await becomeCoherent();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const load = vi.fn(async () => {
      await gate;
      return new Set(['pk']);
    });
    const reads = [readRevokedSetCached(KEY, load), readRevokedSetCached(KEY, load), readRevokedSetCached(KEY, load)];
    release();
    for (const r of await Promise.all(reads)) expect(r).toEqual(new Set(['pk']));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keys by scope: one harness never answers for another', async () => {
    await becomeCoherent();
    const a = vi.fn(async () => new Set(['a']));
    const b = vi.fn(async () => new Set(['b']));
    expect(await readRevokedSetCached(revokedSetCacheKey('contributors', 'ws-1', 'h-a'), a)).toEqual(new Set(['a']));
    expect(await readRevokedSetCached(revokedSetCacheKey('contributors', 'ws-1', 'h-b'), b)).toEqual(new Set(['b']));
    expect(await readRevokedSetCached(revokedSetCacheKey('pot_members', 'ws-1', 'h-a'), b)).toEqual(new Set(['b']));
  });

  it('after a failed attach, keeps reading uncached and retries only after the backoff', async () => {
    let attempts = 0;
    _configureRevokedSetCacheForTests({
      startCoherence: async () => {
        attempts++;
        throw new Error('LISTEN refused');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const load = vi.fn(async () => new Set(['pk']));
    await readRevokedSetCached(KEY, load);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    for (let i = 0; i < 10; i++) await readRevokedSetCached(KEY, load);
    expect(attempts).toBe(1);
    expect(load).toHaveBeenCalledTimes(11);
    clock += REVOKED_SET_COHERENCE_RETRY_MS;
    await readRevokedSetCached(KEY, load);
    expect(attempts).toBe(2);
    warn.mockRestore();
  });

  it('loadRevokedPubkeysCached routes the real contributors read through the cache', async () => {
    await becomeCoherent();
    const runQuery = vi.fn(async () => [{ revoked_pubkeys: ['dev-1'] }, { revoked_pubkeys: null }]);
    for (let i = 0; i < 10; i++) {
      expect(await loadRevokedPubkeysCached({ workspaceId: 'ws-1', harnessSlug: 'h-a', runQuery })).toEqual(
        new Set(['dev-1']),
      );
    }
    expect(runQuery).toHaveBeenCalledTimes(1);
    handlers!.onEvent('harness_shared.contributors.changed');
    await loadRevokedPubkeysCached({ workspaceId: 'ws-1', harnessSlug: 'h-a', runQuery });
    expect(runQuery).toHaveBeenCalledTimes(2);
  });
});
