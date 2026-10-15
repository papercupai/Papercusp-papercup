/**
 * no-eager-execfile-promisify-guard.test.ts — the eager-execFile-promisify CI
 * guard's detection predicate (EI-10161).
 *
 * The guard (`scripts/check-no-eager-execfile-promisify.mjs`) runs green on the
 * clean tree (its BASELINE grandfathers pre-existing sites). This locks the
 * direction EI-10161 actually asks for — that it FLAGS a NEW module-scope eager
 * `const x = promisify(execFile)` while NOT flagging an already-lazy (function-body)
 * promisify call, a differently-named promisify target, or a prose mention.
 */
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, it, expect, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicate only.
import { usesEagerExecFilePromisify } from '../../../../scripts/check-no-eager-execfile-promisify.mjs';

describe.each([
  ['../harness/git-sync/pot-integration-mode.ts', 'execFileAsync'],
  ['../harness/git-sync/standing-pr-merge-deps.ts', 'execFileP'],
  ['../harness/git-sync/standing-pr-merge-live.ts', 'execFileP'],
  ['../backup/state-census-producers.ts', 'execFileAsync'],
  ['../fleet-logs-gc.ts', 'execFileAsync'],
  ['../goal-brief-live-probe.test-helper.ts', 'execute'],
  ['../../../../papercusp-desktop/bin/lib/server-container.mjs', 'execFileAsync'],
])('%s subprocess wrapper', (module, binding) => {
  function loadWrapper(execFile: unknown,
    wrap: (fn: Parameters<typeof promisify>[0]) => ReturnType<typeof promisify> = promisify) {
    const source = readFileSync(new URL(module, import.meta.url), 'utf8');
    const tree = ts.createSourceFile(module, source, ts.ScriptTarget.Latest, true);
    const declarations = tree.statements.filter((statement) =>
      ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) =>
        ts.isIdentifier(declaration.name) && declaration.name.text.startsWith(binding),
      ),
    );
    expect(declarations.length).toBeGreaterThan(0);
    const { outputText } = ts.transpileModule(declarations.map((statement) => statement.getText(tree)).join('\n'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    });
    return runInNewContext(`${outputText}\n${binding}`, { execFile, promisify: wrap });
  }

  it('loads the real wrapper without resolving a missing execFile in a narrow subprocess mock', () => {
    expect(typeof loadWrapper(undefined)).toBe('function');
  });

  it('memoizes promisify at first use and forwards calls and callback failures', async () => {
    const result = { stdout: 'git output', stderr: '' };
    const failure = new Error('git failed');
    const execFile = vi.fn((file: string, args: string[], options: object,
      callback: (error: Error | null, output?: typeof result) => void) => {
      callback(args.includes('fail') ? failure : null, result);
    });
    const wrap = vi.fn(promisify);
    const wrapper = loadWrapper(execFile, wrap);
    expect(wrap).not.toHaveBeenCalled();
    const options = { cwd: '/repo' };
    await expect(wrapper('git', ['status'], options)).resolves.toEqual(result);
    await expect(wrapper('git', ['fail'], options)).rejects.toBe(failure);
    expect(wrap).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[0].slice(0, 3)).toEqual(['git', ['status'], options]);
  });
});

describe('no-eager-execfile-promisify guard predicate (EI-10161)', () => {
  it('FLAGS a module-scope `const x = promisify(execFile)`', () => {
    expect(usesEagerExecFilePromisify("const execFileP = promisify(execFile);")).toBe(true);
  });

  it('FLAGS the execFileCb-aliased-import variant', () => {
    expect(usesEagerExecFilePromisify("const execFileP = promisify(execFileCb);")).toBe(true);
  });

  it('FLAGS an exported module-scope binding', () => {
    expect(usesEagerExecFilePromisify("export const pexec = promisify(execFile);")).toBe(true);
  });

  it('does NOT flag the lazy memoized wrapper WI-10005282 applied to 14 files', () => {
    const lazy = [
      'let execFileAsyncMemo: typeof execFile.__promisify__ | null = null;',
      'const execFileAsync = ((...args: unknown[]) =>',
      '  Reflect.apply((execFileAsyncMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;',
    ].join('\n');
    expect(usesEagerExecFilePromisify(lazy, 'x.ts')).toBe(false);
  });

  it('still FLAGS a column-0 eager call alongside other code (the raw pre-filter must not hide it)', () => {
    const eager = ["import { promisify } from 'node:util';", 'const execFileP = promisify(execFile);'].join('\n');
    expect(usesEagerExecFilePromisify(eager, 'x.ts')).toBe(true);
  });

  it('does NOT flag a lazy (function-body, indented) promisify call', () => {
    const lazy = [
      'let cached = null;',
      'function execFileP(...args) {',
      '  if (!cached) cached = promisify(execFile);',
      '  return cached(...args);',
      '}',
    ].join('\n');
    expect(usesEagerExecFilePromisify(lazy)).toBe(false);
  });

  it('does NOT flag an unrelated module-scope promisify target (e.g. fs)', () => {
    expect(usesEagerExecFilePromisify('const readFileP = promisify(readFileCb);')).toBe(false);
  });

  it('does NOT flag a mention only in a comment (comments are stripped)', () => {
    const codeWithComment = [
      '// do NOT do `const execFileP = promisify(execFile)` at module scope here',
      '/** see the lazy execFileP wrapper below instead */',
      'function ok() { return null; }',
    ].join('\n');
    expect(usesEagerExecFilePromisify(codeWithComment)).toBe(false);
  });
});
