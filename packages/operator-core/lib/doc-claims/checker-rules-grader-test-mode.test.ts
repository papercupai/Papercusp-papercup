/**
 * verification-system-improvements-2026-10-10 P-009 — the grader and test-mode personas
 * carry the four CHECKER RULES, as the prompt assembler actually renders them.
 *
 * Clauses pinned here:
 *   - AUTO-BAR-R-9-P-009: the grader and test-mode prompts, as assembled by prompt
 *     assembly, each contain all four checker rules.
 *   - SPEC-P-009-CHECKER-RULES: this test fails when a rule is missing from the grader
 *     (GRADE mode, su.mode-grade) prompt as assembled.
 *   - SPEC-P-009-TEST-MODE-RULES: this test fails when a rule is missing from the TEST mode
 *     (su.mode-test) prompt as assembled.
 *
 * "As assembled" means the real su stack composer, `composeSuStackSource`, which
 * `role-launch-spec.ts` calls to render an su launch. Reading the .md files directly would
 * pass even if the mode layer stopped binding, so every assertion runs on composed text.
 * Attribution: each rule must be ABSENT from the same stack composed without the mode, so a
 * rule that leaks in from the kernel or another layer cannot satisfy the clause.
 *
 * Controls (the "module you import" tier of CLAUDE.md's falsifiability rule): for every
 * rule, the detector is fed the real composed text with that one rule removed and must
 * report exactly that rule. A green run therefore still says something.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { composeSuStackSource, suSessionBinding } from '@papercusp/orchestrator/blueprint';
import { ROOT } from './corpus-subject';

const HARNESS_DIR = join(ROOT, 'libs', 'papercusp', 'packages', 'harness');

/** The four checker rules. `marker` is the rule's stable lead phrase in both documents. */
export const CHECKER_RULES = [
  { id: 'claims-are-leads', marker: 'CLAIMS ARE LEADS' },
  { id: 'real-surface', marker: 'RE-RUN THROUGH THE REAL SURFACE' },
  { id: 'never-edit-checks', marker: 'NEVER EDIT TESTS, FIXTURES, GUARDS OR VERIFIERS TO PASS' },
  { id: 'hunt-stubs', marker: 'HUNT FOR STUBBED, HARDCODED OR TEST-ONLY BEHAVIOUR' },
] as const;

/** Ids of the checker rules whose marker does not appear in `text`. */
export function missingCheckerRules(text: string): string[] {
  return CHECKER_RULES.filter((rule) => !text.includes(rule.marker)).map((rule) => rule.id);
}

function compose(modes: string[]): string {
  return composeSuStackSource({ harnessDir: HARNESS_DIR, binding: suSessionBinding({ modes }) }).text;
}

const PERSONAS = [
  // GRADE implies AUTO, so the registry always writes both; the baseline keeps AUTO.
  { name: 'grader (GRADE mode)', spec: 'SPEC-P-009-CHECKER-RULES', modes: ['grade', 'auto'], baseline: ['auto'], heading: '## GRADE mode — binding contract' },
  { name: 'test-mode (TEST mode)', spec: 'SPEC-P-009-TEST-MODE-RULES', modes: ['test'], baseline: [], heading: '## TEST mode — binding contract' },
] as const;

describe('P-009 checker rules in the assembled grader and test-mode prompts', () => {
  it('pins exactly four checker rules (population guard)', () => {
    expect(CHECKER_RULES).toHaveLength(4);
    expect(new Set(CHECKER_RULES.map((rule) => rule.marker)).size).toBe(4);
  });

  for (const persona of PERSONAS) {
    describe(persona.name, () => {
      const assembled = compose([...persona.modes]);
      const baseline = compose([...persona.baseline]);

      it(`${persona.spec} / AUTO-BAR-R-9-P-009: the assembled prompt binds the mode and carries all four rules`, () => {
        expect(assembled).toContain(persona.heading);
        expect(missingCheckerRules(assembled)).toEqual([]);
      });

      it('every rule comes from the mode layer, not from the rest of the stack', () => {
        expect(baseline).not.toContain(persona.heading);
        expect(missingCheckerRules(baseline)).toEqual(CHECKER_RULES.map((rule) => rule.id));
      });

      it('control: removing any one rule from the assembled text is reported', () => {
        for (const rule of CHECKER_RULES) {
          const stripped = assembled.split(rule.marker).join('');
          expect(stripped).not.toBe(assembled);
          expect(missingCheckerRules(stripped)).toEqual([rule.id]);
        }
      });
    });
  }
});
