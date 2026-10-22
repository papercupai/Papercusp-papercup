/** Runs only inside with-test-pg's credential-free private operator profile. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';
import { eventLogPathForOwner } from '../../../apps/operator/scripts/psu-pty-host.mjs';
import type { PapercuspUnifiedToolContext } from '../lib/agent-tools/_tool-context';
import { currentSuBenchHarnessDriver, liveCurrentSuBenchPorts, currentBenchAssignmentId, currentBenchGatewayController, type CurrentBenchTask } from '../lib/external-bench/current-su';
import { liveBenchHarnessOps } from '../lib/external-bench/bench-harness-live';
import { retainIsolatedNativeTaskDiagnostics, retainIsolatedWorkerProgress, withIsolatedNativeLaunchDiagnostics } from './isolated-integration-proof';
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
import { installClaudeHooks, installInjectionHooks } from '../lib/desktop-install/papercusp-files';
import { isValidSuperuserBearer, readSuperuserToken, superuserTokenPath } from '../lib/superuser-token';
import { createCurrentSuNativeProtocol, guardedCurrentSuNativeHandler } from './current-su-native-http-protocol';

/** Seed only the disposable private pool before its operator boots. The
 * credential is deliberately invalid; inference still terminates at the local
 * refusal listener and authenticateProvider below can never forward it. */
export async function prepareCurrentSuNativeScenario(workspace: string) {
  assert.match(workspace, /^test-runtime-/);
  assert.equal(process.env.PAPERCUSP_WORKSPACE_ID, workspace);
  // The normal desktop bootstrap installs these executable assets. The
  // disposable runtime starts with an empty HOME, so install the same pinned
  // sources there before the native launcher writes its per-session hooks.
  const privateHome = process.env.HOME!;
  assert.equal(process.env.PAPERCUSP_HOME, join(privateHome, '.papercusp'));
  // The desktop installer normally provisions this bearer. Bootstrap reads it
  // before rendering the native MCP config, so the empty disposable home must
  // receive its own token before either the private operator or launcher boots.
  mkdirSync(process.env.PAPERCUSP_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(superuserTokenPath(), randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
  assert.ok(isValidSuperuserBearer(readSuperuserToken()), 'private native MCP bearer preparation failed');
  const hookSources = resolve(import.meta.dirname, '../../../apps/operator/scripts/hooks');
  const ccHooks = await installClaudeHooks(privateHome, join(hookSources, 'cc'));
  const injectionHooks = await installInjectionHooks(privateHome, join(hookSources, 'inject'));
  for (const name of ['pretooluse-locks-acquire.sh', 'posttooluse-locks-release.sh', 'lifecycle-report.sh'])
    assert.ok(ccHooks.installed.includes(name), 'private native hook installation missing ' + name);
  assert.ok(injectionHooks.includes(join('inject', 'index.mjs')), 'private native injection dispatcher missing');
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

/** Exercise carry's actual HTTP repair boundary without starting a native CLI. */
export async function measureCurrentSuHomeRepairScenario(input: { workspace: string; base: string }) {
  const { workspace, base } = input;
  const { rebuildSuLaunchArtifact } = await import('../lib/su-persona-render');
  const { composeModePromptSection } = await import('../lib/endpoint-route/routes/agent-mcp/bootstrap-su-shared');
  const { ensureSuCodexHomeConfigAsync } = await import('../lib/role-codex-home');
  const { recordAdvSession, recordSuLaunchSpec } = await import('../lib/adv-sessions');
  const { declareSessionConfinement } = await import('../lib/capability-envelope/session-confinement-store');
  const { setMode } = await import('../lib/modes/store');
  const ownerId = 'su-private-home-repair';
  await setMode({ workspaceId: workspace, ownerId, modeId: 'auto', enabled: true,
    reason: 'private native home repair regression', setBy: ownerId });
  const record = { v: 1 as const, agent: 'codex' as const, workspaceId: workspace, harnessSlug: workspace,
    profile: 'generic' as const, contextSize: 'trimmed' as const, personaTier: 'full' as const, model: 'gpt-6-luna',
    planSlug: null, launchedBy: null, autoMode: true, drainMode: false, loopArmed: false,
    headless: true, fleet: null, stack: [] };
  const rebuilt = await rebuildSuLaunchArtifact({ ownerId, operatorBaseUrl: base, record,
    modeSection: composeModePromptSection(record) });
  const home = await ensureSuCodexHomeConfigAsync({ sessionKey: 1, sid: ownerId,
    mcpUrl: rebuilt.spec.mcpUrl, promptText: rebuilt.promptText, model: record.model,
    token: readSuperuserToken(), headless: true, codexGatewayAuto: true,
    recoverMissingHome: true, trustDir: rebuilt.spec.cwd });
  assert.ok(readFileSync(home.configPath, 'utf8').includes('papercusp-codex-gateway'));
  const advSessionId = await recordAdvSession({ workspaceId: workspace, agent: 'codex', role: 'su',
    mode: 'console', coordOwnerId: ownerId, cwd: rebuilt.spec.cwd,
    launchArgv: ['psu', '--auto', '--account=auto', '--headless', '--model=gpt-6-luna:max'] });
  assert.equal(advSessionId, 1);
  assert.equal(await recordSuLaunchSpec(advSessionId, ownerId, { ...record,
    specificationRevision: rebuilt.artifact.specificationRevision,
    stateRevision: rebuilt.artifact.stateRevision,
    specificationArtifact: rebuilt.artifact.specificationArtifact }), true);
  assert.equal((await declareSessionConfinement({ ownerId, workspaceId: workspace,
    confinement: { denyTools: [], denyOutside: ['coord:whoami', 'session:request-compaction'],
      denyAmbientContext: true, imposedBy: 'private home repair regression',
      reason: 'match the native benchmark context boundary' } })).ok, true);
  const repairHome = () => fetch(base + '/api/adv/sessions/ensure-codex-home', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner: ownerId, advSessionId, model: record.model,
      headless: true, requireGatewayProvider: false }), signal: AbortSignal.timeout(30_000),
  });
  const response = await repairHome();
  const repair = await response.json();
  assert.equal(response.status, 200, JSON.stringify(repair));
  assert.equal(repair.ok, true, JSON.stringify(repair));
  // Match the existing real-seam privacy case: the native container can
  // atomically replace config.toml as root while its host-owned parent survives.
  // Keep the bytes unchanged, so access is the only changed variable.
  const docker = (...args: string[]) => execFileSync('docker', args, { timeout: 30_000, stdio: 'pipe' });
  assert.notEqual(process.getuid?.(), 0, 'the host-unreadable control requires the ordinary host user');
  try {
    docker('run', '--rm', '--pull=never', '--network', 'none',
      '--mount', `type=bind,src=${home.codexHome},dst=/session`, 'alpine', 'sh', '-c',
      'cp /session/config.toml /session/config.next && chmod 600 /session/config.next && mv /session/config.next /session/config.toml');
    assert.equal(statSync(home.configPath).uid, 0);
    assert.equal(statSync(home.configPath).mode & 0o777, 0o600);
    assert.throws(() => readFileSync(home.configPath), { code: 'EACCES' });
    const privateResponse = await repairHome();
    const privateRepair = await privateResponse.json();
    assert.equal(privateResponse.status, 200, JSON.stringify(privateRepair));
    assert.equal(privateRepair.ok, true, JSON.stringify(privateRepair));
    return { status: response.status, privateConfigStatus: privateResponse.status,
      repaired: privateRepair.repaired, providerForwarding: false };
  } finally {
    docker('run', '--rm', '--pull=never', '--network', 'none',
      '--mount', `type=bind,src=${home.codexHome},dst=/session`, 'alpine',
      'chown', `${process.getuid?.()}:${process.getgid?.()}`, '/session/config.toml');
  }
}

export async function measureCurrentSuNativeScenario(input: { workspace: string; base: string; evidenceDir: string; managedCarry?: boolean }) {
  const { workspace, base, evidenceDir, managedCarry = false } = input;
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
  const taskCheckout = join(evidenceDir, 'task-checkout');
  let taskHead: string | undefined;
  const taskGit = (...args: string[]) => execFileSync('git', ['-C', taskCheckout, ...args], { encoding: 'utf8', timeout: 10000 });
  if (managedCarry) {
    mkdirSync(taskCheckout);
    taskGit('init', '-q', '--initial-branch=main');
    execFileSync('git', ['fast-import', '--quiet'], { cwd: taskCheckout,
      input: 'blob\nmark :1\ndata 7\nbefore\n\ncommit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1577836800 +0000\ndata 6\nfrozen\nM 100644 :1 answer.txt\n\ndone\n' });
    taskGit('reset', '--hard', 'HEAD');
    taskHead = taskGit('rev-parse', 'HEAD');
  }
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
  let lastNativeTask: CurrentBenchTask | undefined;
  const retainTaskDiagnostics = async (task: CurrentBenchTask) => {
    lastNativeTask = task;
    const ownerId = typeof task.detail.coordOwnerId === 'string' ? task.detail.coordOwnerId : '';
    const rows = await sql`SELECT id FROM harness_shared.adv_sessions
      WHERE workspace_id=${workspace} AND coord_owner_id=${ownerId}
      ORDER BY id DESC LIMIT 1`;
    const codexHome = rows[0] ? codexHomeForSessionKey(rows[0].id) : undefined;
    const logPath = 'logPath' in task && typeof task.logPath === 'string' ? task.logPath : undefined;
    const boot = typeof task.detail.coordOwnerId === 'string'
      ? psuLaunchLogPath(task.detail.coordOwnerId, { home: process.env.HOME }) : null;
    retainIsolatedNativeTaskDiagnostics(evidenceDir, { taskId: task.taskId,
      workspaceId: task.workspaceId, state: task.state, sessionId: task.sessionId,
      exitCode: task.exitCode, ownerId: task.detail.coordOwnerId, nativeStreamError: task.detail.nativeStreamError,
      exitReason: 'exitReason' in task ? task.exitReason : undefined }, {
      ...(logPath ? { stdout: logPath, normalized: logPath.replace(/\.log$/, '.normalized.log') } : {}),
      ...(boot ? { boot } : {}),
      ...(ownerId ? { 'host-events': eventLogPathForOwner(ownerId) } : {}),
    }, codexHome);
  };
  let predecessor: { ownerId: string; taskId: string; sessionId: string } | undefined;
  let successorId: string | undefined;
  let stoppedAfterCarry = false;
  const protocol = createCurrentSuNativeProtocol();
  // This service has no provider credential or forwarding path. The carry
  // variant supplies fixed protocol output solely to exercise the native host.
  const transport = guardedCurrentSuNativeHandler(async (req, res) => {
    requests.push({ method: req.method, path: req.url, at: new Date().toISOString() });
    progress('model-transport-request', { request: requests.at(-1), modelRequests: bodies.length });
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.url?.endsWith('/responses')) {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      bodies.push(body);
      const sessions = await sql`SELECT coord_owner_id FROM harness_shared.adv_sessions WHERE workspace_id=${workspace}`;
      if (sessions.length === 1) observedAuto = (await getModes(workspace, sessions[0].coord_owner_id)).some(mode => mode.mode === 'auto');
      if (managedCarry) {
        const rows = await sql`SELECT a.id, a.coord_owner_id, a.session_id, t.task_id FROM harness_shared.adv_sessions a
          JOIN harness_shared.task_ledger t ON t.workspace_id=a.workspace_id AND t.detail->>'coordOwnerId'=a.coord_owner_id
          WHERE a.workspace_id=${workspace}`;
        assert.equal(rows.length, 1, JSON.stringify(rows));
        const row = rows[0];
        let wire: string;
        try {
          wire = protocol.respond(body, { predecessorSessionId: row.session_id,
            editApplied: () => readFileSync(join(taskCheckout, 'answer.txt'), 'utf8') === 'after\n' });
          if (protocol.predecessorSessionId && !predecessor) {
            assert.match(protocol.predecessorSessionId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,
              'Managed carry requires the native predecessor bound before compaction');
            predecessor = { ownerId: row.coord_owner_id, taskId: row.task_id, sessionId: protocol.predecessorSessionId };
          }
        } finally {
          // The protocol can fail before launch's readiness promise returns.
          // Retain the CLI's own MCP error at that boundary, independently of
          // task polling, while its exact disposable home still exists.
          retainIsolatedNativeTaskDiagnostics(evidenceDir, { taskId: row.task_id,
            ownerId: row.coord_owner_id, sessionId: row.session_id }, {}, codexHomeForSessionKey(row.id));
          writeFileSync(join(evidenceDir, 'native-model-requests.json'), JSON.stringify(protocol.census, null, 2));
          progress('model-protocol-request', { census: protocol.census.at(-1) });
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(wire);
        return;
      }
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Private current-su no-forwarding lifecycle fixture.' } }));
  }, error => progress('model-handler-failed', { error: String(error) }));
  const listener = createServer(transport.listener);
  await new Promise<void>((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done); });
  const port = (listener.address() as { port: number }).port;
  const assignmentId = currentBenchAssignmentId(config.runId, 'papercusp', 't1', 1);
  const controller = currentBenchGatewayController({ workspaceId: workspace, loopId: 'private-current-su-loop',
    token: 'a'.repeat(64), preregHash: frozen.preregHash, protocol: config, armId: 'papercusp', taskId: 't1', seed: 1,
    resources: { inputTokens: 100000, outputTokens: 1000, requestsPerArm: 50, usdPerArm: 3, maxOpenUsd: 3,
      wallClockMs: 360000, wallClockMsPerArm: 180000,
      armIds: config.arms.map(arm => currentBenchAssignmentId(config.runId, arm.id, 't1', 1)) },
    authenticateProvider: async () => { throw new Error('Provider authentication is forbidden in the private fixture'); } });
  const stopListener = async () => {
    listener.closeAllConnections(); await new Promise<void>(done => listener.close(() => done()));
  };
  const hosted = await controller.startNativeGateway(() => {}, async () => ({ port, stop: stopListener } as never))
    .catch(async error => { await stopListener(); throw error; });
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
      seam: { version: 'private-lifecycle', extraRunArgs: ['--workdir', '/app',
        ...(managedCarry ? ['-v', `${taskCheckout}:/app`] : [])] },
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
            try { return await withIsolatedNativeLaunchDiagnostics(evidenceDir, async () => {
              const receipt = await ports.launch(args); progress('launch-returned', { receipt }); return receipt;
            }, async () => {
              assert.ok(args.label, 'native launch diagnostic scope requires its exact assignment label');
              const tasks = await ports.listTasks({ workspaceId: workspace, labelPrefix: args.label, includeEnded: true, limit: 100 });
              const matching = tasks.filter(task => task.workspaceId === workspace && task.detail.label === args.label);
              progress('launch-diagnostics-observed', { taskIds: matching.map(task => task.taskId) });
              assert.equal(matching.length, 1, 'native launch diagnostics require the single enrolled assignment task');
              await retainTaskDiagnostics(matching[0]);
            }); }
            catch (error) { progress('launch-failed', { error: String(error) }); throw error; }
          },
          getTask: async id => {
            let task = await ports.getTask(id);
            if (managedCarry && protocol.carryInputSeen && predecessor && task?.sessionId && task.sessionId !== predecessor.sessionId && !stoppedAfterCarry) {
              assert.equal(task.detail.coordOwnerId, predecessor.ownerId);
              assert.equal(task.taskId, predecessor.taskId);
              successorId = task.sessionId;
              stoppedAfterCarry = true;
              progress('managed-carry-verified', { ...predecessor, successorId });
              await ports.killTask(id);
              task = await ports.getTask(id);
            }
            if (task && Date.now() - nativeDiagnosticsAt >= 1000) {
              nativeDiagnosticsAt = Date.now();
              await retainTaskDiagnostics(task);
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
    const output = await Promise.race([adapter.runAgent({ task, handle, role: 'worker', arm: 'papercusp', teamKey: 'private-native',
      topic: '', directive: '', forbidTools: [], attemptBudget: { maxCostUsd: 3, maxTokens: 100000, maxWallMs: 180000 } }), transport.failure]);
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
    const configPath = join(home, 'config.toml');
    const beforeHandback = statSync(configPath);
    progress('session-files-before-handback', { uid: beforeHandback.uid, gid: beforeHandback.gid,
      mode: beforeHandback.mode & 0o777, hostUid: process.getuid?.(), hostGid: process.getgid?.() });
    // The native CLI may atomically replace a private config as the container
    // user. The seam owns returning those files to the host before inspection.
    await adapter.seam.teardown(handle);
    handle = undefined;
    const afterHandback = statSync(configPath);
    progress('session-files-after-handback', { uid: afterHandback.uid, gid: afterHandback.gid,
      mode: afterHandback.mode & 0o777 });
    assert.equal(afterHandback.uid, process.getuid?.(), 'native config was not handed back to the host');
    assert.equal(afterHandback.mode & 0o777, beforeHandback.mode & 0o777, 'handback changed private config permissions');
    const toml = readFileSync(configPath, 'utf8');
    const hooks = readFileSync(join(home, 'hooks.json'), 'utf8');
    const instructions = readFileSync(join(home, 'AGENTS.md'), 'utf8');
    assert.ok(toml.includes(adapter.egress.originFor('gw')) && toml.includes(adapter.egress.originFor('mcp')), toml);
    assert.ok(!toml.includes(`http://127.0.0.1:${port}`) && !toml.includes(base), toml);
    assert.ok(hooks.includes(adapter.egress.originFor('hooks')) && hooks.includes('/opt/papercusp/hook-shim'), hooks);
    assert.ok(instructions.includes('Papercusp') || instructions.includes('papercusp'), 'native su instructions missing');
    const firstTaskBody = managedCarry ? protocol.initialBody : bodies[0];
    assert.ok(firstTaskBody, 'No task-driving model request was observed');
    const request = JSON.stringify(firstTaskBody);
    assert.ok(request.includes('<cwd>/app</cwd>'), diagnostic);
    assert.ok(!request.includes(checkout), 'observer checkout leaked into native request');
    assert.equal(firstTaskBody.model, 'gpt-6-luna');
    assert.ok(observedAuto, 'AUTO was not registered at the first native generation request');
    const confinement = await readSessionConfinement(row.coord_owner_id, workspace);
    assert.ok(confinement, 'native session has no host confinement');
    assert.ok(JSON.stringify(confinement).includes(assignmentId), 'assignment confinement missing');
    assert.deepEqual(confinement.denyOutside, ['coord:whoami', 'session:request-compaction', 'work_items:get', 'work_items:checkpoint', 'work_items:complete']);
    assert.equal(confinement.denyAmbientContext, true);
    assert.ok(bridge!.stats().calls > 0 && bridge!.stats().pings > 0, JSON.stringify(bridge!.stats()));
    assert.notEqual(output.status, 'completed', diagnostic);
    assert.ok(adapter.egress.stats().gw.connections > 0 && adapter.egress.stats().mcp.connections > 0);
    let managedCarryReceipt;
    if (managedCarry) {
      assert.ok(protocol.carryRequested && protocol.carryInputSeen && stoppedAfterCarry && successorId && predecessor, diagnostic);
      assert.notEqual(successorId, predecessor.sessionId);
      assert.equal(taskGit('rev-parse', 'HEAD'), taskHead);
      assert.equal(readFileSync(join(taskCheckout, 'answer.txt'), 'utf8'), 'after\n');
      assert.ok(taskGit('diff', '--', 'answer.txt').includes('-before\n+after'));
      managedCarryReceipt = { requested: true, predecessorId: predecessor.sessionId, successorId,
        distinctNativeSession: true, sameOwner: true, sameTask: true, preservedHead: true,
        preservedDiff: true, confinementPreserved: true };
    }
    return { workspace, assignmentId, nativeSessionId: row.session_id, nativeTaskId: row.task_id,
      modelRequests: bodies.length, providerForwarding: false, autoRegistered: true, hooksBridged: true,
      containerWorkdir: '/app', mcpConfined: true, status: output.status,
      ...(managedCarryReceipt ? { managedCarry: managedCarryReceipt } : {}) };
  } finally {
    try { progress('native-cleanup-start', { bridge: bridge?.stats(), egress: adapter?.egress.stats() }); }
    finally {
      try { if (handle && adapter) await adapter.seam.teardown(handle); }
      finally {
        try { if (lastNativeTask) await retainTaskDiagnostics(lastNativeTask); }
        finally {
          try { if (adapter) assert.deepEqual((await adapter.stop()).errors, []); }
          finally { await hosted.stop(); }
        }
      }
    }
    progress('native-cleanup-completed');
  }
}
