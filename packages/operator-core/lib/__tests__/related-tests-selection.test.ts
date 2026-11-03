import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { preparePartialContinuationManifest, preparePartialNativeProducerSelection,
  registerPartialNativeProducer, readPartialNativeProducer } from '../../../../scripts/lib/partial-task-resume.mjs';


import {
  RELATED_WIDEN_THRESHOLD_DEFAULT,
  RELATED_WIDEN_THRESHOLD_ENV,
  buildIndex,
  classifySpecifier,
  isCrossRootUnreached,
  isTestFile,
  packageExportTargets,
  playwrightOwnedTest,
  pruneWithExecutedMap,
  resolveRelatedWidenThreshold,
  prepareRelatedTestSelection,
  selectRelatedTests,
  staticImportClosure,
  transitiveDeps,
  writeRelatedFilterList,
  enumerateAffectedTaskSelection,
} from '../../../../scripts/lib/related-tests.mjs';

/**
 * Import-graph test selection (file-level-test-selection-2026-08-17).
 *
 * The engine decides which tests a change can affect. Its dangerous failure is not
 * "ran too many tests" — that only costs minutes — it is "ran too few and reported
 * green", which certifies code nothing exercised. So every rail below asserts the
 * FAIL-SAFE direction: anything the graph cannot answer confidently must widen to
 * the full suite rather than narrow.
 *
 * A virtual filesystem keeps these deterministic and sub-millisecond; the real
 * indexer is exercised against the actual tree by `--related`'s own dry-run.
 */

const ROOT = '/repo/lib';

describe('original gate selection preparation', () => {
  const task = (script = 'test', command = 'vitest run', relatedFiles?: string[]) => ({
    ws: { name: '@probe/core', dir: 'packages/core', scripts: { [script]: command } }, script, relatedFiles,
  });
  const options = (results: unknown[]) => ({ root: '/repo', filterDir: tmpdir(), runResolver: () => results });
  const resolved = (files: string[]) => ({ ok: true, enumerated: true, files, config: { include: files, exclude: [] } });

  it.each([false, true])('preserves an empty qualification filter without changing ordinary empty selectors: %s', qualification => {
    const dir = mkdtempSync(join(tmpdir(), 'qualification-empty-selection-'));
    try {
      const selected = { ...task('test', 'vitest run', []),
        ...(qualification ? { qualificationSelection: {} } : {}) };
      const result = enumerateAffectedTaskSelection([selected], { root: '/repo', filterDir: dir,
        enumerateSpecifications: true, runResolver: (requests: Array<{ env: Record<string, string> }>) => {
          const filter = requests[0]!.env.PC_TEST_FILTER_LIST;
          if (qualification) expect(JSON.parse(readFileSync(filter!, 'utf8'))).toEqual([]);
          else expect(filter).toBeUndefined();
          return [{ ...resolved(qualification ? [] : ['a.test.ts']), selectedSpecifications: [] }];
        } });
      expect(result.files).toEqual(qualification ? [] : ['packages/core/a.test.ts']);
      expect(result.executed).toBe(false);
      expect(result.operationalAcceptance).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps wide lanes unknown until their real config enumerates files', () => {
    const result = enumerateAffectedTaskSelection([task()], options([resolved(['a.test.ts', 'b.test.ts'])]));
    expect(result.files).toEqual(['packages/core/a.test.ts', 'packages/core/b.test.ts']);
    expect(result.coverage).toBe('complete');
    expect(result.executed).toBe(false);
    expect(result.runtimeClosure).toBe('unmeasured');
    expect(result.operationalAcceptance).toBe(false);
  });

  it('passes exact native specification discovery through the maintained selector without executing tests', () => {
    const specs = [{ testFile: 'packages/core/a.test.ts', projectName: 'pure', pool: 'forks',
      testNamePattern: null, testLines: null, testIds: null, testTagsFilter: null }];
    let requests: Array<Record<string, unknown>> = [];
    const result = enumerateAffectedTaskSelection([task()], { root: '/repo', enumerateSpecifications: true,
      runResolver: (input: typeof requests) => {
        requests = input;
        return [{ ...resolved(['a.test.ts']), selectedSpecifications: specs }];
      } });
    expect(requests).toMatchObject([{ enumerateSpecifications: true, enumerateFiles: true }]);
    const entry = result.tasks[0];
    if (!entry || !('selectedSpecifications' in entry)) throw new Error('native specifications missing');
    expect(entry.selectedSpecifications).toEqual(specs);
    expect(result.executed).toBe(false);
  });

  it('discovers exact specifications with native Vitest without loading test modules', () => {
    const repo = fileURLToPath(new URL('../../../..', import.meta.url));
    const parent = join(repo, '.papercusp/scratch'); mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(join(parent, 'native-selection-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      writeFileSync(join(dir, 'vitest.config.mjs'), 'export default {test:{name:"enrollment",pool:"forks",include:["a.test.ts"]}}');
      writeFileSync(join(dir, 'a.test.ts'), 'throw new Error("discovery must never load this test")');
      const relativeDir = dir.slice(repo.length).replace(/^\//, '');
      const result = enumerateAffectedTaskSelection([{ ws: { name: '@probe/native', dir: relativeDir,
        scripts: { test: 'vitest run --config vitest.config.mjs' } }, script: 'test' }], {
        root: repo, enumerateSpecifications: true,
      });
      expect(result.coverage).toBe('complete');
      const entry = result.tasks[0];
      if (!entry || !('selectedSpecifications' in entry)) throw new Error('native specifications missing');
      expect(entry.selectedSpecifications).toEqual([{ testFile: `${relativeDir}/a.test.ts`,
        projectName: 'enrollment', pool: 'forks', testNamePattern: null, testLines: null, testIds: null, testTagsFilter: null }]);
      expect(result.executed).toBe(false);
      const manifest = preparePartialContinuationManifest({ selection: result,
        tasks: [{ id: '@probe/native :: test', dir: relativeDir, command: 'vitest run --config vitest.config.mjs' }],
        postSuite: { schemaVersion: 1, coverage: 'complete', units: [
          { id: 'post:lint', kind: 'post-suite', path: 'package.json' },
        ] } });
      expect(manifest).toMatchObject({ status: 'ready', operationalAcceptance: false,
        manifest: { units: [{ id: 'post:lint' }, { path: `${relativeDir}/a.test.ts`, kind: 'test' }] } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it('retains unsupported composite/guard tasks even if they supplied a file list', () => {
    const result = enumerateAffectedTaskSelection([
      task(), task('lint:guard', 'node guard.mjs', ['guard.test.ts']),
      task('test:compound', 'vitest run && node more.mjs'),
    ], options([resolved(['a.test.ts'])]));
    expect(result.coverage).toBe('partial');
    expect(result.unenumerated.map(row => row.task)).toEqual(['@probe/core :: lint:guard', '@probe/core :: test:compound']);
  });

  it('does not shrink to relatedFiles when config resolution or the batch fails', () => {
    expect(enumerateAffectedTaskSelection([task('test', 'vitest run', ['a.test.ts'])],
      options([{ ok: false, error: 'config unavailable' }])).unenumerated[0].reason).toBe('config unavailable');
    expect(enumerateAffectedTaskSelection([task()], options([])).coverage).toBe('partial');
  });

  it('follows local aliases, preserves lifecycle commands and refuses missing or cyclic aliases', () => {
    const base = task();
    base.ws.scripts = { test: 'npm run test:unit', 'test:unit': 'vitest run', pretest: 'node build.mjs' };
    const result = enumerateAffectedTaskSelection([base], options([resolved(['a.test.ts'])]));
    expect(result.tasks[0].command).toBe('npm run test:unit');
    expect(result.tasks[0].resolvedCommand).toBe('vitest run');
    expect(result.tasks[0].lifecycleCommands).toEqual([{ script: 'pretest', command: 'node build.mjs' }]);
    for (const scripts of [{ test: 'npm run missing' }, { test: 'npm run again', again: 'npm run test' }]) {
      expect(enumerateAffectedTaskSelection([{ ...base, ws: { ...base.ws, scripts } }], options([])).coverage).toBe('partial');
    }
  });

  it('retains template config environment without admitting arbitrary shell assignments', () => {
    const requests: Array<{ env: Record<string, string> }> = [];
    const result = enumerateAffectedTaskSelection([task('test', 'TEMPLATE_CHECKS_CONFIG=template-checks.json vitest run')],
      { root: '/repo', runResolver: (batch: Array<{ env: Record<string, string> }>) => {
        requests.push(...batch); return [resolved(['a.test.ts'])];
      } });
    expect(result.coverage).toBe('complete');
    expect(requests[0].env).toEqual({ TEMPLATE_CHECKS_CONFIG: 'template-checks.json' });
    expect(enumerateAffectedTaskSelection([task('test', 'UNKNOWN=value vitest run')], options([])).coverage).toBe('partial');
  });

  it('measures the original fixture build lifecycle inputs without building or resolving installed dependencies', () => {
    const repo = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))), '..');
    const parent = join(repo, '.papercusp/scratch');
    mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(join(parent, 'fixture-build-selection-'));
    try {
      for (const sub of ['scripts', 'app', 'public', 'packages/data/src', '.next']) mkdirSync(join(dir, sub), { recursive: true });
      for (const file of ['build.mjs', 'source-identity.mjs', 'dependency-preflight.mjs'])
        writeFileSync(join(dir, 'scripts', file), readFileSync(join(repo, 'apps/slack-asana-bug-drill/scripts', file)));
      writeFileSync(join(dir, 'package.json'), '{"type":"module","dependencies":{"never-installed":"0.0.0"}}');
      writeFileSync(join(dir, 'app/page.tsx'), 'throw new Error("discovery compiled the app");');
      writeFileSync(join(dir, 'packages/data/src/index.ts'), 'throw new Error("discovery bundled data");');
      writeFileSync(join(dir, 'public/logo.svg'), '<svg/>');
      writeFileSync(join(dir, 'next-env.d.ts'), 'declare const input: true;');
      writeFileSync(join(dir, '.next/fixture-build.json'), 'unchanged build sentinel');
      const relativeDir = dir.slice(repo.length + 1).replaceAll('\\', '/');
      const ws = { name: '@bug-drill/fixture', dir: relativeDir,
        scripts: { test: 'vitest run', pretest: 'node scripts/build.mjs' } };
      const discover = () => enumerateAffectedTaskSelection([{ ws, script: 'test' }],
        { root: repo, enumerateSpecifications: true, runResolver: () => [{ ...resolved(['a.test.ts']),
          selectedSpecifications: [{ testFile: `${relativeDir}/a.test.ts`, pool: 'forks', projectName: null,
            testNamePattern: null, testLines: null, testIds: null, testTagsFilter: null }] }] });
      const result = discover();
      expect(result.files).toEqual([`${relativeDir}/a.test.ts`]);
      expect(result.unenumerated).toMatchObject([{ reason: 'unexecuted-lifecycle-command' }]);
      const obligation = result.commandObligations[0];
      expect(obligation).toMatchObject({ kind: 'npm-lifecycle', script: 'pretest',
        command: 'node scripts/build.mjs', executed: false,
        discovery: { check: 'fixture-build', files: [], dependencyClosure: 'unmeasured', runtimeClosure: 'unmeasured' } });
      const originalTask = { id: '@bug-drill/fixture :: test', dir: relativeDir, command: ws.scripts.test };
      const native = preparePartialNativeProducerSelection(result, originalTask, repo);
      expect(native.status).toBe('ready');
      const enrolled = registerPartialNativeProducer(join(dir, 'native.json'), {
        attemptId: 'lifecycle-selection', runGroupId: 'physical-run', root: repo,
        taskKey: originalTask.id, workspaceName: ws.name, sourceCommit: 'f'.repeat(40),
        registeredAtMs: Date.now(), selectedSpecifications: native.selectedSpecifications,
        command: { cmd: 'npm', argv: ['run', 'test'], cwd: dir },
      }, {});
      expect(readPartialNativeProducer(enrolled.path, { taskKey: originalTask.id }))
        .toMatchObject({ selectedSpecifications: native.selectedSpecifications });
      expect(preparePartialContinuationManifest({ root: repo, selection: result, tasks: [originalTask],
        postSuite: { schemaVersion: 1, coverage: 'complete', units: [{ id: 'post:lint', kind: 'post-suite', path: 'package.json' }] } }))
        .toMatchObject({ status: 'ready', operationalAcceptance: false, manifest: { units: [
          { id: `command:${originalTask.id}:0`, kind: 'guard' }, { id: 'post:lint' },
          { id: `test:${relativeDir}/a.test.ts` },
        ] } });
      for (const change of [
        (value: typeof result) => { value.unenumerated.push({ task: originalTask.id, reason: 'unknown-native-config', command: ws.scripts.test }); },
        (value: typeof result) => { Object.assign(value.tasks[0], { selectedSpecifications: [] }); },
        (value: typeof result) => { value.commandObligations = []; },
        (value: typeof result) => { value.commandObligations = [null]; },
        (value: typeof result) => { Object.assign(value.tasks[0], { commandObligations: [{ ...obligation, inputs: null }] }); },
      ]) {
        const changed = structuredClone(result);
        change(changed);
        expect(preparePartialNativeProducerSelection(changed, originalTask, repo).status).toBe('refused');
      }
      const paths = obligation.inputs.map((input: { path: string }) => input.path);
      expect(paths).toEqual(expect.arrayContaining(['scripts/build.mjs', 'scripts/source-identity.mjs',
        'scripts/dependency-preflight.mjs', 'app/page.tsx', 'packages/data/src/index.ts',
        'public/logo.svg', 'next-env.d.ts', 'package.json'].map(path => `${relativeDir}/${path}`)));
      expect(paths.some((path: string) => path.includes('/.next/'))).toBe(false);
      for (const input of obligation.inputs) expect(input.sha256)
        .toBe(createHash('sha256').update(readFileSync(join(repo, input.path))).digest('hex'));
      const before = obligation.inputs.find((input: { path: string }) => input.path.endsWith('/public/logo.svg'))!.sha256;
      writeFileSync(join(dir, 'public/logo.svg'), '<svg>changed asset</svg>');
      expect(preparePartialNativeProducerSelection(result, originalTask, repo))
        .toMatchObject({ status: 'refused', reason: 'native-producer-command-inputs-changed' });
      expect(discover().commandObligations[0].inputs.find((input: { path: string }) => input.path.endsWith('/public/logo.svg'))!.sha256)
        .not.toBe(before);
      expect(readFileSync(join(dir, '.next/fixture-build.json'), 'utf8')).toBe('unchanged build sentinel');
      expect(existsSync(join(dir, 'node_modules'))).toBe(false);
      expect(result.coverage).toBe('partial');
      expect(result.executed).toBe(false);
      expect(result.operationalAcceptance).toBe(false);
      const chained = enumerateAffectedTaskSelection([{ ws: { ...ws,
        scripts: { ...ws.scripts, test: 'npm run first && npm run second', first: 'vitest run', second: 'vitest run' } }, script: 'test' }],
        { root: repo, runResolver: () => [resolved(['a.test.ts'])] });
      expect(preparePartialNativeProducerSelection(chained, originalTask, repo).status).toBe('refused');
      expect(chained.commandObligations[0]).toMatchObject({ step: 0, script: 'pretest',
        discovery: { check: 'fixture-build' }, executed: false });
      const chainScripts = { ...ws.scripts, test: 'npm run first && npm run second',
        first: 'vitest run --config first.config.mjs', second: 'vitest run --config second.config.mjs' };
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', scripts: chainScripts }));
      let leaf = 0;
      const completeChain = enumerateAffectedTaskSelection([{ ws: { ...ws, scripts: chainScripts }, script: 'test' }], {
        root: repo, enumerateSpecifications: true, runResolver: () => {
          const file = `${++leaf}.test.ts`;
          return [{ ...resolved([file]), selectedSpecifications: [{ testFile: `${relativeDir}/${file}`,
            pool: 'forks', projectName: null, testNamePattern: null, testLines: null, testIds: null, testTagsFilter: null }] }];
        },
      });
      const prepareChain = (selection = completeChain) => preparePartialContinuationManifest({ root: repo, selection,
        tasks: [{ id: '@bug-drill/fixture :: test', dir: relativeDir, command: chainScripts.test }],
        postSuite: { schemaVersion: 1, coverage: 'complete', units: [
          { id: 'post:lint', kind: 'post-suite', path: 'package.json' },
        ] } });
      expect(prepareChain()).toMatchObject({ status: 'ready', manifest: { units: [
        { id: 'chain:@bug-drill/fixture :: test', kind: 'guard' },
        { id: 'command:@bug-drill/fixture :: test:step:0:0', kind: 'guard' },
        { id: 'post:lint' }, { id: `test:${relativeDir}/1.test.ts` }, { id: `test:${relativeDir}/2.test.ts` },
      ] } });
      expect(prepareChain({ ...completeChain, commandObligations: [] }))
        .toMatchObject({ status: 'refused', reason: 'command-population-mismatch' });
      const missingHook = structuredClone(completeChain);
      const chain = missingHook.tasks[0];
      if (!chain || !('steps' in chain)) throw new Error('Ordered lifecycle inventory missing');
      chain.steps.shift();
      expect(prepareChain(missingHook)).toMatchObject({ status: 'refused', reason: 'chain-population-mismatch' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps a failed or forged fixture lifecycle discovery as explicit residue with the original command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixture-build-selection-refusal-'));
    try {
      const wsRoot = join(dir, 'fixture');
      mkdirSync(join(wsRoot, 'scripts'), { recursive: true });
      writeFileSync(join(wsRoot, 'package.json'), '{"type":"module"}');
      const ws = { name: '@bug-drill/fixture', dir: 'fixture', scripts: { test: 'vitest run', pretest: 'node scripts/build.mjs' } };
      const base = { schemaVersion: 1, kind: 'command-check-inputs', check: 'fixture-build', files: [],
        inputs: [{ path: 'fixture/package.json', sha256: createHash('sha256').update(readFileSync(join(wsRoot, 'package.json'))).digest('hex') }],
        executed: false, dependencyClosure: 'unmeasured', runtimeClosure: 'unmeasured', operationalAcceptance: false };
      for (const receipt of [{ ...base, executed: true }, { ...base, operationalAcceptance: true },
        { ...base, inputs: [{ ...base.inputs[0], sha256: 'a'.repeat(64) }] },
        { ...base, inputs: [...base.inputs, ...base.inputs] }, { ...base, inputs: [] },
        { ...base, dependencyClosure: 'complete' }, { ...base, files: ['fixture/package.json'] }]) {
        writeFileSync(join(wsRoot, 'scripts/build.mjs'), `console.log('COMMAND_CHECK_SELECTION='+${JSON.stringify(JSON.stringify(receipt))});`);
        const result = enumerateAffectedTaskSelection([{ ws, script: 'test' }],
          { root: dir, runResolver: () => [resolved(['a.test.ts'])] });
        expect(result.commandObligations[0]).toMatchObject({ command: 'node scripts/build.mjs', inputs: null, executed: false });
        expect(result.coverage).toBe('partial');
        expect(result.unenumerated).toHaveLength(2);
      }
      rmSync(join(wsRoot, 'scripts/build.mjs'));
      expect(enumerateAffectedTaskSelection([{ ws, script: 'test' }],
        { root: dir, runResolver: () => [resolved(['a.test.ts'])] }).commandObligations[0].inputs).toBe(null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('enumerates npm shell expansion before native Node globs without importing a test', () => {
    const dir = mkdtempSync(join(tmpdir(), 'node-selection-'));
    try {
      const ws = join(dir, 'packages/core');
      mkdirSync(join(ws, 'src/one/deep'), { recursive: true });
      for (const file of ['src/one/a.node-test.ts', 'src/one/deep/b.node-test.ts'])
        writeFileSync(join(ws, file), 'throw new Error("selection executed a test");');
      const result = enumerateAffectedTaskSelection([task('test', 'node --test --test-global-setup=preflight.mjs src/**/*.node-test.ts')], { root: dir });
      expect(result.unenumerated).toEqual([]);
      // The unquoted npm shell glob already matched one level, so Node receives
      // that literal path, not the original recursive pattern.
      expect(result.files).toEqual(['packages/core/src/one/a.node-test.ts']);
      if (!('shellPatterns' in result.tasks[0])) throw new Error('Node selection metadata missing');
      expect(result.tasks[0].shellPatterns).toEqual(['src/one/a.node-test.ts']);
      expect(result.executed).toBe(false);
      for (const command of ['node --test --test-name-pattern=foo src/*.ts', 'node --test src/*.ts && node more.mjs',
        'node --test ../outside.ts', 'node --test'])
        expect(enumerateAffectedTaskSelection([task('test', command)], { root: dir }).coverage).toBe('partial');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('uses native Vitest project inheritance and in-source/typecheck discovery without collection', () => {
    const repo = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))), '..');
    const dir = mkdtempSync(join(tmpdir(), 'project-selection-'));
    try {
      const ws = join(dir, 'packages/core');
      mkdirSync(ws, { recursive: true });
      writeFileSync(join(ws, 'vitest.config.mts'), `export default {test:{projects:[
        {test:{name:'unit',include:['a.test.ts']}},
        {test:{name:'source',include:[],includeSource:['inside.ts']}},
        {test:{name:'types',typecheck:{enabled:true,only:true,include:['a.test-d.ts']}}}
      ]}};`);
      writeFileSync(join(ws, 'a.test.ts'), 'throw new Error("selection executed a test");');
      writeFileSync(join(ws, 'inside.ts'), 'if (import.meta.vitest) throw new Error("selection executed source");');
      writeFileSync(join(ws, 'a.test-d.ts'), 'throw new Error("selection executed typecheck");');
      const result = enumerateAffectedTaskSelection([task()], { root: dir, runResolver: (requests: unknown[]) => {
        const output = execFileSync(process.execPath, [join(repo, 'scripts/resolve-vitest-config-contracts.mjs')],
          { cwd: repo, input: JSON.stringify({ requests }), encoding: 'utf8', timeout: 30_000 });
        return JSON.parse(output.split('\n').reverse().find(line => line.startsWith('PC_VITEST_CONFIG_CONTRACTS='))!
          .slice('PC_VITEST_CONFIG_CONTRACTS='.length)).results;
      } });
      expect(result.unenumerated).toEqual([]);
      expect(result.files).toEqual(['packages/core/a.test-d.ts', 'packages/core/a.test.ts', 'packages/core/inside.ts']);
      if (!('projects' in result.tasks[0])) throw new Error('Vitest project metadata missing');
      expect(result.tasks[0].projects.map((project: { name: string }) => project.name).sort()).toEqual(['source', 'types', 'unit']);
      expect(result.executed).toBe(false);
      expect(result.runtimeClosure).toBe('unmeasured');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);

  it('refuses duplicate, escaping, or unqualified file populations', () => {
    for (const result of [resolved(['../outside.test.ts']), resolved(['a.test.ts', 'a.test.ts']),
      { ok: true, files: ['a.test.ts'] }]) {
      expect(enumerateAffectedTaskSelection([task()], options([result])).unenumerated).toHaveLength(1);
    }
  });

  it('records overlapping task populations instead of accepting a false partition', () => {
    const result = enumerateAffectedTaskSelection([task(), task('test:integration')],
      options([resolved(['a.test.ts']), resolved(['a.test.ts'])]));
    expect(result.coverage).toBe('partial');
    expect(result.overlaps).toEqual(['packages/core/a.test.ts']);
    expect(result.fileOccurrences).toEqual([
      { task: '@probe/core :: test', step: null, command: 'vitest run', file: 'packages/core/a.test.ts', kind: 'test-file' },
      { task: '@probe/core :: test:integration', step: null, command: 'vitest run', file: 'packages/core/a.test.ts', kind: 'test-file' },
    ]);
  });

  it('retains ordered local npm chains, lifecycle checks and unknown Astro steps without inventing files', () => {
    const base = task();
    base.ws.scripts = { test: 'npm run docs && npm run unit', docs: 'astro check',
      unit: 'vitest run', preunit: 'node setup.mjs', postunit: 'node cleanup.mjs' };
    const result = enumerateAffectedTaskSelection([base], options([resolved(['a.test.ts'])]));
    expect(result.files).toEqual(['packages/core/a.test.ts']);
    expect(result.coverage).toBe('partial');
    expect(result.unenumerated.map(row => row.reason)).toEqual([
      'astro-sync-not-requested', 'unexecuted-lifecycle-command', 'unexecuted-lifecycle-command',
    ]);
    const entry = result.tasks[0];
    if (!('steps' in entry)) throw new Error('Original chain missing');
    expect(entry.command).toBe(base.ws.scripts.test);
    expect(entry.steps.map((step: { command: string }) => step.command)).toEqual([
      'astro check', 'node setup.mjs', 'vitest run', 'node cleanup.mjs',
    ]);
    expect(result.commandObligations.map(row => row.command)).toEqual(['astro check', 'node setup.mjs', 'node cleanup.mjs']);
    expect(result.executed).toBe(false);
    for (const scripts of [{ test: 'npm run again && vitest run', again: 'npm run test' },
      { test: 'npm run absent && vitest run' }]) {
      expect(enumerateAffectedTaskSelection([{ ...base, ws: { ...base.ws, scripts } }], options([]))
        .unenumerated[0].reason).toBe('invalid-local-script-chain');
    }
  });

  it('requires explicit Astro sync and refuses pre-sync or tampered populations without dropping the check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astro-selection-qualification-'));
    try {
      const file = 'packages/core/checked.ts';
      mkdirSync(join(dir, 'packages/core'), { recursive: true });
      writeFileSync(join(dir, file), 'export const checked = true;');
      const hash = createHash('sha256').update(readFileSync(join(dir, file))).digest('hex');
      const receipt = { ok: true, enumerated: true, repositoryFiles: [file],
        inputs: [{ path: file, sha256: hash }], sync: { status: 'completed', beforePopulation: true },
        executed: false, runtimeClosure: 'unmeasured', operationalAcceptance: false };
      const request = task('test', 'astro check');
      let called = false;
      const blocked = enumerateAffectedTaskSelection([request], { root: dir,
        runResolver: () => { called = true; return [receipt]; } });
      expect(called).toBe(false);
      expect(blocked.unenumerated[0].reason).toBe('astro-sync-not-requested');
      expect(blocked.commandObligations).toMatchObject([{ command: 'astro check', executed: false }]);
      for (const bad of [{ ...receipt, sync: undefined }, { ...receipt, executed: true },
        { ...receipt, inputs: [{ path: file, sha256: 'f'.repeat(64) }] },
        { ...receipt, repositoryFiles: [] }, { ...receipt, operationalAcceptance: true }]) {
        const result = enumerateAffectedTaskSelection([request], { root: dir, syncAstro: true,
          runResolver: () => [bad] });
        expect(result.coverage).toBe('partial');
        expect(result.files).toEqual([]);
        expect(result.commandObligations).toMatchObject([{ command: 'astro check', executed: false }]);
      }
      const accepted = enumerateAffectedTaskSelection([request], { root: dir, syncAstro: true,
        runResolver: (requests: unknown[]) => {
          expect(requests).toMatchObject([{ runner: 'astro-check', syncBeforeCheck: true }]);
          return [receipt];
        } });
      expect(accepted.files).toEqual([file]);
      expect(accepted.coverage).toBe('partial');
      expect(accepted.unenumerated[0].reason).toBe('unexecuted-command-obligations');
      expect(accepted.commandObligations[0].inputs).toEqual(receipt.inputs);
      expect(preparePartialContinuationManifest({ root: dir,
        tasks: [{ id: '@probe/core :: test', dir: request.ws.dir, command: request.ws.scripts.test }],
        selection: accepted, postSuite: { schemaVersion: 1, coverage: 'complete',
          units: [{ id: 'post:lint', kind: 'post-suite', path: 'package.json' }] },
      })).toMatchObject({ status: 'ready', manifest: { units: [
        { id: 'command:@probe/core :: test:0', kind: 'guard' },
        { id: 'post:lint', kind: 'post-suite' },
      ] } });
      const failedReceipt = { ok: false, error: 'sync fixture failed',
        diagnostics: { currentPhase: 'sync', elapsedMs: 21, phases: {} } };
      const failed = enumerateAffectedTaskSelection([request], { root: dir, syncAstro: true,
        runResolver: () => [failedReceipt] });
      expect(failed.unenumerated[0].reason).toBe('sync fixture failed');
      expect(failed.commandObligations[0]).toMatchObject({ executed: false, inputs: null,
        discovery: failedReceipt });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('uses the native Astro checker population after sync while keeping diagnostics unexecuted', () => {
    const repo = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))), '..');
    // Astro excludes node_modules from its project population, so keep the
    // isolated fixture in the repo's ignored scratch area, with inherited deps.
    const parent = join(repo, '.papercusp/scratch');
    mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(join(parent, 'astro-selection-fixture-'));
    const external = mkdtempSync(join(tmpdir(), 'astro-external-input-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      writeFileSync(join(dir, 'astro.config.mjs'), `export default { integrations: [{ name: 'selection-fixture', hooks: {
        'astro:config:done': ({injectTypes}) => injectTypes({filename: 'selection-generated.d.ts', content: 'declare const syncedValue: string;'})
      }}] };`);
      writeFileSync(join(dir, 'tsconfig.json'), '{"extends":"astro/tsconfigs/strict","include":[".astro/types.d.ts","src/**/*"],"exclude":["dist"]}');
      writeFileSync(join(dir, 'src/checked.ts'), 'export const broken: string = 123;');
      writeFileSync(join(dir, 'src/page.astro'), '<p>Hello</p>');
      writeFileSync(join(dir, 'src/skipped.vue'), '<template>hello</template>');
      writeFileSync(join(dir, 'src/skipped.svelte'), '<p>hello</p>');
      const relativeDir = dir.slice(repo.length + 1).replaceAll('\\', '/');
      const result = enumerateAffectedTaskSelection([{ ws: { name: '@probe/astro', dir: relativeDir,
        scripts: { test: 'astro check' } }, script: 'test' }], { root: repo, syncAstro: true });
      expect(result.unenumerated).toMatchObject([{ reason: 'unexecuted-command-obligations' }]);
      expect(result.files).toEqual(expect.arrayContaining([
        `${relativeDir}/.astro/types.d.ts`, `${relativeDir}/src/checked.ts`, `${relativeDir}/src/page.astro`,
      ]));
      expect(result.files.some(file => /\.(vue|svelte)$/.test(file))).toBe(false);
      expect(readFileSync(join(dir, '.astro/types.d.ts'), 'utf8')).toContain('selection-generated.d.ts');
      expect(result.commandObligations[0]).toMatchObject({ check: 'astro-check', executed: false,
        discovery: { sync: { status: 'completed', beforePopulation: true }, executed: false } });
      const diagnostics = result.commandObligations[0].discovery.diagnostics;
      expect(diagnostics.currentPhase).toBe('completed');
      for (const name of ['syncMs', 'checkerMs', 'populationMs'])
        expect(diagnostics.phases[name]).toBeGreaterThanOrEqual(0);
      expect(diagnostics.elapsedMs).toBeGreaterThanOrEqual(diagnostics.phases.syncMs);
      expect(result.runtimeClosure).toBe('unmeasured');
      expect(result.operationalAcceptance).toBe(false);
      expect(result.commandObligations[0].inputs.some((input: { path: string }) =>
        input.path.startsWith('node_modules/astro/'))).toBe(true);
      expect(preparePartialContinuationManifest({ root: repo,
        tasks: [{ id: '@probe/astro :: test', dir: relativeDir, command: 'astro check' }],
        selection: result, postSuite: { schemaVersion: 1, coverage: 'complete',
          units: [{ id: 'post:lint', kind: 'post-suite', path: 'package.json' }] },
      })).toMatchObject({ status: 'ready', manifest: { units: [
        { id: 'command:@probe/astro :: test:0', kind: 'guard' },
        { id: 'post:lint', kind: 'post-suite' },
      ] } });
      // An external first-party input stays outside the boundary even when
      // its path contains node_modules; it is not this install's dependency.
      mkdirSync(join(external, 'node_modules'), { recursive: true });
      const escaped = join(external, 'node_modules', 'escaped.ts');
      writeFileSync(escaped, 'export const escaped = true;');
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ extends: 'astro/tsconfigs/strict',
        files: [escaped], include: ['.astro/types.d.ts', 'src/**/*'], exclude: ['dist'] }));
      const refused = enumerateAffectedTaskSelection([{ ws: { name: '@probe/astro', dir: relativeDir,
        scripts: { test: 'astro check' } }, script: 'test' }], { root: repo, syncAstro: true });
      expect(refused.files).toEqual([]);
      expect(refused.unenumerated).toMatchObject([{ reason: 'astro-input-escapes-repository' }]);
      expect(refused.operationalAcceptance).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  }, 40_000);

  it('retains the voice guard native input census as an unexecuted command obligation', () => {
    const repo = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))), '..');
    const ws = { name: '@probe/operator', dir: 'apps/operator', scripts: { 'lint:el-tools': 'node scripts/el-tools-check.mjs' } };
    const result = enumerateAffectedTaskSelection([{ ws, script: 'lint:el-tools' }], { root: repo });
    expect(result.files).toEqual([]);
    expect(result.coverage).toBe('partial');
    expect(result.unenumerated[0].reason).toBe('unexecuted-command-obligations');
    expect(result.commandObligations).toHaveLength(1);
    const obligation = result.commandObligations[0];
    expect(obligation).toMatchObject({ check: 'el-tools-drift', executed: false });
    expect(obligation.inputs.map((input: { path: string }) => input.path)).toEqual(expect.arrayContaining([
      'apps/operator/scripts/el-tools-check.mjs', 'apps/operator/scripts/el-agent-sync.mjs',
    ]));
    const defs = readdirSync(join(repo, 'packages/operator-core/lib/commands/defs'))
      .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'index.ts');
    expect(obligation.inputs.filter((input: { path: string }) => input.path.startsWith('packages/operator-core/lib/commands/defs/')))
      .toHaveLength(defs.length);
    for (const input of obligation.inputs) expect(input.sha256)
      .toBe(createHash('sha256').update(readFileSync(join(repo, input.path))).digest('hex'));
    expect(result.runtimeClosure).toBe('unmeasured');
    expect(result.operationalAcceptance).toBe(false);
    expect(preparePartialContinuationManifest({ root: repo,
      tasks: [{ id: '@probe/operator :: lint:el-tools', dir: ws.dir, command: ws.scripts['lint:el-tools'] }],
      selection: result, postSuite: { schemaVersion: 1, coverage: 'complete',
        units: [{ id: 'post:lint', kind: 'post-suite', path: 'package.json' }] },
    })).toMatchObject({ status: 'ready', manifest: { units: [
      { id: 'command:@probe/operator :: lint:el-tools:0', kind: 'guard' },
      { id: 'post:lint', kind: 'post-suite' },
    ] } });
  });

  it('refuses a repeated test-file population within an ordered chain', () => {
    const base = task();
    base.ws.scripts = { test: 'npm run one && npm run two', one: 'vitest run', two: 'vitest run' };
    const result = enumerateAffectedTaskSelection([base], options([resolved(['a.test.ts'])]));
    expect(result.files).toEqual(['packages/core/a.test.ts']);
    expect(result.coverage).toBe('partial');
    expect(result.unenumerated[0].reason).toBe('overlapping-chain-file-population');
    expect(result.fileOccurrences).toEqual([
      { task: '@probe/core :: test', step: 0, command: 'vitest run', file: 'packages/core/a.test.ts', kind: 'test-file' },
      { task: '@probe/core :: test', step: 1, command: 'vitest run', file: 'packages/core/a.test.ts', kind: 'test-file' },
    ]);
  });

  function orderedFixture(command = 'npm run one && npm run two') {
    const root = mkdtempSync(join(tmpdir(), 'ordered-manifest-'));
    const dir = 'packages/core';
    mkdirSync(join(root, dir), { recursive: true });
    const scripts = { test: command, one: 'vitest run --config one.config.mjs',
      two: 'vitest run --config two.config.mjs' };
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ scripts }));
    const files = ['a.test.ts', 'b.test.ts'];
    for (const file of files) writeFileSync(join(root, dir, file), 'throw new Error("discovery executed a test");');
    let index = 0;
    const selection = enumerateAffectedTaskSelection([{ ws: { name: '@probe/core', dir, scripts }, script: 'test' }], {
      root, enumerateSpecifications: true, runResolver: () => {
        const file = files[index++ % files.length]!;
        return [{ ...resolved([file]), selectedSpecifications: [{ testFile: `${dir}/${file}`,
          pool: 'forks', projectName: null, testNamePattern: null, testLines: null, testIds: null, testTagsFilter: null }] }];
      },
    });
    return { root, selection, tasks: [{ id: '@probe/core :: test', dir, command }],
      postSuite: { schemaVersion: 1, coverage: 'complete', units: [
        { id: 'post:lint', kind: 'post-suite', path: 'package.json' },
      ] } };
  }

  it('freezes ordered native leaves and a distinct original-chain execution obligation', () => {
    const fixture = orderedFixture();
    try {
      expect(preparePartialContinuationManifest(fixture)).toMatchObject({ status: 'ready', operationalAcceptance: false,
        manifest: { units: [
          { id: 'chain:@probe/core :: test', kind: 'guard', path: 'packages/core/package.json' },
          { id: 'post:lint' }, { id: 'test:packages/core/a.test.ts', kind: 'test' },
          { id: 'test:packages/core/b.test.ts', kind: 'test' },
        ] } });
      expect(fixture.selection.executed).toBe(false);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it.each(['omitted-step', 'reordered-step', 'omitted-native-file', 'omitted-specification',
    'unknown-step', 'omitted-residue', 'changed-script', 'duplicate-test', 'null-step'])(
    'refuses an ordered population with %s before claiming any execution', mutation => {
      const fixture = orderedFixture();
      try {
        const chain = fixture.selection.tasks[0] as any;
        if (mutation === 'omitted-step') chain.steps.pop();
        if (mutation === 'reordered-step') chain.steps.reverse();
        if (mutation === 'omitted-native-file') chain.steps[0].files = [];
        if (mutation === 'omitted-specification') chain.steps[0].discovery[0].selectedSpecifications = [];
        if (mutation === 'unknown-step') {
          chain.steps[0].unenumerated.push({ reason: 'unsupported-task-command' });
          fixture.selection.unenumerated.push({ task: chain.id, step: 0,
            command: chain.steps[0].command, reason: 'unsupported-task-command' });
        }
        if (mutation === 'omitted-residue') fixture.selection.unenumerated.push({ task: chain.id,
          step: 0, command: chain.steps[0].command, reason: 'unexecuted-command-obligations' });
        if (mutation === 'changed-script') writeFileSync(join(fixture.root, 'packages/core/package.json'),
          JSON.stringify({ scripts: { test: 'vitest run' } }));
        if (mutation === 'duplicate-test') {
          chain.steps[1].files = chain.steps[0].files;
          chain.steps[1].discovery[0].files = chain.steps[0].files;
          chain.steps[1].discovery[0].selectedSpecifications = chain.steps[0].discovery[0].selectedSpecifications;
          chain.files = chain.steps[0].files;
        }
        if (mutation === 'null-step') chain.steps[0] = null;
        expect(preparePartialContinuationManifest(fixture)).toMatchObject({ status: 'refused', manifest: null });
      } finally { rmSync(fixture.root, { recursive: true, force: true }); }
    });

  it('keeps an Astro guard and a native test of the same path distinct inside the original chain', () => {
    const root = mkdtempSync(join(tmpdir(), 'ordered-astro-manifest-'));
    try {
      const dir = 'packages/core', file = `${dir}/a.test.ts`, command = 'astro check && vitest run';
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ scripts: { test: command } }));
      writeFileSync(join(root, file), 'throw new Error("selection ran a test");');
      const selection = enumerateAffectedTaskSelection([task('test', command)], {
        root, syncAstro: true, enumerateSpecifications: true,
        runResolver: (requests: Array<{ runner?: string }>) => requests.map(request => request.runner === 'astro-check' ? {
          ok: true, enumerated: true, repositoryFiles: [file],
          inputs: [{ path: file, sha256: createHash('sha256').update(readFileSync(join(root, file))).digest('hex') }],
          sync: { status: 'completed', beforePopulation: true }, executed: false,
          runtimeClosure: 'unmeasured', operationalAcceptance: false,
        } : { ...resolved(['a.test.ts']), selectedSpecifications: [{ testFile: file, pool: 'forks',
          projectName: null, testNamePattern: null, testLines: null, testIds: null, testTagsFilter: null }] }),
      });
      // Astro's check input is a separate occurrence, not a second native test.
      expect(selection.unenumerated.map(row => row.reason)).toEqual(['unexecuted-command-obligations']);
      const prepared = preparePartialContinuationManifest({ root, selection,
        tasks: [{ id: '@probe/core :: test', dir, command }],
        postSuite: { schemaVersion: 1, coverage: 'complete', units: [
          { id: 'post:lint', kind: 'post-suite', path: 'package.json' },
        ] } });
      expect(prepared).toMatchObject({ status: 'ready', manifest: { units: [
        { id: 'chain:@probe/core :: test' }, { id: 'command:@probe/core :: test:step:0:0', kind: 'guard' },
        { id: 'post:lint' }, { id: `test:${file}`, kind: 'test' },
      ] } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('retains both the Astro check input and Vitest execution occurrence of one source path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astro-vitest-occurrences-'));
    try {
      const file = 'packages/core/a.test.ts';
      mkdirSync(join(dir, 'packages/core'), { recursive: true });
      writeFileSync(join(dir, file), 'export const checked = true;');
      const astro = { ok: true, enumerated: true, repositoryFiles: [file],
        inputs: [{ path: file, sha256: createHash('sha256').update(readFileSync(join(dir, file))).digest('hex') }],
        sync: { status: 'completed', beforePopulation: true }, executed: false,
        runtimeClosure: 'unmeasured', operationalAcceptance: false };
      const result = enumerateAffectedTaskSelection([task('test', 'astro check && vitest run')], {
        root: dir, syncAstro: true,
        runResolver: (requests: Array<{ runner?: string }>) => requests.map(request =>
          request.runner === 'astro-check' ? astro : resolved(['a.test.ts'])),
      });
      expect(result.files).toEqual([file]);
      expect(result.fileOccurrences).toEqual([
        { task: '@probe/core :: test', step: 0, command: 'astro check', file, kind: 'check-input' },
        { task: '@probe/core :: test', step: 1, command: 'vitest run', file, kind: 'test-file' },
      ]);
      expect(result.commandObligations[0]).toMatchObject({ command: 'astro check', executed: false });
      expect(result.coverage).toBe('partial');
      expect(result.operationalAcceptance).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('discovers actual aggregate array and guard inputs without executing any selftest or hiding disk drift', () => {
    const repo = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))), '..');
    const dir = mkdtempSync(join(tmpdir(), 'aggregate-selection-'));
    try {
      const lib = join(dir, 'desktop/bin/lib');
      mkdirSync(lib, { recursive: true });
      const source = readFileSync(join(repo, 'papercusp-desktop/bin/lib/run-selftests.sh'), 'utf8')
        .replace(/TESTS=\([\s\S]*?\n\)/, 'TESTS=(\n  listed.selftest.sh\n)');
      writeFileSync(join(lib, 'run-selftests.sh'), source);
      writeFileSync(join(lib, 'pipefail-predicate.baseline.txt'), '');
      for (const name of ['listed', 'unlisted']) writeFileSync(join(lib, `${name}.selftest.sh`),
        `touch ${join(dir, 'executed')}\nexit 91\n`);
      const result = enumerateAffectedTaskSelection([{ ws: { name: '@probe/desktop', dir: 'desktop',
        scripts: { test: 'bash bin/lib/run-selftests.sh' } }, script: 'test' }], { root: dir });
      expect(result.files).toEqual(['desktop/bin/lib/listed.selftest.sh']);
      const obligation = result.commandObligations[0];
      expect(obligation.discovery).toMatchObject({ listed: ['listed.selftest.sh'],
        disk: ['listed.selftest.sh', 'unlisted.selftest.sh'],
        guards: ['array-disk-completeness', 'pipefail-predicate-baseline'], executed: false });
      expect(obligation.inputs.map((input: { path: string }) => input.path)).toContain('desktop/bin/lib/unlisted.selftest.sh');
      expect(result.coverage).toBe('partial');
      expect(existsSync(join(dir, 'executed'))).toBe(false);
      rmSync(join(lib, 'listed.selftest.sh'));
      expect(enumerateAffectedTaskSelection([{ ws: { name: '@probe/desktop', dir: 'desktop',
        scripts: { test: 'bash bin/lib/run-selftests.sh' } }, script: 'test' }], { root: dir }).commandObligations).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reuses the workspace launcher full-suite and integration configuration decisions', () => {
    const requests: Array<{ config: string | false }> = [];
    const result = enumerateAffectedTaskSelection([
      task('test', 'node ../../scripts/workspace-test.mjs --passWithNoTests'),
      task('test:integration', 'node ../../scripts/workspace-test.mjs --workspace-integration --passWithNoTests'),
    ], { root: '/repo', filterDir: tmpdir(), runResolver: (batch: Array<{ config: string | false }>) => {
      requests.push(...batch); return [resolved(['a.test.ts']), resolved(['a.integration.test.ts'])];
    } });
    expect(result.unenumerated).toEqual([]);
    expect(requests[1].config).toBe('vitest.integration.config.ts');
  });

  it('uses the actual lane cwd, native include/exclude and related filter in one resolver batch', () => {
    const repo = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))), '..');
    const dir = mkdtempSync(join(tmpdir(), 'selection-native-'));
    try {
      mkdirSync(join(dir, 'packages/core'), { recursive: true });
      const ws = join(dir, 'packages/core');
      const shared = join(repo, 'libs/test-config/src/vitest-config.ts');
      writeFileSync(join(ws, 'vitest.config.mts'), `import { defineVitestConfig } from ${JSON.stringify(shared)};\nexport default defineVitestConfig({layer:'unit',laneSplit:true,exclude:['**/excluded.test.ts']});`);
      for (const file of ['pure.test.ts', 'other.test.ts', 'excluded.test.ts']) writeFileSync(join(ws, file), '// pure fixture');
      writeFileSync(join(ws, 'stateful.test.ts'), 'vi.mock("fixture")');
      mkdirSync(join(dir, 'packages/shared'));
      writeFileSync(join(dir, 'packages/shared/outside.test.ts'), '// owned outside the workspace');
      writeFileSync(join(ws, 'cross.config.mts'), `import { defineVitestConfig } from ${JSON.stringify(shared)};\nexport default defineVitestConfig({layer:'unit',include:['../shared/*.test.ts']});`);
      const requests: unknown[] = [];
      const runResolver = (batch: unknown[]) => {
        requests.push(...batch);
        const output = execFileSync(process.execPath, [join(repo, 'scripts/resolve-vitest-config-contracts.mjs')],
          { cwd: repo, input: JSON.stringify({ requests: batch }), encoding: 'utf8', timeout: 30_000 });
        return JSON.parse(output.split('\n').reverse().find(line => line.startsWith('PC_VITEST_CONFIG_CONTRACTS='))!
          .slice('PC_VITEST_CONFIG_CONTRACTS='.length)).results;
      };
      const result = enumerateAffectedTaskSelection([
        task('test:lane-pure', `PC_TEST_LANE=pure node ${join(repo, 'scripts/run-vitest-pure-lane.mjs')}`, ['pure.test.ts', 'stateful.test.ts', 'excluded.test.ts']),
        task('test:lane-stateful', 'PC_TEST_LANE=stateful vitest run'),
        task('test:cross', 'vitest run --config cross.config.mts'),
      ], { root: dir, filterDir: dir, runResolver });
      expect(requests).toHaveLength(3);
      expect(result.unenumerated).toEqual([]);
      expect(result.files).toEqual(['packages/core/pure.test.ts', 'packages/core/stateful.test.ts', 'packages/shared/outside.test.ts']);
      expect(result.tasks[0].files).toEqual(['packages/core/pure.test.ts']);
      expect(result.tasks[1].files).toEqual(['packages/core/stateful.test.ts']);
      expect(result.tasks[2].files).toEqual(['packages/shared/outside.test.ts']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);
});
const BLUEPRINT_STEPS_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'blueprint-steps');

/** Build a fake fs from a { path: contents } map. */
function vfs(files: Record<string, string>) {
  const names = Object.keys(files);
  return {
    list: (dir: string) => names.filter((n) => n.startsWith(dir + '/')),
    read: (p: string) => (p in files ? files[p] : null),
    exists: (p: string) => p in files,
  };
}

describe('classifySpecifier', () => {
  it('separates relative, alias and bare specifiers', () => {
    expect(classifySpecifier('./sibling')).toBe('relative');
    expect(classifySpecifier('../up')).toBe('relative');
    expect(classifySpecifier('@/app/thing')).toBe('alias');
    expect(classifySpecifier('#internal')).toBe('alias');
    // Bare is deliberately OUT of graph: cross-package effects are covered by
    // workspace-level selection, not this index.
    expect(classifySpecifier('node:fs')).toBe('bare');
    expect(classifySpecifier('vitest')).toBe('bare');
    expect(classifySpecifier('@papercusp/operator-core')).toBe('bare');
  });
});

describe('isTestFile', () => {
  it('recognises the suffixes vitest collects, and nothing else', () => {
    expect(isTestFile('/a/b.test.ts')).toBe(true);
    expect(isTestFile('/a/b.test.tsx')).toBe(true);
    expect(isTestFile('/a/b.spec.ts')).toBe(true);
    expect(isTestFile('/a/b.ts')).toBe(false);
    // The positive control for the negative case: a file merely CONTAINING "test".
    expect(isTestFile('/a/tested-thing.ts')).toBe(false);
  });
});

describe('selectRelatedTests — narrowing', () => {
  it('selects only the test that transitively imports the changed file', () => {
    const fs = vfs({
      [`${ROOT}/leaf.ts`]: 'export const leaf = 1;',
      [`${ROOT}/mid.ts`]: `import { leaf } from './leaf';`,
      [`${ROOT}/uses-leaf.test.ts`]: `import './mid';`,
      [`${ROOT}/unrelated.ts`]: 'export const other = 2;',
      [`${ROOT}/unrelated.test.ts`]: `import './unrelated';`,
      [`${ROOT}/also-unrelated.test.ts`]: `import './unrelated';`,
      [`${ROOT}/third.test.ts`]: `import './unrelated';`,
      [`${ROOT}/fourth.test.ts`]: `import './unrelated';`,
    });

    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [`${ROOT}/leaf.ts`],
      fs,
    });

    expect(r.mode).toBe('related');
    // Transitive: leaf <- mid <- uses-leaf.test.ts
    expect(r.selected).toEqual([`${ROOT}/uses-leaf.test.ts`]);
    expect(r.total).toBe(5);
  });

  it('always selects a changed TEST file itself, even when nothing imports it', () => {
    const fs = vfs({
      [`${ROOT}/a.ts`]: 'export const a = 1;',
      [`${ROOT}/orphan.test.ts`]: 'expect(1).toBe(1);',
      [`${ROOT}/b.test.ts`]: `import './a';`,
      [`${ROOT}/c.test.ts`]: `import './a';`,
      [`${ROOT}/d.test.ts`]: `import './a';`,
    });

    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [`${ROOT}/orphan.test.ts`],
      fs,
    });

    expect(r.mode).toBe('related');
    expect(r.selected).toEqual([`${ROOT}/orphan.test.ts`]);
  });

  it('follows alias specifiers when a mapping is supplied', () => {
    const fs = vfs({
      [`${ROOT}/app/target.ts`]: 'export const t = 1;',
      [`${ROOT}/aliased.test.ts`]: `import '@/app/target';`,
      [`${ROOT}/x.ts`]: 'export const x = 1;',
      [`${ROOT}/p.test.ts`]: `import './x';`,
      [`${ROOT}/q.test.ts`]: `import './x';`,
      [`${ROOT}/r.test.ts`]: `import './x';`,
    });

    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [`${ROOT}/app/target.ts`],
      aliases: [{ prefix: '@/', target: `${ROOT}/`, wildcard: true }],
      fs,
    });

    expect(r.mode).toBe('related');
    expect(r.selected).toEqual([`${ROOT}/aliased.test.ts`]);
  });
});

describe('selectRelatedTests — every rail fails toward running MORE tests', () => {
  it('falls back to the full suite when an intra-repo import cannot be resolved', () => {
    // `@/missing` has no alias mapping, so the graph has a HOLE. The safe reading of
    // a hole is "this test might reach the change", not "it does not".
    const fs = vfs({
      [`${ROOT}/leaf.ts`]: 'export const leaf = 1;',
      [`${ROOT}/hole.test.ts`]: `import '@/missing/thing';`,
      [`${ROOT}/other.test.ts`]: `import './leaf';`,
    });

    const index = buildIndex({ rootDir: ROOT, fs });
    expect(index.unresolved.has(`${ROOT}/hole.test.ts`)).toBe(true);

    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [`${ROOT}/leaf.ts`],
      fs,
    });

    // Both tests selected => 2/2 is over threshold => full suite. The hole widened
    // the selection rather than narrowing it, which is the whole point.
    expect(r.mode).toBe('full');
  });

  it('selects a test when an unresolved alias appears in its transitive closure', () => {
    const fs = vfs({
      [`${ROOT}/target.ts`]: 'export const target = 1;',
      [`${ROOT}/mid.ts`]: `import '@/unmapped/target';`,
      [`${ROOT}/holey.test.ts`]: `import './mid';`,
      [`${ROOT}/direct.test.ts`]: `import './target';`,
      [`${ROOT}/unrelated.test.ts`]: 'expect(1).toBe(1);',
    });
    const index = buildIndex({ rootDir: ROOT, fs });
    expect(index.unresolved.has(`${ROOT}/mid.ts`)).toBe(true);
    expect(index.unresolved.has(`${ROOT}/holey.test.ts`)).toBe(false);

    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [`${ROOT}/target.ts`],
      fs,
      index,
    });

    expect(r.mode).toBe('related');
    expect(r.selected).toEqual([`${ROOT}/direct.test.ts`, `${ROOT}/holey.test.ts`]);
  });

  it('runs everything when the change is outside the indexed root', () => {
    const fs = vfs({
      [`${ROOT}/a.ts`]: 'export const a = 1;',
      [`${ROOT}/a.test.ts`]: `import './a';`,
    });

    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: ['/repo/other-package/lib/z.ts'],
      fs,
    });

    expect(r.mode).toBe('full');
    expect(r.reason).toBe('no-changed-paths-in-scope');
  });

  it('runs everything for mixed external source and local test changes', () => {
    const external = '/repo/scripts/shared.ts';
    const fs = vfs({
      [external]: 'export const shared = 1;',
      [`${ROOT}/changed.test.ts`]: 'expect(1).toBe(1);',
      [`${ROOT}/uses-shared.test.ts`]: `import '../scripts/shared';`,
      [`${ROOT}/unrelated.test.ts`]: 'expect(1).toBe(1);',
    });
    // The external import resolves: omission cannot be blamed on a graph hole.
    const index = buildIndex({ rootDir: ROOT, fs });
    expect(index.unresolved.size).toBe(0);
    const localOnly = selectRelatedTests({
      rootDir: ROOT, changedPaths: [`${ROOT}/changed.test.ts`], fs, index,
    });
    expect(localOnly.selected).toEqual([`${ROOT}/changed.test.ts`]);

    const mixed = selectRelatedTests({
      rootDir: ROOT, changedPaths: [external, `${ROOT}/changed.test.ts`], fs, index,
    });
    expect(mixed.mode).toBe('full');
    expect(mixed.reason).toBe('changed-paths-outside-scope');
    expect(mixed.total).toBe(3);
    expect(mixed.executedMap.applied).toBe(false);
  });

  it('does not narrow mixed workspace changes through unindexed package imports', () => {
    const fs = vfs({
      [`${ROOT}/local.ts`]: 'export const local = 1;',
      [`${ROOT}/uses-local.test.ts`]: `import './local';`,
      [`${ROOT}/uses-package.test.ts`]: `import '@papercusp/shared';`,
      [`${ROOT}/unrelated.test.ts`]: 'expect(1).toBe(1);',
    });
    const mixed = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [`${ROOT}/local.ts`, '/repo/shared/source.ts'],
      fs,
    });
    expect(mixed.mode).toBe('full');
    expect(mixed.reason).toBe('changed-paths-outside-scope');
    expect(mixed.total).toBe(3);
  });

  it('runs everything when an in-scope change reaches NO test (a graph gap, not proof of no coverage)', () => {
    const fs = vfs({
      [`${ROOT}/lonely.ts`]: 'export const l = 1;',
      [`${ROOT}/a.test.ts`]: 'expect(1).toBe(1);',
      [`${ROOT}/b.test.ts`]: 'expect(1).toBe(1);',
    });

    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [`${ROOT}/lonely.ts`],
      fs,
    });

    expect(r.mode).toBe('full');
    expect(r.reason).toBe('empty-selection');
  });

  it('runs everything when selection exceeds the threshold — a barrel change buys nothing', () => {
    // The measured reality in operator-core: a barrel is imported by most tests, so
    // "related" degenerates to "everything" and the subset is pure overhead.
    const files: Record<string, string> = {
      [`${ROOT}/core.ts`]: 'export const core = 1;',
      [`${ROOT}/barrel.ts`]: `export * from './core';`,
    };
    for (let i = 0; i < 10; i++) files[`${ROOT}/t${i}.test.ts`] = `import './barrel';`;

    const r = selectRelatedTests({ rootDir: ROOT, changedPaths: [`${ROOT}/core.ts`], fs: vfs(files) });

    expect(r.mode).toBe('full');
    expect(r.reason).toMatch(/^over-threshold\(10\/10\)$/);
    expect(r.threshold).toBe(RELATED_WIDEN_THRESHOLD_DEFAULT);
  });

  // P-001 (gate-latency-selection-and-retry-policy-2026-09-06): widening is a COST rule, not a
  // soundness rail. Gate run e70cd139 selected 3,849 of 6,493 operator-core files (59%) and the
  // old 0.5 default widened it to the whole lane — 2,634 unrelated files for nothing.
  it('keeps a majority-share selection RELATED under the default — 6/10 is not "everything"', () => {
    const files: Record<string, string> = {
      [`${ROOT}/hub.ts`]: 'export const hub = 1;',
      [`${ROOT}/leaf.ts`]: 'export const leaf = 1;',
    };
    for (let i = 0; i < 6; i++) files[`${ROOT}/hub${i}.test.ts`] = `import './hub';`;
    for (let i = 0; i < 4; i++) files[`${ROOT}/leaf${i}.test.ts`] = `import './leaf';`;

    const r = selectRelatedTests({ rootDir: ROOT, changedPaths: [`${ROOT}/hub.ts`], fs: vfs(files) });

    expect(RELATED_WIDEN_THRESHOLD_DEFAULT).toBeGreaterThan(0.6);
    expect(r.mode).toBe('related');
    expect(r.selected).toHaveLength(6);
    expect(r.selected.every((f) => /hub\d\.test\.ts$/.test(f))).toBe(true);
    expect(r.threshold).toBe(RELATED_WIDEN_THRESHOLD_DEFAULT);
  });

  it('honours an explicit threshold — the same 6/10 widens at 0.5', () => {
    const files: Record<string, string> = {
      [`${ROOT}/hub.ts`]: 'export const hub = 1;',
      [`${ROOT}/leaf.ts`]: 'export const leaf = 1;',
    };
    for (let i = 0; i < 6; i++) files[`${ROOT}/hub${i}.test.ts`] = `import './hub';`;
    for (let i = 0; i < 4; i++) files[`${ROOT}/leaf${i}.test.ts`] = `import './leaf';`;

    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [`${ROOT}/hub.ts`],
      fs: vfs(files),
      threshold: 0.5,
    });

    expect(r.mode).toBe('full');
    expect(r.reason).toBe('over-threshold(6/10)');
    expect(r.threshold).toBe(0.5);
  });
});

describe('cross-root selection (WI-6554700010018067)', () => {
  // A dependent workspace `/repo/app` whose tests import package `@pkg/core` through its
  // `exports`, and whose runner config loads a setup file out of core by path.
  const APP = '/repo/app';
  const CORE = '/repo/core';
  const packages = [
    {
      name: '@pkg/core',
      dir: CORE,
      exports: {
        '.': { types: './lib/index.d.ts', import: './lib/index.ts' },
        './lib/*': './lib/*.ts',
      },
    },
    { name: 'app', dir: APP },
  ];
  const base: Record<string, string> = {
    [`${APP}/vitest.config.ts`]:
      `import { defineConfig } from 'vitest/config';\n` +
      `export default defineConfig({ test: { setupFiles: [resolve(__dirname, '../core/lib/setup.ts')] } });`,
    [`${CORE}/package.json`]: '{}',
    [`${CORE}/lib/setup.ts`]: 'export {};',
    [`${CORE}/lib/leaf.ts`]: 'export const leaf = 1;',
    [`${CORE}/lib/other.ts`]: 'export const other = 2;',
    [`${CORE}/lib/index.ts`]: `export * from './other';`,
    [`${CORE}/lib/leaf.test.ts`]: `import './leaf';`,
    [`${CORE}/lib/holey.ts`]: `import '@/nowhere';`,
    [`${APP}/lonely.ts`]: 'export const lonely = 1;',
    [`${APP}/uses-leaf.test.ts`]: `import { leaf } from '@pkg/core/lib/leaf';`,
    [`${APP}/uses-index.test.ts`]: `import { other } from '@pkg/core';`,
    [`${APP}/plain-1.test.ts`]: 'expect(1).toBe(1);',
    [`${APP}/plain-2.test.ts`]: 'expect(1).toBe(1);',
    [`${APP}/plain-3.test.ts`]: 'expect(1).toBe(1);',
  };
  const select = (changed: string[], files = base, crossRoot: { packages: typeof packages } | null = { packages }) =>
    selectRelatedTests({ rootDir: APP, changedPaths: changed, fs: vfs(files), crossRoot });

  it('selects the dependent test that imports the changed module through the package specifier', () => {
    const leaf = select([`${CORE}/lib/leaf.ts`]);
    expect(leaf.mode).toBe('related');
    expect(leaf.selected).toEqual([`${APP}/uses-leaf.test.ts`]);
    expect(leaf.total).toBe(5);
    // `.` resolves through the `import` condition (never `types`) and follows the re-export.
    const other = select([`${CORE}/lib/other.ts`]);
    expect(other.selected).toEqual([`${APP}/uses-index.test.ts`]);
  });

  it('CONTROL: without crossRoot the same change keeps the historical full run', () => {
    const r = select([`${CORE}/lib/leaf.ts`], base, null);
    expect(r.mode).toBe('full');
    expect(r.reason).toBe('no-changed-paths-in-scope');
  });

  it('keeps both same-name package targets independently of inventory order', () => {
    const twin = { ...packages[0]!, dir: '/repo/twin' };
    const files = { ...base,
      '/repo/twin/lib/leaf.ts': 'export const leaf = 2;',
      '/repo/twin/lib/index.ts': "export * from './other';",
      '/repo/twin/lib/other.ts': 'export const other = 2;',
    };
    for (const candidates of [[...packages, twin], [twin, ...packages]]) {
      for (const changed of [`${CORE}/lib/leaf.ts`, '/repo/twin/lib/leaf.ts']) {
        expect(select([changed], files, { packages: candidates }).selected)
          .toEqual([`${APP}/uses-leaf.test.ts`]);
      }
    }
  });

  it('a resolved same-name package cannot hide another candidate with a graph hole', () => {
    const twin = { ...packages[0]!, dir: '/repo/twin' };
    const files = { ...base, '/repo/twin/lib/unrelated.ts': 'export const other = 2;' };
    for (const candidates of [[...packages, twin], [twin, ...packages]]) {
      const crossRoot = { packages: candidates };
      expect(select(['/repo/twin/lib/unrelated.ts'], files, crossRoot).selected)
        .toContain(`${APP}/uses-leaf.test.ts`);
      const index = buildIndex({ rootDir: APP, fs: vfs(files), crossRoot });
      expect(index.unresolved.has(`${APP}/uses-leaf.test.ts`)).toBe(true);
    }
  });

  it('runs nothing in a dependent no test of which reaches the change', () => {
    const r = select([`${CORE}/lib/leaf.test.ts`]);
    expect(r.mode).toBe('related');
    expect(r.selected).toEqual([]);
    expect(r.reason).toBe('cross-root-unreached');
  });

  it('still runs everything when a LOCAL change reaches no test', () => {
    const r = select([`${APP}/lonely.ts`]);
    expect(r.mode).toBe('full');
    expect(r.reason).toBe('empty-selection');
  });

  it('selects a test whose closure holds an unresolved import anywhere, not only in the test', () => {
    const files = { ...base, [`${APP}/uses-holey.test.ts`]: `import '@pkg/core/lib/holey';` };
    const r = select([`${CORE}/lib/leaf.ts`], files);
    expect(r.mode).toBe('related');
    expect(r.selected).toEqual([`${APP}/uses-holey.test.ts`, `${APP}/uses-leaf.test.ts`]);
  });

  it('treats a workspace specifier that maps to no file as a hole, and a registry one as external', () => {
    const files = {
      ...base,
      [`${APP}/bad.test.ts`]: `import '@pkg/core/missing/thing';`,
      [`${APP}/registry.test.ts`]: `import 'left-pad'; import '@other/pkg';`,
    };
    const index = buildIndex({ rootDir: APP, fs: vfs(files), crossRoot: { packages } });
    expect(index.unresolved.has(`${APP}/bad.test.ts`)).toBe(true);
    expect(index.unresolved.has(`${APP}/registry.test.ts`)).toBe(false);
    expect(index.external?.has(`${CORE}/lib/leaf.ts`)).toBe(true);
    const r = select([`${CORE}/lib/other.ts`], files);
    expect(r.selected).toEqual([`${APP}/bad.test.ts`, `${APP}/uses-index.test.ts`]);
  });

  it('runs everything when the change is in what the runner config loads', () => {
    const r = select([`${CORE}/lib/setup.ts`]);
    expect(r.mode).toBe('full');
    expect(r.reason).toBe('runner-config-reaches-change');
  });

  it('runs everything when the runner config closure has a hole', () => {
    const files = { ...base, [`${APP}/vitest.config.ts`]: `import '@pkg/core/lib/not-there';` };
    const r = select([`${CORE}/lib/leaf.ts`], files);
    expect(r.mode).toBe('full');
    expect(r.reason).toBe('runner-config-unresolved');
  });

  it('runs everything for an out-of-root change no import edge can describe', () => {
    for (const changed of [`${CORE}/package.json`, '/repo/scripts/tool.mjs', `${CORE}/dist/leaf.js`]) {
      const r = select([`${CORE}/lib/leaf.ts`, changed]);
      expect(r.mode).toBe('full');
      expect(r.reason).toBe('cross-root-unrelatable-change');
    }
  });

  // affected-tests.mjs drops a workspace's narrowable test tasks exactly when this is true.
  it('isCrossRootUnreached: only the cross-root reason with an empty selection drops the tasks', () => {
    expect(isCrossRootUnreached(select([`${CORE}/lib/leaf.test.ts`]))).toBe(true);
    expect(isCrossRootUnreached({ mode: 'related', selected: new Set(), reason: 'cross-root-unreached' })).toBe(true);
    // A selection the runner filter emptied keeps the full run: emptiness alone is not proof.
    const leaf = select([`${CORE}/lib/leaf.ts`]);
    expect(isCrossRootUnreached({ ...leaf, selected: [] })).toBe(false);
    expect(isCrossRootUnreached({ mode: 'related', selected: [`${APP}/uses-leaf.test.ts`], reason: 'cross-root-unreached' })).toBe(false);
    expect(isCrossRootUnreached({ mode: 'full', selected: [], reason: 'cross-root-unreached' })).toBe(false);
    expect(isCrossRootUnreached(select([`${APP}/lonely.ts`]))).toBe(false);
    expect(isCrossRootUnreached(null)).toBe(false);
  });
});

describe('packageExportTargets', () => {
  const dir = '/repo/pkg';
  it('takes an exact subpath key over patterns, and every runtime condition but types', () => {
    const pkg = {
      name: 'p',
      dir,
      exports: {
        '.': { types: './a.d.ts', import: './a.ts', require: './a.cjs' },
        './x': './x-exact.ts',
        './*': './src/*.ts',
      },
    };
    expect(packageExportTargets(pkg, '.')).toEqual([`${dir}/a.ts`, `${dir}/a.cjs`]);
    expect(packageExportTargets(pkg, './x')).toEqual([`${dir}/x-exact.ts`]);
    expect(packageExportTargets(pkg, './y/z')).toEqual([`${dir}/src/y/z.ts`]);
  });

  it('reads a bare string or condition object as the `.` entry, and main without exports', () => {
    expect(packageExportTargets({ name: 'p', dir, exports: './i.ts' }, '.')).toEqual([`${dir}/i.ts`]);
    expect(packageExportTargets({ name: 'p', dir, exports: { default: './d.ts' } }, '.')).toEqual([`${dir}/d.ts`]);
    expect(packageExportTargets({ name: 'p', dir, main: 'src/m.ts' }, '.')).toEqual([`${dir}/src/m.ts`]);
    expect(packageExportTargets({ name: 'p', dir }, './deep/f')).toEqual([`${dir}/deep/f`]);
    // An exports map with no matching key exports nothing: the specifier is a hole.
    expect(packageExportTargets({ name: 'p', dir, exports: { '.': './i.ts' } }, './other')).toEqual([]);
  });
});

describe('resolveRelatedWidenThreshold (P-001)', () => {
  it('defaults when the env var is unset or blank', () => {
    expect(resolveRelatedWidenThreshold({})).toEqual({
      threshold: RELATED_WIDEN_THRESHOLD_DEFAULT,
      source: 'default',
    });
    expect(resolveRelatedWidenThreshold({ [RELATED_WIDEN_THRESHOLD_ENV]: '  ' }).source).toBe('default');
  });

  it('accepts a fraction in (0, 1] from the env', () => {
    expect(resolveRelatedWidenThreshold({ [RELATED_WIDEN_THRESHOLD_ENV]: '0.5' })).toEqual({
      threshold: 0.5,
      source: 'env',
    });
    expect(resolveRelatedWidenThreshold({ [RELATED_WIDEN_THRESHOLD_ENV]: '1' }).threshold).toBe(1);
  });

  it('REPORTS an unparseable or out-of-range value instead of silently re-widening', () => {
    for (const bad of ['abc', '0', '-0.2', '1.5', 'NaN']) {
      const r = resolveRelatedWidenThreshold({ [RELATED_WIDEN_THRESHOLD_ENV]: bad });
      expect(r.threshold).toBe(RELATED_WIDEN_THRESHOLD_DEFAULT);
      expect(r.source).toBe('default');
      expect(r.invalid).toBe(bad);
    }
  });
});

describe('writeRelatedFilterList (P-001)', () => {
  it('writes a sorted, de-duplicated, content-addressed JSON list and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'related-filter-'));
    try {
      const a = writeRelatedFilterList(dir, ['lib/b.test.ts', 'lib\\a.test.ts', 'lib/b.test.ts']);
      expect(a.count).toBe(2);
      expect(a.path).toBe(join(dir, `related-filter-${a.digest}.json`));
      expect(JSON.parse(readFileSync(a.path, 'utf8'))).toEqual(['lib/a.test.ts', 'lib/b.test.ts']);

      // Same content ⇒ same file, no EEXIST escape; different content ⇒ a different digest.
      const again = writeRelatedFilterList(dir, ['lib/a.test.ts', 'lib/b.test.ts']);
      expect(again.path).toBe(a.path);
      const other = writeRelatedFilterList(dir, ['lib/c.test.ts']);
      expect(other.digest).not.toBe(a.digest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats an unreadable file as unknown-dependency rather than dependency-free', () => {
    const base = vfs({
      [`${ROOT}/leaf.ts`]: 'export const leaf = 1;',
      [`${ROOT}/unreadable.test.ts`]: 'x',
      [`${ROOT}/plain.test.ts`]: `import './leaf';`,
    });
    const fs = {
      ...base,
      read: (p: string) => (p.endsWith('unreadable.test.ts') ? null : base.read(p)),
    };

    const index = buildIndex({ rootDir: ROOT, fs });
    expect(index.unresolved.has(`${ROOT}/unreadable.test.ts`)).toBe(true);
  });

  it('reports full (never a vacuous empty pass) when the root holds no tests at all', () => {
    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [`${ROOT}/a.ts`],
      fs: vfs({ [`${ROOT}/a.ts`]: 'export const a = 1;' }),
    });

    expect(r.mode).toBe('full');
    expect(r.reason).toBe('no-test-files');
    expect(r.selected).toEqual([]);
  });
});

describe('buildIndex', () => {
  it('bounds cross-root ownership lookup across many importers without losing deepest-package edges', () => {
    const app = '/repo/app';
    const parent = '/repo/dependency';
    const nested = `${parent}/nested`;
    const related = `${app}/related.test.ts`;
    const count = 64;
    const files: Record<string, string> = {
      [`${app}/vitest.config.ts`]: 'export default {};',
      [related]: Array.from({ length: count }, (_, i) => `import '@probe/nested/modules/part${i}';`).join('\n'),
      [`${app}/unrelated.test.ts`]: 'export {};',
    };
    for (let i = 0; i < count; i++) {
      files[`${nested}/modules/part${i}.ts`] = `import '@/leaf${i}';`;
      files[`${nested}/src/leaf${i}.ts`] = 'export {};';
    }
    let unrelatedOwnerProbes = 0;
    const noiseCount = 128;
    const crossRoot = {
      packages: [
        ...Array.from({ length: noiseCount }, (_, i) => ({ name: `@noise/pkg${i}`,
          get dir() { unrelatedOwnerProbes++; return `/repo/noise/pkg${i}`; } })),
        { name: '@probe/parent', dir: parent },
        { name: '@probe/nested', dir: nested, exports: { './modules/*': './modules/*.ts' } },
      ],
      aliasesFor: (dir: string) => [{ prefix: '@/', target: `${dir}/src/`, wildcard: true }],
    };
    const fs = vfs(files);
    const index = buildIndex({ rootDir: app, fs, crossRoot });
    expect(index.unresolved.size).toBe(0);
    expect(index.external?.size).toBe(count * 2);
    for (let i = 0; i < count; i++) {
      expect([...index.deps.get(`${nested}/modules/part${i}.ts`)!]).toEqual([`${nested}/src/leaf${i}.ts`]);
    }
    expect(selectRelatedTests({ rootDir: app, fs, index, crossRoot,
      changedPaths: [`${nested}/src/leaf63.ts`], threshold: Number.POSITIVE_INFINITY }).selected).toEqual([related]);
    expect(unrelatedOwnerProbes).toBeLessThanOrEqual(noiseCount * 4);
  });

  it('bounds cross-root owner scans per importer while preserving the deepest package aliases', () => {
    const app = '/repo/app';
    const parent = '/repo/dependency';
    const nested = `${parent}/nested`;
    const importer = `${nested}/index.ts`;
    const related = `${app}/related.test.ts`;
    const leafCount = 64;
    const files: Record<string, string> = {
      [`${app}/vitest.config.ts`]: 'export default {};',
      [related]: "import '@probe/nested';",
      [`${app}/unrelated.test.ts`]: 'export {};',
      [importer]: Array.from({ length: leafCount }, (_, i) => `import '@/part${i}';`).join('\n'),
    };
    for (let i = 0; i < leafCount; i++) files[`${nested}/src/part${i}.ts`] = 'export {};';
    let ownerProbes = 0;
    const crossRoot = {
      packages: [
        { name: '@probe/parent', dir: parent },
        { name: '@probe/nested', get dir() { ownerProbes++; return nested; }, exports: './index.ts' },
      ],
      aliasesFor: (dir: string) => [{ prefix: '@/', target: `${dir}/src/`, wildcard: true }],
    };
    const fs = vfs(files);
    const index = buildIndex({ rootDir: app, fs, crossRoot });

    expect(index.unresolved.size).toBe(0);
    expect([...index.deps.get(importer)!].sort()).toEqual(
      Array.from({ length: leafCount }, (_, i) => `${nested}/src/part${i}.ts`).sort(),
    );
    expect(ownerProbes).toBeLessThanOrEqual(8);
    expect(selectRelatedTests({ rootDir: app, fs, index, crossRoot,
      changedPaths: [`${nested}/src/part63.ts`], threshold: Number.POSITIVE_INFINITY }).selected).toEqual([related]);
  });

  it('keeps new source and tests while excluding ignored generated modules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'related-source-census-'));
    try {
      execFileSync('git', ['init', '--quiet', dir]);
      writeFileSync(join(dir, '.gitignore'), 'generated/\n');
      mkdirSync(join(dir, 'generated'));
      writeFileSync(join(dir, 'generated', 'bundle.test.ts'), "import '../source';");
      writeFileSync(join(dir, 'source.ts'), 'export const value = 1;');
      writeFileSync(join(dir, 'source.test.ts'), "import './source';");
      writeFileSync(join(dir, 'other.test.ts'), 'export {};');

      const index = buildIndex({ rootDir: dir });
      expect(index.files.sort()).toEqual([
        join(dir, 'other.test.ts'), join(dir, 'source.test.ts'), join(dir, 'source.ts'),
      ].sort());
      const result = selectRelatedTests({
        rootDir: dir, changedPaths: [join(dir, 'source.ts')], index,
      });
      expect(result.mode).toBe('related');
      expect(result.selected).toEqual([join(dir, 'source.test.ts')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('indexes archive sources without Git and excludes generated host output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'related-archive-census-'));
    try {
      mkdirSync(join(dir, 'dist-host'));
      writeFileSync(join(dir, 'dist-host', 'bundle.test.ts'), "import '../source';");
      writeFileSync(join(dir, 'source.ts'), 'export const value = 1;');
      writeFileSync(join(dir, 'source.test.ts'), "import './source';");
      const index = buildIndex({ rootDir: dir });
      expect(index.files.sort()).toEqual([
        join(dir, 'source.test.ts'), join(dir, 'source.ts'),
      ].sort());
      expect(index.deps.get(join(dir, 'source.test.ts'))?.has(join(dir, 'source.ts'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not follow bare specifiers into the graph', () => {
    const fs = vfs({
      [`${ROOT}/a.ts`]: `import 'node:fs'; import 'vitest'; import '@papercusp/operator-core';`,
    });
    const index = buildIndex({ rootDir: ROOT, fs });

    expect(index.deps.get(`${ROOT}/a.ts`)?.size).toBe(0);
    // …and a bare specifier is NOT an unresolved hole — it is deliberately out of scope.
    expect(index.unresolved.has(`${ROOT}/a.ts`)).toBe(false);
  });

  it('survives an import cycle instead of hanging', () => {
    const fs = vfs({
      [`${ROOT}/a.ts`]: `import './b';`,
      [`${ROOT}/b.ts`]: `import './a';`,
      [`${ROOT}/a.test.ts`]: `import './a';`,
      [`${ROOT}/x.test.ts`]: 'expect(1).toBe(1);',
      [`${ROOT}/y.test.ts`]: 'expect(1).toBe(1);',
      [`${ROOT}/z.test.ts`]: 'expect(1).toBe(1);',
    });

    const r = selectRelatedTests({ rootDir: ROOT, changedPaths: [`${ROOT}/b.ts`], fs });
    expect(r.mode).toBe('related');
    expect(r.selected).toEqual([`${ROOT}/a.test.ts`]);
  });
});

describe('dependency edges distinguish executable code from child-program text', () => {
  const source = [
    `const child = "import ghost from './missing-child.ts'; require('./missing-require.ts');";`,
    "const template = `export { ghost } from './missing-template.ts';`;",
    `export const words = "export { ghost } from './missing-export.ts';";`,
    `// import './missing-comment.ts';`,
    `import { real } from './real.ts';`,
    `export { exported } from './exported.ts';`,
    `const required = require('./required.ts');`,
    "const output = `text ${import('./dynamic.ts')}`;",
    `const runtime = new URL('./runtime.ts', import.meta.url);`,
  ].join('\n');
  const dependencies = ['real', 'exported', 'required', 'dynamic', 'runtime']
    .map(name => `${ROOT}/${name}.ts`).sort();
  const files = Object.fromEntries([
    [`${ROOT}/entry.ts`, source],
    ...dependencies.map(file => [file, 'export const value = 1;']),
  ]);

  it('keeps real imports and template expressions without phantom closure edges', () => {
    const result = staticImportClosure({ rootDir: ROOT, entryFiles: [`${ROOT}/entry.ts`], fs: vfs(files) });
    expect(result.unresolved).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.files).toEqual([`${ROOT}/entry.ts`, ...dependencies].sort());
  });

  it('uses the same executable edges in related-test selection', () => {
    const result = buildIndex({ rootDir: ROOT, fs: vfs(files) });
    expect([...result.unresolved]).toEqual([]);
    expect([...result.deps.get(`${ROOT}/entry.ts`)!].sort()).toEqual(dependencies);
  });

  it('still fails closed on a real missing dependency beside quoted imports', () => {
    const missing = vfs({ ...files, [`${ROOT}/entry.ts`]: source + "\nimport './genuinely-missing.ts';" });
    const closure = staticImportClosure({ rootDir: ROOT, entryFiles: [`${ROOT}/entry.ts`], fs: missing });
    expect(closure.ok).toBe(false);
    expect(closure.unresolved).toEqual([`${ROOT}/entry.ts:./genuinely-missing.ts`]);
    expect(buildIndex({ rootDir: ROOT, fs: missing }).unresolved.has(`${ROOT}/entry.ts`)).toBe(true);
  });
});

/**
 * WI-10007002: tsconfig `paths` resolve the way TypeScript resolves them — an EXACT key by
 * equality only, otherwise the LONGEST wildcard prefix — independent of declaration order. The
 * retired resolver flattened every key into a prefix map and took the FIRST prefix that matched,
 * so an exact key could capture a longer specifier and a short wildcard could shadow a longer
 * one, depending purely on the order the tsconfig happened to declare them.
 */
describe('tsconfig paths resolution — exact key first, then the longest wildcard (WI-10007002)', () => {
  const FILES = {
    [`${ROOT}/cfg/index.ts`]: 'export const cfg = 1;', // exact `#cfg`
    [`${ROOT}/cfg/util.ts`]: 'export const util = 1;', // wildcard `#cfg/*`
    [`${ROOT}/env.real.ts`]: 'export const env = 1;', // exact `@/env`
    [`${ROOT}/env.ts`]: 'export const decoy = 1;', // what `@/*` alone would give `@/env`
    [`${ROOT}/other/deep/a.ts`]: 'export const a = 1;', // longest wildcard `@/deep/*`
    [`${ROOT}/deep/a.ts`]: 'export const decoy = 1;', // what `@/*` alone would give `@/deep/a`
    [`${ROOT}/importer.ts`]: `import '#cfg/util'; import '#cfg'; import '@/env'; import '@/deep/a';`,
  };
  const ENTRIES = [
    { prefix: '#cfg', target: `${ROOT}/cfg/index.ts`, wildcard: false },
    { prefix: '#cfg/', target: `${ROOT}/cfg/`, wildcard: true },
    { prefix: '@/', target: `${ROOT}/`, wildcard: true },
    { prefix: '@/env', target: `${ROOT}/env.real.ts`, wildcard: false },
    { prefix: '@/deep/', target: `${ROOT}/other/deep/`, wildcard: true },
  ];
  const ORDERS = [
    ['declared order', ENTRIES],
    ['reversed order', [...ENTRIES].reverse()],
  ] as const;
  const EXPECTED = [`${ROOT}/cfg/index.ts`, `${ROOT}/cfg/util.ts`, `${ROOT}/env.real.ts`, `${ROOT}/other/deep/a.ts`];

  for (const [label, aliases] of ORDERS) {
    it(`buildIndex resolves every key to its TypeScript target (${label})`, () => {
      const index = buildIndex({ rootDir: ROOT, aliases: [...aliases], fs: vfs(FILES) });
      expect([...(index.deps.get(`${ROOT}/importer.ts`) ?? [])].sort()).toEqual(EXPECTED);
      expect(index.unresolved.has(`${ROOT}/importer.ts`)).toBe(false);
    });

    it(`staticImportClosure reaches exactly the TypeScript targets (${label})`, () => {
      const r = staticImportClosure({
        rootDir: ROOT,
        entryFiles: [`${ROOT}/importer.ts`],
        aliases: [...aliases],
        fs: vfs(FILES),
      });
      expect(r.unresolved).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.files).toEqual([...EXPECTED, `${ROOT}/importer.ts`].sort());
    });

    it(`selectRelatedTests selects the test importing an exact key's target (${label})`, () => {
      const fs = vfs({
        ...FILES,
        [`${ROOT}/env.test.ts`]: `import '@/env';`,
        [`${ROOT}/decoy.test.ts`]: `import './env';`,
      });
      const r = selectRelatedTests({
        rootDir: ROOT,
        changedPaths: [`${ROOT}/env.real.ts`],
        aliases: [...aliases],
        fs,
      });
      expect(r.mode).toBe('related');
      expect(r.selected).toEqual([`${ROOT}/env.test.ts`]);
    });
  }

  it('CONTROL: the retired flattened first-match resolver misresolves this fixture, so the cases above can fail', () => {
    // A faithful copy of the pre-fix resolver: every key flattened to `prefix → dir/`, first match wins.
    const flattened = Object.fromEntries(
      ENTRIES.map(({ prefix, target }) => [prefix, target.endsWith('/') ? target : `${target}/`]),
    );
    const firstMatch = (spec: string) => {
      const p = Object.keys(flattened).find((k) => spec === k || spec.startsWith(k));
      return p === undefined ? null : join(flattened[p], spec.slice(p.length));
    };
    expect(firstMatch('#cfg/util')).toBe(`${ROOT}/cfg/index.ts/util`); // exact key captured by prefix
    expect(firstMatch('@/env')).toBe(`${ROOT}/env`); // short wildcard shadows the exact key → env.ts decoy
    expect(firstMatch('@/deep/a')).toBe(`${ROOT}/deep/a`); // short wildcard shadows the longer one → decoy
  });

  it('refuses the retired prefix-map shape loudly instead of resolving nothing', () => {
    const legacy = { '@/': `${ROOT}/` } as unknown as never;
    expect(() => buildIndex({ rootDir: ROOT, aliases: legacy, fs: vfs(FILES) })).toThrow(TypeError);
    expect(() =>
      staticImportClosure({ rootDir: ROOT, entryFiles: [`${ROOT}/importer.ts`], aliases: legacy, fs: vfs(FILES) }),
    ).toThrow(/tsconfigPathEntriesFor/);
  });
});

describe('transitiveDeps', () => {
  it('returns the same complete closure for every entry point through an import cycle', () => {
    const fs = vfs({
      [`${ROOT}/a.ts`]: `import './b'; import './left';`,
      [`${ROOT}/b.ts`]: `import './a'; import './right';`,
      [`${ROOT}/left.ts`]: 'export const left = 1;',
      [`${ROOT}/right.ts`]: 'export const right = 1;',
    });
    const index = buildIndex({ rootDir: ROOT, fs });

    // Prime through A first. The former stack-guarded memoization cached B's
    // partial closure at this point and permanently omitted left.ts from B.
    const aFirst = transitiveDeps(index);
    expect([...aFirst(`${ROOT}/a.ts`)].sort()).toEqual(
      [`${ROOT}/b.ts`, `${ROOT}/left.ts`, `${ROOT}/right.ts`].sort(),
    );
    expect([...aFirst(`${ROOT}/b.ts`)].sort()).toEqual(
      [`${ROOT}/a.ts`, `${ROOT}/left.ts`, `${ROOT}/right.ts`].sort(),
    );

    // A fresh resolver primed through B must produce the identical B closure.
    const bFirst = transitiveDeps(index);
    expect([...bFirst(`${ROOT}/b.ts`)].sort()).toEqual([...aFirst(`${ROOT}/b.ts`)].sort());
  });

  it('does not let removing an import edge enlarge a later closure', () => {
    const indexWithEdge = buildIndex({
      rootDir: ROOT,
      fs: vfs({
        [`${ROOT}/a.ts`]: `import './b'; import './c';`,
        [`${ROOT}/b.ts`]: `import './a';`,
        [`${ROOT}/c.ts`]: 'export const c = 1;',
      }),
    });
    const indexWithoutEdge = buildIndex({
      rootDir: ROOT,
      fs: vfs({
        [`${ROOT}/a.ts`]: `import './c';`,
        [`${ROOT}/b.ts`]: `import './a';`,
        [`${ROOT}/c.ts`]: 'export const c = 1;',
      }),
    });

    const closureForB = (index: ReturnType<typeof buildIndex>) => {
      const reach = transitiveDeps(index);
      // Prime both resolvers through A first, matching the batch measurement that
      // exposed the old traversal-order-dependent cache. With the former DFS,
      // the A↔B cycle cached B as only {A}; removing A→B then made B incorrectly
      // GROW to {A,C}. Exact SCC reachability returns {A,C} in both graphs.
      reach(`${ROOT}/a.ts`);
      return [...reach(`${ROOT}/b.ts`)].sort();
    };

    const withEdge = closureForB(indexWithEdge);
    const withoutEdge = closureForB(indexWithoutEdge);
    expect(withEdge).toEqual([`${ROOT}/a.ts`, `${ROOT}/c.ts`].sort());
    expect(withoutEdge).toEqual(withEdge);
  });
});

describe('repository test import surfaces', () => {
  it('keeps single-blueprint tests on their leaf registration op instead of the all-ops barrel', () => {
    const singleBlueprintTests = readdirSync(BLUEPRINT_STEPS_DIR)
      .filter(
        (name) =>
          name.endsWith('-blueprint.test.ts') || name === 'negative-space-marketplace-roundtrip.test.ts',
      )
      .sort();

    const barrelImporters = singleBlueprintTests.filter((name) => {
      const source = readFileSync(join(BLUEPRINT_STEPS_DIR, name), 'utf8');
      return /(?:import|from)\s+['"]\.\/index(?:\.js)?['"]/.test(source);
    });

    // These tests each import their one ./ops/* module already, which registers
    // the op under test. Pulling ./index.js as well eagerly registers every other
    // deterministic op and turns a leaf test into a 1,000+ source graph hub.
    // Whole-registry invariant tests have different names and intentionally keep
    // the barrel; this guard targets only the single-blueprint contract tests.
    expect(singleBlueprintTests.length).toBeGreaterThan(0);
    expect(barrelImporters).toEqual([]);
  });
});

/**
 * EI-21440128879545486. A selection is narrowed only into VITEST lanes, so a test some other
 * RUNNER owns can never execute there — it reaches vitest as a positional filter matching
 * nothing, and the router refuses the whole partial-match run rather than false-greening it.
 * The task then reds with ZERO attributable test files: no `test_runs` fail rows to triage and
 * nothing for the gate's isolation re-run to isolate. Two Playwright specs entering the
 * `@papercusp/web :: test` selection that way red-pinned green-checkpoint and froze `main`.
 *
 * The discriminator under test is RUNNER OWNERSHIP, never the file extension — `.spec.ts` is a
 * legitimate VITEST include in search-core and the three papergrid packages, and excluding
 * those would silently shrink real runs, which is the failure this whole file guards against.
 */
describe('playwrightOwnedTest — ownership by runner, not by extension', () => {
  const PW_CONFIG = `
    import { defineConfig } from '@playwright/test';
    export default defineConfig({
      testDir: './e2e',
      testMatch: /.*\\.spec\\.ts$/,
    });
  `;

  /** A reader over a virtual workspace; anything unlisted throws, as the real fs does. */
  const reader = (files: Record<string, string>) => (p: string) => {
    if (p in files) return files[p];
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  };

  const owned = (files: Record<string, string>) =>
    playwrightOwnedTest('/ws', { readFile: reader(files) });

  it('claims a Playwright spec inside the declared testDir', () => {
    expect(owned({ '/ws/playwright.config.ts': PW_CONFIG })('/ws/e2e/docs-routes.spec.ts')).toBe(
      true,
    );
  });

  it('reads the ESM config before a compatibility TypeScript entry', () => {
    const isOwned = owned({
      '/ws/playwright.config.ts': "export { default } from './playwright.config.mts';",
      '/ws/playwright.config.mts': PW_CONFIG,
    });
    expect(isOwned('/ws/e2e/docs-routes.spec.ts')).toBe(true);
    expect(isOwned('/ws/lib/thing.test.ts')).toBe(false);
  });

  it('leaves a vitest .test.ts in the same workspace alone', () => {
    const isOwned = owned({ '/ws/playwright.config.ts': PW_CONFIG });
    expect(isOwned('/ws/lib/thing.test.ts')).toBe(false);
    expect(isOwned('/ws/e2e/helper.test.ts')).toBe(false);
  });

  it('leaves a .spec.ts OUTSIDE testDir alone — it is a real vitest include elsewhere', () => {
    // search-core / papergrid ship `src/**/*.spec.ts` as their VITEST include. Claiming these
    // would drop real tests from the run and certify code nothing exercised.
    expect(owned({ '/ws/playwright.config.ts': PW_CONFIG })('/ws/src/query.spec.ts')).toBe(false);
  });

  it('never claims a testDir PREFIX match (e2e-utils/ is not e2e/)', () => {
    expect(owned({ '/ws/playwright.config.ts': PW_CONFIG })('/ws/e2e-utils/a.spec.ts')).toBe(false);
  });

  it('owns nothing when the workspace has no Playwright config', () => {
    expect(owned({})('/ws/src/query.spec.ts')).toBe(false);
    expect(owned({})('/ws/e2e/docs-routes.spec.ts')).toBe(false);
  });

  it('owns nothing when the config parses to no declaration — the failure stays LOUD', () => {
    // Fail-safe direction: withholding nothing means a genuine mismatch still reds the gate
    // naming the file, instead of a test silently disappearing from the run.
    const noDecl = owned({ '/ws/playwright.config.ts': 'export default defineConfig({});' });
    expect(noDecl('/ws/e2e/docs-routes.spec.ts')).toBe(false);
  });

  it('follows testDir when it moves — derived from the config, not a hardcoded e2e/ glob', () => {
    const moved = owned({
      '/ws/playwright.config.ts': PW_CONFIG.replace("'./e2e'", "'./browser-tests'"),
    });
    expect(moved('/ws/browser-tests/docs-routes.spec.ts')).toBe(true);
    expect(moved('/ws/e2e/docs-routes.spec.ts')).toBe(false);
  });

  it('is stateless across calls even if the config regex carries /g', () => {
    // A surviving `lastIndex` would make identical calls alternate true/false.
    const g = owned({ '/ws/playwright.config.ts': PW_CONFIG.replace('$/,', '$/g,') });
    const file = '/ws/e2e/docs-routes.spec.ts';
    expect([g(file), g(file), g(file)]).toEqual([true, true, true]);
  });
});

describe('playwrightOwnedTest — against the real repository tree', () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const OPERATOR = join(REPO_ROOT, 'apps/operator');

  it('claims every Playwright spec in apps/operator and no vitest test', () => {
    const isOwned = playwrightOwnedTest(OPERATOR);
    const e2eDir = join(OPERATOR, 'e2e');
    const specs = readdirSync(e2eDir).filter((n) => n.endsWith('.spec.ts'));

    // Positive control: an empty list would make the "claims all" assertion vacuously true.
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter((n) => !isOwned(join(e2eDir, n)))).toEqual([]);

    // The two specs that actually red-pinned the gate.
    expect(isOwned(join(e2eDir, 'design-dashboard-flow.spec.ts'))).toBe(true);
    expect(isOwned(join(e2eDir, 'docs-routes.spec.ts'))).toBe(true);

    // Negative control: vitest files in the same workspace must survive selection.
    expect(isOwned(join(OPERATOR, 'lib/sync-sse.test.ts'))).toBe(false);
    expect(isOwned(join(OPERATOR, 'vitest.config.ts'))).toBe(false);
  });
});

/**
 * Executed-source pruning (gate-latency-selection-and-retry-policy-2026-09-06, P-002).
 *
 * The static closure is the SUPERSET; a recorded map of what a test actually executed may
 * only REMOVE tests from it, and only when the map is provably current. Every rail below
 * is asserted in the fail-safe direction: a question the rule cannot answer keeps the test.
 */
describe('selectRelatedTests — executed-source pruning (P-002)', () => {
  const JUDGED = 'judged00000000000000000000000000000000000';
  const OLDER = 'older000000000000000000000000000000000000';
  const leaf = `${ROOT}/leaf.ts`;
  const hub = `${ROOT}/hub.ts`;
  const other = `${ROOT}/other.ts`;
  const tests = ['a', 'b', 'c', 'd', 'e'].map((n) => `${ROOT}/${n}.test.ts`);
  const [a, b, c, d, e] = tests;

  /** leaf changed; hub re-exports it; five tests import hub; three unrelated tests pad the suite. */
  function hubFs() {
    return vfs({
      [leaf]: 'export const leaf = 1;',
      [other]: 'export const other = 2;',
      [hub]: `export * from './leaf'; export * from './other';`,
      ...Object.fromEntries(tests.map((t) => [t, `import './hub';`])),
      [`${ROOT}/u1.test.ts`]: `import './other';`,
      [`${ROOT}/u2.test.ts`]: `import './other';`,
      [`${ROOT}/u3.test.ts`]: `import './other';`,
    });
  }
  const entry = (self: string, executed: string[], recordedSha = JUDGED) => ({
    recordedSha,
    executed: new Set([self, ...executed]),
  });
  const fresh = () => () => [] as string[];

  it('exposes static candidates from one prebuilt index for a scoped map read', () => {
    const baseFs = hubFs();
    let listCalls = 0;
    const fs = {
      ...baseFs,
      list(root: string) {
        listCalls += 1;
        return baseFs.list(root);
      },
    };
    const prepared = prepareRelatedTestSelection({ rootDir: ROOT, changedPaths: [leaf], fs });
    const candidates = [...prepared.selection.selected].sort();
    expect(candidates).toEqual(tests);
    expect(listCalls).toBe(1);

    const result = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [leaf],
      prepared,
      executedMap: new Map([[a, entry(a, [hub, other])]]),
      judgedSha: JUDGED,
      changedBetween: fresh(),
    });
    expect(result.selected).toEqual([b, c, d, e]);
    expect(listCalls).toBe(1);
  });

  it('prunes a test whose current map never executed the change and keeps one whose map did', () => {
    const executedMap = new Map([
      [a, entry(a, [hub, other])], // reached leaf statically through the hub, never executed it
      [b, entry(b, [hub, other, leaf])], // executed the change
    ]);
    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [leaf],
      fs: hubFs(),
      executedMap,
      judgedSha: JUDGED,
      changedBetween: fresh(),
    });
    expect(r.mode).toBe('related');
    expect(r.selected).toEqual([b, c, d, e]);
    expect(r.executedMap.applied).toBe(true);
    expect(r.executedMap.pruned).toBe(1);
    expect(r.executedMap.kept.intersects).toBe(1);
    // c, d, e have no entry: the static rail keeps them and the summary says so.
    expect(r.executedMap.kept.noEntry).toBe(3);
  });

  it('keeps a test whose closure drifted since its map was recorded (stale map), prunes one whose closure did not', () => {
    const executedMap = new Map([
      [a, entry(a, [hub, other], OLDER)],
      [b, entry(b, [hub, other], OLDER)],
    ]);
    // Between OLDER and JUDGED, hub.ts changed — inside a's and b's closure — so both maps are
    // stale and both tests stay, even though neither recorded set touches leaf.
    const r1 = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [leaf],
      fs: hubFs(),
      executedMap,
      judgedSha: JUDGED,
      changedBetween: (from, to) => (from === OLDER && to === JUDGED ? [hub] : null),
    });
    expect(r1.selected).toContain(a);
    expect(r1.selected).toContain(b);
    expect(r1.executedMap.kept.stale).toBe(2);
    expect(r1.executedMap.pruned).toBe(0);

    // Drift OUTSIDE the closure (an unrelated file) does not stale the map: both prune.
    const r2 = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [leaf],
      fs: hubFs(),
      executedMap,
      judgedSha: JUDGED,
      changedBetween: () => [`${ROOT}/u1.test.ts`],
    });
    expect(r2.selected).toEqual([c, d, e]);
    expect(r2.executedMap.pruned).toBe(2);
  });

  it('keeps a test when the drift between recorded and judged sha cannot be determined', () => {
    const executedMap = new Map([[a, entry(a, [hub, other], OLDER)]]);
    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [leaf],
      fs: hubFs(),
      executedMap,
      judgedSha: JUDGED,
      changedBetween: () => null,
    });
    expect(r.selected).toContain(a);
    expect(r.executedMap.kept.unknownDrift).toBe(1);
    expect(r.executedMap.pruned).toBe(0);
  });

  it('does not trust an entry that omits the test file itself, or an empty one', () => {
    const executedMap = new Map([
      [a, { recordedSha: JUDGED, executed: new Set([hub, other]) }], // no self
      [b, { recordedSha: JUDGED, executed: new Set<string>() }],
    ]);
    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [leaf],
      fs: hubFs(),
      executedMap,
      judgedSha: JUDGED,
      changedBetween: fresh(),
    });
    expect(r.selected).toContain(a);
    expect(r.selected).toContain(b);
    expect(r.executedMap.kept.untrusted).toBe(2);
  });

  it('always runs a changed test file, whatever its map says', () => {
    const executedMap = new Map([[a, entry(a, [hub, other])]]);
    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [a],
      fs: hubFs(),
      executedMap,
      judgedSha: JUDGED,
      changedBetween: fresh(),
    });
    expect(r.selected).toEqual([a]);
    expect(r.executedMap.kept.changedTest).toBe(1);
  });

  it('refuses to narrow the selection to nothing: the static selection stands', () => {
    const executedMap = new Map(tests.map((t) => [t, entry(t, [hub, other])]));
    const r = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [leaf],
      fs: hubFs(),
      executedMap,
      judgedSha: JUDGED,
      changedBetween: fresh(),
    });
    expect(r.mode).toBe('related');
    expect(r.selected).toEqual(tests);
    expect(r.executedMap.wouldEmpty).toBe(true);
    expect(r.executedMap.pruned).toBe(0);
    expect(r.executedMap.prunable).toBe(5);
  });

  it('is inert — and says why — without a map, a judged sha, or a drift seam', () => {
    const executedMap = new Map([[a, entry(a, [hub, other])]]);
    const base = { rootDir: ROOT, changedPaths: [leaf], fs: hubFs() };
    const noMap = selectRelatedTests({ ...base, judgedSha: JUDGED, changedBetween: fresh() });
    const noSha = selectRelatedTests({ ...base, executedMap, changedBetween: fresh() });
    const noSeam = selectRelatedTests({ ...base, executedMap, judgedSha: JUDGED });
    for (const r of [noMap, noSha, noSeam]) {
      expect(r.selected).toEqual(tests);
      expect(r.executedMap.applied).toBe(false);
    }
    expect(noMap.executedMap.reason).toBe('no-map');
    expect(noSha.executedMap.reason).toBe('no-judged-sha');
    expect(noSeam.executedMap.reason).toBe('no-drift-seam');
    // The default call shape is unchanged in outcome AND still reports the summary.
    const plain = selectRelatedTests(base);
    expect(plain.selected).toEqual(tests);
    expect(plain.executedMap).toMatchObject({ applied: false, reason: 'no-map' });
  });

  it('reports the summary on every full-mode return path too', () => {
    const noTests = selectRelatedTests({ rootDir: ROOT, changedPaths: [leaf], fs: vfs({ [leaf]: '' }) });
    expect(noTests.reason).toBe('no-test-files');
    expect(noTests.executedMap.applied).toBe(false);
    const outOfScope = selectRelatedTests({ rootDir: ROOT, changedPaths: ['/elsewhere/x.ts'], fs: hubFs() });
    expect(outOfScope.reason).toBe('no-changed-paths-in-scope');
    expect(outOfScope.executedMap.applied).toBe(false);
  });

  it('applies the widening threshold to the PRUNED selection', () => {
    // Statically 5/8 selected — over a 0.6 threshold, so unpruned this widens to full.
    const executedMap = new Map([[a, entry(a, [hub, other])], [b, entry(b, [hub, other])]]);
    const wide = selectRelatedTests({ rootDir: ROOT, changedPaths: [leaf], fs: hubFs(), threshold: 0.6 });
    expect(wide.mode).toBe('full');
    const narrowed = selectRelatedTests({
      rootDir: ROOT,
      changedPaths: [leaf],
      fs: hubFs(),
      threshold: 0.6,
      executedMap,
      judgedSha: JUDGED,
      changedBetween: fresh(),
    });
    expect(narrowed.mode).toBe('related');
    expect(narrowed.selected).toEqual([c, d, e]);
  });

  it('pruneWithExecutedMap keeps a graph hole (unresolved import) whatever the map says', () => {
    const selected = new Set([a, b]);
    const { selected: kept, summary } = pruneWithExecutedMap({
      selected,
      changedSet: new Set([leaf]),
      reach: () => new Set([hub, leaf, other]),
      unresolved: new Set([a]),
      executedMap: new Map([[a, entry(a, [hub])], [b, entry(b, [hub])]]),
      judgedSha: JUDGED,
      changedBetween: fresh(),
    });
    expect([...kept]).toEqual([a]);
    expect(summary.kept.unresolved).toBe(1);
    expect(summary.pruned).toBe(1);
  });

  it('pruneWithExecutedMap caches the drift lookup per recorded sha and survives a throwing seam', () => {
    let calls = 0;
    const { summary } = pruneWithExecutedMap({
      selected: new Set([a, b, c]),
      changedSet: new Set([leaf]),
      reach: () => new Set([hub, leaf, other]),
      unresolved: new Set(),
      executedMap: new Map([
        [a, entry(a, [hub], OLDER)],
        [b, entry(b, [hub], OLDER)],
        [c, entry(c, [hub], 'third0000000000000000000000000000000000000')],
      ]),
      judgedSha: JUDGED,
      changedBetween: (from) => {
        calls += 1;
        if (from === OLDER) return [];
        throw new Error('unknown sha');
      },
    });
    expect(calls).toBe(2); // OLDER once (cached for b), the throwing sha once
    expect(summary.pruned).toBe(2);
    expect(summary.kept.unknownDrift).toBe(1);
  });
});
