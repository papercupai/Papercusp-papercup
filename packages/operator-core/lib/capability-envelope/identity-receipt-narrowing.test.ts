/**
 * WI-10004801 (#1155): narrowing a launch record's identityHistory to the
 * requested receipts must never change which receipt the identity gate selects.
 * The SQL that performs the narrowing is held to `narrowIdentityHistory` by
 * identity-receipt-narrowing.integration.test.ts (real PostgreSQL).
 */
import { describe, expect, it } from 'vitest';
import { narrowIdentityHistory, revisionsParam } from './identity-receipt-narrowing';
import { selectAppliedReceipt } from './identity-grants-port';

const A = { specificationRevision: 'a'.repeat(64), stateRevision: 'state-a' };
const B = { specificationRevision: 'b'.repeat(64), stateRevision: 'state-b' };
const C = { specificationRevision: 'c'.repeat(64), stateRevision: 'state-c' };
const receipt = (pair: typeof A, tag: string) => ({ ...pair, specificationArtifact: { tag } });

describe('revisionsParam', () => {
  it('serialises well-formed pairs and drops extra keys', () => {
    expect(revisionsParam([{ ...A, applied: true }])).toBe(JSON.stringify([A]));
    expect(revisionsParam([])).toBe('[]');
  });

  it('refuses to narrow when any pair is not a pair of strings', () => {
    expect(revisionsParam([A, null])).toBeNull();
    expect(revisionsParam([{ specificationRevision: A.specificationRevision }])).toBeNull();
    expect(revisionsParam([{ specificationRevision: 7, stateRevision: 'x' }])).toBeNull();
  });
});

describe('narrowIdentityHistory', () => {
  it('keeps only matching history entries, in stored order, and leaves top-level fields untouched', () => {
    const record = {
      ...C, workspaceId: 'ws', harnessSlug: 'h', specificationArtifact: { tag: 'top' },
      identityHistory: [receipt(A, 'a1'), receipt(B, 'b1'), 'not-an-object', receipt(A, 'a2'), null],
    };
    expect(narrowIdentityHistory(record, [A])).toEqual({
      ...C, workspaceId: 'ws', harnessSlug: 'h', specificationArtifact: { tag: 'top' },
      identityHistory: [receipt(A, 'a1'), receipt(A, 'a2')],
    });
    expect((narrowIdentityHistory(record, []) as { identityHistory: unknown[] }).identityHistory).toEqual([]);
  });

  it('matches by exact JSON type, as JS === on the parsed record does', () => {
    const numeric = { specificationRevision: 1, stateRevision: 'state-a', specificationArtifact: {} };
    const record = { identityHistory: [numeric] };
    expect(narrowIdentityHistory(record, [{ specificationRevision: '1', stateRevision: 'state-a' }]))
      .toEqual({ identityHistory: [] });
  });

  it('returns records it cannot narrow exactly as stored', () => {
    const notArray = { ...A, identityHistory: { 0: receipt(A, 'x') } };
    expect(narrowIdentityHistory(notArray, [A])).toBe(notArray);
    const noHistory = { ...A };
    expect(narrowIdentityHistory(noHistory, [A])).toBe(noHistory);
    expect(narrowIdentityHistory(['array'], [A])).toEqual(['array']);
    expect(narrowIdentityHistory(null, [A])).toBeNull();
    const malformedRequest = { identityHistory: [receipt(B, 'b')] };
    expect(narrowIdentityHistory(malformedRequest, [{ specificationRevision: 'x' }])).toBe(malformedRequest);
  });
});

// What `appliedIdentityArtifact` consumes from a selected receipt. When the
// top-level record IS the receipt, the selected object carries identityHistory
// too, which narrowing changes by design; the gate never reads it from there.
const consumed = (selected: Record<string, unknown> | null) => selected && {
  specificationRevision: selected.specificationRevision,
  stateRevision: selected.stateRevision,
  specificationArtifact: selected.specificationArtifact,
};

describe('the gate selects the same receipt from a narrowed record (WI-10004801)', () => {
  const records: Array<[string, unknown]> = [
    ['top level matches', { ...receipt(A, 'top'), identityHistory: [receipt(A, 'older'), receipt(B, 'b')] }],
    ['history matches once', { ...receipt(C, 'top'), identityHistory: [receipt(B, 'b'), receipt(A, 'a')] }],
    ['history matches twice', { ...receipt(C, 'top'), identityHistory: [receipt(A, 'first'), receipt(A, 'second')] }],
    ['no match anywhere', { ...receipt(C, 'top'), identityHistory: [receipt(B, 'b')] }],
    ['state revision differs', { ...receipt(C, 'top'), identityHistory: [{ ...receipt(A, 'a'), stateRevision: 'other' }] }],
    ['history holds junk', { ...receipt(C, 'top'), identityHistory: [7, 'x', null, [receipt(A, 'nested')], receipt(A, 'a')] }],
    ['history not an array', { ...receipt(C, 'top'), identityHistory: receipt(A, 'a') }],
  ];

  for (const [name, record] of records) {
    for (const revision of [A, B, C]) {
      it(`${name} — ${revision.stateRevision}`, () => {
        const narrowed = narrowIdentityHistory(record, [revision]);
        expect(consumed(selectAppliedReceipt(narrowed, revision)))
          .toEqual(consumed(selectAppliedReceipt(record, revision)));
      });
    }
  }

  it('an empty request removes every history entry without changing an absent-revision selection', () => {
    const record = { ...receipt(C, 'top'), identityHistory: [receipt(A, 'a')] };
    expect(selectAppliedReceipt(narrowIdentityHistory(record, []), null)).toBeNull();
    expect(selectAppliedReceipt(record, null)).toBeNull();
  });
});
