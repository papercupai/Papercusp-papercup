/** P026: saved repository questions and separately labelled authored controls
 * through exposed native handlers. Coverage refusals and missing cost witnesses
 * remain explicit; passing an honesty guard never certifies backend acceptance.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const storage = vi.hoisted(() => ({ sql: undefined as postgres.Sql | undefined, tasks: [] as string[] }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => {
    if (!storage.sql) throw new Error('native language acceptance database is not initialized');
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
    const [row] = await storage.sql!`SELECT workspace_id FROM harness_shared.task_ledger WHERE task_id = ${result.taskId}`;
    expect(row).toMatchObject({ workspace_id: workspaceId });
    return result;
  } };
});
import graphQuery from '../agent-tools/gitnexus/query';
import lspQuery from '../agent-tools/lsp/query';
import { killScopeUnit, killTask } from '../task-manager/control';
import { closeTask } from '../task-manager/store';
import { taskTerminalEventKey } from '../task-manager/task-terminal-events';
import type { CodeIntelAnswer } from './contracts';
import { nativeLanguageControls } from './fair-comparison-corpus';
import { materializeFrozenRepositoryTask, measureFairToolPayload, prepareFrozenControl, validateFrozenInputs, verifyFrozenSource,
  type FrozenFairInputs } from './fair-comparison-cli';
import { shutdownAllLspClients } from './lsp-adapter';
import { LSP_DAEMON_SOCKET_ENV } from './lsp-daemon-socket';
import { runLspDaemonServer } from './lsp-daemon-server';

// Reuse the pinned LSP fixtures' real dispatcher, private persistence and
// terminal-latch cleanup. An exposed-tool test must never borrow a live daemon.
const eventEngine = await import('../events/await/engine');
const workspaceId = `test-native-language-acceptance-${process.pid}`;
const previousSocket = process.env[LSP_DAEMON_SOCKET_ENV];
let socketRoot: string | undefined;
let server: Server | undefined;
let db: OrgTestDb | undefined;
let previousAutoPump: boolean | undefined;
beforeAll(async () => {
  db = await createOrgTestDb();
  storage.sql = db.adminSql;
  previousAutoPump = eventEngine.setAutoPumpEnabledForTests(false);
  socketRoot = mkdtempSync(join(tmpdir(), 'native-language-daemon-'));
  process.env[LSP_DAEMON_SOCKET_ENV] = join(socketRoot, 'fixture.sock');
  server = runLspDaemonServer();
  await once(server, 'listening');
}, 120_000);
afterAll(async () => {
  const errors: unknown[] = [];
  try {
    try { await shutdownAllLspClients(); } catch (error) { errors.push(error); }
    try {
      if (server) await new Promise<void>(done => server!.close(() => done()));
    } catch (error) { errors.push(error); }
    for (const taskId of storage.tasks.splice(0)) {
      try {
      const outcome = await killTask(taskId, { includeSubtree: true, reapTerminalResidue: true, escalateAfterMs: 500 });
      if (!outcome.ok && outcome.error === 'not_live') {
        // A terminal row may still have residue. Verify this exact owned scope,
        // as the maintained multilingual fixture does, before accepting teardown.
        const [row] = await storage.sql!`SELECT workspace_id, scope_unit FROM harness_shared.task_ledger WHERE task_id = ${taskId}`;
        expect(row?.workspace_id).toBe(workspaceId);
        if (!row?.scope_unit) throw new Error('LSP fixture cannot verify an unconfined terminal task');
        const scope = await killScopeUnit(row.scope_unit, { escalateAfterMs: 500 });
        if (!scope.ok && scope.error !== 'already_gone') throw new Error(`LSP fixture scope cleanup refused: ${scope.error}`);
      } else if (!outcome.ok && outcome.error !== 'already_gone') {
        throw new Error(`LSP fixture cleanup refused: ${outcome.error}`);
      } else if (!outcome.ok) {
        await closeTask(taskId, { state: 'stranded', exitReason: 'fixture verified process gone at teardown' });
      }
      // Suite hooks have no active test for expect.poll; use the maintained hook-safe wait.
      await vi.waitFor(async () => {
        const [row] = await storage.sql!`
          SELECT task.workspace_id, task.state, task.ended_at IS NOT NULL AS ended,
                 fire.last_payload->>'taskId' AS emitted_task,
                 fire.last_payload->>'state' = task.state AS matching_state
            FROM harness_shared.task_ledger task
            LEFT JOIN harness_shared.event_key_fires fire ON fire.event_key = ${taskTerminalEventKey(taskId)}
           WHERE task.task_id = ${taskId}`;
        expect(row).toMatchObject({ workspace_id: workspaceId, ended: true, emitted_task: taskId, matching_state: true });
      }, { timeout: 5_000, interval: 20 });
      } catch (error) { errors.push(error); }
    }
  } finally {
    if (previousAutoPump !== undefined) eventEngine.setAutoPumpEnabledForTests(previousAutoPump);
    if (previousSocket === undefined) delete process.env[LSP_DAEMON_SOCKET_ENV];
    else process.env[LSP_DAEMON_SOCKET_ENV] = previousSocket;
    if (socketRoot) rmSync(socketRoot, { recursive: true, force: true });
    await db?.cleanup();
    storage.sql = undefined;
  }
  if (errors.length) throw new AggregateError(errors, 'LSP fixture task cleanup failed');
}, 60_000);

const controls = nativeLanguageControls();
const operations = { callers: 'callers', callees: 'callees', definition: 'symbol', impact: 'impact' } as const;
const cases = controls.cases.filter(kase => kase.intent in operations);
const keys = new Map(controls.keys.map(key => [key.caseId, key]));

const frozen = validateFrozenInputs(JSON.parse(readFileSync(new URL(
  '../../../../docs/evidence/native-code-intelligence-preregistration-2026-10-09.json',
  import.meta.url), 'utf8')) as FrozenFairInputs);
const repositoryTasks = frozen.cases.filter(kase => kase.source === 'repository-task');
const repositoryKeys = new Map(frozen.keys.map(key => [key.caseId, key]));
const donor = join(process.env.P017_BENCH ?? join(homedir(), '.papercusp/bench/fair-comparison-2026-10'),
  `snapshot-${frozen.preregistration.protocol!.sourceCommit.slice(0, 12)}`);

describe('native P026 frozen repository-task replay', () => {
  beforeAll(async () => { await verifyFrozenSource(donor, frozen); });

  it.each(repositoryTasks)('$id', async kase => {
    const root = mkdtempSync(join(tmpdir(), 'native-repository-task-'));
    const path = kase.anchorFile!, source = readFileSync(join(donor, path), 'utf8');
    const expectedSites = repositoryKeys.get(kase.id)!.sites;
    const started = performance.now();
    try {
      const sourceWitness = await materializeFrozenRepositoryTask(root, kase, frozen, source);
      let tool: string, request: unknown, response: unknown, sites: string[], coverage: string;
      if (kase.intent === 'text-search') {
        tool = 'native-command:rg';
        const argv = ['--with-filename', '-n', '-F', '--', kase.subject, path];
        request = { command: 'rg', argv, cwd: root };
        const result = spawnSync('rg', argv, { cwd: root, encoding: 'utf8' });
        response = { stdout: result.stdout, stderr: result.stderr, exitCode: result.status,
          error: result.error?.message ?? null };
        sites = result.stdout.split('\n').filter(Boolean).map(line => {
          const match = /^(.*?):(\d+):/.exec(line);
          expect(match, line).not.toBeNull();
          return `${match![1]}:${match![2]}`;
        }).sort();
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(sites).toEqual([...expectedSites].sort());
        coverage = 'answered';
      } else {
        tool = 'graph:query';
        const args = graphQuery.args.parse({ op: 'symbol', name: kase.subject,
          paths: [path], file_path: path });
        request = args;
        const answer = (await graphQuery.handler(args, { projectDir: root } as never) as { data: CodeIntelAnswer }).data;
        response = answer;
        sites = answer.sites.map(site => `${site.path}:${site.line1}`).sort();
        if (kase.language === 'javascript') {
          expect(answer.error, JSON.stringify(answer)).toBeNull();
          expect(sites).toEqual([...expectedSites].sort());
          expect(answer.evidence?.sourceScope.supportingFiles).toContainEqual(
            expect.objectContaining({ path, contentHash: sourceWitness.contentHash }));
          coverage = 'answered';
        } else {
          // Native graph admission currently covers JS/TS. This records a real
          // request and its refusal, not successful Rust/Python task accuracy.
          expect(answer.error).toMatch(/unsupported/i);
          expect(answer.freshness.health).not.toBe('healthy');
          expect(sites).toEqual([]);
          coverage = 'unsupported';
        }
      }
      const wallMs = performance.now() - started;
      const tokenWitness = await measureFairToolPayload(request, response);
      console.log('NATIVE_REPOSITORY_TASK=' + JSON.stringify({ caseId: kase.id,
        question: kase, preregHash: frozen.preregistration.hash, sourceWitness,
        tool, request, response, sites, expectedSites, coverage,
        wallMs, rawResponseBytes: Buffer.byteLength(JSON.stringify(response)),
        // This suite is a shared process and this replay materializes the pinned
        // file only. Never infer frozen project configuration or fresh-task costs.
        configurationWitness: { status: 'not-measured', reason: 'pinned-project-configuration-not-materialized' },
        resultTokens: tokenWitness.responseTokens, tokenWitness,
        processCosts: { status: 'not-measured', reason: 'shared-test-process-not-fresh-task' },
        authoredControlOnly: false, backendVerdict: 'unqualified' }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});

describe('native P026 frozen configuration invalidation', () => {
  it('refuses a removed project config after a keyed answer, then recovers on the original bytes', async () => {
    const configured = frozen.cases.find(kase => kase.id === 'native-typescript-symbol-search-positive-configured-current')!;
    const unconfigured = frozen.cases.find(kase => kase.id === 'native-typescript-callers-positive-unconfigured-current')!;
    const expected = repositoryKeys.get(configured.id)!.sites;
    const root = mkdtempSync(join(tmpdir(), 'native-frozen-config-'));
    const path = configured.anchorFile!;
    const request = lspQuery.args.parse({ op: 'workspace_symbols', rootPath: root,
      file: path, language: 'typescript', name: configured.subject, limit: 20 });
    const query = async () => (await lspQuery.handler(request,
      { projectDir: root, workspaceId } as never) as { data: CodeIntelAnswer }).data;
    const sites = (answer: CodeIntelAnswer) => answer.sites.map(site => `${site.path}:${site.line1}`).sort();
    try {
      const original = await prepareFrozenControl(root, configured, frozen);
      const before = await query();
      expect(before.error, JSON.stringify(before)).toBeNull();
      expect(sites(before)).toEqual([...expected].sort());
      const removed = await prepareFrozenControl(root, unconfigured, frozen);
      expect(removed?.currentSourceHash).toBe(original?.currentSourceHash);
      expect(removed?.configurationFiles.map(file => file.hash)).toEqual([null]);
      const refusal = await query();
      expect(refusal.error).toMatch(/no tsconfig.json or jsconfig.json/);
      expect(refusal.freshness.health).not.toBe('healthy');
      expect(sites(refusal)).toEqual([]);
      const restored = await prepareFrozenControl(root, configured, frozen);
      expect(restored).toEqual(original);
      const after = await query();
      expect(after.error, JSON.stringify(after)).toBeNull();
      expect(sites(after)).toEqual([...expected].sort());
      console.log('NATIVE_CONFIGURATION_INVALIDATION=' + JSON.stringify({
        preregHash: frozen.preregistration.hash, caseIds: [configured.id, unconfigured.id],
        tool: 'lsp:query', request, original, removed, restored, before, refusal, after,
        tokenWitnesses: await Promise.all([before, refusal, after].map(answer => measureFairToolPayload(request, answer))),
        authoredControlOnly: true, scope: 'typescript-workspace-symbols-config-admission',
        processCosts: { status: 'not-measured', reason: 'shared-test-process-not-fresh-task' },
        backendVerdict: 'unqualified' }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);
});

describe('native P026 multilingual authored graph acceptance', () => {
  it.each(cases)('$id', async kase => {
    const root = mkdtempSync(join(tmpdir(), 'native-language-acceptance-'));
    const path = kase.anchorFile!;
    const source = controls.files[path]!;
    const configured = kase.configuration === 'configured';
    try {
      for (const [file, text] of Object.entries(controls.files)) {
        if (dirname(file) !== dirname(path) || (!configured && file !== path)) continue;
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), text);
      }
      if (kase.sourceState === 'stale') writeFileSync(join(root, path),
        source.replace('return target()', 'return 0').replace('{ target() }', '{ 0 }'));
      if (kase.sourceState === 'deleted') rmSync(join(root, path));
      const op = operations[kase.intent as keyof typeof operations];
      const answer = (await graphQuery.handler(graphQuery.args.parse({
        op, name: kase.subject, paths: [path],
        ...(op === 'callers' ? {} : { file_path: path }),
        ...(op === 'impact' ? { max_depth: kase.depth } : {}),
      }), { projectDir: root } as never) as { data: CodeIntelAnswer }).data;
      const unsupported = !['javascript', 'typescript'].includes(kase.language!);
      // The tool emits call sites for callees; the preregistered answer unit is
      // its measured callee declaration. Retain raw sites as well as scored units.
      const sites = (op === 'callees' ? answer.evidence?.relationships.map(edge => edge.target?.site)
        .filter((site): site is NonNullable<typeof site> => Boolean(site)) ?? [] : answer.sites)
        .map(site => `${site.path}:${site.line1}`).sort();
      console.log('NATIVE_LANGUAGE_ACCEPTANCE=' + JSON.stringify({ caseId: kase.id,
        source: kase.source, language: kase.language, configuration: kase.configuration,
        sourceState: kase.sourceState, fixtureHash: kase.sourceFingerprint,
        currentSourceHash: kase.sourceState === 'deleted' ? null : createHash('sha256').update(
          kase.sourceState === 'stale' ? source.replace('return target()', 'return 0').replace('{ target() }', '{ 0 }') : source).digest('hex'),
        tool: 'graph:query', op, sites, rawSites: answer.sites, expectedSites: keys.get(kase.id)!.sites,
        error: answer.error, latencyMs: answer.latencyMs,
        evidence: answer.evidence, authoredControlOnly: true }));
      if (unsupported) {
        expect(answer.error, kase.id).toMatch(/unsupported/i);
        expect(sites).toEqual([]);
        expect(answer.freshness.health).not.toBe('healthy');
        expect(answer.evidence?.languageCapabilities).toContainEqual(expect.objectContaining({
          language: kase.language, status: 'unsupported' }));
      } else if (kase.sourceState === 'deleted' || (kase.tags.includes('absence') && op !== 'callers')) {
        // No declaration or a missing file is an explicit unavailable answer;
        // preserve it instead of scoring it as certified semantic absence.
        expect(answer.error, kase.id).not.toBeNull();
        expect(sites).toEqual([]);
      } else {
        expect(answer.error, kase.id).toBeNull();
        expect(sites).toEqual([...keys.get(kase.id)!.sites].sort());
        expect(answer.evidence?.sourceScope.repositoryId).toBeTruthy();
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});

describe('native P026 remaining authored language acceptance', () => {
  it.each(controls.cases.filter(kase => !(kase.intent in operations)))('$id', async kase => {
    const root = mkdtempSync(join(tmpdir(), 'native-language-acceptance-'));
    const path = kase.anchorFile!, source = controls.files[path]!;
    const absent = kase.tags.includes('absence');
    try {
      for (const [file, text] of Object.entries(controls.files)) {
        if (dirname(file) !== dirname(path)) continue;
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), text);
      }
      if (kase.intent === 'text-search') {
        // Text search is the documented native command route. It is lexical
        // evidence; it cannot certify a compiler or language-server intent.
        const started = performance.now();
        const command = ['--with-filename', '-n', '-F', '--', kase.subject, path];
        const result = spawnSync('rg', command,
          { cwd: root, encoding: 'utf8' });
        const sites = result.stdout.split('\n').filter(Boolean).map(line => {
          const match = /^(.*?):(\d+):/.exec(line);
          expect(match, line).not.toBeNull();
          return `${match![1]}:${match![2]}`;
        }).sort();
        console.log('NATIVE_LANGUAGE_ACCEPTANCE=' + JSON.stringify({ caseId: kase.id,
          source: kase.source, language: kase.language, configuration: kase.configuration,
          sourceState: kase.sourceState, fixtureHash: kase.sourceFingerprint,
          currentSourceHash: createHash('sha256').update(source).digest('hex'),
          tool: 'native-command:rg', intent: kase.intent, command: ['rg', ...command],
          sites, expectedSites: keys.get(kase.id)!.sites, error: result.error?.message ?? null,
          exitCode: result.status, latencyMs: performance.now() - started,
          stdout: result.stdout, stderr: result.stderr, authoredControlOnly: true }));
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(absent ? 1 : 0);
        expect(sites).toEqual([...keys.get(kase.id)!.sites].sort());
        return;
      }
      const language = kase.language === 'javascript' ? 'typescript' : kase.language;
      const symbols = (await lspQuery.handler(lspQuery.args.parse({ op: 'workspace_symbols',
        rootPath: root, file: path, language, name: kase.subject, limit: 20 }),
      { projectDir: root, workspaceId } as never) as { data: CodeIntelAnswer }).data;
      let answer = symbols;
      if (kase.intent === 'references' && !symbols.error && symbols.sites.length) {
        const cursor = symbols.sites.find(site => site.path === path)!;
        expect(cursor, JSON.stringify(symbols)).toBeDefined();
        const line = source.split('\n')[cursor.line1! - 1]!;
        answer = (await lspQuery.handler(lspQuery.args.parse({ op: 'references', rootPath: root,
          file: path, line1: cursor.line1, character: line.indexOf(kase.subject), limit: 20 }),
        { projectDir: root, workspaceId } as never) as { data: CodeIntelAnswer }).data;
      }
      const neutral = new Set(keys.get(kase.id)!.neutral);
      const sites = answer.sites.map(site => `${site.path}:${site.line1}`)
        .filter(site => !neutral.has(site)).sort();
      console.log('NATIVE_LANGUAGE_ACCEPTANCE=' + JSON.stringify({ caseId: kase.id,
        source: kase.source, language: kase.language, configuration: kase.configuration,
        sourceState: kase.sourceState, fixtureHash: kase.sourceFingerprint,
        currentSourceHash: createHash('sha256').update(source).digest('hex'),
        tool: 'lsp:query', intent: kase.intent, symbols, answer, sites,
        expectedSites: keys.get(kase.id)!.sites, authoredControlOnly: true }));
      if (answer.error) {
        // Preserve unsupported/unavailable as a coverage gap. A truthful
        // refusal passes this honesty guard, never the task-accuracy bar.
        expect(answer.error.length).toBeGreaterThan(0);
        expect(answer.freshness.health).not.toBe('healthy');
        expect(sites).toEqual([]);
      } else {
        // Captured server input hashes establish this fixture's exact version;
        // Backend readiness and disk freshness are separate contract fields;
        // an unknown disk-freshness value remains unknown even for a ready server.
        expect(answer.freshness.staleVsDisk).not.toBe(true);
        expect(answer.evidence?.sourceScope.supportingFiles).toContainEqual(expect.objectContaining({
          path, contentHash: createHash('sha256').update(source).digest('hex'),
        }));
        expect(sites).toEqual([...keys.get(kase.id)!.sites].sort());
      }
    } finally {
      await shutdownAllLspClients();
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
