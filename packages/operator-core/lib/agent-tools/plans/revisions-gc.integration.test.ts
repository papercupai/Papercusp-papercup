/**
 * revisions-gc.integration.test.ts — gcOldPlanRevisions, the per-plan retention cap
 * over plan_revisions, against a real Postgres.
 *
 * infra-fail-fast C4/P-012. Proves: keeps the newest N revisions per plan and deletes
 * the older tail; partitions independently per (workspace_id, harness_slug, plan_slug);
 * a plan with ≤N revisions is untouched; returns the deleted count.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { gcOldPlanRevisions } = await import('./revisions-gc');

let rootSql: postgres.Sql;
const survivingSeqs = async (plan: string) =>
  (await rootSql<{ seq: number }[]>`
    SELECT seq FROM harness_shared.plan_revisions WHERE plan_slug=${plan} ORDER BY seq`).map((r) => r.seq);

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `prgc_${randomBytes(5).toString('hex')}`;
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
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.plan_revisions (
      id bigserial PRIMARY KEY,
      plan_slug text NOT NULL,
      seq integer NOT NULL,
      content_snapshot text,
      created_at bigint,
      harness_slug text NOT NULL DEFAULT 'papercusp',
      workspace_id text NOT NULL DEFAULT 'default'
    )`);
  h.sql = rootSql;
  await rootSql.unsafe(`CREATE TABLE harness_shared.harness_plans (
    workspace_id text, harness_slug text, plan_slug text, execution_start_revision_seq integer)`);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.plan_revisions RESTART IDENTITY`;
  await rootSql`TRUNCATE harness_shared.harness_plans`;
});

async function seed(plan: string, count: number, harness = 'papercusp', ws = 'default') {
  for (let seq = 1; seq <= count; seq++) {
    await rootSql`INSERT INTO harness_shared.plan_revisions (plan_slug, seq, content_snapshot, harness_slug, workspace_id)
                  VALUES (${plan}, ${seq}, ${'snapshot ' + seq}, ${harness}, ${ws})`;
  }
}

describe('gcOldPlanRevisions (PG)', () => {
  it('retains only the exact scoped start pin beyond the newest 100, then ages an obsolete pin', async () => {
    await seed('chatty', 105);
    await seed('chatty', 105, 'other-harness');
    await rootSql`INSERT INTO harness_shared.harness_plans VALUES ('default','papercusp','chatty',1)`;
    expect(await gcOldPlanRevisions()).toBe(9);
    const pinned = await rootSql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.plan_revisions
      WHERE seq=1 AND harness_slug='papercusp'`;
    expect(pinned[0]?.n).toBe(1);
    await rootSql`UPDATE harness_shared.harness_plans SET execution_start_revision_seq=NULL`;
    expect(await gcOldPlanRevisions()).toBe(1);
  });
  it('keeps the newest N per plan and deletes the older tail; ≤N plans untouched', async () => {
    await seed('chatty', 10); // > keep(3) → trim to newest 3
    await seed('quiet', 2);   // ≤ keep(3) → untouched

    const n = await gcOldPlanRevisions(3);
    expect(n).toBe(7); // chatty: 10 - 3 kept
    expect(await survivingSeqs('chatty')).toEqual([8, 9, 10]); // newest 3 by seq
    expect(await survivingSeqs('quiet')).toEqual([1, 2]); // untouched
  });

  it('partitions independently per (workspace, harness, plan_slug)', async () => {
    // same plan_slug under two different harnesses — each capped on its own.
    await seed('shared-slug', 6, 'hive-a');
    await seed('shared-slug', 6, 'hive-b');
    const n = await gcOldPlanRevisions(4);
    expect(n).toBe(4); // 2 trimmed from each of the two scopes
    const rows = await rootSql<{ harness_slug: string; cnt: number }[]>`
      SELECT harness_slug, count(*)::int AS cnt FROM harness_shared.plan_revisions GROUP BY harness_slug ORDER BY harness_slug`;
    expect(rows).toEqual([
      { harness_slug: 'hive-a', cnt: 4 },
      { harness_slug: 'hive-b', cnt: 4 },
    ]);
  });

  it('returns 0 when nothing exceeds the cap', async () => {
    await seed('small', 5);
    expect(await gcOldPlanRevisions(100)).toBe(0);
    expect(await survivingSeqs('small')).toEqual([1, 2, 3, 4, 5]);
  });
});
