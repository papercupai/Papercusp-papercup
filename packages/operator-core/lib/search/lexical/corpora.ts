/**
 * corpora.ts — the single registry of BM25 (pg_textsearch) lexical corpora.
 * Plan bm25-lexical-search-evoke-adoption-2026-10-10, decision D-003 §3.
 *
 * One entry per table that lexical search ranks over. Each entry names its BM25 index
 * (always passed explicitly to `to_bm25query(q, '<index>')`) and the indexed text
 * expression. `renderBm25TextExpr(corpus)` (unqualified) must be byte-identical to that
 * corpus's row in migration 1447's `harness_shared.bm25_corpus_indexes()`, which is the
 * DDL source of truth; `corpora.test.ts` pins the two together. A query repeats the same
 * expression in `ORDER BY <expr> <@> to_bm25query(...)` so the planner matches the
 * expression index — pass a table alias to qualify the columns.
 *
 * Field weights (setweight A/B/C in the legacy tsvector columns) are not representable in
 * pg_textsearch, so the index covers the concatenated text; the P-001 bake-off measured
 * exactly that shape (D-002).
 */

export type Bm25TextConfig = 'english' | 'simple';

export interface Bm25Corpus {
  /** Base table in `harness_shared`. */
  readonly table: string;
  /** BM25 index name in `harness_shared`. */
  readonly indexName: string;
  /**
   * Indexed text expression with column names written as `{column}`; rendered by
   * `renderBm25TextExpr`. Columns are concatenated with a single space.
   */
  readonly textExprTemplate: string;
  readonly textConfig: Bm25TextConfig;
  /** The legacy `tsvector` column the `ts_rank_cd` fallback ranks with. */
  readonly legacyTsvColumn: string;
  /**
   * Set when a BM25-live search source still reads the stored legacy column and its GIN
   * index, so legacy-column retirement (migration 1452, `bm25_retire_legacy_columns()`)
   * must keep both on this corpus. `'exact-list'`: the source fuses an exact list (legacy
   * AND + `ts_rank_cd`) with its BM25 list (plan decision D-016). `corpora.test.ts` pins
   * this set to the retirement list and to the exact-list sources in `sources.ts`.
   */
  readonly keepLegacyColumn?: 'exact-list';
}

const TITLE_DESCRIPTION = "coalesce({title}, '') || ' ' || coalesce({description}, '')";

export const BM25_CORPORA = [
  {
    table: 'work_items', indexName: 'work_items_bm25', textConfig: 'english', legacyTsvColumn: '_search',
    textExprTemplate: "coalesce({title}, '') || ' ' || coalesce({summary}, '') || ' ' || coalesce({notes}, '')",
    keepLegacyColumn: 'exact-list',
  },
  {
    table: 'harness_plans', indexName: 'harness_plans_bm25', textConfig: 'english', legacyTsvColumn: '_search',
    textExprTemplate: "coalesce({title}, '') || ' ' || coalesce({content}, '')",
    keepLegacyColumn: 'exact-list',
  },
  {
    table: 'goals', indexName: 'goals_bm25', textConfig: 'english', legacyTsvColumn: '_search',
    textExprTemplate: "coalesce({title}, '') || ' ' || coalesce({body}, '')",
  },
  {
    table: 'report_library', indexName: 'report_library_bm25', textConfig: 'english', legacyTsvColumn: 'search_tsv',
    textExprTemplate:
      "coalesce({title}, '') || ' ' || coalesce({summary}, '') || ' ' || coalesce({subject_label}, '') || ' ' || left(coalesce({body_md}, ''), 200000)",
  },
  {
    table: 'session_turns', indexName: 'session_turns_bm25', textConfig: 'english', legacyTsvColumn: 'text_tsv',
    textExprTemplate: "left(coalesce({text}, ''), 20000)",
    keepLegacyColumn: 'exact-list',
  },
  {
    table: 'documents', indexName: 'documents_bm25', textConfig: 'english', legacyTsvColumn: 'text_tsv',
    textExprTemplate: "coalesce({title}, '') || ' ' || coalesce({text}, '')",
  },
  {
    table: 'coord_thread_posts', indexName: 'coord_thread_posts_bm25', textConfig: 'english', legacyTsvColumn: 'body_tsv',
    textExprTemplate: "coalesce({body}, '')",
  },
  {
    table: 'code_recipes', indexName: 'code_recipes_bm25', textConfig: 'english', legacyTsvColumn: 'title_tsv',
    textExprTemplate: TITLE_DESCRIPTION,
  },
  {
    table: 'datatype_registry', indexName: 'datatype_registry_bm25', textConfig: 'english', legacyTsvColumn: 'title_tsv',
    textExprTemplate: TITLE_DESCRIPTION,
  },
  {
    table: 'event_key_registry', indexName: 'event_key_registry_bm25', textConfig: 'english', legacyTsvColumn: 'title_tsv',
    textExprTemplate: TITLE_DESCRIPTION,
  },
  {
    table: 'capability_class_registry', indexName: 'capability_class_registry_bm25', textConfig: 'english', legacyTsvColumn: 'title_tsv',
    textExprTemplate: TITLE_DESCRIPTION,
  },
  {
    table: 'audit_log', indexName: 'audit_log_bm25', textConfig: 'simple', legacyTsvColumn: '_search',
    textExprTemplate: "coalesce({subject}, '') || ' ' || coalesce({action}, '') || ' ' || coalesce({actor}, '')",
  },
  {
    table: 'harness_escalations', indexName: 'harness_escalations_bm25', textConfig: 'english', legacyTsvColumn: 'body_tsv',
    textExprTemplate: "coalesce({escalation}, '') || ' ' || coalesce({supervisor_notes}, '')",
  },
  {
    table: 'harness_decisions', indexName: 'harness_decisions_bm25', textConfig: 'english', legacyTsvColumn: 'body_tsv',
    textExprTemplate: "coalesce({verb}, '') || ' ' || coalesce({args}, '')",
  },
  {
    table: 'harness_brainstorm', indexName: 'harness_brainstorm_bm25', textConfig: 'english', legacyTsvColumn: 'content_tsv',
    textExprTemplate: "coalesce({content}, '')",
  },
] as const satisfies readonly Bm25Corpus[];

export type Bm25CorpusTable = (typeof BM25_CORPORA)[number]['table'];

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

/** The registry entry for `table`; throws on an unregistered table. */
export function bm25Corpus(table: Bm25CorpusTable): Bm25Corpus {
  const corpus = BM25_CORPORA.find(c => c.table === table);
  if (!corpus) throw new Error(`bm25Corpus: ${table} is not a registered BM25 corpus`);
  return corpus;
}

/**
 * Renders the indexed text expression. With no alias it is the exact text in migration
 * 1447; with an alias every column is qualified (`w.title`) for queries that join.
 */
export function renderBm25TextExpr(corpus: Bm25Corpus, alias?: string): string {
  if (alias !== undefined && !SAFE_IDENT.test(alias)) throw new Error(`renderBm25TextExpr: unsafe alias ${JSON.stringify(alias)}`);
  return corpus.textExprTemplate.replace(/\{([a-z_][a-z0-9_]*)\}/g, (_m, col: string) => (alias ? `${alias}.${col}` : col));
}

/** The columns an expression reads, in first-use order. */
export function bm25TextColumns(corpus: Bm25Corpus): string[] {
  return [...new Set([...corpus.textExprTemplate.matchAll(/\{([a-z_][a-z0-9_]*)\}/g)].map(m => m[1]!))];
}

/**
 * The row this corpus contributes to `harness_shared.bm25_corpus_indexes()` in migration
 * 1447, as it appears in the SQL text. `corpora.test.ts` asserts each one is present
 * verbatim.
 */
export function bm25CorpusSqlRow(corpus: Bm25Corpus): string {
  return `('${corpus.indexName}', '${corpus.table}', $e$${renderBm25TextExpr(corpus)}$e$, '${corpus.textConfig}')`;
}
