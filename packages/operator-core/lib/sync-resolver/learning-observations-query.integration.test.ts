// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { INTAKE_EXECUTION_SCHEMA_VERSION, readIntakeTriageState } from '../attention/intake-promotion';
import { composeCompanionSummary, type CompanionListSummary, type FacetDef } from '@papercusp/facets';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../test/_work-items-schema';
import { assertCompanionPredicateParity } from './count-contract-testkit';
import { LIST_READ_BUDGET_MS } from './bounded-list-read';
import { PAYLOAD_BUDGET_BYTES } from './sync-read-audit';
import {
  buildLearningObservationsPredicate,
  learningObservationsSummarySelection,
  normalizeLearningObservationsArgs,
  readLearningObservationsPageFromStore,
  readLearningObservationsSummaryFromStore,
  type LearningObservationRow,
  type LearningObservationsWireArgs,
} from './learning-observations-read';

// Above the 46,964-row live raw-observation corpus measured 2026-08-22 and the
// retired 2,000-row cap. The distinguished match is deep in newest-first order.
const ROWS = 50_205;
const DEEP = 50_153;
const token = randomBytes(5).toString('hex');
const workspaceId = `p5-observations-${token}`;
const harnessSlug = `p5-harness-${token}`;
const BASE_TS = 1_900_000_000_000;
let db: FreshPgDb;
let sql: Sql;

interface FixtureRow extends LearningObservationRow {
  kind: string;
  scope: string;
  confidence: string;
  sourceRole: string;
}

const rowFor = (g: number): FixtureRow => ({
  id: `P5OBS-${g.toString().padStart(5, '0')}`,
  title: g === DEEP ? 'deep-only-match' : `ordinary observation ${g}`,
  body: `body ${g}`,
  kind: ['friction', 'workaround', 'gap', 'surprise', 'reinforce', 'other'][g % 6]!,
  scope: `scope-${g % 10}`,
  confidence: ['low', 'med', 'high', 'unknown'][g % 4]!,
  sourceRole: `role-${g % 5}`,
  refs: g === DEEP ? ['context:plan-deep/P-005'] : [`plan-${g % 7}`],
  createdAt: new Date(BASE_TS - g).toISOString(),
});

const corpus = Array.from({ length: ROWS }, (_, index) => rowFor(index + 1));

const planMatches = (row: FixtureRow, plans: readonly string[]): boolean => {
  if (plans.length === 0) return true;
  return plans.some((plan) => {
    const slug = plan.toLowerCase();
    const tokenPattern = new RegExp(`(^|[^a-z0-9_-])${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_-])`);
    return row.refs.some((ref) => {
      const lowered = ref.toLowerCase();
      return lowered === slug || lowered === `plan:${slug}` || tokenPattern.test(lowered);
    });
  });
};

const facetBasePredicate = (row: FixtureRow, wire: LearningObservationsWireArgs): boolean => {
  const args = normalizeLearningObservationsArgs(wire);
  const q = args.q?.toLowerCase() ?? null;
  const haystack = `${row.title} ${row.body ?? ''} ${row.kind} ${row.refs.join(' ')}`.toLowerCase();
  return (!q || haystack.includes(q)) && planMatches(row, args.filters.plans);
};

const matches = (row: FixtureRow, wire: LearningObservationsWireArgs): boolean => {
  const args = normalizeLearningObservationsArgs(wire);
  const f = args.filters;
  return (
    facetBasePredicate(row, wire) &&
    (f.scopes.length === 0 || f.scopes.includes(row.scope)) &&
    (f.sourceRoles.length === 0 || f.sourceRoles.includes(row.sourceRole)) &&
    (f.confidences.length === 0 || f.confidences.includes(row.confidence)) &&
    (f.triageStates.length === 0 || f.triageStates.includes(row.triageState ?? 'awaiting')) &&
    (f.kinds.length === 0 || f.kinds.includes(row.kind))
  );
};

const facetDefs: readonly FacetDef<FixtureRow>[] = [
  { key: 'triageState', extract: (row) => row.triageState ?? 'awaiting' },
  { key: 'kind', extract: (row) => row.kind },
  { key: 'scope', extract: (row) => row.scope },
  { key: 'sourceRole', extract: (row) => row.sourceRole },
  { key: 'confidence', extract: (row) => row.confidence },
];

const pageFor = async (args: LearningObservationsWireArgs, cursor: string | null) => {
  const normalized = normalizeLearningObservationsArgs({ ...args, cursor });
  return readLearningObservationsPageFromStore(
    sql,
    workspaceId,
    buildLearningObservationsPredicate(normalized),
  ) as Promise<{ rows: FixtureRow[]; nextCursor: string | null; hasMore: boolean }>;
};

const summaryFor = async (args: LearningObservationsWireArgs): Promise<CompanionListSummary> => {
  const normalized = normalizeLearningObservationsArgs(args);
  const aggregate = await readLearningObservationsSummaryFromStore(
    sql,
    workspaceId,
    buildLearningObservationsPredicate(normalized),
  );
  return composeCompanionSummary(aggregate, {
    selection: learningObservationsSummarySelection(normalized),
  });
};

// Both benchmarks inject the same unused display projection into the canonical
// base-table query; keeping one copy prevents a retired view alias surviving in one rig.
const withUnusedObservationProjection = (query: string): string => query.replace(
  /(scoped AS MATERIALIZED\s*\(\s*SELECT)/i,
  `$1 feature_id AS id, COALESCE(title, '') AS title, summary AS body,
    to_timestamp(created_ts / 1000.0) AS created_at,
    ARRAY(SELECT jsonb_array_elements_text(CASE
      WHEN jsonb_typeof(payload->'observation'->'refs') = 'array'
      THEN payload->'observation'->'refs' ELSE '[]'::jsonb END)) AS refs,`,
);

beforeAll(async () => {
  db = await createFreshPgDb('learning-observations-query');
  sql = db.sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await sql.unsafe(readFileSync(new URL('../../../../libs/papercusp/libs/db/sql/831-issue-occurrence-ledger.sql', import.meta.url), 'utf8'));
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status,
       item_kind, payload, created_ts, updated_ts, origin)
    SELECT ${workspaceId},
           ${harnessSlug},
           'P5OBS-' || lpad(g::text, 5, '0'),
           CASE WHEN g = ${DEEP} THEN 'deep-only-match'
                ELSE 'ordinary observation ' || g END,
           'body ' || g,
           'open',
           'bug',
           jsonb_build_object(
             'lane', 'observation',
             'filedByRole', 'role-' || (g % 5),
             'observation', jsonb_build_object(
               'kind', (ARRAY['friction','workaround','gap','surprise','reinforce','other'])[1 + (g % 6)],
               'scope', 'scope-' || (g % 10),
               'confidence', (ARRAY['low','med','high','unknown'])[1 + (g % 4)],
               'refs', CASE WHEN g = ${DEEP}
                            THEN jsonb_build_array('context:plan-deep/P-005')
                            ELSE jsonb_build_array('plan-' || (g % 7)) END
             )
           ),
           ${BASE_TS}::bigint - g,
           ${BASE_TS}::bigint - g,
           'local'
      FROM generate_series(1, ${ROWS}) AS g`;
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('learning.observations + summary real-PG contract', () => {
  it('R-10/R-33 partitions retained observation stock into awaiting/handled exactly once, reopening new evidence and undo', async () => {
    const schemaVersion = INTAKE_EXECUTION_SCHEMA_VERSION;
    const disposition = { schemaVersion, disposition: 'retain', reason: 'kept as evidence', decidedBy: 'reviewer', occurrenceWatermark: 10 };
    const fixtures = [
      { id: 'never', payload: {}, latest: null, state: 'awaiting' },
      { id: 'retain', payload: { intakeDisposition: disposition }, latest: 10, state: 'handled' },
      { id: 'reject', payload: { intakeDisposition: { ...disposition, disposition: 'reject' } }, latest: null, state: 'handled' },
      { id: 'reopened', payload: { intakeDisposition: disposition }, latest: 11, state: 'awaiting' },
      { id: 'promoted', payload: { intakeExecution: { schemaVersion, disposition: 'promote', workItemId: 'WI-accepted' } }, latest: null, state: 'handled' },
      { id: 'merged', payload: { intakeExecution: { schemaVersion, disposition: 'merge', workItemId: 'WI-target' } }, latest: null, state: 'handled' },
      { id: 'in-place', payload: { intakePromotion: { schemaVersion, key: 'receipt' } }, latest: null, state: 'handled' },
      { id: 'reversed', payload: { intakeDispositionReversed: [disposition] }, latest: null, state: 'awaiting' },
      { id: 'retry', payload: { intakeDisposition: { ...disposition, disposition: 'retry' } }, latest: null, state: 'awaiting' },
      { id: 'legacy', payload: { intakeExecution: { schemaVersion: 'unknown' } }, latest: null, state: 'awaiting' },
      { id: 'bad-key', payload: { intakePromotion: { schemaVersion, key: 42 } }, latest: null, state: 'awaiting' },
      { id: 'bad-watermark', payload: { intakeDisposition: { ...disposition, occurrenceWatermark: '10' } }, latest: 12, state: 'awaiting' },
      { id: 'negative-watermark-no-occurrence', payload: { intakeDisposition: { ...disposition, occurrenceWatermark: -1 } }, latest: null, state: 'handled' },
    ];
    const ids = fixtures.map((fixture) => `TRIAGE-${fixture.id}`);
    try {
      for (const fixture of fixtures) {
        const id = `TRIAGE-${fixture.id}`;
        expect(readIntakeTriageState(fixture.payload, fixture.latest)).toBe(fixture.state);
        await sql`INSERT INTO harness_shared.work_items
          (workspace_id,harness_slug,feature_id,title,summary,status,item_kind,payload,created_ts,updated_ts,origin)
          VALUES (${workspaceId},${harnessSlug},${id},${'triage-partition ' + fixture.id},'', 'open','bug',
            ${sql.json({ ...fixture.payload, lane: 'observation' })},${BASE_TS},${BASE_TS},'local')`;
        if (fixture.latest !== null) await sql`INSERT INTO harness_shared.work_item_occurrences
          (occurrence_id,workspace_id,canonical_harness_slug,canonical_work_item_id,source_tool,report_kind,reported_title)
          VALUES (${fixture.latest},${workspaceId},${harnessSlug},${id},'test','canonical-created','new evidence')`;
      }
      // The occurrence belongs to another canonical harness, despite sharing an id.
      await sql`INSERT INTO harness_shared.work_item_occurrences
        (occurrence_id,workspace_id,canonical_harness_slug,canonical_work_item_id,source_tool,report_kind,reported_title)
        VALUES (101,${workspaceId},'other-harness','TRIAGE-retain','test','canonical-created','unrelated evidence')`;
      const full = await summaryFor({ q: 'triage-partition' });
      expect(full).toMatchObject({ total: ROWS + fixtures.length, matched: fixtures.length });
      const partition = full.facets.find((facet) => facet.key === 'triageState')!.values;
      expect(partition.map((value) => value.count).reduce((a, b) => a + b, 0)).toBe(fixtures.length);
      for (const state of ['awaiting', 'handled']) {
        const wire = { q: 'triage-partition', filters: { triageStates: [state] } };
        const page = await pageFor(wire, null);
        const expected = fixtures.filter((fixture) => fixture.state === state).map((fixture) => `TRIAGE-${fixture.id}`).sort();
        expect(page.rows.map((row) => row.id).sort()).toEqual(expected);
        expect(page.rows.every((row) => row.triageState === state)).toBe(true);
        const summary = await summaryFor(wire);
        expect(summary.matched).toBe(expected.length);
        expect(summary.facets.find((facet) => facet.key === 'triageState')!.values).toEqual(partition);
      }
    } finally {
      await sql`DELETE FROM harness_shared.work_item_occurrences WHERE workspace_id=${workspaceId} AND canonical_work_item_id=ANY(${ids}::text[])`;
      await sql`DELETE FROM harness_shared.work_items WHERE workspace_id=${workspaceId} AND feature_id=ANY(${ids}::text[])`;
    }
  });
  it('bounds reference expansion for summaries/pages while retaining reference search', async () => {
    let captured: { query: string; parameters: Parameters<Sql['unsafe']>[1] } | undefined;
    const recordingSql = postgres(db.url, {
      max: 1,
      debug: (_connection, query, parameters) => { captured = { query, parameters }; },
    });
    type PlanNode = {
      'Node Type': string;
      'Actual Rows': number;
      'Actual Loops': number;
      Plans?: PlanNode[];
    };
    const expandedRows = (node: PlanNode): number =>
      (node['Node Type'] === 'ProjectSet' ? node['Actual Rows'] * node['Actual Loops'] : 0)
      + (node.Plans ?? []).reduce((sum, child) => sum + expandedRows(child), 0);
    try {
      for (const q of ['', 'context:plan-deep/P-005']) {
        const rows = await readLearningObservationsSummaryFromStore(
          recordingSql, workspaceId,
          buildLearningObservationsPredicate(normalizeLearningObservationsArgs({ q })),
        );
        expect(rows.find((row) => row.kind === 'totals')).toMatchObject({
          total: ROWS, matched: q ? 1 : ROWS,
        });
        expect(captured).toBeDefined();
        const plan = await sql.unsafe<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>(
          `EXPLAIN (ANALYZE, FORMAT JSON) ${captured!.query}`, captured!.parameters,
        );
        const expanded = expandedRows(plan[0]!['QUERY PLAN'][0]!.Plan);
        if (q) expect(expanded).toBeGreaterThan(0);
        else expect(expanded).toBe(0);
        if (!q) {
          const burst = await Promise.all(Array.from({ length: 8 }, () => summaryFor({})));
          for (const summary of burst) expect(summary).toEqual(burst[0]);
          expect(burst[0]).toMatchObject({ total: ROWS, matched: ROWS });
        }
      }
      const page = await readLearningObservationsPageFromStore(
        recordingSql, workspaceId,
        buildLearningObservationsPredicate(normalizeLearningObservationsArgs({ limit: 200 })),
      );
      expect(page.rows).toHaveLength(200);
      expect(page.hasMore).toBe(true);
      const pagePlan = await sql.unsafe<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${captured!.query}`, captured!.parameters,
      );
      // One ref per fixture row: only the bounded page plus its next-page
      // sentinel needs display refs, not every row in the observation corpus.
      expect(expandedRows(pagePlan[0]!['QUERY PLAN'][0]!.Plan)).toBeLessThanOrEqual(201);
    } finally {
      await recordingSql.end();
    }
  }, 120_000);

  // Keep the 100 alternating samples per variant, but give the structural
  // guard and each bounded batch their own deadline. One 200-query task used
  // to time out and keep executing into subsequent tests.
  const warmTimings: Record<'legacy' | 'current', number[]> = { legacy: [], current: [] };
  it.for([0, 1, 2, 3, 4])('measures warm summary parity and latency in bounded batch %i', { timeout: 120_000 }, async (batch, { signal }) => {
    let captured: { query: string; parameters: Parameters<Sql['unsafe']>[1] } | undefined;
    const recordingSql = postgres(db.url, {
      max: 1,
      debug: (_connection, query, parameters) => { captured = { query, parameters }; },
    });
    try {
      await readLearningObservationsSummaryFromStore(
        recordingSql, workspaceId,
        buildLearningObservationsPredicate(normalizeLearningObservationsArgs({})),
      );
      expect(captured).toBeDefined();
      const currentQuery = captured!.query;
      const legacyQuery = withUnusedObservationProjection(currentQuery);
      expect(legacyQuery).not.toBe(currentQuery);
      const parameters = captured!.parameters;
      const canonical = (result: readonly object[]) => result.map((row) => JSON.stringify(row)).sort();
      const reference = canonical(await sql.unsafe(currentQuery, parameters));
      for (let offset = 0; offset < 20; offset += 1) {
        const sample = batch * 20 + offset;
        const order = sample % 2 === 0 ? ['legacy', 'current'] as const : ['current', 'legacy'] as const;
        for (const variant of order) {
          signal.throwIfAborted();
          const started = performance.now();
          const result = await sql.unsafe(variant === 'legacy' ? legacyQuery : currentQuery, parameters);
          signal.throwIfAborted();
          warmTimings[variant].push(performance.now() - started);
          expect(canonical(result)).toEqual(reference);
        }
      }
      console.info('OBSERVATION_SUMMARY_BENCHMARK_BATCH', JSON.stringify({ batch, callsPerVariant: 20 }));
      if (batch === 4) {
        expect(warmTimings.legacy).toHaveLength(100);
        expect(warmTimings.current).toHaveLength(100);
        const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
        console.info('OBSERVATION_SUMMARY_BENCHMARK', JSON.stringify({
          rows: ROWS, callsPerVariant: 100, cacheState: 'warm',
          p50Ms: { legacy: percentile(warmTimings.legacy, 0.5), current: percentile(warmTimings.current, 0.5) },
          p95Ms: { legacy: percentile(warmTimings.legacy, 0.95), current: percentile(warmTimings.current, 0.95) },
        }));
      }
    } finally {
      await recordingSql.end();
    }
  });

  it('measures fresh-client and eight-reader summary latency with complete result parity', async () => {
    let captured: { query: string; parameters: Parameters<Sql['unsafe']>[1] } | undefined;
    const recordingSql = postgres(db.url, {
      max: 1,
      debug: (_connection, query, parameters) => { captured = { query, parameters }; },
    });
    try {
      await readLearningObservationsSummaryFromStore(
        recordingSql, workspaceId,
        buildLearningObservationsPredicate(normalizeLearningObservationsArgs({})),
      );
    } finally {
      await recordingSql.end();
    }
    expect(captured).toBeDefined();
    const currentQuery = captured!.query;
    const legacyQuery = withUnusedObservationProjection(currentQuery);
    expect(legacyQuery).not.toBe(currentQuery);
    const canonical = (rows: readonly object[]) => rows.map((row) => JSON.stringify(row)).sort();
    const expected = canonical(await sql.unsafe(currentQuery, captured!.parameters));
    const measurements: Array<{
      variant: 'legacy' | 'current'; round: number;
      freshClientMs: number; burstMs: number; readerMs: number[];
    }> = [];
    // Connection-cold, NOT database/OS-cache-cold: the fixture has already been
    // loaded and read. Alternate order to avoid assigning warm-up to one version.
    for (let round = 0; round < 4; round += 1) {
      const order = round % 2 === 0 ? ['legacy', 'current'] as const : ['current', 'legacy'] as const;
      for (const variant of order) {
        const client = postgres(db.url, { max: 8, prepare: false });
        const query = variant === 'legacy' ? legacyQuery : currentQuery;
        try {
          const firstStarted = performance.now();
          const first = await client.unsafe(query, captured!.parameters);
          const freshClientMs = performance.now() - firstStarted;
          expect(canonical(first)).toEqual(expected);
          const burstStarted = performance.now();
          const readers = await Promise.all(Array.from({ length: 8 }, async () => {
            const started = performance.now();
            const rows = await client.unsafe(query, captured!.parameters);
            return { rows, ms: performance.now() - started };
          }));
          const burstMs = performance.now() - burstStarted;
          for (const reader of readers) expect(canonical(reader.rows)).toEqual(expected);
          measurements.push({ variant, round, freshClientMs, burstMs, readerMs: readers.map((r) => r.ms) });
        } finally {
          await client.end();
        }
      }
    }
    console.info('OBSERVATION_SUMMARY_CONCURRENCY', JSON.stringify({
      rows: ROWS, concurrency: 8, roundsPerVariant: 4,
      cacheState: 'fresh connection pool; warmed database/OS caches; no application cache',
      measurements,
    }));
  }, 120_000);

  it.each([
    { q: `body ${DEEP}` },
    { q: 'context:plan-deep/P-005' },
    { filters: { plans: ['plan-deep'] } },
  ])('preserves body/reference/plan summary predicates: %j', async (args) => {
    expect(await summaryFor(args)).toMatchObject({ total: ROWS, matched: 1 });
  });

  it('proves OR-within/AND-across parity, exact zero, facets, and cursor termination above live size', async () => {
    const deep = rowFor(DEEP);
    const args: LearningObservationsWireArgs = {
      filters: {
        scopes: [deep.scope, 'scope-9'],
        sourceRoles: [deep.sourceRole, 'role-4'],
        confidences: [deep.confidence, 'unknown'],
        kinds: [deep.kind, 'gap'],
      },
      limit: 200,
    };
    await assertCompanionPredicateParity({
      corpus,
      pageCap: 200,
      args,
      zeroMatchArgs: { q: 'no-such-p5-observation', limit: 200 },
      beyondPageRowId: deep.id,
      rowId: (row) => row.id,
      predicate: matches,
      facetBasePredicate,
      facetDefs,
      selection: (wire) => learningObservationsSummarySelection(normalizeLearningObservationsArgs(wire)),
      readPage: pageFor,
      readSummary: summaryFor,
    });
  }, 60_000);

  it('finds the only text and selected-plan match beyond page one', async () => {
    const textRows = await pageFor({ q: 'deep-only-match', limit: 200 }, null);
    expect(textRows.rows.map((row) => row.id)).toEqual([rowFor(DEEP).id]);
    const planRows = await pageFor({ filters: { plans: ['plan-deep'] }, limit: 200 }, null);
    expect(planRows.rows.map((row) => row.id)).toEqual([rowFor(DEEP).id]);
  });

  it('keeps the paired response bounded and under the shared six-second budget', async () => {
    const started = performance.now();
    const [page, summary] = await Promise.all([pageFor({ limit: 200 }, null), summaryFor({ limit: 200 })]);
    const elapsedMs = performance.now() - started;
    expect(page.rows).toHaveLength(200);
    expect(page.hasMore).toBe(true);
    expect(summary).toMatchObject({ total: ROWS, matched: ROWS });
    expect(Buffer.byteLength(JSON.stringify({ page, summary }), 'utf8')).toBeLessThan(PAYLOAD_BUDGET_BYTES);
    expect(elapsedMs).toBeLessThan(LIST_READ_BUDGET_MS);
  }, 30_000);
});
