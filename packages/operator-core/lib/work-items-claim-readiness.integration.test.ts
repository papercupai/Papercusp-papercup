/**
 * work-items-claim-readiness.integration.test.ts — claimNextWorkItem RESPECTS blocking
 * (work-item-deps-and-readiness-2026-06-22 P-005, the F1 split-brain fix).
 *
 * Before P-005 the decentralized claim path (claimNextWorkItem) ignored blocking
 * entirely and could hand out a row with an unsatisfied blocker, while the orchestrator
 * frontier (frontier-readiness.ts) correctly held it back — a split-brain. P-005 adds the
 * SAME readiness AND-clause to the claim SELECT: never self-select a row that has a
 * PRESENT, NON-TERMINAL blocker in work_item_deps (dep_type='blocks').
 *
 * Proves against real Postgres (testcontainer; Docker required):
 *   • a feature with a non-terminal feature blocker is NOT claimed;
 *   • after the blocker → 'passed' (terminal) it IS claimed;
 *   • an ABSENT blocker ref (no matching row) does not block;
 *   • an issue blocker 'open' blocks, but 'resolved' does not (the F2 cross-family terminal).
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/work-items-claim-readiness.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, applyClaimPathReadDeps, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

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
const depsStore = await import('./dbos/work-item-deps-store');
const H = 'papercup';
const WS = 'default'; // == DEFAULT_COORD_WORKSPACE; work_item_deps + engineer_issues live here
let db: FreshPgDb;

async function seedFeature(
  id: string,
  opts: { createdTs?: number; status?: string; takenBy?: string | null } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, created_ts, updated_ts)
    VALUES (${H}, ${id}, 'feature', ${opts.status ?? 'open'}, ${opts.takenBy ?? null}, ${WS}, ${opts.createdTs ?? 0}, 0)`;
}

/** A feature→feature blocks edge (harness-qualified refs, the featureRef convention). */
async function blockByFeature(blockedId: string, blockerId: string) {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, 'feature', ${`${H}#${blockedId}`}, 'feature', ${`${H}#${blockerId}`}, 'blocks')`;
}

/** An issue→feature blocks edge: blocker is a bare 'EI-<n>' issue id (issues:link convention). */
async function blockByIssue(blockedId: string, issueId: string) {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, 'feature', ${`${H}#${blockedId}`}, 'issue', ${issueId}, 'blocks')`;
}

/** An issue blocked by a feature dependency: bare issue target, qualified feature blocker. */
async function blockIssueByFeature(blockedId: string, blockerId: string) {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, 'issue', ${blockedId}, 'feature', ${`${H}#${blockerId}`}, 'blocks')`;
}

// `assignee` (mapped to work_items.taken_by by the engineer_issues view's INSTEAD OF
// trigger) defaults to a placeholder "someone already has it" owner: P-007
// (SCHEDULER_ISSUES_CLAIMABLE, default-ON) additively falls through to self-select an
// unblocked, UNCLAIMED open issue as a work-item in its own right (tier 3 of
// claimNextWorkItem) — an unassigned open blocker seeded here would otherwise be
// claimed BY THIS SAME wi.claimNextWorkItem() call the test is using to probe purely
// the blocking behavior, producing a false "blocks" read. Pass assignee: null explicitly
// for a test that specifically wants an unclaimed issue.
async function seedIssue(id: string, state: string, opts: { assignee?: string | null } = {}) {
  const assignee = opts.assignee === undefined ? 'other-owner' : opts.assignee;
  await db.sql`
    INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, title, state, assignee)
    VALUES (${WS}, ${id}, ${`issue ${id}`}, ${state}, ${assignee})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-claim-readiness');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple()); // claim path LEFT-JOINs the trust list (autoPickableWhereSql)
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple(); // the dep table the P-005 readiness clause reads
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz;
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS assignee_rank integer, ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz,
      ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`).simple();
}, 90_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
});

describe('claimNextWorkItem readiness — feature blocker (P-005, F1)', () => {
  it('does NOT claim a feature with a non-terminal feature blocker', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 100 });
    await seedFeature('F-blocked', { status: 'open', createdTs: 200 });
    await blockByFeature('F-blocked', 'F-blocker');
    // F-blocker is 'wip' (not claimable here — not 'open'); F-blocked is the only 'open'
    // candidate, but its blocker is non-terminal ⇒ nothing should be claimed.
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w1' })).toBeNull();
  });

  it('CLAIMS the blocked feature once the blocker reaches a terminal status', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 100 });
    await seedFeature('F-blocked', { status: 'open', createdTs: 200 });
    await blockByFeature('F-blocked', 'F-blocker');
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w1' })).toBeNull();

    // Blocker satisfied: passed is terminal.
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET status='passed' WHERE feature_id='F-blocker'`;
    const claimed = await wi.claimNextWorkItem({ harness: H, assignee: 'w1' });
    expect(claimed?.id).toBe('F-blocked');
  });

  it('treats deprecated (the other feature-terminal) as satisfying the blocker too', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 100 });
    await seedFeature('F-blocked', { status: 'open', createdTs: 200 });
    await blockByFeature('F-blocked', 'F-blocker');
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET status='deprecated' WHERE feature_id='F-blocker'`;
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))?.id).toBe('F-blocked');
  });

  it('an ABSENT blocker ref (no matching feature row) does NOT block', async () => {
    await seedFeature('F-blocked', { status: 'open', createdTs: 100 });
    // Edge points at a blocker that has no row in the table — an absent blocker never deadlocks.
    await blockByFeature('F-blocked', 'F-ghost');
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))?.id).toBe('F-blocked');
  });
});

describe('claimNextWorkItem readiness — issue blocker (P-005, F2 cross-family terminal)', () => {
  it('an OPEN issue blocker blocks; a RESOLVED one does not', async () => {
    await seedFeature('F-blocked', { status: 'open', createdTs: 100 });
    await seedIssue('EI-1', 'open');
    await blockByIssue('F-blocked', 'EI-1');
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w1' })).toBeNull();

    // Migration 996: only a SETTLED completion (authority committed/validated) satisfies a
    // blocker. A bare completionRef is judged 'proposed' and keeps blocking (next test).
    await wi.setWorkItemState('EI-1', 'resolved', {
      by: 'integration-test', completionRef: 'readiness', completionAuthority: 'committed',
    });
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))?.id).toBe('F-blocked');
  });

  it('a RESOLVED issue blocker with only PROPOSED authority still blocks (migration 996)', async () => {
    await seedFeature('F-blocked', { status: 'open', createdTs: 100 });
    await seedIssue('EI-3', 'open');
    await blockByIssue('F-blocked', 'EI-3');
    const closed = await wi.setWorkItemState('EI-3', 'resolved', { by: 'integration-test', completionRef: 'readiness' });
    // Precondition: the close really landed terminal and was judged under-evidenced; without
    // it a "still blocked" read could just mean the write never happened.
    expect(closed?.completionAuthority).toBe('proposed');
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w1' })).toBeNull();
  });

  it('a CLOSED issue blocker (the other issue-terminal) does not block', async () => {
    await seedFeature('F-blocked', { status: 'open', createdTs: 100 });
    await seedIssue('EI-2', 'closed');
    await blockByIssue('F-blocked', 'EI-2');
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))?.id).toBe('F-blocked');
  });

  it('an ABSENT issue blocker ref (no matching issue row) does not block', async () => {
    await seedFeature('F-blocked', { status: 'open', createdTs: 100 });
    await blockByIssue('F-blocked', 'EI-ghost');
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))?.id).toBe('F-blocked');
  });
});

/**
 * EI-19325959789634791 / D-017 — WRITER↔FLOOR AGREEMENT, not floor behavior.
 *
 * Every test above seeds `work_item_deps` by HAND, via blockByFeature/blockByIssue, which
 * write the correct per-family convention by construction. That is exactly why the whole
 * suite stayed green while the production writer emitted edges that gate nothing: these
 * tests prove the FLOOR honors a well-formed edge, and nothing proved the WRITER produces
 * one. So the bug lived in the gap between two green suites.
 *
 * These tests therefore route through the PRODUCTION writer (`syncWorkItemDepEdges`) and
 * assert on the CLAIM PATH. Do not "simplify" them by seeding the dep directly — that
 * deletes the only thing they test.
 *
 * The defect: `syncWorkItemDepEdges` hardcodes FEATURE_KIND + featureRef() (harness-QUALIFIED)
 * for both endpoints, but the issue-family floor (`depsBlockedExclusionSql`) matches
 * `d.blocked_ref = wi.feature_id` — BARE. So an issue-family item's edge is invisible to the
 * issue floor, and the feature floor never evaluates it (the wir_* sidecar triggers are
 * feature-only). Measured live 2026-08-02: 6 such rows in papercusp, 3 on genuinely-open
 * items with non-terminal blockers, all advertised claimable while blocked.
 */
describe('claimNextWorkItem readiness — edges from the PRODUCTION writer gate ISSUE-family items (EI-19325959789634791)', () => {
  it('an issue-family item whose blocker edge was written by syncWorkItemDepEdges is NOT claimed', async () => {
    await seedIssue('WI-blocker', 'open'); // non-terminal, and assigned so it is not itself claimed
    await seedIssue('WI-blocked', 'open', { assignee: null }); // the only claimable candidate

    // The production write path — NOT a hand-seeded row.
    await depsStore.syncWorkItemDepEdges(H, 'WI-blocked', ['WI-blocker']);

    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w1' })).toBeNull();
  });

  it('and IS claimed once that blocker reaches a terminal state (the fix must not over-gate)', async () => {
    await seedIssue('WI-blocker', 'open');
    await seedIssue('WI-blocked', 'open', { assignee: null });
    await depsStore.syncWorkItemDepEdges(H, 'WI-blocked', ['WI-blocker']);
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'w1' })).toBeNull();

    await wi.setWorkItemState('WI-blocker', 'resolved', { by: 'integration-test', completionRef: 'readiness' });
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))?.id).toBe('WI-blocked');
  });

  it('the edge it wrote is READABLE BY THE FLOOR — kind and ref form both match the target family', async () => {
    await seedIssue('WI-blocker', 'open');
    await seedIssue('WI-blocked', 'open', { assignee: null });
    await depsStore.syncWorkItemDepEdges(H, 'WI-blocked', ['WI-blocker']);

    // The structural statement of the same defect: an issue-family endpoint must carry
    // kind='issue' + a BARE ref. Asserted separately from the claim-path tests above so a
    // failure says WHICH half broke — the row shape, or the gating.
    const [row] = await db.sql<{ blocked_kind: string; blocked_ref: string; blocker_kind: string; blocker_ref: string }[]>`
      SELECT blocked_kind, blocked_ref, blocker_kind, blocker_ref
        FROM harness_shared.work_item_deps
       WHERE dep_type = 'blocks' AND blocked_ref LIKE ${'%WI-blocked'}`;
    expect(row).toMatchObject({
      blocked_kind: 'issue',
      blocked_ref: 'WI-blocked',
      blocker_kind: 'issue',
      blocker_ref: 'WI-blocker',
    });
  });
});

describe('claimNextWorkItem readiness — unblocked work is unaffected', () => {
  it('claims a normal unblocked todo feature exactly as before', async () => {
    await seedFeature('F-free', { status: 'open', createdTs: 100 });
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))?.id).toBe('F-free');
  });

  it('prefers the unblocked item over a blocked older one', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 50 });
    await seedFeature('F-blocked', { status: 'open', createdTs: 100 }); // older, but blocked
    await seedFeature('F-ready', { status: 'open', createdTs: 200 }); // newer, but ready
    await blockByFeature('F-blocked', 'F-blocker');
    // Oldest-first would pick F-blocked, but it's blocked ⇒ the claim skips to F-ready.
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))?.id).toBe('F-ready');
  });
});

describe('readHeldDependencyEscapeContext — fleet critical-path escape (P-006)', () => {
  it('identifies an excluded issue dependency as blocking active work held by that member', async () => {
    await seedIssue('WI-blocker', 'open', { assignee: null });
    await db.sql`UPDATE harness_shared.work_items SET harness_slug = ${H} WHERE feature_id = 'WI-blocker'`;
    await seedFeature('F-held', { status: 'wip', takenBy: 'member-1' });
    await seedFeature('F-other', { status: 'wip', takenBy: 'member-2' });
    await seedFeature('F-done', { status: 'done', takenBy: 'member-1' });
    await blockByIssue('F-held', 'WI-blocker');
    await blockByIssue('F-other', 'WI-blocker');
    await blockByIssue('F-done', 'WI-blocker');

    await expect(wi.readHeldDependencyEscapeContext({
      dependencyId: 'WI-blocker',
      member: 'member-1',
      harness: H,
    })).resolves.toEqual({
      dependencyId: 'WI-blocker',
      dependencyKind: 'issue',
      blockedHeldItems: [{ id: 'F-held', kind: 'feature', harness: H }],
    });
  });

  it('honors the qualified feature ref when the member-held item is issue-family', async () => {
    await seedFeature('F-blocker', { status: 'wip' });
    await seedIssue('WI-held', 'open', { assignee: 'member-1' });
    await db.sql`
      UPDATE harness_shared.work_items
         SET harness_slug = ${H}, item_kind = 'change'
       WHERE feature_id = 'WI-held'`;
    await blockIssueByFeature('WI-held', 'F-blocker');

    await expect(wi.readHeldDependencyEscapeContext({
      dependencyId: 'F-blocker',
      member: 'member-1',
      harness: H,
    })).resolves.toEqual({
      dependencyId: 'F-blocker',
      dependencyKind: 'feature',
      blockedHeldItems: [{ id: 'WI-held', kind: 'change', harness: H }],
    });
  });

  it('returns null after the dependency is terminal (same falsifier as readiness)', async () => {
    await seedIssue('WI-blocker', 'done', { assignee: null });
    await seedFeature('F-held', { status: 'wip', takenBy: 'member-1' });
    await blockByIssue('F-held', 'WI-blocker');
    await expect(wi.readHeldDependencyEscapeContext({
      dependencyId: 'WI-blocker',
      member: 'member-1',
      harness: H,
    })).resolves.toBeNull();
  });

  it('matches held work stored under a stable-name alias of the canonical fleet owner', async () => {
    await seedIssue('WI-blocker', 'open', { assignee: null });
    await db.sql`UPDATE harness_shared.work_items SET harness_slug = ${H} WHERE feature_id = 'WI-blocker'`;
    await seedFeature('F-held', { status: 'wip', takenBy: 'stable-builder' });
    await blockByIssue('F-held', 'WI-blocker');

    await expect(wi.readHeldDependencyEscapeContext({
      dependencyId: 'WI-blocker',
      member: 'su-member',
      memberAliases: ['stable-builder'],
      harness: H,
    })).resolves.toEqual({
      dependencyId: 'WI-blocker',
      dependencyKind: 'issue',
      blockedHeldItems: [{ id: 'F-held', kind: 'feature', harness: H }],
    });
  });
});
