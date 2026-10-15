import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { runGymPipeline } from '../gym-runner';
import type { GymOracleRun, GymRunnerPorts, GymRunSpec } from '../gym-runner';

/**
 * The runner orchestrates one hermetic run: clone → register throwaway harness →
 * apply variant overlay → file feature → start pipeline → poll to terminal. All
 * effects are injected, so the SEQUENCING + teardown-on-setup-failure logic is
 * tested with fakes (no live operator, no real agents). Artifacts are NOT torn
 * down by the runner — the trace collector (P-002) reads the clone + schema after.
 */
function makeSpec(overrides: Partial<GymRunSpec> = {}): GymRunSpec {
  return {
    task: {
      id: 'task-1',
      source: '/repos/substrate',
      commit: '0123456789abcdef0123456789abcdef01234567',
      spec: 'Add a /health endpoint',
      intent: 'Operators need a liveness probe',
    },
    variant: { id: 'baseline', overlay: { promptOverrides: {} } },
    cycle: 0,
    harnessCommit: 'fedcba9876543210fedcba9876543210fedcba98',
    workspaceId: 'gym-ws',
    scratchRoot: '/scratch/gym/clones',
    timeoutMs: 1000,
    pollIntervalMs: 100,
    ...overrides,
  };
}

interface FakeOpts {
  poll: Array<{ workflowStatus: string; featureStatus: string | null }>;
  throwOn?: keyof GymRunnerPorts;
}

function makePorts(opts: FakeOpts) {
  const calls: string[] = [];
  const overrideOps: Array<{ role: string; promptMd: string }> = [];
  let clock = 0;
  let pollIdx = 0;
  const maybeThrow = (name: keyof GymRunnerPorts) => {
    calls.push(name);
    if (opts.throwOn === name) throw new Error(`boom:${name}`);
  };
  const ports: GymRunnerPorts = {
    async cloneSubstrate() { maybeThrow('cloneSubstrate'); },
    async registerThrowawayHarness() { maybeThrow('registerThrowawayHarness'); },
    async applyPromptOverride(i) { maybeThrow('applyPromptOverride'); overrideOps.push({ role: i.role, promptMd: i.promptMd }); },
    async fileFeature() { maybeThrow('fileFeature'); },
    async startPipeline() { maybeThrow('startPipeline'); return { workflowID: 'pipeline:gym-x:F-GYM-AA:e0' }; },
    async pollStatus() {
      maybeThrow('pollStatus');
      const snap = opts.poll[Math.min(pollIdx, opts.poll.length - 1)];
      pollIdx++;
      return snap;
    },
    async teardownHarness() { maybeThrow('teardownHarness'); },
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
  };
  return { ports, calls, overrideOps };
}

function oracleExecution(implementationHash = 'b'.repeat(64)) {
  return { command: ['npm', 'run', 'test:file', '--', 'oracle.test.js', '--', '--reporter=json'],
    cwd: '/scratch/gym', report: '{}', unresolved: ['fixture-runtime'],
    npmManifest: { path: 'package.json', sourceHashes: {
      pinned: 'd'.repeat(64), before: 'd'.repeat(64), after: 'd'.repeat(64),
    } } as { path: string; sourceHashes: { pinned: string | null; before: string | null; after: string | null } } | undefined,
    configSources: { reference: { pinCommit: makeSpec().harnessCommit,
      sources: [{ path: 'vitest.config.ts', sha256: 'e'.repeat(64) }] },
      loaded: { schemaVersion: 'node-loaded-config-sources-v1', scope: 'repository-vite-config-dependencies',
        basis: 'node-load-hook', status: 'stable', reasons: [],
        sources: [{ path: 'vitest.config.ts', sha256: 'e'.repeat(64), currentSha256: 'e'.repeat(64) }] },
      evidence: { schemaVersion: 'vitest-config-disk-snapshots-v1', scope: 'repository-vite-config-dependencies',
        basis: 'reporter-init-disk', status: 'unchanged', reasons: [],
        sources: [{ path: 'vitest.config.ts', sha256: 'e'.repeat(64), currentSha256: 'e'.repeat(64) }] },
    } as NonNullable<GymOracleRun['execution']>['configSources'],
    mainProcessSources: { reference: { pinCommit: makeSpec().harnessCommit,
      sources: [{ path: 'libs/runner-support/index.mjs', sha256: 'f'.repeat(64) }] },
      evidence: { schemaVersion: 'node-loaded-main-process-sources-v1', scope: 'repository-node-main-process-sources',
        basis: 'node-load-hook', status: 'stable', reasons: [] as string[],
        sources: [{ path: 'libs/runner-support/index.mjs', sha256: 'f'.repeat(64), currentSha256: 'f'.repeat(64) }] },
    } as { reference: { pinCommit: string; sources: Array<{ path: string; sha256: string | null }> };
      evidence: { schemaVersion: string; scope: string; basis: string; status: string; reasons: string[];
        sources: Array<{ path: string; sha256: string | null; currentSha256: string | null }> } } | undefined,
    exitCode: 0, signal: null,
    commandProcessSources: { report: '{}', unresolved: ['node-process-descendant-population-unmeasured'],
      reference: { pinCommit: makeSpec().harnessCommit, sources: [{ path: 'scripts/command.mjs', sha256: '1'.repeat(64) }] },
      processes: [{ schemaVersion: 'node-loaded-process-sources-v1', scope: 'repository-node-process-sources',
        basis: 'node-load-hook', status: 'stable', entrypoint: 'scripts/command.mjs', pid: 123, parentPid: 122, exitCode: 0,
        reasons: [], unresolved: ['node-process-descendant-population-unmeasured'],
        sources: [{ path: 'scripts/command.mjs', sha256: '1'.repeat(64), currentSha256: '1'.repeat(64) }] }],
    } as NonNullable<GymOracleRun['execution']>['commandProcessSources'],
    workerSources: { report: '{}', reference: { pinCommit: makeSpec().harnessCommit, sources: [
      { path: 'oracle.test.js', sha256: 'a'.repeat(64) }, { path: 'impl.js', sha256: 'b'.repeat(64) },
    ] } as { pinCommit: string; sources: Array<{ path: string; sha256: string | null }> } | undefined,
    modules: [{ testFile: 'oracle.test.js', state: 'passed', sourceEvidence: {
      schemaVersion: 'vite-collected-source-evidence-v1', scope: 'repository-worker-vite-original-sources',
      status: 'stable', reasons: [] as string[], sources: [{ path: 'oracle.test.js',
        sha256: 'a'.repeat(64), currentSha256: 'a'.repeat(64) },
      { path: 'impl.js', sha256: implementationHash, currentSha256: implementationHash }],
    } }] } };
}

describe('runGymPipeline', () => {
  it('keeps the original task and variant when the caller mutates them during an awaited clone', async () => {
    const spec = makeSpec({
      task: { ...makeSpec().task, oracle: {
        testPath: 'original.test.ts', implPath: 'original.ts',
        pinCommit: 'a'.repeat(40), sourceRef: 'WI-ORIGINAL',
      } },
      variant: { id: 'challenger', overlay: { promptOverrides: { worker: 'original overlay' } } },
    });
    const original = structuredClone(spec);
    const { ports } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
    const filed: Parameters<GymRunnerPorts['fileFeature']>[0][] = [];
    const oracles: Parameters<NonNullable<GymRunnerPorts['runOracle']>>[0][] = [];
    ports.cloneSubstrate = async () => {
      await Promise.resolve();
      spec.task.id = 'replacement';
      spec.task.spec = 'replacement spec';
      spec.task.intent = 'replacement intent';
      spec.task.oracle!.testPath = 'replacement.test.ts';
      spec.task.oracle!.pinCommit = 'b'.repeat(40);
      spec.variant.id = 'replacement';
      spec.variant.overlay.promptOverrides.worker = 'replacement overlay';
      spec.harnessCommit = 'c'.repeat(40);
    };
    ports.fileFeature = async (input) => { filed.push(input); };
    ports.runOracle = async (input) => {
      oracles.push(input);
      return { results: [{ name: 'original assertion', passed: true }],
        testPath: input.testPath, pinCommit: input.pinCommit!,
        sourceHashes: { pinned: 'd'.repeat(64), before: 'd'.repeat(64), after: 'd'.repeat(64) },
        implementation: { path: input.implPath!, before: 'e'.repeat(64), after: 'e'.repeat(64) },
        execution: oracleExecution() };
    };
    const result = await runGymPipeline(spec, ports);
    expect(filed).toEqual([expect.objectContaining({ spec: original.task.spec, intent: original.task.intent })]);
    expect(oracles).toHaveLength(2);
    expect(oracles.every((v) => v.testPath === original.task.oracle!.testPath && v.pinCommit === original.task.oracle!.pinCommit &&
      v.implPath === original.task.oracle!.implPath)).toBe(true);
    expect(result.runKey).toMatchObject({ taskId: original.task.id, variantId: original.variant.id });
    expect(result.deterministicSignals?.executionInput).toEqual({
      task: original.task, variant: original.variant, harnessCommit: original.harnessCommit,
      taskHash: createHash('sha256').update(JSON.stringify(original.task)).digest('hex'),
      variantHash: createHash('sha256').update(JSON.stringify(original.variant)).digest('hex'),
    });
  });

  it('retains input provenance without inferring task success or code identity from it', async () => {
    const spec = makeSpec();
    const { ports } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
    const result = await runGymPipeline(spec, ports);
    expect(result.deterministicSignals?.executionInput).toMatchObject({
      task: spec.task, variant: spec.variant, harnessCommit: spec.harnessCommit,
    });
    expect(result.deterministicSignals).not.toHaveProperty('taskPassed');
    expect(result.deterministicSignals).not.toHaveProperty('regressions');
    expect(result.deterministicSignals).not.toHaveProperty('codeHash');
    spec.task.spec = 'changed after return';
    expect(result.deterministicSignals?.executionInput).toMatchObject({ task: { spec: 'Add a /health endpoint' } });
  });

  it('runs the full setup sequence then polls to a terminal outcome', async () => {
    const { ports, calls } = makePorts({
      poll: [{ workflowStatus: 'PENDING', featureStatus: 'in_progress' }, { workflowStatus: 'SUCCESS', featureStatus: 'passed' }],
    });
    const result = await runGymPipeline(makeSpec(), ports);

    expect(result.outcome).toBe('passed');
    expect(result.terminal).toBe(true);
    expect(result.workflowID).toBe('pipeline:gym-x:F-GYM-AA:e0');
    expect(result.harnessSlug).toMatch(/^gym[a-z0-9]+$/); // hyphen-free (valid PG schema)
    expect(result.clonePath).toBe(`/scratch/gym/clones/${result.harnessSlug}`);
    // Setup happens before the first poll; the runner does NOT tear down.
    expect(calls.slice(0, 5)).toEqual([
      'cloneSubstrate', 'registerThrowawayHarness', 'fileFeature', 'startPipeline', 'pollStatus',
    ]);
    expect(calls).not.toContain('teardownHarness');
  });

  it('applies one prompt-override op per overridden role', async () => {
    const { ports, calls, overrideOps } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
    await runGymPipeline(
      makeSpec({ variant: { id: 'cand', overlay: { promptOverrides: { worker: '# w2', validator: '# v2' } } } }),
      ports,
    );
    expect(overrideOps).toEqual([
      { role: 'validator', promptMd: '# v2' },
      { role: 'worker', promptMd: '# w2' },
    ]);
    expect(calls.filter((c) => c === 'applyPromptOverride')).toHaveLength(2);
  });

  it('applies NO overrides for the baseline (empty overlay)', async () => {
    const { ports, calls } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
    await runGymPipeline(makeSpec(), ports);
    expect(calls).not.toContain('applyPromptOverride');
  });

  it('returns timeout when the pipeline never terminates within the deadline', async () => {
    const { ports } = makePorts({ poll: [{ workflowStatus: 'PENDING', featureStatus: 'in_progress' }] });
    const result = await runGymPipeline(makeSpec({ timeoutMs: 300, pollIntervalMs: 100 }), ports);
    expect(result.outcome).toBe('timeout');
    expect(result.terminal).toBe(true);
  });

  it('measures the immutable oracle before and after the pipeline and emits regressions only when both are measured', async () => {
    const { ports } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
    let oracleRun = 0;
    ports.runOracle = async ({ testPath, pinCommit, implPath }) => {
      oracleRun += 1;
      return { results: [{ name: 'oracle > preserves behaviour', passed: oracleRun === 1 }],
        testPath, pinCommit: pinCommit!,
        sourceHashes: { pinned: 'a'.repeat(64), before: 'a'.repeat(64), after: 'a'.repeat(64) },
        implementation: { path: implPath!, before: 'b'.repeat(64), after: 'b'.repeat(64) },
        execution: oracleExecution() };
    };

    const result = await runGymPipeline(
      makeSpec({
        task: {
          ...makeSpec().task,
          oracle: {
            testPath: 'oracle.test.js',
            implPath: 'impl.js',
            pinCommit: 'fedcba9876543210fedcba9876543210fedcba98',
            sourceRef: 'WI-ORACLE',
          },
        },
      }),
      ports,
    );

    expect(oracleRun).toBe(2);
    expect(result.deterministicSignals).toMatchObject({ regressions: true, taskPassed: false,
      oracle: { sourceCurrent: true, populationComplete: true } });
  });

  it('tears down on a setup failure and never starts the pipeline', async () => {
    const { ports, calls } = makePorts({
      poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }],
      throwOn: 'registerThrowawayHarness',
    });
    await expect(runGymPipeline(makeSpec(), ports)).rejects.toThrow(/boom:registerThrowawayHarness/);
    expect(calls).toContain('teardownHarness');
    expect(calls).not.toContain('startPipeline');
  });

  it('does not report no regression from an incomplete post-oracle', async () => {
    const { ports } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
    let run = 0;
    ports.runOracle = async () => ++run === 1
      ? [{ name: 'kept', passed: true }, { name: 'missing', passed: true }]
      : [{ name: 'kept', passed: true }];
    const result = await runGymPipeline(makeSpec({ task: { ...makeSpec().task,
      oracle: { testPath: 'oracle.test.js', implPath: 'impl.js',
        pinCommit: makeSpec().harnessCommit, sourceRef: 'WI-ORACLE' } } }), ports);
    expect(result.deterministicSignals?.regressions).toBeUndefined();
  });

  it.each(['before', 'after', 'pinned'] as const)('withholds objective/regression authority when oracle %s bytes changed', async (field) => {
    const { ports } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
    let run = 0;
    ports.runOracle = async ({ testPath, pinCommit, implPath }) => ({
      results: [{ name: 'oracle', passed: true }], testPath, pinCommit: pinCommit!,
      sourceHashes: { pinned: 'a'.repeat(64), before: 'a'.repeat(64), after: 'a'.repeat(64),
        ...( ++run === 2 ? { [field]: 'b'.repeat(64) } : {} ) },
      implementation: { path: implPath!, before: 'c'.repeat(64), after: 'c'.repeat(64) },
      execution: oracleExecution(),
    });
    const result = await runGymPipeline(makeSpec({ task: { ...makeSpec().task,
      oracle: { testPath: 'oracle.test.js', implPath: 'impl.js',
        pinCommit: makeSpec().harnessCommit, sourceRef: 'WI-ORACLE' } } }), ports);
    expect(result.deterministicSignals?.regressions).toBeUndefined();
    expect(result.deterministicSignals?.taskPassed).toBeUndefined();
    expect(result.deterministicSignals?.oracle).toMatchObject({ sourceCurrent: false });
  });

  it.each(['missing', 'skipped', 'duplicate', 'added'] as const)('withholds a pass when oracle coverage is %s', async (mode) => {
    const { ports } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
    let run = 0;
    ports.runOracle = async ({ testPath, pinCommit, implPath }) => {
      const results = ++run === 1 ? [{ name: 't1', passed: true }, { name: 't2', passed: true }] :
        mode === 'missing' ? [{ name: 't1', passed: true }] :
        mode === 'skipped' ? [{ name: 't1', passed: true }, { name: 't2', passed: false, executed: false }] :
        mode === 'added' ? [{ name: 't1', passed: true }, { name: 't2', passed: true }, { name: 't3', passed: true }] :
        [{ name: 't1', passed: true }, { name: 't1', passed: true }];
      return { results, testPath, pinCommit: pinCommit!,
        sourceHashes: { pinned: 'a'.repeat(64), before: 'a'.repeat(64), after: 'a'.repeat(64) },
        implementation: { path: implPath!, before: 'b'.repeat(64), after: 'b'.repeat(64) },
        execution: oracleExecution() };
    };
    const result = await runGymPipeline(makeSpec({ task: { ...makeSpec().task,
      oracle: { testPath: 'oracle.test.js', implPath: 'impl.js',
        pinCommit: makeSpec().harnessCommit, sourceRef: 'WI-ORACLE' } } }), ports);
    expect(result.deterministicSignals?.regressions).toBeUndefined();
    expect(result.deterministicSignals?.taskPassed).toBeUndefined();
    expect(result.deterministicSignals?.oracle).toMatchObject({ populationComplete: false });
  });

  it('records complete executed task recovery without inventing probe or rollback evidence', async () => {
    const { ports } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
    let run = 0;
    ports.runOracle = async ({ testPath, pinCommit, implPath }) => ({
      results: [{ name: 'task', passed: ++run > 1 }, { name: 'preserved', passed: true }], testPath, pinCommit: pinCommit!,
      sourceHashes: { pinned: 'a'.repeat(64), before: 'a'.repeat(64), after: 'a'.repeat(64) },
      implementation: { path: implPath!, before: run === 1 ? 'b'.repeat(64) : 'c'.repeat(64),
        after: run === 1 ? 'b'.repeat(64) : 'c'.repeat(64) },
      execution: oracleExecution((run === 1 ? 'b' : 'c').repeat(64)),
    });
    const result = await runGymPipeline(makeSpec({ task: { ...makeSpec().task,
      oracle: { testPath: 'oracle.test.js', implPath: 'impl.js',
        pinCommit: makeSpec().harnessCommit, sourceRef: 'WI-ORACLE' } } }), ports);
    expect(result.deterministicSignals).toMatchObject({ regressions: false, taskPassed: true,
      oracle: { sourceCurrent: true, implementationCurrent: true, populationComplete: true, sourceRef: 'WI-ORACLE',
        pre: { results: [{ name: 'task', passed: false }, { name: 'preserved', passed: true }] },
        post: { results: [{ name: 'task', passed: true }, { name: 'preserved', passed: true }] } } });
    expect(result.deterministicSignals).not.toHaveProperty('planted_bug_caught');
    expect(result.deterministicSignals).not.toHaveProperty('rollback');
  });

  it('does not confuse task recovery with measured regression coverage when no prior tests were green', async () => {
    const { ports } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
    let run = 0;
    ports.runOracle = async ({ testPath, pinCommit, implPath }) => ({
      results: [{ name: 'task', passed: ++run > 1 }], testPath, pinCommit: pinCommit!,
      sourceHashes: { pinned: 'a'.repeat(64), before: 'a'.repeat(64), after: 'a'.repeat(64) },
      implementation: { path: implPath!, before: 'b'.repeat(64), after: 'b'.repeat(64) },
      execution: oracleExecution(),
    });
    const result = await runGymPipeline(makeSpec({ task: { ...makeSpec().task,
      oracle: { testPath: 'oracle.test.js', implPath: 'impl.js',
        pinCommit: makeSpec().harnessCommit, sourceRef: 'WI-ORACLE' } } }), ports);
    expect(result.deterministicSignals?.taskPassed).toBe(true);
    expect(result.deterministicSignals?.regressions).toBeUndefined();
    expect(result.deterministicSignals?.oracle).toMatchObject({ regressionPopulation: 0 });
  });

  it.each(['missing', 'changed', 'unknown', 'wrong-file', 'wrong-scope', 'helper-changed-between-runs'] as const)(
    'withholds positive claims when collected worker sources are %s', async (mode) => {
      const { ports } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
      let run = 0;
      ports.runOracle = async ({ testPath, pinCommit, implPath }) => {
        const execution = oracleExecution();
        run += 1;
        if (mode === 'missing') execution.workerSources.modules = [];
        else if (mode === 'wrong-file') execution.workerSources.modules[0]!.testFile = 'other.test.js';
        else if (mode === 'wrong-scope') execution.workerSources.modules[0]!.sourceEvidence.scope = 'checkout-at-end';
        else if (mode === 'helper-changed-between-runs') {
          const hash = (run === 1 ? 'b' : 'c').repeat(64);
          execution.workerSources.modules[0]!.sourceEvidence.sources.push({
            path: 'oracle-helper.js', sha256: hash, currentSha256: hash,
          });
        } else execution.workerSources.modules[0]!.sourceEvidence.status = mode;
        return { results: [{ name: 'task', passed: true }], testPath, pinCommit: pinCommit!,
          sourceHashes: { pinned: 'a'.repeat(64), before: 'a'.repeat(64), after: 'a'.repeat(64) },
          implementation: { path: implPath!, before: 'b'.repeat(64), after: 'b'.repeat(64) }, execution };
      };
      const result = await runGymPipeline(makeSpec({ task: { ...makeSpec().task,
        oracle: { testPath: 'oracle.test.js', implPath: 'impl.js',
          pinCommit: makeSpec().harnessCommit, sourceRef: 'WI-ORACLE' } } }), ports);
      expect(result.deterministicSignals?.taskPassed).toBeUndefined();
      expect(result.deterministicSignals?.regressions).toBeUndefined();
      expect(result.deterministicSignals?.oracle).toMatchObject({ workerSourcesCurrent: false });
    });

  it.each(['missing-reference', 'wrong-commit', 'changed-helper', 'unknown-helper', 'omitted-helper', 'duplicate-reference',
    'missing-implementation', 'wrong-implementation'] as const)(
    'withholds positive claims when immutable worker source provenance has %s', async (mode) => {
      const { ports } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
      ports.runOracle = async ({ testPath, pinCommit, implPath }) => {
        const execution = oracleExecution();
        const sources = execution.workerSources.modules[0]!.sourceEvidence.sources;
        const reference = execution.workerSources.reference!;
        sources.push({ path: 'helper.js', sha256: 'c'.repeat(64), currentSha256: 'c'.repeat(64) });
        reference.sources.push({ path: 'helper.js', sha256: 'c'.repeat(64) });
        if (mode === 'missing-reference') execution.workerSources.reference = undefined;
        else if (mode === 'wrong-commit') reference.pinCommit = 'd'.repeat(40);
        else if (mode === 'changed-helper') reference.sources[2]!.sha256 = 'd'.repeat(64);
        else if (mode === 'unknown-helper') reference.sources[2]!.sha256 = null;
        else if (mode === 'omitted-helper') reference.sources.pop();
        else if (mode === 'duplicate-reference') reference.sources.push({ ...reference.sources[2]! });
        else if (mode === 'missing-implementation') sources.splice(1, 1);
        else sources[1] = { path: 'impl.js', sha256: 'd'.repeat(64), currentSha256: 'd'.repeat(64) };
        return { results: [{ name: 'task', passed: true }, { name: 'preserved', passed: true }],
          testPath, pinCommit: pinCommit!, sourceHashes: {
            pinned: 'a'.repeat(64), before: 'a'.repeat(64), after: 'a'.repeat(64),
          }, implementation: { path: implPath!, before: 'b'.repeat(64), after: 'b'.repeat(64) }, execution };
      };
      const result = await runGymPipeline(makeSpec({ task: { ...makeSpec().task,
        oracle: { testPath: 'oracle.test.js', implPath: 'impl.js',
          pinCommit: makeSpec().harnessCommit, sourceRef: 'WI-ORACLE' } } }), ports);
      expect(result.deterministicSignals?.taskPassed).toBeUndefined();
      expect(result.deterministicSignals?.regressions).toBeUndefined();
      expect(result.deterministicSignals?.oracle).toMatchObject({ workerSourcesCurrent: false });
    });

  it.each(['missing', 'missing-hashes', 'malformed', 'unknown', 'changed-during-run', 'changed-from-pin', 'wrong-path',
    'changed-between-runs', 'wrong-command'] as const)(
    'withholds positive claims when the npm command manifest is %s', async (mode) => {
      const { ports } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
      let run = 0;
      ports.runOracle = async ({ testPath, pinCommit, implPath }) => {
        const execution = oracleExecution();
        run += 1;
        if (mode === 'missing') execution.npmManifest = undefined;
        else if (mode === 'missing-hashes') Object.assign(execution.npmManifest!, { sourceHashes: undefined });
        else if (mode === 'malformed') execution.npmManifest!.sourceHashes.pinned = 'not-a-digest';
        else if (mode === 'unknown') execution.npmManifest!.sourceHashes.pinned = null;
        else if (mode === 'changed-during-run') execution.npmManifest!.sourceHashes.after = 'e'.repeat(64);
        else if (mode === 'changed-from-pin') {
          execution.npmManifest!.sourceHashes.before = 'e'.repeat(64);
          execution.npmManifest!.sourceHashes.after = 'e'.repeat(64);
        } else if (mode === 'wrong-path') execution.npmManifest!.path = 'other/package.json';
        else if (mode === 'changed-between-runs' && run === 2) {
          execution.npmManifest!.sourceHashes = { pinned: 'e'.repeat(64), before: 'e'.repeat(64), after: 'e'.repeat(64) };
        } else if (mode === 'wrong-command') execution.command[0] = 'node';
        return { results: [{ name: 'task', passed: true }, { name: 'preserved', passed: true }],
          testPath, pinCommit: pinCommit!, sourceHashes: {
            pinned: 'a'.repeat(64), before: 'a'.repeat(64), after: 'a'.repeat(64),
          }, implementation: { path: implPath!, before: 'b'.repeat(64), after: 'b'.repeat(64) }, execution };
      };
      const result = await runGymPipeline(makeSpec({ task: { ...makeSpec().task,
        oracle: { testPath: 'oracle.test.js', implPath: 'impl.js',
          pinCommit: makeSpec().harnessCommit, sourceRef: 'WI-ORACLE' } } }), ports);
      expect(result.deterministicSignals?.taskPassed).toBeUndefined();
      expect(result.deterministicSignals?.regressions).toBeUndefined();
      expect(result.deterministicSignals?.oracle).toMatchObject({ npmManifestCurrent: false });
    });

  it.each(['missing', 'unknown', 'changed', 'unpinned', 'missing-reference', 'wrong-basis', 'duplicate',
    'changed-between-runs'] as const)('withholds positive claims when config snapshots are %s', async (mode) => {
    const { ports } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
    let run = 0;
    ports.runOracle = async ({ testPath, pinCommit, implPath }) => {
      const execution = oracleExecution();
      run += 1;
      const measured = execution.configSources!;
      if (mode === 'missing') execution.configSources = undefined;
      else if (mode === 'unknown') measured.evidence!.status = 'unknown';
      else if (mode === 'changed') measured.evidence!.sources[0]!.currentSha256 = 'f'.repeat(64);
      else if (mode === 'unpinned') measured.reference.sources[0]!.sha256 = null;
      else if (mode === 'missing-reference') Object.assign(measured, { reference: undefined });
      else if (mode === 'wrong-basis') measured.evidence!.basis = 'after-run-disk';
      else if (mode === 'duplicate') measured.evidence!.sources.push({ ...measured.evidence!.sources[0]! });
      else if (mode === 'changed-between-runs' && run === 2) {
        measured.evidence!.sources.push({ path: 'other.config.ts', sha256: 'f'.repeat(64), currentSha256: 'f'.repeat(64) });
        measured.reference.sources.push({ path: 'other.config.ts', sha256: 'f'.repeat(64) });
      }
      return { results: [{ name: 'task', passed: true }, { name: 'preserved', passed: true }],
        testPath, pinCommit: pinCommit!, sourceHashes: {
          pinned: 'a'.repeat(64), before: 'a'.repeat(64), after: 'a'.repeat(64),
        }, implementation: { path: implPath!, before: 'b'.repeat(64), after: 'b'.repeat(64) }, execution };
    };
    const result = await runGymPipeline(makeSpec({ task: { ...makeSpec().task,
      oracle: { testPath: 'oracle.test.js', implPath: 'impl.js',
        pinCommit: makeSpec().harnessCommit, sourceRef: 'WI-ORACLE' } } }), ports);
    expect(result.deterministicSignals?.taskPassed).toBeUndefined();
    expect(result.deterministicSignals?.regressions).toBeUndefined();
    expect(result.deterministicSignals?.oracle).toMatchObject({ configSnapshotsCurrent: false });
  });

  it.each(['missing', 'unknown', 'changed', 'unpinned', 'wrong-basis', 'duplicate', 'missing-source',
    'changed-between-runs'] as const)('withholds positive claims when originally loaded config is %s', async (mode) => {
    const { ports } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
    let run = 0;
    ports.runOracle = async ({ testPath, pinCommit, implPath }) => {
      const execution = oracleExecution();
      const measured = execution.configSources!;
      const loaded = measured.loaded!;
      run += 1;
      if (mode === 'missing') measured.loaded = null;
      else if (mode === 'unknown') loaded.status = 'unknown';
      else if (mode === 'changed') loaded.sources[0]!.currentSha256 = 'f'.repeat(64);
      else if (mode === 'unpinned') loaded.sources[0]!.sha256 = 'f'.repeat(64);
      else if (mode === 'wrong-basis') loaded.basis = 'reporter-init-disk';
      else if (mode === 'duplicate') loaded.sources.push({ ...loaded.sources[0]! });
      else if (mode === 'missing-source') loaded.sources = [];
      else if (mode === 'changed-between-runs' && run === 2) loaded.sources[0]!.sha256 = 'f'.repeat(64);
      return { results: [{ name: 'task', passed: true }, { name: 'preserved', passed: true }],
        testPath, pinCommit: pinCommit!, sourceHashes: {
          pinned: 'a'.repeat(64), before: 'a'.repeat(64), after: 'a'.repeat(64),
        }, implementation: { path: implPath!, before: 'b'.repeat(64), after: 'b'.repeat(64) }, execution };
    };
    const result = await runGymPipeline(makeSpec({ task: { ...makeSpec().task,
      oracle: { testPath: 'oracle.test.js', implPath: 'impl.js',
        pinCommit: makeSpec().harnessCommit, sourceRef: 'WI-ORACLE' } } }), ports);
    expect(result.deterministicSignals?.taskPassed).toBeUndefined();
    expect(result.deterministicSignals?.regressions).toBeUndefined();
    expect(result.deterministicSignals?.oracle).toMatchObject({ configLoadedCurrent: false });
  });

  it.each(['missing', 'unknown', 'changed', 'unpinned', 'wrong-basis', 'wrong-scope', 'duplicate',
    'missing-source', 'missing-reference', 'changed-between-runs'] as const)
    ('withholds positive claims when native main-process inputs are %s', async (mode) => {
      const { ports } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
      let run = 0;
      ports.runOracle = async ({ testPath, pinCommit, implPath }) => {
        const execution = oracleExecution();
        const measured = execution.mainProcessSources!;
        run += 1;
        if (mode === 'missing') execution.mainProcessSources = undefined;
        else if (mode === 'unknown') measured.evidence.status = 'unknown';
        else if (mode === 'changed') measured.evidence.sources[0]!.currentSha256 = 'a'.repeat(64);
        else if (mode === 'unpinned') measured.reference.sources[0]!.sha256 = null;
        else if (mode === 'wrong-basis') measured.evidence.basis = 'after-run-disk';
        else if (mode === 'wrong-scope') measured.evidence.scope = 'repository-vite-config-dependencies';
        else if (mode === 'duplicate') measured.evidence.sources.push({ ...measured.evidence.sources[0]! });
        else if (mode === 'missing-source') measured.evidence.sources = [];
        else if (mode === 'missing-reference') Object.assign(measured, { reference: undefined });
        else if (mode === 'changed-between-runs' && run === 2) {
          measured.evidence.sources.push({ path: 'libs/other.mjs', sha256: 'c'.repeat(64), currentSha256: 'c'.repeat(64) });
          measured.reference.sources.push({ path: 'libs/other.mjs', sha256: 'c'.repeat(64) });
        }
        return { results: [{ name: 'task', passed: true }, { name: 'preserved', passed: true }],
          testPath, pinCommit: pinCommit!, sourceHashes: {
            pinned: 'a'.repeat(64), before: 'a'.repeat(64), after: 'a'.repeat(64),
          }, implementation: { path: implPath!, before: 'b'.repeat(64), after: 'b'.repeat(64) }, execution };
      };
      const result = await runGymPipeline(makeSpec({ task: { ...makeSpec().task,
        oracle: { testPath: 'oracle.test.js', implPath: 'impl.js',
          pinCommit: makeSpec().harnessCommit, sourceRef: 'WI-ORACLE' } } }), ports);
      expect(result.deterministicSignals?.taskPassed).toBeUndefined();
      expect(result.deterministicSignals?.regressions).toBeUndefined();
      expect(result.deterministicSignals?.oracle).toMatchObject({ mainProcessCurrent: false });
    });

  it.each(['missing', 'empty', 'unknown', 'self-restored', 'dirty', 'missing-entrypoint', 'duplicate-process', 'wrong-pin', 'changed-between-runs'] as const)
    ('withholds positive claims when command child-process inputs are %s', async mode => {
      const { ports } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
      let run = 0;
      ports.runOracle = async ({ testPath, pinCommit, implPath }) => {
        run++;
        const execution = oracleExecution();
        const measured = execution.commandProcessSources!;
        if (mode === 'missing') execution.commandProcessSources = undefined;
        else if (mode === 'empty') measured.processes = [];
        else if (mode === 'unknown') measured.processes[0].status = 'unknown';
        else if (mode === 'self-restored') measured.processes[0].sources[0].sha256 = '2'.repeat(64);
        else if (mode === 'dirty') {
          measured.processes[0].sources[0].sha256 = '2'.repeat(64);
          measured.processes[0].sources[0].currentSha256 = '2'.repeat(64);
        } else if (mode === 'missing-entrypoint') measured.processes[0].entrypoint = null;
        else if (mode === 'duplicate-process') measured.processes.push(structuredClone(measured.processes[0]));
        else if (mode === 'wrong-pin') measured.reference.pinCommit = makeSpec().task.commit;
        else if (mode === 'changed-between-runs' && run === 2) {
          const extra = { path: 'scripts/extra.mjs', sha256: '2'.repeat(64), currentSha256: '2'.repeat(64) };
          measured.processes[0].sources.push(extra);
          measured.reference.sources.push(extra);
        }
        return { results: [{ name: 'task', passed: true }, { name: 'preserved', passed: true }],
          testPath, pinCommit: pinCommit!, sourceHashes: {
            pinned: 'a'.repeat(64), before: 'a'.repeat(64), after: 'a'.repeat(64),
          }, implementation: { path: implPath!, before: 'b'.repeat(64), after: 'b'.repeat(64) }, execution };
      };
      const result = await runGymPipeline(makeSpec({ task: { ...makeSpec().task,
        oracle: { testPath: 'oracle.test.js', implPath: 'impl.js',
          pinCommit: makeSpec().harnessCommit, sourceRef: 'WI-ORACLE' } } }), ports);
      expect(result.deterministicSignals?.taskPassed).toBeUndefined();
      expect(result.deterministicSignals?.regressions).toBeUndefined();
      expect(result.deterministicSignals?.oracle).toMatchObject({ commandProcessesCurrent: false });
    });

  it('withholds authority from legacy unpinned oracle results even with complete passing coverage', async () => {
    const { ports } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
    ports.runOracle = async () => [{ name: 't', passed: true }];
    const result = await runGymPipeline(makeSpec({ task: { ...makeSpec().task,
      oracle: { testPath: 'oracle.test.js', implPath: 'impl.js',
        pinCommit: makeSpec().harnessCommit, sourceRef: 'WI-ORACLE' } } }), ports);
    expect(result.deterministicSignals?.regressions).toBeUndefined();
    expect(result.deterministicSignals?.taskPassed).toBeUndefined();
    expect(result.deterministicSignals?.oracle).toMatchObject({ sourceCurrent: false, populationComplete: true });
  });

  it.each(['changed', 'missing', 'wrong-path'] as const)('withholds task and regression claims when the evaluated implementation is %s', async (mode) => {
    const { ports } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
    let run = 0;
    ports.runOracle = async ({ testPath, pinCommit }) => ({
      results: [{ name: 'task', passed: true }], testPath, pinCommit: pinCommit!,
      sourceHashes: { pinned: 'a'.repeat(64), before: 'a'.repeat(64), after: 'a'.repeat(64) },
      implementation: ++run === 1 ? { path: 'impl.js', before: 'b'.repeat(64), after: 'b'.repeat(64) } :
        mode === 'missing' ? null : { path: mode === 'wrong-path' ? 'other.js' : 'impl.js',
          before: 'c'.repeat(64), after: mode === 'changed' ? 'd'.repeat(64) : 'c'.repeat(64) },
      execution: oracleExecution(),
    });
    const result = await runGymPipeline(makeSpec({ task: { ...makeSpec().task,
      oracle: { testPath: 'oracle.test.js', implPath: 'impl.js',
        pinCommit: makeSpec().harnessCommit, sourceRef: 'WI-ORACLE' } } }), ports);
    expect(result.deterministicSignals?.taskPassed).toBeUndefined();
    expect(result.deterministicSignals?.regressions).toBeUndefined();
    expect(result.deterministicSignals?.oracle).toMatchObject({ implementationCurrent: false });
  });

  it.each(['failed', 'signalled', 'unknown', 'baseline-failed'] as const)('withholds positive task and regression claims when the oracle command is %s', async (mode) => {
    const { ports } = makePorts({ poll: [{ workflowStatus: 'SUCCESS', featureStatus: 'passed' }] });
    let run = 0;
    ports.runOracle = async ({ testPath, pinCommit, implPath, clonePath }) => ({
      results: [{ name: 'task', passed: true }], testPath, pinCommit: pinCommit!,
      sourceHashes: { pinned: 'a'.repeat(64), before: 'a'.repeat(64), after: 'a'.repeat(64) },
      implementation: { path: implPath!, before: 'b'.repeat(64), after: 'b'.repeat(64) },
      execution: { command: ['fixture-oracle'], cwd: clonePath, report: '{}', unresolved: ['fixture'],
        exitCode: mode === 'unknown' ? null : mode === 'failed' || (mode === 'baseline-failed' && ++run === 1) ? 1 : 0,
        signal: mode === 'signalled' ? 'SIGTERM' : null },
    });
    const result = await runGymPipeline(makeSpec({ task: { ...makeSpec().task,
      oracle: { testPath: 'oracle.test.js', implPath: 'impl.js',
        pinCommit: makeSpec().harnessCommit, sourceRef: 'WI-ORACLE' } } }), ports);
    expect(result.deterministicSignals?.taskPassed).toBeUndefined();
    expect(result.deterministicSignals?.regressions).toBeUndefined();
  });
});
