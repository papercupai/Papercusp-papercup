import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:net';
import type { GovernedExecution } from '../resource-governor/execution';

const h = vi.hoisted(() => ({ begin: vi.fn(), finished: vi.fn(), cancelled: vi.fn(), pending: new Set<Promise<unknown>>(), productionGrace: false }));
vi.mock('../flag-override-store-boot-effect', () => ({}));
vi.mock('../flag-override-store', () => ({ installFlagOverrideStore: () => {} }));
vi.mock('../flag-change-listener', () => ({ ensureFlagChangeListener: async () => {} }));
vi.mock('../dbos/orchestrator-runner', () => ({ spawnInvokeOnce: vi.fn() }));
vi.mock('./spawner-sidecar-spawn', () => ({ spawnSpawnerSidecar: async () => {} }));
vi.mock('./sidecar-exec-process', async (original) => {
  const actual = await original<typeof import('./sidecar-exec-process')>();
  return {
    ...actual,
    execProcess: (params: Parameters<typeof actual.execProcess>[0], deps: Parameters<typeof actual.execProcess>[1]) => {
      const result = actual.execProcess(params, { ...deps, beginExecution: h.begin,
        ...(h.productionGrace ? {} : { killGraceMs: 100 }), lazyReceiptMs: 0 });
      h.pending.add(result);
      void result.then(() => h.pending.delete(result), () => h.pending.delete(result));
      return result;
    },
  };
});

import { execProcess, PROCESS_EXEC_CALLER_LABELS, type ProcessExecCallerLabel } from './sidecar-exec-process';
import { runSpawnerSidecarServer } from './spawner-sidecar-server';
import { SpawnerIpcClient, type SpawnerCallOpts } from './spawner-ipc-client';
import { runCommandViaSpawnerSidecar, isSidecarInfrastructureFault } from './git-via-sidecar';
import * as lifetime from './sidecar-exec-lifetime';
import { DEV_DEPLOY_SIDECAR_BATCH_DEADLINE_MS, DEV_DEPLOY_SIDECAR_RPC_TIMEOUT_MS } from '../dev-deploy-state';

function receipt(): GovernedExecution {
  return {
    receiptId: 'test-exec',
    context: { contractVersion: 1, requestId: 'test', rootRequestId: 'test', parentRequestId: null,
      idempotencyKey: 'test', admissionClass: 'process', priority: 0, demand: { cpuWeight: 1 },
      depth: 0, createdAtMs: 1, decisionGeneration: 1 },
    lease: { leaseId: 'test', generation: 1, admissionClass: 'process', expiresAtMs: 2, owner: 'test' },
    finish: h.finished, cancel: h.cancelled,
  };
}

function alive(pid: number): boolean {
  if (pid <= 0) return false;
  try { process.kill(pid, 0); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw e;
  }
  if (process.platform !== 'linux') return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commEnd = stat.lastIndexOf(')');
    return stat.slice(commEnd + 2).split(' ', 1)[0] !== 'Z';
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

let server: Server;
let dir: string;
let clients: SpawnerIpcClient[];
let shutdown: () => void;
const pids = new Set<number>();
const childScript = "process.on('SIGTERM', () => setTimeout(() => { process.stdout.write('cleanup complete\\n'); process.exit(0); }, 40)); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);";

beforeEach(async () => {
  h.productionGrace = false;
  h.begin.mockReset().mockImplementation(async () => receipt());
  h.finished.mockReset().mockResolvedValue(true);
  h.cancelled.mockReset().mockResolvedValue(true);
  dir = await mkdtemp(join(tmpdir(), 'exec-cancel-'));
  vi.stubEnv('PAPERCUSP_SPAWNER_IPC_SOCKET', join(dir, 'server.sock'));
  clients = [];
  const previousSignalHandlers = new Set(process.listeners('SIGTERM'));
  server = runSpawnerSidecarServer({ slowExecMs: 40 });
  shutdown = process.listeners('SIGTERM').find((handler) => !previousSignalHandlers.has(handler)) as () => void;
  await once(server, 'listening');
});

afterEach(async () => {
  for (const client of clients) client.close();
  for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
  pids.clear();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  // A closed client rejects before the server finishes draining its child and
  // receipt. Drain those executions before the next test resets the shared mocks.
  await Promise.allSettled([...h.pending]);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function runChild(releasePath?: string, callerLabel?: ProcessExecCallerLabel) {
  const client = new SpawnerIpcClient(join(dir, 'server.sock'));
  clients.push(client);
  let requestId = 0;
  let clientConnectionId = '';
  let pid = 0;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const script = releasePath
    ? `process.on('SIGTERM', () => { const timer = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(releasePath)})) { clearInterval(timer); process.stdout.write('cleanup complete\\n'); process.exit(0); } }, 5); }); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`
    : childScript;
  const result = client.call<{ code: number; stdout: string; stderr: string }>('process:exec', {
    command: process.execPath, args: ['-e', script], timeoutMs: 5000,
    ...(callerLabel ? { callerLabel } : {}),
  }, {
    onRequestId: (id, connectionId) => { requestId = id; clientConnectionId = connectionId; },
    onPid: (value) => { pid = value; pids.add(pid); },
    onOutputActivity: () => ready(),
  });
  // Cleanup may close the socket after an earlier assertion failed. Keep that
  // secondary rejection observed without changing the result asserted by tests.
  void result.catch(() => {});
  return { client, started, result, id: () => requestId, clientConnectionId: () => clientConnectionId, pid: () => pid };
}

function recoveryClient() {
  const client = new SpawnerIpcClient(join(dir, 'server.sock'));
  clients.push(client);
  return client;
}

async function executionFence(client: SpawnerIpcClient) {
  const capabilities = await client.call<{
    processExecFence: { serverGeneration: string; connectionId: string };
    eventLoopDelayP99Ms: number;
  }>('spawn:cancel', {});
  expect(capabilities.processExecFence).toMatchObject({
    serverGeneration: expect.any(String), connectionId: expect.any(String),
  });
  expect(Number.isFinite(capabilities.eventLoopDelayP99Ms)).toBe(true);
  expect(capabilities.eventLoopDelayP99Ms).toBeGreaterThanOrEqual(0);
  return capabilities.processExecFence;
}

describe('cancellable caller with real IPC and child processes', () => {
  it('receives the child deadline result after production kill grace instead of an RPC fault', async () => {
    h.productionGrace = true;
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
    const client = recoveryClient();
    let childPid = 0;
    const result = client.call<{ code: number; stderr: string }>('process:exec', {
      command: process.execPath,
      args: ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"],
      timeoutMs: DEV_DEPLOY_SIDECAR_BATCH_DEADLINE_MS,
    }, {
      timeoutMs: DEV_DEPLOY_SIDECAR_RPC_TIMEOUT_MS,
      onPid: (pid) => { childPid = pid; pids.add(pid); },
    });
    const receipt = await result;
    expect(receipt.code).toBe(-1);
    expect(receipt.stderr).toContain(`timed out after ${DEV_DEPLOY_SIDECAR_BATCH_DEADLINE_MS}ms`);
    expect(receipt.stderr).toContain('SIGKILL');
    expect(childPid).toBeGreaterThan(0);
    expect(alive(childPid)).toBe(false);
    expect(h.finished).toHaveBeenCalledTimes(1);
    expect(logs.mock.calls.some(([tag, details]) => tag === '[spawner-process-exec-stage]' &&
      (details as { event?: string }).event === 'request-settled')).toBe(true);
  }, 30_000);

  it.each(['admission', 'settlement'] as const)('distinguishes a stalled %s from child execution without logging the payload', async (phase) => {
    const events = vi.spyOn(console, 'info').mockImplementation(() => {});
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    if (phase === 'admission') h.begin.mockImplementationOnce(async () => { await barrier; return receipt(); });
    else h.finished.mockImplementationOnce(async () => { await barrier; return true; });
    const client = recoveryClient();
    let requestId = 0;
    let clientConnectionId = '';
    let settled = false;
    const secret = 'test-only-never-log-command-arguments-or-environment';
    const result = client.call<{ code: number; stdout: string }>('process:exec', {
      command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(secret)})`],
      env: { PC_TEST_SECRET: secret }, cwd: dir, timeoutMs: 2000,
      callerLabel: PROCESS_EXEC_CALLER_LABELS.command,
    }, { onRequestId: (id, connection) => { requestId = id; clientConnectionId = connection; } });
    void result.then(() => { settled = true; }, () => {});
    const stage = phase === 'admission' ? 'admission-start' : 'settlement-start';
    const matching = () => events.mock.calls.filter(([tag, details]) =>
      tag === '[spawner-process-exec-stage]' &&
      (details as { clientConnectionId?: string; stage?: string }).clientConnectionId === clientConnectionId &&
      (details as { stage?: string }).stage === stage);
    try {
      await vi.waitFor(() => expect(matching().length).toBeGreaterThan(0));
      const details = matching()[0]![1] as Record<string, unknown>;
      const fence = await executionFence(client);
      expect(details).toMatchObject({
        serverGeneration: fence.serverGeneration, connectionId: fence.connectionId,
        clientConnectionId, requestId, callerLabel: PROCESS_EXEC_CALLER_LABELS.command,
        stage, elapsedMs: expect.any(Number),
      });
      const stages = details.stageMs as Record<string, number>;
      if (phase === 'admission') {
        expect(details.childPid).toBeNull();
        expect(stages).not.toHaveProperty('child-spawn');
        expect(stages).not.toHaveProperty('child-close');
      } else {
        expect(details.childPid).toBeGreaterThan(0);
        expect(stages).toHaveProperty('child-close');
        expect(stages).toHaveProperty('group-exit-confirmed');
        expect(stages).not.toHaveProperty('settlement-complete');
        expect(alive(details.childPid as number)).toBe(false);
      }
      expect(settled).toBe(false);
      expect(JSON.stringify(details)).not.toContain(secret);
      expect(JSON.stringify(details)).not.toContain(dir);
      expect(details).not.toHaveProperty('command');
      expect(details).not.toHaveProperty('env');
    } finally {
      release();
      expect(await result).toMatchObject({ code: 0, stdout: secret });
    }
    await vi.waitFor(() => expect(events.mock.calls.some(([tag, details]) =>
      tag === '[spawner-process-exec-stage]' &&
      (details as { clientConnectionId?: string; event?: string }).clientConnectionId === clientConnectionId &&
      (details as { event?: string }).event === 'request-settled')).toBe(true));
    const completed = events.mock.calls.find(([tag, details]) =>
      tag === '[spawner-process-exec-stage]' &&
      (details as { clientConnectionId?: string; event?: string }).clientConnectionId === clientConnectionId &&
      (details as { event?: string }).event === 'request-settled')![1] as { stageMs: Record<string, number> };
    expect(completed.stageMs).toHaveProperty('settlement-complete');
    expect(completed.stageMs).toHaveProperty('exec-complete');
  });

  it('drains a lost reply without replaying a file mutation or killing a shared sibling', async () => {
    // Kernel recovery is exercised separately against real Linux scopes in
    // sidecar-exec-lifetime.integration.test.ts. This in-process server models
    // only a transport loss; it must never try the dead-server cleanup branch.
    const snapshot = { pid: process.pid, identity: 'fixture', scopeUnit: 'pc-fixture.scope',
      cgroupPath: '/fixture', rootIdentity: 'fixture', cgroupIdentity: 'fixture' };
    const processFaults = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const drainEvents = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(lifetime, 'captureSidecarContainment').mockReturnValue(snapshot);
    vi.spyOn(lifetime, 'sidecarContainmentCurrent').mockReturnValue(true);
    const reap = vi.spyOn(lifetime, 'reapDeadSidecar');
    const sibling = runChild();
    await sibling.started;
    const marker = join(dir, 'mutation-count');
    const originalCall = SpawnerIpcClient.prototype.call;
    let executions = 0;
    let childPid = 0;
    vi.spyOn(SpawnerIpcClient.prototype, 'call').mockImplementation(function<T>(
      this: SpawnerIpcClient, method: string, params?: unknown, opts?: SpawnerCallOpts,
    ): Promise<T> {
      if (method === 'process:exec') {
        executions += 1;
        opts = { ...opts, onPid: (pid) => { childPid = pid; pids.add(pid); },
          onOutputActivity: () => this.close() };
      }
      return originalCall.call(this, method, params, opts) as Promise<T>;
    });
    const script = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'one\\n'); ${childScript}`;
    try {
      const result = await runCommandViaSpawnerSidecar(process.execPath, ['-e', script], {
        timeoutMs: 5000, signal: new AbortController().signal,
      });
      expect(childPid).toBeGreaterThan(0);
      expect(alive(childPid)).toBe(false);
      expect(await readFile(marker, 'utf8')).toBe('one\n');
      expect(executions).toBe(1);
      expect(isSidecarInfrastructureFault(result)).toBe(false);
      expect(reap).not.toHaveBeenCalled();
      expect(alive(sibling.pid())).toBe(true);
      const callerFault = processFaults.mock.calls.find(([tag]) => tag === '[spawner-process-exec-fault]')?.[1] as
        Record<string, unknown> | undefined;
      expect(callerFault).toMatchObject({
        method: 'process:exec',
        clientConnectionId: expect.any(String),
        serverGeneration: expect.any(String),
        connectionId: expect.any(String),
        requestId: expect.any(Number),
      });
      const drainEvent = drainEvents.mock.calls.find(([tag]) => tag === '[spawner-process-drain]')?.[1] as
        Record<string, unknown> | undefined;
      expect(drainEvent).toMatchObject({
        targetMethod: 'process:exec',
        targetClientConnectionId: callerFault?.clientConnectionId,
        targetServerGeneration: callerFault?.serverGeneration,
        targetConnectionId: callerFault?.connectionId,
        targetRequestId: callerFault?.requestId,
      });
      expect(JSON.stringify([callerFault, drainEvent])).not.toContain(marker);
      expect(callerFault).not.toHaveProperty('command');
      expect(callerFault).not.toHaveProperty('args');
      expect(callerFault).not.toHaveProperty('env');
    } finally {
      await sibling.client.call('spawn:cancel', { requestId: sibling.id() });
      await sibling.result;
    }
  });

  it('logs peer EOF with the active process request identity', async () => {
    const callerLabel = PROCESS_EXEC_CALLER_LABELS.command;
    const child = runChild(undefined, callerLabel);
    await child.started;
    const fence = await executionFence(child.client);
    const peerEof = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const socket = (child.client as unknown as { socket: net.Socket | null }).socket;
    if (!socket) throw new Error('client socket missing before peer EOF');
    socket.end();
    await vi.waitFor(() => expect(peerEof.mock.calls.some(([tag, details]) =>
      tag === '[spawner-socket-peer-eof]' &&
      typeof details === 'object' && details !== null &&
      (details as { clientConnectionId?: string }).clientConnectionId === child.clientConnectionId(),
    )).toBe(true));
    const event = peerEof.mock.calls.find(([tag]) => tag === '[spawner-socket-peer-eof]')?.[1] as
      { activeRequests?: Array<{ requestId: number; method: string; callerLabel?: string }> } | undefined;
    expect(event?.activeRequests).toContainEqual({ requestId: child.id(), method: 'process:exec', callerLabel });
    await recoveryClient().call('process:drain', { ...fence, requestId: child.id() });
  });

  it('logs socket errors with the active server connection and request identity', async () => {
    const socketError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const clientWarning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const accepted: net.Socket[] = [];
    const captureConnection = (socket: net.Socket): void => { accepted.push(socket); };
    server.on('connection', captureConnection);
    const callerLabel = PROCESS_EXEC_CALLER_LABELS.command;
    const child = runChild(undefined, callerLabel);
    try {
      await child.started;
      const serverSocket = accepted[0];
      if (!serverSocket) throw new Error('server socket missing after child started');
      const fence = await executionFence(child.client);
      const rejected = expect(child.result).rejects.toThrow();
      serverSocket.emit('error', Object.assign(new Error('synthetic ECONNRESET'), { code: 'ECONNRESET' }));
      serverSocket.destroy();
      await rejected;
      await recoveryClient().call('process:drain', { ...fence, requestId: child.id() });

      const fault = socketError.mock.calls.find(([tag]) => tag === '[spawner-socket-error]')?.[1] as
        Record<string, unknown> | undefined;
      expect(fault).toMatchObject({
        serverGeneration: fence.serverGeneration,
        connectionId: fence.connectionId,
        clientConnectionId: child.clientConnectionId(),
        errorCode: 'ECONNRESET',
        errorName: 'Error',
        activeRequests: [{ requestId: child.id(), method: 'process:exec', callerLabel }],
      });
      expect(JSON.stringify(fault)).not.toContain('synthetic ECONNRESET');
      expect(fault).not.toHaveProperty('command');
      expect(fault).not.toHaveProperty('args');
      expect(fault).not.toHaveProperty('env');
      const clientFault = clientWarning.mock.calls.find(([tag, details]) =>
        tag === '[spawner-ipc-client-fault]' &&
        typeof details === 'object' && details !== null &&
        (details as { event?: string }).event === 'peer-eof',
      )?.[1] as Record<string, unknown> | undefined;
      expect(clientFault).toMatchObject({
        clientConnectionId: child.clientConnectionId(),
        serverGeneration: fence.serverGeneration,
        serverConnectionId: fence.connectionId,
        activeRequests: [{ requestId: child.id(), method: 'process:exec', callerLabel }],
      });
    } finally {
      server.off('connection', captureConnection);
    }
  });

  it('omits unrecognized caller labels from client fault records', async () => {
    const clientWarning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unrecognizedCallerLabel = 'command=/secret' as ProcessExecCallerLabel;
    const child = runChild(undefined, unrecognizedCallerLabel);
    try {
      await child.started;
      const fence = await executionFence(child.client);
      const socket = (child.client as unknown as { socket: net.Socket | null }).socket;
      if (!socket) throw new Error('client socket missing before peer EOF');
      socket.end();
      await vi.waitFor(() => expect(clientWarning.mock.calls.some(([tag, details]) =>
        tag === '[spawner-ipc-client-fault]' &&
        typeof details === 'object' && details !== null &&
        (details as { event?: string }).event === 'peer-eof',
      )).toBe(true));
      const clientFault = clientWarning.mock.calls.find(([tag, details]) =>
        tag === '[spawner-ipc-client-fault]' &&
        typeof details === 'object' && details !== null &&
        (details as { event?: string }).event === 'peer-eof',
      )?.[1] as Record<string, unknown> | undefined;
      expect(JSON.stringify(clientFault)).not.toContain(unrecognizedCallerLabel);
      expect(clientFault?.activeRequests).toEqual([{ requestId: child.id(), method: 'process:exec' }]);
      await recoveryClient().call('process:drain', { ...fence, requestId: child.id() });
    } finally {
      await child.result.catch(() => {});
    }
  });
});

describe('process:drain connection-generation exit proof', () => {
  it('waits for disconnected command exit and settlement without cancelling another client', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const child = runChild(join(dir, 'release'));
    const sibling = runChild();
    await Promise.all([child.started, sibling.started]);
    const fence = await executionFence(child.client);
    let releaseSettlement!: () => void;
    h.finished.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      releaseSettlement = () => resolve(true);
    }));
    const rejected = expect(child.result).rejects.toThrow('Connection closed by caller');
    child.client.close();
    await rejected;
    let settled = false;
    const drain = recoveryClient().call('process:drain', { ...fence, requestId: child.id() });
    void drain.then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(h.finished).toHaveBeenCalledOnce());
      expect(alive(child.pid())).toBe(false);
      expect(settled).toBe(false);
      expect(alive(sibling.pid())).toBe(true);
      releaseSettlement();
      expect(await drain).toMatchObject({ exitConfirmed: true });
      expect(alive(sibling.pid())).toBe(true);
    } finally {
      releaseSettlement?.();
      await sibling.client.call('spawn:cancel', { requestId: sibling.id() });
      await sibling.result;
    }
  });

  it('revokes a connection before admission/PID and waits until it cannot launch the mutation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let admit!: (value: GovernedExecution) => void;
    h.begin.mockImplementationOnce(() => new Promise<GovernedExecution>((resolve) => { admit = resolve; }));
    const client = recoveryClient();
    const fence = await executionFence(client);
    const marker = join(dir, 'must-not-run');
    let requestId = 0;
    const onPid = vi.fn();
    const execution = client.call('process:exec', {
      command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'mutation')`],
      fence, timeoutMs: 5000,
    }, { onRequestId: (id) => { requestId = id; }, onPid });
    const rejected = expect(execution).rejects.toThrow('Socket error');
    await vi.waitFor(() => expect(h.begin).toHaveBeenCalledOnce());
    let settled = false;
    const drain = recoveryClient().call('process:drain', { ...fence, requestId });
    void drain.then(() => { settled = true; });
    await rejected;
    expect(settled).toBe(false);
    admit(receipt());
    expect(await drain).toMatchObject({ exitConfirmed: true, result: { code: -1 } });
    expect(onPid).not.toHaveBeenCalled();
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an old connection fence after reconnect, even if no request had reached admission', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = recoveryClient();
    const fence = await executionFence(client);
    expect(await recoveryClient().call('process:drain', { ...fence, requestId: 2 }))
      .toMatchObject({ exitConfirmed: true, result: null });
    client.close();
    const result = await client.call('process:exec', { command: process.execPath, args: ['-e', 'process.exit(0)'], fence });
    expect(result).toMatchObject({ code: -1, stderr: expect.stringContaining('fence mismatch') });
    expect(h.begin).not.toHaveBeenCalled();
  });

  it('refuses another server generation and same-connection drain without cancelling a live command', async () => {
    const child = runChild();
    await child.started;
    const fence = await executionFence(child.client);
    await expect(recoveryClient().call('process:drain', {
      ...fence, serverGeneration: 'previous-incarnation', requestId: child.id(),
    })).rejects.toThrow('server generation mismatch');
    await expect(child.client.call('process:drain', { ...fence, requestId: child.id() }))
      .rejects.toThrow('different connection');
    expect(alive(child.pid())).toBe(true);
    await child.client.call('spawn:cancel', { requestId: child.id() });
    await child.result;
  });

  it('confirms a completed connection without replaying a completed mutation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = recoveryClient();
    const fence = await executionFence(client);
    const marker = join(dir, 'mutation-count');
    let requestId = 0;
    expect(await client.call('process:exec', {
      command: process.execPath, args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'once\\n')`],
      fence, timeoutMs: 5000,
    }, { onRequestId: (id) => { requestId = id; } })).toMatchObject({ code: 0 });
    const recovery = recoveryClient();
    for (let i = 0; i < 2; i++) {
      expect(await recovery.call('process:drain', { ...fence, requestId }))
        .toMatchObject({ exitConfirmed: true, result: null });
    }
    expect(await readFile(marker, 'utf8')).toBe('once\n');
    expect(h.begin).toHaveBeenCalledOnce();
  });
});

describe('process:exec cancellation over the real spawner IPC protocol', () => {
  it('keeps the original request pending until graceful cleanup and actual child exit', async () => {
    const releasePath = join(dir, 'release-child');
    const child = runChild(releasePath);
    await child.started;
    expect(alive(child.pid())).toBe(true);
    let settled = false;
    void child.result.then(() => { settled = true; });
    const ack = await child.client.call('spawn:cancel', { requestId: child.id() });
    expect(ack).toMatchObject({ cancelled: true, processExecCancellation: true });
    expect(settled).toBe(false);
    await writeFile(releasePath, 'release');
    const result = await child.result;
    expect(result.code).toBe(-1);
    expect(result.stdout).toContain('cleanup complete');
    expect(result.stderr).toContain('aborted by caller');
    expect(alive(child.pid())).toBe(false);
    expect(h.finished).toHaveBeenCalledOnce();
  });

  it('does not cancel another connection whose request has the same numeric id', async () => {
    const a = runChild();
    const b = runChild();
    await Promise.all([a.started, b.started]);
    expect(a.id()).toBe(b.id());
    await a.client.call('spawn:cancel', { requestId: a.id() });
    await a.result;
    expect(alive(a.pid())).toBe(false);
    expect(alive(b.pid())).toBe(true);
    await b.client.call('spawn:cancel', { requestId: b.id() });
    await b.result;
    expect(alive(b.pid())).toBe(false);
  });

  it('rejects a disconnected caller and cancels its orphaned child on the server', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const child = runChild();
    await child.started;
    const rejection = expect(child.result).rejects.toThrow('Connection closed by caller');
    child.client.close();
    await rejection;
    await vi.waitFor(() => expect(alive(child.pid())).toBe(false));
  });

  it('drains active command exit and admission settlement before exiting on shutdown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const child = runChild();
    await child.started;
    let releaseSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => { releaseSettlement = resolve; });
    h.finished.mockImplementationOnce(async () => { await settlement; return true; });
    // Invoke only THIS server's registered handler; never send a real signal
    // to the test runner or invoke unrelated process-global signal listeners.
    const exit = vi.spyOn(process, 'exit').mockImplementation(vi.fn<typeof process.exit>());
    const rejected = expect(child.result).rejects.toThrow('Socket error');
    const closed = once(server, 'close');
    try {
      shutdown();
      await Promise.all([closed, rejected]);
      expect(exit).not.toHaveBeenCalled();
      expect(process.listeners('SIGTERM')).toContain(shutdown);
      shutdown();
      expect(exit).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(h.finished).toHaveBeenCalledOnce());
      expect(alive(child.pid())).toBe(false);
      expect(exit).not.toHaveBeenCalled();
      releaseSettlement();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
      expect(process.listeners('SIGTERM')).not.toContain(shutdown);
    } finally {
      releaseSettlement();
      await vi.waitFor(() => expect(alive(child.pid())).toBe(false));
      await vi.waitFor(() => expect(exit).toHaveBeenCalled());
      exit.mockRestore();
    }
  });

  it('exits promptly on shutdown with no active requests', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(vi.fn<typeof process.exit>());
    const closed = once(server, 'close');
    try {
      shutdown();
      await closed;
      expect(exit).toHaveBeenCalledExactlyOnceWith(0);
      expect(process.listeners('SIGTERM')).not.toContain(shutdown);
    } finally {
      exit.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('preserves a silent external termination signal in the sidecar result', async () => {
    const result = await execProcess({
      command: process.execPath, args: ['-e', "process.kill(process.pid, 'SIGTERM');"], timeoutMs: 5000,
    }, { onPid: (pid) => pids.add(pid) });
    expect(result).toMatchObject({ code: -1, stdout: '' });
    expect(result.stderr).toContain('terminated by signal SIGTERM');
    expect(h.finished).toHaveBeenCalledOnce();
  });

  it('does not spawn after cancellation while admission was pending', async () => {
    const controller = new AbortController();
    let admit!: (value: GovernedExecution) => void;
    h.begin.mockImplementation(() => new Promise<GovernedExecution>((resolve) => { admit = resolve; }));
    const onPid = vi.fn();
    const result = execProcess({ command: process.execPath, args: ['-e', 'process.exit(0)'] }, {
      signal: controller.signal, onPid,
    });
    controller.abort();
    admit(receipt());
    expect(await result).toMatchObject({ code: -1, stderr: 'process aborted before spawn' });
    expect(onPid).not.toHaveBeenCalled();
    expect(h.cancelled).toHaveBeenCalledOnce();
    expect(h.finished).not.toHaveBeenCalled();
  });

  it.each([
    { stdio: 'inherit', readyDelayMs: 0 },
    { stdio: 'ignore', readyDelayMs: 0 },
    { stdio: 'ignore', readyDelayMs: 1200 },
  ] as const)('terminates a descendant with $stdio pipes and $readyDelayMs ms startup before settling cancellation', async ({ stdio, readyDelayMs }) => {
    const readyPath = join(dir, 'descendant-ready');
    const descendant = `process.on('SIGTERM', () => {}); setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, String(process.pid)); process.send('ready'); }, ${readyDelayMs}); setInterval(() => {}, 1000);`;
    const parent = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: [${JSON.stringify(stdio)}, ${JSON.stringify(stdio)}, ${JSON.stringify(stdio)}, 'ipc'] }); child.once('message', () => process.stdout.write('descendant ready\\n')); setInterval(() => {}, 1000);`;
    const controller = new AbortController();
    let ready!: () => void;
    const descendantReady = new Promise<void>((resolve) => { ready = resolve; });
    const result = execProcess({
      command: process.execPath, args: ['-e', parent], timeoutMs: 5000,
    }, { signal: controller.signal, onPid: (pid) => pids.add(pid), onOutputActivity: ready });
    // The child's own deadline bounds startup. An explicit acknowledgement
    // proves readiness without vi.waitFor's unrelated one-second default.
    await Promise.race([descendantReady, result.then(() => { throw new Error('parent exited before descendant readiness'); })]);
    const descendantPid = Number(await readFile(readyPath, 'utf8'));
    expect(descendantPid).toBeGreaterThan(0);
    pids.add(descendantPid);
    expect(alive(descendantPid)).toBe(true);
    let descendantAliveAtSettlement: boolean | undefined;
    h.finished.mockImplementationOnce(async () => {
      descendantAliveAtSettlement = alive(descendantPid);
      return true;
    });
    controller.abort();
    expect(await result).toMatchObject({ code: -1 });
    expect(alive(descendantPid)).toBe(false);
    expect(descendantAliveAtSettlement).toBe(false);
    expect(h.finished).toHaveBeenCalledOnce();
    // The child has its own 5s startup deadline above. The test also owns
    // cancellation, group-exit confirmation and settlement after startup.
  }, 10_000);

  it('escalates an ignored abort and reports completion only after the child is dead', async () => {
    const controller = new AbortController();
    let pid = 0;
    const result = await execProcess({
      command: process.execPath,
      args: ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);"],
      timeoutMs: 5000,
    }, {
      signal: controller.signal,
      onPid: (value) => { pid = value; pids.add(pid); },
      onOutputActivity: () => controller.abort(),
    });
    expect(pid).toBeGreaterThan(0);
    expect(result.code).toBe(-1);
    expect(alive(pid)).toBe(false);
    expect(h.finished).toHaveBeenCalledOnce();
  });

  it.each(['release', 'abort', 'timeout'] as const)('waits for a helper after normal parent exit until %s', async (ending) => {
    const readyPath = join(dir, 'orphan-ready');
    const releasePath = join(dir, 'orphan-release');
    const helper = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, String(process.pid)); setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(releasePath)})) process.exit(0); }, 5);`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: 'ignore' }).unref(); const timer = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(readyPath)})) { clearInterval(timer); process.exit(0); } }, 5);`;
    const controller = new AbortController();
    let parentPid = 0;
    let parentClosed!: () => void;
    const parentExit = new Promise<void>((resolve) => { parentClosed = resolve; });
    let helperAliveAtSettlement: boolean | undefined;
    h.finished.mockImplementationOnce(async () => {
      helperAliveAtSettlement = alive(Number(await readFile(readyPath, 'utf8')));
      return true;
    });
    const result = execProcess({ command: process.execPath, args: ['-e', parent], timeoutMs: 5000 }, {
      signal: controller.signal, onPid: (pid) => { parentPid = pid; pids.add(pid); },
      onStage: (stage) => { if (stage === 'child-close') parentClosed(); },
    });
    // Wait for the observed child lifecycle instead of vi.waitFor's unrelated
    // one-second default; the command's own deadline remains authoritative.
    await parentExit;
    const helperPid = Number(await readFile(readyPath, 'utf8'));
    pids.add(helperPid);
    expect(parentPid).toBeGreaterThan(0);
    expect(alive(parentPid)).toBe(false);
    expect(alive(helperPid)).toBe(true);
    const early = await Promise.race([
      result.then(() => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 50)),
    ]);
    expect(early).toBe('pending');
    expect(h.finished).not.toHaveBeenCalled();
    if (ending === 'release') await writeFile(releasePath, 'release');
    else if (ending === 'abort') controller.abort();
    const completed = await result;
    expect(completed.code).toBe(ending === 'release' ? 0 : -1);
    expect(alive(helperPid)).toBe(false);
    expect(helperAliveAtSettlement).toBe(false);
    expect(h.finished).toHaveBeenCalledOnce();
  }, 10_000);

  it('keeps observer failures separate from child execution and settlement', async () => {
    const fail = () => { throw new Error('observer unavailable'); };
    const result = await execProcess({
      command: process.execPath, args: ['-e', "process.stdout.write('ok')"], timeoutMs: 5000,
    }, { onPid: fail, onOutputActivity: fail });
    expect(result).toMatchObject({ code: 0, stdout: 'ok' });
    expect(h.finished).toHaveBeenCalledOnce();
  });

  it('returns after child exit even when admission settlement fails', async () => {
    h.finished.mockRejectedValueOnce(new Error('settlement unavailable'));
    const result = await execProcess({
      command: process.execPath, args: ['-e', "process.stdout.write('done')"], timeoutMs: 5000,
    });
    expect(result).toMatchObject({ code: -1, stdout: 'done' });
    expect(result.stderr).toContain('admission settlement failed: Error: settlement unavailable');
    expect(h.finished).toHaveBeenCalledOnce();
  });

  it('settles failed admission cancellation before spawn without running the child', async () => {
    const handoffPath = join(dir, 'handoff-output');
    const controller = new AbortController();
    let admit!: (value: GovernedExecution) => void;
    h.begin.mockImplementation(() => new Promise<GovernedExecution>((resolve) => { admit = resolve; }));
    h.cancelled.mockRejectedValueOnce(new Error('cancellation unavailable'));
    const result = execProcess({
      command: process.execPath, args: ['-e', "process.stdout.write('must not run')"],
      stdoutPath: handoffPath,
    }, { signal: controller.signal });
    await vi.waitFor(() => expect(h.begin).toHaveBeenCalledOnce());
    controller.abort();
    admit(receipt());
    expect(await result).toMatchObject({ code: -1 });
    expect(h.cancelled).toHaveBeenCalledOnce();
    expect(await readFile(handoffPath, 'utf8')).toBe('');
    await rm(handoffPath);
  });

  it('settles a synchronous spawn failure even when admission cancellation fails', async () => {
    h.cancelled.mockRejectedValueOnce(new Error('cancellation unavailable'));
    const result = await execProcess({
      command: process.execPath, args: ['\0'], timeoutMs: 5000,
    });
    expect(result.code).toBe(-1);
    expect(result.stderr).toContain('could not spawn process');
    expect(result.stderr).toContain('admission cancellation failed');
    expect(h.cancelled).toHaveBeenCalledOnce();
  });
});
