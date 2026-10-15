import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGymRunnerPorts, parseVitestOracleResults, type GymRunnerPortsConfig } from '../runner-ports';
import type { Sql } from 'postgres';

/** A no-op tagged-template + `.unsafe()`/`.json()` sql fake (teardown + principal-seed paths). */
function fakeSql(): Sql {
  const tag = (async () => []) as unknown as Sql;
  (tag as unknown as { unsafe: (s: string) => Promise<unknown[]> }).unsafe = async () => [];
  (tag as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return tag;
}

/**
 * Real GymRunnerPorts adapter (P-001 wiring). Binds the smoke-PROVEN operations:
 * git clone, harness register (HTTP), prompt overrides + feature (gym PG), pipeline
 * start (admin route + superuser bearer), poll (gym PG), teardown. The HTTP + exec
 * ports are tested here with injected fakes (verifying URLs/auth/commands); the gym-PG
 * ports are validated by the boot smoke / P-014.
 */
function cfg(over: Partial<GymRunnerPortsConfig> = {}): { config: GymRunnerPortsConfig; reqs: { url: string; init: RequestInit }[]; execs: string[][] } {
  const reqs: { url: string; init: RequestInit }[] = [];
  const execs: string[][] = [];
  const config: GymRunnerPortsConfig = {
    operatorBaseUrl: 'http://127.0.0.1:3971',
    gymSql: fakeSql(), // registerThrowawayHarness seeds principals through it before the HTTP call
    superuserToken: 'sekret-token-1234567890',
    workspaceId: 'gym-ws',
    fetchFn: (async (url: string, init: RequestInit) => {
      reqs.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => '{}',
        json: async () => ({ ok: true, workflowID: 'pipeline:gymx:F-GYM-1:e0' }),
      } as unknown as Response;
    }) as unknown as typeof fetch,
    exec: async (cmd: string, args: string[]) => {
      execs.push([cmd, ...args]);
    },
    rm: async () => {},
    ...over,
  };
  return { config, reqs, execs };
}

describe('createGymRunnerPorts', () => {
  it('retains skipped assertion identities so they cannot disappear from coverage', () => {
    expect(parseVitestOracleResults(JSON.stringify({ testResults: [{ assertionResults: [
      { fullName: 'executed', status: 'passed' }, { fullName: 'skipped', status: 'pending' },
    ] }] }))).toEqual([
      { name: 'executed', passed: true },
      { name: 'skipped', passed: false, executed: false },
    ]);
  });

  it('exposes the full GymRunnerPorts surface', () => {
    const p = createGymRunnerPorts(cfg().config);
    for (const k of ['cloneSubstrate', 'registerThrowawayHarness', 'applyPromptOverride', 'fileFeature', 'startPipeline', 'pollStatus', 'runOracle', 'teardownHarness', 'now', 'sleep'] as const) {
      expect(typeof p[k]).toBe('function');
    }
  });

  it('default runOracle executes the supported test:file command and parses measured Vitest assertions', async () => {
    const clonePath = mkdtempSync(join(tmpdir(), 'gym-oracle-'));
    try {
      const { config, execs } = cfg({
        execCapture: async (_cmd, args) => {
          const outputArg = args.find((arg) => arg.startsWith('--outputFile='));
          expect(outputArg).toBeTruthy();
          writeFileSync(outputArg!.slice('--outputFile='.length), JSON.stringify({
            testResults: [{
              assertionResults: [
                { fullName: 'oracle > passes', status: 'passed' },
                { fullName: 'oracle > fails', status: 'failed' },
                { fullName: 'oracle > skipped', status: 'skipped' },
              ],
            }],
          }));
          return { stdout: '', stderr: '' };
        },
      });
      const p = createGymRunnerPorts(config);
      const results = await p.runOracle!({ clonePath, testPath: 'oracle.test.js' });
      expect(results).toEqual([
        { name: 'oracle > passes', passed: true },
        { name: 'oracle > fails', passed: false },
        { name: 'oracle > skipped', passed: false, executed: false },
      ]);
      expect(execs).toEqual([]);
    } finally {
      rmSync(clonePath, { recursive: true, force: true });
    }
  });

  it.each([false, true])('captures the actual pinned oracle and bytes around execution (mutated=%s)', async (mutated) => {
    const clonePath = mkdtempSync(join(tmpdir(), 'gym-oracle-pin-'));
    const original = 'export const oracle = true;\n';
    const changed = 'export const oracle = false;\n';
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    try {
      writeFileSync(join(clonePath, 'oracle.test.js'), original);
      const commands: string[][] = [];
      const { config } = cfg({ execCapture: async (cmd, args) => {
        commands.push([cmd, ...args]);
        if (cmd === 'git') return { stdout: original, stderr: '' };
        const outputArg = args.find((arg) => arg.startsWith('--outputFile='))!;
        writeFileSync(outputArg.slice('--outputFile='.length), JSON.stringify({ testResults: [
          { name: join(clonePath, 'oracle.test.js'), assertionResults: [{ fullName: 't', status: 'passed' }] },
        ] }));
        if (mutated) writeFileSync(join(clonePath, 'oracle.test.js'), changed);
        return { stdout: '', stderr: '' };
      } });
      const pinCommit = 'a'.repeat(40);
      expect(await createGymRunnerPorts(config).runOracle!({ clonePath, testPath: 'oracle.test.js', pinCommit })).toMatchObject({
        results: [{ name: 't', file: 'oracle.test.js', passed: true }], testPath: 'oracle.test.js', pinCommit,
        sourceHashes: { pinned: digest(original), before: digest(original), after: digest(mutated ? changed : original) },
      });
      expect(commands[0]).toEqual(['git', 'show', `${pinCommit}:oracle.test.js`]);
      expect(commands[1]).toEqual(['git', 'show', `${pinCommit}:package.json`]);
      expect(commands[2].slice(0, 5)).toEqual(['npm', 'run', 'test:file', '--', 'oracle.test.js']);
    } finally { rmSync(clonePath, { recursive: true, force: true }); }
  });

  it('retains explicit unknown source identity when the immutable pin cannot be read', async () => {
    const clonePath = mkdtempSync(join(tmpdir(), 'gym-oracle-missing-pin-'));
    try {
      writeFileSync(join(clonePath, 'oracle.test.js'), 'oracle');
      const { config } = cfg({ execCapture: async (cmd, args) => {
        if (cmd === 'git') throw new Error('missing commit');
        const outputArg = args.find((arg) => arg.startsWith('--outputFile='))!;
        writeFileSync(outputArg.slice('--outputFile='.length), JSON.stringify({ testResults: [{
          name: 'oracle.test.js', assertionResults: [{ fullName: 't', status: 'passed' }],
        }] }));
        return { stdout: '', stderr: '' };
      } });
      const receipt = await createGymRunnerPorts(config).runOracle!({ clonePath, testPath: 'oracle.test.js', pinCommit: 'a'.repeat(40) });
      expect(receipt).toMatchObject({ results: [{ name: 't', file: 'oracle.test.js', passed: true }],
        sourceHashes: { pinned: null } });
    } finally { rmSync(clonePath, { recursive: true, force: true }); }
  });

  it.each([false, true])('retains the exact evaluated implementation and raw test report (mutated=%s)', async (mutated) => {
    const clonePath = mkdtempSync(join(tmpdir(), 'gym-oracle-artifact-'));
    const before = 'export const answer = 42;\n';
    const after = 'export const answer = 0;\n';
    const report = JSON.stringify({ testResults: [{ name: join(clonePath, 'oracle.test.js'),
      assertionResults: [{ fullName: 'task', status: 'passed' }] }] });
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    try {
      writeFileSync(join(clonePath, 'impl.js'), before);
      writeFileSync(join(clonePath, 'oracle.test.js'), 'oracle');
      const { config } = cfg({ execCapture: async (cmd, args) => {
        if (cmd === 'git') return { stdout: 'oracle', stderr: '' };
        const outputArg = args.find((arg) => arg.startsWith('--outputFile='))!;
        writeFileSync(outputArg.slice('--outputFile='.length), report);
        if (mutated) writeFileSync(join(clonePath, 'impl.js'), after);
        return { stdout: '', stderr: '' };
      } });
      const input = { clonePath, testPath: 'oracle.test.js', implPath: 'impl.js', pinCommit: 'a'.repeat(40) };
      const receipt = await createGymRunnerPorts(config).runOracle!(input);
      expect(receipt).toMatchObject({
        implementation: { path: 'impl.js', before: hash(before), after: hash(mutated ? after : before) },
        execution: { cwd: clonePath, report,
          command: ['npm', 'run', 'test:file', '--', 'oracle.test.js', '--', '--reporter=json', expect.stringMatching(/^--outputFile=/)],
          unresolved: ['oracle-dependencies-outside-worker-vite-scope', 'test-command-runtime', 'pipeline-runtime',
            'oracle-main-process-load-unmeasured',
            'oracle-config-original-load-unmeasured', 'oracle-config-snapshot-evidence-unavailable',
            'oracle-npm-manifest-evidence-unavailable', 'oracle-worker-source-evidence-unavailable'], workerSources: { report: null, modules: [] } },
      });
    } finally { rmSync(clonePath, { recursive: true, force: true }); }
  });

  it('measures real Git and Vitest oracle artifacts across an implementation change', async () => {
    const clonePath = mkdtempSync(join(tmpdir(), 'gym-oracle-real-'));
    const vitestDir = dirname(fileURLToPath(import.meta.resolve('vitest/package.json')));
    const reporterPath = join(dirname(fileURLToPath(import.meta.resolve('@papercusp/test-config/vitest-config'))), 'executed-source-map-reporter.ts');
    const implementation = 'export const answer = 42;\n';
    const changedImplementation = 'export const answer = 41;\n';
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    try {
      // Reuse the installed framework; this fixture owns no agent or live DB.
      mkdirSync(join(clonePath, 'node_modules'));
      symlinkSync(vitestDir, join(clonePath, 'node_modules', 'vitest'), 'dir');
      mkdirSync(join(clonePath, 'libs'));
      symlinkSync(dirname(dirname(reporterPath)), join(clonePath, 'libs', 'test-config'), 'dir');
      const mainDir = join(clonePath, 'libs', 'runner-support');
      mkdirSync(mainDir);
      writeFileSync(join(mainDir, 'package.json'), JSON.stringify({ name: 'runner-support', type: 'module', exports: './index.mjs' }));
      const mainSource = 'export const allow = true;\n';
      writeFileSync(join(mainDir, 'index.mjs'), mainSource);
      symlinkSync(mainDir, join(clonePath, 'node_modules', 'runner-support'), 'dir');
      const commandSource = `import { spawnSync } from 'node:child_process';
        const child = spawnSync(process.execPath, [${JSON.stringify(join(vitestDir, 'vitest.mjs'))},
          'run', '--config', 'vitest.config.mjs', ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
        process.exit(child.status ?? 1);\n`;
      writeFileSync(join(clonePath, 'command.mjs'), commandSource);
      writeFileSync(join(clonePath, 'package.json'), JSON.stringify({ name: 'gym-oracle-fixture', type: 'module', scripts: {
        'test:file': 'node command.mjs',
      } }));
      const configHelper = 'export const workers = 1;\n';
      writeFileSync(join(clonePath, 'config-helper.mjs'), configHelper);
      writeFileSync(join(clonePath, 'vitest.config.mjs'), `import { workers } from './config-helper.mjs';
        import { allow } from 'runner-support';
        export default { test: {
        include: ['oracle.test.mjs'], pool: 'forks', maxWorkers: workers, fileParallelism: !allow,
        experimental: { importDurations: { limit: 1000000 } },
        reporters: ['json', ${JSON.stringify(reporterPath)}], outputFile: process.argv.find(a => a.startsWith('--outputFile='))?.slice(13),
      } };\n`);
      writeFileSync(join(clonePath, 'impl.mjs'), implementation);
      writeFileSync(join(clonePath, 'helper.mjs'), 'export const expected = 42;\n');
      writeFileSync(join(clonePath, 'oracle.test.mjs'), `import { test, expect } from 'vitest';
        import { answer } from './impl.mjs';
        import { expected } from './helper.mjs';
        import { writeFileSync } from 'node:fs';
        test('actual task', () => {
          if (expected === 43) {
            writeFileSync(new URL('./helper.mjs', import.meta.url), 'export const expected = 44;');
            writeFileSync(new URL('./config-helper.mjs', import.meta.url), 'export const workers = 2;');
          }
          expect(answer).toBe(expected);
        });\n`);
      const git = (args: string[]) => execFileSync('git', args, { cwd: clonePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      git(['init', '--quiet']);
      git(['add', 'package.json', 'command.mjs', 'vitest.config.mjs', 'config-helper.mjs', 'impl.mjs', 'helper.mjs', 'oracle.test.mjs', 'libs/runner-support']);
      git(['-c', 'user.name=Gym fixture', '-c', 'user.email=gym-fixture@example.invalid', 'commit', '--quiet', '-m', 'Pinned oracle fixture']);
      const pinCommit = git(['rev-parse', 'HEAD']).trim();
      const port = createGymRunnerPorts(cfg().config).runOracle!;
      const input = { clonePath, testPath: 'oracle.test.mjs', implPath: 'impl.mjs', pinCommit };
      const pre = await port(input);
      writeFileSync(join(clonePath, 'impl.mjs'), changedImplementation);
      const post = await port(input);
      if (!pre || Array.isArray(pre) || !post || Array.isArray(post)) throw new Error('Missing real oracle receipt');
      expect(pre.results).toEqual([{ name: 'actual task', file: 'oracle.test.mjs', passed: true }]);
      expect(post.results).toEqual([{ name: 'actual task', file: 'oracle.test.mjs', passed: false }]);
      expect(pre.implementation).toEqual({ path: 'impl.mjs', before: digest(implementation), after: digest(implementation) });
      expect(post.implementation).toEqual({ path: 'impl.mjs', before: digest(changedImplementation), after: digest(changedImplementation) });
      expect(pre.sourceHashes).toEqual(post.sourceHashes);
      expect(pre.execution).toMatchObject({ exitCode: 0, signal: null });
      expect(post.execution).toMatchObject({ exitCode: 1, signal: null });
      const originalManifest = git(['show', `${pinCommit}:package.json`]);
      for (const receipt of [pre, post]) {
        expect(receipt.execution).toMatchObject({ npmManifest: { path: 'package.json', sourceHashes: {
          pinned: digest(originalManifest), before: digest(originalManifest), after: digest(originalManifest),
        } } });
      }
      expect(JSON.parse(pre.execution!.report).testResults[0].assertionResults[0].status).toBe('passed');
      for (const receipt of [pre, post]) {
        expect(receipt.execution).toMatchObject({ commandProcessSources: {
          report: expect.any(String),
          processes: expect.arrayContaining([expect.objectContaining({ entrypoint: 'command.mjs',
            schemaVersion: 'node-loaded-process-sources-v1', status: 'stable',
            sources: expect.arrayContaining([{ path: 'command.mjs', sha256: digest(commandSource), currentSha256: digest(commandSource) }]),
          })]),
          reference: { pinCommit, sources: expect.arrayContaining([{ path: 'command.mjs', sha256: digest(commandSource) }]) },
          unresolved: expect.arrayContaining(['node-process-descendant-population-unmeasured', 'node-preload-self-unmeasured']),
        } });
      }
      for (const receipt of [pre, post]) {
        expect(receipt.execution).toMatchObject({ mainProcessSources: {
          evidence: { scope: 'repository-node-main-process-sources', sources: expect.arrayContaining([
            { path: 'libs/runner-support/index.mjs', sha256: digest(mainSource), currentSha256: digest(mainSource) },
          ]) },
          reference: { pinCommit, sources: expect.arrayContaining([
            { path: 'libs/runner-support/index.mjs', sha256: digest(mainSource) },
          ]) },
        } });
        expect(receipt.execution!.configSources!.loaded!.sources.map(source => source.path))
          .not.toContain('libs/runner-support/index.mjs');
      }
      for (const receipt of [pre, post]) {
        expect(receipt.execution).toMatchObject({ configSources: {
          loaded: { basis: 'node-load-hook', status: 'stable', reasons: [],
            sources: expect.arrayContaining([
              { path: 'config-helper.mjs', sha256: digest(configHelper), currentSha256: digest(configHelper) },
            ]) },
          reference: { pinCommit, sources: expect.arrayContaining([
            { path: 'config-helper.mjs', sha256: digest(configHelper) },
          ]) },
          evidence: { basis: 'reporter-init-disk', status: 'unchanged', reasons: [],
            sources: expect.arrayContaining([
              { path: 'config-helper.mjs', sha256: digest(configHelper), currentSha256: digest(configHelper) },
            ]) },
        } });
        expect(receipt.execution!.unresolved).not.toContain('oracle-config-original-load-unmeasured');
      }
      expect(JSON.parse(post.execution!.report).testResults[0].assertionResults[0].status).toBe('failed');
      for (const receipt of [pre, post]) {
        expect(receipt.execution!.workerSources).toMatchObject({
          reference: { pinCommit, sources: expect.arrayContaining([
            { path: 'helper.mjs', sha256: digest('export const expected = 42;\n') },
          ]) },
          modules: [{ testFile: 'oracle.test.mjs', sourceEvidence: {
            status: 'stable', sources: expect.arrayContaining([
              expect.objectContaining({ path: 'helper.mjs', sha256: digest('export const expected = 42;\n') }),
            ]),
          } }],
        });
        expect(receipt.execution!.workerSources!.report).toBeTruthy();
      }
      expect(post.execution!.workerSources!.modules[0]!.state).toBe('failed');
      // Config evaluation can restore a helper before the reporter starts.
      // Both disk snapshots then match the pin although Vite loaded other bytes.
      const originalConfig = readFileSync(join(clonePath, 'vitest.config.mjs'), 'utf8');
      const rewrittenConfigHelper = 'export const workers = 2;\n';
      writeFileSync(join(clonePath, 'config-helper.mjs'), rewrittenConfigHelper);
      writeFileSync(join(clonePath, 'vitest.config.mjs'), originalConfig +
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./config-helper.mjs', import.meta.url), ${JSON.stringify(configHelper)});\n`);
      const selfRewritingConfig = await port(input);
      if (!selfRewritingConfig || Array.isArray(selfRewritingConfig)) throw new Error('Missing config load receipt');
      expect(selfRewritingConfig.execution!.configSources).toMatchObject({
        evidence: { status: 'unchanged', sources: expect.arrayContaining([
          { path: 'config-helper.mjs', sha256: digest(configHelper), currentSha256: digest(configHelper) },
        ]) },
        loaded: { status: 'changed', reasons: expect.arrayContaining(['config-loaded-source-changed:config-helper.mjs']),
          sources: expect.arrayContaining([
            { path: 'config-helper.mjs', sha256: digest(rewrittenConfigHelper), currentSha256: digest(configHelper) },
          ]) },
      });
      writeFileSync(join(clonePath, 'vitest.config.mjs'), originalConfig);
      // A bare repository import is externalized by Vite and absent from its
      // config dependency list. It can restore itself before reporter init.
      const rewrittenMain = `import { writeFileSync } from 'node:fs';
        writeFileSync(new URL('./index.mjs', import.meta.url), ${JSON.stringify(mainSource)});
        export const allow = false;\n`;
      writeFileSync(join(mainDir, 'index.mjs'), rewrittenMain);
      const selfRestoringMain = await port(input);
      if (!selfRestoringMain || Array.isArray(selfRestoringMain)) throw new Error('Missing main-process receipt');
      expect(selfRestoringMain.execution).toMatchObject({ mainProcessSources: {
        evidence: { status: 'changed', sources: expect.arrayContaining([
          { path: 'libs/runner-support/index.mjs', sha256: digest(rewrittenMain), currentSha256: digest(mainSource) },
        ]) },
        reference: { sources: expect.arrayContaining([
          { path: 'libs/runner-support/index.mjs', sha256: digest(mainSource) },
        ]) },
      } });
      // A stable dirty helper must retain its immutable reference separately.
      // Comparing pre/post alone would silently accept the rewritten oracle.
      writeFileSync(join(clonePath, 'helper.mjs'), 'export const expected = 41;\n');
      const dirtyHelper = await port(input);
      if (!dirtyHelper || Array.isArray(dirtyHelper)) throw new Error('Missing dirty helper receipt');
      expect(dirtyHelper.results[0]!.passed).toBe(true);
      expect(dirtyHelper.execution!.workerSources).toMatchObject({
        reference: { pinCommit, sources: expect.arrayContaining([
          { path: 'helper.mjs', sha256: digest('export const expected = 42;\n') },
        ]) },
        modules: [{ sourceEvidence: { status: 'stable', sources: expect.arrayContaining([
          expect.objectContaining({ path: 'helper.mjs', sha256: digest('export const expected = 41;\n') }),
        ]) } }],
      });
      writeFileSync(join(clonePath, 'helper.mjs'), 'export const expected = 43;\n');
      const drifting = await port(input);
      if (!drifting || Array.isArray(drifting)) throw new Error('Missing drift receipt');
      expect(drifting.execution!.workerSources).toMatchObject({ modules: [{ sourceEvidence: {
        status: 'changed', sources: expect.arrayContaining([expect.objectContaining({
          path: 'helper.mjs', sha256: digest('export const expected = 43;\n'),
          currentSha256: digest('export const expected = 44;'),
        })]),
      } }] });
      expect(drifting.execution).toMatchObject({ configSources: { evidence: {
        status: 'changed', sources: expect.arrayContaining([
          { path: 'config-helper.mjs', sha256: digest(configHelper), currentSha256: digest('export const workers = 2;') },
        ]),
      } } });
      // The actual npm command can change independently of the worker graph.
      // A stable rewritten lifecycle hook remains distinct from the pinned manifest.
      writeFileSync(join(clonePath, 'helper.mjs'), 'export const expected = 41;\n');
      const rewrittenManifest = JSON.stringify({ ...JSON.parse(originalManifest), scripts: {
        ...JSON.parse(originalManifest).scripts, 'pretest:file': 'node -e "process.exit(0)"',
      } });
      writeFileSync(join(clonePath, 'package.json'), rewrittenManifest);
      const dirtyCommand = await port(input);
      if (!dirtyCommand || Array.isArray(dirtyCommand)) throw new Error('Missing dirty command receipt');
      expect(dirtyCommand.results[0]!.passed).toBe(true);
      expect(dirtyCommand.execution).toMatchObject({ npmManifest: { path: 'package.json', sourceHashes: {
        pinned: digest(originalManifest), before: digest(rewrittenManifest), after: digest(rewrittenManifest),
      } } });
      expect(dirtyCommand.execution).toMatchObject({ configSources: {
        reference: { sources: expect.arrayContaining([{ path: 'config-helper.mjs', sha256: digest(configHelper) }]) },
        evidence: { status: 'unchanged', sources: expect.arrayContaining([
          { path: 'config-helper.mjs', sha256: digest('export const workers = 2;'), currentSha256: digest('export const workers = 2;') },
        ]) },
      } });
    } finally { rmSync(clonePath, { recursive: true, force: true }); }
  }, 30_000);

  it.each([false, true])('retains intermediate loader audit verbatim and cleans its file (command failure=%s)', async failure => {
    const clonePath = mkdtempSync(join(tmpdir(), 'gym-loader-audit-'));
    // Propagation only: actual native byte/transform semantics are verified by
    // committed-source-loader.test.ts, not inferred from this controlled record.
    const raw = JSON.stringify({ boundary: 'node-esm-load-return', returnedSha256: 'controlled',
      unresolved: ['later-loader-transforms-unmeasured'] }) + '\n';
    let loaderPath = '';
    try {
      writeFileSync(join(clonePath, 'oracle.test.js'), 'oracle');
      const { config } = cfg({ execCapture: async (cmd, args, opts) => {
        if (cmd === 'git') return { stdout: 'oracle', stderr: '' };
        loaderPath = opts?.env?.PAPERCUSP_COMMITTED_SOURCE_AUDIT ?? '';
        expect(loaderPath).not.toBe('');
        writeFileSync(loaderPath, raw);
        writeFileSync(args.find(arg => arg.startsWith('--outputFile='))!.slice('--outputFile='.length),
          JSON.stringify({ testResults: [{ assertionResults: [{ fullName: 't', status: 'passed' }] }] }));
        if (failure) throw Object.assign(new Error('controlled command failure'), { code: 7 });
        return { stdout: '', stderr: '' };
      } });
      const receipt = await createGymRunnerPorts(config).runOracle!({ clonePath, testPath: 'oracle.test.js', pinCommit: 'a'.repeat(40) });
      expect(receipt).toMatchObject({ execution: { exitCode: failure ? 7 : 0,
        commandProcessSources: { loaderReport: raw,
          unresolved: expect.arrayContaining(['committed-source-loader-chain-not-closed']) } } });
      expect(existsSync(loaderPath)).toBe(false);
    } finally { rmSync(clonePath, { recursive: true, force: true }); }
  });

  it.each(['exit', 'signal', 'spawn'] as const)('retains a report without hiding the test command %s failure', async (failure) => {
    const clonePath = mkdtempSync(join(tmpdir(), 'gym-oracle-command-'));
    try {
      writeFileSync(join(clonePath, 'oracle.test.js'), 'oracle');
      writeFileSync(join(clonePath, 'impl.js'), 'implementation');
      const { config } = cfg({ execCapture: async (cmd, args) => {
        if (cmd === 'git') return { stdout: 'oracle', stderr: '' };
        const outputArg = args.find((arg) => arg.startsWith('--outputFile='))!;
        writeFileSync(outputArg.slice('--outputFile='.length), JSON.stringify({ testResults: [
          { assertionResults: [{ fullName: 't', status: 'passed' }] },
        ] }));
        throw Object.assign(new Error('oracle command failed'), {
          code: failure === 'exit' ? 7 : failure === 'spawn' ? 'ENOENT' : null,
          signal: failure === 'signal' ? 'SIGTERM' : null,
        });
      } });
      const input = { clonePath, testPath: 'oracle.test.js', implPath: 'impl.js', pinCommit: 'a'.repeat(40) };
      expect(await createGymRunnerPorts(config).runOracle!(input)).toMatchObject({
        results: [{ name: 't', passed: true }],
        execution: { exitCode: failure === 'exit' ? 7 : null, signal: failure === 'signal' ? 'SIGTERM' : null },
      });
    } finally { rmSync(clonePath, { recursive: true, force: true }); }
  });

  it('retains file collection failures and handles malformed reports as unmeasured', () => {
    expect(parseVitestOracleResults(JSON.stringify({ testResults: [{ name: 'broken.test.ts', assertionResults: [] }] })))
      .toEqual([{ name: '', file: 'broken.test.ts', passed: false, executed: false }]);
    expect(parseVitestOracleResults('null')).toEqual([]);
    expect(parseVitestOracleResults('not json')).toEqual([]);
    expect(parseVitestOracleResults(JSON.stringify({ testResults: [{ name: 'hook.test.ts', status: 'failed',
      assertionResults: [{ fullName: 'passed before hook error', status: 'passed' }],
    }] }))).toEqual([
      { name: 'passed before hook error', file: 'hook.test.ts', passed: true },
      { name: '', file: 'hook.test.ts', passed: false, executed: false },
    ]);
  });

  it('cloneSubstrate runs git clone then checkout --detach at the pinned commit', async () => {
    const { config, execs } = cfg();
    const p = createGymRunnerPorts(config);
    await p.cloneSubstrate({ source: '/repos/sub', commit: '0123456789abcdef0123456789abcdef01234567', destDir: '/c/gymx' });
    expect(execs[0]).toContain('clone');
    expect(execs[1]).toEqual(['git', '-C', '/c/gymx', 'checkout', '--detach', '0123456789abcdef0123456789abcdef01234567']);
  });

  it('registerThrowawayHarness POSTs the slug + path to /api/harness/projects', async () => {
    const { config, reqs } = cfg();
    const p = createGymRunnerPorts(config);
    await p.registerThrowawayHarness({ slug: 'gymx', clonePath: '/c/gymx', workspaceId: 'gym-ws' });
    expect(reqs[0].url).toBe('http://127.0.0.1:3971/api/harness/projects');
    expect(JSON.parse(reqs[0].init.body as string)).toEqual({ slug: 'gymx', path: '/c/gymx' });
  });

  it('registerThrowawayHarness throws (fail-loud) when scaffold failed even on HTTP 200', async () => {
    // The /api/harness/projects route swallows a scaffoldHarnessSchema() failure:
    // it returns HTTP 200 / ok:true with provisioning:{ok:false,error}. If the port
    // ignores `provisioning`, the per-harness `harness_features` VIEW is never created
    // and the worker's `UPDATE harness_features` later 42P01s deep in the pipeline.
    // The port MUST surface the scaffold error at registration time.
    const { config } = cfg({
      fetchFn: (async (url: string, init: RequestInit) => ({
        ok: true,
        status: 200,
        text: async () => 'unused',
        json: async () => ({
          ok: true,
          project: { slug: 'gymx', path: '/c/gymx' },
          provisioning: { ok: false, error: 'relation "harness_shared.harness_features_consolidated" does not exist' },
        }),
      })) as unknown as typeof fetch,
    });
    const p = createGymRunnerPorts(config);
    await expect(
      p.registerThrowawayHarness({ slug: 'gymx', clonePath: '/c/gymx', workspaceId: 'gym-ws' }),
    ).rejects.toThrow(/scaffold|provisioning|harness_features_consolidated/);
  });

  it('registerThrowawayHarness succeeds when provisioning.ok is true (or absent)', async () => {
    // ok:true + provisioning.ok:true → no throw (the default cfg fake omits provisioning,
    // which must also be treated as success so non-scaffold registration paths still work).
    const { config } = cfg();
    const p = createGymRunnerPorts(config);
    await expect(
      p.registerThrowawayHarness({ slug: 'gymx', clonePath: '/c/gymx', workspaceId: 'gym-ws' }),
    ).resolves.toBeUndefined();
  });

  it('registerThrowawayHarness (WI-2604): a 409 for the SAME slug at the SAME clone path is idempotent (no throw) — a leftover/replayed throwaway harness', async () => {
    // gymRunIdentity derives a DETERMINISTIC slug from (task×variant×cycle×repeat) so a
    // DBOS replay / re-run of the same key intentionally re-registers the same slug.
    // Nothing tears the project entry down after a successful run, so this 409 is the
    // COMMON case, not an error — it must resolve, never throw.
    const { config, reqs } = cfg({
      fetchFn: (async (url: string, init?: RequestInit) => {
        reqs.push({ url, init: init ?? {} });
        if (init?.method === 'POST') {
          return { ok: false, status: 409, text: async () => '{"error":"slug already exists"}' } as unknown as Response;
        }
        // The idempotency-check GET
        return {
          ok: true,
          status: 200,
          json: async () => ({ projects: [{ slug: 'gymx', path: '/c/gymx' }] }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    const p = createGymRunnerPorts(config);
    await expect(
      p.registerThrowawayHarness({ slug: 'gymx', clonePath: '/c/gymx', workspaceId: 'gym-ws' }),
    ).resolves.toBeUndefined();
    expect(reqs.some((r) => r.init.method === undefined && r.url.endsWith('/api/harness/projects'))).toBe(true);
  });

  it('registerThrowawayHarness (WI-2604): a 409 for the SAME slug at a DIFFERENT path still throws (a real collision, not a replay)', async () => {
    const { config } = cfg({
      fetchFn: (async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return { ok: false, status: 409, text: async () => '{"error":"slug already exists"}' } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ projects: [{ slug: 'gymx', path: '/some/other/unrelated/path' }] }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    const p = createGymRunnerPorts(config);
    await expect(
      p.registerThrowawayHarness({ slug: 'gymx', clonePath: '/c/gymx', workspaceId: 'gym-ws' }),
    ).rejects.toThrow(/409|collision/);
  });

  it('registerThrowawayHarness (EI-7196): a 409 for the SAME slug under a DIFFERENT scratch root but SAME clone-dir basename is idempotent (no throw)', async () => {
    // The autoloop clones under a FRESH `mkdtemp` scratch root every fire, so the absolute
    // clonePath legitimately changes run-to-run (/tmp/gym-loop-AAA/<slug> → …-BBB/<slug>)
    // even though the deterministic slug is stable and the registry still holds the PRIOR
    // run's path. WI-2604's strict full-path equality never matched this real replay and
    // threw on every subsequent fire — the CHRONIC red. The clone dir is always named after
    // the slug, so a basename match recognizes the same throwaway under any scratch root.
    const { config, reqs } = cfg({
      fetchFn: (async (url: string, init?: RequestInit) => {
        reqs.push({ url, init: init ?? {} });
        if (init?.method === 'POST') {
          return { ok: false, status: 409, text: async () => '{"error":"slug already exists"}' } as unknown as Response;
        }
        // The registry still holds the PRIOR fire's path — a DIFFERENT scratch root, same basename.
        return {
          ok: true,
          status: 200,
          json: async () => ({ projects: [{ slug: 'gymx', path: '/tmp/gym-loop-AAA/gymx' }] }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    const p = createGymRunnerPorts(config);
    await expect(
      p.registerThrowawayHarness({ slug: 'gymx', clonePath: '/tmp/gym-loop-BBB/gymx', workspaceId: 'gym-ws' }),
    ).resolves.toBeUndefined();
    expect(reqs.some((r) => r.init.method === undefined && r.url.endsWith('/api/harness/projects'))).toBe(true);
  });

  it('startPipeline hits the admin route with the superuser bearer + returns the workflow id', async () => {
    const { config, reqs } = cfg();
    const p = createGymRunnerPorts(config);
    const out = await p.startPipeline({ slug: 'gymx', featureId: 'F-GYM-1', workspaceId: 'gym-ws' });
    expect(reqs[0].url).toContain('/api/admin/dbos/pipeline/start');
    expect(reqs[0].url).toContain('superuser=1');
    expect((reqs[0].init.headers as Record<string, string>).authorization).toBe('Bearer sekret-token-1234567890');
    expect(JSON.parse(reqs[0].init.body as string)).toEqual({ harnessSlug: 'gymx', featureId: 'F-GYM-1' });
    expect(out.workflowID).toBe('pipeline:gymx:F-GYM-1:e0');
  });

  it('teardownHarness (EI-484) also DELETEs the throwaway harness project registration, not just the schema/clone', async () => {
    // Without this, /api/harness/projects keeps the entry after teardown drops the
    // schema — the NEXT replay of this deterministic slug then basename-matches the
    // stale registration (WI-2604/EI-7196's 409 idempotency check) and skips real
    // re-registration, so the pipeline 42P01s against the schema this call just
    // dropped (the follow-up edge EI-7196's resolution flagged as still-open).
    const { config, reqs } = cfg({ gymSql: fakeSql() });
    const p = createGymRunnerPorts(config);
    await p.teardownHarness({ slug: 'gymx', clonePath: '/c/gymx', workspaceId: 'gym-ws' });
    const del = reqs.find((r) => r.init.method === 'DELETE');
    expect(del?.url).toBe('http://127.0.0.1:3971/api/harness/projects/gymx');
  });

  it('teardownHarness never throws even when the DELETE fails (best-effort cleanup)', async () => {
    const { config } = cfg({
      gymSql: fakeSql(),
      fetchFn: (async () => { throw new Error('network down'); }) as unknown as typeof fetch,
      rm: async () => { throw new Error('rm failed'); },
    });
    const p = createGymRunnerPorts(config);
    await expect(
      p.teardownHarness({ slug: 'gymx', clonePath: '/c/gymx', workspaceId: 'gym-ws' }),
    ).resolves.toBeUndefined();
  });

  it('now + sleep work', async () => {
    const p = createGymRunnerPorts(cfg().config);
    expect(typeof p.now()).toBe('number');
    await expect(p.sleep(1)).resolves.toBeUndefined();
  });
});
