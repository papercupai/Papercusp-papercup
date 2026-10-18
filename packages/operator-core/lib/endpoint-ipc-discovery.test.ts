import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mutable home so each test points `homedir()` at its own temp dir. ESM
// namespaces aren't spy-able, so mock the module with a holder set in
// beforeEach (vi.mock is hoisted above the imports).
const h = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, homedir: () => h.home || actual.tmpdir() };
});

import {
  writeEndpointIpcDiscovery,
  readEndpointIpcDiscovery,
  endpointIpcDiscoveryPath,
  endpointIpcDiscoveryPathForPort,
  readAgentMcpDiscoveryForPort,
  agentMcpOperatorId,
} from './endpoint-ipc-discovery';

const savedPapercuspHome = process.env.PAPERCUSP_HOME;
beforeEach(async () => {
  h.home = await mkdtemp(join(tmpdir(), 'ipc-disc-'));
  // Every case below except the isolation block assumes the default ~/.papercusp root.
  delete process.env.PAPERCUSP_HOME;
});
afterEach(() => {
  if (savedPapercuspHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = savedPapercuspHome;
});

describe('PAPERCUSP_HOME isolation (writer agrees with the native reader)', () => {
  it.each(['exact', 'padded'])('writes both discovery files at the normalized %s PAPERCUSP_HOME root', async (style) => {
    const isolated = await mkdtemp(join(tmpdir(), 'ipc-disc-iso-'));
    process.env.PAPERCUSP_HOME = style === 'padded' ? `  ${isolated}  ` : isolated;
    process.env.PAPERCUSP_HONO_PORT = '33700';
    try {
      expect(endpointIpcDiscoveryPath()).toBe(join(isolated, 'endpoint-ipc.json'));
      expect(endpointIpcDiscoveryPathForPort(33700)).toBe(join(isolated, 'endpoint-ipc.33700.json'));
      await writeEndpointIpcDiscovery('/tmp/sockets/iso.sock');
      const perPort = JSON.parse(await readFile(join(isolated, 'endpoint-ipc.33700.json'), 'utf8'));
      expect(perPort).toMatchObject({ socketPath: '/tmp/sockets/iso.sock', port: 33700 });
      expect((await readEndpointIpcDiscovery())?.socketPath).toBe('/tmp/sockets/iso.sock');
      const leaked = await readFile(join(h.home, '.papercusp', 'endpoint-ipc.33700.json'), 'utf8').catch(() => null);
      expect(leaked).toBeNull();
    } finally {
      delete process.env.PAPERCUSP_HONO_PORT;
    }
  });

  it('treats an empty PAPERCUSP_HOME as unset, like serve.ts and the native reader', () => {
    process.env.PAPERCUSP_HOME = '';
    expect(endpointIpcDiscoveryPath()).toBe(join(h.home, '.papercusp', 'endpoint-ipc.json'));
  });
});

describe('agent MCP selected-operator discovery', () => {
  it('preserves UI compatibility; validates modes, port, PID and stale socket', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'discovery-agent-'));
    const socketPath = join(directory, 'agent.sock');
    const server = createServer();
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    await chmod(socketPath, 0o600);
    try {
      const agentMcp = { version: 1 as const, transport: 'uds' as const, socketPath,
        operatorId: agentMcpOperatorId(3170), generation: randomUUID() };
      await writeEndpointIpcDiscovery('/tmp/ui-one.sock', { port: 3170, agentMcp });
      await writeEndpointIpcDiscovery('/tmp/ui-two.sock', { port: 3070 });
      expect((await readAgentMcpDiscoveryForPort(3170))?.agentMcp).toEqual(agentMcp);
      expect(await readAgentMcpDiscoveryForPort(3070)).toBeNull();
      expect((await readEndpointIpcDiscovery())?.socketPath).toBe('/tmp/ui-two.sock');
      await chmod(socketPath, 0o666);
      expect(await readAgentMcpDiscoveryForPort(3170)).toBeNull();
      await chmod(socketPath, 0o600);
      await chmod(directory, 0o755);
      expect(await readAgentMcpDiscoveryForPort(3170)).toBeNull();
      await chmod(directory, 0o700);
      const path = endpointIpcDiscoveryPathForPort(3170);
      const raw = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, JSON.stringify({ ...raw, pid: 2_000_000_000 }));
      expect(await readAgentMcpDiscoveryForPort(3170)).toBeNull();
      await writeFile(path, JSON.stringify({ ...raw, port: 3070 }));
      expect(await readAgentMcpDiscoveryForPort(3170)).toBeNull();
      await writeFile(path, JSON.stringify({ ...raw, agentMcp: { ...agentMcp, operatorId: 'f'.repeat(64) } }));
      expect(await readAgentMcpDiscoveryForPort(3170)).toBeNull();
      await writeFile(path, JSON.stringify(raw));
      expect((await readAgentMcpDiscoveryForPort(3170))?.agentMcp).toEqual(agentMcp);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true });
    }
    expect(await readAgentMcpDiscoveryForPort(3170)).toBeNull();
  });
});

afterEach(async () => {
  const home = h.home;
  h.home = '';
  await rm(home, { recursive: true, force: true });
});

describe('endpoint-ipc discovery file', () => {
  it('writes the path under ~/.papercusp/endpoint-ipc.json', () => {
    expect(endpointIpcDiscoveryPath()).toBe(join(h.home, '.papercusp', 'endpoint-ipc.json'));
  });

  it('round-trips the socket path + stamps pid/startedAt', async () => {
    const sock = '/run/user/1000/.papercusp/sockets/42.sock';
    await writeEndpointIpcDiscovery(sock);

    const back = await readEndpointIpcDiscovery();
    expect(back).not.toBeNull();
    expect(back!.socketPath).toBe(sock);
    expect(back!.pid).toBe(process.pid);
    expect(typeof back!.startedAt).toBe('number');
    expect(back!.startedAt).toBeGreaterThan(0);

    // The on-disk JSON is exactly the documented shape (the Rust dev reader
    // parses `socketPath` off this file).
    const raw = JSON.parse(await readFile(endpointIpcDiscoveryPath(), 'utf8'));
    expect(raw).toMatchObject({ socketPath: sock, pid: process.pid });
  });

  it('returns null when the file is missing', async () => {
    expect(await readEndpointIpcDiscovery()).toBeNull();
  });

  it('returns null when the file is corrupt / lacks socketPath', async () => {
    await mkdir(join(h.home, '.papercusp'), { recursive: true });
    await writeFile(endpointIpcDiscoveryPath(), '{ not json', 'utf8');
    expect(await readEndpointIpcDiscovery()).toBeNull();

    await writeFile(endpointIpcDiscoveryPath(), JSON.stringify({ pid: 1 }), 'utf8');
    expect(await readEndpointIpcDiscovery()).toBeNull();
  });
});

describe('sibling discovery-file pruning (EI-18763945004822208 item 2)', () => {
  const papercuspDir = () => join(h.home, '.papercusp');

  it('deletes a sibling endpoint-ipc.<port>.json whose pid is dead', async () => {
    await mkdir(papercuspDir(), { recursive: true });
    const stalePath = join(papercuspDir(), 'endpoint-ipc.3271.json');
    // A pid this high is never a real process — deterministically dead
    // (same convention as the Rust-side DEFINITELY_DEAD_PID test const).
    await writeFile(
      stalePath,
      JSON.stringify({ socketPath: '/tmp/dead.sock', pid: 2_000_000_000, startedAt: 1, port: 3271 }),
      'utf8',
    );

    await writeEndpointIpcDiscovery('/tmp/sockets/fresh.sock');

    await expect(readFile(stalePath, 'utf8')).rejects.toThrow();
  });

  it('leaves a sibling whose pid is alive untouched', async () => {
    await mkdir(papercuspDir(), { recursive: true });
    const livePath = join(papercuspDir(), 'endpoint-ipc.3070.json');
    await writeFile(
      livePath,
      // process.pid — this test process itself is trivially alive.
      JSON.stringify({ socketPath: '/tmp/live.sock', pid: process.pid, startedAt: 1, port: 3070 }),
      'utf8',
    );

    process.env.PAPERCUSP_HONO_PORT = '3170';
    try {
      await writeEndpointIpcDiscovery('/tmp/sockets/fresh.sock');
    } finally {
      delete process.env.PAPERCUSP_HONO_PORT;
    }

    const raw = JSON.parse(await readFile(livePath, 'utf8'));
    expect(raw).toMatchObject({ socketPath: '/tmp/live.sock', pid: process.pid });
  });

  it('never throws when the directory holds an unreadable/corrupt sibling', async () => {
    await mkdir(papercuspDir(), { recursive: true });
    await writeFile(join(papercuspDir(), 'endpoint-ipc.9999.json'), '{ not json', 'utf8');
    await expect(writeEndpointIpcDiscovery('/tmp/sockets/fresh.sock')).resolves.toBeUndefined();
  });

  it('ignores a non-discovery file in the same directory', async () => {
    await mkdir(papercuspDir(), { recursive: true });
    const unrelated = join(papercuspDir(), 'embedded-pg.json');
    await writeFile(unrelated, JSON.stringify({ pid: 2_000_000_000 }), 'utf8');

    await writeEndpointIpcDiscovery('/tmp/sockets/fresh.sock');

    // Never matched the endpoint-ipc(.port)?.json pattern, so untouched
    // regardless of its (dead) pid.
    await expect(readFile(unrelated, 'utf8')).resolves.toContain('2000000000');
  });
});

describe('per-port discovery (EI-190)', () => {
  const savedPort = process.env.PAPERCUSP_HONO_PORT;
  afterEach(() => {
    if (savedPort === undefined) delete process.env.PAPERCUSP_HONO_PORT;
    else process.env.PAPERCUSP_HONO_PORT = savedPort;
  });

  it('names the per-port file endpoint-ipc.<port>.json beside the singleton', () => {
    expect(endpointIpcDiscoveryPathForPort(3170)).toBe(
      join(h.home, '.papercusp', 'endpoint-ipc.3170.json'),
    );
  });

  it('writes BOTH the per-port file and the legacy singleton, identical payloads with the port', async () => {
    process.env.PAPERCUSP_HONO_PORT = '3170';
    const savedBackgroundWorkers = process.env.PAPERCUSP_BACKGROUND_WORKERS;
    const savedVitest = process.env.VITEST;
    process.env.PAPERCUSP_BACKGROUND_WORKERS = '1';
    delete process.env.VITEST;
    try {
      await writeEndpointIpcDiscovery('/tmp/sockets/eipc-test.sock');

      const perPort = JSON.parse(await readFile(endpointIpcDiscoveryPathForPort(3170), 'utf8'));
      const singleton = JSON.parse(await readFile(endpointIpcDiscoveryPath(), 'utf8'));
      expect(perPort).toEqual(singleton);
      expect(perPort).toMatchObject({
        socketPath: '/tmp/sockets/eipc-test.sock',
        pid: process.pid,
        port: 3170,
        processRole: 'bg-host',
      });
      expect((await readEndpointIpcDiscovery())?.processRole).toBe('bg-host');
    } finally {
      if (savedBackgroundWorkers === undefined) delete process.env.PAPERCUSP_BACKGROUND_WORKERS;
      else process.env.PAPERCUSP_BACKGROUND_WORKERS = savedBackgroundWorkers;
      if (savedVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = savedVitest;
    }
  });

  it('records the request-only staging role when background-worker mode is implicit', async () => {
    const savedPort = process.env.PAPERCUSP_HONO_PORT;
    const savedBackgroundWorkers = process.env.PAPERCUSP_BACKGROUND_WORKERS;
    const savedVitest = process.env.VITEST;
    process.env.PAPERCUSP_HONO_PORT = '3170';
    delete process.env.PAPERCUSP_BACKGROUND_WORKERS;
    delete process.env.VITEST;
    try {
      await writeEndpointIpcDiscovery('/tmp/sockets/request-only.sock');
      const perPort = JSON.parse(await readFile(endpointIpcDiscoveryPathForPort(3170), 'utf8'));
      expect(perPort.processRole).toBe('operator');
    } finally {
      if (savedPort === undefined) delete process.env.PAPERCUSP_HONO_PORT;
      else process.env.PAPERCUSP_HONO_PORT = savedPort;
      if (savedBackgroundWorkers === undefined) delete process.env.PAPERCUSP_BACKGROUND_WORKERS;
      else process.env.PAPERCUSP_BACKGROUND_WORKERS = savedBackgroundWorkers;
      if (savedVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = savedVitest;
    }
  });

  it('defaults the port to 3070 when PAPERCUSP_HONO_PORT is unset', async () => {
    delete process.env.PAPERCUSP_HONO_PORT;
    await writeEndpointIpcDiscovery('/tmp/sockets/eipc-default.sock');
    const perPort = JSON.parse(await readFile(endpointIpcDiscoveryPathForPort(3070), 'utf8'));
    expect(perPort.port).toBe(3070);
  });
});
