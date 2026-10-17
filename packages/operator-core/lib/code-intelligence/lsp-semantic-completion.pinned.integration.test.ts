/** Candidate only: real pinned wrapper/plugin/native request seam, with authored ground truth. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createTextCollector } from '../child-output';
import { transformSync } from 'esbuild';
import { CancellationTokenSource, createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';

const storage = vi.hoisted(() => ({ sql: undefined as postgres.Sql | undefined, tasks: [] as string[] }));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => {
    if (!storage.sql) throw new Error('native completion fixture PG not initialized');
    return { sql: storage.sql };
  },
}));
vi.mock('@papercusp/flags/server', async original => ({
  ...await original<typeof import('@papercusp/flags/server')>(), getFlag: async () => true,
}));
vi.mock('../task-manager/managed-spawn', async original => {
  const actual = await original<typeof import('../task-manager/managed-spawn')>();
  return { ...actual, managedSpawn: async (...args: Parameters<typeof actual.managedSpawn>) => {
    const result = await actual.managedSpawn(args[0], args[1], args[2], { ...args[3], workspaceId });
    storage.tasks.push(result.taskId);
    return result;
  } };
});

import { managedSpawn } from '../task-manager/managed-spawn';
import { killTask } from '../task-manager/control';
import { closeTask } from '../task-manager/store';
import { taskTerminalEventKey } from '../task-manager/task-terminal-events';
import { LSP_VENDOR_DIR, resolveServerBin, resolveTsserverPath, shutdownAllLspClients, shutdownLspClient, typescriptInitializationOptions, typescriptWorkspaceMemoryMb } from './lsp-adapter';
import { dispatchLspDaemonRequest } from './lsp-daemon-server';
import { freezeCompilerReplayConfig, materializeReplaySource, replayHash, replaySemanticCompletionContext, validateDaemonReplayConfig } from './lsp-fleet-replay-runtime';
import { requestSemanticCompletion, SEMANTIC_COMPLETION_COMMAND, SEMANTIC_COMPLETION_TYPESCRIPT_VERSION,
  type SemanticCompletionRequest } from './lsp-semantic-completion';

// Reuse the task-terminal integration boundary: initialize its import graph
// before child exit callbacks, route persistence to migrated isolated PG, and
// join each terminal latch before disposing that database.
const eventEngine = await import('../events/await/engine');
const workspaceId = `test-lsp-native-completion-${process.pid}`;
let db: OrgTestDb | undefined;
let previousAutoPump = true;
beforeAll(async () => {
  db = await createOrgTestDb();
  storage.sql = db.adminSql;
  previousAutoPump = eventEngine.setAutoPumpEnabledForTests(false);
}, 120_000);
afterAll(async () => {
  eventEngine.setAutoPumpEnabledForTests(previousAutoPump);
  await db?.cleanup();
  storage.sql = undefined;
}, 30_000);

async function finishOwnedTask(taskId: string): Promise<void> {
  // A systemd-run wrapper can exit before its payload. Verify and reap the
  // exact owned scope even when the wrapper has already exited.
  const outcome = await killTask(taskId, { includeSubtree: true, reapTerminalResidue: true, escalateAfterMs: 500 });
  if (!outcome.ok && outcome.error !== 'already_gone') {
    throw new Error(`native completion fixture cleanup refused: ${outcome.error}`);
  }
  if (!outcome.ok && outcome.error === 'already_gone') {
    await closeTask(taskId, { state: 'stranded', exitReason: 'fixture verified process gone at teardown' });
  }
  await expect.poll(async () => {
    const [row] = await storage.sql!`
      SELECT task.workspace_id, task.state, task.ended_at IS NOT NULL AS ended,
             fire.fire_count, fire.last_payload->>'taskId' AS emitted_task,
             fire.last_payload->>'state' = task.state AS matching_state
        FROM harness_shared.task_ledger task
        LEFT JOIN harness_shared.event_key_fires fire ON fire.event_key = ${taskTerminalEventKey(taskId)}
       WHERE task.task_id = ${taskId}
    `;
    return row;
  }, { timeout: 5_000, interval: 20 }).toMatchObject({
    workspace_id: workspaceId, ended: true, fire_count: 1, emitted_task: taskId, matching_state: true,
  });
}

const pluginName = 'papercusp-semantic-completion-fixture';
const controls = ['complete', 'complete-projects', 'missing-file', 'extra-file', 'missing-project', 'extra-project',
  'disabled', 'cancel-before', 'cancel-after'] as const;

// Only this fixture wrapper mutates native state. Production candidate code is
// compiled unchanged; cancellation uses tsserver's ACTUAL per-request pipe.
const controlWrapper = String.raw`
const candidate = module.exports.default;
const fs = require('node:fs');
const activationFile = require('node:path').join(__dirname, '../../../native-plugin-activations.jsonl');
const sessionIds = new WeakMap();
const fixtureInterceptors = new WeakSet();
let nextSessionId = 0;
let nextFactoryId = 0;
module.exports = function(modules) {
  const factoryId = ++nextFactoryId;
  const plugin = candidate(modules);
  return { create(info) {
    const session = info.session;
    if (!sessionIds.has(session)) sessionIds.set(session, ++nextSessionId);
    const activation = { processId: process.pid, serverMode: session.projectService.serverMode,
      factoryId, sessionId: sessionIds.get(session),
      projectName: info.project.getProjectName(), registrations: 0, registrationCalls: [], ok: false };
    const add = session.addProtocolHandler;
    session.addProtocolHandler = function(command, handler) {
      activation.registrations++;
      const receipt = { command, nestedDelegate: fixtureInterceptors.has(add), nativeSuccess: false };
      activation.registrationCalls.push(receipt);
      const result = add.call(this, command, function(request) {
        const control = request.arguments && request.arguments.nativeControl;
        let pipe;
        const references = session.getReferences;
        try {
          if (control === 'disabled') {
            const project = session.projectService.findProject(request.arguments.population[0].projectName);
            if (!project) throw new Error('fixture project missing');
            project.disableLanguageService();
          }
          if (control === 'cancel-before' || control === 'cancel-after') {
            const index = process.argv.indexOf('--cancellationPipeName');
            const pattern = process.argv[index + 1];
            if (index < 0 || !pattern.endsWith('*')) throw new Error('fixture native cancellation pipe missing');
            pipe = pattern.slice(0, -1) + request.seq;
            if (control === 'cancel-before') fs.writeFileSync(pipe, '');
            else session.getReferences = function(...args) {
              const result = references.apply(this, args);
              fs.writeFileSync(pipe, '');
              return result;
            };
          }
          return handler(request);
        } finally {
          session.getReferences = references;
          if (pipe) fs.rmSync(pipe, { force: true });
        }
      });
      receipt.nativeSuccess = !receipt.nestedDelegate;
      return result;
    };
    fixtureInterceptors.add(session.addProtocolHandler);
    try {
      const service = plugin.create(info);
      activation.ok = true;
      return service;
    } catch (error) {
      activation.error = String(error);
      throw error;
    } finally {
      session.addProtocolHandler = add;
      fs.appendFileSync(activationFile, JSON.stringify(activation) + '\n');
    }
  } };
};
`;

describe('candidate completion through the pinned native plugin package', () => {
  it.each(controls)('qualifies only the declared authored population: %s', async control => {
    const bin = resolveServerBin('typescript');
    expect(bin, 'the maintained pinned server must be provisioned').not.toBeNull();
    const tsserver = resolveTsserverPath();
    const compiler = createRequire(tsserver)('./typescript.js') as { version: string };
    expect(compiler.version).toBe(SEMANTIC_COMPLETION_TYPESCRIPT_VERSION);
    const root = mkdtempSync(join(tmpdir(), 'lsp-native-completion-'));
    const target = join(root, 'target.ts');
    const consumer = join(root, 'consumer.ts');
    const config = join(root, 'tsconfig.json');
    const source = 'export function semanticTarget() { return 1; }\nsemanticTarget();\n';
    // This declaration is authored BEFORE launching or asking the compiler.
    // noLib/types:[] excludes ambient dependencies; config is part of the graph.
    const population = [{ projectName: config, anchorFile: target, files: [target, consumer, config] }];
    writeFileSync(config, JSON.stringify({ compilerOptions: { strict: true, noLib: true, types: [] },
      files: ['target.ts', 'consumer.ts'] }));
    writeFileSync(target, source);
    writeFileSync(consumer, 'import { semanticTarget } from "./target";\nsemanticTarget();\n');
    const secondConsumer = join(root, 'second', 'consumer.ts');
    if (control === 'complete-projects') {
      const secondConfig = join(root, 'second', 'tsconfig.json');
      mkdirSync(join(root, 'second'));
      writeFileSync(secondConfig, JSON.stringify({ compilerOptions: { strict: true, noLib: true, types: [] },
        files: ['consumer.ts'] }));
      writeFileSync(secondConsumer, 'import { semanticTarget } from "../target";\nsemanticTarget();\n');
      // Independently authored imported-source closure, before native startup.
      population.push({ projectName: secondConfig, anchorFile: secondConsumer,
        files: [target, secondConsumer, secondConfig] });
    }
    const pluginRoot = join(root, 'probe');
    const packageRoot = join(pluginRoot, 'node_modules', pluginName);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: pluginName, version: '0.0.0', main: 'index.cjs' }));
    const candidate = readFileSync(new URL('./lsp-semantic-completion.ts', import.meta.url), 'utf8');
    writeFileSync(join(packageRoot, 'index.cjs'), transformSync(candidate, { loader: 'ts', format: 'cjs', target: 'node22' }).code + controlWrapper);
    let task: Awaited<ReturnType<typeof managedSpawn>> | undefined;
    let connection: ReturnType<typeof createMessageConnection> | undefined;
    const stderr = createTextCollector(undefined, { maxChars: 8_192 });
    try {
      task = await managedSpawn(bin!, ['--stdio'], { class: 'sidecar',
        title: `lsp-native-completion-${control}`, argv: [bin!, '--stdio'], cwd: root,
        launchedBy: 'test:lsp-native-completion', planSlug: 'lsp-fleet-scale-all-languages-2026-08-21' },
      { workspaceId, spawnOptions: { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] } });
      stderr.attach(task.child.stderr);
      connection = createMessageConnection(new StreamMessageReader(task.child.stdout!), new StreamMessageWriter(task.child.stdin!));
      connection.onRequest('window/workDoneProgress/create', () => null);
      connection.listen();
      const rpc = async <T,>(method: string, args: unknown, token?: CancellationTokenSource): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            token ? connection!.sendRequest<T>(method, args, token.token) : connection!.sendRequest<T>(method, args),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} deadline; stderr=${stderr.peek()}`)), 20_000); }),
          ]);
        } finally { if (timer) clearTimeout(timer); }
      };
      const rootUri = pathToFileURL(root).href;
      await rpc('initialize', { processId: process.pid, rootUri,
        workspaceFolders: [{ uri: rootUri, name: 'authored-native-completion' }],
        initializationOptions: { ...typescriptInitializationOptions(tsserver, undefined, root),
          disableAutomaticTypingAcquisition: true, plugins: [{ name: pluginName, location: pluginRoot }] },
        capabilities: { window: { workDoneProgress: true } } });
      await connection.sendNotification('initialized', {});
      await connection.sendNotification('textDocument/didOpen', { textDocument: {
        uri: pathToFileURL(target).href, languageId: 'typescript', version: 1, text: source } });
      const native = (command: string, args: unknown, token?: CancellationTokenSource) => rpc('workspace/executeCommand', {
        command: 'typescript.tsserverRequest', arguments: [command, args, { executionTarget: 0 }] }, token);
      // projectInfo is used to wait for plugin registration, NEVER to author
      // the population or the expected reference sites.
      await native('projectInfo', { file: target, needFileNameList: false });
      if (control === 'complete-projects') {
        await connection.sendNotification('textDocument/didOpen', { textDocument: {
          uri: pathToFileURL(secondConsumer).href, languageId: 'typescript', version: 1,
          text: 'import { semanticTarget } from "../target";\nsemanticTarget();\n' } });
        await native('projectInfo', { file: secondConsumer, needFileNameList: false });
        const activations = readFileSync(join(root, 'native-plugin-activations.jsonl'), 'utf8')
          .trim().split('\n').map(line => JSON.parse(line) as {
            processId: number; serverMode: number;
            factoryId: number; sessionId: number; projectName: string; registrations: number; ok: boolean; error?: string;
            registrationCalls: { command: string; nestedDelegate: boolean; nativeSuccess: boolean }[];
          });
        console.info('WI41095_NATIVE_REGISTRATIONS', JSON.stringify(activations));
        // The wrapper also activates the plugin in its separate syntax child.
        // Session/factory counters are process-local: qualify their PID before
        // requiring one shared semantic session across configured projects.
        const configured = activations.filter(row => population.some(project => project.projectName === row.projectName));
        expect(configured.map(row => row.projectName).sort(), JSON.stringify(activations))
          .toEqual(population.map(project => project.projectName).sort());
        expect(new Set(configured.map(row => row.factoryId)).size).toBe(2);
        expect(configured.every(row => row.serverMode === 0), JSON.stringify(activations)).toBe(true);
        expect(new Set(configured.map(row => `${row.processId}:${row.sessionId}`)).size).toBe(1);
        expect(activations.every(row => row.ok), JSON.stringify(activations)).toBe(true);
        // Count actual native delegation per session, including the syntax
        // child. A duplicate attempt or failed native registration still fails.
        const sessionKeys = new Set(activations.map(row => `${row.processId}:${row.sessionId}`));
        for (const sessionKey of sessionKeys) {
          const rows = activations.filter(row => `${row.processId}:${row.sessionId}` === sessionKey);
          const calls = rows.flatMap(row => row.registrationCalls);
          expect(rows.reduce((sum, row) => sum + row.registrations, 0), JSON.stringify(rows)).toBe(1);
          expect(calls, JSON.stringify(rows)).toEqual([
            { command: SEMANTIC_COMPLETION_COMMAND, nestedDelegate: false, nativeSuccess: true },
          ]);
        }
      }
      const request: SemanticCompletionRequest & { nativeControl?: string } = {
        file: target, line: 2, offset: 2,
        population: population.map(project => ({ ...project, files: [...project.files] })),
      };
      if (control === 'missing-file') request.population[0].files.push(join(root, 'omitted.ts'));
      if (control === 'extra-file') request.population[0].files = request.population[0].files.filter(file => file !== consumer);
      if (control === 'missing-project') request.population.push({ projectName: join(root, 'missing', 'tsconfig.json'),
        anchorFile: join(root, 'missing', 'target.ts'), files: [join(root, 'missing', 'target.ts')] });
      if (control === 'extra-project') {
        const extra = join(root, 'extra');
        mkdirSync(extra);
        writeFileSync(join(extra, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noLib: true, types: [] }, files: ['extra.ts'] }));
        writeFileSync(join(extra, 'extra.ts'), 'export const extra = 1;\n');
        await connection.sendNotification('textDocument/didOpen', { textDocument: {
          uri: pathToFileURL(join(extra, 'extra.ts')).href, languageId: 'typescript', version: 1, text: 'export const extra = 1;\n' } });
        await native('projectInfo', { file: join(extra, 'extra.ts'), needFileNameList: false });
      }
      if (['disabled', 'cancel-before', 'cancel-after'].includes(control)) request.nativeControl = control;
      if (control === 'complete' || control === 'complete-projects') {
        const result = await requestSemanticCompletion(request, { isCancellationRequested: false }, native);
        expect(result.population).toEqual(population.map(project => ({ ...project, files: [...project.files].sort() }))
          .sort((a, b) => a.projectName.localeCompare(b.projectName)));
        const sites = result.refs.map(ref => [ref.file.slice(root.length + 1), ref.start.line, ref.start.offset])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        const expectedSites = [['consumer.ts', 1, 10], ['consumer.ts', 2, 1], ['target.ts', 1, 17], ['target.ts', 2, 1]];
        if (control === 'complete-projects') expectedSites.push(['second/consumer.ts', 1, 10], ['second/consumer.ts', 2, 1]);
        expect(sites).toEqual(expectedSites.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
        // Characterize the wrapper's ignored token, then require our outer
        // boundary to refuse the same pre-cancelled caller independently.
        const cancelled = new CancellationTokenSource();
        try {
          cancelled.cancel();
          await expect(native(SEMANTIC_COMPLETION_COMMAND, request, cancelled)).resolves.toMatchObject({ success: true });
          await expect(requestSemanticCompletion(request, cancelled.token, native)).rejects.toThrow('outer-cancelled');
        } finally { cancelled.dispose(); }
        console.info('WI41095_NATIVE_COMPLETION', JSON.stringify({ control, sites, declared: population,
          certification: 'authored-fixture-only', productionReadiness: 'unchanged' }));
      } else {
        const expected = control.startsWith('cancel') ? /semantic completion refused: cancelled/
          : control === 'disabled' ? /semantic completion refused: disabled-project/
          : control === 'extra-project' ? /semantic completion refused: extra-project/
          : control === 'missing-project' ? /No Project|No project|not found|semantic completion refused/
          : /semantic completion refused: project-or-file-population-mismatch/;
        await expect(requestSemanticCompletion(request, { isCancellationRequested: false }, native)).rejects.toThrow(expected);
        console.info('WI41095_NATIVE_COMPLETION', JSON.stringify({ control, refused: true, certification: 'authored-fixture-only' }));
      }
    } finally {
      try {
        try {
          if (task && connection) await shutdownLspClient({ connection, child: task.child, taskId: task.taskId, scopeUnit: task.scopeUnit });
        } finally {
          if (task) await finishOwnedTask(task.taskId);
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }, 60_000);
});

describe('independent semantic graph through the production daemon adapter', () => {
  it('preserves the real pinned vendor and independently declared graph in a standalone copy', () => {
    const parent = mkdtempSync(join(tmpdir(), 'lsp-production-vendor-copy-'));
    const root = join(parent, 'donor'); mkdirSync(root);
    try {
      writeFileSync(join(root, 'target.ts'), 'export function semanticTarget() { return 1; }\nsemanticTarget();\n');
      writeFileSync(join(root, 'consumer.ts'), 'import { semanticTarget } from "./target";\nsemanticTarget();\n');
      writeFileSync(join(root, 'base.json'), JSON.stringify({ compilerOptions: { lib: ['es5'], types: [] } }));
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ extends: './base.json', files: ['target.ts', 'consumer.ts'] }));
      const vendor = realpathSync(LSP_VENDOR_DIR);
      const tsserver = realpathSync(resolveTsserverPath(vendor));
      const compilerEntry = createRequire(tsserver).resolve('./typescript.js');
      const copied = materializeReplaySource({ runId: 'production-vendor-copy', rootPath: root,
        workspaceId, socketPath: join(parent, 'unused.sock'), levels: [1], requestTimeoutMs: 30_000,
        compilerEntry, compilerPackageRoot: vendor, tsconfigPath: 'tsconfig.json',
        definition: { file: 'target.ts', line1: 2, character: 1 },
        references: { file: 'target.ts', line1: 2, character: 1 }, runtimeFiles: [],
        evidenceRef: 'authored-production-vendor-copy-fixture' }, join(parent, 'copied'), {
        enumerateSources: () => ['base.json', 'consumer.ts', 'target.ts', 'tsconfig.json'],
        // This authored project has no workspace package imports. Its complete
        // external server/compiler package tree is declared above and copied by
        // the maintained runtime copier, independently of native observations.
        snapshotDependencies: (donor, destination) => {
          expect(donor).toBe(root);
          // Reuse the source-materialization suite's empty workspace receipt.
          // The external vendor population is copied separately in full.
          writeFileSync(join(destination, '.papercusp-pinned-deps'), 'mode=copy\ntrees=0\n', { flag: 'wx' });
        },
        // This authored donor is not a Papercusp checkout and has no release
        // admission script. Exercise the existing admission seam against the
        // fixture's actual filesystem before copying any declared vendor bytes.
        checkSourceHeadroom: (donor, destination, bytes) => {
          expect(donor).toBe(root);
          expect(destination).toBe(join(parent, 'copied'));
          const capacity = statfsSync(parent, { bigint: true });
          expect(capacity.bavail * capacity.bsize).toBeGreaterThan(BigInt(bytes));
        },
      });
      const copiedVendor = copied.compilerPackageRoot!;
      const dependencyStamp = join(copied.rootPath, '.papercusp-pinned-deps');
      expect(readFileSync(dependencyStamp, 'utf8')).toBe('mode=copy\ntrees=0\n');
      const snapshot = JSON.parse(readFileSync(copied.sourceSnapshot!.manifestPath, 'utf8'));
      expect(snapshot.sourceFiles['.papercusp-pinned-deps']).toBe(replayHash(readFileSync(dependencyStamp)));
      expect(snapshot.loadedRuntime).toBe('unmeasured');
      expect(copied.runtimeFiles).toEqual(expect.arrayContaining([dependencyStamp, copied.sourceSnapshot!.manifestPath]));
      const copiedServer = realpathSync(resolveTsserverPath(copiedVendor));
      expect(createRequire(copiedServer).resolve('./typescript.js')).toBe(copied.compilerEntry);
      for (const relative of ['package.json', 'package-lock.json',
        'node_modules/typescript-language-server/lib/cli.mjs',
        'node_modules/@typescript/old/lib/tsserver.js', 'node_modules/@typescript/old/lib/typescript.js']) {
        const original = join(vendor, relative); const independent = join(copiedVendor, relative);
        expect(readFileSync(independent)).toEqual(readFileSync(original));
        expect([statSync(independent).dev, statSync(independent).ino])
          .not.toEqual([statSync(original).dev, statSync(original).ino]);
      }
      expect(JSON.parse(readFileSync(join(copiedVendor, 'node_modules/typescript-language-server/package.json'), 'utf8')).version)
        .toBe('6.0.0');
      expect(createRequire(copiedServer)(copied.compilerEntry!).version).toBe(SEMANTIC_COMPLETION_TYPESCRIPT_VERSION);
      // Removing the authored donor before compiler/config loading proves the
      // declared graph does not depend on that source tree still being present.
      rmSync(root, { recursive: true });
      const frozen = freezeCompilerReplayConfig(copied);
      expect(Object.keys(frozen.semanticGraph!.compilerEntries)).toEqual([copied.compilerEntry]);
      expect(frozen.semanticGraph!.projects).toHaveLength(1);
      expect(frozen.semanticGraph!.projects[0].projectName).toBe(join(copied.rootPath, 'tsconfig.json'));
      expect(frozen.semanticGraph!.projects[0].files).toEqual(expect.arrayContaining([
        join(copied.rootPath, 'base.json'), join(copied.rootPath, 'tsconfig.json'),
        join(copied.rootPath, 'target.ts'), join(copied.rootPath, 'consumer.ts'),
        join(copiedVendor, 'node_modules/@typescript/old/lib/lib.es5.d.ts'),
      ]));
      expect(frozen.corpus['hot-references'].oracle.sites).toEqual([
        { path: 'consumer.ts', line1: 1 }, { path: 'consumer.ts', line1: 2 },
        { path: 'target.ts', line1: 1 }, { path: 'target.ts', line1: 2 },
      ]);
      expect(typescriptWorkspaceMemoryMb(copied.rootPath, copiedServer)).toBe(6400);
      expect(() => validateDaemonReplayConfig(frozen)).not.toThrow();
      console.info('WI41095_COPIED_VENDOR_ADMISSION', JSON.stringify({ compilerVersion: frozen.oracleProvenance.compilerVersion,
        projects: frozen.semanticGraph!.projects.length, memoryMb: 6400, certification: 'prelaunch-authored-fixture-only' }));
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }, 60_000);

  it.each(['complete', 'missing-consumer'] as const)('checks configured library and inherited-config closure: %s', async control => {
    const root = mkdtempSync(join(tmpdir(), 'lsp-daemon-semantic-'));
    const taskStart = storage.tasks.length;
    try {
      const target = join(root, 'target.ts'); const consumer = join(root, 'consumer.ts');
      writeFileSync(target, 'export function semanticTarget() { return 1; }\nsemanticTarget();\n');
      writeFileSync(consumer, 'import { semanticTarget } from "./target";\nsemanticTarget();\n');
      writeFileSync(join(root, 'base.json'), JSON.stringify({ compilerOptions: { strict: true, types: [], lib: ['es5'] } }));
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ extends: './base.json', files: ['target.ts', 'consumer.ts'] }));
      const location = join(root, 'probe'); const packageRoot = join(location, 'node_modules', pluginName);
      mkdirSync(packageRoot, { recursive: true });
      const manifest = join(packageRoot, 'package.json'); const entry = join(packageRoot, 'index.cjs');
      writeFileSync(manifest, JSON.stringify({ name: pluginName, version: '0.0.0', main: 'index.cjs' }));
      const source = readFileSync(new URL('./lsp-semantic-completion.ts', import.meta.url), 'utf8');
      writeFileSync(entry, transformSync(source, { loader: 'ts', format: 'cjs', target: 'node22' }).code + '\nmodule.exports = module.exports.default;\n');
      const files = Object.fromEntries([manifest, entry].map(file => [file, replayHash(readFileSync(file))]));
      // Independently freeze compiler population and plugin bytes BEFORE native startup.
      const frozen = freezeCompilerReplayConfig({ runId: `daemon-semantic-${control}`, rootPath: root,
        workspaceId, socketPath: join(root, 'unused.sock'), levels: [1], requestTimeoutMs: 30_000,
        compilerEntry: createRequire(resolveTsserverPath()).resolve('./typescript.js'),
        tsconfigPath: 'tsconfig.json', definition: { file: 'target.ts', line1: 2, character: 1 },
        references: { file: 'target.ts', line1: 2, character: 1 }, runtimeFiles: [manifest, entry],
        semanticCompletionPlugin: { name: pluginName, location, files }, evidenceRef: 'authored-daemon-semantic-fixture' });
      const semanticCompletion = replaySemanticCompletionContext({ ...frozen,
        runtimeWitness: { directory: location, runId: frozen.runId, bootstraps: {}, files } });
      expect(semanticCompletion.population[0].files).toContain(join(root, 'base.json'));
      expect(semanticCompletion.population[0].files.some(file => file.endsWith('/lib.es5.d.ts'))).toBe(true);
      if (control === 'missing-consumer') semanticCompletion.population[0].files =
        semanticCompletion.population[0].files.filter(file => file !== consumer);
      const request = { op: 'references' as const, args: { file: target, line1: 2, character: 1, rootPath: root },
        workspaceId, archive: true, semanticCompletion, deadlineAtMs: Date.now() + 30_000 };
      // Replay warms cheap queries first. That warmup must carry the plugin
      // declaration or the shared client refuses the later native reference RPC.
      const definition = await dispatchLspDaemonRequest({ ...request, op: 'symbol' },
        `production-semantic-definition-${control}`, new AbortController().signal);
      expect(definition.error, JSON.stringify(definition)).toBeNull();
      const answer = await dispatchLspDaemonRequest(request, `production-semantic-${control}`, new AbortController().signal);
      const diagnostic = JSON.stringify({ control, error: answer.error, health: answer.freshness.health,
        wire: answer.daemonEvidence?.wire });
      console.info('WI41095_PRODUCTION_SEMANTIC_DIAGNOSTIC', diagnostic);
      expect(answer.daemonEvidence?.wire.some(wire => wire.method === 'workspace/executeCommand' &&
        wire.command === SEMANTIC_COMPLETION_COMMAND &&
        wire.outcome === (control === 'complete' ? 'response' : 'error')), diagnostic).toBe(true);
      if (control === 'complete') {
        expect(answer.error, diagnostic).toBeNull(); expect(answer.freshness.health, diagnostic).toBe('healthy');
        expect(answer.sites.map(site => [site.path, site.line1]).sort()).toEqual([
          ['consumer.ts', 1], ['consumer.ts', 2], ['target.ts', 1], ['target.ts', 2],
        ]);
        const abort = new AbortController(); abort.abort();
        const cancelled = await dispatchLspDaemonRequest({ ...request, deadlineAtMs: Date.now() + 30_000 },
          'production-semantic-cancelled', abort.signal);
        expect(cancelled.error).toBeTruthy(); expect(cancelled.freshness.health).not.toBe('healthy');
      } else {
        expect(answer.error, diagnostic).toMatch(/project-or-file-population-mismatch/);
        expect(answer.freshness.health).not.toBe('healthy'); expect(answer.sites).toEqual([]);
      }
      console.info('WI41095_PRODUCTION_SEMANTIC', JSON.stringify({ control, error: answer.error,
        health: answer.freshness.health, sites: answer.sites, certification: 'authored-fixture-only' }));
    } finally {
      try {
        await shutdownAllLspClients();
        for (const taskId of storage.tasks.slice(taskStart)) await finishOwnedTask(taskId);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }, 60_000);
});
