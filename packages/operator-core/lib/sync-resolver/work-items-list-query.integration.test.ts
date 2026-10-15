// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
import {
  composeCompanionSummary,
  type CompanionListSummary,
  type FacetDef,
  type FacetSelection,
} from '@papercusp/facets';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import { sealImplementationAcceptance } from '../harness/improvements/agent-review-policy';
import {
  assertCompanionPredicateParity,
} from './count-contract-testkit';
import { LIST_READ_BUDGET_MS } from './bounded-list-read';
import {
  buildWorkItemsPredicate,
  encodeWorkItemsCursor,
  normalizeWorkItemsListArgs,
  readWorkItemsPageFromStore,
  readWorkItemPresentations,
  readWorkItemsSummaryFromStore,
  workItemsPageSql,
  workItemsSummarySelection,
  type WorkItemsListRow,
  type WorkItemsListWireArgs,
} from './work-items-list-query';

const ROWS = 31_205; // above Avi's 31,133-row reproduction corpus
const DEEP = 31_153;
const token = randomBytes(5).toString('hex');
const workspaceId = `p4-ws-${token}`;
const harnessSlug = `p4-h-${token}`;
const BASE_TS = 1_900_000_000_000;
let db: FreshPgDb;
let sql: Sql;

/** Minimal production-reader projection: scopedCtes reads only these columns. */
const SPAWNED_AGENTS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text PRIMARY KEY,
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    parent_role text,
    child_role text,
    feature_id text,
    run_id text,
    status text NOT NULL,
    started_at timestamptz
  )`;

/** The live corpus already carries hfc_updated_idx; reproduce that planner seam. */
const WORK_ITEMS_UPDATED_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS hfc_updated_idx
    ON harness_shared.work_items (updated_ts DESC)`;

interface FixtureRow {
  id: string;
  kind: string;
  state: string;
  title: string;
  assignee: string;
  severity: string | null;
  priority: number;
  rank: number;
  plan: string;
  stage: string | null;
}

const rowFor = (g: number): FixtureRow => {
  const kind = g % 3 === 0 ? 'feature' : g % 3 === 1 ? 'bug' : 'change';
  return {
    id: `P4WI-${g.toString().padStart(5, '0')}`,
    kind,
    state: ['open', 'blocked', 'wip', 'done'][g % 4]!,
    title: g === DEEP ? 'deep-only-match' : `ordinary work item ${g}`,
    assignee: `su-${g % 6}`,
    severity: kind === 'feature' ? null : g % 2 === 0 ? 'minor' : 'major',
    priority: g % 10,
    rank: g % 7,
    plan: `plan-${g % 5}`,
    stage: g === DEEP ? 'reviewer' : null,
  };
};

const corpus = Array.from({ length: ROWS }, (_, index) => rowFor(index + 1));

interface PlanNode {
  'Node Type'?: string;
  'Subplan Name'?: string;
  Plans?: PlanNode[];
  [key: string]: unknown;
}

const findPlanNode = (node: PlanNode, match: (node: PlanNode) => boolean): PlanNode | undefined => {
  if (match(node)) return node;
  for (const child of node.Plans ?? []) {
    const found = findPlanNode(child, match);
    if (found) return found;
  }
  return undefined;
};

const selection = (args: WorkItemsListWireArgs): FacetSelection =>
  workItemsSummarySelection(normalizeWorkItemsListArgs(args));

const facetDefs: readonly FacetDef<FixtureRow>[] = [
  { key: 'kind', extract: (row) => row.kind },
  { key: 'state', extract: (row) => row.state },
  { key: 'stage', extract: (row) => row.stage },
  { key: 'assignee', extract: (row) => row.assignee },
  { key: 'severity', extract: (row) => row.severity },
  { key: 'plan', extract: (row) => row.plan },
];

const matches = (row: FixtureRow, wire: WorkItemsListWireArgs): boolean => {
  const args = normalizeWorkItemsListArgs(wire);
  const f = args.filters;
  return matchesFacetBase(row, wire)
    && (f.kinds.length === 0 || f.kinds.includes(row.kind))
    && (f.states.length === 0 || f.states.includes(row.state))
    && (f.stages.length === 0 || (row.stage != null && f.stages.includes(row.stage)))
    && (f.assignees.length === 0 || f.assignees.includes(row.assignee))
    && (f.severities.length === 0 || (row.severity != null && f.severities.includes(row.severity)))
    && (f.plans.length === 0 || f.plans.includes(row.plan));
};

const matchesFacetBase = (row: FixtureRow, wire: WorkItemsListWireArgs): boolean => {
  const args = normalizeWorkItemsListArgs(wire);
  const f = args.filters;
  const contains = (value: string | null, query: string | null) =>
    !query || (value ?? '').toLowerCase().includes(query.toLowerCase());
  return contains(`${row.id} ${row.title} ${row.state} ${row.assignee}`, args.q)
    && contains(row.id, f.id)
    && contains(row.title, f.title)
    && (f.priorityMin == null || row.priority >= f.priorityMin)
    && (f.priorityMax == null || row.priority <= f.priorityMax)
    && (f.rankMin == null || row.rank >= f.rankMin)
    && (f.rankMax == null || row.rank <= f.rankMax);
};

const fixtureFromStoredRow = (row: WorkItemsListRow): FixtureRow => ({
  id: row.id,
  kind: row.kind,
  state: row.state,
  title: row.title,
  assignee: row.assignee ?? '',
  severity: row.severity,
  priority: row.priority ?? 0,
  rank: row.rank ?? 0,
  plan: row.planSlug ?? '',
  stage: row.spineRole,
});

const pageFor = async (args: WorkItemsListWireArgs, cursor: string | null) => {
  const normalized = normalizeWorkItemsListArgs({ ...args, cursor });
  const page = await readWorkItemsPageFromStore(sql, workspaceId, buildWorkItemsPredicate(normalized));
  return { ...page, rows: page.rows.map(fixtureFromStoredRow) };
};

const summaryFor = async (args: WorkItemsListWireArgs): Promise<CompanionListSummary> => {
  const normalized = normalizeWorkItemsListArgs(args);
  const aggregate = await readWorkItemsSummaryFromStore(sql, workspaceId, buildWorkItemsPredicate(normalized));
  return composeCompanionSummary(aggregate, { selection: workItemsSummarySelection(normalized) });
};

beforeAll(async () => {
  db = await createFreshPgDb('work-items-list-query');
  sql = db.sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await sql.unsafe(WORK_ITEM_DEPS_DDL);
  await sql.unsafe(SPAWNED_AGENTS_DDL);
  await sql.unsafe(WORK_ITEMS_UPDATED_INDEX_DDL);
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, item_kind,
       taken_by, payload, feature_order, assignee_rank, source_plan_slug,
       created_ts, updated_ts, origin)
    SELECT ${workspaceId},
           ${harnessSlug},
           'P4WI-' || lpad(g::text, 5, '0'),
           CASE WHEN g = ${DEEP} THEN 'deep-only-match' ELSE 'ordinary work item ' || g END,
           CASE WHEN g = ${DEEP} THEN 'mobile detail description' ELSE '' END,
           (ARRAY['open','blocked','wip','done'])[1 + (g % 4)],
           CASE WHEN g % 3 = 0 THEN 'feature' WHEN g % 3 = 1 THEN 'bug' ELSE 'change' END,
           'su-' || (g % 6),
           CASE WHEN g % 3 = 0 THEN '{}'::jsonb
                ELSE jsonb_build_object('_ei', jsonb_build_object(
                  'severity', CASE WHEN g % 2 = 0 THEN 'minor' ELSE 'major' END
                )) END,
           g % 10,
           g % 7,
           'plan-' || (g % 5),
           ${BASE_TS}::bigint - g,
           ${BASE_TS}::bigint - g,
           'local'
      FROM generate_series(1, ${ROWS}) AS g`;
  await sql`
    INSERT INTO harness_shared.spawned_agents
      (spawn_id, workspace_id, harness_slug, parent_role, child_role,
       feature_id, run_id, status, started_at)
    VALUES (${`p4-spawn-${token}`}, ${workspaceId}, ${harnessSlug}, 'su', 'reviewer',
            ${rowFor(DEEP).id}, ${`p4-run-${token}`}, 'done', now())`;
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('workItems.byHarness + workItems.summary real-PG contract', () => {
  it('keeps non-work records out of queue pages, fair slices, counts and facets', async () => {
    const queueHarness = `${harnessSlug}-nature`;
    const contactId = 'PER-8bb3f65b4bfceccd6673b885';
    const fixtures = [
      { id: 'WI-QUEUE-FEATURE', kind: 'feature', nature: 'work', audience: 'agent' },
      { id: 'WI-QUEUE-BUG', kind: 'bug', nature: 'work', audience: 'agent' },
      { id: 'WI-QUEUE-CUSTOM', kind: 'queue-custom-work', nature: 'work', audience: 'agent' },
      { id: 'WI-QUEUE-HUMAN', kind: 'email-draft-proposal', nature: 'work', audience: 'human' },
      { id: contactId, kind: 'person', nature: 'record', audience: null },
      { id: 'ORG-QUEUE-RECORD', kind: 'organization', nature: 'record', audience: null },
      { id: 'DOC-QUEUE-DOCUMENT', kind: 'feature', nature: 'document', audience: null },
      { id: 'EVT-QUEUE-EVENT', kind: 'queue-event', nature: 'event', audience: null },
    ];
    await sql`INSERT INTO harness_shared.work_items ${sql(fixtures.map((row, index) => ({
      workspace_id: workspaceId, harness_slug: queueHarness, feature_id: row.id,
      item_kind: row.kind, nature: row.nature, audience: row.audience,
      title: row.id, summary: '', status: 'open', payload: {},
      created_ts: BASE_TS, updated_ts: BASE_TS + index,
    })))}`;
    const predicateFor = (args: WorkItemsListWireArgs = {}) =>
      buildWorkItemsPredicate(normalizeWorkItemsListArgs({ harnessSlug: queueHarness, ...args }));
    const workIds = fixtures.filter((row) => row.nature === 'work').map((row) => row.id).sort();

    const page = await readWorkItemsPageFromStore(sql, workspaceId, predicateFor());
    expect(page.rows.map((row) => row.id).sort()).toEqual(workIds);
    expect(page.hasMore).toBe(false);
    const first = await readWorkItemsPageFromStore(sql, workspaceId, predicateFor({ limit: 1 }));
    expect(first.rows.map((row) => row.id)).toEqual(['WI-QUEUE-HUMAN']);
    expect(first.hasMore).toBe(true);
    const next = await readWorkItemsPageFromStore(sql, workspaceId, predicateFor({ cursor: first.nextCursor }));
    expect(next.rows.map((row) => row.id).sort()).toEqual(workIds.filter((id) => id !== 'WI-QUEUE-HUMAN'));

    const fair = await readWorkItemsPageFromStore(sql, workspaceId,
      predicateFor({ states: ['open'], perState: 10 }));
    expect(fair.rows.map((row) => row.id).sort()).toEqual(workIds);
    const summary = await readWorkItemsSummaryFromStore(sql, workspaceId, predicateFor());
    expect(summary.find((row) => row.kind === 'totals')).toEqual({ kind: 'totals', total: 4, matched: 4 });
    expect(summary.filter((row) => row.kind === 'facet' && row.facet === 'kind')
      .map((row) => row.kind === 'facet' ? row.value : '').sort())
      .toEqual(['bug', 'email-draft-proposal', 'feature', 'queue-custom-work']);
    expect(summary.find((row) => row.kind === 'facet' && row.facet === 'state'))
      .toMatchObject({ value: 'open', count: 4 });

    // Searches and explicit kind filters narrow the work queue; they cannot opt data into it.
    for (const args of [{ q: contactId }, { kind: 'person' }, { filters: { kinds: ['person', 'organization'] } }]) {
      const predicate = predicateFor(args);
      expect((await readWorkItemsPageFromStore(sql, workspaceId, predicate)).rows).toEqual([]);
      expect((await readWorkItemsSummaryFromStore(sql, workspaceId, predicate))
        .find((row) => row.kind === 'totals')).toEqual({ kind: 'totals', total: 4, matched: 0 });
    }
    // Data remains stored and available to the relationship graph.
    const [contact] = await sql`SELECT nature, audience FROM harness_shared.work_items
      WHERE workspace_id = ${workspaceId} AND harness_slug = ${queueHarness} AND feature_id = ${contactId}`;
    expect(contact).toEqual({ nature: 'record', audience: null });
  });

  it('reads item progress and exact registered wait refs without turning reservations into native work', async () => {
    const id = rowFor(DEEP).id;
    const blocker = rowFor(DEEP - 1).id;
    const previous = await sql`SELECT taken_at, last_progress_at, payload FROM harness_shared.work_items
      WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND feature_id = ${id}`;
    const now = new Date().toISOString();
    try {
      await sql`UPDATE harness_shared.work_items SET taken_at = ${now}::timestamptz, last_progress_at = NULL,
        payload = payload || '{"_claimHold":true}'::jsonb
        WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND feature_id = ${id}`;
      await sql`INSERT INTO harness_shared.work_item_deps (workspace_id, blocked_kind, blocked_ref,
        blocker_kind, blocker_ref, dep_type, created_by, satisfaction)
        VALUES ('default', 'issue', ${harnessSlug + '#' + id}, 'issue', ${harnessSlug + '#' + blocker},
        'blocks', 'fixture', 'settled')`;
      const read = async () => (await readWorkItemPresentations(sql, workspaceId,
        [{ id, harnessSlug }])).get(`${harnessSlug}#${id}`)!;
      const reserved = await read();
      expect(reserved.workEvidence).toMatchObject({ reservation: { owner: rowFor(DEEP).assignee },
        recentItemWork: { status: 'unknown' }, nativeAttestation: { status: 'unknown' },
        waiting: { status: 'registered', refs: [harnessSlug + '#' + blocker] } });
      await sql`UPDATE harness_shared.work_items SET last_progress_at = ${now}::timestamptz
        WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND feature_id = ${id}`;
      expect((await read()).workEvidence?.recentItemWork.status).toBe('recent');
      expect((await read()).workEvidence?.nativeAttestation.status).toBe('unknown');
      expect(await readWorkItemPresentations(sql, `${workspaceId}-foreign`, [{ id, harnessSlug }])).toEqual(new Map());
    } finally {
      await sql`DELETE FROM harness_shared.work_item_deps WHERE workspace_id = 'default'
        AND blocked_ref = ${harnessSlug + '#' + id} AND created_by = 'fixture'`;
      await sql`UPDATE harness_shared.work_items SET taken_at = ${previous[0]!.taken_at},
        last_progress_at = ${previous[0]!.last_progress_at}, payload = ${sql.json(previous[0]!.payload)}
        WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND feature_id = ${id}`;
    }
  });

  it('preserves mobile harness and summary details on the existing scoped cursor reader', async () => {
    const predicate = buildWorkItemsPredicate(normalizeWorkItemsListArgs({
      harnessSlug, filters: { id: rowFor(DEEP).id }, limit: 200,
    }));
    const detailed = await readWorkItemsPageFromStore(sql, workspaceId, predicate, { includeDetails: true });
    expect(detailed.rows).toHaveLength(1);
    expect(detailed.rows[0]).toMatchObject({
      id: rowFor(DEEP).id, harness: harnessSlug, summary: 'mobile detail description',
      createdAt: new Date(BASE_TS - DEEP).toISOString(),
    });
    const lean = await readWorkItemsPageFromStore(sql, workspaceId, predicate);
    expect(lean.rows[0]?.summary).toBe('');
    expect(lean.rows[0]?.createdAt).toBeUndefined();
    const foreign = await readWorkItemsPageFromStore(sql, `${workspaceId}-foreign`, predicate, { includeDetails: true });
    expect(foreign.rows).toEqual([]);
  });

  it('carries current acceptance, stale reasons and evidence on a bounded row without leaking payload or body', async () => {
    const id = rowFor(DEEP).id;
    const source = { kind: rowFor(DEEP).kind, title: 'deep-only-match', summary: 'source content' };
    const sealed = sealImplementationAcceptance({ proposal: {
      problem: 'A measured queue defect', evidence: ['WI-10004573'], outcome: 'Queue explains acceptance',
      scope: 'selected harness', completionCheck: 'Read the selected row',
    }, source, authority: { kind: 'agent-review', reviewer: 'su-reviewer', submittedBy: 'su-filer', round: 1 },
      reason: 'Reviewed the source evidence', acceptedAt: '2026-10-01T00:00:00.000Z',
      // P-006: a bug's acceptance carries its reproduction receipt (ignored for other kinds).
      reproduction: { kind: 'failing-test', ref: 'fixture.test.ts', buildSha: 'abcdef1' } });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('fixture acceptance must seal');
    const payload = { implementationReadiness: { schemaVersion: 'implementation-readiness-v1',
      status: 'ready', source: 'agent-review', reason: 'Evidence reviewed', updatedAt: '2026-10-01T00:00:00.000Z',
      evidence: { acceptance: sealed.contract } } };
    const previous = await sql`SELECT summary, payload FROM harness_shared.work_items WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND feature_id = ${id}`;
    try {
      await sql`UPDATE harness_shared.work_items SET summary = ${source.summary}, payload = ${sql.json(JSON.parse(JSON.stringify(payload)))} WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND feature_id = ${id}`;
      const read = () => readWorkItemsPageFromStore(sql, workspaceId, buildWorkItemsPredicate(normalizeWorkItemsListArgs({ harnessSlug, filters: { id }, limit: 1 })));
      const accepted = (await read()).rows[0]!;
      expect(accepted.presentation).toMatchObject({ stage: 'accepted-blocked', evidenceRefs: ['WI-10004573'] });
      expect(accepted).not.toHaveProperty('payload');
      expect(accepted.summary).toBe('');
      await sql`UPDATE harness_shared.work_items SET summary = 'changed source' WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND feature_id = ${id}`;
      const stale = (await read()).rows[0]!;
      expect(stale.presentation).toMatchObject({ stage: 'candidate' });
      expect(stale.presentation?.reason).toContain('acceptance-revision-stale');
    } finally {
      await sql`UPDATE harness_shared.work_items SET summary = ${previous[0]!.summary}, payload = ${sql.json(previous[0]!.payload)} WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND feature_id = ${id}`;
    }
  });
  it('proves OR-within/AND-across parity, beyond-page reachability, exact zero, and cursor termination', async () => {
    const args: WorkItemsListWireArgs = {
      harnessSlug,
      filters: {
        kinds: ['bug', 'change'],
        states: ['open', 'blocked'],
        assignees: ['su-1', 'su-2'],
        severities: ['minor', 'major'],
        plans: ['plan-3', 'plan-4'],
        priorityMin: 2,
        priorityMax: 8,
        rankMin: 1,
        rankMax: 6,
      },
      limit: 500,
    };
    expect(matches(rowFor(DEEP), args)).toBe(true);
    await assertCompanionPredicateParity({
      corpus,
      pageCap: 500,
      args,
      zeroMatchArgs: { harnessSlug, q: 'no-such-p4-row' },
      beyondPageRowId: rowFor(DEEP).id,
      rowId: (row) => row.id,
      predicate: matches,
      facetBasePredicate: matchesFacetBase,
      facetDefs,
      selection,
      readPage: pageFor,
      readSummary: summaryFor,
    });
  }, 60_000);

  it('reproduces 31,133-vs-500 without substituting workspace or page counts', async () => {
    const args = { harnessSlug, limit: 500 } satisfies WorkItemsListWireArgs;
    const started = performance.now();
    const [page, summary] = await Promise.all([pageFor(args, null), summaryFor(args)]);
    const elapsedMs = performance.now() - started;
    expect(page.rows).toHaveLength(500);
    expect(page.hasMore).toBe(true);
    expect(summary).toMatchObject({ total: ROWS, matched: ROWS });
    expect(JSON.stringify(page.rows).length).toBeLessThan(512_000);
    expect(elapsedMs).toBeLessThan(LIST_READ_BUDGET_MS);
  }, 30_000);

  it('serves the PRODUCTION page statement newest-first from hfc_updated_idx, never a work_items seq scan', async () => {
    // P-013: EXPLAIN the statement readWorkItemsPageFromStore actually runs. A
    // hand-written query here once passed while the real one ordered by
    // COALESCE(updated_ts, 0), which no index serves, and seq-scanned the corpus.
    await sql`ANALYZE harness_shared.work_items`;
    for (const cursor of [null, encodeWorkItemsCursor({ updatedTs: BASE_TS - 600, id: rowFor(600).id })]) {
      const args = normalizeWorkItemsListArgs({ harnessSlug, limit: 500, cursor });
      const explained = await sql<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }[]>`
        EXPLAIN (FORMAT JSON) ${workItemsPageSql(sql, workspaceId, args)}`;
      const root = explained[0]?.['QUERY PLAN']?.[0]?.Plan;
      expect(root).toBeDefined();
      // Key selection lives in CTE `page`. Hydration joins ≤ page-size rows back
      // to work_items afterwards, and on this small fixture the planner may
      // legitimately hash-join that step, so the guard is scoped to the CTE.
      const pageCte = findPlanNode(root!, (node) => node['Subplan Name'] === 'CTE page');
      expect(pageCte, 'EXPLAIN must expose the page CTE subplan').toBeDefined();
      const keySelection = JSON.stringify(pageCte);
      expect(keySelection).toContain('"Index Name":"hfc_updated_idx"');
      // A leaf node's object closes before the next node, so `[^}]*` stays inside it.
      expect(keySelection).not.toMatch(/"Seq Scan"[^}]*"Relation Name":"work_items"/);
    }
  }, 30_000);

  it('keeps NULL updated_ts rows reachable, ordered as 0, across keyset pages', async () => {
    // updated_ts is nullable with no default; the page splits non-NULL and NULL
    // key branches for index use, so prove the merged order is still exactly
    // COALESCE(updated_ts, 0) DESC, id DESC and that paging reaches every row.
    const plan = `p013-null-ts-${token}`;
    const ids = { newest: `P4NULL-${token}-4`, zeroHigh: `P4NULL-${token}-3`, nullMid: `P4NULL-${token}-2`, nullLow: `P4NULL-${token}-1` };
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind,
         taken_by, payload, source_plan_slug, created_ts, updated_ts, origin)
      VALUES
        (${workspaceId}, ${harnessSlug}, ${ids.newest},   'null-ts newest', '', 'open', 'bug', 'su-0', '{}'::jsonb, ${plan}, 1, 5, 'local'),
        (${workspaceId}, ${harnessSlug}, ${ids.zeroHigh}, 'null-ts zero',   '', 'open', 'bug', 'su-0', '{}'::jsonb, ${plan}, 1, 0, 'local'),
        (${workspaceId}, ${harnessSlug}, ${ids.nullMid},  'null-ts null',   '', 'open', 'bug', 'su-0', '{}'::jsonb, ${plan}, 1, NULL, 'local'),
        (${workspaceId}, ${harnessSlug}, ${ids.nullLow},  'null-ts null',   '', 'open', 'bug', 'su-0', '{}'::jsonb, ${plan}, 1, NULL, 'local')`;
    try {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await readWorkItemsPageFromStore(sql, workspaceId, buildWorkItemsPredicate(
          normalizeWorkItemsListArgs({ harnessSlug, filters: { plans: [plan] }, limit: 1, cursor })));
        seen.push(...page.rows.map((row) => row.id));
        if (!page.hasMore) break;
        cursor = page.nextCursor;
      }
      // String ids order '-4' > '-3' > '-2' > '-1'; NULL and 0 tie on the sort key.
      expect(seen).toEqual([ids.newest, ids.zeroHigh, ids.nullMid, ids.nullLow]);
      const summary = await summaryFor({ harnessSlug, filters: { plans: [plan] } });
      expect(summary).toMatchObject({ matched: 4 });
    } finally {
      await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${workspaceId} AND source_plan_slug = ${plan}`;
    }
  }, 30_000);
});
