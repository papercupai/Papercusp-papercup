/** WI-10002233: artifact checks reuse the operational recorder; census proof stays pinned. */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { executeOperationalRun } from './agent-tools/testing/record-run';

export interface ReviewGradingAuditArtifact {
  records: Array<[string, string, string | null, number | null, string, string, string, string[]]>;
  traceability: {
    criterionCount: number;
    records: Array<{
      id: string; rubricRef: string | null; rubricRevision: number | null; observationMd5: string;
      implementationImpact: string; status: string; missingEdges: string[];
      ratings: Array<[string, string, string | null, number, string | null, string | null, string[], string[], string]>;
    }>;
  };
  measurementSpecification: {
    owner: string;
    baseline: { auditWindow: string[]; comparisonWindow: string };
    startWatermark: { name: string; state: string; value: string | null; source: string; rule: string };
    postWindow: string;
    metrics: Array<{ key: string; numerator: string; denominator: string; source: string; status: string; threshold: string }>;
    rolloutStages: Array<{ stage: string; condition: string; owner: string }>;
    recurrenceGuards: Array<{ key: string; threshold: string; liveSource: string; owner: string }>;
    replication: string;
  };
}

/** Validate recorded gaps, rather than turning missing edges into positive outcomes. */
export function validateReviewGradingArtifact(artifact: ReviewGradingAuditArtifact) {
  const fail = (condition: boolean, reason: string) => { if (!condition) throw new Error(reason); };
  const rows = artifact.records;
  fail(rows.length > 0 && rows.length <= 80 && new Set(rows.map(r => r[0])).size === rows.length,
    'audit_sample_identity_invalid');
  const traces = artifact.traceability.records;
  fail(traces.length === rows.length && new Set(traces.map(r => r.id)).size === rows.length,
    'audit_trace_population_mismatch');
  let criteria = 0;
  for (const row of rows) {
    const trace = traces.find(t => t.id === row[0]);
    fail(!!trace && trace.rubricRef === row[2] && trace.rubricRevision === row[3]
      && trace.observationMd5 === row[4], 'audit_trace_identity_mismatch');
    if (!trace) throw new Error('audit_trace_missing');
    const keys = trace.ratings.map(r => r[0]);
    fail(new Set(keys).size === keys.length && keys.length === row[7].length
      && row[7].every(k => keys.includes(k)), 'audit_criterion_population_mismatch');
    fail(trace.status === 'PARTIAL' && trace.implementationImpact === 'NOT-VERIFIED'
      && trace.missingEdges.includes('independentOutcomeReplay'), 'audit_unverified_impact_claim');
    fail(row[3] !== null || trace.missingEdges.includes('rubricRevision'), 'audit_revision_gap_hidden');
    for (const rating of trace.ratings) {
      const disposition = rating[4] ? 'recorded-remediation' : rating[5] ? 'recorded-disregard' : 'NOT-RECORDED';
      fail(rating[8] === disposition, 'audit_disposition_invented');
      const refs = [...new Set((rating[4] ?? '').match(/(?:WI|EI)-[0-9]+/g) ?? [])].sort();
      fail(JSON.stringify(refs) === JSON.stringify(rating[6]), 'audit_remediation_link_invented');
    }
    fail(!trace.ratings.some(r => !r[4] && !r[5]) || trace.missingEdges.includes('recordedDisposition'),
      'audit_disposition_gap_hidden');
    criteria += keys.length;
  }
  fail(criteria === artifact.traceability.criterionCount, 'audit_criterion_count_mismatch');
  const spec = artifact.measurementSpecification;
  fail(!!spec.owner && spec.baseline.auditWindow.length === 2 && !!spec.baseline.comparisonWindow
    && !!spec.startWatermark.name && !!spec.startWatermark.source && !!spec.startWatermark.rule
    && !!spec.postWindow && !!spec.replication, 'audit_measurement_window_missing');
  fail(spec.startWatermark.state !== 'NOT-STARTED' || spec.startWatermark.value === null,
    'audit_activation_receipt_invented');
  const required = ['useful-finding-rate', 'repeated-grades', 'stale-invalidations',
    'unlinked-poor-ratings', 'tool-calls', 'elapsed-tool-time'];
  fail(spec.metrics.length === required.length && new Set(spec.metrics.map(m => m.key)).size === required.length,
    'audit_measurement_metric_population_mismatch');
  for (const key of required) {
    const metric = spec.metrics.find(m => m.key === key);
    const guard = spec.recurrenceGuards.find(g => g.key === key);
    fail(!!metric?.numerator && !!metric.denominator && !!metric.source && !!metric.threshold
      && !!guard?.threshold && !!guard.liveSource && !!guard.owner, 'audit_measurement_metric_or_guard_missing');
    if (key === 'tool-calls' || key === 'elapsed-tool-time') {
      fail(metric?.status === 'NOT-MEASURED', 'audit_unattributed_cost_invented');
    }
  }
  fail(spec.rolloutStages.length >= 3 && spec.rolloutStages.every(s => !!s.stage && !!s.condition && !!s.owner),
    'audit_rollout_missing');
  return { records: rows.length, criteria, metrics: required.length };
}

/** Re-read only preserved identities: no resampling, current-rubric backfill or mutation. */
export async function readReviewGradingArtifact(sql: Sql, args: {
  workspaceId: string; artifact: ReviewGradingAuditArtifact; expectedDatabase: string; expectedPort: number;
}) {
  const checked = validateReviewGradingArtifact(args.artifact);
  return sql.begin('isolation level repeatable read read only', async tx => {
    await tx`SET LOCAL statement_timeout = '10000ms'`;
    const [control] = await tx<{ database: string; port: number }[]>`
      SELECT current_database() AS database, inet_server_port() AS port`;
    if (control.database !== args.expectedDatabase || control.port !== args.expectedPort) {
      throw new Error('audit_database_identity_mismatch');
    }
    const cards = await tx<{ id: string; hash: string; observation: {
      rubricRef?: string; rubricRevision?: number; ratings?: Record<string, {
        rating?: string; evidence?: string; remediation?: string; disregard?: string;
      }>;
    } }[]>`SELECT issue_id AS id, md5((payload->'observation')::text) AS hash,
      payload->'observation' AS observation FROM harness_shared.engineer_issues
      WHERE workspace_id=${args.workspaceId} AND issue_id IN
      (SELECT jsonb_array_elements_text(${JSON.stringify(args.artifact.records.map(r => r[0]))}::text::jsonb))`;
    const assertions = args.artifact.traceability.records.map(trace => {
      const card = cards.find(c => c.id === trace.id);
      const ratings = card?.observation.ratings ?? {};
      const exact = !!card && card.hash === trace.observationMd5
        && card.observation.rubricRef === trace.rubricRef
        && (card.observation.rubricRevision ?? null) === trace.rubricRevision
        && Object.keys(ratings).length === trace.ratings.length
        && trace.ratings.every(r => {
          const stored = ratings[r[0]];
          const text = stored?.evidence ?? '';
          // The artifact counts Unicode code points; paging offsets remain UTF-16.
          return stored?.rating === r[1] && [...text].length === r[3]
            && (text ? createHash('sha256').update(text).digest('hex') : null) === r[2]
            && (stored.remediation ?? null) === r[4] && (stored.disregard ?? null) === r[5];
        });
      return { id: `artifact-${trace.id}`, passed: exact,
        evidence: card ? `canonical observation MD5=${card.hash}; exact persisted criterion edges=${exact}` : 'canonical card missing' };
    });
    return { control, checked, assertions };
  });
}

export async function executeReviewGradingArtifactReplay(sql: Sql, args: {
  workspaceId: string; harnessSlug: string; projectDir: string; runtimeUnits: string[];
  artifactPath: string; artifact: ReviewGradingAuditArtifact; expectedDatabase: string; expectedPort: number;
}) {
  await sql`SELECT 1`;
  return executeOperationalRun({
    filePath: args.artifactPath, name: 'Preserved review audit judgments, trace chains and measurement specification',
    framework: 'operational', command: ['executeReviewGradingArtifactReplay', args.artifactPath, args.workspaceId],
    runtimeUnits: args.runtimeUnits,
    run: async () => {
      const result = await readReviewGradingArtifact(sql, args);
      return { exitCode: result.assertions.every(a => a.passed) ? 0 : 1,
        assertions: result.assertions,
        summary: JSON.stringify({ ...result.checked, database: result.control,
          scope: 'Canonical observation identity and recorded trace/specification only; no independent implementation-impact or acceptance verdict.' }) };
    },
  }, { workspaceId: args.workspaceId, harnessSlug: args.harnessSlug, projectDir: args.projectDir });
}

