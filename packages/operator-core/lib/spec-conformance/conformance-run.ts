/**
 * Spec-conformance run — the execution-time loop over a plan's requirements.
 *
 * For every requirement of a plan (the `## Requirements` blocks joined with the
 * `## Conformance` contract by `evaluateRequirementEnforcement`) one run:
 *
 *   1. evaluates every RUNNABLE `violatedWhen` falsifier (a check that asserts the
 *      requirement holds — a `fail` verdict is the falsifier firing, R-2);
 *   2. re-scores the requirement's executable DONE-WHEN check;
 *   3. records every verdict in the results ledger under the namespace
 *      `conformance:<harness>/<plan>` (one check id per falsifier / done-when);
 *   4. raises drift:
 *        - a firing falsifier is drift (R-2);
 *        - a done-when check that moved pass → fail is drift (R-4). A done-when
 *          check that has never passed is PROGRESS state, never drift;
 *   5. opens ONE deduplicated drift-alarm work-item per drifting requirement, links
 *      it `blocks` to every non-terminal work-item mapped to that requirement
 *      (R-3), and emits `plan:drift-alarm:<slug>` when the alarm is first opened;
 *   6. closes an open alarm once every check it rests on is measured green, which
 *      releases its blocks. An approved deviation suppresses the alarm for its
 *      requirement (closing an open one).
 *
 * The run is pure orchestration over injected dependencies so the drift rules are
 * unit-testable without a database; `conformance-run-deps.ts` supplies the
 * production adapters (results ledger, test-run ledger, rubric probe/instrument
 * runners, condition-keyed work-item filing, blocks links, the event engine).
 *
 * Plan: spec-conformance-loop-2026-10-14 (P-018; R-2, R-3, R-4).
 */
import type { RubricCriterionCheck } from '../agent-tools/plans/rubric-template';
import type { RubricCheckResult, RubricCheckVerdict } from '../check-results-ledger';
import { evaluateRequirementEnforcement, type RequirementEnforcement } from './conformance-contract';

export type ConformanceCheckVerdict = RubricCheckVerdict;
export type ConformanceCheckRole = 'falsifier' | 'done-when';
export type ConformanceRecordedKind = 'probe' | 'instrument' | 'tests';

/** Results-ledger namespace of one plan's conformance verdicts. */
export function conformanceLedgerRef(harnessSlug: string, planSlug: string): string {
  return `conformance:${harnessSlug}/${planSlug}`;
}

/** The awaitable key a newly opened drift alarm fires. */
export function planDriftAlarmKey(planSlug: string): string {
  return `plan:drift-alarm:${planSlug}`;
}

/** Condition key that deduplicates the drift alarm of one requirement. */
export function driftAlarmConditionKey(harnessSlug: string, planSlug: string, barKey: string): string {
  return `spec-conformance-drift:${harnessSlug}/${planSlug}/${barKey}`;
}

export function doneWhenCheckId(barKey: string): string {
  return `${barKey}:done-when`;
}

export function falsifierCheckId(barKey: string, falsifierId: string): string {
  return `${barKey}:violated-when:${falsifierId}`;
}

export interface ConformanceCheckRequest {
  barKey: string;
  role: ConformanceCheckRole;
  checkId: string;
  falsifierId?: string;
  check: RubricCriterionCheck;
}

/** One executed check. `error` means nothing was measured — never a pass, never a fail. */
export interface EvaluatedConformanceCheck {
  kind: ConformanceRecordedKind;
  verdict: ConformanceCheckVerdict;
  value: number | string | boolean | null;
  unit: string | null;
  measuredAt: string;
  durationMs?: number | null;
  detail?: string;
}

export interface OpenDriftAlarm {
  id: string;
  barKey: string;
  /** The alarm was raised (or later re-confirmed) by a done-when pass → fail regression. */
  doneWhenRegressed: boolean;
}

export interface DriftAlarmFiling {
  barKey: string;
  title: string;
  conditionKey: string;
  firedFalsifiers: string[];
  doneWhenRegressed: boolean;
  summary: string;
}

export interface MappedWorkItem {
  id: string;
  terminal: boolean;
}

export interface PlanDriftAlarmPayload {
  planSlug: string;
  harnessSlug: string;
  barKey: string;
  alarmId: string;
  firedFalsifiers: string[];
  doneWhenRegressed: boolean;
  blocked: string[];
}

export interface ConformanceRunDeps {
  /** Run one check. Null when the run cannot evaluate this check kind (reported, never green). */
  evaluateCheck(request: ConformanceCheckRequest): Promise<EvaluatedConformanceCheck | null>;
  /** Latest recorded verdict per check id in the plan's conformance ledger namespace. */
  readLatestVerdicts(ledgerRef: string): Promise<ReadonlyMap<string, ConformanceCheckVerdict>>;
  /** Append ledger rows; returns test_runs ids in result order. */
  recordResults(results: ReadonlyArray<RubricCheckResult>): Promise<number[]>;
  listOpenDriftAlarms(): Promise<OpenDriftAlarm[]>;
  /** Open the requirement's alarm, or adopt the open one (condition-key dedup). */
  openDriftAlarm(filing: DriftAlarmFiling): Promise<{ id: string; created: boolean }>;
  closeDriftAlarm(id: string, reason: string): Promise<void>;
  /** Work-items mapped to a requirement through the plan's Bar-to-work map. */
  listMappedWorkItems(barKey: string): Promise<MappedWorkItem[]>;
  /** Idempotent `blocks` edge from the alarm to the dependent work-item. */
  linkBlocks(alarmId: string, workItemId: string): Promise<void>;
  emitDriftAlarm(payload: PlanDriftAlarmPayload): Promise<void>;
  /** Requirements carrying an APPROVED deviation (R-7); none when omitted. */
  approvedDeviations?(): Promise<ReadonlySet<string>>;
}

export type DriftAlarmAction = 'none' | 'opened' | 'kept' | 'closed' | 'suppressed';

export interface RequirementRunOutcome {
  barKey: string;
  falsifiers: Array<{ id: string; verdict: ConformanceCheckVerdict | 'unevaluable' }>;
  doneWhen: { before: ConformanceCheckVerdict | null; after: ConformanceCheckVerdict | 'unevaluable' } | null;
  firedFalsifiers: string[];
  doneWhenRegressed: boolean;
  drifting: boolean;
  /** Some check this requirement rests on measured nothing this run. */
  unmeasured: boolean;
  alarm: { action: DriftAlarmAction; id: string | null };
  blocked: string[];
}

export interface ConformanceRunOutcome {
  planSlug: string;
  harnessSlug: string;
  ledgerRef: string;
  /** False when the plan has no parseable requirements: nothing ran. */
  applicable: boolean;
  /** A malformed contract is never partially enforced; the run stops and reports it. */
  contractProblems: string[];
  executed: number;
  testRunIds: number[];
  requirements: RequirementRunOutcome[];
  /** Declared `pendingBinding` falsifiers — counted, never silently treated as green. */
  unbound: Array<{ barKey: string; falsifierId: string; bindWhen: string }>;
  unevaluable: Array<{ barKey: string; checkId: string; kind: string }>;
  alarmsOpened: string[];
  alarmsClosed: string[];
}

function toLedgerResult(
  ledgerRef: string,
  request: ConformanceCheckRequest,
  evaluated: EvaluatedConformanceCheck,
): RubricCheckResult {
  return {
    check: {
      id: request.checkId,
      rubricRef: ledgerRef,
      criterionKey: request.barKey,
      kind: evaluated.kind,
      value: evaluated.value,
      unit: evaluated.unit,
    },
    verdict: evaluated.verdict,
    measuredAt: evaluated.measuredAt,
    durationMs: evaluated.durationMs ?? null,
    ...(evaluated.detail ? { detail: evaluated.detail } : {}),
  };
}

function alarmSummary(input: {
  planSlug: string;
  requirement: RequirementEnforcement;
  firedFalsifiers: string[];
  doneWhenRegressed: boolean;
  ledgerRef: string;
}): string {
  const lines = [
    `Spec-conformance drift on plan \`${input.planSlug}\` requirement **${input.requirement.barKey} — ${input.requirement.title}**.`,
    '',
  ];
  for (const id of input.firedFalsifiers) {
    const falsifier = input.requirement.falsifiers.bound.find((f) => f.id === id);
    lines.push(`- violated-when \`${id}\` fired: ${falsifier?.failureMode ?? '(failure mode not recorded)'}`);
  }
  if (input.doneWhenRegressed) {
    lines.push('- the done-when check moved from pass to fail (a regression, not progress state)');
  }
  lines.push(
    '',
    `Verdicts are in the results ledger under \`${input.ledgerRef}\` (testing:runs on \`rubric-check/${input.ledgerRef}/…\`).`,
    'This alarm blocks every non-terminal work-item mapped to the requirement. It closes itself once every check it rests on ' +
      'is measured green; an unmeetable requirement needs an approved deviation (plans:conformance op approve-deviation), ' +
      'never a silent close.',
  );
  return lines.join('\n');
}

/** Run every requirement's checks once and reconcile drift alarms against the verdicts. */
export async function runPlanConformance(
  input: { planSlug: string; harnessSlug: string; planContent: string },
  deps: ConformanceRunDeps,
): Promise<ConformanceRunOutcome> {
  const ledgerRef = conformanceLedgerRef(input.harnessSlug, input.planSlug);
  const report = evaluateRequirementEnforcement(input.planContent);
  const outcome: ConformanceRunOutcome = {
    planSlug: input.planSlug,
    harnessSlug: input.harnessSlug,
    ledgerRef,
    applicable: report.applicable,
    contractProblems: report.problems
      .filter((problem) => problem.code === 'conformance_contract_invalid')
      .map((problem) => problem.detail),
    executed: 0,
    testRunIds: [],
    requirements: [],
    unbound: [],
    unevaluable: [],
    alarmsOpened: [],
    alarmsClosed: [],
  };
  if (!report.applicable || outcome.contractProblems.length > 0) return outcome;

  const before = await deps.readLatestVerdicts(ledgerRef);
  const openAlarms = new Map((await deps.listOpenDriftAlarms()).map((alarm) => [alarm.barKey, alarm] as const));
  const deviations = (await deps.approvedDeviations?.()) ?? new Set<string>();

  // Pass 1 — measure everything, then record it in one batch.
  const evaluations = new Map<string, EvaluatedConformanceCheck | null>();
  const ledgerResults: RubricCheckResult[] = [];
  const requestsByBar = new Map<string, ConformanceCheckRequest[]>();
  for (const requirement of report.requirements) {
    const requests: ConformanceCheckRequest[] = requirement.falsifiers.bound.map((falsifier) => ({
      barKey: requirement.barKey,
      role: 'falsifier',
      falsifierId: falsifier.id,
      checkId: falsifierCheckId(requirement.barKey, falsifier.id),
      check: falsifier.check!,
    }));
    if (requirement.doneWhen === 'executable' && requirement.doneWhenCheck) {
      requests.push({
        barKey: requirement.barKey,
        role: 'done-when',
        checkId: doneWhenCheckId(requirement.barKey),
        check: requirement.doneWhenCheck,
      });
    }
    for (const falsifier of requirement.falsifiers.pending) {
      outcome.unbound.push({
        barKey: requirement.barKey,
        falsifierId: falsifier.id,
        bindWhen: falsifier.pendingBinding!.bindWhen,
      });
    }
    requestsByBar.set(requirement.barKey, requests);
    for (const request of requests) {
      let evaluated: EvaluatedConformanceCheck | null;
      try {
        evaluated = await deps.evaluateCheck(request);
      } catch (error) {
        evaluated = {
          kind: request.check.kind === 'instrument' || request.check.kind === 'probe' ? request.check.kind : 'tests',
          verdict: 'error',
          value: null,
          unit: null,
          measuredAt: new Date().toISOString(),
          detail: `check threw: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      evaluations.set(request.checkId, evaluated);
      if (evaluated === null) {
        outcome.unevaluable.push({ barKey: request.barKey, checkId: request.checkId, kind: request.check.kind });
      } else {
        ledgerResults.push(toLedgerResult(ledgerRef, request, evaluated));
      }
    }
  }
  if (ledgerResults.length > 0) {
    outcome.testRunIds = await deps.recordResults(ledgerResults);
    outcome.executed = ledgerResults.length;
  }

  // Pass 2 — drift per requirement, reconciled against the open alarms.
  for (const requirement of report.requirements) {
    const barKey = requirement.barKey;
    const requests = requestsByBar.get(barKey) ?? [];
    const alarm = openAlarms.get(barKey) ?? null;
    const falsifierOutcomes: RequirementRunOutcome['falsifiers'] = [];
    const firedFalsifiers: string[] = [];
    let unmeasured = false;
    let doneWhen: RequirementRunOutcome['doneWhen'] = null;
    let doneWhenRegressed = false;

    for (const request of requests) {
      const evaluated = evaluations.get(request.checkId) ?? null;
      const verdict = evaluated?.verdict ?? 'unevaluable';
      if (verdict === 'error' || verdict === 'unevaluable') unmeasured = true;
      if (request.role === 'falsifier') {
        falsifierOutcomes.push({ id: request.falsifierId!, verdict });
        if (verdict === 'fail') firedFalsifiers.push(request.falsifierId!);
      } else {
        const prior = before.get(request.checkId) ?? null;
        doneWhen = { before: prior, after: verdict };
        // Pass → fail is drift. A fail that follows a fail stays drift only while the
        // alarm that a regression opened is still open; a never-green fail is progress.
        doneWhenRegressed = verdict === 'fail' && (prior === 'pass' || alarm?.doneWhenRegressed === true);
      }
    }

    const drifting = firedFalsifiers.length > 0 || doneWhenRegressed;
    const row: RequirementRunOutcome = {
      barKey,
      falsifiers: falsifierOutcomes,
      doneWhen,
      firedFalsifiers,
      doneWhenRegressed,
      drifting,
      unmeasured,
      alarm: { action: 'none', id: alarm?.id ?? null },
      blocked: [],
    };

    if (deviations.has(barKey)) {
      if (alarm) {
        await deps.closeDriftAlarm(alarm.id, `approved deviation recorded for ${barKey}; drift alarm suppressed`);
        outcome.alarmsClosed.push(alarm.id);
      }
      row.alarm = { action: 'suppressed', id: alarm?.id ?? null };
    } else if (drifting) {
      const filing: DriftAlarmFiling = {
        barKey,
        title: `Spec drift: ${input.planSlug} ${barKey} — ${requirement.title}`.slice(0, 300),
        conditionKey: driftAlarmConditionKey(input.harnessSlug, input.planSlug, barKey),
        firedFalsifiers,
        doneWhenRegressed,
        summary: alarmSummary({ planSlug: input.planSlug, requirement, firedFalsifiers, doneWhenRegressed, ledgerRef }),
      };
      const opened = await deps.openDriftAlarm(filing);
      row.alarm = { action: opened.created ? 'opened' : 'kept', id: opened.id };
      for (const work of await deps.listMappedWorkItems(barKey)) {
        if (work.terminal || work.id === opened.id) continue;
        await deps.linkBlocks(opened.id, work.id);
        row.blocked.push(work.id);
      }
      if (opened.created) {
        outcome.alarmsOpened.push(opened.id);
        await deps.emitDriftAlarm({
          planSlug: input.planSlug,
          harnessSlug: input.harnessSlug,
          barKey,
          alarmId: opened.id,
          firedFalsifiers,
          doneWhenRegressed,
          blocked: row.blocked,
        });
      }
    } else if (alarm && !unmeasured) {
      await deps.closeDriftAlarm(alarm.id, `every check of ${barKey} measured green in ${ledgerRef}`);
      outcome.alarmsClosed.push(alarm.id);
      row.alarm = { action: 'closed', id: alarm.id };
    } else if (alarm) {
      // Not drifting, but not every check was measured: green is unconfirmed, so keep it.
      row.alarm = { action: 'kept', id: alarm.id };
    }
    outcome.requirements.push(row);
  }
  return outcome;
}
