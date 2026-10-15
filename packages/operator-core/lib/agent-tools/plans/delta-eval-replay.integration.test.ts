/**
 * Delta replay/eval harness — RE-EXECUTION integration tier
 * (agent-tool-delta-protocol-2026-06-22, Lane A / P-003).
 *
 * `harness_shared.tool_invocations` stores arg shape + result SIZE only, NEVER
 * bodies — so a delta replay must RE-EXECUTE a candidate tool against a fixture
 * DB to obtain real `base`/`next` snapshots. This test proves that full loop on
 * LIVE Postgres output (not synthetic fixtures): it seeds a `plans:list`-shaped
 * fixture table, re-executes a tool handler that reads it (the same DB-read →
 * `{ data: rows }` shape the real plans:list handler produces), mutates the DB,
 * re-executes again, and runs the two REAL bodies through the eval engine —
 * asserting the merge reconstructs `next` EXACTLY and the delta/not_modified
 * token saving is real.
 *
 * The fixture stands in for plans:list (whose production projection — harness_plans
 * + effective-status + issue-blocks + scout-provenance — is the Lane-E exemplar's
 * seeding job, P-014); the loop under test (re-execute → real body → eval →
 * correct merge) is identical.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import {
  computeListDelta,
  applyListDelta,
  evalSnapshotTransition,
  type DeltaEvalRow,
} from '@papercusp/agent-mcp';

let sql: postgres.Sql;

/** The candidate tool's handler: a real DB read → the plans:list ListRow body. */
async function reExecute(): Promise<DeltaEvalRow[]> {
  const rows = await sql<DeltaEvalRow[]>`
    SELECT slug, title, status, updated,
           is_legacy   AS "isLegacy",
           item_counts AS "itemCounts",
           next_action AS "nextAction"
    FROM eval_plans
    ORDER BY slug`;
  // postgres returns row objects; normalize to plain objects (engine compares by value)
  return rows.map((r) => ({ ...r }));
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `pp_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE TABLE eval_plans (
      slug        text PRIMARY KEY,
      title       text,
      status      text NOT NULL,
      updated     text,
      is_legacy   boolean NOT NULL DEFAULT false,
      item_counts jsonb,
      next_action text
    )`);
}, 90_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await sql`TRUNCATE eval_plans`;
  // Seed a representative ~30-plan workspace view.
  for (let i = 0; i < 30; i++) {
    await sql`
      INSERT INTO eval_plans (slug, title, status, updated, item_counts, next_action)
      VALUES (
        ${`plan-${i}-2026-06-${String((i % 28) + 1).padStart(2, '0')}`},
        ${`Plan ${i} — a representative multi-clause title describing the effort`},
        ${i % 5 === 0 ? 'active' : 'draft'},
        ${`2026-06-${String((i % 28) + 1).padStart(2, '0')}`},
        ${sql.json({ todo: i % 7, wip: i % 3, done: i % 11 })},
        ${`Phase ${i % 4} — wire component ${i}, verify against the suite, hand off to the reviewer.`}
      )`;
  }
});

describe('delta replay — re-execute plans:list-shaped tool against a fixture DB', () => {
  it('UNCHANGED between re-executions → not_modified, merge is base, on REAL bodies', async () => {
    const base = await reExecute();
    const next = await reExecute(); // no mutation
    expect(base).toHaveLength(30);

    const delta = computeListDelta(base, next, { itemKey: 'slug' });
    expect(delta.mode).toBe('not_modified');

    const e = await evalSnapshotTransition(base, next, { itemKey: 'slug' });
    expect(e.mode).toBe('not_modified');
    expect(e.correct).toBe(true);
    expect(e.savedVsFullPct).toBeGreaterThan(95);
  });

  it('a real DB mutation between re-executions → delta reconstructs next EXACTLY', async () => {
    const base = await reExecute();

    // Mutate the live fixture: update one, insert one, delete one.
    await sql`UPDATE eval_plans SET status='shipped', next_action='edited live' WHERE slug=${base[10].slug as string}`;
    await sql`DELETE FROM eval_plans WHERE slug=${base[3].slug as string}`;
    await sql`
      INSERT INTO eval_plans (slug, title, status, updated, item_counts, next_action)
      VALUES ('plan-new-zzz', 'A newly created plan', 'draft', '2026-06-22', ${sql.json({ todo: 1 })}, 'kick off')`;

    const next = await reExecute();
    expect(next).toHaveLength(30); // -1 deleted, +1 inserted

    const delta = computeListDelta(base, next, { itemKey: 'slug' });
    expect(delta.mode).toBe('delta');
    if (delta.mode === 'delta') {
      expect(delta.counts).toMatchObject({ added: 1, updated: 1, removed: 1 });
    }

    // The de-risk oracle on REAL re-executed bodies: merge === next, exactly.
    const merged = applyListDelta(base, delta, { itemKey: 'slug' });
    expect(merged).toEqual(next);

    const e = await evalSnapshotTransition(base, next, { itemKey: 'slug' });
    expect(e.correct).toBe(true);
    expect(e.winner).toBe('delta');
    const fullBaseline = Math.min(e.tokens.fullJson, e.tokens.fullToon);
    expect(e.tokens.delta!).toBeLessThan(fullBaseline / 2);
  });
});
