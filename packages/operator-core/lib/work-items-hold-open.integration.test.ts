/**
 * work-items-hold-open.integration.test.ts — the HOLD-OPEN lease reaper (WI-4531)
 * against real Postgres.
 *
 * THE CONTRACT: a hold-open must not outlive its holder. A hold whose holder is LIVE is
 * honoured forever (the long-running leader gate hold_open exists for — WI-3548); a hold left
 * behind by a DEAD session expires and stops (a) starving the item out of claim_next/scheduler
 * self-select and (b) refusing every non-holder's terminal transition.
 *
 * The liveness rule is deliberately the SAME mig-225 alias-aware fragments the claim reapers
 * use (liveHolderFragment / parkedHolderFragment), so the two can never drift — the nursery-
 * alias case below exists specifically to prove the shared fragment is really in the path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';
import { reclaimStaleHoldOpens, isHoldOpenExpired, HOLD_OPEN_GRACE_MS } from './work-items-hold-open';
import { sweepDeadOwnerControlState } from './dead-owner-control-sweep';

const PRESENCE_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.coord_presence (
    owner_id text PRIMARY KEY,
    heartbeat_at timestamptz
  )`;
const SPAWNED_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text PRIMARY KEY,
    session_owner text,
    run_id text,
    status text NOT NULL,
    heartbeat_at timestamptz,
    finished_at timestamptz,
    cancelled_at timestamptz
  )`;
const ROUTINES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.routines (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    name text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    reschedule_interval_sec integer,
    target_owner_id text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
  )`;
// EI-18674157526367861: `liveHolderFragment` now UNIONs in `activeTurnHolderFragment`
// (the cross-CLI worker activity bridge sink, migration 143) — this test's own
// minimal DDL fixture predates that fix and never created the table, so every test
// here started failing with `relation "harness_shared.agent_activity" does not
// exist` (discovered live while verifying an unrelated WI-5964 change to this file's
// seedPresence helper). Same deliberately-minimal projection as the sibling
// work-items-stale-claims.integration.test.ts's AGENT_ACTIVITY_DDL (only the columns
// activeTurnHolderFragment reads: owner_id/kind/summary/created_at).
const AGENT_ACTIVITY_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.agent_activity (
    id BIGSERIAL PRIMARY KEY,
    owner_id text NOT NULL,
    kind text NOT NULL,
    summary text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;

let db: FreshPgDb;
let sql: postgres.Sql;
const WS = 'default';
const H = 'papercup';

beforeAll(async () => {
  db = await createFreshPgDb();
  sql = db.sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await sql.unsafe(PRESENCE_DDL);
  await sql.unsafe(SPAWNED_DDL);
  await sql.unsafe(ROUTINES_DDL);
  await sql.unsafe(AGENT_ACTIVITY_DDL);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.work_items, harness_shared.coord_presence, harness_shared.spawned_agents, harness_shared.routines, harness_shared.agent_activity`;
});

describe('agent-operability P-003 — one dead-owner sweep', () => {
  it('terminates every loop and lifts every expired hold for one unreachable owner atomically', async () => {
    await seedHeld('WI-DEAD-1', 'su-dead-batch', 8 * 60);
    await seedHeld('WI-DEAD-2', 'su-dead-batch', 8 * 60);
    await sql`
      INSERT INTO harness_shared.routines
        (id, workspace_id, name, active, reschedule_interval_sec, target_owner_id, updated_at)
      VALUES
        ('loop-a', ${WS}, 'loop-a', true, 60, 'su-dead-batch', now() - interval '3 hours'),
        ('loop-b', ${WS}, 'loop-b', true, 300, 'su-dead-batch', now() - interval '3 hours')`;

    const result = await sweepDeadOwnerControlState(sql, { ownerGraceMs: 1, holdOpenGraceMs: 1 });

    expect(result).toEqual({ owners: ['su-dead-batch'], loopsTerminated: 2, holdsLifted: 2 });
    const [loopState] = await sql<{ active: string }[]>`
      SELECT count(*) FILTER (WHERE active)::text AS active
        FROM harness_shared.routines WHERE target_owner_id = 'su-dead-batch'`;
    expect(loopState?.active).toBe('0');
    expect(await holdOf('WI-DEAD-1')).toEqual({ by: null, claimHold: null });
    expect(await holdOf('WI-DEAD-2')).toEqual({ by: null, claimHold: null });
  });

  it('WI-10005173: the dead-owner sweep NEVER lifts a hold on a PEER-WRITTEN (origin=remote) row', async () => {
    await seedHeld('WI-PEER-DEAD', 'su-dead-peer', 8 * 60, { origin: 'remote' });
    await seedHeld('WI-LOCAL-DEAD', 'su-dead-peer', 8 * 60);
    expect(await originOf('WI-PEER-DEAD')).toBe('remote');
    await sql`
      INSERT INTO harness_shared.routines
        (id, workspace_id, name, active, reschedule_interval_sec, target_owner_id, updated_at)
      VALUES ('loop-peer', ${WS}, 'loop-peer', true, 60, 'su-dead-peer', now() - interval '3 hours')`;

    const result = await sweepDeadOwnerControlState(sql, { ownerGraceMs: 1, holdOpenGraceMs: 1 });

    expect(result).toEqual({ owners: ['su-dead-peer'], loopsTerminated: 1, holdsLifted: 1 });
    expect(await holdOf('WI-PEER-DEAD')).toEqual({ by: 'su-dead-peer', claimHold: 'true' });
    expect(await holdOf('WI-LOCAL-DEAD')).toEqual({ by: null, claimHold: null });
  });

  it('WI-6774: NEVER lifts a POLICY-TIER hold via dead-owner liveness sweep, even for a fully dead owner', async () => {
    // The exact incident this closes: a policy-tier fence on a live-money item, holder's loop
    // long dead — must survive the sweep. Only the audited, ownerOverride-gated
    // work_items:hold_open clear may remove it.
    await seedHeld('WI-POLICY-1', 'su-dead-policy', 8 * 60, {
      reason: 'policy-tier: daily-loss gate, D-042 — do not auto-lift',
    });
    await sql`
      INSERT INTO harness_shared.routines
        (id, workspace_id, name, active, reschedule_interval_sec, target_owner_id, updated_at)
      VALUES ('loop-policy', ${WS}, 'loop-policy', true, 60, 'su-dead-policy', now() - interval '3 hours')`;

    const result = await sweepDeadOwnerControlState(sql, { ownerGraceMs: 1, holdOpenGraceMs: 1 });

    // The dead loop is still terminated (liveness cleanup of the OWNER'S loop is unrelated to
    // the hold's policy-tier status) — only the hold survives.
    expect(result.loopsTerminated).toBe(1);
    expect(result.holdsLifted).toBe(0);
    expect(await holdOf('WI-POLICY-1')).toEqual({ by: 'su-dead-policy', claimHold: 'true' });
  });
});

/** Seed a work-item HELD OPEN by `holder`, stamped `heldAgoMin` ago — exactly the shape
 *  setWorkItemClaimHold writes (_claimHold + held_open_by/at/reason). */
async function seedHeld(
  featureId: string,
  holder: string,
  heldAgoMin: number,
  opts: { status?: string; itemKind?: string; heldAtRaw?: string | null; reason?: string; origin?: 'local' | 'remote' } = {},
): Promise<void> {
  const heldAt =
    opts.heldAtRaw !== undefined
      ? opts.heldAtRaw
      : new Date(Date.now() - heldAgoMin * 60_000).toISOString();
  const payload = {
    _claimHold: true,
    held_open_by: holder,
    held_open_reason: opts.reason ?? 'gating it',
    ...(heldAt === null ? {} : { held_open_at: heldAt }),
  };
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, status, payload, created_ts, updated_ts)
    VALUES
      (${WS}, ${H}, ${featureId}, ${opts.itemKind ?? 'task'}, ${featureId}, ${opts.status ?? 'open'},
       ${sql.json(payload)}, ${Date.now()}, ${Date.now()})`;
  if (opts.origin) {
    await sql`UPDATE harness_shared.work_items SET origin = ${opts.origin} WHERE feature_id = ${featureId}`;
  }
}

async function originOf(featureId: string): Promise<string | null> {
  const [row] = await sql<{ origin: string | null }[]>`
    SELECT origin FROM harness_shared.work_items WHERE feature_id = ${featureId}`;
  return row?.origin ?? null;
}

/** The hold as it stands in the DB right now (null ⇒ no hold). */
async function holdOf(featureId: string): Promise<{ by: string | null; claimHold: string | null }> {
  const [row] = await sql<{ by: string | null; claim_hold: string | null }[]>`
    SELECT payload->>'held_open_by' AS by, payload->>'_claimHold' AS claim_hold
      FROM harness_shared.work_items WHERE feature_id = ${featureId}`;
  return { by: row?.by ?? null, claimHold: row?.claim_hold ?? null };
}

async function seedPresence(ownerId: string, beatAgoMin: number): Promise<void> {
  // WI-5964: coord_presence_pkey is PRIMARY KEY(owner_id) ONLY — globally unique,
  // not scoped by workspace_id — so a bare INSERT can collide with a same-named
  // literal owner_id seeded by another concurrent *.integration.test.ts process on
  // this shared fixture. Upsert so this test's own values always win.
  await sql`
    INSERT INTO harness_shared.coord_presence (owner_id, heartbeat_at)
    VALUES (${ownerId}, now() - make_interval(mins => ${beatAgoMin}))
    ON CONFLICT (owner_id) DO UPDATE SET heartbeat_at = EXCLUDED.heartbeat_at`;
}

describe('WI-4531 — a hold-open must not outlive its holder', () => {
  it('LIFTS a hold whose holder is gone from coord_presence entirely (the WI-4445 case)', async () => {
    // su-0efdd444 held WI-4445 open, then vanished so completely that coord:send returned
    // unknown_recipient. Before this fix the hold blocked the item forever.
    await seedHeld('WI-4445', 'su-0efdd444', 8 * 60);

    const { expired } = await reclaimStaleHoldOpens(sql);

    expect(expired.map((e) => e.feature_id)).toEqual(['WI-4445']);
    expect(expired[0]!.former_holder).toBe('su-0efdd444');
    // BOTH halves of the hold must go: the terminal-transition guard reads held_open_by, and
    // claim_next/scheduler self-select reads _claimHold. Clearing one and leaving the other
    // would fix half the bug.
    expect(await holdOf('WI-4445')).toEqual({ by: null, claimHold: null });
  });

  it('WI-10005173: NEVER lifts a hold on a PEER-WRITTEN (origin=remote) row — this node cannot judge a peer agent', async () => {
    // Measured 2026-10-03: the Mac VM lifted a LIVE tower agent's lease on a replicated
    // row exactly HOLD_OPEN_GRACE_MS after it was stamped, because the tower agent is never
    // in the VM's coord_presence, then federated the revocation back to the tower.
    await seedHeld('WI-PEER-HELD', 'su-peer-agent', 8 * 60, { origin: 'remote' });
    // Control: the identical lease on a locally-written row IS lifted, so the guard below
    // is not passing vacuously (holder absent here, past grace).
    await seedHeld('WI-LOCAL-HELD', 'su-peer-agent', 8 * 60);
    expect(await originOf('WI-PEER-HELD')).toBe('remote');

    const { expired } = await reclaimStaleHoldOpens(sql);

    expect(expired.map((e) => e.feature_id)).toEqual(['WI-LOCAL-HELD']);
    expect(await holdOf('WI-PEER-HELD')).toEqual({ by: 'su-peer-agent', claimHold: 'true' });
    expect(await holdOf('WI-LOCAL-HELD')).toEqual({ by: null, claimHold: null });
  });

  it('WI-6774: NEVER lifts a POLICY-TIER hold via the liveness reaper, even for a fully dead holder', async () => {
    // Same shape as the WI-4445 case above (holder entirely gone, hold way past grace) — the
    // ONLY difference is the reason names a policy-tier gate. That alone must be enough to
    // survive this sweep; only work_items:hold_open's ownerOverride-gated clear may lift it.
    await seedHeld('WI-POLICY-2', 'su-dead-policy-2', 8 * 60, {
      reason: 'triageDecision:"gate" — owner sign-off required before clearing',
    });

    const { expired } = await reclaimStaleHoldOpens(sql);

    expect(expired).toEqual([]);
    expect(await holdOf('WI-POLICY-2')).toEqual({ by: 'su-dead-policy-2', claimHold: 'true' });
  });

  it('NEVER lifts a LIVE holder\'s hold, however old it is (the leader gate stays a gate)', async () => {
    // The whole point of hold_open: a leader gating an item for days. Liveness EXTENDS the
    // lease — age alone must never expire it, or this "fix" would break the feature.
    await seedHeld('WI-3548', 'su-leader', 30 * 24 * 60); // held 30 days ago
    await seedPresence('su-leader', 1); // …but beating right now

    const { expired } = await reclaimStaleHoldOpens(sql);

    expect(expired).toEqual([]);
    expect((await holdOf('WI-3548')).by).toBe('su-leader');
  });

  it('does NOT lift a fresh hold whose holder is not yet visible (transient-invisibility guard)', async () => {
    // An agent that just placed a hold may not have a presence row in hand yet. The grace
    // measured from held_open_at is what stops the sweep from robbing it instantly.
    await seedHeld('WI-NEW', 'su-just-started', 5); // 5 min old, no presence row

    const { expired } = await reclaimStaleHoldOpens(sql);

    expect(expired).toEqual([]);
    expect((await holdOf('WI-NEW')).by).toBe('su-just-started');
  });

  it('does NOT lift a BRIEFLY-PARKED holder\'s hold (the WI-2689 churn guard, same window claims get)', async () => {
    // Beat 15m ago: past the 10m live window, inside the 30m parked window — a member whose
    // loop dropped and is about to be re-armed, not a dead one.
    await seedHeld('WI-PARKED', 'su-parked', 5 * 60);
    await seedPresence('su-parked', 15);

    const { expired } = await reclaimStaleHoldOpens(sql);

    expect(expired).toEqual([]);
    expect((await holdOf('WI-PARKED')).by).toBe('su-parked');
  });

  it('lifts a hold whose holder is IN coord_presence but long dead (beat past the parked window)', async () => {
    await seedHeld('WI-DEAD-BEAT', 'su-stale', 5 * 60);
    await seedPresence('su-stale', 90); // beat 90m ago — past live (10m) AND parked (30m)

    const { expired } = await reclaimStaleHoldOpens(sql);

    expect(expired.map((e) => e.feature_id)).toEqual(['WI-DEAD-BEAT']);
    expect((await holdOf('WI-DEAD-BEAT')).by).toBeNull();
  });

  it('honours NURSERY-ALIAS liveness — proving the shared mig-225 fragment is really in the path', async () => {
    // The holder has NO coord_presence row, but is the session_owner alias of a RUNNING
    // spawned_agents row with a fresh beat. The claim reapers call that alive; so must we, or
    // the two liveness rules have silently diverged.
    await seedHeld('WI-BEE', 'owner-alias-1', 6 * 60);
    await sql`
      INSERT INTO harness_shared.spawned_agents (spawn_id, session_owner, run_id, status, heartbeat_at)
      VALUES ('spawn-1', 'owner-alias-1', 'run-1', 'running', now() - make_interval(mins => 2))`;

    const { expired } = await reclaimStaleHoldOpens(sql);

    expect(expired).toEqual([]);
    expect((await holdOf('WI-BEE')).by).toBe('owner-alias-1');
  });

  it('sweeps a hold left on an ALREADY-TERMINAL item (inert residue, but residue)', async () => {
    await seedHeld('WI-DONE', 'su-gone', 8 * 60, { status: 'resolved' });

    const { expired } = await reclaimStaleHoldOpens(sql);

    expect(expired.map((e) => e.feature_id)).toEqual(['WI-DONE']);
    expect(expired[0]!.status).toBe('resolved'); // returned so the caller can NOT broadcast these
  });

  it('treats a missing / unparseable held_open_at as PAST grace (no anchor ⇒ cannot be shown fresh)', async () => {
    await seedHeld('WI-NOSTAMP', 'su-gone', 0, { heldAtRaw: null });
    await seedHeld('WI-JUNK', 'su-gone', 0, { heldAtRaw: 'not-a-timestamp' });

    const { expired } = await reclaimStaleHoldOpens(sql);

    // …and crucially the junk value does not abort the sweep with a cast error.
    expect(expired.map((e) => e.feature_id).sort()).toEqual(['WI-JUNK', 'WI-NOSTAMP']);
  });

  it('leaves an UNHELD item completely alone', async () => {
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, updated_ts)
      VALUES (${WS}, ${H}, 'WI-FREE', 'task', 'WI-FREE', 'open', ${Date.now()}, ${Date.now()})`;

    const { expired } = await reclaimStaleHoldOpens(sql);

    expect(expired).toEqual([]);
  });

  it('respects a configured holdOpenGraceMs override', async () => {
    await seedHeld('WI-CFG', 'su-gone', 90); // 90 min old, holder dead

    // Default grace is 2h ⇒ still protected.
    expect((await reclaimStaleHoldOpens(sql)).expired).toEqual([]);

    // Tighten the lease to 1h ⇒ now expired.
    const { expired } = await reclaimStaleHoldOpens(sql, { holdOpenGraceMs: 60 * 60 * 1000 });
    expect(expired.map((e) => e.feature_id)).toEqual(['WI-CFG']);
  });
});

describe('WI-4531 — isHoldOpenExpired (the inline chokepoint test)', () => {
  // setWorkItemState calls this on the refusal path so a dead holder's hold never blocks a
  // terminal transition even when the 60s sweep is wedged or has not ticked yet.
  const old = () => new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();

  it('WI-10005916: is FALSE for a PEER-WRITTEN (origin=remote) row — this node cannot judge a peer holder', async () => {
    // A peer agent is never in this node's presence, so without the origin rule it reads dead.
    expect(await isHoldOpenExpired(sql, 'su-ghost', old(), { origin: 'remote' })).toBe(false);
    // Control: the same invisible holder at the same age on a LOCAL row IS expired, so the
    // origin rule (not the fixture) is what keeps the remote hold enforced.
    expect(await isHoldOpenExpired(sql, 'su-ghost', old(), { origin: 'local' })).toBe(true);
    expect(await isHoldOpenExpired(sql, 'su-ghost', old(), { origin: null })).toBe(true);
  });

  it('is TRUE for a holder with no liveness signal at all, past grace', async () => {
    expect(await isHoldOpenExpired(sql, 'su-ghost', old())).toBe(true);
  });

  it('is FALSE for a LIVE holder (their gate must still block)', async () => {
    await seedPresence('su-live', 1);
    expect(await isHoldOpenExpired(sql, 'su-live', old())).toBe(false);
  });

  it('is FALSE for a briefly-parked holder', async () => {
    await seedPresence('su-parked', 15);
    expect(await isHoldOpenExpired(sql, 'su-parked', old())).toBe(false);
  });

  it('is FALSE within the grace window even for an invisible holder', async () => {
    const fresh = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(await isHoldOpenExpired(sql, 'su-ghost', fresh)).toBe(false);
  });

  it('is TRUE when the hold carries no timestamp and the holder is invisible', async () => {
    expect(await isHoldOpenExpired(sql, 'su-ghost', null)).toBe(true);
  });

  it('is FALSE for an empty holder string (nothing to expire)', async () => {
    expect(await isHoldOpenExpired(sql, '   ', old())).toBe(false);
  });

  it('agrees with the sweep at the grace boundary', async () => {
    const justInside = new Date(Date.now() - (HOLD_OPEN_GRACE_MS - 5 * 60_000)).toISOString();
    const justOutside = new Date(Date.now() - (HOLD_OPEN_GRACE_MS + 5 * 60_000)).toISOString();
    expect(await isHoldOpenExpired(sql, 'su-ghost', justInside)).toBe(false);
    expect(await isHoldOpenExpired(sql, 'su-ghost', justOutside)).toBe(true);
  });
});

/** Seed a work-item DURABLY PARKED out of self-select (release {claimHold:true}) — the
 *  claim_hold_* provenance shape setWorkItemClaimHold writes for `parkedBy`, with NO
 *  held_open_* lease. */
async function seedParked(featureId: string, parker: string, parkedAgoMin: number, extraPayload: Record<string, unknown> = {}): Promise<void> {
  const payload = {
    _claimHold: true,
    claim_hold_by: parker,
    claim_hold_reason: 'umbrella item tracked elsewhere — do not self-select',
    claim_hold_at: new Date(Date.now() - parkedAgoMin * 60_000).toISOString(),
    ...extraPayload,
  };
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, status, payload, created_ts, updated_ts)
    VALUES
      (${WS}, ${H}, ${featureId}, 'task', ${featureId}, 'open',
       ${sql.json(payload)}, ${Date.now()}, ${Date.now()})`;
}

describe('durable park vs lease — the WI-321 boomerang fix', () => {
  // THE INCIDENT: release {claimHold:true} used to stamp held_open_by, so every park was a
  // WI-4531 liveness lease — and a park placed by an ephemeral drain agent lapsed ~2h after
  // its session died. Eight agents in 27h re-claimed the SAME parked umbrella item (WI-321),
  // each re-parking it into the same trap. A park (claim_hold_by, no held_open_by) is a
  // judgment about the ITEM, not the parker — it must survive the parker's death.

  it('a durable park is NEVER reaped, however dead its parker (the boomerang fix itself)', async () => {
    await seedParked('WI-PARK', 'su-ephemeral-drainer', 8 * 60); // parker has no liveness signal at all

    const { expired } = await reclaimStaleHoldOpens(sql);

    expect(expired).toEqual([]);
    expect((await holdOf('WI-PARK')).claimHold).toBe('true');
  });

  it('the dead-owner sweep leaves a durable park alone too', async () => {
    await seedParked('WI-PARK-2', 'su-dead-owner', 8 * 60);
    await sql`
      INSERT INTO harness_shared.routines
        (id, workspace_id, name, active, reschedule_interval_sec, target_owner_id, updated_at)
      VALUES ('loop-p', ${WS}, 'loop-p', true, 60, 'su-dead-owner', now() - interval '3 hours')`;

    const result = await sweepDeadOwnerControlState(sql, { ownerGraceMs: 1, holdOpenGraceMs: 1 });

    expect(result.holdsLifted).toBe(0);
    expect((await holdOf('WI-PARK-2')).claimHold).toBe('true');
  });

  it('lifting a dead LEASE preserves a coexisting durable park (_claimHold + claim_hold_* survive; held_open_* go)', async () => {
    await seedHeld('WI-BOTH', 'su-dead-gater', 8 * 60);
    await sql`
      UPDATE harness_shared.work_items
         SET payload = payload || '{"claim_hold_by":"su-parker","claim_hold_reason":"parked"}'::jsonb
       WHERE feature_id = 'WI-BOTH'`;

    const { expired } = await reclaimStaleHoldOpens(sql);

    expect(expired.map((e) => e.feature_id)).toEqual(['WI-BOTH']);
    const [row] = await sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM harness_shared.work_items WHERE feature_id = 'WI-BOTH'`;
    expect(row!.payload.held_open_by).toBeUndefined();
    expect(row!.payload.held_open_at).toBeUndefined();
    expect(String(row!.payload._claimHold)).toBe('true');
    expect(row!.payload.claim_hold_by).toBe('su-parker');
  });
});
