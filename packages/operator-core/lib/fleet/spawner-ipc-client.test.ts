/**
 * spawner-ipc-client.test.ts — WI-344 ③ (plan spawner-sidecar-offload-2026-06-30).
 *
 * Proves the two properties the wrapper depends on, against a REAL line-delimited
 * JSON-RPC Unix-socket server (no mocks of net):
 *   1. id-correlated request/response — concurrent calls resolve to their OWN
 *      results even when the server replies out of order; an error reply rejects.
 *   2. server→client PUSH routing — `spawn:pid` / `spawn:outputActivity`
 *      notifications (method + params, NO id) route to the per-request `onPid` /
 *      `onOutputActivity` callbacks, keyed by `params.requestId`, with no bleed
 *      between two concurrent in-flight requests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { SpawnerIpcClient } from './spawner-ipc-client';

// Short tmpdir socket path (Unix socket paths cap ~108 chars; the scratchpad path
// is too long).
function socketPath(): string {
  return path.join(os.tmpdir(), `spawner-ipc-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

/**
 * A minimal line-delimited JSON-RPC server that exercises every client path.
 * Methods:
 *   echo   { value, delayMs? } → reply result:{ value }, optionally delayed (to
 *                                force out-of-order completion).
 *   invoke { pid }            → push spawn:pid{requestId,pid} + 2× spawn:outputActivity{requestId},
 *                                then reply result:{ output:'ok', exitCode:0, stderr:'' }.
 *   process:exec { code }     → reply result:{ code, stdout:'out', stderr:'' }.
 *   boom                      → reply error{ code:-32001, message:'kaboom' }.
 */
function startServer(sock: string): Promise<net.Server> {
  const server = net.createServer((socket) => {
    // Same StringDecoder discipline as the real server: a fake that decodes
    // per-chunk would corrupt a split multi-byte char itself and could mask
    // (or fake) the very bug the split-char test below is asserting against.
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const req = JSON.parse(line) as { method: string; params?: any; id: number };
        const send = (obj: unknown): void => void socket.write(JSON.stringify(obj) + '\n');
        if (req.method === 'echo') {
          const reply = (): void => send({ jsonrpc: '2.0', result: { value: req.params?.value }, id: req.id });
          if (req.params?.delayMs) setTimeout(reply, req.params.delayMs);
          else reply();
        } else if (req.method === 'invoke') {
          send({ jsonrpc: '2.0', method: 'spawn:pid', params: { requestId: req.id, pid: req.params?.pid } });
          send({ jsonrpc: '2.0', method: 'spawn:outputActivity', params: { requestId: req.id } });
          send({ jsonrpc: '2.0', method: 'spawn:outputActivity', params: { requestId: req.id } });
          send({ jsonrpc: '2.0', result: { output: 'ok', exitCode: 0, stderr: '' }, id: req.id });
        } else if (req.method === 'process:exec') {
          send({ jsonrpc: '2.0', result: { code: req.params?.code ?? 0, stdout: 'out', stderr: '' }, id: req.id });
        } else if (req.method === 'boom') {
          send({ jsonrpc: '2.0', error: { code: -32001, message: 'kaboom' }, id: req.id });
        }
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(sock, () => resolve(server)));
}

let server: net.Server;
let client: SpawnerIpcClient;
let sock: string;

beforeEach(async () => {
  sock = socketPath();
  server = await startServer(sock);
  client = new SpawnerIpcClient(sock);
});

afterEach(async () => {
  client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (fs.existsSync(sock)) { try { fs.unlinkSync(sock); } catch { /* removed by server.close */ } }
  vi.restoreAllMocks();
});

describe('SpawnerIpcClient — id-correlated request/response', () => {
  it('unrefs the persistent socket so it cannot keep a short-lived host alive', async () => {
    const unref = vi.spyOn(net.Socket.prototype, 'unref');
    try {
      await client.call('echo', { value: 'unref' });
      expect(unref).toHaveBeenCalled();
    } finally {
      unref.mockRestore();
    }
  });

  it('resolves concurrent calls to their OWN results even when replies arrive out of order', async () => {
    // The first call is delayed so the second completes first — only correct id
    // correlation gives each its own value.
    const slow = client.call<{ value: string }>('echo', { value: 'first', delayMs: 60 });
    const fast = client.call<{ value: string }>('echo', { value: 'second' });
    expect(await fast).toEqual({ value: 'second' });
    expect(await slow).toEqual({ value: 'first' });
  });

  it('rejects on an error response', async () => {
    await expect(client.call('boom')).rejects.toThrow(/RPC error -32001: kaboom/);
  });

  it('scans fragmented large responses in linear work before resolving the exact result', async () => {
    let assignId!: (id: number) => void;
    const assigned = new Promise<number>((resolve) => { assignId = resolve; });
    // The server leaves this request pending. Deliver deterministic socket chunks
    // ourselves: real writes can coalesce and hide the growing-prefix rescan.
    const response = client.call<{ output: string }>('hang', {}, {
      onRequestId: assignId,
      timeoutMs: 5000,
    });
    const id = await assigned;
    const socket = (client as unknown as { socket: net.Socket | null }).socket;
    if (!socket) throw new Error('client socket missing before fragmented response');
    const output = 'x'.repeat(256 * 1024);
    const wire = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result: { output } }) + '\n');
    const indexOf = String.prototype.indexOf;
    let scannedCharacters = 0;
    const scan = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
      this: string, search: string, position?: number,
    ) {
      if (search === '\n') scannedCharacters += Math.max(0, this.length - (position ?? 0));
      return indexOf.call(this, search, position);
    });
    try {
      for (let offset = 0; offset < wire.length; offset += 1024) {
        socket.emit('data', wire.subarray(offset, offset + 1024));
      }
    } finally {
      scan.mockRestore();
    }
    expect(await response).toEqual({ output });
    // Bound deterministic parser work, rather than elapsed time on a busy host.
    // JSON parsing sees the same complete frame regardless of chunk boundaries.
    expect(scannedCharacters).toBeLessThanOrEqual(wire.length * 2);
  });

  it('logs socket-error correlation without RPC params', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const accepted: net.Socket[] = [];
    const captureConnection = (socket: net.Socket): void => { accepted.push(socket); };
    server.on('connection', captureConnection);
    let requestIdentity: { requestId: number; clientConnectionId: string } | undefined;
    const request = client.call('hang', {
      command: 'private-command', args: ['private-argument'], env: { TOKEN: 'private-value' },
    }, {
      timeoutMs: 5000,
      onRequestId: (requestId, clientConnectionId) => { requestIdentity = { requestId, clientConnectionId }; },
    });
    const rejected = expect(request).rejects.toThrow('synthetic ECONNRESET');
    try {
      await vi.waitFor(() => expect(requestIdentity).toBeDefined());
      const socket = (client as unknown as { socket: net.Socket | null }).socket;
      if (!socket) throw new Error('client socket missing before synthetic error');
      socket.emit('error', Object.assign(new Error('synthetic ECONNRESET'), { code: 'ECONNRESET' }));
      socket.destroy();
      await rejected;

      const fault = warning.mock.calls.find(([tag, details]) =>
        tag === '[spawner-ipc-client-fault]' &&
        typeof details === 'object' && details !== null &&
        (details as { event?: string }).event === 'socket-error',
      )?.[1] as Record<string, unknown> | undefined;
      expect(fault).toMatchObject({
        event: 'socket-error',
        clientConnectionId: requestIdentity?.clientConnectionId,
        errorCode: 'ECONNRESET',
        errorName: 'Error',
        activeRequests: [{ requestId: requestIdentity?.requestId, method: 'hang' }],
      });
      expect(JSON.stringify(fault)).not.toMatch(/private-command|private-argument|private-value|TOKEN|synthetic ECONNRESET/);
    } finally {
      server.off('connection', captureConnection);
      for (const socket of accepted) socket.destroy();
    }
  });

  it('logs timeout correlation without copying command, args, or env', async () => {
    const p = socketPath();
    let received: { id: number; clientConnectionId: string } | undefined;
    const stalledServer = net.createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        received = JSON.parse(buffer.slice(0, newline)) as { id: number; clientConnectionId: string };
      });
    });
    await new Promise<void>((resolve) => stalledServer.listen(p, resolve));
    const stalledClient = new SpawnerIpcClient(p);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(stalledClient.call('process:exec', {
        command: 'private-command', args: ['private-argument'], env: { TOKEN: 'private-value' },
        callerLabel: 'git-via-sidecar.runCommandViaSpawnerSidecar',
      }, { timeoutMs: 50 })).rejects.toThrow('RPC request timeout: process:exec');
      expect(received).toBeDefined();
      const fault = warning.mock.calls.find(([tag, details]) =>
        tag === '[spawner-ipc-client-fault]' &&
        typeof details === 'object' && details !== null &&
        (details as { event?: string }).event === 'rpc-timeout',
      )?.[1] as Record<string, unknown> | undefined;
      expect(fault).toMatchObject({
        event: 'rpc-timeout', method: 'process:exec', requestId: received?.id,
        clientConnectionId: received?.clientConnectionId,
        activeRequests: [{
          requestId: received?.id, method: 'process:exec',
          callerLabel: 'git-via-sidecar.runCommandViaSpawnerSidecar',
        }],
        rpcTimeoutMs: 50,
      });
      expect(fault?.elapsedMs).toEqual(expect.any(Number));
      expect(fault?.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(fault).not.toHaveProperty('command');
      expect(fault).not.toHaveProperty('args');
      expect(fault).not.toHaveProperty('env');
      expect(JSON.stringify(fault)).not.toMatch(/private-command|private-argument|private-value|TOKEN/);
    } finally {
      stalledClient.close();
      await new Promise<void>((resolve) => stalledServer.close(() => resolve()));
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* removed by close */ } }
    }
  });
});

describe('SpawnerIpcClient — server→client PUSH (notification) routing', () => {
  it('routes spawn:pid / spawn:outputActivity to the per-request callbacks and still resolves the result', async () => {
    const pids: number[] = [];
    let activity = 0;
    const result = await client.call<{ output: string; exitCode: number; stderr: string }>(
      'invoke',
      { pid: 4242 },
      { onPid: (pid) => pids.push(pid), onOutputActivity: () => { activity += 1; } },
    );
    expect(result).toEqual({ output: 'ok', exitCode: 0, stderr: '' });
    expect(pids).toEqual([4242]);
    expect(activity).toBe(2);
  });

  it('keys callbacks per-request — two concurrent invokes never cross their notifications', async () => {
    const aPids: number[] = [];
    const bPids: number[] = [];
    const a = client.call('invoke', { pid: 111 }, { onPid: (p) => aPids.push(p) });
    const b = client.call('invoke', { pid: 222 }, { onPid: (p) => bPids.push(p) });
    await Promise.all([a, b]);
    expect(aPids).toEqual([111]);
    expect(bPids).toEqual([222]);
  });

  it('surfaces the assigned request id synchronously via onRequestId (for cancel wiring)', async () => {
    let captured: number | undefined;
    await client.call('echo', { value: 'x' }, { onRequestId: (id) => { captured = id; } });
    expect(typeof captured).toBe('number');
    expect(captured).toBeGreaterThan(0);
  });

  it('supports generic process:exec responses used by git-sync sidecar routing', async () => {
    const result = await client.call<{ code: number; stdout: string; stderr: string }>(
      'process:exec',
      { code: 7 },
      { timeoutMs: 1000 },
    );
    expect(result).toEqual({ code: 7, stdout: 'out', stderr: '' });
  });
});

describe('SpawnerIpcClient — multi-byte UTF-8 split across socket chunks (WI-6699)', () => {
  it('decodes a response whose multi-byte character straddles two socket chunks', async () => {
    // Regression for the silent-corruption mode. Under a per-chunk
    // `chunk.toString()` each half decodes independently, so the straddled
    // character becomes U+FFFD replacement chars. The nasty part is that the
    // damage lands INSIDE a JSON string value, so the response still PARSES —
    // the caller silently accepts a wrong value with no error raised anywhere.
    // Chunk boundaries are set by the kernel, so in production this presents
    // as a rare, unreproducible wrong result rather than a crash.
    const payload = 'café 日本語 🎉 branch';
    const splitSock = socketPath();

    const splitServer = net.createServer((socket) => {
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const req = JSON.parse(line) as { id: number };
          const full = Buffer.from(
            `${JSON.stringify({ jsonrpc: '2.0', result: { value: payload }, id: req.id })}\n`,
            'utf8',
          );
          // Cut BETWEEN the two bytes of the 'é' in 'café'.
          const eIdx = full.indexOf(Buffer.from('é', 'utf8'));
          expect(eIdx).toBeGreaterThan(-1);
          const cut = eIdx + 1;
          socket.write(full.subarray(0, cut));
          // A later tick guarantees a genuinely separate 'data' event rather
          // than one coalesced write (which would not exercise the bug).
          setTimeout(() => socket.write(full.subarray(cut)), 20);
        }
      });
    });

    await new Promise<void>((resolve) => splitServer.listen(splitSock, () => resolve()));
    const splitClient = new SpawnerIpcClient(splitSock);
    try {
      const res = await splitClient.call<{ value: string }>('echo', {}, { timeoutMs: 2000 });
      expect(res.value).toBe(payload);
      expect(res.value).not.toContain('�');
    } finally {
      splitClient.close();
      await new Promise<void>((resolve) => splitServer.close(() => resolve()));
      if (fs.existsSync(splitSock)) {
        try { fs.unlinkSync(splitSock); } catch { /* removed by server.close */ }
      }
    }
  });
});

/**
 * WI-2141693 — the client latched onto a dead connection forever.
 *
 * Measured on the tower 2026-09-02: the spawner-sidecar crashed (exit 7) and
 * RESPAWNED 11s later on the same socket path, yet bg-host logged 333+
 * `spawner-sidecar git unavailable, using local spawn` lines over the next 99
 * minutes, every one of them `Cannot call write after a stream was destroyed`.
 * Fallback counters climbed to pot-git 13,230 / harness-docs 3,423 /
 * git-sync 1,922, and only a bg-host restart cleared it.
 *
 * The mechanism is a settled-promise latch in `ensureConnected()`:
 * `connectPromise` was never cleared once settled, so after `connected` went
 * false the guard `if (this.connectPromise) return this.connectPromise` handed
 * back the ALREADY-SETTLED promise and no re-dial ever happened. `call()`'s
 * `if (!this.socket)` check then passed — a destroyed socket is still
 * non-null — and wrote into it.
 *
 * It latches in BOTH directions, which is why there are two cases here: a
 * settled-RESOLVED promise after a death, and a settled-REJECTED promise after
 * a failed first dial (a sidecar not yet listening would then stay unreachable
 * for the life of the process, even once it came up).
 *
 * The sibling substrate client already carries this fix (WI-895); this client
 * was cloned from it and never received it.
 */
describe('SpawnerIpcClient — re-dials a replacement sidecar (WI-2141693)', () => {
  /** Echo server that tracks live connections so a sidecar DEATH can be simulated. */
  async function startTrackedServer(p: string): Promise<{ server: net.Server; killConnections: () => void }> {
    const conns = new Set<net.Socket>();
    const srv = net.createServer((socket) => {
      conns.add(socket);
      socket.on('close', () => conns.delete(socket));
      socket.on('error', () => {});
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const req = JSON.parse(line) as { params?: { value?: string }; id: number };
          socket.write(JSON.stringify({ jsonrpc: '2.0', result: { value: req.params?.value }, id: req.id }) + '\n');
        }
      });
    });
    await new Promise<void>((resolve) => srv.listen(p, () => resolve()));
    return { server: srv, killConnections: () => { for (const c of conns) c.destroy(); } };
  }

  it('reconnects after the sidecar dies and a replacement listens on the same path', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = socketPath();
    let live = await startTrackedServer(p);
    const c = new SpawnerIpcClient(p);
    try {
      expect(await c.call<{ value: string }>('echo', { value: 'before' }, { timeoutMs: 3000 })).toEqual({
        value: 'before',
      });

      // The sidecar dies: its connections drop and it stops listening.
      live.killConnections();
      await new Promise<void>((resolve) => live.server.close(() => resolve()));
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* already gone */ } }

      // Let the client actually OBSERVE the disconnect. Measured with a
      // standalone probe: after a peer destroy Node delivers 'end'/'close' a
      // macrotask or two later, NOT synchronously — immediately after
      // `server.close()` resolves the socket still reads
      // `destroyed=false, readyState='open'`. Production had 11 seconds and 99
      // minutes here, so this models the real sequence; without it the test
      // would be asserting on the inherent death-to-EOF race (covered
      // separately below) instead of on the latch.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      // ...and the sidecar respawns on the SAME socket path.
      live = await startTrackedServer(p);

      // Pre-fix this rejects with "Cannot call write after a stream was
      // destroyed" — permanently, for the life of the process.
      expect(await c.call<{ value: string }>('echo', { value: 'after' }, { timeoutMs: 3000 })).toEqual({
        value: 'after',
      });
    } finally {
      c.close();
      live.killConnections();
      await new Promise<void>((resolve) => live.server.close(() => resolve()));
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* already gone */ } }
    }
  });

  it('recovers on the NEXT call when one call is lost to the death→EOF race', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The production symptom was not "one call failed" — a call issued between
    // the sidecar's death and the kernel delivering EOF cannot succeed, and no
    // client can prevent that. It was that ALL 333 subsequent calls failed for
    // 99 minutes. This pins the property that actually regressed: a lost call
    // must leave the client RECOVERABLE, not latched.
    const p = socketPath();
    let live = await startTrackedServer(p);
    const c = new SpawnerIpcClient(p);
    try {
      await c.call('echo', { value: 'before' }, { timeoutMs: 3000 });

      // Kill and immediately respawn, giving the client NO chance to observe
      // the close first — so the next call races the EOF.
      live.killConnections();
      await new Promise<void>((resolve) => live.server.close(() => resolve()));
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* already gone */ } }
      live = await startTrackedServer(p);

      // This one may legitimately fail (it is the inherent race) or succeed —
      // either is acceptable, so the outcome is deliberately not asserted.
      await c.call('echo', { value: 'racy' }, { timeoutMs: 3000 }).catch(() => undefined);

      // What is NOT acceptable is staying broken. Pre-fix, every call from here
      // on rejected forever; post-fix the client re-dials.
      expect(await c.call<{ value: string }>('echo', { value: 'recovered' }, { timeoutMs: 3000 })).toEqual({
        value: 'recovered',
      });
    } finally {
      c.close();
      live.killConnections();
      await new Promise<void>((resolve) => live.server.close(() => resolve()));
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* already gone */ } }
    }
  });

  it('re-dials after the peer ends a socket before the local close event', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = socketPath();
    let connectionCount = 0;
    const clientConnectionIds: string[] = [];
    const sockets = new Set<net.Socket>();
    const srv = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      const generation = ++connectionCount;
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += decoder.write(chunk);
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) continue;
          const req = JSON.parse(line) as { id: number; clientConnectionId?: string; params?: { value?: string } };
          if (req.clientConnectionId) clientConnectionIds.push(req.clientConnectionId);
          const response = JSON.stringify({
            jsonrpc: '2.0', result: { value: req.params?.value }, id: req.id,
          }) + '\n';
          if (generation === 1) socket.end(response);
          else socket.write(response);
        }
      });
    });
    await new Promise<void>((resolve) => srv.listen(p, resolve));
    const c = new SpawnerIpcClient(p);
    try {
      await c.ensureConnected();
      const firstSocket = (c as unknown as { socket: net.Socket | null }).socket;
      if (!firstSocket) throw new Error('client did not retain its connected socket');
      // Attach before the first RPC: the reply and peer FIN can arrive in one
      // read cycle, before the awaiting test continuation runs.
      const peerEnded = new Promise<void>((resolve) => firstSocket.once('end', resolve));
      await expect(c.call<{ value: string }>('echo', { value: 'before' }, { timeoutMs: 1000 }))
        .resolves.toEqual({ value: 'before' });
      await peerEnded;

      await expect(c.call<{ value: string }>('echo', { value: 'after' }, { timeoutMs: 100 }))
        .resolves.toEqual({ value: 'after' });
      expect(connectionCount).toBe(2);
      expect(clientConnectionIds).toHaveLength(2);
      expect(new Set(clientConnectionIds).size).toBe(2);
    } finally {
      c.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* removed by server.close */ } }
    }
  });

  it('does not latch on a FAILED first dial — connects once the sidecar comes up', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = socketPath();
    const c = new SpawnerIpcClient(p);
    let live: { server: net.Server; killConnections: () => void } | null = null;
    try {
      // Nothing is listening yet, so the first call must fail...
      await expect(c.call('echo', { value: 'nope' }, { timeoutMs: 3000 })).rejects.toThrow();

      // ...but that failure must not be cached. The sidecar now starts up.
      live = await startTrackedServer(p);

      // Pre-fix, ensureConnected() returns the stale REJECTED promise forever,
      // so this fails even though the sidecar is listening.
      expect(await c.call<{ value: string }>('echo', { value: 'up' }, { timeoutMs: 3000 })).toEqual({
        value: 'up',
      });
    } finally {
      c.close();
      // Bind to a const: the `if (live)` narrowing does not survive into the
      // arrow closure below, so `live.server` there is `possibly null` to tsc.
      const started = live;
      if (started) {
        started.killConnections();
        await new Promise<void>((resolve) => started.server.close(() => resolve()));
      }
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* already gone */ } }
    }
  });
});
