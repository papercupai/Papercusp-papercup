/**
 * plugin-configs-pg.integration.test.ts — the plugin-config PG mirror with
 * pgcrypto encryption-at-rest (migration 039 / baseline), against a real Postgres.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - ENCRYPTION ROUND-TRIP: mirrorPluginConfig pgp_sym_encrypts the JSON into
 *    config_ct; loadPluginConfig pgp_sym_decrypts it back. Needs the real pgcrypto.
 *  - ENCRYPTION-AT-REST: the legacy plaintext `config` column is NEVER written the
 *    payload (the whole point of 039) — ciphertext lives only in config_ct.
 *  - The (harness_slug, plugin_slug) upsert + delete.
 *
 * The table is built FAITHFUL to the generated baseline (config NOT NULL DEFAULT
 * '{}', updated_at bigint) — so the helper's writes are checked against the
 * constraints the shipped product actually deploys.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const WS = 'ws-plugins';
const KEY = 'test-encryption-key-0123456789';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, withWorkspace: async (_ws: string, fn: (tx: postgres.Sql) => unknown) => fn(h.sql) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});
vi.mock('./db-encryption', () => ({ getDbEncryptionKey: () => KEY }));

const { mirrorPluginConfig, loadPluginConfig, deletePluginConfig } = await import('./plugin-configs-pg');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `pcfg_${randomBytes(5).toString('hex')}`;
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
  await rootSql.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to 000-baseline.sql: config NOT NULL DEFAULT '{}', updated_at bigint.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.plugin_configs (
      harness_slug text NOT NULL,
      plugin_slug text NOT NULL,
      config jsonb DEFAULT '{}'::jsonb NOT NULL,
      updated_at bigint DEFAULT 0 NOT NULL,
      workspace_id text NOT NULL,
      config_ct bytea,
      CONSTRAINT plugin_configs_pkey PRIMARY KEY (harness_slug, plugin_slug),
      CONSTRAINT plugin_configs_workspace_nonempty CHECK (workspace_id <> '')
    )
  `);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

describe('plugin-configs PG mirror (encryption-at-rest)', () => {
  it('loadPluginConfig is null when no row exists', async () => {
    expect(await loadPluginConfig('web', 'github')).toBeNull();
  });

  it('mirror → load round-trips the JSON through pgcrypto encryption', async () => {
    await mirrorPluginConfig('web', 'github', { token: 'ghp_secret', scopes: ['repo', 'read'] });
    expect(await loadPluginConfig('web', 'github')).toEqual({ token: 'ghp_secret', scopes: ['repo', 'read'] });
  });

  it('encryption-at-rest: the payload lives ONLY in config_ct ciphertext, never the plaintext config column', async () => {
    const raw = await rootSql<{ config: unknown; ct: Buffer | null }[]>`
      SELECT config, config_ct AS ct FROM harness_shared.plugin_configs
       WHERE harness_slug = 'web' AND plugin_slug = 'github'`;
    expect(raw[0]!.config).toEqual({}); // legacy plaintext column left at its '{}' default — never the payload
    expect(JSON.stringify(raw[0]!.config)).not.toContain('ghp_secret'); // no plaintext secret at rest
    expect(raw[0]!.ct).toBeInstanceOf(Buffer); // ciphertext present
    expect(raw[0]!.ct!.toString('utf8')).not.toContain('ghp_secret'); // and it really is encrypted
  });

  it('mirror upserts on (harness, plugin) — a second write replaces the config', async () => {
    await mirrorPluginConfig('web', 'github', { token: 'rotated' });
    expect(await loadPluginConfig('web', 'github')).toEqual({ token: 'rotated' });
    const n = await rootSql`SELECT count(*)::int AS c FROM harness_shared.plugin_configs WHERE harness_slug='web' AND plugin_slug='github'`;
    expect(n[0]!.c).toBe(1); // upsert, not a duplicate
  });

  it('deletePluginConfig drops the row', async () => {
    await deletePluginConfig('web', 'github');
    expect(await loadPluginConfig('web', 'github')).toBeNull();
  });
});
