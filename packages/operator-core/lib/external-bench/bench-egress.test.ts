/**
 * bench-egress unit suite (P-006 / D-030 / D-031). The docker half runs against a fake ProcExec that records every
 * call; the relay half is REAL: unix sockets in a temp dir piping to a real loopback TCP server. The real-docker
 * path (sidecar, internal networks, isolation) is bench-egress.integration.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, connect, type Server } from 'node:net';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcExec } from './grader/swe-bench-pro';
import { isLoopbackRequest } from '../superuser-token';
import {
  BENCH_EGRESS_ALIAS,
  listeningPortsFromProcNet,
  renderEgressNginxConf,
  resolveEgressEndpoints,
  startBenchEgress,
  sweepBenchEgress,
  type BenchEgress,
} from './bench-egress';

/** A /proc/net/tcp dump with the given ports in LISTEN (0A) plus one ESTABLISHED (01) row that must be ignored. */
function procNet(ports: number[]): string {
  const hdr = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  const rows = ports.map((p, i) => `   ${i}: 00000000:${p.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1`);
  rows.push('   9: 0100007F:1F90 0100007F:D2F0 01 00000000:00000000 00:00000000 00000000     0        0 2 1');
  return [hdr, ...rows, ''].join('\n');
}

interface Call {
  args: string[];
}

/** Fake docker: records calls; `fail` marks a subcommand prefix (e.g. 'network connect') to fail. */
function fakeDocker(opts: { listen?: number[]; fail?: string[] } = {}): { exec: ProcExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ProcExec = async (cmd, args) => {
    expect(cmd).toBe('docker');
    calls.push({ args });
    const key = args.slice(0, 2).join(' ');
    if (opts.fail?.some((f) => key === f || args[0] === f)) return { stdout: '', stderr: `forced failure: ${key}`, code: 1 };
    if (args[0] === 'run') return { stdout: 'sidecar-123\n', stderr: '', code: 0 };
    if (args[0] === 'exec') return { stdout: procNet(opts.listen ?? []), stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  return { exec, calls };
}

let workRoot: string;
let upstream: Server;
let upstreamPort: number;
const started: BenchEgress[] = [];

beforeEach(async () => {
  workRoot = mkdtempSync(join(tmpdir(), 'egr-'));
  // A loopback target that answers "pong:<request>" and then closes, like a tiny HTTP/1.0 server.
  upstream = createServer((s) => {
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (d: string) => {
      buf += d;
      if (buf.includes('\n')) s.end(`pong:${buf.trim()}`);
    });
    s.on('error', () => undefined);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  upstreamPort = (upstream.address() as { port: number }).port;
});

afterEach(async () => {
  for (const e of started.splice(0)) await e.stop();
  await new Promise<void>((r) => upstream.close(() => r()));
  rmSync(workRoot, { recursive: true, force: true });
});

async function start(over: { listen?: number[]; fail?: string[]; readyTimeoutMs?: number; targetPort?: number } = {}) {
  const fake = fakeDocker({ listen: over.listen ?? [8788, 9071], fail: over.fail });
  const egress = await startBenchEgress({
    runId: 'Run 42/unit',
    endpoints: [
      { name: 'gw', listenPort: 8788, targetPort: over.targetPort ?? upstreamPort },
      { name: 'mcp', listenPort: 9071, targetPort: over.targetPort ?? upstreamPort },
    ],
    exec: fake.exec,
    workRoot,
    readyTimeoutMs: over.readyTimeoutMs ?? 2000,
    readyPollMs: 10,
  });
  started.push(egress);
  return { egress, ...fake };
}

/** The host relay dir, read back from the sidecar's `-v <relayDir>:/relay` flag. */
function relayDirOf(calls: Call[]): string {
  const run = calls.find((c) => c.args[0] === 'run')!.args;
  const v = run.find((a) => a.endsWith(':/relay'))!;
  return v.slice(0, -':/relay'.length);
}

function request(socketPath: string, body: string, halfClose = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = connect(socketPath);
    let out = '';
    c.setEncoding('utf8');
    c.on('data', (d: string) => (out += d));
    c.on('end', () => resolve(out));
    c.on('close', () => resolve(out));
    c.on('error', reject);
    c.write(`${body}\n`);
    if (halfClose) c.end();
  });
}

describe('resolveEgressEndpoints', () => {
  it('defaults the target host to 127.0.0.1', () => {
    expect(resolveEgressEndpoints([{ name: 'gw', listenPort: 8788, targetPort: 8788 }])).toEqual([
      { name: 'gw', listenPort: 8788, targetPort: 8788, targetHost: '127.0.0.1', perTask: false, transport: 'tcp' },
    ]);
  });

  it('D-033: a perTask endpoint takes no targetPort and resolves with a null one', () => {
    expect(resolveEgressEndpoints([{ name: 'gw', listenPort: 8788, perTask: true }])).toEqual([
      { name: 'gw', listenPort: 8788, targetPort: null, targetHost: '127.0.0.1', perTask: true, transport: 'tcp' },
    ]);
    expect(() => resolveEgressEndpoints([{ name: 'gw', listenPort: 8788, perTask: true, targetPort: 1 }])).toThrow(/takes no targetPort/);
    expect(() => resolveEgressEndpoints([{ name: 'gw', listenPort: 8788 }])).toThrow(/is not a port/);
  });

  it.each([
    [[], /at least one endpoint/],
    [[{ name: 'GW', listenPort: 1, targetPort: 1 }], /must match/],
    [[{ name: 'gw/x', listenPort: 1, targetPort: 1 }], /must match/],
    [[{ name: 'gw', listenPort: 1, targetPort: 1 }, { name: 'gw', listenPort: 2, targetPort: 2 }], /duplicate endpoint name/],
    [[{ name: 'a', listenPort: 1, targetPort: 1 }, { name: 'b', listenPort: 1, targetPort: 2 }], /duplicate listenPort/],
    [[{ name: 'gw', listenPort: 0, targetPort: 1 }], /listenPort 0 is not a port/],
    [[{ name: 'gw', listenPort: 1, targetPort: 70000 }], /targetPort 70000 is not a port/],
    [[{ name: 'gw', listenPort: 1, targetPort: 1, targetHost: '10.0.0.5' }], /not loopback/],
    [[{ name: 'gw', listenPort: 1, targetPort: 1, targetHost: 'api.openai.com' }], /not loopback/],
  ])('refuses %j', (eps, re) => {
    expect(() => resolveEgressEndpoints(eps)).toThrow(re);
  });
});

describe('renderEgressNginxConf', () => {
  it('is exactly one stream server per endpoint and no http block', () => {
    expect(renderEgressNginxConf([{ name: 'gw', listenPort: 8788 }, { name: 'mcp', listenPort: 9071 }])).toBe(
      'events {}\nstream {\n  server { listen 8788; proxy_pass unix:/relay/gw.sock; }\n  server { listen 9071; proxy_pass unix:/relay/mcp.sock; }\n}\n',
    );
  });
});

describe('listeningPortsFromProcNet', () => {
  it('returns LISTEN ports only, from tcp and tcp6 rows', () => {
    const tcp6 = '   0: 00000000000000000000000000000000:2383 00000000000000000000000000000000:0000 0A 0 0 0 0 0 1 1';
    expect([...listeningPortsFromProcNet(procNet([8788]) + tcp6)].sort()).toEqual([8788, 9091]);
  });

  it('ignores garbage', () => {
    expect(listeningPortsFromProcNet('nonsense\n\n  x y z 0A\n').size).toBe(0);
  });
});

describe('startBenchEgress', () => {
  it('streams an MCP POST response before upstream completion and closes the live stream on stop', async () => {
    let received = '';
    const host = createHttpServer(async (req, res) => {
      for await (const chunk of req) received += chunk;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first-event\n\n');
      // Intentionally stays open: buffering the response would never resolve.
    });
    await new Promise<void>(done => host.listen(0, '127.0.0.1', done));
    const fake = fakeDocker({ listen: [9071] });
    let client: ReturnType<typeof httpRequest> | undefined;
    let egress: BenchEgress | undefined;
    try {
      egress = await startBenchEgress({ runId: 'http-stream', endpoints: [{ name: 'mcp', listenPort: 9071,
        targetPort: (host.address() as { port: number }).port, transport: 'http' }],
        exec: fake.exec, workRoot, readyTimeoutMs: 2000, readyPollMs: 10 });
      started.push(egress);
      let streamClosed: Promise<void> | undefined;
      const first = new Promise<string>((resolve, reject) => {
        client = httpRequest({ socketPath: join(relayDirOf(fake.calls), 'mcp.sock'),
          method: 'POST', path: '/api/mcp?superuser=1', headers: { host: 'papercusp-egress:9071',
            'content-type': 'application/json' } }, response => {
          streamClosed = new Promise<void>(done => response.once('close', done));
          response.on('error', () => undefined); // stop intentionally aborts this open stream.
          response.once('data', chunk => resolve(String(chunk)));
        });
        client.on('error', reject);
        client.end('{"jsonrpc":"2.0","method":"tools/list","id":1}');
      });
      expect(await first).toBe('data: first-event\n\n');
      expect(JSON.parse(received)).toMatchObject({ method: 'tools/list', id: 1 });
      expect(await egress.stop()).toEqual({ errors: [] });
      await streamClosed;
    } finally {
      client?.destroy();
      await egress?.stop();
      host.closeAllConnections();
      await new Promise<void>(done => host.close(() => done()));
    }
  });

  it('HTTP MCP relay preserves loopback authentication without trusting external forwarding headers', async () => {
    const seen: Array<{ host: string | undefined; bearer: string | undefined; path: string | undefined }> = [];
    const host = createHttpServer((req, res) => {
      seen.push({ host: req.headers.host, bearer: req.headers.authorization, path: req.url });
      const headers = new Headers(Object.entries(req.headers).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, Array.isArray(value) ? value.join(', ') : value]]));
      const local = isLoopbackRequest(headers);
      res.writeHead(!local ? 403 : req.headers.authorization === 'Bearer private-fixture' ? 200 : 401);
      res.end(!local ? 'superuser_non_loopback' : req.headers.authorization === 'Bearer private-fixture' ? 'tools/list' : 'invalid_bearer');
    });
    await new Promise<void>(done => host.listen(0, '127.0.0.1', done));
    const port = (host.address() as { port: number }).port;
    const fake = fakeDocker({ listen: [9071] });
    try {
      const egress = await startBenchEgress({ runId: 'http-auth',
        endpoints: [{ name: 'mcp', listenPort: 9071, targetPort: port, transport: 'http' }],
        exec: fake.exec, workRoot, readyTimeoutMs: 2000, readyPollMs: 10 });
      started.push(egress);
      const socket = join(relayDirOf(fake.calls), 'mcp.sock');
      const send = (extra: string) => request(socket,
        'GET /api/mcp?superuser=1&client=private-fixture HTTP/1.1\r\nHost: papercusp-egress:9071\r\nConnection: close\r\n' + extra + '\r\n');
      expect(await send('Authorization: Bearer private-fixture\r\n')).toContain('200 OK');
      expect(seen[0]).toEqual({ host: `127.0.0.1:${port}`, bearer: 'Bearer private-fixture',
        path: '/api/mcp?superuser=1&client=private-fixture' });
      expect(await send('Authorization: Bearer wrong\r\n')).toContain('401 Unauthorized');
      expect(await send('Authorization: Bearer private-fixture\r\nX-Forwarded-For: 203.0.113.5\r\n'))
        .toContain('403 Forbidden');
    } finally {
      for (const egress of started.splice(0)) await egress.stop();
      await new Promise<void>(done => host.close(() => done()));
    }
  });

  it('creates an internal labelled base network, then the sidecar on it under the alias, then waits for LISTEN', async () => {
    const { egress, calls } = await start();
    const [net, run, ready] = calls.map((c) => c.args);
    expect(net.slice(0, 3)).toEqual(['network', 'create', '--internal']);
    expect(net).toContain('papercusp.bench-egress=run-42-unit');
    expect(net.at(-1)).toBe(egress.baseNetwork);
    expect(egress.baseNetwork).toMatch(/^pc-egress-run-42-unit-[0-9a-f]{6}-base$/);

    expect(run.slice(0, 2)).toEqual(['run', '-d']);
    expect(run.join(' ')).toContain(`--network ${egress.baseNetwork} --network-alias ${BENCH_EGRESS_ALIAS}`);
    expect(run.some((a) => a.endsWith(':/etc/nginx/nginx.conf:ro'))).toBe(true);
    expect(run.at(-1)).toBe('nginx:alpine');
    expect(egress.sidecarId).toBe('sidecar-123');

    expect(ready).toEqual(['exec', 'sidecar-123', 'cat', '/proc/net/tcp', '/proc/net/tcp6']);
  });

  it('writes the nginx.conf it mounts and serves 0666 sockets in a 0755 dir', async () => {
    const { calls } = await start();
    const run = calls.find((c) => c.args[0] === 'run')!.args;
    const conf = run.find((a) => a.endsWith(':/etc/nginx/nginx.conf:ro'))!.split(':')[0]!;
    expect(readFileSync(conf, 'utf8')).toBe(renderEgressNginxConf([{ name: 'gw', listenPort: 8788 }, { name: 'mcp', listenPort: 9071 }]));
    const dir = relayDirOf(calls);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(statSync(join(dir, 'gw.sock')).mode & 0o777).toBe(0o666);
    expect(statSync(join(dir, 'mcp.sock')).mode & 0o777).toBe(0o666);
  });

  it('relays a unix-socket connection to the loopback target and counts it', async () => {
    const { egress, calls } = await start();
    const dir = relayDirOf(calls);
    expect(await request(join(dir, 'gw.sock'), 'GET /a')).toBe('pong:GET /a');
    expect(await request(join(dir, 'mcp.sock'), 'GET /b')).toBe('pong:GET /b');
    expect(await request(join(dir, 'gw.sock'), 'GET /c')).toBe('pong:GET /c');
    expect(egress.stats()).toEqual({ gw: { connections: 2, errors: 0 }, mcp: { connections: 1, errors: 0 } });
  });

  it('D-033: a perTask endpoint relays only while bound to an open task network; one task network at a time', async () => {
    const fake = fakeDocker({ listen: [8788, 9071] });
    const egress = await startBenchEgress({
      runId: 'pertask',
      endpoints: [{ name: 'gw', listenPort: 8788, perTask: true }, { name: 'mcp', listenPort: 9071, targetPort: upstreamPort }],
      exec: fake.exec, workRoot, readyTimeoutMs: 2000, readyPollMs: 10,
    });
    started.push(egress);
    const sock = join(relayDirOf(fake.calls), 'gw.sock');
    // An unbound endpoint destroys the client on accept, so its write can race the close (EPIPE/ECONNRESET).
    const refused = (body: string) =>
      request(sock, body).catch((e: unknown) => (/EPIPE|ECONNRESET/.test(String(e)) ? '' : Promise.reject(e)));

    expect(await refused('GET /unbound')).toBe('');
    expect(egress.stats().gw).toEqual({ connections: 1, errors: 1 });

    const lease = await egress.openTaskNetwork('task-a');
    await expect(egress.openTaskNetwork('task-b')).rejects.toThrow(/one open task network at a time/);
    expect(() => egress.bindTaskEndpoint('pc-egress-other', 'gw', upstreamPort)).toThrow(/is not open/);
    expect(() => egress.bindTaskEndpoint(lease.network, 'mcp', upstreamPort)).toThrow(/shared, not perTask/);
    expect(() => egress.bindTaskEndpoint(lease.network, 'nope', upstreamPort)).toThrow(/no endpoint named/);
    expect(() => egress.bindTaskEndpoint(lease.network, 'gw', 0)).toThrow(/is not a port/);

    const unbind = egress.bindTaskEndpoint(lease.network, 'gw', upstreamPort);
    expect(() => egress.bindTaskEndpoint(lease.network, 'gw', upstreamPort)).toThrow(/already bound/);
    expect(await request(sock, 'GET /bound')).toBe('pong:GET /bound');
    unbind();
    expect(await refused('GET /after-unbind')).toBe('');

    egress.bindTaskEndpoint(lease.network, 'gw', upstreamPort);
    expect(await lease.release()).toEqual([]);
    expect(await refused('GET /after-release'), 'releasing the network unbinds it').toBe('');
    expect(egress.stats().gw).toEqual({ connections: 4, errors: 3 });

    const next = await egress.openTaskNetwork('task-b');
    expect(next.network).not.toBe(lease.network);
  });

  it('D-033: a failed task-network open frees the single slot', async () => {
    const fake = fakeDocker({ listen: [8788], fail: ['network connect'] });
    const egress = await startBenchEgress({
      runId: 'pertask-fail', endpoints: [{ name: 'gw', listenPort: 8788, perTask: true }],
      exec: fake.exec, workRoot, readyTimeoutMs: 2000, readyPollMs: 10,
    });
    started.push(egress);
    await expect(egress.openTaskNetwork('a')).rejects.toThrow(/could not join/);
    await expect(egress.openTaskNetwork('b')).rejects.toThrow(/could not join/);
  });

  it('still returns the response when the client half-closes after its request', async () => {
    const { calls } = await start();
    expect(await request(join(relayDirOf(calls), 'gw.sock'), 'GET /half', true)).toBe('pong:GET /half');
  });

  it('counts a refused target as an error and closes the client', async () => {
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()));
    const deadPort = (dead.address() as { port: number }).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const { egress, calls } = await start({ targetPort: deadPort });
    expect(await request(join(relayDirOf(calls), 'gw.sock'), 'GET /x')).toBe('');
    expect(egress.stats().gw).toEqual({ connections: 1, errors: expect.any(Number) });
    expect(egress.stats().gw!.errors).toBeGreaterThanOrEqual(1);
  });

  it('originFor maps an endpoint to http://<alias>:<listenPort> and refuses unknown names', async () => {
    const { egress } = await start();
    expect(egress.originFor('gw')).toBe('http://papercusp-egress:8788');
    expect(egress.originFor('mcp')).toBe('http://papercusp-egress:9071');
    expect(() => egress.originFor('internet')).toThrow(/no endpoint named 'internet'/);
  });

  it('openTaskNetwork creates an internal network and connects the sidecar under the alias; release undoes both once', async () => {
    const { egress, calls } = await start();
    calls.length = 0;
    const lease = await egress.openTaskNetwork('Task: sqlite/1');
    expect(lease.network).toMatch(/^pc-egress-run-42-unit-[0-9a-f]{6}-t1-task-sqlite-1$/);
    expect(calls.map((c) => c.args)).toEqual([
      ['network', 'create', '--internal', '--label', 'papercusp.bench-egress=run-42-unit', lease.network],
      ['network', 'connect', '--alias', BENCH_EGRESS_ALIAS, lease.network, 'sidecar-123'],
    ]);
    const second = await egress.openTaskNetwork('Task: sqlite/1');
    expect(second.network).not.toBe(lease.network);

    calls.length = 0;
    expect(await lease.release()).toEqual([]);
    expect(await lease.release()).toEqual([]);
    expect(calls.map((c) => c.args)).toEqual([
      ['network', 'disconnect', '-f', lease.network, 'sidecar-123'],
      ['network', 'rm', lease.network],
    ]);
  });

  it('openTaskNetwork removes the network again when the sidecar cannot join it', async () => {
    const { egress, calls } = await start({ fail: ['network connect'] });
    calls.length = 0;
    await expect(egress.openTaskNetwork('t')).rejects.toThrow(/sidecar could not join/);
    expect(calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['network create', 'network connect', 'network rm']);
  });

  it('stop releases open task networks, then the sidecar, then the base network, then the relay; idempotent', async () => {
    const { egress, calls } = await start();
    const dir = relayDirOf(calls);
    const lease = await egress.openTaskNetwork('t');
    calls.length = 0;
    expect(await egress.stop()).toEqual({ errors: [] });
    expect(calls.map((c) => c.args)).toEqual([
      ['network', 'disconnect', '-f', lease.network, 'sidecar-123'],
      ['network', 'rm', lease.network],
      ['rm', '-f', 'sidecar-123'],
      ['network', 'rm', egress.baseNetwork],
    ]);
    expect(existsSync(dir)).toBe(false);
    await expect(egress.openTaskNetwork('late')).rejects.toThrow(/stopped/);
    calls.length = 0;
    expect(await egress.stop()).toEqual({ errors: [] });
    expect(calls).toEqual([]);
  });

  it('stop reports docker failures instead of throwing', async () => {
    const { egress } = await start({ fail: ['rm'] });
    const r = await egress.stop();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/rm sidecar .*forced failure/);
  });

  it('a sidecar that never listens fails the start and leaves nothing behind', async () => {
    const fake = fakeDocker({ listen: [8788] });
    const before = new Set((await import('node:fs')).readdirSync(workRoot));
    await expect(
      startBenchEgress({
        runId: 'r',
        endpoints: [{ name: 'gw', listenPort: 8788, targetPort: upstreamPort }, { name: 'mcp', listenPort: 9071, targetPort: upstreamPort }],
        exec: fake.exec,
        workRoot,
        readyTimeoutMs: 50,
        readyPollMs: 10,
      }),
    ).rejects.toThrow(/not listening on \[9071\]/);
    const tail = fake.calls.map((c) => c.args.slice(0, 2).join(' ')).slice(-3);
    expect(tail).toEqual(['logs --tail', 'rm -f', 'network rm']);
    expect((await import('node:fs')).readdirSync(workRoot).filter((n) => !before.has(n))).toEqual([]);
  });

  it('a failed sidecar start removes the base network and the work dir', async () => {
    const fake = fakeDocker({ fail: ['run'] });
    await expect(
      startBenchEgress({ runId: 'r', endpoints: [{ name: 'gw', listenPort: 8788, targetPort: upstreamPort }], exec: fake.exec, workRoot }),
    ).rejects.toThrow(/sidecar start failed/);
    // The sidecar is removed by NAME: the daemon may have created it even though the client call failed.
    expect(fake.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['network create', 'run -d', 'rm -f', 'network rm']);
    expect(fake.calls[2]!.args).toEqual(['rm', '-f', expect.stringMatching(/^pc-egress-r-[0-9a-f]{6}-sidecar$/)]);
    expect((await import('node:fs')).readdirSync(workRoot)).toEqual([]);
  });

  it('a failed sidecar start that never created the container reports no cleanup error', async () => {
    const calls: string[][] = [];
    const exec: ProcExec = async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'run') return { stdout: '', stderr: 'daemon timeout', code: 1 };
      if (args[0] === 'rm') return { stdout: '', stderr: 'Error response from daemon: No such container: x', code: 1 };
      return { stdout: '', stderr: '', code: 0 };
    };
    const err = await startBenchEgress({ runId: 'r', endpoints: [{ name: 'gw', listenPort: 8788, targetPort: upstreamPort }], exec, workRoot }).catch(
      (e: Error) => e,
    );
    expect((err as Error).message).toMatch(/sidecar start failed/);
    expect((err as Error).message).not.toMatch(/cleanup/);
    expect(calls.map((a) => a[0])).toEqual(['network', 'run', 'rm', 'network']);
  });

  it('sweepBenchEgress removes the run-labelled containers first, then its networks, and reports failures', async () => {
    const calls: string[][] = [];
    const exec: ProcExec = async (cmd, args) => {
      expect(cmd).toBe('docker');
      calls.push(args);
      if (args[0] === 'ps') return { stdout: 'c1\nc2\n', stderr: '', code: 0 };
      if (args[0] === 'network' && args[1] === 'ls') return { stdout: 'n1\nn2\n', stderr: '', code: 0 };
      if (args[0] === 'network' && args[2] === 'n2') return { stdout: '', stderr: 'has active endpoints', code: 1 };
      return { stdout: '', stderr: '', code: 0 };
    };
    const r = await sweepBenchEgress('Run 7', exec);
    expect(calls).toEqual([
      ['ps', '-aq', '--filter', 'label=papercusp.bench-egress=run-7'],
      ['rm', '-f', 'c1', 'c2'],
      ['network', 'ls', '-q', '--filter', 'label=papercusp.bench-egress=run-7'],
      ['network', 'rm', 'n1'],
      ['network', 'rm', 'n2'],
    ]);
    expect(r.errors).toEqual([expect.stringMatching(/^rm network n2: .*active endpoints/)]);
  });

  it('sweepBenchEgress with nothing labelled issues no removals', async () => {
    const fake = fakeDocker();
    expect(await sweepBenchEgress('r', fake.exec)).toEqual({ errors: [] });
    expect(fake.calls.map((c) => c.args[0] + ' ' + c.args[1])).toEqual(['ps -aq', 'network ls']);
  });

  it('refuses a work root whose socket path would not fit in sun_path, before touching docker', async () => {
    const fake = fakeDocker();
    const deep = join(workRoot, 'x'.repeat(90));
    (await import('node:fs')).mkdirSync(deep);
    await expect(
      startBenchEgress({ runId: 'r', endpoints: [{ name: 'gw', listenPort: 8788, targetPort: upstreamPort }], exec: fake.exec, workRoot: deep }),
    ).rejects.toThrow(/socket path too long/);
    expect(fake.calls).toEqual([]);
  });

  it('refuses a missing runId', async () => {
    await expect(startBenchEgress({ runId: ' ', endpoints: [{ name: 'gw', listenPort: 1, targetPort: 1 }], exec: fakeDocker().exec })).rejects.toThrow(
      /runId is required/,
    );
  });
});
