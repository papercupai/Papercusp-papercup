/**
 * claim-next-miss-diagnosis.integration.test.ts — EI-5919.
 *
 * `work_items:claim_next` returned a bare "no claimable work-item" for TWO very different
 * states, so a bee that followed "claim_next null ⇒ queue DRAINED ⇒ idle" idled on a
 * FULL-but-blocked backlog (the EI-5803 "fleet saturated with work still queued" signal).
 * The repro was: 40+ todo items existed, unclaimed, yet claim_next returned null — while a
 * direct `work_items:claim(id)` on one of them SUCCEEDED. That asymmetry is BY DESIGN (a
 * named claim bypasses the status/readiness floors self-select enforces), but the null was
 * indistinguishable from a genuinely drained queue.
 *
 * The fix: `diagnoseClaimNextMiss` (work-items.ts) — run only on a claim MISS — reports
 *   • drained          — true iff there is NO unclaimed claimable-status work at all.
 *   • pendingUnclaimed — the admissible unclaimed POOL (before readiness/affinity/redundancy).
 *   • readyUnclaimed   — of that pool, how many pass ALL claim_next floors.
 *
 * This test proves the three cases + the core asymmetry: an item claim_next refuses (blocked)
 * is reported drained:false / pendingUnclaimed:1, AND is directly claimable by id — exactly
 * the EI-5919 divergence, now diagnosable instead of silently idling.
 *
 * Real Postgres (testcontainer; Docker required).
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/claim-next-miss-diagnosis.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  applyClaimPathReadDeps,
  WORK_ITEM_DEPS_DDL,
} from '../test/_work-items-schema';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('./work-items');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

async function seedFeature(id: string, opts: { status?: string; takenBy?: string | null; createdTs?: number } = {}) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'feature', ${opts.status ?? 'open'}, ${opts.takenBy ?? null}, ${WS},
       ${opts.createdTs ?? 0}, 0)`;
}

/** A feature→feature blocks edge (harness-qualified refs, the featureRef convention). */
async function blockByFeature(blockedId: string, blockerId: string) {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, 'feature', ${`${H}#${blockedId}`}, 'feature', ${`${H}#${blockerId}`}, 'blocks')`;
}

/** An issue-family (bug/change/task) row in the work_items BASE — the issue tier of the
 *  claim ladder (EI-6062). */
async function seedIssue(
  id: string,
  opts: { status?: string; takenBy?: string | null; createdTs?: number } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'bug', ${opts.status ?? 'open'}, ${opts.takenBy ?? null}, ${WS},
       ${opts.createdTs ?? 0}, 0)`;
}

/** An issue→feature blocks edge: the issue's blocked_ref is its BARE id (issues:link
 *  convention), the blocker is a harness-qualified feature ref. */
async function blockIssueByFeature(issueId: string, blockerId: string) {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, 'bug', ${issueId}, 'feature', ${`${H}#${blockerId}`}, 'blocks')`;
}

beforeAll(async () => {
  db = await createFreshPgDb('claim-next-miss-diagnosis');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
  // Pin the INLINE readiness path (the reversible default) so the diagnosis is deterministic
  // without the maintained sidecar table.
  setFlagOverridesForTest({ [FLAGS.SCHEDULER_MAINTAINED_READY]: false });
});
afterEach(() => setFlagOverridesForTest({}));

describe('claim_next miss diagnosis — drained vs present-but-unclaimable (EI-5919)', () => {
  it('DRAINED: empty queue ⇒ drained:true, pendingUnclaimed:0', async () => {
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w1' })).toBeNull();
    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'w1' });
    expect(diag).toEqual({ drained: true, pendingUnclaimed: 0, readyUnclaimed: 0, flagReadError: null });
  });

  it('PRESENT-but-BLOCKED: claim_next misses, but the item exists and is DIRECTLY claimable — the EI-5919 divergence', async () => {
    // The only unclaimed todo is blocked by a non-terminal feature. claim_next (readiness
    // floor) refuses it; a direct claim(id) (named-assignment exception) takes it.
    await seedFeature('F-blocker', { status: 'wip', createdTs: 100 });
    await seedFeature('F-blocked', { status: 'open', createdTs: 200 });
    await blockByFeature('F-blocked', 'F-blocker');

    // claim_next hands out nothing (the blocked item is not self-selectable).
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w1' })).toBeNull();

    // The diagnosis says: NOT drained — 1 unclaimed item exists in the pool, 0 ready.
    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'w1' });
    expect(diag.drained).toBe(false);
    expect(diag.pendingUnclaimed).toBe(1);
    expect(diag.readyUnclaimed).toBe(0);

    // …and the SAME item is directly claimable by id (the divergence the bug reported).
    const claimed = await wi.claimWorkItem('F-blocked', 'w1', { harness: H });
    expect(claimed?.id).toBe('F-blocked');
  });

  it('READY-BUT-RACED: an unblocked item that a peer already took ⇒ drained:false, pendingUnclaimed:0 after it is claimed; drained flips true when the pool empties', async () => {
    await seedFeature('F-ready', { status: 'open', createdTs: 100 });

    // Before any claim: it is both pending and ready.
    const before = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'w1' });
    expect(before).toEqual({ drained: false, pendingUnclaimed: 1, readyUnclaimed: 1, flagReadError: null });

    // A peer self-selects it (claim_next succeeds — control that the happy path still works).
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'peer' });
    expect(got?.id).toBe('F-ready');

    // Now the queue is genuinely drained: the only item is claimed.
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w1' })).toBeNull();
    const after = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'w1' });
    expect(after).toEqual({ drained: true, pendingUnclaimed: 0, readyUnclaimed: 0, flagReadError: null });
  });

  it('BLOCKER GOES TERMINAL: the pending item becomes ready ⇒ readyUnclaimed rises and claim_next then serves it', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 100 });
    await seedFeature('F-blocked', { status: 'open', createdTs: 200 });
    await blockByFeature('F-blocked', 'F-blocker');

    // Blocked: present but not ready.
    let diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'w1' });
    expect(diag).toEqual({ drained: false, pendingUnclaimed: 1, readyUnclaimed: 0, flagReadError: null });

    // Flip the blocker terminal ⇒ readiness satisfied.
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET status = 'passed' WHERE feature_id = 'F-blocker'`;
    diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'w1' });
    expect(diag).toEqual({ drained: false, pendingUnclaimed: 1, readyUnclaimed: 1, flagReadError: null });

    // claim_next now serves the newly-ready item.
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'w1' });
    expect(got?.id).toBe('F-blocked');
  });
});

/**
 * EI-6062 — `diagnoseClaimNextMiss` undercounted the ISSUE-family backlog: it only read
 * the FEATURE pool. The `pendingUnclaimed` half was later patched to fold in the issue POOL,
 * but `readyUnclaimed` STILL read only the feature-family floor (harness_features_consolidated),
 * so an issue-only backlog that was READY (unblocked) reported readyUnclaimed:0 while
 * pendingUnclaimed>0 — the "genuinely blocked/gated, don't hot-retry" verdict — even though
 * claim_next's issue tier would have served it (a lost-lease/race that SHOULD retry). Both
 * halves must now count the issue family, mirroring claimNextIssueWorkItem's floors.
 */
describe('claim_next miss diagnosis — issue-family backlog (EI-6062)', () => {
  const enableIssues = () =>
    setFlagOverridesForTest({
      [FLAGS.SCHEDULER_MAINTAINED_READY]: false,
      [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
    });

  it('ISSUE-ONLY READY backlog is counted in BOTH pendingUnclaimed AND readyUnclaimed — not just the feature pool', async () => {
    enableIssues();
    // No features at all — an unclaimed, unblocked `open` bug is the whole backlog.
    await seedIssue('EI-ready', { status: 'open', createdTs: 100 });
    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'w1' });
    // The regression: before the fix readyUnclaimed read only the feature pool ⇒ 0 here,
    // misreporting a claimable issue as "genuinely blocked/gated". It must be 1.
    expect(diag).toEqual({ drained: false, pendingUnclaimed: 1, readyUnclaimed: 1, flagReadError: null });
  });

  it('ISSUE-ONLY BLOCKED backlog: pending counts it, ready does NOT until the blocker goes terminal', async () => {
    enableIssues();
    await seedFeature('F-blocker', { status: 'wip', createdTs: 100 });
    await seedIssue('EI-blocked', { status: 'open', createdTs: 200 });
    await blockIssueByFeature('EI-blocked', 'F-blocker');

    // Present in the pool, but the non-terminal feature blocker keeps it out of the ready set.
    let diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'w1' });
    expect(diag).toEqual({ drained: false, pendingUnclaimed: 1, readyUnclaimed: 0, flagReadError: null });

    // Flip the blocker terminal ⇒ the issue's readiness is satisfied and it joins readyUnclaimed.
    await db.sql`UPDATE harness_shared.work_items SET status = 'passed' WHERE feature_id = 'F-blocker'`;
    diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'w1' });
    expect(diag).toEqual({ drained: false, pendingUnclaimed: 1, readyUnclaimed: 1, flagReadError: null });
  });

  it('gate OFF ⇒ issue backlog is invisible to the diagnosis (byte-identical feature-only behavior)', async () => {
    // Explicitly pin SCHEDULER_ISSUES_CLAIMABLE off (it defaults ON) so the issue tier is inert.
    setFlagOverridesForTest({
      [FLAGS.SCHEDULER_MAINTAINED_READY]: false,
      [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: false,
    });
    await seedIssue('EI-ready', { status: 'open', createdTs: 100 });
    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'w1' });
    expect(diag).toEqual({ drained: true, pendingUnclaimed: 0, readyUnclaimed: 0, flagReadError: null });
  });
});

/**
 * EI-19370051676057812 — the `states` override must reach the ISSUE legs, not just the feature ones.
 *
 * Both issue counts used to hardcode ISSUE_FAMILY_CLAIMABLE_STATES while the feature legs read
 * `filter.states ?? ['open']`, so a caller's `states` was honored for one family and silently
 * dropped for the other, blended into one drained/pending/ready verdict with no error. That made
 * this DIAGNOSTIC disagree with the claim path it exists to explain (claimNextIssueWorkItem and
 * explainIssueClaimFloors both honor the override), so a state-specific miss was diagnosed against
 * a pool the claim would never serve.
 *
 * This guard is the falsifiable half: an inert `states` argument CANNOT satisfy both legs below,
 * because they demand opposite answers about the SAME row. Pre-fix the override leg read 0.
 * The 14 call sites that used to pass a long-retired `states: ['todo']` were only green because
 * the argument did nothing — they now omit it and exercise the real default pool.
 */
describe('diagnoseClaimNextMiss honors an explicit `states` override on the ISSUE legs (EI-19370051676057812)', () => {
  it('an issue in a NON-default claimable state is counted ONLY when `states` names it', async () => {
    setFlagOverridesForTest({
      [FLAGS.SCHEDULER_MAINTAINED_READY]: false,
      [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
    });
    // 'failing' is claimable-eligible (CLAIM_STATES_ALLOWLIST) but is NOT the issue-family
    // default (ISSUE_FAMILY_CLAIMABLE_STATES === ['open']) — the one shape that can tell an
    // honored override apart from an ignored one.
    await seedIssue('EI-failing', { status: 'failing', createdTs: 100 });

    // Default states must NOT see it...
    const dflt = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'w1' });
    expect(dflt.pendingUnclaimed).toBe(0);

    // ...and naming it explicitly MUST. This is the assertion that was unsatisfiable
    // while the issue legs hardcoded their states.
    const override = await wi.diagnoseClaimNextMiss({
      harness: H,
      assignee: 'w1',
      states: ['failing'],
    });
    expect(override.pendingUnclaimed).toBe(1);
  });
});
