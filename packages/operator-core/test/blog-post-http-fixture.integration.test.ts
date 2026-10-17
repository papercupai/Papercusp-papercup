import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createOwnedExternalTriggerSource } from '../lib/external-triggers/source-store';
import { createOrgTestDb, type OrgTestDb } from './_org-test-db';
import { configureBlogPostPublication } from './blog-post-http-fixture';
// @ts-ignore -- the HTTP fixture's native bootstrap owns its synthetic constants.
import { PUBLICATION } from './blog-post-http-host.mjs';

const WS = 'blog-publication-setup';
let org: OrgTestDb;
let sql: postgres.Sql;
let userId: string;
let otherUserId: string;
let sourceId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  // Match the HTTP fixture exactly. org.adminSql restores raw JSONB serializers
  // and would hide the double encoding performed by an ordinary driver client.
  sql = postgres(org.adminDsn, { max: 1, onnotice: () => {} });
  const users = await org.adminSql`INSERT INTO harness_shared.users (username, display_name)
    VALUES ('blog-setup-owner', 'Blog owner'), ('blog-setup-other', 'Other owner') RETURNING id`;
  [userId, otherUserId] = users.map(row => row.id);
}, 180_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
  const source = await createOwnedExternalTriggerSource(org.adminSql, {
    workspaceId: WS, kind: 'hashnode', ownerUserId: userId, config: { preserved: 'existing setting' },
  });
  sourceId = source.id;
});

it('stores publication configuration as an object with the HTTP fixture raw driver', async () => {
  const [control] = await sql`SELECT jsonb_typeof(${JSON.stringify({ publicationId: PUBLICATION })}::jsonb) AS kind`;
  expect(control.kind).toBe('string');
  await configureBlogPostPublication(sql, { workspace: WS, sourceId, userId });
  const [stored] = await sql`SELECT config, jsonb_typeof(config) AS kind FROM harness_shared.data_sources WHERE id = ${sourceId}::uuid`;
  expect(stored.kind).toBe('object');
  expect(stored.config).toEqual({ preserved: 'existing setting', publicationId: PUBLICATION });
});

it.each(['workspace', 'owner'] as const)('refuses a mismatched %s without changing the source', async mismatch => {
  await expect(configureBlogPostPublication(sql, {
    workspace: mismatch === 'workspace' ? 'another-workspace' : WS,
    sourceId, userId: mismatch === 'owner' ? otherUserId : userId,
  })).rejects.toThrow('owned publication source required');
  const [stored] = await sql`SELECT config FROM harness_shared.data_sources WHERE id = ${sourceId}::uuid`;
  expect(stored.config).toEqual({ preserved: 'existing setting' });
});
