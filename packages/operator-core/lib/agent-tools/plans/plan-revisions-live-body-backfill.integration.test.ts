/**
 * WI-10006321 — migration 1376 gives every live plan body a matching plan_revisions row.
 *
 * The plan-parts reconcile sweep dates a body by the latest revision whose content_hash
 * equals harness_plans.content_hash; with none it falls back to updated_at, which
 * non-content writes also bump. Measured 2026-10-06: 338 local + 214 remote live plans had
 * no matching revision. This seeds one row per branch of the migration's decision, runs the
 * migration text the way the runner does (one transaction), and asserts the outcome per row.
 *
 * The subject path is overridable (PLAN_REVISIONS_BACKFILL_SQL) so the same test can run
 * against the .DRAFT before the migration is armed, or against a mutated copy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPlanContent } from '@papercusp/plan-parser/content-hash';
import type { OrgTestDb } from '../../../test/_org-test-db';

const { createOrgTestDb } = await import('../../../test/_org-test-db');

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH =
  process.env.PLAN_REVISIONS_BACKFILL_SQL ??
  resolve(HERE, '../../../../../libs/papercusp/libs/db/sql/1376-plan-revisions-live-body-backfill.sql');
const MIGRATION = readFileSync(MIGRATION_PATH, 'utf8');

const WS = 'plan-rev-backfill-test';
const H = 'backfill-harness';
const AUTHOR = 'plan-revisions:live-body-backfill';
const T = '2026-09-01T00:00:00.000Z';

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.adminSql`DELETE FROM harness_shared.plan_revisions WHERE workspace_id = ${WS}`;
  await db.adminSql`DELETE FROM harness_shared.harness_plans WHERE workspace_id = ${WS}`;
});

async function seedPlan(slug: string, content: string, opts: { hash?: string; origin?: string; archived?: boolean } = {}) {
  await db.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, origin, archived, updated_at)
    VALUES (${WS}, ${H}, ${slug}, ${content}, ${opts.hash ?? hashPlanContent(content)},
            ${opts.origin ?? 'local'}, ${opts.archived ?? false}, ${T}::timestamptz)`;
}

async function seedRevision(slug: string, seq: number, content: string) {
  await db.adminSql`
    INSERT INTO harness_shared.plan_revisions
      (workspace_id, harness_slug, plan_slug, seq, content_hash, content_snapshot, author_kind, author_id, created_at)
    VALUES (${WS}, ${H}, ${slug}, ${seq}, ${hashPlanContent(content)}, ${content}, 'system', 'seed', ${1_000 + seq})`;
}

async function runMigration() {
  await db.adminSql.begin((tx) => tx.unsafe(MIGRATION).simple());
}

type Rev = { seq: number; content_hash: string; content_snapshot: string; author_kind: string; author_id: string; created_at: number };
async function revisions(slug: string): Promise<Rev[]> {
  return db.adminSql<Rev[]>`
    SELECT seq, content_hash, content_snapshot, author_kind, author_id, created_at
      FROM harness_shared.plan_revisions
     WHERE workspace_id = ${WS} AND harness_slug = ${H} AND plan_slug = ${slug}
     ORDER BY seq`;
}

async function planRow(slug: string) {
  // updated_ms uses the reconcile sweep's own conversion (it ROUNDS sub-millisecond time;
  // a JS Date from the driver truncates, so the two can differ by 1 ms). The backfill's
  // created_at must agree with the sweep's LEAST(updated_at ms, revision created_at).
  const [row] = await db.adminSql<Array<{ content_hash: string; updated_ms: number }>>`
    SELECT content_hash, (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_ms
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${H} AND plan_slug = ${slug}`;
  return row!;
}

describe('migration 1376: plan_revisions live-body backfill', () => {
  it('calibration: the SQL hash is byte-identical to hashPlanContent, including non-ASCII bodies', async () => {
    const body = 'café — ✓ ñ 日本語\n';
    const [{ h }] = await db.adminSql<Array<{ h: string }>>`SELECT encode(sha256(convert_to(${body}, 'UTF8')), 'hex') AS h`;
    expect(h).toBe(hashPlanContent(body));
  });

  it('backfills each live body with no matching revision, and leaves every other branch alone', async () => {
    await seedPlan('fresh', 'café — ✓ body A');                       // no revisions at all
    await seedPlan('drifted', 'body B v2');                           // revisions exist, none match
    await seedRevision('drifted', 1, 'body B v0');
    await seedRevision('drifted', 2, 'body B v1');
    await seedPlan('matched', 'body C');                              // already dated
    await seedRevision('matched', 1, 'body C');
    await seedPlan('archived', 'body D', { archived: true });         // the sweep never reads it
    await seedPlan('empty-hash-local', 'body E', { hash: '' });       // the adhoc-scope defect
    await seedPlan('empty-hash-remote', 'body F', { hash: '', origin: 'remote' });
    await seedPlan('wrong-hash', 'body G', { hash: 'deadbeef' });     // hash lies about its bytes
    await seedPlan('remote-consistent', 'body H', { origin: 'remote' });

    await runMigration();

    const tMs = Date.parse(T);
    expect(await revisions('fresh')).toEqual([
      { seq: 1, content_hash: hashPlanContent('café — ✓ body A'), content_snapshot: 'café — ✓ body A', author_kind: 'system', author_id: AUTHOR, created_at: tMs },
    ]);
    const drifted = await revisions('drifted');
    expect(drifted.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(drifted[2]).toMatchObject({ content_hash: hashPlanContent('body B v2'), author_id: AUTHOR, created_at: tMs });
    expect((await revisions('matched')).map((r) => r.author_id)).toEqual(['seed']);
    expect(await revisions('archived')).toEqual([]);

    // The local '' hash is repaired, and the body is then dated by the backfill.
    const e = await planRow('empty-hash-local');
    expect(e.content_hash).toBe(hashPlanContent('body E'));
    expect(await revisions('empty-hash-local')).toEqual([
      expect.objectContaining({ seq: 1, content_hash: hashPlanContent('body E'), author_id: AUTHOR, created_at: e.updated_ms }),
    ]);
    // A remote row is the origin's to correct: neither repaired nor snapshotted.
    expect((await planRow('empty-hash-remote')).content_hash).toBe('');
    expect(await revisions('empty-hash-remote')).toEqual([]);
    expect((await planRow('wrong-hash')).content_hash).toBe('deadbeef');
    expect(await revisions('wrong-hash')).toEqual([]);
    expect(await revisions('remote-consistent')).toEqual([
      expect.objectContaining({ seq: 1, content_hash: hashPlanContent('body H'), author_id: AUTHOR, created_at: tMs }),
    ]);

    // The reconcile sweep's own join now finds a revision for every consistent live body.
    const undated = await db.adminSql<Array<{ plan_slug: string }>>`
      SELECT p.plan_slug FROM harness_shared.harness_plans p
       WHERE p.workspace_id = ${WS} AND p.archived = false
         AND NOT EXISTS (SELECT 1 FROM harness_shared.plan_revisions r
                          WHERE r.workspace_id = p.workspace_id AND r.harness_slug = p.harness_slug
                            AND r.plan_slug = p.plan_slug AND r.content_hash = p.content_hash)
       ORDER BY p.plan_slug`;
    expect(undated.map((r) => r.plan_slug)).toEqual(['empty-hash-remote', 'wrong-hash']);
  });

  it('is idempotent: a second run inserts nothing and changes no hash', async () => {
    await seedPlan('fresh', 'body A');
    await seedPlan('empty-hash-local', 'body E', { hash: '' });
    await runMigration();
    const [{ n: before }] = await db.adminSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.plan_revisions WHERE workspace_id = ${WS}`;
    expect(before).toBe(2);
    await runMigration();
    const [{ n: after }] = await db.adminSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.plan_revisions WHERE workspace_id = ${WS}`;
    expect(after).toBe(before);
  });
});
