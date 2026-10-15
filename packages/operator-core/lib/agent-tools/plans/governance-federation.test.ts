import { describe, expect, it } from 'vitest';
import {
  appendGovernanceVote,
  createGovernanceRound,
  finalizeGovernanceRound,
  type FinalizationCertificate,
  type GovernanceRound,
  type GovernanceVoteEvent,
} from './governance-round';
import { DEFAULT_PLAN_ADMISSION_POLICY } from './plan-admission-policy';
import {
  ACCEPT_ALL_SIGNATURES_TEST_ONLY,
  admissibleCertificate,
  governanceEventDigest,
  ingestGovernanceEvents,
  projectGovernanceFederation,
  projectionDigest,
  resolveRoundControls,
  roundStatusAt,
  selectFederatableEvents,
  type FederatedGovernanceEvent,
  type GovernanceEventBody,
  type PotBoundary,
} from './governance-federation';
import { assertPlanAdmission, type AdmissionCertificate } from './plan-admission-enforcement';

const POT = 'pot-alpha';
const PEER_A = 'peer-a';
const PEER_B = 'peer-b';
const OUTSIDER = 'peer-outsider';

const shared: PotBoundary = { potId: POT, visibility: 'shared', memberPeerIds: [PEER_A, PEER_B] };
const priv: PotBoundary = { potId: POT, visibility: 'private', memberPeerIds: [PEER_A, PEER_B] };

/**
 * Ingest with signatures stubbed as valid. `ingestGovernanceEvents` REJECTS by
 * default, so every test whose subject is something other than signature checking
 * has to opt into acceptance explicitly — which is the point of the default.
 */
function ingestVerified(input: Omit<Parameters<typeof ingestGovernanceEvents>[0], 'verifySignature'>) {
  return ingestGovernanceEvents({ ...input, verifySignature: ACCEPT_ALL_SIGNATURES_TEST_ONLY });
}

let seq = 0;
function event(body: GovernanceEventBody, over: Partial<FederatedGovernanceEvent> = {}): FederatedGovernanceEvent {
  seq += 1;
  const base = { eventId: `evt-${seq}`, potId: POT, roundId: 'round-1', originPeerId: PEER_A, occurredAtMs: 1_000 + seq, body, ...over };
  return { ...base, signature: `sig-${governanceEventDigest(base).slice(0, 8)}` };
}

function buildRound(roundId: string, choices: readonly GovernanceVoteEvent['choice'][]): { round: GovernanceRound; votes: GovernanceVoteEvent[]; cert: FinalizationCertificate } {
  const memberIds = choices.map((_, i) => `member-${i}`);
  const created = createGovernanceRound({ roundId, planRevisionHash: `rev-${roundId}`, policyVersion: DEFAULT_PLAN_ADMISSION_POLICY.policyVersion, eligibleMemberIds: memberIds, createdAtMs: 1_000 });
  if (!created.ok) throw new Error(created.detail);
  let votes: GovernanceVoteEvent[] = [];
  choices.forEach((choice, i) => {
    const appended = appendGovernanceVote(created.value, votes, { eventId: `${roundId}-vote-${i}`, roundId, memberId: memberIds[i]!, choice, sequence: i, signature: `s-${i}` });
    if (!appended.ok) throw new Error(appended.detail);
    votes = appended.value;
  });
  const finalized = finalizeGovernanceRound({ round: created.value, events: votes,
    members: created.value.eligibleMemberIds.map(memberId => ({ memberId })), policy: DEFAULT_PLAN_ADMISSION_POLICY, nowMs: 2_000 });
  if (!finalized.ok) throw new Error(finalized.detail);
  return { round: created.value, votes, cert: finalized.value };
}

/** A ratified round-1: open + three approving votes + its certificate. */
function ratifiedRoundEvents(): { events: FederatedGovernanceEvent[]; cert: FinalizationCertificate } {
  const { round, votes, cert } = buildRound('round-1', ['approve', 'approve', 'approve']);
  return {
    cert,
    events: [event({ kind: 'round-open', round }), ...votes.map((vote) => event({ kind: 'vote', vote })), event({ kind: 'finalize', certificate: cert })],
  };
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  items.forEach((item, i) => {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([item, ...rest]);
  });
  return out;
}

describe('governance federation — immutable events and offline convergence', () => {
  it('projects a ratified round as finalized and admissible', () => {
    const { events, cert } = ratifiedRoundEvents();
    const projection = projectGovernanceFederation(POT, events);
    expect(projection.rounds.get('round-1')).toMatchObject({ status: 'finalized', roundOpened: true, paused: false });
    expect(admissibleCertificate(projection, 'round-1')?.certificateHash).toBe(cert.certificateHash);
  });

  it('converges on the same projection for every delivery order', () => {
    const { events } = ratifiedRoundEvents();
    const digests = new Set(permutations(events).map((order) => projectionDigest(projectGovernanceFederation(POT, order))));
    expect(events).toHaveLength(5);
    expect(permutations(events)).toHaveLength(120);
    expect(digests.size).toBe(1);
  });

  it('projectionDigest DISCRIMINATES — the convergence assertions above are not vacuous', () => {
    // Every convergence test asserts two digests are EQUAL, which a constant digest
    // would also satisfy. These pairs must differ, or none of those tests prove anything.
    const { events } = ratifiedRoundEvents();
    const finalized = projectGovernanceFederation(POT, events);
    const revoked = projectGovernanceFederation(POT, [...events, event({ kind: 'revoke', reason: 'r' }, { occurredAtMs: 5_000 })]);
    const paused = projectGovernanceFederation(POT, [...events, event({ kind: 'pause' }, { occurredAtMs: 5_000 })]);
    const partial = projectGovernanceFederation(POT, events.slice(0, 2));

    const digests = [finalized, revoked, paused, partial].map(projectionDigest);
    expect(new Set(digests).size).toBe(4);
  });

  it('converges when two offline replicas see disjoint halves and later merge', () => {
    const { events } = ratifiedRoundEvents();
    const left = events.filter((_, i) => i % 2 === 0);
    const right = events.filter((_, i) => i % 2 === 1);

    const mergedLeftFirst = ingestVerified({ boundary: shared, known: left, incoming: right });
    const mergedRightFirst = ingestVerified({ boundary: shared, known: right, incoming: left });
    expect(projectionDigest(mergedLeftFirst.projection)).toBe(projectionDigest(mergedRightFirst.projection));
    expect(projectionDigest(mergedLeftFirst.projection)).toBe(projectionDigest(projectGovernanceFederation(POT, events)));

    // A partial replica must NOT admit on its own — it has not seen the certificate.
    expect(admissibleCertificate(projectGovernanceFederation(POT, right), 'round-1')).toBeNull();
    expect(admissibleCertificate(mergedLeftFirst.projection, 'round-1')).not.toBeNull();
  });

  it('is idempotent on re-delivery and refuses to mutate an existing event id', () => {
    const { events } = ratifiedRoundEvents();
    const first = ingestVerified({ boundary: shared, known: [], incoming: events });
    expect(first.accepted).toHaveLength(events.length);
    expect(first.dropped).toEqual([]);

    const replay = ingestVerified({ boundary: shared, known: events, incoming: events });
    expect(replay.accepted).toEqual([]);
    expect(replay.dropped).toEqual([]);
    expect(projectionDigest(replay.projection)).toBe(projectionDigest(first.projection));

    const mutated: FederatedGovernanceEvent = { ...events[0]!, occurredAtMs: 9_999 };
    const conflict = ingestVerified({ boundary: shared, known: events, incoming: [mutated] });
    expect(conflict.dropped).toMatchObject([{ eventId: events[0]!.eventId, reason: 'immutable-conflict' }]);
    expect(projectionDigest(conflict.projection)).toBe(projectionDigest(first.projection));
  });

  it('drops events whose signature does not verify', () => {
    const { events } = ratifiedRoundEvents();
    const result = ingestGovernanceEvents({ boundary: shared, known: [], incoming: events, verifySignature: (e) => e.body.kind !== 'finalize' });
    expect(result.dropped).toMatchObject([{ reason: 'unverified-signature' }]);
    expect(admissibleCertificate(result.projection, 'round-1')).toBeNull();
  });
});

describe('governance federation — conflicting finalizations are quarantined', () => {
  it('quarantines a round with two different certificates and never picks a winner', () => {
    const { events, cert } = ratifiedRoundEvents();
    const rival = buildRound('round-1', ['approve', 'approve', 'approve', 'approve']).cert;
    expect(rival.certificateHash).not.toBe(cert.certificateHash);

    const forked = [...events, event({ kind: 'finalize', certificate: rival })];
    const projection = projectGovernanceFederation(POT, forked);
    const round = projection.rounds.get('round-1');
    expect(round).toMatchObject({ status: 'quarantined' });
    expect(round?.certificates).toHaveLength(2);
    expect(round?.quarantineReason).toContain('conflicting finalizations');
    expect(admissibleCertificate(projection, 'round-1')).toBeNull();
  });

  it('quarantines regardless of which fork arrives first', () => {
    const { events, cert } = ratifiedRoundEvents();
    const rival = buildRound('round-1', ['approve', 'approve', 'approve', 'approve']).cert;
    const rivalEvent = event({ kind: 'finalize', certificate: rival });
    const a = projectGovernanceFederation(POT, [...events, rivalEvent]);
    const b = projectGovernanceFederation(POT, [rivalEvent, ...events]);
    expect(projectionDigest(a)).toBe(projectionDigest(b));
    expect(a.rounds.get('round-1')?.status).toBe('quarantined');
    expect(a.rounds.get('round-1')?.certificates.map((c) => c.certificateHash).sort()).toEqual([cert.certificateHash, rival.certificateHash].sort());
  });

  it('treats a re-sent identical certificate as one finalization, not a fork', () => {
    const { events, cert } = ratifiedRoundEvents();
    const duplicate = event({ kind: 'finalize', certificate: cert });
    const projection = projectGovernanceFederation(POT, [...events, duplicate]);
    expect(projection.rounds.get('round-1')).toMatchObject({ status: 'finalized' });
    expect(projection.rounds.get('round-1')?.certificates).toHaveLength(1);
  });
});

describe('governance federation — pause and revoke', () => {
  it('stops a paused round from admitting, even when the certificate arrives later', () => {
    const { round, votes, cert } = buildRound('round-1', ['approve', 'approve', 'approve']);
    const paused = projectGovernanceFederation(POT, [
      event({ kind: 'round-open', round }),
      ...votes.map((vote) => event({ kind: 'vote', vote })),
      event({ kind: 'pause' }, { occurredAtMs: 5_000 }),
      event({ kind: 'finalize', certificate: cert }, { occurredAtMs: 6_000 }),
    ]);
    expect(paused.rounds.get('round-1')).toMatchObject({ status: 'paused', paused: true });
    expect(admissibleCertificate(paused, 'round-1')).toBeNull();
  });

  it('re-admits after a resume', () => {
    const { events } = ratifiedRoundEvents();
    const resumed = projectGovernanceFederation(POT, [
      ...events,
      event({ kind: 'pause' }, { occurredAtMs: 5_000 }),
      event({ kind: 'resume' }, { occurredAtMs: 6_000 }),
    ]);
    expect(resumed.rounds.get('round-1')).toMatchObject({ status: 'finalized', paused: false });
    expect(admissibleCertificate(resumed, 'round-1')).not.toBeNull();
  });

  it('makes revoke terminal — a later resume cannot resurrect a revoked round', () => {
    const { events } = ratifiedRoundEvents();
    const revoked = projectGovernanceFederation(POT, [
      ...events,
      event({ kind: 'revoke', reason: 'policy breach' }, { occurredAtMs: 5_000 }),
      event({ kind: 'resume' }, { occurredAtMs: 6_000 }),
      event({ kind: 'finalize', certificate: ratifiedRoundEvents().cert }, { occurredAtMs: 7_000 }),
    ]);
    expect(revoked.rounds.get('round-1')).toMatchObject({ status: 'revoked', revokedReason: 'policy breach' });
    expect(admissibleCertificate(revoked, 'round-1')).toBeNull();
  });

  it('revokes deterministically whatever order the control events arrive in', () => {
    const { events } = ratifiedRoundEvents();
    const revoke = event({ kind: 'revoke', reason: 'policy breach' }, { occurredAtMs: 5_000 });
    const resume = event({ kind: 'resume' }, { occurredAtMs: 6_000 });
    const a = projectGovernanceFederation(POT, [...events, revoke, resume]);
    const b = projectGovernanceFederation(POT, [resume, revoke, ...events]);
    expect(projectionDigest(a)).toBe(projectionDigest(b));
    expect(a.rounds.get('round-1')?.status).toBe('revoked');
  });
});

describe('governance federation — signature verification fails closed', () => {
  it('drops EVERY event when no verifier is injected, and admits nothing', () => {
    // The default is REJECT. A caller that forgets to wire a verifier gets an empty
    // projection and a full `dropped` list — loud — rather than a projection silently
    // built from unauthenticated events.
    const { events } = ratifiedRoundEvents();
    const result = ingestGovernanceEvents({ boundary: shared, known: [], incoming: events });
    expect(result.accepted).toEqual([]);
    expect(result.dropped).toHaveLength(events.length);
    expect(result.dropped.every((d) => d.reason === 'unverified-signature')).toBe(true);
    expect(result.projection.eventCount).toBe(0);
    expect(admissibleCertificate(result.projection, 'round-1')).toBeNull();
  });

  it('accepts only under an explicit opt-in — the two defaults are not the same code path', () => {
    const { events } = ratifiedRoundEvents();
    const closed = ingestGovernanceEvents({ boundary: shared, known: [], incoming: events });
    const opened = ingestGovernanceEvents({ boundary: shared, known: [], incoming: events, verifySignature: ACCEPT_ALL_SIGNATURES_TEST_ONLY });
    // Discriminating control: if the default had stayed accept-all these two would be
    // identical and the assertion above would pass while proving nothing.
    expect(projectionDigest(closed.projection)).not.toBe(projectionDigest(opened.projection));
    expect(admissibleCertificate(opened.projection, 'round-1')).not.toBeNull();
  });
});

describe('governance federation — a time-bounded pause expires', () => {
  const pausedUntil = (expiresAtMs: number | undefined) => {
    const { events } = ratifiedRoundEvents();
    return projectGovernanceFederation(POT, [...events, event({ kind: 'pause', expiresAtMs }, { occurredAtMs: 5_000 })]);
  };

  it('holds until its expiry, then lapses back to the underlying status', () => {
    const projection = pausedUntil(9_000);
    const round = projection.rounds.get('round-1')!;
    expect(round).toMatchObject({ status: 'paused', paused: true, pausedUntilMs: 9_000 });

    expect(roundStatusAt(round, 8_999)).toBe('paused');
    expect(roundStatusAt(round, 9_000)).toBe('finalized');
    expect(admissibleCertificate(projection, 'round-1', 8_999)).toBeNull();
    expect(admissibleCertificate(projection, 'round-1', 9_000)).not.toBeNull();
  });

  it('never expires when the pause is unbounded', () => {
    const projection = pausedUntil(undefined);
    const round = projection.rounds.get('round-1')!;
    expect(round.pausedUntilMs).toBeNull();
    expect(roundStatusAt(round, Number.MAX_SAFE_INTEGER)).toBe('paused');
    expect(admissibleCertificate(projection, 'round-1', Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it('omitting nowMs keeps the conservative reading — a clockless caller is never admitted by expiry', () => {
    const projection = pausedUntil(9_000);
    expect(admissibleCertificate(projection, 'round-1')).toBeNull();
  });

  it('keeps the fold time-free — the projection of the same events is identical whatever the clock', () => {
    // Expiry is applied by roundStatusAt, never inside the fold, so two replicas with
    // different clocks still converge on one digest. If expiry leaked into the fold,
    // convergence would silently become clock-dependent.
    const { events } = ratifiedRoundEvents();
    const pause = event({ kind: 'pause', expiresAtMs: 9_000 }, { occurredAtMs: 5_000 });
    expect(projectionDigest(projectGovernanceFederation(POT, [...events, pause]))).toBe(projectionDigest(projectGovernanceFederation(POT, [pause, ...events])));
    // …and pausedUntilMs is part of that identity, so two differently-bounded pauses do not collide.
    const other = event({ kind: 'pause', expiresAtMs: 12_000 }, { occurredAtMs: 5_000, eventId: pause.eventId });
    expect(projectionDigest(projectGovernanceFederation(POT, [...events, pause]))).not.toBe(projectionDigest(projectGovernanceFederation(POT, [...events, other])));
  });
});

describe('governance federation — controls reach the admission door (P-004 × P-005)', () => {
  const admissionInput = (cert: FinalizationCertificate, projection: ReturnType<typeof projectGovernanceFederation>, nowMs: number) => {
    const admission: AdmissionCertificate = { planRevisionHash: cert.planRevisionHash, policyVersion: cert.policyVersion, admitted: cert.admitted, expiresAtMs: 1_000_000, certificateHash: cert.certificateHash };
    return { door: 'start', planRevisionHash: cert.planRevisionHash, policyVersion: cert.policyVersion, certificate: admission, governance: resolveRoundControls(projection, cert.roundId, nowMs), nowMs };
  };

  it('refuses a paused round at the door and admits once the pause expires', () => {
    const { events, cert } = ratifiedRoundEvents();
    const projection = projectGovernanceFederation(POT, [...events, event({ kind: 'pause', expiresAtMs: 9_000 }, { occurredAtMs: 5_000 })]);
    expect(assertPlanAdmission(admissionInput(cert, projection, 8_000))).toMatchObject({ ok: false, code: 'plan-paused' });
    expect(assertPlanAdmission(admissionInput(cert, projection, 9_500))).toMatchObject({ ok: true, door: 'start' });
  });

  it('refuses a revoked round at the door, terminally', () => {
    const { events, cert } = ratifiedRoundEvents();
    const projection = projectGovernanceFederation(POT, [
      ...events,
      event({ kind: 'revoke', reason: 'policy breach' }, { occurredAtMs: 5_000 }),
      event({ kind: 'resume' }, { occurredAtMs: 6_000 }),
    ]);
    expect(assertPlanAdmission(admissionInput(cert, projection, 9_999_999))).toMatchObject({ ok: false, code: 'plan-revoked' });
  });

  it('refuses a quarantined round, and admits the recomputed round that replaces it', () => {
    const { events, cert } = ratifiedRoundEvents();
    const rival = buildRound('round-1', ['approve', 'approve', 'approve', 'approve']).cert;
    const forked = projectGovernanceFederation(POT, [...events, event({ kind: 'finalize', certificate: rival }, { occurredAtMs: 5_000 })]);
    expect(assertPlanAdmission(admissionInput(cert, forked, 6_000))).toMatchObject({ ok: false, code: 'round-quarantined' });

    // Recomputation is a NEW round, never an edit of the forked one: the conflicting
    // certificates are immutable, so round-1 stays quarantined forever by construction.
    const recomputed = buildRound('round-2', ['approve', 'approve', 'approve']);
    const withRound2 = projectGovernanceFederation(POT, [
      ...events,
      event({ kind: 'finalize', certificate: rival }, { occurredAtMs: 5_000 }),
      event({ kind: 'round-open', round: recomputed.round }, { roundId: 'round-2', occurredAtMs: 7_000 }),
      ...recomputed.votes.map((vote) => event({ kind: 'vote', vote }, { roundId: 'round-2', occurredAtMs: 7_500 })),
      event({ kind: 'finalize', certificate: recomputed.cert }, { roundId: 'round-2', occurredAtMs: 8_000 }),
    ]);
    expect(withRound2.rounds.get('round-1')?.status).toBe('quarantined');
    expect(assertPlanAdmission(admissionInput(recomputed.cert, withRound2, 9_000))).toMatchObject({ ok: true, door: 'start' });
  });

  it('returns null controls for a round this projection has never seen', () => {
    const { events } = ratifiedRoundEvents();
    expect(resolveRoundControls(projectGovernanceFederation(POT, events), 'round-absent', 1_000)).toBeNull();
  });
});

describe('governance federation — private-pot boundaries', () => {
  it('drops events belonging to another pot', () => {
    const { events } = ratifiedRoundEvents();
    const foreign = event({ kind: 'pause' }, { potId: 'pot-beta' });
    const result = ingestVerified({ boundary: shared, known: [], incoming: [...events, foreign] });
    expect(result.dropped).toMatchObject([{ eventId: foreign.eventId, reason: 'foreign-pot' }]);
    expect(result.projection.eventCount).toBe(events.length);
  });

  it('drops non-member peers inbound for a private pot but accepts them for a shared one', () => {
    const outsider = event({ kind: 'pause' }, { originPeerId: OUTSIDER });
    expect(ingestVerified({ boundary: priv, known: [], incoming: [outsider] }).dropped).toMatchObject([
      { eventId: outsider.eventId, reason: 'non-member-peer' },
    ]);
    expect(ingestVerified({ boundary: shared, known: [], incoming: [outsider] }).dropped).toEqual([]);
  });

  it('emits nothing outbound to a non-member of a private pot', () => {
    const { events } = ratifiedRoundEvents();
    expect(selectFederatableEvents({ boundary: priv, events, toPeerId: OUTSIDER })).toEqual([]);
    expect(selectFederatableEvents({ boundary: priv, events, toPeerId: PEER_B })).toHaveLength(events.length);
    // A shared pot has no such restriction — this is what makes the private case a real boundary.
    expect(selectFederatableEvents({ boundary: shared, events, toPeerId: OUTSIDER })).toHaveLength(events.length);
  });

  it('never emits a foreign pot’s events outbound, whatever the visibility', () => {
    const { events } = ratifiedRoundEvents();
    const foreign = event({ kind: 'pause' }, { potId: 'pot-beta' });
    for (const boundary of [priv, shared]) {
      const selected = selectFederatableEvents({ boundary, events: [...events, foreign], toPeerId: PEER_B });
      expect(selected.some((e) => e.potId !== POT)).toBe(false);
      expect(selected).toHaveLength(events.length);
    }
  });
});
