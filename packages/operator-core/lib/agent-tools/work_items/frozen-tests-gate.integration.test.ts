/** R-9: real item/evidence/test ledgers, real hashes, and production completion writes. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { hashPlanContent } from '@papercusp/plan-parser/content-hash';

const WS = 'default', HARNESS = 'papercusp', BUILDER = 'su-frozen-builder', TESTER = 'su-frozen-tester';
const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, root: '', actor: 'su-frozen-builder', child: false }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: async <T>(ws: string, callback: (tx: postgres.Sql) => Promise<T>) => h.sql.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id',${ws},true)`;
    return callback(tx as unknown as postgres.Sql);
  }),
}));
vi.mock('../../workspace-registry', async original => ({
  ...await original<typeof import('../../workspace-registry')>(), activeWorkspaceId: () => 'default',
}));
vi.mock('../../harness-registry', async original => ({
  ...await original<typeof import('../../harness-registry')>(),
  loadHarnessRegistry: async () => ({ projects:[{ slug:'papercusp',path:h.root }] }),
  resolveHarnessContentPath: () => h.root,
}));
vi.mock('../plans/source', async original => ({
  ...await original<typeof import('../plans/source')>(),
  resolvePlanScope: async () => ({ workspaceId:'default',harnessSlug:'papercusp' }),
}));
vi.mock('../coordination/identity', async original => ({
  ...await original<typeof import('../coordination/identity')>(),
  resolveAgentIdentity: () => ({ ownerId:h.actor,ownerLabel:'frozen-test integration',source:'test' }),
  deriveFleetMembership: async () => null,
}));
vi.mock('../../fleet/git-via-sidecar', async original => ({
  ...await original<typeof import('../../fleet/git-via-sidecar')>(), gitSidecarEnabled: () => false,
}));
vi.mock('@papercusp/flags/server', async original => ({
  ...await original<typeof import('@papercusp/flags/server')>(), getFlag: async () => false,
}));
vi.mock('../../events', async original => ({
  ...await original<typeof import('../../events')>(), fireReactionInProcess: async () => ({ ok:true }),
}));
vi.mock('../../grading-integrity', async original => ({
  ...await original<typeof import('../../grading-integrity')>(),
  dispatchPendingGradingAudits: async () => ({ requestedTargetIds:[],receipts:[] }),
}));
vi.mock('../../harness/improvements/completion-verification-store', async original => ({
  ...await original<typeof import('../../harness/improvements/completion-verification-store')>(),
  spawnCompletionVerificationForClose: async () => ({ outcome:'no-dependents' }),
  applyCompletionVerdictForClose: async () => null, acceptCompletionOnSettlementForSubject: async () => null,
}));

const { createIssue } = await import('../../issues-engineer');
const { getWorkItem } = await import('../../work-items');
const { setSpecClause } = await import('../plans/spec-clauses-store');
const { bindSpecEvidence, listSpecEvidence, measureAndPinRepoFilesEvidenceAtRoot, resolveMeasurementRoot } = await import('../plans/spec-evidence-store');
const { readPlanBySlug } = await import('../plans/source');
const { frozenTestsTestSeams } = await import('./frozen-tests-gate');
const update = (await import('./update')).default;
const complete = (await import('./complete')).default;
const create = (await import('./create')).default;
let db: OrgTestDb, planSlug: string, itemId: string, freezeId: number, redId: number, commit: string;
const roots: string[] = [];
const TEST_PATH = 'acceptance.test.ts';
const git = (...args: string[]) => execFileSync('git',['-C',h.root,'-c','user.email=fixture@example.test',
  '-c','user.name=fixture','-c','commit.gpgsign=false',...args],{encoding:'utf8'}).trim();
const content = (pilot = true, decision = '') => `---\nslug: ${planSlug}\nstatus: active\n${pilot?'frozenTests: pilot\n':''}---\n## Build\n- **P-001** \`todo\` Implement acceptance\n## Decisions\n${decision}\n`;
async function writePlan(body: string) {
  await h.sql`INSERT INTO harness_shared.harness_plans (workspace_id,harness_slug,plan_slug,title,status,content,content_hash)
    VALUES (${WS},${HARNESS},${planSlug},'frozen pilot fixture','active',${body},${hashPlanContent(body)})
    ON CONFLICT (workspace_id,harness_slug,plan_slug) DO UPDATE SET content=EXCLUDED.content,content_hash=EXCLUDED.content_hash`;
}
beforeAll(async () => {
  db = await createOrgTestDb({ adminPoolMax:4 }); h.sql=db.adminSql;
  // Identity graph mechanics have their own real-PG suite. Inject the one relationship
  // used here while exercising the production guard's independence decision.
  frozenTestsTestSeams.deps = { plan:readPlanBySlug,evidence:listSpecEvidence,root:resolveMeasurementRoot,
    related:async (a,b) => h.child && a===TESTER && b===BUILDER };
},180_000);
afterAll(async () => { frozenTestsTestSeams.deps=undefined; await db?.cleanup(); for(const root of roots) await rm(root,{recursive:true,force:true}); });

async function testRun(status: 'pass'|'fail', extra: Record<string,unknown> = {}) {
  const execution = { schemaVersion:1,root:h.root,filePath:TEST_PATH,runGroupId:null,
    workspaceId:WS,harnessSlug:HARNESS,testNamePattern:null,testLayer:'unit',
    passed:status==='pass'?1:0,failed:status==='fail'?1:0,skipped:0,collectionFailed:false,
    failedCaseTitles:status==='fail'?['promised behavior rejects invalid input']:[],
    passedCaseTitles:status==='pass'?['promised behavior rejects invalid input']:[],
    mutationPhase:null,commitSha:commit,worktreeDirty:false,...extra };
  const [row] = await h.sql<Array<{id:number}>>`INSERT INTO harness_shared.test_runs
    (workspace_id,harness_slug,file_path,framework,source,status,started_at,finished_at,commit_sha,worktree_dirty,execution_details)
    VALUES (${WS},${HARNESS},${TEST_PATH},'vitest','local',${status},now(),now(),${commit},false,${JSON.stringify(execution)}::text::jsonb) RETURNING id`;
  return Number(row!.id);
}
async function binding(kind:'manual'|'test', actor=TESTER, runId?:number) {
  const measurement = { schemaVersion:1 as const,kind:'repo-files' as const,
    sourcePaths:kind==='manual'?[TEST_PATH]:['implementation.ts'],testPaths:[TEST_PATH] };
  const measured = await measureAndPinRepoFilesEvidenceAtRoot(h.root,measurement);
  const result = await bindSpecEvidence({ harnessSlug:HARNESS,planSlug,workItemId:itemId,specId:'SPEC-1',specRevision:1,
    // Keep fixture author identities distinct even when the measured bytes are identical.
    // The production binding fingerprint is intentionally content-based, so reusing one
    // evidenceRef here would return the first immutable row and hide the lineage refusal.
    evidenceKind:kind,evidenceRef:kind==='manual'?`freeze:${actor}:${measured.testFingerprint}`:`test-run:${actor}:${runId}`,
    ...(runId?{testRunId:runId}:{}),sourceFingerprint:measured.sourceFingerprint,testFingerprint:measured.testFingerprint,
    details:{currentMeasurement:measurement,measurementPin:measured.pin},actorId:actor });
  expect(result).toHaveProperty('id');
  const id = (result as {id:number}).id;
  const [stored] = await h.sql`SELECT created_by FROM harness_shared.spec_evidence_bindings
    WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND id=${id}`;
  expect(stored).toMatchObject({ created_by: actor });
  return id;
}
async function register(bindingId=freezeId,expectedRevision=0,decisionId?:string) {
  h.actor=TESTER;
  const response=await update.handler(update.args.parse({id:itemId,harness:HARNESS,
    frozenTests:{bindingId,redRunIds:[redId],expectedRevision,...(decisionId?{decisionId}:{})}}),{workspaceId:WS,isSuperuser:true} as never);
  return (response as {data:{results:Array<Record<string,unknown>>}}).data.results[0]!;
}
async function close() {
  h.actor=BUILDER;
  const response=await complete.handler(complete.args.parse({id:itemId,harness:HARNESS,state:'done',assumptions:'none',
    changeKinds:['no-code-change'],changeKindReason:'The fixture verifies a completion guard and changes no repository files.',completion:{
    summary:'Verified the pilot acceptance behavior.',testsRun:'the recorded acceptance suite',
    testResult:'Passing canonical test-run evidence was checked against current files.',verifiedHow:'unit',filesChanged:[],
  }}),{workspaceId:WS,isSuperuser:true} as never);
  return (response as {data:{results:Array<Record<string,unknown>>}}).data.results[0]!;
}
async function expectRefused() {
  const result=await close(); expect(result,JSON.stringify(result)).toMatchObject({ok:false});
  expect(result.specConformanceRefusal).toMatchObject({code:'frozen_tests_completion_refused'});
  const [stored]=await h.sql`SELECT status,payload FROM harness_shared.work_items WHERE workspace_id=${WS} AND feature_id=${itemId}`;
  expect(stored!.status).toBe('open'); expect(stored!.payload._completion).toBeUndefined();
}
beforeEach(async () => {
  h.child=false;h.actor=BUILDER;h.root=await mkdtemp(join(tmpdir(),'frozen-pilot-'));roots.push(h.root);
  // Fixture Git is confined to this disposable database/repository, never the shared tree.
  git('init','-q','-b','fixture'); await writeFile(join(h.root,TEST_PATH),'expect(rejectInvalid()).toBe(true);\n');
  await writeFile(join(h.root,'implementation.ts'),'export const implemented=false;\n');
  git('add','.');git('commit','-q','-m','frozen calibration fixture');commit=git('rev-parse','HEAD');
  planSlug=`frozen-pilot-${Date.now()}-${Math.random().toString(36).slice(2)}`;await writePlan(content());
  await h.sql`INSERT INTO harness_shared.plan_items (workspace_id,harness_slug,plan_slug,item_id,seq)
    VALUES (${WS},${HARNESS},${planSlug},'P-001',1)`;
  const item=await createIssue({kind:'task',scope:'harness:papercusp',createdBy:BUILDER,title:`Frozen fixture ${planSlug}`,body:'Verify the frozen-test completion guard.'});itemId=item.id;
  await h.sql`UPDATE harness_shared.work_items SET taken_by=${BUILDER},admission='admitted',source_plan_slug=${planSlug},source_plan_item_ids=ARRAY['P-001']
    WHERE workspace_id=${WS} AND feature_id=${itemId}`;
  expect(await setSpecClause({harnessSlug:HARNESS,planSlug,specId:'SPEC-1',planItemId:'P-001',expectedRevision:0,
    behavior:'Reject invalid input.',behaviorClass:'boundary',lifecycleStatus:'active',actorId:TESTER})).toMatchObject({status:'created'});
  redId=await testRun('fail');freezeId=await binding('manual');
});

describe('frozen-test pilot completion (real Postgres)',() => {
  it('rejects a caller-forged manifest at item creation',() => {
    expect(create.args.safeParse({kind:'task',title:'Forged freeze',payload:{_frozenTests:{bindingId:freezeId}}}).success).toBe(false);
  });
  it('accepts unchanged frozen tests with a current passing recorded run',async () => {
    expect(await register()).toMatchObject({ok:true});const run=await testRun('pass');await binding('test',BUILDER,run);
    const result=await close();expect(result,JSON.stringify(result)).toMatchObject({ok:true});
    expect((await getWorkItem(itemId,HARNESS))?.state).toBe('done');
  });
  it('refuses an absent manifest before persisting completion',async () => {await expectRefused();});
  it.each(['edit','delete'])('refuses a frozen test %s after a passing run',async action => {
    expect(await register()).toMatchObject({ok:true});await binding('test',BUILDER,await testRun('pass'));
    if(action==='edit')await writeFile(join(h.root,TEST_PATH),'expect(true).toBe(true);\n');else await rm(join(h.root,TEST_PATH));
    await expectRefused();
  });
  it('refuses never-run frozen tests',async () => {expect(await register()).toMatchObject({ok:true});await expectRefused();});
  it('refuses a latest failing run rather than an asserted pass',async () => {
    expect(await register()).toMatchObject({ok:true});const run=await testRun('pass');await binding('test',BUILDER,run);
    await h.sql`UPDATE harness_shared.test_runs SET status='fail',execution_details=jsonb_set(jsonb_set(execution_details,'{failed}','1'),'{passed}','0') WHERE id=${run}`;
    await expectRefused();
  });
  it('refuses skipped frozen-test proof',async () => {
    expect(await register()).toMatchObject({ok:true});const run=await testRun('pass');await binding('test',BUILDER,run);
    await h.sql`UPDATE harness_shared.test_runs SET execution_details=jsonb_set(execution_details,'{skipped}','1') WHERE id=${run}`;
    await expectRefused();
  });
  it('refuses a source edit after the passing run even when the tests stayed frozen',async () => {
    expect(await register()).toMatchObject({ok:true});await binding('test',BUILDER,await testRun('pass'));
    await writeFile(join(h.root,'implementation.ts'),'export const implemented="different";\n');await expectRefused();
  });
  it('leaves a non-pilot plan completion unaffected',async () => {
    await writePlan(content(false));const result=await close();expect(result,JSON.stringify(result)).toMatchObject({ok:true});
  });
  it('refuses the implementer and its child as test authors',async () => {
    const own=await binding('manual',BUILDER);h.actor=TESTER;
    expect(await register(own)).toMatchObject({ok:false});h.child=true;
    expect(await register()).toMatchObject({ok:false});
    expect((await getWorkItem(itemId,HARNESS))?.payload).not.toHaveProperty('_frozenTests');
  });
  it('requires an implementer reservation before checking author independence',async () => {
    await h.sql`UPDATE harness_shared.work_items SET taken_by=NULL
      WHERE workspace_id=${WS} AND feature_id=${itemId}`;
    // Releasing taken_by appends durable history in a BEFORE trigger. Clear the
    // fixture history afterward, without firing that trigger a second time.
    await h.sql`UPDATE harness_shared.work_items SET last_released_by=NULL,terminal_owner=NULL,worked_by_history='[]'::jsonb
      WHERE workspace_id=${WS} AND feature_id=${itemId}`;
    const [unassigned]=await h.sql`SELECT taken_by,last_released_by,terminal_owner,worked_by_history
      FROM harness_shared.work_items WHERE workspace_id=${WS} AND feature_id=${itemId}`;
    expect(unassigned).toMatchObject({taken_by:null,last_released_by:null,terminal_owner:null,worked_by_history:[]});
    expect((await getWorkItem(itemId,HARNESS))?.assignee).toBeNull();
    expect(await register()).toMatchObject({ok:false,error:'frozen_tests_implementer_unassigned'});
    expect((await getWorkItem(itemId,HARNESS))?.payload).not.toHaveProperty('_frozenTests');
    await h.sql`UPDATE harness_shared.work_items SET taken_by=${BUILDER}
      WHERE workspace_id=${WS} AND feature_id=${itemId}`;
    expect(await register()).toMatchObject({ok:true,frozenTests:{revision:1}});
  });
  it('refuses uncalibrated infrastructure-red evidence',async () => {
    await h.sql`UPDATE harness_shared.test_runs SET execution_details=jsonb_set(execution_details,'{failedCaseTitles}','[]') WHERE id=${redId}`;
    expect(await register()).toMatchObject({ok:false});
  });
  it('requires a matching recorded Decision and original author for re-freeze',async () => {
    expect(await register()).toMatchObject({ok:true});await writeFile(join(h.root,TEST_PATH),'expect(rejectAllInvalid()).toBe(true);\n');
    git('add',TEST_PATH);git('commit','-q','-m','explicit fixture test amendment');commit=git('rev-parse','HEAD');
    redId=await testRun('fail');const next=await binding('manual');
    expect(await register(next,1)).toMatchObject({ok:false});
    const record={itemId,fromRevision:1,toRevision:2,previousBindingId:freezeId,bindingId:next,reason:'A newly specified boundary requires the stronger test.'};
    await writePlan(content(true,`### D-001 — Re-freeze this item\n\`\`\`frozen-tests\n${JSON.stringify(record)}\n\`\`\``));
    expect(await register(next,1,'D-001')).toMatchObject({ok:true,frozenTests:{revision:2}});
    await binding('test',BUILDER,await testRun('pass'));expect(await close()).toMatchObject({ok:true});
  });
});
