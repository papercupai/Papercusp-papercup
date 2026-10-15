/**
 * heartbeat_resource.test.ts — the locks:heartbeat_resource HANDLER (tryHeartbeatResource
 * mocked; txn wrapper runs the callback). Pins that ok mirrors `extended` (a successful
 * extension is ok:true with the new ISO expiry; a lapsed/owner-mismatch no-op is ok:false
 * with expires_ts:null). A regression that reports a no-op heartbeat as success — so a
 * caller believes its lease is alive when it lapsed — is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/heartbeat_resource.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./identity', () => ({
  readIdentity: vi.fn(() => ({ ownerId: 'me', coordinationDomain: 'dom' })),
  readFileLockIdentity: vi.fn(() => ({ ownerId: 'me', ownerLabel: 'me', coordinationDomain: 'dom' })),
}));
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})),
}));
// WI-10004326: the lock_id locator. Default null (no recorded row found) so the
// WI-5960 cases below exercise exactly the inferred-candidate fallback order.
vi.mock('./su-lock-store', () => ({
  tryHeartbeatResource: vi.fn(),
  getTxPool: vi.fn(() => ({})),
  readOwnedResourceLockDomain: vi.fn(async () => null),
}));
// WI-5960: a special-domain (git-sync:*, host-global) lease was ACQUIRED under a
// domain other than the caller's own tree-scoped one — heartbeat must be able to
// find it there too. Distinct from the caller's 'dom' so the fallback tests below
// can tell "found on the caller domain" apart from "found on the fallback".
vi.mock('./coordination-domain', () => ({
  candidateResourceLockDomains: vi.fn(() => ['dom', 'ws-scoped-domain', 'papercusp-host-global']),
}));

import { readOwnedResourceLockDomain, tryHeartbeatResource } from './su-lock-store';
import { inWorkspaceTxn } from './in-workspace-txn';
import { mockResolvedTyped } from '../../testing/typed-mock';
const hbM = vi.mocked(tryHeartbeatResource);
const txnM = vi.mocked(inWorkspaceTxn);
const tool = (await import('./heartbeat_resource')).default;
const fileLockTool = (await import('./heartbeat')).default;

type Out = { data?: any; content?: { text: string }[] };
const call = (args: Record<string, unknown> = { lock_id: '33333333-3333-3333-3333-333333333333' }) =>
  tool.handler(args as never, {} as never) as Promise<Out>;
const body = (o: Out) => o.data ?? JSON.parse(o.content![0]!.text);

beforeEach(() => vi.clearAllMocks());

describe('heartbeat tool selection guidance', () => {
  it('distinguishes file locks from named-resource leases', () => {
    expect(fileLockTool.name).toBe('locks:heartbeat');
    expect(fileLockTool.description).toContain('file lock');
    expect(fileLockTool.description).toContain('locks:heartbeat_resource');
    expect(tool.name).toBe('locks:heartbeat_resource');
    expect(tool.description).toContain('named-resource lease');
  });
});

describe('locks:heartbeat_resource handler', () => {
  it('extends and returns the new ISO expiry', async () => {
    mockResolvedTyped(hbM, { extended: true, expires_ts: new Date('2026-02-01T00:00:00Z') });
    const b = body(await call());
    expect(b).toMatchObject({
      ok: true,
      counts: { ok: 1, failed: 0 },
      results: [
        {
          ok: true,
          lock_id: '33333333-3333-3333-3333-333333333333',
          extended: true,
          expires_ts: '2026-02-01T00:00:00.000Z',
        },
      ],
    });
  });

  it('a no-op (lapsed / not owner) is ok:false with null expiry — never a false-alive', async () => {
    mockResolvedTyped(hbM, { extended: false, expires_ts: null });
    const b = body(await call());
    expect(b).toMatchObject({
      // Envelope ok is DERIVED (`counts.failed === 0`) — EI-23737206446729041.
      ok: false,
      counts: { ok: 0, failed: 1 },
      results: [
        {
          ok: false,
          lock_id: '33333333-3333-3333-3333-333333333333',
          extended: false,
          expires_ts: null,
          error: 'not_found_or_not_yours_or_expired',
        },
      ],
    });
  });

  it('heartbeats selected lock_ids as one keyed batch', async () => {
    mockResolvedTyped(hbM, { extended: true, expires_ts: new Date('2026-02-01T00:00:00Z') });
    const b = body(await call({
      lock_ids: [
        '33333333-3333-3333-3333-333333333333',
        '44444444-4444-4444-4444-444444444444',
      ],
    }));
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: any) => r.lock_id)).toEqual([
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
    ]);
    expect(hbM).toHaveBeenCalledTimes(2);
  });

  // WI-5960: before this fix, heartbeat resolved EVERY lease through only the
  // caller's own tree-scoped domain — so a `git-sync:<slug>` (or host-global)
  // lease, correctly ACQUIRED under a different domain, silently found nothing
  // to extend on every heartbeat and expired on schedule regardless. Pins the
  // fallback: the caller domain is tried first (cheap, common case), and a miss
  // there now falls through to the special-domain families instead of giving up.
  it('WI-5960: falls back to a special-domain lease when the caller domain finds nothing to extend', async () => {
    hbM.mockImplementation(async (_tx, domain) =>
      domain === 'ws-scoped-domain'
        ? { extended: true, expires_ts: new Date('2026-02-01T00:00:00Z') }
        : { extended: false, expires_ts: null },
    );
    const b = body(await call());
    expect(b).toMatchObject({
      ok: true,
      counts: { ok: 1, failed: 0 },
      results: [
        {
          ok: true,
          lock_id: '33333333-3333-3333-3333-333333333333',
          extended: true,
          expires_ts: '2026-02-01T00:00:00.000Z',
        },
      ],
    });
    // tried the caller's own domain ('dom') first, THEN the fallback that hit —
    // never skipped straight to the special domain, and stopped once it found it.
    expect(hbM.mock.calls.map((c) => c[1])).toEqual(['dom', 'ws-scoped-domain']);
  });

  it('WI-10004326: extends a lease acquired through ANOTHER operator install, in its own recorded domain', async () => {
    // The lease lives in a checkout domain this operator never infers (not 'dom',
    // not a special domain). Before the fix every candidate missed and the lease
    // lapsed however often its holder renewed it.
    const otherInstall = '/home/x/papercusp-staging';
    vi.mocked(readOwnedResourceLockDomain).mockResolvedValueOnce(otherInstall);
    hbM.mockImplementation(async (_tx, domain) =>
      domain === otherInstall
        ? { extended: true, expires_ts: new Date('2026-03-01T00:00:00Z') }
        : { extended: false, expires_ts: null },
    );
    const b = body(await call());
    expect(b.results[0]).toMatchObject({ ok: true, extended: true, expires_ts: '2026-03-01T00:00:00.000Z' });
    // located by lock_id + OWNER (never another owner's lease), and tried first.
    expect(vi.mocked(readOwnedResourceLockDomain).mock.calls[0]?.slice(1)).toEqual([
      '33333333-3333-3333-3333-333333333333',
      'me',
    ]);
    expect(hbM.mock.calls.map((c) => c[1])).toEqual([otherInstall]);
  });

  it('WI-10004326: a failed locator read degrades to the inferred candidates, never to fewer', async () => {
    vi.mocked(readOwnedResourceLockDomain).mockRejectedValueOnce(new Error('pool down'));
    mockResolvedTyped(hbM, { extended: false, expires_ts: null });
    await call();
    expect(hbM.mock.calls.map((c) => c[1])).toEqual(['dom', 'ws-scoped-domain', 'papercusp-host-global']);
  });

  it('WI-5960: reports the no-op (never-alive) result when NO domain — caller or special — has the lease', async () => {
    mockResolvedTyped(hbM, { extended: false, expires_ts: null });
    const b = body(await call());
    expect(b.results[0]).toMatchObject({ ok: false, extended: false, expires_ts: null });
    // every candidate domain was tried, in order, before giving up.
    expect(hbM.mock.calls.map((c) => c[1])).toEqual(['dom', 'ws-scoped-domain', 'papercusp-host-global']);
  });

  it('retries a transient workspace contention before reporting the heartbeat result', async () => {
    vi.useFakeTimers();
    try {
      const contended = Object.assign(new Error('workspace contended'), {
        name: 'WorkspaceContendedError',
        pgCode: '57014',
      });
      txnM.mockRejectedValueOnce(contended);
      // Let the parameter types come from the mocked signature (the pattern the rest
      // of this file uses). Hand-annotating them re-declared `fn` as returning
      // `unknown`, which no longer satisfies the real `(tx) => Promise<unknown>`.
      txnM.mockImplementation(async (_d, _o, fn) => fn({} as never));
      mockResolvedTyped(hbM, { extended: true, expires_ts: new Date('2026-02-01T00:00:00Z') });

      const pending = call();
      await vi.runAllTimersAsync();
      const b = body(await pending);

      expect(b).toMatchObject({
        ok: true,
        counts: { ok: 1, failed: 0 },
        results: [{ ok: true, extended: true }],
      });
      expect(txnM).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a persistent workspace contention as a keyed failure after retries', async () => {
    vi.useFakeTimers();
    try {
      const contended = Object.assign(new Error('workspace contended'), {
        name: 'WorkspaceContendedError',
        pgCode: '57014',
      });
      txnM.mockRejectedValue(contended);

      const pending = call();
      await vi.runAllTimersAsync();
      const b = body(await pending);

      expect(b).toMatchObject({
        // Envelope ok is DERIVED (`counts.failed === 0`) — EI-23737206446729041.
        ok: false,
        counts: { ok: 0, failed: 1 },
        results: [
          {
            ok: false,
            lock_id: '33333333-3333-3333-3333-333333333333',
            error: 'workspace contended',
          },
        ],
      });
      // One initial attempt plus the three contention backoffs; do not probe
      // other domains after the caller-domain transaction never serialized.
      expect(txnM).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
