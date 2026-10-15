/**
 * claim-watchdog-fire.integration.test.ts — EI-6777.
 *
 * Proves, against a REAL Postgres (testcontainer), the actual property the
 * fix rests on: `claimWatchdogFire`'s advisory-lock-guarded check+insert lets
 * exactly ONE of N concurrent racers for the SAME debounce key win, closing
 * the check-then-act race that `recentWatchdogFires(...) > 0` then, later,
 * `recordFire(...)` had (two separate non-atomic steps — every racer could
 * observe "not fired yet" before any of them committed the insert). This
 * property is INVISIBLE to a PG-free/mocked unit test (a fake `sql` has no
 * real advisory-lock semantics to race against), so it needs a real DB.
 *
 * Mirrors pot-wake-pg.integration.test.ts's testcontainer setup (fresh DB +
 * hand-rolled minimal table shape, mocks `@papercusp/db-org` getOrgPg).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const WS = 'ws-claimfiretest';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { claimWatchdogFire, recentWatchdogFires } = await import('./watchdog');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `claimfire_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 10, onnotice: () => {} });
  h.sql = rootSql;
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // The 212-pot-watchdog-fires.sql shape, minus RLS/grants (not needed —
  // this connects as the DB owner, not the RLS-scoped harness_app role).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.pot_watchdog_fires (
      id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id  text NOT NULL,
      install_slug  text NOT NULL,
      fired_at      timestamptz NOT NULL DEFAULT now(),
      source        text NOT NULL,
      reason        text NOT NULL DEFAULT '',
      wake_at       timestamptz,
      demand        jsonb NOT NULL DEFAULT '{}'::jsonb,
      repeat_count  integer NOT NULL DEFAULT 1
    )
  `);
});

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

describe('claimWatchdogFire (EI-6777)', () => {
  it('the first claim for a fresh debounce key wins (returns true) and records the fire', async () => {
    const installSlug = `single::${randomBytes(4).toString('hex')}`;
    const claimed = await claimWatchdogFire({
      workspaceId: WS,
      installSlug,
      source: 'tick',
      reason: 'first',
      wakeAt: null,
    });
    expect(claimed).toBe(true);
    expect(await recentWatchdogFires(WS, installSlug, 24, 'tick')).toBe(1);
  });

  it('a second claim for the SAME key within the window loses (returns false) and does NOT double-insert', async () => {
    const installSlug = `sequential::${randomBytes(4).toString('hex')}`;
    const first = await claimWatchdogFire({ workspaceId: WS, installSlug, source: 'tick', reason: 'a', wakeAt: null });
    const second = await claimWatchdogFire({ workspaceId: WS, installSlug, source: 'tick', reason: 'b', wakeAt: null });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await recentWatchdogFires(WS, installSlug, 24, 'tick')).toBe(1);
  });

  it('a different `source` for the SAME (workspace, installSlug) is an independent debounce key', async () => {
    const installSlug = `multisource::${randomBytes(4).toString('hex')}`;
    const tick = await claimWatchdogFire({ workspaceId: WS, installSlug, source: 'tick', reason: 'a', wakeAt: null });
    const boot = await claimWatchdogFire({ workspaceId: WS, installSlug, source: 'boot', reason: 'b', wakeAt: null });
    expect(tick).toBe(true);
    expect(boot).toBe(true);
    expect(await recentWatchdogFires(WS, installSlug, 24)).toBe(2);
  });

  it(
    'THE RACE (EI-6777): N concurrent claims for the SAME debounce key — exactly ONE wins, not N',
    async () => {
      const installSlug = `race::${randomBytes(4).toString('hex')}`;
      const N = 12;
      // Fired truly concurrently (Promise.all, not sequential awaits) so every
      // racer's advisory-lock acquisition genuinely contends — this is the
      // exact shape of the incident (EI-6760/6761/6762: 3 escalations filed
      // within 20ms of each other by racing sweep ticks).
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          claimWatchdogFire({
            workspaceId: WS,
            installSlug,
            source: 'autoloop-chronic',
            reason: `racer-${i}`,
            wakeAt: null,
          }),
        ),
      );
      const wins = results.filter(Boolean).length;
      expect(wins).toBe(1);
      // And the ledger reflects exactly one recorded fire, not N.
      expect(await recentWatchdogFires(WS, installSlug, 24, 'autoloop-chronic')).toBe(1);
    },
  );

  it('EI-16071: a `scopeKey` narrows the debounce below `source` — two scoped conditions sharing (workspace, installSlug, source) are independent debounce keys', async () => {
    const installSlug = `scoped::${randomBytes(4).toString('hex')}`;
    const rubricA = await claimWatchdogFire({
      workspaceId: WS,
      installSlug,
      source: 'rubric-staleness',
      reason: `release-gating rubric 'rubric-a' has NO scorecard in the last 6h`,
      wakeAt: null,
      scopeKey: 'rubric-a',
    });
    const rubricB = await claimWatchdogFire({
      workspaceId: WS,
      installSlug,
      source: 'rubric-staleness',
      reason: `release-gating rubric 'rubric-b' has NO scorecard in the last 6h`,
      wakeAt: null,
      scopeKey: 'rubric-b',
    });
    // Both win — the bug this closes is rubric-b silently losing to rubric-a's fire
    // because the old debounce key was source-only (no scopeKey dimension).
    expect(rubricA).toBe(true);
    expect(rubricB).toBe(true);
    expect(await recentWatchdogFires(WS, installSlug, 24, 'rubric-staleness')).toBe(2);
    expect(await recentWatchdogFires(WS, installSlug, 24, 'rubric-staleness', 'rubric-a')).toBe(1);
    expect(await recentWatchdogFires(WS, installSlug, 24, 'rubric-staleness', 'rubric-b')).toBe(1);
    // A second claim for the SAME scopeKey within the window still loses — scoping
    // narrows the key, it does not disable the debounce for repeats of the same scope.
    const rubricARepeat = await claimWatchdogFire({
      workspaceId: WS,
      installSlug,
      source: 'rubric-staleness',
      reason: `release-gating rubric 'rubric-a' has NO scorecard in the last 6h`,
      wakeAt: null,
      scopeKey: 'rubric-a',
    });
    expect(rubricARepeat).toBe(false);
  });

  it('a claim outside the window fires again (the debounce is time-bounded, not permanent)', async () => {
    const installSlug = `windowed::${randomBytes(4).toString('hex')}`;
    // Backdate a fire to 25h ago — outside the default 24h window.
    await rootSql`
      INSERT INTO harness_shared.pot_watchdog_fires (workspace_id, install_slug, source, reason, fired_at)
      VALUES (${WS}, ${installSlug}, ${'tick'}, ${'old'}, now() - interval '25 hours')
    `;
    const claimed = await claimWatchdogFire({ workspaceId: WS, installSlug, source: 'tick', reason: 'fresh', wakeAt: null });
    expect(claimed).toBe(true);
    expect(await recentWatchdogFires(WS, installSlug, 24, 'tick')).toBe(1); // only the fresh one counts within 24h
  });
});
