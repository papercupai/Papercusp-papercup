/** Real psql + independent lease DB: no production migration or backup is touched. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { assertResourceFenceCurrent } from '@papercusp/locks';

vi.mock('../../resource-governor/execution', () => ({
  runGovernedOperation: async (_input: unknown, run: () => Promise<unknown>) => run(),
}));
import { migrationBackupAdvisoryLockSql, migrationPsqlScript, runPsql, BACKUP_MIGRATION_ADVISORY_LOCK_KEY } from './migrate';

let admin: postgres.Sql;
let target: postgres.Sql;
let leases: postgres.Sql;
let backup: postgres.Sql;
let targetUrl: string;
let databases: string[] = [];
let directory: string;
const originalLock = randomUUID();
const token = { coordinationDomain: 'original-candidate', resource: 'db-schema', lockId: originalLock, fenceSeq: 7 };
const assertCurrent = () => assertResourceFenceCurrent(leases, token);
let pending: ReturnType<typeof runPsql> | undefined;

beforeAll(async () => {
  const adminUrl = await getTestPg();
  admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  databases = [`mf_${randomUUID().replace(/-/g, '')}`, `mf_su_${randomUUID().replace(/-/g, '')}`];
  const urls: string[] = [];
  for (const name of databases) {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    await markManagedTestDatabase(admin, name);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    urls.push(url.toString());
  }
  targetUrl = urls[0];
  target = postgres(targetUrl, { max: 1, onnotice: () => {} });
  backup = postgres(targetUrl, { max: 1, onnotice: () => {} });
  leases = postgres(urls[1], { max: 1, onnotice: () => {} });
  await target.unsafe('CREATE SCHEMA harness_shared; CREATE TABLE harness_shared.schema_migrations(filename text PRIMARY KEY, sha256 text);');
  // Match the fields read by the production fence predicate; keep lease truth
  // in a different DB, just like papercusp_su and the migration target.
  await leases.unsafe(`CREATE TABLE agent_resource_locks (
    coordination_domain text, resource text, lock_id uuid, fence_seq int,
    mode text, status text, expires_ts timestamptz, owner text
  )`);
  directory = mkdtempSync(join(tmpdir(), 'migration-fence-'));
}, 60_000);

beforeEach(async () => {
  await target.unsafe('DROP TABLE IF EXISTS proof_first, proof_second; TRUNCATE harness_shared.schema_migrations;');
  await leases.unsafe('TRUNCATE agent_resource_locks;');
  await leases`INSERT INTO agent_resource_locks VALUES (
    ${token.coordinationDomain}, 'db-schema', ${originalLock}, 7, 'exclusive', 'held',
    clock_timestamp() + interval '60 seconds', 'same-owner'
  )`;
});

afterEach(async () => {
  // Also unblock and join the child if an assertion fails mid-wait.
  if (backup) await backup`SELECT pg_advisory_unlock_all()`;
  if (pending) await pending;
  pending = undefined;
});

afterAll(async () => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  await Promise.all([target?.end({ timeout: 2 }), leases?.end({ timeout: 2 }), backup?.end({ timeout: 2 })]);
  if (admin) {
    for (const name of databases) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end({ timeout: 2 });
  }
});

function start(sqlText = 'CREATE TABLE proof_first(id int);', check = assertCurrent) {
  const file = join(directory, 'fixture.sql');
  writeFileSync(file, sqlText);
  const marker = `PAPERCUSP_MIGRATION_FENCE_${randomUUID().replace(/-/g, '')}`;
  // Exercise production backend binding; the test must not add the marker.
  pending = runPsql('psql', [targetUrl, '-X', '-v', 'ON_ERROR_STOP=1'], {
    encoding: 'utf8',
    input: migrationPsqlScript({ sqlText, resolvedFile: file, filenameLiteral: 'fixture.sql', sha256: 'test',
      lockTimeoutSec: 1, guardPreamble: migrationBackupAdvisoryLockSql(1), fenceMarker: marker }),
    fence: { marker, assertCurrent: check },
  });
  return marker;
}

async function waitForBackupWait(marker: string) {
  const deadline = Date.now() + 5_000;
  let terminal: Awaited<ReturnType<typeof runPsql>> | undefined;
  void pending?.then(result => { terminal = result; });
  let observed: unknown[] = [];
  do {
    const rows = await target`SELECT pid, state, wait_event, query FROM pg_stat_activity
      WHERE application_name = ${marker}`;
    observed = rows;
    const waiting = rows.find(row => row.wait_event === 'advisory');
    if (waiting) return waiting.pid;
    if (terminal) throw new Error(`Private migration exited before backup wait: ${JSON.stringify(terminal)}`);
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error(`Private migration backup-wait readiness deadline: ${JSON.stringify({ backend: observed, terminal })}`);
}

async function hasTable(name: string) {
  const [row] = await target`SELECT to_regclass(${name}) IS NOT NULL AS present`;
  return row.present;
}

describe('db:migrate exact fence through backup waits', () => {
  it('resumes a current lease after a real backup wait and records the migration', async () => {
    await backup`SELECT pg_advisory_lock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))`;
    const check = vi.fn(assertCurrent);
    const marker = start(undefined, check);
    await waitForBackupWait(marker);
    expect(await hasTable('proof_first')).toBe(false);
    await backup`SELECT pg_advisory_unlock_all()`;
    expect(await pending).toMatchObject({ status: 0, diagnostics: { backendApplicationName: marker } });
    expect((await pending)?.diagnostics?.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'sql-guards', state: 'fulfilled' }),
      expect.objectContaining({ phase: 'fence', state: 'fulfilled' }),
    ]));
    expect(check).toHaveBeenCalled();
    expect(await hasTable('proof_first')).toBe(true);
    expect(await target`SELECT filename FROM harness_shared.schema_migrations`).toHaveLength(1);
  });

  it.each(['expired', 'superseded'] as const)('cancels an %s original lease without cancelling the backup', async (kind) => {
    await backup`SELECT pg_advisory_lock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))`;
    const [{ pid: backupPid }] = await backup`SELECT pg_backend_pid() AS pid`;
    const check = vi.fn(assertCurrent);
    const marker = start(undefined, check);
    const migrationPid = await waitForBackupWait(marker);
    await leases`UPDATE agent_resource_locks SET expires_ts = clock_timestamp() - interval '1 second'`;
    // Same owner in a different domain must never renew the original lease.
    await leases`INSERT INTO agent_resource_locks VALUES (
      ${kind === 'expired' ? 'other-release' : token.coordinationDomain}, 'db-schema', ${randomUUID()}, 8,
      'exclusive', 'held', clock_timestamp() + interval '60 seconds', 'same-owner'
    )`;
    // Prove the timer is enabled before relying on its cancellation result.
    // Vitest owns the bounded deadline; cleanup unlocks and joins a failed run.
    await vi.waitFor(() => expect(check).toHaveBeenCalled(), { timeout: 4_000 });
    const result = await pending;
    expect(result?.staleFence).toMatchObject({ current: false, reason: kind === 'expired' ? 'expired_or_released' : 'superseded' });
    expect(result?.status).not.toBe(0);
    expect(result?.diagnostics).toMatchObject({ backendApplicationName: marker });
    expect(result?.diagnostics?.phases).toContainEqual(expect.objectContaining({ phase: 'fence', state: 'rejected' }));
    expect(await hasTable('proof_first')).toBe(false);
    expect(await target`SELECT filename FROM harness_shared.schema_migrations`).toHaveLength(0);
    // Child exit and PostgreSQL backend cleanup are separate transitions.
    // Await cleanup, and retain the exact backend state if it does not finish.
    await vi.waitFor(async () => {
      expect(await target`SELECT pid, state, wait_event, query FROM pg_stat_activity
        WHERE pid = ${migrationPid}`).toEqual([]);
    }, { timeout: 5_000, interval: 50 });
    expect(await target`SELECT pid FROM pg_stat_activity WHERE pid = ${backupPid}`).toHaveLength(1);
    const [{ acquired }] = await target`SELECT pg_try_advisory_lock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY})) AS acquired`;
    expect(acquired).toBe(false);
  }, 10_000);

  it('retains the lease-reader SQLSTATE and cancels only its own backup waiter', async () => {
    await backup`SELECT pg_advisory_lock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))`;
    const [{ pid: backupPid }] = await backup`SELECT pg_backend_pid() AS pid`;
    const marker = start();
    const migrationPid = await waitForBackupWait(marker);
    try {
      // Break only this private lease reader while the real backup wait is held.
      await leases.unsafe('ALTER TABLE agent_resource_locks RENAME TO unavailable_lease_table');
      const result = await pending;
      expect(result?.staleFence).toMatchObject({ current: false, reason: 'check_failed',
        checkFailure: [{ name: 'PostgresError', code: '42P01' }] });
      expect(result?.status).not.toBe(0);
      expect(await hasTable('proof_first')).toBe(false);
      expect(await target`SELECT filename FROM harness_shared.schema_migrations`).toHaveLength(0);
      await vi.waitFor(async () => {
        expect(await target`SELECT pid FROM pg_stat_activity WHERE pid = ${migrationPid}`).toEqual([]);
      }, { timeout: 5_000, interval: 50 });
      expect(await target`SELECT pid FROM pg_stat_activity WHERE pid = ${backupPid}`).toHaveLength(1);
      const [{ acquired }] = await target`SELECT pg_try_advisory_lock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY})) AS acquired`;
      expect(acquired).toBe(false);
    } finally {
      await leases.unsafe('ALTER TABLE unavailable_lease_table RENAME TO agent_resource_locks');
    }
  }, 10_000);

  it('checks again after the wait releases, before sending any DDL', async () => {
    await backup`SELECT pg_advisory_lock(hashtext(${BACKUP_MIGRATION_ADVISORY_LOCK_KEY}))`;
    const marker = start();
    await waitForBackupWait(marker);
    await leases`UPDATE agent_resource_locks SET expires_ts = clock_timestamp() - interval '1 second'`;
    await backup`SELECT pg_advisory_unlock_all()`;
    expect((await pending)?.staleFence?.reason).toBe('expired_or_released');
    expect(await hasTable('proof_first')).toBe(false);
  });

  it('revalidates each breakpoint and reports prior commits without admitting a later chunk', async () => {
    let checks = 0;
    const marker = start('CREATE TABLE proof_first(id int);\n--> statement-breakpoint\nCREATE TABLE proof_second(id int);', async () => {
      if (++checks === 2) await leases`UPDATE agent_resource_locks SET expires_ts = clock_timestamp() - interval '1 second'`;
      return assertCurrent();
    });
    expect(marker).toContain('PAPERCUSP_MIGRATION_FENCE_');
    expect((await pending)?.staleFence?.reason).toBe('expired_or_released');
    expect(await hasTable('proof_first')).toBe(true);
    expect(await hasTable('proof_second')).toBe(false);
    expect(await target`SELECT filename FROM harness_shared.schema_migrations`).toHaveLength(0);
  });

  it('finishes an already-applied branch without hanging on a skipped checkpoint', async () => {
    await target`INSERT INTO harness_shared.schema_migrations VALUES ('fixture.sql', 'test')`;
    start();
    expect(await pending).toMatchObject({ status: 0, stdout: expect.stringContaining('PAPERCUSP_MIGRATION_ALREADY_APPLIED') });
    expect(await hasTable('proof_first')).toBe(false);
    expect(await target`SELECT filename FROM harness_shared.schema_migrations`).toHaveLength(1);
  });
});
