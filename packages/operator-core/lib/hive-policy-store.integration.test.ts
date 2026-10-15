import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { getHivePolicy, upsertHivePolicyRow } from './hive-policy-store';
let db: FreshPgDb;
beforeAll(async () => {
  db = await createFreshPgDb('policy-editor-cas');
  await db.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared;
    CREATE TABLE harness_shared.pot_policy (workspace_id text NOT NULL, harness_slug text NOT NULL, policy_json text NOT NULL,
      owner_pubkey text NOT NULL, signature text NOT NULL, policy_version integer NOT NULL, fed_hlc text,
      created_at bigint NOT NULL, updated_at bigint NOT NULL, PRIMARY KEY(workspace_id,harness_slug));`);
});
afterAll(async () => { if (db) await db.cleanup(); });
describe('policy editor persistence compare-and-swap', () => {
  it('allows exactly one concurrent author at a reviewed version, including first creation', async () => {
    const base = { workspaceId: 'fixture', potHomeSlug: 'home', ownerPubkey: 'test-key', signature: 'test-signature' };
    const create = await Promise.allSettled(['open', 'approval'].map(membership => upsertHivePolicyRow({ ...base, policyVersion: 1, expectedPolicyVersion: 0, policyJson: JSON.stringify({ membership }) }, db.sql)));
    expect(create.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const update = await Promise.allSettled(['allowlist', 'approval'].map(membership => upsertHivePolicyRow({ ...base, policyVersion: 2, expectedPolicyVersion: 1, policyJson: JSON.stringify({ membership }) }, db.sql)));
    expect(update.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    await expect(upsertHivePolicyRow({ ...base, policyVersion: 2, expectedPolicyVersion: 1, policyJson: '{}' }, db.sql)).rejects.toThrow('Policy changed');
    expect((await getHivePolicy('fixture', 'home', db.sql))?.policyVersion).toBe(2);
    await expect(upsertHivePolicyRow({ ...base, potHomeSlug: 'missing', policyVersion: 4, expectedPolicyVersion: 3, policyJson: '{}' }, db.sql)).rejects.toThrow('Policy changed');
  });
});
