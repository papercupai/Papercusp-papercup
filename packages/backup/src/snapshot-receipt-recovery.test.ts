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

vi.mock('./password', () => ({ deriveRepoPassword: async () => 'test-password' }));

import {
  configureBackup,
  configureBackupStepRunner,
  WorkspaceBackup,
} from './index';

let root: string;

function configureWithSql(sql: Sql): void {
  configureBackup({
    getSql: () => sql,
    workspacesRoot: () => '/tmp/backup-receipt-test-root',
    ensureSchema: async () => {},
    getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
  });
}

beforeEach(async () => {
  configureBackupStepRunner(null);
  root = await mkdtemp(join(tmpdir(), 'backup-receipt-'));
});

afterEach(async () => {
  configureBackupStepRunner(null);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('snapshot receipt recovery', () => {
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
