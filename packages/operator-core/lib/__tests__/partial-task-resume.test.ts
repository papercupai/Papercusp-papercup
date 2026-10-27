import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { nativeProcessTraceEnv } from '../../../../scripts/lib/vitest-startup-trace.mjs';
import {
  PARTIAL_TASK_CHECKPOINT_SCHEMA,
  PARTIAL_TASK_SKIP_LIST_SCHEMA,
  normalizePartialFiles,
  partialTaskCheckpointPath,
  partialTaskSkipListPath,
  readPartialTaskCheckpoint,
  writePartialTaskCheckpointAtomic,
  evaluatePartialTaskContinuation,
  readPartialNativeCompletion,
  registerPartialNativeProducer,
  registerPartialNativeProducerChannels,
  readPartialNativeProducer,
  preparePartialContinuationManifest,
  preparePartialRemainingSelection,
  preparePartialNativeProducerChannels,
  preparePartialNativeProducerSelection,
} from '../../../../scripts/lib/partial-task-resume.mjs';

const ID = {
  root: '/repo',
  taskKey: '@papercusp/operator-core :: test:integration',
  sourceCommit: 'a'.repeat(40),
  sourceDigest: 'b'.repeat(64),
};

describe('remaining work preserves the original selected population', () => {
  it('freezes the same original npm invocations before task-key initialization, including standalone and empty guards', () => {
    const source = readFileSync(new URL('../../../../scripts/affected-tests.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('function originalNpmTaskInvocation(');
    const end = source.indexOf('\n/**', start);
    const select = new Function('ROOT', 'join', 'emptySuiteGuardArgs', 'coverageArgsFor',
      `${source.slice(start, end)}\nreturn selectedTaskInvocations;`)('/repo', join,
      ({ selectedFiles }: { selectedFiles: string[] }) => selectedFiles.length ? ['--passWithNoTests=false'] : [],
      () => []);
    const tasks = [false, true].map(standalone => ({ ws: { name: standalone ? 'standalone' : 'workspace',
      dir: standalone ? 'nested' : 'packages/ws', standalone, scripts: { test: 'vitest run' } },
      script: 'test', relatedFiles: ['a.test.ts'], guardBase: 'base' }));
    expect(select(tasks)).toEqual([
      { task: 'workspace :: test', cwd: '/repo',
        argv: ['npm', 'run', 'test', '--workspace', 'packages/ws', '--', '--passWithNoTests=false', '--base', 'base'],
        emptyArgv: ['npm', 'run', 'test', '--workspace', 'packages/ws', '--', '--base', 'base'] },
      { task: 'standalone :: test', cwd: '/repo/nested',
        argv: ['npm', 'run', 'test', '--', '--passWithNoTests=false', '--base', 'base'],
        emptyArgv: ['npm', 'run', 'test', '--', '--base', 'base'] },
    ]);
  });
  const fixture = (dir = '.') => {
    const files = ['a.test.ts', 'b.test.ts'].map(file => dir === '.' ? file : `${dir}/${file}`);
    const specifications = files.map(testFile => ({ testFile, pool: 'forks',
      projectName: null, testNamePattern: null, testIds: null, testTagsFilter: null, testLines: null }));
    const task = { id: 'ws :: test', dir, workspace: 'ws', command: 'vitest run', runner: 'vitest',
      files: specifications.map(row => row.testFile), selectedSpecifications: specifications,
      lifecycleCommands: [], commandObligations: [] };
    const inventory = [{ id: task.id, dir: task.dir, command: task.command },
      { id: 'ws :: guard', dir: '.', command: 'node guard.mjs', isInvariantGuard: true }];
    const selection = { schemaVersion: 1, kind: 'full-gate', phase: 'selection-preparation', executed: false,
      tasks: [task], taskInventory: inventory, files: task.files, unenumerated: [], commandObligations: [], overlaps: [] };
    const postSuite = { schemaVersion: 1, coverage: 'complete',
      units: [{ id: 'post:build', kind: 'post-suite', path: 'package.json' }] };
    const prepared = preparePartialContinuationManifest({ tasks: inventory, selection, postSuite, root: ID.root });
    const expected = { ...ID, attemptId: 'attempt', candidate: ID.sourceCommit, repairHead: null,
      manifest: prepared.manifest, runnerIdentity: 'native', runContext: 'ci', retryStates: [] };
    const receipt = (unitId: string, path: string) => ({ unitId, completionId: `done:${unitId}`, observedAtMs: 1,
      state: 'pass', worktreeDirty: false, observedCount: 1, firstAttemptVerdict: 'pass', proof: {
        recordedSha: ID.sourceCommit, executedModules: [path], readPaths: [], inputsCaptured: true,
        opaqueReasons: [], runnerIdentity: 'native', runContext: 'ci' } });
    const checkpoint = { ...ID, continuation: { schemaVersion: 1, ...expected,
      receipts: [receipt(`test:${files[0]}`, files[0]!), receipt('guard:ws :: guard', 'package.json')] } };
    const project = () => preparePartialRemainingSelection(checkpoint, expected, { selection, postSuite });
    return { checkpoint, expected, selection, postSuite, project, receipt };
  };

  it('runs only the unfinished file, omits a proved guard and keeps the owed post leg', () => {
    const { project, selection } = fixture();
    expect(project()).toMatchObject({ status: 'ready', omitted: ['ws :: guard'],
      tasks: [{ id: 'ws :: test', files: ['b.test.ts'], selectedSpecifications: [{ testFile: 'b.test.ts' }] }],
      evaluation: { run: ['post:build', 'test:b.test.ts'], reused: ['guard:ws :: guard', 'test:a.test.ts'],
        verdict: 'incomplete' } });
    expect(selection.tasks[0]!.files).toEqual(['a.test.ts', 'b.test.ts']);
  });

  it('reruns an invalidated pass and refuses a changed full population', () => {
    const { project, checkpoint, selection } = fixture();
    checkpoint.continuation.receipts[0]!.proof.opaqueReasons.push('unknown' as never);
    expect(project()).toMatchObject({ status: 'ready', tasks: [{ files: ['a.test.ts', 'b.test.ts'] }] });
    selection.taskInventory.pop();
    expect(project()).toMatchObject({ status: 'refused', reason: 'selection-manifest-mismatch' });
  });

  it('retains a failure until the explicit retry policy authorizes it', () => {
    const { project, checkpoint, expected } = fixture();
    checkpoint.continuation.receipts[0]!.state = 'fail';
    expect(project()).toMatchObject({ status: 'refused', reason: 'retained-terminal-outcome' });
    expected.retryStates.push('fail' as never);
    expect(project()).toMatchObject({ status: 'ready', tasks: [{ files: ['a.test.ts', 'b.test.ts'] }],
      evaluation: { verdict: 'red' } });
  });

  it('can omit a completely proved native task without declaring its post leg passed', () => {
    const { project, checkpoint, receipt } = fixture();
    checkpoint.continuation.receipts.push(receipt('test:b.test.ts', 'b.test.ts'));
    expect(project()).toMatchObject({ status: 'ready', tasks: [], omitted: ['ws :: test', 'ws :: guard'],
      evaluation: { run: ['post:build'], verdict: 'incomplete' } });
  });

  it.each(['.', 'packages/ws'].flatMap(dir => [false, true].map(green => ({ dir, green }))))(
    'runs the actual early runner boundary before its later taskKey declaration in $dir green=$green', ({ dir, green }) => {
    const { checkpoint, selection, project } = fixture(dir);
    const source = readFileSync(new URL('../../../../scripts/affected-tests.mjs', import.meta.url), 'utf8');
    const begin = source.indexOf('if (qualificationWorkFile) {');
    const block = source.slice(begin, source.indexOf('\nif (!tasks.length) {', begin));
    const tasks = [{ ws: { name: 'ws', dir, scripts: { test: 'vitest run' } }, script: 'test' },
      { ws: { name: 'ws', dir: '.', scripts: { guard: 'node guard.mjs' } }, script: 'guard', isInvariantGuard: true }];
    const logs: string[] = [];
    const fail = (reason: string) => { throw new Error(reason); };
    const fakeProcess = { env: { GREEN_CHECKPOINT: green ? '1' : undefined,
      PAPERCUSP_CHECKPOINT_QUALIFICATION_ATTEMPT_ID: 'attempt',
      PAPERCUSP_TEST_RUN_GROUP: 'run' }, exit: fail };
    const execute = new Function('qualificationWorkFile', 'tasks', 'ROOT', 'RUN_LOG_ROOT', 'partialSourceIdentity',
      'defaultRunnerIdentity', 'execFileSync', 'createHash', 'readPartialTaskCheckpoint',
      'enumerateAffectedTaskSelection', 'preparePartialRemainingSelection', 'outSync', 'errSync', 'process', 'relative', 'join', 'isAbsolute', 'nativeProcessTraceEnv',
      `${block}\nconst taskKey = task => task.ws.name + ' :: ' + task.script; return tasks;`);
    Object.assign(checkpoint, { sourceDigest: createHash('sha256').update('native').digest('hex') });
    Object.assign(checkpoint, { physicalExecution: { fingerprint: 'a'.repeat(64), evidenceRoot: '/native', tasks: [] } });
    const result = execute('/snapshot', tasks, ID.root, '/logs', () => ({ sourceCommit: ID.sourceCommit,
      sourceDigest: createHash('sha256').update('').digest('hex') }), () => 'native', () => '', createHash,
    () => checkpoint, () => structuredClone(selection), (_checkpoint: unknown, expected: { runContext: string }) => {
      expect(expected.runContext).toBe(green ? 'green-checkpoint' : 'clean-local');
      return project();
    }, (line: string) => logs.push(line), fail, fakeProcess, relative, join,
    (file: string) => file.startsWith('/'), nativeProcessTraceEnv);
    expect(result).toMatchObject([{ ws: tasks[0]!.ws, script: 'test', relatedFiles: ['b.test.ts'],
      qualificationSelection: { tasks: selection.tasks, files: selection.files } }]);
    expect(logs).toEqual(['QUALIFICATION_REMAINING tasks=1 omitted=1 files=1 verdict=incomplete']);
  });

  it.each([['--qualification-work', '/snapshot'], ['--qualification-work=/snapshot']])(
    'parses the original runner value option %s without treating its checkpoint as a positional file', (...argv) => {
      const source = readFileSync(new URL('../../../../scripts/affected-tests.mjs', import.meta.url), 'utf8');
      const begin = source.indexOf('const VALUE_FLAGS =');
      const end = source.indexOf('// WI-42146 / green-main-fast', begin);
      const parse = new Function('process', `${source.slice(begin, end)}\n` +
        `return { path: arg('--qualification-work', null), positionalArgs };`);
      expect(parse({ argv: ['node', 'affected-tests.mjs', ...argv] })).toEqual({ path: '/snapshot', positionalArgs: [] });
    });
});

describe('original npm native channel preparation', () => {
  const fixture = (tolerateEmpty = false) => {
    const root = mkdtempSync(join(tmpdir(), 'partial-native-channels-'));
    const emptyFlag = tolerateEmpty ? ' --passWithNoTests' : '';
    const scripts = { test: 'npm run first && npm run second',
      first: `vitest run a.test.ts${emptyFlag}`, second: `vitest run b.test.ts${emptyFlag}` };
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts }));
    const task = { id: 'ws :: test', dir: '.', command: scripts.test };
    const steps = ['first', 'second'].map((script, index) => {
      const command = scripts[script as 'first' | 'second'];
      const file = `${index ? 'b' : 'a'}.test.ts`;
      return { script, command, files: [file], commandObligations: [], unenumerated: [],
        discovery: [{ runner: 'vitest', command, files: [file], commandObligations: [], lifecycleCommands: [],
          selectedSpecifications: [{ testFile: file, pool: 'forks', projectName: null,
            testNamePattern: null, testIds: null, testTagsFilter: null, testLines: null }] }] };
    });
    const entry = { ...task, workspace: 'ws', script: 'test', runner: 'command-chain',
      steps, files: steps.flatMap(step => step.files), commandObligations: [] };
    const selection = { schemaVersion: 1, kind: 'full-gate', phase: 'selection-preparation', executed: false,
      tasks: [entry], files: entry.files, unenumerated: [], commandObligations: [], overlaps: [] };
    const postSuite = { schemaVersion: 1, coverage: 'complete',
      units: [{ id: 'post:build', kind: 'post-suite', path: 'package.json' }] };
    const input = { root, outPath: join(root, 'out.json'), task, selection, postSuite };
    return { root, scripts, input, prepare: () => preparePartialNativeProducerChannels(input) };
  };

  it.each(['partial', 'empty-step', 'empty-pass', 'all-empty-pass', 'banked-chain', 'invalidated-pass'])(
    'retains the original npm chain while selecting its unfinished files: %s', scenario => {
      const { root, input, scripts } = fixture(scenario === 'empty-pass' || scenario === 'all-empty-pass');
      try {
        const entry = input.selection.tasks[0]!;
        const leaf = entry.steps[0]!.discovery[0]!;
        entry.steps[0]!.files.push('remaining.test.ts');
        leaf.files = entry.steps[0]!.files.slice();
        leaf.selectedSpecifications.push({ ...leaf.selectedSpecifications[0]!, testFile: 'remaining.test.ts' });
        entry.files = entry.steps.flatMap(step => step.files);
        input.selection.files = entry.files;
        const selection = { ...input.selection, taskInventory: [input.task] };
        const prepared = preparePartialContinuationManifest({ ...input, tasks: [input.task], selection });
        expect(prepared.status).toBe('ready');
        const expected = { ...ID, root, taskKey: 'qualification', attemptId: 'attempt', candidate: ID.sourceCommit,
          repairHead: null, manifest: prepared.manifest, runnerIdentity: 'native', runContext: 'ci', retryStates: [] };
        const receipts = [{ unitId: 'test:a.test.ts', completionId: 'saved-first-file', observedAtMs: 1,
          state: 'pass', worktreeDirty: false, observedCount: 1, firstAttemptVerdict: 'pass', proof: {
            recordedSha: ID.sourceCommit, executedModules: ['a.test.ts'], readPaths: [], inputsCaptured: true,
            opaqueReasons: [] as string[], runnerIdentity: 'native', runContext: 'ci' } }];
        const emptyFirst = ['empty-step', 'empty-pass', 'all-empty-pass'].includes(scenario);
        if (emptyFirst) receipts.push({ ...receipts[0]!, unitId: 'test:remaining.test.ts',
          completionId: 'saved-second-file', proof: { ...receipts[0]!.proof, executedModules: ['remaining.test.ts'] } });
        if (scenario === 'all-empty-pass') receipts.push({ ...receipts[0]!, unitId: 'test:b.test.ts',
          completionId: 'saved-last-file', proof: { ...receipts[0]!.proof, executedModules: ['b.test.ts'] } });
        if (scenario === 'banked-chain') receipts.push({ ...receipts[0]!, unitId: 'chain:ws :: test',
          completionId: 'saved-chain', proof: { ...receipts[0]!.proof, executedModules: ['package.json'] } });
        if (scenario === 'invalidated-pass') receipts[0]!.proof.opaqueReasons.push('unknown-input');
        const checkpoint = { root, taskKey: expected.taskKey, continuation: { schemaVersion: 1, ...expected, receipts } };
        const remaining = preparePartialRemainingSelection(checkpoint, expected, { selection, postSuite: input.postSuite });
        if (scenario === 'empty-step' || scenario === 'banked-chain') {
          expect(remaining).toMatchObject({ status: 'refused', reason: scenario === 'empty-step'
            ? 'native-empty-selection-with-command-work' : 'atomic-command-partially-complete' });
          return;
        }
        expect(remaining).toMatchObject({ status: 'ready', tasks: [{ command: input.task.command,
          files: scenario === 'all-empty-pass' ? [] : emptyFirst ? ['b.test.ts']
            : scenario === 'partial' ? ['remaining.test.ts', 'b.test.ts'] : entry.files,
          steps: [{ script: 'first', command: scripts.first,
            files: emptyFirst ? [] : scenario === 'partial' ? ['remaining.test.ts'] : ['a.test.ts', 'remaining.test.ts'] },
          { script: 'second', command: scripts.second, files: scenario === 'all-empty-pass' ? [] : ['b.test.ts'] }] }],
          evaluation: { verdict: 'incomplete' } });
        const narrowed = remaining.tasks[0]!;
        const channels = preparePartialNativeProducerChannels({ ...input, remainingFiles: narrowed.files,
          observedSelection: { ...input.selection, tasks: [narrowed] } });
        expect(channels).toMatchObject({ status: 'ready', commandUnitIds: ['chain:ws :: test'],
          postSuiteUnitIds: ['post:build'], channels: [{ taskKey: 'ws :: test:step:0',
            selectedSpecifications: emptyFirst ? []
              : scenario === 'partial' ? [expect.objectContaining({ testFile: 'remaining.test.ts' })]
                : leaf.selectedSpecifications }, { taskKey: 'ws :: test:step:1',
            selectedSpecifications: scenario === 'all-empty-pass' ? []
              : entry.steps[1]!.discovery[0]!.selectedSpecifications }] });
        expect(channels.manifest).toEqual(prepared.manifest);
        const registered = registerPartialNativeProducerChannels(input.outPath, channels, {
          attemptId: 'attempt', runGroupId: 'group', root, workspaceName: 'ws', sourceCommit: ID.sourceCommit,
          registeredAtMs: 1, command: { cmd: 'npm', argv: ['run', 'test'], cwd: root },
        }, {});
        expect(registered.producers).toHaveLength(scenario === 'all-empty-pass' ? 0 : emptyFirst ? 1 : 2);
        expect(JSON.parse(readFileSync(registered.path, 'utf8')).channels).toHaveLength(2);
        expect(registered.operationalAcceptance).toBe(false);
        expect(entry.steps[0]!.files).toEqual(['a.test.ts', 'remaining.test.ts']);
        expect(checkpoint.continuation.receipts[0]!.completionId).toBe('saved-first-file');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

  it.each(['supported', 'strict', 'banked-hook', 'invalidated'])(
    'keeps a simple native task and its owed lifecycle command when its tests are banked: %s', scenario => {
      const { root, input, scripts } = fixture(scenario !== 'strict');
      try {
        const command = 'node guard.mjs';
        writeFileSync(join(root, 'guard.mjs'), 'process.exitCode = 0;');
        writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { ...scripts, prefirst: command } }));
        const inputs = ['package.json', 'guard.mjs'].map(path => ({ path,
          sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex') }));
        const hook = { kind: 'npm-lifecycle', script: 'prefirst', command, executed: false, inputs,
          discovery: { executed: false, runtimeClosure: 'unmeasured', operationalAcceptance: false,
            inputs, repositoryFiles: ['guard.mjs'] } };
        const task = { id: 'ws :: first', dir: '.', command: scripts.first };
        const leaf = input.selection.tasks[0]!.steps[0]!.discovery[0]!;
        const entry = { ...task, ...leaf, workspace: 'ws', script: 'first',
          lifecycleCommands: [{ script: 'prefirst', command }], commandObligations: [hook] };
        const selection = { ...input.selection, tasks: [entry], taskInventory: [task], files: leaf.files,
          commandObligations: [{ task: task.id, ...hook }],
          unenumerated: [{ task: task.id, reason: 'unexecuted-lifecycle-command' }] };
        const prepared = preparePartialContinuationManifest({ root, tasks: [task], selection, postSuite: input.postSuite });
        expect(prepared.status).toBe('ready');
        const expected = { ...ID, root, taskKey: 'qualification', attemptId: 'attempt', candidate: ID.sourceCommit,
          repairHead: null, manifest: prepared.manifest, runnerIdentity: 'native', runContext: 'ci', retryStates: [] };
        const testReceipt = { unitId: 'test:a.test.ts', completionId: 'saved-test', observedAtMs: 1,
          state: 'pass', worktreeDirty: false, observedCount: 1, firstAttemptVerdict: 'pass', proof: {
            recordedSha: ID.sourceCommit, executedModules: ['a.test.ts'], readPaths: [], inputsCaptured: true,
            opaqueReasons: scenario === 'invalidated' ? ['unknown-input'] : [], runnerIdentity: 'native', runContext: 'ci' } };
        const receipts = scenario === 'banked-hook' ? [{ ...testReceipt, unitId: `command:${task.id}:0`,
          completionId: 'saved-hook', proof: { ...testReceipt.proof, executedModules: ['package.json'] } }] : [testReceipt];
        const checkpoint = { root, taskKey: expected.taskKey, continuation: { schemaVersion: 1, ...expected, receipts } };
        const remaining = preparePartialRemainingSelection(checkpoint, expected, { selection, postSuite: input.postSuite });
        if (scenario === 'strict' || scenario === 'banked-hook') {
          expect(remaining).toMatchObject({ status: 'refused', reason: scenario === 'strict'
            ? 'native-empty-selection-with-command-work' : 'atomic-command-partially-complete' });
          return;
        }
        const files = scenario === 'invalidated' ? ['a.test.ts'] : [];
        expect(remaining).toMatchObject({ status: 'ready', omitted: [], tasks: [{ ...task, files,
          selectedSpecifications: scenario === 'invalidated' ? leaf.selectedSpecifications : [],
          lifecycleCommands: [{ script: 'prefirst', command }], commandObligations: [hook] }],
          evaluation: { verdict: 'incomplete', run: expect.arrayContaining([`command:${task.id}:0`, 'post:build']) } });
        const channels = preparePartialNativeProducerChannels({ ...input, task, selection,
          remainingFiles: files, observedSelection: { ...selection, tasks: remaining.tasks } });
        expect(channels).toMatchObject({ status: 'ready', manifest: prepared.manifest,
          commandUnitIds: [`command:${task.id}:0`], postSuiteUnitIds: ['post:build'] });
        expect(channels.channels).toMatchObject([{ step: null, outPath: input.outPath,
          selectedSpecifications: scenario === 'invalidated' ? leaf.selectedSpecifications : [] }]);
        expect(selection.tasks[0]!.files).toEqual(['a.test.ts']);
        expect(checkpoint.continuation.receipts[0]!.completionId).toBe(scenario === 'banked-hook' ? 'saved-hook' : 'saved-test');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

  it('refuses an empty strict step, a fabricated remaining file and a changed full population', () => {
    const { root, input } = fixture();
    try {
      expect(preparePartialNativeProducerChannels({ ...input, remainingFiles: ['b.test.ts'] }))
        .toMatchObject({ status: 'refused', reason: 'native-empty-selection-with-command-work' });
      expect(preparePartialNativeProducerChannels({ ...input, remainingFiles: ['foreign.test.ts'] }))
        .toMatchObject({ status: 'refused', reason: 'native-channel-remaining-population-mismatch' });
      input.selection.tasks[0]!.steps.shift();
      expect(preparePartialNativeProducerChannels({ ...input, remainingFiles: ['b.test.ts'] }))
        .toMatchObject({ status: 'refused', reason: 'native-channel-chain-population-unmeasured' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a native filter that widened back to banked files before enrollment', () => {
    const { root, input } = fixture(true);
    try {
      expect(preparePartialNativeProducerChannels({ ...input, remainingFiles: ['b.test.ts'],
        observedSelection: input.selection }))
        .toMatchObject({ status: 'refused', reason: 'native-channel-remaining-selection-mismatch' });
      expect(preparePartialNativeProducerChannels({ ...input, remainingFiles: ['b.test.ts'],
        observedSelection: { tasks: [] } }))
        .toMatchObject({ status: 'refused', reason: 'native-channel-remaining-selection-unmeasured' });
      expect(existsSync(`${input.outPath}.native-channels.json`)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('enrolls original command identities immutably without granting operational acceptance', () => {
    const { root, input, prepare } = fixture();
    try {
      const registered = registerPartialNativeProducerChannels(input.outPath, prepare(), {
        attemptId: 'attempt', runGroupId: 'group', root, workspaceName: 'ws', sourceCommit: ID.sourceCommit,
        registeredAtMs: 1, command: { cmd: 'npm', argv: ['run', 'test'], cwd: root },
      }, { PC_EXECUTED_SOURCE_MAP_OUT: input.outPath });
      expect(registered.operationalAcceptance).toBe(false);
      expect(registered.producers).toHaveLength(2);
      const first = registered.producers[0]!;
      expect(readPartialNativeProducer(first.path, { taskKey: 'ws :: test:step:0' }))
        .toMatchObject({ command: { cmd: 'npm', argv: ['run', 'test'] }, nativeChannel: {
          traceOut: input.outPath, script: 'first', command: 'vitest run a.test.ts', step: 0 } });
      const bytes = readFileSync(first.path);
      expect(() => registerPartialNativeProducerChannels(input.outPath, prepare(), {
        attemptId: 'attempt', runGroupId: 'group', root, workspaceName: 'ws', sourceCommit: ID.sourceCommit,
        registeredAtMs: 1, command: { cmd: 'npm', argv: ['run', 'test'], cwd: root },
      }, {})).toThrow();
      expect(readFileSync(first.path)).toEqual(bytes);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['fresh', 'banked-step', 'all-banked', 'widened'])('the production affected runner enrolls each original npm step before its unchanged spawn: %s', scenario => {
    const { root, input, prepare } = fixture(scenario !== 'fresh');
    try {
      const source = readFileSync(new URL('../../../../scripts/affected-tests.mjs', import.meta.url), 'utf8');
      const begin = source.indexOf('    if (qualificationNativeOut) {');
      const end = source.indexOf('    // Extend existing OUT diagnostics', begin);
      expect(begin).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(begin);
      const checkpointPath = join(root, 'work.json');
      writePartialTaskCheckpointAtomic(checkpointPath, { ...ID, root, continuation: {
        schemaVersion: 1, attemptId: 'attempt', manifest: prepare().manifest,
      } });
      const messages: string[] = [];
      const task = { ws: { dir: '.', name: 'ws', scripts: input.selection.tasks[0]!.steps.reduce(
        (scripts, step) => ({ ...scripts, [step.script]: step.command }), { test: input.task.command }) }, script: 'test',
        ...(scenario === 'fresh' ? {} : { qualificationSelection: input.selection,
          relatedFiles: scenario === 'all-banked' ? [] : ['b.test.ts'] }) };
      const scope = { qualificationNativeOut: input.outPath, ROOT: root, RUN_LOG_ROOT: root,
        qualificationWorkFile: checkpointPath, qualificationAttemptId: 'attempt',
        enumerateAffectedTaskSelection: () => {
          if (scenario === 'fresh' || scenario === 'widened') return input.selection;
          const actual = structuredClone(input.selection);
          for (const [index, step] of actual.tasks[0]!.steps.entries()) {
            if (scenario === 'all-banked' || index === 0) {
              step.files = []; step.discovery[0]!.files = []; step.discovery[0]!.selectedSpecifications = [];
            }
          }
          return actual;
        }, spawnTask: task, context: { t: task }, relative, join,
        taskKey: () => input.task.id, partialSourceIdentity: () => ({ sourceCommit: ID.sourceCommit }),
        governedEnv: { PAPERCUSP_TEST_RUN_GROUP: 'group' }, cmd: 'npm', argv: ['run', 'test'], cwd: root,
        readPartialTaskCheckpoint, preparePartialNativeProducerSelection, preparePartialNativeProducerChannels,
        registerPartialNativeProducer, registerPartialNativeProducerChannels,
        outSync: (line: string) => messages.push(line) };
      const run = () => new Function('scope', `const {${Object.keys(scope).join(',')}} = scope;\n${source.slice(begin, end)}`)(scope);
      if (scenario === 'widened') {
        expect(run).toThrow('native-channel-remaining-selection-mismatch');
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('QUALIFICATION_NATIVE_PRODUCER_REFUSED');
        expect(existsSync(`${input.outPath}.native-channels.json`)).toBe(false);
        return;
      }
      run();
      const activeSteps = scenario === 'fresh' ? [0, 1] : scenario === 'banked-step' ? [1] : [];
      expect(messages).toHaveLength(activeSteps.length);
      for (const [index, step] of activeSteps.entries()) expect(messages[index]).toContain(`task="ws :: test:step:${step}"`);
      expect(JSON.parse(readFileSync(`${input.outPath}.native-channels.json`, 'utf8')).channels).toHaveLength(2);
      if (scenario !== 'fresh') expect(existsSync(`${input.outPath}.step-0.producer.json`)).toBe(false);
      for (const step of activeSteps) expect(readPartialNativeProducer(`${input.outPath}.step-${step}.producer.json`, {
        taskKey: `${input.task.id}:step:${step}`,
      }))
        .toMatchObject({ taskKey: `${input.task.id}:step:${step}`, command: { cmd: 'npm', argv: ['run', 'test'] } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['narrowed', 'widened', 'all-banked'])('checks the real simple-native filter before spawning: %s', scenario => {
    const { root, input, prepare } = fixture(true);
    try {
      input.task.command = 'vitest run --passWithNoTests';
      const entry = input.selection.tasks[0]!;
      const simple = { ...entry, command: input.task.command, runner: 'vitest', lifecycleCommands: [],
        selectedSpecifications: entry.steps.flatMap(step => step.discovery[0]!.selectedSpecifications) };
      input.selection.tasks = [simple];
      const checkpointPath = join(root, 'work.json');
      writePartialTaskCheckpointAtomic(checkpointPath, { ...ID, root, continuation: {
        schemaVersion: 1, attemptId: 'attempt', manifest: prepare().manifest,
      } });
      const source = readFileSync(new URL('../../../../scripts/affected-tests.mjs', import.meta.url), 'utf8');
      const begin = source.indexOf('    if (qualificationNativeOut) {');
      const end = source.indexOf('    // Extend existing OUT diagnostics', begin);
      const messages: string[] = [];
      const task = { ws: { dir: '.', name: 'ws', scripts: { test: input.task.command } }, script: 'test',
        qualificationSelection: input.selection, relatedFiles: scenario === 'all-banked' ? [] : ['b.test.ts'] };
      const scope = { qualificationNativeOut: input.outPath, ROOT: root, RUN_LOG_ROOT: root,
        qualificationWorkFile: checkpointPath, qualificationAttemptId: 'attempt',
        enumerateAffectedTaskSelection: () => ({ ...input.selection, tasks: [{ ...simple,
          selectedSpecifications: simple.selectedSpecifications.filter(spec => scenario === 'widened' ||
            scenario !== 'all-banked' && spec.testFile === 'b.test.ts'),
        }] }), spawnTask: task, context: { t: task }, relative, join,
        taskKey: () => input.task.id, partialSourceIdentity: () => ({ sourceCommit: ID.sourceCommit }),
        governedEnv: { PAPERCUSP_TEST_RUN_GROUP: 'group' }, cmd: 'npm', argv: ['run', 'test'], cwd: root,
        readPartialTaskCheckpoint, preparePartialNativeProducerSelection, preparePartialNativeProducerChannels,
        registerPartialNativeProducer, registerPartialNativeProducerChannels,
        outSync: (line: string) => messages.push(line) };
      const run = () => new Function('scope', `const {${Object.keys(scope).join(',')}} = scope;\n${source.slice(begin, end)}`)(scope);
      if (scenario === 'widened') {
        expect(run).toThrow('native-channel-remaining-selection-mismatch');
        expect(existsSync(`${input.outPath}.producer.json`)).toBe(false);
      } else {
        run();
        if (scenario === 'all-banked') expect(existsSync(`${input.outPath}.producer.json`)).toBe(false);
        else expect(readPartialNativeProducer(`${input.outPath}.producer.json`, {}))
          .toMatchObject({ selectedSpecifications: [{ testFile: 'b.test.ts' }] });
      }
      expect(messages).toHaveLength(scenario === 'all-banked' ? 0 : 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('assigns distinct channels to original npm steps and keeps its chain and post guards owed', () => {
    const { root, input, prepare } = fixture();
    try {
      expect(prepare()).toMatchObject({ status: 'ready', operationalAcceptance: false,
        channels: [{ taskKey: 'ws :: test:step:0', sourceTask: 'ws :: test', step: 0, script: 'first',
          command: 'vitest run a.test.ts', outPath: `${input.outPath}.step-0`,
          selectedSpecifications: [{ testFile: 'a.test.ts' }] },
        { taskKey: 'ws :: test:step:1', sourceTask: 'ws :: test', step: 1, script: 'second',
          command: 'vitest run b.test.ts', outPath: `${input.outPath}.step-1`,
          selectedSpecifications: [{ testFile: 'b.test.ts' }] }],
        commandUnitIds: ['chain:ws :: test'], postSuiteUnitIds: ['post:build'] });
      expect(input.task.command).toBe('npm run first && npm run second');
      expect(input.selection.tasks[0]!.steps).toHaveLength(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['source', 'order', 'selection', 'overlap', 'post', 'relative-output', 'unsupported-runner'])(
    'offers no partial channels after %s invalidates the original population', scenario => {
      const { root, scripts, input, prepare } = fixture();
      try {
        if (scenario === 'source') writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { ...scripts, test: 'npm run first' } }));
        if (scenario === 'order') input.selection.tasks[0]!.steps.reverse();
        if (scenario === 'selection') input.selection.tasks[0]!.steps[1]!.discovery[0]!.selectedSpecifications = [];
        if (scenario === 'overlap') input.selection.overlaps.push({ file: 'a.test.ts' } as never);
        if (scenario === 'post') input.postSuite.units = [];
        if (scenario === 'relative-output') input.outPath = 'out.json';
        if (scenario === 'unsupported-runner') input.selection.tasks[0]!.steps[1]!.discovery[0]!.runner = 'node-test';
        expect(prepare()).toMatchObject({ status: 'refused', channels: [], manifest: null,
          commandUnitIds: [], postSuiteUnitIds: [], operationalAcceptance: false });
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  );
});

describe('partial-task-resume', () => {
  it('normalizes workspace paths and rejects paths outside the workspace', () => {
    expect(normalizePartialFiles(['./lib/a.test.ts', '/repo/lib/b.test.ts', '../escape.test.ts'], '/repo'))
      .toEqual(['lib/a.test.ts', 'lib/b.test.ts']);
  });

  it('round-trips a checkpoint and bounds passed files to its selected manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'partial-task-resume-'));
    const file = partialTaskCheckpointPath(dir, ID.root, ID.taskKey);
    writePartialTaskCheckpointAtomic(file, {
      ...ID,
      selectedFiles: ['lib/b.test.ts', 'lib/a.test.ts'],
      passedFiles: ['lib/a.test.ts', 'lib/foreign.test.ts'],
      state: 'partial',
    });
    expect(readPartialTaskCheckpoint(file, ID)).toMatchObject({
      schemaVersion: PARTIAL_TASK_CHECKPOINT_SCHEMA,
      selectedFiles: ['lib/a.test.ts', 'lib/b.test.ts'],
      passedFiles: ['lib/a.test.ts'],
      state: 'partial',
    });
  });

  it('refuses a checkpoint whose source identity moved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'partial-task-resume-'));
    const file = partialTaskCheckpointPath(dir, ID.root, ID.taskKey);
    writePartialTaskCheckpointAtomic(file, { ...ID, selectedFiles: ['a.test.ts'], passedFiles: ['a.test.ts'], state: 'partial' });
    expect(readPartialTaskCheckpoint(file, { ...ID, sourceDigest: 'c'.repeat(64) })).toBeNull();
  });

  it('writes a distinct skip-list channel that cannot be mistaken for a pass proof', () => {
    const dir = mkdtempSync(join(tmpdir(), 'partial-task-resume-'));
    const skip = partialTaskSkipListPath(dir, { ...ID, passedFiles: ['lib/a.test.ts'] });
    const parsed = JSON.parse(readFileSync(skip.path, 'utf8'));
    expect(parsed).toEqual({
      schema: PARTIAL_TASK_SKIP_LIST_SCHEMA,
      taskKey: ID.taskKey,
      sourceCommit: ID.sourceCommit,
      sourceDigest: ID.sourceDigest,
      files: ['lib/a.test.ts'],
    });
    expect(parsed).not.toHaveProperty('runContext');
    expect(parsed).not.toHaveProperty('runnerIdentity');
  });
});

describe('independent qualification manifest preparation', () => {
  const tasks = [
    { id: 'workspace :: test', dir: 'packages/example', command: 'vitest run' },
    { id: 'root :: guard', dir: '.', command: 'node scripts/guard.mjs', isInvariantGuard: true },
  ];
  const selected = { schemaVersion: 1, kind: 'full-gate', phase: 'selection-preparation', executed: false,
    tasks: [{ ...tasks[0], runner: 'vitest', files: ['packages/example/a.test.ts'],
      selectedSpecifications: [{ testFile: 'packages/example/a.test.ts', pool: 'forks', projectName: null,
        testNamePattern: null, testIds: null, testTagsFilter: null, testLines: null }] }],
    unenumerated: [{ task: 'root :: guard', reason: 'unsupported-task-command' }], commandObligations: [] };
  const postSuite = { schemaVersion: 1, coverage: 'complete', units: [
    { id: 'post:lint', kind: 'post-suite', path: 'scripts/lint.mjs' },
  ] };
  const prepare = (overrides = {}) => preparePartialContinuationManifest({ tasks, selection: selected, postSuite, ...overrides });

  it('keeps command guards and post-suite obligations in the independently selected population', () => {
    expect(prepare()).toEqual({ status: 'ready', reason: null, operationalAcceptance: false,
      manifest: { schemaVersion: 1, units: [
        { id: 'guard:root :: guard', kind: 'guard', path: 'package.json' },
        postSuite.units[0],
        { id: 'test:packages/example/a.test.ts', kind: 'test', path: 'packages/example/a.test.ts' },
      ] } });
  });

  it('refuses omitted or foreign tasks, unknown native selection and an absent post-suite population', () => {
    expect(prepare({ tasks: tasks.slice(0, 1) })).toMatchObject({ status: 'refused', reason: 'foreign-task-selection' });
    expect(prepare({ tasks: [...tasks, { id: 'missing', dir: '.', command: 'vitest run' }] }))
      .toMatchObject({ status: 'refused', reason: 'task-selection-unmeasured' });
    expect(prepare({ selection: { ...selected, tasks: [{ ...selected.tasks[0], selectedSpecifications: [] }] } }))
      .toMatchObject({ status: 'refused', reason: 'native-specifications-unmeasured' });
    expect(prepare({ selection: { ...selected, tasks: [{ ...selected.tasks[0],
      selectedSpecifications: [{ ...selected.tasks[0]!.selectedSpecifications[0], pool: null }] }] } }))
      .toMatchObject({ status: 'refused', reason: 'native-specifications-unmeasured' });
    expect(prepare({ postSuite: undefined })).toMatchObject({ status: 'refused', reason: 'post-suite-population-unmeasured' });
    expect(prepare({ selection: { ...selected, unenumerated: [null] } }))
      .toMatchObject({ status: 'refused', reason: 'task-population-unmeasured' });
  });

  it('retains exact policy exclusions and refuses unselected, duplicate or undocumented exemptions', () => {
    const exclusion = { unitId: 'post:lint', reason: 'candidate predates check', policyRef: 'policy:pre-ratchet' };
    expect(prepare({ exclusions: [exclusion] })).toMatchObject({ status: 'ready', manifest: { units: [
      { id: 'guard:root :: guard' }, { id: 'post:lint', exclusion: { reason: exclusion.reason, policyRef: exclusion.policyRef } },
      { id: 'test:packages/example/a.test.ts' },
    ] } });
    for (const exclusions of [[{ ...exclusion, unitId: 'foreign' }], [exclusion, exclusion], [{ ...exclusion, policyRef: '' }]])
      expect(prepare({ exclusions })).toMatchObject({ status: 'refused', reason: 'exclusion-population-invalid' });
  });

  it('refuses overlapping native populations and duplicate post-suite identities', () => {
    const duplicate = { ...tasks[0], id: 'another :: test' };
    expect(prepare({ tasks: [...tasks, duplicate], selection: { ...selected,
      tasks: [...selected.tasks, { ...selected.tasks[0], ...duplicate }] } }))
      .toMatchObject({ status: 'refused', reason: 'test-population-overlapping-or-invalid' });
    expect(prepare({ postSuite: { ...postSuite, units: [...postSuite.units, ...postSuite.units] } }))
      .toMatchObject({ status: 'refused', reason: 'manifest-population-invalid' });
  });

  const commandFixture = (runner = 'command-check') => {
    const root = mkdtempSync(join(tmpdir(), 'continuation-command-'));
    const file = 'input.mjs';
    writeFileSync(join(root, file), 'export const input = 1;\n');
    const inputs = [{ path: file, sha256: createHash('sha256').update(readFileSync(join(root, file))).digest('hex') }];
    const commandTask = { id: 'command :: test', dir: '.', command: 'node input.mjs' };
    const command = { kind: 'command-check', command: commandTask.command, inputs, executed: false,
      discovery: { files: [file], inputs, executed: false, runtimeClosure: 'unmeasured', operationalAcceptance: false } };
    const entry = { ...commandTask, runner, files: [file], commandObligations: [command] };
    const selection = { ...selected, tasks: [entry],
      commandObligations: [{ ...command, task: commandTask.id }],
      unenumerated: [{ task: commandTask.id, reason: 'unexecuted-command-obligations' }] };
    return { root, file, inputs, command, entry, selection, tasks: [commandTask], postSuite };
  };

  it('keeps a discovered command and its test files as separate unsatisfied obligations', () => {
    const fixture = commandFixture();
    try {
      const prepared = preparePartialContinuationManifest(fixture);
      expect(prepared).toMatchObject({ status: 'ready', operationalAcceptance: false,
        manifest: { units: [
          { id: 'command:command :: test:0', kind: 'guard', path: 'package.json' },
          postSuite.units[0], { id: 'test:input.mjs', kind: 'test', path: 'input.mjs' },
        ] } });
      const expected = { ...ID, root: fixture.root, attemptId: 'logical-one', candidate: ID.sourceCommit,
        repairHead: null, manifest: prepared.manifest!, runContext: 'ci', runnerIdentity: 'runner' };
      const evaluation = evaluatePartialTaskContinuation({ root: fixture.root, taskKey: ID.taskKey,
        continuation: { ...expected, schemaVersion: 1, receipts: [] } }, expected);
      expect(evaluation).toMatchObject({ verdict: 'incomplete', run: [
        'command:command :: test:0', 'post:lint', 'test:input.mjs',
      ] });
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it('retains Astro check inputs as a command guard without relabeling them as tests', () => {
    const fixture = commandFixture('astro-check');
    try {
      expect(preparePartialContinuationManifest(fixture)).toMatchObject({ status: 'ready', manifest: { units: [
        { id: 'command:command :: test:0', kind: 'guard' }, postSuite.units[0],
      ] } });
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it('preserves an independently discovered npm lifecycle hook around native tests', () => {
    const fixture = commandFixture();
    try {
      const hook = { ...fixture.command, kind: 'npm-lifecycle', script: 'pretest' };
      const selection = { ...selected, tasks: [{ ...selected.tasks[0],
        lifecycleCommands: [{ script: hook.script, command: hook.command }], commandObligations: [hook] }],
        commandObligations: [{ ...hook, task: tasks[0]!.id }],
        unenumerated: [{ task: tasks[0]!.id, reason: 'unexecuted-lifecycle-command' }, ...selected.unenumerated] };
      expect(prepare({ root: fixture.root, selection })).toMatchObject({ status: 'ready', manifest: { units: [
        { id: 'command:workspace :: test:0', kind: 'guard' }, { id: 'guard:root :: guard' },
        postSuite.units[0], { id: 'test:packages/example/a.test.ts' },
      ] } });
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it.each(['missing-root', 'missing-inputs', 'missing-discovery', 'false-execution', 'foreign-command',
    'unknown-residue', 'omitted-command', 'changed-input', 'removed-input'])(
    'refuses command preparation with %s', mutation => {
      const fixture = commandFixture();
      const originalRoot = fixture.root;
      try {
        if (mutation === 'missing-root') fixture.root = undefined as unknown as string;
        if (mutation === 'missing-inputs') fixture.command.inputs = [];
        if (mutation === 'missing-discovery') fixture.command.discovery = undefined as unknown as typeof fixture.command.discovery;
        if (mutation === 'false-execution') fixture.command.executed = true;
        if (mutation === 'foreign-command') fixture.command.command = 'node foreign.mjs';
        if (mutation === 'unknown-residue') fixture.selection.unenumerated[0]!.reason = 'unsupported-task-command';
        if (mutation === 'omitted-command') fixture.selection.commandObligations = [];
        if (mutation === 'changed-input') writeFileSync(join(fixture.root, fixture.file), 'changed');
        if (mutation === 'removed-input') rmSync(join(fixture.root, fixture.file));
        expect(preparePartialContinuationManifest(fixture)).toMatchObject({ status: 'refused', manifest: null });
      } finally { rmSync(originalRoot, { recursive: true, force: true }); }
    });
});

describe('partial-task continuation proof composition', () => {
  const units = [
    { id: 'test-a', kind: 'test', path: 'lib/a.test.ts' },
    { id: 'guard-a', kind: 'guard', path: 'scripts/guard.mjs' },
    { id: 'post-a', kind: 'post-suite', path: 'scripts/post.mjs' },
  ];
  const expected = { ...ID, attemptId: 'logical-one', candidate: ID.sourceCommit, repairHead: null,
    manifest: { schemaVersion: 1, units }, runContext: 'ci', runnerIdentity: 'proof-v3 node' };
  const receipt = (unit: typeof units[number]) => ({ unitId: unit.id, completionId: `completion:${unit.id}`,
    observedAtMs: 100, state: 'pass', worktreeDirty: false, observedCount: 1, firstAttemptVerdict: 'pass',
    proof: { recordedSha: ID.sourceCommit, executedModules: [unit.path, 'lib/shared.ts'],
      readPaths: ['fixtures/input.json'], inputsCaptured: true, opaqueReasons: [] as string[],
      runContext: 'ci', runnerIdentity: 'proof-v3 node' } });
  const checkpoint = () => ({ ...ID, selectedFiles: ['lib/a.test.ts'], passedFiles: [], state: 'partial',
    continuation: { schemaVersion: 1, attemptId: expected.attemptId, candidate: expected.candidate,
      repairHead: null, manifest: structuredClone(expected.manifest), receipts: units.map(receipt) } });
  const evaluate = (value = checkpoint(), overrides = {}, changed: string[] | null = []) =>
    evaluatePartialTaskContinuation(value, { ...expected, ...overrides }, { changedBetween: () => changed });

  it('recovers the same pending population from the durable checkpoint in a fresh read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'partial-continuation-'));
    const path = partialTaskCheckpointPath(dir, ID.root, ID.taskKey);
    const saved = checkpoint();
    saved.continuation.receipts = saved.continuation.receipts.filter(row => row.unitId !== 'post-a');
    writePartialTaskCheckpointAtomic(path, saved);
    const recovered = readPartialTaskCheckpoint(path, ID);
    expect(evaluate(recovered)).toMatchObject({ status: 'ready', run: ['post-a'],
      reused: ['guard-a', 'test-a'], verdict: 'incomplete', counts: { selected: 3, passed: 2, pending: 1 } });
  });

  it('composes a green verdict only from valid proofs of the complete selected population', () => {
    expect(evaluate()).toMatchObject({ verdict: 'green', run: [], reused: ['guard-a', 'post-a', 'test-a'],
      counts: { selected: 3, required: 3, passed: 3, pending: 0 } });
  });

  it.each(units)('retains a missing or invalid $kind as pending rather than green', unit => {
    const missing = checkpoint();
    missing.continuation.receipts = missing.continuation.receipts.filter(row => row.unitId !== unit.id);
    expect(evaluate(missing)).toMatchObject({ verdict: 'incomplete', run: [unit.id] });
    const opaque = checkpoint();
    opaque.continuation.receipts.find(row => row.unitId === unit.id)!.proof.opaqueReasons = ['socket'];
    expect(evaluate(opaque)).toMatchObject({ verdict: 'incomplete', run: [unit.id] });
  });

  it.each(['attemptId', 'candidate', 'repairHead'] as const)('refuses a moved %s', key => {
    expect(evaluate(checkpoint(), { [key]: 'different' })).toMatchObject({ status: 'refused', verdict: 'incomplete' });
  });

  it('refuses changed selection, duplicate receipts and foreign receipt identities', () => {
    expect(evaluate(checkpoint(), { manifest: { schemaVersion: 1, units: units.slice(1) } })).toMatchObject({
      status: 'refused', reason: 'manifest-mismatch' });
    const duplicate = checkpoint();
    duplicate.continuation.receipts.push(receipt(units[0]!));
    expect(evaluate(duplicate)).toMatchObject({ status: 'refused', reason: 'receipt-population-invalid' });
    const foreign = checkpoint();
    foreign.continuation.receipts[0]!.unitId = 'foreign';
    expect(evaluate(foreign)).toMatchObject({ status: 'refused', verdict: 'incomplete' });
    const aliased = checkpoint();
    aliased.continuation.receipts[1]!.completionId = aliased.continuation.receipts[0]!.completionId;
    expect(evaluate(aliased)).toMatchObject({ status: 'refused', reason: 'receipt-population-invalid' });
  });

  it('invalidates relevant source and input changes while retaining an unrelated-change control', () => {
    const newer = 'c'.repeat(40);
    expect(evaluate(checkpoint(), { sourceCommit: newer }, ['docs/unrelated.md'])).toMatchObject({ verdict: 'green', run: [] });
    for (const changed of ['lib/shared.ts', 'fixtures/input.json', 'package-lock.json'])
      expect(evaluate(checkpoint(), { sourceCommit: newer }, [changed])).toMatchObject({ verdict: 'incomplete',
        run: ['guard-a', 'post-a', 'test-a'], reused: [] });
    expect(evaluate(checkpoint(), { sourceCommit: newer }, null)).toMatchObject({ verdict: 'incomplete', reused: [] });
  });

  it('requires matching runner and context, captured inputs and a clean first-attempt pass', () => {
    for (const overrides of [{ runnerIdentity: 'different' }, { runContext: 'different' }])
      expect(evaluate(checkpoint(), overrides)).toMatchObject({ verdict: 'incomplete', reused: [] });
    for (const corrupt of [
      (row: ReturnType<typeof receipt>) => { row.proof.inputsCaptured = false; },
      (row: ReturnType<typeof receipt>) => { row.worktreeDirty = true; },
      (row: ReturnType<typeof receipt>) => { row.observedCount = 0; },
      (row: ReturnType<typeof receipt>) => { row.firstAttemptVerdict = 'fail'; },
    ]) {
      const value = checkpoint();
      corrupt(value.continuation.receipts[0]!);
      expect(evaluate(value)).toMatchObject({ verdict: 'incomplete', run: ['test-a'] });
    }
  });

  it('retains failure and infrastructure outcomes and retries them only under an explicit policy', () => {
    const value = checkpoint();
    value.continuation.receipts[0]!.state = 'fail';
    value.continuation.receipts[1]!.state = 'infra';
    expect(evaluate(value)).toMatchObject({ verdict: 'red', run: [], reused: ['post-a'],
      retainedFailures: ['test-a'], infrastructure: ['guard-a'] });
    expect(evaluate(value, { retryStates: ['fail', 'infra'] })).toMatchObject({ verdict: 'red',
      run: ['guard-a', 'test-a'], reused: ['post-a'] });
  });

  it('requires exact documented exclusions and refuses empty or entirely excluded success', () => {
    const value = checkpoint();
    const manifest = { schemaVersion: 1, units: units.map(unit => ({ ...unit,
      exclusion: { policyRef: 'policy:owned-exclusion', reason: 'not applicable to this candidate' } })) };
    value.continuation.manifest = manifest;
    expect(evaluate(value, { manifest })).toMatchObject({ verdict: 'incomplete', run: [], reused: [],
      excluded: ['guard-a', 'post-a', 'test-a'] });
    expect(evaluate(value)).toMatchObject({ status: 'refused', reason: 'manifest-mismatch' });
    expect(evaluate(checkpoint(), { manifest: { schemaVersion: 1, units: [] } })).toMatchObject({ status: 'refused' });
  });

  it('detects a torn or modified durable continuation rather than recovering its pass names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'partial-continuation-'));
    const path = partialTaskCheckpointPath(dir, ID.root, ID.taskKey);
    writePartialTaskCheckpointAtomic(path, checkpoint());
    const text = readFileSync(path, 'utf8');
    // A persisted envelope is validated before any legacy passedFiles field is returned.
    const parsed = JSON.parse(text);
    parsed.continuation.receipts[0].proof.inputsCaptured = false;
    writeFileSync(path, JSON.stringify(parsed));
    expect(readPartialTaskCheckpoint(path, ID)).toBeNull();
    writeFileSync(path, text.slice(0, -12));
    expect(readPartialTaskCheckpoint(path, ID)).toBeNull();
  });
});

describe('native durable continuation outcomes', () => {
  const selectedSpecifications = [{ testFile: 'lib/a.test.ts', projectName: null, pool: 'forks',
    testNamePattern: null, testLines: null, testIds: null, testTagsFilter: null }];
  const manifest = { schemaVersion: 1, units: [{ id: 'a', kind: 'test', path: 'lib/a.test.ts' },
    { id: 'guard', kind: 'guard', path: 'scripts/guard.mjs' }] };
  const expected = { ...ID, attemptId: 'attempt-one', workspaceName: '@repo/tests', manifest, selectedSpecifications };
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const snapshot = () => ({ workspaceName: expected.workspaceName, recordedSha: ID.sourceCommit, worktreeDirty: false,
    completionCheckpoint: { schemaVersion: 1, qualificationAttemptId: expected.attemptId,
      runGroupId: 'physical-run-one', runContext: 'ci', runnerIdentity: 'proof-v3 node', state: 'partial', noPersist: true },
    configSources: { status: 'unchanged' },
    rows: [{ testFile: 'lib/a.test.ts', executedModules: ['lib/a.test.ts'], inputsCaptured: true,
      readPaths: ['/repo/fixtures/input.json'], opaqueReasons: [] as string[] }],
    nativeRun: { schemaVersion: 'native-vitest-run-v1', startedAtMs: 100, gaps: [] as string[], finishedAtMs: null as number | null,
      terminalHook: null as string | null, reason: null as string | null,
      unhandledErrorCount: null as number | null, modulePopulationMatched: false,
      selectedManifest: { specifications: structuredClone(selectedSpecifications), sha256: hash(selectedSpecifications) },
      files: [{ testFile: 'lib/a.test.ts', completionId: 'completion-a', observedAtMs: 123, state: 'passed',
        firstAttemptVerdict: 'pass', cases: [{ status: 'pass' }],
        proof: { sourceEvidence: { schemaVersion: 'vite-collected-source-evidence-v1', status: 'stable',
          sources: [{ path: 'lib/a.test.ts', sha256: 'a'.repeat(64), currentSha256: 'a'.repeat(64) }], reasons: [] } } }] } });
  const read = (value = snapshot(), overrides = {}, classify = true, producerOverrides: Record<string, unknown> | null = null,
    options = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'native-continuation-'));
    const file = join(dir, 'out.json');
    writeFileSync(file, JSON.stringify({ ...value, completionIntegrity: { schemaVersion: 1, sha256: hash(value) } }));
    try {
      const producer = producerOverrides === null ? null : registerPartialNativeProducer(file, {
        attemptId: expected.attemptId, runGroupId: 'physical-run-one', root: ID.root, taskKey: ID.taskKey,
        workspaceName: expected.workspaceName, sourceCommit: ID.sourceCommit, registeredAtMs: 50,
        command: { cmd: '/node', argv: ['vitest', 'run'], cwd: ID.root }, selectedSpecifications,
        ...producerOverrides,
      }, { TEST_SECRET: 'credential-never-written' });
      return readPartialNativeCompletion(file, { ...expected, ...overrides,
        ...(producer ? { producerPath: producer.path } : {}) }, classify
        ? { ...options, classifyReadPaths: () => ({ readPaths: ['fixtures/input.json'], opaqueReasons: [] }) } : options);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  const currentFixture = (damage: (value: any) => void = () => {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'native-current-outcome-'));
    const traceOut = join(dir, 'out'), outPath = `${traceOut}.step-0`;
    const channel = { traceOut, script: 'test', command: 'vitest run', step: 0 };
    const binding = { schemaVersion: 1, kind: 'native-channel-binding', ...channel, outPath,
      parentPid: 10, processIdentity: 'npm-process', childIdentity: 'test-child' };
    const native = snapshot();
    Object.assign(native.nativeRun, { scope: 'vitest-reporter-callbacks', pid: 12, ppid: 11,
      finishedAtMs: 140, reason: 'passed', terminalHook: 'onTestRunEnd',
      unhandledErrorCount: 0, modulePopulationMatched: true });
    // Runtime read closure is deliberately unavailable; current evidence must
    // authenticate independently, without inventing a reusable proof.
    native.rows[0]!.inputsCaptured = false;
    native.rows[0]!.opaqueReasons = ['runtime-closure-unmeasured'];
    const physical = { ...expected, candidate: ID.sourceCommit, repairHead: null, runContext: 'ci',
      runnerIdentity: 'proof-v3 node', runId: 'physical-run-one', runnerId: 'owner-one', pidIdentity: 'boot:42',
      runnerReservedAtMs: 40, nowMs: 200 };
    mkdirSync(`${traceOut}.native-processes`);
    const emptyHash = createHash('sha256').update('').digest('hex');
    const stream = { scope: 'node-writable-call-inputs', captureComplete: true, sha256: emptyHash,
      ref: `${emptyHash}.stream`, byteLength: 0, observedByteLength: 0 };
    writeFileSync(join(`${traceOut}.native-processes`, stream.ref), '');
    const lifecycle = { event: 'test', script: channel.command };
    const events = [
      { event: 'node-entry', pid: 10, ppid: 1, processIdentity: 'npm-process', atMs: 60,
        cwd: ID.root, argv: ['/node', '/npm-cli.js', 'run', 'test'], reporterOut: traceOut },
      { event: 'child-spawn', pid: 10, ppid: 1, processIdentity: 'npm-process', atMs: 70,
        childIdentity: binding.childIdentity, childPid: 11, nativeChannel: binding, shell: false,
        command: 'sh', argv: ['-c', channel.command], cwd: ID.root, lifecycle },
      { event: 'node-entry', pid: 12, ppid: 11, processIdentity: 'reporter-process', atMs: 80,
        cwd: ID.root, reporterOut: outPath, lifecycle },
      { event: 'node-exit', pid: 12, ppid: 11, processIdentity: 'reporter-process', atMs: 150,
        code: 0, exitListenersComplete: true, streams: { stdout: stream, stderr: stream } },
      { event: 'child-close', pid: 10, ppid: 1, processIdentity: 'npm-process', atMs: 160,
        childIdentity: binding.childIdentity, childPid: 11, code: 0, signal: null },
    ];
    try {
      damage({ native, physical, events, binding });
      for (const event of events) {
        const value = { schemaVersion: 1, kind: 'native-node-process-event', ...event };
        writeFileSync(join(`${traceOut}.native-processes`, `${hash(value)}.json`), JSON.stringify(value));
      }
      writeFileSync(`${outPath}.binding.json`, JSON.stringify(binding));
      writeFileSync(outPath, JSON.stringify({ ...native, completionIntegrity: { schemaVersion: 1, sha256: hash(native) } }));
      const producer = registerPartialNativeProducer(outPath, { attemptId: expected.attemptId,
        runGroupId: 'physical-run-one', root: ID.root, taskKey: ID.taskKey, workspaceName: expected.workspaceName,
        sourceCommit: ID.sourceCommit, registeredAtMs: 50, selectedSpecifications, nativeChannel: channel,
        command: { cmd: 'npm', argv: ['run', 'test'], cwd: ID.root } }, {});
      const observed = readPartialNativeCompletion(outPath, { ...physical, producerPath: producer.path });
      const guard = { unitId: 'guard', completionId: 'guard-completion', state: 'pass', observedAtMs: 123,
        worktreeDirty: false, observedCount: 1, proof: { recordedSha: ID.sourceCommit, runContext: physical.runContext,
          runnerIdentity: physical.runnerIdentity, executedModules: ['scripts/guard.mjs'], inputsCaptured: true,
          readPaths: [], opaqueReasons: [] } };
      const checkpoint = { ...ID, continuation: { schemaVersion: 1, ...physical,
        receipts: [...observed.receipts, guard] } };
      return { observed, physical, checkpoint };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it('composes exact current and retained evidence while keeping current runtime closure unmeasured', () => {
    const { observed, physical, checkpoint } = currentFixture();
    expect(observed).toMatchObject({ status: 'ready', currentEvidence: [{ scope: 'current-execution' }], receipts: [{ proof: {
      inputsCaptured: false, opaqueReasons: expect.arrayContaining(['runtime-closure-unmeasured']) } }] });
    expect(evaluatePartialTaskContinuation(checkpoint, physical, { currentEvidence: observed.currentEvidence }))
      .toMatchObject({ verdict: 'green', current: ['a'], reused: ['guard'], run: [], counts: { required: 2, passed: 2 },
        evidenceScopes: [{ unitId: 'a', scope: 'current-execution' }, { unitId: 'guard', scope: 'reusable' }] });
    expect(evaluatePartialTaskContinuation(checkpoint, physical))
      .toMatchObject({ verdict: 'incomplete', current: [], reused: ['guard'], run: ['a'],
        evidenceScopes: [{ unitId: 'guard', scope: 'reusable' }] });
    expect(observed.receipts[0]!.proof).toMatchObject({ inputsCaptured: false,
      opaqueReasons: expect.arrayContaining(['runtime-closure-unmeasured']) });
  });

  it.each(['runId', 'runnerId', 'pidIdentity', 'runnerIdentity', 'runContext', 'sourceCommit'])(
    'cannot carry current-only authority across a changed %s', key => {
      const { observed, physical, checkpoint } = currentFixture();
      expect(evaluatePartialTaskContinuation(checkpoint, { ...physical, [key]: 'replacement' },
        { currentEvidence: observed.currentEvidence })).toMatchObject({ verdict: 'incomplete', current: [] });
    });

  it('publishes canonical scope labels without granting authority to missing, forged or invalid reuse proof', () => {
    const { observed, physical, checkpoint } = currentFixture();
    const evaluate = (currentEvidence?: unknown) => evaluatePartialTaskContinuation(checkpoint, physical, { currentEvidence });
    expect(evaluate(observed.currentEvidence).evidenceScopes).toEqual([
      { unitId: 'a', scope: 'current-execution' }, { unitId: 'guard', scope: 'reusable' },
    ]);
    for (const claimed of [undefined, [{ scope: 'current-execution' }], [{ scope: 'reusable' }]])
      expect(evaluate(claimed)).toMatchObject({ verdict: 'incomplete', current: [],
        evidenceScopes: [{ unitId: 'guard', scope: 'reusable' }] });
    // Reusable proof can fail independently while authenticated current
    // authority remains valid. The public contract must expose that boundary.
    Object.assign(checkpoint.continuation.receipts.find(receipt => receipt.unitId === 'guard')!, { proof: null });
    expect(evaluate(observed.currentEvidence)).toMatchObject({ verdict: 'incomplete', current: ['a'], reused: [],
      evidenceScopes: [{ unitId: 'a', scope: 'current-execution' }] });
  });

  it('refuses forged, serialized, missing and receipt-mismatched current authority', () => {
    const { observed, physical, checkpoint } = currentFixture();
    for (const evidence of [undefined, [{}], [{ scope: 'current-execution' }],
      JSON.parse(JSON.stringify(observed.currentEvidence))])
      expect(evaluatePartialTaskContinuation(checkpoint, physical, { currentEvidence: evidence }))
        .toMatchObject({ verdict: 'incomplete', current: [], run: ['a'] });
    checkpoint.continuation.receipts[0]!.completionId = 'forged';
    expect(evaluatePartialTaskContinuation(checkpoint, physical, { currentEvidence: observed.currentEvidence }))
      .toMatchObject({ verdict: 'incomplete', current: [] });
  });

  it('binds the aggregate qualification while authenticating the separate original native task', () => {
    const { observed, physical, checkpoint } = currentFixture(({ physical }) => {
      physical.continuationTaskKey = 'aggregate-qualification';
    });
    checkpoint.taskKey = 'aggregate-qualification';
    expect(evaluatePartialTaskContinuation(checkpoint, { ...physical, taskKey: checkpoint.taskKey },
      { currentEvidence: observed.currentEvidence })).toMatchObject({ verdict: 'green', current: ['a'], reused: ['guard'] });
    checkpoint.continuation.receipts.pop();
    expect(evaluatePartialTaskContinuation(checkpoint, { ...physical, taskKey: checkpoint.taskKey },
      { currentEvidence: observed.currentEvidence })).toMatchObject({ verdict: 'incomplete', current: ['a'], run: ['guard'] });
  });

  it.each(['source', 'config', 'first-attempt', 'cases', 'time', 'fence', 'group', 'trace'])(
    'requires independent source, population and physical authentication: %s', scenario => {
      const { observed } = currentFixture(({ native, physical, events }) => {
        if (scenario === 'source') native.nativeRun.files[0].proof.sourceEvidence.status = 'changed';
        if (scenario === 'config') native.configSources.status = 'changed';
        if (scenario === 'first-attempt') native.nativeRun.files[0].firstAttemptVerdict = 'fail';
        if (scenario === 'cases') native.nativeRun.files[0].cases = [];
        if (scenario === 'time') native.nativeRun.files[0].observedAtMs = 141;
        if (scenario === 'fence') physical.runnerReservedAtMs = 51;
        if (scenario === 'group') physical.runId = 'replacement';
        if (scenario === 'trace') events.pop();
      });
      expect('currentEvidence' in observed ? observed.currentEvidence : []).toEqual([]);
    });

  it('requires a pre-start producer with the exact independently selected native specifications', () => {
    expect(read(snapshot(), {}, true, {})).toMatchObject({ status: 'ready' });
    for (const producer of [
      { attemptId: 'foreign' }, { runGroupId: 'foreign' }, { sourceCommit: 'foreign' },
      { registeredAtMs: 101 }, { taskKey: 'foreign' },
      { selectedSpecifications: [{ ...selectedSpecifications[0], testNamePattern: 'one case' }] },
    ]) expect(read(snapshot(), {}, true, producer)).toMatchObject({ status: 'refused', reason: 'native-producer-mismatch' });
  });

  it('accepts selection recovered with JSONB key ordering while still checking the native manifest digest', () => {
    const recovered = selectedSpecifications.map(spec => Object.fromEntries(Object.entries(spec).reverse()));
    expect(read(snapshot(), { selectedSpecifications: recovered }, true, {})).toMatchObject({ status: 'ready' });
    const damaged = snapshot();
    damaged.nativeRun.selectedManifest.sha256 = '0'.repeat(64);
    expect(read(damaged, { selectedSpecifications: recovered }, true, {}))
      .toMatchObject({ status: 'refused', reason: 'native-selection-mismatch' });
  });

  it('seals immutable enrollment without persisting environment secrets and rejects altered identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-producer-')), out = join(dir, 'out.json');
    const registration = { ...ID, attemptId: expected.attemptId, runGroupId: 'run-one',
      workspaceName: expected.workspaceName, registeredAtMs: 50, selectedSpecifications,
      command: { cmd: '/node', argv: ['vitest', 'run'], cwd: ID.root } };
    try {
      const saved = registerPartialNativeProducer(out, registration, { TOKEN: 'credential-never-written' });
      expect(readFileSync(saved.path, 'utf8')).not.toContain('credential-never-written');
      expect(readPartialNativeProducer(saved.path, { ...ID, command: registration.command })).toEqual(saved.producer);
      expect(readPartialNativeProducer(saved.path, { environmentDigest: '0'.repeat(64) })).toBeNull();
      expect(readPartialNativeProducer(saved.path, { command: { ...registration.command, argv: ['other'] } })).toBeNull();
      expect(() => registerPartialNativeProducer(out, { ...registration, runGroupId: 'overwrite' }, {})).toThrow();
      expect(readPartialNativeProducer(saved.path, { runGroupId: 'run-one' })).not.toBeNull();
      const altered = JSON.parse(readFileSync(saved.path, 'utf8')); altered.taskKey = 'foreign';
      writeFileSync(saved.path, JSON.stringify(altered));
      expect(readPartialNativeProducer(saved.path, {})).toBeNull();
      expect(() => registerPartialNativeProducer(join(dir, 'duplicate.json'), {
        ...registration, selectedSpecifications: [...selectedSpecifications, ...selectedSpecifications],
      }, {})).toThrow('native-producer-registration-invalid');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('recovers a committed module before the terminal hook and composes its proof with pending guards', () => {
    const recovered = read();
    expect(recovered).toMatchObject({ status: 'ready', receipts: [{ unitId: 'a', completionId: 'completion-a',
      state: 'pass', observedCount: 1, proof: { opaqueReasons: [], inputsCaptured: true } }],
      origin: { runGroupId: 'physical-run-one', startedAtMs: 100, sourceCommit: ID.sourceCommit } });
    const checkpoint = { ...ID, continuation: { schemaVersion: 1, attemptId: expected.attemptId,
      candidate: ID.sourceCommit, repairHead: null, manifest, receipts: recovered.receipts } };
    expect(evaluatePartialTaskContinuation(checkpoint, { ...expected, candidate: ID.sourceCommit,
      repairHead: null, runContext: 'ci', runnerIdentity: 'proof-v3 node' })).toMatchObject({
      verdict: 'incomplete', reused: ['a'], run: ['guard'] });
  });

  it('requires independent exact selection including case filters and attempt identity', () => {
    expect(read(snapshot(), { attemptId: 'other' })).toMatchObject({ status: 'refused' });
    const filtered = snapshot();
    filtered.nativeRun.selectedManifest.specifications[0]!.testNamePattern = 'one case' as never;
    filtered.nativeRun.selectedManifest.sha256 = hash(filtered.nativeRun.selectedManifest.specifications);
    expect(read(filtered)).toMatchObject({ status: 'refused', reason: 'native-selection-mismatch' });
  });

  it('distinguishes a clean interrupted prefix from a terminal verdict or an observed error', () => {
    const options = { requireTerminal: true, allowInterrupted: true };
    expect(read(snapshot(), {}, true, null, { requireTerminal: true }))
      .toMatchObject({ status: 'refused', reason: 'native-terminal-verdict-unmeasured' });
    expect(read(snapshot(), {}, true, null, options)).toMatchObject({ status: 'ready', origin: { terminal: 'interrupted' } });
    for (const damage of [
      (v: ReturnType<typeof snapshot>) => { v.nativeRun.finishedAtMs = 200; },
      (v: ReturnType<typeof snapshot>) => { v.nativeRun.reason = 'failed'; },
      (v: ReturnType<typeof snapshot>) => { v.nativeRun.unhandledErrorCount = 1; },
      (v: ReturnType<typeof snapshot>) => { v.nativeRun.terminalHook = 'onExit'; },
      (v: ReturnType<typeof snapshot>) => { v.nativeRun.gaps = ['run-end-unobserved']; },
      (v: ReturnType<typeof snapshot>) => { v.nativeRun.files = []; },
    ]) {
      const value = snapshot(); damage(value);
      expect(read(value, {}, true, null, options)).toMatchObject({ status: 'refused' });
      if (value.nativeRun.files.length) expect(read(value).receipts[0]!.proof.opaqueReasons)
        .toContain('native-run-incomplete-or-errored');
    }
  });

  it('retains failure and infrastructure outcomes without promoting them to passes', () => {
    const failed = snapshot();
    failed.nativeRun.files[0]!.state = 'failed';
    expect(read(failed)).toMatchObject({ status: 'ready', receipts: [{ state: 'fail' }] });
    failed.nativeRun.files[0]!.state = 'error';
    expect(read(failed)).toMatchObject({ status: 'ready', receipts: [{ state: 'infra' }] });
  });

  it('never reuses unclassified, opaque, unstable or terminal-error proof', () => {
    expect(read(snapshot(), {}, false).receipts[0]!.proof.inputsCaptured).toBe(false);
    for (const damage of [
      (v: ReturnType<typeof snapshot>) => { v.nativeRun.files[0]!.proof.sourceEvidence.status = 'unknown'; },
      (v: ReturnType<typeof snapshot>) => { v.nativeRun.files[0]!.cases = []; },
      (v: ReturnType<typeof snapshot>) => { v.rows[0]!.opaqueReasons = ['socket']; },
      (v: ReturnType<typeof snapshot>) => { v.nativeRun.finishedAtMs = 200; v.nativeRun.reason = 'failed'; v.nativeRun.unhandledErrorCount = 1; },
    ]) {
      const value = snapshot(); damage(value);
      expect(read(value).receipts[0]!.proof.opaqueReasons.length).toBeGreaterThan(0);
    }
    const duplicate = snapshot(); duplicate.nativeRun.files.push(duplicate.nativeRun.files[0]!);
    expect(read(duplicate)).toMatchObject({ status: 'refused', reason: 'native-receipt-population-invalid' });
  });

  it('authenticates a completion snapshot without parsing or rehashing a document-sized string', () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-bounded-completion-'));
    const file = join(dir, 'out.json');
    const value = { ...snapshot(), padding: Array.from({ length: 1000 }, () => 'observed-source-🙂'.repeat(8)) };
    writeFileSync(file, JSON.stringify({ ...value, completionIntegrity: { schemaVersion: 1, sha256: hash(value) } }));
    const stringify = JSON.stringify, parse = JSON.parse;
    const writeGuard = vi.spyOn(JSON, 'stringify').mockImplementation(((input: unknown) => {
      if (input && typeof input === 'object' && 'nativeRun' in input)
        throw new RangeError('aggregate serialization forbidden');
      return stringify(input);
    }) as typeof JSON.stringify);
    const readGuard = vi.spyOn(JSON, 'parse').mockImplementation(((input: string) => {
      if (input.length > 4096) throw new RangeError('aggregate parsing forbidden');
      return parse(input);
    }) as typeof JSON.parse);
    let observed;
    try {
      observed = readPartialNativeCompletion(file, expected, {
        classifyReadPaths: () => ({ readPaths: ['fixtures/input.json'], opaqueReasons: [] }),
      });
    } finally {
      readGuard.mockRestore();
      writeGuard.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(observed).toMatchObject({ status: 'ready', receipts: [{ state: 'pass' }] });
  });

  it('refuses a torn or altered snapshot even if its pass file names look valid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-corruption-')), file = join(dir, 'out.json');
    const value = snapshot();
    writeFileSync(file, JSON.stringify({ ...value, completionIntegrity: { schemaVersion: 1, sha256: '0'.repeat(64) } }));
    expect(readPartialNativeCompletion(file, expected)).toMatchObject({ status: 'refused', reason: 'snapshot-integrity-invalid' });
    writeFileSync(file, '{');
    expect(readPartialNativeCompletion(file, expected)).toMatchObject({ status: 'refused', reason: 'snapshot-unreadable' });
  });
});
