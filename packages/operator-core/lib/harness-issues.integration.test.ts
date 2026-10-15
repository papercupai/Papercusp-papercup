/**
 * harness-issues.integration.test.ts
 *
 * engineer-issues-2026-06-03 Phase 3 — PG is the issues store-of-record.
 *
 * Proves, against a real Postgres (testcontainer) with migration 130 applied:
 *   1. saveIssues → loadIssuesFromPg round-trips the curated set through the
 *      per-harness `harness_issues` VIEW into `harness_issues_consolidated`.
 *   2. The migration-130 CHECK is real — a raw non-canonical severity is rejected.
 *   3. The write-path CLAMP (clampSeverity/clampStatus) normalizes a non-canonical
 *      finding so saveIssues SUCCEEDS (the row is kept, normalized — not dropped).
 *   4. saveIssues with a shrunk set deletes the rows no longer present.
 *   5. loadIssuesOrSeed returns the PG rows.
 *
 * Mirrors the testcontainer setup of harness-plan-status-grants.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import type { ProjectEntry } from './harness-registry';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
// Strip psql metacommands (\set, …) exactly like the migration runner so the
// real 130 file applies via postgres-js .simple().
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line))
    .join('\n');

const SLUG = 'sheets';
const SCHEMA = `harness_${SLUG}`;
const PROJECT = { slug: SLUG, path: '/tmp/__nonexistent_harness__' } as unknown as ProjectEntry;

// Holder so the hoisted vi.mock factory can reach the per-test connection
// assigned in beforeAll without a TDZ error.
const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getHarnessPg: () => ({ sql: h.sql }) };
});

// Imported AFTER the mock is registered (vi.mock is hoisted).
const { saveIssues, loadIssuesFromPg, loadIssuesOrSeed } = await import('./harness-issues');

const CONSOLIDATED_DDL = `
  CREATE TABLE harness_shared.harness_issues_consolidated (
    harness_slug text NOT NULL, issue_id text NOT NULL, title text NOT NULL,
    severity text NOT NULL, source text NOT NULL, status text NOT NULL,
    found_at timestamptz NOT NULL, found_during text, repro text, evidence text,
    suggested_fix text, code_pointer text, linked_feature_id text,
    attempts bigint NOT NULL DEFAULT 0, notes jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_ts bigint NOT NULL, updated_ts bigint NOT NULL,
    author_pubkey text, origin text NOT NULL DEFAULT 'local',
    workspace_id text NOT NULL DEFAULT '',
    PRIMARY KEY (harness_slug, issue_id)
  );
  CREATE TABLE harness_shared.harness_pending_issues (
    harness_slug text NOT NULL, phase text NOT NULL DEFAULT 'staging',
    issue_id text NOT NULL, feature_id text, title text NOT NULL DEFAULT '',
    severity text NOT NULL DEFAULT 'normal', source text NOT NULL DEFAULT '',
    payload jsonb NOT NULL, ts bigint NOT NULL DEFAULT 0, mtime_ms bigint NOT NULL DEFAULT 0,
    workspace_id text NOT NULL DEFAULT '',
    PRIMARY KEY (harness_slug, phase, issue_id)
  );
`;

let rootSql: postgres.Sql;
let dbName: string;

beforeAll(async () => {
  const adminUri = await getTestPg();
  dbName = `hi_${randomBytes(5).toString('hex')}`;
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
  await rootSql.unsafe(`CREATE SCHEMA ${SCHEMA}`);
  await rootSql.unsafe(CONSOLIDATED_DDL).simple();
  // The real migration: adds the canonical severity/status/source CHECKs.
  await rootSql.unsafe(readMigration('130-harness-issues-enums-canonical.sql')).simple();
  // The per-harness slug-keyed VIEW the operator writes through (scaffold-harness-schema.ts).
  await rootSql.unsafe(
    `CREATE VIEW ${SCHEMA}.harness_issues AS
       SELECT * FROM harness_shared.harness_issues_consolidated WHERE harness_slug = '${SLUG}'
       WITH CHECK OPTION`,
  );

  // The connection saveIssues/loadIssuesFromPg use (search_path resolves the VIEW).
  h.sql = postgres(u.toString(), {
    max: 1,
    onnotice: () => {},
    connection: { search_path: `${SCHEMA}, harness_shared, public` },
  });
}, 90_000);

afterAll(async () => {
  await h.sql?.end({ timeout: 5 });
  await rootSql?.end({ timeout: 5 });
});

const issue = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'I-0001',
  title: 'something broke',
  severity: 'major',
  source: 'validator',
  foundAt: '2026-06-04T00:00:00.000Z',
  status: 'open',
  attempts: 0,
  notes: [],
  ...over,
}) as unknown as Parameters<typeof saveIssues>[1]['issues'][number];

describe('issues PG store-of-record (Phase 3)', () => {
  it('round-trips saveIssues → loadIssuesFromPg through the consolidated VIEW', async () => {
    await saveIssues(PROJECT, {
      issues: [
        issue({ id: 'I-0001', title: 'first', severity: 'major', status: 'open' }),
        issue({ id: 'I-0002', title: 'second', severity: 'nit', status: 'closed', notes: [{ ts: 't', by: 'me', text: 'n' }] }),
      ],
      nextId: 3,
    });
    const loaded = await loadIssuesFromPg(PROJECT);
    expect(loaded).toHaveLength(2);
    const byId = Object.fromEntries(loaded.map((i) => [i.id, i]));
    expect(byId['I-0001'].title).toBe('first');
    expect(byId['I-0002'].severity).toBe('nit');
    expect(byId['I-0002'].notes).toEqual([{ ts: 't', by: 'me', text: 'n' }]);
  });

  it('the migration-130 CHECK rejects a raw non-canonical severity', async () => {
    await expect(
      rootSql`INSERT INTO ${rootSql.unsafe(SCHEMA)}.harness_issues
                (harness_slug, issue_id, title, severity, source, status, found_at, created_ts, updated_ts)
              VALUES (${SLUG}, 'I-RAW', 't', 'info', 'validator', 'open', now(), 0, 0)`,
    ).rejects.toThrow(/harness_issues_consolidated_severity_check|check constraint/i);
  });

  it('the write-path clamp keeps a non-canonical finding (normalized, not dropped)', async () => {
    // A validator finding with drift values that would violate the CHECK raw.
    await saveIssues(PROJECT, {
      issues: [issue({ id: 'I-DRIFT', severity: 'info', status: 'resolved' })],
      nextId: 2,
    });
    const loaded = await loadIssuesFromPg(PROJECT);
    const drift = loaded.find((i) => i.id === 'I-DRIFT');
    expect(drift).toBeDefined();
    expect(drift!.severity).toBe('nit'); // info → nit (clampSeverity)
    expect(drift!.status).toBe('closed'); // resolved → closed (clampStatus)
  });

  it('saveIssues deletes rows no longer in the set', async () => {
    await saveIssues(PROJECT, {
      issues: [issue({ id: 'I-A' }), issue({ id: 'I-B' })],
      nextId: 3,
    });
    await saveIssues(PROJECT, { issues: [issue({ id: 'I-A' })], nextId: 2 });
    const loaded = await loadIssuesFromPg(PROJECT);
    expect(loaded.map((i) => i.id).sort()).toEqual(['I-A']);
  });

  it('loadIssuesOrSeed returns the PG rows', async () => {
    await saveIssues(PROJECT, { issues: [issue({ id: 'I-SEED', title: 'live' })], nextId: 2 });
    const file = await loadIssuesOrSeed(PROJECT);
    expect(file.issues.map((i) => i.id)).toEqual(['I-SEED']);
    expect(file.nextId).toBe(1); // no numeric I-NNNN ids → allocator starts at 1
  });
});
