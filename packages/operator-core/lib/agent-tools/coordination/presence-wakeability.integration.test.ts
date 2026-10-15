/**
 * presence-wakeability.integration.test.ts — the activity-recency read behind
 * every presence / roster / fleet:assignments / delivery-ladder liveness verdict
 * (papercusp-performance-audit-2026-10-12 P-007, migration 1487).
 *
 * Two properties, both properties of the SQL against the real schema, so this
 * runs the full migration chain on a throwaway Postgres (testcontainer):
 *
 *   1. SEMANTICS — `fetchWakeability` reads, per owner, the newest activity row
 *      and the newest session-end marker inside the 7-day window. The query was
 *      rewritten from a GROUP BY over every in-window row to two LIMIT 1
 *      lookups per owner; these cases pin that the answer did not move:
 *      a live owner, an owner whose newest row IS its end marker, an owner with
 *      only stale rows, and a lifecycle row that is not the end marker.
 *   2. COST — each lookup is one descent of the 1487 indexes. Measured live
 *      before 1487: the GROUP BY walked 112,553 rows (116,604 buffers, 162 ms)
 *      for a 300-owner roster at ~3.5 calls/s. The plan assertion fails if the
 *      read regresses to scanning an owner's whole window.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/coordination/presence-wakeability.integration.test.ts
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { SESSION_END_MARKER } from '../activity/lifecycle-markers';
// eslint-disable-next-line import/no-relative-packages -- mirror the canonical org client's raw Date/jsonb serializers: fetchWakeability Date.parse()s the timestamptz TEXT the org client returns, and a default postgres() client hands back Date objects instead (which Date.parse truncates to whole seconds).
import { restoreRawDateSerializers, restoreRawJsonbSerializer } from '../../../../../libs/papercusp/libs/db/src/raw-serializers';

/** A test client configured like the canonical org client (getOrgPg). */
function orgLikeClient(options: postgres.Options<Record<string, postgres.PostgresType>>): Sql {
  const client = postgres(db.url, options);
  restoreRawJsonbSerializer(client);
  restoreRawDateSerializers(client);
  return client;
}

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..', '..', '..');
const SQL_DIR = join(REPO, 'libs', 'papercusp', 'libs', 'db', 'sql');
const RUNNER = join(REPO, 'libs', 'papercusp', 'packages', 'embedded-postgres-server', 'src', 'migration-runner.js');

let db: MigratedTestDb;
let sql: Sql;

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql }),
}));

const { fetchWakeability } = await import('./presence-wakeability');

const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

async function provision(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(BOOT_PREREQS_DDL);
    const { applyPendingMigrations } = (await import(pathToFileURL(RUNNER).href)) as {
      applyPendingMigrations: (o: { client: Sql; sqlDir: string }) => Promise<{ appliedCount: number; totalKnown: number }>;
    };
    const { appliedCount, totalKnown } = await applyPendingMigrations({ client, sqlDir: SQL_DIR });
    if (appliedCount !== totalKnown) throw new Error(`migrations incomplete: applied ${appliedCount} of ${totalKnown}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  db = await createFreshTestDb({ provision });
  sql = orgLikeClient({ max: 4, onnotice: () => {}, prepare: false });
}, 600_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.agent_activity`;
});

const SEC = 1000;
const DAY = 24 * 3600 * SEC;

async function activity(owner: string, agoMs: number, kind = 'tool', summary: string | null = 'did a thing'): Promise<Date> {
  const at = new Date(Date.now() - agoMs);
  await sql`
    INSERT INTO harness_shared.agent_activity (owner_id, kind, summary, created_at)
    VALUES (${owner}, ${kind}, ${summary}, ${at})`;
  return at;
}

describe('fetchWakeability activity recency (semantics)', () => {
  it('reads the newest in-window row per owner, and the newest session-end marker', async () => {
    // live: an end marker in the past, newer activity after it.
    await activity('live', 10 * 60 * SEC, 'lifecycle', SESSION_END_MARKER);
    for (let i = 0; i < 20; i++) await activity('live', (60 + i) * SEC);
    const liveNewest = await activity('live', 30 * SEC);
    // ended: its newest row IS the end marker, so it is not in a live turn.
    await activity('ended', 90 * SEC);
    const endedAt = await activity('ended', 20 * SEC, 'lifecycle', SESSION_END_MARKER);
    // stale: nothing inside the 7-day window.
    await activity('stale', 8 * DAY);
    // other-lifecycle: a lifecycle row that is NOT the end marker never counts as an end.
    const otherNewest = await activity('other-lifecycle', 15 * SEC, 'lifecycle', 'session started');

    const signals = await fetchWakeability(['live', 'ended', 'stale', 'other-lifecycle', 'live'], sql);

    // EXACT milliseconds (WI-6554700010009626). The org-like client delivers Date
    // objects; Date.parse(date) coerces through toString() and used to drop the
    // milliseconds, so this compared at whole seconds. A regression to that
    // conversion fails here unless the seeded instant happens to land on .000.
    expect(signals.get('live')?.lastActivityMs).toBe(liveNewest.getTime());
    expect(signals.get('live')?.liveTurn).toBe(true);
    expect(signals.get('ended')?.lastActivityMs).toBe(endedAt.getTime());
    expect(signals.get('ended')?.liveTurn).toBe(false);
    expect(signals.get('stale')?.lastActivityMs ?? null).toBeNull();
    expect(signals.get('stale')?.liveTurn).toBe(false);
    expect(signals.get('other-lifecycle')?.lastActivityMs).toBe(otherNewest.getTime());
    expect(signals.get('other-lifecycle')?.liveTurn).toBe(true);
  });
});

describe('fetchWakeability activity recency (cost, migration 1487)', () => {
  type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: PlanNode[] };

  function activityScans(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
    if (node['Relation Name'] === 'agent_activity') out.push(node);
    for (const child of node.Plans ?? []) activityScans(child, out);
    return out;
  }

  it('looks each owner up through the newest-row indexes, never by scanning its window', async () => {
    // Production-shaped: many owners interleaved in time, so no single owner is
    // a large share of the newest rows (live: ~300 roster owners over 1.16 M rows).
    // With only a few owners a backward created_at scan meets each owner within a
    // handful of rows and is legitimately cheaper — a fixture artifact, not the
    // property under test.
    await sql`
      INSERT INTO harness_shared.agent_activity (owner_id, kind, summary, created_at)
      SELECT 'o' || (g % 200), 'tool', 'did a thing', now() - make_interval(secs => g * 13)
        FROM generate_series(1, 8000) AS g`;
    await sql`
      INSERT INTO harness_shared.agent_activity (owner_id, kind, summary, created_at)
      SELECT 'o' || g, 'lifecycle', ${SESSION_END_MARKER}, now() - interval '3 days'
        FROM generate_series(0, 199) AS g`;
    // Capture the exact statement fetchWakeability sends, never a re-typed copy.
    const captured: Array<{ query: string; params: unknown[] }> = [];
    const client = orgLikeClient({
      max: 1,
      onnotice: () => {},
      prepare: false,
      debug: (_conn: number, query: string, params: unknown[]) => {
        if (query.includes('agent_activity')) captured.push({ query, params: [...params] });
      },
    });
    try {
      await fetchWakeability(['o1', 'o2', 'o3'], client);
    } finally {
      await client.end({ timeout: 5 });
    }
    expect(captured).toHaveLength(1);

    await sql.unsafe('VACUUM (ANALYZE) harness_shared.agent_activity');
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL enable_seqscan = off');
      await tx.unsafe('SET LOCAL enable_bitmapscan = off');
      return tx.unsafe(`EXPLAIN (FORMAT JSON) ${captured[0]!.query}`, captured[0]!.params as never[]);
    });
    const plan = (rows[0] as unknown as { 'QUERY PLAN': Array<{ Plan: PlanNode }> })['QUERY PLAN'][0]!.Plan;
    const indexes = activityScans(plan).map((s) => s['Index Name']).sort();
    expect(indexes).toEqual(['agent_activity_owner_created_idx', 'agent_activity_owner_lifecycle_idx']);
  });
});
