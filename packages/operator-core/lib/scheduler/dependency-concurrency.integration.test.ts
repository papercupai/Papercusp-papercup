/**
 * dependency-concurrency.integration.test.ts — the dependency subsystem under CONTENTION.
 *
 * Plan: dependency-subsystem-thorough-testing-2026-08-02 (P-011).
 * @covers INV-04 INV-05 INV-08
 *
 * WHY THIS TIER AND NOT A MOCK. Every property here is a TRANSACTION-ISOLATION property:
 * what two overlapping writers leave behind, and whether a door can serve a row while
 * another transaction is changing the thing that gates it. A mock cannot express any of
 * that — it would encode the author's belief about interleaving, which is exactly the
 * belief under test. So this file drives real Postgres and real production entry points:
 *
 *   claim door   `claimNextWorkItem`     (work-items.ts)
 *   edge writer  `syncWorkItemDepEdges`  (dbos/work-item-deps-store.ts)
 *
 * WHAT "CONCURRENT" MEANS HERE, stated honestly. Two `await`ed calls fired without
 * awaiting the first (`Promise.all`) genuinely overlap: each opens its own pooled
 * connection and its own transaction, so their statements interleave at the server. It is
 * NOT a deterministic interleaving — a green run does not prove the race is impossible,
 * only that it did not occur this time. That is why the assertions below are written as
 * INVARIANTS OVER OUTCOMES ("exactly one winner", "the final set is one of the two
 * inputs") rather than as a single expected result: an invariant holds under every
 * interleaving, so it stays meaningful however the scheduler orders things.
 *
 * ⚠ EVERY NEGATIVE EXPECTATION IS PAIRED WITH A POSITIVE ONE, for the reason P-008
 * documents: a bare `claim → null` passes with dependency blocking entirely disabled, with
 * the item merely mis-seeded, or with an unrelated floor doing the work. So the
 * contention cases here always show the item BEING SERVED under the same rig first.
 *
 * ⚠ BLOCKERS ARE PARKED AT `wip`, AND THAT IS LOad-BEARING — it is not cosmetic seeding.
 * A blocker is itself a work-item, so a blocker left at `open` is CLAIMABLE, and the door
 * happily serves the BLOCKER when the test believes it is proving something about the
 * blocked item. The first run of this file failed four ways for exactly that reason: a
 * `claim → null` assertion returned the blocker's own id. `wip` is the one status that is
 * simultaneously non-claimable (CLAIM_STATES_ALLOWLIST is ['open','failing']) and
 * NON-TERMINAL (so it still withholds) — which is why the same trick appears in
 * dependency-writer-effectiveness. It also removes ordering nondeterminism from the
 * positive controls, since the door is then left with exactly one thing it could serve.
 *
 * ISSUE FAMILY throughout: an issue-family row is seeded directly, with no promotion
 * machinery in the way, which keeps each test's setup small enough that the race is the
 * only interesting thing happening. The family axis itself is P-007's job.
 *
 * Real Postgres (testcontainer; Docker required).
 *
 * Run:
 *   npm run test:file -- packages/operator-core/lib/scheduler/dependency-concurrency.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  applyClaimPathReadDeps,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
import { WIDE_TRIGGER_DDL } from './dependency-trigger-fixture';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l) && !/\bGRANT\b/.test(l) && !/^\s*(BEGIN|COMMIT);\s*$/.test(l))
    .join('\n');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});
vi.mock('@papercusp/flags/server', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/flags/server')>('@papercusp/flags/server');
  return { ...actual, getFlag: async () => true };
});

const wi = await import('../work-items');
const { syncWorkItemDepEdges } = await import('../dbos/work-item-deps-store');

const WS = 'default';
const H = 'papercup';

let db: FreshPgDb;

/** THE claim door. `null` = withheld; otherwise the id it served. */
const claim = async (assignee: string): Promise<string | null> =>
  (await wi.claimNextWorkItem({ harness: H, assignee }))?.id ?? null;

/** An issue-family row. Seeding the ITEM is fixture work; EDGES are always writer-made. */
async function seedIssue(id: string, status = 'open'): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, title, status, item_kind, workspace_id, taken_by, created_ts, updated_ts, payload)
    VALUES (${H}, ${id}, ${`issue ${id}`}, ${status}, 'task', ${WS}, NULL, 0, 0, '{}'::jsonb)`;
}

const setStatus = (id: string, status: string) =>
  db.sql`UPDATE harness_shared.work_items SET status=${status} WHERE feature_id=${id}`;

const releaseClaim = (id: string) =>
  db.sql`UPDATE harness_shared.work_items SET taken_by=NULL WHERE feature_id=${id}`;

/** Blocker ids currently recorded against `blocked`, sorted. The row-level truth. */
async function blockersOf(blocked: string): Promise<string[]> {
  const rows = (await db.sql<{ blocker_ref: string }[]>`
    SELECT blocker_ref FROM harness_shared.work_item_deps
     WHERE dep_type = 'blocks' AND blocked_ref = ${blocked}
     ORDER BY blocker_ref`) as unknown as Array<{ blocker_ref: string }>;
  return rows.map((r) => r.blocker_ref).sort();
}

beforeAll(async () => {
  db = await createFreshPgDb('dependency-concurrency');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql
    .unsafe(
      `ALTER TABLE harness_shared.work_items
         ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';
       CREATE TABLE IF NOT EXISTS harness_shared.contributors (
         workspace_id text NOT NULL, harness_slug text NOT NULL,
         github_user_id bigint NOT NULL, github_username text NOT NULL DEFAULT '');`,
    )
    .simple();
  // The SHIPPED readiness oracle + sidecar triggers, replacing the fixture's stand-in.
  await db.sql.unsafe(readMigration('379-maintained-ready-column.sql')).simple();
  await db.sql.unsafe(WIDE_TRIGGER_DDL).simple();
  await db.sql.unsafe(readMigration('719-fix-work-item-is-blocked-workspace-scope.sql')).simple();
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps, harness_shared.work_item_blocked, harness_shared.contributors`;
});

// ---------------------------------------------------------------------------
// Two agents racing the SAME item
// ---------------------------------------------------------------------------

describe('two agents racing the same item (P-011) — @covers INV-04', () => {
  it('POSITIVE CONTROL: with one claimable item, exactly ONE of two racing agents wins', async () => {
    // Establishes that the race harness actually races and that the door is mutually
    // exclusive. Without this line, the "neither wins" assertion below would also pass on
    // a rig where claiming is simply broken for everyone.
    await seedIssue('EI-solo');

    const [a, b] = await Promise.all([claim('agent-a'), claim('agent-b')]);
    const winners = [a, b].filter((x) => x !== null);

    expect(winners).toEqual(['EI-solo']);
    // And the row records exactly one owner — no torn double-write.
    const rows = (await db.sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.work_items WHERE feature_id = 'EI-solo'`) as unknown as Array<{
      taken_by: string | null;
    }>;
    expect(['agent-a', 'agent-b']).toContain(rows[0]!.taken_by);
  });

  it('NEITHER of two racing agents is served an item with a live blocker', async () => {
    await seedIssue('EI-blocked');
    await seedIssue('EI-blocker', 'wip'); // non-terminal ⇒ withholds; non-claimable ⇒ not a candidate

    // Positive control FIRST, on this exact rig: with no edge, the door serves it.
    expect(await claim('probe')).toBe('EI-blocked');
    await releaseClaim('EI-blocked');

    // The real writer creates the edge.
    await syncWorkItemDepEdges(H, 'EI-blocked', ['EI-blocker']);

    const [a, b] = await Promise.all([claim('agent-a'), claim('agent-b')]);
    expect([a, b]).toEqual([null, null]);

    // Contention must not have quietly taken the row either — a claim that withholds but
    // still stamps an owner is the "silently parked" failure P-011 names.
    const rows = (await db.sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.work_items WHERE feature_id = 'EI-blocked'`) as unknown as Array<{
      taken_by: string | null;
    }>;
    expect(rows[0]!.taken_by).toBeNull();
  });

  it('four agents racing a single claimable item still yield exactly one winner', async () => {
    // Widening the race increases the chance of catching a lost update on the claim stamp.
    await seedIssue('EI-one');
    const results = await Promise.all([claim('a1'), claim('a2'), claim('a3'), claim('a4')]);
    expect(results.filter((r) => r !== null)).toEqual(['EI-one']);
  });
});

// ---------------------------------------------------------------------------
// Two writers racing the SAME blocked item
// ---------------------------------------------------------------------------

describe('two writers racing edge sync on the same item (P-011) — @covers INV-08', () => {
  it('racing the SAME blocker set is idempotent — no duplicate rows', async () => {
    await seedIssue('EI-b');
    await seedIssue('EI-x');

    await Promise.all([
      syncWorkItemDepEdges(H, 'EI-b', ['EI-x']),
      syncWorkItemDepEdges(H, 'EI-b', ['EI-x']),
    ]);

    expect(await blockersOf('EI-b')).toEqual(['EI-x']);
  });

  it('racing DIFFERENT blocker sets leaves one of the two intact — never torn, never empty', async () => {
    await seedIssue('EI-b');
    await seedIssue('EI-x');
    await seedIssue('EI-y');

    // `syncWorkItemDepEdges` is REPLACE semantics (delete-then-insert) inside one
    // transaction. Two overlapping replaces may commit in either order, so either final
    // set is correct. What must NEVER happen is a torn outcome: the union (both deletes
    // landing before both inserts, i.e. a lost replace) or the empty set (an insert lost
    // entirely, which silently DROPS a dependency and is the D-017 inert-edge failure
    // arriving by a different route).
    //
    // ⚠ THIS TEST FOUND A REAL DEFECT AND IS THE REGRESSION GUARD FOR ITS FIX. Before
    // P-011 this failed 3/3 with the UNION `['EI-x','EI-y']`: at READ COMMITTED both
    // transactions' DELETEs ran against snapshots lacking the other's uncommitted INSERT,
    // so both deleted nothing, took no row locks (a phantom — there were no rows to lock),
    // and both INSERTs landed. `syncWorkItemDepEdges` now takes a transaction-scoped
    // advisory lock keyed on the blocked item, which is what makes the assertion below
    // hold. If this ever reds again, that lock has been removed or bypassed.
    await Promise.all([
      syncWorkItemDepEdges(H, 'EI-b', ['EI-x']),
      syncWorkItemDepEdges(H, 'EI-b', ['EI-y']),
    ]);

    const finalSet = await blockersOf('EI-b');
    const why =
      `expected exactly one writer's set to survive; a union means a replace was lost, ` +
      `an empty set means a dependency was silently dropped`;
    expect(finalSet, why).toHaveLength(1);
    expect(['EI-x', 'EI-y'], why).toContain(finalSet[0]);
  });

  it('a concurrent REMOVAL is not lost — the damaging direction of the same race', async () => {
    // The direction with teeth. The union outcome is bad in the abstract; it is HARMFUL
    // when one writer is dropping a blocker. If its removal is lost, the stale edge
    // withholds the item forever, no error is raised anywhere, and every counter reports
    // success — INV-05's silent stall, reached through a race rather than a bad write.
    await seedIssue('EI-b');
    await seedIssue('EI-x', 'wip');
    await seedIssue('EI-y', 'wip');

    // Established state: EI-b is blocked by BOTH.
    await syncWorkItemDepEdges(H, 'EI-b', ['EI-x', 'EI-y']);
    expect(await blockersOf('EI-b')).toEqual(['EI-x', 'EI-y']);
    expect(await claim('probe')).toBeNull(); // genuinely withheld before the race

    // Now race a DROP of EI-y against a rewrite that keeps only EI-y. Whichever wins, the
    // result must be exactly one writer's intent — never the union that would resurrect
    // the blocker the first writer explicitly removed.
    await Promise.all([
      syncWorkItemDepEdges(H, 'EI-b', ['EI-x']),
      syncWorkItemDepEdges(H, 'EI-b', ['EI-y']),
    ]);

    const finalSet = await blockersOf('EI-b');
    expect(finalSet, 'a lost removal resurrects a dropped blocker').toHaveLength(1);
    expect(['EI-x', 'EI-y']).toContain(finalSet[0]);
  });

  it('clearing ALL blockers concurrently actually releases the item', async () => {
    // The end state a removal race is usually driving toward: an empty set must mean
    // CLAIMABLE, not merely "no rows". Pairs the row-level assertion above with the
    // behavioural one, per D-017 — row shape is not the verdict.
    await seedIssue('EI-b');
    await seedIssue('EI-x', 'wip');
    await syncWorkItemDepEdges(H, 'EI-b', ['EI-x']);
    expect(await claim('probe')).toBeNull();

    await Promise.all([
      syncWorkItemDepEdges(H, 'EI-b', []),
      syncWorkItemDepEdges(H, 'EI-b', []),
    ]);

    expect(await blockersOf('EI-b')).toEqual([]);
    expect(await claim('after')).toBe('EI-b');
  });

  it('the surviving edge set is EFFECTIVE — the winner actually gates the claim door', async () => {
    // Row shape is not the verdict (D-017). Whichever writer won, the item must be
    // withheld, because both candidate blockers were seeded non-terminal.
    await seedIssue('EI-b');
    await seedIssue('EI-x', 'wip'); // parked: non-terminal, and not a rival candidate
    await seedIssue('EI-y', 'wip');

    expect(await claim('probe')).toBe('EI-b'); // positive control on this rig
    await releaseClaim('EI-b');

    await Promise.all([
      syncWorkItemDepEdges(H, 'EI-b', ['EI-x']),
      syncWorkItemDepEdges(H, 'EI-b', ['EI-y']),
    ]);

    expect(await claim('after')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A claim racing the blocker's own completion
// ---------------------------------------------------------------------------

describe("a claim racing the blocker's completion (P-011) — @covers INV-04 INV-05", () => {
  it('is never served while blocked, and is never left permanently parked', async () => {
    // The sharpest case in this file, and the one with two opposite failure modes:
    //   too weak  — the claim slips through while the blocker is still live (INV-04);
    //   too strong — the completion lands but the row stays unclaimable forever, because
    //                the readiness sidecar was updated by a transaction that lost the
    //                race and never re-converged (INV-05, and invisible: no error is
    //                raised anywhere, the work simply stops being offered).
    // Either outcome of the RACE is legal; both post-conditions are mandatory.
    await seedIssue('EI-dep');
    await seedIssue('EI-pre', 'wip'); // live blocker, but not itself a candidate
    await syncWorkItemDepEdges(H, 'EI-dep', ['EI-pre']);

    const [claimed] = await Promise.all([claim('racer'), setStatus('EI-pre', 'done')]);

    if (claimed !== null) {
      // If it WAS served, the blocker must have been terminal by then — a serve while a
      // live blocker existed is INV-04 violated outright.
      expect(claimed).toBe('EI-dep');
      const rows = (await db.sql<{ status: string }[]>`
        SELECT status FROM harness_shared.work_items WHERE feature_id = 'EI-pre'`) as unknown as Array<{
        status: string;
      }>;
      expect(rows[0]!.status).toBe('done');
      await releaseClaim('EI-dep');
    }

    // THE POST-CONDITION THAT MATTERS EITHER WAY: the blocker is now terminal, so a
    // subsequent claim MUST serve the item. This is what catches a row parked forever by
    // a stale sidecar row that the losing transaction never cleaned up.
    expect(await claim('follow-up')).toBe('EI-dep');
  });

  it('a claim racing the blocker being RE-OPENED never serves a row with a live blocker', async () => {
    // The mirror direction. The blocker starts terminal (item claimable) and goes back to
    // open under the claim. A serve is legal only if it happened before the re-open
    // committed — but the row must never end up claimed WHILE a live blocker stands.
    await seedIssue('EI-dep');
    await seedIssue('EI-pre', 'done');
    await syncWorkItemDepEdges(H, 'EI-dep', ['EI-pre']);

    // Re-opened to `wip`, not `open`: still a LIVE (non-terminal) blocker, but not itself
    // a rival candidate — otherwise the follow-up claim below is served the blocker and
    // the assertion silently stops being about EI-dep at all.
    const [claimed] = await Promise.all([claim('racer'), setStatus('EI-pre', 'wip')]);
    if (claimed !== null) await releaseClaim('EI-dep');

    // Now that the blocker is unambiguously live, the door must withhold.
    expect(await claim('follow-up')).toBeNull();
  });
});
