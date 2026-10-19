/** Real primary/failover routing proof inside the maintained private HTTP fixture. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseToml } from '@iarna/toml';
import { getOrgPg } from '@papercusp/db-org';
import { loadHarnessRegistry, saveHarnessRegistry } from '../lib/harness-registry';
import { accountStatus, poolVerdictByProvider, updateAccountPool } from '../lib/deployment/account-pool-store';
import { accountProvider } from '../lib/deployment/account-pool';
import { readAgentConfig, writeAgentConfig } from '../lib/agent-config';
import { startGatewayService } from '../lib/inference-gateway/launch';
import { fireLaunchBlueprint } from '../lib/blueprint/launch-blueprint';
import { readProcessIdentity } from '../lib/process-identity';
import { harnessPackageDir, invokeOnceBin, tsxBin } from '../lib/harness-paths';
import { CODEX_SAFE_DEFAULT_MODEL } from '../lib/model-context-budget.mjs';
import { ONE_MILLION_MODEL_ALIASES } from '../lib/inference-gateway/model-aliases';
import { makeCredentialResolver } from '../lib/inference-gateway/credential-store';
import { privateClaudeModelConfig, privateCodexModelConfig, retainPrivateProviderResponse } from './private-http-workspace-preflight';
import { spawnObservedGatewayModel, spawnRouteGatewayModel } from '../lib/fleet/spawn-tree';

// Reuse the maintained launch policy rather than a retired fixture model id.
const [primaryModel, primaryEffort] = CODEX_SAFE_DEFAULT_MODEL.split(':');
const backupModel = ONE_MILLION_MODEL_ALIASES.sonnet;
const backupEffort = 'high';

function descendants(rootPid: number): number[] {
  const parents = new Map<number, number>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      parents.set(Number(name), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
    } catch { /* process exited during the measured snapshot */ }
  }
  const result = [rootPid];
  for (let i = 0; i < result.length; i++) for (const [pid, ppid] of parents) if (ppid === result[i]) result.push(pid);
  return result;
}

async function eventually<T>(read: () => Promise<T | null | undefined>, label: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read(); if (value != null) return value;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Private routing proof did not observe ${label}`);
}

export async function prepareBlueprintAccountRouteScenario(input: { workspace: string; evidenceDir: string }) {
  const { workspace, evidenceDir } = input;
  assert.match(workspace, /^test-runtime-/);
  assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(process.env.PAPERCUSP_DBOS_ENABLE, '0');
  const e = process.env;
  delete e.PAPERCUSP_CODEX_GATEWAY;
  delete e.PAPERCUSP_ACCOUNT_ID;
  e.PAPERCUSP_MCP_PROXY = '0';
  // A private HOME has no development harness symlink. Select the maintained
  // checkout explicitly before the bundled host resolves its sibling invoke.
  const root = resolve(import.meta.dirname, '../../..');
  e.PAPERCUSP_HARNESS_DIR = realpathSync(join(root, 'libs/papercusp/packages/harness'));
  const runtimeInputs = { harness: harnessPackageDir(), invoke: invokeOnceBin(), tsx: tsxBin() };
  for (const [name, path] of Object.entries(runtimeInputs))
    assert.ok(existsSync(path), `private primary preflight requires ${name}: ${path}`);
  assert.ok(runtimeInputs.invoke.startsWith(join(root, 'libs/papercusp/packages/orchestrator/')),
    'primary proof must execute the selected checkout orchestrator');
  assert.ok(runtimeInputs.invoke.endsWith('.ts'), 'current-source proof must not use a stale packaged invoke bundle');
  const source = JSON.parse(readFileSync(e.FGR_R6_ACCOUNT_POOL_REFERENCE_FILE!, 'utf8'));
  const failover = source.mode === 'capacity-failover';
  assert.ok(source.mode === 'primary' || failover, 'explicit primary/failover mode required');
  const launchedBackend = failover ? 'claude-code' : 'codex';
  const launchedModel = failover ? backupModel : primaryModel;
  const launchedEffort = failover ? backupEffort : primaryEffort;
  assert.ok(source.accounts.length > 0, 'private pool requires real configured account references');
  for (const account of source.accounts.filter((row: any) => accountProvider(row) === 'claude'))
    makeCredentialResolver(account.credentialRef);
  // Inject only private persisted capacity facts. Production accountStatus,
  // resolved-route filtering and ordered preflight make the actual decision.
  // The original source headroom snapshot remains separately recorded below.
  const injectedAt = Date.now();
  await updateAccountPool(() => ({ accounts: source.accounts.map((account: any) => failover && accountProvider(account) === 'codex'
    ? { ...account, rate: { ...account.rate, utilization: 1, utilization7d: 1,
      utilizationAt: injectedAt, windowResetAt: injectedAt + 300_000, windowResetAt7d: injectedAt + 300_000,
      usageCreditsAvailable: false, lastProbeFailedAt: undefined } } : account) }), workspace);
  const agentConfig = await readAgentConfig();
  await writeAgentConfig({ ...agentConfig, models: { ...agentConfig.models, 'release-fixer': CODEX_SAFE_DEFAULT_MODEL },
    roleBackends: { ...agentConfig.roleBackends, 'release-fixer': 'codex' },
    roleAccounts: { ...agentConfig.roleAccounts, 'release-fixer': 'auto' },
    roleBackups: { ...agentConfig.roleBackups, 'release-fixer': [
      { backend: 'claude-code', model: backupModel, effort: backupEffort, account: 'auto' },
    ] } });
  const registry = await loadHarnessRegistry(workspace, { fresh: true });
  const home = registry.projects.find(project => project.slug === workspace);
  assert.ok(home, 'private home harness missing');
  const project = join(evidenceDir, 'private-project');
  mkdirSync(join(project, '.papercusp'), { recursive: true });
  const prompt = join(project, '.papercusp', 'inert-release-fixer.md');
  writeFileSync(prompt, 'You are an inert routing fixture. Reply with the single word READY. Do not invoke any tool, execute a command, read a file, claim work, acquire a lock, edit files, or operate a release gate.');
  const config = { promptOverrides: { 'release-fixer': prompt }, timeouts: { 'release-fixer': 90 } };
  // invoke-once reads its maintained effective config from STATE_DIR/config.json.
  writeFileSync(join(project, '.papercusp', 'config.json'), JSON.stringify(config));
  assert.equal(JSON.parse(readFileSync(join(project, '.papercusp', 'config.json'), 'utf8'))
    .promptOverrides['release-fixer'], prompt);
  await saveHarnessRegistry({ ...registry, projects: registry.projects.map(entry => entry.slug === workspace
    ? { ...entry, path: project, configOverrides: { ...entry.configOverrides,
      ...config } } : entry) }, workspace);
  writeFileSync(join(evidenceDir, 'account-route-preflight.json'), JSON.stringify({ runtimeInputs,
    declared: { codexGatewayPresent: Object.hasOwn(e, 'PAPERCUSP_CODEX_GATEWAY'), account: 'auto' },
    prompt, config, mode: source.mode, injectedPrimaryWall: failover, injectedAt,
    observedAt: source.observedAt, accountIds: source.accounts.map((account: any) => account.id) }));
  console.log('BLUEPRINT_ACCOUNT_ROUTE_PHASE runtime-preflight-ready');
  const { sql } = getOrgPg();
  const privateGateBefore = await sql`SELECT name, active, next_fire_at, metadata
    FROM harness_shared.routines WHERE workspace_id=${workspace} AND name='green-checkpoint'`;
  assert.equal(privateGateBefore.length, 1);
  assert.equal(privateGateBefore[0].active, false, 'private publication must stay paused');
  // Validate private injected facts before allocating a gateway that needs disposal.
  // The real launcher later reads these same rows through its ordinary live path.
  const capacity = poolVerdictByProvider(await accountStatus(workspace, Date.now(), {
    gatewayStats: null, readCodexWalletId: async () => null,
  }));
  const primaryVerdict = capacity.find(row => row.provider === 'codex');
  assert.ok(primaryVerdict);
  assert.equal(primaryVerdict.atCapacity, failover, 'production preflight must observe the injected primary wall');
  if (failover) {
    assert.equal(primaryVerdict.walledFresh, primaryVerdict.total, 'every private primary account must be freshly walled');
    const backupVerdict = capacity.find(row => row.provider === 'claude');
    assert.ok(backupVerdict && !backupVerdict.atCapacity, 'backup route must have usable capacity');
  }
  let spawnId: string | undefined;
  let stopped = false;
  let nativeProcesses: Array<{ pid: number; identity: ReturnType<typeof readProcessIdentity> }> = [];
  let upstream: (Awaited<ReturnType<typeof retainPrivateProviderResponse>> & { requests: number }) | undefined;
  let requestCount = 0;
  let releaseResponse: (() => void) | undefined;
  const responseHeld = new Promise<void>(done => { releaseResponse = done; });
  let ready: (() => void) | undefined;
  const realResponseReady = new Promise<void>(done => { ready = done; });
  const gateway = await startGatewayService({ workspace, port: 0, refreshIntervalMs: 0,
    poolReloadIntervalMs: 0, localBackendReloadIntervalMs: 0, durableAdmission: false,
    fetchImpl: async (url, init) => {
      assert.notEqual(e.FGR_R6_NO_PROVIDER, '1', 'setup calibration must never contact a provider');
      assert.match(String(url), failover ? /\/messages(?:\?|$)/ : /\/responses(?:\?|$)/,
        'only the declared backend real first inference request is permitted');
      assert.equal(++requestCount, 1, 'bounded routing fixture permits exactly one real request');
      const response = await fetch(url, init);
      // Read the real body while withholding it from the native child. No mock response
      // or model completion can reach the child before its whole lineage is stopped.
      upstream = { ...await retainPrivateProviderResponse(evidenceDir, response, init), requests: requestCount };
      ready!();
      await responseHeld;
      return response;
    },
  });
  e.PAPERCUSP_GATEWAY_PORT = String(gateway.port);
  async function measureNative() {
    assert.ok(spawnId);
    const [row] = await sql`SELECT pid, run_id FROM harness_shared.spawned_agents WHERE spawn_id=${spawnId}`;
    // A pending launch row names the initiating process, not an admitted child.
    if (!row?.pid || !String(row.run_id).startsWith('invoke-launch-')) return false;
    assert.notEqual(Number(row.pid), process.pid, 'never terminate the initiating fixture');
    nativeProcesses = descendants(Number(row.pid)).map(pid => ({ pid, identity: readProcessIdentity(pid) }));
    return true;
  }
  async function stopNative() {
    if (!spawnId || stopped) return;
    if (!nativeProcesses.length && !await measureNative()) return;
    for (const { pid, identity } of [...nativeProcesses].reverse()) {
      if (identity && readProcessIdentity(pid) === identity) try { process.kill(pid, 'SIGKILL'); } catch (error: any) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    await eventually(async () => nativeProcesses.every(({ pid, identity }) => !identity || readProcessIdentity(pid) !== identity)
      ? true : null, 'native lineage cleanup', 10_000);
    stopped = true;
  }
  async function pauseNative() {
    for (const { pid, identity } of nativeProcesses) {
      assert.ok(identity && readProcessIdentity(pid) === identity, 'native lifetime moved before pause');
      process.kill(pid, 'SIGSTOP');
    }
    await eventually(async () => nativeProcesses.every(({ pid, identity }) => {
      if (readProcessIdentity(pid) !== identity) return false;
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] === 'T';
    }) ? true : null, 'kernel-stopped native lineage', 10_000);
  }
  function measureChildConfig() {
    const candidates = nativeProcesses.flatMap(({ pid }) => {
      try {
        // CODEX_HOME is also inherited by wrappers. Measure the native binary
        // that actually consumes CLI config overrides, not an ancestor shell.
        const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').slice(0, -1);
        if (failover ? !argv.includes('--mcp-config') : !realpathSync(`/proc/${pid}/exe`).endsWith('/codex')) return [];
        const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
          .filter(Boolean).map(entry => { const i = entry.indexOf('='); return [entry.slice(0, i), entry.slice(i + 1)]; }));
        return (failover ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME)
          ? [{ pid, home: (failover ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME)!, argv, env }] : [];
      } catch { return []; }
    });
    const child = candidates.at(-1);
    assert.ok(child, 'actual native lineage must expose its per-spawn config');
    assert.equal(candidates.length, 1, 'the bounded proof must expose exactly one actual native consumer');
    assert.ok(child.home.startsWith(resolve(e.HOME!, '..') + '/'), 'native config escaped private runtime');
    const config = failover ? undefined : parseToml(readFileSync(join(child.home, 'config.toml'), 'utf8')) as any;
    const provider = config?.model_providers?.[config.model_provider];
    const mcp = config ? new URL(config.mcp_servers.papercusp.url) : undefined;
    const measured = failover ? privateClaudeModelConfig(child.argv, child.env)
      : { ...privateCodexModelConfig(child.argv, config), baseUrl: provider?.base_url,
        ownerId: provider?.http_headers?.['x-papercusp-owner'],
        accountPinPresent: Boolean(provider?.http_headers?.['x-papercusp-account'] || child.env.PAPERCUSP_ACCOUNT_ID),
        mcpOrigin: mcp!.origin, mcpOwnerId: mcp!.searchParams.get('client'),
        mcpWorkspace: mcp!.searchParams.get('workspace') };
    assert.equal(measured.baseUrl, `http://127.0.0.1:${gateway.port}${failover ? '' : '/v1'}`);
    assert.equal(measured.ownerId, spawnId);
    assert.equal(measured.accountPinPresent, false, 'auto must not acquire an ambient pin');
    assert.equal(measured.mcpOrigin, new URL(e.PAPERCUSP_OPERATOR_URL!).origin);
    assert.equal(measured.mcpOwnerId, spawnId);
    assert.equal(measured.mcpWorkspace, workspace);
    const mounts = readFileSync(`/proc/${child.pid}/mountinfo`, 'utf8').trim().split('\n').map(line => {
      const fields = line.split(' ');
      return { path: fields[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))), options: fields[5].split(',') };
    }).filter(mount => root === mount.path || root.startsWith(mount.path.endsWith('/') ? mount.path : mount.path + '/'))
      .sort((a, b) => b.path.length - a.path.length);
    assert.ok(mounts[0]?.options.includes('ro'), 'actual native mount must deny canonical tree writes');
    return { pid: child.pid, sha256: createHash('sha256').update(JSON.stringify(measured)).digest('hex'),
      argvSha256: createHash('sha256').update(JSON.stringify(child.argv)).digest('hex'),
      ...measured, canonicalMount: mounts[0] };
  }
  return {
    measureSetup() {
      assert.equal(requestCount, 0, 'preflight must not make inference requests');
      assert.equal(spawnId, undefined, 'preflight must not launch a native child');
      return { workspace, mode: source.mode, injectedPrimaryWall: failover, capacity,
        requestedBackend: 'codex', primaryModel, primaryEffort,
        backups: [{ backend: 'claude-code', model: backupModel, effort: backupEffort, account: 'auto' }],
        codexGatewayPresent: Object.hasOwn(e, 'PAPERCUSP_CODEX_GATEWAY'),
        providerRequests: requestCount, nativeStarted: false, bundleStarted: false, httpStarted: false };
    },
    async execute(stopInvokeHost: (afterExit?: () => Promise<void>) => Promise<void>) {
      console.log('BLUEPRINT_ACCOUNT_ROUTE_PHASE launch-real-' + source.mode);
      const launched = await fireLaunchBlueprint('release-fix', { installSlug: workspace, workspaceId: workspace,
        kickoff: 'Inert routing proof: reply READY without tools.', timeoutMs: 90_000,
        bodyExtra: { account: 'auto' } });
      spawnId = launched.spawn?.spawnId ?? undefined;
      assert.ok(spawnId, 'production blueprint launcher must return its exact spawn identity');
      await Promise.race([realResponseReady, eventually(async () => {
        const [row] = await sql`SELECT status, error_message FROM harness_shared.spawned_agents WHERE spawn_id=${spawnId!}`;
        if (row?.status === 'failed') throw new Error(`Real primary launch failed before response: ${row.error_message}`);
        return null;
      }, 'real primary response', 100_000), new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('real first provider response timed out')), 100_000); timer.unref();
      })]);
      assert.equal(upstream?.status, 200, `real upstream must accept and serve the request: ${JSON.stringify(upstream?.error)}`);
      assert.ok(await measureNative(), 'actual invoke handoff must precede the provider response');
      assert.ok(nativeProcesses.length > 1, 'real native descendant must exist');
      const childConfig = measureChildConfig();
      // Freeze the actual consumer before releasing the real successful body.
      // The gateway can finish its socket write and persist success, while the
      // native process cannot consume the completion or take a tool action.
      await pauseNative();
      releaseResponse!();
      const row = await eventually(async () => {
        const [entry] = await sql`SELECT account_route, first_gateway_request FROM harness_shared.spawned_agents WHERE spawn_id=${spawnId!}`;
        return entry?.first_gateway_request ? entry : null;
      }, 'persisted exact first gateway request');
      const ownerReport = await (await fetch(`http://127.0.0.1:${gateway.port}/admin/owner-report?owner=${encodeURIComponent(spawnId)}`)).json() as any;
      const first = ownerReport.stageTelemetry.recent.find((entry: any) => entry.ownerId === spawnId);
      assert.ok(first, 'same gateway must report the same explicit owner');
      assert.equal(row.first_gateway_request.ownerId, spawnId);
      assert.equal(row.first_gateway_request.requestId, `${ownerReport.process.instanceId}:${first.requestId}`);
      assert.equal(row.first_gateway_request.requestOrdinal, first.requestId);
      assert.equal(ownerReport.process.identity, readProcessIdentity(process.pid));
      assert.equal(row.first_gateway_request.finalStatus, 200);
      assert.equal(row.first_gateway_request.outcome, 'ok');
      assert.equal(row.first_gateway_request.servingAccountId, first.cache.servingAccountId);
      assert.ok(row.account_route.resolvedAccountIds.includes(first.cache.servingAccountId));
      // Startup telemetry retains Claude's client-side [1m] marker, while the
      // provider body and launch route use the bare Anthropic model id. Preserve
      // the raw evidence and compare the canonical model plane explicitly.
      assert.equal(row.first_gateway_request.model, first.model);
      assert.equal(spawnObservedGatewayModel(row.first_gateway_request), spawnRouteGatewayModel(row.account_route));
      assert.equal(row.first_gateway_request.effort, row.account_route.launchedEffort);
      assert.equal(childConfig.model, row.account_route.launchedModel);
      assert.equal(childConfig.effort, row.account_route.launchedEffort);
      assert.equal(row.account_route.requestedBackend, 'codex');
      assert.equal(row.account_route.launchedBackend, launchedBackend);
      assert.equal(row.account_route.requestedModel, primaryModel);
      assert.equal(row.account_route.launchedModel, launchedModel);
      assert.equal(row.account_route.requestedEffort, primaryEffort);
      assert.equal(row.account_route.launchedEffort, launchedEffort);
      assert.equal(row.account_route.reason ?? null, failover ? 'capacity' : null);
      assert.equal(upstream?.requestShape.model, launchedModel);
      assert.equal(upstream?.requestShape.effort, launchedEffort);
      // Host exit closes admission. Descendant reaping then closes inherited
      // pipes; waiting for pipe-close before reaping would deadlock this order.
      await stopInvokeHost(stopNative);
      const [state] = await sql`SELECT count(*) AS claims FROM harness_shared.work_item_claims`;
      assert.equal(Number(state.claims), 0, 'private child must not claim work');
      const privateGateAfter = await sql`SELECT name, active, next_fire_at, metadata
        FROM harness_shared.routines WHERE workspace_id=${workspace} AND name='green-checkpoint'`;
      assert.deepEqual(privateGateAfter, privateGateBefore, 'inert child must not alter private gate controls');
      return { workspace, mode: source.mode, injectedPrimaryWall: failover, capacity,
        spawnId, route: row.account_route, firstRequest: row.first_gateway_request,
        upstream, telemetry: { servingAccountId: first.cache.servingAccountId,
          requestId: `${ownerReport.process.instanceId}:${first.requestId}` }, childConfig,
        childStopped: stopped, stoppedPids: nativeProcesses.map(({ pid }) => pid),
        responseObservedByChild: false, responseBufferedWhileChildPaused: true,
        canonicalTreeReadOnly: true, privateMcp: true,
        gatewayRuntime: ownerReport.process, privateGateUnchanged: true, privateClaims: Number(state.claims),
        runtimeInputs,
        declared: { account: 'auto', backend: 'codex', model: primaryModel, effort: primaryEffort, codexGatewayPresent: false },
        preflight: { observedAt: source.observedAt, headroom: source.headroom,
          accountIds: source.accounts.map((account: any) => account.id) } };
    },
    async dispose() {
      try { await stopNative(); }
      finally { releaseResponse!(); await gateway.stop(); }
    },
  };
}
