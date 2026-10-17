import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareBudgetedTaskComparison, readBudgetedTaskComparisonArtifacts,
  type BudgetedTaskComparisonArtifactPins, type BudgetedTaskComparisonCohort } from '../../../../scripts/lib/budgeted-task-scheduler.mjs';
import type { RecordOperationalRunDeps } from '../agent-tools/testing/record-run';
import { executeGreenMainThroughputComparison } from './green-main-slo';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

// Exercise the real artifact reader, evaluator and native executor together.
// Only executor boundaries use fixtures: these are neither real benchmark cohorts
// nor a serving-runtime measurement or an operational acceptance receipt.
const boundary = vi.hoisted(() => ({
  snapshot: vi.fn(() => ({ commit: 'b'.repeat(40), porcelain: '' })),
  readRuntime: vi.fn(async () => 'c'.repeat(64)),
  verifyDefinition: vi.fn(async () => true),
  persist: vi.fn(async (_params: Parameters<RecordOperationalRunDeps['persist']>[0]) =>
    ({ written: 1, ids: [123] })),
}));
vi.mock('../agent-tools/testing/record-run', async importOriginal => {
  const actual = await importOriginal<typeof import('../agent-tools/testing/record-run')>();
  return { ...actual, executeOperationalRun: (
    definition: Parameters<typeof actual.executeOperationalRun>[0],
    ctx: Parameters<typeof actual.executeOperationalRun>[1],
  ) => actual.executeOperationalRun(definition, ctx, boundary) };
});

describe('native throughput wrapper artifact-to-executor integration', () => {
  let root: string;
  beforeEach(() => {
    vi.clearAllMocks();
    boundary.snapshot.mockImplementation(() => ({ commit: 'b'.repeat(40), porcelain: '' }));
    boundary.readRuntime.mockImplementation(async () => 'c'.repeat(64));
    root = mkdtempSync(join(tmpdir(), 'green-main-throughput-fixture-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function fixture(candidateExecutionMs = 50) {
    const pin = (ref: string, value: unknown, raw = false) => {
      const bytes = raw ? String(value) : JSON.stringify(value);
      writeFileSync(join(root, ref), bytes);
      return { ref, sha256: createHash('sha256').update(bytes).digest('hex') };
    };
    const files = ['long-fixture.test.ts', 'short-fixture.test.ts'];
    const sourceCommit = 'b'.repeat(40);
    const sourceFiles = files.map(path => ({ path, sha256: 'a'.repeat(64) }));
    const selection = pin('selection.json', { kind: 'full-gate', coverage: 'complete', unenumerated: [], files });
    const source = pin('source.json', { schemaVersion: 'verifier-source-v1', sourceCommit, files: sourceFiles });
    const dependencies = pin('dependencies.txt', 'fixture dependency bytes', true);
    const runtimeClosure = pin('closure.json', { status: 'complete', sourceCommit, files });
    const tasks = files.map((path, index) => ({ id: index === 0 ? 'long' : 'short', files: [path] }));
    const estimates = tasks.map((task, index) => {
      const ms = index === 0 ? 100 : 20;
      const original = pin(`${task.id}-wall.json`, { task: task.id, childWallMs: ms });
      return { task: task.id, ms, originalRef: original.ref, originalSha256: original.sha256 };
    });
    const policy = { workerBudget: 8, memoryBudgetMb: 32768, workerMemoryMb: 4096,
      maxConcurrentTasks: 2, reserveWorkers: 1, taskCgroupPidsMax: 32768 };
    const manifest = prepareBudgetedTaskComparison({
      selection: { kind: 'full-gate', coverage: 'complete', unenumerated: [], files,
        originalRef: selection.ref, originalSha256: selection.sha256 },
      source: { commit: sourceCommit, receiptSha256: source.sha256,
        dependencySha256: dependencies.sha256, runtimeClosureSha256: runtimeClosure.sha256, files: sourceFiles },
      tasks, baseline: policy, candidate: { ...policy, maxConcurrentTasks: 4 },
      envelope: { hardMemoryMb: 45056, pidsMax: 32768, heapMb: 4096 },
      estimates,
    });
    const cohorts = manifest.order.map((key, index) => {
      const [side, repeat] = key.split(':');
      const executionWallMs = side === 'baseline' ? 100 : candidateExecutionMs;
      const children = tasks.map(task => {
      const child = { task: task.id, lane: 'primary', files: task.files, code: 0, signal: null, childWallMs: 20,
        resultLine: 'TEST_FILE_RESULT status=passed requested=1 executed=1 matched=1 skippedTests=0 childSubstituted=0',
        expectedCgroup: '/fixture', runGroup: `fixture:group-${index}`, deadlineEpochMs: 1000,
        cgroupObservations: [{ pid: 123, cgroupPath: '/fixture', runGroup: `fixture:group-${index}`,
          deadlineEpochMs: 1000, vitestFork: true, phase: 'preload' }] };
      const originalChild = pin(`child-${index}-${task.id}.json`, child);
      return { ...child, originalRef: originalChild.ref, originalSha256: originalChild.sha256 };
      });
      return pin(`cohort-${index}.json`, {
        side, repeat: Number(repeat), runId: `fixture:run-${index}`, manifestSha256: manifest.manifestSha256,
        sourceUnchanged: true, sourceReceiptSha256: source.sha256,
        dependencySha256: dependencies.sha256, runtimeClosureSha256: runtimeClosure.sha256,
        policy: side === 'baseline' ? manifest.baseline : manifest.candidate, envelope: manifest.envelope,
        wallMs: executionWallMs + 30, acquiredWaitsMs: [10, 20], executionWallMs,
        memory: { pairedSamples: 3, maxAnonPerAllocatedWorkerMb: 300, oomKills: 0 },
        stats: { memoryReadings: 2, lastMemAvailableMb: 40000,
          observedMaxWorkers: 8, observedMaxTasks: side === 'baseline' ? 1 : 2, observedMaxMemoryMb: 32768 },
        children,
      });
    });
    const pins: BudgetedTaskComparisonArtifactPins = {
      manifest: pin('manifest.json', manifest), source, dependencies, runtimeClosure, cohorts,
    };
    return { workspaceId: 'workspace-fixture', harnessSlug: 'papercusp', projectDir: REPO_ROOT,
      runtimeUnits: ['fixture-runtime'], evidenceRoot: root, pins };
  }

  it('retains the original artifact scope and independently bracketed native execution fields', async () => {
    const args = fixture();
    const original = await readBudgetedTaskComparisonArtifacts(root, args.pins);
    expect(await executeGreenMainThroughputComparison(args)).toMatchObject({
      ok: true, status: 'pass', testRunIds: [123], runtimeEnvironmentMeasured: true,
    });
    const receipt = boundary.persist.mock.calls[0]![0];
    expect(receipt.runGroupId).toMatch(/^operational-native:/);
    expect(receipt).toMatchObject({ workspaceId: args.workspaceId, harnessSlug: args.harnessSlug,
      commit: 'b'.repeat(40), worktreeDirty: false });
    expect(receipt.rows[0]).toMatchObject({ filePath: 'packages/operator-core/lib/release/green-main-slo.ts',
      status: 'pass', execution: { passed: 4, failed: 0, skipped: 0,
        operational: { schemaVersion: 1, command: ['executeGreenMainThroughputComparison',
          args.workspaceId, args.harnessSlug, root, args.pins.manifest.ref, args.pins.manifest.sha256,
          args.pins.source.ref, args.pins.dependencies.ref, args.pins.runtimeClosure.ref,
          ...args.pins.cohorts.flatMap(pin => [pin.ref, pin.sha256])] },
        runtimeEnvironmentBefore: { units: ['fixture-runtime'], fingerprint: 'c'.repeat(64) },
        runtimeEnvironmentAfter: { units: ['fixture-runtime'], fingerprint: 'c'.repeat(64) } } });
    expect(receipt.rows[0]!.outputTail).toContain(`original_population_sha256=${original.populationSha256}`);
    expect(receipt.rows[0]!.outputTail).toContain('ratio=0.5');
    expect(receipt.rows[0]!.outputTail).toContain('statistical semantics await');
    expect(boundary.verifyDefinition).toHaveBeenCalledWith(REPO_ROOT,
      'packages/operator-core/lib/release/green-main-slo.ts', 'b'.repeat(40));
    expect(boundary.snapshot).toHaveBeenCalledTimes(2);
    expect(boundary.readRuntime).toHaveBeenCalledTimes(2);
  });

  it('detaches nested cohort pins and scope before asynchronous executor checks', async () => {
    const args = fixture();
    const original = await readBudgetedTaskComparisonArtifacts(root, args.pins);
    const originalPin = structuredClone(args.pins.cohorts[0]!);
    boundary.snapshot.mockImplementationOnce(() => {
      args.pins.cohorts[0]!.ref = 'not-the-original-cohort.json';
      args.evidenceRoot = join(root, 'not-the-original-root');
      args.workspaceId = 'different-workspace';
      args.runtimeUnits.push('different-runtime');
      return { commit: 'b'.repeat(40), porcelain: '' };
    });
    expect(await executeGreenMainThroughputComparison(args)).toMatchObject({ ok: true, status: 'pass' });
    const receipt = boundary.persist.mock.calls[0]![0];
    expect(receipt.workspaceId).toBe('workspace-fixture');
    expect(receipt.rows[0]!.outputTail).toContain(`original_population_sha256=${original.populationSha256}`);
    expect(receipt.rows[0]!.execution).toMatchObject({ operational: {
      command: expect.arrayContaining([originalPin.ref, originalPin.sha256, root, 'workspace-fixture']),
    } });
    expect(boundary.readRuntime).toHaveBeenNthCalledWith(1, ['fixture-runtime'], 'workspace-fixture');
  });

  it('records failed qualification rather than promoting a slower original candidate', async () => {
    expect(await executeGreenMainThroughputComparison(fixture(51))).toMatchObject({ ok: true, status: 'fail' });
    const receipt = boundary.persist.mock.calls[0]![0];
    expect(receipt.rows[0]!.execution).toMatchObject({ passed: 3, failed: 1, skipped: 0,
      failedCaseTitles: ['full-identical-file-set-at-most-half-baseline-wall'] });
    expect(receipt.rows[0]!.outputTail).toContain('ratio=0.51');
  });

  it('records original child byte drift as a native exception with no fabricated population hash', async () => {
    const args = fixture();
    writeFileSync(join(root, 'child-1-long.json'), '{}');
    expect(await executeGreenMainThroughputComparison(args)).toMatchObject({ ok: true, status: 'fail' });
    const receipt = boundary.persist.mock.calls[0]![0];
    expect(receipt.rows[0]!.execution).toMatchObject({ passed: 0, failed: 1, skipped: 0,
      failedCaseTitles: ['native-check-exception'] });
    expect(receipt.rows[0]!.outputTail).toContain('Original artifact hash mismatch: child-1-long.json');
    expect(receipt.rows[0]!.outputTail).not.toContain('original_population_sha256=');
  });

  function repinCohort(args: ReturnType<typeof fixture>, index: number,
    change: (cohort: BudgetedTaskComparisonCohort) => void) {
    const pin = args.pins.cohorts[index]!;
    const cohort = JSON.parse(readFileSync(join(root, pin.ref), 'utf8')) as BudgetedTaskComparisonCohort;
    change(cohort);
    // Re-pin both levels: a rejected cohort must reach policy qualification, rather than
    // accidentally exercising the unrelated original-byte mismatch guard.
    for (const child of cohort.children) {
      const { originalRef, originalSha256: _oldHash, ...fields } = child;
      const bytes = JSON.stringify(fields);
      writeFileSync(join(root, originalRef), bytes);
      child.originalSha256 = createHash('sha256').update(bytes).digest('hex');
    }
    const bytes = JSON.stringify(cohort);
    writeFileSync(join(root, pin.ref), bytes);
    args.pins.cohorts[index] = { ref: pin.ref, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  async function expectUnqualified(args: ReturnType<typeof fixture>) {
    const original = await readBudgetedTaskComparisonArtifacts(args.evidenceRoot, args.pins);
    expect(original.originalArtifactsResolved).toBe(true);
    expect(original.cohorts[1]!.executionWallMs / original.cohorts[0]!.executionWallMs).toBe(0.5);
    expect(await executeGreenMainThroughputComparison(args)).toMatchObject({ ok: true, status: 'fail' });
    const receipt = boundary.persist.mock.calls[0]![0];
    expect(receipt.rows[0]!.execution).toMatchObject({ passed: 2, failed: 2, skipped: 0,
      failedCaseTitles: ['unchanged-contained-no-skip-paired-headroom-longest-first-cohorts',
        'full-identical-file-set-at-most-half-baseline-wall'] });
    expect(receipt.rows[0]!.outputTail).toContain(`original_population_sha256=${original.populationSha256}`);
  }

  it.each([1, 2])('rejects candidate repeat at cohort %i without measured concurrency growth', async index => {
    const args = fixture();
    repinCohort(args, index, cohort => { cohort.stats.observedMaxTasks = 1; });
    await expectUnqualified(args);
  });

  it('rejects a persisted candidate policy that falls back to the baseline task ceiling', async () => {
    const args = fixture();
    repinCohort(args, 1, cohort => { cohort.policy.maxConcurrentTasks = 2; });
    await expectUnqualified(args);
  });

  it('rejects shortest-first candidate scheduling even when the wall ratio passes', async () => {
    const args = fixture();
    repinCohort(args, 1, cohort => { cohort.children.reverse(); });
    await expectUnqualified(args);
  });

  it('rejects raised concurrency beyond the measured memory budget', async () => {
    const args = fixture();
    repinCohort(args, 1, cohort => { cohort.stats.observedMaxMemoryMb = 32769; });
    await expectUnqualified(args);
  });

  it('rejects a raised-concurrency cohort with a memory-admission refusal', async () => {
    const args = fixture();
    repinCohort(args, 1, cohort => {
      cohort.children[0]!.code = 75;
      cohort.children[0]!.resultLine = 'TASK_BUDGET_REFUSAL kind=memory requested=32768 available=16384';
    });
    await expectUnqualified(args);
  });
});
