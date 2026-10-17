/**
 * P-006 runtime acceptance: the production scheduled workflow, dispatched by
 * name through a real DBOS executor, must remove measured compaction debt.
 * Reuse the preloaded BM25 fixture and DBOS lifecycle used by the hive suite.
 * The scheduler registrations are inspected, then parked in this test process
 * so unrelated periodic work cannot fire while explicit enqueues are tested.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import type { DBOS as DBOSType, DBOSClient as DBOSClientType } from '@dbos-inc/dbos-sdk';
import { seedBm25Corpus, startBm25TestDb, type Bm25TestDb } from '../search/lexical/test-pg/bm25-test-db';
import { captureIsolatedWorker, isolatedTestFileWorkerOptions, recordIsolatedIntegrationProof }
  from '../../test/isolated-integration-proof';
import type { Bm25MaintenanceStepResult } from './bm25-maintenance-step';

const root = resolve(import.meta.dirname, '../../../..');
const filePath = 'packages/operator-core/lib/dbos/bm25-maintenance-runtime.integration.test.ts';
// The maintained runner preserves reporter group identity across its private
// environment. A distinct child group selects the original runtime assertions
// without recursively starting another observer.
const workerGroupSuffix = ':bm25-maintenance-runtime-worker';
const isWorker = process.env.PAPERCUSP_TEST_RUN_GROUP?.endsWith(workerGroupSuffix);

if (isWorker) {

const QUEUE = 'bm25-maintenance-runtime-test';
const INDEX = 'harness_shared.runtime_compaction_probe_bm25';
let db: Bm25TestDb;
let DBOS: typeof DBOSType;
let client: DBOSClientType;
let resetOrgPg: typeof import('@papercusp/db-org')._resetForTests;
const parkedSchedules: Array<{ config: { crontab: string }; original: string }> = [];

beforeAll(async () => {
  db = await startBm25TestDb();
  await seedBm25Corpus(db.sql);
  const dsn = `postgresql://postgres@${db.connection.host}:${db.connection.port}/${db.runTag}`;
  vi.stubEnv('HARNESS_DATABASE_URL', dsn);
  vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', dsn);
  vi.stubEnv('DATABASE_URL', dsn);
  vi.stubEnv('PAPERCUSP_SKIP_PG_DISCOVERY', '1');
  vi.stubEnv('PAPERCUSP_PGBOUNCER', '0');
  ({ _resetForTests: resetOrgPg } = await import('@papercusp/db-org'));
  await resetOrgPg();

  const sdk = await import('@dbos-inc/dbos-sdk');
  DBOS = sdk.DBOS;
  new sdk.WorkflowQueue(QUEUE, { concurrency: 1 });
  DBOS.setConfig({
    name: 'bm25-maintenance-runtime-test',
    systemDatabaseUrl: dsn,
    systemDatabaseSchemaName: 'dbos',
    applicationVersion: db.runTag,
    runAdminServer: false,
    listenQueues: [QUEUE],
  });
  await import('./periodic-workflows');
  const schedules = DBOS.getAssociatedInfo('dbos.scheduler');
  const maintenance = schedules.find(r => r.methodReg.name === 'bm25Maintenance');
  expect(maintenance, 'production BM25 scheduled registration is missing').toBeDefined();
  expect(maintenance!.methodConfig).toMatchObject({ crontab: '30 */15 * * * *' });
  for (const registration of schedules) {
    const config = registration.methodConfig as { crontab: string };
    parkedSchedules.push({ config, original: config.crontab });
    config.crontab = '0 0 0 1 1 *';
  }
  await DBOS.launch();
  client = await sdk.DBOSClient.create({ systemDatabaseUrl: dsn, systemDatabaseSchemaName: 'dbos' });

  await db.sql.unsafe(`
    CREATE TABLE harness_shared.runtime_compaction_probe (id serial PRIMARY KEY, body text);
    CREATE INDEX runtime_compaction_probe_bm25 ON harness_shared.runtime_compaction_probe USING bm25 (body)
      WITH (text_config = 'english', compaction = 'manual');`);
}, 600_000);

afterAll(async () => {
  try {
    await client?.destroy();
    if (DBOS) await DBOS.shutdown();
  } finally {
    for (const { config, original } of parkedSchedules) config.crontab = original;
    try {
      await resetOrgPg?.();
      if (db) {
        await db.close();
        const admin = postgres({ ...db.connection, user: 'postgres', database: 'postgres', max: 1 });
        try {
          const rows = await admin`SELECT datname FROM pg_database WHERE datname = ${db.runTag}`;
          expect(rows, 'private runtime database survived teardown').toEqual([]);
        } finally {
          await admin.end({ timeout: 5 });
        }
      }
    } finally {
      vi.unstubAllEnvs();
    }
  }
}, 120_000);

async function makeDebt(words: string[]): Promise<void> {
  for (const word of words) {
    await db.sql`INSERT INTO harness_shared.runtime_compaction_probe (body)
      SELECT ${word} || ' wading bird ' || g FROM generate_series(1, 40) g`;
    await db.sql`SELECT public.bm25_spill_index(${INDEX})`;
  }
}

async function needsCompaction(): Promise<boolean> {
  const [row] = await db.sql<{ needs: boolean }[]>`
    SELECT public.bm25_needs_compaction(${INDEX}::regclass) AS needs`;
  return row!.needs;
}

async function enqueue(workflowID: string): Promise<Bm25MaintenanceStepResult> {
  const handle = await client.enqueue({ queueName: QUEUE, workflowName: 'bm25Maintenance', workflowID });
  const result = await DBOS.getResult<Bm25MaintenanceStepResult>(workflowID, { timeoutSeconds: 120 });
  expect(result).toBeDefined();
  expect(result).toMatchObject({
    outcome: expect.stringMatching(/^(no-op|completed|completed-with-errors)$/),
    noOp: expect.any(Boolean),
    startedAtMs: expect.any(Number),
    finishedAtMs: expect.any(Number),
    durationMs: expect.any(Number),
    report: expect.objectContaining({ ensure: expect.any(Array), errors: expect.any(Array) }),
    error: null,
  });
  expect(result).toHaveProperty('loadedSourceSha');
  expect(result!.durationMs).toBe(Math.max(0, result!.finishedAtMs - result!.startedAtMs));
  expect(await handle.getStatus()).toMatchObject({
    workflowID, workflowName: 'bm25Maintenance', status: 'SUCCESS', queueName: QUEUE,
    applicationVersion: db.runTag,
  });
  return result!;
}

describe('BM25 maintenance through the real registered DBOS runtime (P-006)', () => {
  it('persists the maintenance step, removes real debt, replays once, and handles the next run', async () => {
    await makeDebt(['heron', 'egret', 'ibis']);
    expect(await needsCompaction(), 'fixture must have actual compaction debt before enqueue').toBe(true);
    // The production wrapper must bypass transaction pooling even when the
    // host enables it. Existing DBOS/test connections stay on the private DB;
    // a newly pooled maintenance client would select the unavailable proxy.
    vi.stubEnv('PAPERCUSP_PGBOUNCER', '1');
    vi.stubEnv('PAPERCUSP_PGBOUNCER_PORT', '1');
    const workflowID = `bm25-runtime-${db.runTag}`;
    const result = await enqueue(workflowID);
    const steps = await DBOS.listWorkflowSteps(workflowID);
    expect(steps).toHaveLength(1);
    expect(steps![0]).toMatchObject({ name: 'bm25-maintenance', error: null });
    expect(steps![0]!.output).toEqual(result);
    expect(result.noOp).toBe(false);
    expect(result.report).not.toBeNull();
    expect(await needsCompaction()).toBe(false);

    // The oracle reads every valid BM25 index in this private database, not
    // merely the workflow's SUCCESS status (the production tick is fail-soft).
    const indexes = await db.sql<{ index: string; needs: boolean }[]>`
      SELECT c.oid::regclass::text AS index, public.bm25_needs_compaction(c.oid) AS needs
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am am ON am.oid = c.relam
       WHERE am.amname = 'bm25' AND i.indisvalid ORDER BY c.oid`;
    expect(indexes.map(r => r.index)).toContain(INDEX);
    expect(indexes.length).toBeGreaterThan(1);
    expect(indexes.filter(r => r.needs)).toEqual([]);
    const [matches] = await db.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM harness_shared.runtime_compaction_probe WHERE body <@> 'egret' < 0`;
    expect(matches!.count).toBe(40);

    await makeDebt(['avocet', 'stilt']);
    expect(await needsCompaction()).toBe(true);
    await enqueue(workflowID);
    expect(await DBOS.listWorkflowSteps(workflowID)).toEqual(steps);
    expect(await needsCompaction(), 'a duplicate workflow ID must not execute maintenance again').toBe(true);
    const rows = await db.sql`SELECT workflow_uuid FROM dbos.workflow_status WHERE workflow_uuid = ${workflowID}`;
    expect(rows).toHaveLength(1);
    await enqueue(`${workflowID}-next`);
    expect(await needsCompaction()).toBe(false);
  }, 300_000);
});
} else {
  const workerOptions = isolatedTestFileWorkerOptions(process.env, 1);
  it('retains the real DBOS maintenance execution and its isolated cleanup witness (P-006)', async context => {
    const runId = await recordIsolatedIntegrationProof({
      root, filePath,
      sourcePaths: [
        'packages/operator-core/lib/dbos/periodic-workflows.ts',
        'packages/operator-core/lib/dbos/bm25-maintenance-step.ts',
        'packages/operator-core/lib/search/lexical/bm25-maintenance.ts',
        'packages/operator-core/lib/search/lexical/rank.ts',
        'packages/operator-core/lib/search/lexical/test-pg/bm25-test-db.ts',
        'packages/operator-core/lib/search/lexical/test-pg/Dockerfile',
        'libs/papercusp/libs/db/src/connection.ts',
        'libs/papercusp/libs/db/sql/1447-bm25-pg-textsearch-indexes.sql',
        'packages/operator-core/test/isolated-integration-proof.ts',
        'packages/operator-core/lib/process-identity.ts',
        'scripts/with-test-pg.mjs',
        'scripts/test-files.mjs',
      ],
      execute: async (observe, evidenceDir) => {
        const env: NodeJS.ProcessEnv = { ...process.env,
          PC_ISOLATED_RUNTIME_PROOF: '1',
          PAPERCUSP_TEST_RUN_GROUP: (process.env.PAPERCUSP_TEST_RUN_GROUP ?? '') + workerGroupSuffix,
        };
        // Only this outer test owns the retained ledger row and source capture.
        // The nested suite records into its private database, which is removed
        // only after the original worker's exit has been observed.
        for (const key of ['PC_EXECUTED_SOURCE_MAP_OUT', 'PC_EXECUTED_SOURCE_MAP_RESULT',
          'PC_EXECUTED_SOURCE_MAP_WORKSPACE', 'PAPERCUSP_TEST_RUN_RECEIPT_FILE',
          'PAPERCUSP_TEST_RUNS_DB_URL']) delete env[key];
        delete env.PC_HEAVY_PREEMPT_READY_FILE;
        delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), [
          '--isolated-runtime', '--', process.execPath,
          '--import', './scripts/lib/committed-source-loader.mjs', 'scripts/test-files.mjs', filePath,
        ], { cwd: root, detached: true, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        const result = await captureIsolatedWorker(child, evidenceDir, workerOptions);
        expect(result, result.output.slice(-8000)).toMatchObject({
          code: 0, signal: null, timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false,
        });
        expect(result.output).toContain('TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed');
        expect(result.output).toContain('skippedTests=0');
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ISOLATED_BM25_MAINTENANCE_PROOF_RUN ' + runId);
  }, workerOptions.testTimeoutMs);
}
