import { describe, expect, it } from 'vitest';
import {
  classifyCloseCoverage,
  closeCoverageWarningText,
  directImportCoverageMapping,
  relativeImportSpecifiers,
  type CloseCoverageTestRun,
  type CoverageMapping,
} from './work-item-close-coverage';

const W0 = 1_000;
const W1 = 10_000;
const edit = (file: string, tsMs = 2_000) => ({ file, tsMs });
const run = (testFile: string, status: string, worktreeDirty: boolean | null, finishedAtMs = 5_000): CloseCoverageTestRun => ({
  testFile,
  status,
  worktreeDirty,
  finishedAtMs,
});
// An injected affected-tests mapping: a.test.ts exercises a.ts; b.ts is exercised by nothing that ran.
const mapping: CoverageMapping = (f, t) => (f === 'lib/a.ts' && t === 'lib/a.test.ts') || (f === 'lib/c.ts' && t === 'lib/x.test.ts');

describe('classifyCloseCoverage (R-10)', () => {
  it('reports the edited file no run exercised, and only that file', () => {
    const r = classifyCloseCoverage({
      edits: [edit('lib/a.ts'), edit('lib/b.ts'), edit('lib/a.ts', 3_000)],
      testRuns: [run('lib/a.test.ts', 'pass', false)],
      covers: mapping,
      windowStartMs: W0,
      windowEndMs: W1,
    });
    expect(r.editedFiles).toEqual(['lib/a.ts', 'lib/b.ts']);
    expect(r.uncoveredFiles).toEqual(['lib/b.ts']);
    expect(r.coveredFiles).toEqual(['lib/a.ts']);
    expect(r.anyCleanPass).toBe(true);
    expect(r.cleanTree).toBe('clean-pass');
  });

  it('a failing run still exercised its file; a skipped or out-of-window run did not', () => {
    const r = classifyCloseCoverage({
      edits: [edit('lib/a.ts'), edit('lib/c.ts')],
      testRuns: [run('lib/a.test.ts', 'fail', false), run('lib/x.test.ts', 'skip', false), run('lib/x.test.ts', 'pass', false, W1 + 1)],
      covers: mapping,
      windowStartMs: W0,
      windowEndMs: W1,
    });
    expect(r.coveredFiles).toEqual(['lib/a.ts']);
    expect(r.uncoveredFiles).toEqual(['lib/c.ts']);
    expect(r.cleanTree).toBe('no-pass');
    expect(r.anyCleanPass).toBe(false);
  });

  it('an edited test file is covered by its own run without any mapping', () => {
    const r = classifyCloseCoverage({
      edits: [edit('lib/z.test.ts')],
      testRuns: [run('lib/z.test.ts', 'pass', true)],
      covers: () => false,
      windowStartMs: W0,
      windowEndMs: W1,
    });
    expect(r.uncoveredFiles).toEqual([]);
    expect(r.cleanTree).toBe('dirty-only');
    expect(r.anyCleanPass).toBe(false);
  });

  it('states unknown when no passing run is clean and one did not record the flag', () => {
    const r = classifyCloseCoverage({
      edits: [edit('lib/a.ts')],
      testRuns: [run('lib/a.test.ts', 'pass', true), run('lib/a.test.ts', 'pass', null)],
      covers: mapping,
      windowStartMs: W0,
      windowEndMs: W1,
    });
    expect(r.cleanTree).toBe('unknown');
    expect(r.passingRuns).toBe(2);
  });
});

describe('closeCoverageWarningText', () => {
  it('names the uncovered file and the dirty-only pass, and says the close is not refused', () => {
    const r = classifyCloseCoverage({
      edits: [edit('lib/a.ts'), edit('lib/b.ts')],
      testRuns: [run('lib/a.test.ts', 'pass', true)],
      covers: mapping,
      windowStartMs: W0,
      windowEndMs: W1,
    });
    const w = closeCoverageWarningText('WI-1', r)!;
    expect(w).toContain('lib/b.ts');
    expect(w).not.toContain('lib/a.ts,');
    expect(w).toContain('DIRTY');
    expect(w).toContain('not refused');
  });

  it('is silent when every edited file is covered by a clean pass', () => {
    const r = classifyCloseCoverage({
      edits: [edit('lib/a.ts')],
      testRuns: [run('lib/a.test.ts', 'pass', false)],
      covers: mapping,
      windowStartMs: W0,
      windowEndMs: W1,
    });
    expect(closeCoverageWarningText('WI-1', r)).toBeUndefined();
  });
});

describe('directImportCoverageMapping', () => {
  const sources: Record<string, string> = {
    'pkg/lib/__tests__/thing.test.ts': "import { x } from '../other';\nvi.mock('../dep.js');",
    'pkg/lib/far.test.ts': "const m = await import('./sub/index');",
  };
  const covers = directImportCoverageMapping((t) => sources[t] ?? null);

  it('matches sibling tests, direct relative imports and index imports', () => {
    expect(covers('pkg/lib/thing.ts', 'pkg/lib/thing.test.ts')).toBe(true);
    expect(covers('pkg/lib/thing.ts', 'pkg/lib/__tests__/thing.test.ts')).toBe(true);
    expect(covers('pkg/lib/other.ts', 'pkg/lib/__tests__/thing.test.ts')).toBe(true);
    expect(covers('pkg/lib/dep.ts', 'pkg/lib/__tests__/thing.test.ts')).toBe(true);
    expect(covers('pkg/lib/sub/index.ts', 'pkg/lib/far.test.ts')).toBe(true);
  });

  it('does not match an unrelated file or a non-code file', () => {
    expect(covers('pkg/lib/unrelated.ts', 'pkg/lib/__tests__/thing.test.ts')).toBe(false);
    expect(covers('pkg/README.md', 'pkg/lib/far.test.ts')).toBe(false);
  });

  it('reads import, dynamic import, require and mock specifiers', () => {
    expect(relativeImportSpecifiers("import a from './a';\nconst b = require('../b');\nimport './c';").sort()).toEqual([
      '../b',
      './a',
      './c',
    ]);
  });
});
