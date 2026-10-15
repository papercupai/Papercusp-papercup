/**
 * WI-10007486 — per-cause reject accounting for the Scout critics.
 *
 * Measured in the 2026-10-07/08 scout_cycle_stage_artifacts window (65 scored, 53
 * rejects): feasibility-only rejects were the majority, yet the tick recorded every
 * non-survivor as `ideasDeduped`, so dedup-burn-guard read feasibility rejects as
 * corpus saturation and widened the NOVELTY band. The same window held 2 moonshots
 * whose critic call had FAILED (placeholder scores novelty 1 / feasibility 0 passed
 * verdictFor as "a leap"). Pinned here:
 *   1. every reject carries a structured cause, set where its verdict is decided;
 *   2. a failed critic rejects with 'critic-failure' — never a moonshot (with a
 *      control proving the same scores from a WORKING critic are a moonshot);
 *   3. the dedup-burn guard counts only novelty + duplicate rejects as saturation
 *      (with a control proving the legacy count would have triggered).
 */
import { describe, it, expect } from 'vitest';
import type { Idea, ScoutLlmCall } from './types';
import { critiqueIdeas } from './critics';
import { bucketByCritique, countRejectCauses, verdictFor } from './critique-core';
import { assessDedupBurn, saturationRejects, type DedupBurnTick } from './dedup-burn-guard';

function idea(over: Partial<Idea> = {}): Idea {
  return {
    id: 'i1',
    lens: 'first-principles',
    title: 'a genuinely fresh mechanism',
    body: 'something the hive has not considered',
    mechanism: 'do the new thing',
    addressesPatternRefs: [],
    ...over,
  };
}

function fakeCritic(scores: { conceptualNovelty: number; feasibility: number }): ScoutLlmCall {
  return async () => {
    const json = { ...scores, rationale: 'fake critic' };
    return { text: JSON.stringify(json), json, costUsd: 0, inputTokens: 0, outputTokens: 0 };
  };
}

const throwingCritic: ScoutLlmCall = async () => {
  throw new Error('429 rate limited');
};

const unparseableCritic: ScoutLlmCall = async () => ({
  text: 'not json at all',
  json: null,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
});

describe('verdictFor / bucketByCritique — reject causes', () => {
  it('names novelty and feasibility rejects, and leaves keep/moonshot without a cause', () => {
    expect(verdictFor({ id: 'a', novelty: 0.1, feasibility: 0.9 }).rejectCause).toBe('novelty');
    expect(verdictFor({ id: 'b', novelty: 0.5, feasibility: 0.1 }, { moonshotNoveltyFloor: 0.8 }).rejectCause).toBe(
      'feasibility',
    );
    expect(verdictFor({ id: 'c', novelty: 0.9, feasibility: 0.9 }).rejectCause).toBeUndefined();
    expect(verdictFor({ id: 'd', novelty: 0.95, feasibility: 0.1 }).rejectCause).toBeUndefined();
  });

  it('a leap demoted by the moonshot cap carries moonshot-cap', () => {
    const b = bucketByCritique(
      [
        { id: 'm1', novelty: 0.95, feasibility: 0.1 },
        { id: 'm2', novelty: 0.9, feasibility: 0.1 },
      ],
      { maxMoonshots: 1 },
    );
    expect(b.verdicts.m1).toMatchObject({ verdict: 'moonshot' });
    expect(b.verdicts.m1.rejectCause).toBeUndefined();
    expect(b.verdicts.m2).toMatchObject({ verdict: 'reject', rejectCause: 'moonshot-cap' });
  });
});

describe('countRejectCauses', () => {
  it('partitions rejects by cause and always sums to the reject count', () => {
    const scored = [
      { verdict: 'keep' },
      { verdict: 'moonshot' },
      { verdict: 'reject', rejectCause: 'novelty' },
      { verdict: 'reject', rejectCause: 'feasibility' },
      { verdict: 'reject', rejectCause: 'feasibility' },
      { verdict: 'reject', rejectCause: 'moonshot-cap' },
      { verdict: 'reject', rejectCause: 'critic-failure' },
      { verdict: 'reject', rejectCause: 'duplicate', duplicateOf: 'plan:x' },
      // pre-cause artifact that recorded a merge → still a duplicate
      { verdict: 'reject', duplicateOf: 'plan:y' },
      // pre-cause artifact with no merge → unclassified, never silently dropped
      { verdict: 'reject' },
      // junk rows are skipped
      null,
      'reject',
    ];
    const c = countRejectCauses(scored);
    expect(c).toEqual({
      duplicate: 2,
      novelty: 1,
      feasibility: 2,
      moonshotCap: 1,
      criticFailure: 1,
      unclassified: 1,
    });
    const rejects = scored.filter((s) => !!s && typeof s === 'object' && s.verdict === 'reject').length;
    expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(rejects);
  });

  it('is all-zero for an absent or empty scored list', () => {
    const zero = { duplicate: 0, novelty: 0, feasibility: 0, moonshotCap: 0, criticFailure: 0, unclassified: 0 };
    expect(countRejectCauses(undefined)).toEqual(zero);
    expect(countRejectCauses([])).toEqual(zero);
  });
});

describe('critiqueIdeas — a failed critic never survives as a moonshot', () => {
  it('CONTROL: the placeholder scores (novelty 1, feasibility 0) from a WORKING critic ARE a moonshot', async () => {
    const r = await critiqueIdeas([idea()], [], { llmCall: fakeCritic({ conceptualNovelty: 1, feasibility: 0 }) });
    expect(r.moonshot.map((c) => c.idea.id)).toEqual(['i1']);
    expect(r.critiques[0].rejectCause).toBeUndefined();
  });

  it.each([
    ['a thrown critic call', throwingCritic],
    ['an unparseable critic response', unparseableCritic],
  ])('%s rejects with critic-failure', async (_label, llmCall) => {
    const r = await critiqueIdeas([idea()], [], { llmCall });
    expect(r.moonshot).toEqual([]);
    expect(r.kept).toEqual([]);
    expect(r.rejected.map((c) => c.idea.id)).toEqual(['i1']);
    expect(r.critiques[0]).toMatchObject({ verdict: 'reject', rejectCause: 'critic-failure' });
    expect(countRejectCauses(r.critiques).criticFailure).toBe(1);
  });

  it('every final reject carries a cause, and no survivor carries one', async () => {
    const ideas = [idea({ id: 'k' }), idea({ id: 'f' })];
    let n = 0;
    const llmCall: ScoutLlmCall = async (opts) => {
      n += 1;
      // first call keeps, second is mid-novelty low-feasibility
      const scores = n === 1 ? { conceptualNovelty: 0.9, feasibility: 0.9 } : { conceptualNovelty: 0.4, feasibility: 0.1 };
      return fakeCritic(scores)(opts);
    };
    const r = await critiqueIdeas(ideas, [], { llmCall }, { bucket: { moonshotNoveltyFloor: 0.8, moonshotFloorMin: 0.8 } });
    for (const c of r.critiques) {
      if (c.verdict === 'reject') expect(c.rejectCause).toBeDefined();
      else expect(c.rejectCause).toBeUndefined();
    }
    expect(r.rejected).toHaveLength(1);
  });
});

describe('dedup-burn-guard — saturation counts novelty + duplicate rejects only', () => {
  const causes = (novelty: number, duplicate: number, feasibility: number) => ({
    duplicate,
    novelty,
    feasibility,
    moonshotCap: 0,
    criticFailure: 0,
    unclassified: 0,
  });
  /** A ran tick shaped like the 2026-10-07/08 window: 10 generated, 9 non-survivors. */
  const tick = (c: ReturnType<typeof causes>): DedupBurnTick => ({
    status: 'ran',
    ideasGenerated: 10,
    ideasDeduped: c.novelty + c.duplicate + c.feasibility,
    ideasRouted: 1,
    detail: { rejectCauses: c },
  });

  it('CONTROL: by the legacy all-rejects count, a feasibility-dominated history triggers', () => {
    const legacy: DedupBurnTick[] = [
      { status: 'ran', ideasGenerated: 10, ideasDeduped: 9, ideasRouted: 1 },
      { status: 'ran', ideasGenerated: 10, ideasDeduped: 9, ideasRouted: 1 },
    ];
    expect(assessDedupBurn(legacy).saturated).toBe(true);
  });

  it('the same history WITH causes (feasibility 7 of 9) does not widen the novelty band', () => {
    const v = assessDedupBurn([tick(causes(1, 1, 7)), tick(causes(1, 1, 7))]);
    expect(v.saturated).toBe(false);
  });

  it('a novelty/duplicate-dominated history with causes still triggers', () => {
    const v = assessDedupBurn([tick(causes(6, 3, 0)), tick(causes(5, 4, 0))]);
    expect(v.saturated).toBe(true);
    expect(v.lastRatio).toBe(0.9);
  });

  it('saturationRejects reads causes when present and falls back to ideasDeduped otherwise', () => {
    expect(saturationRejects(tick(causes(2, 1, 6)))).toEqual({ count: 3, source: 'causes' });
    expect(saturationRejects({ status: 'ran', ideasGenerated: 10, ideasDeduped: 8 })).toEqual({
      count: 8,
      source: 'ideasDeduped',
    });
    // malformed causes → legacy fallback, never NaN
    expect(
      saturationRejects({ status: 'ran', ideasGenerated: 10, ideasDeduped: 4, detail: { rejectCauses: { novelty: '3' } } }),
    ).toEqual({ count: 4, source: 'ideasDeduped' });
  });
});
