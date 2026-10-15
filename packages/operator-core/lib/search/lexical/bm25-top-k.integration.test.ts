/**
 * `bm25TopK` (plan bm25-lexical-search-evoke-adoption-2026-10-10, R-18 / D-019): the BM25
 * top-k shape the work_item and session_turn search sources read their lexical list from.
 *
 * Two properties carry the R-18 latency fix, and both are pinned here:
 *  1. SAME ROWS as the seam's filter-then-limit form (`WHERE leg.match ORDER BY leg.order
 *     LIMIT k`), for limits below, at and above the match count, and never a non-match.
 *  2. The `<@>` distance is NOT a per-row Filter on the plan (it is selected once and tested
 *     after the LIMIT). The filter-then-limit form is the both-ways control: its plan does
 *     carry that Filter, so this assertion is not vacuous.
 *
 * And the scan-score form (`runBm25TopK`, BM25_SCAN_SCORE_NOTE in rank.ts, D-023):
 *  3. Under a BM25 index scan, `bm25_get_current_score()` gives the same rows and the same
 *     distances as the standalone `<@>`, with no fallback. If a pg_textsearch upgrade changes
 *     what that undocumented function returns, this fails.
 *  4. With no BM25 index scan driving the rows, the function returns stale state (control:
 *     the unguarded list is wrong), and `runBm25TopK` catches it and re-runs standalone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  bm25Leg,
  bm25ScanScoreFallbacks,
  bm25TopK,
  readBm25ScanScore,
  resetBm25ScanScoreFallbacks,
  runBm25TopK,
  type Bm25TopKRequest,
  type SqlFragment,
} from './rank';
import { bm25Corpus } from './corpora';
import { seedBm25Corpus, startBm25TestDb, type Bm25TestDb } from './test-pg/bm25-test-db';

let db: Bm25TestDb;
let sql: Sql;

// Workspace 'tk': MATCHES rows carry the probe term 1..MATCHES times (distinct BM25
// distances, checked below), NON_MATCHES rows never do.
const WS = 'tk';
const TERM = 'zebu';
const MATCHES = 12;
const NON_MATCHES = 20;
const BASE_ID = 7001;

beforeAll(async () => {
  db = await startBm25TestDb();
  sql = db.sql;
  await seedBm25Corpus(sql);
  const rows = [
    ...Array.from({ length: MATCHES }, (_, i) => ({
      id: BASE_ID + i, ws: WS, title: `probe row ${i}`, summary: 'plain summary',
      notes: `${Array.from({ length: i + 1 }, () => TERM).join(' ')} filler text`,
    })),
    ...Array.from({ length: NON_MATCHES }, (_, i) => ({
      id: BASE_ID + 100 + i, ws: WS, title: `other row ${i}`, summary: 'plain summary', notes: 'filler text only',
    })),
  ];
  await sql`INSERT INTO harness_shared.work_items ${sql(rows)}`;
}, 600_000);

afterAll(async () => {
  await db?.close();
});

function leg() {
  const l = bm25Leg(sql, bm25Corpus('work_items'), TERM, 'w');
  if (!l.distance) throw new Error('bm25Leg returned no distance');
  return { ...l, distance: l.distance };
}

function topK(limit: number) {
  const l = leg();
  return bm25TopK(sql, {
    distance: l.distance,
    columns: sql`w.id`,
    from: sql`harness_shared.work_items w`,
    where: sql`w.ws = ${WS}`,
    limit,
  });
}

/** The seam's filter-then-limit form: the reference the top-k shape must equal. */
function filterThenLimit(limit: number) {
  const l = leg();
  return sql`
    SELECT w.id, ${l.distance} AS bm25_d FROM harness_shared.work_items w
     WHERE w.ws = ${WS} AND ${l.match}
  ORDER BY ${l.order} LIMIT ${limit}`;
}

describe('bm25TopK — same rows as filter-then-limit', () => {
  it('the probe rows have distinct distances (precondition for an order comparison)', async () => {
    const rows = await sql<{ bm25_d: number }[]>`${filterThenLimit(100)}`;
    expect(rows).toHaveLength(MATCHES);
    expect(new Set(rows.map((r) => r.bm25_d)).size).toBe(MATCHES);
  });

  for (const limit of [5, MATCHES, 30]) {
    it(`limit ${limit}: identical ids in identical order, matches only`, async () => {
      const got = await sql<{ id: number; bm25_d: number }[]>`SELECT s.id, s.bm25_d FROM (${topK(limit)}) s ORDER BY s.bm25_d`;
      const want = await sql<{ id: number }[]>`${filterThenLimit(limit)}`;
      expect(got.map((r) => r.id)).toEqual(want.map((r) => r.id));
      expect(got).toHaveLength(Math.min(limit, MATCHES));
      expect(got.every((r) => r.bm25_d < 0)).toBe(true);
    });
  }
});

describe('bm25TopK — the distance is evaluated once, not as a per-row filter', () => {
  async function planLines(q: SqlFragment): Promise<string[]> {
    const rows = await sql<{ 'QUERY PLAN': string }[]>`EXPLAIN (VERBOSE, COSTS OFF) ${q}`;
    return rows.map((r) => r['QUERY PLAN']);
  }
  const distanceFilter = (lines: string[]) => lines.filter((l) => /Filter:.*<@>/.test(l));

  it('control: the filter-then-limit plan re-evaluates <@> as a row Filter', async () => {
    expect(distanceFilter(await planLines(filterThenLimit(10)))).not.toHaveLength(0);
  });

  it('the top-k plan has no <@> row Filter (the match test runs on the selected value)', async () => {
    const lines = await planLines(sql`SELECT s.id FROM (${topK(10)}) s ORDER BY s.bm25_d`);
    expect(distanceFilter(lines)).toEqual([]);
    expect(lines.some((l) => /Filter:.*bm25_d < /.test(l))).toBe(true);
  });
});

describe('runBm25TopK — the score read from the BM25 index scan (BM25_SCAN_SCORE_NOTE)', () => {
  type Row = { id: number; bm25_d: number };
  const MISSING = 'zzyzxnomatch';

  function scanReq(term: string, limit: number): Bm25TopKRequest {
    const l = bm25Leg(sql, bm25Corpus('work_items'), term, 'w');
    if (!l.distance) throw new Error('bm25Leg returned no distance');
    return {
      distance: l.distance,
      scanScore: sql`bm25_get_current_score()`,
      columns: sql`w.id`,
      from: sql`harness_shared.work_items w`,
      where: sql`w.ws = ${WS}`,
      limit,
    };
  }

  /** Runs `body` in a transaction whose planner settings force (or forbid) the BM25 index scan. */
  async function inTx<T>(indexScan: boolean, body: (tx: Sql) => Promise<T>): Promise<T> {
    let out!: T;
    await sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      if (indexScan) {
        await tx.unsafe('SET LOCAL enable_seqscan = off');
        await tx.unsafe('SET LOCAL enable_bitmapscan = off');
        await tx.unsafe('SET LOCAL enable_sort = off');
      } else {
        // Leave a NEGATIVE stale score behind first: a BM25 index scan (forced, or a small
        // table may seq-scan it and leave the fresh-backend 0) ending on a match. Then
        // forbid index scans, so the list below is a seq scan + sort.
        await tx.unsafe('SET LOCAL enable_seqscan = off');
        await tx.unsafe('SET LOCAL enable_bitmapscan = off');
        await tx`SELECT w.id FROM harness_shared.work_items w WHERE w.ws = ${WS} ORDER BY ${scanReq(TERM, 1).distance} LIMIT 3`;
        await tx.unsafe('SET LOCAL enable_seqscan = on');
        await tx.unsafe('SET LOCAL enable_indexscan = off');
      }
      out = await body(tx);
    });
    return out;
  }

  const runList = (tx: Sql) => (topK: SqlFragment) =>
    tx<Row[]>`SELECT s.id, s.bm25_d FROM (${topK}) s ORDER BY s.bm25_d` as unknown as Promise<Row[]>;

  it('precondition: the server has bm25_get_current_score()', async () => {
    expect(await readBm25ScanScore(sql)).toBe(true);
  });

  it('under a BM25 index scan: the plan uses the BM25 index (so the fast path is what is tested)', async () => {
    const lines = await inTx(true, async (tx) =>
      (await tx<{ 'QUERY PLAN': string }[]>`EXPLAIN (COSTS OFF) ${bm25TopK(sql, scanReq(TERM, 30))}`).map((r) => r['QUERY PLAN']),
    );
    expect(lines.some((l) => /Index Scan using \S*bm25\S* on work_items/.test(l))).toBe(true);
    expect(lines.some((l) => /Seq Scan/.test(l))).toBe(false);
  });

  for (const limit of [5, MATCHES, 30]) {
    it(`under a BM25 index scan, limit ${limit}: same ids, same distances as standalone, no fallback`, async () => {
      resetBm25ScanScoreFallbacks();
      const got = await inTx(true, (tx) => runBm25TopK(sql, tx, scanReq(TERM, limit), runList(tx), (r) => Number(r.bm25_d)));
      const want = await sql<Row[]>`${filterThenLimit(limit)}`;
      expect(got.map((r) => r.id)).toEqual(want.map((r) => r.id));
      got.forEach((r, i) => expect(Number(r.bm25_d)).toBeCloseTo(Number(want[i].bm25_d), 3));
      expect(bm25ScanScoreFallbacks()).toBe(0);
    });
  }

  it('under a BM25 index scan, no match: empty, no fallback', async () => {
    resetBm25ScanScoreFallbacks();
    const got = await inTx(true, (tx) => runBm25TopK(sql, tx, scanReq(MISSING, 30), runList(tx), (r) => Number(r.bm25_d)));
    expect(got).toEqual([]);
    expect(bm25ScanScoreFallbacks()).toBe(0);
  });

  it('control: with no BM25 index scan the UNGUARDED scan-score list is wrong (stale state)', async () => {
    const got = await inTx(false, (tx) => runList(tx)(bm25TopK(sql, scanReq(TERM, 30))));
    const want = await sql<Row[]>`${filterThenLimit(30)}`;
    // The stale value is one constant on every row, so it cannot reproduce MATCHES distinct
    // distances, and it keeps the non-matches (32 rows in the workspace, 30 returned).
    expect(new Set(got.map((r) => Number(r.bm25_d))).size).toBe(1);
    expect(got.map((r) => r.id)).not.toEqual(want.map((r) => r.id));
  });

  it('with no BM25 index scan: runBm25TopK catches the stale score and re-runs standalone', async () => {
    resetBm25ScanScoreFallbacks();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const got = await inTx(false, (tx) => runBm25TopK(sql, tx, scanReq(TERM, 30), runList(tx), (r) => Number(r.bm25_d)));
      const want = await sql<Row[]>`${filterThenLimit(30)}`;
      expect(got.map((r) => r.id)).toEqual(want.map((r) => r.id));
      got.forEach((r, i) => expect(Number(r.bm25_d)).toBeCloseTo(Number(want[i].bm25_d), 6));
      expect(bm25ScanScoreFallbacks()).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/BM25_SCAN_SCORE_NOTE/);
    } finally {
      warn.mockRestore();
    }
  });

  it('with no BM25 index scan and no match: the stale non-matches are caught and the list is empty', async () => {
    resetBm25ScanScoreFallbacks();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const got = await inTx(false, (tx) => runBm25TopK(sql, tx, scanReq(MISSING, 30), runList(tx), (r) => Number(r.bm25_d)));
      expect(got).toEqual([]);
      expect(bm25ScanScoreFallbacks()).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('without scanScore runBm25TopK is the plain top-k list (no check query, no fallback)', async () => {
    resetBm25ScanScoreFallbacks();
    const req = { ...scanReq(TERM, 30), scanScore: null };
    const got = await inTx(false, (tx) => runBm25TopK(sql, tx, req, runList(tx), (r) => Number(r.bm25_d)));
    const want = await sql<Row[]>`${filterThenLimit(30)}`;
    expect(got.map((r) => r.id)).toEqual(want.map((r) => r.id));
    expect(bm25ScanScoreFallbacks()).toBe(0);
  });
});
