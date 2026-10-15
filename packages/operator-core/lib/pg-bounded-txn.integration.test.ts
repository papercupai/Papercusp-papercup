/**
 * Real postgres.js cancellation coverage for boundedOrgTxn. A mocked cancel()
 * promise cannot reveal rejections from the driver's in-flight query object.
 *
 * Run: npx vitest run --config vitest.integration.config.ts lib/pg-bounded-txn.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { boundedOrgTxn, type BoundedOrgTxnOptions } from './pg-bounded-txn';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('boundedOrgTxn (real PostgreSQL cancellation)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('settles a lost reserved connection and reacquires on the same single-connection client', async () => {
    const isolated = await createOrgTestDb({ adminPoolMax: 1 });
    let releaseWork!: () => void;
    const workReleased = new Promise<void>((resolve) => { releaseWork = resolve; });
    let markReserved!: (pid: number) => void;
    const reserved = new Promise<number>((resolve) => { markReserved = resolve; });
    let transaction: Promise<unknown> | undefined;
    let lateError: unknown;
    let markLateSettled!: () => void;
    const lateSettled = new Promise<void>((resolve) => { markLateSettled = resolve; });

    try {
      transaction = boundedOrgTxn(async (tx) => {
        const [row] = await tx.unsafe('SELECT pg_backend_pid() AS pid');
        markReserved(Number(row?.pid));
        await workReleased;
        try {
          return await tx.unsafe('SELECT 1 AS n');
        } catch (error) {
          lateError = error;
          throw error;
        } finally {
          markLateSettled();
        }
      }, {
        client: isolated.adminSql as BoundedOrgTxnOptions['client'],
        acquireTimeoutMs: 2_000,
        acquireRetries: 0,
      });
      // Connection loss can reject before the test reaches its assertion.
      void transaction.catch(() => undefined);
      const pid = await reserved;
      expect(pid).toBeGreaterThan(0);

      // Use the independent fixture client and restrict termination to the
      // backend this test reserved in its own disposable database.
      const terminated = await db.adminSql`
        SELECT pg_terminate_backend(pid) AS terminated
        FROM pg_stat_activity
        WHERE pid = ${pid} AND datname = ${isolated.dbName}
      `;
      expect(terminated).toEqual([{ terminated: true }]);
      await expect(transaction).rejects.toThrow();

      // Resume the abandoned callback only after the driver's close signal.
      // It must not submit its old transaction's query on a new reservation.
      releaseWork();
      await lateSettled;
      expect(lateError).toMatchObject({ code: 'CONNECTION_CLOSED' });

      expect(await boundedOrgTxn((tx) => tx.unsafe('SELECT 1 AS n'), {
        client: isolated.adminSql as BoundedOrgTxnOptions['client'],
        acquireTimeoutMs: 2_000,
        acquireRetries: 0,
      })).toEqual([{ n: 1 }]);
      expect(await isolated.adminSql.unsafe('SELECT 1 AS n')).toEqual([{ n: 1 }]);
    } finally {
      releaseWork();
      await isolated.cleanup();
      await transaction?.catch(() => undefined);
    }
  }, 20_000);

  it('rejects queries on a closed explicit reservation without poisoning the pool', async () => {
    const isolated = await createOrgTestDb({ adminPoolMax: 1 });
    let markClosed!: () => void;
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    isolated.adminSql.options.onclose = markClosed;
    const reserved = await isolated.adminSql.reserve();
    try {
      const [row] = await reserved.unsafe('SELECT pg_backend_pid() AS pid');
      const pid = Number(row?.pid);
      expect(pid).toBeGreaterThan(0);
      expect(await db.adminSql`
        SELECT pg_terminate_backend(pid) AS terminated
        FROM pg_stat_activity
        WHERE pid = ${pid} AND datname = ${isolated.dbName}
      `).toEqual([{ terminated: true }]);
      await closed;

      await expect(reserved.unsafe('SELECT 1 AS n')).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
      reserved.release();
      expect(await boundedOrgTxn((tx) => tx.unsafe('SELECT 1 AS n'), {
        client: isolated.adminSql as BoundedOrgTxnOptions['client'],
        acquireTimeoutMs: 2_000,
        acquireRetries: 0,
      })).toEqual([{ n: 1 }]);
    } finally {
      reserved.release();
      await isolated.cleanup();
    }
  }, 20_000);

  it('rejects an explicitly released reservation while the client remains usable', async () => {
    const isolated = await createOrgTestDb({ adminPoolMax: 1 });
    try {
      const reserved = await isolated.adminSql.reserve();
      expect(await reserved.unsafe('SELECT 1 AS n')).toEqual([{ n: 1 }]);
      reserved.release();
      await expect(reserved.unsafe('SELECT 1 AS n')).rejects.toMatchObject({ code: 'CONNECTION_RELEASED' });
      reserved.release();
      expect(await isolated.adminSql.unsafe('SELECT 1 AS n')).toEqual([{ n: 1 }]);
    } finally {
      await isolated.cleanup();
    }
  }, 20_000);

  it('rolls back a begin that resolves after its deadline without setup SQL or caller work', async () => {
    const isolated = await createOrgTestDb({ adminPoolMax: 1 });
    let releaseHeld: () => void = () => {};
    let markHeldStarted!: () => void;
    const heldStarted = new Promise<void>((resolve) => { markHeldStarted = resolve; });
    const holdConnection = new Promise<void>((resolve) => { releaseHeld = resolve; });
    let heldPid = 0;
    let heldTxn: Promise<unknown> | undefined;
    let settleLateBegin!: () => void;
    const lateBeginSettled = new Promise<void>((resolve) => { settleLateBegin = resolve; });
    const setupQueries: string[] = [];
    let callerRan = false;

    try {
      heldTxn = Promise.resolve(isolated.adminSql.begin(async (tx) => {
        const [row] = await tx.unsafe('SELECT pg_backend_pid() AS pid');
        heldPid = Number(row?.pid ?? 0);
        markHeldStarted();
        await holdConnection;
      }));
      void heldTxn.catch(() => undefined);
      await heldStarted;

      const tracingClient = {
        begin: (callback: (tx: unknown) => Promise<unknown>) => {
          const pending = isolated.adminSql.begin(async (rawTx) => {
            const tracedTx = new Proxy(rawTx as (...args: unknown[]) => unknown, {
              apply(target, thisArg, args) {
                const strings = args[0];
                if (Array.isArray(strings)) setupQueries.push(strings.join('?'));
                return Reflect.apply(target, thisArg, args);
              },
            });
            return callback(tracedTx);
          });
          void Promise.resolve(pending).then(settleLateBegin, settleLateBegin);
          return pending;
        },
      } as unknown as BoundedOrgTxnOptions['client'];

      const pending = boundedOrgTxn(async () => {
        callerRan = true;
        return 'unreachable';
      }, {
        client: tracingClient,
        readOnly: true,
        acquireTimeoutMs: 40,
        acquireRetries: 0,
      });

      await expect(pending).rejects.toMatchObject({
        name: 'DbCallDeadlineError',
        label: 'boundedOrgTxn:begin(admin)',
        deadlineMs: 40,
      });
      expect(setupQueries).toEqual([]);

      releaseHeld();
      await heldTxn;
      await lateBeginSettled;

      expect(heldPid).toBeGreaterThan(0);
      expect(callerRan).toBe(false);
      const activeTransactions = await isolated.adminSql.unsafe(
        'SELECT pid FROM pg_stat_activity ' +
          'WHERE datname = current_database() AND usename = current_user ' +
          'AND xact_start IS NOT NULL AND pid <> pg_backend_pid()',
      );
      expect(activeTransactions).toEqual([]);
      expect(await isolated.adminSql.unsafe('SELECT 1 AS n')).toEqual([{ n: 1 }]);
      expect(setupQueries).toEqual([]);
    } finally {
      releaseHeld();
      await heldTxn?.catch(() => undefined);
      await isolated.cleanup();
    }
  }, 20_000);

  it('observes the canceled in-flight query and keeps the pool usable', async () => {
    const controller = new AbortController();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    let queryStarted!: () => void;
    const started = new Promise<void>((resolve) => { queryStarted = resolve; });

    try {
      const transaction = boundedOrgTxn(async (tx) => {
        const query = tx.unsafe('SELECT pg_sleep(2)');
        queryStarted();
        await query;
      }, {
        client: db.adminSql as BoundedOrgTxnOptions['client'],
        signal: controller.signal,
        statementTimeoutMs: 10_000,
      });

      await started;
      // postgres.js queries are lazy; this allows the await above to submit it.
      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort(new Error('test abort'));
      await expect(transaction).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
      expect(await db.adminSql`SELECT 1 AS n`).toEqual([{ n: 1 }]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 20_000);

  it('does not turn a composed SQL fragment into an unobserved query on abort', async () => {
    const controller = new AbortController();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    let queryStarted!: () => void;
    const started = new Promise<void>((resolve) => { queryStarted = resolve; });

    try {
      const transaction = boundedOrgTxn(async (tx) => {
        const where = tx`WHERE true`;
        const query = tx`SELECT pg_sleep(2) ${where}`;
        queryStarted();
        await query;
      }, {
        client: db.adminSql as BoundedOrgTxnOptions['client'],
        signal: controller.signal,
        statementTimeoutMs: 10_000,
      });

      await started;
      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort(new Error('test abort'));
      await expect(transaction).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
      expect(await db.adminSql`SELECT 1 AS n`).toEqual([{ n: 1 }]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 20_000);
});
