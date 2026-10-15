/**
 * start-goal-by-id.test.ts — the P-020 activation primitive's contract
 * (work-on-everything-goal-2026-08-23 P-020, D-006).
 *
 * Everything is injected: the goal-row read rides a fake sql tag, the
 * launch/holders/readiness/attach legs ride StartGoalByIdDeps. Readiness
 * fixtures are built with the REAL `goalReadiness` fold rather than
 * hand-written literals, so a change to the fold's satisfied/pending
 * semantics (e.g. P-019's plan-status mapping) is felt here instead of
 * silently diverging from a stale fixture.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { goalReadiness } from '@papercusp/agent-mcp/goal-deps';
import { evaluateGoalOperatingInputs, renderGoalPortfolioBrief, type GoalLaunchResolution, type GoalPortfolioBrief } from '../goal-launch-settings';
import { buildGoalKickoffBrief } from '../agent-tools/goals/start';
import type { GoalHolders, ResolvedGoalHolder } from './holder';
import { startGoalById, type StartGoalByIdDeps, type StartGoalByIdInput } from './start-goal-by-id';

type GoalRow = {
  id: string;
  title: string;
  status: string;
  install_slug: string | null;
  // The brief-shaped columns (EI-21566842357792802). `budget_cents` is BIGINT,
  // which postgres-js returns as a STRING — the fixture keeps it a string on
  // purpose so the coercion is exercised rather than assumed.
  body: string | null;
  kill_criterion: string | null;
  budget_cents: string | number | null;
  budget_window_sec: string | number | null;
  standing: boolean | null;
};

const WS = 'ws-1';
const GOAL = 'fix-the-roof-a1b2c3';

function fakeSql(rows: GoalRow[]): Sql {
  return ((..._args: unknown[]) => Promise.resolve(rows)) as unknown as Sql;
}

function goalRow(overrides: Partial<GoalRow> = {}): GoalRow {
  return {
    id: GOAL,
    title: 'Fix the roof',
    status: 'active',
    install_slug: 'papercusp',
    body: 'the long form',
    kill_criterion: 'no dry week by October',
    budget_cents: '80000',
    budget_window_sec: null,
    standing: false,
    ...overrides,
  };
}

function holder(overrides: Partial<ResolvedGoalHolder> = {}): ResolvedGoalHolder {
  return {
    goalId: GOAL,
    workspaceId: WS,
    ownerId: 'su-old-holder',
    setAtMs: 1,
    setBy: null,
    sessionState: null,
    selfWake: null,
    heartbeatFresh: null,
    live: null,
    ...overrides,
  };
}

function holdersFixture(liveness: GoalHolders['liveness'], rows: ResolvedGoalHolder[] = []): GoalHolders {
  const elected = rows[0] ?? null;
  const allLive = rows.filter((r) => r.live === true);
  return {
    goalId: GOAL,
    workspaceId: WS,
    holders: rows,
    elected,
    live: elected?.live === true ? [elected] : [],
    allLive,
    overlap: {
      status: 'none',
      liveOwnerIds: allLive.map((row) => row.ownerId),
      predecessorOwnerId: null,
      successorOwnerId: elected?.ownerId ?? null,
      expiresAtMs: null,
    },
    liveness,
  };
}

const READY = goalReadiness([]);
const BLOCKED = goalReadiness([{ kind: 'plan', ref: 'plan:papercusp/some-prereq', status: 'draft' }]);

function launchResolution(overrides: Partial<GoalLaunchResolution> = {}): GoalLaunchResolution {
  return {
    goalId: GOAL,
    settings: null,
    goalBrief: null,
    effective: {},
    ceilings: { maxAgents: 12, maxPerFleet: 5 },
    headcount: { total: 0, fleet: null },
    budget: null,
    refusal: null,
    degraded: false,
    degradedReasons: [],
    ...overrides,
  };
}

function portfolioBrief(): GoalPortfolioBrief {
  return {
    schemaVersion: 1,
    assembledAt: '2026-09-04T23:00:00.000Z',
    goal: {
      id: GOAL,
      title: 'Fix the roof',
      status: 'active',
      body: 'the long form',
      killCriterion: 'no dry week by October',
      standing: false,
      parentId: null,
    },
    worklist: [
      {
        ref: 'plan:papercusp/roof',
        ordinal: 1,
        harness: 'papercusp',
        slug: 'roof',
        title: 'Roof plan',
        status: 'active',
        next: null,
        counts: { todo: 1, wip: 0, blocked: 0, needsHuman: 0, done: 0 },
        ambiguousMatches: 0,
        placement: {
          state: 'unplaced',
          activeLane: null,
          fleet: null,
          launchTransaction: null,
          reconciliation: { consistent: true, action: 'none', reason: 'none', toolCall: null },
          // Unplaced: the plan has open work, so closure does not yet arise.
          closure: null,
        },
      },
    ],
    pots: [],
    drainFleet: { slug: null, exists: null, controlState: null, leaderOwnerId: null, live: null, working: null },
    queue: {
      total: 1,
      terminal: 0,
      inFlight: 0,
      blocked: 0,
      needsHuman: 0,
      claimable: 1,
      claimabilityScope: 'issue-family',
    },
    launch: {
      settings: null,
      ceilings: { maxAgents: 12, maxPerFleet: 5 },
      headcount: { total: 0, fleet: null },
    },
    budget: {
      budgetCents: 80000,
      spentCents: 0,
      unmeasuredPricedSpend: false,
      spentCentsAt: null,
      spentCentsSource: null,
      interactiveUsageFreshnessStatus: null,
      interactiveUsageLastIngestedAtMs: null,
      budgetWindowSec: null,
    },
    tripwires: [],
    pending: { blenderIdeas: 0, acceptanceRubric: null },
    continuity: { checkpoint: null, lastOwnerReportAt: null },
    priorities: ['Delegate the next plan.'],
    degradedReasons: [],
  };
}

function makeDeps(overrides: Partial<StartGoalByIdDeps> = {}): {
  deps: StartGoalByIdDeps;
  launch: ReturnType<typeof vi.fn>;
  resolveGoalLaunch: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  refreshControlAnchor: ReturnType<typeof vi.fn>;
  neutralize: ReturnType<typeof vi.fn>;
  notifyHandoff: ReturnType<typeof vi.fn>;
} {
  const launch = vi.fn().mockResolvedValue({ ownerId: 'su-new-holder', warnings: ['w1'] });
  const resolveGoalLaunch = vi.fn().mockResolvedValue(launchResolution());
  const attach = vi.fn().mockResolvedValue({ ok: true, error: null });
  const refreshControlAnchor = vi.fn().mockResolvedValue(null);
  const neutralize = vi.fn().mockResolvedValue(undefined);
  const notifyHandoff = vi.fn().mockResolvedValue(undefined);
  const stampAgentOwner = vi.fn().mockResolvedValue(undefined);
  const deps: StartGoalByIdDeps = {
    launch,
    resolveGoalLaunch,
    attach,
    refreshControlAnchor,
    neutralize,
    notifyHandoff,
    stampAgentOwner,
    resolveHolders: vi.fn().mockResolvedValue(holdersFixture('unheld')),
    readReadiness: vi.fn().mockResolvedValue(READY),
    // A recognisable stub rather than the real builder: these tests assert that
    // a brief was built FROM THE GOAL ROW and reached the launch door, which a
    // stub echoing its own inputs proves and the real prose would only obscure.
    buildBrief: vi.fn(
      (o: Parameters<StartGoalByIdDeps['buildBrief']>[0]) =>
        `BRIEF(${o.goalId}|${o.title}|kc=${o.killCriterion ?? 'none'}|cents=${o.budgetCents ?? 'none'})`,
    ) as unknown as StartGoalByIdDeps['buildBrief'],
    ...overrides,
  };
  return { deps, launch, resolveGoalLaunch, attach, refreshControlAnchor, neutralize, notifyHandoff };
}

function run(deps: StartGoalByIdDeps, opts: { rows?: GoalRow[]; input?: Partial<StartGoalByIdInput> } = {}) {
  return startGoalById(fakeSql(opts.rows ?? [goalRow()]), { workspaceId: WS, goalId: GOAL, ...opts.input }, deps);
}

describe('startGoalById — the idempotence guard (D-006)', () => {
  it('refuses a goal that does not exist, launching nothing', async () => {
    const { deps, launch } = makeDeps();
    const res = await run(deps, { rows: [] });
    expect(res).toMatchObject({ ok: false, reason: 'not-found' });
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(['paused', 'achieved', 'killed'] as const)(
    "refuses a '%s' goal — activation never resurrects a non-active goal",
    async (status) => {
      const { deps, launch } = makeDeps();
      const res = await run(deps, { rows: [goalRow({ status })] });
      expect(res).toMatchObject({ ok: false, reason: 'not-active' });
      expect(res.ok === false && res.detail).toContain(status);
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it('refuses a goal with no install_slug — no harness to launch into', async () => {
    const { deps, launch } = makeDeps();
    const res = await run(deps, { rows: [goalRow({ install_slug: null })] });
    expect(res).toMatchObject({ ok: false, reason: 'no-harness' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses a goal with a LIVE holder, naming the holder', async () => {
    const { deps, launch } = makeDeps({
      resolveHolders: vi.fn().mockResolvedValue(holdersFixture('held', [holder({ ownerId: 'su-alive', live: true })])),
    });
    const res = await run(deps);
    expect(res).toMatchObject({ ok: false, reason: 'already-held' });
    expect(res.ok === false && res.detail).toContain('su-alive');
    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses on UNKNOWN holder liveness — degraded evidence is not absence', async () => {
    const { deps, launch } = makeDeps({
      resolveHolders: vi.fn().mockResolvedValue(holdersFixture('unknown', [holder()])),
    });
    const res = await run(deps);
    expect(res).toMatchObject({ ok: false, reason: 'holder-unknown' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('proceeds past a LOST holder — that is the recovery case', async () => {
    const { deps, launch } = makeDeps({
      resolveHolders: vi.fn().mockResolvedValue(holdersFixture('lost', [holder({ live: false })])),
    });
    const res = await run(deps);
    expect(res).toMatchObject({ ok: true, ownerId: 'su-new-holder' });
    expect(launch).toHaveBeenCalledOnce();
  });
});

describe('startGoalById — the readiness gate (activation, never dispatch)', () => {
  it('refuses an unready goal without startBlocked, launching nothing', async () => {
    const { deps, launch } = makeDeps({ readReadiness: vi.fn().mockResolvedValue(BLOCKED) });
    const res = await run(deps);
    expect(res).toMatchObject({ ok: false, reason: 'not-ready' });
    expect(res.ok === false && res.detail).toContain('plan:papercusp/some-prereq');
    expect(launch).not.toHaveBeenCalled();
  });

  it('startBlocked overrides, recording the audit trail', async () => {
    const { deps, launch } = makeDeps({ readReadiness: vi.fn().mockResolvedValue(BLOCKED) });
    const res = await run(deps, {
      input: { startBlocked: true, startBlockedReason: 'owner said start anyway' },
    });
    expect(res).toMatchObject({ ok: true, startBlockedOverride: 'owner said start anyway' });
    expect(launch).toHaveBeenCalledOnce();
  });

  it('synthesizes the override reason when none is given', async () => {
    const { deps } = makeDeps({ readReadiness: vi.fn().mockResolvedValue(BLOCKED) });
    const res = await run(deps, { input: { startBlocked: true } });
    expect(res.ok && res.startBlockedOverride).toContain('plan:papercusp/some-prereq');
  });

  it('a ready goal carries a null override', async () => {
    const { deps } = makeDeps();
    const res = await run(deps);
    expect(res).toMatchObject({ ok: true, startBlockedOverride: null });
  });
});

describe('startGoalById — launch then attach', () => {
  it('launches into the goal row harness and attaches the launched identity to THIS goal', async () => {
    const { deps, launch, attach, refreshControlAnchor } = makeDeps();
    const res = await run(deps, { input: { launcherOwnerId: 'trigger-binding-7' } });
    expect(res).toMatchObject({ ok: true, goalId: GOAL, ownerId: 'su-new-holder', warnings: ['w1'] });
    expect(launch).toHaveBeenCalledWith({
      workspaceId: WS,
      goalId: GOAL,
      harnessSlug: 'papercusp',
      launcherOwnerId: 'trigger-binding-7',
      deferSpawn: false,
      // EI-21566842357792802: this assertion used to read `kickoffPrompt: null`
      // — i.e. the defect was PINNED BY A PASSING TEST. An unbriefed goal agent
      // was the documented contract of this door, so nothing was going to catch
      // it; the failure surfaced only when a real holder spent 18 minutes not
      // knowing its own goal. A caller who omits the brief now gets one built
      // from the goal row.
      kickoffPrompt: 'BRIEF(fix-the-roof-a1b2c3|Fix the roof|kc=no dry week by October|cents=80000)',
      renderedPortfolio: null,
      resolvedLaunch: expect.objectContaining({ goalId: GOAL, refusal: null }),
    });
    expect(attach).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        goalId: GOAL,
        ownerId: 'su-new-holder',
        setBy: 'trigger-binding-7',
      }),
    );
    expect(refreshControlAnchor).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'su-new-holder',
        workspaceId: WS,
        origin: 'system',
        actorId: 'trigger-binding-7',
        source: 'mode:set',
        ownerDirected: false,
        sql: expect.anything(),
      }),
    );
  });

  it("defaults attribution to 'goal-start-by-id' and forwards deferSpawn", async () => {
    const { deps, launch, attach } = makeDeps();
    await run(deps, { input: { deferSpawn: true } });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ deferSpawn: true, launcherOwnerId: null }));
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({ setBy: 'goal-start-by-id' }));
  });

  it('threads kickoffPrompt to the launch door (P-017 package starts brief their holder)', async () => {
    const { deps, launch } = makeDeps();
    await run(deps, { input: { kickoffPrompt: 'GOAL brief: keep the queue drained' } });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ kickoffPrompt: 'GOAL brief: keep the queue drained' }),
    );
  });

  it('a launch failure propagates as a throw and nothing is attached', async () => {
    const { deps, attach } = makeDeps();
    (deps.launch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('budget refused'));
    await expect(run(deps)).rejects.toThrow('budget refused');
    expect(attach).not.toHaveBeenCalled();
    expect(deps.stampAgentOwner).not.toHaveBeenCalled();
  });

  it('an attach failure neutralizes the launched identity before throwing', async () => {
    const { deps, neutralize } = makeDeps({
      attach: vi.fn().mockResolvedValue({ ok: false, error: 'mode store down' }),
    });
    await expect(run(deps)).rejects.toThrow(/su-new-holder.*mode store down/s);
    expect(neutralize).toHaveBeenCalledWith({
      workspaceId: WS,
      goalId: GOAL,
      ownerId: 'su-new-holder',
      reason: 'GOAL attachment failed after launch: mode store down',
    });
    expect(deps.stampAgentOwner).not.toHaveBeenCalled();
  });

  it('stamps metadata only after a successful attach and preserves launch warnings', async () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      attach: vi.fn(async () => {
        order.push('attach');
        return { ok: true, error: null };
      }),
      stampAgentOwner: vi.fn(async () => {
        order.push('stamp');
      }),
    });

    const res = await run(deps);

    expect(res).toMatchObject({ ok: true, warnings: ['w1'] });
    expect(order).toEqual(['attach', 'stamp']);
    expect(deps.stampAgentOwner).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: WS,
      goalId: GOAL,
      ownerId: 'su-new-holder',
    });
  });

  it('keeps a successful start when the metadata stamp fails, exposing the failure as a warning', async () => {
    const { deps } = makeDeps({
      stampAgentOwner: vi.fn().mockRejectedValue(new Error('metadata db down')),
    });

    const res = await run(deps);

    expect(res).toMatchObject({
      ok: true,
      ownerId: 'su-new-holder',
      warnings: ['w1', 'agentOwnerId stamp failed: metadata db down'],
    });
  });
});

/* ── a goal agent must be TOLD its goal (EI-21566842357792802) ────────────────
   Omitting `kickoffPrompt` used to send `null`, and the spawned session fell
   through to the generic fleet-member kickoff — "You are a fleet member with no
   human at your keyboard" — which names no goal. The session was still stamped
   `overlay:goal` with the correct subject, so the mode row and the delivered
   prompt disagreed and the goal read healthy everywhere while its agent worked
   unrelated backlog.

   These guard the DEFAULT path specifically, because that is the one every
   trigger / schedule / watchdog leg takes. The explicit-override path already
   had a test; it was the omission that had no guard and a wrong one. ── */
describe('startGoalById — an omitted kickoff is BUILT, never left null', () => {
  it('builds the brief from the goal row and sends it to the launch door', async () => {
    const { deps, launch } = makeDeps();
    await run(deps);
    const sent = (launch.mock.calls[0]?.[0] as { kickoffPrompt: unknown }).kickoffPrompt;
    // The precise failure being guarded: never null, never empty.
    expect(sent).not.toBeNull();
    expect(String(sent)).toContain(GOAL);
    expect(String(sent)).toContain('Fix the roof');
    expect(deps.buildBrief).toHaveBeenCalledWith(
      expect.objectContaining({
        goalId: GOAL,
        title: 'Fix the roof',
        killCriterion: 'no dry week by October',
        standing: false,
      }),
    );
  });

  it('coerces the BIGINT budget to a number — a string ceiling renders a wrong brief', async () => {
    const { deps } = makeDeps();
    await run(deps);
    const arg = (deps.buildBrief as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.budgetCents).toBe(80000);
    expect(typeof arg.budgetCents).toBe('number');
  });

  it('passes null (not NaN) for an absent or unparseable budget', async () => {
    const { deps } = makeDeps();
    await run(deps, { rows: [goalRow({ budget_cents: null, kill_criterion: null })] });
    const arg = (deps.buildBrief as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.budgetCents).toBeNull();
    expect(arg.killCriterion).toBeNull();
  });

  it('reads the GOAL portfolio once, embeds it in the default brief, and hands the same resolution to launch', async () => {
    const portfolio = portfolioBrief();
    const resolved = launchResolution({
      goalBrief: {
        title: 'Fix the roof',
        body: 'the long form',
        killCriterion: 'no dry week by October',
        budgetCents: 80000,
        budgetWindowSec: null,
        standing: false,
        portfolio,
      },
    });
    const renderPortfolio = vi.fn(renderGoalPortfolioBrief);
    const { deps, launch } = makeDeps({
      resolveGoalLaunch: vi.fn().mockResolvedValue(resolved),
      buildBrief: vi.fn(buildGoalKickoffBrief),
      renderPortfolio,
    });

    await run(deps);

    expect(deps.resolveGoalLaunch).toHaveBeenCalledTimes(1);
    expect(renderPortfolio).toHaveBeenCalledTimes(1);
    expect(deps.resolveGoalLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        goalId: GOAL,
        goalRole: 'goal',
        sql: expect.anything(),
      }),
    );
    expect(deps.buildBrief).toHaveBeenCalledWith(expect.objectContaining({ portfolio }));
    const sent = launch.mock.calls[0]?.[0] as {
      kickoffPrompt: string; renderedPortfolio: string | null; resolvedLaunch: GoalLaunchResolution;
    };
    expect(sent.resolvedLaunch).toBe(resolved);
    expect(sent.kickoffPrompt).toContain('GOAL PORTFOLIO SNAPSHOT — assembled 2026-09-04T23:00:00.000Z');
    expect(sent.renderedPortfolio).toContain('GOAL PORTFOLIO SNAPSHOT — assembled 2026-09-04T23:00:00.000Z');
    expect(sent.kickoffPrompt.match(/GOAL PORTFOLIO SNAPSHOT —/g)).toHaveLength(1);
  });

  it('adds the same snapshot to an explicit package brief exactly once', async () => {
    const portfolio = portfolioBrief();
    const resolved = launchResolution({
      goalBrief: {
        title: 'Fix the roof',
        body: 'the long form',
        killCriterion: 'no dry week by October',
        budgetCents: 80000,
        budgetWindowSec: null,
        standing: false,
        portfolio,
      },
    });
    const { deps, launch } = makeDeps({ resolveGoalLaunch: vi.fn().mockResolvedValue(resolved) });

    await run(deps, { input: { kickoffPrompt: 'package brief' } });

    const sent = launch.mock.calls[0]?.[0]?.kickoffPrompt as string;
    expect(sent).toContain('package brief');
    expect(sent.match(/GOAL PORTFOLIO SNAPSHOT —/g)).toHaveLength(1);
    expect(launch.mock.calls[0]?.[0]?.renderedPortfolio).toContain('GOAL PORTFOLIO SNAPSHOT — assembled');
    expect(deps.buildBrief).not.toHaveBeenCalled();
  });

  it('honors a launch-policy refusal before opening a holder process', async () => {
    const { deps, launch } = makeDeps({
      resolveGoalLaunch: vi.fn().mockResolvedValue(
        launchResolution({
          refusal: {
            reason: 'goal_budget_exceeded',
            limit: 100,
            current: 100,
            requested: 1,
            currentScope: 'attributed-by-lineage:authoritative',
            message: 'budget exhausted',
          },
        }),
      ),
    });

    await expect(run(deps)).rejects.toThrow('goal-holder-launch refused for fix-the-roof-a1b2c3: budget exhausted');
    expect(launch).not.toHaveBeenCalled();
  });

  it('returns an operating-input refusal before opening an outcome holder', async () => {
    const readiness = evaluateGoalOperatingInputs({
      standing: false, killCriterion: null, budgetCents: null, budgetWindowSec: null,
      spentCents: null, spentCentsSource: null, unmeasuredPricedSpend: false, tripwires: [],
    });
    const { deps, launch } = makeDeps({
      resolveGoalLaunch: vi.fn().mockResolvedValue(launchResolution({ holderReadiness: readiness })),
    });
    const result = await run(deps);
    expect(result).toMatchObject({ ok: false, reason: 'operating-inputs' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('an explicitly supplied brief still WINS over the built default', async () => {
    const { deps, launch } = makeDeps();
    await run(deps, { input: { kickoffPrompt: 'package brief' } });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ kickoffPrompt: 'package brief' }));
    // The package-start door must not pay for a brief it is about to discard.
    expect(deps.buildBrief).not.toHaveBeenCalled();
  });

  /* CONTROL. Every assertion above would also pass if `launch` were never
     called at all (`mock.calls[0]?.[0]` on an empty array is undefined, and
     `expect(undefined).not.toBeNull()` passes). This pins that the run really
     reaches the launch door, so the guards above cannot go vacuous. */
  it('CONTROL: the fixture actually reaches the launch door', async () => {
    const { deps, launch } = makeDeps();
    await run(deps);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
