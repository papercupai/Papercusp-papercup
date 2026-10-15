/**
 * feature-commits.integration.test.ts — makeFeatureCommitLookup, which resolves a
 * feature ref to its recorded implementing commit SHA(s) via
 * harness_features_consolidated.completion_ref (jsonb), against a real Postgres.
 *
 * Behaviors a fake-sql unit test can't prove: the (workspace, harness, feature)
 * scoping, and that ONLY a VALID CompletionRef (isCompletionRef) with a commit_sha
 * yields a SHA — an unknown/null/malformed completion_ref returns [] so the drift
 * resolver reports 'unresolved-feature', never a false verdict. isCompletionRef is
 * kept real (it's the gate under test).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../../test/_work-items-schema';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { makeFeatureCommitLookup } = await import('./feature-commits');

const SHA = 'a'.repeat(40);
const validRef = { remote: 'origin', branch: 'main', commit_sha: SHA, pr_url: 'https://github.com/o/r/pull/1', schema_version: 1 };
let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `fc_${randomBytes(5).toString('hex')}`;
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
  // P-010 unification: work_items base + hfc/ei compat views.
  await rootSql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.work_items `;
});

async function insert(featureId: string, completionRef: unknown, opts: { ws?: string; harness?: string } = {}) {
  await rootSql`
    INSERT INTO harness_shared.harness_features_consolidated (workspace_id, harness_slug, feature_id, completion_ref)
    VALUES (${opts.ws ?? 'default'}, ${opts.harness ?? 'web'}, ${featureId},
            ${completionRef === null ? null : rootSql.json(completionRef as object)})`;
}

describe('makeFeatureCommitLookup (PG)', () => {
  it('returns the recorded commit SHA for a feature with a valid completion_ref', async () => {
    await insert('F-1', validRef);
    expect(await makeFeatureCommitLookup('web')('F-1')).toEqual([SHA]);
  });

  it('returns [] for a feature with NULL completion_ref', async () => {
    await insert('F-2', null);
    expect(await makeFeatureCommitLookup('web')('F-2')).toEqual([]);
  });

  it('returns [] for a MALFORMED completion_ref (not a valid CompletionRef) — never a false verdict', async () => {
    await insert('F-3', { commit_sha: 'deadbeef' }); // truthy commit_sha but missing remote/branch/pr_url/schema_version
    expect(await makeFeatureCommitLookup('web')('F-3')).toEqual([]);
  });

  it('returns [] for an unknown feature', async () => {
    expect(await makeFeatureCommitLookup('web')('F-NOPE')).toEqual([]);
  });

  it('is scoped to the harness + workspace — a matching feature in another harness is not returned', async () => {
    await insert('F-1', validRef, { harness: 'api' });
    expect(await makeFeatureCommitLookup('web')('F-1')).toEqual([]); // wrong harness
    expect(await makeFeatureCommitLookup('api')('F-1')).toEqual([SHA]); // right harness
    await insert('F-9', validRef, { ws: 'other-ws' });
    expect(await makeFeatureCommitLookup('web', 'default')('F-9')).toEqual([]); // wrong workspace
  });
});
