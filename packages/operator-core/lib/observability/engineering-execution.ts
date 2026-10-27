/** Reconcile reporter hints against the server's independently captured spans.
 * Neither a test result nor an OTel parent observes the named child boundary. */
import type { Sql } from 'postgres';
import { parseExecutionBoundaryReceipt, parseTestBoundaryObservations,
  type TestBoundaryObservation } from '@papercusp/test-config/execution-details';

export interface EngineeringExecutionObservation extends TestBoundaryObservation {
  runId: number;
  invocationId: string;
}
export interface EngineeringExecution {
  status: 'observed' | 'unobserved';
  /** These observations cover ONLY the named boundary, never its uninstrumented callees. */
  scope: 'instrumented-boundaries-only';
  observations: EngineeringExecutionObservation[];
  gaps: string[];
}

export async function readEngineeringExecution(scope: { workspaceId: string; harness: string }, runId: number,
  sql: Sql): Promise<EngineeringExecution> {
  const result: EngineeringExecution = { status: 'unobserved', scope: 'instrumented-boundaries-only', observations: [], gaps: [] };
  const gap = (reason: string) => { if (!result.gaps.includes(reason)) result.gaps.push(reason); };
  const [run] = await sql`SELECT commit_sha, started_at, finished_at, execution_details FROM harness_shared.test_runs
    WHERE workspace_id=${scope.workspaceId} AND harness_slug=${scope.harness} AND id=${runId}`;
  if (!run) { gap('execution-run-unavailable'); return result; }
  const details = run.execution_details;
  const hints = parseTestBoundaryObservations(details?.boundaryObservations);
  if (!hints?.length) { gap(details?.boundaryObservations === undefined ? 'execution-not-recorded' : 'execution-correlation-invalid'); return result; }
  const start = new Date(details?.runStartedAt ?? run.started_at).getTime();
  const end = new Date(run.finished_at).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    gap('execution-outside-run'); return result;
  }
  const identities = hints.map(({ caseKey, occurrence }) => ({ case_key: caseKey, occurrence }));
  const cases = await sql`SELECT case_key,occurrence FROM harness_shared.test_case_runs WHERE test_run_id=${runId}
    AND (case_key,occurrence) IN (SELECT case_key,occurrence
      FROM jsonb_to_recordset(${sql.json(identities)}::jsonb) AS requested(case_key text,occurrence integer)) LIMIT 33`;
  if (cases.length > 32) { gap('execution-case-limit'); return result; }
  const calls = [...new Set(hints.map(row => row.receipt.callId))];
  // The telemetry writer stamps dispatch settlement before the caller receives
  // its result, so a reporter-observed call settles inside this run's window.
  // Use the existing workspace/harness/time index before matching JSON call IDs;
  // historical tests may reuse a call label and must not pollute this run.
  const invocations = await sql`SELECT id::text, status, serving_build_sha, metadata_json->'otel' AS otel
    FROM harness_shared.tool_invocations WHERE workspace_id=${scope.workspaceId} AND harness_slug=${scope.harness}
      AND invoked_at >= ${new Date(start)} AND invoked_at <= ${new Date(end)}
      AND tool_name='graph:query' AND metadata_json->'otel'->>'callId'=ANY(${calls}::text[])
    ORDER BY id LIMIT 33`;
  if (invocations.length > 32) { gap('execution-invocation-limit'); return result; }
  const seen = new Set<string>();
  for (const hint of hints) {
    const receipt = hint.receipt;
    if (receipt.workspaceId !== scope.workspaceId || receipt.harness !== scope.harness) { gap('execution-scope-mismatch'); continue; }
    if (!cases.some(row => row.case_key === hint.caseKey && row.occurrence === hint.occurrence)) { gap('execution-case-mismatch'); continue; }
    const matches = invocations.filter(row => row.otel?.callId === receipt.callId);
    if (matches.length !== 1) { gap('execution-invocation-unresolved'); continue; }
    const invocation = matches[0]!;
    const recorded = Array.isArray(invocation.otel?.boundaryObservations)
      ? invocation.otel.boundaryObservations.map(parseExecutionBoundaryReceipt).filter(Boolean) : [];
    const own = recorded.filter((row: typeof receipt) => row?.spanId === receipt.spanId);
    if (own.length !== 1 || Object.keys(receipt).some(key =>
      receipt[key as keyof typeof receipt] !== own[0]![key as keyof typeof receipt])) {
      gap('execution-boundary-mismatch'); continue;
    }
    if (invocation.otel.traceId !== receipt.traceId || invocation.otel.spanId !== receipt.parentSpanId
      || !(receipt.traceFlags & 1) || !(invocation.otel.traceFlags & 1)) { gap('execution-trace-unobserved'); continue; }
    if (invocation.status !== receipt.outcome || receipt.outcome !== 'ok') { gap('execution-failed'); continue; }
    if (!receipt.buildSha || !run.commit_sha || !String(run.commit_sha).startsWith(receipt.buildSha)
      || invocation.serving_build_sha !== receipt.buildSha) { gap('execution-build-mismatch'); continue; }
    if (!Number.isFinite(start) || !Number.isFinite(end) || receipt.startedAt < start || receipt.endedAt > end) {
      gap('execution-outside-run'); continue;
    }
    const key = `${receipt.callId}:${receipt.spanId}`;
    if (seen.has(key)) { gap('execution-duplicate-correlation'); continue; }
    seen.add(key);
    result.observations.push({ ...hint, runId, invocationId: invocation.id });
  }
  if (result.observations.length) result.status = 'observed';
  return result;
}
