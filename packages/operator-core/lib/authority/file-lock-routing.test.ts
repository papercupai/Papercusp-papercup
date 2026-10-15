/**
 * file-lock-routing.test.ts — the file-claim → lock-authority router.
 *
 * Reliability-critical: file-claim locks serialize concurrent edits to the SHARED repo across
 * machines; mis-routing them risks concurrent corruption. The D-009 scope guard (only managed,
 * federated checkouts route to an authority; everything else runs LOCAL) and the hot-path guard
 * (a box with no live remote peers stays purely local) are the two safety properties pinned here.
 * All deps are injected; the module-global resolvers + remote-peers cache are reset between tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  routeFileLockOp,
  configureFileLockDomainResolver,
  getDomainToHarnessSlug,
  configureFileLockHiveResolver,
  getHarnessToPotSlug,
  _testing,
  type FileLockRoutingDeps,
} from './file-lock-routing';
import { __resetRemotePeersCacheForTests } from './remote-peers-cache';
import type { AuthorityOp } from './lock-authority';
import { setPeerRpcTransport, __resetPeerRpcTransportForTests, PeerUnreachableError } from './peer-rpc-transport';

/** An AuthorityOp whose local() returns `value` and counts its calls. No remote envelope ⇒ a
 *  remote authority would fail open to local (D-004). */
function op<T>(value: T) {
  const o = { localCalls: 0, local: async () => { o.localCalls++; return value; } };
  return o as AuthorityOp<T> & { localCalls: number };
}

beforeEach(() => __resetRemotePeersCacheForTests());
afterEach(() => {
  __resetPeerRpcTransportForTests();
  configureFileLockDomainResolver(null);
  configureFileLockHiveResolver(null);
  __resetRemotePeersCacheForTests();
});

describe('hook operation authority fence', () => {
  const NOW = 1_000_000;
  const self = { githubUserId: 1, devicePubkey: 'peer-z' };
  const remote = { device_pubkey: 'peer-a', github_user_id: 2, machine_label: 'other', last_seen_ms: NOW };
  const deps: FileLockRoutingDeps = {
    domainToHarnessSlug: () => 'harness-x', harnessToPotSlug: () => null,
    resolveSelf: async () => self, fetchPresenceRows: async () => [remote],
    now: () => NOW, useHrwRendezvous: false,
  };
  const fenceOp = (expected?: string): AuthorityOp<{ authority: string }> & { local: ReturnType<typeof vi.fn> } => ({
    local: vi.fn(async () => ({ authority: 'mutated' })),
    authorityFence: { expected, prepare: (authority) => ({ authority }) },
    remote: { kind: 'lock.acquire', payload: {}, decode: (raw) => raw as { authority: string },
      prepare: { kind: 'lock.queue', payload: { operationPrepare: true }, decode: (raw) => {
        if ((raw as { hookOperationProtocol?: number }).hookOperationProtocol !== 1) throw new Error('unsupported');
        return (raw as { storeIdentity: string }).storeIdentity;
      } } },
  });

  it('prepares an unmanaged local operation without mutating and accepts only its original scope', async () => {
    const o = fenceOp();
    const localDeps = { domainToHarnessSlug: () => null, resolveSelf: async () => self };
    const prepared = await routeFileLockOp('/repo', o, localDeps);
    expect(prepared.value.authority).toBe(JSON.stringify(['domain:/repo', self.devicePubkey]));
    expect(o.local).not.toHaveBeenCalled();
    const pinned = fenceOp(prepared.value.authority);
    await routeFileLockOp('/repo', pinned, localDeps);
    expect(pinned.local).toHaveBeenCalledOnce();
    await expect(routeFileLockOp('/other', pinned, localDeps)).rejects.toMatchObject({ reason: 'operation_authority_changed' });
    expect(pinned.local).toHaveBeenCalledOnce();
  });

  it('prepares a remote operation with a read-only protocol probe and persists its machine pin', async () => {
    const rpc = vi.fn(async () => ({ hookOperationProtocol: 1, storeIdentity: 'store-a' }));
    setPeerRpcTransport({ rpc });
    const o = fenceOp();
    const prepared = await routeFileLockOp('/repo', o, deps);
    expect(prepared.value.authority).toBe(JSON.stringify(['harness:harness-x', remote.device_pubkey, 'store-a']));
    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ devicePubkey: 'peer-a' }),
      { harnessSlug: 'harness-x', kind: 'lock.queue', payload: { operationPrepare: true } });
    expect(o.local).not.toHaveBeenCalled();
  });

  it('never sends acquire to an authority that lacks the operation protocol', async () => {
    const rpc = vi.fn(async () => ({ active_locks: [], waiting: [] }));
    setPeerRpcTransport({ rpc });
    const o = fenceOp();
    await expect(routeFileLockOp('/repo', o, deps)).rejects.toMatchObject({ reason: 'operation_authority_unknown' });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'lock.queue' }));
    expect(o.local).not.toHaveBeenCalled();
  });

  it('retains unknown on an unreachable pinned authority without writing a local store', async () => {
    setPeerRpcTransport({ rpc: vi.fn(async () => { throw new PeerUnreachableError('lost reply'); }) });
    const o = fenceOp(JSON.stringify(['harness:harness-x', 'peer-a']));
    await expect(routeFileLockOp('/repo', o, deps)).rejects.toMatchObject({ reason: 'operation_authority_unknown' });
    expect(o.local).not.toHaveBeenCalled();
  });

  it('refuses a changed authority before any remote or local mutation', async () => {
    const rpc = vi.fn(async () => ({ authority: 'mutated' }));
    setPeerRpcTransport({ rpc });
    const o = fenceOp(JSON.stringify(['harness:harness-x', 'peer-b']));
    await expect(routeFileLockOp('/repo', o, deps)).rejects.toMatchObject({ reason: 'operation_authority_changed' });
    expect(rpc).not.toHaveBeenCalled();
    expect(o.local).not.toHaveBeenCalled();
  });

  it('refuses a different local database on the same machine', async () => {
    const o = fenceOp();
    o.authorityFence!.localStoreIdentity = () => 'store-a';
    const localDeps = { domainToHarnessSlug: () => null, resolveSelf: async () => self };
    const prepared = await routeFileLockOp('/repo', o, localDeps);
    const finish = fenceOp(prepared.value.authority);
    finish.authorityFence!.localStoreIdentity = () => 'store-b';
    await expect(routeFileLockOp('/repo', finish, localDeps)).rejects.toMatchObject({ reason: 'operation_authority_changed' });
    expect(finish.local).not.toHaveBeenCalled();
  });

  it('revalidates a remote database pin before acquire or completion', async () => {
    const rpc = vi.fn(async () => ({ hookOperationProtocol: 1, storeIdentity: 'store-b' }));
    setPeerRpcTransport({ rpc });
    const o = fenceOp(JSON.stringify(['harness:harness-x', 'peer-a', 'store-a']));
    await expect(routeFileLockOp('/repo', o, deps)).rejects.toMatchObject({ reason: 'operation_authority_changed' });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'lock.queue' }));
    expect(o.local).not.toHaveBeenCalled();
  });

  it('applies the same no-fallback fence at hive scope', async () => {
    setPeerRpcTransport({ rpc: vi.fn(async () => { throw new PeerUnreachableError('lost reply'); }) });
    const o = fenceOp(JSON.stringify(['hive:hive-x', 'peer-a']));
    await expect(routeFileLockOp('/repo', o, { ...deps, harnessToPotSlug: () => 'hive-x',
      fetchHivePresenceRows: async () => [remote] })).rejects.toMatchObject({ reason: 'operation_authority_unknown' });
    expect(o.local).not.toHaveBeenCalled();
  });
});

describe('resolver seams default to local-only and are swappable', () => {
  it('the domain→harness resolver defaults to null (no federated harness → local)', () => {
    expect(getDomainToHarnessSlug()('/any/repo')).toBeNull();
    expect(_testing.defaultDomainToHarnessSlug('/any/repo')).toBeNull();
  });

  it('configureFileLockDomainResolver swaps it, and null restores the default', () => {
    configureFileLockDomainResolver((d) => (d === '/managed' ? 'harness-x' : null));
    expect(getDomainToHarnessSlug()('/managed')).toBe('harness-x');
    expect(getDomainToHarnessSlug()('/other')).toBeNull();
    configureFileLockDomainResolver(null);
    expect(getDomainToHarnessSlug()('/managed')).toBeNull();
  });

  it('the harness→hive resolver defaults to null (non-Hive → harness scope) and is swappable', () => {
    expect(getHarnessToPotSlug()('harness-x')).toBeNull();
    configureFileLockHiveResolver((h) => (h === 'harness-x' ? 'hive-1' : null));
    expect(getHarnessToPotSlug()('harness-x')).toBe('hive-1');
    configureFileLockHiveResolver(null);
    expect(getHarnessToPotSlug()('harness-x')).toBeNull();
  });
});

describe('routeFileLockOp — D-009 scope guard + hot-path guard', () => {
  it('runs LOCALLY for an unmanaged domain (no federated harness)', async () => {
    const o = op('RESULT');
    const res = await routeFileLockOp('/unmanaged', o, { domainToHarnessSlug: () => null });
    expect(res).toEqual({ value: 'RESULT', via: 'local-authority' });
    expect(o.localCalls).toBe(1);
  });

  it('uses the registered resolver when deps omit an override', async () => {
    configureFileLockDomainResolver(() => null); // registry says: not a managed harness
    const o = op('R');
    const res = await routeFileLockOp('/repo', o, {});
    expect(res.via).toBe('local-authority');
    expect(o.localCalls).toBe(1);
  });

  it('a managed harness with NO live remote peers stays local (hot-path guard) and queries harness presence', async () => {
    const harnessFetch = vi.fn(async () => []);
    const hiveFetch = vi.fn(async () => []);
    const deps: FileLockRoutingDeps = {
      domainToHarnessSlug: () => 'harness-x',
      harnessToPotSlug: () => null, // harness scope
      fetchPresenceRows: harnessFetch,
      fetchHivePresenceRows: hiveFetch,
      resolveSelf: async () => null,
      now: () => 1000,
    };
    const o = op('R');
    const res = await routeFileLockOp('/repo', o, deps);
    expect(res.via).toBe('local-authority');
    expect(o.localCalls).toBe(1);
    // P-006: presence fetch carries the (TS) staleMs window as a loose SQL pre-filter
    // (DEFAULT_AUTHORITY_STALE_MS). We assert the SCOPE (harness slug), not the tunable window.
    // WI-6032/D-015: file-claim locks are deliberately workspace-BLIND (a shared
    // harness's file lock must serialize across every workspace that imports it),
    // so the 3rd arg (workspaceId) is undefined here — never threaded from ambient
    // identity into this path. See LockAuthorityDeps.workspaceId.
    expect(harnessFetch).toHaveBeenCalledWith('harness-x', expect.any(Number), undefined); // harness-scoped presence consulted
    expect(hiveFetch).not.toHaveBeenCalled();
  });

  it('a Hive-member harness routes at HIVE scope (consults hive presence) and stays local with no hive peers', async () => {
    const harnessFetch = vi.fn(async () => []);
    const hiveFetch = vi.fn(async () => []);
    const deps: FileLockRoutingDeps = {
      domainToHarnessSlug: () => 'harness-x',
      harnessToPotSlug: () => 'hive-1', // hive scope
      fetchPresenceRows: harnessFetch,
      fetchHivePresenceRows: hiveFetch,
      resolveSelf: async () => null,
      now: () => 1000,
    };
    const o = op('R');
    const res = await routeFileLockOp('/repo', o, deps);
    expect(res.via).toBe('local-authority');
    // WI-6032/D-015: same workspace-blind-by-design rationale as above.
    expect(hiveFetch).toHaveBeenCalledWith('hive-1', expect.any(Number), undefined); // hive-scoped presence consulted (P-006 staleMs window)
    expect(harnessFetch).not.toHaveBeenCalled();
  });
});
