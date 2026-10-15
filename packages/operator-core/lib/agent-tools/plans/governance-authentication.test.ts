import { describe, expect, it } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import type { FederatedGovernanceEvent, GovernanceEventBody } from './governance-federation';
import { admissibleCertificate, ingestGovernanceEvents } from './governance-federation';
import { createGovernanceRound, finalizeGovernanceRound, type GovernanceRound, type GovernanceVoteEvent } from './governance-round';
import { DEFAULT_PLAN_ADMISSION_POLICY } from './plan-admission-policy';
import { authenticateGovernanceEvent, governanceAuthorityHash, governanceEventSigningBytes,
  governanceVoteSigningBytes, validGovernanceSigningAuthority, type GovernanceSigningAuthority } from './governance-authentication';

function fixture() {
  const a = generateEd25519KeypairDer();
  const b = generateEd25519KeypairDer();
  const authority: GovernanceSigningAuthority = { potId: 'pot', policy: DEFAULT_PLAN_ADMISSION_POLICY,
    members: [
      { memberId: 'a', publicKey: a.pubkeyBase64, keyEpoch: 1, originPeerIds: ['peer-a'], roles: ['round-open', 'vote', 'finalize', 'pause', 'resume', 'revoke'] },
      { memberId: 'b', publicKey: b.pubkeyBase64, keyEpoch: 1, originPeerIds: ['peer-b'], roles: ['vote'] },
    ],
  };
  const created = createGovernanceRound({ roundId: 'round', planRevisionHash: 'revision', policyVersion: 1,
    eligibleMemberIds: ['a', 'b'], createdAtMs: 1000, authorityHash: governanceAuthorityHash(authority) });
  if (!created.ok) throw new Error(created.detail);
  const round = created.value;
  function sign(body: GovernanceEventBody, over: Partial<Omit<FederatedGovernanceEvent, 'signature'>> = {}, key = a) {
    const unsigned = { eventId: 'outer', potId: 'pot', roundId: 'round', originPeerId: 'peer-a',
      occurredAtMs: 1100, body, authorization: { memberId: 'a', keyEpoch: 1 }, ...over };
    return { ...unsigned, signature: signWithPrivateKeyDer(key.privateKeyDer, governanceEventSigningBytes(unsigned)).toString('base64') };
  }
  const unsignedVote = { eventId: 'ballot', roundId: 'round', memberId: 'a', choice: 'approve' as const, sequence: 1, keyEpoch: 1 };
  const vote: GovernanceVoteEvent = { ...unsignedVote,
    signature: signWithPrivateKeyDer(a.privateKeyDer, governanceVoteSigningBytes(authority, round, unsignedVote)).toString('base64') };
  const verify = (event: FederatedGovernanceEvent, pinned = authority, r: GovernanceRound = round, nowMs = 1200) =>
    authenticateGovernanceEvent({ authority: pinned, event, round: r, nowMs });
  return { a, b, authority, round, vote, sign, verify };
}

describe('eligible governance keys and signed domains', () => {
  it('authenticates a real round, control and independently signed ballot', () => {
    const f = fixture();
    expect(f.verify(f.sign({ kind: 'round-open', round: f.round }))).toEqual({ ok: true });
    expect(f.verify(f.sign({ kind: 'pause' }))).toEqual({ ok: true });
    expect(f.verify(f.sign({ kind: 'vote', vote: f.vote }))).toEqual({ ok: true });
  });

  it('admits authentic federation records and refuses forged inner/outer or wrong-epoch authority', () => {
    const f = fixture();
    const opened = f.sign({ kind: 'round-open', round: f.round }, { eventId: 'opened' });
    const ballot = f.sign({ kind: 'vote', vote: f.vote }, { eventId: 'ballot-envelope' });
    const boundary = { potId: 'pot', visibility: 'shared' as const, memberPeerIds: ['peer-a', 'peer-b'] };
    const ingest = (incoming: readonly FederatedGovernanceEvent[]) => ingestGovernanceEvents({
      boundary, known: [], incoming, verifySignature: event => f.verify(event).ok,
    });
    const accepted = ingest([ballot, opened]);
    expect(accepted.accepted).toHaveLength(2);
    expect(accepted.dropped).toEqual([]);
    for (const forged of [
      { ...ballot, signature: 'forged' },
      f.sign({ kind: 'vote', vote: { ...f.vote, signature: 'forged' } }, { eventId: 'inner-forgery' }),
      f.sign({ kind: 'vote', vote: f.vote }, { eventId: 'wrong-epoch', authorization: { memberId: 'a', keyEpoch: 2 } }),
      f.sign({ kind: 'vote', vote: f.vote }, { eventId: 'wrong-key' }, f.b),
    ]) {
      const refused = ingest([opened, forged]);
      expect(refused.accepted).toEqual([opened]);
      expect(refused.dropped).toMatchObject([{ reason: 'unverified-signature' }]);
    }
    expect(ingestGovernanceEvents({ boundary, known: [], incoming: [opened, ballot] }).accepted).toEqual([]);
  });

  it('quarantines real signed conflicting finalizations in either arrival order while preserving valid and forged controls', () => {
    const f = fixture();
    const voteForB = (choice: GovernanceVoteEvent['choice'], sequence: number): GovernanceVoteEvent => {
      const unsigned = { eventId: `ballot-b-${sequence}`, roundId: f.round.roundId,
        memberId: 'b', choice, sequence, keyEpoch: 1 };
      return { ...unsigned, signature: signWithPrivateKeyDer(f.b.privateKeyDer,
        governanceVoteSigningBytes(f.authority, f.round, unsigned)).toString('base64') };
    };
    const approved = voteForB('approve', 1), replacement = voteForB('reject', 2);
    const finalize = (events: GovernanceVoteEvent[]) => {
      const result = finalizeGovernanceRound({ round: f.round, events,
        members: f.authority.members, policy: f.authority.policy, nowMs: 1200 });
      if (!result.ok) throw new Error(result.detail);
      return result.value;
    };
    const certificate = finalize([f.vote, approved]);
    const rival = finalize([f.vote, approved, replacement]);
    expect(certificate.admitted).toBe(true);
    expect(rival.admitted).toBe(false);
    expect(rival.certificateHash).not.toBe(certificate.certificateHash);
    const opened = f.sign({ kind: 'round-open', round: f.round }, { eventId: 'opened' });
    const ballotA = f.sign({ kind: 'vote', vote: f.vote }, { eventId: 'ballot-a-envelope' });
    const ballotB = (vote: GovernanceVoteEvent) => f.sign({ kind: 'vote', vote }, {
      eventId: `${vote.eventId}-envelope`, originPeerId: 'peer-b',
      authorization: { memberId: 'b', keyEpoch: 1 },
    }, f.b);
    const first = f.sign({ kind: 'finalize', certificate }, { eventId: 'finalize-first' });
    const second = f.sign({ kind: 'finalize', certificate: rival }, { eventId: 'finalize-rival' });
    const boundary = { potId: 'pot', visibility: 'shared' as const, memberPeerIds: ['peer-a', 'peer-b'] };
    const ingest = (incoming: readonly FederatedGovernanceEvent[]) => ingestGovernanceEvents({
      boundary, known: [], incoming, verifySignature: event => f.verify(event).ok,
    });
    const valid = [opened, ballotA, ballotB(approved), first];
    const control = ingest(valid);
    expect(control.dropped).toEqual([]);
    expect(admissibleCertificate(control.projection, f.round.roundId)).toEqual(certificate);
    const forged = ingest([...valid, { ...second, signature: 'forged' }]);
    expect(forged.dropped).toMatchObject([{ reason: 'unverified-signature' }]);
    expect(admissibleCertificate(forged.projection, f.round.roundId)).toEqual(certificate);
    const forked = [...valid, ballotB(replacement), second];
    for (const order of [forked, [...forked].reverse()]) {
      const result = ingest(order);
      expect(result.dropped).toEqual([]);
      expect(result.projection.rounds.get(f.round.roundId)?.status).toBe('quarantined');
      expect(result.projection.rounds.get(f.round.roundId)?.certificates).toHaveLength(2);
      expect(admissibleCertificate(result.projection, f.round.roundId)).toBeNull();
    }
  });

  it('refuses legacy and forged nonempty signatures', () => {
    const f = fixture();
    const event = f.sign({ kind: 'vote', vote: f.vote });
    expect(f.verify({ ...event, authorization: undefined })).toMatchObject({ ok: false, code: 'missing-authorization' });
    expect(f.verify({ ...event, signature: 'forged' })).toMatchObject({ ok: false, code: 'unverified-signature' });
  });

  it('fails closed on malformed decoded events and electorate records', () => {
    const f = fixture();
    for (const event of [null, {}, { ...f.sign({ kind: 'pause' }), body: null },
      { ...f.sign({ kind: 'pause' }), body: { kind: 'vote' } }]) {
      expect(f.verify(event as FederatedGovernanceEvent)).toMatchObject({ ok: false, code: 'invalid-event' });
    }
    const event = f.sign({ kind: 'pause' });
    expect(f.verify(event, f.authority, { ...f.round, eligibleMemberIds: undefined } as unknown as GovernanceRound))
      .toMatchObject({ ok: false, code: 'invalid-round-binding' });
    expect(f.verify(event, f.authority, { ...f.round, eligibleMemberIds: ['a', 'a'] }))
      .toMatchObject({ ok: false, code: 'invalid-round-binding' });
  });

  it('rejects outer payload edits and a re-signed outer envelope with a forged inner ballot', () => {
    const f = fixture();
    const event = f.sign({ kind: 'vote', vote: f.vote });
    expect(f.verify({ ...event, eventId: 'edited' })).toMatchObject({ ok: false, code: 'unverified-signature' });
    expect(f.verify(f.sign({ kind: 'vote', vote: { ...f.vote, choice: 'reject' } })))
      .toMatchObject({ ok: false, code: 'unverified-ballot' });
  });

  it('does not let a governor sign another member ballot', () => {
    const f = fixture();
    expect(f.verify(f.sign({ kind: 'vote', vote: { ...f.vote, memberId: 'b' } })))
      .toMatchObject({ ok: false, code: 'unverified-ballot' });
  });

  it('requires the permitted control role, authenticated origin and exact key epoch', () => {
    const f = fixture();
    expect(f.verify(f.sign({ kind: 'revoke', reason: 'halt' }, { originPeerId: 'peer-b', authorization: { memberId: 'b', keyEpoch: 1 } }, f.b)))
      .toMatchObject({ ok: false, code: 'unauthorized-role' });
    expect(f.verify(f.sign({ kind: 'pause' }, { originPeerId: 'peer-b' })))
      .toMatchObject({ ok: false, code: 'wrong-origin-peer' });
    expect(f.verify(f.sign({ kind: 'pause' }, { authorization: { memberId: 'a', keyEpoch: 2 } })))
      .toMatchObject({ ok: false, code: 'stale-key-epoch' });
  });

  it('refuses revoked, expired and future authority', () => {
    const f = fixture();
    const event = f.sign({ kind: 'pause' });
    expect(f.verify(event, { ...f.authority, members: [{ ...f.authority.members[0]!, revoked: true }, f.authority.members[1]!] }))
      .toMatchObject({ ok: false, code: 'ineligible-signer' });
    expect(f.verify(event, { ...f.authority, members: [{ ...f.authority.members[0]!, expiresAtMs: 1200 }, f.authority.members[1]!] }))
      .toMatchObject({ ok: false, code: 'expired-signer' });
    expect(f.verify(f.sign({ kind: 'pause' }, { occurredAtMs: 1300 }))).toMatchObject({ ok: false, code: 'invalid-time' });
    expect(f.verify(event, f.authority, f.round, NaN)).toMatchObject({ ok: false, code: 'invalid-time' });
  });

  it('binds ballots to the exact pot, round, revision, policy, action and electorate', () => {
    const f = fixture();
    const event = f.sign({ kind: 'vote', vote: f.vote });
    expect(f.verify({ ...event, potId: 'foreign' })).toMatchObject({ ok: false, code: 'foreign-pot' });
    for (const over of [{ roundId: 'another' }, { planRevisionHash: 'edited' }, { policyVersion: 2 },
      { approvedActionHash: 'another-action' }, { eligibleMemberIds: ['a'] }, { authorityHash: 'forged' }]) {
      expect(f.verify(event, f.authority, { ...f.round, ...over })).toMatchObject({ ok: false });
    }
  });

  it('requires delegations to active voters at their exact signing epoch', () => {
    const f = fixture();
    const delegated = { ...f.authority, delegations: [{ from: 'a', to: 'b', epoch: 1 }] };
    expect(validGovernanceSigningAuthority(delegated)).toBe(true);
    expect(validGovernanceSigningAuthority({ ...delegated, delegations: [{ from: 'a', to: 'b', epoch: 2 }] })).toBe(false);
    expect(validGovernanceSigningAuthority({ ...delegated, members: [f.authority.members[0]!,
      { ...f.authority.members[1]!, revoked: true }] })).toBe(false);
    expect(validGovernanceSigningAuthority({ ...delegated, members: [f.authority.members[0]!,
      { ...f.authority.members[1]!, roles: ['pause'] }] })).toBe(false);
    expect(validGovernanceSigningAuthority({ ...f.authority, members: [
      { ...f.authority.members[0]!, weight: Number.MAX_SAFE_INTEGER }, f.authority.members[1]!] })).toBe(false);
  });

  it('rejects duplicate signer identities or a key reused as several voters', () => {
    const f = fixture();
    expect(validGovernanceSigningAuthority({ ...f.authority, members: [f.authority.members[0]!, f.authority.members[0]!] })).toBe(false);
    expect(validGovernanceSigningAuthority({ ...f.authority, members: [f.authority.members[0]!, { ...f.authority.members[1]!, publicKey: f.a.pubkeyBase64 }] })).toBe(false);
    expect(validGovernanceSigningAuthority({ ...f.authority, members: [{ ...f.authority.members[0]!, keyEpoch: NaN }] })).toBe(false);
  });

  it('authenticates a committed action and refuses moving its ballot to another action', () => {
    const f = fixture();
    const round = { ...f.round, approvedActionHash: 'a'.repeat(64) };
    const { signature: _signature, ...unsigned } = f.vote;
    void _signature;
    const vote = { ...unsigned, signature: signWithPrivateKeyDer(f.a.privateKeyDer,
      governanceVoteSigningBytes(f.authority, round, unsigned)).toString('base64') };
    const event = f.sign({ kind: 'vote', vote });
    expect(f.verify(event, f.authority, round)).toEqual({ ok: true });
    // Even a permitted governor re-signing the envelope cannot replace the
    // independently signed voter's action commitment.
    expect(f.verify(f.sign({ kind: 'vote', vote }), f.authority,
      { ...round, approvedActionHash: 'b'.repeat(64) }))
      .toMatchObject({ ok: false, code: 'unverified-ballot' });
  });

  it('normalizes roster order and commits changed role, weight or policy semantics', () => {
    const f = fixture();
    expect(governanceAuthorityHash({ ...f.authority, members: [...f.authority.members].reverse() })).toBe(governanceAuthorityHash(f.authority));
    for (const changed of [
      { ...f.authority, policy: { ...f.authority.policy, approvalBps: 9000 } },
      { ...f.authority, members: [{ ...f.authority.members[0]!, weight: 2 }, f.authority.members[1]!] },
      { ...f.authority, members: [{ ...f.authority.members[0]!, roles: ['vote' as const] }, f.authority.members[1]!] },
    ]) expect(governanceAuthorityHash(changed)).not.toBe(governanceAuthorityHash(f.authority));
  });
});
