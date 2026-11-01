/**
 * claim-spec-store.integration.test.ts — the per-bee claim-spec store (mig 372 cup_claim_specs)
 * that makes get_next usable (hybrid-bee-scheduler-work-stealing-2026-06-22 spec-handoff).
 *
 * setClaimSpec validates (validateClaimSpec) + upserts a bee's spec (bumping the revision on
 * re-steer); getClaimSpec loads it, falling back to DEFAULT_CLAIM_SPEC when absent or invalid.
 * Real Postgres (testcontainer; Docker required); the store fns take a DI `sql`.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *   lib/scheduler/claim-spec-store.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { applyClaimPathReadDeps } from '../../test/_work-items-schema';

// Keep the import chain (claim-spec-store → get-next → work-items) safe at module load.
const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  claimSql: undefined as postgres.Sql | undefined,
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../long-lived-admin-pool', () => ({
  getLongLivedAdminPool: () => h.claimSql ?? h.sql,
}));

const {
  setClaimSpec,
  getClaimSpec,
  getClaimSpecRecord,
  getClaimSpecHeadsForBees,
  resolveClaimSpecWorkspace,
  fleetSpecBeeKey,
  countActiveClaimsForBee,
  readClaimConcurrency,
  readClaimConcurrencyBatch,
  resolveFleetClaimSpec,
  listFleetClaimSpecCandidates,
  getNextForBee,
  SCHEDULER_CLAIM_SETUP_BUDGET_MS,
} = await import('./claim-spec-store');
const { DEFAULT_CLAIM_SPEC } = await import('./claim-spec');
const { updateExternalBlockerHistory } = await import('../external-blockers');
const { buildBeeClaimSpecProjection } = await import('../sync/hyperbee/projections/bee-claim-spec');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const mig = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l))
    // strip standalone BEGIN;/COMMIT; — sql.unsafe on a pooled conn rejects them.
    .filter((l) => !/^\s*(begin|commit);\s*$/i.test(l))
    .join('\n');

let db: FreshPgDb;
beforeAll(async () => {
  db = await createFreshPgDb('beespecs');
  h.sql = db.sql;
  // Minimal consolidated tables FIRST — mig 102 attaches its capture triggers to
  // them (and ALTERs harness_issues_consolidated), so they must pre-exist.
  await db.sql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.harness_features_consolidated (
    harness_slug text NOT NULL, feature_id text NOT NULL, item_kind text NOT NULL DEFAULT 'feature',
    status text NOT NULL DEFAULT 'todo', taken_by text, taken_at timestamptz,
    last_progress_at timestamptz, workspace_id text NOT NULL DEFAULT 'default',
    PRIMARY KEY (harness_slug, feature_id))`);
  await db.sql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.harness_issues_consolidated (
    harness_slug text NOT NULL, issue_id text NOT NULL, workspace_id text NOT NULL DEFAULT 'default',
    PRIMARY KEY (harness_slug, issue_id))`);
  // P-016 (cross-machine-coord-parity): substrate_outbox + capture fn (mig 102),
  // the spec table (372/389), then its federation columns + capture triggers (438).
  await db.sql.unsafe(mig('archive/102-substrate-outbox.sql'));
  await db.sql.unsafe(mig('372-bee-claim-specs.sql'));
  await db.sql.unsafe(mig('389-bee-claim-spec-id-only.sql')); // id-pin tripwire column
  await db.sql.unsafe(mig('438-bee-claim-specs-federation.sql'));
  // P-009 Phase 2 (WI-3954): rename cup_claim_specs (né bee_claim_specs) so this
  // rig matches the live post-555 schema the store/projection now queries.
  // Renamed inline (not the full 555 file, whose UNCONDITIONAL beekeeper_* compat
  // VIEWs target cup_keeper_* tables absent from this claim-spec-only rig → 42P01).
  // The store's ON CONFLICT (workspace_id, bee_id) is column-based, so a
  // table-only rename is sufficient (constraint names are untouched, unreferenced).
  await db.sql.unsafe('ALTER TABLE harness_shared.bee_claim_specs RENAME TO cup_claim_specs');
  // The authoritative record reader must distinguish confirmed solo membership
  // from an unreadable ledger; a missing fixture table is not an absence witness.
  await db.sql.unsafe(`CREATE TABLE harness_shared.fleet_membership_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id text NOT NULL, owner_id text NOT NULL,
    fleet_slug text, fleet_role text
  )`);
  // EI-11796: the production guard counts through the unified work_items view. This
  // claim-spec-only fixture does not need the full work-item schema; keep the smallest
  // real table that exercises the count and its terminal-state floor.
  // EI-12095: `item_kind` added so getActiveClaimsForBee's `feature_id AS id, item_kind AS
  // kind` projection (the concurrency-diagnosis held-ids read) also has a real column to
  // select against — production's harness_shared.work_items has no `id` column at all;
  // the unified id lives in `feature_id` and the family/kind in `item_kind`.
  // EI-21895667973178286: `payload` added so the fixture exercises the resource-governor
  // claim_hold_by exclusion `getActiveClaimsForBee` filters on.
  await db.sql.unsafe(`CREATE TABLE harness_shared.work_items (
    -- WI-38326: FEATURE_COLS projects these five claim-spec filter columns; a fixture
    -- missing them fails that projection with "column does not exist" (D-014 debt).
    tags jsonb,
    source_plan_slug text,
    source_plan_item_ids text[],
    redundancy integer,
    expected_cost_cents bigint,
    workspace_id text NOT NULL,
    -- WI-10005209: work_item_claim_floors (migration 1101, LANGUAGE sql, created by
    -- applyClaimPathReadDeps) resolves blockers via 'work_items bf ... bf.harness_slug',
    -- and a sql function body is validated at CREATE time, so every bf./bi. column it
    -- names must exist here: harness_slug and authority (both text, as live).
    harness_slug text,
    authority text,
    feature_id text PRIMARY KEY,
    admission text, admitted_at timestamptz, admitted_by text,
    taken_by text,
    status text NOT NULL DEFAULT 'todo',
    item_kind text NOT NULL DEFAULT 'change',
    payload jsonb
  )`);
  // WI-10005130: getNextForBee reaches the claim path, so apply the shared claim-path
  // read deps LAST (all IF NOT EXISTS) over the hand-built tables above. The recovery
  // database in the 389 test only replays claim-spec migrations and calls no claim door.
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
}, 180_000);
afterAll(async () => {
  await db?.cleanup?.();
});

describe('migration 389 restored after the migration 555 table rename', () => {
  it('adds id_only to the current base table and refreshes the compatibility view', async () => {
    const recovery = await createFreshPgDb('claim_spec_389_recovery');
    try {
      await recovery.sql.unsafe(mig('372-bee-claim-specs.sql'));

      // Faithfully reproduce the persisted r22 shape: migration 389 was absent from
      // the package, but migration 555 later renamed the table and installed this
      // compatibility view. R24 then restored 389 and must converge from here.
      await recovery.sql.unsafe('ALTER TABLE harness_shared.bee_claim_specs RENAME TO cup_claim_specs');
      await recovery.sql.unsafe(
        'CREATE VIEW harness_shared.bee_claim_specs AS SELECT * FROM harness_shared.cup_claim_specs',
      );

      await recovery.sql.unsafe(mig('389-bee-claim-spec-id-only.sql'));
      await recovery.sql.unsafe(mig('389-bee-claim-spec-id-only.sql'));

      const columns = await recovery.sql<{ relation: string; relkind: string; idOnly: boolean }[]>`
        SELECT c.relname AS relation,
               c.relkind::text AS relkind,
               EXISTS (
                 SELECT 1
                   FROM pg_attribute a
                  WHERE a.attrelid = c.oid
                    AND a.attname = 'id_only'
                    AND a.attnum > 0
                    AND NOT a.attisdropped
               ) AS "idOnly"
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'harness_shared'
           AND c.relname IN ('bee_claim_specs', 'cup_claim_specs')
         ORDER BY c.relname`;

      expect(columns).toEqual([
        { relation: 'bee_claim_specs', relkind: 'v', idOnly: true },
        { relation: 'cup_claim_specs', relkind: 'r', idOnly: true },
      ]);
    } finally {
      await recovery?.cleanup();
    }
  }, 120_000);
});

describe('cup_claim_specs store (mig 372)', () => {
  it('appendIds preserves incumbent cohort ids and policy in exactly one revision', async () => {
    const cupId = fleetSpecBeeKey('append-preserves-policy');
    const incumbent = {
      ...DEFAULT_CLAIM_SPEC, specId: 'append-preserves-policy', revision: 7,
      states: ['open'], limits: { maxConcurrentClaims: 2 },
      view: { filter: { all: [
        { field: 'id', op: 'in', value: ['WI-old', 'WI-retained'] },
        { field: 'goal', op: '=', value: 'goal-owned' },
        { not: { field: 'title', op: 'word', value: 'p2p' } },
      ] } },
    };
    expect((await setClaimSpec({ cupId, workspaceId: 'append-ws', spec: incumbent, potSlug: 'papercusp' }, db.sql)).ok).toBe(true);
    const result = await setClaimSpec({ cupId, workspaceId: 'append-ws', appendIds: ['WI-new', 'WI-old'], potSlug: 'wrong-scope' }, db.sql);
    expect(result).toMatchObject({ ok: true, revision: 8 });
    const [stored] = await db.sql`SELECT spec, revision, harness_slug FROM harness_shared.cup_claim_specs
      WHERE workspace_id = 'append-ws' AND bee_id = ${cupId}`;
    expect(stored.spec).toEqual({ ...incumbent, revision: 8, view: { filter: { all: [
      { field: 'id', op: 'in', value: ['WI-old', 'WI-retained', 'WI-new'] },
      ...incumbent.view.filter.all.slice(1),
    ] } } });
    expect(stored).toMatchObject({ revision: 8, harness_slug: 'papercusp' });
    expect(result.spec).toEqual(stored.spec);
  });

  it('concurrent appendIds calls preserve the union of requested cohort ids', async () => {
    const cupId = fleetSpecBeeKey('append-concurrent');
    await setClaimSpec({ cupId, spec: { ...DEFAULT_CLAIM_SPEC, revision: 10,
      view: { filter: { field: 'id', op: 'in', value: ['WI-incumbent'] } },
    } }, db.sql);
    const ids = Array.from({ length: 8 }, (_, index) => `WI-concurrent-${index}`);
    const results = await Promise.all(ids.map((id) => setClaimSpec({ cupId, appendIds: [id] }, db.sql)));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.map((result) => result.revision).sort((a, b) => a! - b!)).toEqual([11, 12, 13, 14, 15, 16, 17, 18]);
    const [stored] = await db.sql`SELECT spec, revision FROM harness_shared.cup_claim_specs
      WHERE workspace_id = 'default' AND bee_id = ${cupId}`;
    expect(stored.spec.view.filter.value).toHaveLength(9);
    expect(new Set(stored.spec.view.filter.value)).toEqual(new Set(['WI-incumbent', ...ids]));
    expect(stored.spec.revision).toBe(18);
    expect(stored.revision).toBe(18);
  });

  it('concurrent first appendIds calls bootstrap only the requested id union', async () => {
    const cupId = fleetSpecBeeKey('append-bootstrap');
    const ids = ['WI-first-a', 'WI-first-b', 'WI-first-c'];
    const results = await Promise.all(ids.map((id) => setClaimSpec({ cupId, appendIds: [id] }, db.sql)));
    expect(results.every((result) => result.ok)).toBe(true);
    const [stored] = await db.sql`SELECT spec, revision, id_only FROM harness_shared.cup_claim_specs
      WHERE workspace_id = 'default' AND bee_id = ${cupId}`;
    expect(stored.revision).toBe(3);
    expect(stored.spec.revision).toBe(3);
    expect(stored.id_only).toBe(true);
    expect(new Set(stored.spec.view.filter.value)).toEqual(new Set(ids));
    expect(stored.spec.view.filter.value).toHaveLength(3);
  });

  it('appendIds refuses dynamic lanes and admission failures without changing storage', async () => {
    const cupId = fleetSpecBeeKey('append-guarded');
    await setClaimSpec({ cupId, spec: DEFAULT_CLAIM_SPEC }, db.sql);
    expect(await setClaimSpec({ cupId, appendIds: ['WI-refused'] }, db.sql)).toMatchObject({ ok: false });
    const cohort = { ...DEFAULT_CLAIM_SPEC, revision: 5,
      view: { filter: { field: 'id', op: 'in', value: ['WI-old'] } },
    };
    await setClaimSpec({ cupId, spec: cohort }, db.sql);
    const validateAppend = vi.fn(async () => ({ errors: ['owner-action floor'] }));
    expect(await setClaimSpec({ cupId, appendIds: ['WI-refused'], validateAppend }, db.sql)).toMatchObject({
      ok: false, errors: ['owner-action floor'],
    });
    expect(validateAppend).toHaveBeenCalledWith({ ...cohort, revision: 6,
      view: { filter: { field: 'id', op: 'in', value: ['WI-old', 'WI-refused'] } },
    }, null);
    const [stored] = await db.sql`SELECT spec, revision FROM harness_shared.cup_claim_specs
      WHERE workspace_id = 'default' AND bee_id = ${cupId}`;
    expect(stored).toMatchObject({ spec: cohort, revision: 5 });
    const absent = fleetSpecBeeKey('append-guarded-absent');
    expect(await setClaimSpec({ cupId: absent, appendIds: ['WI-refused'], validateAppend }, db.sql)).toMatchObject({ ok: false });
    expect(await db.sql`SELECT 1 FROM harness_shared.cup_claim_specs WHERE workspace_id = 'default' AND bee_id = ${absent}`).toHaveLength(0);
  });

  it('bounds dedicated setup acquisition and recovers without running an expired setup', async () => {
    const cupId = 'su-scheduler-setup-starved';
    await setClaimSpec({ cupId, spec: DEFAULT_CLAIM_SPEC }, db.sql);
    // An already-held item prevents candidate writes on the successful control call.
    await db.sql`
      INSERT INTO harness_shared.work_items (workspace_id, feature_id, taken_by, status)
      VALUES ('default', 'EI-scheduler-setup-held', ${cupId}, 'open')
    `;
    const dedicated = postgres(db.url, { max: 1, prepare: false });
    h.claimSql = dedicated;
    // Prime the dedicated pool so the held-connection case below specifically
    // protects the warm 5s fail-fast path; cold first-use has its own bounded test.
    expect(
      await getNextForBee({
        cupId,
        harness: 'papercusp',
        useDedicatedClaimPool: true,
      }),
    ).toBeNull();
    const reserved = await dedicated.reserve();
    let released = false;
    const steps: string[] = [];
    try {
      const startedAt = Date.now();
      const attempt = getNextForBee({
        cupId,
        harness: 'papercusp',
        useDedicatedClaimPool: true,
        onClaimStep: (step) => {
          steps.push(step);
        },
      });
      await expect(attempt).rejects.toMatchObject({
        name: 'OrgTxnTimeoutError',
        timeoutSource: 'caller-budget',
        message: expect.stringContaining('no claim was attempted'),
      });
      expect(Date.now() - startedAt).toBeLessThan(SCHEDULER_CLAIM_SETUP_BUDGET_MS + 3_000);
      expect(steps).toEqual(['claim-setup-acquisition']);

      // Release the exact connection we deliberately held. The late BEGIN must roll
      // back before it invokes setup, then the same pool must serve a fresh request.
      reserved.release();
      released = true;
      expect(await dedicated`SELECT 1 AS n`).toEqual([{ n: 1 }]);
      expect(steps).toEqual(['claim-setup-acquisition']);
      expect(
        await getNextForBee({
          cupId,
          harness: 'papercusp',
          useDedicatedClaimPool: true,
          onClaimStep: (step) => {
            steps.push(step);
          },
        }),
      ).toBeNull();
      expect(steps).toEqual([
        'claim-setup-acquisition',
        'claim-setup-acquisition',
        'claim-spec-read',
        'claim-concurrency-read',
      ]);
      expect(await countActiveClaimsForBee({ cupId }, db.sql)).toBe(1);
    } finally {
      if (!released) reserved.release();
      h.claimSql = undefined;
      await dedicated.end({ timeout: 2 });
      await db.sql`DELETE FROM harness_shared.work_items WHERE feature_id = 'EI-scheduler-setup-held'`;
    }
  }, 20_000);

  it('counts an active/parked claim but ignores terminal claims (EI-11796)', async () => {
    await db.sql`
      INSERT INTO harness_shared.work_items (workspace_id, feature_id, taken_by, status)
      VALUES ('default', 'EI-11796-active', 'su-bee-active', 'open'),
             ('default', 'EI-11796-done', 'su-bee-active', 'resolved')`;

    expect(await countActiveClaimsForBee({ cupId: 'su-bee-active' }, db.sql)).toBe(1);

    await db.sql`
      UPDATE harness_shared.work_items SET status = 'closed'
       WHERE feature_id = 'EI-11796-active'`;
    expect(await countActiveClaimsForBee({ cupId: 'su-bee-active' }, db.sql)).toBe(0);
  });

  // WI-1250584: the terminal-status exclusion list drifted from the canonical
  // ALL_TERMINAL_STATUSES set (work-item-blocking.ts) — it had 'passed'/'deprecated'/
  // 'resolved'/'closed' but was missing 'done' and 'dropped', so a `taken_by`-tagged
  // row left in either of THOSE two terminal statuses (e.g. a system-created
  // resource-governor admission receipt, or any ordinary issue-family item closed via
  // 'done') was miscounted as an active claim forever, permanently pinning a bee's
  // concurrency slot even though the item was already finished.
  it("does not count 'done' or 'dropped' rows as active claims (WI-1250584)", async () => {
    await db.sql`
      INSERT INTO harness_shared.work_items (workspace_id, feature_id, taken_by, status)
      VALUES ('default', 'WI-1250584-done', 'su-bee-terminal-drift', 'done'),
             ('default', 'WI-1250584-dropped', 'su-bee-terminal-drift', 'dropped')`;

    expect(await countActiveClaimsForBee({ cupId: 'su-bee-terminal-drift' }, db.sql)).toBe(0);
  });

  // EI-21895667973178286: a resource-governor admission receipt (title 'Queued agent
  // admission' / 'Queued inference admission', payload.claim_hold_by = 'system:resource-
  // governor') is bookkeeping for the bee's OWN spawn/inference-call admission, not real
  // work. Left ACTIVE ('wip') it consumed the bee's only concurrency slot under the
  // default cap of 1, so a freshly spawned bee's first scheduler:get_next refused before
  // evaluating any lane. A real active claim alongside it must still count.
  it('does not count an active resource-governor admission receipt as a claim, but counts real work beside it (EI-21895667973178286)', async () => {
    await db.sql`
      INSERT INTO harness_shared.work_items (workspace_id, feature_id, taken_by, status, payload)
      VALUES ('default', 'WI-governor-receipt', 'su-bee-governor', 'wip',
              '{"claim_hold_by": "system:resource-governor", "_claimHold": true}'::jsonb)`;
    expect(await countActiveClaimsForBee({ cupId: 'su-bee-governor' }, db.sql)).toBe(0);

    await db.sql`
      INSERT INTO harness_shared.work_items (workspace_id, feature_id, taken_by, status)
      VALUES ('default', 'WI-real-work', 'su-bee-governor', 'wip')`;
    expect(await countActiveClaimsForBee({ cupId: 'su-bee-governor' }, db.sql)).toBe(1);
  });

  // EI-21902965465306743: readClaimConcurrencyBatch (fleet:leader-brief's per-member
  // concurrency read) had DRIFTED from getActiveClaimsForBee's WHERE clause — it kept the
  // pre-WI-1250584/pre-EI-21895667973178286 literal terminal-status list and carried NO
  // claim_hold_by exclusion at all. These three cases mirror the countActiveClaimsForBee
  // tests above 1:1 against the batch reader so the two queries cannot silently diverge
  // again without a red test on both sides.
  describe('readClaimConcurrencyBatch (EI-21902965465306743 — must not diverge from getActiveClaimsForBee)', () => {
    it('counts an active claim but ignores a terminal one, for a batch of bees', async () => {
      await db.sql`
        INSERT INTO harness_shared.work_items (workspace_id, feature_id, taken_by, status)
        VALUES ('default', 'EI-21902965-batch-active', 'su-bee-batch-active', 'open'),
               ('default', 'EI-21902965-batch-done', 'su-bee-batch-terminal', 'resolved')`;

      const verdicts = await readClaimConcurrencyBatch(
        { cupIds: ['su-bee-batch-active', 'su-bee-batch-terminal'] },
        db.sql,
      );
      expect(verdicts.get('su-bee-batch-active')).toMatchObject({ blocked: true, activeClaims: 1 });
      expect(verdicts.get('su-bee-batch-terminal')).toMatchObject({ blocked: false, activeClaims: 0 });
    });

    it("does not count 'done' or 'dropped' rows as active claims (the WI-1250584 half)", async () => {
      await db.sql`
        INSERT INTO harness_shared.work_items (workspace_id, feature_id, taken_by, status)
        VALUES ('default', 'EI-21902965-done', 'su-bee-batch-done-dropped', 'done'),
               ('default', 'EI-21902965-dropped', 'su-bee-batch-done-dropped', 'dropped')`;

      const verdicts = await readClaimConcurrencyBatch({ cupIds: ['su-bee-batch-done-dropped'] }, db.sql);
      expect(verdicts.get('su-bee-batch-done-dropped')).toMatchObject({ blocked: false, activeClaims: 0 });
    });

    it('does not count an active resource-governor admission receipt, but counts real work beside it (the EI-21895667973178286 half)', async () => {
      await db.sql`
        INSERT INTO harness_shared.work_items (workspace_id, feature_id, taken_by, status, payload)
        VALUES ('default', 'EI-21902965-governor-receipt', 'su-bee-batch-governor', 'wip',
                '{"claim_hold_by": "system:resource-governor", "_claimHold": true}'::jsonb)`;
      let verdicts = await readClaimConcurrencyBatch({ cupIds: ['su-bee-batch-governor'] }, db.sql);
      expect(verdicts.get('su-bee-batch-governor')).toMatchObject({ blocked: false, activeClaims: 0 });

      await db.sql`
        INSERT INTO harness_shared.work_items (workspace_id, feature_id, taken_by, status)
        VALUES ('default', 'EI-21902965-real-work', 'su-bee-batch-governor', 'wip')`;
      verdicts = await readClaimConcurrencyBatch({ cupIds: ['su-bee-batch-governor'] }, db.sql);
      expect(verdicts.get('su-bee-batch-governor')).toMatchObject({ blocked: true, activeClaims: 1 });
    });

    it('a cupId with no held rows is still present in the map, with blocked:false', async () => {
      const verdicts = await readClaimConcurrencyBatch({ cupIds: ['su-bee-batch-never-claimed'] }, db.sql);
      expect(verdicts.has('su-bee-batch-never-claimed')).toBe(true);
      expect(verdicts.get('su-bee-batch-never-claimed')).toMatchObject({ blocked: false, activeClaims: 0 });
    });
  });

  // P-010 (parked-agent-census-resumption-and-root-cause-2026-10-09 D-010): a held row that is
  // blocked/needs-human WITH an active typed external blocker stops consuming a concurrent-claim
  // slot; it is reported as blockerParkedIds instead. Everything EI-11796 protects still counts:
  // a wip row carrying a blocker, a plain blocked park, and a blocked row whose blocker cleared.
  // The blocker records come from the canonical writer, so the fixture cannot drift from the
  // shape work_items:set_blocker persists.
  describe('P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot', () => {
    const cupId = 'su-bee-p010-blocker-parked';
    const actor = 'su-p010-test';
    const ref = 'event:p010-test-upstream';
    const active = updateExternalBlockerHistory(
      {},
      { kind: 'event', ref, summary: 'waiting on an upstream event' },
      actor,
    ).blockers;
    const cleared = updateExternalBlockerHistory({ externalBlockers: active }, { kind: 'event', ref, clear: true }, actor)
      .blockers;
    const withBlockers = (blockers: unknown) => JSON.stringify({ externalBlockers: blockers });

    beforeAll(async () => {
      expect(active.map((b) => b.status)).toEqual(['active']);
      expect(cleared.map((b) => b.status)).toEqual(['cleared']);
      await db.sql`
        INSERT INTO harness_shared.work_items (workspace_id, feature_id, taken_by, status, payload)
        VALUES ('default', 'P010-blocked-ext', ${cupId}, 'blocked', ${withBlockers(active)}::text::jsonb),
               ('default', 'P010-needs-human-ext', ${cupId}, 'needs-human', ${withBlockers(active)}::text::jsonb),
               ('default', 'P010-wip-ext', ${cupId}, 'wip', ${withBlockers(active)}::text::jsonb),
               ('default', 'P010-blocked-plain', ${cupId}, 'blocked', NULL),
               ('default', 'P010-blocked-cleared', ${cupId}, 'blocked', ${withBlockers(cleared)}::text::jsonb)`;
      // Bound via ::text::jsonb (as work-item-blocker-reaper.ts does): this test client would
      // otherwise JSON-encode the string a second time and store a jsonb STRING scalar
      // (EI-20633798408131012), which no reader can see as an externalBlockers array.
      const [shape] = await db.sql<{ t: string }[]>`
        SELECT jsonb_typeof(payload->'externalBlockers') AS t
          FROM harness_shared.work_items WHERE feature_id = 'P010-blocked-ext'`;
      expect(shape?.t).toBe('array');
    });

    it('counts only the rows its holder is not parked on externally', async () => {
      expect(await countActiveClaimsForBee({ cupId }, db.sql)).toBe(3);
    });

    it('readClaimConcurrency names the parked rows and leaves them out of activeClaims', async () => {
      const verdict = await readClaimConcurrency({ cupId, maxConcurrentClaims: 3 }, db.sql);
      expect(verdict).toMatchObject({ blocked: true, activeClaims: 3, maxConcurrentClaims: 3 });
      expect([...verdict.heldIds].sort()).toEqual(['P010-blocked-cleared', 'P010-blocked-plain', 'P010-wip-ext']);
      expect([...verdict.blockerParkedIds].sort()).toEqual(['P010-blocked-ext', 'P010-needs-human-ext']);
      // The two parked rows would have pinned this bee at a cap of 4 before P-010; now it has room.
      expect(await readClaimConcurrency({ cupId, maxConcurrentClaims: 4 }, db.sql)).toMatchObject({
        blocked: false,
        activeClaims: 3,
      });
    });

    it('readClaimConcurrencyBatch returns the same verdict as the single-bee reader', async () => {
      const single = await readClaimConcurrency({ cupId, maxConcurrentClaims: 3 }, db.sql);
      const batch = (await readClaimConcurrencyBatch({ cupIds: [cupId], maxConcurrentClaims: 3 }, db.sql)).get(cupId);
      expect(batch).toBeDefined();
      expect({ ...batch!, heldIds: [...batch!.heldIds].sort(), blockerParkedIds: [...batch!.blockerParkedIds].sort() })
        .toEqual({ ...single, heldIds: [...single.heldIds].sort(), blockerParkedIds: [...single.blockerParkedIds].sort() });
    });

    it('Luna: clearing a typed blocker restores cap2 counting without changing custody or the member override', async () => {
      const holder = 'su-luna-clearance-owner';
      const nextHolder = 'su-luna-reassigned-owner';
      const spec = { ...DEFAULT_CLAIM_SPEC, limits: { maxConcurrentClaims: 2 } };
      expect((await setClaimSpec({ cupId: holder, spec }, db.sql)).ok).toBe(true);
      await db.sql`
        INSERT INTO harness_shared.work_items (workspace_id, feature_id, taken_by, status, payload)
        VALUES ('default', 'LUNA-cap-active', ${holder}, 'wip', NULL),
               ('default', 'LUNA-cap-blocked', ${holder}, 'blocked', ${withBlockers(active)}::text::jsonb),
               ('default', 'LUNA-cap-needs-human', ${holder}, 'needs-human', ${withBlockers(active)}::text::jsonb)`;
      const before = await readClaimConcurrency({ cupId: holder, maxConcurrentClaims: 2 }, db.sql);
      expect(before).toMatchObject({ activeClaims: 1, maxConcurrentClaims: 2, blocked: false });
      expect(before.heldIds).toEqual(['LUNA-cap-active']);
      expect([...before.blockerParkedIds].sort()).toEqual(['LUNA-cap-blocked', 'LUNA-cap-needs-human']);

      await db.sql`UPDATE harness_shared.work_items SET payload = ${withBlockers(cleared)}::text::jsonb
        WHERE workspace_id = 'default' AND feature_id = 'LUNA-cap-blocked'`;
      const after = await readClaimConcurrency({ cupId: holder, maxConcurrentClaims: 2 }, db.sql);
      expect(after).toMatchObject({ activeClaims: 2, maxConcurrentClaims: 2, blocked: true });
      expect([...after.heldIds].sort()).toEqual(['LUNA-cap-active', 'LUNA-cap-blocked']);
      expect(after.blockerParkedIds).toEqual(['LUNA-cap-needs-human']);
      const owners = await db.sql<{ taken_by: string }[]>`SELECT taken_by FROM harness_shared.work_items
        WHERE workspace_id = 'default' AND feature_id IN ('LUNA-cap-active', 'LUNA-cap-blocked', 'LUNA-cap-needs-human')`;
      expect(owners.map(row => row.taken_by)).toEqual([holder, holder, holder]);
      expect((await getClaimSpec({ cupId: holder }, db.sql)).limits).toEqual({ maxConcurrentClaims: 2 });

      await db.sql`UPDATE harness_shared.work_items SET taken_by = ${nextHolder}
        WHERE workspace_id = 'default' AND feature_id = 'LUNA-cap-blocked'`;
      expect(await readClaimConcurrency({ cupId: holder, maxConcurrentClaims: 2 }, db.sql))
        .toMatchObject({ activeClaims: 1, blocked: false, heldIds: ['LUNA-cap-active'] });
      expect(await readClaimConcurrency({ cupId: nextHolder, maxConcurrentClaims: 2 }, db.sql))
        .toMatchObject({ activeClaims: 1, blocked: false, heldIds: ['LUNA-cap-blocked'], blockerParkedIds: [] });
      expect((await getClaimSpec({ cupId: holder }, db.sql)).limits).toEqual({ maxConcurrentClaims: 2 });
    });
  });

  it('stores a valid spec, returns it, and bumps the revision on re-steer', async () => {
    const r1 = await setClaimSpec({ cupId: 'su-bee-1', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'mug' }, db.sql);
    expect(r1.ok).toBe(true);
    expect(r1.revision).toBe(DEFAULT_CLAIM_SPEC.revision);

    const got = await getClaimSpec({ cupId: 'su-bee-1' }, db.sql);
    expect(got.specVersion).toBe(DEFAULT_CLAIM_SPEC.specVersion);
    expect(got.specId).toBe(DEFAULT_CLAIM_SPEC.specId);

    const r2 = await setClaimSpec({ cupId: 'su-bee-1', spec: DEFAULT_CLAIM_SPEC }, db.sql);
    expect(r2.ok).toBe(true);
    expect(r2.revision).toBe((r1.revision ?? 0) + 1);
  });

  it('returns DEFAULT_CLAIM_SPEC for a bee with no stored spec', async () => {
    expect(await getClaimSpec({ cupId: 'no-such-bee' }, db.sql)).toEqual(DEFAULT_CLAIM_SPEC);
  });

  it('rejects an invalid spec (the validation gate) and stores nothing', async () => {
    const r = await setClaimSpec({ cupId: 'su-bee-2', spec: { garbage: true } }, db.sql);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(await getClaimSpec({ cupId: 'su-bee-2' }, db.sql)).toEqual(DEFAULT_CLAIM_SPEC);
  });
});

describe('getClaimSpecRecord (EI-7678 — the READ verb behind scheduler:get_claim_spec)', () => {
  it('returns source:"cup" + the full row metadata for a bee with an explicit spec', async () => {
    await setClaimSpec({ cupId: 'su-rec-1', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'leader-x' }, db.sql);
    const rec = await getClaimSpecRecord({ cupId: 'su-rec-1' }, db.sql);
    expect(rec.source).toBe('cup');
    expect(rec.spec.specId).toBe(DEFAULT_CLAIM_SPEC.specId);
    expect(rec.revision).toBe(DEFAULT_CLAIM_SPEC.revision);
    expect(rec.updatedBy).toBe('leader-x');
    expect(rec.updatedAt).not.toBeNull();
    expect(rec.harnessSlug ?? null).toBeNull(); // operator-scope (no potSlug passed)
    expect(rec.fleetSlug).toBeUndefined();
  });

  it('reads future top-level fields with a warning without mutating the stored spec', async () => {
    const cupId = 'su-rec-forward-read';
    await setClaimSpec({ cupId, spec: DEFAULT_CLAIM_SPEC }, db.sql);
    await db.sql.unsafe(
      "UPDATE harness_shared.cup_claim_specs SET spec = spec || '{\"futureLane\":\"verification\"}'::jsonb " +
        "WHERE workspace_id = 'default' AND bee_id = 'su-rec-forward-read'",
    );

    const rec = await getClaimSpecRecord({ cupId }, db.sql);
    expect(rec.spec.specId).toBe(DEFAULT_CLAIM_SPEC.specId);
    expect(rec.spec).not.toHaveProperty('futureLane');
    expect(rec.warnings?.some((warning) => warning.includes('futureLane'))).toBe(true);
    const storedRows = (await db.sql.unsafe(
      "SELECT spec FROM harness_shared.cup_claim_specs WHERE workspace_id = 'default' AND bee_id = 'su-rec-forward-read'",
    )) as Array<{ spec: Record<string, unknown> }>;
    expect(storedRows[0]?.spec.futureLane).toBe('verification');

    const rejectedWrite = await setClaimSpec({
      cupId: 'su-rec-forward-write',
      spec: { ...DEFAULT_CLAIM_SPEC, futureLane: 'verification' },
    }, db.sql);
    expect(rejectedWrite.ok).toBe(false);

    const fleetSlug = 'forward-read-fleet';
    const fleetKey = fleetSpecBeeKey(fleetSlug);
    await setClaimSpec({ cupId: fleetKey, spec: DEFAULT_CLAIM_SPEC }, db.sql);
    await db.sql.unsafe(
      "UPDATE harness_shared.cup_claim_specs SET spec = spec || '{\"futureLane\":\"verification\"}'::jsonb " +
        "WHERE workspace_id = 'default' AND bee_id = 'fleet:forward-read-fleet'",
    );
    const resolved = await resolveFleetClaimSpec({ spec: fleetSlug }, db.sql);
    expect(resolved?.record.spec.specId).toBe(DEFAULT_CLAIM_SPEC.specId);
    expect(resolved?.record.warnings?.some((warning) => warning.includes('futureLane'))).toBe(true);
  });

  it('the revision bumps are visible on re-read (confirms a re-steer landed)', async () => {
    await setClaimSpec({ cupId: 'su-rec-2', spec: DEFAULT_CLAIM_SPEC }, db.sql);
    const before = await getClaimSpecRecord({ cupId: 'su-rec-2' }, db.sql);
    await setClaimSpec({ cupId: 'su-rec-2', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'leader-y' }, db.sql);
    const after = await getClaimSpecRecord({ cupId: 'su-rec-2' }, db.sql);
    expect(after.revision).toBe((before.revision ?? 0) + 1);
    expect(after.updatedBy).toBe('leader-y');
  });

  // EI-18694186565089433: the revision was stored TWICE (the column, bumped
  // atomically on every write, and a `revision` field embedded inside the spec
  // JSONB, which the read-edit-write pattern setClaimSpec forces on every caller
  // carried forward verbatim) — so the embedded copy fell one write behind the
  // column on every re-steer. Confirmed live: set_claim_spec returned revision 6
  // (the column) while every following get_claim_spec read reported
  // spec.revision 5 (the stale embedded copy) — a leader could not trust its own
  // re-steer, and a member's stale-revision report was wrongly dismissed as a
  // "timeline artifact".
  it('EI-18694186565089433: rec.spec.revision matches rec.revision after a re-steer (no divergence)', async () => {
    await setClaimSpec({ cupId: 'su-rec-3', spec: DEFAULT_CLAIM_SPEC }, db.sql);
    await setClaimSpec({ cupId: 'su-rec-3', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'leader-w' }, db.sql);
    const rec = await getClaimSpecRecord({ cupId: 'su-rec-3' }, db.sql);
    expect(rec.revision).toBe(1);
    expect(rec.spec.revision).toBe(rec.revision); // the two copies must never diverge

    // The fix is not just at the read boundary — the STORED jsonb itself carries
    // the correct value, so a raw SQL read (dev:pg_query, psql) sees the same
    // number the authoritative column does, instead of a permanently-one-behind
    // embedded copy.
    const [row] = await db.sql<{ revision: number; embedded_revision: number }[]>`
      SELECT revision, (spec->>'revision')::int AS embedded_revision
        FROM harness_shared.cup_claim_specs
       WHERE workspace_id = 'default' AND bee_id = 'su-rec-3'`;
    expect(row!.embedded_revision).toBe(row!.revision);
  });

  it('EI-18694186565089433: getClaimSpec (the bare-spec resolver, no record wrapper) also returns the stamped revision', async () => {
    await setClaimSpec({ cupId: 'su-rec-4', spec: DEFAULT_CLAIM_SPEC }, db.sql);
    await setClaimSpec({ cupId: 'su-rec-4', spec: DEFAULT_CLAIM_SPEC }, db.sql);
    const spec = await getClaimSpec({ cupId: 'su-rec-4' }, db.sql);
    expect(spec.revision).toBe(1);
  });

  it('returns source:"default" (DEFAULT_CLAIM_SPEC, no metadata) for a bee/fleet with no stored spec', async () => {
    const rec = await getClaimSpecRecord({ cupId: 'no-such-bee-rec' }, db.sql);
    expect(rec).toEqual({
      source: 'default',
      spec: DEFAULT_CLAIM_SPEC,
      revision: null,
      updatedBy: null,
      updatedAt: null,
    });
  });

  it('reads a FLEET-level spec directly via its sentinel key (fleetSpecBeeKey)', async () => {
    const fleetKey = fleetSpecBeeKey('drain-fleet-x');
    await setClaimSpec({ cupId: fleetKey, spec: DEFAULT_CLAIM_SPEC, updatedBy: 'leader-z' }, db.sql);
    const rec = await getClaimSpecRecord({ cupId: fleetKey }, db.sql);
    expect(rec.source).toBe('fleet');
    expect(rec.fleetSlug).toBe('drain-fleet-x');
    expect(rec.updatedBy).toBe('leader-z');
  });
});

describe('resolveFleetClaimSpec (EI-18672834165659298 — resolve BOTH the fleet-slug and specId namespaces)', () => {
  it('resolves via the literal fleet SLUG (the sentinel bee_id)', async () => {
    await setClaimSpec(
      {
        cupId: fleetSpecBeeKey('drain-fleet-slug'),
        spec: { ...DEFAULT_CLAIM_SPEC, specId: 'drain-fleet-slug-lane' },
        updatedBy: 'leader-a',
      },
      db.sql,
    );
    const resolved = await resolveFleetClaimSpec({ spec: 'drain-fleet-slug' }, db.sql);
    expect(resolved).not.toBeNull();
    expect(resolved!.matchedBy).toBe('fleet-slug');
    expect(resolved!.fleetSlug).toBe('drain-fleet-slug');
    expect(resolved!.record.spec.specId).toBe('drain-fleet-slug-lane');
    expect(resolved!.record.source).toBe('fleet');
  });

  it('resolves via an already-prefixed fleet sentinel identifier', async () => {
    const fleetSlug = 'drain-fleet-prefixed-slug';
    await setClaimSpec(
      {
        cupId: fleetSpecBeeKey(fleetSlug),
        spec: { ...DEFAULT_CLAIM_SPEC, specId: 'drain-fleet-prefixed-lane' },
        updatedBy: 'leader-prefixed',
      },
      db.sql,
    );
    const resolved = await resolveFleetClaimSpec({ spec: fleetSpecBeeKey(fleetSlug) }, db.sql);
    expect(resolved).not.toBeNull();
    expect(resolved!.matchedBy).toBe('fleet-slug');
    expect(resolved!.fleetSlug).toBe(fleetSlug);
    expect(resolved!.record.spec.specId).toBe('drain-fleet-prefixed-lane');
  });

  it('EI-18694186565089433: a re-steered fleet spec also carries the stamped (non-diverged) revision', async () => {
    const cupId = fleetSpecBeeKey('drain-fleet-restamped');
    await setClaimSpec(
      { cupId, spec: { ...DEFAULT_CLAIM_SPEC, specId: 'drain-fleet-restamped-lane' }, updatedBy: 'leader-c' },
      db.sql,
    );
    await setClaimSpec(
      { cupId, spec: { ...DEFAULT_CLAIM_SPEC, specId: 'drain-fleet-restamped-lane' }, updatedBy: 'leader-c' },
      db.sql,
    );
    const resolved = await resolveFleetClaimSpec({ spec: 'drain-fleet-restamped' }, db.sql);
    expect(resolved).not.toBeNull();
    expect(resolved!.record.revision).toBe(1);
    expect(resolved!.record.spec.revision).toBe(resolved!.record.revision);
  });

  it("resolves via the spec's own specId when the caller passes THAT instead of the fleet slug (the field-reported bug)", async () => {
    await setClaimSpec(
      {
        cupId: fleetSpecBeeKey('p2p-release'),
        spec: { ...DEFAULT_CLAIM_SPEC, specId: 'p2p-release-lane' },
        updatedBy: 'leader-b',
      },
      db.sql,
    );
    // caller passes the specId ('p2p-release-lane'), NOT the fleet slug ('p2p-release') —
    // this is the exact trap the bug report describes (the specId is the more discoverable
    // value: it's what get_next's own refusal text prints).
    const resolved = await resolveFleetClaimSpec({ spec: 'p2p-release-lane' }, db.sql);
    expect(resolved).not.toBeNull();
    expect(resolved!.matchedBy).toBe('spec-id');
    expect(resolved!.fleetSlug).toBe('p2p-release');
    expect(resolved!.record.spec.specId).toBe('p2p-release-lane');
  });

  it('resolves a strict revN shorthand when exactly one live fleet spec has that revision', async () => {
    await setClaimSpec(
      {
        cupId: fleetSpecBeeKey('revision-alias-unique'),
        spec: { ...DEFAULT_CLAIM_SPEC, specId: 'revision-alias-unique-lane', revision: 870_001 },
        updatedBy: 'leader-revision',
      },
      db.sql,
    );
    const resolved = await resolveFleetClaimSpec({ spec: 'rev870001' }, db.sql);
    expect(resolved).not.toBeNull();
    expect(resolved!.matchedBy).toBe('revision-shorthand');
    expect(resolved!.fleetSlug).toBe('revision-alias-unique');
    expect(resolved!.record.revision).toBe(870_001);
  });

  it('fails a revN shorthand closed when more than one live fleet spec shares that revision', async () => {
    for (const fleet of ['revision-alias-ambiguous-a', 'revision-alias-ambiguous-b']) {
      await setClaimSpec(
        {
          cupId: fleetSpecBeeKey(fleet),
          spec: { ...DEFAULT_CLAIM_SPEC, specId: `${fleet}-lane`, revision: 870_002 },
          updatedBy: 'leader-revision',
        },
        db.sql,
      );
    }
    await expect(resolveFleetClaimSpec({ spec: 'rev870002' }, db.sql)).resolves.toBeNull();
  });

  it('an UNRECOGNIZED spec (neither namespace matches) returns null — never DEFAULT_CLAIM_SPEC', async () => {
    const resolved = await resolveFleetClaimSpec({ spec: 'totally-bogus-spec-xyz' }, db.sql);
    expect(resolved).toBeNull();
  });

  it('a per-BEE (non-fleet) spec is never matched by specId — the lookup is scoped to fleet: sentinels only', async () => {
    // A regular bee (not a fleet sentinel) with a spec whose specId happens to collide.
    await setClaimSpec({ cupId: 'su-plain-bee', spec: { ...DEFAULT_CLAIM_SPEC, specId: 'plain-bee-spec-id' } }, db.sql);
    const bySlug = await resolveFleetClaimSpec({ spec: 'su-plain-bee' }, db.sql);
    expect(bySlug).toBeNull(); // 'su-plain-bee' is not a fleet: sentinel bee_id
    const bySpecId = await resolveFleetClaimSpec({ spec: 'plain-bee-spec-id' }, db.sql);
    expect(bySpecId).toBeNull(); // the specId lookup only scans bee_id LIKE 'fleet:%' rows
  });
});

describe('listFleetClaimSpecCandidates (the "unrecognized spec" error diagnostic)', () => {
  it('lists fleet slug + specId pairs for every fleet-sentinel row', async () => {
    await setClaimSpec(
      { cupId: fleetSpecBeeKey('cand-fleet-1'), spec: { ...DEFAULT_CLAIM_SPEC, specId: 'cand-fleet-1-lane' } },
      db.sql,
    );
    await setClaimSpec(
      { cupId: fleetSpecBeeKey('cand-fleet-2'), spec: { ...DEFAULT_CLAIM_SPEC, specId: 'cand-fleet-2-lane' } },
      db.sql,
    );
    const candidates = await listFleetClaimSpecCandidates({}, db.sql);
    const slugs = candidates.map((c) => c.fleetSlug);
    expect(slugs).toContain('cand-fleet-1');
    expect(slugs).toContain('cand-fleet-2');
    const c1 = candidates.find((c) => c.fleetSlug === 'cand-fleet-1');
    expect(c1?.specId).toBe('cand-fleet-1-lane');
  });

  it('EI-21857753284071679: `revision` returns every fleet at that revision even when the default recency window would drop one', async () => {
    // Two fleets share revision N. Reproduce the field bug: with a tight `limit`, the default
    // (unfiltered) window can only show ONE of them — exactly the misleading "1 candidate"
    // symptom a caller sees for a genuinely-ambiguous revN shorthand.
    await setClaimSpec(
      { cupId: fleetSpecBeeKey('rev-collide-old'), spec: { ...DEFAULT_CLAIM_SPEC, specId: 'rev-collide-old-lane' } },
      db.sql,
    );
    // A steer bumps a spec's revision by 1 per call; three steers land 'rev-collide-old' and
    // 'rev-collide-new' on the SAME revision number without hand-picking one.
    await setClaimSpec({ cupId: fleetSpecBeeKey('rev-collide-old'), spec: DEFAULT_CLAIM_SPEC }, db.sql); // rev 1
    await setClaimSpec(
      { cupId: fleetSpecBeeKey('rev-collide-new'), spec: { ...DEFAULT_CLAIM_SPEC, specId: 'rev-collide-new-lane' } },
      db.sql,
    );
    await setClaimSpec({ cupId: fleetSpecBeeKey('rev-collide-new'), spec: DEFAULT_CLAIM_SPEC }, db.sql); // rev 1

    // A `limit:1` mimics the "collision fell outside the top-N recency window" symptom: the
    // default (unfiltered) call is allowed to return only ONE row, so it cannot reveal the
    // true match set for revision 1 — this is the bug, asserted as a baseline before the fix.
    const unfiltered = await listFleetClaimSpecCandidates({ limit: 1 }, db.sql);
    expect(unfiltered).toHaveLength(1);

    // `revision:1` must surface BOTH — the fix's whole point: the true ambiguity-causing set,
    // not whatever happened to be most-recently-updated.
    const filtered = await listFleetClaimSpecCandidates({ revision: 1 }, db.sql);
    const filteredSlugs = filtered.map((c) => c.fleetSlug);
    expect(filteredSlugs).toContain('rev-collide-old');
    expect(filteredSlugs).toContain('rev-collide-new');
    expect(filtered.every((c) => c.revision === 1)).toBe(true);
  });
});

describe('getClaimSpecHeadsForBees (the bee-runs spec join, P-001)', () => {
  it('returns specId@revision per bee with a stored spec (highest revision), absent otherwise', async () => {
    await setClaimSpec({ cupId: 'su-h1', spec: DEFAULT_CLAIM_SPEC }, db.sql); // revision 0
    await setClaimSpec({ cupId: 'su-h2', spec: DEFAULT_CLAIM_SPEC }, db.sql);
    await setClaimSpec({ cupId: 'su-h2', spec: DEFAULT_CLAIM_SPEC }, db.sql); // re-steer → revision 1

    const heads = await getClaimSpecHeadsForBees(['su-h1', 'su-h2', 'su-no-spec'], undefined, db.sql);
    expect(heads.get('su-h1')).toEqual({ specId: DEFAULT_CLAIM_SPEC.specId, revision: 0 });
    expect(heads.get('su-h2')).toEqual({ specId: DEFAULT_CLAIM_SPEC.specId, revision: 1 }); // highest revision wins
    expect(heads.has('su-no-spec')).toBe(false); // no stored spec ⇒ absent (⇒ DEFAULT ordering)
  });

  it('returns an empty map for no bees', async () => {
    expect(await getClaimSpecHeadsForBees([], undefined, db.sql)).toEqual(new Map());
  });
  it('P-016: a hive-scoped spec ENQUEUES a federation outbox row; operator-scope stays LOCAL', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    // operator-scope (potSlug null) — no capture (the mig-438 WHEN gate).
    await setClaimSpec({ cupId: 'su-bee-local', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'mug' }, db.sql);
    expect(
      await db.sql`SELECT 1 FROM harness_shared.substrate_outbox WHERE table_name='cup_claim_specs' AND key='su-bee-local'`,
    ).toHaveLength(0);
    // hive-scoped — one put outbox row keyed by bee_id, tagged with the hive home slug.
    await setClaimSpec({ cupId: 'su-bee-fed', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'mug', potSlug: 'my-hive' }, db.sql);
    const rows = await db.sql<{ op: string; key: string; harness_slug: string }[]>`
      SELECT op, key, harness_slug FROM harness_shared.substrate_outbox WHERE table_name='cup_claim_specs' AND key='su-bee-fed'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ op: 'put', key: 'su-bee-fed', harness_slug: 'my-hive' });
    // a re-steer (revision bump) of the hive-scoped spec captures again (UPDATE gate).
    await setClaimSpec({ cupId: 'su-bee-fed', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'mug', potSlug: 'my-hive' }, db.sql);
    expect(
      (
        await db.sql`SELECT 1 FROM harness_shared.substrate_outbox WHERE table_name='cup_claim_specs' AND key='su-bee-fed'`
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('L9 (P-058) — tombstone on scope-downgrade (cup_claim_specs re-home)', () => {
  it('re-homing a spec to a DIFFERENT hive scope federates a TOMBSTONE (del) to the OLD scope + a put to the NEW', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await setClaimSpec({ cupId: 'su-rehome', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'mug', potSlug: 'hiveA' }, db.sql);
    const r = await setClaimSpec(
      { cupId: 'su-rehome', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'mug', potSlug: 'hiveB' },
      db.sql,
    );
    expect(r.ok).toBe(true);
    const ops = await db.sql<{ op: string; harness_slug: string }[]>`
      SELECT op, harness_slug FROM harness_shared.substrate_outbox
       WHERE table_name='cup_claim_specs' AND key='su-rehome' ORDER BY id`;
    // put(hiveA) from the first author, then the re-home: del(hiveA) = the tombstone
    // to the OLD scope's peers, put(hiveB) = the spec under the NEW scope.
    expect(ops).toEqual([
      { op: 'put', harness_slug: 'hiveA' },
      { op: 'del', harness_slug: 'hiveA' },
      { op: 'put', harness_slug: 'hiveB' },
    ]);
    // The LOCAL row now lives under hive B, revision preserved-and-bumped.
    const [row] = await db.sql<{ harness_slug: string; revision: number; embedded_revision: number }[]>`
      SELECT harness_slug, revision, (spec->>'revision')::int AS embedded_revision
        FROM harness_shared.cup_claim_specs WHERE bee_id='su-rehome'`;
    expect(row.harness_slug).toBe('hiveB');
    expect(row.revision).toBe(DEFAULT_CLAIM_SPEC.revision + 1);
    // EI-18694186565089433: the re-home path (DELETE + fresh INSERT, not an
    // ON CONFLICT upsert) must ALSO stamp the computed nextRev into the stored
    // spec's own embedded revision — otherwise a scope change is exactly where
    // the two copies are born diverged (the column jumps to nextRev; a naive
    // re-insert of the caller's v.spec would keep the OLD embedded value).
    expect(row.embedded_revision).toBe(row.revision);
    // get_next reads the live row — one spec, under the new scope (no strand).
    expect(await getClaimSpec({ cupId: 'su-rehome' }, db.sql)).toMatchObject({ specId: DEFAULT_CLAIM_SPEC.specId });
  });

  it('DOWNGRADING a hive-scoped spec to operator-scope (null) still tombstones the old scope; the new local row is not federated', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await setClaimSpec({ cupId: 'su-downgrade', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'mug', potSlug: 'hiveA' }, db.sql);
    await setClaimSpec({ cupId: 'su-downgrade', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'mug', potSlug: null }, db.sql);
    const ops = await db.sql<{ op: string; harness_slug: string | null }[]>`
      SELECT op, harness_slug FROM harness_shared.substrate_outbox
       WHERE table_name='cup_claim_specs' AND key='su-downgrade' ORDER BY id`;
    // put(hiveA), then del(hiveA) tombstone; the re-insert is operator-scope (null
    // harness_slug) so its INSERT never trips the mig-438 WHEN gate → not captured.
    expect(ops).toEqual([
      { op: 'put', harness_slug: 'hiveA' },
      { op: 'del', harness_slug: 'hiveA' },
    ]);
    const [row] = await db.sql<{ harness_slug: string | null }[]>`
      SELECT harness_slug FROM harness_shared.cup_claim_specs WHERE bee_id='su-downgrade'`;
    expect(row.harness_slug).toBeNull();
  });

  it('a SAME-scope re-steer does NOT tombstone (only the in-place UPDATE capture)', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await setClaimSpec({ cupId: 'su-samescope', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'mug', potSlug: 'hiveA' }, db.sql);
    await setClaimSpec({ cupId: 'su-samescope', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'mug', potSlug: 'hiveA' }, db.sql);
    const ops = await db.sql<{ op: string }[]>`
      SELECT op FROM harness_shared.substrate_outbox
       WHERE table_name='cup_claim_specs' AND key='su-samescope' ORDER BY id`;
    expect(ops.map((o) => o.op)).toEqual(['put', 'put']); // no 'del' — no re-home
  });
});

describe('WI-1564 (LIVE-1 D5) — write+read+capture agree on the workspace partition', () => {
  const WS = 'papercusp-workspace';
  const HIVE = 'papercusp';

  it('resolveClaimSpecWorkspace: concrete ident passes through; null/"*"/empty fall to undefined (legacy default)', () => {
    expect(resolveClaimSpecWorkspace(WS)).toBe(WS);
    expect(resolveClaimSpecWorkspace(` ${WS} `)).toBe(WS);
    expect(resolveClaimSpecWorkspace('*')).toBeUndefined();
    expect(resolveClaimSpecWorkspace(null)).toBeUndefined();
    expect(resolveClaimSpecWorkspace(undefined)).toBeUndefined();
    expect(resolveClaimSpecWorkspace('  ')).toBeUndefined();
  });

  it('REGRESSION: a workspace-threaded hive-scoped write lands the ROW, the READ, and the OUTBOX capture all under that workspace', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    const r = await setClaimSpec(
      { cupId: 'wi1564-fed', workspaceId: WS, spec: DEFAULT_CLAIM_SPEC, updatedBy: 'mug', potSlug: HIVE },
      db.sql,
    );
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined(); // threaded correctly — nothing to warn about

    // ROW under the workspace partition (not 'default').
    const rows = await db.sql<{ workspace_id: string; harness_slug: string }[]>`
      SELECT workspace_id, harness_slug FROM harness_shared.cup_claim_specs WHERE bee_id = 'wi1564-fed'`;
    expect(rows).toEqual([{ workspace_id: WS, harness_slug: HIVE }]);

    // READ agrees: the same workspace sees the spec; the 'default' partition
    // does NOT (this asymmetry is exactly why BOTH handlers must thread it).
    expect(await getClaimSpec({ cupId: 'wi1564-fed', workspaceId: WS }, db.sql)).toMatchObject({
      specId: DEFAULT_CLAIM_SPEC.specId,
    });
    expect(await getClaimSpec({ cupId: 'wi1564-fed' }, db.sql)).toEqual(DEFAULT_CLAIM_SPEC);

    // CAPTURE agrees: the outbox row rides (WS, HIVE) — the handle the booted
    // drain actually serves. Under ('default', HIVE) it stranded forever (D5).
    const outbox = await db.sql<{ workspace_id: string; harness_slug: string; op: string }[]>`
      SELECT workspace_id, harness_slug, op FROM harness_shared.substrate_outbox
       WHERE table_name = 'cup_claim_specs' AND key = 'wi1564-fed'`;
    expect(outbox).toEqual([{ workspace_id: WS, harness_slug: HIVE, op: 'put' }]);
  });

  it('the strand combo (hive-scoped + default partition) still writes but returns the LOUD WI-1564 warning', async () => {
    const r = await setClaimSpec(
      { cupId: 'wi1564-strand', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'mug', potSlug: HIVE },
      db.sql,
    );
    expect(r.ok).toBe(true); // fail-soft: local get_next on 'default' still works
    expect(r.warning).toMatch(/NOT federate/);
    expect(r.warning).toMatch(/WI-1564/);
  });

  it('no warning for operator-scope (potSlug null) on the default partition — local-only is the intent there', async () => {
    const r = await setClaimSpec({ cupId: 'wi1564-local', spec: DEFAULT_CLAIM_SPEC, updatedBy: 'mug' }, db.sql);
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });
});

describe('M6 (P-055) — federated claim-spec steer-tier authz gate (bee-claim-spec projection)', () => {
  const HIVE = 'my-hive';
  type Tier = 'observe' | 'message' | 'wake' | 'steer';
  const specRow = (cupId: string) =>
    ({ harness_slug: HIVE, bee_id: cupId, spec: { ...DEFAULT_CLAIM_SPEC }, revision: 0, updated_by: 'mug' }) as never;
  const proj = (tier: Tier) =>
    buildBeeClaimSpecProjection({
      workspaceId: 'default',
      harnessSlug: HIVE, // hive-home-grained binding (== the federation slug)
      sql: db.sql,
      potHomeSlug: HIVE, // ⇒ enforcement active
      resolveCommsTier: async () => ({ tier, githubUserId: 4242 }),
    });
  const applied = async (cupId: string) =>
    (await db.sql`SELECT 1 FROM harness_shared.cup_claim_specs WHERE workspace_id='default' AND bee_id=${cupId}`)
      .length > 0;

  beforeEach(async () => {
    await db.sql`DELETE FROM harness_shared.cup_claim_specs WHERE bee_id LIKE 'm6-%'`;
  });

  it('a REMOTE spec from a BELOW-steer author (observe/message/wake) is NOT applied', async () => {
    for (const tier of ['observe', 'message', 'wake'] as Tier[]) {
      const bee = `m6-below-${tier}`;
      await proj(tier).writeToPg(specRow(bee), { authorPubkey: 'devA', origin: 'remote' });
      expect(await applied(bee)).toBe(false);
    }
  });

  it('a REMOTE spec from a STEER author IS applied (a claim spec is a steer-class action)', async () => {
    await proj('steer').writeToPg(specRow('m6-steer'), { authorPubkey: 'devA', origin: 'remote' });
    expect(await applied('m6-steer')).toBe(true);
  });

  it('a LOCAL-origin spec applies regardless of tier (the queen on THIS machine, ungated)', async () => {
    await proj('observe').writeToPg(specRow('m6-local'), { authorPubkey: 'devA', origin: 'local' });
    expect(await applied('m6-local')).toBe(true);
  });

  it("a NON-hive-bound projection stays full-passthrough (no gate — today's behavior)", async () => {
    const plain = buildBeeClaimSpecProjection({ workspaceId: 'default', harnessSlug: HIVE, sql: db.sql }); // no potHomeSlug
    await plain.writeToPg(specRow('m6-plain'), { authorPubkey: 'devA', origin: 'remote' });
    expect(await applied('m6-plain')).toBe(true);
  });

  it('a tier-resolve ERROR fails CLOSED (a steer-class action must not apply on doubt)', async () => {
    const errProj = buildBeeClaimSpecProjection({
      workspaceId: 'default',
      harnessSlug: HIVE,
      sql: db.sql,
      potHomeSlug: HIVE,
      resolveCommsTier: async () => {
        throw new Error('tier store down');
      },
    });
    await errProj.writeToPg(specRow('m6-err'), { authorPubkey: 'devA', origin: 'remote' });
    expect(await applied('m6-err')).toBe(false);
  });
});
