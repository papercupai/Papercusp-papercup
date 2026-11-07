import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asStructuredObservation } from '../../harness/improvements/observation-types';
import { specQualityRerunRecipeSchema } from '../plans/spec-quality-identity';

const readRubric = vi.hoisted(() => vi.fn());
vi.mock('../../rubrics', async original => ({ ...await original<typeof import('../../rubrics')>(), readRubric }));
vi.mock('../../scout/generation-watermark', () => ({ readRunningGeneration: async () => null }));
vi.mock('../plans/spec-quality', async original => ({ ...await original<typeof import('../plans/spec-quality')>(),
  resolveSpecQualityPlanSubject: async () => ({ planSlug: 'quality-plan', harnessSlug: 'papercusp' }) }));
vi.mock('../../plan-audits', async original => ({ ...await original<typeof import('../../plan-audits')>(),
  withCurrentDiscovery: async (_input: unknown, accept: () => Promise<unknown>) => ({ ok: true, result: await accept() }) }));
import emitTool, { emitScorecard } from './emit';

const build = { sha: 'quality-evaluator-v2', version: '1.0.0' };
const recipe = specQualityRerunRecipeSchema.parse({
  schemaVersion: 1, evaluator: 'plans:evaluate-spec-quality', evaluatorBuild: build, specSetHashVersion: 2,
  args: { harness: 'papercusp', slug: 'quality-plan', classRef: 'plan-class-feature-ship',
    evaluatorBuild: build, specSetHashVersion: 2, expectedSpecSetHash: 'a'.repeat(64),
    replaySnapshot: { planContentHash: 'b'.repeat(64), clausesAsOf: '2026-11-01T00:00:00.000Z' } },
});
const args = { rubricRef: 'spec-quality', terminal: true as const,
  subject: { kind: 'plan' as const, ref: 'spec-set:plan-class-feature-ship:' + 'a'.repeat(64) + ':quality-plan' },
  ratings: { freshness: { rating: 'pass', evidence: 'Exact server evaluator snapshot.' } }, rerunRecipe: recipe };

beforeEach(() => {
  readRubric.mockResolvedValue({ kind: 'found', rubric: { rubricId: 'spec-quality', kind: 'standard', status: 'active',
    criteria: [{ key: 'freshness', title: 'Freshness' }], ratingScale: ['pass', 'fail', 'unknown'] } });
});

describe('spec quality emission identity (EI-28010197882392568)', () => {
  it('accepts the complete quality evaluator draft at the public emitter boundary', () => {
    const parsed = emitTool.args.safeParse(args);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    if (!parsed.success) throw new Error('Expected the complete quality draft to be accepted');
    expect(parsed.data.rerunRecipe).toEqual(recipe);
  });

  it('preserves the exact executable recipe through canonical observation readback', () => {
    expect(asStructuredObservation({ rubricRef: 'spec-quality', ratings: args.ratings, rerunRecipe: recipe })?.rerunRecipe)
      .toEqual(recipe);
  });

  it.each(['legacy', 'older-build', 'older-protocol', 'contradictory-args'])('refuses %s before replay, persistence or audit', async mismatch => {
    const dispatchTool = vi.fn();
    const altered = mismatch === 'legacy' ? undefined : { ...recipe,
      ...(mismatch === 'older-build' ? { evaluatorBuild: { ...build, sha: 'older' } } : {}),
      ...(mismatch === 'older-protocol' ? { specSetHashVersion: 1 } : {}),
      ...(mismatch === 'contradictory-args' ? { args: { ...recipe.args, evaluatorBuild: { ...build, sha: 'older' } } } : {}),
    };
    const result = await emitScorecard({ ...args, rerunRecipe: altered }, { createdBy: 'independent-grader' },
      { getEvaluatorBuild: () => build, dispatchTool });
    expect(result.ok).toBe(false);
    expect(result.code).toMatch(/spec_quality/);
    expect(dispatchTool).not.toHaveBeenCalled();
  });

  it('refuses a same-build replay that returns the old same-clause hash', async () => {
    const dispatchTool = vi.fn().mockResolvedValue({ ok: true, evaluatorBuild: build, specSetHashVersion: 2,
      specSetHash: 'c'.repeat(64), scorecardDraft: args });
    const result = await emitScorecard(args, { createdBy: 'independent-grader' }, { getEvaluatorBuild: () => build, dispatchTool });
    expect(result).toMatchObject({ ok: false, code: 'invalid_spec_quality_binding' });
    expect(dispatchTool).toHaveBeenCalledExactlyOnceWith('plans:evaluate-spec-quality', recipe.args);
  });

  it.each(['missing-version', 'missing-ratings', 'unavailable'])('fails closed when replay is %s', async failure => {
    const dispatchTool = failure === 'unavailable' ? vi.fn().mockRejectedValue(new Error('evaluator unavailable'))
      : vi.fn().mockResolvedValue({ ok: true, evaluatorBuild: build,
        ...(failure === 'missing-version' ? {} : { specSetHashVersion: 2 }),
        specSetHash: recipe.args.expectedSpecSetHash,
        scorecardDraft: failure === 'missing-ratings' ? { subject: args.subject } : args });
    expect(await emitScorecard(args, { createdBy: 'independent-grader' }, { getEvaluatorBuild: () => build, dispatchTool }))
      .toMatchObject({ ok: false, code: 'invalid_spec_quality_binding' });
  });
});
