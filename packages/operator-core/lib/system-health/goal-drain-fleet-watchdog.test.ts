import { describe, expect, it, vi } from 'vitest';

import type { Sql } from 'postgres';

import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import type { GoalHolderLike } from './goal-liveness-watchdog';
import {
  GOAL_DRAIN_FLEET_DEAD_GRACE_MS,
  GOAL_DRAIN_FLEET_PULL_STALL_WINDOW_MS,
  GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS,
  GOAL_DRAIN_FLEET_RELAUNCH_RATE_LIMIT,
  GOAL_DRAIN_RELAUNCH_SPEND_CEILING,
  DRAIN_WORKER_THROTTLE_FACT_KEY_PREFIX,
  drainWorkerThrottleFactKey,
  goalSpendFraction,
  parseCentsColumn,
  claimSpecFilterConstrainsGoal,
  claimSpecIsGoalScoped,
  classifyDelegatedDrainFleetLiveness,
  classifyDrainWorkerLiveness,
  classifyGoalDrainFleetPullStall,
  decideGoalDrainFleetRelaunch,
  goalDrainRelaunchEligibility,
  goalPinnedRemedySpec,
  makeResolveFleetLiveness,
  resolveGoalPinWritability,
  type GoalPinWritabilityProbe,
  parseGoalDrainRespawnLedger,
  claimSpecIsPlanScoped,
  classifyGoalDrainFleet,
  classifyGoalPlanFleetCoverage,
  fleetKey,
  readActiveFleetPullStallAlerts,
  readGoalPlanFleetObservation,
  runGoalDrainFleetSweepOnce,
  scanGoalDrainFleets,
  type DrainFleetLiveness,
  type DrainFleetSpecScope,
  type GoalDrainAlert,
  type GoalDrainFleetSweepDeps,
  type GoalDrainRelaunchResult,
  type GoalDrainRowLike,
  type GoalPlanFleetCohort,
  type GoalPlanFleetAlert,
  GOAL_PLAN_FLEET_EVENT_MAX_IDS,
  goalPlanFleetEventPayload,
  goalPlanFleetLegEventKey,
  goalPlanFleetRemedy,
  goalPlanFleetSubjectSignature,
  oldestLiveDrainFleetMember,
} from './goal-drain-fleet-watchdog';
import { EVENT_CATALOG } from '../events/await/catalog';
import { DEFAULT_CLAIM_SPEC, type ClaimSpec, type FilterNode } from '../scheduler/claim-spec';
import { evaluateCollapseGuard } from '../scheduler/spec-pool-preview';

const NOW = 1_800_000_000_000;
const PAST_GRACE = NOW - GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS - 60_000;
const noRegisteredActiveFleetsSql = (async (parts: TemplateStringsArray) => {
  const statement = parts.join(' ');
  if (statement.includes('FROM harness_shared.agent_fleets')) return [];
  throw new Error(`unexpected SQL in an orchestration-only test: ${statement}`);
}) as unknown as Sql;

function makeGoal(over: Partial<GoalDrainRowLike> = {}): GoalDrainRowLike {
  return {
    goalId: 'g-1',
    workspaceId: 'ws',
    title: 'ship the thing',
    createdAtMs: PAST_GRACE,
    drainFleet: null,
    ...over,
  };
}

function makeHolder(over: Partial<GoalHolderLike> = {}): GoalHolderLike {
  return { goalId: 'g-1', workspaceId: 'ws', ownerId: 'su-a', setAtMs: PAST_GRACE, ...over };
}

function makeVerdict(
  ownerId: string,
  sessionState: LivenessVerdict['sessionState'],
  selfWake?: LivenessVerdict['selfWake'],
): LivenessVerdict {
  return {
    ownerId,
    sessionState,
    wakeable: sessionState !== 'ended',
    liveTurn: sessionState === 'live',
    confirmLiveness: null,
    heartbeatFresh: sessionState !== 'ended',
    ...(selfWake === undefined ? {} : { selfWake }),
  };
}

const verdicts = (...vs: LivenessVerdict[]) => new Map(vs.map((v) => [v.ownerId, v]));
const fleets = (entries: Record<string, DrainFleetLiveness>) => new Map(Object.entries(entries));
const scopes = (entries: Record<string, DrainFleetSpecScope> = {}) => new Map(Object.entries(entries));

describe('drain-fleet recovery guards', () => {
  it('promotes only the oldest positively-live su member, excluding holders and non-su rows', () => {
    expect(oldestLiveDrainFleetMember('su-dead-leader', ['su-holder'], [
      { agentId: 'su-newer', agentRole: 'su', fleetRole: 'member', sessionState: 'live', startedAt: '2026-10-02T10:00:00Z' },
      { agentId: 'su-oldest', agentRole: 'su', fleetRole: 'member', sessionState: 'live', startedAt: '2026-10-02T09:00:00Z' },
      { agentId: 'su-holder', agentRole: 'su', fleetRole: 'member', sessionState: 'live', startedAt: '2026-10-02T08:00:00Z' },
      { agentId: 'su-unknown', agentRole: 'su', fleetRole: 'member', sessionState: null, startedAt: '2026-10-02T07:00:00Z' },
      { agentId: 'bee', agentRole: 'cup', fleetRole: 'member', sessionState: 'live', startedAt: '2026-10-02T06:00:00Z' },
    ])).toBe('su-oldest');
  });

  it('alarms only after ten minutes with positive live-member/start evidence and no successful pull', () => {
    const member = {
      agentId: 'su-member', agentRole: 'su', fleetRole: 'member', sessionState: 'live' as const,
      startedAt: new Date(NOW - GOAL_DRAIN_FLEET_PULL_STALL_WINDOW_MS - 1).toISOString(),
    };
    expect(classifyGoalDrainFleetPullStall({ members: [member], successfulPullOwnerIds: new Set(), nowMs: NOW }))
      .toMatchObject({ liveMemberIds: ['su-member'] });
    expect(classifyGoalDrainFleetPullStall({ members: [member], successfulPullOwnerIds: new Set(['su-member']), nowMs: NOW })).toBeNull();
    expect(classifyGoalDrainFleetPullStall({
      members: [{ ...member, startedAt: null }], successfulPullOwnerIds: new Set(), nowMs: NOW,
    })).toBeNull();
    expect(classifyGoalDrainFleetPullStall({
      members: [{ ...member, sessionState: null }], successfulPullOwnerIds: new Set(), nowMs: NOW,
    })).toBeNull();
  });

  it('does not treat a live leader as a scheduler pull worker', () => {
    const leader = {
      agentId: 'su-leader', agentRole: 'su', fleetRole: 'leader', sessionState: 'live' as const,
      startedAt: new Date(NOW - GOAL_DRAIN_FLEET_PULL_STALL_WINDOW_MS - 1).toISOString(),
    };
    expect(classifyGoalDrainFleetPullStall({
      members: [leader], successfulPullOwnerIds: new Set(), nowMs: NOW,
    })).toBeNull();
  });

  it('does not let a leader pull mask a stalled worker', () => {
    const startedAt = new Date(NOW - GOAL_DRAIN_FLEET_PULL_STALL_WINDOW_MS - 1).toISOString();
    expect(classifyGoalDrainFleetPullStall({
      members: [
        { agentId: 'su-leader', agentRole: 'su', fleetRole: 'leader', sessionState: 'live' as const, startedAt },
        { agentId: 'su-worker', agentRole: 'su', fleetRole: 'member', sessionState: 'live' as const, startedAt },
      ],
      successfulPullOwnerIds: new Set(['su-leader']),
      nowMs: NOW,
    })).toMatchObject({ liveMemberIds: ['su-worker'] });
  });

  it('scans active registered fleets that have no goal declaration', async () => {
    const statements: string[] = [];
    const sqlTag = vi.fn(async (parts: TemplateStringsArray) => {
      const statement = parts.join(' ');
      statements.push(statement);
      if (statement.includes('FROM harness_shared.agent_fleets')) {
        return [{ workspace_id: 'ws', fleet_slug: 'standalone' }];
      }
      if (statement.includes('FROM harness_shared.tool_invocations')) return [];
      throw new Error(`unexpected query: ${statement}`);
    });
    const readRoster = vi.fn(async () => ({
      entries: [{
        agentId: 'su-member',
        agentRole: 'su',
        fleetRole: 'member',
        sessionState: 'live',
        startedAt: new Date(NOW - GOAL_DRAIN_FLEET_PULL_STALL_WINDOW_MS - 1).toISOString(),
      }],
      degradedLegs: [],
    } as never));
    const readEverMembers = vi.fn(async () => ['su-member']);

    const alerts = await readActiveFleetPullStallAlerts(
      sqlTag as unknown as Sql,
      [],
      NOW,
      { listRoster: readRoster as never, listEverMembers: readEverMembers as never },
    );

    expect(statements[0]).toMatch(/FROM harness_shared\.agent_fleets[\s\S]*WHERE control_state = 'active'/);
    expect(alerts).toEqual([{
      workspaceId: 'ws',
      fleetSlug: 'standalone',
      liveMemberIds: ['su-member'],
      stalledForMs: GOAL_DRAIN_FLEET_PULL_STALL_WINDOW_MS + 1,
    }]);
  });

  it('suppresses an active-fleet pull alarm when any roster evidence leg is degraded', async () => {
    const sqlTag = vi.fn(async (parts: TemplateStringsArray) => {
      const statement = parts.join(' ');
      if (statement.includes('FROM harness_shared.agent_fleets')) {
        return [{ workspace_id: 'ws', fleet_slug: 'uncertain' }];
      }
      throw new Error(`unexpected query: ${statement}`);
    });
    const readRoster = vi.fn(async () => ({
      entries: [{
        agentId: 'su-member',
        agentRole: 'su',
        fleetRole: 'member',
        sessionState: 'live',
        startedAt: new Date(NOW - GOAL_DRAIN_FLEET_PULL_STALL_WINDOW_MS - 1).toISOString(),
      }],
      degradedLegs: ['wakeability'],
    } as never));
    const readEverMembers = vi.fn(async () => ['su-member']);

    const alerts = await readActiveFleetPullStallAlerts(
      sqlTag as unknown as Sql,
      [],
      NOW,
      { listRoster: readRoster as never, listEverMembers: readEverMembers as never },
    );

    expect(alerts).toEqual([]);
    expect(readEverMembers).not.toHaveBeenCalled();
    expect(sqlTag).toHaveBeenCalledTimes(1);
  });
});

describe('P-014 drain worker liveness', () => {
  it('does not let a healthy leader conceal a fleet with zero live workers', () => {
    expect(classifyDrainWorkerLiveness('su-leader', ['su-leader'], verdicts(
      makeVerdict('su-leader', 'live'),
    ))).toBe('dead');
    expect(classifyDrainWorkerLiveness('su-leader', ['su-leader', 'su-dead-worker'], verdicts(
      makeVerdict('su-leader', 'live'), makeVerdict('su-dead-worker', 'ended'),
    ))).toBe('dead');
  });

  it('keeps verified worker coverage even with an unresolved peer, and suppresses when no worker is verified', () => {
    const members = ['su-leader', 'su-unresolved', 'su-worker'];
    expect(classifyDrainWorkerLiveness('su-leader', members, verdicts(
      makeVerdict('su-leader', 'live'), makeVerdict('su-worker', 'live'),
    ))).toBe('alive');
    expect(classifyDrainWorkerLiveness('su-leader', members, verdicts(
      makeVerdict('su-leader', 'live'), makeVerdict('su-worker', 'ended'),
    ))).toBe('unknown');
  });

  it('requires a distinct live delegated leader and holder coupling', () => {
    const members = ['su-holder', 'su-leader', 'su-worker'];
    const live = verdicts(makeVerdict('su-holder', 'live'), makeVerdict('su-leader', 'live'), makeVerdict('su-worker', 'live'));
    expect(classifyDelegatedDrainFleetLiveness('su-holder', null, false, members, live)).toBe('dead');
    expect(classifyDelegatedDrainFleetLiveness('su-holder', 'su-holder', true, members, live)).toBe('dead');
    // EI-24556293106348130: live leader + live worker with no holder edge is an
    // in-place coupling repair ('uncoupled'), never a dead fleet to relaunch —
    // the normal state right after a goal-holder lease handoff.
    expect(classifyDelegatedDrainFleetLiveness('su-holder', 'su-leader', false, members, live)).toBe('uncoupled');
    // ...but uncoupled with no live worker is still dead: coupling alone restores nothing.
    expect(classifyDelegatedDrainFleetLiveness('su-holder', 'su-leader', false, members,
      verdicts(makeVerdict('su-leader', 'live'), makeVerdict('su-worker', 'ended')))).toBe('dead');
    expect(classifyDelegatedDrainFleetLiveness('su-holder', 'su-leader', true, members, live)).toBe('alive');
    expect(classifyDelegatedDrainFleetLiveness('su-holder', 'su-leader', true, members,
      verdicts(makeVerdict('su-worker', 'live')))).toBe('unknown');
    expect(classifyDelegatedDrainFleetLiveness('su-holder', 'su-leader', true, members,
      verdicts(makeVerdict('su-leader', 'ended'), makeVerdict('su-worker', 'live')))).toBe('dead');
  });

  it('uses the current holder for coupling, even when the fleet owner column is stale', async () => {
    const read = vi.fn(async (parts: TemplateStringsArray) => {
      const statement = parts.join(' ');
      if (statement.includes('FROM harness_shared.agent_fleets')) return [{
        workspace_id: 'ws', fleet_slug: 'drain-1', owner: 'su-old-holder', leader_owner_id: 'su-leader',
      }];
      if (statement.includes('FROM harness_shared.coord_presence')) return [
        { workspace_id: 'ws', fleet_slug: 'drain-1', owner_id: 'su-leader' },
        { workspace_id: 'ws', fleet_slug: 'drain-1', owner_id: 'su-worker' },
      ];
      if (statement.includes('FROM harness_shared.agent_couplings')) return [{
        workspace_id: 'ws', agent_a: 'su-current-holder', agent_b: 'su-leader',
      }];
      throw new Error(`unexpected query: ${statement}`);
    });
    const resolve = makeResolveFleetLiveness(read as unknown as Sql, async () => verdicts(
      makeVerdict('su-leader', 'live'), makeVerdict('su-worker', 'live'),
    ));
    const drain = await resolve([{ workspaceId: 'ws', fleetSlug: 'drain-1', holderOwnerId: 'su-current-holder' }]);
    expect(drain.get(fleetKey('ws', 'drain-1'))).toBe('alive');
    // Plan fleets use this resolver too; they do not require a GOAL coupling.
    const plan = await resolve([{ workspaceId: 'ws', fleetSlug: 'drain-1' }]);
    expect(plan.get(fleetKey('ws', 'drain-1'))).toBe('alive');
  });
});

describe('classifyGoalDrainFleet', () => {
  it('alerts no-drain-fleet-declared on a live-held goal past the kickoff grace', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal(),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      fleets({}),
      scopes(),
      NOW,
    );
    expect(alert).toMatchObject({
      reason: 'no-drain-fleet-declared',
      goalId: 'g-1',
      liveHolders: ['su-a'],
    });
  });

  it('stays silent inside the kickoff grace window', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal({ createdAtMs: NOW - 60_000 }),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      fleets({}),
      scopes(),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('stays silent on an UNHELD goal — the liveness sibling owns that alarm', () => {
    const alert = classifyGoalDrainFleet(makeGoal(), [], verdicts(), fleets({}), scopes(), NOW);
    expect(alert).toBeNull();
  });

  it('stays silent when every holder is dead — abandoned is the sibling territory', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal(),
      [makeHolder({ ownerId: 'su-dead' })],
      verdicts(makeVerdict('su-dead', 'ended')),
      fleets({}),
      scopes(),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('a holder with NO oracle verdict is UNKNOWN, never promoted to held-alive', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal(),
      [makeHolder({ ownerId: 'su-mystery' })],
      verdicts(), // oracle degraded — no entry
      fleets({}),
      scopes(),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('parked holder with selfWake none does not count as alive', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal(),
      [makeHolder({ ownerId: 'su-costume' })],
      verdicts(makeVerdict('su-costume', 'parked', 'none')),
      fleets({}),
      scopes(),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('declared + fleet alive + goal-scoped lane is healthy', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal({ drainFleet: 'drain-1' }),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      fleets({ [fleetKey('ws', 'drain-1')]: 'alive' }),
      scopes({ 'g-1': 'goal-scoped' }),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('declared + fleet dead alerts drain-fleet-dead', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal({ drainFleet: 'drain-1' }),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      fleets({ [fleetKey('ws', 'drain-1')]: 'dead' }),
      scopes(),
      NOW,
    );
    expect(alert).toMatchObject({ reason: 'drain-fleet-dead', drainFleet: 'drain-1' });
  });

  it('declared + no fleets-table row alerts drain-fleet-not-found', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal({ drainFleet: 'gone' }),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      fleets({ [fleetKey('ws', 'gone')]: 'not-found' }),
      scopes(),
      NOW,
    );
    expect(alert).toMatchObject({ reason: 'drain-fleet-not-found' });
  });

  it('unknown fleet liveness suppresses — a degraded read is not a dead fleet', () => {
    for (const missing of [fleets({ [fleetKey('ws', 'drain-1')]: 'unknown' as const }), fleets({})]) {
      const alert = classifyGoalDrainFleet(
        makeGoal({ drainFleet: 'drain-1' }),
        [makeHolder()],
        verdicts(makeVerdict('su-a', 'live')),
        missing,
        scopes(),
        NOW,
      );
      expect(alert).toBeNull();
    }
  });

  // ── D-005: held correctly also means SCOPED correctly ────────────────────
  it('an ALIVE fleet with a pot-wide lane alerts drain-fleet-not-goal-scoped', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal({ drainFleet: 'drain-1' }),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      fleets({ [fleetKey('ws', 'drain-1')]: 'alive' }),
      scopes({ 'g-1': 'not-goal-scoped' }),
      NOW,
    );
    expect(alert).toMatchObject({ reason: 'drain-fleet-not-goal-scoped', drainFleet: 'drain-1' });
  });

  it('an ALIVE fleet whose spec could not be read suppresses — unknown never alarms', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal({ drainFleet: 'drain-1' }),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      fleets({ [fleetKey('ws', 'drain-1')]: 'alive' }),
      scopes({ 'g-1': 'unknown' }),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it('a DEAD fleet wins over a bad scope — one classifier verdict per goal', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal({ drainFleet: 'drain-1' }),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      fleets({ [fleetKey('ws', 'drain-1')]: 'dead' }),
      scopes({ 'g-1': 'not-goal-scoped' }),
      NOW,
    );
    expect(alert).toMatchObject({ reason: 'drain-fleet-dead' });
  });

  it('an ALIVE fleet whose goal cohort is STARVED suppresses — the remedy would be refused', () => {
    const alert = classifyGoalDrainFleet(
      makeGoal({ drainFleet: 'drain-1' }),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      fleets({ [fleetKey('ws', 'drain-1')]: 'alive' }),
      scopes({ 'g-1': 'goal-cohort-starved' }),
      NOW,
    );
    expect(alert).toBeNull();
  });
});

/**
 * EI-23748092951882673 — the D-005 obligation and the scheduler's starvation
 * guard must never be armed against each other.
 *
 * The measured conflict: the watchdog demanded a `goal`-pinned lane; writing one
 * collapsed the claimable match 4430 -> 13 of 4444; `evaluateCollapseGuard`
 * correctly refused it; and the only documented way past the refusal was
 * `confirmCollapse:true`, which would actually starve the fleet. An agent that
 * OBEYED the alarm was steered into the damaging action.
 *
 * These tests pin the invariant that resolves it: THE WATCHDOG MUST NOT DEMAND A
 * WRITE THE SCHEDULER WOULD REFUSE. They compose the real remedy builder with
 * the real guard — no mock of either — so the two cannot drift apart silently.
 */
describe('goalPinnedRemedySpec — obligation and scheduler guard share one oracle', () => {
  const kindOnly: ClaimSpec = {
    ...DEFAULT_CLAIM_SPEC,
    view: { filter: { field: 'kind', op: 'in', value: ['bug', 'change'] } as FilterNode },
  };

  it('builds a spec the D-005 predicate itself accepts — the remedy satisfies the alarm', () => {
    expect(claimSpecIsGoalScoped(goalPinnedRemedySpec(DEFAULT_CLAIM_SPEC, 'g-1'), 'g-1')).toBe(true);
    expect(claimSpecIsGoalScoped(goalPinnedRemedySpec(kindOnly, 'g-1'), 'g-1')).toBe(true);
  });

  it('preserves the incumbent narrowing instead of discarding the lane', () => {
    expect(JSON.stringify(goalPinnedRemedySpec(kindOnly, 'g-1').view.filter)).toContain('"kind"');
  });

  it('pins POSITIVELY and specifically — it does not satisfy a different goal', () => {
    expect(claimSpecIsGoalScoped(goalPinnedRemedySpec(kindOnly, 'g-1'), 'g-2')).toBe(false);
  });

  it('the scheduler REFUSES the remedy at the measured incident numbers (4430 -> 13 of 4444)', () => {
    const remedy = goalPinnedRemedySpec(kindOnly, 'g-1');
    const verdict = evaluateCollapseGuard({
      matched: 13,
      pool: 4444,
      previousMatched: 4430,
      previousSource: 'authored',
      confirm: false,
      filter: remedy.view.filter,
      previousFilter: kindOnly.view.filter,
    });
    expect(verdict.refuse).toBe(true);
    // ...so the watchdog MUST read that pair as 'goal-cohort-starved', and
    // classifying it must yield NO alert. An alert here is precisely the bug:
    // it steers the reader toward confirmCollapse:true, which starves the fleet.
    expect(
      classifyGoalDrainFleet(
        makeGoal({ drainFleet: 'drain-1' }),
        [makeHolder()],
        verdicts(makeVerdict('su-a', 'live')),
        fleets({ [fleetKey('ws', 'drain-1')]: 'alive' }),
        scopes({ 'g-1': 'goal-cohort-starved' }),
        NOW,
      ),
    ).toBeNull();
  });

  // POSITIVE CONTROL: the fix must NOT silence D-005 wholesale. A goal whose
  // cohort is genuinely populated still gets its obligation, because there the
  // pinned write lands. Without this, "suppress everything" would also pass.
  it('a POPULATED goal cohort is still an obligation — the guard accepts, so the alarm fires', () => {
    const remedy = goalPinnedRemedySpec(kindOnly, 'g-1');
    const verdict = evaluateCollapseGuard({
      matched: 900, // well above max(ABS_FLOOR, ceil(4430 * RATIO)) = 222
      pool: 4444,
      previousMatched: 4430,
      previousSource: 'authored',
      confirm: false,
      filter: remedy.view.filter,
      previousFilter: kindOnly.view.filter,
    });
    expect(verdict.refuse).toBe(false);
    expect(
      classifyGoalDrainFleet(
        makeGoal({ drainFleet: 'drain-1' }),
        [makeHolder()],
        verdicts(makeVerdict('su-a', 'live')),
        fleets({ [fleetKey('ws', 'drain-1')]: 'alive' }),
        scopes({ 'g-1': 'not-goal-scoped' }),
        NOW,
      ),
    ).toMatchObject({ reason: 'drain-fleet-not-goal-scoped' });
  });
});

/**
 * The probe that decides whether to alarm. These use the REAL
 * `evaluateCollapseGuard` with faked COUNTS, so the thresholds under test are the
 * scheduler's own — a change to RATIO/ABS_FLOOR moves these tests, which is the
 * point: the watchdog's demand is defined by the guard, not by a second copy of it.
 */
describe('resolveGoalPinWritability — only alarm when the remedy is a legal write', () => {
  const kindOnly: ClaimSpec = {
    ...DEFAULT_CLAIM_SPEC,
    view: { filter: { field: 'kind', op: 'in', value: ['bug', 'change'] } as FilterNode },
  };
  type GuardInput = Parameters<GoalPinWritabilityProbe['guard']>[0];

  /** `counts` is the preview queue in call order: [candidate(remedy), previous(incumbent)]. */
  function probe(counts: Array<{ matched: number; pool: number }>, spy?: { calls: GuardInput[] }): GoalPinWritabilityProbe {
    const queue = [...counts];
    return {
      preview: async () => queue.shift() ?? { matched: 0, pool: 0 },
      guard: (input) => {
        spy?.calls.push(input);
        return evaluateCollapseGuard(input);
      },
    };
  }

  it('STARVED: an authored pot-wide lane whose pin collapses the pool does NOT alarm', async () => {
    await expect(
      resolveGoalPinWritability(kindOnly, 'g-1', 'ws', probe([
        { matched: 13, pool: 4444 },
        { matched: 4430, pool: 4444 },
      ])),
    ).resolves.toBe('goal-cohort-starved');
  });

  it('OBLIGATION: an authored lane whose pin keeps a real cohort still alarms', async () => {
    await expect(
      resolveGoalPinWritability(kindOnly, 'g-1', 'ws', probe([
        { matched: 900, pool: 4444 },
        { matched: 4430, pool: 4444 },
      ])),
    ).resolves.toBe('not-goal-scoped');
  });

  it('NO stored spec: measures against DEFAULT and reports previousSource "default"', async () => {
    const spy = { calls: [] as GuardInput[] };
    await expect(
      resolveGoalPinWritability(null, 'g-1', 'ws', probe([{ matched: 40, pool: 4444 }], spy)),
    ).resolves.toBe('not-goal-scoped');
    expect(spy.calls[0]).toMatchObject({ previousSource: 'default', previousMatched: null });
  });

  it('an EMPTY goal cohort with no stored spec is starved, not an obligation', async () => {
    await expect(
      resolveGoalPinWritability(null, 'g-1', 'ws', probe([{ matched: 0, pool: 4444 }])),
    ).resolves.toBe('goal-cohort-starved');
  });

  // ANTI-FOOTGUN. confirmCollapse:true is the override whose USE is the documented
  // harm in EI-23748092951882673. The watchdog asks "would this be REFUSED?", and
  // must never ask "could it be FORCED?" — a true here re-arms the original trap.
  it('NEVER asks the guard to ignore the collapse — confirm is always false', async () => {
    const spy = { calls: [] as GuardInput[] };
    await resolveGoalPinWritability(kindOnly, 'g-1', 'ws', probe([
      { matched: 13, pool: 4444 },
      { matched: 4430, pool: 4444 },
    ], spy));
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].confirm).toBe(false);
  });

  it('a DEGRADED probe is unknown and suppresses — never a false obligation', async () => {
    await expect(
      resolveGoalPinWritability(kindOnly, 'g-1', 'ws', {
        preview: async () => {
          throw new Error('pg down');
        },
        guard: () => {
          throw new Error('unreachable');
        },
      }),
    ).resolves.toBe('unknown');
  });

  it('measures the PINNED remedy against the INCUMBENT — not the same spec twice', async () => {
    const seen: ClaimSpec[] = [];
    await resolveGoalPinWritability(kindOnly, 'g-1', 'ws', {
      preview: async (spec) => {
        seen.push(spec);
        return { matched: 900, pool: 4444 };
      },
      guard: (i) => evaluateCollapseGuard(i),
    });
    expect(seen).toHaveLength(2);
    expect(claimSpecIsGoalScoped(seen[0], 'g-1')).toBe(true); // candidate IS the pinned remedy
    expect(claimSpecIsGoalScoped(seen[1], 'g-1')).toBe(false); // previous is the incumbent lane
  });
});

describe('readGoalPlanFleetObservation', () => {
  it('reuses the watchdog cohort and liveness classifier without side effects', async () => {
    const result = await readGoalPlanFleetObservation(
      {} as Sql,
      { workspaceId: 'ws', goalId: 'g-1' },
      {
        readGoals: async () => ({ goals: [makeGoal()], holders: [makeHolder()] }),
        resolveLiveness: async () => verdicts(makeVerdict('su-a', 'live')),
        resolveFleetLiveness: async () => fleets({}),
        readCohort: async () => ({
          status: 'known',
          plans: [
            {
              goalId: 'g-1',
              workspaceId: 'ws',
              harnessSlug: 'papercusp',
              planSlug: 'plan-a',
              itemIds: ['P-001'],
              targetingFleets: [],
            },
          ],
        }),
      },
    );

    expect(result).toMatchObject({
      status: 'known',
      applicablePlanCount: 1,
      alert: { reason: 'started-plan-no-live-targeting-fleet', planSlug: 'plan-a' },
    });
  });

  it('keeps an unreadable cohort unknown instead of manufacturing no demand', async () => {
    const result = await readGoalPlanFleetObservation(
      {} as Sql,
      { workspaceId: 'ws', goalId: 'g-1' },
      {
        readGoals: async () => ({ goals: [makeGoal()], holders: [makeHolder()] }),
        resolveLiveness: async () => verdicts(makeVerdict('su-a', 'live')),
        resolveFleetLiveness: async () => fleets({}),
        readCohort: async () => ({ status: 'unknown', plans: [] }),
      },
    );
    expect(result).toEqual({ status: 'unknown', alert: null, applicablePlanCount: null });
  });
});

describe('claimSpecFilterConstrainsGoal — the D-005 scope predicate', () => {
  const leaf = { field: 'goal', op: '=', value: 'g-1' };

  it('accepts the positive = leaf and the in form containing the goal', () => {
    expect(claimSpecFilterConstrainsGoal(leaf, 'g-1')).toBe(true);
    expect(claimSpecFilterConstrainsGoal({ field: 'goal', op: 'in', value: ['g-0', 'g-1'] }, 'g-1')).toBe(true);
  });

  it('rejects a leaf for a DIFFERENT goal', () => {
    expect(claimSpecFilterConstrainsGoal(leaf, 'g-2')).toBe(false);
    expect(claimSpecFilterConstrainsGoal({ field: 'goal', op: 'in', value: ['g-0'] }, 'g-1')).toBe(false);
  });

  it('accepts the leaf nested under all (AND narrows)', () => {
    const filter = { all: [{ field: 'kind', op: 'in', value: ['bug'] }, leaf] };
    expect(claimSpecFilterConstrainsGoal(filter, 'g-1')).toBe(true);
  });

  it('an any is scoped only when EVERY branch is (OR widens)', () => {
    expect(claimSpecFilterConstrainsGoal({ any: [leaf, leaf] }, 'g-1')).toBe(true);
    expect(claimSpecFilterConstrainsGoal({ any: [leaf, { field: 'kind', op: '=', value: 'bug' }] }, 'g-1')).toBe(false);
  });

  it('the WI-37711 trap: a negated or != goal leaf NEVER counts as scoping', () => {
    // `goal` is NULLABLE — the negative form silently excludes every unstamped
    // row in the SQL compiler, which is why only the positive form scopes.
    expect(claimSpecFilterConstrainsGoal({ not: leaf }, 'g-1')).toBe(false);
    expect(claimSpecFilterConstrainsGoal({ field: 'goal', op: '!=', value: 'g-2' }, 'g-1')).toBe(false);
  });

  it('an empty / absent filter (the pot-wide default) never counts', () => {
    expect(claimSpecFilterConstrainsGoal(undefined, 'g-1')).toBe(false);
    expect(claimSpecFilterConstrainsGoal({}, 'g-1')).toBe(false);
  });
});

describe('GOAL plan-fleet obligation classifier', () => {
  const plan = (
    planSlug: string,
    targetingFleets: Array<{
      fleetSlug: string;
      liveness: DrainFleetLiveness;
      liveClaimItemIds: string[];
    }> = [],
    itemIds = ['P-001'],
  ) => ({
    goalId: 'g-1',
    workspaceId: 'ws',
    harnessSlug: 'papercusp',
    planSlug,
    itemIds,
    targetingFleets,
  });
  const cohort = (...plans: ReturnType<typeof plan>[]): GoalPlanFleetCohort => ({
    status: 'known',
    plans,
  });

  it('accepts the positive plan =/in claim-spec forms and rejects widening/negative forms', () => {
    expect(claimSpecIsPlanScoped({ view: { filter: { field: 'plan', op: '=', value: 'p-1' } } }, 'p-1')).toBe(true);
    expect(claimSpecIsPlanScoped({ view: { filter: { field: 'plan', op: 'in', value: ['p-0', 'p-1'] } } }, 'p-1')).toBe(
      true,
    );
    expect(claimSpecIsPlanScoped({ view: { filter: { not: { field: 'plan', op: '=', value: 'p-2' } } } }, 'p-1')).toBe(
      false,
    );
    expect(
      claimSpecIsPlanScoped(
        {
          view: {
            filter: {
              any: [
                { field: 'plan', op: '=', value: 'p-1' },
                { field: 'kind', op: '=', value: 'bug' },
              ],
            },
          },
        },
        'p-1',
      ),
    ).toBe(false);
  });

  it('healthy: a live targeting fleet with a live claim on a non-terminal item is silent', () => {
    const result = classifyGoalPlanFleetCoverage(
      makeGoal(),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      cohort(plan('p-healthy', [{ fleetSlug: 'fleet-a', liveness: 'alive', liveClaimItemIds: ['P-001'] }])),
    );
    expect(result).toBeNull();
  });

  it('Leg A: a non-empty started plan with no live targeting fleet alarms', () => {
    const result = classifyGoalPlanFleetCoverage(
      makeGoal(),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      cohort(plan('p-no-fleet')),
    );
    expect(result).toMatchObject({
      reason: 'started-plan-no-live-targeting-fleet',
      planSlug: 'p-no-fleet',
      itemIds: ['P-001'],
    });
  });

  it('Leg B: a live targeting fleet with zero live claims on the plan alarms', () => {
    const result = classifyGoalPlanFleetCoverage(
      makeGoal(),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      cohort(plan('p-unclaimed', [{ fleetSlug: 'fleet-a', liveness: 'alive', liveClaimItemIds: [] }])),
    );
    expect(result).toMatchObject({
      reason: 'started-plan-targeting-fleet-zero-live-claims',
      planSlug: 'p-unclaimed',
    });
  });

  it('unknown cohort or targeting-fleet liveness suppresses rather than alarming', () => {
    const args = [makeGoal(), [makeHolder()], verdicts(makeVerdict('su-a', 'live'))] as const;
    expect(classifyGoalPlanFleetCoverage(...args, { status: 'unknown', plans: [] })).toBeNull();
    expect(
      classifyGoalPlanFleetCoverage(
        ...args,
        cohort(plan('p-unknown', [{ fleetSlug: 'fleet-a', liveness: 'unknown', liveClaimItemIds: [] }])),
      ),
    ).toBeNull();
  });

  it('an empty/completed started plan and a goal without a positively-live holder stay silent', () => {
    expect(
      classifyGoalPlanFleetCoverage(
        makeGoal(),
        [makeHolder()],
        verdicts(makeVerdict('su-a', 'live')),
        cohort(plan('p-empty', [], [])),
      ),
    ).toBeNull();
    expect(
      classifyGoalPlanFleetCoverage(makeGoal(), [makeHolder()], verdicts(), cohort(plan('p-no-fleet'))),
    ).toBeNull();
  });

  it('exactly one classifier speaks per goal, deterministically preferring Leg A', () => {
    const result = classifyGoalPlanFleetCoverage(
      makeGoal(),
      [makeHolder()],
      verdicts(makeVerdict('su-a', 'live')),
      cohort(plan('p-b', [{ fleetSlug: 'fleet-b', liveness: 'alive', liveClaimItemIds: [] }]), plan('p-a')),
    );
    expect(result).toMatchObject({ reason: 'started-plan-no-live-targeting-fleet', planSlug: 'p-a' });
  });
});

describe('scanGoalDrainFleets', () => {
  it('classifies each goal independently', () => {
    const goals = [makeGoal({ goalId: 'g-bad' }), makeGoal({ goalId: 'g-ok', drainFleet: 'drain-ok' })];
    const holders = [makeHolder({ goalId: 'g-bad' }), makeHolder({ goalId: 'g-ok' })];
    const out = scanGoalDrainFleets(
      goals,
      holders,
      verdicts(makeVerdict('su-a', 'live')),
      fleets({ [fleetKey('ws', 'drain-ok')]: 'alive' }),
      scopes({ 'g-ok': 'goal-scoped' }),
      NOW,
    );
    expect(out.map((a) => a.goalId)).toEqual(['g-bad']);
  });
});

describe('runGoalDrainFleetSweepOnce', () => {
  const sql = noRegisteredActiveFleetsSql;

  const baseDeps = () => ({
    readGoals: vi.fn(async () => ({
      goals: [makeGoal({ drainFleet: 'drain-1' })],
      holders: [makeHolder()],
    })),
    resolveLiveness: vi.fn(async () => verdicts(makeVerdict('su-a', 'live'))),
    resolveFleetLiveness: vi.fn(async () => fleets({ [fleetKey('ws', 'drain-1')]: 'dead' as const })),
    resolveFleetSpecScopes: vi.fn(async () => scopes()),
    escalate: vi.fn(async () => {}),
    emitDrainDead: vi.fn(async () => {}),
    promoteDrainLeader: vi.fn(async () => false),
    readPullStallAlerts: vi.fn(async () => []),
    escalatePullStall: vi.fn(async () => {}),
    flagEnabled: vi.fn(async () => true),
    now: () => NOW,
    graceMs: GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS,
    ...relaunchDeps(),
    ...planFleetDeps(),
  });

  it('keeps the active-fleet pull scan running when there are no active goals', async () => {
    const deps = baseDeps();
    deps.readGoals = vi.fn(async () => ({ goals: [], holders: [] }));

    const result = await runGoalDrainFleetSweepOnce(sql, deps);

    expect(deps.readPullStallAlerts).toHaveBeenCalledWith([], NOW);
    expect(result).toMatchObject({ scanned: 0, skipped: false });
  });

  it('repairs an UNCOUPLED fleet in place: no alarm, no dead stamp, no relaunch (EI-24556293106348130)', async () => {
    // Measured 2026-09-30 on goal 60d3a8: a holder handoff left the live drain
    // leader without a coupling edge to the new holder, the fleet read 'dead',
    // and goal:plan-placement fired drain-fleet-dead while the leader was live.
    const repairDrainCoupling = vi.fn(async () => true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = {
        ...baseDeps(),
        resolveFleetLiveness: vi.fn(async () => fleets({ [fleetKey('ws', 'drain-1')]: 'uncoupled' })),
        repairDrainCoupling,
      };
      const res = await runGoalDrainFleetSweepOnce(sql, deps);

      expect(repairDrainCoupling).toHaveBeenCalledTimes(1);
      expect(repairDrainCoupling).toHaveBeenCalledWith(
        expect.objectContaining({ goalId: 'g-1', drainFleet: 'drain-1' }),
        'su-a',
      );
      expect(deps.escalate).not.toHaveBeenCalled();
      expect(deps.emitDrainDead).not.toHaveBeenCalled();
      expect(deps.markDrainDead).not.toHaveBeenCalled();
      expect(deps.reserveRelaunchSlot).not.toHaveBeenCalled();
      expect(deps.relaunchDrainFleet).not.toHaveBeenCalled();
      expect(res).toMatchObject({ escalated: 0, relaunched: 0 });
    } finally {
      warn.mockRestore();
    }
  });

  it('does not repair coupling for a DEAD fleet; that path still alarms and relaunches', async () => {
    const repairDrainCoupling = vi.fn(async () => true);
    const deps = { ...baseDeps(), repairDrainCoupling };
    await runGoalDrainFleetSweepOnce(sql, deps);
    expect(repairDrainCoupling).not.toHaveBeenCalled();
    expect(deps.escalate).toHaveBeenCalled();
  });

  it('skips entirely when the flag is off', async () => {
    const deps = { ...baseDeps(), flagEnabled: vi.fn(async () => false) };
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toEqual({ scanned: 0, escalated: 0, skipped: true, relaunched: 0, relaunchCapped: 0, planFleetEscalated: 0 });
    expect(deps.readGoals).not.toHaveBeenCalled();
  });

  it('escalates AND emits for a dead declared fleet', async () => {
    const deps = baseDeps();
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toEqual({ scanned: 1, escalated: 1, skipped: false, relaunched: 0, relaunchCapped: 0, planFleetEscalated: 0 });
    expect(deps.escalate).toHaveBeenCalledTimes(1);
    expect(deps.emitDrainDead).toHaveBeenCalledTimes(1);
    expect(deps.escalate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'drain-fleet-dead' }));
  });

  it('uses the dead-episode grace to promote a live member before relaunch or alarm', async () => {
    const deps = {
      ...baseDeps(),
      readGoals: vi.fn(async () => ({
        goals: [makeGoal({ drainFleet: 'drain-1', standing: true })],
        holders: [makeHolder()],
      })),
      markDrainDead: vi.fn(async () => NOW - GOAL_DRAIN_FLEET_DEAD_GRACE_MS),
      promoteDrainLeader: vi.fn(async () => true),
    };
    await runGoalDrainFleetSweepOnce(sql, deps);
    expect(deps.promoteDrainLeader).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'drain-fleet-dead' }),
      expect.objectContaining({ drainFleet: 'drain-1' }),
    );
    expect(deps.escalate).toHaveBeenCalledTimes(1);
    expect(deps.emitDrainDead).toHaveBeenCalledTimes(1);
    expect(deps.reserveRelaunchSlot).not.toHaveBeenCalled();
  });

  it('resolves liveness only for holders of active goals, and fleet liveness only for declared fleets', async () => {
    const deps = baseDeps();
    deps.readGoals = vi.fn(async () => ({
      goals: [makeGoal({ drainFleet: 'drain-1' }), makeGoal({ goalId: 'g-2', drainFleet: null })],
      holders: [makeHolder(), makeHolder({ goalId: 'g-closed', ownerId: 'su-irrelevant' })],
    }));
    await runGoalDrainFleetSweepOnce(sql, deps);
    expect(deps.resolveLiveness).toHaveBeenCalledWith(['su-a']);
    expect(deps.resolveFleetLiveness).toHaveBeenCalledWith([{
      workspaceId: 'ws', fleetSlug: 'drain-1', holderOwnerId: 'su-a',
    }]);
  });

  it('a failed escalate is contained and the emit still runs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = baseDeps();
      deps.escalate = vi.fn(async () => {
        throw new Error('escalation surface down');
      });
      const res = await runGoalDrainFleetSweepOnce(sql, deps);
      expect(res).toEqual({ scanned: 1, escalated: 0, skipped: false, relaunched: 0, relaunchCapped: 0, planFleetEscalated: 0 });
      expect(deps.emitDrainDead).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('escalate failed for g-1'));
    } finally {
      warn.mockRestore();
    }
  });

  it('a failed emit is contained and still counts the escalation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = baseDeps();
      deps.emitDrainDead = vi.fn(async () => {
        throw new Error('event engine down');
      });
      const res = await runGoalDrainFleetSweepOnce(sql, deps);
      expect(res).toEqual({ scanned: 1, escalated: 1, skipped: false, relaunched: 0, relaunchCapped: 0, planFleetEscalated: 0 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('event emit failed for g-1'));
    } finally {
      warn.mockRestore();
    }
  });

  it('control: a deliberately-wrong classifier premise would be caught here', async () => {
    // Calibration for the suppress rules — a healthy fleet must produce ZERO
    // escalations; if classifyGoalDrainFleet ever fired on alive fleets this
    // canary fails, proving the suite can catch that class of defect.
    const deps = baseDeps();
    deps.resolveFleetLiveness = vi.fn(async () => fleets({ [fleetKey('ws', 'drain-1')]: 'alive' as const }));
    deps.resolveFleetSpecScopes = vi.fn(async () => scopes({ 'g-1': 'goal-scoped' as const }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toEqual({ scanned: 1, escalated: 0, skipped: false, relaunched: 0, relaunchCapped: 0, planFleetEscalated: 0 });
    expect(deps.escalate).not.toHaveBeenCalled();
    expect(deps.emitDrainDead).not.toHaveBeenCalled();
    // D-005: scope was actually consulted for the alive pair — an implementation
    // that skips the check entirely would also produce zero escalations here.
    expect(deps.resolveFleetSpecScopes).toHaveBeenCalledWith([
      { workspaceId: 'ws', fleetSlug: 'drain-1', goalId: 'g-1' },
    ]);
  });

  // ── D-005 ────────────────────────────────────────────────────────────────
  it('escalates drain-fleet-not-goal-scoped for an ALIVE fleet on a pot-wide lane', async () => {
    const deps = baseDeps();
    deps.resolveFleetLiveness = vi.fn(async () => fleets({ [fleetKey('ws', 'drain-1')]: 'alive' as const }));
    deps.resolveFleetSpecScopes = vi.fn(async () => scopes({ 'g-1': 'not-goal-scoped' as const }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toEqual({ scanned: 1, escalated: 1, skipped: false, relaunched: 0, relaunchCapped: 0, planFleetEscalated: 0 });
    expect(deps.escalate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'drain-fleet-not-goal-scoped' }));
  });

  it('spec scopes are resolved ONLY for alive fleets — dead ones already have their verdict', async () => {
    const deps = baseDeps(); // baseDeps liveness: dead
    await runGoalDrainFleetSweepOnce(sql, deps);
    expect(deps.resolveFleetSpecScopes).not.toHaveBeenCalled();
  });
});

// ── WI-2140699: the relaunch leg ──────────────────────────────────────────────

/** Inert relaunch-leg deps: every ledger write records, nothing launches unless a test says so. */
function relaunchDeps(): Pick<
  GoalDrainFleetSweepDeps,
  | 'relaunchFlagEnabled'
  | 'markDrainDead'
  | 'reserveRelaunchSlot'
  | 'clearDrainLedger'
  | 'relaunchDrainFleet'
  | 'notifyRelaunch'
  | 'escalateRelaunchExhausted'
  | 'deadGraceMs'
> {
  return {
    relaunchFlagEnabled: vi.fn(async () => true),
    // Default: the episode began a full grace ago, so the timing leg says relaunch.
    markDrainDead: vi.fn(async () => NOW - GOAL_DRAIN_FLEET_DEAD_GRACE_MS),
    reserveRelaunchSlot: vi.fn(async () => ({ kind: 'reserved' as const, attemptsInWindow: 1 })),
    clearDrainLedger: vi.fn(async () => {}),
    relaunchDrainFleet: vi.fn(
      async (): Promise<GoalDrainRelaunchResult> => ({ fleetSlug: 'drain-1', ownerId: 'su-drain-1', warnings: [] }),
    ),
    notifyRelaunch: vi.fn(async () => {}),
    escalateRelaunchExhausted: vi.fn(async () => {}),
    deadGraceMs: GOAL_DRAIN_FLEET_DEAD_GRACE_MS,
  };
}

describe('goalDrainRelaunchEligibility (pure gate)', () => {
  const dead = { reason: 'drain-fleet-dead' as const };
  it('a dead or missing declared fleet on a standing goal is eligible', () => {
    expect(goalDrainRelaunchEligibility(dead, { standing: true, drainRespawn: null })).toEqual({ eligible: true });
    expect(
      goalDrainRelaunchEligibility({ reason: 'drain-fleet-not-found' }, { standing: true, drainRespawn: null }),
    ).toEqual({ eligible: true });
  });
  it('an outcome (non-standing) goal keeps the report-only posture', () => {
    expect(goalDrainRelaunchEligibility(dead, { standing: false, drainRespawn: null })).toEqual({
      eligible: false,
      why: 'not-standing',
    });
    expect(goalDrainRelaunchEligibility(dead, { drainRespawn: null })).toMatchObject({ why: 'not-standing' });
  });
  it('undeclared / mis-scoped reasons are holder decisions, never relaunches', () => {
    for (const reason of ['no-drain-fleet-declared', 'drain-fleet-not-goal-scoped'] as const) {
      expect(goalDrainRelaunchEligibility({ reason }, { standing: true, drainRespawn: null })).toEqual({
        eligible: false,
        why: 'reason-not-relaunchable',
      });
    }
  });
  it('a spent budget (needsHuman) holds until a human clears it', () => {
    expect(
      goalDrainRelaunchEligibility(dead, { standing: true, drainRespawn: { deadSinceMs: 1, needsHuman: true } }),
    ).toEqual({ eligible: false, why: 'needs-human' });
  });

  // WI-10004623: the relaunch leg is spend-aware.
  it('GUARD: a goal at/over the spend ceiling is NOT eligible (spend-ceiling), below it still is', () => {
    const standing = { standing: true, drainRespawn: null } as const;
    const atCeiling = { ...standing, spentCents: GOAL_DRAIN_RELAUNCH_SPEND_CEILING * 50_000, budgetCents: 50_000 };
    expect(goalDrainRelaunchEligibility(dead, atCeiling)).toEqual({ eligible: false, why: 'spend-ceiling' });
    expect(goalDrainRelaunchEligibility(dead, { ...standing, spentCents: 50_000, budgetCents: 50_000 })).toEqual({
      eligible: false,
      why: 'spend-ceiling',
    });
    // positive control: the same goal one cent under the ceiling is eligible, so the gate is the ONLY difference
    expect(goalDrainRelaunchEligibility(dead, { ...atCeiling, spentCents: atCeiling.spentCents - 1 })).toEqual({
      eligible: true,
    });
    expect(goalDrainRelaunchEligibility(dead, { ...standing, spentCents: 36_628, budgetCents: 50_000 })).toEqual({
      eligible: true,
    });
  });
  it('unmeasured spend or no budget fails OPEN (cannot tell is never read as over-ceiling)', () => {
    const standing = { standing: true, drainRespawn: null } as const;
    for (const spend of [
      { spentCents: null, budgetCents: 50_000 },
      { spentCents: 49_999, budgetCents: null },
      { spentCents: 49_999, budgetCents: 0 },
      { spentCents: Number.NaN, budgetCents: 50_000 },
      {},
    ]) {
      expect(goalDrainRelaunchEligibility(dead, { ...standing, ...spend })).toEqual({ eligible: true });
    }
  });
  it('a non-relaunchable reason or a non-standing goal wins over the spend verdict (ordering of whys is stable)', () => {
    const over = { spentCents: 50_000, budgetCents: 50_000 };
    expect(goalDrainRelaunchEligibility({ reason: 'no-drain-fleet-declared' }, { standing: true, drainRespawn: null, ...over })).toMatchObject({
      why: 'reason-not-relaunchable',
    });
    expect(goalDrainRelaunchEligibility(dead, { standing: false, drainRespawn: null, ...over })).toMatchObject({ why: 'not-standing' });
    expect(
      goalDrainRelaunchEligibility(dead, { standing: true, drainRespawn: { deadSinceMs: 1, needsHuman: true }, ...over }),
    ).toMatchObject({ why: 'needs-human' });
  });

  // WI-10004626: the steward's worker-throttle mark (a live drain-worker-throttle:<goalId> fact).
  it('GUARD: a throttled standing goal is NOT eligible (steward-throttle); the same goal un-throttled is', () => {
    const standing = { standing: true, drainRespawn: null } as const;
    expect(goalDrainRelaunchEligibility(dead, { ...standing, workerThrottled: true })).toEqual({
      eligible: false,
      why: 'steward-throttle',
    });
    // positive controls: absent and explicit false are both eligible, so the mark is the ONLY difference
    expect(goalDrainRelaunchEligibility(dead, { ...standing, workerThrottled: false })).toEqual({ eligible: true });
    expect(goalDrainRelaunchEligibility(dead, standing)).toEqual({ eligible: true });
    // a truthy-but-not-true value is not a mark (strict === true)
    expect(goalDrainRelaunchEligibility(dead, { ...standing, workerThrottled: 1 as unknown as boolean })).toEqual({
      eligible: true,
    });
  });
  it('steward intent outranks the spend heuristic, but never outranks reason / not-standing / needs-human', () => {
    const over = { spentCents: 50_000, budgetCents: 50_000, workerThrottled: true };
    expect(goalDrainRelaunchEligibility(dead, { standing: true, drainRespawn: null, ...over })).toMatchObject({
      why: 'steward-throttle',
    });
    expect(
      goalDrainRelaunchEligibility({ reason: 'no-drain-fleet-declared' }, { standing: true, drainRespawn: null, ...over }),
    ).toMatchObject({ why: 'reason-not-relaunchable' });
    expect(goalDrainRelaunchEligibility(dead, { standing: false, drainRespawn: null, ...over })).toMatchObject({
      why: 'not-standing',
    });
    expect(
      goalDrainRelaunchEligibility(dead, { standing: true, drainRespawn: { deadSinceMs: 1, needsHuman: true }, ...over }),
    ).toMatchObject({ why: 'needs-human' });
  });
  it('the throttle fact key is the documented prefix + goal id (the steward writes this exact key)', () => {
    expect(DRAIN_WORKER_THROTTLE_FACT_KEY_PREFIX).toBe('drain-worker-throttle:');
    expect(drainWorkerThrottleFactKey('work-on-everything-fresh-grading-and-improvement-60d3a8')).toBe(
      'drain-worker-throttle:work-on-everything-fresh-grading-and-improvement-60d3a8',
    );
  });
});

describe('goalSpendFraction / parseCentsColumn (pure)', () => {
  it('is spent/budget, null when either side is unmeasured or the budget is not positive', () => {
    expect(goalSpendFraction({ spentCents: 36_628, budgetCents: 50_000 })).toBeCloseTo(0.73256, 5);
    expect(goalSpendFraction({ spentCents: 0, budgetCents: 100 })).toBe(0);
    expect(goalSpendFraction({ spentCents: -1, budgetCents: 100 })).toBeNull();
    expect(goalSpendFraction({ spentCents: 10, budgetCents: -5 })).toBeNull();
    expect(goalSpendFraction({})).toBeNull();
  });
  it('parseCentsColumn never coerces junk, blanks or null to 0', () => {
    expect(parseCentsColumn('36628')).toBe(36_628);
    expect(parseCentsColumn(36_628)).toBe(36_628);
    expect(parseCentsColumn('0')).toBe(0);
    for (const junk of [null, undefined, '', '   ', 'abc', Number.NaN, 'Infinity']) {
      expect(parseCentsColumn(junk as string | number | null | undefined)).toBeNull();
    }
  });
});

describe('decideGoalDrainFleetRelaunch (pure timing)', () => {
  it('waits inside the dead grace, relaunches at/after it', () => {
    expect(decideGoalDrainFleetRelaunch(NOW - 1, NOW)).toMatchObject({
      kind: 'wait',
      remainingMs: GOAL_DRAIN_FLEET_DEAD_GRACE_MS - 1,
    });
    expect(decideGoalDrainFleetRelaunch(NOW - GOAL_DRAIN_FLEET_DEAD_GRACE_MS, NOW)).toMatchObject({
      kind: 'relaunch',
      deadForMs: GOAL_DRAIN_FLEET_DEAD_GRACE_MS,
    });
    expect(decideGoalDrainFleetRelaunch(NOW - 3 * GOAL_DRAIN_FLEET_DEAD_GRACE_MS, NOW, 60_000)).toMatchObject({
      kind: 'relaunch',
    });
  });
  it('a future or non-finite stamp reads as "just now" — one more sweep of patience, never a relaunch off a bad clock', () => {
    expect(decideGoalDrainFleetRelaunch(NOW + 5_000, NOW)).toMatchObject({ kind: 'wait', deadSinceMs: NOW });
    expect(decideGoalDrainFleetRelaunch(Number.NaN, NOW)).toMatchObject({ kind: 'wait', deadSinceMs: NOW });
  });
});

describe('parseGoalDrainRespawnLedger', () => {
  it('reads a well-formed ledger, tolerates numeric strings, and treats junk as no episode', () => {
    expect(parseGoalDrainRespawnLedger({ deadSinceMs: 5, needsHuman: true })).toEqual({
      deadSinceMs: 5,
      needsHuman: true,
    });
    expect(parseGoalDrainRespawnLedger({ deadSinceMs: '7' })).toEqual({ deadSinceMs: 7, needsHuman: false });
    expect(parseGoalDrainRespawnLedger({ attempts: [1, 2] })).toEqual({ deadSinceMs: null, needsHuman: false });
    expect(parseGoalDrainRespawnLedger(null)).toBeNull();
    expect(parseGoalDrainRespawnLedger('x')).toBeNull();
    expect(parseGoalDrainRespawnLedger([1])).toBeNull();
  });
});

describe('runGoalDrainFleetSweepOnce — relaunch leg (WI-2140699)', () => {
  const sql = noRegisteredActiveFleetsSql;
  const standingGoal = () =>
    makeGoal({ drainFleet: 'drain-1', standing: true, installSlug: 'papercusp', drainRespawn: null });

  const deadStandingDeps = () => ({
    readGoals: vi.fn(async () => ({ goals: [standingGoal()], holders: [makeHolder()] })),
    resolveLiveness: vi.fn(async () => verdicts(makeVerdict('su-a', 'live'))),
    resolveFleetLiveness: vi.fn(async () => fleets({ [fleetKey('ws', 'drain-1')]: 'dead' as const })),
    resolveFleetSpecScopes: vi.fn(async () => scopes()),
    escalate: vi.fn(async () => {}),
    emitDrainDead: vi.fn(async () => {}),
    flagEnabled: vi.fn(async () => true),
    now: () => NOW,
    graceMs: GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS,
    ...relaunchDeps(),
    ...planFleetDeps(),
  });

  it('GUARD: a standing goal whose declared fleet stayed dead past the grace gets exactly ONE relaunch, the ledger is charged first, and the holder is told', async () => {
    const deps = deadStandingDeps();
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toEqual({ scanned: 1, escalated: 1, skipped: false, relaunched: 1, relaunchCapped: 0, planFleetEscalated: 0 });
    // the report-only rail still fires for the parked holder…
    expect(deps.escalate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'drain-fleet-dead', standing: true }));
    expect(deps.emitDrainDead).toHaveBeenCalledTimes(1);
    // …and the relaunch leg ran in ledger order: mark → reserve → launch → notify
    expect(deps.markDrainDead).toHaveBeenCalledWith(expect.objectContaining({ goalId: 'g-1' }), NOW);
    expect(deps.reserveRelaunchSlot).toHaveBeenCalledTimes(1);
    expect(deps.relaunchDrainFleet).toHaveBeenCalledTimes(1);
    const [alert, goal] = (deps.relaunchDrainFleet as ReturnType<typeof vi.fn>).mock.calls[0] as [
      GoalDrainAlert,
      GoalDrainRowLike,
    ];
    expect(alert.liveHolders).toEqual(['su-a']);
    expect(goal.installSlug).toBe('papercusp');
    expect(deps.notifyRelaunch).toHaveBeenCalledWith(
      expect.objectContaining({ goalId: 'g-1' }),
      expect.objectContaining({ goalId: 'g-1' }),
      expect.objectContaining({ fleetSlug: 'drain-1', ownerId: 'su-drain-1' }),
    );
    expect(deps.escalateRelaunchExhausted).not.toHaveBeenCalled();
    expect(deps.clearDrainLedger).not.toHaveBeenCalled();
    // reservation happens BEFORE the launch — a crash mid-launch still costs the budget
    const order = (name: keyof typeof deps) => (deps[name] as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(order('markDrainDead')).toBeLessThan(order('reserveRelaunchSlot'));
    expect(order('reserveRelaunchSlot')).toBeLessThan(order('relaunchDrainFleet'));
  });

  it('a missing (not-found) declared fleet on a standing goal relaunches the same way', async () => {
    const deps = deadStandingDeps();
    deps.resolveFleetLiveness = vi.fn(async () => fleets({ [fleetKey('ws', 'drain-1')]: 'not-found' as const }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ relaunched: 1, relaunchCapped: 0, planFleetEscalated: 0 });
    expect(deps.relaunchDrainFleet).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'drain-fleet-not-found' }),
      expect.anything(),
    );
  });

  it('inside the dead grace it only stamps the clock — no reservation, no launch', async () => {
    const deps = deadStandingDeps();
    deps.markDrainDead = vi.fn(async () => NOW); // first sighting this sweep
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ escalated: 1, relaunched: 0, relaunchCapped: 0, planFleetEscalated: 0 });
    expect(deps.markDrainDead).toHaveBeenCalledTimes(1);
    expect(deps.reserveRelaunchSlot).not.toHaveBeenCalled();
    expect(deps.relaunchDrainFleet).not.toHaveBeenCalled();
  });

  it('GUARD (WI-10004623): a standing goal at its spend ceiling gets NO relaunch, no ledger stamp and no reservation — the report-only alert still fires', async () => {
    const deps = deadStandingDeps();
    deps.readGoals = vi.fn(async () => ({
      goals: [{ ...standingGoal(), spentCents: 45_000, budgetCents: 50_000 }],
      holders: [makeHolder()],
    }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ escalated: 1, relaunched: 0, relaunchCapped: 0 });
    expect(deps.escalate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'drain-fleet-dead' }));
    expect(deps.markDrainDead).not.toHaveBeenCalled();
    expect(deps.reserveRelaunchSlot).not.toHaveBeenCalled();
    expect(deps.relaunchDrainFleet).not.toHaveBeenCalled();
    expect(deps.escalateRelaunchExhausted).not.toHaveBeenCalled();
  });

  it('positive control (WI-10004623): the same dead standing goal below the ceiling still relaunches', async () => {
    const deps = deadStandingDeps();
    deps.readGoals = vi.fn(async () => ({
      goals: [{ ...standingGoal(), spentCents: 36_628, budgetCents: 50_000 }],
      holders: [makeHolder()],
    }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ relaunched: 1, relaunchCapped: 0 });
    expect(deps.relaunchDrainFleet).toHaveBeenCalledTimes(1);
  });

  it('GUARD (WI-10004626): a standing goal under a steward throttle gets NO relaunch, no ledger stamp and no reservation — the report-only alert still fires', async () => {
    const deps = deadStandingDeps();
    deps.readGoals = vi.fn(async () => ({
      // spend is low on purpose: the throttle, not the spend ceiling, is the only reason it holds
      goals: [{ ...standingGoal(), spentCents: 1_000, budgetCents: 50_000, workerThrottled: true }],
      holders: [makeHolder()],
    }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ escalated: 1, relaunched: 0, relaunchCapped: 0 });
    expect(deps.escalate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'drain-fleet-dead' }));
    expect(deps.markDrainDead).not.toHaveBeenCalled();
    expect(deps.reserveRelaunchSlot).not.toHaveBeenCalled();
    expect(deps.relaunchDrainFleet).not.toHaveBeenCalled();
    expect(deps.escalateRelaunchExhausted).not.toHaveBeenCalled();
  });

  it('positive control (WI-10004626): the same dead standing goal once the throttle is lifted relaunches', async () => {
    const deps = deadStandingDeps();
    deps.readGoals = vi.fn(async () => ({
      goals: [{ ...standingGoal(), spentCents: 1_000, budgetCents: 50_000, workerThrottled: false }],
      holders: [makeHolder()],
    }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ relaunched: 1, relaunchCapped: 0 });
    expect(deps.relaunchDrainFleet).toHaveBeenCalledTimes(1);
  });

  it('GUARD: a spent budget launches nothing and escalates the give-up exactly once per sweep', async () => {
    const deps = deadStandingDeps();
    deps.reserveRelaunchSlot = vi.fn(async () => ({
      kind: 'capped' as const,
      attemptsInWindow: GOAL_DRAIN_FLEET_RELAUNCH_RATE_LIMIT,
    }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ relaunched: 0, relaunchCapped: 1 });
    expect(deps.relaunchDrainFleet).not.toHaveBeenCalled();
    expect(deps.escalateRelaunchExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ goalId: 'g-1' }),
      GOAL_DRAIN_FLEET_RELAUNCH_RATE_LIMIT,
    );
  });

  it('once the ledger says needsHuman the leg is skipped before any write', async () => {
    const deps = deadStandingDeps();
    deps.readGoals = vi.fn(async () => ({
      goals: [makeGoal({ drainFleet: 'drain-1', standing: true, drainRespawn: { deadSinceMs: 1, needsHuman: true } })],
      holders: [makeHolder()],
    }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ escalated: 1, relaunched: 0, relaunchCapped: 0, planFleetEscalated: 0 });
    expect(deps.markDrainDead).not.toHaveBeenCalled();
    expect(deps.relaunchFlagEnabled).not.toHaveBeenCalled();
  });

  it('an OUTCOME goal (standing:false) keeps the pre-WI-2140699 posture: report + emit, never launch, no ledger writes', async () => {
    const deps = deadStandingDeps();
    deps.readGoals = vi.fn(async () => ({
      goals: [makeGoal({ drainFleet: 'drain-1', standing: false })],
      holders: [makeHolder()],
    }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toEqual({ scanned: 1, escalated: 1, skipped: false, relaunched: 0, relaunchCapped: 0, planFleetEscalated: 0 });
    expect(deps.escalate).toHaveBeenCalledWith(expect.objectContaining({ standing: false }));
    expect(deps.markDrainDead).not.toHaveBeenCalled();
    expect(deps.relaunchFlagEnabled).not.toHaveBeenCalled();
    expect(deps.relaunchDrainFleet).not.toHaveBeenCalled();
  });

  it('the relaunch flag is the kill-switch: OFF keeps reporting and writes nothing', async () => {
    const deps = deadStandingDeps();
    deps.relaunchFlagEnabled = vi.fn(async () => false);
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ escalated: 1, relaunched: 0 });
    expect(deps.markDrainDead).not.toHaveBeenCalled();
    expect(deps.relaunchDrainFleet).not.toHaveBeenCalled();
  });

  it('the flag is read at most once per sweep, and only when some alert is eligible', async () => {
    const deps = deadStandingDeps();
    deps.readGoals = vi.fn(async () => ({
      goals: [
        standingGoal(),
        makeGoal({ goalId: 'g-2', drainFleet: 'drain-2', standing: true, installSlug: 'papercusp' }),
      ],
      holders: [makeHolder(), makeHolder({ goalId: 'g-2' })],
    }));
    deps.resolveFleetLiveness = vi.fn(async () =>
      fleets({ [fleetKey('ws', 'drain-1')]: 'dead' as const, [fleetKey('ws', 'drain-2')]: 'dead' as const }),
    );
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ relaunched: 2 });
    expect(deps.relaunchFlagEnabled).toHaveBeenCalledTimes(1);
  });

  it('a launch that throws is contained: the sweep continues, nothing else is charged, and the failure is logged with the budget note', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = deadStandingDeps();
      deps.relaunchDrainFleet = vi.fn(async () => {
        throw new Error('launch-su down');
      });
      const res = await runGoalDrainFleetSweepOnce(sql, deps);
      expect(res).toMatchObject({ escalated: 1, relaunched: 0, relaunchCapped: 0, planFleetEscalated: 0 });
      expect(deps.notifyRelaunch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('relaunch failed for g-1'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('budget charged'));
    } finally {
      warn.mockRestore();
    }
  });

  it('a fleet that reads ALIVE again ends the episode: the ledger (dead clock + needsHuman) is cleared', async () => {
    const deps = deadStandingDeps();
    deps.readGoals = vi.fn(async () => ({
      goals: [
        makeGoal({ drainFleet: 'drain-1', standing: true, drainRespawn: { deadSinceMs: NOW - 1, needsHuman: true } }),
        makeGoal({
          goalId: 'g-clean',
          drainFleet: 'drain-clean',
          standing: true,
          drainRespawn: { deadSinceMs: null, needsHuman: false },
        }),
      ],
      holders: [makeHolder(), makeHolder({ goalId: 'g-clean' })],
    }));
    deps.resolveFleetLiveness = vi.fn(async () =>
      fleets({ [fleetKey('ws', 'drain-1')]: 'alive' as const, [fleetKey('ws', 'drain-clean')]: 'alive' as const }),
    );
    deps.resolveFleetSpecScopes = vi.fn(async () =>
      scopes({ 'g-1': 'goal-scoped' as const, 'g-clean': 'goal-scoped' as const }),
    );
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toEqual({ scanned: 2, escalated: 0, skipped: false, relaunched: 0, relaunchCapped: 0, planFleetEscalated: 0 });
    expect(deps.clearDrainLedger).toHaveBeenCalledTimes(1);
    expect(deps.clearDrainLedger).toHaveBeenCalledWith(expect.objectContaining({ goalId: 'g-1' }));
  });

  it('an UNKNOWN fleet verdict never clears the ledger (conservative rule holds on the way out too)', async () => {
    const deps = deadStandingDeps();
    deps.readGoals = vi.fn(async () => ({
      goals: [
        makeGoal({ drainFleet: 'drain-1', standing: true, drainRespawn: { deadSinceMs: NOW - 1, needsHuman: false } }),
      ],
      holders: [makeHolder()],
    }));
    deps.resolveFleetLiveness = vi.fn(async () => fleets({ [fleetKey('ws', 'drain-1')]: 'unknown' as const }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ escalated: 0, relaunched: 0 });
    expect(deps.clearDrainLedger).not.toHaveBeenCalled();
    expect(deps.markDrainDead).not.toHaveBeenCalled();
  });
});

// ── goal-plan-fleet-obligation-detector P-002: the plan-fleet leg ────────────

/** Inert plan-fleet deps: an EMPTY known cohort, so the leg is silent unless a test says otherwise. */
function planFleetDeps(): Pick<
  GoalDrainFleetSweepDeps,
  'readPlanFleetCohort' | 'escalatePlanFleet' | 'emitPlanFleet' | 'notifyPlanFleetHolders'
> {
  return {
    readPlanFleetCohort: vi.fn(async (): Promise<GoalPlanFleetCohort> => ({ status: 'known', plans: [] })),
    escalatePlanFleet: vi.fn(async () => ({ opened: true })),
    emitPlanFleet: vi.fn(async () => {}),
    notifyPlanFleetHolders: vi.fn(async () => {}),
  };
}

const planRow = (
  planSlug: string,
  targetingFleets: GoalPlanFleetAlert['targetingFleets'] = [],
  itemIds = ['P-001'],
  goalId = 'g-1',
) => ({ goalId, workspaceId: 'ws', harnessSlug: 'papercusp', planSlug, itemIds, targetingFleets });

const knownCohort = (...plans: ReturnType<typeof planRow>[]): GoalPlanFleetCohort => ({ status: 'known', plans });

function makePlanAlert(over: Partial<GoalPlanFleetAlert> = {}): GoalPlanFleetAlert {
  return {
    goalId: 'g-1',
    workspaceId: 'ws',
    title: 'ship the thing',
    reason: 'started-plan-no-live-targeting-fleet',
    planSlug: 'p-a',
    harnessSlug: 'papercusp',
    itemIds: ['P-001', 'P-002'],
    targetingFleets: [],
    liveHolders: ['su-a'],
    ...over,
  };
}

describe('plan-fleet delivery helpers (pure)', () => {
  it('each leg has its own parkable key, both goal-scoped', () => {
    expect(goalPlanFleetLegEventKey(makePlanAlert())).toBe('goal:plan-fleet-missing:g-1');
    expect(
      goalPlanFleetLegEventKey(makePlanAlert({ reason: 'started-plan-targeting-fleet-zero-live-claims' })),
    ).toBe('goal:plan-fleet-unclaimed:g-1');
  });

  it('every emitted key family is registered in the event catalog (an unregistered key reads as "will never fire")', () => {
    const templates = new Set(EVENT_CATALOG.map((e) => e.keyTemplate));
    expect(templates.has('goal:plan-fleet-missing:<goalId>')).toBe(true);
    expect(templates.has('goal:plan-fleet-unclaimed:<goalId>')).toBe(true);
    expect(templates.has('goal:plan-placement:<goalId>')).toBe(true);
  });

  it('the payload carries plan, fleet, spec and claim evidence; id lists are capped but counts stay exact', () => {
    const many = Array.from({ length: GOAL_PLAN_FLEET_EVENT_MAX_IDS + 5 }, (_, i) => `P-${100 + i}`);
    const payload = goalPlanFleetEventPayload(
      makePlanAlert({
        reason: 'started-plan-targeting-fleet-zero-live-claims',
        itemIds: many,
        targetingFleets: [{ fleetSlug: 'fleet-a', liveness: 'alive', liveClaimItemIds: many }],
      }),
    );
    expect(payload).toMatchObject({
      goalId: 'g-1',
      reason: 'started-plan-targeting-fleet-zero-live-claims',
      planSlug: 'p-a',
      harnessSlug: 'papercusp',
      openItemCount: many.length,
      liveHolders: ['su-a'],
    });
    expect(payload.openItemIds).toHaveLength(GOAL_PLAN_FLEET_EVENT_MAX_IDS);
    expect(payload.targetingFleets).toEqual([
      {
        fleetSlug: 'fleet-a',
        liveness: 'alive',
        claimSpecRef: 'fleet:fleet-a',
        liveClaimCount: many.length,
        liveClaimItemIds: many.slice(0, GOAL_PLAN_FLEET_EVENT_MAX_IDS),
      },
    ]);
  });

  it('the dedup subject includes the plan, so a different failing plan is a new escalation', () => {
    expect(goalPlanFleetSubjectSignature(makePlanAlert())).toBe(
      'ws:g-1:started-plan-no-live-targeting-fleet:p-a',
    );
    expect(goalPlanFleetSubjectSignature(makePlanAlert({ planSlug: 'p-b' }))).not.toBe(
      goalPlanFleetSubjectSignature(makePlanAlert()),
    );
  });

  it('the remedy differs by leg: A launches/points a fleet, B says another fleet will NOT help', () => {
    const a = goalPlanFleetRemedy(makePlanAlert());
    expect(a).toContain("fleet:launch-on-plan { plan: 'p-a' }");
    expect(a).toContain('NO fleet whose claim spec targets it');
    const b = goalPlanFleetRemedy(
      makePlanAlert({
        reason: 'started-plan-targeting-fleet-zero-live-claims',
        targetingFleets: [{ fleetSlug: 'fleet-a', liveness: 'alive', liveClaimItemIds: [] }],
      }),
    );
    expect(b).toContain('launching another fleet will not');
    expect(b).toContain("'fleet-a' (alive)");
    expect(b).not.toContain('fleet:launch-on-plan');
  });
});

describe('runGoalDrainFleetSweepOnce — plan-fleet leg (P-002)', () => {
  const sql = noRegisteredActiveFleetsSql;

  /** A live-held goal whose declared drain fleet is healthy, so ONLY the plan-fleet leg can speak. */
  const healthyDrainDeps = (cohort: GoalPlanFleetCohort) => ({
    readGoals: vi.fn(async () => ({ goals: [makeGoal({ drainFleet: 'drain-1' })], holders: [makeHolder()] })),
    resolveLiveness: vi.fn(async () => verdicts(makeVerdict('su-a', 'live'))),
    resolveFleetLiveness: vi.fn(async () => fleets({ [fleetKey('ws', 'drain-1')]: 'alive' as const })),
    resolveFleetSpecScopes: vi.fn(async () => scopes({ 'g-1': 'goal-scoped' as const })),
    escalate: vi.fn(async () => {}),
    emitDrainDead: vi.fn(async () => {}),
    flagEnabled: vi.fn(async () => true),
    now: () => NOW,
    graceMs: GOAL_DRAIN_FLEET_KICKOFF_GRACE_MS,
    ...relaunchDeps(),
    ...planFleetDeps(),
    readPlanFleetCohort: vi.fn(async () => cohort),
  });

  it('Leg A: escalates, emits and wakes the live holder for a started plan with no targeting fleet', async () => {
    const deps = healthyDrainDeps(knownCohort(planRow('p-no-fleet')));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toEqual({
      scanned: 1, escalated: 0, skipped: false, relaunched: 0, relaunchCapped: 0, planFleetEscalated: 1,
    });
    const expected = expect.objectContaining({
      goalId: 'g-1',
      reason: 'started-plan-no-live-targeting-fleet',
      planSlug: 'p-no-fleet',
      liveHolders: ['su-a'],
    });
    expect(deps.escalatePlanFleet).toHaveBeenCalledWith(expected);
    expect(deps.emitPlanFleet).toHaveBeenCalledWith(expected);
    expect(deps.notifyPlanFleetHolders).toHaveBeenCalledWith(expected);
    // the drain leg stays silent: the two obligations never borrow each other's voice
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it('Leg B: a live targeting fleet with zero live claims reports the spec-scope reason', async () => {
    const deps = healthyDrainDeps(
      knownCohort(planRow('p-unclaimed', [{ fleetSlug: 'fleet-a', liveness: 'alive', liveClaimItemIds: [] }])),
    );
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res.planFleetEscalated).toBe(1);
    expect(deps.escalatePlanFleet).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'started-plan-targeting-fleet-zero-live-claims', planSlug: 'p-unclaimed' }),
    );
  });

  it('exactly one plan-fleet verdict per goal per sweep, even with both legs present', async () => {
    const deps = healthyDrainDeps(
      knownCohort(
        planRow('p-b', [{ fleetSlug: 'fleet-b', liveness: 'alive', liveClaimItemIds: [] }]),
        planRow('p-a'),
      ),
    );
    await runGoalDrainFleetSweepOnce(sql, deps);
    expect(deps.escalatePlanFleet).toHaveBeenCalledTimes(1);
    expect(deps.emitPlanFleet).toHaveBeenCalledTimes(1);
    expect(deps.escalatePlanFleet).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'started-plan-no-live-targeting-fleet', planSlug: 'p-a' }),
    );
  });

  it('a coalesced (already-open) escalation still emits but does NOT re-wake the holder', async () => {
    const deps = healthyDrainDeps(knownCohort(planRow('p-no-fleet')));
    deps.escalatePlanFleet = vi.fn(async () => ({ opened: false }));
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res.planFleetEscalated).toBe(1);
    expect(deps.emitPlanFleet).toHaveBeenCalledTimes(1);
    expect(deps.notifyPlanFleetHolders).not.toHaveBeenCalled();
  });

  it('control: a healthy plan (live targeting fleet with a live claim) is silent', async () => {
    const deps = healthyDrainDeps(
      knownCohort(planRow('p-ok', [{ fleetSlug: 'fleet-a', liveness: 'alive', liveClaimItemIds: ['P-001'] }])),
    );
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res.planFleetEscalated).toBe(0);
    // the cohort WAS read for the live-held goal — a leg that never looked would also be silent
    expect(deps.readPlanFleetCohort).toHaveBeenCalledWith(
      [expect.objectContaining({ goalId: 'g-1' })],
      deps.resolveFleetLiveness,
    );
    expect(deps.escalatePlanFleet).not.toHaveBeenCalled();
    expect(deps.emitPlanFleet).not.toHaveBeenCalled();
    expect(deps.notifyPlanFleetHolders).not.toHaveBeenCalled();
  });

  it('an UNKNOWN cohort, or an unknown targeting fleet, suppresses rather than alarms', async () => {
    for (const cohort of [
      { status: 'unknown', plans: [] } as GoalPlanFleetCohort,
      knownCohort(planRow('p-x', [{ fleetSlug: 'fleet-a', liveness: 'unknown', liveClaimItemIds: [] }])),
    ]) {
      const deps = healthyDrainDeps(cohort);
      const res = await runGoalDrainFleetSweepOnce(sql, deps);
      expect(res.planFleetEscalated).toBe(0);
      expect(deps.escalatePlanFleet).not.toHaveBeenCalled();
      expect(deps.emitPlanFleet).not.toHaveBeenCalled();
    }
  });

  it('a goal without a POSITIVELY-live holder is never judged (the liveness sibling owns it)', async () => {
    const deps = healthyDrainDeps(knownCohort(planRow('p-no-fleet')));
    deps.resolveLiveness = vi.fn(async () => verdicts()); // holder unresolved = unknown, not alive
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res.planFleetEscalated).toBe(0);
    expect(deps.readPlanFleetCohort).not.toHaveBeenCalled();
  });

  it('the flag is the kill-switch for this leg too', async () => {
    const deps = { ...healthyDrainDeps(knownCohort(planRow('p-no-fleet'))), flagEnabled: vi.fn(async () => false) };
    const res = await runGoalDrainFleetSweepOnce(sql, deps);
    expect(res).toMatchObject({ skipped: true, planFleetEscalated: 0 });
    expect(deps.readPlanFleetCohort).not.toHaveBeenCalled();
  });

  it('failures are contained: a throwing reader costs nothing else; a failed escalate still emits and does not wake', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const reader = healthyDrainDeps(knownCohort());
      reader.readPlanFleetCohort = vi.fn(async () => {
        throw new Error('cohort read down');
      });
      reader.resolveFleetLiveness = vi.fn(async () => fleets({ [fleetKey('ws', 'drain-1')]: 'dead' as const }));
      const r1 = await runGoalDrainFleetSweepOnce(sql, reader);
      expect(r1).toMatchObject({ escalated: 1, planFleetEscalated: 0 }); // the drain leg still spoke

      const esc = healthyDrainDeps(knownCohort(planRow('p-no-fleet')));
      esc.escalatePlanFleet = vi.fn(async () => {
        throw new Error('escalation surface down');
      });
      const r2 = await runGoalDrainFleetSweepOnce(sql, esc);
      expect(r2.planFleetEscalated).toBe(0);
      expect(esc.emitPlanFleet).toHaveBeenCalledTimes(1);
      expect(esc.notifyPlanFleetHolders).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('plan-fleet escalate failed for g-1'));
    } finally {
      warn.mockRestore();
    }
  });
});
