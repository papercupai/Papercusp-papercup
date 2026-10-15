/**
 * ledger.integration.test.ts — the parallel-llm-test claim ledger
 * (llm_test_claims, migration 074), against a real Postgres.
 *
 * The module opens its OWN pool via getHarnessAdminUrl(); we mock that to a
 * per-test DB (the storage.integration.test.ts pattern) and TRUNCATE between tests.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - tryClaim is mutually exclusive on claim_key (ON CONFLICT DO NOTHING → busy +
 *    the live holder envelope);
 *  - it OPPORTUNISTICALLY REAPS expired holders at acquire time so a stale claim
 *    never blocks the full TTL (TEETHED here: the `DELETE … expires_at < now()`);
 *  - heartbeat / release are owner-checked (a non-owner can neither extend nor free);
 *  - the EI-281 path: a holder owned by a DEAD local pid is reaped on contention even
 *    BEFORE its TTL lapses;
 *  - reapExpired removes only expired rows and returns the count.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ url: '' }));
vi.mock('../embedded-pg-discovery', () => ({ getHarnessAdminUrl: () => h.url }));

const { tryClaim, heartbeat, release, reapExpired, buildClaimKey, holderIsDeadLocalPid } = await import('./ledger');

let rootSql: postgres.Sql;
const key = (over: Partial<{ scenarioId: string; identityHash: string; matrixIndex: number }> = {}) =>
  ({ scenarioId: 's1', identityHash: 'idhash0000000000zz', matrixIndex: 0, ...over });

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `ledger_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  h.url = u.toString(); // the module's pool opens against this
  rootSql = postgres(u.toString(), { max: 2, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to migration 074.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.llm_test_claims (
      claim_key text PRIMARY KEY, owner_id text NOT NULL,
      scenario_id text NOT NULL, identity_hash text NOT NULL, matrix_index int,
      acquired_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
      metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb
    )`);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.llm_test_claims`;
});

// Seed a claim directly with a chosen owner + expiry (bypasses tryClaim's reap).
async function seed(ck: string, ownerId: string, expiresAt: string) {
  await rootSql`INSERT INTO harness_shared.llm_test_claims (claim_key, owner_id, scenario_id, identity_hash, matrix_index, expires_at)
                VALUES (${ck}, ${ownerId}, 's1', 'idhash0000000000zz', 0, ${expiresAt})`;
}

describe('llm-test claim ledger (PG)', () => {
  it('tryClaim is mutually exclusive — a second owner gets busy + the holder envelope', async () => {
    const a = await tryClaim({ ...key(), ownerId: 'runner-A', ttlSec: 600 });
    expect(a).toMatchObject({ ok: true, ownerId: 'runner-A' });
    const b = await tryClaim({ ...key(), ownerId: 'runner-B', ttlSec: 600 });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b).toMatchObject({ reason: 'busy', holder: { ownerId: 'runner-A' } });
    expect(await rootSql`SELECT 1 FROM harness_shared.llm_test_claims`).toHaveLength(1); // one holder
  });

  it('REAPS an expired holder at acquire time — a stale claim never blocks the full TTL', async () => {
    const ck = buildClaimKey(key());
    await seed(ck, 'runner-A', '2000-01-01T00:00:00Z'); // long expired, non-pid owner
    const b = await tryClaim({ ...key(), ownerId: 'runner-B', ttlSec: 600 });
    expect(b).toMatchObject({ ok: true, ownerId: 'runner-B' }); // reaped → B claims
    const row = (await rootSql`SELECT owner_id FROM harness_shared.llm_test_claims WHERE claim_key=${ck}`)[0]!;
    expect(row.owner_id).toBe('runner-B'); // the new holder
  });

  it('different matrix_index → independent claim keys (both held concurrently)', async () => {
    expect(buildClaimKey(key({ matrixIndex: 0 }))).not.toBe(buildClaimKey(key({ matrixIndex: 1 })));
    expect((await tryClaim({ ...key({ matrixIndex: 0 }), ownerId: 'A' })).ok).toBe(true);
    expect((await tryClaim({ ...key({ matrixIndex: 1 }), ownerId: 'A' })).ok).toBe(true); // distinct key, not a conflict
    expect(await rootSql`SELECT 1 FROM harness_shared.llm_test_claims`).toHaveLength(2);
  });

  it('heartbeat extends expires_at for the OWNER only', async () => {
    await tryClaim({ ...key(), ownerId: 'runner-A', ttlSec: 10 });
    const before = (await rootSql`SELECT expires_at FROM harness_shared.llm_test_claims`)[0]!.expires_at as Date;
    const ck = buildClaimKey(key());
    expect(await heartbeat(ck, 'runner-A', 3600)).toBe(true); // owner extends
    const after = (await rootSql`SELECT expires_at FROM harness_shared.llm_test_claims`)[0]!.expires_at as Date;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
    expect(await heartbeat(ck, 'someone-else', 99999)).toBe(false); // non-owner can't
    const unchanged = (await rootSql`SELECT expires_at FROM harness_shared.llm_test_claims`)[0]!.expires_at as Date;
    expect(unchanged.getTime()).toBe(after.getTime()); // no extension by the impostor
  });

  it('release is owner-checked — a non-owner cannot free the claim', async () => {
    await tryClaim({ ...key(), ownerId: 'runner-A', ttlSec: 600 });
    const ck = buildClaimKey(key());
    await release(ck, 'impostor'); // wrong owner → no-op
    expect(await rootSql`SELECT 1 FROM harness_shared.llm_test_claims`).toHaveLength(1); // still held
    await release(ck, 'runner-A'); // owner frees it
    expect(await rootSql`SELECT 1 FROM harness_shared.llm_test_claims`).toHaveLength(0);
    expect((await tryClaim({ ...key(), ownerId: 'runner-B' })).ok).toBe(true); // reclaimable
  });

  it('EI-281: a DEAD local-pid holder is reaped on contention even before its TTL lapses', async () => {
    const deadPid = 2_147_483_646; // no process owns this
    expect(holderIsDeadLocalPid(`${hostname()}:${deadPid}`)).toBe(true); // sanity: probe says dead
    const ck = buildClaimKey(key());
    await seed(ck, `${hostname()}:${deadPid}`, '2999-01-01T00:00:00Z'); // FUTURE expiry — TTL reap can't touch it
    const b = await tryClaim({ ...key(), ownerId: 'runner-B', ttlSec: 600 });
    expect(b).toMatchObject({ ok: true, ownerId: 'runner-B' }); // dead-pid path reaped it
  });

  it('reapExpired removes only expired rows and returns the count', async () => {
    await seed('k-old', 'runner-A', '2000-01-01T00:00:00Z'); // expired
    await seed('k-live', 'runner-B', '2999-01-01T00:00:00Z'); // live
    expect(await reapExpired()).toBe(1); // only the expired one
    expect((await rootSql`SELECT claim_key FROM harness_shared.llm_test_claims`).map((r) => r.claim_key)).toEqual(['k-live']);
  });
});
