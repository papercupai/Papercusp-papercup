/**
 * get-next-floors-admission-lease.integration.test.ts — the get_next resolver honors the
 * REMAINING global floors (hybrid-bee-scheduler-work-stealing-2026-06-22, P-003 verification).
 *
 * get-next.integration.test.ts already proves the filter+rank selection, the READINESS/blocking
 * floor, the unclaimed + claimable-status floors, SKIP-LOCKED concurrency, and DEFAULT_CLAIM_SPEC
 * provenance. The floors the sibling does NOT exercise — and the determinism the plan's P-003
 * names explicitly — are filled HERE so the floor set (ready/blocking · lease · admission · dedup)
 * AND record-revision determinism are end-to-end covered:
 *
 *   • ADMISSION floor (G2 / autoPickableWhereSql): a REMOTE, un-admitted item the spec.filter
 *     EXPLICITLY selects is NEVER claimed — and the SAME spec DOES claim it once the auditor
 *     admits it (audit_verdict='admit') or its verified author is trusted. D-002: a spec narrows,
 *     it can never un-floor an un-admitted remote item.
 *   • LEASE floor (per-Hive swarm affinity): under a swarmId, work affined to ANOTHER Swarm is
 *     NEVER claimed even when the spec selects it; work affined to THIS Swarm (or unaffined) is.
 *   • PLAN-ITEM awareness (the spec-side of the dedup floor — D-010 KEEP "plan-item dedup"): a
 *     spec.view.filter on `plan_item` (source_plan_item_ids text[]) NARROWS to the item carrying
 *     a given plan item — the spec vocabulary the Queen authors to keep a bee on ITS plan lane.
 *   • RECORD-REVISION DETERMINISM (D-003/D-006): for a FIXED DAG + spec, repeated get_next calls
 *     select the SAME item in the SAME order and stamp the SAME claimedUnder = specId@revision;
 *     re-steering (a higher revision) is recorded on the next claim. Provenance is deterministic,
 *     not incidental.
 *
 * Real Postgres (testcontainer; Docker required), same bootstrap as get-next.integration.test.ts.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/get-next-floors-admission-lease.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  applyClaimPathReadDeps,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import type { ClaimSpec } from './claim-spec';

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

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

interface SeedOpts {
  createdTs?: number;
  status?: string;
  takenBy?: string | null;
  featureOrder?: number | null;
  tags?: string[];
  origin?: string; // 'local' (default) | 'remote'
  auditVerdict?: string | null; // null | 'admit' | 'quarantine'
  verifiedAuthorGithubUserId?: number | null;
  swarmAffinity?: string | null;
  planItemIds?: string[] | null; // source_plan_item_ids
}
async function seedFeature(id: string, opts: SeedOpts = {}) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id,
       created_ts, updated_ts, feature_order, tags,
       origin, audit_verdict, verified_author_github_user_id, swarm_affinity, source_plan_item_ids)
    VALUES (${H}, ${id}, 'feature', ${opts.status ?? 'open'}, ${opts.takenBy ?? null}, ${WS},
       ${opts.createdTs ?? 0}, 0, ${opts.featureOrder ?? null},
       ${opts.tags ? db.sql.json(opts.tags) : null},
       ${opts.origin ?? 'local'}, ${opts.auditVerdict ?? null},
       ${opts.verifiedAuthorGithubUserId ?? null}, ${opts.swarmAffinity ?? null},
       ${opts.planItemIds ?? null})`;
}

/** Validate a spec or fail loudly — every spec under test must pass the validator. */
function spec(s: ClaimSpec): ClaimSpec {
  const v = validateClaimSpec(s);
  expect(v.ok, `spec invalid: ${v.errors.join('; ')}`).toBe(true);
  return s;
}

/** A spec that selects everything tagged 'lane' and ranks oldest-first (deterministic, total). */
function laneSpec(specId: string, revision: number): ClaimSpec {
  return spec({
    specVersion: '1.0',
    specId,
    revision,
    view: { filter: { field: 'tags', op: 'contains', value: 'lane' } },
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  });
}

const BEE = { assignee: 'bee-1' };

beforeAll(async () => {
  db = await createFreshPgDb('sched-floors-adm-lease');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`).simple();
}, 90_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps, harness_shared.user_trust_list`;
});

// ────────────────────────────────────────────────────────────────────────────
// 1. ADMISSION floor (G2 / autoPickableWhereSql) — a spec can't un-floor a remote item.
// ────────────────────────────────────────────────────────────────────────────
describe('get_next — ADMISSION floor: a remote, un-admitted item is NEVER claimed (D-002)', () => {
  it('NEVER claims a remote + un-audited item even though the spec.filter selects it', async () => {
    // Remote-origin, NO audit verdict ⇒ quarantined by the G2 floor (autoPickableWhereSql).
    await seedFeature('F-remote', { tags: ['lane'], origin: 'remote', auditVerdict: null, createdTs: 100 });
    const s = laneSpec('wants-remote', 1);
    expect(await getNextWorkItem(s, BEE, { harness: H })).toBeNull();
  });

  it("ADMITS the SAME remote item once the auditor sets audit_verdict='admit' (the floor lifts, not the spec)", async () => {
    await seedFeature('F-remote', { tags: ['lane'], origin: 'remote', auditVerdict: null, createdTs: 100 });
    const s = laneSpec('wants-remote', 1);
    expect(await getNextWorkItem(s, BEE, { harness: H })).toBeNull();

    await db.sql`UPDATE harness_shared.harness_features_consolidated SET audit_verdict='admit' WHERE feature_id='F-remote'`;
    const r = await getNextWorkItem(s, BEE, { harness: H });
    expect(r?.workItem.id).toBe('F-remote');
  });

  it('admits a remote item via the TRUST fast-path (verified author in the workspace trust list)', async () => {
    // Remote + un-admitted, but its VERIFIED author (777) is trusted in THIS workspace ⇒ admitted.
    await seedFeature('F-trusted', {
      tags: ['lane'],
      origin: 'remote',
      auditVerdict: null,
      verifiedAuthorGithubUserId: 777,
      createdTs: 100,
    });
    const s = laneSpec('wants-trusted', 1);
    expect(await getNextWorkItem(s, BEE, { harness: H })).toBeNull(); // not yet trusted

    await db.sql`INSERT INTO harness_shared.user_trust_list (workspace_id, trusted_github_user_id) VALUES (${WS}, 777)`;
    const r = await getNextWorkItem(s, BEE, { harness: H });
    expect(r?.workItem.id).toBe('F-trusted');
  });

  it('a LOCAL item is always admission-eligible (origin local bypasses the auditor)', async () => {
    await seedFeature('F-local', { tags: ['lane'], origin: 'local', createdTs: 100 });
    const r = await getNextWorkItem(laneSpec('local-ok', 1), BEE, { harness: H });
    expect(r?.workItem.id).toBe('F-local');
  });

  it('prefers the ADMITTED item over a co-selected remote-unadmitted one (floor narrows the pool, rank picks)', async () => {
    await seedFeature('F-remote', { tags: ['lane'], origin: 'remote', auditVerdict: null, createdTs: 10 }); // oldest, but floored
    await seedFeature('F-local', { tags: ['lane'], origin: 'local', createdTs: 50 }); // newer, but eligible
    const r = await getNextWorkItem(laneSpec('mix', 1), BEE, { harness: H });
    expect(r?.workItem.id).toBe('F-local'); // age asc would pick F-remote, but it's floored out
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. LEASE floor (per-Hive swarm affinity) — a spec can't pull another Swarm's leased work.
// ────────────────────────────────────────────────────────────────────────────
describe('get_next — LEASE floor: under a swarmId, never claim ANOTHER Swarm-affined item', () => {
  it("NEVER claims an item affined to a DIFFERENT swarm even when the spec selects it", async () => {
    await seedFeature('F-theirs', { tags: ['lane'], swarmAffinity: 'swarm-B', createdTs: 100 });
    const s = laneSpec('cross-swarm', 1);
    // This bee runs under swarm-A's lease ⇒ swarm-B work is invisible to it.
    expect(await getNextWorkItem(s, BEE, { harness: H, swarmId: 'swarm-A' })).toBeNull();
  });

  it('CLAIMS an item affined to THIS swarm', async () => {
    await seedFeature('F-mine', { tags: ['lane'], swarmAffinity: 'swarm-A', createdTs: 100 });
    const r = await getNextWorkItem(laneSpec('same-swarm', 1), BEE, { harness: H, swarmId: 'swarm-A' });
    expect(r?.workItem.id).toBe('F-mine');
  });

  it('CLAIMS an UNAFFINED item (null affinity is claimable by any swarm)', async () => {
    await seedFeature('F-free', { tags: ['lane'], swarmAffinity: null, createdTs: 100 });
    const r = await getNextWorkItem(laneSpec('unaffined', 1), BEE, { harness: H, swarmId: 'swarm-A' });
    expect(r?.workItem.id).toBe('F-free');
  });

  it('skips a cross-swarm item for a this-swarm one (the lease floor never starves the local queue)', async () => {
    await seedFeature('F-theirs', { tags: ['lane'], swarmAffinity: 'swarm-B', createdTs: 10 }); // oldest, leased away
    await seedFeature('F-mine', { tags: ['lane'], swarmAffinity: 'swarm-A', createdTs: 50 });
    const r = await getNextWorkItem(laneSpec('lease-skip', 1), BEE, { harness: H, swarmId: 'swarm-A' });
    expect(r?.workItem.id).toBe('F-mine');
  });

  it('WITHOUT a swarmId (single-instance default) affinity is ignored — any item is claimable', async () => {
    await seedFeature('F-theirs', { tags: ['lane'], swarmAffinity: 'swarm-B', createdTs: 100 });
    const r = await getNextWorkItem(laneSpec('no-lease', 1), BEE, { harness: H });
    expect(r?.workItem.id).toBe('F-theirs'); // no lease ⇒ affinity is not a floor
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. PLAN-ITEM awareness — the spec-side of the dedup floor (D-010 KEEP plan-item dedup).
// ────────────────────────────────────────────────────────────────────────────
describe('get_next — a plan_item filter NARROWS to the item carrying that plan item (dedup vocabulary)', () => {
  it('a plan_item `contains` filter selects only the item whose source_plan_item_ids holds it', async () => {
    await seedFeature('F-p1', { tags: ['lane'], planItemIds: ['P-001'], createdTs: 100 });
    await seedFeature('F-p2', { tags: ['lane'], planItemIds: ['P-002'], createdTs: 50 }); // older, filtered out
    const s = spec({
      specVersion: '1.0',
      specId: 'plan-lane',
      revision: 1,
      view: {
        filter: {
          all: [
            { field: 'tags', op: 'contains', value: 'lane' },
            { field: 'plan_item', op: 'contains', value: 'P-001' },
          ],
        },
      },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    const r = await getNextWorkItem(s, BEE, { harness: H });
    expect(r?.workItem.id).toBe('F-p1');
  });

  it('a plan_item `in` filter overlaps the supplied plan-item set', async () => {
    await seedFeature('F-a', { tags: ['lane'], planItemIds: ['P-010', 'P-011'], createdTs: 100 });
    await seedFeature('F-b', { tags: ['lane'], planItemIds: ['P-099'], createdTs: 50 });
    const s = spec({
      specVersion: '1.0',
      specId: 'plan-set',
      revision: 1,
      view: { filter: { field: 'plan_item', op: 'in', value: ['P-010', 'P-020'] } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    const r = await getNextWorkItem(s, BEE, { harness: H });
    expect(r?.workItem.id).toBe('F-a'); // overlaps P-010; F-b (P-099) excluded
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. RECORD-REVISION DETERMINISM (D-003/D-006) — same DAG+spec ⇒ same item, same provenance.
// ────────────────────────────────────────────────────────────────────────────
describe('get_next — deterministic selection + recorded revision provenance', () => {
  it('for a FIXED DAG + spec, repeated claims drain in the SAME total order and stamp the SAME specId@revision', async () => {
    await seedFeature('F-1', { tags: ['lane'], createdTs: 10 });
    await seedFeature('F-2', { tags: ['lane'], createdTs: 20 });
    await seedFeature('F-3', { tags: ['lane'], createdTs: 30 });
    const s = laneSpec('drain', 7);

    // Drain the queue one claim at a time (each claim removes its row from the eligible pool).
    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await getNextWorkItem(s, { assignee: `bee-${i}` }, { harness: H });
      expect(r).not.toBeNull();
      order.push(r!.workItem.id);
      // EVERY claim records the exact spec revision that selected it (deterministic provenance).
      expect(r!.claimedUnder).toEqual({ specId: 'drain', revision: 7 });
    }
    // age asc is a TOTAL order over distinct created_ts ⇒ the drain order is fully determined.
    expect(order).toEqual(['F-1', 'F-2', 'F-3']);
    // Pool now empty ⇒ a 4th claim is null (no nondeterministic extra pick).
    expect(await getNextWorkItem(s, BEE, { harness: H })).toBeNull();
  });

  it('a RE-STEER (higher revision) is recorded on the NEXT claim — provenance tracks the live revision', async () => {
    await seedFeature('F-only', { tags: ['lane'], createdTs: 10 });
    // r3 claims nothing here (we keep the item) — instead seed two items so each revision claims one.
    await seedFeature('F-second', { tags: ['lane'], createdTs: 20 });

    const r3 = await getNextWorkItem(laneSpec('steer', 3), { assignee: 'bee-x' }, { harness: H });
    expect(r3?.workItem.id).toBe('F-only');
    expect(r3?.claimedUnder).toEqual({ specId: 'steer', revision: 3 });

    // The Queen re-steers: same specId, bumped revision. The next claim records the NEW revision.
    const r4 = await getNextWorkItem(laneSpec('steer', 4), { assignee: 'bee-y' }, { harness: H });
    expect(r4?.workItem.id).toBe('F-second');
    expect(r4?.claimedUnder).toEqual({ specId: 'steer', revision: 4 });
  });
});
