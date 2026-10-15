// WI-10004820: a SQLSTATE 55P03 during a migration means another session holds a
// lock the DDL conflicts with. The runner's retry line and final failure used to
// name no holder, so a staging boot crash loop on migration 1295 (a long ad-hoc
// psql read holding ACCESS SHARE on the altered table) was attributed to backup
// contention. These cases pin that the runner now names the holder. The SQL
// itself is exercised against real pg_locks in
// migration-runner-lock-holders.integration.test.ts.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyPendingMigrations,
  describeMigrationLockHolders,
  migrationRelationNames,
} from '../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const dirs: string[] = [];

function fixtureDir(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), 'migration-runner-lock-holders-'));
  dirs.push(dir);
  writeFileSync(join(dir, '001-lock.sql'), sql, 'utf8');
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HOLDER_ROW = {
  pid: 716148,
  application_name: 'psql',
  state: 'active',
  mode: 'AccessShareLock',
  relation: 'harness_shared.session_identity_activation_events',
  age_sec: 2412,
  query: 'WITH s AS ( SELECT a.identity_activation_event_id AS event_id',
};

function lockTimeout() {
  return Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
}

/** A fake postgres-js client whose migration transactions fail `failures` times with `error`. */
function contendedClient(failures: number, error: () => Error, holders: unknown[] = [HOLDER_ROW]) {
  let remaining = failures;
  return {
    unsafe: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT filename')) return [];
      if (sql.includes('FROM pg_locks')) return holders;
      if (sql.startsWith('BEGIN;') && remaining > 0) {
        remaining -= 1;
        throw error();
      }
      return undefined;
    }),
  };
}

const ALTER = 'ALTER TABLE harness_shared.session_identity_activation_events ADD COLUMN note text;';

describe('migrationRelationNames', () => {
  it('collects schema-qualified names, quoted or not, once each in first-seen order', () => {
    expect(
      migrationRelationNames(
        'ALTER TABLE harness_shared.foo ADD COLUMN x int;\n' +
          'CREATE INDEX ON "harness_shared"."bar" (x);\n' +
          'UPDATE harness_shared.foo SET x = 1;',
      ),
    ).toEqual(['harness_shared.foo', 'harness_shared.bar']);
  });

  it('returns nothing for a chunk with no qualified identifier', () => {
    expect(migrationRelationNames('ALTER TABLE foo ADD COLUMN x int;')).toEqual([]);
  });
});

describe('describeMigrationLockHolders', () => {
  it('names each holder with application, state, transaction age, mode, relation and query', async () => {
    const client = contendedClient(0, lockTimeout);
    const text = await describeMigrationLockHolders(client, ALTER);
    expect(text).toBe(
      'lock holders (oldest first): pid 716148 (psql, active, txn 40m12s) holds AccessShareLock on ' +
        'harness_shared.session_identity_activation_events: WITH s AS ( SELECT a.identity_activation_event_id AS event_id',
    );
    const diagnosis = client.unsafe.mock.calls.map(([sql]) => sql).find((sql) => sql.includes('FROM pg_locks'));
    expect(diagnosis).toContain("IN ('harness_shared.session_identity_activation_events')");
    expect(diagnosis).toContain('pg_backend_pid()');
  });

  it('says so when no holder remains, instead of implying the lock was free all along', async () => {
    const text = await describeMigrationLockHolders(contendedClient(0, lockTimeout, []), ALTER);
    expect(text).toBe(
      'lock holders: none granted on harness_shared.session_identity_activation_events at diagnosis time ' +
        '(the holder may already have released)',
    );
  });

  it('does not query when the chunk names no qualified relation', async () => {
    const client = contendedClient(0, lockTimeout);
    expect(await describeMigrationLockHolders(client, 'ALTER TABLE foo ADD COLUMN x int;')).toMatch(/not diagnosed/);
    expect(client.unsafe).not.toHaveBeenCalled();
  });

  it('reports a failed diagnosis inline rather than throwing', async () => {
    const client = {
      unsafe: vi.fn(async () => {
        throw new Error('permission denied for view pg_locks');
      }),
    };
    await expect(describeMigrationLockHolders(client, ALTER)).resolves.toBe(
      'lock holders: diagnosis failed (permission denied for view pg_locks)',
    );
  });
});

describe('applyPendingMigrations on SQLSTATE 55P03', () => {
  it('names the lock holder on the retry line, then applies once the lock is free', async () => {
    const client = contendedClient(1, lockTimeout);
    const lines: string[] = [];
    const result = await applyPendingMigrations({ client, sqlDir: fixtureDir(ALTER), log: (l: string) => lines.push(l) });

    expect(result).toMatchObject({ appliedCount: 1, failed: [] });
    const retry = lines.find((l) => l.startsWith('retry 001-lock.sql after SQLSTATE 55P03'));
    expect(retry).toContain('(attempt 2/3); lock holders (oldest first): pid 716148 (psql, active, txn 40m12s)');
  });

  it('puts the holder in the final failure when every attempt times out', async () => {
    const client = contendedClient(3, lockTimeout);
    const result = await applyPendingMigrations({ client, sqlDir: fixtureDir(ALTER), continueOnError: true });

    expect(result.appliedCount).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain('(SQLSTATE 55P03)');
    expect(result.failed[0].error).toContain(
      "Another session holds a lock this migration's DDL conflicts with — lock holders (oldest first): pid 716148 (psql",
    );
  }, 15_000);

  it('runs no lock diagnosis for a non-lock failure', async () => {
    const client = contendedClient(1, () => Object.assign(new Error('syntax error at or near "ALTR"'), { code: '42601' }));
    const result = await applyPendingMigrations({ client, sqlDir: fixtureDir(ALTER), continueOnError: true });

    expect(result.failed[0].error).not.toContain('Another session holds a lock');
    expect(client.unsafe.mock.calls.some(([sql]) => sql.includes('FROM pg_locks'))).toBe(false);
  });
});
