/** Authenticated governance over the existing signed policy, event log and Ed25519 helpers. */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../authority/authority-rpc-envelope';
import { verifyEd25519 } from '../../identity/ed25519';
import type { FederatedGovernanceEvent, GovernanceEventKind } from './governance-federation';
import type { GovernanceRound, GovernanceVoteEvent } from './governance-round';
import { canonicalizePlanAdmissionPolicy, validatePlanAdmissionPolicy, type PlanAdmissionPolicy } from './plan-admission-policy';
import type { Delegation, VotingMember } from './governance-voting';

export interface GovernanceSigningMember extends VotingMember {
  readonly publicKey: string;
  readonly keyEpoch: number;
  readonly roles: readonly GovernanceEventKind[];
  readonly originPeerIds: readonly string[];
  readonly expiresAtMs?: number;
}

/** Resolve this from an independently trusted owner-signed policy, never from incoming events. */
export interface GovernanceSigningAuthority {
  readonly potId: string;
  readonly policy: PlanAdmissionPolicy;
  readonly members: readonly GovernanceSigningMember[];
  readonly delegations?: readonly Delegation[];
}

const kinds: ReadonlySet<string> = new Set(['round-open', 'vote', 'finalize', 'pause', 'resume', 'revoke']);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const epoch = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;

function canonicalBase64(value: unknown, bytes: number): value is string {
  if (typeof value !== 'string') return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === bytes && decoded.toString('base64') === value;
}

export function validGovernanceSigningAuthority(authority: GovernanceSigningAuthority): boolean {
  if (!authority || !nonempty(authority.potId) || !validatePlanAdmissionPolicy(authority.policy).ok ||
      !Array.isArray(authority.members) || authority.members.length === 0) return false;
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const m of authority.members) {
    if (!m || !nonempty(m.memberId) || ids.has(m.memberId) || !canonicalBase64(m.publicKey, 32) ||
        keys.has(m.publicKey) || !epoch(m.keyEpoch) ||
        (m.weight !== undefined && (!Number.isSafeInteger(m.weight) || m.weight <= 0)) ||
        (m.revoked !== undefined && typeof m.revoked !== 'boolean') ||
        (m.expiresAtMs !== undefined && (!Number.isSafeInteger(m.expiresAtMs) || m.expiresAtMs < 0)) ||
        !Array.isArray(m.roles) || m.roles.length === 0 || m.roles.some((r: string) => !kinds.has(r)) ||
        new Set(m.roles).size !== m.roles.length || !Array.isArray(m.originPeerIds) ||
        m.originPeerIds.length === 0 || m.originPeerIds.some((p: string) => !nonempty(p))) return false;
    ids.add(m.memberId);
    keys.add(m.publicKey);
  }
  const sources = new Set<string>();
  if (authority.delegations !== undefined && !Array.isArray(authority.delegations)) return false;
  for (const d of authority.delegations ?? []) {
    const from = authority.members.find(m => m.memberId === d?.from);
    const to = authority.members.find(m => m.memberId === d?.to);
    if (!d || !ids.has(d.from) || !ids.has(d.to) || sources.has(d.from) || !epoch(d.epoch) ||
        !from || !to || from.revoked || to.revoked || !from.roles.includes('vote') || !to.roles.includes('vote') || d.epoch !== from.keyEpoch ||
        (d.expiresAtMs !== undefined && (!Number.isSafeInteger(d.expiresAtMs) || d.expiresAtMs < 0))) return false;
    sources.add(d.from);
  }
  const totalWeight = authority.members.filter(m => !m.revoked && m.roles.includes('vote'))
    .reduce((total, m) => total + (m.weight ?? 1), 0);
  if (!Number.isSafeInteger(totalWeight)) return false;
  return true;
}

/** One commitment covers policy thresholds, electorate, roles, weights, peers and key epochs. */
export function governanceAuthorityHash(authority: GovernanceSigningAuthority): string {
  const body = {
    domain: 'papercusp:governance-authority:v2', potId: authority.potId,
    policy: JSON.parse(canonicalizePlanAdmissionPolicy(authority.policy)),
    members: authority.members.map(m => ({ memberId: m.memberId, publicKey: m.publicKey,
      keyEpoch: m.keyEpoch, roles: [...m.roles].sort(), originPeerIds: [...m.originPeerIds].sort(),
      weight: m.weight ?? 1, revoked: m.revoked ?? false, expiresAtMs: m.expiresAtMs ?? null,
    })).sort((a, b) => a.memberId.localeCompare(b.memberId)),
    delegations: [...(authority.delegations ?? [])].sort((a, b) => a.from.localeCompare(b.from)),
  };
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export function governanceEventSigningBytes(event: Omit<FederatedGovernanceEvent, 'signature'>): Buffer {
  return Buffer.from(canonicalJson({ domain: 'papercusp:governance-event:v2', event }), 'utf8');
}

export function governanceVoteSigningBytes(
  authority: GovernanceSigningAuthority, round: GovernanceRound,
  vote: Omit<GovernanceVoteEvent, 'signature'>,
): Buffer {
  return Buffer.from(canonicalJson({ domain: 'papercusp:governance-ballot:v2',
    potId: authority.potId, roundId: round.roundId, planRevisionHash: round.planRevisionHash,
    policyVersion: round.policyVersion, authorityHash: round.authorityHash,
    approvedActionHash: round.approvedActionHash ?? null, vote,
  }), 'utf8');
}

export type GovernanceAuthentication = { ok: true } | { ok: false; code:
  'invalid-authority' | 'invalid-event' | 'foreign-pot' | 'missing-authorization' | 'ineligible-signer' |
  'stale-key-epoch' | 'expired-signer' | 'unauthorized-role' | 'wrong-origin-peer' |
  'invalid-time' | 'invalid-round-binding' | 'unverified-signature' | 'unverified-ballot' };

/** Authenticate the signed envelope before persisting unordered peer delivery.
 * Round-dependent ballot verification remains mandatory at consumption. */
export function authenticateGovernanceEnvelope(input: {
  authority: GovernanceSigningAuthority; event: FederatedGovernanceEvent;
  nowMs: number;
}): GovernanceAuthentication {
  const { authority, event, nowMs } = input;
  if (!validGovernanceSigningAuthority(authority)) return { ok: false, code: 'invalid-authority' };
  if (!event || !nonempty(event.eventId) || !nonempty(event.roundId) || !nonempty(event.originPeerId) ||
      !event.body || !kinds.has(event.body.kind) ||
      (event.body.kind === 'vote' && (!event.body.vote || typeof event.body.vote !== 'object')))
    return { ok: false, code: 'invalid-event' };
  if (event.potId !== authority.potId) return { ok: false, code: 'foreign-pot' };
  const authorization = event.authorization;
  if (!authorization || !nonempty(authorization.memberId) || !epoch(authorization.keyEpoch))
    return { ok: false, code: 'missing-authorization' };
  const member = authority.members.find(m => m.memberId === authorization.memberId);
  if (!member || member.revoked) return { ok: false, code: 'ineligible-signer' };
  if (member.keyEpoch !== authorization.keyEpoch) return { ok: false, code: 'stale-key-epoch' };
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(event.occurredAtMs) ||
      event.occurredAtMs < 0 || event.occurredAtMs > nowMs) return { ok: false, code: 'invalid-time' };
  if (member.expiresAtMs !== undefined && nowMs >= member.expiresAtMs)
    return { ok: false, code: 'expired-signer' };
  if (!member.roles.includes(event.body.kind)) return { ok: false, code: 'unauthorized-role' };
  if (!member.originPeerIds.includes(event.originPeerId)) return { ok: false, code: 'wrong-origin-peer' };
  const { signature, ...unsigned } = event;
  if (!canonicalBase64(signature, 64) || !verifyEd25519(governanceEventSigningBytes(unsigned), member.publicKey, Buffer.from(signature, 'base64')))
    return { ok: false, code: 'unverified-signature' };
  return { ok: true };
}

/** Authenticate transport/control signer AND the voter's independent ballot signature. */
export function authenticateGovernanceEvent(input: {
  authority: GovernanceSigningAuthority; event: FederatedGovernanceEvent;
  round?: GovernanceRound; nowMs: number;
}): GovernanceAuthentication {
  const envelope = authenticateGovernanceEnvelope(input);
  if (!envelope.ok) return envelope;
  const { authority, event } = input;
  const member = authority.members.find(m => m.memberId === event.authorization!.memberId)!;
  const round = event.body.kind === 'round-open' ? event.body.round : input.round;
  const eligible = authority.members.filter(m => !m.revoked && m.roles.includes('vote')).map(m => m.memberId).sort();
  if (!round || round.roundId !== event.roundId || !nonempty(round.planRevisionHash) ||
      !Array.isArray(round.eligibleMemberIds) || round.eligibleMemberIds.some(id => !nonempty(id)) ||
      new Set(round.eligibleMemberIds).size !== round.eligibleMemberIds.length ||
      round.policyVersion !== authority.policy.policyVersion || round.authorityHash !== governanceAuthorityHash(authority) ||
      !Number.isSafeInteger(round.createdAtMs) || round.createdAtMs < 0 || round.createdAtMs > event.occurredAtMs ||
      canonicalJson([...round.eligibleMemberIds].sort()) !== canonicalJson(eligible))
    return { ok: false, code: 'invalid-round-binding' };
  if (event.body.kind === 'vote') {
    const { signature: ballotSignature, ...vote } = event.body.vote;
    if (vote.memberId !== member.memberId || vote.roundId !== round.roundId || vote.keyEpoch !== member.keyEpoch ||
        !Number.isSafeInteger(vote.sequence) || vote.sequence < 0 || !nonempty(vote.eventId) ||
        !['approve', 'reject', 'abstain'].includes(vote.choice) || !eligible.includes(vote.memberId) ||
        !canonicalBase64(ballotSignature, 64) ||
        !verifyEd25519(governanceVoteSigningBytes(authority, round, vote), member.publicKey, Buffer.from(ballotSignature, 'base64')))
      return { ok: false, code: 'unverified-ballot' };
  }
  return { ok: true };
}
