/** EI-25900400373431567: execute the real recent-item query against epoch-ms PG rows. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const holder = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: holder.sql }),
}));
vi.mock('../../issues-engineer', () => ({ issuesScopeWorkspace: () => 'issues-workspace' }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'active-workspace' }));

import { __queryRecentOpenItemsForTest } from './recent-lexical-dupe-guard';

let db: FreshPgDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshPgDb('recent-dupe-epoch-ms');
  sql = holder.sql = db.sql;
  // These are the actual reader/writer column types; no mock SQL parser can
  // detect the bigint >= timestamptz error this fixture prevents.
  await sql`CREATE TABLE harness_shared.work_items (
    workspace_id text NOT NULL, harness_slug text NOT NULL, feature_id text NOT NULL,
    title text, summary text, status text, embedding bytea,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    lane text GENERATED ALWAYS AS (payload ->> 'lane') STORED,
    created_ts bigint NOT NULL DEFAULT ((extract(epoch FROM now()) * 1000)::bigint),
    PRIMARY KEY (workspace_id, harness_slug, feature_id)
  )`;
}, 60_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { holder.sql = sql; await sql`TRUNCATE harness_shared.work_items`; });

describe('recent lexical dedup epoch-ms store query', () => {
  it('includes the exact cutoff and fresh unembedded rows, excluding old, terminal and foreign rows', async () => {
    await sql.begin(async tx => {
      holder.sql = tx as unknown as postgres.Sql;
      try {
        await tx`INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, title, status, created_ts)
          SELECT workspace, harness, id, id, status,
            (extract(epoch FROM (now() - interval '10 minutes')) * 1000)::bigint + delta_ms
          FROM (VALUES
            ('active-workspace', 'papercusp', 'WI-cutoff', 'open', 0),
            ('issues-workspace', 'papercusp', 'EI-fresh', 'open', 600000),
            ('active-workspace', 'papercusp', 'WI-too-old', 'open', -1),
            ('active-workspace', 'papercusp', 'WI-terminal', 'done', 600000),
            ('foreign-workspace', 'papercusp', 'WI-foreign', 'open', 600000),
            ('active-workspace', 'other-harness', 'WI-other', 'open', 600000)
          ) AS fixture(workspace, harness, id, status, delta_ms)`;
        const result = await __queryRecentOpenItemsForTest(10, 'papercusp');
        expect(result.rows.map(row => row.id)).toEqual(['EI-fresh', 'WI-cutoff']);
        expect(result.rows.every(row => !row.hasEmbedding)).toBe(true);
        expect(result.truncated).toBe(false);
      } finally { holder.sql = sql; }
    });
  });

  it('uses a fractional minute window without treating epoch milliseconds as seconds', async () => {
    await sql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, status, created_ts)
      VALUES
        ('active-workspace', 'papercusp', 'WI-recent', 'open',
          (extract(epoch FROM (now() - interval '10 seconds')) * 1000)::bigint),
        ('active-workspace', 'papercusp', 'WI-older', 'open',
          (extract(epoch FROM (now() - interval '45 seconds')) * 1000)::bigint)`;
    expect((await __queryRecentOpenItemsForTest(0.5, 'papercusp')).rows.map(row => row.id))
      .toEqual(['WI-recent']);
  });

  it('retains the newest 50 candidates and reports the real sentinel row', async () => {
    await sql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, status, created_ts)
      SELECT 'active-workspace', 'papercusp', 'WI-' || n, 'open',
        (extract(epoch FROM now()) * 1000)::bigint - n
      FROM generate_series(1, 52) AS n`;
    const result = await __queryRecentOpenItemsForTest(10, 'papercusp');
    expect(result.rows).toHaveLength(50);
    expect(result.rows[0].id).toBe('WI-1');
    expect(result.rows.at(-1)?.id).toBe('WI-50');
    expect(result.truncated).toBe(true);
  });

  it('excludes observation rows before the cap so they cannot hide actual work', async () => {
    await sql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, payload, created_ts)
      SELECT 'active-workspace', 'papercusp', 'EI-OBS-' || n, 'Turn-end reflection ' || n,
        'open', jsonb_build_object('lane', 'observation'),
        (extract(epoch FROM now()) * 1000)::bigint - n
      FROM generate_series(1, 55) AS n`;
    await sql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, created_ts)
      VALUES ('active-workspace', 'papercusp', 'WI-REAL', 'Real work item', 'open',
        (extract(epoch FROM now()) * 1000)::bigint - 1000)`;

    const result = await __queryRecentOpenItemsForTest(10, 'papercusp');

    expect(result.rows.map(row => row.id)).toEqual(['WI-REAL']);
    expect(result.truncated).toBe(false);
  });
});
