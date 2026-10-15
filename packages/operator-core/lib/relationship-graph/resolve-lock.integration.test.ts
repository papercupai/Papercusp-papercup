/**
 * The relationship-graph resolve lock against real Postgres, with transaction pooling simulated
 * (WI-10006902).
 *
 * The operator reaches Postgres through pgbouncer in `pool_mode = transaction`. There a reserved
 * client connection does NOT pin a server backend: consecutive autocommit statements can run on
 * different backends. The old resolve lock took a SESSION advisory lock on `sql.reserve()`, so the
 * unlock could land on another backend, return false, and leave the lock held by a pooled backend
 * for its whole life. Every later resolve of that (workspace, datatype) then failed with
 * `canceling statement due to lock timeout`, and connector person records stopped resolving.
 *
 * `transactionPooled` reproduces the pooler: its `reserve()` sends alternate statements to two
 * different connections. Properties under test:
 *   - a resolve leaves NO advisory lock behind on any backend, and the next resolve from another
 *     connection takes the lock at once;
 *   - resolves still serialize: a resolve waits while another transaction holds the same key, and
 *     proceeds when that transaction ends.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { resolveIdentities } from './resolver';

const WS = 'resolve-lock-test-ws';
const DATATYPE = 'person' as const;

/**
 * The resolver's lock key, restated rather than imported so this guard also runs against a
 * resolver that predates the fix (scripts/mutation-probe.sh historical mode). If the key format
 * changes, the serialize test below fails, because its holder no longer blocks a resolve.
 */
function resolveLockKey(workspaceId: string, datatype: string): string {
  return `relationship-graph:${workspaceId}:${datatype}`;
}

let org: OrgTestDb;
let pool: Sql;
let probe: Sql;

/**
 * Wrap a pool so `reserve()` behaves like a client connection behind pgbouncer's transaction
 * pooling: statements alternate between two server connections. A transaction (`begin`) is
 * passed through untouched, because the pooler does pin a transaction to one backend.
 */
function transactionPooled(sql: Sql): Sql {
  return new Proxy(sql, {
    get(target, prop, receiver) {
      if (prop !== 'reserve') return Reflect.get(target, prop, receiver);
      return async () => {
        const a = await target.reserve();
        const b = await target.reserve();
        let n = 0;
        const handle = ((strings: TemplateStringsArray, ...values: unknown[]) =>
          (n++ % 2 === 0 ? a : b)(strings, ...(values as never[]))) as unknown as Sql & { release: () => void };
        handle.release = () => {
          a.release();
          b.release();
        };
        return handle;
      };
    },
  });
}

async function heldResolveLocks(): Promise<number[]> {
  const rows = await probe<Array<{ pid: number }>>`
    WITH k AS (SELECT hashtextextended(${resolveLockKey(WS, DATATYPE)}, 0) AS h)
    SELECT l.pid FROM pg_locks l, k
     WHERE l.locktype = 'advisory' AND l.granted
       AND l.classid::bigint = ((k.h >> 32) & 4294967295) AND l.objid::bigint = (k.h & 4294967295)`;
  return rows.map((r) => r.pid);
}

beforeAll(async () => {
  org = await createOrgTestDb();
  pool = postgres(org.adminDsn, { max: 6, onnotice: () => {} });
  probe = postgres(org.adminDsn, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await pool?.end({ timeout: 5 }).catch(() => {});
  await probe?.end({ timeout: 5 }).catch(() => {});
  await org?.cleanup();
});

describe('relationship-graph resolve lock behind a transaction pooler (WI-10006902)', () => {
  it('the pooler simulation is real: a session lock on a reserved handle leaks', async () => {
    // Calibration: without this, a passing test below could mean the simulation never split.
    const reserved = await (transactionPooled(pool) as unknown as { reserve: () => Promise<Sql & { release: () => void }> }).reserve();
    const key = `${resolveLockKey(WS, DATATYPE)}:calibration`;
    await reserved`SELECT pg_advisory_lock(hashtextextended(${key}, 0))`;
    const [unlock] = await reserved<Array<{ ok: boolean }>>`SELECT pg_advisory_unlock(hashtextextended(${key}, 0)) AS ok`;
    reserved.release();
    expect(unlock!.ok).toBe(false);
    // Clean up the leaked calibration lock by closing every pooled backend.
    await pool.end({ timeout: 5 });
    pool = postgres(org.adminDsn, { max: 6, onnotice: () => {} });
  });

  it('a resolve leaves no advisory lock behind, and the next resolve gets the lock at once', async () => {
    const pooled = transactionPooled(pool);
    await resolveIdentities(pooled, { workspaceId: WS, datatype: DATATYPE, recordIds: [] });
    expect(await heldResolveLocks()).toEqual([]);

    // A separate session with a short lock_timeout, as harness_admin has 15s in production.
    const other = postgres(org.adminDsn, { max: 2, onnotice: () => {}, connection: { lock_timeout: 1000 } });
    try {
      await resolveIdentities(other, { workspaceId: WS, datatype: DATATYPE, recordIds: [] });
      expect(await heldResolveLocks()).toEqual([]);
    } finally {
      await other.end({ timeout: 5 });
    }
  });

  it('resolves still serialize on the key: a resolve waits for a holder and proceeds after it ends', async () => {
    let releaseHolder!: () => void;
    const holderReleased = new Promise<void>((resolve) => { releaseHolder = resolve; });
    let holderHasLock!: () => void;
    const holderLocked = new Promise<void>((resolve) => { holderHasLock = resolve; });
    const holder = probe.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${resolveLockKey(WS, DATATYPE)}, 0))`;
      holderHasLock();
      await holderReleased;
    });
    await holderLocked;

    let finished = false;
    const resolving = resolveIdentities(transactionPooled(pool), { workspaceId: WS, datatype: DATATYPE, recordIds: [] })
      .then(() => { finished = true; });
    await new Promise((r) => setTimeout(r, 400));
    expect(finished).toBe(false);

    releaseHolder();
    await holder;
    await resolving;
    expect(finished).toBe(true);
    expect(await heldResolveLocks()).toEqual([]);
  });
});
