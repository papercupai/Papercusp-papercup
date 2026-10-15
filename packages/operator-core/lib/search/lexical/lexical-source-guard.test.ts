/**
 * Source guard: lexical ranking goes through the one seam (plan
 * bm25-lexical-search-evoke-adoption-2026-10-10, requirement R-9, P-007).
 *
 * A production source file that calls `ts_rank(` or `ts_rank_cd(` must also import the
 * lexical seam (`search/lexical/rank`), which is how its ts_rank fragments become the
 * LEGACY leg the seam falls back to when BM25 is unavailable or switched off. A file that
 * ranks with ts_rank and never touches the seam is a new call site that skipped BM25: the
 * guard names it. The two sites plan decision D-009 keeps on ts_rank are allowlisted with
 * that reason; an allowlist entry that no longer calls ts_rank fails, so the list only
 * shrinks.
 *
 * Granularity is the FILE: a file that already uses the seam can still rank a second query
 * with a bare ts_rank_cd (D-007 keeps fixed relevance floors on ts_rank_cd for exactly that
 * reason). Population: tracked files from `git grep`, superproject and submodules.
 *
 * Comments are ignored (a doc comment may quote ts_rank), string and template literals are
 * NOT: the SQL that calls ts_rank lives inside them.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripCommentsOnly } from '../../../../../scripts/lib/strip-comments-and-strings.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

/** The seam itself. */
const SEAM = 'packages/operator-core/lib/search/lexical/rank.ts';

/** Files allowed to rank with ts_rank without the seam, each with its governing reason. */
const LEXICAL_SEAM_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  ['packages/operator-core/lib/conventions/registry.ts',
    'D-009: ranks single plan DECISIONS, elements of the harness_plans.decisions jsonb array; no table row for a BM25 index to rank (follow-up WI-6554700010008456).'],
  ['packages/operator-core/lib/blueprint/package-doc-resources.ts',
    'D-009: ranks pack-doc PARTS computed on the fly with to_tsvector; no stored corpus for a BM25 index.'],
]);

const PRODUCTION_SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const NOT_PRODUCTION = /(\.test\.|\.spec\.|\/bench\/|\/e2e\/|\/dist\/|\/test\/|\/__tests__\/|sidecar)/;
const TS_RANK_CALL = /\bts_rank(_cd)?\s*\(/;
const SEAM_IMPORT = /from\s+['"][^'"]*search\/lexical\/rank['"]|from\s+['"]\.\/rank['"]/;

/*
 * Comments only, through the shared parser-backed stripper (EI-25706078725120945): the SQL that
 * calls ts_rank lives inside template literals and SEAM_IMPORT reads the import-path string, so
 * the strings variant would blind both. A private regex stripper here was the phantom-offender
 * class guard-string-literal-blindness ratchets against (a `//` inside a string read as a comment).
 */

interface SourceFile { path: string; text: string }

/** The files that rank with ts_rank outside the seam and are not allowlisted. */
function findLexicalSeamViolations(
  files: readonly SourceFile[],
  allow: ReadonlyMap<string, string> = LEXICAL_SEAM_ALLOWLIST,
): string[] {
  return files
    .filter(f => PRODUCTION_SOURCE.test(f.path) && !NOT_PRODUCTION.test(f.path) && f.path !== SEAM)
    .filter(f => !allow.has(f.path))
    .filter(f => {
      const code = stripCommentsOnly(f.text, f.path);
      if (!TS_RANK_CALL.test(code)) return false;
      const sameDirSeam = f.path.startsWith('packages/operator-core/lib/search/lexical/');
      const imports = SEAM_IMPORT.test(code) && (sameDirSeam || /search\/lexical\/rank/.test(code));
      return !imports;
    })
    .map(f => f.path)
    .sort();
}

/** Every tracked file whose text contains a ts_rank call, read from disk. */
function trackedTsRankFiles(): SourceFile[] {
  const out = execFileSync(
    'git',
    ['grep', '--recurse-submodules', '-lE', 'ts_rank(_cd)?[[:space:]]*\\(', '--', '*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.mjs', '*.cjs'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return out.split('\n').filter(Boolean).map(p => ({ path: p, text: readFileSync(path.join(REPO_ROOT, p), 'utf8') }));
}

describe('lexical seam source guard (R-9)', () => {
  describe('detector controls', () => {
    const rankSql = "const rows = await sql`SELECT id FROM t ORDER BY ts_rank_cd(t._search, q) DESC`;";

    it('flags a planted ts_rank_cd call site that skips the seam', () => {
      expect(findLexicalSeamViolations([{ path: 'packages/operator-core/lib/planted.ts', text: rankSql }]))
        .toEqual(['packages/operator-core/lib/planted.ts']);
    });

    it('flags a bare ts_rank( call too, with whitespace before the paren', () => {
      const text = 'const q = sql`ORDER BY ts_rank  (x._search, q) DESC`;';
      expect(findLexicalSeamViolations([{ path: 'apps/operator/lib/planted.ts', text }])).toHaveLength(1);
    });

    it('accepts the same call when the file routes through the seam', () => {
      const text = `import { lexicalLeg } from './search/lexical/rank';\n${rankSql}`;
      expect(findLexicalSeamViolations([{ path: 'packages/operator-core/lib/planted.ts', text }])).toEqual([]);
    });

    it('accepts the package-path import used from another workspace', () => {
      const text = `import { bm25LegIfAvailable } from '@papercusp/operator-core/lib/search/lexical/rank';\n${rankSql}`;
      expect(findLexicalSeamViolations([{ path: 'packages/agent-mcp/src/tools/x.ts', text }])).toEqual([]);
    });

    it('does not let an unrelated ./rank import outside the lexical directory pass', () => {
      const text = `import { rank } from './rank';\n${rankSql}`;
      expect(findLexicalSeamViolations([{ path: 'packages/operator-core/lib/other/planted.ts', text }])).toHaveLength(1);
    });

    it('ignores ts_rank quoted in comments', () => {
      const text = '/** Replaces ts_rank_cd(x) with BM25. */\n// ts_rank(y) used to live here\nexport const a = 1;';
      expect(findLexicalSeamViolations([{ path: 'packages/operator-core/lib/doc.ts', text }])).toEqual([]);
    });

    it('ignores tests, benches and the seam itself', () => {
      const files = ['x.test.ts', 'lib/search/bench/b.ts', SEAM].map(p => ({ path: p, text: rankSql }));
      expect(findLexicalSeamViolations(files)).toEqual([]);
    });

    it('honours an allowlist entry, and only for its own path', () => {
      const allow = new Map([['packages/operator-core/lib/a.ts', 'reason']]);
      const files = ['packages/operator-core/lib/a.ts', 'packages/operator-core/lib/b.ts'].map(p => ({ path: p, text: rankSql }));
      expect(findLexicalSeamViolations(files, allow)).toEqual(['packages/operator-core/lib/b.ts']);
    });
  });

  describe('the real tree', () => {
    const files = trackedTsRankFiles();
    const paths = new Set(files.map(f => f.path));

    it('the population is real: it contains known seam call sites and the seam (positive control)', () => {
      for (const known of [SEAM, 'packages/operator-core/lib/work-items.ts', 'packages/agent-mcp/src/tools/search/query.ts']) {
        expect(paths.has(known), `${known} should call ts_rank and be found by git grep`).toBe(true);
      }
    });

    it('has no production file that ranks with ts_rank outside the seam', () => {
      expect(findLexicalSeamViolations(files)).toEqual([]);
    });

    it('every allowlist entry still calls ts_rank (shrink-only: remove an entry once its site moves)', () => {
      for (const [p, reason] of LEXICAL_SEAM_ALLOWLIST) {
        expect(reason.length).toBeGreaterThan(20);
        const f = files.find(x => x.path === p);
        expect(f, `${p} no longer calls ts_rank; drop it from LEXICAL_SEAM_ALLOWLIST`).toBeDefined();
        expect(TS_RANK_CALL.test(stripCommentsOnly(f!.text, f!.path))).toBe(true);
      }
    });
  });
});
