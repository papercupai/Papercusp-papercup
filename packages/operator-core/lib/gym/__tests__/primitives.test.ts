import { describe, it, expect } from 'vitest';
import {
  GYM_SIGNAL_REGISTRY,
  knownSignals,
  resolveSignals,
  evaluateSignals,
  rubricFromBlueprintGym,
  GYM_JUDGE_RUBRIC_V1,
  type SignalContext,
} from '../primitives';
import type { BlueprintGym } from '@papercusp/orchestrator/blueprint';

/**
 * P-012 — the gym ENGINE-PRIMITIVES surface: the host-side signal registry (resolves
 * a blueprint's `gym.signals` names → deterministic guardrails) + the rubric mapper
 * (reads the TARGET blueprint's `gym.rubric`, falling back to GYM_JUDGE_RUBRIC_V1).
 */

describe('GYM_SIGNAL_REGISTRY / resolveSignals', () => {
  it('exposes the built-in deterministic signals by name', () => {
    // The original pair + the FB-23 drill-ground-truth trio (P-048) + fabricationDetected (HE-06).
    expect(knownSignals().sort()).toEqual([
      'drillMttsh',
      'drillResolveRate',
      'drillTriageAccuracy',
      'fabricationDetected',
      'plantedBugCaught',
      'regressionsFromTests',
    ]);
    expect(typeof GYM_SIGNAL_REGISTRY.regressionsFromTests).toBe('function');
    expect(typeof GYM_SIGNAL_REGISTRY.plantedBugCaught).toBe('function');
    expect(typeof GYM_SIGNAL_REGISTRY.fabricationDetected).toBe('function');
  });

  it('resolves known names and reports unknown ones (no silent drop)', () => {
    const { resolved, unknown } = resolveSignals(['regressionsFromTests', 'nope', 'plantedBugCaught']);
    expect(resolved.map((r) => r.name)).toEqual(['regressionsFromTests', 'plantedBugCaught']);
    expect(unknown).toEqual(['nope']);
  });
});

describe('evaluateSignals', () => {
  it('marks incomplete regression coverage inapplicable instead of passing', () => {
    const { results } = evaluateSignals(['regressionsFromTests'], {
      preTests: [{ name: 'kept', passed: true }, { name: 'missing', passed: true }],
      postTests: [{ name: 'kept', passed: true }],
    });
    expect(results).toEqual([{ name: 'regressionsFromTests', value: false, applicable: false }]);
  });
  it('regressionsFromTests fires true on a pre-green test gone red', () => {
    const ctx: SignalContext = {
      preTests: [{ name: 't1', passed: true }],
      postTests: [{ name: 't1', passed: false }],
    };
    const { results } = evaluateSignals(['regressionsFromTests'], ctx);
    expect(results).toEqual([{ name: 'regressionsFromTests', value: true, applicable: true }]);
  });

  it('plantedBugCaught fires true when the harness output references the bug location', () => {
    const ctx: SignalContext = {
      plantedBug: { location: 'src/auth/session.ts', defect: 'off-by-one', detectionSignature: 'x' },
      harnessOutputText: 'the validator flagged a problem in src/auth/session.ts near the loop',
    };
    const { results } = evaluateSignals(['plantedBugCaught'], ctx);
    expect(results[0]).toEqual({ name: 'plantedBugCaught', value: true, applicable: true });
  });

  it('fabricationDetected fires true on a claimed-done item ground truth contradicts (HE-06, P-041)', () => {
    const ctx: SignalContext = {
      claimedItems: [
        { claimedDone: true, actuallyDone: true, hasCommit: true }, // genuinely done
        { claimedDone: true, actuallyDone: false, hasCommit: false }, // FABRICATED
      ],
    };
    const { results } = evaluateSignals(['fabricationDetected'], ctx);
    expect(results[0]).toEqual({ name: 'fabricationDetected', value: true, applicable: true });
  });

  it('fabricationDetected is inapplicable (not a fake pass) for a non-Hive target with no claim rows', () => {
    const { results } = evaluateSignals(['fabricationDetected'], { harnessOutputText: 'done' });
    expect(results[0]).toEqual({ name: 'fabricationDetected', value: false, applicable: false });
  });

  it('marks a signal NOT-applicable (not a false value) when its inputs are absent', () => {
    // A repo-less (work-item-output) target has no pre/post tests → regression signal
    // is inapplicable, NOT a (misleading) false. This is the requiresRepo:false path.
    const { results } = evaluateSignals(['regressionsFromTests'], { harnessOutputText: 'done' });
    expect(results[0]).toEqual({ name: 'regressionsFromTests', value: false, applicable: false });
  });

  it('reports unknown signal names from evaluate too', () => {
    const { unknown } = evaluateSignals(['bogus'], {});
    expect(unknown).toEqual(['bogus']);
  });
});

describe('rubricFromBlueprintGym', () => {
  it('returns the frozen V1 rubric when the target declares no gym/rubric', () => {
    expect(rubricFromBlueprintGym(undefined)).toBe(GYM_JUDGE_RUBRIC_V1);
    const noRubric: BlueprintGym = { collectTrace: 'work-item-output', signals: [] };
    expect(rubricFromBlueprintGym(noRubric)).toBe(GYM_JUDGE_RUBRIC_V1);
  });

  it('fills missing fields from V1 when the target declares a PARTIAL rubric (only weights)', () => {
    const gym: BlueprintGym = {
      collectTrace: 'git-diff',
      signals: [],
      rubric: { version: 'v1', weights: { d1: 0.6, d2: 0.2, d3: 0.2 } },
    };
    const r = rubricFromBlueprintGym(gym);
    expect(r.weights).toEqual({ d1: 0.6, d2: 0.2, d3: 0.2 });
    // dimensions + model + thinking budget fall back to V1
    expect(r.dimensions).toEqual(GYM_JUDGE_RUBRIC_V1.dimensions);
    expect(r.model).toBe(GYM_JUDGE_RUBRIC_V1.model);
    expect(r.thinkingBudgetTokens).toBe(GYM_JUDGE_RUBRIC_V1.thinkingBudgetTokens);
  });

  it('honors a fully-specified target rubric (overrides V1)', () => {
    const gym: BlueprintGym = {
      collectTrace: 'work-item-output',
      signals: [],
      rubric: {
        version: 'r2',
        model: 'claude-sonnet-4-6',
        temperature: 0.3,
        thinkingBudgetTokens: 8000,
        weights: { d1: 0.4, d2: 0.3, d3: 0.3 },
        dimensions: { d1: 'finding quality', d2: 'source rigor', d3: 'synthesis' },
      },
    };
    const r = rubricFromBlueprintGym(gym);
    expect(r).toEqual({
      version: 'r2',
      model: 'claude-sonnet-4-6',
      temperature: 0.3,
      thinkingBudgetTokens: 8000,
      weights: { d1: 0.4, d2: 0.3, d3: 0.3 },
      dimensions: { d1: 'finding quality', d2: 'source rigor', d3: 'synthesis' },
    });
  });

  it('the mapped rubric is shaped so composite/rubricHash accept it', () => {
    const gym: BlueprintGym = { collectTrace: 'git-diff', signals: [], rubric: { version: 'v1', weights: { d1: 1, d2: 0, d3: 0 } } };
    const r = rubricFromBlueprintGym(gym);
    // weights present + summable, dimensions present — the judge-scoring cores need these.
    expect(r.weights.d1 + r.weights.d2 + r.weights.d3).toBeGreaterThan(0);
    expect(r.dimensions.d1.length).toBeGreaterThan(0);
  });
});

describe('resolveGymChildBlueprint (D-008 — the $target binding)', () => {
  it('binds the gym blueprint\'s declared $target to the blueprint under optimization', async () => {
    const { resolveGymChildBlueprint } = await import('../primitives');
    const gymBp = { id: 'gym', recursion: { childBlueprint: '$target' } };
    expect(resolveGymChildBlueprint(gymBp, 'coding')).toBe('coding');
    expect(resolveGymChildBlueprint(gymBp, 'research')).toBe('research');
  });

  it('fails closed when the target is missing (no silent self-fallback)', async () => {
    const { resolveGymChildBlueprint } = await import('../primitives');
    const gymBp = { id: 'gym', recursion: { childBlueprint: '$target' } };
    expect(() => resolveGymChildBlueprint(gymBp, '')).toThrow(/bound no "target" param/);
  });
});
