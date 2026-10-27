/**
 * ordered-vector-query-guard.test.ts — WI-10004138's recurrence guard.
 *
 * An HNSW index-ordered scan stops after `hnsw.ef_search` candidates (default 40)
 * and THEN applies the WHERE clause, so a filtered `ORDER BY embedding <=> $q LIMIT n`
 * silently returns fewer than n rows. Measured on 2026-09-30 against the live corpus
 * with each site's exact production predicate, default scan vs
 * `SET LOCAL hnsw.iterative_scan = relaxed_order` vs an exact scan:
 *
 *   code-recipes-search       LIMIT 60   267/600 rows   recall 0.445 -> 0.953
 *   loop-wake-recipe          LIMIT 5     36/50  rows   recall 0.72  -> 0.96
 *   doc-section-overlap       LIMIT 25   158/250 rows   recall 0.63  -> 1.0
 *
 * `withIterativeScan` (libs/generic/search) is the fix; this guard makes every
 * ordered vector query in the tree either run inside it or carry a written reason.
 *
 * ─── WHAT COUNTS AS AN ORDERED VECTOR QUERY ────────────────────────────────
 * A SQL literal (template or string) whose ORDER BY sort key is a bare distance
 * expression (`<=>`, `<->`, `<#>`), either directly or through a select-list alias
 * (`emb <=> $q AS distance … ORDER BY distance`). A DERIVED score is not one:
 * `ORDER BY 1 - (emb <=> $q)` or `ORDER BY GREATEST(ts_rank, …)` cannot use the
 * index, so Postgres sorts exactly and nothing is capped.
 *
 * ─── THE FALSE-ABSENCE TRAPS THE CENSUS HIT (each pinned by a control below) ──
 *  1. A single-line grep misses an ORDER BY that wraps onto the next line.
 *  2. `git ls-files` without --recurse-submodules skips libs/generic/*, which is
 *     where the chunk vector leg lives (listTrackedFiles recurses).
 *  3. `ORDER BY random() … <=>` must NOT match: the sort key ends at `(`.
 *  4. The alias form is invisible to a direct `ORDER BY … <=>` regex.
 *  5. A SQL BUILDER (chunkAwareVectorLegSql) holds the ORDER BY while its callers
 *     hold the execution, so the builder is exempt only because rule 2 below
 *     checks every call site instead.
 *
 * ⚠ Bound: a query assembled from fragments where the ORDER BY and the distance
 * operator sit in DIFFERENT literals is not detected. None existed at authoring
 * time (the 2026-09-30 census found every vector-operator literal self-contained).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { listTrackedFiles } from '../../../../scripts/lib/tracked-files.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCAN_PREFIXES = ['packages/', 'apps/', 'libs/'];
const SOURCE_FILE = /\.(ts|tsx|mts|cts)$/;
const NOT_SOURCE = /\.(test|spec)\.tsx?$|\/__tests__\/|\.d\.ts$|\/dist\/|\/node_modules\//;

const VECTOR_OP = /<=>|<->|<#>/;
/** ORDER BY whose first sort key reaches a distance operator before any , ; ( ) boundary. */
const DIRECT_ORDER = /ORDER\s+BY\s+\(?[^,;()]*?(?:<=>|<->|<#>)/i;
/**
 * `<operand> <op> … AS alias` where the operand is not the right-hand side of
 * arithmetic — `1 - (emb <=> $q) AS sim` is a derived score, not a distance.
 * `${}` is the placeholder `literalText` uses for an interpolated span.
 */
const BARE_DISTANCE_ALIAS =
  /(?<![\w.$])(?<![-+*/]\s*\(?\s*)(?:[A-Za-z_][\w.]*|\$\{\})\s*(?:<=>|<->|<#>)[^,;]*?\bAS\s+([A-Za-z_]\w*)/gi;
const ORDER_KEY = /ORDER\s+BY\s+(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)/gi;

const WRAPPER = /(^|\.)withIterativeScan$/;
const BUILDER = /(^|\.)chunkAwareVectorLegSql$/;
/** The builder's own module and its barrel re-export are not call sites. */
const BUILDER_HOME = 'libs/generic/search/src/chunks/';

type OrderedKind = 'direct' | 'alias';

function orderedVectorKind(sqlText: string): OrderedKind | null {
  if (!VECTOR_OP.test(sqlText)) return null;
  if (DIRECT_ORDER.test(sqlText)) return 'direct';
  const aliases = new Set([...sqlText.matchAll(BARE_DISTANCE_ALIAS)].map((m) => m[1]!.toLowerCase()));
  if (aliases.size === 0) return null;
  for (const m of sqlText.matchAll(ORDER_KEY)) if (aliases.has(m[1]!.toLowerCase())) return 'alias';
  return null;
}

interface Site {
  file: string;
  line: number;
  kind: OrderedKind;
  wrapped: boolean;
  /** Whitespace-collapsed literal text, `${}` for interpolations. */
  text: string;
}
interface BuilderCall {
  file: string;
  line: number;
  wrapped: boolean;
  /** Whitespace-collapsed call text, so an exemption can name its call site. */
  text: string;
}

function literalText(n: ts.Node): string | null {
  if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(' ${} ');
  return null;
}

/**
 * A leg combinator runs the `embedding` member of the SearchSource object literal it is
 * called with under withIterativeScan (knowledge-sources.ts `boundedSource`), so an ordered
 * query inside that member IS capped although no withIterativeScan call encloses it
 * lexically. Only that member counts: the lexical leg runs unwrapped. Pinned by
 * 'a leg combinator still runs the embedding leg under withIterativeScan' below.
 */
const LEG_COMBINATOR = /(^|\.)boundedSource$/;
const LEG_COMBINATOR_HOME = 'packages/operator-core/lib/agent-tools/search/knowledge-sources.ts';

function isCombinatorEmbeddingLeg(p: ts.Node, sf: ts.SourceFile): boolean {
  if (!(ts.isMethodDeclaration(p) || ts.isPropertyAssignment(p)) || p.name.getText(sf) !== 'embedding') return false;
  const obj = p.parent;
  const call = obj?.parent;
  return ts.isObjectLiteralExpression(obj) && !!call && ts.isCallExpression(call)
    && call.arguments[0] === obj && LEG_COMBINATOR.test(call.expression.getText(sf));
}

function insideWrapper(n: ts.Node, sf: ts.SourceFile): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && WRAPPER.test(p.expression.getText(sf))) return true;
    if (isCombinatorEmbeddingLeg(p, sf)) return true;
  }
  return false;
}

/** A string that is an element of `evidence: [...]` is text the R-31 reader guard greps for, not SQL. */
function isReaderEvidence(n: ts.Node): boolean {
  const arr = n.parent;
  if (!arr || !ts.isArrayLiteralExpression(arr)) return false;
  const prop = arr.parent;
  return !!prop && ts.isPropertyAssignment(prop) && prop.name.getText() === 'evidence';
}

function scanSource(file: string, text: string): { sites: Site[]; builderCalls: BuilderCall[] } {
  const sites: Site[] = [];
  const builderCalls: BuilderCall[] = [];
  const mentionsBuilder = text.includes('chunkAwareVectorLegSql');
  if (!VECTOR_OP.test(text) && !mentionsBuilder) return { sites, builderCalls };
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    const lit = literalText(n);
    if (lit !== null) {
      const kind = orderedVectorKind(lit);
      if (kind && !(ts.isStringLiteral(n) && isReaderEvidence(n))) {
        sites.push({ file, line: lineOf(n), kind, wrapped: insideWrapper(n, sf), text: lit.replace(/\s+/g, ' ') });
      }
    }
    if (
      mentionsBuilder &&
      !file.startsWith(BUILDER_HOME) &&
      ts.isCallExpression(n) &&
      BUILDER.test(n.expression.getText(sf))
    ) {
      builderCalls.push({ file, line: lineOf(n), wrapped: insideWrapper(n, sf), text: n.getText(sf).replace(/\s+/g, ' ') });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { sites, builderCalls };
}

/**
 * Unwrapped ordered vector queries that are correct as written. Keyed by file plus
 * a substring of the whitespace-collapsed literal (not a line number, which drifts).
 * An entry that stops matching fails the guard, so the list cannot rot silently.
 */
const EXEMPT: ReadonlyArray<{ file: string; contains: string; reason: string }> = [
  {
    file: 'libs/generic/search/src/chunks/vector-leg.ts',
    contains: 'AS matched_anchor, 0 AS leg',
    reason:
      'chunkAwareVectorLegSql is a SQL builder: it returns a fragment and executes nothing. ' +
      'Rule 2 of this guard requires every call site to run it inside withIterativeScan. ' +
      "Its chunk arm orders by an interpolated fragment (scan 'ann' or 'exact', D-032), so " +
      'this scan no longer sees it as a literal ORDER BY; the same rule 2 covers it.',
  },
  {
    file: 'libs/generic/search/src/chunks/vector-leg.ts',
    contains: 'hit.matched_anchor, 1 AS leg FROM (SELECT',
    reason:
      "The ANN chunk leg over the exact slice (scan 'exact', chunkScan 'ann'; generic-rag-chunking " +
      'D-046, D-048) orders the chunk table by its vector so the partial HNSW index can serve it. ' +
      'Same builder, same rule 2: every call site runs the fragment inside withIterativeScan or ' +
      'carries a BUILDER_EXEMPT entry saying why the default scan cap is safe for it.',
  },
  {
    file: 'libs/generic/search/src/chunks/vector-leg.ts',
    contains: 'AS chunk_leg_candidate_vector',
    reason:
      "The half chunk arm (no chunk ANN leg) orders the chunk rows joined to the parent slice by " +
      'their vector distance. It lives in the same chunkAwareVectorLegSql builder as the two arms ' +
      'above: a fragment that executes nothing, so rule 2 (every call site runs it inside ' +
      'withIterativeScan or carries a BUILDER_EXEMPT entry) is what covers its scan.',
  },
  {
    file: 'packages/operator-core/lib/personal-vault/store.ts',
    contains: 'row_number() OVER (ORDER BY embedding <=>',
    reason:
      'harness_shared.documents has no HNSW index and this ORDER BY is a window over a ' +
      'pre-filtered CTE, so Postgres sorts exactly; there is no ef_search cap to under-return.',
  },
  {
    file: 'packages/operator-core/lib/code-intelligence/semantic-code.ts',
    contains: 'AS cosine_similarity FROM harness_shared.semantic_code_functions',
    reason:
      'harness_shared.semantic_code_functions has no vector index (migration 1568 creates only the ' +
      'GIN search_text index), so this ORDER BY embedding <=> is an exact sort over the filtered ' +
      'rows; there is no HNSW ef_search cap to under-return. Wrap it if a vector index is added.',
  },
  // R-33's same-time A/B bench (generic-rag-chunking D-040). Arm A must be the
  // pre-change query exactly as it ran at 9a9473af95, so the pair differs only in
  // what the chunking work changed; wrapping it would time a query that never shipped.
  {
    file: 'packages/operator-core/lib/search/bench/chunk-search-ab-cli.ts',
    contains: 'AND template_slug IS NULL AND archived = false ORDER BY embedding <=>',
    reason:
      'Benchmark arm A for plans: reproduces queryTopPlansReal as of 9a9473af95, which ran under ' +
      'withWorkspace only. It is a measurement of the pre-change query, never a production read.',
  },
  {
    file: 'packages/operator-core/lib/search/bench/chunk-search-ab-cli.ts',
    contains: "AND state = 'closed_answered' AND query_embedding IS NOT NULL",
    reason:
      'Benchmark arm A for consult: reproduces peersKnowLookup as of 9a9473af95, an unwrapped exact ' +
      'scan. It is a measurement of the pre-change query, never a production read.',
  },
];

/**
 * chunkAwareVectorLegSql call sites that run OUTSIDE withIterativeScan on purpose.
 * Keyed by file plus a substring of the whitespace-collapsed call text. An entry
 * that stops matching an unwrapped call fails the guard, so the list cannot rot.
 */
const BUILDER_EXEMPT: ReadonlyArray<{ file: string; contains: string; reason: string }> = [
  {
    file: 'packages/operator-core/lib/consult/peers-know.ts',
    contains: 'surface: CONSULT_QUESTIONS_CHUNK_SURFACE',
    reason:
      'generic-rag-chunking D-048. The consult surface chunks only settled questions (eligibleSql is ' +
      "the reader's own slice predicate), and the ANN chunk leg filters only by workspace, so " +
      'nearly every HNSW candidate passes and there is little for an iterative scan to recover. ' +
      'The wrapper and its transaction cost the lookup its 3.5 ms latency budget (D-047 record: ' +
      '+8.0 ms at p95). A chunk the default ef_search misses leaves its question to the parent ' +
      'leg: a recall loss, never a wrong answer.',
  },
];

/** Sites WI-10004138 wrapped. Each must still be DETECTED as wrapped, or the scan went blind. */
const KNOWN_WRAPPED = [
  'packages/operator-core/lib/code-recipes-search.ts',
  'packages/operator-core/lib/harness/routines/loop-wake-recipe.ts',
  'packages/operator-core/lib/consult/get-feedback-core.ts',
  'packages/operator-core/lib/search/doc-section-overlap.ts',
];

/**
 * `ORDERED_VECTOR_GUARD_SUBJECT=<repo-relative path>=<absolute path>` scans the second
 * file in place of the first. It exists so scripts/mutation-probe.sh can prove the tree
 * rules falsifiable against a mutated COPY, without mutating the shared tree.
 */
function subjectOverride(): Map<string, string> {
  const raw = process.env.ORDERED_VECTOR_GUARD_SUBJECT;
  const eq = raw ? raw.indexOf('=') : -1;
  return eq > 0 ? new Map([[raw!.slice(0, eq), raw!.slice(eq + 1)]]) : new Map();
}

function scanTree() {
  const tracked = listTrackedFiles(REPO_ROOT);
  const files = (tracked.files as string[]).filter(
    (f) => SCAN_PREFIXES.some((p) => f.startsWith(p)) && SOURCE_FILE.test(f) && !NOT_SOURCE.test(f),
  );
  const override = subjectOverride();
  const sites: Site[] = [];
  const builderCalls: BuilderCall[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(override.get(f) ?? resolve(REPO_ROOT, f), 'utf8');
    } catch {
      continue; // tracked but deleted in the working tree
    }
    const r = scanSource(f, text);
    sites.push(...r.sites);
    builderCalls.push(...r.builderCalls);
  }
  return { files, sites, builderCalls };
}

describe('ordered vector queries run under withIterativeScan (WI-10004138)', () => {
  describe('detector controls', () => {
    const one = (src: string) => scanSource('fixture.ts', src).sites;

    it('flags an unwrapped direct ORDER BY distance', () => {
      const s = one('const r = await sql`SELECT id FROM t WHERE k = ${k} ORDER BY embedding <=> ${v}::vector LIMIT 5`;');
      expect(s).toHaveLength(1);
      expect(s[0]).toMatchObject({ kind: 'direct', wrapped: false });
    });

    it('sees the same query as wrapped inside withIterativeScan', () => {
      const s = one(
        'const r = await withIterativeScan(sql, async (tx) => tx`SELECT id FROM t ORDER BY embedding <=> ${v}::vector LIMIT 5`);',
      );
      expect(s).toHaveLength(1);
      expect(s[0]!.wrapped).toBe(true);
    });

    it('detects an ORDER BY that wraps onto the next line (trap 1)', () => {
      const s = one('sql`SELECT id FROM t\n  ORDER BY\n    embedding\n    <=> ${v}::vector\n  LIMIT 5`;');
      expect(s.map((x) => x.kind)).toEqual(['direct']);
    });

    it('ignores ORDER BY random() followed later by a distance (trap 3)', () => {
      expect(one('sql`WITH a AS (SELECT e FROM t ORDER BY random() LIMIT 9) SELECT 1 - (a.e <=> b.e) AS sim FROM a, b`;')).toEqual([]);
    });

    it('detects ordering by an alias of a bare distance (trap 4)', () => {
      const s = one('sql`SELECT id, (embedding <=> ${v}::vector) AS distance FROM t ORDER BY distance LIMIT 5`;');
      expect(s.map((x) => x.kind)).toEqual(['alias']);
      const interpolated = one('sql`SELECT id, (${col} <=> ${v}::vector) AS distance FROM t ORDER BY distance LIMIT 5`;');
      expect(interpolated.map((x) => x.kind)).toEqual(['alias']);
    });

    it('does not flag ordering by a derived score', () => {
      expect(one('sql`SELECT id, 1 - (embedding <=> ${v}::vector) AS sim FROM t ORDER BY sim DESC LIMIT 5`;')).toEqual([]);
      expect(one('sql`SELECT id FROM t ORDER BY 1 - (embedding <=> ${v}::vector) DESC LIMIT 5`;')).toEqual([]);
    });

    it('ignores comments but checks plain string SQL, except reader evidence', () => {
      expect(one('// ORDER BY embedding <=> $1\nconst x = 1;')).toEqual([]);
      expect(one("await sql.unsafe('SELECT id FROM t ORDER BY embedding <=> $1 LIMIT 5', [v]);")).toHaveLength(1);
      expect(one("const t = { readers: [{ evidence: ['ORDER BY embedding <=> ${qVec}::vector'] }] };")).toEqual([]);
    });

    it('requires builder call sites to be inside withIterativeScan (trap 5)', () => {
      const bare = scanSource('caller.ts', 'await sql`WITH best AS (${chunkAwareVectorLegSql(sql, opts)}) SELECT 1`;');
      expect(bare.builderCalls).toEqual([
        { file: 'caller.ts', line: 1, wrapped: false, text: 'chunkAwareVectorLegSql(sql, opts)' },
      ]);
      const wrapped = scanSource(
        'caller.ts',
        'await withIterativeScan(sql, (h) => h`WITH best AS (${chunkAwareVectorLegSql(h, opts)}) SELECT 1`);',
      );
      expect(wrapped.builderCalls.map((c) => c.wrapped)).toEqual([true]);
    });

    it('counts only the embedding leg of a boundedSource(...) source as wrapped', () => {
      const src =
        'const s = boundedSource({ async lexical(p) { return p.sql`SELECT 1 ORDER BY e <=> ${v}::vector`; },\n' +
        '  async embedding(p) { return p.sql`SELECT 1 ORDER BY e <=> ${v}::vector`; } });\n' +
        'const t = other({ async embedding(p) { return p.sql`SELECT 1 ORDER BY e <=> ${v}::vector`; } });';
      expect(scanSource('s.ts', src).sites.map((s) => [s.line, s.wrapped])).toEqual([[1, false], [2, true], [3, false]]);
    });
  });

  describe('the tree', () => {
    const { files, sites, builderCalls } = scanTree();

    it('scans the submodule that holds the chunk vector leg (trap 2)', () => {
      expect(files.length).toBeGreaterThan(1000);
      expect(files).toContain('libs/generic/search/src/chunks/vector-leg.ts');
      expect(sites.some((s) => s.file === 'libs/generic/search/src/chunks/vector-leg.ts')).toBe(true);
    });

    it('a leg combinator still runs the embedding leg under withIterativeScan', () => {
      const src = readFileSync(resolve(REPO_ROOT, LEG_COMBINATOR_HOME), 'utf8');
      const start = src.indexOf('export function boundedSource(');
      expect(start, `boundedSource moved out of ${LEG_COMBINATOR_HOME}`).toBeGreaterThanOrEqual(0);
      const fn = src.slice(start, src.indexOf('\n}\n', start));
      expect(fn).toMatch(/vector\s*\?\s*withIterativeScan\(/);
      expect(fn).toMatch(/embedding:[^\n]*run\(source\.embedding!?, p, true\)/);
    });

    it('still detects every site WI-10004138 wrapped', () => {
      const wrappedFiles = new Set(sites.filter((s) => s.wrapped).map((s) => s.file));
      expect(KNOWN_WRAPPED.filter((f) => !wrappedFiles.has(f))).toEqual([]);
    });

    it('has no unwrapped ordered vector query without a written reason', () => {
      const unexplained = sites
        .filter((s) => !s.wrapped)
        .filter((s) => !EXEMPT.some((e) => e.file === s.file && s.text.includes(e.contains)))
        .map((s) => `${s.file}:${s.line} [${s.kind}] ${s.text.slice(0, 120)}`);
      expect(
        unexplained,
        'Run the query inside withIterativeScan(sql, async (tx) => …) from @papercusp/search, ' +
          'or add an EXEMPT entry saying why the scan cannot be capped',
      ).toEqual([]);
    });

    it('has no stale or unexplained exemption', () => {
      for (const e of EXEMPT) expect(e.reason.length, e.contains).toBeGreaterThan(60);
      const stale = EXEMPT.filter((e) => !sites.some((s) => !s.wrapped && s.file === e.file && s.text.includes(e.contains)));
      expect(stale.map((e) => `${e.file} :: ${e.contains}`)).toEqual([]);
    });

    it('runs every chunkAwareVectorLegSql call inside withIterativeScan, or names why not', () => {
      expect(builderCalls.length).toBeGreaterThan(0);
      const exempt = (c: BuilderCall) => BUILDER_EXEMPT.some((e) => e.file === c.file && c.text.includes(e.contains));
      expect(
        builderCalls.filter((c) => !c.wrapped && !exempt(c)).map((c) => `${c.file}:${c.line}`),
        'Run the fragment inside withIterativeScan, or add a BUILDER_EXEMPT entry saying why the default scan cap is safe',
      ).toEqual([]);
    });

    it('has no stale or unexplained builder exemption', () => {
      for (const e of BUILDER_EXEMPT) expect(e.reason.length, e.contains).toBeGreaterThan(60);
      const stale = BUILDER_EXEMPT.filter(
        (e) => !builderCalls.some((c) => !c.wrapped && c.file === e.file && c.text.includes(e.contains)),
      );
      expect(stale.map((e) => `${e.file} :: ${e.contains}`)).toEqual([]);
    });
  });
});
