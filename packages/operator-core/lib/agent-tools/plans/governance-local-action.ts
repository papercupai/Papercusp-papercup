/** Local UI actions reuse the policy verifier, device keychain and immutable event log. */
import { randomUUID } from 'node:crypto';
import { authenticateGovernanceEvent, governanceAuthorityHash, governanceEventSigningBytes,
  governanceVoteSigningBytes, type GovernanceSigningAuthority } from './governance-authentication';
import { projectGovernanceFederation, roundStatusAt, type FederatedGovernanceEvent, type GovernanceEventBody } from './governance-federation';
import { createGovernanceRound, finalizeGovernanceRound, type GovernanceRound } from './governance-round';
import type { PlanAdmissionGovernanceSnapshot } from './plan-admission-governance-store';

export interface LocalGovernanceSigner {
  publicKey: string;
  originPeerId: string;
  sign(bytes: Buffer): Promise<Buffer>;
}

/** Load an existing device key only; switching GitHub accounts invalidates the cache. */
export async function localGovernanceSigner(): Promise<LocalGovernanceSigner | null> {
  const { loadCachedLocalAnnounceIdentity } = await import('../../sync/hyperbee/local-announce-identity');
  const { getAuthenticatedGithubUser } = await import('../../identity/resolve-local-github-identity');
  const [identity, user] = await Promise.all([loadCachedLocalAnnounceIdentity(), getAuthenticatedGithubUser()]);
  if (!identity || !user || identity.githubUserId !== user.id) return null;
  const { signWithDeviceKey } = await import('../../identity/sign-with-device-key');
  return { publicKey: identity.devicePubkeyBase64, originPeerId: identity.devicePubkeyBase64,
    sign: bytes => signWithDeviceKey(identity.keychainId, bytes) };
}

export function localGovernanceActor(authority: GovernanceSigningAuthority, signer: LocalGovernanceSigner | null, nowMs: number) {
  const member = signer && authority.members.find(m => m.publicKey === signer.publicKey && !m.revoked &&
    (m.expiresAtMs === undefined || nowMs < m.expiresAtMs) && m.originPeerIds.includes(signer.originPeerId));
  return member ? { memberId: member.memberId, keyEpoch: member.keyEpoch, roles: member.roles } : null;
}

export type LocalGovernanceAction =
  | { kind: 'open' }
  | { kind: 'vote'; roundId: string; choice: 'approve' | 'reject' | 'abstain' }
  | { kind: 'finalize'; roundId: string };

export async function createLocalGovernanceEvent(input: {
  authority: GovernanceSigningAuthority;
  snapshot: PlanAdmissionGovernanceSnapshot;
  planRevisionHash: string;
  expectedRevisionHash: string;
  signer: LocalGovernanceSigner | null;
  action: LocalGovernanceAction;
  nowMs: number;
}): Promise<FederatedGovernanceEvent> {
  const { authority, snapshot, signer, action, nowMs } = input;
  if (input.expectedRevisionHash !== input.planRevisionHash) throw new Error('This proposal changed. Reload it before deciding.');
  if (snapshot.potId !== authority.potId || snapshot.integrityErrors.length || snapshot.conflictedRoundIds.size)
    throw new Error('Governance evidence needs repair before another decision can be recorded.');
  const actor = localGovernanceActor(authority, signer, nowMs);
  if (!actor || !signer) throw new Error('Your current device is not an eligible signer in the organization’s verified policy.');
  const kind = action.kind === 'open' ? 'round-open' : action.kind;
  if (!actor.roles.includes(kind)) throw new Error('Your policy role cannot perform this decision.');
  let round: GovernanceRound;
  let body: GovernanceEventBody;
  if (action.kind === 'open') {
    const projection = projectGovernanceFederation(authority.potId, snapshot.events);
    if (snapshot.events.some(event => event.body.kind === 'round-open' &&
      event.body.round.planRevisionHash === input.planRevisionHash &&
      ['open', 'paused'].includes(roundStatusAt(projection.rounds.get(event.roundId)!, nowMs))))
      throw new Error('This proposal already has an active voting round.');
    const created = createGovernanceRound({ roundId: randomUUID(), planRevisionHash: input.planRevisionHash,
      policyVersion: authority.policy.policyVersion, authorityHash: governanceAuthorityHash(authority),
      eligibleMemberIds: authority.members.filter(m => !m.revoked && m.roles.includes('vote')).map(m => m.memberId).sort(), createdAtMs: nowMs });
    if (!created.ok) throw new Error(created.detail);
    round = created.value;
    body = { kind: 'round-open', round };
  } else {
    const opened = snapshot.events.find(event => event.roundId === action.roundId && event.body.kind === 'round-open');
    if (!opened || opened.body.kind !== 'round-open') throw new Error('Voting round not found.');
    round = opened.body.round;
    if (round.planRevisionHash !== input.planRevisionHash) throw new Error('This voting round covers an older proposal revision.');
    const projected = projectGovernanceFederation(authority.potId, snapshot.events).rounds.get(round.roundId);
    if (!projected || roundStatusAt(projected, nowMs) !== 'open') throw new Error('This voting round is no longer open.');
    if (nowMs >= round.createdAtMs + authority.policy.ratificationWindowSec * 1000) throw new Error('This voting round has expired.');
    const ballots = snapshot.events.flatMap(event => event.roundId === round.roundId && event.body.kind === 'vote' ? [event.body.vote] : []);
    if (action.kind === 'vote') {
      const sequence = Math.max(-1, ...ballots.filter(vote => vote.memberId === actor.memberId).map(vote => vote.sequence)) + 1;
      const vote = { eventId: randomUUID(), roundId: round.roundId, memberId: actor.memberId,
        choice: action.choice, sequence, keyEpoch: actor.keyEpoch };
      body = { kind: 'vote', vote: { ...vote, signature: (await signer.sign(governanceVoteSigningBytes(authority, round, vote))).toString('base64') } };
    } else {
      const finalization = finalizeGovernanceRound({ round, events: ballots, policy: authority.policy,
        members: authority.members.filter(m => !m.revoked && m.roles.includes('vote')), delegations: authority.delegations, nowMs });
      if (!finalization.ok) throw new Error(finalization.detail);
      body = { kind: 'finalize', certificate: finalization.value };
    }
  }
  const unsigned = { eventId: randomUUID(), potId: authority.potId, roundId: round.roundId,
    originPeerId: signer.originPeerId, occurredAtMs: nowMs, body, authorization: { memberId: actor.memberId, keyEpoch: actor.keyEpoch } };
  const event = { ...unsigned, signature: (await signer.sign(governanceEventSigningBytes(unsigned))).toString('base64') };
  const authentication = authenticateGovernanceEvent({ authority, event, round, nowMs });
  if (!authentication.ok) throw new Error('Device signature was refused: ' + authentication.code);
  return event;
}
