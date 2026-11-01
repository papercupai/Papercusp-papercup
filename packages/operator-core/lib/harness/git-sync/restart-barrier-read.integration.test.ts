import postgres, { type Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { locksHost } from '@papercusp/locks';
import { readGitSyncRestartBarrierQueue } from './restart-barrier-read';

function adminDatabaseUrl(): string {
  return locksHost().getAdminBaseUrl();
}

describe('git-sync restart-barrier reads (PostgreSQL integration)', () => {
  it('recovers from an actual ACCESS EXCLUSIVE relation-lock timeout and reads the drain row', async () => {
    const adminSql = postgres(adminDatabaseUrl(), { max: 1, prepare: false });
    const schema = `git_sync_restart_${randomUUID().replace(/-/g, '')}`;
    const escapedSchema = `"${schema}"`;
    let readerSql: Sql | null = null;
    let blockerSql: Sql | null = null;
    let releaseBarrier = () => {};
    let blockerWork: Promise<unknown> | null = null;

    try {
      await adminSql.unsafe(`CREATE SCHEMA ${escapedSchema}`);
      await adminSql.unsafe(`
        CREATE TABLE ${escapedSchema}.agent_resource_locks (
          coordination_domain text NOT NULL,
          resource text NOT NULL,
          owner text NOT NULL,
          owner_label text,
          mode text NOT NULL,
          status text NOT NULL,
          lock_id uuid NOT NULL,
          reason text,
          acquired_ts timestamptz NOT NULL,
          expires_ts timestamptz NOT NULL,
          fence_seq integer NOT NULL
        )
      `);
      await adminSql.unsafe(`
        CREATE TABLE ${escapedSchema}.agent_resource_exclusive_queue (
          coordination_domain text NOT NULL,
          ticket_id uuid NOT NULL,
          resource text NOT NULL,
          owner text NOT NULL,
          owner_label text,
          reason text,
          ttl_sec integer NOT NULL,
          queued_ts timestamptz NOT NULL,
          expires_ts timestamptz NOT NULL
        )
      `);

      readerSql = postgres(adminDatabaseUrl(), { max: 1, prepare: false });
      blockerSql = postgres(adminDatabaseUrl(), { max: 1, prepare: false });
      await readerSql`SELECT set_config('search_path', ${schema}, false)`;
      await blockerSql`SELECT set_config('search_path', ${schema}, false)`;
      const visible = await readerSql<{ schema_name: string }[]>`SELECT current_schema() AS schema_name`;
      expect(visible[0]?.schema_name).toBe(schema);
      await readerSql`
        INSERT INTO agent_resource_locks (
          coordination_domain, resource, owner, owner_label, mode, status,
          lock_id, reason, acquired_ts, expires_ts, fence_seq
        ) VALUES (
          'git-sync-restart-test', 'git-sync', 'system:dev-restart:test', 'restart drain',
          'exclusive', 'draining', ${randomUUID()}::uuid, 'integration test',
          clock_timestamp(), clock_timestamp() + interval '1 minute', 0
        )
      `;

      let markLocked!: () => void;
      const locked = new Promise<void>((resolve) => { markLocked = resolve; });
      let unblock!: () => void;
      const barrier = new Promise<void>((resolve) => { unblock = resolve; });
      releaseBarrier = unblock;
      blockerWork = blockerSql.begin(async (tx) => {
        await tx`LOCK TABLE agent_resource_locks IN ACCESS EXCLUSIVE MODE`;
        markLocked();
        await barrier;
      });
      await locked;

      let beginCount = 0;
      const trackedSql = new Proxy(readerSql, {
        get(target, property, receiver) {
          if (property === 'begin') {
            const begin = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
            return (...args: unknown[]) => {
              beginCount += 1;
              return begin.apply(target, args);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }) as Sql;
      const readResult = readGitSyncRestartBarrierQueue(trackedSql, {
        coordinationDomain: 'git-sync-restart-test',
        resource: 'git-sync',
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      const deadline = Date.now() + 5_000;
      while (beginCount < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(beginCount).toBeGreaterThanOrEqual(2);
      releaseBarrier();
      const result = await readResult;
      if (!result.ok) throw result.error;
      expect(result.value.draining).toBe(true);
      expect(result.value.holders).toEqual([
        expect.objectContaining({ owner: 'system:dev-restart:test', mode: 'exclusive', status: 'draining' }),
      ]);
    } finally {
      releaseBarrier();
      await blockerWork?.catch(() => {});
      await readerSql?.end({ timeout: 1 });
      await blockerSql?.end({ timeout: 1 });
      await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${escapedSchema} CASCADE`);
      await adminSql.end({ timeout: 1 });
    }
  }, 20_000);
});
