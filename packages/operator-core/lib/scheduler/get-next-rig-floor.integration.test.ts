/**
 * get-next-rig-floor.integration.test.ts — the cross-machine-rig floor is a GLOBAL admission
 * floor across the FEATURE family too, not just the issue family (EI-14806).
 *
 * WI-2796 gave `payload.needs_2_machine_rig:true` items a self-select exclusion so a single-box
 * caller never claims work it cannot run solo — but it was wired ONLY into the issue-family claim
 * path (claimNextIssueWorkItem). A FEATURE-family item can carry the same tag (the live repro:
 * WI-3487, a p2p rig-readiness FEATURE), and the feature-family claim path — getNextWorkItem tiers
 * 1/2 + claimNextWorkItem, both via claimFloorsWhereSql — never read it. So a no-rig caller drawing
 * DEFAULT_CLAIM_SPEC (exactly the just-left-fleet solo population from WI-5276) self-selected an
 * un-runnable rig FEATURE, had to detect + release it, and it bounced between solo agents.
 *
 * This proves the floor now holds on the feature-family path for BOTH claim entry points:
 *   • getNextWorkItem(DEFAULT_CLAIM_SPEC): a no-rig caller SKIPS a needs_2_machine_rig feature and
 *     claims the next non-rig one — even though the rig one is OLDER (age-asc would pick it first,
 *     so it is the FLOOR, not the rank, that excludes it); rigAvailable:true surfaces it normally.
 *   • claimNextWorkItem (work_items:claim_next): same skip/claim, same rigAvailable bypass.
 *   • a rig-ONLY backlog misses honestly (null) for a no-rig caller, and is served once rig is declared.
 *
 * Real Postgres (testcontainer; Docker required), same bootstrap as
 * get-next-floors-admission-lease.integration.test.ts.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/get-next-rig-floor.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  applyClaimPathReadDeps,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
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

const { getNextWorkItem } = await import('./get-next');
const { DEFAULT_CLAIM_SPEC } = await import('./claim-spec');
const { claimNextWorkItem } = await import('../work-items');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

interface SeedOpts {
  createdTs?: number;
  needsRig?: boolean;
}
/** Seed a FEATURE-family row, optionally tagged payload.needs_2_machine_rig. */
async function seedFeature(id: string, opts: SeedOpts = {}) {
  const payload = opts.needsRig ? { needs_2_machine_rig: true } : {};
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id,
       created_ts, updated_ts, origin, payload)
    VALUES (${H}, ${id}, 'feature', 'open', NULL, ${WS},
       ${opts.createdTs ?? 0}, 0, 'local', ${db.sql.json(payload)})`;
}

const BEE = { assignee: 'bee-1' };

beforeAll(async () => {
  db = await createFreshPgDb('sched-rig-floor');
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
// getNextWorkItem(DEFAULT_CLAIM_SPEC) — the exact WI-3487 repro path.
// ────────────────────────────────────────────────────────────────────────────
describe('get_next — cross-machine-rig floor on the FEATURE family (EI-14806)', () => {
  it('a no-rig DEFAULT_CLAIM_SPEC caller SKIPS a needs_2_machine_rig feature and claims the next non-rig one', async () => {
    // The rig feature is OLDER, so DEFAULT_CLAIM_SPEC's age-asc rank would pick it FIRST — proving
    // it is the rig FLOOR, not the rank, that excludes it. rigAvailable omitted = single-box default.
    await seedFeature('F-rig', { needsRig: true, createdTs: 10 });
    await seedFeature('F-plain', { needsRig: false, createdTs: 50 });
    const r = await getNextWorkItem(DEFAULT_CLAIM_SPEC, BEE, { harness: H });
    expect(r?.workItem.id).toBe('F-plain');
  });

  it('the SAME caller CLAIMS the rig feature once it declares rigAvailable:true (the floor lifts)', async () => {
    await seedFeature('F-rig', { needsRig: true, createdTs: 10 });
    await seedFeature('F-plain', { needsRig: false, createdTs: 50 });
    const r = await getNextWorkItem(DEFAULT_CLAIM_SPEC, BEE, { harness: H, rigAvailable: true });
    // rigAvailable lifts the floor; age-asc now picks the older rig feature.
    expect(r?.workItem.id).toBe('F-rig');
  });

  it('a rig-ONLY backlog misses honestly (null) for a no-rig caller — never a claim/release churn', async () => {
    await seedFeature('F-rig', { needsRig: true, createdTs: 10 });
    expect(await getNextWorkItem(DEFAULT_CLAIM_SPEC, BEE, { harness: H })).toBeNull();
  });

  it('a rig-ONLY backlog IS served once rigAvailable:true is declared', async () => {
    await seedFeature('F-rig', { needsRig: true, createdTs: 10 });
    const r = await getNextWorkItem(DEFAULT_CLAIM_SPEC, BEE, { harness: H, rigAvailable: true });
    expect(r?.workItem.id).toBe('F-rig');
  });

  it('a plain feature with NO payload rig tag is always claimable (the floor never over-excludes)', async () => {
    await seedFeature('F-plain', { needsRig: false, createdTs: 10 });
    const r = await getNextWorkItem(DEFAULT_CLAIM_SPEC, BEE, { harness: H });
    expect(r?.workItem.id).toBe('F-plain');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// claimNextWorkItem (work_items:claim_next) — the SAME feature-family floor, other entry point.
// ────────────────────────────────────────────────────────────────────────────
describe('claim_next — cross-machine-rig floor on the FEATURE family (EI-14806)', () => {
  it('a no-rig caller SKIPS a needs_2_machine_rig feature and claims the next non-rig one', async () => {
    await seedFeature('F-rig', { needsRig: true, createdTs: 10 });
    await seedFeature('F-plain', { needsRig: false, createdTs: 50 });
    const claimed = await claimNextWorkItem({ harness: H, assignee: 'bee-cn' });
    expect(claimed?.id).toBe('F-plain');
  });

  it('the SAME caller CLAIMS the rig feature once it declares rigAvailable:true', async () => {
    await seedFeature('F-rig', { needsRig: true, createdTs: 10 });
    const claimed = await claimNextWorkItem({ harness: H, assignee: 'bee-cn', rigAvailable: true });
    expect(claimed?.id).toBe('F-rig');
  });

  it('a rig-ONLY backlog misses honestly (null) for a no-rig caller', async () => {
    await seedFeature('F-rig', { needsRig: true, createdTs: 10 });
    expect(await claimNextWorkItem({ harness: H, assignee: 'bee-cn' })).toBeNull();
  });
});
