/** P-029: requirement-labelled closure reuses the BAR map and conformance ledger. */
import { parseBarMappings } from '../acceptance-bar-seed';
import { trackPhase, type PhaseTracker } from '@papercusp/tooldef';
import { readPlanBySlug } from '../agent-tools/plans/source';
import { readLatestRubricCheckResults } from '../check-results-ledger';
import { evaluateRequirementEnforcement, type RequirementEnforcement } from './conformance-contract';
import { conformanceLedgerRef, doneWhenCheckId, type ConformanceCheckVerdict, type OpenDriftAlarm } from './conformance-run';
import { productionConformanceDeps } from './conformance-run-deps';
import { approvedDeviations } from './deviation';
import type { WorkItem } from '../work-items';

export interface RequirementClosureDeclaration {
  discharges?: readonly string[];
  contributesTo?: readonly string[];
}
export interface ConformanceClosureRefusal {
  code: 'conformance_contract_invalid' | 'conformance_mapping_unavailable' |
    'conformance_requirements_missing' | 'conformance_requirement_unmapped' |
    'conformance_drift_alarm_open' | 'conformance_done_when_not_passing' | 'frozen_tests_completion_refused';
  error: string;
  /** The RefusalContract lift condition: what must become true for this close to pass. */
  liftsWhen?: string;
  requirements?: string[];
  alarmIds?: string[];
}
export interface ConformanceClosureAssessment {
  /** Whether this plan item has mapped requirements governed by the conformance contract. */
  applicable: boolean;
  /** Requirement keys mapped to the linked plan items. */
  mappedRequirements: string[];
  /** Requirement keys supplied by the caller across discharges and contributions. */
  declaredRequirements: string[];
  /** True when at least one declaration is present and every declaration maps to this item. */
  declarationSatisfied: boolean | null;
  refusal: ConformanceClosureRefusal | null;
}
export interface ConformanceClosureDeps {
  listOpenDriftAlarms(): Promise<readonly OpenDriftAlarm[]>;
  readDoneWhenVerdict(requirement: RequirementEnforcement): Promise<ConformanceCheckVerdict | null>;
}

/** Contribution-only closes need no done-when pass, but still respect drift alarms. */
export async function evaluateConformanceClosure(
  input: { planContent: string; planItemIds: readonly string[]; completion: RequirementClosureDeclaration },
  deps: ConformanceClosureDeps,
): Promise<ConformanceClosureRefusal | null> {
  return (await evaluateConformanceClosureAssessment(input, deps)).refusal;
}

/**
 * Evaluate closure once while retaining the mapping and caller declarations for
 * validateOnly/refusal output. The refusal-only wrapper above remains available to
 * existing callers that need only the enforcement decision.
 */
export async function evaluateConformanceClosureAssessment(
  input: { planContent: string; planItemIds: readonly string[]; completion: RequirementClosureDeclaration },
  deps: ConformanceClosureDeps,
): Promise<ConformanceClosureAssessment> {
  const discharged = new Set(input.completion.discharges ?? []);
  const contributed = new Set(input.completion.contributesTo ?? []);
  const declaredRequirements = [...new Set([...discharged, ...contributed])];
  const result = (
    refusal: ConformanceClosureRefusal | null,
    fields: Partial<Pick<ConformanceClosureAssessment, 'applicable' | 'mappedRequirements' | 'declarationSatisfied'>> = {},
  ): ConformanceClosureAssessment => ({
    applicable: false,
    mappedRequirements: [],
    declaredRequirements,
    declarationSatisfied: null,
    ...fields,
    refusal,
  });
  const report = evaluateRequirementEnforcement(input.planContent);
  if (!report.applicable) return result(null);
  const map = parseBarMappings(input.planContent, new Set(report.requirements.map((r) => r.barKey)));
  const mapped = new Set(map.mappings
    .filter((m) => m.planItemIds.some((id) => input.planItemIds.includes(id)))
    .map((m) => m.barKey));
  const mappedRequirements = [...mapped];
  if (!map.ok) {
    // Retiring/transferring another lane must not freeze support work. Only
    // dropped-only errors with a known, unrelated subject are item-scoped;
    // malformed/unknown mappings and this item's own dropped mapping still fail.
    const problems = map.problems.filter((p) => p.code !== 'bar_mapping_dropped_only' ||
      p.barKey === undefined || mapped.has(p.barKey));
    if (problems.length) {
      return result({ code: 'conformance_mapping_unavailable', error: problems.map((p) => p.detail).join('; ') },
        { applicable: true, mappedRequirements });
    }
  }
  if (!mapped.size) return result(null);
  // Conformance is plan-wide at activation, but a terminal close only owns the
  // requirements mapped to this plan item. Do not block a support item because
  // a different mapped item still has an unenforced or malformed requirement.
  // Contract-level parse failures have no bar key and therefore apply to every
  // mapped requirement; bar-scoped failures are narrowed to this item's map.
  const scopedProblems = report.problems.filter((problem) => problem.barKey === undefined || mapped.has(problem.barKey));
  if (scopedProblems.length) {
    const problemRequirements = [...new Set(scopedProblems.flatMap((problem) => problem.barKey ? [problem.barKey] : mappedRequirements))];
    return result({
      code: 'conformance_contract_invalid',
      error: scopedProblems.map((problem) => problem.detail).join('; '),
      requirements: problemRequirements,
    }, { applicable: true, mappedRequirements, declarationSatisfied: null });
  }
  const named = new Set(declaredRequirements);
  if (!named.size) {
    return result(
      { code: 'conformance_requirements_missing', error: 'Name a mapped requirement in completion.discharges or completion.contributesTo.', requirements: mappedRequirements },
      { applicable: true, mappedRequirements, declarationSatisfied: false },
    );
  }
  const unmapped = [...named].filter((key) => !mapped.has(key));
  if (unmapped.length) {
    return result(
      { code: 'conformance_requirement_unmapped', error: `Requirements are not mapped to this item: ${unmapped.join(', ')}.`, requirements: unmapped },
      { applicable: true, mappedRequirements, declarationSatisfied: false },
    );
  }
  const declarationSatisfied = true;
  const deviations = approvedDeviations(input.planContent);
  const alarms = (await deps.listOpenDriftAlarms()).filter((a) => mapped.has(a.barKey) && !deviations.has(a.barKey));
  if (alarms.length) {
    return result({
        code: 'conformance_drift_alarm_open',
        error: 'Mapped requirements have open drift alarms; resolve them or record an approved deviation before closing.',
        requirements: [...new Set(alarms.map((a) => a.barKey))], alarmIds: alarms.map((a) => a.id),
      }, { applicable: true, mappedRequirements, declarationSatisfied });
  }
  const nonPassing: string[] = [];
  for (const requirement of report.requirements) {
    if (!discharged.has(requirement.barKey) || deviations.has(requirement.barKey) || requirement.doneWhen !== 'executable') continue;
    if (await deps.readDoneWhenVerdict(requirement) !== 'pass') nonPassing.push(requirement.barKey);
  }
  return result(nonPassing.length ? {
    code: 'conformance_done_when_not_passing', error: 'Executable checks for discharged requirements must have passing recorded results.', requirements: nonPassing,
  } : null, { applicable: true, mappedRequirements, declarationSatisfied });
}

export async function conformanceClosureAssessment(input: {
  workspaceId: string; harnessSlug: string; planSlug: string; planItemIds: readonly string[];
  completion: RequirementClosureDeclaration;
  item?: WorkItem;
  skipConformance?: boolean;
  phases?: PhaseTracker;
}): Promise<ConformanceClosureAssessment> {
  const declaredRequirements = [...new Set([
    ...(input.completion.discharges ?? []),
    ...(input.completion.contributesTo ?? []),
  ])];
  const result = (
    refusal: ConformanceClosureRefusal | null,
    fields: Partial<Pick<ConformanceClosureAssessment, 'applicable' | 'mappedRequirements' | 'declarationSatisfied'>> = {},
  ): ConformanceClosureAssessment => ({
    applicable: false,
    mappedRequirements: [],
    declaredRequirements,
    declarationSatisfied: null,
    ...fields,
    refusal,
  });
  const plan = await trackPhase(input.phases, 'conformance:closure:plan', () =>
    readPlanBySlug(input.planSlug, { workspaceId: input.workspaceId, harnessSlug: input.harnessSlug }));
  if (!plan) return result({ code: 'conformance_mapping_unavailable', error: `Cannot read linked plan ${input.planSlug}.` }, { applicable: true });
  if (input.item && plan.parsed.frontmatter.frozenTests === 'pilot') {
    const { frozenTestsClosureRefusal } = await import('../agent-tools/work_items/frozen-tests-gate');
    const refusal = await frozenTestsClosureRefusal({ item: input.item, scope: input, plan });
    if (refusal) return result({ code: 'frozen_tests_completion_refused', error: refusal.error,
      liftsWhen: 'the plan carries a frozen-tests manifest for this plan and item, and a current passing test run whose source and test fingerprints match the frozen rows covers every frozen test file of this item' },
    { applicable: true });
  }
  if (input.skipConformance) return result(null);
  const runtime = productionConformanceDeps(input);
  let verdicts: Awaited<ReturnType<typeof readLatestRubricCheckResults>> | undefined;
  return evaluateConformanceClosureAssessment({ planContent: plan.row.content, planItemIds: input.planItemIds, completion: input.completion }, {
    listOpenDriftAlarms: () => trackPhase(input.phases, 'conformance:closure:drift', runtime.listOpenDriftAlarms),
    async readDoneWhenVerdict(requirement) {
      // Tests have a canonical ledger even before the first conformance sweep fires.
      if (requirement.doneWhenCheck?.kind === 'tests') {
        // Reuse the run adapter: it retains one immutable dependency cache for this
        // close, preserves named case selectors, and carries the request's phases.
        return (await trackPhase(input.phases, `conformance:closure:tests:${requirement.barKey}`, () =>
          runtime.evaluateCheck({
            barKey: requirement.barKey,
            role: 'done-when',
            checkId: doneWhenCheckId(requirement.barKey),
            check: requirement.doneWhenCheck!,
          })))?.verdict ?? null;
      }
      verdicts ??= await trackPhase(input.phases, 'conformance:closure:results', () =>
        readLatestRubricCheckResults({ rubricRef: conformanceLedgerRef(input.harnessSlug, input.planSlug), workspaceId: input.workspaceId }));
      return verdicts.get(doneWhenCheckId(requirement.barKey))?.status ?? null;
    },
  });
}

export async function conformanceClosureRefusal(input: Parameters<typeof conformanceClosureAssessment>[0]): Promise<ConformanceClosureRefusal | null> {
  return (await conformanceClosureAssessment(input)).refusal;
}
