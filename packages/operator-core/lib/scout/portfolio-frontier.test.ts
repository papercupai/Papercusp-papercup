import { describe, expect, it } from 'vitest';

import {
  decodePortfolioFrontierCheckpoint,
  finishPortfolioFrontierStep,
  orderPortfolioCandidates,
  planPortfolioFrontierStep,
  PORTFOLIO_FRONTIER_VERIFICATION_FLOOR,
  type PortfolioFrontierCheckpoint,
  type PortfolioOutcomeCandidate,
} from './portfolio-frontier';

const NOW = Date.parse('2026-08-26T20:00:00Z');

const candidate = (
  ideaId: string,
  over: Partial<PortfolioOutcomeCandidate> = {},
): PortfolioOutcomeCandidate => ({
  ideaId,
  origin: 'scout',
  routedRef: `plan:${ideaId}`,
  routedAtMs: NOW,
  humanGrade: null,
  ...over,
});

const checkpoint = (over: Partial<PortfolioFrontierCheckpoint> = {}): PortfolioFrontierCheckpoint => ({
  version: 1,
  phase: 'outcome-verification',
  cursorIdeaId: null,
  cursorGrade: null,
  cursorRoutedAtMs: null,
  currentIdeaId: null,
  itemBudget: 2,
  timeBudgetMs: 5_000,
  consumedItems: 0,
  elapsedMs: 0,
  gradingBacklog: 0,
  pendingOutcomes: 0,
  evidenceSource: null,
  updatedAt: new Date(NOW).toISOString(),
  ...over,
});

describe('portfolio frontier ordering', () => {
  it('orders recorded value first, then oldest route, then stable id', () => {
    const rows = [
      candidate('later-low', { humanGrade: 3, routedAtMs: NOW + 1 }),
      candidate('later-high', { humanGrade: 5, routedAtMs: NOW + 2 }),
      candidate('b', { humanGrade: 5, routedAtMs: NOW }),
      candidate('a', { humanGrade: 5, routedAtMs: NOW }),
      candidate('ungraded', { routedAtMs: NOW - 10_000 }),
    ];
    expect(orderPortfolioCandidates(rows).map((row) => row.ideaId)).toEqual([
      'a',
      'b',
      'later-high',
      'later-low',
      'ungraded',
    ]);
  });
});

describe('planPortfolioFrontierStep', () => {
  it('reserves a bounded outcome slice while grading remains actionable', () => {
    const result = planPortfolioFrontierStep({
      gradingBacklog: 1,
      pending: [candidate('a'), candidate('b'), candidate('c'), candidate('d')],
      previous: checkpoint({ cursorIdeaId: 'resume-here' }),
      itemBudget: 10,
      timeBudgetMs: 5_000,
      nowMs: NOW,
    });
    expect(result.selected.map((row) => row.ideaId)).toEqual(['a', 'b', 'c']);
    expect(result.checkpoint).toMatchObject({
      phase: 'outcome-verification',
      cursorIdeaId: 'c',
      consumedItems: PORTFOLIO_FRONTIER_VERIFICATION_FLOOR,
      gradingBacklog: 1,
    });
  });

  it('enters outcome verification only on a drained grading frontier and respects the item budget', () => {
    const result = planPortfolioFrontierStep({
      gradingBacklog: 0,
      pending: [candidate('a'), candidate('b'), candidate('c')],
      itemBudget: 2,
      timeBudgetMs: 5_000,
      nowMs: NOW,
    });
    expect(result.selected.map((row) => row.ideaId)).toEqual(['a', 'b']);
    expect(result.checkpoint).toMatchObject({
      phase: 'outcome-verification',
      cursorIdeaId: 'b',
      currentIdeaId: 'a',
      consumedItems: 2,
      itemBudget: 2,
      timeBudgetMs: 5_000,
    });
  });

  it('resumes after a stable idea-id cursor, wraps, and never relies on an array offset', () => {
    const result = planPortfolioFrontierStep({
      gradingBacklog: 0,
      pending: [candidate('a'), candidate('b'), candidate('c')],
      previous: checkpoint({ cursorIdeaId: 'b' }),
      itemBudget: 2,
      timeBudgetMs: 5_000,
      nowMs: NOW,
    });
    expect(result.selected.map((row) => row.ideaId)).toEqual(['c', 'a']);
    expect(result.checkpoint.cursorIdeaId).toBe('a');
  });

  it('continues after the stored ordering boundary when the cursor row becomes terminal', () => {
    const result = planPortfolioFrontierStep({
      gradingBacklog: 0,
      pending: [
        candidate('a', { humanGrade: 5, routedAtMs: NOW }),
        candidate('c', { humanGrade: 5, routedAtMs: NOW + 2 }),
      ],
      previous: checkpoint({
        cursorIdeaId: 'b-now-terminal',
        cursorGrade: 5,
        cursorRoutedAtMs: NOW + 1,
      }),
      itemBudget: 1,
      timeBudgetMs: 5_000,
      nowMs: NOW,
    });
    expect(result.selected.map((row) => row.ideaId)).toEqual(['c']);
  });

  it('restarts at the ordered head for a legacy checkpoint with no ordering boundary', () => {
    const result = planPortfolioFrontierStep({
      gradingBacklog: 0,
      pending: [candidate('b'), candidate('a')],
      previous: checkpoint({ cursorIdeaId: 'legacy-missing' }),
      itemBudget: 1,
      timeBudgetMs: 5_000,
      nowMs: NOW,
    });
    expect(result.selected.map((row) => row.ideaId)).toEqual(['a']);
  });

  it('marks a fully drained portfolio and consumes no budget', () => {
    const result = planPortfolioFrontierStep({
      gradingBacklog: 0,
      pending: [],
      itemBudget: 10,
      timeBudgetMs: 5_000,
      nowMs: NOW,
    });
    expect(result.selected).toEqual([]);
    expect(result.checkpoint).toMatchObject({ phase: 'drained', consumedItems: 0, pendingOutcomes: 0 });
  });

  it('treats a zero time budget as an observable no-op', () => {
    const result = planPortfolioFrontierStep({
      gradingBacklog: 0,
      pending: [candidate('a')],
      itemBudget: 1,
      timeBudgetMs: 0,
      nowMs: NOW,
    });
    expect(result.selected).toEqual([]);
    expect(result.checkpoint).toMatchObject({ phase: 'outcome-verification', timeBudgetMs: 0 });
  });
});

// WI-10005247: a never-verified route (and rows the cursor lap has not revisited
// for a day) must not wait out the whole round-robin lap behind rows another
// writer just stamped.
describe('planPortfolioFrontierStep staleness tier', () => {
  const DAY = 86_400_000;
  const STALE_BEFORE = NOW - DAY;
  const fresh = (ideaId: string, over: Partial<PortfolioOutcomeCandidate> = {}) =>
    candidate(ideaId, { outcomeCheckedAtMs: NOW - 60_000, ...over });

  it('verifies a never-checked route and day-stale rows before a cursor that sits elsewhere', () => {
    const result = planPortfolioFrontierStep({
      gradingBacklog: 5,
      pending: [
        // graded su-ideate rows sort first but were last checked 2 days ago
        candidate('ideate-old', { humanGrade: 4, outcomeCheckedAtMs: NOW - 2 * DAY }),
        // brand-new route: never verified, graded late so it ranks behind the cursor
        candidate('brand-new', { humanGrade: 4, routedAtMs: NOW + 1, outcomeCheckedAtMs: null }),
        fresh('scout-1'),
        fresh('scout-2'),
        fresh('scout-3'),
      ],
      previous: checkpoint({ cursorIdeaId: 'scout-1' }),
      itemBudget: 25,
      timeBudgetMs: 5_000,
      nowMs: NOW,
      staleBeforeMs: STALE_BEFORE,
    });
    // never-checked first, then oldest check, then the reserved cursor slot
    expect(result.selected.map((row) => row.ideaId)).toEqual(['brand-new', 'ideate-old', 'scout-2']);
    expect(result.priorityCount).toBe(2);
  });

  it('keeps a reserved slot for the cursor so unstampable stale rows cannot freeze the lap', () => {
    const stale = ['s1', 's2', 's3', 's4'].map((id) => candidate(id, { outcomeCheckedAtMs: null }));
    const result = planPortfolioFrontierStep({
      gradingBacklog: 1,
      pending: [...stale, fresh('r1'), fresh('r2')],
      previous: checkpoint({ cursorIdeaId: 'r1' }),
      itemBudget: 25,
      timeBudgetMs: 5_000,
      nowMs: NOW,
      staleBeforeMs: STALE_BEFORE,
    });
    expect(result.selected).toHaveLength(PORTFOLIO_FRONTIER_VERIFICATION_FLOOR);
    expect(result.priorityCount).toBe(PORTFOLIO_FRONTIER_VERIFICATION_FLOOR - 1);
    expect(result.selected.at(-1)?.ideaId).toBe('r2');
  });

  it('does not drag the round-robin cursor to a priority pick', () => {
    const result = planPortfolioFrontierStep({
      gradingBacklog: 1,
      pending: [candidate('stale', { outcomeCheckedAtMs: null, humanGrade: 3 }), fresh('a'), fresh('b'), fresh('c')],
      previous: checkpoint({ cursorIdeaId: 'a', cursorGrade: null, cursorRoutedAtMs: NOW }),
      itemBudget: 25,
      timeBudgetMs: 5_000,
      nowMs: NOW,
      staleBeforeMs: STALE_BEFORE,
    });
    expect(result.selected.map((row) => row.ideaId)).toEqual(['stale', 'b', 'c']);
    expect(result.checkpoint.cursorIdeaId).toBe('c');
    expect(result.checkpoint.currentIdeaId).toBe('stale');
  });

  it('is inert when the caller omits staleBeforeMs or the staleness reading', () => {
    const pending = [candidate('x', { outcomeCheckedAtMs: null }), candidate('y'), candidate('z')];
    const base = { gradingBacklog: 0, pending, itemBudget: 2, timeBudgetMs: 5_000, nowMs: NOW };
    const disabled = planPortfolioFrontierStep({ ...base, previous: checkpoint({ cursorIdeaId: 'x' }) });
    expect(disabled.selected.map((row) => row.ideaId)).toEqual(['y', 'z']);
    expect(disabled.priorityCount).toBe(0);
    // `undefined` (not read) never counts as stale even with the tier enabled
    const unread = planPortfolioFrontierStep({
      ...base,
      pending: [candidate('y'), candidate('z')],
      previous: checkpoint({ cursorIdeaId: 'y' }),
      staleBeforeMs: STALE_BEFORE,
    });
    expect(unread.priorityCount).toBe(0);
    expect(unread.selected.map((row) => row.ideaId)).toEqual(['z', 'y']);
  });
});

describe('checkpoint durability', () => {
  it('rejects old/malformed persisted state instead of inventing a cursor', () => {
    expect(decodePortfolioFrontierCheckpoint(null)).toBeNull();
    expect(decodePortfolioFrontierCheckpoint({ version: 2, phase: 'grading' })).toBeNull();
    expect(decodePortfolioFrontierCheckpoint({ version: 1, phase: 'surprise' })).toBeNull();
  });

  it('records elapsed budget and the authoritative evidence source', () => {
    const finished = finishPortfolioFrontierStep(checkpoint(), {
      elapsedMs: 37,
      evidenceSource: { kind: 'plan-run', ref: 'plan:shipped-plan' },
      nowMs: NOW + 37,
    });
    expect(finished).toMatchObject({
      elapsedMs: 37,
      evidenceSource: { kind: 'plan-run', ref: 'plan:shipped-plan' },
      updatedAt: new Date(NOW + 37).toISOString(),
    });
  });
});
