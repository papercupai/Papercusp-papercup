/**
 * release_resource.test.ts — the locks:release_resource HANDLER (tryReleaseResource +
 * broadcastResourceBackUp mocked; txn wrapper runs the callback). Pins: the required-arg
 * guard (lock_id OR resource), the result projection, and — the load-bearing part — that
 * a "back up" broadcast fires ONLY when an EXCLUSIVE resource was actually freed (and to
 * its waiters, not the whole fleet). A regression that broadcasts on every release, or
 * lets a no-arg call hit the store, is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/release_resource.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./identity', () => ({ readIdentity: vi.fn(() => ({ ownerId: 'me', coordinationDomain: 'dom' })) }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})),
}));
// WI-10004326: the lock_id locator defaults to "no recorded row" so the WI-5960
// cases keep exercising the inferred-candidate order unchanged.
vi.mock('./su-lock-store', () => ({
  tryReleaseResource: vi.fn(),
  getTxPool: vi.fn(() => ({})),
  readOwnedResourceLockDomain: vi.fn(async () => null),
}));
vi.mock('./contention-retry', () => ({ acquireWithContentionRetry: vi.fn() }));
vi.mock('./resource-broadcast', () => ({ broadcastResourceBackUp: vi.fn() }));

import { readOwnedResourceLockDomain, tryReleaseResource } from './su-lock-store';
import { mockImplementationTyped } from '../../testing/typed-mock';
import { acquireWithContentionRetry } from './contention-retry';
import { broadcastResourceBackUp } from './resource-broadcast';
const releaseM = vi.mocked(tryReleaseResource);
const retryM = vi.mocked(acquireWithContentionRetry);
const backUpM = vi.mocked(broadcastResourceBackUp);
const tool = (await import('./release_resource')).default;

type Out = { data?: any; content?: Array<{ text: string }> };
const call = (args: Record<string, unknown> = {}) => tool.handler(args as never, {} as never) as Promise<Out>;
const body = (o: Out) => (o.data ?? JSON.parse(o.content![0].text));

beforeEach(() => {
  vi.clearAllMocks();
  retryM.mockImplementation(async (run) => run());
  backUpM.mockResolvedValue(undefined as never);
});

describe('locks:release_resource handler', () => {
  it('requires lock_id or resource — refuses without touching the store', async () => {
    const b = body(await call());
    expect(b.ok).toBe(false);
    expect(String(b.error)).toMatch(/lock_id or resource/);
    expect(releaseM).not.toHaveBeenCalled();
  });

  it('wraps a single lock_id release through the keyed bulk envelope and does NOT broadcast for shared holds', async () => {
    // WI-5960: a lock_id-only release now tries each candidate domain in turn
    // (see coordination-domain.ts's candidateResourceLockDomains) and stops at
    // the first that actually released something — `released` is the real
    // store's NUMBER-of-rows-deleted shape (resource-lock-store.ts), not an
    // array of freed ids; a mock returning the wrong shape makes the `> 0`
    // domain-search check always false, so every domain gets tried and the
    // handler falls through to the "nothing released" default.
    releaseM.mockResolvedValue({ released: 1, releasedModes: ['shared'], exclusiveResources: [], waiters: {} } as never);
    const b = body(await call({ lock_id: '11111111-1111-1111-1111-111111111111' }));
    expect(b).toMatchObject({
      ok: true,
      counts: { ok: 1, failed: 0 },
      results: [
        { ok: true, lock_id: '11111111-1111-1111-1111-111111111111', released: 1, released_modes: ['shared'], exclusive_resources: [] },
      ],
    });
    expect(backUpM).not.toHaveBeenCalled();
  });

  it('WI-10004326: releases a lease acquired through ANOTHER operator install in its own recorded domain, first', async () => {
    const otherInstall = '/home/x/papercusp-staging';
    vi.mocked(readOwnedResourceLockDomain).mockResolvedValueOnce(otherInstall);
    mockImplementationTyped(releaseM, async (_tx, opts) =>
      (opts.coordinationDomain === otherInstall
        ? { released: 1, releasedModes: ['exclusive'], exclusiveResources: ['p013-benchmark-rig'], waiters: {} }
        : { released: 0, releasedModes: [], exclusiveResources: [], waiters: {} }) as never,
    );
    const b = body(await call({ lock_id: '22222222-2222-2222-2222-222222222222' }));
    expect(b.results[0]).toMatchObject({ ok: true, released: 1 });
    // one store call, in the located domain, owner-scoped: no inference was needed.
    expect(releaseM.mock.calls.map((c) => c[1].coordinationDomain)).toEqual([otherInstall]);
    expect(vi.mocked(readOwnedResourceLockDomain).mock.calls[0]?.slice(1)).toEqual([
      '22222222-2222-2222-2222-222222222222',
      'me',
    ]);
  });

  it('surfaces an expired-before-release warning instead of a silent ok:true / released:0', async () => {
    const lockId = '11111111-1111-1111-1111-111111111111';
    const expiredAt = new Date('2026-08-17T23:20:00.000Z');
    releaseM.mockResolvedValue({
      released: 0,
      releasedModes: [],
      exclusiveResources: [],
      expired: [{ lockId, resource: 'dev-server', mode: 'exclusive', expiredAt }],
      waiters: {},
    } as never);

    const b = body(await call({ lock_id: lockId }));

    expect(b).toMatchObject({
      ok: true,
      counts: { ok: 1, failed: 0 },
      results: [
        {
          ok: true,
          lock_id: lockId,
          released: 0,
          expired: true,
          warning: 'resource_lock_expired_before_release',
          note: expect.stringContaining('expired before release'),
          expired_at: expiredAt.toISOString(),
          expired_locks: [
            {
              lock_id: lockId,
              resource: 'dev-server',
              mode: 'exclusive',
              expired_at: expiredAt.toISOString(),
            },
          ],
        },
      ],
    });
    expect(backUpM).not.toHaveBeenCalled();
  });

  it('reports an unmatched resource as resource_not_held and suggests the caller\'s held prefix matches', async () => {
    releaseM.mockResolvedValue({
      released: 0,
      releasedModes: [],
      exclusiveResources: [],
      expired: [],
      heldResourceSuggestions: ['mac-test-vm:aviweiss@127.0.0.1:2222'],
      waiters: {},
    } as never);

    const b = body(await call({ resource: 'mac-test-vm' }));

    expect(b).toMatchObject({
      ok: false,
      counts: { ok: 0, failed: 1 },
      results: [
        {
          ok: false,
          resource: 'mac-test-vm',
          released: 0,
          error: 'resource_not_held',
          code: 'resource_not_held',
          held_resource_suggestions: ['mac-test-vm:aviweiss@127.0.0.1:2222'],
        },
      ],
    });
    expect(backUpM).not.toHaveBeenCalled();
  });

  it('wraps a single resource release through the keyed bulk envelope and broadcasts when exclusive', async () => {
    releaseM.mockResolvedValue({
      released: ['L2'], releasedModes: ['exclusive'], exclusiveResources: ['dev-server'], waiters: { 'dev-server': ['w1'] },
    } as never);
    const b = body(await call({ resource: 'dev-server' }));
    expect(b).toMatchObject({
      ok: true,
      counts: { ok: 1, failed: 0 },
      results: [
        { ok: true, resource: 'dev-server', released: ['L2'], released_modes: ['exclusive'], exclusive_resources: ['dev-server'] },
      ],
    });
    expect(backUpM).toHaveBeenCalledTimes(1);
    expect(backUpM.mock.calls[0]![0]).toMatchObject({ resource: 'dev-server', waiters: ['w1'] });
  });

  it('retries transient workspace contention before releasing a named-resource lease', async () => {
    const contention = Object.assign(
      new Error('workspace "host-global" contended (pg 57014: lock/statement timeout)'),
      { name: 'WorkspaceContendedError', pgCode: '57014' },
    );
    retryM.mockImplementation(async (run) => {
      try {
        return await run();
      } catch (error) {
        expect(error).toBe(contention);
        return await run();
      }
    });
    releaseM.mockRejectedValueOnce(contention);
    releaseM.mockResolvedValue({
      released: 1,
      releasedModes: ['exclusive'],
      exclusiveResources: ['git-sync:portal'],
      waiters: { 'git-sync:portal': ['waiter-1'] },
    } as never);

    const b = body(await call({ resource: 'git-sync:portal' }));

    expect(b).toMatchObject({
      ok: true,
      counts: { ok: 1, failed: 0 },
      results: [
        { ok: true, resource: 'git-sync:portal', released: 1, exclusive_resources: ['git-sync:portal'] },
      ],
    });
    expect(retryM).toHaveBeenCalledTimes(1);
    expect(releaseM).toHaveBeenCalledTimes(2);
    expect(backUpM).toHaveBeenCalledTimes(1);
  });

  it('releases selected resource lock_ids as a keyed bulk envelope', async () => {
    // WI-5960: `released` is the real store's NUMBER-of-rows-deleted shape —
    // see the note in the single-lock_id test above.
    mockImplementationTyped(releaseM, async () => ({
      released: 1,
      releasedModes: ['shared'],
      exclusiveResources: [],
      expired: [],
      waiters: {},
    }));
    const b = body(await call({
      lock_ids: [
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
      ],
    }));
    expect(b).toMatchObject({
      ok: true,
      counts: { ok: 2, failed: 0 },
      results: [
        { ok: true, lock_id: '11111111-1111-1111-1111-111111111111', released: 1, released_modes: ['shared'] },
        { ok: true, lock_id: '22222222-2222-2222-2222-222222222222', released: 1, released_modes: ['shared'] },
      ],
    });
  });

  it('releases selected resource names and broadcasts per exclusive resource', async () => {
    // The previous `as never` here hid a fixture that did not match tryReleaseResource's
    // real result: `released` is a COUNT, not an array of names, and `expired` was missing
    // entirely. Typed via mockImplementationTyped so the fixture cannot drift again.
    mockImplementationTyped(releaseM, async (_tx, spec) => {
      const resource = spec.resource as string;
      return {
        released: 1,
        releasedModes: ['exclusive'],
        exclusiveResources: [resource],
        expired: [],
        waiters: { [resource]: [`waiter:${resource}`] },
      };
    });
    const b = body(await call({ resources: ['dev-server', 'db'] }));
    expect(b).toMatchObject({
      ok: true,
      counts: { ok: 2, failed: 0 },
      results: [
        { ok: true, resource: 'dev-server', exclusive_resources: ['dev-server'] },
        { ok: true, resource: 'db', exclusive_resources: ['db'] },
      ],
    });
    expect(backUpM).toHaveBeenCalledTimes(2);
    expect(backUpM.mock.calls[0]![0]).toMatchObject({ resource: 'dev-server', waiters: ['waiter:dev-server'] });
    expect(backUpM.mock.calls[1]![0]).toMatchObject({ resource: 'db', waiters: ['waiter:db'] });
  });
});
