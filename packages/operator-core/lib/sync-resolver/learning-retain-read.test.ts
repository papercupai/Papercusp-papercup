/**
 * learning-retain-read tests (WI-5412 → WI-39493 Variant D) — the unified
 * Retained-ledger feed (keyset windows, k-way merge, server-side shipped
 * classification), the slim extras strip, and the insight-doc fs legs.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeCompanionSummary } from '@papercusp/facets';
import {
  buildRetainFeedPredicate,
  countCanonicalRetainMemories,
  countInsightDocs,
  listCanonicalRetainMemoriesPage,
  matchesRetainFeedPredicate,
  normalizeRetainFeedArgs,
  parseInsightFrontmatter,
  readInsightDocsPage,
  readRetainDetail,
  readRetainExtras,
  readRetainFeed,
  readRetainPlanChildren,
  retainFeedKindsForArgs,
  readRetainSummaryAggregateRows,
  RETAIN_FEED_PAGE_SIZE,
  retainFeedSummarySelection,
  retainMemoryTitle,
  retainMemoryTsOf,
  stripFrontmatter,
  type RetainDetailDeps,
  type RetainExtrasDeps,
  type RetainFeedDeps,
} from './learning-retain-read';
import {
  compareRetainRows,
  decodeRetainCursor,
  encodeRetainCursor,
  inRetainLegWindow,
  retainLegWindowFor,
} from './learning-retain-types';

/** A postgres-tag stub: every sql`…` call resolves via the injected handler.
 *  Nested fragments (filter/window predicates) surface as VALUES, so routing
 *  keys on the STATIC template text only. */
function sqlStub(handler: (text: string, values: unknown[]) => unknown[]): never {
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) =>
    Promise.resolve(handler(strings.join('?'), values));
  return fn as never;
}

const isPlanLeg = (t: string) => t.includes('DISTINCT ON (hp.plan_slug)');
const isWiLeg = (t: string) => t.includes('DISTINCT ON (ei.issue_id)');
const isPlanCount = (t: string) => t.includes('count(DISTINCT hp.plan_slug)');
const isWiCount = (t: string) => t.includes('count(DISTINCT ei.issue_id)');

const extrasDeps: RetainExtrasDeps = {
  readLensWeights: async () => ({ analogical: 2, reframing: 1 }),
};

describe('readRetainExtras (slim strip: banked + lens weights)', () => {
  it('returns the banked counts and lens weights on the happy path', async () => {
    const sql = sqlStub(() => [{ n: 3 }]);
    const snap = await readRetainExtras(sql, 'ws-1', extrasDeps);
    expect(snap.banked).toEqual({ improvementsFiled7d: 3, plansDrafted7d: 3 });
    expect(snap.lensWeights).toEqual({ analogical: 2, reframing: 1 });
  });

  it('degrades each failing leg independently — never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = sqlStub(() => {
      throw new Error('pg down');
    });
    const snap = await readRetainExtras(sql, 'ws-1', {
      readLensWeights: async () => {
        throw new Error('weights down');
      },
    });
    expect(snap.banked).toEqual({ improvementsFiled7d: null, plansDrafted7d: null });
    expect(snap.lensWeights).toBeNull();
    warn.mockRestore();
  });

  it('empty lens weights read as null (none recorded), not {}', async () => {
    const sql = sqlStub(() => [{ n: 0 }]);
    const snap = await readRetainExtras(sql, 'ws-1', { readLensWeights: async () => ({}) });
    expect(snap.lensWeights).toBeNull();
  });
});

describe('parseInsightFrontmatter', () => {
  it('extracts title + discovered', () => {
    const doc = parseInsightFrontmatter(
      'my-doc',
      '---\ntitle: The runbook title\ndescription: x\ndiscovered: 2026-06-14\n---\nbody',
    );
    expect(doc).toEqual({ slug: 'my-doc', title: 'The runbook title', discovered: '2026-06-14' });
  });

  it('falls back to the slug on a missing title, null on a missing date', () => {
    expect(parseInsightFrontmatter('slug-x', '---\nstatus: active\n---')).toEqual({
      slug: 'slug-x',
      title: 'slug-x',
      discovered: null,
    });
  });
});

// ─── Feed machinery: cursor + windows + comparator ───────────────────────────

describe('retain cursor + leg windows', () => {
  const cursor = { ts: '2026-08-15T12:00:00.000Z', kind: 'rubric' as const, id: 'r-mid' };

  it('cursor round-trips and rejects garbage', () => {
    expect(decodeRetainCursor(encodeRetainCursor(cursor))).toEqual(cursor);
    expect(decodeRetainCursor('not json')).toBeNull();
    expect(decodeRetainCursor(JSON.stringify({ ts: 1, kind: 'plan', id: 'x' }))).toBeNull();
    expect(decodeRetainCursor(JSON.stringify({ ts: 't', kind: 'nope', id: 'x' }))).toBeNull();
    expect(decodeRetainCursor(null)).toBeNull();
  });

  it('windows depend on the leg kind relative to the cursor kind (kind ASC at equal ts)', () => {
    // 'plan' < 'rubric': all its rows at the cursor ts were already emitted.
    expect(retainLegWindowFor('plan', cursor)).toEqual({
      beforeTs: cursor.ts,
      includeTies: false,
      tieIdAfter: null,
    });
    // 'runbook' > 'rubric': its rows AT the cursor ts are still to come.
    expect(retainLegWindowFor('runbook', cursor)).toEqual({
      beforeTs: cursor.ts,
      includeTies: true,
      tieIdAfter: null,
    });
    // same kind: ties resolved by id.
    expect(retainLegWindowFor('rubric', cursor)).toEqual({
      beforeTs: cursor.ts,
      includeTies: false,
      tieIdAfter: 'r-mid',
    });
    expect(retainLegWindowFor('plan', null)).toBeNull();
  });

  it('inRetainLegWindow evaluates the three window shapes', () => {
    const t0 = '2026-08-15T12:00:00.000Z';
    const earlier = '2026-08-15T11:59:59.999Z';
    const later = '2026-08-15T12:00:00.001Z';
    const strict = { beforeTs: t0, includeTies: false, tieIdAfter: null };
    const ties = { beforeTs: t0, includeTies: true, tieIdAfter: null };
    const sameKind = { beforeTs: t0, includeTies: false, tieIdAfter: 'm' };
    expect(inRetainLegWindow(earlier, 'a', strict)).toBe(true);
    expect(inRetainLegWindow(t0, 'a', strict)).toBe(false);
    expect(inRetainLegWindow(t0, 'a', ties)).toBe(true);
    expect(inRetainLegWindow(later, 'a', ties)).toBe(false);
    expect(inRetainLegWindow(t0, 'z', sameKind)).toBe(true);
    expect(inRetainLegWindow(t0, 'a', sameKind)).toBe(false);
    expect(inRetainLegWindow(later, 'z', null)).toBe(true);
  });

  it('compareRetainRows orders ts DESC, then kind ASC, then id ASC', () => {
    const rows = [
      { ts: '2026-08-14T00:00:00.000Z', kind: 'plan' as const, id: 'a' },
      { ts: '2026-08-15T00:00:00.000Z', kind: 'wi' as const, id: 'b' },
      { ts: '2026-08-15T00:00:00.000Z', kind: 'plan' as const, id: 'z' },
      { ts: '2026-08-15T00:00:00.000Z', kind: 'plan' as const, id: 'a' },
    ];
    const sorted = rows.slice().sort(compareRetainRows);
    expect(sorted.map((r) => `${r.kind}:${r.id}`)).toEqual(['plan:a', 'plan:z', 'wi:b', 'plan:a']);
  });
});

describe('Retain paired predicate contract (P-007)', () => {
  const depsBase = (): RetainFeedDeps => ({
    listMemories: async () => [],
    listRubrics: async () => [],
    listRecipesPage: async () => [],
    countRecipes: async () => 0,
    summarizeRecipes: async () => ({ total: 0, matched: 0 }),
    listRunbooksPage: async () => [],
    countRunbooks: async () => 0,
    summarizeRunbooks: async () => ({ total: 0, matched: 0 }),
  });
  const row = (id: string, title: string, status: string | null, lens?: string) => ({
    kind: 'rubric' as const,
    id,
    title,
    ts: '2026-08-15T00:00:00.000Z',
    status,
    shipped: false,
    meta: { ...(lens ? { lens } : {}) },
  });

  it('normalizes once and applies OR within status/lens, AND across dimensions', () => {
    const args = normalizeRetainFeedArgs({
      q: '  target  ',
      filters: {
        title: '  migration ',
        statuses: ['active', 'draft', 'active', ''],
        lenses: ['risk-first', 'user-value', 'risk-first'],
      },
    });
    expect(args).toMatchObject({
      q: 'target',
      filters: {
        title: 'migration',
        statuses: ['active', 'draft'],
        lenses: ['risk-first', 'user-value'],
      },
    });
    const predicate = buildRetainFeedPredicate(args);
    expect(matchesRetainFeedPredicate(row('r-target', 'Target migration', 'draft', 'user-value'), predicate)).toBe(
      true,
    );
    expect(matchesRetainFeedPredicate(row('r-target', 'Target migration', 'closed', 'user-value'), predicate)).toBe(
      false,
    );
    expect(matchesRetainFeedPredicate(row('r-target', 'Target migration', 'active', 'analogical'), predicate)).toBe(
      false,
    );
  });

  it('finds filtered rubric matches beyond page one and keyset pages neither skip nor duplicate', async () => {
    const rubrics = Array.from({ length: 150 }, (_, index) => ({
      slug: `r-${index.toString().padStart(3, '0')}`,
      title: index % 37 === 0 ? `Needle rubric ${index}` : `Ordinary rubric ${index}`,
      status: index % 2 === 0 ? 'active' : 'draft',
      updatedAt: new Date(Date.UTC(2026, 7, 20) - index * 1000).toISOString(),
    }));
    const deps = { ...depsBase(), listRubrics: async () => rubrics };
    const opts = {
      tab: 'rubrics' as const,
      q: 'needle',
      filters: { statuses: ['active', 'draft'] },
      limit: 2,
    };
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let pageNo = 0; pageNo < 10; pageNo += 1) {
      const page = await readRetainFeed(
        sqlStub(() => []),
        'ws-1',
        deps,
        {
          ...opts,
          cursor,
        },
      );
      ids.push(...page.rows.map((item) => item.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(ids).toContain('r-148');
    expect(new Set(ids).size).toBe(ids.length);
    expect(cursor).toBeNull();
  });

  it('returns exact selected-tab totals, drill-down status counts, and a zero-match selected facet', async () => {
    const rubrics = [
      { slug: 'r-a', title: 'Target A', status: 'active', updatedAt: '2026-08-16T00:00:00.000Z' },
      { slug: 'r-b', title: 'Target B', status: 'draft', updatedAt: '2026-08-15T00:00:00.000Z' },
      { slug: 'r-c', title: 'Other', status: 'active', updatedAt: '2026-08-14T00:00:00.000Z' },
    ];
    const deps = { ...depsBase(), listRubrics: async () => rubrics };
    const wire = { tab: 'rubrics' as const, q: 'no-such-row', filters: { statuses: ['active'] } };
    const normalized = normalizeRetainFeedArgs(wire);
    const aggregate = await readRetainSummaryAggregateRows(
      sqlStub(() => []),
      'ws-1',
      deps,
      wire,
    );
    const summary = composeCompanionSummary(aggregate, {
      selection: retainFeedSummarySelection(normalized),
    });
    expect(summary).toMatchObject({ total: 3, matched: 0 });
    expect(summary.facets.find((facet) => facet.key === 'status')?.values).toContainEqual({
      value: 'active',
      count: 0,
    });
  });
});

describe('canonical Retain memory reads', () => {
  it('uses the shared current-memory/scope predicate, keyset window, and maps canonical activity into metadata', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = sqlStub((text, values) => {
      calls.push({ text, values });
      if (text.includes('SELECT x.id, x.payload, x.ts')) {
        return [
          {
            id: 'm-z',
            payload: {
              data: 'Canonical fact',
              user_id: 'hive:pot-a',
              kind: 'feedback',
              created_by: 'owner',
            },
            ts: '2026-08-14T12:34:56.789Z',
          },
        ];
      }
      return [];
    });
    const window = {
      beforeTs: '2026-08-15T00:00:00.000Z',
      includeTies: false,
      tieIdAfter: 'm-mid',
    };

    const rows = await listCanonicalRetainMemoriesPage(sql, ['hive:pot-a'], { window, limit: 75 });

    expect(rows).toEqual([
      {
        id: 'm-z',
        text: 'Canonical fact',
        scope: 'hive:pot-a',
        kind: 'feedback',
        metadata: {
          kind: 'feedback',
          created_by: 'owner',
          updated_at: '2026-08-14T12:34:56.789Z',
        },
      },
    ]);
    const renderedSql = calls.map((call) => call.text).join('\n');
    expect(renderedSql).toContain("m.row_kind = 'memory'");
    expect(renderedSql).toContain("m.state <> 'archived'");
    expect(renderedSql).toContain('m.invalid_at IS NULL OR m.invalid_at > now()');
    expect(renderedSql).toContain('m.user_id = ANY(');
    expect(renderedSql).toContain('x.id COLLATE "C" >');
    expect(calls.flatMap((call) => call.values)).toContain(window.beforeTs);
    expect(calls.flatMap((call) => call.values)).toContain(window.tieIdAfter);
  });

  it('counts the exact matching corpus independently of the bounded page', async () => {
    const sql = sqlStub((text) => (text.includes('count(*)::int AS n') ? [{ n: '58' }] : []));
    await expect(countCanonicalRetainMemories(sql, ['hive:pot-a'])).resolves.toBe(58);
  });
});

// ─── The unified feed ────────────────────────────────────────────────────────

const emptyFeedDeps = (): RetainFeedDeps => ({
  listMemories: async () => [],
  listRubrics: async () => [],
  listRecipesPage: async () => [],
  countRecipes: async () => 0,
  summarizeRecipes: async () => ({ total: 0, matched: 0 }),
  listRunbooksPage: async () => [],
  countRunbooks: async () => 0,
  summarizeRunbooks: async () => ({ total: 0, matched: 0 }),
});

const planRow = (slug: string, ts: string, over: Record<string, unknown> = {}) => ({
  id: slug,
  title: `Plan ${slug}`,
  status: 'ready',
  ts,
  idea_id: `idea-${slug}`,
  idea_title: `idea for ${slug}`,
  lens: 'reframing',
  child_total: 3,
  child_done: 2,
  ...over,
});

const wiRow = (id: string, ts: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `WI ${id}`,
  status: 'done',
  shipped: true,
  ts,
  idea_id: `idea-${id}`,
  idea_title: null,
  lens: 'constraint-removal',
  ...over,
});

describe('readRetainFeed', () => {
  it('interleaves every kind by recent activity, newest first', async () => {
    const sql = sqlStub((t) => {
      if (isPlanLeg(t)) return [planRow('p1', '2026-08-15T10:00:00.000Z')];
      if (isWiLeg(t)) return [wiRow('EI-1', '2026-08-16T09:00:00.000Z')];
      return [{ n: 0 }];
    });
    const deps: RetainFeedDeps = {
      ...emptyFeedDeps(),
      listRubrics: async () => [
        { slug: 'r1', title: 'Rubric', status: 'active', updatedAt: '2026-08-16T08:00:00.000Z' },
      ],
      listRunbooksPage: async () => [
        { slug: 'd1', title: 'Doc', discovered: '2026-08-14', ts: '2026-08-14T12:00:00.000Z' },
      ],
      listRecipesPage: async () => [{ id: 'rec1', title: 'Recipe', runCount: 4, ts: '2026-08-16T11:00:00.000Z' }],
    };
    const page = await readRetainFeed(sql, 'ws-1', deps);
    expect(page.rows.map((r) => `${r.kind}:${r.id}`)).toEqual([
      'recipe:rec1',
      'wi:EI-1',
      'rubric:r1',
      'plan:p1',
      'runbook:d1',
    ]);
    expect(page.degraded).toEqual([]);
    // 5 candidates < default page size → exhausted.
    expect(page.nextCursor).toBeNull();
  });

  it('pages with a composite cursor: full page ⇒ nextCursor at the last row, and the next page resumes after it', async () => {
    const rubrics = Array.from({ length: 6 }, (_, i) => ({
      slug: `r-${String(i).padStart(2, '0')}`,
      title: `Rubric ${i}`,
      status: 'active',
      updatedAt: `2026-08-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`,
    }));
    const deps: RetainFeedDeps = { ...emptyFeedDeps(), listRubrics: async () => rubrics };
    const sql = sqlStub(() => [{ n: 0 }]);
    const page1 = await readRetainFeed(sql, 'ws-1', deps, { tab: 'rubrics', limit: 4 });
    expect(page1.rows).toHaveLength(4);
    expect(page1.rows[0]!.id).toBe('r-05');
    expect(page1.nextCursor).not.toBeNull();
    const c = decodeRetainCursor(page1.nextCursor)!;
    expect(c).toEqual({ ts: '2026-08-12T00:00:00.000Z', kind: 'rubric', id: 'r-02' });
    const page2 = await readRetainFeed(sql, 'ws-1', deps, { tab: 'rubrics', limit: 4, cursor: page1.nextCursor });
    expect(page2.rows.map((r) => r.id)).toEqual(['r-01', 'r-00']);
    expect(page2.nextCursor).toBeNull();
    // Paging never re-emits and never skips: the two pages partition the corpus.
    const all = [...page1.rows, ...page2.rows].map((r) => r.id);
    expect(new Set(all).size).toBe(6);
  });

  it('a full-page tie at one timestamp still advances via the id tiebreak', async () => {
    const ts = '2026-08-15T00:00:00.000Z';
    const rubrics = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
      slug: id,
      title: id,
      status: 'active',
      updatedAt: ts,
    }));
    const deps: RetainFeedDeps = { ...emptyFeedDeps(), listRubrics: async () => rubrics };
    const sql = sqlStub(() => [{ n: 0 }]);
    const page1 = await readRetainFeed(sql, 'ws-1', deps, { tab: 'rubrics', limit: 2 });
    expect(page1.rows.map((r) => r.id)).toEqual(['a', 'b']);
    const page2 = await readRetainFeed(sql, 'ws-1', deps, { tab: 'rubrics', limit: 2, cursor: page1.nextCursor });
    expect(page2.rows.map((r) => r.id)).toEqual(['c', 'd']);
  });

  it('counts ride the FIRST page only, filter-independent corpus sizes', async () => {
    const sql = sqlStub((t) => {
      if (isPlanCount(t)) return [{ n: 21 }];
      if (isWiCount(t)) return [{ n: 991 }];
      return [];
    });
    const deps: RetainFeedDeps = {
      ...emptyFeedDeps(),
      listRubrics: async () => [{ slug: 'r1', title: 'R', status: 'active', updatedAt: '2026-08-01T00:00:00.000Z' }],
      countRunbooks: async () => 512,
      countRecipes: async () => 13561,
    };
    const page1 = await readRetainFeed(sql, 'ws-1', deps, { withCounts: true });
    expect(page1.counts).toEqual({ memories: 0, plans: 21, wi: 991, rubrics: 1, runbooks: 512, recipes: 13561 });
    const page2 = await readRetainFeed(sql, 'ws-1', deps, {
      withCounts: true,
      cursor: encodeRetainCursor({ ts: '2026-08-01T00:00:00.000Z', kind: 'rubric', id: 'r1' }),
    });
    expect(page2.counts).toBeNull();
  });

  it('counts are OFF the page by DEFAULT — their own read now (learning.retainCounts, WI-39900)', async () => {
    const sql = sqlStub((t) => {
      if (isPlanCount(t) || isWiCount(t)) throw new Error('counts must not run un-opted-in');
      return [];
    });
    const page = await readRetainFeed(sql, 'ws-1', emptyFeedDeps());
    expect(page.counts).toBeNull();
  });

  it('a failing count degrades to null — never 0 (a bounded read must not read as an empty corpus)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = sqlStub((t) => {
      if (isPlanCount(t)) throw new Error('pg down');
      if (isWiCount(t)) return [{ n: 5 }];
      return [];
    });
    const page = await readRetainFeed(sql, 'ws-1', emptyFeedDeps(), { withCounts: true });
    expect(page.counts).toEqual({ memories: 0, plans: null, wi: 5, rubrics: 0, runbooks: 0, recipes: 0 });
    warn.mockRestore();
  });

  it('tab narrows to one leg; a cursored single-kind page touches no other store', async () => {
    const deps = emptyFeedDeps();
    const listRubrics = vi.fn(deps.listRubrics);
    const listRunbooksPage = vi.fn(deps.listRunbooksPage);
    const listRecipesPage = vi.fn(async () => [
      { id: 'rec1', title: 'Recipe', runCount: 1, ts: '2026-08-10T00:00:00.000Z' },
    ]);
    const sqlCalls: string[] = [];
    const sql = sqlStub((t) => {
      sqlCalls.push(t);
      return [];
    });
    const page = await readRetainFeed(
      sql,
      'ws-1',
      { ...deps, listRubrics, listRunbooksPage, listRecipesPage },
      { tab: 'recipes', cursor: encodeRetainCursor({ ts: '2026-08-11T00:00:00.000Z', kind: 'recipe', id: 'x' }) },
    );
    expect(page.rows.map((r) => r.kind)).toEqual(['recipe']);
    expect(listRubrics).not.toHaveBeenCalled();
    expect(listRunbooksPage).not.toHaveBeenCalled();
    expect(sqlCalls).toEqual([]); // no plan/wi legs, no counts past page 1
  });

  it('the recipe leg receives the cursor as its keyset window', async () => {
    const listRecipesPage = vi.fn(async () => []);
    const sql = sqlStub(() => []);
    const cursor = { ts: '2026-08-11T00:00:00.000Z', kind: 'recipe' as const, id: 'rec-mid' };
    await readRetainFeed(
      sql,
      'ws-1',
      { ...emptyFeedDeps(), listRecipesPage },
      { tab: 'recipes', cursor: encodeRetainCursor(cursor) },
    );
    expect(listRecipesPage).toHaveBeenCalledWith({
      window: { beforeTs: cursor.ts, includeTies: false, tieIdAfter: 'rec-mid' },
      // Pin the CONSTANT, not its value: the page size is a measured product decision
      // (24→75 in WI-39675) and this assertion is about the cursor window plumbing,
      // not the size itself. A literal here strands this test on every size change.
      limit: RETAIN_FEED_PAGE_SIZE,
    });
  });

  // D-001 (learning-tab-improve-retain-clarity-2026-08-28). The shipped-only
  // rule is a per-leg PREDICATE on the two statusful kinds, never a narrowing
  // of the kind set. This test replaces one that pinned the opposite —
  // "a non-all filter narrows the feed to statusful kinds (plan, wi)" — which
  // described the removed Shipped ∕ In-flight filter. That narrowing is
  // precisely why the filter emptied four of the six tabs and had to be
  // disabled on them (WI-39900); pinning its ABSENCE is what stops the
  // behaviour returning.
  it('the shipped-only rule does NOT drop statusless kinds — the all tab still reads runbooks and recipes', async () => {
    const deps = emptyFeedDeps();
    const listRunbooksPage = vi.fn(deps.listRunbooksPage);
    const listRecipesPage = vi.fn(deps.listRecipesPage);
    const sql = sqlStub((t) => {
      if (isPlanLeg(t)) return [planRow('p1', '2026-08-15T00:00:00.000Z', { status: 'shipped' })];
      if (isWiLeg(t)) return [wiRow('EI-1', '2026-08-16T00:00:00.000Z')];
      return [{ n: 0 }];
    });
    await readRetainFeed(sql, 'ws-1', { ...deps, listRunbooksPage, listRecipesPage }, { tab: 'all' });
    expect(listRunbooksPage).toHaveBeenCalled();
    expect(listRecipesPage).toHaveBeenCalled();
  });

  it('every kind survives kind selection — the outcome rule never narrows the kind set', () => {
    // The unit under the leg fan-out above: whatever else changes, selecting
    // the `all` tab must yield all six kinds.
    expect(retainFeedKindsForArgs(normalizeRetainFeedArgs({ tab: 'all' })).sort()).toEqual([
      'memory',
      'plan',
      'recipe',
      'rubric',
      'runbook',
      'wi',
    ]);
  });

  // NOTE: the other half of D-001 — that the plan/wi legs are actually
  // shipped-SCOPED, not merely un-narrowed — CANNOT be asserted in this file:
  // the composed `sql` fragment from retainOutcomeSql never appears in the
  // stub's template text, and the stub returns whatever rows the case hands
  // it, so a predicate regression to TRUE would pass here unnoticed. It needs
  // real Postgres; see learning-retain-query.integration.test.ts.

  it('the legacy full-corpus fallback is read ONCE per page even when both its leg and counts consume it', async () => {
    // A pluggable backend without the optional bounded/exact capabilities
    // retains the old listMemories contract. On page 1 of an `all` tab BOTH
    // its row leg and counts want that array, so the compatibility path must
    // share one read rather than doubling it.
    const listMemories = vi.fn(async () => [
      { id: 'm1', text: 'first memory', metadata: { created_at: '2026-08-16T00:00:00.000Z' } },
      { id: 'm2', text: 'second memory', metadata: { created_at: '2026-08-15T00:00:00.000Z' } },
    ]);
    const listRubrics = vi.fn(async () => [
      { slug: 'r1', title: 'Rubric one', status: 'active', updatedAt: '2026-08-14T00:00:00.000Z' },
    ]);
    const sql = sqlStub(() => [{ n: 0 }]);

    const page = await readRetainFeed(
      sql,
      'ws-1',
      { ...emptyFeedDeps(), listMemories, listRubrics },
      { tab: 'all', withCounts: true },
    );

    expect(listMemories).toHaveBeenCalledTimes(1);
    expect(listRubrics).toHaveBeenCalledTimes(1);
    // …and because the count is taken over the SAME array the rows came from,
    // it cannot drift from what the leg actually returned.
    expect(page.counts?.memories).toBe(2);
    expect(page.counts?.rubrics).toBe(1);
    expect(page.rows.filter((r) => r.kind === 'memory')).toHaveLength(2);
  });

  it('a full-corpus dep that rejects still degrades its leg and nulls its count (one shared rejection)', async () => {
    // The shared promise is observed by two consumers. Both must keep their
    // own handling, or a single upstream failure escalates from "this leg
    // degraded" to an unhandled rejection that throws the whole page.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const listMemories = vi.fn(async () => {
      throw new Error('memory backend unavailable');
    });
    const sql = sqlStub(() => [{ n: 0 }]);

    const page = await readRetainFeed(
      sql,
      'ws-1',
      { ...emptyFeedDeps(), listMemories },
      { tab: 'all', withCounts: true },
    );

    expect(listMemories).toHaveBeenCalledTimes(1);
    expect(page.degraded).toContain('memory');
    expect(page.counts?.memories).toBeNull();
    warn.mockRestore();
  });

  it('a throwing leg lands in `degraded` while the rest of the page survives', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = sqlStub((t) => {
      if (isPlanLeg(t)) throw new Error('pg down');
      if (isWiLeg(t)) return [wiRow('EI-1', '2026-08-16T00:00:00.000Z')];
      return [{ n: 0 }];
    });
    const page = await readRetainFeed(sql, 'ws-1', emptyFeedDeps());
    expect(page.degraded).toEqual(['plan']);
    expect(page.rows.map((r) => r.id)).toEqual(['EI-1']);
    warn.mockRestore();
  });

  /**
   * WI-39813 — a store that HANGS must degrade exactly like one that THROWS.
   *
   * The per-leg try/catch above only ever covered a leg that rejects. Nothing
   * bounded a leg that merely never settles, so `Promise.all` waited for it,
   * the read blew the sync layer's 10s resolver timeout, and the whole page
   * 500'd with ZERO rows even though every other leg had already returned —
   * the "Loading retained items… forever" reported on 2026-08-17 (the client
   * sets no `retry`, so v5 retries 3x at a full 10s each before any error
   * branch can surface). Slowness is the characteristic symptom of a hiccuping
   * store here, not the exception: memory-backend p50 is ~10.9s (WI-39554) and
   * the memory leg is a full-corpus read over exactly that backend.
   */
  describe('a hung store degrades instead of hanging the page (WI-39813)', () => {
    /** Never settles — a wedged store, not a failing one. */
    const hang = <T>(): Promise<T> => new Promise<T>(() => {});
    const oneWi = (t: string) => (isWiLeg(t) ? [wiRow('EI-1', '2026-08-16T00:00:00.000Z')] : [{ n: 0 }]);

    it('a hanging leg lands in `degraded` and every other leg still serves its rows', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const page = await readRetainFeed(
        sqlStub(oneWi),
        'ws-1',
        { ...emptyFeedDeps(), listMemories: () => hang() },
        { tab: 'all', budgetMs: 40, withCounts: true },
      );

      expect(page.degraded).toContain('memory');
      // The whole point: the page still SERVES. Before the budget this returned
      // nothing at all, because the hung leg took the entire read down with it.
      expect(page.rows.map((r) => r.id)).toEqual(['EI-1']);
      expect(page.counts?.memories).toBeNull();
      warn.mockRestore();
    });

    // Without this control the guard above would pass just as happily against a
    // branch that degrades unconditionally — "always degraded" satisfies every
    // assertion that only ever inspects the failing case.
    it('a healthy page under the SAME budget degrades nothing — the guard discriminates on the hang, not on the budget', async () => {
      const page = await readRetainFeed(
        sqlStub(oneWi),
        'ws-1',
        {
          ...emptyFeedDeps(),
          listMemories: async () => [
            { id: 'm1', text: 'a memory', metadata: { created_at: '2026-08-15T00:00:00.000Z' } },
          ],
        },
        { tab: 'all', budgetMs: 40, withCounts: true },
      );

      expect(page.degraded).toEqual([]);
      expect(page.counts?.memories).toBe(1);
      expect(page.rows.map((r) => r.kind).sort()).toEqual(['memory', 'wi']);
    });

    // The counts fan-out is a SECOND, later `Promise.all` and hangs the page
    // just as thoroughly as the legs do. Budgeting only the legs leaves the
    // original defect fully reachable through any count.
    it('a hanging COUNT nulls that one count without hanging the page, and its siblings still resolve', async () => {
      const page = await readRetainFeed(
        sqlStub(oneWi),
        'ws-1',
        { ...emptyFeedDeps(), countRecipes: () => hang(), countRunbooks: async () => 7 },
        { tab: 'all', budgetMs: 40, withCounts: true },
      );

      expect(page.counts?.recipes).toBeNull();
      expect(page.counts?.runbooks).toBe(7);
      expect(page.rows.map((r) => r.id)).toEqual(['EI-1']);
    });

    // Pins the DEADLINE decision itself. Two independent per-call budgets would
    // total 2x and overrun the very 10s resolver timeout this exists to stay
    // under; the observable difference is that counts run AFTER the legs, so a
    // budget the legs already spent must leave them none.
    it('the deadline is SHARED by both fan-outs — the counts get no second budget after the legs spent the first', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Needs one real timer tick: fast, but not a microtask (an already-settled
      // promise legitimately wins a zero-remaining budget, by design).
      const slowishCount = () => new Promise<number>((r) => setTimeout(() => r(9), 5));

      const spent = await readRetainFeed(
        sqlStub(oneWi),
        'ws-1',
        { ...emptyFeedDeps(), listMemories: () => hang(), countRecipes: slowishCount },
        { tab: 'all', budgetMs: 30, withCounts: true },
      );
      expect(spent.degraded).toContain('memory');
      expect(spent.counts?.recipes).toBeNull();

      // Control: the identical count against a deadline nothing has spent lands
      // — so the null above is the shared deadline, not a count that can't run.
      const fresh = await readRetainFeed(
        sqlStub(oneWi),
        'ws-1',
        { ...emptyFeedDeps(), countRecipes: slowishCount },
        { tab: 'all', budgetMs: 2000, withCounts: true },
      );
      expect(fresh.counts?.recipes).toBe(9);
      warn.mockRestore();
    });

    /**
     * FALSIFIABILITY CONTROL for the three guards above — they are only worth
     * their runtime if they FAIL when the bound stops being applied.
     *
     * The read builds its deadline internally, so the honest lever is the one
     * knob it exposes: a budget far outside the test's patience is
     * observationally identical to no bound at all. Under it the SAME hang
     * takes the WHOLE read down — the defect itself, reproduced on demand
     * rather than asserted, and the reason `degraded` can never ship from an
     * unbounded read (the response never ships either).
     *
     * `pending` has to be an assertable outcome here, not a test timeout: "it
     * never settles" is precisely the condition under test.
     */
    const PENDING = Symbol('still-pending');
    const settledWithin = <T>(p: Promise<T>, ms: number): Promise<T | typeof PENDING> =>
      Promise.race([
        p,
        new Promise<typeof PENDING>((resolve) => {
          const t = setTimeout(() => resolve(PENDING), ms);
          (t as unknown as { unref?: () => void }).unref?.();
        }),
      ]);

    it('CONTROL: with a budget that cannot fire, the same hang takes the whole read down — so the guards above are falsifiable', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const unbounded = readRetainFeed(
        sqlStub(oneWi),
        'ws-1',
        { ...emptyFeedDeps(), listMemories: () => hang() },
        { tab: 'all', budgetMs: 10 * 60_000 },
      );
      expect(await settledWithin(unbounded, 150)).toBe(PENDING);

      // Calibration: the identical call under a REAL budget settles, degraded.
      // Without this the assertion above would also pass against a read that
      // can never settle for some unrelated reason.
      const bounded = await settledWithin(
        readRetainFeed(
          sqlStub(oneWi),
          'ws-1',
          { ...emptyFeedDeps(), listMemories: () => hang() },
          { tab: 'all', budgetMs: 40, withCounts: true },
        ),
        2000,
      );
      expect(bounded).not.toBe(PENDING);
      expect(bounded !== PENDING && bounded.degraded).toContain('memory');
      warn.mockRestore();
    });
  });

  /**
   * EI-18792873324746237 — the shipped verdict is stamped SERVER-side against
   * the shared unified status set. The regression: a query naming only the
   * pre-unify 'resolved'/'closed' spellings selected nothing post-flip, and a
   * client-side re-typed list scored `done` as not-a-win. Pin both halves.
   */
  describe('server-side shipped classification (EI-18792873324746237)', () => {
    it('binds the CANONICAL unified spelling into the wi leg, so it can match a live row', async () => {
      const bound: unknown[][] = [];
      const sql = sqlStub((t, values) => {
        if (isWiLeg(t)) bound.push(values);
        return [];
      });
      await readRetainFeed(sql, 'ws-1', emptyFeedDeps(), { tab: 'wi', cursor: 'x' });
      expect(bound).toHaveLength(1);
      expect(bound.flat(2)).toContain('done');
    });

    it('serves the row-level verdict the SQL computed — done=shipped, dropped=not', async () => {
      const sql = sqlStub((t) =>
        isWiLeg(t)
          ? [
              wiRow('EI-done', '2026-08-16T00:00:00.000Z', { status: 'done', shipped: true }),
              wiRow('EI-dropped', '2026-08-15T00:00:00.000Z', { status: 'dropped', shipped: false }),
            ]
          : [{ n: 0 }],
      );
      const page = await readRetainFeed(sql, 'ws-1', emptyFeedDeps(), { tab: 'wi' });
      expect(page.rows.map((r) => [r.id, r.shipped])).toEqual([
        ['EI-done', true],
        ['EI-dropped', false],
      ]);
    });

    it('classifies a plan by the PLAN vocabulary: only `shipped` lands', async () => {
      const sql = sqlStub((t) =>
        isPlanLeg(t)
          ? [
              planRow('p-shipped', '2026-08-16T00:00:00.000Z', { status: 'shipped' }),
              planRow('p-active', '2026-08-15T00:00:00.000Z', { status: 'active' }),
            ]
          : [{ n: 0 }],
      );
      const page = await readRetainFeed(sql, 'ws-1', emptyFeedDeps(), { tab: 'plans' });
      expect(page.rows.map((r) => [r.id, r.shipped])).toEqual([
        ['p-shipped', true],
        ['p-active', false],
      ]);
    });
  });

  it('plan rows carry the plan-born child rollup + origin idea', async () => {
    const sql = sqlStub((t) => (isPlanLeg(t) ? [planRow('p1', '2026-08-15T00:00:00.000Z')] : [{ n: 0 }]));
    const page = await readRetainFeed(sql, 'ws-1', emptyFeedDeps(), { tab: 'plans' });
    expect(page.rows[0]!.meta).toEqual({
      ideaId: 'idea-p1',
      ideaTitle: 'idea for p1',
      lens: 'reframing',
      childTotal: 3,
      childDone: 2,
    });
  });

  // ─── The memory leg (WI-39535: shared-memory pool folded in as a kind) ────
  describe('memory leg', () => {
    const mem = (id: string, text: string, metadata: Record<string, unknown> = {}, kind?: string) => ({
      id,
      text,
      ...(kind ? { kind } : {}),
      metadata,
    });

    it('uses the bounded page capability with the cursor window and never calls the full-list fallback', async () => {
      const listMemories = vi.fn(async () => [mem('must-not-load', 'whole corpus')]);
      const listMemoriesPage = vi.fn(async () => [
        mem('m-after', 'After cursor', { updated_at: '2026-08-14T00:00:00.000Z' }),
      ]);
      const cursor = encodeRetainCursor({
        ts: '2026-08-15T00:00:00.000Z',
        kind: 'memory',
        id: 'm-mid',
      });

      const page = await readRetainFeed(
        sqlStub(() => []),
        'ws-1',
        { ...emptyFeedDeps(), listMemories, listMemoriesPage },
        { tab: 'memories', cursor, limit: 7 },
      );

      expect(listMemoriesPage).toHaveBeenCalledWith({
        window: {
          beforeTs: '2026-08-15T00:00:00.000Z',
          includeTies: false,
          tieIdAfter: 'm-mid',
        },
        limit: 7,
      });
      expect(listMemories).not.toHaveBeenCalled();
      expect(page.rows.map((row) => row.id)).toEqual(['m-after']);
    });

    it('uses the exact count capability even when the bounded page contains fewer rows', async () => {
      const listMemories = vi.fn(async () => [mem('must-not-load', 'whole corpus')]);
      const listMemoriesPage = vi.fn(async () => [
        mem('m-one', 'Visible page row', { updated_at: '2026-08-16T00:00:00.000Z' }),
      ]);
      const countMemories = vi.fn(async () => 58);

      const page = await readRetainFeed(
        sqlStub(() => [{ n: 0 }]),
        'ws-1',
        { ...emptyFeedDeps(), listMemories, listMemoriesPage, countMemories },
        { tab: 'memories', withCounts: true, limit: 1 },
      );

      expect(page.rows).toHaveLength(1);
      expect(page.counts?.memories).toBe(58);
      expect(countMemories).toHaveBeenCalledTimes(1);
      expect(listMemories).not.toHaveBeenCalled();
    });

    it('interleaves memory rows by metadata recency, with provenance in meta', async () => {
      const sql = sqlStub((t) => (isWiLeg(t) ? [wiRow('EI-1', '2026-08-15T00:00:00.000Z')] : [{ n: 0 }]));
      const deps: RetainFeedDeps = {
        ...emptyFeedDeps(),
        listMemories: async () => [
          mem('m-new', 'Fresh fact', { updated_at: '2026-08-16T00:00:00.000Z', created_by: 'owner' }, 'feedback'),
          mem('m-pack', 'Pack fact', {
            created_at: '2026-08-14T00:00:00.000Z',
            source: 'pack',
            pack_id: 'coding',
          }),
        ],
      };
      const page = await readRetainFeed(sql, 'ws-1', deps, { withCounts: true });
      expect(page.rows.map((r) => `${r.kind}:${r.id}`)).toEqual(['memory:m-new', 'wi:EI-1', 'memory:m-pack']);
      expect(page.rows[0]!.meta).toEqual({ memKind: 'feedback', createdBy: 'owner' });
      expect(page.rows[0]!.status).toBeNull();
      expect(page.rows[2]!.meta).toEqual({ packId: 'coding' });
      expect(page.counts?.memories).toBe(2);
    });

    it('a memory with no timestamp reads as epoch — visible at the tail, never dropped', async () => {
      const sql = sqlStub(() => [{ n: 0 }]);
      const deps: RetainFeedDeps = { ...emptyFeedDeps(), listMemories: async () => [mem('m-old', 'Undated fact')] };
      const page = await readRetainFeed(sql, 'ws-1', deps, { tab: 'memories' });
      expect(page.rows.map((r) => r.id)).toEqual(['m-old']);
      expect(page.rows[0]!.ts).toBe('1970-01-01T00:00:00.000Z');
    });

    it('the memories tab narrows to the memory leg — no SQL legs touched past page 1', async () => {
      const sqlCalls: string[] = [];
      const sql = sqlStub((t) => {
        sqlCalls.push(t);
        return [];
      });
      const cursor = encodeRetainCursor({ ts: '2026-08-15T00:00:00.000Z', kind: 'memory', id: 'm-mid' });
      const deps: RetainFeedDeps = {
        ...emptyFeedDeps(),
        listMemories: async () => [
          mem('m-a', 'after cursor', { updated_at: '2026-08-14T00:00:00.000Z' }),
          mem('m-z', 'before cursor', { updated_at: '2026-08-16T00:00:00.000Z' }),
        ],
      };
      const page = await readRetainFeed(sql, 'ws-1', deps, { tab: 'memories', cursor });
      expect(page.rows.map((r) => r.id)).toEqual(['m-a']); // keyset window applied
      expect(sqlCalls).toEqual([]);
    });

    it('an UNWIRED listMemories dep degrades VISIBLY, never silently', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { listMemories: _omit, ...rest } = emptyFeedDeps();
      const page = await readRetainFeed(
        sqlStub(() => [{ n: 0 }]),
        'ws-1',
        rest as RetainFeedDeps,
        { withCounts: true },
      );
      expect(page.degraded).toEqual(['memory']);
      expect(page.counts?.memories).toBeNull();
      warn.mockRestore();
    });

    it('retainMemoryTitle collapses whitespace and clamps long facts', () => {
      expect(retainMemoryTitle('a\n b\t c')).toBe('a b c');
      const long = 'x'.repeat(300);
      const title = retainMemoryTitle(long);
      expect(title.length).toBeLessThanOrEqual(200);
      expect(title.endsWith('…')).toBe(true);
    });

    it('retainMemoryTsOf prefers updated over created and tolerates both spellings', () => {
      expect(retainMemoryTsOf({ updated_at: '2026-08-16T00:00:00.000Z', created_at: '2026-08-10T00:00:00.000Z' })).toBe(
        '2026-08-16T00:00:00.000Z',
      );
      expect(retainMemoryTsOf({ createdAt: '2026-08-10T00:00:00.000Z' })).toBe('2026-08-10T00:00:00.000Z');
      expect(retainMemoryTsOf(undefined)).toBe('1970-01-01T00:00:00.000Z');
    });
  });
});

describe('readRetainPlanChildren', () => {
  it('maps rows with the server-stamped shipped verdict', async () => {
    const sql = sqlStub(() => [
      { id: 'EI-1', title: 'Child one', status: 'done', shipped: true, ts: '2026-08-15T00:00:00.000Z' },
      { id: 'EI-2', title: 'Child two', status: 'wip', shipped: false, ts: '2026-08-14T00:00:00.000Z' },
    ]);
    const rows = await readRetainPlanChildren(sql, 'ws-1', 'plan-x');
    expect(rows).toEqual([
      { id: 'EI-1', title: 'Child one', status: 'done', shipped: true, ts: '2026-08-15T00:00:00.000Z' },
      { id: 'EI-2', title: 'Child two', status: 'wip', shipped: false, ts: '2026-08-14T00:00:00.000Z' },
    ]);
  });

  it('degrades to [] on a read failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = sqlStub(() => {
      throw new Error('pg down');
    });
    expect(await readRetainPlanChildren(sql, 'ws-1', 'plan-x')).toEqual([]);
    warn.mockRestore();
  });
});

// ─── Row detail (WI-39534) ───────────────────────────────────────────────────

const isPlanDetail = (t: string) => t.includes('hp.content');
const isWiDetail = (t: string) => t.includes('ei.body');

const emptyDetailDeps = (): RetainDetailDeps => ({
  getRubric: async () => null,
  getRecipe: async () => null,
  readRunbook: async () => null,
  getMemory: async () => null,
});

describe('readRetainDetail', () => {
  it('plan: body from content, provenance fields from the routed idea', async () => {
    const sql = sqlStub((t) =>
      isPlanDetail(t)
        ? [
            {
              title: 'Plan one',
              status: 'active',
              content: '  # Plan body  ',
              harness_slug: 'h-1',
              now_state: 'building',
              ts: '2026-08-15T00:00:00.000Z',
              idea_id: 'idea-1',
              idea_title: 'the idea',
              lens: 'reframing',
              routed_ts: '2026-08-10T00:00:00.000Z',
            },
          ]
        : [],
    );
    const d = await readRetainDetail(sql, 'ws-1', 'plan', 'p-1', emptyDetailDeps());
    expect(d).toMatchObject({
      kind: 'plan',
      id: 'p-1',
      title: 'Plan one',
      status: 'active',
      body: '# Plan body',
      bodyTruncated: false,
    });
    expect(d!.fields).toEqual([
      { label: 'Harness', value: 'h-1' },
      { label: 'Now', value: 'building' },
      { label: 'From idea', value: 'the idea' },
      { label: 'Lens', value: 'reframing' },
      { label: 'Routed', value: '2026-08-10T00:00:00.000Z' },
    ]);
  });

  it('wi: body + severity/scope fields; unknown id resolves null', async () => {
    const sql = sqlStub((t) =>
      isWiDetail(t)
        ? [
            {
              title: 'The issue',
              state: 'done',
              body: 'repro steps',
              severity: 'major',
              created_by: 'scout',
              scope: 'harness:h-1',
              ts: '2026-08-15T00:00:00.000Z',
              created_ts: '2026-08-01T00:00:00.000Z',
              idea_id: null,
              idea_title: null,
              lens: null,
            },
          ]
        : [],
    );
    const d = await readRetainDetail(sql, 'ws-1', 'wi', 'EI-1', emptyDetailDeps());
    expect(d).toMatchObject({ kind: 'wi', title: 'The issue', status: 'done', body: 'repro steps' });
    expect(d!.fields.map((f) => f.label)).toEqual(['Severity', 'Scope', 'Created by', 'Created']);
    expect(
      await readRetainDetail(
        sqlStub(() => []),
        'ws-1',
        'wi',
        'EI-none',
        emptyDetailDeps(),
      ),
    ).toBeNull();
  });

  it('rubric: criteria as listItems', async () => {
    const deps: RetainDetailDeps = {
      ...emptyDetailDeps(),
      getRubric: async () => ({
        title: 'Rubric R',
        description: 'what good looks like',
        status: 'active',
        characteristic: 'hive-coordination',
        criteria: [{ label: 'C1' }, { title: 'C2' }, { id: 'c3' }],
        updatedAt: '2026-08-15T00:00:00.000Z',
      }),
    };
    const d = await readRetainDetail(
      sqlStub(() => []),
      'ws-1',
      'rubric',
      'r-1',
      deps,
    );
    expect(d).toMatchObject({ kind: 'rubric', title: 'Rubric R', body: 'what good looks like' });
    expect(d!.listItems).toEqual(['C1', 'C2', 'c3']);
    expect(d!.fields).toEqual([{ label: 'Characteristic', value: 'hive-coordination' }]);
  });

  it('runbook: frontmatter stripped from the body, title/discovered parsed from it', async () => {
    const deps: RetainDetailDeps = {
      ...emptyDetailDeps(),
      readRunbook: async () => ({
        text: '---\ntitle: The doc\ndiscovered: 2026-07-01\n---\nThe method itself.',
        ts: '2026-08-01T00:00:00.000Z',
      }),
    };
    const d = await readRetainDetail(
      sqlStub(() => []),
      'ws-1',
      'runbook',
      'doc-1',
      deps,
    );
    expect(d).toMatchObject({ title: 'The doc', body: 'The method itself.', ts: '2026-08-01T00:00:00.000Z' });
    expect(d!.fields).toEqual([{ label: 'Discovered', value: '2026-07-01' }]);
  });

  it('recipe: description as body, script as code, run stats as fields', async () => {
    const deps: RetainDetailDeps = {
      ...emptyDetailDeps(),
      getRecipe: async () => ({
        title: 'Recipe R',
        description: 'what it automates',
        script: 'console.log(1)',
        potSlug: 'pot-a',
        toolsUsed: ['dev:pg_query'],
        runCount: 5,
        successCount: 4,
        lastRunAt: '2026-08-15T00:00:00.000Z',
        status: 'active',
        createdBy: 'agent-x',
        updatedAt: '2026-08-10T00:00:00.000Z',
      }),
    };
    const d = await readRetainDetail(
      sqlStub(() => []),
      'ws-1',
      'recipe',
      'rec-1',
      deps,
    );
    expect(d).toMatchObject({ kind: 'recipe', body: 'what it automates', code: 'console.log(1)' });
    expect(d!.ts).toBe('2026-08-15T00:00:00.000Z');
    expect(d!.fields).toEqual([
      { label: 'Runs', value: '4/5 ok' },
      { label: 'Last run', value: '2026-08-15T00:00:00.000Z' },
      { label: 'Pot', value: 'pot-a' },
      { label: 'Author', value: 'agent-x' },
      { label: 'Tools', value: 'dev:pg_query' },
    ]);
  });

  it('memory: full text, editable, pack + pool provenance', async () => {
    const deps: RetainDetailDeps = {
      ...emptyDetailDeps(),
      getMemory: async () => ({
        id: 'm-1',
        text: 'The retained fact, in full.',
        kind: 'feedback',
        scope: 'hive:pot-a',
        metadata: {
          created_by: 'owner',
          source: 'pack',
          pack_id: 'coding',
          pack_version: '1.2.0',
          applies_to: ['engineer'],
          updated_at: '2026-08-16T00:00:00.000Z',
        },
      }),
    };
    const d = await readRetainDetail(
      sqlStub(() => []),
      'ws-1',
      'memory',
      'm-1',
      deps,
    );
    expect(d).toMatchObject({
      kind: 'memory',
      body: 'The retained fact, in full.',
      editable: true,
      ts: '2026-08-16T00:00:00.000Z',
    });
    expect(d!.fields).toEqual([
      { label: 'Kind', value: 'feedback' },
      { label: 'Created by', value: 'owner' },
      { label: 'Pack', value: 'coding @1.2.0' },
      { label: 'Applies to', value: 'engineer' },
      { label: 'Pool', value: 'hive:pot-a' },
    ]);
  });

  it('a long body clamps with bodyTruncated', async () => {
    const sql = sqlStub((t) => (isPlanDetail(t) ? [{ title: 'P', status: null, content: 'x'.repeat(9000) }] : []));
    const d = await readRetainDetail(sql, 'ws-1', 'plan', 'p-big', emptyDetailDeps());
    expect(d!.bodyTruncated).toBe(true);
    expect(d!.body!.length).toBe(4000);
  });

  it('an empty id and an unknown id resolve null', async () => {
    expect(
      await readRetainDetail(
        sqlStub(() => []),
        'ws-1',
        'plan',
        '',
        emptyDetailDeps(),
      ),
    ).toBeNull();
    expect(
      await readRetainDetail(
        sqlStub(() => []),
        'ws-1',
        'memory',
        'm-none',
        emptyDetailDeps(),
      ),
    ).toBeNull();
  });

  it.each(['plan', 'wi', 'rubric', 'runbook', 'recipe', 'memory'] as const)(
    'propagates %s retained detail read failures instead of a successful missing row', async kind => {
      const error = new Error(kind === 'memory' ? 'mem0_unavailable' : `${kind} store down`);
      const fail = async () => { throw error; };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await expect(readRetainDetail(sqlStub(() => { throw error; }), 'ws-1', kind, 'existing-id', {
          getRubric: fail, getRecipe: fail, readRunbook: fail, getMemory: fail,
        })).rejects.toBe(error);
      } finally {
        warn.mockRestore();
      }
    },
  );

  it('stripFrontmatter leaves a doc without frontmatter intact', () => {
    expect(stripFrontmatter('no frontmatter here')).toBe('no frontmatter here');
    expect(stripFrontmatter('---\na: 1\n---\nbody')).toBe('body');
  });
});

describe('insight-doc fs legs', () => {
  const mkDocs = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'insights-'));
    const mk = async (name: string, discovered: string, mtimeSec: number) => {
      const p = path.join(dir, name);
      await writeFile(p, `---\ntitle: ${name}\ndiscovered: ${discovered}\n---\n`);
      await utimes(p, mtimeSec, mtimeSec);
    };
    await mk('a.mdx', '2026-07-01', 1_700_000_100);
    await mk('b.mdx', '2026-07-18', 1_700_000_200);
    await mk('c.md', '2026-07-10', 1_700_000_300);
    await writeFile(path.join(dir, 'ignored.txt'), 'not a doc');
    return dir;
  };

  it('pages newest-mtime first, opening only the selected files', async () => {
    const dir = await mkDocs();
    const page = await readInsightDocsPage(dir, { window: null, limit: 2 });
    expect(page.map((d) => d.slug)).toEqual(['c', 'b']);
    expect(page[0]!.title).toBe('c.md');
    expect(page[0]!.ts).toBe(new Date(1_700_000_300_000).toISOString());
  });

  it('applies the keyset window', async () => {
    const dir = await mkDocs();
    const first = await readInsightDocsPage(dir, { window: null, limit: 1 });
    const w = { beforeTs: first[0]!.ts, includeTies: false, tieIdAfter: first[0]!.slug };
    const rest = await readInsightDocsPage(dir, { window: w, limit: 5 });
    expect(rest.map((d) => d.slug)).toEqual(['b', 'a']);
  });

  it('countInsightDocs counts only md/mdx', async () => {
    const dir = await mkDocs();
    expect(await countInsightDocs(dir)).toBe(3);
  });
});
