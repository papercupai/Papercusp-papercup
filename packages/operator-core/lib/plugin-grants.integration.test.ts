/**
 * plugin-grants.integration.test.ts — the plugin capability-grant store against a
 * real Postgres. Scoped narrowly to grant mechanics (the unique-to-plugins
 * surface that doesn't require WASM scaffolding); install/enable/disable
 * lifecycle E2E is deferred per
 * apps/operator/docs/plans/deferred-followups-2026-05-14.md.
 *
 * INTEGRATION tier (EI-16087 family). Its predecessor `lib/plugin-grants.test.ts`
 * already called itself an integration test but sat in the UNIT layer, where it
 * verified writes with its OWN client from `pgClientFields()` (embedded pg,
 * 127.0.0.1:18532) while the code under test wrote through `getOrgPg()` (native
 * pg, 127.0.0.1:5432 — setup-hermetic-env.ts pins discovery off). Both DBs are
 * named `papercusp`, so the split was invisible; the write landed on a server the
 * assertions never read. It also soft-skipped (`itPg` returned early) when PG was
 * unreachable, so the file could silently pass as a no-op.
 *
 * Here the DB is a throwaway container owned solely by this file, and the code
 * under test writes through the SAME connection the assertions read (the
 * `vi.mock('@papercusp/db-org')` below), so the two cannot drift apart. Plain
 * `it()` means an unreachable DB fails loudly.
 *
 * NOTE: the EI-13994 comment on the old afterEach — scope cleanup to this run's
 * randomized TEST_PLUGIN because the suite shares a live PG with the whole fleet
 * — no longer applies here (the container is private to this file). The scoping
 * is kept anyway: it is free, and correct regardless of isolation.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { getGrantsForPluginInHarness, grantCapabilities, revokeCapabilities } = await import(
  './plugin-grants'
);

const TEST_PLUGIN = `vitest-plugin-${randomBytes(3).toString('hex')}`;
const TEST_HARNESS = `vitest-harness-${randomBytes(3).toString('hex')}`;
const TEST_VERSION = '0.0.1';

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `pgr_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 2, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to baseline. The composite PRIMARY KEY is load-bearing: it is what
  // makes grantCapabilities' `ON CONFLICT DO NOTHING` idempotent, which the
  // re-grant test below pins.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.plugin_capability_grants (
      plugin_name text NOT NULL,
      plugin_version text NOT NULL,
      harness_slug text NOT NULL,
      capability text NOT NULL,
      granted_at timestamptz NOT NULL DEFAULT now(),
      granted_by text,
      reason text,
      PRIMARY KEY (plugin_name, plugin_version, harness_slug, capability)
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

afterEach(async () => {
  await rootSql`DELETE FROM harness_shared.plugin_capability_grants WHERE plugin_name = ${TEST_PLUGIN}`;
});

describe('plugin capability grants', () => {
  it('returns empty when no grants exist', async () => {
    const grants = await getGrantsForPluginInHarness(TEST_PLUGIN, TEST_VERSION, TEST_HARNESS, {
      skipLegacy: true,
    });
    expect(grants).toEqual([]);
  });

  it('grantCapabilities persists then getGrantsForPluginInHarness returns them', async () => {
    await grantCapabilities({
      pluginName: TEST_PLUGIN,
      pluginVersion: TEST_VERSION,
      harnessSlug: TEST_HARNESS,
      capabilities: ['system:read', 'fs:list'],
      grantedBy: 'vitest',
    });
    const grants = await getGrantsForPluginInHarness(TEST_PLUGIN, TEST_VERSION, TEST_HARNESS, {
      skipLegacy: true,
    });
    expect(grants.sort()).toEqual(['fs:list', 'system:read']);
  });

  it('global ("") harness grants apply across all harnesses', async () => {
    await grantCapabilities({
      pluginName: TEST_PLUGIN,
      pluginVersion: TEST_VERSION,
      harnessSlug: '',
      capabilities: ['log:write'],
      grantedBy: 'vitest',
    });
    // Query for a SPECIFIC harness — should still include the global grant.
    const grants = await getGrantsForPluginInHarness(
      TEST_PLUGIN,
      TEST_VERSION,
      'random-harness-name',
      { skipLegacy: true },
    );
    expect(grants).toContain('log:write');
  });

  it('grants scoped to one harness do not leak to another', async () => {
    await grantCapabilities({
      pluginName: TEST_PLUGIN,
      pluginVersion: TEST_VERSION,
      harnessSlug: 'harness-A',
      capabilities: ['secret:read'],
    });
    const inA = await getGrantsForPluginInHarness(TEST_PLUGIN, TEST_VERSION, 'harness-A', {
      skipLegacy: true,
    });
    const inB = await getGrantsForPluginInHarness(TEST_PLUGIN, TEST_VERSION, 'harness-B', {
      skipLegacy: true,
    });
    expect(inA).toContain('secret:read');
    expect(inB).not.toContain('secret:read');
  });

  it('grants are version-pinned: a different version sees an empty grant set', async () => {
    await grantCapabilities({
      pluginName: TEST_PLUGIN,
      pluginVersion: TEST_VERSION,
      harnessSlug: TEST_HARNESS,
      capabilities: ['cap:a'],
    });
    const v2Grants = await getGrantsForPluginInHarness(TEST_PLUGIN, '99.99.99', TEST_HARNESS, {
      skipLegacy: true,
    });
    expect(v2Grants).not.toContain('cap:a');
  });

  it('revokeCapabilities removes the grant', async () => {
    await grantCapabilities({
      pluginName: TEST_PLUGIN,
      pluginVersion: TEST_VERSION,
      harnessSlug: TEST_HARNESS,
      capabilities: ['cap:x', 'cap:y'],
    });
    await revokeCapabilities({
      pluginName: TEST_PLUGIN,
      pluginVersion: TEST_VERSION,
      harnessSlug: TEST_HARNESS,
      capabilities: ['cap:x'],
    });
    const grants = await getGrantsForPluginInHarness(TEST_PLUGIN, TEST_VERSION, TEST_HARNESS, {
      skipLegacy: true,
    });
    expect(grants).not.toContain('cap:x');
    expect(grants).toContain('cap:y');
  });

  it('re-granting an existing tuple is idempotent (no error)', async () => {
    await grantCapabilities({
      pluginName: TEST_PLUGIN,
      pluginVersion: TEST_VERSION,
      harnessSlug: TEST_HARNESS,
      capabilities: ['cap:z'],
    });
    // Re-grant the same tuple — ON CONFLICT DO NOTHING makes it a silent no-op.
    await expect(
      grantCapabilities({
        pluginName: TEST_PLUGIN,
        pluginVersion: TEST_VERSION,
        harnessSlug: TEST_HARNESS,
        capabilities: ['cap:z'],
      }),
    ).resolves.toBeUndefined();
    const grants = await getGrantsForPluginInHarness(TEST_PLUGIN, TEST_VERSION, TEST_HARNESS, {
      skipLegacy: true,
    });
    expect(grants).toEqual(['cap:z']);
  });
});
