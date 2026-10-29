import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import runTool, {
  buildDetachedMixedTestRunRequest,
  buildDetachedTestRunRequest,
  clampTestingRunForegroundTimeoutMs,
  emptyDistilledRunRefusal,
  nameFilterNoMatchRefusal,
  parseRouterTerminalCompletion,
  recoverCompletedRunAfterBudget,
  reportlessNameFilterNoMatchRefusal,
  resolveDetachedHarnessSlug,
  selectTestFileRoot,
  testEvidenceRecoveryRunId,
  withInProcessTestingRunForegroundCeiling,
} from './run';
import { REPO_ROOT } from '../docs/_repo-paths';
import { FOREGROUND_TIMEOUT_CEILING_MS } from '../capability/foreground-transport-cap';

/**
 * `files` became OPTIONAL when `changedPaths` was added, which made `testing:run {}`
 * expressible for the first time. That is the dangerous shape: this tool's entire
 * reason for existing is refusing runs that measure nothing and exit 0, so a missing
 * selector must REFUSE rather than default to anything.
 *
 * Both refusals happen before any root resolution or spawn, so a bare ctx is enough —
 * and if that ever stops being true, these tests fail loudly instead of silently
 * shelling out from a test process.
 */
const bareCtx = {} as unknown as Parameters<typeof runTool.handler>[1];

async function callHandler(args: unknown) {
  const result = await runTool.handler(args as Parameters<typeof runTool.handler>[0], bareCtx);
  return (result as { data: Record<string, unknown> }).data;
}

describe('testing:run selector arbitration', () => {
  it('diagnoses reportless Node zero-match without inventing a verdict from unrelated output', () => {
    const pattern = '^missing "case"$';
    const output = ['ROUTE cwd=packages/x runner=node:test', '  requested real.test.ts',
      'ℹ tests 0', 'ℹ pass 0', 'ℹ fail 0', 'ℹ skipped 0',
      `TEST_FILE_NAME_FILTER_NO_MATCH requested=1 matched=1 executedFiles=1 testsExecuted=0 status=failed reason=name-filter-matched-no-tests pattern=${JSON.stringify(pattern)}; refusing to report a verdict`,
    ].join('\n');
    const args = { output, routerExit: 2, pattern, files: 1, runId: 'node-zero-match', root: '/repo' };
    expect(reportlessNameFilterNoMatchRefusal(args)).toMatchObject({
      ok: false, error: 'name_filter_no_match', skipped: 0, files: 1, runId: args.runId,
    });
    for (const routerExit of [0, 1, null]) {
      expect(reportlessNameFilterNoMatchRefusal({ ...args, routerExit })).toBeNull();
    }
    for (const changed of [
      output.replace('testsExecuted=0', 'testsExecuted=1'),
      output.replace('matched=1', 'matched=0'),
      output.replace('executedFiles=1', 'executedFiles=0'),
      output.replace('status=failed', 'status=passed'),
      output.replace('TEST_FILE_NAME_FILTER_NO_MATCH', 'TEST_FILE_RESULT'),
    ]) {
      expect(reportlessNameFilterNoMatchRefusal({ ...args, output: changed })).toBeNull();
    }
    expect(reportlessNameFilterNoMatchRefusal({ ...args, pattern: 'another case' })).toBeNull();
    expect(reportlessNameFilterNoMatchRefusal({ ...args, pattern: undefined })).toBeNull();
    expect(reportlessNameFilterNoMatchRefusal({ ...args, files: 2 })).toBeNull();
  });

  it('reuses completed Node proof after its budget without needing PostgreSQL or a replay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'completed-node-proof-'));
    const output = ['ROUTE cwd=packages/x runner=node:test', '  requested real.test.ts',
      '# tests 2', '# pass 1', '# fail 0', '# skipped 1',
      'TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed'].join('\n');
    try {
      const args = { output, dir, root: '/repo', runId: 'preserved-node-run',
        files: ['packages/x/real.test.ts'], timeoutMs: 1000, environment: {} };
      expect(await recoverCompletedRunAfterBudget(args)).toMatchObject({
        ok: true, runId: 'preserved-node-run', passed: 1, failed: 0, skipped: 1, budgetExceeded: true,
      });
      expect(await recoverCompletedRunAfterBudget({ ...args,
        output: output.replace('status=passed', 'status=passed finalizationError=true') })).toBeNull();
      expect(parseRouterTerminalCompletion(output.replace('# pass 1', '# pass 2'))).toBeNull();
      expect(parseRouterTerminalCompletion(output.replace('# pass 1', '# pass 0'))).toBeNull();
      expect(parseRouterTerminalCompletion(output.replace('executed=1', 'executed=2'))).toBeNull();
      expect(parseRouterTerminalCompletion(output.replace('runner=node:test', 'runner=vitest'))).toBeNull();
      expect(parseRouterTerminalCompletion(output.split('\n').slice(0, -1).join('\n'))).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  const nativeConsult = { request_key: 'native-retry', question: 'Does the archived source reach the configured backend?',
    tried: 'Read the exact dispatcher and launcher', observed: 'Prior native source failed to launch',
    decision_at_stake: 'Whether historical conversion is supported',
    sourceBackend: 'claude', sourceState: 'ended', targetBackend: 'codex' };

  it('requires an explicit held work-item for native consults before resolving or launching anything', async () => {
    expect(await callHandler({ nativeConsult })).toMatchObject({ ok: false, error: 'native_consult_requires_work_item' });
  });

  it.each(['files', 'changedPaths', 'recoverEvidence', 'remeasureEvidence', 'evidence', 'rootHarnessSlug', 'testNamePattern'])(
    'refuses native consult mixed with %s before launching anything', async (selector) => {
      expect(await callHandler({ nativeConsult, work_item_id: 'WI-1', [selector]: [] })).toMatchObject({
        ok: false, error: 'mutually_exclusive_selectors',
      });
    });

  it('rejects a native source/backend selector outside the finite contract', () => {
    expect(runTool.args.safeParse({ nativeConsult: { ...nativeConsult, targetBackend: 'unknown' } }).success).toBe(false);
  });

  it('is classified as a write so a timed-out MCP call can replay its result', () => {
    expect(runTool.effect).toBe('write');
  });

  it('accepts private-PG routing only as an explicit boolean execution option', () => {
    expect(runTool.args.safeParse({ files: ['feature.integration.test.ts'], privatePg: true }).success).toBe(true);
    expect(runTool.args.safeParse({ files: ['feature.integration.test.ts'], privatePg: 'true' }).success).toBe(false);
  });

  it('refuses private-PG routing without an executed file selection', async () => {
    expect(await callHandler({ privatePg: true })).toMatchObject({
      ok: false, error: 'private_pg_requires_executed_files',
    });
  });

  const emptyRun = {
    passed: 0,
    failed: 0,
    skipped: 0,
    files: 0,
    failures: [],
    failuresTruncated: false,
    durationMs: null,
    byFile: {},
  };

  it('refuses an empty external Vitest report instead of returning an ambiguous all-zero verdict', () => {
    expect(
      emptyDistilledRunRefusal({
        runs: [emptyRun],
        runId: 'run-empty-report',
        root: '/portal',
        routerOutput: 'vitest exited 1 after writing an empty report',
      }),
    ).toMatchObject({ ok: false, error: 'no_report', runId: 'run-empty-report', root: '/portal' });
  });

  it('refuses a mixed report set when any workspace group produced no files', () => {
    const measuredRun = { ...emptyRun, passed: 1, files: 1, byFile: { 'one.test.ts': { passed: 1, failed: 0, skipped: 0, collectionFailed: false } } };
    expect(
      emptyDistilledRunRefusal({
        runs: [measuredRun, emptyRun],
        runId: 'run-mixed-report',
        root: '/papercusp',
        routerOutput: 'one group passed; one group wrote an empty report',
      }),
    ).toMatchObject({ ok: false, error: 'no_report' });
  });

  it('keeps evidence recovery exclusive from starting another test process', async () => {
    const recoverEvidence = { workItemId: 'WI-1', originRunId: 'f04cdb70-ad2d-4757-9ff0-3a3d9f4440ad',
      runId: 'f04cdb70-ad2d-4757-9ff0-3a3d9f4440ad' };
    expect(runTool.args.safeParse({ recoverEvidence }).success).toBe(true);
    const data = await callHandler({ files: ['a.test.ts'], recoverEvidence });
    expect(data.error).toBe('mutually_exclusive_selectors');
  });

  it('uses the detached handle for evidence recovery when a run times out', () => {
    const originRunId = 'f04cdb70-ad2d-4757-9ff0-3a3d9f4440ad';
    const detachedRunId = 'ca5fce52-7c67-4d38-8c26-96a952f6a2a2';
    expect(testEvidenceRecoveryRunId(originRunId, { error: 'timeout', detachedRunId })).toBe(detachedRunId);
    expect(testEvidenceRecoveryRunId(originRunId, { error: 'timeout' })).toBe(originRunId);
    expect(testEvidenceRecoveryRunId(originRunId, { error: undefined, detachedRunId })).toBe(originRunId);
  });

  it('keeps detached timeout recovery locally adoptable and preserves its explicit harness scope', () => {
    const files = ['agent-credentials.test.ts'];
    const single = buildDetachedTestRunRequest({
      root: REPO_ROOT,
      files,
      harnessSlug: 'papercusp',
      workspaceId: 'papercusp-workspace',
      timeoutMs: 90_000,
    });
    const unscoped = buildDetachedTestRunRequest({
      root: REPO_ROOT,
      files,
      timeoutMs: 90_000,
    });
    const focused = buildDetachedTestRunRequest({
      root: REPO_ROOT,
      files,
      testNamePattern: 'focused proof',
      harnessSlug: 'papercusp',
      workspaceId: 'papercusp-workspace',
      timeoutMs: 90_000,
    });
    const mixed = buildDetachedMixedTestRunRequest({
      groups: [{ root: REPO_ROOT, files }],
      harnessSlug: 'papercusp',
      workspaceId: 'papercusp-workspace',
      timeoutMs: 90_000,
    });

    for (const request of [single, mixed]) {
      expect(request.testRunSource).toBe('local');
      expect(request.env).toMatchObject({
        PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
        PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace',
      });
    }
    expect(unscoped.testRunSource).toBe('local');
    expect(unscoped.env).not.toHaveProperty('PAPERCUSP_TEST_RUN_HARNESS');
    expect(single.detachedReportArtifacts).toHaveLength(1);
    expect(single.detachedReportArtifacts?.[0]).toMatchObject({
      root: REPO_ROOT,
      routerReports: true,
      scope: { harnessSlug: 'papercusp', workspaceId: 'papercusp-workspace' },
    });
    expect(mixed.detachedReportArtifacts).toHaveLength(1);
    expect(mixed.detachedReportArtifacts?.[0]).toMatchObject({ root: REPO_ROOT, routerReports: true });
    expect(unscoped.detachedReportArtifacts).toHaveLength(1);
    expect(unscoped.detachedReportArtifacts?.[0]).not.toHaveProperty('scope');
    const reportPath = focused.detachedReportArtifacts?.[0]?.reportPath;
    expect(focused.detachedReportArtifacts).toHaveLength(1);
    expect(focused.detachedReportArtifacts?.[0]).toMatchObject({
      root: REPO_ROOT,
      testNamePattern: 'focused proof',
      scope: { harnessSlug: 'papercusp', workspaceId: 'papercusp-workspace' },
    });
    expect(reportPath).toContain('papercusp-testing-run-detached-');
    expect(focused.args).toEqual([
      join(REPO_ROOT, 'scripts', 'test-files.mjs'),
      ...files,
      '--',
      '--reporter=json',
      `--reporter=${join(REPO_ROOT, 'libs/test-config/src/admin-test-runs-reporter.ts')}`,
      `--outputFile=${reportPath}`,
      '--testNamePattern=focused proof',
    ]);
  });

  it('keeps throwaway PG and the durable test-ledger sink in detached recovery', () => {
    const previousSink = process.env.PAPERCUSP_TEST_RUNS_DB_URL;
    const ledgerSink = 'postgresql://127.0.0.1/detached-private-ledger';
    try {
      process.env.PAPERCUSP_TEST_RUNS_DB_URL = ledgerSink;
      const request = buildDetachedTestRunRequest({
        root: REPO_ROOT,
        files: ['packages/operator-core/lib/omp-managed-tools.native.integration.test.ts'],
        timeoutMs: 900_000,
        privatePg: true,
      });
      expect(request.command).toBe(process.execPath);
      expect(request.args.slice(0, 4)).toEqual([
        join(REPO_ROOT, 'scripts', 'with-test-pg.mjs'),
        '--',
        process.execPath,
        join(REPO_ROOT, 'scripts', 'test-files.mjs'),
      ]);
      expect(request.env).toMatchObject({
        PAPERCUSP_TEST_RUNS_DB_URL: ledgerSink,
        PAPERCUSP_TEST_FILE_TIMEOUT_MS: expect.any(String),
      });
    } finally {
      if (previousSink === undefined) delete process.env.PAPERCUSP_TEST_RUNS_DB_URL;
      else process.env.PAPERCUSP_TEST_RUNS_DB_URL = previousSink;
    }
  });

  it('boots detached test workers in test mode without changing a production host', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const artifactDirs: string[] = [];
    try {
      const now = Date.now();
      const scoped = { root: REPO_ROOT, files: ['agent-credentials.test.ts'],
        harnessSlug: 'papercusp', workspaceId: 'papercusp-workspace' };
      const callerBound = buildDetachedTestRunRequest({ ...scoped, deadline: {
        startedAtMs: now, taskDeadlineAtMs: now + 60_000,
        childCutoffAtMs: now + 55_000, cleanupReserveMs: 5_000,
      } });
      artifactDirs.push(...(callerBound.detachedReportArtifacts ?? []).map(artifact => dirname(artifact.reportPath)));
      const requests = [
        buildDetachedTestRunRequest(scoped),
        buildDetachedMixedTestRunRequest({ groups: [{ root: REPO_ROOT, files: scoped.files }],
          harnessSlug: scoped.harnessSlug, workspaceId: scoped.workspaceId }),
        callerBound,
      ];
      for (const request of requests) {
        expect(request.env).toMatchObject({ NODE_ENV: 'test',
          PAPERCUSP_TEST_RUN_HARNESS: scoped.harnessSlug, PAPERCUSP_WORKSPACE_ID: scoped.workspaceId });
      }
      expect(process.env.NODE_ENV).toBe('production');
    } finally {
      vi.unstubAllEnvs();
      await Promise.all(artifactDirs.map(path => rm(path, { recursive: true, force: true })));
    }
  });

  it('retains a JSON recovery report beside the admin reporter for ordinary multi-file runs', () => {
    const request = buildDetachedTestRunRequest({
      root: REPO_ROOT,
      files: ['packages/operator-core/lib/testing-run-store.test.ts', 'apps/operator/lib/verify-tauri-headless-env.test.ts'],
      harnessSlug: 'papercusp', workspaceId: 'papercusp-workspace',
    });
    const artifact = request.detachedReportArtifacts?.[0];
    expect(artifact).toMatchObject({ root: REPO_ROOT, routerReports: true, testNamePattern: null });
    expect(request.args).toEqual(expect.arrayContaining([
      '--reporter=json',
      `--reporter=${join(REPO_ROOT, 'libs/test-config/src/admin-test-runs-reporter.ts')}`,
      `--outputFile=${artifact?.reportPath}`,
    ]));
  });

  it('does not claim evidence from an affected-test plan that runs nothing', async () => {
    const data = await callHandler({ changedPaths: ['src/a.ts'], evidence: { workItemId: 'WI-1', bindings: [] } });
    expect(data.error).toBe('evidence_requires_executed_files');
  });

  it('refuses a call with NEITHER selector instead of defaulting', async () => {
    const data = await callHandler({});
    expect(data.ok).toBe(false);
    expect(data.error).toBe('no_selector');
  });

  it('refuses a call with BOTH selectors instead of silently preferring one', async () => {
    // Preferring `files` here would quietly ignore a radius the caller asked to see.
    const data = await callHandler({ files: ['a.test.ts'], changedPaths: ['src/a.ts'] });
    expect(data.ok).toBe(false);
    expect(data.error).toBe('mutually_exclusive_selectors');
  });

  /**
   * `testNamePattern` is the ONLY failed-scenario rerun surface (R-8), and the tool's own
   * description tells the caller to paste a previous result's `failures[].test` into it.
   * That value reaches vitest as `--testNamePattern=<verbatim>`, which is a REGEX — so a
   * pasted literal containing regex metacharacters does not match itself.
   *
   * Measured 2026-09-11, same file, one variable changed:
   *   'flags ≤1-tool recipes (thin wrappers over the primitive)'   -> name_filter_no_match, 0 run
   *   'flags ≤1-tool recipes \\(thin wrappers over the primitive\\)' -> passed:1, the intended test
   * Population: 25,606 of 86,056 unique test names in operator-core carry such a character
   * (19,915 of them parentheses).
   *
   * The REFUSAL is correct and must stay — it is what stops a vacuous run reading as green.
   * The defect is the DIAGNOSIS: blaming "a typo or a stale name" is wrong for a name that is
   * exact and current, and sending the caller to re-run without the filter prescribes the
   * whole-file rerun R-8 exists to prevent. Recovery must cost one precise call, not a matrix.
   */
  describe('name_filter_no_match diagnosis', () => {
    const base = { skipped: 3, files: 1, runId: 'run-name-filter', root: '/papercusp' };
    const literal = 'flags ≤1-tool recipes (thin wrappers over the primitive)';

    it('hands back an escaped pattern that actually matches the pasted literal', () => {
      const refusal = nameFilterNoMatchRefusal({ ...base, pattern: literal });
      expect(refusal).toMatchObject({ ok: false, error: 'name_filter_no_match', skipped: 3 });
      // The property that matters is not the wording — it is that the suggestion WORKS.
      expect(refusal.literalPattern).toBeDefined();
      expect(new RegExp(refusal.literalPattern!).test(literal)).toBe(true);
      // ...and that the original genuinely did not, or there would be nothing to fix.
      expect(new RegExp(literal).test(literal)).toBe(false);
      expect(refusal.hint).toContain(refusal.literalPattern!);
    });

    it('does not prescribe an unfiltered whole-file rerun as the remedy for a pasted literal', () => {
      const { hint } = nameFilterNoMatchRefusal({ ...base, pattern: literal });
      expect(hint).not.toMatch(/Re-run without testNamePattern/i);
      expect(hint).toMatch(/metacharacter|literal/i);
    });

    it('names a pattern that is not even a valid regex as certainly a pasted literal', () => {
      // An unclosed class cannot have been intended as a regex, so this is not a judgement call.
      const broken = 'handles [DIRTY paths';
      const refusal = nameFilterNoMatchRefusal({ ...base, pattern: broken });
      expect(refusal.patternIsValidRegex).toBe(false);
      expect(new RegExp(refusal.literalPattern!).test(broken)).toBe(true);
    });

    it('keeps the typo/stale-name guidance when the pattern has no metacharacters to blame', () => {
      // Here a zero match really does mean a wrong name, and inventing an escaping story
      // would be a confident wrong diagnosis in the opposite direction.
      const refusal = nameFilterNoMatchRefusal({ ...base, pattern: 'a plain name that is gone' });
      expect(refusal.literalPattern).toBeUndefined();
      expect(refusal.hint).toMatch(/typo or a stale name/i);
    });
  });

  it('still accepts each selector on its own at the schema level', () => {
    expect(runTool.args.safeParse({ files: ['a.test.ts'] }).success).toBe(true);
    expect(runTool.args.safeParse({ changedPaths: ['src/a.ts'] }).success).toBe(true);
    expect(runTool.args.safeParse({
      files: ['a.test.ts'],
      harness: 'papercusp',
      recheckReason: 'revalidate after an environment repair',
    }).success).toBe(true);
    // Empty arrays stay rejected by the schema — an empty selector is the same
    // measure-nothing hazard wearing a different hat.
    expect(runTool.args.safeParse({ files: [] }).success).toBe(false);
    expect(runTool.args.safeParse({ changedPaths: [] }).success).toBe(false);
  });
});

describe('testing:run cross-hive root fallback reproduction (EI-24176097539238030)', () => {
  const files = ['packages/operator-core/lib/testing-flakiness.test.ts'];
  const unrelatedHiveRoot = '/tmp/unrelated-hive';

  it('does not use the operator process REPO_ROOT when an unrelated caller requests its test path', () => {
    expect(selectTestFileRoot(files, unrelatedHiveRoot, { discoveredRoots: [] })).toEqual({
      root: unrelatedHiveRoot,
      source: 'requested',
    });
  });

  it('rejects a release/checkpoint-style worktree as the configured canonical fallback', async () => {
    const releaseWorktree = await mkdtemp(join(tmpdir(), 'papercup-release-root-fallback-'));
    const file = join(releaseWorktree, files[0]!);
    try {
      await writeFile(join(releaseWorktree, '.git'), 'gitdir: /tmp/worktrees/release/.git');
      await writeFile(
        join(releaseWorktree, 'package.json'),
        JSON.stringify({ private: true, workspaces: ['packages/*'] }),
      );
      await mkdir(join(releaseWorktree, 'scripts'), { recursive: true });
      await writeFile(join(releaseWorktree, 'scripts', 'test-files.mjs'), 'process.exit(0);\n');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, 'export {};\n');

      expect(
        selectTestFileRoot(files, unrelatedHiveRoot, {
          discoveredRoots: [],
          canonicalRepoRoot: releaseWorktree,
        }),
      ).toEqual({ root: unrelatedHiveRoot, source: 'requested' });
    } finally {
      await rm(releaseWorktree, { recursive: true, force: true });
    }
  });
});

describe('testing:run foreground handler budget', () => {
  it('reserves handler-phase headroom inside the shared foreground ceiling', () => {
    const maximum = clampTestingRunForegroundTimeoutMs(Number.MAX_SAFE_INTEGER);

    expect(maximum).toBe(FOREGROUND_TIMEOUT_CEILING_MS - 20_000);
    expect(maximum).toBe(25_000);
    expect(clampTestingRunForegroundTimeoutMs(10_000)).toBe(10_000);
  });

  // WI-6554700010018388: an in-process caller crosses no MCP transport, so it may declare its own
  // ceiling. That ceiling must stay inside the caller's async chain. A concurrent MCP-dispatched
  // call in the same process keeps the transport clamp.
  it('lifts the transport budget only inside the in-process caller scope', async () => {
    const outside = new Promise<number>((resolve) => {
      setTimeout(() => resolve(clampTestingRunForegroundTimeoutMs(Number.MAX_SAFE_INTEGER)), 5);
    });
    const inside = await withInProcessTestingRunForegroundCeiling(90_000, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return clampTestingRunForegroundTimeoutMs(Number.MAX_SAFE_INTEGER);
    });

    expect(inside).toBe(90_000);
    expect(await outside).toBe(25_000);
    expect(clampTestingRunForegroundTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(25_000);
    await expect(withInProcessTestingRunForegroundCeiling(90_000, async () => clampTestingRunForegroundTimeoutMs(10_000)))
      .resolves.toBe(10_000);
    expect(() => withInProcessTestingRunForegroundCeiling(0, async () => 1)).toThrow(RangeError);
  });
});

/**
 * WI-10006949: an operator/superuser `testing:run` carries the '*' harness sentinel, and a
 * detached recovery request without a concrete harness had no scope — so its recovered report
 * rows were silently never written to test_runs. The detached harness must resolve from the
 * registry entry that owns the root whenever the caller did not name a concrete one.
 */
describe('resolveDetachedHarnessSlug', () => {
  const root = '/fixture/checkout';
  const lookups: Array<[string, string]> = [];
  const lookup = async (r: string, w: string) => { lookups.push([r, w]); return 'registered-harness'; };

  it.each([undefined, '*'])('resolves the registered harness when the caller sent %s', async (harnessSlug) => {
    lookups.length = 0;
    await expect(resolveDetachedHarnessSlug({
      root, workspaceId: 'ws-1', detachedEnabled: true, ...(harnessSlug !== undefined ? { harnessSlug } : {}),
    }, lookup)).resolves.toBe('registered-harness');
    expect(lookups).toEqual([[root, 'ws-1']]);
  });

  it('keeps an explicit concrete harness without a registry lookup', async () => {
    lookups.length = 0;
    await expect(resolveDetachedHarnessSlug({
      root, workspaceId: 'ws-1', harnessSlug: 'papercusp', detachedEnabled: true,
    }, lookup)).resolves.toBe('papercusp');
    expect(lookups).toEqual([]);
  });

  it('does not look up a harness when detached recovery is off or the workspace is not concrete', async () => {
    lookups.length = 0;
    await expect(resolveDetachedHarnessSlug({ root, workspaceId: 'ws-1', harnessSlug: '*', detachedEnabled: false }, lookup))
      .resolves.toBe('*');
    await expect(resolveDetachedHarnessSlug({ root, workspaceId: '*', detachedEnabled: true }, lookup)).resolves.toBeUndefined();
    await expect(resolveDetachedHarnessSlug({ root, detachedEnabled: true }, lookup)).resolves.toBeUndefined();
    expect(lookups).toEqual([]);
  });

  it('falls back to what the caller sent when the root is unregistered or the lookup fails', async () => {
    await expect(resolveDetachedHarnessSlug(
      { root, workspaceId: 'ws-1', harnessSlug: '*', detachedEnabled: true }, async () => undefined,
    )).resolves.toBe('*');
    await expect(resolveDetachedHarnessSlug(
      { root, workspaceId: 'ws-1', detachedEnabled: true }, async () => { throw new Error('registry unavailable'); },
    )).resolves.toBeUndefined();
  });
});
