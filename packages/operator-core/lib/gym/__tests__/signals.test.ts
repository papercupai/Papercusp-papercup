import { describe, it, expect } from 'vitest';
import { regressionsFromTests, plantedBugCaught, type TestResult } from '../signals';

/**
 * Deterministic signal cores (P-003). These are the un-gameable guardrails — the
 * optimizer can't touch the repo's own tests or the planted defect (D-011). Pure
 * cores here; running the repo's tests + reading the harness's issues is the
 * integration layer (P-002 collector + the fake-agent smoke / P-014 real run).
 */
describe('regressionsFromTests', () => {
  it('flags a pre-existing test that flipped pass→fail', () => {
    const pre: TestResult[] = [{ name: 't1', passed: true }, { name: 't2', passed: true }];
    const post: TestResult[] = [{ name: 't1', passed: true }, { name: 't2', passed: false }];
    expect(regressionsFromTests(pre, post)).toBe(true);
  });

  it('does not flag a test that was already failing before the change', () => {
    const pre: TestResult[] = [{ name: 't1', passed: false }];
    const post: TestResult[] = [{ name: 't1', passed: false }];
    expect(regressionsFromTests(pre, post)).toBe(false);
  });

  it('does not flag a brand-new failing test (not a pre-existing test)', () => {
    const pre: TestResult[] = [{ name: 't1', passed: true }];
    const post: TestResult[] = [{ name: 't1', passed: true }, { name: 'tNew', passed: false }];
    expect(regressionsFromTests(pre, post)).toBe(false);
  });

  it('is false when nothing regressed', () => {
    const pre: TestResult[] = [{ name: 't1', passed: true }];
    expect(regressionsFromTests(pre, pre)).toBe(false);
  });

  it('withholds a no-regression claim when a prior test disappeared', () => {
    expect(regressionsFromTests(
      [{ name: 'kept', passed: true }, { name: 'missing', passed: true }],
      [{ name: 'kept', passed: true }],
    )).toBeUndefined();
  });

  it('distinguishes an unexecuted assertion from an observed failure', () => {
    expect(regressionsFromTests(
      [{ name: 't', passed: true }],
      [{ name: 't', passed: false, executed: false }],
    )).toBeUndefined();
  });

  it('withholds empty and ambiguous evidence, but preserves an observed regression alongside a gap', () => {
    expect(regressionsFromTests([], [])).toBeUndefined();
    expect(regressionsFromTests([{ name: 't', passed: true }],
      [{ name: 't', passed: false }, { name: 't', passed: true }])).toBeUndefined();
    expect(regressionsFromTests([{ name: 't', passed: true }, { name: 'missing', passed: true }],
      [{ name: 't', passed: false }])).toBe(true);
  });

  it('keeps same-named assertions in different files separate', () => {
    expect(regressionsFromTests(
      [{ name: 't', file: 'a.test.ts', passed: true }, { name: 't', file: 'b.test.ts', passed: true }],
      [{ name: 't', file: 'a.test.ts', passed: false }, { name: 't', file: 'b.test.ts', passed: true }],
    )).toBe(true);
  });
});

describe('plantedBugCaught', () => {
  const bug = {
    location: 'src/orders/total.ts computeTotal()',
    defect: 'off-by-one drops the last line item',
    detectionSignature: 'a 3-item order returns the 2-item total',
  };

  it('is caught when the harness output references the defect location symbol', () => {
    expect(plantedBugCaught(bug, 'FAIL: computeTotal mishandles the last item; off-by-one.')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(plantedBugCaught(bug, 'noticed COMPUTETOTAL looks wrong')).toBe(true);
  });

  it('is not caught when the harness output never references the defect', () => {
    expect(plantedBugCaught(bug, 'PASS — endpoint returns 200, looks good, shipping.')).toBe(false);
  });
});
