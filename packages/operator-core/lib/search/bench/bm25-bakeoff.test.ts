import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyD001Rule,
  BAKEOFF_CORPORA,
  bakeoffDatabases,
  BM25_BAKEOFF_ENGINES,
  resolveBakeoffCorpus,
  comparePaired,
  countCsvRecords,
  createDatabaseSql,
  decideCap,
  parseCsv,
  parseEvalRows,
  percentileCont,
  rankAgreement,
  renderSummaryTable,
  restrictToCommonQueries,
  summarize,
  type BakeoffVariant,
  type EvalRow,
  type MethodSummary,
} from './bm25-bakeoff';

const row = (method: string, target: string, rank: number | null, opts: Partial<EvalRow> = {}): EvalRow => ({
  method, variant: 'title', target, rank, ms: 1, err: false, errmsg: null, ...opts,
});

describe('createDatabaseSql (engine isolation)', () => {
  it('clones from template0 so no engine inherits an extension the image put in template1', () => {
    for (const { database } of bakeoffDatabases()) {
      expect(createDatabaseSql(database)).toBe(`CREATE DATABASE ${database} TEMPLATE template0`);
    }
  });

  it('refuses a name that is not a plain lower-case identifier', () => {
    expect(() => createDatabaseSql('bake; DROP DATABASE postgres')).toThrow(/invalid database name/);
    expect(() => createDatabaseSql('Bake')).toThrow(/invalid database name/);
  });
});

describe('parseCsv (Postgres COPY csv)', () => {
  it('distinguishes COPY NULL (unquoted empty) from a quoted empty string', () => {
    expect(parseCsv('a,,"",b\n')).toEqual([['a', null, '', 'b']]);
  });

  it('handles quoted commas, doubled quotes, embedded newlines and CRLF', () => {
    expect(parseCsv('"x,y","say ""hi""","line1\nline2"\r\nz,1,2')).toEqual([
      ['x,y', 'say "hi"', 'line1\nline2'],
      ['z', '1', '2'],
    ]);
  });

  it('refuses an unterminated quote instead of returning a short row', () => {
    expect(() => parseCsv('"open,1')).toThrow(/unterminated/);
  });
});

describe('countCsvRecords (streamed corpus row count)', () => {
  const FIXTURES = [
    '',
    'a,b\n',
    'a,b',
    'a,,"",b\n',
    '"x,y","say ""hi""","line1\nline2"\r\nz,1,2',
    'one\r\ntwo\rthree\nfour',
    'a\n\nb\n',
    '"crlf\r\ninside",1\r\n"é ü 漢字 ""q""",2\n',
    '""\n""',
  ];
  /** Every split of the bytes into `size`-byte chunks — exercises CRLF and `""` straddling a boundary. */
  const chunked = (bytes: Uint8Array, size: number): Uint8Array[] => {
    const out: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
    return out;
  };

  it('agrees with parseCsv on every fixture at every chunk size', () => {
    for (const text of FIXTURES) {
      const bytes = new TextEncoder().encode(text);
      const expected = parseCsv(text).length;
      for (const size of [1, 2, 3, 5, 64]) {
        expect(countCsvRecords(chunked(bytes, size)), `${JSON.stringify(text)} @${size}`).toBe(expected);
      }
    }
  });

  it('rejects an unterminated quoted field like parseCsv does', () => {
    expect(() => countCsvRecords([new TextEncoder().encode('"open,1')])).toThrow(/unterminated/);
  });
});

describe('parseEvalRows', () => {
  it('maps a NULL rank to null and t/f to booleans', () => {
    const rows = parseEvalRows('evoke,title,h:WI-1,,3.5,f,\npgts,short,h:WI-2,2,1.25,t,"XX000 boom, bang"\n');
    expect(rows).toEqual([
      { method: 'evoke', variant: 'title', target: 'h:WI-1', rank: null, ms: 3.5, err: false, errmsg: null },
      { method: 'pgts', variant: 'short', target: 'h:WI-2', rank: 2, ms: 1.25, err: true, errmsg: 'XX000 boom, bang' },
    ]);
  });

  it('rejects a row with the wrong field count or an unknown variant', () => {
    expect(() => parseEvalRows('evoke,title,x,1,1,f\n')).toThrow(/7/);
    expect(() => parseEvalRows('evoke,body,x,1,1,f,\n')).toThrow(/variant/);
  });
});

describe('percentileCont matches Postgres percentile_cont', () => {
  it('interpolates linearly', () => {
    expect(percentileCont([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentileCont(Array.from({ length: 20 }, (_, i) => i + 1), 0.95)).toBeCloseTo(19.05, 10);
    expect(percentileCont([7], 0.95)).toBe(7);
    expect(Number.isNaN(percentileCont([], 0.5))).toBe(true);
  });
});

describe('summarize', () => {
  it('divides recall@1 by ALL queries: a miss (NULL rank) and an error both count as 0 (WI-10008233 trap)', () => {
    const rows = [
      row('m', 'a', 1),
      row('m', 'b', null),
      row('m', 'c', 3),
      row('m', 'd', null, { err: true, errmsg: 'XX000 oops', ms: 0.1 }),
    ];
    const [s] = summarize(rows);
    // avg((rank = 1)::int) over non-NULL ranks would say 0.5 here.
    expect(s.recallAt1).toBe(0.25);
    expect(s.recallAt10).toBe(0.5);
    expect(s.mrrAt10).toBeCloseTo((1 + 1 / 3) / 4, 12);
    expect(s.n).toBe(4);
    expect(s.errors).toBe(1);
    expect(s.errorSamples).toEqual(['XX000 oops']);
  });

  it('computes latency over non-error queries only and reports a Wilson CI around recall@10', () => {
    const rows = [row('m', 'a', 1, { ms: 2 }), row('m', 'b', 2, { ms: 4 }), row('m', 'c', null, { ms: 100, err: true })];
    const [s] = summarize(rows);
    expect(s.p50Ms).toBe(3);
    expect(s.meanMs).toBe(3);
    expect(s.recallAt10CI.point).toBeCloseTo(2 / 3, 12);
    expect(s.recallAt10CI.lower).toBeLessThan(2 / 3);
    expect(s.recallAt10CI.upper).toBeGreaterThan(2 / 3);
  });

  it('groups by method AND variant', () => {
    const rows = [row('m', 'a', 1), row('m', 'a', null, { variant: 'short' }), row('k', 'a', 2)];
    expect(summarize(rows).map(s => `${s.variant}:${s.method}`)).toEqual(['short:m', 'title:k', 'title:m']);
  });
});

describe('comparePaired / rankAgreement', () => {
  it('aligns the two arms on target and ignores queries only one arm answered', () => {
    const rows = [
      row('base', 'a', null), row('base', 'b', 1), row('base', 'c', null), row('base', 'only-base', 1),
      row('cand', 'a', 1), row('cand', 'b', 1), row('cand', 'c', 4),
    ];
    const p = comparePaired(rows, 'base', 'cand', 'title')!;
    expect(p.n).toBe(3);
    expect(p.hitAt10.onlyA).toBe(0);
    expect(p.hitAt10.onlyB).toBe(2);
    expect(p.mrrAt10.meanA).toBeCloseTo(1 / 3, 12);
    expect(p.mrrAt10.meanB).toBeCloseTo((1 + 1 + 0.25) / 3, 12);
    expect(rankAgreement(rows, 'base', 'cand', 'title')).toEqual({ n: 3, agree: 1 / 3 });
  });

  it('returns null when fewer than two queries are shared', () => {
    expect(comparePaired([row('base', 'a', 1), row('cand', 'a', 1)], 'base', 'cand', 'title')).toBeNull();
  });
});

const summary = (method: string, variant: BakeoffVariant, recallAt10: number, mrrAt10: number, p50Ms = 3, p95Ms = 20): MethodSummary => ({
  method, variant, n: 1000, errors: 0, recallAt1: 0, recallAt10, mrrAt10, p50Ms, p95Ms, meanMs: p50Ms,
  recallAt10CI: { point: recallAt10, lower: recallAt10, upper: recallAt10, ci: 0.95 }, errorSamples: [],
});

const both = (method: string, r: number, m: number, p50?: number, p95?: number) =>
  (['title', 'short'] as const).map(v => summary(method, v, r, m, p50, p95));

describe('applyD001Rule (plan D-001)', () => {
  it('chooses pg_textsearch when it is within 10% of Evoke on recall@10 and MRR@10 on every form and meets R-2', () => {
    const v = applyD001Rule([...both('evoke', 0.46, 0.34), ...both('pgts', 0.42, 0.31)]);
    expect(v.choice).toBe('pg_textsearch');
    expect(v.checks.every(c => c.pass)).toBe(true);
    expect(v.chosenMeetsR2).toBe(true);
  });

  it('chooses Evoke when pg_textsearch falls more than 10% behind on ANY metric of ANY form', () => {
    const rows = [
      ...both('evoke', 0.46, 0.34),
      summary('pgts', 'title', 0.45, 0.33),
      summary('pgts', 'short', 0.45, 0.30), // 0.30 < 0.9 * 0.34 = 0.306
    ];
    const v = applyD001Rule(rows);
    expect(v.choice).toBe('evoke');
    expect(v.reasons.join(' ')).toMatch(/short mrrAt10/);
  });

  it('chooses Evoke when pg_textsearch ranks well but misses the R-2 latency budget', () => {
    const v = applyD001Rule([...both('evoke', 0.46, 0.34), ...both('pgts', 0.46, 0.34, 4, 60)]);
    expect(v.choice).toBe('evoke');
    expect(v.reasons.join(' ')).toMatch(/latency/);
  });

  it('holds pg_textsearch to the BETTER Evoke configuration, not the default one', () => {
    const rows = [...both('evoke', 0.40, 0.25), ...both('evoke_stem', 0.50, 0.40), ...both('pgts', 0.44, 0.33)];
    const v = applyD001Rule(rows);
    expect(v.evokeMethod).toBe('evoke_stem');
    expect(v.choice).toBe('evoke'); // 0.33 < 0.9 * 0.40; it would have passed against the default
  });

  it('flags when the chosen engine itself misses R-2', () => {
    const v = applyD001Rule([...both('evoke', 0.46, 0.34, 3, 80), ...both('pgts', 0.2, 0.1)]);
    expect(v.choice).toBe('evoke');
    expect(v.chosenMeetsR2).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/does NOT meet R-2/);
  });

  it('refuses to decide without a complete Evoke and pg_textsearch reading', () => {
    expect(() => applyD001Rule(both('pgts', 0.4, 0.3))).toThrow(/Evoke/);
    expect(() => applyD001Rule([...both('evoke', 0.4, 0.3), summary('pgts', 'title', 0.4, 0.3)])).toThrow(/pgts/);
  });

  it('refuses an unpaired comparison (arms read on different query counts)', () => {
    const capped = both('evoke', 0.4, 0.3).map(s => ({ ...s, n: 200 }));
    expect(() => applyD001Rule([...capped, ...both('pgts', 0.4, 0.3)])).toThrow(/unpaired comparison/);
  });

  it('reports the paired query count on every check', () => {
    const v = applyD001Rule([...both('evoke', 0.46, 0.34), ...both('pgts', 0.42, 0.31)]);
    expect(v.checks.every(c => c.n === 1000)).toBe(true);
  });
});

describe('restrictToCommonQueries (run 2 regression: capped Evoke vs full-sample pg_textsearch)', () => {
  // Shape of run 2: Evoke answered only the first 200 (easy) queries; pg_textsearch all 1,000.
  // On the easy 200 both hit; on the hard 800 pg_textsearch mostly misses. Read unpaired,
  // pg_textsearch looks far worse than Evoke; on the same 200 queries it is equal.
  const ids = Array.from({ length: 1000 }, (_, i) => `t${String(i).padStart(4, '0')}`);
  const rows: EvalRow[] = [];
  for (const variant of ['title', 'short'] as const) {
    for (const [i, id] of ids.entries()) {
      if (i < 200) rows.push(row('evoke_stem', id, 1, { variant }));
      rows.push(row('pgts', id, i < 200 || i % 4 === 0 ? 1 : null, { variant }));
    }
    rows.push(row('tsv_and', ids[0], 1, { variant }));
  }

  it('keeps only the listed methods, on the queries every one of them answered, per form', () => {
    const kept = restrictToCommonQueries(rows, ['evoke', 'evoke_stem', 'pgts']);
    expect(kept.some(r => r.method === 'tsv_and')).toBe(false);
    for (const variant of ['title', 'short'] as const) {
      for (const m of ['evoke_stem', 'pgts']) {
        const targets = kept.filter(r => r.method === m && r.variant === variant).map(r => r.target);
        expect(targets).toEqual(ids.slice(0, 200));
      }
    }
  });

  it('the unpaired reading is refused and the paired reading chooses pg_textsearch', () => {
    expect(() => applyD001Rule(summarize(rows))).toThrow(/unpaired comparison/);
    const v = applyD001Rule(summarize(restrictToCommonQueries(rows, ['evoke', 'evoke_stem', 'pgts'])));
    expect(v.evokeMethod).toBe('evoke_stem');
    expect(v.choice).toBe('pg_textsearch');
    expect(v.checks.filter(c => c.metric !== 'latency').every(c => c.n === 200 && c.pgts === c.evoke)).toBe(true);
  });
});

describe('decideCap (cap on the recorded probe median, not a warm-up mean)', () => {
  const opts = { slowCapMs: 300, slowCapN: 200, nQueries: 1000, probeN: 100 };

  it('does not cap a fast engine whose cold warm-up was slow (run 2 Evoke: warm-up ~1 s/query, steady p50 2.4 ms)', () => {
    expect(decideCap(2.4, opts)).toEqual({ capped: false, limit: 1000 });
  });

  it('caps a genuinely slow engine to slowCapN, never below the probe already recorded', () => {
    expect(decideCap(885, opts)).toEqual({ capped: true, limit: 200 });
    expect(decideCap(885, { ...opts, slowCapN: 50 })).toEqual({ capped: true, limit: 100 });
    expect(decideCap(885, { ...opts, nQueries: 150 })).toEqual({ capped: true, limit: 150 });
  });

  it('does not cap when the median is unmeasurable (every probe query errored)', () => {
    expect(decideCap(Number.NaN, opts)).toEqual({ capped: false, limit: 1000 });
  });
});

describe('common.sql query order', () => {
  it('evaluates queries in a stable hash order, so a capped prefix is not the oldest items', () => {
    const sql = readFileSync(new URL('./bm25-bakeoff/common.sql', import.meta.url), 'utf8');
    const loop = sql.match(/FOR r IN SELECT \* FROM q ORDER BY ([^\n]+?) LIMIT p_limit OFFSET p_offset LOOP/);
    expect(loop?.[1]).toBe('md5(target), target');
  });
});

describe('roster', () => {
  it('sets up bake_sql first (it freezes the query set) and each database once', () => {
    const dbs = bakeoffDatabases();
    expect(dbs[0].database).toBe('bake_sql');
    expect(new Set(dbs.map(d => d.database)).size).toBe(dbs.length);
    expect(dbs.map(d => d.database).sort()).toEqual(['bake_evoke', 'bake_pgsearch', 'bake_pgts', 'bake_sql']);
  });

  it('runs the pure-SQL BM25 postings setup only when a sqlbm25 arm is selected (EI-25652941379953131)', () => {
    const pick = (...methods: string[]) => BM25_BAKEOFF_ENGINES.filter(e => methods.includes(e.method));
    const sqlFiles = (methods: string[]) => bakeoffDatabases(pick(...methods)).find(d => d.database === 'bake_sql')?.setupFiles;
    expect(sqlFiles(['tsv_and', 'pgts'])).toEqual(['engine-sql.sql']);
    expect(sqlFiles(['tsv_and', 'sqlbm25_post'])).toEqual(['engine-sql.sql', 'engine-sqlbm25.sql']);
    expect(sqlFiles(['sqlbm25_tsv', 'sqlbm25_post'])).toEqual(['engine-sql.sql', 'engine-sqlbm25.sql']);
    expect(bakeoffDatabases(pick('pgts'))).toEqual([{ database: 'bake_pgts', setupFiles: ['engine-pgts.sql'] }]);
  });

  it('marks only the AGPL engine as not shippable', () => {
    expect(BM25_BAKEOFF_ENGINES.filter(e => !e.shippable).map(e => e.method)).toEqual(['pgsearch']);
  });

  it('renders one table row per summary', () => {
    const md = renderSummaryTable([summary('pgts', 'title', 0.4, 0.3)]);
    expect(md.split('\n')).toHaveLength(3);
    expect(md).toContain('pg_textsearch 1.5.1');
  });
});

describe('bake-off corpora', () => {
  it('defaults to work items and refuses an unknown corpus', () => {
    expect(resolveBakeoffCorpus(undefined).key).toBe('work-items');
    expect(() => resolveBakeoffCorpus('turns')).toThrow(/--corpus must be one of/);
  });

  it('exports every corpus with one read-only, workspace-scoped COPY to stdout', () => {
    for (const corpus of Object.values(BAKEOFF_CORPORA)) {
      expect(corpus.exportSql).toMatch(/^COPY \(/);
      expect(corpus.exportSql).toMatch(/\) TO STDOUT WITH \(FORMAT csv\)$/);
      expect(corpus.exportSql).toMatch(/workspace_id='(papercusp-workspace|default)'/);
      expect(corpus.exportSql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i);
    }
  });

  it('keeps the session-turn query words out of the indexed body', () => {
    const sql = BAKEOFF_CORPORA['session-turns'].exportSql;
    expect(sql).toContain("array_to_string(w[1:12], ' ')");
    expect(sql).toContain("array_to_string(w[13:], ' ')");
    expect(sql).toMatch(/REPEATABLE \(42\)/);
  });
});
