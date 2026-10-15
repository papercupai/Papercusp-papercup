/**
 * EI-19282401068515102 — the mock-cast-escape detector + ratchet gate.
 *
 * The case that motivated it (WI-6673): fixtures for `readIssueClaimability` were
 * installed via `.mockImplementation((...) => ({...})) as never)`, so adding the
 * required `admitted` field went unnoticed by tsc and took 14 tests down at runtime.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs guard script, no type declarations by design
import { decide, decidePerFile, findMockCastEscapesInText } from '../../../../scripts/check-mock-cast-escape.mjs';
import { runGuardScript } from '../testing-guard-script';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('findMockCastEscapesInText', () => {
  it('flags a single-line `.mockResolvedValue(... as never)`', () => {
    const src = `recM.mockResolvedValue(null as never);`;
    const found = findMockCastEscapesInText(src);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ line: 1, verb: 'mockResolvedValue', kind: 'never' });
  });

  it('flags `.mockReturnValue(... as any)`', () => {
    const src = `fn.mockReturnValue(x as any);`;
    const found = findMockCastEscapesInText(src);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('any');
  });

  it('flags a multi-line `.mockImplementation((...) => ({...})) as never)` call', () => {
    const src = [
      'readM.mockImplementation((async (_filter, _opts, readOpts) => ({',
      '  breakdown: BREAKDOWN,',
      '  rows: [],',
      '})) as never);',
    ].join('\n');
    const found = findMockCastEscapesInText(src);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ line: 1, verb: 'mockImplementation', kind: 'never' });
  });

  it('flags `Once` variants too', () => {
    const src = `candM.mockResolvedValueOnce([] as never);`;
    const found = findMockCastEscapesInText(src);
    expect(found).toHaveLength(1);
    expect(found[0].verb).toBe('mockResolvedValueOnce');
  });

  it('does NOT flag a mock call whose argument is properly typed (no cast)', () => {
    const src = `recM.mockResolvedValue(null);`;
    expect(findMockCastEscapesInText(src)).toHaveLength(0);
  });

  it('does NOT flag a cast to a REAL type — only a bare `as never`/`as any`', () => {
    const src = `fn.mockReturnValue(x as any as ReturnType<typeof realFn>);`;
    expect(findMockCastEscapesInText(src)).toHaveLength(0);
  });

  it('does NOT flag `as never` appearing only in a comment or string', () => {
    const src = [
      '// old code used to do: fn.mockReturnValue(x as never)',
      'fn.mockReturnValue(realValue);',
    ].join('\n');
    expect(findMockCastEscapesInText(src)).toHaveLength(0);
  });

  it('counts multiple occurrences across the same file, each with its own line number', () => {
    const src = ['a.mockResolvedValue(1 as never);', 'b.mockReturnValue(2 as any);'].join('\n');
    const found = findMockCastEscapesInText(src);
    // Annotated because the helper is imported from an untyped `.mjs` script, so `found` is
    // `any` and the callback parameter would otherwise be an implicit-any (TS7006) gate red.
    expect(found.map((f: { line: number }) => f.line)).toEqual([1, 2]);
  });
});

/**
 * EI-20059456952698638 — FALSIFIABILITY.
 *
 * These are the cases that made the previous hand-rolled lexer wrong, in BOTH directions.
 * They are the point of the AST rewrite, so they are pinned here as fixture STRINGS: a
 * detector that silently matches nothing is indistinguishable from a clean repo, so each
 * "ignores X" case below is paired with a live offender in the SAME fixture, proving the
 * detector was still capable of firing when it declined to.
 *
 * (Fixture strings, never a mutation of a real tracked file: git-sync commits the whole
 * tree on a timer, so a probe that edits the shared tree can be committed even when
 * nothing goes wrong and no handler fails.)
 */
describe('findMockCastEscapesInText — lexical traps that broke the pre-AST detector', () => {
  it('is not blinded by a regex literal containing a quote (the whole-file blanking bug)', () => {
    // The old masker had no regex-literal state: the `'` below opened a "string" that ran
    // to EOF, blanking every later line. It reported ZERO escapes for this exact shape.
    const src = [`const QUOTE_RE = /['"]/g;`, `vi.mocked(realFn).mockResolvedValue({ stale: true } as never);`].join('\n');
    const found = findMockCastEscapesInText(src);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ line: 2, verb: 'mockResolvedValue', kind: 'never' });
  });

  it('is not blinded by a regex literal containing a slash or a comment-lookalike', () => {
    const src = [`const URL_RE = /https?:\\/\\/[^"']+/;`, `const NOT_A_COMMENT = /[/*]/;`, `fn.mockReturnValue(x as any);`].join('\n');
    expect(findMockCastEscapesInText(src)).toHaveLength(1);
  });

  it('flags a cast followed by a TRAILING COMMA — i.e. any prettier-formatted multi-line call', () => {
    // The old `/\bas\s+(never|any)\s*$/` was anchored, so the comma prettier emits here
    // defeated it. 13 real escapes in this repo were invisible for this reason alone.
    const src = ['vi.mocked(lookup).mockReturnValue(', '  makeTool({ handler: vi.fn() }) as never,', ');'].join('\n');
    const found = findMockCastEscapesInText(src);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ line: 1, kind: 'never' });
  });

  it('flags an installed arrow whose concise body is the cast (the return value is what is checked)', () => {
    const src = `getAcct.mockImplementation((_pool: unknown, id: string) => ({ id }) as never);`;
    expect(findMockCastEscapesInText(src)).toHaveLength(1);
  });

  it('attributes each link of a CHAINED mock call to its own line, not the head of the chain', () => {
    const src = ['spawnSyncMock', '  .mockReturnValueOnce({ status: 0 } as never)', '  .mockReturnValueOnce({ status: 1 } as never);'].join('\n');
    const found = findMockCastEscapesInText(src);
    expect(found.map((f: { line: number }) => f.line)).toEqual([2, 3]);
  });

  it('ignores `as never` in a comment, a string, a template literal and a regex — while still flagging real code beside them', () => {
    const src = [
      '// historical: fn.mockReturnValue(x as never)',
      '/* also fn.mockResolvedValue(y as never) */',
      `const s = "fn.mockReturnValue(z as never)";`,
      'const t = `fn.mockReturnValue(q as never)`;',
      'const r = /fn\\.mockReturnValue\\(w as never\\)/;',
      'realFn.mockReturnValue(actual as never);', // <- the ONLY live offender
    ].join('\n');
    const found = findMockCastEscapesInText(src);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(6);
  });

  it('does NOT flag a cast nested deeper inside an argument (deliberately out of policy)', () => {
    const src = `fn.mockResolvedValue(makeThing({ inner: 1 as never }));`;
    expect(findMockCastEscapesInText(src)).toHaveLength(0);
  });

  it('parses TSX without losing the tree when a filename says so', () => {
    const src = ['const el = <div className="x">{"y"}</div>;', 'fn.mockReturnValue(el as never);'].join('\n');
    expect(findMockCastEscapesInText(src, 'fixture.test.tsx')).toHaveLength(1);
  });
});

describe('decide (ratchet-only-down policy)', () => {
  it('fails when the count exceeds the baseline', () => {
    expect(decide({ count: 10, baselineCount: 5 })).toEqual({ verdict: 'fail-exceeds' });
  });

  it('reports ok-below (never auto-locks) when the count drops without --update', () => {
    expect(decide({ count: 3, baselineCount: 5 })).toEqual({ verdict: 'ok-below', belowBy: 2 });
  });

  it('ratchets the baseline down only when --update is explicit', () => {
    expect(decide({ count: 3, baselineCount: 5, updateFlag: true })).toEqual({
      verdict: 'ok-ratchet',
      newBaseline: 3,
    });
  });

  it('is ok when the count exactly equals the baseline', () => {
    expect(decide({ count: 5, baselineCount: 5 })).toEqual({ verdict: 'ok' });
  });
});

describe('decidePerFile (non-fungible ratchet policy)', () => {
  it('fails when a different file adds an escape even if another file removes more', () => {
    expect(
      decidePerFile({
        baseline: { 'a.test.ts': 10, 'b.test.ts': 2 },
        current: { 'a.test.ts': 8, 'b.test.ts': 3 },
      }),
    ).toMatchObject({
      verdict: 'fail-file-increase',
      increases: [{ file: 'b.test.ts', count: 3, baselineCount: 2, delta: 1 }],
      decreases: [{ file: 'a.test.ts', count: 8, baselineCount: 10, delta: 2 }],
    });
  });

  it('treats the first escape in a new file as an increase from zero', () => {
    expect(decidePerFile({ baseline: {}, current: { 'new.test.ts': 1 } })).toMatchObject({
      verdict: 'fail-file-increase',
      increases: [{ file: 'new.test.ts', count: 1, baselineCount: 0, delta: 1 }],
    });
  });

  it('only locks decreases in with an explicit update', () => {
    const args = { baseline: { 'a.test.ts': 3 }, current: { 'a.test.ts': 2 } };
    expect(decidePerFile(args).verdict).toBe('ok-below-files');
    expect(decidePerFile({ ...args, updateFlag: true }).verdict).toBe('ok-ratchet-files');
  });
});

describe('the --json CLI report', () => {
  it('fully drains a large piped report before returning the verdict status', () => {
    const guard = runGuardScript('node', ['scripts/check-mock-cast-escape.mjs', '--json'], {
      cwd: REPO_ROOT,
      timeoutMs: 180_000,
    });

    let report: {
      count: number;
      baselineCount: number;
      targetCount: number;
      verdict: string;
      increases: unknown[];
      byFile: Record<string, unknown[]>;
    };
    try {
      report = JSON.parse(guard.stdout) as typeof report;
    } catch {
      throw new Error(`the mock-cast-escape guard produced no parseable --json report:\n${guard.output}`);
    }

    expect(report.count).toBeGreaterThanOrEqual(0);
    expect(report.baselineCount).toBeGreaterThanOrEqual(0);
    expect(report.targetCount).toBeGreaterThanOrEqual(0);
    const baseline = JSON.parse(readFileSync(path.join(REPO_ROOT, '.mock-cast-escape-baseline.json'), 'utf8'));
    const current = Object.fromEntries(Object.entries(report.byFile).map(([file, hits]) => [file, hits.length]));
    const decision = baseline.byFile
      ? decidePerFile({ current, baseline: baseline.byFile })
      : decide({ count: report.count, baselineCount: baseline.count });
    expect(Object.values(current).reduce((sum, count) => sum + count, 0)).toBe(report.count);
    expect(report.baselineCount).toBe(baseline.count);
    expect(report.increases).toEqual(decision.increases ?? []);
    expect(report.verdict).toBe(decision.verdict);
    expect(report.verdict).toMatch(/^(?:fail-file-increase|fail-exceeds|ok-ratchet-files|ok-below-files|ok-ratchet|ok-below|ok)$/);
    expect(guard.status, guard.output).toBe(report.verdict.startsWith('fail-') ? 1 : 0);
  }, 240_000);
});
