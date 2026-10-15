/**
 * pot-wake-pg.integration.test.ts — autoloop-hive-operator-rebuild-2026-06-05 P0.
 *
 * Proves, against the canonical fully migrated org fixture, that the
 * self-declared wake store round-trips:
 *   - declarePotTimeWake: one-shot routine row (no cron) with the clamped
 *     explicit next_fire_at, payload {blueprintId:'coding', launchInstallSlug},
 *     target system:blueprint-run.
 *   - listDueCronRoutines + claimDueRoutine: the one-shot is not-due in the
 *     future, due once past, DEACTIVATED on claim (no refire loop), and a
 *     second claim loses. A cron routine stays active and advances.
 *   - hive_wake state (migration 158): subscriptions + lastWakeAt round-trip.
 *
 * Uses real workspace-scoped transactions and the same schema/serializers as
 * production; a hand-curated migration subset misses new carry-note columns.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const WS = 'ws-hivetest';
const SLUG = 'pot-test-harness';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  appSql: undefined as unknown as postgres.Sql,
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: (ws: string, fn: (tx: postgres.TransactionSql) => unknown) =>
      h.appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
        return fn(tx);
      }),
  };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const { listDueCronRoutines } = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
const {
  declarePotTimeWake,
  clearPotTimeWake,
  getPotTimeWake,
  readPotWakeState,
  setPotEventSubscriptions,
  setPotCarryNote,
  getPotCarryNote,
  getPotCarryJournal,
  recordPotWake,
  POT_WAKE_ROUTINE_NAME,
} = await import('./wake');
const { claimDueRoutine } = await import('../harness/routines/claim');
const { _resetReactionsForTests, listReactionRules, registerReactionRule } = await import('../events/registry');

let rootSql: postgres.Sql;
let db: OrgTestDb;
let priorRules: ReturnType<typeof listReactionRules> = [];

beforeAll(async () => {
  priorRules = listReactionRules();
  db = await createOrgTestDb();
  rootSql = h.sql = db.adminSql;
  h.appSql = db.appSql;
}, 90_000);

afterAll(async () => {
  _resetReactionsForTests();
  priorRules.forEach(registerReactionRule);
  await db?.cleanup();
});

describe('declarePotTimeWake (the one-shot time wake)', () => {
  it('writes a one-shot routine: no cron, explicit clamped next_fire_at, pot payload', async () => {
    const now = new Date();
    const requested = new Date(now.getTime() + 3600_000);
    const r = await declarePotTimeWake(rootSql, { workspaceId: WS, installSlug: SLUG, at: requested, now });
    expect(r.clamped).toBe(false);
    expect(r.at).toEqual(requested);

    const rows = await rootSql<
      Array<{ trigger_config: Record<string, unknown>; target_role: string; payload_template: Record<string, unknown>; active: boolean; next_fire_at: Date }>
    >`SELECT trigger_config, target_role, payload_template, active, next_fire_at
        FROM harness_shared.routines
       WHERE workspace_id = ${WS} AND name = ${POT_WAKE_ROUTINE_NAME}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(true);
    expect(rows[0].trigger_config.cron).toBeUndefined();
    expect(rows[0].target_role).toBe('system:blueprint-run');
    expect(rows[0].payload_template.blueprintId).toBe('coding');
    expect(rows[0].payload_template.launchInstallSlug).toBe(SLUG);
    expect(new Date(rows[0].next_fire_at).getTime()).toBe(requested.getTime());
  });

  it('clamps a too-soon wake to now + floor', async () => {
    const now = new Date();
    const r = await declarePotTimeWake(rootSql, {
      workspaceId: WS,
      installSlug: SLUG,
      at: new Date(now.getTime() - 1000),
      now,
    });
    expect(r.clamped).toBe(true);
    expect(r.at.getTime()).toBe(now.getTime() + 60_000);
  });

  it('is not due in the future; due + claimable once past; DEACTIVATED on claim (one-shot, no refire)', async () => {
    // Future wake: not in the due list.
    const due0 = await listDueCronRoutines(rootSql);
    expect(due0.some((r) => r.name === POT_WAKE_ROUTINE_NAME)).toBe(false);

    // Force it due (the tick's view once the wall clock passes next_fire_at).
    await rootSql`UPDATE harness_shared.routines SET next_fire_at = now() - interval '1 second'
                   WHERE workspace_id = ${WS} AND name = ${POT_WAKE_ROUTINE_NAME}`;
    const due1 = await listDueCronRoutines(rootSql);
    const routine = due1.find((r) => r.name === POT_WAKE_ROUTINE_NAME);
    expect(routine).toBeDefined();

    // First claim wins and DEACTIVATES (one-shot).
    expect(await claimDueRoutine(rootSql, routine!)).toBe(true);
    const after = await rootSql<Array<{ active: boolean; next_fire_at: Date | null }>>`
      SELECT active, next_fire_at FROM harness_shared.routines
       WHERE workspace_id = ${WS} AND name = ${POT_WAKE_ROUTINE_NAME}`;
    expect(after[0].active).toBe(false);
    expect(after[0].next_fire_at).toBeNull();

    // No refire loop: it is gone from the due list, and a second claim loses.
    const due2 = await listDueCronRoutines(rootSql);
    expect(due2.some((r) => r.name === POT_WAKE_ROUTINE_NAME)).toBe(false);
    expect(await claimDueRoutine(rootSql, routine!)).toBe(false);
  });

  it('a CRON routine stays active and advances on claim (regression guard)', async () => {
    const { upsertRoutine } = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
    const { computeNextFireAt } = await import('../harness/routines/cron');
    await upsertRoutine(
      rootSql,
      {
        workspaceId: WS,
        installSlug: SLUG,
        name: 'cron-regression',
        triggerKind: 'cron',
        triggerConfig: { cron: '0 */5 * * * *' },
        targetRole: 'system:git-sync',
        active: true,
      },
      computeNextFireAt,
    );
    await rootSql`UPDATE harness_shared.routines SET next_fire_at = now() - interval '1 second'
                   WHERE install_slug = ${SLUG} AND name = 'cron-regression'`;
    const due = await listDueCronRoutines(rootSql);
    const routine = due.find((r) => r.name === 'cron-regression');
    expect(routine).toBeDefined();
    expect(await claimDueRoutine(rootSql, routine!)).toBe(true);
    const after = await rootSql<Array<{ active: boolean; next_fire_at: Date | null }>>`
      SELECT active, next_fire_at FROM harness_shared.routines
       WHERE install_slug = ${SLUG} AND name = 'cron-regression'`;
    expect(after[0].active).toBe(true);
    expect(after[0].next_fire_at).not.toBeNull();
    expect(new Date(after[0].next_fire_at!).getTime()).toBeGreaterThan(Date.now());
  });

  it('re-declaring reactivates (upsert) and clearPotTimeWake deletes the row (EI-1477)', async () => {
    const r = await declarePotTimeWake(rootSql, {
      workspaceId: WS,
      installSlug: SLUG,
      at: new Date(Date.now() + 7200_000),
    });
    expect(r.clamped).toBe(false);
    let state = await getPotTimeWake(rootSql, SLUG, { workspaceId: WS });
    expect(state?.active).toBe(true);

    // EI-1477: clearPotTimeWake now DELETEs the row (not just deactivates) to avoid
    // zombie rows that collide with a subsequent UPSERT under concurrency.
    await clearPotTimeWake(rootSql, SLUG, { workspaceId: WS });
    state = await getPotTimeWake(rootSql, SLUG, { workspaceId: WS });
    expect(state).toBeNull(); // row is fully deleted, not just set inactive

    // Re-declaring after clear must succeed (no stale row to collide with).
    const r2 = await declarePotTimeWake(rootSql, {
      workspaceId: WS,
      installSlug: SLUG,
      at: new Date(Date.now() + 3600_000),
    });
    state = await getPotTimeWake(rootSql, SLUG, { workspaceId: WS });
    expect(state?.active).toBe(true);
    expect(r2.clamped).toBe(false);
  });

  it('EI-1477: repeat-declare in the same turn UPSERTs in place (no duplicate-key collision)', async () => {
    const t1 = new Date(Date.now() + 3600_000);
    await declarePotTimeWake(rootSql, { workspaceId: WS, installSlug: SLUG, at: t1 });

    // Immediately re-declare with a later time — must UPSERT, not INSERT+collide.
    const t2 = new Date(Date.now() + 7200_000);
    const r2 = await declarePotTimeWake(rootSql, { workspaceId: WS, installSlug: SLUG, at: t2 });
    expect(r2.at.getTime()).toBe(t2.getTime());

    // Exactly ONE routine row must exist (no duplicates from the second declare).
    const rows = await rootSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.routines
       WHERE workspace_id = ${WS} AND name = ${POT_WAKE_ROUTINE_NAME}`;
    expect(rows[0].n).toBe(1);

    // The stored nextFireAt must reflect the SECOND (later) declare.
    const finalState = await getPotTimeWake(rootSql, SLUG, { workspaceId: WS });
    expect(new Date(finalState!.nextFireAt!).getTime()).toBe(t2.getTime());
  });
});

describe('hive_wake state (migration 158)', () => {
  it('subscriptions + lastWakeAt round-trip per workspace', async () => {
    expect((await readPotWakeState(WS)).subscriptions).toEqual([]);

    const n = await setPotEventSubscriptions(WS, [
      { on: 'coord:escalate', note: 'integration round-trip' },
    ]);
    expect(n).toBe(1);

    const s1 = await readPotWakeState(WS);
    expect(s1.subscriptions).toHaveLength(1);
    expect(s1.subscriptions[0].on).toBe('coord:escalate');
    expect(s1.declaredAt).toBeTypeOf('number');

    await recordPotWake(WS);
    const s2 = await readPotWakeState(WS);
    expect(s2.lastWakeAt).toBeTypeOf('number');
    expect(s2.subscriptions).toHaveLength(1); // merge, not clobber

    await setPotEventSubscriptions(WS, []);
    expect((await readPotWakeState(WS)).subscriptions).toEqual([]);
  });

  it('carry-note (P-015 / B-04) round-trips with replace-semantics, coexists with subscriptions', async () => {
    // Fresh: no carry-note.
    expect(await getPotCarryNote(WS)).toBeNull();

    // Set one — round-trips via getPotCarryNote and lands in the carry-JOURNAL
    // (the note converged onto the shared carry-note substrate, P-001).
    const stored = await setPotCarryNote(WS, '  Mid-wave on plan-x; revisit when wi-101 lands.  ');
    expect(stored).toBe('Mid-wave on plan-x; revisit when wi-101 lands.'); // trimmed
    expect(await getPotCarryNote(WS)).toBe('Mid-wave on plan-x; revisit when wi-101 lands.');
    const j1 = await getPotCarryJournal(WS);
    expect(j1[0]?.note).toBe('Mid-wave on plan-x; revisit when wi-101 lands.'); // newest-first

    // Coexists with subscriptions — they live in different tables now, so neither
    // can clobber the other (the carry-note is NOT in the hive_wake payload).
    await setPotEventSubscriptions(WS, [{ on: 'coord:escalate', note: 'x' }]);
    expect(await getPotCarryNote(WS)).toBe('Mid-wave on plan-x; revisit when wi-101 lands.');
    expect((await readPotWakeState(WS)).subscriptions).toHaveLength(1);

    // Replace-semantics: a new note replaces the old (and appends to the journal).
    await setPotCarryNote(WS, 'New intention.');
    expect(await getPotCarryNote(WS)).toBe('New intention.');

    // Empty / whitespace / undefined clears the note (she carried nothing this
    // wake); the carry-JOURNAL trajectory persists through the clear (L1a).
    expect(await setPotCarryNote(WS, '   ')).toBeNull();
    expect(await getPotCarryNote(WS)).toBeNull();
    expect((await getPotCarryJournal(WS)).length).toBeGreaterThanOrEqual(2); // journal survived the clear
    await setPotCarryNote(WS, 'again');
    expect(await setPotCarryNote(WS, undefined)).toBeNull();
    expect(await getPotCarryNote(WS)).toBeNull();
    // Subscriptions survived all the carry-note churn.
    expect((await readPotWakeState(WS)).subscriptions).toHaveLength(1);
  });
});
