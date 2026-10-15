/**
 * lifecycle-judgement.integration.test.ts — the REAL `listOpenCandidateItems` query against a
 * FULLY migrated schema (WI-10005157).
 *
 * The query used to select and filter an `assignee` column that harness_shared.work_items has
 * never had: only the engineer_issues VIEW exposes it, as `taken_by AS assignee`. Every unit test
 * drives a FAKE listOpenCandidateItems, and the one source-text assertion pinned the bad predicate,
 * so nothing noticed that every real bg-host sweep threw 42703 (277 times on 2026-10-01) — the
 * catch in task-reconcile-action swallowed it to a console.warn, and the lifecycle judge never ran.
 *
 * A column that does not exist is only caught by a real round-trip against the REAL migration
 * chain (not a hand-picked subset), so that is what this file does.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..', '..');
const SQL_DIR = join(REPO, 'libs', 'papercusp', 'libs', 'db', 'sql');
const RUNNER = join(REPO, 'libs', 'papercusp', 'packages', 'embedded-postgres-server', 'src', 'migration-runner.js');

const WS = 'lifecycle-judgement-it';

let db: MigratedTestDb;
let sql: Sql;

// The code under test reaches its connection through getOrgPg() at call time. PARTIAL mock, so
// every other real export of the module survives.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql }),
}));

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
  sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });
}, 600_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

beforeEach(async () => {
  // NOT engineer_issues: it is a VIEW over work_items, so clearing work_items clears it.
  await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS}`;
});

async function insertItem(
  id: string,
  kind: 'task' | 'feature',
  opts: { takenBy?: string | null; status?: string; taskId?: string | null } = {},
): Promise<void> {
  const payload =
    opts.taskId === null ? {} : { processLifecycleCandidate: { taskId: opts.taskId ?? `task-${id}` } };
  await sql`
    INSERT INTO harness_shared.work_items
      (feature_id, workspace_id, harness_slug, nature, item_kind, status, taken_by, payload)
    VALUES
      (${id}, ${WS}, 'papercusp', 'work', ${kind}, ${opts.status ?? 'open'}, ${opts.takenBy ?? null},
       ${sql.json(payload)})
  `;
}

describe('nodeLifecycleJudgementDeps.listOpenCandidateItems against the real migrated schema (WI-10005157)', () => {
  it('runs without a missing-column error and returns only unclaimed, non-terminal candidates in either family', async () => {
    await insertItem('WI-free-issue', 'task');
    await insertItem('WI-held-issue', 'task', { takenBy: 'queen-a' });
    await insertItem('WI-free-feature', 'feature');
    await insertItem('WI-held-feature', 'feature', { takenBy: 'queen-b' });
    await insertItem('WI-done-issue', 'task', { status: 'done' });
    await insertItem('WI-not-a-candidate', 'task', { taskId: null });

    const { nodeLifecycleJudgementDeps } = await import('./lifecycle-judgement');
    const items = await nodeLifecycleJudgementDeps.listOpenCandidateItems(WS);

    expect(items.map((item) => item.id).sort()).toEqual(['WI-free-feature', 'WI-free-issue']);
    for (const item of items) {
      expect(item.taskId).toBe(`task-${item.id}`);
      expect(item.takenBy ?? null).toBeNull();
    }
  });

  it('pins the premise the fix rests on: the issue VIEW names taken_by as assignee', async () => {
    await insertItem('WI-held-issue', 'task', { takenBy: 'queen-a' });
    const viewRows = await sql<Array<{ assignee: string | null }>>`
      SELECT assignee FROM harness_shared.engineer_issues WHERE issue_id = 'WI-held-issue'
    `;
    expect(viewRows.map((row) => row.assignee)).toEqual(['queen-a']);
    const baseColumns = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'harness_shared' AND table_name = 'work_items'
         AND column_name IN ('assignee', 'taken_by')
    `;
    expect(baseColumns.map((row) => row.column_name)).toEqual(['taken_by']);
  });
});

describe('nodeLifecycleJudgementDeps.readLatestVerdicts against the real migrated schema', () => {
  it('uses decision time when a stale candidate row was refreshed after the latest verdict', async () => {
    const taskId = 'task-stale-verdict-order';
    const earlier = {
      taskId,
      decision: 'keep',
      reason: 'earlier decision',
      keepCount: 1,
      recheckAt: '2026-09-30T08:00:00.000Z',
      decidedAt: '2026-09-29T20:08:00.000Z',
    };
    const latest = {
      taskId,
      decision: 'keep',
      reason: 'latest decision',
      keepCount: 2,
      recheckAt: '2026-10-01T08:00:00.000Z',
      decidedAt: '2026-09-30T08:06:00.000Z',
    };
    const earlierUpdatedTs = Date.parse('2026-10-02T00:00:00.000Z');
    const latestUpdatedTs = Date.parse('2026-10-01T00:00:00.000Z');

    await sql`
      INSERT INTO harness_shared.work_items
        (feature_id, workspace_id, harness_slug, nature, item_kind, status, payload, updated_ts)
      VALUES
        ('WI-earlier-verdict', ${WS}, 'papercusp', 'work', 'task', 'done',
         ${sql.json({ processLifecycleCandidate: { taskId }, out: { processLifecycleVerdict: earlier } })},
         ${earlierUpdatedTs}),
        ('WI-latest-verdict', ${WS}, 'papercusp', 'work', 'task', 'done',
         ${sql.json({ processLifecycleCandidate: { taskId }, out: { processLifecycleVerdict: latest } })},
         ${latestUpdatedTs})
    `;

    const refreshedRows = await sql<Array<{ id: string }>>`
      SELECT feature_id AS id
        FROM harness_shared.work_items
       WHERE workspace_id = ${WS}
         AND feature_id IN ('WI-earlier-verdict', 'WI-latest-verdict')
       ORDER BY updated_ts DESC
    `;
    expect(refreshedRows.map((row) => row.id)).toEqual(['WI-earlier-verdict', 'WI-latest-verdict']);

    const { nodeLifecycleJudgementDeps } = await import('./lifecycle-judgement');
    const verdicts = await nodeLifecycleJudgementDeps.readLatestVerdicts(WS, [taskId]);

    expect(verdicts.get(taskId)).toMatchObject({ keepCount: 2, decidedAt: latest.decidedAt });
  });
});
