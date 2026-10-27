/**
 * Production adapters for `runPlanConformance` — every one an existing surface:
 *
 *   - tests checks       → judged from the test-run ledger (latest row per named file);
 *   - probe checks       → evaluateCriterionProbeChecks through the re-score dispatcher;
 *   - instrument checks  → runInstrumentChecks (registered command instruments);
 *   - requirements checks → the canonical activation/completion realization judge;
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
import { trackPhase, type PhaseTracker } from '@papercusp/tooldef';
import { parseTestRunExecutionDetails } from '@papercusp/test-config/execution-details';
import { sameBuildSha } from '../attention/bug-reproduction';
import { readPlanBySlug } from '../agent-tools/plans/source';
import { getBuildInfo } from '../build-info';
import { createTestContentEquivalence, type TestContentEquivalence } from './conformance-test-content';
import { approvedDeviations } from './deviation';
import {
  probeCheckResults,
  readLatestRubricCheckResults,
  recordRubricCheckResults,
  runInstrumentChecks,
  type RubricCheckResult,
} from '../check-results-ledger';
import {
  evaluateCriterionProbeChecks,
  evaluateCriterionRequirementChecks,
  loadCriterionCheckCases,
  type CriterionCaseLoader,
  type RequirementRealizationReader,
} from '../rubrics-criterion-checks';
import { getEffectiveItemAudits, getLatestActivationAudit, getPlanItemStatuses } from '../plan-audits';
import { isNonCodeAuditVerdict } from '../plan-verification-profile';
import { runWithWorkspace } from '../workspace-als';
import { resolveTestCaseFilter, type RecordedTestCase } from '../testing-case-filter';
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
const SPEC_CONFORMANCE_BUILD_SHA_RE = /^[0-9a-f]{7,40}$/i;

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
    /** Running operator build identity; injectable for deterministic ledger tests. */
    currentBuildSha?: string | null;
    /** Named cases narrow the verdict to exact recorded case outcomes within each file. */
    cases?: ReadonlyArray<{ file: string; testName: string }>;
    /** Injectable case reader for focused tests; production reads the per-case ledger. */
    caseLoader?: CriterionCaseLoader;
    /** Injectable clock for deterministic evidence-window tests. */
    now?: () => Date;
    /** Override only for focused tests; production uses the seven-day policy above. */
    maxAgeMs?: number;
    /** Immutable dependency-content proof; injectable for focused selection tests. */
    contentEquivalence?: TestContentEquivalence;
    /** Same per-request tracker as the enclosing conformance run. */
    phases?: PhaseTracker;
  },
  sql: Sql = getOrgPg().sql,
): Promise<EvaluatedConformanceCheck> {
  const currentBuildSha = input.currentBuildSha === undefined ? getBuildInfo().sha : input.currentBuildSha;
  const normalizedCurrentBuildSha = currentBuildSha?.trim() || null;
  const matchingBuildSha = normalizedCurrentBuildSha && SPEC_CONFORMANCE_BUILD_SHA_RE.test(normalizedCurrentBuildSha)
    ? normalizedCurrentBuildSha.toLowerCase()
    : null;
  const candidates = (await trackPhase(input.phases, 'conformance:tests:ledger', () => sql`
    WITH per_commit AS (
    SELECT DISTINCT ON (file_path, commit_sha)
           id, file_path, status, finished_at, commit_sha, worktree_dirty, execution_details
      FROM harness_shared.test_runs
     WHERE file_path = ANY(${[...input.files]})
       AND framework IS DISTINCT FROM 'rubric-check'
       -- Mutation controls deliberately pass or fail against altered copies;
       -- filter them before DISTINCT ON, as the test-ledger browser does.
       AND source IS DISTINCT FROM 'mutation-probe'
       AND (workspace_id = ${input.workspaceId} OR workspace_id IS NULL)
       AND status IN ('pass', 'fail', 'error')
     -- Concurrent reviewers may test other commits in this same workspace.
     -- Prefer this build's newest run; retain foreign rows as a diagnostic
     -- fallback when there is no match. Unpinned errors stay fail-closed.
     ORDER BY file_path, commit_sha,
              CASE WHEN status = 'pass' AND worktree_dirty IS TRUE THEN 1 ELSE 0 END,
              finished_at DESC NULLS LAST, id DESC
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY file_path ORDER BY
              CASE WHEN ${matchingBuildSha}::text IS NULL
                     OR nullif(btrim(commit_sha), '') IS NULL
                     OR (commit_sha ~ '^[a-fA-F0-9]{7,64}$' AND (
                       starts_with(lower(btrim(commit_sha)), ${matchingBuildSha}::text)
                       OR starts_with(${matchingBuildSha}::text, lower(btrim(commit_sha)))
                     )) THEN 0 ELSE 1 END,
              -- A dirty passing run observes an uncommitted candidate, even when
              -- its HEAD matches. Prefer this build's committed observation;
              -- keep negative and name-filtered evidence fail-closed as before.
              CASE WHEN status = 'pass' AND worktree_dirty IS TRUE THEN 1 ELSE 0 END,
              finished_at DESC NULLS LAST, id DESC) AS candidate_rank
        FROM per_commit
    ) SELECT * FROM ranked WHERE candidate_rank <= 32
      ORDER BY file_path, candidate_rank
  `)) as Array<{
    id: number | string;
    file_path: string;
    status: string;
    finished_at: Date | string | null;
    commit_sha: string | null;
    worktree_dirty: boolean | null;
    execution_details: unknown;
  }>;
  const equivalentRows = new Set<typeof candidates[number]>();
  const equivalenceProblems = new Map<typeof candidates[number], string>();
  const contentEquivalence = input.contentEquivalence ?? createTestContentEquivalence();
  // Among compatible rows preserve dirty-pass penalty, recency, then id. Walk
  // that order until the first compatible row: no later proof can outrank it.
  const ordered = [...candidates].sort((a, b) =>
    Number(a.status === 'pass' && a.worktree_dirty === true) - Number(b.status === 'pass' && b.worktree_dirty === true)
    || (finishedAtMs(b.finished_at) || 0) - (finishedAtMs(a.finished_at) || 0)
    || Number(b.id) - Number(a.id));
  const candidatesByFile = new Map<string, typeof candidates>();
  for (const row of ordered) {
    const group = candidatesByFile.get(row.file_path) ?? [];
    group.push(row);
    candidatesByFile.set(row.file_path, group);
  }
  const byFile = new Map<string, typeof candidates[number]>();
  for (const [file, group] of candidatesByFile) {
    // If no row is compatible, retain the same best diagnostic fallback.
    byFile.set(file, group[0]!);
    for (const row of group) {
      const sha = row.commit_sha?.trim();
      if (!matchingBuildSha || !sha || (SPEC_CONFORMANCE_BUILD_SHA_RE.test(sha) && sameBuildSha(sha, matchingBuildSha))) {
        byFile.set(file, row);
        break;
      }
      if (!SPEC_CONFORMANCE_BUILD_SHA_RE.test(sha)) continue;
      const details = parseTestRunExecutionDetails(row.execution_details);
      // Content cannot recover unknown runtime identity, a dirty observation,
      // external integration state or missing full-file/named-case coverage.
      if (!details || details.testLayer !== 'unit' || details.filePath !== row.file_path
        || row.worktree_dirty !== false || details.worktreeDirty || details.commitSha !== row.commit_sha) continue;
      const proof = await trackPhase(input.phases, `conformance:tests:contentEquivalence:${row.id}:${row.file_path}`,
        () => contentEquivalence({ file: row.file_path, recordedSha: sha, currentSha: matchingBuildSha }));
      if (proof.equivalent) {
        equivalentRows.add(row);
        byFile.set(file, row);
        break;
      }
      equivalenceProblems.set(row, proof.reason);
    }
  }
  const rows = [...byFile.values()];
  const currentBuildProblems = rows.flatMap((row) => {
    if (row.status === 'error') return [];
    if (!normalizedCurrentBuildSha || !SPEC_CONFORMANCE_BUILD_SHA_RE.test(normalizedCurrentBuildSha)) {
      return [`${row.file_path} (current running build SHA is unavailable, test_runs #${row.id})`];
    }
    const runSha = row.commit_sha?.trim() ?? '';
    if (!runSha) {
      return row.status === 'fail'
        ? [`${row.file_path} (test run has no commit SHA to match the current build, test_runs #${row.id})`]
        : [];
    }
    if ((!SPEC_CONFORMANCE_BUILD_SHA_RE.test(runSha) || !sameBuildSha(runSha, normalizedCurrentBuildSha)) && !equivalentRows.has(row)) {
      return [`${row.file_path} (test-run commit ${runSha} does not match current build ${normalizedCurrentBuildSha}, test_runs #${row.id}${equivalenceProblems.has(row) ? '; ' + equivalenceProblems.get(row) : ''})`];
    }
    return [];
  });
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
  const latest = rows
    .map((row) => (row.finished_at instanceof Date ? row.finished_at.toISOString() : String(row.finished_at ?? '')))
    .sort()
    .at(-1);
  const measuredAt = latest || new Date().toISOString();
  const caseSelectors = input.cases ?? [];
  if (caseSelectors.length > 0) {
    const selectorFiles = new Set(caseSelectors.map((selector) => selector.file));
    const selectorProblems = [
      ...input.files.filter((file) => !selectorFiles.has(file)).map((file) => file + ' (no named case selector)'),
      ...caseSelectors
        .filter((selector) => !input.files.includes(selector.file))
        .map((selector) => selector.file + ' (named case selector is outside check.files)'),
    ];
    const invalidCaseRows = rows.flatMap((row) => {
      if (!selectorFiles.has(row.file_path)) return [];
      const details = parseTestRunExecutionDetails(row.execution_details);
      if (!details) {
        return [row.file_path + ' (missing or invalid execution details, test_runs #' + String(row.id) + ')'];
      }
      const reasons: string[] = [];
      if (row.status === 'error') reasons.push('test run status is error');
      if (details.filePath !== row.file_path) reasons.push('execution details file path mismatch');
      if (details.collectionFailed) reasons.push('test collection failed');
      if (row.worktree_dirty !== false || details.worktreeDirty) reasons.push('worktree was not proven clean');
      if (!row.commit_sha || details.commitSha !== row.commit_sha) reasons.push('commit SHA is absent or inconsistent');
      if (details.passed + details.failed === 0) reasons.push('no executed cases recorded');
      return reasons.length > 0
        ? [row.file_path + ' (' + reasons.join(', ') + ', test_runs #' + String(row.id) + ')']
        : [];
    });
    if (missing.length > 0 || stale.length > 0 || selectorProblems.length > 0 || invalidCaseRows.length > 0 || currentBuildProblems.length > 0) {
      const unavailable = [
        ...missing.map((file) => file + ' (no test-run ledger row)'),
        ...stale.map((row) => row.file_path + ' (stale test-run evidence, test_runs #' + String(row.id) + ')'),
        ...selectorProblems,
        ...invalidCaseRows,
        ...currentBuildProblems,
      ];
      return {
        kind: 'tests',
        verdict: 'error',
        value: null,
        unit: 'cases',
        measuredAt,
        detail: 'named test-case evidence unavailable, stale, or incomplete: ' + unavailable.join('; '),
      };
    }

    const loadCases = input.caseLoader ?? loadCriterionCheckCases;
    const recordedByFile = new Map<string, RecordedTestCase[] | null>();
    const outcomes = new Map<string, RecordedTestCase>();
    const caseProblems: string[] = [];
    for (const selector of caseSelectors) {
      const row = byFile.get(selector.file);
      if (!row) continue;
      const testRunId = Number(row.id);
      if (!Number.isSafeInteger(testRunId) || testRunId < 1) {
        caseProblems.push(selector.file + ' (invalid test-run id)');
        continue;
      }
      if (!recordedByFile.has(selector.file)) {
        try {
          recordedByFile.set(
            selector.file,
            await trackPhase(input.phases, `conformance:tests:cases:${testRunId}:${selector.file}`,
              () => loadCases({ testRunIds: [testRunId], file: selector.file })),
          );
        } catch (error) {
          caseProblems.push(
            selector.file + ' (per-case results could not be read: ' +
              (error instanceof Error ? error.message : String(error)) + ')',
          );
          continue;
        }
      }
      const resolution = resolveTestCaseFilter(selector, recordedByFile.get(selector.file));
      if (!resolution.ok) {
        caseProblems.push(selector.file + ' (' + resolution.message + ')');
        continue;
      }
      for (const result of resolution.matched) {
        outcomes.set(JSON.stringify([selector.file, result.caseKey, result.occurrence]), result);
      }
    }
    if (caseProblems.length > 0 || outcomes.size === 0) {
      return {
        kind: 'tests',
        verdict: 'error',
        value: null,
        unit: 'cases',
        measuredAt,
        detail: 'named test-case evidence unavailable or unresolved: ' +
          (caseProblems.length > 0 ? caseProblems.join('; ') : 'no selected cases were measured'),
      };
    }
    const measuredCases = [...outcomes.values()];
    const passingCases = measuredCases.filter((result) => result.status === 'pass');
    const failingCases = measuredCases.filter((result) => result.status === 'fail');
    return {
      kind: 'tests',
      verdict: failingCases.length > 0 ? 'fail' : 'pass',
      value: passingCases.length,
      unit: 'cases',
      measuredAt,
      ...(failingCases.length > 0
        ? { detail: 'failing: ' + failingCases.map((result) => result.caseKey).join('; ') }
        : {}),
    };
  }
  const runErrors = rows.filter((row) => row.status === 'error');
  const failing = rows.filter((row) => row.status === 'fail').map((row) => `${row.file_path} (fail, test_runs #${row.id})`);
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
  const passing = rows.length - failing.length;
  if (missing.length > 0 || stale.length > 0 || runErrors.length > 0 || unprovenPasses.length > 0 || currentBuildProblems.length > 0) {
    const unavailable = [
      ...missing.map((file) => `${file} (no test-run ledger row)`),
      ...stale.map((row) => `${row.file_path} (stale test-run evidence, test_runs #${row.id})`),
      ...runErrors.map((row) => `${row.file_path} (test run status is error, test_runs #${row.id})`),
      ...unprovenPasses,
      ...currentBuildProblems,
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
  phases?: PhaseTracker;
  /** Injectable probe dispatcher for focused tests; production uses the palette dispatcher. */
  dispatchTool?: Parameters<typeof rescoreProbeDispatcher>[1];
  /** Injectable probe evaluator for focused tests; production uses the continuity evaluator. */
  evaluateProbes?: typeof evaluateCriterionProbeChecks;
  /** Same realization data used by scorecard grading; injectable without replacing its judge. */
  readRequirementRealization?: RequirementRealizationReader;
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
  const contentEquivalence = createTestContentEquivalence();
  const readRequirementRealization: RequirementRealizationReader = input.readRequirementRealization ??
    (() => runWithWorkspace(input.workspaceId, async () => {
      const [activationAudit, itemAudits, planItems] = await Promise.all([
        getLatestActivationAudit(input.planSlug, { workspaceId: input.workspaceId, harnessSlug: input.harnessSlug }),
        getEffectiveItemAudits(input.planSlug),
        getPlanItemStatuses(input.planSlug, { harnessSlug: input.harnessSlug }),
      ]);
      // Reuse the scorecard reader's operational proof, without calling closure or
      // changing item status. A code audit can therefore be measured before close.
      const proof = itemAudits.some(({ entry }) => isNonCodeAuditVerdict(entry.verdict))
        // notify-classification: {"id":"packages/operator-core/lib/spec-conformance/conformance-run-deps.ts#<module>/productionConformanceDeps/<callback>/<callback>:85518d4eabe604a888a1:1","classification":"durable","reason":"Lifecycle evaluation can reach grading and owner notification paths; retain their terminal delivery requirement through this wrapper.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009","deliveryState":"unverified"}
        ? await (await import('../acceptance-bar-lifecycle-evaluator')).readAndEvaluateAcceptanceBarLifecycle(
            input.planSlug, 'pre-grading', { harnessSlug: input.harnessSlug },
          )
        : null;
      return { planSlug: input.planSlug, mappings: activationAudit?.activation?.mappings ?? [],
        itemAudits, planItems, nonCodeItemProofs: proof?.nonCodeItemProofs };
    }));
  return {
    phases: input.phases,
    async evaluateCheck(request: ConformanceCheckRequest) {
      const check = request.check;
      if (check.kind === 'tests') {
        const cases = check.cases ?? (
          check.testName === undefined
            ? undefined
            : [{ file: check.files[0]!, testName: check.testName }]
        );
        return judgeTestsFromLedger({
          files: check.files,
          workspaceId: input.workspaceId,
          phases: input.phases,
          contentEquivalence,
          ...(cases ? { cases } : {}),
        }, sql());
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
      if (check.kind === 'requirements') {
        const evaluation = await evaluateCriterionRequirementChecks({
          criteria: [{ key: request.checkId, check }],
          ratings: { [request.checkId]: { rating: 'unknown' } },
          readRequirementRealization,
        });
        if (!evaluation.ok) return {
          kind: 'requirements', verdict: 'error', value: null, unit: null, measuredAt: nowIso(),
          detail: `${evaluation.error}: ${evaluation.detail}`,
        };
        const run = evaluation.checkRuns[request.checkId];
        if (run?.kind !== 'requirements') return {
          kind: 'requirements', verdict: 'error', value: null, unit: null, measuredAt: nowIso(),
          detail: 'requirements check produced no realization measurement',
        };
        return { kind: 'requirements', verdict: run.verdict, value: run.unrealized,
          unit: 'unrealized requirements', measuredAt: run.measuredAt,
          detail: `${run.unrealized} of ${run.mappingsJudged} realizing mappings unverified; ` +
            `${run.checkedTargets} targets checked; ${run.exemptMappings} exempt mappings; ` +
            `${run.droppedTargets} dropped targets` +
            (run.unrealizedRequirements?.length ? `: ${run.unrealizedRequirements.join('; ')}` : '') };
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
