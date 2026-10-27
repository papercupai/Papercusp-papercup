import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CODE_HEALTH_VERSION, compareCodeHealth, measureCodeHealth } from './code-health';
import { firstPartyCallers } from './first-party-callers';

const snapshot = (text: string, path = 'fixture.ts') => measureCodeHealth(ts,
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true), path);

describe('compiler/complexity-v1 definitions', () => {
  it.each([
    'if (x) {}', 'for (;;) {}', 'for (const a in x) {}', 'for (const a of x) {}',
    'while (x) {}', 'do {} while (x);', 'try {} catch (e) {}',
    'switch (x) { case 1: break; default: break; }', 'return x ? 1 : 2;',
    'return x && 1;', 'return x || 1;', 'return x ?? 1;',
  ])('counts exactly one branch for %s', body => {
    const row = snapshot(`function subject(x: any) { ${body} }`).functions[0]!;
    expect(row).toMatchObject({ cyclomatic: 2, cognitive: 1, length: 1, nesting: 2 });
  });

  it('pins compiler and metric versions; comments/strings/default/else are not branches', () => {
    const measured = snapshot('function f(x: any) { /* if (x) {} */ const s = "x && y"; switch(x) { default: break; } }');
    expect(measured).toMatchObject({ status: 'measured', metricVersion: CODE_HEALTH_VERSION, compilerVersion: ts.version });
    expect(measured.functions[0]).toMatchObject({ cyclomatic: 1, cognitive: 0, nesting: 1 });
  });

  it('sums branch ancestor depth and physical body length', () => {
    const measured = snapshot('function f(x: any) {\n if(x) {\n  while(x) {\n   if(x) break;\n  }\n }\n}');
    expect(measured.functions[0]).toMatchObject({ cyclomatic: 4, cognitive: 6, nesting: 4, length: 7 });
    expect(measured.functions[0]!.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('measures nested functions independently, including arrows and methods', () => {
    const measured = snapshot('function outer() {\n const inner = () => {\n  if (true) { while (true) break; }\n };\n return inner;\n}\nclass A { m() { return true ? 1 : 0; } }');
    expect(measured.functions.map(f => [f.name, f.cyclomatic, f.cognitive, f.nesting, f.length]))
      .toEqual([['outer', 1, 0, 1, 5], ['outer.inner', 3, 3, 3, 3], ['A.m', 2, 1, 2, 1]]);
  });

  it('excludes overloads and rejects malformed source as unknown', () => {
    expect(snapshot('function f(x: number): number; function f(x: number) { return x; }').functions).toHaveLength(1);
    expect(snapshot('function f( {')).toMatchObject({ status: 'unknown', functions: [] });
  });
});

describe('advisory complexity added per change', () => {
  it('does not report unchanged complexity or line movement as new', () => {
    const before = snapshot('function f(x: boolean) { if(x) return 1; }');
    const result = compareCodeHealth(before, snapshot('\n\nfunction f(x: boolean) { if(x) return 1; }'));
    expect(result.deltas[0]).toMatchObject({ status: 'measured', baseline: { cyclomatic: 2, cognitive: 1 }, added: { cyclomatic: 0, cognitive: 0 }, warning: false });
    expect(result.warnings).toEqual([]);
  });

  it('warns on a positive delta and never raises the retained baseline', () => {
    const before = snapshot('function f(x: boolean) { return x; }');
    const after = snapshot('function f(x: boolean) { if(x) { if(x) return 1; } }');
    const result = compareCodeHealth(before, after);
    expect(result).toMatchObject({ mode: 'warn-only', status: 'measured' });
    expect(result.deltas[0]).toMatchObject({ baseline: { cyclomatic: 1, cognitive: 0 }, added: { cyclomatic: 2, cognitive: 3 }, warning: true });
    expect(result.nextWatermarks[after.functions[0]!.id]).toEqual({ cyclomatic: 1, cognitive: 0 });
    expect(compareCodeHealth(after, after, [], result.nextWatermarks).warnings).toHaveLength(1);
    const reduced = compareCodeHealth(after, before);
    expect(reduced.warnings).toEqual([]);
    expect(reduced.nextWatermarks[before.functions[0]!.id]).toEqual({ cyclomatic: 1, cognitive: 0 });
  });

  it('carries recorded rename history and labels an unrecorded rename unknown', () => {
    const before = snapshot('export function old(x: boolean) { if(x) return 1; }');
    const after = snapshot('export function renamed(x: boolean) { if(x) return 1; }', 'moved.ts');
    expect(compareCodeHealth(before, after).deltas[0]).toMatchObject({ status: 'unknown', baseline: null, added: null });
    expect(compareCodeHealth(before, after).nextWatermarks[before.functions[0]!.id]).toEqual({ cyclomatic: 2, cognitive: 1 });
    const old = before.functions[0]!;
    const result = compareCodeHealth(before, after, [{ currentId: after.functions[0]!.id,
      predecessors: [{ id: old.id, start: old.start, end: old.end }] }]);
    expect(result.deltas[0]).toMatchObject({ status: 'measured', added: { cyclomatic: 0, cognitive: 0 }, warning: false });
  });

  it('partitions split predecessor points once, and rejects overlapping claims', () => {
    const before = snapshot('function f(x: any) { if(x) return 1; while(x) break; }');
    const after = snapshot('function left(x: any) { if(x) return 1; } function right(x: any) { while(x) break; }');
    const old = before.functions[0]!, boundary = old.branches[1]!.start;
    const lineage = after.functions.map((fn, i) => ({ currentId: fn.id,
      predecessors: [{ id: old.id, start: i === 0 ? old.start : boundary, end: i === 0 ? boundary : old.end }] }));
    const result = compareCodeHealth(before, after, lineage);
    expect(result.deltas.map(d => d.baseline)).toEqual([{ cyclomatic: 2, cognitive: 1 }, { cyclomatic: 1, cognitive: 1 }]);
    expect(result.deltas.reduce((n, d) => n + d.baseline!.cyclomatic, 0)).toBe(old.cyclomatic);
    expect(result.removed).toEqual([]);
    lineage[1]!.predecessors[0]!.start = old.start;
    expect(compareCodeHealth(before, after, lineage).deltas.every(d => d.status === 'unknown')).toBe(true);
  });

  it('gives confirmed new functions baseline zero; removals shrink retained state', () => {
    const empty = snapshot('');
    const added = snapshot('function added() { return 1; }');
    expect(compareCodeHealth(empty, added).deltas[0]).toMatchObject({ baseline: { cyclomatic: 0, cognitive: 0 }, warning: true });
    expect(compareCodeHealth(added, empty)).toMatchObject({ removed: [added.functions[0]!.id], nextWatermarks: {} });
    const replaced = snapshot('function replacement() { return 1; }');
    expect(compareCodeHealth(added, replaced, [{ currentId: replaced.functions[0]!.id, predecessors: [] }]).deltas[0])
      .toMatchObject({ status: 'measured', baseline: { cyclomatic: 0, cognitive: 0 } });
  });

  it('never silently compares incompatible versions or unmeasured source', () => {
    const before = snapshot('function f() {}');
    for (const after of [{ ...before, metricVersion: 'v2' }, { ...before, compilerVersion: 'other' }, snapshot('function f( {')]) {
      const result = compareCodeHealth(before, after);
      expect(result.status).toBe('unknown');
      expect(result.warnings).toEqual([]);
      expect(result.deltas.every(d => d.baseline === null)).toBe(true);
    }
  });
});

describe('existing graph and advisory command consumers', () => {
  it('returns metrics through the scoped compiler symbol graph', () => {
    const root = mkdtempSync(join(tmpdir(), 'code-health-'));
    try {
      writeFileSync(join(root, 'subject.ts'), 'export function subject(x: boolean) { if(x) return 1; return 0; }');
      const result = firstPartyCallers({ ts, root, name: 'subject', op: 'symbol', paths: ['subject.ts'] });
      expect(result.error).toBeNull();
      expect(result.codeHealth).toMatchObject({ status: 'measured', metricVersion: CODE_HEALTH_VERSION });
      expect(result.codeHealth!.functions[0]).toMatchObject({ name: 'subject', path: 'subject.ts', cyclomatic: 2, cognitive: 1 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it('runs the real advisory command and preserves warn-only process success', () => {
    // Native Node TypeScript keeps the committed-source guard's byte comparison intact.
    const output = execFileSync(process.execPath, ['scripts/check-code-health.ts',
      '--base=HEAD', '--paths=packages/operator-core/lib/code-intelligence/code-health.ts', '--json'],
    { cwd: fileURLToPath(new URL('../../../../', import.meta.url)), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    expect(JSON.parse(output)).toMatchObject({ mode: 'warn-only', compilerVersion: ts.version });
  }, 30_000);
});
