/** Internal, scoped shipment-evidence reader. Inputs identify records; they never
 * supply a schedule, runtime, candidate, review verdict or test result. */
import { createHash } from 'node:crypto';
import { DBOS, type WorkflowStatus } from '@dbos-inc/dbos-sdk';
import { getOrgPg } from '@papercusp/db-org';
import type { SqlMiningOptions } from '../bash-substitution/sql-tool-candidates';
import { readMonitoredFireSnapshot } from '../harness/routines/fire-provenance';
import { AGGREGATE_LIFETIME_DAYS, miningScopeId } from './privacy';
import { boundedStage, MONITORED_FAMILIES, type MonitoredFamily, type MonitoredRunEvidence } from './pipeline';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const iso = (value: unknown): string | null => {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const digest = (value: unknown, size: number): value is string => typeof value === 'string'
  && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
type WorkflowStep = { functionID: number; name: string; output: unknown; error: unknown };
/** Trusted dependency seam for maintained tests. Production uses the SDK, which
 * decodes DBOSJSON (including SuperJSON), portable JSON and configured serializers.
 * JSON.parse on operation_outputs would silently accept the wrong envelope. */
export interface MonitoredWorkflowReader {
  status(id: string): Promise<Pick<WorkflowStatus, 'workflowID' | 'workflowName' | 'status' | 'input'> | null>;
  steps(id: string): Promise<readonly WorkflowStep[] | undefined>;
}
const workflows: MonitoredWorkflowReader = {
  status: id => DBOS.getWorkflowStatus(id),
  steps: id => DBOS.listWorkflowSteps(id, { limit: 129 }),
};
export interface MonitoredRunReadOptions extends SqlMiningOptions { runId: string }
export type MonitoredRunReadResult = { status: 'read'; evidence: MonitoredRunEvidence; refs: string[] }
  | { status: 'UNKNOWN'; reasons: string[] };

/** Native test-ledger correlation, set before the maintained deployed test starts.
 * The reader additionally requires its case row, clean SHA and enclosing times.
 * This identifier alone is never evidence of an executed or passing test. */
export function monitoredTestRunGroup(runId: string, runtime: string): string {
  return 'sql-intent-monitored:' + createHash('sha256').update(JSON.stringify([runId, runtime])).digest('hex');
}

export async function readMonitoredRunEvidence(opts: MonitoredRunReadOptions,
  deps: { workflow?: MonitoredWorkflowReader } = {}): Promise<MonitoredRunReadResult> {
  const unknown = (reason: string): MonitoredRunReadResult => ({ status: 'UNKNOWN', reasons: [reason] });
  if (opts.workspaceId !== opts.scope.workspaceId || !opts.harnessSlug
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(opts.runId)) return unknown('invalid-scope-or-run');
  const sql = opts.client ?? getOrgPg().sql, scopeId = miningScopeId(opts.scope, opts.harnessSlug);
  const allowed = () => opts.authorize({ workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug,
    sourceBoundary: opts.scope.sourceBoundary });
  try { return await boundedStage(async (): Promise<MonitoredRunReadResult> => {
    if (!await allowed()) return unknown('scope-denied');
    const load = () => sql`SELECT run_id::text,workspace_id,harness_slug,routine_id,workflow_id,
      source_sha,runtime_id,started_at,finished_at FROM harness_shared.sql_intent_runs
      WHERE workspace_id=${opts.workspaceId} AND harness_slug=${opts.harnessSlug} AND scope_id=${scopeId}
        AND run_id=${opts.runId}::uuid AND finished_at IS NOT NULL
        AND started_at > ${new Date((opts.now ?? Date.now()) - AGGREGATE_LIFETIME_DAYS * 86400_000).toISOString()}::timestamptz`;
    const [run] = await load();
    if (!run || !run.routine_id || !run.workflow_id || !digest(run.source_sha, 40)
      || typeof run.runtime_id !== 'string' || !run.runtime_id.trim()) return unknown('run-identity-missing');
    const reader = deps.workflow ?? workflows;
    const status = await reader.status(run.workflow_id), steps = await reader.steps(run.workflow_id);
    if (!status || status.workflowID !== run.workflow_id || status.workflowName !== 'routineFire'
      || status.status !== 'SUCCESS' || !Array.isArray(status.input) || status.input.length !== 10
      || !steps || steps.length >= 129) return unknown('workflow-evidence-missing-or-truncated');
    const input = status.input, provenance = input[9];
    if (input[0] !== run.routine_id || input[1] !== opts.workspaceId || input[2] !== opts.harnessSlug
      || input[3] !== 'system:sql-read-census' || !record(provenance) || provenance.version !== 1
      || !['scheduler', 'manual'].includes(String(provenance.origin)) || !digest(provenance.configHash, 64))
      return unknown('workflow-scope-or-origin');
    const startRows = steps.filter(s => s.name === 'routine-fire-start');
    const finishRows = steps.filter(s => s.name === 'routine-fire-finish');
    if (startRows.length !== 1 || finishRows.length !== 1) return unknown('workflow-boundaries-missing-or-duplicate');
    const start = startRows[0]!, finish = finishRows[0]!;
    if (start.error || finish.error || start.functionID >= finish.functionID
      || !record(start.output) || !record(finish.output)) return unknown('workflow-boundaries-invalid');
    const first = start.output, last = finish.output, before = first.snapshot, after = last.snapshot;
    const provenanceMatches = (p: unknown) => record(p) && p.version === 1 && p.origin === provenance.origin
      && p.scheduledAt === provenance.scheduledAt && p.configHash === provenance.configHash;
    const snapshotMatches = (s: unknown): s is RecordValue => record(s) && s.workspaceId === opts.workspaceId
      && s.harnessSlug === opts.harnessSlug && s.routineId === run.routine_id && s.targetRole === 'system:sql-read-census'
      && s.sha === run.source_sha && s.runtime === run.runtime_id && s.configHash === provenance.configHash
      && s.active === true && typeof s.expression === 'string' && !!s.expression.trim()
      && typeof s.timezone === 'string' && !!s.timezone.trim() && !!iso(s.observedAt);
    if (first.routineId !== run.routine_id || first.workspaceId !== opts.workspaceId || first.installSlug !== opts.harnessSlug
      || first.targetRole !== 'system:sql-read-census' || !provenanceMatches(first.provenance)
      || !provenanceMatches(last.provenance) || !snapshotMatches(before) || !snapshotMatches(after))
      return unknown('boundary-scope-runtime-or-schedule-drift');
    const startedAt = iso(run.started_at), finishedAt = iso(run.finished_at), dueAt = iso(provenance.scheduledAt);
    if (!startedAt || !finishedAt || !dueAt || Date.parse(String(before.observedAt)) > Date.parse(startedAt)
      || Date.parse(String(after.observedAt)) < Date.parse(finishedAt)) return unknown('boundary-timing-or-due-slot');
    // Current canonical definition must still agree. A retained old receipt does
    // not certify a paused, deleted, retuned or re-scoped routine.
    const current = await readMonitoredFireSnapshot(sql, opts.workspaceId, run.routine_id);
    if (!current || !current.active || current.harnessSlug !== opts.harnessSlug || current.targetRole !== 'system:sql-read-census'
      || current.configHash !== provenance.configHash || current.expression !== before.expression
      || before.expression !== after.expression || current.timezone !== before.timezone || before.timezone !== after.timezone)
      return unknown('current-schedule-drift');
    const loadFamilies = () => sql`SELECT family,coverage,scanned,qualifying,diagnostics
      FROM harness_shared.sql_intent_family_runs WHERE workspace_id=${opts.workspaceId} AND run_id=${opts.runId}::uuid
      ORDER BY family LIMIT 6`;
    const families = await loadFamilies();
    if (families.length !== MONITORED_FAMILIES.length || MONITORED_FAMILIES.some(f => families.filter(r => r.family === f).length !== 1))
      return unknown('family-population-missing-or-duplicate');
    const familyRows: MonitoredRunEvidence['families'] = [];
    for (const row of families) {
      const candidates = record(row.diagnostics) ? row.diagnostics.candidates : undefined;
      if (!Array.isArray(candidates) || candidates.some(c => !record(c) || !digest(c.id, 64))
        || !['measured', 'missing', 'unsupported', 'truncated', 'UNKNOWN'].includes(row.coverage))
        return unknown('family-evidence-invalid');
      familyRows.push({ runId: run.run_id, sha: run.source_sha, runtime: run.runtime_id, family: row.family,
        enabled: true, coverage: row.coverage, scanned: row.scanned, qualifying: row.qualifying,
        plantedCandidateIds: candidates.filter(c => c.reviewEligible === true).map(c => c.id as string) });
    }
    // Approval is grounded in the native grading ledger AND the applied round,
    // not a work-item success boolean or the filer's original assignment.
    const loadReviews = () => sql`SELECT w.feature_id, w.taken_by, w.payload->'monitoredCandidateReview' AS pointer,
      w.payload->'agentReview' AS review, g.idea_id,g.human_grade,g.graded_by,g.graded_at
      FROM harness_shared.work_items w JOIN harness_shared.scout_routed_ideas g
        ON g.workspace_id=w.workspace_id AND g.harness_slug=w.harness_slug AND g.routed_ref='wi:'||w.feature_id
          AND g.idea_id=w.payload->'agentReview'->>'ledgerIdeaId'
      JOIN harness_shared.sql_candidate_reviews r ON r.workspace_id=w.workspace_id AND r.harness_slug=w.harness_slug
        AND r.artifact_id=w.feature_id AND NOT r.suppressed
        AND r.lifecycle_id=w.payload->'monitoredCandidateReview'->>'lifecycleId'
        AND r.edition_id=w.payload->'monitoredCandidateReview'->>'editionId'
      WHERE w.workspace_id=${opts.workspaceId} AND w.harness_slug=${opts.harnessSlug}
        AND w.payload->'monitoredCandidateReview'->>'runId'=${opts.runId}
      ORDER BY w.feature_id LIMIT 257`;
    const reviews = await loadReviews();
    if (reviews.length >= 257) return unknown('review-evidence-truncated');
    const reviewRows: MonitoredRunEvidence['reviews'] = reviews.flatMap(r => {
      const p = r.pointer, review = r.review;
      if (!record(p) || !record(review) || review.status !== 'approved'
        || !Number.isSafeInteger(review.round) || Number(review.round) < 1
        || !Number.isInteger(Number(r.human_grade)) || Number(r.human_grade) < 4 || Number(r.human_grade) > 5
        || !r.graded_by || !r.graded_at || !record(review.timing) || review.timing.round !== review.round
        || !iso(review.timing.enteredAt)
        || !iso(review.timing.decidedAt) || !iso(r.graded_at)
        || Date.parse(iso(r.graded_at)!) < Date.parse(iso(review.timing.enteredAt)!)
        || Date.parse(iso(r.graded_at)!) > Date.parse(iso(review.timing.decidedAt)!)
        || !familyRows.some(f => f.family === p.family && f.plantedCandidateIds.includes(String(p.candidateId)))) return [];
      return [{ runId: run.run_id, family: p.family as MonitoredFamily, candidateId: String(p.candidateId),
        workItemId: r.feature_id, transitionId: `agent-review:${r.idea_id}:${review.round}:${iso(r.graded_at)}`,
        outcome: 'accepted' as const, owner: r.taken_by ?? r.graded_by }];
    });
    const group = monitoredTestRunGroup(run.run_id, run.runtime_id);
    const loadTests = () => sql`SELECT t.id::text,t.file_path,t.commit_sha,c.case_key
      FROM harness_shared.test_runs t JOIN harness_shared.test_case_runs c ON c.test_run_id=t.id
      WHERE t.workspace_id=${opts.workspaceId} AND t.harness_slug=${opts.harnessSlug}
        AND t.run_group_id=${group} AND t.status='pass' AND c.status='pass' AND c.case_key='R13-DEPLOYED'
        AND t.file_path='packages/operator-core/lib/agent-opportunities/pipeline.deployed.integration.test.ts'
        AND t.commit_sha=${run.source_sha} AND t.worktree_dirty=false AND t.is_scratch_config=false
        AND t.execution_details->>'testLayer'='integration' AND t.execution_details->>'skipped'='0'
        AND t.started_at<=${startedAt}::timestamptz AND t.finished_at>=${finishedAt}::timestamptz
      ORDER BY t.id LIMIT 33`;
    const tests = await loadTests();
    if (tests.length >= 33) return unknown('test-evidence-truncated');
    // A stable parent alone cannot certify independently mutable children,
    // review grades/reservations or native test rows. Re-read the same bounded,
    // ordered joins so a revocation/deletion during hydration fails closed.
    const [finalFamilies, finalReviews, finalTests] = await Promise.all([
      loadFamilies(), loadReviews(), loadTests(),
    ]);
    if (JSON.stringify(finalFamilies) !== JSON.stringify(families)
      || JSON.stringify(finalReviews) !== JSON.stringify(reviews)
      || JSON.stringify(finalTests) !== JSON.stringify(tests)) return unknown('normalized-evidence-changed');
    const [sameRun] = await load();
    const finalSchedule = await readMonitoredFireSnapshot(sql, opts.workspaceId, run.routine_id);
    if (JSON.stringify(sameRun) !== JSON.stringify(run) || !finalSchedule || !finalSchedule.active
      || finalSchedule.configHash !== current.configHash || !await allowed()) return unknown('evidence-changed-or-revoked');
    const schedule = (s: RecordValue) => ({ id: run.routine_id as string, configHash: s.configHash as string,
      active: s.active === true, paused: s.active !== true, expression: s.expression as string,
      timezone: s.timezone as string, dueAt });
    return { status: 'read', evidence: {
      run: { id: run.run_id, workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug,
        routineId: run.routine_id, configHash: provenance.configHash, operationId: `${run.workflow_id}:${start.functionID}`,
        trigger: provenance.origin as 'scheduler' | 'manual', scheduledAt: dueAt, startedAt, finishedAt,
        sha: run.source_sha, runtime: run.runtime_id },
      runtimeBefore: { sha: before.sha as string, runtime: before.runtime as string },
      runtimeAfter: { sha: after.sha as string, runtime: after.runtime as string },
      scheduleBefore: schedule(before), scheduleAfter: schedule(after),
      expectedSchedule: { id: current.routineId, expression: current.expression!, timezone: current.timezone },
      families: familyRows, reviews: reviewRows,
      testRuns: tests.map(t => ({ id: t.id, runId: run.run_id, sha: t.commit_sha, runtime: run.runtime_id,
        result: 'passed' as const, file: t.file_path, caseName: t.case_key })),
    }, refs: [`sql-intent-run:${opts.workspaceId}:${run.run_id}`, `dbos-workflow:${run.workflow_id}`,
      ...reviewRows.map(r => r.transitionId), ...tests.map(t => `test-run:${t.id}`)] };
  }, Math.min(30_000, Math.max(1, opts.timeBudgetMs ?? 5000))); }
  catch { return unknown('canonical-evidence-unavailable'); }
}
