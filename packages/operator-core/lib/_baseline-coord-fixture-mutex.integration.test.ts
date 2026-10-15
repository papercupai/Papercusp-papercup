/**
 * _baseline-coord-fixture-mutex.integration.test.ts — regression guard for
 * EI-18683737202696167 (concurrent integration-test runs leak rows across
 * files via the shared/reused baseline-schema testcontainer).
 *
 * `_baseline-coord-fixture.ts`'s `setupBaselineCoordFixture()` now serializes
 * every consumer of the shared coord tables via a Postgres session-level
 * advisory lock held from `setup()` until `dispose()` (see that file's doc
 * comment for the full root-cause). This test proves the mutual-exclusion
 * property directly and deterministically, within a single controlled test
 * process — it does NOT depend on which OTHER files happen to be running
 * concurrently on the box (that would be a flaky, fleet-load-dependent way to
 * prove this).
 *
 * Two concurrent `setupBaselineCoordFixture()` callers: the second must not
 * resolve (and, critically, must not touch the shared `HARNESS_DATABASE_URL`
 * / `HARNESS_ADMIN_DATABASE_URL` env vars the tools read from) until the
 * first has fully `dispose()`d.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';
import { getOrgPg } from '@papercusp/db-org';

describe('_baseline-coord-fixture mutex (EI-18683737202696167)', () => {
  let fx1: BaselineCoordFixture | undefined;
  let fx2: BaselineCoordFixture | undefined;
  let isolatedDb: OrgTestDb | undefined;

  afterEach(async () => {
    await fx1?.dispose().catch(() => {});
    await fx2?.dispose().catch(() => {});
    await isolatedDb?.cleanup();
    fx1 = undefined;
    fx2 = undefined;
    isolatedDb = undefined;
  });

  it('routes both fixture and coordination module connections to an explicit isolated DB', async () => {
    isolatedDb = await createOrgTestDb();
    fx1 = await setupBaselineCoordFixture({ dsn: isolatedDb.adminDsn });

    const [fixtureDb] = await fx1.admin`SELECT current_database() AS name`;
    const [moduleDb] = await getOrgPg().sql`SELECT current_database() AS name`;
    expect(fixtureDb.name).toBe(isolatedDb.dbName);
    expect(moduleDb.name).toBe(isolatedDb.dbName);
  }, 120_000);

  it('blocks a second setup() until the first fixture disposes', async () => {
    const events: string[] = [];

    fx1 = await setupBaselineCoordFixture();
    events.push('fx1-acquired');
    // Snapshot the env the first fixture pointed at the shared DB.
    const envDuringFx1 = process.env.HARNESS_ADMIN_DATABASE_URL;
    expect(envDuringFx1).toBeTruthy();

    // Start the second acquire WHILE the first still holds the fixture — it
    // must block on the mutex rather than racing fx1's env/DB state.
    const fx2Promise = setupBaselineCoordFixture().then((fx) => {
      events.push('fx2-acquired');
      return fx;
    });

    // Give fx2's bounded poll loop several cycles (it polls every 250ms) to
    // prove it is NOT resolving while fx1 still holds the mutex.
    await new Promise((r) => setTimeout(r, 800));
    expect(events).toEqual(['fx1-acquired']);
    // The env still reflects fx1 — fx2 has not mutated it out from under fx1.
    expect(process.env.HARNESS_ADMIN_DATABASE_URL).toBe(envDuringFx1);

    events.push('fx1-disposing');
    await fx1.dispose();
    fx1 = undefined;

    fx2 = await fx2Promise;
    expect(events).toEqual(['fx1-acquired', 'fx1-disposing', 'fx2-acquired']);
  }, 30_000);
});
