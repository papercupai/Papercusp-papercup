import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { applyExtractionPlan, planExtraction, type CodemodFamily, type ExtractionPlan } from './extract-codemod';

function fsOf(files: Record<string, string>) {
  const store = new Map(Object.entries(files));
  return {
    store,
    readFile: async (p: string) => store.get(p) ?? null,
    writeFile: async (p: string, t: string) => { store.set(p, t); },
  };
}

const family = (members: Array<[string, number, string]>, kind: CodemodFamily['kind'] = 'exact'): CodemodFamily =>
  ({ id: 'fam-1', kind, members: members.map(([path, line, symbol]) => ({ path, line, symbol })) });

const after = (plan: ExtractionPlan, path: string) => {
  if (plan.status !== 'planned') throw new Error(`refused: ${plan.reason}`);
  const e = plan.edits.find(x => x.path === path);
  if (!e) throw new Error(`no edit for ${path}`);
  return e.after;
};
const reason = (plan: ExtractionPlan) => (plan.status === 'refused' ? plan.reason : `planned (expected a refusal)`);
const topLevelFunctions = (text: string) =>
  ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true).statements
    .filter(ts.isFunctionDeclaration).map(f => f.name!.text);

const SUM_A = `import { clamp } from '../util/math';

function total(values: number[]): number {
  let acc = 0;
  for (const v of values) acc += clamp(v);
  return acc;
}

export function report(xs: number[]) { return total(xs); }
`;
// Same program: different whitespace, comment, and import path spelling from another directory.
const SUM_B = `import { clamp } from '../../util/math';

/** Sum of clamped values. */
function total(values: number[]): number {
  let acc = 0; // running sum
  for (const v of values) acc   +=   clamp(v);
  return acc;
}

export const used = total([1]);
`;

describe('planExtraction — accepted Type-1/2 families', () => {
  it('Type-1: exports the canonical copy, replaces the other with an import, and drops its doc comment', async () => {
    const io = fsOf({ 'src/a/sum.ts': SUM_A, 'src/b/c/sum.ts': SUM_B, 'src/util/math.ts': 'export const clamp = (n: number) => n;' });
    const plan = await planExtraction(family([['src/a/sum.ts', 3, 'total'], ['src/b/c/sum.ts', 4, 'total']]), io.readFile);
    expect(plan).toMatchObject({ status: 'planned' });
    if (plan.status !== 'planned') return;
    expect(plan.canonical).toEqual({ path: 'src/a/sum.ts', line: 3, symbol: 'total' });
    expect(after(plan, 'src/a/sum.ts')).toContain('export function total(values: number[]): number {');
    const b = after(plan, 'src/b/c/sum.ts');
    expect(b).toContain(`import { total } from '../../a/sum';`);
    expect(topLevelFunctions(b)).toEqual([]);
    expect(b).not.toContain('Sum of clamped values');
    expect(b).toContain('export const used = total([1]);');
    expect(plan.members.map(m => m.endLine)).toEqual([7, 8]);
  });

  it('Type-2: renamed function, parameters and locals import the canonical under the local name', async () => {
    const io = fsOf({
      'p/one.ts': 'function first(list: string[]) { const out = []; for (const s of list) out.push(s.trim()); return out; }\n',
      'q/two.ts': 'function second(items: string[]) { const res = []; for (const it of items) res.push(it.trim()); return res; }\nsecond([]);\n',
    });
    const plan = await planExtraction(family([['p/one.ts', 1, 'first'], ['q/two.ts', 1, 'second']], 'renamed'), io.readFile);
    const two = after(plan, 'q/two.ts');
    expect(two).toContain(`import { first as second } from '../p/one';`);
    expect(two).toContain('second([]);');
    expect(topLevelFunctions(two)).toEqual([]);
  });

  it('keeps an exported copy exported by re-exporting the imported binding', async () => {
    const io = fsOf({ 'a.ts': 'function f(x: number) { return x + 1; }\n', 'b.ts': 'export function g(y: number) { return y + 1; }\n' });
    const plan = await planExtraction(family([['a.ts', 1, 'f'], ['b.ts', 1, 'g']], 'renamed'), io.readFile);
    expect(after(plan, 'b.ts')).toBe(`import { f as g } from './a';\nexport { g };\n`);
  });

  it('accepts copies that differ only in being exported, and leaves an already-exported canonical untouched', async () => {
    const io = fsOf({ 'a.ts': 'export function f(x: number) { return x * 2; }\n', 'b.ts': 'function f(x: number) { return x * 2; }\n' });
    const plan = await planExtraction(family([['a.ts', 1, 'f'], ['b.ts', 1, 'f']]), io.readFile);
    expect(plan.status).toBe('planned');
    if (plan.status === 'planned') expect(plan.edits.map(e => e.path)).toEqual(['b.ts']);
  });

  it('treats a recursive call to the function itself as part of the program, not a free name', async () => {
    const io = fsOf({
      'a.ts': 'function fa(n: number): number { return n <= 1 ? 1 : n * fa(n - 1); }\n',
      'b.ts': 'function fb(k: number): number { return k <= 1 ? 1 : k * fb(k - 1); }\n',
    });
    const plan = await planExtraction(family([['a.ts', 1, 'fa'], ['b.ts', 1, 'fb']], 'renamed'), io.readFile);
    expect(after(plan, 'b.ts')).toContain(`import { fa as fb } from './a';`);
  });

  it('inserts the import after the existing imports', async () => {
    const io = fsOf({
      'a.ts': 'function f() { return 1; }\n',
      'b.ts': `import x from 'x';\nimport { y } from 'y';\n\nfunction f() { return 1; }\nexport const z = [x, y, f];\n`,
    });
    const plan = await planExtraction(family([['a.ts', 1, 'f'], ['b.ts', 4, 'f']]), io.readFile);
    expect(after(plan, 'b.ts')).toBe(`import x from 'x';\nimport { y } from 'y';\nimport { f } from './a';\n\nexport const z = [x, y, f];\n`);
  });
});

describe('planExtraction — refusals', () => {
  const two = (a: string, b: string) => fsOf({ 'a.ts': a, 'b.ts': b });
  const run = (io: ReturnType<typeof fsOf>, kind: CodemodFamily['kind'] = 'renamed', sa = 'f', sb = 'f') =>
    planExtraction(family([['a.ts', 1, sa], ['b.ts', 1, sb]], kind), io.readFile);

  it('refuses near and semantic families', async () => {
    const io = two('function f() { return 1; }', 'function f() { return 1; }');
    expect(reason(await run(io, 'near'))).toContain('only exact/renamed');
    expect(reason(await run(io, 'semantic'))).toContain('only exact/renamed');
  });

  it('refuses copies whose bodies differ', async () => {
    expect(reason(await run(two('function f(x: number) { return x + 1; }', 'function f(x: number) { return x + 2; }'))))
      .toContain('differs from');
  });

  it('refuses an inconsistent rename (one binding in one copy, two in the other)', async () => {
    expect(reason(await run(two('function f(a: number, b: number) { return a + a; }', 'function f(a: number, b: number) { return a + b; }'))))
      .toContain('differs from');
  });

  it('refuses when a shorthand property key would change with the rename', async () => {
    expect(reason(await run(two('function f(item: number) { return { item }; }', 'function f(entry: number) { return { entry }; }'))))
      .toContain('differs from');
  });

  it('refuses a reference to a module-local binding', async () => {
    expect(reason(await run(two('const K = 1;\nfunction f() { return K; }', 'const K = 2;\nfunction f() { return K; }'))))
      .toContain('references module-local K');
  });

  it('refuses the same specifier text that resolves to different modules from different directories', async () => {
    const io = fsOf({ 'x/a.ts': `import { h } from './h';\nfunction f() { return h(); }`, 'y/b.ts': `import { h } from './h';\nfunction f() { return h(); }` });
    expect(reason(await planExtraction(family([['x/a.ts', 2, 'f'], ['y/b.ts', 2, 'f']]), io.readFile)))
      .toContain('does not resolve to the same import');
  });

  it('refuses a free name imported from different modules', async () => {
    expect(reason(await run(two(`import { h } from './h1';\nfunction f() { return h(); }`, `import { h } from './h2';\nfunction f() { return h(); }`))))
      .toContain('does not resolve to the same import');
  });

  it('refuses a free name imported in one copy and global in the other', async () => {
    expect(reason(await run(two(`import { h } from './h1';\nfunction f() { return h(); }`, 'function f() { return h(); }'))))
      .toContain('does not resolve to the same import');
  });

  it('refuses a local declaration that shadows a module-level name', async () => {
    expect(reason(await run(two(`import { v } from './v';\nfunction f() { const v = 1; return v; }`, `import { v } from './v';\nfunction f() { const v = 1; return v; }`))))
      .toContain('also names a module-level binding');
  });

  it('refuses two copies in one file', async () => {
    const io = fsOf({ 'a.ts': 'function f() { return 1; }\nfunction g() { return 1; }\n' });
    expect(reason(await planExtraction(family([['a.ts', 1, 'f'], ['a.ts', 2, 'g']], 'renamed'), io.readFile))).toContain('share a file');
  });

  it('refuses a member that is not a top-level function declaration', async () => {
    expect(reason(await run(two('const f = () => 1;', 'const f = () => 1;')))).toContain('not a top-level function declaration');
  });

  it('refuses overloads, default exports and unreadable files', async () => {
    expect(reason(await run(two('function f(x: number): number;\nfunction f(x: number) { return x; }', 'function f(x: number) { return x; }'))))
      .toContain('overloads');
    expect(reason(await run(two('export default function f() { return 1; }', 'function f() { return 1; }')))).toContain('default export');
    expect(reason(await planExtraction(family([['a.ts', 1, 'f'], ['missing.ts', 1, 'f']]), fsOf({ 'a.ts': 'function f() {}' }).readFile)))
      .toContain('cannot read missing.ts');
  });

  it('refuses when the canonical file already imports a copy (import cycle)', async () => {
    expect(reason(await run(two(`import { other } from './b';\nfunction f() { return 1; }\nother();`, 'export function other() {}\nfunction f() { return 1; }'))))
      .toContain('import cycle');
  });
});

describe('applyExtractionPlan', () => {
  it('writes every edit when the files are unchanged since planning', async () => {
    const io = fsOf({ 'a.ts': 'function f() { return 1; }\n', 'b.ts': 'function f() { return 1; }\nf();\n' });
    const plan = await planExtraction(family([['a.ts', 1, 'f'], ['b.ts', 1, 'f']]), io.readFile);
    expect(await applyExtractionPlan(plan, io)).toEqual({ written: ['a.ts', 'b.ts'] });
    expect(io.store.get('b.ts')).toBe(`import { f } from './a';\nf();\n`);
  });

  it('writes nothing when a file changed after planning', async () => {
    const io = fsOf({ 'a.ts': 'function f() { return 1; }\n', 'b.ts': 'function f() { return 1; }\n' });
    const plan = await planExtraction(family([['a.ts', 1, 'f'], ['b.ts', 1, 'f']]), io.readFile);
    io.store.set('b.ts', '// a peer edit\nfunction f() { return 1; }\n');
    await expect(applyExtractionPlan(plan, io)).rejects.toThrow('b.ts changed since the extraction was planned');
    expect(io.store.get('a.ts')).toBe('function f() { return 1; }\n');
  });

  it('cannot apply a refused plan', async () => {
    await expect(applyExtractionPlan({ status: 'refused', familyId: 'x', reason: 'nope' }, fsOf({}))).rejects.toThrow('nope');
  });
});
