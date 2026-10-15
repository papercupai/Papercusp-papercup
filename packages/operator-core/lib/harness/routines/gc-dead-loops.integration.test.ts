/**
 * gc-dead-loops — the retention sweep for `loop-<ownerId>` routine rows
 * (agents-system-pane-split-2026-07-26 P-007), proven against a real migrated
 * Postgres.
 *
 * WHAT IS ACTUALLY AT STAKE: this is a DELETE against the table that holds every
 * schedule in the system, driven by a LIKE pattern. The interesting assertions are
 * therefore not "does it delete" but "what does it refuse to delete" — an armed
 * loop, a loop whose session is still alive, a recently-armed loop whose presence
 * row has not been written yet, and above all anything that is not a loop at all.
 * Each of those is a separate test below.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/gc-dead-loops.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { DEAD_LOOP_RETENTION_DAYS_DEFAULT, gcDeadLoops } from './gc-dead-loops';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-gc-loops';
const HARNESS = 'papercup';

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});
afterAll(async () => {
  await org?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.autoloop_state WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.coord_presence WHERE workspace_id = ${WS}`;
});

/** Days-ago helper — every fixture is expressed in age, which is what the sweep keys on. */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function seedRoutine(over: {
  name: string;
  targetOwnerId?: string | null;
  targetRole?: string;
  active?: boolean;
  lastFiredDaysAgo?: number | null;
  createdDaysAgo?: number;
}): Promise<void> {
  const id = `rt_${WS}_${over.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const lastFired =
    over.lastFiredDaysAgo === null || over.lastFiredDaysAgo === undefined
      ? null
      : daysAgo(over.lastFiredDaysAgo);
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       target_owner_id, concurrency, catchup, active, last_fired_at, created_at)
    VALUES (${id}, ${HARNESS}, ${WS}, ${over.name}, 'cron', '{}'::jsonb,
            ${over.targetRole ?? 'system:loop-wake'}, ${over.targetOwnerId ?? null},
            'skip', 'skip-old', ${over.active ?? false}, ${lastFired},
            ${daysAgo(over.createdDaysAgo ?? 60)})`;
}

async function seedPresence(ownerId: string, lastActiveDaysAgo: number): Promise<void> {
  await sql`
    INSERT INTO harness_shared.coord_presence (workspace_id, owner_id, last_active_at)
    VALUES (${WS}, ${ownerId}, ${daysAgo(lastActiveDaysAgo)})
    ON CONFLICT DO NOTHING`;
}

async function seedFireState(over: {
  harnessSlug: string;
  role: string;
  consecutiveErrors?: number;
  lastFiredDaysAgo?: number;
  lastStatus?: string;
}): Promise<void> {
  await sql`
    INSERT INTO harness_shared.autoloop_state
      (harness_slug, role, last_fired_at, last_status, consecutive_errors, workspace_id)
    VALUES
      (${over.harnessSlug}, ${over.role}, ${daysAgo(over.lastFiredDaysAgo ?? 30)},
       ${over.lastStatus ?? 'error: dead loop'}, ${over.consecutiveErrors ?? 7}, ${WS})`;
}

const names = async (): Promise<string[]> => {
  const rows = await sql<Array<{ name: string }>>`
    SELECT name FROM harness_shared.routines WHERE workspace_id = ${WS} ORDER BY name`;
  return rows.map((r) => r.name);
};

describe('gcDeadLoops — what it reaps', () => {
  it('reaps an inactive loop whose owner has been silent past the window', async () => {
    await seedRoutine({ name: 'loop-su-dead', targetOwnerId: 'su-dead', lastFiredDaysAgo: 30 });
    await seedPresence('su-dead', 30);

    const res = await gcDeadLoops({ sql, workspaceId: WS });
    expect(res.reaped).toBe(1);
    expect(await names()).toEqual([]);
  });

  // The dominant real case: the presence row is reaped on its own TTL long before
  // anyone looks, so "no presence row at all" is the strongest evidence of death.
  it('reaps an inactive loop with NO presence row at all', async () => {
    await seedRoutine({ name: 'loop-su-ghost', targetOwnerId: 'su-ghost', lastFiredDaysAgo: 30 });

    const res = await gcDeadLoops({ sql, workspaceId: WS });
    expect(res.reaped).toBe(1);
    expect(await names()).toEqual([]);
  });

  it('reports without deleting under dryRun', async () => {
    await seedRoutine({ name: 'loop-su-dead', targetOwnerId: 'su-dead', lastFiredDaysAgo: 30 });

    const res = await gcDeadLoops({ sql, workspaceId: WS, dryRun: true });
    expect(res.reaped).toBe(1);
    expect(res.dryRun).toBe(true);
    expect(await names()).toEqual(['loop-su-dead']);
  });

  it('honours maxPerRun so a runaway sweep is slow rather than total', async () => {
    for (let i = 0; i < 5; i++) {
      await seedRoutine({ name: `loop-su-d${i}`, targetOwnerId: `su-d${i}`, lastFiredDaysAgo: 30 });
    }
    const res = await gcDeadLoops({ sql, workspaceId: WS, maxPerRun: 2 });
    expect(res.reaped).toBe(2);
    expect(await names()).toHaveLength(3);
  });

  // Migration 939 permits exactly one fire-state row per owner-loop role.
  // Exercise each surviving historical location independently instead of
  // constructing a split that the migrated database correctly rejects.
  it.each(['*', HARNESS])('atomically reaps matching fire-state under historical slug %s', async (harnessSlug) => {
    await seedRoutine({ name: 'loop-su-dead', targetOwnerId: 'su-dead', lastFiredDaysAgo: 30 });
    await seedFireState({ harnessSlug, role: 'loop-su-dead', lastStatus: 'error: prior install' });

    const res = await gcDeadLoops({ sql, workspaceId: WS });
    expect(res.reaped).toBe(1);
    expect(
      await sql`SELECT 1 FROM harness_shared.autoloop_state
                 WHERE workspace_id = ${WS} AND role = 'loop-su-dead'`,
    ).toEqual([]);
    expect(await names()).toEqual([]);
  });

  it('preserves fire-state when a same-name loop is active under another install slug', async () => {
    await seedRoutine({ name: 'loop-su-rehomed', targetOwnerId: 'su-dead', lastFiredDaysAgo: 30 });
    const liveId = `rt_${WS}_rehomed_live`;
    await sql`
      INSERT INTO harness_shared.routines
        (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
         target_owner_id, concurrency, catchup, active, last_fired_at, created_at)
      VALUES (${liveId}, 'new-install', ${WS}, 'loop-su-rehomed', 'cron', '{}'::jsonb,
              'system:loop-wake', 'su-live', 'skip', 'skip-old', true, now(), now())`;
    await seedFireState({ harnessSlug: '*', role: 'loop-su-rehomed' });

    const res = await gcDeadLoops({ sql, workspaceId: WS });
    expect(res.reaped).toBe(1);
    expect(
      await sql`SELECT harness_slug, role FROM harness_shared.autoloop_state
                 WHERE workspace_id = ${WS} AND role = 'loop-su-rehomed'`,
    ).toEqual([{ harness_slug: '*', role: 'loop-su-rehomed' }]);
    expect(await names()).toEqual(['loop-su-rehomed']);
  });
});

describe('gcDeadLoops — what it refuses to touch', () => {
  // The single most important assertion in this file. `name LIKE 'loop-%'` is a
  // blunt instrument pointed at the table holding every schedule in the system.
  it('never touches a non-loop routine, however old and inactive', async () => {
    await seedRoutine({
      name: 'git-sync',
      targetRole: 'system:git-sync',
      targetOwnerId: null,
      active: false,
      lastFiredDaysAgo: 400,
      createdDaysAgo: 400,
    });
    await seedRoutine({
      name: 'green-checkpoint',
      targetRole: 'system:green-checkpoint',
      targetOwnerId: null,
      active: false,
      lastFiredDaysAgo: 400,
      createdDaysAgo: 400,
    });

    const res = await gcDeadLoops({ sql, workspaceId: WS });
    expect(res.reaped).toBe(0);
    expect(await names()).toEqual(['git-sync', 'green-checkpoint']);
  });

  // A name can start with "loop-" without being a loop; `target_owner_id` is what
  // actually identifies one (loop.ts materialises it per owning session).
  it('never touches a loop-named routine with no target_owner_id', async () => {
    await seedRoutine({
      name: 'loop-watcher-sweep',
      targetRole: 'system:some-sweep',
      targetOwnerId: null,
      lastFiredDaysAgo: 90,
    });

    const res = await gcDeadLoops({ sql, workspaceId: WS });
    expect(res.reaped).toBe(0);
    expect(await names()).toEqual(['loop-watcher-sweep']);
  });

  // `active` is the owner's own switch. A long cadence is legitimate, so age alone
  // must never be enough to reap an ARMED loop.
  it('never touches an ARMED loop, however long since it fired', async () => {
    await seedRoutine({
      name: 'loop-su-armed',
      targetOwnerId: 'su-armed',
      active: true,
      lastFiredDaysAgo: 365,
      createdDaysAgo: 365,
    });

    const res = await gcDeadLoops({ sql, workspaceId: WS });
    expect(res.reaped).toBe(0);
    expect(await names()).toEqual(['loop-su-armed']);
  });

  it('keeps an inactive loop whose session is still alive', async () => {
    await seedRoutine({ name: 'loop-su-live', targetOwnerId: 'su-live', lastFiredDaysAgo: 30 });
    await seedPresence('su-live', 0);

    const res = await gcDeadLoops({ sql, workspaceId: WS });
    expect(res.reaped).toBe(0);
    expect(await names()).toEqual(['loop-su-live']);
  });

  // The race this guard exists for: a loop armed minutes ago has no presence row
  // written yet, which would otherwise read exactly like a long-dead session.
  it('keeps a freshly-created loop that has never fired and has no presence row', async () => {
    await seedRoutine({
      name: 'loop-su-fresh',
      targetOwnerId: 'su-fresh',
      lastFiredDaysAgo: null,
      createdDaysAgo: 0,
    });

    const res = await gcDeadLoops({ sql, workspaceId: WS });
    expect(res.reaped).toBe(0);
    expect(await names()).toEqual(['loop-su-fresh']);
  });

  it('keeps a dead loop that fired inside the retention window', async () => {
    await seedRoutine({
      name: 'loop-su-recent',
      targetOwnerId: 'su-recent',
      lastFiredDaysAgo: DEAD_LOOP_RETENTION_DAYS_DEFAULT - 1,
    });

    const res = await gcDeadLoops({ sql, workspaceId: WS });
    expect(res.reaped).toBe(0);
    expect(await names()).toEqual(['loop-su-recent']);
  });

  it('never crosses a workspace boundary', async () => {
    await seedRoutine({ name: 'loop-su-dead', targetOwnerId: 'su-dead', lastFiredDaysAgo: 30 });

    const res = await gcDeadLoops({ sql, workspaceId: 'some-other-workspace' });
    expect(res.reaped).toBe(0);
    expect(await names()).toEqual(['loop-su-dead']);
  });

  it('is idempotent — a second pass finds nothing', async () => {
    await seedRoutine({ name: 'loop-su-dead', targetOwnerId: 'su-dead', lastFiredDaysAgo: 30 });

    expect((await gcDeadLoops({ sql, workspaceId: WS })).reaped).toBe(1);
    expect((await gcDeadLoops({ sql, workspaceId: WS })).reaped).toBe(0);
  });
});
