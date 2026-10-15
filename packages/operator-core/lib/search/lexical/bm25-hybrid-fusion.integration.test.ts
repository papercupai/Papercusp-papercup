/**
 * Rank fusion with a BM25 lexical leg (plan bm25-lexical-search-evoke-adoption-2026-10-10:
 * requirement R-13, decision D-004).
 *
 * R-13 is judged live by `search/bench/bm25-hybrid-recall-cli.ts` (fused recall@10 of
 * `runHybridSearch` with the BM25 leg vs the legacy leg, same process, same sample). This
 * suite pins two properties that verdict relies on: fusion is by POSITION, so BM25's
 * unbounded score fuses exactly like ts_rank's [0,1) one; and (D-016) the exact list
 * recovers the verbatim-fragment target BM25 alone ranks out of the top results.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { bm25Leg, boundedExactTopK, lexicalEngine, mergeExactAndBm25, resetBm25Availability, rrfTerm } from './rank';
import { bm25Corpus } from './corpora';
import { seedBm25Corpus, startBm25TestDb, type Bm25TestDb } from './test-pg/bm25-test-db';
import { applyDisclosureLedgerForTest } from '../../../test/_pg-helpers';
import { SEARCH_SOURCES } from '../../agent-tools/search/sources';
import { FLAGS, flagEnvVarName } from '@papercusp/flags';
import type { PgHandle } from '@papercusp/search';

let db: Bm25TestDb;
let sql: Sql;

beforeAll(async () => {
  db = await startBm25TestDb();
  sql = db.sql;
  await seedBm25Corpus(sql);
}, 600_000);

afterAll(async () => {
  await db?.close();
});

describe('the exact list beside the BM25 list (R-13, plan D-016)', () => {
  // The measured R-13 failure, in miniature: a verbatim fragment of a LONG document whose
  // terms are individually common. Short distractors repeat all but one of the fragment's
  // lexemes, so BM25 (no AND, no proximity) ranks every distractor above the target; the
  // AND list admits only the target. Rows live in workspace 'w9', apart from the seed.
  const FRAGMENT = "third consecutive wake where the carry-note's";
  const TARGET = 5001;

  beforeAll(async () => {
    const filler = Array.from({ length: 400 }, (_, i) => `ledger${i % 37} harbour${i % 23}`).join(' ');
    const rows = [
      { id: TARGET, ws: 'w9', title: 'stale pointer audit', summary: 'routine summary',
        notes: `${filler} This is the third consecutive wake where the carry-note's pointer was stale. ${filler}` },
      ...Array.from({ length: 40 }, (_, i) => ({
        id: TARGET + 1 + i, ws: 'w9', title: `wake third ${i}`,
        summary: 'third consecutive wake wake', notes: 'consecutive note note wake' })),
    ];
    await sql`INSERT INTO harness_shared.work_items ${sql(rows)}`;
  }, 120_000);

  async function bm25List(): Promise<{ id: number; rank: number }[]> {
    const leg = bm25Leg(sql, bm25Corpus('work_items'), FRAGMENT, 'w');
    return sql<{ id: number; rank: number }[]>`
      SELECT w.id, ${leg.score} AS rank FROM harness_shared.work_items w
       WHERE w.ws = 'w9' AND ${leg.match} ORDER BY ${leg.order}, w.id LIMIT 10`;
  }

  async function exactList(): Promise<{ id: number; rank: number }[]> {
    const tsv = sql`to_tsvector('english', coalesce(w.title, '') || ' ' || coalesce(w.summary, '') || ' ' || coalesce(w.notes, ''))`;
    const q = sql`plainto_tsquery('english', ${FRAGMENT})`;
    return sql<{ id: number; rank: number }[]>`
      SELECT w.id, ts_rank_cd(${tsv}, ${q})::float8 AS rank FROM harness_shared.work_items w
       WHERE w.ws = 'w9' AND ${tsv} @@ ${q} ORDER BY rank DESC, w.id LIMIT 10`;
  }

  it('BM25 alone ranks the fragment target out of its top 10 (the mechanism R-13 measured)', async () => {
    const ids = (await bm25List()).map(r => r.id);
    expect(ids).toHaveLength(10);
    expect(ids).not.toContain(TARGET);
  });

  it('the AND list admits only the target, and the merged list keeps it in the top two (D-032 interleave)', async () => {
    const exact = await exactList();
    expect(exact.map(r => r.id)).toEqual([TARGET]);
    const merged = mergeExactAndBm25(exact, await bm25List(), r => String(r.id), 10);
    expect(merged.slice(0, 2).map(r => r.id)).toContain(TARGET);
    expect(merged).toHaveLength(10);
  });
});

describe('rank fusion with a BM25 leg (plan D-004)', () => {
  // BM25 matches items 1 (quokka) and 2 (marmoset) only; the stand-in second leg matches
  // items 2 and 3, best = 3. The OR in WHERE keeps the planner off the BM25 index scan, so
  // the distance is computed per row inside the window.
  async function fused(scale: number): Promise<{ id: number; score: number }[]> {
    const leg = bm25Leg(sql, bm25Corpus('work_items'), 'quokka marmoset', 'w');
    const otherMatch = sql`w.id IN (2, 3)`;
    return sql<{ id: number; score: number }[]>`
      SELECT w.id,
             (${rrfTerm(sql, leg.match, leg.score)} + ${rrfTerm(sql, otherMatch, sql`w.id * ${scale}::float8`)})::float8 AS score
        FROM harness_shared.work_items w
       WHERE ${leg.match} OR ${otherMatch}
       ORDER BY score DESC, w.id`;
  }

  it('ranks the row both legs match first and admits only rows some leg matches', async () => {
    const rows = await fused(1);
    expect(rows.map(r => r.id).sort()).toEqual([1, 2, 3]);
    expect(rows[0]?.id).toBe(2);
    // Item 2 is second in the other leg and first or second (a tie with item 1) in BM25.
    expect(rows[0]!.score).toBeGreaterThanOrEqual(1 / 62 + 1 / 62 - 1e-12);
    expect(rows[0]!.score).toBeLessThanOrEqual(1 / 61 + 1 / 62 + 1e-12);
    for (const r of rows.slice(1)) expect(r.score).toBeGreaterThan(0);
  });

  it('depends on positions only, so rescaling a leg changes nothing', async () => {
    expect(await fused(1_000_000)).toEqual(await fused(1));
  });
});

describe('one bounded exact candidate scan (R-18, D-033)', () => {
  const tsv = () => sql`to_tsvector('english', coalesce(w.title, '') || ' ' || coalesce(w.summary, '') || ' ' || coalesce(w.notes, ''))`;
  const top = (query: string, maxMatches: number, limit = 10) => boundedExactTopK(sql, {
    columns: sql`w.id`, from: sql`harness_shared.work_items w`, where: sql`w.ws = 'w9'`,
    tsv: tsv(), query, limit, maxMatches,
  });

  it('preserves the full AND list ranks and scoped identities at the cap boundary', async () => {
    const query = 'third consecutive wake';
    const expected = await sql`
      SELECT w.id, ts_rank_cd(${tsv()}, plainto_tsquery('english', ${query})) AS rank
        FROM harness_shared.work_items w
       WHERE w.ws = 'w9' AND ${tsv()} @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC`;
    expect(expected).toHaveLength(41);
    const got = await sql`SELECT id, exact_rank AS rank FROM (${top(query, expected.length, 50)}) e`;
    expect(got.map(r => ({ id: r.id, rank: r.rank })).sort((a, b) => a.id - b.id))
      .toEqual(expected.map(r => ({ id: r.id, rank: r.rank })).sort((a, b) => a.id - b.id));
    const limited = await sql`SELECT exact_rank AS rank FROM (${top(query, expected.length, 5)}) e`;
    expect(limited.map(r => r.rank)).toEqual(expected.slice(0, 5).map(r => r.rank));
  });

  it('returns no truncated exact list above the cap, and does not scan the corpus twice', async () => {
    expect(await sql`${top('third consecutive wake', 40)}`).toHaveLength(0);
    expect(await sql`${top('unfindablequokka', 40)}`).toHaveLength(0);
    const [ex] = await sql`EXPLAIN (ANALYZE, FORMAT JSON) ${top('third consecutive wake', 40)}`;
    const nodes: Record<string, unknown>[] = [];
    const walk = (n: Record<string, unknown>) => {
      nodes.push(n);
      for (const child of (n.Plans ?? []) as Record<string, unknown>[]) walk(child);
    };
    walk(ex['QUERY PLAN'][0].Plan);
    const scans = nodes.filter(n => n['Relation Name'] === 'work_items');
    expect(scans).toHaveLength(1);
    expect(scans[0]!['Actual Loops']).toBe(1);
    expect(scans[0]!['Actual Rows']).toBeLessThanOrEqual(41);
    const ranked = nodes.find(n => n['Node Type'] === 'Result' && String(n['One-Time Filter']).includes('40'));
    expect(ranked).toBeDefined();
    expect(ranked!['Actual Rows']).toBe(0);
  });
});

it('the production exact session list hydrates the full workspace key, including an exact-only target', async () => {
  // Same logical turn in another tenant is deliberately inserted first. The target is too
  // long for BM25's top two, so only the exact-list hydration can recover its own text.
  await sql.unsafe(`CREATE TABLE harness_shared.session_turns (
    workspace_id text NOT NULL, source_kind text NOT NULL, session_id text NOT NULL, turn_idx int NOT NULL,
    speaker text NOT NULL, owner text, harness_slug text, text text NOT NULL, ts timestamptz,
    ingested_at timestamptz NOT NULL DEFAULT now(), turn_origin_verdict text,
    text_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', left(text, 20000))) STORED,
    PRIMARY KEY (workspace_id, source_kind, session_id, turn_idx));
    CREATE INDEX session_turns_bm25 ON harness_shared.session_turns
      USING bm25 ((left(coalesce(text, ''), 20000))) WITH (text_config='english', compaction='manual')`);
  await applyDisclosureLedgerForTest(sql);
  const fragment = "third consecutive wake where the carry-note's";
  const filler = Array.from({ length: 400 }, (_, i) => `ledger${i % 37} harbour${i % 23}`).join(' ');
  const turns = [
    { workspace_id: 'foreign', source_kind: 'claude', session_id: 'same', turn_idx: 0, speaker: 'user', text: 'FOREIGNMARKER' },
    { workspace_id: 'mine', source_kind: 'claude', session_id: 'same', turn_idx: 0, speaker: 'user', text: `OWNMARKER ${filler} ${fragment} pointer was stale. ${filler}` },
    ...Array.from({ length: 400 }, (_, i) => ({ workspace_id: 'mine', source_kind: 'claude', session_id: 'short', turn_idx: i,
      speaker: 'user', text: 'third consecutive wake wake consecutive note note wake' })),
  ];
  await sql`INSERT INTO harness_shared.session_turns ${sql(turns)}`;
  const envKey = flagEnvVarName(FLAGS.BM25_LEXICAL_RANKING);
  const saved = process.env[envKey];
  process.env[envKey] = '1';
  resetBm25Availability();
  try {
    expect(await lexicalEngine(sql, 'session_turns')).toBe('bm25');
    const leg = bm25Leg(sql, bm25Corpus('session_turns'), fragment);
    const before = await sql`SELECT session_id, ${leg.score} AS score FROM harness_shared.session_turns
      WHERE workspace_id='mine' AND ${leg.match} ORDER BY ${leg.order} LIMIT 2`;
    // BM25's document frequencies span tenants. Without a neutral corpus, almost every
    // document contains the distractor terms and the target's rare compound dominates.
    const neutral = Array.from({ length: 400 }, (_, i) => ({ workspace_id: 'padding', source_kind: 'claude',
      session_id: 'neutral', turn_idx: i, speaker: 'user', text: 'routine ledger harbour plain summary' }));
    await sql`INSERT INTO harness_shared.session_turns ${sql(neutral)}`;
    const primary = await sql`SELECT session_id, ${leg.score} AS score FROM harness_shared.session_turns
      WHERE workspace_id='mine' AND ${leg.match} ORDER BY ${leg.order} LIMIT 2`;
    expect(primary.map(r => r.session_id), JSON.stringify({ before, after: primary })).not.toContain('same');
    const sources = process.env.PAPERCUSP_SOURCES_SUBJECT
      ? (await import(process.env.PAPERCUSP_SOURCES_SUBJECT)).SEARCH_SOURCES as typeof SEARCH_SOURCES
      : SEARCH_SOURCES;
    const source = sources.find(s => s.name === 'session_turn')!;
    // A small corpus may choose a sequential scan. The existing scan-score guard then
    // warns and reruns with standalone scores; that expected path must stay observable.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rows = await source.lexical({ sql: sql as unknown as PgHandle, query: fragment,
        workspaceId: 'mine', scopeFilter: null, limit: 2, wantHighlight: false });
      for (const args of warn.mock.calls) expect(args.join(' ')).toMatch(/bm25_get_current_score\(\) disagreed.*no BM25 index scan drove the list/);
      expect(rows).toHaveLength(2);
      expect(rows.find(r => r.row.source_id === 'claude:same:0')?.row.excerpt).toContain('OWNMARKER');
      expect(rows.map(r => r.row.excerpt).join('\n')).not.toContain('FOREIGNMARKER');
    } finally { warn.mockRestore(); }
  } finally {
    if (saved === undefined) delete process.env[envKey]; else process.env[envKey] = saved;
    resetBm25Availability();
  }
}, 120_000);
