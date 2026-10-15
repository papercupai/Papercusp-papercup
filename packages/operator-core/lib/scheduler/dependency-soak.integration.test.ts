/**
 * dependency-soak.integration.test.ts — the dependency subsystem under SUSTAINED CHURN.
 *
 * Plan: dependency-subsystem-thorough-testing-2026-08-02 (P-014).
 * @covers INV-04 INV-05 INV-11 INV-12
 *
 * ── WHAT A SOAK ADDS THAT THE OTHER TWELVE FILES CANNOT ────────────────────────────────
 * Every sibling in this plan asserts a POINT-IN-TIME fact: seed a graph, drive one writer,
 * ask one question. That shape cannot see the failure mode this subsystem actually has,
 * which is ACCUMULATION — a maintained sidecar that is correct after each individual write
 * and wrong after four hundred of them, because one transition class silently maintains
 * nothing and the error only becomes visible once some later read depends on it.
 *
 * So this file asserts CONTINUITY instead: it runs a bounded stream of mutations against a
 * seeded graph and re-checks the whole invariant set after EVERY tick. A violation is
 * reported with the tick index and the mutation that produced it, so a failure names its
 * own cause instead of leaving a post-mortem diff.
 *
 * The three per-tick assertions are all SHIPPED PRODUCTION DETECTORS, not local re-statements:
 *
 *   (a) `reconcileReadiness`              — oracle (`work_item_is_blocked`) ≡ sidecar
 *                                           (`work_item_blocked`), both drift directions.
 *   (b) `reconcileWorkItemDepEndpoints`   — no endpoint has drifted to an inert form (D-017).
 *   (c) the real claim door               — nothing is SERVED while it has a live blocker.
 *
 * Re-using the detectors is the point: (a) and (b) are what the hourly readiness-drift
 * routine runs in production, so a green soak is evidence about the thing that actually
 * watches production, not about a paraphrase of it written here.
 *
 * ── ⚠ THE MIGRATION STACK IS LOAD-BEARING, AND EVERY SIBLING FILE GETS IT WRONG ─────────
 * This rig applies 379 + **640** + 719. The nine other dependency integration tests apply
 * 379 (+719) and NOT 640 — measured 2026-08-02 by grepping `readMigration(` across the
 * suite: 9 files name 379, 7 name 719, ZERO name 640.
 *
 * That omission is not cosmetic, and it is not a style difference. Migration 379 created
 * `wir_status_sync_dependents_trg`, the trigger that re-syncs an item's DEPENDENTS when the
 * item crosses the terminal boundary. Its firing condition is a WHEN clause listing the
 * terminal statuses — and 379's list is the FAMILY-BLIND union that omits the unified
 * terminals entirely:
 *
 *     379:  WHEN (OLD.status IN ('passed','deprecated','resolved','closed'))
 *             IS DISTINCT FROM (NEW.status IN (…same four…))
 *     640:  WHEN (OLD.status = ANY (ARRAY['passed','deprecated','resolved','closed','done','dropped']))
 *             IS DISTINCT FROM (NEW.status = ANY (…same six…))
 *
 * Under 379 alone, a blocker moving `open → done` crosses NO boundary the WHEN clause can
 * see (false → false), so the trigger never fires, so the sidecar keeps asserting that the
 * dependent is blocked — while the ORACLE, which 719 rewrote, treats `done` as terminal and
 * says it is free. The dependent starves, and `reconcileReadiness` reports the drift.
 *
 * The reason this matters so much HERE: `done` is the terminal status the fixtures use.
 * `standardScenario`'s only satisfied blocker is `F-done-blocker`, at status `done`. So the
 * corpus built to prove this subsystem correct has been driving the one transition its own
 * schema cannot maintain — and could not notice, because a point-in-time test seeds the
 * terminal status up-front rather than TRANSITIONING to it, and the sidecar is only ever
 * maintained by a transition. NEGATIVE CONTROL 1 below reproduces this on demand.
 *
 * ⚠ 640 is invisible to `auditMigrationList` (the fixture-staleness helper in _pg-helpers)
 * BY CONSTRUCTION, which is why no guard caught this. That audit derives relevance from
 * `tablesTouchedBySql`, which matches `CREATE|ALTER TABLE`. Migration 640 changes a
 * FUNCTION and a TRIGGER and touches no table declaration at all, so it can never appear in
 * `missing` however stale a list gets. The audit is sound for what it models; the model just
 * has no notion of behaviour that lives in a trigger. Filed rather than patched here.
 *
 * ── HOW 640 IS APPLIED, AND WHY NOT BY HAND ────────────────────────────────────────────
 * 640 as a whole is not applicable to a partial fixture: it also rewrites the federation CDC
 * and touches `harness_shared.pots` / `substrate_outbox` / `terminal_reason` / `fed_hlc`,
 * none of which this rig builds. The obvious workaround — paste the trigger's DDL into this
 * file — is the exact fixture-forgery trap the plan header warns about: a hand-copied WHEN
 * clause is a SECOND copy of the convention, so the day production widens that array again,
 * this test keeps passing against the stale one it owns.
 *
 * So the statement is EXTRACTED FROM THE SHIPPED MIGRATION BYTES at run time
 * (`extractTriggerDdl`), and the extractor THROWS if it cannot find it. A rename or a
 * refactor of 640 fails this file loudly instead of silently degrading the rig back to
 * 379's narrow trigger — which, since that degradation is invisible in a green run, is the
 * only failure mode worth engineering against.
 *
 * ── ⚠ BLOCKERS ARE PARKED AT `wip`, AND THAT IS LOAD-BEARING ───────────────────────────
 * Inherited from P-011, where it cost four failures on the first run. A blocker is ITSELF a
 * work-item, so a blocker left at `open` is CLAIMABLE, and the door cheerfully serves the
 * BLOCKER while the test believes it is proving something about the blocked item. `wip` is
 * the unique status that is simultaneously non-claimable (CLAIM_STATES_ALLOWLIST is
 * ['open','failing']) and NON-TERMINAL, so it still withholds.
 *
 * ── ⚠ ANTI-VACUITY IS ASSERTED, NOT ASSUMED ────────────────────────────────────────────
 * A soak whose mutation stream never produced the discriminating shape proves nothing while
 * looking thorough — the most expensive way for this file to fail. So the stream's OWN
 * coverage is a first-class assertion (`describe('the mutation stream is honest')`): the run
 * must actually have produced a `done` transition, a legacy-spelling transition, an edge
 * addition, an edge REMOVAL, and at least one tick with a non-empty blocked set. If any is
 * missing the soak is reported as inconclusive rather than green.
 *
 * Deterministic by construction: a seeded PRNG (no `Math.random`), so a failure is
 * reproducible from the seed printed in the message.
 *
 * Real Postgres (testcontainer; Docker required).
 *
 * Run:
 *   npm run test:file -- packages/operator-core/lib/scheduler/dependency-soak.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  applyClaimPathReadDeps,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import {
  extractTriggerDdl,
  migrationText,
  NARROW_TRIGGER_DDL,
  TRIGGER,
  WIDE_TRIGGER_DDL,
} from './dependency-trigger-fixture';

/** Strip psql meta-commands, GRANTs and bare txn markers — the sibling files' convention. */
const readMigration = (f: string) =>
  migrationText(f)
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
const { reconcileReadiness } = await import('./readiness-reconcile');
const { reconcileWorkItemDepEndpoints } = await import('./work-item-deps-integrity');

const WS = 'default';
const H = 'papercup';

/**
 * Terminal vocabularies, PER FAMILY — the P-010 finding (D-019), restated here because the
 * mutation stream must pick a terminal status the BLOCKER'S OWN family recognises. Collapsing
 * these into one list is what made the fixture disagree with the shipped oracle for four of
 * six states.
 */
const FEATURE_TERMINALS = ['passed', 'deprecated', 'done', 'dropped'] as const;
const ISSUE_TERMINALS = ['resolved', 'closed', 'done', 'dropped'] as const;
/** Non-terminal parking spots. `wip` for blockers — see the header. */
const NON_TERMINAL = ['open', 'wip', 'in_progress'] as const;

let db: FreshPgDb;

// ---------------------------------------------------------------------------
// Deterministic PRNG — mulberry32. No Math.random: a soak that cannot be replayed
// from its seed turns every failure into an unreproducible anecdote.
// ---------------------------------------------------------------------------
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

beforeAll(async () => {
  db = await createFreshPgDb('dependency-soak');
  h.sql = db.sql;
  // `reconcileWorkItemDepEndpoints` reads THREE relations — work_item_deps (the mirror),
  // coord_links (the AUTHORITATIVE store) and coord_threads. Building only the mirror is
  // how a rig gets a green verdict from a detector that never looked at the source, so all
  // three exist here even though this soak's writers only populate the first.
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
  // The SHIPPED readiness layer: sidecar + triggers (379), then the corrected oracle (719).
  await db.sql.unsafe(readMigration('379-maintained-ready-column.sql')).simple();
  await db.sql.unsafe(readMigration('719-fix-work-item-is-blocked-workspace-scope.sql')).simple();
  // …then 640's WIDENED dependent-sync trigger. 719 replaces the ORACLE but leaves the
  // trigger 379 installed, so without this the rig maintains the sidecar on a four-status
  // boundary while the oracle judges on six. See the header.
  await db.sql.unsafe(WIDE_TRIGGER_DDL).simple();
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps, harness_shared.work_item_blocked, harness_shared.contributors, harness_shared.coord_links, harness_shared.coord_threads`;
  // Every test starts from the PRODUCTION trigger; NEGATIVE CONTROL 1 swaps it deliberately
  // and restores it, but a mid-test failure there must not leak into a sibling.
  await db.sql.unsafe(WIDE_TRIGGER_DDL).simple();
});

// ---------------------------------------------------------------------------
// Helpers — items are seeded, EDGES always go through the real production writer.
// ---------------------------------------------------------------------------

type Family = 'feature' | 'issue';
/** The engine derives family from the item_kind VALUE, never from the family name. */
const KIND: Record<Family, string> = { feature: 'feature', issue: 'task' };

async function seedItem(id: string, family: Family, status: string): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, title, status, item_kind, workspace_id, taken_by, created_ts, updated_ts, payload)
    VALUES (${H}, ${id}, ${`${family} ${id}`}, ${status}, ${KIND[family]}, ${WS}, NULL, 0, 0, '{}'::jsonb)`;
}

const setStatus = (id: string, status: string) =>
  db.sql`UPDATE harness_shared.work_items SET status=${status} WHERE feature_id=${id} AND workspace_id=${WS}`;

const statusOf = async (id: string): Promise<string> => {
  const rows = (await db.sql<{ status: string }[]>`
    SELECT status FROM harness_shared.work_items WHERE feature_id=${id} AND workspace_id=${WS}`) as unknown as Array<{
    status: string;
  }>;
  return rows[0]!.status;
};

/** THE claim door. `null` = withheld; otherwise the id it served. */
const claim = async (assignee: string): Promise<string | null> =>
  (await wi.claimNextWorkItem({ harness: H, assignee }))?.id ?? null;

const releaseAll = () => db.sql`UPDATE harness_shared.work_items SET taken_by=NULL WHERE workspace_id=${WS}`;

/**
 * The FEATURE-family blocked set, straight from the shipped oracle. Deliberately asks the
 * database function rather than recomputing the predicate here — a local re-derivation is a
 * second implementation, and then the test only ever proves the two agree with each other.
 */
async function oracleBlockedFeatures(): Promise<string[]> {
  const rows = (await db.sql<{ feature_id: string }[]>`
    SELECT f.feature_id
      FROM harness_shared.work_items f
     WHERE f.item_kind <> ALL (ARRAY['bug','change','task'])
       AND f.workspace_id = ${WS}
       AND harness_shared.work_item_is_blocked(f.harness_slug, f.feature_id, f.workspace_id)
     ORDER BY f.feature_id`) as unknown as Array<{ feature_id: string }>;
  return rows.map((r) => r.feature_id);
}

/**
 * The ISSUE-family blocked set, via the SAME shape the shipped floor uses
 * (`depsBlockedExclusionSql` — bare blocked_ref, per-family blocker terminality). The issue
 * family is NOT tracked by the wir_* triggers, so it has no sidecar to compare against; it
 * is here because assertion (c) must cover both families or the claim-door check is only
 * ever exercised on half the graph.
 */
async function floorBlockedIssues(): Promise<string[]> {
  const rows = (await db.sql<{ feature_id: string }[]>`
    SELECT wi.feature_id
      FROM harness_shared.work_items wi
     WHERE wi.item_kind = ANY (ARRAY['bug','change','task'])
       AND wi.workspace_id = ${WS}
       AND EXISTS (
         SELECT 1 FROM harness_shared.work_item_deps d
          WHERE d.workspace_id = 'default'
            AND d.dep_type = 'blocks'
            AND d.blocked_ref = wi.feature_id
            AND (
              EXISTS (
                SELECT 1 FROM harness_shared.work_items bf
                 WHERE bf.item_kind <> ALL (ARRAY['bug','change','task'])
                   AND bf.workspace_id = wi.workspace_id
                   AND (bf.harness_slug || '#' || bf.feature_id) = d.blocker_ref
                   AND bf.status NOT IN ('passed','deprecated','done','dropped')
              )
              OR EXISTS (
                SELECT 1 FROM harness_shared.work_items bi
                 WHERE bi.item_kind = ANY (ARRAY['bug','change','task'])
                   AND bi.workspace_id = wi.workspace_id
                   AND bi.feature_id = d.blocker_ref
                   AND bi.status NOT IN ('resolved','closed','done','dropped')
              )
            )
       )
     ORDER BY wi.feature_id`) as unknown as Array<{ feature_id: string }>;
  return rows.map((r) => r.feature_id);
}

/**
 * Drain the claim door and report what it SERVED. Bounded — an unbounded drain against a
 * door bug would hang the suite rather than fail it.
 */
async function drainDoor(limit = 12): Promise<string[]> {
  const served: string[] = [];
  for (let i = 0; i < limit; i++) {
    const got = await claim(`soak-${i}`);
    if (!got) break;
    served.push(got);
  }
  await releaseAll();
  return served;
}

// ---------------------------------------------------------------------------
// The graph under soak
// ---------------------------------------------------------------------------

const FEATURES = ['F-a', 'F-b', 'F-c', 'F-d'] as const;
const ISSUES = ['EI-a', 'EI-b', 'EI-c', 'EI-d'] as const;
/** Blockers only ever park here or at a terminal — never `open`, per the header. */
const BLOCKERS: { id: string; family: Family }[] = [
  { id: 'F-blk1', family: 'feature' },
  { id: 'F-blk2', family: 'feature' },
  { id: 'EI-blk1', family: 'issue' },
  { id: 'EI-blk2', family: 'issue' },
];

async function seedGraph(): Promise<void> {
  for (const id of FEATURES) await seedItem(id, 'feature', 'open');
  for (const id of ISSUES) await seedItem(id, 'issue', 'open');
  for (const b of BLOCKERS) await seedItem(b.id, b.family, 'wip');
}

/** What the mutation stream actually did — the anti-vacuity ledger. */
interface Coverage {
  terminalizedTo: Set<string>;
  reopened: number;
  edgesAdded: number;
  edgesRemoved: number;
  ticksWithBlockedItems: number;
  ticksWithServedItems: number;
}

interface Violation {
  tick: number;
  mutation: string;
  kind: 'readiness-drift' | 'endpoint-defect' | 'served-while-blocked';
  detail: string;
}

/**
 * Run `ticks` mutations, re-checking the FULL invariant set after each one.
 *
 * Returns violations rather than throwing so a caller can assert on the whole run — and so
 * NEGATIVE CONTROL 1 can assert that a violation IS produced, which is the only way to know
 * these checks can fail at all.
 */
async function soak(opts: {
  ticks: number;
  seed: number;
  checkDoor?: boolean;
}): Promise<{ violations: Violation[]; coverage: Coverage }> {
  const r = rng(opts.seed);
  const coverage: Coverage = {
    terminalizedTo: new Set(),
    reopened: 0,
    edgesAdded: 0,
    edgesRemoved: 0,
    ticksWithBlockedItems: 0,
    ticksWithServedItems: 0,
  };
  const violations: Violation[] = [];
  /** Mirror of the intent last written per blocked item — lets a tick REMOVE edges, not only add. */
  const intent = new Map<string, string[]>();

  for (let tick = 0; tick < opts.ticks; tick++) {
    let mutation = '';
    const roll = r();

    if (roll < 0.4) {
      // ── Rewire a blocked item's edge set through the REAL writer (REPLACE semantics).
      const blocked = pick(r, FEATURES);
      const before = intent.get(blocked) ?? [];
      const n = Math.floor(r() * 3); // 0..2 — 0 exercises full removal
      const next: string[] = [];
      for (let i = 0; i < n; i++) {
        const b = pick(r, BLOCKERS).id;
        if (!next.includes(b)) next.push(b);
      }
      mutation = `rewire ${blocked} -> [${next.join(',')}] (was [${before.join(',')}])`;
      await syncWorkItemDepEdges(H, blocked, next);
      intent.set(blocked, next);
      const added = next.filter((x) => !before.includes(x)).length;
      const removed = before.filter((x) => !next.includes(x)).length;
      coverage.edgesAdded += added;
      coverage.edgesRemoved += removed;
    } else if (roll < 0.7) {
      // ── Terminalize a blocker, in ITS OWN family's vocabulary (D-019).
      const b = pick(r, BLOCKERS);
      const to = pick(r, b.family === 'feature' ? FEATURE_TERMINALS : ISSUE_TERMINALS);
      mutation = `terminalize ${b.id} (${b.family}) -> ${to}`;
      await setStatus(b.id, to);
      coverage.terminalizedTo.add(to);
    } else if (roll < 0.85) {
      // ── Reopen a blocker: the drift direction that STARVES rather than over-serves.
      const b = pick(r, BLOCKERS);
      const to = pick(r, NON_TERMINAL.filter((s) => s !== 'open')); // never `open` — see header
      mutation = `reopen ${b.id} -> ${to}`;
      await setStatus(b.id, to);
      coverage.reopened += 1;
    } else {
      // ── Point an ISSUE-family item at a blocker: the family the sidecar does NOT track,
      //    so only the inline floor can withhold it.
      const blocked = pick(r, ISSUES);
      const b = pick(r, BLOCKERS).id;
      mutation = `issue-edge ${blocked} -> [${b}]`;
      await syncWorkItemDepEdges(H, blocked, [b]);
      const before = intent.get(blocked) ?? [];
      coverage.edgesAdded += before.includes(b) ? 0 : 1;
      intent.set(blocked, [b]);
    }

    // ── (a) sidecar ≡ oracle, after EVERY tick.
    const readiness = await reconcileReadiness(db.sql);
    if (readiness.drift !== 0) {
      violations.push({
        tick,
        mutation,
        kind: 'readiness-drift',
        detail:
          `drift=${readiness.drift} ` +
          `missing=[${readiness.missing.map((k) => k.feature_id).join(',')}] ` +
          `extra=[${readiness.extra.map((k) => k.feature_id).join(',')}]`,
      });
    }

    // ── (b) no endpoint has drifted to an inert form.
    const endpoints = await reconcileWorkItemDepEndpoints(db.sql);
    if (endpoints.defects !== 0) {
      violations.push({
        tick,
        mutation,
        kind: 'endpoint-defect',
        detail: `defects=${endpoints.defects} mismatched=${endpoints.mismatched.length} dangling=${endpoints.dangling.length}`,
      });
    }

    // ── (c) nothing SERVED while it has a live blocker.
    const blockedNow = new Set([...(await oracleBlockedFeatures()), ...(await floorBlockedIssues())]);
    if (blockedNow.size > 0) coverage.ticksWithBlockedItems += 1;
    if (opts.checkDoor !== false) {
      const served = await drainDoor();
      if (served.length > 0) coverage.ticksWithServedItems += 1;
      for (const id of served) {
        if (blockedNow.has(id)) {
          violations.push({
            tick,
            mutation,
            kind: 'served-while-blocked',
            detail: `door served '${id}' while it had a live blocker (blocked set: ${[...blockedNow].join(',')})`,
          });
        }
      }
    }
  }

  return { violations, coverage };
}

const fmt = (vs: Violation[]) =>
  vs.map((v) => `tick ${v.tick} [${v.kind}] after '${v.mutation}': ${v.detail}`).join('\n');

// ---------------------------------------------------------------------------
// THE SOAK
// ---------------------------------------------------------------------------

const TICKS = 60;
const SEEDS = [0xc0ffee, 0x5eed, 0xd15ea5e];

describe('dependency soak — the invariants hold CONTINUOUSLY under sustained churn', () => {
  for (const seed of SEEDS) {
    it(`holds every invariant across ${TICKS} mutations (seed 0x${seed.toString(16)})`, async () => {
      await seedGraph();
      const { violations } = await soak({ ticks: TICKS, seed });
      expect(
        violations.length,
        `seed 0x${seed.toString(16)} — replay with that seed to reproduce:\n${fmt(violations)}`,
      ).toBe(0);
    }, 180_000);
  }

  it('leaves NO residue once every blocker is terminal — the accumulation question, asked directly', async () => {
    await seedGraph();
    await soak({ ticks: TICKS, seed: 0xfaded, checkDoor: false });

    // Satisfy the entire graph in each blocker's own vocabulary, then demand a clean slate.
    // A sidecar that merely trends correct is not correct: after the last blocker goes
    // terminal, NOTHING may still be marked blocked.
    for (const b of BLOCKERS) {
      await setStatus(b.id, b.family === 'feature' ? 'done' : 'resolved');
    }

    expect(await oracleBlockedFeatures()).toEqual([]);
    const rows = (await db.sql<{ feature_id: string }[]>`
      SELECT feature_id FROM harness_shared.work_item_blocked ORDER BY feature_id`) as unknown as Array<{
      feature_id: string;
    }>;
    expect(rows.map((r) => r.feature_id), 'sidecar residue after every blocker went terminal').toEqual([]);
    expect((await reconcileReadiness(db.sql)).drift).toBe(0);
    expect((await reconcileWorkItemDepEndpoints(db.sql)).defects).toBe(0);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// The mutation stream's OWN coverage. A soak that never produced the discriminating
// shape is INCONCLUSIVE, and inconclusive-but-green is the worst outcome available.
// ---------------------------------------------------------------------------

describe('the mutation stream is honest', () => {
  it('actually produces every shape the assertions depend on', async () => {
    await seedGraph();
    const { coverage } = await soak({ ticks: TICKS, seed: SEEDS[0]! });

    // `done` specifically: the unified terminal 379's narrow trigger cannot see, and the
    // status every fixture in this plan uses. If the stream never emits it, NEGATIVE
    // CONTROL 1 is testing nothing and the main soak never exercises the real risk.
    expect(coverage.terminalizedTo, 'stream must terminalize something to `done`').toContain('done');
    // …and a LEGACY per-family spelling, so the run spans both sides of the 638/640 cutover
    // rather than only the unified vocabulary.
    expect(
      [...coverage.terminalizedTo].some((s) =>
        ['passed', 'deprecated', 'resolved', 'closed'].includes(s),
      ),
      `stream must also use a legacy terminal spelling; saw ${[...coverage.terminalizedTo].join(',')}`,
    ).toBe(true);

    expect(coverage.reopened, 'stream must reopen a blocker (the starving drift direction)').toBeGreaterThan(0);
    expect(coverage.edgesAdded, 'stream must add edges').toBeGreaterThan(0);
    // REMOVAL is the half a naive stream misses: an append-only stream can never show that
    // the sidecar releases an item, so the whole `extra`/starving direction would go untested.
    expect(coverage.edgesRemoved, 'stream must REMOVE edges, not only add them').toBeGreaterThan(0);
    expect(
      coverage.ticksWithBlockedItems,
      'stream must reach states where something IS blocked — otherwise every check is vacuous',
    ).toBeGreaterThan(0);
    // The positive control for the door: if it never served anything, `served-while-blocked`
    // could not have fired however broken the floor was.
    expect(coverage.ticksWithServedItems, 'the claim door must actually serve items').toBeGreaterThan(0);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS — permanent, in-file, and never achieved by mutating production
// code. Each installs a KNOWN-WRONG condition and asserts the soak REPORTS it. Without
// these, a green soak is indistinguishable from a soak whose detectors are inert.
// ---------------------------------------------------------------------------

describe('negative controls — the soak can actually fail', () => {
  it('CONTROL 1: reports readiness drift under 379\'s NARROW trigger (the stack every sibling test uses)', async () => {
    await seedGraph();
    await syncWorkItemDepEdges(H, 'F-a', ['F-blk1']);

    // Baseline under the PRODUCTION (640) trigger: F-a is blocked, and the sidecar agrees.
    expect(await oracleBlockedFeatures()).toContain('F-a');
    expect((await reconcileReadiness(db.sql)).drift).toBe(0);

    // Swap in 379's narrow trigger — extracted from the real 379 bytes, not written here.
    await db.sql.unsafe(NARROW_TRIGGER_DDL).simple();

    // The transition every fixture in this plan relies on: a feature blocker → `done`.
    // Under 379's WHEN clause this crosses no boundary (false → false), so no re-sync fires.
    await setStatus('F-blk1', 'done');

    const oracle = await oracleBlockedFeatures();
    const drift = await reconcileReadiness(db.sql);

    // The oracle (719) has moved on: `done` is terminal for a feature blocker, so F-a is free.
    expect(oracle, 'the 719 oracle treats `done` as terminal').not.toContain('F-a');
    // The sidecar has NOT, because the narrow trigger never fired. This is the drift the
    // main soak asserts is absent — proving that assertion is capable of failing.
    expect(drift.drift, 'the narrow trigger must leave the sidecar stale').toBeGreaterThan(0);
    expect(drift.extra.map((k) => k.feature_id), 'F-a starves: sidecar says blocked, oracle says free').toContain(
      'F-a',
    );

    // Restore production and prove the drift was attributable to the trigger alone: the same
    // transition, re-applied under 640, leaves no drift behind.
    await db.sql.unsafe(WIDE_TRIGGER_DDL).simple();
    await setStatus('F-blk1', 'wip');
    await setStatus('F-blk1', 'done');
    expect((await reconcileReadiness(db.sql)).drift, 'production trigger maintains the sidecar').toBe(0);
  }, 180_000);

  it('CONTROL 2: reports an endpoint defect when an inert edge is present', async () => {
    await seedGraph();
    expect((await reconcileWorkItemDepEndpoints(db.sql)).defects).toBe(0);

    // A D-017 kind-mismatch, written straight to the table: declared FEATURE kind with a
    // harness-qualified ref, pointing at a row that is really ISSUE family. Form-valid,
    // mirrored, acyclic — and it gates nothing.
    await db.sql`
      INSERT INTO harness_shared.work_item_deps
        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
      VALUES ('default', 'feature', ${`${H}#F-a`}, 'feature', ${`${H}#EI-blk1`}, 'blocks')`;

    const res = await reconcileWorkItemDepEndpoints(db.sql);
    expect(res.defects, 'the endpoint detector must SEE an inert edge').toBeGreaterThan(0);
  }, 180_000);

  it('CONTROL 3: the trigger extractor FAILS LOUDLY rather than degrading the rig silently', () => {
    // The rig's fidelity rests entirely on the extraction succeeding. If a rename made it
    // return empty instead of throwing, every test above would run against 379's trigger and
    // stay green — so the throw is itself an invariant worth pinning.
    expect(() => extractTriggerDdl('-- a migration with no such trigger', TRIGGER)).toThrow(
      /could not find/i,
    );
    // …and the real extraction must yield the WIDENED array, not the narrow one. This is the
    // one place a literal status list is justified: it asserts a property OF the extracted
    // production bytes rather than restating a convention the test then checks against itself.
    expect(WIDE_TRIGGER_DDL).toMatch(/'done'/);
    expect(WIDE_TRIGGER_DDL).toMatch(/'dropped'/);
    expect(NARROW_TRIGGER_DDL).not.toMatch(/'done'/);
  });
});
