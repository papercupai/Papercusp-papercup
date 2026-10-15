/**
 * agent-fleets-store.integration.test.ts — the fleet:launch-on-plan idempotency
 * guard (P-005 / migration 484), against a real Postgres (testcontainer).
 *
 * Proves the CROSS-WORKER semantics the in-process Map could not provide (the
 * 2026-07-03 ornith incident: a leader re-fired launch-on-plan 7× in 40s, each
 * call landed on a different :3070 worker with an empty map, and 6 waves / 12
 * unwanted terminals opened):
 *   - exactly ONE concurrent claim wins the window, even under a parallel race;
 *   - a claim inside the window is suppressed WITH the prior launch's at/count;
 *   - the window elapsing re-opens the slot;
 *   - releaseFleetLaunchSlot (all-spawns-failed path) clears ONLY its own claim,
 *     never a newer one.
 *
 * Mirrors autoloop-state.integration.test.ts's per-test-database setup; the
 * store fns take an explicit `sql` so no module mocking is needed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  claimFleetLaunchSlot,
  clearFleetLeaderMissingSince,
  createFleetIfAbsent,
  deleteFleet,
  getFleet,
  getFleetHeadcountTarget,
  claimFleetHeadcountAttempt,
  lapseFleetTopUpRule,
  listExpiredFleetTopUpRules,
  listFleetHeadcountTargets,
  recordFleetHeadcountAttempt,
  releaseFleetLaunchSlot,
  markFleetLeaderMissingSince,
  promoteFleetLeaderIfMissing,
  setFleetLeader,
  setFleetHeadcountTarget,
  setFleetControlState,
  setFleetLaunchTransaction,
  updateFleetMeta,
} from './agent-fleets-store';
import { latestFleetMembership } from './fleet-membership-store';
import { fleetSlugOfAgent } from './fleet-transition-events';
import type { FleetTopUpRule } from './fleet/top-up-rule';

const WS = 'ws-flguard';
const WINDOW = 60_000;
const LEADER_MISSING_MIGRATION = readFileSync(
  new URL('../../../libs/papercusp/libs/db/sql/1348-fleet-leader-missing-since.sql', import.meta.url),
  'utf8',
);
const LEADER_MISSING_GRACE_MS = 10 * 60_000;

let rootSql: postgres.Sql;
let db: FreshPgDb;

async function insertFleet(slug: string): Promise<void> {
  await rootSql.unsafe(
    `INSERT INTO harness_shared.agent_fleets (workspace_id, fleet_slug, created_at, updated_at)
     VALUES ($1, $2, $3, $3)`,
    [WS, slug, Date.now()],
  );
}

beforeAll(async () => {
  // EI-11788: use the shared Papercusp fixture, which retries transient PG
  // connects and drops only this throwaway database. The former bespoke
  // CREATE DATABASE path could wait behind concurrent green-checkpoint work
  // until Vitest's 90s suite timeout, losing the actual test verdict.
  db = await createFreshPgDb('fleet-headcount-store');
  rootSql = db.sql;
  // max > 1 (the helper's max=4) keeps the concurrency test genuine.
  // The agent_fleets shape: 417 baseline + the 484 launch-guard columns + the
  // 575 control-state columns (P-009 / H4) + the 964 fleet_type column (D-008 /
  // P-010). Migration 1348 is applied below to this pre-migration table. This
  // fixture hand-rolls the table, so it does NOT inherit other new
  // migrations — a column added to the real table has to be added here too or
  // every store call that names it fails with a bare "column does not exist".
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.agent_fleets (
      workspace_id      text NOT NULL,
      fleet_slug        text NOT NULL,
      title             text,
      description       text,
      owner             text,
      leader_owner_id   text,
      color_scheme      text,
      fleet_type        text DEFAULT 'single' NOT NULL,
      control_state     text DEFAULT 'active' NOT NULL,
      control_reason    text,
      control_by        text,
      control_at        bigint,
      control_resume_gate text,
      control_expires_at bigint,
      control_no_resume_path boolean NOT NULL DEFAULT false,
      created_at        bigint NOT NULL,
      updated_at        bigint DEFAULT 0 NOT NULL,
      last_launch_at    bigint,
      last_launch_count integer,
      headcount_target integer,
      headcount_config jsonb,
      headcount_next_attempt_at bigint,
      headcount_backoff_ms bigint DEFAULT 0 NOT NULL,
      headcount_last_error text,
      last_launch_transaction jsonb,
      CONSTRAINT agent_fleets_headcount_target_positive
        CHECK (headcount_target IS NULL OR headcount_target BETWEEN 1 AND 64),
      CONSTRAINT agent_fleets_pkey PRIMARY KEY (workspace_id, fleet_slug)
    )
  `);
  await rootSql.unsafe(
    `INSERT INTO harness_shared.agent_fleets (workspace_id, fleet_slug, leader_owner_id, created_at, updated_at)
     VALUES ($1, 'leader-missing-legacy', 'legacy-leader', $2, $2)`,
    [WS, Date.now()],
  );
  await rootSql.unsafe(LEADER_MISSING_MIGRATION);
  // Minimal canonical append-only membership ledger for deleteFleet's teardown
  // test. The production projection trigger/view is not needed here: the test
  // exercises the latest-fact writer directly, which is the source those
  // projections read.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.fleet_membership_events (
      id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL DEFAULT 'default',
      owner_id     text NOT NULL,
      owner_label  text,
      fleet_slug   text,
      fleet_role   text,
      event        text NOT NULL DEFAULT 'join',
      at           timestamptz NOT NULL DEFAULT now()
    )
  `);
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('leader-missing timestamp and succession (migration 1348)', () => {
  it('adds a nullable bigint and preserves existing fleets with no absence episode', async () => {
    const columns = await rootSql.unsafe(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'harness_shared' AND table_name = 'agent_fleets'
          AND column_name = 'leader_missing_since_ms'`,
    ) as unknown as Array<{ data_type: string; is_nullable: string }>;
    expect(columns).toEqual([{ data_type: 'bigint', is_nullable: 'YES' }]);
    expect((await getFleet(WS, 'leader-missing-legacy', rootSql))?.leaderMissingSinceMs).toBeNull();
  });

  it('starts once, clears with a matching snapshot, then atomically promotes after the grace', async () => {
    const { record } = await createFleetIfAbsent(
      { workspaceId: WS, fleetSlug: 'leader-missing-cas', leaderOwnerId: 'leader-a' },
      rootSql,
    );
    expect(record.leaderMissingSinceMs).toBeNull();

    const firstSeenAt = Math.max(Date.now(), record.updatedAt + 1);
    const marked = await markFleetLeaderMissingSince({
      workspaceId: WS,
      fleetSlug: 'leader-missing-cas',
      expectedLeaderOwnerId: 'leader-a',
      expectedUpdatedAtMs: record.updatedAt,
      observedAtMs: firstSeenAt,
    }, rootSql);
    expect(marked?.leaderMissingSinceMs).toBe(firstSeenAt);

    // A later complete absence observation cannot restart the grace clock.
    const duplicateMark = await markFleetLeaderMissingSince({
      workspaceId: WS,
      fleetSlug: 'leader-missing-cas',
      expectedLeaderOwnerId: 'leader-a',
      expectedUpdatedAtMs: marked!.updatedAt,
      observedAtMs: firstSeenAt + 5_000,
    }, rootSql);
    expect(duplicateMark).toBeNull();
    expect((await getFleet(WS, 'leader-missing-cas', rootSql))?.leaderMissingSinceMs).toBe(firstSeenAt);

    const staleClear = await clearFleetLeaderMissingSince({
      workspaceId: WS,
      fleetSlug: 'leader-missing-cas',
      expectedLeaderOwnerId: 'leader-a',
      expectedLeaderMissingSinceMs: firstSeenAt,
      expectedUpdatedAtMs: marked!.updatedAt - 1,
      observedAtMs: marked!.updatedAt + 1,
    }, rootSql);
    expect(staleClear).toBeNull();
    const cleared = await clearFleetLeaderMissingSince({
      workspaceId: WS,
      fleetSlug: 'leader-missing-cas',
      expectedLeaderOwnerId: 'leader-a',
      expectedLeaderMissingSinceMs: firstSeenAt,
      expectedUpdatedAtMs: marked!.updatedAt,
      observedAtMs: marked!.updatedAt + 1,
    }, rootSql);
    expect(cleared?.leaderMissingSinceMs).toBeNull();

    const nextFirstSeen = cleared!.updatedAt + 1;
    const remapped = await markFleetLeaderMissingSince({
      workspaceId: WS,
      fleetSlug: 'leader-missing-cas',
      expectedLeaderOwnerId: 'leader-a',
      expectedUpdatedAtMs: cleared!.updatedAt,
      observedAtMs: nextFirstSeen,
    }, rootSql);
    expect(remapped?.leaderMissingSinceMs).toBe(nextFirstSeen);

    const promotion = {
      workspaceId: WS,
      fleetSlug: 'leader-missing-cas',
      expectedLeaderOwnerId: 'leader-a',
      expectedLeaderMissingSinceMs: nextFirstSeen,
      expectedUpdatedAtMs: remapped!.updatedAt,
      replacementLeaderOwnerId: 'successor-b',
      graceMs: LEADER_MISSING_GRACE_MS,
    };
    await expect(promoteFleetLeaderIfMissing({
      ...promotion,
      nowMs: nextFirstSeen + LEADER_MISSING_GRACE_MS - 1,
    }, rootSql)).resolves.toBeNull();

    // A registry mutation after the roster snapshot invalidates promotion even
    // when the leader id and absence clock themselves have not changed.
    await rootSql.unsafe(
      `UPDATE harness_shared.agent_fleets
          SET updated_at = updated_at + 1
        WHERE workspace_id = $1 AND fleet_slug = $2`,
      [WS, 'leader-missing-cas'],
    );
    await expect(promoteFleetLeaderIfMissing({
      ...promotion,
      nowMs: nextFirstSeen + LEADER_MISSING_GRACE_MS,
    }, rootSql)).resolves.toBeNull();
    const currentVersion = (await getFleet(WS, 'leader-missing-cas', rootSql))!.updatedAt;

    const results = await Promise.all([
      promoteFleetLeaderIfMissing({ ...promotion, expectedUpdatedAtMs: currentVersion, nowMs: nextFirstSeen + LEADER_MISSING_GRACE_MS }, rootSql),
      promoteFleetLeaderIfMissing({ ...promotion, expectedUpdatedAtMs: currentVersion, nowMs: nextFirstSeen + LEADER_MISSING_GRACE_MS }, rootSql),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)).toMatchObject({
      leaderOwnerId: 'successor-b',
      leaderMissingSinceMs: null,
    });
    expect(await getFleet(WS, 'leader-missing-cas', rootSql)).toMatchObject({
      leaderOwnerId: 'successor-b',
      leaderMissingSinceMs: null,
    });
  });

  it('manual leader changes clear a previously observed absence clock', async () => {
    const { record } = await createFleetIfAbsent(
      { workspaceId: WS, fleetSlug: 'leader-missing-manual', leaderOwnerId: 'leader-old' },
      rootSql,
    );
    const marked = await markFleetLeaderMissingSince({
      workspaceId: WS,
      fleetSlug: 'leader-missing-manual',
      expectedLeaderOwnerId: 'leader-old',
      expectedUpdatedAtMs: record.updatedAt,
      observedAtMs: Math.max(Date.now(), record.updatedAt + 1),
    }, rootSql);
    expect(marked?.leaderMissingSinceMs).not.toBeNull();
    const changed = await setFleetLeader(WS, 'leader-missing-manual', 'leader-new', rootSql, 'leader-old');
    expect(changed).toMatchObject({ leaderOwnerId: 'leader-new', leaderMissingSinceMs: null });
  });
});

describe('deleteFleet membership retirement', () => {
  it('appends leave facts for current members but preserves membership history', async () => {
    const slug = 'deleted-drain-fleet';
    await insertFleet(slug);
    const membership = async (
      ownerId: string,
      fleetSlug: string | null,
      fleetRole: string | null,
      event: string,
    ) => rootSql.unsafe(
      `INSERT INTO harness_shared.fleet_membership_events
         (workspace_id, owner_id, owner_label, fleet_slug, fleet_role, event)
       VALUES ($1, $2, $2, $3, $4, $5)`,
      [WS, ownerId, fleetSlug, fleetRole, event],
    );

    await membership('leader-live', slug, 'leader', 'lead');
    await membership('member-live', slug, 'member', 'join');
    await membership('member-left', slug, 'member', 'join');
    await membership('member-left', null, null, 'leave');
    await membership('member-moved', slug, 'member', 'join');
    await membership('member-moved', 'other-fleet', 'member', 'join');

    await expect(deleteFleet(WS, slug, rootSql)).resolves.toBe(true);

    const latest = await rootSql.unsafe(
      `SELECT DISTINCT ON (owner_id) owner_id, fleet_slug, event
         FROM harness_shared.fleet_membership_events
        WHERE workspace_id = $1
        ORDER BY owner_id, id DESC`,
      [WS],
    ) as unknown as Array<{ owner_id: string; fleet_slug: string | null; event: string }>;
    expect(Object.fromEntries(latest.map((row) => [row.owner_id, [row.fleet_slug, row.event]]))).toEqual({
      'leader-live': [null, 'leave'],
      'member-live': [null, 'leave'],
      'member-left': [null, 'leave'],
      'member-moved': ['other-fleet', 'join'],
    });

    const history = await rootSql.unsafe(
      `SELECT DISTINCT owner_id
         FROM harness_shared.fleet_membership_events
        WHERE workspace_id = $1 AND fleet_slug = $2
        ORDER BY owner_id`,
      [WS, slug],
    ) as unknown as Array<{ owner_id: string }>;
    expect(history.map((row) => row.owner_id)).toEqual([
      'leader-live',
      'member-left',
      'member-live',
      'member-moved',
    ]);
    await expect(getFleet(WS, slug, rootSql)).resolves.toBeNull();
    await expect(latestFleetMembership(WS, 'member-live', rootSql)).resolves.toEqual({
      fleetSlug: null,
      fleetRole: null,
    });
    await expect(fleetSlugOfAgent(WS, 'member-live', {
      fleetOfAgent: async (workspaceId, ownerId) =>
        (await latestFleetMembership(workspaceId, ownerId, rootSql))?.fleetSlug ?? null,
    })).resolves.toBeNull();
    await expect(deleteFleet(WS, slug, rootSql)).resolves.toBe(false);
  });
});

/**
 * fleet_type round-trip (directed-pair-work-items-2026-08-25 D-008 / P-010,
 * migration 964) — the half asFleetType's unit tests cannot reach: that the
 * value actually SURVIVES a write and comes back typed, and that the default
 * holds for every caller who never heard of the column.
 */
describe('fleet type (D-008 / P-010)', () => {
  it('defaults to single for a caller that does not pass a type', async () => {
    const { record, created } = await createFleetIfAbsent(
      { workspaceId: WS, fleetSlug: 'type-default' },
      rootSql,
    );
    expect(created).toBe(true);
    expect(record.fleetType).toBe('single');
    // …and it is durable, not just a default applied in the mapper.
    expect((await getFleet(WS, 'type-default', rootSql))?.fleetType).toBe('single');
  });

  it('persists paired and reads it back through getFleet', async () => {
    const { record } = await createFleetIfAbsent(
      { workspaceId: WS, fleetSlug: 'type-paired', fleetType: 'paired' },
      rootSql,
    );
    expect(record.fleetType).toBe('paired');
    expect((await getFleet(WS, 'type-paired', rootSql))?.fleetType).toBe('paired');
  });

  it('reads a legacy row (column defaulted, never written) as single', async () => {
    // insertFleet names no fleet_type — the pre-964 caller shape.
    await insertFleet('type-legacy');
    expect((await getFleet(WS, 'type-legacy', rootSql))?.fleetType).toBe('single');
  });

  it('does NOT re-type an existing fleet (createFleetIfAbsent is idempotent)', async () => {
    await createFleetIfAbsent({ workspaceId: WS, fleetSlug: 'type-sticky' }, rootSql);
    const second = await createFleetIfAbsent(
      { workspaceId: WS, fleetSlug: 'type-sticky', fleetType: 'paired' },
      rootSql,
    );
    expect(second.created).toBe(false);
    // The caller asked for paired and did not get it — which is exactly why
    // fleet:create reports typeRequestIgnored rather than staying silent.
    expect(second.record.fleetType).toBe('single');
  });

  it('updateFleetMeta re-types an existing fleet, and leaves the type alone when omitted', async () => {
    await createFleetIfAbsent(
      { workspaceId: WS, fleetSlug: 'type-update', title: 'before' },
      rootSql,
    );
    const retyped = await updateFleetMeta(WS, 'type-update', { fleetType: 'paired' }, rootSql);
    expect(retyped?.fleetType).toBe('paired');

    // A metadata-only edit must not silently reset the type to the default —
    // the COALESCE guard. Without it this edit would read back 'single'.
    const renamed = await updateFleetMeta(WS, 'type-update', { title: 'after' }, rootSql);
    expect(renamed?.title).toBe('after');
    expect(renamed?.fleetType).toBe('paired');
  });
});

describe('claimFleetLaunchSlot (P-005 cross-worker idempotency)', () => {
  it('first claim wins; a re-claim inside the window is suppressed with the prior at/count', async () => {
    await insertFleet('window-fleet');
    const t0 = 1_000_000;
    const first = await claimFleetLaunchSlot({
      workspaceId: WS, fleetSlug: 'window-fleet', count: 2, windowMs: WINDOW, now: t0, sql: rootSql,
    });
    expect(first).toEqual({ won: true, at: t0 });
    // The 2026-07-03 shape: a re-fire 40s later must NOT open another wave.
    const refire = await claimFleetLaunchSlot({
      workspaceId: WS, fleetSlug: 'window-fleet', count: 2, windowMs: WINDOW, now: t0 + 40_000, sql: rootSql,
    });
    expect(refire).toEqual({ won: false, priorAt: t0, priorCount: 2 });
  });

  it('atomically advances a higher target inside the window while suppressing duplicate scale-up calls (EI-13483)', async () => {
    await insertFleet('canary-scale-up');
    const t0 = 1_500_000;
    const canary = await claimFleetLaunchSlot({
      workspaceId: WS,
      fleetSlug: 'canary-scale-up',
      count: 1,
      windowMs: WINDOW,
      allowCountIncreaseWithinWindow: true,
      now: t0,
      sql: rootSql,
    });
    expect(canary).toEqual({ won: true, at: t0 });

    const scaleUp = await claimFleetLaunchSlot({
      workspaceId: WS,
      fleetSlug: 'canary-scale-up',
      count: 11,
      windowMs: WINDOW,
      allowCountIncreaseWithinWindow: true,
      now: t0 + 40_000,
      sql: rootSql,
    });
    expect(scaleUp).toEqual({ won: true, at: t0 + 40_000 });

    const duplicate = await claimFleetLaunchSlot({
      workspaceId: WS,
      fleetSlug: 'canary-scale-up',
      count: 11,
      windowMs: WINDOW,
      allowCountIncreaseWithinWindow: true,
      now: t0 + 40_001,
      sql: rootSql,
    });
    expect(duplicate).toEqual({ won: false, priorAt: t0 + 40_000, priorCount: 11 });
  });

  it('admits exactly one concurrent caller for the same higher in-window target (EI-13483)', async () => {
    await insertFleet('canary-scale-race');
    const t0 = 1_750_000;
    await claimFleetLaunchSlot({
      workspaceId: WS,
      fleetSlug: 'canary-scale-race',
      count: 1,
      windowMs: WINDOW,
      now: t0,
      sql: rootSql,
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        claimFleetLaunchSlot({
          workspaceId: WS,
          fleetSlug: 'canary-scale-race',
          count: 11,
          windowMs: WINDOW,
          allowCountIncreaseWithinWindow: true,
          now: t0 + 40_000 + i,
          sql: rootSql,
        }),
      ),
    );
    expect(results.filter((result) => result.won)).toHaveLength(1);
  });

  it('the window elapsing re-opens the slot (a genuine second wave)', async () => {
    await insertFleet('second-wave');
    const t0 = 2_000_000;
    await claimFleetLaunchSlot({
      workspaceId: WS, fleetSlug: 'second-wave', count: 3, windowMs: WINDOW, now: t0, sql: rootSql,
    });
    const wave2 = await claimFleetLaunchSlot({
      workspaceId: WS, fleetSlug: 'second-wave', count: 3, windowMs: WINDOW, now: t0 + WINDOW + 1, sql: rootSql,
    });
    expect(wave2).toEqual({ won: true, at: t0 + WINDOW + 1 });
  });

  it('exactly ONE of N concurrent claims wins (the multi-worker race)', async () => {
    await insertFleet('race-fleet');
    const t0 = 3_000_000;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        claimFleetLaunchSlot({
          workspaceId: WS, fleetSlug: 'race-fleet', count: 2, windowMs: WINDOW, now: t0 + i, sql: rootSql,
        }),
      ),
    );
    expect(results.filter((r) => r.won)).toHaveLength(1);
  });

  it('fails OPEN (won, unrecorded) when the fleet row does not exist', async () => {
    const r = await claimFleetLaunchSlot({
      workspaceId: WS, fleetSlug: 'no-such-fleet', count: 1, windowMs: WINDOW, now: 5_000, sql: rootSql,
    });
    expect(r.won).toBe(true);
  });
});

describe('fleet control state (P-009 / mig 575) — typed wind-down round-trip', () => {
  it('a new fleet is born active; wind-down persists state+reason+by+ts; resume clears back', async () => {
    const { record } = await createFleetIfAbsent(
      { workspaceId: WS, fleetSlug: 'ctl-fleet', leaderOwnerId: 'su-lead' },
      rootSql,
    );
    expect(record.controlState).toBe('active');
    expect(record.controlReason).toBeNull();

    const wound = await setFleetControlState(
      WS, 'ctl-fleet',
      { state: 'winding-down', reason: 'release cut', by: 'su-lead' },
      rootSql,
    );
    expect(wound).toMatchObject({
      controlState: 'winding-down',
      controlReason: 'release cut',
      controlBy: 'su-lead',
    });
    expect(wound?.controlAt).toBeGreaterThan(0);

    // The read path every consumer (orient fold, fleet:status) uses.
    const read = await getFleet(WS, 'ctl-fleet', rootSql);
    expect(read?.controlState).toBe('winding-down');

    const resumed = await setFleetControlState(
      WS, 'ctl-fleet',
      { state: 'active', reason: 'incident cleared', by: 'su-lead' },
      rootSql,
    );
    expect(resumed?.controlState).toBe('active');
    expect(resumed?.controlReason).toBe('incident cleared');
  });

  it('a missing fleet returns null (no phantom control rows)', async () => {
    expect(
      await setFleetControlState(WS, 'no-such', { state: 'winding-down' }, rootSql),
    ).toBeNull();
  });

  it('a stale reconcile snapshot cannot overwrite a newer resume', async () => {
    await createFleetIfAbsent(
      { workspaceId: WS, fleetSlug: 'cas-fleet', leaderOwnerId: 'su-lead' },
      rootSql,
    );
    // Make the snapshot unambiguously older than the resume write, even if both calls
    // happen within one millisecond in a fast test process.
    await rootSql.unsafe(
      `UPDATE harness_shared.agent_fleets SET updated_at = $3 WHERE workspace_id = $1 AND fleet_slug = $2`,
      [WS, 'cas-fleet', 1_000_000],
    );
    const snapshot = await getFleet(WS, 'cas-fleet', rootSql);
    expect(snapshot?.updatedAt).toBe(1_000_000);

    const resumed = await setFleetControlState(
      WS,
      'cas-fleet',
      { state: 'active', reason: 'newer resume', by: 'su-lead' },
      rootSql,
    );
    expect(resumed?.updatedAt).toBeGreaterThan(snapshot!.updatedAt);

    const staleWindDown = await setFleetControlState(
      WS,
      'cas-fleet',
      { state: 'winding-down', reason: 'stale reconcile', by: 'system:fleet-control-reconcile' },
      rootSql,
      undefined,
      { state: 'active', updatedAtMs: snapshot!.updatedAt },
    );
    expect(staleWindDown).toBeNull();
    expect((await getFleet(WS, 'cas-fleet', rootSql))?.controlState).toBe('active');
  });

  it('a forged control_state reads back as active (defensive rowToRecord)', async () => {
    await insertFleet('forged-ctl');
    await rootSql.unsafe(
      `UPDATE harness_shared.agent_fleets SET control_state = 'god-mode' WHERE workspace_id = $1 AND fleet_slug = $2`,
      [WS, 'forged-ctl'],
    );
    const read = await getFleet(WS, 'forged-ctl', rootSql);
    expect(read?.controlState).toBe('active');
  });
});

describe('fleet launch transaction state (P-003 / mig 830)', () => {
  it('persists and reads the exact partial-recovery transaction on the fleet row', async () => {
    await insertFleet('transaction-fleet');
    const transaction = {
      version: 1 as const,
      transactionId: 'tx-1',
      state: 'partial' as const,
      requestedAt: 1_000,
      updatedAt: 2_000,
      requestedMemberIds: ['su-a', 'su-b'],
      openedMemberIds: ['su-a'],
      verifiedMemberIds: ['su-a'],
      failed: [{ ownerId: 'su-b', phase: 'spawn' as const, reason: 'no window' }],
      waves: [{ index: 0, ownerIds: ['su-a'], state: 'verified' as const }],
      recovery: { retryOwnerIds: ['su-b'], nextAction: 'retry only the unresolved member identity' },
    };
    await setFleetLaunchTransaction({ workspaceId: WS, fleetSlug: 'transaction-fleet', transaction, sql: rootSql });
    expect((await getFleet(WS, 'transaction-fleet', rootSql))?.lastLaunchTransaction).toEqual(transaction);
  });

  it('refuses stale same-transaction and superseded-transaction writers', async () => {
    await insertFleet('transaction-cas-fleet');
    const initial = {
      version: 1 as const,
      transactionId: 'tx-initial',
      state: 'partial' as const,
      requestedAt: 1_000,
      updatedAt: 2_000,
      requestedMemberIds: ['su-a'],
      openedMemberIds: ['su-a'],
      verifiedMemberIds: [],
      failed: [],
      waves: [{ index: 0, ownerIds: ['su-a'], state: 'partial' as const }],
      recovery: { retryOwnerIds: ['su-a'], nextAction: 'observe' },
    };
    expect(await setFleetLaunchTransaction({
      workspaceId: WS, fleetSlug: 'transaction-cas-fleet', transaction: initial, sql: rootSql,
    })).toBe(true);
    const storedRevision = await rootSql.unsafe<[{ json_type: string; transaction_id: string; updated_at: string; matches: boolean }]>(
      `SELECT jsonb_typeof(last_launch_transaction) AS json_type,
              last_launch_transaction->>'transactionId' AS transaction_id,
              last_launch_transaction->>'updatedAt' AS updated_at,
              last_launch_transaction @> jsonb_build_object(
                'transactionId', $3::text,
                'updatedAt', $4::bigint
              ) AS matches
         FROM harness_shared.agent_fleets
        WHERE workspace_id = $1 AND fleet_slug = $2`,
      [WS, 'transaction-cas-fleet', initial.transactionId, initial.updatedAt],
    );
    expect(storedRevision[0]).toEqual({
      json_type: 'object',
      transaction_id: initial.transactionId,
      updated_at: String(initial.updatedAt),
      matches: true,
    });
    // Backward compatibility: the old `$n::jsonb` unsafe-parameter spelling let
    // postgres-js encode a JSON string as a JSONB string. The reader historically
    // accepted that shape, so the CAS must normalize it while new writes use the
    // canonical `$n::text::jsonb` spelling and remain objects.
    await rootSql.unsafe(
      `UPDATE harness_shared.agent_fleets
          SET last_launch_transaction = to_jsonb($3::text)
        WHERE workspace_id = $1 AND fleet_slug = $2`,
      [WS, 'transaction-cas-fleet', JSON.stringify(initial)],
    );

    const refreshed = { ...initial, updatedAt: 3_000, recovery: { retryOwnerIds: [], nextAction: 'ready' } };
    expect(await setFleetLaunchTransaction({
      workspaceId: WS,
      fleetSlug: 'transaction-cas-fleet',
      transaction: refreshed,
      expectedRevision: { transactionId: initial.transactionId, updatedAt: initial.updatedAt },
      sql: rootSql,
    })).toBe(true);
    expect(await setFleetLaunchTransaction({
      workspaceId: WS,
      fleetSlug: 'transaction-cas-fleet',
      transaction: { ...initial, updatedAt: 4_000 },
      expectedRevision: { transactionId: initial.transactionId, updatedAt: initial.updatedAt },
      sql: rootSql,
    })).toBe(false);

    const replacement = {
      ...refreshed,
      transactionId: 'tx-replacement',
      previousTransactionId: refreshed.transactionId,
      updatedAt: 5_000,
    };
    expect(await setFleetLaunchTransaction({
      workspaceId: WS,
      fleetSlug: 'transaction-cas-fleet',
      transaction: replacement,
      expectedRevision: { transactionId: refreshed.transactionId, updatedAt: refreshed.updatedAt },
      sql: rootSql,
    })).toBe(true);
    expect(await setFleetLaunchTransaction({
      workspaceId: WS,
      fleetSlug: 'transaction-cas-fleet',
      transaction: { ...refreshed, updatedAt: 6_000 },
      expectedRevision: { transactionId: refreshed.transactionId, updatedAt: refreshed.updatedAt },
      sql: rootSql,
    })).toBe(false);
    expect((await getFleet(WS, 'transaction-cas-fleet', rootSql))?.lastLaunchTransaction)
      .toEqual(replacement);
  });
});

describe('releaseFleetLaunchSlot (all-spawns-failed retry path)', () => {
  it('clears its own claim so an immediate retry wins', async () => {
    await insertFleet('failed-launch');
    const t0 = 4_000_000;
    const claim = await claimFleetLaunchSlot({
      workspaceId: WS, fleetSlug: 'failed-launch', count: 2, windowMs: WINDOW, now: t0, sql: rootSql,
    });
    expect(claim.won).toBe(true);
    await releaseFleetLaunchSlot({ workspaceId: WS, fleetSlug: 'failed-launch', at: t0, sql: rootSql });
    const retry = await claimFleetLaunchSlot({
      workspaceId: WS, fleetSlug: 'failed-launch', count: 2, windowMs: WINDOW, now: t0 + 5_000, sql: rootSql,
    });
    expect(retry).toEqual({ won: true, at: t0 + 5_000 });
  });

  it('never clears a NEWER claim (stale release is a no-op)', async () => {
    await insertFleet('stale-release');
    const t0 = 5_000_000;
    await claimFleetLaunchSlot({
      workspaceId: WS, fleetSlug: 'stale-release', count: 1, windowMs: WINDOW, now: t0, sql: rootSql,
    });
    // A stale release from an OLDER claim timestamp must not clear the live one.
    await releaseFleetLaunchSlot({ workspaceId: WS, fleetSlug: 'stale-release', at: t0 - 999, sql: rootSql });
    const refire = await claimFleetLaunchSlot({
      workspaceId: WS, fleetSlug: 'stale-release', count: 1, windowMs: WINDOW, now: t0 + 1_000, sql: rootSql,
    });
    expect(refire.won).toBe(false);
  });
});

describe('fleet headcount target (WI-2479)', () => {
  const config = {
    plan: 'drain', harness: 'papercusp', agent: 'codex' as const,
    model: 'gpt-5.6-luna', effort: 'max', account: 'default', headless: true,
    carry: 'warm' as const, contextSize: 'trimmed' as const, compactionLimit: 825_000,
    role: 'su', brief: 'drain bugs',
  };

  it('persists a target recipe and grants only one concurrent retry lease', async () => {
    await insertFleet('headcount-fleet');
    await setFleetHeadcountTarget({ workspaceId: WS, fleetSlug: 'headcount-fleet', target: 30, config, sql: rootSql });
    expect(await listFleetHeadcountTargets(WS, rootSql)).toMatchObject([{ fleetSlug: 'headcount-fleet', target: 30, config }]);
    const first = await claimFleetHeadcountAttempt({ workspaceId: WS, fleetSlug: 'headcount-fleet', now: 8_000_000, sql: rootSql });
    expect(first).toMatchObject({ fleetSlug: 'headcount-fleet', target: 30, claimedAt: 8_000_000 });
    expect(await claimFleetHeadcountAttempt({ workspaceId: WS, fleetSlug: 'headcount-fleet', now: 8_000_001, sql: rootSql })).toBeNull();
  });

  it('normalizes a legacy full value before persisting the launch recipe', async () => {
    await insertFleet('headcount-legacy-context');
    await setFleetHeadcountTarget({
      workspaceId: WS,
      fleetSlug: 'headcount-legacy-context',
      target: 1,
      config: { ...config, contextSize: 'full' } as unknown as typeof config,
      sql: rootSql,
    });
    expect(await getFleetHeadcountTarget(WS, 'headcount-legacy-context', rootSql)).toMatchObject({
      config: { contextSize: 'trimmed' },
    });
  });

  it('normalizes an already-stored historical full recipe on read and marks the deprecation', async () => {
    const fleetSlug = 'headcount-stored-legacy-context';
    await insertFleet(fleetSlug);
    await rootSql.unsafe(
      `UPDATE harness_shared.agent_fleets
          SET headcount_target = $3, headcount_config = $4::jsonb
        WHERE workspace_id = $1 AND fleet_slug = $2`,
      [WS, fleetSlug, 1, JSON.stringify({ ...config, contextSize: 'full' })],
    );

    expect(await getFleetHeadcountTarget(WS, fleetSlug, rootSql)).toMatchObject({
      config: { contextSize: 'trimmed' },
      normalizedLegacyContextSize: true,
    });
    const [stored] = await rootSql.unsafe<{ headcount_config: typeof config | string }[]>(
      `SELECT headcount_config
         FROM harness_shared.agent_fleets
        WHERE workspace_id = $1 AND fleet_slug = $2`,
      [WS, fleetSlug],
    );
    const storedConfig = typeof stored?.headcount_config === 'string'
      ? JSON.parse(stored.headcount_config)
      : stored?.headcount_config;
    expect(storedConfig).toMatchObject({ contextSize: 'full' });
  });

  it('resets on success and doubles a failed retry delay with a cap', async () => {
    await insertFleet('headcount-backoff');
    await setFleetHeadcountTarget({ workspaceId: WS, fleetSlug: 'headcount-backoff', target: 2, config, sql: rootSql });
    const readBackoffTarget = async () =>
      (await listFleetHeadcountTargets(WS, rootSql)).find((target) => target.fleetSlug === 'headcount-backoff');
    await claimFleetHeadcountAttempt({ workspaceId: WS, fleetSlug: 'headcount-backoff', now: 9_000_000, sql: rootSql });
    await recordFleetHeadcountAttempt({ workspaceId: WS, fleetSlug: 'headcount-backoff', succeeded: false, error: 'spawn failed', now: 9_100_000, sql: rootSql });
    expect(await readBackoffTarget()).toMatchObject({ backoffMs: 60_000, lastError: 'spawn failed' });
    await claimFleetHeadcountAttempt({ workspaceId: WS, fleetSlug: 'headcount-backoff', now: 9_200_000, sql: rootSql });
    await recordFleetHeadcountAttempt({ workspaceId: WS, fleetSlug: 'headcount-backoff', succeeded: false, error: 'spawn failed again', now: 9_300_000, sql: rootSql });
    expect(await readBackoffTarget()).toMatchObject({ backoffMs: 120_000, lastError: 'spawn failed again' });
    await recordFleetHeadcountAttempt({ workspaceId: WS, fleetSlug: 'headcount-backoff', succeeded: true, now: 9_500_000, sql: rootSql });
    expect(await readBackoffTarget()).toMatchObject({ backoffMs: 0, nextAttemptAt: null, lastError: null });
  });

  it('disables automatic top-up without erasing the canonical launch recipe', async () => {
    await insertFleet('headcount-disabled-profile');
    await setFleetHeadcountTarget({
      workspaceId: WS, fleetSlug: 'headcount-disabled-profile', target: 5, config, sql: rootSql,
    });
    await setFleetHeadcountTarget({
      workspaceId: WS, fleetSlug: 'headcount-disabled-profile', target: null, sql: rootSql,
    });

    expect(await listFleetHeadcountTargets(WS, rootSql)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ fleetSlug: 'headcount-disabled-profile' })]),
    );
    expect(await claimFleetHeadcountAttempt({
      workspaceId: WS, fleetSlug: 'headcount-disabled-profile', now: 10_000_000, sql: rootSql,
    })).toBeNull();
    expect(await getFleetHeadcountTarget(WS, 'headcount-disabled-profile', rootSql)).toMatchObject({
      fleetSlug: 'headcount-disabled-profile', enabled: false, target: 1, config,
    });
    const [row] = await rootSql.unsafe<{
      headcount_target: number | null;
      headcount_config: typeof config | string;
    }[]>(
      `SELECT headcount_target, headcount_config
         FROM harness_shared.agent_fleets
        WHERE workspace_id = $1 AND fleet_slug = $2`,
      [WS, 'headcount-disabled-profile'],
    );
    expect(row?.headcount_target).toBeNull();
    expect(typeof row?.headcount_config === 'string' ? JSON.parse(row.headcount_config) : row?.headcount_config)
      .toMatchObject(config);
  });

  // WI-1454201. A wound-down fleet kept being topped up forever: fleet:wind-down
  // left headcount_target armed AND the governor's selection had no control_state
  // predicate, so `capless-inference-gateway-ship-2026-08-28` relaunched a DESKTOP
  // member 20 times over 23h onto a plan that had already shipped. Both halves are
  // asserted here, independently, because either one alone leaves the trap
  // re-armable — and each block carries an ACTIVE positive control so a predicate
  // that refused everything (or an instrument that returned nothing) could not pass.
  describe('winding-down disarms the headcount governor (WI-1454201)', () => {
    it('wind-down clears the target, preserves the recipe, and does not re-arm on resume', async () => {
      await insertFleet('headcount-wind-down');
      await insertFleet('headcount-wind-down-control');
      await setFleetHeadcountTarget({ workspaceId: WS, fleetSlug: 'headcount-wind-down', target: 4, config, sql: rootSql });
      await setFleetHeadcountTarget({ workspaceId: WS, fleetSlug: 'headcount-wind-down-control', target: 4, config, sql: rootSql });

      // Calibration: both are armed and claimable BEFORE the wind-down, so a later
      // refusal is attributable to control_state and not to a fleet that never armed.
      const armed = await listFleetHeadcountTargets(WS, rootSql);
      expect(armed).toEqual(expect.arrayContaining([
        expect.objectContaining({ fleetSlug: 'headcount-wind-down', target: 4 }),
        expect.objectContaining({ fleetSlug: 'headcount-wind-down-control', target: 4 }),
      ]));

      const wound = await setFleetControlState(
        WS, 'headcount-wind-down', { state: 'winding-down', reason: 'plan shipped', by: 'su-test' }, rootSql,
      );
      expect(wound?.controlState).toBe('winding-down');

      // The governor can neither see it nor open a member for it...
      expect(await listFleetHeadcountTargets(WS, rootSql)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ fleetSlug: 'headcount-wind-down' })]),
      );
      expect(await claimFleetHeadcountAttempt({
        workspaceId: WS, fleetSlug: 'headcount-wind-down', now: 11_000_000, sql: rootSql,
      })).toBeNull();

      // ...while the untouched sibling still is, so the predicate discriminates.
      expect(await listFleetHeadcountTargets(WS, rootSql)).toEqual(
        expect.arrayContaining([expect.objectContaining({ fleetSlug: 'headcount-wind-down-control', target: 4 })]),
      );
      expect(await claimFleetHeadcountAttempt({
        workspaceId: WS, fleetSlug: 'headcount-wind-down-control', now: 11_000_000, sql: rootSql,
      })).toMatchObject({ fleetSlug: 'headcount-wind-down-control', target: 4 });

      // The launch recipe survives for a later takeover/respawn/explicit re-arm.
      expect(await getFleetHeadcountTarget(WS, 'headcount-wind-down', rootSql)).toMatchObject({
        enabled: false, config,
      });

      // Resuming does NOT silently re-arm top-up — re-arming is an explicit call.
      const resumed = await setFleetControlState(WS, 'headcount-wind-down', { state: 'active' }, rootSql);
      expect(resumed?.controlState).toBe('active');
      expect(await listFleetHeadcountTargets(WS, rootSql)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ fleetSlug: 'headcount-wind-down' })]),
      );
    });

    it('refuses a legacy row wound down with its target still armed', async () => {
      // The exact production shape: control_state='winding-down' with a live
      // headcount_target, as written by a build whose wind-down did not clear it.
      // The selection predicate is what has to catch this, not the writer.
      await insertFleet('headcount-legacy-wound');
      await insertFleet('headcount-legacy-active');
      await setFleetHeadcountTarget({ workspaceId: WS, fleetSlug: 'headcount-legacy-wound', target: 1, config, sql: rootSql });
      await setFleetHeadcountTarget({ workspaceId: WS, fleetSlug: 'headcount-legacy-active', target: 1, config, sql: rootSql });
      await rootSql.unsafe(
        `UPDATE harness_shared.agent_fleets
            SET control_state = 'winding-down'
          WHERE workspace_id = $1 AND fleet_slug = $2`,
        [WS, 'headcount-legacy-wound'],
      );

      const [row] = await rootSql.unsafe<{ headcount_target: number | null; control_state: string }[]>(
        `SELECT headcount_target, control_state
           FROM harness_shared.agent_fleets
          WHERE workspace_id = $1 AND fleet_slug = $2`,
        [WS, 'headcount-legacy-wound'],
      );
      expect(row).toMatchObject({ headcount_target: 1, control_state: 'winding-down' });

      expect(await listFleetHeadcountTargets(WS, rootSql)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ fleetSlug: 'headcount-legacy-wound' })]),
      );
      expect(await claimFleetHeadcountAttempt({
        workspaceId: WS, fleetSlug: 'headcount-legacy-wound', now: 12_000_000, sql: rootSql,
      })).toBeNull();

      expect(await listFleetHeadcountTargets(WS, rootSql)).toEqual(
        expect.arrayContaining([expect.objectContaining({ fleetSlug: 'headcount-legacy-active', target: 1 })]),
      );
      expect(await claimFleetHeadcountAttempt({
        workspaceId: WS, fleetSlug: 'headcount-legacy-active', now: 12_000_000, sql: rootSql,
      })).toMatchObject({ fleetSlug: 'headcount-legacy-active', target: 1 });
    });
  });
});

// P-005 / D-030. An unheld fleet is held off by a visible, attributed rule that
// EXPIRES. These tests exercise the SQL halves the unit suites mock out: the
// rule riding the preserved recipe, the expired-rule listing, and the lapse
// compare-and-set. Each exclusion has a positive control beside it, so a
// predicate that refused everything could not pass.
describe('fleet no-top-up rule (P-005 / D-030)', () => {
  const config = {
    plan: 'drain', harness: 'papercusp', agent: 'codex' as const,
    model: 'gpt-5.6-luna', effort: 'max', account: 'default', headless: true,
    carry: 'warm' as const, contextSize: 'trimmed' as const, compactionLimit: 825_000,
    role: 'su', brief: 'drain bugs',
  };
  const rule = (over: Partial<FleetTopUpRule> = {}): FleetTopUpRule => ({
    kind: 'target-disabled',
    ratifiedBy: 'su-leader',
    ratifiedAt: 1_000,
    reason: 'plan paused for review',
    until: 5_000,
    suspendedTarget: 3,
    suspendedSupervise: true,
    ...over,
  });

  async function insertFleetIn(workspaceId: string, slug: string): Promise<void> {
    await rootSql.unsafe(
      `INSERT INTO harness_shared.agent_fleets (workspace_id, fleet_slug, created_at, updated_at)
       VALUES ($1, $2, $3, $3)`,
      [workspaceId, slug, Date.now()],
    );
  }

  async function readRow(slug: string, workspaceId = WS): Promise<{
    target: number | null;
    config: (Record<string, unknown> & { topUpRule?: unknown; supervise?: unknown }) | null;
  }> {
    const [row] = await rootSql.unsafe<{ headcount_target: number | null; headcount_config: unknown }[]>(
      `SELECT headcount_target, headcount_config
         FROM harness_shared.agent_fleets
        WHERE workspace_id = $1 AND fleet_slug = $2`,
      [workspaceId, slug],
    );
    const raw = row?.headcount_config;
    return {
      target: row?.headcount_target ?? null,
      config: (typeof raw === 'string' ? JSON.parse(raw) : raw) as never,
    };
  }

  it('a disable merges the rule into the preserved recipe; a disable without one strips it', async () => {
    await insertFleet('topup-merge');
    await setFleetHeadcountTarget({
      workspaceId: WS, fleetSlug: 'topup-merge', target: 3, config: { ...config, supervise: true }, sql: rootSql,
    });
    await setFleetHeadcountTarget({
      workspaceId: WS, fleetSlug: 'topup-merge', target: null, topUpRule: rule(), sql: rootSql,
    });
    const ruled = await readRow('topup-merge');
    expect(ruled.target).toBeNull();
    expect(ruled.config).toMatchObject({ ...config, supervise: true, topUpRule: rule() });

    await setFleetHeadcountTarget({ workspaceId: WS, fleetSlug: 'topup-merge', target: null, sql: rootSql });
    const stripped = await readRow('topup-merge');
    expect(stripped.target).toBeNull();
    expect(stripped.config).toMatchObject({ ...config, supervise: true });
    expect(stripped.config).not.toHaveProperty('topUpRule');
  });

  it('a row with no recipe stays NULL even when a rule is offered', async () => {
    await insertFleet('topup-no-recipe');
    await setFleetHeadcountTarget({
      workspaceId: WS, fleetSlug: 'topup-no-recipe', target: null, topUpRule: rule(), sql: rootSql,
    });
    expect(await readRow('topup-no-recipe')).toEqual({ target: null, config: null });
  });

  // The readers tolerate a jsonb STRING recipe (`typeof === 'string' ? JSON.parse`),
  // which hid that this fixture's typed-parameter client stored one: the stored
  // SHAPE is asserted directly, because readRow's parse would mask a regression.
  it('every writer stores an object recipe, and a non-object recipe is left untouched', async () => {
    const storedType = async (slug: string): Promise<string | null> => {
      const [row] = await rootSql.unsafe<{ t: string | null }[]>(
        `SELECT jsonb_typeof(headcount_config) AS t FROM harness_shared.agent_fleets
          WHERE workspace_id = $1 AND fleet_slug = $2`,
        [WS, slug],
      );
      return row?.t ?? null;
    };
    await insertFleet('topup-shape');
    await setFleetHeadcountTarget({ workspaceId: WS, fleetSlug: 'topup-shape', target: 2, config, sql: rootSql });
    expect(await storedType('topup-shape')).toBe('object');
    await setFleetHeadcountTarget({
      workspaceId: WS, fleetSlug: 'topup-shape', target: 2, config, topUpRule: rule(), sql: rootSql,
    });
    expect(await storedType('topup-shape')).toBe('object');
    await setFleetHeadcountTarget({
      workspaceId: WS, fleetSlug: 'topup-shape', target: null, topUpRule: rule({ until: 9_000 }), sql: rootSql,
    });
    expect(await storedType('topup-shape')).toBe('object');
    await setFleetHeadcountTarget({ workspaceId: WS, fleetSlug: 'topup-shape', target: null, sql: rootSql });
    expect(await storedType('topup-shape')).toBe('object');

    await insertFleet('topup-scalar');
    await rootSql.unsafe(
      `UPDATE harness_shared.agent_fleets SET headcount_config = to_jsonb('legacy'::text)
        WHERE workspace_id = $1 AND fleet_slug = $2`,
      [WS, 'topup-scalar'],
    );
    await setFleetHeadcountTarget({ workspaceId: WS, fleetSlug: 'topup-scalar', target: null, sql: rootSql });
    await setFleetHeadcountTarget({
      workspaceId: WS, fleetSlug: 'topup-scalar', target: null, topUpRule: rule(), sql: rootSql,
    });
    expect(await storedType('topup-scalar')).toBe('string');
    const [scalar] = await rootSql.unsafe<{ v: string | null }[]>(
      `SELECT headcount_config #>> '{}' AS v FROM harness_shared.agent_fleets
        WHERE workspace_id = $1 AND fleet_slug = $2`,
      [WS, 'topup-scalar'],
    );
    expect(scalar?.v).toBe('legacy');
  });

  it('a non-null write strips a stale stored rule unless the write ratifies one', async () => {
    await insertFleet('topup-rearm');
    // A recipe read back from the row still carries its old rule; re-arming with
    // it must not resurrect that rule.
    const staleRecipe = { ...config, supervise: true, topUpRule: rule() };
    await setFleetHeadcountTarget({
      workspaceId: WS, fleetSlug: 'topup-rearm', target: 4, config: staleRecipe, sql: rootSql,
    });
    const rearmed = await readRow('topup-rearm');
    expect(rearmed.target).toBe(4);
    expect(rearmed.config).toMatchObject({ ...config, supervise: true });
    expect(rearmed.config).not.toHaveProperty('topUpRule');

    const revoke = rule({ kind: 'supervise-revoked', suspendedTarget: null, suspendedSupervise: true });
    await setFleetHeadcountTarget({
      workspaceId: WS, fleetSlug: 'topup-rearm', target: 4,
      config: { ...config, supervise: false }, topUpRule: revoke, sql: rootSql,
    });
    const revoked = await readRow('topup-rearm');
    expect(revoked.target).toBe(4);
    expect(revoked.config).toMatchObject({ ...config, supervise: false, topUpRule: revoke });
  });

  it('lists expired rules only, excluding in-force, winding-down and malformed ones', async () => {
    const ws = 'ws-topup-list';
    for (const slug of ['expired', 'in-force', 'wound', 'malformed', 'until-text', 'no-rule']) {
      await insertFleetIn(ws, slug);
      await setFleetHeadcountTarget({
        workspaceId: ws, fleetSlug: slug, target: 2, config: { ...config, supervise: true }, sql: rootSql,
      });
    }
    await setFleetHeadcountTarget({ workspaceId: ws, fleetSlug: 'expired', target: null, topUpRule: rule(), sql: rootSql });
    await setFleetHeadcountTarget({
      workspaceId: ws, fleetSlug: 'in-force', target: null, topUpRule: rule({ until: 50_000 }), sql: rootSql,
    });
    await setFleetHeadcountTarget({ workspaceId: ws, fleetSlug: 'wound', target: null, topUpRule: rule(), sql: rootSql });
    expect(await setFleetControlState(
      ws, 'wound', { state: 'winding-down', reason: 'plan shipped', by: 'su-test' }, rootSql,
    )).toBeTruthy();
    // Written raw: the typed writer could never store these shapes.
    await rootSql.unsafe(
      `UPDATE harness_shared.agent_fleets
          SET headcount_target = NULL,
              headcount_config = headcount_config || jsonb_build_object('topUpRule', $3::jsonb)
        WHERE workspace_id = $1 AND fleet_slug = $2`,
      [ws, 'malformed', JSON.stringify({ ...rule(), reason: '' })],
    );
    await rootSql.unsafe(
      `UPDATE harness_shared.agent_fleets
          SET headcount_target = NULL,
              headcount_config = headcount_config || jsonb_build_object('topUpRule', $3::jsonb)
        WHERE workspace_id = $1 AND fleet_slug = $2`,
      [ws, 'until-text', JSON.stringify({ ...rule(), until: '5000' })],
    );

    // The wound fleet's rule is still stored: its exclusion is control_state, not absence.
    expect((await readRow('wound', ws)).config).toMatchObject({ topUpRule: rule() });

    const expired = await listExpiredFleetTopUpRules(ws, 10_000, rootSql);
    expect(expired).toEqual([
      {
        workspaceId: ws,
        fleetSlug: 'expired',
        rule: rule(),
        config: expect.objectContaining({ plan: 'drain', supervise: true }),
      },
    ]);

    // Positive control: past its own until, the in-force rule lists too; the
    // wound, malformed and text-until rows stay excluded at every instant.
    const later = await listExpiredFleetTopUpRules(ws, 100_000, rootSql);
    expect(later.map((r) => r.fleetSlug).sort()).toEqual(['expired', 'in-force']);
    // The boundary is inclusive: a rule expires AT its until.
    expect((await listExpiredFleetTopUpRules(ws, 5_000, rootSql)).map((r) => r.fleetSlug)).toEqual(['expired']);
    expect(await listExpiredFleetTopUpRules(ws, 4_999, rootSql)).toEqual([]);
  });

  it('lapse with restore puts back the suspended target and grant of a target-disabled rule', async () => {
    await insertFleet('topup-lapse-target');
    await setFleetHeadcountTarget({
      workspaceId: WS, fleetSlug: 'topup-lapse-target', target: 3, config: { ...config, supervise: true }, sql: rootSql,
    });
    await setFleetHeadcountTarget({
      workspaceId: WS, fleetSlug: 'topup-lapse-target', target: null, topUpRule: rule(), sql: rootSql,
    });
    expect(await listFleetHeadcountTargets(WS, rootSql)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ fleetSlug: 'topup-lapse-target' })]),
    );

    expect(await lapseFleetTopUpRule({
      workspaceId: WS, fleetSlug: 'topup-lapse-target', expectedUntil: 5_000, restore: true, now: 9_000, sql: rootSql,
    })).toBe(true);
    const lapsed = await readRow('topup-lapse-target');
    expect(lapsed.target).toBe(3);
    expect(lapsed.config).toMatchObject({ ...config, supervise: true });
    expect(lapsed.config).not.toHaveProperty('topUpRule');
    expect(await listFleetHeadcountTargets(WS, rootSql)).toEqual(
      expect.arrayContaining([expect.objectContaining({ fleetSlug: 'topup-lapse-target', target: 3 })]),
    );
    // A second lapse finds no rule and changes nothing.
    expect(await lapseFleetTopUpRule({
      workspaceId: WS, fleetSlug: 'topup-lapse-target', expectedUntil: 5_000, restore: true, sql: rootSql,
    })).toBe(false);
  });

  it('lapse with restore on a supervise-revoked rule restores only the grant', async () => {
    await insertFleet('topup-lapse-grant');
    await setFleetHeadcountTarget({
      workspaceId: WS, fleetSlug: 'topup-lapse-grant', target: 2, config: { ...config, supervise: false },
      topUpRule: rule({ kind: 'supervise-revoked', suspendedTarget: 7, suspendedSupervise: true }), sql: rootSql,
    });
    expect(await lapseFleetTopUpRule({
      workspaceId: WS, fleetSlug: 'topup-lapse-grant', expectedUntil: 5_000, restore: true, sql: rootSql,
    })).toBe(true);
    const lapsed = await readRow('topup-lapse-grant');
    // suspendedTarget is ignored for this kind: the target was never suspended.
    expect(lapsed.target).toBe(2);
    expect(lapsed.config).toMatchObject({ ...config, supervise: true });
    expect(lapsed.config).not.toHaveProperty('topUpRule');
  });

  it('lapse without restore only clears the rule', async () => {
    await insertFleet('topup-lapse-clear');
    await setFleetHeadcountTarget({
      workspaceId: WS, fleetSlug: 'topup-lapse-clear', target: 3, config: { ...config, supervise: false }, sql: rootSql,
    });
    await setFleetHeadcountTarget({
      workspaceId: WS, fleetSlug: 'topup-lapse-clear', target: null, topUpRule: rule(), sql: rootSql,
    });
    expect(await lapseFleetTopUpRule({
      workspaceId: WS, fleetSlug: 'topup-lapse-clear', expectedUntil: 5_000, restore: false, sql: rootSql,
    })).toBe(true);
    const cleared = await readRow('topup-lapse-clear');
    expect(cleared.target).toBeNull();
    expect(cleared.config).toMatchObject({ ...config, supervise: false });
    expect(cleared.config).not.toHaveProperty('topUpRule');
  });

  it('the until compare-and-set loses to a re-ratification, and a winding-down fleet is never lapsed', async () => {
    await insertFleet('topup-cas');
    await setFleetHeadcountTarget({
      workspaceId: WS, fleetSlug: 'topup-cas', target: 3, config: { ...config, supervise: true }, sql: rootSql,
    });
    await setFleetHeadcountTarget({
      workspaceId: WS, fleetSlug: 'topup-cas', target: null, topUpRule: rule(), sql: rootSql,
    });
    // The leader re-ratifies between the sweep's listing and its lapse.
    const reRatified = rule({ ratifiedAt: 7_000, until: 80_000 });
    await setFleetHeadcountTarget({
      workspaceId: WS, fleetSlug: 'topup-cas', target: null, topUpRule: reRatified, sql: rootSql,
    });
    expect(await lapseFleetTopUpRule({
      workspaceId: WS, fleetSlug: 'topup-cas', expectedUntil: 5_000, restore: true, sql: rootSql,
    })).toBe(false);
    expect(await readRow('topup-cas')).toMatchObject({ target: null, config: { topUpRule: reRatified } });
    // Positive control: the CURRENT until lapses it.
    expect(await lapseFleetTopUpRule({
      workspaceId: WS, fleetSlug: 'topup-cas', expectedUntil: 80_000, restore: true, sql: rootSql,
    })).toBe(true);
    expect((await readRow('topup-cas')).target).toBe(3);

    await insertFleet('topup-wound');
    await setFleetHeadcountTarget({
      workspaceId: WS, fleetSlug: 'topup-wound', target: 3, config: { ...config, supervise: true }, sql: rootSql,
    });
    await setFleetHeadcountTarget({
      workspaceId: WS, fleetSlug: 'topup-wound', target: null, topUpRule: rule(), sql: rootSql,
    });
    await setFleetControlState(WS, 'topup-wound', { state: 'winding-down', reason: 'plan shipped', by: 'su-test' }, rootSql);
    expect(await lapseFleetTopUpRule({
      workspaceId: WS, fleetSlug: 'topup-wound', expectedUntil: 5_000, restore: true, sql: rootSql,
    })).toBe(false);
    expect(await readRow('topup-wound')).toMatchObject({ target: null, config: { topUpRule: rule() } });
  });
});
