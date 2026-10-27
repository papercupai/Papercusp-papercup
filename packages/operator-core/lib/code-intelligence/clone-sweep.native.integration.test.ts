import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { CloneIndex } from './clone-index';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../..');
const deadlines = isolatedWorkerOptions(360_000);
const cloneCorpusSource = 'export function sum(xs: number[]) { let total = 0; for (const x of xs) { if (x > 0) { total += x; } else { total -= x; } if (x % 2 === 0) { total += x * 2; } else { total += x * 3; } if (x > 100) { total -= 10; } else if (x < -100) { total += 10; } } return total + xs.length; }';

// The background worker loads production source and starts the actual managed
// CLI. Its private workspace and database cannot file findings in the live pot.
const journey = String.raw`
  import assert from 'node:assert/strict';
  import { execFileSync } from 'node:child_process';
  import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
  import { readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { setTimeout as delay } from 'node:timers/promises';
  import { DBOS } from '@dbos-inc/dbos-sdk';
  import { getOrgPg, listDueCronRoutines, _resetForTests } from '@papercusp/db-org';
  import { _stopInvalidationListenerForTests } from '@papercusp/agent-mcp/auth';
  import { _stopHubForTests } from './packages/operator-core/lib/pg-listen-hub.ts';
  import { flushFallbackObservations } from './packages/operator-core/lib/degradation/fallback-observations.ts';
  import { saveHarnessRegistry } from './packages/operator-core/lib/harness-registry.ts';
  import { armPlanSchedule, disarmPlanSchedule } from './packages/operator-core/lib/harness/routines/arm-plan-schedule.ts';
  import { materializePlanSchedule } from './packages/operator-core/lib/harness/routines/materialize-plan-schedule.ts';
  import { claimDueRoutine, claimedRoutineDispatchAllowed } from './packages/operator-core/lib/harness/routines/claim.ts';
  import { getTask, listTasks } from './packages/operator-core/lib/task-manager/store.ts';
  import { killTask } from './packages/operator-core/lib/task-manager/control.ts';
  import { readProcessIdentity } from './packages/operator-core/lib/process-identity.ts';

  const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID;
  assert.match(workspaceId, /^test-runtime-/);
  assert.notEqual(new URL(process.env.HARNESS_ADMIN_DATABASE_URL).port, '5432');
  assert.match(process.env.HOME, /papercusp-test-runtime-.*\/home$/);
  assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0', 'private supervisor must scrub ambient scheduler enablement');
  assert.equal(process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES, 'none', 'private fixture must disable unrelated orchestrator timers before imports');
  const sourceRoot = process.cwd();
  const corpus = await mkdtemp(join(process.env.TMPDIR, 'clone-sweep-corpus-'));
  await mkdir(join(corpus, 'packages/a'), { recursive: true });
  await mkdir(join(corpus, 'apps/b'), { recursive: true });
  await mkdir(join(corpus, 'scripts'));
  await symlink(join(sourceRoot, 'node_modules'), join(corpus, 'node_modules'), 'dir');
  await symlink(join(sourceRoot, 'scripts/clone-family-sweep.mts'), join(corpus, 'scripts/clone-family-sweep.mts'));
  const source = ${JSON.stringify(cloneCorpusSource)};
  await writeFile(join(corpus, 'packages/a/a.ts'), source);
  await writeFile(join(corpus, 'apps/b/b.ts'), source.replace('sum(', 'sumAgain('));
  // This disposable corpus has no commits, remotes or shared working tree.
  execFileSync('git', ['init', '--quiet', corpus]);
  await saveHarnessRegistry({ projects: [{ slug: workspaceId, path: corpus, harness_kind: 'hive' }] }, workspaceId);

  const tasks = [];
  const taskIds = [];
  const workflowReceipts = [];
  const { sql } = getOrgPg();
  const templateSlug = 'private-clone-family-nightly';
  const schedule = { kind: 'cron', cron: '0 2 * * *', tzid: 'America/New_York',
    concurrency: 'skip', catchup: 'skip-old',
    action: { system: 'clone-family-sweep', input: { harness: workspaceId, clonePolicy: 'reuse-signals-v1' } } };
  const privateTasks = () => listTasks({ workspaceId, launchedBy: 'system:clone-family-sweep', includeEnded: true, limit: 100 });
  const dueNow = async id => {
    await sql.unsafe('UPDATE harness_shared.routines SET next_fire_at = $1 WHERE id = $2',
      [new Date(Date.now() - 1000), id]);
    const due = (await listDueCronRoutines(sql)).find(row => row.id === id);
    assert.ok(due, 'armed private cadence must enter the production due list');
    return due;
  };
  DBOS.setConfig({ name: 'private-clone-family-schedule', systemDatabaseUrl: process.env.HARNESS_ADMIN_DATABASE_URL,
    systemDatabaseSchemaName: 'dbos', applicationVersion: 'private-clone-family-schedule-v1', runAdminServer: false });
  // Importing the production fire module also registers its unrelated scheduler
  // ticks. Defer those private tick timers beyond this fixture's deadline; the
  // clone cadence below keeps its real nightly configuration and due claims.
  const deferredTick = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const tickCron = [0, deferredTick.getMinutes(), deferredTick.getHours(),
    deferredTick.getDate(), deferredTick.getMonth() + 1, '*'].join(' ');
  process.env.PAPERCUSP_DBOS_ROUTINES_CRONTAB = tickCron;
  process.env.PAPERCUSP_DBOS_ROUTINES_SWEEP_CRONTAB = tickCron;
  const { routineFireWorkflow } = await import('./packages/operator-core/lib/dbos/routines-workflow.ts');
  const fire = async (routine, fireId) => {
    const handle = await DBOS.startWorkflow(routineFireWorkflow, { workflowID: fireId })(
      routine.id, routine.workspaceId, routine.installSlug, routine.targetRole,
      routine.triggerConfig, routine.payloadTemplate, routine.name);
    await handle.getResult();
    const [terminal] = await sql.unsafe('SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1', [fireId]);
    assert.equal(terminal?.status, 'SUCCESS');
    const steps = await sql.unsafe('SELECT function_name FROM dbos.operation_outputs WHERE workflow_uuid = $1 ORDER BY function_id', [fireId]);
    const names = steps.map(row => row.function_name);
    assert.deepEqual(names.slice(0, 2), ['routine-fire-start', 'routine-fire-active-fence']);
    workflowReceipts.push({ fireId, routineId: routine.id, targetRole: routine.targetRole, status: terminal.status, steps: names });
    return names;
  };
  const run = async (routine, fireId) => {
    const names = await fire(routine, fireId);
    assert.ok(names.includes('system:clone-family-sweep'), 'production workflow must execute the registered sweep action');
    const launched = (await privateTasks()).find(task => task.detail.fireId === fireId);
    assert.ok(launched, 'DBOS action must create an actual managed task');
    assert.equal(launched.detail.routineId, routine.id);
    const taskId = launched.taskId;
    taskIds.push(taskId);
    const cutoff = Date.now() + 120_000;
    let task;
    while (Date.now() < cutoff) {
      task = await getTask(taskId);
      if (task?.endedAt) break;
      await delay(100);
    }
    assert.ok(task?.endedAt, 'managed sweep must reach a terminal ledger state');
    assert.equal(task.workspaceId, workspaceId);
    assert.equal(task.class, 'build');
    assert.equal(task.launchedBy, 'system:clone-family-sweep');
    assert.equal(task.memoryMaxBytes, 4 * 1024 ** 3);
    assert.ok(task.deadlineAt, 'managed sweep must retain its execution deadline');
    assert.equal(task.state, 'exited');
    assert.equal(task.exitCode, 0, readFileSync(task.logPath, 'utf8'));
    assert.ok(task.processIdentity, 'native process identity must be recorded');
    assert.notEqual(readProcessIdentity(task.pid), task.processIdentity, 'original managed child must have exited');
    tasks.push({ taskId, fireId, routineId: routine.id, pid: task.pid, processIdentity: task.processIdentity,
      state: task.state, exitCode: task.exitCode, confined: task.confined });
    const outcomes = readFileSync(task.logPath, 'utf8').split('\n').flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const outcome = outcomes.find(row => row.schemaVersion === 1 && row.fireId === fireId);
    assert.ok(outcome, 'actual CLI must retain its sweep outcome');
    assert.equal(outcome.indexed, 2);
    assert.deepEqual(outcome.incomplete, []);
    assert.equal(outcome.rows.length, 1);
    return outcome;
  };

  try {
    await sql.unsafe('INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, schedule) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)',
      [workspaceId, workspaceId, templateSlug, 'Private clone-family cadence', 'ready', '# Private cadence', 'private', JSON.stringify(schedule)]);
    assert.equal((await listDueCronRoutines(sql)).some(row => row.workspaceId === workspaceId), false,
      'authoring alone must not create a private due routine');
    assert.equal((await privateTasks()).length, 0);
    const unarmed = await materializePlanSchedule({ sql, workspaceId, harnessSlug: workspaceId, templateSlug,
      schedule, action: schedule.action, active: false });
    await sql.unsafe('UPDATE harness_shared.routines SET next_fire_at = $1 WHERE id = $2', [new Date(Date.now() - 1000), unarmed.id]);
    assert.equal((await listDueCronRoutines(sql)).some(row => row.id === unarmed.id), false);
    assert.equal(await claimedRoutineDispatchAllowed(sql, { id: unarmed.id, triggerConfig: schedule, rescheduleIntervalSec: null }), false);
    assert.equal((await privateTasks()).length, 0, 'unarmed schedule must not launch a sweep');

    const armed = await armPlanSchedule({ sql, workspaceId, harnessSlug: workspaceId, templateSlug, schedule });
    assert.equal(armed.ok, true);
    assert.equal(armed.routineId, unarmed.id, 'canonical arm must reuse the authored routine');
    const [plan] = await sql.unsafe('SELECT schedule_active FROM harness_shared.harness_plans WHERE workspace_id = $1 AND harness_slug = $2 AND plan_slug = $3', [workspaceId, workspaceId, templateSlug]);
    assert.equal(plan.schedule_active, true);
    const due = await dueNow(armed.routineId);
    assert.equal(due.targetRole, 'system:clone-family-sweep');
    assert.equal(due.concurrency, 'skip');
    assert.equal(due.triggerConfig.cron, '0 2 * * *');
    assert.equal(due.triggerConfig.tzid, 'America/New_York');
    assert.equal(due.triggerConfig.catchup, 'skip-old');
    assert.equal(due.triggerConfig.action, undefined);
    assert.deepEqual(due.payloadTemplate.input, schedule.action.input);
    const winners = await Promise.all([claimDueRoutine(sql, due), claimDueRoutine(sql, due)]);
    assert.equal(winners.filter(Boolean).length, 1, 'only one racing due claim may win');
    assert.equal((await listDueCronRoutines(sql)).some(row => row.id === due.id), false, 'claim must advance the cadence');
    await DBOS.launch();
    const first = await run(due, 'native-first');
    assert.equal(first.created, 1);
    const secondDue = await dueNow(armed.routineId);
    assert.equal(await claimDueRoutine(sql, secondDue), true);
    const second = await run(secondDue, 'native-second');
    assert.equal(second.created, 0);
    assert.equal(second.rows[0].disposition, 'reused');
    assert.equal(second.rows[0].itemId, first.rows[0].itemId);
    assert.notEqual(tasks[0].taskId, tasks[1].taskId);

    const paused = await dueNow(armed.routineId);
    assert.equal(await claimDueRoutine(sql, paused), true);
    await disarmPlanSchedule({ sql, workspaceId, harnessSlug: workspaceId, templateSlug });
    assert.equal(await claimedRoutineDispatchAllowed(sql, paused), false);
    assert.equal(await claimDueRoutine(sql, paused), false);
    assert.deepEqual(await fire(paused, 'native-paused'), ['routine-fire-start', 'routine-fire-active-fence']);
    assert.equal((await privateTasks()).length, 2, 'queued paused fire must not spawn');

    const wrong = await materializePlanSchedule({ sql, workspaceId, harnessSlug: workspaceId,
      templateSlug: 'private-wrong-action', schedule,
      action: { system: 'p008-unregistered-control', input: schedule.action.input } });
    const wrongDue = await dueNow(wrong.id);
    assert.equal(await claimDueRoutine(sql, wrongDue), true);
    const wrongSteps = await fire(wrongDue, 'native-wrong-action');
    assert.ok(wrongSteps.includes('system:p008-unregistered-control'));
    assert.equal(wrongSteps.includes('system:clone-family-sweep'), false);
    assert.equal((await privateTasks()).length, 2, 'wrong action must not dispatch the sweep');
    const missing = { ...due, id: 'private-missing-routine' };
    assert.equal(await claimedRoutineDispatchAllowed(sql, missing), false);
    assert.deepEqual(await fire(missing, 'native-missing'), ['routine-fire-start', 'routine-fire-active-fence']);
    assert.equal((await privateTasks()).length, 2, 'absent routine must fail closed');
    const workflows = await sql.unsafe('SELECT DISTINCT name FROM dbos.workflow_status');
    assert.deepEqual(workflows.map(row => row.name), ['routineFire'], 'unrelated private scheduler ticks must not run');
    console.log('P008_NATIVE ' + JSON.stringify({ workspaceId, schedule, routineId: armed.routineId,
      deferredSchedulerTick: { cron: tickCron, until: deferredTick.toISOString() },
      controls: ['authored-only', 'unarmed', 'racing-claim', 'paused-after-claim', 'wrong-action', 'absent-routine'],
      workflowReceipts, tasks,
      familyId: first.rows[0].familyId, itemId: first.rows[0].itemId }));
  } finally {
    try {
      for (const taskId of new Set([...taskIds, ...(await privateTasks()).map(task => task.taskId)])) {
        const task = await getTask(taskId);
        assert.equal(task.workspaceId, workspaceId);
        if (task.pid && task.processIdentity && readProcessIdentity(task.pid) === task.processIdentity) {
          const stopped = await killTask(taskId, { includeSubtree: true, reapTerminalResidue: true, escalateAfterMs: 5000 });
          assert.equal(stopped.ok, true, 'owned private task cleanup must succeed');
          assert.notEqual(readProcessIdentity(task.pid), task.processIdentity);
        }
      }
    } finally {
      try { await DBOS.shutdown(); }
      finally {
        // This worker owns the disposable process, including imported LISTEN
        // clients. Ending only the org query pool leaves those sockets alive.
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
  }
  await new Promise(done => setImmediate(done));
  const pgPort = Number(new URL(process.env.HARNESS_ADMIN_DATABASE_URL).port);
  const privatePgSockets = (process.report.getReport().libuv ?? []).filter(handle =>
    handle.type === 'tcp' && handle.is_referenced && Number(handle.remoteEndpoint?.port) === pgPort);
  assert.deepEqual(privatePgSockets, [], 'private fixture must retire every referenced database socket');
  console.log('P008_NATIVE_TEARDOWN ' + JSON.stringify({ pgPort, privatePgSockets: privatePgSockets.length }));
`;

it('arms a private nightly cadence and dispatches real DBOS managed sweeps with fail-closed controls and teardown', async (context) => {
  const calibration = new CloneIndex();
  calibration.update({ path: 'packages/a/a.ts', source: cloneCorpusSource });
  calibration.update({ path: 'apps/b/b.ts', source: cloneCorpusSource.replace('sum(', 'sumAgain(') });
  expect(calibration.families('renamed'), 'native corpus must admit one family at the production mass floor').toHaveLength(1);
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/code-intelligence/clone-sweep.native.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'scripts/clone-family-sweep.mts',
      'scripts/lib/tracked-files.mjs', 'packages/operator-core/lib/code-intelligence/clone-sweep.ts',
      'packages/operator-core/lib/code-intelligence/clone-index.ts',
      'packages/operator-core/lib/harness/routines/clone-family-sweep-action.ts',
      'packages/operator-core/lib/harness/routines/arm-plan-schedule.ts',
      'packages/operator-core/lib/harness/routines/materialize-plan-schedule.ts',
      'packages/operator-core/lib/harness/routines/claim.ts',
      'packages/operator-core/lib/harness/routines/schedule-next.ts',
      'packages/operator-core/lib/harness/routines/system-actions.ts',
      'packages/operator-core/lib/harness/routines/register-system-actions.ts',
      'packages/operator-core/lib/dbos/routines-workflow.ts',
      'packages/operator-core/lib/dbos/orchestrator-loop.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'packages/operator-core/lib/task-manager/managed-spawn.ts',
      'packages/operator-core/lib/task-manager/store.ts',
      'packages/operator-core/lib/task-manager/control.ts',
      'packages/agent-mcp/src/auth.ts',
      'packages/operator-core/lib/pg-listen-hub.ts',
      'packages/operator-core/lib/degradation/fallback-observations.ts',
      'libs/papercusp/libs/db/src/connection.ts',
      'packages/operator-core/lib/harness-registry.ts'],
    retainedArtifacts: ['phases/execute/native-sweep.json', 'phases/execute/native-teardown.json'],
    execute: async (observe, evidenceDir) => {
      // Background bootstrap registers the default orchestrator before journey
      // imports run. Keep its timer off while exercising the real sweep action.
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
      const output = result.output.split('\n').find(line => line.startsWith('P008_NATIVE '));
      expect(output).toBeDefined();
      // The callback receives the execute directory; retainedArtifacts is relative to the run root.
      await writeFile(join(evidenceDir, 'native-sweep.json'), output!.slice('P008_NATIVE '.length));
      const teardown = result.output.split('\n').find(line => line.startsWith('P008_NATIVE_TEARDOWN '));
      expect(teardown, 'private worker must retain its database socket teardown assertion').toBeDefined();
      const teardownReceipt = JSON.parse(teardown!.slice('P008_NATIVE_TEARDOWN '.length));
      expect(teardownReceipt).toMatchObject({ privatePgSockets: 0 });
      await writeFile(join(evidenceDir, 'native-teardown.json'), JSON.stringify(teardownReceipt));
      const stages = result.output.split('\n').filter(line => line.startsWith('[with-test-pg] cleanup '))
        .map(line => JSON.parse(line.slice('[with-test-pg] cleanup '.length)));
      const complete = stages.find(stage => stage.stage === 'complete');
      expect(complete).toMatchObject({ runtimeRemoved: true, pgDataRemoved: true });
      expect(existsSync(complete.runtimeRoot)).toBe(false);
      expect(existsSync(complete.dataDir)).toBe(false);
    },
  });
  // The reporter hashes this run's original lifecycle artifacts for the test ledger.
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, deadlines.testTimeoutMs);
