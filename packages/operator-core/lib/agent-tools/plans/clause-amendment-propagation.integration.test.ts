/** R-10: amend through the real writer and inspect committed item/coordination state. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import type { SpecClauseWrite } from './spec-clauses-store';
const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
const WS = 'ws-amendment';
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  withWorkspace: async <T>(_ws: string, fn: (tx: postgres.Sql) => Promise<T>) =>
    h.sql.begin((tx) => fn(tx as unknown as postgres.Sql)),
}));
vi.mock('./source', async (original) => ({
  ...(await original<typeof import('./source')>()),
  resolvePlanScope: async () => ({ workspaceId: WS, harnessSlug: 'h' }),
}));
const { setSpecClause } = await import('./spec-clauses-store');
const { propagateClauseAmendment } = await import('./clause-amendment-propagation');
let db: FreshPgDb;
let propagationQuery = '';
let propagationParameters: unknown[] = [];
const here = path.dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  db = await createFreshPgDb('clause-amendment'); h.sql = db.sql;
  h.sql.options.debug = (_connection, query, parameters) => {
    if (!query.trimStart().startsWith('EXPLAIN') && /SELECT w\.feature_id AS id/i.test(query)) {
      propagationQuery = query; propagationParameters = parameters;
    }
  };
  await h.sql.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='harness_app') THEN CREATE ROLE harness_app; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin; END IF;
  END $$;
  CREATE TABLE harness_shared.harness_plans (workspace_id text,harness_slug text,plan_slug text);
  CREATE TABLE harness_shared.plan_items (workspace_id text,harness_slug text,plan_slug text,item_id text);
  CREATE TABLE harness_shared.work_items (
    workspace_id text,harness_slug text,feature_id text,status text DEFAULT 'open',taken_by text,
    source_plan_slug text,source_plan_item_ids text[],payload jsonb DEFAULT '{}'
  );
  CREATE TABLE harness_shared.work_item_spec_revision_edges (
    workspace_id text,harness_slug text,work_item_id text,plan_slug text,spec_id text,spec_revision int
  );
  CREATE TABLE harness_shared.coord_presence (workspace_id text,owner_id text,heartbeat_at timestamptz);
  CREATE TABLE harness_shared.coord_event_log (
    id bigserial PRIMARY KEY,workspace_id text,surface text,writer_key text,msg_id text,body jsonb,harness_slug text,ts timestamptz
  );
  CREATE UNIQUE INDEX work_items_identity ON harness_shared.work_items (workspace_id,harness_slug,feature_id);
  CREATE INDEX work_items_source_plan ON harness_shared.work_items (workspace_id,harness_slug,source_plan_slug);
  CREATE INDEX work_items_payload_plan ON harness_shared.work_items
    (workspace_id,harness_slug,(payload->'plan_item'->>'plan_slug'),(payload->'plan_item'->>'item_id'));
  CREATE INDEX work_item_edges_spec ON harness_shared.work_item_spec_revision_edges
    (workspace_id,harness_slug,plan_slug,spec_id);`);
  for (const name of ['851-first-class-plan-spec-clauses.sql','929-spec-clause-falsifier.sql']) {
    await applyMigrationForTest(h.sql,path.resolve(here,'../../../../../libs/papercusp/libs/db/sql',name));
  }
  await h.sql.unsafe(`ALTER TABLE harness_shared.plan_spec_clause_revisions
    ADD source_bar_key text, ADD source_bar_hash text, ADD source_bar_set_hash text,
    ADD source_rubric_slug text, ADD source_rubric_revision bigint, ADD evidence_plane text;`);
});
afterAll(async () => { await db?.cleanup(); });
const spec = (expectedRevision: number, extra: Partial<SpecClauseWrite> = {}): SpecClauseWrite => ({
  harnessSlug:'h',planSlug:'plan',specId:'SPEC-1',expectedRevision,planItemId:'P-001',
  behavior: expectedRevision ? 'Reject all invalid input.' : 'Reject invalid input.',
  behaviorClass:'boundary',lifecycleStatus:'active',actorId:'author',...extra,
});
beforeEach(async () => {
  await h.sql.unsafe(`TRUNCATE harness_shared.plan_spec_clause_revisions,harness_shared.plan_spec_clauses,
    harness_shared.harness_plans,harness_shared.plan_items,harness_shared.work_items,
    harness_shared.work_item_spec_revision_edges,harness_shared.coord_presence,harness_shared.coord_event_log CASCADE;`);
  await h.sql`INSERT INTO harness_shared.harness_plans VALUES (${WS},'h','plan')`;
  await h.sql`INSERT INTO harness_shared.plan_items VALUES (${WS},'h','plan','P-001'),(${WS},'h','plan','P-002')`;
  expect(await setSpecClause(spec(0))).toMatchObject({ status:'created',revision:1 });
});
async function item(id: string, holder: string | null, opts: { linked?: boolean; terminal?: boolean; workspace?: string; stale?: boolean; stamp?: boolean } = {}) {
  const ws = opts.workspace ?? WS;
  await h.sql`INSERT INTO harness_shared.work_items
    (workspace_id,harness_slug,feature_id,status,taken_by,source_plan_slug,source_plan_item_ids)
    VALUES (${ws},'h',${id},${opts.terminal?'done':'open'},${holder},${opts.stamp?'plan':null},${opts.stamp?['P-001']:[]})`;
  if (opts.linked) await h.sql`INSERT INTO harness_shared.work_item_spec_revision_edges
    VALUES (${ws},'h',${id},'plan','SPEC-1',1)`;
  if (holder) await h.sql`INSERT INTO harness_shared.coord_presence
    VALUES (${ws},${holder},${opts.stale?new Date(0):new Date()})`;
}
describe('clause amendment propagation', () => {
  it('notifies each live linked holder once with both revisions, including plan-stamped items', async () => {
    await item('WI-edge','builder',{linked:true});
    await item('WI-stamp','builder',{stamp:true});
    await item('WI-other','other'); await item('WI-done','done-holder',{linked:true,terminal:true});
    await item('WI-tenant','tenant',{linked:true,workspace:'another'});
    expect(await setSpecClause(spec(1))).toMatchObject({status:'revised',revision:2});
    const rows = await h.sql`SELECT body FROM harness_shared.coord_event_log`;
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toMatchObject({to:['builder'],from:'author',plan_slug:'plan',expects:'none'});
    expect(rows[0].body.body).toContain('revision 1 → 2');
    expect(rows[0].body.body).toContain('WI-edge'); expect(rows[0].body.body).toContain('WI-stamp');
    const untouched = await h.sql`SELECT payload FROM harness_shared.work_items WHERE feature_id IN ('WI-other','WI-done','WI-tenant')`;
    expect(untouched.every((r)=>JSON.stringify(r.payload)==='{}')).toBe(true);
  });
  it('records amendments on unheld and stale-holder items without sending them to an unrelated session', async () => {
    await item('WI-unheld',null,{linked:true}); await item('WI-stale','old',{stamp:true,stale:true});
    await setSpecClause(spec(1));
    const rows = await h.sql`SELECT feature_id, payload,
      jsonb_path_query_first(payload, '$._specAmendments.*.newRevision')::text AS revision
      FROM harness_shared.work_items ORDER BY feature_id`;
    for (const row of rows) {
      expect(Object.values(row.payload._specAmendments)).toEqual([
        expect.objectContaining({ specId:'SPEC-1',oldRevision:1,newRevision:2 }),
      ]);
    }
    expect(rows.map((r)=>[r.feature_id,r.revision])).toEqual([['WI-stale','2'],['WI-unheld','2']]);
    expect(await h.sql`SELECT * FROM harness_shared.coord_event_log`).toHaveLength(0);
  });
  it('includes payload-only provenance, deduplicates overlapping paths and ignores unrelated wide rows', async () => {
    await item('WI-payload','payload-holder');
    await h.sql`UPDATE harness_shared.work_items
      SET payload = ${JSON.stringify({plan_item:{plan_slug:'plan',item_id:'P-001'}})}::text::jsonb
      WHERE feature_id='WI-payload'`;
    await item('WI-overlap','overlap-holder',{linked:true,stamp:true});
    await h.sql`UPDATE harness_shared.work_items
      SET payload = ${JSON.stringify({plan_item:{plan_slug:'plan',item_id:'P-001'}})}::text::jsonb
      WHERE feature_id='WI-overlap'`;
    await item('WI-other-item',null);
    await h.sql`UPDATE harness_shared.work_items
      SET payload = ${JSON.stringify({plan_item:{plan_slug:'plan',item_id:'P-002'}})}::text::jsonb
      WHERE feature_id='WI-other-item'`;
    // Real work-item rows contain large unrelated columns. They are not provenance
    // and must stay outside the candidate predicate's JSON conversion.
    await h.sql.unsafe('ALTER TABLE harness_shared.work_items ADD COLUMN IF NOT EXISTS unrelated_body text');
    await h.sql`INSERT INTO harness_shared.work_items
      (workspace_id,harness_slug,feature_id,source_plan_slug,source_plan_item_ids,payload,unrelated_body)
      SELECT ${WS},'h','unrelated-'||i,'other-plan',ARRAY['P-001'],
        jsonb_build_object('plan_item',jsonb_build_object('plan_slug','other-plan','item_id','P-001')),
        repeat(md5(i::text),2048)
      FROM generate_series(1,100) i`;
    await h.sql.unsafe('ANALYZE harness_shared.work_items; ANALYZE harness_shared.work_item_spec_revision_edges');
    expect(await setSpecClause(spec(1))).toMatchObject({status:'revised',revision:2});
    const changed = await h.sql`SELECT feature_id FROM harness_shared.work_items
      WHERE payload ? '_specAmendments' ORDER BY feature_id`;
    expect(changed.map((row)=>row.feature_id)).toEqual(['WI-overlap','WI-payload']);
    const messages = await h.sql`SELECT body FROM harness_shared.coord_event_log`;
    expect(messages).toHaveLength(2);
    expect(messages.map((row)=>row.body.to[0]).sort()).toEqual(['overlap-holder','payload-holder']);
    // Explain the statement actually executed by the writer. With sequential
    // scans disabled, each provenance path must still have an indexable route;
    // the former whole-row JSON predicates cannot use the first two indexes.
    const query = propagationQuery, parameters = propagationParameters;
    // Regression guard: concurrent clause amendments must acquire overlapping work-item
    // rows in a stable order before the transaction updates their amendment stamps.
    expect(query).toMatch(/ORDER BY w\.feature_id\s+FOR UPDATE OF w/);
    const indexes = await h.sql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL enable_seqscan = off');
      const explained = await tx.unsafe('EXPLAIN (FORMAT JSON) '+query, parameters as never);
      const names: string[] = [];
      const walk = (node: Record<string, unknown>) => {
        if (typeof node['Index Name'] === 'string') names.push(node['Index Name']);
        for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) walk(child);
      };
      walk(explained[0]['QUERY PLAN'][0].Plan);
      return names;
    });
    expect(indexes).toEqual(expect.arrayContaining([
      'work_items_source_plan','work_items_payload_plan','work_item_edges_spec',
    ]));
  });
  it('does not duplicate a repeated amendment or replayed delivery', async () => {
    await item('WI-edge','builder',{linked:true}); await setSpecClause(spec(1));
    expect(await setSpecClause(spec(2))).toMatchObject({status:'unchanged',revision:2});
    await h.sql.begin((tx)=>propagateClauseAmendment(tx as never,{
      workspaceId:WS,harnessSlug:'h',planSlug:'plan',specId:'SPEC-1',planItemId:'P-001',
      oldRevision:1,newRevision:2,actorId:'replay',
    }));
    expect(await h.sql`SELECT * FROM harness_shared.coord_event_log`).toHaveLength(1);
    const rows = await h.sql`SELECT payload FROM harness_shared.work_items WHERE feature_id='WI-edge'`;
    expect(Object.values(rows[0].payload._specAmendments)).toEqual([
      expect.objectContaining({ actorId:'author',newRevision:2 }),
    ]);
  });
  it('rolls back clause revision, item evidence and notifications together', async () => {
    await item('WI-edge','builder',{linked:true});
    await expect(h.sql.begin(async (tx)=>{
      expect(await setSpecClause(spec(1),{executor:tx as never,workspaceId:WS,harnessSlug:'h'})).toMatchObject({revision:2});
      throw new Error('abort producer');
    })).rejects.toThrow('abort producer');
    expect((await h.sql`SELECT current_revision FROM harness_shared.plan_spec_clauses`)[0].current_revision).toBe(1);
    expect((await h.sql`SELECT payload FROM harness_shared.work_items`)[0].payload).toEqual({});
    expect(await h.sql`SELECT * FROM harness_shared.coord_event_log`).toHaveLength(0);
  });
  it('notifies the prior owning item when an amendment moves the clause to another item', async () => {
    await item('WI-stamp','builder',{stamp:true});
    await setSpecClause(spec(1,{planItemId:'P-002'}));
    expect(await h.sql`SELECT * FROM harness_shared.coord_event_log`).toHaveLength(1);
  });
});
