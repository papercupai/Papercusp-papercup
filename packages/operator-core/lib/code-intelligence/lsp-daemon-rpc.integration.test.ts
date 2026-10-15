import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { callLspDaemonRpc, computeLspDaemonRename, countLspDaemonDiagnostics, readLspDaemonAdmission, resyncLspDaemonDocument } from './lsp-daemon-client.ts';
import { runLspDaemonServer } from './lsp-daemon-server.ts';
import { LSP_DAEMON_SOCKET_ENV } from './lsp-daemon-socket.ts';
import { lspAdmissionController } from './lsp-admission.ts';
import type { CodeIntelAnswer } from './contracts.ts';

const root = mkdtempSync(join(tmpdir(), 'papercusp-lsp-rpc-'));
const path = join(root, 'daemon.sock');
const previous = process.env[LSP_DAEMON_SOCKET_ENV];
let server: Server | undefined;
afterEach(async () => {
  if (server) { await new Promise<void>((done) => server!.close(() => done())); server = undefined; }
  if (previous === undefined) delete process.env[LSP_DAEMON_SOCKET_ENV];
  else process.env[LSP_DAEMON_SOCKET_ENV] = previous;
  rmSync(root, { recursive: true, force: true });
});

describe('LSP daemon process boundary', () => {
  it('passes a real RPC drain to the daemon shutdown owner and aborts its outstanding work', async () => {
    process.env[LSP_DAEMON_SOCKET_ENV] = path;
    let requestSignal: AbortSignal | undefined;
    let rpcClosed: Promise<void> | undefined;
    const shutdown = vi.fn((closeRpc: () => Promise<void>) => { rpcClosed = closeRpc(); });
    const prior = new Set(process.listeners('SIGTERM'));
    server = runLspDaemonServer(async (_request, _id, signal) => {
      requestSignal = signal;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('request abandoned at shutdown');
    }, undefined, shutdown);
    await once(server, 'listening');
    const socket = connect(path);
    await once(socket, 'connect');
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'shutdown', method: 'lsp:query', params: { op: 'references', args: { rootPath: '/fixture' }, actorId: 'shutdown' } })}\n`);
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    const handlers = process.listeners('SIGTERM').filter(handler => !prior.has(handler));
    expect(handlers).toHaveLength(1);
    const clientClosed = once(socket, 'close');
    handlers[0]('SIGTERM');
    expect(shutdown).toHaveBeenCalledTimes(1);
    await rpcClosed;
    await clientClosed;
    expect(requestSignal?.aborted).toBe(true);
    expect(server.listening).toBe(false);
    expect(process.listeners('SIGTERM')).not.toContain(handlers[0]);
    server = undefined;
  });

  it('routes rename planning, diagnostic reads and resync to the daemon', async () => {
    process.env[LSP_DAEMON_SOCKET_ENV] = path;
    const methods: string[] = [];
    server = runLspDaemonServer(undefined, async (method, request) => {
      methods.push(method);
      expect(request).toMatchObject({ workspaceId: 'workspace-a', file: '/fixture/x.ts', rootPath: '/fixture' });
      if (method === 'lsp:rename') return { ok: true, edit: { changes: {} }, projectRoot: '/fixture', language: 'typescript', completenessProven: false, completenessWarning: 'unproven' };
      if (method === 'lsp:diagnostic-count') return 2;
      return true;
    });
    await once(server, 'listening');
    const base = { workspaceId: 'workspace-a', file: '/fixture/x.ts', rootPath: '/fixture' };
    expect(await computeLspDaemonRename({ ...base, line1: 1, character: 0, newName: 'renamed' })).toMatchObject({ ok: true, projectRoot: '/fixture' });
    expect(await countLspDaemonDiagnostics(base)).toBe(2);
    expect(await resyncLspDaemonDocument({ ...base, newText: 'renamed' })).toBe(true);
    expect(methods).toEqual(['lsp:rename', 'lsp:diagnostic-count', 'lsp:resync']);
  });

  it('reads the daemon-owned admission snapshot through the same socket', async () => {
    process.env[LSP_DAEMON_SOCKET_ENV] = path;
    server = runLspDaemonServer();
    await once(server, 'listening');
    const workspaceId = `lsp-rpc-test-${Date.now()}`;
    const snapshot = await readLspDaemonAdmission(workspaceId);
    expect(snapshot).toMatchObject({
      generation: lspAdmissionController(workspaceId).snapshot().generation,
      queued: 0, inFlight: 0, classes: [], settlementFailures: [],
    });
    expect(snapshot.measured).toBe(true);
    expect(snapshot.assessment).toBe('idle');
  });

  it('round-trips the closed request and aborts abandoned work without forging an empty answer', async () => {
    process.env[LSP_DAEMON_SOCKET_ENV] = path;
    const requests: Array<{ op: string; root?: string; aborted: boolean }> = [];
    const answer: CodeIntelAnswer = {
      backend: 'lsp-adapter', intent: 'references', query: 'fixture', sites: [{ path: '/fixture/x.ts', line1: 3, kind: 'reference' }],
      truncation: { truncated: false, totalAvailable: 1, continuation: null },
      freshness: { health: 'healthy', indexedAt: null, staleVsDisk: false, indexedCommit: null },
      latencyMs: 1, error: null,
    };
    let abandoned: AbortSignal | undefined;
    server = runLspDaemonServer(async (request, _id, signal) => {
      requests.push({ op: request.op, root: request.args.rootPath, aborted: signal.aborted });
      if (request.actorId === 'abandon') {
        abandoned = signal;
        await new Promise<void>((done) => signal.addEventListener('abort', () => done(), { once: true }));
      }
      return answer;
    });
    await once(server, 'listening');
    const result = await callLspDaemonRpc(path, { op: 'references', args: { rootPath: '/fixture', file: '/fixture/x.ts', line1: 3, character: 0 }, actorId: 'agent-a' });
    expect(result).toEqual(answer);
    expect(requests[0]).toEqual({ op: 'references', root: '/fixture', aborted: false });

    const socket = connect(path);
    await once(socket, 'connect');
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'abandoned', method: 'lsp:query', params: { op: 'references', args: { rootPath: '/fixture' }, actorId: 'abandon' } })}\n`);
    for (let tries = 0; !abandoned && tries < 50; tries++) await new Promise((done) => setTimeout(done, 10));
    expect(abandoned).toBeDefined();
    socket.destroy();
    await once(socket, 'close');
    expect(abandoned?.aborted).toBe(true);
  });
});
