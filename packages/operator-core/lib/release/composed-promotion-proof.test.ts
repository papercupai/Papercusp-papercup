/**
 * P-018 (green-main-ratchet-convergence-2026-10-17): the composed promotion proof.
 *   R-15 falsifiers: (1) a green selective step triggers a full gate re-run while every radius
 *   is computable; (2) a result outside every radius is re-run instead of carried; (3) a lint
 *   leg re-runs though it passed and its inputs did not change; (4) an uncomputable radius
 *   does not fall back to the full gate.
 *   R-16 falsifiers: (1) a type-annotation-only lint fix selects a runtime test; (2) a
 *   runtime-changing lint fix does not re-run its dependents; (3) a file whose emit cannot be
 *   computed is treated as type-only.
 * R-16 cases run the real TypeScript compiler (`emitIdentity`), not a stub.
 */
import { describe, it, expect } from 'vitest';
import {
  composeVerdict,
  emitIdentity,
  planComposedProof,
  type ChangedFile,
  type ComposedProofInput,
  type ComposedProofPlan,
} from './composed-promotion-proof';

const SRC = 'packages/ui/src/sum.ts';
const SRC_TEST = 'packages/ui/src/sum.test.ts';
const OTHER_TEST = 'packages/ui/src/menu.test.ts';
const FAR_TEST = 'packages/db/src/far.test.ts';

const BEFORE = 'export function sum(a, b) {\n  return a + b;\n}\n';
const TYPE_ONLY_AFTER =
  "import type { Num } from './num';\nexport function sum(a: Num, b: number): number {\n  return a + b;\n}\n";
const RUNTIME_AFTER = 'export function sum(a: number, b: number): number {\n  return a + b + 0.0001;\n}\n';

const tsLeg = { id: 'lint:tsc', passed: false, covers: (p: string) => p.endsWith('.ts') };
const eslintLeg = { id: 'lint:eslint', passed: true, covers: (p: string) => p.startsWith('packages/ui/') };
const mdLeg = { id: 'lint:docs', passed: true, covers: (p: string) => p.endsWith('.md') };

const base = (changedFiles: ChangedFile[], over: Partial<ComposedProofInput> = {}): ComposedProofInput => ({
  round1Tests: { [SRC_TEST]: 'pass', [OTHER_TEST]: 'pass', [FAR_TEST]: 'fail' },
  lintLegs: [tsLeg, eslintLeg, mdLeg],
  admissions: [{ id: 'adm-1', changedFiles }],
  dependentTestsOf: (p) => (p === SRC ? [SRC_TEST, OTHER_TEST] : []),
  ...over,
});
const composed = (p: ComposedProofPlan) => {
  if (p.mode !== 'composed') throw new Error(`expected a composed plan, got ${p.mode}: ${p.reason}`);
  return p;
};

describe('emitIdentity (real TypeScript transpile)', () => {
  it('reports a type-annotation and import-type change as identical emit', () => {
    expect(emitIdentity(SRC, BEFORE, TYPE_ONLY_AFTER)).toBe('identical');
  });
  it('reports a runtime change as changed', () => {
    expect(emitIdentity(SRC, BEFORE, RUNTIME_AFTER)).toBe('changed');
  });
  it('reports an unparseable file as uncomputable, never identical (R-16 f3)', () => {
    expect(emitIdentity(SRC, BEFORE, 'export function sum(a, b) { return a + ; }')).toBe('uncomputable');
  });
  it('reports a non-script file as uncomputable', () => {
    expect(emitIdentity('packages/ui/package.json', '{"a":1}', '{"a":2}')).toBe('uncomputable');
  });
  it('reports an added or deleted file as changed', () => {
    expect(emitIdentity(SRC, null, BEFORE)).toBe('changed');
    expect(emitIdentity(SRC, BEFORE, null)).toBe('changed');
  });
});

describe('planComposedProof', () => {
  it('R-16 f1: a type-only lint fix selects zero runtime tests', () => {
    const plan = composed(planComposedProof(base([{ path: SRC, before: BEFORE, after: TYPE_ONLY_AFTER }])));
    expect(plan.rerunTests).toEqual([]);
    expect(plan.typeOnlyFiles).toEqual([SRC]);
    expect(plan.carriedTests).toEqual([FAR_TEST, OTHER_TEST, SRC_TEST]);
  });

  it('R-16 f2: a runtime-changing lint fix re-runs its dependent tests', () => {
    const plan = composed(planComposedProof(base([{ path: SRC, before: BEFORE, after: RUNTIME_AFTER }])));
    expect(plan.rerunTests).toEqual([OTHER_TEST, SRC_TEST]);
    expect(plan.runtimeFiles).toEqual([SRC]);
  });

  it('R-16 f3: an uncomputable emit is treated as a runtime change, not type-only', () => {
    const plan = composed(
      planComposedProof(base([{ path: SRC, before: BEFORE, after: 'export function sum(a, b) { return a + ; }' }])),
    );
    expect(plan.typeOnlyFiles).toEqual([]);
    expect(plan.rerunTests).toEqual([OTHER_TEST, SRC_TEST]);
  });

  it('R-15 f1: a green selective step with computable radii composes instead of a full re-run', () => {
    expect(planComposedProof(base([{ path: SRC, before: BEFORE, after: RUNTIME_AFTER }])).mode).toBe('composed');
  });

  it('R-15 f2: a result outside every admission radius is carried, not re-run', () => {
    const plan = composed(planComposedProof(base([{ path: SRC, before: BEFORE, after: RUNTIME_AFTER }])));
    expect(plan.carriedTests).toEqual([FAR_TEST]);
    expect(plan.rerunTests).not.toContain(FAR_TEST);
  });

  it('R-15 f3: a lint leg re-runs only if it failed or its inputs changed', () => {
    const plan = composed(planComposedProof(base([{ path: SRC, before: BEFORE, after: TYPE_ONLY_AFTER }])));
    // lint:tsc failed in round 1 → re-run; lint:eslint covers the changed file → re-run;
    // lint:docs passed and covers nothing that changed → carried.
    expect(plan.rerunLegs).toEqual(['lint:eslint', 'lint:tsc']);
    expect(plan.carriedLegs).toEqual(['lint:docs']);
  });

  it('R-15 f4: an uncomputable radius for a runtime change falls back to the full gate', () => {
    const plan = planComposedProof(
      base([{ path: SRC, before: BEFORE, after: RUNTIME_AFTER }], { dependentTestsOf: () => null }),
    );
    expect(plan.mode).toBe('full-gate');
    if (plan.mode === 'full-gate') expect(plan.uncomputableRadius).toEqual([SRC]);
  });

  it('a type-only file needs no radius, so an uncomputable radius there does not force the full gate', () => {
    const plan = planComposedProof(
      base([{ path: SRC, before: BEFORE, after: TYPE_ONLY_AFTER }], { dependentTestsOf: () => null }),
    );
    expect(plan.mode).toBe('composed');
  });

  it('unions radii across several admissions', () => {
    const plan = composed(
      planComposedProof(
        base([], {
          admissions: [
            { id: 'a', changedFiles: [{ path: SRC, before: BEFORE, after: RUNTIME_AFTER }] },
            { id: 'b', changedFiles: [{ path: 'packages/db/src/far.ts', before: 'export const x = 1;', after: 'export const x = 2;' }] },
          ],
          dependentTestsOf: (p) => (p === SRC ? [SRC_TEST] : [FAR_TEST]),
        }),
      ),
    );
    expect(plan.rerunTests).toEqual([FAR_TEST, SRC_TEST]);
    expect(plan.carriedTests).toEqual([OTHER_TEST]);
  });
});

describe('composeVerdict', () => {
  const plan = composed(planComposedProof(base([{ path: SRC, before: BEFORE, after: RUNTIME_AFTER }])));
  const round1 = { [SRC_TEST]: 'pass', [OTHER_TEST]: 'pass', [FAR_TEST]: 'fail' } as const;

  it('carries round-1 failures outside the radius and adds re-run failures', () => {
    const v = composeVerdict(plan, round1, {
      [SRC_TEST]: 'fail', [OTHER_TEST]: 'pass', 'lint:tsc': 'pass', 'lint:eslint': 'pass',
    });
    expect(v.failing).toEqual([FAR_TEST, SRC_TEST]);
    expect(v.unmeasured).toEqual([]);
  });

  it('counts a re-run with no result as failing (fail closed)', () => {
    const v = composeVerdict(plan, round1, { [SRC_TEST]: 'pass', 'lint:tsc': 'pass', 'lint:eslint': 'pass' });
    expect(v.unmeasured).toEqual([OTHER_TEST]);
    expect(v.failing).toContain(OTHER_TEST);
  });
});
