/**
 * red-inflow-repair-first.integration.test.ts — red-gate inflow control
 * (green-main-cycle-time-2026-10-08 P-017, design D-032 / D-033), proven through the REAL
 * scheduler:get_next resolver (getNextWorkItem) against real Postgres.
 *
 * Acceptance clause AUTO-BAR-R-15-P-017@2 is falsified if: no members move during a long
 * red; moved members take neither failing-leg items nor attributed per-sync red items;
 * members take new backlog first; or the behaviour is not behind a registered flag. Each
 * case below targets one of those:
 *
 *   MOVE      — past 8h of red, a fleet member in the repair-first share claims a
 *               frozen-repair-leg: item, then a sync-delta-red: item, before OLDER backlog
 *               that sits inside its own lane (D-033: the lane does not hide repair work),
 *               and only then the backlog, with a redInflow stamp saying why each time.
 *   SHARE     — a member outside the share keeps the normal order.
 *   THRESHOLD — under 8h of red, nobody moves.
 *   FLAG      — FLAGS.RED_INFLOW_REPAIR_FIRST off ⇒ nobody moves.
 *   UNFLEETED — a caller with no fleet slug is not a drain-fleet member and never moves.
 *   EXCLUDED  — the queue-level frozen-repair-convergence: item, the gate-red-streak
 *               singleton and an ordinary bug are NOT repair-first items (D-028/D-032 r3).
 *   SCOPE     — a red on another harness moves nobody here.
 *
 * The feature tier never sees condition_key (D-032 ruling 5): in MOVE the same get_next call
 * that runs the preclaim falls through to the feature tier, which would raise a PG error on
 * an unknown column.
 *
 * Real Postgres (testcontainer; Docker required).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import {
  applyEventSubstrateMigrationsForTest,
  COORD_SUBSCRIPTION_SUBSTRATE,
  createFreshPgDb,
  type FreshPgDb,
} from '../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  applyClaimPathReadDeps,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
import type { ClaimSpec } from './claim-spec';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const { getNextWorkItem } = await import('./get-next');
const { validateClaimSpec } = await import('./claim-spec');
const { RED_INFLOW_REPAIR_FIRST_HOURS, redInflowMemberSelected } = await import('../work-items-admission');

const H = 'papercup';
const H2 = 'other-harness';
const WS = 'default';
const FLEET = 'red-inflow-drain';
const HOUR_MS = 3_600_000;
let db: FreshPgDb;

/** A strict feature-only drain lane: its backlog is features, never condition items. */
const LANE: ClaimSpec = {
  specVersion: '1.0',
  specId: 'red-inflow-lane',
  revision: 1,
  view: { filter: { field: 'kind', op: 'in', value: ['feature'] } },
  rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
};

/** `n` distinct ownerIds whose stable share bucket is in (want=true) or out of the share. */
function members(want: boolean, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < n && i < 10_000; i += 1) {
    const id = `su-red-inflow-${i}`;
    if (redInflowMemberSelected(id) === want) out.push(id);
  }
  expect(out).toHaveLength(n);
  return out;
}

async function seedFeature(id: string, createdTs: number) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, workspace_id, created_ts, updated_ts, title)
    VALUES (${H}, ${id}, 'feature', 'open', ${WS}, ${createdTs}, 0, ${'feature ' + id})`;
}

async function seedIssue(
  id: string,
  opts: { conditionKey?: string; createdTs: number; harness?: string; kind?: string; status?: string },
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, workspace_id, origin, created_ts, updated_ts,
       title, condition_key)
    VALUES (${opts.harness ?? H}, ${id}, ${opts.kind ?? 'bug'}, ${opts.status ?? 'open'}, ${WS}, 'local',
            ${opts.createdTs}, 0, ${'issue ' + id}, ${opts.conditionKey ?? null})`;
}

/** The open gate-red-streak:<harness> item that says the gate has been red for `hours`. */
async function seedRed(hours: number, harness = H) {
  await seedIssue(`WI-RED-${harness}`, {
    harness,
    conditionKey: `gate-red-streak:${harness}`,
    createdTs: Date.now() - hours * HOUR_MS,
  });
}

/** The normal backlog (old) and both repair kinds (newer), so age order alone favours backlog. */
async function seedBacklogAndRepair() {
  await seedFeature('F-BACKLOG', 1_000);
  await seedIssue('WI-LEG', { conditionKey: `frozen-repair-leg:${H}:lane-unit`, createdTs: Date.now() - 60_000 });
  await seedIssue('WI-SYNC', { conditionKey: 'sync-delta-red:packages/x/y.test.ts', createdTs: Date.now() - 30_000 });
}

async function takenBy(id: string): Promise<string | null> {
  const [row] = await db.sql<{ taken_by: string | null }[]>`
    SELECT taken_by FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND feature_id = ${id}`;
  return row?.taken_by ?? null;
}

beforeAll(async () => {
  db = await createFreshPgDb('red-inflow-repair-first');
  h.sql = db.sql;
  // Same claim-path substrate as get-next.integration.test.ts: every successful claim emits
  // work-item:claimed:<id> through the real awaited-event surface.
  await applyEventSubstrateMigrationsForTest(db.sql, {
    label: 'scheduler/red-inflow-repair-first.integration.test.ts',
    ...COORD_SUBSCRIPTION_SUBSTRATE,
  });
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.coord_thread_posts (
      id BIGSERIAL PRIMARY KEY,
      workspace_id text NOT NULL
    );`).simple();
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.adv_sessions (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL, coord_owner_id text,
      role text, started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz, ended_by text, launch_spec jsonb
    );
    CREATE TABLE harness_shared.session_briefs (
      workspace_id text NOT NULL, owner_id text NOT NULL, control_state jsonb,
      PRIMARY KEY (workspace_id, owner_id)
    );
  `).simple();
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`).simple();
  expect(validateClaimSpec(LANE).ok).toBe(true);

  // Warm the WHOLE claim path once, outside every test's deadline. The first get_next in a
  // fresh worker pays the transform of its lazily imported module graph: measured 14.1s
  // before the first preclaim step under host load, while the preclaim itself took 63ms.
  // Left in the first test, that cold window tripped a 5s pool-acquire deadline.
  setFlagOverridesForTest({
    [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
    [FLAGS.RED_INFLOW_REPAIR_FIRST]: true,
  });
  await seedRed(RED_INFLOW_REPAIR_FIRST_HOURS + 1);
  await seedIssue('WI-WARM', { conditionKey: `frozen-repair-leg:${H}:warm`, createdTs: 1 });
  await seedFeature('F-WARM', 1);
  const [warm] = members(true, 1);
  await getNextWorkItem(LANE, { assignee: warm }, { harness: H, fleetSlug: FLEET });
  await getNextWorkItem(LANE, { assignee: `${warm}-2` }, { harness: H, fleetSlug: FLEET });
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  setFlagOverridesForTest({
    [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
    [FLAGS.RED_INFLOW_REPAIR_FIRST]: true,
  });
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps,
    harness_shared.adv_sessions, harness_shared.session_briefs`;
});

describe('P-017 red-gate inflow control through scheduler:get_next', () => {
  it('MOVE: past 8h a share member takes the leg item, then the per-sync red, then backlog', async () => {
    await seedRed(RED_INFLOW_REPAIR_FIRST_HOURS + 1);
    await seedBacklogAndRepair();
    const [a, b, c] = members(true, 3);

    const first = await getNextWorkItem(LANE, { assignee: a }, { harness: H, fleetSlug: FLEET });
    expect(first?.workItem.id).toBe('WI-LEG');
    expect(first?.redInflow).toMatchObject({ applied: true, thresholdHours: 8, sharePct: 50 });
    expect(first?.redInflow?.redSinceHours).toBeGreaterThanOrEqual(8.9);

    const second = await getNextWorkItem(LANE, { assignee: b }, { harness: H, fleetSlug: FLEET });
    expect(second?.workItem.id).toBe('WI-SYNC');
    expect(second?.redInflow?.applied).toBe(true);

    // No repair item left: the preference falls through to the member's own backlog, in the
    // SAME call, through the feature tier (which would error if condition_key leaked into it).
    const third = await getNextWorkItem(LANE, { assignee: c }, { harness: H, fleetSlug: FLEET });
    expect(third?.workItem.id).toBe('F-BACKLOG');
    expect(third?.redInflow?.applied).toBe(false);

    expect(await takenBy('WI-LEG')).toBe(a);
    expect(await takenBy('WI-SYNC')).toBe(b);
    // The red-streak singleton itself is never self-selected (LIVE_GATE_OPS, D-028).
    expect(await takenBy(`WI-RED-${H}`)).toBeNull();
  });

  it('SHARE: a member outside the share takes backlog first', async () => {
    await seedRed(RED_INFLOW_REPAIR_FIRST_HOURS + 1);
    await seedBacklogAndRepair();
    const [outside] = members(false, 1);

    const res = await getNextWorkItem(LANE, { assignee: outside }, { harness: H, fleetSlug: FLEET });
    expect(res?.workItem.id).toBe('F-BACKLOG');
    expect(res?.redInflow).toBeUndefined();
    expect(await takenBy('WI-LEG')).toBeNull();
    expect(await takenBy('WI-SYNC')).toBeNull();
  });

  it('THRESHOLD: under 8h of red nobody moves', async () => {
    await seedRed(RED_INFLOW_REPAIR_FIRST_HOURS - 1);
    await seedBacklogAndRepair();
    const [inShare] = members(true, 1);

    const res = await getNextWorkItem(LANE, { assignee: inShare }, { harness: H, fleetSlug: FLEET });
    expect(res?.workItem.id).toBe('F-BACKLOG');
    expect(res?.redInflow).toBeUndefined();
  });

  it('FLAG: the registered kill-switch off keeps the normal order', async () => {
    setFlagOverridesForTest({
      [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
      [FLAGS.RED_INFLOW_REPAIR_FIRST]: false,
    });
    await seedRed(RED_INFLOW_REPAIR_FIRST_HOURS + 1);
    await seedBacklogAndRepair();
    const [inShare] = members(true, 1);

    const res = await getNextWorkItem(LANE, { assignee: inShare }, { harness: H, fleetSlug: FLEET });
    expect(res?.workItem.id).toBe('F-BACKLOG');
    expect(res?.redInflow).toBeUndefined();
  });

  it('UNFLEETED: a caller with no fleet slug is not moved', async () => {
    await seedRed(RED_INFLOW_REPAIR_FIRST_HOURS + 1);
    await seedBacklogAndRepair();
    const [inShare] = members(true, 1);

    const res = await getNextWorkItem(LANE, { assignee: inShare }, { harness: H });
    expect(res?.workItem.id).toBe('F-BACKLOG');
    expect(res?.redInflow).toBeUndefined();
  });

  it('EXCLUDED: convergence, red-streak and ordinary bugs are not repair-first items', async () => {
    await seedRed(RED_INFLOW_REPAIR_FIRST_HOURS + 1);
    await seedFeature('F-BACKLOG', 1_000);
    await seedIssue('WI-CONVERGE', { conditionKey: `frozen-repair-convergence:${H}`, createdTs: 2_000 });
    await seedIssue('WI-PLAIN-BUG', { createdTs: 2_000 });
    const [inShare] = members(true, 1);

    const res = await getNextWorkItem(LANE, { assignee: inShare }, { harness: H, fleetSlug: FLEET });
    expect(res?.workItem.id).toBe('F-BACKLOG');
    expect(res?.redInflow?.applied).toBe(false);
    expect(await takenBy('WI-CONVERGE')).toBeNull();
    expect(await takenBy('WI-PLAIN-BUG')).toBeNull();
  });

  it('SCOPE: a long red on another harness moves nobody here', async () => {
    await seedRed(RED_INFLOW_REPAIR_FIRST_HOURS + 1, H2);
    await seedBacklogAndRepair();
    const [inShare] = members(true, 1);

    const res = await getNextWorkItem(LANE, { assignee: inShare }, { harness: H, fleetSlug: FLEET });
    expect(res?.workItem.id).toBe('F-BACKLOG');
    expect(res?.redInflow).toBeUndefined();
  });
});
