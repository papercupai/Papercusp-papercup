import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureSidecarContainment, observeSidecarExit, reapDeadSidecar, sidecarContainmentCurrent } from './sidecar-exec-lifetime';
import { runCommandViaSpawnerSidecar, isSidecarInfrastructureFault } from './git-via-sidecar';
import { SpawnerIpcClient } from './spawner-ipc-client';
import { newTaskId, scopeUnitForTask } from '../task-manager/types';
import { createTextCollector } from '../child-output';
import type { SidecarContainment } from './sidecar-exec-lifetime';
import { SIDECAR_EXIT_SOCKET_IN_USE } from '../sidecar-socket/pid-keyed-socket';

// The subject here is real kernel containment, not the task ledger/flag store.
vi.mock('../task-manager/enabled', () => ({ isTaskManagerEnabled: async () => true }));
vi.mock('./spawner-sidecar-spawn', () => ({ spawnSpawnerSidecar: async () => {} }));
vi.mock('../task-manager/store', () => ({
  registerTask: async (_spec: unknown, opts: { taskId: string }) => ({ taskId: opts.taskId, state: 'pending' }),
  markSpawned: async () => {}, closeTask: async () => {},
}));
import { managedSpawn, markManagedSpawnTeardown, probeScopeSupport } from '../task-manager/managed-spawn';

const exec = promisify(execFile);
const scopes: { unit: string; child: ChildProcess }[] = [];
const dirs: string[] = [];
const helperSource = "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);";
const serverSource = `
  const helper = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helperSource)}], { stdio: ['ignore', 'pipe', 'inherit'] });
  helper.stdout.once('data', () => process.stdout.write(JSON.stringify({ pid: process.pid, helper: helper.pid }) + '\\n'));
  setInterval(() => {}, 1000);
`;

async function startScope() {
  const task = await managedSpawn(process.execPath, ['-e', serverSource], {
    class: 'sidecar', title: 'sidecar lifetime integration fixture', launchedBy: 'test:sidecar-exec-lifetime',
    argv: [process.execPath, '-e', serverSource],
  }, { scopeAvailable: true, spawnOptions: { stdio: ['ignore', 'pipe', 'pipe'] } });
  expect(task.scopeUnit).toBeTruthy();
  scopes.push({ unit: task.scopeUnit!, child: task.child });
  // Both the fault injection and afterEach are deliberate fixture teardown.
  markManagedSpawnTeardown(task.child);
  const text = createTextCollector(task.child.stdout);
  const errors = createTextCollector(task.child.stderr);
  await vi.waitFor(() => {
    if (task.child.exitCode !== null || task.child.signalCode !== null) throw new Error(`scope exited before ready: ${errors.peek()}`);
    expect(text.peek()).toContain('\n');
  }, { timeout: 10_000 });
  const { pid, helper } = JSON.parse(text.peek().trim()) as { pid: number; helper: number };
  const snapshot = captureSidecarContainment(task.scopeUnit!, pid);
  expect(snapshot).not.toBeNull();
  return { snapshot: snapshot!, pid, helper };
}

afterEach(async () => {
  for (const { unit, child } of scopes.splice(0)) {
    const closed = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'close');
    await exec('systemctl', ['--user', 'kill', '--signal=SIGKILL', unit]).catch(() => {});
    await closed;
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it.runIf(process.platform === 'linux')('proves descendant exit after real server death, preserving a different live scope', async (ctx) => {
  const support = await probeScopeSupport();
  if (!support.ok) ctx.skip(`user scopes unavailable: ${support.reason}`);
  const original = await startScope();
  const sibling = await startScope();
  expect(sidecarContainmentCurrent(original.snapshot)).toBe(true);
  expect(await reapDeadSidecar(original.snapshot)).toBe(false);
  expect(observeSidecarExit(sibling.snapshot)).toBe('alive');
  // Kill only the exact test-owned server, leaving its helper inside the scope.
  process.kill(original.pid, 'SIGKILL');
  await vi.waitFor(() => expect(observeSidecarExit(original.snapshot)).toBe('populated'));
  expect(() => process.kill(original.helper, 0)).not.toThrow();
  expect(await reapDeadSidecar(original.snapshot)).toBe(true);
  expect(observeSidecarExit(original.snapshot)).toBe('exited');
  expect(observeSidecarExit(sibling.snapshot)).toBe('alive');
  expect(() => process.kill(sibling.helper, 0)).not.toThrow();
}, 30_000);

for (const phase of ['after-mutation', 'before-admission']) {
it.runIf(process.platform === 'linux')(
  `full caller proves exit after separate IPC server death ${phase}, without replay`, async (ctx) => {
    const support = await probeScopeSupport();
    if (!support.ok) ctx.skip(`user scopes unavailable: ${support.reason}`);
    const dir = await mkdtemp(join(tmpdir(), 'sidecar-death-'));
    dirs.push(dir);
    const socketPath = join(dir, 'sidecar.sock');
    const barrier = join(dir, 'admission');
    const marker = join(dir, 'mutation');
    const taskId = newTaskId();
    const argv = ['--import', 'tsx', fileURLToPath(new URL('./fixtures/sidecar-lifetime-server.ts', import.meta.url))];
    const task = await managedSpawn(process.execPath, argv, {
      class: 'sidecar', title: 'real IPC lifetime fixture', launchedBy: 'test:sidecar-exec-lifetime', argv: [process.execPath, ...argv],
    }, { taskId, scopeAvailable: true, spawnOptions: {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PAPERCUSP_SPAWNER_IPC_SOCKET: socketPath,
        PAPERCUSP_SPAWNER_SCOPE_UNIT: scopeUnitForTask(taskId),
        ...(phase === 'before-admission' ? { PC_TEST_WAIT_ADMISSION_PATH: barrier } : {}),
      },
    } });
    expect(task.scopeUnit).toBeTruthy();
    scopes.push({ unit: task.scopeUnit!, child: task.child });
    markManagedSpawnTeardown(task.child);
    const output = createTextCollector(task.child.stdout);
    output.attach(task.child.stderr);
    await vi.waitFor(() => {
      if (task.child.exitCode !== null || task.child.signalCode !== null) throw new Error(output.peek());
      expect(output.peek()).toContain('PAPERCUSP_SPAWNER_READY');
    }, { timeout: 30_000 });
    const control = new SpawnerIpcClient(socketPath);
    const capabilities = await control.call<{ processExecContainment: SidecarContainment }>('spawn:cancel', {});
    control.close();
    const snapshot = capabilities.processExecContainment;
    expect(sidecarContainmentCurrent(snapshot)).toBe(true);
    vi.stubEnv('PAPERCUSP_SPAWNER_IPC_SOCKET', socketPath);
    const script = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'one\\n'); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;
    let killed = false;
    const killServer = () => {
      if (!killed) { killed = true; process.kill(snapshot.pid, 'SIGKILL'); }
    };
    // This deliberate server death emits correlated transport diagnostics. Assert
    // the entire chain so unrelated warnings still fail this real IPC fixture.
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const run = runCommandViaSpawnerSidecar(process.execPath, ['-e', script], {
        timeoutMs: 5000, signal: new AbortController().signal,
        onProgress: phase === 'after-mutation' ? killServer : undefined,
      });
      if (phase === 'before-admission') {
        await vi.waitFor(async () => expect(await readFile(barrier, 'utf8')).toBe('waiting'), { timeout: 5000 });
        killServer();
      }
      const result = await run;
      expect(killed).toBe(true);
      expect(result.stderr).toContain('not replayed');
      expect(isSidecarInfrastructureFault(result)).toBe(false);
      expect(observeSidecarExit(snapshot)).toBe('exited');
      if (phase === 'after-mutation') expect(await readFile(marker, 'utf8')).toBe('one\n');
      else await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      const execution = warning.mock.calls[1]?.[1] as {
        clientConnectionId: string; serverGeneration: string; connectionId: string; requestId: number;
      };
      expect(execution).toMatchObject({
        clientConnectionId: expect.any(String), serverGeneration: expect.any(String),
        connectionId: expect.any(String), requestId: expect.any(Number),
      });
      expect(execution.requestId).toBeGreaterThan(0);
      expect(warning.mock.calls).toEqual([
        ['[spawner-ipc-client-fault]', {
          event: 'peer-eof', clientConnectionId: execution.clientConnectionId,
          serverGeneration: execution.serverGeneration, serverConnectionId: execution.connectionId,
          requestId: null, method: null, relatedRequestId: null, errorCode: null, errorName: 'Error',
          activeRequests: [{
            requestId: execution.requestId, method: 'process:exec',
            callerLabel: 'git-via-sidecar.runCommandViaSpawnerSidecar',
          }],
        }],
        ['[spawner-process-exec-fault]', {
          event: 'transport-error', clientConnectionId: execution.clientConnectionId,
          serverGeneration: execution.serverGeneration, connectionId: execution.connectionId,
          requestId: execution.requestId, method: 'process:exec', errorCode: null, errorName: 'Error',
          childPid: phase === 'after-mutation' ? expect.any(Number) : null,
          elapsedMs: expect.any(Number),
          childTimeoutMs: 5000, childIdleTimeoutMs: null, rpcTimeoutMs: 40000,
        }],
        ['[spawner-ipc-client-fault]', {
          event: 'socket-error', clientConnectionId: expect.any(String),
          serverGeneration: null, serverConnectionId: null, requestId: null, method: null,
          relatedRequestId: null, errorCode: 'ECONNREFUSED', errorName: 'Error', activeRequests: [],
        }],
      ]);
      expect(warning.mock.calls[2]?.[1].clientConnectionId).not.toBe(execution.clientConnectionId);
    } finally {
      warning.mockRestore();
    }
  }, 60_000,
);
}

// host-memory-reduction-2026-09-27 P-005: a sidecar spawned onto a path a LIVE sidecar
// already serves used to unlink it and bind its own, leaving two ~2 GB sidecars running.
// The real server must now exit SIDECAR_EXIT_SOCKET_IN_USE and leave the path alone,
// including its exit hook, which would otherwise delete the live sidecar's path.
it.runIf(process.platform === 'linux')('a real server refuses a live path: exits in-use, path and listener intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sidecar-in-use-'));
  dirs.push(dir);
  const socketPath = join(dir, 'sidecar.sock');
  const live = createServer((c) => {
    c.on('error', () => {});
    c.end('live');
  }).listen(socketPath);
  await once(live, 'listening');
  try {
    const argv = ['--import', 'tsx', fileURLToPath(new URL('./fixtures/sidecar-lifetime-server.ts', import.meta.url))];
    const outcome = await exec(process.execPath, argv, {
      env: { ...process.env, PAPERCUSP_SPAWNER_IPC_SOCKET: socketPath }, timeout: 30_000,
    }).then(() => ({ code: 0, stderr: '' }), (e: { code?: number; stderr?: string }) => ({ code: e.code, stderr: e.stderr ?? '' }));
    expect(outcome.code, outcome.stderr).toBe(SIDECAR_EXIT_SOCKET_IN_USE);
    expect(outcome.stderr).toContain('EADDRINUSE');
    expect(existsSync(socketPath)).toBe(true);
    const c = createConnection(socketPath);
    c.setEncoding('utf8');
    let reply = '';
    c.on('data', (d) => (reply += d));
    await once(c, 'end');
    expect(reply).toBe('live');
  } finally {
    live.close();
  }
}, 60_000);
