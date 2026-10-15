/**
 * scorecard-freshness.test.ts — P-014b emission-freshness
 * (plan-templates-and-rubric-v2-2026-06-20 P-014 / D-005).
 *
 * Hermetic: listScorecards (P-013) is injected via the deps seam, so these pin the freshness LOGIC
 * (fresh / partial-only / stale, the complete-requires-rubricResolved rule, newest-first selection)
 * without PG. The underlying read has its own suite.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  checkScorecardFreshness,
  interpretOverwatchEmission,
  type OverwatchEmissionContext,
} from './scorecard-freshness';
import type { ScorecardRow, ListScorecardsFilter } from './scorecards';

function row(p: Partial<ScorecardRow> & { issueId: string; createdAt: string }): ScorecardRow {
  return {
    createdBy: 's-overwatch',
    rubricRef: 'pot-coordination-health',
    ratings: {},
    nKeys: 0,
    missingKeys: [],
    extraKeys: [],
    rubricResolved: true,
    synthesized: false,
    score10: null,
    linkedItems: [],
    ...p,
  };
}

const SINCE = '2026-06-20T12:00:00.000Z';
/** A deps seam returning a fixed scorecard set (newest-first, as listScorecards guarantees). */
const withRows = (rows: ScorecardRow[]) => ({ listScorecards: async () => rows });

describe('checkScorecardFreshness — P-014b emission-freshness', () => {
  it('FRESH: a complete scorecard landed in-window (the mandate is met)', async () => {
    const r = await checkScorecardFreshness(
      { rubricRef: 'pot-coordination-health', since: SINCE },
      withRows([
        row({ issueId: 'EI-1', createdAt: '2026-06-20T13:00:00.000Z', nKeys: 13, missingKeys: [], rubricResolved: true }),
      ]),
    );
    expect(r.status).toBe('fresh');
    expect(r.complete).toBe(true);
    expect(r.emitted).toBe(true);
    expect(r.lastCompleteAt).toBe('2026-06-20T13:00:00.000Z');
    expect(r.latestMissingKeys).toEqual([]);
    expect(r.latestExtraKeys).toEqual([]);
  });

  it('PARTIAL-ONLY: scorecards landed but ALL incomplete — the silent truncation becomes visible', async () => {
    const r = await checkScorecardFreshness(
      { rubricRef: 'pot-coordination-health', since: SINCE },
      withRows([
        // newest-first
        row({ issueId: 'EI-2', createdAt: '2026-06-20T13:30:00.000Z', nKeys: 3, missingKeys: ['wake', 'federation'], rubricResolved: true }),
        row({ issueId: 'EI-3', createdAt: '2026-06-20T13:00:00.000Z', nKeys: 4, missingKeys: ['federation'], rubricResolved: true }),
      ]),
    );
    expect(r.status).toBe('partial-only');
    expect(r.complete).toBe(false);
    expect(r.emitted).toBe(true);
    expect(r.count).toBe(2);
    expect(r.partialCount).toBe(2);
    expect(r.latestMissingKeys).toEqual(['wake', 'federation']); // the NEWEST scorecard's gap
    expect(r.lastEmittedAt).toBe('2026-06-20T13:30:00.000Z');
    expect(r.lastCompleteAt).toBeNull();
  });

  it('STALE: nothing landed in-window — the silent emission gap becomes visible', async () => {
    const r = await checkScorecardFreshness(
      { rubricRef: 'pot-coordination-health', since: SINCE },
      withRows([]),
    );
    expect(r.status).toBe('stale');
    expect(r.rubricKnown).toBe(true);
    expect(r.emitted).toBe(false);
    expect(r.complete).toBe(false);
    expect(r.count).toBe(0);
    expect(r.lastEmittedAt).toBeNull();
    expect(r.lastCompleteAt).toBeNull();
    expect(r.latestMissingKeys).toEqual([]);
    expect(r.latestExtraKeys).toEqual([]);
  });

  it('UNKNOWN-RUBRIC: an empty window for a nonexistent rubric is non-actionable, not stale', async () => {
    const getRubric = vi.fn(async () => null);
    const builtInCriterionKeysForRubric = vi.fn(() => null);
    const r = await checkScorecardFreshness(
      { rubricRef: 'definitely-not-a-rubric', since: SINCE },
      {
        listScorecards: async () => [],
        getRubric,
        builtInCriterionKeysForRubric,
      },
    );
    expect(r.status).toBe('unknown-rubric');
    expect(r.rubricKnown).toBe(false);
    expect(r.emitted).toBe(false);
    expect(r.complete).toBe(false);
    expect(r.count).toBe(0);
    expect(builtInCriterionKeysForRubric).toHaveBeenCalledWith('definitely-not-a-rubric');
    expect(getRubric).toHaveBeenCalledWith('definitely-not-a-rubric');
  });

  it('does not resolve the rubric when scorecards are present — rows already prove the reference', async () => {
    const getRubric = vi.fn(async () => null);
    const builtInCriterionKeysForRubric = vi.fn(() => null);
    const r = await checkScorecardFreshness(
      { rubricRef: 'custom-rubric', since: SINCE },
      {
        listScorecards: async () => [
          row({ issueId: 'EI-PRESENT', createdAt: '2026-06-20T13:00:00.000Z' }),
        ],
        getRubric,
        builtInCriterionKeysForRubric,
      },
    );
    expect(r.rubricKnown).toBe(true);
    expect(getRubric).not.toHaveBeenCalled();
    expect(builtInCriterionKeysForRubric).not.toHaveBeenCalled();
  });

  it('FRESH picks the newest COMPLETE even when a later partial follows an earlier complete', async () => {
    const r = await checkScorecardFreshness(
      { rubricRef: 'pot-coordination-health', since: SINCE },
      withRows([
        row({ issueId: 'EI-5', createdAt: '2026-06-20T14:00:00.000Z', nKeys: 2, missingKeys: ['wake'], rubricResolved: true }), // newest, partial
        row({ issueId: 'EI-6', createdAt: '2026-06-20T13:00:00.000Z', nKeys: 13, missingKeys: [], rubricResolved: true }), // older, complete
      ]),
    );
    expect(r.status).toBe('fresh'); // a complete one exists in-window
    expect(r.complete).toBe(true);
    expect(r.partialCount).toBe(1);
    expect(r.lastCompleteAt).toBe('2026-06-20T13:00:00.000Z');
    expect(r.lastEmittedAt).toBe('2026-06-20T14:00:00.000Z'); // newest emission (the partial)
    expect(r.latestMissingKeys).toEqual(['wake']);
  });

  it('does NOT count an UNRESOLVED-rubric scorecard as complete (empty missingKeys but rubricResolved=false)', async () => {
    const r = await checkScorecardFreshness(
      { rubricRef: 'unknown-rubric', since: SINCE },
      withRows([
        row({ issueId: 'EI-7', createdAt: '2026-06-20T13:00:00.000Z', nKeys: 2, missingKeys: [], rubricResolved: false }),
      ]),
    );
    expect(r.emitted).toBe(true);
    expect(r.complete).toBe(false); // unresolved → not a confirmable complete
    expect(r.partialCount).toBe(0); // not confirmed-incomplete either
    expect(r.status).toBe('partial-only'); // emitted but no confirmed-complete
    expect(r.rubricKnown).toBe(true); // non-empty rows avoid an extra resolver lookup
  });

  it('treats a scorecard with extra non-rubric keys as partial-only, not complete', async () => {
    const r = await checkScorecardFreshness(
      { rubricRef: 'pot-coordination-health', since: SINCE },
      withRows([
        row({
          issueId: 'EI-EXTRA',
          createdAt: '2026-06-20T13:00:00.000Z',
          nKeys: 15,
          missingKeys: [],
          extraKeys: ['invented-dimension'],
          rubricResolved: true,
        }),
      ]),
    );
    expect(r.status).toBe('partial-only');
    expect(r.complete).toBe(false);
    expect(r.partialCount).toBe(1);
    expect(r.latestMissingKeys).toEqual([]);
    expect(r.latestExtraKeys).toEqual(['invented-dimension']);
  });

  it('EXCLUDES the synthesized floor by default — a floor-only window reads STALE so the agent skip stays visible', async () => {
    const rows = [
      row({
        issueId: 'EI-FLOOR',
        createdAt: '2026-06-20T13:00:00.000Z',
        nKeys: 13,
        missingKeys: [],
        rubricResolved: true,
        synthesized: true,
      }),
    ];
    // The seam honors the filter exactly as the real listScorecards does.
    const seam = {
      listScorecards: async (f?: ListScorecardsFilter) =>
        f?.includeSynthesized ? rows : rows.filter((r) => !r.synthesized),
    };
    const byDefault = await checkScorecardFreshness(
      { rubricRef: 'pot-coordination-health', since: SINCE },
      seam,
    );
    expect(byDefault.status).toBe('stale'); // the floor does NOT satisfy the agent mandate

    const including = await checkScorecardFreshness(
      { rubricRef: 'pot-coordination-health', since: SINCE, includeSynthesized: true },
      seam,
    );
    expect(including.status).toBe('fresh'); // counted only when explicitly asked
  });

  it('defaults `since` to a lookback window when omitted', async () => {
    const r = await checkScorecardFreshness(
      { rubricRef: 'pot-coordination-health', lookbackMs: 60_000 },
      withRows([]),
    );
    expect(typeof r.since).toBe('string');
    expect(r.status).toBe('stale');
  });
});

describe('interpretOverwatchEmission — WI-1724 self-interpreting freshness verdict', () => {
  // A live, started, currently-firing loop (the "should be emitting" baseline).
  const liveLoop: OverwatchEmissionContext = {
    flagEnabled: true,
    started: true,
    loopAlive: true,
    loopStale: false,
    lastRunAt: '2026-07-03T04:00:00.000Z',
  };

  it('FRESH ⇒ verdict fresh, non-actionable (regardless of loop state)', () => {
    const r = interpretOverwatchEmission('fresh', liveLoop);
    expect(r.verdict).toBe('fresh');
    expect(r.actionable).toBe(false);
  });

  it('unknown-rubric ⇒ a non-actionable invalid-reference verdict before loop context', () => {
    const r = interpretOverwatchEmission('unknown-rubric', liveLoop);
    expect(r.verdict).toBe('unknown-rubric');
    expect(r.actionable).toBe(false);
    expect(r.note).toContain('not registered');
  });

  it('stale + flag OFF ⇒ overwatch-disabled, NON-actionable (staleness expected — the false-alarm case)', () => {
    const r = interpretOverwatchEmission('stale', {
      flagEnabled: false,
      started: false,
      loopAlive: false,
      loopStale: false,
      lastRunAt: null,
    });
    expect(r.verdict).toBe('overwatch-disabled');
    expect(r.actionable).toBe(false);
  });

  it('stale + enabled but NOT started ⇒ overwatch-not-started, NON-actionable', () => {
    const r = interpretOverwatchEmission('stale', {
      flagEnabled: true,
      started: false,
      loopAlive: false,
      loopStale: false,
      lastRunAt: null,
    });
    expect(r.verdict).toBe('overwatch-not-started');
    expect(r.actionable).toBe(false);
  });

  it('stale + started+enabled + loop STALE ⇒ loop-dead, ACTIONABLE (revive the loop — the WI-1724 root case)', () => {
    const r = interpretOverwatchEmission('stale', {
      flagEnabled: true,
      started: true,
      loopAlive: false,
      loopStale: true,
      lastRunAt: '2026-07-02T21:07:19.000Z',
    });
    expect(r.verdict).toBe('loop-dead');
    expect(r.actionable).toBe(true);
    expect(r.note).toContain('2026-07-02T21:07:19.000Z'); // surfaces the last-run time
  });

  it('stale + bounded turn in flight ⇒ turn-in-flight, NON-actionable even past a short cadence window', () => {
    const r = interpretOverwatchEmission('stale', {
      flagEnabled: true,
      started: true,
      loopAlive: false,
      loopStale: true,
      lastRunAt: '2026-07-13T20:23:40.000Z',
      inFlight: true,
    });
    expect(r.verdict).toBe('turn-in-flight');
    expect(r.actionable).toBe(false);
    expect(r.note).toContain('IN FLIGHT');
  });

  it('stale + started+enabled + loop never fired ⇒ loop-dead (lastRunAt null renders "never")', () => {
    const r = interpretOverwatchEmission('stale', {
      flagEnabled: true,
      started: true,
      loopAlive: false,
      loopStale: false, // neither alive nor stale (defensive) still reads as a dead loop
      lastRunAt: null,
    });
    expect(r.verdict).toBe('loop-dead');
    expect(r.actionable).toBe(true);
    expect(r.note).toContain('never');
  });

  it('stale + live loop ⇒ agent-skipping, ACTIONABLE (loop fires but agent emits nothing — D-005)', () => {
    const r = interpretOverwatchEmission('stale', liveLoop);
    expect(r.verdict).toBe('agent-skipping');
    expect(r.actionable).toBe(true);
    expect(r.note).toContain('SKIPPING');
  });

  it('partial-only + live loop ⇒ agent-skipping with the TRUNCATION note', () => {
    const r = interpretOverwatchEmission('partial-only', liveLoop);
    expect(r.verdict).toBe('agent-skipping');
    expect(r.actionable).toBe(true);
    expect(r.note).toContain('TRUNCATING');
  });

  it('precedence: a disabled flag wins even if the loop looks stale', () => {
    const r = interpretOverwatchEmission('stale', {
      flagEnabled: false,
      started: true,
      loopAlive: false,
      loopStale: true,
      lastRunAt: '2026-07-02T21:07:19.000Z',
    });
    expect(r.verdict).toBe('overwatch-disabled');
    expect(r.actionable).toBe(false);
  });
});
