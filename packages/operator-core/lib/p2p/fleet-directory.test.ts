/**
 * fleet-directory store + PgFleetDirectory — unit tests (P-101 / D-006) with a
 * stubbed postgres client (`{ unsafe }` — every store read/write goes through
 * pg(sql).unsafe(query, params)). Real Ed25519 keys exercise the author→verify
 * loop end-to-end; hive membership reads are module-mocked (the store imports
 * them directly).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const listHiveMembersMock = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
const loadRevokedMock = vi.fn(async (..._args: unknown[]): Promise<Set<string>> => new Set<string>());
vi.mock('../hive-membership-store', () => ({
  listHiveMembers: (...args: unknown[]) => listHiveMembersMock(...args),
  loadRevokedHivePubkeys: (...args: unknown[]) => loadRevokedMock(...args),
}));

import { putFleetRecord, PgFleetDirectory, type FleetRecordSigner } from './fleet-directory';
import { GrantBackedScopeRoster } from './scope-roster';
import {
  canonicalFleetRecordJson,
  coerceFleetDirectoryRecord,
  fleetDirectorySignedBytes,
} from './fleet-directory-schema';
import {
  generateEd25519KeypairDer,
  signWithPrivateKeyDer,
  verifyEd25519,
} from '../identity/ed25519';

const WS = 'ws-test';
const HIVE = 'hive-home';
const OWNER = 279242982;
const PUB = 1567022;

const kp = generateEd25519KeypairDer();
const devicePubkey = kp.pubkeyBase64;
const signer: FleetRecordSigner = {
  pubkey: devicePubkey,
  sign: async (bytes) => signWithPrivateKeyDer(kp.privateKeyDer, bytes),
};

const baseRecord = {
  fleetSlug: 'alpha',
  ownerGithubUserId: OWNER,
  title: 'Alpha fleet',
  description: '',
  publisherGithubUserIds: [PUB],
  recordVersion: 1,
  archived: false,
};

/** DB-row shape the store's READ_COLS select returns, for a given signed record. */
function dbRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const c = coerceFleetDirectoryRecord(baseRecord);
  if (!c.ok) throw new Error(c.error);
  const json = canonicalFleetRecordJson(c.record);
  return {
    workspace_id: WS,
    harness_slug: HIVE,
    owner_github_user_id: OWNER,
    fleet_slug: 'alpha',
    record_json: json,
    signer_device_pubkey: devicePubkey,
    signature: 'c2ln',
    record_version: 1,
    archived: false,
    fed_hlc: null,
    updated_at: 0,
    ...over,
  };
}

/** Fake postgres client: unsafe(query, params) dispatches on the query verb. */
function fakeSql(handlers: { select?: () => unknown[]; write?: (q: string, params: unknown[]) => unknown[] }) {
  const calls: { q: string; params: unknown[] }[] = [];
  const sql = {
    unsafe: async (q: string, params: unknown[]) => {
      calls.push({ q, params });
      if (/^\s*SELECT/i.test(q)) return handlers.select?.() ?? [];
      return handlers.write?.(q, params) ?? [];
    },
  } as unknown as postgres.Sql;
  return { sql, calls };
}

beforeEach(() => {
  listHiveMembersMock.mockReset().mockResolvedValue([]);
  loadRevokedMock.mockReset().mockResolvedValue(new Set());
});

describe('putFleetRecord', () => {
  it('refuses a non-owner author (D-006 single-owner gate)', async () => {
    const { sql } = fakeSql({});
    const r = await putFleetRecord({
      workspaceId: WS, potHomeSlug: HIVE, selfGithubUserId: PUB,
      record: baseRecord, signer, sql,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/only the fleet owner/);
  });

  it('refuses a non-advancing recordVersion against the stored row', async () => {
    const { sql } = fakeSql({ select: () => [dbRow({ record_version: 3 })] });
    const r = await putFleetRecord({
      workspaceId: WS, potHomeSlug: HIVE, selfGithubUserId: OWNER,
      record: { ...baseRecord, recordVersion: 3 }, signer, sql,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/does not advance/);
  });

  it('authors a signed row whose signature verifies over the canonical bytes', async () => {
    let written: unknown[] | null = null;
    const { sql } = fakeSql({
      select: () => [],
      write: (_q, params) => {
        written = params;
        // Echo a plausible RETURNING row from the insert params (positional:
        // ws, hive, owner, slug, json, signer, sig, version, archived, ...).
        return [dbRow({
          record_json: params[4], signer_device_pubkey: params[5],
          signature: params[6], record_version: params[7], archived: params[8],
        })];
      },
    });
    const r = await putFleetRecord({
      workspaceId: WS, potHomeSlug: HIVE, selfGithubUserId: OWNER,
      record: baseRecord, signer, sql,
    });
    expect(r.ok).toBe(true);
    expect(written).not.toBeNull();
    if (!r.ok) return;
    const bytes = fleetDirectorySignedBytes({
      workspaceId: WS, potHomeSlug: HIVE,
      recordVersion: r.stored.recordVersion, canonicalRecordJson: r.stored.recordJson,
    });
    expect(verifyEd25519(bytes, r.stored.signerDevicePubkey, Buffer.from(r.stored.signature, 'base64'))).toBe(true);
  });
});

describe('PgFleetDirectory', () => {
  it('scopeMembers: null when absent or archived; owner ∪ publishers otherwise', async () => {
    const scope = { kind: 'fleet' as const, ownerGithubUserId: OWNER, slug: 'alpha' };
    const absent = new PgFleetDirectory({ workspaceId: WS, potSlug: HIVE, sqlOverride: fakeSql({ select: () => [] }).sql });
    expect(await absent.scopeMembers(scope)).toBeNull();
    const archived = new PgFleetDirectory({
      workspaceId: WS, potSlug: HIVE,
      sqlOverride: fakeSql({ select: () => [dbRow({ archived: true })] }).sql,
    });
    expect(await archived.scopeMembers(scope)).toBeNull();
    const live = new PgFleetDirectory({
      workspaceId: WS, potSlug: HIVE,
      sqlOverride: fakeSql({ select: () => [dbRow()] }).sql,
    });
    expect(await live.scopeMembers(scope)).toEqual([OWNER, PUB]);
  });

  it('resolvePublisherSet: fail-closed refusal on an absent record', async () => {
    const dir = new PgFleetDirectory({ workspaceId: WS, potSlug: HIVE, sqlOverride: fakeSql({ select: () => [] }).sql });
    const set = await dir.resolvePublisherSet({ kind: 'fleet', ownerGithubUserId: OWNER, slug: 'alpha' });
    expect(set).toEqual({
      ownerGithubUserId: OWNER, ownerAnchored: false,
      ownerSignatureValid: false, memberGithubUserIds: [],
    });
  });

  it('resolvePublisherSet: anchored + signature-valid for a genuinely signed stored row', async () => {
    const c = coerceFleetDirectoryRecord(baseRecord);
    if (!c.ok) throw new Error(c.error);
    const json = canonicalFleetRecordJson(c.record);
    const sig = signWithPrivateKeyDer(kp.privateKeyDer, fleetDirectorySignedBytes({
      workspaceId: WS, potHomeSlug: HIVE, recordVersion: 1, canonicalRecordJson: json,
    })).toString('base64');
    listHiveMembersMock.mockResolvedValue([
      { githubUserId: OWNER, deviceAttestations: [{ device_pubkey: devicePubkey }] },
    ]);
    const dir = new PgFleetDirectory({
      workspaceId: WS, potSlug: HIVE,
      sqlOverride: fakeSql({ select: () => [dbRow({ signature: sig })] }).sql,
    });
    const set = await dir.resolvePublisherSet({ kind: 'fleet', ownerGithubUserId: OWNER, slug: 'alpha' });
    expect(set.ownerAnchored).toBe(true);
    expect(set.ownerSignatureValid).toBe(true);
    expect(set.memberGithubUserIds).toEqual([OWNER, PUB]);

    // Revoking the signing device kills BOTH anchoring (sole device) and validity.
    loadRevokedMock.mockResolvedValue(new Set([devicePubkey]));
    const revokedSet = await dir.resolvePublisherSet({ kind: 'fleet', ownerGithubUserId: OWNER, slug: 'alpha' });
    expect(revokedSet.ownerAnchored).toBe(false);
    expect(revokedSet.ownerSignatureValid).toBe(false);
  });

  it('listParticipatingScopes: owner or publisher rows only', async () => {
    const other = dbRow({
      owner_github_user_id: 555, fleet_slug: 'beta',
      record_json: canonicalFleetRecordJson((() => {
        const c = coerceFleetDirectoryRecord({ ...baseRecord, ownerGithubUserId: 555, fleetSlug: 'beta', publisherGithubUserIds: [] });
        if (!c.ok) throw new Error(c.error);
        return c.record;
      })()),
    });
    const dir = new PgFleetDirectory({
      workspaceId: WS, potSlug: HIVE,
      sqlOverride: fakeSql({ select: () => [dbRow(), other] }).sql,
    });
    expect(await dir.listParticipatingScopes(OWNER)).toEqual([{ kind: 'fleet', ownerGithubUserId: OWNER, slug: 'alpha' }]);
    expect(await dir.listParticipatingScopes(PUB)).toEqual([{ kind: 'fleet', ownerGithubUserId: OWNER, slug: 'alpha' }]);
    expect(await dir.listParticipatingScopes(999)).toEqual([]);
  });
});

describe('GrantBackedScopeRoster + PgFleetDirectory (the P-101 widening)', () => {
  it('widens members to attested owner and publishers; revocations narrow the same directory', async () => {
    const owner = { githubUserId: OWNER, deviceAttestations: [{ device_pubkey: devicePubkey }], revokedPubkeys: [] as string[] };
    const publisher = { githubUserId: PUB, deviceAttestations: [{ device_pubkey: 'publisher-device' }], revokedPubkeys: [] };
    listHiveMembersMock.mockResolvedValue([owner, publisher]);
    const scope = { kind: 'fleet' as const, ownerGithubUserId: OWNER, slug: 'alpha' };
    const directory = new PgFleetDirectory({
      workspaceId: WS, potSlug: HIVE,
      sqlOverride: fakeSql({ select: () => [dbRow()] }).sql,
    });
    const roster = new GrantBackedScopeRoster({ workspaceId: WS, potSlug: HIVE, directory });
    expect(await roster.members(scope)).toEqual([OWNER, PUB]);
    expect(await roster.isMember(scope, PUB)).toBe(true);
    expect(await roster.isMember(scope, 999)).toBe(false);
    expect(await roster.isMember(scope, OWNER)).toBe(true);

    // No directory narrows the live roster to its attested owner.
    const bare = new GrantBackedScopeRoster({ workspaceId: WS, potSlug: HIVE });
    expect(await bare.members(scope)).toEqual([OWNER]);
    expect(await bare.isMember(scope, PUB)).toBe(false);

    listHiveMembersMock.mockResolvedValue([{ ...owner, revokedPubkeys: ['publisher-device'] }, publisher]);
    expect(await roster.members(scope)).toEqual([OWNER]);
    expect(await roster.isMember(scope, PUB)).toBe(false);
  });
});
