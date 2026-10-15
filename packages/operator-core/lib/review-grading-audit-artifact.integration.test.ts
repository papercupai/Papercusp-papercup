import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertPgReachable } from '@papercusp/test-config/pg';
import type {} from '@papercusp/test-config';
import { readReviewGradingArtifact, type ReviewGradingAuditArtifact } from './review-grading-audit-artifact';

const ws=`review-artifact-${randomUUID()}`;
const other=`${ws}-other`;
let sql: postgres.Sql;

async function cleanup() {
  await sql`DELETE FROM harness_shared.pr_review_reports WHERE workspace_id IN (${ws},${other})`;
  await sql`DELETE FROM harness_shared.engineer_issues WHERE workspace_id IN (${ws},${other})`;
  await sql`DELETE FROM harness_shared.harness_plans WHERE workspace_id=${ws}`;
}

beforeAll(async()=>{
  const dsn=inject('baselineSchemaDsn');
  await assertPgReachable(dsn,'review-grading-live-replay');
  sql=postgres(dsn,{max:1,onnotice:()=>{}});
});
afterAll(async()=>{ if(sql) { await cleanup(); await sql.end({timeout:5}); } });
beforeEach(async()=>{
  await cleanup();
  for(const [slug,kind] of [
    ['suffix-acceptance','acceptance'],['pot-coordination-health','standard'],
    ['meta-acceptance-rubric','standard'],['grading-integrity-control','standard'],
  ]) {
    await sql`INSERT INTO harness_shared.harness_plans
      (workspace_id,harness_slug,plan_slug,template,template_data)
      VALUES (${ws},'papercusp',${slug},'rubric',${JSON.stringify({kind})}::text::jsonb)`;
  }
  const observations: Array<[string,Record<string,unknown>]>=[
    ['residual',{rubricRef:'pot-coordination-health'}],
    ['independent',{rubricRef:'suffix-acceptance'}],
    ['json-null',{rubricRef:'suffix-acceptance',acceptance:null}],
    ['author',{rubricRef:'suffix-acceptance',acceptance:{verdict:'accept'}}],
    ['malformed',{rubricRef:'suffix-acceptance',acceptance:false}],
    ['unresolved',{rubricRef:'acceptance-missing-definition'}],
    ['vetting',{rubricRef:'meta-acceptance-rubric'}],
    ['integrity',{rubricRef:'grading-integrity-control'}],
    ['synthesized',{rubricRef:'pot-coordination-health',synthesized:true}],
  ];
  for(const [id,observation] of observations) {
    await sql`INSERT INTO harness_shared.engineer_issues
      (workspace_id,issue_id,title,created_at,payload,signal_origin)
      VALUES (${ws},${`EI-${id}`},${id},'2026-09-15T00:00:00Z',
        ${JSON.stringify({observation})}::text::jsonb,'organic')`;
  }
  await sql`INSERT INTO harness_shared.engineer_issues (workspace_id,issue_id,title,created_at,payload)
    VALUES (${ws},'EI-upper-bound','outside','2026-10-01T00:00:00Z',
      ${JSON.stringify({observation:{rubricRef:'pot-coordination-health'}})}::text::jsonb)`;
  for(const workspace of [ws,other]) {
    await sql`INSERT INTO harness_shared.pr_review_reports
      (workspace_id,harness_slug,pr_number,pr_url,head_sha,recommendation,summary,rationale,
        risks,checks_observed,model,tokens_in,tokens_out,cost_usd_cents,reviewed_at)
      VALUES (${workspace},'papercusp',1,'https://example.test/pr/1','abcdef1','approve','review','reason',
        '[]'::jsonb,'[]'::jsonb,'fixture',1,1,0,'2026-09-15T00:00:00Z')`;
  }
  // Diagnose fixture transport before a successful census can conceal it.
  const [rubric]=await sql`SELECT jsonb_typeof(template_data) AS shape,
    template_data->>'kind' AS kind FROM harness_shared.harness_plans
    WHERE workspace_id=${ws} AND plan_slug='suffix-acceptance'`;
  expect(rubric).toMatchObject({shape:'object',kind:'acceptance'});
  const [card]=await sql`SELECT jsonb_typeof(payload) AS shape,
    payload->'observation'->>'rubricRef' AS rubric FROM harness_shared.engineer_issues
    WHERE workspace_id=${ws} AND issue_id='EI-independent'`;
  expect(card).toMatchObject({shape:'object',rubric:'suffix-acceptance'});
});

describe('preserved criterion evidence against actual canonical SQL', () => {
  async function fixture() {
    const evidence = '🧪 A recorded partial chain; no remediation or historical rubric revision.';
    const observation = { rubricRef: 'suffix-acceptance', ratings: { criterion: { rating: 'unknown', evidence } } };
    await sql`UPDATE harness_shared.engineer_issues SET payload=${JSON.stringify({ observation })}::text::jsonb
      WHERE workspace_id=${ws} AND issue_id='EI-independent'`;
    const [stored] = await sql`SELECT md5((payload->'observation')::text) AS hash,
      current_database() AS database, inet_server_port() AS port FROM harness_shared.engineer_issues
      WHERE workspace_id=${ws} AND issue_id='EI-independent'`;
    const artifact: ReviewGradingAuditArtifact = JSON.parse(readFileSync(new URL(
      '../../../docs/evidence/review-grading-80-record-judgments-2026-10-09.json', import.meta.url), 'utf8'));
    artifact.records = [['EI-independent', 'independent-acceptance', 'suffix-acceptance', null,
      stored.hash, 'inconclusive', 'Fixture partial chain', ['criterion']]];
    artifact.traceability.criterionCount = 1;
    artifact.traceability.records = [{ id: 'EI-independent', rubricRef: 'suffix-acceptance', rubricRevision: null,
      observationMd5: stored.hash, implementationImpact: 'NOT-VERIFIED', status: 'PARTIAL',
      missingEdges: ['rubricRevision', 'recordedDisposition', 'independentOutcomeReplay'],
      ratings: [['criterion', 'unknown', createHash('sha256').update(evidence).digest('hex'), [...evidence].length,
        null, null, [], [], 'NOT-RECORDED']] }];
    return { workspaceId: ws, artifact, expectedDatabase: stored.database as string, expectedPort: stored.port as number };
  }
  it('matches exact preserved evidence while retaining legitimate partial edges', async () => {
    const result = await readReviewGradingArtifact(sql, await fixture());
    expect(result.checked).toEqual({ records: 1, criteria: 1, metrics: 6 });
    expect(result.assertions).toEqual([expect.objectContaining({ id: 'artifact-EI-independent', passed: true })]);
  });
  it('fails a changed observation rather than treating its existing id as proof', async () => {
    const input = await fixture();
    await sql`UPDATE harness_shared.engineer_issues SET payload=jsonb_set(payload,
      '{observation,ratings,criterion,evidence}', '"changed"'::jsonb)
      WHERE workspace_id=${ws} AND issue_id='EI-independent'`;
    expect((await readReviewGradingArtifact(sql, input)).assertions[0].passed).toBe(false);
  });
  it('reports a missing preserved card rather than resampling a replacement', async () => {
    const input = await fixture();
    await sql`DELETE FROM harness_shared.engineer_issues WHERE workspace_id=${ws} AND issue_id='EI-independent'`;
    expect((await readReviewGradingArtifact(sql, input)).assertions[0]).toMatchObject({ passed: false, evidence: 'canonical card missing' });
  });
  it('rejects an alternate database before interpreting an empty or different result', async () => {
    const input = await fixture();
    await expect(readReviewGradingArtifact(sql, { ...input, expectedPort: input.expectedPort + 1 }))
      .rejects.toThrow('database_identity_mismatch');
  });
});
