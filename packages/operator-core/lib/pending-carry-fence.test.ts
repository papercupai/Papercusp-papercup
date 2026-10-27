import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import { createPendingCarryFence } from '../../../apps/operator/scripts/psu-carry-fence.mjs';
import { decodeControl, makeCarryRearmController } from '../../../apps/operator/scripts/psu-pty-host.mjs';
import { fencePendingCarry, type PendingCarryFencePorts, type PendingCarryFenceRequest } from './pending-carry-fence';
import { qualifyCarryFenceAck, type InjectHostResult } from './events/await/psu-pty-discovery';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { clearPendingCarryRespawn, consumePendingCarryRespawn, fencePendingCarryRespawnSlot,
  readPendingCarryFenceTarget, restorePendingCarryRespawn, savePendingCarryRespawn } from './session-brief';

const NOW = 1_792_850_000_000;
const identity = { ownerId: 'su-fence-test', workspaceId: 'isolated-fence-workspace',
  advSessionId: 'adv-test', nativeSessionId: 'native-test', hostStartedAt: NOW - 1000,
  childGeneration: 1, hostCodeVersion: 'source-test' };
const request = (): PendingCarryFenceRequest => ({ ownerId: identity.ownerId, workspaceId: identity.workspaceId,
  nonce: 'original-nonce', fenceId: 'fence-one', expectedAdvSessionId: identity.advSessionId,
  expectedNativeSessionId: identity.nativeSessionId, expectedHostStartedAt: identity.hostStartedAt,
  expectedChildGeneration: identity.childGeneration, expectedHostCodeVersion: identity.hostCodeVersion,
  expiresAtMs: NOW + 10_000 });
const carry = (nonce = 'original-nonce') => ({ ownerId: identity.ownerId, workspaceId: identity.workspaceId,
  expectedAdvSessionId: identity.advSessionId, expectedNativeSessionId: identity.nativeSessionId,
  expectedHostStartedAt: identity.hostStartedAt, expectedChildGeneration: identity.childGeneration,
  expectedHostCodeVersion: identity.hostCodeVersion, mode: 'carry-respawn', data: 'retained carry', carryNonce: nonce });
const receipt = () => ({ ok: true, reason: 'carry-fenced', nonce: 'original-nonce', fenceId: 'fence-one', identity: { ...identity } });
const state = () => createPendingCarryFence({ identity: () => ({ ...identity }), now: () => NOW });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};

describe('exact pending carry cancellation', () => {
  it('tombstones before arrival, refuses delayed old execution and preserves a newer nonce', () => {
    const guard = state();
    expect(guard.fence(request())).toEqual(receipt());
    expect(guard.fence(request())).toEqual(receipt());
    expect(guard.fence({ ...request(), fenceId: 'different' })).toMatchObject({ ok: false, reason: 'carry-fence-conflict' });
    expect(guard.admit(carry())).toBe('carry-fenced');
    expect(guard.begin(carry())).toBe('carry-fenced');
    expect(guard.begin({ mode: 'carry-respawn', data: 'delayed legacy carry' })).toBe('carry-nonce-required-after-fence');
    expect(guard.admit(carry('newer'))).toBeNull();
    expect(guard.begin(carry('newer'))).toBeNull();
  });

  it.each(['ownerId', 'workspaceId', 'expectedAdvSessionId', 'expectedNativeSessionId',
    'expectedHostStartedAt', 'expectedChildGeneration', 'expectedHostCodeVersion'] as const)
    ('refuses stale %s both on fence and late carry', key => {
      const guard = state();
      const value = typeof request()[key] === 'number' ? 42 : 'different';
      const stale = { ...request(), [key]: value };
      expect(guard.fence(stale)).toMatchObject({ ok: false, reason: 'stale-carry-fence-target' });
      expect(guard.begin({ ...carry(), [key]: value })).toBe('stale-carry-target');
      expect(guard.begin(carry())).toBeNull();
    });

  it('refuses after replacement commits, during effects, on legacy pending input and invalid expiry', () => {
    const guard = state();
    expect(guard.admit(carry())).toBeNull();
    expect(guard.begin(carry())).toBeNull();
    expect(guard.fence(request())).toMatchObject({ reason: 'carry-already-committed', ok: false });
    const legacy = { mode: 'carry-respawn', data: 'old unbound protocol' };
    const other = state();
    other.admit(legacy);
    expect(other.fence(request())).toMatchObject({ reason: 'carry-nonce-unavailable', ok: false });
    other.end(legacy);
    expect(other.fence({ ...request(), expiresAtMs: NOW })).toMatchObject({ ok: false });
    expect(other.fence({ ...request(), expiresAtMs: NOW + 30_001 })).toMatchObject({ ok: false });
    const busy = createPendingCarryFence({ identity: () => identity, now: () => NOW, canFence: () => false });
    expect(busy.fence(request())).toMatchObject({ reason: 'carry-fence-effect-in-flight', ok: false });
  });

  it('preserves nonce and exact host pins through the production decoder; fence is ungated', () => {
    const decoded = decodeControl(JSON.stringify({ v: 1, ...carry() }));
    expect(decoded).toMatchObject(carry());
    expect(decodeControl(JSON.stringify({ v: 1, mode: 'carry-fence', ownerId: identity.ownerId, request: request() })))
      .toMatchObject({ mode: 'carry-fence', gated: false, request: request() });
  });

  it('a first attempt fenced during a wait cannot reach its replacement effect', async () => {
    const guard = state();
    const msg = carry();
    const wait = deferred<void>();
    const effect = vi.fn();
    guard.admit(msg);
    const firstAttempt = (async () => { await wait.promise; if (!guard.begin(msg)) effect(); })();
    expect(guard.fence(request()).ok).toBe(true);
    wait.resolve();
    await firstAttempt;
    expect(effect).not.toHaveBeenCalled();
  });

  it('the production rearm controller retires a fence after its gate await, settles once and clears wake suppression', async () => {
    const guard = state();
    const msg = carry();
    guard.admit(msg);
    const entered = deferred<void>();
    const gate = deferred<{ deferred: boolean }>();
    const settled = deferred<unknown>();
    const effect = vi.fn();
    const onSettlement = vi.fn((messages: unknown[], outcome: unknown) => {
      messages.forEach(m => guard.end(m));
      settled.resolve(outcome);
    });
    const controller = makeCarryRearmController({ acquireInject: async () => () => {},
      waitAtPrompt: async () => { entered.resolve(); return gate.promise; },
      recycle: effect, emitEvent: () => {}, isCancelled: m => guard.isFenced(m), onSettlement });
    controller.schedule(msg);
    await entered.promise;
    expect(controller.pendingCount('carry-respawn')).toBe(1);
    expect(guard.fence(request()).ok).toBe(true);
    expect(controller.pendingCount('carry-respawn')).toBe(0);
    gate.resolve({ deferred: false });
    expect(await settled.promise).toMatchObject({ delivered: false, reason: 'carry-fenced' });
    expect(effect).not.toHaveBeenCalled();
    expect(onSettlement).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});

function ports(result: InjectHostResult = { ok: true, confirmation: 'acked', carryFence: receipt() }) {
  return { now: () => NOW,
    read: vi.fn(async () => ({ nonce: 'original-nonce', fenceId: null as string | null })),
    find: vi.fn(async () => ({ ...identity, startedAt: identity.hostStartedAt, sock: '/isolated/test.sock', caps: ['pending-carry-fence-v1'] })),
    send: vi.fn(async () => result), persist: vi.fn(async () => true) } satisfies PendingCarryFencePorts;
}

describe('two-sided fence custody', () => {
  it('requires a qualified host receipt before the durable compare-and-set', async () => {
    const p = ports();
    expect(await fencePendingCarry(request(), p)).toMatchObject({ ok: true, hostFenced: true, slotFenced: true });
    expect(p.persist).toHaveBeenCalledWith(identity.ownerId, identity.workspaceId, 'original-nonce', 'fence-one');
    expect(p.send.mock.invocationCallOrder[0]).toBeLessThan(p.persist.mock.invocationCallOrder[0]);
  });

  it.each([
    { ok: true, confirmation: 'assumed-close' },
    { ok: false, confirmation: 'timeout' },
    { ok: true, confirmation: 'acked' },
    { ok: true, confirmation: 'acked', carryFence: { ok: true } },
    { ok: true, confirmation: 'acked', carryFence: { ...receipt(), nonce: 'newer' } },
    { ok: true, confirmation: 'acked', carryFence: { ...receipt(), identity: { ...identity, childGeneration: 2 } } },
  ] satisfies InjectHostResult[])('unconfirmed/malformed/wrong ACK cannot mutate database (%j)', async result => {
    const p = ports(result);
    expect(await fencePendingCarry(request(), p)).toMatchObject({ ok: false, hostFenced: null, slotFenced: false });
    expect(p.persist).not.toHaveBeenCalled();
  });

  it('refuses stale slot/workspace/capability/host pins before sending', async () => {
    const stale = ports();
    stale.read.mockResolvedValue({ nonce: 'newer', fenceId: null });
    expect((await fencePendingCarry(request(), stale)).reason).toBe('carry-fence-slot-mismatch');
    expect(stale.send).not.toHaveBeenCalled();
    const conflict = ports();
    conflict.read.mockResolvedValue({ nonce: 'original-nonce', fenceId: 'another-fence' });
    expect((await fencePendingCarry(request(), conflict)).reason).toBe('carry-fence-conflict');
    expect(conflict.send).not.toHaveBeenCalled();
    const badHost = ports();
    badHost.find.mockResolvedValue({ ...identity, startedAt: identity.hostStartedAt, sock: '/wrong.sock', caps: [] });
    expect((await fencePendingCarry(request(), badHost)).reason).toBe('stale-carry-fence-target');
    expect(badHost.send).not.toHaveBeenCalled();
    expect(qualifyCarryFenceAck({ ...request(), workspaceId: 'wrong' }, receipt())).toBe(false);
  });

  it('preserves host tombstone on a database race or write failure; never reports full custody', async () => {
    const race = ports();
    race.persist.mockResolvedValue(false);
    expect(await fencePendingCarry(request(), race)).toMatchObject({ ok: false, reason: 'carry-fence-slot-changed', hostFenced: true, slotFenced: false });
    const failure = ports();
    failure.persist.mockRejectedValue(new Error('isolated failure'));
    expect(await fencePendingCarry(request(), failure)).toMatchObject({ ok: false, reason: 'carry-fence-slot-persist-failed', hostFenced: true, slotFenced: false });
  });
});

describe('fence tombstone on real isolated Postgres', () => {
  let db: FreshPgDb;
  let pg: DedicatedNativePg;
  const savedAdminUrl = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
  const options = () => ({ sql: db.sql, nowMs: NOW });
  const seed = { firstPrompt: 'retained first prompt', systemPromptAddendum: 'retained carry' };
  beforeAll(async () => {
    // Reuse the maintained per-run cluster. A shared PG storage refusal must
    // not be waived or turn database assertions into skipped success.
    pg = await startDedicatedNativePg({ settings: { shared_buffers: '16MB', max_connections: '20' } });
    process.env.PAPERCUSP_TEST_PG_ADMIN_URL = pg.getConnectionUri();
    db = await createFreshPgDb('pending-carry-fence');
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    await applyMigrationForTest(db.sql, resolve(root, 'libs/papercusp/libs/db/sql/322-session-briefs-ei1742.sql'));
    await applyMigrationForTest(db.sql, resolve(root, 'libs/papercusp/libs/db/sql/1340-session-brief-pending-carry-respawn.sql'));
  }, 90_000);
  afterAll(async () => {
    try { await db?.cleanup(); } finally {
      if (savedAdminUrl === undefined) delete process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
      else process.env.PAPERCUSP_TEST_PG_ADMIN_URL = savedAdminUrl;
      await pg?.stop();
      if (pg) expect(existsSync(pg.dataDir)).toBe(false);
    }
  });

  it('retains cancellation across same-nonce save/clear/consume/restore and a newer slot being consumed', async () => {
    const who = { ownerId: 'su-isolated-fence', workspaceId: 'isolated' };
    const old = await savePendingCarryRespawn(who, seed, { ...options(), nonce: 'old' });
    expect(old).not.toBeNull();
    expect(await fencePendingCarryRespawnSlot(who.ownerId, 'wrong-workspace', 'old', 'f', options())).toBe(false);
    expect(await fencePendingCarryRespawnSlot(who.ownerId, who.workspaceId, 'old', 'f', options())).toBe(true);
    expect(await fencePendingCarryRespawnSlot(who.ownerId, who.workspaceId, 'old', 'f', options())).toBe(true);
    expect(await fencePendingCarryRespawnSlot(who.ownerId, who.workspaceId, 'old', 'conflict', options())).toBe(false);
    expect(await readPendingCarryFenceTarget(who.ownerId, who.workspaceId, options())).toEqual({ nonce: 'old', fenceId: 'f' });
    expect(await consumePendingCarryRespawn(who.ownerId, options())).toBeNull();
    expect(await clearPendingCarryRespawn(who.ownerId, 'old', options())).toBe(false);
    expect(await restorePendingCarryRespawn(who.ownerId, who.workspaceId, old!, options())).toBe(false);
    expect(await savePendingCarryRespawn(who, seed, { ...options(), nonce: 'old' })).toBeNull();
    expect(await savePendingCarryRespawn(who, seed, { ...options(), nonce: 'newer' })).toMatchObject({ nonce: 'newer' });
    expect(await fencePendingCarryRespawnSlot(who.ownerId, who.workspaceId, 'old', 'f', options())).toBe(false);
    const consumed = await consumePendingCarryRespawn(who.ownerId, options());
    expect(consumed?.nonce).toBe('newer');
    expect(await restorePendingCarryRespawn(who.ownerId, who.workspaceId, old!, options())).toBe(false);
    expect(await restorePendingCarryRespawn(who.ownerId, who.workspaceId, consumed!, options())).toBe(true);
    expect(await clearPendingCarryRespawn(who.ownerId, 'newer', options())).toBe(true);
    expect(await savePendingCarryRespawn(who, seed, { ...options(), nonce: 'old' })).toBeNull();
  });

  it('late fence CAS cannot overwrite a newer payload; concurrent consumers get it once', async () => {
    const who = { ownerId: 'su-isolated-race', workspaceId: 'isolated' };
    await savePendingCarryRespawn(who, seed, { ...options(), nonce: 'before' });
    await savePendingCarryRespawn(who, seed, { ...options(), nonce: 'after' });
    expect(await fencePendingCarryRespawnSlot(who.ownerId, who.workspaceId, 'before', 'f', options())).toBe(false);
    const copies = await Promise.all([consumePendingCarryRespawn(who.ownerId, options()), consumePendingCarryRespawn(who.ownerId, options())]);
    expect(copies.filter(Boolean)).toHaveLength(1);
    expect(copies.find(Boolean)?.nonce).toBe('after');
  });

  it('malformed fence metadata fails closed without returning retained prompt bytes', async () => {
    await db.sql`INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, pending_carry_respawn)
      VALUES ('su-isolated-malformed', 'isolated', '{"nonce":"bad","fenced":false}'::jsonb)`;
    expect(await consumePendingCarryRespawn('su-isolated-malformed', options())).toBeNull();
    expect(await clearPendingCarryRespawn('su-isolated-malformed', 'bad', options())).toBe(false);
    expect(await savePendingCarryRespawn({ ownerId: 'su-isolated-malformed', workspaceId: 'isolated' }, seed,
      { ...options(), nonce: 'new' })).toBeNull();
  });
});
