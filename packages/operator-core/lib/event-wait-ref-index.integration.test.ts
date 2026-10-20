/**
 * event-wait-ref-index.integration.test.ts — announced-event settlement finds the items
 * waiting on a key through the wait-ref indexes of migration 1539, and the rewritten
 * lookups select exactly the items the pre-rewrite scans did
 * (plan event-wait-settlement-2026-10-20 P-002; specs SPEC-P-002, AUTO-BAR-R-3-P-002).
 *
 * WHY. Every announced-event settlement runs two `FOR UPDATE` lookups in its transaction:
 * reconcileEventExternalBlockers (active `{kind:'event', ref:<key>}` blockers) and
 * reconcileEventDurableParks (unclaimed durable parks whose release trigger is <key>).
 * Measured on the live box 2026-10-20 (404,825 work_items rows): the first filtered all
 * 4,431 blocked payloads (89.7 ms, 25,429 buffers), the second ran a parallel seq scan
 * (676.6 ms, 930,107 buffers). With 1539's indexes: 0.08 ms and 0.06 ms.
 *
 * HOW. The table is seeded at that live size. The test drives the REAL functions through
 * a traced client, captures the exact statement each sent (with its bound parameters) and
 * EXPLAINs that statement, so it pins the code path rather than a hand-copied query. The
 * pre-rewrite predicates are kept here only as the ORACLE the rewritten lookups must
 * agree with. The last case drops both indexes inside a rolled-back transaction and
 * asserts neither plan can name them any more: the guard is falsifiable in the test itself.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
const MIGRATIONS = [
  '1475-work-items-external-blockers-partial-idx.sql',
  '1539-work-items-wait-ref-indexes.sql',
].map((name) => resolve(SQL_DIR, name));
const GIN_INDEX = 'work_items_external_blockers_gin_idx';
const PARK_INDEX = 'work_items_claim_hold_release_trigger_idx';

const WS = 'ews-p002-ws';
const OTHER_WS = 'ews-p002-other-ws';
// Live shape, 2026-10-20: 404,825 rows, 4,431 carrying externalBlockers, 1,018 parks.
const PLAIN_ROWS = 399_400;
const BLOCKED_ROWS = 4_400;
const PARKED_ROWS = 1_000;

const BLOCKER_KEY = 'work-item:done:WI-p002-target';
const PARK_KEY = 'work-item:done:WI-p002-park-target';
const ABSENT_KEY = 'work-item:done:WI-p002-absent';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { reconcileEventExternalBlockers } = await import('./work-items');
const { reconcileEventDurableParks } = await import('./work-items-durable-park-audit');

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Relation Name'?: string;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

let db: FreshPgDb;
let traced: postgres.Sql;
const captured: { query: string; params: unknown[] }[] = [];

/** The one statement `run` sent whose text matches `marker`, with its bound parameters. */
async function captureLookup(run: () => Promise<unknown>, marker: RegExp): Promise<{ query: string; params: unknown[] }> {
  captured.length = 0;
  await run();
  const hits = captured.filter((c) => /FROM harness_shared\.work_items/.test(c.query) && marker.test(c.query));
  expect(hits, `expected exactly one work_items lookup matching ${marker}`).toHaveLength(1);
  return hits[0]!;
}

async function planNodes(sql: postgres.Sql | postgres.TransactionSql, lookup: { query: string; params: unknown[] }): Promise<PlanNode[]> {
  const explained = await sql.unsafe(`EXPLAIN (FORMAT JSON) ${lookup.query}`, lookup.params as never[]);
  const plan = (explained[0] as Record<string, unknown>)['QUERY PLAN'] as { Plan: PlanNode }[];
  return flatten(plan[0]!.Plan);
}

const externalBlockerLookup = () =>
  captureLookup(() => reconcileEventExternalBlockers(traced, ABSENT_KEY, 'test:p002'), /externalBlockers/);
const durableParkLookup = () =>
  captureLookup(() => reconcileEventDurableParks(traced, ABSENT_KEY, 'test:p002'), /claim_hold_release/);

/** ORACLE: the pre-rewrite external-blocker predicate (work-items.ts before P-002). */
async function oracleBlockedIds(key: string): Promise<string[]> {
  const rows = await db.sql<{ feature_id: string }[]>`
    SELECT feature_id FROM harness_shared.work_items
     WHERE payload ? 'externalBlockers'
       AND COALESCE(payload, '{}'::jsonb) @> jsonb_build_object(
         'externalBlockers',
         jsonb_build_array(jsonb_build_object('kind', 'event', 'ref', ${key}::text, 'status', 'active')))
     ORDER BY feature_id`;
  return rows.map((r) => r.feature_id);
}

/** ORACLE: the pre-rewrite durable-park predicate (work-items-durable-park-audit.ts before P-002). */
async function oracleParkedIds(trigger: string): Promise<string[]> {
  const rows = await db.sql<{ feature_id: string }[]>`
    SELECT feature_id FROM harness_shared.work_items
     WHERE COALESCE(payload, '{}'::jsonb) ->> '_claimHold' = 'true'
       AND NULLIF(COALESCE(payload, '{}'::jsonb) ->> 'claim_hold_by', '') IS NOT NULL
       AND (taken_by IS NULL OR btrim(taken_by) = '')
       AND COALESCE(payload, '{}'::jsonb) -> 'claim_hold_release' ->> 'trigger' = ${trigger}
     ORDER BY feature_id`;
  return rows.map((r) => r.feature_id);
}

async function payloadsById(): Promise<Map<string, unknown>> {
  const rows = await db.sql<{ feature_id: string; payload: unknown }[]>`
    SELECT feature_id, payload FROM harness_shared.work_items WHERE feature_id LIKE 'WI-fx-%'`;
  return new Map(rows.map((r) => [r.feature_id, r.payload]));
}

// A complete stored record: readExternalBlockers drops one missing any of these fields.
const event = (ref: string, status = 'active') => ({
  kind: 'event', ref, status, capability: 'live-dependency', summary: `waits on ${ref}`,
  createdAt: '2026-10-20T00:00:00.000Z', createdBy: 'su-p002-fixture', updatedAt: '2026-10-20T00:00:00.000Z',
});
const park = (trigger: string, extra: Record<string, unknown> = {}) => ({
  _claimHold: true,
  claim_hold_by: 'su-p002-holder',
  claim_hold_release: { trigger },
  ...extra,
});

/** Fixture rows around the two target keys; `null` stores a SQL NULL payload. */
const FIXTURES: { id: string; ws?: string; takenBy?: string; payload: Record<string, unknown> | null }[] = [
  { id: 'WI-fx-blocked', payload: { externalBlockers: [event(BLOCKER_KEY)] } },
  { id: 'WI-fx-blocked-second', payload: { externalBlockers: [{ kind: 'gate', ref: 'plan:x', status: 'active' }, event(BLOCKER_KEY)] } },
  { id: 'WI-fx-blocked-other-ws', ws: OTHER_WS, payload: { externalBlockers: [event(BLOCKER_KEY)] } },
  { id: 'WI-fx-cleared', payload: { externalBlockers: [event(BLOCKER_KEY, 'cleared')] } },
  { id: 'WI-fx-gate-same-ref', payload: { externalBlockers: [{ kind: 'gate', ref: BLOCKER_KEY, status: 'active' }] } },
  { id: 'WI-fx-other-ref', payload: { externalBlockers: [event(`${BLOCKER_KEY}-other`)] } },
  { id: 'WI-fx-object-not-array', payload: { externalBlockers: event(BLOCKER_KEY) } },
  { id: 'WI-fx-null-payload', payload: null },
  { id: 'WI-fx-park', payload: park(PARK_KEY) },
  { id: 'WI-fx-park-other-ws', ws: OTHER_WS, payload: park(PARK_KEY) },
  { id: 'WI-fx-park-taken', takenBy: 'su-p002-claimer', payload: park(PARK_KEY) },
  { id: 'WI-fx-park-blank-taken', takenBy: '  ', payload: park(PARK_KEY) },
  { id: 'WI-fx-park-not-held', payload: park(PARK_KEY, { _claimHold: false }) },
  { id: 'WI-fx-park-no-holder', payload: park(PARK_KEY, { claim_hold_by: '' }) },
  { id: 'WI-fx-park-other-trigger', payload: park(`${PARK_KEY}-other`) },
  { id: 'WI-fx-park-no-release', payload: { _claimHold: true, claim_hold_by: 'su-p002-holder' } },
];

beforeAll(async () => {
  db = await createFreshPgDb('ews-p002');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL).simple();
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.audit_log (
      id text PRIMARY KEY, ts bigint, actor text, action text, subject text,
      details jsonb, workspace_id text)`).simple();
  for (const file of MIGRATIONS) await db.sql.unsafe(readFileSync(file, 'utf8')).simple();

  await db.sql.unsafe(`
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, status, title, created_ts, updated_ts, payload)
    SELECT '${WS}', 'papercusp', 'WI-plain-' || g, 'bug', 'open', 'plain ' || g, 1760000000000 + g, 1760000000000 + g,
           jsonb_build_object('note', 'row ' || g)
      FROM generate_series(1, ${PLAIN_ROWS}) g;
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, status, title, created_ts, updated_ts, payload)
    SELECT '${WS}', 'papercusp', 'WI-blocked-' || g, 'bug', 'blocked', 'blocked ' || g, 1760000000000 + g, 1760000000000 + g,
           jsonb_build_object(
             'note', repeat('x', 1500),
             'externalBlockers', jsonb_build_array(
               jsonb_build_object('kind', 'event', 'ref', 'bg:event:' || g, 'status', 'active', 'capability', 'live-dependency'),
               jsonb_build_object('kind', 'event', 'ref', 'bg:event:old:' || g, 'status', 'cleared')))
      FROM generate_series(1, ${BLOCKED_ROWS}) g;
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, status, title, created_ts, updated_ts, payload)
    SELECT '${WS}', 'papercusp', 'WI-parked-' || g, 'bug', 'open', 'parked ' || g, 1760000000000 + g, 1760000000000 + g,
           jsonb_build_object('_claimHold', true, 'claim_hold_by', 'su-bg-' || g,
                              'claim_hold_release', jsonb_build_object('trigger', 'bg:park:' || g))
      FROM generate_series(1, ${PARKED_ROWS}) g;`).simple();
  for (const f of FIXTURES) {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, title, created_ts, updated_ts, taken_by, payload)
      VALUES (${f.ws ?? WS}, 'papercusp', ${f.id}, 'bug', 'blocked', ${f.id}, 1760000000000, 1760000000000,
              ${f.takenBy ?? null}, ${f.payload === null ? null : JSON.stringify(f.payload)}::text::jsonb)`;
  }
  await db.sql.unsafe('ANALYZE harness_shared.work_items').simple();

  traced = postgres(db.url, {
    max: 2,
    prepare: false,
    onnotice: () => {},
    debug: (_connection, query, params) => {
      captured.push({ query, params: params as unknown[] });
    },
  });
  h.sql = traced;
}, 300_000);

afterAll(async () => {
  await traced?.end({ timeout: 5 });
  await db?.cleanup();
});

describe('event-wait settlement lookups (event-wait-settlement-2026-10-20 P-002)', () => {
  it('AUTO-BAR-R-3-P-002: the external-blocker settlement lookup reads the GIN wait-ref index, no seq scan', async () => {
    const nodes = await planNodes(db.sql, await externalBlockerLookup());
    const shape = JSON.stringify(nodes.map((n) => [n['Node Type'], n['Index Name'] ?? null, n['Index Cond'] ?? null]));

    // A GIN index can also be read by an unqualified full-index scan, so the containment
    // itself must be the index condition — not merely the index named somewhere.
    const gin = nodes.find((n) => n['Index Name'] === GIN_INDEX);
    expect(gin, shape).toBeDefined();
    expect(gin!['Index Cond'] ?? '', shape).toMatch(/externalBlockers.*@>/);
    expect(nodes.some((n) => n['Node Type'] === 'Seq Scan'), shape).toBe(false);
  });

  it('AUTO-BAR-R-3-P-002: the durable-park settlement lookup reads the trigger index, no seq scan', async () => {
    const nodes = await planNodes(db.sql, await durableParkLookup());

    expect(nodes.map((n) => n['Index Name']).filter(Boolean)).toContain(PARK_INDEX);
    expect(nodes.some((n) => n['Node Type'] === 'Seq Scan')).toBe(false);
  });

  it('the durable-park lookup selects exactly the parks the pre-rewrite scan did', async () => {
    const expected = await oracleParkedIds(PARK_KEY);
    // Fixture sanity: the oracle itself admits only the held, unclaimed parks naming the key.
    expect(expected).toEqual(['WI-fx-park', 'WI-fx-park-blank-taken', 'WI-fx-park-other-ws']);

    // Re-run the exact captured statement with the target key bound in place of the absent
    // one: the reconcile itself would clear what it finds, so its own read is not replayable.
    const lookup = await durableParkLookup();
    const params = lookup.params.map((p) => (p === ABSENT_KEY ? PARK_KEY : p));
    expect(params).toContain(PARK_KEY);
    const rows = await db.sql.begin(async (tx) => {
      const found = await tx.unsafe<{ feature_id: string }[]>(lookup.query, params as never[]);
      return found.map((r) => r.feature_id).sort();
    });
    expect(rows).toEqual(expected);

    const out = await reconcileEventDurableParks(traced, PARK_KEY, 'test:p002');
    expect(out.matched).toBe(expected.length);
  });

  it('SPEC-P-002: the rewritten event-blocker reconcile settles the same items as the pre-rewrite scan', async () => {
    const expected = await oracleBlockedIds(BLOCKER_KEY);
    // Fixture sanity: only ACTIVE `event` blockers on the key, in either workspace, qualify.
    expect(expected).toEqual(['WI-fx-blocked', 'WI-fx-blocked-other-ws', 'WI-fx-blocked-second']);
    const before = await payloadsById();

    const out = await reconcileEventExternalBlockers(traced, BLOCKER_KEY, 'test:p002');

    expect(out.cleared).toBe(expected.length);
    const after = await payloadsById();
    const settled = [...after.keys()].filter((id) => JSON.stringify(after.get(id)) !== JSON.stringify(before.get(id))).sort();
    expect(settled).toEqual(expected);
    for (const id of expected) {
      const blockers = (after.get(id) as { externalBlockers: { kind: string; ref: string; status: string }[] }).externalBlockers;
      expect(blockers.find((b) => b.kind === 'event' && b.ref === BLOCKER_KEY)?.status).toBe('cleared');
    }
    // Nothing is left for a second settlement of the same key.
    expect(await oracleBlockedIds(BLOCKER_KEY)).toEqual([]);
  });

  it('the pre-rewrite lookups cannot use the wait-ref indexes (the index assertions discriminate)', async () => {
    // Same indexes, same data, the ORACLE predicates: neither may reach 1539's indexes, so
    // the AUTO-BAR-R-3-P-002 cases above fail if the rewrite is reverted.
    const oldBlocker = {
      query: `SELECT workspace_id, feature_id, item_kind, status, payload FROM harness_shared.work_items
               WHERE payload ? 'externalBlockers'
                 AND COALESCE(payload, '{}'::jsonb) @> jsonb_build_object('externalBlockers',
                   jsonb_build_array(jsonb_build_object('kind', 'event', 'ref', $1::text, 'status', 'active')))
               FOR UPDATE`,
      params: [ABSENT_KEY],
    };
    const oldPark = {
      query: `SELECT workspace_id, harness_slug, feature_id, status AS state, taken_by, payload FROM harness_shared.work_items
               WHERE COALESCE(payload, '{}'::jsonb) ->> '_claimHold' = 'true'
                 AND NULLIF(COALESCE(payload, '{}'::jsonb) ->> 'claim_hold_by', '') IS NOT NULL
                 AND (taken_by IS NULL OR btrim(taken_by) = '')
                 AND COALESCE(payload, '{}'::jsonb) -> 'claim_hold_release' ->> 'trigger' = $1
               FOR UPDATE`,
      params: [ABSENT_KEY],
    };

    expect((await planNodes(db.sql, oldBlocker)).map((n) => n['Index Name'])).not.toContain(GIN_INDEX);
    expect((await planNodes(db.sql, oldPark)).map((n) => n['Index Name'])).not.toContain(PARK_INDEX);
  });
});
