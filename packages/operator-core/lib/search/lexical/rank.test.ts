/**
 * fuseByPosition — merging best-first lists from different corpora by position, never by
 * raw score (plan bm25-lexical-search-evoke-adoption-2026-10-10 D-006).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { RRF_K_DEFAULT } from '@papercusp/rrf';
import {
  EXACT_LIST_MAX_AND_ROWS,
  fuseByPosition,
  bm25LegIfAvailable,
  lexicalLeg,
  mergeExactAndBm25,
  measureWarmBm25QueryLatencies,
  resetBm25Availability,
  usesWebsearchOperators,
} from './rank';
import type { AvailabilityEntry } from './rank';
import type { Sql } from 'postgres';

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => true) }));

const RANK_SOURCE = readFileSync(new URL('./rank.ts', import.meta.url), 'utf8');

describe('BM25 latency canary path', () => {
  it('uses the guarded top-k scan-score path instead of repeating standalone scores', () => {
    const start = RANK_SOURCE.indexOf('export async function measureBm25Latency(');
    const end = RANK_SOURCE.indexOf('export interface Bm25Health', start);
    const source = RANK_SOURCE.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(source).toMatch(/runBm25TopK(?:<[^>]+>)?\(/);
    expect(source).toContain('scanScore');
    expect(source).not.toContain('leg.score');
    expect(source).not.toContain('leg.match');
    expect(source).not.toContain('leg.order');
  });
});

describe('measureWarmBm25QueryLatencies', () => {
  it('warms every canary before collecting the measured samples', async () => {
    const queries = ['search ranking', 'test failure', 'plan item'];
    const calls: string[] = [];
    let clock = 0;

    const samples = await measureWarmBm25QueryLatencies(
      queries,
      async (query) => {
        calls.push(query);
        clock += 10;
      },
      () => clock,
    );

    expect(calls).toEqual([...queries, ...queries]);
    expect(samples).toEqual([10, 10, 10]);
  });
});

function catalogSql(indexes: string[] = []) {
  const queries: string[] = [];
  const sql = Object.assign(
    ((strings: TemplateStringsArray) => {
      const query = strings.join('?');
      queries.push(query);
      if (query.includes('FROM pg_index')) return Promise.resolve(indexes.map((name) => ({ name })));
      if (query.includes('to_regprocedure')) return Promise.resolve([{ ok: true }]);
      return Promise.resolve([]);
    }) as unknown as import('postgres').Sql,
    { unsafe: vi.fn((fragment: string) => ({ fragment })) },
  );
  return { sql, queries };
}

describe('BM25 availability cache', () => {
  it('attaches the scan-score fragment to the BM25 lexical leg', async () => {
    resetBm25Availability();
    const { sql, queries } = catalogSql(['work_items_bm25']);
    const leg = await lexicalLeg(sql, {
      table: 'work_items',
      query: 'search ranking',
      legacy: { score: sql`legacy score`, match: sql`legacy match` },
    });

    expect(leg.engine).toBe('bm25');
    expect(leg.scanScore).toBeDefined();
    expect(queries.some((query) => query.includes('to_regprocedure'))).toBe(true);
  });

  it('uses a transaction client for cache-miss reads and retains the original client as cache key', async () => {
    resetBm25Availability();
    const owner = catalogSql();
    const transaction = catalogSql(['session_turns_bm25']);

    const loadAvailability = vi.fn(async (read: (sql: Sql) => Promise<AvailabilityEntry>) =>
      await read(transaction.sql));
    const first = await bm25LegIfAvailable(owner.sql, 'session_turns', 'query', undefined, {
      availabilityLoader: loadAvailability,
    });

    expect(first?.engine).toBe('bm25');
    expect(owner.queries.filter((query) => query.includes('FROM pg_index') || query.includes('to_regprocedure'))).toEqual([]);
    expect(transaction.queries.filter((query) => query.includes('FROM pg_index'))).toHaveLength(1);
    expect(transaction.queries.filter((query) => query.includes('to_regprocedure'))).toHaveLength(1);
    expect(loadAvailability).toHaveBeenCalledOnce();

    const cacheHit = await bm25LegIfAvailable(owner.sql, 'session_turns', 'query', undefined, {
      availabilityLoader: loadAvailability,
    });
    expect(cacheHit?.engine).toBe('bm25');
    expect(loadAvailability).toHaveBeenCalledOnce();
    expect(transaction.queries).toHaveLength(2);
    expect(owner.queries.filter((query) => query.includes('FROM pg_index') || query.includes('to_regprocedure'))).toEqual([]);
  });

  it('does not cache a catalog result when its source signal aborts during the bounded loader', async () => {
    resetBm25Availability();
    const owner = catalogSql();
    const aborted = new AbortController();
    let finishLoad!: (entry: AvailabilityEntry) => void;
    const pending = new Promise<AvailabilityEntry>((resolve) => { finishLoad = resolve; });
    const loader = vi.fn(async () => await pending);
    const first = bm25LegIfAvailable(owner.sql, 'session_turns', 'query', undefined, {
      availabilityLoader: loader,
      signal: aborted.signal,
    });

    aborted.abort(new Error('source budget expired'));
    finishLoad({ indexes: new Set(['session_turns_bm25']), scanScore: true, checkedAt: Date.now() });
    await expect(first).rejects.toMatchObject({ message: 'source budget expired' });

    const cacheMiss = catalogSql();
    await bm25LegIfAvailable(owner.sql, 'session_turns', 'query', undefined, {
      availabilityLoader: async (read) => await read(cacheMiss.sql),
    });
    expect(cacheMiss.queries.some((query) => query.includes('FROM pg_index'))).toBe(true);
  });
});

describe('mergeExactAndBm25 (R-13, D-016)', () => {
  type R = { id: string; rank: number };
  const id = (r: R) => r.id;

  it('interleaves BM25 then exact, and keeps a row both lists found once, at its earlier slot', () => {
    const exact: R[] = [{ id: 'target', rank: 0.9 }, { id: 'e2', rank: 0.5 }];
    const bm25: R[] = [{ id: 'b1', rank: 30 }, { id: 'target', rank: 20 }, { id: 'b3', rank: 10 }];
    const merged = mergeExactAndBm25(exact, bm25, id, 10);
    expect(merged.map(r => r.id)).toEqual(['b1', 'target', 'e2', 'b3']);
    expect(merged.filter(r => r.id === 'target')).toHaveLength(1);
  });

  it('keeps a fragment target the exact list ranks first inside the top results even when BM25 never found it', () => {
    // BM25 ranks the target past its whole list, the exact list ranks it 1.
    const bm25: R[] = Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, rank: 100 - i }));
    const exact: R[] = [{ id: 'target', rank: 0.4 }];
    const merged = mergeExactAndBm25(exact, bm25, id, 10);
    expect(merged.map(r => r.id).indexOf('target')).toBe(1);
  });

  it('keeps the exact rank-1 row in the top two when many rows overlap both lists (R-13 run 12, D-032)', () => {
    // The measured shape: exact rank 1 / BM25 rank 58 for the target, and 21 of the two
    // top-30 lists' rows in both. Reciprocal-rank fusion put the target at position 22.
    const pairs: Array<[number, number]> = [
      [2, 3], [3, 5], [4, 20], [6, 12], [8, 1], [9, 16], [10, 22], [11, 2], [12, 18], [13, 21], [14, 4],
      [15, 26], [16, 24], [17, 27], [18, 6], [19, 23], [22, 14], [24, 13], [25, 9], [29, 11], [30, 29],
    ];
    const exact: R[] = Array.from({ length: 30 }, (_, i) => ({ id: `e${i + 1}`, rank: 1 - i / 100 }));
    const bm25: R[] = Array.from({ length: 30 }, (_, i) => ({ id: `b${i + 1}`, rank: 50 - i }));
    exact[0] = { id: 'target', rank: 1 };
    for (const [e, b] of pairs) bm25[b - 1] = { id: `e${e}`, rank: 50 - (b - 1) };
    const merged = mergeExactAndBm25(exact, bm25, id, 30);
    expect(merged.map(r => r.id).indexOf('target')).toBe(1);
    expect(new Set(merged.map(r => r.id)).size).toBe(merged.length);
  });

  it('bounds every row by its better list: exact rank r at position <= 2r, BM25 rank r at <= 2r-1', () => {
    const exact: R[] = Array.from({ length: 20 }, (_, i) => ({ id: `x${(i * 7) % 20}`, rank: 20 - i }));
    const bm25: R[] = Array.from({ length: 20 }, (_, i) => ({ id: `x${(i * 3) % 20}`, rank: 20 - i }));
    const pos = new Map(mergeExactAndBm25(exact, bm25, id, 40).map((r, i) => [r.id, i + 1]));
    exact.forEach((r, i) => expect(pos.get(r.id)!).toBeLessThanOrEqual(2 * (i + 1)));
    bm25.forEach((r, i) => expect(pos.get(r.id)!).toBeLessThanOrEqual(2 * (i + 1) - 1));
  });

  it('carries the best original ordinal on the RRF scale, never either raw scale (D-039)', () => {
    const merged = mergeExactAndBm25([{ id: 'e', rank: 0.001 }], [{ id: 'b', rank: 999 }], id, 10);
    expect(merged.map(r => r.id)).toEqual(['b', 'e']);
    expect(merged[0].rank).toBeCloseTo(1 / (RRF_K_DEFAULT + 1), 12);
    expect(merged[1].rank).toBeCloseTo(1 / (RRF_K_DEFAULT + 1), 12);
    expect(merged.map(r => r.fusionRank)).toEqual([1, 1]);
  });

  it('returns the BM25 list unchanged in order when the exact list is empty, and honours limit', () => {
    const bm25: R[] = [{ id: 'a', rank: 3 }, { id: 'b', rank: 2 }, { id: 'c', rank: 1 }];
    expect(mergeExactAndBm25([], bm25, id, 2).map(r => r.id)).toEqual(['a', 'b']);
    expect(mergeExactAndBm25([], bm25, id, 0)).toEqual([]);
  });

  it('caps the exact list at a population that admits every measured R-13 loss (largest AND set 3,925)', () => {
    expect(EXACT_LIST_MAX_AND_ROWS).toBeGreaterThanOrEqual(3925);
  });
});

describe('usesWebsearchOperators (plan D-007)', () => {
  it.each(['"exact phrase"', 'report -draft', '-draft report', 'gate or deploy', 'gate OR deploy', 'a "b c" d'])(
    'detects websearch syntax in %j',
    (q) => expect(usesWebsearchOperators(q)).toBe(true),
  );

  it.each(['plain words only', 'pre-release gate', 'oracle orbit', 'or', 'error-or-warning', 'x - y', ''])(
    'treats %j as a plain query',
    (q) => expect(usesWebsearchOperators(q)).toBe(false),
  );
});

type Row = { id: string; score: number };
const key = (r: Row) => r.id;

describe('fuseByPosition', () => {
  it('interleaves lists by position whatever their score scales', () => {
    const bm25: Row[] = [{ id: 'a', score: 14 }, { id: 'b', score: 9 }, { id: 'c', score: 7 }];
    const tsRank: Row[] = [{ id: 'x', score: 0.09 }, { id: 'y', score: 0.01 }];
    const fused = fuseByPosition([{ name: 'bm25', rows: bm25, key }, { name: 'ts', rows: tsRank, key }]);
    expect(fused.map(f => f.row.id)).toEqual(['a', 'x', 'b', 'y', 'c']);
    expect(fused[0]).toMatchObject({ list: 'bm25', position: 1, score: 1 / (RRF_K_DEFAULT + 1) });
    expect(fused[3]).toMatchObject({ list: 'ts', position: 2, score: 1 / (RRF_K_DEFAULT + 2) });
  });

  it('is invariant to rescaling any list', () => {
    const a: Row[] = [{ id: 'a1', score: 3 }, { id: 'a2', score: 2 }];
    const b: Row[] = [{ id: 'b1', score: 0.3 }, { id: 'b2', score: 0.2 }];
    const scaled = b.map(r => ({ ...r, score: r.score * 1000 }));
    const order = (rows: Row[]) => fuseByPosition([{ name: 'a', rows: a, key }, { name: 'b', rows, key }]).map(f => f.row.id);
    expect(order(scaled)).toEqual(order(b));
  });

  it('keeps rows of different lists that share a key apart', () => {
    const fused = fuseByPosition([
      { name: 'goals', rows: [{ id: 'same', score: 1 }], key },
      { name: 'audit', rows: [{ id: 'same', score: 1 }], key },
    ]);
    expect(fused.map(f => `${f.list}:${f.row.id}`)).toEqual(['goals:same', 'audit:same']);
  });

  it('returns nothing for empty input', () => {
    expect(fuseByPosition<Row>([])).toEqual([]);
    expect(fuseByPosition<Row>([{ name: 'a', rows: [], key }])).toEqual([]);
  });
});
