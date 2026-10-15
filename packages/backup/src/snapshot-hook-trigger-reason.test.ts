/**
 * WorkspaceBackup.snapshot(reason) must hand its trigger reason to the pre-snapshot
 * DB-dump hook (EI-25211496463956189). The hook uses it to decide whether its dump may
 * yield to an overdue Kopia sweep that is still making progress (`interval` only) or
 * keeps the backup guard's due-now priority (`pre_destructive`, `pre-deploy`; see
 * WI-10004871). Dropping the reason at this call site would silently turn every dump
 * into a safety dump, and the routine interval dumps would go back to preempting the
 * sweep. The hook's own argv per reason is pinned in hook.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';

const { hookCalls } = vi.hoisted(() => ({ hookCalls: [] as Array<Record<string, unknown>> }));

vi.mock('./password', () => ({ deriveRepoPassword: async () => 'test-password' }));
vi.mock('./hook', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./hook')>();
  return {
    ...actual,
    runPreSnapshotHook: async (ctx: Record<string, unknown>) => {
      hookCalls.push(ctx);
      return { ok: true };
    },
  };
});

import { configureBackup, configureBackupStepRunner, WorkspaceBackup } from './index';

let root: string;

/** Run every step for real except the row insert, which needs a returned row. */
function realHookStepRunner(rowId: number): void {
  configureBackupStepRunner({
    runStep: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      if (name === 'backup-insert-row') return { id: rowId, startedAtMs: 1000 } as T;
      return fn();
    },
  });
}

function configureWithEmptySql(): void {
  const sql = ((..._args: unknown[]) => Promise.resolve([])) as unknown as Sql;
  configureBackup({
    getSql: () => sql,
    workspacesRoot: () => '/tmp/backup-trigger-reason-root',
    ensureSchema: async () => {},
    getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
  });
}

beforeEach(async () => {
  hookCalls.length = 0;
  configureBackupStepRunner(null);
  root = await mkdtemp(join(tmpdir(), 'backup-trigger-reason-'));
});

afterEach(async () => {
  configureBackupStepRunner(null);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('snapshot trigger reason reaches the pre-snapshot dump hook', () => {
  it.each(['interval', 'pre_destructive', 'pre-deploy'])('passes %s through', async (reason) => {
    realHookStepRunner(91001);
    configureWithEmptySql();
    const backup = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });
    vi.spyOn(backup, 'ensureRepo').mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(backup as any, 'assertSelfExclusionPolicy').mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(backup as any, 'kopia').mockResolvedValue(
      JSON.stringify({ id: 'kopia-artifact', stats: { addedSize: 17, totalSize: 1_000 } }),
    );

    await backup.snapshot(reason);

    expect(hookCalls).toEqual([{ workspaceId: 'ws', workspaceRoot: root, triggerReason: reason }]);
  });
});
