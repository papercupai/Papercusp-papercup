import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// EI-24100872054224181: a testing:run { evidence } refused by the mutation-probe fence used to
// register pending spec-evidence rows first and then FINISH them, leaving two never-settling
// rows per binding that remeasure skipped as run-in-flight until someone retracted them by hand.
const phases = vi.hoisted(() => ({
  fence: vi.fn(),
  restricted: vi.fn(),
  prepare: vi.fn(),
  finish: vi.fn(),
  retract: vi.fn(),
  buildRemeasure: vi.fn(),
  detach: vi.fn(),
  snapshot: vi.fn(),
}));
// This suite owns refusal/deadline behavior. The provenance collector uses
// governed subprocesses and the loop gate reads live claims; their own suites
// cover those dependencies. Neither belongs under this suite's virtual clock.
vi.mock('../../verification-attempts/loop-gate', () => ({ loopLaunchRefusal: vi.fn(async () => null) }));
vi.mock('./mutation-probe-fence', () => ({ mutationProbeRefusal: phases.fence }));
// The restricted-write fence (WI-10005634) reads the fence module's closure exports, which the
// factory above omits; its reach logic has its own suite (restricted-hold-fence.test.ts).
vi.mock('./restricted-hold-fence', () => ({ restrictedHoldRefusal: phases.restricted }));
vi.mock('../../testing-run-store', async (original) => ({
  ...(await original<typeof import('../../testing-run-store')>()),
  startRunDurable: phases.detach,
  captureWorktreeSnapshotAsync: phases.snapshot,
}));
vi.mock('./evidence', async (original) => ({
  ...(await original<typeof import('./evidence')>()),
  prepareTestEvidence: phases.prepare,
  finishTestEvidence: phases.finish,
  retractRefusedTestEvidence: phases.retract,
  buildTestEvidenceRemeasure: phases.buildRemeasure,
}));

import runTool, { buildDetachedMixedTestRunRequest, buildDetachedTestRunRequest, runTestFilesCore } from './run';
import * as runArtifacts from './run-artifacts';

const refusal = { error: 'mutation_probe_active' as const, hint: 'active mutation probe on src/feature.ts' };
const roots: string[] = [];
beforeEach(() => {
  phases.snapshot.mockResolvedValue({ commit: null, porcelain: null });
});
async function cleanupDetachedReports() {
  // Legacy recovery writes a unique file in a shared temporary directory.
  // Only explicitly allocated fixture roots belong in the recursive cleanup.
  const files = phases.detach.mock.calls.flatMap(([request]) =>
    (request.detachedReportArtifacts ?? []).flatMap((artifact: { reportPath: string; failureDetailsPath?: string }) =>
      [artifact.reportPath, artifact.failureDetailsPath].filter((path): path is string => Boolean(path))));
  await Promise.all(files.map(path => rm(path, { force: true })));
}
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupDetachedReports();
  Object.values(phases).forEach((mock) => mock.mockReset());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTestRoot(router = false) {
  const root = await mkdtemp(join(tmpdir(), 'testing-run-evidence-refusal-'));
  roots.push(root);
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: [] }));
  await writeFile(join(root, 'vitest.config.ts'), 'export default {};\n');
  await writeFile(join(root, 'feature.test.ts'), "import { it } from 'vitest';\nit('noop', () => {});\n");
  if (router) {
    await mkdir(join(root, 'scripts'));
    await writeFile(join(root, 'scripts/test-files.mjs'), 'export {};\n');
  }
  return root;
}

it('cleans detached report files while preserving their shared parent and sibling artifacts', async () => {
  const root = await makeTestRoot();
  const reportPath = join(root, 'detached-report.json');
  const failureDetailsPath = join(root, 'detached-failures.json');
  const siblingPath = join(root, 'another-run.json');
  await Promise.all([reportPath, failureDetailsPath, siblingPath].map(path => writeFile(path, '{}')));
  phases.detach({ detachedReportArtifacts: [{ reportPath, failureDetailsPath }] });

  await cleanupDetachedReports();

  await expect(readFile(reportPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(failureDetailsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(siblingPath, 'utf8')).toBe('{}');
  expect(await readFile(join(root, 'package.json'), 'utf8')).toContain('workspaces');
});

async function invoke(extra: Record<string, unknown> = {}) {
  const root = await makeTestRoot();
  const evidence = { workItemId: 'WI-refusal', planSlug: 'refusal-plan', bindings: [{
    specId: 'SPEC-001', specRevision: 1, testPath: 'feature.test.ts', sourcePaths: ['feature.ts'], testLayer: 'unit' as const,
  }] };
  const ctx = { projectDir: root, workspaceId: 'refusal-workspace', uiClientId: 'su-refusal-test', isSuperuser: true } as const;
  const args = runTool.args.parse({ files: ['feature.test.ts'], harness: 'refusal-harness', evidence, ...extra });
  const result = await runTool.handler(args, ctx as never) as { data: Record<string, unknown> };
  return { root, result: result.data };
}

it('validates public absolute deadlines and reserves instead of stripping them', () => {
  const args = { files: ['feature.test.ts'], timeoutMs: 20_000, taskDeadlineAtMs: 21_000, cleanupReserveMs: 5_000 };
  expect(runTool.args.parse(args)).toMatchObject(args);
  for (const invalid of [NaN, Infinity, -1, 1.5]) {
    expect(runTool.args.safeParse({ ...args, taskDeadlineAtMs: invalid }).success).toBe(false);
    expect(runTool.args.safeParse({ ...args, cleanupReserveMs: invalid }).success).toBe(false);
  }
});

it('refuses an already expired caller deadline before fences or pending evidence writes', async () => {
  const { result } = await invoke({ taskDeadlineAtMs: 1, cleanupReserveMs: 5_000 });
  expect(result).toMatchObject({ ok: false, error: 'deadline_exhausted' });
  expect(result).not.toHaveProperty('artifacts');
  expect(phases.fence).not.toHaveBeenCalled();
  expect(phases.prepare).not.toHaveBeenCalled();
});

it('rejects an invalid relative reserve before pending evidence writes', async () => {
  const { result } = await invoke({ timeoutMs: 10_000, cleanupReserveMs: 10_000 });
  expect(result).toMatchObject({ ok: false, error: 'invalid_test_deadline' });
  expect(phases.prepare).not.toHaveBeenCalled();
});

it('preserves the foreground transport cap without shrinking an explicit oversized reserve', async () => {
  const clock = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(clock);
  const anchored = vi.spyOn(runArtifacts, 'testRunDeadline');
  phases.fence.mockResolvedValue(refusal);
  const { result } = await invoke({ timeoutMs: 600_000, taskDeadlineAtMs: Date.now() + 600_000,
    cleanupReserveMs: 60_000 });
  expect(anchored.mock.results[0]?.value).toEqual({ startedAtMs: clock, taskDeadlineAtMs: clock + 600_000,
    cleanupReserveMs: 60_000, childCutoffAtMs: clock + 540_000 });
  expect(result).toMatchObject({ ok: false, error: 'mutation_probe_active' });
  expect(phases.prepare).not.toHaveBeenCalled();
});

it('R5 preserves a caller deadline beyond the foreground cap without overwriting it', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_000);
  const anchored = vi.spyOn(runArtifacts, 'testRunDeadline');
  phases.fence.mockResolvedValue(refusal);
  const { result } = await invoke({ timeoutMs: 45_000, taskDeadlineAtMs: 46_000, cleanupReserveMs: 10_000 });
  expect(anchored.mock.results[0]?.value).toEqual({ startedAtMs: 1_000, taskDeadlineAtMs: 46_000,
    cleanupReserveMs: 10_000, childCutoffAtMs: 36_000 });
  expect(result).toMatchObject({ error: 'mutation_probe_active' });
});

const timedOutRouter = () => vi.fn(async (_args: string[], _root: string,
  _env: NodeJS.ProcessEnv, _timeoutMs: number) => ({
  code: null, signal: null, timedOut: true, aborted: false, output: '',
}));
const callerDeadline = { startedAtMs: 1_000, taskDeadlineAtMs: 46_000,
  cleanupReserveMs: 10_000, childCutoffAtMs: 36_000 };

it.each([21_000, 31_000])('retains the requested task budget when preparation reaches %ims beyond the foreground reserve', async preparationEnd => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const root = await makeTestRoot(true);
  phases.restricted.mockImplementation(async () => { now = preparationEnd; return null; });
  phases.detach.mockResolvedValue({ snapshot: { runId: 'preparation-replay' }, durable: true });
  const runRouterFn = timedOutRouter();
  const result = await runTestFilesCore({ root, files: ['feature.test.ts'], timeoutMs: 25_000,
    recoveryTimeoutMs: 60_000, harnessSlug: 'refusal-harness', workspaceId: 'refusal-workspace' },
  { runRouterFn, artifactBaseDir: root });
  expect(result).toMatchObject({ error: 'timeout', detachedRunId: 'preparation-replay', detachedDurable: true });
  const manifest = JSON.parse(await readFile(result.artifacts!.manifest, 'utf8'));
  expect(manifest.deadline).toEqual({ startedAtMs: 1_000, taskDeadlineAtMs: 61_000,
    cleanupReserveMs: 20_000, childCutoffAtMs: 41_000 });
  expect(manifest.cleanup.complete).toBe(true);
  expect(phases.detach).toHaveBeenCalledOnce();
  expect(phases.snapshot).toHaveBeenCalledExactlyOnceWith(root);
  if (preparationEnd < 26_000) {
    expect(runRouterFn).toHaveBeenCalledOnce();
    expect(runRouterFn.mock.calls[0]![3]).toBe(26_000 - preparationEnd);
    expect(runRouterFn.mock.calls[0]![2]).toMatchObject({
      PAPERCUSP_TEST_TASK_DEADLINE_AT_MS: '61000', PAPERCUSP_TEST_CHILD_CUTOFF_AT_MS: '41000',
      PAPERCUSP_TEST_CLEANUP_RESERVE_MS: '20000',
    });
  } else {
    expect(runRouterFn).not.toHaveBeenCalled();
  }
});

it('R5 replays a caller-bound foreground timeout with the identical deadline and reserve', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_000);
  const root = await makeTestRoot(true);
  phases.detach.mockResolvedValue({ snapshot: { runId: 'caller-replay' }, durable: true });
  const runRouterFn = timedOutRouter();
  const result = await runTestFilesCore({ root, files: ['feature.test.ts'], timeoutMs: 25_000,
    deadline: callerDeadline, harnessSlug: 'refusal-harness', workspaceId: 'refusal-workspace' },
  { runRouterFn, artifactBaseDir: root });
  expect(result).toMatchObject({ error: 'timeout', detachedRunId: 'caller-replay', detachedDurable: true });
  expect(phases.detach).toHaveBeenCalledOnce();
  expect(phases.detach.mock.calls[0]![0]).toMatchObject({ env: {
    PAPERCUSP_TEST_TASK_DEADLINE_AT_MS: '46000', PAPERCUSP_TEST_CHILD_CUTOFF_AT_MS: '36000',
    PAPERCUSP_TEST_CLEANUP_RESERVE_MS: '10000',
  } });
  expect(runRouterFn).toHaveBeenCalledOnce();
});

it('R5 keeps the replay cutoff fixed after preparation and refuses an exhausted replay before spawn', async () => {
  let now = 10_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const root = await makeTestRoot(true);
  const request = buildDetachedTestRunRequest({ root, files: ['feature.test.ts'],
    timeoutMs: 45_000, deadline: callerDeadline });
  expect(request.env).toMatchObject({ PAPERCUSP_TEST_TASK_DEADLINE_AT_MS: '46000',
    PAPERCUSP_TEST_CHILD_CUTOFF_AT_MS: '36000', PAPERCUSP_TEST_CLEANUP_RESERVE_MS: '10000' });
  const reportArtifact = request.detachedReportArtifacts?.[0];
  expect(reportArtifact).toMatchObject({ root, routerReports: true, testNamePattern: null });
  const reportDirectory = dirname(reportArtifact!.reportPath);
  roots.push(reportDirectory);
  expect(request.args.at(-1)).toContain(JSON.stringify({ [root]: reportDirectory }));
  const runRouterFn = timedOutRouter();
  const replay = { root, files: ['feature.test.ts'], timeoutMs: 45_000,
    deadline: callerDeadline, allowDetachedRecovery: false };
  const replayResult = await runTestFilesCore(replay, { runRouterFn, artifactBaseDir: root,
    reportDirectories: { [root]: reportDirectory } });
  expect(replayResult.artifacts?.reports).toBe(join(replayResult.artifacts!.directory, 'reports'));
  expect(runRouterFn.mock.calls[0]![0]).toContain(`--outputFile=${reportArtifact!.reportPath}`);
  expect(runRouterFn.mock.calls[0]![2]).toMatchObject(request.env!);
  expect(runRouterFn.mock.calls[0]![3]).toBe(26_000);
  now = 36_000;
  const exhausted = await runTestFilesCore(replay, { runRouterFn, artifactBaseDir: root });
  expect(exhausted).toMatchObject({ error: 'deadline_exhausted' });
  expect(exhausted).not.toHaveProperty('artifacts');
  expect(runRouterFn).toHaveBeenCalledOnce();
  expect(phases.detach).not.toHaveBeenCalled();
});

it('R5 writes both checkout reports at the paths retained by caller-bound detached recovery', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(10_000);
  const groups = await Promise.all([makeTestRoot(true), makeTestRoot(true)])
    .then(checkouts => checkouts.map(root => ({ root, files: ['feature.test.ts'] })));
  const request = buildDetachedMixedTestRunRequest({ groups, deadline: callerDeadline, timeoutMs: 45_000 });
  const artifacts = request.detachedReportArtifacts!;
  expect(artifacts.map(artifact => artifact.root)).toEqual(groups.map(group => group.root));
  const reportDirectories = Object.fromEntries(artifacts.map(artifact => [artifact.root, dirname(artifact.reportPath)]));
  roots.push(...Object.values(reportDirectories));
  expect(request.args.at(-1)).toContain(JSON.stringify(reportDirectories));
  const runRouterFn = vi.fn(async (args: string[], root: string) => {
    const output = args.find(arg => arg.startsWith('--outputFile='))!.slice('--outputFile='.length);
    await writeFile(output, JSON.stringify({ success: true, numPassedTests: 1, numFailedTests: 0,
      numPendingTests: 0, testResults: [{ name: join(root, 'feature.test.ts'), status: 'passed',
        assertionResults: [{ title: 'noop', fullName: 'noop', status: 'passed' }] }] }));
    return { code: 0, signal: null, timedOut: false, aborted: false, output: '' };
  });
  const result = await runTestFilesCore({ root: groups[0]!.root,
    files: groups.flatMap(group => group.files.map(file => join(group.root, file))),
    deadline: callerDeadline, timeoutMs: 45_000, allowDetachedRecovery: false },
  { runRouterFn, artifactBaseDir: groups[0]!.root, reportDirectories });
  expect(result).toMatchObject({ ok: true, passed: 2, failed: 0 });
  expect(runRouterFn).toHaveBeenCalledTimes(2);
  for (const artifact of artifacts) {
    expect(runRouterFn.mock.calls.find(([, root]) => root === artifact.root)?.[0])
      .toContain(`--outputFile=${artifact.reportPath}`);
    expect(JSON.parse(await readFile(artifact.reportPath, 'utf8')).testResults[0].name)
      .toBe(join(artifact.root, 'feature.test.ts'));
  }
  expect(phases.detach).not.toHaveBeenCalled();
});

it('retains replay report bytes after the detached store consumes its temporary sink', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(10_000);
  const root = await makeTestRoot(true);
  const sink = await mkdtemp(join(tmpdir(), 'testing-run-replay-retention-'));
  roots.push(sink);
  const report = JSON.stringify({ success: true, numPassedTests: 1, numFailedTests: 0,
    numPendingTests: 0, testResults: [{ name: join(root, 'feature.test.ts'), status: 'passed',
      assertionResults: [{ title: 'noop', fullName: 'noop', status: 'passed' }] }] });
  const sidecar = JSON.stringify({ details: [] });
  const runRouterFn = vi.fn(async (args: string[]) => {
    expect(args).toContain(`--outputFile=${join(sink, 'report.json')}`);
    await writeFile(join(sink, 'report.json'), report);
    await writeFile(join(sink, 'report-sidecar.txt'), sidecar);
    return { code: 0, signal: null, timedOut: false, aborted: false, output: '' };
  });
  const result = await runTestFilesCore({ root, files: ['feature.test.ts'],
    timeoutMs: 45_000, deadline: callerDeadline, allowDetachedRecovery: false },
  { runRouterFn, artifactBaseDir: root, reportDirectories: { [root]: sink } });
  expect(result).toMatchObject({ ok: true, passed: 1 });
  await rm(sink, { recursive: true, force: true });
  const manifest = JSON.parse(await readFile(result.artifacts!.manifest, 'utf8'));
  expect(manifest.paths.reports).toBe(result.artifacts!.reports);
  expect(manifest.childState).toBe('closed');
  expect(manifest.cleanup.complete).toBe(true);
  await expect(readFile(join(result.artifacts!.reports, 'report.json'), 'utf8')).resolves.toBe(report);
  await expect(readFile(join(result.artifacts!.reports, 'report-sidecar.txt'), 'utf8')).resolves.toBe(sidecar);
});

it('R5 keeps a caller deadline within the foreground cap unchanged and foreground-only', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_000);
  const root = await makeTestRoot(true);
  const deadline = { startedAtMs: 1_000, taskDeadlineAtMs: 21_000,
    cleanupReserveMs: 5_000, childCutoffAtMs: 16_000 };
  const runRouterFn = timedOutRouter();
  const result = await runTestFilesCore({ root, files: ['feature.test.ts'], timeoutMs: 25_000, deadline },
    { runRouterFn, artifactBaseDir: root });
  expect(result).toMatchObject({ error: 'timeout' });
  expect(result).not.toHaveProperty('detachedRunId');
  expect(runRouterFn.mock.calls[0]![2]).toMatchObject({ PAPERCUSP_TEST_TASK_DEADLINE_AT_MS: '21000',
    PAPERCUSP_TEST_CHILD_CUTOFF_AT_MS: '16000', PAPERCUSP_TEST_CLEANUP_RESERVE_MS: '5000' });
  expect(deadline).toEqual({ startedAtMs: 1_000, taskDeadlineAtMs: 21_000,
    cleanupReserveMs: 5_000, childCutoffAtMs: 16_000 });
  expect(phases.detach).not.toHaveBeenCalled();
});

it('charges elapsed handler preflight to the caller child cutoff before evidence preparation', async () => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  phases.fence.mockImplementation(async () => { now = 15_000; return null; });
  const { result } = await invoke({ timeoutMs: 20_000, taskDeadlineAtMs: 21_000, cleanupReserveMs: 10_000 });
  expect(result).toMatchObject({ ok: false, error: 'deadline_exhausted',
    deadline: { startedAtMs: 1_000, taskDeadlineAtMs: 21_000, childCutoffAtMs: 11_000, cleanupReserveMs: 10_000 } });
  expect(phases.prepare).not.toHaveBeenCalled();
  expect(phases.finish).not.toHaveBeenCalled();
});

it('retires pending evidence if preparation itself exhausts the fixed cutoff without creating a child packet', async () => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const prepared = [{ input: { evidenceRef: 'test-run-group:expired:0' } }];
  phases.prepare.mockImplementation(async () => { now = 15_000; return prepared; });
  phases.retract.mockResolvedValue({ status: 'not-recorded', reason: 'deadline_exhausted', retiredCount: 1 });
  const { result } = await invoke({ timeoutMs: 20_000, taskDeadlineAtMs: 21_000, cleanupReserveMs: 10_000 });
  expect(result).toMatchObject({ ok: false, error: 'deadline_exhausted',
    evidenceBundle: { status: 'not-recorded', retiredCount: 1 } });
  expect(result).not.toHaveProperty('artifacts');
  expect(phases.retract).toHaveBeenCalledExactlyOnceWith(prepared, result.runId,
    expect.objectContaining({ harnessSlug: 'refusal-harness' }), 'deadline_exhausted');
  expect(phases.finish).not.toHaveBeenCalled();
});

it('refuses a re-measure whose stale proofs were measured in more than one checkout (EI-25203154942838341)', async () => {
  // One process runs in ONE checkout; a hive-app proof re-run at the session root is ENOENT.
  phases.buildRemeasure.mockResolvedValue({
    request: { workItemId: 'WI-refusal', planSlug: 'refusal-plan', bindings: [] },
    files: ['feature.test.ts'], plan: { selected: [], skipped: [] }, rootHarnessSlugs: ['phone-app', null],
    abandonedPendingBindingIds: [], summary: { examined: 2, selected: 2, skipped: 0, abandonedPending: 0 },
  });
  const ctx = { projectDir: tmpdir(), workspaceId: 'refusal-workspace', uiClientId: 'su-refusal-test', isSuperuser: true } as const;
  const args = runTool.args.parse({ harness: 'refusal-harness',
    remeasureEvidence: { workItemId: 'WI-refusal', planSlug: 'refusal-plan' } });

  const result = (await runTool.handler(args, ctx as never) as { data: Record<string, unknown> }).data;

  expect(result).toMatchObject({ ok: false, error: 'evidence_remeasure_mixed_roots', rootHarnessSlugs: ['phone-app', null] });
  expect(phases.buildRemeasure).toHaveBeenCalledOnce();
  expect(phases.prepare).not.toHaveBeenCalled();
  expect(phases.fence).not.toHaveBeenCalled();
});

it('refuses before registering any evidence when a mutation probe is active', async () => {
  phases.fence.mockResolvedValue(refusal);

  const { root, result } = await invoke();

  expect(result).toMatchObject({ ok: false, root, error: 'mutation_probe_active', hint: refusal.hint });
  expect(result).not.toHaveProperty('evidenceBundle');
  expect(phases.fence).toHaveBeenCalledExactlyOnceWith(root, ['feature.test.ts']);
  expect(phases.prepare).not.toHaveBeenCalled();
  expect(phases.finish).not.toHaveBeenCalled();
});

it('retracts, rather than finishes, evidence prepared for a run the core then refused', async () => {
  // The probe started between the handler preflight and the core's own check.
  phases.fence.mockResolvedValueOnce(null).mockResolvedValueOnce(refusal);
  const prepared = [{ input: { evidenceRef: 'test-run-group:x:0' } }];
  phases.prepare.mockResolvedValue(prepared);
  phases.retract.mockResolvedValue({ status: 'not-recorded', reason: 'mutation_probe_active', retiredCount: 1, bindingIds: [9] });

  const { root, result } = await invoke();

  expect(result).toMatchObject({ ok: false, error: 'mutation_probe_active',
    evidenceBundle: { status: 'not-recorded', retiredCount: 1, bindingIds: [9] } });
  expect(phases.prepare).toHaveBeenCalledOnce();
  expect(phases.retract).toHaveBeenCalledExactlyOnceWith(prepared, result.runId,
    expect.objectContaining({ root, harnessSlug: 'refusal-harness', workspaceId: 'refusal-workspace' }), 'mutation_probe_active');
  expect(phases.finish).not.toHaveBeenCalled();
});

// WI-10005634: a test that would execute a restricted session's write is refused before launch,
// on the same pre-launch path (no evidence registered, prepared evidence retracted).
const restrictedRefusal = { error: 'restricted_write_held' as const, hint: 'feature.test.ts is itself a held restricted write' };

it('refuses before registering any evidence when the run would execute a held restricted write', async () => {
  phases.fence.mockResolvedValue(null);
  phases.restricted.mockResolvedValue(restrictedRefusal);

  const { root, result } = await invoke();

  expect(result).toMatchObject({ ok: false, root, error: 'restricted_write_held', hint: restrictedRefusal.hint });
  expect(result).not.toHaveProperty('evidenceBundle');
  expect(phases.restricted).toHaveBeenCalledExactlyOnceWith(root, ['feature.test.ts']);
  expect(phases.prepare).not.toHaveBeenCalled();
  expect(phases.finish).not.toHaveBeenCalled();
});

it('retracts prepared evidence when the core refuses a held restricted write', async () => {
  // The disclosure was delivered between the handler preflight and the core's own check.
  phases.fence.mockResolvedValue(null);
  phases.restricted.mockResolvedValueOnce(null).mockResolvedValueOnce(restrictedRefusal);
  const prepared = [{ input: { evidenceRef: 'test-run-group:y:0' } }];
  phases.prepare.mockResolvedValue(prepared);
  phases.retract.mockResolvedValue({ status: 'not-recorded', reason: 'restricted_write_held', retiredCount: 1, bindingIds: [4] });

  const { root, result } = await invoke();

  expect(result).toMatchObject({ ok: false, error: 'restricted_write_held',
    evidenceBundle: { status: 'not-recorded', retiredCount: 1, bindingIds: [4] } });
  expect(phases.retract).toHaveBeenCalledExactlyOnceWith(prepared, result.runId,
    expect.objectContaining({ root, harnessSlug: 'refusal-harness', workspaceId: 'refusal-workspace' }), 'restricted_write_held');
  expect(phases.finish).not.toHaveBeenCalled();
});
