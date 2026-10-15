/**
 * work-items-swarm-affinity.integration.test.ts — the Queen's co-location lever against
 * real Postgres (hive-coordination-model-2026-06-08 P-002).
 *
 * Proves:
 *   • claimNextWorkItem WITHOUT a swarmId (the single-instance default) ignores
 *     swarm_affinity — byte-identical to the pre-P-002 oldest-first claim.
 *   • claimNextWorkItem WITH a swarmId (only passed under the per-Hive claim lease):
 *       - SKIPS work affined to a DIFFERENT Swarm (never claims another Swarm's work);
 *       - PREFERS work affined to THIS Swarm over unaffined work, even when older
 *         unaffined work exists;
 *       - falls back to unaffined work when nothing is affined to this Swarm.
 *   • setWorkItemSwarmAffinity / getWorkItemSwarmAffinity round-trip the column.
 *
 * Mirrors work-items-claim.integration.test.ts's schema bootstrap.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, applyClaimPathReadDeps } from '../test/_work-items-schema';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

// HFC with the swarm_affinity column (migration 191) baked in.
const HFC_DDL = HARNESS_FEATURES_CONSOLIDATED_DDL;

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('./work-items');
const coLocateTool = (await import('./agent-tools/work_items/co_locate')).default;
// co_locate returns the modern `defineTool` ToolResponse shape `{ data }` (its local
// `json()` helper is `(o) => ({ data: o })`) — NOT the legacy `{ content: [{ text }] }`
// envelope this helper used to JSON.parse. Read `.data` directly (already the object).
const runCoLocate = async (args: Record<string, unknown>) =>
  (
    await (
      coLocateTool as unknown as {
        handler: (a: unknown, c: unknown) => Promise<{ data: unknown }>;
      }
    ).handler(args, { log() {}, workspaceId: 'default', role: 'operator' })
  ).data as Record<string, unknown>;
const H = 'papercup';
const S1 = 'swarm-one';
const S2 = 'swarm-two';
let db: FreshPgDb;

async function seedFeature(
  id: string,
  opts: { createdTs?: number; affinity?: string | null; takenBy?: string | null } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, swarm_affinity, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'feature', 'open', ${opts.takenBy ?? null}, ${opts.affinity ?? null}, 'default', ${opts.createdTs ?? 0}, 0)`;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-swarm-affinity');
  h.sql = db.sql;
  await db.sql.unsafe(HFC_DDL);
  // G2 trust leg (P-010): autoPickableWhereSql(sql, ws) consults this table.
  await db.sql.unsafe(
    `CREATE TABLE IF NOT EXISTS harness_shared.user_trust_list (workspace_id text NOT NULL, trusted_github_user_id bigint NOT NULL, note text, created_ts bigint NOT NULL, PRIMARY KEY (workspace_id, trusted_github_user_id))`,
  );
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple()); // claim path's P-005 readiness clause reads work_item_deps
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz;
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz,
      ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`).simple();
});

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.harness_features_consolidated`;
});

describe('claimNextWorkItem — affinity-blind (no swarmId, the single-instance default)', () => {
  it('ignores swarm_affinity entirely — claims the oldest regardless', async () => {
    await seedFeature('F-1', { createdTs: 100, affinity: S2 }); // oldest, affined elsewhere
    await seedFeature('F-2', { createdTs: 200, affinity: null });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-x' });
    expect(got?.id).toBe('F-1'); // oldest-first, affinity NOT consulted
  });
});

describe('claimNextWorkItem — affinity-aware (swarmId set, as under the per-Hive lease)', () => {
  it('skips work affined to ANOTHER Swarm', async () => {
    await seedFeature('F-1', { createdTs: 100, affinity: S2 }); // oldest but affined to S2
    await seedFeature('F-2', { createdTs: 200, affinity: null }); // claimable by S1
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-x', swarmId: S1 });
    expect(got?.id).toBe('F-2'); // never F-1 (it belongs to S2)
  });

  it('prefers work affined to THIS Swarm over older unaffined work', async () => {
    await seedFeature('F-1', { createdTs: 100, affinity: null }); // older, unaffined
    await seedFeature('F-2', { createdTs: 200, affinity: S1 }); // newer, mine
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-x', swarmId: S1 });
    expect(got?.id).toBe('F-2'); // affined-to-me wins over older unaffined
  });

  it('falls back to unaffined work when nothing is affined to this Swarm', async () => {
    await seedFeature('F-1', { createdTs: 100, affinity: S2 });
    await seedFeature('F-2', { createdTs: 200, affinity: null });
    await seedFeature('F-3', { createdTs: 150, affinity: null });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-x', swarmId: S1 });
    expect(got?.id).toBe('F-3'); // oldest unaffined (150 < 200); F-1 skipped (S2)
  });

  it('returns null when every claimable item is affined to another Swarm', async () => {
    await seedFeature('F-1', { createdTs: 100, affinity: S2 });
    await seedFeature('F-2', { createdTs: 200, affinity: S2 });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-x', swarmId: S1 });
    expect(got).toBeNull();
  });
});

describe('setWorkItemSwarmAffinity / getWorkItemSwarmAffinity', () => {
  it('round-trips the affinity column', async () => {
    await seedFeature('F-1', { createdTs: 100 });
    expect((await wi.getWorkItemSwarmAffinity('F-1', { harness: H }))?.swarmAffinity).toBeNull();

    const set = await wi.setWorkItemSwarmAffinity('F-1', S1, { harness: H });
    expect(set?.swarmAffinity).toBe(S1);
    expect((await wi.getWorkItemSwarmAffinity('F-1', { harness: H }))?.swarmAffinity).toBe(S1);

    const cleared = await wi.setWorkItemSwarmAffinity('F-1', null, { harness: H });
    expect(cleared?.swarmAffinity).toBeNull();
  });

  it('a claim now respects an affinity that was just set', async () => {
    await seedFeature('F-1', { createdTs: 100 }); // unaffined → would be claimable by S1
    await wi.setWorkItemSwarmAffinity('F-1', S2, { harness: H }); // now belongs to S2
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-x', swarmId: S1 });
    expect(got).toBeNull(); // S1 can't claim S2's work
  });
});

describe('work_items:co_locate tool', () => {
  it('read mode reports the current affinity without writing', async () => {
    await seedFeature('F-1', { createdTs: 100, affinity: S1 });
    const r = await runCoLocate({ workItem: 'F-1', harness: H });
    expect(r).toMatchObject({ ok: true, mode: 'read', workItem: 'F-1', swarmAffinity: S1 });
  });

  it('explicit mode pins a Swarm, and null clears it', async () => {
    await seedFeature('F-1', { createdTs: 100 });
    const pinned = await runCoLocate({ workItem: 'F-1', harness: H, swarm: S2 });
    expect(pinned).toMatchObject({ ok: true, mode: 'explicit', action: 'pin', swarmAffinity: S2 });
    expect((await wi.getWorkItemSwarmAffinity('F-1', { harness: H }))?.swarmAffinity).toBe(S2);

    const cleared = await runCoLocate({ workItem: 'F-1', harness: H, swarm: null });
    expect(cleared).toMatchObject({ ok: true, action: 'clear', swarmAffinity: null });
  });

  it('decided mode co-locates with another item: inherits its Swarm', async () => {
    await seedFeature('F-peer', { createdTs: 100, affinity: S2 }); // collaborator on S2
    await seedFeature('F-new', { createdTs: 200 });
    const r = await runCoLocate({ workItem: 'F-new', harness: H, coLocateWith: 'F-peer' });
    expect(r).toMatchObject({ ok: true, mode: 'decided', action: 'co-locate', swarmAffinity: S2 });
    expect((await wi.getWorkItemSwarmAffinity('F-new', { harness: H }))?.swarmAffinity).toBe(S2);
  });

  it('decided mode reports not-found for a missing coLocateWith item', async () => {
    await seedFeature('F-new', { createdTs: 200 });
    const r = await runCoLocate({ workItem: 'F-new', harness: H, coLocateWith: 'F-nope' });
    expect(r.ok).toBe(false);
  });
});
