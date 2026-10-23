import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { CARRY_SHIPMENT_PLAN, readCarryShipmentReceipts } from './carry-drill-shipment';

let db: MigratedTestDb, sql: Sql;
const sha = 'a'.repeat(40), at = '2026-10-22T00:00:05Z';
const input = { workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: CARRY_SHIPMENT_PLAN,
  ownerId: 'su-test', drillId: 'drill', deploymentId: '42', reportId: 'rpt-test',
  windowStart: '2026-10-22T00:00:00Z', windowEnd: '2026-10-22T01:00:00Z' };
beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'carryshipment' });
  sql = postgres(db.url,{ max: 1, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.pipeline_events(id bigint, workspace_id text,install_slug text,kind text,status text,created_at timestamptz,detail jsonb);
    CREATE TABLE harness_shared.tool_invocations(id bigint,workspace_id text,coord_owner_id text,tool_name text,status text,invoked_at timestamptz,
      duration_ms integer,args_json jsonb,serving_host text,serving_process_id text,serving_build_sha text);
    CREATE TABLE harness_shared.report_library(workspace_id text,report_id text,subject_kind text,subject_ref text,body_md text,
      visibility text,published_at timestamptz,retired_at timestamptz);`);
  await sql`INSERT INTO harness_shared.pipeline_events VALUES
    (42,'workspace','papercusp','deploy','ok',${at},${sql.json({ fullTargetSha: sha })}),
    (41,'workspace','papercusp','green_checkpoint','advanced',${at},${sql.json({ candidate: sha.slice(0,12) })}),
    (40,'foreign','papercusp','green_checkpoint','advanced',${at},${sql.json({ candidate: sha })}),
    (39,'workspace','other','green_checkpoint','advanced',${at},${sql.json({ candidate: sha })}),
    (38,'workspace','papercusp','green_checkpoint','advanced',${at},${sql.json({ candidate: 'b'.repeat(40) })})`;
  await sql`INSERT INTO harness_shared.tool_invocations VALUES
    (1,'workspace','su-test','session:carry-drill','ok',${at},900,${sql.json({ op:'grade',drillId:'drill' })},'port-3070','linux:boot:123',${sha.slice(0,10)}),
    (2,'foreign','su-test','session:carry-drill','ok',${at},900,'{}','port-3070','foreign',${sha.slice(0,10)}),
    (3,'workspace','foreign','session:carry-drill','ok',${at},900,'{}','port-3070','foreign',${sha.slice(0,10)})`;
  await sql`INSERT INTO harness_shared.report_library VALUES
    ('workspace','rpt-test','plan',${CARRY_SHIPMENT_PLAN},'native report','owner',${at},NULL)`;
},180_000);
afterAll(async () => {
  try { await sql?.end({ timeout: 5 }); }
  finally { await db?.drop(); }
});

it('reads exact workspace/install/owner receipts and short green promotion identity from real PostgreSQL', async () => {
  const result = await readCarryShipmentReceipts(input,sql);
  expect(result.deployment).toMatchObject({ id:'42',kind:'deploy',detail:{fullTargetSha:sha} });
  expect(result.promotions.map(row => row.id)).toEqual(['41']);
  expect(result.invocations).toHaveLength(1);
  expect(result.invocations[0]).toMatchObject({ id:'1',tool:'session:carry-drill',servingProcess:'linux:boot:123',durationMs:900 });
  expect(result.report).toMatchObject({ id:'rpt-test',subjectRef:CARRY_SHIPMENT_PLAN,visibility:'owner' });
});
it('does not substitute another workspace or a retired report', async () => {
  await sql`UPDATE harness_shared.report_library SET retired_at=now() WHERE report_id='rpt-test'`;
  const result = await readCarryShipmentReceipts({ ...input, deploymentId:'43' },sql);
  expect(result.deployment).toBeNull();
  expect(result.report).toBeNull();
  expect(result.promotions).toEqual([]);
});
