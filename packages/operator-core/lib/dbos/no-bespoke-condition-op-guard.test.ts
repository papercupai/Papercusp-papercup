import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-ignore — maintained bare-node source guard.
import { findDispatches, inspectMigratedCaller, SEED_HASH } from '../../../../scripts/check-no-bespoke-condition-op.mjs';
// @ts-ignore — shared bare-node policy validator.
import { judgeSites, validatePolicy } from '../../../../scripts/lib/shrink-only-guard.mjs';

const policy = () => JSON.parse(readFileSync(new URL('../../../../scripts/no-bespoke-condition-op-baseline.json', import.meta.url), 'utf8'));
const path = 'packages/operator-core/lib/new-matcher.ts';

it('rules events reuse R-69 rejects switch and if-chain shapes with three or more operator literals', () => {
  for (const source of [
    "switch (op) { case 'eq': return a === b; case 'gt': return a > b; case 'lt': return a < b; }",
    "if (op === 'eq') return a === b; else if (op === 'gt') return a > b; else if (op === 'lt') return a < b;",
    "if (op === 'eq') return a === b; if (op === 'gt') return a > b; if (op === 'lt') return a < b;",
    "if ('eq' === leaf.op || 'gt' === leaf.op || 'lt' === leaf.op) return compare();",
  ]) {
    const sites = findDispatches(source, path);
    expect(sites).toHaveLength(1);
    expect(judgeSites(sites, policy(), SEED_HASH).offenders).toHaveLength(1);
    expect(findDispatches(source, 'libs/generic/rules/src/compile.ts')).toEqual([]);
  }
  for (const belowThreshold of [
    "switch (op) { case 'eq': return a === b; case 'gt': return a > b; }",
    "if (op === 'eq') return a === b; else if (op === 'gt') return a > b;",
    "if (op === 'eq') return a === b; if (op === 'gt') return a > b;",
    "if (a === 'eq') return true; if (b === 'gt') return true; if (c === 'lt') return true;",
    "// switch (op) { case 'eq': case 'gt': case 'lt': }\nconst prose = `if (op === 'eq') ...`;",
  ]) expect(findDispatches(belowThreshold, path)).toEqual([]);
});

it('rules events reuse R-70 allows only the shrinking condition baseline and reasoned exceptions', () => {
  const current = policy();
  expect(SEED_HASH).toBe('3049a568af43f41a528230c6b53622c2eed54bbdb2fbefc5aeb234f102151091');
  expect(current.initial).toHaveLength(5);
  expect(validatePolicy(current, SEED_HASH)).toEqual([]);
  expect(validatePolicy({ ...current, baseline: current.baseline.slice(1) }, SEED_HASH)).toEqual([]);
  expect(validatePolicy({ ...current, baseline: [...current.baseline, path] }, SEED_HASH)).toContain(`baseline growth: ${path}`);
  expect(validatePolicy({ ...current, initial: [...current.initial, path] }, SEED_HASH)).toContain('measured initial list changed');
  const sites = findDispatches("switch(op) { case 'eq': case 'ne': case 'lt': return false; }", path);
  const allowed = { ...current, allowlist: { [path]: 'SQL query construction maps operators to SQL expressions, not in-memory condition truth.' } };
  expect(judgeSites(sites, allowed, SEED_HASH).offenders).toEqual([]);
  expect(validatePolicy({ ...allowed, allowlist: { [path]: '' } }, SEED_HASH)).toContain(`exception requires a reason: ${path}`);
});

describe('post-migration zero-dispatch guard', () => {
  it('does not inherit the broad three-literal threshold or baseline exemption', () => {
    const caller = 'export function evaluate(x) { return sharedMatch(x); }';
    expect(inspectMigratedCaller(caller, path, 'evaluate', 'sharedMatch')).toEqual([]);
    for (const dispatch of ["switch (op) { case 'eq': return false; }", "if (op === 'lt') return false;"]) {
      expect(inspectMigratedCaller(caller + dispatch, path, 'evaluate', 'sharedMatch')).toContain('local condition dispatch remains');
    }
    expect(inspectMigratedCaller('', path, 'evaluate', 'sharedMatch')).toEqual(['missing exported caller evaluate', 'missing shared call sharedMatch']);
    expect(inspectMigratedCaller('export function evaluate(x) { return false; }', path, 'evaluate', 'sharedMatch')).toContain('missing shared call sharedMatch');
    expect(inspectMigratedCaller('// export function evaluate(x) { return sharedMatch(x); }', path, 'evaluate', 'sharedMatch')).toHaveLength(2);
  });
});
