/**
 * P-011 / INV-19 — real-Postgres dependency lifecycle transition matrix.
 *
 * The graph writer and migration 989 form one refusal boundary: whichever side
 * of an edge/lifecycle race commits first, the opposite transition re-evaluates
 * the committed state and refuses a contradictory partial post-state. These
 * cases enumerate both serial orders and both work-item families. P-007's
 * deterministic contention suite separately proves the endpoint locks force
 * concurrent transactions into one of those serial orders.
 *
 * Real PostgreSQL (shared reusable testcontainer; Docker required).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import {
  mutateWorkItemDependencies,
  WorkItemDependencyAdmissionError,
  type WorkItemDepEndpoint,
  type WorkItemDependencyBatchInput,
} from './work-item-deps-store';

const SQL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../libs/papercusp/libs/db/sql');
const EDGE_WS = 'default';
const ITEM_WS = 'tenant-lifecycle';
const H = 'lifecycle-harness';
const REOPEN_MIGRATION = '1621-dependency-reopen-untouched-dependants.sql';

type Family = 'issue' | 'feature';
type SeedOptions = {
  family?: Family;
  status?: string;
  takenBy?: string | null;
  lastProgressAt?: Date | null;
  harness?: string;
};

let db: FreshPgDb;

const endpoint = (family: Family, id: string, harness = H): WorkItemDepEndpoint =>
  family === 'issue' ? { kind: 'issue', ref: id } : { kind: 'feature', ref: `${harness}#${id}` };

async function seedItem(id: string, opts: SeedOptions = {}): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind,
       taken_by, taken_at, last_progress_at, created_ts, updated_ts, payload)
    VALUES
      (${ITEM_WS}, ${opts.harness ?? H}, ${id}, ${`item ${id}`}, ${opts.status ?? 'open'},
       ${opts.family === 'feature' ? 'feature' : 'task'}, ${opts.takenBy ?? null},
       ${opts.takenBy ? new Date() : null}, ${opts.lastProgressAt ?? null}, 0, 0, '{}'::jsonb)`;
}

const mutate = (mutations: WorkItemDependencyBatchInput['mutations']) =>
  mutateWorkItemDependencies(
    { workspaceId: EDGE_WS, itemWorkspaceId: ITEM_WS, mutations },
    { sql: db.sql as Sql, retry: { maxRetries: 8 } },
  );

const addEdge = (blocked: WorkItemDepEndpoint, blocker: WorkItemDepEndpoint) =>
  mutate([{ op: 'add', blocked, blocker, createdBy: 'p011-test' }]);

const removeEdge = (blocked: WorkItemDepEndpoint, blocker: WorkItemDepEndpoint) =>
  mutate([{ op: 'remove', blocked, blocker }]);

async function edgeCount(): Promise<number> {
  const [row] = await db.sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n
      FROM harness_shared.work_item_deps
     WHERE workspace_id = ${EDGE_WS} AND dep_type = 'blocks'`;
  return Number(row?.n ?? 0);
}

async function itemState(id: string): Promise<{ status: string; taken_by: string | null; harness_slug: string }> {
  const [row] = await db.sql<Array<{ status: string; taken_by: string | null; harness_slug: string }>>`
    SELECT status, taken_by, harness_slug
      FROM harness_shared.work_items
     WHERE workspace_id = ${ITEM_WS} AND feature_id = ${id}`;
  if (!row) throw new Error(`missing fixture row ${id}`);
  return row;
}

async function expectLifecycleAdmissionRejected(promise: Promise<unknown>): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(WorkItemDependencyAdmissionError);
  const admission = error as WorkItemDependencyAdmissionError;
  expect(admission.findings.map((finding) => finding.policy.code)).toContain('active-dependant-unreconciled');
}

async function expectPgGuardRejected(promise: Promise<unknown>, message: RegExp): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string } | undefined)?.code).toBe('23514');
  expect(String((error as Error | undefined)?.message)).toMatch(message);
}

beforeAll(async () => {
  db = await createFreshPgDb('work-item-deps-p011-lifecycle');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql
    .unsafe(
      `
      CREATE TABLE harness_shared.coord_links (
        id bigserial PRIMARY KEY,
        workspace_id text NOT NULL DEFAULT 'default',
        src_kind text NOT NULL,
        src_ref text NOT NULL,
        dst_kind text NOT NULL,
        dst_ref text NOT NULL,
        rel text NOT NULL
      );
      CREATE UNIQUE INDEX coord_links_edge_uq ON harness_shared.coord_links
        (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel);
      CREATE TABLE harness_shared.coord_threads (
        workspace_id text NOT NULL DEFAULT 'default',
        thread_id text NOT NULL,
        parent_kind text NOT NULL,
        parent_ref text NOT NULL,
        post_count integer NOT NULL DEFAULT 0,
        PRIMARY KEY (workspace_id, thread_id)
      );
      CREATE UNIQUE INDEX coord_threads_parent_uq ON harness_shared.coord_threads
        (workspace_id, parent_kind, parent_ref);
    `,
    )
    .simple();

  // Apply the shipping transition seams verbatim. The test never restates their
  // functions, so production/test drift breaks setup or behavior loudly.
  await applyMigrationForTest(db.sql, resolve(SQL_DIR, '734-repoint-qualified-refs-on-rehome.sql'));
  await applyMigrationForTest(db.sql, resolve(SQL_DIR, '988-work-item-dependency-delete-guard.sql'));
  await applyMigrationForTest(db.sql, resolve(SQL_DIR, '991-work-item-dependency-lifecycle-transition-guard.sql'));
  await applyMigrationForTest(db.sql, resolve(SQL_DIR, '992-work-item-dependency-satisfaction.sql'));
  await applyMigrationForTest(db.sql, resolve(SQL_DIR, REOPEN_MIGRATION));
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql
    .unsafe(
      `
      TRUNCATE harness_shared.work_item_deps,
               harness_shared.work_item_blocked,
               harness_shared.work_items,
               harness_shared.coord_links,
               harness_shared.coord_threads
      RESTART IDENTITY CASCADE;
    `,
    )
    .simple();
});

// @covers INV-19
describe('P-011 blocker addition — active dependant refusal across the typed graph', () => {
  it.each([
    ['issue', 'issue'],
    ['issue', 'feature'],
    ['feature', 'issue'],
    ['feature', 'feature'],
  ] as const)(
    'rejects unresolved %s dependant <- %s blocker behind a named claim',
    async (blockedFamily, blockerFamily) => {
      await seedItem('DEP', { family: blockedFamily, takenBy: 'su-active' });
      await seedItem('BLOCK', { family: blockerFamily });

      await expectLifecycleAdmissionRejected(addEdge(endpoint(blockedFamily, 'DEP'), endpoint(blockerFamily, 'BLOCK')));
      expect(await edgeCount()).toBe(0);
    },
  );

  it.each(['wip', 'in_progress', 'validating'])('rejects a new unresolved blocker behind status %s', async (status) => {
    await seedItem('DEP', { status });
    await seedItem('BLOCK');

    await expectLifecycleAdmissionRejected(addEdge(endpoint('issue', 'DEP'), endpoint('issue', 'BLOCK')));
    expect(await edgeCount()).toBe(0);
  });

  it('allows retained history behind a terminal dependant (the terminal advisory control)', async () => {
    await seedItem('DEP', { status: 'done', takenBy: 'stale-holder' });
    await seedItem('BLOCK');

    await expect(addEdge(endpoint('issue', 'DEP'), endpoint('issue', 'BLOCK'))).resolves.toBeDefined();
    expect(await edgeCount()).toBe(1);
  });

  it.each(['issue', 'feature'] as const)(
    'allows an explicitly blocked %s dependant to retain its claim while its blocker is recorded',
    async (blockedFamily) => {
      await seedItem('DEP', { family: blockedFamily, status: 'blocked', takenBy: 'su-blocked' });
      await seedItem('BLOCK');

      await expect(addEdge(endpoint(blockedFamily, 'DEP'), endpoint('issue', 'BLOCK'))).resolves.toBeDefined();
      expect(await edgeCount()).toBe(1);
    },
  );

  it('allows a satisfied terminal blocker behind an active dependant because reachability does not change', async () => {
    await seedItem('DEP', { takenBy: 'su-active' });
    await seedItem('BLOCK', { status: 'done' });

    await expect(addEdge(endpoint('issue', 'DEP'), endpoint('issue', 'BLOCK'))).resolves.toBeDefined();
    expect(await edgeCount()).toBe(1);
  });
});

// @covers INV-19
describe('P-011 named claim, progress, settle, and removal ordering', () => {
  it('preserves the named-claim override but refuses active progress behind the live blocker', async () => {
    await seedItem('DEP');
    await seedItem('BLOCK');
    await addEdge(endpoint('issue', 'DEP'), endpoint('issue', 'BLOCK'));

    // This is the unified base-table transition underlying both claim views. It
    // deliberately succeeds despite the edge; D-008's tool response separately warns.
    await db.sql`
      UPDATE harness_shared.work_items
         SET taken_by = 'su-named', taken_at = now()
       WHERE workspace_id = ${ITEM_WS} AND feature_id = 'DEP'`;
    expect(await itemState('DEP')).toMatchObject({ status: 'open', taken_by: 'su-named' });

    await expectPgGuardRejected(
      db.sql`
        UPDATE harness_shared.work_items
           SET status = 'wip'
         WHERE workspace_id = ${ITEM_WS} AND feature_id = 'DEP'`,
      /cannot move dependency dependant issue:DEP to status wip/i,
    );
    expect(await itemState('DEP')).toMatchObject({ status: 'open', taken_by: 'su-named' });
  });

  it('a blocker terminal transition makes the held dependant eligible to progress', async () => {
    await seedItem('DEP');
    await seedItem('BLOCK');
    await addEdge(endpoint('issue', 'DEP'), endpoint('issue', 'BLOCK'));
    await db.sql`
      UPDATE harness_shared.work_items
         SET taken_by = 'su-named', taken_at = now()
       WHERE workspace_id = ${ITEM_WS} AND feature_id = 'DEP'`;

    await db.sql`
      UPDATE harness_shared.work_items
         SET status = 'done'
       WHERE workspace_id = ${ITEM_WS} AND feature_id = 'BLOCK'`;
    await expect(
      db.sql`
        UPDATE harness_shared.work_items
           SET status = 'wip'
         WHERE workspace_id = ${ITEM_WS} AND feature_id = 'DEP'`,
    ).resolves.toBeDefined();
    expect(await itemState('DEP')).toMatchObject({ status: 'wip', taken_by: 'su-named' });
  });

  it('removing only one live blocker still refuses progress; removing the final blocker releases it', async () => {
    await seedItem('DEP');
    await seedItem('BLOCK-A');
    await seedItem('BLOCK-B');
    await mutate([
      { op: 'add', blocked: endpoint('issue', 'DEP'), blocker: endpoint('issue', 'BLOCK-A') },
      { op: 'add', blocked: endpoint('issue', 'DEP'), blocker: endpoint('issue', 'BLOCK-B') },
    ]);
    await db.sql`
      UPDATE harness_shared.work_items
         SET taken_by = 'su-named', taken_at = now()
       WHERE workspace_id = ${ITEM_WS} AND feature_id = 'DEP'`;

    await removeEdge(endpoint('issue', 'DEP'), endpoint('issue', 'BLOCK-A'));
    await expectPgGuardRejected(
      db.sql`
        UPDATE harness_shared.work_items
           SET status = 'wip'
         WHERE workspace_id = ${ITEM_WS} AND feature_id = 'DEP'`,
      /BLOCK-B/i,
    );

    await removeEdge(endpoint('issue', 'DEP'), endpoint('issue', 'BLOCK-B'));
    await expect(
      db.sql`
        UPDATE harness_shared.work_items
           SET status = 'wip'
         WHERE workspace_id = ${ITEM_WS} AND feature_id = 'DEP'`,
    ).resolves.toBeDefined();
    expect(await edgeCount()).toBe(0);
    expect(await itemState('DEP')).toMatchObject({ status: 'wip' });
  });
});

// @covers INV-19
describe('P-011/992 blocker reopen — untouched dependants pass, progressed dependants refuse', () => {
  it('992 allows reopen while the dependant is untouched, open, and unclaimed', async () => {
    await seedItem('DEP');
    await seedItem('BLOCK', { status: 'done' });
    await addEdge(endpoint('issue', 'DEP'), endpoint('issue', 'BLOCK'));

    await expect(
      db.sql`
        UPDATE harness_shared.work_items
           SET status = 'open'
         WHERE workspace_id = ${ITEM_WS} AND feature_id = 'BLOCK'`,
    ).resolves.toBeDefined();
    expect(await itemState('BLOCK')).toMatchObject({ status: 'open' });
  });

  it.each([
    ['claimed', { takenBy: 'su-holder' }],
    ['progress timestamp', { lastProgressAt: new Date('2026-08-27T00:00:00Z') }],
    ['active status', { status: 'wip' }],
    ['terminal status', { status: 'done' }],
  ] as const)('refuses reopen behind a dependant with %s', async (_label, dependantState) => {
    await seedItem('DEP', dependantState);
    await seedItem('BLOCK', { status: 'done' });
    await addEdge(endpoint('issue', 'DEP'), endpoint('issue', 'BLOCK'));

    await expectPgGuardRejected(
      db.sql`
        UPDATE harness_shared.work_items
           SET status = 'open'
         WHERE workspace_id = ${ITEM_WS} AND feature_id = 'BLOCK'`,
      /cannot make dependency blocker issue:BLOCK unsatisfied while nonterminal dependant issue:DEP remains/i,
    );
    expect(await itemState('BLOCK')).toMatchObject({ status: 'done' });
  });
});

describe('forward migration repairs previously applied dependency guards', () => {
  it('repairs an installed historical guard without changing the dependency edge', async () => {
    // Exact applied 992 from db commit 889df4ce; SHA256 c09f2a119b528d7d2bab7368ad611072596fa564c0007594954b57a0785855d4.
    // Both historical files in the current tree were edited after deployment.
    await applyMigrationForTest(db.sql, resolve(dirname(fileURLToPath(import.meta.url)),
      '../../test/fixtures/work-item-deps-992-applied.sql.fixture'));
    await seedItem('DEP');
    await seedItem('BLOCK', { status: 'done' });
    await addEdge(endpoint('issue', 'DEP'), endpoint('issue', 'BLOCK'));
    const reopen = () => db.sql`
      UPDATE harness_shared.work_items SET status = 'open'
       WHERE workspace_id = ${ITEM_WS} AND feature_id = 'BLOCK'`;
    try {
      await expectPgGuardRejected(reopen(), /cannot make dependency blocker/i);
      await applyMigrationForTest(db.sql, resolve(SQL_DIR, REOPEN_MIGRATION));
      await expect(reopen()).resolves.toBeDefined();
      expect(await itemState('BLOCK')).toMatchObject({ status: 'open' });
      expect(await edgeCount()).toBe(1);
    } finally {
      await applyMigrationForTest(db.sql, resolve(SQL_DIR, REOPEN_MIGRATION));
    }
  });

  it('preserves cleanup issue-family identity and progressed-dependant protection', async () => {
    await seedItem('DEP', { takenBy: 'su-holder' });
    await seedItem('BLOCK', { status: 'done' });
    await db.sql`UPDATE harness_shared.work_items SET item_kind = 'cleanup'
      WHERE workspace_id = ${ITEM_WS} AND feature_id IN ('DEP', 'BLOCK')`;
    await addEdge(endpoint('issue', 'DEP'), endpoint('issue', 'BLOCK'));
    await expectPgGuardRejected(
      db.sql`UPDATE harness_shared.work_items SET status = 'open'
        WHERE workspace_id = ${ITEM_WS} AND feature_id = 'BLOCK'`,
      /dependency blocker issue:BLOCK.*dependant issue:DEP/i,
    );
    expect(await itemState('BLOCK')).toMatchObject({ status: 'done' });
    expect(await edgeCount()).toBe(1);
  });
});

// @covers INV-19
describe('P-011 endpoint deletion and re-home stay graph-aware', () => {
  it('refuses endpoint deletion until its incident edge is explicitly removed', async () => {
    await seedItem('DEP');
    await seedItem('BLOCK');
    await addEdge(endpoint('issue', 'DEP'), endpoint('issue', 'BLOCK'));

    let deletionError: unknown;
    try {
      await db.sql`
        DELETE FROM harness_shared.work_items
         WHERE workspace_id = ${ITEM_WS} AND feature_id = 'BLOCK'`;
    } catch (caught) {
      deletionError = caught;
    }
    expect((deletionError as { code?: string } | undefined)?.code).toBe('23503');
    expect(String((deletionError as Error | undefined)?.message)).toMatch(
      /cannot delete dependency endpoint issue:BLOCK/i,
    );

    await removeEdge(endpoint('issue', 'DEP'), endpoint('issue', 'BLOCK'));
    await expect(
      db.sql`
        DELETE FROM harness_shared.work_items
         WHERE workspace_id = ${ITEM_WS} AND feature_id = 'BLOCK'`,
    ).resolves.toBeDefined();
  });

  it('re-points a feature dependant on re-home and applies the lifecycle guard to its new identity', async () => {
    await seedItem('DEP-F', { family: 'feature', harness: 'old-harness' });
    await seedItem('BLOCK');
    await addEdge(endpoint('feature', 'DEP-F', 'old-harness'), endpoint('issue', 'BLOCK'));

    await db.sql`
      UPDATE harness_shared.work_items
         SET harness_slug = 'new-harness'
       WHERE workspace_id = ${ITEM_WS} AND feature_id = 'DEP-F'`;
    const [edge] = await db.sql<Array<{ blocked_ref: string }>>`
      SELECT blocked_ref
        FROM harness_shared.work_item_deps
       WHERE workspace_id = ${EDGE_WS}`;
    expect(edge?.blocked_ref).toBe('new-harness#DEP-F');

    await expectPgGuardRejected(
      db.sql`
        UPDATE harness_shared.work_items
           SET status = 'wip'
         WHERE workspace_id = ${ITEM_WS} AND feature_id = 'DEP-F'`,
      /feature:new-harness#DEP-F/i,
    );
    expect(await itemState('DEP-F')).toMatchObject({ harness_slug: 'new-harness', status: 'open' });
  });
});
