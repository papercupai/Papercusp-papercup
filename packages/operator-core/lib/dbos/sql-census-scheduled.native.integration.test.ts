/** Current-build scheduler proof in a disposable runtime; never R13 production evidence. */
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../..');
const deadlines = isolatedWorkerOptions(180_000);
const journey = String.raw`
  import assert from 'node:assert/strict';
  import { mkdir } from 'node:fs/promises';
  import { join } from 'node:path';
  import { setTimeout as delay } from 'node:timers/promises';
  import { DBOS } from '@dbos-inc/dbos-sdk';
  import { getOrgPg, listDueCronRoutines, upsertRoutine, _resetForTests } from '@papercusp/db-org';
  import { _stopInvalidationListenerForTests } from '@papercusp/agent-mcp/auth';
  import { _stopHubForTests } from './packages/operator-core/lib/pg-listen-hub.ts';
  import { flushFallbackObservations } from './packages/operator-core/lib/degradation/fallback-observations.ts';
  import { saveHarnessRegistry } from './packages/operator-core/lib/harness-registry.ts';
  import { computeNextFireAt } from './packages/operator-core/lib/harness/routines/cron.ts';
  import { scheduledCensusWorkflowId, monitoredCensusRunId, monitoredRuntimeId,
    routineDefinitionHash } from './packages/operator-core/lib/harness/routines/fire-provenance.ts';
  import { monitoredTestRunGroup } from './packages/operator-core/lib/agent-opportunities/run-evidence.ts';
  import { MONITORED_FAMILIES } from './packages/operator-core/lib/agent-opportunities/pipeline.ts';

  const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID;
  assert.match(workspaceId, /^test-runtime-/);
  assert.match(process.env.HOME, /papercusp-test-runtime-.*\/home$/);
  assert.equal(process.env.PAPERCUSP_HOME, join(process.env.HOME, '.papercusp'));
  assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
  assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
  assert.equal(process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES, 'none');
  assert.equal(process.env.PAPERCUSP_SID, undefined);
  const dsn = new URL(process.env.HARNESS_ADMIN_DATABASE_URL);
  assert.equal(Number(dsn.port), Number(process.env.PAPERCUSP_PG_PORT));
  assert.notEqual(dsn.port, '5432');
  const { sql } = getOrgPg();
  const [database] = await sql.unsafe('SELECT current_database() AS name, inet_server_port() AS port');
  assert.equal(database.port, Number(dsn.port));
  const corpus = join(process.env.HOME, 'private-census-corpus');
  await mkdir(corpus);
  await saveHarnessRegistry({ projects: [{ slug: workspaceId, path: corpus, harness_kind: 'hive' }] }, workspaceId);

  const progress = stage => console.log('P013_SCHEDULED_PROGRESS ' + JSON.stringify({ stage, at: Date.now() }));
  // Run the real registered dispatch timer in this disposable database. Keep
  // its unrelated sweep timer outside this worker's lifetime; no private export.
  const deferred = new Date(Date.now() + 2 * 86400_000);
  const cron = [0, deferred.getMinutes(), deferred.getHours(), deferred.getDate(), deferred.getMonth() + 1, '*'].join(' ');
  process.env.PAPERCUSP_DBOS_ROUTINES_CRONTAB = '* * * * * *';
  process.env.PAPERCUSP_DBOS_ROUTINES_SWEEP_CRONTAB = cron;
  DBOS.setConfig({ name: 'private-scheduled-census', systemDatabaseUrl: process.env.HARNESS_ADMIN_DATABASE_URL,
    systemDatabaseSchemaName: 'dbos', applicationVersion: 'private-scheduled-census-v1', runAdminServer: false });
  await import('./packages/operator-core/lib/dbos/routines-workflow.ts');
  const routine = await upsertRoutine(sql, { workspaceId, installSlug: workspaceId,
    name: 'private-sql-read-census', triggerKind: 'cron', targetRole: 'system:sql-read-census',
    triggerConfig: { cron: '0 2 * * *', window_days: 7 }, concurrency: 'skip',
    nextFireAt: new Date(Date.now() - 1000) }, computeNextFireAt);
  const due = (await listDueCronRoutines(sql)).find(row => row.id === routine.id);
  assert.ok(due?.nextFireAt, 'private routine must enter the production due list');
  const workflowId = scheduledCensusWorkflowId(workspaceId, due.id, due.nextFireAt);
  const runId = monitoredCensusRunId(workspaceId, workflowId);
  const group = monitoredTestRunGroup(runId, monitoredRuntimeId);
  const selectedAt = Date.now();
  assert.equal((await sql.unsafe('SELECT run_id FROM harness_shared.sql_intent_runs WHERE workspace_id=$1',
    [workspaceId])).length, 0, 'selection must precede the native action');

  try {
    progress('launch-start');
    await DBOS.launch();
    progress('launch-complete-await-scheduled-child');
    const deadline = Date.now() + 120_000;
    let status;
    while (Date.now() < deadline) {
      status = await DBOS.getWorkflowStatus(workflowId);
      if (status && ['SUCCESS', 'ERROR', 'CANCELLED'].includes(status.status)) break;
      await delay(100);
    }
    assert.equal(status?.status, 'SUCCESS', 'the selected scheduler child must settle');
    progress('scheduled-child-settled');
    const steps = await DBOS.listWorkflowSteps(workflowId, { limit: 129 });
    const start = steps.find(step => step.name === 'routine-fire-start')?.output;
    const finish = steps.find(step => step.name === 'routine-fire-finish')?.output;
    const expected = { version: 1, origin: 'scheduler', scheduledAt: due.nextFireAt.toISOString(),
      configHash: routineDefinitionHash(due) };
    for (const boundary of [start, finish]) {
      assert.deepEqual(boundary?.provenance, expected);
      assert.equal(boundary?.snapshot?.runtime, monitoredRuntimeId);
      assert.equal(boundary?.snapshot?.routineId, due.id);
      assert.equal(boundary?.snapshot?.configHash, expected.configHash);
    }
    assert.ok(steps.some(step => step.name === 'system:sql-read-census'), 'real registered action must execute');
    const rows = await sql.unsafe('SELECT run_id::text, workflow_id, routine_id, runtime_id, started_at, finished_at FROM harness_shared.sql_intent_runs WHERE workspace_id=$1', [workspaceId]);
    assert.equal(rows.length, 1);
    const run = rows[0];
    assert.equal(run.run_id, runId);
    assert.equal(run.workflow_id, workflowId);
    assert.equal(run.routine_id, due.id);
    assert.equal(run.runtime_id, monitoredRuntimeId);
    assert.ok(Date.parse(run.started_at) >= selectedAt);
    assert.ok(run.finished_at);
    assert.equal(monitoredTestRunGroup(run.run_id, run.runtime_id), group);
    const families = await sql.unsafe('SELECT family, coverage FROM harness_shared.sql_intent_family_runs WHERE workspace_id=$1 AND run_id=$2::uuid ORDER BY family', [workspaceId, runId]);
    assert.deepEqual([...families].map(row => row.family).sort(), [...MONITORED_FAMILIES].sort());
    assert.equal((await listDueCronRoutines(sql)).some(row => row.id === due.id), false,
      'the real scheduler must advance the claimed due slot');
    await delay(1200); // Observe the next real private timer tick.
    assert.equal((await sql.unsafe('SELECT run_id FROM harness_shared.sql_intent_runs WHERE workspace_id=$1', [workspaceId])).length, 1,
      'the advanced due slot must not mine a second census');
    console.log('P013_SCHEDULED_NATIVE ' + JSON.stringify({ workspaceId, database, workflowId, runId,
      runtime: monitoredRuntimeId, group, selectedAt, families, steps: steps.map(step => step.name),
      productionAcceptance: false }));
  } finally {
    progress('shutdown-start');
    try { await DBOS.shutdown(); }
    finally {
      try { await _stopInvalidationListenerForTests(); }
      finally {
        try { await _stopHubForTests(); }
        finally {
          try { await flushFallbackObservations({ sql }); }
          finally { await _resetForTests(); }
        }
      }
    }
  }
  await new Promise(done => setImmediate(done));
  const privatePgSockets = (process.report.getReport().libuv ?? []).filter(handle =>
    handle.type === 'tcp' && handle.is_referenced && Number(handle.remoteEndpoint?.port) === Number(dsn.port));
  assert.deepEqual(privatePgSockets, [], 'private child must retire every database socket');
  console.log('P013_SCHEDULED_TEARDOWN ' + JSON.stringify({ pgPort: Number(dsn.port), privatePgSockets: 0 }));
`;

it('preselects a census identity and executes it through the real scheduled DBOS dispatch in isolation', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/dbos/sql-census-scheduled.native.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/lib/dbos/routines-workflow.ts',
      'packages/operator-core/lib/harness/routines/fire-provenance.ts',
      'packages/operator-core/lib/harness/routines/sql-read-census-action.ts',
      'packages/operator-core/lib/harness/routines/claim.ts',
      'packages/operator-core/lib/agent-opportunities/census.ts',
      'packages/operator-core/lib/agent-opportunities/run-evidence.ts'],
    retainedArtifacts: ['phases/execute/native-census.json', 'phases/execute/native-teardown.json'],
    execute: async (observe, evidenceDir) => {
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
        PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES: 'none' };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime', '--',
        process.execPath, '--import', 'tsx', '--input-type=module', '-e', journey],
      { cwd: root, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      const result = await captureIsolatedWorker(child, evidenceDir, deadlines);
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      for (const [prefix, name] of [['P013_SCHEDULED_NATIVE ', 'native-census.json'],
        ['P013_SCHEDULED_TEARDOWN ', 'native-teardown.json']]) {
        const line = result.output.split('\n').find(row => row.startsWith(prefix!));
        expect(line, name).toBeDefined();
        await writeFile(join(evidenceDir, name!), line!.slice(prefix!.length));
      }
      const complete = result.output.split('\n').filter(line => line.startsWith('[with-test-pg] cleanup '))
        .map(line => JSON.parse(line.slice('[with-test-pg] cleanup '.length)))
        .find(stage => stage.stage === 'complete');
      expect(complete).toMatchObject({ runtimeRemoved: true, pgDataRemoved: true });
      expect(existsSync(complete.runtimeRoot)).toBe(false);
      expect(existsSync(complete.dataDir)).toBe(false);
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, deadlines.testTimeoutMs);
