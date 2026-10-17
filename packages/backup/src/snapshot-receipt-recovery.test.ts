/**
 * WI-42258 — a pre-destructive backup completed its Kopia artifact, then lost
 * the final PG receipt write and stayed `running`. Pin the two-part recovery:
 * every artifact carries its durable row id, and the write surface can recover
 * that exact receipt without starting another snapshot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import type { BackupMigrationLock } from './config';

vi.mock('./password', () => ({ deriveRepoPassword: async () => 'test-password' }));
const admission = vi.hoisted(() => ({ active: false }));
vi.mock('./host-dump-coverage', () => ({ readHostDumpInProgress: async () => admission.active
  ? { phase: 'guard-queued', pid: 4242 } : null }));

import {
  configureBackup,
  configureBackupStepRunner,
  WorkspaceBackup,
} from './index';

let root: string;

function configureWithSql(sql: Sql, acquireMigrationLock?: () => Promise<BackupMigrationLock>): void {
  configureBackup({
    getSql: () => sql,
    workspacesRoot: () => '/tmp/backup-receipt-test-root',
    ensureSchema: async () => {},
    getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
    acquireMigrationLock,
  });
}

beforeEach(async () => {
  configureBackupStepRunner(null);
  admission.active = false;
  root = await mkdtemp(join(tmpdir(), 'backup-receipt-'));
});

afterEach(async () => {
  configureBackupStepRunner(null);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('snapshot receipt recovery', () => {
  function producerFixture(status = 'running') {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const row = { id: 78850, trigger_reason: 'pre_destructive', sources_json: [] as string[],
      started_at: new Date().toISOString(), status, finished_at: null as string | null,
      kopia_snapshot_id: null as string | null, bytes_added: '1', bytes_total: '2',
      db_dump_ok: true as boolean | null, error_text: null as string | null,
      hook_payload: { ok: true } as Record<string, unknown>, capture_started: false };
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?'); queries.push({ text, values });
      if (text.includes('SELECT id FROM harness_shared.backup_events')) return Promise.resolve([{ id: '123' }]);
      if (text.includes('SELECT event.id, event.payload_json')) return Promise.resolve([
        { id: 123, payload_json: row.hook_payload, capture_started: row.capture_started },
      ]);
      if (text.includes('SELECT id, trigger_reason') || text.includes('SELECT status, error_text')
        || text.includes('FROM harness_shared.backup_snapshots AS snapshot')) {
        return Promise.resolve([row]);
      }
      if (text.includes("SET status = 'running', finished_at = NULL")) {
        row.status = 'running'; row.finished_at = null; row.error_text = null;
        return Promise.resolve([{ id: row.id }]);
      }
      if (text.includes('UPDATE harness_shared.backup_snapshots') && text.includes('RETURNING id')) return Promise.resolve([{ id: row.id }]);
      return Promise.resolve([]);
    }) as unknown as Sql;
    const backup = new WorkspaceBackup({ workspaceId: 'resume-ws', workspaceRoot: root });
    row.sources_json = [root];
    vi.spyOn(backup, 'ensureRepo').mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(backup as any, 'assertSelfExclusionPolicy').mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kopia = vi.spyOn(backup as any, 'kopia').mockImplementation(async (...params: unknown[]) => {
      const args = params[0] as string[];
      return args.includes('create') ? JSON.stringify({ id: 'same-row-artifact', stats: { addedSize: 1, totalSize: 2 } }) : '[]';
    });
    const steps: string[] = [];
    configureBackupStepRunner({ runStep: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      steps.push(name);
      return name.startsWith('backup-pre-snapshot-hook') ? { ok: true, error: null } as T : fn();
    } });
    return { row, sql, queries, backup, kopia, steps };
  }

  it('re-drives the exact row under the existing producer lock without inserting another receipt', async () => {
    const f = producerFixture();
    const release = vi.fn(async () => {});
    const acquire = vi.fn(async () => ({ release }));
    configureWithSql(f.sql, acquire);
    const started = vi.fn();
    const result = await f.backup.snapshot('pre_destructive', undefined, { resumeSnapshotId: 78850, onStarted: started });
    expect(result).toMatchObject({ snapshotId: 78850, kopiaSnapshotId: 'same-row-artifact', dbDumpOk: true });
    expect(started).toHaveBeenCalledWith(78850);
    expect(acquire).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(f.queries.some(q => q.text.includes('INSERT INTO harness_shared.backup_snapshots'))).toBe(false);
    expect(f.steps).not.toContain('backup-insert-row');
    expect(f.kopia).toHaveBeenCalledWith(expect.arrayContaining(['create', '--tags=papercusp-backup-row-id:78850']), expect.any(Object));
    expect(f.queries.find(q => q.text.includes('SET kopia_snapshot_id'))?.values).toContain(78850);
  });

  it('joins the same row, refuses a different in-flight row, and rechecks completion after the lock wait', async () => {
    const f = producerFixture();
    const release = vi.fn(async () => {});
    let unlock!: (lock: BackupMigrationLock) => void;
    const acquire = vi.fn(() => new Promise<BackupMigrationLock>(resolve => { unlock = resolve; }));
    configureWithSql(f.sql, acquire);
    const first = f.backup.snapshot('pre_destructive', undefined, { resumeSnapshotId: 78850 });
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    const joined = f.backup.snapshot('pre_destructive', undefined, { resumeSnapshotId: 78850 });
    await expect(f.backup.snapshot('pre_destructive', undefined, { resumeSnapshotId: 78851 })).rejects.toThrow('refusing to substitute');
    f.row.status = 'ok'; f.row.kopia_snapshot_id = 'original-finished'; f.row.finished_at = new Date().toISOString();
    unlock({ release });
    expect(await first).toMatchObject({ snapshotId: 78850, kopiaSnapshotId: 'original-finished' });
    expect(await joined).toMatchObject({ snapshotId: 78850, kopiaSnapshotId: 'original-finished' });
    expect(f.kopia).not.toHaveBeenCalled();
    expect(f.steps).not.toContain('backup-pre-snapshot-hook');
    expect(release).toHaveBeenCalledOnce();
  });

  it('recovers a completed row-tagged artifact instead of creating it again', async () => {
    const f = producerFixture();
    const release = vi.fn(async () => {});
    configureWithSql(f.sql, async () => ({ release }));
    f.kopia.mockResolvedValue(JSON.stringify([{ id: 'already-created', endTime: new Date().toISOString(),
      source: { path: root }, stats: { addedSize: 1, totalSize: 2 } }]));
    expect(await f.backup.snapshot('pre_destructive', undefined, { resumeSnapshotId: 78850 }))
      .toMatchObject({ snapshotId: 78850, kopiaSnapshotId: 'already-created', dbDumpOk: true });
    expect(f.kopia.mock.calls.some(([args]) => (args as string[]).includes('create'))).toBe(false);
    expect(f.steps).not.toContain('backup-pre-snapshot-hook');
  });

  it.each(['foreign-root', 'foreign-trigger', 'missing-row'] as const)('refuses mismatched recovery identity before touching the receipt (%s)', async which => {
    const f = producerFixture();
    if (which === 'foreign-root') f.row.sources_json = ['/another/root'];
    if (which === 'foreign-trigger') f.row.trigger_reason = 'manual';
    const sql = which === 'missing-row' ? (() => Promise.resolve([])) as unknown as Sql : f.sql;
    const acquire = vi.fn(async () => ({ release: async () => {} }));
    configureWithSql(sql, acquire);
    await expect(f.backup.snapshot('pre_destructive', undefined, { resumeSnapshotId: 78850 })).rejects.toThrow('does not match');
    expect(acquire).not.toHaveBeenCalled();
    expect(f.queries.some(q => q.text.includes('UPDATE harness_shared.backup_snapshots'))).toBe(false);
    expect(f.kopia).not.toHaveBeenCalled();
  });

  it('refuses producer recovery without a cross-process fence', async () => {
    const f = producerFixture(); configureWithSql(f.sql);
    await expect(f.backup.snapshot('pre_destructive', undefined, { resumeSnapshotId: 78850 })).rejects.toThrow('requires the cross-process');
    expect(f.queries.some(q => q.text.includes('UPDATE harness_shared.backup_snapshots'))).toBe(false);
  });

  it('does not overwrite a terminal failed receipt', async () => {
    const f = producerFixture('failed');
    const release = vi.fn(async () => {}); configureWithSql(f.sql, async () => ({ release }));
    await expect(f.backup.snapshot('pre_destructive', undefined, { resumeSnapshotId: 78850 })).rejects.toThrow('refusing to overwrite');
    expect(f.queries.some(q => q.text.includes('UPDATE harness_shared.backup_snapshots'))).toBe(false);
    expect(f.kopia).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('reopens only an artifact-free orphan-sweep verdict under the producer lock, retaining the exact row', async () => {
    const f = producerFixture('failed');
    f.row.error_text = "orphan-sweep: status='running' for >60min";
    f.row.finished_at = new Date().toISOString(); f.row.db_dump_ok = null;
    let locked = false;
    const release = vi.fn(async () => { locked = false; });
    configureWithSql(f.sql, async () => { locked = true; return { release }; });
    f.kopia.mockImplementation(async (...params: unknown[]) => {
      expect(locked).toBe(true);
      return (params[0] as string[]).includes('create')
        ? JSON.stringify({ id: 'same-row-artifact', stats: {} }) : '[]';
    });
    expect(await f.backup.snapshot('pre_destructive', undefined, { resumeSnapshotId: 78850 }))
      .toMatchObject({ snapshotId: 78850, kopiaSnapshotId: 'same-row-artifact', dbDumpOk: true });
    const reopen = f.queries.find(q => q.text.includes("SET status = 'running', finished_at = NULL"));
    expect(reopen?.text).toContain("AND status = 'failed' AND error_text =");
    expect(reopen?.text).toContain('AND finished_at =');
    expect(reopen?.text).toContain('AND sources_json =');
    expect(f.queries.some(q => q.text.includes('INSERT INTO harness_shared.backup_snapshots'))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([false, true])('retries only a proven no-work host admission deferral on the same row (typed=%s)', async typed => {
    const f = producerFixture('failed');
    const error = 'host backup is in progress (phase guard-queued, pid 4242)';
    f.row.hook_payload = { ok: false, error, ...(typed ? { deferred: 'host-backup-in-progress' } : {}) };
    f.row.error_text = `pre-destructive backup requires a successful database dump: ${error}`;
    f.row.finished_at = new Date().toISOString(); f.row.db_dump_ok = false;
    const release = vi.fn(async () => {}); configureWithSql(f.sql, async () => ({ release }));
    expect(await f.backup.snapshot('pre_destructive', undefined, { resumeSnapshotId: 78850 }))
      .toMatchObject({ snapshotId: 78850, dbDumpOk: true });
    expect(f.steps).toContain('backup-pre-snapshot-hook:resume:78850:123');
    expect(f.steps).not.toContain('backup-pre-snapshot-hook');
    expect(f.queries.some(q => q.text.includes('INSERT INTO harness_shared.backup_snapshots'))).toBe(false);
    expect(f.queries.some(q => q.values.some(value => typeof value === 'string' && value.includes('admission_deferred_retry')))).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it('uses the prior hook event to escape a cached rejection after the recovery CAS and a crash', async () => {
    const f = producerFixture('running');
    f.row.hook_payload = { ok: false, error: 'host backup is in progress (phase guard-queued, pid 4242)' };
    f.row.db_dump_ok = false;
    configureWithSql(f.sql, async () => ({ release: async () => {} }));
    configureBackupStepRunner({ runStep: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      f.steps.push(name);
      if (name === 'backup-pre-snapshot-hook') return { ok: false, error: 'cached admission refusal' } as T;
      return name.startsWith('backup-pre-snapshot-hook:resume:') ? { ok: true } as T : fn();
    } });
    expect(await f.backup.snapshot('pre_destructive', undefined, { resumeSnapshotId: 78850 }))
      .toMatchObject({ snapshotId: 78850, dbDumpOk: true });
    expect(f.steps).toContain('backup-pre-snapshot-hook:resume:78850:123');
    expect(f.steps).not.toContain('backup-pre-snapshot-hook');
  });

  it.each(['active-host', 'actual-dump-failure', 'missing-hook', 'error-mismatch', 'capture-started', 'artifact', 'bad-finish', 'cas-race'] as const)
  ('protects a terminal receipt when admission retry is not proven (%s)', async which => {
    const f = producerFixture('failed');
    const error = 'host backup is in progress (phase guard-queued, pid 4242)';
    f.row.hook_payload = { ok: false, error, deferred: 'host-backup-in-progress' };
    f.row.error_text = `pre-destructive backup requires a successful database dump: ${error}`;
    f.row.finished_at = new Date().toISOString(); f.row.db_dump_ok = false;
    admission.active = which === 'active-host';
    if (which === 'actual-dump-failure') f.row.hook_payload.error = 'pg_dump exited 1';
    if (which === 'missing-hook') f.row.hook_payload = {};
    if (which === 'error-mismatch') f.row.error_text = 'some other failure';
    if (which === 'capture-started') f.row.capture_started = true;
    if (which === 'artifact') f.kopia.mockResolvedValue('[{"id":"protected-artifact"}]');
    if (which === 'bad-finish') f.row.finished_at = 'invalid';
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (which === 'cas-race' && strings.join('?').includes("SET status = 'running', finished_at = NULL")) return Promise.resolve([]);
      return (f.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>)(strings, ...values);
    }) as unknown as Sql;
    const release = vi.fn(async () => {}); configureWithSql(sql, async () => ({ release }));
    await expect(f.backup.snapshot('pre_destructive', undefined, { resumeSnapshotId: 78850 })).rejects.toThrow();
    expect(f.row.status).toBe('failed');
    expect(f.steps.some(name => name.startsWith('backup-pre-snapshot-hook'))).toBe(false);
    expect(f.kopia.mock.calls.some(([args]) => (args as string[]).includes('create'))).toBe(false);
    expect(f.queries.some(q => q.text.includes('SET finished_at = now()'))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(['artifact', 'known-artifact', 'failed-dump', 'malformed-list', 'receipt-race'] as const)
  ('preserves an orphan verdict when safe recovery cannot be proved (%s)', async which => {
    const f = producerFixture('failed');
    f.row.error_text = "orphan-sweep: status='running' for >60min";
    f.row.finished_at = new Date().toISOString(); f.row.db_dump_ok = null;
    if (which === 'known-artifact') f.row.kopia_snapshot_id = 'protected-artifact';
    if (which === 'failed-dump') f.row.db_dump_ok = false;
    if (which === 'artifact') f.kopia.mockResolvedValue('[{"id":"protected-artifact"}]');
    if (which === 'malformed-list') f.kopia.mockResolvedValue('{}');
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (which === 'receipt-race' && strings.join('?').includes("SET status = 'running', finished_at = NULL")) return Promise.resolve([]);
      return (f.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>)(strings, ...values);
    }) as unknown as Sql;
    const release = vi.fn(async () => {}); configureWithSql(sql, async () => ({ release }));
    await expect(f.backup.snapshot('pre_destructive', undefined, { resumeSnapshotId: 78850 })).rejects.toThrow();
    expect(f.row.status).toBe('failed');
    expect(f.row.error_text).toBe("orphan-sweep: status='running' for >60min");
    expect(f.kopia.mock.calls.some(([args]) => (args as string[]).includes('create'))).toBe(false);
    expect(f.steps).not.toContain('backup-pre-snapshot-hook');
    expect(f.queries.some(q => q.text.includes('SET finished_at = now()'))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(['receipt-race', 'known-artifact', 'malformed-list'] as const)('requires positive absence proof before re-driving (%s)', async which => {
    const f = producerFixture();
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (which === 'receipt-race' && strings.join('?').includes('RETURNING id')) return Promise.resolve([]);
      return (f.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>)(strings, ...values);
    }) as unknown as Sql;
    const release = vi.fn(async () => {}); configureWithSql(sql, async () => ({ release }));
    if (which === 'known-artifact') f.row.kopia_snapshot_id = 'known-existing-artifact';
    if (which === 'malformed-list') f.kopia.mockResolvedValue('{}');
    if (which === 'receipt-race') f.kopia.mockResolvedValue(JSON.stringify([{ id: 'exists', endTime: new Date().toISOString(), source: { path: root } }]));
    await expect(f.backup.snapshot('pre_destructive', undefined, { resumeSnapshotId: 78850 }))
      .rejects.toThrow(which === 'malformed-list' ? 'malformed manifest list' : 'positive artifact-absence proof');
    expect(f.kopia.mock.calls.some(([args]) => (args as string[]).includes('create'))).toBe(false);
    expect(f.steps).not.toContain('backup-pre-snapshot-hook');
    expect(f.queries.some(q => q.text.includes("SET finished_at = now()"))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it('tags the Kopia artifact with the durable backup row id', async () => {
    const sql = (() => Promise.resolve([])) as unknown as Sql;
    configureWithSql(sql);
    configureBackupStepRunner({
      runStep: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        if (name === 'backup-kopia-create') return fn();
        const canned: Record<string, unknown> = {
          'backup-insert-row': { id: 75479, startedAtMs: 1000 },
          'backup-pre-snapshot-hook': { ok: true, error: null },
          'backup-record-result': undefined,
        };
        return canned[name] as T;
      },
    });
    const backup = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });
    vi.spyOn(backup, 'ensureRepo').mockResolvedValue(undefined);
    // ensureRepo normally proves this before snapshotOnce reaches the create
    // step. The focused test bypasses ensureRepo, so preserve that proven
    // precondition explicitly instead of letting the empty fake settings store
    // recurse through policy repair.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(backup as any, 'assertSelfExclusionPolicy').mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kopia = vi.spyOn(backup as any, 'kopia').mockResolvedValue(
      JSON.stringify({ id: 'kopia-tagged', stats: { addedSize: 1, totalSize: 2 } }),
    );

    await backup.snapshot('pre_destructive');

    expect(kopia).toHaveBeenCalledWith(
      expect.arrayContaining(['--tags=papercusp-backup-row-id:75479']),
      expect.any(Object),
    );
  });

  it.each([undefined, 'stable-root-object'])('reconciles a tagged artifact using its stable root when present (%s)', async (rootObject) => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      queries.push({ text, values });
      if (text.includes('FROM harness_shared.backup_snapshots AS snapshot')) {
        return Promise.resolve([{
          id: 75479,
          status: 'running',
          kopia_snapshot_id: null,
          started_at: '2026-08-26T22:40:10.180Z',
          finished_at: null,
          bytes_added: null,
          bytes_total: null,
          db_dump_ok: null,
          hook_payload: { ok: true, bytes: 2_329_667_487 },
        }]);
      }
      if (/UPDATE harness_shared\.backup_snapshots/.test(text)) {
        return Promise.resolve([{ id: 75479 }]);
      }
      return Promise.resolve([]);
    }) as unknown as Sql;
    configureWithSql(sql);
    const backup = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });
    vi.spyOn(backup, 'ensureRepo').mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kopia = vi.spyOn(backup as any, 'kopia').mockResolvedValue(JSON.stringify([{
      id: '0de65178167b65df11cf1ba40a0169b0',
      startTime: '2026-08-26T22:43:39.886Z',
      endTime: '2026-08-26T22:43:49.378Z',
      source: { path: root },
      ...(rootObject ? { rootEntry: { obj: rootObject } } : {}),
      stats: { addedSize: 17, totalSize: 6_948_207_239 },
    }]));

    const result = await backup.reconcileSnapshotReceipt(75479);

    expect(kopia).toHaveBeenCalledWith(
      expect.arrayContaining(['--tags=papercusp-backup-row-id:75479']),
      expect.any(Object),
    );
    expect(result).toMatchObject({
      snapshotId: 75479,
      reconciled: true,
      stillRunning: false,
      status: 'ok',
      dbDumpOk: true,
      kopiaSnapshotId: rootObject ?? '0de65178167b65df11cf1ba40a0169b0',
      bytesAdded: 17,
      bytesTotal: 6_948_207_239,
    });
    const update = queries.find((query) => /UPDATE harness_shared\.backup_snapshots/.test(query.text));
    expect(update?.values).toEqual(expect.arrayContaining([
      rootObject ?? '0de65178167b65df11cf1ba40a0169b0',
      'ok',
      6_948_207_239,
      true,
    ]));
  });

  it('reconciles a tagged artifact with an explicit failed dump as degraded', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      queries.push({ text, values });
      if (text.includes('FROM harness_shared.backup_snapshots AS snapshot')) {
        return Promise.resolve([{
          id: 75480,
          status: 'running',
          kopia_snapshot_id: null,
          started_at: '2026-08-26T22:40:10.180Z',
          finished_at: null,
          bytes_added: null,
          bytes_total: null,
          db_dump_ok: false,
          hook_payload: { ok: false, error: 'pg dump timed out after 900000ms' },
        }]);
      }
      if (/UPDATE harness_shared\.backup_snapshots/.test(text)) {
        return Promise.resolve([{ id: 75480 }]);
      }
      return Promise.resolve([]);
    }) as unknown as Sql;
    configureWithSql(sql);
    const backup = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });
    vi.spyOn(backup, 'ensureRepo').mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(backup as any, 'kopia').mockResolvedValue(JSON.stringify([{
      id: 'kopia-degraded',
      startTime: '2026-08-26T22:43:39.886Z',
      endTime: '2026-08-26T22:43:49.378Z',
      source: { path: root },
      stats: { addedSize: 17, totalSize: 6_948_207_239 },
    }]));

    await expect(backup.reconcileSnapshotReceipt(75480)).resolves.toMatchObject({
      snapshotId: 75480,
      reconciled: true,
      stillRunning: false,
      status: 'degraded',
      dbDumpOk: false,
      kopiaSnapshotId: 'kopia-degraded',
    });
    const update = queries.find((query) => /UPDATE harness_shared\.backup_snapshots/.test(query.text));
    expect(update?.values).toEqual(expect.arrayContaining(['degraded', false]));
  });
});
