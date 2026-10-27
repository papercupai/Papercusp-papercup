/** P007: measured proposal/repair feedback shares the canonical results ledger. */
import { createHash } from 'node:crypto';
import { recordRubricCheckResults, type RubricCheckResult } from './check-results-ledger';
import { retainMeasurementProvenance } from './measurement-provenance';
import { evaluateSqlRepairOutcome, type SqlRepairMeasurement } from './bash-substitution/sql-census';
import type { SqlCandidateReviewResult } from './sql-tool-candidate-review';

export const SQL_FEEDBACK_RUBRIC = 'sql-tool-opportunity-feedback';
export const SQL_FEEDBACK_VERSION = 'sql-tool-feedback-v1';
/** One reusable workspace rubric; candidate identities stay in the source ledger, not its criteria. */
export function sqlFeedbackRubricDefinition(workspaceId: string) {
  if (!workspaceId.trim()) throw new Error('invalid_sql_feedback_scope');
  const workspace = workspaceId.replaceAll("'", "''");
  const criteria = ['proposal-quality', 'repair-outcome'].map(key => {
    // Retain every cohort member's latest result. A new passing candidate cannot mask another's failure.
    // Missing repair feedback for an accepted proposal is UNKNOWN, as are absent/stale observations.
    const sql = `WITH latest AS (
      SELECT DISTINCT ON (file_path) file_path,status,execution_details->'check'->>'criterionKey' AS key
      FROM harness_shared.test_runs
      WHERE workspace_id='${workspace}' AND source='local' AND framework='rubric-check'
        AND finished_at >= NOW() - INTERVAL '14 days' AND finished_at <= NOW()
        AND file_path ~ '^rubric-check/sql-tool-opportunity-feedback/[a-f0-9]{64}:(proposal-quality|repair-outcome):0$'
      ORDER BY file_path,finished_at DESC,id DESC
    ), cohort AS (
      ${key === 'proposal-quality' ? "SELECT status FROM latest WHERE key LIKE '%:proposal-quality'" : `SELECT COALESCE(r.status,'error') AS status FROM latest q
      LEFT JOIN latest r ON r.key=replace(q.key,':proposal-quality',':repair-outcome')
      WHERE q.key LIKE '%:proposal-quality' AND q.status='pass'`}
    ) SELECT CASE WHEN COUNT(*)=0 OR COUNT(*)>1000 THEN NULL
      WHEN BOOL_OR(status='fail') THEN 0
      WHEN BOOL_OR(status<>'pass') THEN NULL ELSE 1 END AS value FROM cohort`;
    return { key, title: key === 'proposal-quality' ? 'Proposal review quality' : 'Measured repair adoption',
      model: key === 'proposal-quality'
        ? 'Every proposal in the current 14-day workspace cohort has an accepted review; pending remains unknown and declined is a measured failure.'
        : 'Every accepted proposal in the current 14-day workspace cohort has complete normalized repair evidence and passes coverage and tool adoption.',
      method: 'Execute the scoped SQL probe over each candidate edition latest canonical ledger rows. Zero or more than 1000 members and incomplete evidence are unknown; any measured failure fails the cohort.',
      driftMarkers: 'A candidate failure is masked by another pass, missing evidence is graded healthy, or the scope/window/denominator is absent.',
      replication: 'Run npm run test:file -- packages/operator-core/lib/sql-tool-candidate-feedback.integration.test.ts; includes realPG scoped cohort failure, missing, repeat, and grading controls.',
      check: { kind: 'probe' as const, probe: { kind: 'sql' as const, sql, schemaRevision: 'live',
        maxRows: 1, expect: { path: '$.rows[0].value', op: 'gte' as const, value: 1 } } } };
  });
  return { rubricRef: SQL_FEEDBACK_RUBRIC, kind: 'standard' as const, characteristic: 'sql-tool-opportunity-feedback',
    title: 'SQL tool proposal quality and repair adoption', methodRef: 'agent-insights/repeat-measurements-are-rubric-checks',
    ratingScale: ['healthy', 'broken', 'unknown'], criteria };
}
export function sqlFeedbackIdentity(input: Pick<SqlCandidateFeedbackInput, 'workspaceId' | 'harnessSlug' | 'review'>): string {
  return createHash('sha256').update(JSON.stringify([input.workspaceId, input.harnessSlug,
    input.review.lifecycleId, input.review.editionId])).digest('hex');
}
export interface SqlCandidateFeedbackInput {
  workspaceId: string;
  harnessSlug: string;
  review: SqlCandidateReviewResult;
  sourceRef: { scopeId: string; ranOn: string };
  /** A verified exposure and fixed-shape measurement, never a review approval as a ship claim. */
  repair?: SqlRepairMeasurement | null;
  measuredAt?: string;
}
export async function recordSqlCandidateFeedback(input: SqlCandidateFeedbackInput,
  deps: { record?: typeof recordRubricCheckResults; client?: Parameters<typeof recordRubricCheckResults>[2] } = {}) {
  if (![input.workspaceId, input.harnessSlug, input.review.lifecycleId, input.review.editionId,
    input.sourceRef.scopeId].every(value => value?.trim())
    || !/^\d{4}-\d{2}-\d{2}$/.test(input.sourceRef.ranOn)
    || !Number.isFinite(Date.parse(input.sourceRef.ranOn))
    || new Date(input.sourceRef.ranOn).toISOString().slice(0, 10) !== input.sourceRef.ranOn)
    throw new Error('invalid_sql_feedback_scope');
  const measuredAt = input.measuredAt ?? new Date().toISOString();
  const measuredAtMs = Date.parse(measuredAt);
  if (!Number.isFinite(measuredAtMs) || measuredAtMs > Date.now()) throw new Error('invalid_sql_feedback_time');
  const identity = sqlFeedbackIdentity(input);
  const accepted = input.review.status === 'accepted';
  const quality = accepted ? true : input.review.status === 'declined' ? false : null;
  // A proposal may be accepted for implementation without having shipped. Preserve that unknown.
  const scopeMatches = input.repair?.baseline.scopeRef === `${input.workspaceId}/${input.harnessSlug}`
    && input.repair?.observation.scopeRef === `${input.workspaceId}/${input.harnessSlug}`;
  const outcome = accepted && input.repair && scopeMatches ? evaluateSqlRepairOutcome(input.repair, measuredAtMs) : {
    status: 'unknown' as const, disposition: 'insufficient-evidence' as const,
    baselineRate: null, observedRate: null, normalizedFall: null, adoptionRate: null,
  };
  const context = { version: SQL_FEEDBACK_VERSION, identity, sourceRef: input.sourceRef,
    workItemId: input.review.workItemId, reviewStatus: input.review.status, measurement: input.repair ?? null };
  const result = (key: string, value: boolean | null, detail: string): RubricCheckResult => ({
    check: { id: `${identity}:${key}:0`, rubricRef: SQL_FEEDBACK_RUBRIC, criterionKey: `${identity}:${key}`,
      kind: 'probe', value, unit: null, provenance: retainMeasurementProvenance({
        startedAt: measuredAt, finishedAt: measuredAt, procedure: context,
        result: { ...outcome, quality, disposition: detail },
      }) }, verdict: value === null ? 'error' : value ? 'pass' : 'fail', measuredAt, durationMs: null, detail,
  });
  const results = [result('proposal-quality', quality, input.review.status)];
  if (accepted) results.push(result('repair-outcome', outcome.status === 'unknown' ? null : outcome.status === 'healthy', outcome.disposition));
  const ids = await (deps.record ?? recordRubricCheckResults)(results,
    { workspaceId: input.workspaceId, harnessSlug: input.harnessSlug,
      commitSha: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.repair?.exposure?.build ?? '')
        ? input.repair!.exposure!.build : null }, deps.client);
  return { testRunIds: ids, outcome, quality };
}
