import { describe, expect, it } from 'vitest';
import { appendGovernanceVote, createGovernanceRound, finalizeGovernanceRound, rebuildGovernanceRound, verifyFinalizationCertificate, type GovernanceVoteEvent } from './governance-round';
import { DEFAULT_PLAN_ADMISSION_POLICY } from './plan-admission-policy';

const round = createGovernanceRound({ roundId: 'r-1', planRevisionHash: 'sha256:plan', policyVersion: 1, eligibleMemberIds: ['a', 'b'], createdAtMs: 1_000 });
const vote = (memberId: string, sequence: number, eventId = `e-${memberId}`): GovernanceVoteEvent => ({ eventId, roundId: 'r-1', memberId, choice: 'approve', sequence, signature: 'sig' });

describe('governance round records', () => {
  it('snapshots membership, appends immutable votes, and finalizes a certificate', () => {
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    const first = appendGovernanceVote(round.value, [], vote('a', 1));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = appendGovernanceVote(round.value, first.value, vote('b', 2));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const cert = finalizeGovernanceRound({ round: round.value, events: second.value, members: [{ memberId: 'a' }, { memberId: 'b' }], policy: DEFAULT_PLAN_ADMISSION_POLICY, nowMs: 2_000 });
    expect(cert).toMatchObject({ ok: true, value: { admitted: true, certificateHash: expect.stringMatching(/^[0-9a-f]{64}$/) } });
  });

  it('refuses an omitted roster instead of assuming unit weights and live keys', () => {
    if (!round.ok) throw new Error('invalid fixture');
    // The runtime guard also protects JavaScript and legacy callers.
    // @ts-expect-error an authenticated explicit roster is mandatory
    const result = finalizeGovernanceRound({ round: round.value, events: [vote('a', 1), vote('b', 1)],
      policy: DEFAULT_PLAN_ADMISSION_POLICY, nowMs: 2_000 });
    expect(result).toMatchObject({ ok: false, code: 'unknown-member', detail: 'an explicit voting roster is required' });
  });

  it('rebuilds deterministically and rejects duplicate/unknown votes', () => {
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    const rebuilt = rebuildGovernanceRound(round.value, [vote('b', 2), vote('a', 1)]);
    expect(rebuilt).toMatchObject({ ok: true, value: [{ memberId: 'a' }, { memberId: 'b' }] });
    if (!rebuilt.ok) return;
    expect(appendGovernanceVote(round.value, rebuilt.value, vote('a', 3, 'e-replacement'))).toMatchObject({ ok: true });
    expect(appendGovernanceVote(round.value, rebuilt.value, vote('a', 3, 'e-a'))).toMatchObject({ ok: false, code: 'duplicate-event' });
    expect(appendGovernanceVote(round.value, rebuilt.value, vote('a', 1, 'e-replay'))).toMatchObject({ ok: false, code: 'duplicate-event' });
    expect(appendGovernanceVote(round.value, rebuilt.value, vote('mallory', 3, 'e-m'))).toMatchObject({ ok: false, code: 'unknown-member' });
  });
});

describe('finalization consults the weighted vote reducer', () => {
  const weighted = createGovernanceRound({ roundId: 'r-w', planRevisionHash: 'sha256:plan', policyVersion: 1, eligibleMemberIds: ['a', 'b', 'c', 'd'], createdAtMs: 1_000 });
  const ballot = (memberId: string, choice: GovernanceVoteEvent['choice'], sequence: number): GovernanceVoteEvent => ({ eventId: `e-${memberId}`, roundId: 'r-w', memberId, choice, sequence, signature: 'sig' });
  // Unweighted this is 3 approve vs 1 reject — 7500bps, clearing the policy's
  // 6667bps approval bar at full quorum, so the policy alone WOULD admit it.
  const events = [ballot('a', 'approve', 1), ballot('b', 'approve', 2), ballot('c', 'approve', 3), ballot('d', 'reject', 4)];

  it('lets the weighted tally veto an admission the unweighted policy count grants', () => {
    expect(weighted.ok).toBe(true);
    if (!weighted.ok) return;
    // POSITIVE CONTROL: at equal weights the same ballots ARE admitted, so a
    // veto below is the weights talking and not some unrelated refusal.
    const equal = finalizeGovernanceRound({ round: weighted.value, events, members: ['a', 'b', 'c', 'd'].map(memberId => ({ memberId })), policy: DEFAULT_PLAN_ADMISSION_POLICY, nowMs: 2_000 });
    expect(equal).toMatchObject({ ok: true, value: { admitted: true } });

    const skewed = finalizeGovernanceRound({
      round: weighted.value,
      events,
      policy: DEFAULT_PLAN_ADMISSION_POLICY,
      nowMs: 2_000,
      members: [{ memberId: 'a' }, { memberId: 'b' }, { memberId: 'c' }, { memberId: 'd', weight: 10 }],
    });
    expect(skewed.ok).toBe(true);
    if (!skewed.ok) return;
    expect(skewed.value.admitted).toBe(false);
    expect(skewed.value.reason).toBe('weighted-approval-not-met');
    expect(skewed.value.tally).toMatchObject({ approveWeight: 3, rejectWeight: 10 });
  });

  it('aborts finalization on a reducer refusal instead of certifying it', () => {
    expect(weighted.ok).toBe(true);
    if (!weighted.ok) return;
    expect(finalizeGovernanceRound({
      round: weighted.value,
      events,
      policy: DEFAULT_PLAN_ADMISSION_POLICY,
      nowMs: 2_000,
      members: [{ memberId: 'a' }, { memberId: 'b' }, { memberId: 'c' }, { memberId: 'd', revoked: true }],
    })).toMatchObject({ ok: false, code: 'vote-reduction-refused' });

    // A ballot signed under a superseded key epoch is likewise refused, not counted.
    expect(finalizeGovernanceRound({
      round: weighted.value,
      events: [{ ...ballot('a', 'approve', 1), keyEpoch: 1 }, ballot('b', 'approve', 2), ballot('c', 'approve', 3), ballot('d', 'reject', 4)],
      policy: DEFAULT_PLAN_ADMISSION_POLICY,
      nowMs: 2_000,
      members: [{ memberId: 'a', keyEpoch: 5 }, { memberId: 'b' }, { memberId: 'c' }, { memberId: 'd' }],
    })).toMatchObject({ ok: false, code: 'vote-reduction-refused' });
  });

  it('covers the tally with the certificate hash, so a swapped tally fails verification', () => {
    expect(weighted.ok).toBe(true);
    if (!weighted.ok) return;
    const cert = finalizeGovernanceRound({ round: weighted.value, events, members: ['a', 'b', 'c', 'd'].map(memberId => ({ memberId })), policy: DEFAULT_PLAN_ADMISSION_POLICY, nowMs: 2_000 });
    expect(cert.ok).toBe(true);
    if (!cert.ok) return;
    expect(verifyFinalizationCertificate(cert.value)).toBe(true);
    expect(verifyFinalizationCertificate({ ...cert.value, tally: { ...cert.value.tally, approveWeight: 99 } })).toBe(false);
  });

  it('enforces the policy approval BPS above a simple weighted majority', () => {
    if (!weighted.ok) throw new Error('invalid fixture');
    // Both headcount (75%) and a weighted majority pass, but weight 3:2
    // is only 60%, below the signed 66.67% policy.
    const result = finalizeGovernanceRound({ round: weighted.value, events,
      policy: DEFAULT_PLAN_ADMISSION_POLICY, nowMs: 2_000,
      members: [{ memberId: 'a' }, { memberId: 'b' }, { memberId: 'c' }, { memberId: 'd', weight: 2 }] });
    expect(result).toMatchObject({ ok: true, value: { admitted: false, reason: 'weighted-approval-not-met' } });
  });

  it('uses delegated weight for quorum and the exact BPS boundary for approval', () => {
    if (!weighted.ok) throw new Error('invalid fixture');
    const members = ['a', 'b', 'c', 'd'].map(memberId => ({ memberId }));
    const delegated = finalizeGovernanceRound({ round: weighted.value, events: [ballot('a', 'approve', 1)],
      policy: DEFAULT_PLAN_ADMISSION_POLICY, nowMs: 2_000, members,
      delegations: ['b', 'c', 'd'].map(from => ({ from, to: 'a', epoch: 1 })) });
    expect(delegated).toMatchObject({ ok: true, value: { admitted: true,
      tally: { approveWeight: 4, participatingWeight: 4, totalEligibleWeight: 4 } } });
    const underQuorum = finalizeGovernanceRound({ round: weighted.value,
      events: [ballot('a', 'approve', 1), ballot('b', 'approve', 2)],
      policy: DEFAULT_PLAN_ADMISSION_POLICY, nowMs: 2_000,
      members: [{ memberId: 'a' }, { memberId: 'b' }, { memberId: 'c', weight: 5 }, { memberId: 'd', weight: 5 }] });
    expect(underQuorum).toMatchObject({ ok: true, value: { admitted: false, reason: 'weighted-quorum-not-met' } });
    for (const [approvalBps, admitted] of [[7_500, true], [7_501, false]] as const) {
      expect(finalizeGovernanceRound({ round: weighted.value, events,
        policy: { ...DEFAULT_PLAN_ADMISSION_POLICY, approvalBps }, nowMs: 2_000, members }))
        .toMatchObject({ ok: true, value: { admitted } });
    }
  });

  it('finalizes advancing replacements deterministically and refuses replay/conflict or extra roster weight', () => {
    if (!weighted.ok) throw new Error('invalid fixture');
    const replacement = { ...ballot('d', 'approve', 5), eventId: 'replacement-d' };
    const input = { round: weighted.value, policy: DEFAULT_PLAN_ADMISSION_POLICY, nowMs: 2_000,
      members: ['a', 'b', 'c', 'd'].map(memberId => ({ memberId })) };
    const revised = finalizeGovernanceRound({ ...input, events: [...events, replacement] });
    expect(revised).toMatchObject({ ok: true, value: { admitted: true, tally: { approveWeight: 4, replacements: 1 } } });
    expect(finalizeGovernanceRound({ ...input, events: [replacement, ...events].reverse() })).toEqual(revised);
    expect(finalizeGovernanceRound({ ...input, events: [...events, { ...replacement, sequence: 4 }] }))
      .toMatchObject({ ok: false, code: 'duplicate-event' });
    expect(finalizeGovernanceRound({ ...input, events: [...events, { ...replacement, eventId: 'e-d' }] }))
      .toMatchObject({ ok: false, code: 'duplicate-event' });
    expect(finalizeGovernanceRound({ ...input, events: [{ ...events[0]!, roundId: 'foreign' }] }))
      .toMatchObject({ ok: false, code: 'unknown-member' });
    expect(finalizeGovernanceRound({ ...input, events, members: ['a', 'b', 'c', 'd', 'extra'].map(memberId => ({ memberId })) }))
      .toMatchObject({ ok: false, code: 'unknown-member' });
  });
});
