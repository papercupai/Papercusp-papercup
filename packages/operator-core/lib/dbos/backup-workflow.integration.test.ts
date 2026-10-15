/**
 * backup-workflow.integration.test.ts — plan dbos-durable-flows-adoption P-011 /
 * P-009: the backup snapshot workflow's durable-result + exactly-once-per-
 * workflowID guarantees, proven against a REAL DBOS runtime (the property that
 * makes a snapshot crash-resumable can only be shown with a live DBOS instance).
 *
 * `startBackupSnapshotWorkflow` enqueues a workflow keyed by a per-request
 * `workflowID = backup-snapshot:<ws>:<reason>:<nonce>` and awaits its result. A
 * RE-invocation with the SAME workflowID returns the durable cached result
 * WITHOUT re-running the executor — DBOS's exactly-once-per-id property, which is
 * exactly what lets a resumed snapshot pick up where it left off. Distinct
 * nonces are independent runs (no dedup mutex — manual snapshots keep today's
 * "both run" behavior).
 *
 * Boots DBOS on a throwaway DB on the shared testcontainer (mirrors
 * provision-workflow.integration.test.ts) and injects a counting stub executor —
 * so the durable-result mechanics are proven WITHOUT spawning a kopia snapshot.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestPg, teardownTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import type { DBOS as DBOSType } from '@dbos-inc/dbos-sdk';
import { configureBackup, configureBackupStepRunner, WorkspaceBackup,
  type SnapshotResult, type SnapshotTriggerReason } from '@papercusp/backup';

vi.mock('../../../backup/src/password', () => ({ deriveRepoPassword: async () => 'isolated-password' }));

let DBOS: typeof DBOSType;
let startBackupSnapshotWorkflow: typeof import('./backup-workflow').startBackupSnapshotWorkflow;
let setBackupSnapshotExecutor: typeof import('./backup-workflow').setBackupSnapshotExecutor;
let startBackupPromoteWorkflow: typeof import('./backup-workflow').startBackupPromoteWorkflow;
let setPromoteExecutor: typeof import('./backup-workflow').setPromoteExecutor;
let startBackupRollbackWorkflow: typeof import('./backup-workflow').startBackupRollbackWorkflow;
let setRollbackExecutor: typeof import('./backup-workflow').setRollbackExecutor;
let startBackupRestoreInPlaceWorkflow: typeof import('./backup-workflow').startBackupRestoreInPlaceWorkflow;
let setRestoreInPlaceExecutor: typeof import('./backup-workflow').setRestoreInPlaceExecutor;
let wireBackupStepRunner: typeof import('./backup-workflow').wireBackupStepRunner;
let adminUri: string;
let dbName: string;

// (workspace, reason) → number of times the (stub) executor actually ran.
const execCount: Record<string, number> = {};
const key = (ws: string, reason: string) => `${ws}:${reason}`;
const nonce = () => randomBytes(6).toString('hex');
const fakeSql = ((..._args: unknown[]) => Promise.resolve([])) as unknown as Sql;

function configureIsolatedBackup(root: string): void {
  configureBackup({
    getSql: () => fakeSql,
    workspacesRoot: () => root,
    ensureSchema: async () => {},
    getHarnessAdminUrl: () => ({ url: 'postgres://isolated:isolated@localhost/unused', source: 'test' }),
  });
}

const result = (kopiaSnapshotId: string): SnapshotResult => ({
  snapshotId: 1,
  kopiaSnapshotId,
  bytesAdded: 10,
  durationMs: 1,
});

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `dbos_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;

  ({ DBOS } = await import('@dbos-inc/dbos-sdk'));
  DBOS.setConfig({
    name: 'papercusp-test',
    systemDatabaseUrl: u.toString(),
    systemDatabaseSchemaName: 'dbos',
    applicationVersion: 'test-v1',
    runAdminServer: false,
  });

  const wf = await import('./backup-workflow');
  startBackupSnapshotWorkflow = wf.startBackupSnapshotWorkflow;
  setBackupSnapshotExecutor = wf.setBackupSnapshotExecutor;
  startBackupPromoteWorkflow = wf.startBackupPromoteWorkflow;
  setPromoteExecutor = wf.setPromoteExecutor;
  startBackupRollbackWorkflow = wf.startBackupRollbackWorkflow;
  setRollbackExecutor = wf.setRollbackExecutor;
  startBackupRestoreInPlaceWorkflow = wf.startBackupRestoreInPlaceWorkflow;
  setRestoreInPlaceExecutor = wf.setRestoreInPlaceExecutor;
  wireBackupStepRunner = wf.wireBackupStepRunner;
  // Stub executor: count the run, hold briefly, then succeed. No kopia, no PG.
  setBackupSnapshotExecutor(
    async (ws: string, reason: SnapshotTriggerReason): Promise<SnapshotResult> => {
      execCount[key(ws, String(reason))] = (execCount[key(ws, String(reason))] ?? 0) + 1;
      await new Promise((r) => setTimeout(r, 50));
      return result(`kopia-${ws}-${String(reason)}`);
    },
  );

  await DBOS.launch();
}, 90_000);

afterAll(async () => {
  configureBackupStepRunner(null);
  setRestoreInPlaceExecutor?.(null);
  setPromoteExecutor?.(null);
  setRollbackExecutor?.(null);
  try {
    await DBOS.shutdown();
  } catch {
    /* best-effort */
  }
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await admin.end({ timeout: 5 });
  }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

beforeEach(() => {
  for (const k of Object.keys(execCount)) delete execCount[k];
});

describe('DBOS backup snapshot workflow — durable result (P-011)', () => {
  it('awaits the durable result on the happy path (tool keeps its sync contract)', async () => {
    const r = await startBackupSnapshotWorkflow({ workspaceId: 'ws-1', reason: 'manual' }, nonce());
    expect(r.kopiaSnapshotId).toBe('kopia-ws-1-manual');
    expect(execCount[key('ws-1', 'manual')]).toBe(1);
  }, 30_000);

  it('re-invoking the SAME workflowID returns the cached result WITHOUT re-running (exactly-once)', async () => {
    const input = { workspaceId: 'ws-1', reason: 'manual' as const };
    const n = nonce();
    const r1 = await startBackupSnapshotWorkflow(input, n);
    const r2 = await startBackupSnapshotWorkflow(input, n); // same workflowID
    expect(r1).toEqual(r2);
    // The decisive assertion: the executor ran exactly once — the second call
    // replayed the durable result, exactly the crash-resume property.
    expect(execCount[key('ws-1', 'manual')]).toBe(1);
  }, 30_000);

  it('distinct nonces are independent runs (no dedup mutex — both run)', async () => {
    const input = { workspaceId: 'ws-1', reason: 'manual' as const };
    const [a, b] = await Promise.all([
      startBackupSnapshotWorkflow(input, nonce()),
      startBackupSnapshotWorkflow(input, nonce()),
    ]);
    expect(a.kopiaSnapshotId).toBe('kopia-ws-1-manual');
    expect(b.kopiaSnapshotId).toBe('kopia-ws-1-manual');
    expect(execCount[key('ws-1', 'manual')]).toBe(2);
  }, 30_000);
});

describe('DBOS backup destructive trio — durable result (P-012)', () => {
  it('promote: durable result + exactly-once per workflowID (the crash-resume property)', async () => {
    let runs = 0;
    // Stub the destructive op so the DBOS mechanics are proven without real FS
    // renames; opId is threaded from the nonce (deterministic broken-dir name).
    setPromoteExecutor(async (i) => {
      runs++;
      return { broken: `/.broken-${i.opId}-live`, live: i.liveTarget ?? '/live' };
    });
    const n = nonce();
    const input = { workspaceId: 'ws-1', restoredPath: '/.restored/s1/live', liveTarget: '/live' };
    const r1 = await startBackupPromoteWorkflow(input, n);
    const r2 = await startBackupPromoteWorkflow(input, n); // same workflowID
    expect(r1).toEqual(r2);
    // The destructive op ran exactly once; the re-invocation replayed the
    // durable result — exactly what makes a half-done promote safe to resume.
    expect(runs).toBe(1);
    expect(r1.broken).toBe(`/.broken-${n}-live`);
    setPromoteExecutor(null);
  }, 30_000);

  it('recovers half-done promote and rollback swaps with the original operation IDs on isolated filesystem', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backup-dbos-p023-'));
    const live = join(root, 'live');
    const clone = join(root, '.restored', 'snap1', 'live');
    const marker = (path: string) => readFile(join(path, 'marker.txt'), 'utf8');
    configureIsolatedBackup(root);
    const backup = new WorkspaceBackup({ workspaceId: 'ws-p023', workspaceRoot: root });
    wireBackupStepRunner();
    setPromoteExecutor((input) => backup.promoteRestore({
      restoredPath: input.restoredPath, liveTarget: input.liveTarget, opId: input.opId,
    }));
    setRollbackExecutor((input) => backup.rollbackPromote({
      brokenPath: input.brokenPath, opId: input.opId,
    }));
    try {
      await mkdir(clone, { recursive: true });
      await mkdir(live, { recursive: true });
      await writeFile(join(clone, 'marker.txt'), 'RESTORED');
      await writeFile(join(live, 'marker.txt'), 'ORIGINAL');

      // The first rename committed before a killed producer could checkpoint
      // the swap. The replay carries the same opId, so it finds that path.
      const promoteId = nonce();
      const broken = join(root, `.broken-${promoteId}-live`);
      await rename(live, broken);
      const promoteInput = { workspaceId: 'ws-p023', restoredPath: clone, liveTarget: live };
      const promoted = await startBackupPromoteWorkflow(promoteInput, promoteId);
      expect(promoted).toEqual({ broken, live });
      expect(await marker(live)).toBe('RESTORED');
      expect(await marker(broken)).toBe('ORIGINAL');
      await DBOS.shutdown();
      await DBOS.launch();
      expect(await startBackupPromoteWorkflow(promoteInput, promoteId)).toEqual(promoted);

      // A rollback crash after stashing the promoted live directory has the
      // same stable-ID requirement; a second DBOS workflow repairs it.
      const rollbackId = nonce();
      const stash = join(root, `.rolled-back-${rollbackId}-live`);
      await rename(live, stash);
      const rollbackInput = { workspaceId: 'ws-p023', brokenPath: broken };
      const rolledBack = await startBackupRollbackWorkflow(rollbackInput, rollbackId);
      expect(rolledBack).toEqual({ liveBefore: stash, liveAfter: live });
      expect(await marker(live)).toBe('ORIGINAL');
      expect(await marker(stash)).toBe('RESTORED');
      expect(await startBackupRollbackWorkflow(rollbackInput, rollbackId)).toEqual(rolledBack);
    } finally {
      setPromoteExecutor(null);
      setRollbackExecutor(null);
      configureBackupStepRunner(null);
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('replays one restore identity without repeating its safety snapshot or apply step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backup-dbos-restore-p023-'));
    const target = join(root, 'live');
    configureIsolatedBackup(root);
    const backup = new WorkspaceBackup({ workspaceId: 'ws-p023-restore', workspaceRoot: root });
    const safety = vi.spyOn(backup, 'snapshot').mockResolvedValue(result('safety-p023'));
    let applies = 0;
    vi.spyOn(backup as unknown as {
      kopia: (args: string[], opts: unknown) => Promise<string>;
    }, 'kopia').mockImplementation(async (args) => {
      if (args[0] !== 'snapshot' || args[1] !== 'restore') throw new Error('unexpected kopia call');
      applies += 1;
      await mkdir(args[3]!, { recursive: true });
      await writeFile(join(args[3]!, 'marker.txt'), 'RESTORED');
      return '';
    });
    wireBackupStepRunner();
    setRestoreInPlaceExecutor((input) => backup.restoreInPlace({
      kopiaSnapshotId: input.kopiaSnapshotId,
      target: input.target,
      skipSafetySnapshot: input.skipSafetySnapshot,
    }));
    try {
      await mkdir(target, { recursive: true });
      await writeFile(join(target, 'marker.txt'), 'ORIGINAL');
      const operationId = nonce();
      const input = { workspaceId: 'ws-p023-restore', kopiaSnapshotId: 'snapshot-p023', target };
      const first = await startBackupRestoreInPlaceWorkflow(input, operationId);
      expect(first).toEqual({ targetPath: target, prevSnapshotId: 'safety-p023' });
      expect(await readFile(join(target, 'marker.txt'), 'utf8')).toBe('RESTORED');
      await DBOS.shutdown();
      await DBOS.launch();
      expect(await startBackupRestoreInPlaceWorkflow(input, operationId)).toEqual(first);
      expect(safety).toHaveBeenCalledTimes(1);
      expect(applies).toBe(1);
    } finally {
      setRestoreInPlaceExecutor(null);
      configureBackupStepRunner(null);
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
