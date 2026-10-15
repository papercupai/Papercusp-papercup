/**
 * CLAUDE.md's acceptance-grader ROUTING claim must stay true of
 * `grader-eligibility.ts` (EI-22069073859022357).
 *
 * THE INCIDENT. CLAUDE.md told a rubric author to get an independent grader by
 * "launch one, or hand the plan off". But `grader-eligibility.ts` resolves the
 * rubric's `createdBy` as the implementer and refuses any caller in that
 * author's spawn/rebind lineage (`grader_in_implementer_lineage`) — so a grader
 * the AUTHOR launches is ineligible BY CONSTRUCTION, and the rubric author is
 * normally the one who needs a grader. The guidance was not merely incomplete;
 * it was confidently wrong in its main case, and phrased as an
 * anti-stopping-short obligation, so it actively pushed agents to spend a whole
 * headless launch + boot + grading pass on an unemittable result. Measured
 * 2026-09-01 shipping `autonomous-inbox-resolution-2026-08-31`: one launched
 * grader refused at emit; two peers NOT in the author's lineage graded fine.
 *
 * WHY A PIN AND NOT JUST A PROSE FIX. The tool's own refusal text already said
 * "never launch a grader from this lineage" while CLAUDE.md said to launch one
 * — prose describing code, hand-maintained, drifted from the code it described.
 * That is the derived-truth-ladder failure this repo names explicitly, so
 * repairing the sentence without pinning it leaves the same trap armed. This
 * guard fails if EITHER side moves: the code stops enforcing lineage, or the
 * prose goes back to recommending a launch.
 *
 * FIXTURE CONTROLS are load-bearing, same discipline as the siblings
 * (`gate-candidate-ref.test.ts`, `acceptance-grading-prose.test.ts`): once the
 * live assertions go green they stop being evidence that the detector works, so
 * each rule keeps a permanent control reproducing the shape it must catch —
 * including the exact pre-fix belief.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './corpus-subject';

const ELIGIBILITY_RELPATH =
  'packages/operator-core/lib/agent-tools/scorecards/grader-eligibility.ts';
const CLAUDE_MD_RELPATH = 'CLAUDE.md';

const read = (relpath: string): string => readFileSync(join(ROOT, relpath), 'utf8');

/**
 * Does the eligibility source still REFUSE a caller in the rubric author's
 * lineage? Judged on the refusal code plus an actual lineage predicate, so
 * deleting the check (or downgrading it to implementer-only) is caught.
 */
export function judgeLineageEnforced(source: string): string[] {
  const violations: string[] = [];
  if (!source.includes('grader_in_implementer_lineage')) {
    violations.push(
      'grader-eligibility.ts no longer emits `grader_in_implementer_lineage` — ' +
        "CLAUDE.md's route-don't-launch rule rests on that refusal existing.",
    );
  }
  if (!/lineageRelated|areAcceptanceLineageRelated/.test(source)) {
    violations.push(
      'grader-eligibility.ts no longer consults a lineage predicate — if only ' +
        'implementer-identity is checked, a LAUNCHED grader becomes eligible and ' +
        "CLAUDE.md's \"never by LAUNCHING one\" is wrong.",
    );
  }
  return violations;
}

/**
 * Does the agent-facing prose still route rather than recommend a launch?
 * The pre-fix sentence is the control shape.
 */
export function judgeRoutingProse(prose: string): string[] {
  const violations: string[] = [];
  if (/grade it: launch one/i.test(prose)) {
    violations.push(
      'the pre-fix sentence "grade it: launch one" is back — a grader the rubric ' +
        'author launches is refused as grader_in_implementer_lineage.',
    );
  }
  if (!/never by LAUNCHING one/i.test(prose)) {
    violations.push(
      'the acceptance section no longer states that an independent grader is ' +
        'ROUTED TO rather than LAUNCHED.',
    );
  }
  if (!/spawn\/rebind lineage/i.test(prose)) {
    violations.push(
      'the acceptance section no longer names the spawn/rebind lineage constraint, ' +
        'which is the reason launching cannot work.',
    );
  }
  return violations;
}

describe('CLAUDE.md acceptance-grader routing claim', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches an eligibility source with the lineage refusal deleted', () => {
      const violations = judgeLineageEnforced(`
        const callerIsImplementer = await sameAcceptanceAuthor(implementer, callerId);
        if (callerIsImplementer) return { refusal: { code: 'grader_is_implementer' } };
        return { refusal: null };
      `);
      expect(violations).not.toHaveLength(0);
      expect(violations.join('\n')).toMatch(/grader_in_implementer_lineage/);
    });

    it('catches lineage downgraded to implementer-identity only', () => {
      const violations = judgeLineageEnforced(`
        const code = 'grader_in_implementer_lineage';
        const callerIsImplementer = await sameAcceptanceAuthor(implementer, callerId);
      `);
      expect(violations.join('\n')).toMatch(/no longer consults a lineage predicate/);
    });

    it('catches the exact pre-fix CLAUDE.md sentence — the EI-22069073859022357 belief', () => {
      const violations = judgeRoutingProse(
        'The independent-grader rule means you must GET a non-implementer to ' +
          'grade it: launch one, or hand the plan off with `coord:handoff`.',
      );
      expect(violations.join('\n')).toMatch(/pre-fix sentence/);
    });

    it('catches prose that drops the routing rule entirely', () => {
      expect(judgeRoutingProse('Have a non-implementer grade it.')).not.toHaveLength(0);
    });

    it('passes prose that routes instead of launching', () => {
      const ok =
        'you must GET a non-implementer to grade it — by ROUTING to one, never by ' +
        'LAUNCHING one, because a session in the author’s spawn/rebind lineage is refused.';
      expect(judgeRoutingProse(ok)).toHaveLength(0);
    });
  });

  describe('the live claim', () => {
    it('grader-eligibility.ts still refuses a grader in the author lineage', () => {
      expect(judgeLineageEnforced(read(ELIGIBILITY_RELPATH))).toEqual([]);
    });

    it('CLAUDE.md routes to an out-of-lineage grader rather than launching one', () => {
      expect(judgeRoutingProse(read(CLAUDE_MD_RELPATH))).toEqual([]);
    });
  });
});

const BASE_JUDGE_PROMPT_RELPATH = 'libs/papercusp/packages/harness/blueprints/base/prompts/judge.md';
const GYM_JUDGE_PROMPT_RELPATH = 'libs/papercusp/packages/harness/blueprints/gym/prompts/judge.md';

/** Keep acceptance grading on the generic evaluator persona, with gym scoring scoped to gym. */
export function judgePersonaSplitViolations(basePrompt: string, gymPrompt: string): string[] {
  const violations: string[] = [];
  const gymOnlyTerms = /gym:judge|blueprint\.gym\.rubric|variant-runner/;

  if (!/independent evaluator/i.test(basePrompt) || !/acceptance grading/i.test(basePrompt)) {
    violations.push('the shared base judge prompt no longer describes the generic acceptance evaluator.');
  }
  if (gymOnlyTerms.test(basePrompt)) {
    violations.push('gym-only scoring instructions have leaked back into the shared base judge prompt.');
  }
  if (!gymOnlyTerms.test(gymPrompt)) {
    violations.push('the gym-specific judge prompt no longer owns its gym scoring instructions.');
  }

  return violations;
}

describe('acceptance judge persona separation', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches the pre-fix gym persona restored into the shared base prompt', () => {
      const preFixGymPersona =
        'You are the judge for the gym blueprint. Score runs from variant-runner using ' +
        'blueprint.gym.rubric and call gym:judge.';
      const violations = judgePersonaSplitViolations(
        preFixGymPersona,
        'gym:judge blueprint.gym.rubric variant-runner',
      );

      expect(violations).not.toHaveLength(0);
      expect(violations.join('\n')).toMatch(/leaked back into the shared base judge prompt/);
    });

    it('catches gym scoring instructions missing from the gym-specific prompt', () => {
      const violations = judgePersonaSplitViolations(
        'You are an independent evaluator for acceptance grading. Follow your kickoff brief.',
        'You are a generic independent evaluator.',
      );

      expect(violations.join('\n')).toMatch(/gym-specific judge prompt no longer owns/);
    });
  });

  describe('the live prompts', () => {
    it('keeps acceptance grading generic and the gym scoring persona under gym', () => {
      expect(
        judgePersonaSplitViolations(
          read(BASE_JUDGE_PROMPT_RELPATH),
          read(GYM_JUDGE_PROMPT_RELPATH),
        ),
      ).toEqual([]);
    });
  });
});
