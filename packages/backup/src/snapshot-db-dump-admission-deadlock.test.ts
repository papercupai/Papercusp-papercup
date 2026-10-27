/**
 * The pre-destructive snapshot receipt must carry the dump verdict the hook
 * actually recorded — not an artifact of step replay.
 *
 * Observed 2026-08-30: snapshot 75742 dumped 9.6GB, its `hook_pg_dump` event
 * recorded `{ ok: true }`, and the receipt still landed `db_dump_ok = NULL`
 * because the step runner replayed an `undefined` result. Two policies then
 * collided: the status write fails OPEN (so the receipt read `ok` and looked
 * healthy), while `snapshot-admission.ts` fails CLOSED on `db_dump_ok IS TRUE`.
 * Every migration >= 1007 was refused with SQLSTATE 55000 — which aborted the
 * green-checkpoint migration preflight, so no release-gate verdict could be
 * rendered at all.
 *
 * Fail-closed admission is correct and stays. What is pinned here is that a
 * KNOWN-good dump is never persisted as UNKNOWN in the first place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Sql } from 'postgres';
import { fileURLToPath } from 'node:url';

vi.mock('./password', () => ({ deriveRepoPassword: async () => 'test-password' }));

import {
  configureBackup,
  configureBackupStepRunner,
  WorkspaceBackup,
} from './index';
import { isCompletedPreDestructiveSnapshotReceipt } from './snapshot-admission';
import { HOST_PG_DUMP_DIR_ENV } from './host-dump-coverage';

let root: string;

function configureWithSql(sql: Sql): void {
  configureBackup({
    getSql: () => sql,
    workspacesRoot: () => '/tmp/backup-admission-deadlock-root',
    ensureSchema: async () => {},
    getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
  });
}

/**
 * A step runner that replays `undefined` for the pre-snapshot hook — the exact
 * shape the comment at the assignment site describes, and the one that produced
 * the wedged receipt. The hook itself is NOT re-run, which is faithful: on a
 * replay its event is already durable from the original attempt.
 */
function replayingStepRunner(rowId: number): void {
  configureBackupStepRunner({
    runStep: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      if (name === 'backup-insert-row') return { id: rowId, startedAtMs: 1000 } as T;
      if (name === 'backup-pre-snapshot-hook') return undefined as T;
      return fn();
    },
  });
}

/** Capture every statement so the final receipt UPDATE can be asserted on. */
function makeSql(
  queries: Array<{ text: string; values: unknown[] }>,
  hookPayload: Record<string, unknown> | null,
): Sql {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    queries.push({ text, values });
    if (text.includes('FROM harness_shared.backup_events')) {
      return Promise.resolve(hookPayload === null ? [] : [{ payload_json: hookPayload }]);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;
}

async function runSnapshot(backup: WorkspaceBackup): Promise<void> {
  vi.spyOn(backup, 'ensureRepo').mockResolvedValue(undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(backup as any, 'assertSelfExclusionPolicy').mockResolvedValue(undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.spyOn(backup as any, 'kopia').mockResolvedValue(
    JSON.stringify({ id: 'kopia-artifact', stats: { addedSize: 17, totalSize: 6_948_207_239 } }),
  );
  await backup.snapshot('pre_destructive');
}

async function waitForCondition(predicate: () => boolean | Promise<boolean>, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function receiptUpdate(queries: Array<{ text: string; values: unknown[] }>) {
  return queries.find((query) => /UPDATE harness_shared\.backup_snapshots/.test(query.text));
}

beforeEach(async () => {
  configureBackupStepRunner(null);
  root = await mkdtemp(join(tmpdir(), 'backup-admission-'));
});

afterEach(async () => {
  configureBackupStepRunner(null);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('pre-destructive receipt vs. migration admission', () => {
  it('persists a replayed-but-successful dump as db_dump_ok = true', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    replayingStepRunner(75742);
    configureWithSql(makeSql(queries, { ok: true, bytes: 9_630_719_546 }));
    const backup = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });

    await runSnapshot(backup);

    // The receipt must record TRUE, not the NULL the replayed step implied.
    expect(receiptUpdate(queries)?.values).toEqual(expect.arrayContaining(['ok', true]));
  });

  it('admits that receipt through the fail-closed guard predicate', () => {
    // The end-to-end point: this is the shape the migration runner admits.
    // With db_dump_ok NULL the same receipt is refused, which is the wedge.
    const receipt = {
      status: 'ok',
      finishedAt: '2026-08-30T14:05:25.545Z',
      kopiaSnapshotId: 'kopia-artifact',
      dbDumpOk: true,
    };
    expect(isCompletedPreDestructiveSnapshotReceipt(receipt)).toBe(true);
    expect(isCompletedPreDestructiveSnapshotReceipt({ ...receipt, dbDumpOk: null })).toBe(false);
  });

  it('leaves the verdict UNKNOWN when no hook event was ever recorded', async () => {
    // The calibration case that keeps the fix honest: recovery must read a real
    // record, never manufacture a success from the absence of evidence.
    const queries: Array<{ text: string; values: unknown[] }> = [];
    replayingStepRunner(75743);
    configureWithSql(makeSql(queries, null));
    const backup = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });

    await expect(runSnapshot(backup)).rejects.toThrow(/dump success not verified/);

    const update = receiptUpdate(queries);
    expect(update?.values).toEqual(expect.arrayContaining([null]));
    expect(update?.values).not.toEqual(expect.arrayContaining([true]));
    expect(update?.text).toContain("status      = 'failed'");
    expect((backup as any).kopia).not.toHaveBeenCalled();
  });

  it('fails a pre-destructive backup before Kopia when the recovered dump failed', async () => {
    // Recovery must not launder a failure into a success.
    const queries: Array<{ text: string; values: unknown[] }> = [];
    replayingStepRunner(75744);
    configureWithSql(makeSql(queries, { ok: false, error: 'pg dump timed out after 900000ms' }));
    const backup = new WorkspaceBackup({ workspaceId: 'ws', workspaceRoot: root });

    await expect(runSnapshot(backup)).rejects.toThrow(/requires a successful database dump/);

    expect(receiptUpdate(queries)?.text).toContain("status      = 'failed'");
    expect(receiptUpdate(queries)?.values).toEqual(expect.arrayContaining([false]));
    expect((backup as any).kopia).not.toHaveBeenCalled();
  });

  it('releases the migration lock before waiting on the real Kopia flock, then reacquires before pg_dump', async () => {
    const binDir = join(root, 'bin');
    const lockPath = join(root, 'kopia.lock');
    const hostReady = join(root, 'host-flock-ready');
    const migrationReleased = join(root, 'workspace-migration-released');
    const hostMigrationAcquired = join(root, 'host-migration-acquired');
    const releaseHost = join(root, 'release-host-flock');
    const dumpStarted = join(root, 'pg-dump-started');
    const pgDumpStub = join(binDir, 'pg_dump');
    const guard = fileURLToPath(new URL('../../../apps/operator/scripts/systemd/kopia-backup-guard.sh', import.meta.url));
    const envKeys = ['PATH', 'KOPIA_BACKUP_GUARD_BIN', 'KOPIA_BACKUP_LOCK_PATH', HOST_PG_DUMP_DIR_ENV, 'PG_DUMP_STARTED'] as const;
    const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
    const order: string[] = [];
    let resolveHostMigrationReleased!: () => void;
    const hostMigrationReleased = new Promise<void>((resolve) => { resolveHostMigrationReleased = resolve; });
    let snapshot: Promise<unknown> | undefined;
    let holder: ReturnType<typeof spawn> | undefined;
    let hostClosed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    const restoreEnv = () => {
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };

    try {
      await mkdir(binDir, { recursive: true });
      await writeFile(lockPath, '');
      await writeFile(pgDumpStub, '#!/usr/bin/env bash\nset -euo pipefail\n: > "$PG_DUMP_STARTED"\nhead -c 16384 /dev/urandom\n');
      await chmod(pgDumpStub, 0o755);
      process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ''}`;
      process.env.KOPIA_BACKUP_GUARD_BIN = guard;
      process.env.KOPIA_BACKUP_LOCK_PATH = lockPath;
      process.env[HOST_PG_DUMP_DIR_ENV] = join(root, 'host-dump');
      process.env.PG_DUMP_STARTED = dumpStarted;

      holder = spawn('flock', [
        '-x', lockPath, 'bash', '-c',
        'touch "$HOST_READY"; while [ ! -e "$WORKSPACE_RELEASED" ]; do sleep 0.01; done; touch "$HOST_MIGRATION_ACQUIRED"; while [ ! -e "$RELEASE_HOST" ]; do sleep 0.01; done',
      ], {
        env: {
          ...process.env,
          HOST_READY: hostReady,
          WORKSPACE_RELEASED: migrationReleased,
          HOST_MIGRATION_ACQUIRED: hostMigrationAcquired,
          RELEASE_HOST: releaseHost,
        },
        stdio: 'ignore',
      });
      hostClosed = new Promise((resolve) => {
        holder!.once('close', (code, signal) => resolve({ code, signal }));
      });

      const sql = ((strings: TemplateStringsArray) => {
        const query = strings.join('?');
        if (query.includes('INSERT INTO harness_shared.backup_snapshots')) return Promise.resolve([{ id: 75750 }]);
        return Promise.resolve([]);
      }) as unknown as Sql;
      configureBackup({
        getSql: () => sql,
        workspacesRoot: () => root,
        ensureSchema: async () => {},
        getHarnessAdminUrl: () => ({ url: 'postgres://u:p@localhost:5432/db', source: 'test' }),
        acquireMigrationLock: async () => {
          order.push('migration-lock-reacquire-start');
          await hostMigrationReleased;
          order.push('migration-lock-reacquired');
          return { release: async () => { order.push('snapshot-migration-lock-release'); } };
        },
      });
      const backup = new WorkspaceBackup({ workspaceId: 'ws-lock-order', workspaceRoot: root });
      vi.spyOn(backup, 'ensureRepo').mockResolvedValue(undefined);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(backup as any, 'assertSelfExclusionPolicy').mockResolvedValue(undefined);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(backup as any, 'kopia').mockResolvedValue(
        JSON.stringify({ id: 'kopia-artifact', stats: { addedSize: 17, totalSize: 6_948_207_239 } }),
      );

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      await waitForCondition(() => fileExists(hostReady), 'host flock');
      snapshot = backup.snapshot('manual', undefined, {
        migrationLock: {
          release: async () => {
            order.push('scheduler-migration-lock-released');
            await writeFile(migrationReleased, 'released');
          },
        },
      });

      await waitForCondition(() => stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join('').includes('result=waiting reason=lock'), 'guard waiting on flock');
      await waitForCondition(() => fileExists(hostMigrationAcquired), 'host migration lock');
      order.push('host-migration-lock-acquired');
      expect(await fileExists(dumpStarted)).toBe(false);

      await writeFile(releaseHost, 'release');
      const closed = await hostClosed!;
      expect(closed).toMatchObject({ code: 0 });
      order.push('host-flock-released');
      resolveHostMigrationReleased();

      await waitForCondition(() => fileExists(dumpStarted), 'workspace pg_dump');
      order.push('pg_dump-started');
      await expect(snapshot).resolves.toMatchObject({ dbDumpOk: true });
      expect(order).toContain('scheduler-migration-lock-released');
      expect(order).toContain('host-flock-released');
      expect(order).toContain('migration-lock-reacquired');
      expect(order.indexOf('scheduler-migration-lock-released')).toBeLessThan(order.indexOf('host-migration-lock-acquired'));
      expect(order.indexOf('host-flock-released')).toBeLessThan(order.indexOf('migration-lock-reacquired'));
      expect(order.indexOf('migration-lock-reacquired')).toBeLessThan(order.indexOf('pg_dump-started'));
      expect(order).toContain('snapshot-migration-lock-release');
    } finally {
      await writeFile(migrationReleased, 'released').catch(() => {});
      await writeFile(releaseHost, 'release').catch(() => {});
      resolveHostMigrationReleased();
      if (holder && holder.exitCode === null && holder.signalCode === null) {
        await Promise.race([hostClosed!, new Promise((resolve) => setTimeout(resolve, 1_000))]);
        if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
      }
      if (snapshot) await Promise.race([snapshot.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5_000))]);
      restoreEnv();
    }
  });
});
