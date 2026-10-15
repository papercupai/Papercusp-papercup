import { fork, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localEsbuildNpxPath } from './test-fixtures/local-esbuild-npx';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../test/isolated-integration-proof';

const root = resolve(__dirname, '../../..');
const composer = join(root, 'papercusp-desktop/bin/vm-rig/compose-rig-sidecar-current.sh');
const workers = [
  'local-embedder-worker.script.mjs',
  'cpu-task-worker.script.mjs',
  'local-reranker-worker.script.mjs',
  'event-loop-sentinel.worker.mjs',
  'snapshot-fold.worker.mjs',
];

function tcpListening(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('TCP ownership probe timed out')); });
  });
}

describe('current-build local rig payload (not a two-machine acceptance result)', () => {
  it('emits a hash-bound payload with every required plain-Node worker without touching the remote rig', () => {
    const out = mkdtempSync(join(tmpdir(), 'current-build-rig-e2e-'));
    const compilerDir = mkdtempSync(join(tmpdir(), 'current-build-rig-compiler-'));
    try {
      const build = spawnSync('bash', [composer, '--no-push'], {
        cwd: root,
        env: { ...process.env, PATH: localEsbuildNpxPath(compilerDir, root), PCUSP_RIG_COMPOSE_OUT: out },
        encoding: 'utf8',
        timeout: 180_000,
      });
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
      const manifest = readFileSync(join(out, 'PAYLOAD-MANIFEST.sha256'), 'utf8');
      for (const worker of workers) {
        expect(manifest, worker).toContain(worker);
        const check = spawnSync('node', ['--check', join(out, worker)], { encoding: 'utf8' });
        expect(check.status, `${worker}: ${check.stderr}`).toBe(0);
      }
      const check = spawnSync('sha256sum', ['-c', 'PAYLOAD-MANIFEST.sha256'], {
        cwd: out,
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(check.status, check.stderr).toBe(0);
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(compilerDir, { recursive: true, force: true });
    }
  }, 200_000);
});

describe('current-build private runtime lifecycle', () => {
  it.each([0, 7])('retains private writes, cleanup and the original baseline (child exit %s)', async exitCode => {
    const token = randomUUID();
    const sourcePaths = ['scripts/with-test-pg.mjs', 'scripts/lib/with-test-pg-cleanup.mjs',
      'packages/operator-core/lib/identity/keychain.ts'];
    const runId = await recordIsolatedIntegrationProof({
      root,
      filePath: 'packages/operator-core/lib/staging-test-environments.e2e.test.ts',
      sourcePaths,
      retainedArtifacts: ['phases/execute/restoration-receipt.json'],
      execute: async (observe, evidenceDir) => {
        const priorListener = createServer(socket => socket.end());
        await new Promise<void>((resolve, reject) => {
          priorListener.once('error', reject);
          priorListener.listen(0, '127.0.0.1', resolve);
        });
        const priorPort = (priorListener.address() as AddressInfo).port;
        try {
        // A controlled baseline makes an escaped write observable without
        // involving the owner's actual database, keychain or home directory.
        const baselinePath = join(evidenceDir, 'prior-state.json');
        writeFileSync(baselinePath, JSON.stringify({ token, state: 'preserved' }));
        const fingerprint = () => createHash('sha256').update(readFileSync(baselinePath)).digest('hex');
        const before = fingerprint();
        const probe = `
          import assert from 'node:assert/strict';
          import { generateKeyPairSync, createHash } from 'node:crypto';
          import { spawn } from 'node:child_process';
          import { readFileSync } from 'node:fs';
          import { createServer } from 'node:net';
          import { join } from 'node:path';
          import postgres from 'postgres';
          import { keychainLoad, keychainStore } from './packages/operator-core/lib/identity/keychain.ts';
          const e = process.env;
          assert.notEqual(e.HOME, e.TEST_PRIOR_HOME);
          assert.notEqual(e.HARNESS_ADMIN_DATABASE_URL, e.TEST_PRIOR_DB);
          assert.notEqual(e.PAPERCUSP_WORKSPACE_ID, e.TEST_PRIOR_WORKSPACE);
          assert.notEqual(e.PAPERCUSP_HONO_PORT, e.TEST_PRIOR_PORT);
          assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '1');
          assert.equal(e.PAPERCUSP_IDENTITY_DIR, e.PAPERCUSP_HOME + '/identity');
          assert.ok(!e.PAPERCUSP_SUBSTRATE_IPC_SOCKET && !e.PAPERCUSP_SPAWNER_IPC_SOCKET);
          assert.ok(!e.DBUS_SESSION_BUS_ADDRESS && !e.GNOME_KEYRING_CONTROL);
          const keyId = 'current-build-e2e-' + e.TEST_LIFECYCLE_TOKEN;
          const missing = await keychainLoad(keyId);
          assert.equal(missing.kind, 'error');
          assert.equal(missing.error.kind, 'not_found');
          const { privateKey, publicKey } = generateKeyPairSync('ed25519');
          await keychainStore(keyId, privateKey.export({ type: 'pkcs8', format: 'der' }));
          assert.equal((await keychainLoad(keyId)).kind, 'ok');
          const sql = postgres(e.HARNESS_ADMIN_DATABASE_URL, { max: 1 });
          try {
            await sql.unsafe('CREATE TABLE public.current_build_lifecycle_sentinel (token text NOT NULL)');
            await sql\`INSERT INTO public.current_build_lifecycle_sentinel VALUES (\${e.TEST_LIFECYCLE_TOKEN})\`;
            const rows = await sql\`SELECT token FROM public.current_build_lifecycle_sentinel\`;
            assert.deepEqual(rows.map(row => row.token), [e.TEST_LIFECYCLE_TOKEN]);
          } finally { await sql.end(); }
          const socket = join(e.XDG_RUNTIME_DIR, 'lifecycle.sock');
          const server = createServer();
          await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
          const api = createServer();
          await new Promise((resolve, reject) => {
            api.once('error', reject); api.listen(Number(e.PAPERCUSP_HONO_PORT), '127.0.0.1', resolve);
          });
          const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
          await new Promise((resolve, reject) => { descendant.once('spawn', resolve); descendant.once('error', reject); });
          descendant.unref();
          assert.equal(JSON.parse(readFileSync(e.TEST_BASELINE_PATH, 'utf8')).state, 'preserved');
          console.log('CURRENT_BUILD_PRIVATE_RUNTIME_RECEIPT ' + JSON.stringify({
            workspace: e.PAPERCUSP_WORKSPACE_ID, home: e.HOME, socket, descendantPid: descendant.pid,
            servicePort: Number(e.PAPERCUSP_HONO_PORT),
            databasePort: new URL(e.HARNESS_ADMIN_DATABASE_URL).port,
            publicKeyHash: createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex'),
            sentinelWritten: true
          }));
          process.exit(Number(e.TEST_CHILD_EXIT));
        `;
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
          TEST_LIFECYCLE_TOKEN: token, TEST_CHILD_EXIT: String(exitCode), TEST_BASELINE_PATH: baselinePath,
          TEST_PRIOR_HOME: process.env.HOME, TEST_PRIOR_DB: process.env.HARNESS_ADMIN_DATABASE_URL,
          TEST_PRIOR_WORKSPACE: process.env.PAPERCUSP_WORKSPACE_ID,
          TEST_PRIOR_PORT: String(priorPort), PAPERCUSP_HONO_PORT: String(priorPort),
          PAPERCUSP_SUBSTRATE_IPC_SOCKET: '/prior/substrate.sock',
          PAPERCUSP_SPAWNER_IPC_SOCKET: '/prior/spawner.sock',
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/prior/keyring-bus' };
        delete env.PC_HEAVY_PREEMPT_READY_FILE;
        delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime', '--',
          process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe], {
          cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        observe(child);
        const result = await captureIsolatedWorker(child, evidenceDir, isolatedWorkerOptions(120_000));
        expect(result, result.output.slice(-6000)).toMatchObject({ code: exitCode, signal: null,
          timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        const privateLine = result.output.split('\n').find(line => line.startsWith('CURRENT_BUILD_PRIVATE_RUNTIME_RECEIPT '));
        expect(privateLine, result.output.slice(-6000)).toBeTruthy();
        const runtime = JSON.parse(privateLine!.slice('CURRENT_BUILD_PRIVATE_RUNTIME_RECEIPT '.length));
        expect(runtime).toMatchObject({ workspace: expect.stringMatching(/^test-runtime-/),
          publicKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/), sentinelWritten: true });
        const stages = result.output.split('\n').filter(line => line.startsWith('[with-test-pg] cleanup '))
          .map(line => JSON.parse(line.slice('[with-test-pg] cleanup '.length)));
        const cleanup = stages.find(row => row.stage === 'complete');
        expect(cleanup).toMatchObject({ runtimeRemoved: true, pgDataRemoved: true });
        for (const path of [runtime.home, runtime.socket, cleanup.runtimeRoot, cleanup.dataDir])
          expect(existsSync(path), path).toBe(false);
        expect(existsSync('/proc/' + runtime.descendantPid)).toBe(false);
        expect(await tcpListening(runtime.servicePort)).toBe(false);
        expect(await tcpListening(Number(runtime.databasePort))).toBe(false);
        expect(await tcpListening(priorPort)).toBe(true);
        const after = fingerprint();
        expect(after).toBe(before);
        writeFileSync(join(evidenceDir, 'restoration-receipt.json'), JSON.stringify({
          schemaVersion: 1, kind: 'current-build-baseline-restoration', childExitCode: exitCode,
          baseline: { path: baselinePath, before, after, preserved: before === after,
            servicePort: priorPort, servicePreserved: true }, runtime, cleanup,
        }, null, 2));
        } finally {
          await new Promise<void>((resolve, reject) => priorListener.close(error => error ? reject(error) : resolve()));
        }
      },
    });
    expect(runId).toBeTruthy();
  }, 360_000);
});
