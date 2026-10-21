import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_JUDGE_STACK,
  ENSEMBLE_JUDGE_STACK,
  GRADING_INTEGRITY_JUDGE_STACK,
  GYM_JUDGE_STACK,
  isJudgeMissionStack,
  judgeStackForMission,
} from './judge-identity-stack';

describe('judge identity stacks (R-3)', () => {
  it('binds every mission to one shared domain and one mission practice', () => {
    const stacks = [
      ACCEPTANCE_JUDGE_STACK,
      GRADING_INTEGRITY_JUDGE_STACK,
      GYM_JUDGE_STACK,
      ENSEMBLE_JUDGE_STACK,
    ];
    for (const stack of stacks) {
      expect(stack).toHaveLength(2);
      expect(stack[0]).toBe('domain:judge-domain');
      expect(stack[1]).toMatch(/^practice:judge-/);
      expect(isJudgeMissionStack(stack)).toBe(true);
    }
  });

  it('returns the mission-specific practice without sharing mutable arrays', () => {
    expect(judgeStackForMission('acceptance')).toEqual(ACCEPTANCE_JUDGE_STACK);
    expect(judgeStackForMission('grading-integrity')).toEqual(GRADING_INTEGRITY_JUDGE_STACK);
    expect(judgeStackForMission('gym')).toEqual(GYM_JUDGE_STACK);
    expect(judgeStackForMission('ensemble')).toEqual(ENSEMBLE_JUDGE_STACK);
  });

  it('rejects stacks that omit the domain or compose multiple practices', () => {
    expect(isJudgeMissionStack(['practice:judge-acceptance'])).toBe(false);
    expect(isJudgeMissionStack(['domain:judge-domain', 'practice:judge-acceptance', 'practice:judge-gym'])).toBe(false);
    expect(isJudgeMissionStack(['domain:other', 'practice:judge-acceptance'])).toBe(false);
  });
});
