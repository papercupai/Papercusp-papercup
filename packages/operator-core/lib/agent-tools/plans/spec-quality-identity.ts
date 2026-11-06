import { z } from 'zod';
import { getBuildInfo } from '../../build-info';
import { SPEC_SET_HASH_VERSION } from './spec-clause-compiler';

export const specQualityEvaluatorBuildSchema = z.object({
  sha: z.string().trim().min(1).nullable(),
  version: z.string().trim().min(1),
}).strict();

export const specQualityReplayArgsSchema = z.object({
  harness: z.string().min(1),
  slug: z.string().min(1),
  classRef: z.string().min(1),
  expectedSpecSetHash: z.string().regex(/^[a-f0-9]{64}$/),
  specSetHashVersion: z.number().int().positive(),
  evaluatorBuild: specQualityEvaluatorBuildSchema,
  replaySnapshot: z.object({
    planContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    clausesAsOf: z.string().datetime({ offset: true }),
  }).strict(),
}).strict();

export const specQualityRerunRecipeSchema = z.object({
  schemaVersion: z.literal(1),
  evaluator: z.literal('plans:evaluate-spec-quality'),
  evaluatorBuild: specQualityEvaluatorBuildSchema,
  specSetHashVersion: z.number().int().positive(),
  args: specQualityReplayArgsSchema,
}).strict();

export type SpecQualityRerunRecipe = z.infer<typeof specQualityRerunRecipeSchema>;

/** A build pin is checked before reads/replay, never after paying for an audit. */
export function specQualityIdentityRefusal(
  recorded: { specSetHashVersion?: number; evaluatorBuild?: { sha: string | null; version: string } },
  live = getBuildInfo(),
): { code: 'spec_quality_evaluator_mismatch'; error: string } | undefined {
  if ((recorded.specSetHashVersion === undefined || recorded.specSetHashVersion === SPEC_SET_HASH_VERSION) &&
      (!recorded.evaluatorBuild || (live.sha && recorded.evaluatorBuild.sha === live.sha &&
        recorded.evaluatorBuild.version === live.version))) return undefined;
  return {
    code: 'spec_quality_evaluator_mismatch',
    error: `Spec quality requires hash protocol ${SPEC_SET_HASH_VERSION} on evaluator ${JSON.stringify(live)}; ` +
      `received ${JSON.stringify(recorded)}. Re-evaluate and emit on the same current build/route ` +
      '(use the staging build selector when evaluating staging); no card or audit was created. Historical cards remain unchanged.',
  };
}
