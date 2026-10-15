/**
 * harness-project-files.integration.test.ts — the per-harness SPEC/AGENTS/
 * contract/config store (migration 034), against a real Postgres (testcontainer).
 *
 * The behavior that needs real PG (a fake-sql unit test can't reach it): the
 * optimistic-concurrency control. saveProjectFiles with `expectedVersion` does a
 * version-guarded UPDATE and throws ProjectFilesVersionConflict when the row
 * moved on — plus the no-OCC upsert that COALESCE-preserves omitted fields and
 * bumps `version`. Mirrors autoloop-state.integration.test.ts's harness.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { drizzle } from 'drizzle-orm/postgres-js';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql,
  workspace: 'project-files-test-workspace', registered: new Map<string, string[]>() }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql, db: drizzle(h.sql) }) };
});
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => h.workspace }));
vi.mock('./harness-registry', () => ({ loadHarnessRegistry: async (workspace: string) => ({
  projects: (h.registered.get(workspace) ?? []).map(slug => ({ slug })),
}) }));

const { loadProjectFiles, saveProjectFiles, ProjectFilesVersionConflict } = await import('./harness-project-files');

const SLUG = 'web';
let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `hpf_${randomBytes(5).toString('hex')}`;
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
  // Include the current migration's workspace column: omitting it concealed
  // writes that a scoped Settings sync query could never read.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.harness_project_files (
      harness_slug text PRIMARY KEY,
      spec text,
      agents text,
      contract text,
      config text,
      workspace_id text NOT NULL DEFAULT '',
      updated_at bigint NOT NULL,
      version integer NOT NULL DEFAULT 0
    )
  `);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

describe('harness-project-files store (PG)', () => {
  it('loadProjectFiles returns the empty default for an unknown harness', async () => {
    expect(await loadProjectFiles('nobody')).toEqual({
      spec: null, agents: null, contract: null, config: null, version: 0,
    });
  });

  it('saveProjectFiles (no OCC) inserts at version 1 and reads back', async () => {
    expect(await saveProjectFiles(SLUG, { spec: 'S1', agents: 'A1' })).toEqual({ version: 1 });
    expect(await loadProjectFiles(SLUG)).toMatchObject({ spec: 'S1', agents: 'A1', contract: null, config: null, version: 1 });
  });

  it('saveProjectFiles (no OCC) upserts: bumps version + COALESCE preserves omitted fields', async () => {
    expect(await saveProjectFiles(SLUG, { contract: 'C1' })).toEqual({ version: 2 }); // only contract
    expect(await loadProjectFiles(SLUG)).toMatchObject({ spec: 'S1', agents: 'A1', contract: 'C1', version: 2 });
  });

  it('OCC: a matching expectedVersion updates and bumps the version', async () => {
    expect(await saveProjectFiles(SLUG, { config: 'cfg' }, { expectedVersion: 2 })).toEqual({ version: 3 });
    expect(await loadProjectFiles(SLUG)).toMatchObject({ config: 'cfg', version: 3 });
    const [stored] = await h.sql`SELECT workspace_id FROM harness_shared.harness_project_files WHERE harness_slug = ${SLUG}`;
    expect(stored.workspace_id).toBe(h.workspace);
  });

  it('OCC: a STALE expectedVersion throws ProjectFilesVersionConflict (carrying the current version) and does NOT apply', async () => {
    let err: unknown;
    try {
      await saveProjectFiles(SLUG, { spec: 'STALE-WRITE' }, { expectedVersion: 1 }); // current is 3
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProjectFilesVersionConflict);
    expect((err as InstanceType<typeof ProjectFilesVersionConflict>).currentVersion).toBe(3);
    expect((await loadProjectFiles(SLUG)).spec).toBe('S1'); // the stale write was rejected
  });

  it('OCC: expectedVersion 0 on a brand-new harness inserts at version 1', async () => {
    expect(await saveProjectFiles('fresh-slug', { spec: 'NEW' }, { expectedVersion: 0 })).toEqual({ version: 1 });
    expect(await loadProjectFiles('fresh-slug')).toMatchObject({ spec: 'NEW', version: 1 });
    const [stored] = await h.sql`SELECT workspace_id FROM harness_shared.harness_project_files WHERE harness_slug = 'fresh-slug'`;
    expect(stored.workspace_id).toBe(h.workspace);
  });

  it('new writes are visible to the selected workspace Settings query and exclude its neighbor', async () => {
    const slug = 'scoped-new';
    const config = JSON.stringify({ marker: 'keep-me', parity: { enabled: false } });
    await saveProjectFiles(slug, { config });
    const { resolveNamedQueryV2 } = await import('./sync-resolver');
    const rows = await resolveNamedQueryV2('harnessProjectFiles.byHarness', { harnessSlug: slug, workspaceId: h.workspace }) as Array<{ config: string }>;
    expect(rows.map(row => row.config)).toEqual([config]);
    expect(await resolveNamedQueryV2('harnessProjectFiles.byHarness', { harnessSlug: slug, workspaceId: 'neighbor-workspace' })).toEqual([]);
  });

  it('an explicit workspace stamps the writer without following the process workspace', async () => {
    const slug = 'explicit-workspace';
    await saveProjectFiles(slug, { config: '{}' }, { workspaceId: 'foreign-workspace' });
    const { resolveNamedQueryV2 } = await import('./sync-resolver');
    expect(await resolveNamedQueryV2('harnessProjectFiles.byHarness', { harnessSlug: slug, workspaceId: h.workspace })).toEqual([]);
    expect(await resolveNamedQueryV2('harnessProjectFiles.byHarness', { harnessSlug: slug, workspaceId: 'foreign-workspace' })).toMatchObject([{ config: '{}' }]);
  });

  it('legacy unscoped config is readable only through its registered workspace', async () => {
    const slug = 'legacy-config';
    const config = JSON.stringify({ marker: 'legacy-preserved', parity: { enabled: false } });
    await h.sql`INSERT INTO harness_shared.harness_project_files (harness_slug, config, updated_at)
      VALUES (${slug}, ${config}, ${Date.now()})`;
    h.registered.set(h.workspace, [slug]);
    const { resolveNamedQueryV2 } = await import('./sync-resolver');
    const rows = await resolveNamedQueryV2('harnessProjectFiles.byHarness', { harnessSlug: slug, workspaceId: h.workspace }) as Array<{ config: string }>;
    expect(rows.map(row => row.config)).toEqual([config]);
    expect(await resolveNamedQueryV2('harnessProjectFiles.byHarness', { harnessSlug: slug, workspaceId: 'neighbor-workspace' })).toEqual([]);
    // Updating an old row must stamp the same ownership as a fresh write.
    await saveProjectFiles(slug, { config });
    const [stored] = await h.sql`SELECT workspace_id FROM harness_shared.harness_project_files WHERE harness_slug = ${slug}`;
    expect(stored.workspace_id).toBe(h.workspace);
  });
});
