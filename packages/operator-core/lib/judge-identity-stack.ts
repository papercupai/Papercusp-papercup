/**
 * Identity bindings for the non-su judge missions.
 *
 * Every judge wears the same domain identity and exactly one mission practice.
 * Keeping the refs here prevents launcher callers from silently drifting into
 * an unbound role or composing two mutually exclusive practices.
 */
export const JUDGE_DOMAIN_STACK_REF = 'domain:judge-domain' as const;

export const ACCEPTANCE_JUDGE_STACK = [
  JUDGE_DOMAIN_STACK_REF,
  'practice:judge-acceptance',
] as const;

export const GRADING_INTEGRITY_JUDGE_STACK = [
  JUDGE_DOMAIN_STACK_REF,
  'practice:judge-grading-integrity',
] as const;

export const GYM_JUDGE_STACK = [
  JUDGE_DOMAIN_STACK_REF,
  'practice:judge-gym',
] as const;

export const ENSEMBLE_JUDGE_STACK = [
  JUDGE_DOMAIN_STACK_REF,
  'practice:judge-ensemble',
] as const;

export type JudgeMission = 'acceptance' | 'grading-integrity' | 'gym' | 'ensemble';

export function judgeStackForMission(mission: JudgeMission): readonly string[] {
  switch (mission) {
    case 'acceptance': return ACCEPTANCE_JUDGE_STACK;
    case 'grading-integrity': return GRADING_INTEGRITY_JUDGE_STACK;
    case 'gym': return GYM_JUDGE_STACK;
    case 'ensemble': return ENSEMBLE_JUDGE_STACK;
  }
}

/** Structural guard used by launch tests and callers that accept a stack input. */
export function isJudgeMissionStack(stack: readonly string[]): boolean {
  return stack.length === 2 && stack[0] === JUDGE_DOMAIN_STACK_REF && stack[1]?.startsWith('practice:judge-');
}
