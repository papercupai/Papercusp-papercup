/**
 * acceptance-bar-lifecycle-evaluator statically imports acceptance-bar-contract-snapshot.
 * The snapshot module must therefore never reach the evaluator through its own
 * STATIC value imports (WI-6554700010030904).
 *
 * When it did (snapshot -> scorecards -> rubric-instrument-registry ->
 * fleet/capacity-recovery-evidence -> llm-testing/scenarios/su/S42 ->
 * agent-tools/events/watch -> events/await -> inference-gateway -> blueprint ->
 * harness/routines/plan-run-action -> evaluator), a test that mocks the snapshot
 * with `importOriginal` evaluated the evaluator while that mock was still being
 * built. The evaluator then bound the REAL snapshot module, so the mocked snapshot
 * was silently ignored. plans/__tests__/start-guard.test.ts went red at tip with
 * bar_snapshot_plan_missing even though its mock returned a valid plan.
 *
 * The walk below follows only value imports. `import type`, all-type named
 * imports and dynamic `await import()` are skipped because none of them
 * evaluates a module at load time.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const LIB = __dirname;
const PKG_ROOT = path.resolve(LIB, '..');

function resolveSpecifier(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else if (spec.startsWith('@/')) base = path.resolve(LIB, spec.slice(2));
  else if (spec.startsWith('@papercusp/operator-core/')) base = path.resolve(PKG_ROOT, spec.slice('@papercusp/operator-core/'.length));
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, base.replace(/\.js$/, '.ts'), path.join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function staticValueImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
  const specs: string[] = [];
  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const clause = stmt.importClause;
      if (clause?.isTypeOnly) continue;
      const named = clause?.namedBindings;
      const allNamedAreTypes = !clause?.name && named && ts.isNamedImports(named)
        && named.elements.length > 0 && named.elements.every(el => el.isTypeOnly);
      if (allNamedAreTypes) continue;
      specs.push(stmt.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      if (stmt.isTypeOnly) continue;
      specs.push(stmt.moduleSpecifier.text);
    }
  }
  return specs.map(spec => resolveSpecifier(file, spec)).filter((f): f is string => f !== null);
}

/** Shortest static value-import chain from `start` to `target`, or null when none exists. */
function staticImportChain(start: string, target: string): string[] | null {
  const parent = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const file = queue.shift()!;
    if (file === target) {
      const chain: string[] = [];
      for (let at: string | null = file; at; at = parent.get(at) ?? null) chain.unshift(path.relative(LIB, at));
      return chain;
    }
    for (const dep of staticValueImports(file)) {
      if (!parent.has(dep)) { parent.set(dep, file); queue.push(dep); }
    }
  }
  return null;
}

describe('acceptance-bar-contract-snapshot import graph', () => {
  const snapshot = path.join(LIB, 'acceptance-bar-contract-snapshot.ts');
  const evaluator = path.join(LIB, 'acceptance-bar-lifecycle-evaluator.ts');

  it('positive control: the evaluator statically imports the snapshot (so a reverse path would be a cycle)', () => {
    expect(staticImportChain(evaluator, snapshot)).toEqual([
      'acceptance-bar-lifecycle-evaluator.ts',
      'acceptance-bar-contract-snapshot.ts',
    ]);
  });

  it('the snapshot never reaches the lifecycle evaluator through static value imports', () => {
    expect(staticImportChain(snapshot, evaluator)).toBeNull();
  });
});

describe('spec evidence schema initialization (EI-27689464176702417)', () => {
  const store = path.join(LIB, 'agent-tools/plans/spec-evidence-store.ts');
  const consumer = path.join(LIB, 'agent-tools/testing/evidence.ts');

  it('positive control: testing evidence reads the store schemas at module initialization', () => {
    expect(staticImportChain(consumer, store)).toEqual([
      'agent-tools/testing/evidence.ts',
      'agent-tools/plans/spec-evidence-store.ts',
    ]);
  });

  it('the store cannot initialize its testing consumer before its schemas are defined', () => {
    expect(staticImportChain(store, consumer)).toBeNull();
  });
});

describe('blueprint operation admission initialization (EI-27690628316181198)', () => {
  const admission = path.join(LIB, 'blueprint/operation-admission.ts');
  const runner = path.join(LIB, 'harness/routines/plan-run-action.ts');
  const evaluator = path.join(LIB, 'acceptance-bar-lifecycle-evaluator.ts');

  it('positive control: the scheduled runner imports the acceptance evaluator', () => {
    expect(staticImportChain(runner, evaluator)).toEqual([
      'harness/routines/plan-run-action.ts',
      'acceptance-bar-lifecycle-evaluator.ts',
    ]);
  });

  it('admission loads the scheduled runtime only when executing a plan operation', () => {
    expect(staticImportChain(admission, runner)).toBeNull();
    expect(staticImportChain(admission, evaluator)).toBeNull();
  });
});
