/**
 * rank.ts — the one lexical-ranking seam (plan bm25-lexical-search-evoke-adoption-2026-10-10
 * P-005, decision D-003 §4).
 *
 * A call site that ranks rows of a registered corpus by a free-text query asks this module
 * for its lexical leg and splices the returned fragments into its own SELECT:
 *
 *   const leg = await lexicalLeg(sql, {
 *     table: 'code_recipes', query,
 *     legacy: { score: sql`ts_rank_cd(title_tsv, ${tq})`, match: sql`title_tsv @@ ${tq}` },
 *   });
 *   sql`SELECT id, ${leg.score} AS rank FROM harness_shared.code_recipes
 *        WHERE status = 'active' AND ${leg.match} ORDER BY ${leg.order}, id LIMIT ${limit}`
 *
 * ENGINE CHOICE, per call: BM25 (pg_textsearch) when the BM25_LEXICAL_RANKING flag is on
 * AND the corpus's BM25 index is present and valid in this database with the library
 * loaded; otherwise the caller's legacy ts_rank fragments, unchanged. The fallback is never
 * silent: `bm25Health` (the P-004 health check) reports `degraded` whenever the flag is on
 * and an expected index, the extension or the library is missing.
 *
 * BM25 SHAPE (measured on pg_textsearch 1.5.1, see migration 1447):
 *  - `<expr> <@> to_bm25query(q, '<schema>.<index>')` is a NEGATIVE distance, so
 *    score = -distance and ORDER BY the distance ascending, written as the bare operator
 *    expression so the planner can drive the scan from the BM25 index.
 *  - the index name must be schema-qualified: an unqualified name fails "index does not
 *    exist" whenever the plan is not that index scan.
 *  - a filtered index scan also returns NON-matching rows at distance 0, so `match`
 *    keeps `distance < 0`.
 *  - the query text is tokenized by the index's text config; operators such as `&` or `(`
 *    are ignored, so any user string is safe to pass.
 */
import type { PendingQuery, Row, Sql } from 'postgres';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { pinModuleState } from '@papercusp/module-singleton';
import { observeFallback as recordFallback } from '../../degradation/fallback-observations';
import { RRF_K_DEFAULT, rrfCombine } from '@papercusp/rrf';
import { BM25_CORPORA, bm25Corpus, renderBm25TextExpr, type Bm25Corpus, type Bm25CorpusTable } from './corpora';

/** A postgres.js SQL fragment, spliced with `${fragment}` into a tagged template. */
export type SqlFragment = PendingQuery<Row[]>;

export type LexicalEngine = 'bm25' | 'legacy';

export interface LexicalLeg {
  engine: LexicalEngine;
  /** Relevance, higher is better. Not comparable across engines. */
  score: SqlFragment;
  /** WHERE predicate: the row matches the query. */
  match: SqlFragment;
  /** ORDER BY body, best first (append the caller's tie-breakers after it). */
  order: SqlFragment;
  /**
   * BM25 only: the raw `<@>` distance (negative = match, lower = better). Set by `bm25Leg`
   * for `bm25TopK`, which evaluates it once per row; `score`/`match` re-evaluate it each.
   */
  distance?: SqlFragment;
  /**
   * BM25 only, and only when the server has `bm25_get_current_score()` (BM25_SCAN_SCORE_NOTE):
   * the distance of the row the BM25 index scan just returned, read from the scan instead of
   * re-scoring the document. Set by `bm25LegIfAvailable`; consumed by `runBm25TopK`.
   */
  scanScore?: SqlFragment;
}

/** The caller's existing ts_rank ranking, used verbatim when BM25 is unavailable. */
export interface LegacyLexicalRank {
  score: SqlFragment;
  match: SqlFragment;
}

export interface LexicalLegRequest {
  table: Bm25CorpusTable;
  query: string;
  /** Table alias in the caller's FROM clause, when it has one. */
  alias?: string;
  legacy: LegacyLexicalRank;
  /**
   * `'websearch'` when the caller's legacy match parses the query with
   * `websearch_to_tsquery` and documents its syntax (quoted phrases, OR, -negation).
   * BM25 tokenizes the query and ignores that syntax, so it would turn `-draft` into a
   * positive match. When the query uses any of those operators, the BM25 leg therefore
   * keeps the legacy predicate as its match filter and BM25 only orders the rows.
   * A plain query gets BM25's own any-term match. Plan D-007.
   */
  querySyntax?: 'websearch';
}

/**
 * Whether `query` uses `websearch_to_tsquery` operator syntax: a double quote (phrase), the
 * word `or` between terms, or a `-` that starts a term (negation).
 */
export function usesWebsearchOperators(query: string): boolean {
  return /"/.test(query) || /(^|\s)-\S/.test(query) || /\S\s+or\s+\S/i.test(query);
}

const SCHEMA = 'harness_shared';
const AVAILABILITY_TTL_MS = 60_000;

export interface AvailabilityEntry {
  indexes: ReadonlySet<string>;
  /** `bm25_get_current_score()` exists on this server (BM25_SCAN_SCORE_NOTE). */
  scanScore: boolean;
  checkedAt: number;
}

/** A caller may wrap a catalog cache miss in a transaction while keeping the
 * cache identity tied to the original SQL client. */
export type Bm25AvailabilityLoader = (
  read: (readSql: Sql) => Promise<AvailabilityEntry>,
) => Promise<AvailabilityEntry>;

const state = pinModuleState('@papercusp/operator-core.lexical-bm25-availability', () => ({
  bySql: new WeakMap<object, AvailabilityEntry>(),
  /** `runBm25TopK` lists that failed the scan-score check and were re-run standalone. */
  scanScoreFallbacks: 0,
  scanScoreFallbackWarnedAt: 0,
}));

/**
 * Valid, ready BM25 indexes in harness_shared, by name. Empty when the pg_textsearch
 * library is not loaded in this server (an index left behind after the preload was
 * removed cannot be scanned). Never throws: a failed catalog read is "nothing available".
 */
export async function readBm25Indexes(sql: Sql): Promise<ReadonlySet<string>> {
  try {
    const rows = await sql<{ name: string }[]>`
      SELECT c.relname AS name
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am a ON a.oid = c.relam
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE a.amname = 'bm25'
         AND n.nspname = ${SCHEMA}
         AND i.indisvalid AND i.indisready
         AND current_setting('pg_textsearch.library_version', true) IS NOT NULL`;
    return new Set(rows.map(r => r.name));
  } catch {
    return new Set();
  }
}

/**
 * Whether this server has pg_textsearch's `bm25_get_current_score()` (present in 1.5.1, not
 * in the README's documented surface). Resolved through the search_path, like `to_bm25query`.
 */
export async function readBm25ScanScore(sql: Sql): Promise<boolean> {
  try {
    const [row] = await sql<{ ok: boolean }[]>`
      SELECT to_regprocedure('bm25_get_current_score()') IS NOT NULL AS ok`;
    return row?.ok === true;
  } catch {
    return false;
  }
}

async function availabilityFor(
  sql: Sql,
  loader?: Bm25AvailabilityLoader,
  signal?: AbortSignal,
): Promise<AvailabilityEntry> {
  const now = Date.now();
  signal?.throwIfAborted();
  const hit = state.bySql.get(sql);
  if (hit && now - hit.checkedAt < AVAILABILITY_TTL_MS) return hit;
  const read = async (readSql: Sql): Promise<AvailabilityEntry> => {
    const indexes = await readBm25Indexes(readSql);
    const scanScore = indexes.size > 0 && (await readBm25ScanScore(readSql));
    return { indexes, scanScore, checkedAt: Date.now() };
  };
  // Cache by the owning client, but let a caller bound/cancel catalog reads.
  // The loader is not called on a fresh cache hit.
  const entry = await (loader ? loader(read) : read(sql));
  // A bounded transaction can return a fallback after its query catches an
  // abort. Never let that partial observation warm the shared pool cache.
  signal?.throwIfAborted();
  state.bySql.set(sql, entry);
  return entry;
}

/** `readBm25Indexes`, remembered per connection pool for a minute. */
export async function bm25IndexesFor(sql: Sql): Promise<ReadonlySet<string>> {
  return (await availabilityFor(sql)).indexes;
}

/** `readBm25ScanScore`, remembered with the index availability. */
export async function bm25ScanScoreFor(sql: Sql): Promise<boolean> {
  return (await availabilityFor(sql)).scanScore;
}

/** Forget remembered availability (after creating or dropping an index, and in tests). */
export function resetBm25Availability(sql?: Sql): void {
  if (sql) state.bySql.delete(sql);
  else state.bySql = new WeakMap();
}

export async function bm25FlagOn(): Promise<boolean> {
  return getFlag(FLAGS.BM25_LEXICAL_RANKING, 'system').catch(() => true);
}

/** Which engine ranks `table` right now. */
export async function lexicalEngine(sql: Sql, table: Bm25CorpusTable): Promise<LexicalEngine> {
  if (!(await bm25FlagOn())) return 'legacy';
  return (await bm25IndexesFor(sql)).has(bm25Corpus(table).indexName) ? 'bm25' : 'legacy';
}

/** The BM25 fragments for one corpus; exported for tests and the bench. */
export function bm25Leg(sql: Sql, corpus: Bm25Corpus, query: string, alias?: string): LexicalLeg {
  const expr = sql.unsafe(renderBm25TextExpr(corpus, alias));
  const index = sql.unsafe(`'${SCHEMA}.${corpus.indexName}'`);
  const distance = () => sql`(${expr}) <@> to_bm25query(${query}::text, ${index})`;
  return {
    engine: 'bm25',
    score: sql`(-(${distance()}))::float8`,
    match: sql`(${distance()}) < 0`,
    order: distance(),
    distance: distance(),
  };
}

export interface Bm25TopKRequest {
  /** The leg's `distance` (from `bm25Leg`). */
  distance: SqlFragment;
  /** Select-list body for the inner query, e.g. sql`w.id, w.title`. Must not use `bm25_d`. */
  columns: SqlFragment;
  /** FROM body, e.g. sql`harness_shared.work_items w`. */
  from: SqlFragment;
  /** Non-BM25 filters (scope, workspace). Do NOT pass the leg's `match`. */
  where: SqlFragment;
  limit: number;
  /**
   * The leg's `scanScore`. When set, `bm25_d` is read from the index scan instead of being
   * computed by the select list (BM25_SCAN_SCORE_NOTE). Only `runBm25TopK` may pass it: the
   * value is wrong unless the BM25 index scan drives the rows, and that function checks.
   */
  scanScore?: SqlFragment | null;
}

/**
 * The top-k BM25 matches as a subquery body: `columns` plus `bm25_d` (the distance), best
 * first, matches only. Use it as `FROM (${bm25TopK(...)}) s ... ORDER BY s.bm25_d` and derive
 * the score as `-s.bm25_d`.
 *
 * Why not `SELECT ${leg.score} ... WHERE ${leg.match} ORDER BY ${leg.order} LIMIT k`: that
 * evaluates `<@>` twice per row on top of the index scan that orders by it (a per-row Filter
 * and the select list; the operator re-scores the document, the scan's value is not reused).
 * Here the distance is selected once, the inner query orders by that ALIAS (postgres.js gives
 * each interpolation fresh `$n` params, so a second copy of the expression would be a
 * separate target entry, evaluated again), and the match test runs on the computed value
 * after the LIMIT. Same rows: every match has a negative distance and every non-match (a
 * filtered scan returns them at distance 0) sorts after all matches, so limit-then-filter
 * equals filter-then-limit. Measured on the R-18 tail query (work_items, plan
 * bm25-lexical-search-evoke-adoption-2026-10-10 D-019): 234/282 ms vs 142/149 ms.
 * Pinned by bm25-top-k.integration.test.ts.
 *
 * With `req.scanScore` the select list does not score at all: see BM25_SCAN_SCORE_NOTE.
 */
export function bm25TopK(sql: Sql, req: Bm25TopKRequest): SqlFragment {
  if (req.scanScore) {
    return sql`
    SELECT * FROM (
      SELECT ${req.columns}, ${req.scanScore} AS bm25_d
        FROM ${req.from}
       WHERE ${req.where}
    ORDER BY ${req.distance}
       LIMIT ${req.limit}
    ) bm25_top
    WHERE bm25_top.bm25_d < 0`;
  }
  return sql`
    SELECT * FROM (
      SELECT ${req.columns}, ${req.distance} AS bm25_d
        FROM ${req.from}
       WHERE ${req.where}
    ORDER BY bm25_d
       LIMIT ${req.limit}
    ) bm25_top
    WHERE bm25_top.bm25_d < 0`;
}

/**
 * ─── BM25_SCAN_SCORE_NOTE (R-18, D-023) ──────────────────────────────────────
 * `<@>` in a select list is pg_textsearch's STANDALONE scoring: it re-tokenizes the whole
 * document for every output row, even though the BM25 index scan ordering those rows has
 * already scored them. Measured on the R-18 work_item tail query #35 (30 rows, documents up
 * to 59k chars): 78-96 ms with the select-list distance, 12-18 ms without it.
 *
 * pg_textsearch 1.5.1 also ships `bm25_get_current_score()`: the score of the row its index
 * scan returned last, as a distance (negative, same sign as `<@>`). Projected on the scan it
 * equals the standalone distance to float4 precision (measured max |diff| 1.4e-5). It is
 * not in the README, and it is NOT tied to the current row: with no BM25 index scan driving
 * the rows (a seq scan + sort plan, which the planner may choose for a small table or a
 * selective filter) it returns whatever the backend's last BM25 scan left behind (measured:
 * every row got the previous query's last score; a fresh backend returns 0). A stale 0 would
 * empty the list through `bm25_d < 0`; a stale negative would keep non-matches.
 *
 * So `runBm25TopK` reads the scan score and checks it. A stale value is the same constant on
 * every row, so a list of two or more rows with differing scores came from a live scan; a
 * list of zero or one rows, or with one score repeated, is checked against the standalone
 * distance of the best row (one `LIMIT 1` query that scores one document). On disagreement
 * the list is re-run with the select-list distance, counted (`bm25ScanScoreFallbacks`) and
 * logged. Pinned by bm25-top-k.integration.test.ts (fast path equals standalone under a
 * forced index scan; a forced seq scan is caught and re-run).
 */

/** Relative tolerance between the scan score (float4) and the standalone distance (float8). */
const SCAN_SCORE_TOLERANCE = 1e-4;
const SCAN_SCORE_WARN_INTERVAL_MS = 60_000;

/** How many `runBm25TopK` lists failed the scan-score check since boot (or the last reset). */
export function bm25ScanScoreFallbacks(): number {
  return state.scanScoreFallbacks;
}

/** Test seam: zero the fallback counter. */
export function resetBm25ScanScoreFallbacks(): void {
  state.scanScoreFallbacks = 0;
  state.scanScoreFallbackWarnedAt = 0;
}

/**
 * Run a call site's statement around `bm25TopK`, reading the score from the BM25 index scan
 * when `req.scanScore` is set and falling back to the select-list distance when the scan
 * score cannot be trusted (BM25_SCAN_SCORE_NOTE).
 *
 * `sql` builds the fragments; `exec` runs the one check query and must be the handle `run`
 * executes on (the caller's transaction, so its SET LOCALs apply). `run` executes the call
 * site's statement with the given top-k subquery body; `distanceOf` reads a returned row's
 * `bm25_d` (a caller that exposes `rank = -bm25_d` passes `(r) => -r.rank`).
 */
export async function runBm25TopK<R>(
  sql: Sql,
  exec: Sql,
  req: Bm25TopKRequest,
  run: (topK: SqlFragment) => Promise<R[]>,
  distanceOf: (row: R) => number,
  observeFallback: typeof recordFallback = recordFallback,
): Promise<R[]> {
  const rows = await run(bm25TopK(sql, req));
  if (!req.scanScore) return rows;
  const distances = rows.map(distanceOf);
  if (distances.length >= 2 && distances.some((d) => d !== distances[0])) {
    observeFallback('bm25-scan-score', { eligible: 1, applied: 1, reason: 'applied' });
    return rows;
  }
  const [best] = (await exec`${bm25TopK(sql, { ...req, scanScore: null, columns: sql`1 AS one`, limit: 1 })}`) as unknown as Array<{
    bm25_d: number;
  }>;
  const want = best ? Number(best.bm25_d) : null;
  const got = distances.length ? Math.min(...distances) : null;
  const agree =
    want === null
      ? got === null
      : got !== null && Math.abs(got - want) <= SCAN_SCORE_TOLERANCE * Math.max(1, Math.abs(want));
  if (agree) {
    observeFallback('bm25-scan-score', { eligible: 1, applied: 1, reason: 'applied' });
    return rows;
  }
  observeFallback('bm25-scan-score', { eligible: 1, applied: 0, reason: 'scan-score-disagreement' });
  state.scanScoreFallbacks += 1;
  const now = Date.now();
  if (now - state.scanScoreFallbackWarnedAt >= SCAN_SCORE_WARN_INTERVAL_MS) {
    state.scanScoreFallbackWarnedAt = now;
    console.warn(
      `[lexical/rank] bm25_get_current_score() disagreed with the standalone distance ` +
        `(scan ${got}, standalone ${want}, ${rows.length} rows): no BM25 index scan drove the list; ` +
        `re-ran with the select-list distance (${state.scanScoreFallbacks} since boot). BM25_SCAN_SCORE_NOTE.`,
    );
  }
  return run(bm25TopK(sql, { ...req, scanScore: null }));
}

/**
 * The BM25 leg when BM25 ranks `table` right now, else `null`. For call sites whose
 * legacy query is too structured to pass as two fragments (sources.ts `lexicalSql`):
 * they keep their own legacy branch and switch to these fragments when non-null.
 */
export async function bm25LegIfAvailable(
  sql: Sql,
  table: Bm25CorpusTable,
  query: string,
  alias?: string,
  options: { availabilityLoader?: Bm25AvailabilityLoader; signal?: AbortSignal } = {},
): Promise<LexicalLeg | null> {
  options.signal?.throwIfAborted();
  if (!(await bm25FlagOn())) return null;
  options.signal?.throwIfAborted();
  const availability = await availabilityFor(sql, options.availabilityLoader, options.signal);
  if (!availability.indexes.has(bm25Corpus(table).indexName)) return null;
  const leg = bm25Leg(sql, bm25Corpus(table), query, alias);
  return availability.scanScore ? { ...leg, scanScore: sql`bm25_get_current_score()` } : leg;
}

/**
 * The tsquery for `ts_headline` over a leg's rows. BM25 returns rows that match only SOME
 * query terms, and ts_headline's fragment mode highlights nothing in a row that does not
 * satisfy its tsquery, so under BM25 the headline uses an OR of the query's terms. The
 * legacy engine keeps the AND query its rows were matched with.
 */
export function headlineTsQuery(sql: Sql, engine: LexicalEngine, query: string): SqlFragment {
  const orTerms = query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2).join(' | ');
  return engine === 'bm25' && orTerms
    ? sql`to_tsquery('english', ${orTerms})`
    : sql`plainto_tsquery('english', ${query})`;
}

/** The lexical leg for one query over one corpus. */
export async function lexicalLeg(sql: Sql, req: LexicalLegRequest): Promise<LexicalLeg> {
  if ((await lexicalEngine(sql, req.table)) === 'bm25') {
    const leg = bm25Leg(sql, bm25Corpus(req.table), req.query, req.alias);
    if (req.querySyntax === 'websearch' && usesWebsearchOperators(req.query)) {
      return { ...leg, match: sql`(${leg.match}) AND (${req.legacy.match})` };
    }
    return leg;
  }
  return {
    engine: 'legacy',
    score: req.legacy.score,
    match: req.legacy.match,
    order: sql`${req.legacy.score} DESC`,
  };
}

/**
 * One leg's reciprocal-rank-fusion term, as a SELECT-list expression: `1 / (k + rank)` for
 * rows the leg matches, ranked by `score` among them (best first), else 0. Summing a lexical
 * term and a vector term fuses the legs by POSITION ONLY, so the fused order cannot depend on
 * a leg's score scale: BM25's unbounded score and ts_rank's [0,1) fuse identically. Use it
 * wherever a call site would otherwise add a lexical score and a cosine with weights
 * (plan bm25-lexical-search-evoke-adoption-2026-10-10 D-004). The window covers every row
 * the query returns before LIMIT, so the WHERE clause must admit both legs' candidates.
 */
export function rrfTerm(sql: Sql, matched: SqlFragment, score: SqlFragment): SqlFragment {
  const k = sql.unsafe(String(RRF_K_DEFAULT));
  return sql`(CASE WHEN ${matched}
                THEN 1.0 / (${k} + rank() OVER (ORDER BY (CASE WHEN ${matched} THEN ${score} END) DESC NULLS LAST))
                ELSE 0 END)`;
}

/** One best-first result list from one corpus, for `fuseByPosition`. */
export interface PositionedList<T> {
  name: string;
  rows: readonly T[];
  /** Identity of a row within the fused result. */
  key: (row: T) => string;
}

export interface PositionFusedRow<T> {
  row: T;
  /** Reciprocal-rank-fusion score: the merged order, comparable across lists. */
  score: number;
  /** Name of the list the row came from. */
  list: string;
  /** 1-based position of the row in that list. */
  position: number;
}

/**
 * Merge best-first result lists from DIFFERENT corpora into one ranking by position
 * (reciprocal rank fusion), never by raw score. A lexical score is not comparable across
 * corpora (each BM25 index has its own IDF statistics) or across engines (BM25 is unbounded,
 * ts_rank sits in [0,1)), so sorting the union by score lets whichever list happens to use
 * the larger scale take every slot. Equal positions keep the lists' input order. Keys are
 * scoped by list, so rows of different corpora that share an id stay distinct.
 * Plan bm25-lexical-search-evoke-adoption-2026-10-10 D-006.
 */
export function fuseByPosition<T>(lists: ReadonlyArray<PositionedList<T>>): Array<PositionFusedRow<T>> {
  const inputs = lists.map(({ name, rows, key }) => ({
    name,
    list: rows.map((row, idx) => ({
      key: `${name}\u0000${key(row)}`,
      score: 0,
      row: { row, list: name, position: idx + 1 },
    })),
  }));
  return rrfCombine(inputs).map(fused => ({ ...fused.row, score: fused.score }));
}

/**
 * The largest AND-match set for which a source runs its EXACT list beside the BM25
 * list (plan bm25-lexical-search-evoke-adoption-2026-10-10, R-13, D-016).
 *
 * Why an exact list exists at all: BM25 (pg_textsearch 1.5.1: `to_bm25query` only, no
 * AND, phrase or proximity operator) ranks a verbatim fragment of a long document far
 * down when the fragment's terms are individually common. Measured 2026-10-11 on
 * work_items for the five R-13 fragment losses: BM25 lexical rank 11, 60, 286, 402 and
 * >500, where `plainto_tsquery` AND + `ts_rank_cd` (cover density rewards adjacent
 * terms) ranks the same targets 1, 1, 2, 2, 1. A BM25 top-K rerank cannot repair it
 * affordably: a top-1000 index scan alone costs 124-232 ms against R-2's 50 ms p95.
 *
 * Why a cap: ranking the AND set reads every match's tsvector, so the cap bounds the
 * cost; below it, the exact list is legacy's ranking exactly. Measured 2026-10-11: the
 * five work-item losses had AND sets of 8, 9, 35, 609 and 1,656 rows (5-66 ms warm);
 * the one session-turn loss left at a 2,000 cap had 3,925 (gate probe 21-25 ms, list
 * 73-80 ms warm), so the cap is 5,000. The gate probe costs about the same at 2,000
 * and 5,000; a non-selective query ('the gate is red': over 10,000) is skipped, and
 * BM25 + cosine carry it.
 */
export const EXACT_LIST_MAX_AND_ROWS = 5000;

/**
 * The exact companion list's identities and cover-density scores. D-033: count and rank
 * one bounded materialization instead of scanning the same indexed match set twice.
 * Callers hydrate only these top identities. Above the cap the whole exact list is empty;
 * ranking an arbitrary truncated subset would change D-016's recall contract.
 */
export function boundedExactTopK(sql: Sql, req: {
  columns: SqlFragment;
  from: SqlFragment;
  where: SqlFragment;
  tsv: SqlFragment;
  query: string;
  limit: number;
  /** Test seam; production callers use the unchanged D-016 cap. */
  maxMatches?: number;
}): SqlFragment {
  const cap = req.maxMatches ?? EXACT_LIST_MAX_AND_ROWS;
  return sql`
    WITH exact_query AS (SELECT plainto_tsquery('english', ${req.query}) AS tq),
    exact_candidates AS MATERIALIZED (
      SELECT ${req.columns}, ${req.tsv} AS exact_tsv
        FROM ${req.from}, exact_query q
       WHERE ${req.where} AND ${req.tsv} @@ q.tq
       LIMIT ${cap + 1}
    )
    SELECT c.*, ts_rank_cd(c.exact_tsv, q.tq) AS exact_rank
      FROM exact_candidates c, exact_query q
     WHERE (SELECT count(*) FROM exact_candidates) <= ${cap}
  ORDER BY exact_rank DESC LIMIT ${req.limit}`;
}

/**
 * Merge a source's EXACT list (legacy AND + `ts_rank_cd`) with its BM25 list for the
 * SAME corpus by INTERLEAVING them: BM25 row 1, exact row 1, BM25 row 2, exact row 2, …
 * A row both lists hold appears once, at its earlier slot. Returns at most `limit` rows.
 *
 * Why not reciprocal-rank fusion (plan bm25-lexical-search-evoke-adoption-2026-10-10,
 * D-032): RRF rewards a row found by both lists, so an EXACT-ONLY row sorts below every
 * overlap row. Measured on R-13 run 12: a verbatim fragment's target was exact rank 1
 * and BM25 rank 58; 21 rows of the two top-30 lists overlapped, each scoring at least
 * 2/90 against the target's 1/61, so the merged leg carried the target at position 22
 * and the hybrid top 10 lost it. The interleave bounds every row by its better list: a
 * row at rank r in the exact list lands at position <= 2r, a BM25 rank-r row at <= 2r-1.
 * BM25 goes first because BM25 is the plan's ranking (R-1).
 *
 * D-039: interleaving admits candidates; it must not charge that position again
 * when this lexical list enters hybrid fusion. `fusionRank` carries the better
 * original ordinal and `rank` is 1/(RRF_K_DEFAULT + fusionRank). The correlated
 * lexical alternatives contribute one vote; overlap never supplies a second vote.
 * The order remains best-first, with BM25 first at tied ordinals (R-16).
 */
export function mergeExactAndBm25<T extends { rank: number }>(
  exact: readonly T[],
  bm25: readonly T[],
  key: (row: T) => string,
  limit: number,
): Array<T & { fusionRank: number }> {
  const cap = Math.max(0, limit);
  const out: Array<T & { fusionRank: number }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < Math.max(exact.length, bm25.length) && out.length < cap; i += 1) {
    for (const row of [bm25[i], exact[i]]) {
      if (row === undefined || out.length >= cap) continue;
      const k = key(row);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ ...row, fusionRank: i + 1, rank: 1 / (RRF_K_DEFAULT + i + 1) });
    }
  }
  return out;
}

export type Bm25HealthStatus = 'ok' | 'degraded' | 'off';

/** R-2's p95 budget for a lexical query on the work-item corpus. */
export const BM25_P95_BUDGET_MS = 50;

/**
 * Canary queries for the latency measurement: ordinary words with long posting lists, so
 * the probe sees a realistic slow case rather than a rare-term fast one. Fixed, so two
 * measurements are comparable.
 */
export const BM25_LATENCY_CANARY_QUERIES = [
  'search ranking', 'test failure', 'plan item', 'agent session',
  'migration index', 'release gate', 'memory recall', 'work item',
] as const;

export interface Bm25Latency {
  corpusIndex: string;
  samplesMs: number[];
  p50Ms: number;
  p95Ms: number;
  budgetMs: number;
  measuredAt: number;
}

/** Nearest-rank percentile; `samples` need not be sorted. */
export function percentileMs(samples: readonly number[], p: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

/**
 * Time the canary queries through the seam's own BM25 fragments (top-10, as callers run
 * them). `null` when the corpus has no usable BM25 index here, so there is nothing to time.
 */
export async function measureBm25Latency(
  sql: Sql,
  table: Bm25CorpusTable = 'work_items',
  queries: readonly string[] = BM25_LATENCY_CANARY_QUERIES,
): Promise<Bm25Latency | null> {
  const corpus = bm25Corpus(table);
  if (!(await readBm25Indexes(sql)).has(corpus.indexName)) return null;
  const from = sql.unsafe(`${SCHEMA}.${corpus.table}`);
  const run = (query: string) => {
    const leg = bm25Leg(sql, corpus, query);
    return sql`SELECT ${leg.score} AS score FROM ${from} WHERE ${leg.match} ORDER BY ${leg.order} LIMIT 10`;
  };
  // One untimed query first: with eight samples p95 is the slowest one, and a cold first
  // query (planning, index metapage reads) would otherwise be judged as steady-state latency.
  if (queries[0] !== undefined) await run(queries[0]);
  const samplesMs: number[] = [];
  for (const query of queries) {
    const started = performance.now();
    await run(query);
    samplesMs.push(performance.now() - started);
  }
  return {
    corpusIndex: corpus.indexName,
    samplesMs,
    p50Ms: percentileMs(samplesMs, 50),
    p95Ms: percentileMs(samplesMs, 95),
    budgetMs: BM25_P95_BUDGET_MS,
    measuredAt: Date.now(),
  };
}

export interface Bm25Health {
  status: Bm25HealthStatus;
  flagOn: boolean;
  libraryLoaded: boolean;
  extensionInstalled: boolean;
  /** Registered corpora whose table exists here but whose BM25 index is missing or invalid. */
  missingIndexes: string[];
  presentIndexes: string[];
  /** The latency measurement judged against the budget, when the caller supplied one. */
  latency: Bm25Latency | null;
  /** One line naming what is wrong, for the health surface. */
  reason: string | null;
}

/**
 * The BM25 health verdict (D-003 §4, plan item P-004): `degraded` when the flag is on but
 * lexical search is (partly) falling back to ts_rank — the library is not loaded, the
 * extension is not installed, or a registered corpus whose table exists has no valid BM25
 * index — or when a supplied latency measurement's p95 exceeds its budget (R-2).
 */
export async function bm25Health(sql: Sql, opts: { latency?: Bm25Latency | null } = {}): Promise<Bm25Health> {
  const flagOn = await bm25FlagOn();
  const [probe] = await sql<{ library: boolean; extension: boolean; tables: string[] }[]>`
    SELECT current_setting('pg_textsearch.library_version', true) IS NOT NULL AS library,
           EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_textsearch') AS extension,
           coalesce(array_agg(c.relname) FILTER (WHERE c.relname IS NOT NULL), '{}') AS tables
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${SCHEMA} AND c.relkind IN ('r', 'p')
       AND c.relname = ANY (${BM25_CORPORA.map(c => c.table)}::text[])`;
  const tables = new Set(probe?.tables ?? []);
  const present = await readBm25Indexes(sql);
  const expected = BM25_CORPORA.filter(c => tables.has(c.table)).map(c => c.indexName);
  const missingIndexes = expected.filter(name => !present.has(name));
  const presentIndexes = expected.filter(name => present.has(name));
  const libraryLoaded = probe?.library ?? false;
  const extensionInstalled = probe?.extension ?? false;
  let reason: string | null = null;
  if (!libraryLoaded) reason = 'pg_textsearch is not in shared_preload_libraries';
  else if (!extensionInstalled) reason = 'the pg_textsearch extension is not installed (run harness_shared.bm25_ensure_indexes())';
  else if (missingIndexes.length) reason = `BM25 index missing: ${missingIndexes.join(', ')}`;
  const latency = opts.latency ?? null;
  if (!reason && latency && latency.p95Ms > latency.budgetMs) {
    reason = `lexical p95 ${latency.p95Ms.toFixed(1)}ms on ${latency.corpusIndex} exceeds the ${latency.budgetMs}ms budget`;
  }
  const status: Bm25HealthStatus = !flagOn ? 'off' : reason ? 'degraded' : 'ok';
  return { status, flagOn, libraryLoaded, extensionInstalled, missingIndexes, presentIndexes, latency, reason };
}
