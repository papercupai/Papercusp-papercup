/** P008 intent oracles. Optional paths are copy-out mutation-probe subjects, never in-tree edits. */
import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';

const registry: typeof import('./modes/registry') = process.env.PAPERCUSP_GOAL_CONTRACT_PROBE
  ? await import(/* @vite-ignore */ pathToFileURL(process.env.PAPERCUSP_GOAL_CONTRACT_PROBE).href)
  : await import('./modes/registry');
const review: typeof import('./goal-planning-review') = process.env.PAPERCUSP_GOAL_REVIEW_PROBE
  ? await import(/* @vite-ignore */ pathToFileURL(process.env.PAPERCUSP_GOAL_REVIEW_PROBE).href)
  : await import('./goal-planning-review');

describe('P008 goal planning intent proof', () => {
  it('permits both scope-appropriate plan authors without an exclusive-Blender contradiction', () => {
    const contract = registry.modeById('goal')!.contract.replace(/\s+/g, ' ');
    expect(contract.includes('Both may originate plans')).toBe(true);
    expect(/Blender.*workspace-level/.test(contract)).toBe(true);
    expect(contract.includes('adopt or revise a suitable existing plan')).toBe(true);
    // Positive phrases alone would let a later contradictory instruction silently win.
    expect(/(?:only|exclusively) Blender (?:may|can|must)|Blender (?:is|as) the (?:only|exclusive) plan author/i.test(contract),
      'GOAL must not be told that Blender is the exclusive plan author').toBe(false);
  });

  const supported = {
    goalId: 'goal-proof', disposition: 'existing-plans-sufficient',
    rationale: 'The linked plan covers the remaining outcome.',
    evidenceRefs: ['plan:papercusp/covered'], planRefs: ['plan:papercusp/covered'],
    coverage: [{ need: 'Checkout recovery', itemRefs: ['WI-1', 'WI-2', 'WI-3'], planRef: 'plan:papercusp/covered' }],
  };
  it('represents the supported no-new-plan disposition without a positive idea count', () => {
    expect(review.goalPlanningReviewInputSchema.safeParse(supported).success).toBe(true);
  });
  it('rejects a no-new-plan review that carries no coverage map (goal-holder-plans P-003)', () => {
    const { coverage: _omitted, ...bare } = supported;
    expect(review.goalPlanningReviewInputSchema.safeParse(bare).success,
      'existing-plans-sufficient without a coverage map is an uncheckable assertion').toBe(false);
  });
  it('rejects a coverage map whose 3+ item cluster names no covering plan (D-002)', () => {
    const coverage = [{ need: 'Checkout recovery', itemRefs: ['WI-1', 'WI-2', 'WI-3'], justification: 'handled one by one' }];
    expect(review.goalPlanningReviewInputSchema.safeParse({ ...supported, coverage }).success).toBe(false);
  });
  it('rejects an unsupported sufficient-plan assertion with no evidence references', () => {
    expect(review.goalPlanningReviewInputSchema.safeParse({ ...supported, evidenceRefs: [] }).success,
      'A sufficient-plan assertion without supporting references must be rejected').toBe(false);
  });
  it('requires an uncovered outcome before recording a necessary new plan', () => {
    expect(review.goalPlanningReviewInputSchema.safeParse({ ...supported, disposition: 'plan-needed' }).success).toBe(false);
    expect(review.goalPlanningReviewInputSchema.safeParse({ ...supported, disposition: 'plan-needed',
      uncoveredOutcome: 'Recover failed checkout' }).success).toBe(true);
  });
});
