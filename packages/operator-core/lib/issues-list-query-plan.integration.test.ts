/**
 * issues-list-query-plan.integration.test.ts — the limited issue-family list must be
 * served by an index-ordered scan, not a full scan + sort
 * (plan papercusp-performance-audit-2026-10-12, P-004 / spec PERF-P004-PLAN).
 *
 * WHY. listIssuesWithLimit ends with `ORDER BY created_at DESC LIMIT n` over the
 * engineer_issues view, whose created_at is an expression over work_items.created_ts.
 * Before migration 1476 nothing indexed that expression, so every call scanned every
 * work_items row and top-N sorted the issue family: measured on the live box
 * 2026-10-12 at 1,023 ms mean over 132,492 calls (588,900 buffers per call), versus
 * 7.3 ms / 3,536 buffers with the index.
 *
 * HOW. The test captures the EXACT statement listIssues sends (postgres.js `debug`
 * hook, with its bound parameters) and EXPLAINs that statement, so it pins the real
 * code path rather than a hand-copied query. It then drops the index and asserts the
 * full sort comes back: the guard is proven falsifiable inside the test itself.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { applyClaimPathReadDeps, HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dirname, '../../../libs/papercusp/libs/db/sql/1476-work-items-issue-created-at-idx.sql');
const INDEX = 'work_items_issue_created_at_idx';
const WS = 'p004-list-plan-ws';
const ISSUE_ROWS = 20_000;

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const issues = await import('./issues-engineer');

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Actual Loops'?: number;
  Filter?: string;
  'Join Filter'?: string;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

let db: FreshPgDb;
let traced: postgres.Sql;
let savedWsEnv: string | undefined;
const captured: { query: string; params: unknown[] }[] = [];

/** Run listIssues once and EXPLAIN the exact statement it sent. */
async function planOfListIssues(): Promise<{ rows: Awaited<ReturnType<typeof issues.listIssues>>; nodes: PlanNode[] }> {
  captured.length = 0;
  const rows = await issues.listIssues({ limit: 300, kinds: ['bug', 'change', 'task'] });
  const listQuery = captured.find((c) => /FROM harness_shared\.engineer_issues/.test(c.query) && /ORDER BY created_at DESC/.test(c.query));
  expect(listQuery, 'listIssues sent no ORDER BY created_at DESC statement over engineer_issues').toBeDefined();
  const explained = await db.sql.unsafe(`EXPLAIN (FORMAT JSON) ${listQuery!.query}`, listQuery!.params as never[]);
  const plan = (explained[0] as Record<string, unknown>)['QUERY PLAN'] as { Plan: PlanNode }[];
  return { rows, nodes: flatten(plan[0]!.Plan) };
}

/** Capture the complete metric-source statement, which must not sort the full issue population. */
async function completeMetricQuery(): Promise<{ rows: Awaited<ReturnType<typeof issues.listAllIssuesForFileExport>>; query: string }> {
  captured.length = 0;
  const rows = await issues.listAllIssuesForFileExport({
    kinds: ['bug', 'change', 'task'],
    payloadProjection: 'fleetMetricsCensus',
  });
  const query = captured.find((c) => /FROM harness_shared\.engineer_issues/.test(c.query))?.query;
  expect(query, 'complete metric source sent no statement over engineer_issues').toBeDefined();
  return { rows, query: query! };
}

beforeAll(async () => {
  savedWsEnv = process.env.PAPERCUSP_WORKSPACE_ID;
  process.env.PAPERCUSP_WORKSPACE_ID = WS;
  db = await createFreshPgDb('issues-list-plan');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS assignee_rank integer,
      ADD COLUMN IF NOT EXISTS rank_writer text,
      ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz`);
  // The real migration file, so the test proves the shipped DDL, not a copy of it.
  await db.sql.unsafe(readFileSync(MIGRATION, 'utf8'));

  // Issue-family rows in ascending created order (as production inserts them), wide
  // enough that a full scan is genuinely expensive, plus non-issue rows and a second
  // workspace that the index must skip.
  await db.sql.unsafe(`
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, status, title, summary, created_ts, updated_ts, payload)
    SELECT '${WS}', 'operator:${WS}', 'EI-' || g, (ARRAY['bug','change','task'])[1 + g % 3], 'open',
           'issue ' || g, repeat('x', 600), 1760000000000 + g * 1000, 1760000000000 + g * 1000, '{}'::jsonb
      FROM generate_series(1, ${ISSUE_ROWS}) g;
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, status, title, created_ts, updated_ts)
    SELECT '${WS}', 'p004', 'F-' || g, 'feature', 'todo', 'feature ' || g, 1760000000000 + g * 1000, 1760000000000 + g * 1000
      FROM generate_series(1, 2000) g;
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, status, title, created_ts, updated_ts, payload)
    SELECT 'other-ws', 'operator:other-ws', 'EI-' || g, 'bug', 'open', 'other ' || g, 1790000000000 + g, 1790000000000 + g, '{}'::jsonb
      FROM generate_series(1, 2000) g;
    ANALYZE harness_shared.work_items;`).simple();

  traced = postgres(db.url, {
    max: 2,
    prepare: false,
    onnotice: () => {},
    debug: (_connection, query, params) => {
      captured.push({ query, params: params as unknown[] });
    },
  });
  h.sql = traced;
}, 120_000);

afterAll(async () => {
  await traced?.end({ timeout: 5 });
  await db?.cleanup();
  if (savedWsEnv === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = savedWsEnv;
});

describe('issue-family list query plan (P-004)', () => {
  it('reads the newest 300 issues through the created_at index with no Sort node', async () => {
    const { rows, nodes } = await planOfListIssues();

    expect(rows).toHaveLength(300);
    expect(rows[0]!.id).toBe(`EI-${ISSUE_ROWS}`);
    expect(rows[299]!.id).toBe(`EI-${ISSUE_ROWS - 299}`);

    const types = nodes.map((n) => n['Node Type']);
    expect(types).toContain('Limit');
    expect(nodes.some((n) => n['Index Name'] === INDEX), `plan did not use ${INDEX}: ${types.join(' > ')}`).toBe(true);
    expect(types, 'a Sort node means the read is sorting the whole issue family again').not.toContain('Sort');
    expect(types).not.toContain('Incremental Sort');
  });

  it('falls back to a full sort without the index (the guard can fail)', async () => {
    await db.sql.unsafe(`DROP INDEX harness_shared.${INDEX}`);
    try {
      const { nodes } = await planOfListIssues();
      expect(nodes.some((n) => n['Index Name'] === INDEX)).toBe(false);
      expect(nodes.map((n) => n['Node Type'])).toContain('Sort');
    } finally {
      await db.sql.unsafe(readFileSync(MIGRATION, 'utf8'));
    }
  });

  it('does not sort the complete fleetMetricsCensus source population', async () => {
    const { rows, query } = await completeMetricQuery();

    expect(rows).toHaveLength(ISSUE_ROWS);
    expect(query).not.toMatch(/ORDER BY created_at DESC/);
  });

  it('evaluates a server-side identity filter once before hydrating matching issue rows', async () => {
    captured.length = 0;
    const excludedWords = '(p2p|shared-hive|federation|replication|swarm|hyperbee|relay)';
    const identities = traced`
      SELECT wi.feature_id
        FROM harness_shared.work_items wi
       WHERE wi.workspace_id = ${WS}
         AND wi.harness_slug = ${`operator:${WS}`}
         AND wi.item_kind = 'bug'
         AND NOT COALESCE(
           wi.title::text ~* ${`(^|[^A-Za-z0-9])${excludedWords}([^A-Za-z0-9]|$)`}
           OR wi.summary::text ~* ${`(^|[^A-Za-z0-9])${excludedWords}([^A-Za-z0-9]|$)`},
           false
         )`;
    const rows = await issues.listAllIssuesForFileExport({
      kind: 'bug',
      issueIds: identities,
      includeBody: false,
      includePayload: false,
    });
    expect(rows).toHaveLength(Math.floor(ISSUE_ROWS / 3));

    const query = captured.find((entry) => /FROM harness_shared\.engineer_issues/.test(entry.query));
    expect(query, 'complete issue read sent no statement over engineer_issues').toBeDefined();
    const explained = await db.sql.unsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query!.query}`,
      query!.params as never[],
    );
    const plan = (explained[0] as Record<string, unknown>)['QUERY PLAN'] as { Plan: PlanNode }[];
    const nodes = flatten(plan[0]!.Plan);
    const predicateNodes = nodes.filter((node) =>
      `${node.Filter ?? ''} ${node['Join Filter'] ?? ''}`.includes('~*'));
    expect(predicateNodes, 'the plan must expose the claim-spec word predicate').not.toHaveLength(0);
    expect(
      Math.max(...predicateNodes.map((node) => node['Actual Loops'] ?? Number.POSITIVE_INFINITY)),
      'word predicates must be evaluated in the bounded identity scan, not once per hydrated row',
    ).toBeLessThanOrEqual(8);
  });
});
