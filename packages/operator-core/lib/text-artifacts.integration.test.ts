/**
 * text-artifacts.integration.test.ts — the PG-canonical text-artifact store
 * (migration 035, drizzle), against a real Postgres. The disk mirror + sync are
 * seams (mocked); the SQL is real.
 *
 * Behaviors a fake-db unit test can't prove:
 *  - save→load round-trip + the `.papercusp/` rel_path normalization (a prefixed
 *    and a bare path hit the SAME row);
 *  - the (harness_slug, rel_path) upsert;
 *  - appendTextArtifact's ATOMIC PG-side `content || EXCLUDED.content` concat;
 *  - the EI-280 `adoptBlankWorkspace` guard: a save adopts the active workspace
 *    onto a BLANK-stamped legacy row, but never RE-HOMES a properly-stamped one;
 *  - delete.
 *
 * Reuses the drizzle harness from toast-log-data: `generated` stays real, a
 * drizzle(rootSql) db is injected.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const WS = 'ws-art';
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ db: h.db }) };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) };
});
vi.mock('./harness-registry', () => ({ loadHarnessRegistry: async () => ({ projects: [] }) }));
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const { loadTextArtifact, saveTextArtifact, appendTextArtifact, deleteTextArtifact } = await import('./text-artifacts');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `art_${randomBytes(5).toString('hex')}`;
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
  // FAITHFUL to baseline: updated_at bigint, workspace_id NOT NULL default '', PK (harness_slug, rel_path).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.harness_text_artifacts (
      harness_slug text NOT NULL,
      rel_path text NOT NULL,
      content text DEFAULT '' NOT NULL,
      updated_at bigint DEFAULT 0 NOT NULL,
      workspace_id text DEFAULT '' NOT NULL,
      CONSTRAINT harness_text_artifacts_pkey PRIMARY KEY (harness_slug, rel_path)
    )`);
  h.db = drizzle(rootSql);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.harness_text_artifacts`;
});

const wsOf = async (slug: string, key: string) =>
  (await rootSql<{ workspace_id: string }[]>`SELECT workspace_id FROM harness_shared.harness_text_artifacts WHERE harness_slug=${slug} AND rel_path=${key}`)[0]?.workspace_id;

describe('text-artifacts (drizzle, PG)', () => {
  it('save → load round-trips, null when absent', async () => {
    expect(await loadTextArtifact('web', 'notes.md')).toBeNull();
    await saveTextArtifact('web', 'notes.md', 'hello');
    expect(await loadTextArtifact('web', 'notes.md')).toBe('hello');
  });

  it('normalizes the `.papercusp/` prefix — a prefixed write and a bare read hit the same row', async () => {
    await saveTextArtifact('web', '.papercusp/memory/a.md', 'X');
    expect(await loadTextArtifact('web', 'memory/a.md')).toBe('X'); // bare read
    expect(await loadTextArtifact('web', '.papercusp/memory/a.md')).toBe('X'); // prefixed read, same row
    expect(await rootSql`SELECT 1 FROM harness_shared.harness_text_artifacts WHERE harness_slug='web'`).toHaveLength(1);
  });

  it('save upserts on (harness_slug, rel_path) — second write overwrites, one row', async () => {
    await saveTextArtifact('web', 'f.md', 'v1');
    await saveTextArtifact('web', 'f.md', 'v2');
    expect(await loadTextArtifact('web', 'f.md')).toBe('v2');
    expect(await rootSql`SELECT 1 FROM harness_shared.harness_text_artifacts WHERE harness_slug='web' AND rel_path='f.md'`).toHaveLength(1);
  });

  it('append ATOMICALLY concatenates via PG `content || EXCLUDED.content`', async () => {
    await appendTextArtifact('web', 'log.md', 'A'); // insert
    await appendTextArtifact('web', 'log.md', 'B'); // concat
    await appendTextArtifact('web', 'log.md', 'C');
    expect(await loadTextArtifact('web', 'log.md')).toBe('ABC');
  });

  it('delete removes the row', async () => {
    await saveTextArtifact('web', 'gone.md', 'x');
    await deleteTextArtifact('web', 'gone.md');
    expect(await loadTextArtifact('web', 'gone.md')).toBeNull();
  });

  it('EI-280: a save ADOPTS the active workspace onto a blank-stamped row, but does NOT re-home a stamped one', async () => {
    // blank legacy row → adopted
    await rootSql`INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, updated_at, workspace_id) VALUES ('web','blank.md','old',1,'')`;
    await saveTextArtifact('web', 'blank.md', 'new');
    expect(await wsOf('web', 'blank.md')).toBe(WS); // adopted the operator workspace

    // properly-stamped row → left alone
    await rootSql`INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, updated_at, workspace_id) VALUES ('web','owned.md','old',1,'other-ws')`;
    await saveTextArtifact('web', 'owned.md', 'new');
    expect(await wsOf('web', 'owned.md')).toBe('other-ws'); // NOT re-homed to WS
  });
});
