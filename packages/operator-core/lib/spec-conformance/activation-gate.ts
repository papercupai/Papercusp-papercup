/**
 * Activation gate for the spec-conformance loop (R-1).
 *
 * `plans:audit { phase:'activation' }` calls this before recording anything. A
 * requirement that compiles to no executable check — no runnable done-when check,
 * no `violatedWhen` falsifier, no approved `unenforced` declaration — is refused
 * with `conformance_requirement_unenforced`, and a malformed `## Conformance`
 * contract is refused rather than partially read.
 *
 * Plan: spec-conformance-loop-2026-10-14 (P-017).
 */
import {
  evaluateRequirementEnforcement,
  type ConformanceProblem,
  type ConformanceProblemCode,
  type EnforcementReport,
} from './conformance-contract';

/** Refusal precedence: a broken contract is reported before what it would have enforced. */
const CODE_PRECEDENCE: readonly ConformanceProblemCode[] = [
  'conformance_contract_invalid',
  'conformance_requirement_unknown',
  'conformance_falsifier_duplicate',
  'conformance_unenforced_unapproved',
  'conformance_requirement_unenforced',
];

export interface ConformanceActivationVerdict {
  ok: boolean;
  /** The refusal code — the highest-precedence problem's code. */
  error: ConformanceProblemCode | null;
  problems: ConformanceProblem[];
  report: EnforcementReport;
  message: string | null;
}

export function conformanceActivationVerdict(planContent: string): ConformanceActivationVerdict {
  const report = evaluateRequirementEnforcement(planContent);
  const problems = [...report.problems].sort(
    (a, b) => CODE_PRECEDENCE.indexOf(a.code) - CODE_PRECEDENCE.indexOf(b.code),
  );
  if (problems.length === 0) {
    return { ok: true, error: null, problems: [], report, message: null };
  }
  const error = problems[0]!.code;
  const unenforced = problems.filter((p) => p.code === 'conformance_requirement_unenforced').map((p) => p.barKey);
  return {
    ok: false,
    error,
    problems,
    report,
    message:
      `${problems.length} spec-conformance problem(s); nothing was recorded. ` +
      (unenforced.length
        ? `Unenforced requirement(s): ${unenforced.join(', ')} — each needs a runnable done-when check, a ` +
          '`violatedWhen` falsifier under ## Conformance, or an approved `unenforced` declaration. '
        : '') +
      'See problems[] for the exact repair per requirement.',
  };
}
