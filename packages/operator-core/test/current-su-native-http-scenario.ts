/** Runs only inside with-test-pg's credential-free private operator profile. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';
import type { PapercuspUnifiedToolContext } from '../lib/agent-tools/_tool-context';
import { currentSuBenchHarnessDriver, liveCurrentSuBenchPorts, currentBenchAssignmentId, currentBenchGatewayController } from '../lib/external-bench/current-su';
import { liveBenchHarnessOps } from '../lib/external-bench/bench-harness-live';
import { retainIsolatedNativeTaskDiagnostics, retainIsolatedWorkerProgress } from './isolated-integration-proof';
import { psuLaunchLogPath } from '../lib/psu-launch-log.mjs';
import { startFrontierSweLaunchAdapter } from '../lib/external-bench/frontier-swe-launch-adapter';
import { startCodexHookBridge, type CodexHookBridge } from '../lib/external-bench/codex-hook-bridge';
import { startBenchEgress, sweepBenchEgress } from '../lib/external-bench/bench-egress';
import type { FrontierSweEnvHandle } from '../lib/external-bench/frontier-swe-seam';
import { currentProtocolFixture } from '../lib/external-bench/reproducibility/_protocol-test-fixture';
import { preregister } from '../lib/external-bench/reproducibility/prereg';
import { getModes } from '../lib/modes/store';
import { readSessionConfinement } from '../lib/capability-envelope/session-confinement-store';
import { emptyPool, registerAccount } from '../lib/deployment/account-pool';
import { loadAccountPool, updateAccountPool } from '../lib/deployment/account-pool-store';

/** Seed only the disposable private pool before its operator boots. The
 * credential is deliberately invalid; inference still terminates at the local
 * refusal listener and authenticateProvider below can never forward it. */
export async function prepareCurrentSuNativeScenario(workspace: string) {
  assert.match(workspace, /^test-runtime-/);
  assert.equal(process.env.PAPERCUSP_WORKSPACE_ID, workspace);
  // ports.launch executes in this worker, independently of the private HTTP
  // host's environment. The installed psu shim otherwise chooses release.
  const launcher = resolve(import.meta.dirname, '../../../apps/operator/scripts/psu-launcher.mjs');
  assert.ok(existsSync(launcher), 'current-build psu launcher missing');
  process.env.PAPERCUSP_PSU_LAUNCHER = launcher;
  const home = join(process.env.HOME!, '.private-current-su-codex');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt',
    tokens: { access_token: randomUUID(), account_id: 'private-current-su' } }), { mode: 0o600 });
  const account = { id: 'private-current-su', provider: 'codex' as const, credentialRef: `codex-cli:${home}` };
  await updateAccountPool(() => registerAccount(emptyPool(), account, Date.now()), workspace);
  const pool = await loadAccountPool(workspace);
  assert.deepEqual(pool.accounts.map(row => ({ id: row.id, provider: row.provider, credentialRef: row.credentialRef })), [account]);
  process.env.PAPERCUSP_MCP_PROXY = '0';
}

export async function measureCurrentSuNativeScenario(input: { workspace: string; base: string; evidenceDir: string }) {
  const { workspace, base, evidenceDir } = input;
  assert.match(workspace, /^test-runtime-/);
  assert.equal(process.env.PAPERCUSP_WORKSPACE_ID, workspace);
  assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(process.env.PAPERCUSP_DBOS_ENABLE, '0');
  assert.ok(![3070, 3170, 3271, 9071].includes(Number(new URL(base).port)));
  for (const image of ['alpine', 'nginx:alpine']) execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore', timeout: 30000 });
  // Prevent psu from substituting an ambient operator proxy for the private API.
  process.env.PAPERCUSP_MCP_PROXY = '0';
  const { sql } = getOrgPg();
  const repoRoot = join(evidenceDir, 'protocol'), checkout = join(evidenceDir, 'observer-checkout');
  mkdirSync(repoRoot); mkdirSync(checkout);
  const config = currentProtocolFixture(`PRIVATE-CURRENT-SU-${randomUUID()}`, 180000);
  for (const arm of config.arms) { arm.model = 'gpt-6-luna'; arm.effort = 'max'; }
  config.priceSchedule.rates[0].model = 'gpt-6-luna';
  const snapshot = JSON.stringify({ entries: [{ key: 'permitted:private-native', text: 'Frozen local lifecycle context.' }] });
  for (const name of ['corpus', 'memory']) writeFileSync(join(repoRoot, `${name}.json`), snapshot);
  config.context = { ...config.context, corpusRef: 'corpus.json', memoryRef: 'memory.json',
    corpusHash: createHash('sha256').update(snapshot).digest('hex'), memoryHash: createHash('sha256').update(snapshot).digest('hex') };
  const frozen = await preregister({ workspaceId: workspace, sql, runId: config.runId, suites: [], config, repoRoot });
  // Commit only the immutable private protocol, never the shared checkout.
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: repoRoot });
  const protocolBytes = readFileSync(frozen.absFilePath, 'utf8');
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repoRoot,
    input: `blob\nmark :1\ndata ${Buffer.byteLength(protocolBytes)}\n${protocolBytes}\ncommit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1577836800 +0000\ndata 6\nfrozen\nM 100644 :1 ${frozen.filePath}\n\ndone\n` });
  const bodies: Array<Record<string, unknown>> = [];
  const requests: Array<{ method?: string; path?: string; at: string }> = [];
  const progress = (stage: string, evidence: Record<string, unknown> = {}) =>
    retainIsolatedWorkerProgress(evidenceDir, stage, evidence);
  let observedAuto = false;
  let nativeDiagnosticsAt = 0;
  // This service has no provider credential, response generator or forwarding path.
  const listener = createServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url, at: new Date().toISOString() });
    progress('model-transport-request', { request: requests.at(-1), modelRequests: bodies.length });
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.url?.endsWith('/responses')) {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const sessions = await sql`SELECT coord_owner_id FROM harness_shared.adv_sessions WHERE workspace_id=${workspace}`;
      if (sessions.length === 1) observedAuto = (await getModes(workspace, sessions[0].coord_owner_id)).some(mode => mode.mode === 'auto');
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Private current-su no-forwarding lifecycle fixture.' } }));
  });
  await new Promise<void>((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done); });
  const port = (listener.address() as { port: number }).port;
  const assignmentId = currentBenchAssignmentId(config.runId, 'papercusp', 't1', 1);
  const controller = currentBenchGatewayController({ workspaceId: workspace, loopId: 'private-current-su-loop',
    token: 'a'.repeat(64), preregHash: frozen.preregHash, protocol: config, armId: 'papercusp', taskId: 't1', seed: 1,
    resources: { inputTokens: 100000, outputTokens: 1000, requestsPerArm: 50, usdPerArm: 3, maxOpenUsd: 3,
      wallClockMs: 360000, wallClockMsPerArm: 180000,
      armIds: config.arms.map(arm => currentBenchAssignmentId(config.runId, arm.id, 't1', 1)) },
    authenticateProvider: async () => { throw new Error('Provider authentication is forbidden in the private fixture'); } });
  const hosted = await controller.startNativeGateway(() => {}, async () => ({ port, stop: async () => {
    listener.closeAllConnections(); await new Promise<void>(done => listener.close(() => done()));
  } } as never));
  const ctx = { workspaceId: workspace, isSuperuser: true, uiClientId: `su-private-native-${randomUUID()}`,
    principal: { slug: 'system:superuser' } } as PapercuspUnifiedToolContext;
  const phase = (name: string) => { progress(name); console.log('CURRENT_SU_NATIVE_PHASE ' + name); };
  let adapter: Awaited<ReturnType<typeof startFrontierSweLaunchAdapter>> | undefined;
  let bridge: CodexHookBridge | undefined;
  let handle: FrontierSweEnvHandle | undefined;
  try {
    phase('adapter-start');
    adapter = await startFrontierSweLaunchAdapter({ runId: config.runId, context: ctx, mcpOrigin: base,
      hookRecordDir: join(evidenceDir, 'private-hook-records'),
      seam: { version: 'private-lifecycle', extraRunArgs: ['--workdir', '/app'] },
      startAssignment: async () => { phase('assignment-start'); return {
        options: { workspaceId: workspace, runId: config.runId, armId: 'papercusp', seed: 1,
          agent: 'codex', model: 'gpt-6-luna', effort: 'max', account: 'auto', pollIntervalMs: 100,
          driveTimeoutMs: 180000, preregistration: { config, preregHash: frozen.preregHash, repoRoot } },
        observations: { ...hosted, admit: async () => ({ admitted: true, receiptRef: 'private-no-spend-admission' }),
          observeIdentity: async () => null },
        checkout: { dir: checkout, repo: 'fixture/private', baseCommit: 'fixture', cleanup: async () => {} },
        generationBudget: config.arms[0].generationBudget, readModelCalls: async () => bodies.length,
        stop: async () => { await hosted.stop(); },
      }; },
    }, {
      startBridge: async options => { phase('bridge-start'); bridge = await startCodexHookBridge(options); phase('bridge-ready'); return bridge; },
      startEgress: async options => { phase('egress-start'); const egress = await startBenchEgress(options); phase('egress-ready'); return egress; },
      sweep: sweepBenchEgress,
      createDriver: (options, context, observations) => {
        phase('driver-start');
        const ports = liveCurrentSuBenchPorts(context, observations, options);
        return currentSuBenchHarnessDriver(liveBenchHarnessOps(options), { ...ports,
          launch: async args => {
            phase('launch-start');
            try { const receipt = await ports.launch(args); progress('launch-returned', { receipt }); return receipt; }
            catch (error) { progress('launch-failed', { error: String(error) }); throw error; }
          },
          getTask: async id => {
            const task = await ports.getTask(id);
            if (task && Date.now() - nativeDiagnosticsAt >= 1000) {
              nativeDiagnosticsAt = Date.now();
              const logPath = 'logPath' in task && typeof task.logPath === 'string' ? task.logPath : undefined;
              const boot = typeof task.detail.coordOwnerId === 'string'
                ? psuLaunchLogPath(task.detail.coordOwnerId, { home: process.env.HOME }) : null;
              retainIsolatedNativeTaskDiagnostics(evidenceDir, { taskId: task.taskId,
                workspaceId: task.workspaceId, state: task.state, sessionId: task.sessionId,
                exitCode: task.exitCode, ownerId: task.detail.coordOwnerId }, {
                ...(logPath ? { stdout: logPath, normalized: logPath.replace(/\.log$/, '.normalized.log') } : {}),
                ...(boot ? { boot } : {}),
              });
            }
            progress('task-observed', { task: task && { taskId: task.taskId, workspaceId: task.workspaceId,
              sessionId: task.sessionId, state: task.state, exitCode: task.exitCode,
              ownerId: task.detail.coordOwnerId, label: task.detail.label, nativeStreamError: task.detail.nativeStreamError } });
            return task;
          },
          readIdentity: async task => { const identity = await ports.readIdentity(task); progress('identity-observed', { taskId: task.taskId, measured: !!identity }); return identity; },
        }, options);
      },
    });
    const task = { benchmark: 'frontier-swe' as const, instanceId: 't1',
      problemStatement: 'Report the private lifecycle task status.',
      graderMeta: { dockerImage: 'alpine', gpus: 0, networkMode: 'no-network' } };
    phase('clone-start');
    handle = await adapter.seam.clone(task);
    phase('clone-ready');
    phase('native-start');
    const output = await adapter.runAgent({ task, handle, role: 'worker', arm: 'papercusp', teamKey: 'private-native',
      topic: '', directive: '', forbidTools: [], attemptBudget: { maxCostUsd: 3, maxTokens: 100000, maxWallMs: 180000 } });
    writeFileSync(join(evidenceDir, 'native-result.json'), JSON.stringify({ output, requests }));
    phase('native-ended');
    const rows = await sql`SELECT a.id, a.coord_owner_id, a.session_id, a.ended_at,
      t.task_id, t.state AS task_state, t.ended_at AS task_ended_at
      FROM harness_shared.adv_sessions a JOIN harness_shared.task_ledger t
        ON t.workspace_id=a.workspace_id AND t.detail->>'coordOwnerId'=a.coord_owner_id AND t.session_id=a.session_id
      WHERE a.workspace_id=${workspace}`;
    const diagnostic = JSON.stringify({ output, requests, rows });
    assert.ok(bodies.length > 0, diagnostic);
    assert.equal(rows.length, 1, diagnostic);
    const row = rows[0];
    assert.match(row.session_id, /^[0-9a-f-]{36}$/i);
    assert.ok(row.ended_at && row.task_ended_at, diagnostic);
    const home = codexHomeForSessionKey(row.id);
    const toml = readFileSync(join(home, 'config.toml'), 'utf8');
    const hooks = readFileSync(join(home, 'hooks.json'), 'utf8');
    const instructions = readFileSync(join(home, 'AGENTS.md'), 'utf8');
    assert.ok(toml.includes(adapter.egress.originFor('gw')) && toml.includes(adapter.egress.originFor('mcp')), toml);
    assert.ok(!toml.includes(`http://127.0.0.1:${port}`) && !toml.includes(base), toml);
    assert.ok(hooks.includes(adapter.egress.originFor('hooks')) && hooks.includes('/opt/papercusp/hook-shim'), hooks);
    assert.ok(instructions.includes('Papercusp') || instructions.includes('papercusp'), 'native su instructions missing');
    const request = JSON.stringify(bodies[0]);
    assert.ok(request.includes('<cwd>/app</cwd>'), diagnostic);
    assert.ok(!request.includes(checkout), 'observer checkout leaked into native request');
    assert.equal(bodies[0].model, 'gpt-6-luna');
    assert.ok(observedAuto, 'AUTO was not registered at the first native generation request');
    const confinement = await readSessionConfinement(row.coord_owner_id, workspace);
    assert.ok(confinement, 'native session has no host confinement');
    assert.ok(JSON.stringify(confinement).includes(assignmentId), 'assignment confinement missing');
    assert.deepEqual(confinement.denyOutside, ['coord:whoami', 'work_items:get', 'work_items:checkpoint', 'work_items:complete']);
    assert.equal(confinement.denyAmbientContext, true);
    assert.ok(bridge!.stats().calls > 0 && bridge!.stats().pings > 0, JSON.stringify(bridge!.stats()));
    assert.notEqual(output.status, 'completed', diagnostic);
    assert.ok(adapter.egress.stats().gw.connections > 0 && adapter.egress.stats().mcp.connections > 0);
    return { workspace, assignmentId, nativeSessionId: row.session_id, nativeTaskId: row.task_id,
      modelRequests: bodies.length, providerForwarding: false, autoRegistered: true, hooksBridged: true,
      containerWorkdir: '/app', mcpConfined: true, status: output.status };
  } finally {
    if (handle && adapter) await adapter.seam.teardown(handle);
    if (adapter) assert.deepEqual((await adapter.stop()).errors, []);
    await hosted.stop();
  }
}
