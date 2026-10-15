/**
 * P-004: the computed tenure-card sweep keeps exactly one current computed card per
 * tenure — files the first, leaves an unchanged one alone, supersedes on a verdict change,
 * and never touches a tenure a grader has graded.
 */
import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';

import {
  buildComputedTenureRatings,
  computedRatingsSignature,
  GOAL_COMPUTED_CARD_AUTHOR,
  type TenureCardRow,
} from '../goal-computed-tenure-card';
import {
  GOAL_MODE_COMPUTED_VERSION,
  rateGoalModeComputed,
  type GoalModeComputedMetrics,
} from '../goal-mode-computed-instruments';
import { runGoalComputedTenureCardSweepOnce, type ComputedTenureSweepDeps } from './goal-computed-tenure-card-sweep';

const NOW = Date.parse('2026-10-08T15:00:00.000Z');
const START = NOW - 3 * 3600_000;
const KEYS = ['never-implements', 'templates-mandate', 'judgment-only'];

function metrics(input: { holderOwnerId: string; windowStart: string; windowEnd: string }, edits = 0): GoalModeComputedMetrics {
  return {
    version: GOAL_MODE_COMPUTED_VERSION,
    window: { workspaceId: 'ws', goalId: 'g1', ...input },
    measuredAtMs: NOW,
    holderCalls: [{ tool: 'coord:orient', at: START + 60_000, ok: true }],
    holderCallsTruncated: false,
    edits: Array.from({ length: edits }, (_, i) => ({ file: `src/f${i}.ts`, at: START + 120_000, via: 'Edit' })),
    coldWakes: [],
    descendantCompletions: [],
    peakWidth: { agents: 1, at: START },
    maxAgents: 6,
    createdItems: { placed: 0, loose: 0, looseSample: [] },
    plansWritten: 0,
    startedPlans: [],
    demandAtStart: 0,
    closedInWindow: 0,
  };
}

function deps(over: Partial<ComputedTenureSweepDeps> = {}) {
  const emit = vi.fn<ComputedTenureSweepDeps['emit']>(async () => ({ ok: true, issueId: 'EI-new' }));
  const base: Partial<ComputedTenureSweepDeps> = {
    flagEnabled: async () => true,
    now: () => NOW,
    readGoals: async () => [{ workspaceId: 'ws', goalId: 'g1', active: true }],
    readCurrentHolders: async () => new Map([['ws:g1', 'holder-a']]),
    readActivity: async () => [
      { ownerId: 'holder-a', atMs: START },
      { ownerId: 'holder-a', atMs: NOW - 5 * 60_000 },
    ],
    readCards: async () => [],
    criterionKeys: async () => KEYS,
    measure: async (input) => metrics(input),
    emit,
    ...over,
  };
  return { overrides: base, emit };
}

const sql = {} as Sql;

describe('runGoalComputedTenureCardSweepOnce', () => {
  it('files the first card for an ongoing tenure over start..now, never terminal', async () => {
    const { overrides, emit } = deps();
    const result = await runGoalComputedTenureCardSweepOnce(sql, overrides);
    expect(result).toMatchObject({ tenures: 1, evaluated: 1, emitted: 1, failed: 0 });
    const card = emit.mock.calls[0]![0];
    expect(card.supersedes).toBeNull();
    expect(card.windowStart).toBe(new Date(START).toISOString());
    expect(card.windowEnd).toBe(new Date(NOW).toISOString());
    expect(Object.keys(card.ratings).sort()).toEqual([...KEYS].sort());
    expect(card.ratings['judgment-only']).toMatchObject({ rating: 'unknown', unknownReason: 'not-assessed' });
  });

  it('leaves an unchanged recent card alone and supersedes it when verdicts change', async () => {
    const window = { holderOwnerId: 'holder-a', windowStart: new Date(START).toISOString(), windowEnd: new Date(NOW).toISOString() };
    const signature = computedRatingsSignature(buildComputedTenureRatings(KEYS, rateGoalModeComputed(metrics(window))));
    const current: TenureCardRow = {
      issueId: 'EI-cur',
      createdMs: NOW - 10 * 60_000,
      createdBy: GOAL_COMPUTED_CARD_AUTHOR,
      subjectRef: 'holder-a',
      windowStartMs: START,
      windowEndMs: NOW - 10 * 60_000,
      supersedes: null,
      ratingsSignature: signature,
    };
    const same = deps({ readCards: async () => [current] });
    expect(await runGoalComputedTenureCardSweepOnce(sql, same.overrides)).toMatchObject({ emitted: 0, unchanged: 1 });
    expect(same.emit).not.toHaveBeenCalled();

    // The holder edits a file: never-implements flips to fail, so the card is re-filed.
    const changed = deps({ readCards: async () => [current], measure: async (input) => metrics(input, 1) });
    expect(await runGoalComputedTenureCardSweepOnce(sql, changed.overrides)).toMatchObject({ emitted: 1 });
    expect(changed.emit.mock.calls[0]![0].supersedes).toBe('EI-cur');
  });

  it('never touches a tenure a grader already graded', async () => {
    const computed: TenureCardRow = {
      issueId: 'EI-c', createdMs: NOW - 3600_000, createdBy: GOAL_COMPUTED_CARD_AUTHOR, subjectRef: 'holder-a',
      windowStartMs: START, windowEndMs: NOW - 3600_000, supersedes: null, ratingsSignature: 'x',
    };
    const graded: TenureCardRow = { ...computed, issueId: 'EI-g', createdBy: 'su-grader', supersedes: 'EI-c' };
    const { overrides, emit } = deps({ readCards: async () => [computed, graded] });
    expect(await runGoalComputedTenureCardSweepOnce(sql, overrides)).toMatchObject({ graded: 1, evaluated: 0 });
    expect(emit).not.toHaveBeenCalled();
  });

  it('honours the kill-switch and contains a failing tenure', async () => {
    const off = deps({ flagEnabled: async () => false });
    expect((await runGoalComputedTenureCardSweepOnce(sql, off.overrides)).skipped).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const boom = deps({ measure: async () => { throw new Error('pg down'); } });
      expect(await runGoalComputedTenureCardSweepOnce(sql, boom.overrides)).toMatchObject({ failed: 1, emitted: 0 });
      // The failure is contained (counted) AND reported, never silently swallowed.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('g1/holder-a failed (non-fatal): pg down'));
    } finally {
      warn.mockRestore();
    }
  });

  it('skips a window that resolves to a different goal', async () => {
    const { overrides, emit } = deps({ measure: async (input) => ({ ...metrics(input), window: { ...metrics(input).window, goalId: 'other' } }) });
    expect(await runGoalComputedTenureCardSweepOnce(sql, overrides)).toMatchObject({ emitted: 0, unchanged: 1 });
    expect(emit).not.toHaveBeenCalled();
  });
});
