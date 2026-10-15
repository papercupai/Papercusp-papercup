/**
 * Spec-conformance contract — the execution-time half of a plan's spec.
 *
 * A plan's `## Requirements` blocks already carry the DONE-WHEN check
 * (`verification.check`). This module parses the companion `## Conformance`
 * section: one fenced `conformance` JSON block holding
 *
 *   - `footprint.paths`  — repo-relative path globs the plan owns (R-5), and
 *   - `requirements[R-N]` — per requirement, `violatedWhen` falsifiers (each a
 *     runnable check, or a declared `pendingBinding` when the interface it would
 *     observe does not exist yet) and an optional `unenforced { reason,
 *     approvalRef }` declaration.
 *
 * Falsifiers deliberately live OUTSIDE the requirement block, so adding one never
 * changes the BAR hash and never forces an acceptance-rubric amendment.
 *
 * `evaluateRequirementEnforcement` joins both halves into one per-requirement
 * verdict. It is pure (plan text in, report out) so the activation gate, the
 * conformance run and the retro-fit report all read the same answer.
 *
 * Plan: spec-conformance-loop-2026-10-14 (P-017, R-1).
 */
import { z } from 'zod';
import { rubricCriterionCheckSchema, type RubricCriterionCheck } from '../agent-tools/plans/rubric-template';
import { splitPlanSections } from '../agent-tools/plans/plan-sections';
import { parseRequirementBars } from '../acceptance-bar-seed';
import { isExplicitlyManualCheck } from '../acceptance-bar-contract-completeness';

export const CONFORMANCE_SECTION_HEADING = 'Conformance';
export const CONFORMANCE_FENCE = 'conformance';
export const MAX_FALSIFIERS_PER_REQUIREMENT = 20;
export const MAX_FOOTPRINT_PATHS = 200;

/** Where in the delivery lifecycle a falsifier observes the violation. */
export const FALSIFIER_STAGES = ['implementation', 'integration', 'delivery', 'operation'] as const;
export type FalsifierStage = (typeof FALSIFIER_STAGES)[number];

const REQUIREMENT_KEY = /^R-\d+$/;
const FALSIFIER_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const DECISION_REF = /^D-\d{3,}$/;
const SESSION_TURN_REF = /^session_turn:[a-z_]+:[^:\s]+:\d+$/;

const pendingBindingSchema = z
  .object({
    observation: z.string().trim().min(1).max(2000)
      .describe('what the falsifier will observe once its interface exists'),
    bindWhen: z.string().trim().min(1).max(1000)
      .describe('the event (usually a plan item landing) after which a runnable check must replace this'),
  })
  .strict();

export const falsifierSchema = z
  .object({
    id: z.string().regex(FALSIFIER_ID, 'falsifier id must be lower-kebab-case (≤80 chars)'),
    failureMode: z.string().trim().min(1).max(1000),
    stage: z.enum(FALSIFIER_STAGES),
    check: rubricCriterionCheckSchema.optional(),
    pendingBinding: pendingBindingSchema.optional(),
  })
  .strict()
  .superRefine((falsifier, ctx) => {
    const hasCheck = falsifier.check !== undefined;
    const hasPending = falsifier.pendingBinding !== undefined;
    if (hasCheck === hasPending) {
      ctx.addIssue({
        code: 'custom',
        path: hasCheck ? ['pendingBinding'] : ['check'],
        message: 'a falsifier carries exactly one of `check` (runnable now) or `pendingBinding` (interface not built yet)',
      });
    }
    if (falsifier.check && isExplicitlyManualCheck(falsifier.check)) {
      ctx.addIssue({
        code: 'custom',
        path: ['check', 'instrumentKey'],
        message:
          "a falsifier check cannot be manual (instrumentKey:'none'); author it as `pendingBinding` until a runnable check exists",
      });
    }
  });

export const unenforcedSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000),
    approvalRef: z.string().trim().min(1).max(300)
      .describe("a D-NNN Decision of this plan, or a canonical session_turn:<kind>:<session>:<turn> owner turn"),
  })
  .strict();

export const requirementConformanceSchema = z
  .object({
    violatedWhen: z.array(falsifierSchema).max(MAX_FALSIFIERS_PER_REQUIREMENT).optional(),
    unenforced: unenforcedSchema.optional(),
  })
  .strict();

export const conformanceContractSchema = z
  .object({
    footprint: z
      .object({ paths: z.array(z.string().trim().min(1).max(500)).max(MAX_FOOTPRINT_PATHS) })
      .strict()
      .optional(),
    requirements: z
      .record(z.string().regex(REQUIREMENT_KEY, 'requirement keys are R-N'), requirementConformanceSchema)
      .optional(),
  })
  .strict();

export type Falsifier = z.infer<typeof falsifierSchema>;
export type UnenforcedDeclaration = z.infer<typeof unenforcedSchema>;
export type RequirementConformance = z.infer<typeof requirementConformanceSchema>;
export type ConformanceContract = z.infer<typeof conformanceContractSchema>;

export type ConformanceProblemCode =
  | 'conformance_contract_invalid'
  | 'conformance_requirement_unknown'
  | 'conformance_falsifier_duplicate'
  | 'conformance_unenforced_unapproved'
  | 'conformance_requirement_unenforced';

export interface ConformanceProblem {
  code: ConformanceProblemCode;
  detail: string;
  barKey?: string;
}

export type ConformanceContractParse =
  | { ok: true; present: boolean; contract: ConformanceContract }
  | { ok: false; problems: ConformanceProblem[] };

function sectionBody(planContent: string, heading: string): string | null {
  return (
    splitPlanSections(planContent).find(
      (section) => section.heading.trim().toLowerCase() === heading.toLowerCase(),
    )?.body ?? null
  );
}

/**
 * Parse the `## Conformance` section. An absent section is an EMPTY contract
 * (`present:false`), not an error: a plan whose every requirement already has an
 * executable done-when check needs no falsifiers. A present section must hold
 * exactly one well-formed `conformance` fence — a malformed contract is refused,
 * never partially read, because a partial read would silently shrink enforcement.
 */
export function parseConformanceContract(planContent: string): ConformanceContractParse {
  const body = sectionBody(planContent, CONFORMANCE_SECTION_HEADING);
  if (body === null) return { ok: true, present: false, contract: {} };
  const fences = [...body.matchAll(/```([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)\n```/g)];
  const conformanceFences = fences.filter((match) => match[1] === CONFORMANCE_FENCE);
  if (conformanceFences.length !== 1) {
    return {
      ok: false,
      problems: [{
        code: 'conformance_contract_invalid',
        detail:
          `## Conformance must hold exactly one \`\`\`${CONFORMANCE_FENCE} JSON block; found ${conformanceFences.length}`,
      }],
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(conformanceFences[0]![2]!);
  } catch (error) {
    return {
      ok: false,
      problems: [{
        code: 'conformance_contract_invalid',
        detail: `## Conformance block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }
  const parsed = conformanceContractSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => ({
        code: 'conformance_contract_invalid' as const,
        detail: `## Conformance ${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`,
        ...(typeof issue.path[1] === 'string' && issue.path[0] === 'requirements'
          ? { barKey: issue.path[1] }
          : {}),
      })),
    };
  }
  return { ok: true, present: true, contract: parsed.data };
}

/** D-NNN ids declared under `## Decisions` as `### D-NNN — title` heads. */
export function planDecisionIds(planContent: string): Set<string> {
  const body = sectionBody(planContent, 'Decisions') ?? '';
  return new Set([...body.matchAll(/^###\s+(D-\d{3,})\b/gm)].map((match) => match[1]!));
}

export type DoneWhenStatus = 'executable' | 'manual' | 'absent';
export type EnforcementStatus =
  /** the requirement block's done-when check is runnable */
  | 'executable'
  /** no runnable done-when check, but ≥1 falsifier (runnable or pendingBinding) */
  | 'falsified'
  /** neither, but an approved `unenforced` declaration — loud, counted, allowed */
  | 'declared-unenforced'
  /** neither, and no approved declaration — refused at activation */
  | 'unenforced';

export interface RequirementEnforcement {
  barKey: string;
  title: string;
  doneWhen: DoneWhenStatus;
  doneWhenCheck: RubricCriterionCheck | null;
  falsifiers: { bound: Falsifier[]; pending: Falsifier[] };
  unenforced: UnenforcedDeclaration | null;
  status: EnforcementStatus;
}

export interface EnforcementReport {
  /** false when the plan has no parseable `## Requirements` (nothing to enforce). */
  applicable: boolean;
  contractPresent: boolean;
  footprint: string[];
  requirements: RequirementEnforcement[];
  problems: ConformanceProblem[];
  counts: Record<EnforcementStatus, number> & { pendingFalsifiers: number; boundFalsifiers: number };
}

function emptyCounts(): EnforcementReport['counts'] {
  return { executable: 0, falsified: 0, 'declared-unenforced': 0, unenforced: 0, pendingFalsifiers: 0, boundFalsifiers: 0 };
}

function doneWhenOf(check: RubricCriterionCheck | null): DoneWhenStatus {
  if (!check) return 'absent';
  return isExplicitlyManualCheck(check) ? 'manual' : 'executable';
}

/**
 * Join the requirement blocks with the conformance contract into one verdict per
 * requirement. Unparseable `## Requirements` is NOT this module's refusal to make —
 * the BAR seed already refuses it with a precise diagnostic — so the report is
 * simply `applicable:false` there and carries no problems of its own.
 */
export function evaluateRequirementEnforcement(planContent: string): EnforcementReport {
  const bars = parseRequirementBars(planContent);
  const contractParse = parseConformanceContract(planContent);
  const contract = contractParse.ok ? contractParse.contract : {};
  const report: EnforcementReport = {
    applicable: bars.ok,
    contractPresent: contractParse.ok ? contractParse.present : true,
    footprint: contract.footprint?.paths ?? [],
    requirements: [],
    problems: contractParse.ok ? [] : [...contractParse.problems],
    counts: emptyCounts(),
  };
  if (!bars.ok) return report;

  const known = new Set(bars.bars.map((bar) => bar.barKey));
  const decisions = planDecisionIds(planContent);
  const declared = contract.requirements ?? {};

  for (const key of Object.keys(declared)) {
    if (!known.has(key)) {
      report.problems.push({
        code: 'conformance_requirement_unknown',
        barKey: key,
        detail: `## Conformance names ${key}, which is not a requirement in ## Requirements`,
      });
    }
  }

  for (const bar of bars.bars) {
    const entry = declared[bar.barKey];
    // normalizeAcceptanceBarCriterion lifts the requirement block's
    // verification.check onto the criterion's top-level `check`.
    const doneWhenCheck = (bar.criterion?.check as RubricCriterionCheck | undefined) ?? null;
    const doneWhen = doneWhenOf(doneWhenCheck);
    const falsifiers = entry?.violatedWhen ?? [];
    const seenIds = new Set<string>();
    for (const falsifier of falsifiers) {
      if (seenIds.has(falsifier.id)) {
        report.problems.push({
          code: 'conformance_falsifier_duplicate',
          barKey: bar.barKey,
          detail: `${bar.barKey} declares falsifier id '${falsifier.id}' more than once`,
        });
      }
      seenIds.add(falsifier.id);
    }
    const bound = falsifiers.filter((falsifier) => falsifier.check !== undefined);
    const pending = falsifiers.filter((falsifier) => falsifier.pendingBinding !== undefined);

    let unenforced: UnenforcedDeclaration | null = entry?.unenforced ?? null;
    if (unenforced) {
      const ref = unenforced.approvalRef;
      const approved = DECISION_REF.test(ref) ? decisions.has(ref) : SESSION_TURN_REF.test(ref);
      if (!approved) {
        report.problems.push({
          code: 'conformance_unenforced_unapproved',
          barKey: bar.barKey,
          detail:
            `${bar.barKey} unenforced.approvalRef '${ref}' is neither a D-NNN under ## Decisions nor a ` +
            'canonical session_turn:<kind>:<session>:<turn> reference',
        });
        unenforced = null;
      }
    }

    const status: EnforcementStatus =
      doneWhen === 'executable'
        ? 'executable'
        : falsifiers.length > 0
          ? 'falsified'
          : unenforced
            ? 'declared-unenforced'
            : 'unenforced';
    if (status === 'unenforced') {
      report.problems.push({
        code: 'conformance_requirement_unenforced',
        barKey: bar.barKey,
        detail:
          `${bar.barKey} has no executable done-when check (${doneWhen === 'manual' ? "instrumentKey:'none'" : 'no verification.check'}), ` +
          'no violatedWhen falsifier and no approved unenforced declaration. Repair ONE of: give the requirement block a ' +
          "runnable verification.check (tests/cargo/probe/instrument); add a `violatedWhen` falsifier under ## Conformance " +
          '(a runnable check, or `pendingBinding { observation, bindWhen }` when its interface is not built yet); or declare ' +
          '`unenforced { reason, approvalRef }` citing an approving D-NNN or owner session_turn.',
      });
    }

    report.counts[status] += 1;
    report.counts.boundFalsifiers += bound.length;
    report.counts.pendingFalsifiers += pending.length;
    report.requirements.push({
      barKey: bar.barKey,
      title: bar.title,
      doneWhen,
      doneWhenCheck,
      falsifiers: { bound, pending },
      unenforced,
      status,
    });
  }
  return report;
}
