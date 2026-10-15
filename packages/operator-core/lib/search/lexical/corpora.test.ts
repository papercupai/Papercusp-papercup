import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BM25_CORPORA, bm25Corpus, bm25CorpusSqlRow, bm25TextColumns, renderBm25TextExpr, type Bm25Corpus } from './corpora';

const SQL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../libs/papercusp/libs/db/sql');
const DEFINES = 'FUNCTION harness_shared.bm25_corpus_indexes()';

/**
 * The newest migration that (re)defines bm25_corpus_indexes(). Armed `.sql` files win; an
 * in-progress `.sql.DRAFT` is used only when no armed file defines the function yet.
 */
function latestCorpusMigration(): { file: string; body: string } {
  const pick = (suffix: string) =>
    readdirSync(SQL_DIR)
      .filter(f => f.endsWith(suffix) && /^\d+-/.test(f))
      .map(f => ({ file: f, n: Number(f.split('-')[0]), sql: readFileSync(path.join(SQL_DIR, f), 'utf8') }))
      .filter(m => m.sql.includes(DEFINES))
      .sort((a, b) => b.n - a.n)[0];
  const m = pick('.sql') ?? pick('.sql.DRAFT');
  if (!m) throw new Error(`no migration in ${SQL_DIR} defines ${DEFINES}`);
  const start = m.sql.indexOf(DEFINES);
  const end = m.sql.indexOf('$fn$;', start);
  return { file: m.file, body: m.sql.slice(start, end) };
}

describe('BM25 corpus registry ↔ migration', () => {
  const { file, body } = latestCorpusMigration();

  it(`every registry corpus appears verbatim in ${file}`, () => {
    for (const corpus of BM25_CORPORA) expect(body, corpus.table).toContain(bm25CorpusSqlRow(corpus));
  });

  it('the migration defines no corpus the registry lacks', () => {
    const rows = [...body.matchAll(/\('([a-z0-9_]+)', '([a-z0-9_]+)', \$e\$/g)].map(m => m[1]);
    expect(rows.sort()).toEqual(BM25_CORPORA.map(c => c.indexName).sort());
  });
});

/**
 * The newest migration that (re)defines bm25_legacy_tsv_columns() (plan decisions D-011,
 * D-012): the retirement list must name exactly the registry's legacy columns, or a corpus
 * would keep its stored column (and its GIN index) forever.
 */
describe('BM25 legacy-column retirement list ↔ registry', () => {
  const LEGACY = 'FUNCTION harness_shared.bm25_legacy_tsv_columns()';
  const pick = (suffix: string) =>
    readdirSync(SQL_DIR)
      .filter(f => f.endsWith(suffix) && /^\d+-/.test(f))
      .map(f => ({ file: f, n: Number(f.split('-')[0]), sql: readFileSync(path.join(SQL_DIR, f), 'utf8') }))
      .filter(m => m.sql.includes(LEGACY))
      .sort((a, b) => b.n - a.n)[0];
  const m = pick('.sql') ?? pick('.sql.DRAFT');

  const body = () => {
    expect(m, `no migration defines ${LEGACY}`).toBeDefined();
    const start = m!.sql.indexOf(LEGACY);
    return m!.sql.slice(start, m!.sql.indexOf('$fn$;', start));
  };
  const corpora: readonly Bm25Corpus[] = BM25_CORPORA;

  it(`names exactly the registry's (table, legacyTsvColumn) pairs`, () => {
    const pairs = [...body().matchAll(/\('([a-z0-9_]+)', '([a-z0-9_]+)', /g)].map(r => `${r[1]}.${r[2]}`);
    expect(pairs.sort()).toEqual(corpora.map(c => `${c.table}.${c.legacyTsvColumn}`).sort());
  });

  // D-016: a corpus whose source reads the stored column (the exact list) must be kept, and
  // only those. The kept_for value is the last field of each VALUES row.
  it(`keeps exactly the registry's keepLegacyColumn corpora`, () => {
    const rows = [...body().matchAll(/^\s*\('([a-z0-9_]+)', '[a-z0-9_]+', .*, (NULL|'([a-z-]+)')(?:::text)?\),?\s*$/gm)];
    expect(rows).toHaveLength(corpora.length);
    const kept = rows.filter(r => r[3]).map(r => `${r[1]}:${r[3]}`);
    expect(kept.sort()).toEqual(corpora.filter(c => c.keepLegacyColumn).map(c => `${c.table}:${c.keepLegacyColumn}`).sort());
  });
});

/**
 * D-016: the work_item and session_turn sources of search:semantic fuse an exact list (legacy
 * AND + ts_rank_cd) that reads the stored legacy column and its GIN index. Every relation an
 * exact list reads must be a corpus with keepLegacyColumn, and every such corpus must have an
 * exact list, so retirement can neither break a live source nor keep a column nobody reads.
 */
describe('BM25 exact-list sources ↔ keepLegacyColumn', () => {
  /** Views the sources read through, mapped to the base table that owns the column. */
  const VIEW_BASE: Record<string, string> = { engineer_issues: 'work_items' };
  it('the exact-list relations are exactly the kept corpora', () => {
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../agent-tools/search/sources.ts'), 'utf8');
    const knowledge = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../agent-tools/search/knowledge-sources.ts'), 'utf8');
    const reads = [...src.matchAll(/lexicalMode: 'and' \}, (?:p\.)?sql`(\w+)`, (?:p\.)?sql`harness_shared\.(\w+)`/g)]
      .map(r => `${VIEW_BASE[r[2]!] ?? r[2]}.${r[1]}`);
    if (/boundedExactTopK\([\s\S]{0,1200}?from: p\.sql`harness_shared\.harness_plans p`[\s\S]{0,500}?tsv: p\.sql`p\._search`/.test(knowledge)) {
      reads.push('harness_plans._search');
    }
    expect(reads.length, 'no exact-list call found in sources.ts').toBeGreaterThan(0);
    const corpora: readonly Bm25Corpus[] = BM25_CORPORA;
    expect([...new Set(reads)].sort())
      .toEqual(corpora.filter(c => c.keepLegacyColumn).map(c => `${c.table}.${c.legacyTsvColumn}`).sort());
  });
});

describe('BM25 corpus registry', () => {
  it('has one entry per table and per index name, each named <table>_bm25', () => {
    expect(new Set(BM25_CORPORA.map(c => c.table)).size).toBe(BM25_CORPORA.length);
    for (const c of BM25_CORPORA) expect(c.indexName).toBe(`${c.table}_bm25`);
  });

  it('renders unqualified and alias-qualified expressions', () => {
    const wi = bm25Corpus('work_items');
    expect(renderBm25TextExpr(wi)).toBe("coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(notes, '')");
    expect(renderBm25TextExpr(wi, 'w')).toBe("coalesce(w.title, '') || ' ' || coalesce(w.summary, '') || ' ' || coalesce(w.notes, '')");
    expect(bm25TextColumns(wi)).toEqual(['title', 'summary', 'notes']);
  });

  it('refuses an alias that is not a plain identifier', () => {
    expect(() => renderBm25TextExpr(bm25Corpus('documents'), "d; DROP TABLE x")).toThrow(/unsafe alias/);
  });

  it('leaves no unrendered placeholder in any expression', () => {
    for (const c of BM25_CORPORA) {
      expect(renderBm25TextExpr(c)).not.toMatch(/[{}]/);
      expect(renderBm25TextExpr(c, 't')).not.toMatch(/[{}]/);
    }
  });
});
