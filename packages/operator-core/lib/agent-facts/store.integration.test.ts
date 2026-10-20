/**
 * agent-facts store — REAL-PG regression guard for the SQL paths the unit tests
 * deliberately skip (they were "exercised by live-verify" — which is exactly how
 * the mig-461 arbiter break shipped: 461 rebuilt the identity index to 5 columns
 * under assertFact's 4-column ON CONFLICT spec, and EVERY assert errored at plan
 * time from 461's apply until 2026-07-03 with zero test coverage noticing).
 *
 * Applies the real agent_facts migrations (444 base, 455 shareable, 461
 * federation cols + 5-col identity, 462 fed_key) and pins:
 *   1. assertFact INSERTS against the live 461 identity index (the arbiter),
 *   2. a RE-assert takes the conflict-UPDATE path (same arbiter, refresh),
 *   3. the F1-1 federation identity: potHomeSlug lands in harness_slug and the
 *      row's to_jsonb (the capture wire shape) passes isAgentFactWireRow,
 *   4. H6 local-partition discipline: retract + cap-eviction never touch a
 *      foreign (source_hive NOT NULL) partition of the same identity.
 *
 * The capture trigger FUNCTION is stubbed no-op (its real body drags the whole
 * outbox dependency chain in; the wire SHAPE is asserted via to_jsonb directly).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { createFreshPgDb, applyMigrationsForTest, type FreshPgDb } from '../../test/_pg-helpers';

// These tests exercise the store's SQL and eviction ranking against a throwaway
// database. Owner notices are covered by notify-evicted.test.ts; letting this
// suite send them through the real coord adapter escapes the fixture and can
// reach the protected live org-admin pool.
vi.mock('./notify-evicted', () => ({
  notifyEvictedFactOwners: async () => [],
}));

// P-003: retract/supersede now cascades to closed work items. This fixture
// applies only the agent_facts migrations (no work_items table), and the cascade
// is covered by retraction-cascade.test.ts — record the store's calls instead, so
// this suite still pins that the hooks fire with the right fact identity.
const cascadeCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('./retraction-cascade', () => ({
  cascadeFactChange: async (_sql: unknown, e: Record<string, unknown>) => {
    cascadeCalls.push(e);
    return { ok: true, kind: e.kind, factRef: '', matched: 0, flagged: [], notified: [], failedRecipients: [], unnotifiable: [], truncated: false };
  },
  supersessionChangedBody: async () => true,
}));

import {
  assertFact,
  retractFact,
  findFactKeyMatches,
  findFactKeyElsewhere,
  foldFacts,
  foldFactsWithCensus,
  countLiveFacts,
  listFacts,
  foldDeadEndFacts,
  foldNeverDropFacts,
  NEVER_DROP_KEY_PREFIXES,
  renderFactsFold,
  factVersions,
  __setFactCapsForTests,
  FACT_PERMANENT_EXPIRY,
  FACT_VOLATILE_MAX_TTL_SEC,
  GUARD_RAIL_KEY_PREFIX,
  listLapsedWallFacts,
  sweepExpiredFacts,
  listConventionFacts,
  factCitationRef,
  listFactEvictionDisclosures,
  previewFactCapImpact,
  foldCodeNotesForPaths,
  type FactDependency,
} from './store';
import { isAgentFactWireRow } from '../sync/hyperbee/projections/agent-facts';
import { factsCellDelta } from './cells';
import { loadGuardRailProbes } from './guard-rail-probes';
import { assumptionSelectorsFor, resolveAssumptions } from './assumptions';

const WS = 'ws-facts-int';

/**
 * P-002: the caps this suite exercises the MECHANISM against.
 *
 * The production ordinary ceiling is deliberately ~14x working demand (5000),
 * and a cap test only means anything against a SATURATED scope — so at
 * production magnitude every saturation test below would insert 5000 rows,
 * making this suite's runtime a function of a number chosen for production
 * capacity reasons. Measured: the FIRST such test alone ran past 160s (and was
 * still going) where the whole file used to take seconds.
 *
 * These are small enough to saturate cheaply and large enough that the victim
 * ranking still has something to order. Every assertion below is written
 * relative to these names rather than to a literal, so the production constants
 * stay free to move without touching a single expectation.
 */
const CAP = 50;
const VOLATILE_CAP = 12;
__setFactCapsForTests({ ordinary: CAP, volatile: VOLATILE_CAP });
// Restore the production constants: the seam is pinned to the module record, so
// leaving it set would leak into any later suite that shares it.
afterAll(() => __setFactCapsForTests(null));

let db: FreshPgDb;

/**
 * ── VOLATILE-PARTITION TEST KIT (P-002 / D-004 §1) ────────────────────────────
 *
 * D-003 made the ORDINARY cap a refusal ceiling, so the eviction ranking
 * (confidence, then remaining-TTL FRACTION, then `updated_at`) no longer runs
 * on that partition at all. D-004 §1 rules that the ranking is RETAINED and is
 * now VOLATILE-ONLY — bounded snapshot churn is that partition's declared
 * purpose — and states plainly that it "is NOT dead code and must not be
 * 'finished' by a later cleanup".
 *
 * That ruling is only as good as its coverage: a mechanism with no test is
 * exactly what a later cleanup deletes. So every eviction/receipt/preview/
 * disclosure guard that used to prove itself against the ordinary partition is
 * ported here rather than dropped, and these helpers are what make the port
 * honest.
 *
 * ⚠ WHY SEEDING GOES THROUGH SQL AND NOT `assertFact`. A volatile write has its
 * `ttlSec` CLAMPED to FACT_VOLATILE_MAX_TTL_SEC (15 min), and ranking key 2 is
 * the remaining SHARE of declared life — `(expires_at - now()) / (expires_at -
 * created_at)`. Seeding a cohort through `assertFact` therefore gives every row
 * the same denominator and a fraction of ~1.0, which FLATTENS the very key the
 * ranking tests exist to discriminate on. They would still pass, on ties broken
 * by `updated_at` — i.e. they would silently degrade back into the
 * write-recency ranking WI-6935 (c) was written to kill. Seeding the two
 * timestamps directly is what keeps the fraction observable.
 */
function volatileMeasurement(ageSec = 0): string {
  return JSON.stringify({ subjectVolatile: true, measuredAt: new Date(Date.now() - ageSec * 1000).toISOString() });
}

type VolatileSeed = {
  key: string;
  confidence?: 'verified' | 'provisional' | 'suspected';
  /** Seconds of declared life this row has ALREADY spent (the fraction's numerator loss). */
  ageSec?: number;
  /** The row's DECLARED lifetime — the fraction's denominator. */
  ttlSec?: number;
  createdBy?: string;
  kind?: 'convention';
  body?: string;
  /** H6: a FOREIGN partition row, which no local sweep may ever touch. */
  sourceHive?: string;
};

/**
 * Insert volatile-partition rows with an explicit age and declared lifetime, so
 * a test can place each incumbent at a chosen point on the ranking.
 */
async function seedVolatile(scope: 'owner' | 'harness', scopeRef: string, seeds: VolatileSeed[]): Promise<void> {
  for (const seed of seeds) {
    const ageSec = seed.ageSec ?? 0;
    const ttlSec = seed.ttlSec ?? FACT_VOLATILE_MAX_TTL_SEC;
    await db.sql`
      INSERT INTO harness_shared.agent_facts
        (workspace_id, scope, scope_ref, key, body, created_by, created_at, updated_at,
         expires_at, confidence, kind, measurement, source_hive)
      VALUES (${WS}, ${scope}, ${scopeRef}, ${seed.key}, ${seed.body ?? 'a snapshot'},
              ${seed.createdBy ?? 'su-int'},
              now() - ${ageSec}::int * interval '1 second',
              now() - ${ageSec}::int * interval '1 second',
              now() + ${ttlSec - ageSec}::int * interval '1 second',
              ${seed.confidence ?? 'verified'}, ${seed.kind ?? null},
              ${volatileMeasurement(ageSec)}::text::jsonb, ${seed.sourceHive ?? null})`;
  }
}

/** `n` interchangeable volatile incumbents — the saturating cohort. */
function volatileCohort(n: number, seed: Omit<VolatileSeed, 'key'> & { prefix?: string } = {}): VolatileSeed[] {
  const { prefix = 'incumbent', ...rest } = seed;
  return Array.from({ length: n }, (_unused, i) => ({ ...rest, key: `${prefix}-${i}` }));
}

/** An `assertFact`/`previewFactCapImpact` input that lands in the VOLATILE partition. */
function volatileWrite(
  scope: 'owner' | 'harness',
  scopeRef: string,
  key: string,
  extra: Record<string, unknown> = {},
) {
  return {
    scope,
    scopeRef,
    workspaceId: WS,
    key,
    body: 'an arriving snapshot',
    createdBy: 'su-int',
    confidence: 'verified' as const,
    subjectVolatile: true,
    measuredAt: new Date(Date.now() - 1_000).toISOString(),
    ttlSec: FACT_VOLATILE_MAX_TTL_SEC,
    ...extra,
  } as Parameters<typeof assertFact>[0];
}

/** Live rows in one partition of a (scope, ref), plus how many were destroyed. */
async function partitionCensus(
  scope: 'owner' | 'harness',
  scopeRef: string,
  partition: 'volatile' | 'ordinary',
): Promise<{ live: number; evicted: number }> {
  const marker =
    partition === 'volatile'
      ? db.sql`measurement->'subjectVolatile' = 'true'::jsonb`
      : db.sql`measurement->'subjectVolatile' IS DISTINCT FROM 'true'::jsonb`;
  const [row] = await db.sql<{ live: number; evicted: number }[]>`
    SELECT count(*) FILTER (
             WHERE superseded_at IS NULL AND retracted_at IS NULL AND expires_at > now()
           )::int AS live,
           count(*) FILTER (WHERE evicted_at IS NOT NULL)::int AS evicted
      FROM harness_shared.agent_facts
     WHERE workspace_id = ${WS} AND scope = ${scope} AND coalesce(scope_ref, '') = ${scopeRef}
       AND source_hive IS NULL AND ${marker}`;
  return row;
}

beforeAll(async () => {
  db = await createFreshPgDb('agent-facts-store');
  // Stub the capture fn BEFORE 461/462 create triggers on it (no-op: the outbox
  // chain is out of scope; the wire shape is pinned via to_jsonb below).
  await db.sql.unsafe(`
    CREATE OR REPLACE FUNCTION harness_shared.capture_substrate_outbox() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
  `);
  // P-008 (c) / D-077: migration 693 attaches `stamp_local_federated_write` to
  // agent_facts, so the function must EXIST before that CREATE TRIGGER runs.
  // Stubbed rather than applying migration 314, which also attaches triggers to
  // tables (harness_features_consolidated, …) this deliberately-minimal fixture
  // does not have.
  //
  // ⚠ SCOPE OF THIS STUB — it mints a monotonically increasing, HLC-SHAPED token,
  // which is exactly the property the delta cursor depends on (D-012: an HLC is a
  // total order, so the cursor is one comparable string). It is NOT the real
  // clock: node-id entropy, hlc_recv drift-clamping and the origin='remote'
  // passthrough are 314/459/466/681's business, not this file's. Those are
  // verified against the REAL trigger on the real schema — a local write is
  // stamped, a remote op carrying its own fed_ts is left alone.
  await db.sql.unsafe(`
    CREATE SEQUENCE IF NOT EXISTS harness_shared.test_hlc_seq;
    CREATE OR REPLACE FUNCTION harness_shared.stamp_local_federated_write() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND NEW.fed_ts IS DISTINCT FROM OLD.fed_ts THEN RETURN NEW; END IF;
      IF COALESCE(NEW.origin, 'local') <> 'local' THEN RETURN NEW; END IF;
      NEW.fed_ts  := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
      NEW.fed_hlc := lpad(nextval('harness_shared.test_hlc_seq')::text, 15, '0') || ':00000:testnode';
      RETURN NEW;
    END $$;
  `);
  const migrations = [
    '444-agent-facts.sql',
    '455-agent-facts-shareable.sql',
    '461-agent-facts-federation.sql',
    '462-agent-facts-fed-key.sql',
    // ⚠ This list had DRIFTED from the real agent_facts migration set — 498,
    // 505 and 664 all touch this table and none were here, so the fixture DB
    // was a schema this store has not run against in production for months.
    // 505 is the one that bit: it adds the surrogate `id` PK, without which
    // P-008's version chain (`supersedes_id` → `id`) cannot even parse. A
    // fixture that lags the real schema is the same blind spot as a stale
    // ON CONFLICT spec — this file exists to catch exactly that.
    '498-agent-facts-replica-identity.sql',
    '505-agent-facts-surrogate-pk-replica-identity.sql',
    '574-agent-facts-audience-provenance.sql',
    '664-widen-fact-body-cap.sql',
    '671-add-agent-facts-confidence.sql',
    // P-008 (a): swaps the identity index for its PARTIAL form. This list is
    // exactly the guard that catches an ON CONFLICT spec drifting away from the
    // live index — the mig-461 break this file was written for.
    '689-agent-facts-append-versioning.sql',
    // P-008 (b): depends_on / kind / claim + the kind CHECK constraint and the
    // partial `agent_facts_kind` index. Added in the SAME edit as the migration,
    // which is the discipline the 498/505/664 drift above exists to enforce.
    '690-agent-facts-depends-on-kind-claim.sql',
    // P-018: the `enforcement` column + its tier CHECK. Same discipline again —
    // added in the same edit as the migration, so a drift between the tier
    // vocabulary in TypeScript and the one in the DB reds HERE.
    '692-agent-facts-convention-enforcement.sql',
    // P-008 (c) / D-077: `fed_hlc` + the stamp trigger — the migration that puts
    // agent_facts into the LWW regime its siblings were already in, so a fact
    // HAS a cell version to serve as the watermark cursor. Added in the SAME
    // edit as the migration, which is the discipline the 498/505/664 drift
    // comment above exists to enforce.
    '693-agent-facts-federation-stamp-regime.sql',
    // WI-6935 (b): `evicted_at` — stamped alongside `retracted_at` by the per-scope
    // cap so a machine eviction stops being indistinguishable from a deliberate
    // retract. Same discipline again: added in the SAME edit as the migration.
    '722-agent-facts-evicted-at.sql',
    // P-002 (agent-epistemics-2026-08-02): `settled_by` + the `undecidable` kind — the
    // durable "not decidable from available evidence, stop re-deriving" record, and the
    // exit condition that says what WOULD settle it. P-006's detector reads both off the
    // version chain, so this suite cannot exercise it without them.
    // ⚠ This entry was MISSING until 2026-08-02, which red-pinned the whole file after
    // migration 730 landed — the exact drift EI-18808675015292160's audit exists to name.
    '730-agent-facts-undecidable-kind.sql',
    // EI-20191740437408337: durable moving-subject snapshot metadata. Keep
    // this fixture list aligned with the live agent_facts migration set.
    '795-agent-facts-volatile-measurements.sql',
    // EI-20212953856919248: deliberate retractions retain their actor and reason.
    '801-agent-facts-retraction-reason.sql',
    // P-010: optional executable re-verification pair. The fixture audit makes
    // the store INSERT/SELECT shape and the real DB CHECK move together.
    '940-agent-facts-recheck-contract.sql',
    // P-004 (expensive-verification-loops): recheck may carry an executable `exec` probe;
    // the widened CHECK and the loader's partial index come with it.
    '1240-agent-facts-recheck-exec.sql',
  ];
  // EI-18808675015292160: applies the list (EI-6887 strip semantics unchanged)
  // but AUDITS it first against the real sql/ dir — so the "list DRIFTED from the
  // real agent_facts migration set" failure described above now reds by NAMING the
  // missing file, instead of surfacing as `column "..." does not exist`.
  await applyMigrationsForTest(db.sql, migrations, {
    label: 'agent-facts/store.integration.test.ts',
  });
});
afterAll(async () => {
  await db?.cleanup();
});
afterEach(async () => {
  await db.sql.unsafe('TRUNCATE harness_shared.agent_facts');
});

describe('wall lapse exact recovery reader', () => {
  it('measures reassertion or explicit retraction, preserving evicted, absent and foreign identities', async () => {
    const identity = { workspaceId: WS, scope: 'owner' as const, scopeRef: 'su-wall', key: 'wall:recovery' };
    await assertFact({ ...identity, body: 'Owner action pending', createdBy: 'su-int', ttlSec: 3600 }, db.sql);
    await db.sql`UPDATE harness_shared.agent_facts SET expires_at = now() - interval '1 day' WHERE key = ${identity.key}`;
    const lapsed = await listLapsedWallFacts({}, db.sql);
    expect(lapsed).toHaveLength(1);
    expect(lapsed[0]).toMatchObject({ ...identity, sourceHive: null });
    const read = () => listLapsedWallFacts({ recoveryFor: [identity] }, db.sql);
    expect((await read())[0].recovered).toBe(false);
    await assertFact({ ...identity, body: 'Wall reaffirmed', createdBy: 'su-int', ttlSec: 3600 }, db.sql);
    expect((await read())[0].recovered).toBe(true);
    expect(await listLapsedWallFacts({}, db.sql)).toEqual([]);
    await db.sql`UPDATE harness_shared.agent_facts SET expires_at = now() - interval '1 day'
      WHERE key = ${identity.key} AND superseded_at IS NULL`;
    await retractFact({ ...identity, reason: 'Explicit owner disposition', retractedBy: 'su-int' }, db.sql);
    expect((await read())[0].recovered).toBe(true);
    await db.sql`UPDATE harness_shared.agent_facts SET evicted_at = now()
      WHERE key = ${identity.key} AND superseded_at IS NULL`;
    expect((await read())[0].recovered).toBe(false);
    expect(await listLapsedWallFacts({ recoveryFor: [{ ...identity, scopeRef: 'su-other' }] }, db.sql)).toEqual([]);
    expect(await listLapsedWallFacts({ recoveryFor: [{ ...identity, sourceHive: 'peer' }] }, db.sql)).toEqual([]);
    await db.sql`INSERT INTO harness_shared.agent_facts
      (workspace_id, scope, scope_ref, key, body, created_by, expires_at, source_hive)
      VALUES (${WS}, 'owner', 'su-wall', ${identity.key}, 'Foreign wall still lapsed', 'su-peer',
        now() - interval '1 day', 'peer')`;
    expect((await listLapsedWallFacts({ recoveryFor: [{ ...identity, sourceHive: 'peer' }] }, db.sql))[0])
      .toMatchObject({ sourceHive: 'peer', recovered: false });
    expect(await listLapsedWallFacts({ recoveryFor: [] }, db.sql)).toEqual([]);
  });
});

// P-008 (c) / D-012 / D-077 — the cell version is minted by the REAL stamp
// trigger (mig 693) and must survive the fold, or the watermark surface has no
// cursor to advance. This is the leg that would have silently no-op'd if the
// trigger were stubbed: every fact would read cellVersion null and every delta
// would be empty forever, with all unit tests still green.
// P-004 / D-006. `foldFacts` is `ORDER BY updated_at DESC LIMIT n`, and it fed a
// renderer whose header ("### Standing facts") presents the slice as the population.
// Measured 2026-09-02 against the live table under the fold's own liveFactPredicate:
// scope `workspace` held 495 fold-eligible facts and returned 12 (2.4%, 483 never
// displayed); `harness:papercusp` held 366 and returned 12. P-002/D-003 stopped the
// ordinary partition evicting and raised its ceiling 200 -> 5000, so that residue now
// grows instead of being destroyed — which is what makes the missing disclosure
// load-bearing rather than cosmetic.
//
// These pin the CENSUS, which is the half that can silently rot: the renderer test
// in store.test.ts only proves the text renders once a census says `truncated`, and
// would stay green if the window function reported the post-LIMIT count (always ==
// shown ⇒ truncated always false ⇒ the disclosure never fires and nothing fails).
describe('P-004 / D-006: the fold reports the population it is a slice OF', () => {
  const SCOPE_REF = 'su-census';

  it('reports the TRUE live total beyond the LIMIT, and marks the fold truncated', async () => {
    for (let i = 0; i < 7; i++) {
      await assertFact(
        { ttlSec: 3600, scope: 'owner', scopeRef: SCOPE_REF, key: `census-${i}`, body: `b${i}`, createdBy: 'su-int', workspaceId: WS },
        db.sql,
      );
    }
    const { facts, census } = await foldFactsWithCensus(
      [{ scope: 'owner', scopeRef: SCOPE_REF }],
      { workspaceId: WS, limitPerSelector: 3, audiences: 'all' },
      db.sql,
    );
    expect(facts).toHaveLength(3);
    const c = census.find((x) => x.scopeRef === SCOPE_REF)!;
    expect(c.shown).toBe(3);
    // The whole point: 7, not 3. A window function is evaluated BEFORE the LIMIT,
    // which is what makes this free — and what a naive `count(*)` after LIMIT
    // would get wrong in the direction that reads as "nothing was dropped".
    expect(c.total).toBe(7);
    expect(c.truncated).toBe(true);
  });

  it('an UNtruncated scope reports truncated:false — silence must mean census, not unmeasured', async () => {
    await assertFact(
      { ttlSec: 3600, scope: 'owner', scopeRef: 'su-census-small', key: 'only', body: 'b', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const { census } = await foldFactsWithCensus(
      [{ scope: 'owner', scopeRef: 'su-census-small' }],
      { workspaceId: WS, limitPerSelector: 12, audiences: 'all' },
      db.sql,
    );
    const c = census.find((x) => x.scopeRef === 'su-census-small')!;
    expect(c.shown).toBe(1);
    expect(c.total).toBe(1);
    expect(c.truncated).toBe(false);
  });

  it('counts the FOLD population, not the raw table — a superseded tail is not a shortfall', async () => {
    const ref = 'su-census-superseded';
    // Same key twice: the first row is superseded, and liveFactPredicate excludes
    // it. If the census counted raw rows it would report total 2 of a 1-fact scope
    // and cry truncation at a fold that showed everything there was.
    await assertFact(
      { ttlSec: 3600, scope: 'owner', scopeRef: ref, key: 'corrected', body: 'v1', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    await assertFact(
      { ttlSec: 3600, scope: 'owner', scopeRef: ref, key: 'corrected', body: 'v2', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const { facts, census } = await foldFactsWithCensus(
      [{ scope: 'owner', scopeRef: ref }],
      { workspaceId: WS, limitPerSelector: 12, audiences: 'all' },
      db.sql,
    );
    expect(facts).toHaveLength(1);
    const c = census.find((x) => x.scopeRef === ref)!;
    expect(c.total).toBe(1);
    expect(c.truncated).toBe(false);
  });

  it('an EMPTY scope reports total 0 — the one reading that IS a census', async () => {
    const { facts, census } = await foldFactsWithCensus(
      [{ scope: 'owner', scopeRef: 'su-census-empty' }],
      { workspaceId: WS, audiences: 'all' },
      db.sql,
    );
    expect(facts).toHaveLength(0);
    const c = census.find((x) => x.scopeRef === 'su-census-empty')!;
    expect(c.total).toBe(0);
    expect(c.truncated).toBe(false);
  });
});

describe('P-008 (c) cell version (fed_hlc, migration 693)', () => {
  it('a locally-asserted fact gets an HLC cell version, and the fold serves it', async () => {
    await assertFact(
      { ttlSec: 3600, scope: 'harness', scopeRef: 'papercusp', key: 'cellv', body: 'b', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const folded = await foldFacts([{ scope: 'harness', scopeRef: 'papercusp' }], { workspaceId: WS }, db.sql);
    const f = folded.find((x) => x.key === 'cellv');
    expect(f).toBeDefined();
    expect(typeof f!.cellVersion).toBe('string');
    expect(f!.cellVersion).not.toBe('');
  });

  it('a CORRECTION mints a STRICTLY GREATER version — this is what makes it a delta cursor', async () => {
    await assertFact(
      { ttlSec: 3600, scope: 'harness', scopeRef: 'papercusp', key: 'moving', body: 'v1', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const first = (await foldFacts([{ scope: 'harness', scopeRef: 'papercusp' }], { workspaceId: WS }, db.sql)).find(
      (x) => x.key === 'moving',
    )!.cellVersion!;

    await assertFact(
      { ttlSec: 3600, scope: 'harness', scopeRef: 'papercusp', key: 'moving', body: 'v2', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const second = (await foldFacts([{ scope: 'harness', scopeRef: 'papercusp' }], { workspaceId: WS }, db.sql)).find(
      (x) => x.key === 'moving',
    )!.cellVersion!;

    // String comparison, because an HLC is a total order by construction — the
    // property that lets the cursor be one opaque token (D-012).
    expect(second > first).toBe(true);
  });

  it('the delta reports that correction as changed against the pre-correction cursor', async () => {
    await assertFact(
      { ttlSec: 3600, scope: 'harness', scopeRef: 'papercusp', key: 'watched', body: 'v1', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const before = await foldFacts([{ scope: 'harness', scopeRef: 'papercusp' }], { workspaceId: WS }, db.sql);
    // Bootstrap: records the position, reports nothing.
    const boot = factsCellDelta(before, '');
    expect(boot.changed).toEqual([]);

    await assertFact(
      { ttlSec: 3600, scope: 'harness', scopeRef: 'papercusp', key: 'watched', body: 'v2', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const after = await foldFacts([{ scope: 'harness', scopeRef: 'papercusp' }], { workspaceId: WS }, db.sql);
    const delta = factsCellDelta(after, boot.nextCursor);

    expect(delta.changed.map((f) => f.key)).toEqual(['watched']);
    expect(delta.changed[0].body).toBe('v2');
    expect(delta.nextCursor > boot.nextCursor).toBe(true);
  });
});

describe('assertFact against the REAL mig-461 identity index', () => {
  it('inserts (the arbiter matches the 5-column identity — the 461 regression)', async () => {
    const fact = await assertFact(
      { ttlSec: 3600,
        scope: 'harness',
        scopeRef: 'papercusp',
        key: 'k1',
        body: 'b1',
        createdBy: 'su-int',
        workspaceId: WS,
      },
      db.sql,
    );
    expect(fact.key).toBe('k1');
  });

  it('a RE-assert APPENDS a version and leaves exactly ONE current (P-008 a — was: conflict-UPDATE)', async () => {
    // Was "takes the conflict-UPDATE path (refresh)" and asserted count === 1.
    // Migration 689 replaced that path: a correction no longer overwrites, so
    // the row count is now the VERSION count and "one live value per identity"
    // is carried by the partial unique index instead.
    const base = {
      scope: 'workspace' as const,
      key: 'k2',
      createdBy: 'su-int',
      workspaceId: WS,
    };
    await assertFact({ ttlSec: 3600, ...base, body: 'first' }, db.sql);
    const updated = await assertFact({ ttlSec: 3600, ...base, body: 'second' }, db.sql);
    expect(updated.body).toBe('second');
    const all = await db.sql`SELECT count(*)::int AS n FROM harness_shared.agent_facts WHERE key = 'k2'`;
    expect(all[0].n).toBe(2); // appended, not overwritten
    const live =
      await db.sql`SELECT count(*)::int AS n FROM harness_shared.agent_facts WHERE key = 'k2' AND superseded_at IS NULL`;
    expect(live[0].n).toBe(1); // exactly one CURRENT version
  });

  it('F1-1: potHomeSlug stamps harness_slug and the wire shape validates on peers', async () => {
    await assertFact(
      { ttlSec: 3600,
        scope: 'harness',
        scopeRef: 'member-a',
        key: 'shared-1',
        body: 'a shareable conclusion',
        createdBy: 'su-int',
        workspaceId: WS,
        shareable: true,
        potHomeSlug: 'the-hive-home',
      },
      db.sql,
    );
    const rows = await db.sql`
      SELECT harness_slug, to_jsonb(agent_facts) AS wire
        FROM harness_shared.agent_facts WHERE key = 'shared-1'`;
    expect(rows[0].harness_slug).toBe('the-hive-home');
    // The capture serializes to_jsonb(row) — the exact value peers decode.
    expect(isAgentFactWireRow(rows[0].wire)).toBe(true);
  });

  it('a later assert WITHOUT the slug keeps the stamped federation identity', async () => {
    const base = {
      scope: 'harness' as const,
      scopeRef: 'member-a',
      key: 'keep-slug',
      createdBy: 'su-int',
      workspaceId: WS,
    };
    await assertFact({ ttlSec: 3600, ...base, body: 'v1', shareable: true, potHomeSlug: 'home' }, db.sql);
    await assertFact({ ttlSec: 3600, ...base, body: 'v2', shareable: true }, db.sql);
    // P-008 (a): must name the CURRENT version explicitly — there are now two
    // rows for this identity, and an unqualified `rows[0]` would be reading an
    // arbitrary one. The carry-forward moved from the UPDATE branch's COALESCE
    // to a subquery over the superseded row, so this is the test that pins it.
    const rows = await db.sql`
      SELECT harness_slug FROM harness_shared.agent_facts
       WHERE key = 'keep-slug' AND superseded_at IS NULL`;
    expect(rows).toHaveLength(1);
    expect(rows[0].harness_slug).toBe('home');
  });
});

// EI-19952118814692217: `created_by` was the ONLY bind in assertFact's INSERT
// without a `?? null` coalesce. mode:set called assertFact directly (not through
// the facts:assert TOOL, which fills createdBy server-side) and omitted it, so
// postgres-js threw a driver-level `UNDEFINED_VALUE` before any row was written —
// and mode:set's bare `catch {}` discarded that error entirely, making the whole
// failure undiagnosable from logs. Every unit test stayed green because
// mode/set.test.ts MOCKS assertFact, so a missing required arg was invisible to it.
describe('createdBy binding (EI-19952118814692217 regression guard)', () => {
  it('succeeds with ONLY the documented-required fields — every other caller-omittable bind must coalesce', async () => {
    // Mirrors the actual failure shape: a direct (non-tool) caller supplying just
    // scope/scopeRef/key/body/createdBy/workspaceId and nothing else. Every
    // OPTIONAL AssertFactInput field left off here must resolve to a safe default
    // in the INSERT (`?? null` or equivalent) — an un-coalesced bind throws before
    // a row is ever written, exactly as `created_by` did.
    const fact = await assertFact(
      { ttlSec: 3600,
        scope: 'owner',
        scopeRef: 'su-required-fields-only',
        key: 'required-only',
        body: 'minimal required-field assert',
        createdBy: 'su-int',
        workspaceId: WS,
      },
      db.sql,
    );
    expect(fact.key).toBe('required-only');
    expect(fact.createdBy).toBe('su-int');
  });

  it('omitting createdBy fails LOUDLY with an attributable NOT NULL error, not a bare "undefined values" throw', async () => {
    // `createdBy` is REQUIRED in AssertFactInput — TypeScript refuses this at
    // compile time for any typed caller. This guards a caller that reaches the
    // store WITHOUT going through that type contract (mode:set's original direct
    // call did exactly this). Before the fix: postgres-js threw
    // `UNDEFINED_VALUE: Undefined values are not allowed` — a message naming no
    // column and no fix. After the fix (`${input.createdBy ?? null}`): the
    // NOT NULL constraint fires instead and names the actual column, which is
    // what makes the fail-soft catch's logged error diagnosable at all.
    const badInput = {
      ttlSec: 3600,
      scope: 'owner',
      scopeRef: 'su-missing-createdby',
      key: 'missing-createdby',
      body: 'no createdBy on purpose',
      workspaceId: WS,
      // createdBy deliberately omitted — the cast bypasses the type contract to
      // simulate a caller that skips it, the same shape as the original bug.
    } as unknown as Parameters<typeof assertFact>[0];
    await expect(assertFact(badInput, db.sql)).rejects.toThrow(/created_by/i);
  });
});

describe('P-008 (a) append-versioning — a correction APPENDS, it never destroys (D-003)', () => {
  const base = { scope: 'owner' as const, scopeRef: 'su-v', key: 'ver', createdBy: 'su-int', workspaceId: WS };
  const chain = () =>
    db.sql`SELECT id, body, superseded_at, supersedes_id, retracted_at
             FROM harness_shared.agent_facts WHERE key = 'ver' ORDER BY id`;

  it('the first version has an id, supersedes nothing, and is current', async () => {
    const v1 = await assertFact({ ttlSec: 3600, ...base, body: 'one' }, db.sql);
    expect(typeof v1.id).toBe('number');
    expect(v1.supersedesId).toBeNull();
    expect(v1.supersededAt).toBeNull();
  });

  it('a correction keeps the OLD row intact and chains the new one to it', async () => {
    const v1 = await assertFact({ ttlSec: 3600, ...base, body: 'one' }, db.sql);
    const v2 = await assertFact({ ttlSec: 3600, ...base, body: 'two' }, db.sql);
    expect(v2.id).not.toBe(v1.id);
    expect(v2.supersedesId).toBe(v1.id);
    const rows = await chain();
    expect(rows).toHaveLength(2);
    // THE POINT OF THE WHOLE ITEM: a pointer taken at v1 still resolves to what
    // v1 said. Before 689 this row's body had been overwritten to 'two'.
    expect(rows[0].body).toBe('one');
    expect(rows[0].superseded_at).not.toBeNull();
  });

  it('reads serve ONLY the current version — a fold never shows a value beside its own correction', async () => {
    await assertFact({ ttlSec: 3600, ...base, body: 'one' }, db.sql);
    await assertFact({ ttlSec: 3600, ...base, body: 'two' }, db.sql);
    const folded = await foldFacts([{ scope: 'owner', scopeRef: 'su-v' }], { workspaceId: WS, audiences: 'all' }, db.sql);
    const mine = folded.filter((f) => f.key === 'ver');
    expect(mine).toHaveLength(1);
    expect(mine[0].body).toBe('two');
  });

  it('factVersions walks the chain, current first', async () => {
    await assertFact({ ttlSec: 3600, ...base, body: 'one' }, db.sql);
    await assertFact({ ttlSec: 3600, ...base, body: 'two' }, db.sql);
    await assertFact({ ttlSec: 3600, ...base, body: 'three' }, db.sql);
    const hist = await factVersions({ scope: 'owner', scopeRef: 'su-v', key: 'ver', workspaceId: WS }, db.sql);
    expect(hist.map((h) => h.body)).toEqual(['three', 'two', 'one']);
    expect(hist[0].supersededAt).toBeNull();
    expect(hist[1].supersededAt).not.toBeNull();
  });

  it('⚠ a retraction SURVIVES on its own version — the old code erased it on revive', async () => {
    await assertFact({ ttlSec: 3600, ...base, body: 'one' }, db.sql);
    await retractFact({ scope: 'owner', scopeRef: 'su-v', key: 'ver', workspaceId: WS }, db.sql);
    const retractedRows = await chain();
    expect(retractedRows[0].retracted_at).not.toBeNull();
    // Re-asserting revives the identity. Previously that was expressed as
    // `retracted_at = NULL` on the mutated row — i.e. by destroying the record
    // that it had ever been retracted. Now the retraction stays on the version
    // that carried it, and the revival is a new version.
    await assertFact({ ttlSec: 3600, ...base, body: 'revived' }, db.sql);
    const rows = await chain();
    expect(rows).toHaveLength(2);
    expect(rows[0].retracted_at).not.toBeNull(); // history intact
    expect(rows[1].retracted_at).toBeNull(); // the live version is not retracted
    expect(rows[1].body).toBe('revived');
  });

  it('a retract marks the CURRENT version only and never rewrites history', async () => {
    await assertFact({ ttlSec: 3600, ...base, body: 'one' }, db.sql);
    await assertFact({ ttlSec: 3600, ...base, body: 'two' }, db.sql);
    await retractFact({ scope: 'owner', scopeRef: 'su-v', key: 'ver', workspaceId: WS }, db.sql);
    const rows = await chain();
    expect(rows[0].retracted_at).toBeNull(); // the superseded version is untouched
    expect(rows[1].retracted_at).not.toBeNull();
  });

  it('a deliberate retract preserves its actor and reason in version history', async () => {
    await assertFact({ ttlSec: 3600, ...base, body: 'temporary conclusion' }, db.sql);
    await retractFact(
      {
        scope: 'owner',
        scopeRef: 'su-v',
        key: 'ver',
        workspaceId: WS,
        retractedBy: 'su-auditor',
        reason: 'new live evidence superseded it',
      },
      db.sql,
    );
    const [version] = await factVersions({ ...base, limit: 1 }, db.sql);
    expect(version.retractedAt).not.toBeNull();
    expect(version.retractedBy).toBe('su-auditor');
    expect(version.retractionReason).toBe('new live evidence superseded it');
  });

  it('the partial unique index still forbids a SECOND current version', async () => {
    await assertFact({ ttlSec: 3600, ...base, body: 'one' }, db.sql);
    await expect(
      db.sql`INSERT INTO harness_shared.agent_facts
               (workspace_id, scope, scope_ref, key, body, created_by, expires_at)
             VALUES (${WS}, 'owner', 'su-v', 'ver', 'illegal', 'su-int', now() + interval '1 day')`,
    ).rejects.toThrow();
  });

  it('the cap counts CURRENT versions, so a heavily-corrected fact cannot evict its neighbours', async () => {
    // One fact revised many times must not consume the (scope, ref) budget.
    for (let i = 0; i < CAP + 5; i++) {
      await assertFact({ ttlSec: 3600, ...base, body: `rev ${i}` }, db.sql);
    }
    const live = await foldFacts(
      [{ scope: 'owner', scopeRef: 'su-v' }],
      { workspaceId: WS, audiences: 'all', limitPerSelector: 100 },
      db.sql,
    );
    expect(live.filter((f) => f.key === 'ver')).toHaveLength(1);
    // …and it is the newest revision, not an evicted one.
    expect(live.find((f) => f.key === 'ver')?.body).toBe(`rev ${CAP + 4}`);
  });

  it('EI-21442182972969040: the cross-author guard became UNIVERSAL — a BETTER-ranked write is refused too, and exempt slots remain writable', async () => {
    const scopeRef = 'su-protect-verified-cap';
    const peer = 'su-peer-verified';
    const writer = 'su-new-writer';
    const base = { scope: 'owner' as const, scopeRef, workspaceId: WS };

    // ── WHY THIS TEST INVERTED (P-002 / D-003) ─────────────────────────────
    // This guard originally refused a write only when its victim was ANOTHER
    // author's `verified` fact. On a scope that saturated 100%-verified across
    // ~130 authors that discriminator went DEGENERATE and the rail read as a
    // scope-wide write lock (EI-21585375376448939), so it was narrowed to
    // permit the destruction whenever the incoming write OUTRANKED its victim.
    // Both settings were reachable only because a stranger's fact was the
    // currency being spent. D-003 removes the currency: the ceiling COUNTS the
    // population instead of searching it for a victim, so ranking no longer
    // buys admission and no incumbent is ever at risk.
    //
    // So the case this test used to assert — "a better-ranked cross-author
    // write is ADMITTED, evicting peer-0" — is precisely the behaviour that was
    // removed, and the assertions below are the STRONGER form of the same
    // protection rather than a relaxation of it.
    await db.sql`
      INSERT INTO harness_shared.agent_facts
        (workspace_id, scope, scope_ref, key, body, created_by, expires_at, confidence)
      SELECT ${WS}, 'owner', ${scopeRef}, 'peer-' || g::text,
             'verified peer finding ' || g::text, ${peer},
             now() + interval '30 days', 'verified'
        FROM generate_series(1, ${CAP}) AS g`;

    // The write the ranking-aware guard USED to admit: a fresh `verified` row,
    // which holds the maximum remaining-TTL fraction and therefore outranks
    // every incumbent in the scope.
    const incoming = {
      ...base,
      key: 'incoming-cross-author',
      body: 'a new verified finding',
      createdBy: writer,
      confidence: 'verified' as const,
      ttlSec: 30 * 86400,
    };
    const preview = await previewFactCapImpact(incoming, db.sql);
    expect(preview.atCap).toBe(true);
    expect(preview.populationSize).toBe(CAP);
    expect(preview.wouldRefuse).toBe(true);
    // No victim is named because none exists — a forecast that still named one
    // would be describing the mechanism this plan removed.
    expect(preview.wouldEvict).toEqual([]);
    await expect(assertFact(incoming, db.sql)).rejects.toThrow(/REFUSED before write/);

    // A WEAKER write meets the identical outcome. That equality is the point:
    // the writer's message no longer depends on a comparison against a row it
    // cannot see, so two writers at the same ceiling get the same answer.
    const weakerIncoming = {
      ...base,
      key: 'incoming-cross-author-weaker',
      body: 'a provisional finding',
      createdBy: 'su-weaker-writer',
      confidence: 'provisional' as const,
      ttlSec: 30 * 86400,
    };
    const weakerPreview = await previewFactCapImpact(weakerIncoming, db.sql);
    expect(weakerPreview.atCap).toBe(true);
    expect(weakerPreview.wouldRefuse).toBe(true);
    expect(weakerPreview.wouldEvict).toEqual([]);
    await expect(assertFact(weakerIncoming, db.sql)).rejects.toThrow(/REFUSED before write/);

    // Both refusals are pre-write, so the peer's population is COMPLETE — not
    // one row short as it was when the better-ranked write was admitted.
    const [afterRefusal] = await db.sql<{
      peerLive: number;
      incomingRows: number;
      weakerIncomingRows: number;
      evictedRows: number;
    }[]>`
      SELECT count(*) FILTER (
               WHERE key LIKE 'peer-%' AND superseded_at IS NULL
                 AND retracted_at IS NULL AND expires_at > now()
             )::int AS "peerLive",
             count(*) FILTER (WHERE key = 'incoming-cross-author')::int AS "incomingRows",
             count(*) FILTER (WHERE key = 'incoming-cross-author-weaker')::int AS "weakerIncomingRows",
             count(*) FILTER (WHERE evicted_at IS NOT NULL)::int AS "evictedRows"
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'owner' AND scope_ref = ${scopeRef}`;
    expect(afterRefusal.peerLive).toBe(CAP);
    expect(afterRefusal.incomingRows).toBe(0);
    expect(afterRefusal.weakerIncomingRows).toBe(0);
    expect(afterRefusal.evictedRows).toBe(0);

    // Typed safety slots and conventions do not consume ordinary cap seats,
    // so they bypass the guard even when the ranked partition is saturated.
    const exemptWrites = [
      { key: 'wall:peer-cap-wall', body: 'owner wall' },
      { key: 'dead-end:peer-cap-dead-end', body: 'do not retry' },
      { key: 'guard-rail:peer-cap-guard', body: 'do not repeat' },
      { key: 'convention-peer-cap', body: 'scope convention', kind: 'convention' as const },
    ];
    for (const exempt of exemptWrites) {
      const result = await assertFact({ ttlSec: 3600, ...base, ...exempt, createdBy: writer }, db.sql);
      expect(result.key).toBe(exempt.key);
      expect(result.evicted ?? []).toEqual([]);
    }

    const [afterExempt] = await db.sql<{ peerLive: number; exemptLive: number; evictedRows: number }[]>`
      SELECT count(*) FILTER (
               WHERE key LIKE 'peer-%' AND superseded_at IS NULL
                 AND retracted_at IS NULL AND expires_at > now()
             )::int AS "peerLive",
             count(*) FILTER (
               WHERE key IN (
                 'wall:peer-cap-wall',
                 'dead-end:peer-cap-dead-end',
                 'guard-rail:peer-cap-guard',
                 'convention-peer-cap'
               )
                 AND superseded_at IS NULL AND retracted_at IS NULL AND expires_at > now()
             )::int AS "exemptLive",
             count(*) FILTER (WHERE evicted_at IS NOT NULL)::int AS "evictedRows"
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'owner' AND scope_ref = ${scopeRef}`;
    // The whole peer population is STILL intact after four exempt writes into a
    // scope that is refusing ordinary ones: exempt rows take no seat, so they
    // are neither refused at the ceiling nor paid for by an incumbent.
    expect(afterExempt.peerLive).toBe(CAP);
    expect(afterExempt.exemptLive).toBe(exemptWrites.length);
    expect(afterExempt.evictedRows).toBe(0);
  });

  it('EI-21488671343297100: concurrent writers cannot race past the ranking-aware cap guard', async () => {
    const scopeRef = 'su-protect-verified-cap-race';
    const peer = 'su-peer-verified-race';

    // Leave exactly one seat. The trigger below pauses both contenders only
    // after their admission read, making the read-check/write gap deterministic:
    // without the per-partition advisory lock both transactions count CAP-1,
    // both conclude there is room, and both INSERT — leaving CAP+1 live rows,
    // i.e. a ceiling that a concurrent pair can simply walk past.
    //
    // P-002 / D-003 makes this the sharper test it could not be before. The
    // losing contender is now REFUSED rather than admitted-with-an-eviction, so
    // the outcome is a clean one-of-two split with nothing destroyed; under the
    // old ranking-aware guard both writes succeeded and the lock was observable
    // only indirectly, through the eviction count.
    await db.sql`
      INSERT INTO harness_shared.agent_facts
        (workspace_id, scope, scope_ref, key, body, created_by, expires_at, confidence)
      SELECT ${WS}, 'owner', ${scopeRef}, 'peer-race-' || g::text,
             'verified peer finding ' || g::text, ${peer},
             now() + interval '30 days', 'verified'
        FROM generate_series(1, ${CAP - 1}) AS g`;

    await db.sql.unsafe(`
      CREATE OR REPLACE FUNCTION harness_shared.test_pause_fact_cap_race() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.key LIKE 'incoming-race-%' THEN PERFORM pg_sleep(0.35); END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_pause_fact_cap_race
        BEFORE INSERT ON harness_shared.agent_facts
        FOR EACH ROW EXECUTE FUNCTION harness_shared.test_pause_fact_cap_race();
    `);

    try {
      const contenders = ['a', 'b'].map((suffix) =>
        db.sql.begin((tx) =>
          assertFact(
            {
              scope: 'owner',
              scopeRef,
              workspaceId: WS,
              key: `incoming-race-${suffix}`,
              body: `concurrent verified finding ${suffix}`,
              createdBy: `su-writer-${suffix}`,
              confidence: 'verified',
              ttlSec: 30 * 86400,
            },
            tx as unknown as NonNullable<Parameters<typeof assertFact>[1]>,
          ),
        ),
      );
      const outcomes = await Promise.allSettled(contenders);

      // EXACTLY one seat, exactly one winner. This is the assertion the lock
      // exists for: serialize the whole seat DECISION, not merely the write.
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(rejected).toHaveLength(1);
      // …and the loser is refused for the RIGHT reason — a serialization
      // failure or a unique-index violation would also land here, and would
      // mean the ceiling had been enforced by accident rather than by design.
      expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/REFUSED before write/);

      const [afterRace] = await db.sql<{
        liveRows: number;
        incomingRows: number;
        evictedRows: number;
      }[]>`
        SELECT count(*) FILTER (
                 WHERE superseded_at IS NULL AND retracted_at IS NULL AND expires_at > now()
               )::int AS "liveRows",
               count(*) FILTER (
                 WHERE key LIKE 'incoming-race-%' AND superseded_at IS NULL
                   AND retracted_at IS NULL AND expires_at > now()
               )::int AS "incomingRows",
               count(*) FILTER (WHERE evicted_at IS NOT NULL)::int AS "evictedRows"
          FROM harness_shared.agent_facts
         WHERE workspace_id = ${WS} AND scope = 'owner' AND scope_ref = ${scopeRef}`;
      // CAP, not CAP+1: the ceiling held under contention. And nothing died to
      // make that true — the loser paid, no incumbent did.
      expect(afterRace).toEqual({
        liveRows: CAP,
        incomingRows: 1,
        evictedRows: 0,
      });
    } finally {
      await db.sql.unsafe(`
        DROP TRIGGER IF EXISTS test_pause_fact_cap_race ON harness_shared.agent_facts;
        DROP FUNCTION IF EXISTS harness_shared.test_pause_fact_cap_race();
      `);
    }
  }, 20_000);

  it('WI-6935: a wall/dead-end fact survives a cap-evicting write — the typed safety slots are exempt from the ranking', async () => {
    const scopeRef = 'su-slot-cap';

    // ⚠ PORTED TO THE VOLATILE PARTITION (P-002 / D-004 §1). This guard used to
    // over-fill the ORDINARY partition, which no longer evicts anything — left
    // there it would pass against a sweep that never runs, asserting nothing
    // while looking green. The exemption it pins is now only observable here.
    //
    // The two slots are seeded as the WORST-ranked rows in the partition
    // (`suspected`, with 890 of 900 declared seconds already spent). That is
    // what made the original bug certain rather than unlikely: a wall is
    // asserted once and never touched again, so it sinks to the bottom of any
    // victim ordering. Were the key-prefix exclusions dropped from
    // capPopulationPredicate, these two would be the FIRST rows to die.
    await seedVolatile('owner', scopeRef, [
      { key: 'wall:owner-must-ratify', body: 'HOLD — owner gate', confidence: 'suspected', ageSec: 890, ttlSec: 900 },
      { key: 'dead-end:already-tried', body: 'do not re-try this', confidence: 'suspected', ageSec: 890, ttlSec: 900 },
      ...volatileCohort(VOLATILE_CAP, { prefix: 'ordinary' }),
    ]);

    const arrival = await assertFact(volatileWrite('owner', scopeRef, 'a-new-snapshot'), db.sql);

    // NON-VACUITY FIRST: the cap must actually have BITTEN, or "the wall
    // survived" is equally true of a scope where eviction never ran at all.
    expect(arrival.evicted?.length).toBe(1);
    // …and it took a RANKED row, never one of the exempt slots — even though
    // both slots rank below every ranked row in the partition.
    expect(arrival.evicted?.[0].key).toMatch(/^ordinary-\d+$/);

    const live = await foldFacts(
      [{ scope: 'owner', scopeRef }],
      // Read past the cap on purpose: the exempt slots live ALONGSIDE the
      // ranked survivors, and they are the oldest-updated rows here, so a
      // limitPerSelector pinned to the cap truncates the read before it reaches
      // them — which reads as "the wall was evicted" when it was never fetched.
      { workspaceId: WS, audiences: 'all', limitPerSelector: VOLATILE_CAP + 100 },
      db.sql,
    );
    const keys = live.map((f) => f.key);
    // Still LIVE, not merely still-present: eviction writes `retracted_at`, the same
    // field a deliberate retract writes, and listLapsedWallFacts filters
    // `retracted_at IS NULL` — so an evicted wall is invisible to the watchdog built
    // to page on exactly that wall.
    expect(keys).toContain('wall:owner-must-ratify');
    expect(keys).toContain('dead-end:already-tried');
  });

  it('WI-6935 (c): the cap evicts by DECLARED VALUE, not by write-recency', async () => {
    const scopeRef = 'su-value-rank';

    // ⚠ PORTED TO THE VOLATILE PARTITION (P-002 / D-004 §1) — the ranking is
    // retained but volatile-only, so this is where "value beats recency" can
    // still be observed. The fixture is built to DISCRIMINATE between the two
    // orderings rather than merely to be consistent with the current one:
    //
    //   • `settled` and `hedge` are the OLDEST-UPDATED rows here (450s in), so
    //     the pre-WI-6935 `updated_at DESC` ranking would have killed one of
    //     THEM first — which is exactly the bug, since a settled conclusion is
    //     written once and then never touched again;
    //   • under the value ranking the sacrifice is `hedge`, on confidence
    //     alone, and both verified rows outlive every newer filler decision.
    await seedVolatile('owner', scopeRef, [
      { key: 'settled', body: 'a verified finding', confidence: 'verified', ageSec: 450, ttlSec: 900 },
      { key: 'most-life-left', body: 'barely into its declared life', confidence: 'verified', ageSec: 90, ttlSec: 900 },
      // The hedge — same elapsed share as `settled`, weaker evidence tier — so
      // the two are separated by DECLARED VALUE and nothing else.
      { key: 'hedge', body: 'a hunch', confidence: 'suspected', ageSec: 450, ttlSec: 900 },
      ...volatileCohort(VOLATILE_CAP - 3, { prefix: 'filler', ageSec: 30, ttlSec: 900 }),
    ]);

    const arrival = await assertFact(volatileWrite('owner', scopeRef, 'a-new-snapshot'), db.sql);

    // Prove the cap FIRED — without this the survival assertions below would pass
    // just as happily against an eviction that never ran (the vacuity trap the
    // sibling guard above was originally built with).
    expect(arrival.evicted?.length).toBe(1);
    // The hedge is sacrificed first…
    expect(arrival.evicted?.[0].key).toBe('hedge');

    const live = await foldFacts(
      [{ scope: 'owner', scopeRef }],
      { workspaceId: WS, audiences: 'all', limitPerSelector: 500 },
      db.sql,
    );
    const keys = live.map((f) => f.key);
    expect(keys).not.toContain('hedge');
    // …while both verified findings survive, even though `settled` is among the
    // OLDEST-updated rows in the scope and would have been the very first
    // victim under the previous write-recency ranking.
    expect(keys).toContain('settled');
    expect(keys).toContain('most-life-left');
  });

  it('WI-7292: an assert never evicts the row it just wrote, so a WORST-RANKED fact can still enter a SATURATED scope', async () => {
    const scopeRef = 'su-self-eviction';

    // ⚠ PORTED TO THE VOLATILE PARTITION (P-002 / D-004 §1). The
    // `id IS DISTINCT FROM ${writtenId}` clause this pins now lives only on the
    // volatile sweep, so the ordinary partition can no longer exercise it at
    // all — and a self-eviction is the one failure mode that is invisible from
    // the receipt, since the caller gets ok:true with a future expiresAt while
    // the row is already dead (written .710Z, evicted .714Z when measured).
    //
    // The arriving row is deliberately the WORST-ranked in the partition: a
    // `suspected` snapshot among `verified` ones. Without the self-exclusion it
    // is the row the sweep picks, as part of the very statement that wrote it.
    await seedVolatile('owner', scopeRef, volatileCohort(VOLATILE_CAP, { confidence: 'verified' }));

    const urgent = await assertFact(
      volatileWrite('owner', scopeRef, 'urgent', {
        body: 'this alarm is false right now',
        confidence: 'suspected',
      }),
      db.sql,
    );

    const live = await foldFacts(
      [{ scope: 'owner', scopeRef }],
      { workspaceId: WS, audiences: 'all', limitPerSelector: 500 },
      db.sql,
    );
    const keys = live.map((f) => f.key);

    // Non-vacuity FIRST: the cap must actually have BITTEN. Without this, "urgent
    // survived" proves nothing — it would survive just as happily in a scope where
    // eviction never ran at all (the trap the sibling guards above call out).
    expect(urgent.evicted?.length).toBe(1);
    expect(keys.length).toBe(VOLATILE_CAP);
    expect(keys.filter((k) => k.startsWith('incumbent-')).length).toBe(VOLATILE_CAP - 1);

    // The write survives its own assert — the whole point.
    expect(keys).toContain('urgent');

    // And state it at the row level too, because THAT is the shape of the bug: a
    // caller got ok:true with a future expiresAt while the row was already dead.
    const [row] = await db.sql<{ retracted_at: string | null; evicted_at: string | null }[]>`
      SELECT retracted_at::text, evicted_at::text
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'owner'
         AND scope_ref = ${scopeRef} AND key = 'urgent' AND superseded_at IS NULL`;
    expect(row.retracted_at).toBeNull();
    expect(row.evicted_at).toBeNull();
  });

  it('EI-19451909636567773: survival-ranking-matches-sweep — the receipt names THIS write as next, and the next assert evicts exactly that row', async () => {
    const scopeRef = 'su-survival-prediction';
    const base = { scope: 'owner' as const, scopeRef, createdBy: 'su-int', workspaceId: WS };

    // ⚠ PORTED TO THE VOLATILE PARTITION (P-002 / D-004 §1). The survival
    // receipt is produced by the eviction path, which is volatile-only now, so
    // this parity pin has to live where the sweep still runs.
    //
    // ⚠ This fixture also changed with EI-19483432832662150. It used to make the
    // doomed row a SHORT-TTL write, because key 2 was `expires_at DESC`. Key 2
    // is now the remaining SHARE of declared TTL, and a fresh write always
    // scores ~1.0 — the maximum — so a new row can no longer be pushed last by
    // its TTL at all. The determinate last-place write is now one whose
    // CONFIDENCE ranks below the incumbents, which is what this pin needs: a
    // predictable victim, so "the row we named must be the row that dies" stays
    // a real assertion rather than a coin flip.
    await seedVolatile('owner', scopeRef, volatileCohort(VOLATILE_CAP, { confidence: 'verified' }));

    // The doomed write: a 'suspected' hedge in a scope of 'verified' findings.
    const doomed = await assertFact(
      volatileWrite('owner', scopeRef, 'doomed', { body: 'a hedge among findings', confidence: 'suspected' }),
      db.sql,
    );

    // Non-vacuity FIRST: the cap must actually have BITTEN. Without this,
    // "ranked last" would be a claim about a scope where ranking never ran.
    expect(doomed.evicted?.length).toBeGreaterThan(0);

    // The half that used to be withheld.
    expect(doomed.survival).toBeDefined();
    expect(doomed.survival?.nextVictim).toBe(true);
    expect(doomed.survival?.rank).toBe(VOLATILE_CAP);
    expect(doomed.survival?.liveCount).toBe(VOLATILE_CAP);
    // It names the BAR this write failed to clear, in key 2's own units — a
    // share of declared life, not an absolute expiry. A fresh incumbent has
    // spent almost none of its TTL, so the bar sits just under 1.
    expect(doomed.survival?.survivingFractionFloor).not.toBeNull();
    expect(doomed.survival!.survivingFractionFloor!).toBeGreaterThan(0);
    expect(doomed.survival!.survivingFractionFloor!).toBeLessThanOrEqual(1);

    // ── THE PIN ────────────────────────────────────────────────────────────
    // A prediction is only worth printing if it comes true, and the JS ordering
    // that produced it is a hand-mirror of the sweep's SQL ORDER BY. This is
    // what stops the two drifting: a DIFFERENT author asserts, and the row we
    // named must be exactly the row that dies.
    const later = await assertFact(
      volatileWrite('owner', scopeRef, 'a-later-write', {
        createdBy: 'su-other-writer',
        body: 'by someone else entirely',
      }),
      db.sql,
    );
    expect(later.evicted?.map((e) => e.key)).toEqual(['doomed']);

    // …and it is really gone from the folds, which is the failure the author
    // would otherwise have experienced as silence.
    const live = await foldFacts(
      [{ scope: 'owner', scopeRef }],
      { workspaceId: WS, audiences: 'all', limitPerSelector: 500 },
      db.sql,
    );
    expect(live.map((f) => f.key)).not.toContain('doomed');
  }, 15_000);

  it('EI-20515478467800187: sweep-survival-population-parity — survival counts ONLY rows the sweep may evict, so conventions never inflate liveCount', async () => {
    const scopeRef = 'su-population-parity';
    const base = { scope: 'owner' as const, scopeRef, createdBy: 'su-int', workspaceId: WS };

    // ── WHAT THIS CATCHES ──────────────────────────────────────────────────
    // The sweep and the survival report used to carry SEPARATE hand-copied
    // WHERE clauses. They agreed on the safety slots and DISAGREED on
    // conventions: P-028 forbids the sweep from evicting `kind:'convention'`,
    // but the survival query counted them anyway. `survival.liveCount` then
    // described a population the sweep cannot act on, and `survival.rank`
    // ranked the write against rows interleaved with exempt ones — so the
    // receipt's headline advice ("rank N of M, survives M-N more asserts") was
    // arithmetically wrong on every scope holding conventions. On the live
    // workspace scope that read as liveCount 259 against a 200-fact cap, which
    // is the anomaly the reporter of EI-20515478467800187 could not reconcile.
    //
    // The sibling guard `survival-ranking-matches-sweep` above cannot catch
    // this and never could: it pins the ORDER BY, and its fixture contains no
    // convention row, so the divergent WHERE is invisible to it. Ordering
    // parity and POPULATION parity are different properties.
    //
    // ⚠ The fixture MUST hold conventions for this test to mean anything — the
    // non-vacuity block below is what stops it degrading into a tautology.
    // ⚠ PORTED TO THE VOLATILE PARTITION (P-002 / D-004 §1) — the survival
    // report is only produced where the sweep still runs. The conventions must
    // be seeded volatile TOO: they exist here solely to differ from the
    // evictable population, and an ordinary convention is already excluded by
    // the partition clause, so the control below would stop discriminating.
    const CONVENTIONS = 3;
    await seedVolatile('owner', scopeRef, [
      ...Array.from({ length: CONVENTIONS }, (_unused, i) => ({
        key: `governing-convention-${i}`,
        body: `we do it this way (${i})`,
        kind: 'convention' as const,
      })),
      // Saturate the EVICTABLE population to exactly the cap.
      ...volatileCohort(VOLATILE_CAP, { confidence: 'verified' }),
    ]);

    const doomed = await assertFact(
      volatileWrite('owner', scopeRef, 'doomed', { body: 'a hedge among findings', confidence: 'suspected' }),
      db.sql,
    );

    // ── NON-VACUITY, BOTH HALVES ───────────────────────────────────────────
    // (1) the cap must actually have bitten, or "liveCount is right" would be a
    //     claim about a scope where the sweep never ran;
    // (2) the conventions must actually be LIVE, or the population difference
    //     this test exists to detect would not exist in the fixture at all.
    expect(doomed.evicted?.length).toBeGreaterThan(0);
    const [{ count: liveConventions }] = await db.sql<{ count: number }[]>`
      SELECT count(*)::int AS count
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'owner' AND scope_ref = ${scopeRef}
         AND kind = 'convention'
         AND superseded_at IS NULL AND retracted_at IS NULL AND expires_at > now()`;
    expect(liveConventions).toBe(CONVENTIONS);

    // ── THE PIN ────────────────────────────────────────────────────────────
    // Measure the evictable population directly and require the receipt to
    // agree with it. Asserting the literal CAP would be weaker:
    // this form states the actual invariant ("liveCount == what the sweep may
    // evict") and stays honest if the cap constant ever moves.
    const [{ count: evictable }] = await db.sql<{ count: number }[]>`
      SELECT count(*)::int AS count
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'owner' AND scope_ref = ${scopeRef}
         AND source_hive IS NULL
         AND superseded_at IS NULL
         AND retracted_at IS NULL AND expires_at > now()
         AND key NOT LIKE 'wall:%'
         AND key NOT LIKE 'dead-end:%'
         AND measurement->'subjectVolatile' = 'true'::jsonb
         AND COALESCE(kind, '') <> 'convention'`;

    // ── THE PERMANENT CONTROL ──────────────────────────────────────────────
    // A guard that has never failed is a guard nobody has tested. Rather than
    // mutate production code in a shared tree to prove this can fail (the
    // sweep-race the repo forbids), keep the PRE-FIX query here permanently as
    // a deliberately-wrong control: this is the survival WHERE exactly as it
    // stood before EI-20515478467800187, i.e. missing the convention filter.
    // If the fix is ever reverted, `liveCount` becomes this number and BOTH
    // assertions below flip — which is what makes them real assertions.
    const [{ count: preFixPopulation }] = await db.sql<{ count: number }[]>`
      SELECT count(*)::int AS count
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'owner' AND scope_ref = ${scopeRef}
         AND source_hive IS NULL
         AND superseded_at IS NULL
         AND retracted_at IS NULL AND expires_at > now()
         AND key NOT LIKE 'wall:%'
         AND key NOT LIKE 'dead-end:%'
         AND measurement->'subjectVolatile' = 'true'::jsonb`;
    // The control must genuinely differ, or this whole test is a tautology.
    expect(preFixPopulation).toBe(evictable + CONVENTIONS);

    expect(doomed.survival).toBeDefined();
    // The receipt must NOT be reporting the inflated population...
    expect(doomed.survival!.liveCount).not.toBe(preFixPopulation);
    // ...it must be reporting exactly what the sweep can evict.
    expect(doomed.survival?.liveCount).toBe(evictable);
    // And the rank must sit inside that population, not past its end.
    expect(doomed.survival!.rank).toBeLessThanOrEqual(evictable);
    // The doomed hedge is bottom of a scope of verified findings, so the
    // receipt's "you are next" must be true AND consistent with the count.
    expect(doomed.survival?.nextVictim).toBe(true);
    expect(doomed.survival!.rank).toBe(evictable);
  });

  it('EI-20515478467800187: a convention write gets NO survival verdict — it is exempt from the cap, so it has no victim ranking', async () => {
    const scopeRef = 'su-convention-no-survival';
    const base = { scope: 'owner' as const, scopeRef, createdBy: 'su-int', workspaceId: WS };

    // ⚠ PORTED TO THE VOLATILE PARTITION (P-002 / D-004 §1): survival is a
    // by-product of the eviction path, so "no survival verdict" is only a
    // meaningful claim where a verdict would otherwise be produced.
    //
    // Saturate so the sweep fires on the next write — otherwise "no survival"
    // would be trivially true (survival is only computed on an at-cap write).
    await seedVolatile('owner', scopeRef, volatileCohort(VOLATILE_CAP, { confidence: 'verified' }));

    const convention = await assertFact(
      volatileWrite('owner', scopeRef, 'a-governing-rule', {
        body: 'policy, not an observation',
        kind: 'convention',
        enforcement: { tier: 'structural' },
      }),
      db.sql,
    );

    // Non-vacuity: we must be on the at-cap path, or "no survival verdict" is
    // trivially true of any write into a roomy scope.
    //
    // ⚠ This control USED TO BE `expect(convention.evicted?.length)
    // .toBeGreaterThan(0)` — "the cap bit on this write". That asserted the
    // EI-20824216187836980 defect as though it were the contract: an exempt row
    // never joins the cap population, so a convention write must destroy
    // NOTHING, and requiring it to evict pinned the bug in place. The at-cap
    // CONDITION is what this test actually needs, so measure the condition
    // directly rather than inferring it from the damage.
    const [{ count: population }] = await db.sql<{ count: number }[]>`
      SELECT count(*)::int AS count
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'owner' AND scope_ref = ${scopeRef}
         AND source_hive IS NULL AND superseded_at IS NULL
         AND retracted_at IS NULL AND expires_at > now()
         AND measurement->'subjectVolatile' = 'true'::jsonb
         AND COALESCE(kind, '') <> 'convention'
         AND key NOT LIKE 'wall:%' AND key NOT LIKE 'dead-end:%'`;
    expect(population).toBe(VOLATILE_CAP);

    // ...and the exempt write cost nobody their seat, precisely because it took
    // none (EI-20824216187836980).
    expect(convention.evicted ?? []).toEqual([]);

    // ...but the written row is exempt, so reporting a victim-rank for it would
    // be a category error — it can never be the victim. Silence is the correct
    // answer here, where the old code would have ranked it among rows it can
    // never join.
    expect(convention.survival).toBeUndefined();

    // The SWEEP IS LIVE at this saturation — the other half of the non-vacuity
    // control the eviction check used to provide. An ordinary newcomer into the
    // very same scope still evicts, so "the convention evicted nothing" is a
    // statement about exemption and not about a sweep that stopped running.
    const ordinary = await assertFact(
      volatileWrite('owner', scopeRef, 'ordinary-newcomer', { body: 'x' }),
      db.sql,
    );
    expect(ordinary.evicted?.length).toBe(1);

    // And it really is exempt: it survives its own at-cap write.
    const [row] = await db.sql<{ retracted_at: string | null }[]>`
      SELECT retracted_at::text
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'owner' AND scope_ref = ${scopeRef}
         AND key = 'a-governing-rule' AND superseded_at IS NULL`;
    expect(row.retracted_at).toBeNull();
  });

  it('EI-20515478467800187: preview-predicts-the-sweep — dryRun names the victim BEFORE the write, and the write destroys exactly that row', async () => {
    const scopeRef = 'su-preview-predicts';
    const base = { scope: 'owner' as const, scopeRef, createdBy: 'su-int', workspaceId: WS };

    // ── WHY THIS TEST IS THE LOAD-BEARING ONE ──────────────────────────────
    // A preview computes the answer a SECOND way (TypeScript over a snapshot)
    // from the way the sweep computes it (SQL). That is a MIRROR, and an
    // unpinned mirror is the exact defect class this whole item is about — it
    // would replace "the receipt tells you too late" with "the forecast tells
    // you the wrong victim", which is strictly worse because it is trusted.
    // So: predict, then execute, then require them to agree on the SAME key.
    //
    // ⚠ PORTED TO THE VOLATILE PARTITION (P-002 / D-004 §1): the SQL sweep the
    // TypeScript forecast mirrors runs only here now, so this is the only
    // partition on which the mirror can still be pinned.
    await seedVolatile('owner', scopeRef, [
      ...volatileCohort(VOLATILE_CAP - 1, { confidence: 'verified' }),
      // One clearly-worst row, so the victim is determinate rather than a tie.
      { key: 'weakest', body: 'a hedge', confidence: 'suspected' },
    ]);

    const preview = await previewFactCapImpact(
      volatileWrite('owner', scopeRef, 'the-new-arrival', { body: 'incoming' }),
      db.sql,
    );

    // Non-vacuity: the preview must actually be forecasting a LOSS, or "they
    // agree" would just be two empty lists agreeing.
    expect(preview.atCap).toBe(true);
    expect(preview.wouldEvict.length).toBeGreaterThan(0);
    expect(preview.replacesExistingKey).toBe(false);
    expect(preview.exempt).toBe(false);
    // It names the owner + evidence strength, which is the actionable part —
    // "I am about to cost a peer a verified finding" is the decision this
    // surface exists to inform.
    expect(preview.wouldEvict[0].createdBy).toBe('su-int');
    expect(preview.wouldEvict[0].key).toBe('weakest');

    // ── THE PIN: the forecast must survive contact with the real sweep ─────
    const real = await assertFact(
      volatileWrite('owner', scopeRef, 'the-new-arrival', { body: 'incoming' }),
      db.sql,
    );
    expect(real.evicted?.map((e) => e.key)).toEqual(preview.wouldEvict.map((e) => e.key));

    // And nothing was written by the preview itself — the whole point.
    const [{ count: arrivalsBefore }] = await db.sql<{ count: number }[]>`
      SELECT count(*)::int AS count
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'owner' AND scope_ref = ${scopeRef}
         AND key = 'the-new-arrival' AND superseded_at IS NULL`;
    // Exactly ONE live row: the real write. Two would mean the preview wrote.
    expect(arrivalsBefore).toBe(1);
  });

  it('EI-20515478467800187: dryRun on an EXISTING key forecasts no eviction — an upsert supersedes its own row and consumes no new slot', async () => {
    const scopeRef = 'su-preview-upsert';
    const base = { scope: 'owner' as const, scopeRef, createdBy: 'su-int', workspaceId: WS };

    // ⚠ PORTED TO THE VOLATILE PARTITION (P-002 / D-004 §1). On the ordinary
    // partition an upsert-at-the-ceiling is now an ADMISSION question rather
    // than an eviction one — that half is pinned by the P-002 ceiling suite's
    // re-assert tests. What survives only here is the original claim: a
    // superseding write consumes no NEW slot, so it destroys nobody.
    //
    // Saturate to the cap so a NEW key would certainly evict — that is the
    // control that makes "no eviction" a statement about upserts specifically,
    // rather than about a scope with room to spare.
    await seedVolatile('owner', scopeRef, volatileCohort(VOLATILE_CAP, { confidence: 'verified' }));

    const newKey = await previewFactCapImpact(
      volatileWrite('owner', scopeRef, 'a-brand-new-key', { body: 'x' }),
      db.sql,
    );
    expect(newKey.wouldEvict.length).toBeGreaterThan(0);
    expect(newKey.replacesExistingKey).toBe(false);

    // The SAME scope, at the SAME saturation — only the key differs.
    const refresh = await previewFactCapImpact(
      volatileWrite('owner', scopeRef, 'incumbent-7', { body: 'refreshed body' }),
      db.sql,
    );
    expect(refresh.replacesExistingKey).toBe(true);
    expect(refresh.wouldEvict).toEqual([]);

    // Confirm against reality: refreshing an existing fact really does destroy
    // nothing, so the forecast above is not merely self-consistent.
    const real = await assertFact(
      volatileWrite('owner', scopeRef, 'incumbent-7', { body: 'refreshed body' }),
      db.sql,
    );
    expect(real.evicted ?? []).toEqual([]);
  });

  it('EI-20824216187836980: an EXEMPT write (convention / wall: / dead-end: / guard-rail:) evicts NOTHING at cap — it never joins the population it was trimming room for', async () => {
    const scopeRef = 'su-exempt-write-takes-no-seat';
    const base = { scope: 'owner' as const, scopeRef, createdBy: 'su-int', workspaceId: WS };

    // ── THE DEFECT ─────────────────────────────────────────────────────────
    // capPopulationPredicate EXCLUDES conventions and the three typed safety
    // slots, so such a row never occupies a cap seat. The sweep nonetheless
    // trimmed incumbents to CAP-1 on every assert — buying a seat for a row
    // that was never going to take one, and destroying a live fact to do it.
    //
    // Measured on the live scope 2026-08-19: workspace/papercusp-workspace held
    // 200 non-exempt rows (pinned at exactly the cap) beside 121 exempt ones,
    // and 12 of that day's 28 evictions were bought by exempt writes.
    //
    // NB the reported symptom blamed append-versioning ("the upsert supersedes
    // into a NEW row"). That is not the cause: the non-exempt re-assert case is
    // already correct and already pinned by the dryRun-upsert sibling above.
    //
    // ⚠ PORTED TO THE VOLATILE PARTITION (P-002 / D-004 §1). The defect was in
    // the sweep's OFFSET, which is volatile-only now; the mirrored claim for
    // the ordinary partition — an exempt key is never REFUSED at the ceiling —
    // is pinned by the P-002 ceiling suite instead.
    await seedVolatile('owner', scopeRef, volatileCohort(VOLATILE_CAP, { confidence: 'verified' }));

    // ── POSITIVE CONTROL, FIRST — this is the calibration case ─────────────
    // An ORDINARY new key MUST evict exactly one row here. Without it, "the
    // exempt writes evicted nothing" is equally true of a scope where the cap
    // never fired at all, and the test would pass against a sweep that had been
    // disabled outright. This is what makes the assertions below falsifiable.
    const ordinary = await assertFact(volatileWrite('owner', scopeRef, 'ordinary-newcomer', { body: 'x' }), db.sql);
    expect(ordinary.evicted?.length).toBe(1);

    // The control left the ranked population at exactly the cap again, so every
    // exempt write below meets a SATURATED scope — the only condition under
    // which the bug can fire.
    for (const probe of [
      { label: 'convention', input: { key: 'a-convention', kind: 'convention' as const } },
      { label: 'wall', input: { key: 'wall:owner-must-rule-on-the-guard' } },
      { label: 'dead-end', input: { key: 'dead-end:tried-and-failed' } },
      { label: 'guard-rail', input: { key: 'guard-rail:do-not-refire' } },
    ]) {
      const r = await assertFact(
        volatileWrite('owner', scopeRef, probe.input.key, {
          ...probe.input,
          body: `exempt ${probe.label}`,
        }),
        db.sql,
      );
      expect(r.evicted ?? [], `${probe.label} write must not evict — it takes no cap seat`).toEqual([]);
    }

    // The exact reported shape: RE-asserting an ALREADY-LIVE convention key.
    const reassert = await assertFact(
      volatileWrite('owner', scopeRef, 'a-convention', { kind: 'convention', body: 'revised body' }),
      db.sql,
    );
    expect(reassert.evicted ?? []).toEqual([]);

    // ── And the population itself is intact ────────────────────────────────
    // State it at the row level, not just via the receipts: the receipt is
    // computed by the same statement that would have done the damage, so a
    // silent over-evict has to be caught against the table.
    const [{ count: ordinaryLive }] = await db.sql<{ count: number }[]>`
      SELECT count(*)::int AS count
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'owner' AND scope_ref = ${scopeRef}
         AND source_hive IS NULL AND superseded_at IS NULL
         AND retracted_at IS NULL AND expires_at > now()
         AND measurement->'subjectVolatile' = 'true'::jsonb
         AND COALESCE(kind, '') <> 'convention'
         AND key NOT LIKE 'wall:%' AND key NOT LIKE 'dead-end:%'
         AND key NOT LIKE 'guard-rail:%'`;
    expect(ordinaryLive).toBe(VOLATILE_CAP);

    // ...and all four exempt rows are live alongside it — the cap-bearing
    // population is CAP, the exempt rows sit outside it, and neither displaced
    // the other.
    const [{ count: exemptLive }] = await db.sql<{ count: number }[]>`
      SELECT count(*)::int AS count
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'owner' AND scope_ref = ${scopeRef}
         AND source_hive IS NULL AND superseded_at IS NULL
         AND retracted_at IS NULL AND expires_at > now()
         AND measurement->'subjectVolatile' = 'true'::jsonb
         AND (COALESCE(kind, '') = 'convention'
              OR key LIKE 'wall:%' OR key LIKE 'dead-end:%' OR key LIKE 'guard-rail:%')`;
    expect(exemptLive).toBe(4);
  });

  it('EI-20824216187836980: dryRun agrees with the sweep on an exempt write — forecasts no eviction, and reports the refresh as replacing an existing key', async () => {
    const scopeRef = 'su-exempt-preview';
    const base = { scope: 'owner' as const, scopeRef, createdBy: 'su-int', workspaceId: WS };

    // ⚠ PORTED TO THE VOLATILE PARTITION (P-002 / D-004 §1) — see the sibling
    // sweep test above; the forecast can only be checked against a sweep that
    // still runs.
    await seedVolatile('owner', scopeRef, volatileCohort(VOLATILE_CAP, { confidence: 'verified' }));

    // Non-vacuity: at this saturation an ORDINARY newcomer is forecast to kill
    // someone, so "the exempt forecast is empty" is a claim about exemption
    // rather than about a scope with room to spare.
    const ordinary = await previewFactCapImpact(
      volatileWrite('owner', scopeRef, 'ordinary-newcomer', { body: 'x' }),
      db.sql,
    );
    expect(ordinary.exempt).toBe(false);
    expect(ordinary.wouldEvict.length).toBeGreaterThan(0);

    const conventionPreview = await previewFactCapImpact(
      volatileWrite('owner', scopeRef, 'a-convention', { kind: 'convention', body: 'x' }),
      db.sql,
    );
    expect(conventionPreview.exempt).toBe(true);
    expect(conventionPreview.wouldEvict).toEqual([]);
    expect(conventionPreview.atCap).toBe(false);
    // Exempt ⇒ no victim ranking to report (it is not in the ranked set).
    expect(conventionPreview.survival).toBeNull();

    // ── THE PIN: forecast must survive contact with the real sweep ─────────
    const real = await assertFact(
      volatileWrite('owner', scopeRef, 'a-convention', { kind: 'convention', body: 'x' }),
      db.sql,
    );
    expect(real.evicted ?? []).toEqual([]);

    // A refresh of that now-live convention must report replacesExistingKey.
    // The exempt row is absent from the cap population, so deciding this from
    // the population alone answered a confident `false` — "this takes a new
    // slot" about a write that takes none.
    const refresh = await previewFactCapImpact(
      volatileWrite('owner', scopeRef, 'a-convention', { kind: 'convention', body: 'revised' }),
      db.sql,
    );
    expect(refresh.replacesExistingKey).toBe(true);
    expect(refresh.wouldEvict).toEqual([]);

    // Control for that field: a convention key that does NOT exist yet must
    // still read false, so the branch above is not simply hardcoding true.
    const freshConvention = await previewFactCapImpact(
      volatileWrite('owner', scopeRef, 'a-convention-never-written', { kind: 'convention', body: 'y' }),
      db.sql,
    );
    expect(freshConvention.exempt).toBe(true);
    expect(freshConvention.replacesExistingKey).toBe(false);
    expect(freshConvention.wouldEvict).toEqual([]);
  });

  it('EI-19483432832662150: an urgent SHORT-TTL fact is no longer doomed on arrival — the most-ELAPSED incumbent dies instead', async () => {
    const scopeRef = 'su-short-ttl-survives';
    const base = { scope: 'owner' as const, scopeRef, createdBy: 'su-int', workspaceId: WS };

    // Measured on the live scope 2026-08-04T01:19Z: an urgent 7-day operational
    // fact (a dev:restart blast-radius hazard) was evicted FIFTEEN SECONDS after
    // it was written, by the next agent's unrelated assert, because the pool was
    // full of incumbents holding later ABSOLUTE expiries. The scope's survival
    // floor had ratcheted to ~30 days, so nothing shorter could live in it.
    //
    // ⚠ PORTED TO THE VOLATILE PARTITION (P-002 / D-004 §1). The ranking that
    // produces this verdict is volatile-only now, so the fixture is rebuilt at
    // that partition's timescale (seconds, not days) while keeping the ONE
    // property that makes it discriminate — see the incumbent-0 note below.
    //
    // The cohort is seeded already 60s into a 3600s declared life. Without an
    // age the incumbents would be MILLISECONDS old and the test genuinely
    // flaky, for a reason worth stating: the arriving row burns its declared
    // share faster per wall-clock second than a longer-declared incumbent, so
    // against zero-age incumbents the sub-millisecond delay between the write
    // and the ranking query decides the verdict, and the same code returns a
    // mid rank on one run and LAST on the next. Both were observed.
    await seedVolatile('owner', scopeRef, [
      // ⚠ THE DISCRIMINATING ROW. Its declared life is long and almost entirely
      // SPENT (29000s of 30000s ⇒ ~0.03 left, the worst fraction in the scope),
      // while its ABSOLUTE expiry (~1000s out) is deliberately LATER than the
      // arriving snapshot's (900s). That inversion is the whole fixture:
      //   • under the old `expires_at DESC`, the arriving row sorts last and is
      //     reported as next to die;
      //   • under the FRACTION it ranks top, and this aged row is the victim.
      // A seeded declared life longer than the 15-minute volatile clamp is
      // deliberate: `assertFact` would flatten every fraction to ~1.0, which is
      // precisely the degenerate fixture this test must not have.
      { key: 'most-elapsed', confidence: 'verified', ageSec: 29_000, ttlSec: 30_000 },
      ...volatileCohort(VOLATILE_CAP - 1, { confidence: 'verified', ageSec: 60, ttlSec: 3600 }),
    ]);

    const urgent = await assertFact(
      volatileWrite('owner', scopeRef, 'urgent-48h', { body: 'a live hazard, true for about two days' }),
      db.sql,
    );

    // Non-vacuity: the cap BIT, so every verdict below came from a ranking that
    // actually ran — and it took the most-elapsed row, not the shortest-lived.
    expect(urgent.evicted?.map((e) => e.key)).toEqual(['most-elapsed']);

    // ── THE REGRESSION ASSERTION ───────────────────────────────────────────
    // This was `true` under `expires_at DESC`: the write arrived already last
    // in line, and the next assert by anyone destroyed it.
    expect(urgent.survival?.nextVictim).toBe(false);

    // Against 8h-old incumbents (~0.989 of their life left) a freshly-written
    // 48h fact holds ~0.99999, so it is the SAFEST row in the scope.
    expect(urgent.survival?.rank).toBe(1);

    // ⚠ Not a claim that a short-lived fact now lives its full life. It does
    // not: both rows age, and a shorter declared life loses ground faster, so
    // it eventually falls to last. That is the fix working as designed rather
    // than a residual bug — at the crossover both facts have spent the same
    // share of the life their authors declared, so they are genuinely
    // comparable losses. The change is the removal of the TTL floor that made
    // the scope structurally closed to short-lived facts; it is not
    // immortality, and should not be sold as it.
    expect(urgent.survival!.rank).toBeLessThan(urgent.survival!.liveCount);

    // The point of "not doomed on arrival" is that it also survives the NEXT
    // agent's unrelated write — the fifteen-second death in the report was
    // caused by a stranger's assert, not by its own.
    const later = await assertFact(
      volatileWrite('owner', scopeRef, 'a-later-write', {
        createdBy: 'su-other-writer',
        body: 'by someone else entirely',
      }),
      db.sql,
    );
    expect(later.evicted?.map((e) => e.key)).not.toContain('urgent-48h');

    const stillLive = await foldFacts(
      [{ scope: 'owner', scopeRef }],
      { workspaceId: WS, audiences: 'all', limitPerSelector: 500 },
      db.sql,
    );
    expect(stillLive.map((f) => f.key)).toContain('urgent-48h');
  }, 15_000);

  it('EI-19451909636567773: a write that lands mid-ranking is NOT alarmed — a warning that always fires is one nobody reads', async () => {
    const scopeRef = 'su-survival-quiet';
    const base = { scope: 'owner' as const, scopeRef, createdBy: 'su-int', workspaceId: WS };

    // ⚠ PORTED TO THE VOLATILE PARTITION (P-002 / D-004 §1) — the alarm this
    // pins is part of the survival receipt, which only the volatile sweep
    // produces now.
    //
    // Well-elapsed incumbents this time (two thirds of their declared life
    // spent), so a freshly-measured newcomer outranks all of them rather than
    // sinking to the bottom.
    await seedVolatile(
      'owner',
      scopeRef,
      volatileCohort(VOLATILE_CAP, { confidence: 'verified', ageSec: 600, ttlSec: 900 }),
    );

    const safe = await assertFact(
      volatileWrite('owner', scopeRef, 'well-declared', { body: 'freshly measured, plenty of life left' }),
      db.sql,
    );

    // Non-vacuity: the cap bit here too, so `nextVictim:false` is a real verdict
    // from a ranking that ran — not the silence of a scope under its cap.
    expect(safe.evicted?.length).toBeGreaterThan(0);
    expect(safe.survival).toBeDefined();
    expect(safe.survival?.nextVictim).toBe(false);
    expect(safe.survival?.rank).toBe(1);
    // Nothing ranks above it, so there is no bar to report — and reporting one
    // anyway would imply a threat that does not exist.
    expect(safe.survival?.survivingFractionFloor).toBeNull();
  });

  it('WI-6935 (b): a cap eviction is distinguishable from a deliberate retract via evicted_at', async () => {
    const scopeRef = 'su-evicted-at';
    const base = { scope: 'owner' as const, scopeRef, createdBy: 'su-int', workspaceId: WS };

    // ⚠ PORTED TO THE VOLATILE PARTITION (P-002 / D-004 §1): `evicted_at` is
    // stamped only by the volatile sweep now, so this is the one partition on
    // which the ambiguity it resolves can still arise. That the ORDINARY
    // partition never stamps it at all is the complementary claim, asserted by
    // the P-002 ceiling suite's `evicted: 0` census.
    //
    // `deliberate` is asserted first and then explicitly retracted, so it carries a
    // retracted_at that the cap did NOT write — the control case.
    await assertFact({ ttlSec: 3600, ...base, key: 'deliberate', body: 'retract me on purpose' }, db.sql);
    await retractFact({ scope: 'owner', scopeRef, key: 'deliberate', workspaceId: WS }, db.sql);

    // …and a volatile row placed at the bottom of its partition's ranking, so
    // the machine's choice of victim is determinate rather than a tie.
    await seedVolatile('owner', scopeRef, [
      { key: 'doomed-snapshot', confidence: 'suspected', ageSec: 890, ttlSec: 900 },
      ...volatileCohort(VOLATILE_CAP - 1),
    ]);
    const arrival = await assertFact(volatileWrite('owner', scopeRef, 'a-new-snapshot'), db.sql);
    expect(arrival.evicted?.map((e) => e.key)).toEqual(['doomed-snapshot']);

    const rows = await db.sql<{ key: string; retracted: boolean; evicted: boolean }[]>`
      SELECT key,
             (retracted_at IS NOT NULL) AS retracted,
             (evicted_at   IS NOT NULL) AS evicted
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'owner' AND scope_ref = ${scopeRef}
         AND superseded_at IS NULL
         AND key IN ('deliberate', 'doomed-snapshot')`;
    const byKey = new Map(rows.map((r) => [r.key, r]));

    // Both rows are retracted — that is exactly the ambiguity this column resolves.
    expect(byKey.get('doomed-snapshot')?.retracted).toBe(true);
    expect(byKey.get('deliberate')?.retracted).toBe(true);
    // …and only the machine-chosen one is stamped evicted.
    expect(byKey.get('doomed-snapshot')?.evicted).toBe(true);
    expect(byKey.get('deliberate')?.evicted).toBe(false);
  });

  it('EI-19485000346355077: listFactEvictionDisclosures reports a recent cap eviction to an ORDINARY reader (not just the writer)', async () => {
    const scopeRef = 'su-eviction-disclosure';

    // ⚠ PORTED TO THE VOLATILE PARTITION (P-002 / D-004 §1) — there is nothing
    // to disclose on the ordinary partition any more, because nothing is
    // destroyed there. Saturate the volatile partition, then write into it
    // three times so the cap evicts three incumbents.
    await seedVolatile('owner', scopeRef, volatileCohort(VOLATILE_CAP, { prefix: 'sat' }));
    for (let i = 0; i < 3; i++) {
      await assertFact(volatileWrite('owner', scopeRef, `arrival-${i}`), db.sql);
    }

    const disclosures = await listFactEvictionDisclosures(
      [{ scope: 'owner', scopeRef }],
      { workspaceId: WS },
      db.sql,
    );

    expect(disclosures).toHaveLength(1);
    expect(disclosures[0].scope).toBe('owner');
    expect(disclosures[0].scopeRef).toBe(scopeRef);
    expect(disclosures[0].recentEvictedCount).toBeGreaterThanOrEqual(3);
    expect(disclosures[0].latestEvictedAt).toEqual(expect.any(String));
    expect(disclosures[0].meaning).toContain('cap-evicted');
    // The notice must say WHICH population lost rows, and must not leave an
    // ordinary reader suspecting their standing facts were destroyed — under
    // D-003 they cannot have been, and a disclosure that implies otherwise
    // sends the reader hunting for a loss that did not happen.
    expect(disclosures[0].meaning).toContain('VOLATILE');
    expect(disclosures[0].meaning).toMatch(/Ordinary standing facts are never evicted/);
  });

  it('EI-19485000346355077: listFactEvictionDisclosures is silent for a scope with no cap evictions', async () => {
    const scopeRef = 'su-eviction-disclosure-quiet';
    await assertFact(
      { ttlSec: 3600, scope: 'owner', scopeRef, key: 'only-one', body: 'x', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );

    const disclosures = await listFactEvictionDisclosures(
      [{ scope: 'owner', scopeRef }],
      { workspaceId: WS },
      db.sql,
    );

    expect(disclosures).toHaveLength(0);
  });

  it('EI-19485000346355077: an OUT-OF-WINDOW cap eviction is not disclosed — the read is bounded, not a permanent scar', async () => {
    const scopeRef = 'su-eviction-disclosure-stale';
    // Ported to the volatile partition for the same reason as its sibling above.
    await seedVolatile('owner', scopeRef, volatileCohort(VOLATILE_CAP, { prefix: 'stale' }));
    for (let i = 0; i < 2; i++) {
      await assertFact(volatileWrite('owner', scopeRef, `arrival-${i}`), db.sql);
    }

    // A window of 0s means "nothing counts as recent" — proves the read is bounded
    // by windowSec rather than returning every eviction the scope has ever had.
    const disclosures = await listFactEvictionDisclosures(
      [{ scope: 'owner', scopeRef }],
      { workspaceId: WS, windowSec: 0 },
      db.sql,
    );

    expect(disclosures).toHaveLength(0);
  });
});

describe('P-002 / D-003 — the ORDINARY ceiling refuses the writer; it never destroys a stranger', () => {
  const PEER = 'su-a-peer';
  const ME = 'su-the-writer';

  /**
   * Saturate an ordinary scope to exactly `n` live cap-population rows.
   *
   * Direct INSERT rather than n asserts, deliberately: what these tests are
   * about is the state of a FULL scope, not the path that filled it, and
   * filling it through assertFact would make every test below quadratic in the
   * cap for no added coverage. The rows are another author's `verified`
   * findings because that is the population D-003 exists to protect — under the
   * old cap these were exactly the rows an unrelated write destroyed.
   */
  async function saturate(scopeRef: string, n: number = CAP): Promise<void> {
    await db.sql`
      INSERT INTO harness_shared.agent_facts
        (workspace_id, scope, scope_ref, key, body, created_by, expires_at, confidence)
      SELECT ${WS}, 'owner', ${scopeRef}, 'incumbent-' || g::text,
             'a peer finding ' || g::text, ${PEER},
             now() + interval '30 days', 'verified'
        FROM generate_series(1, ${n}) AS g`;
  }

  async function census(scopeRef: string): Promise<{ live: number; evicted: number; retracted: number }> {
    const [row] = await db.sql<{ live: number; evicted: number; retracted: number }[]>`
      SELECT count(*) FILTER (
               WHERE superseded_at IS NULL AND retracted_at IS NULL AND expires_at > now()
             )::int AS live,
             count(*) FILTER (WHERE evicted_at IS NOT NULL)::int AS evicted,
             count(*) FILTER (WHERE retracted_at IS NOT NULL)::int AS retracted
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'owner' AND scope_ref = ${scopeRef}`;
    return row;
  }

  const arriving = (scopeRef: string, key: string) => ({
    scope: 'owner' as const,
    scopeRef,
    workspaceId: WS,
    key,
    body: 'an arriving finding',
    createdBy: ME,
    confidence: 'verified' as const,
    ttlSec: 30 * 86400,
  });

  it('REFUSES a new key at the ceiling — and every incumbent is still alive afterwards', async () => {
    const scopeRef = 'su-ceiling-refuses';
    await saturate(scopeRef);

    await expect(assertFact(arriving(scopeRef, 'arriving'), db.sql)).rejects.toThrow(/REFUSED/);

    // The load-bearing half. A refusal that still destroyed something would be
    // strictly worse than the eviction it replaced — the writer would pay AND a
    // stranger would. `evicted: 0` is the D-003 invariant; `live: CAP` proves
    // the population is intact rather than merely un-evicted-looking.
    expect(await census(scopeRef)).toEqual({ live: CAP, evicted: 0, retracted: 0 });

    // …and the refusal is not a silent no-op either: nothing was written.
    const [{ n }] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'owner' AND scope_ref = ${scopeRef} AND key = 'arriving'`;
    expect(n).toBe(0);
  });

  it('the refusal names the ceiling and says nothing died — a writer must not go hunting for a victim', async () => {
    const scopeRef = 'su-ceiling-message';
    await saturate(scopeRef);

    // The old refusal named a victim and told the writer to coordinate with its
    // owner. Under D-003 there is no victim, so a message shaped like the old
    // one would send the writer looking for a peer who does not exist.
    await expect(assertFact(arriving(scopeRef, 'arriving'), db.sql)).rejects.toThrow(
      /NOTHING WAS WRITTEN AND NOTHING WAS DESTROYED/,
    );
    await expect(assertFact(arriving(scopeRef, 'arriving'), db.sql)).rejects.toThrow(
      new RegExp(`${CAP}-fact ceiling`),
    );
  });

  it('a RE-ASSERT of an existing key still succeeds at the ceiling — a full scope stays CORRECTABLE', async () => {
    const scopeRef = 'su-ceiling-correctable';
    await saturate(scopeRef);

    // This is what makes a refusal recoverable rather than a deadlock: the
    // population count excludes the incoming key, so revising a fact already
    // here consumes no new seat. Without it, a saturated scope would freeze
    // with its contents uncorrectable — including wrong ones.
    const revised = await assertFact(
      {
        ...arriving(scopeRef, 'incumbent-1'),
        createdBy: PEER,
        body: 'the same fact, corrected',
      },
      db.sql,
    );
    expect(revised.body).toBe('the same fact, corrected');

    // Superseding leaves the live population unchanged, and still destroys nothing.
    const after = await census(scopeRef);
    expect(after.live).toBe(CAP);
    expect(after.evicted).toBe(0);

    // A retraction must also remain possible — that is how a scope is DRAINED
    // back below its ceiling by the author responsible for the pressure.
    await retractFact(
      { scope: 'owner', scopeRef, key: 'incumbent-2', workspaceId: WS, retractedBy: PEER, reason: 'no longer true' },
      db.sql,
    );
    expect((await census(scopeRef)).live).toBe(CAP - 1);

    // …and with a seat freed, the previously-refused write now lands.
    await expect(assertFact(arriving(scopeRef, 'arriving'), db.sql)).resolves.toBeTruthy();
  });

  it('an EXEMPT key is still writable at the ceiling — a wall must never be un-recordable', async () => {
    const scopeRef = 'su-ceiling-exempt';
    await saturate(scopeRef);

    // Exempt keys take no cap seat, so they are neither evicted nor refused.
    // The failure this guards is the mirror of WI-6935's: that bug DESTROYED a
    // wall under cap pressure, and a ceiling applied to exempt writes would
    // instead make one impossible to RECORD — same outcome (no wall), arrived
    // at from the opposite direction.
    for (const key of ['wall:owner-must-ratify', 'dead-end:already-tried', 'guard-rail:do-not-widen']) {
      await expect(assertFact({ ...arriving(scopeRef, key), body: 'safety slot' }, db.sql)).resolves.toBeTruthy();
    }
    await expect(
      assertFact({ ...arriving(scopeRef, 'a-convention'), kind: 'convention', body: 'how we do it' }, db.sql),
    ).resolves.toBeTruthy();

    expect((await census(scopeRef)).evicted).toBe(0);
  });

  it('the dry run AGREES with the write: wouldRefuse ⇒ the write throws, and it forecasts no victim', async () => {
    const scopeRef = 'su-ceiling-preview';
    await saturate(scopeRef);

    const preview = await previewFactCapImpact(arriving(scopeRef, 'arriving'), db.sql);
    expect(preview.wouldRefuse).toBe(true);
    expect(preview.atCap).toBe(true);
    // A forecast that still named victims would be describing the mechanism
    // this plan removed — and a caller reading it would decline a write for a
    // cost that no longer exists.
    expect(preview.wouldEvict).toEqual([]);
    expect(preview.survival).toBeNull();

    // Preview and write must not disagree about the same input.
    await expect(assertFact(arriving(scopeRef, 'arriving'), db.sql)).rejects.toThrow(/REFUSED/);

    // The re-assert case must forecast NO refusal, matching the write above.
    const refresh = await previewFactCapImpact(
      { ...arriving(scopeRef, 'incumbent-1'), createdBy: PEER },
      db.sql,
    );
    expect(refresh.replacesExistingKey).toBe(true);
    expect(refresh.wouldRefuse).toBe(false);
  });

  it('BELOW the ceiling nothing is refused and nothing is evicted — the control that keeps the guards above non-vacuous', async () => {
    const scopeRef = 'su-below-ceiling';
    // One seat short of the ceiling: the last legal new key.
    await saturate(scopeRef, CAP - 1);

    const preview = await previewFactCapImpact(arriving(scopeRef, 'arriving'), db.sql);
    expect(preview.wouldRefuse).toBe(false);
    await expect(assertFact(arriving(scopeRef, 'arriving'), db.sql)).resolves.toBeTruthy();

    // Exactly at the ceiling now, having destroyed nothing on the way.
    expect(await census(scopeRef)).toEqual({ live: CAP, evicted: 0, retracted: 0 });

    // And the NEXT new key is refused — proving the bound still bites, which is
    // what separates "backpressure" from "we removed the cap".
    await expect(assertFact(arriving(scopeRef, 'one-too-many'), db.sql)).rejects.toThrow(/REFUSED/);
  });
});

describe('EI-15900 cross-key supersession — one current conclusion replaces its siblings', () => {
  const scopeRef = 'su-cross-key-supersession';
  const base = {
    scope: 'owner' as const,
    scopeRef,
    createdBy: 'su-reconciler',
    workspaceId: WS,
  };
  const selector = { scope: 'owner' as const, scopeRef };

  it('normalizes + deduplicates keys, retires only current same-scope locals, and reports what changed', async () => {
    await assertFact({ ttlSec: 3600, ...base, key: 'incident-a', body: 'partial diagnosis A' }, db.sql);
    await assertFact({ ttlSec: 3600, ...base, key: 'incident-b', body: 'partial diagnosis B' }, db.sql);
    await assertFact({ ttlSec: 3600, ...base, key: 'already-retired', body: 'old conclusion' }, db.sql);
    await retractFact(
      {
        ...selector,
        key: 'already-retired',
        workspaceId: WS,
        retractedBy: 'su-earlier',
        reason: 'already obsolete',
      },
      db.sql,
    );
    await assertFact(
      { ttlSec: 3600,
        ...base,
        scopeRef: 'a-different-owner',
        key: 'wrong-scope',
        body: 'must remain live',
      },
      db.sql,
    );

    const replacement = await assertFact(
      { ttlSec: 3600,
        ...base,
        key: 'incident-settled',
        body: 'one corrected incident conclusion',
        supersedes: [
          ' incident-b ',
          'incident-a',
          'incident-a',
          'missing-key',
          'wrong-scope',
          'already-retired',
          '   ',
        ],
      },
      db.sql,
    );

    expect(replacement.retiredKeys).toEqual(['incident-a', 'incident-b']);

    const retired = await db.sql`
      SELECT key, retracted_by, retraction_reason, evicted_at
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'owner' AND scope_ref = ${scopeRef}
         AND key = ANY(${['incident-a', 'incident-b']}::text[])
       ORDER BY key`;
    expect(retired).toEqual([
      {
        key: 'incident-a',
        retracted_by: 'su-reconciler',
        retraction_reason: 'superseded by incident-settled',
        evicted_at: null,
      },
      {
        key: 'incident-b',
        retracted_by: 'su-reconciler',
        retraction_reason: 'superseded by incident-settled',
        evicted_at: null,
      },
    ]);

    const folded = await foldFacts([selector], { workspaceId: WS, audiences: 'all' }, db.sql);
    const listed = await listFacts(selector, { workspaceId: WS }, db.sql);
    expect(folded.map((fact) => fact.key)).toEqual(['incident-settled']);
    expect(listed.map((fact) => fact.key)).toEqual(['incident-settled']);

    const wrongScope = await listFacts({ scope: 'owner', scopeRef: 'a-different-owner' }, { workspaceId: WS }, db.sql);
    expect(wrongScope.map((fact) => fact.key)).toContain('wrong-scope');

    const [alreadyRetired] = await factVersions({ ...selector, key: 'already-retired', workspaceId: WS }, db.sql);
    expect(alreadyRetired.retractedBy).toBe('su-earlier');
    expect(alreadyRetired.retractionReason).toBe('already obsolete');
  });

  it('refuses the asserted key itself and enforces the direct-store fan-out bound', async () => {
    await expect(
      assertFact(
        { ttlSec: 3600,
          ...base,
          key: 'self-key',
          body: 'must not write',
          supersedes: [' self-key '],
        },
        db.sql,
      ),
    ).rejects.toThrow(/supersedes cannot contain the asserted key/);

    await expect(
      assertFact(
        { ttlSec: 3600,
          ...base,
          key: 'too-many',
          body: 'must not write',
          supersedes: Array.from({ length: 13 }, (_, i) => `sibling-${i}`),
        },
        db.sql,
      ),
    ).rejects.toThrow(/at most 12 distinct keys/);

    expect(await listFacts(selector, { workspaceId: WS }, db.sql)).toEqual([]);
  });

  it('rolls sibling retirement back when the replacement insert fails', async () => {
    await assertFact({ ttlSec: 3600, ...base, key: 'still-valid', body: 'keep me on failed replacement' }, db.sql);
    const invalid = {
      ttlSec: 3600,
      scope: 'owner',
      scopeRef,
      key: 'replacement-fails',
      body: 'missing createdBy on purpose',
      supersedes: ['still-valid'],
      workspaceId: WS,
    } as unknown as Parameters<typeof assertFact>[0];

    await expect(assertFact(invalid, db.sql)).rejects.toThrow(/created_by/i);
    const live = await listFacts(selector, { workspaceId: WS }, db.sql);
    expect(live.map((fact) => fact.key)).toEqual(['still-valid']);
  });
});

// EI-19328780288425209: a retractFact miss is ambiguous — "never existed" vs "exists at a
// DIFFERENT scope" — the latter left a WRONG fact live and believed-retracted for 5h+ while
// the author had already told six agents it was gone. findFactKeyElsewhere is the disambiguator
// retract.ts calls on a miss, before reporting bare `retracted:false`.
describe('findFactKeyElsewhere (EI-19328780288425209 — the retract-scope-miss disambiguator)', () => {
  it('finds the SAME key live at a DIFFERENT scope/scopeRef', async () => {
    await assertFact(
      { ttlSec: 3600, scope: 'harness', scopeRef: 'papercusp', key: 'elsewhere-1', body: 'b', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const hits = await findFactKeyElsewhere(
      { scope: 'workspace', scopeRef: '', key: 'elsewhere-1', workspaceId: WS },
      db.sql,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.scope).toBe('harness');
    expect(hits[0]!.scopeRef).toBe('papercusp');
    expect(typeof hits[0]!.id).toBe('number');
  });

  it('is empty when the key truly does not exist anywhere', async () => {
    const hits = await findFactKeyElsewhere(
      { scope: 'workspace', scopeRef: '', key: 'genuinely-never-asserted-xyz', workspaceId: WS },
      db.sql,
    );
    expect(hits).toEqual([]);
  });

  it('excludes the scope actually searched — a hit there means retractFact should not have missed', async () => {
    await assertFact(
      { ttlSec: 3600, scope: 'owner', scopeRef: 'su-elsewhere', key: 'elsewhere-2', body: 'b', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const hits = await findFactKeyElsewhere(
      { scope: 'owner', scopeRef: 'su-elsewhere', key: 'elsewhere-2', workspaceId: WS },
      db.sql,
    );
    expect(hits).toEqual([]);
  });

  it('excludes a RETRACTED copy at another scope — retraction is not a live "elsewhere" hit', async () => {
    await assertFact(
      { ttlSec: 3600, scope: 'harness', scopeRef: 'papercusp', key: 'elsewhere-3', body: 'b', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    await retractFact({ scope: 'harness', scopeRef: 'papercusp', key: 'elsewhere-3', workspaceId: WS }, db.sql);
    const hits = await findFactKeyElsewhere(
      { scope: 'workspace', scopeRef: '', key: 'elsewhere-3', workspaceId: WS },
      db.sql,
    );
    expect(hits).toEqual([]);
  });
});

describe('findFactKeyMatches (EI-20246178086794269 — key-only retract resolution)', () => {
  it('returns one current identity for a unique key and both identities when the key is ambiguous', async () => {
    await assertFact(
      { ttlSec: 3600, scope: 'owner', scopeRef: 'su-key-only', key: 'key-only-unique', body: 'b', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    await assertFact(
      { ttlSec: 3600, scope: 'owner', scopeRef: 'su-key-only', key: 'key-only-shared', body: 'b', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    await assertFact(
      { ttlSec: 3600, scope: 'harness', scopeRef: 'papercusp', key: 'key-only-shared', body: 'b', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );

    const unique = await findFactKeyMatches({ key: 'key-only-unique', workspaceId: WS }, db.sql);
    expect(unique).toHaveLength(1);
    expect(unique[0]).toMatchObject({ scope: 'owner', scopeRef: 'su-key-only' });

    const ambiguous = await findFactKeyMatches({ key: 'key-only-shared', workspaceId: WS }, db.sql);
    expect(ambiguous).toHaveLength(2);
    expect(new Set(ambiguous.map((row) => `${row.scope}:${row.scopeRef}`))).toEqual(
      new Set(['owner:su-key-only', 'harness:papercusp']),
    );
  });

  it('ignores retracted and superseded copies when resolving a key', async () => {
    await assertFact(
      { ttlSec: 3600, scope: 'owner', scopeRef: 'su-key-history', key: 'key-only-history', body: 'old', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    await assertFact(
      { ttlSec: 3600, scope: 'owner', scopeRef: 'su-key-history', key: 'key-only-history', body: 'current', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );

    const matches = await findFactKeyMatches({ key: 'key-only-history', workspaceId: WS }, db.sql);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ scope: 'owner', scopeRef: 'su-key-history' });
  });
});

describe('P-008 (b) depends_on / kind / claim (migration 690)', () => {
  const base = { scope: 'owner' as const, scopeRef: 'su-d', key: 'dep', createdBy: 'su-int', workspaceId: WS };
  const dep = (over: Partial<FactDependency> = {}): FactDependency => ({
    cell: 'pipeline.myChange',
    observedAt: '2026-07-27T00:00:00.000Z',
    digest: 'abc123def4567890',
    observed: 'deployed',
    ...over,
  });
  const read = async () =>
    (await foldFacts([{ scope: 'owner', scopeRef: 'su-d' }], { workspaceId: WS, audiences: 'all' }, db.sql)).find(
      (f) => f.key === 'dep',
    );

  it('round-trips all three columns through assert → fold', async () => {
    await assertFact(
      {
        ...base,
        body: 'the reds are unrelated to my change',
        kind: 'assumption',
        confidence: 'suspected',
        dependsOn: [dep()],
        claim: { subject: 'cell:gate.greenCheckpoint.verdict', assertion: 'unrelated-to-my-change' },
      },
      db.sql,
    );
    const f = await read();
    expect(f?.kind).toBe('assumption');
    expect(f?.claim).toEqual({ subject: 'cell:gate.greenCheckpoint.verdict', assertion: 'unrelated-to-my-change' });
    expect(f?.dependsOn).toEqual([dep()]);
  });

  it('a fact with no declaration reads kind:null, claim:null and an EMPTY dependsOn (never null)', async () => {
    await assertFact({ ttlSec: 3600, ...base, body: 'plain' }, db.sql);
    const f = await read();
    expect(f?.kind).toBeNull();
    expect(f?.claim).toBeNull();
    // [] not null: "cannot go stale on declared terms" is one state, and every
    // consumer iterates it without a guard.
    expect(f?.dependsOn).toEqual([]);
  });

  it('an UNREADABLE dependency stores its unknown code instead of a digest — never an empty one', async () => {
    // The laundering this forbids: a blank digest would later compare EQUAL to
    // another failed read and certify the fact as fresh.
    await assertFact(
      { ttlSec: 3600, ...base, body: 'rests on something I could not read', dependsOn: [dep({ digest: undefined, unknown: 'not-measured' })] },
      db.sql,
    );
    const f = await read();
    expect(f?.dependsOn[0].digest).toBeUndefined();
    expect(f?.dependsOn[0].unknown).toBe('not-measured');
  });

  it('⚠ depends_on does NOT carry forward to a corrected version — it is an observation, not an identity', async () => {
    await assertFact({ ttlSec: 3600, ...base, body: 'one', dependsOn: [dep()] }, db.sql);
    await assertFact({ ttlSec: 3600, ...base, body: 'two' }, db.sql);
    // Inheriting the old digest would stamp a reading taken at v1's time onto a
    // claim made later, and it would fail in the CONFIDENT direction (reporting
    // fresh against an anchor that was never re-observed).
    expect((await read())?.dependsOn).toEqual([]);
    // …while the superseded version keeps its own, intact.
    const hist = await factVersions({ scope: 'owner', scopeRef: 'su-d', key: 'dep', workspaceId: WS }, db.sql);
    expect(hist[1].dependsOn).toEqual([dep()]);
  });

  it('normalizes on write: de-dupes by cell, drops anchorless entries, and bounds the list', async () => {
    await assertFact(
      { ttlSec: 3600,
        ...base,
        body: 'messy declaration',
        dependsOn: [
          dep({ cell: 'a' }),
          dep({ cell: 'a', observed: 'a second observation of the same cell' }), // dupe
          { cell: 'b', observedAt: '2026-07-27T00:00:00.000Z' } as FactDependency, // anchorless
          dep({ cell: 'c' }),
        ],
      },
      db.sql,
    );
    const f = await read();
    expect(f?.dependsOn.map((d) => d.cell)).toEqual(['a', 'c']);
    expect(f?.dependsOn[0].observed).toBe('deployed'); // FIRST occurrence wins
  });

  it('the DB CHECK rejects an out-of-vocabulary kind written around the store', async () => {
    await expect(
      db.sql`INSERT INTO harness_shared.agent_facts
               (workspace_id, scope, scope_ref, key, body, created_by, expires_at, kind)
             VALUES (${WS}, 'owner', 'su-d', 'bad-kind', 'x', 'su-int', now() + interval '1 day', 'guess')`,
    ).rejects.toThrow();
  });

  it('the store refuses an unknown kind as INVALID INPUT, not as a 500 from the CHECK', async () => {
    await expect(
      assertFact({ ttlSec: 3600, ...base, body: 'x', kind: 'hunch' as never }, db.sql),
    ).rejects.toThrow(/unknown kind/);
  });

  it('a version chain preserves each version OWN kind — a modality change is history, not a rewrite', async () => {
    await assertFact({ ttlSec: 3600, ...base, body: 'one', kind: 'assumption' }, db.sql);
    await assertFact({ ttlSec: 3600, ...base, body: 'two', kind: 'conclusion' }, db.sql);
    const hist = await factVersions({ scope: 'owner', scopeRef: 'su-d', key: 'dep', workspaceId: WS }, db.sql);
    expect(hist.map((h) => h.kind)).toEqual(['conclusion', 'assumption']);
  });
});

describe('P-010 standing-fact recheck contract (migration 940)', () => {
  const base = {
    scope: 'owner' as const,
    scopeRef: 'su-recheck',
    key: 'deploy-position',
    body: 'the release is at the green pin',
    createdBy: 'su-int',
    workspaceId: WS,
  };
  const recheck = {
    probe: 'Run release:deploy { op:"status" } and read the deployed pin.',
    falsifier: 'The deployed pin differs from the current green checkpoint pin.',
  };

  it('round-trips through assert, fold, version history, and does not carry forward implicitly', async () => {
    const written = await assertFact({ ttlSec: 3600, ...base, recheck }, db.sql);
    expect(written.recheck).toEqual(recheck);
    const folded = await foldFacts(
      [{ scope: 'owner', scopeRef: 'su-recheck' }],
      { workspaceId: WS, audiences: 'all' },
      db.sql,
    );
    expect(folded.find((f) => f.key === base.key)?.recheck).toEqual(recheck);
    expect(renderFactsFold([written], Date.parse(written.updatedAt) + 2 * 86_400_000)).toContain(
      `RECHECK: ${recheck.probe} — FALSIFIED IF: ${recheck.falsifier}`,
    );

    await assertFact({ ttlSec: 3600, ...base, body: 'corrected without a new recheck observation' }, db.sql);
    const history = await factVersions(
      { scope: 'owner', scopeRef: 'su-recheck', key: base.key, workspaceId: WS },
      db.sql,
    );
    expect(history.map((f) => f.recheck ?? null)).toEqual([null, recheck]);
  });

  it('surfaces the pair through the cross-scope convention read', async () => {
    await assertFact(
      {
        scope: 'workspace',
        key: 'recheck-convention',
        body: 'apply migrations through the runner',
        kind: 'convention',
        recheck,
        createdBy: 'su-int',
        workspaceId: WS,
      },
      db.sql,
    );
    expect((await listConventionFacts({ workspaceId: WS }, db.sql))[0].recheck).toEqual(recheck);
  });

  it('the store refuses malformed pairs before SQL', async () => {
    await expect(
      assertFact({ ttlSec: 3600, ...base, recheck: { probe: 'only one half' } as never }, db.sql),
    ).rejects.toThrow(
      /exactly probe and falsifier/,
    );
    await expect(
      assertFact({ ttlSec: 3600, ...base, recheck: { probe: 'x'.repeat(501), falsifier: 'no' } }, db.sql),
    ).rejects.toThrow(
      /500-character cap/,
    );
  });

  it('the DB CHECK rejects half-contracts and extra keys written around the store', async () => {
    const insertRaw = (key: string, value: Record<string, unknown>) => db.sql`
      INSERT INTO harness_shared.agent_facts
        (workspace_id, scope, scope_ref, key, body, created_by, expires_at, recheck)
      VALUES
        (${WS}, 'owner', 'su-db-recheck', ${key}, 'raw write', 'su-int', now() + interval '1 day',
         ${JSON.stringify(value)}::text::jsonb)`;
    await expect(insertRaw('half', { probe: 'run it' })).rejects.toThrow();
    await expect(insertRaw('extra', { ...recheck, surprise: true })).rejects.toThrow();
    await expect(insertRaw('too-long', { probe: 'x'.repeat(501), falsifier: 'no' })).rejects.toThrow();
    await expect(insertRaw('valid', recheck)).resolves.toBeDefined();
  });
});

describe('P-004 executable guard rails (migration 1240, guard-rail-probes.ts)', () => {
  const recheck = {
    probe: 'Check the rig lease is held before booting the VM sidecar.',
    falsifier: 'The lease probe exits non-zero.',
  };
  const exec = { command: 'true', expectExitCode: 0, scope: ['p505'] };
  const insertRaw = (key: string, value: unknown, extra = '') =>
    db.sql.unsafe(
      `INSERT INTO harness_shared.agent_facts
         (workspace_id, scope, scope_ref, key, body, created_by, expires_at, recheck${extra ? ', source_hive, origin, shareable' : ''})
       VALUES ($1, 'workspace', NULL, $2, 'raw write', 'su-int', now() + interval '1 day', $3::text::jsonb${extra})`,
      [WS, key, JSON.stringify(value)],
    );

  it('the DB CHECK admits a well-formed exec and refuses one the loader would misread', async () => {
    await expect(insertRaw('guard-rail:ok', { ...recheck, exec })).resolves.toBeDefined();
    await expect(insertRaw('guard-rail:no-scope', { ...recheck, exec: { ...exec, scope: [] } })).rejects.toThrow();
    await expect(
      insertRaw('guard-rail:string-code', { ...recheck, exec: { ...exec, expectExitCode: '0' } }),
    ).rejects.toThrow();
    await expect(insertRaw('guard-rail:no-command', { ...recheck, exec: { expectExitCode: 0, scope: ['p505'] } })).rejects.toThrow();
  });

  it('loads live local-origin exec facts whose scope overlaps, and nothing else', async () => {
    await assertFact(
      {
        scope: 'workspace',
        key: 'guard-rail:rig-lease',
        body: 'hold the rig lease before touching the VM',
        kind: 'convention',
        recheck: { ...recheck, exec: { ...exec, stdoutIncludes: 'held' } },
        createdBy: 'su-int',
        workspaceId: WS,
      },
      db.sql,
    );
    await assertFact(
      {
        scope: 'workspace',
        key: 'guard-rail:other-harness',
        body: 'a rail for a different harness',
        kind: 'convention',
        recheck: { ...recheck, exec: { ...exec, scope: ['relcut'] } },
        createdBy: 'su-int',
        workspaceId: WS,
      },
      db.sql,
    );
    await assertFact(
      { scope: 'workspace', key: 'guard-rail:prose-only', body: 'no exec', kind: 'convention', recheck, createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    // D-003: a federated copy of an exec fact must never be executed here.
    await insertRaw('guard-rail:federated', { ...recheck, exec }, ", 'peer-log-key', 'remote', true");
    await assertFact(
      {
        scope: 'workspace',
        key: 'guard-rail:retracted',
        body: 'withdrawn',
        kind: 'convention',
        recheck: { ...recheck, exec },
        createdBy: 'su-int',
        workspaceId: WS,
      },
      db.sql,
    );
    await retractFact({ scope: 'workspace', key: 'guard-rail:retracted', workspaceId: WS, reason: 'test' }, db.sql);

    const probes = await loadGuardRailProbes({ tags: ['p505'], workspaceId: WS }, db.sql);
    expect(probes).toEqual([
      {
        key: 'guard-rail:rig-lease',
        command: 'true',
        expect: { exitCode: 0, stdoutIncludes: 'held' },
        scope: ['p505'],
        lesson: 'hold the rig lease before touching the VM',
      },
    ]);
    expect((await loadGuardRailProbes({ tags: ['relcut', 'p505'], workspaceId: WS }, db.sql)).map((p) => p.key)).toEqual([
      'guard-rail:other-harness',
      'guard-rail:rig-lease',
    ]);
    expect(await loadGuardRailProbes({ tags: [], workspaceId: WS }, db.sql)).toEqual([]);
  });
});

describe('H6 local-partition discipline (foreign partitions untouchable locally)', () => {
  /** Seed a FOREIGN partition of an identity (what the projection writes). */
  async function seedForeign(key: string) {
    await db.sql`
      INSERT INTO harness_shared.agent_facts
        (workspace_id, scope, scope_ref, key, body, created_by, expires_at, shareable, source_hive, origin)
      VALUES (${WS}, 'harness', 'member-a', ${key}, 'a peer observation', 'peer', now() + interval '1 day', true, 'peer-log-key', 'remote')`;
  }

  it('the local assert coexists with a foreign partition of the SAME identity', async () => {
    await seedForeign('both');
    await assertFact(
      { ttlSec: 3600, scope: 'harness', scopeRef: 'member-a', key: 'both', body: 'local view', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const rows = await db.sql`SELECT source_hive FROM harness_shared.agent_facts WHERE key = 'both' ORDER BY source_hive NULLS FIRST`;
    expect(rows.length).toBe(2);
    expect(rows[0].source_hive).toBeNull();
    expect(rows[1].source_hive).toBe('peer-log-key');
  });

  it('retractFact retracts ONLY the local partition', async () => {
    await seedForeign('r1');
    await assertFact(
      { ttlSec: 3600, scope: 'harness', scopeRef: 'member-a', key: 'r1', body: 'local', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const did = await retractFact({ scope: 'harness', scopeRef: 'member-a', key: 'r1', workspaceId: WS }, db.sql);
    expect(did).toBe(true);
    const rows = await db.sql`
      SELECT source_hive, retracted_at FROM harness_shared.agent_facts WHERE key = 'r1' ORDER BY source_hive NULLS FIRST`;
    expect(rows[0].retracted_at).not.toBeNull(); // local: retracted
    expect(rows[1].retracted_at).toBeNull(); // foreign: untouched
  });

  it('cap eviction only ever retracts LOCAL rows', async () => {
    // ⚠ PORTED TO THE VOLATILE PARTITION (P-002 / D-004 §1). This guard used to
    // saturate the ORDINARY partition, which no longer evicts anything at all —
    // left there it would now pass against a sweep that never runs, i.e. it
    // would assert nothing while looking green.
    //
    // The foreign row must also be seeded INTO the volatile partition, and as
    // the WORST-ranked row in it. `capPopulationPredicate` excludes foreign rows
    // via `source_hive IS NULL`, so a foreign row that is ordinary — or merely
    // mid-ranking — survives for reasons that have nothing to do with H6, and
    // the test would hold just as happily with that clause deleted.
    await db.sql`
      INSERT INTO harness_shared.agent_facts
        (workspace_id, scope, scope_ref, key, body, created_by, created_at, updated_at,
         expires_at, confidence, shareable, source_hive, origin, measurement)
      VALUES (${WS}, 'harness', 'member-a', 'cap-foreign', 'a peer observation', 'peer',
              now() - interval '890 seconds', now() - interval '890 seconds',
              now() + interval '10 seconds', 'suspected', true, 'peer-log-key', 'remote',
              ${volatileMeasurement(890)}::text::jsonb)`;

    await seedVolatile('harness', 'member-a', volatileCohort(VOLATILE_CAP, { prefix: 'cap' }));
    const arrival = await assertFact(volatileWrite('harness', 'member-a', 'cap-arrival'), db.sql);

    // NON-VACUITY: the sweep must actually have FIRED on this write, or "the
    // foreign row survived" is a statement about a sweep that never ran.
    expect(arrival.evicted?.length).toBe(1);
    // …and it took a LOCAL row, despite the foreign one ranking below every
    // local incumbent (suspected, and 890 of its 900 declared seconds spent).
    expect(arrival.evicted?.[0].key).toMatch(/^cap-\d+$/);

    const foreign = await db.sql`
      SELECT retracted_at, evicted_at FROM harness_shared.agent_facts
       WHERE key = 'cap-foreign' AND source_hive IS NOT NULL`;
    expect(foreign[0].retracted_at).toBeNull();
    expect(foreign[0].evicted_at).toBeNull();
  });

  it('foldFacts surfaces BOTH partitions (foreign observations inform briefs)', async () => {
    await seedForeign('fold-1');
    await assertFact(
      { ttlSec: 3600, scope: 'harness', scopeRef: 'member-a', key: 'fold-1', body: 'local', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    const folded = await foldFacts([{ scope: 'harness', scopeRef: 'member-a' }], { workspaceId: WS }, db.sql);
    expect(folded.length).toBe(2);
  });
});

// ── coord-authority-hardening-2026-07-11 P-007 (mig 574): audience filter +
// source-provenance round-trip against the REAL columns ──
describe('P-007 audience_scope + source_provenance (mig 574)', () => {
  const SEL = [{ scope: 'harness' as const, scopeRef: 'papercusp' }];
  const base = {
    scope: 'harness' as const,
    scopeRef: 'papercusp',
    body: 'a conclusion',
    createdBy: 'su-int',
    workspaceId: WS,
  };
  const STAMP = {
    kind: 'msg' as const,
    verified: true,
    quote: 'the verbatim origin',
    label: 'msg m-1 (15179 → 4c85f, 2026-07-11T09:01Z)',
    verifiedAt: '2026-07-11T00:00:01.000Z',
  };

  it('audienceScope + sourceProvenance round-trip through assert → fold', async () => {
    await assertFact({ ttlSec: 3600, ...base, key: 'aud-rt', audienceScope: 'fleet:backend', sourceProvenance: STAMP }, db.sql);
    const [f] = await foldFacts(SEL, { workspaceId: WS, audiences: ['fleet:backend'] }, db.sql);
    expect(f.audienceScope).toBe('fleet:backend');
    expect(f.sourceProvenance).toEqual(STAMP);
  });

  it('fold default excludes audience-scoped facts; only the MATCHING audience (or "all") includes them', async () => {
    await assertFact({ ttlSec: 3600, ...base, key: 'aud-only', body: 'fleet-only', audienceScope: 'fleet:backend' }, db.sql);
    await assertFact({ ttlSec: 3600, ...base, key: 'open', body: 'for everyone' }, db.sql);

    const noAudience = await foldFacts(SEL, { workspaceId: WS }, db.sql);
    expect(noAudience.map((f) => f.key)).toEqual(['open']);

    const otherFleet = await foldFacts(SEL, { workspaceId: WS, audiences: ['fleet:frontend'] }, db.sql);
    expect(otherFleet.map((f) => f.key)).toEqual(['open']);

    const matching = await foldFacts(SEL, { workspaceId: WS, audiences: ['fleet:backend'] }, db.sql);
    expect(matching.map((f) => f.key).sort()).toEqual(['aud-only', 'open']);

    // facts:list's escape hatch — audience-scoped facts stay listable/retractable.
    const all = await foldFacts(SEL, { workspaceId: WS, audiences: 'all' }, db.sql);
    expect(all.map((f) => f.key).sort()).toEqual(['aud-only', 'open']);
  });

  it('a re-assert REPLACES audience + provenance (omitting them clears — fresh assert wins)', async () => {
    await assertFact({ ttlSec: 3600, ...base, key: 'swap', audienceScope: 'fleet:backend', sourceProvenance: STAMP }, db.sql);
    await assertFact({ ttlSec: 3600, ...base, key: 'swap', body: 'now unrestricted' }, db.sql);
    const [f] = await foldFacts(SEL, { workspaceId: WS }, db.sql); // default fold now sees it
    expect(f.key).toBe('swap');
    expect(f.audienceScope).toBeNull();
    expect(f.sourceProvenance).toBeNull();
  });

  it('a malformed/forged stored stamp reads back as null (defensive parse, fold never crashes)', async () => {
    await db.sql`
      INSERT INTO harness_shared.agent_facts
        (workspace_id, scope, scope_ref, key, body, created_by, expires_at, source_provenance)
      VALUES (${WS}, 'harness', 'papercusp', 'forged', 'b', 'peer', now() + interval '1 day',
              '{"kind":"god-mode","verified":"yes"}'::jsonb)`;
    const [f] = await foldFacts(SEL, { workspaceId: WS }, db.sql);
    expect(f.key).toBe('forged');
    expect(f.sourceProvenance).toBeNull();
  });
});

// WI-6052 (EI-18681964809855890 follow-up, mig 671): `confidence` reached the
// AgentFact contract + write-side TTL/lint behaviour but was never persisted —
// the INSERT/RETURNING/SELECT all omitted it, so it round-tripped as `null` on
// EVERY assert regardless of what the caller passed. This describe block is
// the regression: before mig 671 + the matching store.ts change, the first
// test here failed (`f.confidence` was `null`, not `'verified'`).
describe('confidence (evidence-strength tier, mig 671 / WI-6052)', () => {
  const SEL = [{ scope: 'harness' as const, scopeRef: 'papercusp' }];
  const base = {
    scope: 'harness' as const,
    scopeRef: 'papercusp',
    body: 'a conclusion',
    createdBy: 'su-int',
    workspaceId: WS,
  };

  it('confidence round-trips through assert → fold', async () => {
    await assertFact({ ttlSec: 3600, ...base, key: 'conf-rt', confidence: 'verified' }, db.sql);
    const [f] = await foldFacts(SEL, { workspaceId: WS }, db.sql);
    expect(f.confidence).toBe('verified');
  });

  it('each of the 3 tiers round-trips distinctly', async () => {
    await assertFact({ ttlSec: 3600, ...base, key: 'conf-verified', confidence: 'verified' }, db.sql);
    await assertFact({ ttlSec: 3600, ...base, key: 'conf-provisional', confidence: 'provisional' }, db.sql);
    await assertFact({ ttlSec: 3600, ...base, key: 'conf-suspected', confidence: 'suspected' }, db.sql);
    const facts = await foldFacts(SEL, { workspaceId: WS }, db.sql);
    const byKey = Object.fromEntries(facts.map((f) => [f.key, f.confidence]));
    expect(byKey['conf-verified']).toBe('verified');
    expect(byKey['conf-provisional']).toBe('provisional');
    expect(byKey['conf-suspected']).toBe('suspected');
  });

  it('omitted confidence stays null (legacy/unset shape, unaffected by mig 671)', async () => {
    await assertFact({ ttlSec: 3600, ...base, key: 'conf-unset' }, db.sql);
    const [f] = await foldFacts(SEL, { workspaceId: WS }, db.sql);
    expect(f.confidence).toBeNull();
  });

  it('a re-assert REPLACES confidence (omitting it clears — fresh assert wins, same semantics as audienceScope/sourceProvenance)', async () => {
    await assertFact({ ttlSec: 3600, ...base, key: 'conf-swap', confidence: 'suspected' }, db.sql);
    await assertFact({ ttlSec: 3600, ...base, key: 'conf-swap', body: 'now unset' }, db.sql);
    const [f] = await foldFacts(SEL, { workspaceId: WS }, db.sql);
    expect(f.key).toBe('conf-swap');
    expect(f.confidence).toBeNull();
  });

  it('the DB CHECK constraint (mig 671) rejects an unrecognized value at write time — defense in depth alongside the TS enum', async () => {
    await expect(
      db.sql`
        INSERT INTO harness_shared.agent_facts
          (workspace_id, scope, scope_ref, key, body, created_by, expires_at, confidence)
        VALUES (${WS}, 'harness', 'papercusp', 'conf-forged', 'b', 'peer', now() + interval '1 day', 'omniscient')`,
    ).rejects.toThrow(/agent_facts_confidence_check|violates check constraint/i);
  });
});

// EI-20191740437408337: a measurement of a changing artifact is not a settled
// property. The metadata must survive the real SQL round-trip, and the store
// must impose the short TTL even when the caller omits ttlSec.
describe('volatile measurements (migration 795)', () => {
  const SEL = [{ scope: 'harness' as const, scopeRef: 'papercusp' }];
  const base = {
    scope: 'harness' as const,
    scopeRef: 'papercusp',
    body: 'currently 29 supported rows',
    createdBy: 'su-int',
    workspaceId: WS,
  };
  const measuredAt = '2026-08-11T20:50:00.000Z';

  it('measurement metadata round-trips and defaults the TTL to 15 minutes', async () => {
    await assertFact({ ttlSec: 3600, ...base, key: 'volatile-rt', subjectVolatile: true, measuredAt }, db.sql);
    const [f] = await foldFacts(SEL, { workspaceId: WS }, db.sql);
    expect(f.measurement).toEqual({ subjectVolatile: true, measuredAt });
    const [row] = await db.sql<{ ttl_seconds: number }[]>`
      SELECT EXTRACT(EPOCH FROM (expires_at - created_at))::float AS ttl_seconds
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND key = 'volatile-rt' AND superseded_at IS NULL`;
    expect(row.ttl_seconds).toBeLessThanOrEqual(FACT_VOLATILE_MAX_TTL_SEC + 1);
  });

  it('a re-assert without the marker clears the prior snapshot metadata', async () => {
    await assertFact({ ttlSec: 3600, ...base, key: 'volatile-clear', subjectVolatile: true, measuredAt }, db.sql);
    await assertFact({ ttlSec: 3600, ...base, key: 'volatile-clear', body: 'the invariant is stable' }, db.sql);
    const [f] = await foldFacts(SEL, { workspaceId: WS }, db.sql);
    expect(f.measurement).toBeNull();
  });

  it('malformed stored metadata is fail-soft and never renders as a snapshot', async () => {
    await db.sql`
      INSERT INTO harness_shared.agent_facts
        (workspace_id, scope, scope_ref, key, body, created_by, expires_at, measurement)
      VALUES (${WS}, 'harness', 'papercusp', 'volatile-forged', 'b', 'peer', now() + interval '1 day',
              '{"subjectVolatile":true,"measuredAt":"not-a-date"}'::jsonb)`;
    const [f] = await foldFacts(SEL, { workspaceId: WS }, db.sql);
    expect(f.measurement).toBeNull();
  });
});

/**
 * P-006 / D-011 — the normalization repairs, pinned against the REAL DB.
 *
 * Why this block exists at all: `store.test.ts` is a validation-BOUNDARY suite (it runs on
 * `failSql`, which throws if reached), so it can only prove that a call is no longer
 * REFUSED. It cannot see what was written. A mutant that deleted the clamp — restoring
 * `const ttl = ... input.ttlSec ...` in place of `effectiveTtlSec` — still passes every
 * boundary test, because the call succeeds either way; it just persists a 7-day volatile
 * snapshot. The written value is only observable here, so this is where it is pinned.
 */
describe('P-006 / D-011 normalization writes the repaired value, not just a receipt', () => {
  const scopeRef = 'p006-normalization-writes';
  const base = {
    scope: 'harness' as const,
    scopeRef,
    body: 'load average is 38.08',
    createdBy: 'su-int',
    workspaceId: WS,
  };
  const measuredAt = '2026-08-21T15:09:06.000Z';
  const WEEK_SEC = 604_800;

  const ttlSecondsOf = async (key: string): Promise<number> => {
    const [row] = await db.sql<{ ttl_seconds: number }[]>`
      SELECT EXTRACT(EPOCH FROM (expires_at - created_at))::float AS ttl_seconds
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope_ref = ${scopeRef} AND key = ${key}
         AND superseded_at IS NULL`;
    return row.ttl_seconds;
  };

  it('CLAMPS the stored expires_at to the 15-minute ceiling, not the requested week', async () => {
    const result = await assertFact(
      { ...base, key: 'clamped', subjectVolatile: true, measuredAt, ttlSec: WEEK_SEC },
      db.sql,
    );

    // The written value. Under a no-clamp mutant this is 604800 and the test fails,
    // which is the entire point of asserting here rather than at the boundary.
    const ttlSeconds = await ttlSecondsOf('clamped');
    expect(ttlSeconds).toBeGreaterThan(FACT_VOLATILE_MAX_TTL_SEC - 60);
    expect(ttlSeconds).toBeLessThanOrEqual(FACT_VOLATILE_MAX_TTL_SEC + 1);

    // The receipt, which is what makes the repair teaching rather than a silent surprise.
    expect(result.normalized?.ttlClampedFrom).toBe(WEEK_SEC);
    expect(result.normalized?.ttlClampedTo).toBe(FACT_VOLATILE_MAX_TTL_SEC);
    expect(result.normalized?.note).toBeTruthy();
  });

  /**
   * CALIBRATION — without this the block above stops measuring what it exists to measure.
   * A mutant that clamped EVERY ttlSec to 900 (not just volatile ones) would satisfy the
   * clamp test perfectly while silently truncating every ordinary long-lived fact in the
   * system. This case is what distinguishes "the volatile ceiling binds" from "the TTL
   * path is broken", and it must keep the full week.
   */
  it('CALIBRATION: an ordinary (non-volatile) fact with the same ttlSec keeps the full week', async () => {
    const result = await assertFact({ ...base, key: 'unclamped-control', ttlSec: WEEK_SEC }, db.sql);

    const ttlSeconds = await ttlSecondsOf('unclamped-control');
    expect(ttlSeconds).toBeGreaterThan(WEEK_SEC - 60);

    // No repair fired, so the receipt is ABSENT — never an empty object (the `evicted`
    // convention), which is what keeps `if (result.normalized)` a correct read.
    expect(result.normalized).toBeUndefined();
  });

  it('INFERS subjectVolatile from measuredAt and persists the marker as a real boolean', async () => {
    // measuredAt supplied, subjectVolatile omitted: you do not stamp a sample time for a
    // non-sample. Pre-P-006 this was a hard refusal that stored nothing.
    const result = await assertFact({ ttlSec: 3600, ...base, key: 'inferred', measuredAt }, db.sql);

    expect(result.normalized?.subjectVolatileInferred).toBe(true);

    // The stored marker must be a JSONB BOOLEAN, not the string "true": the volatile
    // fact-cap partition (EI-20365165629381535) keys off the boolean, so a string here
    // would let the row escape its bounded cap while still reading as volatile.
    const [row] = await db.sql<{ is_volatile: boolean }[]>`
      SELECT (measurement->'subjectVolatile' = 'true'::jsonb) AS is_volatile
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope_ref = ${scopeRef} AND key = 'inferred'
         AND superseded_at IS NULL`;
    expect(row.is_volatile).toBe(true);

    // Inference alone must also bound the lifetime — an inferred snapshot that kept an
    // unbounded TTL would be the original bug wearing the repair's clothes.
    const ttlSeconds = await ttlSecondsOf('inferred');
    expect(ttlSeconds).toBeLessThanOrEqual(FACT_VOLATILE_MAX_TTL_SEC + 1);
  });

  it('applies BOTH repairs in one call and reports both on the same receipt', async () => {
    const result = await assertFact(
      { ...base, key: 'both', measuredAt, ttlSec: WEEK_SEC },
      db.sql,
    );

    expect(result.normalized?.subjectVolatileInferred).toBe(true);
    expect(result.normalized?.ttlClampedFrom).toBe(WEEK_SEC);
    expect(await ttlSecondsOf('both')).toBeLessThanOrEqual(FACT_VOLATILE_MAX_TTL_SEC + 1);
  });
});

// EI-20365165629381535: volatile snapshots get their own bounded cap. The
// partition must be based on the JSONB BOOLEAN marker, not text extraction:
// legacy/malformed rows are ordinary facts and must not be allowed to either
// escape the ordinary cap or consume volatile capacity.
describe('volatile fact-cap partition (EI-20365165629381535)', () => {
  const scopeRef = 'volatile-cap-partition';
  const base = {
    scope: 'harness' as const,
    scopeRef,
    createdBy: 'su-int',
    workspaceId: WS,
  };

  it('keeps malformed markers ordinary, isolates caps, and keeps preview/write victims identical', async () => {
    const measuredAt = new Date(Date.now() - 1_000).toISOString();
    const validMeasurement = { subjectVolatile: true, measuredAt };

    // Leave three ordinary slots for malformed/legacy measurement shapes. The
    // string marker is the load-bearing case: `->>` would incorrectly classify
    // it as volatile, while `->` + JSONB equality must keep it ordinary.
    await db.sql`
      INSERT INTO harness_shared.agent_facts
        (workspace_id, scope, scope_ref, key, body, created_by, expires_at, confidence)
      SELECT ${WS}, 'harness', ${scopeRef}, 'ordinary-seed-' || i, 'ordinary', 'su-int',
             now() + interval '30 days', 'verified'
        FROM generate_series(0, ${CAP - 4}) AS seed(i)`;

    const malformed = [
      ['ordinary-marker-string', { subjectVolatile: 'true', measuredAt }],
      ['ordinary-marker-false', { subjectVolatile: false, measuredAt }],
      ['ordinary-marker-missing', { measuredAt }],
    ] as const;
    for (const [key, measurement] of malformed) {
      await db.sql`
        INSERT INTO harness_shared.agent_facts
          (workspace_id, scope, scope_ref, key, body, created_by, expires_at, confidence, measurement)
        VALUES (${WS}, 'harness', ${scopeRef}, ${key}, 'ordinary', 'su-int',
                now() + interval '30 days', 'verified', ${JSON.stringify(measurement)}::text::jsonb)`;
    }

    // Saturate the independent volatile cap. A single deliberately weak row
    // makes the victim deterministic and proves the sweep actually fires.
    await db.sql`
      INSERT INTO harness_shared.agent_facts
        (workspace_id, scope, scope_ref, key, body, created_by, expires_at, confidence, measurement)
      SELECT ${WS}, 'harness', ${scopeRef}, 'volatile-seed-' || i, 'volatile', 'su-int',
             now() + interval '15 minutes',
             CASE WHEN i = 0 THEN 'suspected' ELSE 'verified' END,
             ${JSON.stringify(validMeasurement)}::text::jsonb
        FROM generate_series(0, ${VOLATILE_CAP - 1}) AS seed(i)`;

    const ordinaryPreview = await previewFactCapImpact(
      { ...base, key: 'ordinary-arrival', body: 'ordinary', confidence: 'verified', ttlSec: 30 * 86400 },
      db.sql,
    );
    expect(ordinaryPreview.populationSize).toBe(CAP);
    expect(ordinaryPreview.cap).toBe(CAP);
    expect(ordinaryPreview.atCap).toBe(true);
    // P-002 / D-004 §1: the two partitions now run DIFFERENT mechanisms, which
    // is the sharpest available statement of their isolation. The saturated
    // ordinary side forecasts a REFUSAL and names no victim…
    expect(ordinaryPreview.wouldRefuse).toBe(true);
    expect(ordinaryPreview.wouldEvict).toEqual([]);
    expect(ordinaryPreview.survival).toBeNull();

    const volatilePreview = await previewFactCapImpact(
      {
        ...base,
        key: 'volatile-arrival',
        body: 'volatile',
        confidence: 'verified',
        subjectVolatile: true,
        measuredAt,
        ttlSec: FACT_VOLATILE_MAX_TTL_SEC,
      },
      db.sql,
    );
    // …while the equally-saturated volatile side still evicts, by ranking, and
    // names exactly who dies. Same scope, same saturation, opposite outcome.
    expect(volatilePreview.populationSize).toBe(VOLATILE_CAP);
    expect(volatilePreview.cap).toBe(VOLATILE_CAP);
    expect(volatilePreview.atCap).toBe(true);
    expect(volatilePreview.wouldRefuse).toBe(false);
    expect(volatilePreview.wouldEvict).toHaveLength(1);
    expect(volatilePreview.wouldEvict[0]?.key).toBe('volatile-seed-0');

    // The refused ordinary write costs the VOLATILE cohort nothing — the
    // isolation direction that matters most, since a ceiling that reached
    // across partitions would destroy snapshots to protect standing facts.
    await expect(
      assertFact(
        { ...base, key: 'ordinary-arrival', body: 'ordinary', confidence: 'verified', ttlSec: 30 * 86400 },
        db.sql,
      ),
    ).rejects.toThrow(/REFUSED before write/);
    const [{ volatileBefore }] = await db.sql<{ volatileBefore: number }[]>`
      SELECT count(*)::int AS "volatileBefore"
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'harness' AND scope_ref = ${scopeRef}
         AND source_hive IS NULL AND superseded_at IS NULL
         AND retracted_at IS NULL AND expires_at > now()
         AND measurement->'subjectVolatile' = 'true'::jsonb`;
    expect(volatileBefore).toBe(VOLATILE_CAP);

    const volatileWrite = await assertFact(
      {
        ...base,
        key: 'volatile-arrival',
        body: 'volatile',
        confidence: 'verified',
        subjectVolatile: true,
        measuredAt,
        ttlSec: FACT_VOLATILE_MAX_TTL_SEC,
      },
      db.sql,
    );
    expect(volatileWrite.evicted?.map((entry) => entry.key)).toEqual(
      volatilePreview.wouldEvict.map((entry) => entry.key),
    );

    const [{ volatileAfter }] = await db.sql<{ volatileAfter: number }[]>`
      SELECT count(*)::int AS "volatileAfter"
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'harness' AND scope_ref = ${scopeRef}
         AND source_hive IS NULL AND superseded_at IS NULL
         AND retracted_at IS NULL AND expires_at > now()
         AND measurement->'subjectVolatile' = 'true'::jsonb`;
    expect(volatileAfter).toBe(VOLATILE_CAP);

    // …and the volatile sweep took its victim from its OWN partition only: the
    // ordinary population is still exactly at its ceiling, undamaged. Stated at
    // the row level because the receipt is produced by the same statement that
    // would have done the damage, so a cross-partition over-evict has to be
    // caught against the table rather than against the receipt.
    expect(await partitionCensus('harness', scopeRef, 'ordinary')).toEqual({ live: CAP, evicted: 0 });

    // All three malformed/legacy rows remain live ordinary facts after both
    // writes. In particular, the string marker must not have been treated as a
    // volatile victim or hidden from the ordinary preview population.
    const [{ ordinaryMarkers }] = await db.sql<{ ordinaryMarkers: number }[]>`
      SELECT count(*)::int AS "ordinaryMarkers"
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'harness' AND scope_ref = ${scopeRef}
         AND key IN ('ordinary-marker-string', 'ordinary-marker-false', 'ordinary-marker-missing')
         AND source_hive IS NULL AND superseded_at IS NULL
         AND retracted_at IS NULL AND expires_at > now()`;
    expect(ordinaryMarkers).toBe(3);
  });
});

// ── owner-wall-ttl-lapse-hardening-2026-07-26 (EI-18669544162414270): the
// wall-lapse read leg against the REAL table ──
describe('listLapsedWallFacts', () => {
  const base = { scope: 'harness' as const, scopeRef: 'papercusp', createdBy: 'su-int', workspaceId: WS };

  /** Assert then backdate expires_at past `now` — assertFact only accepts a
   *  positive ttlSec, so a lapsed fixture is built in two steps like a real
   *  wall would arrive at lapse: asserted live, then its TTL elapses. */
  async function assertLapsed(key: string, body: string, daysAgo: number) {
    await assertFact({ ...base, key, body, ttlSec: 3600 }, db.sql);
    await db.sql`UPDATE harness_shared.agent_facts SET expires_at = now() - make_interval(days => ${daysAgo})
                  WHERE workspace_id = ${WS} AND key = ${key}`;
  }

  it('finds an unretracted wall: fact past its expiry, oldest-lapsed first', async () => {
    await assertLapsed('wall:newer-lapse', 'b1', 1);
    await assertLapsed('wall:older-lapse', 'b2', 5);
    const lapsed = await listLapsedWallFacts({}, db.sql);
    expect(lapsed.map((f) => f.key)).toEqual(['wall:older-lapse', 'wall:newer-lapse']);
    expect(lapsed[0]!.workspaceId).toBe(WS);
    expect(lapsed[0]!.createdBy).toBe('su-int');
  });

  it('excludes a non-wall-prefixed fact even when it too has lapsed', async () => {
    await assertLapsed('ordinary-lapsed', 'b', 1);
    const lapsed = await listLapsedWallFacts({}, db.sql);
    expect(lapsed.map((f) => f.key)).not.toContain('ordinary-lapsed');
  });

  it('excludes a wall fact that has NOT yet lapsed', async () => {
    await assertFact({ ...base, key: 'wall:still-live', body: 'b', ttlSec: 3600 }, db.sql);
    const lapsed = await listLapsedWallFacts({}, db.sql);
    expect(lapsed.map((f) => f.key)).not.toContain('wall:still-live');
  });

  it('excludes a lapsed wall fact that was explicitly retracted', async () => {
    await assertLapsed('wall:retracted', 'b', 1);
    await retractFact({ scope: 'harness', scopeRef: 'papercusp', key: 'wall:retracted', workspaceId: WS }, db.sql);
    const lapsed = await listLapsedWallFacts({}, db.sql);
    expect(lapsed.map((f) => f.key)).not.toContain('wall:retracted');
  });

  it('a re-assert clears a wall from the lapsed set (fresh TTL, retracted_at reset)', async () => {
    await assertLapsed('wall:renewed', 'stale body', 2);
    expect((await listLapsedWallFacts({}, db.sql)).map((f) => f.key)).toContain('wall:renewed');
    await assertFact({ ...base, key: 'wall:renewed', body: 'fresh body', ttlSec: 3600 }, db.sql);
    expect((await listLapsedWallFacts({}, db.sql)).map((f) => f.key)).not.toContain('wall:renewed');
  });

  it('keeps a lapsed wall folded and retained until explicit retraction', async () => {
    await assertLapsed('wall:retained-after-lapse', 'owner action is still required', 45);
    const selector = { scope: 'harness' as const, scopeRef: 'papercusp' };

    const folded = await foldFacts([selector], { workspaceId: WS, audiences: 'all' }, db.sql);
    expect(folded.map((fact) => fact.key)).toContain('wall:retained-after-lapse');
    await expect(countLiveFacts(selector, { workspaceId: WS, audiences: 'all' }, db.sql)).resolves.toBe(1);
    expect(renderFactsFold(folded, Date.now())).toContain('TTL lapsed — remains active until retracted');
    const resolved = await resolveAssumptions(['wall:retained-after-lapse'], [selector], { workspaceId: WS }, db.sql);
    expect(resolved[0]?.condition).toBe('live');

    // The ordinary 30-day reaper must not erase an unretracted wall's only
    // durable record just because the review deadline was missed.
    expect(await sweepExpiredFacts(db.sql)).toBe(0);
    expect(await factVersions({ ...base, key: 'wall:retained-after-lapse' }, db.sql)).toHaveLength(1);

    await retractFact({ scope: 'harness', scopeRef: 'papercusp', key: 'wall:retained-after-lapse', workspaceId: WS }, db.sql);
    const afterRetraction = await foldFacts([selector], { workspaceId: WS, audiences: 'all' }, db.sql);
    expect(afterRetraction.map((fact) => fact.key)).not.toContain('wall:retained-after-lapse');
    await db.sql`UPDATE harness_shared.agent_facts
                    SET retracted_at = now() - interval '31 days'
                  WHERE workspace_id = ${WS} AND key = 'wall:retained-after-lapse'`;
    expect(await sweepExpiredFacts(db.sql)).toBe(1);
    expect(await factVersions({ ...base, key: 'wall:retained-after-lapse' }, db.sql)).toHaveLength(0);
  });
});

/**
 * EI-18725816532600240 — the key-prefix narrowing, against real PG.
 *
 * `foldNeverDropFacts` is what lets coord:orient's monitor tick keep delivering the
 * override slots (dead-ends + walls + guard rails) on a context budget, and it rides a multi-prefix
 * `key LIKE ANY(...)` binding that NO test covered before this one. The property that
 * actually matters is the last case: the filter is applied IN SQL, BEFORE the
 * per-selector LIMIT, so a small never-drop set can never be crowded out by newer
 * ordinary facts — which is the whole reason the narrowed fold is safe to bound.
 */
describe('key-prefix narrowing (foldNeverDropFacts / foldDeadEndFacts)', () => {
  const base = { scope: 'harness' as const, scopeRef: 'papercusp', createdBy: 'su-int', workspaceId: WS };
  const SEL = [{ scope: 'harness' as const, scopeRef: 'papercusp' }];
  const fold = (o = {}) => foldFacts(SEL, { workspaceId: WS, ...o }, db.sql);

  async function seed() {
    await assertFact({ ...base, key: 'dead-end:tried-that', body: 'falsified', ttlSec: 3600 }, db.sql);
    await assertFact({ ...base, key: 'wall:needs-owner', body: 'still gated', ttlSec: 3600 }, db.sql);
    await assertFact({ ...base, key: 'guard-rail:do-not-refire', body: 'already fired', ttlSec: 3600 }, db.sql);
    await assertFact({ ...base, key: 'ordinary-conclusion', body: 'plain', ttlSec: 3600 }, db.sql);
  }

  it('folds BOTH never-drop slots in one query and excludes ordinary facts', async () => {
    await seed();
    const keys = (await foldNeverDropFacts(SEL, { workspaceId: WS }, db.sql)).map((f) => f.key).sort();
    expect(keys).toEqual(['dead-end:tried-that', 'guard-rail:do-not-refire', 'wall:needs-owner']);
  });

  it('the never-drop prefix set is exactly the three override slots', () => {
    expect([...NEVER_DROP_KEY_PREFIXES]).toEqual(['dead-end:', 'wall:', 'guard-rail:']);
    expect(NEVER_DROP_KEY_PREFIXES).toContain(GUARD_RAIL_KEY_PREFIX);
  });

  it('the single-prefix fold still narrows to dead-ends only', async () => {
    await seed();
    const keys = (await foldDeadEndFacts(SEL, { workspaceId: WS }, db.sql)).map((f) => f.key);
    expect(keys).toEqual(['dead-end:tried-that']);
  });

  it('no prefixes ⇒ no key filter (the unfiltered branch still selects everything)', async () => {
    await seed();
    expect((await fold()).length).toBe(4);
    expect((await fold({ keyPrefixes: [] })).length).toBe(4);
  });

  it('narrows BEFORE the per-selector LIMIT — newer ordinary facts cannot crowd out a dead-end', async () => {
    await assertFact({ ...base, key: 'dead-end:oldest', body: 'falsified', ttlSec: 3600 }, db.sql);
    // five ORDINARY facts, all newer than the dead-end (the fold is updated_at DESC)
    for (const n of [1, 2, 3, 4, 5]) {
      await assertFact({ ...base, key: `ordinary-${n}`, body: 'plain', ttlSec: 3600 }, db.sql);
    }
    // CONTROL: unfiltered, a limit of 2 sees only the newest ordinary rows — so this
    // fixture really does bury the dead-end, and the assertion below can fail.
    const unfiltered = (await fold({ limitPerSelector: 2 })).map((f) => f.key);
    expect(unfiltered).not.toContain('dead-end:oldest');
    // the narrowed fold spends its limit on the never-drop set alone
    const narrowed = (await foldNeverDropFacts(SEL, { workspaceId: WS, limitPerSelector: 2 }, db.sql)).map((f) => f.key);
    expect(narrowed).toEqual(['dead-end:oldest']);
  });
});

/**
 * P-018 — the conventions layer against real PG. The unit suite pins the D-016
 * RULES; this pins that they survive a round-trip through the mig-692 column and
 * that the cross-scope discovery read actually selects what it claims to.
 */
describe('P-018 conventions — enforcement round-trip + cross-scope discovery', () => {
  const conv = (over: Record<string, unknown> = {}) => ({
    scope: 'workspace' as const,
    key: 'migrations-via-runner',
    body: 'Apply migrations via db:migrate, never a raw psql -f.',
    kind: 'convention' as const,
    createdBy: 'su-int',
    workspaceId: WS,
    ...over,
  });

  it('persists an enforcement tier and reads it back typed', async () => {
    const f = await assertFact(
      conv({ enforcement: { tier: 'gate', floor: 0.6, reviewBy: '2026-09-01' } }),
      db.sql,
    );
    expect(f.enforcement).toEqual({ tier: 'gate', floor: 0.6, reviewBy: '2026-09-01' });
    const [read] = await listConventionFacts({ workspaceId: WS }, db.sql);
    expect(read.enforcement).toEqual({ tier: 'gate', floor: 0.6, reviewBy: '2026-09-01' });
    // The citable id carries the real version id, so it is checkable.
    expect(factCitationRef(read)).toMatch(/^fact:workspace:migrations-via-runner@v\d+$/);
  });

  it('a structural convention persists with no floor', async () => {
    const f = await assertFact(conv({ enforcement: { tier: 'structural' } }), db.sql);
    expect(f.enforcement).toEqual({ tier: 'structural' });
  });

  it('defaults an unbounded convention to infinity and keeps it out of observation-cap eviction', async () => {
    const permanent = await assertFact(conv(), db.sql);
    expect(permanent.expiresAt).toBe(FACT_PERMANENT_EXPIRY);
    expect(renderFactsFold([permanent])).toContain('(permanent');
    const [stored] = await db.sql<{ expires_at: string }[]>`
      SELECT expires_at::text
        FROM harness_shared.agent_facts
       WHERE workspace_id = ${WS} AND scope = 'workspace' AND key = 'migrations-via-runner'
         AND superseded_at IS NULL`;
    expect(stored.expires_at).toBe(FACT_PERMANENT_EXPIRY);

    const bounded = await assertFact(conv({ key: 'bounded-convention', ttlSec: 3600 }), db.sql);
    expect(bounded.expiresAt).not.toBe(FACT_PERMANENT_EXPIRY);

    // Saturate the ordinary population to EXACTLY its ceiling. Under D-003 the
    // ceiling refuses rather than evicts, so this used to over-fill by 5 and
    // relied on the conventions surviving the eviction. The property is now the
    // stronger one: conventions are outside the cap population entirely, so
    // they neither consume a seat nor are refused when every seat is taken.
    const ordinary = (i: number) => ({
      scope: 'workspace' as const,
      key: `ordinary-${i}`,
      body: `ordinary fact ${i}`,
      kind: 'conclusion' as const,
      createdBy: 'su-int',
      workspaceId: WS,
      ttlSec: 30 * 86400,
    });
    for (let i = 0; i < CAP; i++) await assertFact(ordinary(i), db.sql);

    // NON-VACUITY: the scope is genuinely full — an ordinary newcomer is
    // refused. Without this the assertions below hold in a roomy scope too, and
    // "kept out of the cap population" would be a claim about nothing.
    await expect(assertFact(ordinary(CAP), db.sql)).rejects.toThrow(/REFUSED before write/);

    // Two conventions already live here, so if they occupied cap seats the
    // ordinary population could never have reached CAP in the first place —
    // and a THIRD is still writable at a ceiling that just refused an ordinary
    // peer, which is the exemption stated in its most falsifiable form.
    await expect(
      assertFact(conv({ key: 'a-third-convention', body: 'still recordable at the ceiling' }), db.sql),
    ).resolves.toBeTruthy();

    expect((await listConventionFacts({ workspaceId: WS }, db.sql)).map((f) => f.key)).toEqual(
      expect.arrayContaining(['migrations-via-runner', 'bounded-convention', 'a-third-convention']),
    );
  });

  it('REFUSES a floorless gate at the STORE, not just the tool layer', async () => {
    await expect(assertFact(conv({ enforcement: { tier: 'gate' } }), db.sql)).rejects.toThrow(
      /requires floor and reviewBy/,
    );
    // …and nothing was written — a refused write must not leave a partial row.
    expect(await listConventionFacts({ workspaceId: WS }, db.sql)).toHaveLength(0);
  });

  it('REFUSES an enforcement tier on a non-convention', async () => {
    await expect(
      assertFact(conv({ kind: 'conclusion', ttlSec: 3600, enforcement: { tier: 'structural' } }), db.sql),
    ).rejects.toThrow(/only meaningful on kind:'convention'/);
  });

  it('the mig-692 CHECK rejects an out-of-vocabulary tier written OUT OF BAND', async () => {
    // The TypeScript validator is bypassable (a raw INSERT); the DB constraint is
    // the backstop that keeps the vocabulary closed either way.
    await expect(
      db.sql.unsafe(`
        INSERT INTO harness_shared.agent_facts
          (workspace_id, scope, scope_ref, key, body, created_by, expires_at, kind, enforcement)
        VALUES ('${WS}', 'workspace', NULL, 'smuggled', 'b', 'su-int', now() + interval '1 day',
                'convention', '{"tier":"prompt"}'::jsonb)`),
    ).rejects.toThrow(/agent_facts_enforcement_tier_check/);
  });

  it('discovery is CROSS-SCOPE — the caller need not know which scope it was filed under', async () => {
    await assertFact(conv({ key: 'ws-rule' }), db.sql);
    await assertFact(conv({ key: 'harness-rule', scope: 'harness', scopeRef: 'papercusp' }), db.sql);
    await assertFact(conv({ key: 'owner-rule', scope: 'owner', scopeRef: 'su-me' }), db.sql);
    const keys = (await listConventionFacts({ workspaceId: WS }, db.sql)).map((f) => f.key);
    expect(keys.sort()).toEqual(['harness-rule', 'owner-rule', 'ws-rule']);
  });

  it('scopeRefs narrows to the refs that govern YOU — but never hides a workspace rule', async () => {
    await assertFact(conv({ key: 'ws-rule' }), db.sql);
    await assertFact(conv({ key: 'mine', scope: 'owner', scopeRef: 'su-me' }), db.sql);
    await assertFact(conv({ key: 'theirs', scope: 'owner', scopeRef: 'su-someone-else' }), db.sql);
    const keys = (
      await listConventionFacts({ workspaceId: WS, scopeRefs: ['su-me'] }, db.sql)
    ).map((f) => f.key);
    expect(keys.sort()).toEqual(['mine', 'ws-rule']);
  });

  it('excludes non-conventions, retracted, and superseded versions', async () => {
    await assertFact(conv({ key: 'a-conclusion', kind: 'conclusion', ttlSec: 3600 }), db.sql);
    await assertFact(conv({ key: 'no-kind', kind: null, ttlSec: 3600 }), db.sql);
    await assertFact(conv({ key: 'gone' }), db.sql);
    await retractFact({ scope: 'workspace', key: 'gone', workspaceId: WS }, db.sql);
    // A corrected convention returns ONCE — the current version, not both.
    await assertFact(conv({ key: 'revised', body: 'v1' }), db.sql);
    await assertFact(conv({ key: 'revised', body: 'v2' }), db.sql);
    const out = await listConventionFacts({ workspaceId: WS }, db.sql);
    expect(out.map((f) => f.key)).toEqual(['revised']);
    expect(out[0].body).toBe('v2');
  });
});

/**
 * P-008 (d) / D-050 / D-079 — assumption key RESOLUTION.
 *
 * These run against real PG because the whole question is what the LEDGER says,
 * and the distinction the gate turns on (lapsed vs never-existed) is invisible to
 * `foldFacts`, which filters expired/retracted/superseded rows out entirely. A
 * mocked read could not tell the two apart, which is the bug being prevented.
 */
describe('P-008 (d) assumption resolution (D-079)', () => {
  const base = {
    scope: 'owner' as const,
    scopeRef: 'su-me',
    body: 'the gate red is a flake',
    createdBy: 'su-int',
    workspaceId: WS,
  };
  const selectors = assumptionSelectorsFor({ workItemId: 'WI-1', ownerId: 'su-me', harnessSlug: 'papercusp' });
  const resolve = (declared: string[]) => resolveAssumptions(declared, selectors, { workspaceId: WS }, db.sql);

  it('resolves a live bare key and STAMPS the absolute versioned ref', async () => {
    const f = await assertFact({ ttlSec: 3600, ...base, key: 'gate-flake' }, db.sql);
    const [r] = await resolve(['gate-flake']);
    expect(r.condition).toBe('live');
    expect(r.ref).toBe(`fact:owner:su-me:gate-flake@v${f.id}`);
    expect(r.versionId).toBe(f.id);
    // The excerpt is what makes the record survive the 30d expiry sweep.
    expect(r.excerpt).toBe('the gate red is a flake');
  });

  it('an EXPIRED key resolves as lapsed — NOT dangling (the D-050 question)', async () => {
    await assertFact({ ttlSec: 3600, ...base, key: 'stale-hunch' }, db.sql);
    await db.sql`UPDATE harness_shared.agent_facts SET expires_at = now() - interval '1 hour'
                  WHERE workspace_id = ${WS} AND key = 'stale-hunch'`;
    const [r] = await resolve(['stale-hunch']);
    expect(r.condition).toBe('lapsed');
    expect(r.ref).toContain('stale-hunch');
    expect(r.excerpt).toBeTruthy();
  });

  it('a RETRACTED key resolves as retracted, not dangling', async () => {
    await assertFact({ ttlSec: 3600, ...base, key: 'withdrawn' }, db.sql);
    await retractFact({ scope: 'owner', scopeRef: 'su-me', key: 'withdrawn', workspaceId: WS }, db.sql);
    const [r] = await resolve(['withdrawn']);
    expect(r.condition).toBe('retracted');
  });

  it('a key that NEVER existed is the one thing that dangles', async () => {
    const [r] = await resolve(['never-asserted-anywhere']);
    expect(r.condition).toBe('dangling');
    expect(r.ref).toBeNull();
  });

  it('a bare key resolves to the CURRENT version after a correction', async () => {
    await assertFact({ ttlSec: 3600, ...base, key: 'revised', body: 'v1' }, db.sql);
    const v2 = await assertFact({ ttlSec: 3600, ...base, key: 'revised', body: 'v2' }, db.sql);
    const [r] = await resolve(['revised']);
    expect(r.condition).toBe('live');
    expect(r.versionId).toBe(v2.id);
    expect(r.excerpt).toBe('v2');
  });

  it('a version-pinned ref whose version was superseded reports superseded, pointing at the current one', async () => {
    const v1 = await assertFact({ ttlSec: 3600, ...base, key: 'pinned', body: 'first' }, db.sql);
    const v2 = await assertFact({ ttlSec: 3600, ...base, key: 'pinned', body: 'second' }, db.sql);
    const [r] = await resolve([`fact:owner:su-me:pinned@v${v1.id}`]);
    expect(r.condition).toBe('superseded');
    expect(r.versionId).toBe(v2.id);
    expect(r.excerpt).toBe('second');
  });

  it('most-specific scope wins, and the multi-scope hit is flagged ambiguous', async () => {
    await assertFact(
      { ttlSec: 3600, scope: 'workspace', key: 'shared-slug', body: 'workspace-wide', createdBy: 'su-int', workspaceId: WS },
      db.sql,
    );
    await assertFact({ ttlSec: 3600, ...base, key: 'shared-slug', body: 'mine' }, db.sql);
    const [r] = await resolve(['shared-slug']);
    expect(r.scope).toBe('owner');
    expect(r.excerpt).toBe('mine');
    expect(r.ambiguous).toBe(true);
  });

  it('a single-scope hit is NOT flagged ambiguous', async () => {
    await assertFact({ ttlSec: 3600, ...base, key: 'only-mine' }, db.sql);
    const [r] = await resolve(['only-mine']);
    expect(r.ambiguous).toBeUndefined();
  });

  /**
   * The reason absolute refs exist: a role-scoped fact cannot be reached by a
   * bare key (AgentIdentity carries no role), so it must stay citable explicitly.
   */
  it('an absolute ref resolves a scope OUTSIDE the caller selector set', async () => {
    await assertFact(
      { ttlSec: 3600,
        scope: 'role',
        scopeRef: 'engineer',
        key: 'role-rule',
        body: 'engineers do X',
        createdBy: 'su-int',
        workspaceId: WS,
      },
      db.sql,
    );
    expect((await resolve(['role-rule']))[0].condition).toBe('dangling');
    const [r] = await resolve(['fact:role:engineer:role-rule']);
    expect(r.condition).toBe('live');
    expect(r.scope).toBe('role');
    expect(r.excerpt).toBe('engineers do X');
  });

  it('a foreign hive partition is not the fact you asserted', async () => {
    await assertFact({ ttlSec: 3600, ...base, key: 'local-only' }, db.sql);
    await db.sql`UPDATE harness_shared.agent_facts SET source_hive = 'other-hive'
                  WHERE workspace_id = ${WS} AND key = 'local-only'`;
    expect((await resolve(['local-only']))[0].condition).toBe('dangling');
  });

  it('resolves a whole batch in ONE read, preserving caller order', async () => {
    await assertFact({ ttlSec: 3600, ...base, key: 'k-a' }, db.sql);
    await assertFact({ ttlSec: 3600, ...base, key: 'k-b' }, db.sql);
    const out = await resolve(['k-b', 'ghost', 'k-a']);
    expect(out.map((r) => r.key)).toEqual(['k-b', 'ghost', 'k-a']);
    expect(out.map((r) => r.condition)).toEqual(['live', 'dangling', 'live']);
  });
});

// ⚠ The `P-011 — assumptions in tension (real PG)` suite that stood here was
// REMOVED by WI-6545 / D-103 together with the detector it exercised. It is worth
// recording WHY a green, well-built suite was deleted rather than kept: it seeded
// its own contradictions. Every case constructed two assumptions itself and then
// proved the detector paired them — so it passed identically whether the fleet
// wrote assumptions or not, and it did so for the detector's entire life while the
// real corpus held 0 of 2,217. That is precisely the gap this plan was chartered to
// find: unit-green, production-unreachable. Do not restore these tests without a
// producer; they measure the fixture, not the plane.

/**
 * P-006 / D-001 — the PRODUCER contract the replacement dispute detector rests on.
 *
 * Read the note directly above first: the deleted suite failed because it seeded its own
 * contradictions and then proved the detector paired them, so it passed identically whether
 * the fleet produced any input or not. This suite deliberately does the opposite — it asserts
 * nothing about pairing or messaging (that is `facts/contested-key.test.ts`, pure and
 * fixture-driven by design). It pins only the three STORE behaviours the detector consumes,
 * each of which is produced by the ordinary `facts:assert` write path with no opt-in:
 *
 *   1. a re-assert stamps `supersedesId` (a first assert does not) — the gate that keeps the
 *      detector free on ~90% of writes, and, if it broke, would silently disable it entirely;
 *   2. `factVersions` returns the chain CURRENT-FIRST — the assessor reads chain[0] as "the
 *      version this write replaced", so a reversed order would misreport a settled key;
 *   3. the chain carries `createdBy`, `kind` and `settledBy` — the only three fields it reads.
 *
 * Every one of these is a real property of the plane. If any regresses, the detector goes
 * quiet rather than wrong, which is the failure mode that took two years to notice last time.
 */
describe('P-006 / D-001 — the version-chain producer the dispute detector consumes', () => {
  const base = { scope: 'owner' as const, scopeRef: 'su-me', createdBy: 'su-alice', workspaceId: WS };

  it('stamps supersedesId on a RE-assert and leaves it null on the first', async () => {
    const v1 = await assertFact({ ttlSec: 3600, ...base, key: 'gate-candidate', body: 'judging 1ee32228' }, db.sql);
    expect(v1.supersedesId ?? null).toBeNull();

    const v2 = await assertFact(
      { ttlSec: 3600, ...base, createdBy: 'su-bob', key: 'gate-candidate', body: 'judging 4a9b218b' },
      db.sql,
    );
    expect(v2.supersedesId).toBe(v1.id);
  });

  it('returns the chain CURRENT-FIRST, carrying createdBy / kind / settledBy', async () => {
    await assertFact({ ttlSec: 3600, ...base, key: 'k', body: 'answer A' }, db.sql);
    await assertFact({ ttlSec: 3600, ...base, createdBy: 'su-bob', key: 'k', body: 'answer B' }, db.sql);
    await assertFact(
      {
        ttlSec: 3600,
        ...base,
        createdBy: 'su-carol',
        key: 'k',
        body: 'not determinable from these fields',
        kind: 'undecidable',
        settledBy: 'the inFlightRetriage marker in harness_shared.routines',
      },
      db.sql,
    );

    const chain = await factVersions({ scope: 'owner', scopeRef: 'su-me', key: 'k', workspaceId: WS }, db.sql);
    expect(chain).toHaveLength(3);
    // chain[0] is the LIVE version — the one a fourth assert would replace.
    expect(chain[0]).toMatchObject({
      createdBy: 'su-carol',
      kind: 'undecidable',
      settledBy: 'the inFlightRetriage marker in harness_shared.routines',
    });
    expect(chain.map((c) => c.createdBy)).toEqual(['su-carol', 'su-bob', 'su-alice']);
    // Three DISTINCT authors on one key is the shape D-001 measured at ~1 occurrence per 14
    // days — rare, which is exactly why the detector must not also require them to be
    // simultaneous, and why the threshold sits at 2 rather than the drafted 3.
    expect(new Set(chain.map((c) => c.createdBy)).size).toBe(3);
  });

  it('a settled undecidable is reachable from the chain even after a later answer overwrites it', async () => {
    // The assessor deliberately only treats chain[0] as the settlement, but the earlier
    // undecidable must still be READABLE — that history is what makes a later "wait, this was
    // already declared unknowable" recoverable at all.
    await assertFact(
      { ttlSec: 3600, ...base, key: 'buried', body: 'cannot tell', kind: 'undecidable', settledBy: 'a primary read' },
      db.sql,
    );
    await assertFact({ ttlSec: 3600, ...base, createdBy: 'su-bob', key: 'buried', body: 'it is X' }, db.sql);

    const chain = await factVersions({ scope: 'owner', scopeRef: 'su-me', key: 'buried', workspaceId: WS }, db.sql);
    expect(chain[0]!.kind).not.toBe('undecidable');
    expect(chain[1]).toMatchObject({ kind: 'undecidable', settledBy: 'a primary read' });
  });
});

// WI-38910 — `facts:list` returned `count: <page size>` and nothing else, so a
// scope holding hundreds of live facts read as "4 facts stand". That is not a
// cosmetic label: agents are instructed to read standing facts BEFORE asserting,
// and a dedup check that sees 4 of N cannot find the key it is looking for. The
// duplicate assert that follows then EVICTS a peer's still-valid fact, because
// the busy scopes sit permanently at CAP.
//
// These pin the property that makes a reported `total` worth trusting: it counts
// EXACTLY the rows the page draws from, and the page limit does not bound it.
describe('countLiveFacts is the census behind a listFacts page (WI-38910)', () => {
  const base = {
    workspaceId: WS,
    scope: 'workspace' as const,
    scopeRef: null,
    createdBy: 'su-me',
  };
  const sel = { scope: 'workspace' as const, scopeRef: null };

  async function seat(n: number, prefix = 'census') {
    for (let i = 0; i < n; i += 1) {
      await assertFact({ ttlSec: 3600, ...base, key: `${prefix}-${i}`, body: `fact ${i}` }, db.sql);
    }
  }

  it('counts every live fact while the page stays capped — the page size must NOT bound the census', async () => {
    await seat(7);

    const page = await listFacts(sel, { workspaceId: WS, limit: 3 }, db.sql);
    const total = await countLiveFacts(sel, { workspaceId: WS, audiences: 'all' }, db.sql);

    expect(page).toHaveLength(3);
    expect(total).toBe(7);
    // The defect in one line: reading the page length as the population. If a
    // future change ever caps the census at the page limit, this is what fails.
    expect(total).toBeGreaterThan(page.length);
  });

  it('agrees exactly with the unbounded fold — a census over a DIFFERENT population is a new lie, not a fix', async () => {
    await seat(5);
    // Excluded rows are the whole point: same table is not the same population.
    // A retracted fact must be invisible to BOTH, or `total` overstates what the
    // reader could actually page to — untrustworthy in the other direction.
    await assertFact({ ttlSec: 3600, ...base, key: 'retracted-one', body: 'retract me' }, db.sql);
    await retractFact({ scope: 'workspace', scopeRef: null, key: 'retracted-one', workspaceId: WS }, db.sql);

    const all = await foldFacts([sel], { workspaceId: WS, limitPerSelector: 1000, audiences: 'all' }, db.sql);
    const total = await countLiveFacts(sel, { workspaceId: WS, audiences: 'all' }, db.sql);

    expect(total).toBe(all.length);
    expect(total).toBe(5);
    expect(all.map((f) => f.key)).not.toContain('retracted-one');
  });

  it('an EXPIRED fact is excluded by both, so the census cannot drift from the fold as TTLs lapse', async () => {
    await seat(2);
    await assertFact({ ttlSec: 3600, ...base, key: 'already-lapsed', body: 'short ttl' }, db.sql);
    await db.sql.unsafe(
      `UPDATE harness_shared.agent_facts SET expires_at = now() - interval '1 hour' WHERE key = 'already-lapsed'`,
    );

    const all = await foldFacts([sel], { workspaceId: WS, limitPerSelector: 1000, audiences: 'all' }, db.sql);
    const total = await countLiveFacts(sel, { workspaceId: WS, audiences: 'all' }, db.sql);

    expect(total).toBe(all.length);
    expect(total).toBe(2);
  });

  it('an unset optional scope dimension censuses 0 — matching the fold, which folds nothing', async () => {
    await seat(3);
    // foldFacts skips a non-workspace selector with a blank ref rather than
    // returning every ref in the scope; the census must make the same choice or
    // it reports a population the caller can never page to.
    const folded = await foldFacts([{ scope: 'harness', scopeRef: '' }], { workspaceId: WS, audiences: 'all' }, db.sql);
    const total = await countLiveFacts({ scope: 'harness', scopeRef: '' }, { workspaceId: WS, audiences: 'all' }, db.sql);

    expect(folded).toHaveLength(0);
    expect(total).toBe(0);
  });
});

describe('P-003 retraction cascade hooks (real PG)', () => {
  const base = { scope: 'owner' as const, scopeRef: 'su-cascade', key: 'cascade-premise', createdBy: 'su-int', workspaceId: WS };
  const ids = async () =>
    (
      await db.sql<{ id: string }[]>`
        SELECT id::text FROM harness_shared.agent_facts
         WHERE workspace_id = ${WS} AND scope = 'owner' AND scope_ref = 'su-cascade' AND key = 'cascade-premise'
`
    )
      // Numeric sort in JS: ORDER BY on the `id::text` alias would sort '1000' before '999'.
      .map((r) => Number(r.id))
      .sort((a, b) => a - b);

  it('retractFact cascades with the retracted version id, reason and retractor', async () => {
    cascadeCalls.length = 0;
    await assertFact({ ttlSec: 3600, ...base, body: 'premise v1' }, db.sql);
    const [v1] = await ids();
    await retractFact({ ...base, reason: 'premise disproved', retractedBy: 'su-retractor' }, db.sql);
    expect(cascadeCalls).toEqual([
      expect.objectContaining({
        kind: 'retracted',
        workspaceId: WS,
        scope: 'owner',
        scopeRef: 'su-cascade',
        key: 'cascade-premise',
        versionId: v1,
        reason: 'premise disproved',
        by: 'su-retractor',
      }),
    ]);
  });

  it('a re-assert that replaces a version cascades a supersession naming old and new ids', async () => {
    await assertFact({ ttlSec: 3600, ...base, body: 'premise v2' }, db.sql);
    cascadeCalls.length = 0;
    await assertFact({ ttlSec: 3600, ...base, body: 'premise v3' }, db.sql);
    const all = await ids();
    const [oldId, newId] = all.slice(-2);
    expect(cascadeCalls).toEqual([
      expect.objectContaining({ kind: 'superseded', key: 'cascade-premise', versionId: oldId, supersededBy: newId }),
    ]);
  });

  it('a first assert (nothing superseded) cascades nothing', async () => {
    cascadeCalls.length = 0;
    await assertFact({ ttlSec: 3600, ...base, key: 'cascade-fresh', body: 'new' }, db.sql);
    expect(cascadeCalls).toEqual([]);
  });
});

describe('code-intel-epoch-carry P-005 code notes (R-9 / R-10) against real SQL', () => {
  const ref = 'code-note-harness';
  const anchor = (path: string): FactDependency => ({
    cell: `file:${path}`,
    observedAt: '2026-10-20T00:00:00.000Z',
    digest: 'sha256:0123456789abcdef',
    observed: 'sha256:0123456789abcdef',
  });
  const base = { scope: 'harness' as const, scopeRef: ref, createdBy: 'su-int', workspaceId: WS, ttlSec: 3600 };

  // The suite's top-level afterEach TRUNCATEs agent_facts, so seed per test.
  beforeEach(async () => {
    await assertFact({ ...base, key: 'code-note:retry-loop', body: 'the retry loop is deliberate', dependsOn: [anchor('lib/a.ts')] }, db.sql);
    await assertFact({ ...base, key: 'code-note:two-files', body: 'b and c share a lock order', dependsOn: [anchor('lib/b.ts'), anchor('lib/c.ts')] }, db.sql);
    await assertFact({ ...base, key: 'ordinary-conclusion', body: 'tests need Docker' }, db.sql);
  });

  it('R-9: the general fold and its census omit code notes', async () => {
    const { facts, census } = await foldFactsWithCensus([{ scope: 'harness', scopeRef: ref }], { workspaceId: WS }, db.sql);
    expect(facts.map((f) => f.key)).toEqual(['ordinary-conclusion']);
    expect(census[0]).toMatchObject({ shown: 1, total: 1 });
    expect(await countLiveFacts({ scope: 'harness', scopeRef: ref }, { workspaceId: WS }, db.sql)).toBe(1);
  });

  it('R-9: an explicit read (facts:list) and a code-note prefix both see them', async () => {
    const listed = await listFacts({ scope: 'harness', scopeRef: ref }, { workspaceId: WS, includeCodeNotes: true }, db.sql);
    expect(listed.map((f) => f.key).sort()).toEqual(['code-note:retry-loop', 'code-note:two-files', 'ordinary-conclusion']);
    expect(await countLiveFacts({ scope: 'harness', scopeRef: ref }, { workspaceId: WS, includeCodeNotes: true }, db.sql)).toBe(3);
    const prefixed = await foldFacts([{ scope: 'harness', scopeRef: ref }], { workspaceId: WS, keyPrefixes: ['code-note:'] }, db.sql);
    expect(prefixed.map((f) => f.key).sort()).toEqual(['code-note:retry-loop', 'code-note:two-files']);
    // A prefix that merely CONTAINS the namespace is not an opt-in.
    const broad = await foldFacts([{ scope: 'harness', scopeRef: ref }], { workspaceId: WS, keyPrefixes: ['code-'] }, db.sql);
    expect(broad).toEqual([]);
  });

  it('foldCodeNotesForPaths returns only notes anchored to a requested file (jsonb filter in SQL)', async () => {
    const sel = [{ scope: 'harness' as const, scopeRef: ref }];
    expect((await foldCodeNotesForPaths(sel, ['lib/a.ts'], { workspaceId: WS }, db.sql)).map((f) => f.key)).toEqual(['code-note:retry-loop']);
    expect((await foldCodeNotesForPaths(sel, ['lib/c.ts'], { workspaceId: WS }, db.sql)).map((f) => f.key)).toEqual(['code-note:two-files']);
    expect(await foldCodeNotesForPaths(sel, ['lib/unrelated.ts'], { workspaceId: WS }, db.sql)).toEqual([]);
    expect(await foldCodeNotesForPaths(sel, [], { workspaceId: WS }, db.sql)).toEqual([]);
  });

  it('R-10: the store refuses a code note with no resolved file anchor', async () => {
    await expect(assertFact({ ...base, key: 'code-note:unanchored', body: 'no anchor' }, db.sql)).rejects.toThrow(/file anchor/);
    await expect(
      assertFact({ ...base, key: 'code-note:unresolved', body: 'anchor never resolved',
        dependsOn: [{ cell: 'file:lib/missing.ts', observedAt: '2026-10-20T00:00:00.000Z', unknown: 'absent' }] }, db.sql),
    ).rejects.toThrow(/file anchor/);
    const stored = await listFacts({ scope: 'harness', scopeRef: ref }, { workspaceId: WS, includeCodeNotes: true }, db.sql);
    expect(stored.map((f) => f.key)).not.toContain('code-note:unanchored');
    expect(stored.map((f) => f.key)).not.toContain('code-note:unresolved');
  });
});
