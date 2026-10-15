/**
 * Guard: the per-client SSE interest declaration has ONE definition.
 *
 * WHY THIS GUARD EXISTS
 * The client builds the declaration (`withInterestParam`) and the server parses
 * it back (`parseInterestDeclaration`). They live in different packages, are
 * exercised by different suites, and nothing in the tree fails if they drift —
 * because the drift is FAIL-OPEN by design: a server that no longer recognises
 * the param simply sees no declaration and fans out everything. The symptom is
 * "the feature appears to be switched off", which is indistinguishable from the
 * feature genuinely being off, and nobody files that as a bug.
 *
 * So the property worth guarding is not "the values are correct" (a test that
 * restates the value is just a second copy of it, and drifts with the first).
 * It is that there is exactly ONE PLACE where each value is decided, and every
 * participant reaches it by IMPORT. That is checkable without restating
 * anything: read the values off the module at runtime, then assert nobody else
 * hard-codes them.
 *
 * FALSIFIABILITY
 * Every scan below carries a POSITIVE CONTROL asserting it found the one
 * legitimate site. A walk that silently visited nothing — a moved root, a bad
 * extension filter — would otherwise report "no duplicates found" while having
 * examined no files at all, which is the exact false-green this file is meant
 * to be immune to. Falsifiability against a real pre-fix source is provable
 * with `scripts/mutation-probe.sh --against-last-without`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  INTEREST_PARAM,
  MAX_DECLARED_QUERY_NAMES,
} from '../../../libs/generic/sync/src/interest-protocol';
import ts from 'typescript';

const REPO_ROOT = join(__dirname, '..', '..', '..');

/** The one file allowed to DECIDE these values. Everyone else imports them. */
const CONTRACT_FILE = join('libs', 'generic', 'sync', 'src', 'interest-protocol.ts');

/** Source roots any participant in this feature could live under. */
const SCAN_ROOTS = ['apps', 'packages', 'libs'];

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.git',
  'coverage',
  'out',
  'target',
  '.turbo',
]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // an absent optional root is not a finding
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue; // a broken symlink is not a finding
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip comments before matching.
 *
 * The property is about CODE. Prose legitimately quotes the param name while
 * explaining it — every one of this guard's first-run hits was a doc comment
 * discussing the contract, which is the writing this guard exists to ENCOURAGE.
 * Matching prose would make the guard punish documentation and, worse, train
 * the next reader to delete the explanation rather than the duplicate.
 *
 * Deliberately crude and deliberately CONSERVATIVE about what it removes: a
 * `//` preceded by `:` is treated as a URL scheme, not a comment, so a line
 * carrying an http(s) URL keeps everything after it and stays scannable.
 */
function stripComments(text: string): string {
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return noBlocks
    .split('\n')
    .map((line) => {
      const at = line.search(/(?:^|[^:])\/\//);
      if (at === -1) return line;
      return line.slice(0, line.indexOf('//', at));
    })
    .join('\n');
}

interface SourceFile {
  /** Repo-relative, POSIX-ish for readable failure messages. */
  rel: string;
  /** Comment-stripped source — what every match below runs against. */
  text: string;
  /** The untouched bytes, for assertions that are ABOUT the prose. */
  raw: string;
}

const isRouteFile = (rel: string) => {
  const posix = rel.split(sep).join('/');
  return posix.includes('zero-harness') && posix.endsWith('/sse.ts');
};

/**
 * Subject-path seam for falsifiability probing.
 *
 * Proving this guard CAN fail needs a source in which the route really did
 * re-declare the contract. Mutating the tree to produce one is unsafe here —
 * git-sync sweeps the whole checkout every few minutes and can COMMIT the
 * mutant even when nothing goes wrong and no handler fails — so the honest
 * control is a frozen snapshot of a real pre-fix commit
 * (`scripts/mutation-probe.sh --against-commit`), and that requires the route
 * file to be pointable somewhere other than its repo path.
 *
 * The snapshot is substituted UNDER ITS REAL repo-relative `rel`, so every
 * assertion, exclusion rule and failure message below behaves exactly as it
 * does in a normal run: only the bytes change, never the guard.
 */
const PROBE_ROUTE_FILE = process.env.PROBE_SSE_ROUTE_FILE;

const SOURCES: SourceFile[] = (() => {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root), files);
  const sources = files.map((f) => {
    const raw = readFileSync(f, 'utf8');
    return { rel: relative(REPO_ROOT, f), text: stripComments(raw), raw };
  });
  if (PROBE_ROUTE_FILE) {
    const idx = sources.findIndex((f) => isRouteFile(f.rel));
    if (idx === -1) throw new Error('PROBE_SSE_ROUTE_FILE set but no route file was found to replace');
    const raw = readFileSync(PROBE_ROUTE_FILE, 'utf8');
    sources[idx] = { rel: sources[idx]!.rel, text: stripComments(raw), raw };
  }
  return sources;
})();

/** Tests may legitimately restate a value to assert against it. */
const isTest = (rel: string) => /\.(test|spec)\.tsx?$/.test(rel);
const isContractFile = (rel: string) => rel.split(sep).join('/') === CONTRACT_FILE.split(sep).join('/');

/** Type keys and strings containing JSON do not declare a runtime URL parameter. */
function writesInterestLiteral(raw: string, rel: string): boolean {
  const source = ts.createSourceFile(rel, raw, ts.ScriptTarget.Latest, true,
    rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isTypeNode(node)) return;
    if (ts.isStringLiteralLike(node) && node.text === INTEREST_PARAM) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('sync interest declaration — one definition, reached by import', () => {
  it('the scan actually sees the tree (positive control)', () => {
    // Without this, every "no duplicates" assertion below could be satisfied by
    // a walk that visited zero files, and would read as a clean pass.
    expect(SOURCES.length).toBeGreaterThan(500);
    expect(SOURCES.some((f) => isContractFile(f.rel))).toBe(true);
    expect(SOURCES.some((f) => f.rel.includes('zero-harness') && f.rel.endsWith('sse.ts'))).toBe(
      true,
    );
  });

  it('the comment stripper removes prose without eating code (positive + negative control)', () => {
    // A stripper that removed too much would make every scan below vacuous,
    // and a vacuous scan reports "no duplicates" exactly like a clean tree.
    const contract = SOURCES.find((f) => isContractFile(f.rel))!;

    // NEGATIVE control: the prose mention that made this guard fire on its
    // first run is gone from what we match against...
    expect(contract.raw).toMatch(/A second copy of/);
    expect(contract.text).not.toMatch(/A second copy of/);

    // ...POSITIVE control: the declaration itself survived intact.
    expect(contract.text).toMatch(/export const INTEREST_PARAM\s*=/);
    expect(contract.text).toMatch(/export const MAX_DECLARED_QUERY_NAMES\s*=/);

    // A URL in a string literal must not be mistaken for a line comment.
    expect(stripComments(`const u = 'http://x/sse'; const v = 'keep';`)).toMatch(/keep/);
  });

  it('the param NAME is written as a literal in exactly one place', () => {
    // Read the value off the module rather than restating it: a test that
    // hard-codes 'queries' is itself the duplicate it is trying to forbid.
    const literal = new RegExp(`['"\`]${INTEREST_PARAM}['"\`]`);
    const offenders = SOURCES.filter(
      (f) => !isTest(f.rel) && !isContractFile(f.rel) && literal.test(f.text) && writesInterestLiteral(f.raw, f.rel),
    ).map((f) => f.rel);

    expect(offenders).toEqual([]);

    // Positive control: the ONE legitimate definition is present and matched.
    const contract = SOURCES.find((f) => isContractFile(f.rel));
    expect(contract).toBeDefined();
    expect(literal.test(contract!.text)).toBe(true);
    expect(writesInterestLiteral(contract!.raw, contract!.rel)).toBe(true);

    // Calibration: a real literal counts; the name nested in a string does not.
    const q = JSON.stringify(INTEREST_PARAM);
    expect(writesInterestLiteral(`const p = '${INTEREST_PARAM}';`, 'probe.ts')).toBe(true);
    expect(writesInterestLiteral(`const body = '{${q}:[]}';`, 'probe.ts')).toBe(false);
    expect(writesInterestLiteral(`type Row = ReturnType<typeof dehydrate>[${q}][number];`, 'probe.ts')).toBe(false);
    expect(writesInterestLiteral(`type Param = ${q}; const p = ${q};`, 'probe.ts')).toBe(true);
  });

  it('the CAP is compared in exactly one place', () => {
    // A second `> MAX_DECLARED_QUERY_NAMES` is not a drifted VALUE — the symbol
    // guarantees the value — but it is a second decision site, which is how
    // "refuse" on one side and "truncate" on the other get to disagree.
    const comparison = /(?:[<>]=?\s*MAX_DECLARED_QUERY_NAMES)|(?:MAX_DECLARED_QUERY_NAMES\s*[<>]=?[^=])/;
    const deciders = SOURCES.filter((f) => !isTest(f.rel) && comparison.test(f.text)).map(
      (f) => f.rel,
    );

    expect(deciders.map((r) => r.split(sep).join('/'))).toEqual([
      CONTRACT_FILE.split(sep).join('/'),
    ]);
  });

  it('the SSE route derives its declaration rather than hand-parsing the param', () => {
    const route = SOURCES.find(
      (f) => f.rel.includes('zero-harness') && f.rel.endsWith(`sse.ts`),
    );
    expect(route).toBeDefined();

    // Hand-assembly tells: a quoted param name pulled straight off the URL, or
    // the delimiter split re-implemented outside the contract module. Either
    // one means the route stopped agreeing with the client BY CONSTRUCTION and
    // started agreeing with it by coincidence.
    expect(route!.text).not.toMatch(/searchParams\.get\(\s*['"`]/);
    expect(route!.text).not.toMatch(/\.split\(\s*['"`],['"`]\s*\)/);

    // Positive control: it does reach the contract, by import.
    expect(route!.text).toMatch(/from '@papercusp\/sync\/server'/);
  });

  it('the cap value itself is stated once and everyone else imports the symbol', () => {
    // Scoped to files that participate at all — a bare numeric scan would drown
    // in HTTP 500s and page sizes and could never be made to mean anything.
    const participants = SOURCES.filter(
      (f) => !isTest(f.rel) && !isContractFile(f.rel) && f.text.includes('MAX_DECLARED_QUERY_NAMES'),
    );
    expect(participants.length).toBeGreaterThan(0); // positive control

    const restated = participants
      .filter((f) => new RegExp(`=\\s*${MAX_DECLARED_QUERY_NAMES}\\b`).test(f.text))
      .map((f) => f.rel);
    expect(restated).toEqual([]);
  });
});
