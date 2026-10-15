/**
 * claim-respects-blocking.integration.test.ts — the scheduler claim path NEVER hands
 * out a BLOCKED work-item, and DOES once it is unblocked
 * (work-item-deps-and-readiness-2026-06-22 P-005, owned by su-0e44e75b).
 *
 * The eligibility floors are defined ONCE — `claimFloorsWhereSql` in work-items.ts — and
 * shared by BOTH claim entry points: the decentralized `claimNextWorkItem` (work-items.ts)
 * AND the spec-driven `getNextForBee` (scheduler/claim-spec-store.ts → get-next.ts). This
 * test asserts the readiness invariant against BOTH, in one place, so a regression in either
 * caller (or in the shared floor) is caught:
 *
 *   1. A feature F blocked-by a NON-TERMINAL feature G (a work_item_deps 'blocks' edge) is
 *      NEVER claimed — by claimNextWorkItem NOR getNextForBee — even with a filter/spec that
 *      WOULD otherwise select F.
 *   2. Flip G → 'passed' (terminal) ⇒ F becomes claimable (both paths return it).
 *   3. A feature with NO blockers is always claimable.
 *   4. An ABSENT / dangling blocker ref does NOT block (no deadlock).
 *
 * Distinct from work-items-claim-readiness.integration.test.ts (which proves only
 * claimNextWorkItem against the inline predicate) and get-next.integration.test.ts (which
 * proves getNextWorkItem with a hand-built spec): THIS file drives the bee-spec ENTRY point
 * (getClaimSpec → getNextWorkItem) the live scheduler actually calls, alongside the legacy
 * claim, and ALSO materializes migration 379's MAINTAINED readiness sidecar
 * (harness_shared.work_item_blocked) to cross-check that the sidecar's membership (the
 * indexed read the SCHEDULER_MAINTAINED_READY flag will switch the claim to) stays IDENTICAL
 * to the inline `NOT EXISTS` predicate at every step — i.e. behavior is the same either way.
 *
 * Real Postgres (testcontainer; Docker required).
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/claim-respects-blocking.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  SUBSTRATE_OUTBOX_DDL,
  applyClaimPathReadDeps,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { WIDE_TRIGGER_DDL } from './dependency-trigger-fixture';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
/** Read a migration verbatim, stripping psql meta-commands / GRANTs / bare BEGIN/COMMIT
 *  the bare testcontainer schema can't run (mirrors the sibling integration tests). */
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

// Keep the import chain (claim-spec-store → get-next → work-items) safe at module load and
// route every getOrgPg() in the engine at the throwaway test db.
const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('../work-items');
const { getNextForBee } = await import('./claim-spec-store');
const { reconcileClearedDependencyBlockedState } = await import('../work-item-blocking');

const H = 'papercup';
const WS = 'default'; // == DEFAULT_COORD_WORKSPACE; work_item_deps + the sidecar live here
let db: FreshPgDb;

interface SeedOpts {
  createdTs?: number;
  status?: string;
  authority?: string | null;
  takenBy?: string | null;
  tags?: string[];
  payload?: Record<string, unknown>;
}
async function seedFeature(id: string, opts: SeedOpts = {}) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, authority, taken_by, workspace_id, created_ts, updated_ts, tags, payload)
    VALUES (${H}, ${id}, 'feature', ${opts.status ?? 'open'}, ${opts.authority ?? null}, ${opts.takenBy ?? null}, ${WS},
       ${opts.createdTs ?? 0}, 0, ${opts.tags ? db.sql.json(opts.tags) : null},
       ${opts.payload ? db.sql.json(opts.payload as Parameters<typeof db.sql.json>[0]) : null})`;
}

/** A feature→feature blocks edge (harness-qualified refs, the featureRef convention). */
async function blockByFeature(blockedId: string, blockerId: string) {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, 'feature', ${`${H}#${blockedId}`}, 'feature', ${`${H}#${blockerId}`}, 'blocks')`;
}

/** The MAINTAINED sidecar (migration 379) view of readiness: true ⇒ a row exists ⇒ NOT ready.
 *  This is exactly the membership the SCHEDULER_MAINTAINED_READY flag's anti-join probes. */
async function sidecarSaysBlocked(id: string): Promise<boolean> {
  const rows = await db.sql`
    SELECT 1 FROM harness_shared.work_item_blocked
     WHERE workspace_id = ${WS} AND harness_slug = ${H} AND feature_id = ${id} LIMIT 1`;
  return rows.length > 0;
}

/** The inline-predicate ORACLE (migration 379's work_item_is_blocked == the live claim's
 *  NOT EXISTS). The maintained sidecar must AGREE with it at every step. */
async function oracleSaysBlocked(id: string): Promise<boolean> {
  const rows = await db.sql<{ blocked: boolean }[]>`
    SELECT harness_shared.work_item_is_blocked(${H}, ${id}, 'default') AS blocked`;
  return rows[0]!.blocked === true;
}

/**
 * Drive both claim entry points that share `claimFloorsWhereSql` and return the id each
 * claimed (or null). Each runs in isolation: we RELEASE any claim between calls so the two
 * paths see the identical pre-claim state. The two callers must agree on every assertion —
 * that is the "one floor, two paths" invariant P-005 protects.
 */
async function claimViaBothPaths(assignee: string): Promise<{ legacy: string | null; spec: string | null }> {
  const legacy = (await wi.claimNextWorkItem({ harness: H, assignee: `${assignee}-legacy` }))?.id ?? null;
  if (legacy) {
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET taken_by = NULL, taken_at = NULL WHERE feature_id = ${legacy}`;
  }
  const spec = (await getNextForBee({ cupId: `${assignee}-spec`, harness: H }))?.workItem.id ?? null;
  if (spec) {
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET taken_by = NULL, taken_at = NULL WHERE feature_id = ${spec}`;
  }
  return { legacy, spec };
}

beforeAll(async () => {
  db = await createFreshPgDb('claim-respects-blocking');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple()); // claim path LEFT-JOINs the trust list (autoPickableWhereSql)
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple(); // the dep table the readiness clause reads
  // The cup_claim_specs store getNextForBee → getClaimSpec reads (absent bee ⇒ DEFAULT_CLAIM_SPEC).
  // 372 (base table) + 389 (id_only tripwire column) + 438 (harness_slug federation column) —
  // getClaimSpecRecord / setClaimSpec (claim-spec-store.ts) select/upsert both columns, so 372
  // alone leaves this test failing with `column "harness_slug" does not exist` whenever
  // getNextForBee is exercised. Mig 438's CDC triggers call harness_shared.capture_substrate_outbox()
  // (archive/102) — but archive/102's OWN trigger-attach statements target
  // harness_features_consolidated, which HARNESS_FEATURES_CONSOLIDATED_DDL (above) makes a compat
  // VIEW post-P-010-unification, and `CREATE TRIGGER ... ON <view>` fails. So define just the
  // generic capture_substrate_outbox() function (verbatim from the canonical fixture pattern —
  // see HARNESS_ISSUES_CONSOLIDATED_FED_DDL in _work-items-schema.ts) + the substrate_outbox
  // table it writes to, without archive/102's incompatible trigger-attach statements.
  await db.sql.unsafe(SUBSTRATE_OUTBOX_DDL);
  await db.sql.unsafe(`
    CREATE OR REPLACE FUNCTION harness_shared.capture_substrate_outbox() RETURNS trigger
      LANGUAGE plpgsql AS $cso$
      DECLARE v_op TEXT; v_rec RECORD; v_origin TEXT; v_key TEXT; v_row JSONB; v_ws TEXT; v_slug TEXT; v_keycol TEXT := TG_ARGV[0];
      BEGIN
        IF (TG_OP = 'DELETE') THEN v_op := 'del'; v_rec := OLD; ELSE v_op := 'put'; v_rec := NEW; END IF;
        v_row := to_jsonb(v_rec); v_origin := v_row ->> 'origin';
        IF COALESCE(v_origin, 'local') <> 'local' THEN RETURN v_rec; END IF;
        v_key := v_row ->> v_keycol; v_ws := COALESCE(v_row ->> 'workspace_id', ''); v_slug := v_row ->> 'harness_slug';
        INSERT INTO harness_shared.substrate_outbox (workspace_id, harness_slug, table_name, op, key, row, ts)
          VALUES (v_ws, v_slug, TG_TABLE_NAME, v_op, v_key, v_row, (extract(epoch from now()) * 1000)::bigint);
        PERFORM pg_notify('substrate_outbox', v_ws || '::' || v_slug);
        RETURN v_rec;
      END; $cso$;`);
  await db.sql.unsafe(readMigration('372-bee-claim-specs.sql')).simple();
  await db.sql.unsafe(readMigration('389-bee-claim-spec-id-only.sql')).simple();
  await db.sql.unsafe(readMigration('438-bee-claim-specs-federation.sql')).simple();
  // P-009 Phase 2 (WI-3954 / EI-9520): rename bee_claim_specs -> cup_claim_specs so this
  // rig matches the live post-555 schema getNextForBee/claim-spec-store.ts now queries.
  // Renamed inline (not the full 555 file, whose UNCONDITIONAL beekeeper_* compat VIEWs
  // target cup_keeper_* tables absent from this claim-only rig -> 42P01) — same pattern as
  // claim-spec-store.integration.test.ts. The store's ON CONFLICT (workspace_id, bee_id) is
  // column-based, so a table-only rename is sufficient (constraint names untouched/unreferenced).
  await db.sql.unsafe('ALTER TABLE harness_shared.bee_claim_specs RENAME TO cup_claim_specs').simple();
  // Columns get-next / claim-readiness fixtures add on top of the base superset.
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`).simple();
  // Migration 379: the MAINTAINED readiness sidecar + its maintenance triggers + the
  // work_item_is_blocked oracle. Self-contained + idempotent — applying it here lets us
  // cross-check the sidecar (the indexed read the flag will switch to) against the inline
  // predicate the claim uses today.
  await db.sql.unsafe(readMigration('379-maintained-ready-column.sql')).simple();
  await db.sql.unsafe(WIDE_TRIGGER_DDL).simple();
  // 719: workspace-scoped oracle (required 3rd arg). See EI-19313459163394127.
  await db.sql.unsafe(readMigration('719-fix-work-item-is-blocked-workspace-scope.sql')).simple();
  // 996: lifecycle-terminal proposed completions remain blocked, and an
  // authority-only proposed→committed promotion refreshes the sidecar.
  await db.sql.unsafe(readMigration('996-work-item-completion-settlement-readiness.sql')).simple();
  // The P-003 status reconciliation executes its audit writer as well as its
  // state CAS. Match the existing work-items lifecycle integration fixture.
  await db.sql`CREATE TABLE IF NOT EXISTS harness_shared.audit_log (
    id text PRIMARY KEY, ts bigint NOT NULL, actor text NOT NULL,
    action text NOT NULL, subject text, details jsonb, workspace_id text NOT NULL
  )`;
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps, harness_shared.work_item_blocked`;
});

// ────────────────────────────────────────────────────────────────────────────
// Flag arms. SCHEDULER_MAINTAINED_READY is declared in libs/flags/src/types.ts, and once
// it is READ by the claim path it switches the claim from the inline `NOT EXISTS` predicate
// to the indexed work_item_blocked sidecar — behavior must be IDENTICAL either way. It is
// NOT wired into the claim path yet (re-verify: `grep -rn SCHEDULER_MAINTAINED_READY
// packages/operator-core/lib/scheduler/ | grep -v '\.test\.'` — empty means still unwired),
// so we run the DEFAULT (inline) arm and, in EVERY case, assert the maintained sidecar
// AGREES with the inline oracle — proving the two readiness sources are byte-equivalent
// ahead of the switch. CONDITION, not a person: when that grep is non-empty, add a second
// arm that sets the flag true and re-runs cases 1–2 through the same body (see TODO below).
//
// TODO(su-0e44e75b): once SCHEDULER_MAINTAINED_READY is wired into claimFloorsWhereSql /
// get-next.ts, parametrize the "claim respects blocking" describes over
// [{ name: 'inline (default)', maintained: false }, { name: 'maintained sidecar', maintained: true }]
// — set the flag via the flags store and assert IDENTICAL claim outcomes across both arms.
// ────────────────────────────────────────────────────────────────────────────

// @covers INV-04 INV-05 INV-06
// INV-04 (an existing edge with a non-terminal blocker is EFFECTIVE) and INV-05 (it is
// RELEASED once the blocker goes terminal) are the two halves of the same proof, and this
// describe drives both through BOTH self-select doors, which is INV-06.
describe('scheduler claim respects blocking — NEVER hands out a blocked item (P-005)', () => {
  // Explicit INLINE arm (flag OFF) — the reversible kill-switch fallback. (The sidecar/ON arm — now the
  // shipped default — is the dedicated describe at the bottom.) Pinned so both paths stay covered
  // regardless of the default value.
  beforeEach(() => setFlagOverridesForTest({ [FLAGS.SCHEDULER_MAINTAINED_READY]: false }));
  afterEach(() => setFlagOverridesForTest({}));

  it('1. does NOT claim a feature with a non-terminal feature blocker — NEITHER claim path', async () => {
    // F-blocker is 'wip' (not itself claimable here); F-blocked is the only 'todo' candidate,
    // tagged so a filter/spec WOULD otherwise select it — but its blocker is non-terminal.
    await seedFeature('F-blocker', { status: 'wip', createdTs: 100 });
    await seedFeature('F-blocked', { status: 'open', createdTs: 200, tags: ['sync'] });
    await blockByFeature('F-blocked', 'F-blocker');

    // The inline ORACLE and the MAINTAINED sidecar agree: F-blocked is NOT ready.
    expect(await oracleSaysBlocked('F-blocked')).toBe(true);
    expect(await sidecarSaysBlocked('F-blocked')).toBe(true);
    expect(await claimViaBothPaths('settlement-proposed')).toEqual({ legacy: null, spec: null });

    // Neither claim entry point hands it out.
    const { legacy, spec } = await claimViaBothPaths('w1');
    expect(legacy).toBeNull();
    expect(spec).toBeNull();
  });

  it('2. CLAIMS the blocked feature via BOTH paths once the blocker reaches a terminal status', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 100 });
    await seedFeature('F-blocked', { status: 'open', createdTs: 200, tags: ['sync'] });
    await blockByFeature('F-blocked', 'F-blocker');
    // Blocked first.
    expect((await claimViaBothPaths('w2')).legacy).toBeNull();

    // Satisfy the blocker: 'passed' is terminal. The status-crossing trigger re-syncs the
    // dependent's sidecar membership.
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET status='passed' WHERE feature_id='F-blocker'`;

    // Oracle + sidecar now agree: F-blocked is READY.
    expect(await oracleSaysBlocked('F-blocked')).toBe(false);
    expect(await sidecarSaysBlocked('F-blocked')).toBe(false);

    // The SAME claim that returned null now hands out F-blocked — by BOTH paths.
    const { legacy, spec } = await claimViaBothPaths('w2');
    expect(legacy).toBe('F-blocked');
    expect(spec).toBe('F-blocked');
  });

  it('3. a feature with NO blockers is claimable via BOTH paths', async () => {
    await seedFeature('F-free', { status: 'open', createdTs: 100 });
    expect(await oracleSaysBlocked('F-free')).toBe(false);
    expect(await sidecarSaysBlocked('F-free')).toBe(false);

    const { legacy, spec } = await claimViaBothPaths('w3');
    expect(legacy).toBe('F-free');
    expect(spec).toBe('F-free');
  });

  it('4. an ABSENT / dangling blocker ref does NOT block (no deadlock) — BOTH paths', async () => {
    await seedFeature('F-blocked', { status: 'open', createdTs: 100 });
    // The edge points at a blocker with NO row in the table — an absent blocker never deadlocks.
    await blockByFeature('F-blocked', 'F-ghost');

    expect(await oracleSaysBlocked('F-blocked')).toBe(false);
    expect(await sidecarSaysBlocked('F-blocked')).toBe(false);

    const { legacy, spec } = await claimViaBothPaths('w4');
    expect(legacy).toBe('F-blocked');
    expect(spec).toBe('F-blocked');
  });

  it('skips a blocked item for a ready one — the floor never starves the ready queue (BOTH paths)', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 1 });
    await seedFeature('F-blocked', { status: 'open', createdTs: 100 }); // older, but blocked
    await seedFeature('F-ready', { status: 'open', createdTs: 200 }); //  newer, but ready
    await blockByFeature('F-blocked', 'F-blocker');

    // Oldest-first would pick F-blocked, but it's blocked ⇒ both claims skip to F-ready.
    const { legacy, spec } = await claimViaBothPaths('w5');
    expect(legacy).toBe('F-ready');
    expect(spec).toBe('F-ready');
  });
});

describe.each([false, true])('P-003 independent preparation and status controls (maintained=%s)', (maintained) => {
  beforeEach(() => setFlagOverridesForTest({ [FLAGS.SCHEDULER_MAINTAINED_READY]: maintained }));
  afterEach(() => setFlagOverridesForTest({}));

  it.each(['credential', 'owner-pause', 'destructive-action'])('admits independent preparation without authorizing %s execution', async (prerequisite) => {
    const condition = { kind: 'human', capability: prerequisite === 'credential' ? 'credential' : 'product-decision', status: 'active', ref: prerequisite,
      summary: `The ${prerequisite} prerequisite is unresolved.`, nextVerb: 'Verify the recorded authorization.',
      defaultIfUnanswered: 'Keep dependent execution blocked.' };
    await seedFeature('F-prerequisite', { status: 'needs-human', payload: { needsOwnerAction: true, externalBlockers: [condition] } });
    await seedFeature('F-execution', { createdTs: 1 });
    await blockByFeature('F-execution', 'F-prerequisite');
    // Preparation is registered separately for this execution task. It has no
    // dependency on performing the prohibited operation and grants no release.
    await seedFeature('F-preparation', { createdTs: 2 });
    await db.sql`UPDATE harness_shared.work_items SET parent_id = 'F-execution'
      WHERE harness_slug = ${H} AND feature_id = 'F-preparation'`;
    const before = await db.sql`SELECT status, payload, taken_by FROM harness_shared.work_items
      WHERE harness_slug = ${H} AND feature_id = 'F-prerequisite'`;

    expect(await claimViaBothPaths('prepare')).toEqual({ legacy: 'F-preparation', spec: 'F-preparation' });
    const [preparation] = await db.sql<{ parent_id: string }[]>`SELECT parent_id FROM harness_shared.work_items
      WHERE harness_slug = ${H} AND feature_id = 'F-preparation'`;
    expect(preparation?.parent_id).toBe('F-execution');
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET status = 'passed'
      WHERE harness_slug = ${H} AND feature_id = 'F-preparation'`;
    expect(await claimViaBothPaths('execute')).toEqual({ legacy: null, spec: null });
    expect(await oracleSaysBlocked('F-execution')).toBe(true);
    expect(await sidecarSaysBlocked('F-execution')).toBe(true);
    expect(await db.sql`SELECT status, payload, taken_by FROM harness_shared.work_items
      WHERE harness_slug = ${H} AND feature_id = 'F-prerequisite'`).toEqual(before);
  });

  it.each([false, true])('reconciles stale blocked status while preserving independent park=%s', async (parked) => {
    const park = parked ? { claim_hold_by: 'owner-pause', claim_hold_reason: 'explicit owner pause',
      claim_hold_release: { condition: 'Avi explicitly resumes this operation.', owner: 'Avi',
        trigger: 'owner:resume:exact-operation', reachability: 'blocked', evidence: 'No resume is recorded.' } } : {};
    const payload = { _claimHold: true, held_open_by: 'blocked-lease', held_open_reason: 'blocked',
      sibling: 'keep', ...park };
    await seedFeature('F-stale', { status: 'blocked', payload });
    const snapshot = { id: 'F-stale', harness: H, family: 'feature', state: 'blocked', origin: 'local',
      assignee: null, payload, updatedAt: new Date(0).toISOString() } as import('../work-items').WorkItem;

    expect(await reconcileClearedDependencyBlockedState(snapshot, 'WI-current-control-proof', {
      sql: db.sql, workspaceId: WS,
    })).toBe('cleared');
    const [row] = await db.sql<{ status: string; payload: Record<string, unknown> }[]>`
      SELECT status, payload FROM harness_shared.work_items WHERE harness_slug = ${H} AND feature_id = 'F-stale'`;
    expect(row?.status).toBe('open');
    expect(row?.payload.sibling).toBe('keep');
    expect(row?.payload).not.toHaveProperty('held_open_by');
    if (parked) expect(row?.payload).toMatchObject({ _claimHold: true, ...park });
    else expect(row?.payload).not.toHaveProperty('_claimHold');
    expect(await claimViaBothPaths('ordinary')).toEqual(parked
      ? { legacy: null, spec: null }
      : { legacy: 'F-stale', spec: 'F-stale' });
  });
});

// @covers INV-09 INV-05
// TRANSITIVE BLOCKING (P-005). Every other behavioural case in this file seeds a depth-1
// chain: one blocked item, one blocker. EI-9108 was a DEEP-chain leak — WI-3503/P-401 served
// with a 7-deep blockedBy chain still open — so the invariant with a real incident behind it
// was the one nothing here re-proved. These cases seed chains and walk them to release.
//
// Note the release is deliberately STEPWISE, and asserting that is the point: satisfying the
// tail does NOT free the head. F-top is blocked by F-mid, and F-mid is non-terminal whether
// or not F-mid is itself blocked — so F-top stays withheld until F-mid actually COMPLETES.
// A "fix" that released the whole chain when its tail went terminal would serve work whose
// real prerequisite had not been done, and would look like a generous bug rather than a leak.
describe('blocking is TRANSITIVE — a chain never leaks, and releases one link at a time (P-005)', () => {
  it('a 3-deep chain withholds every non-terminal link, then releases head-last', async () => {
    await seedFeature('F-tail', { status: 'wip', createdTs: 1 }); // the root prerequisite
    await seedFeature('F-mid', { status: 'open', createdTs: 2 });
    await seedFeature('F-top', { status: 'open', createdTs: 3 });
    await blockByFeature('F-mid', 'F-tail');
    await blockByFeature('F-top', 'F-mid');

    // Nothing is claimable: F-mid waits on F-tail, F-top waits on F-mid, F-tail is 'wip'.
    expect(await oracleSaysBlocked('F-mid')).toBe(true);
    expect(await oracleSaysBlocked('F-top')).toBe(true);
    expect(await sidecarSaysBlocked('F-mid')).toBe(true);
    expect(await sidecarSaysBlocked('F-top')).toBe(true);
    expect(await claimViaBothPaths('t1')).toEqual({ legacy: null, spec: null });

    // Satisfy the TAIL. F-mid frees; F-top must NOT — its own blocker is still open.
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET status='passed' WHERE feature_id='F-tail'`;
    expect(await oracleSaysBlocked('F-mid')).toBe(false);
    expect(await oracleSaysBlocked('F-top')).toBe(true);
    expect(await sidecarSaysBlocked('F-mid')).toBe(false);
    expect(await sidecarSaysBlocked('F-top')).toBe(true);
    // Both doors hand out F-mid and ONLY F-mid — F-top is older-ranked but still withheld.
    expect(await claimViaBothPaths('t2')).toEqual({ legacy: 'F-mid', spec: 'F-mid' });

    // Satisfy the MIDDLE. Only now is the head claimable.
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET status='passed' WHERE feature_id='F-mid'`;
    expect(await oracleSaysBlocked('F-top')).toBe(false);
    expect(await sidecarSaysBlocked('F-top')).toBe(false);
    expect(await claimViaBothPaths('t3')).toEqual({ legacy: 'F-top', spec: 'F-top' });
  });

  it('holds to ARBITRARY depth: a 6-deep chain leaks nothing through EITHER door', async () => {
    // ⚠ WHAT THIS DOES NOT DISTINGUISH. A one-hop-only implementation passes this case, and
    // saying otherwise would be the same over-claim this plan exists to stop. Every
    // intermediate link here is 'open' — i.e. non-terminal — so "blocked by a non-terminal
    // blocker" already withholds the entire chain without consulting anything transitively.
    // Depth cannot discriminate one-hop from transitive while the intermediates are open.
    //
    // What it DOES prove, and what no other case in this file covers: the sidecar's triggers
    // stay exact at depth (wir_status_sync_dependents_trg fires on DIRECT dependents, so a
    // long chain is where a missed cascade would surface), and the release frontier advances
    // by exactly one link per completion rather than collapsing. The discriminating case for
    // transitivity itself is the next test.
    const chain = ['F-l0', 'F-l1', 'F-l2', 'F-l3', 'F-l4', 'F-l5'];
    await seedFeature(chain[0], { status: 'wip', createdTs: 1 }); // root, non-terminal
    for (let i = 1; i < chain.length; i += 1) {
      await seedFeature(chain[i], { status: 'open', createdTs: 1 + i });
      await blockByFeature(chain[i], chain[i - 1]);
    }

    for (let i = 1; i < chain.length; i += 1) {
      expect(await oracleSaysBlocked(chain[i]), `${chain[i]} must be blocked`).toBe(true);
      expect(await sidecarSaysBlocked(chain[i]), `${chain[i]} sidecar must agree`).toBe(true);
    }
    // The deepest link is the one a one-hop implementation leaks first.
    expect(await claimViaBothPaths('t4')).toEqual({ legacy: null, spec: null });

    // Walk the chain to release, asserting the frontier advances by exactly one link.
    for (let i = 0; i < chain.length - 1; i += 1) {
      await db.sql`UPDATE harness_shared.harness_features_consolidated SET status='passed' WHERE feature_id=${chain[i]}`;
      const next = chain[i + 1];
      expect(await oracleSaysBlocked(next), `${next} frees when ${chain[i]} completes`).toBe(false);
      if (i + 2 < chain.length) {
        const after = chain[i + 2];
        expect(await oracleSaysBlocked(after), `${after} must NOT free early`).toBe(true);
      }
      expect(await claimViaBothPaths(`t5-${i}`)).toEqual({ legacy: next, spec: next });
    }
  });

  it('THE DISCRIMINATING CASE: a TERMINAL intermediate releases its dependent, even with its own blocker still open', async () => {
    // This is the only shape in which "one-hop with terminality" and "fully transitive"
    // disagree, so it is the only case that pins down which semantics the system has.
    //
    //   F-root ('wip', unfinished)  <-- F-mid ('passed', DONE)  <-- F-head ('open')
    //
    // One-hop: F-mid is terminal, so F-head is free.  Transitive: F-root is unfinished, so
    // F-mid is "really" still blocked and F-head must wait.
    //
    // The system is one-hop, and that is the CORRECT reading rather than a leak: terminal
    // means the work is done. If F-mid was completed, F-head's prerequisite is satisfied
    // whatever the state of F-root — and F-root's own dependents are still gated by F-root.
    // A fully-transitive rule would deadlock any item whose completed prerequisite happened
    // to sit downstream of an abandoned or long-running root.
    //
    // Recorded because INV-09's phrasing ("an item with a blocked blocker is itself
    // withheld") reads as if it demands the transitive answer. It does not — see the
    // registry note on INV-09, corrected under this plan.
    await seedFeature('F-root', { status: 'wip', createdTs: 1 });
    await seedFeature('F-mid', { status: 'passed', createdTs: 2 });
    await seedFeature('F-head', { status: 'open', createdTs: 3 });
    await blockByFeature('F-mid', 'F-root');
    await blockByFeature('F-head', 'F-mid');

    expect(await oracleSaysBlocked('F-head')).toBe(false);
    expect(await sidecarSaysBlocked('F-head')).toBe(false);
    const { legacy, spec } = await claimViaBothPaths('t7');
    expect(legacy).toBe('F-head');
    expect(spec).toBe('F-head');
  });

  it('a chain whose ROOT is already terminal blocks nothing — the clean control', async () => {
    // The silent-on-clean half. Without it, an implementation that reports EVERY chained
    // item as blocked would pass every case above and deadlock the queue in production.
    await seedFeature('F-tail', { status: 'passed', createdTs: 1 });
    await seedFeature('F-mid', { status: 'open', createdTs: 2 });
    await blockByFeature('F-mid', 'F-tail');

    expect(await oracleSaysBlocked('F-mid')).toBe(false);
    expect(await sidecarSaysBlocked('F-mid')).toBe(false);
    expect(await claimViaBothPaths('t6')).toEqual({ legacy: 'F-mid', spec: 'F-mid' });
  });
});

// @covers INV-15
describe('maintained readiness sidecar tracks the inline oracle through the lifecycle (379)', () => {
  it('add-edge → blocked, terminal-blocker → ready, drop-edge → ready: sidecar mirrors the oracle at every step', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 1 });
    await seedFeature('F-blocked', { status: 'open', createdTs: 2 });
    // Pre-edge: no blocker ⇒ ready in both.
    expect(await oracleSaysBlocked('F-blocked')).toBe(false);
    expect(await sidecarSaysBlocked('F-blocked')).toBe(false);

    // Add the blocks-edge ⇒ blocked in both (wir_deps_sync_trg).
    await blockByFeature('F-blocked', 'F-blocker');
    expect(await oracleSaysBlocked('F-blocked')).toBe(true);
    expect(await sidecarSaysBlocked('F-blocked')).toBe(true);
    expect(await claimViaBothPaths('settlement-invalid')).toEqual({ legacy: null, spec: null });

    // Blocker → terminal ⇒ ready in both (wir_status_sync_dependents_trg).
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET status='passed' WHERE feature_id='F-blocker'`;
    expect(await oracleSaysBlocked('F-blocked')).toBe(false);
    expect(await sidecarSaysBlocked('F-blocked')).toBe(false);

    // Re-block (blocker back to a non-terminal status) ⇒ blocked again.
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET status='wip' WHERE feature_id='F-blocker'`;
    expect(await oracleSaysBlocked('F-blocked')).toBe(true);
    expect(await sidecarSaysBlocked('F-blocked')).toBe(true);

    // Drop the edge ⇒ ready in both (wir_deps_sync_trg on DELETE).
    await db.sql`DELETE FROM harness_shared.work_item_deps WHERE blocked_ref = ${`${H}#F-blocked`}`;
    expect(await oracleSaysBlocked('F-blocked')).toBe(false);
    expect(await sidecarSaysBlocked('F-blocked')).toBe(false);
    expect(await claimViaBothPaths('settlement-committed')).toEqual({
      legacy: 'F-blocked',
      spec: 'F-blocked',
    });
  });

  it('terminal proposed stays blocked, then authority-only settlement refreshes oracle and sidecar', async () => {
    await seedFeature('F-blocker', { status: 'passed', authority: 'proposed', createdTs: 100 });
    await seedFeature('F-blocked', { status: 'open', createdTs: 200 });
    await blockByFeature('F-blocked', 'F-blocker');

    expect(await oracleSaysBlocked('F-blocked')).toBe(true);
    expect(await sidecarSaysBlocked('F-blocked')).toBe(true);

    await db.sql`
      UPDATE harness_shared.harness_features_consolidated
         SET authority = 'invalid'
       WHERE feature_id = 'F-blocker'`;
    expect(await oracleSaysBlocked('F-blocked')).toBe(true);
    expect(await sidecarSaysBlocked('F-blocked')).toBe(true);

    await db.sql`
      UPDATE harness_shared.harness_features_consolidated
         SET authority = 'committed'
       WHERE feature_id = 'F-blocker'`;

    expect(await oracleSaysBlocked('F-blocked')).toBe(false);
    expect(await sidecarSaysBlocked('F-blocked')).toBe(false);
  });

  it('deprecated and dropped blockers remain settled without waiting on completion authority', async () => {
    await seedFeature('F-deprecated', { status: 'deprecated', authority: 'proposed', createdTs: 100 });
    await seedFeature('F-dropped', { status: 'dropped', authority: 'invalid', createdTs: 110 });
    await seedFeature('F-after-deprecated', { status: 'open', createdTs: 200 });
    await seedFeature('F-after-dropped', { status: 'open', createdTs: 210 });
    await blockByFeature('F-after-deprecated', 'F-deprecated');
    await blockByFeature('F-after-dropped', 'F-dropped');

    for (const dependent of ['F-after-deprecated', 'F-after-dropped']) {
      expect(await oracleSaysBlocked(dependent)).toBe(false);
      expect(await sidecarSaysBlocked(dependent)).toBe(false);
    }
  });
});

// Closes the agent's TODO(su-0e44e75b): exercise the claim with SCHEDULER_MAINTAINED_READY ON,
// so the INDEXED work_item_blocked anti-join in claimFloorsWhereSql is driven end-to-end through
// BOTH entry points (the equivalence proof above covers the sidecar==oracle predicate; this covers
// the anti-join SQL fragment itself — a wrong column match would claim a blocked item or claim none).
// @covers INV-04 INV-06
describe('claim respects blocking with SCHEDULER_MAINTAINED_READY ON — the indexed sidecar anti-join (P-005 cutover)', () => {
  beforeEach(() => setFlagOverridesForTest({ [FLAGS.SCHEDULER_MAINTAINED_READY]: true }));
  afterEach(() => setFlagOverridesForTest({}));

  it('flag ON: a feature with a non-terminal blocker is NOT claimed via EITHER path', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 100 });
    await seedFeature('F-blocked', { status: 'open', createdTs: 200, tags: ['sync'] });
    await blockByFeature('F-blocked', 'F-blocker');
    expect(await sidecarSaysBlocked('F-blocked')).toBe(true);
    const { legacy, spec } = await claimViaBothPaths('m1');
    expect(legacy).toBeNull();
    expect(spec).toBeNull();
  });

  it('flag ON: the blocked feature becomes claimable via BOTH paths once the blocker is terminal', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 100 });
    await seedFeature('F-blocked', { status: 'open', createdTs: 200, tags: ['sync'] });
    await blockByFeature('F-blocked', 'F-blocker');
    expect((await claimViaBothPaths('m2')).legacy).toBeNull();
    await db.sql`UPDATE harness_shared.harness_features_consolidated SET status='passed' WHERE feature_id='F-blocker'`;
    expect(await sidecarSaysBlocked('F-blocked')).toBe(false);
    const { legacy, spec } = await claimViaBothPaths('m2');
    expect(legacy).toBe('F-blocked');
    expect(spec).toBe('F-blocked');
  });

  it('flag ON: skips a blocked item for a ready one — the indexed floor never starves the queue', async () => {
    await seedFeature('F-blocker', { status: 'wip', createdTs: 1 });
    await seedFeature('F-blocked', { status: 'open', createdTs: 100 });
    await seedFeature('F-ready', { status: 'open', createdTs: 200 });
    await blockByFeature('F-blocked', 'F-blocker');
    const { legacy, spec } = await claimViaBothPaths('m3');
    expect(legacy).toBe('F-ready');
    expect(spec).toBe('F-ready');
  });
});

// @covers INV-07 INV-14
describe('getNextForBee contention releases the losing claim (P-011)', () => {
  beforeEach(() => setFlagOverridesForTest({ [FLAGS.SCHEDULER_MAINTAINED_READY]: false }));
  afterEach(() => setFlagOverridesForTest({}));

  it('two bees racing one plan-lane row leave it available after the winner releases', async () => {
    await seedFeature('F-race', { status: 'open', createdTs: 10, tags: ['sync'] });
    const [a, b] = await Promise.all([
      getNextForBee({ cupId: 'bee-a', harness: H }),
      getNextForBee({ cupId: 'bee-b', harness: H }),
    ]);
    const winner = a?.workItem.id ?? b?.workItem.id;
    expect(winner).toBe('F-race');
    expect([a, b].filter(Boolean)).toHaveLength(1);

    // Simulate the lane-guard bounce's release, then prove a later bee can serve it.
    await db.sql`UPDATE harness_shared.harness_features_consolidated
                    SET taken_by = NULL, taken_at = NULL WHERE feature_id = 'F-race'`;
    const retry = await getNextForBee({ cupId: 'bee-retry', harness: H });
    expect(retry?.workItem.id).toBe('F-race');
  });
});
