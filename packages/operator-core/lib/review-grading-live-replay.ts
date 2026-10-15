/** WI-10002233: live census replay through the existing operational-run ledger. */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { executeOperationalRun } from './agent-tools/testing/record-run';

export const REVIEW_AUDIT_STRATA = [
  'independent-acceptance', 'author-acceptance', 'rubric-vetting', 'grading-integrity',
  'ordinary-code-review', 'other-rubric-assessments', 'unresolved-rubric',
] as const;
export type ReviewAuditStratum = typeof REVIEW_AUDIT_STRATA[number];
export type ReviewAuditPopulation = Record<ReviewAuditStratum, number>;

/** Rubric names outside known families never establish code-review provenance. */
export function reviewAuditStratum(row: { rubricRef: string; rubricKind: string | null; acceptance: unknown }): ReviewAuditStratum {
  if (row.rubricRef === 'meta-acceptance-rubric') return 'rubric-vetting';
  if (row.rubricRef.includes('grading-integrity')) return 'grading-integrity';
  if (row.rubricKind === null) return 'unresolved-rubric';
  if (row.rubricKind === 'acceptance') {
    if (row.acceptance === null || row.acceptance === undefined) return 'independent-acceptance';
    return typeof row.acceptance === 'object' && !Array.isArray(row.acceptance)
      ? 'author-acceptance' : 'unresolved-rubric';
  }
  return 'other-rubric-assessments';
}

/** Reserve one record per populated stratum, then apportion remaining capacity. */
export function reviewAuditQuotas(population: ReviewAuditPopulation, requested: number): ReviewAuditPopulation {
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > 80) throw new Error('sample_size_invalid');
  for (const n of Object.values(population)) {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('population_invalid');
  }
  const nonempty = REVIEW_AUDIT_STRATA.filter(s => population[s] > 0);
  const total = Object.values(population).reduce((a, b) => a + b, 0);
  const target = Math.min(requested, total);
  if (target < nonempty.length) throw new Error('sample_cannot_cover_populated_strata');
  const quotas = Object.fromEntries(REVIEW_AUDIT_STRATA.map(s => [s, 0])) as ReviewAuditPopulation;
  const capacity = total - nonempty.length;
  const remainder = target - nonempty.length;
  const fractions: Array<{ stratum: ReviewAuditStratum; fraction: number }> = [];
  for (const stratum of nonempty) {
    const share = capacity ? remainder * (population[stratum] - 1) / capacity : 0;
    quotas[stratum] = 1 + Math.floor(share);
    fractions.push({ stratum, fraction: share - Math.floor(share) });
  }
  fractions.sort((a, b) => b.fraction - a.fraction || a.stratum.localeCompare(b.stratum));
  let left = target - Object.values(quotas).reduce((a, b) => a + b, 0);
  for (const { stratum } of fractions) {
    if (left && quotas[stratum] < population[stratum]) { quotas[stratum]++; left--; }
  }
  if (left) throw new Error('quota_allocation_incomplete');
  return quotas;
}

// Rubric kinds come from canonical rubric-template plans, not prefix guesses.
// Conflicting/missing metadata gets its own cell; the residual cell is explicit.
const FRAME_SQL = `WITH scorecard_base AS (
  SELECT e.issue_id AS id, e.created_at, e.payload->'observation' AS o,
    (SELECT CASE WHEN count(DISTINCT COALESCE(p.template_data->>'kind','standard'))=1
      THEN min(COALESCE(p.template_data->>'kind','standard')) END
      FROM harness_shared.harness_plans p WHERE p.workspace_id=$1
      AND p.template='rubric' AND p.plan_slug=e.payload->'observation'->>'rubricRef') AS rubric_kind
  FROM harness_shared.engineer_issues e WHERE e.workspace_id=$1
    AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz
    AND COALESCE(e.signal_origin,'organic')='organic'
    AND e.payload->'observation'->>'synthesized' IS DISTINCT FROM 'true'
    AND e.payload->'observation'->>'rubricRef' IS NOT NULL
), scorecards AS (
  SELECT id, created_at, o->>'rubricRef' AS rubric_ref, rubric_kind, md5(o::text) AS payload_hash,
    CASE WHEN o->>'rubricRef'='meta-acceptance-rubric' THEN 'rubric-vetting'
      WHEN position('grading-integrity' in o->>'rubricRef') > 0 THEN 'grading-integrity'
      WHEN rubric_kind IS NULL THEN 'unresolved-rubric'
      WHEN rubric_kind='acceptance' AND jsonb_typeof(o->'acceptance')='object' THEN 'author-acceptance'
      WHEN rubric_kind='acceptance' AND o->>'acceptance' IS NULL THEN 'independent-acceptance'
      WHEN rubric_kind='acceptance' THEN 'unresolved-rubric'
      ELSE 'other-rubric-assessments' END AS stratum, 'engineer_issues' AS source
  FROM scorecard_base
), ordinary AS (
  SELECT 'PR:'||harness_slug||':'||pr_number||':'||head_sha AS id, reviewed_at AS created_at,
    NULL::text AS rubric_ref, NULL::text AS rubric_kind,
    md5(jsonb_build_object('recommendation',recommendation,'summary',summary,'rationale',rationale)::text) AS payload_hash,
    'ordinary-code-review' AS stratum, 'pr_review_reports' AS source
  FROM harness_shared.pr_review_reports WHERE workspace_id=$1
    AND reviewed_at >= $2::timestamptz AND reviewed_at < $3::timestamptz
), frame AS (SELECT * FROM scorecards UNION ALL SELECT * FROM ordinary)`;

export interface ReviewAuditSampleRow {
  id: string; stratum: ReviewAuditStratum; source: string; rubric_ref: string | null;
  rubric_kind: string | null; payload_hash: string; draw_rank: number;
}

export async function readReviewGradingCensus(sql: Sql, args: {
  workspaceId: string; lowerBound: string; upperBound: string; seed: string; sampleSize: number;
}) {
  if (!args.workspaceId.trim() || !args.seed.trim()) throw new Error('scope_or_seed_missing');
  if (!Number.isFinite(Date.parse(args.lowerBound)) || !Number.isFinite(Date.parse(args.upperBound))
    || Date.parse(args.lowerBound) >= Date.parse(args.upperBound)) throw new Error('window_invalid');
  return sql.begin('isolation level repeatable read read only', async tx => {
    await tx`SET LOCAL statement_timeout = '10000ms'`;
    const [control] = await tx<{ database: string; port: number; reports_relation: string | null;
      audit_relation: string | null; scorecard_control: boolean }[]>`
      SELECT current_database() AS database, inet_server_port() AS port,
        to_regclass('harness_shared.pr_review_reports')::text AS reports_relation,
        to_regclass('harness_shared.auto_review_audit')::text AS audit_relation,
        EXISTS(SELECT 1 FROM harness_shared.engineer_issues WHERE workspace_id=${args.workspaceId}
          AND payload->'observation'->>'rubricRef' IS NOT NULL) AS scorecard_control`;
    if (!control?.reports_relation || !control.audit_relation || !control.scorecard_control) {
      throw new Error('review_source_positive_control_failed');
    }
    const values = [args.workspaceId, args.lowerBound, args.upperBound];
    const counts = await tx.unsafe<{ stratum: ReviewAuditStratum; records: number }[]>(
      FRAME_SQL + ' SELECT stratum,count(*)::int AS records FROM frame GROUP BY stratum', values);
    const population = Object.fromEntries(REVIEW_AUDIT_STRATA.map(s => [s, 0])) as ReviewAuditPopulation;
    for (const row of counts) {
      if (!REVIEW_AUDIT_STRATA.includes(row.stratum)) throw new Error('unrecognized_frame_stratum');
      population[row.stratum] = row.records;
    }
    const quotas = reviewAuditQuotas(population, args.sampleSize);
    const sample = await tx.unsafe<ReviewAuditSampleRow[]>(FRAME_SQL + `,
      quotas AS (SELECT * FROM jsonb_to_recordset($4::text::jsonb) AS q(stratum text,quota int)),
      ranked AS (SELECT frame.*,row_number() OVER (PARTITION BY frame.stratum
        ORDER BY md5(id||$5),id)::int AS draw_rank FROM frame)
      SELECT id,ranked.stratum,source,rubric_ref,rubric_kind,payload_hash,draw_rank
      FROM ranked JOIN quotas USING(stratum) WHERE draw_rank <= quota
      ORDER BY ranked.stratum,draw_rank LIMIT 80`, [...values,
        JSON.stringify(REVIEW_AUDIT_STRATA.map(stratum => ({ stratum, quota: quotas[stratum] }))), args.seed]);
    const [audit] = await tx<{ records: number }[]>`SELECT count(*)::int AS records
      FROM harness_shared.auto_review_audit WHERE workspace_id=${args.workspaceId}
      AND ts >= ${args.lowerBound}::timestamptz AND ts < ${args.upperBound}::timestamptz`;
    return { control, population, quotas, sample, autoReviewAuditRows: audit.records,
      workspaceId: args.workspaceId, lowerBound: args.lowerBound, upperBound: args.upperBound, seed: args.seed };
  });
}

export async function executeReviewGradingReplay(sql: Sql, args: {
  workspaceId: string; harnessSlug: string; projectDir: string; runtimeUnits: string[];
  lowerBound: string; upperBound: string; seed: string; sampleSize: number;
}) {
  let census: Awaited<ReturnType<typeof readReviewGradingCensus>> | undefined;
  // Prewarm the existing DB/recorder graph before its finite runtime observation.
  await sql`SELECT 1`;
  const result = await executeOperationalRun({
    filePath: 'packages/operator-core/lib/review-grading-live-replay.ts',
    name: 'Review/grading frozen live census and stratified sample', framework: 'operational',
    command: ['executeReviewGradingReplay', args.workspaceId, args.lowerBound, args.upperBound,
      args.seed, String(args.sampleSize)], runtimeUnits: args.runtimeUnits,
    run: async () => {
      census = await readReviewGradingCensus(sql, args);
      const total = Object.values(census.population).reduce((a,b) => a+b,0);
      const target = Object.values(census.quotas).reduce((a,b) => a+b,0);
      const assertions = [
        { id: 'bounded-sample-size', passed: census.sample.length === target,
          evidence: `${census.sample.length} sampled; ${target} allocated; ${total} frame records` },
        { id: 'sample-identities-unique', passed: new Set(census.sample.map(r=>r.id)).size === target,
          evidence: 'Exact preserved identities across all sampled strata' },
        { id: 'ordinary-code-review-provenance',
          passed: census.sample.filter(r=>r.stratum==='ordinary-code-review').every(r=>r.source==='pr_review_reports'),
          evidence: `${census.population['ordinary-code-review']} real PR review records; residual rubric assessments remain separate` },
        ...REVIEW_AUDIT_STRATA.map(stratum => ({ id: `quota-${stratum}`,
          passed: census!.sample.filter(r=>r.stratum===stratum).length === census!.quotas[stratum],
          evidence: `population=${census!.population[stratum]}, quota=${census!.quotas[stratum]}` })),
        ...census.sample.map(row=>({ id: `sample-${row.id}`, passed: row.draw_rank <= census!.quotas[row.stratum],
          evidence: `${row.stratum}; ${row.source}; ${row.rubric_ref ?? 'PR review'}; payload-md5=${row.payload_hash}` })),
      ];
      return { exitCode: assertions.every(a=>a.passed) ? 0 : 1,
        summary: JSON.stringify({ window: [args.lowerBound,args.upperBound], seed: args.seed,
          population: census.population, quotas: census.quotas, autoReviewAuditRows: census.autoReviewAuditRows,
          sampleSha256: createHash('sha256').update(JSON.stringify(census.sample)).digest('hex'),
          coverageNote: 'This checks execution and sampling, not substantive classification or the acceptance verdict.' }), assertions };
    },
  }, { workspaceId: args.workspaceId, harnessSlug: args.harnessSlug, projectDir: args.projectDir });
  return { ...result, census };
}
