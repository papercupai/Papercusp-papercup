/**
 * load-revoked-pubkeys.integration.test.ts — loadRevokedPubkeys, which unions the
 * revoked_pubkeys text[] across a (workspace, harness)'s contributors into a Set,
 * against a real Postgres.
 *
 * Behaviors a fake-sql unit test can't prove: the text[] columns union + DEDUPE
 * across multiple contributor rows; the read is scoped to (workspace, harness);
 * and an empty/absent set yields an empty Set. (The default runQuery path is
 * exercised — getOrgPg().sql.unsafe against the real contributors table.)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { loadRevokedPubkeys } = await import('./load-revoked-pubkeys');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `rev_${randomBytes(5).toString('hex')}`;
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
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.contributors (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      github_user_id bigint NOT NULL,
      github_username text NOT NULL,
      revoked_pubkeys text[] DEFAULT '{}' NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug, github_user_id)
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.contributors`;
});

async function addContributor(ws: string, harness: string, userId: number, revoked: string[]) {
  await rootSql`INSERT INTO harness_shared.contributors (workspace_id, harness_slug, github_user_id, github_username, revoked_pubkeys)
                VALUES (${ws}, ${harness}, ${userId}, ${'u' + userId}, ${revoked})`;
}

describe('loadRevokedPubkeys (PG)', () => {
  it('unions + dedupes revoked_pubkeys across the harness contributors', async () => {
    await addContributor('ws1', 'web', 1, ['k1', 'k2']);
    await addContributor('ws1', 'web', 2, ['k2', 'k3']); // k2 overlaps
    await addContributor('ws1', 'web', 3, []); // contributes nothing
    const set = await loadRevokedPubkeys({ workspaceId: 'ws1', harnessSlug: 'web' });
    expect([...set].sort()).toEqual(['k1', 'k2', 'k3']); // union, deduped
  });

  it('is scoped to (workspace, harness)', async () => {
    await addContributor('ws1', 'web', 1, ['web-key']);
    await addContributor('ws1', 'api', 2, ['api-key']); // other harness
    await addContributor('ws2', 'web', 3, ['ws2-key']); // other workspace
    expect([...await loadRevokedPubkeys({ workspaceId: 'ws1', harnessSlug: 'web' })]).toEqual(['web-key']);
  });

  it('returns an empty Set when there are no contributors / no revocations', async () => {
    expect((await loadRevokedPubkeys({ workspaceId: 'ws1', harnessSlug: 'empty' })).size).toBe(0);
    await addContributor('ws1', 'web', 1, []);
    expect((await loadRevokedPubkeys({ workspaceId: 'ws1', harnessSlug: 'web' })).size).toBe(0);
  });
});
