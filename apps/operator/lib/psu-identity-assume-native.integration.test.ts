// @vitest-environment node
/** Installed Codex, native transcripts, managed PTYs and context bootstrap are
 * real. The provider, inspection service and resume callback are local fixtures;
 * this does not certify the production operator, custody store or work router. */
import { expect, it, vi, type TestContext } from 'vitest';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { execFileSync, fork, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import net from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { hostThroughPty, metaPathFor, handoffPathFor, readHostHandoffForParentPid, eventLogPathForOwner,
  resolveLinuxCodexStartupPid, readLinuxStartupCounters, readCodexTuiLogTail,
  controlWritesForAgent } from '../scripts/psu-pty-host.mjs';
import { mintCarryRespawnArgs, codexThreadWriterHolder, codexThreadWriterLockPath,
  codexNativeIdForPty } from '../scripts/psu-launcher.mjs';
import { launchIdentityAssumeHandoff, makeIdentityAssumeHostPort,
  prepareIdentityAssumeCheckpoint } from '../scripts/psu-identity-assume.mjs';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from
  '../../../packages/operator-core/lib/inference-gateway/codex-cli-bridge';
import { readProcessIdentity } from '../../../packages/operator-core/lib/process-identity';
import type { AssumeExecutionObservation, AssumeTransitionReceipt } from '../../../packages/operator-core/lib/session-assume';
import { readAssumeTranscriptPin } from '../../../packages/operator-core/lib/session-assume-preparation';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof } from '../../../packages/operator-core/test/isolated-integration-proof';

// Private runtime, router collection and Vitest setup precede the native case.
// Keep their bounded startup clock separate from actual native execution.
const nativeRuntimeOptions = { ...isolatedWorkerOptions(180_000), testFileExecutionFromStdout: 'case' as const };

/** The parent observes the original private runtime before the native case runs
 * and retains its teardown. The child executes the same maintained case once. */
async function nativeRuntimeJourney(context: TestContext, ...args: Parameters<typeof nativeJourney>) {
  return nativeRuntimeCase(context, () => nativeJourney(...args));
}

async function nativeRuntimeCase(context: TestContext, execute: () => unknown | Promise<unknown>) {
  if (process.env.PC_ASSUME_NATIVE_RUNTIME_CHILD === '1') return execute();
  const root = resolve(import.meta.dirname, '../../..');
  const filePath = 'apps/operator/lib/psu-identity-assume-native.integration.test.ts';
  const pattern = '^' + context.task.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
  const runId = await recordIsolatedIntegrationProof({ root, filePath,
    sourcePaths: ['apps/operator/scripts/psu-identity-assume.mjs', 'apps/operator/scripts/psu-launcher.mjs',
      'apps/operator/scripts/psu-pty-host.mjs', 'apps/operator/vitest-shims/identity-assume-production.ts',
      'apps/operator/vitest-shims/psu-pty-temp-dir.ts', 'apps/operator/vitest-shims/scoped-native-fixture-cleanup.ts',
      'packages/operator-core/lib/session-assume.ts', 'packages/operator-core/lib/session-assume-caller.ts',
      'packages/operator-core/lib/session-assume-custody.ts', 'packages/operator-core/lib/session-assume-store.ts',
      'packages/operator-core/lib/session-assume-preparation.ts', 'packages/operator-core/lib/adv-sessions.ts',
      'packages/operator-core/lib/inference-gateway/codex-cli-bridge.ts', 'scripts/with-test-pg.mjs'],
    execute: async (observe, evidenceDir) => {
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', PC_ASSUME_NATIVE_RUNTIME_CHILD: '1' };
      // Only the parent reporter owns its source map and durable receipt file.
      for (const key of ['PC_EXECUTED_SOURCE_MAP_OUT', 'PC_EXECUTED_SOURCE_MAP_RESULT',
        'PC_EXECUTED_SOURCE_MAP_WORKSPACE', 'PAPERCUSP_TEST_RUN_RECEIPT_FILE']) delete env[key];
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime', '--', process.execPath,
        '--import', './scripts/lib/committed-source-loader.mjs', 'scripts/test-files.mjs', filePath,
        '--testNamePattern=' + pattern], { cwd: root, detached: true, execArgv: [], env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      const result = await captureIsolatedWorker(child, evidenceDir, nativeRuntimeOptions);
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      expect(result.output).toMatch(/TEST_FILE_RESULT requested=1 executed=1 matched=1 .*status=passed/);
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}

type Row = Record<string, any>;
const productionState = vi.hoisted(() => ({ sql: undefined as any, homes: new Map<string, string>() }));
const previewDatabase = new AsyncLocalStorage<any>();
vi.mock('@papercusp/db-org', async original => {
  const actual = await original<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => previewDatabase.getStore()
    ? { sql: previewDatabase.getStore() }
    : productionState.sql ? { sql: productionState.sql } : actual.getOrgPg() };
});
vi.mock('@papercusp/orchestrator/session-launch-dirs', async original => {
  const actual = await original<typeof import('@papercusp/orchestrator/session-launch-dirs')>();
  return { ...actual, codexHomeForSessionKey: (key: string | number) =>
    productionState.homes.get(String(key)) ?? actual.codexHomeForSessionKey(key) };
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : null; }
};
async function control(sock: string, message: unknown): Promise<Row> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sock); let bytes = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Native handoff control timed out')));
    socket.once('error', reject); socket.on('data', data => { bytes += data; });
    socket.once('end', () => { try { resolve(JSON.parse(bytes)); } catch (error) { reject(error); } });
    socket.once('connect', () => socket.end(JSON.stringify(message)));
  });
}
function callOutputs(value: any): Row[] {
  if (typeof value === 'string') { try { return callOutputs(JSON.parse(value)); } catch { return []; } }
  if (Array.isArray(value)) return value.flatMap(callOutputs);
  if (!value || typeof value !== 'object') return [];
  return String(value.type).endsWith('call_output') ? [value] : Object.values(value).flatMap(callOutputs);
}

function handoffToolRoute(available: Row[]) {
  const namespace = available.find(tool => tool.type === 'namespace' &&
    tool.tools?.some((t: Row) => t.name === 'handoff_fixture'));
  const direct = available.find(tool => tool.type === 'function' && tool.name?.endsWith('__handoff_fixture'));
  const executor = available.find(tool => tool.type === 'namespace' &&
    tool.tools?.some((t: Row) => t.type === 'custom' && t.name === 'exec'));
  // The executor may be advertised before the deferred MCP tool. Its presence
  // does not establish that handoff_fixture is callable in ALL_TOOLS yet.
  const discovery = !namespace && !direct && available.some(tool => tool.type === 'tool_search');
  return { namespace, direct, executor, discovery };
}

it('discovers a deferred handoff tool before invoking an already advertised executor', context => nativeRuntimeCase(context, () => {
  const executor = { type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec' }] };
  const search = { type: 'tool_search' };
  expect(handoffToolRoute([executor, search])).toMatchObject({ discovery: true });
  const tool = { type: 'function', name: 'mcp__fixture__handoff_fixture' };
  expect(handoffToolRoute([executor, search, tool])).toMatchObject({ discovery: false, direct: tool });
}), nativeRuntimeOptions.testTimeoutMs);

it('read-only context preview isolates an overlapping coordination writer', context => nativeRuntimeCase(context, async () => {
  const { productionAssumeFixture } = await import('../vitest-shims/identity-assume-production');
  let entered!: () => void, written!: () => void;
  const previewEntered = new Promise<void>(resolve => { entered = resolve; });
  const writerFinished = new Promise<void>(resolve => { written = resolve; });
  const real = await productionAssumeFixture('native-context-fixture', sql => { productionState.sql = sql; },
    (sql, run) => previewDatabase.run(sql, async () => {
      const [row] = await sql`SELECT current_setting('transaction_read_only') AS read_only`;
      expect(row.read_only).toBe('on');
      entered();
      await writerFinished;
      return run();
    }));
  // Created outside the preview's async context, as the telemetry flush timer is.
  const owner = 'test-assume-overlap-' + randomUUID();
  const writer = (async () => {
    await previewEntered;
    try { await real.send(owner, 'Independent writer during read-only preview'); }
    finally { written(); }
  })();
  try {
    await real.readOnlyPreview(owner, owner, 'native-resume');
    await writer;
    expect(await real.pending(owner)).toHaveLength(1);
  } finally {
    entered(); written();
    await Promise.allSettled([writer]);
    await real.dispose(); productionState.sql = undefined;
  }
}), nativeRuntimeOptions.testTimeoutMs);

async function nativeJourney(mode: 'native-resume' | 'checkpoint', production = false,
  contended = false, preflight = false, channelControls = false, crashRecovery = false, returnControls = false,
  checks: { responseOrdering?: boolean; crashAfterStartup?: boolean;
    diagnosticProbe?: { error: Error; artifact: string } } = {}) {
    const root = mkdtempSync('/tmp/assume-native-journey-');
    // Diagnostic treatment changes only the Responses item identity. Tool
    // correlation, prompts, custody checks and deadlines stay identical.
    const returnItemIdentity = process.env.PC_ASSUME_RETURN_ITEM_ID_MODE ?? 'duplicate';
    if (!['duplicate', 'unique'].includes(returnItemIdentity)) throw new Error('Invalid return item identity mode');
    const milestone = (stage: string, detail: Row = {}) => {
      const path = process.env.PC_EXECUTED_SOURCE_MAP_OUT;
      if (path) appendFileSync(path + '.native-milestones.jsonl', JSON.stringify({
        journey: root, atMs: Date.now(), mode, production, returnItemIdentity, stage, ...detail }) + '\n');
    };
    const marker = { target: `TARGET_HISTORY_${randomUUID()}`, caller: `CALLER_HISTORY_${randomUUID()}`,
      checkpoint: `TARGET_CHECKPOINT_${randomUUID()}`, rival: `RIVAL_HISTORY_${randomUUID()}`,
      loserProbe: `LOSER_COMMAND_${randomUUID()}`, loserResponse: `LOSER_RESPONSE_${randomUUID()}`,
      channelInput: `TARGET_INPUT_${randomUUID()}`, channelResponse: `TARGET_OUTPUT_${randomUUID()}`,
      channelHold: `TARGET_HOLD_${randomUUID()}`, returnInput: `RETURN_INPUT_${randomUUID()}`,
      returnResponse: `RETURN_OUTPUT_${randomUUID()}`, returnHold: `RETURN_HOLD_${randomUUID()}` };
    const privateCallerEnv = { ASSUME_CALLER_TOOL_HISTORY: `CALLER_TOOL_HISTORY_${randomUUID()}`,
      ASSUME_CALLER_TRANSCRIPT: marker.caller, OPENAI_API_KEY: `fixture-only-${randomUUID()}`,
      PAPERCUSP_NATIVE_SESSION_ID: `caller-private-${randomUUID()}` };
    const owners = { caller: `test-assume-caller-${randomUUID()}`, target: `test-assume-target-${randomUUID()}`,
      rival: `test-assume-rival-${randomUUID()}` };
    const homes = { caller: join(root, 'caller'), target: join(root, 'target'), rival: join(root, 'rival') };
    for (const home of Object.values(homes)) mkdirSync(home);
    const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
    let output = '';
    const io = { stdin, stdout: { isTTY: false, columns: 120, rows: 40,
      write(data: string) { output += data; return true; } } };
    let phase: 'seed' | 'caller' | 'target' | 'return' = 'seed';
    let port = 0, issued = false, targetReady = false, returnIssued = false, targetProbed = false;
    const requests: Array<{ atMs: number; phase: string; actor: string; body: Row }> = [], errors: string[] = [], nativeResults: string[] = [];
    const toolCatalogs: Row[] = [];
    const mcpRequests: Row[] = [], toolOutputs: Row[] = [];
    const activeExecutions = new Map<string, string>();
    const ownsPhase = (actor: string | null, execution: string | null) =>
      actor !== null && execution !== null && activeExecutions.get(actor) === execution &&
      (phase === 'seed' || phase === 'target' ? actor === 'target' :
        actor === 'caller' || phase === 'caller' && contended && actor === 'rival');
    const hosts: McpServer[] = [];
    const orders: Row[] = [], inspections = new Map<string, Row>();
    const crashBoundaries: Array<{ hostPid: number; exitCode: number }> = [];
    const startupCrashCustody: Row[] = [];
    let callerResponseSeen = false, targetStartupCrashed = false;
    let releaseCallerCompletion!: () => void, releaseStartupCrash!: () => void;
    const callerCompletionGate = new Promise<void>(resolve => { releaseCallerCompletion = resolve; });
    const startupCrashGate = new Promise<void>(resolve => { releaseStartupCrash = resolve; });
    let releaseTarget!: () => void;
    let retireSeed!: () => Promise<void>;
    const targetGate = new Promise<void>(resolve => { releaseTarget = resolve; });
    let controlRequested = false, releaseControl!: () => void;
    const controlGate = new Promise<void>(resolve => { releaseControl = resolve; });
    const runs: Array<{ owner: string; signals: EventEmitter; done: Promise<number> }> = [];
    const callerIssued = new Set<string>();
    const race: Array<{ owner: string; receipt: Row; workId: string }> = [];
    let preparedCallers = 0, releaseCallers!: () => void;
    const callersReady = new Promise<void>(resolve => { releaseCallers = resolve; });
    const transcript = (key: keyof typeof homes, id?: string) => {
      const files = readdirSync(join(homes[key], 'sessions'), { recursive: true }).map(String)
        .filter(path => path.endsWith('.jsonl'));
      const found = files.map(path => readFileSync(join(homes[key], 'sessions', path), 'utf8'))
        .filter(text => !id || JSON.parse(text.split('\n')[0]).payload.id === id);
      if (found.length !== 1) throw new Error(`Expected one ${key} transcript, found ${found.length}`);
      return found[0];
    };
    const nativeId = (key: keyof typeof homes) => JSON.parse(transcript(key).split('\n')[0]).payload.id as string;
    const latestNativeId = (key: keyof typeof homes) => {
      const files = readdirSync(join(homes[key], 'sessions'), { recursive: true }).map(String)
        .filter(path => path.endsWith('.jsonl'));
      return files.map(path => JSON.parse(readFileSync(join(homes[key], 'sessions', path), 'utf8').split('\n')[0]))
        .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).at(-1)!.payload.id as string;
    };
    let real: Awaited<ReturnType<typeof import('../vitest-shims/identity-assume-production').productionAssumeFixture>> | undefined;
    let preflightStep = 'not-started';
    let accepted: Row | undefined, returning: Row | undefined, targetWork = '', callerWork = '';
    const routed: Row[] = [];
    const initialResponsibilities = new Map<string, Row>();
    const inspect = async (request: Row, afterExit = false, action = 'observe', startup?: Row) => {
      if (real) return real.inspect(request, afterExit, action, startup);
      const result = inspections.get(request.transitionKey);
      if (!result || JSON.stringify(result.preparation.caller) !== JSON.stringify(request.caller))
        throw new Error('Fixture inspection refused an unknown caller');
      if (action === 'begin-startup' || action === 'startup-started')
        return { ok: true, attemptId: startup!.attemptId };
      return result;
    };
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        if (req.url === '/inspect') {
          const result = await inspect(body.request, body.afterExit, body.action);
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); return;
        }
        if (req.url?.split('?')[0] === '/mcp') {
          const query = new URL(req.url, 'http://localhost').searchParams;
          const actor = query.get('actor'), execution = query.get('execution');
          mcpRequests.push({ atMs: Date.now(), phase, actor, method: body?.method });
          const host = new McpServer({ name: 'native-handoff-fixture', version: '1' }); hosts.push(host);
          host.registerTool('handoff_fixture', { inputSchema: {} }, async () => {
            if (phase !== 'caller' && phase !== 'target') throw new Error('Handoff outside an execution phase');
            if (!ownsPhase(actor, execution)) throw new Error('Handoff from an inactive native execution');
            if (real && phase === 'target' && !targetProbed) {
              targetProbed = true;
              const result = await real.probe(owners.target, targetWork);
              routed.push(result);
              return { content: [{ type: 'text', text: JSON.stringify(result) }] };
            }
            if (real && phase === 'target') {
              const plan = await real.prepare(owners.target, owners.caller, 'native-resume');
              returning = await real.commit(plan);
              if (returning.state !== 'handoff-accepted') throw new Error('Production return refused: ' +
                JSON.stringify({ state: returning.state, reason: returning.reason, trace: real.trace }));
              milestone('C-return-tool-result', { returning });
              return { content: [{ type: 'text', text: JSON.stringify(returning) }] };
            }
            if (real) {
              const key = actor === 'rival' ? 'rival' : 'caller';
              const owner = owners[key], id = nativeId(key);
              await vi.waitFor(() => expect(JSON.parse(readFileSync(metaPathFor(owner), 'utf8'))
                .nativeSessionId).toBe(id), { timeout: 5000 });
              const registration = await real.register(owner, id, root, false);
              productionState.homes.set(String(registration), homes[key]);
              const workId = await real.assign(owner);
              initialResponsibilities.set(owner, (await real.seedResponsibilities(owner, workId))!);
              await real.send(owner, 'CALLER_BEFORE_HANDOFF');
              if (preflight) {
                // Keep the seeded native target running despite its terminal
                // registration: a stale ended row must never admit a live writer.
                expect(alive(JSON.parse(readFileSync(metaPathFor(owners.target), 'utf8')).ptyPid)).toBe(true);
                expect(await real.readOnlyPreview(owner, owners.target, mode))
                  .toEqual({ ok: false, code: 'target-live' });
                expect(await real.pause(owner)).toBeNull();
                await retireSeed();
                const callerMetaPath = metaPathFor(owner);
                const executionPin = () => {
                  const meta = JSON.parse(readFileSync(callerMetaPath, 'utf8'));
                  return { ownerId: meta.ownerId, ptyPid: meta.ptyPid, nativeSessionId: meta.nativeSessionId,
                    childGeneration: meta.childGeneration, identityAssume: meta.identityAssume };
                };
                const beforeMeta = executionPin();
                const beforeTarget = await real.resolve(real.records.get(owners.target)!);
                const assertUnchanged = async () => {
                  expect(executionPin()).toEqual(beforeMeta);
                  expect(alive(beforeMeta.ptyPid)).toBe(true);
                  expect(await real!.pause(owner)).toBeNull();
                  expect(await real!.resolve(real!.records.get(owners.target)!)).toEqual(beforeTarget);
                };
                // PostgreSQL rejects any write from the real preparation readers.
                // The exact registration and managed attachment must also stay put.
                const preview = await real.readOnlyPreview(owner, owners.target, mode);
                expect(preview).toMatchObject({ ok: true, state: 'prepared', preparation: { target: {
                  ownerId: owners.target, advSessionId: real.records.get(owners.target),
                  nativeSessionId: nativeId('target'), ended: true, writer: 'free',
                  binding: { coordOwnerId: owners.target, sessionId: nativeId('target') },
                } } });
                if (!preview.ok) throw new Error('Production preview refused');
                expect(await real.load(preview.preparation)).toBeNull();
                await assertUnchanged();
                const beforeResponsibilities = await real.responsibilitySnapshot(owner);
                const unauthorized = await real.authorizationRefusals(owner, owners.target, mode,
                  preview.token, preview.preparation.expiresAt);
                expect(unauthorized.denied).toEqual(Array.from({ length: 4 },
                  () => ({ ok: false, code: 'unauthorized' })));
                expect(unauthorized.readerCalls).toBe(0);
                expect(unauthorized.otherCaller).toEqual({ ok: false, code: 'caller-changed' });
                expect(unauthorized.otherWorkspace).toEqual({ ok: false, code: 'caller-changed' });
                expect(unauthorized.tampered).toEqual({ ok: false, code: 'invalid-token' });
                expect(unauthorized.expired).toEqual({ ok: false, code: 'expired-token' });
                expect(await real.responsibilitySnapshot(owner)).toEqual(beforeResponsibilities);
                expect(await real.load(preview.preparation)).toBeNull();
                await assertUnchanged();
                // Exercise the actual installed target's transcript resolver.
                // A valid checkpoint must not rescue explicit native mode, and
                // a valid transcript must not rescue a stale checkpoint.
                const targetNativeId = nativeId('target');
                const sessionsRoot = join(homes.target, 'sessions');
                const targetRollout = readdirSync(sessionsRoot, { recursive: true }).map(String)
                  .filter(path => path.endsWith('.jsonl')).find(path =>
                    JSON.parse(readFileSync(join(sessionsRoot, path), 'utf8').split('\n')[0])
                      .payload.id === targetNativeId)!;
                const targetRolloutPath = join(sessionsRoot, targetRollout);
                const originalTranscript = readFileSync(targetRolloutPath, 'utf8');
                for (const fault of ['missing', 'corrupt', 'other-conversation'] as const) {
                  preflightStep = 'R3 native ' + fault;
                  renameSync(targetRolloutPath, targetRolloutPath + '.saved');
                  try {
                    if (fault !== 'missing') {
                      const otherId = randomUUID();
                      const altered = fault === 'corrupt' ? '{corrupt native transcript\n'
                        : originalTranscript.split('\n').filter(Boolean).map(line => {
                          const entry = JSON.parse(line);
                          if (entry.type === 'session_meta') entry.payload.id = otherId;
                          return JSON.stringify(entry);
                        }).join('\n') + '\n';
                      writeFileSync(targetRolloutPath, altered);
                      if (fault === 'other-conversation') expect(JSON.parse(altered.split('\n')[0]).payload.id)
                        .toBe(otherId);
                    }
                    expect(await readAssumeTranscriptPin(targetRolloutPath, sessionsRoot, 'codex', targetNativeId),
                      preflightStep + ' exact file').toBeNull();
                    expect(await real.readOnlyPreview(owner, owners.target, 'native-resume'), 'R3 native ' + fault)
                      .toEqual({ ok: false, code: 'context-unavailable' });
                    expect(await real.readOnlyPreview(owner, owners.target, 'checkpoint'))
                      .toMatchObject({ ok: true, preparation: { target: { context: { mode: 'checkpoint' } } } });
                    await assertUnchanged();
                  } finally {
                    if (existsSync(targetRolloutPath)) unlinkSync(targetRolloutPath);
                    renameSync(targetRolloutPath + '.saved', targetRolloutPath);
                  }
                }
                const [checkpoint] = await real.sql`SELECT scope, body_ts FROM harness_shared.carry_notes
                  WHERE workspace_id = 'native-context-fixture' AND scope LIKE ${'loop:%' + owners.target}`;
                expect(checkpoint).toBeDefined();
                await real.sql`UPDATE harness_shared.carry_notes SET body_ts = 0
                  WHERE workspace_id = 'native-context-fixture' AND scope = ${checkpoint.scope}`;
                try {
                  preflightStep = 'R3 stale checkpoint';
                  expect(await real.readOnlyPreview(owner, owners.target, 'checkpoint'), 'R3 stale checkpoint')
                    .toEqual({ ok: false, code: 'context-unavailable' });
                  expect(await real.readOnlyPreview(owner, owners.target, 'native-resume'))
                    .toMatchObject({ ok: true, preparation: { target: { context: { mode: 'native-resume' } } } });
                  await assertUnchanged();
                } finally {
                  await real.sql`UPDATE harness_shared.carry_notes SET body_ts = ${checkpoint.body_ts}
                    WHERE workspace_id = 'native-context-fixture' AND scope = ${checkpoint.scope}`;
                }
                preflightStep = 'R3 complete';
                const targetId = real.records.get(owners.target)!;
                await real.sql`UPDATE harness_shared.adv_sessions SET workspace_id = 'foreign-native-fixture'
                  WHERE id = ${targetId}`;
                try {
                  expect(await real.readOnlyPreview(owner, owners.target, mode))
                    .toEqual({ ok: false, code: 'context-unavailable' });
                  expect(await real.pause(owner)).toBeNull();
                  expect(executionPin()).toEqual(beforeMeta);
                } finally {
                  await real.sql`UPDATE harness_shared.adv_sessions SET workspace_id = 'native-context-fixture'
                    WHERE id = ${targetId}`;
                }
                await assertUnchanged();
                // An actual filesystem error, rather than a mocked writer verdict,
                // exercises the production native-lock reader's unknown branch.
                const lock = codexThreadWriterLockPath(homes.target, nativeId('target'))!;
                const hadLock = existsSync(lock);
                if (hadLock) renameSync(lock, lock + '.saved');
                symlinkSync(basename(lock), lock);
                try {
                  expect(codexThreadWriterHolder(homes.target, nativeId('target')).reason).toBe('stat-error-ELOOP');
                  expect(await real.readOnlyPreview(owner, owners.target, mode))
                    .toEqual({ ok: false, code: 'writer-unknown' });
                  expect(await real.load(preview.preparation)).toBeNull();
                  await assertUnchanged();
                } finally {
                  unlinkSync(lock);
                  if (hadLock) renameSync(lock + '.saved', lock);
                }
              }
              const plan = await real.prepare(owner, owners.target, mode);
              if (contended) {
                if (++preparedCallers === 2) releaseCallers();
                await callersReady;
              }
              const receipt = await real.commit(plan);
              if (contended) race.push({ owner, receipt, workId });
              if (contended && receipt.state === 'refused')
                return { content: [{ type: 'text', text: JSON.stringify(receipt) }] };
              accepted = receipt; callerWork = workId;
              if (receipt.state !== 'handoff-accepted') throw new Error('Production commit: ' + JSON.stringify({
                state: receipt.state, reason: receipt.reason, trace: real.trace }));
              // The native tool response has not been delivered and the caller
              // still runs. Its independently reloaded recovery must exist now.
              expect(alive(receipt.preparation.caller.nativePid)).toBe(true);
              const recovery = await real.recovery(receipt);
              expect(recovery).toMatchObject({ caller: receipt.preparation.caller,
                transitionKey: receipt.transitionKey });
              expect(recovery.work.some(row => row.id === workId && row.checkpoint.includes(owner))).toBe(true);
              expect(await real.responsibilitySnapshot(owners.target)).toEqual(initialResponsibilities.get(owners.target));
              await real.send(owners.target, 'DURING_HANDOFF');
              return { content: [{ type: 'text', text: JSON.stringify(accepted) }] };
            }
            const key = phase, other = key === 'caller' ? 'target' : 'caller';
            const meta = JSON.parse(readFileSync(metaPathFor(owners[key]), 'utf8'));
            const caller = { ownerId: owners[key], workspaceId: 'native-context-fixture',
              nativeSessionId: latestNativeId(key), nativePid: meta.ptyPid,
              hostId: meta.identityAssume.hostId, attachmentId: meta.identityAssume.attachmentId,
              childGeneration: meta.childGeneration };
            const request = { caller, transitionKey: `session-assume:${hash(randomUUID())}`,
              preparationHash: hash(randomUUID()), recoveryRef: `carry-note:${key}`,
              recoveryHash: hash(randomUUID()), expiresAt: Date.now() + 120_000 };
            const target = { ownerId: owners[other], workspaceId: caller.workspaceId, advSessionId: other === 'target' ? 2 : 1,
              backend: 'codex', role: 'su', nativeSessionId: nativeId(other),
              executionNativeSessionId: key === 'caller' && mode === 'checkpoint' ? null : nativeId(other),
              context: { mode: key === 'caller' ? mode : 'native-resume',
                ref: key === 'caller' && mode === 'checkpoint' ? 'carry-note:target' : nativeId(other),
                sha256: hash(marker.checkpoint), revision: 'fixture' },
              ...(key === 'target' ? { returnFrom: { transitionKey: orders[0].assume.request.transitionKey } } : {}) };
            inspections.set(request.transitionKey, { ok: true, state: 'handoff-accepted',
              transitionKey: request.transitionKey, preparationHash: request.preparationHash,
              preparation: { caller, target, expiresAt: request.expiresAt }, checkpointBody: marker.checkpoint,
              recovery: { checkpointRef: request.recoveryRef, checkpointSha256: request.recoveryHash,
                returnRef: { ownerId: caller.ownerId } } });
            for (const action of ['freeze', 'queue']) expect(await control(meta.sock,
              { v: 1, mode: 'identity-assume', ownerId: caller.ownerId, action, request })).toMatchObject({ ok: true });
            return { content: [{ type: 'text', text: JSON.stringify({ transitionKey: request.transitionKey,
              preparationFingerprint: request.preparationHash, state: 'handoff-accepted', durable: true,
              preparation: { caller: { ...caller, backend: 'codex' } },
              recovery: { checkpointRef: request.recoveryRef, checkpointSha256: request.recoveryHash } }) }] };
          });
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
          await host.connect(transport); await transport.handleRequest(req, res, body); return;
        }
        if (!req.url?.endsWith('/responses')) { res.writeHead(200); res.end('{}'); return; }
        const [, , actor, execution] = req.url.split('?')[0].split('/');
        requests.push({ atMs: Date.now(), phase, actor, body }); res.writeHead(200, { 'content-type': 'text/event-stream' });
        const finish = (text: string) => res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({
          model: 'gpt-6-sol', text, inputTokens: 0, outputTokens: 0 })));
        // A parked loser's late provider request still belongs to that caller.
        // It cannot advance the target/return phase or consume its responsibilities.
        if (!ownsPhase(actor, execution)) { finish('INACTIVE_NATIVE_EXECUTION'); return; }
        if (checks.crashAfterStartup && phase === 'target' && !targetStartupCrashed) {
          await startupCrashGate;
          // This request belongs to the process killed before finalization.
          finish('CRASHED_NATIVE_EXECUTION'); return;
        }
        if (phase === 'seed') { finish(marker.target); return; }
        if (phase === 'return') {
          const userInput = (body.input ?? []).filter((item: Row) => item.role === 'user')
            .map((item: Row) => JSON.stringify(item)).join('\n');
          if (returnControls && userInput.includes(marker.returnHold)) {
            controlRequested = true; await controlGate; finish('LATE_RETURN_OUTPUT'); return;
          }
          finish(returnControls && userInput.includes(marker.returnInput) ? marker.returnResponse : 'CALLER_RETURNED');
          return;
        }
        if (channelControls && phase === 'target') {
          const userInput = (body.input ?? []).filter((item: Row) => item.role === 'user')
            .map((item: Row) => JSON.stringify(item)).join('\n');
          if (userInput.includes(marker.channelHold)) {
            controlRequested = true; await controlGate; finish('LATE_INTERRUPTED_OUTPUT'); return;
          }
          if (userInput.includes(marker.channelInput)) { finish(marker.channelResponse); return; }
        }
        if (contended && phase === 'caller' && JSON.stringify(body).includes(marker.loserProbe)) {
          finish(marker.loserResponse); return;
        }
        const outputs = callOutputs(body.input);
        toolOutputs.push(...outputs.map(row => ({ atMs: Date.now(), phase, actor, type: row.type,
          callId: row.call_id, output: JSON.stringify(row.output ?? null).slice(0, 1800) })));
        if (real && phase === 'target' && outputs.some(row => row.call_id === 'handoff-target-return')) {
          milestone('D-provider-received-return-result', { actor, execution, input: body.input });
          finish('RETURN_NATIVE_COMPLETE'); return;
        }
        const results = outputs.filter(row => row.call_id === `handoff-${phase}`);
        let returningCall = false;
        if (results.length) {
          nativeResults.push(JSON.stringify(results).slice(0, 1800));
          if (checks.responseOrdering && phase === 'caller') {
            expect(JSON.stringify(results)).toContain(accepted!.transitionKey);
            expect(alive(accepted!.preparation.caller.nativePid)).toBe(true);
            callerResponseSeen = true;
            await callerCompletionGate;
          }
          if (phase === 'target') {
            milestone('A-provider-received-target-result', { actor, execution, input: body.input });
            targetReady = true; await targetGate;
          }
          if (channelControls && phase === 'target') { finish('TARGET_CHANNEL_READY'); return; }
          if (real && phase === 'target' && !returnIssued) { returningCall = true; }
          else { finish('HANDOFF_NATIVE_COMPLETE'); return; }
        }
        const available = [...(body.tools ?? []), ...(body.input ?? []).flatMap(
          (item: Row) => Array.isArray(item.tools) ? item.tools : [])];
        const { namespace, direct, executor, discovery } = handoffToolRoute(available);
        toolCatalogs.push({ phase, actor, discovery, executor: executor?.name,
          tools: available.map(tool => ({ type: tool.type, name: tool.name,
            tools: tool.tools?.map((entry: Row) => entry.name) })) });
        const alreadyIssued = contended && phase === 'caller' ? callerIssued.has(actor) : issued;
        if (alreadyIssued && !returningCall || !namespace && !direct && !executor && !available.some(tool => tool.type === 'tool_search')) {
          finish('AUXILIARY_RESPONSE'); return;
        }
        issued = !discovery;
        if (!discovery && returningCall) returnIssued = true;
        if (contended && phase === 'caller' && !discovery) callerIssued.add(actor);
        const callId = returningCall ? 'handoff-target-return' : `handoff-${phase}`;
        const itemId = returningCall && returnItemIdentity === 'unique' ? 'call-target-return' : `call-${phase}`;
        const call = discovery ? { id: 'discover', type: 'tool_search_call', execution: 'client',
          call_id: 'discover-handoff', status: 'completed', arguments: { query: 'handoff_fixture', limit: 1 } } : executor
          ? { id: itemId, type: 'custom_tool_call', namespace: executor.name, name: 'exec',
            call_id: callId, status: 'completed',
            input: "const tool=ALL_TOOLS.find(t=>t.name.endsWith('__handoff_fixture')); if(!tool)throw new Error('Missing handoff fixture');text(await tools[tool.name]({}));" }
          : { id: itemId, type: 'function_call', call_id: callId, status: 'completed',
            ...(namespace ? { namespace: namespace.name } : {}), name: direct?.name ?? 'handoff_fixture', arguments: '{}' };
        const event = (type: string, payload: Row) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
        if (returningCall) milestone('B-return-call-emitted', { actor, execution, call });
        res.end(event('response.output_item.added', { output_index: 0,
          item: { ...call, status: 'in_progress', ...(!discovery && executor ? { input: '' } : { arguments: discovery ? {} : '' }) } }) +
          event('response.output_item.done', { output_index: 0, item: call }) +
          event('response.completed', { response: { ...codexCliResponsesBody({ model: 'gpt-6-sol',
            text: '', inputTokens: 0, outputTokens: 0 }), output: [call] } }));
      } catch (error) { errors.push(String(error)); if (!res.headersSent) res.writeHead(500); res.end(); }
    });
    const baseArgs = (key: keyof typeof homes = 'target') => {
      const execution = randomUUID(); activeExecutions.set(key, execution);
      return ['--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox',
      ...Object.entries({ model: 'gpt-6-sol', model_provider: 'assume_fixture',
        'model_providers.assume_fixture.name': 'Offline native context fixture',
        'model_providers.assume_fixture.base_url': `http://127.0.0.1:${port}/v1/${key}/${execution}`,
        'mcp_servers.fixture.url': `http://127.0.0.1:${port}/mcp?actor=${key}&execution=${execution}`,
        'model_providers.assume_fixture.wire_api': 'responses',
        'model_providers.assume_fixture.requires_openai_auth': false,
        'model_providers.assume_fixture.supports_websockets': false,
        'model_providers.assume_fixture.request_max_retries': 0,
        'model_providers.assume_fixture.stream_max_retries': 0,
        'features.apps': false, 'features.hooks': false, web_search: 'disabled',
        [`projects.${JSON.stringify(root)}.trust_level`]: 'trusted' })
        .flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])];
    };
    const start = (key: keyof typeof homes, args: string[], inherited?: Row) => {
      const signals = new EventEmitter();
      const contextEnv = inherited?.inheritedEnv ?? (key === 'caller' ? privateCallerEnv : {});
      if (production) {
        const file = join(root, 'psu-pty-host-' + key + '.mjs');
        const hostModule = new URL('../scripts/psu-pty-host.mjs', import.meta.url).href;
        const assumeModule = new URL('../scripts/psu-identity-assume.mjs', import.meta.url).href;
        // This subprocess really owns the production host and native child.
        // Discovery checks its command line; no discovery verifier is replaced.
        writeFileSync(file, [
          'import {hostThroughPty,writeHostHandoff} from ' + JSON.stringify(hostModule) + ';',
          'import {makeIdentityAssumeHostPort} from ' + JSON.stringify(assumeModule) + ';',
          'import {readdirSync,readFileSync} from "node:fs"; import {join} from "node:path";',
          'const inspect=async(request,afterExit=false,action="observe")=>{const r=await fetch(' +
            JSON.stringify('http://127.0.0.1:' + port + '/inspect') +
            ',{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({request,afterExit,action})});' +
            'if(!r.ok)throw new Error("Inspection refused");return r.json()};',
          'const latest=()=>{try{const root=join(process.env.CODEX_HOME,"sessions");return readdirSync(root,{recursive:true})' +
            '.map(String).filter(p=>p.endsWith(".jsonl")).map(p=>JSON.parse(readFileSync(join(root,p),"utf8").split("\\n")[0]))' +
            '.sort((a,b)=>String(a.timestamp).localeCompare(String(b.timestamp))).at(-1)?.payload.id??null}catch{return null}};',
          'process.on("message",message=>{if(message.resize){process.stdout.columns=message.resize.cols;' +
            'process.stdout.rows=message.resize.rows;process.stdout.emit("resize")}});',
          'const identityAssume=makeIdentityAssumeHostPort({ownerId:process.env.PAPERCUSP_SID,inspect,reexecCode:75,' +
            'hostId:' + JSON.stringify(inherited?.hostId ?? null) + ',attachmentId:' + JSON.stringify(inherited?.attachmentId ?? null) +
            ',writeHandoff:(owner,record)=>{const path=writeHostHandoff(owner,record);' +
            'if(path)process.send?.({handoff:JSON.parse(readFileSync(path,"utf8"))});return path}});',
          'const code=await hostThroughPty({command:"codex",args:' + JSON.stringify(args) +
            ',cwd:' + JSON.stringify(root) + ',ownerId:process.env.PAPERCUSP_SID,env:process.env,' +
            'resolveRespawnNativeId:latest,identityAssume,onReexec:()=>{},emitCompacted:()=>null,onExit:()=>{},activityPersistMs:100,bridgeTty:false});',
          ...(crashRecovery && key === 'caller' && !inherited ? [
            // Stop only after the real native-exit boundary and durable orders.
            // The parent kills this host before any target launcher is entered.
            'if(code===75){process.send?.({crashBoundary:{hostPid:process.pid,exitCode:code}});' +
              'await new Promise(()=>{})}',
          ] : []),
          'process.exit(code);',
        ].join('\n'));
        const child = spawn(process.execPath, [file], { cwd: root,
          env: hermeticEnv({ ...contextEnv, CODEX_HOME: homes[key], TERM: 'xterm-256color', PAPERCUSP_AGENT: 'codex',
            PAPERCUSP_SID: owners[key], PAPERCUSP_WORKSPACE: 'native-context-fixture',
            PAPERCUSP_PSU_REEXEC: '75', PAPERCUSP_PSU_REEXEC_PPID: String(process.pid) }),
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
        child.stdout!.on('data', data => { output += data; }); child.stderr!.on('data', data => { output += data; });
        child.on('message', (message: any) => {
          if (message.handoff) orders.push(message.handoff);
          if (message.crashBoundary) crashBoundaries.push(message.crashBoundary);
        });
        signals.on('SIGTERM', () => child.kill('SIGTERM'));
        signals.on('SIGKILL', () => child.kill('SIGKILL'));
        signals.on('input', data => child.stdin!.write(data));
        signals.on('resize', (cols, rows) => child.send({ resize: { cols, rows } }));
        const done = new Promise<number>((resolve, reject) => {
          child.once('error', reject); child.once('close', code => resolve(code ?? -1));
        });
        const run = { owner: owners[key], signals, done }; runs.push(run); return run;
      }
      const hostPort = makeIdentityAssumeHostPort({ ownerId: owners[key], inspect,
        reexecCode: 75, attachmentId: inherited?.attachmentId, hostId: inherited?.hostId,
        writeHandoff: (_owner: string, record: Row) => {
          // This same-process fixture cannot exit its Vitest parent. Pin the
          // real departed native PID as the predecessor for the helper seam.
          orders.push({ ...record, ownerId: owners[key], fromPid: record.assume.request.caller.nativePid });
          return handoffPathFor(owners[key]);
        } });
      const done = hostThroughPty({ command: 'codex', args, cwd: root, ownerId: owners[key],
        env: hermeticEnv({ ...contextEnv, CODEX_HOME: homes[key], TERM: 'xterm-256color', PAPERCUSP_AGENT: 'codex',
          PAPERCUSP_SID: owners[key], PAPERCUSP_WORKSPACE: 'native-context-fixture',
          PAPERCUSP_PSU_REEXEC: '75', PAPERCUSP_PSU_REEXEC_PPID: String(process.ppid) }),
        resolveRespawnNativeId: () => { try { return latestNativeId(key); } catch { return null; } },
        identityAssume: hostPort, onReexec: () => {}, signalSource: signals,
        emitCompacted: () => null, onExit: () => {}, bridgeTty: false, io });
      const run = { owner: owners[key], signals, done }; runs.push(run); return run;
    };
    const diagnostics = () => JSON.stringify({ phase, preflightStep, errors, nativeResults, toolCatalogs, mcpRequests, toolOutputs,
      requests: requests.length, orders: orders.length, startupCrashCustody,
      output: output.slice(-1200) });
    try {
      if (production) {
        const { productionAssumeFixture } = await import('../vitest-shims/identity-assume-production');
        real = await productionAssumeFixture('native-context-fixture', sql => { productionState.sql = sql; },
          (sql, run) => previewDatabase.run(sql, run));
      }
      port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1',
        () => resolve((server.address() as net.AddressInfo).port)));
      for (const [key, home] of Object.entries(homes)) {
        writeFileSync(join(home, 'AGENTS.md'), 'Isolated native context fixture persona.');
        writeFileSync(join(home, 'config.toml'),
          // Each journey needs the real MCP handler before its first tool call.
          // Optional startup otherwise races the already available exec tool.
          `[mcp_servers.fixture]\nrequired = true\nurl = "http://127.0.0.1:${port}/mcp?actor=${key}"\n`);
      }
      const seed = start('target', [...baseArgs(), 'Record the target history.']);
      await vi.waitFor(() => expect(output, diagnostics()).toContain(marker.target), { timeout: 20_000 });
      if (checks.diagnosticProbe) throw checks.diagnosticProbe.error;
      const seedExecution = activeExecutions.get('target')!;
      retireSeed = async () => {
        seed.signals.emit('SIGTERM'); await seed.done;
        activeExecutions.delete('target');
      };
      if (!preflight) await retireSeed();
      const targetNative = nativeId('target');
      if (real) {
        const registration = await real.register(owners.target, targetNative, root, true);
        productionState.homes.set(String(registration), homes.target);
        await real.checkpoint(owners.target, marker.checkpoint);
        await real.send(owners.target, 'BEFORE_HANDOFF');
        targetWork = await real.assign(owners.target);
        const retained = (await real.seedResponsibilities(owners.target, targetWork))!;
        expect(retained).toMatchObject({ ownerId: owners.target,
          work: { id: targetWork, assignee: owners.target }, planClaim: { owner: owners.target },
          directives: [{ recordedBy: owners.target, disposition: null }],
          routines: [{ active: true, ownerId: owners.target }, { active: false, ownerId: owners.target }],
          awaited: { subscriberId: owners.target }, fleet: { leaderOwnerId: owners.target },
          subscriptions: [{ subscriber: owners.target }], historical: { from: owners.target } });
        initialResponsibilities.set(owners.target, retained);
      }
      phase = 'caller'; issued = false;
      let caller = start('caller', [...baseArgs('caller'), marker.caller]);
      let losingActor: 'caller' | 'rival' | undefined;
      if (contended) start('rival', [...baseArgs('rival'), marker.rival]);
      if (checks.responseOrdering) {
        await vi.waitFor(() => expect(callerResponseSeen, diagnostics()).toBe(true), { timeout: 25_000 });
        const pinned = accepted!.preparation.caller;
        const before = JSON.parse(readFileSync(metaPathFor(owners.caller), 'utf8'));
        expect(await real!.commit(accepted!.preparation))
          .toMatchObject({ state: 'handoff-accepted', replayed: true });
        for (const mode of ['turn', 'carry-respawn'])
          expect(await control(before.sock, { v: 1, mode, ownerId: owners.caller, data: 'EARLY_INPUT' }))
            .toMatchObject({ ok: false, reason: 'assume-caller-paused' });
        // Cross multiple host inspection ticks while the invoking native child
        // has consumed its tool result but has no fresh completion boundary.
        await new Promise(resolve => setTimeout(resolve, 350));
        expect(alive(pinned.nativePid)).toBe(true);
        expect(orders).toHaveLength(0);
        expect(JSON.parse(readFileSync(metaPathFor(owners.caller), 'utf8')))
          .toMatchObject({ ptyPid: pinned.nativePid, childGeneration: before.childGeneration });
        releaseCallerCompletion();
      }
      await vi.waitFor(() => expect(orders, diagnostics()).toHaveLength(1), { timeout: 25_000 });
      if (contended) {
        await vi.waitFor(() => expect(race, diagnostics()).toHaveLength(2), { timeout: 10_000 });
        const winners = race.filter(row => row.receipt.state === 'handoff-accepted');
        const losers = race.filter(row => row.receipt.state === 'refused');
        expect(winners).toHaveLength(1); expect(losers).toHaveLength(1);
        const loser = losers[0];
        expect(loser.receipt.reason).toBe('custody-reserved');
        const loserMeta = JSON.parse(readFileSync(metaPathFor(loser.owner), 'utf8'));
        expect(alive(loserMeta.ptyPid)).toBe(true);
        expect(await real!.pause(loser.owner)).toBeNull();
        expect((await real!.load(loser.receipt.preparation))?.state).toBe('refused');
        const untouched = await real!.probe(loser.owner, loser.workId);
        expect(untouched.assignment).toMatchObject({ assignee: loser.owner, observedBy: loser.owner });
        expect(untouched.messages).toHaveLength(1);
        const loserKey = loser.owner === owners.rival ? 'rival' : 'caller';
        losingActor = loserKey;
        const loserNative = nativeId(loserKey);
        expect(await control(loserMeta.sock, { v: 1, mode: 'turn', ownerId: loser.owner,
          data: marker.loserProbe })).toMatchObject({ ok: true });
        await vi.waitFor(() => expect(transcript(loserKey)).toContain(marker.loserResponse), { timeout: 15_000 });
        expect(nativeId(loserKey)).toBe(loserNative);
        const loserInput = requests.filter(row => row.actor === loserKey).map(row => JSON.stringify(row.body)).join('\n');
        expect(loserInput).toContain(marker.loserProbe);
        expect(loserInput).not.toContain(marker.target);
        expect(loserInput).not.toContain(marker.checkpoint);
        if (winners[0].owner === owners.rival) {
          [owners.caller, owners.rival] = [owners.rival, owners.caller];
          [homes.caller, homes.rival] = [homes.rival, homes.caller];
          marker.caller = marker.rival;
        }
        caller = runs.find(run => run.owner === winners[0].owner)!;
        expect(orders[0].assume.request.caller.ownerId).toBe(winners[0].owner);
      }
      const original = orders[0].assume.request.caller;
      await vi.waitFor(() => expect(alive(original.nativePid), diagnostics()).toBe(false), { timeout: 10_000 });
      if (crashRecovery) {
        await vi.waitFor(() => expect(crashBoundaries).toHaveLength(1), { timeout: 10_000 });
        const boundary = crashBoundaries[0];
        expect(boundary).toEqual({ hostPid: orders[0].fromPid, exitCode: 75 });
        expect(alive(boundary.hostPid)).toBe(true);
        expect(await real!.load(accepted!.preparation)).toMatchObject({ state: 'handoff-accepted', durable: true });
        expect(await real!.pause(owners.caller)).not.toBeNull();
        const [reservation] = await real!.sql`SELECT resume_claim_key FROM harness_shared.adv_sessions
          WHERE id = ${real!.records.get(owners.target)!}`;
        expect(reservation.resume_claim_key).toBe(accepted!.transitionKey);
        caller.signals.emit('SIGKILL');
        expect(await caller.done).toBe(-1);
        await vi.waitFor(() => expect(alive(boundary.hostPid)).toBe(false));
        expect(alive(original.nativePid)).toBe(false);
        // The persisted receipt is the retry fence. Recovering the orders may
        // launch exactly once; replaying the commit may not start another host.
        expect(await real!.commit(accepted!.preparation))
          .toMatchObject({ state: 'handoff-accepted', replayed: true });
        expect(orders).toHaveLength(1);
      } else expect(await caller.done).toBe(75);
      if (real) {
        const consumed = readHostHandoffForParentPid(process.pid, { ownerId: owners.caller });
        expect(consumed).not.toBeNull(); orders[0] = consumed;
        expect(alive(orders[0].fromPid)).toBe(false);
        await real.depart(owners.caller);
      }
      const callerNative = nativeId('caller');
      const resume = async (session: Row, options: Row): Promise<typeof caller> => {
        await options.managedAssume.verify();
        const key = session.coordOwnerId === owners.target ? 'target' : 'caller';
        let args = [...baseArgs(key), 'resume', session.sessionId];
        let kickoff = options.kickoff;
        if (options.managedAssume.checkpoint) {
          const carry = prepareIdentityAssumeCheckpoint(session,
            options.managedAssume.checkpoint, args, { mint: mintCarryRespawnArgs,
              codexHome: homes[key], personaFile: null, home: root });
          args = carry.args;
          kickoff = [carry.carryText || options.managedAssume.checkpoint.body, kickoff].join('\n\n');
        }
        // Explicit phase prompt avoids relying on PTY ready-prompt timing.
        args.push(kickoff);
        await options.managedAssume.beginStartup();
        const run = start(key, args, options.managedAssume);
        if (real) {
          await vi.waitFor(() => {
            const meta = JSON.parse(readFileSync(metaPathFor(owners[key]), 'utf8'));
            expect(alive(meta.ptyPid)).toBe(true);
            expect(meta.nativeSessionId).toBe(latestNativeId(key));
            expect(meta.nativeSessionId === session.sessionId).toBe(!options.managedAssume.checkpoint);
          }, { timeout: 10_000 });
          const receipt = (key === 'target' ? accepted! : returning!) as AssumeTransitionReceipt;
          const startupMeta = JSON.parse(readFileSync(metaPathFor(owners[key]), 'utf8'));
          await options.managedAssume.started({ ptyPid: startupMeta.ptyPid });
          if (checks.crashAfterStartup && key === 'target' && !targetStartupCrashed) {
            const meta = JSON.parse(readFileSync(metaPathFor(owners.target), 'utf8'));
            let native: number | null = null;
            await vi.waitFor(() => {
              native = resolveLinuxCodexStartupPid(meta.ptyPid);
              expect(native).not.toBeNull();
            }, { timeout: 10_000 });
            await vi.waitFor(() => expect(codexThreadWriterHolder(homes.target, latestNativeId(key),
              { holderPid: native! }).held).toBe(true), { timeout: 5000 });
            // A writer lock alone can precede the first real transcript write.
            // Exercise recovery after native startup has advanced the pinned
            // history, while verification remains blocked by startupCrashGate.
            await vi.waitFor(() => expect(hash(transcript('target')))
              .not.toBe(receipt.preparation.target.context.sha256), { timeout: 10_000 });
            expect((await real.load(receipt.preparation))?.state).toBe('handoff-accepted');
            run.signals.emit('SIGKILL');
            expect(await run.done).toBe(-1);
            await vi.waitFor(() => expect(alive(native!)).toBe(false), { timeout: 10_000 });
            const custody = await real.custodySnapshot(receipt.preparation);
            startupCrashCustody.push(custody);
            if (process.env.PC_EXECUTED_SOURCE_MAP_OUT) appendFileSync(
              process.env.PC_EXECUTED_SOURCE_MAP_OUT + '.startup-custody.jsonl', JSON.stringify(custody) + '\n');
            targetStartupCrashed = true; releaseStartupCrash();
            expect(await real.commit(receipt.preparation))
              .toMatchObject({ state: 'handoff-accepted', replayed: true });
            expect(orders).toHaveLength(1);
            expect((await real.recovery(receipt)).transitionKey).toBe(receipt.transitionKey);
            expect(await real.pause(owners.caller)).not.toBeNull();
            // The original reservation is still held. Re-enter the supported
            // launch path only after its real native writer has exited.
            return resume(session, options);
          }
          await real.finalize(receipt.preparation, receipt.transitionKey, latestNativeId(key));
          await options.managedAssume.restoreReturn?.();
        }
        return run;
      };
      const launch = (handoff: Row) => launchIdentityAssumeHandoff(handoff, { inspect,
        resolveSession: async (id: number) => real ? real.resolve(id) : ({ id, coordOwnerId: id === 2 ? owners.target : owners.caller,
          workspaceId: original.workspaceId, agent: 'codex', role: 'su', sessionId: id === 2 ? targetNative : callerNative }),
        accountFor: async () => ({ mode: 'default' }), resume, isAlive: alive, baseEnv: privateCallerEnv });
      phase = 'target'; issued = false;
      if (contended) {
        // Exercise delayed replies before starting the replacement. Neither a
        // losing caller nor the old target incarnation may manufacture readiness.
        for (const [actor, execution] of [[losingActor!, activeExecutions.get(losingActor!)!],
          ['target', seedExecution]]) {
          const staleReply = fetch(`http://127.0.0.1:${port}/v1/${actor}/${execution}/responses`, {
            method: 'POST', body: JSON.stringify({ input: [{ type: 'function_call_output',
              call_id: 'handoff-target', output: 'LATE_NATIVE_OUTPUT' }] }),
          }).then(response => response.text());
          await vi.waitFor(() => expect(requests.some(row => row.actor === actor &&
            JSON.stringify(row.body).includes('LATE_NATIVE_OUTPUT'))).toBe(true));
          expect(targetReady).toBe(false); expect(routed).toHaveLength(0);
          expect(await staleReply).toContain('INACTIVE_NATIVE_EXECUTION');
        }
      }
      const targetRun = await launch(orders[0]);
      await vi.waitFor(() => expect(targetReady, diagnostics()).toBe(true), { timeout: 25_000 });
      const targetMeta = JSON.parse(readFileSync(metaPathFor(owners.target), 'utf8'));
      expect(targetMeta.identityAssume).toMatchObject({ hostId: original.hostId, attachmentId: original.attachmentId });
      expect(targetMeta.ptyPid).not.toBe(original.nativePid);
      const runningTargetNative = latestNativeId('target');
      expect(runningTargetNative === targetNative).toBe(mode === 'native-resume');
      // A user namespace may hide locks from the global /proc/locks view.
      // The managed startup child is authoritative; its fdinfo still proves
      // the exact thread flock, as in the launcher's native identity oracle.
      const observedProcesses: Array<{ pid: number; comm: string | null }> = [];
      const processTreeReads: Row[] = [];
      const nativePid = resolveLinuxCodexStartupPid(targetMeta.ptyPid, {
        readDir: new Proxy(readdirSync, { apply(target, receiver, args) {
          try {
            const entries = Reflect.apply(target, receiver, args);
            processTreeReads.push({ path: String(args[0]), entries });
            return entries;
          } catch (error) {
            processTreeReads.push({ path: String(args[0]), error: (error as NodeJS.ErrnoException).code });
            throw error;
          }
        } }),
        readFile: new Proxy(readFileSync, { apply(target, receiver, args) {
          try {
            const value = Reflect.apply(target, receiver, args);
            if (String(args[0]).endsWith('/children'))
              processTreeReads.push({ path: String(args[0]), children: String(value).trim() });
            return value;
          } catch (error) {
            processTreeReads.push({ path: String(args[0]), error: (error as NodeJS.ErrnoException).code });
            throw error;
          }
        } }),
        readCounters(pid: number, read: typeof readFileSync = readFileSync) {
          const counters = readLinuxStartupCounters(pid, read);
          observedProcesses.push({ pid, comm: counters?.comm ?? null });
          return counters;
        },
      });
      const rootExecutable = readlinkSync(`/proc/${targetMeta.ptyPid}/exe`);
      expect(nativePid, JSON.stringify({ ptyPid: targetMeta.ptyPid, rootExecutable,
        rootWriter: codexThreadWriterHolder(homes.target, runningTargetNative, { holderPid: targetMeta.ptyPid }),
        observedProcesses, processTreeReads })).not.toBeNull();
      expect(codexThreadWriterHolder(homes.target, runningTargetNative,
        { holderPid: nativePid })).toMatchObject({ held: true, pid: nativePid });
      const targetEnvironment = readFileSync(`/proc/${nativePid}/environ`, 'utf8').split('\0');
      for (const [key, value] of Object.entries(privateCallerEnv)) {
        // The host deliberately recomputes this carrier from the target's
        // resume argv. Reject the caller value while accepting that new pin.
        if (key === 'PAPERCUSP_NATIVE_SESSION_ID') {
          const carrier = targetEnvironment.find(entry => entry.startsWith(key + '='));
          expect(carrier === undefined || carrier === `${key}=${runningTargetNative}`).toBe(true);
        } else expect(targetEnvironment.some(entry => entry.startsWith(key + '='))).toBe(false);
        expect(targetEnvironment.join('\n')).not.toContain(value);
      }
      const targetInput = requests.filter(row => row.phase === 'target' && row.actor === 'target' &&
        !JSON.stringify(row.body).includes('LATE_NATIVE_OUTPUT')).map(row => JSON.stringify(row.body)).join('\n');
      expect(targetInput).not.toContain(marker.caller);
      for (const value of Object.values(privateCallerEnv)) expect(targetInput).not.toContain(value);
      expect(targetInput.includes(marker.target)).toBe(mode === 'native-resume');
      expect(targetInput.includes(marker.checkpoint)).toBe(mode === 'checkpoint');
      expect(orders).toHaveLength(1);
      if (real) {
        expect(routed).toHaveLength(1);
        const retained = initialResponsibilities.get(owners.target)!;
        expect(routed[0].responsibilities).toEqual(retained);
        expect(await real.responsibilitySnapshot(owners.target)).toEqual(retained);
        for (const value of [retained.planClaim.planSlug, retained.directives[0].text,
          retained.fleet.slug, retained.subscriptions[0].target]) expect(targetInput).toContain(value);
        expect(routed[0]).toMatchObject({ ownerId: owners.target,
          assignment: { id: targetWork, assignee: owners.target, observedBy: owners.target } });
        expect(routed[0].messages).toHaveLength(2);
        expect(new Set(routed[0].messages.map((row: Row) => row.id)).size).toBe(2);
        expect((await real.pending(owners.caller)).map(row => row.summary)).toEqual(['CALLER_BEFORE_HANDOFF']);
        expect((await real.probe(owners.target, targetWork)).messages).toEqual([]);
        const after = await real.send(owners.target, 'AFTER_HANDOFF');
        const afterProbe = await real.probe(owners.target, targetWork);
        expect(afterProbe.messages.map(row => row.id)).toEqual([after.msg_id]);
        expect(afterProbe.responsibilities).toEqual(retained);
        expect((await real.load(accepted!.preparation))?.state).toBe('handoff-accepted');
        expect((await real.pause(owners.caller))?.transitionKey).toBe(accepted!.transitionKey);
        expect((await real.commit(accepted!.preparation)).replayed).toBe(true);
        expect(orders).toHaveLength(1);
        const binding = await real.resolve(accepted!.preparation.target.advSessionId);
        expect(binding?.sessionId).toBe(runningTargetNative);
        const writer = codexThreadWriterHolder(homes.target, runningTargetNative, { holderPid: nativePid });
        // The npm Codex launcher can parent a different native lock holder.
        // Use the maintained exact startup-process oracle, not a loose scan.
        expect(codexNativeIdForPty(homes.target, targetMeta.ptyPid)).toBe(runningTargetNative);
        expect(writer.pid).not.toBeNull();
        const message = routed[0].messages[0];
        const observation: AssumeExecutionObservation = {
          transitionKey: accepted!.transitionKey, observedAt: Date.now(),
          hostId: targetMeta.identityAssume.hostId, attachmentId: targetMeta.identityAssume.attachmentId,
          callerNativePid: original.nativePid, callerExited: alive(original.nativePid) === false,
          targetOwnerId: routed[0].ownerId, targetNativeSessionId: runningTargetNative,
          backend: 'codex', contextSha256: accepted!.preparation.target.context.sha256,
          nativePid: writer.pid!, nativeProcessStart: readProcessIdentity(writer.pid!)!,
          ptyPid: targetMeta.ptyPid, ptyProcessStart: readProcessIdentity(targetMeta.ptyPid)!,
          nativeWriterPids: writer.held && writer.pid ? [writer.pid] : [],
          ...(mode === 'checkpoint' ? { nativeBinding: {
            advSessionId: binding!.id, ownerId: binding!.coordOwnerId!, sourceNativeSessionId: targetNative,
            nativeSessionId: binding!.sessionId!, transitionKey: accepted!.transitionKey,
          } } : {}),
          directedMessage: { id: message.id, recipient: message.to[0], consumedBy: routed[0].ownerId, consumptions: 1 },
          assignment: routed[0].assignment,
        };
        // These counterexamples must leave the persisted accepted receipt unchanged.
        for (const changed of [
          { ...observation, hostId: 'unrelated-host' },
          { ...observation, nativeWriterPids: [targetMeta.ptyPid, process.pid] },
          { ...observation, callerExited: false },
          { ...observation, targetOwnerId: owners.caller },
          { ...observation, contextSha256: hash('wrong-context') },
        ]) {
          expect((await real.verify(accepted! as any, changed)).state).toBe('handoff-accepted');
          expect((await real.load(accepted!.preparation))?.state).toBe('handoff-accepted');
        }
        expect((await real.verify(accepted! as any, observation)).state).toBe('target-verified');
        const history = await real.sql<Array<{ body: Row }>>`
          SELECT body FROM harness_shared.coord_event_log
          WHERE workspace_id = 'native-context-fixture'
            AND body #>> '{sessionAssume,transitionKey}' = ${accepted!.transitionKey}
          ORDER BY body ->> 'ts', body ->> 'msg_id'`;
        const verified = history.filter(row => row.body.sessionAssume.state === 'target-verified');
        expect(verified).toHaveLength(1);
        expect(verified[0].body).toMatchObject({ from: owners.caller, category: 'session-assume-audit',
          sessionAssume: { preparation: accepted!.preparation, observation } });
        for (const secret of Object.values(privateCallerEnv))
          expect(JSON.stringify(history)).not.toContain(secret);
        if (contended) {
          const loser = race.find(row => row.receipt.state === 'refused')!;
          expect(await real.commit(loser.receipt.preparation)).toMatchObject({ state: 'refused', replayed: true });
          expect(orders).toHaveLength(1);
          expect(codexThreadWriterHolder(homes.target, runningTargetNative, { holderPid: nativePid }).pid).toBe(writer.pid);
        }
      }
      if (channelControls) {
        const submit = async (text: string) => {
          for (const step of controlWritesForAgent({ mode: 'turn', data: text }, 'codex', {})) {
            if (step.delayMs) await new Promise(resolve => setTimeout(resolve, step.delayMs));
            if (!alive(targetMeta.ptyPid)) return;
            targetRun.signals.emit('input', step.data);
          }
        };
        releaseTarget();
        await vi.waitFor(() => expect(output, diagnostics()).toContain('TARGET_CHANNEL_READY'), { timeout: 10_000 });
        targetRun.signals.emit('resize', 147, 53);
        const tty = readlinkSync(`/proc/${nativePid}/fd/0`);
        expect(tty).toMatch(/^\/dev\/pts\/\d+$/);
        await vi.waitFor(() => expect(execFileSync('stty', ['-F', tty, 'size'], { encoding: 'utf8' }).trim())
          .toBe('53 147'), { timeout: 5000 });
        await submit(marker.channelInput);
        await vi.waitFor(() => expect(output, diagnostics()).toContain(marker.channelResponse), { timeout: 10_000 });
        expect(transcript('target', runningTargetNative)).toContain(marker.channelInput);
        expect(alive(original.nativePid)).toBe(false);
        await submit(marker.channelHold);
        await vi.waitFor(() => expect(controlRequested, diagnostics()).toBe(true), { timeout: 10_000 });
        targetRun.signals.emit('input', '\x03');
        await vi.waitFor(() => expect(transcript('target', runningTargetNative)).toContain('"type":"turn_aborted"'),
          { timeout: 10_000 });
        expect(alive(targetMeta.ptyPid)).toBe(true);
        await submit('/exit');
        await vi.waitFor(() => expect(alive(targetMeta.ptyPid), diagnostics()).toBe(false), { timeout: 10_000 });
        expect(await targetRun.done).toBe(0);
        expect(orders).toHaveLength(1);
        return;
      }
      releaseTarget();
      await vi.waitFor(() => expect(alive(targetMeta.ptyPid), diagnostics()).toBe(false), { timeout: 10_000 });
      milestone('E-target-native-exit-after-completion', { nativeSessionId: runningTargetNative,
        transcript: transcript('target', runningTargetNative),
        events: existsSync(eventLogPathForOwner(owners.target))
          ? readFileSync(eventLogPathForOwner(owners.target), 'utf8') : null });
      expect(await targetRun.done).toBe(75);
      expect(orders).toHaveLength(2); expect(alive(targetMeta.ptyPid)).toBe(false);
      if (real) {
        const consumed = readHostHandoffForParentPid(process.pid, { ownerId: owners.target });
        expect(consumed).not.toBeNull(); orders[1] = consumed;
        expect(alive(orders[1].fromPid)).toBe(false);
        await real.depart(owners.target);
      }
      phase = 'return'; issued = false;
      const returned = await launch(orders[1]);
      await vi.waitFor(() => expect(output, diagnostics()).toContain('CALLER_RETURNED'), { timeout: 20_000 });
      const returnMeta = JSON.parse(readFileSync(metaPathFor(owners.caller), 'utf8'));
      expect(returnMeta.identityAssume).toMatchObject({ hostId: original.hostId, attachmentId: original.attachmentId });
      expect(latestNativeId('caller')).toBe(callerNative);
      expect(requests.filter(row => row.phase === 'return').some(row => JSON.stringify(row.body).includes(marker.caller))).toBe(true);
      expect(transcript('caller', callerNative)).toContain('CALLER_RETURNED');
      if (real) {
        const originalReceipt = await real.load(accepted!.preparation);
        expect(originalReceipt?.callerReturn?.transitionKey).toBe(returning!.transitionKey);
        expect(await real.pause(owners.caller)).toBeNull();
        const restored = await real.probe(owners.caller, callerWork);
        expect(restored.responsibilities).toEqual(initialResponsibilities.get(owners.caller));
        expect(restored.assignment).toMatchObject({ assignee: owners.caller, observedBy: owners.caller });
        expect(restored.messages).toHaveLength(1);
        expect((await real.probe(owners.caller, callerWork)).messages).toEqual([]);
        expect((await real.commit(returning!.preparation)).replayed).toBe(true);
        expect(orders).toHaveLength(2);
      }
      if (returnControls) {
        const submit = async (text: string) => {
          for (const step of controlWritesForAgent({ mode: 'turn', data: text }, 'codex', {})) {
            if (step.delayMs) await new Promise(resolve => setTimeout(resolve, step.delayMs));
            expect(alive(returnMeta.ptyPid)).toBe(true);
            returned.signals.emit('input', step.data);
          }
        };
        expect(returnMeta.ptyPid).not.toBe(original.nativePid);
        expect(returnMeta.ptyPid).not.toBe(targetMeta.ptyPid);
        expect(alive(original.nativePid)).toBe(false);
        expect(alive(targetMeta.ptyPid)).toBe(false);
        returned.signals.emit('resize', 131, 47);
        const returnPid = resolveLinuxCodexStartupPid(returnMeta.ptyPid)!;
        expect(returnPid).not.toBeNull();
        expect(codexThreadWriterHolder(homes.caller, callerNative, { holderPid: returnPid }))
          .toMatchObject({ held: true, pid: returnPid });
        const tty = readlinkSync(`/proc/${returnPid}/fd/0`);
        expect(tty).toMatch(/^\/dev\/pts\/\d+$/);
        await vi.waitFor(() => expect(execFileSync('stty', ['-F', tty, 'size'], { encoding: 'utf8' }).trim())
          .toBe('47 131'), { timeout: 5000 });
        await submit(marker.returnInput);
        await vi.waitFor(() => expect(output, diagnostics()).toContain(marker.returnResponse), { timeout: 10_000 });
        expect(transcript('caller', callerNative)).toContain(marker.returnInput);
        expect(transcript('target', runningTargetNative)).not.toContain(marker.returnInput);
        expect(requests.filter(row => row.phase === 'return' && JSON.stringify(row.body).includes(marker.returnInput))
          .every(row => row.actor === 'caller')).toBe(true);
        await submit(marker.returnHold);
        await vi.waitFor(() => expect(controlRequested, diagnostics()).toBe(true), { timeout: 10_000 });
        returned.signals.emit('input', '\x03');
        await vi.waitFor(() => expect(transcript('caller', callerNative)).toContain('"type":"turn_aborted"'),
          { timeout: 10_000 });
        expect(alive(returnMeta.ptyPid)).toBe(true);
        await submit('/exit');
        await vi.waitFor(() => expect(alive(returnMeta.ptyPid), diagnostics()).toBe(false), { timeout: 10_000 });
        expect(await returned.done).toBe(0);
        expect(orders).toHaveLength(2);
      }
      expect(errors, diagnostics()).toEqual([]);
      returned.signals.emit('SIGTERM'); await returned.done;
    } catch (error) {
      const artifact = checks.diagnosticProbe?.artifact ?? (process.env.PC_EXECUTED_SOURCE_MAP_OUT
        ? process.env.PC_EXECUTED_SOURCE_MAP_OUT + '.journey-failures.jsonl'
        : join('/tmp', 'assume-native-failure-' + randomUUID() + '.jsonl'));
      // The isolated discovery directory is removed by afterAll. Retain its
      // lifecycle evidence while the failed process is still observable, so a
      // startup or return stall can be diagnosed without repeating the journey.
      const hostEvidence = Object.values(owners).map(owner => {
        try {
          let meta: Row | null = null;
          try { meta = JSON.parse(readFileSync(metaPathFor(owner), 'utf8')); } catch { /* not spawned */ }
          const eventsPath = eventLogPathForOwner(owner);
          const events = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').trim().split('\n')
            .filter(Boolean).map(line => JSON.parse(line)) : [];
          const ptyPid = Number.isInteger(meta?.ptyPid) ? meta!.ptyPid as number : null;
          const nativePid = ptyPid ? resolveLinuxCodexStartupPid(ptyPid) : null;
          return { owner, ptyPid, ptyAlive: ptyPid ? alive(ptyPid) : null,
            nativeSessionId: meta?.nativeSessionId ?? null, nativePid,
            nativeProcessStart: nativePid ? readProcessIdentity(nativePid) : null,
            startupCounters: nativePid ? readLinuxStartupCounters(nativePid) : null, events };
        } catch (evidenceError) { return { owner, evidenceError: String(evidenceError) }; }
      });
      // A PTY counter cannot tell which native startup dependency is pending,
      // or whether a returned tool call was persisted. Keep the isolated native
      // log and transcripts before the finally block deletes their homes.
      const nativeEvidence = Object.entries(homes).map(([actor, home]) => {
        try {
          const sessions = join(home, 'sessions');
          const transcripts = existsSync(sessions) ? readdirSync(sessions, { recursive: true })
            .map(String).filter(path => path.endsWith('.jsonl')).map(path => {
              const text = readFileSync(join(sessions, path), 'utf8');
              return { path, sha256: hash(text), text };
            }) : [];
          return { actor, log: readCodexTuiLogTail(home), transcripts };
        } catch (evidenceError) { return { actor, evidenceError: String(evidenceError) }; }
      });
      appendFileSync(artifact, JSON.stringify({ mode, production, contended, preflight, crashRecovery, returnControls, checks, crashBoundaries,
        diagnostics: JSON.parse(diagnostics()), hostEvidence, nativeEvidence,
        providerRequests: requests, productionTrace: real?.trace,
        returnReceipt: returning, error: String(error),
        errorStack: error instanceof Error ? error.stack : undefined }) + '\n');
      // console.error is itself an assertion under fail-on-console and would
      // replace the original failure/stack before the rethrow below can run.
      process.stderr.write('Native journey failure evidence: ' + artifact + '\n');
      throw error;
    } finally {
      releaseCallerCompletion(); releaseStartupCrash();
      releaseCallers();
      releaseControl();
      releaseTarget(); for (const run of runs) run.signals.emit('SIGTERM');
      await Promise.allSettled(runs.map(run => run.done));
      await Promise.allSettled(hosts.map(host => host.close()));
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      await real?.dispose(); productionState.sql = undefined; productionState.homes.clear();
      rmSync(root, { recursive: true, force: true });
    }
}

it('preserves the original native failure and startup evidence after fixture cleanup', context => nativeRuntimeCase(context, async () => {
  const directory = mkdtempSync('/tmp/assume-native-diagnostic-guard-');
  const artifact = join(directory, 'failure.jsonl');
  const error = new Error('Controlled native diagnostic failure');
  try {
    await expect(nativeJourney('native-resume', false, false, false, false, false, false,
      { diagnosticProbe: { error, artifact } })).rejects.toBe(error);
    const evidence = JSON.parse(readFileSync(artifact, 'utf8'));
    expect(evidence.errorStack).toBe(error.stack);
    expect(evidence.diagnostics.phase).toBe('seed');
    const target = evidence.nativeEvidence.find((entry: Row) => entry.actor === 'target');
    // The installed client may never create a TUI log. Its explicit absence
    // is evidence too; native transcript preservation remains mandatory.
    expect(target.log.path).toBeTypeOf('string');
    expect(target.log.present).toBeTypeOf('boolean');
    expect(existsSync(target.log.path)).toBe(false);
    expect(target.transcripts).toHaveLength(1);
    const metadata = JSON.parse(target.transcripts[0].text.split('\n')[0]);
    expect(metadata.type).toBe('session_meta');
    expect(existsSync(metadata.payload.cwd)).toBe(false);
    expect(evidence.providerRequests.some((request: Row) => request.phase === 'seed')).toBe(true);
    expect(evidence.hostEvidence.some((host: Row) => host.ptyAlive === true)).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}), nativeRuntimeOptions.testTimeoutMs);

for (const mode of ['native-resume', 'checkpoint'] as const) {
  it(`resumes installed native target context and returns the caller on the same managed attachment (${mode})`,
    context => nativeRuntimeJourney(context, mode), nativeRuntimeOptions.testTimeoutMs);
  it(`uses production custody and routed responsibilities through the installed native handoff (${mode})`,
    context => nativeRuntimeJourney(context, mode, true), nativeRuntimeOptions.testTimeoutMs);
}

it('admits exactly one of two installed native callers and preserves the losing caller responsibilities',
  context => nativeRuntimeJourney(context, 'native-resume', true, true), nativeRuntimeOptions.testTimeoutMs);

it('routes installed native target input output resize interrupt and exit through the inherited managed channel',
  context => nativeRuntimeJourney(context, 'native-resume', true, false, false, true), nativeRuntimeOptions.testTimeoutMs);

it('previews one exact ended target without writes and refuses live, foreign and unknown custody',
  context => nativeRuntimeJourney(context, 'native-resume', true, false, true), nativeRuntimeOptions.testTimeoutMs);

it('R-8 recovers persisted native handoff after managed host SIGKILL before target execution',
  context => nativeRuntimeJourney(context, 'native-resume', true, false, false, false, true), nativeRuntimeOptions.testTimeoutMs);

it('R-5 exact caller return restores input output resize interrupt and exit on the original pane',
  context => nativeRuntimeJourney(context, 'native-resume', true, false, false, false, false, true), nativeRuntimeOptions.testTimeoutMs);

it('R-1 delivers the invoking native tool response before fresh completion permits caller replacement',
  context => nativeRuntimeJourney(context, 'native-resume', true, false, false, false, false, false,
    { responseOrdering: true }), nativeRuntimeOptions.testTimeoutMs);

it('R-8 recovers after target native writer acquisition and managed host SIGKILL before verification',
  context => nativeRuntimeJourney(context, 'native-resume', true, false, false, false, false, false,
    { crashAfterStartup: true }), nativeRuntimeOptions.testTimeoutMs);
