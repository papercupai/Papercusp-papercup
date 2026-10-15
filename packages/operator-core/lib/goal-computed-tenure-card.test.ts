/**
 * P-004 (goal-grading-live-coverage-and-holder-followthrough-2026-10-08): whole-tenure
 * computed goal-mode-e2e cards. Pure rules + the grader-side adoption, each with a
 * positive and a negative control.
 */
import { describe, expect, it } from 'vitest';

import {
  adoptComputedTenureRatings,
  buildComputedTenureRatings,
  COMPUTED_CARD_REFRESH_MS,
  COMPUTED_EVIDENCE_PREFIX,
  COMPUTED_FAIL_DISREGARD,
  COMPUTED_TENURE_GAP_MS,
  computedRatingsSignature,
  decideTenureCardEmit,
  deriveHolderTenures,
  GOAL_COMPUTED_CARD_AUTHOR,
  isAdoptableComputedRating,
  mergeComputedTenureRatings,
  tenureCardState,
  tenureNeedsEvaluation,
  type HolderTenure,
  type TenureCardRow,
} from './goal-computed-tenure-card';
import { CHILD_PROOF_WINDOW_MS, type GoalModeComputedRating } from './goal-mode-computed-instruments';

const H = 3600_000;
const T0 = Date.parse('2026-10-08T09:00:00.000Z');

function tenure(over: Partial<HolderTenure> = {}): HolderTenure {
  return {
    workspaceId: 'ws',
    goalId: 'g1',
    ownerId: 'holder-a',
    startMs: T0,
    lastMs: T0 + 5 * H,
    ongoing: false,
    endMs: T0 + 5 * H,
    ...over,
  };
}

function card(over: Partial<TenureCardRow> = {}): TenureCardRow {
  return {
    issueId: 'EI-1',
    createdMs: T0 + 5 * H,
    createdBy: GOAL_COMPUTED_CARD_AUTHOR,
    subjectRef: 'holder-a',
    windowStartMs: T0,
    windowEndMs: T0 + 5 * H,
    supersedes: null,
    ratingsSignature: 'sig',
    ...over,
  };
}

describe('deriveHolderTenures', () => {
  const base = {
    workspaceId: 'ws',
    goalId: 'g1',
    currentHolderOwnerId: 'holder-b',
    goalActive: true,
  };

  it('splits one owner at a gap longer than COMPUTED_TENURE_GAP_MS and keeps owners apart', () => {
    const activity = [
      { ownerId: 'holder-a', atMs: T0 },
      { ownerId: 'holder-a', atMs: T0 + 2 * H },
      { ownerId: 'holder-a', atMs: T0 + 2 * H + COMPUTED_TENURE_GAP_MS + 1 },
      { ownerId: 'holder-b', atMs: T0 + 10 * H },
    ];
    const tenures = deriveHolderTenures({ ...base, activity, nowMs: T0 + 11 * H });
    expect(tenures.map((t) => [t.ownerId, t.startMs - T0, t.lastMs - T0, t.ongoing])).toEqual([
      ['holder-a', 0, 2 * H, false],
      ['holder-a', 2 * H + COMPUTED_TENURE_GAP_MS + 1, 2 * H + COMPUTED_TENURE_GAP_MS + 1, false],
      ['holder-b', 10 * H, 10 * H, true],
    ]);
  });

  it('a gap exactly at the limit does not split', () => {
    const activity = [
      { ownerId: 'holder-a', atMs: T0 },
      { ownerId: 'holder-a', atMs: T0 + COMPUTED_TENURE_GAP_MS },
    ];
    expect(deriveHolderTenures({ ...base, activity, nowMs: T0 + 20 * H })).toHaveLength(1);
  });

  it('only the current holder, on an active goal, within the gap, is ongoing — its window ends now', () => {
    const activity = [{ ownerId: 'holder-b', atMs: T0 }];
    const now = T0 + H;
    const [live] = deriveHolderTenures({ ...base, activity, nowMs: now });
    expect(live).toMatchObject({ ongoing: true, endMs: now });
    // Negative controls: paused goal, a former holder, or a silent holder all end the tenure.
    expect(deriveHolderTenures({ ...base, goalActive: false, activity, nowMs: now })[0]!.ongoing).toBe(false);
    expect(deriveHolderTenures({ ...base, currentHolderOwnerId: 'other', activity, nowMs: now })[0]!.ongoing).toBe(false);
    const silent = deriveHolderTenures({ ...base, activity, nowMs: T0 + COMPUTED_TENURE_GAP_MS + 1 })[0]!;
    expect(silent.ongoing).toBe(false);
  });

  it('an ended single-call tenure still has a positive window', () => {
    const [t] = deriveHolderTenures({ ...base, currentHolderOwnerId: null, activity: [{ ownerId: 'x', atMs: T0 }], nowMs: T0 + H });
    expect(t!.endMs).toBeGreaterThan(t!.startMs);
  });
});

describe('buildComputedTenureRatings', () => {
  const computed: Record<string, GoalModeComputedRating> = {
    'never-implements': { verdict: 'pass', reason: 'no edits' },
    'parallelism-width-and-ceilings': { verdict: 'fail', reason: 'width 11 > 6' },
    'templates-mandate': { verdict: 'unknown', unknownReason: 'not-exercised', reason: 'no trigger' },
    'rubric-reuse-not-proliferation': { verdict: 'unknown', unknownReason: 'needs-judgment', reason: '1 triggering call' },
    'dedup-before-creating': { verdict: 'unknown', unknownReason: 'idle', reason: 'no calls' },
  };
  const keys = [...Object.keys(computed), 'some-judgment-only-criterion'];
  const ratings = buildComputedTenureRatings(keys, computed);

  it('rates every criterion, so the card is complete', () => {
    expect(Object.keys(ratings).sort()).toEqual([...keys].sort());
  });

  it('maps verdicts; needs-judgment and uninstrumented read not-assessed', () => {
    expect(ratings['never-implements']).toMatchObject({ rating: 'pass' });
    expect(ratings['parallelism-width-and-ceilings']).toMatchObject({ rating: 'fail', disregard: COMPUTED_FAIL_DISREGARD });
    expect(ratings['templates-mandate']).toMatchObject({ rating: 'unknown', unknownReason: 'not-exercised' });
    expect(ratings['dedup-before-creating']).toMatchObject({ rating: 'unknown', unknownReason: 'idle' });
    expect(ratings['rubric-reuse-not-proliferation']).toMatchObject({ rating: 'unknown', unknownReason: 'not-assessed' });
    expect(ratings['some-judgment-only-criterion']).toMatchObject({ rating: 'unknown', unknownReason: 'not-assessed' });
    for (const entry of Object.values(ratings)) expect(entry.evidence.startsWith(COMPUTED_EVIDENCE_PREFIX)).toBe(true);
  });

  it('every unknown discloses a structured reason (goal-mode-e2e emit contract)', () => {
    for (const entry of Object.values(ratings)) if (entry.rating === 'unknown') expect(entry.unknownReason).toBeTruthy();
  });

  it('the signature tracks verdicts, not evidence prose', () => {
    const reworded = buildComputedTenureRatings(keys, {
      ...computed,
      'never-implements': { verdict: 'pass', reason: 'different words' },
    });
    expect(computedRatingsSignature(reworded)).toBe(computedRatingsSignature(ratings));
    const flipped = buildComputedTenureRatings(keys, {
      ...computed,
      'never-implements': { verdict: 'fail', reason: 'an edit' },
    });
    expect(computedRatingsSignature(flipped)).not.toBe(computedRatingsSignature(ratings));
  });
});

describe('grader adoption', () => {
  const computedCard = buildComputedTenureRatings(
    ['a-pass', 'a-fail', 'a-idle', 'a-not-exercised', 'a-judgment'],
    {},
  );
  computedCard['a-pass'] = { rating: 'pass', evidence: `${COMPUTED_EVIDENCE_PREFIX} x` };
  computedCard['a-fail'] = { rating: 'fail', evidence: `${COMPUTED_EVIDENCE_PREFIX} x`, disregard: COMPUTED_FAIL_DISREGARD };
  computedCard['a-idle'] = { rating: 'unknown', unknownReason: 'idle', evidence: `${COMPUTED_EVIDENCE_PREFIX} x` };
  computedCard['a-not-exercised'] = { rating: 'unknown', unknownReason: 'not-exercised', evidence: `${COMPUTED_EVIDENCE_PREFIX} x` };
  const keys = Object.keys(computedCard);

  it('adopts only settled computed ratings; fails and not-assessed stay residual', () => {
    expect(isAdoptableComputedRating(computedCard['a-pass'])).toBe(true);
    expect(isAdoptableComputedRating(computedCard['a-fail'])).toBe(false);
    expect(isAdoptableComputedRating(computedCard['a-judgment'])).toBe(false);
    // A grader's own pass (no computed marker) is never adopted.
    expect(isAdoptableComputedRating({ rating: 'pass', evidence: 'grader prose' })).toBe(false);
    const merged = mergeComputedTenureRatings({
      supplied: { 'a-judgment': { rating: 'pass', evidence: 'grader read the transcript' } },
      computed: computedCard,
      criterionKeys: keys,
      computedCardId: 'EI-9',
    });
    expect(merged.adoptedKeys.sort()).toEqual(['a-idle', 'a-not-exercised', 'a-pass']);
    expect(merged.residualKeys).toEqual(['a-fail']);
    expect(merged.ratings['a-judgment']).toEqual({ rating: 'pass', evidence: 'grader read the transcript' });
    expect(String(merged.ratings['a-pass']!.evidence)).toContain('adopted from computed card EI-9');
    expect(merged.ratings['a-fail']).toBeUndefined();
  });

  it('supplied ratings always win over the computed card', () => {
    const merged = mergeComputedTenureRatings({
      supplied: { 'a-pass': { rating: 'fail', evidence: 'grader overrides', remediation: 'WI-1' } },
      computed: computedCard,
      criterionKeys: keys,
      computedCardId: 'EI-9',
    });
    expect(merged.ratings['a-pass']).toMatchObject({ rating: 'fail', evidence: 'grader overrides' });
  });

  const subject = { ref: 'holder-a', windowStart: '2026-10-08T09:00:00.000Z', windowEnd: '2026-10-08T14:00:00.000Z' };
  const readCard = async () => ({ createdBy: GOAL_COMPUTED_CARD_AUTHOR, subject, ratings: computedCard });
  const base = {
    rubricRef: 'goal-mode-e2e',
    supersedes: 'EI-9',
    subject,
    supplied: { 'a-judgment': { rating: 'pass', evidence: 'judged' } },
    criterionKeys: keys,
  };

  it('adopts when superseding the computed card for the identical window', async () => {
    const out = await adoptComputedTenureRatings(base, { readCard });
    expect(out?.adoptedKeys.sort()).toEqual(['a-idle', 'a-not-exercised', 'a-pass']);
    // Same instant written differently still matches.
    const out2 = await adoptComputedTenureRatings(
      { ...base, subject: { ...subject, windowStart: '2026-10-08T09:00:00Z' } },
      { readCard },
    );
    expect(out2).not.toBeNull();
  });

  it('never adopts across a different rubric, author, subject or window', async () => {
    expect(await adoptComputedTenureRatings({ ...base, rubricRef: 'other' }, { readCard })).toBeNull();
    expect(await adoptComputedTenureRatings({ ...base, supersedes: undefined }, { readCard })).toBeNull();
    expect(
      await adoptComputedTenureRatings(base, { readCard: async () => ({ ...(await readCard()), createdBy: 'su-grader' }) }),
    ).toBeNull();
    expect(await adoptComputedTenureRatings({ ...base, subject: { ...subject, ref: 'holder-b' } }, { readCard })).toBeNull();
    expect(
      await adoptComputedTenureRatings({ ...base, subject: { ...subject, windowEnd: '2026-10-08T12:00:00.000Z' } }, { readCard }),
    ).toBeNull();
    expect(await adoptComputedTenureRatings(base, { readCard: async () => null })).toBeNull();
  });
});

describe('card lifecycle', () => {
  it('finds the current computed card and ignores superseded and foreign cards', () => {
    const cards = [
      card({ issueId: 'EI-1', createdMs: T0 + H }),
      card({ issueId: 'EI-2', createdMs: T0 + 2 * H, supersedes: 'EI-1' }),
      card({ issueId: 'EI-3', subjectRef: 'holder-b' }),
      card({ issueId: 'EI-4', windowStartMs: T0 + 30 * H, windowEndMs: T0 + 31 * H }),
    ];
    const state = tenureCardState(tenure(), cards);
    expect(state.current?.issueId).toBe('EI-2');
    expect(state.graded).toBe(false);
  });

  it('a grader card superseding the computed card marks the tenure graded', () => {
    const cards = [card({ issueId: 'EI-1' }), card({ issueId: 'EI-5', createdBy: 'su-grader', supersedes: 'EI-1' })];
    const state = tenureCardState(tenure(), cards);
    expect(state.graded).toBe(true);
    expect(tenureNeedsEvaluation(tenure(), state, T0 + 6 * H)).toEqual({ action: 'skip', reason: 'graded' });
  });

  it('an ended tenure settles once its card covers it and the proof window closed', () => {
    const t = tenure();
    const state = { current: card(), graded: false };
    expect(tenureNeedsEvaluation(t, state, t.endMs + H).action).toBe('evaluate');
    expect(tenureNeedsEvaluation(t, state, t.endMs + CHILD_PROOF_WINDOW_MS + COMPUTED_CARD_REFRESH_MS + 1)).toEqual({
      action: 'skip',
      reason: 'settled',
    });
    // Negative control: a card that does not yet cover the tenure end is never settled.
    expect(
      tenureNeedsEvaluation(t, { current: card({ windowEndMs: t.endMs - H }), graded: false }, t.endMs + 10 * H).action,
    ).toBe('evaluate');
  });

  it('decides first / changed / ended / refresh / unchanged', () => {
    const ongoing = tenure({ ongoing: true, endMs: T0 + 6 * H });
    const d = (over: Partial<Parameters<typeof decideTenureCardEmit>[0]>) =>
      decideTenureCardEmit({ tenure: ongoing, current: card(), signature: 'sig', nowMs: T0 + 5 * H + 10 * 60_000, windowStartMs: T0, ...over });
    expect(d({ current: null })).toEqual({ emit: true, supersedes: null, reason: 'first' });
    expect(d({ signature: 'other' })).toEqual({ emit: true, supersedes: 'EI-1', reason: 'verdicts-changed' });
    expect(d({})).toEqual({ emit: false, reason: 'unchanged' });
    expect(d({ nowMs: T0 + 5 * H + COMPUTED_CARD_REFRESH_MS })).toEqual({ emit: true, supersedes: 'EI-1', reason: 'refresh' });
    const ended = tenure({ endMs: T0 + 5 * H + 30 * 60_000 });
    expect(d({ tenure: ended })).toEqual({ emit: true, supersedes: 'EI-1', reason: 'tenure-ended' });
    expect(d({ tenure: tenure() })).toEqual({ emit: false, reason: 'unchanged' });
  });
});
