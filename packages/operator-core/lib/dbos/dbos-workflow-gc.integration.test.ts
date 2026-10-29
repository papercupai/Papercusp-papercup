/** P-001: actual SQL safety/order/resume and the registered DBOS job on private PG. */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { DBOS as DBOSType, DBOSClient as DBOSClientType } from '@dbos-inc/dbos-sdk';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { captureIsolatedWorker, isolatedTestFileWorkerOptions, isolatedWorkerFailureDetail, recordIsolatedIntegrationProof }
  from '../../test/isolated-integration-proof';
import { DBOS_TERMINAL_STATUSES, DBOS_WORKFLOW_GC_CRONTAB, dbosWorkflowGcSqlDeps,
  DBOS_HISTORY_CEILING_CONDITION_KEY, runDbosWorkflowGcOnce, type DbosWorkflowGcResult } from './dbos-workflow-gc';

const root = resolve(import.meta.dirname, '../../../..');
const filePath = 'packages/operator-core/lib/dbos/dbos-workflow-gc.integration.test.ts';
const workerSuffix = ':dbos-workflow-gc-worker';
const isWorker = process.env.PAPERCUSP_TEST_RUN_GROUP?.endsWith(workerSuffix);

// Enabled GC must keep its hourly repair cadence even when heavy ticks would shed.
vi.mock('./tick-load-shed', () => ({ shouldShedHeavyTick: () => true }));

if (isWorker) {
  let org: OrgTestDb;
  let sql: Sql;
  let DBOS: typeof DBOSType;
  let client: DBOSClientType;
  let resetOrgPg: typeof import('@papercusp/db-org')._resetForTests;
  const schedules: Array<{ config: { crontab: string }; original: string }> = [];
  const nowMs = 1_800_000_000_000;
  const cutoff = nowMs - 2 * 86_400_000;
  let registeredCron: string;
  let dbosStopped = false;

  beforeAll(async () => {
    org = await createOrgTestDb();
    sql = org.adminSql;
    for (const key of ['HARNESS_DATABASE_URL', 'HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL']) vi.stubEnv(key, org.adminDsn);
    vi.stubEnv('PAPERCUSP_SKIP_PG_DISCOVERY', '1');
    vi.stubEnv('PAPERCUSP_PGBOUNCER', '0');
    vi.stubEnv('PAPERCUSP_DBOS_WORKFLOW_GC', '1');
    vi.stubEnv('PAPERCUSP_DBOS_WORKFLOW_HISTORY_CEILING', '300000');
    ({ _resetForTests: resetOrgPg } = await import('@papercusp/db-org'));
    await resetOrgPg();
    const sdk = await import('@dbos-inc/dbos-sdk');
    DBOS = sdk.DBOS;
    new sdk.WorkflowQueue('gc-runtime-test', { concurrency: 1 });
    DBOS.setConfig({ name: 'gc-runtime-test', systemDatabaseUrl: org.adminDsn,
      systemDatabaseSchemaName: 'dbos', applicationVersion: org.dbName,
      runAdminServer: false, listenQueues: ['gc-runtime-test'] });
    await import('./periodic-workflows');
    const registered = DBOS.getAssociatedInfo('dbos.scheduler');
    registeredCron = (registered.find(r => r.methodReg.name === 'dbosWorkflowGc')!.methodConfig as { crontab: string }).crontab;
    for (const r of registered) {
      const config = r.methodConfig as { crontab: string };
      schedules.push({ config, original: config.crontab });
      config.crontab = '0 0 0 1 1 *';
    }
    await DBOS.launch();
    client = await sdk.DBOSClient.create({ systemDatabaseUrl: org.adminDsn, systemDatabaseSchemaName: 'dbos' });
  }, 600_000);

  afterAll(async () => {
    try {
      if (!dbosStopped) {
        await client?.destroy();
        if (DBOS) await DBOS.shutdown();
      }
    } finally {
      for (const r of schedules) r.config.crontab = r.original;
      await resetOrgPg?.();
      if (org) expect(await org.cleanupWithResult()).toBe('dropped');
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  }, 120_000);
  beforeEach(async () => {
    await sql`DELETE FROM dbos.workflow_status WHERE workflow_uuid LIKE 'gc-fixture-%'`;
  });

  function deps() { return dbosWorkflowGcSqlDeps(sql as unknown as Parameters<typeof dbosWorkflowGcSqlDeps>[0]); }
  async function seed(id: string, status: string, created: number, updated: number) {
    await sql`INSERT INTO dbos.workflow_status (workflow_uuid, name, status, created_at, updated_at)
      VALUES (${id}, 'gc-fixture', ${status}, ${created}, ${updated})`;
    await sql`INSERT INTO dbos.operation_outputs (workflow_uuid, function_id, output) VALUES (${id}, 0, 'null')`;
  }
  async function remaining() {
    return (await sql<{ id: string; output: string }[]>`
      SELECT w.workflow_uuid AS id, o.output FROM dbos.workflow_status w
      JOIN dbos.operation_outputs o USING (workflow_uuid)
      WHERE w.workflow_uuid LIKE 'gc-fixture-%' ORDER BY w.workflow_uuid`).map(r => r.id);
  }

  it('orders by creation with uuid ties, preserves recovery data, and resumes after a committed budget-limited batch', async () => {
    const victims = ['gc-fixture-tie-a', 'gc-fixture-tie-z', 'gc-fixture-newer-old-update', 'gc-fixture-newest'];
    const created = [100, 100, 200, 300];
    const updated = [cutoff - 1, cutoff - 2, cutoff - 1000, cutoff - 3];
    for (let i = 3; i >= 0; i--) await seed(victims[i]!, DBOS_TERMINAL_STATUSES[i]!, created[i]!, updated[i]!);
    const preserved = ['gc-fixture-boundary', 'gc-fixture-enqueued', 'gc-fixture-fresh', 'gc-fixture-pending'];
    await seed(preserved[0]!, 'SUCCESS', 0, cutoff);
    await seed(preserved[1]!, 'ENQUEUED', 0, cutoff - 1000);
    await seed(preserved[2]!, 'ERROR', 0, cutoff + 1);
    await seed(preserved[3]!, 'PENDING', 0, cutoff - 1000);
    let clock = 0;
    const real = deps();
    const first = await runDbosWorkflowGcOnce({ enabled: true, nowMs, batchLimit: 2,
      timeBudgetMs: 25, nowClockMs: () => clock,
      deps: { ...real, deleteWorkflows: async ids => {
        expect(ids).toEqual(victims.slice(0, 2));
        const count = await real.deleteWorkflows(ids); clock = 25; return count;
      } } });
    expect(first).toMatchObject({ deletedWorkflows: 2, deletedOutputs: 2, batches: 1, budgetExhausted: true });
    expect(await remaining()).toEqual([...preserved, ...victims.slice(2)].sort());
    const resumed = await runDbosWorkflowGcOnce({ enabled: true, nowMs, batchLimit: 1, deps: real });
    expect(resumed).toMatchObject({ deletedWorkflows: 2, deletedOutputs: 2, budgetExhausted: false });
    expect(await remaining()).toEqual(preserved);
  });

  it('retains selected SQL rows and outputs when selection uses the remaining budget', async () => {
    await seed('gc-fixture-selected', 'SUCCESS', 1, cutoff - 1);
    let clock = 0;
    const real = deps();
    const first = await runDbosWorkflowGcOnce({ enabled: true, nowMs, timeBudgetMs: 10,
      nowClockMs: () => clock, deps: { ...real, selectTerminalVictims: async (...args) => {
        const ids = await real.selectTerminalVictims(...args); clock = 10; return ids;
      } } });
    expect(first).toMatchObject({ batches: 0, deletedWorkflows: 0, budgetExhausted: true });
    expect(await remaining()).toEqual(['gc-fixture-selected']);
    expect(await runDbosWorkflowGcOnce({ enabled: true, nowMs, deps: real })).toMatchObject({ deletedWorkflows: 1, deletedOutputs: 1 });
    expect(await remaining()).toEqual([]);
  });

  it('runs the actual hourly registered workflow and persists both deletion and zero-work pass results', async () => {
    expect(registeredCron).toBe(DBOS_WORKFLOW_GC_CRONTAB);
    const old = Date.now() - 3 * 86_400_000;
    await seed('gc-fixture-runtime', 'SUCCESS', old, old);
    await seed('gc-fixture-runtime-pending', 'PENDING', old, old);
    for (const [suffix, deleted] of [['work', 1], ['empty', 0]] as const) {
      const workflowID = `gc-pass-${org.dbName}-${suffix}`;
      const handle = await client.enqueue({ queueName: 'gc-runtime-test', workflowName: 'dbosWorkflowGc', workflowID });
      const result = await DBOS.getResult<DbosWorkflowGcResult>(workflowID, { timeoutSeconds: 60 });
      expect(result).toMatchObject({ skipped: false, deletedWorkflows: deleted, deletedOutputs: deleted,
        budgetExhausted: false, durationMs: expect.any(Number) });
      expect(await handle.getStatus()).toMatchObject({ status: 'SUCCESS', applicationVersion: org.dbName });
      const steps = await DBOS.listWorkflowSteps(workflowID);
      expect(steps).toHaveLength(1);
      expect(steps![0]).toMatchObject({ name: 'dbos-workflow-gc', error: null, output: result });
      expect(await remaining()).toEqual(['gc-fixture-runtime-pending']);
    }
  }, 180_000);

  it('raises the actual ceiling-alarm receipt above 300000 rows with DBOS stopped', async () => {
    await client.destroy();
    await DBOS.shutdown();
    dbosStopped = true;
    const runStep = vi.spyOn(DBOS, 'runStep').mockImplementation(() => { throw new Error('DBOS unavailable'); });
    const startWorkflow = vi.spyOn(DBOS, 'startWorkflow').mockImplementation(() => { throw new Error('DBOS unavailable'); });
    // This database belongs solely to this test worker. Remove its earlier
    // workflow fixtures before constructing exact physical-table count boundaries.
    await sql`TRUNCATE dbos.workflow_status CASCADE`;
    await sql`INSERT INTO dbos.workflow_status (workflow_uuid, name, status)
      SELECT 'history-alarm-' || n, 'history-alarm-fixture', 'SUCCESS' FROM generate_series(1, 299999) n`;
    const { buildDefaultChecks, runPeriodicCheck } = await import('./in-process-periodic');
    const check = buildDefaultChecks().find(c => c.name === 'dbos-history-ceiling')!;
    const receipts = () => sql<{ importance: string; data: Record<string, unknown> }[]>`
      SELECT importance, data FROM harness_shared.attention_notifications
      WHERE data->>'conditionKey' = ${DBOS_HISTORY_CEILING_CONDITION_KEY}`;
    for (const count of [299_999, 300_000]) {
      if (count === 300_000) await seed('history-alarm-300000', 'SUCCESS', Date.now(), Date.now());
      expect(await runPeriodicCheck(check, { shouldShed: () => true })).toEqual({ ran: true });
      expect(await receipts()).toEqual([]);
    }
    await seed('history-alarm-300001', 'SUCCESS', Date.now(), Date.now());
    const crossedAt = Date.now();
    expect(await runPeriodicCheck(check, { shouldShed: () => true })).toEqual({ ran: true });
    expect(Date.now() - crossedAt).toBeLessThanOrEqual(60_000);
    expect(await receipts()).toEqual([expect.objectContaining({ importance: 'urgent', data: expect.objectContaining({
      rowCount: 300_001, ceilingRows: 300_000, conditionKey: DBOS_HISTORY_CEILING_CONDITION_KEY,
    }) })]);
    expect(runStep).not.toHaveBeenCalled();
    expect(startWorkflow).not.toHaveBeenCalled();
  }, 180_000);
} else {
  const options = isolatedTestFileWorkerOptions(process.env, 1);
  it('retains the registered GC runtime effect and disposable-database cleanup witness', async context => {
    const runId = await recordIsolatedIntegrationProof({ root, filePath,
      sourcePaths: [filePath, 'packages/operator-core/lib/dbos/dbos-workflow-gc.ts',
        'packages/operator-core/lib/dbos/in-process-periodic.ts', 'packages/operator-core/lib/alarm-attention.ts',
        'packages/operator-core/lib/dbos/periodic-workflows.ts', 'packages/operator-core/test/_org-test-db.ts',
        'packages/operator-core/test/isolated-integration-proof.ts'],
      execute: async (observe, evidenceDir) => {
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
          PAPERCUSP_TEST_RUN_GROUP: (process.env.PAPERCUSP_TEST_RUN_GROUP ?? '') + workerSuffix };
        for (const key of ['PC_EXECUTED_SOURCE_MAP_OUT', 'PC_EXECUTED_SOURCE_MAP_RESULT',
          'PC_EXECUTED_SOURCE_MAP_WORKSPACE', 'PAPERCUSP_TEST_RUN_RECEIPT_FILE', 'PAPERCUSP_TEST_RUNS_DB_URL',
          'PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE']) delete env[key];
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime', '--', process.execPath,
          '--import', './scripts/lib/committed-source-loader.mjs', 'scripts/test-files.mjs', filePath],
        { cwd: root, detached: true, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        const result = await captureIsolatedWorker(child, evidenceDir, options);
        expect(result, isolatedWorkerFailureDetail(result.output, result)).toMatchObject({ code: 0, signal: null, timedOut: false,
          exitWaitTimedOut: false, stdioDrainTimedOut: false });
        expect(result.output).toContain('TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed');
        expect(result.output).toContain('skippedTests=0');
      } });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ISOLATED_DBOS_GC_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);
}
