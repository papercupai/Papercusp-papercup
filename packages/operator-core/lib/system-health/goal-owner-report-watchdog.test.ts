import { describe, expect, it, vi } from 'vitest';

import type { Sql } from 'postgres';

import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import {
  GOAL_OWNER_REPORT_FIELD,
  GOAL_OWNER_REPORT_HEADING_LIST,
  GOAL_OWNER_REPORT_LEGACY_SQL_PATTERNS,
  GOAL_OWNER_REPORT_SCHEMA_VERSION,
} from '../goal-owner-report';
import {
  GOAL_OWNER_REPORT_MAX_SILENCE_MS,
  GOAL_OWNER_REPORT_MEASURED_FAILURE_SILENCE_MS,
  GOAL_OWNER_REPORT_MEASURED_HEALTHY_CADENCE_MS,
  GOAL_OWNER_REPORT_REVIEW_BY,
  GOAL_OWNER_REPORT_STANDING_MAX_SILENCE_MS,
  GOAL_OWNER_REPORT_STANDING_MEASURED_FAILURE_SILENCE_MS,
  GOAL_OWNER_REPORT_STANDING_MEASURED_HEALTHY_CADENCE_MS,
  GOAL_OWNER_REPORT_DUE_SOON_MARGIN_MS,
  buildReportSkeleton,
  describeGoalOwnerReportObligation,
  findOverdueReports,
  isPastReportFloorReview,
  readGoalOwnerReportObligation,
  runGoalOwnerReportSweepOnce,
  goalOwnerReportConditionKey,
  type GoalOwnerReportAlert,
  type GoalOwnerReportRowLike,
  type GoalOwnerReportSweepDeps,
} from './goal-owner-report-watchdog';

const NOW = 1_800_000_000_000;
const FLOOR = GOAL_OWNER_REPORT_MAX_SILENCE_MS;
const STANDING_FLOOR = GOAL_OWNER_REPORT_STANDING_MAX_SILENCE_MS;
const HOUR = 3600_000;

const defaultRails = vi.hoisted(() => ({
  openEscalation: vi.fn(),
  wakeRecipients: vi.fn(),
}));
vi.mock('../agent-tools/coordination/escalations', () => ({
  openEscalation: defaultRails.openEscalation,
}));
vi.mock('../agent-tools/coordination/inbox-wake', () => ({
  wakeRecipients: defaultRails.wakeRecipients,
}));

function makeRow(over: Partial<GoalOwnerReportRowLike> = {}): GoalOwnerReportRowLike {
  return {
    workspaceId: 'ws',
    goalId: 'g-1',
    agentId: 'su-goal-owner',
    baselineTsMs: NOW - 24 * HOUR,
    lastReportTsMs: null,
    standing: false,
    ...over,
  };
}

// The default deps hit PG/flags/the liveness oracle — every sweep test injects the full surface.
const sqlNever = ((..._args: unknown[]) => {
  throw new Error('sql must not be called when all deps are injected');
}) as unknown as Sql;

function liveVerdict(ownerId: string): LivenessVerdict {
  return {
    ownerId,
    sessionState: 'live',
    wakeable: true,
    liveTurn: false,
    confirmLiveness: null,
    heartbeatFresh: true,
  };
}

function deadVerdict(ownerId: string): LivenessVerdict {
  return {
    ownerId,
    sessionState: 'ended',
    wakeable: false,
    liveTurn: false,
    confirmLiveness: null,
    heartbeatFresh: false,
  };
}

function makeDeps(over: Partial<GoalOwnerReportSweepDeps> = {}): GoalOwnerReportSweepDeps {
  return {
    readGoalModeOwners: vi.fn(async () => [] as GoalOwnerReportRowLike[]),
    resolveLiveness: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, liveVerdict(id)]))),
    escalate: vi.fn(async () => ({ coalesced: false })),
    nudge: vi.fn(async () => {}),
    flagEnabled: vi.fn(async () => true),
    now: () => Date.now(),
    readOpenConditionKeys: vi.fn(async () => []),
    readReport: vi.fn(async () => []),
    rail: { broadcast: vi.fn(async () => true), resolve: vi.fn(async () => true) },
    ...over,
  };
}

describe('describeGoalOwnerReportObligation (pure, WI-2140700) — the holder-side verdict agrees with the sweep', () => {
  const MIN = 60_000;

  it('a standing goal silent past the 60-min floor reads overdue, with the same reference the sweep uses', () => {
    const row = makeRow({ standing: true, baselineTsMs: NOW - 5 * HOUR, lastReportTsMs: NOW - 90 * MIN });
    const v = describeGoalOwnerReportObligation(row, NOW);
    expect(v.obligation).toBe('overdue');
    expect(v.floorMin).toBe(60);
    expect(v.ageMin).toBe(90);
    expect(v.dueInMin).toBe(-30);
    expect(v.dueAt).toBe(new Date(NOW - 30 * MIN).toISOString());
    expect(v.lastReportAt).toBe(new Date(NOW - 90 * MIN).toISOString());
    expect(v.instruction).toMatch(/^OVERDUE by 30 min/);
    expect(v.instruction).toContain("coord:send { to:['human'] }");
    expect(v.instruction).toContain(GOAL_OWNER_REPORT_HEADING_LIST);
    // Agreement with the sweep: the sweep would nudge exactly this row.
    expect(findOverdueReports([row], NOW)).toHaveLength(1);
  });

  it('inside the last 5 minutes before the floor reads due-now (the contract\'s 55-minute mark)', () => {
    const row = makeRow({ standing: true, baselineTsMs: NOW - 5 * HOUR, lastReportTsMs: NOW - 56 * MIN });
    const v = describeGoalOwnerReportObligation(row, NOW);
    expect(v.obligation).toBe('due-now');
    expect(v.dueInMin).toBe(4);
    expect(v.dueAt).toBe(new Date(NOW + 4 * MIN).toISOString());
    expect(v.instruction).toMatch(/^DUE NOW \(4 min to the 60-min floor\)/);
    expect(v.instruction).toContain(GOAL_OWNER_REPORT_HEADING_LIST);
    // Not yet overdue for the sweep — the holder is told first, the human second.
    expect(findOverdueReports([row], NOW)).toHaveLength(0);
    expect(GOAL_OWNER_REPORT_DUE_SOON_MARGIN_MS).toBe(5 * MIN);
  });

  it('a fresh report reads not-due and names the remaining minutes', () => {
    const row = makeRow({ standing: true, baselineTsMs: NOW - 5 * HOUR, lastReportTsMs: NOW - 10 * MIN });
    const v = describeGoalOwnerReportObligation(row, NOW);
    expect(v.obligation).toBe('not-due');
    expect(v.dueInMin).toBe(50);
    expect(v.dueAt).toBe(new Date(NOW + 50 * MIN).toISOString());
    expect(v.instruction).toMatch(/^not due: 50 min until the 60-min floor/);
  });

  it('an outcome goal is judged against the 4-hour floor', () => {
    const row = makeRow({ standing: false, baselineTsMs: NOW - 10 * HOUR, lastReportTsMs: NOW - 90 * MIN });
    const v = describeGoalOwnerReportObligation(row, NOW);
    expect(v.standing).toBe(false);
    expect(v.floorMin).toBe(240);
    expect(v.obligation).toBe('not-due');
    expect(v.dueInMin).toBe(150);
  });

  it('no report since the baseline: lastReportAt is null and age is measured from the baseline', () => {
    const fresh = makeRow({ standing: true, baselineTsMs: NOW - 20 * MIN, lastReportTsMs: null });
    const v = describeGoalOwnerReportObligation(fresh, NOW);
    expect(v.lastReportAt).toBeNull();
    expect(v.ageMin).toBe(20);
    expect(v.obligation).toBe('not-due');
    expect(v.instruction).toContain('none yet');
    // A report that PREDATES the baseline is ignored exactly as the sweep ignores it.
    const stale = makeRow({ standing: true, baselineTsMs: NOW - 20 * MIN, lastReportTsMs: NOW - 3 * HOUR });
    const w = describeGoalOwnerReportObligation(stale, NOW);
    expect(w.lastReportAt).toBeNull();
    expect(w.ageMin).toBe(20);
  });

  it('readGoalOwnerReportObligation projects the single row the filtered population query returns, null when absent', async () => {
    const calls: unknown[][] = [];
    const sqlFn = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      // The filter fragment is itself a sql`` call; only the outer query returns rows.
      if (strings.join('').includes('FROM harness_shared.agent_modes')) {
        return values.length && calls.length > 1
          ? [
              {
                workspace_id: 'ws',
                goal_id: 'goal-1',
                owner_id: 'su-holder',
                standing: true,
                baseline_ts_ms: String(NOW - 5 * HOUR),
                last_report_ts_ms: String(NOW - 90 * MIN),
              },
            ]
          : [];
      }
      return { fragment: values };
    }) as unknown as Sql;
    const v = await readGoalOwnerReportObligation(sqlFn, { workspaceId: 'ws', ownerId: 'su-holder', goalId: 'goal-1' }, NOW);
    expect(v?.obligation).toBe('overdue');
    expect(v?.ageMin).toBe(90);
    // The filter values reached the query (fragment call carries them in order).
    expect(calls[0]).toEqual(['ws', 'su-holder', 'goal-1']);

    const none = (async () => []) as unknown as Sql;
    await expect(
      readGoalOwnerReportObligation(none, { workspaceId: 'ws', ownerId: 'su-holder', goalId: 'goal-1' }, NOW),
    ).resolves.toBeNull();
  });

  it('the SQL-backed union requires complete report evidence on every rail, never a bare human ping', async () => {
    const queryTexts: string[] = [];
    const queryValues: unknown[] = [];
    const sqlFn = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queryTexts.push(strings.join(' '));
      queryValues.push(...values);
      // Inner sql`` filter fragment.
      if (!strings.join('').includes('FROM harness_shared.agent_modes')) return { fragment: values };
      return [];
    }) as unknown as Sql;

    await readGoalOwnerReportObligation(sqlFn, { workspaceId: 'ws', ownerId: 'su-holder', goalId: 'goal-1' }, NOW);

    const query = queryTexts.find((text) => text.includes('FROM harness_shared.agent_modes')) ?? '';
    expect(query).toContain('NULLIF(BTRIM(e.body ->');
    expect(query).toContain("->> 'moved'), '') IS NOT NULL");
    expect(query).toContain("->> 'cost'), '') IS NOT NULL");
    expect(query).toContain("->> 'ownerWalled'), '') IS NOT NULL");
    expect(query).toContain("->> 'killed'), '') IS NOT NULL");
    expect(query).toContain("a.data->>'ownerId' = m.owner_id");
    expect(query).not.toContain("a.data->>'goalId' = m.subject OR");
    expect(queryValues).toContain(GOAL_OWNER_REPORT_FIELD);
    expect(queryValues).toContain(GOAL_OWNER_REPORT_SCHEMA_VERSION);
    for (const pattern of Object.values(GOAL_OWNER_REPORT_LEGACY_SQL_PATTERNS)) {
      expect(queryValues).toContain(pattern);
    }
  });
});

describe('findOverdueReports (pure)', () => {
  it('a long-silent owner with no report ever is overdue, measured from the baseline', () => {
    const alerts = findOverdueReports([makeRow()], NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      workspaceId: 'ws',
      goalId: 'g-1',
      agentId: 'su-goal-owner',
      referenceTsMs: NOW - 24 * HOUR,
      silentMs: 24 * HOUR,
    });
  });

  it('a fresh report clears the condition', () => {
    const alerts = findOverdueReports([makeRow({ lastReportTsMs: NOW - HOUR })], NOW);
    expect(alerts).toHaveLength(0);
  });

  it('grace: a freshly-taken goal with no report is NOT overdue until the floor elapses from baseline', () => {
    const alerts = findOverdueReports([makeRow({ baselineTsMs: NOW - HOUR })], NOW);
    expect(alerts).toHaveLength(0);
  });

  it('a report that PREDATES the baseline is ignored — the reference is the baseline', () => {
    // Owner escalated about something else last week, then took this goal 1h ago:
    // that stale report must not start the clock early, and the fresh baseline
    // must not be overridden by it either.
    const fresh = findOverdueReports(
      [makeRow({ baselineTsMs: NOW - HOUR, lastReportTsMs: NOW - 7 * 24 * HOUR })],
      NOW,
    );
    expect(fresh).toHaveLength(0);
    // Same stale report, old baseline: overdue, and measured from the baseline.
    const stale = findOverdueReports(
      [makeRow({ baselineTsMs: NOW - 24 * HOUR, lastReportTsMs: NOW - 7 * 24 * HOUR })],
      NOW,
    );
    expect(stale).toHaveLength(1);
    expect(stale[0].referenceTsMs).toBe(NOW - 24 * HOUR);
  });

  it('the floor is a strict bound: exactly-at-floor silence is not overdue, 1ms past is', () => {
    expect(
      findOverdueReports([makeRow({ baselineTsMs: NOW - FLOOR, lastReportTsMs: null })], NOW),
    ).toHaveLength(0);
    expect(
      findOverdueReports([makeRow({ baselineTsMs: NOW - FLOOR - 1, lastReportTsMs: null })], NOW),
    ).toHaveLength(1);
  });
});

describe('findOverdueReports — falsifiability controls (the fixtures can tell a broken predicate apart)', () => {
  // Deliberately-wrong implementations kept permanently as controls (mutation-probe
  // module tier): each must DISAGREE with the real predicate on the case built to
  // catch it, and AGREE on the calibration case — proving the fixtures distinguish
  // a broken implementation rather than passing anything shaped like a function.
  function brokenIgnoresReports(
    rows: readonly GoalOwnerReportRowLike[],
    nowMs: number,
  ): GoalOwnerReportAlert[] {
    // Defect: measures silence from the baseline alone — a compliant reporter
    // still gets nagged forever.
    return rows
      .filter((r) => nowMs - r.baselineTsMs > FLOOR)
      .map((r) => ({
        workspaceId: r.workspaceId,
        goalId: r.goalId,
        agentId: r.agentId,
        referenceTsMs: r.baselineTsMs,
        silentMs: nowMs - r.baselineTsMs,
        floorMs: FLOOR,
        standing: r.standing,
      }));
  }

  function brokenMinReference(
    rows: readonly GoalOwnerReportRowLike[],
    nowMs: number,
  ): GoalOwnerReportAlert[] {
    // Defect: min instead of max — a stale pre-baseline report starts the clock
    // early, nuking the grace window for freshly-taken goals.
    return rows
      .filter((r) => nowMs - Math.min(r.baselineTsMs, r.lastReportTsMs ?? r.baselineTsMs) > FLOOR)
      .map((r) => ({
        workspaceId: r.workspaceId,
        goalId: r.goalId,
        agentId: r.agentId,
        referenceTsMs: Math.min(r.baselineTsMs, r.lastReportTsMs ?? r.baselineTsMs),
        silentMs: nowMs - Math.min(r.baselineTsMs, r.lastReportTsMs ?? r.baselineTsMs),
        floorMs: FLOOR,
        standing: r.standing,
      }));
  }

  const freshReportRow = makeRow({ lastReportTsMs: NOW - HOUR });
  const staleReportFreshGoalRow = makeRow({
    baselineTsMs: NOW - HOUR,
    lastReportTsMs: NOW - 7 * 24 * HOUR,
  });
  const calibrationRow = makeRow(); // 24h silent, no report — everyone must alert

  it('control 1 (ignores reports) is CAUGHT by the fresh-report fixture', () => {
    expect(findOverdueReports([freshReportRow], NOW)).toHaveLength(0);
    expect(brokenIgnoresReports([freshReportRow], NOW)).toHaveLength(1);
  });

  it('control 2 (min reference) is CAUGHT by the stale-report-fresh-goal fixture', () => {
    expect(findOverdueReports([staleReportFreshGoalRow], NOW)).toHaveLength(0);
    expect(brokenMinReference([staleReportFreshGoalRow], NOW)).toHaveLength(1);
  });

  it('calibration: both controls AND the real predicate alert on plain long silence', () => {
    expect(findOverdueReports([calibrationRow], NOW)).toHaveLength(1);
    expect(brokenIgnoresReports([calibrationRow], NOW)).toHaveLength(1);
    expect(brokenMinReference([calibrationRow], NOW)).toHaveLength(1);
  });
});

describe('the cadence floor (D-016: a floor with no consequence is a comment)', () => {
  it('sits strictly ABOVE the measured healthy cadence — a compliant owner is never nagged', () => {
    expect(GOAL_OWNER_REPORT_MAX_SILENCE_MS).toBeGreaterThan(
      GOAL_OWNER_REPORT_MEASURED_HEALTHY_CADENCE_MS,
    );
  });

  it('sits AT-OR-BELOW the measured failure silence — the observed failure would have been caught', () => {
    expect(GOAL_OWNER_REPORT_MAX_SILENCE_MS).toBeLessThanOrEqual(
      GOAL_OWNER_REPORT_MEASURED_FAILURE_SILENCE_MS,
    );
    // And the measured failure itself trips the predicate:
    const failureRow = makeRow({
      baselineTsMs: NOW - GOAL_OWNER_REPORT_MEASURED_FAILURE_SILENCE_MS,
      lastReportTsMs: null,
    });
    expect(findOverdueReports([failureRow], NOW)).toHaveLength(1);
  });

  it('the review date has consequence: this test FAILS once it passes', () => {
    // If you are reading this because it went red: the floors' review date has
    // arrived. Re-litigate BOTH numbers (4h outcome, 1h standing) against
    // current evidence (rubric trends, scorecard cadence, real goal-mode runs),
    // update the WHY on GOAL_OWNER_REPORT_MAX_SILENCE_MS /
    // GOAL_OWNER_REPORT_STANDING_MAX_SILENCE_MS, and bump
    // GOAL_OWNER_REPORT_REVIEW_BY. Deleting or skipping this test instead is
    // the exact decay D-016 names. (Last re-litigated 2026-09-01, WI-2091959.)
    expect(isPastReportFloorReview(GOAL_OWNER_REPORT_REVIEW_BY, new Date())).toBe(false);
  });

  it('isPastReportFloorReview is itself falsifiable: past ⇒ true, future ⇒ false, garbage ⇒ true', () => {
    const now = new Date('2026-08-17T00:00:00Z');
    expect(isPastReportFloorReview('2026-08-01', now)).toBe(true);
    expect(isPastReportFloorReview('2026-09-01', now)).toBe(false);
    expect(isPastReportFloorReview('not-a-date', now)).toBe(true);
  });
});

describe('the STANDING-goal cadence floor (WI-2091959: two graded FAILs sat BELOW the 4h floor by design)', () => {
  it('a standing goal is judged against the standing floor: overdue where an outcome goal is not', () => {
    const silentMs = STANDING_FLOOR + 1;
    expect(
      findOverdueReports([makeRow({ standing: true, baselineTsMs: NOW - silentMs })], NOW),
    ).toHaveLength(1);
    expect(findOverdueReports([makeRow({ baselineTsMs: NOW - silentMs })], NOW)).toHaveLength(0);
  });

  it('the standing floor is a strict bound too: exactly-at-floor silence is not overdue', () => {
    expect(
      findOverdueReports([makeRow({ standing: true, baselineTsMs: NOW - STANDING_FLOOR })], NOW),
    ).toHaveLength(0);
  });

  it('the alert carries the floor it was judged against — the escalation text states the applied bound', () => {
    const standing = findOverdueReports(
      [makeRow({ standing: true, baselineTsMs: NOW - 2 * HOUR })],
      NOW,
    );
    expect(standing[0]).toMatchObject({ floorMs: STANDING_FLOOR, standing: true });
    const outcome = findOverdueReports([makeRow({ baselineTsMs: NOW - 24 * HOUR })], NOW);
    expect(outcome[0]).toMatchObject({ floorMs: FLOOR, standing: false });
  });

  it('sits strictly ABOVE the measured healthy steward cadence — a compliant steward is never nagged', () => {
    expect(STANDING_FLOOR).toBeGreaterThan(GOAL_OWNER_REPORT_STANDING_MEASURED_HEALTHY_CADENCE_MS);
  });

  it('sits AT-OR-BELOW the SMALLER measured failure silence — both graded breaches would have been caught', () => {
    expect(STANDING_FLOOR).toBeLessThanOrEqual(
      GOAL_OWNER_REPORT_STANDING_MEASURED_FAILURE_SILENCE_MS,
    );
    // Both graded FAIL silences trip the predicate (1h07m and 2h14m, per the
    // WI-2094390 audit erratum's corrected numbers):
    for (const silentMs of [GOAL_OWNER_REPORT_STANDING_MEASURED_FAILURE_SILENCE_MS, 134 * 60_000]) {
      expect(
        findOverdueReports([makeRow({ standing: true, baselineTsMs: NOW - silentMs })], NOW),
      ).toHaveLength(1);
    }
  });

  it('sits strictly BELOW the outcome floor — the split is real, not a rename', () => {
    expect(STANDING_FLOOR).toBeLessThan(FLOOR);
  });

  it('the graded false-negative is closed: the 2h14m silence the 4h floor missed now alerts', () => {
    // The exact miss that drove the re-litigation: 2h14m < 4h, so the old
    // single-floor predicate stayed quiet on a standing goal. The same row
    // judged per-kind alerts — and with only the flag flipped it stays quiet,
    // which doubles as the falsifiability control on the split itself.
    const row = makeRow({ standing: true, baselineTsMs: NOW - 134 * 60_000 });
    expect(findOverdueReports([row], NOW)).toHaveLength(1);
    expect(findOverdueReports([{ ...row, standing: false }], NOW)).toHaveLength(0);
  });
});

describe('buildReportSkeleton', () => {
  it("carries every GOAL WRITE report field and points at the sanctioned rail", () => {
    const skeleton = buildReportSkeleton({
      workspaceId: 'ws',
      goalId: 'g-1',
      agentId: 'su-goal-owner',
      referenceTsMs: NOW - 5 * HOUR,
      silentMs: 5 * HOUR,
      floorMs: FLOOR,
      standing: false,
    });
    expect(Object.keys(skeleton)).toEqual([
      'channel',
      'whatMoved',
      'whatItCost',
      'ownerWalled',
      'whatYouKilled',
      'nextWake',
    ]);
    expect(skeleton.channel).toContain('coord:escalate');
    expect(skeleton.whatMoved).toContain('g-1');
    expect(skeleton.nextWake).toMatch(/trigger|event|cadence/i);
    expect(skeleton.nextWake).toMatch(/time/i);
  });
});

describe('original owner-report condition lifecycle', () => {
  const row = makeRow();
  const key = goalOwnerReportConditionKey(row);
  const recovered = { ...row, lastReportTsMs: NOW - HOUR };
  function deps(over: Partial<GoalOwnerReportSweepDeps> = {}) {
    return makeDeps({ now: () => NOW, readGoalModeOwners: async () => [row], ...over });
  }

  it('opens before legacy coalescing and resolves a fresh exact report after restart and candidate absence', async () => {
    const order: string[] = [];
    const first = deps({
      rail: { broadcast: vi.fn(async event => { order.push('rail'); expect(event).toMatchObject({ conditionKey: key, oneShot: true }); return true; }) },
      escalate: vi.fn(async () => { order.push('legacy'); return { coalesced: true }; }),
    });
    await runGoalOwnerReportSweepOnce(sqlNever, first);
    expect(order).toEqual(['rail', 'legacy']);
    expect(first.nudge).not.toHaveBeenCalled();
    const restart = deps({ readGoalModeOwners: async () => [], readOpenConditionKeys: async () => [key],
      readReport: vi.fn(async () => [recovered]), resolveLiveness: vi.fn(async () => new Map()) });
    await runGoalOwnerReportSweepOnce(sqlNever, restart);
    expect(restart.readReport).toHaveBeenCalledWith({ workspaceId: row.workspaceId, goalId: row.goalId, ownerId: row.agentId });
    expect(restart.rail!.resolve).toHaveBeenCalledWith({ conditionKey: key, summary: 'goal-owner-report-watchdog recovered' });
    expect(restart.resolveLiveness).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', []], ['ambiguous', [recovered, recovered]],
    ['foreign workspace', [{ ...recovered, workspaceId: 'other' }]],
    ['foreign goal', [{ ...recovered, goalId: 'other' }]],
    ['foreign owner', [{ ...recovered, agentId: 'other' }]],
    ['no report and new baseline', [{ ...row, baselineTsMs: NOW - HOUR }]],
    ['predates registration', [{ ...recovered, baselineTsMs: NOW - 30 * 60_000 }]],
    ['overdue report', [{ ...row, lastReportTsMs: NOW - 5 * HOUR }]],
    ['standing report beyond tight floor', [{ ...row, standing: true, lastReportTsMs: NOW - 2 * HOUR }]],
    ['future report', [{ ...row, lastReportTsMs: NOW + 1 }]],
    ['future baseline', [{ ...recovered, baselineTsMs: NOW + 1 }]],
    ['invalid baseline', [{ ...recovered, baselineTsMs: Number.NaN }]],
    ['invalid report', [{ ...row, lastReportTsMs: Number.NaN }]],
    ['unmeasured standing', [{ ...recovered, standing: undefined }]],
  ])('preserves the durable episode for %s', async (_label, rows) => {
    const d = deps({ readGoalModeOwners: async () => [], readOpenConditionKeys: async () => [key],
      readReport: async () => rows as GoalOwnerReportRowLike[] });
    await runGoalOwnerReportSweepOnce(sqlNever, d);
    expect(d.rail!.resolve).not.toHaveBeenCalled();
  });

  it.each([false, true])('clears only a measured report at the exact floor (standing=%s)', async standing => {
    const floor = standing ? STANDING_FLOOR : FLOOR;
    const d = deps({ readGoalModeOwners: async () => [], readOpenConditionKeys: async () => [key],
      readReport: async () => [{ ...row, standing, lastReportTsMs: NOW - floor }] });
    await runGoalOwnerReportSweepOnce(sqlNever, d);
    expect(d.rail!.resolve).toHaveBeenCalledTimes(1);
  });

  it('preserves failed exact reads, malformed keys and invalid clocks without suppressing other subjects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const other = { ...row, goalId: 'g-2' }, otherKey = goalOwnerReportConditionKey(other);
      const d = deps({ readOpenConditionKeys: async () => [key, otherKey, 'alarm:goal-owner-report:bad',
        'alarm:goal-owner-report:%5B%22ws%22%2C%22g-1%22%5D', 'unrelated'],
        readReport: vi.fn(async identity => { if (identity.goalId === row.goalId) throw new Error('unreadable'); return [{ ...other, lastReportTsMs: NOW }]; }) });
      await runGoalOwnerReportSweepOnce(sqlNever, d);
      expect(d.readReport).toHaveBeenCalledTimes(2);
      expect(d.rail!.resolve).toHaveBeenCalledTimes(1);
      expect(d.rail!.resolve).toHaveBeenCalledWith({ conditionKey: otherKey, summary: 'goal-owner-report-watchdog recovered' });
      await runGoalOwnerReportSweepOnce(sqlNever, { ...d, now: () => Number.NaN });
      expect(d.rail!.resolve).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });

  it('keeps legacy delivery independent of a failed rail and rail delivery independent of failed legacy delivery', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = deps({ rail: { broadcast: vi.fn(async () => { throw new Error('rail unavailable'); }) } });
      await runGoalOwnerReportSweepOnce(sqlNever, first);
      expect(first.nudge).toHaveBeenCalledTimes(1);
      const second = deps({ escalate: vi.fn(async () => { throw new Error('legacy unavailable'); }) });
      await runGoalOwnerReportSweepOnce(sqlNever, second);
      expect(second.rail!.broadcast).toHaveBeenCalledTimes(1);
      expect(second.nudge).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('preserves episodes on disabled ticks and failed condition discovery', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const off = deps({ flagEnabled: async () => false, readOpenConditionKeys: vi.fn(async () => [key]) });
      await runGoalOwnerReportSweepOnce(sqlNever, off);
      expect(off.readOpenConditionKeys).not.toHaveBeenCalled();
      const unknown = deps({ readOpenConditionKeys: async () => { throw new Error('unreadable ledger'); } });
      await runGoalOwnerReportSweepOnce(sqlNever, unknown);
      expect(unknown.rail!.resolve).not.toHaveBeenCalled();
      expect(unknown.rail!.broadcast).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });

  it.each([
    { ...row, baselineTsMs: Number.NaN }, { ...row, lastReportTsMs: NOW + 1 },
    { ...row, standing: undefined }, { ...row, workspaceId: '' },
  ])('does not open from an invalid candidate %#', async invalid => {
    const d = deps({ readGoalModeOwners: async () => [invalid as GoalOwnerReportRowLike] });
    await runGoalOwnerReportSweepOnce(sqlNever, d);
    expect(d.rail!.broadcast).not.toHaveBeenCalled();
  });

  it('does not open from ambiguous candidate registrations', async () => {
    const d = deps({ readGoalModeOwners: async () => [row, row] });
    await runGoalOwnerReportSweepOnce(sqlNever, d);
    expect(d.rail!.broadcast).not.toHaveBeenCalled();
  });

  it.each([true, false, '', ' ', 'Infinity', 'NaN', undefined, null])('refuses malformed raw PG timestamp %s for recovery', async invalid => {
    for (const field of ['baseline_ts_ms', 'last_report_ts_ms'] as const) {
      const raw = { workspace_id: row.workspaceId, goal_id: row.goalId, owner_id: row.agentId,
        standing: false, baseline_ts_ms: String(row.baselineTsMs), last_report_ts_ms: String(NOW), [field]: invalid };
      const sql = (async (strings: TemplateStringsArray) => strings.join('').includes('FROM harness_shared.agent_modes')
        ? [raw] : []) as unknown as Sql;
      const { readReport: _injectedReader, ...productionReader } = deps({ readGoalModeOwners: async () => [],
        readOpenConditionKeys: async () => [key] });
      await runGoalOwnerReportSweepOnce(sql, productionReader);
      expect(productionReader.rail!.resolve).not.toHaveBeenCalled();
    }
  });
});

describe('runGoalOwnerReportSweepOnce', () => {
  // The sweep measures against REAL Date.now() (it takes no clock), so sweep
  // fixtures anchor there — the fixed NOW constant above is for the pure tests,
  // and a row anchored to it would sit in the future and never be overdue.
  const overdueRow = makeRow({ baselineTsMs: Date.now() - 24 * HOUR }); // 24h silent — overdue by construction

  it('default escalation and directed nudge require the complete canonical WRITE headings', async () => {
    defaultRails.openEscalation.mockReset().mockResolvedValue({ coalesced: false });
    defaultRails.wakeRecipients.mockReset().mockResolvedValue(undefined);
    const { readGoalModeOwners, resolveLiveness, flagEnabled, readOpenConditionKeys, rail } = makeDeps({
      readGoalModeOwners: vi.fn(async () => [overdueRow]),
    });
    // Exercise the real producers; only their outbound transport seams are mocked.
    const result = await runGoalOwnerReportSweepOnce(sqlNever, {
      readGoalModeOwners, resolveLiveness, flagEnabled, readOpenConditionKeys, rail,
    });
    expect(result.nudged).toBe(1);
    expect(defaultRails.openEscalation).toHaveBeenCalledTimes(1);
    expect(defaultRails.wakeRecipients).toHaveBeenCalledTimes(1);
    const escalation = defaultRails.openEscalation.mock.calls[0][1] as { body: string };
    const nudge = defaultRails.wakeRecipients.mock.calls[0][1] as {
      summary: string;
      payload: { reportSkeleton: Record<string, string> };
    };
    expect(escalation.body).toContain(GOAL_OWNER_REPORT_HEADING_LIST);
    expect(nudge.summary).toContain(GOAL_OWNER_REPORT_HEADING_LIST);
    expect(defaultRails.wakeRecipients.mock.calls[0][0]).toEqual([overdueRow.agentId]);
    expect(nudge.payload.reportSkeleton.nextWake).toMatch(/trigger|event|cadence/i);
  });

  it('flag off ⇒ skipped, and nothing is read', async () => {
    const deps = makeDeps({ flagEnabled: vi.fn(async () => false) });
    const r = await runGoalOwnerReportSweepOnce(sqlNever, deps);
    expect(r).toEqual({ scanned: 0, overdue: 0, nudged: 0, skipped: true });
    expect(deps.readGoalModeOwners).not.toHaveBeenCalled();
  });

  it('nothing overdue ⇒ no liveness read, no escalation, no nudge', async () => {
    const deps = makeDeps({
      readGoalModeOwners: vi.fn(async () => [makeRow({ lastReportTsMs: NOW - HOUR, baselineTsMs: Date.now() - HOUR })]),
    });
    const r = await runGoalOwnerReportSweepOnce(sqlNever, deps);
    expect(r.overdue).toBe(0);
    expect(deps.resolveLiveness).not.toHaveBeenCalled();
    expect(deps.escalate).not.toHaveBeenCalled();
    expect(deps.nudge).not.toHaveBeenCalled();
  });

  it('overdue + alive + newly-opened escalation ⇒ exactly one nudge, to that owner', async () => {
    const deps = makeDeps({
      readGoalModeOwners: vi.fn(async () => [overdueRow]),
    });
    const r = await runGoalOwnerReportSweepOnce(sqlNever, deps);
    expect(r.overdue).toBe(1);
    expect(r.nudged).toBe(1);
    expect(deps.escalate).toHaveBeenCalledTimes(1);
    expect(deps.nudge).toHaveBeenCalledTimes(1);
    const alert = (deps.nudge as ReturnType<typeof vi.fn>).mock.calls[0][0] as GoalOwnerReportAlert;
    expect(alert.agentId).toBe('su-goal-owner');
    expect(alert.goalId).toBe('g-1');
  });

  it('ONE nudge per silence: a coalesced escalation suppresses the wake', async () => {
    const deps = makeDeps({
      readGoalModeOwners: vi.fn(async () => [overdueRow]),
      escalate: vi.fn(async () => ({ coalesced: true })),
    });
    const r = await runGoalOwnerReportSweepOnce(sqlNever, deps);
    expect(r.overdue).toBe(1);
    expect(r.nudged).toBe(0);
    expect(deps.nudge).not.toHaveBeenCalled();
  });

  it('a dead owner is suppressed — the liveness watchdog owns that lane', async () => {
    const deps = makeDeps({
      readGoalModeOwners: vi.fn(async () => [overdueRow]),
      resolveLiveness: vi.fn(async () => new Map([['su-goal-owner', deadVerdict('su-goal-owner')]])),
    });
    const r = await runGoalOwnerReportSweepOnce(sqlNever, deps);
    expect(r.overdue).toBe(0);
    expect(deps.escalate).not.toHaveBeenCalled();
    expect(deps.nudge).not.toHaveBeenCalled();
  });

  it('a MISSING liveness verdict is UNKNOWN, not alive — suppressed (the conservative rule)', async () => {
    const deps = makeDeps({
      readGoalModeOwners: vi.fn(async () => [overdueRow]),
      resolveLiveness: vi.fn(async () => new Map<string, LivenessVerdict>()),
    });
    const r = await runGoalOwnerReportSweepOnce(sqlNever, deps);
    expect(r.overdue).toBe(0);
    expect(deps.escalate).not.toHaveBeenCalled();
  });

  it('a THROWING liveness read suppresses every alert this tick, without failing the sweep', async () => {
    const deps = makeDeps({
      readGoalModeOwners: vi.fn(async () => [overdueRow]),
      resolveLiveness: vi.fn(async () => {
        throw new Error('oracle degraded');
      }),
    });
    const r = await runGoalOwnerReportSweepOnce(sqlNever, deps);
    expect(r.overdue).toBe(1); // observed, reported honestly
    expect(r.nudged).toBe(0);
    expect(deps.escalate).not.toHaveBeenCalled();
    expect(deps.nudge).not.toHaveBeenCalled();
  });

  it('an escalate failure skips the nudge (the dedup retry next tick is the recovery path)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = makeDeps({
        readGoalModeOwners: vi.fn(async () => [overdueRow]),
        escalate: vi.fn(async () => {
          throw new Error('escalation store down');
        }),
      });
      const r = await runGoalOwnerReportSweepOnce(sqlNever, deps);
      expect(r.nudged).toBe(0);
      expect(deps.nudge).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('a nudge failure is contained per alert — the sweep still returns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = makeDeps({
        readGoalModeOwners: vi.fn(async () => [overdueRow]),
        nudge: vi.fn(async () => {
          throw new Error('wake fan down');
        }),
      });
      const r = await runGoalOwnerReportSweepOnce(sqlNever, deps);
      expect(r.overdue).toBe(1);
      expect(r.nudged).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});
