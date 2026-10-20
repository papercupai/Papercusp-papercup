import { describe, expect, it } from 'vitest';
import { supersessionWinner } from './supersession-winner';

describe('supersessionWinner (EI-26515229747561182)', () => {
  it('returns the winner a superseded row names', () => {
    expect(
      supersessionWinner({ metadata: { validity: { status: 'superseded', superseded_by: 'new-id' } } }),
    ).toBe('new-id');
  });

  it('a soft-forgotten row (closed, superseded_by null) has NO winner, despite status superseded', () => {
    expect(
      supersessionWinner({ metadata: { validity: { status: 'superseded', superseded_by: null } } }),
    ).toBeNull();
  });

  it('an open row, a row without validity, and a missing row have no winner', () => {
    expect(supersessionWinner({ metadata: { validity: { status: 'current', superseded_by: null } } })).toBeNull();
    expect(supersessionWinner({ metadata: {} })).toBeNull();
    expect(supersessionWinner({})).toBeNull();
    expect(supersessionWinner(null)).toBeNull();
    expect(supersessionWinner(undefined)).toBeNull();
  });

  it('a non-string or empty superseded_by is not a winner', () => {
    expect(supersessionWinner({ metadata: { validity: { superseded_by: '' } } })).toBeNull();
    expect(supersessionWinner({ metadata: { validity: { superseded_by: 42 } } })).toBeNull();
  });
});
