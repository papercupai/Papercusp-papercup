/**
 * presence-tier1.integration.test.ts — exercises the REAL batch SQL in
 * fetchPresenceTier1 against live PG (presence-v2 P-003). The pure merge is
 * unit-tested in presence-tier1.test.ts; this proves the column names + the
 * `= ANY(${ids}::text[])` idiom + DISTINCT ON / array_agg against the schema.
 *
 * Isolated on the shared table by a unique owner id + self-cleanup (the
 * presence-conformance pattern). Soft-skips if PG is unreachable.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getOrgPg } from '@papercusp/db-org';
import { fetchPresenceTier1 } from './presence-tier1';
import { getDefaultWakeMode, setWakeMode } from './wake-mode';
import { planItemRef } from '../../issue-blocks-merge';
import { openAwaitsByOwner } from '../../adv-roster';

const OWNER = `tier1-it-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const WS = 'default';

let ready = true;

async function cleanup(): Promise<void> {
  const { sql } = getOrgPg();
  await sql`DELETE FROM harness_shared.plan_item_claims WHERE owner = ${OWNER}`.catch(() => {});
  await sql`DELETE FROM harness_shared.work_items WHERE taken_by = ${OWNER}`.catch(() => {});
  await sql`DELETE FROM harness_shared.event_awaits WHERE subscriber_id = ${OWNER}`.catch(() => {});
  await sql`DELETE FROM harness_shared.operator_settings WHERE key = ${`wake_mode:agent:${OWNER}`}`.catch(
    () => {},
  );
}

describe('fetchPresenceTier1 (live PG)', () => {
  beforeAll(async () => {
    try {
      await getOrgPg().sql`SELECT 1`;
    } catch {
      ready = false;
    }
  });
  afterEach(cleanup);

  it('projects plan-item-only occupancy; joins active await + wake-mode by ownerId', async (ctx) => {
    if (!ready) {
      ctx.skip();
      return;
    }
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.plan_item_claims
        (workspace_id, harness_slug, plan_slug, item_id, owner, expires_ts)
      VALUES
        (${WS}, 'papercup', 'presence-v2-2026-06-14', 'P-777', ${OWNER}, now() + interval '1 hour'),
        (${WS}, 'papercup', 'presence-v2-2026-06-14', 'P-778', ${OWNER}, now() + interval '1 hour')
    `;
    await sql`
      INSERT INTO harness_shared.event_awaits (workspace_id, subscriber_id, event_key, note)
      VALUES (${WS}, ${OWNER}, 'plan-run:finished:42', 'blocked on the run')
    `;
    await setWakeMode(OWNER, 'manual');

    const map = await fetchPresenceTier1([OWNER]);
    const e = map.get(OWNER);
    expect(e).toBeDefined();
    expect(e!.claimedItems).toEqual(['P-777', 'P-778']); // array_agg ORDER BY item_id
    expect(e!.claimCount).toBe(2); // plan-item claims remain visible in unified occupancy
    expect(e!.awaitingEvent).toBe(true);
    expect(e!.awaitingEventKey).toBe('plan-run:finished:42');
    expect(e!.awaitingNote).toBe('blocked on the run');
    expect(e!.wakeMode).toBe('manual');
    expect(e!.model).toBeNull(); // no running spawned_agents row for this owner
  });

  it('does not report an emitter declaration as a consumer wait', async (ctx) => {
    if (!ready) {
      ctx.skip();
      return;
    }
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.event_awaits
        (workspace_id, subscriber_id, event_key, policy, note)
      VALUES (${WS}, ${OWNER}, 'presence-test:source-ship', 'announce', 'Declaration only')
    `;

    expect((await fetchPresenceTier1([OWNER])).get(OWNER)).toMatchObject({
      awaitingEvent: false,
      awaitingEventKey: null,
      awaitingNote: null,
    });
    expect((await openAwaitsByOwner([OWNER])).has(OWNER)).toBe(false);
  });

  it('keeps a real consumer wait visible when its owner declares a newer output gate', async (ctx) => {
    if (!ready) {
      ctx.skip();
      return;
    }
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.event_awaits
        (workspace_id, subscriber_id, event_key, policy, note, created_at)
      VALUES
        (${WS}, ${OWNER}, 'presence-test:release-receipt', 'wake', 'Waiting for release receipt', now() - interval '1 second'),
        (${WS}, ${OWNER}, 'presence-test:source-ship', 'announce', 'Declaration only', now())
    `;

    expect((await fetchPresenceTier1([OWNER])).get(OWNER)).toMatchObject({
      awaitingEvent: true,
      awaitingEventKey: 'presence-test:release-receipt',
      awaitingNote: 'Waiting for release receipt',
    });
    expect((await openAwaitsByOwner([OWNER])).get(OWNER)).toMatchObject({
      eventKey: 'presence-test:release-receipt',
      note: 'Waiting for release receipt',
    });
  });

  it('an unclaimed owner gets empty defaults (no rows, inherits the global default wake mode)', async (ctx) => {
    if (!ready) {
      ctx.skip();
      return;
    }
    const map = await fetchPresenceTier1([OWNER]); // nothing seeded for OWNER this case
    const e = map.get(OWNER);
    expect(e).toBeDefined();
    expect(e!.claimedItems).toEqual([]);
    expect(e!.claimCount).toBe(0);
    expect(e!.awaitingEvent).toBe(false);
    expect(e!.model).toBeNull();
    // The semantic under test: NO per-owner override → falls through to the GLOBAL default.
    // Assert against the live global default, NOT the factory 'auto' — this runs against the
    // shared PG, and the owner can (deliberately) set the global default to 'manual' at any
    // time (as on 2026-07-03, which red-pinned the gate on the old hardcoded expectation).
    expect(e!.wakeMode).toBe(await getDefaultWakeMode());
  });

  it('empty ownerIds short-circuits to an empty map', async (ctx) => {
    if (!ready) {
      ctx.skip();
      return;
    }
    expect((await fetchPresenceTier1([])).size).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // EI-20200393414409502 — claimedPlanItemRefs, and WHY IT MUST BE PROVEN HERE.
  //
  // The consumer (coupling-derivation) reads roster rows STRUCTURALLY, so a unit
  // test with hand-built fixtures cannot tell a REAL field from a plausible one that
  // production never populates — the exact way `currentFiles` shipped "green (51/51)"
  // reading a field empty for essentially every live agent, and the way D-082's
  // `claimedItems` composition would have matched zero rows forever. Only a check
  // against the PRODUCER can, so the jsonb path, the terminal filter and the ref
  // format are asserted against live PG here.
  // ---------------------------------------------------------------------------
  it('projects work-item-only occupancy and derives plan-item refs, EXCLUDING terminal work', async (ctx) => {
    if (!ready) {
      ctx.skip();
      return;
    }
    const { sql } = getOrgPg();
    // Three held work-items: one live+stamped (occupies), one DONE+stamped (does
    // not — the work is finished, so it blocks nobody), one live but unstamped
    // (nothing to map back to a plan item).
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, taken_by, payload)
      VALUES
        (${WS}, 'papercup', ${`${OWNER}-live`}, 'task', 'open', ${OWNER},
         ${sql.json({ plan_item: { plan_slug: 'tier1-it-plan', item_id: 'P-101' } })}),
        (${WS}, 'papercup', ${`${OWNER}-done`}, 'task', 'done', ${OWNER},
         ${sql.json({ plan_item: { plan_slug: 'tier1-it-plan', item_id: 'P-102' } })}),
        (${WS}, 'papercup', ${`${OWNER}-bare`}, 'task', 'open', ${OWNER}, ${sql.json({})})
    `;

    const e = (await fetchPresenceTier1([OWNER])).get(OWNER);
    expect(e).toBeDefined();
    // The FORMAT is pinned to the shared builder, not to a hand-typed '#' string:
    // the derivation splits on the same separator, and a literal here would be a
    // third definition of the format free to drift from both.
    expect(e!.claimedPlanItemRefs).toEqual([planItemRef('tier1-it-plan', 'P-101')]);
    // The unstamped and terminal rows still count as HELD work — only the plan-item
    // projection excludes them.
    expect(e!.workItemClaims).toEqual([`${OWNER}-bare`, `${OWNER}-done`, `${OWNER}-live`]);
    // Occupancy is NOT plan-item claims: nothing was seeded in plan_item_claims, and
    // that surface staying empty is precisely the starvation this field routes around.
    expect(e!.claimedItems).toEqual([]);
    expect(e!.claimCount).toBe(3); // all three held work-item rows occupy work-item space
  });

  it('adds both independent claim lanes to the unified occupancy count', async (ctx) => {
    if (!ready) {
      ctx.skip();
      return;
    }
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.plan_item_claims
        (workspace_id, harness_slug, plan_slug, item_id, owner, expires_ts)
      VALUES
        (${WS}, 'papercup', 'tier1-it-both', 'P-201', ${OWNER}, now() + interval '1 hour')
    `;
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, taken_by, payload)
      VALUES
        (${WS}, 'papercup', ${`${OWNER}-both-a`}, 'task', 'open', ${OWNER}, ${sql.json({})}),
        (${WS}, 'papercup', ${`${OWNER}-both-b`}, 'task', 'open', ${OWNER}, ${sql.json({})})
    `;

    const e = (await fetchPresenceTier1([OWNER])).get(OWNER);
    expect(e).toBeDefined();
    expect(e!.claimedItems).toEqual(['P-201']);
    expect(e!.workItemClaims).toEqual([`${OWNER}-both-a`, `${OWNER}-both-b`]);
    expect(e!.claimCount).toBe(3);
  });

  it('OMITS claimedPlanItemRefs entirely when the owner occupies nothing (no empty-array payload cost)', async (ctx) => {
    if (!ready) {
      ctx.skip();
      return;
    }
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, taken_by, payload)
      VALUES (${WS}, 'papercup', ${`${OWNER}-bare`}, 'task', 'open', ${OWNER}, ${sql.json({})})
    `;
    const e = (await fetchPresenceTier1([OWNER])).get(OWNER);
    // Undefined, not []: `pick` drops undefined, which is what keeps the field off
    // every row of a roster where nobody holds stamped work.
    expect(e!.claimedPlanItemRefs).toBeUndefined();
    expect(e!.workItemClaims).toEqual([`${OWNER}-bare`]);
  });
});
