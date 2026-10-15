import { describe, expect, it } from 'vitest';
import { reduceGovernanceVotes } from './governance-voting';

describe('governance voting reducer', () => {
  it('counts weighted votes and explicit delegation deterministically', () => {
    const result = reduceGovernanceVotes({ members: [{ memberId: 'a' }, { memberId: 'b' }, { memberId: 'c', weight: 2 }], events: [{ memberId: 'a', choice: 'approve', sequence: 1, keyEpoch: 1 }, { memberId: 'b', choice: 'approve', sequence: 1, keyEpoch: 1 }, { memberId: 'c', choice: 'abstain', sequence: 1, keyEpoch: 1 }], delegations: [{ from: 'c', to: 'a', epoch: 1 }], nowMs: 1_000 });
    expect(result).toMatchObject({ ok: true, value: { approveWeight: 4, abstainWeight: 0, totalEligibleWeight: 4 } });
  });

  it('supports replacement and fails closed for cycles, revocation, and stale keys', () => {
    const replaced = reduceGovernanceVotes({ members: [{ memberId: 'a' }], events: [{ memberId: 'a', choice: 'reject', sequence: 1, keyEpoch: 1 }, { memberId: 'a', choice: 'approve', sequence: 2, keyEpoch: 1 }], nowMs: 0 });
    expect(replaced).toMatchObject({ ok: true, value: { approveWeight: 1, replacements: 1 } });
    expect(reduceGovernanceVotes({ members: [{ memberId: 'a' }, { memberId: 'b' }], events: [], delegations: [{ from: 'a', to: 'b', epoch: 1 }, { from: 'b', to: 'a', epoch: 1 }], nowMs: 0 })).toMatchObject({ ok: false, code: 'delegation-cycle' });
    expect(reduceGovernanceVotes({ members: [{ memberId: 'a', revoked: true }], events: [{ memberId: 'a', choice: 'approve', sequence: 1, keyEpoch: 1 }], nowMs: 0 })).toMatchObject({ ok: false, code: 'revoked-member' });
    expect(reduceGovernanceVotes({ members: [{ memberId: 'a', keyEpoch: 2 }], events: [{ memberId: 'a', choice: 'approve', sequence: 1, keyEpoch: 1 }], nowMs: 0 })).toMatchObject({ ok: false, code: 'stale-key-epoch' });
  });

  it('refuses ambiguous delegation, inactive endpoints and key epoch mismatch', () => {
    const members = [{ memberId: 'a', keyEpoch: 2 }, { memberId: 'b', keyEpoch: 1 }];
    const run = (delegations: Parameters<typeof reduceGovernanceVotes>[0]['delegations']) =>
      reduceGovernanceVotes({ members, events: [], delegations, nowMs: 10 });
    expect(run([{ from: 'a', to: 'b', epoch: 2 }])).toMatchObject({ ok: true });
    expect(run([{ from: 'a', to: 'b', epoch: 1 }])).toMatchObject({ ok: false, code: 'stale-key-epoch' });
    expect(run([{ from: 'a', to: 'b', epoch: 3 }])).toMatchObject({ ok: false, code: 'stale-key-epoch' });
    expect(run([{ from: 'a', to: 'b', epoch: 2 }, { from: 'a', to: 'a', epoch: 2 }]))
      .toMatchObject({ ok: false, code: 'invalid-delegation' });
    expect(run([{ from: 'a', to: 'missing', epoch: 2 }])).toMatchObject({ ok: false, code: 'unknown-member' });
    expect(run([{ from: 'a', to: 'b', epoch: 2, expiresAtMs: 10 }]))
      .toMatchObject({ ok: false, code: 'delegation-expired' });
    expect(reduceGovernanceVotes({ members: [members[0]!, { ...members[1]!, revoked: true }], events: [],
      delegations: [{ from: 'a', to: 'b', epoch: 2 }], nowMs: 10 }))
      .toMatchObject({ ok: false, code: 'revoked-member' });
  });

  it('requires exact integer weights, unambiguous members and valid ballots', () => {
    const event = { memberId: 'a', choice: 'approve' as const, sequence: 1, keyEpoch: 2 };
    const members = [{ memberId: 'a', keyEpoch: 2 }];
    for (const over of [{ sequence: NaN }, { sequence: -1 }, { sequence: 0.5 },
      { keyEpoch: NaN }, { choice: 'invented' as 'approve' }]) {
      expect(reduceGovernanceVotes({ members, events: [{ ...event, ...over }], nowMs: 0 }))
        .toMatchObject({ ok: false, code: 'invalid-vote' });
    }
    expect(reduceGovernanceVotes({ members, events: [{ ...event, keyEpoch: 3 }], nowMs: 0 }))
      .toMatchObject({ ok: false, code: 'stale-key-epoch' });
    for (const weight of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(reduceGovernanceVotes({ members: [{ memberId: 'a', weight }], events: [], nowMs: 0 }))
        .toMatchObject({ ok: false, code: 'invalid-weight' });
    }
    expect(reduceGovernanceVotes({ members: [{ memberId: 'a', weight: Number.MAX_SAFE_INTEGER },
      { memberId: 'b' }], events: [], nowMs: 0 })).toMatchObject({ ok: false, code: 'invalid-weight' });
    expect(reduceGovernanceVotes({ members: [members[0]!, members[0]!], events: [], nowMs: 0 }))
      .toMatchObject({ ok: false, code: 'unknown-member' });
  });

  it('preserves each eligible weight once across transitive delegation and replacement', () => {
    const result = reduceGovernanceVotes({ members: [{ memberId: 'a', weight: 2 },
      { memberId: 'b', weight: 3 }, { memberId: 'c', weight: 5 }],
      delegations: [{ from: 'a', to: 'b', epoch: 1 }, { from: 'b', to: 'c', epoch: 1 }],
      events: [{ memberId: 'a', choice: 'reject', sequence: 1, keyEpoch: 1 },
        { memberId: 'c', choice: 'reject', sequence: 1, keyEpoch: 1 },
        { memberId: 'c', choice: 'approve', sequence: 2, keyEpoch: 1 }], nowMs: 0 });
    expect(result).toMatchObject({ ok: true, value: { approveWeight: 10, rejectWeight: 0,
      participatingWeight: 10, totalEligibleWeight: 10, replacements: 1 } });
  });
});
