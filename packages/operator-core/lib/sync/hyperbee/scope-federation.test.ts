/**
 * scope-federation.test.ts — P-108 connection coordinator (§5.2/§5.3/D-017)
 * over a REAL ScopeCoreRegistry (fake store/muxer from scope-cores' seams) + a
 * fake roster + a fake connection context. No swarm, no PG.
 *
 * The behaviours pinned here are the ones boot.ts relies on and cannot easily
 * exercise itself:
 *   - serve+disclose ONLY the scopes the peer is a member of (§5.3 gate);
 *   - the DIRECTED follow-up is sent once, then LOOP-DAMPED (no ping-pong);
 *   - an inbound disclosure for a scope WE are a member of admits + attaches
 *     the remote core; one we are NOT gets a loud refusal (M15 counter);
 *   - D-017 redisclose after a roster change detaches the now-hidden scope and
 *     sends a fresh follow-up; a no-op roster leaves the wire silent;
 *   - structural inertness: no participating scopes ⇒ nothing served/disclosed.
 */
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ScopeFederation, type ScopeFederationRefusal } from './scope-federation';
import { ScopeCoreRegistry, type ScopedStoreLike, type ScopedSessionLike } from './scope-cores';
import type { ScopeRoster } from '../../p2p/scope-roster';
import type { ScopeId } from '../pot-git/scope-repo';
import type { SignedAnnounce } from './announce';
import { packScopedLog } from './scope-disclosure';
import type { AnnounceConnectionContext } from './swarm';

const SCOPE_A: ScopeId = { kind: 'fleet', ownerGithubUserId: 42, slug: 'widgets' };

// ── fake scoped store (mirrors scope-cores.test.ts) ──
class FakeSession implements ScopedSessionLike {
  readonly key: Buffer;
  readonly writable: boolean;
  readonly attachedMuxes = new Set<object>();
  constructor(key: Buffer, writable: boolean) {
    this.key = key;
    this.writable = writable;
  }
  async ready(): Promise<void> {}
  replicate(mux: object): unknown {
    this.attachedMuxes.add(mux);
    return mux;
  }
  readonly replicator = {
    attached: (mux: object) => this.attachedMuxes.has(mux),
    detachFrom: (mux: object) => void this.attachedMuxes.delete(mux),
  };
}
class FakeStore implements ScopedStoreLike {
  readonly byName = new Map<string, FakeSession>();
  readonly byKey = new Map<string, FakeSession>();
  get(opts: { name?: string; key?: Buffer }): FakeSession {
    if (opts.name) {
      let s = this.byName.get(opts.name);
      if (!s) {
        s = new FakeSession(createHash('sha256').update(opts.name).digest(), true);
        this.byName.set(opts.name, s);
        this.byKey.set(s.key.toString('hex'), s);
      }
      return s;
    }
    const keyHex = opts.key!.toString('hex');
    let s = this.byKey.get(keyHex);
    if (!s) {
      s = new FakeSession(opts.key!, false);
      this.byKey.set(keyHex, s);
    }
    return s;
  }
}

/** A roster where `members[scopeId]` lists the member uids; owner always in. */
function fakeRoster(members: Record<string, number[]>, epoch = 1): ScopeRoster {
  const id = (s: ScopeId) => `fleet:${s.ownerGithubUserId}/${s.slug}`;
  const isMember = async (s: ScopeId, uid: number) =>
    uid === s.ownerGithubUserId || (members[id(s)] ?? []).includes(uid);
  const roster: ScopeRoster = {
    isMember,
    members: async (s) => [s.ownerGithubUserId, ...(members[id(s)] ?? [])],
    currentEpoch: async () => epoch,
    predicate: isMember,
  };
  return roster;
}

const remoteKeyHex = (n: number) => n.toString(16).padStart(64, '0');

describe('P-531 scoped inventory growth', () => {
  it('announces current lengths without cutting an authorized live scope when its length changes', async () => {
    const store = new FakeStore();
    const registry = new ScopeCoreRegistry(store);
    const f = new ScopeFederation({ registry, roster: fakeRoster({ 'fleet:42/widgets': [7] }),
      selfGithubUserId: 42, buildScopedAnnounce });
    await f.ensureOwnScopes([SCOPE_A]);
    const own = [...store.byName.values()][0]!;
    Object.defineProperty(own, 'length', { value: 4, configurable: true });
    const { ctx, muxer, sent } = fakeCtx();
    await f.onPeerAnnounce(frame(7), ctx);
    expect(sent[0]!.scoped_logs?.[0]).toMatch(/\|4$/);
    const detach = vi.spyOn(own.replicator, 'detachFrom');
    Object.defineProperty(own, 'length', { value: 9, configurable: true });
    await f.redisclose();
    expect(sent[1]!.scoped_logs?.[0]).toMatch(/\|9$/);
    expect(own.attachedMuxes.has(muxer)).toBe(true);
    expect(detach).not.toHaveBeenCalled();
    const relayKey = remoteKeyHex(55);
    await registry.admitRemoteScopedCore({ scope: SCOPE_A, logCoreKeyHex: relayKey, scopeEpoch: 1, logLength: 12 });
    await f.redisclose();
    expect(sent[2]!.scoped_logs).toContain(packScopedLog({
      scope: SCOPE_A, logCoreKeyHex: relayKey, scopeEpoch: 1, logLength: 12,
    }));
  });
});

function frame(githubUserId: number, scopedLogs?: string[]): SignedAnnounce {
  return {
    device_pubkey: 'dp',
    github_user_id: githubUserId,
    github_login: `u${githubUserId}`,
    attestation_gist_id: 'g',
    log_core_key: remoteKeyHex(githubUserId),
    ts: 1,
    sig: 's',
    ...(scopedLogs ? { scoped_logs: scopedLogs } : {}),
  };
}

function fakeCtx() {
  const muxer = {};
  const sent: SignedAnnounce[] = [];
  const ctx: AnnounceConnectionContext = { muxer, send: (f) => void sent.push(f) };
  return { ctx, muxer, sent };
}

/** buildScopedAnnounce that echoes the scoped_logs it was handed. */
const buildScopedAnnounce = async (scopedLogs: string[]): Promise<SignedAnnounce> => ({
  ...frame(42),
  scoped_logs: scopedLogs,
});

function fed(
  store: FakeStore,
  roster: ScopeRoster,
  selfGithubUserId: number,
  onRefusal?: (r: ScopeFederationRefusal) => void,
) {
  const registry = new ScopeCoreRegistry(store);
  const f = new ScopeFederation({ registry, roster, selfGithubUserId, buildScopedAnnounce, onRefusal });
  return { registry, f };
}

describe('§5.2 send — directed follow-up + loop damping', () => {
  it('serves + discloses a scope the peer is a member of, then damps the repeat', async () => {
    const store = new FakeStore();
    // self=42 owns SCOPE_A; peer 777 is a member.
    const roster = fakeRoster({ 'fleet:42/widgets': [777] });
    const { registry, f } = fed(store, roster, 42);
    await f.ensureOwnScopes([SCOPE_A]);
    const { ctx, muxer, sent } = fakeCtx();

    await f.onPeerAnnounce(frame(777), ctx);
    // Directed follow-up sent once, carrying our scope disclosure.
    expect(sent).toHaveLength(1);
    const ownKey = registry.ownCoreKeyHex('fleet:42/widgets')!;
    expect(sent[0].scoped_logs).toEqual([packScopedLog({ scope: SCOPE_A, logCoreKeyHex: ownKey, scopeEpoch: 1 })]);
    // Our own scope core is attached (served) on this muxer.
    expect(store.byKey.get(ownKey)!.attachedMuxes.has(muxer)).toBe(true);

    // A second identical announce ⇒ no change ⇒ DAMPED (no second send).
    await f.onPeerAnnounce(frame(777), ctx);
    expect(sent).toHaveLength(1);
  });

  it('a non-member peer gets NOTHING served and NO disclosure (capability non-disclosure)', async () => {
    const store = new FakeStore();
    const roster = fakeRoster({ 'fleet:42/widgets': [] }); // 777 not a member
    const { registry, f } = fed(store, roster, 42);
    await f.ensureOwnScopes([SCOPE_A]);
    const { ctx, muxer, sent } = fakeCtx();

    await f.onPeerAnnounce(frame(777), ctx);
    expect(sent).toHaveLength(0);
    const ownKey = registry.ownCoreKeyHex('fleet:42/widgets')!;
    expect(store.byKey.get(ownKey)!.attachedMuxes.has(muxer)).toBe(false);
  });

  it('structural inertness: no participating scopes ⇒ never serves or discloses', async () => {
    const store = new FakeStore();
    const roster = fakeRoster({ 'fleet:42/widgets': [777] });
    const { f } = fed(store, roster, 42);
    // ensureOwnScopes NOT called — tier-1 with no directory.
    const { ctx, sent } = fakeCtx();
    await f.onPeerAnnounce(frame(777), ctx);
    expect(sent).toHaveLength(0);
  });

  it('an identity-blind frame (no numeric id) is ignored for scoped handling', async () => {
    const store = new FakeStore();
    const roster = fakeRoster({ 'fleet:42/widgets': [777] });
    const { f } = fed(store, roster, 42);
    await f.ensureOwnScopes([SCOPE_A]);
    const { ctx, sent } = fakeCtx();
    await f.onPeerAnnounce(frame(0), ctx); // uid 0 ⇒ skipped
    expect(sent).toHaveLength(0);
    expect(f.connectionCount).toBe(0);
  });
});

describe('§5.2 receive — admit inbound disclosures + loud refusals', () => {
  it('admits a disclosed scoped core WE are a member of and attaches it', async () => {
    const store = new FakeStore();
    // self=99 is a member of peer 42's scope A.
    const roster = fakeRoster({ 'fleet:42/widgets': [99] });
    const refusals: ScopeFederationRefusal[] = [];
    const { registry, f } = fed(store, roster, 99, (r) => refusals.push(r));
    const { ctx } = fakeCtx();

    const disclosure = packScopedLog({ scope: SCOPE_A, logCoreKeyHex: remoteKeyHex(5), scopeEpoch: 1 });
    await f.onPeerAnnounce(frame(42, [disclosure]), ctx);

    expect(refusals).toHaveLength(0);
    // The remote scoped core was opened in our store.
    expect(store.byKey.has(remoteKeyHex(5))).toBe(true);
    // Re-admitting the same core is idempotent (newlyAdmitted false, no throw).
    await f.onPeerAnnounce(frame(42, [disclosure]), ctx);
    expect(refusals).toHaveLength(0);
  });

  it('refuses (loud, M15) a disclosure for a scope we are NOT a member of', async () => {
    const store = new FakeStore();
    const roster = fakeRoster({ 'fleet:42/widgets': [] }); // self 99 not a member
    const refusals: ScopeFederationRefusal[] = [];
    const { f } = fed(store, roster, 99, (r) => refusals.push(r));
    const { ctx } = fakeCtx();

    const disclosure = packScopedLog({ scope: SCOPE_A, logCoreKeyHex: remoteKeyHex(5), scopeEpoch: 1 });
    await f.onPeerAnnounce(frame(42, [disclosure]), ctx);

    expect(refusals).toHaveLength(1);
    expect(refusals[0].kind).toBe('inbound-announce');
    if (refusals[0].kind === 'inbound-announce') {
      expect(refusals[0].refusal.reason).toBe('not-a-member');
    }
    expect(store.byKey.has(remoteKeyHex(5))).toBe(false); // never opened
  });

  it('refuses a malformed inbound entry with a counter', async () => {
    const store = new FakeStore();
    const roster = fakeRoster({});
    const refusals: ScopeFederationRefusal[] = [];
    const { f } = fed(store, roster, 99, (r) => refusals.push(r));
    const { ctx } = fakeCtx();
    await f.onPeerAnnounce(frame(42, ['not|a|valid|entry|xx']), ctx);
    expect(refusals.some((r) => r.kind === 'inbound-announce' && r.refusal.reason === 'malformed')).toBe(true);
  });
});

describe('D-017 n1 — redisclose on roster mutation', () => {
  it('revocation: a peer dropped from the roster gets the scope DETACHED + a fresh (empty) follow-up', async () => {
    const store = new FakeStore();
    const members: Record<string, number[]> = { 'fleet:42/widgets': [777] };
    const roster = fakeRoster(members);
    const { registry, f } = fed(store, roster, 42);
    await f.ensureOwnScopes([SCOPE_A]);
    const { ctx, muxer, sent } = fakeCtx();
    await f.onPeerAnnounce(frame(777), ctx);
    const ownKey = registry.ownCoreKeyHex('fleet:42/widgets')!;
    expect(store.byKey.get(ownKey)!.attachedMuxes.has(muxer)).toBe(true);
    expect(sent).toHaveLength(1);

    // Revoke 777, then redisclose.
    members['fleet:42/widgets'] = [];
    await f.redisclose();
    // The scope core is detached (stopped serving) on that connection…
    expect(store.byKey.get(ownKey)!.attachedMuxes.has(muxer)).toBe(false);
    // …and a fresh follow-up (now empty) was sent (disclosure changed).
    expect(sent).toHaveLength(2);
    expect(sent[1].scoped_logs).toEqual([]);
  });

  it('a no-op roster leaves the wire silent (no redundant follow-up)', async () => {
    const store = new FakeStore();
    const roster = fakeRoster({ 'fleet:42/widgets': [777] });
    const { f } = fed(store, roster, 42);
    await f.ensureOwnScopes([SCOPE_A]);
    const { ctx, sent } = fakeCtx();
    await f.onPeerAnnounce(frame(777), ctx);
    expect(sent).toHaveLength(1);
    await f.redisclose(); // nothing changed
    expect(sent).toHaveLength(1);
  });

  it('dropConnection forgets the connection (redisclose no longer touches it)', async () => {
    const store = new FakeStore();
    const roster = fakeRoster({ 'fleet:42/widgets': [777] });
    const { f } = fed(store, roster, 42);
    await f.ensureOwnScopes([SCOPE_A]);
    const { ctx, muxer, sent } = fakeCtx();
    await f.onPeerAnnounce(frame(777), ctx);
    expect(f.connectionCount).toBe(1);
    f.dropConnection(muxer);
    expect(f.connectionCount).toBe(0);
    await f.redisclose();
    expect(sent).toHaveLength(1); // no new send for a dropped conn
  });
});

describe('epoch (X6) rides the disclosure', () => {
  it('carries the roster currentEpoch in the packed disclosure', async () => {
    const store = new FakeStore();
    const roster = fakeRoster({ 'fleet:42/widgets': [777] }, 7);
    const { registry, f } = fed(store, roster, 42);
    await f.ensureOwnScopes([SCOPE_A]);
    const { ctx, sent } = fakeCtx();
    await f.onPeerAnnounce(frame(777), ctx);
    const ownKey = registry.ownCoreKeyHex('fleet:42/widgets')!;
    expect(sent[0].scoped_logs).toEqual([
      packScopedLog({ scope: SCOPE_A, logCoreKeyHex: ownKey, scopeEpoch: 7 }),
    ]);
  });
});
