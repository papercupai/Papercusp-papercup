/** Real-PG regressions for generation changes between a lane read and delete. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generated } from '@papercusp/db-org';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const fixture = vi.hoisted(() => ({ get: null as null | (() => unknown) }));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => fixture.get!(),
}));
vi.mock('./resource-profile', () => ({ getResourceProfile: () => ({ backgroundCadenceMultiplier: 1 }) }));
vi.mock('./harness-registry', () => ({ loadHarnessRegistry: async () => ({ projects: [] }) }));
import { _internals } from './harness-status-sweep';

let pg: FreshPgDb;
let database: ReturnType<typeof drizzle>;
let afterRead: (() => Promise<void>) | undefined;
const lane = generated.harnessLanesInHarnessShared;
const deadPid = 2147483646;
const oldStart = 1;

beforeAll(async () => {
  pg = await createFreshPgDb('lane_generation');
  // Minimal projection of harness_lanes in 000-baseline.sql: the exact generated
  // table and real Drizzle client still execute the production predicates.
  await pg.sql.unsafe(`CREATE TABLE harness_shared.harness_lanes (
    harness_slug text NOT NULL, phase text NOT NULL DEFAULT 'staging',
    role text NOT NULL, feature_id text, pid integer, started_at bigint NOT NULL,
    workspace_id text NOT NULL DEFAULT '', PRIMARY KEY (harness_slug, phase, role))`);
  database = drizzle(pg.sql);
  fixture.get = () => ({ sql: pg.sql, db: {
    select: (...args: Parameters<typeof database.select>) => {
      const query = database.select(...args);
      return { from: async (table: typeof lane) => {
        const snapshot = await query.from(table);
        const replace = afterRead;
        afterRead = undefined;
        await replace?.();
        return snapshot;
      } };
    },
    delete: database.delete.bind(database),
  } });
}, 90_000);
afterAll(async () => { fixture.get = null; await pg?.cleanup(); });
beforeEach(async () => { afterRead = undefined; await pg.sql`TRUNCATE harness_shared.harness_lanes`; });

async function insert(pid: number | null, startedAt = oldStart, role = 'worker') {
  await database.insert(lane).values({ harnessSlug: 'fixture', phase: 'staging', role, pid, startedAt });
}
async function rows() {
  return pg.sql`SELECT role, pid, started_at FROM harness_shared.harness_lanes ORDER BY role`;
}

describe('harness-status-sweep observed lane generation', () => {
  it('preserves a same-key live replacement installed after the dead PID snapshot', async () => {
    await insert(deadPid);
    const startedAt = Date.now();
    afterRead = async () => {
      await pg.sql`UPDATE harness_shared.harness_lanes SET pid=${process.pid}, started_at=${startedAt}`;
    };
    await _internals.sweepHarnessLanes();
    expect(await rows()).toEqual([{ role: 'worker', pid: process.pid, started_at: startedAt }]);
  });

  it('preserves a changed start generation even when the recorded PID is unchanged', async () => {
    await insert(deadPid);
    const startedAt = Date.now();
    afterRead = async () => { await pg.sql`UPDATE harness_shared.harness_lanes SET started_at=${startedAt}`; };
    await _internals.sweepHarnessLanes();
    expect(await rows()).toEqual([{ role: 'worker', pid: deadPid, started_at: startedAt }]);
  });

  it('preserves a PID captured after a stale null-PID snapshot with the same start time', async () => {
    await insert(null);
    afterRead = async () => { await pg.sql`UPDATE harness_shared.harness_lanes SET pid=${process.pid}`; };
    await _internals.sweepHarnessLanes();
    expect(await rows()).toEqual([{ role: 'worker', pid: process.pid, started_at: oldStart }]);
  });

  it('still removes unchanged dead and expired null-PID rows while retaining live and recent rows', async () => {
    await insert(deadPid, oldStart, 'dead');
    await insert(null, oldStart, 'expired');
    await insert(process.pid, oldStart, 'live');
    const startedAt = Date.now();
    await insert(null, startedAt, 'recent');
    await _internals.sweepHarnessLanes();
    expect(await rows()).toEqual([
      { role: 'live', pid: process.pid, started_at: oldStart },
      { role: 'recent', pid: null, started_at: startedAt },
    ]);
  });
});
