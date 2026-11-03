import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OrgTestDb } from '../../test/_org-test-db';
import { assertWorkPerfIsolation, seedWorkPerfFixture } from '../../../../scripts/lib/desktop-work-perf-fixture';

const dbRef = vi.hoisted(() => ({ sql: null as any }));
vi.mock('@papercusp/db-org', async orig => ({ ...await orig<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: dbRef.sql }) }));
let db: OrgTestDb;
let server: ChildProcess;
let root: string;
let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  const { createOrgTestDb } = await import('../../test/_org-test-db');
  db = await createOrgTestDb();
  dbRef.sql = db.adminSql;
  root = mkdtempSync(path.join(tmpdir(), 'work-perf-fixture-'));
  env = { ...process.env, VERIFY_TAURI_ISOLATED_DB: '1', PAPERCUSP_VERIFY_TAURI_ISOLATED: '1',
    PAPERCUSP_HOME: root + '/papercusp-home', PAPERCUSP_WORKSPACE: 'verify-tauri-isolated-999',
    PAPERCUSP_WORKSPACE_ID: 'verify-tauri-isolated-999',
    HARNESS_ADMIN_DATABASE_URL: db.adminDsn, HARNESS_DATABASE_URL: db.appDsn,
    VERIFY_TAURI_PORT: '49999', OPERATOR_DEV_PORT: '49999' };
  for (const key of ['PAPERCUSP_WORKSPACE', 'PAPERCUSP_WORKSPACE_ID', 'PAPERCUSP_HOME', 'HARNESS_ADMIN_DATABASE_URL',
    'HARNESS_DATABASE_URL']) vi.stubEnv(key, env[key]!);
  // Only the preflight's process-environment identity is needed here; the
  // route/store behavior below runs against the real isolated Postgres.
  server = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env, stdio: 'ignore' });
  env.VERIFY_TAURI_PID = String(server.pid);
});
afterAll(async () => {
  server?.kill();
  await db?.cleanup();
  if (root) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('private native work journey fixture', () => {
  it('the documented tsx CLI refuses an ambient process without loading stores', () => {
    const cli = spawnSync(process.execPath, ['--import', 'tsx',
      path.resolve(import.meta.dirname, '../../../../scripts/lib/desktop-work-perf-fixture.ts')], {
      cwd: path.resolve(import.meta.dirname, '../../../..'),
      env: { ...process.env, VERIFY_TAURI_PID: '', VERIFY_TAURI_ISOLATED_DB: '' },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(cli.status).toBe(1);
    // test:file's inherited source guard can refuse a transformed CJS module
    // before our preflight. Both are containment; neither is a native pass.
    expect(cli.stderr).toMatch(/Private work performance fixture setup failed|COMMITTED_SOURCE refused/);
    expect(cli.stderr).not.toContain('TypeError');
    expect(cli.stdout).not.toContain('phase=stores-loaded');
  });

  it('refuses ambient/shared or mismatched runtime identities before writes', () => {
    assertWorkPerfIsolation(env, env);
    for (const patch of [{ VERIFY_TAURI_ISOLATED_DB: '0' }, { PAPERCUSP_WORKSPACE: 'default' },
      { PAPERCUSP_WORKSPACE_ID: 'other' },
      { PAPERCUSP_HOME: '/home/test/.papercusp' }, { VERIFY_TAURI_PID: '../bad' },
      { HARNESS_DATABASE_URL: 'postgresql://localhost:5432/live' }]) {
      expect(() => assertWorkPerfIsolation({ ...env, ...patch }, env)).toThrow();
    }
    expect(() => assertWorkPerfIsolation(env, { ...env, OPERATOR_DEV_PORT: '49998' })).toThrow();
    expect(() => assertWorkPerfIsolation(env, { ...env, HARNESS_ADMIN_DATABASE_URL: 'other' })).toThrow();
  });

  it('persists a private Hive plan and offer, then authenticates a distinct claimant through the real session store', async () => {
    const fixture = await seedWorkPerfFixture(env);
    const { login, getSessionUser, SESSION_COOKIE } = await import('../auth');
    const { getHumanMarketItem, actOnHumanMarketItem } = await import('../work-items-human-market-store');
    const { humanAssignee, readHumanMarketJob } = await import('../work-items-human-market');
    const { hasActiveStrictHumanAsk } = await import('../hold-registry');
    const { getPlanRow } = await import('../agent-tools/plans/source');
    const plan = await getPlanRow(fixture.planSlug, { workspaceId: fixture.workspace, harnessSlug: fixture.harness });
    expect(plan).toMatchObject({ planSlug: fixture.planSlug, harnessSlug: fixture.harness,
      workspaceId: fixture.workspace, status: 'draft' });
    expect(plan?.content).toContain('Open this persisted body through the product plan reader.');
    expect(await getPlanRow(fixture.planSlug, { workspaceId: fixture.workspace, harnessSlug: 'papercusp' })).toBeNull();
    const session = await login(fixture.username, null, { workspace_id: fixture.workspace });
    const human = await getSessionUser(new Headers({ cookie: SESSION_COOKIE + '=' + session.token }));
    expect(human?.workspace_id).toBe(fixture.workspace);
    const scope = { workspaceId: fixture.workspace, harness: fixture.harness, id: fixture.itemId };
    const before = await getHumanMarketItem(scope);
    expect(before?.state).toBe('needs-human');
    expect(hasActiveStrictHumanAsk(before?.payload)).toBe(true);
    const job = readHumanMarketJob(before!)!;
    expect(job.ownerUserId).not.toBe(human!.id);
    await expect(actOnHumanMarketItem({ ...scope, userId: job.ownerUserId,
      action: 'claim', version: 0 })).rejects.toThrow('external_human_required');
    const claimed = await actOnHumanMarketItem({ ...scope, userId: human!.id, action: 'claim', version: 0 });
    expect(claimed).toMatchObject({ state: 'wip', assignee: humanAssignee(human!.id) });
    expect(readHumanMarketJob((await getHumanMarketItem(scope))!)?.version).toBe(1);
    expect(await getSessionUser(new Headers({ authorization: 'Bearer ' + session.token }))).toBeNull();
  });
});
