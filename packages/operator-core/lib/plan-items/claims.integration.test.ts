/**
 * claims.integration.test.ts — the plan-item claim store's lease mechanics
 * against REAL Postgres (migration 141 applied verbatim), through the public
 * authority-routed API (LocalClaimAuthority — single box, isSelf=true).
 *
 * The properties only PG can prove (clock_timestamp leases, the ON CONFLICT
 * steal guard, owner/claim_id-checked mutations):
 *
 *   • acquire: fresh → ok; same-owner re-acquire renews under a NEW claim_id;
 *     a DIFFERENT owner against a LIVE claim → {ok:false, conflict:<holder>};
 *     against a LAPSED claim → steals it (D-004 lazy reclaim).
 *   • heartbeat (D-003 asymmetric liveness): availability renews on a bare
 *     keepalive; activity does NOT (held:true, renewed:false + reason) but
 *     renews on activity/extend; wrong claim_id → held:false; a lapsed claim
 *     cannot be heartbeated back to life; ttlSecOverride clamps at MAX_TTL_SEC.
 *   • release: owner+claim_id checked (wrong owner frees nothing); correct →
 *     row gone. releaseAllClaimsForOwner sweeps a session's set.
 *   • renewOwnerActivityClaims: renews ONLY the owner's non-expired
 *     claims in BOTH modes (EI-295 residual) — lapsed not resurrected.
 *   • getClaim/listClaimsForPlan derive `expired`; sweepLapsedClaims deletes
 *     only lapsed rows (honoring the harness filter).
 *
 * getOrgPg is redirected at the module seam to the throwaway test DB (same
 * pattern as work-items-lifecycle.integration.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { FreshPgDb } from '../../test/_pg-helpers';
import { createOrgTestDb } from '../../test/_org-test-db';
import type { AcquireOpts } from './claims';
import { noteGoalClaimed, readAgentStateStamp, resetAgentStateStamps } from '../agent-state-stamp';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const claims = await import('./claims');

const WS = 'default';
const HARNESS = 'sheets';
const PLAN = 'test-plan-2026-06-07';

let db: FreshPgDb;

beforeAll(async () => {
  // Goal rehydration can read work-items/fleets on the same connection during
  // release. A missing leg aborts the D006 observer transaction even when its
  // JS reader catches the error. Reuse the migrated fixture, including those
  // real tables, rather than maintaining a partial claim-only schema.
  const org = await createOrgTestDb({ adminPoolMax: 4 });
  db = { sql: org.adminSql, url: org.adminDsn, cleanup: org.cleanup };
  h.sql = db.sql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  resetAgentStateStamps();
  await db.sql`DELETE FROM harness_shared.plan_item_claims`;
  await db.sql`DELETE FROM harness_shared.agent_activity`;
  await db.sql`DELETE FROM harness_shared.adv_sessions`;
});

/** Record a holder tool-activity event `ageSec` seconds in the past (EI-8997 grace). */
async function activity(ownerId: string, ageSec = 0) {
  await db.sql`
    INSERT INTO harness_shared.agent_activity (owner_id, kind, created_at)
    VALUES (${ownerId}, 'tool_call', clock_timestamp() - make_interval(secs => ${ageSec}))
  `;
}

/** Force a claim's lease into the past (a lapsed claim). */
async function lapse(itemId: string) {
  await db.sql`
    UPDATE harness_shared.plan_item_claims
       SET expires_ts = clock_timestamp() - interval '1 second'
     WHERE workspace_id = ${WS} AND item_id = ${itemId}
  `;
}

function acquire(over: Partial<AcquireOpts> = {}) {
  return claims.acquireClaim({
    workspaceId: WS,
    harnessSlug: HARNESS,
    planSlug: PLAN,
    itemId: 'P-001',
    owner: 'su-alice',
    ...over,
  });
}

describe('acquireClaim', () => {
  it('fresh acquire succeeds with the availability defaults', async () => {
    const res = await acquire();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.claim.owner).toBe('su-alice');
    expect(res.claim.livenessMode).toBe('availability');
    expect(res.claim.ttlSec).toBe(claims.DEFAULT_AVAILABILITY_TTL_SEC);
    expect(res.claim.expired).toBe(false);
  });

  it('activity mode gets the activity default TTL; explicit ttl is clamped at MAX_TTL_SEC', async () => {
    const a = await acquire({ itemId: 'P-002', livenessMode: 'activity' });
    expect(a.ok && a.claim.ttlSec).toBe(claims.DEFAULT_ACTIVITY_TTL_SEC);
    const b = await acquire({ itemId: 'P-003', ttlSec: 999_999 });
    expect(b.ok && b.claim.ttlSec).toBe(claims.MAX_TTL_SEC);
    const c = await acquire({ itemId: 'P-004', ttlSec: -5 });
    expect(c.ok && c.claim.ttlSec).toBe(claims.DEFAULT_AVAILABILITY_TTL_SEC);
  });

  it('same-owner re-acquire renews under a NEW claim_id', async () => {
    const first = await acquire({ intent: 'first' });
    const second = await acquire({ intent: 'second' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.claim.claimId).not.toBe(first.claim.claimId);
    expect(second.claim.intent).toBe('second');
    // still exactly one row (the PK is the mutual exclusion)
    const all = await claims.listClaimsForPlan(WS, HARNESS, PLAN);
    expect(all).toHaveLength(1);
  });

  it('a different owner against a LIVE claim gets {ok:false} with the holder reported', async () => {
    await acquire({ intent: 'mine' });
    const res = await acquire({ owner: 'su-bob' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.conflict.owner).toBe('su-alice');
    expect(res.conflict.intent).toBe('mine');
    expect(res.conflict.expired).toBe(false);
  });

  it('a different owner STEALS a lapsed claim (D-004 lazy reclaim)', async () => {
    await acquire();
    await lapse('P-001');
    const res = await acquire({ owner: 'su-bob' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.claim.owner).toBe('su-bob');
    expect(res.claim.expired).toBe(false);
  });
});

describe('heartbeatClaim — D-003 asymmetric liveness', () => {
  it('availability renews on a bare keepalive', async () => {
    const a = await acquire();
    if (!a.ok) throw new Error('setup');
    const hb = await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-001', a.claim.claimId, 'su-alice', 'keepalive');
    expect(hb).toMatchObject({ renewed: true, held: true });
    expect(hb.expiresTs).not.toBeNull();
  });

  it('activity mode is NOT renewed by a keepalive (held, with the nudge reason) but IS by activity/extend', async () => {
    const a = await acquire({ itemId: 'P-010', livenessMode: 'activity' });
    if (!a.ok) throw new Error('setup');
    const keep = await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-010', a.claim.claimId, 'su-alice', 'keepalive');
    expect(keep.renewed).toBe(false);
    expect(keep.held).toBe(true);
    expect(keep.reason).toMatch(/activity\/extend/);
    const act = await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-010', a.claim.claimId, 'su-alice', 'activity');
    expect(act).toMatchObject({ renewed: true, held: true });
    const ext = await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-010', a.claim.claimId, 'su-alice', 'extend');
    expect(ext).toMatchObject({ renewed: true, held: true });
  });

  it('ttlSecOverride is applied and clamped at MAX_TTL_SEC', async () => {
    const a = await acquire();
    if (!a.ok) throw new Error('setup');
    await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-001', a.claim.claimId, 'su-alice', 'extend', 999_999);
    const row = await claims.getClaim(WS, HARNESS, PLAN, 'P-001');
    expect(row?.ttlSec).toBe(claims.MAX_TTL_SEC);
  });

  it('a wrong claim_id (a re-acquired claim) no longer heartbeats: held:false', async () => {
    const a = await acquire();
    if (!a.ok) throw new Error('setup');
    const re = await acquire({ intent: 'renewed' }); // same owner → NEW claim_id
    if (!re.ok) throw new Error('setup');
    const hb = await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-001', a.claim.claimId, 'su-alice');
    expect(hb.held).toBe(false);
    expect(hb.reason).toMatch(/another owner or under a new claim_id/);
  });

  it('a lapsed claim cannot be heartbeated back to life', async () => {
    const a = await acquire();
    if (!a.ok) throw new Error('setup');
    await lapse('P-001');
    const hb = await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-001', a.claim.claimId, 'su-alice', 'activity');
    expect(hb).toMatchObject({ renewed: false, held: false, expiresTs: null });
    expect(hb.reason).toMatch(/lapsed|released/);
  });
});

describe('release', () => {
  it('owner+claim_id checked: the wrong owner frees nothing; the right one frees the row', async () => {
    const a = await acquire();
    if (!a.ok) throw new Error('setup');
    noteGoalClaimed('su-alice', `${PLAN}#P-001`);
    expect(await claims.releaseClaim(WS, HARNESS, PLAN, 'P-001', a.claim.claimId, 'su-bob')).toBe(false);
    expect(await claims.getClaim(WS, HARNESS, PLAN, 'P-001')).not.toBeNull();
    expect(await claims.releaseClaim(WS, HARNESS, PLAN, 'P-001', a.claim.claimId, 'su-alice')).toBe(true);
    expect(await claims.getClaim(WS, HARNESS, PLAN, 'P-001')).toBeNull();
    expect(readAgentStateStamp('su-alice').goalRef).toBeNull();
  });

  it('releasing an older claim does not clear a newer plan-item goal', async () => {
    const old = await acquire({ itemId: 'P-001' });
    const newer = await acquire({ itemId: 'P-002' });
    if (!old.ok || !newer.ok) throw new Error('setup');
    noteGoalClaimed('su-alice', `${PLAN}#P-002`);

    expect(await claims.releaseClaim(WS, HARNESS, PLAN, 'P-001', old.claim.claimId, 'su-alice')).toBe(true);
    expect(await claims.getClaim(WS, HARNESS, PLAN, 'P-001')).toBeNull();
    expect(readAgentStateStamp('su-alice').goalRef).toBe(`${PLAN}#P-002`);

    expect(await claims.releaseClaim(WS, HARNESS, PLAN, 'P-002', newer.claim.claimId, 'su-alice')).toBe(true);
    expect(readAgentStateStamp('su-alice').goalRef).toBeNull();
  });

  it('releaseAllClaimsForOwner sweeps exactly the owner set', async () => {
    await acquire({ itemId: 'P-001' });
    await acquire({ itemId: 'P-002' });
    await acquire({ itemId: 'P-003', owner: 'su-bob' });
    noteGoalClaimed('su-alice', `${PLAN}#P-002`);
    expect(await claims.releaseAllClaimsForOwner(WS, 'su-alice')).toBe(2);
    const left = await claims.listClaimsForPlan(WS, HARNESS, PLAN);
    expect(left.map((c) => c.owner)).toEqual(['su-bob']);
    expect(readAgentStateStamp('su-alice').goalRef).toBeNull();
  });
});

describe('D-006 plan-only claim isolation', () => {
  const source = 'su-d006-source';
  const answerer = 'su-d006-answerer';

  // A transactional observer in the disposable fixture catches intermediate
  // writes, including delete/reacquire with equal holder endpoints. The label
  // identifies this controlled wrapper; it is not trusted native attribution.
  async function observe(run: (sql: postgres.Sql) => Promise<void>) {
    await db.sql.begin(async (transaction) => {
      const sql = transaction as unknown as postgres.Sql;
      await sql.unsafe(`
        CREATE TEMP TABLE d006_claim_observations (
          id bigserial PRIMARY KEY,
          operation text NOT NULL,
          wrapper text NOT NULL,
          old_claim jsonb,
          new_claim jsonb
        ) ON COMMIT DROP;
        CREATE OR REPLACE FUNCTION pg_temp.observe_d006_claim() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          INSERT INTO d006_claim_observations (operation, wrapper, old_claim, new_claim)
          VALUES (TG_OP, current_setting('application_name'),
                  CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
                  CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END);
          RETURN NULL;
        END $fn$;
        CREATE TRIGGER d006_claim_observer AFTER INSERT OR UPDATE OR DELETE
          ON harness_shared.plan_item_claims
          FOR EACH ROW EXECUTE FUNCTION pg_temp.observe_d006_claim();
      `).simple();
      h.sql = sql;
      try {
        await run(sql);
        await sql.unsafe('DROP TRIGGER d006_claim_observer ON harness_shared.plan_item_claims');
      } finally {
        h.sql = db.sql;
      }
    });
  }

  async function sourceRows(sql: postgres.Sql) {
    return sql<{ claim: Record<string, unknown> }[]>`
      SELECT to_jsonb(c) AS claim FROM harness_shared.plan_item_claims c
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
         AND plan_slug = ${PLAN} AND owner = ${source}
       ORDER BY item_id
    `;
  }

  async function sourceChanges(sql: postgres.Sql) {
    return sql<{ operation: string; wrapper: string; old_claim: Record<string, unknown> | null;
      new_claim: Record<string, unknown> | null }[]>`
      SELECT operation, wrapper, old_claim, new_claim FROM d006_claim_observations
       WHERE old_claim ->> 'owner' = ${source} OR new_claim ->> 'owner' = ${source}
       ORDER BY id
    `;
  }

  it('answerer operations preserve raw source rows; release/reacquire is observable despite equal holders', async () => {
    await observe(async (sql) => {
      const first = await acquire({ owner: source });
      const other = await acquire({ owner: source, itemId: 'P-002', livenessMode: 'activity' });
      if (!first.ok || !other.ok) throw new Error('source setup');
      const before = await sourceRows(sql);
      await sql`DELETE FROM d006_claim_observations`;
      await sql`SELECT set_config('application_name', 'd006:answerer', true)`;

      expect((await acquire({ owner: answerer })).ok).toBe(false);
      expect(await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-001', first.claim.claimId, answerer))
        .toMatchObject({ renewed: false, held: false });
      expect(await claims.releaseClaim(WS, HARNESS, PLAN, 'P-001', first.claim.claimId, answerer)).toBe(false);
      const own = await acquire({ owner: answerer, itemId: 'P-003' });
      if (!own.ok) throw new Error('answerer positive control');
      expect(await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-003', own.claim.claimId, answerer))
        .toMatchObject({ renewed: true, held: true });
      expect(await claims.releaseAllClaimsForOwner(WS, answerer)).toBe(1);
      expect(await sourceRows(sql)).toEqual(before);
      expect(await sourceChanges(sql)).toEqual([]);

      await sql`SELECT set_config('application_name', 'd006:source', true)`;
      expect(await claims.releaseClaim(WS, HARNESS, PLAN, 'P-001', first.claim.claimId, source)).toBe(true);
      const replacement = await acquire({ owner: source });
      if (!replacement.ok) throw new Error('source replacement');
      expect(replacement.claim.claimId).not.toBe(first.claim.claimId);
      expect((await sourceRows(sql)).map((r) => r.claim.owner)).toEqual(before.map((r) => r.claim.owner));
      const changes = await sourceChanges(sql);
      expect(changes.map((r) => [r.operation, r.wrapper])).toEqual([
        ['DELETE', 'd006:source'], ['INSERT', 'd006:source'],
      ]);
      expect(changes[0].old_claim?.claim_id).toBe(first.claim.claimId);
      expect(changes[1].new_claim?.claim_id).toBe(replacement.claim.claimId);

      // A privileged system operation must match the incarnation it inspected,
      // even when the replacement has the same owner as that old incarnation.
      await sql`SELECT set_config('application_name', 'd006:system', true)`;
      const replacedRows = await sourceRows(sql);
      expect(await claims.forceReleaseClaim({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN,
        itemId: 'P-001', owner: source, claimId: first.claim.claimId })).toBe(false);
      expect((await claims.forceTakeoverClaim({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN,
        itemId: 'P-001', owner: answerer, expectedOwner: source, expectedClaimId: first.claim.claimId })).ok)
        .toBe(false);
      expect(await sourceRows(sql)).toEqual(replacedRows);
      expect(await sourceChanges(sql)).toEqual(changes);
    });
  });

  it('system expiry and sweep leave empty endpoints but retain the intermediate claim transitions', async () => {
    await observe(async (sql) => {
      expect(await sourceRows(sql)).toEqual([]);
      await sql`SELECT set_config('application_name', 'd006:source', true)`;
      const held = await acquire({ owner: source });
      if (!held.ok) throw new Error('source setup');
      await sql`SELECT set_config('application_name', 'd006:system', true)`;
      await sql`UPDATE harness_shared.plan_item_claims
                 SET expires_ts = clock_timestamp() - interval '1 second'
               WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
                 AND plan_slug = ${PLAN} AND item_id = 'P-001'`;
      expect((await claims.getClaim(WS, HARNESS, PLAN, 'P-001'))?.expired).toBe(true);
      expect(await claims.sweepLapsedClaims(WS, HARNESS)).toBe(1);
      expect(await sourceRows(sql)).toEqual([]);
      const changes = await sourceChanges(sql);
      expect(changes.map((r) => [r.operation, r.wrapper])).toEqual([
        ['INSERT', 'd006:source'], ['UPDATE', 'd006:system'], ['DELETE', 'd006:system'],
      ]);
      expect(changes[0].new_claim?.claim_id).toBe(held.claim.claimId);
      expect(changes[2].old_claim?.claim_id).toBe(held.claim.claimId);
    });
  });
});

describe('renewOwnerActivityClaims — the per-turn auto-renewal', () => {
  // EI-295 residual (2026-06-11): BOTH liveness modes renew on the owner's
  // turn — no explicit availability-heartbeat path exists yet, so this
  // renewal is the only thing keeping a turn-active owner's availability
  // lane alive. The mode-specific assertions live in
  // activity-claim-renewal.integration.test.ts; this case pins the
  // boundary conditions (lapsed + other-owner untouched).
  it('renews the owner\'s live claims (both modes); lapsed + other owners untouched', async () => {
    await db.sql`
      INSERT INTO harness_shared.adv_sessions (workspace_id, mode, cwd, coord_owner_id, started_at, ended_at)
      VALUES (${WS}, 'console', '/repo', 'su-alice', clock_timestamp() - interval '1 minute', NULL),
             (${WS}, 'console', '/repo', 'su-bob', clock_timestamp() - interval '1 minute', NULL)
    `;
    await acquire({ itemId: 'P-020', livenessMode: 'activity' });
    await acquire({ itemId: 'P-021', livenessMode: 'activity' });
    await acquire({ itemId: 'P-022' }); // availability — renews too (EI-295)
    await acquire({ itemId: 'P-023', livenessMode: 'activity', owner: 'su-bob' });
    await lapse('P-021'); // an already-lapsed activity claim must NOT resurrect

    // NOTE: at runtime postgres-js hands timestamptz back as Date (the
    // PlanItemClaim.expiresTs string type is aspirational) — compare epoch ms.
    const leaseMs = async () =>
      new Map(
        (await claims.listClaimsForPlan(WS, HARNESS, PLAN)).map((c) => [
          c.itemId,
          new Date(c.expiresTs).getTime(),
        ]),
      );
    const before = await leaseMs();
    await new Promise((r) => setTimeout(r, 10)); // ensure the renewed lease lands strictly later
    const renewed = await claims.renewOwnerActivityClaims(WS, 'su-alice');
    expect(renewed.sort()).toEqual(['P-020', 'P-022']);

    const after = await leaseMs();
    expect(after.get('P-020')!).toBeGreaterThan(before.get('P-020')!); // pushed out
    expect(after.get('P-022')!).toBeGreaterThan(before.get('P-022')!); // availability lane kept alive
    expect(after.get('P-023')).toBe(before.get('P-023')); // other owner untouched
    const lapsed = await claims.getClaim(WS, HARNESS, PLAN, 'P-021');
    expect(lapsed?.expired).toBe(true); // not resurrected
  });
});

describe('extendOwnerClaimsForAwait — EI-383 (survive an events:await sleep)', () => {
  const leaseMs = async () =>
    new Map(
      (await claims.listClaimsForPlan(WS, HARNESS, PLAN)).map((c) => [
        c.itemId,
        new Date(c.expiresTs).getTime(),
      ]),
    );

  it('pushes a live claim\'s expiry out to the target TTL; lapsed + other owners untouched', async () => {
    await acquire({ itemId: 'P-030', livenessMode: 'activity' });
    await acquire({ itemId: 'P-031', livenessMode: 'activity', owner: 'su-bob' });
    await acquire({ itemId: 'P-032', livenessMode: 'activity' });
    await lapse('P-032'); // an already-lapsed claim must NOT resurrect

    const before = await leaseMs();
    // A long await (well beyond the default ~20-30m activity TTL) — this is
    // exactly the case the ticket describes: a claim held while genuinely
    // parked on a push-wake sleep.
    const extended = await claims.extendOwnerClaimsForAwait(WS, 'su-alice', 3600);
    expect(extended).toEqual(['P-030']);

    const after = await leaseMs();
    expect(after.get('P-030')!).toBeGreaterThan(before.get('P-030')!);
    // The extension lands roughly `targetTtlSec` out from now, not just a small bump.
    expect(after.get('P-030')! - Date.now()).toBeGreaterThan(3000 * 1000);
    expect(after.get('P-031')).toBe(before.get('P-031')); // other owner untouched
    const lapsed = await claims.getClaim(WS, HARNESS, PLAN, 'P-032');
    expect(lapsed?.expired).toBe(true); // not resurrected
  });

  it('never SHRINKS an existing longer expiry (GREATEST, not overwrite)', async () => {
    await acquire({ itemId: 'P-033', livenessMode: 'activity', ttlSec: 5000 }); // already ~83m out
    const before = await leaseMs();
    // A short await timeout must not pull the expiry IN.
    const extended = await claims.extendOwnerClaimsForAwait(WS, 'su-alice', 60);
    expect(extended).toEqual(['P-033']); // still touched (matched the WHERE), but…
    const after = await leaseMs();
    expect(after.get('P-033')!).toBe(before.get('P-033')!); // …expiry unchanged (GREATEST kept the longer one)
  });

  it('caps at MAX_TTL_SEC — the same 2h dead-holder-detection ceiling every lease respects', async () => {
    await acquire({ itemId: 'P-034', livenessMode: 'activity' });
    await claims.extendOwnerClaimsForAwait(WS, 'su-alice', 24 * 3600); // a 1-day await
    const claim = await claims.getClaim(WS, HARNESS, PLAN, 'P-034');
    const outMs = new Date(claim!.expiresTs).getTime() - Date.now();
    expect(outMs).toBeLessThanOrEqual(claims.MAX_TTL_SEC * 1000 + 5000); // capped, +slack for test latency
    expect(outMs).toBeGreaterThan(claims.MAX_TTL_SEC * 1000 - 5000);
  });

  it('fails the best-effort await-claim extension promptly under a real row-table lock', async () => {
    let unlock!: () => void;
    let reportLockAcquired!: () => void;
    const locked = new Promise<void>((resolve) => { reportLockAcquired = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const blocker = db.sql.begin(async tx => {
      await tx`LOCK TABLE harness_shared.plan_item_claims IN ACCESS EXCLUSIVE MODE`;
      reportLockAcquired();
      await release;
    });
    await locked;
    const startedAt = Date.now();
    try {
      const error = await claims.extendOwnerClaimsForAwait(WS, 'su-alice', 3600)
        .then(() => null, failure => failure as Error & { pgCode?: string });
      expect(error).toMatchObject({ name: 'OrgTxnTimeoutError', pgCode: '55P03' });
      expect(Date.now() - startedAt).toBeLessThan(15_000);
    } finally {
      unlock();
      await blocker;
    }
  });
});

describe('reads + sweep', () => {
  it('reads exact-owner endpoints across plans/harnesses, retaining lapsed leases without changing rows', async () => {
    await acquire({ itemId: 'P-002' });
    await acquire({ itemId: 'P-001', harnessSlug: 'aaa', planSlug: 'another-plan' });
    await acquire({ itemId: 'P-003', owner: 'su-bob' });
    await acquire({ itemId: 'P-004', workspaceId: 'foreign-workspace' });
    await lapse('P-002');
    const before = await db.sql`SELECT * FROM harness_shared.plan_item_claims ORDER BY workspace_id, harness_slug, plan_slug, item_id`;
    const own = await claims.listClaimsForOwner(WS, 'su-alice', 201);
    expect(own.map(row => [row.harnessSlug, row.planSlug, row.itemId, row.expired]))
      .toEqual([['aaa', 'another-plan', 'P-001', false], [HARNESS, PLAN, 'P-002', true]]);
    expect(own.every(row => row.owner === 'su-alice' && row.workspaceId === WS)).toBe(true);
    expect(await claims.listClaimsForOwner(WS, 'unheld-owner', 201)).toEqual([]);
    expect(await db.sql`SELECT * FROM harness_shared.plan_item_claims ORDER BY workspace_id, harness_slug, plan_slug, item_id`)
      .toEqual(before);
  });

  it('retains exact incarnation and lease changes across heartbeat and same-owner release/reacquire', async () => {
    const result = await acquire();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [before] = await claims.listClaimsForOwner(WS, 'su-alice', 201);
    await claims.heartbeatClaim(WS, HARNESS, PLAN, 'P-001', result.claim.claimId, 'su-alice', 'extend', 3600);
    const [renewed] = await claims.listClaimsForOwner(WS, 'su-alice', 201);
    expect(renewed.claimId).toBe(before.claimId);
    expect(new Date(renewed.expiresTs).getTime()).toBeGreaterThan(new Date(before.expiresTs).getTime());
    expect(await claims.releaseClaim(WS, HARNESS, PLAN, 'P-001', result.claim.claimId, 'su-alice')).toBe(true);
    expect(await claims.listClaimsForOwner(WS, 'su-alice', 201)).toEqual([]);
    await acquire();
    const [replaced] = await claims.listClaimsForOwner(WS, 'su-alice', 201);
    expect(replaced.claimId).not.toBe(before.claimId);
    expect(replaced.owner).toBe(before.owner);
    expect(replaced.itemId).toBe(before.itemId);
  });

  it('bounds owner endpoint reads with an overflow sentinel and rejects invalid bounds', async () => {
    await db.sql`
      INSERT INTO harness_shared.plan_item_claims
        (workspace_id, harness_slug, plan_slug, item_id, owner, acquired_ts, expires_ts, last_activity_ts)
      SELECT ${WS}, ${HARNESS}, ${PLAN}, 'P-' || lpad(n::text, 3, '0'), 'su-alice',
        clock_timestamp(), clock_timestamp() + interval '20 minutes', clock_timestamp()
      FROM generate_series(1, 202) AS n`;
    const rows = await claims.listClaimsForOwner(WS, 'su-alice', 201);
    expect(rows).toHaveLength(201);
    expect(rows[200].itemId).toBe('P-201');
    expect(await claims.listClaimsForOwner(WS, 'su-alice', 1)).toHaveLength(1);
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 202]) {
      await expect(claims.listClaimsForOwner(WS, 'su-alice', invalid)).rejects.toThrow('claim read limit');
    }
  });

  it('getClaim/listClaimsForPlan derive `expired`; listing is item-ordered', async () => {
    await acquire({ itemId: 'P-002' });
    await acquire({ itemId: 'P-001' });
    await lapse('P-002');
    const list = await claims.listClaimsForPlan(WS, HARNESS, PLAN);
    expect(list.map((c) => c.itemId)).toEqual(['P-001', 'P-002']);
    expect(list.map((c) => c.expired)).toEqual([false, true]);
    expect((await claims.getClaim(WS, HARNESS, PLAN, 'P-002'))?.expired).toBe(true);
    expect(await claims.getClaim(WS, HARNESS, PLAN, 'P-404')).toBeNull();
  });

  it('sweepLapsedClaims deletes only lapsed rows and honors the harness filter', async () => {
    await acquire({ itemId: 'P-001' });
    await acquire({ itemId: 'P-002' });
    await acquire({ itemId: 'P-003', harnessSlug: 'other' });
    await lapse('P-002');
    await lapse('P-003');
    // wrong harness filter → nothing swept there
    expect(await claims.sweepLapsedClaims(WS, HARNESS)).toBe(1);
    expect(await claims.getClaim(WS, HARNESS, PLAN, 'P-001')).not.toBeNull();
    expect(await claims.getClaim(WS, HARNESS, PLAN, 'P-002')).toBeNull();
    // unfiltered sweep catches the other harness's lapsed row
    expect(await claims.sweepLapsedClaims(WS)).toBe(1);
    expect(await claims.getClaim(WS, 'other', PLAN, 'P-003')).toBeNull();
  });
});

describe('EI-8997 lapse grace — lapse means holder DEAD, not holder BUSY', () => {
  it('a different owner CANNOT steal a lapsed claim whose holder has fresh activity — the incumbent lease auto-renews under the SAME claim_id', async () => {
    const first = await acquire({ owner: 'su-alice' });
    expect(first.ok).toBe(true);
    const aliceClaimId = first.ok ? first.claim.claimId : '';
    await lapse('P-001');
    await activity('su-alice'); // alice is mid-long-turn: fresh tool call, no renewal landed
    const steal = await acquire({ owner: 'su-bob' });
    expect(steal.ok).toBe(false);
    if (steal.ok) return;
    expect(steal.reason).toBe('holder-active-lease-renewed');
    expect(steal.conflict.owner).toBe('su-alice');
    expect(steal.conflict.expired).toBe(false); // self-healed: the lease is LIVE again
    expect(steal.conflict.claimId).toBe(aliceClaimId); // renewed, not re-issued
    const now = await claims.getClaim(WS, HARNESS, PLAN, 'P-001');
    expect(now?.owner).toBe('su-alice');
    expect(now?.expired).toBe(false);
  });

  it('activity OLDER than the grace does not protect the claim — the steal proceeds (D-004 lazy reclaim preserved)', async () => {
    await acquire({ owner: 'su-alice' });
    await lapse('P-001');
    await activity('su-alice', claims.CLAIM_LAPSE_ACTIVITY_GRACE_SEC + 60);
    const steal = await acquire({ owner: 'su-bob' });
    expect(steal.ok).toBe(true);
    expect(steal.ok && steal.claim.owner).toBe('su-bob');
  });

  it("another agent's fresh activity does not protect the holder (grace keys on the HOLDER's owner_id)", async () => {
    await acquire({ owner: 'su-alice' });
    await lapse('P-001');
    await activity('su-someone-else');
    const steal = await acquire({ owner: 'su-bob' });
    expect(steal.ok).toBe(true);
    expect(steal.ok && steal.claim.owner).toBe('su-bob');
  });

  it('sweepLapsedClaims skips a lapsed claim with fresh holder activity, sweeps it once the activity ages out', async () => {
    await acquire({ owner: 'su-alice' });
    await lapse('P-001');
    await activity('su-alice');
    expect(await claims.sweepLapsedClaims(WS, HARNESS)).toBe(0); // busy holder — spared
    await db.sql`DELETE FROM harness_shared.agent_activity`;
    await activity('su-alice', claims.CLAIM_LAPSE_ACTIVITY_GRACE_SEC + 60);
    expect(await claims.sweepLapsedClaims(WS, HARNESS)).toBe(1); // quiet holder — reclaimed
  });

  it('a LIVE (unexpired) claim is untouched by the grace path — plain conflict, no reason', async () => {
    await acquire({ owner: 'su-alice' });
    await activity('su-alice');
    const steal = await acquire({ owner: 'su-bob' });
    expect(steal.ok).toBe(false);
    if (steal.ok) return;
    expect(steal.reason).toBeUndefined();
    expect(steal.conflict.owner).toBe('su-alice');
  });
});
