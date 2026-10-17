/** Current-source daemon + pinned TypeScript server + migrated real PG stores; flag and DB routing are isolated. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CancellationTokenSource, createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import type { Server } from 'node:net';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const storage = vi.hoisted(() => ({ sql: undefined as postgres.Sql | undefined }));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => { if (!storage.sql) throw new Error('pinned test PG not initialized'); return { sql: storage.sql }; },
}));

vi.mock('@papercusp/flags/server', async importOriginal => {
  const original = await importOriginal<typeof import('@papercusp/flags/server')>();
  return { ...original, getFlag: async (...args: Parameters<typeof original.getFlag>) =>
    args[0] === 'papercusp-code-intel-lsp' ? true : original.getFlag(...args) };
});
vi.mock('../resource-governor/execution', async importOriginal => {
  const original = await importOriginal<typeof import('../resource-governor/execution')>();
  const { PgAdmissionCutoverQueueStore } = await import('../resource-governor/admission-cutover-store');
  const { WorkItemAdmissionQueueDriver } = await import('../resource-governor/queue');
  const { Governor } = await import('../resource-governor/admission');
  return { ...original, governedExecutionRuntime: (workspaceId: string) => {
    if (!storage.sql) throw new Error('pinned test PG not initialized');
    const driver = new WorkItemAdmissionQueueDriver(new PgAdmissionCutoverQueueStore({ workspaceId, sql: storage.sql }), { namespace: 'lsp-query' });
    return { driver, governor: new Governor(driver) };
  } };
});

import { runLspDaemonServer } from './lsp-daemon-server';
import { callLspDaemonRpc, readLspDaemonAdmission, readLspDaemonHealth } from './lsp-daemon-client';
import { LSP_DAEMON_SOCKET_ENV } from './lsp-daemon-socket';
import { lspClientInventory, resolveServerBin, resolveTsserverPath, shutdownAllLspClients,
  shutdownLspClient, typescriptInitializationOptions } from './lsp-adapter';
import { managedSpawn } from '../task-manager/managed-spawn';
import { corpusCase } from './acceptance-corpus';
import { buildLspAdmissionStatePayload } from '../agent-tools/state/lsp-admission';
import { MAX_SITES_PER_ANSWER } from './lsp-daemon-facade';
import { freezeCompilerReplayConfig, replayServerPopulation, runDaemonReplay } from './lsp-fleet-replay-runtime';
import type { ReplayReport } from './lsp-fleet-replay';
import { classifyReplayAnswer } from './lsp-fleet-replay';

const rootPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const workspaceId = `test-lsp-admission-pinned-${process.pid}`;
const previousSocket = process.env[LSP_DAEMON_SOCKET_ENV];
let server: Server | undefined;
let socketRoot: string | undefined;
let corpusRoot: string | undefined;
let db: OrgTestDb | undefined;
beforeAll(async () => {
  db = await createOrgTestDb();
  storage.sql = db.adminSql;
  expect((await db.adminSql`SELECT to_regclass('harness_shared.lsp_capabilities') AS name`)[0].name).toBeTruthy();
}, 120_000);
afterAll(async () => {
  await shutdownAllLspClients();
  if (server) await new Promise<void>(done => server!.close(() => done()));
  if (socketRoot) rmSync(socketRoot, { recursive: true, force: true });
  if (corpusRoot) rmSync(corpusRoot, { recursive: true, force: true });
  if (previousSocket === undefined) delete process.env[LSP_DAEMON_SOCKET_ENV];
  else process.env[LSP_DAEMON_SOCKET_ENV] = previousSocket;
  storage.sql = undefined;
  await db?.cleanup();
}, 30_000);

describe('daemon admission against the pinned TypeScript server', () => {
  it('measures semantic project responses without treating them as whole-reference completion', async () => {
    const bin = resolveServerBin('typescript');
    expect(bin).not.toBeNull();
    // The omitted file is a source-authored negative control: a successful
    // projectInfo response is still incomplete against the declared population.
    for (const includeConsumer of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), 'lsp-semantic-project-proof-'));
      const target = join(root, 'target.ts');
      const consumer = join(root, 'consumer.ts');
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true },
        files: includeConsumer ? ['target.ts', 'consumer.ts'] : ['target.ts'] }));
      const source = 'export function semanticTarget() { return 1; }\nsemanticTarget();\n';
      writeFileSync(target, source);
      writeFileSync(consumer, 'import { semanticTarget } from "./target";\nsemanticTarget();\n');
      let task: Awaited<ReturnType<typeof managedSpawn>> | undefined;
      let connection: ReturnType<typeof createMessageConnection> | undefined;
      try {
        task = await managedSpawn(bin!, ['--stdio'], { class: 'sidecar',
          title: 'lsp-semantic-project-proof', argv: [bin!, '--stdio'], cwd: root,
          launchedBy: 'test:lsp-semantic-project-proof', planSlug: 'lsp-fleet-scale-all-languages-2026-08-21' },
        { spawnOptions: { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] } });
        // Drain the pipe; protocol errors are retained independently below.
        task.child.stderr?.resume();
        connection = createMessageConnection(new StreamMessageReader(task.child.stdout!),
          new StreamMessageWriter(task.child.stdin!));
        connection.onRequest('window/workDoneProgress/create', () => null);
        connection.listen();
        const request = async <T,>(method: string, args: unknown, token?: CancellationTokenSource): Promise<T> => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              token ? connection!.sendRequest<T>(method, args, token.token) : connection!.sendRequest<T>(method, args),
              new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} deadline`)), 20_000); }),
            ]);
          } finally { if (timer) clearTimeout(timer); }
        };
        const rootUri = pathToFileURL(root).href;
        await request('initialize', { processId: process.pid, rootUri,
          workspaceFolders: [{ uri: rootUri, name: 'authored-project-proof' }],
          initializationOptions: typescriptInitializationOptions(resolveTsserverPath(), undefined, root),
          capabilities: { window: { workDoneProgress: true } } });
        await connection.sendNotification('initialized', {});
        await connection.sendNotification('textDocument/didOpen', { textDocument: {
          uri: pathToFileURL(target).href, languageId: 'typescript', version: 1, text: source } });
        type NativeResponse<T> = { type: string; success?: boolean; body?: T };
        type ProjectInfo = { configFileName: string; languageServiceDisabled: boolean; fileNames: string[] };
        type NativeReferences = { refs: Array<{ file: string; start: { line: number; offset: number } }> };
        const command = (name: string, args: unknown) => ({ command: 'typescript.tsserverRequest',
          arguments: [name, args, { executionTarget: 0 }] }); // Pinned ExecutionTarget.Semantic.
        const project = await request<NativeResponse<ProjectInfo>>('workspace/executeCommand',
          command('projectInfo', { file: target, needFileNameList: true }));
        expect(project).toMatchObject({ type: 'response', success: true,
          body: { configFileName: join(root, 'tsconfig.json'), languageServiceDisabled: false } });
        const declared = [target, consumer];
        const missing = declared.filter(file => !project.body!.fileNames.includes(file));
        expect(missing).toEqual(includeConsumer ? [] : [consumer]);
        const expected = includeConsumer
          ? [['consumer.ts', 1], ['consumer.ts', 2], ['target.ts', 1], ['target.ts', 2]]
          : [['target.ts', 1], ['target.ts', 2]];
        const samples: Array<Array<Array<string | number>>> = [];
        for (let index = 0; index < 3; index++) {
          const refs = await request<NativeResponse<NativeReferences>>('workspace/executeCommand',
            command('references', { file: target, line: 2, offset: 2 }));
          expect(refs).toMatchObject({ type: 'response', success: true });
          const sites = refs.body!.refs.map(ref => [ref.file.slice(root.length + 1), ref.start.line])
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
          expect(sites).toEqual(expected);
          samples.push(sites);
        }
        // The pinned custom-command route omits executeCommand's cancellation
        // token when calling executeCustom. A pre-cancelled request therefore
        // still returns a normal response here; it cannot prove uncancelled
        // traversal in a production completion mechanism.
        const cancelled = new CancellationTokenSource();
        try {
          cancelled.cancel();
          const response = await request<NativeResponse<ProjectInfo>>('workspace/executeCommand',
            command('projectInfo', { file: target, needFileNameList: true }), cancelled);
          expect(cancelled.token.isCancellationRequested).toBe(true);
          expect(response).toMatchObject({ type: 'response', success: true });
        } finally { cancelled.dispose(); }
        console.info('WI41095_SEMANTIC_PROJECT_RESPONSES', JSON.stringify({ includeConsumer,
          missing: missing.map(file => file.slice(root.length + 1)), samples,
          customCommandCancellation: 'pre-cancelled-request-returned-success',
          certification: 'unproven-outside-authored-project' }));
      } finally {
        try {
          if (task && connection) await shutdownLspClient({ connection, child: task.child,
            taskId: task.taskId, scopeUnit: task.scopeUnit });
        } finally { rmSync(root, { recursive: true, force: true }); }
      }
    }
  }, 120_000);

  it('preserves the readiness refusal for a source-complete stable warm reference answer', async () => {
    expect(resolveServerBin('typescript')).not.toBeNull();
    socketRoot = mkdtempSync(join(tmpdir(), 'lsp-stable-readiness-socket-'));
    corpusRoot = mkdtempSync(join(tmpdir(), 'lsp-stable-readiness-corpus-'));
    const file = join(corpusRoot, 'target.ts');
    writeFileSync(join(corpusRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true }, files: ['target.ts', 'consumer.ts'],
    }));
    writeFileSync(file, 'export function stableTarget() { return 1; }\nstableTarget();\n');
    writeFileSync(join(corpusRoot, 'consumer.ts'),
      'import { stableTarget } from "./target";\nstableTarget();\n');
    const args = { file, rootPath: corpusRoot, line1: 2, character: 1 };
    const socket = join(socketRoot, 'daemon.sock');
    process.env[LSP_DAEMON_SOCKET_ENV] = socket;
    server = runLspDaemonServer();
    await once(server, 'listening');
    try {
      const warm = await callLspDaemonRpc(socket, { workspaceId, op: 'symbol', args, archive: true },
        90_000, 'pinned/stable-readiness/warm');
      expect(warm.error, JSON.stringify(warm)).toBeNull();
      expect(warm.freshness.health).toBe('healthy');
      expect(warm.sites.map(site => [site.path, site.line1])).toEqual([['target.ts', 1]]);
      const expected = [['consumer.ts', 1], ['consumer.ts', 2], ['target.ts', 1], ['target.ts', 2]];
      const samples: Array<{
        sites: Array<Array<string | number | null>>;
        health: string;
        progressGeneration: number;
        certifiedReadiness: string[];
        unprovenReadiness: string[];
      }> = [];
      for (let index = 0; index < 3; index++) {
        const answer = await callLspDaemonRpc(socket, { workspaceId, op: 'references', args, archive: true },
          90_000, `pinned/stable-readiness/${index}`);
        expect(answer.error, JSON.stringify(answer)).toBeNull();
        const sites = answer.sites.map(site => [site.path, site.line1])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        // Ground truth comes from the fixture's authored sites, never a warm answer.
        expect(sites).toEqual(expected);
        const client = lspClientInventory().find(client => client.rootPath === corpusRoot)!;
        expect(client).toBeDefined();
        samples.push({ sites, health: answer.freshness.health,
          progressGeneration: client.progressGeneration, certifiedReadiness: client.certifiedReadiness,
          unprovenReadiness: client.unprovenReadiness });
        expect(answer.freshness.health).toBe('degraded');
        expect(client.certifiedReadiness).not.toContain('references');
        expect(client.unprovenReadiness).toContain('references');
      }
      console.info('WI41095_STABLE_REFERENCE_READINESS', JSON.stringify(samples));
      // This reproduces an availability failure, not a completeness waiver.
      // An unchanged answer and a completed project-load cycle cannot satisfy
      // the current canary's required answer transition after its first sample.
      expect(samples.every(sample => sample.progressGeneration === samples[0].progressGeneration)).toBe(true);
    } finally {
      await shutdownAllLspClients();
      await new Promise<void>(done => server!.close(() => done()));
      server = undefined;
      rmSync(socketRoot, { recursive: true, force: true });
      rmSync(corpusRoot, { recursive: true, force: true });
      socketRoot = undefined;
      corpusRoot = undefined;
    }
  }, 120_000);

  it('answers tracked cross-package ground truth through learned cost lanes and live RPC readback', async () => {
    // Absence fails this acceptance check; a skip is not proof of a working backend.
    expect(resolveServerBin('typescript'), 'provision the maintained pinned TypeScript server').not.toBeNull();
    const file = join(rootPath, 'libs/generic/search/src/leg-health.ts');
    const lines = readFileSync(file, 'utf8').split('\n');
    const line0 = lines.findIndex(line => line.includes('import { pinModuleState'));
    expect(line0).toBeGreaterThanOrEqual(0);
    const args = { file, rootPath, line1: line0 + 1, character: lines[line0].indexOf('pinModuleState') };
    const expected = corpusCase('definition-cross-package-bare-specifier')!.expectedSites[0];
    socketRoot = mkdtempSync(join(tmpdir(), 'lsp-pinned-admission-'));
    const socket = join(socketRoot, 'daemon.sock');
    process.env[LSP_DAEMON_SOCKET_ENV] = socket;
    server = runLspDaemonServer();
    await once(server, 'listening');
    const query = (actorId: string) => callLspDaemonRpc(socket, { workspaceId, op: 'symbol', args, actorId, archive: true,
      deadlineAtMs: Date.now() + 90_000 }, 90_000, `pinned/${actorId}`);
    const warm = await query('warmup');
    expect(warm.error).toBeNull();
    expect(warm.freshness.health).toBe('healthy');
    expect(warm.sites).toContainEqual(expect.objectContaining({ path: expected.path, line1: expected.line1 }));
    const answers = await Promise.all(Array.from({ length: 8 }, (_, index) => query(`agent-${index}`)));
    for (const answer of answers) {
      expect(answer.error).toBeNull();
      expect(answer.freshness.health).toBe('healthy');
      expect(answer.sites).toContainEqual(expect.objectContaining({ path: expected.path, line1: expected.line1 }));
    }
    await vi.waitFor(async () => {
      expect(await readLspDaemonAdmission(workspaceId)).toMatchObject({ assessment: 'idle', queued: 0, inFlight: 0,
        settlementFailures: [], costObservations: 1 });
    });
    expect(await buildLspAdmissionStatePayload(workspaceId)).toMatchObject({ measurement: 'measured', assessment: 'idle', unknown: [] });
    const inventory = lspClientInventory().filter(client => client.language === 'typescript');
    expect(inventory).toHaveLength(1);
    expect(inventory[0].taskId).toBeTruthy();
    expect(inventory[0].health).toBe('healthy');
    const population = replayServerPopulation(inventory[0].pid!, inventory[0].taskId!);
    expect(population.unknown, JSON.stringify(population)).toEqual([]);
    expect(population.processes.map(process => process.pid)).toContain(inventory[0].pid);
    expect(population.processes.some(process => process.cmdline.some(arg => /(?:^|\/)tsserver\.js$/.test(arg))),
      JSON.stringify(population)).toBe(true);
    for (const process of population.processes) {
      expect(process.identity).toMatch(/^linux:[^:]+:\d+$/);
      expect(process.executable?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(process.loadedModules).toBe('unmeasured');
    }
    const owningHealth = await readLspDaemonHealth(workspaceId);
    expect(owningHealth).toMatchObject({ pid: process.pid, sampledAtMs: expect.any(Number),
      servers: [{ taskId: inventory[0].taskId, pid: inventory[0].pid, certifiedReadiness: expect.any(Array),
        unprovenReadiness: expect.any(Array), progressGeneration: expect.any(Number) }] });
    for (const [index, answer] of answers.entries()) {
      expect(answer.daemonEvidence!.requestId).toBe(`pinned/agent-${index}`);
      const wire = answer.daemonEvidence!.wire.filter(row => row.method === 'textDocument/definition');
      expect(wire).toHaveLength(1);
      expect(wire[0]).toMatchObject({ taskId: inventory[0].taskId, pid: inventory[0].pid, outcome: 'response' });
      expect(wire[0].endedAtMs!).toBeGreaterThanOrEqual(wire[0].startedAtMs);
    }
    const receipts = answers.flatMap(answer => answer.daemonEvidence!.events.filter(event => event.phase === 'durable-settled'));
    expect(receipts.length).toBeGreaterThan(0);
    for (const receipt of receipts) {
      expect(receipt.confirmed).toBe(true);
      const rows = await db!.adminSql`SELECT state FROM harness_shared.resource_governor_admissions
        WHERE workspace_id = ${workspaceId} AND receipt_id = ${receipt.receiptId!}`;
      expect(rows).toEqual([{ state: 'completed' }]);
    }
    // This is a protocol/full-set precondition, not the repository-hot-class BAR.
    // A source-authored oracle cannot inherit missing sites from a warmup answer.
    corpusRoot = mkdtempSync(join(tmpdir(), 'lsp-archive-corpus-'));
    const corpusFile = join(corpusRoot, 'hot.ts');
    const callCount = MAX_SITES_PER_ANSWER + 20;
    writeFileSync(join(corpusRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, files: ['hot.ts'] }));
    writeFileSync(corpusFile, ['export function archiveHot() { return 1; }',
      ...Array.from({ length: callCount }, () => 'archiveHot();'), ''].join('\n'));
    const hotArgs = { file: corpusFile, line1: 2, character: 1, rootPath: corpusRoot };
    const preflight = await callLspDaemonRpc(socket, { workspaceId, op: 'symbol', args: hotArgs, archive: true }, 90_000, 'pinned/corpus/preflight');
    expect(preflight.error, JSON.stringify(preflight)).toBeNull();
    expect(preflight.sites.map(site => ({ path: site.path, line1: site.line1 }))).toEqual([{ path: 'hot.ts', line1: 1 }]);
    const request = { workspaceId, op: 'references' as const, args: hotArgs, deadlineAtMs: Date.now() + 90_000 };
    const full = await callLspDaemonRpc(socket, { ...request, archive: true }, 90_000, 'pinned/hot/archive');
    expect(full.error, JSON.stringify(full)).toBeNull();
    expect(full.sites.length).toBeGreaterThan(MAX_SITES_PER_ANSWER);
    expect(full.sites.map(site => ({ path: site.path, line1: site.line1 })).sort((a, b) => (a.line1 ?? 0) - (b.line1 ?? 0)))
      .toEqual(Array.from({ length: callCount + 1 }, (_, line) => ({ path: 'hot.ts', line1: line + 1 })));
    expect(full.truncation.truncated).toBe(false);
    const bounded = await callLspDaemonRpc(socket, { ...request, args: { ...hotArgs, limit: Number.MAX_SAFE_INTEGER } }, 90_000);
    expect(bounded.daemonEvidence).toBeUndefined();
    expect(bounded.sites).toHaveLength(MAX_SITES_PER_ANSWER);
    expect(bounded.truncation).toMatchObject({ truncated: true, totalAvailable: full.sites.length });
    expect(lspClientInventory().filter(client => client.language === 'typescript' && client.rootPath === rootPath)).toHaveLength(1);
    expect(lspClientInventory().filter(client => client.language === 'typescript' && client.rootPath === corpusRoot)).toHaveLength(1);
    // Exercise the maintained runner through the real socket and migrated PG,
    // without confusing this small corpus/control with the full1000 repository BAR.
    const replayConfig = freezeCompilerReplayConfig({ runId: 'protocol-runner', rootPath: corpusRoot,
      socketPath: socket, workspaceId, levels: [3], requestTimeoutMs: 90_000, tsconfigPath: 'tsconfig.json',
      definition: hotArgs, references: hotArgs, runtimeFiles: [], evidenceRef: 'source-authored145-call-protocol-fixture' });
    const replay = await runDaemonReplay(replayConfig, join(corpusRoot, 'archives'));
    expect(replay.result.unknown).toContain('missing-1000-level');
    const runs = readFileSync(join(replay.directory, 'runs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as ReplayReport);
    expect(runs).toHaveLength(9);
    expect(runs.reduce((count, report) => count + report.population.length, 0)).toBe(54);
    for (const report of runs) {
      expect(report.complete, JSON.stringify(report.accountingErrors)).toBe(true);
      for (const sample of report.samples) {
        expect(sample.clientSettledAtMs!).toBeGreaterThanOrEqual(sample.settledAtMs);
        const evidence = (sample.answer as typeof full).daemonEvidence!;
        expect(evidence.requestId).toBe(sample.request.id);
        // Exact source correctness and backend certification are separate facts.
        // Stable correct references can remain degraded under the current canary
        // strategy; preserve that failed BAR instead of forcing readiness green.
        const expected = replayConfig.corpus[sample.request.queryClass].oracle;
        expect(sample.answer!.error).toBeNull();
        const keys = (sites: typeof expected.sites) => sites.map(site => JSON.stringify([site.path, site.line1])).sort();
        expect(keys(sample.answer!.sites)).toEqual(keys(expected.sites));
        const classification = classifyReplayAnswer(sample.answer, expected);
        expect(report.failures.some(failure => failure.id === sample.request.id)).toBe(!classification.usefulCorrect);
        for (const terminal of evidence.events.filter(event => event.phase === 'durable-settled')) {
          expect(terminal.confirmed).toBe(true);
          expect(await db!.adminSql`SELECT state FROM harness_shared.resource_governor_admissions
            WHERE workspace_id = ${workspaceId} AND receipt_id = ${terminal.receiptId!}`).toEqual([{ state: 'completed' }]);
        }
      }
      for (const queryClass of ['definition', 'hot-references'] as const) {
        const useful = report.samples.filter(sample => sample.request.queryClass === queryClass &&
          classifyReplayAnswer(sample.answer, replayConfig.corpus[queryClass].oracle).usefulCorrect).length;
        expect(report.classes[queryClass].usefulCorrect).toBe(useful);
      }
    }
  }, 120_000);
});
