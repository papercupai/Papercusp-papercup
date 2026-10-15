/**
 * moved-algorithms-single-home.test.ts — shared-vector-search-libraries-2026-09-29 R-14.
 *
 * R-14: each algorithm the plan moved into `@papercusp/search` is DEFINED only
 * in the library, and the papercusp modules that held it import it from there.
 *
 * How this proves it, per algorithm:
 *   1. A code FINGERPRINT (a regex over the algorithm's characteristic line)
 *      matches the library file that now defines it, and matches the line
 *      recorded verbatim from the pre-move papercusp source (commit bba6c48424).
 *      Both are calibrations: a fingerprint that misses either one would make
 *      step 2 vacuous.
 *   2. No non-test source file under packages/operator-core matches that
 *      fingerprint, except a file listed in `KNOWN_RESIDUE` with a work-item.
 *      Every listed residue must STILL match, so the entry has to be deleted
 *      in the change that removes the copy.
 *   3. Each papercusp module that held the algorithm imports the library entry
 *      point from `@papercusp/search` (or uses the host's library-built
 *      instance) and calls it.
 *
 * The oracle is the text of the tree plus the recorded pre-move lines; it never
 * imports the code under test. Comments are stripped before matching; string
 * and template literals are kept, because the filter builder's fingerprint is
 * its SQL template.
 */
import { describe, expect, it } from 'vitest';
import { stripCommentsOnly } from '../../../../scripts/lib/strip-comments-and-strings.mjs';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const HERE = dirname(new URL(import.meta.url).pathname);
const OPERATOR_CORE = resolve(HERE, '../..');
const REPO = resolve(OPERATOR_CORE, '../..');
const LIB_SRC = join(REPO, 'libs/generic/search/src');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.papercusp', '__tests__', '__fixtures__', '.vitest-tmp']);
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|mts|cts)$|\.d\.ts$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (SOURCE_EXT.test(name) && !TEST_FILE.test(name)) out.push(p);
  }
  return out;
}

/** Remove comments (strings and templates survive) via the shared lexer-backed stripper. */
export const stripComments = (src: string): string => stripCommentsOnly(src, 'source.ts');

const read = (abs: string) => stripComments(readFileSync(abs, 'utf8'));
const opRel = (abs: string) => relative(OPERATOR_CORE, abs);

/** Names imported (as values, not `type`) from `@papercusp/search`. */
function libraryValueImports(code: string): Set<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]@papercusp\/search['"]/g)) {
    for (const raw of m[1]!.split(',')) {
      const part = raw.trim();
      if (!part || part.startsWith('type ')) continue;
      names.add(part.split(/\s+as\s+/)[0]!.trim());
    }
  }
  return names;
}

interface Host {
  /** operator-core-relative path of a module that held the algorithm. */
  file: string;
  /** Library value it must import from `@papercusp/search` (omit when it uses the host instance). */
  imports?: string[];
  /** It must call the library (or the host's library-built instance). */
  calls: RegExp;
}

interface MovedAlgorithm {
  name: string;
  libFile: string;
  libDefinition: RegExp;
  fingerprint: RegExp;
  /** The pre-move papercusp line, verbatim from bba6c48424. */
  preMove: { file: string; line: string };
  hosts: Host[];
}

const MOVED: MovedAlgorithm[] = [
  {
    name: 'embedding-space filter builder',
    libFile: 'embedding-space.ts',
    libDefinition: /\bfunction predicateSql\(/,
    fingerprint: /IS NULL AND \$\{\s*\w+\s*\}\s*=\s*\$\{\s*[\w.]*legacyMode\s*\}/,
    preMove: {
      file: 'lib/search/prose-vector-dims.ts',
      line: '    ? sql`(${profile} = ${selection.profileId} OR (${profile} IS NULL AND ${mode} = ${selection.legacyMode}))`',
    },
    hosts: [
      { file: 'lib/search/prose-vector-dims.ts', imports: ['createEmbeddingSpace'], calls: /\bcreateEmbeddingSpace\(/ },
      { file: 'lib/agent-tools/search/sources.ts', calls: /\bPROSE_EMBEDDING_SPACE\.\w+\(/ },
    ],
  },
  {
    name: 'storage compatibility check',
    libFile: 'embedding-space.ts',
    libDefinition: /\bfunction validateCompatibility\(/,
    fingerprint: /\bdistanceMetric\s*!==\s*[\w.]+\.distanceMetric\b/,
    preMove: {
      file: 'lib/search/prose-vector-dims.ts',
      line: '  if (profile.distanceMetric !== PROSE_VECTOR_STORAGE_PROFILE.distanceMetric) {',
    },
    hosts: [
      { file: 'lib/search/prose-vector-dims.ts', imports: ['createEmbeddingSpace'], calls: /\bPROSE_EMBEDDING_SPACE\.validateCompatibility\(/ },
      { file: 'lib/capability-class-registry-store.ts', imports: ['createEmbeddingSpace'], calls: /\.validateCompatibility\(/ },
    ],
  },
  {
    name: 'self-check comparison',
    libFile: 'embedding-space-self-check.ts',
    libDefinition: /\bexport function isEmbeddingDesync\(/,
    fingerprint: /\bdistance\s*<=\s*threshold\b/,
    preMove: { file: 'lib/search/embed-space-self-check.ts', line: '  if (distance <= threshold) {' },
    hosts: [
      { file: 'lib/search/embed-space-self-check.ts', imports: ['runStoredRowSelfCheck'], calls: /\brunStoredRowSelfCheck\(/ },
    ],
  },
  {
    name: 'coverage assessment',
    libFile: 'coverage-gate.ts',
    libDefinition: /\bexport function createCoverageGate\(/,
    fingerprint: /\bcoverage\s*<\s*[\w.]*(?:COVERAGE_FLOOR|coverageFloor)\b/,
    preMove: {
      file: 'lib/search/coverage-gate.ts',
      line: '  const degraded = coverage !== null && coverage < TOTAL_COVERAGE_FLOOR;',
    },
    hosts: [{ file: 'lib/search/coverage-gate.ts', imports: ['createCoverageGate'], calls: /\bcreateCoverageGate\(/ }],
  },
  {
    name: 'calibrated duplicate cut',
    libFile: 'near-duplicate.ts',
    libDefinition: /\bexport function calibrateNearDuplicateCut\(/,
    fingerprint: /\bbackgroundSamples\s*:\s*\w+\.length\b/,
    preMove: {
      file: 'lib/agent-tools/plans/semantic-dedup.ts',
      line: "  return { basis: 'corpus-relative', cut, backgroundSamples: usable.length, quantile: q };",
    },
    hosts: [
      {
        file: 'lib/agent-tools/plans/semantic-dedup.ts',
        imports: ['calibrateNearDuplicateCut', 'checkNearDuplicates'],
        calls: /\bcalibrateNearDuplicateCut\([\s\S]*\bcheckNearDuplicates\(|\bcheckNearDuplicates\([\s\S]*\bcalibrateNearDuplicateCut\(/,
      },
    ],
  },
  {
    // P-006: the stale-row pull that skips rows already failed this call.
    name: 'backfill stale-row pull',
    libFile: 'backfill/backfill-table.ts',
    libDefinition: /\bexport async function backfillTable</,
    fingerprint: /LIMIT \$1 OFFSET \$\{\s*\w+\s*\}/,
    preMove: { file: 'lib/search/embed-backfill.ts', line: '        LIMIT $1 OFFSET ${selOffsetExpr}`,' },
    hosts: [{ file: 'lib/search/embed-backfill.ts', imports: ['backfillTable'], calls: /\bbackfillTableCore</ }],
  },
  {
    // P-006: the sweep's rotation of which target leads.
    name: 'backfill round-robin sweep',
    libFile: 'backfill/sweeper.ts',
    libDefinition: /\bexport function createBackfillSweeper</,
    fingerprint: /\bsweepCounter\s*%\s*\w+\.length\b/,
    preMove: { file: 'lib/search/embed-backfill.ts', line: '    const offset = __sweepState.sweepCounter % TARGETS.length;' },
    hosts: [{ file: 'lib/search/embed-backfill.ts', imports: ['createBackfillSweeper'], calls: /\bcreateBackfillSweeper</ }],
  },
];

/**
 * Copies still defined in operator-core, each owned by a work-item. An entry
 * must keep matching its fingerprint, so it is deleted together with the copy.
 */
const KNOWN_RESIDUE: Array<{ algorithm: string; file: string; workItem: string }> = [];

const SOURCES = walk(join(OPERATOR_CORE, 'lib'));

// Copy-out mutation probes substitute ONE walked file with a mutant copy, so
// falsifiability is proven without dirtying the shared tree:
// PAPERCUSP_MOVED_ALGORITHMS_SUBJECT='<operator-core-relative path>=<absolute copy path>'.
const SUBJECT = (() => {
  const raw = process.env.PAPERCUSP_MOVED_ALGORITHMS_SUBJECT;
  if (!raw) return null;
  const at = raw.indexOf('=');
  const rel = raw.slice(0, at);
  if (at < 1 || !SOURCES.some((abs) => opRel(abs) === rel)) {
    // A substitution that matches no walked file would leave the run measuring the
    // real tree while the probe believes it measured the mutant.
    throw new Error(`PAPERCUSP_MOVED_ALGORITHMS_SUBJECT names no walked file: ${raw}`);
  }
  return { rel, copy: raw.slice(at + 1) };
})();
const CODE = new Map(
  SOURCES.map((abs) => [opRel(abs), read(SUBJECT && opRel(abs) === SUBJECT.rel ? SUBJECT.copy : abs)]),
);

describe('moved algorithms live only in @papercusp/search (R-14)', () => {
  it('the walk covers operator-core/lib, including every host module (non-vacuous)', () => {
    expect(SOURCES.length).toBeGreaterThan(500);
    for (const alg of MOVED) for (const h of alg.hosts) expect(CODE.has(h.file), h.file).toBe(true);
    expect([...CODE.keys()].some((f) => TEST_FILE.test(f))).toBe(false);
  });

  it('every known residue names a work-item and a moved algorithm', () => {
    for (const r of KNOWN_RESIDUE) {
      expect(r.workItem).toMatch(/^(?:WI|EI)-\d+$/);
      expect(MOVED.map((a) => a.name)).toContain(r.algorithm);
    }
  });

  describe.each(MOVED)('$name', (alg) => {
    const libCode = read(join(LIB_SRC, alg.libFile));

    it('is defined in the library, and its fingerprint matches the library and the pre-move line', () => {
      expect(libCode).toMatch(alg.libDefinition);
      expect(libCode).toMatch(alg.fingerprint);
      expect(alg.preMove.line).toMatch(alg.fingerprint);
    });

    it('is not defined anywhere else in operator-core (known residue excepted, and still present)', () => {
      const residue = new Set(KNOWN_RESIDUE.filter((r) => r.algorithm === alg.name).map((r) => r.file));
      const hits = [...CODE].filter(([, code]) => alg.fingerprint.test(code)).map(([f]) => f);
      expect(hits.filter((f) => !residue.has(f))).toEqual([]);
      for (const f of residue) expect(hits, `${f} no longer matches: delete its KNOWN_RESIDUE entry`).toContain(f);
    });

    it.each(alg.hosts)('host $file uses the library', (host) => {
      const code = CODE.get(host.file)!;
      const imported = libraryValueImports(code);
      for (const name of host.imports ?? []) expect([...imported], `${host.file} imports ${name}`).toContain(name);
      const body = code.replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"];?/g, '');
      expect(body).toMatch(host.calls);
    });
  });
});

describe('controls', () => {
  it('stripComments drops comments but keeps SQL templates, so a commented-out copy does not count', () => {
    const commented = '// if (distance <= threshold) {\n/* coverage < TOTAL_COVERAGE_FLOOR */\nconst s = `a // b`;';
    const stripped = stripComments(commented);
    expect(stripped).not.toMatch(MOVED[2]!.fingerprint);
    expect(stripped).not.toMatch(MOVED[3]!.fingerprint);
    expect(stripped).toContain('`a // b`');
  });

  it('a re-inlined copy in a host module would be reported (fingerprints fire on host-shaped code)', () => {
    for (const alg of MOVED) {
      const fake = `export function copy() {\n${alg.preMove.line}\n}`;
      expect(alg.fingerprint.test(stripComments(fake)), alg.name).toBe(true);
    }
  });

  it('libraryValueImports ignores type-only imports and reads aliases', () => {
    const code = "import { createCoverageGate, type CoverageGate, calibrateNearDuplicateCut as cut } from '@papercusp/search';";
    expect([...libraryValueImports(code)].sort()).toEqual(['calibrateNearDuplicateCut', 'createCoverageGate']);
  });
});
