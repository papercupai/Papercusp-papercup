/**
 * spend-rollup.integration.test — the goal spend rollup against a real Postgres
 * (goal-mode-design-intent-hardening-2026-08-16 P-005 / D-003, and
 * work-on-everything-stewardship-remediation-2026-08-30 P-003 / D-011).
 *
 * Behaviors a fake-sql unit test can't prove (same lesson as
 * convert.integration.test.ts: the unit-mocked halves had "never been proven to
 * compose"):
 *  - the LINEAGE leg (samples stamped with the goal's id at INSERT) is the one
 *    authoritative spentCents, and it cross-cuts the diagnostic legs instead of
 *    agreeing with any of them;
 *  - the diagnostic POT leg (goalSpend, real @papercusp/db-org SQL) and SESSION
 *    leg (sessionSpendForGoal) still partition the ledger EXACTLY — a sample
 *    carrying both a goal-pot harness AND a goal-member session id is counted
 *    ONCE (by the pot leg), which only real SQL executing the NOT IN exclusion
 *    can demonstrate;
 *  - the goal-lifetime lower bound (GREATEST vs goals.created_at) and the budget
 *    window on every leg;
 *  - unmeasured stays unmeasured: no attributed samples, or any unpriced one in
 *    the window, snapshots null with a named reason, never 0;
 *  - a breach PAUSES the goal (D-011 clause 5) rather than killing it;
 *  - the sweep's scope: ACTIVE goals only, flag-gated per tick.
 *
 * The falsifiability control is the exact-cents assertion on the partition
 * fixture: lineage 105c, pot 150c, session 55c, diagnostic total 205c. An
 * implementation reading any other leg as authoritative lands on one of the
 * other three numbers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const flagMock = vi.hoisted(() => ({ getFlag: vi.fn(async () => true) }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: flagMock.getFlag }));
// The breach pause escalates to the owner. Mocked so this suite never writes an
// escalation into whatever operator database the process can reach, and so the
// escalation itself is asserted rather than assumed.
const escalationMock = vi.hoisted(() => ({ openEscalation: vi.fn(async () => ({ ok: true })) }));
vi.mock('../agent-tools/coordination/escalations', () => ({ openEscalation: escalationMock.openEscalation }));

import { computeGoalSpendRollup, runGoalSpendRollupOnce, sessionSpendForGoal } from './spend-rollup';
import { GOAL_SPEND_SNAPSHOT_SOURCE } from '@papercusp/db-org';
import { GOAL_MODE } from '../modes/goal-session';
import { checkGoalInferenceAdmission, resolveGoalLaunchForGoal } from '../goal-launch-settings';

const WS = 'default';
const GOAL = 'goal-rollup-1';
const OTHER_GOAL = 'goal-rollup-2';
const GOAL_CREATED = '2026-08-01T00:00:00Z';
const GOAL_MS = Date.parse(GOAL_CREATED);
const LINEAGE_SCOPE = 'attributed-by-lineage:authoritative';

let rootSql: postgres.Sql;
let rootUrl: string;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `spendroll_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootUrl = u.toString();
  rootSql = postgres(rootUrl, { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // Minimal fixture DDL — only the columns the rollup SQL touches (precedent:
  // convert.integration.test.ts's agent_modes/session_briefs fixtures).
  // audit_log is deliberately absent: the pause's goal:write audit is
  // best-effort and tolerates a missing table (write-audit.ts, 42P01).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.goals (
      id text PRIMARY KEY, workspace_id text NOT NULL,
      title text NOT NULL DEFAULT 'Measured launch budget', body text,
      kill_criterion text, standing boolean NOT NULL DEFAULT false,
      launch_settings jsonb,
      status text NOT NULL DEFAULT 'active',
      metadata jsonb, budget_cents bigint,
      -- budget_window_sec: migration 914, the DENOMINATOR for budget_cents
      -- (work-on-everything-goal-2026-08-23 P-004). NULL = per goal lifetime.
      --
      -- ⚠ SECOND OCCURRENCE of the drift the tripwires comment below records.
      -- The pattern is now confirmed, not anecdotal: a hand-rolled fixture is
      -- schema-complete for the columns the code touches TODAY, so it silently
      -- falls one behind the moment production SQL reads a new one — and the
      -- affected-tests selector cannot pick this file from the migration diff,
      -- because the migration does not touch it. Adding a column to
      -- harness_shared.goals means auditing this block by hand.
      budget_window_sec integer,
      -- tripwires: a COLUMN since migration 765, and the one P-004 advances.
      -- This fixture predated the sweep reading it and was silently a column
      -- behind production until that read landed.
      tripwires jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await rootSql.unsafe(`
    -- Keep this schema-COMPLETE against migration 765's goal_pots. A fixture
    -- that hand-rolls a harness_shared table only stays correct while it names
    -- every column the code under test touches, and it falls behind silently:
    -- the migration that added a column never touches THIS file, so
    -- test:affected does not select it and the strand surfaces only when
    -- somebody runs the suite. That is what happened here: added_at landed, the
    -- pot-leg query in @papercusp/db-org selects gp.added_at, and all 16
    -- real-PG cases below died on "column gp.added_at does not exist" while
    -- reporting nothing about the code they were meant to judge.
    CREATE TABLE harness_shared.goal_pots (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL, goal_id text NOT NULL,
      harness_slug text NOT NULL, role text NOT NULL DEFAULT 'owner',
      added_at timestamptz NOT NULL DEFAULT now(),
      added_by text,
      removed_at timestamptz,
      removed_by text,
      note text,
      kill_criterion text
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.agent_usage_samples (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL, ts bigint NOT NULL,
      source text NOT NULL,
      ingested_at bigint NOT NULL,
      harness_slug text, session_id text, goal_id text, cost_usd double precision
    )`);
  // Keep the fixture's access paths aligned with migrations 279 and 881. The
  // session spend query deliberately splits goal-attributed and legacy
  // session-attributed rows so these two indexes can be used independently.
  await rootSql.unsafe(`
    CREATE INDEX agent_usage_samples_ws_goal_ts_idx
      ON harness_shared.agent_usage_samples (workspace_id, goal_id, ts DESC)
      WHERE goal_id IS NOT NULL`);
  await rootSql.unsafe(`
    CREATE INDEX agent_usage_samples_ws_session_ts_idx
      ON harness_shared.agent_usage_samples (workspace_id, session_id, ts DESC)
      WHERE session_id IS NOT NULL`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.adv_sessions (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL DEFAULT 'default',
      coord_owner_id text, session_id text,
      started_at timestamptz NOT NULL DEFAULT now()
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.consult_state (
      workspace_id text NOT NULL,
      conversation_id text NOT NULL,
      requester_id text NOT NULL,
      routing jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.agent_modes (
      workspace_id text NOT NULL, owner_id text NOT NULL,
      axis_key text NOT NULL, mode text NOT NULL, subject text, set_by text,
      goal_lease_epoch bigint, goal_handoff_from_owner_id text,
      goal_handoff_expires_at timestamptz, set_at timestamptz NOT NULL DEFAULT now()
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.session_briefs (
      owner_id text PRIMARY KEY, workspace_id text NOT NULL, goal_id text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_presence (
      owner_id text PRIMARY KEY, heartbeat_at timestamptz, fleet_slug text,
      host text NOT NULL DEFAULT '', pid integer, source text NOT NULL DEFAULT ''
    )`);
  // goalHeadcount's pending_launches CTE counts leased goal reservations from
  // work_items (WI-10006337). Without this table the launch resolver degrades to
  // "ceiling not enforced — headcount failed", and the under-ceiling admission
  // cases below fail for a reason unrelated to spend. Same shape as
  // goal-headcount-census.integration.test.ts.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.work_items (
      feature_id text PRIMARY KEY, workspace_id text NOT NULL, payload jsonb NOT NULL
    )`);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  flagMock.getFlag.mockClear();
  flagMock.getFlag.mockResolvedValue(true);
  escalationMock.openEscalation.mockClear();
  await rootSql`TRUNCATE harness_shared.goals, harness_shared.goal_pots,
                harness_shared.agent_usage_samples, harness_shared.adv_sessions,
                harness_shared.agent_modes, harness_shared.session_briefs,
                harness_shared.consult_state, harness_shared.work_items`;
});

async function seedGoal(
  over: {
    id?: string;
    status?: string;
    metadata?: postgres.JSONValue;
    budgetCents?: number | null;
    /** P-004: the denominator for budgetCents. Null ⇒ per goal lifetime. */
    budgetWindowSec?: number | null;
  } = {},
) {
  await rootSql`INSERT INTO harness_shared.goals (id, workspace_id, status, metadata, budget_cents, budget_window_sec, created_at)
    VALUES (${over.id ?? GOAL}, ${WS}, ${over.status ?? 'active'},
            ${over.metadata ? rootSql.json(over.metadata) : null}, ${over.budgetCents ?? null},
            ${over.budgetWindowSec ?? null}, ${GOAL_CREATED})`;
}
async function pot(harness: string, goalId = GOAL) {
  // added_at is a HARD LOWER BOUND on the pot leg (goal-pots.ts: s.ts >=
  // GREATEST(since, g.created_at, gp.added_at)). Defaulting it to now() would
  // silently exclude every backdated sample these cases insert, so attach the
  // pot at the GOAL's creation.
  await rootSql`INSERT INTO harness_shared.goal_pots (workspace_id, goal_id, harness_slug, added_at)
    VALUES (${WS}, ${goalId}, ${harness},
            COALESCE((SELECT g.created_at FROM harness_shared.goals g
                       WHERE g.id = ${goalId} AND g.workspace_id = ${WS}), now()))`;
}
async function sample(o: {
  harness?: string;
  session?: string;
  goalId?: string;
  usd?: number | null;
  ts?: number;
  source?: string;
  ingestedAt?: number;
}) {
  const eventTs = o.ts ?? Date.now();
  await rootSql`INSERT INTO harness_shared.agent_usage_samples
    (workspace_id, ts, source, ingested_at, harness_slug, session_id, goal_id, cost_usd)
    VALUES (${WS}, ${eventTs}, ${o.source ?? 'interactive'}, ${o.ingestedAt ?? eventTs},
            ${o.harness ?? null}, ${o.session ?? null}, ${o.goalId ?? null}, ${o.usd === undefined ? 0 : o.usd})`;
}
async function ownedSession(owner: string, sessionId: string, startedAtMs = Date.now()) {
  await rootSql`INSERT INTO harness_shared.adv_sessions (coord_owner_id, session_id, started_at)
    VALUES (${owner}, ${sessionId}, ${new Date(startedAtMs)})`;
}
async function consult(
  conversationId: string,
  requester: string,
  answeringOwners: string[],
  createdAtMs: number,
) {
  await rootSql`INSERT INTO harness_shared.consult_state
    (workspace_id, conversation_id, requester_id, routing, created_at)
    VALUES (${WS}, ${conversationId}, ${requester},
            ${rootSql.json({ selection: { selected: answeringOwners.map((answeringOwnerId) => ({ answeringOwnerId })) } })},
            ${new Date(createdAtMs)})`;
}
async function subjectOwner(owner: string, goalId = GOAL) {
  await rootSql`INSERT INTO harness_shared.agent_modes (workspace_id, owner_id, axis_key, mode, subject, set_by)
    VALUES (${WS}, ${owner}, ${GOAL_MODE}, ${GOAL_MODE}, ${goalId}, 'test')`;
}
async function inheritedOwner(owner: string, goalId = GOAL) {
  await rootSql`INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, goal_id)
    VALUES (${owner}, ${WS}, ${goalId})`;
}
async function goalMetadata(goalId = GOAL): Promise<Record<string, any> | null> {
  const rows = await rootSql<Array<{ metadata: Record<string, any> | null }>>`
    SELECT metadata FROM harness_shared.goals WHERE id = ${goalId} AND workspace_id = ${WS}`;
  return rows[0]?.metadata ?? null;
}
async function goalStatus(goalId = GOAL): Promise<string | undefined> {
  const rows = await rootSql<Array<{ status: string }>>`
    SELECT status FROM harness_shared.goals WHERE id = ${goalId} AND workspace_id = ${WS}`;
  return rows[0]?.status;
}

/**
 * The canonical partition fixture: pot 150c + session 55c = diagnostic 205c,
 * with a deliberate double-count trap (a pot-harness sample that ALSO carries a
 * member session). The member sessions' samples carry the goal's id, as the
 * ledger stamps them at INSERT, so the authoritative lineage leg is 105c — of
 * which 50c sits inside the pot. Four different numbers, one per leg.
 */
async function seedPartitionFixture() {
  await seedGoal();
  await pot('hive-a');
  await subjectOwner('su-subject');
  await inheritedOwner('su-child');
  await ownedSession('su-subject', 'S1');
  await ownedSession('su-child', 'S2');
  await sample({ harness: 'hive-a', usd: 1.0 }); // pot leg, not attributed
  await sample({ harness: 'hive-a', session: 'S1', goalId: GOAL, usd: 0.5 }); // pot leg ONLY — the trap; lineage inside the pot
  await sample({ session: 'S1', goalId: GOAL, usd: 0.25 }); // session leg (no harness); lineage
  await sample({ harness: 'other-hive', session: 'S2', goalId: GOAL, usd: 0.3 }); // session leg (non-pot harness); lineage
  await sample({ session: 'S3-stranger', usd: 5.0 }); // nobody's
  await sample({ harness: 'hive-b', usd: 7.0 }); // non-pot harness, no session — nobody's
}

describe('goal spend rollup (P-005 / D-003 / D-011) — real PG', () => {
  describe('D-017: unmeasured spend is refused on real launch and per-turn paths', () => {
    it.each([
      { scenario: 'no-snapshot-refused', snapshot: false, usage: 'empty', admitted: false },
      { scenario: 'no-samples-refused', snapshot: true, usage: 'empty', admitted: false },
      { scenario: 'unpriced-refused', snapshot: true, usage: 'unpriced', admitted: false },
      { scenario: 'priced-under-budget-control', snapshot: true, usage: 'priced-zero', admitted: true },
    ] as const)('$scenario', async ({ snapshot, usage, admitted }) => {
      await seedGoal({ budgetCents: 2_000 });
      await subjectOwner('su-budget-test');
      if (usage === 'unpriced') await sample({ goalId: GOAL, usd: null });
      if (usage === 'priced-zero') await sample({ goalId: GOAL, usd: 0 });
      if (snapshot) {
        const sweep = await runGoalSpendRollupOnce(rootSql);
        expect(sweep).toMatchObject({ ok: true, written: 1, errors: [] });
        const metadata = await goalMetadata();
        expect(metadata?.spentCents).toBe(usage === 'priced-zero' ? 0 : null);
      } else {
        expect(await goalMetadata()).toBeNull();
      }

      const measured = await computeGoalSpendRollup(rootSql, { workspaceId: WS, goalId: GOAL });
      // Calibrate both dangerous wrong policies against the same real ledger.
      // The historical fail-open policy admits each null figure; an overstrict
      // policy refuses the observed priced-zero control. The repaired paths
      // below must give the opposite decisions for these exact fixtures.
      const failOpenOnNull = measured.spentCents == null || measured.spentCents < 2_000;
      const refuseEveryBudgetedGoal = false;
      expect(usage === 'priced-zero' ? refuseEveryBudgetedGoal : failOpenOnNull).toBe(!admitted);

      const launch = await resolveGoalLaunchForGoal({
        workspaceId: WS, goalId: GOAL, sql: rootSql, launcherOwnerId: 'su-budget-test',
      });
      const turn = await checkGoalInferenceAdmission({
        workspaceId: WS, ownerId: 'su-budget-test', sql: rootSql,
      });
      if (admitted) {
        expect(launch.refusal).toBeNull();
        expect(turn).toMatchObject({ allowed: true, reason: 'under-budget' });
      } else {
        expect(launch.refusal).toMatchObject({ reason: 'goal_budget_unmeasurable', current: null });
        expect(turn).toMatchObject({ allowed: false, code: 'goal_budget_unmeasurable', spentCents: null });
      }
    });
  });

  describe.each(['snapshot', 'launch-time'] as const)('measured launch admission through %s', (measurement) => {
    it.each([
      { spentCents: 2_000, scenario: 'at-ceiling-refused', refused: true },
      { spentCents: 1_999, scenario: 'under-ceiling-admitted', refused: false },
    ])('$scenario with real attributed spend', async ({ spentCents, refused }) => {
      await seedGoal({ budgetCents: 2_000 });
      await sample({ goalId: GOAL, usd: spentCents / 100 });
      if (measurement === 'snapshot') {
        await runGoalSpendRollupOnce(rootSql);
        const metadata = await goalMetadata();
        expect(metadata?.spentCents).toBe(spentCents);
        expect(metadata?.spentCentsSource).toBe(GOAL_SPEND_SNAPSHOT_SOURCE);
        expect(metadata?.spentCentsFreshness).toMatchObject({ status: 'fresh' });
      } else {
        expect(await goalMetadata()).toBeNull();
      }

      // Compose the real ledger reader/snapshot writer with the real launch
      // resolver. A rollup-only assertion cannot prove admission enforces it.
      // Opposite boundary policies are calibrated against this same fixture:
      // strict > would admit the ceiling, while <= would refuse 1 cent below it.
      const wrongRefused = refused ? spentCents > 2_000 : spentCents <= 2_000;
      expect(wrongRefused).toBe(!refused);
      const launch = await resolveGoalLaunchForGoal({
        workspaceId: WS, goalId: GOAL, sql: rootSql, launcherOwnerId: 'su-budget-test',
      });
      expect(launch.degradedReasons).toEqual([]);
      expect(launch.headcount.total).toBe(0);
      if (refused) {
        expect(launch.refusal).toMatchObject({
          reason: 'goal_budget_exceeded', limit: 2_000, current: 2_000,
        });
      } else {
        expect(launch.refusal).toBeNull();
        expect(launch.ceilings.maxAgents).toBeGreaterThan(0);
      }
    });
  });

  it('lineage is authoritative and cross-cuts an exact pot + session partition', async () => {
    await seedPartitionFixture();
    const r = await computeGoalSpendRollup(rootSql, { workspaceId: WS, goalId: GOAL });
    // Authoritative: only samples stamped with the goal's id.
    expect(r.spentCents).toBe(105);
    expect(r.unmeasuredReason).toBeNull();
    expect(r.lineageCents).toBe(105);
    expect(r.lineageInsidePotCents).toBe(50);
    expect(r.lineage.samples).toBe(3);
    // Diagnostic partition. The control values a broken partition produces:
    // 255 (no pot-harness exclusion), 150 (no session leg), 55 (no pot leg).
    // Only the correct partition reaches 205.
    expect(r.potCents).toBe(150);
    expect(r.sessionCents).toBe(55);
    expect(r.totalCents).toBe(205);
    expect(r.samples).toBe(4);
    expect(r.measured).toBe(true);
    expect(r.session.sessions).toBe(2);
  });

  it('bounds EVERY leg to the goal lifetime — pre-creation spend never bills', async () => {
    await seedPartitionFixture();
    await sample({ harness: 'hive-a', usd: 100, ts: GOAL_MS - 1000 }); // pot leg, too old
    await sample({ session: 'S1', usd: 100, ts: GOAL_MS - 1000 }); // session leg, too old
    await sample({ goalId: GOAL, usd: 100, ts: GOAL_MS - 1000 }); // lineage, too old
    const r = await computeGoalSpendRollup(rootSql, { workspaceId: WS, goalId: GOAL });
    expect(r.totalCents).toBe(205);
    expect(r.spentCents).toBe(105);
    // Execute the wrong no-lower-bound population against this same real ledger.
    // It includes the pre-creation 100-dollar sample; the repaired reader above
    // excludes that row from its authoritative 105-cent figure.
    const [unbounded] = await rootSql<Array<{ cents: number }>>`
      SELECT round(sum(cost_usd) * 100)::integer AS cents
        FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${WS} AND goal_id = ${GOAL}`;
    expect(unbounded?.cents).toBe(10_105);
  });

  it('a pot-less goal whose fleets spend under its goal id is MEASURED (the D-011 fix)', async () => {
    // Before D-011 the authoritative leg INNER JOINed goal_pots, so this goal
    // read spentCents=null forever and every holder launch was refused.
    await seedGoal();
    await sample({ harness: 'fleet-hive', session: 'S-fleet', goalId: GOAL, usd: 1.4 });
    const r = await computeGoalSpendRollup(rootSql, { workspaceId: WS, goalId: GOAL });
    expect(r).toMatchObject({ spentCents: 140, unmeasuredReason: null, potCents: 0, pot: { measured: false } });
  });

  it('an unpriced ATTRIBUTED sample leaves spentCents null with a named reason and a priced floor', async () => {
    await seedGoal();
    await sample({ goalId: GOAL, usd: 0.4 });
    await sample({ goalId: GOAL, usd: null }); // unpriced
    const r = await computeGoalSpendRollup(rootSql, { workspaceId: WS, goalId: GOAL });
    expect(r.spentCents).toBeNull();
    expect(r.unmeasuredReason).toBe('unpriced-lineage-samples');
    expect(r.lineageCents).toBe(40);
    expect(r.lineage.unpricedSamples).toBe(1);
  });

  it('an unpriced sample in a diagnostic leg is a diagnostic FLOOR only: measured=false, spentCents untouched', async () => {
    await seedGoal();
    await subjectOwner('su-subject');
    await ownedSession('su-subject', 'S1');
    await sample({ session: 'S1', goalId: GOAL, usd: 0.4 });
    await sample({ session: 'S1', usd: null }); // unpriced, never attributed
    const r = await computeGoalSpendRollup(rootSql, { workspaceId: WS, goalId: GOAL });
    expect(r.totalCents).toBe(40);
    expect(r.measured).toBe(false);
    expect(r.unpricedSamples).toBe(1);
    expect(r.spentCents).toBe(40);
  });

  it('windows every leg to the budget window, so an unpriced sample outside it cannot poison the figure', async () => {
    const NOW = GOAL_MS + 30 * 86_400_000;
    await seedGoal({ budgetWindowSec: 3_600 });
    await sample({ goalId: GOAL, usd: 5.0, ts: GOAL_MS + 60_000 }); // outside the window
    await sample({ goalId: GOAL, usd: null, ts: GOAL_MS + 60_000 }); // unpriced, outside the window
    await sample({ goalId: GOAL, usd: 0.5, ts: NOW - 60_000 }); // in-window
    const r = await computeGoalSpendRollup(rootSql, { workspaceId: WS, goalId: GOAL, windowSec: 3_600, nowMs: NOW });
    expect(r).toMatchObject({ spentCents: 50, unmeasuredReason: null, windowSec: 3_600 });
    // CONTROL: over the lifetime the same ledger is unmeasurable.
    const lifetime = await computeGoalSpendRollup(rootSql, { workspaceId: WS, goalId: GOAL, nowMs: NOW });
    expect(lifetime).toMatchObject({ spentCents: null, unmeasuredReason: 'unpriced-lineage-samples', lineageCents: 550 });
  });

  it('sessionSpendForGoal includes selected consult answer sessions opened by goal owners only', async () => {
    await seedGoal();
    await inheritedOwner('su-child');
    await ownedSession('su-child', 'S2');
    await ownedSession('su-unrelated', 'S9');
    await consult('consult-for-goal', 'su-child', ['consult-answerer', 'not-launched'], GOAL_MS + 20_000);
    await ownedSession('consult-answerer', 'S-consult', GOAL_MS + 30_000);
    await ownedSession('consult-answerer', 'S-before-consult', GOAL_MS + 10_000);
    await consult('consult-unrelated', 'su-unrelated', ['unrelated-answerer'], GOAL_MS + 20_000);
    await ownedSession('unrelated-answerer', 'S-unrelated-consult', GOAL_MS + 30_000);
    await sample({ session: 'S2', usd: 0.2 });
    await sample({ session: 'S9', usd: 9 });
    await sample({ session: 'S-consult', usd: 7.19 });
    await sample({ session: 'S-before-consult', usd: 5 });
    await sample({ session: 'S-unrelated-consult', usd: 6 });
    await sample({ session: 'S-not-launched', usd: 4 });
    const s = await sessionSpendForGoal(rootSql, { workspaceId: WS, goalId: GOAL });
    expect(s.costUsd).toBeCloseTo(7.39, 10);
    expect(s.samples).toBe(2);
    expect(s.sessions).toBe(2);
  });

  it('P-014(a): reads consult_state once per call, not once per usage sample', async () => {
    // Recurrence guard for the correlated-EXISTS regression: when the consult
    // answer-session leg was evaluated per sample, every unattributed sample
    // re-read consult_state (live: ~24.7 s and ~48M buffers per call). The
    // per-transaction counters are deterministic, so this asserts the SHAPE
    // (consult_state reads independent of sample count) without timing.
    await seedGoal();
    await inheritedOwner('su-child');
    for (let i = 0; i < 3; i += 1) {
      await consult(`consult-guard-${i}`, 'su-child', [`guard-answerer-${i}`], GOAL_MS + 20_000);
      await ownedSession(`guard-answerer-${i}`, `S-guard-answer-${i}`, GOAL_MS + 30_000);
      await sample({ session: `S-guard-answer-${i}`, usd: 1 });
    }
    await ownedSession('su-noise', 'S-noise', GOAL_MS + 30_000);
    const NOISE = 60;
    for (let i = 0; i < NOISE; i += 1) await sample({ session: 'S-noise', usd: 0.01 });

    const { spend, consultReads } = await rootSql.begin(async (tx) => {
      const spend = await sessionSpendForGoal(tx as unknown as typeof rootSql, { workspaceId: WS, goalId: GOAL });
      const [row] = await tx<{ reads: string }[]>`
        SELECT (COALESCE(seq_tup_read, 0) + COALESCE(idx_tup_fetch, 0))::text AS reads
          FROM pg_stat_xact_user_tables
         WHERE schemaname = 'harness_shared' AND relname = 'consult_state'`;
      return { spend, consultReads: Number(row?.reads ?? 0) };
    });
    // Semantics unchanged: exactly the three consult answer sessions count.
    expect(spend.costUsd).toBeCloseTo(3, 10);
    expect(spend.samples).toBe(3);
    // Shape: a per-sample correlated scan reads consult_state >= NOISE times.
    expect(consultReads).toBeGreaterThan(0);
    expect(consultReads).toBeLessThan(NOISE / 4);

    // CONTROL (keeps the guard falsifiable): the pre-P-014 correlated form of
    // the same consult predicate, on the same fixture, must trip the counter.
    const controlReads = await rootSql.begin(async (tx) => {
      await tx`
        SELECT count(*) FROM harness_shared.agent_usage_samples s
         WHERE s.workspace_id = ${WS} AND s.goal_id IS NULL
           AND EXISTS (
             SELECT 1 FROM harness_shared.consult_state cs
              CROSS JOIN LATERAL jsonb_array_elements(
                CASE WHEN jsonb_typeof(cs.routing #> '{selection,selected}') = 'array'
                     THEN cs.routing #> '{selection,selected}' ELSE '[]'::jsonb END) selected
              JOIN harness_shared.adv_sessions answer_session
                ON answer_session.workspace_id = cs.workspace_id
               AND answer_session.coord_owner_id = NULLIF(selected->>'answeringOwnerId', '')
               AND answer_session.session_id IS NOT NULL
               AND answer_session.started_at >= cs.created_at
             WHERE cs.workspace_id = ${WS}
               AND cs.requester_id = 'su-child'
               AND answer_session.session_id = s.session_id
               AND s.ts >= (EXTRACT(EPOCH FROM answer_session.started_at) * 1000)::bigint)`;
      const [row] = await tx<{ reads: string }[]>`
        SELECT (COALESCE(seq_tup_read, 0) + COALESCE(idx_tup_fetch, 0))::text AS reads
          FROM pg_stat_xact_user_tables
         WHERE schemaname = 'harness_shared' AND relname = 'consult_state'`;
      return Number(row?.reads ?? 0);
    });
    expect(controlReads).toBeGreaterThanOrEqual(NOISE);
  });

  it('P-014(b): splits usage reads across the goal and session indexes', async () => {
    await seedGoal();
    await inheritedOwner('su-child');
    await ownedSession('su-child', 'S-indexed');
    await sample({ goalId: GOAL, usd: 0.25 });
    await sample({ session: 'S-indexed', usd: 0.5 });

    const captured: Array<{ query: string; params: unknown[] }> = [];
    const client = postgres(rootUrl, {
      max: 1,
      onnotice: () => {},
      debug: (_connection, query, params) => {
        if (query.includes('agent_usage_samples')) captured.push({ query, params: [...params] });
      },
    });
    try {
      await sessionSpendForGoal(client as unknown as typeof rootSql, { workspaceId: WS, goalId: GOAL });
    } finally {
      await client.end({ timeout: 5 });
    }
    expect(captured).toHaveLength(1);

    await rootSql.unsafe('VACUUM (ANALYZE) harness_shared.agent_usage_samples');
    const rows = await rootSql.begin(async tx => {
      await tx.unsafe('SET LOCAL enable_seqscan = off');
      await tx.unsafe('SET LOCAL enable_bitmapscan = off');
      return tx.unsafe(`EXPLAIN (FORMAT JSON) ${captured[0]!.query}`, captured[0]!.params as never[]);
    });
    type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: PlanNode[] };
    const plan = (rows[0] as unknown as { 'QUERY PLAN': Array<{ Plan: PlanNode }> })['QUERY PLAN'][0]!.Plan;
    const usageScans: PlanNode[] = [];
    const visit = (node: PlanNode): void => {
      if (node['Relation Name'] === 'agent_usage_samples') usageScans.push(node);
      for (const child of node.Plans ?? []) visit(child);
    };
    visit(plan);
    expect(usageScans.map(scan => scan['Index Name'])).toEqual(expect.arrayContaining([
      'agent_usage_samples_ws_goal_ts_idx',
      'agent_usage_samples_ws_session_ts_idx',
    ]));
  });

  it('preserves write-time attribution after live session membership disappears', async () => {
    await seedGoal();
    await subjectOwner('su-subject');
    await ownedSession('su-subject', 'S-stable');
    await sample({ session: 'S-stable', goalId: GOAL, usd: 0.42 });

    const before = await sessionSpendForGoal(rootSql, { workspaceId: WS, goalId: GOAL });
    expect(before.costUsd).toBeCloseTo(0.42, 6);

    // The live membership is gone, but the sample's write-time goal_id is the
    // historical attribution that must keep the goal meter monotonic.
    await rootSql`DELETE FROM harness_shared.agent_modes WHERE workspace_id = ${WS} AND owner_id = 'su-subject'`;
    const after = await sessionSpendForGoal(rootSql, { workspaceId: WS, goalId: GOAL });
    expect(after.costUsd).toBeCloseTo(0.42, 6);
    expect(after.samples).toBe(1);
    expect((await computeGoalSpendRollup(rootSql, { workspaceId: WS, goalId: GOAL })).spentCents).toBe(42);
  });

  it('the sweep snapshots every ACTIVE goal, merges metadata, and skips inactive ones', async () => {
    await seedPartitionFixture(); // GOAL, active, with existing spend
    await seedGoal({ id: 'goal-done', status: 'achieved', metadata: { spentCents: 999 } });
    // Pre-existing unrelated metadata must survive the merge.
    await rootSql`UPDATE harness_shared.goals SET metadata = '{"killCriterion":"$5 spent"}'::jsonb
      WHERE id = ${GOAL} AND workspace_id = ${WS}`;
    const before = await rootSql<Array<{ updated_at: string }>>`
      SELECT updated_at FROM harness_shared.goals WHERE id = ${GOAL}`;

    const res = await runGoalSpendRollupOnce(rootSql);
    expect(res).toMatchObject({ ok: true, ran: true, checked: 1, written: 1, errors: [] });

    const md = await goalMetadata();
    expect(md?.spentCents).toBe(105);
    expect(md?.spentCentsSource).toBe(GOAL_SPEND_SNAPSHOT_SOURCE);
    expect(md?.spentCentsWindowSec).toBeNull();
    expect(md?.spentCentsUnmeasuredReason).toBeNull();
    expect(typeof md?.spentCentsAt).toBe('string');
    expect(md?.spentCentsBreakdown).toMatchObject({
      measured: true,
      lineageScope: LINEAGE_SCOPE,
      lineageCents: 105,
      lineageSamples: 3,
      lineageUnpricedSamples: 0,
      lineageInsidePotCents: 50,
      // The labels must survive the jsonb round-trip, not just exist in source:
      // potCents + sessionCents = diagnosticTotalCents below (150 + 55 = 205) is
      // exactly why they are ADDITIVE partitions rather than rival meters, and
      // the scopes are what say so to anyone reading the persisted row.
      potCents: 150,
      potSamples: 2,
      potUnpricedSamples: 0,
      potScope: 'inside-goal-pots:diagnostic-only',
      sessionScope: 'outside-goal-pots:diagnostic-only',
      sessionCents: 55,
      sessionSamples: 2,
      sessionUnpricedSamples: 0,
      sessionMeasured: true,
      sessionCount: 2,
      diagnosticTotalCents: 205,
      diagnosticSamples: 4,
      diagnosticUnpricedSamples: 0,
    });
    expect(md?.killCriterion).toBe('$5 spent'); // merge, not clobber

    // updated_at is the DEFINITION-edit time — a background rollup must not bump it.
    const after = await rootSql<Array<{ updated_at: string }>>`
      SELECT updated_at FROM harness_shared.goals WHERE id = ${GOAL}`;
    expect(String(after[0].updated_at)).toBe(String(before[0].updated_at));

    // The inactive goal was never touched.
    const doneMd = await goalMetadata('goal-done');
    expect(doneMd).toEqual({ spentCents: 999 });
  });

  it('the sweep judges each goal over its own budget window', async () => {
    await seedGoal({ budgetWindowSec: 3_600 });
    await sample({ goalId: GOAL, usd: 5.0, ts: GOAL_MS + 60_000 }); // long ago
    await sample({ goalId: GOAL, usd: 0.5, ts: Date.now() - 60_000 }); // in-window

    await runGoalSpendRollupOnce(rootSql);
    expect(await goalMetadata()).toMatchObject({ spentCents: 50, spentCentsWindowSec: 3_600 });
  });

  it('flag OFF → the sweep stands down before reading anything', async () => {
    await seedPartitionFixture();
    flagMock.getFlag.mockResolvedValue(false);
    const res = await runGoalSpendRollupOnce(rootSql);
    expect(res).toMatchObject({ ok: true, ran: false, checked: 0, written: 0 });
    expect(await goalMetadata()).toBeNull();
  });

  it('a goal with no attributed samples snapshots null instead of fabricating a measured zero', async () => {
    await seedGoal();
    await sample({ usd: 0, ts: Date.now(), ingestedAt: Date.now() }); // fresh workspace watermark, no goal attribution
    const res = await runGoalSpendRollupOnce(rootSql);
    expect(res.written).toBe(1);
    const md = await goalMetadata();
    expect(md?.spentCents).toBeNull();
    expect(md?.spentCentsUnmeasuredReason).toBe('no-lineage-samples');
    expect(md?.spentCentsFreshness).toMatchObject({ status: 'unavailable' });
    expect(md?.spentCentsBreakdown).toMatchObject({
      measured: false,
      lineageSamples: 0,
      potCents: 0,
      potSamples: 0,
      diagnosticSamples: 0,
    });
  });

  it('an attached but unused pot is still unmeasured', async () => {
    await seedGoal();
    await pot('hive-a');
    await sample({ usd: 0, ts: Date.now(), ingestedAt: Date.now() }); // fresh workspace watermark, no goal attribution

    const res = await runGoalSpendRollupOnce(rootSql);
    expect(res.written).toBe(1);
    expect(await goalMetadata()).toMatchObject({
      spentCents: null,
      spentCentsUnmeasuredReason: 'no-lineage-samples',
      spentCentsBreakdown: { potCents: 0, potSamples: 0, measured: false },
    });
  });

  it('diagnostic legs cannot promote unattributed spend into authoritative spend', async () => {
    await seedGoal();
    await pot('hive-a');
    await sample({ harness: 'hive-a', usd: 0.5 }); // pot leg, no goal id
    await subjectOwner('su-subject');
    await ownedSession('su-subject', 'S-diagnostic');
    await sample({ session: 'S-diagnostic', usd: 0.75 }); // membership-inferred, no goal id

    const res = await runGoalSpendRollupOnce(rootSql);
    expect(res.written).toBe(1);
    expect(await goalMetadata()).toMatchObject({
      spentCents: null,
      spentCentsUnmeasuredReason: 'no-lineage-samples',
      spentCentsBreakdown: {
        potCents: 50,
        sessionCents: 75,
        sessionSamples: 1,
        diagnosticTotalCents: 125,
      },
    });
  });

  it('an observed zero-cost attributed sample is a measured numeric zero', async () => {
    await seedGoal();
    await sample({ goalId: GOAL, usd: 0 });

    const res = await runGoalSpendRollupOnce(rootSql);
    expect(res.written).toBe(1);
    expect(await goalMetadata()).toMatchObject({
      spentCents: 0,
      spentCentsUnmeasuredReason: null,
      spentCentsBreakdown: { lineageSamples: 1, lineageUnpricedSamples: 0, measured: true },
    });
  });

  it('keeps diagnostic estimates diagnostic: they cannot overwrite the attributed figure or pause the goal', async () => {
    await seedGoal({ budgetCents: 200 });
    await sample({ goalId: GOAL, usd: 1.5 }); // authoritative = 150c
    await subjectOwner('su-subject');
    await ownedSession('su-subject', 'S-estimate');
    await sample({ session: 'S-estimate', usd: 10 }); // diagnostic estimate, no goal id
    await sample({ session: 'S-estimate', usd: null }); // makes only that estimate unmeasured
    await setTripwires([{ metric: 'spend_usd', label: 'spend', threshold: 2, unit: 'usd' }]);

    const res = await runGoalSpendRollupOnce(rootSql);
    expect(res).toMatchObject({ ok: true, written: 1, tripwiresAdvanced: 1, errors: [] });

    const md = await goalMetadata();
    expect(md).toMatchObject({
      spentCents: 150,
      spentCentsSource: GOAL_SPEND_SNAPSHOT_SOURCE,
      spentCentsBreakdown: {
        measured: true,
        lineageCents: 150,
        sessionCents: 1150,
        sessionUnpricedSamples: 1,
        sessionMeasured: false,
        diagnosticUnpricedSamples: 1,
      },
    });
    expect(await goalStatus()).toBe('active');
    expect((await goalTripwires())?.[0]?.current).toBe(1.5);
    expect(md?.autoPaused).toBeUndefined();
  });

  /* ── P-004: the measured number reaches the tripwire ─────────────────────── */

  async function goalTripwires(goalId = GOAL): Promise<Array<Record<string, any>> | null> {
    const rows = await rootSql<Array<{ tripwires: Array<Record<string, any>> | null }>>`
      SELECT tripwires FROM harness_shared.goals WHERE id = ${goalId} AND workspace_id = ${WS}`;
    return rows[0]?.tripwires ?? null;
  }
  async function setTripwires(tw: postgres.JSONValue, goalId = GOAL) {
    await rootSql`UPDATE harness_shared.goals SET tripwires = ${rootSql.json(tw)}
      WHERE id = ${goalId} AND workspace_id = ${WS}`;
  }

  it('P-004: the sweep advances a spend tripwire and leaves a domain metric alone', async () => {
    await seedPartitionFixture(); // lineage 105c, fully priced
    await setTripwires([
      { metric: 'spend_usd', label: 'Measured child-fleet spend', threshold: 50, unit: 'usd' },
      { metric: 'hours_since_verdict_advance', label: 'Domain', threshold: 48, unit: 'h' },
    ]);
    const before = await rootSql<Array<{ updated_at: string }>>`
      SELECT updated_at FROM harness_shared.goals WHERE id = ${GOAL}`;

    const res = await runGoalSpendRollupOnce(rootSql);
    expect(res).toMatchObject({ ok: true, tripwiresAdvanced: 1, errors: [] });

    const tw = await goalTripwires();
    // Only the authoritative lineage figure (105c) reaches the tripwire; the
    // pot (150c) and session (55c) legs cannot govern the goal.
    expect(tw?.find((t) => t.metric === 'spend_usd')?.current).toBe(1.05);
    // The domain metric only its executor can score is untouched — no invented value.
    expect(tw?.find((t) => t.metric === 'hours_since_verdict_advance')).toEqual({
      metric: 'hours_since_verdict_advance',
      label: 'Domain',
      threshold: 48,
      unit: 'h',
    });

    // Scoring a tripwire REPORTS a measurement; it does not edit the goal's intent.
    const after = await rootSql<Array<{ updated_at: string }>>`
      SELECT updated_at FROM harness_shared.goals WHERE id = ${GOAL}`;
    expect(String(after[0].updated_at)).toBe(String(before[0].updated_at));
  });

  it('WI-10004419: spend_usd_7d advances only when the goal budget window IS 7d', async () => {
    const WEEKLY = { metric: 'spend_usd_7d', label: 'Trailing-7d spend', threshold: 500, unit: 'usd', current: 34.91 };
    // Goal A: a 7d budget window — the rollup window matches the suffix.
    await seedGoal({ budgetWindowSec: 604_800 });
    // Goal B: a 24h budget window — a 7d metric must NOT be fed the 24h figure.
    await seedGoal({ id: 'goal-daily', budgetWindowSec: 86_400 });
    await sample({ goalId: GOAL, usd: 1.25 });
    await sample({ goalId: 'goal-daily', usd: 2.5 });
    await setTripwires([WEEKLY]);
    await setTripwires([WEEKLY], 'goal-daily');

    const res = await runGoalSpendRollupOnce(rootSql, { nowMs: GOAL_MS + 3_600_000 });
    expect(res).toMatchObject({ ok: true, errors: [] });

    const weekly = (await goalTripwires())?.[0];
    expect(weekly?.current).toBe(1.25);
    expect(weekly?.measuredBy).toMatchObject({ source: 'resolver:spend_usd_7d', value: 1.25 });
    // Window mismatch ⇒ unmeasured: the authored value is left exactly as it was.
    expect((await goalTripwires('goal-daily'))?.[0]).toEqual(WEEKLY);
  });

  it('P-004: an UNMEASURED (floor) rollup advances no spend tripwire and snapshots null', async () => {
    await seedGoal();
    await sample({ goalId: GOAL, usd: 1.0 });
    await sample({ goalId: GOAL, usd: null }); // unpriced => unmeasured
    await setTripwires([{ metric: 'spend_usd', label: 'spend', threshold: 50, unit: 'usd' }]);

    const res = await runGoalSpendRollupOnce(rootSql);
    expect(res.tripwiresAdvanced).toBe(0);

    // D-011 clause 3: a floor is not the goal's spend. The snapshot says it is
    // unmeasured and why; the floor rides in the breakdown, labelled.
    expect(await goalMetadata()).toMatchObject({
      spentCents: null,
      spentCentsUnmeasuredReason: 'unpriced-lineage-samples',
      spentCentsBreakdown: {
        measured: false,
        lineageCents: 100,
        lineageSamples: 2,
        lineageUnpricedSamples: 1,
      },
    });
    expect(await goalTripwires()).toEqual([{ metric: 'spend_usd', label: 'spend', threshold: 50, unit: 'usd' }]);
  });

  it('P-004: a goal with no tripwires is written once, not twice', async () => {
    await seedPartitionFixture();
    const res = await runGoalSpendRollupOnce(rootSql);
    expect(res).toMatchObject({ written: 1, tripwiresAdvanced: 0 });
    expect(await goalTripwires()).toBeNull();
  });

  /**
   * The ceiling's DENOMINATOR (work-on-everything-goal-2026-08-23 P-004).
   *
   * The breach check stops the goal, so the denominator is not a reporting
   * detail. With a window declared, lifetime spend is the WRONG number rather
   * than a stricter one: a standing goal (P-001) accrues forever, so judging it
   * against lifetime does not budget it — it schedules its stop for whenever
   * the running total happens to arrive.
   *
   * Both directions are asserted on purpose. The survive case alone would pass
   * against an implementation that simply stopped enforcing budgets on
   * windowed goals, which would be a worse bug than the one being fixed.
   */
  describe('P-004: a windowed ceiling is judged over the window, not the lifetime', () => {
    /** Old enough to sit outside the window, new enough to be after goal creation. */
    const OLD = GOAL_MS + 60_000;
    const RECENT = () => Date.now() - 60_000;

    it.each([50, 200])('display-admission-breach-parity: %i cents in the window, despite 500 older cents', async cents => {
      await seedGoal({ budgetCents: 200, budgetWindowSec: 3_600 });
      await sample({ goalId: GOAL, usd: 5.0, ts: OLD });
      await sample({ goalId: GOAL, usd: cents / 100, ts: RECENT() });

      // A lifetime-only reader would see the older 500 cents and falsely
      // refuse the under-window control. Measure that wrong population with
      // the real SQL instead of inventing a number in the assertion.
      const wrongLifetime = await computeGoalSpendRollup(rootSql, { workspaceId: WS, goalId: GOAL });
      expect(wrongLifetime.spentCents).toBe(500 + cents);
      if (cents < 200) expect(wrongLifetime.spentCents! >= 200).toBe(true);

      // No snapshot: compose the admission reader with the actual windowed SQL.
      const launch = await resolveGoalLaunchForGoal({
        workspaceId: WS, goalId: GOAL, sql: rootSql, launcherOwnerId: 'su-budget-test',
      });
      if (cents < 200) expect(launch.refusal).toBeNull();
      else expect(launch.refusal).toMatchObject({ reason: 'goal_budget_exceeded', current: cents, limit: 200 });

      const sweep = await runGoalSpendRollupOnce(rootSql);
      expect(sweep).toMatchObject({ ok: true, written: 1, errors: [] });
      const metadata = await goalMetadata();
      expect(metadata).toMatchObject({ spentCents: cents, spentCentsWindowSec: 3_600 });
      expect(await goalStatus()).toBe(cents < 200 ? 'active' : 'paused');
      if (cents < 200) {
        // The persisted display snapshot and the next admission use that figure.
        const snapshotLaunch = await resolveGoalLaunchForGoal({
          workspaceId: WS, goalId: GOAL, sql: rootSql, launcherOwnerId: 'su-budget-test',
        });
        expect(snapshotLaunch.refusal).toBeNull();
      } else {
        expect(metadata?.autoPaused).toMatchObject({ spentCents: cents, judgedWindowSec: 3_600 });
      }
    });

    it('SURVIVES: lifetime spend is over the ceiling but the trailing window is not', async () => {
      await seedGoal({ budgetCents: 200, budgetWindowSec: 3_600 });
      await sample({ goalId: GOAL, usd: 5.0, ts: OLD }); // 500c, long ago
      await sample({ goalId: GOAL, usd: 0.5, ts: RECENT() }); // 50c, in-window

      const res = await runGoalSpendRollupOnce(rootSql);
      expect(res).toMatchObject({ ok: true, errors: [] });
      // Lifetime is 550c against a 200c ceiling; the window holds 50c.
      // Pre-P-004 this goal is stopped here.
      expect(await goalStatus()).toBe('active');
    });

    it('STILL PAUSES: spend WITHIN the window reaches the ceiling', async () => {
      await seedGoal({ budgetCents: 200, budgetWindowSec: 3_600 });
      await sample({ goalId: GOAL, usd: 5.0, ts: OLD });
      await sample({ goalId: GOAL, usd: 2.0, ts: RECENT() }); // 200c in-window

      await runGoalSpendRollupOnce(rootSql);
      expect(await goalStatus()).toBe('paused');
      // The recorded reason must name the window, or a later reader cannot tell
      // which rule paused it.
      const meta = (await goalMetadata()) as { autoPaused?: { reasons?: string[]; judgedWindowSec?: number } };
      expect(meta.autoPaused?.reasons?.join(' ')).toContain('per 3600s window');
      expect(meta.autoPaused?.judgedWindowSec).toBe(3_600);
    });

    it('CONTROL: the same spend with NO window still pauses on lifetime — the rule is unchanged for ordinary goals', async () => {
      await seedGoal({ budgetCents: 200 });
      await sample({ goalId: GOAL, usd: 5.0, ts: OLD });
      await sample({ goalId: GOAL, usd: 0 });

      await runGoalSpendRollupOnce(rootSql);
      expect(await goalStatus()).toBe('paused');
    });
  });

  it('PAUSES (never kills) an active goal when measured spend reaches its declared budget, and tells the owner', async () => {
    await seedGoal({ budgetCents: 200, metadata: { holderRespawn: { attempts: [1, 2] } } });
    await sample({ goalId: GOAL, usd: 2.0 });
    // Keep the pre-transition value deterministic so this assertion proves the
    // pause writer stamps the lifecycle change rather than merely observing the
    // row's insert-time timestamp.
    await rootSql`UPDATE harness_shared.goals SET updated_at = ${GOAL_CREATED}
      WHERE id = ${GOAL} AND workspace_id = ${WS}`;
    const before = await rootSql<Array<{ updated_at: string }>>`
      SELECT updated_at FROM harness_shared.goals WHERE id = ${GOAL} AND workspace_id = ${WS}`;

    const res = await runGoalSpendRollupOnce(rootSql);
    expect(res).toMatchObject({ ok: true, written: 1, errors: [] });
    expect(await goalStatus()).toBe('paused');
    const after = await rootSql<Array<{ updated_at: string }>>`
      SELECT updated_at FROM harness_shared.goals WHERE id = ${GOAL} AND workspace_id = ${WS}`;
    expect(Date.parse(String(after[0]?.updated_at))).toBeGreaterThan(Date.parse(String(before[0]?.updated_at)));

    const md = await goalMetadata();
    expect(md).toMatchObject({
      autoPaused: {
        reason: 'measured-goal-breach',
        spentCents: 200,
        measured: true,
        spentCentsScope: LINEAGE_SCOPE,
        notJudged: { potScope: 'inside-goal-pots:diagnostic-only', sessionScope: 'outside-goal-pots:diagnostic-only' },
      },
      pause: { pausedBy: 'goal-spend-rollup' },
      // The respawner stays off a paused goal; existing respawn state survives.
      holderRespawn: { needsHuman: true, attempts: [1, 2] },
    });
    expect(typeof md?.holderRespawn?.needsHumanAtMs).toBe('number');
    // No escalatedAtMs: the liveness reconciler may clear the latch once the
    // owner resumes the goal.
    expect(md?.holderRespawn?.escalatedAtMs).toBeUndefined();
    expect(md?.autoKilled).toBeUndefined();

    await vi.waitFor(() => expect(escalationMock.openEscalation).toHaveBeenCalledTimes(1));
    const [, input] = escalationMock.openEscalation.mock.calls[0] as unknown as [unknown, Record<string, any>];
    expect(input.severity).toBe('blocker');
    expect(input.meta).toMatchObject({ dedupKind: 'goal-spend-breach-paused', subjectSignature: `${WS}:${GOAL}` });
  });

  it('pauses an active goal when an unmeasured spend floor already reaches its budget', async () => {
    await seedGoal({ budgetCents: 200 });
    await sample({ goalId: GOAL, usd: 2.0 });
    await sample({ goalId: GOAL, usd: null }); // the 200c total is a known floor

    const res = await runGoalSpendRollupOnce(rootSql);
    expect(res).toMatchObject({ ok: true, written: 1, errors: [] });
    expect(await goalStatus()).toBe('paused');
    expect(await goalMetadata()).toMatchObject({
      spentCents: null,
      autoPaused: {
        reason: 'spend-floor-goal-breach',
        spentCents: 200,
        measured: false,
      },
    });
    expect((await goalMetadata())?.autoPaused.reasons[0]).toContain('unpriced sample');
  });

  it('a paused goal is left alone by later sweeps (ACTIVE goals only)', async () => {
    await seedGoal({ budgetCents: 200 });
    await sample({ goalId: GOAL, usd: 2.0 });
    await runGoalSpendRollupOnce(rootSql);
    expect(await goalStatus()).toBe('paused');

    const res = await runGoalSpendRollupOnce(rootSql);
    expect(res).toMatchObject({ ok: true, checked: 0, written: 0 });
    expect(escalationMock.openEscalation).toHaveBeenCalledTimes(1);
  });

  it('pauses an active goal when a measured structured tripwire breaches', async () => {
    await seedPartitionFixture();
    await setTripwires([{ metric: 'spend_usd', label: 'spend', threshold: 1.0, unit: 'usd' }]);

    const res = await runGoalSpendRollupOnce(rootSql);
    expect(res).toMatchObject({ ok: true, written: 1, tripwiresAdvanced: 1, errors: [] });
    expect(await goalStatus()).toBe('paused');
  });

  it('still enforces an unchanged freshly confirmed measurement and preserves stopped goals', async () => {
    await seedPartitionFixture();
    await setTripwires([{
      metric: 'spend_usd', label: 'measured spend', threshold: 1.05, current: 1.05,
      measuredBy: { source: 'resolver:spend_usd', atMs: GOAL_MS, value: 1.05 },
    }]);
    await seedGoal({ id: 'historical-stopped-control', status: 'killed', metadata: { stopCause: 'preserve me' } });
    const before = await rootSql`
      SELECT * FROM harness_shared.goals WHERE id = 'historical-stopped-control' AND workspace_id = ${WS}`;

    const res = await runGoalSpendRollupOnce(rootSql);
    expect(res).toMatchObject({ ok: true, checked: 1, written: 1, tripwiresAdvanced: 0, errors: [] });
    expect(await goalStatus()).toBe('paused');
    expect(await goalMetadata()).toMatchObject({
      autoPaused: {
        reason: 'measured-goal-breach', spentCents: 105, measured: true,
        spentCentsScope: LINEAGE_SCOPE,
        reasons: [`spend_usd 1.05 reached threshold 1.05 [measured over ${LINEAGE_SCOPE}]`],
      },
    });
    const after = await rootSql`
      SELECT * FROM harness_shared.goals WHERE id = 'historical-stopped-control' AND workspace_id = ${WS}`;
    expect([...after]).toEqual([...before]);
  });

  it.each([
    { name: 'manually supplied', measuredBy: null },
    {
      name: 'previously measured but no longer measurable',
      measuredBy: { source: 'resolver:spend_usd', atMs: GOAL_MS, value: 999 },
    },
    {
      name: 'changed after its measurement',
      measuredBy: { source: 'resolver:spend_usd', atMs: GOAL_MS, value: 1 },
    },
    { name: 'attribution is unpriced', measuredBy: null, unpriced: true },
    { name: 'attribution predates goal lifetime', measuredBy: null, stale: true },
  ])('does not auto-pause from $name spend current without authoritative samples', async (scenario) => {
    await seedGoal({ budgetCents: 100_000 });
    await ownedSession('su-diagnostic', 'S-diagnostic-only');
    await subjectOwner('su-diagnostic');
    await sample({ session: 'S-diagnostic-only', usd: 999 }); // diagnostic, no goal id
    if ('unpriced' in scenario || 'stale' in scenario) {
      await pot('hive-unmeasured');
      await sample({
        harness: 'hive-unmeasured',
        goalId: GOAL,
        usd: 'unpriced' in scenario ? null : 999,
        ts: 'stale' in scenario ? GOAL_MS - 1 : GOAL_MS + 60_000,
      });
    }
    await setTripwires([
      { metric: 'spend_usd', label: 'diagnostic estimate', threshold: 100, current: 999, measuredBy: scenario.measuredBy },
    ]);
    expect(await computeGoalSpendRollup(rootSql, { workspaceId: WS, goalId: GOAL })).toMatchObject({
      spentCents: null, lineageCents: 0, potCents: 0, sessionCents: 99_900, pot: { measured: false },
    });

    const res = await runGoalSpendRollupOnce(rootSql);
    expect(res).toMatchObject({ ok: true, written: 1, tripwiresAdvanced: 0, errors: [] });
    expect(await goalStatus()).toBe('active');
    expect((await goalMetadata())?.autoPaused).toBeUndefined();
  });

  it('does not auto-pause from an executor-owned domain tripwire the platform did not measure', async () => {
    await seedGoal({ budgetCents: 100_000 });
    await setTripwires([
      {
        metric: 'openReleaseWalls',
        label: 'Signed release walls still open',
        threshold: 0,
        current: 2,
        unit: 'walls',
      },
    ]);

    const res = await runGoalSpendRollupOnce(rootSql);
    expect(res).toMatchObject({ ok: true, written: 1, tripwiresAdvanced: 0, errors: [] });
    expect(await goalStatus()).toBe('active');
    expect((await goalMetadata())?.autoPaused).toBeUndefined();
  });

  it('does not reinterpret a legitimate external metric as a platform stop measurement', async () => {
    await seedGoal();
    await setTripwires([{
      metric: 'openReleaseWalls', label: 'external census', threshold: 0, current: 2,
      evidence: { kind: 'work-item-count', ref: 'signed-release-walls' },
      measuredBy: { source: 'evidence:work-item-count:signed-release-walls', atMs: GOAL_MS, value: 2 },
    }]);
    const before = await rootSql`
      SELECT tripwires FROM harness_shared.goals WHERE id = ${GOAL} AND workspace_id = ${WS}`;
    expect(await runGoalSpendRollupOnce(rootSql)).toMatchObject({ ok: true, errors: [], tripwiresAdvanced: 0 });
    const after = await rootSql<Array<{ status: string; tripwires: postgres.JSONValue }>>`
      SELECT status, tripwires FROM harness_shared.goals WHERE id = ${GOAL} AND workspace_id = ${WS}`;
    expect(after[0]?.status).toBe('active');
    expect(after[0]?.tripwires).toEqual(before[0]?.tripwires);
    expect((await goalMetadata())?.autoPaused).toBeUndefined();
  });

  it('leaves over-15-minute event-to-ingest lag unmeasured and skips tripwire and breach controls', async () => {
    await seedGoal({ budgetCents: 100 });
    const authoredTripwire = { metric: 'spend_usd', label: 'freshness guard', threshold: 1, current: 0 };
    await setTripwires([authoredTripwire]);
    const nowMs = Date.now();
    await sample({
      goalId: GOAL,
      usd: 2,
      ts: nowMs - 20 * 60_000,
      ingestedAt: nowMs,
      source: 'interactive',
    });

    const result = await runGoalSpendRollupOnce(rootSql);
    expect(result).toMatchObject({ ok: true, written: 1, tripwiresAdvanced: 0, errors: [] });
    expect(await goalStatus()).toBe('active');
    expect(await goalTripwires()).toEqual([authoredTripwire]);
    expect(await goalMetadata()).toMatchObject({
      spentCents: null,
      spentCentsUnmeasuredReason: 'interactive-usage-stale',
      spentCentsFreshness: {
        status: 'stale',
        maxRecentIngestLagMs: 20 * 60_000,
      },
    });
  });

  it('does not let another goal’s fresh interactive samples mask this goal’s stale ingest lag', async () => {
    await seedGoal({ id: GOAL, budgetCents: 1_000 });
    await seedGoal({ id: OTHER_GOAL, budgetCents: 1_000 });
    const nowMs = Date.now();
    await sample({
      goalId: GOAL,
      usd: 2,
      ts: nowMs - 20 * 60_000,
      ingestedAt: nowMs,
      source: 'interactive',
    });
    await sample({ goalId: OTHER_GOAL, usd: 5, ts: nowMs, ingestedAt: nowMs, source: 'interactive' });

    const result = await runGoalSpendRollupOnce(rootSql, { nowMs });
    expect(result).toMatchObject({ ok: true, written: 2, errors: [] });
    expect(await goalMetadata(GOAL)).toMatchObject({
      spentCents: null,
      spentCentsUnmeasuredReason: 'interactive-usage-stale',
      spentCentsFreshness: { status: 'stale' },
    });
    expect(await goalMetadata(OTHER_GOAL)).toMatchObject({
      spentCents: 500,
      spentCentsUnmeasuredReason: null,
      spentCentsFreshness: { status: 'fresh' },
    });
  });
});
