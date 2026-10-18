import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURRENT_BUILD_TEST_CLASSES, SERVING_RUNTIMES } from './serving-runtimes';
import { resolveFsMutexLockRoot } from '../../../scripts/lib/fs-mutex.mjs';

const root = resolve(__dirname, '../../..');

describe('current-build execution route contract', () => {
  it('reaps a real detached private task scope when the supervisor is cancelled without an agent', async () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), 'private-scope-cancel-'));
    const pidPath = join(evidenceDir, 'payload.pid');
    const probe = `
      import assert from 'node:assert/strict';
      import { existsSync, readFileSync } from 'node:fs';
      import { managedSpawn } from './packages/operator-core/lib/task-manager/managed-spawn.ts';
      import { getTask } from './packages/operator-core/lib/task-manager/store.ts';
      const pidPath = process.env.PRIVATE_SCOPE_PID_PATH;
      const task = await managedSpawn(process.execPath, ['-e',
        'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', pidPath],
        { class: 'desktop', title: 'private cancellation guard', argv: [], launchedBy: 'test-private-scope' },
        { workspaceId: process.env.PAPERCUSP_WORKSPACE_ID, requireRegistration: true, confine: true,
          spawnOptions: { detached: true, stdio: 'ignore', env: process.env } });
      assert.equal(task.confined, true);
      const deadline = Date.now() + 15000;
      while (!existsSync(pidPath) && Date.now() < deadline) await new Promise(done => setTimeout(done, 50));
      assert.ok(existsSync(pidPath), 'private scope payload never started');
      const row = await getTask(task.taskId);
      assert.ok(row?.cgroupPath);
      console.log('PRIVATE_SCOPE_READY ' + JSON.stringify({ taskId: task.taskId,
        cgroupPath: row.cgroupPath, payloadPid: Number(readFileSync(pidPath, 'utf8')) }));
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
      '--isolated-runtime=operator-api', '--managed-tasks', '--', process.execPath,
      '--import', 'tsx', '--input-type=module', '-e', probe], {
      cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PRIVATE_SCOPE_PID_PATH: pidPath },
    });
    let output = '';
    let ready!: (receipt: { taskId: string; cgroupPath: string; payloadPid: number }) => void;
    const receipt = new Promise<{ taskId: string; cgroupPath: string; payloadPid: number }>(done => { ready = done; });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      const line = output.split('\n').find(row => row.startsWith('PRIVATE_SCOPE_READY '));
      if (line) ready(JSON.parse(line.slice('PRIVATE_SCOPE_READY '.length)));
    });
    child.stderr.on('data', (chunk: string) => { output += chunk; });
    const closed = new Promise<{ code: number | null; signal: string | null }>((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => done({ code, signal }));
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const task = await Promise.race([receipt, closed.then(() => { throw new Error(output.slice(-4000)); }),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('private scope startup deadline: ' + output.slice(-4000))), 150000); })]);
      clearTimeout(deadline);
      child.kill('SIGTERM');
      const result = await closed;
      expect(result, output.slice(-4000)).toEqual({ code: null, signal: 'SIGTERM' });
      expect(output).toContain('PRIVATE_MANAGED_TASK_CLEANUP ');
      expect(output).toContain('"reaped":1');
      expect(existsSync('/proc/' + task.payloadPid)).toBe(false);
      const { absCgroupDir, walkCgroupTree } = await import('./task-manager/cgroup-read');
      expect(walkCgroupTree(absCgroupDir(task.cgroupPath))).toEqual([]);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await closed; }
      rmSync(evidenceDir, { recursive: true, force: true });
    }
  }, 220000);

  it('rebuilds and repairs an auto Codex home in the private native runtime without model inference', () => {
    const probe = `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { prepareCurrentSuNativeScenario } from './packages/operator-core/test/current-su-native-http-scenario.ts';
      import { rebuildSuLaunchArtifact } from './packages/operator-core/lib/su-persona-render.ts';
      import { composeModePromptSection } from './packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-su-shared.ts';
      import { ensureSuCodexHomeConfigAsync } from './packages/operator-core/lib/role-codex-home.ts';
      import { readSuperuserToken } from './packages/operator-core/lib/superuser-token.ts';
      const workspace = process.env.PAPERCUSP_WORKSPACE_ID;
      await prepareCurrentSuNativeScenario(workspace);
      const record = { v: 1, agent: 'codex', workspaceId: workspace, harnessSlug: workspace,
        profile: 'generic', contextSize: 'trimmed', personaTier: 'full', model: 'gpt-6-luna',
        planSlug: null, launchedBy: null, autoMode: true, drainMode: false, loopArmed: false,
        headless: true, fleet: null, stack: [] };
      const rebuilt = await rebuildSuLaunchArtifact({ ownerId: 'su-private-home-repair',
        operatorBaseUrl: process.env.PAPERCUSP_OPERATOR_URL, record,
        modeSection: composeModePromptSection(record) });
      const home = await ensureSuCodexHomeConfigAsync({ sessionKey: 1,
        sid: 'su-private-home-repair', mcpUrl: rebuilt.spec.mcpUrl, promptText: rebuilt.promptText,
        model: record.model, token: readSuperuserToken(), headless: true,
        codexGatewayAuto: true, recoverMissingHome: true, trustDir: rebuilt.spec.cwd });
      assert.ok(readFileSync(home.configPath, 'utf8').includes('papercusp-codex-gateway'));
      console.log('PRIVATE_NATIVE_HOME_REPAIR ' + JSON.stringify({ repaired: home.repaired,
        promptRepaired: home.promptRepaired, providerForwarding: false }));
    `;
    const result = spawnSync(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
      '--isolated-runtime=operator-api', '--', process.execPath, '--import', 'tsx',
      '--input-type=module', '-e', probe], {
      cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
    });
    expect(result.status, result.stdout.slice(-3000) + result.stderr.slice(-5000)).toBe(0);
    expect(result.stdout).toContain('PRIVATE_NATIVE_HOME_REPAIR ');
  }, 200_000);

  it('prepares the dummy account, real hooks and MCP bearer in the native fixture private home', () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), 'private-native-setup-'));
    try {
      const result = spawnSync(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime=operator-api', '--', process.execPath, '--import', 'tsx',
        join(root, 'packages/operator-core/test/staging-first-http-fixture.ts')], {
        cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, STAGING_FIRST_HTTP_SCENARIO: 'current-su-native-setup',
          STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --trace-warnings` },
      });
      expect(result.status, result.stdout.slice(-2000) + result.stderr.slice(-2000)).toBe(0);
      const line = result.stdout.split('\n').find(row => row.startsWith('CURRENT_SU_NATIVE_SETUP_RECEIPT '));
      expect(line, result.stdout.slice(-2000)).toBeTruthy();
      const receipt = JSON.parse(line!.slice('CURRENT_SU_NATIVE_SETUP_RECEIPT '.length));
      expect(receipt).toMatchObject({
        workspace: expect.stringMatching(/^test-runtime-/), accountId: 'private-current-su',
        provider: 'codex', providerForwarding: false,
        launcherPath: join(root, 'apps/operator/scripts/psu-launcher.mjs'),
        nativeMcpAuth: { bearerPresent: true, bearerAccepted: true, privatePath: true, mode: 0o600,
          absentRejected: true, wrongRejected: true },
        nativeHookPreflight: { beforeInstall: false, configured: true, privateHookRoot: true,
          events: expect.arrayContaining(['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd']) } });
      expect(receipt.nodeOptions).not.toContain('vitest-startup-trace.mjs');
      expect(receipt.nodeOptions).not.toMatch(/(?:^|\s)(?:--import|--loader)=?tsx/);
      expect(receipt.nodeOptions).toContain('--trace-warnings');
      if (process.env.NODE_OPTIONS?.includes('committed-source-loader.mjs'))
        expect(receipt.nodeOptions).toContain('committed-source-loader.mjs');
    } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
  }, 200_000);

  it.each([
    ['pool', false], ['pool', true], ['launch', false], ['launch', true],
    ['spawn', false], ['spawn', true], ['hub', false], ['hub', true],
  ] as const)('retires private native %s pools after the fixture (failure=%s)', (kind, failure) => {
    const evidenceDir = mkdtempSync(join(tmpdir(), 'private-native-pool-cleanup-'));
    try {
      const result = spawnSync(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime=operator-api', '--', process.execPath, '--import', 'tsx',
        join(root, 'packages/operator-core/test/staging-first-http-fixture.ts')], {
        cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, STAGING_FIRST_HTTP_SCENARIO: `current-su-native-${kind}-cleanup` + (failure ? '-failure' : ''),
          STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir },
      });
      expect(result.error, result.stderr.slice(-2000)).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stdout.slice(-2000) + result.stderr.slice(-2000)).toBe(failure ? 1 : 0);
      expect(result.stdout).toContain('CURRENT_SU_NATIVE_POOL_READY ');
      if (failure) expect(result.stderr).toContain('Private native pool cleanup exception control');
      const progress = readFileSync(join(evidenceDir, 'worker-progress.ndjson'), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line));
      expect(progress.map(row => row.stage).filter(stage => stage !== 'fixture-pg-socket-opened')).toEqual([
        'fixture-cleanup-start', 'fixture-host-stopped', 'fixture-pools-closing', 'fixture-pools-closed',
      ]);
      expect(progress.at(-1)).toMatchObject({ exitCode: failure ? 1 : 0 });
      expect(progress.at(-2).pgConnections).toEqual(expect.arrayContaining([
        expect.objectContaining({ application_name: expect.any(String), client_port: expect.any(Number) }),
      ]));
      if (kind === 'hub') expect(progress.at(-2).pgConnections).toEqual(expect.arrayContaining([
        expect.objectContaining({ application_name: expect.stringMatching(/^pcusp:listen-hub:/) }),
      ]));
      // A disconnected TCP handle can retain its local endpoint for one more
      // close callback even though this child already exited normally. The
      // original native leak kept an established remote PG endpoint alive.
      // Keep that distinction alongside the authoritative child-exit guard.
      expect(progress.at(-1).activeSockets.filter((socket: any) =>
        socket.active && socket.referenced && socket.remote && socket.pgConnection)).toEqual([]);
    } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
  }, 200_000);

  it.each(['--isolated-runtime', '--isolated-runtime=operator-api'])(
    'pins the allocator before native host loading (%s)', mode => {
      const probe = `
        (async () => {
          const { planMallocArenaReexec, HOST_MALLOC_ARENA_MAX } = await import(
            require('node:path').resolve('apps/operator/bin/malloc-arena-reexec.ts'));
          const plan = planMallocArenaReexec({ platform: 'linux', env: process.env,
            execPath: process.execPath, execArgv: [], argv: [process.execPath, '/private/hono-host.mjs'],
            isMainThread: true, hasExecve: true });
          console.log('ALLOCATOR_BOOT_PROBE ' + JSON.stringify({
            plan: { action: plan.action, reason: plan.action === 'none' ? plan.reason : 'pin-missing' },
            pinned: process.env.MALLOC_ARENA_MAX === HOST_MALLOC_ARENA_MAX }));
        })().catch(error => { console.error(error); process.exitCode = 1; });`;
      const env = { ...process.env };
      delete env.MALLOC_ARENA_MAX;
      delete env.GLIBC_TUNABLES;
      const result = spawnSync(process.execPath, [join(root, 'scripts/with-test-pg.mjs'), mode,
        '--', process.execPath, '-e', probe], { cwd: root, env, encoding: 'utf8',
        timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      const line = result.stdout.split('\n').find(row => row.startsWith('ALLOCATOR_BOOT_PROBE '));
      expect(line, result.stderr + result.stdout).toBeTruthy();
      expect(JSON.parse(line!.slice('ALLOCATOR_BOOT_PROBE '.length))).toEqual({
        plan: { action: 'none', reason: 'already-set' }, pinned: true,
      });
    }, 200_000);

  it('points every declared runnable route at maintained source and a real runtime', () => {
    for (const route of CURRENT_BUILD_TEST_CLASSES) {
      if (route.runtime) expect(SERVING_RUNTIMES[route.runtime]).toBeDefined();
      if (route.readiness === 'ready' || route.readiness === 'requires-prerequisites') {
        expect(route.routeFile, route.id).not.toBeNull();
        expect(existsSync(resolve(root, route.routeFile!)), route.id).toBe(true);
      }
      expect(route.prerequisites.length, route.id).toBeGreaterThan(0);
      expect(route.verification.length, route.id).toBeGreaterThan(20);
    }
  });

  it('does not promote a separate staging API port into isolated background or data ownership', () => {
    const api = CURRENT_BUILD_TEST_CLASSES.find(({ id }) => id === 'operator-api')!;
    const background = CURRENT_BUILD_TEST_CLASSES.find(({ id }) => id === 'background-federation')!;
    expect(api.runtime).toBe('staging-operator');
    expect(api.isolation).toMatch(/database and workspace are not isolated/i);
    expect(background.runtime).toBe('bg-host');
    expect(background.readiness).toBe('requires-prerequisites');
    expect(background.route).toContain('--isolated-runtime');
    expect(background.isolation).toMatch(/device keychain/);
  });

  it('boots a private migrated background environment and cleans it after a successful child', () => {
    const wrapper = resolve(root, 'scripts/with-test-pg.mjs');
    const probe = `
      const fs = require('node:fs');
      const postgres = require('postgres');
      const e = process.env;
      const root = e.PAPERCUSP_WORKSPACES_ROOT;
      const id = e.PAPERCUSP_WORKSPACE_ID;
      (async () => {
      const { ensureFsMutexLockRoot } = await import(require('node:path').resolve('scripts/lib/fs-mutex.mjs'));
      const fsMutexRoot = await ensureFsMutexLockRoot();
      const sql = postgres(e.HARNESS_ADMIN_DATABASE_URL, { max: 1 });
      const applied = await sql.unsafe('SELECT count(*)::int AS n FROM harness_shared.schema_migrations');
      await sql.end();
      console.log('RUNTIME_PROBE ' + JSON.stringify({
        privateHome: e.HOME !== process.env.TEST_LIVE_HOME,
        homeScoped: e.PAPERCUSP_HOME === e.HOME + '/.papercusp',
        workspaceScoped: id !== process.env.TEST_LIVE_WORKSPACE && e.PAPERCUSP_WORKSPACE === id,
        registryScoped: JSON.parse(fs.readFileSync(root + '/registry.json')).current === id,
        dbScoped: e.HARNESS_ADMIN_DATABASE_URL !== process.env.TEST_LIVE_DB,
        portScoped: e.PAPERCUSP_HONO_PORT !== process.env.TEST_LIVE_PORT,
        background: e.PAPERCUSP_BACKGROUND_WORKERS === '1',
        noVitestMarker: !e.VITEST && !e.VITEST_WORKER_ID,
        noLiveCredential: !e.PAPERCUSP_SID && !e.GOOGLE_APPLICATION_CREDENTIALS,
        noLiveIpc: !e.PAPERCUSP_SUBSTRATE_IPC_SOCKET && !e.PAPERCUSP_SPAWNER_IPC_SOCKET,
        noLiveDht: !e.PAPERCUSP_DHT_BOOTSTRAP,
        noLiveAgentSocket: !e.SSH_AUTH_SOCK,
        apiScoped: e.PAPERCUSP_OPERATOR_URL === 'http://127.0.0.1:' + e.PAPERCUSP_HONO_PORT,
        routinesDisabled: e.PAPERCUSP_DBOS_ROUTINES === '0' && e.PAPERCUSP_DBOS_TIMERS === '0',
        vmScoped: e.DBOS__VMID !== process.env.TEST_LIVE_VM,
        fsMutexRootHandedOff: fsMutexRoot === e.PAPERCUSP_FS_MUTEX_LOCK_DIR &&
          e.PAPERCUSP_FS_MUTEX_LOCK_DIR === process.env.TEST_LIVE_MUTEX_ROOT,
        migrated: applied[0].n > 0,
        home: e.HOME
      }));
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const result = spawnSync(process.execPath, [wrapper, '--isolated-runtime', '--', process.execPath, '-e', probe], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        TEST_LIVE_HOME: process.env.HOME ?? '',
        TEST_LIVE_WORKSPACE: 'real-workspace',
        TEST_LIVE_DB: 'postgresql://live@localhost:5432/live',
        TEST_LIVE_PORT: '3271',
        TEST_LIVE_MUTEX_ROOT: resolveFsMutexLockRoot(process.env),
        PAPERCUSP_SID: 'live-agent',
        GOOGLE_APPLICATION_CREDENTIALS: '/do-not-inherit.json',
        PAPERCUSP_SUBSTRATE_IPC_SOCKET: '/live/substrate.sock',
        PAPERCUSP_SPAWNER_IPC_SOCKET: '/live/spawner.sock',
        PAPERCUSP_DHT_BOOTSTRAP: 'live-host:1234',
        PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070',
        SSH_AUTH_SOCK: '/live/agent.sock',
        TEST_LIVE_VM: 'live-background-vm',
        DBOS__VMID: 'live-background-vm',
      },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = result.stdout.match(/^RUNTIME_PROBE (.+)$/m)?.[1];
    expect(payload).toBeTruthy();
    const { home, ...checks } = JSON.parse(payload!) as Record<string, unknown>;
    for (const [key, value] of Object.entries(checks)) expect(value, key).toBe(true);
    expect(existsSync(home as string)).toBe(false);
  }, 125_000);

  it('captures a default coord inbox phase trace from current source in an isolated background runtime', () => {
    const wrapper = resolve(root, 'scripts/with-test-pg.mjs');
    const probe = `
      import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
      import tool from './packages/operator-core/lib/agent-tools/coordination/tools/inbox.ts';
      process.env.PAPERCUSP_COORD_INBOX_TRACE_PHASES = '1';
      const metadata = [];
      const e = process.env;
      const lag = monitorEventLoopDelay({ resolution: 10 });
      const ctx = {
        uiClientId: 'current-build-inbox-probe',
        isSuperuser: true,
        workspaceId: e.PAPERCUSP_WORKSPACE_ID,
        metadata: (value) => metadata.push(value),
        log: () => {},
        progress: () => {},
      };
      lag.enable();
      const startedAt = performance.now();
      const result = await tool.handler({}, ctx);
      const elapsedMs = Math.round(performance.now() - startedAt);
      await new Promise((resolve) => setTimeout(resolve, 30));
      lag.disable();
      const trace = metadata
        .map((value) => value?.coordInboxRead)
        .filter(Boolean)
        .at(-1) ?? null;
      console.log('INBOX_PHASE_PROBE ' + JSON.stringify({
        defaultArgs: {},
        background: e.PAPERCUSP_BACKGROUND_WORKERS === '1',
        workspaceScoped: e.PAPERCUSP_WORKSPACE === e.PAPERCUSP_WORKSPACE_ID,
        returned: Array.isArray(result?.content),
        elapsedMs,
        eventLoopMaxMs: Number.isFinite(lag.max) && lag.max > 0 ? Math.round(lag.max / 1e6) : null,
        eventLoopP99Ms: Number.isFinite(lag.percentile(99)) ? Math.round(lag.percentile(99) / 1e6) : null,
        trace,
        home: e.HOME,
      }));
    `;
    const result = spawnSync(process.execPath, [wrapper, '--isolated-runtime', '--', process.execPath,
      '--import', 'tsx', '--input-type=module', '-e', probe], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(result.status, `${result.stdout.slice(-2000)}\n${result.stderr.slice(-3000)}`).toBe(0);
    const payload = result.stdout.match(/^INBOX_PHASE_PROBE (.+)$/m)?.[1];
    expect(payload).toBeTruthy();
    const probeResult = JSON.parse(payload!);
    process.stdout.write(`INBOX_PHASE_OBSERVATION ${JSON.stringify({
      elapsedMs: probeResult.elapsedMs,
      eventLoopMaxMs: probeResult.eventLoopMaxMs,
      eventLoopP99Ms: probeResult.eventLoopP99Ms,
      phases: probeResult.trace?.phases,
    })}\n`);
    expect(probeResult.defaultArgs).toEqual({});
    expect(probeResult.background).toBe(true);
    expect(probeResult.workspaceScoped).toBe(true);
    expect(probeResult.returned).toBe(true);
    expect(probeResult.trace.request).toEqual({ hasFrom: false, directed: false, unansweredOnly: false });
    expect(probeResult.trace.phases).toContainEqual(expect.objectContaining({
      name: 'readInbox-derive', status: 'fulfilled', elapsedMs: expect.any(Number),
    }));
    expect(probeResult.trace.phases.map(({ name }: { name: string }) => name)).toEqual(expect.arrayContaining([
      'resolve-actor-identity',
      'drain-user-mailbox',
    ]));
    expect(existsSync(probeResult.home)).toBe(false);
  }, 125_000);

  it('mints a distinct device keychain identity for each isolated child', () => {
    const wrapper = resolve(root, 'scripts/with-test-pg.mjs');
    const keychainId = `current-build-isolation-${randomUUID()}`;
    const probe = `
      import { generateKeyPairSync, createHash } from 'node:crypto';
      import { keychainLoad, keychainStore } from './packages/operator-core/lib/identity/keychain.ts';
      const id = process.env.TEST_KEYCHAIN_ID;
      const before = await keychainLoad(id);
      if (before.kind !== 'error' || before.error.kind !== 'not_found') throw new Error('device key escaped its isolated home');
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      await keychainStore(id, privateKey.export({ type: 'pkcs8', format: 'der' }));
      const after = await keychainLoad(id);
      if (after.kind !== 'ok') throw new Error('private key did not persist in the isolated keychain');
      const pub = publicKey.export({ type: 'spki', format: 'der' });
      console.log('DEVICE_IDENTITY_PROBE ' + JSON.stringify({
        publicKeyHash: createHash('sha256').update(pub).digest('hex'),
        privateIdentityDir: process.env.PAPERCUSP_IDENTITY_DIR === process.env.PAPERCUSP_HOME + '/identity',
        noLiveKeyringBus: !process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.GNOME_KEYRING_CONTROL,
        home: process.env.HOME,
      }));
    `;
    const keys = [];
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, [wrapper, '--isolated-runtime', '--', process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe], {
        cwd: root, encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, TEST_KEYCHAIN_ID: keychainId, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/live/keyring-bus' },
      });
      expect(result.status, `${result.stdout.slice(-1000)}\n${result.stderr.slice(-1000)}`).toBe(0);
      const payload = result.stdout.match(/^DEVICE_IDENTITY_PROBE (.+)$/m)?.[1];
      expect(payload).toBeTruthy();
      const identity = JSON.parse(payload!) as { publicKeyHash: string; privateIdentityDir: boolean; noLiveKeyringBus: boolean; home: string };
      expect(identity.privateIdentityDir).toBe(true);
      expect(identity.noLiveKeyringBus).toBe(true);
      expect(existsSync(identity.home)).toBe(false);
      keys.push(identity.publicKeyHash);
    }
    expect(keys[0]).not.toBe(keys[1]);
  }, 245_000);

  it('preflights a private request-only API profile and reaps its real embedding sidecar', () => {
    const probe = `
      import { loadHarnessRegistry } from './packages/operator-core/lib/harness-registry.ts';
      const e = process.env;
      const registry = await loadHarnessRegistry(e.PAPERCUSP_WORKSPACE_ID, { fresh: true });
      const health = await (await fetch(e.PAPERCUSP_EMBED_SIDECAR_URL + '/healthz')).json();
      console.log('API_PROFILE_PROBE ' + JSON.stringify({
        requestOnly: e.PAPERCUSP_BACKGROUND_WORKERS === '0',
        dbosDisabled: e.PAPERCUSP_DBOS_ENABLE === '0' && e.PAPERCUSP_DBOS_ORCHESTRATOR === '0',
        homeRegistered: registry.projects.some(p => p.slug === e.PAPERCUSP_POT_HOME_SLUG && p.path.startsWith(e.PAPERCUSP_WORKSPACES_ROOT + '/')),
        privateSidecar: e.PAPERCUSP_EMBED_SIDECAR_URL !== 'http://127.0.0.1:3384' && health.capabilities.includes('POST /embed'),
        privateIngress: !!e.PAPERCUSP_EXTERNAL_INGRESS_PORT && e.PAPERCUSP_EXTERNAL_INGRESS_PORT !== e.PAPERCUSP_HONO_PORT,
        watchdogUnmodified: !e.PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB && !e.PAPERCUSP_MEMORY_WATCHDOG,
        noLiveIdentity: !e.PAPERCUSP_SID,
        home: e.HOME, sidecarPid: health.pid, sidecarUrl: e.PAPERCUSP_EMBED_SIDECAR_URL
      }));
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
      '--isolated-runtime=operator-api', '--', process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe], {
      cwd: root, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, PAPERCUSP_SID: 'live-agent', PAPERCUSP_EMBED_SIDECAR_URL: 'http://127.0.0.1:3384',
        PAPERCUSP_MEMORY_WATCHDOG: '0', PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB: '99999' },
    });
    expect(result.status, `${result.stdout.slice(-2000)}\n${result.stderr.slice(-3000)}`).toBe(0);
    const payload = result.stdout.match(/^API_PROFILE_PROBE (.+)$/m)?.[1];
    expect(payload).toBeTruthy();
    const { home, sidecarPid, sidecarUrl, ...checks } = JSON.parse(payload!);
    for (const [key, value] of Object.entries(checks)) expect(value, key).toBe(true);
    expect(existsSync(home)).toBe(false);
    expect(() => process.kill(sidecarPid, 0)).toThrow();
    expect(sidecarUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  }, 125_000);

  it('cleans the operator-api profile when the command fails', () => {
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
      '--isolated-runtime=operator-api', '--', process.execPath, '-e',
      "console.log('FAILED_API_HOME ' + process.env.HOME); process.exit(7)"], {
      cwd: root, encoding: 'utf8', timeout: 120_000,
    });
    expect(result.status, `${result.stdout.slice(-2000)}\n${result.stderr.slice(-3000)}`).toBe(7);
    const home = result.stdout.match(/^FAILED_API_HOME (.+)$/m)?.[1];
    expect(home).toBeTruthy();
    expect(existsSync(home!)).toBe(false);
  }, 125_000);

  it('serves the real paired device API in the preflighted operator-api profile', () => {
    const bundleRoot = mkdtempSync(join(tmpdir(), 'papercusp-paired-api-test-'));
    const bundle = join(bundleRoot, 'host/hono-host.mjs');
    symlinkSync(resolve(root, 'node_modules'), join(bundleRoot, 'node_modules'), 'dir');
    const probe = `
      const { spawn } = require('node:child_process');
      const path = require('node:path');
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const base = process.env.PAPERCUSP_OPERATOR_URL;
      const ingress = 'http://127.0.0.1:' + process.env.PAPERCUSP_EXTERNAL_INGRESS_PORT;
      const host = spawn(process.execPath, [process.env.TEST_BUNDLE_PATH], {
        cwd: path.join(process.cwd(), 'apps/operator'), env: process.env, stdio: ['ignore', 'pipe', 'pipe']
      });
      let head = '', tail = '', lastHttp = 'unreachable', paired = null;
      host.stdout.setEncoding('utf8');
      host.stderr.setEncoding('utf8');
      for (const stream of [host.stdout, host.stderr]) stream.on('data', (text: string) => {
        head = (head + text).slice(0, 2000); tail = (tail + text).slice(-2000);
      });
      const call = async (route, method = 'GET', body, token, origin = base) => {
        const response = await fetch(origin + route, {
          method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000)
        });
        const json = await response.json();
        if (response.status !== 200) throw new Error(route + ' returned ' + response.status + ': ' + (json.error?.code ?? json.error ?? 'unknown'));
        return json;
      };
      (async () => {
        const deadline = Date.now() + 150000;
        let ready = false;
        while (Date.now() < deadline) {
          if (host.exitCode !== null || host.signalCode !== null) throw new Error('host exited ' + host.exitCode + '/' + host.signalCode);
          try {
            const r = await fetch(base + '/api/health/ready', { signal: AbortSignal.timeout(1500) });
            const json = await r.json(); lastHttp = r.status + ' ' + JSON.stringify(json);
            if (r.status === 200 && json.ready) { ready = true; break; }
          } catch (error) { lastHttp = String(error); }
          await wait(500);
        }
        if (!ready) throw new Error('request host did not become ready');
        const blockedMint = await fetch(ingress + '/api/device/desktop/mint-pair-token', {
          method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' },
          body: JSON.stringify({ workspaceId: process.env.PAPERCUSP_WORKSPACE_ID }), signal: AbortSignal.timeout(30000)
        });
        if (blockedMint.status !== 404) throw new Error('external ingress admitted desktop mint: ' + blockedMint.status);
        const blockedRead = await fetch(ingress + '/api/device/attention', { signal: AbortSignal.timeout(30000) });
        if (![401, 403].includes(blockedRead.status)) throw new Error('external ingress admitted anonymous device read: ' + blockedRead.status);
        const mint = await call('/api/device/desktop/mint-pair-token', 'POST', { workspaceId: process.env.PAPERCUSP_WORKSPACE_ID });
        paired = await call('/api/device/pair', 'POST', { pairToken: mint.qrPayload.pairToken }, undefined, ingress);
        if (!paired.deviceId || !paired.deviceToken || paired.workspaceId !== process.env.PAPERCUSP_WORKSPACE_ID) throw new Error('pair identity mismatch');
        const paths = ['/api/device/runtime-config', '/api/device/attention', '/api/device/plans', '/api/device/monitoring', '/api/device/devices'];
        for (const route of paths) await call(route, 'GET', undefined, paired.deviceToken);
        for (const route of paths) {
          const response = await fetch(ingress + route, { headers: { authorization: 'Bearer ' + paired.deviceToken }, signal: AbortSignal.timeout(30000) });
          if (response.status !== 200) throw new Error('external paired read ' + route + ': ' + response.status);
        }
        for (const name of ['toastLog.recent', 'auditLog.recent', 'operatorScans.running', 'harnessStatus.list', 'standingCandidates.list']) {
          const json = await call('/api/device/rest-query?name=' + name + '&args=%7B%7D', 'GET', undefined, paired.deviceToken);
          if (!Array.isArray(json.rows)) throw new Error('rest-query ' + name + ' did not return rows');
        }
        console.log('PAIRED_API_PROBE ' + JSON.stringify({ paired: true, deviceReads: paths.length, externalDeviceReads: paths.length,
          deniedExternalMint: true, deniedAnonymousRead: true, restQueries: 5, home: process.env.HOME }));
      })().catch(error => {
        console.error('PAIRED_API_FAILURE ' + JSON.stringify({ message: String(error), lastHttp, exitCode: host.exitCode, signalCode: host.signalCode, head, tail }));
        process.exitCode = 1;
      }).finally(async () => {
        if (paired?.deviceId) {
          try { await call('/api/device/devices/' + paired.deviceId, 'DELETE', undefined, paired.deviceToken); }
          catch (error) { console.error('PAIR_REVOKE_FAILURE ' + String(error)); process.exitCode = 1; }
        }
        if (host.exitCode === null && host.signalCode === null) {
          const exited = new Promise(resolve => host.once('exit', resolve));
          host.kill('SIGTERM'); await Promise.race([exited, wait(5000)]);
          if (host.exitCode === null && host.signalCode === null) { host.kill('SIGKILL'); await exited; }
        }
        host.stdout.destroy(); host.stderr.destroy();
      });
    `;
    try {
      const build = spawnSync('bash', [resolve(root, 'apps/operator/bin/bundle-host.sh'), 'bin/hono-host.ts', bundle], {
        cwd: resolve(root, 'apps/operator'), encoding: 'utf8', timeout: 120_000,
      });
      expect(build.status, `${build.stdout.slice(-2000)}\n${build.stderr.slice(-2000)}`).toBe(0);
      const result = spawnSync(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime=operator-api', '--', process.execPath, '-e', probe], {
        cwd: root, encoding: 'utf8', timeout: 210_000, env: { ...process.env, TEST_BUNDLE_PATH: bundle },
      });
      const failure = result.stderr.match(/^PAIRED_API_FAILURE (.+)$/m)?.[1];
      expect(result.status, failure ?? `${result.stdout.slice(-1000)}\n${result.stderr.slice(-2000)}`).toBe(0);
      const payload = result.stdout.match(/^PAIRED_API_PROBE (.+)$/m)?.[1];
      expect(payload).toBeTruthy();
      const measured = JSON.parse(payload!);
      expect(measured.paired).toBe(true);
      expect(measured.deviceReads).toBe(5);
      expect(measured.externalDeviceReads).toBe(5);
      expect(measured.deniedExternalMint).toBe(true);
      expect(measured.deniedAnonymousRead).toBe(true);
      expect(measured.restQueries).toBe(5);
      expect(existsSync(measured.home)).toBe(false);
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true });
    }
  }, 335_000);

  it('boots the real background host with private DBOS readiness and reaps it', () => {
    const wrapper = resolve(root, 'scripts/with-test-pg.mjs');
    const bundleRoot = mkdtempSync(join(tmpdir(), 'papercusp-current-host-test-'));
    const bundle = join(bundleRoot, 'host/hono-host.mjs');
    symlinkSync(resolve(root, 'node_modules'), join(bundleRoot, 'node_modules'), 'dir');
    const probe = `
      const { spawn } = require('node:child_process');
      const path = require('node:path');
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const base = 'http://127.0.0.1:' + process.env.PAPERCUSP_HONO_PORT;
      const host = spawn(process.execPath, [process.env.TEST_BUNDLE_PATH], {
        cwd: path.join(process.cwd(), 'apps/operator'),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let head = '';
      let tail = '';
      let lastHttp = 'unreachable';
      host.stdout.setEncoding('utf8');
      host.stderr.setEncoding('utf8');
      for (const stream of [host.stdout, host.stderr]) {
        stream.on('data', (text: string) => {
          head = (head + text).slice(0, 2000);
          tail = (tail + text).slice(-2000);
        });
      }
      (async () => {
        const deadline = Date.now() + 150000;
        let readiness;
        while (Date.now() < deadline) {
          if (host.exitCode !== null) throw new Error('host exited ' + host.exitCode + ': ' + tail);
          try {
            const response = await fetch(base + '/api/health/ready', { signal: AbortSignal.timeout(1500) });
            const body = await response.json();
            lastHttp = String(response.status) + ' ' + JSON.stringify(body);
            if (response.status === 200 && body.ready && body.dbosEnabled && body.dbos) {
              readiness = body;
              break;
            }
          } catch (error) { lastHttp = String(error); }
          await wait(500);
        }
        if (!readiness) throw new Error('background DBOS did not become ready');
        const federationResponse = await fetch(base + '/api/discovery/federation-status', {
          signal: AbortSignal.timeout(10000),
        });
        const federation = await federationResponse.json();
        console.log('BACKGROUND_HOST_PROBE ' + JSON.stringify({
          privateHome: process.env.PAPERCUSP_HOME === process.env.HOME + '/.papercusp',
          privateVm: process.env.DBOS__VMID.startsWith('test-runtime-'),
          privatePort: process.env.PAPERCUSP_HONO_PORT !== '3271',
          noScheduledRoutines: process.env.PAPERCUSP_DBOS_ROUTINES === '0',
          ready: readiness.ready && readiness.dbosEnabled && readiness.dbos,
          federationRead: federationResponse.status === 200 && federation.ok === true && Array.isArray(federation.hives) && !!federation.substrate,
          home: process.env.HOME,
        }));
      })().catch((error) => {
        console.error('BACKGROUND_HOST_FAILURE ' + JSON.stringify({
          message: String(error), lastHttp, exitCode: host.exitCode, head, tail,
        }));
        process.exitCode = 1;
      }).finally(async () => {
        const exited = new Promise((resolve) => host.once('exit', resolve));
        host.kill('SIGTERM');
        await Promise.race([exited, wait(5000)]);
        if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
        host.stdout.destroy();
        host.stderr.destroy();
      });
    `;
    try {
      const build = spawnSync('bash', [resolve(root, 'apps/operator/bin/bundle-host.sh'), 'bin/hono-host.ts', bundle], {
        cwd: resolve(root, 'apps/operator'), encoding: 'utf8', timeout: 120_000,
      });
      expect(build.status, `${build.stdout.slice(-2000)}\n${build.stderr.slice(-2000)}`).toBe(0);
      const result = spawnSync(process.execPath, [wrapper, '--isolated-runtime', '--', process.execPath, '-e', probe], {
        cwd: root,
        encoding: 'utf8',
        timeout: 190_000,
        env: { ...process.env, TEST_BUNDLE_PATH: bundle },
      });
      const failure = result.stderr.match(/^BACKGROUND_HOST_FAILURE (.+)$/m)?.[1];
      expect(result.status, failure ?? `${result.stdout.slice(-1000)}\n${result.stderr.slice(-1000)}`).toBe(0);
      const payload = result.stdout.match(/^BACKGROUND_HOST_PROBE (.+)$/m)?.[1];
      expect(payload, result.stdout.slice(-4000)).toBeTruthy();
      const { home, ...checks } = JSON.parse(payload!) as Record<string, unknown>;
      for (const [key, value] of Object.entries(checks)) expect(value, key).toBe(true);
      expect(existsSync(home as string)).toBe(false);
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true });
    }
  }, 320_000);

  it('cleans the private database and device home after a failing child', () => {
    const wrapper = resolve(root, 'scripts/with-test-pg.mjs');
    const result = spawnSync(process.execPath, [
      wrapper, '--isolated-runtime', '--', process.execPath, '-e',
      "console.log('FAILED_HOME ' + process.env.HOME); process.exit(7)",
    ], { cwd: root, encoding: 'utf8', timeout: 120_000 });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(7);
    const home = result.stdout.match(/^FAILED_HOME (.+)$/m)?.[1];
    expect(home).toBeTruthy();
    expect(existsSync(home!)).toBe(false);
  }, 125_000);

  it('requires opt-in private data for mutable desktop tests and protects the release boundary', () => {
    const desktop = CURRENT_BUILD_TEST_CLASSES.find(({ id }) => id === 'desktop-native')!;
    const script = readFileSync(resolve(root, desktop.routeFile!), 'utf8');
    expect(script).toContain('VERIFY_TAURI_ISOLATED_DB=1');
    expect(desktop.prerequisites.join(' ')).toContain('VERIFY_TAURI_ISOLATED_DB=1');
    expect(CURRENT_BUILD_TEST_CLASSES.find(({ id }) => id === 'final-release')?.readiness)
      .toBe('release-only');
  });
});
