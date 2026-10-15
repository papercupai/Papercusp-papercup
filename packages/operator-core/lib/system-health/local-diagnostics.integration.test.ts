import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { FLAGS } from '@papercusp/flags';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { runWithWorkspace, currentRequestWorkspaceId } from '../workspace-als';
import { LiveHealthMonitor, type LiveHealthPaths } from '../resource-governor/live-health-monitor';
import { writeSharedSnapshot } from '../derived-reads/shared-snapshot';
import { computeSystemHealth, getSystemHealth, _resetSystemHealthCache } from './compute';
import { resolveNamedQueryV2 } from '../sync-resolver';

let db: OrgTestDb;
let readSql: Sql;
let localRoot: string;
const paths = new Map<string, LiveHealthPaths>();

// Keep the established migrated test database, substituting only its connection.
// The final reads use the real harness_app principal and authorized request scope.
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: readSql }),
}));
vi.mock('@papercusp/flags/server', async importOriginal => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: async (key: string) => key === FLAGS.SYSTEM_HEALTH_TAB || key === FLAGS.PRECOMPUTE_DERIVED_READS,
}));
vi.mock('../resource-governor/live-health-monitor', async importOriginal => {
  const original = await importOriginal<typeof import('../resource-governor/live-health-monitor')>();
  return { ...original, readLiveHealthSnapshot: (_paths: unknown, now: number) => {
    const local = paths.get(currentRequestWorkspaceId()!);
    if (!local) throw new Error('no local resource fixture for selected workspace');
    return original.readLiveHealthSnapshot(local, now);
  } };
});

beforeAll(async () => {
  db = await createOrgTestDb();
  readSql = db.adminSql;
  localRoot = await mkdtemp(join(tmpdir(), 'byoc-local-health-'));
});
afterAll(async () => {
  _resetSystemHealthCache();
  await db?.cleanup();
  if (localRoot) await rm(localRoot, { recursive: true, force: true });
}, 300_000);

it('serves each BYOC workspace its recorded provider failure and local resource health through the existing Health reader', async () => {
  const fixtures = [
    { workspace: 'byoc-local-a', tool: 'task:provider-a', error: 'provider-a refused the local task', cpuPsi: 90, memoryPsi: 0, memoryFull: 0 },
    { workspace: 'byoc-local-b', tool: 'task:provider-b', error: 'provider-b timed out on its local task', cpuPsi: 0, memoryPsi: 20, memoryFull: 8 },
  ];
  for (const fixture of fixtures) {
    const rootDir = join(localRoot, fixture.workspace);
    const local = { rootDir, fragmentsDir: join(rootDir, 'fragments'), snapshotPath: join(rootDir, 'live-health.json') };
    paths.set(fixture.workspace, local);
    const monitor = new LiveHealthMonitor({ paths: local, readFragments: async () => [],
      collectHost: async () => ({ atMs: Date.now(), cpu: null, totalMemoryBytes: 1024, freeMemoryBytes: 256,
        cpuPsi: { some60: fixture.cpuPsi, full60: null },
        memoryPsi: { some60: fixture.memoryPsi, full60: fixture.memoryFull },
        ioPsi: { some60: 0, full60: 0 }, scheduler: { runnable: 0, blocked: 0 },
        memoryKernel: { swapUsedBytes: 0, swapInPages: 0, swapOutPages: 0 },
        network: null, closeWaitCount: 0, diskFreeBytes: 1024 }) });
    await monitor.sampleOnce();
    await db.adminSql`INSERT INTO harness_shared.tool_invocations
      (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status, error_code, error_message)
      SELECT ${fixture.workspace}, 'local-diagnostics', 'fixture', ${fixture.tool}, 'su', 'local-fixture',
        'local-fixture', 'error', 'provider_error', ${fixture.error} FROM generate_series(1, 5)`;
  }
  for (const fixture of fixtures) {
    const health = await runWithWorkspace(fixture.workspace, () => computeSystemHealth());
    const infra = health.panels.infra;
    expect(infra.error).toBeUndefined();
    expect(infra.data?.toolFailures?.brokenTools).toEqual([fixture.tool]);
    expect(infra.data?.toolFailures?.evidence).toContain(fixture.error);
    expect(infra.data?.toolFailures?.totalCalls).toBe(5);
    expect(infra.data?.hostPressure).toMatchObject({ status: 'crit', cpuPsiSomePct: fixture.cpuPsi,
      memoryPsiSomePct: fixture.memoryPsi, memoryPsiFullPct: fixture.memoryFull });
    await writeSharedSnapshot('system.health', fixture.workspace, health, 1);
  }
  for (const fixture of fixtures) {
    const foreign = fixtures.find(value => value !== fixture)!;
    await db.appSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${fixture.workspace}, true)`;
      readSql = tx as unknown as Sql;
      _resetSystemHealthCache();
      // There is no new diagnostic endpoint, table, destination, or export grant.
      const health = await runWithWorkspace(fixture.workspace, () => getSystemHealth());
      expect(health?.workspaceId).toBe(fixture.workspace);
      expect(health?.panels.infra.data?.toolFailures?.brokenTools).toEqual([fixture.tool]);
      expect(health?.panels.infra.data?.hostPressure).toMatchObject({ cpuPsiSomePct: fixture.cpuPsi,
        memoryPsiSomePct: fixture.memoryPsi, memoryPsiFullPct: fixture.memoryFull });
      expect(JSON.stringify(health)).not.toContain(foreign.error);
      expect(JSON.stringify(health)).not.toContain(foreign.tool);
      // Auth supplies the request workspace. A caller's query args must not
      // redirect the named query into a different workspace's local snapshot.
      const rows = await runWithWorkspace(fixture.workspace, () =>
        resolveNamedQueryV2('health.snapshot', { workspaceId: foreign.workspace }));
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toEqual([health]);
      expect(JSON.stringify(rows)).not.toContain(foreign.tool);
    });
    readSql = db.adminSql;
  }
}, 120_000);
