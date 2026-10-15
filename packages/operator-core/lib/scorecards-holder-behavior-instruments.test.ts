/**
 * P-013 (goal-holder-plans-ideation-truthful-reports-2026-10-03): the WOE holder-behavior
 * criteria are bound to platform-computed instruments, so a grader cannot pass a window
 * whose ledgers show the witnessed failures (no plans over a 3+ item cluster, no ideation
 * yield, unmeasured COST lines, suppressed loop fires, reminders that never bit).
 *
 * The positive control is the measured 00:53:17Z-02:13:10Z window for holder su-9e72a11f:
 * every holder-behavior instrument must read fail, and a claimed pass on any of them must
 * be a verdictMismatch (which scorecards:emit refuses).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  evaluateScorecardInstrumentContract,
  resolveScorecardInstrumentSnapshots,
  WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC,
} from './scorecards';
import {
  emptyDissolvedClusterFates,
  HOLDER_BEHAVIOR_CRITERIA,
  HOLDER_BEHAVIOR_INSTRUMENT_KEYS,
  type GoalHolderBehaviorMetrics,
} from './goal-holder-behavior-metrics';
import type { ObservationRatings } from './harness/improvements/observation-types';
import type { Rubric } from './rubrics';

const subject = {
  kind: 'agent-run' as const,
  ref: 'su-9e72a11f-da70-4737-b3da-62fa98badea8',
  windowStart: '2026-10-03T00:53:17Z',
  windowEnd: '2026-10-03T02:13:10Z',
};
const now = () => Date.parse('2026-10-03T02:30:00Z');

const rubric = {
  rubricId: WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC,
  criteria: HOLDER_BEHAVIOR_CRITERIA.map((key) => ({
    key,
    instrumentKey: HOLDER_BEHAVIOR_INSTRUMENT_KEYS[key],
    window: { kind: 'rolling', ms: 86_400_000 },
  })),
} as unknown as Rubric;

/** The ledger readings measured for the witnessed window (WI-10005807 live probe). */
const witnessed = (): GoalHolderBehaviorMetrics => ({
  version: 2,
  window: {
    workspaceId: 'default',
    goalId: '60d3a8',
    holderOwnerId: subject.ref,
    windowStart: subject.windowStart,
    windowEnd: subject.windowEnd,
  },
  planAuthorship: {
    plansNew: 0,
    plansStarted: 0,
    planFleetLaunches: 0,
    unplannedOpenGoalItems: 39,
    unplannedClusters: 1,
    overdueUnplannedClusters: 1,
    overdueClustersAtStart: 1,
    dissolvedOverdueClusters: emptyDissolvedClusterFates(),
    overdueClustersNudged: 0,
  },
  ideation: {
    since: '2026-10-02T02:13:10Z',
    plansNew: 0,
    ideasFiled: 0,
    reviews: 7,
    noNewPlanReviews: 7,
    noNewPlanReviewsOverUnplannedCluster: 7,
    reviewsWithUncoveredClusterNeed: 0,
  },
  ownerReports: {
    reports: 2,
    costCitedMeasured: 0,
    costNotMeasured: 2,
    costGoalSpendUnmeasured: 0,
    costUnverified: 0,
    walledEntries: 6,
    bareWalledEntries: 2,
  },
  loop: { deliveredFires: 3, suppressedFires: 2, windowHours: 1.33 },
  nudges: {
    timedReminders: 3,
    fired: 0,
    cancelled: 3,
    cancelledWithReason: 0,
    dischargedCancels: 0,
    watchChurnWithoutReason: 12,
  },
});

/** A window that meets every bar. */
const healthy = (): GoalHolderBehaviorMetrics => ({
  ...witnessed(),
  planAuthorship: {
    plansNew: 1,
    plansStarted: 1,
    planFleetLaunches: 1,
    unplannedOpenGoalItems: 0,
    unplannedClusters: 0,
    overdueUnplannedClusters: 0,
    overdueClustersAtStart: 0,
    dissolvedOverdueClusters: emptyDissolvedClusterFates(),
    overdueClustersNudged: 0,
  },
  ideation: { ...witnessed().ideation, plansNew: 1, ideasFiled: 1, noNewPlanReviews: 0, noNewPlanReviewsOverUnplannedCluster: 0 },
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
  nudges: { timedReminders: 2, fired: 2, cancelled: 0, cancelledWithReason: 0, dischargedCancels: 0, watchChurnWithoutReason: 0 },
});

const claim = (rating: string): ObservationRatings =>
  Object.fromEntries(
    HOLDER_BEHAVIOR_CRITERIA.map((key) => [
      key,
      { rating, evidence: 'Claimed by the grader.', evidenceRef: 'tool:scorecards:test', evidenceKind: 'tool', attribution: 'subject' },
    ]),
  ) as ObservationRatings;

describe('WOE holder-behavior instruments', () => {
  it('measures every holder-behavior criterion as a platform-computed fail on the witnessed window', async () => {
    const holderMetrics = vi.fn(async () => witnessed());
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric, subject }, { now, holderMetrics });
    // One ledger read serves all five instruments.
    expect(holderMetrics).toHaveBeenCalledTimes(1);
    expect(holderMetrics).toHaveBeenCalledWith({
      holderOwnerId: subject.ref,
      windowStart: subject.windowStart,
      windowEnd: subject.windowEnd,
    });
    for (const criterion of HOLDER_BEHAVIOR_CRITERIA) {
      expect(snapshots?.[HOLDER_BEHAVIOR_INSTRUMENT_KEYS[criterion]]).toMatchObject({
        verdict: 'fail',
        provenance: 'platform-computed',
        evidenceRef: 'goal-holder-behavior-metrics',
        value: { resolver: HOLDER_BEHAVIOR_INSTRUMENT_KEYS[criterion], criterion, goalId: '60d3a8' },
      });
    }
  });

  it('refuses a claimed pass on every criterion of the witnessed window (positive control)', async () => {
    const instrumentSnapshots = await resolveScorecardInstrumentSnapshots(
      { rubric, subject },
      { now, holderMetrics: async () => witnessed() },
    );
    const out = evaluateScorecardInstrumentContract({ rubric, ratings: claim('pass'), instrumentSnapshots, nowMs: now() });
    expect(out.verdictMismatches.sort()).toEqual(Object.values(HOLDER_BEHAVIOR_INSTRUMENT_KEYS).sort());
    expect(out.valid).toBe(false);
    // A rubric-faithful fail on the same window is accepted.
    const faithful = evaluateScorecardInstrumentContract({ rubric, ratings: claim('fail'), instrumentSnapshots, nowMs: now() });
    expect(faithful.verdictMismatches).toEqual([]);
  });

  it('accepts a claimed pass on a window that meets every bar (negative control)', async () => {
    const instrumentSnapshots = await resolveScorecardInstrumentSnapshots(
      { rubric, subject },
      { now, holderMetrics: async () => healthy() },
    );
    for (const key of Object.values(HOLDER_BEHAVIOR_INSTRUMENT_KEYS)) {
      expect(instrumentSnapshots?.[key].verdict).toBe('pass');
    }
    const out = evaluateScorecardInstrumentContract({ rubric, ratings: claim('pass'), instrumentSnapshots, nowMs: now() });
    expect(out.verdictMismatches).toEqual([]);
    expect(out.valid).toBe(true);
  });

  it('overwrites a forged platform-computed pass with the measurement', async () => {
    const supplied = Object.fromEntries(
      Object.values(HOLDER_BEHAVIOR_INSTRUMENT_KEYS).map((key) => [
        key,
        { verdict: 'pass' as const, measuredAt: subject.windowEnd, provenance: 'platform-computed' as const },
      ]),
    );
    const snapshots = await resolveScorecardInstrumentSnapshots(
      { rubric, subject, supplied },
      { now, holderMetrics: async () => witnessed() },
    );
    for (const key of Object.values(HOLDER_BEHAVIOR_INSTRUMENT_KEYS)) {
      expect(snapshots?.[key]).toMatchObject({ verdict: 'fail', provenance: 'platform-computed' });
    }
  });

  it('accepts inherited uncertainty but refuses false passes and unknown claims over due-negative evidence (D-008)', async () => {
    const metrics = healthy();
    metrics.ideation = {
      ...metrics.ideation, plansNew: 0, ideasFiled: 0, reviews: 0,
      holderAttribution: { status: 'inherited', holderSince: subject.windowStart!, exercisedReviews: 0 },
    };
    const measure = () => resolveScorecardInstrumentSnapshots({ rubric, subject }, { now, holderMetrics: async () => metrics });
    const key = HOLDER_BEHAVIOR_INSTRUMENT_KEYS['ideation-yield'];
    const ratings = claim('pass');
    ratings['ideation-yield'] = { ...ratings['ideation-yield']!, rating: 'unknown' };
    const inherited = await measure();
    expect(inherited?.[key]).toMatchObject({ verdict: 'unknown', value: { unknownReason: 'scope-mismatch' } });
    expect(evaluateScorecardInstrumentContract({ rubric, ratings, instrumentSnapshots: inherited, nowMs: now() }).valid).toBe(true);
    expect(evaluateScorecardInstrumentContract({ rubric, ratings: claim('pass'), instrumentSnapshots: inherited, nowMs: now() }).verdictMismatches).toEqual([key]);
    metrics.ideation.holderAttribution = { status: 'full-goal-day', holderSince: metrics.ideation.since, exercisedReviews: 0 };
    const due = await measure();
    expect(due?.[key].verdict).toBe('fail');
    expect(evaluateScorecardInstrumentContract({ rubric, ratings, instrumentSnapshots: due, nowMs: now() }).verdictMismatches).toEqual([key]);
    metrics.ideation.ideasFiled = 1;
    const positive = await measure();
    expect(evaluateScorecardInstrumentContract({ rubric, ratings: claim('pass'), instrumentSnapshots: positive, nowMs: now() }).valid).toBe(true);
  });

  it('reads unknown, never fail, when the holder stewarded no goal or the ledgers are unreadable', async () => {
    const none = await resolveScorecardInstrumentSnapshots({ rubric, subject }, { now, holderMetrics: async () => null });
    const broken = await resolveScorecardInstrumentSnapshots(
      { rubric, subject },
      { now, holderMetrics: async () => { throw new Error('ledger unavailable'); } },
    );
    for (const key of Object.values(HOLDER_BEHAVIOR_INSTRUMENT_KEYS)) {
      expect(none?.[key]).toMatchObject({ verdict: 'unknown', value: { reason: expect.stringContaining('No goal stewarded') } });
      expect(broken?.[key]).toMatchObject({ verdict: 'unknown', value: { reason: expect.stringContaining('ledger unavailable') } });
    }
    // An unknown measurement cannot carry a claimed pass.
    const out = evaluateScorecardInstrumentContract({ rubric, ratings: claim('pass'), instrumentSnapshots: none, nowMs: now() });
    expect(out.verdictMismatches).toHaveLength(HOLDER_BEHAVIOR_CRITERIA.length);
  });

  it('does not read the holder ledgers for a rubric with no holder-behavior criteria', async () => {
    const holderMetrics = vi.fn(async () => witnessed());
    await resolveScorecardInstrumentSnapshots(
      { rubric: { ...rubric, criteria: [] } as Rubric, subject },
      { now, holderMetrics },
    );
    expect(holderMetrics).not.toHaveBeenCalled();
  });
});
