import { describe, expect, it } from 'vitest';
import { changedFrozenTests } from './frozen-tests-hash';

describe('frozen test hash comparison', () => {
  const frozen = [{ path:'acceptance.test.ts',sha256:'original' }, { path:'journey.test.ts',sha256:'journey' }];
  it('accepts identical bytes regardless of enumeration order', () => {
    expect(changedFrozenTests(frozen, [...frozen].reverse())).toEqual([]);
  });
  it('names an edited test', () => {
    expect(changedFrozenTests(frozen, [{ ...frozen[0]!,sha256:'weakened' },frozen[1]!])).toEqual(['acceptance.test.ts']);
  });
  it('names a deleted test even when an unrelated file was added', () => {
    expect(changedFrozenTests(frozen, [frozen[1]!,{ path:'replacement.test.ts',sha256:'original' }])).toEqual(['acceptance.test.ts']);
  });
});
