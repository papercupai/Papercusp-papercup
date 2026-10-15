import { beforeAll, describe, expect, it, vi } from 'vitest';
import { generateEd25519KeypairDer } from '../../identity/ed25519';
import {
  PHASE_G_INPUT_SCHEMA,
  executePhysicalPhaseG,
  type PhysicalPhaseGInput,
} from './physical-drill-phase-g';
import {
  POST_GO_RELEASE_CANARY_MIN_DURATION_MS,
  POST_GO_RELEASE_CANARY_SCHEMA,
  postGoReleaseCanaryMinimum,
  validatePostGoReleaseCanary,
  type PostGoReleaseCanaryInput,
} from './post-go-release-canary';
import type { PostGoCanaryObservation } from './post-go-canary-observations';
import type { PhysicalPhaseIInput } from './physical-drill-phase-i';
import { buildPhysicalPhaseIInput } from './physical-drill-phase-i.fixture';

const CANDIDATE = 'a'.repeat(40);
const RUN = 'p524-post-go-phase-g-0001';
const GO_AT = '2026-08-10T19:59:59.000Z';
const CANARY_START = '2026-08-10T20:00:00.000Z';
const CANARY_FINISH = '2026-08-13T20:00:00.000Z';
const PHASE_G_START = '2026-08-13T20:00:00.000Z';
const PHASE_G_OBSERVED = '2026-08-13T20:30:00.000Z';
const PHASE_G_FINISH = '2026-08-13T21:00:00.000Z';
const PHASE_I_START = '2026-08-13T21:00:00.000Z';
const CHAOS_FINISH = '2026-08-13T22:00:00.000Z';
const EVALUATED_AT = '2026-08-13T22:01:00.000Z';

const CANARY_HIVE = 'hello-world-3-pot';
const EGRESS_HEAD = 'd'.repeat(40);

/** A quiet, healthy sample every hour across the whole 72h window (73 samples). */
function hourlyObservations(): PostGoCanaryObservation[] {
  const start = Date.parse(CANARY_START);
  return Array.from({ length: 73 }, (_, hour) => {
    const at = new Date(start + hour * 3_600_000).toISOString();
    return {
      at,
      hive: CANARY_HIVE,
      active: true,
      lastFiredAt: at,
      lastStatus: 'ok',
      watchdogAlerted: false,
      eligibilityAlerted: false,
      bridgeRan: true,
      bridgeSkipped: null,
      divergence: 'clear',
      needsOwner: false,
      bridgeErrors: [],
      egressTarget: 'fork',
      egressHead: EGRESS_HEAD,
      forkHead: EGRESS_HEAD,
      openEscalations: 0,
    };
  });
}

let phaseG: PhysicalPhaseGInput;
let phaseI: PhysicalPhaseIInput;

beforeAll(async () => {
  const tower = generateEd25519KeypairDer();
  const vm = generateEd25519KeypairDer();
  const result = await executePhysicalPhaseG(
    {
      runId: RUN,
      towerDeviceKey: tower.pubkeyBase64,
      vmDeviceKey: vm.pubkeyBase64,
    },
    { now: () => PHASE_G_OBSERVED },
  );
  phaseG = {
    schemaVersion: PHASE_G_INPUT_SCHEMA,
    runId: RUN,
    window: { startedAt: PHASE_G_START, finishedAt: PHASE_G_FINISH },
    identities: {
      towerDeviceKey: tower.pubkeyBase64,
      vmDeviceKey: vm.pubkeyBase64,
    },
    result,
  };
  phaseI = buildPhysicalPhaseIInput({
    runId: 'p502-post-go-phase-i-0001',
    canary: { workspaceId: 'papercusp-workspace', potHomeSlug: CANARY_HIVE, repoKey: 'hello-world-3-pot:main' },
    towerDeviceKey: tower.pubkeyBase64,
    vmDeviceKey: vm.pubkeyBase64,
    startMs: Date.parse(PHASE_I_START),
  });
}, 60_000);

function validInput(): PostGoReleaseCanaryInput {
  return {
    schemaVersion: POST_GO_RELEASE_CANARY_SCHEMA,
    candidateSha: CANDIDATE,
    // A release with no owner ruling: the 72h default applies.
    releaseVersion: '0.0.30-alpha',
    independentGo: {
      decision: 'GO',
      candidateSha: CANDIDATE,
      approvedAt: GO_AT,
      reviewerOwnerId: 'su-independent-reviewer',
      implementationOwnerId: 'su-implementation-owner',
      attestationRef: 'p2p-public-release-endgame-2026-09-01#P-401',
    },
    canary: {
      candidateSha: CANDIDATE,
      startedAt: CANARY_START,
      finishedAt: CANARY_FINISH,
      hive: CANARY_HIVE,
      routineIntervalSec: 300,
      observations: hourlyObservations(),
      alarms: [],
      alarmRail: {
        divergenceNotifiesUrgent: true,
        stallWatchdogNotifiesUrgent: true,
        deliveredPageAt: '2026-08-12T09:00:00.000Z',
        deliveredPageRef: 'attention_notifications:real-page',
      },
    },
    ownerFreezeChaos: {
      candidateSha: CANDIDATE,
      window: { startedAt: PHASE_G_START, finishedAt: CHAOS_FINISH },
      phaseG: structuredClone(phaseG),
      phaseI: structuredClone(phaseI),
    },
    evaluatedAt: EVALUATED_AT,
  };
}

describe('post-GO public-release canary readiness', () => {
  it('refuses a Phase I that froze a disposable drill key instead of the canary owner (WI-10004748, D-119)', () => {
    const input = validInput();
    const ephemeral = buildPhysicalPhaseIInput({
      runId: 'p502-post-go-phase-i-0002',
      towerDeviceKey: input.ownerFreezeChaos.phaseI.identities.towerDeviceKey,
      vmDeviceKey: input.ownerFreezeChaos.phaseI.identities.vmDeviceKey,
      startMs: Date.parse(input.ownerFreezeChaos.phaseI.window.startedAt) - 1_000,
    });
    input.ownerFreezeChaos.phaseI = ephemeral;
    const verdict = validatePostGoReleaseCanary(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toMatch(/real owning authority/);
  });

  it('refuses a canary-owner Phase I aimed at a different hive than the soak observed', () => {
    const input = validInput();
    const target = input.ownerFreezeChaos.phaseI.target;
    if (target?.kind !== 'canary-owner') throw new Error('fixture must be canary-owner');
    target.potHomeSlug = 'some-other-pot';
    const verdict = validatePostGoReleaseCanary(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toMatch(/potHomeSlug = canary\.hive/);
  });

  it('refuses when the canary\'s real staging ref moved during the owner outage (G1)', () => {
    const input = validInput();
    const target = input.ownerFreezeChaos.phaseI.target;
    if (target?.kind !== 'canary-owner') throw new Error('fixture must be canary-owner');
    target.realTargets.duringOutage.stagingRef = 'f'.repeat(40);
    const verdict = validatePostGoReleaseCanary(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toMatch(/G1: the canary's real protected refs moved/);
  });

  it('refuses when the restored owner made no fresh progress on the real staging ref (G3)', () => {
    const input = validInput();
    const target = input.ownerFreezeChaos.phaseI.target;
    if (target?.kind !== 'canary-owner') throw new Error('fixture must be canary-owner');
    target.realTargets.afterRecovery.stagingRef = target.realTargets.duringOutage.stagingRef;
    const verdict = validatePostGoReleaseCanary(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toMatch(/G3: the restored owner made no fresh progress/);
  });

  it('reports the canary hive and sample count on a passing receipt', () => {
    const verdict = validatePostGoReleaseCanary(validInput());
    expect(verdict.errors).toEqual([]);
    expect(verdict.result).toMatchObject({ canaryHive: CANARY_HIVE, canaryObservationCount: 73 });
  });

  it('rejects a 72h window that carries no P-501 observations (WI-10002545)', () => {
    const input = validInput();
    const bare = { ...input, canary: { candidateSha: CANDIDATE, startedAt: CANARY_START, finishedAt: CANARY_FINISH } };
    const verdict = validatePostGoReleaseCanary(bare as unknown as PostGoReleaseCanaryInput);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toMatch(/hourly observations/);
  });

  it('rejects a full-length soak whose window contained a divergence escalation', () => {
    const input = validInput();
    input.canary.observations[40] = { ...input.canary.observations[40]!, divergence: 'diverged', openEscalations: 1 };
    const verdict = validatePostGoReleaseCanary(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.some((e) => e.startsWith('C1:'))).toBe(true);
    expect(verdict.errors.some((e) => e.startsWith('C2:'))).toBe(true);
  });
  it('does not accept future-dated elapsed time from a caller-supplied receipt', () => {
    const input = validInput();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(CANARY_FINISH) - 1);
    try {
      const premature = validatePostGoReleaseCanary(input);
      expect(premature.ok).toBe(false);
      expect(premature.errors).toContain('evaluatedAt cannot be in the future relative to the verifier clock');
      // The identical receipt becomes eligible only once its stated observation
      // time is in the past; do not weaken the actual 72-hour duration check.
      clock.mockReturnValue(Date.parse(EVALUATED_AT));
      expect(validatePostGoReleaseCanary(input).ok).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it('accepts an exact 72-hour post-GO canary followed by validated owner-freeze chaos', () => {
    const verdict = validatePostGoReleaseCanary(validInput());
    expect(verdict).toMatchObject({
      ok: true,
      errors: [],
      result: {
        candidateSha: CANDIDATE,
        status: 'ready-for-default-mode-decision',
        planItems: ['P-501', 'P-502', 'P-503'],
        canaryDurationMs: POST_GO_RELEASE_CANARY_MIN_DURATION_MS,
        ownerFreezeVerified: true,
        ownerRecoveryVerified: true,
      },
    });
  });

  it('rejects a canary that starts before the independent GO', () => {
    const input = validInput();
    input.independentGo.approvedAt = '2026-08-10T20:00:00.001Z';
    expect(validatePostGoReleaseCanary(input).errors).toContain(
      'canary cannot start before the independent GO',
    );
  });

  it('rejects a canary even one millisecond short of 72 hours', () => {
    const input = validInput();
    input.canary.finishedAt = '2026-08-13T19:59:59.999Z';
    expect(validatePostGoReleaseCanary(input).errors).toContain(
      'canary must run for an actual minimum of 72 hours',
    );
  });

  it('rejects candidate rebinding anywhere in the post-GO sequence', () => {
    const input = validInput();
    input.canary.candidateSha = 'b'.repeat(40);
    input.ownerFreezeChaos.candidateSha = 'c'.repeat(40);
    expect(validatePostGoReleaseCanary(input).errors).toEqual(
      expect.arrayContaining([
        'canary must bind the exact independently approved candidate',
        'owner-freeze chaos must bind the exact canary candidate',
      ]),
    );
  });

  it('requires an independent reviewer rather than an implementation self-GO', () => {
    const input = validInput();
    input.independentGo.reviewerOwnerId = input.independentGo.implementationOwnerId;
    expect(validatePostGoReleaseCanary(input).errors).toContain(
      'independent GO reviewer must differ from the implementation owner',
    );
  });

  it('rejects owner-freeze chaos that begins before the canary completes', () => {
    const input = validInput();
    input.canary.finishedAt = '2026-08-13T20:00:00.001Z';
    expect(validatePostGoReleaseCanary(input).errors).toContain(
      'owner-freeze chaos cannot execute before the canary soak finishes',
    );
  });

  describe('release-scoped soak minimum (endgame D-132 / D-163)', () => {
    /** Shift the whole post-canary sequence so the soak is exactly `hours` long. */
    function soakOf(hours: number, releaseVersion: string): PostGoReleaseCanaryInput {
      const input = validInput();
      input.releaseVersion = releaseVersion;
      const shift = (72 - hours) * 3_600_000;
      const back = (iso: string) => new Date(Date.parse(iso) - shift).toISOString();
      input.canary.finishedAt = back(input.canary.finishedAt);
      input.canary.observations = input.canary.observations.slice(0, hours + 1);
      const chaos = input.ownerFreezeChaos;
      chaos.window = { startedAt: back(chaos.window.startedAt), finishedAt: back(chaos.window.finishedAt) };
      return input;
    }

    const noSoakReleases = [
      ['0.0.28-alpha', 'p2p-public-release-endgame-2026-09-01#D-132'],
      ['0.0.29-alpha', 'p2p-public-release-endgame-2026-09-01#D-163'],
    ] as const;

    it('keeps the timer removal scoped to the release and its replacement', () => {
      for (const [releaseVersion, decisionRef] of noSoakReleases) {
        expect(postGoReleaseCanaryMinimum(releaseVersion)).toEqual({
          minimumDurationMs: 0,
          decisionRef,
        });
      }
      for (const other of ['0.0.30-alpha', '0.0.28', '0.0.29', '0.0.28-alpha.1', '0.0.29-alpha.1', '', 'toString', undefined]) {
        expect(postGoReleaseCanaryMinimum(other)).toEqual({
          minimumDurationMs: POST_GO_RELEASE_CANARY_MIN_DURATION_MS,
          decisionRef: null,
        });
      }
      expect(POST_GO_RELEASE_CANARY_MIN_DURATION_MS).toBe(72 * 3_600_000);
    });

    it('rejects a 24h soak for a release without an owner ruling', () => {
      const verdict = validatePostGoReleaseCanary(soakOf(24, '0.0.30-alpha'));
      expect(verdict.errors).toContain('canary must run for an actual minimum of 72 hours');
    });

    it.each(noSoakReleases)('accepts immediate %s evidence after independent GO without a timed soak', (releaseVersion, decisionRef) => {
      const input = validInput();
      input.releaseVersion = releaseVersion;
      input.canary.finishedAt = input.canary.startedAt;
      input.canary.observations = input.canary.observations.slice(0, 1);
      input.canary.alarmRail.deliveredPageAt = input.canary.startedAt;
      const verdict = validatePostGoReleaseCanary(input);
      expect(verdict.errors).toEqual([]);
      expect(verdict.ok).toBe(true);
      expect(verdict.result).toMatchObject({
        canaryDurationMs: 0,
        minimumDurationMs: 0,
        minimumDurationDecisionRef: decisionRef,
      });
    });

    it.each(noSoakReleases)('still requires independent approval when the %s timer is removed', (releaseVersion) => {
      const input = validInput();
      input.releaseVersion = releaseVersion;
      input.independentGo.reviewerOwnerId = input.independentGo.implementationOwnerId;
      expect(validatePostGoReleaseCanary(input).errors).toContain(
        'independent GO reviewer must differ from the implementation owner',
      );
    });

    it('requires a well-formed releaseVersion', () => {
      const input = validInput();
      input.releaseVersion = 'latest';
      expect(validatePostGoReleaseCanary(input).errors).toContain(
        'releaseVersion must name the shipping release (e.g. 0.0.28-alpha)',
      );
    });
  });

  it('rejects narrative freeze claims when the Phase G authority evidence is invalid', () => {
    const input = validInput();
    input.ownerFreezeChaos.phaseG.result.authorityFence.deviceOnlyAcceptance = {
      ok: true,
      reason: null,
    };
    expect(validatePostGoReleaseCanary(input).errors).toEqual(
      expect.arrayContaining([
        'Phase G: Phase G device-only advance must be rejected without owning hive authority',
        'owner-freeze chaos must contain complete validated P-308 Phase G evidence',
      ]),
    );
  });

  it('derives the owner-freeze and recovery verdicts from validated Phase I evidence', () => {
    expect(validatePostGoReleaseCanary(validInput()).result).toMatchObject({
      ownerFreezeVerified: true,
      ownerRecoveryVerified: true,
    });
  });

  it('rejects an outage in which a non-owner protected effect was authorized', () => {
    const input = validInput();
    const attempt = input.ownerFreezeChaos.phaseI.steps.outage.tower.attempts[0];
    attempt.ok = true;
    attempt.reason = null;
    const errors = validatePostGoReleaseCanary(input).errors;
    expect(errors).toContain('owner outage must freeze protected effects and refuse non-owner authority');
    expect(errors.some((e) => e.startsWith('Phase I: '))).toBe(true);
  });

  it('rejects resumption when the restored owner is not the same hive key', () => {
    const input = validInput();
    input.ownerFreezeChaos.phaseI.owner.restored.hiveId = phaseG.identities.towerDeviceKey;
    expect(validatePostGoReleaseCanary(input).errors).toContain(
      'protected effects may resume only after owning-hive proof is restored',
    );
  });

  it('rejects owner-freeze chaos with no Phase I evidence', () => {
    const input = validInput();
    delete (input.ownerFreezeChaos as Partial<typeof input.ownerFreezeChaos>).phaseI;
    const errors = validatePostGoReleaseCanary(input).errors;
    expect(errors).toContain('Phase I evidence must fall inside the post-canary owner-freeze chaos window');
    expect(errors).toContain('owner outage must freeze protected effects and refuse non-owner authority');
  });

  it('rejects Phase I evidence produced outside the owner-freeze chaos window', () => {
    const input = validInput();
    input.ownerFreezeChaos.window.finishedAt = PHASE_I_START;
    expect(validatePostGoReleaseCanary(input).errors).toContain(
      'Phase I evidence must fall inside the post-canary owner-freeze chaos window',
    );
  });
});
