/**
 * work-on-everything-goal-2026-08-23 P-011 — the operator-boot arm.
 *
 * Unit tests over the SAME injected-deps seams the P-009 respawner engine
 * exposes (`GoalHolderRespawnDeps`). The load-bearing claims:
 *
 *  - SCOPE: only `standing = true` goals are ever considered, and the filter
 *    wraps an INJECTED `readGoals` too (it cannot be bypassed by DI).
 *  - The P-009 floor is inherited unchanged: 'unheld' never spawns
 *    (install ≠ start, D-002), 'unknown' never spawns (degraded oracle is not
 *    death), a paused goal is not eligible, and the default holder policy
 *    (onLoss = 'deactivate') never respawns — respawn stays EARNED (D-001).
 *  - The flag gate is a hard pre-read no-op.
 *
 * NOT covered here (recorded as completion residue, same shape as P-010):
 * the armed managed-interval window and the real dark-flag reads
 * (STANDING_GOAL_BOOT_ARM / the GOAL_HOLDER_RESPAWN deference) — those resolve
 * through `@papercusp/flags/server` and are exercised only when the owner arms
 * the flag, which is the owner's documented ratification step.
 */
import { describe, expect, it } from 'vitest';
import { DARK_FLAGS, FLAGS, FLAG_DEFAULTS } from '@papercusp/flags';

import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';
import {
  runStandingGoalBootArmOnce,
  standingGoalEligibleForBootArm,
  type GoalHolderLike,
  type GoalHolderRespawnDeps,
  type GoalRowLike,
} from './goal-liveness-watchdog';

const sql = {} as never; // never touched — every PG dep is injected

const RESPAWN_POLICY = {
  holder: { requireLive: true, onLoss: 'respawn' },
} as GoalRowLike['launchSettings'];

function goal(overrides: Partial<GoalRowLike> = {}): GoalRowLike {
  return {
    goalId: 'work-on-everything',
    workspaceId: 'papercusp-workspace',
    title: 'Work on everything',
    updatedAtMs: Date.now() - 3_600_000,
    status: 'active',
    installSlug: 'papercusp',
    launchSettings: RESPAWN_POLICY,
    standing: true,
    ...overrides,
  };
}

function holder(ownerId: string, goalId = 'work-on-everything'): GoalHolderLike {
  return {
    goalId,
    workspaceId: 'papercusp-workspace',
    ownerId,
    setAtMs: Date.now() - 3_600_000,
  };
}

function verdict(ownerId: string, sessionState: SessionState): LivenessVerdict {
  return {
    ownerId,
    sessionState,
    wakeable: sessionState !== 'ended',
    liveTurn: sessionState === 'live',
    confirmLiveness: null,
    heartbeatFresh: sessionState === 'live',
  };
}

function harness(over: Partial<GoalHolderRespawnDeps> = {}) {
  const launches: string[] = [];
  const attaches: string[] = [];
  const deps: Partial<GoalHolderRespawnDeps> = {
    readGoals: async () => ({ goals: [goal()], holders: [holder('su-dead')] }),
    resolveLiveness: async () => new Map([['su-dead', verdict('su-dead', 'ended')]]),
    flagEnabled: async () => true,
    launch: async (g) => {
      launches.push(g.goalId);
      return { ownerId: 'su-fresh', warnings: [] };
    },
    attach: async (g, ownerId) => {
      attaches.push(`${g.goalId}:${ownerId}`);
    },
    reserveRateSlot: async () => ({ kind: 'reserved', attemptsInWindow: 1 }),
    // A PG dep like the ones around it, so the `sql` stub above stays untouched. The
    // latch reconciler (EI-23821882158913073) runs for EVERY swept goal by design —
    // a recovered holder is exactly the case the health-gated branches skip — so an
    // uninjected one reaches the stub and warns on every test in this file.
    reconcileStrandedLatch: async () => ({ kind: 'noop' }),
    // WI-10005573: the superseded-holder reaper also runs for every swept goal.
    retireSuperseded: async () => ({ retired: [], leftArmed: [], awaitsCancelled: 0, claimsReleased: [] }),
    // WI-10005559: production defers recovery until loss persists for 5 min. These
    // cases model boot-arm recovery on a single tick; the confirm window itself is
    // covered in goal-liveness-watchdog.test.ts.
    lossConfirmMs: 0,
    lossObservations: new Map(),
    escalateGiveUp: async () => {},
    now: () => Date.now(),
    states: new Map(),
    ...over,
  };
  return { deps, launches, attaches };
}

describe('standingGoalEligibleForBootArm', () => {
  it('accepts an active standing goal that earned onLoss=respawn', () => {
    expect(standingGoalEligibleForBootArm(goal())).toBe(true);
  });
  it('refuses a non-standing goal, however respawn-shaped its policy', () => {
    expect(standingGoalEligibleForBootArm(goal({ standing: false }))).toBe(false);
    expect(standingGoalEligibleForBootArm(goal({ standing: null }))).toBe(false);
  });
  it('refuses a paused goal — a deliberate hold is never a fault to repair', () => {
    expect(standingGoalEligibleForBootArm(goal({ status: 'paused' }))).toBe(false);
  });
  it('refuses the DEFAULT holder policy — respawn stays EARNED (D-001)', () => {
    expect(standingGoalEligibleForBootArm(goal({ launchSettings: null }))).toBe(false);
  });
});

describe('runStandingGoalBootArmOnce', () => {
  it('respawns a lost standing goal: launch first, then attach the pre-pinned owner', async () => {
    const { deps, launches, attaches } = harness();
    const r = await runStandingGoalBootArmOnce(sql, deps);
    expect(r).toMatchObject({ scanned: 1, eligible: 1, attempted: 1, respawned: 1, skipped: false });
    expect(launches).toEqual(['work-on-everything']);
    expect(attaches).toEqual(['work-on-everything:su-fresh']);
  });

  it('filters non-standing goals out even from an INJECTED readGoals — the scope cannot be bypassed', async () => {
    const { deps, launches } = harness({
      readGoals: async () => ({
        goals: [goal({ standing: false, goalId: 'ordinary-goal' })],
        holders: [holder('su-dead', 'ordinary-goal')],
      }),
    });
    const r = await runStandingGoalBootArmOnce(sql, deps);
    // Filtered BEFORE the engine: not even scanned, let alone launched.
    expect(r).toMatchObject({ scanned: 0, eligible: 0, attempted: 0, respawned: 0 });
    expect(launches).toEqual([]);
  });

  it("never spawns an 'unheld' standing goal — install ≠ start (D-002)", async () => {
    const { deps, launches } = harness({
      readGoals: async () => ({ goals: [goal()], holders: [] }),
      resolveLiveness: async () => new Map(),
    });
    const r = await runStandingGoalBootArmOnce(sql, deps);
    expect(r).toMatchObject({ scanned: 1, eligible: 1, attempted: 0, respawned: 0 });
    expect(launches).toEqual([]);
  });

  it("never spawns on 'unknown' liveness — a degraded oracle read is not death", async () => {
    const { deps, launches } = harness({
      // Holder row exists but the oracle returned no verdict for it.
      resolveLiveness: async () => new Map(),
    });
    const r = await runStandingGoalBootArmOnce(sql, deps);
    expect(r).toMatchObject({ scanned: 1, eligible: 1, attempted: 0, respawned: 0 });
    expect(launches).toEqual([]);
  });

  it('leaves a HELD standing goal alone', async () => {
    const { deps, launches } = harness({
      resolveLiveness: async () => new Map([['su-dead', verdict('su-dead', 'live')]]),
    });
    const r = await runStandingGoalBootArmOnce(sql, deps);
    expect(r).toMatchObject({ scanned: 1, eligible: 1, attempted: 0, respawned: 0 });
    expect(launches).toEqual([]);
  });

  it('is a hard no-op when the flag gate says no — nothing is read', async () => {
    let read = false;
    const { deps } = harness({
      flagEnabled: async () => false,
      readGoals: async () => {
        read = true;
        return { goals: [], holders: [] };
      },
    });
    const r = await runStandingGoalBootArmOnce(sql, deps);
    expect(r.skipped).toBe(true);
    expect(read).toBe(false);
  });
});

describe('the flag ships dark, owner-authority — the P-011 polarity', () => {
  it('STANDING_GOAL_BOOT_ARM defaults OFF via DARK_FLAGS, case owner-authority', () => {
    expect(FLAG_DEFAULTS[FLAGS.STANDING_GOAL_BOOT_ARM]).toBe(false);
    expect(DARK_FLAGS.get(FLAGS.STANDING_GOAL_BOOT_ARM)?.case).toBe('owner-authority');
  });
});
