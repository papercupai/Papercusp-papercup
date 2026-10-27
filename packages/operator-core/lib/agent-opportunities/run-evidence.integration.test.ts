import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createOrgTestDb } from '../../test/_org-test-db';
import { readMonitoredFireSnapshot } from '../harness/routines/fire-provenance';
import { MONITORED_FAMILIES, assessMonitoredRun } from './pipeline';
import { miningScopeId } from './privacy';
import { monitoredTestRunGroup, readMonitoredRunEvidence, type MonitoredRunReadOptions,
  type MonitoredWorkflowReader } from './run-evidence';

let db: Awaited<ReturnType<typeof createOrgTestDb>>;
let opts: MonitoredRunReadOptions;
let status: { workflowID: string; workflowName: string; status: string; input?: unknown[] };
let steps: NonNullable<Awaited<ReturnType<MonitoredWorkflowReader['steps']>>>;
let started: string, finished: string, workflowId: string;
const ws = 'monitored-run-reader', harness = 'reader-test', routine = 'reader-census';
const sha = 'a'.repeat(40), runtime = 'reader-fixture:123:456', candidate = 'b'.repeat(64);
const file = 'packages/operator-core/lib/agent-opportunities/pipeline.deployed.integration.test.ts';
const source = { workspaceId: ws, sourceBoundary: 'tool-ledger', epoch: 'reader-v1', key: new Uint8Array(32).fill(73) };
const workflow: MonitoredWorkflowReader = { status: async () => status, steps: async () => steps };
beforeAll(async () => {
  db = await createOrgTestDb();
  await db.adminSql.unsafe(readFileSync(new URL('../../../../libs/papercusp/libs/db/sql/1583-sql-intent-monitored-family-runs.sql', import.meta.url), 'utf8'));
}, 120_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await db.adminSql`DELETE FROM harness_shared.sql_intent_runs WHERE workspace_id=${ws}`;
  await db.adminSql`DELETE FROM harness_shared.routines WHERE workspace_id=${ws}`;
  await db.adminSql`DELETE FROM harness_shared.work_items WHERE workspace_id=${ws}`;
  await db.adminSql`DELETE FROM harness_shared.scout_routed_ideas WHERE workspace_id=${ws}`;
  await db.adminSql`DELETE FROM harness_shared.sql_candidate_reviews WHERE workspace_id=${ws}`;
  await db.adminSql`DELETE FROM harness_shared.test_runs WHERE workspace_id=${ws}`;
  opts = { workspaceId: ws, harnessSlug: harness, scope: source, client: db.adminSql,
    authorize: async () => true, runId: randomUUID(), timeBudgetMs: 30_000 };
  const now = Date.now(), due = new Date(now - 20_000).toISOString();
  started = new Date(now - 19_000).toISOString(); finished = new Date(now - 18_000).toISOString();
  workflowId = 'reader-workflow-' + opts.runId;
  await db.adminSql`INSERT INTO harness_shared.routines
    (id,workspace_id,install_slug,name,trigger_kind,target_role,trigger_config,active)
    VALUES (${routine},${ws},${harness},'reader','cron','system:sql-read-census','{"cron":"0 17 4 * * *"}'::jsonb,true)`;
  const snapshot = await readMonitoredFireSnapshot(db.adminSql, ws, routine);
  const provenance = { version: 1, origin: 'scheduler', scheduledAt: due, configHash: snapshot!.configHash };
  status = { workflowID: workflowId, workflowName: 'routineFire', status: 'SUCCESS',
    input: [routine, ws, harness, 'system:sql-read-census', {}, null, 'reader', null, null, provenance] };
  const before = { ...snapshot, sha, runtime, observedAt: new Date(now - 19_500).toISOString() };
  const after = { ...before, observedAt: new Date(now - 17_500).toISOString() };
  steps = [{ functionID: 0, name: 'routine-fire-start', error: null, output: {
    routineId: routine, workspaceId: ws, installSlug: harness, targetRole: 'system:sql-read-census', provenance, snapshot: before } },
  { functionID: 3, name: 'routine-fire-finish', error: null, output: { provenance, snapshot: after } }];
  await db.adminSql`INSERT INTO harness_shared.sql_intent_runs
    (workspace_id,run_id,scope_id,harness_slug,routine_id,workflow_id,source_sha,runtime_id,started_at,finished_at)
    VALUES (${ws},${opts.runId}::uuid,${miningScopeId(source, harness)},${harness},${routine},${workflowId},${sha},${runtime},
      ${started}::timestamptz,${finished}::timestamptz)`;
  for (const family of MONITORED_FAMILIES) await db.adminSql`INSERT INTO harness_shared.sql_intent_family_runs
    (workspace_id,run_id,family,coverage,scanned,qualifying,diagnostics)
    VALUES (${ws},${opts.runId}::uuid,${family},'measured',2,1,${JSON.stringify({ candidates:
      family === 'search-reformulation' ? [{ id: candidate, reviewEligible: true }] : [] })}::jsonb)`;
});
const read = (over: Partial<MonitoredRunReadOptions> = {}) => readMonitoredRunEvidence({ ...opts, ...over }, { workflow });
async function seedReviewAndTest() {
  const pointer = { runId: opts.runId, family: 'search-reformulation', candidateId: candidate,
    lifecycleId: 'c'.repeat(64), editionId: 'd'.repeat(64) };
  const payload = { monitoredCandidateReview: pointer, agentReview: { status: 'approved', round: 1,
    ledgerIdeaId: 'reader-idea', timing: { round: 1, enteredAt: new Date(Date.parse(started) - 1000).toISOString(), decidedAt: finished } } };
  await db.adminSql`INSERT INTO harness_shared.work_items (workspace_id,harness_slug,feature_id,title,status,item_kind,payload)
    VALUES (${ws},${harness},'EI-reader-fixture','Reader fixture','open','feature',${JSON.stringify(payload)}::jsonb)`;
  await db.adminSql`INSERT INTO harness_shared.scout_routed_ideas
    (idea_id,workspace_id,harness_slug,lens,rail,routed_ref,routed_at,human_grade,graded_by,graded_at)
    VALUES ('reader-idea',${ws},${harness},'first-principles','improvement','wi:EI-reader-fixture',0,5,'su-independent-reviewer',${finished}::timestamptz)`;
  await db.adminSql`INSERT INTO harness_shared.sql_candidate_reviews
    (workspace_id,harness_slug,lifecycle_id,edition_id,artifact_id,suppressed)
    VALUES (${ws},${harness},${pointer.lifecycleId},${pointer.editionId},'EI-reader-fixture',false)`;
  const [test] = await db.adminSql`INSERT INTO harness_shared.test_runs
    (workspace_id,harness_slug,file_path,framework,status,commit_sha,run_group_id,worktree_dirty,is_scratch_config,
      started_at,finished_at,execution_details)
    VALUES (${ws},${harness},${file},'vitest','pass',${sha},${monitoredTestRunGroup(opts.runId, runtime)},false,false,
      ${new Date(Date.parse(started) - 1000).toISOString()}::timestamptz,
      ${new Date(Date.parse(finished) + 1000).toISOString()}::timestamptz,'{"testLayer":"integration","skipped":0}'::jsonb)
    RETURNING id`;
  await db.adminSql`INSERT INTO harness_shared.test_case_runs (test_run_id,case_index,case_key,occurrence,status)
    VALUES (${test!.id},0,'R13-DEPLOYED',1,'pass')`;
}

it('reads native rows independently and cannot invent review or test proof from a finished census', async () => {
  const result = await read(); expect(result.status).toBe('read');
  if (result.status !== 'read') return;
  expect(result.evidence.run).toMatchObject({ id: opts.runId, operationId: workflowId + ':0', trigger: 'scheduler', sha, runtime });
  expect(result.evidence.families).toHaveLength(5);
  expect(result.evidence.reviews).toEqual([]); expect(result.evidence.testRuns).toEqual([]);
  expect(assessMonitoredRun(result.evidence)).toMatchObject({ status: 'fail',
    failures: expect.arrayContaining(['canonical-review-transition', 'deployed-test-binding']) });
});
it('joins canonical review grade, applied round and exact native passed test case for the same runtime/run', async () => {
  await seedReviewAndTest(); const result = await read(); expect(result.status).toBe('read');
  if (result.status !== 'read') return;
  expect(result.evidence.reviews).toMatchObject([{ owner: 'su-independent-reviewer', outcome: 'accepted' }]);
  expect(result.evidence.testRuns).toMatchObject([{ caseName: 'R13-DEPLOYED', sha, runtime }]);
  expect(assessMonitoredRun(result.evidence).status).toBe('pass');
  // This fixture is a reader/assessor control. It never executes or certifies a deployed run.
});
it('rejects wrong scope, denied authority and revocation during asynchronous hydration', async () => {
  expect((await read({ harnessSlug: 'other' })).status).toBe('UNKNOWN');
  expect((await read({ workspaceId: 'other' })).status).toBe('UNKNOWN');
  expect((await read({ authorize: async () => false })).status).toBe('UNKNOWN');
  let grants = 0;
  expect((await read({ authorize: async () => ++grants === 1 })).status).toBe('UNKNOWN');
});
it('keeps nine-argument legacy fires, malformed SDK envelopes and missing boundaries UNKNOWN', async () => {
  const original = status.input!; status.input = original.slice(0, 9);
  expect((await read()).status).toBe('UNKNOWN'); status.input = original;
  const saved = steps; steps = saved.slice(0, 1);
  expect((await read()).status).toBe('UNKNOWN'); steps = saved;
  steps = [{ ...saved[0]!, output: { json: saved[0]!.output, __dbos_serializer: 'superjson' } }, saved[1]!];
  expect((await read()).status).toBe('UNKNOWN');
});
it('detects boundary runtime drift, retuning, pause and normalized child deletion', async () => {
  const last = steps[1]!.output as { snapshot: { runtime: string } };
  last.snapshot.runtime = 'different-process'; expect((await read()).status).toBe('UNKNOWN'); last.snapshot.runtime = runtime;
  await db.adminSql`UPDATE harness_shared.routines SET active=false WHERE id=${routine}`;
  expect((await read()).status).toBe('UNKNOWN');
  await db.adminSql`UPDATE harness_shared.routines SET active=true,trigger_config='{"cron":"* * * * *"}'::jsonb WHERE id=${routine}`;
  expect((await read()).status).toBe('UNKNOWN');
  await db.adminSql`UPDATE harness_shared.routines SET trigger_config='{"cron":"0 17 4 * * *"}'::jsonb WHERE id=${routine}`;
  await db.adminSql`DELETE FROM harness_shared.sql_intent_family_runs WHERE workspace_id=${ws} AND family='sql'`;
  expect((await read()).status).toBe('UNKNOWN');
});
it('does not turn UNKNOWN native coverage into all-family success', async () => {
  await seedReviewAndTest();
  await db.adminSql`UPDATE harness_shared.sql_intent_family_runs SET coverage='UNKNOWN'
    WHERE workspace_id=${ws} AND family='native-operation'`;
  const result = await read(); expect(result.status).toBe('read');
  if (result.status === 'read') expect(assessMonitoredRun(result.evidence)).toMatchObject({ status: 'UNKNOWN',
    unknown: ['family:native-operation:UNKNOWN'] });
});
it('requires the canonical grade rather than an authored approved flag and rejects stale rounds', async () => {
  await seedReviewAndTest();
  await db.adminSql`UPDATE harness_shared.scout_routed_ideas SET human_grade=3 WHERE idea_id='reader-idea'`;
  let result = await read(); expect(result.status).toBe('read');
  if (result.status === 'read') expect(result.evidence.reviews).toEqual([]);
  await db.adminSql`UPDATE harness_shared.scout_routed_ideas SET human_grade=5,graded_at='2000-01-01'::timestamptz WHERE idea_id='reader-idea'`;
  result = await read();
  if (result.status === 'read') expect(result.evidence.reviews).toEqual([]);
});
it('requires the applied round and grade to fall inside its canonical review interval', async () => {
  await seedReviewAndTest();
  await db.adminSql`UPDATE harness_shared.work_items
    SET payload=jsonb_set(payload,'{agentReview,timing,round}','2'::jsonb) WHERE workspace_id=${ws}`;
  let result = await read(); expect(result.status).toBe('read');
  if (result.status === 'read') expect(result.evidence.reviews).toEqual([]);
  await db.adminSql`UPDATE harness_shared.work_items
    SET payload=jsonb_set(payload,'{agentReview,timing,round}','1'::jsonb) WHERE workspace_id=${ws}`;
  await db.adminSql`UPDATE harness_shared.scout_routed_ideas
    SET graded_at=${new Date(Date.parse(finished) + 1000).toISOString()}::timestamptz WHERE idea_id='reader-idea'`;
  result = await read(); expect(result.status).toBe('read');
  if (result.status === 'read') expect(result.evidence.reviews).toEqual([]);
});
it.each(['family', 'review-grade', 'review-reservation', 'test-status', 'test-case'] as const)(
  'fails closed when %s evidence changes after hydration while the parent is unchanged', async kind => {
    await seedReviewAndTest();
    let changed = false;
    const client = new Proxy(db.adminSql, { apply(target, thisArg, args) {
      const rows = Reflect.apply(target, thisArg, args);
      if (!(args[0] as TemplateStringsArray).join('?').includes('FROM harness_shared.test_runs')) return rows;
      return Promise.resolve(rows).then(async result => {
        if (!changed) {
          changed = true;
          if (kind === 'family') await db.adminSql`DELETE FROM harness_shared.sql_intent_family_runs
            WHERE workspace_id=${ws} AND family='sql'`;
          if (kind === 'review-grade') await db.adminSql`UPDATE harness_shared.scout_routed_ideas
            SET human_grade=1 WHERE idea_id='reader-idea'`;
          if (kind === 'review-reservation') await db.adminSql`UPDATE harness_shared.sql_candidate_reviews
            SET suppressed=true WHERE workspace_id=${ws}`;
          if (kind === 'test-status') await db.adminSql`UPDATE harness_shared.test_runs
            SET status='fail' WHERE workspace_id=${ws}`;
          if (kind === 'test-case') await db.adminSql`UPDATE harness_shared.test_case_runs SET status='fail'
            WHERE test_run_id IN (SELECT id FROM harness_shared.test_runs WHERE workspace_id=${ws})`;
        }
        return result;
      });
    } });
    expect(await read({ client })).toEqual({ status: 'UNKNOWN', reasons: ['normalized-evidence-changed'] });
    expect(changed).toBe(true);
  });
it('rejects dirty, skipped, wrong-group and wrong-case test evidence independently of the asserted pass', async () => {
  await seedReviewAndTest();
  for (const mutation of ["worktree_dirty=true", "run_group_id='unbound'", "execution_details='{}'::jsonb"]) {
    await db.adminSql`UPDATE harness_shared.test_runs SET worktree_dirty=false,
      run_group_id=${monitoredTestRunGroup(opts.runId, runtime)},execution_details='{"testLayer":"integration","skipped":0}'::jsonb
      WHERE workspace_id=${ws}`;
    await db.adminSql.unsafe('UPDATE harness_shared.test_runs SET ' + mutation + " WHERE workspace_id='monitored-run-reader'");
    const result = await read(); expect(result.status).toBe('read');
    if (result.status === 'read') expect(result.evidence.testRuns).toEqual([]);
  }
});
