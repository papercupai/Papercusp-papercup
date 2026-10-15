/**
 * plugin-enables-pg.integration.test.ts — the enabled-plugins PG mirror
 * (plugin_enables, baseline), against a real Postgres. The enabled-plugins.json
 * source is real fs under a temp dir (papercuspPath mocked there).
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - enabledAtEpochMs coerces the CLI's ISO-string `enabledAt` to the BIGINT
 *    epoch-ms the column wants — the EI-300 fix (a raw ISO string made every
 *    fresh-DB INSERT crash with `invalid input syntax for type bigint`);
 *  - mirrorHarness RECONCILES — plugins removed from the json are DELETEd (NOT IN),
 *    and an empty json clears the harness;
 *  - the (harness → plugins) and (plugin → harnesses) read groupings.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const WS = 'ws-pe';
const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, tmp: '' }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, withWorkspace: async (_ws: string, fn: (tx: postgres.Sql) => unknown) => fn(h.sql) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});
vi.mock('./papercusp-root', () => ({ papercuspPath: (...segs: string[]) => join(h.tmp, ...segs) }));

const { enabledAtEpochMs, mirrorHarness, listEnabledByHarness, harnessesByPlugin } = await import('./plugin-enables-pg');

let rootSql: postgres.Sql;

async function writeEnabled(harness: string, enabled: Record<string, { version?: string; enabledAt?: string; configHash?: string }>) {
  const dir = join(h.tmp, 'harnesses', harness);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'enabled-plugins.json'), JSON.stringify({ enabled }), 'utf8');
}

beforeAll(async () => {
  h.tmp = await mkdtemp(join(tmpdir(), 'pe-'));
  const adminUri = await getTestPg();
  const dbName = `pe_${randomBytes(5).toString('hex')}`;
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
  // FAITHFUL to baseline: enabled_at BIGINT (the EI-300 column), PK (harness_slug, plugin_slug).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.plugin_enables (
      harness_slug text NOT NULL,
      plugin_slug text NOT NULL,
      version text DEFAULT '' NOT NULL,
      config_hash text DEFAULT '' NOT NULL,
      enabled_at bigint DEFAULT 0 NOT NULL,
      updated_at timestamptz DEFAULT now() NOT NULL,
      workspace_id text NOT NULL,
      CONSTRAINT plugin_enables_pkey PRIMARY KEY (harness_slug, plugin_slug),
      CONSTRAINT plugin_enables_workspace_nonempty CHECK (workspace_id <> '')
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
  if (h.tmp) await rm(h.tmp, { recursive: true, force: true });
});

afterEach(async () => {
  await rootSql`TRUNCATE harness_shared.plugin_enables`;
});

describe('enabledAtEpochMs (pure, the EI-300 coercion)', () => {
  it('coerces ISO strings, numeric strings, and numbers to epoch ms; falls back for junk', () => {
    const iso = '2026-06-10T10:58:51.426Z';
    expect(enabledAtEpochMs(iso)).toBe(Date.parse(iso)); // the ISO shape the CLI actually writes
    expect(enabledAtEpochMs(1_716_000_000_000)).toBe(1_716_000_000_000);
    expect(enabledAtEpochMs('1716000000000')).toBe(1_716_000_000_000); // numeric string
    expect(enabledAtEpochMs('not a date')).toBeGreaterThan(1_700_000_000_000); // → Date.now() fallback
    expect(enabledAtEpochMs('')).toBeGreaterThan(1_700_000_000_000);
  });
});

describe('mirrorHarness (PG + fs)', () => {
  it('mirrors enabled plugins, writing the ISO enabledAt as BIGINT epoch-ms (EI-300)', async () => {
    const iso = '2026-06-10T10:58:51.426Z';
    await writeEnabled('web', {
      github: { version: '1.0', enabledAt: iso, configHash: 'h1' },
      linear: { version: '2.0', enabledAt: '1716000000000', configHash: 'h2' },
    });
    await mirrorHarness('web');
    const rows = await rootSql<{ plugin_slug: string; enabled_at: string; version: string }[]>`
      SELECT plugin_slug, enabled_at, version FROM harness_shared.plugin_enables WHERE harness_slug='web' ORDER BY plugin_slug`;
    expect(rows.map((r) => r.plugin_slug)).toEqual(['github', 'linear']);
    expect(Number(rows[0]!.enabled_at)).toBe(Date.parse(iso)); // ISO → bigint epoch-ms, no crash
    expect(Number(rows[1]!.enabled_at)).toBe(1_716_000_000_000);
  });

  it('reconciles: a plugin removed from the json is DELETEd on the next mirror', async () => {
    await writeEnabled('web', { github: { enabledAt: '1716000000000' }, linear: { enabledAt: '1716000000000' } });
    await mirrorHarness('web');
    await writeEnabled('web', { github: { enabledAt: '1716000000000' } }); // linear removed
    await mirrorHarness('web');
    const rows = await rootSql`SELECT plugin_slug FROM harness_shared.plugin_enables WHERE harness_slug='web'`;
    expect(rows.map((r) => r.plugin_slug)).toEqual(['github']); // linear reconciled away
  });

  it('an empty enabled set clears the harness', async () => {
    await writeEnabled('web', { github: { enabledAt: '1716000000000' } });
    await mirrorHarness('web');
    await writeEnabled('web', {});
    await mirrorHarness('web');
    expect(await rootSql`SELECT 1 FROM harness_shared.plugin_enables WHERE harness_slug='web'`).toHaveLength(0);
  });
});

describe('read groupings (PG)', () => {
  it('listEnabledByHarness groups harness → plugin slugs; harnessesByPlugin reverses it', async () => {
    await writeEnabled('web', { github: { enabledAt: '1' }, linear: { enabledAt: '1' } });
    await writeEnabled('api', { github: { enabledAt: '1' } });
    await mirrorHarness('web');
    await mirrorHarness('api');
    expect(await listEnabledByHarness()).toEqual({ web: ['github', 'linear'], api: ['github'] });
    expect((await harnessesByPlugin('github')).sort()).toEqual(['api', 'web']);
    expect(await harnessesByPlugin('linear')).toEqual(['web']);
  });
});
