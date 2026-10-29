import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../../packages/operator-core/test/_pg-helpers';
import { withCutSeedSingleton } from './cut-seed-cli';

describe('seed singleton with a live drainer', () => {
  let db: FreshPgDb;
  let data: postgres.Sql;
  let observer: postgres.Sql;
  const createLockClient = () => ({ sql: postgres(db.url, {
    max: 1, prepare: false,
    connection: { idle_in_transaction_session_timeout: 100 },
  }) });

  beforeAll(async () => {
    db = await createFreshPgDb('seed_singleton');
    data = postgres(db.url, { max: 1, prepare: false,
      connection: { idle_in_transaction_session_timeout: 100 } });
    observer = postgres(db.url, { max: 1, prepare: false });
    await data`CREATE TABLE harness_shared.seed_refresh_probe (id text PRIMARY KEY)`;
  }, 60_000);

  afterAll(async () => {
    await Promise.all([data?.end({ timeout: 2 }), observer?.end({ timeout: 2 })]);
    await db?.cleanup();
  });

  it('commits backfill rows before waiting for another connection to drain them', async () => {
    await withCutSeedSingleton({
      pg: data, workspaceId: 'seed-test', hive: 'visibility', createLockClient,
      run: async (pg) => {
        await pg`INSERT INTO harness_shared.seed_refresh_probe VALUES ('visible')`;
        const [{ visible }] = await observer<{ visible: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM harness_shared.seed_refresh_probe WHERE id = 'visible') AS visible`;
        expect(visible, 'the live drainer must see committed backfill while the cut still owns its lock').toBe(true);
        await observer`DELETE FROM harness_shared.seed_refresh_probe WHERE id = 'visible'`;
        const [{ remaining }] = await pg<{ remaining: number }[]>`
          SELECT count(*)::int AS remaining FROM harness_shared.seed_refresh_probe WHERE id = 'visible'`;
        expect(remaining).toBe(0);
      },
    });
  });

  it('keeps mutual exclusion across an external wait longer than the idle transaction limit', async () => {
    const options = { pg: data, workspaceId: 'seed-test', hive: 'external-wait', createLockClient };
    await withCutSeedSingleton({ ...options, run: async (pg) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await expect(withCutSeedSingleton({ ...options, run: async () => 'wrong' }))
        .rejects.toThrow('another seed cut is already refreshing or opening');
      const [{ alive }] = await pg<{ alive: number }[]>`SELECT 1 AS alive`;
      expect(alive).toBe(1);
    } });
    await expect(withCutSeedSingleton({ ...options, run: async () => 'released' })).resolves.toBe('released');
  });

  it('releases the lock when the protected callback fails', async () => {
    const options = { pg: data, workspaceId: 'seed-test', hive: 'failure', createLockClient };
    const failure = new Error('refresh failed');
    await expect(withCutSeedSingleton({ ...options, run: async () => { throw failure; } })).rejects.toBe(failure);
    await expect(withCutSeedSingleton({ ...options, run: async () => 'recovered' })).resolves.toBe('recovered');
  });
});
