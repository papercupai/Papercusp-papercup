import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DARK_FLAGS, FLAGS, FLAG_DEFAULTS } from '@papercusp/flags';

import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';
import { GOAL_HOLDER_PRODUCTIVITY_GRACE_MS } from '../goals/activity';
import type { GoalPortfolioThroughputRead } from '../goals/portfolio-throughput';
import {
  findUnplannedClusters,
  type UnplannedClusterAlert,
  type UnplannedClusterRead,
} from '../goals/unplanned-clusters';
import type { GoalHolderLaunchCapacityVerdict } from '../goals/holder-launch-capacity';
import {
  GOAL_HOLDER_CAPACITY_DEFER_ESCALATE_MS,
  GOAL_HOLDER_CAPACITY_DEFER_LOG_INTERVAL_MS,
  GOAL_HOLDER_LOSS_CONFIRM_MS,
  GOAL_HOLDER_REKICK_INTERVAL_MS,
  GOAL_HOLDER_REKICK_MAX,
  GOAL_HOLDER_UNHONORED_LAUNCH_HOLD_MAX_MS,
  GOAL_HOLDER_UNHONORED_LAUNCH_HOLD_MS,
  unhonoredLaunchHoldMs,
  type GoalHolderCapacityDeferral,
  type GoalHolderUnhonoredLaunchState,
  GOAL_LIVENESS_GRACE_MS,
  classifyGoalLiveness,
  classifyGoalPortfolioIdle,
  classifyGoalReadiness,
  classifyGoalWedge,
  goalEligibleForHolderRespawn,
  goalHolderRespawnKey,
  goalReadinessKey,
  holderCountsAsAlive,
  makeReadHolderProductivity,
  runGoalHolderRespawnOnce,
  runGoalLivenessSweepOnce,
  scanGoalLiveness,
  type GoalHolderRespawnDeps,
  type GoalHolderLike,
  type GoalLiveHold,
  type GoalLivenessAlert,
  type GoalPortfolioIdleAlert,
  type GoalReadinessAlert,
  type GoalRowLike,
  type GoalWedgeAlert,
} from './goal-liveness-watchdog';
import type { GoalReadiness } from '@papercusp/agent-mcp/goal-deps';
import { GoalHolderLaunchPolicyRefusedError } from '../harness/routines/goal-holder-launch-action';

// This suite exercises the existing liveness/readiness/respawn behavior with
// every delivery dependency isolated. The canonical condition-rail producer
// case separately verifies the real keyed open and measured-recovery lifecycle.
vi.mock('../severe-event-broadcast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../severe-event-broadcast')>()),
  broadcastSevereEvent: vi.fn(async () => undefined),
}));
vi.mock('../alarm-attention', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../alarm-attention')>()),
  resolveAlarm: vi.fn(async () => undefined),
}));

const NOW = Date.parse('2026-08-16T04:00:00Z');
const LONG_AGO = NOW - 5 * 24 * 60 * 60_000; // 5 days — the measured sidestage case
const JUST_NOW = NOW - 60_000;

function goal(overrides: Partial<GoalRowLike> = {}): GoalRowLike {
  return {
    goalId: 'make-sidestage-web-ios-and-android-ready-for-pub-dd62af',
    workspaceId: 'papercusp-workspace',
    title: 'Make SideStage web, iOS, and Android ready for public release',
    updatedAtMs: LONG_AGO,
    ...overrides,
  };
}

function holder(overrides: Partial<GoalHolderLike> = {}): GoalHolderLike {
  return {
    goalId: 'make-sidestage-web-ios-and-android-ready-for-pub-dd62af',
    workspaceId: 'papercusp-workspace',
    ownerId: 'su-2c130be1',
    setAtMs: LONG_AGO,
    ...overrides,
  };
}

function verdict(
  ownerId: string,
  sessionState: SessionState,
  selfWake?: 'loop' | 'event' | 'none',
): LivenessVerdict {
  return {
    ownerId,
    sessionState,
    wakeable: sessionState !== 'ended',
    liveTurn: sessionState === 'live',
    confirmLiveness: null,
    heartbeatFresh: sessionState === 'live',
    ...(selfWake ? { selfWake, loopArmed: selfWake === 'loop' } : {}),
  };
}

const vmap = (...vs: LivenessVerdict[]) => new Map(vs.map((v) => [v.ownerId, v]));

describe('holderCountsAsAlive', () => {
  it('counts live and recorded holders as alive', () => {
    expect(holderCountsAsAlive(verdict('a', 'live'))).toBe(true);
    expect(holderCountsAsAlive(verdict('a', 'recorded'))).toBe(true);
  });

  it('counts an ended holder as dead', () => {
    expect(holderCountsAsAlive(verdict('a', 'ended'))).toBe(false);
  });

  it('counts a parked holder with a self-wake source as alive', () => {
    expect(holderCountsAsAlive(verdict('a', 'parked', 'loop'))).toBe(true);
    expect(holderCountsAsAlive(verdict('a', 'parked', 'event'))).toBe(true);
  });

  it('counts a parked holder that nothing will ever wake as dead', () => {
    // The "dead member in a healthy costume" case — parked LOOKS alive.
    expect(holderCountsAsAlive(verdict('a', 'parked', 'none'))).toBe(false);
  });

  it('treats an ABSENT self-wake leg as alive, never as none', () => {
    // The leg is opt-in and can degrade; undefined means UNKNOWN. Collapsing
    // unknown to 'none' would alarm on every parked agent whenever the self-wake
    // query failed.
    expect(holderCountsAsAlive(verdict('a', 'parked'))).toBe(true);
  });

  it('treats mid-verdict states as alive and lets the next sweep decide', () => {
    expect(holderCountsAsAlive(verdict('a', 'draining'))).toBe(true);
    expect(holderCountsAsAlive(verdict('a', 'suspect'))).toBe(true);
  });
});

describe('classifyGoalLiveness', () => {
  it('reports a goal whose only holder is dead and long past the grace window', () => {
    const alert = classifyGoalLiveness(
      goal(),
      [holder()],
      vmap(verdict('su-2c130be1', 'ended')),
      NOW,
    );
    expect(alert).not.toBeNull();
    expect(alert?.reason).toBe('abandoned');
    expect(alert?.goalId).toBe('make-sidestage-web-ios-and-android-ready-for-pub-dd62af');
    expect(alert?.holders).toEqual([{ ownerId: 'su-2c130be1', sessionState: 'ended' }]);
    expect(alert?.darkMs).toBeGreaterThan(GOAL_LIVENESS_GRACE_MS);
  });

  /**
   * P-005 / D-009 — the falsifier for the paused exemption.
   *
   * Identical inputs to the test above (dead holder, five days dark) with ONE
   * field changed: the goal is deliberately paused. A pause disarms exactly
   * these sessions' loops, so the dead holder is the EXPECTED consequence of
   * the hold, not evidence of abandonment. Alarming here would report a stop as
   * a crash — the failure `isAdministrativelyPaused` already prevents one layer
   * down, and the reason P-005 has to land before P-004's deactivation.
   */
  it('stays silent on a DELIBERATELY PAUSED goal, however dead its holders', () => {
    const alert = classifyGoalLiveness(
      goal({ status: 'paused' }),
      [holder()],
      vmap(verdict('su-2c130be1', 'ended')),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('stays silent on a goal that is already over (achieved / killed)', () => {
    for (const status of ['achieved', 'killed']) {
      expect(
        classifyGoalLiveness(goal({ status }), [holder()], vmap(verdict('su-2c130be1', 'ended')), NOW),
      ).toBeNull();
    }
  });

  it('an ACTIVE status changes nothing — the exemption is not accidentally universal', () => {
    const alert = classifyGoalLiveness(
      goal({ status: 'active' }),
      [holder()],
      vmap(verdict('su-2c130be1', 'ended')),
      NOW,
    );
    expect(alert?.reason).toBe('abandoned');
  });

  it('reports a goal with no holder row at all as unheld, not abandoned', () => {
    const alert = classifyGoalLiveness(goal(), [], new Map(), NOW);
    expect(alert?.reason).toBe('unheld');
    expect(alert?.holders).toEqual([]);
  });

  it('stays silent while the elected holder is alive', () => {
    const alert = classifyGoalLiveness(
      goal(),
      [
        holder({ ownerId: 'dead', goalLeaseEpoch: 1 }),
        holder({ ownerId: 'alive', goalLeaseEpoch: 2 }),
      ],
      vmap(verdict('dead', 'ended'), verdict('alive', 'live')),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('stays silent inside the grace window — a gap between sessions is not abandonment', () => {
    const alert = classifyGoalLiveness(
      goal({ updatedAtMs: JUST_NOW }),
      [holder({ setAtMs: JUST_NOW })],
      vmap(verdict('su-2c130be1', 'ended')),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('measures darkness from the MOST RECENT evidence, goal row or holder row', () => {
    // Goal row is ancient but someone took the mode recently: not dark.
    const alert = classifyGoalLiveness(
      goal({ updatedAtMs: LONG_AGO }),
      [holder({ setAtMs: JUST_NOW })],
      vmap(verdict('su-2c130be1', 'ended')),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('NEVER infers death from a missing verdict — an unresolvable holder suppresses the alert', () => {
    // resolveSessionStates omits an entry when its fetch degraded. If that read
    // as "dead", one transient DB hiccup would alarm on every goal at once.
    const alert = classifyGoalLiveness(goal(), [holder()], new Map(), NOW);
    expect(alert).toBeNull();
  });

  it('suppresses the alert when only SOME holders are unresolvable', () => {
    const alert = classifyGoalLiveness(
      goal(),
      [
        holder({ ownerId: 'dead', goalLeaseEpoch: 1 }),
        holder({ ownerId: 'unknown', goalLeaseEpoch: 2 }),
      ],
      vmap(verdict('dead', 'ended')),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('allows the elected successor and named predecessor inside the handoff window', () => {
    const alert = classifyGoalLiveness(
      goal(),
      [
        holder({ ownerId: 'old', goalLeaseEpoch: 1 }),
        holder({
          ownerId: 'new',
          goalLeaseEpoch: 2,
          goalHandoffFromOwnerId: 'old',
          goalHandoffExpiresAtMs: NOW + 60_000,
        }),
      ],
      vmap(verdict('old', 'live'), verdict('new', 'live')),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('reports live holder overlap immediately after the elected handoff expires', () => {
    const alert = classifyGoalLiveness(
      goal(),
      [
        holder({ ownerId: 'old', goalLeaseEpoch: 1 }),
        holder({
          ownerId: 'new',
          goalLeaseEpoch: 2,
          goalHandoffFromOwnerId: 'old',
          goalHandoffExpiresAtMs: NOW - 5_000,
        }),
      ],
      vmap(verdict('old', 'live'), verdict('new', 'live')),
      NOW,
    );
    expect(alert).toMatchObject({
      reason: 'overlap',
      darkMs: 5_000,
      holders: [
        { ownerId: 'old', sessionState: 'live' },
        { ownerId: 'new', sessionState: 'live' },
      ],
    });
  });

  it('does not attribute another workspace\'s holder to this goal', () => {
    const alert = classifyGoalLiveness(
      goal(),
      [holder({ workspaceId: 'other-workspace', ownerId: 'alive' })],
      vmap(verdict('alive', 'live')),
      NOW,
    );
    // The live holder belongs to a different workspace, so this goal is unheld.
    expect(alert?.reason).toBe('unheld');
  });

  it('does not attribute a holder pointing at a different goal', () => {
    const alert = classifyGoalLiveness(
      goal(),
      [holder({ goalId: 'some-other-goal', ownerId: 'alive' })],
      vmap(verdict('alive', 'live')),
      NOW,
    );
    expect(alert?.reason).toBe('unheld');
  });
});

describe('scanGoalLiveness — the measured 2026-08-16 population', () => {
  // Reproduces the exact live state that motivated this watchdog: 6 active goals,
  // 2 with live holders, 4 dark. If this ever stops producing 4 alerts the
  // classification changed meaning.
  const goals: GoalRowLike[] = [
    goal({ goalId: 'keep-the-blender-output-loop', title: 'blender', updatedAtMs: JUST_NOW }),
    goal({ goalId: 'the-papercusp-desktop-app-is-verified', title: 'desktop', updatedAtMs: JUST_NOW }),
    goal({ goalId: 'make-sidestage', title: 'sidestage' }),
    goal({ goalId: 'the-gui-chat-surface', title: 'gui chat' }),
    goal({ goalId: 'test-84df0d', title: 'test' }),
    goal({ goalId: 'build-a-website-displaying-cute-bears', title: 'bears' }),
  ];
  const holders: GoalHolderLike[] = [
    holder({ goalId: 'keep-the-blender-output-loop', ownerId: 'su-e9d9bc18' }),
    holder({ goalId: 'the-papercusp-desktop-app-is-verified', ownerId: 'su-b9e0ec11' }),
    holder({ goalId: 'make-sidestage', ownerId: 'su-2c130be1' }),
    holder({ goalId: 'the-gui-chat-surface', ownerId: 'su-89beac53' }),
    holder({ goalId: 'test-84df0d', ownerId: 'su-e7ebadf8' }),
    holder({ goalId: 'build-a-website-displaying-cute-bears', ownerId: 'su-a8689a0b' }),
  ];
  const verdicts = vmap(
    verdict('su-e9d9bc18', 'live'),
    verdict('su-b9e0ec11', 'live'),
    verdict('su-2c130be1', 'ended'),
    verdict('su-89beac53', 'ended'),
    verdict('su-e7ebadf8', 'ended'),
    verdict('su-a8689a0b', 'ended'),
  );

  it('flags exactly the 4 dark goals and neither live one', () => {
    const alerts = scanGoalLiveness(goals, holders, verdicts, NOW);
    expect(alerts.map((a) => a.goalId).sort()).toEqual([
      'build-a-website-displaying-cute-bears',
      'make-sidestage',
      'test-84df0d',
      'the-gui-chat-surface',
    ]);
    expect(alerts.every((a) => a.reason === 'abandoned')).toBe(true);
  });

  // CALIBRATION CONTROL. The scan must be capable of returning nothing — a
  // classifier that always fires would pass the assertion above for the wrong
  // reason.
  it('returns nothing when every holder is live', () => {
    const allLive = vmap(...holders.map((h) => verdict(h.ownerId, 'live')));
    expect(scanGoalLiveness(goals, holders, allLive, NOW)).toEqual([]);
  });

  // FALSIFIABILITY CONTROL, kept permanently in the test file rather than by
  // mutating the shared tree (see CLAUDE.md § proving a guard is falsifiable).
  // This is the naive implementation the whole watchdog exists to replace: it
  // counts holder ROWS instead of resolving liveness. It reports the live state
  // as perfectly healthy — which is exactly the production bug — so if the real
  // classifier ever degrades into row-counting, the assertions above fail while
  // this one still passes, naming the regression.
  it('control: counting holder ROWS instead of resolving liveness sees nothing wrong', () => {
    const rowCountingVerdict = (g: GoalRowLike) =>
      holders.filter((h) => h.goalId === g.goalId).length > 0 ? null : 'unheld';
    expect(goals.map(rowCountingVerdict)).toEqual([null, null, null, null, null, null]);
  });
});

describe('runGoalLivenessSweepOnce', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    readGoals: async () => ({ goals: [goal()], holders: [holder()] }),
    resolveLiveness: async () => vmap(verdict('su-2c130be1', 'ended')),
    // P-005: the readiness leg is injected inert here — its own behavior has a
    // dedicated describe block below.
    readReadiness: async () => new Map<string, GoalReadiness>(),
    escalateReadiness: async () => {},
    // P-002: the portfolio-idle leg injected INERT, same as the readiness leg
    // above and for the same reason — its behaviour has a dedicated describe
    // block. This also keeps the `sql = {}` contract below literally true: the
    // leg's default measurement is the only other PG dep in the sweep.
    readPortfolioThroughput: async () => new Map<string, GoalPortfolioThroughputRead>(),
    escalatePortfolioIdle: async () => {},
    readUnplannedClusters: async () => new Map(),
    fileUnplannedCluster: async () => null,
    flagEnabled: async () => true,
    now: () => NOW,
    graceMs: GOAL_LIVENESS_GRACE_MS,
    ...over,
  });
  const sql = {} as never; // never touched — every PG dep is injected

  it('escalates a dark goal', async () => {
    const seen: GoalLivenessAlert[] = [];
    const r = await runGoalLivenessSweepOnce(sql, {
      ...deps(),
      escalate: async (a) => {
        seen.push(a);
      },
    });
    expect(r).toEqual({
      scanned: 1,
      escalated: 1,
      readinessEscalated: 0,
      autoStarted: 0,
      wedgeEscalated: 0,
      // P-002: a DARK goal is `lost`, not `held`, so the portfolio leg does not
      // judge it — placing nothing is only a finding about a steward who is there.
      portfolioIdleEscalated: 0,
      unplannedClustersFiled: 0,
      skipped: false,
    });
    expect(seen[0]?.reason).toBe('abandoned');
  });

  it('no-ops entirely when the flag is off', async () => {
    let called = false;
    const r = await runGoalLivenessSweepOnce(sql, {
      ...deps({
        flagEnabled: async () => false,
        readGoals: async () => {
          called = true;
          return { goals: [], holders: [] };
        },
      }),
      escalate: async () => {},
    });
    expect(r).toEqual({
      scanned: 0,
      escalated: 0,
      readinessEscalated: 0,
      autoStarted: 0,
      portfolioIdleEscalated: 0,
      wedgeEscalated: 0,
      unplannedClustersFiled: 0,
      skipped: true,
    });
    expect(called).toBe(false); // the kill-switch stops it BEFORE reading the DB
  });

  it('one failing escalation does not cost the rest of the batch', async () => {
    const ok: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await runGoalLivenessSweepOnce(sql, {
      ...deps({
        readGoals: async () => ({
          goals: [goal({ goalId: 'a' }), goal({ goalId: 'b' }), goal({ goalId: 'c' })],
          holders: [
            holder({ goalId: 'a', ownerId: 'x' }),
            holder({ goalId: 'b', ownerId: 'x' }),
            holder({ goalId: 'c', ownerId: 'x' }),
          ],
        }),
        resolveLiveness: async () => vmap(verdict('x', 'ended')),
      }),
      escalate: async (a: GoalLivenessAlert) => {
        if (a.goalId === 'b') throw new Error('escalation surface down');
        ok.push(a.goalId);
      },
    });
    expect(ok).toEqual(['a', 'c']);
    expect(r.escalated).toBe(2);
    // The failure is REPORTED, not swallowed silently — a sweep that quietly
    // dropped an alert would be indistinguishable from a healthy goal.
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('escalate failed for b');
    warn.mockRestore();
  });

  it('does not pay oracle cost for holders pointing at inactive goals', async () => {
    let asked: string[] = [];
    await runGoalLivenessSweepOnce(sql, {
      ...deps({
        readGoals: async () => ({
          goals: [goal({ goalId: 'active-one' })],
          holders: [
            holder({ goalId: 'active-one', ownerId: 'relevant' }),
            holder({ goalId: 'a-closed-goal', ownerId: 'irrelevant' }),
          ],
        }),
        resolveLiveness: async (ids: string[]) => {
          asked = ids;
          return vmap(verdict('relevant', 'ended'));
        },
      }),
      escalate: async () => {},
    });
    expect(asked).toEqual(['relevant']);
  });
});

// ── goal-dag-shared-substrate-2026-08-18 P-005: the readiness leg ──────────
type BlockerView = GoalReadiness['blockers'][number];
const bv = (over: Partial<BlockerView> = {}): BlockerView => ({
  kind: 'goal',
  ref: 'prereq-goal-aa11bb',
  status: 'achieved',
  verdict: 'satisfied',
  ...over,
});
const ready = (blockers: BlockerView[]): GoalReadiness => ({
  actionable: blockers.every((b) => b.verdict === 'satisfied'),
  premiseInvalidated: blockers.some((b) => b.verdict === 'invalidating'),
  blockers,
});

describe('classifyGoalReadiness (P-005)', () => {
  it('offers a BECAME-READY goal: all blockers satisfied, nobody on it', () => {
    const alert = classifyGoalReadiness(goal(), ready([bv()]), 'unheld');
    expect(alert?.kind).toBe('became-ready');
    expect(alert?.blockers).toHaveLength(1);
    // A lost (dead-holder) goal is just as unattended as an unheld one.
    expect(classifyGoalReadiness(goal(), ready([bv()]), 'lost')?.kind).toBe('became-ready');
  });

  it('never offers a goal somebody is ALIVE on — held means no offer needed', () => {
    expect(classifyGoalReadiness(goal(), ready([bv()]), 'held')).toBeNull();
  });

  it("suppresses the offer on UNKNOWN holder liveness — the liveness leg's conservative rule", () => {
    expect(classifyGoalReadiness(goal(), ready([bv()]), 'unknown')).toBeNull();
  });

  it('stays silent on a goal with NO edges — a plain goal was always startable', () => {
    expect(classifyGoalReadiness(goal(), undefined, 'unheld')).toBeNull();
    expect(classifyGoalReadiness(goal(), ready([]), 'unheld')).toBeNull();
  });

  it('offers an edge-less goal only when it explicitly opts into autoStart', () => {
    const g = goal({ launchSettings: { autoStart: true } });
    expect(classifyGoalReadiness(g, ready([]), 'unheld')).toMatchObject({
      kind: 'became-ready',
      blockers: [],
    });
    expect(classifyGoalReadiness(g, ready([]), 'lost')?.kind).toBe('became-ready');
  });

  it('stays silent while a blocker is merely PENDING — waiting is the intended state', () => {
    expect(
      classifyGoalReadiness(goal(), ready([bv({ status: 'active', verdict: 'pending' })]), 'unheld'),
    ).toBeNull();
  });

  it('flags PREMISE-INVALIDATED on a killed blocker, naming only the invalidating ones', () => {
    const alert = classifyGoalReadiness(
      goal(),
      ready([bv(), bv({ ref: 'dead-goal-ff00aa', status: 'killed', verdict: 'invalidating' })]),
      'unheld',
    );
    expect(alert?.kind).toBe('premise-invalidated');
    expect(alert?.blockers.map((b) => b.ref)).toEqual(['dead-goal-ff00aa']);
  });

  it('premise-invalidated fires EVEN WHEN held — a live holder needs the review too', () => {
    const alert = classifyGoalReadiness(
      goal(),
      ready([bv({ ref: 'dead-goal-ff00aa', status: 'killed', verdict: 'invalidating' })]),
      'held',
    );
    expect(alert?.kind).toBe('premise-invalidated');
  });
});

describe('runGoalLivenessSweepOnce — the readiness leg (P-005)', () => {
  const sql = {} as never;
  const base = (over: Record<string, unknown> = {}) => ({
    // Holder dead but INSIDE the grace window: the liveness leg stays silent,
    // so anything escalated here is the readiness leg's own doing.
    readGoals: async () => ({
      goals: [goal({ updatedAtMs: NOW - 60_000 })],
      holders: [],
    }),
    resolveLiveness: async () => new Map(),
    escalate: async () => {},
    flagEnabled: async () => true,
    now: () => NOW,
    graceMs: GOAL_LIVENESS_GRACE_MS,
    ...over,
  });

  it('escalates a became-ready goal through the readiness surface', async () => {
    const seen: GoalReadinessAlert[] = [];
    const g = goal({ updatedAtMs: NOW - 60_000 });
    const r = await runGoalLivenessSweepOnce(sql, {
      ...base(),
      readReadiness: async () => new Map([[goalReadinessKey(g), ready([bv()])]]),
      escalateReadiness: async (a) => {
        seen.push(a);
      },
    });
    expect(r.readinessEscalated).toBe(1);
    expect(r.escalated).toBe(0); // the liveness leg had nothing to say
    expect(seen[0]?.kind).toBe('became-ready');
  });

  it('a readiness-escalation failure is contained and reported, never fatal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = goal({ updatedAtMs: NOW - 60_000 });
    const r = await runGoalLivenessSweepOnce(sql, {
      ...base(),
      readReadiness: async () => new Map([[goalReadinessKey(g), ready([bv()])]]),
      escalateReadiness: async () => {
        throw new Error('escalation surface down');
      },
    });
    expect(r.readinessEscalated).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('readiness escalate failed');
    warn.mockRestore();
  });

  it('an empty readiness map escalates nothing — ordinary edge-less goals stay quiet', async () => {
    const r = await runGoalLivenessSweepOnce(sql, {
      ...base(),
      readReadiness: async () => new Map(),
      escalateReadiness: async () => {
        throw new Error('must not be called');
      },
    });
    expect(r.readinessEscalated).toBe(0);
  });

  it('default readiness synthesizes [] for autoStart and leaves a plain no-edge goal quiet', async () => {
    const auto = goal({
      goalId: 'auto-start-no-edges',
      updatedAtMs: NOW - 60_000,
      launchSettings: { autoStart: true },
    });
    const plain = goal({
      goalId: 'plain-no-edges',
      updatedAtMs: NOW - 60_000,
    });
    // The default reader only needs an empty edge query for this regression.
    const sql = vi.fn(async () => []) as never;
    const startGoal = vi.fn(async () => ({
      ok: true as const,
      goalId: auto.goalId,
      ownerId: 'su-auto-held-no-edge',
      warnings: [],
      startBlockedOverride: null,
    }));
    const escalateReadiness = vi.fn(async () => {});
    const r = await runGoalLivenessSweepOnce(sql, {
      readGoals: async () => ({ goals: [auto, plain], holders: [] }),
      resolveLiveness: async () => new Map(),
      escalate: async () => {},
      escalateReadiness,
      startGoal,
      flagEnabled: async () => true,
      now: () => NOW,
      graceMs: GOAL_LIVENESS_GRACE_MS,
    });

    expect(r.autoStarted).toBe(1);
    expect(r.readinessEscalated).toBe(0);
    expect(startGoal).toHaveBeenCalledWith({
      workspaceId: auto.workspaceId,
      goalId: auto.goalId,
      launcherOwnerId: 'goal-liveness-watchdog:auto-start',
    });
    expect(escalateReadiness).not.toHaveBeenCalled();
  });
});

// ── work-on-everything-goal-2026-08-23 P-020: the autoStart leg ────────────

describe('runGoalLivenessSweepOnce — the autoStart leg (P-020)', () => {
  const sql = {} as never;
  const autoGoal = (over: Partial<GoalRowLike> = {}) =>
    goal({ updatedAtMs: NOW - 60_000, launchSettings: { autoStart: true }, ...over });
  const base = (g: GoalRowLike, over: Record<string, unknown> = {}) => ({
    readGoals: async () => ({ goals: [g], holders: [] }),
    resolveLiveness: async () => new Map(),
    escalate: async () => {},
    readReadiness: async () => new Map([[goalReadinessKey(g), ready([bv()])]]),
    flagEnabled: async () => true,
    now: () => NOW,
    graceMs: GOAL_LIVENESS_GRACE_MS,
    ...over,
  });

  it('dispatches a became-ready autoStart goal through the primitive and suppresses the offer', async () => {
    const g = autoGoal();
    const startGoal = vi.fn(async () => ({
      ok: true as const,
      goalId: g.goalId,
      ownerId: 'su-auto-held-1',
      warnings: [],
      startBlockedOverride: null,
    }));
    const r = await runGoalLivenessSweepOnce(sql, {
      ...base(g),
      startGoal,
      escalateReadiness: async () => {
        throw new Error('the offer must be suppressed after a successful dispatch');
      },
    });
    expect(r.autoStarted).toBe(1);
    expect(r.readinessEscalated).toBe(0);
    expect(startGoal).toHaveBeenCalledWith({
      workspaceId: g.workspaceId,
      goalId: g.goalId,
      launcherOwnerId: 'goal-liveness-watchdog:auto-start',
    });
  });

  it('a primitive refusal falls through to the offer, carrying WHY the dispatch declined', async () => {
    const g = autoGoal();
    const seen: GoalReadinessAlert[] = [];
    const r = await runGoalLivenessSweepOnce(sql, {
      ...base(g),
      startGoal: vi.fn(async () => ({
        ok: false as const,
        reason: 'already-held' as never,
        detail: 'live holder su-elsewhere',
      })),
      escalateReadiness: async (a) => {
        seen.push(a);
      },
    });
    expect(r.autoStarted).toBe(0);
    expect(r.readinessEscalated).toBe(1);
    expect(seen[0]?.autoStartFailure).toBe('refused: already-held — live holder su-elsewhere');
  });

  it('a thrown launch failure is contained: the offer still surfaces, naming the throw', async () => {
    const g = autoGoal();
    const seen: GoalReadinessAlert[] = [];
    const r = await runGoalLivenessSweepOnce(sql, {
      ...base(g),
      startGoal: vi.fn(async () => {
        throw new Error('spawn infra down');
      }),
      escalateReadiness: async (a) => {
        seen.push(a);
      },
    });
    expect(r.autoStarted).toBe(0);
    expect(r.readinessEscalated).toBe(1);
    expect(seen[0]?.autoStartFailure).toBe('launch threw: spawn infra down');
  });

  it('without the opt-in the offer stays an offer — no dispatch (D-003 preserved)', async () => {
    const g = goal({ updatedAtMs: NOW - 60_000 }); // no launchSettings at all
    const startGoal = vi.fn();
    const seen: GoalReadinessAlert[] = [];
    const r = await runGoalLivenessSweepOnce(sql, {
      ...base(g),
      startGoal,
      escalateReadiness: async (a) => {
        seen.push(a);
      },
    });
    expect(startGoal).not.toHaveBeenCalled();
    expect(r.autoStarted).toBe(0);
    expect(seen[0]?.kind).toBe('became-ready');
    expect(seen[0]?.autoStartFailure).toBeUndefined();
  });

  it('premise-invalidated NEVER auto-starts, opt-in or not — a killed blocker needs review (D-002)', async () => {
    const g = autoGoal();
    const startGoal = vi.fn();
    const seen: GoalReadinessAlert[] = [];
    const r = await runGoalLivenessSweepOnce(sql, {
      ...base(g, {
        readReadiness: async () =>
          new Map([
            [
              goalReadinessKey(g),
              ready([bv({ ref: 'dead-goal-ff00aa', status: 'killed', verdict: 'invalidating' })]),
            ],
          ]),
      }),
      startGoal,
      escalateReadiness: async (a) => {
        seen.push(a);
      },
    });
    expect(startGoal).not.toHaveBeenCalled();
    expect(r.autoStarted).toBe(0);
    expect(seen[0]?.kind).toBe('premise-invalidated');
  });
});

// ── goal-live-holder-guarantee-2026-08-18 P-009: bounded recovery ──────────

function respawnGoal(overrides: Partial<GoalRowLike> = {}): GoalRowLike {
  return goal({
    status: 'active',
    installSlug: 'papercusp',
    launchSettings: { holder: { requireLive: true, onLoss: 'respawn' } },
    ...overrides,
  });
}

function respawnDeps(overrides: Partial<GoalHolderRespawnDeps> = {}): GoalHolderRespawnDeps {
  const target = respawnGoal();
  return {
    readGoals: async () => ({ goals: [target], holders: [holder()] }),
    resolveLiveness: async () => vmap(verdict('su-2c130be1', 'ended')),
    flagEnabled: async () => true,
    launch: async (g) => ({ ownerId: `replacement-${g.goalId}`, warnings: [] }),
    attach: async () => {},
    readAuthority: async () => ({
      status: 'none',
      goalId: null,
      electedOwnerId: null,
      electedEpoch: null,
      handoffExpiresAt: null,
    }),
    neutralize: async () => {},
    notifyHandoff: async () => {},
    refreshControlAnchor: vi.fn().mockResolvedValue(null),
    reserveRateSlot: async () => ({ kind: 'reserved', attemptsInWindow: 1 }),
    // Every SQL-touching seam is stubbed here because `sql` is a bare `{}` stub. The
    // latch reconciler runs for EVERY swept goal (that is the point of it — see the
    // EI-23821882158913073 block at the bottom), so without a stub it issues a real
    // query against that stub and warns on every unrelated test in this file.
    reconcileStrandedLatch: async () => ({ kind: 'noop' }),
    // WI-10005573: same reason — the superseded-holder reaper runs for every
    // swept goal and would otherwise query the bare `{}` SQL stub.
    retireSuperseded: async () => ({ retired: [], leftArmed: [], awaitsCancelled: 0, claimsReleased: [] }),
    pauseNeedsHuman: async () => true,
    escalateGiveUp: async () => {},
    // Existing holder-recovery cases model a completed first turn. Without an
    // explicit attestation, the production default reads the live ledger via
    // the bare SQL stub and correctly returns unknown rather than clearing
    // re-kick and capacity-deferral state.
    attestHolder: async (g, elected) => ({
      status: 'complete',
      workspaceId: g.workspaceId,
      goalId: g.goalId,
      ownerId: elected.ownerId,
      modeSetAt: new Date(elected.setAtMs).toISOString(),
      loopActive: true,
      checkpointAt: new Date(elected.setAtMs).toISOString(),
      portfolioAct: { tool: 'goals:get', at: new Date(elected.setAtMs).toISOString() },
      missing: [],
      unavailable: [],
    }),
    // WI-2140573 finding 5: the default assessor reads live accounts:status; a
    // unit fixture measures capacity as clear unless a test says otherwise.
    assessLaunchCapacity: async () => ({
      kind: 'clear',
      target: { provider: 'claude', accountId: null, agent: 'claude' },
      reason: 'fixture: capacity clear',
    }),
    escalateCapacityDeferral: async () => {},
    capacityDeferrals: new Map(),
    // WI-10005559: these fixtures exercise recovery itself, so a first lost
    // tick acts. The loss-confirmation window has its own tests below.
    lossConfirmMs: 0,
    lossObservations: new Map(),
    now: () => NOW,
    states: new Map(),
    ...overrides,
  };
}

const respawnContractScenarios = [
  'elected-loss-recovery',
  'live-holder-no-double-spawn',
  'concurrent-takeover-refusal',
  'successful-recovery-control',
] as const;
type RespawnContractScenario = typeof respawnContractScenarios[number];
const respawnContractControl = process.env.PAPERCUSP_GOAL_RESPAWN_CONTROL;
if (respawnContractControl && !respawnContractScenarios.includes(respawnContractControl as RespawnContractScenario)) {
  throw new Error(`Unknown permanent goal respawn control: ${respawnContractControl}`);
}

async function observeRespawnContract(scenario: RespawnContractScenario, wrong = false) {
  const target = respawnGoal();
  const live = scenario === 'live-holder-no-double-spawn';
  const takeover = scenario === 'concurrent-takeover-refusal';
  const elected = holder({ ownerId: 'elected', goalLeaseEpoch: 2, setAtMs: JUST_NOW });
  const historical = holder({ ownerId: 'historical', goalLeaseEpoch: 1 });
  const launch = vi.fn(async () => ({ ownerId: 'replacement', warnings: [] }));
  const neutralize = vi.fn(async () => {});
  const attach = vi.fn<GoalHolderRespawnDeps['attach']>(async () => {
    if ((takeover && !wrong) || (scenario === 'successful-recovery-control' && wrong)) {
      throw new Error('lease changed during launch');
    }
  });
  // Reverse one documented seam per control. Production folding, recovery,
  // expected-lease forwarding and attach reconciliation still execute.
  const electedState = wrong && (live || scenario === 'elected-loss-recovery')
    ? (live ? 'ended' : 'live') : (live ? 'live' : 'ended');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const result = await runGoalHolderRespawnOnce({} as never, respawnDeps({
      readGoals: async () => ({ goals: [target], holders: [historical, elected] }),
      resolveLiveness: async () => vmap(verdict('historical', 'live'), verdict('elected', electedState)),
      launch, attach, neutralize,
      readAuthority: async () => ({
        status: 'superseded', goalId: target.goalId, electedOwnerId: 'legitimate-takeover',
        electedEpoch: 3, handoffExpiresAt: null,
      }),
    }));
    return {
      launches: launch.mock.calls.length,
      respawned: result.respawned,
      attachFailed: result.attachFailed,
      neutralized: neutralize.mock.calls.length,
      expectedLease: attach.mock.calls[0]?.[2] ?? null,
    };
  } finally {
    warn.mockRestore();
  }
}

describe('goal respawn causal contracts (WI-1074216)', () => {
  it('respawn calibration: the running elected lease is left alone', async () => {
    expect(await observeRespawnContract('live-holder-no-double-spawn')).toEqual({
      launches: 0, respawned: 0, attachFailed: 0, neutralized: 0, expectedLease: null,
    });
  });

  it.each(respawnContractScenarios)('repaired respawn contract: %s', async (scenario) => {
    const live = scenario === 'live-holder-no-double-spawn';
    const takeover = scenario === 'concurrent-takeover-refusal';
    expect(await observeRespawnContract(scenario, respawnContractControl === scenario),
      `respawn-contract:${scenario}`).toEqual({
      launches: live ? 0 : 1,
      respawned: live || takeover ? 0 : 1,
      attachFailed: takeover ? 1 : 0,
      neutralized: takeover ? 1 : 0,
      expectedLease: live ? null : { ownerId: 'elected', epoch: 2 },
    });
  });

  it.each(respawnContractScenarios)('detects permanent wrong-seam control: %s', async (scenario) => {
    const live = scenario === 'live-holder-no-double-spawn';
    const takeover = scenario === 'concurrent-takeover-refusal';
    const expected = {
      launches: live ? 0 : 1,
      respawned: live || takeover ? 0 : 1,
      attachFailed: takeover ? 1 : 0,
      neutralized: takeover ? 1 : 0,
      expectedLease: live ? null : { ownerId: 'elected', epoch: 2 },
    };
    // Calibrate the same fixture before observing the deliberate wrong seam.
    expect(await observeRespawnContract(scenario)).toEqual(expected);
    expect(await observeRespawnContract(scenario, true)).not.toEqual(expected);
  });
});

describe('goal holder respawn eligibility (P-009)', () => {
  it('requires an ACTIVE goal that explicitly earns respawn', () => {
    expect(goalEligibleForHolderRespawn(respawnGoal())).toBe(true);
    // requireLive inherits true, but onLoss never inherits respawn.
    expect(goalEligibleForHolderRespawn(respawnGoal({ launchSettings: { holder: { onLoss: 'respawn' } } }))).toBe(true);

    expect(goalEligibleForHolderRespawn(goal({ status: 'active' }))).toBe(false);
    expect(goalEligibleForHolderRespawn(respawnGoal({ launchSettings: { holder: { onLoss: 'deactivate' } } }))).toBe(
      false,
    );
    expect(
      goalEligibleForHolderRespawn(
        respawnGoal({
          launchSettings: { holder: { requireLive: false, onLoss: 'respawn' } },
        }),
      ),
    ).toBe(false);
  });

  it('never respawns a paused or terminal goal', () => {
    for (const status of ['paused', 'achieved', 'killed']) {
      expect(goalEligibleForHolderRespawn(respawnGoal({ status }))).toBe(false);
    }
  });

  it('pins the recovery flag as a separate owner-authority dark flag', () => {
    expect(FLAGS.GOAL_HOLDER_RESPAWN).toBe('papercusp-goal-holder-respawn');
    expect(FLAG_DEFAULTS[FLAGS.GOAL_HOLDER_RESPAWN]).toBe(false);
    expect(DARK_FLAGS.get(FLAGS.GOAL_HOLDER_RESPAWN)?.case).toBe('owner-authority');
  });
});

describe('runGoalHolderRespawnOnce (P-009)', () => {
  const sql = {} as never;

  it('launches first and attaches the returned identity for a lost holder', async () => {
    const target = respawnGoal();
    const operations: string[] = [];
    const refreshControlAnchor = vi.fn().mockResolvedValue(null);
    const result = await runGoalHolderRespawnOnce(
      sql,
      respawnDeps({
        readGoals: async () => ({ goals: [target], holders: [holder()] }),
        launch: async () => {
          operations.push('launch');
          return { ownerId: 'su-replacement', warnings: [] };
        },
        attach: async (g, ownerId) => {
          operations.push(`attach:${g.goalId}:${ownerId}`);
        },
        refreshControlAnchor,
      }),
    );

    expect(operations).toEqual(['launch', `attach:${target.goalId}:su-replacement`]);
    expect(refreshControlAnchor).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'su-replacement',
        workspaceId: target.workspaceId,
        origin: 'system',
        actorId: 'goal-holder-respawner',
        source: 'mode:set',
        ownerDirected: false,
        sql,
      }),
    );
    expect(result).toEqual({
      scanned: 1,
      eligible: 1,
      attempted: 1,
      respawned: 1,
      launchFailed: 0,
      launchRefused: 0,
      launchUnhonored: 0,
      attachFailed: 0,
      attachUnresolved: 0,
      neutralizeFailed: 0,
      gaveUp: 0,
      rekicked: 0,
      partialFirstTurn: 0,
      deferredCapacity: 0,
      lossUnconfirmed: 0,
      skipped: false,
    });
  });

  it('does no read or launch when its independent flag is off', async () => {
    const readGoals = vi.fn(async () => ({ goals: [], holders: [] }));
    const launch = vi.fn(async () => ({ ownerId: 'must-not-launch', warnings: [] }));
    const result = await runGoalHolderRespawnOnce(
      sql,
      respawnDeps({
        flagEnabled: async () => false,
        readGoals,
        launch,
      }),
    );

    expect(result.skipped).toBe(true);
    expect(readGoals).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('does not auto-start a never-started unheld goal or infer loss from unknown liveness', async () => {
    const unheld = respawnGoal({ goalId: 'unheld' });
    const unknown = respawnGoal({ goalId: 'unknown' });
    const launch = vi.fn(async () => ({ ownerId: 'must-not-launch', warnings: [] }));
    const result = await runGoalHolderRespawnOnce(
      sql,
      respawnDeps({
        readGoals: async () => ({
          goals: [unheld, unknown],
          holders: [holder({ goalId: unknown.goalId, ownerId: 'unresolved-holder' })],
        }),
        resolveLiveness: async () => new Map(),
        launch,
      }),
    );

    expect(result).toMatchObject({ scanned: 2, eligible: 2, attempted: 0, respawned: 0 });
    expect(launch).not.toHaveBeenCalled();
  });

  it('recovers a started goal whose durable GOAL-mode row was lost', async () => {
    const target = respawnGoal({
      goalId: 'started-but-row-lost',
      startedHolderOwnerId: 'su-former-holder',
    });
    const launch = vi.fn(async () => ({ ownerId: 'su-replacement', warnings: [] }));
    const attach = vi.fn(async () => {});

    const result = await runGoalHolderRespawnOnce(
      sql,
      respawnDeps({
        readGoals: async () => ({ goals: [target], holders: [] }),
        resolveLiveness: vi.fn(async () => new Map()),
        launch,
        attach,
      }),
    );

    expect(result).toMatchObject({ scanned: 1, eligible: 1, attempted: 1, respawned: 1 });
    expect(launch).toHaveBeenCalledWith(target);
    expect(attach).toHaveBeenCalledWith(target, 'su-replacement', null);
  });

  it('never attaches a phantom holder when launch fails', async () => {
    const attach = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const states: GoalHolderRespawnDeps['states'] = new Map();
    const target = respawnGoal();
    try {
      const result = await runGoalHolderRespawnOnce(
        sql,
        respawnDeps({
          states,
          readGoals: async () => ({ goals: [target], holders: [holder()] }),
          launch: async () => {
            throw new Error('launcher refused');
          },
          attach,
        }),
      );

      expect(result).toMatchObject({ attempted: 1, launchFailed: 1, attachFailed: 0, respawned: 0 });
      expect(attach).not.toHaveBeenCalled();
      expect(warn.mock.calls[0]?.[0]).toContain('launch failed');
      const state = states.get(goalHolderRespawnKey(target));
      expect(state?.restarts).toEqual([]);
      expect(state?.lastRestartAt).toBeNull();
      expect(state?.lastAttemptAt).not.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('returns the rate slot when launch policy refuses before minting a process (WI-10004329)', async () => {
    // Measured 2026-09-30 on goal 60d3a8: six budget-unmeasurable refusals in
    // five minutes filled the 6-per-hour cap with zero holders launched, and the
    // cap escalation reported them as recoveries.
    const attach = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reserveRateSlot = vi.fn(async () => ({ kind: 'reserved' as const, attemptsInWindow: 1 }));
    const releaseRateSlot = vi.fn(async () => true);
    const target = respawnGoal();
    try {
      const result = await runGoalHolderRespawnOnce(
        sql,
        respawnDeps({
          readGoals: async () => ({ goals: [target], holders: [holder()] }),
          reserveRateSlot,
          releaseRateSlot,
          launch: async () => {
            throw new GoalHolderLaunchPolicyRefusedError(target.goalId, {
              reason: 'goal_budget_unmeasurable',
              limit: 50_000,
              current: null,
              requested: 0,
              message: 'spend cannot be measured',
              currentScope: 'goal budget window',
            });
          },
          attach,
        }),
      );

      expect(result).toMatchObject({ attempted: 1, launchRefused: 1, launchFailed: 0, respawned: 0 });
      expect(attach).not.toHaveBeenCalled();
      expect(releaseRateSlot).toHaveBeenCalledTimes(1);
      // The slot returned is exactly the one reserved this tick.
      const reservedAtMs = (reserveRateSlot.mock.calls[0] as unknown as [unknown, number])[1];
      expect(releaseRateSlot).toHaveBeenCalledWith(target, reservedAtMs);
      expect(warn.mock.calls.some((call) => String(call[0]).includes('refused by policy'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the rate slot spent when a launch fails for any other reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const releaseRateSlot = vi.fn(async () => true);
    const target = respawnGoal();
    try {
      const result = await runGoalHolderRespawnOnce(
        sql,
        respawnDeps({
          readGoals: async () => ({ goals: [target], holders: [holder()] }),
          releaseRateSlot,
          launch: async () => {
            throw new Error('goal-holder-launch refused for goal-1: kickoff could not be built');
          },
        }),
      );

      expect(result).toMatchObject({ attempted: 1, launchFailed: 1, launchRefused: 0 });
      expect(releaseRateSlot).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('contains one attach failure and continues recovering the rest of the batch', async () => {
    const a = respawnGoal({ goalId: 'goal-a' });
    const b = respawnGoal({ goalId: 'goal-b' });
    const attached: string[] = [];
    const states: GoalHolderRespawnDeps['states'] = new Map();
    const neutralize = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runGoalHolderRespawnOnce(
        sql,
        respawnDeps({
          readGoals: async () => ({
            goals: [a, b],
            holders: [holder({ goalId: a.goalId, ownerId: 'dead-a' }), holder({ goalId: b.goalId, ownerId: 'dead-b' })],
          }),
          states,
          resolveLiveness: async (ownerIds) => vmap(...ownerIds.map((ownerId) => verdict(ownerId, 'ended'))),
          launch: async (g) => ({ ownerId: `replacement-${g.goalId}`, warnings: [] }),
          attach: async (g) => {
            attached.push(g.goalId);
            if (g.goalId === a.goalId) throw new Error('mode store unavailable');
          },
          neutralize,
        }),
      );

      expect(attached).toEqual(['goal-a', 'goal-b']);
      expect(result).toMatchObject({ attempted: 2, respawned: 1, attachFailed: 1 });
      expect(neutralize).toHaveBeenCalledWith(
        a,
        `replacement-${a.goalId}`,
        expect.stringContaining('mode store unavailable'),
      );
      expect(warn.mock.calls[0]?.[0]).toContain('attach failed for goal-a');
      expect(states.get(goalHolderRespawnKey(a))?.restarts).toEqual([]);
      expect(states.get(goalHolderRespawnKey(a))?.lastRestartAt).toBeNull();
      expect(states.get(goalHolderRespawnKey(b))?.restarts).toHaveLength(1);
      expect(states.get(goalHolderRespawnKey(b))?.lastRestartAt).not.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('preserves a replacement when attach throws after the election committed', async () => {
    const target = respawnGoal({ goalId: 'commit-then-throw' });
    const neutralize = vi.fn(async () => {});
    const refreshControlAnchor = vi.fn().mockResolvedValue(null);
    const states: GoalHolderRespawnDeps['states'] = new Map();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runGoalHolderRespawnOnce(
        sql,
        respawnDeps({
          readGoals: async () => ({
            goals: [target],
            holders: [holder({ goalId: target.goalId, ownerId: 'dead-old', goalLeaseEpoch: 4 })],
          }),
          resolveLiveness: async () => vmap(verdict('dead-old', 'ended')),
          states,
          launch: async () => ({ ownerId: 'su-replacement', warnings: [] }),
          attach: async () => {
            throw new Error('connection dropped after COMMIT');
          },
          readAuthority: async () => ({
            status: 'elected',
            goalId: target.goalId,
            electedOwnerId: 'su-replacement',
            electedEpoch: 5,
            handoffExpiresAt: '2026-08-30T10:00:00.000Z',
          }),
          neutralize,
          refreshControlAnchor,
        }),
      );

      expect(result).toMatchObject({ respawned: 1, attachFailed: 0, neutralizeFailed: 0 });
      expect(neutralize).not.toHaveBeenCalled();
      expect(refreshControlAnchor).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'su-replacement', workspaceId: target.workspaceId }),
      );
      expect(states.get(goalHolderRespawnKey(target))?.restarts).toHaveLength(1);
      expect(warn.mock.calls.some((call) => String(call[0]).includes('durable readback confirms'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves an unreadable attach outcome unresolved without neutralizing or counting success', async () => {
    const target = respawnGoal({ goalId: 'unreadable-attach-readback' });
    const neutralize = vi.fn(async () => {});
    const refreshControlAnchor = vi.fn().mockResolvedValue(null);
    const states: GoalHolderRespawnDeps['states'] = new Map();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runGoalHolderRespawnOnce(
        sql,
        respawnDeps({
          readGoals: async () => ({
            goals: [target],
            holders: [holder({ goalId: target.goalId, ownerId: 'dead-old', goalLeaseEpoch: 4 })],
          }),
          resolveLiveness: async () => vmap(verdict('dead-old', 'ended')),
          states,
          launch: async () => ({ ownerId: 'su-replacement', warnings: [] }),
          attach: async () => {
            throw new Error('connection dropped after unknown commit state');
          },
          readAuthority: async () => {
            throw new Error('authority store unavailable');
          },
          neutralize,
          refreshControlAnchor,
        }),
      );

      expect(result).toMatchObject({
        respawned: 0,
        attachFailed: 1,
        attachUnresolved: 1,
        neutralizeFailed: 0,
      });
      expect(neutralize).not.toHaveBeenCalled();
      expect(refreshControlAnchor).not.toHaveBeenCalled();
      expect(states.get(goalHolderRespawnKey(target))?.restarts).toEqual([]);
      expect(warn.mock.calls.some((call) => String(call[0]).includes('UNRESOLVED'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('uses shared backoff, gives up after six attempts, and latches the escalation', async () => {
    const states: GoalHolderRespawnDeps['states'] = new Map();
    let nowMs = 0;
    const launch = vi.fn(async () => ({ ownerId: 'replacement', warnings: [] }));
    const attach = vi.fn(async () => {});
    const escalateGiveUp = vi.fn(async () => {});
    const deps = respawnDeps({ states, now: () => nowMs, launch, attach, escalateGiveUp });

    for (const attemptAt of [0, 1_000, 6_000, 21_000, 81_000, 141_000]) {
      nowMs = attemptAt;
      const result = await runGoalHolderRespawnOnce(sql, deps);
      expect(result.attempted).toBe(1);
    }
    nowMs = 201_000;
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ attempted: 0, gaveUp: 1 });
    nowMs = 261_000;
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ attempted: 0, gaveUp: 0 });

    expect(launch).toHaveBeenCalledTimes(6);
    expect(attach).toHaveBeenCalledTimes(6);
    expect(escalateGiveUp).toHaveBeenCalledOnce();
    expect(escalateGiveUp).toHaveBeenCalledWith(expect.anything(), 6);
  });

  it('halts at the durable hourly cap even after process-local damping state is lost', async () => {
    const launch = vi.fn(async () => ({ ownerId: 'must-not-launch', warnings: [] }));
    const escalateGiveUp = vi.fn(async () => {});
    const pauseNeedsHuman = vi.fn(async () => true);

    const result = await runGoalHolderRespawnOnce(
      sql,
      respawnDeps({
        states: new Map(),
        launch,
        reserveRateSlot: async () => ({ kind: 'capped', attemptsInWindow: 6 }),
        escalateGiveUp,
        pauseNeedsHuman,
      }),
    );

    expect(result).toMatchObject({ attempted: 0, respawned: 0, gaveUp: 1 });
    expect(launch).not.toHaveBeenCalled();
    expect(escalateGiveUp).toHaveBeenCalledWith(expect.anything(), 6);
    expect(pauseNeedsHuman).toHaveBeenCalledWith(expect.anything(), 6, NOW);
  });

  it('does not report a give-up when the capped goal pause matches no row', async () => {
    const target = respawnGoal();
    const key = goalHolderRespawnKey(target);
    const states: GoalHolderRespawnDeps['states'] = new Map();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runGoalHolderRespawnOnce(
        sql,
        respawnDeps({
          states,
          reserveRateSlot: async () => ({ kind: 'capped', attemptsInWindow: 6 }),
          pauseNeedsHuman: async () => false,
        }),
      );

      expect(result).toMatchObject({ attempted: 0, gaveUp: 0 });
      expect(states.get(key)?.gaveUp).toBe(false);
      expect(warn.mock.calls.some(([message]) =>
        String(message).includes('needs-human pause matched no active, flagged goal row')))
        .toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('retries a failed give-up escalation instead of silently keeping its latch', async () => {
    const target = respawnGoal();
    const key = goalHolderRespawnKey(target);
    const states: GoalHolderRespawnDeps['states'] = new Map([
      [
        key,
        {
          restarts: [1, 2, 3, 4, 5, 6],
          backoffIndex: 3,
          lastAttemptAt: 6,
          lastRestartAt: 6,
          healthySince: null,
          gaveUp: false,
        },
      ],
    ]);
    let escalationCalls = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = respawnDeps({
      readGoals: async () => ({ goals: [target], holders: [holder()] }),
      states,
      now: () => 60_006,
      escalateGiveUp: async () => {
        escalationCalls += 1;
        if (escalationCalls === 1) throw new Error('escalation store unavailable');
      },
    });
    try {
      expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ gaveUp: 0 });
      expect(states.get(key)?.gaveUp).toBe(false);
      expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ gaveUp: 1 });
      expect(states.get(key)?.gaveUp).toBe(true);
      expect(escalationCalls).toBe(2);
      expect(warn.mock.calls[0]?.[0]).toContain('give-up escalation failed');
    } finally {
      warn.mockRestore();
    }
  });

  it('clears give-up only after five continuous healthy minutes, then may recover again', async () => {
    const target = respawnGoal();
    const key = goalHolderRespawnKey(target);
    const states: GoalHolderRespawnDeps['states'] = new Map([
      [
        key,
        {
          restarts: [1, 2, 3, 4, 5, 6],
          backoffIndex: 3,
          lastAttemptAt: 6,
          lastRestartAt: 6,
          healthySince: null,
          gaveUp: true,
        },
      ],
    ]);
    let nowMs = 1_000;
    let holderState: SessionState = 'live';
    const launch = vi.fn(async () => ({ ownerId: 'replacement', warnings: [] }));
    const deps = respawnDeps({
      readGoals: async () => ({ goals: [target], holders: [holder()] }),
      resolveLiveness: async () => vmap(verdict('su-2c130be1', holderState)),
      states,
      now: () => nowMs,
      launch,
    });

    await runGoalHolderRespawnOnce(sql, deps);
    expect(states.get(key)?.gaveUp).toBe(true);
    nowMs += 5 * 60_000;
    await runGoalHolderRespawnOnce(sql, deps);
    expect(states.get(key)).toMatchObject({
      gaveUp: false,
      restarts: [],
      backoffIndex: 0,
      lastRestartAt: null,
    });

    holderState = 'ended';
    nowMs += 1;
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ attempted: 1, respawned: 1 });
    expect(launch).toHaveBeenCalledOnce();
  });
});

/* ── the wedge leg: held, alive, and producing nothing ────────────────────── */

describe('classifyGoalWedge', () => {
  const GOAL_ID = 'make-sidestage-web-ios-and-android-ready-for-pub-dd62af';
  const KEY = `papercusp-workspace:${GOAL_ID}`;
  const HELD_LONG_ENOUGH = NOW - (GOAL_HOLDER_PRODUCTIVITY_GRACE_MS + 60_000);
  const live = vmap(verdict('su-2c130be1', 'live'));

  it('reports a live holder that has produced nothing past the grace', () => {
    const alert = classifyGoalWedge(
      goal(),
      [holder({ setAtMs: HELD_LONG_ENOUGH })],
      live,
      new Map([[KEY, 0]]),
      NOW,
    );
    expect(alert).toMatchObject({
      goalId: GOAL_ID,
      agentOriginCalls: 0,
      holders: [{ ownerId: 'su-2c130be1', sessionState: 'live' }],
    });
  });

  it('stays silent when the holder HAS produced agent-origin work', () => {
    const alert = classifyGoalWedge(
      goal(),
      [holder({ setAtMs: HELD_LONG_ENOUGH })],
      live,
      new Map([[KEY, 1]]),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('stays silent inside the grace window', () => {
    const alert = classifyGoalWedge(
      goal(),
      [holder({ setAtMs: NOW - 60_000 })],
      live,
      new Map([[KEY, 0]]),
      NOW,
    );
    expect(alert).toBeNull();
  });

  // The distinction the whole leg turns on: an ABSENT measurement is not a
  // passing one. A degraded read must report nothing, not everyone wedged.
  it('stays silent when productivity was NOT MEASURED (absent key, not zero)', () => {
    const alert = classifyGoalWedge(
      goal(),
      [holder({ setAtMs: HELD_LONG_ENOUGH })],
      live,
      new Map(),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('only asks the question of a HELD goal — a dead or absent holder is the liveness leg', () => {
    const dead = vmap(verdict('su-2c130be1', 'ended'));
    expect(
      classifyGoalWedge(
        goal(),
        [holder({ setAtMs: HELD_LONG_ENOUGH })],
        dead,
        new Map([[KEY, 0]]),
        NOW,
      ),
    ).toBeNull();
    // unheld: no holder rows at all
    expect(classifyGoalWedge(goal(), [], live, new Map([[KEY, 0]]), NOW)).toBeNull();
    // unknown: the oracle returned no verdict, which is not evidence of anything
    expect(
      classifyGoalWedge(
        goal(),
        [holder({ setAtMs: HELD_LONG_ENOUGH })],
        new Map(),
        new Map([[KEY, 0]]),
        NOW,
      ),
    ).toBeNull();
  });

  it('exempts a deliberately paused goal — it produces nothing BY DESIGN', () => {
    const alert = classifyGoalWedge(
      goal({ status: 'paused' }),
      [holder({ setAtMs: HELD_LONG_ENOUGH })],
      live,
      new Map([[KEY, 0]]),
      NOW,
    );
    expect(alert).toBeNull();
  });

  // Conservative pairing: calls counted since the EARLIEST hold, grace measured
  // from the MOST RECENT one — so a fresh holder re-arms the window rather than
  // inheriting a predecessor's silence.
  it('re-arms the grace from the MOST RECENT hold when a second holder joins', () => {
    const holders = [
      holder({ ownerId: 'su-old', setAtMs: HELD_LONG_ENOUGH }),
      holder({ ownerId: 'su-new', setAtMs: NOW - 60_000 }),
    ];
    const verdicts = vmap(verdict('su-old', 'live'), verdict('su-new', 'live'));
    expect(classifyGoalWedge(goal(), holders, verdicts, new Map([[KEY, 0]]), NOW)).toBeNull();
  });
});

describe('the wedge leg inside runGoalLivenessSweepOnce', () => {
  const GOAL_ID = 'make-sidestage-web-ios-and-android-ready-for-pub-dd62af';
  const KEY = `papercusp-workspace:${GOAL_ID}`;
  const HELD_LONG_ENOUGH = NOW - (GOAL_HOLDER_PRODUCTIVITY_GRACE_MS + 60_000);
  const sql = {} as never;

  const wedgeDeps = (over: Record<string, unknown> = {}) => ({
    readGoals: async () => ({
      goals: [goal()],
      holders: [holder({ setAtMs: HELD_LONG_ENOUGH })],
    }),
    resolveLiveness: async () => vmap(verdict('su-2c130be1', 'live')),
    escalate: async () => {},
    readReadiness: async () => new Map<string, GoalReadiness>(),
    escalateReadiness: async () => {},
    // P-002: inert here. These deps hold a LIVE goal, so unlike the dark-goal
    // block above they DO reach the portfolio leg — without this stub its
    // default measurement would run real SQL against the `{}` sql stub.
    readPortfolioThroughput: async () => new Map<string, GoalPortfolioThroughputRead>(),
    escalatePortfolioIdle: async () => {},
    readUnplannedClusters: async () => new Map(),
    fileUnplannedCluster: async () => null,
    flagEnabled: async () => true,
    now: () => NOW,
    graceMs: GOAL_LIVENESS_GRACE_MS,
    ...over,
  });

  it('escalates a wedged holder and counts it', async () => {
    const seen: GoalWedgeAlert[] = [];
    const r = await runGoalLivenessSweepOnce(
      sql,
      wedgeDeps({
        readHolderProductivity: async () => new Map([[KEY, 0]]),
        escalateWedge: async (a: GoalWedgeAlert) => {
          seen.push(a);
        },
      }),
    );
    expect(r.wedgeEscalated).toBe(1);
    expect(seen[0]).toMatchObject({ goalId: GOAL_ID, agentOriginCalls: 0 });
  });

  it("passes the live holds to the measurement, with each holder's own since-clock", async () => {
    let got: readonly GoalLiveHold[] = [];
    await runGoalLivenessSweepOnce(
      sql,
      wedgeDeps({
        readHolderProductivity: async (holds: readonly GoalLiveHold[]) => {
          got = holds;
          return new Map([[KEY, 5]]);
        },
        escalateWedge: async () => {},
      }),
    );
    expect(got).toEqual([
      {
        workspaceId: 'papercusp-workspace',
        goalId: GOAL_ID,
        ownerId: 'su-2c130be1',
        setAtMs: HELD_LONG_ENOUGH,
      },
    ]);
  });

  // A degraded measurement costs SILENCE, never a wave of false wedges.
  it('survives a throwing productivity read and escalates nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const escalateWedge = vi.fn();
      const r = await runGoalLivenessSweepOnce(
        sql,
        wedgeDeps({
          readHolderProductivity: async () => {
            throw new Error('pg down');
          },
          escalateWedge,
        }),
      );
      expect(r.wedgeEscalated).toBe(0);
      expect(escalateWedge).not.toHaveBeenCalled();
      expect(r.skipped).toBe(false);
      // Degraded, not silent-degraded: the sweep says so.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('holder-productivity read failed'));
    } finally {
      warn.mockRestore();
    }
  });

  it('never measures when no goal is held — the ledger read is skipped entirely', async () => {
    const readHolderProductivity = vi.fn(async () => new Map<string, number>());
    await runGoalLivenessSweepOnce(
      sql,
      wedgeDeps({
        resolveLiveness: async () => vmap(verdict('su-2c130be1', 'ended')),
        readHolderProductivity,
        escalateWedge: async () => {},
      }),
    );
    expect(readHolderProductivity).not.toHaveBeenCalled();
  });

  it('a failing wedge escalation does not cost the sweep', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await runGoalLivenessSweepOnce(
        sql,
        wedgeDeps({
          readHolderProductivity: async () => new Map([[KEY, 0]]),
          escalateWedge: async () => {
            throw new Error('escalation store down');
          },
        }),
      );
      expect(r.wedgeEscalated).toBe(0);
      expect(r.scanned).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('wedge escalate failed'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('makeReadHolderProductivity', () => {
  function captureSql() {
    const queries: string[] = [];
    const tag = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      queries.push(strings.join(' ? '));
      void vals;
      return Promise.resolve([] as unknown[]);
    }) as unknown as Parameters<typeof makeReadHolderProductivity>[0];
    return { tag, queries };
  }

  const hold: GoalLiveHold = {
    workspaceId: 'papercusp-workspace',
    goalId: 'g1',
    ownerId: 'su-1',
    setAtMs: NOW - 60_000,
  };

  it('short-circuits on zero holds without touching the ledger', async () => {
    const { tag, queries } = captureSql();
    expect(await makeReadHolderProductivity(tag)([])).toEqual(new Map());
    expect(queries).toEqual([]);
  });

  // The load-bearing predicate. `<> 'hook'` is FALSE for a NULL origin, which
  // would drop those rows, undercount, and manufacture a FALSE WEDGE — the one
  // direction this leg must never err in.
  it('excludes hook-origin calls with IS DISTINCT FROM, never `<>`', async () => {
    const { tag, queries } = captureSql();
    await makeReadHolderProductivity(tag)([hold]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/call_origin\s+IS DISTINCT FROM\s+'hook'/);
    expect(queries[0]).not.toMatch(/call_origin\s*<>/);
  });

  it('measures each hold from its own set-at clock, not a shared floor', async () => {
    const { tag, queries } = captureSql();
    await makeReadHolderProductivity(tag)([hold]);
    expect(queries[0]).toMatch(/ti\.invoked_at\s*>=\s*h\.since/);
  });
});

/* ── the PORTFOLIO-IDLE leg (goal-mode-drift-guards-2026-08-31 P-002) ──────── */

describe('classifyGoalPortfolioIdle', () => {
  const GOAL_ID = 'make-sidestage-web-ios-and-android-ready-for-pub-dd62af';
  const KEY = `papercusp-workspace:${GOAL_ID}`;
  const live = vmap(verdict('su-2c130be1', 'live'));
  const held = [holder({ setAtMs: JUST_NOW })];

  /** A throughput reading, defaulting to the IDLE shape the leg exists to catch. */
  const reading = (
    over: Partial<GoalPortfolioThroughputRead> = {},
  ): GoalPortfolioThroughputRead =>
    ({
      goalId: GOAL_ID,
      workspaceId: 'papercusp-workspace',
      windowMinutes: 60,
      actsInWindow: 0,
      actsPerHour: 0,
      lastActAtMs: null,
      lastActTool: null,
      lastActFacet: null,
      idleMinutes: 240,
      idleAfterMinutes: 20,
      measuredOwnerIds: 1,
      holderLiveness: 'held',
      idle: true,
      reason: 'idle',
      assessment: 'idle-past-threshold',
      unavailable: null,
      ...over,
    }) as GoalPortfolioThroughputRead;

  const map = (r?: GoalPortfolioThroughputRead) =>
    new Map<string, GoalPortfolioThroughputRead>(r ? [[KEY, r]] : []);

  it('alerts on a held goal that has placed nothing past the threshold', () => {
    const alert = classifyGoalPortfolioIdle(goal(), held, live, map(reading()), NOW);
    expect(alert).not.toBeNull();
    expect(alert?.idleMinutes).toBe(240);
    expect(alert?.idleAfterMinutes).toBe(20);
    expect(alert?.actsInWindow).toBe(0);
    expect(alert?.holders).toEqual([{ ownerId: 'su-2c130be1', sessionState: 'live' }]);
  });

  it('carries the last act through, when there was one', () => {
    const alert = classifyGoalPortfolioIdle(
      goal(),
      held,
      live,
      map(reading({ lastActTool: 'plans:set-status', lastActAtMs: NOW - 77 * 60_000 })),
      NOW,
    );
    expect(alert?.lastActTool).toBe('plans:set-status');
  });

  it('stays silent when the reading is not idle', () => {
    expect(
      classifyGoalPortfolioIdle(
        goal(),
        held,
        live,
        map(reading({ idle: false, reason: 'placing', assessment: 'placing', actsInWindow: 4 })),
        NOW,
      ),
    ).toBeNull();
  });

  /**
   * The conservative rule every leg in this file shares: an ABSENT measurement
   * suppresses. A degraded throughput read must cost silence, never a wave of
   * "every goal is idle".
   */
  it('stays silent when the goal is ABSENT from the throughput map', () => {
    expect(classifyGoalPortfolioIdle(goal(), held, live, map(), NOW)).toBeNull();
  });

  it('stays silent when idleMinutes is null even if `idle` somehow says true', () => {
    expect(
      classifyGoalPortfolioIdle(goal(), held, live, map(reading({ idleMinutes: null })), NOW),
    ).toBeNull();
  });

  /**
   * Placing nothing is only a finding about a steward who is THERE. A dark goal
   * is `unheld`/`lost` — the liveness leg's subject, with a different repair
   * (find a holder, not rethink the goal). Reporting both would send someone to
   * do the wrong one.
   */
  it('does NOT judge a goal whose holder is dead — that is the liveness leg', () => {
    const dead = vmap(verdict('su-2c130be1', 'ended'));
    expect(classifyGoalPortfolioIdle(goal(), held, dead, map(reading()), NOW)).toBeNull();
  });

  it.each(['paused', 'achieved', 'killed'])(
    'does NOT judge a %s goal — it places nothing by design or is over',
    (status) => {
      expect(
        classifyGoalPortfolioIdle(goal({ status }), held, live, map(reading()), NOW),
      ).toBeNull();
    },
  );
});

describe('runGoalLivenessSweepOnce — the portfolio-idle leg', () => {
  const GOAL_ID = 'make-sidestage-web-ios-and-android-ready-for-pub-dd62af';
  const KEY = `papercusp-workspace:${GOAL_ID}`;
  const sql = {} as never;

  const idleReading = {
    goalId: GOAL_ID,
    workspaceId: 'papercusp-workspace',
    windowMinutes: 60,
    actsInWindow: 0,
    actsPerHour: 0,
    lastActAtMs: null,
    lastActTool: null,
    lastActFacet: null,
    idleMinutes: 240,
    idleAfterMinutes: 20,
    measuredOwnerIds: 1,
    holderLiveness: 'held',
    idle: true,
    reason: 'idle',
    assessment: 'idle-past-threshold',
    unavailable: null,
  } as GoalPortfolioThroughputRead;

  const base = (over: Record<string, unknown> = {}) => ({
    readGoals: async () => ({ goals: [goal()], holders: [holder({ setAtMs: JUST_NOW })] }),
    resolveLiveness: async () => vmap(verdict('su-2c130be1', 'live')),
    escalate: async () => {},
    readReadiness: async () => new Map<string, GoalReadiness>(),
    escalateReadiness: async () => {},
    readHolderProductivity: async () => new Map<string, number>([[KEY, 99]]),
    escalateWedge: async () => {},
    readUnplannedClusters: async () => new Map(),
    fileUnplannedCluster: async () => null,
    flagEnabled: async () => true,
    now: () => NOW,
    graceMs: GOAL_LIVENESS_GRACE_MS,
    ...over,
  });

  it('escalates an idle steward and counts it', async () => {
    const seen: GoalPortfolioIdleAlert[] = [];
    const r = await runGoalLivenessSweepOnce(
      sql,
      base({
        readPortfolioThroughput: async () =>
          new Map<string, GoalPortfolioThroughputRead>([[KEY, idleReading]]),
        escalatePortfolioIdle: async (a: GoalPortfolioIdleAlert) => {
          seen.push(a);
        },
      }),
    );
    expect(r.portfolioIdleEscalated).toBe(1);
    expect(seen[0]?.idleMinutes).toBe(240);
  });

  /**
   * The leg receives the ALREADY-FOLDED holders rather than re-resolving them,
   * so the wedge verdict and this one cannot disagree about who is held within a
   * single tick.
   */
  it('is handed the folded holders for exactly the HELD goals', async () => {
    let got: ReadonlyMap<string, unknown> | null = null;
    await runGoalLivenessSweepOnce(
      sql,
      base({
        readPortfolioThroughput: async (h: ReadonlyMap<string, unknown>) => {
          got = h;
          return new Map();
        },
        escalatePortfolioIdle: async () => {},
      }),
    );
    expect([...(got as unknown as Map<string, unknown>).keys()]).toEqual([KEY]);
  });

  it('hands the leg NOTHING when no goal is held', async () => {
    let called = false;
    const r = await runGoalLivenessSweepOnce(
      sql,
      base({
        // An ENDED holder ⇒ liveness `lost` ⇒ the held map is empty ⇒ the
        // measurement is never even attempted.
        resolveLiveness: async () => vmap(verdict('su-2c130be1', 'ended')),
        readPortfolioThroughput: async () => {
          called = true;
          return new Map();
        },
        escalatePortfolioIdle: async () => {},
      }),
    );
    expect(called).toBe(false);
    expect(r.portfolioIdleEscalated).toBe(0);
  });

  // A degraded measurement costs SILENCE, never a wave of false idles.
  it('survives a throwing throughput read and escalates nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const escalatePortfolioIdle = vi.fn();
      const r = await runGoalLivenessSweepOnce(
        sql,
        base({
          readPortfolioThroughput: async () => {
            throw new Error('pg down');
          },
          escalatePortfolioIdle,
        }),
      );
      expect(r.portfolioIdleEscalated).toBe(0);
      expect(escalatePortfolioIdle).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // A failing escalation must not abort the sweep — same non-fatal contract the
  // wedge and readiness legs hold.
  it('survives a throwing escalation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await runGoalLivenessSweepOnce(
        sql,
        base({
          readPortfolioThroughput: async () =>
            new Map<string, GoalPortfolioThroughputRead>([[KEY, idleReading]]),
          escalatePortfolioIdle: async () => {
            throw new Error('escalation store unavailable');
          },
        }),
      );
      expect(r.portfolioIdleEscalated).toBe(0);
      expect(r.skipped).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * WI-2140573 (measured 2026-09-01): seven consecutive codex goal holders whose
 * kickoff turn died at the model layer ("We're currently experiencing high
 * demand", 5/5 retries, no output) sat parked with live processes, and the
 * respawner paid a full launch + a rate-cap slot for each — into the same
 * outage — until the hourly cap paused the goal. The verdict was right (the
 * session WAS lost); the remedy was wrong. A live process is woken, not
 * relaunched.
 */
describe('runGoalHolderRespawnOnce — re-kick a live-but-idle holder before launching (WI-2140573)', () => {
  const sql = {} as never;
  // Every re-kick (and every re-kick failure) is announced on console.warn, the
  // file's one log channel; the assertions below are on the deps, not the log.
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });
  /** The measured shape: parked (inbox-wake armed), nothing to self-wake, wrapper still heartbeating. */
  const liveButIdle = (ownerId: string): LivenessVerdict => ({
    ...verdict(ownerId, 'parked', 'none'),
    heartbeatFresh: true,
  });

  it('wakes the elected holder with a retry brief and pays NO launch', async () => {
    const launch = vi.fn(async (g: GoalRowLike) => ({ ownerId: `replacement-${g.goalId}`, warnings: [] }));
    const rekick = vi.fn(async (_goal: GoalRowLike, _ownerId: string, _attempt: number) => ({ woken: 1, staged: 0 }));
    const states = new Map();
    const result = await runGoalHolderRespawnOnce(
      sql,
      respawnDeps({
        resolveLiveness: async () => vmap(liveButIdle('su-2c130be1')),
        launch,
        rekick,
        rekickStates: new Map(),
        states,
      }),
    );
    expect(rekick).toHaveBeenCalledTimes(1);
    expect(rekick.mock.calls[0]?.[1]).toBe('su-2c130be1');
    expect(rekick.mock.calls[0]?.[2]).toBe(1);
    expect(launch).not.toHaveBeenCalled();
    expect(result.rekicked).toBe(1);
    expect(result.attempted).toBe(0);
    // Re-kicks never touch the flap-damping ledger: they cannot consume the give-up budget.
    expect(states.size).toBe(0);
  });

  it('spaces re-kicks by the interval, caps them, and only then falls through to a launch', async () => {
    let now = NOW;
    const launch = vi.fn(async (g: GoalRowLike) => ({ ownerId: `replacement-${g.goalId}`, warnings: [] }));
    const rekick = vi.fn(async (_goal: GoalRowLike, _ownerId: string, _attempt: number) => ({ woken: 1, staged: 0 }));
    const rekickStates = new Map();
    const states = new Map();
    const tick = () =>
      runGoalHolderRespawnOnce(
        sql,
        respawnDeps({
          resolveLiveness: async () => vmap(liveButIdle('su-2c130be1')),
          launch,
          rekick,
          rekickStates,
          states,
          now: () => now,
        }),
      );

    await tick(); // attempt 1
    now += 60_000;
    await tick(); // inside the interval: nothing
    expect(rekick).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();

    for (let attempt = 2; attempt <= GOAL_HOLDER_REKICK_MAX; attempt += 1) {
      now += GOAL_HOLDER_REKICK_INTERVAL_MS;
      const r = await tick();
      expect(r.rekicked).toBe(1);
      expect(rekick).toHaveBeenCalledTimes(attempt);
      expect(rekick.mock.calls[attempt - 1]?.[2]).toBe(attempt);
    }
    expect(launch).not.toHaveBeenCalled();

    // Budget spent, holder still idle: the damped launch path takes over.
    now += GOAL_HOLDER_REKICK_INTERVAL_MS;
    const spent = await tick();
    expect(rekick).toHaveBeenCalledTimes(GOAL_HOLDER_REKICK_MAX);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(spent.rekicked).toBe(0);
    expect(spent.attempted).toBe(1);
  });

  it('launches immediately when the process is actually gone (ended, or parked with a cold heartbeat)', async () => {
    for (const dead of [verdict('su-2c130be1', 'ended'), verdict('su-2c130be1', 'parked', 'none')]) {
      const launch = vi.fn(async (g: GoalRowLike) => ({ ownerId: `replacement-${g.goalId}`, warnings: [] }));
      const rekick = vi.fn(async (_goal: GoalRowLike, _ownerId: string, _attempt: number) => ({ woken: 1, staged: 0 }));
      const result = await runGoalHolderRespawnOnce(
        sql,
        respawnDeps({ resolveLiveness: async () => vmap(dead), launch, rekick, rekickStates: new Map() }),
      );
      expect(rekick).not.toHaveBeenCalled();
      expect(launch).toHaveBeenCalledTimes(1);
      expect(result.rekicked).toBe(0);
      expect(result.attempted).toBe(1);
    }
  });

  it('a holder that comes back alive earns a fresh re-kick budget; a NEW elected holder starts fresh too', async () => {
    let now = NOW;
    const rekick = vi.fn(async (_goal: GoalRowLike, _ownerId: string, _attempt: number) => ({ woken: 1, staged: 0 }));
    const rekickStates = new Map();
    let verdicts = vmap(liveButIdle('su-2c130be1'));
    let holders = [holder()];
    const tick = () =>
      runGoalHolderRespawnOnce(
        sql,
        respawnDeps({
          readGoals: async () => ({ goals: [respawnGoal()], holders }),
          resolveLiveness: async () => verdicts,
          rekick,
          rekickStates,
          now: () => now,
        }),
      );
    await tick();
    expect(rekick).toHaveBeenCalledTimes(1);

    // The re-kick took: the holder is alive. The ledger is cleared.
    verdicts = vmap(verdict('su-2c130be1', 'live', 'loop'));
    await tick();
    expect(rekickStates.size).toBe(0);

    // Idle again much later: attempt numbering restarts at 1.
    now += 6 * 60 * 60_000;
    verdicts = vmap(liveButIdle('su-2c130be1'));
    await tick();
    expect(rekick).toHaveBeenCalledTimes(2);
    expect(rekick.mock.calls[1]?.[2]).toBe(1);

    // A different elected holder (higher epoch) is a different budget.
    holders = [holder(), holder({ ownerId: 'su-next', goalLeaseEpoch: 99, setAtMs: JUST_NOW })];
    verdicts = vmap(liveButIdle('su-2c130be1'), liveButIdle('su-next'));
    await tick();
    expect(rekick).toHaveBeenCalledTimes(3);
    expect(rekick.mock.calls[2]?.[1]).toBe('su-next');
    expect(rekick.mock.calls[2]?.[2]).toBe(1);
  });

  it('a failing re-kick is non-fatal and still consumes that attempt', async () => {
    const launch = vi.fn(async (g: GoalRowLike) => ({ ownerId: `replacement-${g.goalId}`, warnings: [] }));
    const rekickStates = new Map();
    const result = await runGoalHolderRespawnOnce(
      sql,
      respawnDeps({
        resolveLiveness: async () => vmap(liveButIdle('su-2c130be1')),
        launch,
        rekick: async () => {
          throw new Error('wake channel unavailable');
        },
        rekickStates,
      }),
    );
    expect(result.rekicked).toBe(0);
    expect(result.attempted).toBe(0);
    expect(launch).not.toHaveBeenCalled();
    expect([...rekickStates.values()][0]?.attemptsAtMs.length).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('re-kick 1/3 failed'));
  });
});

describe('runGoalHolderRespawnOnce — defers recovery while the launch target is usage-walled (WI-2140573 finding 5)', () => {
  const sql = {} as never;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });
  type Deferred = Extract<GoalHolderLaunchCapacityVerdict, { kind: 'deferred' }>;
  const target = { provider: 'codex' as const, accountId: null, agent: 'codex' };
  const walled = (untilMs: number | null = NOW + 5 * 24 * 3_600_000): Deferred => ({
    kind: 'deferred',
    target,
    binding: 'usage-wall',
    untilMs,
    accountIds: ['chatgpt-sub-cli'],
    reason: "no 'codex' account can serve on a fresh reading (1 usage-walled, 0 rate-paused of 1)",
    pool: {
      provider: 'codex',
      total: 1,
      serviceable: 0,
      walledFresh: 1,
      paused: 0,
      pacing: 0,
      unknown: 0,
      atCapacity: true,
      binding: 'usage-wall',
      reason: 'walled',
    },
  });
  const ratePaused = (): Deferred => ({
    ...walled(NOW + 5 * 60_000),
    binding: 'rate-pause',
  });
  const clear: GoalHolderLaunchCapacityVerdict = { kind: 'clear', target, reason: '1 of 1 can serve' };
  const escalationMock = () =>
    vi.fn(async (_goal: GoalRowLike, _verdict: Deferred, _deferredForMs: number): Promise<void> => {});
  const liveButIdle = (ownerId: string): LivenessVerdict => ({
    ...verdict(ownerId, 'parked', 'none'),
    heartbeatFresh: true,
  });

  it('spends NOTHING on a lost holder while the pool is measured usage-walled: no re-kick, no damping, no rate slot, no launch — and escalates once', async () => {
    const launch = vi.fn(async (g: GoalRowLike) => ({ ownerId: `replacement-${g.goalId}`, warnings: [] }));
    const rekick = vi.fn(async () => ({ woken: 1, staged: 0 }));
    const reserveRateSlot = vi.fn(async () => ({ kind: 'reserved' as const, attemptsInWindow: 1 }));
    const escalateCapacityDeferral = escalationMock();
    const states = new Map();
    const capacityDeferrals = new Map();
    let now = NOW;
    const deps = respawnDeps({
      // The measured shape: the holder's process is up but idle (it died at the model layer).
      resolveLiveness: async () => vmap(liveButIdle('su-2c130be1')),
      assessLaunchCapacity: async () => walled(),
      escalateCapacityDeferral,
      capacityDeferrals,
      launch,
      rekick,
      rekickStates: new Map(),
      reserveRateSlot,
      states,
      now: () => now,
    });
    const first = await runGoalHolderRespawnOnce(sql, deps);
    expect(first).toMatchObject({ eligible: 1, deferredCapacity: 1, rekicked: 0, attempted: 0, respawned: 0 });
    expect(rekick).not.toHaveBeenCalled();
    expect(reserveRateSlot).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(states.size).toBe(0);
    // A usage wall escalates on the FIRST deferred tick, and exactly once per episode.
    expect(escalateCapacityDeferral).toHaveBeenCalledTimes(1);
    expect(escalateCapacityDeferral.mock.calls[0]?.[1]).toMatchObject({ binding: 'usage-wall' });

    // Ten more 60-second ticks: still deferred, still nothing spent, no second escalation.
    for (let i = 0; i < 10; i += 1) {
      now += 60_000;
      expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ deferredCapacity: 1, attempted: 0 });
    }
    expect(launch).not.toHaveBeenCalled();
    expect(escalateCapacityDeferral).toHaveBeenCalledTimes(1);
    expect(capacityDeferrals.size).toBe(1);
    // The deferral is logged on entry and then at most once per log interval — not per tick.
    const deferredLines = warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('recovery DEFERRED')).length;
    expect(deferredLines).toBe(1 + Math.floor((10 * 60_000) / GOAL_HOLDER_CAPACITY_DEFER_LOG_INTERVAL_MS));
  });

  it('resumes the ordinary path only once capacity reads back for GOAL_HOLDER_CAPACITY_RESUME_CONFIRM_TICKS consecutive ticks', async () => {
    const launch = vi.fn(async (g: GoalRowLike) => ({ ownerId: `replacement-${g.goalId}`, warnings: [] }));
    const capacityDeferrals = new Map();
    let capacity: GoalHolderLaunchCapacityVerdict = walled();
    const deps = respawnDeps({
      resolveLiveness: async () => vmap(verdict('su-2c130be1', 'ended')),
      assessLaunchCapacity: async () => capacity,
      escalateCapacityDeferral: async () => {},
      capacityDeferrals,
      launch,
      states: new Map(),
    });
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ deferredCapacity: 1, attempted: 0 });
    capacity = clear;
    // First clear tick: the episode stays open (streak 1/2) and nothing is spent.
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ deferredCapacity: 1, attempted: 0 });
    expect(launch).not.toHaveBeenCalled();
    expect(capacityDeferrals.size).toBe(1);
    expect(warn.mock.calls.some((c: unknown[]) => String(c[0]).includes('capacity back'))).toBe(false);
    // Second consecutive clear tick: confirmed — the episode closes and the launch is paid.
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ deferredCapacity: 0, attempted: 1, respawned: 1 });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(capacityDeferrals.size).toBe(0);
    const back = warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('capacity back'));
    expect(back).toHaveLength(1);
    expect(String(back[0]?.[0])).toContain('2 consecutive clear readings');
  });

  it('holds the deferral through a FLAPPING reading — unknown ticks and a lone clear tick between walled ticks never pay a launch (measured 2026-09-02 06:16–08:52Z)', async () => {
    const launch = vi.fn(async (g: GoalRowLike) => ({ ownerId: `replacement-${g.goalId}`, warnings: [] }));
    const rekick = vi.fn(async () => ({ woken: 1, staged: 0 }));
    const capacityDeferrals = new Map();
    const unknown: GoalHolderLaunchCapacityVerdict = {
      kind: 'unknown',
      target,
      reason: "no 'codex' account can serve on a fresh reading (0 usage-walled, 0 rate-paused of 7; 7 stale)",
    };
    // The measured shape: deferred → stale/unknown → one clear flicker → deferred again → …
    const readings: GoalHolderLaunchCapacityVerdict[] = [walled(), unknown, unknown, clear, walled(), clear, unknown, walled()];
    let tick = 0;
    let now = NOW;
    const deps = respawnDeps({
      resolveLiveness: async () => vmap(liveButIdle('su-2c130be1')),
      assessLaunchCapacity: async () => readings[Math.min(tick, readings.length - 1)]!,
      escalateCapacityDeferral: async () => {},
      capacityDeferrals,
      launch,
      rekick,
      rekickStates: new Map(),
      states: new Map(),
      now: () => now,
    });
    // 5-minute ticks so the hold outlasts GOAL_HOLDER_CAPACITY_DEFER_LOG_INTERVAL_MS and the
    // rate-limited "capacity NOT confirmed" line is observable (walled() lifts 5 days out).
    for (tick = 0; tick < readings.length; tick += 1) {
      now += 5 * 60_000;
      expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ deferredCapacity: 1, rekicked: 0, attempted: 0 });
    }
    expect(launch).not.toHaveBeenCalled();
    expect(rekick).not.toHaveBeenCalled();
    expect(capacityDeferrals.size).toBe(1);
    expect(warn.mock.calls.some((c: unknown[]) => String(c[0]).includes('capacity back'))).toBe(false);
    expect(warn.mock.calls.some((c: unknown[]) => String(c[0]).includes('capacity NOT confirmed'))).toBe(true);

    // Two consecutive clear readings confirm the wall lifted: the ordinary path resumes exactly once.
    readings.push(clear, clear);
    now += 60_000;
    tick = readings.length - 2;
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ deferredCapacity: 1, rekicked: 0, attempted: 0 });
    now += 60_000;
    tick = readings.length - 1;
    const resumed = await runGoalHolderRespawnOnce(sql, deps);
    expect(resumed.deferredCapacity).toBe(0);
    expect(capacityDeferrals.size).toBe(0);
    expect(warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('capacity back'))).toHaveLength(1);
    // The resumed path is the ordinary one: a live-but-idle holder is re-kicked before any launch is paid.
    expect(rekick).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
  });

  it('closes an episode on a non-deferred reading once the wall\'s own lift time has passed, even without a confirmed streak', async () => {
    const launch = vi.fn(async (g: GoalRowLike) => ({ ownerId: `replacement-${g.goalId}`, warnings: [] }));
    const capacityDeferrals = new Map();
    const untilMs = NOW + 30 * 60_000;
    let capacity: GoalHolderLaunchCapacityVerdict = walled(untilMs);
    let now = NOW;
    const deps = respawnDeps({
      resolveLiveness: async () => vmap(verdict('su-2c130be1', 'ended')),
      assessLaunchCapacity: async () => capacity,
      escalateCapacityDeferral: async () => {},
      capacityDeferrals,
      launch,
      states: new Map(),
      now: () => now,
    });
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ deferredCapacity: 1, attempted: 0 });
    // Readings go stale (unknown) before the lift time: still held.
    capacity = { kind: 'unknown', target, reason: 'readings stale' };
    now += 60_000;
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ deferredCapacity: 1, attempted: 0 });
    // Past the lift time the same unknown reading may close the episode.
    now = untilMs + 1;
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ deferredCapacity: 0, attempted: 1, respawned: 1 });
    expect(capacityDeferrals.size).toBe(0);
    const back = warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('capacity back'));
    expect(back).toHaveLength(1);
    expect(String(back[0]?.[0])).toContain('wall lift time passed');
  });

  it('escalates a RATE PAUSE only once the deferral episode outlasts the budget', async () => {
    const escalateCapacityDeferral = escalationMock();
    let now = NOW;
    const deps = respawnDeps({
      resolveLiveness: async () => vmap(verdict('su-2c130be1', 'ended')),
      assessLaunchCapacity: async () => ratePaused(),
      escalateCapacityDeferral,
      capacityDeferrals: new Map(),
      launch: vi.fn(async () => ({ ownerId: 'must-not-launch', warnings: [] })),
      states: new Map(),
      now: () => now,
    });
    await runGoalHolderRespawnOnce(sql, deps);
    expect(escalateCapacityDeferral).not.toHaveBeenCalled();
    now += GOAL_HOLDER_CAPACITY_DEFER_ESCALATE_MS - 1;
    await runGoalHolderRespawnOnce(sql, deps);
    expect(escalateCapacityDeferral).not.toHaveBeenCalled();
    now += 1;
    await runGoalHolderRespawnOnce(sql, deps);
    expect(escalateCapacityDeferral).toHaveBeenCalledTimes(1);
    expect(escalateCapacityDeferral.mock.calls[0]?.[1]).toMatchObject({ binding: 'rate-pause' });
  });

  it('proceeds as UNKNOWN when the capacity read throws or cannot measure — a guess never withholds recovery', async () => {
    const launch = vi.fn(async (g: GoalRowLike) => ({ ownerId: `replacement-${g.goalId}`, warnings: [] }));
    const throwing = respawnDeps({
      resolveLiveness: async () => vmap(verdict('su-2c130be1', 'ended')),
      assessLaunchCapacity: async () => {
        throw new Error('accounts:status unreachable');
      },
      launch,
      states: new Map(),
    });
    expect(await runGoalHolderRespawnOnce(sql, throwing)).toMatchObject({ deferredCapacity: 0, attempted: 1 });
    const unknown = respawnDeps({
      resolveLiveness: async () => vmap(verdict('su-2c130be1', 'ended')),
      assessLaunchCapacity: async () => ({ kind: 'unknown', target, reason: 'all readings stale' }),
      launch,
      states: new Map(),
    });
    expect(await runGoalHolderRespawnOnce(sql, unknown)).toMatchObject({ deferredCapacity: 0, attempted: 1 });
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('closes a deferral episode silently when the holder turns out to be held again', async () => {
    const capacityDeferrals = new Map([
      [
        goalHolderRespawnKey(respawnGoal()),
        { sinceMs: NOW - 60_000, lastLoggedAtMs: NOW - 60_000, reason: 'x', escalated: true, clearStreak: 0, untilMs: null },
      ],
    ]);
    const assessLaunchCapacity = vi.fn(async () => walled());
    const deps = respawnDeps({
      resolveLiveness: async () => vmap(verdict('su-2c130be1', 'live', 'loop')),
      assessLaunchCapacity,
      capacityDeferrals,
      states: new Map(),
    });
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ deferredCapacity: 0, attempted: 0 });
    expect(assessLaunchCapacity).not.toHaveBeenCalled();
    expect(capacityDeferrals.size).toBe(0);
  });
});

/**
 * EI-23821882158913073 — REACHABILITY, which is the actual defect.
 *
 * The SQL semantics of the reconciler are covered against a real Postgres in
 * goal-holder-respawn.integration.test.ts. What those cannot catch is the bug itself:
 * every branch that can escalate or clear a durable needs-human latch sits BELOW
 * decideFlapDamping({ healthy: false }), so once a holder recovers the latch is
 * unreachable and survives forever. Measured: one live goal sat needsHuman:true with no
 * escalatedAtMs for 7h while its holder was healthy and on wake #127.
 *
 * These pin the reconcile to the HEALTHY path. Move the call back below the `held`
 * early-return and the integration tests all still pass — these are what go red.
 */
// WI-10005904: measured 2026-10-03 04:57Z..05:30Z on goal 60d3a8. The account
// session override allowed only a codex account; the claude holder's launches
// all died at boot with "--account auto could not be honored". Each one was
// counted as a holder death: it spent an hourly rate-cap slot and a damping
// restart, and after six the respawner paused the goal as needs-human.
describe('runGoalHolderRespawnOnce — boot deaths on the account route never spend the holder-death cap (WI-10005904)', () => {
  const sql = {} as never;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });
  const UNHONORED =
    'psu exited (code 1) before the session registered presence\n' +
    '--account auto could not be honored: claude requires a claude account pool. ' +
    'Refusing to fall back to the default system login.';
  /** A durable 6-per-hour ledger, so a slot that is not returned would eventually cap. */
  function rateLedger() {
    const slots: number[] = [];
    const reserveRateSlot = vi.fn(async (_goal: GoalRowLike, at: number) => {
      const inWindow = slots.filter((t) => at - t < 3_600_000).length;
      if (inWindow >= 6) return { kind: 'capped' as const, attemptsInWindow: inWindow };
      slots.push(at);
      return { kind: 'reserved' as const, attemptsInWindow: inWindow + 1 };
    });
    const releaseRateSlot = vi.fn(async (_goal: GoalRowLike, at: number) => {
      const i = slots.indexOf(at);
      if (i >= 0) slots.splice(i, 1);
      return i >= 0;
    });
    return { slots, reserveRateSlot, releaseRateSlot };
  }

  it('six consecutive unhonored launches return every slot, leave damping untouched, never pause, and hold recovery with a doubling hold', async () => {
    let clock = NOW;
    const { slots, reserveRateSlot, releaseRateSlot } = rateLedger();
    const launch = vi.fn(async (): Promise<{ ownerId: string; warnings: string[] }> => {
      throw new Error(UNHONORED);
    });
    const pauseNeedsHuman = vi.fn(async () => true);
    const escalateGiveUp = vi.fn(async () => {});
    const escalateUnhonoredLaunch = vi.fn(
      async (_goal: GoalRowLike, _info: { refusal: string; count: number; holdMs: number }) => {},
    );
    const states = new Map();
    const capacityDeferrals = new Map<string, GoalHolderCapacityDeferral>();
    const unhonoredLaunches = new Map<string, GoalHolderUnhonoredLaunchState>();
    const deps = respawnDeps({
      reserveRateSlot,
      releaseRateSlot,
      launch,
      pauseNeedsHuman,
      escalateGiveUp,
      escalateUnhonoredLaunch,
      states,
      capacityDeferrals,
      unhonoredLaunches,
      now: () => clock,
    });

    const holds: number[] = [];
    for (let i = 1; i <= 6; i += 1) {
      const result = await runGoalHolderRespawnOnce(sql, deps);
      expect(result).toMatchObject({ attempted: 1, launchUnhonored: 1, launchFailed: 0, gaveUp: 0, respawned: 0 });
      expect(launch).toHaveBeenCalledTimes(i);
      // Damping is untouched and the slot is back in the ledger.
      expect(states.size).toBe(0);
      expect(slots).toEqual([]);
      const episode = [...capacityDeferrals.values()][0];
      const holdMs = unhonoredLaunchHoldMs(i);
      expect(episode?.holdUntilMs).toBe(clock + holdMs);
      holds.push(holdMs);
      // A clear capacity reading does not launch while the hold runs: that reading
      // is what failed to foresee the death.
      clock += holdMs - 1;
      expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ attempted: 0, deferredCapacity: 1 });
      expect(launch).toHaveBeenCalledTimes(i);
      clock += 1;
    }

    expect(holds[0]).toBe(GOAL_HOLDER_UNHONORED_LAUNCH_HOLD_MS);
    expect(holds).toEqual([10, 20, 40, 80, 120, 120].map((m) => m * 60_000));
    expect(holds[5]).toBe(GOAL_HOLDER_UNHONORED_LAUNCH_HOLD_MAX_MS);
    expect(reserveRateSlot).toHaveBeenCalledTimes(6);
    expect(releaseRateSlot).toHaveBeenCalledTimes(6);
    expect(pauseNeedsHuman).not.toHaveBeenCalled();
    expect(escalateGiveUp).not.toHaveBeenCalled();
    expect(escalateUnhonoredLaunch.mock.calls.map((c) => c[1].count)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(escalateUnhonoredLaunch.mock.calls[0]?.[1].refusal).toMatch(/^--account auto could not be honored: /);
  });

  it('a successful launch resets the doubling', async () => {
    let clock = NOW;
    const { reserveRateSlot, releaseRateSlot } = rateLedger();
    let fail = true;
    const launch = vi.fn(async (g: GoalRowLike) => {
      if (fail) throw new Error(UNHONORED);
      return { ownerId: `replacement-${g.goalId}`, warnings: [] };
    });
    const unhonoredLaunches = new Map<string, GoalHolderUnhonoredLaunchState>();
    const deps = respawnDeps({
      reserveRateSlot,
      releaseRateSlot,
      launch,
      unhonoredLaunches,
      capacityDeferrals: new Map(),
      states: new Map(),
      now: () => clock,
    });
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ launchUnhonored: 1 });
    expect([...unhonoredLaunches.values()].map((s) => s.count)).toEqual([1]);
    clock += GOAL_HOLDER_UNHONORED_LAUNCH_HOLD_MS;
    fail = false;
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ attempted: 1, respawned: 1, launchUnhonored: 0 });
    expect(unhonoredLaunches.size).toBe(0);
  });

  it('an ordinary launch failure is still damped and keeps its slot (the control)', async () => {
    const { slots, reserveRateSlot, releaseRateSlot } = rateLedger();
    const states = new Map();
    const deps = respawnDeps({
      reserveRateSlot,
      releaseRateSlot,
      launch: async () => {
        throw new Error('spawn psu ENOENT');
      },
      states,
      capacityDeferrals: new Map(),
      unhonoredLaunches: new Map(),
    });
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ attempted: 1, launchFailed: 1, launchUnhonored: 0 });
    expect(states.size).toBe(1);
    expect(slots).toHaveLength(1);
    expect(releaseRateSlot).not.toHaveBeenCalled();
  });

  it('escalates a session-override deferral on the first tick instead of waiting out the rate-pause grace', async () => {
    const target = { provider: 'claude' as const, accountId: null, agent: 'claude' };
    const overrideDeferred: GoalHolderLaunchCapacityVerdict = {
      kind: 'deferred',
      target,
      binding: 'session-override',
      untilMs: null,
      accountIds: ['aviynw', 'aviynw2'],
      reason: 'the account session override (forced: aviynw_codex; excluded: none) disallows every claude account',
      pool: {
        provider: 'claude',
        total: 2,
        serviceable: 2,
        walledFresh: 0,
        paused: 0,
        pacing: 0,
        unknown: 0,
        atCapacity: false,
        binding: 'none',
        reason: '2 of 2 can serve',
      },
    };
    const escalateCapacityDeferral = vi.fn(async () => {});
    const launch = vi.fn(async (g: GoalRowLike) => ({ ownerId: `replacement-${g.goalId}`, warnings: [] }));
    const deps = respawnDeps({
      assessLaunchCapacity: async () => overrideDeferred,
      escalateCapacityDeferral,
      launch,
      capacityDeferrals: new Map(),
    });
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ attempted: 0, deferredCapacity: 1 });
    expect(escalateCapacityDeferral).toHaveBeenCalledTimes(1);
    expect(escalateCapacityDeferral).toHaveBeenCalledWith(expect.anything(), overrideDeferred, 0);
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ attempted: 0, deferredCapacity: 1 });
    expect(escalateCapacityDeferral).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('stranded needs-human latch is reconciled on the HEALTHY path (EI-23821882158913073)', () => {
  const sql = {} as never;

  it('reconciles a goal whose holder is LIVE — the case every health-gated branch skips', async () => {
    const target = respawnGoal();
    const reconciled: string[] = [];
    const result = await runGoalHolderRespawnOnce(
      sql,
      respawnDeps({
        readGoals: async () => ({ goals: [target], holders: [holder()] }),
        // A healthy holder: the sweep takes its `held` early-return, so nothing below it
        // runs. This is precisely the goal whose latch could never converge.
        resolveLiveness: async () => vmap(verdict('su-2c130be1', 'live')),
        reconcileStrandedLatch: async (goal) => {
          reconciled.push(goal.goalId);
          return { kind: 'cleared', attemptsInWindow: 0 };
        },
      }),
    );

    expect(reconciled).toEqual([target.goalId]);
    // ...and converging a stale latch must not pay for any recovery on a healthy holder.
    expect(result).toMatchObject({ attempted: 0, respawned: 0 });
  });

  it('re-drives the escalate+pause the original tick dropped, when the cap still holds', async () => {
    const escalated: number[] = [];
    const paused: number[] = [];
    const launches: string[] = [];

    await runGoalHolderRespawnOnce(
      sql,
      respawnDeps({
        resolveLiveness: async () => vmap(verdict('su-2c130be1', 'live')),
        reconcileStrandedLatch: async () => ({ kind: 'escalate', attemptsInWindow: 6 }),
        escalateGiveUp: async (_goal, n) => {
          escalated.push(n);
        },
        pauseNeedsHuman: async (_goal, n) => {
          paused.push(n);
          return true;
        },
        launch: async (g) => {
          launches.push(g.goalId);
          return { ownerId: 'su-replacement', warnings: [] };
        },
      }),
    );

    // Both halves, with the window count the reconciler measured — not a fresh guess.
    expect(escalated).toEqual([6]);
    expect(paused).toEqual([6]);
    // Repairing a latch is never a licence to spawn.
    expect(launches).toEqual([]);
  });

  it('a reconcile THROW never blocks the ordinary lost-holder recovery below it', async () => {
    const launches: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runGoalHolderRespawnOnce(
        sql,
        respawnDeps({
          // Default fixture liveness is 'ended' => the normal recovery path must still run.
          reconcileStrandedLatch: async () => {
            throw new Error('reconcile boom');
          },
          launch: async (g) => {
            launches.push(g.goalId);
            return { ownerId: 'su-replacement', warnings: [] };
          },
        }),
      );
      expect(launches).toHaveLength(1);
      expect(result).toMatchObject({ attempted: 1, respawned: 1 });
    } finally {
      warn.mockRestore();
    }
  });

  it('defaults to a no-op when no reconciler is injected (the seam stays optional)', async () => {
    const result = await runGoalHolderRespawnOnce(
      sql,
      respawnDeps({
        resolveLiveness: async () => vmap(verdict('su-2c130be1', 'live')),
        reconcileStrandedLatch: undefined,
      }),
    );
    expect(result).toMatchObject({ attempted: 0 });
  });
});

// WI-10005559 (measured 2026-10-02): a holder's carry-respawn, cold-boot drill
// cut or resume stamps adv_sessions.ended_at, and the oracle reads the owner
// `ended` until its successor registers about two minutes later. Acting on the
// first such tick re-elected goal 60d3a8 six times in 23 minutes and spent its
// hourly cap. A loss must persist for GOAL_HOLDER_LOSS_CONFIRM_MS first.
describe('runGoalHolderRespawnOnce — loss confirmation window (WI-10005559)', () => {
  const sql = {} as never;
  let info: { mock: { calls: unknown[][] }; mockRestore(): void };
  beforeEach(() => {
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    info.mockRestore();
  });

  it('rides out a same-owner restart gap and acts only on a loss that persists', async () => {
    let nowMs = NOW;
    let state: SessionState = 'ended';
    const launch = vi.fn(async () => ({ ownerId: 'replacement', warnings: [] }));
    const lossObservations: NonNullable<GoalHolderRespawnDeps['lossObservations']> = new Map();
    const deps = respawnDeps({
      lossConfirmMs: GOAL_HOLDER_LOSS_CONFIRM_MS,
      lossObservations,
      now: () => nowMs,
      launch,
      resolveLiveness: async () => vmap(verdict('su-2c130be1', state)),
    });

    // The restart gap: two `ended` ticks, then the successor registers.
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ attempted: 0, lossUnconfirmed: 1 });
    nowMs += 60_000;
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ attempted: 0, lossUnconfirmed: 1 });
    state = 'live';
    nowMs += 60_000;
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ attempted: 0, lossUnconfirmed: 0 });
    expect(lossObservations.size).toBe(0);
    expect(launch).not.toHaveBeenCalled();

    // A genuine loss: the window restarts from this tick and recovery acts
    // only once it has fully elapsed.
    state = 'ended';
    nowMs += 60_000;
    const lostAt = nowMs;
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ attempted: 0, lossUnconfirmed: 1 });
    nowMs = lostAt + GOAL_HOLDER_LOSS_CONFIRM_MS - 1;
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ attempted: 0, lossUnconfirmed: 1 });
    nowMs = lostAt + GOAL_HOLDER_LOSS_CONFIRM_MS;
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ attempted: 1, lossUnconfirmed: 0 });
    expect(launch).toHaveBeenCalledOnce();
    // The reason trail: each loss episode is logged once, when it starts.
    const lostLines = info.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((line: string) => line.includes('judged lost'));
    expect(lostLines).toHaveLength(2);
    // WI-10005579: each line names the verdict inputs, so a relaunch gap
    // (`ended`) reads differently from a parked holder with no wake source.
    expect(lostLines[lostLines.length - 1]).toContain('sessionState=ended');
    expect(lostLines[lostLines.length - 1]).toMatch(/selfWake=\S+/);
  });

  it('restarts the window when a different holder is elected', async () => {
    let nowMs = NOW;
    let elected = 'su-2c130be1';
    const launch = vi.fn(async () => ({ ownerId: 'replacement', warnings: [] }));
    const target = respawnGoal();
    const deps = respawnDeps({
      lossConfirmMs: GOAL_HOLDER_LOSS_CONFIRM_MS,
      lossObservations: new Map(),
      now: () => nowMs,
      launch,
      readGoals: async () => ({ goals: [target], holders: [holder({ ownerId: elected })] }),
      resolveLiveness: async () => vmap(verdict(elected, 'ended')),
    });

    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ attempted: 0, lossUnconfirmed: 1 });
    elected = 'su-successor';
    nowMs += GOAL_HOLDER_LOSS_CONFIRM_MS;
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ attempted: 0, lossUnconfirmed: 1 });
    expect(launch).not.toHaveBeenCalled();
    nowMs += GOAL_HOLDER_LOSS_CONFIRM_MS;
    expect(await runGoalHolderRespawnOnce(sql, deps)).toMatchObject({ attempted: 1 });
  });

  it('applies the production window to a caller that does not set one', async () => {
    const launch = vi.fn(async () => ({ ownerId: 'replacement', warnings: [] }));
    const { lossConfirmMs: _unset, ...rest } = respawnDeps({ launch, lossObservations: new Map() });
    expect(await runGoalHolderRespawnOnce(sql, rest)).toMatchObject({ attempted: 0, lossUnconfirmed: 1 });
    expect(launch).not.toHaveBeenCalled();
  });

  it('keeps the window above the measured carry-respawn gap', () => {
    // 2026-10-02: drill cut 16:49:10Z, successor's first tool call 16:51:00Z.
    expect(GOAL_HOLDER_LOSS_CONFIRM_MS).toBeGreaterThanOrEqual(3 * 60_000);
  });
});

describe('runGoalLivenessSweepOnce — the unplanned-cluster leg (goal-holder-plans P-002)', () => {
  const sql = {} as never;
  const KEY = goalReadinessKey(goal());
  /** A 3-item cluster that formed `formedAgoMs` before NOW. */
  const read = (formedAgoMs: number): UnplannedClusterRead => ({
    clusters: findUnplannedClusters(
      KEY,
      ['WI-1', 'WI-2', 'WI-3'].map((id) => ({
        id,
        title: `[Reminder delivery] ${id}`,
        createdAtMs: NOW - formedAgoMs,
        harness: 'papercusp',
      })),
      [],
    ),
    itemCount: 3,
    truncatedByLimit: false,
  });

  const base = (over: Record<string, unknown> = {}) => ({
    readGoals: async () => ({ goals: [goal()], holders: [holder({ setAtMs: JUST_NOW })] }),
    resolveLiveness: async () => vmap(verdict('su-2c130be1', 'live')),
    escalate: async () => {},
    readReadiness: async () => new Map<string, GoalReadiness>(),
    escalateReadiness: async () => {},
    readHolderProductivity: async () => new Map<string, number>([[KEY, 99]]),
    escalateWedge: async () => {},
    readPortfolioThroughput: async () => new Map<string, GoalPortfolioThroughputRead>(),
    escalatePortfolioIdle: async () => {},
    flagEnabled: async () => true,
    now: () => NOW,
    graceMs: GOAL_LIVENESS_GRACE_MS,
    ...over,
  });

  it('files ONE holder-assigned nudge for a cluster older than 2 ordinary (4h) cycles', async () => {
    const filed: UnplannedClusterAlert[] = [];
    const r = await runGoalLivenessSweepOnce(
      sql,
      base({
        readUnplannedClusters: async () => new Map([[KEY, read(8 * 3600_000 + 60_000)]]),
        fileUnplannedCluster: async (a: UnplannedClusterAlert) => {
          filed.push(a);
          return 'WI-NUDGE';
        },
      }),
    );
    expect(r.unplannedClustersFiled).toBe(1);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      goalId: goal().goalId,
      workspaceId: 'papercusp-workspace',
      holderOwnerId: 'su-2c130be1',
      reportCycleMs: 4 * 3600_000,
    });
    expect(filed[0].cluster.memberIds).toEqual(['WI-1', 'WI-2', 'WI-3']);
  });

  it('gives an ordinary goal its two cycles: a 3h-old cluster is not yet reportable', async () => {
    let calls = 0;
    const r = await runGoalLivenessSweepOnce(
      sql,
      base({
        readUnplannedClusters: async () => new Map([[KEY, read(3 * 3600_000)]]),
        fileUnplannedCluster: async () => {
          calls += 1;
          return 'WI-NUDGE';
        },
      }),
    );
    expect(calls).toBe(0);
    expect(r.unplannedClustersFiled).toBe(0);
  });

  it('holds a STANDING goal to its hourly cadence: the same 3h-old cluster is reportable', async () => {
    const filed: UnplannedClusterAlert[] = [];
    const r = await runGoalLivenessSweepOnce(
      sql,
      base({
        readGoals: async () => ({ goals: [goal({ standing: true })], holders: [holder({ setAtMs: JUST_NOW })] }),
        readUnplannedClusters: async () => new Map([[KEY, read(3 * 3600_000)]]),
        fileUnplannedCluster: async (a: UnplannedClusterAlert) => {
          filed.push(a);
          return 'WI-NUDGE';
        },
      }),
    );
    expect(r.unplannedClustersFiled).toBe(1);
    expect(filed[0].reportCycleMs).toBe(3600_000);
  });

  it('does not count a cluster whose nudge already exists (the filer returns null)', async () => {
    const r = await runGoalLivenessSweepOnce(
      sql,
      base({
        readUnplannedClusters: async () => new Map([[KEY, read(9 * 3600_000)]]),
        fileUnplannedCluster: async () => null,
      }),
    );
    expect(r.unplannedClustersFiled).toBe(0);
  });

  it('never judges an UNHELD goal — that is the liveness leg', async () => {
    let read_ = 0;
    await runGoalLivenessSweepOnce(
      sql,
      base({
        resolveLiveness: async () => vmap(verdict('su-2c130be1', 'ended')),
        readUnplannedClusters: async (goals: readonly GoalRowLike[]) => {
          read_ += goals.length;
          return new Map([[KEY, read(9 * 3600_000)]]);
        },
        fileUnplannedCluster: async () => 'WI-NUDGE',
      }),
    );
    expect(read_).toBe(0);
  });

  it('a failed read costs the leg silence, not the sweep', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await runGoalLivenessSweepOnce(
        sql,
        base({
          readUnplannedClusters: async () => {
            throw new Error('pg down');
          },
          fileUnplannedCluster: async () => 'WI-NUDGE',
        }),
      );
      expect(r.skipped).toBe(false);
      expect(r.unplannedClustersFiled).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unplanned-cluster read failed'));
    } finally {
      warn.mockRestore();
    }
  });
});
