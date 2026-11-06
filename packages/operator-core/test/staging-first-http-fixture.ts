/** Private current-build request fixture; launched only by its integration suite. */
import assert from 'node:assert/strict';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Socket } from 'node:net';
import { getOrgPg, getOrgPgApp, getOrgPgListener, _resetForTests } from '@papercusp/db-org';
import { readPgBackendCensus } from './_pg-backend-census';
import { loadHarnessRegistry, saveHarnessRegistry } from '../lib/harness-registry';
import { readProcessIdentity } from '../lib/process-identity';
import { resolvePlanScope } from '../lib/agent-tools/plans/source';
import { buildPrivateOperatorApiBundle, privateBundleRuntimeEnv, privateNativeDockerHost, waitForPrivateOperator, stopPrivateOperatorHost, qualifyCommittedReaderSource, observeCommittedReaderLoadedSources, resolvePreparedCommittedReaderSource, resolvePreparedPrivateApiBundle } from './private-http-workspace-preflight';
import { captureIsolatedWorker, isolatedTestFileWorkerOptions, retainIsolatedWorkerProgress } from './isolated-integration-proof';
import { measurePrivateUnrelatedCheckpointScenario } from './private-unrelated-write-http-scenario';

let host: ChildProcess | undefined;
let hostIdentity: ReturnType<typeof readProcessIdentity>;
let disposeScenario: (() => Promise<void>) | undefined;
let retainLoadedSources: (() => void) | undefined;
const socketOrigins = new Map<number, string>();
const originalConnect = Socket.prototype.connect;
// Evidence only: trace the native worker's real PG clients, including clients
// opened by a detached exit callback after the shared pools were reset.
if (process.env.STAGING_FIRST_HTTP_SCENARIO?.startsWith('current-su-native')) {
  Socket.prototype.connect = function(this: Socket, ...args: unknown[]) {
    const stack = new Error('Private fixture PG connection creation').stack ?? '';
    this.once('connect', () => {
      if (this.remotePort === Number(process.env.PAPERCUSP_PG_PORT) && this.localPort) {
        socketOrigins.set(this.localPort, stack);
        retainIsolatedWorkerProgress(process.env.STAGING_FIRST_HTTP_EVIDENCE_DIR!,
          'fixture-pg-socket-opened', { localPort: this.localPort, remotePort: this.remotePort, stack });
      }
    });
    return Reflect.apply(originalConnect, this, args);
  } as typeof originalConnect;
}
async function stopHost(afterExit?: () => Promise<void>) {
  if (!host) { await afterExit?.(); return; }
  await stopPrivateOperatorHost(host, afterExit);
  assert.notEqual(readProcessIdentity(host.pid!), hostIdentity, 'private host survived cleanup');
  retainLoadedSources?.();
  retainLoadedSources = undefined;
}

async function main() {
  const e = process.env;
  const workspace = e.PAPERCUSP_WORKSPACE_ID!;
  const base = e.PAPERCUSP_OPERATOR_URL!;
  assert.match(workspace, /^test-runtime-/);
  assert.equal(e.PAPERCUSP_POT_HOME_SLUG, workspace);
  assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(e.PAPERCUSP_DBOS_ENABLE, '0');
  assert.equal(e.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
  assert.notEqual(e.PAPERCUSP_PG_PORT, '5432');
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(![3070, 3170, 3271].includes(Number(new URL(base).port)));
  const root = resolve(import.meta.dirname, '../../..');
  const evidenceDir = e.STAGING_FIRST_HTTP_EVIDENCE_DIR!;
  assert.ok(evidenceDir, 'retained evidence directory required');
  // Native assignments launch from this worker as well as the private host.
  // Filtering only hostEnv leaves test preloads on the worker's launch lineage.
  if (e.STAGING_FIRST_HTTP_SCENARIO?.startsWith('current-su-native'))
    e.NODE_OPTIONS = privateBundleRuntimeEnv(e).NODE_OPTIONS;
  if (['report-journal', 'private-completion'].includes(e.STAGING_FIRST_HTTP_SCENARIO ?? ''))
    e.PAPERCUSP_FLAG_PAPERCUSP_REPORTS_LIBRARY = '1';
  const harness = `${workspace}-guard`;
  const registry = await loadHarnessRegistry(workspace, { fresh: true });
  const home = registry.projects.find(project => project.slug === workspace);
  assert.ok(home, 'private operator home must exist');
  await saveHarnessRegistry({ ...registry, projects: [...registry.projects,
    { slug: harness, path: home.path, hive_slug: workspace }] }, workspace);
  const scope = await resolvePlanScope({ harnessSlug: harness, workspaceId: workspace });
  assert.deepEqual(scope, { workspaceId: workspace, harnessSlug: workspace });
  const headers = { 'content-type': 'application/json', origin: base, 'x-papercusp-workspace': workspace };
  // Keep this shared org client live through the teardown census below. The
  // fixture's finally block owns the single close point via _resetForTests().
  const { sql } = getOrgPg();
  if (e.STAGING_FIRST_HTTP_SCENARIO?.startsWith('current-su-native-pool-cleanup') ||
      e.STAGING_FIRST_HTTP_SCENARIO?.startsWith('current-su-native-hub-cleanup') ||
      e.STAGING_FIRST_HTTP_SCENARIO?.startsWith('current-su-native-launch-cleanup') ||
      e.STAGING_FIRST_HTTP_SCENARIO?.startsWith('current-su-native-spawn-cleanup')) {
    // Native launch readers use pools besides the org query client. Exercise
    // the idle LISTEN connection too: ending only sql cannot release it.
    await getOrgPgApp().sql`SELECT 1`;
    await getOrgPgListener().sql.listen('private_native_cleanup', () => {});
    if (e.STAGING_FIRST_HTTP_SCENARIO.startsWith('current-su-native-hub-cleanup')) {
      // The native wake buses own a separate pool, outside db-org's reset.
      // Leave this subscription active to exercise process-owner teardown.
      const { hubListen } = await import('../lib/pg-listen-hub');
      await hubListen('private_native_hub_cleanup', () => {});
    }
    if (!e.STAGING_FIRST_HTTP_SCENARIO.startsWith('current-su-native-pool-cleanup')) {
      // Exercise the native launch module and its standing-wake callback without
      // spawning a CLI, container, provider request or private API build.
      await import('../lib/agent-tools/capability/launch-agent');
      const { armInboxWake } = await import('../lib/events/await/inbox-wake-arm');
      await armInboxWake({ ownerId: `su-private-cleanup-${workspace}`, workspaceId: workspace });
    }
    if (e.STAGING_FIRST_HTTP_SCENARIO.startsWith('current-su-native-spawn-cleanup')) {
      const { spawnGovernedAgentProcess } = await import('../lib/resource-governor/spawn-execution');
      const result = await spawnGovernedAgentProcess({ workspaceId: workspace,
        owner: `private-cleanup-${workspace}`, idempotencyKey: `private-cleanup-${workspace}` }, async () => {
        const child = spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'ignore' });
        const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done =>
          child.once('exit', (code, signal) => done({ code, signal })));
        return { status: 'ok', pid: child.pid ?? null, terminal: 'private-no-agent-control',
          display: null, desktopEnvResolvedVia: null, child, childExit };
      });
      assert.equal(result.status, 'ok');
      assert.ok(result.childExit);
      assert.equal((await result.childExit).code, 1);
    }
    console.log('CURRENT_SU_NATIVE_POOL_READY ' + JSON.stringify({ workspace }));
    if (e.STAGING_FIRST_HTTP_SCENARIO.endsWith('-failure'))
      throw new Error('Private native pool cleanup exception control');
    return;
  }
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'current-su-native-setup') {
    // Exercise the real writer before paying for an API build/container/native
    // launch. A fresh isolated HOME has no installed hook scripts by default.
    const probeHome = join(evidenceDir, 'codex-hook-preflight');
    mkdirSync(probeHome);
    let nativeHookPreflight;
    try {
      const { writeCodexLockHooks } = await import('../lib/role-codex-home');
      const beforeInstall = writeCodexLockHooks(probeHome);
      await (await import('./current-su-native-http-scenario')).prepareCurrentSuNativeScenario(workspace);
      const configured = writeCodexLockHooks(probeHome, { lockSid: 'su-private-hook-preflight',
        activitySid: 'su-private-hook-preflight', injectSid: 'su-private-hook-preflight' });
      const hooks = configured ? JSON.parse(readFileSync(join(probeHome, 'hooks.json'), 'utf8')).hooks : {};
      nativeHookPreflight = { beforeInstall, configured, events: Object.keys(hooks),
        privateHookRoot: configured && JSON.stringify(hooks).includes(join(e.HOME!, '.papercusp', 'hooks')) };
    } finally { rmSync(probeHome, { recursive: true, force: true }); }
    const { readSuperuserToken, isValidSuperuserBearer, superuserTokenPath } = await import('../lib/superuser-token');
    const bearer = readSuperuserToken();
    // Check the same reader/validator used by bootstrap-su and the HTTP MCP
    // host. Return booleans only; the disposable credential stays in its home.
    const nativeMcpAuth = { bearerPresent: bearer !== null, bearerAccepted: isValidSuperuserBearer(bearer),
      privatePath: superuserTokenPath() === join(e.PAPERCUSP_HOME!, 'superuser-token'),
      mode: bearer === null ? null : statSync(superuserTokenPath()).mode & 0o777,
      absentRejected: !isValidSuperuserBearer(null), wrongRejected: !isValidSuperuserBearer('wrong-private-bearer') };
    console.log('CURRENT_SU_NATIVE_SETUP_RECEIPT ' + JSON.stringify({ workspace,
      accountId: 'private-current-su', provider: 'codex', providerForwarding: false,
      launcherPath: process.env.PAPERCUSP_PSU_LAUNCHER ?? null,
      nodeOptions: e.NODE_OPTIONS ?? '', nativeHookPreflight, nativeMcpAuth }));
    return;
  }
  if (['committed-reader-setup', 'committed-reader-setup-exception'].includes(e.STAGING_FIRST_HTTP_SCENARIO ?? '')) {
    const receipt = await (await import('./committed-reader-http-scenario')).measureCommittedReaderSetup({
      workspace, harness, evidenceDir,
    });
    console.log('COMMITTED_READER_SETUP_RECEIPT ' + JSON.stringify(receipt));
    if (e.STAGING_FIRST_HTTP_SCENARIO === 'committed-reader-setup-exception')
      throw new Error('private preparation exception control');
    return;
  }
  if (e.STAGING_FIRST_HTTP_SCENARIO?.startsWith('blueprint-account-route-setup')) {
    assert.equal(e.FGR_R6_NO_PROVIDER, '1', 'setup must prohibit real provider requests');
    const scenario = await (await import('./blueprint-account-route-http-scenario')).prepareBlueprintAccountRouteScenario({ workspace, evidenceDir });
    disposeScenario = scenario.dispose;
    const receipt = scenario.measureSetup();
    writeFileSync(join(evidenceDir, 'account-route-setup.json'), JSON.stringify(receipt));
    console.log('BLUEPRINT_ACCOUNT_ROUTE_SETUP_RECEIPT ' + JSON.stringify(receipt));
    if (e.STAGING_FIRST_HTTP_SCENARIO.endsWith('-exception')) throw new Error('private routing setup exception control');
    return;
  }
  const sourcePath = 'packages/operator-core/lib/agent-tools/plans/staging-first-activation-guard.ts';
  const sourceSha256 = createHash('sha256').update(readFileSync(join(root, sourcePath))).digest('hex');
  const isCommittedReader = e.STAGING_FIRST_HTTP_SCENARIO === 'committed-reader';
  const isBlueprintRoute = e.STAGING_FIRST_HTTP_SCENARIO === 'blueprint-account-route';
  const isCurrentSuNative = ['current-su-native', 'current-su-native-carry',
    'current-su-native-frozen-carry-on', 'current-su-native-frozen-carry-off'].includes(e.STAGING_FIRST_HTTP_SCENARIO ?? '');
  // The supervisor deliberately strips DOCKER_* credentials and routing.
  // Reconstitute only this run's selected local endpoint before host launch.
  if (isCurrentSuNative) e.DOCKER_HOST = privateNativeDockerHost(process.argv.slice(2));
  const isCodexManagedTools = e.STAGING_FIRST_HTTP_SCENARIO === 'codex-managed-tools';
  const isOmpManagedTools = e.STAGING_FIRST_HTTP_SCENARIO === 'omp-managed-tools';
  const requiresPrepared = isCommittedReader || isBlueprintRoute || isCurrentSuNative || isCodexManagedTools || isOmpManagedTools
    || e.STAGING_FIRST_HTTP_SCENARIO === 'testing-background';
  const prepared = requiresPrepared
    ? resolvePreparedPrivateApiBundle(process.argv.slice(2), evidenceDir) : undefined;
  assert.ok(!requiresPrepared || prepared,
    'Selected request scenario requires its prepared pinned API');
  const bundle = prepared ?? join(evidenceDir, 'hono-host.mjs');
  if (!prepared) {
    console.log('STAGING_FIRST_HTTP_PHASE bundle-start');
    try {
      await buildPrivateOperatorApiBundle(root, evidenceDir, { timeoutMs: 240_000, maxMs: 420_000 });
    } finally {
      writeFileSync(join(evidenceDir, 'build.log'), readFileSync(join(evidenceDir, 'operator-api-build.log')));
    }
  }
  const bundleBytes = readFileSync(bundle);
  assert.ok(bundleBytes.includes(Buffer.from('staging-first-activation-guard.ts')), 'guard must be in the executed bundle');
  if (isCommittedReader) assert.ok(bundleBytes.includes(Buffer.from('committed-tree-reader.ts')),
    'committed reader must be in the executed bundle');
  const bundleSha256 = createHash('sha256').update(bundleBytes).digest('hex');
  let qualifySource: (() => ReturnType<typeof qualifyCommittedReaderSource>) | undefined;
  let loadedSourceOptions: Parameters<typeof qualifyCommittedReaderSource>[0] | undefined;
  if (isCommittedReader) {
    const selection = resolvePreparedCommittedReaderSource(process.argv.slice(2), evidenceDir);
    // Compare the actual required private column/type/nullability/default
    // catalogue, rather than inferring applied schema from migration filenames.
    const columns = await sql`SELECT table_schema, table_name, column_name, data_type, udt_name,
      is_nullable, column_default, ordinal_position FROM information_schema.columns
      WHERE table_schema = 'harness_shared' ORDER BY table_name, ordinal_position`;
    const schema = Object.fromEntries(columns.map(row => [
      `${row.table_schema}.${row.table_name}.${row.column_name}`,
      createHash('sha256').update(JSON.stringify({ ...row })).digest('hex'),
    ]));
    loadedSourceOptions = { root, bundle,
      receiptPath: join(dirname(evidenceDir), 'prepare', 'operator-api-preflight.json'),
      ...selection, schema, environment: e };
    qualifySource = () => qualifyCommittedReaderSource(loadedSourceOptions!);
    writeFileSync(join(evidenceDir, 'committed-reader-source-preflight.json'), JSON.stringify(qualifySource()));
  }
  // The required source guard runs before preparation opens its private sidecar.
  const committedReader = isCommittedReader
    ? await (await import('./committed-reader-http-scenario')).prepareCommittedReaderScenario({
      workspace, harness, base, headers, evidenceDir,
    }) : undefined;
  const blueprintRoute = e.STAGING_FIRST_HTTP_SCENARIO === 'blueprint-account-route'
    ? await (await import('./blueprint-account-route-http-scenario')).prepareBlueprintAccountRouteScenario({ workspace, evidenceDir })
    : undefined;
  disposeScenario = blueprintRoute?.dispose ?? committedReader?.dispose;
  if (isCodexManagedTools || isOmpManagedTools) {
    const { randomBytes } = await import('node:crypto');
    const { superuserTokenPath } = await import('../lib/superuser-token');
    mkdirSync(e.PAPERCUSP_HOME!, { recursive: true, mode: 0o700 });
    writeFileSync(superuserTokenPath(), randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
  }
  if (isCurrentSuNative || e.STAGING_FIRST_HTTP_SCENARIO === 'current-su-native-home-repair')
    await (await import('./current-su-native-http-scenario')).prepareCurrentSuNativeScenario(workspace);
  // Preparation changes socket/tmp settings; compare the final host environment
  // again. A refused pin still follows the same finally/dispose path.
  if (qualifySource) qualifySource();
  // The real native request fixture grants writes only to its disposable state.
  // Apply the mount boundary to the whole operator/invoke/native lineage.
  const privateRoot = dirname(e.HOME!);
  const traceOut = join(evidenceDir, 'committed-reader-host-source.json');
  const hostEnv = privateBundleRuntimeEnv(e, loadedSourceOptions ? { traceOut } : undefined);
  if (blueprintRoute) {
    // `with-test-pg --isolated-runtime` deliberately scrubs ambient
    // PAPERCUSP_* keys. The blueprint scenario selects the maintained checkout
    // harness after that boundary; carry that exact, preflighted path into the
    // private operator host explicitly before it can resolve invoke-once/tsx.
    const harnessDir = realpathSync(join(root, 'libs/papercusp/packages/harness'));
    assert.equal(e.PAPERCUSP_HARNESS_DIR, harnessDir,
      'blueprint runtime preflight must select the checkout harness');
    hostEnv.PAPERCUSP_HARNESS_DIR = harnessDir;
    assert.equal(hostEnv.PAPERCUSP_HARNESS_DIR, harnessDir,
      'private operator host must receive the preflighted harness path');
  }
  // Use the maintained installed shim's explicit launcher override; its
  // default release checkout cannot certify this current-build candidate.
  hostEnv.PAPERCUSP_PSU_LAUNCHER = join(root, 'apps/operator/scripts/psu-launcher.mjs');
  const hostStartedAtMs = Date.now();
  host = blueprintRoute
    ? spawn('bwrap', ['--die-with-parent', '--ro-bind', '/', '/', '--bind', privateRoot, privateRoot,
      '--bind', evidenceDir, evidenceDir, '--dev', '/dev', '--proc', '/proc', '--', process.execPath, bundle],
    { cwd: root, env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, [bundle], { cwd: root, env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout!.on('data', chunk => process.stdout.write(chunk));
  host.stderr!.on('data', chunk => process.stderr.write(chunk));
  hostIdentity = readProcessIdentity(host.pid!);
  assert.ok(hostIdentity, 'private host kernel identity required');
  if (loadedSourceOptions) {
    const selected = loadedSourceOptions;
    retainLoadedSources = () => {
      const observation = observeCommittedReaderLoadedSources({ ...selected, traceOut,
        pid: host!.pid!, startedAtMs: hostStartedAtMs, finishedAtMs: Date.now() });
      writeFileSync(join(evidenceDir, 'committed-reader-loaded-source.json'), JSON.stringify(observation), { mode: 0o600 });
    };
  }
  const health = await waitForPrivateOperator({ host, base, headers, evidenceDir, hostIdentity, environment: hostEnv });
  console.log('STAGING_FIRST_HTTP_PHASE request-ready');
  if (isCodexManagedTools || isOmpManagedTools) {
    const backend = isOmpManagedTools ? 'omp' : 'codex';
    const prefix = backend.toUpperCase();
    const { readSuperuserToken } = await import('../lib/superuser-token');
    const token = readSuperuserToken();
    assert.ok(token, 'private operator MCP bearer is required');
    const censusDir = join(evidenceDir, 'census');
    mkdirSync(censusDir);
    const env = { ...e, PAPERCUSP_TEST_RUN_GROUP:
      (e.PAPERCUSP_TEST_RUN_GROUP ?? '') + ':' + backend + '-managed-surface-worker',
      // The installed client's code-mode probe checks exit_code and exact output.
      // Foreground capability:bash exposes those fields through negotiated MCP
      // structuredContent; its default text result is intended for human readers.
      [prefix + '_MANAGED_PRIVATE_MCP_URL']: base + '/api/mcp?superuser=1&structured=1&workspace=' +
        encodeURIComponent(workspace) + '&client=su-private-' + backend + '-managed',
      [prefix + '_MANAGED_PRIVATE_MCP_TOKEN']: token };
    const child = fork(join(root, 'scripts/test-files.mjs'),
      ['packages/operator-core/lib/' + backend + '-managed-tools.native.integration.test.ts'],
      { cwd: root, env, execArgv: ['--import', './scripts/lib/committed-source-loader.mjs'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const result = await captureIsolatedWorker(child, censusDir, isolatedTestFileWorkerOptions(env, 1));
    assert.equal(result.code, 0, result.output.slice(-12000));
    assert.equal(result.signal, null);
    assert.equal(result.timedOut, false);
    const resultLine = result.output.split(/\r?\n/).find(row => row.startsWith('TEST_FILE_RESULT '));
    assert.ok(resultLine, 'machine-readable TEST_FILE_RESULT is required');
    const resultFields = Object.fromEntries(resultLine.split(/\s+/).slice(1).map(field => {
      const equals = field.indexOf('=');
      assert.notEqual(equals, -1, `malformed TEST_FILE_RESULT field: ${field}`);
      return [field.slice(0, equals), field.slice(equals + 1)];
    }));
    assert.deepEqual({ requested: resultFields.requested, executed: resultFields.executed,
      matched: resultFields.matched, status: resultFields.status, skippedTests: resultFields.skippedTests },
    { requested: '1', executed: '1', matched: '1', status: 'passed', skippedTests: '0' });
    const line = result.output.split('\n').find(row => row.startsWith(prefix + '_ADMITTED_LIFECYCLE '));
    assert.ok(line, 'production MCP lifecycle receipt is required');
    const measured = JSON.parse(line.slice((prefix + '_ADMITTED_LIFECYCLE ').length));
    for (const row of isOmpManagedTools ? measured.removed : measured.removed.lifecycle) {
      assert.equal(row.managedPath, 'production-capability-bash');
      assert.equal(row.managedCalls, 1);
      assert.equal(row.hasNativeExecution, false);
    }
    await stopHost();
    const receipt = { workspace, bundleSha256, health, hostStopped: true,
      providerForwarding: false, managedTool: 'capability:bash', surfaces: ['launch', 'resume', 'wake'] };
    writeFileSync(join(evidenceDir, 'operator-mcp-receipt.json'), JSON.stringify(receipt));
    console.log(result.output);
    console.log(prefix + '_PRODUCTION_MCP_VERIFIED ' + JSON.stringify(receipt));
    return;
  }
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'private-completion') {
    const receipt = await (await import('./private-completion-http-scenario')).measurePrivateCompletionScenario({
      workspace, harness, base, headers, evidenceDir, expectedSha: health.sha,
    });
    await stopHost();
    console.log('PRIVATE_COMPLETION_HTTP_RECEIPT ' + JSON.stringify({ ...receipt, hostStopped: true, bundleSha256, health }));
    return;
  }
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'shared-chat-recovery') {
    const receipt = await (await import('./shared-chat-recovery-http-scenario')).measureSharedChatRecovery({ workspace, base });
    await stopHost();
    console.log('SHARED_CHAT_RECOVERY_HTTP_RECEIPT ' + JSON.stringify({ ...receipt, hostStopped: true, bundleSha256, health }));
    return;
  }
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'current-su-native-home-repair') {
    const receipt = await (await import('./current-su-native-http-scenario')).measureCurrentSuHomeRepairScenario({ workspace, base });
    await stopHost();
    console.log('PRIVATE_NATIVE_HOME_REPAIR ' + JSON.stringify({ ...receipt, hostStopped: true, bundleSha256, health }));
    return;
  }
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'session-capability') {
    const receipt = await (await import('./session-capability-http-scenario')).measureSessionCapabilityScenario({
      workspace, api: base + '/api', expectedSha: health.sha,
    });
    await stopHost();
    console.log('SESSION_CAPABILITY_HTTP_RECEIPT ' + JSON.stringify({ ...receipt, hostPid: host.pid,
      hostStopped: true, bundleSha256, health }));
    return;
  }
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'codex-budget') {
    const receipt = await (await import('./codex-budget-http-scenario')).measureCodexBudgetScenario({
      workspace, base, headers, evidenceDir,
    });
    await stopHost();
    console.log('CODEX_BUDGET_HTTP_RECEIPT ' + JSON.stringify({ ...receipt, hostStopped: true, bundleSha256, health }));
    return;
  }
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'loop-namespace-native') {
    const receipt = await (await import('./loop-namespace-native-scenario')).measureLoopNamespaceNativeScenario({
      workspace, base, headers, evidenceDir,
    });
    await stopHost();
    console.log('LOOP_NAMESPACE_NATIVE_RECEIPT ' + JSON.stringify({ ...receipt, hostStopped: true, bundleSha256, health }));
    return;
  }
  if (blueprintRoute) {
    const receipt = await blueprintRoute.execute(stopHost);
    await stopHost();
    await blueprintRoute.dispose();
    disposeScenario = undefined;
    const finalReceipt = { ...receipt, hostStopped: true, hostPid: host.pid, bundleSha256, sourceSha256, health };
    writeFileSync(join(evidenceDir, 'account-route.json'), JSON.stringify(finalReceipt));
    console.log('BLUEPRINT_ACCOUNT_ROUTE_RECEIPT ' + JSON.stringify(finalReceipt));
    return;
  }
  if (isCurrentSuNative) {
    const receipt = await (await import('./current-su-native-http-scenario')).measureCurrentSuNativeScenario({
      workspace, base, evidenceDir, managedCarry: e.STAGING_FIRST_HTTP_SCENARIO === 'current-su-native-carry',
      ...(e.STAGING_FIRST_HTTP_SCENARIO === 'current-su-native-frozen-carry-on' ? { frozenCarryMode: 'on' as const } : {}),
      ...(e.STAGING_FIRST_HTTP_SCENARIO === 'current-su-native-frozen-carry-off' ? { frozenCarryMode: 'off' as const } : {}),
    });
    await stopHost();
    console.log('CURRENT_SU_NATIVE_RECEIPT ' + JSON.stringify({ ...receipt, hostStopped: true, bundleSha256, health,
      dockerHost: e.DOCKER_HOST }));
    return;
  }
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'compaction-warm') {
    const receipt = await (await import('./compaction-warm-http-scenario')).measureCompactionWarmScenario({
      workspace, harness, base, headers, evidenceDir,
    });
    await stopHost();
    console.log('COMPACTION_WARM_HTTP_RECEIPT ' + JSON.stringify({ ...receipt, hostPid: host.pid,
      hostStopped: true, bundleSha256, health }));
    return;
  }
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'report-journal') {
    const receipt = await (await import('./report-journal-http-scenario')).measureReportJournalScenario({
      workspace, harness, base, headers, evidenceDir,
    });
    await stopHost();
    console.log('REPORT_JOURNAL_HTTP_RECEIPT ' + JSON.stringify({ ...receipt, hostPid: host.pid,
      hostStopped: true, bundleSha256, health }));
    return;
  }
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'private-read-pg-error') {
    const receipt = await (await import('./private-read-pg-error-http-scenario')).measurePrivateReadPgErrorScenario({
      workspace, harness, base, headers, evidenceDir, expectedSha: health.sha,
    });
    await stopHost();
    console.log('PRIVATE_READ_PG_ERROR_HTTP_RECEIPT ' + JSON.stringify({
      ...receipt, hostPid: host.pid, hostStopped: true, bundleSha256, health,
    }));
    return;
  }
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'private-read-cancellation') {
    const receipt = await (await import('./private-read-cancellation-http-scenario')).measurePrivateReadCancellationScenario({
      workspace, harness, base, headers, evidenceDir, expectedSha: health.sha,
    });
    await stopHost();
    console.log('PRIVATE_READ_CANCELLATION_HTTP_RECEIPT ' + JSON.stringify({
      ...receipt, hostPid: host.pid, hostStopped: true, bundleSha256, health,
    }));
    return;
  }
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'testing-background') {
    const receipt = await (await import('./testing-background-http-scenario')).measureTestingBackgroundScenario({
      workspace, harness, base, headers, evidenceDir, root,
    });
    await stopHost();
    console.log('TESTING_BACKGROUND_HTTP_RECEIPT ' + JSON.stringify({
      ...receipt, hostStopped: true, bundleSha256, health,
    }));
    return;
  }
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'private-read-deadline') {
    const receipt = await (await import('./private-read-deadline-http-scenario')).measurePrivateReadDeadlineScenario({
      workspace, harness, base, headers, evidenceDir, expectedSha: health.sha,
    });
    await stopHost();
    console.log('PRIVATE_READ_DEADLINE_HTTP_RECEIPT ' + JSON.stringify({
      ...receipt, hostPid: host.pid, hostStopped: true, bundleSha256, health,
    }));
    return;
  }
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'private-same-item-write') {
    const receipt = await (await import('./private-unrelated-write-http-scenario')).measurePrivateSameItemCheckpointScenario({
      workspace, harness, base, headers, evidenceDir, expectedSha: health.sha,
    });
    await stopHost();
    console.log('PRIVATE_SAME_ITEM_WRITE_HTTP_RECEIPT ' + JSON.stringify({
      ...receipt, hostPid: host.pid, hostStopped: true, bundleSha256, health,
    }));
    return;
  }
  if (e.STAGING_FIRST_HTTP_SCENARIO === 'private-unrelated-write') {
    const receipt = await measurePrivateUnrelatedCheckpointScenario({
      workspace, harness, base, headers, evidenceDir, expectedSha: health.sha,
    });
    await stopHost();
    console.log('PRIVATE_UNRELATED_WRITE_HTTP_RECEIPT ' + JSON.stringify({
      ...receipt, hostPid: host.pid, hostStopped: true, bundleSha256, health,
    }));
    return;
  }
  if (committedReader) {
    const readerReceipt = await committedReader.execute(host.pid!);
    await stopHost();
    await committedReader.dispose();
    disposeScenario = undefined;
    console.log('COMMITTED_READER_HTTP_RECEIPT ' + JSON.stringify({ workspace, hostPid: host.pid,
      hostStopped: true, sourceSha256, bundleSha256, health, ...readerReceipt }));
    return;
  }
  const requests: Array<Record<string, unknown>> = [];
  const preparation = ['Finalize', 'Define', 'Specify', 'Select', 'Choose', 'Design'];
  const releasePlanes = ['main promotion', 'the deployed host', 'green-checkpoint'];
  for (const [index, action] of [...preparation, ...releasePlanes].entries()) {
    const release = index >= preparation.length;
    const requestedSlug = `private-guard-${index}`;
    const content = '## Items\n\n'
      + `- **P-003** \`todo\` ${release ? 'Finalize' : action} the pilot scope, threat/deployment/data contract, and implementation estimates.${release ? ` Then verify ${action}.` : ''}\n`
      + '- **P-007** `todo` Implement the data-governance contract on current-build. blocked-by: P-003\n'
      + '- **P-011** `todo` Deliver the selected connector and exercise separate write authorization on current-build. blocked-by: P-003, P-007\n';
    const created = await fetch(base + '/api/admin/plans/new', { method: 'POST',
      headers,
      // Each case is a distinct private subject with intentionally shared topic
      // tokens. Acknowledge that fixture duplication through the supported API.
      body: JSON.stringify({ harness, workspaceId: workspace, slug: requestedSlug, title: 'Private staging-first request fixture', status: 'draft', content, force: true }),
      signal: AbortSignal.timeout(30_000) });
    const creation = await created.json() as any;
    assert.equal(created.status, 200, JSON.stringify(creation));
    assert.equal(creation.ok, true, JSON.stringify(creation));
    const slug = creation.slug;
    assert.equal(typeof slug, 'string', 'plans:new must return its canonical dated slug');
    const stored = await sql`SELECT workspace_id, harness_slug FROM harness_shared.harness_plans WHERE plan_slug = ${slug}`;
    assert.deepEqual(stored.map(row => ({ ...row })), [{ workspace_id: scope.workspaceId, harness_slug: scope.harnessSlug }]);
    const readback = await fetch(`${base}/api/admin/plans/get?harness=${harness}&slug=${slug}`,
      { headers, signal: AbortSignal.timeout(30_000) });
    const plan = await readback.json() as any;
    assert.equal(readback.status, 200, JSON.stringify(plan));
    assert.equal(plan.ok, true, JSON.stringify(plan));
    const preparationItem = plan.items?.find((item: any) => item.id === 'P-003');
    assert.ok(preparationItem?.text?.includes('threat/deployment/data contract'),
      JSON.stringify({ slug: plan.slug, preparationItem }));
    // A deliberately invalid source ref is a downstream control: preparation
    // must reach source validation, while actual release waits fail earlier.
    // This does not manufacture a valid owner conversation or activation.
    const args = { harness, slug, phase: 'activation', dryRun: true,
      classRef: 'plan-class-feature-ship',
      sourceRanges: [{ sourceKind: 'codex', sessionId: 'private-guard-source', fromTurn: 1, toTurn: 1 }],
      mappings: [{ id: 'M-001', sourceRefs: ['private-fixture-invalid-source'],
        requirement: 'Private guard control', planTargets: ['P-003'], disposition: 'covered' }] };
    const response = await fetch(base + '/api/agent-mcp/run-tool', { method: 'POST',
      headers,
      body: JSON.stringify({ name: 'plans:audit', args, harness }), signal: AbortSignal.timeout(30_000) });
    const envelope = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(envelope));
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    assert.notEqual(envelope.result?.isError, true, JSON.stringify(envelope));
    const serialized = envelope.result?.content?.find((item: any) => item.type === 'text' && item.text.trim().startsWith('{'));
    const result = envelope.result?.structuredContent ?? (serialized ? JSON.parse(serialized.text) : envelope.result?.data ?? envelope.result);
    writeFileSync(join(evidenceDir, `request-${index}.json`), JSON.stringify({ base, args, status: response.status, envelope }));
    if (release) {
      assert.equal(result.error, 'staging_first_guard_failed', JSON.stringify(result));
      assert.ok(result.problems.some((problem: any) => problem.itemId === 'P-007'
        && problem.code === 'non_final_deployed_main_wait'), JSON.stringify(result));
    } else {
      assert.equal(result.error, 'activation_audit_invalid', JSON.stringify(result));
      assert.ok(result.problems.some((problem: any) => problem.code === 'invalid_session_turn_ref'), JSON.stringify(result));
    }
    requests.push({ action, release, status: response.status, error: result.error,
      problemCodes: result.problems.map((problem: any) => problem.code) });
  }
  const rows = await sql`SELECT workspace_id FROM harness_shared.harness_plans WHERE plan_slug LIKE 'private-guard-%'`;
  assert.equal(rows.length, preparation.length + releasePlanes.length);
  assert.ok(rows.every(row => row.workspace_id === workspace), 'fixture plans escaped private workspace');
  await stopHost();
  console.log('STAGING_FIRST_HTTP_RECEIPT ' + JSON.stringify({ workspace, hostPid: host.pid,
    hostStopped: true, sourcePath, sourceSha256, bundleSha256, health, requests }));
}

try { await main(); }
catch (error) {
  const assertion = error as { message?: string; stack?: string; actual?: unknown; expected?: unknown };
  console.error('STAGING_FIRST_HTTP_FAILURE ' + JSON.stringify({ message: assertion.message ?? String(error),
    stack: assertion.stack, actual: assertion.actual, expected: assertion.expected }));
  process.exitCode = 1;
} finally {
  const evidenceDir = process.env.STAGING_FIRST_HTTP_EVIDENCE_DIR!;
  retainIsolatedWorkerProgress(evidenceDir, 'fixture-cleanup-start');
  try {
    await stopHost(disposeScenario);
    disposeScenario = undefined;
    retainIsolatedWorkerProgress(evidenceDir, 'fixture-host-stopped');
  } finally {
    // This process owns a disposable database. Reuse the maintained reset to
    // retire org, app, harness and LISTEN pools, including on assertion failure.
    // Auth's principal-invalidation LISTEN is lazy and starts fire-and-forget;
    // await its generation-aware teardown before db-org reset so a late
    // listen() completion cannot reopen the retired socket.
    const { _stopInvalidationListenerForTests } = await import('@papercusp/agent-mcp/auth');
    await _stopInvalidationListenerForTests();
    // Capture the census while the fixture-owned pools are still live. In the
    // hub scenario this is the only point where the shared listen-hub client
    // can be observed; stopping it first made the canonical cleanup assertion
    // contradict the fixture's own setup.
    // Read through the admin-only census module: harness_app cannot see other
    // roles' backends, and this file also drives the app-role pool above.
    const pgConnections = await readPgBackendCensus()
      .catch(error => {
        retainIsolatedWorkerProgress(evidenceDir, 'fixture-pg-census-unavailable', { error: String(error) });
        // A missing census is not evidence that cleanup succeeded. Keep going
        // so every owned pool is retired, but make the integration worker fail.
        process.exitCode = 1;
        console.error('STAGING_FIRST_HTTP_PG_CENSUS_UNAVAILABLE ' + String(error));
        return [];
      });
    retainIsolatedWorkerProgress(evidenceDir, 'fixture-pools-closing', { pgConnections });
    // pg-listen-hub owns a direct postgres-js connection outside db-org's
    // reset registry. Close it after the census, before resetting disposable
    // pools, or its referenced socket keeps the worker alive after a failure.
    const { _stopHubForTests } = await import('../lib/pg-listen-hub');
    await _stopHubForTests();
    await _resetForTests();
    // libuv completes socket close callbacks on the next loop turn. Record
    // after that boundary so an already-closing handle is not called a leak.
    await new Promise<void>(done => setImmediate(done));
    const report = process.report!.getReport() as { libuv?: Array<Record<string, unknown>> };
    retainIsolatedWorkerProgress(evidenceDir, 'fixture-pools-closed', {
      activeResources: process.getActiveResourcesInfo(), exitCode: process.exitCode ?? 0,
      activeSockets: (report.libuv ?? []).filter(handle => handle.type === 'tcp').slice(0, 16)
        .map(handle => ({ active: handle.is_active, referenced: handle.is_referenced,
          local: handle.localEndpoint, remote: handle.remoteEndpoint,
          creationStack: socketOrigins.get((handle.localEndpoint as { port?: number } | undefined)?.port ?? 0) ?? null,
          pgConnection: pgConnections.find(row => row.client_port ===
            (handle.localEndpoint as { port?: number } | undefined)?.port) ?? null })),
    });
    Socket.prototype.connect = originalConnect;
  }
}
