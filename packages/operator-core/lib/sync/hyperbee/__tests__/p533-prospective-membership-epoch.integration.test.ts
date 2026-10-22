/** Independent prospective P533 contracts. WI-6554700010020476.
 * Three migrated disposable PGs; real epoch/member projections and readers.
 * Transport is excluded here; the existing boot churn rigs remain separate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { encodeHlc } from '@papercusp/locks-core';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { seedHive, HIVE_SLUG, WORKSPACE_ID } from './_hive-substrate-rig';
import { getHiveEpoch, setHiveEpoch } from '../hive-epoch-state';
import { buildHiveSettingsProjection } from '../projections/hive-settings';
import { buildHiveMembersProjection } from '../projections/hive-members';
import { applyOpVia, type TableProjection } from '../projection';
import { getScopeRoster } from '../../../p2p/scope-roster';
import { advanceGrantorHighWater } from '../../../p2p/grant-store';
import { addRevokedHivePubkeys, listHiveMembers, loadRevokedHivePubkeys, upsertHiveMember } from '../../../hive-membership-store';
import { __resetCommsTierGate, __setCommsTierGateDeps, resolveAuthorCommsTier } from '../comms-tier-gate';
import { resolvePeerAdmission } from '../../pot-git/serve-wiring';
import type { ScopeId } from '../../pot-git/scope-repo';
import type { DeviceAttestationEntry } from '../../../harness/contributor-row-types';
import { advanceEpochOnHiveBoundary } from '../hive-epoch-boundary-wiring';
import type { EpochKey, HiveEpochCrypto } from '../hive-epoch-crypto';
import { createEpochKeyProvider } from '../hive-epoch-key-provider';
import { createPgWrappedKeyLoader } from '../hive-epoch-keys-store';
import { ScopeFederation } from '../scope-federation';
import { ScopeCoreRegistry, type ScopedSessionLike, type ScopedStoreLike } from '../scope-cores';
import type { SignedAnnounce } from '../announce';
import { makeRateLimitedApply } from '../rate-limit-admission';
import { MemberRateLimiter } from '../rate-limiter';
import type { OpEnvelope } from '../op-envelope-types';
import { resolveGithubUserIdForDevicePubkey } from '../hive-member-identity-set';

const databases: OrgTestDb[] = [];
afterEach(async () => {
  __resetCommsTierGate();
  await Promise.all(databases.splice(0).map(db => db.cleanup()));
});
const scope: ScopeId = { kind: 'fleet', ownerGithubUserId: 101, slug: 'p533-independent' };
function attestation(device: string): DeviceAttestationEntry {
  return { device_pubkey: device, gist_id: 'fixture', gist_url: 'https://example.invalid/fixture',
    device_label: device, created_at: 1, signature_by_device: 'fixture-signature' };
}
async function peer() {
  const db = await createOrgTestDb();
  databases.push(db);
  await seedHive(db.adminSql);
  await upsertHiveMember({ workspaceId: WORKSPACE_ID, potHomeSlug: HIVE_SLUG,
    githubUserId: 101, githubUsername: 'owner', deviceAttestations: [attestation('owner-device')] }, db.adminSql);
  await upsertHiveMember({ workspaceId: WORKSPACE_ID, potHomeSlug: HIVE_SLUG,
    githubUserId: 102, githubUsername: 'member', deviceAttestations: [attestation('member-old')] }, db.adminSql);
  return db;
}
function roster(db: OrgTestDb) {
  return getScopeRoster({ workspaceId: WORKSPACE_ID, potSlug: HIVE_SLUG, sqlOverride: db.adminSql });
}
// A storage/transport fixture only. Membership and epochs come from the real PG
// roster, and the production coordinator decides every attach/detach/disclosure.
function scopeStore() {
  const sessions = new Map<string, ScopedSessionLike & { attached: Set<object> }>();
  const store: ScopedStoreLike = { get(opts) {
    const key = opts.key ?? createHash('sha256').update(opts.name!).digest();
    const hex = key.toString('hex');
    let session = sessions.get(hex);
    if (!session) {
      const attached = new Set<object>();
      session = { key, writable: !!opts.name, attached, ready: async () => {}, close: async () => {},
        replicate: mux => void attached.add(mux),
        replicator: { attached: mux => attached.has(mux), detachFrom: mux => void attached.delete(mux) } };
      sessions.set(hex, session);
    }
    return session;
  } };
  return { store, sessions };
}
function announce(uid: number, scoped_logs?: string[]): SignedAnnounce {
  return { github_user_id: uid, github_login: `u${uid}`, device_pubkey: `device-${uid}`,
    attestation_gist_id: 'fixture', log_core_key: uid.toString(16).padStart(64, '0'),
    ts: 1, sig: 'fixture', ...(scoped_logs ? { scoped_logs } : {}) };
}
// This suite checks key distribution, not cryptographic primitives. The tagged
// fixture wrapping lets the real PG loader/provider expose a wrong recipient.
const fixtureCrypto: HiveEpochCrypto = {
  deriveEpochKey: async (_pot, epoch) => Uint8Array.of(epoch) as EpochKey,
  wrapKeyToMember: async (key, member) => Buffer.from(JSON.stringify({ member, key: [...key] })),
  unwrapEpochKey: async (blob, member) => {
    const row = JSON.parse(Buffer.from(blob).toString()) as { member: string; key: number[] };
    if (row.member !== member) throw new Error('wrong recipient');
    return Uint8Array.from(row.key) as EpochKey;
  },
  encryptOp: async () => { throw new Error('encryption is outside this distribution fixture'); },
  decryptOp: async () => { throw new Error('decryption is outside this distribution fixture'); },
};
function keyBoundary(db: OrgTestDb, loadRevoked = () => loadRevokedHivePubkeys(WORKSPACE_ID, HIVE_SLUG, db.adminSql)) {
  return advanceEpochOnHiveBoundary({ workspaceId: WORKSPACE_ID, potHomeSlug: HIVE_SLUG,
    enabled: true, sql: db.adminSql }, {
    resolveCrypto: async () => fixtureCrypto,
    loadAllMemberPubkeys: async () => (await listHiveMembers(WORKSPACE_ID, HIVE_SLUG, db.adminSql))
      .flatMap(m => m.deviceAttestations.map(a => a.device_pubkey)),
    loadRevokedPubkeys: loadRevoked,
    resolveAuthorPubkey: async () => 'owner-device',
  });
}
async function project(db: OrgTestDb, epoch: number, revoked: string[]) {
  const opts = { workspaceId: WORKSPACE_ID, harnessSlug: HIVE_SLUG, sql: db.adminSql };
  const settings = buildHiveSettingsProjection(opts);
  const members = buildHiveMembersProjection(opts);
  const projections = new Map<string, TableProjection<unknown>>([
    [settings.tableTag, settings as TableProjection<unknown>], [members.tableTag, members as TableProjection<unknown>],
  ]);
  for (const [projection, key, value] of [
    [members, '101', { pot_home_slug: HIVE_SLUG, github_user_id: 101, github_username: 'owner',
      device_attestations: [attestation('owner-device')], revoked_pubkeys: revoked, binding_status: 'verified' }],
    [settings, 'epoch', { harness_slug: HIVE_SLUG, setting_key: 'epoch', value: JSON.stringify(epoch) }],
  ] as const) {
    expect(await applyOpVia(tag => projections.get(tag) ?? null, {
      type: 'put', table: projection.tableTag, hbKey: key, value,
      ts: epoch * 1000, hlc: encodeHlc({ ms: epoch * 1000, count: 0 }),
      writerPubkey: 'owner-device', sourceLogKeyHex: 'a'.repeat(64),
    }, { ownLogKeyHex: 'b'.repeat(64) })).toBe(true);
  }
}

describe('P533 prospective shared membership epoch', () => {
  it('an unrevoked member is admitted by the baseline epoch, comms and Git readers', async () => {
    const db = await peer();
    expect(await getHiveEpoch(WORKSPACE_ID, HIVE_SLUG, db.adminSql)).toBe(0);
    expect(await roster(db).currentEpoch(scope)).toBe(0);
    __setCommsTierGateDeps({ listHiveMembers: async () => listHiveMembers(WORKSPACE_ID, HIVE_SLUG, db.adminSql),
      effectiveCommsTier: async () => ({ tier: 'steer', source: 'override' }) });
    expect(await resolveAuthorCommsTier({ workspaceId: WORKSPACE_ID, potHomeSlug: HIVE_SLUG,
      devicePubkey: 'member-old', nowMs: 1000 })).toMatchObject({ tier: 'steer', githubUserId: 102 });
    expect(await resolvePeerAdmission({ workspaceId: WORKSPACE_ID, potHomeSlug: HIVE_SLUG,
      peerDevicePubkey: 'member-old', loadRevoked: async () => loadRevokedHivePubkeys(WORKSPACE_ID, HIVE_SLUG, db.adminSql),
      resolveMember: async () => 102 })).toMatchObject({ ok: true, githubUserId: 102 });
  });

  it('three peers use the same membership epoch after revoke, partition and rejoin; stale replay cannot lower it', async () => {
    const [a, b, c] = await Promise.all([peer(), peer(), peer()]);
    await Promise.all([a, b, c].map(db => project(db, 1, [])));
    await addRevokedHivePubkeys(WORKSPACE_ID, HIVE_SLUG, 101, ['member-old'], a.adminSql);
    await setHiveEpoch(WORKSPACE_ID, HIVE_SLUG, 2, a.adminSql);
    await project(b, 2, ['member-old']);
    // C is partitioned and still has epoch 1. Its later catch-up uses the same
    // production projections, followed by an out-of-order old replay.
    expect(await getHiveEpoch(WORKSPACE_ID, HIVE_SLUG, c.adminSql)).toBe(1);
    await project(c, 2, ['member-old']);
    await project(c, 1, []);
    for (const db of [a, b, c]) {
      expect(await getHiveEpoch(WORKSPACE_ID, HIVE_SLUG, db.adminSql)).toBe(2);
      expect(await loadRevokedHivePubkeys(WORKSPACE_ID, HIVE_SLUG, db.adminSql)).toContain('member-old');
      expect(await roster(db).currentEpoch(scope)).toBe(2);
    }
  });

  it('grant replay high-water remains separate from the membership epoch used for disclosure', async () => {
    const db = await peer();
    await setHiveEpoch(WORKSPACE_ID, HIVE_SLUG, 3, db.adminSql);
    await advanceGrantorHighWater({ workspaceId: WORKSPACE_ID, potSlug: HIVE_SLUG,
      grantorGithubUserId: 101, epoch: 23 }, db.adminSql);
    expect(await getHiveEpoch(WORKSPACE_ID, HIVE_SLUG, db.adminSql)).toBe(3);
    expect(await roster(db).currentEpoch(scope)).toBe(3);
    const rows = await db.adminSql`SELECT high_water_epoch FROM harness_shared.p2p_grantor_epochs
      WHERE workspace_id=${WORKSPACE_ID} AND harness_slug=${HIVE_SLUG} AND grantor_github_user_id=101`;
    expect(Number(rows[0].high_water_epoch)).toBe(23);
  });

  it('a cached comms admission cannot outlive the same revocation that immediately fences Git serving', async () => {
    const db = await peer();
    await setHiveEpoch(WORKSPACE_ID, HIVE_SLUG, 1, db.adminSql);
    __setCommsTierGateDeps({ listHiveMembers: async () => listHiveMembers(WORKSPACE_ID, HIVE_SLUG, db.adminSql),
      effectiveCommsTier: async () => ({ tier: 'steer', source: 'override' }) });
    const input = { workspaceId: WORKSPACE_ID, potHomeSlug: HIVE_SLUG, devicePubkey: 'member-old', nowMs: 1000 };
    expect(await resolveAuthorCommsTier(input)).toMatchObject({ tier: 'steer', githubUserId: 102 });
    await addRevokedHivePubkeys(WORKSPACE_ID, HIVE_SLUG, 101, ['member-old'], db.adminSql);
    await setHiveEpoch(WORKSPACE_ID, HIVE_SLUG, 2, db.adminSql);
    const serve = await resolvePeerAdmission({ workspaceId: WORKSPACE_ID, potHomeSlug: HIVE_SLUG,
      peerDevicePubkey: 'member-old', loadRevoked: async () => loadRevokedHivePubkeys(WORKSPACE_ID, HIVE_SLUG, db.adminSql),
      resolveMember: async () => 102 });
    expect(serve).toMatchObject({ ok: false, refusal: 'revoked-device' });
    const after = await resolveAuthorCommsTier({ ...input, nowMs: 1001 });
    expect(after.githubUserId).toBeNull();
    expect(after.tier).not.toBe('steer');
  });

  it('hive key distribution denies fresh keys to the revoked device while a survivor and a new rejoin device progress', async () => {
    const db = await peer();
    const provider = (device: string) => createEpochKeyProvider(fixtureCrypto,
      createPgWrappedKeyLoader(WORKSPACE_ID, HIVE_SLUG, db.adminSql), { keychainId: device, pubkeyBase64: device });
    const removed = provider('member-old');
    await keyBoundary(db);
    expect([...(await removed.keyForEpoch(HIVE_SLUG, 1))]).toEqual([1]);
    await addRevokedHivePubkeys(WORKSPACE_ID, HIVE_SLUG, 101, ['member-old'], db.adminSql);
    await keyBoundary(db);
    await expect(removed.keyForEpoch(HIVE_SLUG, 2)).rejects.toThrow();
    expect([...(await provider('owner-device').keyForEpoch(HIVE_SLUG, 2))]).toEqual([2]);
    await upsertHiveMember({ workspaceId: WORKSPACE_ID, potHomeSlug: HIVE_SLUG,
      githubUserId: 102, githubUsername: 'member', deviceAttestations: [attestation('member-new')] }, db.adminSql);
    await keyBoundary(db);
    expect([...(await provider('member-new').keyForEpoch(HIVE_SLUG, 3))]).toEqual([3]);
    await expect(removed.keyForEpoch(HIVE_SLUG, 3)).rejects.toThrow();
  });

  it('hive key publication fails closed without revocation authority and leaves the epoch unchanged', async () => {
    const db = await peer();
    await setHiveEpoch(WORKSPACE_ID, HIVE_SLUG, 4, db.adminSql);
    await expect(keyBoundary(db, async () => { throw new Error('roster unavailable'); })).rejects.toThrow('roster unavailable');
    expect(await getHiveEpoch(WORKSPACE_ID, HIVE_SLUG, db.adminSql)).toBe(4);
    const rows = await db.adminSql`SELECT count(*) AS n FROM harness_shared.pot_epoch_keys`;
    expect(Number(rows[0].n)).toBe(0);
  });

  it('scope disclosure uses the hive epoch and detaches a revoked peer even when the fleet directory is unchanged', async () => {
    const db = await peer();
    const { store, sessions } = scopeStore();
    const registry = new ScopeCoreRegistry(store);
    const liveRoster = getScopeRoster({ workspaceId: WORKSPACE_ID, potSlug: HIVE_SLUG,
      sqlOverride: db.adminSql, directory: { scopeMembers: async () => [101, 102] } });
    const sent: SignedAnnounce[] = [];
    const muxer = {};
    const fed = new ScopeFederation({ registry, roster: liveRoster, selfGithubUserId: 101,
      buildScopedAnnounce: async logs => announce(101, logs) });
    await setHiveEpoch(WORKSPACE_ID, HIVE_SLUG, 1, db.adminSql);
    await fed.ensureOwnScopes([scope]);
    await fed.onPeerAnnounce(announce(102), { muxer, send: frame => void sent.push(frame) });
    expect.soft(sent.at(-1)?.scoped_logs?.[0]?.split('|')[2]).toBe('1');
    const session = [...sessions.values()][0]!;
    expect(session.attached.has(muxer)).toBe(true);
    await addRevokedHivePubkeys(WORKSPACE_ID, HIVE_SLUG, 101, ['member-old'], db.adminSql);
    await setHiveEpoch(WORKSPACE_ID, HIVE_SLUG, 2, db.adminSql);
    await fed.redisclose();
    expect.soft(session.attached.has(muxer)).toBe(false);
    expect.soft(sent.at(-1)?.scoped_logs).toEqual([]);
    expect.soft(await liveRoster.currentEpoch(scope)).toBe(2);
  });

  it('an unresolved roster authority cannot grant even an owner scope or manufacture epoch zero', async () => {
    const unavailable = getScopeRoster({ workspaceId: null, potSlug: HIVE_SLUG });
    const admitted = await unavailable.isMember(scope, 101).catch(() => false);
    expect.soft(admitted).toBe(false);
    const epoch = await unavailable.currentEpoch(scope).catch(() => null);
    expect.soft(epoch).toBeNull();
  });

  it('trust admission cannot retain a warmed grant while its roster authority is unavailable', async () => {
    const db = await peer();
    let unavailable = false;
    __setCommsTierGateDeps({ listHiveMembers: async () => {
      if (unavailable) throw new Error('roster unavailable');
      return listHiveMembers(WORKSPACE_ID, HIVE_SLUG, db.adminSql);
    }, effectiveCommsTier: async () => ({ tier: 'steer', source: 'override' }) });
    const input = { workspaceId: WORKSPACE_ID, potHomeSlug: HIVE_SLUG, devicePubkey: 'member-old', nowMs: 1000 };
    expect(await resolveAuthorCommsTier(input)).toMatchObject({ tier: 'steer', githubUserId: 102 });
    unavailable = true;
    const denied = await resolveAuthorCommsTier({ ...input, nowMs: 1001 });
    expect.soft(denied.githubUserId).toBeNull();
    expect.soft(denied.tier).not.toBe('steer');
  });

  it('rate admission refreshes the real receiver identity after revoke, denies unknown authority and permits survivor/rejoin writes', async () => {
    const db = await peer();
    const sink = vi.fn(async (_op: OpEnvelope) => true);
    const identity = async (device: string) => resolveGithubUserIdForDevicePubkey(WORKSPACE_ID,
      HIVE_SLUG, device, db.adminSql, { loadMembers: async () => listHiveMembers(WORKSPACE_ID, HIVE_SLUG, db.adminSql) });
    const admit = async (device: string, key: string, authorityAvailable = true) => {
      const uid = authorityAvailable ? await identity(device) : null;
      return makeRateLimitedApply({ limiter: new MemberRateLimiter(), ownLogKeyHex: 'a'.repeat(64),
        resolveAuthorId: () => uid, currentCaps: () => ({ opsPerMin: 100 }), apply: sink })({
        type: 'put', table: 'features-by-id', hbKey: key, value: { id: key }, ts: 1000,
        sourceLogKeyHex: 'b'.repeat(64), writerPubkey: device,
      });
    };
    expect(await admit('member-old', 'before')).toBe(true);
    await addRevokedHivePubkeys(WORKSPACE_ID, HIVE_SLUG, 101, ['member-old'], db.adminSql);
    await setHiveEpoch(WORKSPACE_ID, HIVE_SLUG, 2, db.adminSql);
    expect(await admit('member-old', 'revoked')).toBe(false);
    expect(await admit('owner-device', 'unknown', false)).toBe(false);
    expect(await admit('owner-device', 'survivor')).toBe(true);
    await upsertHiveMember({ workspaceId: WORKSPACE_ID, potHomeSlug: HIVE_SLUG,
      githubUserId: 102, githubUsername: 'member', deviceAttestations: [attestation('member-new')] }, db.adminSql);
    expect(await admit('member-new', 'rejoin')).toBe(true);
    expect(sink.mock.calls.map(([op]) => op.hbKey)).toEqual(['before', 'survivor', 'rejoin']);
  });

  it.each(['revocation', 'member'] as const)('Git serving denies unavailable %s authority before any serve action', async failure => {
    const db = await peer();
    const decision = await resolvePeerAdmission({ workspaceId: WORKSPACE_ID, potHomeSlug: HIVE_SLUG,
      peerDevicePubkey: 'member-old', loadRevoked: async () => {
        if (failure === 'revocation') throw new Error('roster unavailable');
        return loadRevokedHivePubkeys(WORKSPACE_ID, HIVE_SLUG, db.adminSql);
      }, resolveMember: async () => { throw new Error('member authority unavailable'); } });
    expect(decision).toMatchObject({ ok: false,
      refusal: failure === 'revocation' ? 'revocation-lookup-error' : 'member-lookup-error' });
  });
});
