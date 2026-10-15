/**
 * trust-store.integration.test.ts
 *
 * Proves the PG-backed trust store (migration 026; single row per
 * workspace in harness_shared.operator_trust_store via operator-state-pg)
 * against a real Postgres testcontainer: the record/check/revoke trust
 * lifecycle, key-rotation + blocklist semantics, and — because the table
 * is in ENCRYPTED_TABLES — that the payload lands pgcrypto-encrypted in
 * payload_ct with the plaintext payload column kept empty.
 *
 * Mirrors operator-conversation-compaction.integration.test.ts's setup
 * (getOrgPg over a per-test database).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

// Pin the encryption key BEFORE the first read/write call sources (and
// caches) it — otherwise the test would touch ~/.papercusp/db-encryption-key.
process.env.PAPERCUSP_DB_ENCRYPTION_KEY = 'provision-trust-store-test-key';

const WS = 'ws-trust-store-test';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const {
  readTrustStore,
  recordTrust,
  checkTrust,
  recordKeyRotation,
  blocklistFingerprint,
  revokeTrust,
} = await import('./trust-store');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `pt_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // pgcrypto powers the payload_ct encryption path (ENCRYPTED_TABLES).
  await rootSql.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  // Baseline shape (000-baseline.sql ~:1909) — verbatim.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.operator_trust_store (
      workspace_id text NOT NULL,
      payload jsonb NOT NULL,
      updated_at bigint DEFAULT 0 NOT NULL,
      payload_ct bytea,
      CONSTRAINT operator_trust_store_pkey PRIMARY KEY (workspace_id)
    );
  `);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`DELETE FROM harness_shared.operator_trust_store`;
});

describe('trust store (PG)', () => {
  it('starts empty', async () => {
    const store = await readTrustStore();
    expect(store.entries).toEqual([]);
    expect(store.rotations).toEqual([]);
    expect(store.blocklist).toEqual([]);
  });

  it('records and checks trust', async () => {
    await recordTrust({
      publisher: '@papercupai',
      plugin: 'aws-lambda',
      publisherKeyFingerprint: 'SHA256:abc',
      scriptHash: 'sha256:s1',
    });
    const r = await checkTrust({
      publisher: '@papercupai',
      plugin: 'aws-lambda',
      scriptHash: 'sha256:s1',
      currentFingerprint: 'SHA256:abc',
    });
    expect(r.trusted).toBe(true);
  });

  it('returns no-trust for an unknown plugin', async () => {
    const r = await checkTrust({
      publisher: 'X',
      plugin: 'Y',
      scriptHash: 'sha256:s1',
      currentFingerprint: 'fp',
    });
    expect(r.trusted).toBe(false);
    if (!r.trusted) expect(r.reason).toBe('no-trust');
  });

  it('rejects when fingerprint differs (key-rotated)', async () => {
    await recordTrust({
      publisher: 'X',
      plugin: 'Y',
      publisherKeyFingerprint: 'old',
      scriptHash: 'sha256:s1',
    });
    const r = await checkTrust({
      publisher: 'X',
      plugin: 'Y',
      scriptHash: 'sha256:s1',
      currentFingerprint: 'new',
    });
    expect(r.trusted).toBe(false);
    if (!r.trusted) expect(r.reason).toBe('key-rotated');
  });

  it('rejects an unapproved scriptHash even when the publisher is trusted', async () => {
    await recordTrust({
      publisher: 'X',
      plugin: 'Y',
      publisherKeyFingerprint: 'fp',
      scriptHash: 'sha256:old',
    });
    const r = await checkTrust({
      publisher: 'X',
      plugin: 'Y',
      scriptHash: 'sha256:new',
      currentFingerprint: 'fp',
    });
    expect(r.trusted).toBe(false);
    if (!r.trusted) expect(r.reason).toBe('script-not-approved');
  });

  it('blocklist rejects regardless of trust', async () => {
    await recordTrust({
      publisher: 'X',
      plugin: 'Y',
      publisherKeyFingerprint: 'fp',
      scriptHash: 'sha256:s1',
    });
    await blocklistFingerprint('fp');
    const r = await checkTrust({
      publisher: 'X',
      plugin: 'Y',
      scriptHash: 'sha256:s1',
      currentFingerprint: 'fp',
    });
    expect(r.trusted).toBe(false);
    if (!r.trusted) expect(r.reason).toBe('blocklisted');
  });

  it('replaces approved hashes when the fingerprint changes', async () => {
    await recordTrust({
      publisher: 'X',
      plugin: 'Y',
      publisherKeyFingerprint: 'old',
      scriptHash: 'sha256:s1',
    });
    await recordTrust({
      publisher: 'X',
      plugin: 'Y',
      publisherKeyFingerprint: 'new',
      scriptHash: 'sha256:s2',
    });
    const store = await readTrustStore();
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0].publisherKeyFingerprint).toBe('new');
    expect(store.entries[0].approvedScriptHashes).toEqual(['sha256:s2']);
  });

  it('revokeTrust drops the entry', async () => {
    await recordTrust({
      publisher: 'X',
      plugin: 'Y',
      publisherKeyFingerprint: 'fp',
      scriptHash: 'sha256:s1',
    });
    await revokeTrust('X', 'Y');
    const r = await checkTrust({
      publisher: 'X',
      plugin: 'Y',
      scriptHash: 'sha256:s1',
      currentFingerprint: 'fp',
    });
    expect(r.trusted).toBe(false);
    if (!r.trusted) expect(r.reason).toBe('no-trust');
  });

  it('records key-rotation events', async () => {
    await recordKeyRotation({
      publisher: '@papercupai',
      oldFingerprint: 'old',
      newFingerprint: 'new',
      rotatedAt: '2026-05-12T00:00:00Z',
      countersigned: true,
      reason: 'scheduled',
    });
    const store = await readTrustStore();
    expect(store.rotations).toHaveLength(1);
    expect(store.rotations[0].countersigned).toBe(true);
  });

  it('stores the payload encrypted at rest (payload_ct, plaintext payload kept empty)', async () => {
    await recordTrust({
      publisher: '@papercupai',
      plugin: 'aws-lambda',
      publisherKeyFingerprint: 'SHA256:secret-fp',
      scriptHash: 'sha256:s1',
    });
    const rows = await rootSql<{ payload: string; payload_ct: Uint8Array | null }[]>`
      SELECT payload::text AS payload, payload_ct
        FROM harness_shared.operator_trust_store
       WHERE workspace_id = ${WS}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toBe('{}'); // legacy column kept null-equivalent
    expect(rows[0].payload_ct).toBeTruthy();
    // The ciphertext must not leak the fingerprint in the clear.
    expect(Buffer.from(rows[0].payload_ct!).toString('utf8')).not.toContain('secret-fp');
    // And the read path round-trips it back out.
    const store = await readTrustStore();
    expect(store.entries[0].publisherKeyFingerprint).toBe('SHA256:secret-fp');
  });
});
