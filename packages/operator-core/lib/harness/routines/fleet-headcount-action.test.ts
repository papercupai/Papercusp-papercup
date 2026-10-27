import { describe, expect, it } from 'vitest';
import type { FleetHeadcountTarget, FleetLaunchTransaction } from '../../agent-fleets-store';
import {
  assessFleetHeadcountGovernor,
  bootFailureFingerprint,
  bootFailureStreak,
  bootFailureWaveFingerprint,
  FLEET_HEADCOUNT_BOOT_FAILURE_STREAK,
  computeHeadcountDeficit,
  FLEET_HEADCOUNT_ATTESTATION_RETRY_LIMIT,
  FLEET_HEADCOUNT_BULK_WAVE_SIZE,
  governorVerdictForAssessment,
  grantingHeadcountTargets,
  nextHeadcountBackoff,
  resolveProductiveCapacityFloor,
  resolveFleetHeadcountLaunchRole,
  resolveFleetHeadcountProfile,
  resolveGovernorMemberLaunchProfile,
  supersedeLegacyHeadcountTransaction,
} from './fleet-headcount-action';

const workerAttestation = (ownerId: string, ready: boolean) => ({
  version: 1 as const,
  ownerId,
  ready,
  stages: {
    agentCall: { status: 'satisfied' as const, successfulCalls: 1 },
    durableWake: ready
      ? { status: 'satisfied' as const, wakeSource: 'loop' }
      : { status: 'missing' as const, wakeSource: null },
    schedulerPull: ready
      ? { status: 'satisfied' as const, calls: 1, successfulCalls: 1 }
      : { status: 'missing' as const, calls: 0, successfulCalls: 0 },
    disposition: ready
      ? { status: 'satisfied' as const, kind: 'no-claim' as const, reason: 'lane_drained' }
      : { status: 'missing' as const, kind: 'missing' as const },
  },
  failures: ready
    ? []
    : [{
        stage: 'durableWake' as const,
        code: 'durable-wake-missing' as const,
        detail: 'No durable wake.',
      }],
});

const transaction = (
  owners: string[],
  overrides: Partial<FleetLaunchTransaction> = {},
): FleetLaunchTransaction => ({
  version: 1,
  transactionId: 'tx-1',
  launcherOwnerId: 'su-leader',
  state: 'partial',
  requestedAt: 1_000,
  updatedAt: 1_000,
  requestedMemberIds: owners,
  openedMemberIds: owners,
  verifiedMemberIds: [],
  unconfirmedMemberIds: owners,
  failed: [],
  waves: [{ index: 0, ownerIds: owners, state: 'partial', openedOwnerIds: owners }],
  recovery: { retryOwnerIds: owners, nextAction: 'observe' },
  ...overrides,
});

// R5 (interrupted-member-recovery-hardening-2026-09-01): the per-fleet GRANT filter the
// governor sweep applies before its wave cap. Only an explicit `supervise: true` on the
// persisted recipe admits a fleet; everything else — absent config, absent key, false,
// a truthy non-boolean — is ungranted, because a recipe persisted for respawn (D-008)
// is not supervision consent. FLEET_HEADCOUNT_GOVERNOR stays the master gate above it.
describe('grantingHeadcountTargets (R5 — per-fleet supervise grant)', () => {
  const recipe = { plan: 'p', harness: 'h', agent: 'claude' as const };
  const target = (config: unknown, fleetSlug = 'f'): FleetHeadcountTarget => ({
    workspaceId: 'ws',
    fleetSlug,
    enabled: true,
    target: 1,
    config: config as FleetHeadcountTarget['config'],
    nextAttemptAt: null,
    backoffMs: 0,
    lastError: null,
  });

  it('admits only an explicit boolean supervise:true and preserves sweep order', () => {
    const granted = grantingHeadcountTargets([
      target({ ...recipe, supervise: true }, 'a'),
      target({ ...recipe }, 'b'),
      target({ ...recipe, supervise: false }, 'c'),
      target(undefined, 'd'),
      target({ ...recipe, supervise: 'true' }, 'e'),
      target({ ...recipe, supervise: true }, 'f'),
    ]);
    expect(granted.map((t) => t.fleetSlug)).toEqual(['a', 'f']);
  });

  it('returns an empty sweep — the flag-ON no-op — when no fleet has granted', () => {
    expect(grantingHeadcountTargets([target({ ...recipe }), target(undefined)])).toEqual([]);
  });
});

describe('fleet headcount governor guards (WI-2479)', () => {
  it('opens only the missing member deficit and never a negative wave', () => {
    expect(computeHeadcountDeficit(5, 2)).toBe(3);
    expect(computeHeadcountDeficit(5, 5)).toBe(0);
    expect(computeHeadcountDeficit(5, 9)).toBe(0);
  });

  it('uses bounded exponential retry delays', () => {
    expect(nextHeadcountBackoff(0)).toBe(60_000);
    expect(nextHeadcountBackoff(60_000)).toBe(120_000);
    expect(nextHeadcountBackoff(60 * 60_000)).toBe(15 * 60_000);
  });

  it('defaults legacy profiles headless while preserving every explicit launch knob', () => {
    expect(resolveFleetHeadcountProfile({ plan: 'drain', harness: 'papercusp', agent: 'codex' }).headless).toBe(true);
    expect(resolveFleetHeadcountProfile({
      plan: 'drain',
      harness: 'papercusp',
      agent: 'codex',
      model: 'gpt-5.6-luna',
      effort: 'max',
      account: 'default',
      carry: 'warm',
      contextSize: 'trimmed',
      compactionLimit: 825_000,
      headless: false,
      brief: 'drain bugs',
    })).toMatchObject({
      headless: false,
      effort: 'max',
      carry: 'warm',
      contextSize: 'trimmed',
      compactionLimit: 825_000,
      brief: 'drain bugs',
    });
  });

  describe('resolveGovernorMemberLaunchProfile (WI-10008195)', () => {
    it('takes the agent from the goal profile together with its model, so a codex model never launches as claude', () => {
      const profile = resolveGovernorMemberLaunchProfile(
        { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', account: 'auto' },
        { agent: 'claude', model: undefined, effort: undefined, account: undefined },
      );
      expect(profile).toEqual({ agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', account: 'auto' });
    });

    it('falls back to the fleet config field by field when the goal profile omits a key', () => {
      expect(resolveGovernorMemberLaunchProfile(
        {},
        { agent: 'claude', model: 'sonnet', effort: 'high', account: undefined },
      )).toEqual({ agent: 'claude', model: 'sonnet', effort: 'high', account: 'default' });
    });
  });

  describe('resolveFleetHeadcountLaunchRole (D-016)', () => {
    it('binds the declared drain fleet to the drain-fleet-member slot', () => {
      expect(resolveFleetHeadcountLaunchRole({
        goalId: 'goal-1',
        fleetSlug: 'goal-drain-goal-1',
        drainFleetSlug: 'goal-drain-goal-1',
      })).toBe('drain-fleet-member');
    });

    it('binds another fleet in the same goal to the plan-fleet-member slot', () => {
      expect(resolveFleetHeadcountLaunchRole({
        goalId: 'goal-1',
        fleetSlug: 'plan-fleet-1',
        drainFleetSlug: 'goal-drain-goal-1',
      })).toBe('plan-fleet-member');
    });

    it('leaves the role layer absent when the fleet has no goal context', () => {
      expect(resolveFleetHeadcountLaunchRole({
        goalId: null,
        fleetSlug: 'standalone-fleet',
        drainFleetSlug: null,
      })).toBeNull();
    });
  });
});

describe('fleet headcount governor typed attestation policy (P-004)', () => {
  it('opens one canary below the productive floor and a bounded wave after the floor is evidenced', () => {
    expect(resolveProductiveCapacityFloor(5, 2)).toBe(2);
    const canary = assessFleetHeadcountGovernor({
      target: 5,
      productiveCapacityFloor: 2,
      liveMemberIds: [],
      executingMemberIds: new Set<string>(),
      transaction: null,
      now: 10_000,
    });
    expect(canary).toMatchObject({ action: 'spawn', spawnCount: 1, workerReadyMemberIds: [] });

    const ready = transaction(['su-a', 'su-b'], {
      state: 'verified',
      verifiedMemberIds: ['su-a', 'su-b'],
      unconfirmedMemberIds: [],
      workerReadyMemberIds: ['su-a', 'su-b'],
      workerAttestations: [workerAttestation('su-a', true), workerAttestation('su-b', true)],
    });
    const bulk = assessFleetHeadcountGovernor({
      target: 5,
      productiveCapacityFloor: 2,
      liveMemberIds: ['su-a', 'su-b'],
      executingMemberIds: new Set(['su-a', 'su-b']),
      transaction: ready,
      now: 10_000,
    });
    expect(bulk).toMatchObject({ action: 'spawn', spawnCount: 3, workerReadyMemberIds: ['su-a', 'su-b'] });
  });

  it('uses attested executing capacity for the deficit and opens a bounded wave once the floor is proven', () => {
    const current = transaction(['su-ready', 'su-unverified-a', 'su-unverified-b'], {
      openedMemberIds: [],
      verifiedMemberIds: ['su-ready'],
      unconfirmedMemberIds: [],
      workerReadyMemberIds: ['su-ready'],
      workerAttestations: [workerAttestation('su-ready', true)],
      governor: {
        version: 1,
        probeOwnerIds: [],
        attestationAttempts: {},
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    });

    expect(assessFleetHeadcountGovernor({
      target: 3,
      productiveCapacityFloor: 1,
      liveMemberIds: ['su-ready', 'su-unverified-a', 'su-unverified-b'],
      executingMemberIds: new Set(['su-ready']),
      transaction: current,
      now: 20_000,
    })).toMatchObject({
      productiveMemberCount: 1,
      deficit: 2,
      headcountBasis: { kind: 'agent-origin-execution-attested' },
      action: 'spawn',
      spawnCount: 2,
      pruneCandidateIds: [],
      unverifiedMemberIds: ['su-unverified-a', 'su-unverified-b'],
    });
  });

  // WI-2034624 REGRESSION — the churn engine. Members opened by a PRIOR launch
  // transaction (or rebuilt by a carry-respawn) never re-enter the current
  // transaction's `workerReadyMemberIds`, so sizing the deficit from that set
  // reported a fleet at 3/50 while 37 members were live and 22 were executing.
  // The governor then requested replacements it did not need, forever: 144
  // ever-members in 13h, 932 lifetime on the predecessor fleet, each churned
  // boot re-burning the quota that is the REAL constraint. `current` must come
  // from execution over the canonical roster, so a member this transaction
  // never recorded still counts.
  it('counts executing members the current transaction never recorded, and asks for no replacement', () => {
    const live = Array.from({ length: 37 }, (_, i) => `su-live-${i}`);
    const current = transaction(live.slice(0, 3), {
      openedMemberIds: [],
      verifiedMemberIds: live.slice(0, 3),
      unconfirmedMemberIds: [],
      // Only THIS transaction's three seats are recorded ready.
      workerReadyMemberIds: live.slice(0, 3),
      workerAttestations: live.slice(0, 3).map((id) => workerAttestation(id, true)),
      governor: {
        version: 1,
        probeOwnerIds: [],
        attestationAttempts: {},
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    });

    const assessment = assessFleetHeadcountGovernor({
      target: 20,
      productiveCapacityFloor: 1,
      liveMemberIds: live,
      executingMemberIds: new Set(live.slice(0, 22)),
      transaction: current,
      now: 20_000,
    });

    expect(assessment).toMatchObject({
      productiveMemberCount: 22,
      deficit: 0,
      action: 'wait',
      spawnCount: 0,
      headcountBasis: {
        kind: 'agent-origin-execution-attested',
        liveRosterMembers: 37,
        executingMembers: 22,
        transactionWorkerReadyMembers: 3,
      },
    });
    // The failing behavior in one assertion: the transaction population must not
    // be able to cap the count, or the governor spawns into an already-full fleet.
    expect(assessment.productiveMemberCount).toBeGreaterThan(
      assessment.workerReadyMemberIds.length,
    );
  });

  // WI-2034624, the SECOND transaction-scoped throttle. Sizing the deficit
  // correctly is not enough on its own: the productive-capacity floor also read
  // only this transaction's attestations, so a fleet rebuilt entirely from prior
  // transactions still refilled ONE canary per probe — the "allowance 1-2 per
  // capacity probe" observed on the incident fleet. Demonstrated execution is
  // stronger proof of productive capacity than a recorded boot attestation.
  it('evidences the productive-capacity floor from execution when this transaction recorded none', () => {
    const live = ['su-prior-a', 'su-prior-b', 'su-prior-c'];
    const current = transaction([], {
      openedMemberIds: [],
      verifiedMemberIds: [],
      unconfirmedMemberIds: [],
      // This transaction opened nobody: every live member predates it.
      workerReadyMemberIds: [],
      workerAttestations: [],
      governor: {
        version: 1,
        probeOwnerIds: [],
        attestationAttempts: {},
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    });

    expect(assessFleetHeadcountGovernor({
      target: 9,
      productiveCapacityFloor: 2,
      liveMemberIds: live,
      executingMemberIds: new Set(live),
      transaction: current,
      now: 20_000,
    })).toMatchObject({
      productiveMemberCount: 3,
      workerReadyMemberIds: [],
      deficit: 6,
      action: 'spawn',
      // A bounded wave, NOT the one-canary trickle: `spawnCount: 1` here is the
      // throttle regressing.
      spawnCount: Math.min(6, FLEET_HEADCOUNT_BULK_WAVE_SIZE),
      reason: expect.stringContaining('productive-capacity floor is evidenced'),
    });
  });

  // The floor must still REFUSE to admit a merely-live process as proof: the
  // legacy fallback counts live seats, and letting that satisfy the floor would
  // hand a bounded wave to a fleet that has proven nothing.
  it('refuses to evidence the floor from the legacy live-roster fallback', () => {
    expect(assessFleetHeadcountGovernor({
      target: 9,
      productiveCapacityFloor: 2,
      liveMemberIds: ['su-legacy-a', 'su-legacy-b', 'su-legacy-c'],
      executingMemberIds: null,
      transaction: null,
      now: 20_000,
    })).toMatchObject({
      headcountBasis: { kind: 'legacy-live-roster-fallback' },
      productiveMemberCount: 3,
      action: 'spawn',
      spawnCount: 1,
      reason: expect.stringContaining('floor is not yet evidenced'),
    });
  });

  it('keeps the one-canary guard while unverified seats coexist with an unproven productive floor', () => {
    const current = transaction(['su-unverified-a', 'su-unverified-b'], {
      openedMemberIds: [],
      verifiedMemberIds: [],
      unconfirmedMemberIds: [],
      workerReadyMemberIds: [],
      workerAttestations: [],
      governor: {
        version: 1,
        probeOwnerIds: [],
        attestationAttempts: {},
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    });

    expect(assessFleetHeadcountGovernor({
      target: 8,
      productiveCapacityFloor: 2,
      liveMemberIds: ['su-unverified-a', 'su-unverified-b'],
      executingMemberIds: new Set<string>(),
      transaction: current,
      now: 20_000,
    })).toMatchObject({
      productiveMemberCount: 0,
      deficit: 8,
      action: 'spawn',
      spawnCount: 1,
      unverifiedMemberIds: ['su-unverified-a', 'su-unverified-b'],
    });
  });

  // WI-6554700010029353 superseded the original "wait until its fate is proven" policy
  // for this shape. Outside the probe cohort nothing ever re-takes the attestation, so
  // its fate is never proven and that wait was unbounded, which contradicts P-004's
  // bounded retry. The member is still never pruned, and the deficit is refilled.
  it('refills past a stale non-ready attestation outside the current probe cohort without pruning it', () => {
    const current = transaction(['su-ready', 'su-stale-unready'], {
      openedMemberIds: [],
      verifiedMemberIds: ['su-ready'],
      unconfirmedMemberIds: [],
      workerReadyMemberIds: ['su-ready'],
      workerAttestations: [
        workerAttestation('su-ready', true),
        workerAttestation('su-stale-unready', false),
      ],
      governor: {
        version: 1,
        probeOwnerIds: [],
        attestationAttempts: {},
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    });

    expect(assessFleetHeadcountGovernor({
      target: 2,
      liveMemberIds: ['su-ready', 'su-stale-unready'],
      executingMemberIds: new Set(['su-ready']),
      transaction: current,
      now: 20_000,
    })).toMatchObject({
      productiveMemberCount: 1,
      deficit: 1,
      action: 'spawn',
      spawnCount: 1,
      pruneCandidateIds: [],
      unreadyMemberIds: ['su-stale-unready'],
      frozenUnreadyMemberIds: ['su-stale-unready'],
    });
  });

  it('waits on an unverified late boot, then cancels replay when that exact member proves ready', () => {
    const slow = transaction(['su-slow']);
    const before = assessFleetHeadcountGovernor({
      target: 1,
      liveMemberIds: [],
      executingMemberIds: new Set<string>(),
      transaction: slow,
      now: 2_000,
    });
    expect(before).toMatchObject({
      action: 'wait',
      spawnCount: 0,
      pendingOpenedMemberIds: ['su-slow'],
    });

    slow.verifiedMemberIds = ['su-slow'];
    slow.unconfirmedMemberIds = [];
    slow.workerReadyMemberIds = ['su-slow'];
    slow.workerAttestations = [workerAttestation('su-slow', true)];
    const after = assessFleetHeadcountGovernor({
      target: 1,
      liveMemberIds: ['su-slow'],
      executingMemberIds: new Set(['su-slow']),
      transaction: slow,
      now: 3_000,
    });
    expect(after).toMatchObject({ action: 'none', spawnCount: 0, workerReadyMemberIds: ['su-slow'] });
  });

  it('never prunes a live member whose typed readiness is absent', () => {
    const legacy = transaction(['su-legacy'], {
      openedMemberIds: [],
      unconfirmedMemberIds: [],
      workerAttestations: undefined,
      workerReadyMemberIds: undefined,
    });
    const result = assessFleetHeadcountGovernor({
      target: 1,
      liveMemberIds: ['su-legacy'],
      executingMemberIds: new Set(['su-legacy']),
      transaction: legacy,
      now: 20_000,
    });
    expect(result).toMatchObject({
      action: 'wait',
      pruneCandidateIds: [],
      unverifiedMemberIds: ['su-legacy'],
    });
  });

  it('supersedes a legacy launch transaction without fabricating correlation or replaying live members', () => {
    const legacy = transaction(['su-live-ready', 'su-live-unknown', 'su-gone'], {
      launcherOwnerId: undefined,
      verifiedMemberIds: ['su-live-ready', 'su-gone'],
      workerReadyMemberIds: ['su-live-ready', 'su-gone'],
      workerAttestations: [
        workerAttestation('su-live-ready', true),
        workerAttestation('su-gone', true),
      ],
      governor: {
        version: 1,
        probeOwnerIds: ['su-live-ready', 'su-live-unknown', 'su-gone'],
        attestationAttempts: { 'su-gone': 2 },
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    });

    const normalized = supersedeLegacyHeadcountTransaction({
      transaction: legacy,
      liveMemberIds: ['su-live-ready', 'su-live-unknown'],
      launcherOwnerId: 'su-current-leader',
      now: 30_000,
    });

    expect(normalized).toMatchObject({
      previousTransactionId: 'tx-1',
      launcherOwnerId: 'su-current-leader',
      requestedAt: 30_000,
      requestedMemberIds: ['su-live-ready', 'su-live-unknown'],
      openedMemberIds: [],
      verifiedMemberIds: ['su-live-ready'],
      workerReadyMemberIds: ['su-live-ready'],
      unconfirmedMemberIds: [],
      recovery: { retryOwnerIds: [] },
      governor: { probeOwnerIds: [], attestationAttempts: {} },
    });
    expect(normalized.transactionId).not.toBe('tx-1');
    expect(normalized.workerAttestations?.map((item) => item.ownerId)).toEqual(['su-live-ready']);
    expect(normalized.governor?.history.at(-1)?.reason).toMatch(/superseded legacy launch transaction/);

    // The two observed live members are never replayed. A target of three opens
    // exactly the one real deficit, with the preserved typed-ready member still
    // satisfying the productive-capacity floor.
    expect(assessFleetHeadcountGovernor({
      target: 3,
      productiveCapacityFloor: 1,
      liveMemberIds: ['su-live-ready', 'su-live-unknown'],
      executingMemberIds: new Set(['su-live-ready']),
      transaction: normalized,
      now: 30_000,
    })).toMatchObject({ action: 'spawn', spawnCount: 2, pendingOpenedMemberIds: [] });
  });

  /**
   * WI-2034601 — the launch-window deadline used to be unreachable for exactly the
   * members it existed to catch. The predicate read
   * `!verified.has(id) || elapsed < WINDOW`, and that disjunction short-circuits: an
   * UNVERIFIED member satisfied `!verified` and so was never time-bounded, while a
   * VERIFIED one was the only kind the deadline could retire. A
   * registered-but-never-first-turn member is unverified by definition, so it waited
   * forever (observed: 278 governor decisions across ~3.5 days at deficit 50).
   *
   * These three cases pin the corrected shape. The middle one is the falsifier: it
   * fails if the deadline is applied too eagerly, which is the way a naive fix breaks
   * the legitimate late-boot behaviour the original branch was protecting.
   */
  describe('first-turn launch deadline (WI-2034601)', () => {
    it('classifies an UNVERIFIED never-first-turn member launch-failed past the deadline, and stops waiting', () => {
      const stuck = transaction(['su-never-booted']);
      const assessment = assessFleetHeadcountGovernor({
        target: 1,
        liveMemberIds: [],
        executingMemberIds: new Set<string>(),
        transaction: stuck,
        // requestedAt is 1_000 and the window is 300_000, so this is past the deadline.
        now: 1_000 + 300_000 + 1,
      });

      // The regression itself: an unverified member must NOT be pending past the deadline.
      expect(assessment.pendingOpenedMemberIds).toEqual([]);
      expect(assessment.launchDeadlineExceededMemberIds).toEqual(['su-never-booted']);
      // And the governor must leave the wait branch, so the seat is actually replaced.
      expect(assessment.action).not.toBe('wait');
      expect(assessment.action).toBe('spawn');
      expect(assessment.reason).toMatch(/never became live within the 300s launch window/);
      expect(assessment.reason).toMatch(/launch-failed/);
    });

    it('FALSIFIER: still waits on an unverified member INSIDE the window, so a late healthy boot is not pruned early', () => {
      const booting = transaction(['su-slow-boot']);
      const assessment = assessFleetHeadcountGovernor({
        target: 1,
        liveMemberIds: [],
        executingMemberIds: new Set<string>(),
        transaction: booting,
        now: 1_000 + 300_000 - 1,
      });

      expect(assessment.action).toBe('wait');
      expect(assessment.pendingOpenedMemberIds).toEqual(['su-slow-boot']);
      expect(assessment.launchDeadlineExceededMemberIds).toEqual([]);
      expect(assessment.reason).not.toMatch(/launch-failed/);
    });

    it('bounds a VERIFIED-but-not-live member on the same deadline, so neither kind waits forever', () => {
      const verifiedGhost = transaction(['su-verified-ghost'], {
        verifiedMemberIds: ['su-verified-ghost'],
        unconfirmedMemberIds: [],
      });
      const assessment = assessFleetHeadcountGovernor({
        target: 1,
        liveMemberIds: [],
        executingMemberIds: new Set<string>(),
        transaction: verifiedGhost,
        now: 1_000 + 300_000 + 1,
      });

      expect(assessment.pendingOpenedMemberIds).toEqual([]);
      expect(assessment.launchDeadlineExceededMemberIds).toEqual(['su-verified-ghost']);
      expect(assessment.action).not.toBe('wait');
    });
  });

  it('prunes only after bounded repeated non-ready evidence plus verified agent start', () => {
    const member = transaction(['su-dark'], {
      verifiedMemberIds: ['su-dark'],
      unconfirmedMemberIds: [],
      workerReadyMemberIds: [],
      workerAttestations: [workerAttestation('su-dark', false)],
      governor: {
        version: 1,
        probeOwnerIds: ['su-dark'],
        attestationAttempts: { 'su-dark': FLEET_HEADCOUNT_ATTESTATION_RETRY_LIMIT - 1 },
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    });
    const retry = assessFleetHeadcountGovernor({
      target: 1,
      liveMemberIds: ['su-dark'],
      executingMemberIds: new Set<string>(),
      transaction: member,
      now: 20_000,
    });
    expect(retry).toMatchObject({ action: 'retry', pruneCandidateIds: [] });

    member.governor!.attestationAttempts['su-dark'] = FLEET_HEADCOUNT_ATTESTATION_RETRY_LIMIT;
    const prune = assessFleetHeadcountGovernor({
      target: 1,
      liveMemberIds: ['su-dark'],
      executingMemberIds: new Set<string>(),
      transaction: member,
      now: 20_000,
    });
    expect(prune).toMatchObject({
      action: 'prune',
      actionOwnerId: 'su-dark',
      pruneCandidateIds: ['su-dark'],
    });

    // A stale launch-stage failure cannot outweigh independent evidence that
    // this same member is now doing work (or waiting by contract).
    const resumed = assessFleetHeadcountGovernor({
      target: 1,
      liveMemberIds: ['su-dark'],
      executingMemberIds: new Set(['su-dark']),
      transaction: member,
      now: 20_000,
    });
    // WI-6554700010029346: `none` (verdict `productive`), not `wait` (verdict
    // `unverified`) — a `wait` here IS the stale attestation outweighing the work
    // evidence, which is what this case exists to forbid.
    expect(resumed).toMatchObject({
      action: 'none',
      pruneCandidateIds: [],
      unreadyMemberIds: [],
      productiveMemberCount: 1,
    });
  });

  // WI-6554700010029346 — the Luna Max wedge (2026-10-26): a verified carry-respawned
  // member whose boot attestation was recorded ready:false, outside probeOwnerIds (so
  // never re-attested, never retryable) and with no attempt count. It is executing, so
  // it is never a prune candidate either. Before the fix it fell through to
  // `wait: prune is unsafe` on every tick and the fleet sat under target forever.
  it('does not let an EXECUTING member with a stale ready:false attestation block refill', () => {
    const live = ['su-respawn-stale', 'su-b', 'su-c'];
    const current = transaction(['su-c93062c0-dead'], {
      openedMemberIds: [],
      verifiedMemberIds: ['su-respawn-stale'],
      unconfirmedMemberIds: [],
      workerAttestations: [workerAttestation('su-respawn-stale', false)],
      failed: [{ phase: 'spawn', ownerId: 'su-c93062c0-dead', reason: 'died at boot (exit 1)' }],
      governor: {
        version: 1,
        probeOwnerIds: [],
        attestationAttempts: {},
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    });
    const assessment = assessFleetHeadcountGovernor({
      target: 9,
      productiveCapacityFloor: 2,
      liveMemberIds: live,
      executingMemberIds: new Set(live),
      transaction: current,
      now: 1_000 + 300_000 + 1,
    });
    expect(assessment.unreadyMemberIds).toEqual([]);
    expect(assessment.pruneCandidateIds).toEqual([]);
    expect(assessment).toMatchObject({ action: 'spawn', productiveMemberCount: 3, deficit: 6 });
    expect(assessment.reason).not.toContain('prune is unsafe');
  });

  // WI-6554700010029353 — the other half of the same boundary. The identical stale
  // attestation on a member that is NOT executing is still non-ready evidence, so it is
  // never pruned without a verified-start or terminal-failure proof. But it sits outside
  // probeOwnerIds, so nothing ever re-takes it: holding refill on it was an unbounded
  // wait (Luna Max, 10:15Z: one member silent 28m kept a 42/50 fleet at `wait`). It is
  // already excluded from the productive count, so the deficit refills past it.
  it('refills past a frozen stale ready:false member that is NOT executing, without pruning it', () => {
    const current = transaction([], {
      openedMemberIds: [],
      verifiedMemberIds: ['su-respawn-stale'],
      unconfirmedMemberIds: [],
      waves: [],
      workerAttestations: [workerAttestation('su-respawn-stale', false)],
      governor: {
        version: 1,
        probeOwnerIds: [],
        attestationAttempts: {},
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    });
    const assessment = assessFleetHeadcountGovernor({
      target: 9,
      productiveCapacityFloor: 2,
      liveMemberIds: ['su-respawn-stale', 'su-b', 'su-c'],
      executingMemberIds: new Set(['su-b', 'su-c']),
      transaction: current,
      now: 1_000 + 300_000 + 1,
    });
    expect(assessment.unreadyMemberIds).toEqual(['su-respawn-stale']);
    expect(assessment.frozenUnreadyMemberIds).toEqual(['su-respawn-stale']);
    expect(assessment.pruneCandidateIds).toEqual([]);
    expect(assessment).toMatchObject({
      action: 'spawn',
      actionOwnerId: null,
      productiveMemberCount: 2,
      deficit: 7,
    });
    expect(assessment.reason).toContain('1 unready member(s) outside the probe cohort hold frozen non-ready evidence');
    expect(assessment.reason).not.toContain('prune is unsafe');
  });

  // Control for the boundary above: a member the governor IS still probing keeps
  // holding refill once its retry budget is spent without a verified-start or
  // terminal-failure proof. Its evidence is re-taken every tick, so that wait is the
  // bounded one the fail-closed rule exists for.
  it('still waits on a PROBED unready member whose retry budget is spent without proof', () => {
    const current = transaction([], {
      openedMemberIds: [],
      verifiedMemberIds: [],
      unconfirmedMemberIds: ['su-probed-unproven'],
      waves: [],
      workerAttestations: [workerAttestation('su-probed-unproven', false)],
      governor: {
        version: 1,
        probeOwnerIds: ['su-probed-unproven'],
        attestationAttempts: { 'su-probed-unproven': 99 },
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    });
    const assessment = assessFleetHeadcountGovernor({
      target: 9,
      productiveCapacityFloor: 2,
      liveMemberIds: ['su-probed-unproven', 'su-b', 'su-c'],
      executingMemberIds: new Set(['su-b', 'su-c']),
      transaction: current,
      now: 1_000 + 300_000 + 1,
    });
    expect(assessment.unreadyMemberIds).toEqual(['su-probed-unproven']);
    expect(assessment.frozenUnreadyMemberIds).toEqual([]);
    expect(assessment.pruneCandidateIds).toEqual([]);
    expect(assessment).toMatchObject({
      action: 'wait',
      reason: 'non-ready evidence lacks a verified-start or terminal-failure proof; prune is unsafe',
    });
  });

  // And the live-attestation boundary: a CURRENT probe owner inside its retry budget
  // is still being re-attested, so its not-ready attestation is live evidence even
  // while it executes (an attestation mismatch — wrong model — is exactly this shape)
  // and the retry machinery keeps owning the decision.
  it('keeps an executing probe owner inside its retry budget on the retry path', () => {
    const current = transaction(['su-probing'], {
      verifiedMemberIds: ['su-probing'],
      unconfirmedMemberIds: [],
      workerAttestations: [workerAttestation('su-probing', false)],
      governor: {
        version: 1,
        probeOwnerIds: ['su-probing'],
        attestationAttempts: { 'su-probing': FLEET_HEADCOUNT_ATTESTATION_RETRY_LIMIT - 1 },
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    });
    expect(assessFleetHeadcountGovernor({
      target: 1,
      liveMemberIds: ['su-probing'],
      executingMemberIds: new Set(['su-probing']),
      transaction: current,
      now: 20_000,
    })).toMatchObject({
      action: 'retry',
      actionOwnerId: 'su-probing',
      unreadyMemberIds: ['su-probing'],
      pruneCandidateIds: [],
    });
  });

  it('refuses a prune even at the retry cap when start/failure proof is still unknown', () => {
    const member = transaction(['su-unknown'], {
      workerAttestations: [workerAttestation('su-unknown', false)],
      governor: {
        version: 1,
        probeOwnerIds: ['su-unknown'],
        attestationAttempts: { 'su-unknown': FLEET_HEADCOUNT_ATTESTATION_RETRY_LIMIT },
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    });
    const result = assessFleetHeadcountGovernor({
      target: 1,
      liveMemberIds: ['su-unknown'],
      executingMemberIds: new Set<string>(),
      transaction: member,
      now: 20_000,
    });
    expect(result).toMatchObject({ action: 'wait', pruneCandidateIds: [] });
  });

  it('prunes a repeatedly non-ready live member after the bounded launch window', () => {
    const member = transaction(['su-stuck'], {
      requestedAt: 1_000,
      verifiedMemberIds: ['su-stuck'],
      workerReadyMemberIds: [],
      workerAttestations: [workerAttestation('su-stuck', false)],
      governor: {
        version: 1,
        probeOwnerIds: ['su-stuck'],
        attestationAttempts: { 'su-stuck': FLEET_HEADCOUNT_ATTESTATION_RETRY_LIMIT },
        retiredMemberIds: [],
        history: [],
        terminalVerdict: null,
      },
    });
    expect(assessFleetHeadcountGovernor({
      target: 1,
      liveMemberIds: ['su-stuck'],
      executingMemberIds: new Set<string>(),
      transaction: member,
      now: 1_000 + 300_000,
    })).toMatchObject({
      action: 'prune',
      actionOwnerId: 'su-stuck',
      productiveMemberCount: 0,
      deficit: 1,
      pruneCandidateIds: ['su-stuck'],
    });
  });

  it('emits a distinct accountable terminal verdict without rewriting liveness or progress', () => {
    const assessment = assessFleetHeadcountGovernor({
      target: 2,
      productiveCapacityFloor: 1,
      liveMemberIds: [],
      // Telemetry unreadable + a transaction with no worker contract: the legacy
      // live-roster fallback is still the honest reading of an empty roster.
      executingMemberIds: null,
      transaction: null,
      now: 20_000,
    });
    expect(governorVerdictForAssessment(assessment, 20_000)).toEqual({
      version: 1,
      outcome: 'repairing',
      decidedAt: 20_000,
      target: 2,
      productiveCapacityFloor: 1,
      liveMemberIds: [],
      workerReadyMemberIds: [],
      unreadyMemberIds: [],
      unverifiedMemberIds: [],
      productiveMemberCount: 0,
      headcountBasis: {
        kind: 'legacy-live-roster-fallback',
        liveRosterMembers: 0,
        executingMembers: null,
        transactionWorkerReadyMembers: null,
      },
      deficit: 2,
      action: 'spawn',
      reason: 'productive-capacity floor is not yet evidenced; open one canary only',
    });
  });
});

describe('deterministic boot-failure hold (WI-6554700010029299)', () => {
  // The exact boot-death shape console-spawn recorded for nonp2p-bug-drain-luna-max-0930
  // on 10-25, including the OSC title sequences the psu banner emits.
  const bootDeath = (session: number) =>
    'headless member launched but its agent command died at boot (exit 1) — the shell stays open holding a DEAD session, '
    + 'so this never surfaced as a process exit (EI-19311623077693508) — log tail: '
    + '\u001b]0;SH: fleet · governor member 1/1 (claim-spec)\u0007papercusp superuser launcher (psu): launcher\n'
    + `psu: codex (su)  ·  no plan  ·  session ${session}\n`
    + 'psu: fleet — joined fleet nonp2p-bug-drain-luna-max-0930 as member.\n'
    + 'psu: SU launch account route differs from its resolved bootstrap\n\n'
    + '[papercusp] initial terminal command exited with status 1; headless launch exiting.';

  it('fingerprints a boot death by its last substantive log line, independent of session ids', () => {
    expect(bootFailureFingerprint(bootDeath(52595))).toBe('psu: su launch account route differs from its resolved bootstrap');
    expect(bootFailureFingerprint(bootDeath(52595))).toBe(bootFailureFingerprint(bootDeath(61234)));
    expect(bootFailureFingerprint('headless member launched but its agent command died at boot (exit 2)'))
      .toBe('died at boot (exit #)');
    // Not a boot death: transient spawn errors must never trip the hold.
    expect(bootFailureFingerprint('spawn ENOENT')).toBeNull();
    expect(bootFailureFingerprint(null)).toBeNull();
  });

  it('a wave counts only when EVERY requested member died at boot with one cause', () => {
    const failed = [
      { ownerId: 'a', reason: bootDeath(1) },
      { ownerId: 'b', reason: bootDeath(2) },
    ];
    expect(bootFailureWaveFingerprint(failed, ['a', 'b'])).toBe('psu: su launch account route differs from its resolved bootstrap');
    // One member opened fine, so the wave is mixed and says nothing deterministic.
    expect(bootFailureWaveFingerprint(failed, ['a', 'b', 'c'])).toBeNull();
    expect(bootFailureWaveFingerprint([{ ownerId: 'a', reason: 'spawn ENOENT' }], ['a'])).toBeNull();
    expect(bootFailureWaveFingerprint([], [])).toBeNull();
  });

  it('counts the trailing run of identical boot-failure waves; boot-ok or a new cause ends it', () => {
    const fp = 'psu: su launch account route differs from its resolved bootstrap';
    const bf = (reason = fp) => ({ action: 'boot-failure', reason });
    const noise = { action: 'terminal', reason: 'failed/spawn: 1/1 headless governor spawn(s) failed' };
    expect(bootFailureStreak([bf(), noise, bf(), { action: 'retry', reason: 'x' }, bf()]))
      .toEqual({ fingerprint: fp, count: 3 });
    expect(bootFailureStreak([bf(), bf(), { action: 'boot-ok', reason: 'ok' }, bf()]))
      .toEqual({ fingerprint: fp, count: 1 });
    expect(bootFailureStreak([bf('other cause'), bf(), bf()])).toEqual({ fingerprint: fp, count: 2 });
    expect(bootFailureStreak([noise])).toBeNull();
    // The hold threshold is reachable by exactly this run length.
    expect(bootFailureStreak([bf(), bf(), bf()])!.count).toBeGreaterThanOrEqual(FLEET_HEADCOUNT_BOOT_FAILURE_STREAK);
  });
});
