/**
 * WI-10006534 — an explicit harness must reach a FEATURE-family row whose id is shadowed by an
 * ISSUE-family row in another harness.
 *
 * `WI-<n>` ids come from a per-database sequence, so the same id can name an issue-family row
 * in one harness and a feature-family row in another. `getWorkItem` probed the issue family
 * first and returned that row whatever harness the caller named, so the feature row was
 * unreachable: measured 2026-10-06, `work_items:set_state { id:'WI-10000680', harness:'email',
 * state:'dropped' }` wrote papercusp's issue-family WI-10000680 and left email's
 * email-draft-proposal row open.
 *
 * The controls pin what must NOT change: harness stays a preference, never a filter
 * (EI-19393623437103599 / WI-10006010), so an unscoped read and a harness with no row of that
 * id still resolve the issue row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, applyClaimPathReadDeps, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';

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

const WS = 'default';
const ISSUE_HARNESS = 'papercusp';
const FEATURE_HARNESS = 'email';
const ID = 'WI-777001';
let db: FreshPgDb;

async function seedIssue(id: string, harness: string) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, workspace_id, created_ts, updated_ts)
    VALUES (${harness}, ${id}, 'task', ${`issue ${id}`}, 'dropped', ${WS}, 1, 1)`;
}

async function seedFeature(id: string, harness: string) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, workspace_id, created_ts, updated_ts)
    VALUES (${harness}, ${id}, 'email-draft-proposal', ${`feature ${id}`}, 'open', ${WS}, 1, 1)`;
}

async function snapshot(harness: string, id: string): Promise<unknown> {
  const [r] = await db.sql<Array<{ row: unknown }>>`
    SELECT to_jsonb(w) - '_search' AS row FROM harness_shared.work_items w
     WHERE workspace_id = ${WS} AND harness_slug = ${harness} AND feature_id = ${id}`;
  return r?.row;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-cross-family-harness');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
});

describe('WI-10006534 — explicit harness resolves across work-item families', () => {
  it('getWorkItem with the feature row\'s harness returns the feature row, not the shadowing issue row', async () => {
    await seedIssue(ID, ISSUE_HARNESS);
    await seedFeature(ID, FEATURE_HARNESS);

    const item = await wi.getWorkItem(ID, FEATURE_HARNESS);

    expect(item?.family).toBe('feature');
    expect(item?.harness).toBe(FEATURE_HARNESS);
    expect(item?.title).toBe(`feature ${ID}`);
  });

  it('setWorkItemState scoped to the feature harness writes the feature row and leaves the issue row byte-identical', async () => {
    await seedIssue(ID, ISSUE_HARNESS);
    await seedFeature(ID, FEATURE_HARNESS);
    const issueBefore = await snapshot(ISSUE_HARNESS, ID);
    expect(issueBefore).toBeDefined();

    const written = await wi.setWorkItemState(ID, 'dropped', {
      harness: FEATURE_HARNESS,
      by: 'wi10006534',
      completionRef: 'superseded: wi10006534 regression',
    });

    expect(written?.family).toBe('feature');
    expect(written?.harness).toBe(FEATURE_HARNESS);
    const [feature] = await db.sql<Array<{ status: string }>>`
      SELECT status FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND harness_slug = ${FEATURE_HARNESS} AND feature_id = ${ID}`;
    expect(feature?.status).toBe('dropped');
    expect(await snapshot(ISSUE_HARNESS, ID)).toEqual(issueBefore);
  });

  it('control: the issue row\'s own harness and an unscoped read still resolve the issue row', async () => {
    await seedIssue(ID, ISSUE_HARNESS);
    await seedFeature(ID, FEATURE_HARNESS);

    expect((await wi.getWorkItem(ID, ISSUE_HARNESS))?.family).toBe('issue');
    expect((await wi.getWorkItem(ID))?.family).toBe('issue');
  });

  it('control: a harness with no row of that id still gets the issue row (preference, not filter)', async () => {
    await seedIssue(ID, ISSUE_HARNESS);

    const item = await wi.getWorkItem(ID, FEATURE_HARNESS);

    expect(item?.family).toBe('issue');
    expect(wi.harnessScopeMismatch(item!, FEATURE_HARNESS)).toEqual({
      requested: FEATURE_HARNESS,
      resolved: ISSUE_HARNESS,
    });
  });
});
