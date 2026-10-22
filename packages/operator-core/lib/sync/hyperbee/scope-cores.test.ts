/**
 * scope-cores.test.ts — P-108 / P-006 §5.1+§5.3: the scoped-core registry and
 * the serve-side roster gate. Unit cases use fake store/muxer seams; the
 * transport case uses real Corestores and encrypted replication streams.
 *
 * The load-bearing properties under test (design FS-D1/FS-D6, D-017):
 *   - serving is EXPLICIT per-core×connection attach, gated by a
 *     cache-bypassing roster re-check on EVERY call — a non-member gets
 *     NOTHING attached and a structural refusal (never a silent drop);
 *   - a serve check is also a revocation edge (roster changed under us ⇒
 *     stop serving NOW);
 *   - the X6 epoch fence: a re-disclosure whose scope_epoch trails the
 *     recorded high-water is refused (pre-revocation replay);
 *   - late-admit mesh: a remote core admitted AFTER a connection started
 *     serving its scope is attached to that connection immediately;
 *   - revokePeerFromScope cuts every connection bound to that peer id, at
 *     once, and only those.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import Corestore from 'corestore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ScopeCoreRegistry,
  ownScopeLogName,
  type ScopedSessionLike,
  type ScopedStoreLike,
} from './scope-cores';
import type { ScopeId } from '../pot-git/scope-repo';
import type { ScopedLogDisclosure } from './scope-disclosure';

const SCOPE_A: ScopeId = { kind: 'fleet', ownerGithubUserId: 42, slug: 'widgets' };
const SCOPE_B: ScopeId = { kind: 'fleet', ownerGithubUserId: 77, slug: 'gadgets' };

describe('P-531 scoped progress inventory and repair', () => {
  function fixture() {
    const sessions: Array<FakeSession & { length: number; contiguousLength: number; closed: boolean }> = [];
    let nextReady = async () => {};
    const registry = new ScopeCoreRegistry({
      get: opts => {
        const s = Object.assign(new FakeSession(opts.key ?? Buffer.alloc(32, 1), !!opts.name), {
          length: 0, contiguousLength: 0, closed: false,
          ready: nextReady,
          async close() { this.closed = true; },
        });
        nextReady = async () => {};
        sessions.push(s);
        return s;
      },
    });
    return { registry, sessions, delayNext: (fn: () => Promise<void>) => { nextReady = fn; } };
  }

  const disclosure = { scope: SCOPE_A, logCoreKeyHex: 'ab'.repeat(32), scopeEpoch: 2, logLength: 20 };

  it('keeps signed high-water across stale views and rejects regressed epoch inventory', async () => {
    const f = fixture();
    await f.registry.admitRemoteScopedCore(disclosure);
    await f.registry.admitRemoteScopedCore({ ...disclosure, logLength: 2 });
    expect(f.registry.replicationProgress()[0]).toMatchObject({ knownLength: 20, position: 0 });
    expect(await f.registry.admitRemoteScopedCore({ ...disclosure, scopeEpoch: 1, logLength: 200 })).toMatchObject({ ok: false });
    f.sessions[0]!.contiguousLength = 4;
    expect(f.registry.replicationProgress()[0]).toMatchObject({ knownLength: 20, position: 4 });
  });

  it('enumerates relay inventory and excludes a reflected own core from remote repair', async () => {
    const f = fixture();
    const own = await f.registry.ensureOwnScopeCore(SCOPE_A);
    f.sessions[0]!.length = 7;
    await f.registry.admitRemoteScopedCore({ ...disclosure, logCoreKeyHex: own.keyHex, logLength: 999 });
    expect(f.registry.replicationProgress()).toEqual([]);
    await f.registry.admitRemoteScopedCore(disclosure);
    expect(f.registry.scopeInventory('fleet:42/widgets')).toEqual([
      { keyHex: own.keyHex, length: 7 }, { keyHex: disclosure.logCoreKeyHex, length: 20 },
    ]);
  });

  it('reopens under fresh roster checks and never reattaches a now-revoked peer', async () => {
    const f = fixture();
    await f.registry.admitRemoteScopedCore(disclosure);
    const old = f.sessions[0]!;
    const allowed = {}, revoked = {};
    await f.registry.serveScopeOnConnection(allowed, SCOPE_A, 7, () => true);
    await f.registry.serveScopeOnConnection(revoked, SCOPE_A, 8, () => true);
    expect(await f.registry.reopenRemoteCore(disclosure.logCoreKeyHex, old, 42,
      (_scope, uid) => uid !== 8, new AbortController().signal)).toBe(true);
    expect(old.closed).toBe(true);
    expect(old.attachedMuxes.size).toBe(0);
    expect(f.sessions[1]!.attachedMuxes.has(allowed)).toBe(true);
    expect(f.sessions[1]!.attachedMuxes.has(revoked)).toBe(false);
    expect(f.registry.replicationProgress()[0]).toMatchObject({ knownLength: 20, position: 0 });
  });

  it('refuses reopening when this device has left the scope', async () => {
    const f = fixture();
    await f.registry.admitRemoteScopedCore(disclosure);
    expect(await f.registry.reopenRemoteCore(disclosure.logCoreKeyHex, f.sessions[0]!, 42,
      () => false, new AbortController().signal)).toBe(false);
    expect(f.sessions).toHaveLength(1);
  });

  it('closes a late timed-out open without replacing the current session', async () => {
    const f = fixture();
    await f.registry.admitRemoteScopedCore(disclosure);
    let resolve!: () => void;
    f.delayNext(() => new Promise<void>(r => { resolve = r; }));
    const controller = new AbortController();
    const pending = f.registry.reopenRemoteCore(disclosure.logCoreKeyHex, f.sessions[0]!, 42,
      () => true, controller.signal);
    await Promise.resolve();
    controller.abort();
    resolve();
    expect(await pending).toBe(false);
    expect(f.registry.replicationProgress()[0]!.session).toBe(f.sessions[0]);
    expect(f.sessions[1]!.closed).toBe(true);
  });
});

describe('private scoped-core transport isolation', () => {
  it('a known key cannot read a non-member scope or new blocks after revocation on a working connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scope-read-isolation-'));
    const main = new Corestore(join(dir, 'main'));
    const scoped = new Corestore(join(dir, 'scoped'));
    const peer = new Corestore(join(dir, 'peer'));
    type Core = {
      ready(): Promise<void>; key: Buffer;
      append(value: unknown): Promise<void>;
      get(index: number, opts: { timeout: number }): Promise<unknown>;
    };
    type Stream = {
      noiseStream: { userData: object };
      pipe(other: Stream): Stream;
      destroy(): void;
    };
    let serving: Stream | undefined;
    let fetching: Stream | undefined;
    try {
      await Promise.all([main.ready(), scoped.ready(), peer.ready()]);
      const registry = new ScopeCoreRegistry(scoped as unknown as ScopedStoreLike);
      const { keyHex } = await registry.ensureOwnScopeCore(SCOPE_A);
      const secret = scoped.get({ name: ownScopeLogName(SCOPE_A), valueEncoding: 'json' }) as Core;
      const publicCore = main.get({ name: 'public-control', valueEncoding: 'json' }) as Core;
      await Promise.all([secret.ready(), publicCore.ready()]);
      await secret.append({ private: 'before-revocation' });
      await publicCore.append({ public: 1 });
      const secretReplica = peer.get({ key: Buffer.from(keyHex, 'hex'), valueEncoding: 'json' }) as Core;
      const publicReplica = peer.get({ key: publicCore.key, valueEncoding: 'json' }) as Core;
      await Promise.all([secretReplica.ready(), publicReplica.ready()]);
      // Only the MAIN store gets automatic discovery-key serving. The private
      // store is reached solely through the registry's per-core attach gate.
      serving = main.replicate(true) as Stream;
      fetching = peer.replicate(false) as Stream;
      serving.pipe(fetching).pipe(serving);
      const mux = serving.noiseStream.userData;
      let member = false;
      const isMember = () => member;
      expect(await publicReplica.get(0, { timeout: 5000 })).toEqual({ public: 1 });
      expect(await registry.serveScopeOnConnection(mux, SCOPE_A, 777, isMember)).toMatchObject({ ok: false, attached: 0 });
      await expect(secretReplica.get(0, { timeout: 500 })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });

      member = true;
      expect(await registry.serveScopeOnConnection(mux, SCOPE_A, 777, isMember)).toMatchObject({ ok: true, attached: 1 });
      expect(await secretReplica.get(0, { timeout: 5000 })).toEqual({ private: 'before-revocation' });

      member = false;
      expect(await registry.serveScopeOnConnection(mux, SCOPE_A, 777, isMember)).toMatchObject({ ok: false, attached: 0 });
      await secret.append({ private: 'after-revocation' });
      await expect(secretReplica.get(1, { timeout: 500 })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
      await publicCore.append({ public: 2 });
      expect(await publicReplica.get(1, { timeout: 5000 })).toEqual({ public: 2 });

      // A later authorized grant can reopen the private channel on the same
      // live connection without reviving it during the revoked interval.
      member = true;
      expect(await registry.serveScopeOnConnection(mux, SCOPE_A, 777, isMember)).toMatchObject({ ok: true, attached: 1 });
      expect(await secretReplica.get(1, { timeout: 5000 })).toEqual({ private: 'after-revocation' });
    } finally {
      serving?.destroy(); fetching?.destroy();
      await Promise.all([main.close(), scoped.close(), peer.close()]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

class FakeSession implements ScopedSessionLike {
  readonly key: Buffer;
  readonly writable: boolean;
  readonly attachedMuxes = new Set<object>();
  replicateCalls = 0;
  throwOnReplicate = false;
  constructor(key: Buffer, writable: boolean) {
    this.key = key;
    this.writable = writable;
  }
  async ready(): Promise<void> {}
  replicate(mux: object): unknown {
    if (this.throwOnReplicate) throw new Error('boom');
    this.replicateCalls++;
    this.attachedMuxes.add(mux);
    return mux;
  }
  readonly replicator = {
    attached: (mux: object): boolean => this.attachedMuxes.has(mux),
    detachFrom: (mux: object): void => {
      this.attachedMuxes.delete(mux);
    },
  };
}

class FakeStore implements ScopedStoreLike {
  readonly byName = new Map<string, FakeSession>();
  readonly byKey = new Map<string, FakeSession>();
  readonly gets: Array<{ name?: string; key?: string }> = [];
  get(opts: { name?: string; key?: Buffer; valueEncoding?: string }): FakeSession {
    if (opts.name) {
      this.gets.push({ name: opts.name });
      let s = this.byName.get(opts.name);
      if (!s) {
        // Deterministic writable key from the name (corestore-like).
        s = new FakeSession(createHash('sha256').update(opts.name).digest(), true);
        this.byName.set(opts.name, s);
        this.byKey.set(s.key.toString('hex'), s);
      }
      return s;
    }
    const keyHex = opts.key!.toString('hex');
    this.gets.push({ key: keyHex });
    let s = this.byKey.get(keyHex);
    if (!s) {
      s = new FakeSession(opts.key!, false);
      this.byKey.set(keyHex, s);
    }
    return s;
  }
}

const remoteKeyHex = (n: number): string => n.toString(16).padStart(64, '0');
const disclosure = (scope: ScopeId, keyN: number, epoch = 1): ScopedLogDisclosure => ({
  scope,
  logCoreKeyHex: remoteKeyHex(keyN),
  scopeEpoch: epoch,
});

/** Roster fixture: membership is a plain lookup — the registry must ask it
 *  on EVERY serve (asserted via `calls`). */
function roster(members: Record<string, number[]>) {
  const calls: Array<{ scopeId: string; uid: number }> = [];
  const isScopeMember = (scope: ScopeId, uid: number): boolean => {
    const id = `fleet:${scope.ownerGithubUserId}/${scope.slug}`;
    calls.push({ scopeId: id, uid });
    return (members[id] ?? []).includes(uid);
  };
  return { isScopeMember, calls };
}

describe('ownScopeLogName', () => {
  it('mints under the canonical §5.1 name', () => {
    expect(ownScopeLogName(SCOPE_A)).toBe('peer-log:scope:fleet:42/widgets');
  });
});

describe('ensureOwnScopeCore', () => {
  it('creates the writable core once and is idempotent', async () => {
    const store = new FakeStore();
    const reg = new ScopeCoreRegistry(store);
    const a1 = await reg.ensureOwnScopeCore(SCOPE_A);
    const a2 = await reg.ensureOwnScopeCore(SCOPE_A);
    expect(a1.keyHex).toBe(a2.keyHex);
    expect(store.gets.filter((g) => g.name).length).toBe(1);
    expect(reg.ownScopeIds()).toEqual(['fleet:42/widgets']);
    expect(reg.ownCoreKeyHex('fleet:42/widgets')).toBe(a1.keyHex);
    expect(reg.ownCoreKeyHex('fleet:77/gadgets')).toBeNull();
  });
});

describe('serveScopeOnConnection — the §5.3 gate', () => {
  it.each([
    { cut: 'revoke', served: true }, { cut: 'disconnect', served: true },
    { cut: 'revoke', served: false }, { cut: 'disconnect', served: false },
  ])('an in-flight roster read cannot open a scope after $cut (previously served=$served)', async ({ cut, served }) => {
    const store = new FakeStore();
    const reg = new ScopeCoreRegistry(store);
    const { keyHex } = await reg.ensureOwnScopeCore(SCOPE_A);
    const mux = {};
    if (served) await reg.serveScopeOnConnection(mux, SCOPE_A, 777, () => true);
    let finish!: (member: boolean) => void;
    const pendingMembership = new Promise<boolean>((resolve) => { finish = resolve; });
    const pendingServe = reg.serveScopeOnConnection(mux, SCOPE_A, 777, () => pendingMembership);
    if (cut === 'revoke') reg.revokePeerFromScope('fleet:42/widgets', 777);
    else { reg.stopServingScope(mux, 'fleet:42/widgets'); reg.dropConnection(mux); }
    finish(true); // stale successful read returns after the newer cut
    expect(await pendingServe).toMatchObject({ ok: false, attached: 0 });
    expect(store.byKey.get(keyHex)!.attachedMuxes.has(mux)).toBe(false);
    expect(reg.servedScopeIds(mux)).toEqual([]);
    expect(await reg.serveScopeOnConnection(mux, SCOPE_A, 777, () => true)).toMatchObject({ ok: true, attached: 1 });
  });

  it('an unreadable roster cuts existing serving and permits a fresh authorized check after recovery', async () => {
    const store = new FakeStore();
    const reg = new ScopeCoreRegistry(store);
    const { keyHex } = await reg.ensureOwnScopeCore(SCOPE_A);
    const mux = {};
    await reg.serveScopeOnConnection(mux, SCOPE_A, 777, () => true);
    await expect(reg.serveScopeOnConnection(mux, SCOPE_A, 777, async () => {
      throw new Error('roster unavailable');
    })).rejects.toThrow('roster unavailable');
    expect(store.byKey.get(keyHex)!.attachedMuxes.has(mux)).toBe(false);
    expect(await reg.serveScopeOnConnection(mux, SCOPE_A, 777, () => true)).toMatchObject({ ok: true, attached: 1 });
  });

  it('member: attaches own + admitted remote cores; re-serve is idempotent', async () => {
    const store = new FakeStore();
    const reg = new ScopeCoreRegistry(store);
    const { keyHex } = await reg.ensureOwnScopeCore(SCOPE_A);
    await reg.admitRemoteScopedCore(disclosure(SCOPE_A, 1));
    const mux = {};
    const r = roster({ 'fleet:42/widgets': [777] });

    const v1 = await reg.serveScopeOnConnection(mux, SCOPE_A, 777, r.isScopeMember);
    expect(v1).toEqual({ ok: true, attached: 2 });
    expect(store.byKey.get(keyHex)!.attachedMuxes.has(mux)).toBe(true);
    expect(store.byKey.get(remoteKeyHex(1))!.attachedMuxes.has(mux)).toBe(true);

    // Idempotent: already-attached cores are not re-attached…
    const v2 = await reg.serveScopeOnConnection(mux, SCOPE_A, 777, r.isScopeMember);
    expect(v2).toEqual({ ok: true, attached: 0 });
    // …but the roster was still consulted BOTH times (FS-D6: never cached).
    expect(r.calls.length).toBe(2);
  });

  it('non-member: refuses structurally and attaches NOTHING', async () => {
    const store = new FakeStore();
    const reg = new ScopeCoreRegistry(store);
    const { keyHex } = await reg.ensureOwnScopeCore(SCOPE_A);
    const mux = {};
    const r = roster({ 'fleet:42/widgets': [] });

    const v = await reg.serveScopeOnConnection(mux, SCOPE_A, 999, r.isScopeMember);
    expect(v.ok).toBe(false);
    expect(v.attached).toBe(0);
    expect(v.refusal).toEqual({
      reason: 'not-a-member',
      scopeId: 'fleet:42/widgets',
      peerGithubUserId: 999,
    });
    expect(store.byKey.get(keyHex)!.attachedMuxes.size).toBe(0);
    expect(reg.servedScopeIds(mux)).toEqual([]);
  });

  it('a serve re-check is a revocation edge: roster loss detaches at once', async () => {
    const store = new FakeStore();
    const reg = new ScopeCoreRegistry(store);
    const { keyHex } = await reg.ensureOwnScopeCore(SCOPE_A);
    const mux = {};
    const yes = roster({ 'fleet:42/widgets': [777] });
    await reg.serveScopeOnConnection(mux, SCOPE_A, 777, yes.isScopeMember);
    expect(store.byKey.get(keyHex)!.attachedMuxes.has(mux)).toBe(true);

    const no = roster({ 'fleet:42/widgets': [] });
    const v = await reg.serveScopeOnConnection(mux, SCOPE_A, 777, no.isScopeMember);
    expect(v.ok).toBe(false);
    expect(store.byKey.get(keyHex)!.attachedMuxes.has(mux)).toBe(false);
    expect(reg.servedScopeIds(mux)).toEqual([]);
  });

  it('a throwing session never breaks the serve (attach is best-effort)', async () => {
    const store = new FakeStore();
    const reg = new ScopeCoreRegistry(store);
    const { keyHex } = await reg.ensureOwnScopeCore(SCOPE_A);
    store.byKey.get(keyHex)!.throwOnReplicate = true;
    await reg.admitRemoteScopedCore(disclosure(SCOPE_A, 1));
    const r = roster({ 'fleet:42/widgets': [777] });
    const v = await reg.serveScopeOnConnection({}, SCOPE_A, 777, r.isScopeMember);
    expect(v.ok).toBe(true);
    expect(v.attached).toBe(1); // the remote still attached
  });
});

describe('admitRemoteScopedCore', () => {
  it('late-admit mesh: a new remote attaches to connections already serving the scope — and ONLY those', async () => {
    const store = new FakeStore();
    const reg = new ScopeCoreRegistry(store);
    await reg.ensureOwnScopeCore(SCOPE_A);
    await reg.ensureOwnScopeCore(SCOPE_B);
    const muxA = { a: 1 };
    const muxB = { b: 1 };
    const r = roster({ 'fleet:42/widgets': [777], 'fleet:77/gadgets': [888] });
    await reg.serveScopeOnConnection(muxA, SCOPE_A, 777, r.isScopeMember);
    await reg.serveScopeOnConnection(muxB, SCOPE_B, 888, r.isScopeMember);

    const v = await reg.admitRemoteScopedCore(disclosure(SCOPE_A, 5));
    expect(v).toEqual({ ok: true, newlyAdmitted: true });
    const remote = store.byKey.get(remoteKeyHex(5))!;
    expect(remote.attachedMuxes.has(muxA)).toBe(true); // serving scope A
    expect(remote.attachedMuxes.has(muxB)).toBe(false); // scope B only
  });

  it('X6 epoch fence: a trailing re-disclosure refuses; equal/higher advances', async () => {
    const store = new FakeStore();
    const reg = new ScopeCoreRegistry(store);
    expect((await reg.admitRemoteScopedCore(disclosure(SCOPE_A, 1, 3))).ok).toBe(true);

    const trailing = await reg.admitRemoteScopedCore(disclosure(SCOPE_A, 1, 2));
    expect(trailing.ok).toBe(false);
    if (!trailing.ok) {
      expect(trailing.refusal).toEqual({
        reason: 'epoch-trails-high-water',
        scopeId: 'fleet:42/widgets',
        logCoreKeyHex: remoteKeyHex(1),
        offered: 2,
        highWater: 3,
      });
    }
    expect(await reg.admitRemoteScopedCore(disclosure(SCOPE_A, 1, 3))).toEqual({
      ok: true,
      newlyAdmitted: false,
    });
    expect(await reg.admitRemoteScopedCore(disclosure(SCOPE_A, 1, 4))).toEqual({
      ok: true,
      newlyAdmitted: false,
    });
    // …and 3 now trails the advanced high-water 4.
    expect((await reg.admitRemoteScopedCore(disclosure(SCOPE_A, 1, 3))).ok).toBe(false);
  });
});

describe('revocation + lifecycle', () => {
  it('revokePeerFromScope cuts every connection bound to that peer, and only those', async () => {
    const store = new FakeStore();
    const reg = new ScopeCoreRegistry(store);
    const { keyHex } = await reg.ensureOwnScopeCore(SCOPE_A);
    await reg.admitRemoteScopedCore(disclosure(SCOPE_A, 1));
    const mux777a = {};
    const mux777b = {};
    const mux888 = {};
    const r = roster({ 'fleet:42/widgets': [777, 888] });
    await reg.serveScopeOnConnection(mux777a, SCOPE_A, 777, r.isScopeMember);
    await reg.serveScopeOnConnection(mux777b, SCOPE_A, 777, r.isScopeMember);
    await reg.serveScopeOnConnection(mux888, SCOPE_A, 888, r.isScopeMember);

    const cut = reg.revokePeerFromScope('fleet:42/widgets', 777);
    expect(cut).toBe(2);
    const own = store.byKey.get(keyHex)!;
    const remote = store.byKey.get(remoteKeyHex(1))!;
    for (const mux of [mux777a, mux777b]) {
      expect(own.attachedMuxes.has(mux)).toBe(false);
      expect(remote.attachedMuxes.has(mux)).toBe(false);
    }
    // The other member's serve is untouched.
    expect(own.attachedMuxes.has(mux888)).toBe(true);
    expect(remote.attachedMuxes.has(mux888)).toBe(true);
    expect(reg.servedScopeIds(mux888)).toEqual(['fleet:42/widgets']);
  });

  it('stopServingScope detaches one scope only; dropConnection forgets tracking', async () => {
    const store = new FakeStore();
    const reg = new ScopeCoreRegistry(store);
    const a = await reg.ensureOwnScopeCore(SCOPE_A);
    const b = await reg.ensureOwnScopeCore(SCOPE_B);
    const mux = {};
    const r = roster({ 'fleet:42/widgets': [777], 'fleet:77/gadgets': [777] });
    await reg.serveScopeOnConnection(mux, SCOPE_A, 777, r.isScopeMember);
    await reg.serveScopeOnConnection(mux, SCOPE_B, 777, r.isScopeMember);

    reg.stopServingScope(mux, 'fleet:42/widgets');
    expect(store.byKey.get(a.keyHex)!.attachedMuxes.has(mux)).toBe(false);
    expect(store.byKey.get(b.keyHex)!.attachedMuxes.has(mux)).toBe(true);
    expect(reg.servedScopeIds(mux)).toEqual(['fleet:77/gadgets']);

    reg.dropConnection(mux);
    expect(reg.servedScopeIds(mux)).toEqual([]);
    // A revocation after drop cuts nothing (no tracking left).
    expect(reg.revokePeerFromScope('fleet:77/gadgets', 777)).toBe(0);
  });
});
