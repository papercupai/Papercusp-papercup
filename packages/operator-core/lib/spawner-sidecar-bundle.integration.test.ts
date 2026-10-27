/** P-011: exercise the maintained sibling builder, including its rejected-build
 * publish contract. This guard never launches a host or uses the live database. */
import { spawnSync } from 'node:child_process';
import { DEFAULT_SPAWNER_READY_TIMEOUT_MS } from './fleet/spawner-sidecar-spawn';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');

it('builds the guarded standalone graph and preserves its prior bytes when compilation is refused', () => {
  const output = mkdtempSync(join(tmpdir(), 'papercusp-spawner-bundle-'));
  try {
    const command = 'source "$1"; bundle_host_spawner "$2" "$3" --external:typescript --external:esbuild --external:@papercusp/embedded-postgres-server --external:@embedded-postgres/* "${HOST_COMMON_EXTERNALS[@]}" "${NATIVE_PKGS[@]/#/--external:}" "$4"';
    const recipe = join(root, 'apps/operator/bin/bundle-host-common.sh');
    const build = (extra: string) => spawnSync('bash', ['-c', command, 'spawner-bundle-test', recipe, root, output, extra], {
      cwd: join(root, 'apps/operator'), encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, PAPERCUSP_MUTATION_PROBE_TMPDIR: output },
    });
    const first = build('--log-limit=20');
    expect(first.status, first.stderr + first.stdout).toBe(0);
    const entry = join(output, 'spawner-sidecar.mjs');
    const bytes = readFileSync(entry);
    const metadata = JSON.parse(readFileSync(entry + '.meta.json', 'utf8'));
    const paths: string[] = Object.keys(metadata.inputs).map(path => path.replaceAll('\\', '/'));
    expect(paths.some(path => path.endsWith('fleet/spawner-sidecar-server.ts'))).toBe(true);
    expect(paths.some(path => path.endsWith('bin/boot-malloc-arena.ts'))).toBe(true);
    expect(paths.some(path => path.endsWith('bin/boot-integrity-first.ts'))).toBe(true);
    expect(paths.some(path => path.endsWith('process-supervision/parent-death-watch.ts'))).toBe(true);
    expect(paths.some(path => path.endsWith('process-supervision/fatal-diagnostics.ts'))).toBe(true);
    expect(paths.filter(path => /bin\/(hono-host|host-handler|host-bootstrap|serve)\.ts$/.test(path))).toEqual([]);
    expect(spawnSync(process.execPath, ['--check', entry], { encoding: 'utf8' }).status).toBe(0);
    const rejected = build('--invalid-spawner-build-option');
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('invalid-spawner-build-option');
    expect(readFileSync(entry).equals(bytes)).toBe(true);
    expect(existsSync(entry + '.meta.json')).toBe(true);
    // Both maintained deploy shapes and the current-build rig stage this bundle.
    for (const [script, destination] of [
      ['apps/operator/bin/bundle-host.sh', '$OUTDIR'],
      ['papercusp-desktop/bin/build-desktop-sidecar.sh', '$SIDECAR_DIR'],
      ['papercusp-desktop/bin/vm-rig/compose-rig-sidecar-current.sh', '$OUT'],
    ]) {
      const code = readFileSync(join(root, script), 'utf8').split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
      expect(code).toContain(`bundle_host_spawner "$REPO_ROOT" "${destination}"`);
    }
  } finally { rmSync(output, { recursive: true, force: true }); }
}, 150_000);

it.each([
  { label: 'identity-less bundle', bakedSha: null },
  { label: 'baked source with a mismatched runtime environment', bakedSha: 'frozen-spawner-fixture-source' },
])('serves packaged process and invokeOnce RPC with $label and private state and graceful cleanup', ({ bakedSha }) => {
  const output = mkdtempSync(join(tmpdir(), 'papercusp-spawner-runtime-'));
  try {
    // Execute the desktop builder's actual boundary and call, rather than a
    // second hand-maintained list of externals/defines. Only output and release
    // metadata are fixture inputs; the whole distribution need not be assembled.
    const desktop = readFileSync(join(root, 'papercusp-desktop/bin/build-desktop-sidecar.sh'), 'utf8');
    const externals = desktop.match(/^HOST_EXTERNALS=\([\s\S]*?^for np in .*$/m)?.[0];
    const minify = desktop.match(/^[ \t]*MINIFY_ARGS=\(.*\)$/m)?.[0];
    const version = desktop.match(/^  VERSION_DEFINE_ARGS=\([\s\S]*?^  \)/m)?.[0];
    const spawner = desktop.match(/^bundle_host_spawner "\$REPO_ROOT" "\$SIDECAR_DIR"[\s\S]*?\|\| exit 1/m)?.[0];
    expect({ externals, minify, version, spawner }).toEqual({
      externals: expect.any(String), minify: expect.any(String), version: expect.any(String), spawner: expect.any(String),
    });
    const command = ['set -euo pipefail', 'source "$1"', 'REPO_ROOT="$2"', 'SIDECAR_DIR="$3"',
      'PAPERCUSP_DESKTOP_VERSION=0.0.0-packaged-fixture', 'PAPERCUP_DOGFOOD_REPO_REF=packaged-fixture-ref',
      externals, minify, version,
      ...(bakedSha ? [`VERSION_DEFINE_ARGS+=('--define:__PAPERCUSP_BUNDLED_SOURCE_SHA__="${bakedSha}"')`] : []),
      spawner].join('\n');
    const build = spawnSync('bash', ['-c', command, 'spawner-runtime-test',
      join(root, 'apps/operator/bin/bundle-host-common.sh'), root, output], {
      cwd: join(root, 'apps/operator'), encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, PAPERCUSP_MUTATION_PROBE_TMPDIR: output },
    });
    expect(build.status, build.stderr + build.stdout).toBe(0);
    // Host recipes externalize native/runtime dependencies. Resolve their exact
    // maintained tree while the runtime's HOME, database and workspace stay private.
    symlinkSync(join(root, 'node_modules'), join(output, 'node_modules'), 'dir');
    const reportPath = join(output, 'runtime-report.json');
    const probe = String.raw`
      const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
      const { spawn } = require('node:child_process'), { pathToFileURL } = require('node:url');
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
      (async () => {
        const e = process.env, report = { schemaVersion: 'p011-packaged-spawner-runtime-v1', incomplete: true,
          scope: 'Current maintained sibling; real RPC/server/spawn chokepoint with a harmless packaged invoke-once fixture, no native LLM agent.' };
        const publish = () => fs.writeFileSync(e.TEST_REPORT_PATH, JSON.stringify(report, null, 2));
        let host, client, tail = '', forcedCleanup = false;
        const childPids = new Set();
        try {
          assert.match(e.PAPERCUSP_WORKSPACE_ID, /^test-runtime-/);
          assert.ok(e.HOME.includes('papercusp-test-runtime-'));
          assert.ok(e.TMPDIR.startsWith(path.dirname(e.HOME)));
          assert.equal(e.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
          report.isolated = true; report.workspace = e.PAPERCUSP_WORKSPACE_ID;
          const packages = path.join(e.TMPDIR, 'packages');
          const harness = path.join(packages, 'harness'), bins = path.join(packages, 'orchestrator', 'bin');
          fs.mkdirSync(harness, { recursive: true }); fs.mkdirSync(bins, { recursive: true });
          // This is the documented packaged invoke-once seam. Only the terminal
          // agent implementation is a fixture; buildInvokeOnce + runChild remain real.
          fs.writeFileSync(path.join(bins, 'invoke-once.mjs'),
            'process.stdout.write(JSON.stringify({pid:process.pid,ppid:process.ppid,role:process.env.ROLE,extras:JSON.parse(process.env.EXTRAS_JSON),token:process.env.TEST_TOKEN,workspace:process.env.PAPERCUSP_WORKSPACE_ID,home:process.env.HOME,privateDb:process.env.DATABASE_URL.includes(":"+process.env.PAPERCUSP_PG_PORT+"/")}));');
          const { resolveSidecarSpawnPlan } = await import(pathToFileURL(path.join(e.TEST_REPO_ROOT,
            'packages/operator-core/lib/process-supervision/sidecar-spawn-shared.ts')).href);
          const { SpawnerIpcClient } = await import(pathToFileURL(path.join(e.TEST_REPO_ROOT,
            'packages/operator-core/lib/fleet/spawner-ipc-client.ts')).href);
          const socket = path.join(e.TMPDIR, 'packaged-spawner.sock');
          const plan = resolveSidecarSpawnPlan({ selfPath: path.join(e.TEST_BUNDLE_DIR, 'hono-host.mjs'),
            devScriptPath: 'unused.ts', bundledModeEnvVar: 'PAPERCUSP_SPAWNER_SIDECAR_MODE',
            execPath: process.execPath, spawnerPid: process.pid, bundledScriptName: 'spawner-sidecar.mjs' });
          assert.deepEqual(plan.args, [path.join(e.TEST_BUNDLE_DIR, 'spawner-sidecar.mjs')]);
          const readinessStartedAt = Date.now();
          host = spawn(plan.cmd, plan.args, { cwd: path.join(e.TEST_REPO_ROOT, 'apps/operator'),
            env: { ...e, ...plan.env, VITEST: '', MALLOC_ARENA_MAX: '2', PAPERCUSP_HARNESS_DIR: harness,
              PAPERCUSP_SPAWNER_IPC_SOCKET: socket, PAPERCUSP_DB_POOL_MAX: '2',
              PAPERCUSP_BACKGROUND_WORKERS: '0', PAPERCUSP_AGENT_SPAWN_SCOPE: '0',
              PAPERCUSP_BUILD_SHA: e.TEST_BAKED_SHA ? 'wrong-runtime-environment' : '',
              PAPERCUSP_BUILD_VERSION: '' },
            stdio: ['ignore', 'pipe', 'pipe'] });
          report.hostPid = host.pid; report.entry = plan.args[0];
          for (const stream of [host.stdout, host.stderr]) stream.on('data', value => { tail = (tail + value).slice(-12000); });
          const deadline = readinessStartedAt + ${DEFAULT_SPAWNER_READY_TIMEOUT_MS};
          while (!tail.includes('PAPERCUSP_SPAWNER_READY socket=' + socket) ||
              !/PAPERCUSP_SPAWNER_IDENTITY (\{[^\n]+\})/.test(tail)) {
            if (host.exitCode !== null || host.signalCode !== null) throw Error('packaged boot exited: ' + tail);
            if (Date.now() >= deadline) throw Error('packaged boot exceeded production READY budget ('
              + ${DEFAULT_SPAWNER_READY_TIMEOUT_MS} + 'ms): ' + tail);
            await wait(50);
          }
          report.ready = true;
          report.readyElapsedMs = Date.now() - readinessStartedAt;
          report.readyBudgetMs = ${DEFAULT_SPAWNER_READY_TIMEOUT_MS};
          assert.ok(report.readyElapsedMs <= ${DEFAULT_SPAWNER_READY_TIMEOUT_MS},
            'packaged sidecar READY exceeded production budget: ' + report.readyElapsedMs + 'ms');
          client = new SpawnerIpcClient(socket);
          const options = { timeoutMs: 20000, onPid: pid => childPids.add(pid) };
          const capability = await client.call('spawn:cancel', { prepareProcessExec: true }, options);
          assert.equal(capability.processExecCancellation, true);
          assert.ok(Object.hasOwn(capability.processExecFence, 'forkserverIdentity'));
          const readyIdentity = JSON.parse(tail.match(/PAPERCUSP_SPAWNER_IDENTITY (\{[^\n]+\})/)[1]);
          const expectedBuild = { sha: e.TEST_BAKED_SHA || null, version: '0.0.0-packaged-fixture' };
          assert.deepEqual(capability.processExecIdentity, { pid: host.pid, buildInfo: expectedBuild });
          assert.deepEqual(readyIdentity, { ...capability.processExecIdentity,
            serverGeneration: capability.processExecFence.serverGeneration });
          // Reconnecting proves the advertised identity belongs to this server,
          // while the request fence remains scoped to each distinct connection.
          const second = new SpawnerIpcClient(socket);
          try {
            const repeated = await second.call('spawn:cancel', {}, options);
            assert.deepEqual(repeated.processExecIdentity, capability.processExecIdentity);
            assert.equal(repeated.processExecFence.serverGeneration, readyIdentity.serverGeneration);
            assert.notEqual(repeated.processExecFence.connectionId, capability.processExecFence.connectionId);
          } finally { second.close(); }
          report.loadedIdentity = readyIdentity; report.identityConnectionChecked = true;
          const commandResult = await client.call('process:exec', { command: process.execPath,
            args: ['-e', 'process.stdout.write("packaged-process-ok")'], cwd: e.TMPDIR,
            timeoutMs: 15000, workspaceId: e.PAPERCUSP_WORKSPACE_ID, ownerId: 'p011-packaged-fixture',
            fence: capability.processExecFence }, options);
          assert.equal(commandResult.code, 0, JSON.stringify({ commandResult, tail: tail.slice(-3000) }));
          assert.equal(commandResult.stdout, 'packaged-process-ok', JSON.stringify({ commandResult }));
          report.processRpc = true;
          const invoked = await client.call('spawn:invokeOnce', { projectDir: e.TMPDIR, role: 'cup',
            extras: ['PACKAGED=1'], extraEnv: { TEST_TOKEN: 'packaged-invoke-ok', PAPERCUSP_SPAWN_BACKEND: 'omp' },
            timeoutMs: 15000 }, options);
          assert.equal(invoked.exitCode, 0, JSON.stringify(invoked));
          const value = JSON.parse(invoked.output);
          assert.equal(value.ppid, host.pid); assert.equal(value.role, 'cup');
          assert.deepEqual(value.extras, ['PACKAGED=1']); assert.equal(value.token, 'packaged-invoke-ok');
          assert.equal(value.workspace, e.PAPERCUSP_WORKSPACE_ID); assert.equal(value.home, e.HOME);
          assert.equal(value.privateDb, true); assert.ok(childPids.has(value.pid));
          report.invokeRpc = value; report.childPids = [...childPids];
          assert.ok(report.childPids.length >= 2);
          for (const pid of childPids) assert.equal(alive(pid), false);
          client.close(); client = null;
          host.kill('SIGTERM');
          const stopDeadline = Date.now() + 10000;
          while (host.exitCode === null && host.signalCode === null && Date.now() < stopDeadline) await wait(50);
          assert.equal(host.exitCode, 0, tail); assert.equal(alive(host.pid), false);
          assert.equal(fs.existsSync(socket), false);
          report.gracefulExit = true; report.socketRemoved = true; report.incomplete = false;
        } catch (error) { report.error = String(error.stack ?? error); throw error; }
        finally {
          client?.close();
          if (host && alive(host.pid)) { forcedCleanup = true; host.kill('SIGKILL'); }
          for (const pid of childPids) if (alive(pid)) { forcedCleanup = true; process.kill(pid, 'SIGKILL'); }
          report.forcedCleanup = forcedCleanup; report.tail = tail.slice(-3000); publish();
        }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const result = spawnSync(process.execPath, [join(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime', '--',
      process.execPath, '--import', 'tsx', '-e', probe], {
      cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, TEST_REPORT_PATH: reportPath, TEST_BUNDLE_DIR: output, TEST_REPO_ROOT: root,
        TEST_BAKED_SHA: bakedSha ?? '' },
    });
    const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
    expect(result.status, JSON.stringify({ report, stderr: result.stderr, stdout: result.stdout, error: result.error?.message })).toBe(0);
    expect(report).toMatchObject({ incomplete: false, isolated: true, ready: true,
      identityConnectionChecked: true, loadedIdentity: { buildInfo: { sha: bakedSha, version: '0.0.0-packaged-fixture' } },
      processRpc: true, gracefulExit: true, socketRemoved: true, forcedCleanup: false });
    console.log('PACKAGED_SPAWNER_RUNTIME_RECEIPT ' + JSON.stringify(report));
  } finally { rmSync(output, { recursive: true, force: true }); }
}, 330_000);
