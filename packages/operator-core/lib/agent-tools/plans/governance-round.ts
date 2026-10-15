/** Immutable shared-pot governance round records and deterministic rebuild (P-002). */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../authority/authority-rpc-envelope';
import type { RefusalContract } from '../../capability-envelope/refusal-contract-types';
import { evaluatePlanAdmission, validatePlanAdmissionPolicy, type PlanAdmissionPolicy, type PlanVote } from './plan-admission-policy';
import { reduceGovernanceVotes, type Delegation, type VotingMember, type VotingTally } from './governance-voting';

export interface GovernanceRound {
  readonly roundId: string;
  readonly planRevisionHash: string;
  readonly policyVersion: number;
  readonly eligibleMemberIds: readonly string[];
  readonly createdAtMs: number;
  /** Commitment to the independently resolved owner-signed policy and signer roster. */
  readonly authorityHash?: string;
  /** Exact canonical action commitment; required when this round authorizes execution. */
  readonly approvedActionHash?: string;
}

export interface GovernanceVoteEvent {
  readonly eventId: string;
  readonly roundId: string;
  readonly memberId: string;
  readonly choice: PlanVote['choice'];
  readonly sequence: number;
  readonly signature: string;
  /** Signing-key epoch of the ballot; a vote trailing its member's epoch is refused by the reducer. */
  readonly keyEpoch?: number;
}

export interface FinalizationCertificate {
  readonly roundId: string;
  readonly planRevisionHash: string;
  readonly policyVersion: number;
  /** Copied from the ratified round and covered by certificateHash. */
  readonly approvedActionHash?: string;
  readonly admitted: boolean;
  readonly reason: string;
  readonly voteEventIds: readonly string[];
  readonly finalizedAtMs: number;
  /**
   * The weighted tally reduceGovernanceVotes produced for this round. It is
   * covered by certificateHash, so a certificate cannot be re-attributed to a
   * tally it did not come from, and federation refuses any certificate that
   * carries none (i.e. one finalized without consulting the reducer).
   */
  readonly tally: VotingTally;
  readonly certificateHash: string;
}

export type GovernanceRoundError = 'invalid-round' | 'duplicate-member' | 'unknown-member' | 'duplicate-event' | 'invalid-sequence' | 'vote-reduction-refused';
/** `refusal` is the lift contract; present on the reducer-refusal abort, which is the fail-closed one. */
export type RoundResult<T> = { ok: true; value: T } | { ok: false; code: GovernanceRoundError; detail: string; refusal?: RefusalContract };

export function createGovernanceRound(input: Omit<GovernanceRound, 'createdAtMs'> & { createdAtMs: number }): RoundResult<GovernanceRound> {
  if (!input.roundId.trim() || !input.planRevisionHash.trim() || !Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1 || !Number.isFinite(input.createdAtMs)) return { ok: false, code: 'invalid-round', detail: 'round id, plan revision, policy epoch, and timestamp are required' };
  if (input.eligibleMemberIds.length === 0 || new Set(input.eligibleMemberIds).size !== input.eligibleMemberIds.length || input.eligibleMemberIds.some((id) => !id.trim())) return { ok: false, code: 'duplicate-member', detail: 'eligible member snapshot must contain unique non-empty ids' };
  if (input.approvedActionHash !== undefined && !/^[0-9a-f]{64}$/.test(input.approvedActionHash)) return { ok: false, code: 'invalid-round', detail: 'approved action commitment must be a canonical SHA-256 digest' };
  return { ok: true, value: Object.freeze({ ...input, eligibleMemberIds: [...input.eligibleMemberIds] }) };
}

export function appendGovernanceVote(round: GovernanceRound, events: readonly GovernanceVoteEvent[], event: GovernanceVoteEvent): RoundResult<GovernanceVoteEvent[]> {
  if (event.roundId !== round.roundId || !round.eligibleMemberIds.includes(event.memberId)) return { ok: false, code: 'unknown-member', detail: 'vote round or member does not match the immutable eligibility snapshot' };
  if (!event.eventId.trim() || !Number.isSafeInteger(event.sequence) || event.sequence < 0 || !event.signature.trim()) return { ok: false, code: 'invalid-sequence', detail: 'vote id, sequence and signature are required' };
  if (events.some((e) => e.eventId === event.eventId || (e.memberId === event.memberId && e.sequence >= event.sequence))) return { ok: false, code: 'duplicate-event', detail: 'event ids are immutable and a replacement must advance the member sequence' };
  return { ok: true, value: [...events, event].sort((a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId)) };
}

function certificateHash(cert: Omit<FinalizationCertificate, 'certificateHash'>): string {
  return createHash('sha256').update(canonicalJson(cert)).digest('hex');
}

/**
 * Finalize a round. The weighted reducer is CONSULTED FIRST and is load-bearing
 * through its refusals and the policy's weighted quorum/approval thresholds.
 * `members`/`delegations` describe the explicit voting roster. The caller must
 * supply verified weights, revocation state and key epochs; deriving a default
 * from electorate ids would silently discard those authority constraints.
 */
export function finalizeGovernanceRound(input: { round: GovernanceRound; events: readonly GovernanceVoteEvent[]; policy: PlanAdmissionPolicy; nowMs: number; members: readonly VotingMember[]; delegations?: readonly Delegation[] }): RoundResult<FinalizationCertificate> {
  if (!createGovernanceRound(input.round).ok || !validatePlanAdmissionPolicy(input.policy).ok ||
      !Number.isSafeInteger(input.nowMs) || input.nowMs < input.round.createdAtMs)
    return { ok: false, code: 'invalid-round', detail: 'a valid round, policy and finalization time are required' };
  const rebuilt = rebuildGovernanceRound(input.round, input.events);
  if (!rebuilt.ok) return rebuilt;
  if (!Array.isArray(input.members)) return { ok: false, code: 'unknown-member', detail: 'an explicit voting roster is required' };
  const members: readonly VotingMember[] = input.members;
  const rosterIds = new Set(members.map((m) => m.memberId));
  if (rosterIds.size !== members.length) return { ok: false, code: 'duplicate-member', detail: 'voting roster contains duplicate member ids' };
  const absent = input.round.eligibleMemberIds.find((id) => !rosterIds.has(id));
  if (absent != null || rosterIds.size !== input.round.eligibleMemberIds.length) return { ok: false, code: 'unknown-member', detail: 'the voting roster must equal the immutable round electorate' };

  const reduced = reduceGovernanceVotes({
    members,
    events: rebuilt.value.map((e) => ({ memberId: e.memberId, choice: e.choice, sequence: e.sequence, keyEpoch: e.keyEpoch ?? 0 })),
    delegations: input.delegations,
    nowMs: input.nowMs,
  });
  if (!reduced.ok) {
    return {
      ok: false,
      code: 'vote-reduction-refused',
      detail: `${reduced.code}: ${reduced.detail}`,
      refusal: {
        observed: { reducerCode: reduced.code, roundId: input.round.roundId, roster: String(members.length) },
        liftsWhen: 'the voting roster and ballots satisfy the weighted reducer (no revoked member voting, current key epochs, acyclic unexpired delegations, strictly advancing sequences, positive finite weights) and finalization is retried',
        whoCanMakeItTrue: ['owner', 'another-agent'],
      },
    };
  }
  const tally = reduced.value;

  const latest = new Map<string, PlanVote>();
  for (const e of rebuilt.value) latest.set(e.memberId, { memberId: e.memberId, choice: e.choice });
  const votes = [...latest.values()];
  const verdict = evaluatePlanAdmission(input.policy, { planRevisionHash: input.round.planRevisionHash, policyVersion: input.round.policyVersion, eligibleMemberIds: [...input.round.eligibleMemberIds], votes, ratifiedAtMs: input.round.createdAtMs }, input.nowMs);
  // Reuse policy epoch/window checks, then apply BOTH thresholds to the same
  // weighted electorate. Integer cross-products avoid rounding at a BPS boundary.
  const bindingValid = ['approved', 'quorum-not-met', 'approval-not-met'].includes(verdict.reason);
  const quorum = tally.totalEligibleWeight > 0 && BigInt(tally.participatingWeight) * 10_000n >= BigInt(tally.totalEligibleWeight) * BigInt(input.policy.quorumBps);
  const cast = tally.approveWeight + tally.rejectWeight;
  const approval = cast > 0 && tally.approveWeight > tally.rejectWeight &&
    BigInt(tally.approveWeight) * 10_000n >= BigInt(cast) * BigInt(input.policy.approvalBps);
  const admitted = bindingValid && quorum && approval;
  const reason = !bindingValid ? verdict.reason : !quorum ? 'weighted-quorum-not-met' : !approval ? 'weighted-approval-not-met' : 'approved';

  const base: Omit<FinalizationCertificate, 'certificateHash'> = { roundId: input.round.roundId, planRevisionHash: input.round.planRevisionHash, policyVersion: input.round.policyVersion,
    ...(input.round.approvedActionHash !== undefined ? { approvedActionHash: input.round.approvedActionHash } : {}),
    admitted, reason, voteEventIds: rebuilt.value.map((e) => e.eventId).sort(), finalizedAtMs: input.nowMs, tally };
  return { ok: true, value: { ...base, certificateHash: certificateHash(base) } };
}

/** Recompute a certificate's hash and compare: any field edited after finalization fails this. */
export function verifyFinalizationCertificate(cert: FinalizationCertificate): boolean {
  const { certificateHash: claimed, ...base } = cert;
  return typeof claimed === 'string' && claimed.length > 0 && certificateHash(base) === claimed;
}

export function rebuildGovernanceRound(round: GovernanceRound, events: readonly GovernanceVoteEvent[]): RoundResult<GovernanceVoteEvent[]> {
  let current: GovernanceVoteEvent[] = [];
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId))) {
    const result = appendGovernanceVote(round, current, event);
    if (!result.ok) return result;
    current = result.value;
  }
  return { ok: true, value: current };
}
