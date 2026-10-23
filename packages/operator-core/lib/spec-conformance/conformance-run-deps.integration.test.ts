import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION } from '@papercusp/test-config/execution-details';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { judgeTestsFromLedger, productionConformanceDeps } from './conformance-run-deps';
import * as ledger from '../check-results-ledger';
import { evaluateCriterionProbeChecks } from '../rubrics-criterion-checks';
import { currentRequestWorkspaceId, runWithWorkspace } from '../workspace-als';
import { dispatchPaletteTarget } from '../capabilities/invoke';

describe('conformance test-ledger evidence population', () => {
  let db: FreshPgDb;
  const file = 'lib/guard.test.ts';
  const input = {
    files: [file],
    workspaceId: 'conformance-workspace',
    currentBuildSha: 'a'.repeat(40),
    now: () => new Date(Date.UTC(2026, 9, 15, 0, 10)),
  };

  beforeAll(async () => {
    db = await createFreshPgDb('conformance-test-sources');
    await db.sql`CREATE TABLE harness_shared.test_runs (
      id bigserial PRIMARY KEY, file_path text NOT NULL, workspace_id text,
      framework text, source text, status text NOT NULL, finished_at timestamptz,
      commit_sha text, worktree_dirty boolean, execution_details jsonb
    )`;
  }, 120_000);
  afterAll(async () => { await db?.cleanup(); });
  beforeEach(async () => { await db.sql`TRUNCATE harness_shared.test_runs`; });

  async function record(
    source: string | null,
    status: string,
    minute: number,
    workspace: string | null = input.workspaceId,
    options: {
      testNamePattern?: string | null;
      worktreeDirty?: boolean;
      commitSha?: string | null;
      skipped?: number;
      passed?: number;
      failed?: number;
      includeDetails?: boolean;
    } = {},
  ) {
    const finishedAt = new Date(Date.UTC(2026, 9, 15, 0, minute));
    const commitSha = options.commitSha === undefined ? 'a'.repeat(40) : options.commitSha;
    const worktreeDirty = options.worktreeDirty ?? false;
    const executionDetails = options.includeDetails === false ? null : {
      schemaVersion: TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
      root: '/repo',
      filePath: file,
      runGroupId: 'conformance-run',
      workspaceId: workspace,
      harnessSlug: 'papercusp',
      testNamePattern: options.testNamePattern ?? null,
      passed: options.passed ?? (status === 'pass' ? 1 : 0),
      failed: options.failed ?? (status === 'fail' ? 1 : 0),
      skipped: options.skipped ?? 0,
      collectionFailed: false,
      mutationPhase: null,
      commitSha,
      worktreeDirty,
    };
    await db.sql`INSERT INTO harness_shared.test_runs
      (file_path, workspace_id, framework, source, status, finished_at, commit_sha, worktree_dirty, execution_details)
      VALUES (${file}, ${workspace}, 'vitest', ${source}, ${status}, ${finishedAt}, ${commitSha}, ${worktreeDirty},
        ${executionDetails === null ? null : db.sql.json(executionDetails as never)})`;
  }

  const r1CasePrefix = 'source-preview export — R-1 selection parity with the installer cut > ';
  const r1CaseNames = [
    'ships every selected tracked file, including the submodule contents',
    'drops every excluded class, node_modules at any depth, and all git metadata',
    'retains the exact eligible bytes from both internal documentation roots',
    'equals the installer selection over the same clean commit, minus node_modules',
  ];

  it('keeps a production pass after a newer intentional mutant failure', async () => {
    await record('local', 'pass', 1);
    await record('mutation-probe', 'fail', 2);
    expect(await judgeTestsFromLedger(input, db.sql)).toMatchObject({ verdict: 'pass', value: 1 });
  });

  it('does not let a passing mutation control hide a production failure', async () => {
    await record('local', 'fail', 1);
    await record('mutation-probe', 'pass', 2);
    expect(await judgeTestsFromLedger(input, db.sql)).toMatchObject({ verdict: 'fail', value: 0 });
  });

  it.each(['pass', 'fail'])('keeps current-build evidence after a newer foreign-build %s', async status => {
    await record('local', 'pass', 1);
    await record('local', status, 2, input.workspaceId, { commitSha: 'b'.repeat(40) });
    expect(await judgeTestsFromLedger(input, db.sql)).toMatchObject({ verdict: 'pass', value: 1 });
  });

  it('keeps a current-build failure after a newer foreign-build pass', async () => {
    await record('local', 'fail', 1);
    await record('local', 'pass', 2, input.workspaceId, { commitSha: 'b'.repeat(40) });
    expect(await judgeTestsFromLedger(input, db.sql)).toMatchObject({ verdict: 'fail', value: 0 });
  });

  it('keeps a clean current-build pass after a newer dirty passing run', async () => {
    await record('local', 'pass', 1);
    await record('local', 'pass', 2, input.workspaceId, { worktreeDirty: true });
    expect(await judgeTestsFromLedger(input, db.sql)).toMatchObject({ verdict: 'pass', value: 1 });
  });

  it('does not let a dirty pass hide a newer clean current-build failure', async () => {
    await record('local', 'pass', 1);
    await record('local', 'fail', 2);
    await record('local', 'pass', 3, input.workspaceId, { worktreeDirty: true });
    expect(await judgeTestsFromLedger(input, db.sql)).toMatchObject({ verdict: 'fail', value: 0 });
  });

  it('keeps dirty-only passing evidence unjudgeable', async () => {
    await record('local', 'pass', 1, input.workspaceId, { worktreeDirty: true });
    expect(await judgeTestsFromLedger(input, db.sql)).toMatchObject({
      verdict: 'error', value: null, detail: expect.stringContaining('worktree was not proven clean'),
    });
  });

  it('still refuses foreign-build evidence when no matching run exists', async () => {
    await record('local', 'pass', 1, input.workspaceId, { commitSha: 'b'.repeat(40) });
    expect(await judgeTestsFromLedger(input, db.sql)).toMatchObject({
      verdict: 'error', detail: expect.stringContaining('does not match current build'),
    });
  });

  it('matches short build identities without ignoring a newer unpinned error', async () => {
    await record('local', 'pass', 1);
    await record('local', 'fail', 2, input.workspaceId, { commitSha: 'b'.repeat(40) });
    expect(await judgeTestsFromLedger({ ...input, currentBuildSha: 'aaaaaaa' }, db.sql))
      .toMatchObject({ verdict: 'pass', value: 1 });
    await record('local', 'error', 3, input.workspaceId, { commitSha: null });
    expect(await judgeTestsFromLedger({ ...input, currentBuildSha: 'aaaaaaa' }, db.sql))
      .toMatchObject({ verdict: 'error', detail: expect.stringContaining('test run status is error') });
  });

  it('rejects a newer name-filtered pass instead of falling back to an older full-file run', async () => {
    await record('local', 'pass', 1);
    await record('local', 'pass', 2, input.workspaceId, {
      testNamePattern: 'delivers no-claim declare/orient scope',
      skipped: 10,
    });
    expect(await judgeTestsFromLedger(input, db.sql)).toMatchObject({
      verdict: 'error',
      value: null,
      detail: expect.stringContaining('name-filtered test run'),
    });
  });

  it('judges a named case independently from unrelated failures in the same file', async () => {
    await record('ci', 'fail', 3, input.workspaceId, { passed: 217, failed: 2 });
    const caseLoader = async ({ testRunIds, file: selectedFile }: { testRunIds: readonly number[]; file: string }) => {
      expect(selectedFile).toBe(file);
      expect(testRunIds).toHaveLength(1);
      return r1CaseNames.map((testName) => ({
        caseKey: r1CasePrefix + testName,
        occurrence: 1,
        status: 'pass' as const,
        durationMs: 1,
      }));
    };
    const result = await judgeTestsFromLedger({
      ...input,
      cases: r1CaseNames.map((testName) => ({ file, testName })),
      caseLoader,
    }, db.sql);
    expect(result).toMatchObject({ verdict: 'pass', value: 4, unit: 'cases' });
  });

  it('fails when one named case fails even if its selected siblings pass', async () => {
    await record('ci', 'fail', 4, input.workspaceId, { passed: 216, failed: 3 });
    const result = await judgeTestsFromLedger({
      ...input,
      cases: r1CaseNames.map((testName) => ({ file, testName })),
      caseLoader: async () => r1CaseNames.map((testName, index) => ({
        caseKey: r1CasePrefix + testName,
        occurrence: 1,
        status: index === 2 ? 'fail' as const : 'pass' as const,
        durationMs: 1,
      })),
    }, db.sql);
    expect(result).toMatchObject({ verdict: 'fail', value: 3, unit: 'cases' });
    expect(result.detail).toContain(r1CaseNames[2]);
  });

  it('keeps dirty-worktree evidence unjudgeable for a named case', async () => {
    await record('local', 'pass', 3, input.workspaceId, {
      testNamePattern: 'equals the installer selection over the same clean commit, minus node_modules',
      worktreeDirty: true,
      passed: 1,
      skipped: 220,
    });
    const result = await judgeTestsFromLedger({
      ...input,
      cases: [{
        file,
        testName: 'equals the installer selection over the same clean commit, minus node_modules',
      }],
      caseLoader: async () => [{
        caseKey: r1CasePrefix + 'equals the installer selection over the same clean commit, minus node_modules',
        occurrence: 1,
        status: 'pass',
        durationMs: 1,
      }],
    }, db.sql);
    expect(result).toMatchObject({
      verdict: 'error',
      value: null,
      detail: expect.stringContaining('worktree was not proven clean'),
    });
  });

  it('rejects a passing row whose worktree was dirty during the run', async () => {
    await record('local', 'pass', 1, input.workspaceId, { worktreeDirty: true });
    expect(await judgeTestsFromLedger(input, db.sql)).toMatchObject({
      verdict: 'error',
      detail: expect.stringContaining('worktree was not proven clean'),
    });
  });

  it('rejects a passing row without a pinned commit SHA', async () => {
    await record('local', 'pass', 1, input.workspaceId, { commitSha: null });
    expect(await judgeTestsFromLedger(input, db.sql)).toMatchObject({
      verdict: 'error',
      detail: expect.stringContaining('commit SHA is absent or inconsistent'),
    });
  });

  it('reports missing production evidence when only mutation evidence exists', async () => {
    await record('mutation-probe', 'pass', 1);
    expect(await judgeTestsFromLedger(input, db.sql)).toMatchObject({ verdict: 'error', detail: expect.stringContaining('no test-run ledger row') });
  });

  it.each(['local', 'ci', 'admin-ui', null])('retains genuine failures from source %s, including legacy rows', async source => {
    await record(source, 'pass', 1);
    await record(source, 'fail', 2, input.workspaceId, { includeDetails: false });
    expect(await judgeTestsFromLedger(input, db.sql)).toMatchObject({ verdict: 'fail', value: 0 });
  });

  it('keeps workspace isolation and permits workspace-neutral CI evidence', async () => {
    await record('ci', 'pass', 1, null);
    await record('local', 'fail', 2, 'another-workspace');
    expect(await judgeTestsFromLedger(input, db.sql)).toMatchObject({ verdict: 'pass', value: 1 });
  });

  it('reports stale evidence as unknown instead of a current regression', async () => {
    await record('local', 'fail', 1);
    const result = await judgeTestsFromLedger({
      ...input,
      now: () => new Date(Date.UTC(2026, 9, 23, 0, 0)),
    }, db.sql);
    expect(result).toMatchObject({ verdict: 'error', value: null, unit: 'files' });
    expect(result.detail).toContain('stale');
    expect(result.detail).toContain('test_runs #');
  });

  it('forwards canonical workspace and harness into executable platform checks', async () => {
    const run = vi.spyOn(ledger, 'runInstrumentChecks').mockResolvedValue([]);
    try {
      const deps = productionConformanceDeps({ workspaceId: 'workspace', harnessSlug: 'harness', planSlug: 'plan' });
      await deps.evaluateCheck({ barKey: 'R-1', role: 'falsifier', checkId: 'R-1:mounts',
        check: { kind: 'instrument', instrumentKey: 'storage:cold-mounts-reboot' } });
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace', harnessSlug: 'harness' }));
    } finally { run.mockRestore(); }
  });

  it('binds executable probe checks to the canonical workspace', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown>; workspace: string | undefined }> = [];
    const dispatchTool: typeof dispatchPaletteTarget = async (opts) => {
      calls.push({ name: opts.name, args: opts.args as Record<string, unknown>, workspace: currentRequestWorkspaceId() });
      return { content: [{ type: 'text', text: '{"value":"next-sha"}' }] };
    };
    const probe = {
      kind: 'state-cell' as const,
      cell: 'deploy.3070.sha',
      schemaRevision: 'test-revision',
      expect: { op: 'ne' as const, path: '$.value', value: 'd740fc3802877d1c8c3b1068768681ee32ef0025' },
    };
    const evaluateProbes: typeof evaluateCriterionProbeChecks = async ({ dispatchTool: probeDispatch }) => {
      await probeDispatch?.('state:read', { cell: 'deploy.3070.sha' });
      return {
        ok: true,
        checkRuns: {
          'R-4': {
            kind: 'probe' as const,
            probe,
            verdict: 'pass' as const,
            status: 'fresh' as const,
            executed: true,
            observed: 'next-sha',
            measuredAt: '2026-10-18T17:00:00.000Z',
          },
        },
      };
    };
    const deps = productionConformanceDeps({
      workspaceId: 'delivery-workspace',
      harnessSlug: 'harness',
      planSlug: 'plan',
      dispatchTool,
      evaluateProbes,
    });

    const result = await runWithWorkspace('ambient-workspace', async () => {
      const value = await deps.evaluateCheck({
        barKey: 'R-4',
        role: 'done-when',
        checkId: 'R-4',
        check: {
          kind: 'probe',
          probe,
        },
      });
      expect(currentRequestWorkspaceId()).toBe('ambient-workspace');
      return value;
    });

    expect(result).toMatchObject({ kind: 'probe', verdict: 'pass', value: 'next-sha' });
    expect(calls).toEqual([{ name: 'state:read', args: { cell: 'deploy.3070.sha' }, workspace: 'delivery-workspace' }]);
    expect(currentRequestWorkspaceId()).toBeUndefined();
  });
});
