import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';
import { validatePromotedFrom, reversePromotions, promotionDecisionBody, type PromotionSource, type LineageQuery } from './promotion-lineage';

describe('promotion lineage on migrated PostgreSQL', () => {
  let db: OrgTestDb;
  const workspace = 'lineage-test';
  const memory = randomUUID();
  const sources: PromotionSource[] = [
    { kind: 'memory', ref: memory }, { kind: 'work-item', ref: 'WI-123' },
    { kind: 'fact', ref: 'source-fact' }, { kind: 'decision', ref: 'source-plan#D-001' },
    { kind: 'session-turn', ref: 'codex:namespace:session:3' }, { kind: 'report', ref: 'report-test' },
  ];
  let query: LineageQuery;
  beforeAll(async () => {
    db = await createOrgTestDb();
    query = async (sql, params) => Array.from(await db.adminSql.unsafe<Record<string, unknown>[]>(sql, params));
    await db.adminSql`INSERT INTO harness_shared.memory_canonical(id,payload) VALUES (${memory}, ${db.adminSql.json({ workspace_id: workspace })})`;
    await db.adminSql`INSERT INTO harness_shared.work_items(workspace_id,harness_slug,feature_id,title,summary,status,item_kind,created_ts,updated_ts,payload)
      VALUES (${workspace},'papercusp','WI-123','Source','Source','open','change',1,1,'{}'::jsonb)`;
    await db.adminSql`INSERT INTO harness_shared.agent_facts(workspace_id,scope,key,body,created_by,expires_at)
      VALUES (${workspace},'workspace','source-fact','Source','test',now()+interval '1 hour')`;
    const body = `---\ntitle: Source\nslug: source-plan\nstatus: draft\n---\n## Decisions\n### D-001 Source\nDate: 2026-10-14\nSource claim.\n`;
    await db.adminSql`INSERT INTO harness_shared.harness_plans(workspace_id,harness_slug,plan_slug,content,decisions)
      VALUES (${workspace},'papercusp','source-plan',${body},${db.adminSql.json([{ id: 'D-001' }])})`;
    await db.adminSql`INSERT INTO harness_shared.session_turns(workspace_id,source_kind,session_id,turn_idx,speaker,text)
      VALUES (${workspace},'codex','namespace:session',3,'user','Source')`;
    await db.adminSql`INSERT INTO harness_shared.report_library(workspace_id,report_id,title,lineage_id)
      VALUES (${workspace},'report-test','Source','report-test')`;
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });

  it('resolves all six source types against the actual schema and rejects another workspace', async () => {
    expect(await validatePromotedFrom(sources, workspace, query)).toEqual(sources);
    for (const source of sources) await expect(validatePromotedFrom([source], 'other-workspace', query)).rejects.toThrow('source missing');
  });
  it('rejects a retracted source fact against the canonical current state', async () => {
    await db.adminSql`UPDATE harness_shared.agent_facts SET retracted_at=now() WHERE workspace_id=${workspace} AND key='source-fact'`;
    await expect(validatePromotedFrom([sources[2]], workspace, query)).rejects.toThrow('retracted');
    await db.adminSql`UPDATE harness_shared.agent_facts SET retracted_at=NULL WHERE workspace_id=${workspace} AND key='source-fact'`;
  });
  it('reverse lookup reads the existing provenance/frontmatter/decision stores without fuzzy matches', async () => {
    const source = sources[1];
    await db.adminSql`INSERT INTO harness_shared.agent_facts(workspace_id,scope,key,body,created_by,expires_at,source_provenance)
      VALUES (${workspace},'workspace','claim','Claim','test',now()+interval '1 hour',
        ${db.adminSql.json({ kind: 'promotion', verified: true, verifiedAt: new Date().toISOString(), promotedFrom: [source] })})`;
    await db.adminSql`INSERT INTO harness_shared.harness_docs(workspace_id,harness_slug,doc_id,content)
      VALUES (${workspace},'papercusp','agent-insights/claim.mdx',${`---\ntitle: Claim\npromotedFrom: ${JSON.stringify([source])}\n---\nClaim`})`;
    const body = `---\ntitle: Promoted\nslug: promoted-plan\nstatus: draft\n---\n## Decisions\n### D-001 Promoted\nDate: 2026-10-14\n${promotionDecisionBody('Claim', [source])}\n`;
    await db.adminSql`INSERT INTO harness_shared.harness_plans(workspace_id,harness_slug,plan_slug,content)
      VALUES (${workspace},'papercusp','promoted-plan',${body})`;
    const result = await reversePromotions(source, workspace, 50, query);
    expect(result.results.map(r => r.kind)).toEqual(['decision','doc','fact']);
    expect(result.truncated).toBe(false);
    expect(await reversePromotions(source, 'other-workspace', 50, query)).toEqual({ results: [], truncated: false });
    expect(await reversePromotions(sources[0], workspace, 50, query)).toEqual({ results: [], truncated: false });
  });
});
