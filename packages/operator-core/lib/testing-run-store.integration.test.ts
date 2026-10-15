import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { getRunAsync, TestingRunSnapshotUnavailableError, persistHarnessTestRunsWithIds } from './testing-run-store';
import { executeOperationalRun } from './agent-tools/testing/record-run';
import { parseTestRunExecutionDetails, stableRecordedRuntimeEnvironment } from '@papercusp/test-config/execution-details';
import { configureRuntimeVintageStore, resetRuntimeVintageStore, InMemoryRuntimeVintageStore,
  reportRuntimeVintage, listRuntimeVintage, measureRuntimeVintageEnvironment } from './runtime-vintage';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('foreground evidence recovery (real PG)', () => {
  let db: OrgTestDb;
  // postgres.js `Sql` is not structurally assignable to the store's narrower tagged-template
  // `SqlLike` parameter (its call signature's values are `ParameterOrFragment`, not `unknown`),
  // so pass the real-PG client through the store's own declared parameter type.
  const storeSql = () => db.adminSql as unknown as NonNullable<Parameters<typeof getRunAsync>[1]>;
  const scope = { workspaceId: 'foreground-workspace', harnessSlug: 'foreground-harness', root: '/fixture' };
  const runId = 'foreground-origin';

  beforeAll(async () => { db = await createOrgTestDb(); }, 120_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => {
    await db.adminSql`DELETE FROM harness_shared.task_ledger`;
  });

  async function insertTask(input: {
    taskId?: string; state?: string; workspace?: string; harness?: string; root?: string;
    launchedBy?: string; foreground?: boolean;
  } = {}) {
    const taskId = input.taskId ?? 'foreground-task';
    await db.adminSql`
      INSERT INTO harness_shared.task_ledger (
        task_id, root_task_id, workspace_id, harness_slug, cwd, class, title, argv, launched_by, state, detail
      ) VALUES (
        ${taskId}, ${taskId}, ${input.workspace ?? scope.workspaceId}, ${input.harness ?? scope.harnessSlug},
        ${input.root ?? scope.root}, 'test-run', 'foreground test', ${db.adminSql.json(['node', 'scripts/test-files.mjs'])},
        ${input.launchedBy ?? `testing:run:${runId}`}, ${input.state ?? 'running'},
        ${db.adminSql.json({ runGroup: runId, foreground: input.foreground ?? true })}
      )
    `;
  }

  it.each(['pending', 'running'])('preserves a %s foreground task with no snapshot', async state => {
    await insertTask({ state });
    await expect(getRunAsync(runId, storeSql(), scope)).resolves.toMatchObject({
      runId, taskId: 'foreground-task', status: 'running', finishedAt: null, exitCode: null,
    });
  });

  it.each([
    { workspace: 'other-workspace' }, { harness: 'other-harness' }, { root: '/other-root' },
    { launchedBy: 'testing:run:other-origin' }, { foreground: false },
  ])('does not use a task outside the exact origin scope: %j', async input => {
    await insertTask(input);
    const positive = await db.adminSql`SELECT task_id FROM harness_shared.task_ledger WHERE task_id = 'foreground-task'`;
    expect(positive).toHaveLength(1);
    await expect(getRunAsync(runId, storeSql(), scope)).resolves.toBeNull();
  });

  it('keeps an ambiguous foreground identity unknown', async () => {
    await insertTask();
    await insertTask({ taskId: 'other-foreground-task' });
    await expect(getRunAsync(runId, storeSql(), scope)).rejects.toBeInstanceOf(TestingRunSnapshotUnavailableError);
  });

  it('does not use a stranded process as evidence that the whole task ended', async () => {
    await insertTask({ state: 'stranded' });
    await expect(getRunAsync(runId, storeSql(), scope)).rejects.toBeInstanceOf(TestingRunSnapshotUnavailableError);
  });

  it('does not turn an ended foreground task into a passing test', async () => {
    await insertTask({ state: 'ended_unobserved' });
    await expect(getRunAsync(runId, storeSql(), scope)).resolves.toBeNull();
  });
});

describe('native operational execution provenance (real PG and kernel)', () => {
  let db: OrgTestDb;
  const workspaceId = 'operational-workspace';
  beforeAll(async () => { db = await createOrgTestDb(); }, 120_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(() => configureRuntimeVintageStore(new InMemoryRuntimeVintageStore()));
  afterEach(() => resetRuntimeVintageStore());

  it.each([false, true])('persists actual runtime observations; source drift=%s remains distinguishable', async drift => {
    await reportRuntimeVintage({ workspaceId, unit: 'native-check-runtime',
      treeSha: 'a'.repeat(40), pid: process.pid });
    const result = await executeOperationalRun({
      filePath: 'lib/testing-run-store.integration.test.ts', name: 'measured operational check',
      command: ['executeGreenMainAdmissionWindow', workspaceId, 'original-install',
        '1791000000000', '1791604800000'], framework: 'operational',
      runtimeUnits: ['native-check-runtime'],
      run: async () => {
        if (drift) await reportRuntimeVintage({ workspaceId, unit: 'native-check-runtime',
          treeSha: 'b'.repeat(40), pid: process.pid });
        return { exitCode: 0, summary: 'Measured actual runtime.',
          assertions: [{ id: 'kernel-runtime-observed', passed: true, evidence: 'Current test process observed.' }] };
      },
    }, { workspaceId, harnessSlug: 'operational-harness', projectDir: process.cwd() }, {
      snapshot: () => ({ commit: 'a'.repeat(40), porcelain: '' }),
      verifyDefinition: async () => true,
      readRuntime: async (units, workspace) => measureRuntimeVintageEnvironment(await listRuntimeVintage(workspace), units),
      persist: params => persistHarnessTestRunsWithIds({ ...params,
        sql: db.adminSql as unknown as NonNullable<Parameters<typeof persistHarnessTestRunsWithIds>[0]['sql']> }),
    });
    expect(result.ok).toBe(true);
    const [row] = await db.adminSql`SELECT workspace_id, harness_slug, execution_details
      FROM harness_shared.test_runs WHERE id = ${result.testRunIds![0]}`;
    expect(row.workspace_id).toBe(workspaceId);
    expect(row.harness_slug).toBe('operational-harness');
    const execution = parseTestRunExecutionDetails(row.execution_details);
    expect(execution).toMatchObject({ passed: 1, failed: 0, worktreeDirty: false,
      operational: { schemaVersion: 1, command: ['executeGreenMainAdmissionWindow',
        workspaceId, 'original-install', '1791000000000', '1791604800000'] } });
    expect(execution?.runtimeEnvironmentBefore).toBeDefined();
    expect(execution?.runtimeEnvironmentAfter).toBeDefined();
    expect(Boolean(stableRecordedRuntimeEnvironment(execution?.runtimeEnvironmentBefore,
      execution?.runtimeEnvironmentAfter))).toBe(!drift);
    expect(execution).not.toHaveProperty('testLayer');
  });

  it('does not publish native evidence when its cited definition is absent at the source commit', async () => {
    let executed = false;
    const result = await executeOperationalRun({
      filePath: 'docs/evidence/future-output.json', name: 'uncommitted output is not a definition',
      command: ['native', 'future-output'], framework: 'operational',
      runtimeUnits: ['native-check-runtime'],
      run: async () => {
        executed = true;
        return { exitCode: 0, summary: 'Should not run.',
          assertions: [{ id: 'unexpected', passed: true, evidence: 'Unexpected' }] };
      },
    }, { workspaceId, harnessSlug: 'operational-harness', projectDir: process.cwd() }, {
      snapshot: () => ({ commit: 'a'.repeat(40), porcelain: '' }),
      verifyDefinition: async () => false,
      readRuntime: async () => 'b'.repeat(64),
      persist: params => persistHarnessTestRunsWithIds({ ...params,
        sql: db.adminSql as unknown as NonNullable<Parameters<typeof persistHarnessTestRunsWithIds>[0]['sql']> }),
    });
    expect(result).toMatchObject({ ok: false, error: 'operational_check_definition_unavailable' });
    expect(executed).toBe(false);
    const rows = await db.adminSql`SELECT id FROM harness_shared.test_runs
      WHERE workspace_id = ${workspaceId} AND file_path = 'docs/evidence/future-output.json'`;
    expect(rows).toHaveLength(0);
  });
});
