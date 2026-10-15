import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { evaluateSubjectCases, HELD_OUT_SUBJECT_CASES } from './subject-evidence.fixtures';

const perfect = (): { id: string; scores: (number | null)[] }[] => HELD_OUT_SUBJECT_CASES.map(c => ({ id: c.id,
  scores: c.passages.map(p => (c.relevant as readonly string[]).includes(p.id) ? 0.9 : 0.1) as (number | null)[] }));

describe('held-out subject measurement integrity', () => {
  it('preserves the preregistered labels and passages across measurement helper changes', () => {
    // Population declared in 64e6e8cf14 and independently validated before scoring.
    // Hash the cases alone: adding a metric must not silently relabel the holdout.
    expect(createHash('sha256').update(JSON.stringify(HELD_OUT_SUBJECT_CASES)).digest('hex'))
      .toBe('137246c6e7f15da78bcda87dd5e3db5395f57cee1b2ea1da720ab3075320d2eb');
  });

  it('keeps no-expert cases separate from the positive recall denominator', () => {
    const results = perfect();
    results[0].scores = [0.6, 0.9];
    results[1].scores = [0.8, 0.1];
    const { summary } = evaluateSubjectCases(results, 0.5);
    expect(summary).toEqual({ population: 5, positiveCases: 3, noExpertCases: 2,
      topChoicePrecision: 2 / 3, recallAt1: 2 / 3, selectionPrecision: 3 / 5,
      falseExpertSelections: 2, falseExpertCases: 1, unavailable: 0 });
  });

  it('detects irrelevant retained alternatives even when the top choice and recall are perfect', () => {
    const results = perfect();
    results[3].scores = [0.9, 0.6];
    const { summary, cases } = evaluateSubjectCases(results, 0.5);
    expect(cases[3].selected).toEqual(['schema-author', 'model-worker']);
    expect(summary.topChoicePrecision).toBe(1);
    expect(summary.recallAt1).toBe(1);
    expect(summary.selectionPrecision).toBe(3 / 4);
    expect(summary.falseExpertSelections).toBe(1);
    expect(summary.falseExpertCases).toBe(0);
  });

  it('refuses omitted, duplicate and undeclared cases instead of shrinking the population', () => {
    expect(() => evaluateSubjectCases(perfect().slice(0, -1), 0.5)).toThrow('population-mismatch');
    const duplicate = perfect();
    duplicate[4] = duplicate[0];
    expect(() => evaluateSubjectCases(duplicate, 0.5)).toThrow('population-mismatch');
    const unknown = perfect();
    unknown[4] = { ...unknown[4], id: 'undeclared' };
    expect(() => evaluateSubjectCases(unknown, 0.5)).toThrow('population-mismatch');
  });

  it('preserves unavailable and invalid measurements as null metrics', () => {
    const results = perfect();
    results[0].scores = [null, NaN];
    const { summary } = evaluateSubjectCases(results, 0.5);
    expect(summary.unavailable).toBe(2);
    expect(summary.topChoicePrecision).toBeNull();
    expect(summary.recallAt1).toBeNull();
    expect(summary.selectionPrecision).toBeNull();
    results[0].scores = [2, -0.1];
    expect(evaluateSubjectCases(results, 0.5).summary.unavailable).toBe(2);
    results[0].scores = [];
    expect(() => evaluateSubjectCases(results, 0.5)).toThrow('score-shape');
  });
});
