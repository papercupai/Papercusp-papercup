import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../../test/_work-items-schema';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  workspace: 'delta-action-ws',
}));

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

vi.mock('../../workspace-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workspace-registry')>();
  return { ...actual, activeWorkspaceId: () => h.workspace };
});

vi.mock('../../agent-tools/coordination/log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-tools/coordination/log')>();
  return {
    ...actual,
    coordScopeReady: async () => undefined,
    coordScopeWorkspace: () => h.workspace,
  };
});

vi.mock('./system-actions', () => ({ registerSystemAction: vi.fn() }));

const { productionLinkUmbrella } = await import('./work-item-admission-delta-sweep-action');

const HARNESS = 'papercusp';
const SOURCE_IDS = ['EI-delta-source-1', 'EI-delta-source-2'];
const UMBRELLA_ID = 'EI-delta-umbrella';

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('work-item-admission-delta-sweep-action');
  await ensureCoordCapabilityTables(db.sql);
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  h.sql = db.sql;
}, 90_000);

afterAll(async () => db?.cleanup(), 60_000);

beforeEach(async () => {
  h.workspace = 'delta-action-ws';
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.coord_links RESTART IDENTITY`;
  for (const id of [...SOURCE_IDS, UMBRELLA_ID]) {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, payload, created_ts, updated_ts)
      VALUES
        (${h.workspace}, ${HARNESS}, ${id}, ${id}, 'delta-sweep action fixture', 'open', 'bug', '{}'::jsonb,
         1787745600000, 1787745600000)`;
  }
});

describe('work-item admission delta-sweep production linker (real PostgreSQL)', () => {
  it('persists neutral related issue edges in the active coord workspace', async () => {
    const written = await productionLinkUmbrella({
      runId: 'delta-action-run',
      workspaceId: h.workspace,
      harnessSlug: HARNESS,
      umbrellaId: UMBRELLA_ID,
      sourceIds: SOURCE_IDS,
    });

    expect(written).toBe(SOURCE_IDS.length);
    const rows = await db.sql<
      Array<{
        workspace_id: string;
        src_kind: string;
        src_ref: string;
        dst_kind: string;
        dst_ref: string;
        rel: string;
        created_by: string | null;
      }>
    >`
      SELECT workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel, created_by
        FROM harness_shared.coord_links
       ORDER BY src_ref`;

    expect(rows).toEqual(
      SOURCE_IDS.map((sourceId) => ({
        workspace_id: h.workspace,
        src_kind: 'issue',
        src_ref: sourceId,
        dst_kind: 'issue',
        dst_ref: UMBRELLA_ID,
        rel: 'relates',
        created_by: 'system:work-item-admission-delta-sweep',
      })),
    );
  }, 60_000);
});
