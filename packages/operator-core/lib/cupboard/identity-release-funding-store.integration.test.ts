import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { bindIdentityReleaseFundingChannel, bindReleaseFundingChannel, readIdentityReleaseFunding,
  readReleaseFunding, recordIdentityReleasePricing } from './identity-release-funding-store';

let db: FreshPgDb;
const identity = 'identity-release:acme/reviewer@1';
const tool = 'plugin:acme/tool@2';
const migration = resolve('..', '..', 'libs/papercusp/libs/db/sql/1428-cupboard-tool-funding-bindings.sql');
const binding = (skuRef: string, workspaceId = 'ws-1', channelId = 'channel-1') =>
  ({ workspaceId, skuRef, channelId, source: 'per-use-checkout' as const, boundBy: 'gh:1' });

beforeAll(async () => {
  db = await createFreshPgDb();
  await applyMigrationForTest(db.sql, resolve('..', '..', 'libs/papercusp/libs/db/sql/1270-identity-funding-bindings.sql'));
  await bindIdentityReleaseFundingChannel(db.sql, binding(identity));
  await recordIdentityReleasePricing(db.sql, 'ws-1', identity, { kind: 'free' });
  await applyMigrationForTest(db.sql, existsSync(migration) ? migration : migration + '.DRAFT');
});
afterAll(async () => { await db?.cleanup(); });

describe('workspace/SKU funding routes (real migration and store)', () => {
  it('preserves existing identity pricing and channel through the extension', async () => {
    expect((await readIdentityReleaseFunding(db.sql, 'ws-1', [identity])).get(identity))
      .toMatchObject({ skuRef: identity, channelId: 'channel-1', pricingState: 'free' });
  });

  it('stores a tool route without pricing or funds evidence and isolates workspace and SKU', async () => {
    await bindReleaseFundingChannel(db.sql, binding(tool));
    await bindReleaseFundingChannel(db.sql, binding(tool, 'ws-2', 'channel-2'));
    expect((await readReleaseFunding(db.sql, 'ws-1', [tool])).get(tool)).toEqual({
      skuRef: tool, channelId: 'channel-1', pricingState: null, pricingOfferId: null,
      pricingUnitMicros: null, pricingCheckedAtMs: null,
    });
    expect((await readReleaseFunding(db.sql, 'ws-2', [tool])).get(tool)?.channelId).toBe('channel-2');
    expect(await readReleaseFunding(db.sql, 'ws-3', [tool])).toEqual(new Map());
    expect(await readReleaseFunding(db.sql, 'ws-1', ['plugin:acme/other@2'])).toEqual(new Map());
    expect(await readIdentityReleaseFunding(db.sql, 'ws-1', [tool])).toEqual(new Map());
  });

  it('rebinds the exact tool SKU without modifying another workspace or identity', async () => {
    await bindReleaseFundingChannel(db.sql, binding(tool, 'ws-1', 'channel-3'));
    expect((await readReleaseFunding(db.sql, 'ws-1', [tool])).get(tool)?.channelId).toBe('channel-3');
    expect((await readReleaseFunding(db.sql, 'ws-2', [tool])).get(tool)?.channelId).toBe('channel-2');
    expect((await readIdentityReleaseFunding(db.sql, 'ws-1', [identity])).get(identity)?.channelId).toBe('channel-1');
  });

  it('keeps identity writer and pricing cache unavailable to tool SKUs', async () => {
    await expect(bindIdentityReleaseFundingChannel(db.sql, binding(tool))).rejects.toThrow('not an identity release');
    await expect(recordIdentityReleasePricing(db.sql, 'ws-1', tool, { kind: 'free' })).rejects.toThrow('not an identity release');
    await expect(db.sql`UPDATE harness_shared.identity_release_funding
      SET pricing_state = 'free', pricing_checked_at = now()
      WHERE workspace_id = 'ws-1' AND sku_ref = ${tool}`)
      .rejects.toMatchObject({ code: '23514', constraint_name: 'identity_release_funding_identity_pricing_check' });
  });

  it.each(['', ' ', ' sku', 'sku ', 'sku\n1', 'x'.repeat(301)])('refuses malformed SKU %j in the store and SQL constraint', async (skuRef) => {
    await expect(bindReleaseFundingChannel(db.sql, binding(skuRef))).rejects.toThrow('exact bounded skuRef');
    await expect(db.sql`INSERT INTO harness_shared.identity_release_funding (workspace_id, sku_ref)
      VALUES ('ws-bad', ${skuRef})`).rejects.toMatchObject({ code: '23514' });
  });

  it('preserves the original identity prefix validator and migration idempotence', async () => {
    const legacy = 'identity-release:' + 'x'.repeat(301);
    await bindIdentityReleaseFundingChannel(db.sql, binding(legacy));
    await applyMigrationForTest(db.sql, existsSync(migration) ? migration : migration + '.DRAFT');
    expect((await readIdentityReleaseFunding(db.sql, 'ws-1', [legacy])).get(legacy)?.channelId).toBe('channel-1');
  });
});
