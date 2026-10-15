/**
 * cross-door-agreement.integration.test.ts — ONE seeded row, put to EVERY door, verdicts
 * compared as a set.
 *
 * Plan: dependency-subsystem-thorough-testing-2026-08-02 (P-009).
 * @covers INV-06 INV-04 INV-05
 *
 * WHAT WAS ALREADY COVERED, so this file adds rather than repeats (checked by reading the
 * assertions, not the headers):
 *   • claim-respects-blocking.integration.test.ts drives TWO feature-family doors
 *     (claimNextWorkItem + getNextForBee) through chains and both flag arms.
 *   • claim-ssot-agreement.integration.test.ts proves the issue-family PREVIEW (the
 *     work_items_claimable SSOT view) admits EXACTLY what claimNextIssueWorkItem serves,
 *     with blocked-dep among its floors in BOTH directions — a terminal blocker admits,
 *     a non-terminal one excludes. That is the preview-vs-claim pair D-007 found disagreeing.
 *
 * THE TWO THINGS NEITHER PROVES, which is this file:
 *
 *  1. AGREEMENT AS A SET, not pairwise. Existing tests assert door A and door B each behave
 *     correctly. That is weaker than INV-06, which is about the doors AGREEING: a pairwise
 *     suite tells you a door is wrong, but only after someone thinks to add the pair. Here
 *     every door answers the same seeded row and the verdicts are collapsed with `new Set` —
 *     so a new door added to the table is compared against all the others for free, and the
 *     failure message names which one dissented.
 *
 *  2. THE BY-ID BOUNDARY, BEHAVIOURALLY. D-008 says readiness floors gate SELF-SELECT only:
 *     taking a blocked item BY NAME is the deliberate operator override (EI-8972) — it is how
 *     you reopen an item, inherit ownership, or attach follow-up work. Until now that boundary
 *     was asserted only by SOURCE SCAN ("claimWorkItem's body contains no dep_type='blocks'").
 *     A source scan cannot prove the door actually SERVES a blocked item — it proves only that
 *     one spelling of one floor is absent, and it would pass unchanged if the floor arrived via
 *     a helper, a view, or a trigger. So the escape hatch every operator recovery depends on
 *     rested on the absence of a string. It is now exercised.
 *
 * ⚠ THE ASYMMETRY IS THE POINT, AND IT MUST NOT BE "TIDIED". Self-select doors must WITHHOLD
 * the blocked row; by-id doors must SERVE it. Both assertions live in the same scenario below
 * so neither can be quietly relaxed into the other: a change that made the by-id door gate
 * would look like a safety improvement and would break reopen/inherit/attach — and a change
 * that made a self-select door serve is the incident this whole plan exists to prevent.
 *
 * Real Postgres (testcontainer; Docker required).
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/cross-door-agreement.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  applyClaimPathReadDeps,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
// The ISSUE-family by-id claim subscribes the claimant to the item (coord_entity_subscriptions),
// so the coord capability tables are load-bearing for that door — not optional scaffolding.
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
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

const WS = 'default'; // work_item_deps + issues are keyed in the coordination workspace
const H = 'papercup';

const wi = await import('../work-items');

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('cross-door-agreement');
  h.sql = db.sql;
  await ensureCoordCapabilityTables(db.sql);
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
  // 379 = the maintained readiness sidecar + its triggers; 719 = the workspace-scoped oracle.
  // Both are DOORS in the table below, not decoration: the sidecar is the indexed read the
  // claim will switch to, and INV-15 makes their disagreement a reportable defect.
  await db.sql.unsafe(readMigration('379-maintained-ready-column.sql')).simple();
  await db.sql.unsafe(WIDE_TRIGGER_DDL).simple();
  await db.sql.unsafe(readMigration('719-fix-work-item-is-blocked-workspace-scope.sql')).simple();
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps, harness_shared.work_item_blocked`;
});

// ---------------------------------------------------------------------------
// Seeding. Items only — the edge is written straight to the table here because
// WHICH WRITER produced it is P-008's subject, not this file's; here the edge is
// a given and the DOORS are on trial.
// ---------------------------------------------------------------------------

async function seedItem(
  id: string,
  opts: { kind: string; status: string; takenBy?: string | null; createdTs?: number },
): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, title, status, item_kind, workspace_id, taken_by, created_ts, updated_ts, payload)
    VALUES (${H}, ${id}, ${`item ${id}`}, ${opts.status}, ${opts.kind}, ${WS},
            ${opts.takenBy ?? null}, ${opts.createdTs ?? 0}, 0, '{}'::jsonb)`;
}

/** blocked → blocker, in each endpoint's own family ref form (D-009). */
async function seedEdge(blocked: { id: string; kind: string }, blocker: { id: string; kind: string }): Promise<void> {
  const ref = (e: { id: string; kind: string }) => (e.kind === 'feature' ? `${H}#${e.id}` : e.id);
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, ${blocked.kind}, ${ref(blocked)}, ${blocker.kind}, ${ref(blocker)}, 'blocks')`;
}

const setStatus = (id: string, status: string) =>
  db.sql`UPDATE harness_shared.work_items SET status=${status} WHERE feature_id=${id} AND workspace_id=${WS}`;

/** Undo a claim so the NEXT door in the table meets the identical starting state. */
const unclaim = (id: string) =>
  db.sql`UPDATE harness_shared.work_items SET taken_by=NULL WHERE feature_id=${id} AND workspace_id=${WS}`;

// ---------------------------------------------------------------------------
// THE DOOR TABLE. Each entry answers one question about one id: "is it withheld?"
// ---------------------------------------------------------------------------

interface Door {
  name: string;
  /** true = this door withholds the item. */
  blocked: (id: string) => Promise<boolean>;
}

/** FEATURE-family self-select + the two readiness sources that back it. */
const FEATURE_DOORS: Door[] = [
  {
    name: 'claimNextWorkItem (self-select)',
    blocked: async (id) => {
      const got = await wi.claimNextWorkItem({ harness: H, assignee: 'door-probe' });
      await unclaim(id);
      return got?.id !== id;
    },
  },
  {
    name: 'work_item_is_blocked() (the SQL oracle)',
    blocked: async (id) => {
      const rows = (await db.sql`
        SELECT harness_shared.work_item_is_blocked(${H}, ${id}, ${WS}) AS blocked`) as unknown as Array<{
        blocked: boolean;
      }>;
      return rows[0]!.blocked === true;
    },
  },
  {
    name: 'work_item_blocked (the maintained sidecar)',
    blocked: async (id) => {
      // INV-15: the cache and the oracle must agree. Folded into the SAME set as the
      // oracle deliberately — a sidecar that silently lags is a second source of truth,
      // and the failure message names it rather than leaving a stale cache to be
      // discovered by whichever door happens to read it.
      const rows = (await db.sql`
        SELECT EXISTS (
          SELECT 1 FROM harness_shared.work_item_blocked
           WHERE workspace_id = ${WS} AND harness_slug = ${H} AND feature_id = ${id}
        ) AS blocked`) as unknown as Array<{ blocked: boolean }>;
      return rows[0]!.blocked === true;
    },
  },
];

/** ISSUE-family self-select + the shared floor fragment the preview surfaces embed. */
const ISSUE_DOORS: Door[] = [
  {
    name: 'claimNextIssueWorkItem (self-select)',
    blocked: async (id) => {
      const got = await wi.claimNextIssueWorkItem({ harness: H, assignee: 'door-probe' }, WS);
      await unclaim(id);
      return got?.id !== id;
    },
  },
  {
    name: 'depsBlockedExclusionSql (the shared floor fragment)',
    blocked: async (id) => {
      // IMPORTED, never re-implemented: a test that re-states the floor cannot detect the
      // floor drifting, and blocking-floor-single-source.test.ts would (correctly) fail this
      // file for holding a seventh copy. The fragment reads "NOT blocked", so negate it.
      const rows = (await db.sql`
        SELECT NOT (${wi.depsBlockedExclusionSql(db.sql as never)}) AS blocked
          FROM harness_shared.work_items wi
         WHERE wi.workspace_id = ${WS} AND wi.harness_slug = ${H} AND wi.feature_id = ${id}`) as unknown as Array<{
        blocked: boolean;
      }>;
      if (rows.length !== 1) throw new Error(`floor probe: expected 1 row for '${id}', got ${rows.length}`);
      return rows[0]!.blocked === true;
    },
  },
];

/**
 * Put one id to every door and collapse the answers.
 *
 * Returning the per-door verdicts (not just the collapsed set) is what makes a failure
 * readable: `expect(verdicts).toEqual(...)` prints WHICH door dissented, where a bare
 * `expect(set.size).toBe(1)` prints only that one did.
 */
async function verdicts(doors: Door[], id: string): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const d of doors) out[d.name] = await d.blocked(id);
  return out;
}

const allSay = (v: Record<string, boolean>, expected: boolean): Record<string, boolean> =>
  Object.fromEntries(Object.keys(v).map((k) => [k, expected]));

// ---------------------------------------------------------------------------

describe('INV-06 as a SET: every self-select door returns the same verdict for the same row', () => {
  describe.each([
    { family: 'feature' as const, doors: FEATURE_DOORS, blockedId: 'F-DEP', blockerId: 'F-PRE', terminal: 'passed' },
    { family: 'issue' as const, doors: ISSUE_DOORS, blockedId: 'WI-DEP', blockerId: 'WI-PRE', terminal: 'resolved' },
  ])('$family family', ({ family, doors, blockedId, blockerId, terminal }) => {
    const kind = family === 'feature' ? 'feature' : 'task';

    /** The blocker is parked TAKEN so it is never itself the claim candidate. */
    const seedPair = async (blockerStatus: string) => {
      await seedItem(blockerId, { kind, status: blockerStatus, takenBy: 'other-owner', createdTs: 100 });
      await seedItem(blockedId, { kind, status: 'open', createdTs: 200 });
      await seedEdge({ id: blockedId, kind: family }, { id: blockerId, kind: family });
    };

    it('non-terminal blocker: every door says WITHHELD', async () => {
      await seedPair('open');
      const v = await verdicts(doors, blockedId);
      expect(v).toEqual(allSay(v, true));
    });

    it('terminal blocker: the SAME doors that withheld now all say SERVABLE (they flip together)', async () => {
      // The release half, run on the SAME fixture as the withhold half rather than a fresh
      // one — that is what makes it a control. A suite that only ever asserts "withheld"
      // passes with every door permanently refusing everything, and a release asserted on a
      // separately-seeded fixture cannot tell you the doors flipped TOGETHER.
      await seedPair('open');
      const before = await verdicts(doors, blockedId);
      expect(before).toEqual(allSay(before, true));

      await setStatus(blockerId, terminal);
      const after = await verdicts(doors, blockedId);
      expect(after).toEqual(allSay(after, false));
    });

    it('no edge at all: every door says SERVABLE (the clean control)', async () => {
      await seedItem(blockerId, { kind, status: 'open', takenBy: 'other-owner', createdTs: 100 });
      await seedItem(blockedId, { kind, status: 'open', createdTs: 200 });
      const v = await verdicts(doors, blockedId);
      expect(v).toEqual(allSay(v, false));
    });

    it('DANGLING blocker ref: every door says SERVABLE — an absent blocker must never deadlock', async () => {
      // The direction nobody notices until work stalls: over-gating is as much a violation of
      // agreement as under-gating, and a door that resolved an absent blocker differently
      // would deadlock items permanently with no error anywhere.
      await seedItem(blockedId, { kind, status: 'open', createdTs: 200 });
      await seedEdge({ id: blockedId, kind: family }, { id: 'NOPE-404', kind: family });
      const v = await verdicts(doors, blockedId);
      expect(v).toEqual(allSay(v, false));
    });
  });
});

describe('the BY-ID door is the deliberate operator override (D-008 / EI-8972) — proven, not scanned', () => {
  it('FEATURE family: self-select withholds the blocked item while claim-by-id SERVES it', async () => {
    await seedItem('F-PRE', { kind: 'feature', status: 'open', takenBy: 'other-owner', createdTs: 100 });
    await seedItem('F-DEP', { kind: 'feature', status: 'open', createdTs: 200 });
    await seedEdge({ id: 'F-DEP', kind: 'feature' }, { id: 'F-PRE', kind: 'feature' });

    // Both halves in ONE scenario so neither can be relaxed into the other.
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'w1' }))?.id).not.toBe('F-DEP');
    const byId = await wi.claimWorkItem('F-DEP', 'operator-reopening-it', { harness: H });
    expect(
      byId && 'id' in byId ? byId.id : byId,
      'claim-by-id must still serve a BLOCKED item. If this went null, a readiness floor has ' +
        'been added to the by-id path — that breaks reopen / inherit-ownership / ' +
        'attach-follow-up, the operator recovery every stuck dependency is dug out with.',
    ).toBe('F-DEP');
  });

  it('ISSUE family: the same override holds — the two families must not diverge here', async () => {
    // claimIssue had NO assertion of this boundary at all before P-009 (claimWorkItem had a
    // source-scan one). A rule enforced on one family and merely assumed on the other is the
    // shape of D-017, and it drifts in whichever direction nobody is looking.
    await seedItem('WI-PRE', { kind: 'task', status: 'open', takenBy: 'other-owner', createdTs: 100 });
    await seedItem('WI-DEP', { kind: 'task', status: 'open', createdTs: 200 });
    await seedEdge({ id: 'WI-DEP', kind: 'issue' }, { id: 'WI-PRE', kind: 'issue' });

    expect((await wi.claimNextIssueWorkItem({ harness: H, assignee: 'w1' }, WS))?.id).not.toBe('WI-DEP');
    await unclaim('WI-DEP');
    const byId = await wi.claimWorkItem('WI-DEP', 'operator-reopening-it', { harness: H });
    expect(byId && 'id' in byId ? byId.id : byId).toBe('WI-DEP');
  });
});
