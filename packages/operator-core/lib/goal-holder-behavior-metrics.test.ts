import { describe, expect, it } from 'vitest';
import { GOAL_SPEND_SNAPSHOT_SOURCE } from '@papercusp/db-org';
import {
  classifyDissolvedCluster,
  costLineIsUnmeasured,
  coverageHasUncoveredClusterNeed,
  emptyDissolvedClusterFates,
  GOAL_SPEND_ROLLUP_SOURCE,
  HOLDER_BEHAVIOR_CRITERIA,
  HOLDER_BEHAVIOR_INSTRUMENT_KEYS,
  holderBehaviorCriterionForInstrument,
  ownerReportCostVerdict,
  rateGoalHolderBehavior,
  summarizeGoalReviews,
  summarizeGoalDayHolderAttribution,
  summarizeOwnerReports,
  walledEntries,
  type GoalHolderBehaviorMetrics,
  type GoalHolderModeChange,
} from './goal-holder-behavior-metrics';
import { goalSpendFromGoalRow, type GoalReportMeasuredSpend } from './goal-owner-report';

/** The witnessed window's goal spend WAS measured, so "not measured per goal" was false. */
const WITNESSED_SPEND: GoalReportMeasuredSpend = {
  spentCents: 290656,
  measured: true,
  source: 'goal-lineage-rollup',
  measuredAt: '2026-10-03T00:45:43Z',
};
/** Goal 60d3a8 on 2026-10-06: the lineage rollup could not measure spend (WI-10006542). */
const UNMEASURED_SPEND: GoalReportMeasuredSpend = {
  spentCents: null,
  measured: false,
  source: 'goal-lineage-rollup',
  measuredAt: '2026-10-06T08:19:59.897Z',
};

const WINDOW = {
  workspaceId: 'papercusp-workspace',
  goalId: 'work-on-everything-fresh-grading-and-improvement-60d3a8',
  holderOwnerId: 'su-9e72a11f-da70-4737-b3da-62fa98badea8',
  windowStart: '2026-10-03T00:53:17Z',
  windowEnd: '2026-10-03T02:13:10Z',
};

describe('goal-day holder attribution (D-008)', () => {
  const change = (id: string, at: string, ownerId = WINDOW.holderOwnerId, oldMode: string | null = null, newMode: string | null = 'goal', subject: string | null = WINDOW.goalId): GoalHolderModeChange =>
    ({ id, at, ownerId, oldMode, newMode, subject });

  it('requires affirmative full-day election coverage, preserving a same-holder reassertion', () => {
    const full = change('1', '2026-10-02T02:13:10Z');
    const reassert = change('2', WINDOW.windowStart, WINDOW.holderOwnerId, 'goal');
    expect(summarizeGoalDayHolderAttribution(WINDOW, [reassert, full])).toEqual({ status: 'full-goal-day', holderSince: '2026-10-02T02:13:10.000Z' });
    expect(summarizeGoalDayHolderAttribution(WINDOW, [reassert])).toEqual({ status: 'inherited', holderSince: '2026-10-03T00:53:17.000Z' });
    expect(summarizeGoalDayHolderAttribution(WINDOW, [])).toEqual({ status: 'unverified', holderSince: null });
  });

  it('does not credit an old lease after a competing election, own exit, or goal switch; equal timestamps use ledger ids', () => {
    const entry = change('1', '2026-10-02T01:00:00Z');
    const peer = change('9007199254740993', WINDOW.windowStart, 'peer');
    const regain = change('9007199254740994', WINDOW.windowStart);
    const expected = { status: 'inherited', holderSince: '2026-10-03T00:53:17.000Z' };
    expect(summarizeGoalDayHolderAttribution(WINDOW, [regain, peer, entry])).toEqual(expected);
    expect(summarizeGoalDayHolderAttribution(WINDOW, [entry, peer, regain])).toEqual(expected);
    expect(summarizeGoalDayHolderAttribution(WINDOW, [entry, peer])).toEqual({ status: 'unverified', holderSince: null });
    expect(summarizeGoalDayHolderAttribution(WINDOW, [entry, change('2', WINDOW.windowStart, WINDOW.holderOwnerId, 'goal', null)])).toEqual({ status: 'unverified', holderSince: null });
    expect(summarizeGoalDayHolderAttribution(WINDOW, [entry, change('2', WINDOW.windowStart, WINDOW.holderOwnerId, 'goal', 'goal', 'other-goal')])).toEqual({ status: 'unverified', holderSince: null });
    // A future election and a retired peer's exit cannot change this exact historical window.
    expect(summarizeGoalDayHolderAttribution(WINDOW, [entry, change('2', WINDOW.windowStart, 'peer', 'goal', null), change('3', '2026-10-04T00:00:00Z', 'peer')]).status).toBe('full-goal-day');
  });
});

/**
 * The witnessed window (holder su-9e72a11f, 2026-10-03 00:53:17Z-02:13:10Z), measured from
 * the ledgers on 2026-10-03: 0 plans written over 31 unplanned goal items; no ideas filed
 * and the day's reviews said existing plans suffice; both owner reports printed COST "not
 * measured per goal" and listed walled items as bare ids; 2 of 5 loop fires suppressed;
 * 3 timed reminders (1 fired, 2 cancelled, 0 with a reason) and 28 watch cancels with no
 * reason. Every new WOE criterion must FAIL on it (P-013 positive control).
 */
function witnessed(): GoalHolderBehaviorMetrics {
  return {
    version: 2,
    window: WINDOW,
    // The rating's fail case is an OVERDUE CLUSTER, not the 31 unplanned singletons
    // (WI-10005920). Whether the real 00:53Z window had one depends on the detector
    // (unplanned-clusters.ts); this fixture pins the rule, not that measurement.
    planAuthorship: {
      plansNew: 0,
      plansStarted: 0,
      planFleetLaunches: 0,
      unplannedOpenGoalItems: 31,
      unplannedClusters: 1,
      overdueUnplannedClusters: 1,
      overdueClustersAtStart: 1,
      dissolvedOverdueClusters: emptyDissolvedClusterFates(), overdueClustersNudged: 0,
    },
    ideation: {
      since: '2026-10-02T02:13:10.000Z',
      plansNew: 0,
      ...summarizeGoalReviews([
        { invokedAt: '2026-10-02T23:13:03Z', disposition: 'existing-plans-sufficient', coverage: undefined, ideasFiled: [], unplannedAtReview: 29 },
        { invokedAt: '2026-10-03T00:15:35Z', disposition: 'existing-plans-sufficient', coverage: undefined, ideasFiled: [], unplannedAtReview: 30 },
      ]),
    },
    ownerReports: summarizeOwnerReports([
      {
        ts: '2026-10-03T00:58:13Z',
        cost: 'not measured per goal; pot-wide last 24h read $4266 (older read).',
        ownerWalled: 'hud P-003 route (asked ~20:55Z); WI-10004856, WI-10004875, WI-10005042; goal budget ceiling (propose rolling 500000c/86400s).',
      },
      {
        ts: '2026-10-03T01:50:58Z',
        cost: 'not measured per goal; pot-wide last read $4266/24h.',
        ownerWalled: 'hud P-003 route; budget ceiling ask conv-murpg1rk (propose 500000c/86400s); WI-10004856, WI-10004875, WI-10005042.',
      },
    ], WITNESSED_SPEND),
    loop: { deliveredFires: 3, suppressedFires: 2, windowHours: 79.88 / 60 },
    nudges: { timedReminders: 3, fired: 1, cancelled: 2, cancelledWithReason: 0, dischargedCancels: 0, watchChurnWithoutReason: 28 },
  };
}

/** A window that meets every bar. */
function healthy(): GoalHolderBehaviorMetrics {
  return {
    version: 2,
    window: WINDOW,
    planAuthorship: {
      plansNew: 1,
      plansStarted: 1,
      planFleetLaunches: 1,
      unplannedOpenGoalItems: 2,
      unplannedClusters: 0,
      overdueUnplannedClusters: 0,
      overdueClustersAtStart: 0,
      dissolvedOverdueClusters: emptyDissolvedClusterFates(), overdueClustersNudged: 0,
    },
    ideation: {
      since: '2026-10-02T02:13:10.000Z',
      plansNew: 1,
      ideasFiled: 2,
      reviews: 1,
      noNewPlanReviews: 0,
      noNewPlanReviewsOverUnplannedCluster: 0,
      reviewsWithUncoveredClusterNeed: 0,
    },
    ownerReports: {
      reports: 2,
      costCitedMeasured: 2,
      costNotMeasured: 0,
      costGoalSpendUnmeasured: 0,
      costUnverified: 0,
      walledEntries: 2,
      bareWalledEntries: 0,
    },
    loop: { deliveredFires: 5, suppressedFires: 0, windowHours: 1.33 },
    nudges: { timedReminders: 3, fired: 2, cancelled: 1, cancelledWithReason: 1, dischargedCancels: 1, watchChurnWithoutReason: 0 },
  };
}

describe('owner-report COST is judged against measured spend, never by wording (WI-10006542)', () => {
  // The two real wordings goal 60d3a8's holder used on 2026-10-06 for the SAME unmeasured goal
  // spend. The lexical rule scored the first "measured" (pass) and the second a failure.
  const W1_WORDING = 'unknown; coverage=no-ceiling; source=goal-lineage-rollup; measured at=2026-10-06T06:39:42.181Z.';
  const W2_WORDING =
    'Goal lineage rollup reports spentCents=null (07:14:47Z); spend remains unknown. Interactive-holder cost attribution remains unmeasured.';

  it('scores both wordings identically when the goal spend is unmeasured, stamped or not', () => {
    for (const cost of [W1_WORDING, W2_WORDING]) {
      expect(ownerReportCostVerdict({ cost, truthCost: null }, UNMEASURED_SPEND)).toBe('goal-spend-unmeasured');
      expect(ownerReportCostVerdict({ cost, truthCost: 'goal-spend-unmeasured' }, UNMEASURED_SPEND)).toBe('goal-spend-unmeasured');
    }
    const at = (cost: string) =>
      rateGoalHolderBehavior({
        ...healthy(),
        // Sent after UNMEASURED_SPEND was measured (08:19:59Z), so that read is a valid comparator.
        ownerReports: summarizeOwnerReports([{ ts: '2026-10-06T08:22:02Z', cost, ownerWalled: 'WI-1 approve the GitHub App install' }], UNMEASURED_SPEND),
      })['owner-report-truthfulness'].verdict;
    expect(at(W1_WORDING)).toBe('pass');
    expect(at(W2_WORDING)).toBe('pass');
  });

  it('scores both wordings identically as NOT citing a measured spend, whatever they say', () => {
    for (const cost of [W1_WORDING, W2_WORDING]) {
      expect(ownerReportCostVerdict({ cost, truthCost: null }, WITNESSED_SPEND)).toBe('measured-spend-not-cited');
    }
    expect(ownerReportCostVerdict({ cost: 'goal spend $2,906.56 (goal-lineage-rollup)', truthCost: null }, WITNESSED_SPEND)).toBe('cited-measured');
  });

  it("lets the stamp's send-time truth win over the grading-time spend read", () => {
    expect(ownerReportCostVerdict({ cost: W2_WORDING, truthCost: 'goal-spend-unmeasured' }, WITNESSED_SPEND)).toBe('goal-spend-unmeasured');
    expect(ownerReportCostVerdict({ cost: 'n/a', truthCost: 'cited-measured' }, UNMEASURED_SPEND)).toBe('cited-measured');
    // 'unread' means the gate could not read spend at send time: fall through to the spend read.
    expect(ownerReportCostVerdict({ cost: W1_WORDING, truthCost: 'unread' }, WITNESSED_SPEND)).toBe('measured-spend-not-cited');
    expect(ownerReportCostVerdict({ cost: W1_WORDING, truthCost: null }, null)).toBe('unverified');
  });

  it('never judges an unstamped report against spend measured AFTER it was sent (WI-10007037)', () => {
    // Goal 60d3a8, E26: the 20:00:23Z report has no truth summary (the send-time read was
    // unavailable); grading at 00:40Z read 401384c measured 00:38:51Z. That later rollup is
    // not what the holder could cite, so the report is unverified, neither pass nor fail.
    const LATER_SPEND: GoalReportMeasuredSpend = {
      spentCents: 401384,
      measured: true,
      source: 'goal-lineage-rollup',
      measuredAt: '2026-10-07T00:38:51.528Z',
    };
    const report = {
      ts: '2026-10-06T20:00:23.467Z',
      cost: 'Goal-lineage unmeasured 19:53Z; last 392612c 19:48Z, no ceiling.',
      truthCost: null,
    };
    // The same goal's read 10 min later was UNMEASURED (00:48:42Z): post-dated reads flip, so
    // before the fix one report scored three different ways depending on the grading minute.
    expect(ownerReportCostVerdict(report, LATER_SPEND)).toBe('unverified');
    expect(ownerReportCostVerdict(report, { ...LATER_SPEND, measured: false, spentCents: null, measuredAt: '2026-10-07T00:48:42.943Z' })).toBe('unverified');
    // A spend outside the 3% tolerance of the report's 392612c, measured BEFORE the send: still
    // judged, and still a failure (the fix only refuses post-dated reads).
    const FAR = { ...LATER_SPEND, spentCents: 420000 };
    expect(ownerReportCostVerdict(report, { ...FAR, measuredAt: '2026-10-06T19:59:00Z' })).toBe('measured-spend-not-cited');
    expect(ownerReportCostVerdict({ ...report, cost: 'goal spend 420000c' }, { ...FAR, measuredAt: '2026-10-06T19:59:00Z' })).toBe('cited-measured');
    // A send-time truth stamp still wins over any spend read.
    expect(ownerReportCostVerdict({ ...report, truthCost: 'goal-spend-unmeasured' }, FAR)).toBe('goal-spend-unmeasured');
    // No timestamp on either side: no evidence of post-dating, so the legacy comparison holds.
    expect(ownerReportCostVerdict({ cost: report.cost, truthCost: null }, FAR)).toBe('measured-spend-not-cited');
    expect(ownerReportCostVerdict(report, { ...FAR, measuredAt: null })).toBe('measured-spend-not-cited');

    // Rating over the E26 shape: 4 stamped truthful reports + this one is a pass, not a fail.
    const stamped = (ts: string, truthCost: 'cited-measured' | 'goal-spend-unmeasured') => ({
      ts, cost: 'x', ownerWalled: 'WI-10004856 register the GitHub App', truthCost,
    });
    const summary = summarizeOwnerReports([
      stamped('2026-10-06T19:25:24Z', 'goal-spend-unmeasured'),
      stamped('2026-10-06T19:45:16Z', 'cited-measured'),
      { ...report, ownerWalled: 'WI-10004856 register the GitHub App' },
      stamped('2026-10-06T20:53:51Z', 'cited-measured'),
      stamped('2026-10-06T21:09:05Z', 'goal-spend-unmeasured'),
    ], LATER_SPEND);
    expect(summary).toMatchObject({ reports: 5, costNotMeasured: 0, costUnverified: 1, costCitedMeasured: 2, costGoalSpendUnmeasured: 2 });
    expect(rateGoalHolderBehavior({ ...healthy(), ownerReports: summary })['owner-report-truthfulness'].verdict).toBe('pass');
  });

  it('maps goal spend columns by the same rule as the send-time gate, against the DB source tag', () => {
    expect(GOAL_SPEND_ROLLUP_SOURCE).toBe(GOAL_SPEND_SNAPSHOT_SOURCE);
    const row = { spent: 290656, source: GOAL_SPEND_SNAPSHOT_SOURCE, at: '2026-10-03T00:45:43Z', unmeasured: null };
    expect(goalSpendFromGoalRow(row, GOAL_SPEND_ROLLUP_SOURCE).measured).toBe(true);
    expect(goalSpendFromGoalRow({ ...row, unmeasured: 'interactive-usage-stale' }, GOAL_SPEND_ROLLUP_SOURCE).measured).toBe(false);
    expect(goalSpendFromGoalRow({ ...row, spent: null }, GOAL_SPEND_ROLLUP_SOURCE).measured).toBe(false);
    expect(goalSpendFromGoalRow({ ...row, source: 'pot-wide' }, GOAL_SPEND_ROLLUP_SOURCE).measured).toBe(false);
  });
});

describe('goal-holder behavior parsing', () => {
  it('treats a COST line that admits no goal measurement as unmeasured', () => {
    expect(costLineIsUnmeasured('not measured per goal; pot-wide last 24h read $4266')).toBe(true);
    expect(costLineIsUnmeasured('$8779 measured cumulative, pot-wide (not goal-attributable).')).toBe(true);
    expect(costLineIsUnmeasured('')).toBe(true);
    expect(costLineIsUnmeasured('290656c, no ceiling declared, goal-lineage-rollup, measured 20:45:43Z')).toBe(false);
  });

  it('flags walled entries that are only work-item ids', () => {
    const entries = walledEntries('hud P-003 route (solo/fleet/drop); WI-10004856, WI-10004875, WI-10005042; WI-10004856/4875/5042');
    expect(entries.map((entry) => entry.bare)).toEqual([false, true, true]);
    expect(walledEntries('WI-10004856: approve the budget ceiling of 500000c/day')[0].bare).toBe(false);
    expect(walledEntries('none')).toEqual([]);
  });

  it('finds a coverage need spanning 3+ items with no plan and no justification', () => {
    expect(coverageHasUncoveredClusterNeed([{ need: 'liveness', itemRefs: ['WI-1', 'WI-2', 'WI-3'] }])).toBe(true);
    expect(coverageHasUncoveredClusterNeed([{ need: 'liveness', itemRefs: ['WI-1', 'WI-2', 'WI-3'], planRef: 'p' }])).toBe(false);
    expect(coverageHasUncoveredClusterNeed([{ need: 'x', itemRefs: ['WI-1', 'WI-2', 'WI-3'], justification: 'one root cause, one fix' }])).toBe(false);
    expect(coverageHasUncoveredClusterNeed([{ need: 'x', itemRefs: ['WI-1', 'WI-2'] }])).toBe(false);
    expect(coverageHasUncoveredClusterNeed(undefined)).toBe(false);
  });

  it('counts a legacy no-new-plan review over 3+ unplanned items, but not one with a coverage map', () => {
    const summary = summarizeGoalReviews([
      { invokedAt: 'a', disposition: 'existing-plans-sufficient', coverage: undefined, ideasFiled: ['i1'], unplannedAtReview: 5 },
      { invokedAt: 'b', disposition: 'existing-plans-sufficient', coverage: [], ideasFiled: 2, unplannedAtReview: 5 },
      { invokedAt: 'c', disposition: 'route-work', coverage: undefined, ideasFiled: null, unplannedAtReview: 5 },
      { invokedAt: 'd', disposition: 'no-eligible-work', coverage: undefined, ideasFiled: [], unplannedAtReview: 2 },
    ]);
    expect(summary).toEqual({
      ideasFiled: 3,
      reviews: 4,
      noNewPlanReviews: 3,
      noNewPlanReviewsOverUnplannedCluster: 1,
      reviewsWithUncoveredClusterNeed: 0,
    });
  });
});

describe('rateGoalHolderBehavior thresholds', () => {
  it('fails every holder-behavior criterion on the witnessed 00:53Z-02:13Z window (positive control)', () => {
    const metrics = witnessed();
    expect(metrics.ownerReports).toEqual({
      reports: 2,
      costCitedMeasured: 0,
      costNotMeasured: 2,
      costGoalSpendUnmeasured: 0,
      costUnverified: 0,
      walledEntries: 6,
      bareWalledEntries: 2,
    });
    const ratings = rateGoalHolderBehavior(metrics);
    for (const criterion of HOLDER_BEHAVIOR_CRITERIA) {
      expect({ criterion, verdict: ratings[criterion].verdict }).toEqual({ criterion, verdict: 'fail' });
    }
  });

  it('passes every criterion on a window that meets each bar (negative control)', () => {
    const ratings = rateGoalHolderBehavior(healthy());
    for (const criterion of HOLDER_BEHAVIOR_CRITERIA) {
      expect({ criterion, verdict: ratings[criterion].verdict }).toEqual({ criterion, verdict: 'pass' });
    }
  });

  it('plan authorship: an overdue cluster fails unless a plan is written AND staffed; singletons never fail (WI-10005920)', () => {
    const at = (p: { unplanned?: number; clusters?: number; overdue: number; plansNew: number; started?: number; fleets: number }) =>
      rateGoalHolderBehavior({
        ...healthy(),
        planAuthorship: {
          plansNew: p.plansNew,
          plansStarted: p.started ?? 0,
          planFleetLaunches: p.fleets,
          unplannedOpenGoalItems: p.unplanned ?? 3,
          unplannedClusters: p.clusters ?? p.overdue,
          overdueUnplannedClusters: p.overdue,
          overdueClustersAtStart: p.overdue,
          dissolvedOverdueClusters: emptyDissolvedClusterFates(), overdueClustersNudged: 0,
        },
      })['holder-plan-authorship'].verdict;
    // Overdue cluster: nothing written, written only, written+started all fail; staffed passes.
    expect(at({ overdue: 1, plansNew: 0, fleets: 0 })).toBe('fail');
    expect(at({ overdue: 1, plansNew: 1, fleets: 0 })).toBe('fail');
    expect(at({ overdue: 1, plansNew: 1, started: 1, fleets: 0 })).toBe('fail');
    expect(at({ overdue: 1, plansNew: 1, fleets: 1 })).toBe('pass');
    // The measured su-a70547cc shape: 29 unplanned singletons, 0 clusters, 0 plans -> not exercised.
    expect(at({ unplanned: 29, clusters: 0, overdue: 0, plansNew: 0, fleets: 0 })).toBe('unknown');
    // A cluster younger than 2 reporting cycles is not yet due.
    expect(at({ unplanned: 5, clusters: 1, overdue: 0, plansNew: 0, fleets: 0 })).toBe('unknown');
    // Written but not staffed with nothing overdue is unknown; written and staffed passes.
    expect(at({ overdue: 0, plansNew: 1, fleets: 0 })).toBe('unknown');
    expect(at({ overdue: 0, plansNew: 1, fleets: 1 })).toBe('pass');
  });

  it('plan authorship: a cluster overdue at window START is judged by how it dissolved, never "not exercised" (WI-10005965)', () => {
    const at = (fates: Partial<Record<'planned' | 'dismissed-with-reason' | 'dissolved-without-drop' | 'dropped-without-reason', number>>, fleets = 0) =>
      rateGoalHolderBehavior({
        ...healthy(),
        planAuthorship: {
          plansNew: fleets,
          plansStarted: 0,
          planFleetLaunches: fleets,
          unplannedOpenGoalItems: 26,
          unplannedClusters: 0,
          overdueUnplannedClusters: 0,
          overdueClustersAtStart: 1,
          dissolvedOverdueClusters: { ...emptyDissolvedClusterFates(), ...fates },
          overdueClustersNudged: 0,
        },
      })['holder-plan-authorship'];
    // The measured P-008 W2 shape (goal 60d3a8, 2026-10-03): cluster EI-23772322660353682 was
    // overdue at 09:49:40Z; the holder dropped 3 duplicates with reasons and closed the nudge
    // dropped with a reason. Before the fix this read "unknown: Not exercised: 0 clusters".
    const w2 = at({ 'dismissed-with-reason': 1 });
    expect(w2.verdict).toBe('pass');
    expect(w2.reason).toContain('1 dismissed with a reason');
    expect(at({ planned: 1 }).verdict).toBe('pass');
    // Dropping the cluster away with no reason fails, even beside an unrelated staffed plan.
    expect(at({ 'dropped-without-reason': 1 }).verdict).toBe('fail');
    expect(at({ 'dropped-without-reason': 1 }, 1).verdict).toBe('fail');
    // Work completed or items regrouped: nothing to credit or blame.
    expect(at({ 'dissolved-without-drop': 1 }).verdict).toBe('unknown');
  });

  it('plan authorship: a fail names whether the overdue cluster was ever nudged (WI-10005942)', () => {
    const fail = (nudged: number) =>
      rateGoalHolderBehavior({
        ...healthy(),
        planAuthorship: {
          plansNew: 0, plansStarted: 0, planFleetLaunches: 0, unplannedOpenGoalItems: 30,
          unplannedClusters: 1, overdueUnplannedClusters: 1, overdueClustersAtStart: 1,
          dissolvedOverdueClusters: emptyDissolvedClusterFates(), overdueClustersNudged: nudged,
        },
      })['holder-plan-authorship'];
    // P-008 W1 shape: the cluster's detector (signal 5) reached the holder's serving build
    // mid-window and no nudge existed for most of it, so the fail must flag the attribution.
    expect(fail(0).verdict).toBe('fail');
    expect(fail(0).reason).toContain('0 of them had a watchdog nudge filed at least one reporting cycle before window end; check whether the holder could see');
    expect(fail(1).verdict).toBe('fail');
    expect(fail(1).reason).toContain('1 of them had a watchdog nudge filed at least one reporting cycle before window end.');
    expect(fail(1).reason).not.toContain('check whether the holder could see');
  });

  it('classifyDissolvedCluster: plan membership, reasoned nudge close, then per-member drop reasons (WI-10005965)', () => {
    const member = (status: string, reason: string | null = null, planned = false) => ({ status, reason, planned });
    // Measured W2 members: canonical item blocked, 3 duplicates dropped with terminal_completion_ref reasons.
    const w2Members = [
      member('blocked'),
      member('dropped', 'Duplicate kernel stale-artifact preflight symptom; canonical duplicate edge points to EI-23772322660353682.'),
      member('dropped', 'Duplicate kernel stale-artifact preflight symptom; canonical duplicate edge points to EI-23772322660353682.'),
      member('dropped', 'Duplicate kernel stale-artifact preflight symptom; canonical duplicate edge points to EI-23772322660353682.'),
    ];
    const w2Nudge = { status: 'dropped', reason: 'Dropped the request for a new four-item plan after explicit duplicate consolidation.' };
    expect(classifyDissolvedCluster({ members: w2Members, nudges: [w2Nudge] })).toBe('dismissed-with-reason');
    // Per-member drop reasons alone also count as a reasoned dismissal.
    expect(classifyDissolvedCluster({ members: w2Members, nudges: [] })).toBe('dismissed-with-reason');
    // Same drops with no reason anywhere: the dodge this rule exists to catch.
    expect(
      classifyDissolvedCluster({ members: [member('blocked'), member('dropped'), member('dropped', '  '), member('dropped')], nudges: [] }),
    ).toBe('dropped-without-reason');
    // A nudge closed without a reason does not rescue reasonless drops.
    expect(
      classifyDissolvedCluster({ members: [member('dropped'), member('dropped'), member('dropped')], nudges: [{ status: 'dropped', reason: null }] }),
    ).toBe('dropped-without-reason');
    // Planned members, or a nudge closed done, mean the cluster was placed as a plan.
    expect(classifyDissolvedCluster({ members: [member('open', null, true), member('dropped')], nudges: [] })).toBe('planned');
    expect(classifyDissolvedCluster({ members: [member('done'), member('open')], nudges: [{ status: 'done', reason: 'planned as p' }] })).toBe('planned');
    // No member dropped: completed or regrouped.
    expect(classifyDissolvedCluster({ members: [member('done'), member('done'), member('open')], nudges: [] })).toBe('dissolved-without-drop');
  });

  it("review quality counts only the graded holder's reviews; ideas count for the goal (WI-10005920)", () => {
    const legacy = { disposition: 'existing-plans-sufficient', coverage: undefined, unplannedAtReview: 30 };
    const predecessor = summarizeGoalReviews([
      { invokedAt: '2026-10-03T00:15:35Z', ...legacy, ideasFiled: undefined, byHolder: false },
      { invokedAt: '2026-10-03T08:08:22Z', disposition: 'route-work', coverage: [], ideasFiled: ['EI-1'], unplannedAtReview: 28, byHolder: true },
    ]);
    expect(predecessor.noNewPlanReviewsOverUnplannedCluster).toBe(0);
    expect(predecessor.ideasFiled).toBe(1);
    const own = summarizeGoalReviews([{ invokedAt: '2026-10-03T08:30:00Z', ...legacy, ideasFiled: undefined }]);
    expect(own.noNewPlanReviewsOverUnplannedCluster).toBe(1);
  });

  it('ideation: zero candidates in a goal-day fails even with no review; one candidate passes', () => {
    const at = (ideation: Partial<GoalHolderBehaviorMetrics['ideation']>) =>
      rateGoalHolderBehavior({ ...healthy(), ideation: { ...healthy().ideation, ...ideation } })['ideation-yield'].verdict;
    expect(at({ plansNew: 0, ideasFiled: 0, reviews: 0 })).toBe('fail');
    expect(at({ plansNew: 0, ideasFiled: 1 })).toBe('pass');
    expect(at({ reviewsWithUncoveredClusterNeed: 1 })).toBe('fail');
    expect(at({ noNewPlanReviewsOverUnplannedCluster: 1 })).toBe('fail');
  });

  it('ideation: inherited zero-candidate exposure is uncertain, while a full due day or an attributable failed review still fails (D-008)', () => {
    const metrics = healthy();
    metrics.ideation = {
      ...metrics.ideation, plansNew: 0, ideasFiled: 0, reviews: 0,
      holderAttribution: { status: 'inherited', holderSince: WINDOW.windowStart, exercisedReviews: 0 },
    };
    const rate = () => rateGoalHolderBehavior(metrics)['ideation-yield'];
    expect(rate()).toMatchObject({ verdict: 'unknown', unknownReason: 'scope-mismatch' });
    // The old unconditional zero => fail policy distinguishes this fixture from a due day.
    expect(metrics.ideation.plansNew + metrics.ideation.ideasFiled === 0 ? 'fail' : 'pass').toBe('fail');
    metrics.ideation.holderAttribution = { status: 'full-goal-day', holderSince: metrics.ideation.since, exercisedReviews: 0 };
    expect(rate().verdict).toBe('fail');
    metrics.ideation.holderAttribution = { status: 'inherited', holderSince: WINDOW.windowStart, exercisedReviews: 1 };
    expect(rate().verdict).toBe('unknown');
    metrics.ideation.reviewsWithUncoveredClusterNeed = 1;
    expect(rate().verdict).toBe('fail');
    metrics.ideation.reviewsWithUncoveredClusterNeed = 0;
    metrics.ideation.ideasFiled = 1;
    expect(rate().verdict).toBe('pass');
    metrics.ideation.reviewsWithUncoveredClusterNeed = 1;
    expect(rate().verdict).toBe('fail');
  });

  it('owner reports: no report is unknown; one unmeasured COST or one bare walled entry fails', () => {
    const zero = { costCitedMeasured: 0, costNotMeasured: 0, costGoalSpendUnmeasured: 0, costUnverified: 0 };
    const at = (reports: Partial<GoalHolderBehaviorMetrics['ownerReports']>) =>
      rateGoalHolderBehavior({
        ...healthy(),
        ownerReports: { reports: 0, walledEntries: 0, bareWalledEntries: 0, ...zero, ...reports },
      })['owner-report-truthfulness'].verdict;
    expect(at({ reports: 0 })).toBe('unknown');
    expect(at({ reports: 3, costCitedMeasured: 2, costNotMeasured: 1 })).toBe('fail');
    expect(at({ reports: 3, costCitedMeasured: 3, walledEntries: 4, bareWalledEntries: 1 })).toBe('fail');
    // WI-10006542: a truthful "unmeasured" COST while the platform has no measured goal spend passes.
    expect(at({ reports: 3, costGoalSpendUnmeasured: 3 })).toBe('pass');
    expect(at({ reports: 2, costGoalSpendUnmeasured: 1, costUnverified: 1 })).toBe('pass');
    // ...but when no report's COST truth could be established at all, the verdict is unknown.
    expect(at({ reports: 2, costUnverified: 2 })).toBe('unknown');
  });

  it('owner reports: the pass reason never claims measured COST the reports did not cite (WI-10006542)', () => {
    const rating = rateGoalHolderBehavior({
      ...healthy(),
      ownerReports: {
        reports: 3,
        costCitedMeasured: 0,
        costNotMeasured: 0,
        costGoalSpendUnmeasured: 3,
        costUnverified: 0,
        walledEntries: 11,
        bareWalledEntries: 0,
      },
    })['owner-report-truthfulness'];
    expect(rating.verdict).toBe('pass');
    expect(rating.reason).toContain('cited the measured goal spend in 0');
    expect(rating.reason).toContain('truthfully stated goal spend unmeasured (no measured lineage spend) in 3');
    expect(rating.reason).not.toMatch(/with measured COST/);
  });

  it('loop liveness: exactly 1 suppressed fire per hour passes; more fails; fires with none delivered fails', () => {
    const at = (delivered: number, suppressed: number, hours: number) =>
      rateGoalHolderBehavior({ ...healthy(), loop: { deliveredFires: delivered, suppressedFires: suppressed, windowHours: hours } })[
        'stewardship-loop-liveness'
      ].verdict;
    expect(at(3, 1, 1)).toBe('pass');
    expect(at(3, 2, 1)).toBe('fail');
    expect(at(0, 0, 1)).toBe('unknown');
    expect(at(0, 1, 2)).toBe('fail');
  });

  it('nudges: any reasonless cancel fails; under half fired-or-discharged fails; none in window is unknown', () => {
    const at = (nudges: Partial<GoalHolderBehaviorMetrics['nudges']>) =>
      rateGoalHolderBehavior({ ...healthy(), nudges: { ...healthy().nudges, ...nudges } })['nudge-efficacy'].verdict;
    expect(at({ cancelled: 2, cancelledWithReason: 1 })).toBe('fail');
    expect(at({ watchChurnWithoutReason: 1 })).toBe('fail');
    expect(at({ timedReminders: 4, fired: 1, cancelled: 3, cancelledWithReason: 3, dischargedCancels: 0 })).toBe('fail');
    expect(at({ timedReminders: 4, fired: 1, cancelled: 3, cancelledWithReason: 3, dischargedCancels: 1 })).toBe('pass');
    expect(at({ timedReminders: 0, fired: 0, cancelled: 0, cancelledWithReason: 0, dischargedCancels: 0 })).toBe('unknown');
  });

  it('maps every criterion to a distinct woe.* instrument key and back', () => {
    const keys = HOLDER_BEHAVIOR_CRITERIA.map((criterion) => HOLDER_BEHAVIOR_INSTRUMENT_KEYS[criterion]);
    expect(new Set(keys).size).toBe(HOLDER_BEHAVIOR_CRITERIA.length);
    for (const criterion of HOLDER_BEHAVIOR_CRITERIA) {
      expect(holderBehaviorCriterionForInstrument(HOLDER_BEHAVIOR_INSTRUMENT_KEYS[criterion])).toBe(criterion);
    }
    expect(holderBehaviorCriterionForInstrument('woe.goal-mode-base-scorecard')).toBeNull();
  });
});
