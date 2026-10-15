/** P-029: requirement-labelled closure reuses the BAR map and conformance ledger. */
import { parseBarMappings } from '../acceptance-bar-seed';
import { readPlanBySlug } from '../agent-tools/plans/source';
import { readLatestRubricCheckResults } from '../check-results-ledger';
import { evaluateRequirementEnforcement, type RequirementEnforcement } from './conformance-contract';
import { conformanceLedgerRef, doneWhenCheckId, type ConformanceCheckVerdict, type OpenDriftAlarm } from './conformance-run';
import { judgeTestsFromLedger, productionConformanceDeps } from './conformance-run-deps';
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
  requirements?: string[];
  alarmIds?: string[];
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
  const report = evaluateRequirementEnforcement(input.planContent);
  if (!report.applicable) return null;
  if (report.problems.length) {
    return { code: 'conformance_contract_invalid', error: report.problems.map((p) => p.detail).join('; ') };
  }
  const map = parseBarMappings(input.planContent, new Set(report.requirements.map((r) => r.barKey)));
  if (!map.ok) {
    return { code: 'conformance_mapping_unavailable', error: map.problems.map((p) => p.detail).join('; ') };
  }
  const mapped = new Set(map.mappings
    .filter((m) => m.planItemIds.some((id) => input.planItemIds.includes(id)))
    .map((m) => m.barKey));
  if (!mapped.size) return null;
  const discharged = new Set(input.completion.discharges ?? []);
  const named = new Set([...discharged, ...(input.completion.contributesTo ?? [])]);
  if (!named.size) {
    return { code: 'conformance_requirements_missing', error: 'Name a mapped requirement in completion.discharges or completion.contributesTo.', requirements: [...mapped] };
  }
  const unmapped = [...named].filter((key) => !mapped.has(key));
  if (unmapped.length) {
    return { code: 'conformance_requirement_unmapped', error: `Requirements are not mapped to this item: ${unmapped.join(', ')}.`, requirements: unmapped };
  }
  const deviations = approvedDeviations(input.planContent);
  const alarms = (await deps.listOpenDriftAlarms()).filter((a) => mapped.has(a.barKey) && !deviations.has(a.barKey));
  if (alarms.length) {
    return {
      code: 'conformance_drift_alarm_open',
      error: 'Mapped requirements have open drift alarms; resolve them or record an approved deviation before closing.',
      requirements: [...new Set(alarms.map((a) => a.barKey))], alarmIds: alarms.map((a) => a.id),
    };
  }
  const nonPassing: string[] = [];
  for (const requirement of report.requirements) {
    if (!discharged.has(requirement.barKey) || deviations.has(requirement.barKey) || requirement.doneWhen !== 'executable') continue;
    if (await deps.readDoneWhenVerdict(requirement) !== 'pass') nonPassing.push(requirement.barKey);
  }
  return nonPassing.length ? {
    code: 'conformance_done_when_not_passing', error: 'Executable checks for discharged requirements must have passing recorded results.', requirements: nonPassing,
  } : null;
}

export async function conformanceClosureRefusal(input: {
  workspaceId: string; harnessSlug: string; planSlug: string; planItemIds: readonly string[];
  completion: RequirementClosureDeclaration;
  item?: WorkItem;
  skipConformance?: boolean;
}): Promise<ConformanceClosureRefusal | null> {
  const plan = await readPlanBySlug(input.planSlug, { workspaceId: input.workspaceId, harnessSlug: input.harnessSlug });
  if (!plan) return { code: 'conformance_mapping_unavailable', error: `Cannot read linked plan ${input.planSlug}.` };
  if (input.item && plan.parsed.frontmatter.frozenTests === 'pilot') {
    const { frozenTestsClosureRefusal } = await import('../agent-tools/work_items/frozen-tests-gate');
    const refusal = await frozenTestsClosureRefusal({ item: input.item, scope: input, plan });
    if (refusal) return { code: 'frozen_tests_completion_refused', error: refusal.error };
  }
  if (input.skipConformance) return null;
  const runtime = productionConformanceDeps(input);
  let verdicts: Awaited<ReturnType<typeof readLatestRubricCheckResults>> | undefined;
  return evaluateConformanceClosure({ planContent: plan.row.content, planItemIds: input.planItemIds, completion: input.completion }, {
    listOpenDriftAlarms: runtime.listOpenDriftAlarms,
    async readDoneWhenVerdict(requirement) {
      // Tests have a canonical ledger even before the first conformance sweep fires.
      if (requirement.doneWhenCheck?.kind === 'tests') {
        return (await judgeTestsFromLedger({ files: requirement.doneWhenCheck.files, workspaceId: input.workspaceId })).verdict;
      }
      verdicts ??= await readLatestRubricCheckResults({ rubricRef: conformanceLedgerRef(input.harnessSlug, input.planSlug), workspaceId: input.workspaceId });
      return verdicts.get(doneWhenCheckId(requirement.barKey))?.status ?? null;
    },
  });
}
