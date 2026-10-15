/**
 * Tests for resolveBearer — the single bearer-token → Principal gatekeeper
 * every MCP tool call passes through. It had ZERO coverage.
 *
 * PG is mocked (@papercusp/db-org): getOrgPg().sql returns the token_index
 * row; getOrgPgListener().sql is a separate direct LISTEN client; withWorkspace
 * runs its callback with a tx that returns the principal row. We exercise
 * resolveBearer's branching, NOT the SQL filters (those belong to the live-PG
 * cross-workspace-probe integration test).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Closure-configured fake result sets, set per test.
let tokenIndexRows: Array<Record<string, unknown>> = [];
let principalRows: Array<Record<string, unknown>> = [];
let withWorkspaceCalls = 0;
// Counts calls to the `sql` tagged template — in resolveBearer that is exactly
// the token_index SELECT (capability loads go through withWorkspace's tx, and
// sql.listen doesn't invoke the base fn), so this measures token_index lookups.
let sqlCalls = 0;
// Captured by the mock's sql.listen — lets tests fire NOTIFY payloads.
let listenChannel: string | null = null;
let listenCallback: ((payload: string) => void) | null = null;
let listenerHandleCalls = 0;
let listenerUnlistenCalls = 0;
let deferredListen: Promise<{ unlisten: () => Promise<void> }> | null = null;

vi.mock('@papercusp/db-org', async (orig) => {
  // tagged-template: sql`...` → sql(strings, ...values)
  const querySql = Object.assign((..._args: unknown[]) => {
    sqlCalls++;
    return Promise.resolve(tokenIndexRows);
  });
  const listenerSql = Object.assign((..._args: unknown[]) => Promise.resolve([]), {
    listen: (channel: string, cb: (payload: string) => void) => {
      listenerHandleCalls++;
      listenChannel = channel;
      listenCallback = cb;
      if (deferredListen) return deferredListen;
      return Promise.resolve({
        unlisten: () => { listenerUnlistenCalls++; return Promise.resolve(); },
      });
    },
  });
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    getOrgPg: () => ({ sql: querySql }),
    getOrgPgListener: () => ({ sql: listenerSql }),
    withWorkspace: (_ws: string, cb: (tx: unknown) => unknown) => {
      withWorkspaceCalls++;
      const tx = (..._a: unknown[]) => Promise.resolve(principalRows);
      return cb(tx);
    },
    // WI-7097: resolveTokenIdentity wraps its token_index query in a deadline
    // race — pass the promise straight through unchanged. The deadline's own
    // racing behavior is covered directly by db-call-deadline.test.ts; this
    // mock's job is only to keep resolveBearer's existing branching testable.
    withDbCallDeadline: (p: Promise<unknown>, _opts: unknown) => p,
  };
});

import { createHash } from 'node:crypto';
import {
  resolveBearer,
  invalidate,
  _resetAuthCacheForTests,
  _stopInvalidationListenerForTests,
  _authCacheTuning,
  PRINCIPAL_INVALIDATE_CHANNEL,
} from './auth';

const hashOf = (bearer: string) => createHash('sha256').update(bearer).digest('hex');

beforeEach(async () => {
  await _resetAuthCacheForTests();
  tokenIndexRows = [];
  principalRows = [];
  withWorkspaceCalls = 0;
  sqlCalls = 0;
  listenChannel = null;
  listenCallback = null;
  listenerHandleCalls = 0;
  listenerUnlistenCalls = 0;
  deferredListen = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('resolveBearer', () => {
  it('waits for and unlistens a subscription that finishes after teardown starts', async () => {
    const bearer = 'system-bearer-token-pending-listener';
    tokenIndexRows = [
      { token: bearer, kind: 'system', harness_slug: 'system:operator', workspace_id: 'ws1' },
    ];
    principalRows = [{ bearer_hash: hashOf(bearer), capabilities: ['*'] }];
    let finishListen!: (handle: { unlisten: () => Promise<void> }) => void;
    deferredListen = new Promise(done => { finishListen = done; });
    expect(await resolveBearer(bearer)).not.toBeNull();
    let stopped = false;
    const stopping = _stopInvalidationListenerForTests().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finishListen({ unlisten: async () => { listenerUnlistenCalls++; } });
    await stopping;
    expect(listenerUnlistenCalls).toBe(1);
    expect(stopped).toBe(true);
  });

  it('closes the principal invalidation LISTEN before test teardown', async () => {
    const bearer = 'system-bearer-token-listener-cleanup';
    tokenIndexRows = [
      { token: bearer, kind: 'system', harness_slug: 'system:operator', workspace_id: 'ws1' },
    ];
    principalRows = [{ bearer_hash: hashOf(bearer), capabilities: ['*'] }];

    expect(await resolveBearer(bearer)).not.toBeNull();
    expect(listenerHandleCalls).toBe(1);
    await _stopInvalidationListenerForTests();
    expect(listenerUnlistenCalls).toBe(1);
    await _stopInvalidationListenerForTests();
    expect(listenerUnlistenCalls).toBe(1);
  });

  it('returns null for an empty bearer (no PG lookup)', async () => {
    expect(await resolveBearer('')).toBeNull();
    expect(withWorkspaceCalls).toBe(0);
  });

  it('returns null when the bearer is not in token_index', async () => {
    tokenIndexRows = [];
    expect(await resolveBearer('unknown-token')).toBeNull();
  });

  it("returns null for a kind='harness' bearer (harness bearers are out of scope for v1)", async () => {
    tokenIndexRows = [
      { token: 'h', kind: 'harness', harness_slug: 'papercup', workspace_id: 'ws1' },
    ];
    expect(await resolveBearer('h')).toBeNull();
    // Never reaches capability load.
    expect(withWorkspaceCalls).toBe(0);
  });

  it('resolves a valid system principal to a trusted bearer-token Principal', async () => {
    const bearer = 'system-bearer-token-abcdef';
    tokenIndexRows = [
      { token: bearer, kind: 'system', harness_slug: 'system:operator', workspace_id: 'ws1' },
    ];
    principalRows = [{ bearer_hash: hashOf(bearer), capabilities: ['*'] }];

    const p = await resolveBearer(bearer);
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('system');
    expect(p!.slug).toBe('system:operator');
    expect(p!.workspaceId).toBe('ws1');
    expect(p!.authMethod).toBe('bearer-token');
    expect(p!.trust).toBe('trusted');
    expect(p!.capabilities.has('*')).toBe(true);
  });

  it('returns null when the stored bearer_hash does not match (tampered/forged token)', async () => {
    const bearer = 'system-bearer-token-abcdef';
    tokenIndexRows = [
      { token: bearer, kind: 'system', harness_slug: 'system:operator', workspace_id: 'ws1' },
    ];
    // Row exists but its hash is for a *different* secret — the only guard
    // against a token-table row being replayed with the wrong bearer.
    principalRows = [{ bearer_hash: hashOf('a-totally-different-secret'), capabilities: ['*'] }];

    expect(await resolveBearer(bearer)).toBeNull();
  });

  it('returns null for an ended pi session even with a matching hash', async () => {
    const bearer = 'pi-bearer-token-abcdef12';
    tokenIndexRows = [
      { token: bearer, kind: 'pi', harness_slug: 'pi:sess-1', workspace_id: 'ws1' },
    ];
    principalRows = [
      { bearer_hash: hashOf(bearer), capabilities: ['harness:read'], allowed_tools: null, ended_at: new Date(), expires_at: new Date(Date.now() + 60_000) },
    ];
    expect(await resolveBearer(bearer)).toBeNull();
  });

  it('resolves an active pi session (ended_at null) with a matching hash', async () => {
    const bearer = 'pi-bearer-token-abcdef12';
    tokenIndexRows = [
      { token: bearer, kind: 'pi', harness_slug: 'pi:sess-1', workspace_id: 'ws1' },
    ];
    principalRows = [
      { bearer_hash: hashOf(bearer), capabilities: ['harness:read'], allowed_tools: ['harness:status'], ended_at: null, expires_at: new Date(Date.now() + 60_000) },
    ];
    const p = await resolveBearer(bearer);
    expect(p!.kind).toBe('pi');
    expect(p!.capabilities.has('harness:read')).toBe(true);
    expect(p!.allowedTools?.has('harness:status')).toBe(true);
    expect(p!.allowedTools?.has('harness:list')).toBe(false);
  });

  it('rejects a PI bearer at its durable expiry, even if it was cached while valid', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-10-02T14:00:00.000Z');
    vi.setSystemTime(now);
    const bearer = 'pi-bearer-token-abcdef12';
    const expiresAt = new Date(now.getTime() + 5_000);
    tokenIndexRows = [
      { token: bearer, kind: 'pi', harness_slug: 'pi:sess-1', workspace_id: 'ws1' },
    ];
    principalRows = [
      {
        bearer_hash: hashOf(bearer), capabilities: ['harness:read'],
        allowed_tools: ['harness:status'], ended_at: null, expires_at: expiresAt,
      },
    ];

    expect(await resolveBearer(bearer)).not.toBeNull();
    expect(withWorkspaceCalls).toBe(1);
    vi.advanceTimersByTime(5_001);
    expect(await resolveBearer(bearer)).toBeNull();
    expect(withWorkspaceCalls).toBe(2);
  });

  it('serves a cached principal without re-loading capabilities, and re-loads after invalidate()', async () => {
    const bearer = 'system-bearer-token-abcdef';
    tokenIndexRows = [
      { token: bearer, kind: 'system', harness_slug: 'system:operator', workspace_id: 'ws1' },
    ];
    principalRows = [{ bearer_hash: hashOf(bearer), capabilities: ['*'] }];

    const first = await resolveBearer(bearer);
    expect(first).not.toBeNull();
    expect(withWorkspaceCalls).toBe(1);

    // Capability source now empty — a cache HIT must NOT re-query it.
    principalRows = [];
    const second = await resolveBearer(bearer);
    expect(second).not.toBeNull();
    expect(withWorkspaceCalls).toBe(1); // unchanged → served from cache

    // After invalidation the next call re-loads and now fails (revoked).
    invalidate('ws1', 'system:operator');
    const third = await resolveBearer(bearer);
    expect(third).toBeNull();
    expect(withWorkspaceCalls).toBe(2);
  });

  it('caches the null result for an ended pi session (no capability re-load per call)', async () => {
    const bearer = 'pi-bearer-token-abcdef12';
    tokenIndexRows = [
      { token: bearer, kind: 'pi', harness_slug: 'pi:sess-1', workspace_id: 'ws1' },
    ];
    principalRows = [
      { bearer_hash: hashOf(bearer), capabilities: ['harness:read'], allowed_tools: null, ended_at: new Date(), expires_at: new Date(Date.now() + 60_000) },
    ];
    expect(await resolveBearer(bearer)).toBeNull();
    expect(withWorkspaceCalls).toBe(1);
    expect(await resolveBearer(bearer)).toBeNull();
    expect(withWorkspaceCalls).toBe(1); // negative entry served from cache
  });

  describe('token_index identity cache (P1-3 — lifts the per-call admin SELECT off the hot path)', () => {
    it('serves the token_index identity from cache even after the principal cache is invalidated', async () => {
      const bearer = 'system-bearer-token-abcdef';
      tokenIndexRows = [
        { token: bearer, kind: 'system', harness_slug: 'system:operator', workspace_id: 'ws1' },
      ];
      principalRows = [{ bearer_hash: hashOf(bearer), capabilities: ['*'] }];

      expect(await resolveBearer(bearer)).not.toBeNull();
      const afterFirst = sqlCalls;
      expect(afterFirst).toBe(1); // the one token_index SELECT

      // Evict the principal (capability) cache — capabilities must re-load, but
      // the immutable token→identity mapping must NOT trigger a second SELECT.
      invalidate('ws1', 'system:operator');
      expect(await resolveBearer(bearer)).not.toBeNull();
      expect(withWorkspaceCalls).toBe(2); // capabilities re-loaded
      expect(sqlCalls).toBe(afterFirst); // token_index served from cache
    });

    it('negatively caches an unknown bearer (no repeat token_index SELECT within the negative TTL)', async () => {
      tokenIndexRows = [];
      expect(await resolveBearer('nope-token')).toBeNull();
      expect(sqlCalls).toBe(1);
      // Second probe of the same dead bearer is served from the negative cache.
      expect(await resolveBearer('nope-token')).toBeNull();
      expect(sqlCalls).toBe(1);
    });

    it('negatively caches a kind=harness bearer (out of scope) without re-querying', async () => {
      tokenIndexRows = [
        { token: 'h', kind: 'harness', harness_slug: 'papercup', workspace_id: 'ws1' },
      ];
      expect(await resolveBearer('h')).toBeNull();
      expect(sqlCalls).toBe(1);
      expect(await resolveBearer('h')).toBeNull();
      expect(sqlCalls).toBe(1); // out-of-scope kind cached negatively
      expect(withWorkspaceCalls).toBe(0); // never reached capability load
    });

    it('re-queries token_index after the identity cache TTL elapses', async () => {
      vi.useFakeTimers();
      try {
        const bearer = 'system-bearer-token-abcdef';
        tokenIndexRows = [
          { token: bearer, kind: 'system', harness_slug: 'system:operator', workspace_id: 'ws1' },
        ];
        principalRows = [{ bearer_hash: hashOf(bearer), capabilities: ['*'] }];

        expect(await resolveBearer(bearer)).not.toBeNull();
        expect(sqlCalls).toBe(1);

        // Past the positive TTL: both the identity and the principal cache expire.
        vi.advanceTimersByTime(_authCacheTuning.ttlMs + 1);
        expect(await resolveBearer(bearer)).not.toBeNull();
        expect(sqlCalls).toBe(2); // identity re-queried
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('TTL expiry', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('re-loads a positive entry after the TTL elapses', async () => {
      const bearer = 'system-bearer-token-abcdef';
      tokenIndexRows = [
        { token: bearer, kind: 'system', harness_slug: 'system:operator', workspace_id: 'ws1' },
      ];
      principalRows = [{ bearer_hash: hashOf(bearer), capabilities: ['*'] }];

      expect(await resolveBearer(bearer)).not.toBeNull();
      expect(withWorkspaceCalls).toBe(1);

      vi.advanceTimersByTime(_authCacheTuning.ttlMs - 1);
      expect(await resolveBearer(bearer)).not.toBeNull();
      expect(withWorkspaceCalls).toBe(1); // still cached

      vi.advanceTimersByTime(2);
      expect(await resolveBearer(bearer)).not.toBeNull();
      expect(withWorkspaceCalls).toBe(2); // expired → re-loaded
    });

    it('expires a negative entry after the (shorter) negative TTL', async () => {
      const bearer = 'pi-bearer-token-abcdef12';
      tokenIndexRows = [
        { token: bearer, kind: 'pi', harness_slug: 'pi:sess-1', workspace_id: 'ws1' },
      ];
      principalRows = [
        { bearer_hash: hashOf(bearer), capabilities: ['harness:read'], allowed_tools: null, ended_at: new Date(), expires_at: new Date(Date.now() + 60_000) },
      ];
      expect(await resolveBearer(bearer)).toBeNull();
      expect(withWorkspaceCalls).toBe(1);

      vi.advanceTimersByTime(_authCacheTuning.negativeTtlMs + 1);
      // Session has since been (re)started — the expired negative entry must
      // not mask it.
      principalRows = [
        { bearer_hash: hashOf(bearer), capabilities: ['harness:read'], allowed_tools: ['harness:status'], ended_at: null, expires_at: new Date(Date.now() + 60_000) },
      ];
      const p = await resolveBearer(bearer);
      expect(p).not.toBeNull();
      expect(withWorkspaceCalls).toBe(2);
    });
  });

  it('bounds the cache: the least-recently-used entry is evicted at the cap', async () => {
    const mkBearer = (i: number) => `bearer-${i}`;
    const resolveNth = async (i: number) => {
      tokenIndexRows = [
        { token: mkBearer(i), kind: 'system', harness_slug: `system:p${i}`, workspace_id: 'ws1' },
      ];
      principalRows = [{ bearer_hash: hashOf(mkBearer(i)), capabilities: ['*'] }];
      return resolveBearer(mkBearer(i));
    };

    for (let i = 0; i < _authCacheTuning.max; i++) {
      expect(await resolveNth(i)).not.toBeNull();
    }
    expect(withWorkspaceCalls).toBe(_authCacheTuning.max);

    // Touch entry 0 so it is most-recently-used, then insert one more.
    expect(await resolveNth(0)).not.toBeNull();
    expect(withWorkspaceCalls).toBe(_authCacheTuning.max); // cache hit
    expect(await resolveNth(_authCacheTuning.max)).not.toBeNull(); // evicts LRU (entry 1)

    // Entry 0 survived (recently used) …
    expect(await resolveNth(0)).not.toBeNull();
    expect(withWorkspaceCalls).toBe(_authCacheTuning.max + 1);
    // … entry 1 was evicted → re-load.
    expect(await resolveNth(1)).not.toBeNull();
    expect(withWorkspaceCalls).toBe(_authCacheTuning.max + 2);
  });

  describe('PG LISTEN invalidation', () => {
    it('subscribes to the invalidate channel and evicts the named principal on NOTIFY', async () => {
      const bearer = 'system-bearer-token-abcdef';
      tokenIndexRows = [
        { token: bearer, kind: 'system', harness_slug: 'system:operator', workspace_id: 'ws1' },
      ];
      principalRows = [{ bearer_hash: hashOf(bearer), capabilities: ['*'] }];

      expect(await resolveBearer(bearer)).not.toBeNull();
      expect(listenChannel).toBe(PRINCIPAL_INVALIDATE_CHANNEL);
      expect(listenCallback).not.toBeNull();
      expect(listenerHandleCalls).toBe(1);

      // Revoke: capability source now empty + NOTIFY fires (as provisioning.ts
      // emits on commit).
      principalRows = [];
      listenCallback!(JSON.stringify({ workspace_id: 'ws1', slug: 'system:operator' }));
      expect(await resolveBearer(bearer)).toBeNull();
      expect(withWorkspaceCalls).toBe(2); // cache was evicted → re-loaded
    });

    it('clears the whole cache on an unparseable NOTIFY payload (safe fallback)', async () => {
      const bearer = 'system-bearer-token-abcdef';
      tokenIndexRows = [
        { token: bearer, kind: 'system', harness_slug: 'system:operator', workspace_id: 'ws1' },
      ];
      principalRows = [{ bearer_hash: hashOf(bearer), capabilities: ['*'] }];

      expect(await resolveBearer(bearer)).not.toBeNull();
      listenCallback!('not-json');
      expect(await resolveBearer(bearer)).not.toBeNull();
      expect(withWorkspaceCalls).toBe(2); // whole cache cleared → re-loaded
    });
  });
});
