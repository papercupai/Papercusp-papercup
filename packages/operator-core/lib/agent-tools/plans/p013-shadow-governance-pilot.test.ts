/**
 * p013-shadow-governance-pilot — P-013, plan shared-pot-dao-cupboard-v1-2026-09-04.
 *
 * THE SHADOW GOVERNANCE PILOT. P-013 reads "run shadow governance rounds, pilot one
 * shared pot and a small creator cohort, measure submission/publish/purchase/install
 * success, and activate enforcement only after evidence." Per D-033 there are no
 * users, so the cohort is synthetic actors driving the REAL modules, and "measure"
 * means a reproducible per-leg count — this file — not a human trial.
 *
 * HISTORICAL BASELINE. This file preserves what P-013 measured before P-037 wired
 * the production certificate source. Current production coverage lives in
 * `plan-admission-certificate-source.test.ts`; the no-producer legs below install
 * an explicit null-returning source so this artifact remains reproducible instead
 * of accidentally changing meaning as production wiring evolves.
 *
 * WHAT THIS PILOT FOUND AT THE TIME, and why it answered "activate enforcement
 * only after evidence":
 *
 *   ENFORCEMENT COULD NOT BE ACTIVATED WHEN P-013 RAN. The two halves of the gate
 *   were wired
 *   asymmetrically. The POLICY half is real: `defaultPolicySource` reads a pot's
 *   owner-signed `governance.planAdmission` out of the live hive policy, so any pot
 *   could switch the section on. The CERTIFICATE half had no producer at all —
 *   `configurePlanAdmissionCertificateSource` has zero non-test call sites in the
 *   repository, so `state.certificateSource` is permanently null in production and
 *   the gate resolves `{ certificate: null }` for every door.
 *
 *   The consequence is measured in LEG 3 below: the moment a real pot sets the
 *   policy section, EVERY plan lifecycle door — start, status, promotion, scheduled,
 *   run-now, autostart, fleet-launch — refuses `missing-certificate`. Not some
 *   doors, and not intermittently. That is correct fail-closed behaviour reached by
 *   a missing bridge rather than by a governance decision.
 *
 *   Both sides of that bridge WORK, which is what makes it a bridge and not a hole:
 *   LEG 1 drives a real round to a verified FinalizationCertificate, LEG 2 federates
 *   it and projects an admissible certificate, and LEG 4 shows that supplying the
 *   one adapter between them opens every door. The gap is exactly one conversion
 *   from `FinalizationCertificate` to `AdmissionCertificate`.
 *
 * So the pilot's historical verdict was: leave enforcement OFF (it would brick
 * every door), and run `mode: 'shadow'` meanwhile. P-037 supersedes that operational
 * verdict by providing the durable source while retaining this baseline as evidence.
 *
 * NOT MEASURED HERE, ON PURPOSE. The cupboard legs P-013 also names — submission,
 * publish, purchase, install, refund — are already exercised by committed suites
 * (creator-drafts, review, listings, browse-listings, entitled-delivery,
 * commerce-door-journeys, install-blueprint-core). Re-implementing synthetic
 * journeys beside them would fork a peer's in-flight harness to measure what is
 * already measured. `CUPBOARD_LEG_COVERAGE` below cites the owning suite per leg
 * instead; the completion note carries the same disclosure.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkPlanAdmission,
  configurePlanAdmissionCertificateSource,
  configurePlanAdmissionPolicySource,
  configurePlanAdmissionShadowSink,
  type PlanAdmissionShadowObservation,
} from './plan-admission-gate';
import { PLAN_ADMISSION_DOORS, type AdmissionCertificate, type AdmissionRefusalCode, type PlanAdmissionDoor } from './plan-admission-enforcement';
import type { PlanAdmissionPolicy } from './plan-admission-policy';
import {
  appendGovernanceVote,
  createGovernanceRound,
  finalizeGovernanceRound,
  verifyFinalizationCertificate,
  type FinalizationCertificate,
  type GovernanceRound,
  type GovernanceVoteEvent,
} from './governance-round';
import {
  ACCEPT_ALL_SIGNATURES_TEST_ONLY,
  admissibleCertificate,
  ingestGovernanceEvents,
  resolveRoundControls,
  type FederatedGovernanceEvent,
  type GovernanceEventBody,
  type PotBoundary,
} from './governance-federation';
import type { PlanRow } from './source';

// ---------------------------------------------------------------------------
// The pilot pot: one shared pot, a synthetic cohort of five voting members.
// ---------------------------------------------------------------------------

const POT_ID = 'pilot-pot';
const PLAN_SLUG = 'pilot-pot-plan';
const ROUND_ID = 'round-p013-1';
const REVISION = 'rev-pilot-1';
const NOW = 1_700_000_000_000;

/** Five synthetic members — enough that quorum and approval are distinct thresholds. */
const COHORT = ['member-a', 'member-b', 'member-c', 'member-d', 'member-e'] as const;

const POLICY: PlanAdmissionPolicy = Object.freeze({
  policyVersion: 7,
  quorumBps: 5_000, // 3 of 5 participating clears it
  approvalBps: 6_667, // 2 of 3 cast votes clears it
  ratificationWindowSec: 3_600,
  materiality: Object.freeze({ maxChangedLines: 200, maxChangedItems: 3 }),
});

/** The same policy the pilot recommends running instead — identical but observing. */
const SHADOW_POLICY: PlanAdmissionPolicy = Object.freeze({ ...POLICY, mode: 'shadow' as const });

const rowWith = (contentHash: string) => ({ contentHash }) as unknown as PlanRow;

const BOUNDARY: PotBoundary = Object.freeze({
  potId: POT_ID,
  visibility: 'shared',
  memberPeerIds: Object.freeze(['peer-1', 'peer-2']) as unknown as readonly string[],
});

const federated = (eventId: string, body: GovernanceEventBody, over: Partial<FederatedGovernanceEvent> = {}): FederatedGovernanceEvent => ({
  eventId,
  potId: POT_ID,
  roundId: ROUND_ID,
  originPeerId: 'peer-1',
  occurredAtMs: NOW,
  body,
  signature: `sig-${eventId}`,
  ...over,
});

/**
 * Run one full round with the cohort's ballots, through the real reducer.
 * Returns the round, its accepted vote events, and the finalization certificate.
 */
function runRound(choices: readonly GovernanceVoteEvent['choice'][]): {
  round: GovernanceRound;
  events: readonly GovernanceVoteEvent[];
  certificate: FinalizationCertificate;
} {
  const created = createGovernanceRound({
    roundId: ROUND_ID,
    planRevisionHash: REVISION,
    policyVersion: POLICY.policyVersion,
    eligibleMemberIds: [...COHORT],
    createdAtMs: NOW,
  });
  if (!created.ok) throw new Error(`round did not open: ${created.code} ${created.detail}`);

  let events: GovernanceVoteEvent[] = [];
  choices.forEach((choice, index) => {
    const appended = appendGovernanceVote(created.value, events, {
      eventId: `vote-${index}`,
      roundId: ROUND_ID,
      memberId: COHORT[index],
      choice,
      sequence: index + 1,
      signature: `sig-vote-${index}`,
    });
    if (!appended.ok) throw new Error(`ballot ${index} refused: ${appended.code} ${appended.detail}`);
    events = appended.value;
  });

  const finalized = finalizeGovernanceRound({ round: created.value, events,
    members: created.value.eligibleMemberIds.map(memberId => ({ memberId })), policy: POLICY, nowMs: NOW });
  if (!finalized.ok) throw new Error(`finalize refused: ${finalized.code} ${finalized.detail}`);
  return { round: created.value, events, certificate: finalized.value };
}

/**
 * The bridge as it existed in the P-013 pilot.
 *
 * Production now owns the equivalent conversion in
 * `plan-admission-certificate-source.ts`. This local copy remains deliberately
 * unexported so the historical pilot can prove its original gap without depending
 * on the later implementation that closed it.
 */
const bridgeToAdmissionCertificate = (cert: FinalizationCertificate, policy: PlanAdmissionPolicy): AdmissionCertificate => ({
  planRevisionHash: cert.planRevisionHash,
  policyVersion: cert.policyVersion,
  admitted: cert.admitted,
  expiresAtMs: cert.finalizedAtMs + policy.ratificationWindowSec * 1000,
  certificateHash: cert.certificateHash,
});

// ---------------------------------------------------------------------------
// Metrics. Every leg records attempts and outcomes into ONE ledger, which is
// asserted against and then emitted — so the artifact cannot claim a leg the
// suite did not actually run.
// ---------------------------------------------------------------------------

interface LegMetrics {
  attempted: number;
  succeeded: number;
  refused: number;
  refusalCodes: Record<string, number>;
}

const METRICS: Record<string, LegMetrics> = {};

function record(leg: string, outcome: { ok: true } | { ok: false; code: string }): void {
  const entry = (METRICS[leg] ??= { attempted: 0, succeeded: 0, refused: 0, refusalCodes: {} });
  entry.attempted += 1;
  if (outcome.ok) entry.succeeded += 1;
  else {
    entry.refused += 1;
    entry.refusalCodes[outcome.code] = (entry.refusalCodes[outcome.code] ?? 0) + 1;
  }
}

/** Drive one door and fold the verdict into the ledger. */
async function driveDoor(leg: string, door: PlanAdmissionDoor, revision = REVISION): Promise<AdmissionRefusalCode | 'admitted' | 'skipped'> {
  const verdict = await checkPlanAdmission({ slug: PLAN_SLUG, door, row: rowWith(revision), nowMs: NOW });
  if (!verdict.admitted) {
    record(leg, { ok: false, code: verdict.refusal.code });
    return verdict.refusal.code;
  }
  record(leg, { ok: true });
  return verdict.skipped ? 'skipped' : 'admitted';
}

/**
 * The cupboard legs P-013 names, mapped to the committed suite that already
 * measures each. Cited rather than re-implemented — see the module header.
 */
const CUPBOARD_LEG_COVERAGE: Readonly<Record<string, string>> = Object.freeze({
  submission: 'apps/operator-public/src/__tests__/creator-drafts.test.ts',
  review: 'apps/operator-public/src/__tests__/review.test.ts',
  publish: 'apps/operator-public/src/__tests__/listings.test.ts',
  browse: 'packages/operator-core/lib/cupboard/browse-listings.test.ts',
  purchase: 'packages/operator-core/lib/cupboard/commerce-door-journeys.test.ts',
  refund: 'packages/operator-core/lib/cupboard/commerce-door-journeys.test.ts',
  delivery: 'packages/operator-core/lib/cupboard/entitled-delivery.test.ts',
  'install-free': 'packages/operator-core/lib/cupboard/install-blueprint-core.test.ts',
  'install-paid': 'packages/operator-core/lib/cupboard/commerce-door-journeys.test.ts (D-048 wall: refused, no release chain)',
});

afterEach(() => {
  configurePlanAdmissionPolicySource(null);
  configurePlanAdmissionCertificateSource(null);
  configurePlanAdmissionShadowSink(null);
});

// ---------------------------------------------------------------------------

describe('P-013 LEG 1 — a real governance round, driven by the synthetic cohort', () => {
  it('opens, takes five ballots, and finalizes into a verifiable certificate', () => {
    const { certificate } = runRound(['approve', 'approve', 'approve', 'approve', 'approve']);

    expect(certificate.admitted).toBe(true);
    expect(certificate.roundId).toBe(ROUND_ID);
    expect(certificate.planRevisionHash).toBe(REVISION);
    expect(certificate.voteEventIds).toHaveLength(COHORT.length);
    // The tally is covered by certificateHash, so a certificate cannot be
    // re-attributed to a tally it did not come from.
    expect(certificate.tally).toBeTruthy();
    expect(verifyFinalizationCertificate(certificate)).toBe(true);
    record('governance-round', { ok: true });
  });

  it('a round the cohort REJECTS finalizes as not-admitted, rather than failing to finalize', () => {
    // The distinction matters for the pilot's counts: a rejected plan is a
    // successful round with a negative verdict, not a broken round.
    const { certificate } = runRound(['reject', 'reject', 'reject', 'approve', 'approve']);
    expect(certificate.admitted).toBe(false);
    expect(verifyFinalizationCertificate(certificate)).toBe(true);
    record('governance-round', { ok: true });
  });
});

describe('P-013 LEG 2 — federation projects the round, and quarantines a conflict', () => {
  it('ingests round-open + ballots + finalize, and yields an admissible certificate', () => {
    const { round, events, certificate } = runRound(['approve', 'approve', 'approve', 'approve', 'approve']);
    const incoming = [
      federated('ev-open', { kind: 'round-open', round }),
      ...events.map((vote, i) => federated(`ev-vote-${i}`, { kind: 'vote', vote })),
      federated('ev-final', { kind: 'finalize', certificate }),
    ];

    const result = ingestGovernanceEvents({ boundary: BOUNDARY, known: [], incoming, verifySignature: ACCEPT_ALL_SIGNATURES_TEST_ONLY });

    expect(result.dropped).toEqual([]);
    expect(result.accepted).toHaveLength(incoming.length);
    const controls = resolveRoundControls(result.projection, ROUND_ID, NOW);
    expect(controls?.status).toBe('finalized');
    expect(admissibleCertificate(result.projection, ROUND_ID, NOW)?.certificateHash).toBe(certificate.certificateHash);
    record('federation', { ok: true });
  });

  it('TWO conflicting finalizations quarantine the round instead of picking a winner', () => {
    const { round, events, certificate } = runRound(['approve', 'approve', 'approve', 'approve', 'approve']);
    // A second, contradictory certificate for the SAME round — the federation case
    // the brief names. Picking either one would let a peer decide admission by
    // racing; quarantine refuses both and says why.
    const conflicting: FinalizationCertificate = { ...certificate, admitted: false, reason: 'conflicting peer view', certificateHash: `${certificate.certificateHash}-alt` };
    const incoming = [
      federated('ev-open', { kind: 'round-open', round }),
      ...events.map((vote, i) => federated(`ev-vote-${i}`, { kind: 'vote', vote })),
      federated('ev-final-a', { kind: 'finalize', certificate }),
      federated('ev-final-b', { kind: 'finalize', certificate: conflicting }, { originPeerId: 'peer-2' }),
    ];

    const result = ingestGovernanceEvents({ boundary: BOUNDARY, known: [], incoming, verifySignature: ACCEPT_ALL_SIGNATURES_TEST_ONLY });
    const controls = resolveRoundControls(result.projection, ROUND_ID, NOW);

    expect(controls?.status).toBe('quarantined');
    expect(controls?.quarantineReason).toContain('conflicting finalizations');
    expect(admissibleCertificate(result.projection, ROUND_ID, NOW)).toBeNull();
    record('federation', { ok: false, code: 'round-quarantined' });
  });

  it('an event from ANOTHER pot is dropped at the boundary, not merged', () => {
    const { round } = runRound(['approve', 'approve', 'approve', 'approve', 'approve']);
    const result = ingestGovernanceEvents({
      boundary: BOUNDARY,
      known: [],
      incoming: [federated('ev-foreign', { kind: 'round-open', round }, { potId: 'some-other-pot' })],
      verifySignature: ACCEPT_ALL_SIGNATURES_TEST_ONLY,
    });
    expect(result.dropped.map((d) => d.reason)).toEqual(['foreign-pot']);
    record('federation', { ok: false, code: 'foreign-pot' });
  });

  it('the DEFAULT signature verifier rejects everything — federation fails closed', () => {
    // Omitting the verifier is the shape that would otherwise fail open silently.
    const { round } = runRound(['approve', 'approve', 'approve', 'approve', 'approve']);
    const result = ingestGovernanceEvents({ boundary: BOUNDARY, known: [], incoming: [federated('ev-open', { kind: 'round-open', round })] });
    expect(result.dropped.map((d) => d.reason)).toEqual(['unverified-signature']);
    record('federation', { ok: false, code: 'unverified-signature' });
  });
});

describe('P-013 LEG 3 — HISTORICAL WALL: the pre-P-037 build had no certificate producer', () => {
  it('with the policy set and the historical null source, EVERY door refuses missing-certificate', async () => {
    // Reproduces the pre-P-037 build explicitly. `null` now restores the production
    // source, so the historical no-producer state must be installed as a real
    // override rather than inferred from current module defaults.
    configurePlanAdmissionPolicySource(async () => POLICY);
    configurePlanAdmissionCertificateSource({
      resolve: async () => ({ certificate: null, governance: null }),
    });

    const outcomes = await Promise.all(PLAN_ADMISSION_DOORS.map((door) => driveDoor('enforce-production-wiring', door)));

    // Not "some doors" and not "intermittently" — the whole plan lifecycle.
    expect(outcomes).toEqual(PLAN_ADMISSION_DOORS.map(() => 'missing-certificate'));
    expect(METRICS['enforce-production-wiring'].succeeded).toBe(0);
    expect(METRICS['enforce-production-wiring'].refused).toBe(PLAN_ADMISSION_DOORS.length);
  });

  it('CONTROL: the same doors pass through when the pot has NO policy section', async () => {
    // Proves the refusals above are caused by the policy being SET, not by the
    // fixture being broken — and pins the pass-through the brief asks for: a pot
    // that never opted in is unaffected by any of this.
    configurePlanAdmissionPolicySource(async () => null);
    const outcomes = await Promise.all(PLAN_ADMISSION_DOORS.map((door) => driveDoor('no-policy-passthrough', door)));
    expect(outcomes).toEqual(PLAN_ADMISSION_DOORS.map(() => 'skipped'));
    expect(METRICS['no-policy-passthrough'].refused).toBe(0);
  });
});

describe('P-013 LEG 4 — the gap is exactly one adapter wide', () => {
  it('supplying the missing FinalizationCertificate→AdmissionCertificate bridge opens every door', async () => {
    // Same policy, same doors, same instant as LEG 3. The ONLY difference is that a
    // certificate source exists and converts the round's real certificate. If this
    // passes while LEG 3 refuses, the missing piece is the conversion and nothing else.
    const { round, events, certificate } = runRound(['approve', 'approve', 'approve', 'approve', 'approve']);
    const ingested = ingestGovernanceEvents({
      boundary: BOUNDARY,
      known: [],
      incoming: [
        federated('ev-open', { kind: 'round-open', round }),
        ...events.map((vote, i) => federated(`ev-vote-${i}`, { kind: 'vote', vote })),
        federated('ev-final', { kind: 'finalize', certificate }),
      ],
      verifySignature: ACCEPT_ALL_SIGNATURES_TEST_ONLY,
    });
    const admissible = admissibleCertificate(ingested.projection, ROUND_ID, NOW);
    expect(admissible).not.toBeNull();
    if (!admissible) return;

    configurePlanAdmissionPolicySource(async () => POLICY);
    configurePlanAdmissionCertificateSource({
      resolve: async () => ({ certificate: bridgeToAdmissionCertificate(admissible, POLICY), governance: resolveRoundControls(ingested.projection, ROUND_ID, NOW) }),
    });

    const outcomes = await Promise.all(PLAN_ADMISSION_DOORS.map((door) => driveDoor('enforce-with-bridge', door)));
    expect(outcomes).toEqual(PLAN_ADMISSION_DOORS.map(() => 'admitted'));
    expect(METRICS['enforce-with-bridge'].refused).toBe(0);
  });

  it('and it still fails closed on a revision the cohort never ratified', async () => {
    // The bridge must not become a rubber stamp: a plan edited after ratification
    // is exactly what the gate exists to catch.
    const { round, events, certificate } = runRound(['approve', 'approve', 'approve', 'approve', 'approve']);
    const ingested = ingestGovernanceEvents({
      boundary: BOUNDARY,
      known: [],
      incoming: [
        federated('ev-open', { kind: 'round-open', round }),
        ...events.map((vote, i) => federated(`ev-vote-${i}`, { kind: 'vote', vote })),
        federated('ev-final', { kind: 'finalize', certificate }),
      ],
      verifySignature: ACCEPT_ALL_SIGNATURES_TEST_ONLY,
    });
    const admissible = admissibleCertificate(ingested.projection, ROUND_ID, NOW);
    if (!admissible) throw new Error('fixture: expected an admissible certificate');

    configurePlanAdmissionPolicySource(async () => POLICY);
    configurePlanAdmissionCertificateSource({ resolve: async () => ({ certificate: bridgeToAdmissionCertificate(admissible, POLICY), governance: null }) });

    expect(await driveDoor('enforce-with-bridge-moved-revision', 'start', 'rev-edited-after-ratification')).toBe('revision-mismatch');
  });
});

describe('P-013 LEG 5 — owner controls refuse through the gate', () => {
  const withControls = async (leg: string, body: GovernanceEventBody, expected: AdmissionRefusalCode) => {
    const { round, events, certificate } = runRound(['approve', 'approve', 'approve', 'approve', 'approve']);
    const ingested = ingestGovernanceEvents({
      boundary: BOUNDARY,
      known: [],
      incoming: [
        federated('ev-open', { kind: 'round-open', round }),
        ...events.map((vote, i) => federated(`ev-vote-${i}`, { kind: 'vote', vote })),
        federated('ev-final', { kind: 'finalize', certificate }),
        federated('ev-control', body),
      ],
      verifySignature: ACCEPT_ALL_SIGNATURES_TEST_ONLY,
    });
    const admissible = admissibleCertificate(ingested.projection, ROUND_ID, NOW);
    configurePlanAdmissionPolicySource(async () => POLICY);
    configurePlanAdmissionCertificateSource({
      resolve: async () => ({
        // A pause or revoke must refuse even when a valid certificate exists —
        // otherwise the control is advisory.
        certificate: admissible ? bridgeToAdmissionCertificate(admissible, POLICY) : bridgeToAdmissionCertificate(certificate, POLICY),
        governance: resolveRoundControls(ingested.projection, ROUND_ID, NOW),
      }),
    });
    expect(await driveDoor(leg, 'start')).toBe(expected);
  };

  it('an owner-signed pause refuses plan-paused', async () => {
    await withControls('owner-control-pause', { kind: 'pause' }, 'plan-paused');
  });

  it('a revoke refuses plan-revoked, and outranks the certificate', async () => {
    await withControls('owner-control-revoke', { kind: 'revoke', reason: 'owner withdrew the mandate' }, 'plan-revoked');
  });
});

describe('P-013 LEG 6 — SHADOW MODE over the historical null-source wiring', () => {
  it('every door ADMITS, and every would-be refusal is recorded with its code', async () => {
    // This is the historical pilot's recommendation, executed. Identical to LEG 3
    // in every respect except the mode: same explicit null source, same doors, same
    // instant — but the fleet keeps running while the evidence accumulates.
    const observations: PlanAdmissionShadowObservation[] = [];
    configurePlanAdmissionShadowSink({ record: (o) => void observations.push(o) });
    configurePlanAdmissionPolicySource(async () => SHADOW_POLICY);
    configurePlanAdmissionCertificateSource({
      resolve: async () => ({ certificate: null, governance: null }),
    });

    const outcomes = await Promise.all(PLAN_ADMISSION_DOORS.map((door) => driveDoor('shadow-production-wiring', door)));

    expect(outcomes).toEqual(PLAN_ADMISSION_DOORS.map(() => 'skipped'));
    expect(METRICS['shadow-production-wiring'].refused).toBe(0);

    // One observation per door, each carrying the refusal enforcement WOULD have
    // returned — i.e. exactly the LEG 3 result, without the outage.
    expect(observations).toHaveLength(PLAN_ADMISSION_DOORS.length);
    expect(observations.every((o) => o.wouldAdmit === false)).toBe(true);
    expect(observations.every((o) => o.code === 'missing-certificate')).toBe(true);
    expect([...observations].map((o) => o.door).sort()).toEqual([...PLAN_ADMISSION_DOORS].sort());

    METRICS['shadow-would-refuse'] = {
      attempted: observations.length,
      succeeded: observations.filter((o) => o.wouldAdmit).length,
      refused: observations.filter((o) => !o.wouldAdmit).length,
      refusalCodes: observations.reduce<Record<string, number>>((acc, o) => {
        if (o.code) acc[o.code] = (acc[o.code] ?? 0) + 1;
        return acc;
      }, {}),
    };
  });
});

describe('P-013 — the pilot metrics artifact', () => {
  it('emits per-leg counts, and the counts agree with what the suite actually ran', () => {
    // Asserted BEFORE emitting, so the artifact can never report a leg the suite
    // did not execute. Every leg above must have left a mark.
    for (const leg of [
      'governance-round',
      'federation',
      'enforce-production-wiring',
      'no-policy-passthrough',
      'enforce-with-bridge',
      'owner-control-pause',
      'owner-control-revoke',
      'shadow-production-wiring',
      'shadow-would-refuse',
    ]) {
      expect(METRICS[leg], `leg '${leg}' recorded nothing — it did not run`).toBeTruthy();
      expect(METRICS[leg].attempted).toBeGreaterThan(0);
    }

    // The pilot's historical headline, stated as an assertion rather than only in prose:
    // enforcement refuses every door, shadow refuses none, and shadow's recorded
    // would-be refusals equal the enforcing run's real ones.
    expect(METRICS['enforce-production-wiring'].refused).toBe(PLAN_ADMISSION_DOORS.length);
    expect(METRICS['shadow-production-wiring'].refused).toBe(0);
    expect(METRICS['shadow-would-refuse'].refusalCodes).toEqual(METRICS['enforce-production-wiring'].refusalCodes);

    const artifact = {
      plan: 'shared-pot-dao-cupboard-v1-2026-09-04',
      item: 'P-013',
      workItem: 'WI-2145116',
      pot: POT_ID,
      cohortSize: COHORT.length,
      doors: [...PLAN_ADMISSION_DOORS],
      verdict: {
        enforcementActivatable: false,
        historical: true,
        asOf: 'P-013 before P-037/WI-2146857',
        reason:
          'the pre-P-037 build had no production certificate producer, so every door refused missing-certificate when governance.planAdmission was set',
        recommendation: "historical: run mode:'shadow' until a FinalizationCertificate→AdmissionCertificate producer is wired",
        supersededBy:
          'P-037/WI-2146857 wires the production governance-event source; current seven-door coverage is plan-admission-certificate-source.test.ts',
      },
      legs: METRICS,
      cupboardLegsMeasuredElsewhere: CUPBOARD_LEG_COVERAGE,
    };

    // eslint-disable-next-line no-console -- the brief asks the suite to PRINT a metrics block.
    console.log(`P013_PILOT_METRICS ${JSON.stringify(artifact)}`);

    // Regenerating the committed artifact is opt-in: a test that writes on every
    // run would dirty the shared tree, and git-sync commits the whole tree.
    if (process.env.PAPERCUSP_WRITE_PILOT_METRICS === '1') {
      writeFileSync(join(__dirname, 'p013-shadow-governance-pilot.metrics.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    }
  });
});
