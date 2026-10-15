import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GovernedExecution } from '../../resource-governor/execution';
import type { ExecParams, ExecResult } from '../../fleet/sidecar-exec-process';

const h = vi.hoisted(() => ({
  begin: vi.fn(), finished: vi.fn(), cancelled: vi.fn(), execute: vi.fn(), spawn: vi.fn(),
}));
// Reuse the maintained server/process executor with private lifecycle and receipt
// fixtures. No shared sidecar is launched, reaped, faulted or restarted.
vi.mock('../../flag-override-store-boot-effect', () => ({}));
vi.mock('../../flag-override-store', () => ({ installFlagOverrideStore: () => {} }));
vi.mock('../../flag-change-listener', () => ({ ensureFlagChangeListener: async () => {} }));
vi.mock('../../dbos/orchestrator-runner', () => ({ spawnInvokeOnce: vi.fn() }));
vi.mock('../../fleet/spawner-sidecar-spawn', () => ({ spawnSpawnerSidecar: async () => {} }));
vi.mock('../../fleet/spawner-sidecar-orphan-watchdog', () => ({ armSpawnerSidecarOrphanWatchdog: () => {} }));
vi.mock('../../fleet/spawner-socket-path', async (original) => ({
  ...await original<typeof import('../../fleet/spawner-socket-path')>(),
  reapOrphanedSpawnerSockets: () => ({ removed: [], errors: [] }),
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    h.spawn(...args);
    return actual.spawn(...args);
  } };
});
vi.mock('../../fleet/sidecar-exec-process', async (original) => {
  const actual = await original<typeof import('../../fleet/sidecar-exec-process')>();
  return { ...actual, execProcess: (
    params: ExecParams, deps: Parameters<typeof actual.execProcess>[1],
  ) => h.execute(params, () => actual.execProcess(params, {
    ...deps, beginExecution: h.begin, lazyReceiptMs: 0,
  })) };
});

// Static imports also capture original source at collection, including the
// normally lazy-loaded IPC client; late disk hashes cannot substitute for it.
import { closeSpawnerIpcClient, SpawnerIpcClient, type SpawnerCallOpts } from '../../fleet/spawner-ipc-client';
import { runSpawnerSidecarServer } from '../../fleet/spawner-sidecar-server';
import { getSidecarFallbackStats } from '../../fleet/git-via-sidecar';
import { createCommittedTreeDiagnostics, defaultBlobBatchReader, readCommittedFiles } from './committed-tree-reader';

const FILE = 'binary.dat';
let dir: string;
let repo: string;
let server: Server | undefined;
let content: Buffer;
let blob: string;
let commit: string;
const sockets = new Set<Socket>();
let handoffs: Array<{ params: ExecParams; stdin: string; modeIn: number; modeOut: number; result?: ExecResult }>;

function receipt(): GovernedExecution {
  return {
    receiptId: 'private-committed-reader',
    context: { contractVersion: 1, requestId: 'private', rootRequestId: 'private', parentRequestId: null,
      idempotencyKey: 'private', admissionClass: 'process', priority: 0, demand: { cpuWeight: 1 },
      depth: 0, createdAtMs: 1, decisionGeneration: 1 },
    lease: { leaseId: 'private', generation: 1, admissionClass: 'process', expiresAtMs: 2, owner: 'private' },
    finish: h.finished, cancel: h.cancelled,
  };
}

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=t',
    '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function readerLocalSpawns() {
  return h.spawn.mock.calls.filter(([command, args]) => command === 'git' &&
    Array.isArray(args) && args[0] === '-C' && args.includes('cat-file'));
}

async function startRealSidecar() {
  server = runSpawnerSidecarServer();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await once(server, 'listening');
}

async function expectHandoffsRemoved() {
  for (const { params } of handoffs) {
    await expect(stat(params.stdinPath!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(params.stdoutPath!)).rejects.toMatchObject({ code: 'ENOENT' });
  }
}

beforeEach(async () => {
  closeSpawnerIpcClient();
  h.spawn.mockReset();
  h.begin.mockReset().mockImplementation(async () => receipt());
  h.finished.mockReset().mockResolvedValue(true);
  h.cancelled.mockReset().mockResolvedValue(true);
  handoffs = [];
  h.execute.mockReset().mockImplementation(async (params: ExecParams, execute: () => Promise<ExecResult>) => {
    const entry = { params, stdin: await readFile(params.stdinPath!, 'utf8'),
      modeIn: (await stat(params.stdinPath!)).mode & 0o777,
      modeOut: (await stat(params.stdoutPath!)).mode & 0o777, result: undefined as ExecResult | undefined };
    handoffs.push(entry);
    entry.result = await execute();
    return entry.result;
  });
  dir = await mkdtemp(join(tmpdir(), 'committed-ipc-'));
  repo = join(dir, 'repo');
  await mkdir(repo);
  vi.stubEnv('PAPERCUSP_SPAWNER_IPC_SOCKET', join(dir, 'server.sock'));
  vi.stubEnv('PAPERCUSP_PLAN_AUDIT_SPAWN_SIDECAR', '1');
  git('init', '-q', '-b', 'main');
  // Unique content addresses prove misses without clearing the shared digest memo.
  content = Buffer.concat([Buffer.from([0, 0xff, 0x80, 0x0a]), randomBytes(32), Buffer.alloc(128 * 1024, 0xff)]);
  await writeFile(join(repo, FILE), content);
  git('add', FILE);
  git('commit', '-q', '-m', 'private cold binary fixture');
  blob = git('rev-parse', `HEAD:${FILE}`);
  commit = git('rev-parse', 'HEAD');
});

afterEach(async () => {
  closeSpawnerIpcClient();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('committed blob reader through private real IPC', () => {
  it('preserves binary bytes and cold digests, then reuses the content-addressed memo', async () => {
    await startRealSidecar();
    const wire = vi.spyOn(SpawnerIpcClient.prototype, 'call');
    const bytes = await defaultBlobBatchReader(repo, [blob]);
    expect(bytes.get(blob)).toEqual(content);
    expect(handoffs).toHaveLength(1);
    // Metadata lookup uses the fixture Git runner; the bulk bytes use the
    // production default reader, actual RPC and actual governed execProcess.
    const cold = createCommittedTreeDiagnostics();
    const deps = { git: async (_cwd: string, args: readonly string[]) => git(...args), diagnostics: cold };
    const files = await readCommittedFiles(repo, commit, [FILE, FILE], deps);
    expect(files.get(FILE)).toEqual({ path: FILE, gitBlob: blob, size: content.length,
      sha256: createHash('sha256').update(content).digest('hex') });
    expect(handoffs).toHaveLength(2); // direct read + one actual cold memo miss
    expect(cold).toEqual({ schemaVersion: 'committed-tree-diagnostics-v1', reads: 1,
      memoHits: 0, memoMisses: 1, batchAttempts: 1, batchSucceeded: 1, batchFailed: 0,
      blobsRequested: 1, blobsReturned: 1, blobsVerified: 1,
      batchRoutes: { sidecar: 1, local: 0, injected: 0 } });
    const snapshot = structuredClone(cold);
    const warm = createCommittedTreeDiagnostics();
    expect(await readCommittedFiles(repo, commit, [FILE], { ...deps, diagnostics: warm })).toEqual(files);
    expect(warm).toEqual({ ...createCommittedTreeDiagnostics(), reads: 1, memoHits: 1 });
    expect(cold).toEqual(snapshot); // another request cannot mutate this one's counters
    expect(handoffs).toHaveLength(2); // warm read spawns no additional cat-file
    for (const entry of handoffs) {
      expect(entry).toMatchObject({ stdin: `${blob}\n`, modeIn: 0o600, modeOut: 0o600,
        params: { command: 'git', args: ['cat-file', '--batch'], cwd: repo },
        result: { code: 0, stdoutBytes: Buffer.byteLength(`${blob} blob ${content.length}\n`) + content.length + 1 } });
    }
    // The server consumes callerLabel as RPC attribution rather than forwarding
    // it to execProcess, so assert it at the actual client call boundary.
    expect(wire).toHaveBeenCalledTimes(2);
    expect(wire).toHaveBeenCalledWith('process:exec', expect.objectContaining({
      callerLabel: 'git-via-sidecar.runGitStdinViaSpawnerSidecar',
    }), expect.any(Object));
    expect(h.begin).toHaveBeenCalledTimes(2);
    expect(h.finished).toHaveBeenCalledTimes(2);
    expect(readerLocalSpawns()).toEqual([]);
    await expectHandoffsRemoved();
  });

  it('preserves the real Git exit and stderr without local retry or empty success', async () => {
    await startRealSidecar();
    const nonRepo = dir;
    const before = getSidecarFallbackStats().total;
    await expect(defaultBlobBatchReader(nonRepo, [blob])).rejects.toThrow(
      `Command failed (exit 128): git -C ${nonRepo} cat-file --batch\nfatal: not a git repository`,
    );
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].result).toMatchObject({ code: 128, stdoutBytes: 0 });
    expect(getSidecarFallbackStats().total).toBe(before);
    expect(readerLocalSpawns()).toEqual([]);
    await expectHandoffsRemoved();
  });

  it.each([
    { script: 'setInterval(() => {}, 1000)', timeoutMs: 200,
      error: { code: 'ETIMEDOUT', signal: 'SIGTERM', killed: true } },
    { script: 'process.kill(process.pid, "SIGTERM")', timeoutMs: 5000,
      error: { code: null, signal: 'SIGTERM', killed: false } },
  ])('distinguishes deadline cancellation from external signal through real IPC: $error', async ({ script, timeoutMs, error }) => {
    await startRealSidecar();
    const call = SpawnerIpcClient.prototype.call;
    vi.spyOn(SpawnerIpcClient.prototype, 'call').mockImplementation(function<T>(
      this: SpawnerIpcClient, method: string, params?: unknown, opts?: SpawnerCallOpts,
    ): Promise<T> {
      // Change only the private fixture's child. The production executor,
      // transport, fd handoff and committed reader retain the actual failure.
      return call.call(this, method, method === 'process:exec' ? {
        ...(params as ExecParams), command: process.execPath, args: ['-e', script], timeoutMs,
      } : params, opts) as Promise<T>;
    });
    const diagnostics = createCommittedTreeDiagnostics();
    await expect(readCommittedFiles(repo, commit, [FILE], {
      git: async (_cwd: string, args: readonly string[]) => git(...args), diagnostics,
    })).rejects.toMatchObject({ ...error, message: expect.stringContaining(
      `no exit status; code=${error.code ?? 'none'}, signal=SIGTERM, killed=${error.killed}`,
    ) });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].result).toMatchObject({ code: -1, stdoutBytes: 0, error });
    expect(diagnostics).toMatchObject({ batchAttempts: 1, batchSucceeded: 0, batchFailed: 1,
      blobsVerified: 0, batchRoutes: { sidecar: 1, local: 0, injected: 0 } });
    expect(readerLocalSpawns()).toEqual([]);
    await expectHandoffsRemoved();
  });

  it('keeps loop turns responsive during a real RPC timeout and preserves the same error', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let received!: () => void;
    let receiveFailed!: (error: unknown) => void;
    const requestReceived = new Promise<void>((resolve, reject) => { received = resolve; receiveFailed = reject; });
    server = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += decoder.write(chunk);
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const request = JSON.parse(line) as { method: string; params: ExecParams };
          if (request.method === 'process:exec') {
            // Real transport reaches this private server; deliberately omit its reply.
            void (async () => {
              const params = request.params;
              handoffs.push({ params, stdin: await readFile(params.stdinPath!, 'utf8'),
                modeIn: (await stat(params.stdinPath!)).mode & 0o777,
                modeOut: (await stat(params.stdoutPath!)).mode & 0o777 });
              received();
            })().catch(receiveFailed);
          }
        }
      });
    });
    server.listen(process.env.PAPERCUSP_SPAWNER_IPC_SOCKET);
    await once(server, 'listening');
    const call = SpawnerIpcClient.prototype.call;
    let rpcError: unknown;
    vi.spyOn(SpawnerIpcClient.prototype, 'call').mockImplementation(function<T>(
      this: SpawnerIpcClient, method: string, params?: unknown, opts?: SpawnerCallOpts,
    ): Promise<T> {
      // Shorten only this private fixture's real RPC timer, never production limits.
      return (call.call(this, method, params, method === 'process:exec' ? { ...opts, timeoutMs: 500 } : opts) as Promise<T>)
        .catch((error: unknown) => { rpcError = error; throw error; });
    });
    const before = getSidecarFallbackStats();
    const diagnostics = createCommittedTreeDiagnostics();
    let settled = false;
    const result = readCommittedFiles(repo, commit, [FILE], {
      git: async (_cwd: string, args: readonly string[]) => git(...args), diagnostics,
    }).then(
      () => ({ error: null }), (error: unknown) => ({ error }),
    ).finally(() => { settled = true; });
    await requestReceived;
    for (let turn = 0; turn < 3; turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(readerLocalSpawns()).toEqual([]);
    }
    const { error } = await result;
    expect(error).toBe(rpcError);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('RPC request timeout: process:exec');
    expect(diagnostics).toEqual({ schemaVersion: 'committed-tree-diagnostics-v1', reads: 1,
      memoHits: 0, memoMisses: 1, batchAttempts: 1, batchSucceeded: 0, batchFailed: 1,
      blobsRequested: 1, blobsReturned: 0, blobsVerified: 0,
      batchRoutes: { sidecar: 1, local: 0, injected: 0 } });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].stdin).toBe(`${blob}\n`);
    expect(h.execute).not.toHaveBeenCalled();
    expect(readerLocalSpawns()).toEqual([]);
    const after = getSidecarFallbackStats();
    expect(after.total).toBe(before.total + 1);
    expect(after.bySubsystem['committed-tree-reader'].rejected).toBe(
      (before.bySubsystem['committed-tree-reader']?.rejected ?? 0) + 1,
    );
    expect(warnings).toHaveBeenCalledWith('[spawner-ipc-client-fault]', expect.objectContaining({
      event: 'rpc-timeout', method: 'process:exec', rpcTimeoutMs: 500,
    }));
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining('local execution avoided'));
    await expectHandoffsRemoved();
  });
});
