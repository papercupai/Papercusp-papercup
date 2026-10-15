/** Actual canonical rig contracts: schema, identity, scoped CDC and cleanup.
 *  WI-10006495 replaces the private-DDL guards with real PostgreSQL checks. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, orgTemplateKey } from '../../test/_org-test-db';
import { bootCompositionRig, type CompositionRig } from './composition-rig';
import { coordCellSetup, presenceCellSetup } from './federated-cell-setup';
import { claimFloorsWhereSql } from '../work-items';

const observations = vi.hoisted(() => ({ provisioningMs: [] as number[] }));
vi.mock('../../test/_org-test-db', async (original) => {
  const actual = await original<typeof import('../../test/_org-test-db')>();
  return { ...actual, createOrgTestDb: vi.fn(async (...args: Parameters<typeof actual.createOrgTestDb>) => {
    const start = performance.now();
    const db = await actual.createOrgTestDb(...args);
    observations.provisioningMs.push(performance.now() - start);
    return db;
  }) };
});
vi.mock('@papercusp/db-org', async (original) => {
  const actual = await original<typeof import('@papercusp/db-org')>();
  const { currentCellSql } = await import('./cell-scope');
  return { ...actual, getOrgPg: () => {
    const sql = currentCellSql();
    if (!sql) throw new Error('getOrgPg outside cell scope');
    return { sql };
  } };
});

const HERE = dirname(fileURLToPath(import.meta.url));
const featureWriter = readFileSync(resolve(HERE, '../sync/hyperbee/projections/harness-features.ts'), 'utf8');
const featureColumns = featureWriter.match(/INSERT INTO harness_shared\.work_items\s*\(([\s\S]*?)\)\s*VALUES/)![1]
  .split(',').map((column) => column.trim());
const issueReader = readFileSync(resolve(HERE, '../issues-engineer.ts'), 'utf8');
const issueColumns = issueReader.match(/const ISSUE_COLS\s*=\s*`([\s\S]*?)`/)![1]
  .split(',').map((column) => column.trim());
const retainedMigrations = [
  '992-work-item-dependency-satisfaction.sql',
  '994-work-item-dependency-resync-contention-guard.sql',
  '996-work-item-completion-settlement-readiness.sql',
  '1087-align-blocker-ref-indexability.sql',
];

interface DatabaseCleanupDisposition {
  datname: string;
  marker: string | null;
  active_connections: number;
  active_drop: boolean;
}

async function databaseCleanupDisposition(names: string[]): Promise<DatabaseCleanupDisposition[]> {
  const sql = postgres(await getTestPg(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    return await sql<DatabaseCleanupDisposition[]>`
      SELECT d.datname, c.description AS marker,
        (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname = d.datname) AS active_connections,
        EXISTS (SELECT 1 FROM pg_stat_activity a
          WHERE a.state = 'active' AND a.datname = current_database()
            AND a.query = 'DROP DATABASE IF EXISTS "' || d.datname || '" WITH (FORCE)') AS active_drop
      FROM pg_database d
      LEFT JOIN pg_shdescription c ON c.objoid = d.oid AND c.classoid = 'pg_database'::regclass
      WHERE d.datname::text = ANY(${sql.array(names, 1009)}::text[])`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function assertManagedCleanup(rows: DatabaseCleanupDisposition[]): void {
  for (const row of rows) {
    expect(row.active_connections, row.datname + ': cell connections must close').toBe(0);
    expect(row.marker === 'papercusp-test-db-drop-deferred' || row.active_drop,
      row.datname + ': a remaining database must have an explicit queued or active DROP').toBe(true);
  }
}

async function expectManagedCleanup(names: string[]): Promise<void> {
  // createFreshTestDb.drop() deliberately permits queued or detached drops.
  // Verify that exact lifecycle contract rather than treating a caller return
  // as proof of deletion. Ordinary managed markers do NOT qualify as cleanup.
  await vi.waitFor(async () => {
    assertManagedCleanup(await databaseCleanupDisposition(names));
  }, { timeout: 5_000, interval: 100 });
}

describe('composition rig uses current canonical schema, preserving its cell contracts', () => {
  let rig: CompositionRig;
  const databases: string[] = [];
  const extraSetupCells: string[] = [];

  beforeAll(async () => {
    rig = await bootCompositionRig({ extraCellSetup: async (sql) => {
      const [row] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
      extraSetupCells.push(row.name);
      await coordCellSetup(sql);
      await presenceCellSetup(sql);
    } });
    for (const cell of Object.values(rig.cells)) {
      const [row] = await cell.sql<{ name: string }[]>`SELECT current_database() AS name`;
      databases.push(row.name);
    }
    console.info('canonical-rig-adoption', JSON.stringify({
      templateKey: orgTemplateKey(), provisioningMs: observations.provisioningMs, databases,
      coldBuildCost: 'unmeasured: global setup may have warmed the template',
    }));
  }, 240_000);

  afterAll(async () => {
    await rig?.close();
    await expectManagedCleanup(databases);
  }, 60_000);

  it('provisions two independent cells through the maintained migration-keyed factory', async () => {
    expect(createOrgTestDb).toHaveBeenCalledTimes(2);
    expect(createOrgTestDb).toHaveBeenNthCalledWith(1, { adminPoolMax: 4 });
    expect(createOrgTestDb).toHaveBeenNthCalledWith(2, { adminPoolMax: 4 });
    expect(new Set(databases).size).toBe(2);
    expect(extraSetupCells).toEqual(databases);
    for (const cell of Object.values(rig.cells)) {
      const rows = await cell.sql<{ filename: string; sha256: string }[]>`
        SELECT filename, sha256 FROM harness_shared.schema_migrations
        WHERE filename = ANY(${cell.sql.array(retainedMigrations, 1009)}::text[]) ORDER BY filename`;
      expect(rows.map((row) => row.filename)).toEqual([...retainedMigrations].sort());
      expect(rows.every((row) => /^[a-f0-9]{64}$/.test(row.sha256))).toBe(true);
      const [column] = await cell.sql`SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'harness_shared' AND table_name = 'work_item_deps' AND column_name = 'satisfaction'`;
      expect(column?.column_default).toBe("'settled'::text");
    }
  });

  it('supplies every production feature write and issue read column on both actual rig cells', async () => {
    expect(featureColumns.length).toBeGreaterThanOrEqual(40);
    expect(issueColumns.length).toBeGreaterThan(15);
    for (const cell of Object.values(rig.cells)) {
      await expect(cell.sql.unsafe('SELECT ' + featureColumns.join(',') + ' FROM harness_shared.work_items WHERE false'))
        .resolves.toHaveLength(0);
      await expect(cell.sql.unsafe('SELECT ' + issueColumns.join(',') + ' FROM harness_shared.engineer_issues WHERE false'))
        .resolves.toHaveLength(0);
    }
  });

  it('CONTROL: missing admission still fails the actual writer-column contract (WI-10005120)', async () => {
    const sql = rig.cells.a.sql;
    await expect(sql.begin(async (tx) => {
      await tx.unsafe('ALTER TABLE harness_shared.work_items DROP COLUMN admission CASCADE');
      await tx.unsafe('SELECT ' + featureColumns.join(',') + ' FROM harness_shared.work_items WHERE false');
    })).rejects.toMatchObject({ code: '42703' });
    await expect(sql.unsafe('SELECT ' + featureColumns.join(',') + ' FROM harness_shared.work_items WHERE false'))
      .resolves.toHaveLength(0);
  });

  it('CONTROL: missing satisfaction rejects the real readiness predicate and rollback restores it', async () => {
    const sql = rig.cells.a.sql;
    const readinessQuery = (client: postgres.Sql) => client`
      SELECT feature_id FROM harness_shared.harness_features_consolidated
      WHERE ${claimFloorsWhereSql(client, {
        harness: rig.harnessSlug,
        workspaceId: rig.workspaceId,
        excludeRedundant: true,
        useMaintainedReady: false,
        cooldownAssignee: rig.cells.a.owner,
      })} LIMIT 0`;

    await expect(readinessQuery(sql)).resolves.toEqual([]);
    await expect(sql.begin(async (tx) => {
      await tx.unsafe('ALTER TABLE harness_shared.work_item_deps DROP COLUMN satisfaction CASCADE');
      await readinessQuery(tx as unknown as postgres.Sql);
    })).rejects.toMatchObject({ code: '42703', message: expect.stringContaining('satisfaction') });
    // The failed transaction restores the canonical column, triggers and default.
    await expect(readinessQuery(sql)).resolves.toEqual([]);
    const [column] = await sql`SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'harness_shared' AND table_name = 'work_item_deps' AND column_name = 'satisfaction'`;
    expect(column?.column_default).toBe("'settled'::text");
  });

  it('preserves canonical parent/member identity and constraints', async () => {
    for (const cell of Object.values(rig.cells)) {
      const peer = cell.name === 'a' ? rig.cells.b : rig.cells.a;
      const [member] = await cell.sql`SELECT m.pot_home_slug, m.github_user_id, m.github_username, m.device_attestations
        FROM harness_shared.pot_members m JOIN harness_shared.pots p USING (workspace_id, pot_home_slug)
        WHERE m.workspace_id = ${rig.workspaceId} AND m.github_user_id = ${peer.githubUserId}`;
      expect(member).toMatchObject({ pot_home_slug: rig.potSlug, github_user_id: peer.githubUserId,
        github_username: 'swarm-' + peer.name, device_attestations: [{ device_pubkey: peer.handle.ownLog.keyHex }] });
      await expect(cell.sql`INSERT INTO harness_shared.pot_members
        (workspace_id, github_user_id, binding_status, device_attestations, revoked_pubkeys)
        VALUES (${rig.workspaceId}, 4203, 'verified', '[]'::jsonb, ARRAY[]::text[])`)
        .rejects.toMatchObject({ code: '23502', column_name: 'pot_home_slug' });
    }
  });

  it('retains seed CDC scopes while depth counts the driven harness stream', async () => {
    for (const cell of Object.values(rig.cells)) {
      const membership = await cell.sql`SELECT harness_slug FROM harness_shared.substrate_outbox
        WHERE workspace_id = ${rig.workspaceId} AND table_name = 'pot_members'`;
      expect(membership.length).toBeGreaterThan(0);
      expect(membership.every((row) => row.harness_slug === rig.potSlug)).toBe(true);
      const seededPlans = await cell.sql`SELECT id FROM harness_shared.substrate_outbox
        WHERE table_name = 'harness_plans' AND harness_slug = 'papercusp'`;
      expect(seededPlans.length).toBeGreaterThan(0);
      const [scoped] = await cell.sql`SELECT count(*)::int AS n FROM harness_shared.substrate_outbox
        WHERE workspace_id = ${rig.workspaceId} AND harness_slug = ${rig.harnessSlug} AND drained_at IS NULL`;
      expect(await rig.outboxDepth(cell)).toBe(scoped.n);
    }
  });

  it('federates canonical backlog and dispatches through readiness and authority', async () => {
    const { a, b } = rig.cells;
    await rig.seedBacklog(a, [{ id: 'F-CANONICAL-ADOPTION' }]);
    expect((await rig.converge()).fixedPoint).toBe(true);
    expect(await rig.readBacklog(b)).toEqual([expect.objectContaining({
      feature_id: 'F-CANONICAL-ADOPTION', origin: 'remote', item_kind: 'feature',
    })]);
    const [row] = await a.sql`SELECT nature, admission, fed_hlc FROM harness_shared.work_items
      WHERE feature_id = 'F-CANONICAL-ADOPTION'`;
    expect(row.nature).toBe('work');
    expect(row.admission).toBeNull();
    expect(row.fed_hlc).toBeTruthy();
    const claims = await Promise.all([rig.claimNext(a), rig.claimNext(b)]);
    expect(claims.every((claim) => claim?.item.id === 'F-CANONICAL-ADOPTION')).toBe(true);
    expect(claims.filter((claim) => claim?.leased)).toHaveLength(1);
    expect(claims[1]?.via).toBe('remote-authority');
    const winner = claims[0]?.leased ? a : b;
    const loser = winner === a ? b : a;
    await rig.runFakePipeline(winner, 'F-CANONICAL-ADOPTION');
    expect((await rig.converge()).fixedPoint).toBe(true);
    expect(await rig.sideEffects(winner)).toHaveLength(1);
    expect(await rig.sideEffects(loser)).toEqual([]);
    for (const cell of [a, b]) {
      expect(await cell.sql`SELECT id FROM harness_shared.substrate_outbox WHERE table_name = 'rig_side_effects'`).toEqual([]);
      expect(await rig.outboxDepth(cell)).toBe(0);
    }
  });

  it('closes both cloned databases through managed cleanup and restores the workspace after extra setup fails', async () => {
    const workspaceBefore = process.env.PAPERCUSP_WORKSPACE_ID;
    await expect(bootCompositionRig({
      workspaceId: 'ws-failed-canonical-rig',
      extraCellSetup: async () => { throw new Error('extra setup failed'); },
    })).rejects.toThrow('extra setup failed');
    const failedDbs = await Promise.all(vi.mocked(createOrgTestDb).mock.results.slice(-2).map((result) => result.value));
    await expectManagedCleanup(failedDbs.map((db) => db.dbName));
    expect(process.env.PAPERCUSP_WORKSPACE_ID).toBe(workspaceBefore);
  }, 60_000);

  it('CONTROL: an unclosed canonical clone is rejected by the cleanup detector', async () => {
    const db = await createOrgTestDb({ adminPoolMax: 4 });
    try {
      await db.adminSql`SELECT 1`;
      const pending = await databaseCleanupDisposition([db.dbName]);
      expect(pending).toHaveLength(1);
      expect(pending[0].active_connections).toBeGreaterThan(0);
      expect(() => assertManagedCleanup(pending)).toThrow();
    } finally {
      await db.cleanup();
    }
    await expectManagedCleanup([db.dbName]);
  }, 60_000);
});
