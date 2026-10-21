/**
 * Production adapters for `runPlanConformance` — every one an existing surface:
 *
 *   - tests checks       → judged from the test-run ledger (latest row per named file);
 *   - probe checks       → evaluateCriterionProbeChecks through the re-score dispatcher;
 *   - instrument checks  → runInstrumentChecks (registered command instruments);
 *   - verdict history    → readLatestRubricCheckResults under `conformance:<harness>/<plan>`;
 *   - ledger writes      → recordRubricCheckResults (framework 'rubric-check');
 *   - drift alarms       → upsertConditionWorkItem (unique condition key = one open alarm per
 *                          requirement, race-free), closed by setWorkItemState('resolved');
 *   - dependent work     → work_item_spec_revision_edges for the requirement's AUTO-BAR clauses;
 *   - blocks             → linkWorkItem(..., 'blocks');
 *   - the event          → emitAwaitedEvent('plan:drift-alarm:<slug>').
 *
 * Condition-upsert filings have no auto-settle: this filer owns the close, which the run
 * performs when every check the alarm rests on is measured green.
 *
 * Plan: spec-conformance-loop-2026-10-14 (P-018).
 */
import { getOrgPg } from '@papercusp/db-org';
import { parseTestRunExecutionDetails } from '@papercusp/test-config/execution-details';
import { readPlanBySlug } from '../agent-tools/plans/source';
import { approvedDeviations } from './deviation';
import {
  probeCheckResults,
  readLatestRubricCheckResults,
  recordRubricCheckResults,
  runInstrumentChecks,
  type RubricCheckResult,
} from '../check-results-ledger';
import { evaluateCriterionProbeChecks } from '../rubrics-criterion-checks';
import { rescoreProbeDispatcher } from '../harness/routines/rubric-rescore-action';
import { upsertConditionWorkItem } from '../coord/condition-upsert';
import { emitAwaitedEvent } from '../events/await/engine';
import type { WorkItemDependencyAdmissionError } from '../dbos/work-item-deps-store';
import {
  getWorkItem,
  linkWorkItem,
  setWorkItemState,
  TERMINAL_WORK_ITEM_STATES,
  workItemObjectRef,
} from '../work-items';
import {
  planDriftAlarmKey,
  type ConformanceCheckRequest,
  type ConformanceCheckVerdict,
  type ConformanceRunDeps,
  type EvaluatedConformanceCheck,
  type MappedWorkItem,
  type OpenDriftAlarm,
} from './conformance-run';

export const SPEC_CONFORMANCE_ACTOR = 'system:spec-conformance';

/**
 * The dependency store refuses to add an unresolved blocker behind a claimed, active
 * dependant (`newlyActiveDependantConflicts`). For a drift alarm that is an expected outcome:
 * the alarm is still recorded and the refused edge is reported. Returns the store's message
 * when EVERY finding is such a lifecycle conflict; null for anything else (a cycle, an
 * endpoint defect, a stranded node, or a non-admission error), which the run must not absorb.
 * Matched by `code`, not `instanceof`, so a duplicated module record cannot hide it.
 */
export function lifecycleOnlyAdmissionRefusal(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const candidate = error as Error & Partial<Pick<WorkItemDependencyAdmissionError, 'code' | 'findings'>>;
  if (candidate.code !== 'WORK_ITEM_DEPENDENCY_ADMISSION_REJECTED' || !Array.isArray(candidate.findings)) return null;
  if (candidate.findings.length === 0) return null;
  const lifecycleOnly = candidate.findings.every(
    (finding) =>
      (finding.lifecycleConflicts?.length ?? 0) > 0 &&
      finding.cycles.length === 0 &&
      finding.endpointDefects.length === 0 &&
      finding.stranded.length === 0,
  );
  return lifecycleOnly ? error.message : null;
}

type Sql = ReturnType<typeof getOrgPg>['sql'];

/** Test-run rows older than one CI cadence are historical context, not current proof. */
export const SPEC_CONFORMANCE_TEST_EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SPEC_CONFORMANCE_TEST_EVIDENCE_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

function finishedAtMs(value: Date | string | null): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && value.trim()) return Date.parse(value);
  return Number.NaN;
}

/** Fold several executed results of ONE check into one verdict: error > fail > pass. */
export function foldVerdicts(verdicts: ReadonlyArray<ConformanceCheckVerdict>): ConformanceCheckVerdict {
  if (verdicts.length === 0 || verdicts.includes('error')) return 'error';
  return verdicts.includes('fail') ? 'fail' : 'pass';
}

function foldResults(kind: EvaluatedConformanceCheck['kind'], results: ReadonlyArray<RubricCheckResult>, nowIso: string): EvaluatedConformanceCheck {
  const verdict = foldVerdicts(results.map((r) => r.verdict));
  const deciding = results.find((r) => r.verdict === verdict) ?? results[0];
  return {
    kind,
    verdict,
    value: deciding?.check.value ?? null,
    unit: deciding?.check.unit ?? null,
    measuredAt: deciding?.measuredAt ?? nowIso,
    durationMs: deciding?.durationMs ?? null,
    ...(deciding?.detail ? { detail: deciding.detail } : results.length === 0 ? { detail: 'the check produced no result' } : {}),
  };
}

/** Judge a tests check from each named file's latest complete, clean, unfiltered run. */
export async function judgeTestsFromLedger(
  input: {
    files: readonly string[];
    workspaceId: string;
    /** Injectable clock for deterministic evidence-window tests. */
    now?: () => Date;
    /** Override only for focused tests; production uses the seven-day policy above. */
    maxAgeMs?: number;
  },
  sql: Sql = getOrgPg().sql,
): Promise<EvaluatedConformanceCheck> {
  const rows = (await sql`
    SELECT DISTINCT ON (file_path)
           id, file_path, status, finished_at, commit_sha, worktree_dirty, execution_details
      FROM harness_shared.test_runs
     WHERE file_path = ANY(${[...input.files]})
       AND framework IS DISTINCT FROM 'rubric-check'
       -- Mutation controls deliberately pass or fail against altered copies;
       -- filter them before DISTINCT ON, as the test-ledger browser does.
       AND source IS DISTINCT FROM 'mutation-probe'
       AND (workspace_id = ${input.workspaceId} OR workspace_id IS NULL)
       AND status IN ('pass', 'fail', 'error')
     ORDER BY file_path, finished_at DESC NULLS LAST, id DESC
  `) as Array<{
    id: number | string;
    file_path: string;
    status: string;
    finished_at: Date | string | null;
    commit_sha: string | null;
    worktree_dirty: boolean | null;
    execution_details: unknown;
  }>;
  const byFile = new Map(rows.map((row) => [row.file_path, row] as const));
  const missing = input.files.filter((file) => !byFile.has(file));
  const now = input.now?.() ?? new Date();
  const nowMs = now.getTime();
  const maxAgeMs = input.maxAgeMs ?? SPEC_CONFORMANCE_TEST_EVIDENCE_MAX_AGE_MS;
  const stale = rows.filter((row) => {
    const finishedMs = finishedAtMs(row.finished_at);
    return !Number.isFinite(finishedMs)
      || finishedMs < nowMs - maxAgeMs
      || finishedMs > nowMs + SPEC_CONFORMANCE_TEST_EVIDENCE_MAX_FUTURE_SKEW_MS;
  });
  const failing = rows.filter((row) => row.status !== 'pass').map((row) => `${row.file_path} (${row.status}, test_runs #${row.id})`);
  // A passing status is not enough for file-wide evidence: filtered or dirty runs
  // can pass only a subset or a moving source tree. Legacy failure rows remain
  // useful negative evidence above, but legacy pass rows cannot prove coverage.
  const unprovenPasses = rows.flatMap((row) => {
    if (row.status !== 'pass') return [];
    const details = parseTestRunExecutionDetails(row.execution_details);
    if (!details) {
      return [`${row.file_path} (missing or invalid execution details, test_runs #${row.id})`];
    }
    const reasons: string[] = [];
    if (details.filePath !== row.file_path) reasons.push('execution details file path mismatch');
    if (details.testNamePattern !== null) reasons.push('name-filtered test run');
    if (details.collectionFailed) reasons.push('test collection failed');
    if (row.worktree_dirty !== false || details.worktreeDirty) reasons.push('worktree was not proven clean');
    if (!row.commit_sha || details.commitSha !== row.commit_sha) reasons.push('commit SHA is absent or inconsistent');
    if (details.failed > 0) reasons.push('execution details report failed cases');
    if (details.passed === 0) reasons.push('no passing cases recorded');
    return reasons.length > 0
      ? [`${row.file_path} (${reasons.join(', ')}, test_runs #${row.id})`]
      : [];
  });
  const latest = rows
    .map((row) => (row.finished_at instanceof Date ? row.finished_at.toISOString() : String(row.finished_at ?? '')))
    .sort()
    .at(-1);
  const measuredAt = latest || new Date().toISOString();
  const passing = rows.length - failing.length;
  if (missing.length > 0 || stale.length > 0 || unprovenPasses.length > 0) {
    const unavailable = [
      ...missing.map((file) => `${file} (no test-run ledger row)`),
      ...stale.map((row) => `${row.file_path} (stale test-run evidence, test_runs #${row.id})`),
      ...unprovenPasses,
    ];
    return {
      kind: 'tests',
      verdict: 'error',
      value: null,
      unit: 'files',
      measuredAt,
      detail: `test-run evidence unavailable, stale, or incomplete: ${unavailable.join('; ')}`,
    };
  }
  if (failing.length > 0) {
    return { kind: 'tests', verdict: 'fail', value: passing, unit: 'files', measuredAt, detail: `failing: ${failing.join('; ')}` };
  }
  return { kind: 'tests', verdict: 'pass', value: passing, unit: 'files', measuredAt };
}

export interface ProductionConformanceDepsInput {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  /** Injectable probe dispatcher for focused tests; production uses the palette dispatcher. */
  dispatchTool?: Parameters<typeof rescoreProbeDispatcher>[1];
  /** Injectable probe evaluator for focused tests; production uses the continuity evaluator. */
  evaluateProbes?: typeof evaluateCriterionProbeChecks;
  /**
   * Requirements carrying an approved deviation (R-17, P-028). Defaults to
   * {@link planApprovedDeviations}: re-derived from the plan's CURRENT text on every
   * run, so a later edit that makes a requirement owner-sourced revokes an agent approval.
   */
  approvedDeviations?: () => Promise<ReadonlySet<string>>;
}

/** Approved deviations for a stored plan; an unreadable plan suppresses nothing. */
export async function planApprovedDeviations(
  input: Pick<ProductionConformanceDepsInput, 'workspaceId' | 'harnessSlug' | 'planSlug'>,
  readPlan: typeof readPlanBySlug = readPlanBySlug,
): Promise<ReadonlySet<string>> {
  const read = await readPlan(input.planSlug, { workspaceId: input.workspaceId, harnessSlug: input.harnessSlug });
  return read ? approvedDeviations(read.row.content) : new Set<string>();
}

/** The DB-backed dependency set the conformance sweep (P-023) runs with. */
export function productionConformanceDeps(input: ProductionConformanceDepsInput): ConformanceRunDeps {
  const sql = () => getOrgPg().sql;
  const nowIso = () => new Date().toISOString();
  return {
    async evaluateCheck(request: ConformanceCheckRequest) {
      const check = request.check;
      if (check.kind === 'tests') {
        return judgeTestsFromLedger({ files: check.files, workspaceId: input.workspaceId }, sql());
      }
      if (check.kind === 'probe') {
        const criterion = { key: request.checkId, check };
        const evaluation = await (input.evaluateProbes ?? evaluateCriterionProbeChecks)({
          criteria: [criterion],
          ratings: { [request.checkId]: { rating: 'unknown' } },
          dispatchTool: rescoreProbeDispatcher(input.harnessSlug, input.dispatchTool, input.workspaceId),
        });
        if (!evaluation.ok) {
          return { kind: 'probe', verdict: 'error', value: null, unit: null, measuredAt: nowIso(), detail: `probe unjudged: ${evaluation.error}` };
        }
        return foldResults('probe', probeCheckResults(request.checkId, evaluation.checkRuns, [criterion]), nowIso());
      }
      if (check.kind === 'instrument') {
        const results = await runInstrumentChecks({ rubricRef: request.checkId, criteria: [{ key: request.checkId, check }],
          workspaceId: input.workspaceId, harnessSlug: input.harnessSlug });
        return foldResults('instrument', results, nowIso());
      }
      return null;
    },

    async readLatestVerdicts(ledgerRef) {
      const latest = await readLatestRubricCheckResults({ rubricRef: ledgerRef, workspaceId: input.workspaceId });
      return new Map([...latest].map(([id, row]) => [id, row.status] as const));
    },

    async recordResults(results) {
      return recordRubricCheckResults(results, { workspaceId: input.workspaceId, harnessSlug: input.harnessSlug });
    },

    async listOpenDriftAlarms(): Promise<OpenDriftAlarm[]> {
      const rows = (await sql()`
        SELECT feature_id, payload->'specConformance' AS spec
          FROM harness_shared.work_items
         WHERE workspace_id = ${input.workspaceId}
           AND harness_slug = ${input.harnessSlug}
           AND payload->'specConformance'->>'planSlug' = ${input.planSlug}
           AND NOT (status = ANY(${[...TERMINAL_WORK_ITEM_STATES]}))
      `) as Array<{ feature_id: string; spec: { barKey?: unknown; doneWhenRegressed?: unknown } | null }>;
      return rows
        .filter((row) => typeof row.spec?.barKey === 'string')
        .map((row) => ({ id: row.feature_id, barKey: row.spec!.barKey as string, doneWhenRegressed: row.spec!.doneWhenRegressed === true }));
    },

    async openDriftAlarm(filing) {
      const specConformance = {
        planSlug: input.planSlug,
        harnessSlug: input.harnessSlug,
        barKey: filing.barKey,
        firedFalsifiers: filing.firedFalsifiers,
        doneWhenRegressed: filing.doneWhenRegressed,
      };
      const paths = filing.paths?.length ? [...new Set(filing.paths)] : [];
      const res = await upsertConditionWorkItem(filing.conditionKey, {
        kind: 'bug',
        severity: 'major',
        harness: input.harnessSlug,
        workspaceId: input.workspaceId,
        sourcePlanSlug: input.planSlug,
        createdBy: SPEC_CONFORMANCE_ACTOR,
        title: filing.title,
        summary: filing.summary,
        payload: { specConformance, ...(paths.length > 0 ? { paths } : {}) },
      });
      if (!res.id) {
        // ConditionUpsertResult.id is typed nullable for the race-loss shape; an alarm
        // nobody can address must fail the run loudly, never read as filed.
        throw new Error(`spec-conformance: drift alarm for ${filing.conditionKey} returned no work-item id`);
      }
      if (!res.created) {
        // An adopted incumbent keeps its original payload; refresh what this run measured.
        if (paths.length > 0) {
          await sql()`
            UPDATE harness_shared.work_items
               SET payload = jsonb_set(
                 jsonb_set(coalesce(payload, '{}'::jsonb), '{specConformance}', ${specConformance as never}::jsonb),
                 '{paths}', ${paths as never}::jsonb
               ),
                   source_plan_slug = ${input.planSlug}
             WHERE feature_id = ${res.id} AND workspace_id = ${input.workspaceId}
          `;
        } else {
          await sql()`
            UPDATE harness_shared.work_items
               SET payload = jsonb_set(coalesce(payload, '{}'::jsonb) - 'paths', '{specConformance}', ${specConformance as never}::jsonb),
                   source_plan_slug = ${input.planSlug}
             WHERE feature_id = ${res.id} AND workspace_id = ${input.workspaceId}
          `;
        }
      }
      return { id: res.id, created: res.created };
    },

    async closeDriftAlarm(id, reason) {
      await setWorkItemState(id, 'resolved', { by: SPEC_CONFORMANCE_ACTOR, completionRef: reason, harness: input.harnessSlug });
    },

    async listMappedWorkItems(barKey): Promise<MappedWorkItem[]> {
      const rows = (await sql()`
        SELECT DISTINCT w.feature_id, w.status
          FROM harness_shared.work_item_spec_revision_edges e
          JOIN harness_shared.work_items w
            ON w.feature_id = e.work_item_id AND w.workspace_id = e.workspace_id
         WHERE e.workspace_id = ${input.workspaceId}
           AND e.harness_slug = ${input.harnessSlug}
           AND e.plan_slug = ${input.planSlug}
           AND e.spec_id ~ ${`^AUTO-BAR-${barKey}-P-[0-9]+$`}
      `) as Array<{ feature_id: string; status: string }>;
      return rows.map((row) => ({ id: row.feature_id, terminal: TERMINAL_WORK_ITEM_STATES.includes(row.status) }));
    },

    async linkBlocks(alarmId, workItemId) {
      const target = await getWorkItem(workItemId, input.harnessSlug);
      if (!target) throw new Error(`spec-conformance: mapped work-item '${workItemId}' not found`);
      let linked: Awaited<ReturnType<typeof linkWorkItem>>;
      try {
        linked = await linkWorkItem(alarmId, workItemObjectRef(target), 'blocks', { harness: input.harnessSlug, by: SPEC_CONFORMANCE_ACTOR });
      } catch (error) {
        const refusal = lifecycleOnlyAdmissionRefusal(error);
        if (refusal !== null) return { linked: false, reason: refusal };
        throw error;
      }
      if ('error' in linked) throw new Error(`spec-conformance: blocks link ${alarmId} -> ${workItemId} failed: ${linked.error}`);
      return { linked: true };
    },

    async emitDriftAlarm(payload) {
      await emitAwaitedEvent({
        key: planDriftAlarmKey(payload.planSlug),
        payload,
        summary: `plan ${payload.planSlug}: drift alarm ${payload.alarmId} opened for ${payload.barKey}` +
          (payload.blocked.length ? `, blocking ${payload.blocked.join(', ')}` : '') +
          (payload.blockRefused.length
            ? `; not blocking active ${payload.blockRefused.map((refused) => refused.workItemId).join(', ')}`
            : ''),
        source: SPEC_CONFORMANCE_ACTOR,
        workspaceId: input.workspaceId,
      });
    },

    approvedDeviations: input.approvedDeviations ?? (() => planApprovedDeviations(input)),
  };
}
