/**
 * WI-4413 (DB-backed) — a floored claim-spec tranche must NAME its floors.
 *
 * Regression guard for the live incident that motivated the work (bug-drain-nonp2p, 2026-07-12):
 * a fleet leader fed THREE consecutive claim-spec tranches that every READ surface reported as
 * claimable and `scheduler:get_next` silently refused with a static, floor-blind string. Members
 * idled; three agents independently reverse-engineered the floors by hand from raw payload reads.
 *
 * The unit sibling (get-next-miss-diagnosis.test.ts) pins the pure logic + the anti-drift guard.
 * THIS test owns what only a real database can prove: that `explainIssueClaimFloors` — which
 * evaluates the SAME exported predicates the claim path ANDs in, as boolean columns instead of
 * WHERE clauses — actually attributes the right floor to the right row, for each floor that bit us.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const { explainIssueClaimFloors } = await import('../work-items');
const { previewClaimSpecAdmission } = await import('../agent-tools/scheduler/set_claim_spec');
const { diagnoseFleetScopeTerminalExhaustion } = await import('./fleet-scope-admission');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

/** Seed an ISSUE-family row (bug/change/task) with an arbitrary payload. */
async function seedIssue(id: string, payload: Record<string, unknown> | null, status = 'open') {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id,
       created_ts, updated_ts, title, payload)
    VALUES (${H}, ${id}, 'change', ${status}, NULL, ${WS}, 0, 0, ${'t ' + id},
            ${payload ? db.sql.json(payload) : null})`;
}

/**
 * Seed a plan. The plan-lane floor is deliberately STATE-SENSITIVE, not merely payload-shaped:
 * a `plan_item` back-pointer reserves the row while its ordinary plan is in lifecycle
 * `paused`/`active` or its operation is `started`/`paused` (reservedPlanLaneExclusionSql).
 * An unleased draft or a ready plan with NULL/`done` op_status is a free control. Seeding the plan is therefore part
 * of the contract under test, not scaffolding: it distinguishes "reserved right now" from
 * "stamped".
 */
async function seedPlan(slug: string, status: 'draft' | 'paused' | 'active' | 'ready', opStatus: string | null = null) {
  await db.sql`
    INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, status, op_status)
    VALUES (${WS}, ${H}, ${slug}, ${status}, ${opStatus})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('get-next-miss-diagnosis');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql
    .unsafe(
      `ALTER TABLE harness_shared.work_items
         ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`,
    )
    .simple();
}, 90_000);
afterAll(async () => {
  // EI-10533: guard the teardown. When beforeAll fails (e.g. the SHARED native PG is briefly in
  // recovery mode — it happened while writing this test), `db` is never assigned, and a bare
  // `db.cleanup()` throws a TypeError that MASKS the real error: the run then reports a broken
  // TEST when the truth is broken INFRA. An agent trusting that surfaced error debugs the wrong
  // layer — I nearly did. Never let teardown outshout the actual failure.
  await db?.cleanup?.();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
});

describe('WI-4413 — explainIssueClaimFloors names the floor that actually refused each row', () => {
  it('attributes the correct floor for every row shape a leader tranche can contain', async () => {
    // The control. If a clean row does not read admissible, this test is measuring the wrong
    // thing and every assertion below it is worthless.
    await seedPlan('live-plan', 'active');
    await seedPlan('draft-plan', 'draft');
    await seedPlan('paused-plan', 'paused');
    await seedPlan('ready-plan', 'ready');
    await seedPlan('done-plan', 'ready', 'done');

    await seedIssue('WI-9001', null);
    // The three floors from the live incident:
    await seedIssue('WI-9002', { lane: 'observation', origin: 'checkpoint-harvest' });
    await seedIssue('WI-9003', { plan_item: { plan_slug: 'live-plan', item_id: 'P-001' } });
    await seedIssue('WI-9004', { _claimHold: true, held_open_by: 'su-other', held_open_reason: 'blocked' });
    // Migration 864 retired the ambiguous legacy `needsHuman` floor. Keep a
    // compatibility-shaped row here to prove the diagnosis now admits it.
    await seedIssue('WI-9005', { needsHuman: true });
    await seedIssue('WI-9008', {
      externalBlockers: [
        {
          kind: 'event',
          ref: 'deploy:green',
          status: 'active',
          summary: 'Waiting for the green deploy event',
          createdAt: '2026-07-13T00:00:00.000Z',
          updatedAt: '2026-07-13T00:00:00.000Z',
        },
      ],
    });
    // A terminal row named in a STALE tranche — the other everyday way a leader's spec goes empty.
    await seedIssue('WI-9006', null, 'resolved');
    // Stamped with a plan_item on an ordinary paused plan ⇒ reserved. The lifecycle state is
    // owner-controlled, so a diagnosis that reported this as claimable would be lying in the
    // opposite direction — telling a leader to dispatch work the owner paused.
    await seedIssue('WI-9007', { plan_item: { plan_slug: 'paused-plan', item_id: 'P-002' } });
    await seedIssue('WI-9009', { plan_item: { plan_slug: 'draft-plan', item_id: 'P-003' } });
    // Ready/NULL and ready/done are the anti-over-exclusion controls: neither is reserved.
    await seedIssue('WI-9010', { plan_item: { plan_slug: 'ready-plan', item_id: 'P-004' } });
    await seedIssue('WI-9011', { plan_item: { plan_slug: 'done-plan', item_id: 'P-005' } });

    const out = await explainIssueClaimFloors(H, [
      'WI-9001',
      'WI-9002',
      'WI-9003',
      'WI-9004',
      'WI-9005',
      'WI-9006',
      'WI-9007',
      'WI-9008',
      'WI-9009',
      'WI-9010',
      'WI-9011',
      'WI-9999', // never inserted — a leader typo
    ]);
    const by = new Map(out.map((o) => [o.id, o]));

    expect(by.get('WI-9001')).toMatchObject({ admissible: true, refusedBy: null });
    expect(by.get('WI-9002')).toMatchObject({ admissible: false, refusedBy: 'observation-lane' });
    expect(by.get('WI-9003')).toMatchObject({ admissible: false, refusedBy: 'plan-lane-reserved' });
    expect(by.get('WI-9004')).toMatchObject({ admissible: false, refusedBy: 'claim-hold' });
    expect(by.get('WI-9005')).toMatchObject({ admissible: true, refusedBy: null });
    expect(by.get('WI-9006')).toMatchObject({ admissible: false, refusedBy: 'not-claimable-status' });
    expect(by.get('WI-9007')).toMatchObject({ admissible: false, refusedBy: 'plan-lane-reserved' });
    expect(by.get('WI-9008')).toMatchObject({ admissible: false, refusedBy: 'external-blocker' });
    // EI-21859942410973983: a draft without a live lane lease has no occupant.
    expect(by.get('WI-9009')).toMatchObject({ admissible: true, refusedBy: null });
    expect(by.get('WI-9010')).toMatchObject({ admissible: true, refusedBy: null });
    expect(by.get('WI-9011')).toMatchObject({ admissible: true, refusedBy: null });
    // A typo'd id is the single most likely way to author a dead tranche, and the old static
    // message said nothing about it whatsoever.
    expect(by.get('WI-9999')).toMatchObject({ admissible: false, refusedBy: 'not-found' });

    // A bare slug is only half a diagnosis — every refusal carries an operator-facing detail.
    for (const row of out) {
      if (!row.admissible) expect(row.detail, `${row.id} needs a human-readable detail`).toBeTruthy();
    }
  });

  it('reproduces the incident: a tranche where EVERY named id is floored, by a DIFFERENT floor', async () => {
    await seedPlan('design-simplification', 'active');
    await seedIssue('WI-9101', { lane: 'observation' });
    await seedIssue('WI-9102', { plan_item: { plan_slug: 'design-simplification', item_id: 'P-016' } });
    await seedIssue('WI-9103', { _claimHold: true });

    const out = await explainIssueClaimFloors(H, ['WI-9101', 'WI-9102', 'WI-9103']);

    expect(out.every((o) => !o.admissible)).toBe(true);
    expect(out.map((o) => o.refusedBy).sort()).toEqual(['claim-hold', 'observation-lane', 'plan-lane-reserved']);
    // Three ids, three DISTINCT floors — the leader reading this learns there is no single
    // thing to fix and that the TRANCHE was the mistake. That realisation took me ~1h and
    // three separate member investigations to reach by hand.
    expect(new Set(out.map((o) => o.refusedBy)).size).toBe(3);
  });

  it('preserves caller id order and returns one row per requested id (never a silent drop)', async () => {
    await seedIssue('WI-9201', null);
    const out = await explainIssueClaimFloors(H, ['WI-9999', 'WI-9201', 'WI-9998']);
    expect(out.map((o) => o.id)).toEqual(['WI-9999', 'WI-9201', 'WI-9998']);
  });

  it('an empty id list is a no-op — a broad kind-only spec must not pay for a pointless query', async () => {
    expect(await explainIssueClaimFloors(H, [])).toEqual([]);
  });

  it('uses the caller/spec state floor instead of treating every issue state as admissible', async () => {
    await seedIssue('WI-9301', null, 'open');
    // work-item-status-full-unify: a non-matching claimable token (`failing`) proves the state
    // floor is honored — the open issue is refused by status; `open` (the unified token) admits it.
    const [failingOnly] = await explainIssueClaimFloors(H, ['WI-9301'], { states: ['failing'] });
    const [open] = await explainIssueClaimFloors(H, ['WI-9301'], { states: ['open'] });
    expect(failingOnly).toMatchObject({ admissible: false, refusedBy: 'not-claimable-status' });
    expect(open).toMatchObject({ admissible: true, refusedBy: null });
  });

  it('scope authoring can include its member-held row without changing ordinary acquisition or ownership', async () => {
    await seedIssue('EI-SCOPE-MEMBER', null);
    await seedIssue('EI-SCOPE-FOREIGN', null);
    await db.sql`
      UPDATE harness_shared.work_items SET taken_by = 'su-member'
       WHERE feature_id = 'EI-SCOPE-MEMBER'`;
    await db.sql`
      UPDATE harness_shared.work_items SET taken_by = 'su-foreign'
       WHERE feature_id = 'EI-SCOPE-FOREIGN'`;
    const ids = ['EI-SCOPE-MEMBER', 'EI-SCOPE-FOREIGN'];

    const acquisition = await explainIssueClaimFloors(H, ids);
    expect(acquisition).toEqual([
      expect.objectContaining({ id: ids[0], admissible: false, refusedBy: 'already-taken', heldBy: 'su-member' }),
      expect.objectContaining({ id: ids[1], admissible: false, refusedBy: 'already-taken', heldBy: 'su-foreign' }),
    ]);
    const scope = await explainIssueClaimFloors(H, ids, { scopeHeldBy: ['su-member'] });
    expect(scope).toEqual([
      expect.objectContaining({ id: ids[0], admissible: true, refusedBy: null }),
      expect.objectContaining({ id: ids[1], admissible: false, refusedBy: 'already-taken', heldBy: 'su-foreign' }),
    ]);
    expect(await explainIssueClaimFloors(H, ids)).toEqual(acquisition);
    const preview = await previewClaimSpecAdmission({
      spec: {
        specVersion: '1.0',
        specId: 'held-repair-wave',
        revision: 2,
        view: { filter: { field: 'id', op: 'in', value: [ids[0]] } },
        rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
      },
      harness: H,
      assignee: 'su-leader',
      fleet: 'repair-fleet',
      resolveFamily: async () => 'issue',
      resolveFleetMembers: async () => ['su-member'],
    });
    expect(preview.errors).toEqual([]);
    expect(preview.preview).toMatchObject({
      admissibleIds: [],
      scopeAdmissibleIds: [ids[0]],
      alreadyHeldIds: [ids[0]],
    });
    const owners = await db.sql`
      SELECT feature_id, taken_by FROM harness_shared.work_items
       WHERE feature_id = ANY(${ids}::text[]) ORDER BY feature_id`;
    expect(owners).toEqual([
      { feature_id: 'EI-SCOPE-FOREIGN', taken_by: 'su-foreign' },
      { feature_id: 'EI-SCOPE-MEMBER', taken_by: 'su-member' },
    ]);
  });

  it.each([
    ['observation-lane', { lane: 'observation' }, 'open'],
    ['claim-hold', { _claimHold: true }, 'open'],
    ['not-claimable-status', null, 'resolved'],
  ] as const)('scope authoring does not hide a member-held %s floor', async (refusedBy, payload, status) => {
    await seedIssue('EI-SCOPE-FLOORED', payload, status);
    await db.sql`
      UPDATE harness_shared.work_items SET taken_by = 'su-member'
       WHERE feature_id = 'EI-SCOPE-FLOORED'`;
    const [scope] = await explainIssueClaimFloors(H, ['EI-SCOPE-FLOORED'], { scopeHeldBy: ['su-member'] });
    expect(scope).toMatchObject({ admissible: false, refusedBy });
    expect(scope.heldBy).toBeUndefined();
  });

  it('distinguishes an all-terminal id tranche from a mixed terminal/non-terminal tranche', async () => {
    const makeScope = (ids: string[]) =>
      ({
        ownerId: 'su-member',
        fleetSlug: 'drain-fleet',
        fleetRole: 'member',
        workspaceId: WS,
        record: {
          source: 'fleet',
          revision: 1,
          updatedBy: 'leader',
          updatedAt: 'now',
          spec: {
            specVersion: '1.0',
            specId: 'id-drain',
            revision: 2,
            view: { filter: { field: 'id', op: 'in', value: ids } },
            rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
            states: ['open'],
          },
        },
      }) as never;

    await seedIssue('WI-terminal', null, 'done');
    await expect(
      diagnoseFleetScopeTerminalExhaustion({
        scope: makeScope(['WI-terminal']),
        harness: H,
        workspaceId: WS,
      }),
    ).resolves.toEqual({ matchedByFilter: 1, terminalMatchedByFilter: 1, inFlightMatchedByFilter: 0, parkedMatchedByFilter: 0 });

    // An open, unheld row is pull-claimable: it lands in no never-pullable bucket.
    await seedIssue('WI-active', null, 'open');
    await expect(
      diagnoseFleetScopeTerminalExhaustion({
        scope: makeScope(['WI-terminal', 'WI-active']),
        harness: H,
        workspaceId: WS,
      }),
    ).resolves.toEqual({ matchedByFilter: 2, terminalMatchedByFilter: 1, inFlightMatchedByFilter: 0, parkedMatchedByFilter: 0 });
  });

  it('WI-6554700010010002: counts held and parked matches in disjoint never-pullable buckets', async () => {
    const makeScope = (ids: string[]) =>
      ({
        ownerId: 'su-member',
        fleetSlug: 'drain-fleet',
        fleetRole: 'member',
        workspaceId: WS,
        record: {
          source: 'fleet',
          revision: 1,
          updatedBy: 'leader',
          updatedAt: 'now',
          spec: {
            specVersion: '1.0',
            specId: 'id-drain',
            revision: 3,
            view: { filter: { field: 'id', op: 'in', value: ids } },
            rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
            states: ['open'],
          },
        },
      }) as never;
    const read = (ids: string[]) =>
      diagnoseFleetScopeTerminalExhaustion({ scope: makeScope(ids), harness: H, workspaceId: WS });

    await seedIssue('WI-done', null, 'done');
    await seedIssue('WI-done-held', null, 'done');
    await seedIssue('WI-held-wip', null, 'wip');
    await seedIssue('WI-held-blocked', null, 'blocked');
    await seedIssue('WI-blocked', null, 'blocked');
    await seedIssue('WI-needs-human', null, 'needs-human');
    await seedIssue('WI-orphan-wip', null, 'wip');
    await db.sql`
      UPDATE harness_shared.work_items SET taken_by = 'su-peer'
       WHERE feature_id IN ('WI-done-held', 'WI-held-wip', 'WI-held-blocked')`;

    // The live shape: terminal rows plus one wip row held by a peer. A terminal row whose
    // holder was never cleared counts once, as terminal; a held blocked row counts once, as
    // held. So the buckets sum to matchedByFilter.
    await expect(read(['WI-done', 'WI-done-held', 'WI-held-wip', 'WI-held-blocked'])).resolves.toEqual({
      matchedByFilter: 4, terminalMatchedByFilter: 2, inFlightMatchedByFilter: 2, parkedMatchedByFilter: 0,
    });
    // Unheld blocked and needs-human rows are parked.
    await expect(read(['WI-done', 'WI-blocked', 'WI-needs-human'])).resolves.toEqual({
      matchedByFilter: 3, terminalMatchedByFilter: 1, inFlightMatchedByFilter: 0, parkedMatchedByFilter: 2,
    });
    // An unheld wip row is in none of the buckets, so the sum falls short of matchedByFilter.
    // That keeps the caller's existing zero-match diagnosis instead of certifying a remainder.
    await expect(read(['WI-done', 'WI-held-wip', 'WI-orphan-wip'])).resolves.toEqual({
      matchedByFilter: 3, terminalMatchedByFilter: 1, inFlightMatchedByFilter: 1, parkedMatchedByFilter: 0,
    });
  });
});
