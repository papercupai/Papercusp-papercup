/**
 * Unit tests for the tsc diagnostic projection behind `build:typecheck`
 * (plan `bash-to-tool-substitution-2026-07-26`, P-024).
 *
 * The fixtures are VERBATIM lines from a real
 * `tsc -p packages/operator-core/tsconfig.json --noEmit --pretty false` run
 * (TypeScript 6.0.3) and from the three no-op shapes reproduced live at the
 * repo root — not hand-written approximations of what tsc might print.
 */

import { describe, expect, it } from 'vitest';
import {
  NO_INPUT_CODES,
  errorsOnly,
  filterToDirs,
  filterToFiles,
  noInputDiagnostic,
  parseFoundSummary,
  parseTscDiagnostics,
  splitVanishedIncludeFiles,
  summariseByFile,
  syntaxBrokenFiles,
  vanishedIncludeFile,
} from './tsc-diagnostics';

/** Verbatim from the live operator-core run. */
const REAL_OUTPUT = [
  "libs/generic/sync/src/index.ts(1,30): error TS6142: Module './SyncProvider' was resolved to '/home/x/SyncProvider.tsx', but '--jsx' is not set.",
  "libs/generic/sync/src/virtualizer/use-sync-virtualizer.ts(283,5): error TS2322: Type '(index: number) => string | number | bigint | unique symbol' is not assignable to type '(index: number) => Key'.",
  "  Type 'string | number | bigint | unique symbol' is not assignable to type 'Key'.",
  "    Type 'typeof React.optimisticKey' is not assignable to type 'Key'.",
  "libs/papercusp/packages/orchestrator/src/invoke.ts(2356,53): error TS2345: Argument of type 'readonly string[]' is not assignable to parameter of type 'string[]'.",
  "  The type 'readonly string[]' is 'readonly' and cannot be assigned to the mutable type 'string[]'.",
  "packages/plugin-loader/src/wasm/jco-transpiler.ts(49,26): error TS2307: Cannot find module '@bytecodealliance/jco' or its corresponding type declarations.",
].join('\n');

describe('parseTscDiagnostics', () => {
  it('parses one diagnostic per top-level line, with full location + code', () => {
    const diagnostics = parseTscDiagnostics(REAL_OUTPUT);
    expect(diagnostics).toHaveLength(4);
    expect(diagnostics[0]).toMatchObject({
      file: 'libs/generic/sync/src/index.ts',
      line: 1,
      column: 30,
      code: 'TS6142',
      category: 'error',
    });
    expect(diagnostics[3]).toMatchObject({ file: 'packages/plugin-loader/src/wasm/jco-transpiler.ts', line: 49, column: 26, code: 'TS2307' });
  });

  it('folds nested continuation lines into the preceding diagnostic (that is where the cause is)', () => {
    const [, assignability] = parseTscDiagnostics(REAL_OUTPUT);
    expect(assignability.message).toContain("is not assignable to type '(index: number) => Key'");
    // The nested detail is retained, not dropped — otherwise the agent has to go
    // re-read the raw log, re-creating the pipe this tool removes.
    expect(assignability.message).toContain("Type 'typeof React.optimisticKey' is not assignable");
  });

  it('caps a pathologically nested message rather than returning it unbounded', () => {
    const nested = ['a.ts(1,1): error TS2322: head.', ...Array.from({ length: 200 }, (_, i) => `${'  '.repeat(i % 8 + 1)}nested detail line ${i} with filler text`)].join('\n');
    const [d] = parseTscDiagnostics(nested);
    expect(d.message.length).toBeLessThanOrEqual(410);
    expect(d.message.endsWith('…')).toBe(true);
  });

  it('parses a global (unattributed) error with a null file', () => {
    const [d] = parseTscDiagnostics("error TS5057: Cannot find a tsconfig.json file at the specified directory: '.'.");
    expect(d).toMatchObject({ file: null, line: null, column: null, code: 'TS5057', category: 'error' });
  });

  it('ignores non-diagnostic chatter instead of inventing entries', () => {
    expect(parseTscDiagnostics('Version 6.0.3\n\nCOMMON COMMANDS\n\n  tsc --init\n')).toHaveLength(0);
  });

  it('returns nothing for empty output (never a phantom clean result)', () => {
    expect(parseTscDiagnostics('')).toHaveLength(0);
  });

  it('handles CRLF output', () => {
    expect(parseTscDiagnostics('a.ts(1,2): error TS1005: x\r\n')).toHaveLength(1);
  });
});

describe('no-op detection — the correctness argument for the tool', () => {
  // Each string is the LIVE output of that command at the papercusp repo root,
  // which has no root tsconfig.json (only tsconfig.base.json).
  it.each([
    ['tsc --noEmit -p .', "error TS5057: Cannot find a tsconfig.json file at the specified directory: '.'.", 'TS5057'],
    ['tsc --noEmit -p tsconfig.json', "error TS5058: The specified path does not exist: 'tsconfig.json'.", 'TS5058'],
    ['a tsconfig matching no inputs', "error TS18003: No inputs were found in config file '/x/tsconfig.json'.", 'TS18003'],
    ['a missing file operand', "error TS6053: File '/x/nope.ts' not found.", 'TS6053'],
  ])('flags %s as having typechecked nothing', (_label, output, code) => {
    const found = noInputDiagnostic(parseTscDiagnostics(output));
    expect(found?.code).toBe(code);
    expect(NO_INPUT_CODES.has(code)).toBe(true);
  });

  it('does NOT flag a real type error as a no-op', () => {
    expect(noInputDiagnostic(parseTscDiagnostics(REAL_OUTPUT))).toBeNull();
  });

  it('does not flag a merely EMPTY result — that is a clean project, not a no-op', () => {
    expect(noInputDiagnostic(parseTscDiagnostics(''))).toBeNull();
  });
});

describe('include-glob files that vanish mid-run (EI-24801454238382823)', () => {
  // VERBATIM TypeScript 6.0.3 output, produced by listing a file in the include glob and
  // deleting it before the program read it (parseJsonSourceFileConfigFileContent with a
  // readDirectory that still returns the deleted path, then createProgram — the same
  // pipeline `tsc -p` runs). The other two are the same code with the other two causes.
  const INCLUDE_RACE = [
    "error TS6053: File '/r/packages/operator-core/lib/workspace-host/__mutprobe_x/a.test.ts' not found.",
    '  The file is in the program because:',
    "    Matched by include pattern 'lib/**/*.ts' in '/r/packages/operator-core/tsconfig.json'",
  ].join('\n');
  const FILES_LIST_MISSING = [
    "error TS6053: File '/r/nope.ts' not found.",
    '  The file is in the program because:',
    "    Part of 'files' list in tsconfig.json",
  ].join('\n');
  const OPERAND_MISSING = [
    "error TS6053: File '/r/nope.ts' not found.",
    '  The file is in the program because:',
    '    Root file specified for compilation',
  ].join('\n');

  it('names the vanished path and does NOT call the run a no-op — the rest of the program was checked', () => {
    const d = parseTscDiagnostics(INCLUDE_RACE);
    expect(d).toHaveLength(1);
    expect(vanishedIncludeFile(d[0])).toBe('/r/packages/operator-core/lib/workspace-host/__mutprobe_x/a.test.ts');
    expect(noInputDiagnostic(d)).toBeNull();
  });

  it.each([
    ['a missing files-list entry', FILES_LIST_MISSING],
    ['a missing CLI operand', OPERAND_MISSING],
    ['a TS6053 with no explanation at all', "error TS6053: File '/x/nope.ts' not found."],
  ])('keeps %s as a genuine no-input refusal', (_label, output) => {
    const d = parseTscDiagnostics(output);
    expect(vanishedIncludeFile(d[0])).toBeNull();
    expect(noInputDiagnostic(d)?.code).toBe('TS6053');
  });

  it('still refuses when a genuine no-input diagnostic rides beside a vanished glob file', () => {
    const d = parseTscDiagnostics(`${INCLUDE_RACE}\n${OPERAND_MISSING}`);
    expect(noInputDiagnostic(d)?.message).toContain("File '/r/nope.ts' not found.");
  });

  it('splits vanished files out, de-duplicated, and keeps every real error in order', () => {
    const output = [INCLUDE_RACE, INCLUDE_RACE, REAL_OUTPUT].join('\n');
    const { vanished, rest } = splitVanishedIncludeFiles(parseTscDiagnostics(output));
    expect(vanished).toEqual(['/r/packages/operator-core/lib/workspace-host/__mutprobe_x/a.test.ts']);
    expect(rest).toEqual(parseTscDiagnostics(REAL_OUTPUT));
    expect(rest.length).toBeGreaterThan(0);
  });

  it('ignores a LOCATED TS6053 — only the global "file not found" form is a listing race', () => {
    const d = parseTscDiagnostics(
      "a.ts(1,1): error TS6053: File '/r/b.ts' not found. The file is in the program because: Matched by include pattern 'x' in 'y'",
    );
    expect(vanishedIncludeFile(d[0])).toBeNull();
  });
});

describe('syntaxBrokenFiles', () => {
  it('names files with a TS1xxx parse error (tsc under-reports behind them)', () => {
    const d = parseTscDiagnostics([
      "a.ts(1,1): error TS1005: ';' expected.",
      'b.ts(2,2): error TS2322: not assignable.',
    ].join('\n'));
    expect(syntaxBrokenFiles(d)).toEqual(['a.ts']);
  });

  it('does not classify TS1320 semantic await/type errors as syntax failures', () => {
    const d = parseTscDiagnostics(
      "a.ts(597,60): error TS1320: Type of 'await' operand must either be a valid promise or must not contain a callable 'then' member.",
    );
    expect(syntaxBrokenFiles(d)).toEqual([]);
  });

  it('is empty when only semantic errors are present', () => {
    expect(syntaxBrokenFiles(parseTscDiagnostics(REAL_OUTPUT))).toEqual([]);
  });
});

describe('summariseByFile', () => {
  it('counts per file, most errors first', () => {
    const d = parseTscDiagnostics([
      'a.ts(1,1): error TS1: x',
      'b.ts(1,1): error TS1: x',
      'b.ts(2,1): error TS1: x',
    ].join('\n'));
    expect(summariseByFile(d)).toEqual([{ file: 'b.ts', count: 2 }, { file: 'a.ts', count: 1 }]);
  });

  it('buckets unattributed errors rather than dropping them', () => {
    expect(summariseByFile(parseTscDiagnostics('error TS5057: nope.'))).toEqual([{ file: '(unattributed)', count: 1 }]);
  });
});

describe('errorsOnly', () => {
  it('excludes warnings so the count matches what gates a build', () => {
    const d = parseTscDiagnostics(['a.ts(1,1): error TS1: x', 'a.ts(2,1): warning TS2: y'].join('\n'));
    expect(errorsOnly(d)).toHaveLength(1);
  });
});

describe('filterToFiles — the server-side form of `| grep myfile`', () => {
  const diagnostics = parseTscDiagnostics([
    'packages/operator-core/lib/run.ts(1,1): error TS1: x',
    'packages/operator-core/lib/prerun.ts(1,1): error TS1: y',
    'apps/operator/lib/run.ts(1,1): error TS1: z',
  ].join('\n'));

  it('matches on a repo-root-relative path', () => {
    expect(filterToFiles(diagnostics, ['packages/operator-core/lib/run.ts'])).toHaveLength(1);
  });

  it('matches a suffix, since tsc emits paths relative to the tsconfig', () => {
    expect(filterToFiles(diagnostics, ['lib/prerun.ts']).map((d) => d.file)).toEqual(['packages/operator-core/lib/prerun.ts']);
  });

  it('anchors the suffix at a segment boundary so run.ts never matches prerun.ts', () => {
    const only = filterToFiles(diagnostics, ['run.ts']).map((d) => d.file);
    expect(only).toEqual(['packages/operator-core/lib/run.ts', 'apps/operator/lib/run.ts']);
    expect(only).not.toContain('packages/operator-core/lib/prerun.ts');
  });

  it('drops unattributed diagnostics (they belong to no file)', () => {
    expect(filterToFiles(parseTscDiagnostics('error TS5057: nope.'), ['a.ts'])).toEqual([]);
  });

  it('normalises windows separators and a leading ./', () => {
    expect(filterToFiles(diagnostics, ['./packages/operator-core/lib/run.ts'])).toHaveLength(1);
    expect(filterToFiles(diagnostics, ['packages\\operator-core\\lib\\run.ts'])).toHaveLength(1);
  });
});

describe('filterToDirs — the directory-attribution question filterToFiles cannot express (EI-22050606808498557)', () => {
  const diagnostics = parseTscDiagnostics([
    'apps/operator/lib/run.ts(1,1): error TS1: a',
    'apps/operator-vite/lib/entry.ts(1,1): error TS1: b',
    'apps/operator-vite/lib/nested/deep.ts(1,1): error TS1: c',
    'packages/operator-core/lib/run.ts(1,1): error TS1: d',
  ].join('\n'));

  it('keeps every diagnostic under the requested directory, at any depth', () => {
    const kept = filterToDirs(diagnostics, ['apps/operator-vite']).map((d) => d.file);
    expect(kept.sort()).toEqual([
      'apps/operator-vite/lib/entry.ts',
      'apps/operator-vite/lib/nested/deep.ts',
    ]);
  });

  it('anchors at a path-segment boundary, so "apps/operator" cannot match "apps/operator-vite"', () => {
    // The exact bug this exists to fix: a name-prefix match would silently fold the
    // sibling operator-vite tree into an operator/-scoped attribution question.
    const kept = filterToDirs(diagnostics, ['apps/operator']).map((d) => d.file);
    expect(kept).toEqual(['apps/operator/lib/run.ts']);
    expect(kept).not.toContain('apps/operator-vite/lib/entry.ts');
  });

  it('matches a diagnostic whose file IS exactly the requested directory path', () => {
    const only = parseTscDiagnostics('apps/operator(1,1): error TS1: weird');
    expect(filterToDirs(only, ['apps/operator'])).toHaveLength(1);
  });

  it('drops unattributed diagnostics (they belong to no file, so no directory)', () => {
    expect(filterToDirs(parseTscDiagnostics('error TS5057: nope.'), ['apps'])).toEqual([]);
  });

  it('normalises windows separators, a leading ./, and a trailing slash', () => {
    expect(filterToDirs(diagnostics, ['./apps/operator-vite/']).map((d) => d.file).sort()).toEqual([
      'apps/operator-vite/lib/entry.ts',
      'apps/operator-vite/lib/nested/deep.ts',
    ]);
    expect(filterToDirs(diagnostics, ['apps\\operator-vite'])).toHaveLength(2);
  });

  it('returns nothing when no diagnostic falls under the requested directory', () => {
    expect(filterToDirs(diagnostics, ['libs/nothing-here'])).toEqual([]);
  });
});

describe('parseFoundSummary — parser drift cross-check', () => {
  it('reads the tally when tsc prints one', () => {
    expect(parseFoundSummary('a.ts(1,1): error TS1: x\nFound 1 error in 1 file.')).toBe(1);
    expect(parseFoundSummary('Found 12 errors in 3 files.')).toBe(12);
    expect(parseFoundSummary('Found 0 errors.')).toBe(0);
  });

  it('returns null when absent — tsc 6.0.3 with --pretty false prints no tally, and a MISSING cross-check must not read as a mismatch', () => {
    expect(parseFoundSummary(REAL_OUTPUT)).toBeNull();
  });
});
