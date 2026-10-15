import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { assertPgReachable } from '@papercusp/test-config/pg';
import type {} from '@papercusp/test-config';
import { readReviewGradingCensus } from './review-grading-live-replay';

const ws=`review-replay-${randomUUID()}`;
const other=`${ws}-other`;
let sql: postgres.Sql;
const args={workspaceId:ws,lowerBound:'2026-09-01T00:00:00Z',upperBound:'2026-10-01T00:00:00Z',seed:'review-replay-control',sampleSize:80};

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

describe('actual read-only review census SQL',()=>{
  it('separates real PR reports from residual assessments and resolves canonical rubric kind',async()=>{
    const result=await readReviewGradingCensus(sql,args);
    expect(result.population).toEqual({
      'independent-acceptance':2,'author-acceptance':1,'rubric-vetting':1,'grading-integrity':1,
      'ordinary-code-review':1,'other-rubric-assessments':1,'unresolved-rubric':2,
    });
    expect(result.sample).toHaveLength(9);
    expect(result.sample.find(r=>r.id==='EI-residual')?.stratum).toBe('other-rubric-assessments');
    expect(result.sample.find(r=>r.id==='EI-json-null')?.stratum).toBe('independent-acceptance');
    expect(result.sample.filter(r=>r.stratum==='ordinary-code-review').map(r=>r.source)).toEqual(['pr_review_reports']);
    expect(result.sample.some(r=>r.id==='EI-synthesized'||r.id==='EI-upper-bound')).toBe(false);
  });
  it('keeps an empty ordinary-review source explicit rather than borrowing residual rows',async()=>{
    await sql`DELETE FROM harness_shared.pr_review_reports WHERE workspace_id=${ws}`;
    const result=await readReviewGradingCensus(sql,args);
    expect(result.control.scorecard_control).toBe(true);
    expect(result.population['ordinary-code-review']).toBe(0);
    expect(result.quotas['ordinary-code-review']).toBe(0);
    expect(result.sample).toHaveLength(8);
    expect(result.population['other-rubric-assessments']).toBe(1);
  });
  it('replays the same bounded snapshot and rejects an undersized stratified sample',async()=>{
    const first=await readReviewGradingCensus(sql,args);
    const second=await readReviewGradingCensus(sql,args);
    expect(second.sample).toEqual(first.sample);
    expect(second.quotas).toEqual(first.quotas);
    await expect(readReviewGradingCensus(sql,{...args,sampleSize:2})).rejects.toThrow('sample_cannot_cover');
  });
  it('fails closed when the selected workspace has no positive scorecard control',async()=>{
    await expect(readReviewGradingCensus(sql,{...args,workspaceId:`${ws}-absent`})).rejects.toThrow('positive_control_failed');
  });
});
