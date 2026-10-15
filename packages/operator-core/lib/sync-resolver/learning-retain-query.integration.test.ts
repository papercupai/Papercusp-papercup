// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { composeCompanionSummary } from '@papercusp/facets';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../test/_work-items-schema';
// Load registry dependencies before installing per-request seams; mocks below
// replace request-time PG access without hiding unrelated module exports.
import { resolveNamedQueryV2 } from './index';
import {
  normalizeRetainFeedArgs,
  readRetainExtras,
  readRetainFeed,
  readRetainSummaryAggregateRows,
  retainFeedSummarySelection,
  type RetainFeedDeps,
  type RetainFeedOpts,
} from './learning-retain-read';

// Half the fixtures are completed: keep more than 500 retained rows so a
// client-side search over a capped window would miss the deep completed match.
const ROWS = 1240;
const DEEP = 1222;
const workspaceId = 'p7-learning-retain-real-pg';
const harnessSlug = 'p7-retain-hive';
const deepId = `P7WI-${DEEP.toString().padStart(4, '0')}`;
const BASE_TS = 1_900_000_000_000;
let db: FreshPgDb;
let sql: Sql;

const deps: RetainFeedDeps = {
  listMemories: async () => [],
  listRubrics: async () => [],
  listRecipesPage: async () => [],
  countRecipes: async () => 0,
  summarizeRecipes: async () => ({ total: 0, matched: 0 }),
  listRunbooksPage: async () => [],
  countRunbooks: async () => 0,
  summarizeRunbooks: async () => ({ total: 0, matched: 0 }),
};

const scoped = (opts: RetainFeedOpts): RetainFeedOpts => ({
  ...opts,
  harnessScopes: [`harness:${harnessSlug}`],
});

beforeAll(async () => {
  db = await createFreshPgDb('learning-retain-query');
  sql = db.sql;
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await sql.unsafe(`
    CREATE TABLE harness_shared.scout_routed_ideas (
      idea_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      lens text NOT NULL,
      rail text NOT NULL,
      routed_ref text NOT NULL,
      title text,
      routed_at bigint NOT NULL
    )`);
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status,
       item_kind, payload, created_ts, updated_ts, origin)
    SELECT ${workspaceId},
           ${harnessSlug},
           'P7WI-' || lpad(g::text, 4, '0'),
           CASE WHEN g = ${DEEP} THEN 'deep-only-retain-match'
                ELSE 'ordinary retained work item ' || g END,
           '',
           CASE WHEN g % 2 = 0 THEN 'done' ELSE 'open' END,
           'bug',
           '{}',
           ${BASE_TS}::bigint - g,
           ${BASE_TS}::bigint - g,
           'local'
      FROM generate_series(1, ${ROWS}) AS g`;
  await sql`
    INSERT INTO harness_shared.scout_routed_ideas
      (idea_id, workspace_id, harness_slug, lens, rail, routed_ref, title, routed_at)
    SELECT 'p7-idea-' || lpad(g::text, 4, '0'),
           ${workspaceId},
           ${harnessSlug},
           CASE WHEN g % 3 = 0 THEN 'risk-first' ELSE 'user-value' END,
           'improvement',
           'wi:P7WI-' || lpad(g::text, 4, '0'),
           'idea ' || g,
           ${BASE_TS}::bigint - g
      FROM generate_series(1, ${ROWS}) AS g`;
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
  // EI-10571: cleanup closes this fixture's client, then DROP DATABASE ...
  // WITH (FORCE) runs against the shared reusable test container. PostgreSQL
  // may spend 6s-267s+ draining concurrent backends and deleting database files
  // on the fleet host, so the ordinary 60s Vitest hook budget produces a false
  // red after every assertion has passed. Keep cleanup strict, but give the
  // canonical teardown path the same 300s budget as the other real-PG suites.
}, 300_000);

describe('learning.retainFeed + summary — real Postgres P-007 contract', () => {
  it('finds the only match beyond the first 500 retained rows and returns exact scoped facets', async () => {
    const firstFiveHundred: string[] = [];
    let cursor: string | null = null;
    for (let pageNo = 0; pageNo < 5; pageNo += 1) {
      const page = await readRetainFeed(sql, workspaceId, deps, scoped({ tab: 'wi', limit: 100, cursor }));
      firstFiveHundred.push(...page.rows.map((row) => row.id));
      cursor = page.nextCursor;
    }
    expect(firstFiveHundred).toHaveLength(500);
    expect(firstFiveHundred).not.toContain(deepId);

    const opts = scoped({
      tab: 'wi',
      q: 'deep-only-retain-match',
      filters: { statuses: ['done'], lenses: ['user-value', 'risk-first'] },
      limit: 75,
    });
    const started = performance.now();
    const [page, aggregate] = await Promise.all([
      readRetainFeed(sql, workspaceId, deps, opts),
      readRetainSummaryAggregateRows(sql, workspaceId, deps, opts),
    ]);
    const normalized = normalizeRetainFeedArgs(opts);
    const summary = composeCompanionSummary(aggregate, {
      selection: retainFeedSummarySelection(normalized),
    });
    expect(page.rows.map((row) => row.id)).toEqual([deepId]);
    expect(summary).toMatchObject({ total: ROWS / 2, matched: 1 });
    expect(summary.total).toBeGreaterThan(500);
    expect(summary.facets.find((facet) => facet.key === 'status')?.values).toContainEqual(
      expect.objectContaining({ value: 'done', count: 1 }),
    );
    expect(performance.now() - started).toBeLessThan(6_000);
  });

  it('terminates an active-filter cursor without skipping or duplicating rows', async () => {
    const base = scoped({
      tab: 'wi',
      filters: { statuses: ['done'], lenses: ['risk-first'] },
      limit: 100,
    });
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let pageNo = 0; pageNo < 20; pageNo += 1) {
      const page = await readRetainFeed(sql, workspaceId, deps, { ...base, cursor });
      ids.push(...page.rows.map((row) => row.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    const expected = Array.from({ length: ROWS }, (_, index) => index + 1)
      .filter((g) => g % 2 === 0 && g % 3 === 0)
      .map((g) => `P7WI-${g.toString().padStart(4, '0')}`);
    expect(cursor).toBeNull();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice().sort()).toEqual(expected.sort());
  });
});

describe('learning.retain banked plans — migrated Postgres schema', () => {
  let orgDb: OrgTestDb;

  beforeAll(async () => {
    orgDb = await createOrgTestDb();
  }, 60_000);

  afterAll(async () => {
    await orgDb?.cleanup();
  }, 300_000);

  it.each(['mem0', 'hybrid-pg'])('provider-free canonical detail prerequisite on %s preserves the real migrated corpus', async choice => {
    await orgDb.adminSql.begin(async tx => {
      const scope = 'hive:retain-provider-free';
      const records = [
        { label: 'selected', payload: { data: 'old selected memory', user_id: scope }, state: 'active', expired: false },
        { label: 'newer', payload: { data: 'newer neighbor memory', user_id: scope }, state: 'active', expired: false },
        { label: 'foreign', payload: { data: 'other pool', user_id: scope + '-foreign' }, state: 'active', expired: false },
        { label: 'entity', payload: { data: 'entity fragment', entityType: 'person', user_id: scope }, state: 'active', expired: false },
        { label: 'archived', payload: { data: 'archived memory', user_id: scope }, state: 'archived', expired: false },
        { label: 'expired', payload: { data: 'expired memory', user_id: scope }, state: 'active', expired: true },
      ];
      const ids = new Map<string, string>();
      for (const record of records) {
        // Production generated columns are derived from base payload only.
        const [row] = await tx`
          INSERT INTO harness_shared.memory_canonical (payload, state, created_at, updated_at, invalid_at)
          VALUES (${tx.json(record.payload)}, ${record.state},
            now() - ${record.label === 'selected' ? '30 days' : '1 hour'}::interval,
            now() - ${record.label === 'selected' ? '30 days' : '1 hour'}::interval,
            ${record.expired ? tx`now() - interval '1 day'` : null})
          RETURNING id::text AS id, row_kind, user_id`;
        expect(row.row_kind).toBe(record.label === 'entity' ? 'entity' : 'memory');
        expect(row.user_id).toBe(record.payload.user_id);
        ids.set(record.label, row.id);
      }
      const backend = vi.fn(() => { throw new Error('provider client must not initialize for a canonical detail read'); });
      vi.doMock('../memory/backend-selection', () => ({ currentMemoryBackendChoice: () => choice }));
      vi.doMock('../memory/backend', () => ({ getMemoryBackend: backend }));
      vi.doMock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: tx }) }));
      vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'retain-provider-free-workspace' }));
      try {
        const detail = (id: string) => resolveNamedQueryV2('learning.retainDetail', {
          kind: 'memory', hive: 'retain-provider-free', id,
        });
        expect(await detail(ids.get('selected')!)).toEqual([expect.objectContaining({
          id: ids.get('selected'), body: 'old selected memory', fields: expect.arrayContaining([{ label: 'Pool', value: scope }]),
        })]);
        expect(await detail(ids.get('newer')!)).toEqual([expect.objectContaining({ body: 'newer neighbor memory' })]);
        for (const label of ['foreign', 'entity', 'archived', 'expired']) expect(await detail(ids.get(label)!)).toEqual([]);
        expect(await detail('not-a-uuid')).toEqual([]);
        expect(backend).not.toHaveBeenCalled();
      } finally {
        for (const module of ['../memory/backend-selection', '../memory/backend', '@papercusp/db-org', '../workspace-registry']) vi.doUnmock(module);
      }
    });
  });

  it('counts typed creation timestamps within seven days and preserves workspace/member scope', async () => {
    // The transaction freezes now() so the exact seven-day boundary is deterministic.
    await orgDb.adminSql.begin(async (tx) => {
      const rows = [
        ['recent', 'retain-banked', 'alpha', 'not a timestamp', '-1 hour'],
        ['inside', 'retain-banked', 'alpha', '1900-01-01', '-7 days +1 microsecond'],
        ['boundary', 'retain-banked', 'alpha', '2099-01-01', '-7 days'],
        ['outside', 'retain-banked', 'alpha', '2099-01-01', '-7 days -1 microsecond'],
        ['old', 'retain-banked', 'alpha', '2099-01-01', '-8 days'],
        ['other-member', 'retain-banked', 'beta', '1900-01-01', '-1 hour'],
        ['other-workspace', 'retain-other', 'alpha', '1900-01-01', '-1 hour'],
      ];
      for (const [slug, workspace, harness, legacyCreated, age] of rows) {
        await tx`
          INSERT INTO harness_shared.harness_plans
            (workspace_id, harness_slug, plan_slug, content, content_hash, title,
             status, created, updated, owner, created_at)
          VALUES (${workspace}, ${harness}, ${slug}, '', md5(${slug}), ${slug},
                  'draft', ${legacyCreated}, ${legacyCreated}, 'retain-test',
                  now() + ${age}::interval)`;
      }

      const columns = await tx`
        SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'harness_shared' AND table_name = 'harness_plans'
           AND column_name IN ('created', 'created_at')`;
      expect(columns).toEqual(expect.arrayContaining([
        { column_name: 'created', data_type: 'text' },
        { column_name: 'created_at', data_type: 'timestamp with time zone' },
      ]));

      const read = (workspace: string, memberSlugs?: string[]) =>
        readRetainExtras(tx as unknown as Sql, workspace,
          { readLensWeights: async () => ({}) }, { memberSlugs });
      expect((await read('retain-banked')).banked.plansDrafted7d).toBe(3);
      expect((await read('retain-banked', ['alpha'])).banked.plansDrafted7d).toBe(2);
      expect((await read('retain-banked', ['beta'])).banked.plansDrafted7d).toBe(1);
      expect((await read('retain-banked', ['alpha', 'beta'])).banked.plansDrafted7d).toBe(3);
      expect((await read('retain-banked', [])).banked.plansDrafted7d).toBe(0);
      expect((await read('retain-banked', ['missing'])).banked.plansDrafted7d).toBe(0);
      expect((await read('retain-other', ['alpha'])).banked.plansDrafted7d).toBe(1);
    });
  });
});
