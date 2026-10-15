import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { createPgDiagnosticHooks, pgResultDiagnosticSnapshot } from '@papercusp/db-org';

describe('postgres.js reserved query queue after backend close', () => {
  let db: FreshPgDb;
  let sql: postgres.Sql;

  beforeAll(async () => {
    db = await createFreshPgDb('reserved-query-close');
    // One in-flight query fills the only pipeline slot; the next query stays in
    // postgres.js reserve()'s private queue until the backend is killed.
    // `max_pipeline` is a real runtime option (postgres/src/index.js parseOptions
    // defaults it to 100) that the package's typings omit, so a literal object
    // trips TS2353. A non-literal argument skips the excess-property check while
    // `max` and `prepare` stay type-checked against Options.
    const options = { max: 1, max_pipeline: 1, prepare: false,
      ...createPgDiagnosticHooks('reserved-query-timing') };
    sql = postgres(db.url, options);
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 1 }).catch(() => {});
    await db?.cleanup();
  });

  it('measures queries held behind a reserved connection separately from their execution', async () => {
    const reserved = await sql.reserve();
    const queued = sql`SELECT 42 AS answer`;
    let result: Promise<postgres.Row[]> | undefined;
    let released = false;
    try {
      // Leave the lazy query unexecuted before starting the controlled wait.
      await new Promise(resolve => setTimeout(resolve, 40));
      expect((queued as unknown as { diagnosticHandleStartedAt?: number }).diagnosticHandleStartedAt).toBeUndefined();
      result = queued.execute().then(rows => rows);
      await vi.waitFor(() => expect(
        (queued as unknown as { diagnosticHandleStartedAt?: number }).diagnosticHandleStartedAt,
      ).toEqual(expect.any(Number)), { timeout: 1_000, interval: 5 });
      await new Promise(resolve => setTimeout(resolve, 120));
      reserved.release();
      released = true;
      expect((await result)[0].answer).toBe(42);
      const records = pgResultDiagnosticSnapshot('reserved-query-timing').results;
      const terminal = records.find(row => row.queryFamily === 'select' && row.command === 'select');
      expect(terminal).toBeDefined();
      expect((terminal as typeof terminal & { preBuildMs: number }).preBuildMs).toBeGreaterThanOrEqual(100);
      expect(terminal!.elapsedMs).toEqual(expect.any(Number));
      expect(terminal!.elapsedMs).toBeGreaterThanOrEqual(0);
    } finally {
      if (!released) reserved.release();
      await result?.catch(() => {});
    }
  });

  it('rejects every queued reserved query when Postgres closes the connection', async () => {
    const reserved = await sql.reserve();
    try {
      const [backend] = await reserved<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
      const active = reserved`SELECT pg_sleep(60)`.execute().then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );
      const pipelined = reserved`SELECT 41 AS answer`.execute().then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );
      const queued = reserved`SELECT 42 AS answer`.execute().then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );

      await vi.waitFor(async () => {
        const [activity] = await db.sql<{ state: string }[]>`
          SELECT state FROM pg_stat_activity WHERE pid = ${backend.pid}`;
        expect(activity?.state).toBe('active');
      }, { timeout: 5_000, interval: 20 });

      const [terminated] = await db.sql<{ terminated: boolean }[]>`
        SELECT pg_terminate_backend(${backend.pid}) AS terminated`;
      expect(terminated.terminated).toBe(true);
      await expect(active).resolves.toBe('rejected');
      await expect(pipelined).resolves.toBe('rejected');

      let timer: ReturnType<typeof setTimeout> | undefined;
      const queuedResult = await Promise.race([
        queued,
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), 2_000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      expect(queuedResult).toBe('rejected');
    } finally {
      reserved.release();
    }
  });
});
