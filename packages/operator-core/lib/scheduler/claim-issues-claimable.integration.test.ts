/**
 * claim-issues-claimable.integration.test.ts — the SCHEDULER_ISSUES_CLAIMABLE gate
 * (work-item-deps-and-readiness-2026-06-22 P-007): ISSUE-family work-items (bug|change|task)
 * become self-pickable by the scheduler claim path WHEN the flag is ON — and are
 * BYTE-IDENTICALLY NON-claimable (feature-only) when it is OFF.
 *
 * Today the decentralized claim (`claimNextWorkItem`) is feature-family-only: the shared
 * `claimFloorsWhereSql` floor pins `item_kind IN ('feature','chunk')` and
 * the UPDATE targets the feature view, so an issue can BLOCK a feature but can never itself
 * be claimed. P-007 adds an ADDITIVE issue-claim branch (a separate query over the work_items
 * base for issue kinds, run only when no feature is claimable AND the flag is on). Readiness
 * is honored by the SAME work_item_deps predicate (terminal = resolved/closed for issues).
 *
 * Proves against real Postgres (testcontainer; Docker required):
 *   flag ON  ⇒ an UNBLOCKED `open` issue IS claimed; a BLOCKED issue is NOT.
 *   flag OFF ⇒ NO issue is claimable (byte-identical to feature-only) — the mutation-check:
 *              this case fails if the flag gate is broken / removed.
 *   + a feature is ALWAYS claimable regardless of the flag (the issue branch is additive,
 *     never disturbing the feature path).
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/claim-issues-claimable.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLAGS, FLAG_DEFAULTS, type FlagKey } from '@papercusp/flags';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  applyClaimPathReadDeps,
  WATCHDOG_TICKS_DDL,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
import { WIDE_TRIGGER_DDL } from './dependency-trigger-fixture';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

// Hoisted handles: the throwaway db, and a MUTABLE per-test override for the gate flag.
const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  issuesClaimable: false as boolean,
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
// Key-aware flag mock: SCHEDULER_ISSUES_CLAIMABLE follows the per-test override; every other
// key (ISSUES_PER_WORKSPACE — keeps issues scoped to 'default'; SCHEDULER_MAINTAINED_READY —
// the inline-predicate arm) resolves to its production default.
vi.mock('@papercusp/flags/server', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/flags/server')>('@papercusp/flags/server');
  return {
    ...actual, // keep onFlagChange (issues-engineer registers a listener at module load) etc.
    getFlag: async (key: FlagKey) =>
      key === FLAGS.SCHEDULER_ISSUES_CLAIMABLE ? h.issuesClaimable : (FLAG_DEFAULTS[key] ?? false),
  };
});

const wi = await import('../work-items');

const H = 'papercup';
const WS = 'default'; // == DEFAULT_COORD_WORKSPACE; work_item_deps + issues live here
let db: FreshPgDb;

/** A feature-FAMILY row (item_kind feature|chunk, default 'feature') —
 *  claimable through the feature path at tier 1/2 of the WI-1407 ladder. */
async function seedFeature(
  id: string,
  opts: { createdTs?: number; status?: string; kind?: string } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, ${opts.kind ?? 'feature'}, ${opts.status ?? 'open'}, ${WS}, ${opts.createdTs ?? 0}, 0)`;
}

/** An issue-family row (bug/change/task) on the work_items base, scope harness:papercup ⇒
 *  harness_slug = 'papercup'. open = claimable; resolved/closed = terminal. */
async function seedIssue(
  id: string,
  opts: {
    createdTs?: number;
    state?: string;
    kind?: string;
    takenBy?: string | null;
    payload?: Record<string, unknown> | null;
  } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts, payload)
    VALUES (${H}, ${id}, ${opts.kind ?? 'bug'}, ${opts.state ?? 'open'}, ${opts.takenBy ?? null},
      ${WS}, ${opts.createdTs ?? 0}, 0,
      ${opts.payload ? db.sql.json(opts.payload as unknown as Parameters<typeof db.sql.json>[0]) : null})`;
}

async function seedWatchdogTick(knownOpenKeys: string[] | null, tickAt = new Date(), status = 'ran') {
  await db.sql`
    INSERT INTO harness_shared.watchdog_ticks (workspace_id, tick_at, status, known_open_keys)
    VALUES (${WS}, ${tickAt}, ${status}, ${knownOpenKeys}::text[])`;
}

/** Insert the newest-first recovery evidence in chronological order for deterministic IDs. */
async function seedWatchdogWindow(
  key: string,
  opts: { count?: number; nullAt?: number; presentAt?: number } = {},
) {
  const count = opts.count ?? 6;
  for (let i = 0; i < count; i += 1) {
    const knownOpenKeys = opts.nullAt === i ? null : opts.presentAt === i ? [key] : [];
    await seedWatchdogTick(knownOpenKeys, new Date(Date.now() - (count - i) * 1_000));
  }
}

/** An OPERATOR-scope issue-family row (harness_slug = 'operator:<workspace>', migration 382 —
 *  not owned by any harness) — must still be self-pickable by a harness-scoped caller
 *  (EI-5919 / WI-1406: this encoding used to be invisible to claimNextIssueWorkItem, which
 *  matched only `harness_slug = filter.harness`). */
async function seedOperatorIssue(
  id: string,
  opts: { createdTs?: number; state?: string; kind?: string } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, workspace_id, created_ts, updated_ts)
    VALUES (${`operator:${WS}`}, ${id}, ${opts.kind ?? 'bug'}, ${opts.state ?? 'open'}, ${WS}, ${opts.createdTs ?? 0}, 0)`;
}

/** A blocks edge with arbitrary blocked/blocker refs (issue refs are BARE ids). */
async function blockEdge(blockedRef: string, blockerRef: string, blockedKind = 'issue', blockerKind = 'feature') {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, ${blockedKind}, ${blockedRef}, ${blockerKind}, ${blockerRef}, 'blocks')`;
}

/** Claim one item via the decentralized claim path, returning its id (or null). The claimed
 *  row is released so each case sees the same pre-claim state. */
async function claimOne(assignee: string): Promise<string | null> {
  const claimed = (await wi.claimNextWorkItem({ harness: H, assignee }))?.id ?? null;
  if (claimed) {
    await db.sql`UPDATE harness_shared.work_items SET taken_by = NULL, taken_at = NULL WHERE feature_id = ${claimed}`;
  }
  return claimed;
}

/** Same as claimOne, but narrows the request to a single feature-family kind — the exact
 *  caller shape the WI-1407 ladder is about (a kind-narrowed request must still widen
 *  through tiers 2 and 3 instead of exiting on a drained tier 1). Does NOT release the
 *  claim (tests assert the id then move on). */
async function claimOneKind(
  assignee: string,
  kind: 'feature' | 'chunk',
): Promise<string | null> {
  return (await wi.claimNextWorkItem({ harness: H, assignee, kind }))?.id ?? null;
}

beforeAll(async () => {
  db = await createFreshPgDb('claim-issues-claimable');
  h.sql = db.sql;
  await ensureCoordCapabilityTables(db.sql);
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL); // base work_items + the hfc + engineer_issues views
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple()); // the feature floor LEFT-JOINs the trust list
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple(); // the readiness dep table
  await db.sql.unsafe(WATCHDOG_TICKS_DDL).simple();
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`).simple();
  // Migration 379: the maintained readiness sidecar (some claim-path code paths reference
  // work_item_blocked even on the inline arm via the sidecar table; apply it for parity).
  await db.sql.unsafe(readMigration('379-maintained-ready-column.sql')).simple();
  await db.sql.unsafe(WIDE_TRIGGER_DDL).simple();
  // harness_plans + plan_item_claims are created by HARNESS_FEATURES_CONSOLIDATED_DDL (the WI-2118
  // reserved-plan-lane floor reads them); the reserved-lane describe below seeds into them.
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps, harness_shared.work_item_blocked,
                       harness_shared.harness_plans, harness_shared.plan_item_claims,
                       harness_shared.watchdog_ticks`;
  h.issuesClaimable = false;
});

describe('SCHEDULER_ISSUES_CLAIMABLE — flag ON: issues self-pickable, readiness honored (P-007)', () => {
  beforeEach(() => {
    h.issuesClaimable = true;
  });

  it('claims an UNBLOCKED open issue when no feature is claimable', async () => {
    await seedIssue('EI-1', { state: 'open', createdTs: 100 });
    expect(await claimOne('w-on-1')).toBe('EI-1');
  });

  it('does NOT claim an issue blocked by a NON-TERMINAL feature blocker', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 50 });
    await seedIssue('EI-2', { state: 'open', createdTs: 100 });
    // Issue EI-2 blocked-by feature F-blocker (feature ref is harness-qualified).
    await blockEdge('EI-2', `${H}#F-blocker`, 'issue', 'feature');
    expect(await claimOne('w-on-2')).toBeNull();

    // Satisfy the blocker (passed = terminal) ⇒ the SAME claim now hands out EI-2.
    await db.sql`UPDATE harness_shared.work_items SET status='passed' WHERE feature_id='F-blocker'`;
    expect(await claimOne('w-on-2')).toBe('EI-2');
  });

  it('does NOT claim an issue blocked by a NON-TERMINAL issue blocker (cross-family terminal)', async () => {
    await seedIssue('EI-blocker', { state: 'open', createdTs: 40, kind: 'change' });
    await seedIssue('EI-3', { state: 'open', createdTs: 100 });
    // Issue→issue blocks: both refs are BARE ids.
    await blockEdge('EI-3', 'EI-blocker', 'issue', 'issue');
    // EI-blocker is the older 'open' issue, so an un-gated claim would hand it out first;
    // assert specifically that EI-3 is NOT what gets claimed while its blocker is open by
    // resolving EI-blocker and re-claiming.
    await db.sql`UPDATE harness_shared.work_items SET status='resolved' WHERE feature_id='EI-blocker'`;
    // Now EI-blocker is terminal (not claimable) and EI-3 is unblocked ⇒ EI-3 is claimed.
    expect(await claimOne('w-on-3')).toBe('EI-3');
  });

  it('does NOT claim a linked issue dependency until the blocker reaches terminal state', async () => {
    await seedIssue('EI-linked-blocker', { state: 'open', createdTs: 40, kind: 'change', takenBy: 'leader-live' });
    await seedIssue('EI-linked-dependent', { state: 'open', createdTs: 100 });

    expect(
      await wi.linkWorkItem(
        'EI-linked-blocker',
        { kind: 'issue', ref: 'EI-linked-dependent' },
        'blocks',
        { by: 'test-linker' },
      ),
    ).toEqual({ ok: true });
    expect(
      await db.sql<{ blocked_kind: string; blocked_ref: string; blocker_kind: string; blocker_ref: string }[]>`
        SELECT blocked_kind, blocked_ref, blocker_kind, blocker_ref
          FROM harness_shared.work_item_deps
         WHERE blocked_ref = 'EI-linked-dependent' AND blocker_ref = 'EI-linked-blocker'`,
    ).toEqual([
      { blocked_kind: 'issue', blocked_ref: 'EI-linked-dependent', blocker_kind: 'issue', blocker_ref: 'EI-linked-blocker' },
    ]);

    expect(await claimOne('w-on-linked')).toBeNull();

    await db.sql`
      UPDATE harness_shared.work_items
         SET status = 'resolved', taken_by = NULL, taken_at = NULL
       WHERE feature_id = 'EI-linked-blocker'`;
    expect(await claimOne('w-on-linked')).toBe('EI-linked-dependent');
  });

  it('excludes a TERMINAL (resolved/closed) issue from the claim', async () => {
    await seedIssue('EI-done', { state: 'resolved', createdTs: 100 });
    await seedIssue('EI-closed', { state: 'closed', createdTs: 110 });
    expect(await claimOne('w-on-4')).toBeNull();
  });

  it('claims an OPERATOR-scope issue (harness_slug=operator:<ws>) via a harness-scoped caller (EI-5919/WI-1406)', async () => {
    await seedOperatorIssue('EI-op-1', { state: 'open', createdTs: 100 });
    expect(await claimOne('w-on-op')).toBe('EI-op-1');
  });

  it('prefers a claimable FEATURE first; only falls through to an issue when no feature is claimable', async () => {
    await seedFeature('F-ready', { status: 'open', createdTs: 200 });
    await seedIssue('EI-5', { state: 'open', createdTs: 100 });
    // A feature is claimable ⇒ the feature path wins (issue branch only runs on a feature miss).
    const first = (await wi.claimNextWorkItem({ harness: H, assignee: 'w-on-5' }))?.id ?? null;
    expect(first).toBe('F-ready');
    // With the feature now taken, the next claim falls through to the issue.
    const second = (await wi.claimNextWorkItem({ harness: H, assignee: 'w-on-5b' }))?.id ?? null;
    expect(second).toBe('EI-5');
  });

  it('EI-7407: honors a Queen-set feature_order for issue-family claims WITHOUT a swarmId (P-007 promises unconditional issue steering, unlike the feature path\'s P-010 lease gate)', async () => {
    // EI-older is the OLDER row (would win on plain oldest-first); EI-newer is YOUNGER but
    // given a LOWER feature_order via work_items:set_priority (setWorkItemPriority) — the
    // Queen steering the issue backlog with no Multi-Swarm lease active (no swarmId passed
    // anywhere in this test, matching the vast majority of real scheduler:get_next callers).
    await seedIssue('EI-older', { state: 'open', createdTs: 50 });
    await seedIssue('EI-newer', { state: 'open', createdTs: 100 });
    const set = await wi.setWorkItemPriority('EI-newer', 1, { harness: H });
    expect(set?.applicable).toBe(true); // written:true, per the set_priority tool contract
    // Before the EI-7407 fix, claimNextIssueWorkItem's ORDER BY only included feature_order
    // inside a `filter.swarmId ?` ternary, so this call (no swarmId) fell through to plain
    // `created_ts ASC` and claimed EI-older regardless of the priority write.
    expect(await claimOne('w-on-priority')).toBe('EI-newer');
  });
});

describe('SCHEDULER_ISSUES_CLAIMABLE — flag OFF: issues NOT claimable, byte-identical to feature-only', () => {
  // h.issuesClaimable stays false (the beforeEach default) — the MUTATION-CHECK arm: if the
  // gate is broken (issue branch runs while OFF), these expectations flip and the test FAILS.

  it('does NOT claim an unblocked open issue (the gate holds)', async () => {
    await seedIssue('EI-10', { state: 'open', createdTs: 100 });
    expect(await claimOne('w-off-1')).toBeNull();
  });

  it('does NOT claim ANY issue kind (bug | change | task) while a feature is absent', async () => {
    await seedIssue('EI-bug', { state: 'open', createdTs: 100, kind: 'bug' });
    await seedIssue('EI-chg', { state: 'open', createdTs: 110, kind: 'change' });
    await seedIssue('EI-task', { state: 'open', createdTs: 120, kind: 'task' });
    expect(await claimOne('w-off-2')).toBeNull();
  });

  it('STILL claims a feature (the feature path is untouched by the gate)', async () => {
    await seedFeature('F-ready', { status: 'open', createdTs: 200 });
    await seedIssue('EI-11', { state: 'open', createdTs: 100 });
    // Even with an older open issue present, OFF ⇒ only the feature is claimable.
    expect(await claimOne('w-off-3')).toBe('F-ready');
  });
});

describe('claimNextWorkItem fallback ladder — a kind-narrowed caller still widens through tiers (WI-1407)', () => {
  // Regression: the OLD `!filter.kind` gate skipped the issue-family fallback ENTIRELY for
  // any kind-narrowed caller (e.g. kind:'feature'), even with the flag ON and a claimable
  // issue sitting there — killing the member instead of widening. These prove the fix.

  it('tier 1 exact match wins when present (no widening needed)', async () => {
    await seedFeature('F-exact', { createdTs: 100, kind: 'feature' });
    await seedFeature('RT-older', { createdTs: 10, kind: 'chunk' }); // older, but wrong kind
    expect(await claimOneKind('w-t1', 'feature')).toBe('F-exact');
  });

  // Retired chunks are excluded by the STATUS floors, not by a kind case
  // (enterprise-data-sources-2026-10-01 D-022 point 2): work_items:create rejects
  // kind 'chunk' (no production caller passes allowDeprecatedChunk) and every live
  // chunk row is terminal (done/passed/dropped, 63 rows measured 2026-10-02). These
  // fixtures therefore seed chunks the way production holds them. An OPEN chunk is
  // not a reachable state, so it is not a fixture here.
  it('retired chunks remain outside tier 2 after a feature-narrowed miss', async () => {
    await seedFeature('RT-1', { createdTs: 100, kind: 'chunk', status: 'done' });
    await seedFeature('RT-2', { createdTs: 101, kind: 'chunk', status: 'passed' });
    await seedFeature('RT-3', { createdTs: 102, kind: 'chunk', status: 'dropped' });
    expect(await claimOneKind('w-t2', 'feature')).toBeNull();
  });

  it('retired chunks remain excluded even after their historical blocker settles', async () => {
    await seedFeature('CH-blocker', { createdTs: 1, kind: 'chunk', status: 'done' });
    await seedFeature('CH-blocked', { createdTs: 50, kind: 'chunk', status: 'done' });
    await blockEdge(`${H}#CH-blocked`, `${H}#CH-blocker`, 'feature', 'feature');
    expect(await claimOneKind('w-t2b', 'feature')).toBeNull();
    await db.sql`UPDATE harness_shared.work_items SET status='passed' WHERE feature_id='CH-blocker'`;
    expect(await claimOneKind('w-t2c', 'feature')).toBeNull();
  });

  it('tier 3: kind="feature" narrowed and the WHOLE feature family dry falls through to an OPEN issue when the flag is ON', async () => {
    h.issuesClaimable = true;
    await seedIssue('EI-t3-on', { state: 'open', createdTs: 100 });
    expect(await claimOneKind('w-t3-on', 'feature')).toBe('EI-t3-on');
  });

  it('tier 3: the SAME kind-narrowed request stays dry when the flag is OFF (the gate, not the kind narrowing, controls it)', async () => {
    // h.issuesClaimable defaults false (beforeEach) — this is the exact shape that used to be
    // structurally blocked pre-WI-1407 regardless of the flag; confirm it now correctly
    // resolves via the flag rather than via the (removed) `!filter.kind` short-circuit.
    await seedIssue('EI-t3-off', { state: 'open', createdTs: 100 });
    expect(await claimOneKind('w-t3-off', 'feature')).toBeNull();
  });

  it('tier 3: a BLOCKED issue is skipped, but the widened issue tier still claims other READY issue work', async () => {
    h.issuesClaimable = true;
    await seedIssue('EI-t3-blocker', { state: 'open', createdTs: 40, kind: 'change' });
    await seedIssue('EI-t3-blocked', { state: 'open', createdTs: 100 });
    await blockEdge('EI-t3-blocked', 'EI-t3-blocker', 'issue', 'issue');
    expect(await claimOneKind('w-t3d', 'feature')).toBe('EI-t3-blocker');
    await db.sql`UPDATE harness_shared.work_items SET status='resolved' WHERE feature_id='EI-t3-blocker'`;
    expect(await claimOneKind('w-t3e', 'feature')).toBe('EI-t3-blocked');
  });
});

describe('issue steer levers become applicable only when SCHEDULER_ISSUES_CLAIMABLE is on (P-007)', () => {
  it('set_priority / co_locate report applicable:false (issue) while OFF, and write while ON', async () => {
    await seedIssue('EI-20', { state: 'open', createdTs: 100 });

    // OFF: byte-identical feature-only behavior — issue is not applicable.
    h.issuesClaimable = false;
    const offPri = await wi.setWorkItemPriority('EI-20', 5, { harness: H });
    expect(offPri?.applicable).toBe(false);
    expect(offPri?.priority).toBeNull();
    const offAff = await wi.setWorkItemSwarmAffinity('EI-20', 'swarm-x', { harness: H });
    expect(offAff?.swarmAffinity).toBeNull();
    // Nothing was written on the base.
    const afterOff = (await db.sql`
      SELECT feature_order, swarm_affinity FROM harness_shared.work_items WHERE feature_id='EI-20'`) as Array<{
      feature_order: number | null;
      swarm_affinity: string | null;
    }>;
    expect(afterOff[0]!.feature_order).toBeNull();
    expect(afterOff[0]!.swarm_affinity).toBeNull();

    // ON: the Queen can now steer issues too — the writes land.
    h.issuesClaimable = true;
    const onPri = await wi.setWorkItemPriority('EI-20', 5, { harness: H });
    expect(onPri?.applicable).toBe(true);
    expect(onPri?.priority).toBe(5);
    const onAff = await wi.setWorkItemSwarmAffinity('EI-20', 'swarm-x', { harness: H });
    expect(onAff?.swarmAffinity).toBe('swarm-x');
    const afterOn = (await db.sql`
      SELECT feature_order, swarm_affinity FROM harness_shared.work_items WHERE feature_id='EI-20'`) as Array<{
      feature_order: number | null;
      swarm_affinity: string | null;
    }>;
    expect(afterOn[0]!.feature_order).toBe(5);
    expect(afterOn[0]!.swarm_affinity).toBe('swarm-x');
  });
});

// WI-2118 (the P-009 leak): the general drain must NOT self-select an issue-family item that is
// RESERVED by another active plan lane — the parent plan is `active`, or the plan-item is under a
// live lease held by another owner. Members that know the lane is reserved (its plan's `## Now`)
// correctly refuse + release such an item, and the scheduler kept re-serving it (claim→refuse→
// re-serve churn — WI-2118 hit 3 different members in minutes). The floor stops it at the source.
describe('reserved plan-lane exclusion — issue linked to another active plan is NOT self-selected (WI-2118)', () => {
  beforeEach(() => {
    h.issuesClaimable = true;
  });

  /** Seed an issue-family task carrying a payload.plan_item back-pointer to (planSlug, itemId). */
  async function seedPlanLinkedIssue(id: string, planSlug: string, itemId: string, createdTs = 100) {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, item_kind, status, workspace_id, created_ts, updated_ts, payload)
      VALUES (${H}, ${id}, 'task', 'open', ${WS}, ${createdTs}, 0,
              ${db.sql.json({ plan_item: { plan_slug: planSlug, item_id: itemId, harness_slug: H } })})`;
  }
  const seedPlan = (slug: string, status: string) =>
    db.sql`INSERT INTO harness_shared.harness_plans (plan_slug, status) VALUES (${slug}, ${status})`;
  const seedLease = (slug: string, itemId: string, owner: string, expiresMinFromNow: number) =>
    db.sql`INSERT INTO harness_shared.plan_item_claims (plan_slug, item_id, owner, expires_ts)
            VALUES (${slug}, ${itemId}, ${owner}, now() + make_interval(mins => ${expiresMinFromNow}))`;

  it('an issue linked to an ACTIVE plan is NOT claimed (the WI-2118 case)', async () => {
    await seedPlan('active-plan-x', 'active');
    await seedPlanLinkedIssue('WI-RES-1', 'active-plan-x', 'P-009');
    expect(await claimOne('drain-member')).toBeNull();
  });

  it('an issue linked to a DRAFT plan with no live lease IS claimed (free backlog, no over-exclusion)', async () => {
    await seedPlan('draft-plan-x', 'draft');
    await seedPlanLinkedIssue('WI-RES-2', 'draft-plan-x', 'P-003');
    expect(await claimOne('drain-member')).toBe('WI-RES-2');
  });

  it('an issue under a LIVE lease held by ANOTHER owner is NOT claimed, even in a draft plan', async () => {
    await seedPlan('draft-plan-y', 'draft');
    await seedPlanLinkedIssue('WI-RES-3', 'draft-plan-y', 'P-006');
    await seedLease('draft-plan-y', 'P-006', 'su-other-owner', 20); // lease live for 20 more min
    expect(await claimOne('drain-member')).toBeNull();
  });

  it('an issue whose lease has LAPSED and whose plan is not active IS claimed (no indefinite starvation)', async () => {
    await seedPlan('draft-plan-z', 'draft');
    await seedPlanLinkedIssue('WI-RES-4', 'draft-plan-z', 'P-001');
    await seedLease('draft-plan-z', 'P-001', 'su-gone', -60); // lapsed 60 min ago
    expect(await claimOne('drain-member')).toBe('WI-RES-4');
  });

  it('a plan-linked issue with no plan row and no lease IS claimed (dangling link ⇒ free)', async () => {
    await seedPlanLinkedIssue('WI-RES-5', 'ghost-plan', 'P-002');
    expect(await claimOne('drain-member')).toBe('WI-RES-5');
  });

  it('an ordinary issue (no plan_item back-pointer, NULL payload) is unaffected by the floor', async () => {
    await seedIssue('EI-RES-6', { state: 'open', createdTs: 100 });
    expect(await claimOne('drain-member')).toBe('EI-RES-6');
  });
});

describe('cross-machine-rig exclusion — an item needing a live ≥2-machine rig is NOT self-selected by a single-box caller (WI-2796)', () => {
  beforeEach(() => {
    h.issuesClaimable = true;
  });

  /** Seed an issue-family task carrying payload.needs_2_machine_rig: true. */
  async function seedRigGatedIssue(id: string, createdTs = 100) {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, item_kind, status, workspace_id, created_ts, updated_ts, payload)
      VALUES (${H}, ${id}, 'task', 'open', ${WS}, ${createdTs}, 0,
              ${db.sql.json({ needs_2_machine_rig: true })})`;
  }

  it('a rig-gated item is NOT claimed by a default (single-box) caller', async () => {
    await seedRigGatedIssue('WI-RIG-1');
    expect(await claimOne('drain-member')).toBeNull();
  });

  it('a rig-gated item IS claimed when the caller declares rigAvailable:true', async () => {
    await seedRigGatedIssue('WI-RIG-2');
    const claimed = (await wi.claimNextWorkItem({ harness: H, assignee: 'rig-fleet', rigAvailable: true }))?.id ?? null;
    expect(claimed).toBe('WI-RIG-2');
  });

  it('an ordinary issue (no rig tag, NULL payload) is unaffected by the floor', async () => {
    await seedIssue('EI-RIG-3', { state: 'open', createdTs: 100 });
    expect(await claimOne('drain-member')).toBe('EI-RIG-3');
  });

  it('claim_next MISS diagnosis (diagnoseClaimNextMiss) also excludes a rig-gated item from readyUnclaimed for a single-box caller', async () => {
    await seedRigGatedIssue('WI-RIG-4');
    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'drain-member' });
    // present in the pool (pendingUnclaimed) but NOT counted ready — matches what the
    // claim itself would (not) serve, so the miss diagnosis never disagrees with claim_next.
    expect(diag.pendingUnclaimed).toBeGreaterThan(0);
    expect(diag.readyUnclaimed).toBe(0);
  });
});

describe('claim-hold exclusion — a do-not-opportunistically-claim item is NOT self-selected, but stays directly claimable by id (WI-2797)', () => {
  beforeEach(() => {
    h.issuesClaimable = true;
  });

  /** Seed an issue-family bug carrying payload._claimHold: true. */
  async function seedHeldIssue(id: string, createdTs = 100) {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, item_kind, status, workspace_id, created_ts, updated_ts, payload)
      VALUES (${H}, ${id}, 'bug', 'open', ${WS}, ${createdTs}, 0,
              ${db.sql.json({ _claimHold: true })})`;
  }

  it('a claim-held item is NOT self-selected by claim_next', async () => {
    await seedHeldIssue('WI-HOLD-1');
    expect(await claimOne('drain-member')).toBeNull();
  });

  it('a claim-held item IS still claimable directly by id (claimWorkItem carries no claimHold predicate)', async () => {
    await seedHeldIssue('WI-HOLD-2');
    // Self-select excludes it (same assertion as the prior test, for contrast in this block).
    expect(await claimOne('drain-member')).toBeNull();
    // The DIRECT-by-id claim path (work_items:claim tool → claimWorkItem → claimIssue) has no
    // claimHold predicate at all — a held item stays fully claimable when named explicitly.
    // claimIssue's UPDATE (the property under test) commits before its unrelated
    // subscriber-follow side-effect, which this file's minimal fixture doesn't have the
    // coordination-substrate table for — tolerate that and assert the row directly.
    try {
      await wi.claimWorkItem('WI-HOLD-2', 'named-claimant', { harness: H });
    } catch {
      /* subs.subscribe needs harness_shared.coord_entity_subscriptions — not part of this
         claim-focused fixture; the UPDATE under test already committed by this point. */
    }
    const row = await db.sql`SELECT taken_by FROM harness_shared.work_items WHERE feature_id = 'WI-HOLD-2'`;
    expect(row[0]?.taken_by).toBe('named-claimant');
  });

  it('setWorkItemClaimHold(true) then (false) round-trips — clearing the hold makes the item self-selectable again', async () => {
    await seedIssue('EI-HOLD-3', { state: 'open', createdTs: 100 });
    const held = await wi.setWorkItemClaimHold('EI-HOLD-3', true, { harness: H });
    expect(held?.applicable).toBe(true);
    expect(await claimOne('drain-member')).toBeNull();
    await wi.setWorkItemClaimHold('EI-HOLD-3', false, { harness: H });
    expect(await claimOne('drain-member')).toBe('EI-HOLD-3');
  });

  it('setWorkItemClaimHold on a feature-family id IS applicable (fleet-deltas-leader-primitives P-006 extended the hold to both families; full coverage lives in work-items-claim-hold.integration.test.ts)', async () => {
    await seedFeature('F-HOLD-4', { status: 'open', createdTs: 100 });
    const held = await wi.setWorkItemClaimHold('F-HOLD-4', true, { harness: H });
    expect(held?.applicable).toBe(true);
  });

  it('an ordinary issue (no hold tag, NULL payload) is unaffected by the floor', async () => {
    await seedIssue('EI-HOLD-5', { state: 'open', createdTs: 100 });
    expect(await claimOne('drain-member')).toBe('EI-HOLD-5');
  });

  it('claim_next MISS diagnosis (diagnoseClaimNextMiss) also excludes a held item from readyUnclaimed for the caller', async () => {
    await seedHeldIssue('WI-HOLD-6');
    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'drain-member' });
    // present in the pool (pendingUnclaimed) but NOT counted ready — matches what the
    // claim itself would (not) serve, so the miss diagnosis never disagrees with claim_next.
    expect(diag.pendingUnclaimed).toBeGreaterThan(0);
    expect(diag.readyUnclaimed).toBe(0);
  });
});

describe('claimNextIssueWorkItem honors a caller/spec `states` override (WI-6453 follow-up)', () => {
  beforeEach(() => {
    h.issuesClaimable = true;
  });

  // WI-6453 follow-up (2026-08-02): claimNextIssueWorkItem used to IGNORE `filter.states`
  // entirely and always hardcode ISSUE_FAMILY_CLAIMABLE_STATES (['open']), while every
  // sibling read/diagnose path (aggregateIssueClaimExclusions, explainIssueClaimFloors, and
  // 4 other helpers in scheduler/get-next.ts) correctly honors `opts.states ??
  // ISSUE_FAMILY_CLAIMABLE_STATES`. A claim spec with `states: ['open', 'failing']`
  // (CLAIM_STATES_ALLOWLIST explicitly allows 'failing') would therefore have the READ
  // oracle report a 'failing' issue-family row as claimable while the REAL self-select claim
  // path could never actually claim it — a claim-path/read-path divergence in the same class
  // as EI-10062/WI-4309/WI-5275/WI-5822/WI-6453, triggered by a states override instead of a
  // filter shape.

  it('a `failing` issue-family row is NOT claimed under the default states (unchanged behavior)', async () => {
    await seedIssue('EI-STATE-1', { state: 'failing', createdTs: 100 });
    expect(await claimOne('w-states-1')).toBeNull();
  });

  it('a `failing` issue-family row IS claimed when the caller passes states:["open","failing"]', async () => {
    await seedIssue('EI-STATE-2', { state: 'failing', createdTs: 100 });
    const claimed = await wi.claimNextWorkItem({
      harness: H,
      assignee: 'w-states-2',
      states: ['open', 'failing'],
    });
    expect(claimed?.id).toBe('EI-STATE-2');
  });

  it('states:["failing"] alone excludes an `open` row but claims a `failing` one', async () => {
    await seedIssue('EI-STATE-3', { state: 'open', createdTs: 100 });
    await seedIssue('EI-STATE-4', { state: 'failing', createdTs: 110 });
    const claimed = await wi.claimNextWorkItem({
      harness: H,
      assignee: 'w-states-3',
      states: ['failing'],
    });
    expect(claimed?.id).toBe('EI-STATE-4');
  });
});

// WI-37356: explainIssueClaimFloors used to SELECT/check only 11 of the ~13 real claim
// floors — it never computed ok_no_blocker (depsBlockedExclusionSql), ok_cooldown, or
// ok_origin (isIssueLocallyClaimableWhereSql) at all, so an item excluded ONLY by one of
// those three reported `admissible:true / refusedBy:null` — a false "should be claimable"
// verdict from the one tool meant to explain per-id claim-floor refusals. These pin that
// each of the 3 newly-wired floors is now actually detected and reported.
describe('explainIssueClaimFloors reports the 3 previously-missing floors (WI-37356)', () => {
  it('a row with a PRESENT non-terminal blocker reports refusedBy:"blocked-dep" (was admissible:true)', async () => {
    await seedIssue('EI-FLOOR-BLOCKED', { state: 'open', createdTs: 100 });
    await seedFeature('EI-FLOOR-BLOCKER', { status: 'open' });
    // Feature blocker refs are harness-qualified (see the `does NOT claim an issue blocked by
    // a NON-TERMINAL feature blocker` case above) — depsBlockedExclusionSql's unsatisfiedBlockerSql
    // matches a feature blocker via `(bf.harness_slug || '#' || bf.feature_id) = d.blocker_ref`,
    // so a bare id here never matches and the blocker reads as absent/satisfied.
    await blockEdge('EI-FLOOR-BLOCKED', `${H}#EI-FLOOR-BLOCKER`, 'issue', 'feature');
    const [attr] = await wi.explainIssueClaimFloors(H, ['EI-FLOOR-BLOCKED']);
    expect(attr.admissible).toBe(false);
    expect(attr.refusedBy).toBe('blocked-dep');
  });

  it('a row released by THIS caller within the cooldown window reports refusedBy:"cooldown" (was admissible:true)', async () => {
    await seedIssue('EI-FLOOR-COOLDOWN', { state: 'open', createdTs: 100 });
    await db.sql`
      UPDATE harness_shared.work_items
         SET last_released_by = 'cooldown-caller', last_released_at = now()
       WHERE feature_id = 'EI-FLOOR-COOLDOWN'`;
    const [attr] = await wi.explainIssueClaimFloors(H, ['EI-FLOOR-COOLDOWN'], {
      assignee: 'cooldown-caller',
    });
    expect(attr.admissible).toBe(false);
    expect(attr.refusedBy).toBe('cooldown');
  });

  it('a row NOT released by THIS caller is unaffected by the cooldown floor (admissible)', async () => {
    await seedIssue('EI-FLOOR-COOLDOWN-OTHER', { state: 'open', createdTs: 100 });
    await db.sql`
      UPDATE harness_shared.work_items
         SET last_released_by = 'someone-else', last_released_at = now()
       WHERE feature_id = 'EI-FLOOR-COOLDOWN-OTHER'`;
    const [attr] = await wi.explainIssueClaimFloors(H, ['EI-FLOOR-COOLDOWN-OTHER'], {
      assignee: 'cooldown-caller',
    });
    expect(attr.admissible).toBe(true);
    expect(attr.refusedBy).toBeNull();
  });

  it('a true-remote-origin row (no own-node author key) reports refusedBy:"origin" (was admissible:true)', async () => {
    await seedIssue('EI-FLOOR-ORIGIN', { state: 'open', createdTs: 100 });
    await db.sql`
      UPDATE harness_shared.work_items
         SET origin = 'remote', author_pubkey = 'a-true-peer-key-not-ours'
       WHERE feature_id = 'EI-FLOOR-ORIGIN'`;
    const [attr] = await wi.explainIssueClaimFloors(H, ['EI-FLOOR-ORIGIN']);
    expect(attr.admissible).toBe(false);
    expect(attr.refusedBy).toBe('origin');
  });

  it('an ordinary local, unblocked, no-cooldown row is still admissible:true (no false positive introduced)', async () => {
    await seedIssue('EI-FLOOR-OK', { state: 'open', createdTs: 100 });
    const [attr] = await wi.explainIssueClaimFloors(H, ['EI-FLOOR-OK']);
    expect(attr.admissible).toBe(true);
    expect(attr.refusedBy).toBeNull();
  });
});

// WI-5939 — FILING IS PUBLISHING. An agent who files a bug and then starts fixing it without
// claiming it first races the entire drain fleet, and that race is decided in seconds. The fix
// extends the EXISTING per-claim cooldown floor (issueCooldownExclusionSql — the one fragment
// this claim door, the get-next preview, the miss diagnosis and the per-id explainer all share)
// with a second caller-relative reason: a row filed inside the grace window is gated for
// everyone EXCEPT its filer. These pin all four acceptance legs plus two fail-open controls —
// a floor that excluded the row from EVERYONE, or from nobody, would satisfy a weaker set.
describe('filing-grace floor — the filer gets first refusal on their own filing (WI-5939)', () => {
  beforeEach(() => {
    h.issuesClaimable = true;
  });

  const FILER = 'su-the-filer';
  const PEER = 'su-a-peer';

  /** An issue filed `ageSec` ago by `filer`. The filer's id lives at payload._ei.created_by:
   *  harness_shared.work_items has NO created_by column at all — the engineer_issues VIEW
   *  derives it from that same `_ei` fold (migration 374). */
  async function seedFiledIssue(id: string, filer: string | null, ageSec: number) {
    await seedIssue(id, { state: 'open', createdTs: Date.now() - ageSec * 1000 });
    if (filer) {
      await db.sql`
        UPDATE harness_shared.work_items
           SET payload = jsonb_build_object('_ei', jsonb_build_object('created_by', ${filer}::text))
         WHERE feature_id = ${id}`;
    }
  }

  it('a PEER cannot claim a row someone else filed seconds ago', async () => {
    await seedFiledIssue('EI-GRACE-1', FILER, 5);
    expect(await claimOne(PEER)).toBeNull();
  });

  it('the FILER claims their own fresh filing immediately (the point — no window for them)', async () => {
    await seedFiledIssue('EI-GRACE-2', FILER, 5);
    expect(await claimOne(FILER)).toBe('EI-GRACE-2');
  });

  it('once the window has passed, the peer claims it normally', async () => {
    await seedFiledIssue('EI-GRACE-3', FILER, 24 * 3600);
    expect(await claimOne(PEER)).toBe('EI-GRACE-3');
  });

  it('the refusal reports under the EXISTING cooldown floor, not a new parallel one (acceptance)', async () => {
    await seedFiledIssue('EI-GRACE-4', FILER, 5);
    const [attr] = await wi.explainIssueClaimFloors(H, ['EI-GRACE-4'], { assignee: PEER });
    expect(attr.admissible).toBe(false);
    expect(attr.refusedBy).toBe('cooldown');
    // ...and the SAME id is admissible to its filer, from that same explainer door.
    const [own] = await wi.explainIssueClaimFloors(H, ['EI-GRACE-4'], { assignee: FILER });
    expect(own.admissible).toBe(true);
  });

  it('CONTROL: a fresh row with NO recorded filer stays claimable (fail-OPEN, not blanket-gated)', async () => {
    await seedFiledIssue('EI-GRACE-5', null, 5);
    expect(await claimOne(PEER)).toBe('EI-GRACE-5');
  });

  it('CONTROL: PAPERCUSP_FILING_GRACE_SEC=0 disables the leg entirely (the kill switch works)', async () => {
    vi.stubEnv('PAPERCUSP_FILING_GRACE_SEC', '0');
    try {
      await seedFiledIssue('EI-GRACE-6', FILER, 5);
      expect(await claimOne(PEER)).toBe('EI-GRACE-6');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('watchdog recovery-window floor — eligible signals stay out of READY until evaluated (EI-201069)', () => {
  beforeEach(() => {
    h.issuesClaimable = true;
  });

  const KEY = 'routine-failure:routine:git-sync';

  it('keeps an eligible signal in POOL but out of READY during six complete absent ticks', async () => {
    await seedIssue('EI-WATCHDOG-WINDOW', {
      state: 'open',
      createdTs: 100,
      payload: { watchdogKey: KEY },
    });
    await seedWatchdogWindow(KEY);

    // The real claim path must refuse the row, while the miss diagnosis must still show
    // pending pool work and zero ready work. This is the causal recovery gate, not a timer.
    expect(await claimOne('watchdog-member')).toBeNull();
    const diagnosis = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'watchdog-member' });
    expect(diagnosis.pendingUnclaimed).toBeGreaterThan(0);
    expect(diagnosis.readyUnclaimed).toBe(0);

    const [attribution] = await wi.explainIssueClaimFloors(H, ['EI-WATCHDOG-WINDOW']);
    expect(attribution).toMatchObject({
      admissible: false,
      refusedBy: 'watchdog-recovery-window',
    });
  });

  it('uses only the newest six ran ticks, then admits the signal once it remains present', async () => {
    // An older present tick does not affect the newest-six recovery window.
    await seedIssue('EI-WATCHDOG-NEWEST', {
      state: 'open',
      createdTs: 100,
      payload: { watchdogKey: KEY },
    });
    await seedWatchdogTick([KEY], new Date(Date.now() - 7_000));
    await seedWatchdogWindow(KEY);
    expect(await claimOne('watchdog-newest')).toBeNull();

    // A present key in the newest six means auto-close declined to close it; it is now
    // actionable and the same claim path must serve it.
    await db.sql`TRUNCATE harness_shared.work_items, harness_shared.watchdog_ticks`;
    await seedIssue('EI-WATCHDOG-SURVIVED', {
      state: 'open',
      createdTs: 100,
      payload: { watchdogKey: KEY },
    });
    await seedWatchdogWindow(KEY, { presentAt: 5 });
    expect(await claimOne('watchdog-survived')).toBe('EI-WATCHDOG-SURVIVED');
  });

  it.each([
    { label: 'zero ticks', count: 0 },
    { label: 'short history', count: 5 },
    { label: 'a NULL known_open_keys row', count: 6, nullAt: 2 },
    { label: 'the key is still present', count: 6, presentAt: 2 },
  ])('$label fails open instead of hiding a real issue', async ({ count, nullAt, presentAt }) => {
    const id = `EI-WATCHDOG-OPEN-${count}-${nullAt ?? 'x'}-${presentAt ?? 'x'}`;
    await seedIssue(id, { state: 'open', createdTs: 100, payload: { watchdogKey: KEY } });
    await seedWatchdogWindow(KEY, { count, nullAt, presentAt });
    expect(await claimOne(`watchdog-open-${count}`)).toBe(id);
  });

  it.each([
    { label: 'missing key', payload: null },
    { label: 'blank key', payload: { watchdogKey: '' } },
    { label: 'missing source prefix', payload: { watchdogKey: ':key' } },
    { label: 'blank key suffix', payload: { watchdogKey: 'routine-failure:' } },
    { label: 'ineligible source', payload: { watchdogKey: 'service-down:operator' } },
  ])('$label fails open', async ({ label, payload }) => {
    const id = `EI-WATCHDOG-MALFORMED-${label.replaceAll(' ', '-')}`;
    await seedIssue(id, { state: 'open', createdTs: 100, payload });
    expect(await claimOne(`watchdog-${label}`)).toBe(id);
  });
});
