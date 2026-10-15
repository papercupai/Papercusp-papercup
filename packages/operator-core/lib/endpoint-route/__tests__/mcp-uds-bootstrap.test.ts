import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, readFile, rm, mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';

const h = vi.hoisted(() => ({ home: '', runtime: '' }));
vi.mock('node:os', async original => ({
  ...await original<typeof import('node:os')>(), homedir: () => h.home,
}));
vi.mock('../routes/transport/_mcp-host', () => ({
  ensureOperatorToolsLoaded: async () => {},
  registerMcpHost: () => {},
  mcpHostServerOptions: () => ({ capabilities: {} }),
  tryBuildSpawnContext: async () => ({ kind: 'failed', reason: 'test denies all' }),
  pinVerifiedMcpRequest: (info: object) => info,
}));

import {
  startDesktopAgentMcp,
} from '../routes/transport/_mcp-uds-bootstrap';
import { agentMcpBootstrapFailureCode } from '../routes/transport/_mcp-uds-error';
import { readAgentMcpDiscoveryForPort, endpointIpcDiscoveryPathForPort } from '../../endpoint-ipc-discovery';

beforeEach(async () => {
  h.home = await mkdtemp(join(tmpdir(), 'boot-mcp-'));
  h.runtime = join(h.home, 'runtime');
  await mkdir(h.runtime, { mode: 0o700 });
  vi.stubEnv('XDG_RUNTIME_DIR', h.runtime);
  vi.stubEnv('PAPERCUSP_IPC_TCP', '');
  vi.stubEnv('WSL_INTEROP', '');
  vi.stubEnv('WSL_DISTRO_NAME', '');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(h.home, { recursive: true, force: true });
});

describe('desktop bootstrap publishes a separately authenticated MCP endpoint', () => {
  it('reports only a credential-safe startup failure class', () => {
    expect(agentMcpBootstrapFailureCode(Object.assign(new Error('secret /tmp/private.sock'), {
      code: 'EADDRINUSE',
    }))).toBe('system:EADDRINUSE');
    expect(agentMcpBootstrapFailureCode(new Error('uds_socket_not_private')))
      .toBe('uds:uds_socket_not_private');
    expect(agentMcpBootstrapFailureCode(new TypeError('Bearer secret-value')))
      .toBe('runtime:TypeError');
    expect(agentMcpBootstrapFailureCode('Bearer secret-value')).toBe('unknown');
  });

  it('publishes only after bind, retains the legacy UI path, and rejects the closed generation', async () => {
    const before = process.listenerCount('SIGTERM');
    const listener = await startDesktopAgentMcp('/tmp/ui.sock', 33170);
    expect(listener).not.toBeNull();
    try {
      const descriptor = await readAgentMcpDiscoveryForPort(33170);
      expect(descriptor?.socketPath).toBe('/tmp/ui.sock');
      expect(descriptor?.agentMcp).toEqual(listener!.endpoint);
      expect(listener!.endpoint.socketPath.startsWith(join(h.runtime, 'pmcp-'))).toBe(true);
      const raw = await readFile(endpointIpcDiscoveryPathForPort(33170), 'utf8');
      expect(raw).not.toContain('authorization');
      expect(raw).not.toContain('token');
      expect((await lstat(listener!.endpoint.socketPath)).isSocket()).toBe(true);
    } finally { await listener!.close(); }
    expect(await readAgentMcpDiscoveryForPort(33170)).toBeNull();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('does not erase a replacement operator descriptor when the old listener closes', async () => {
    const a = await startDesktopAgentMcp('/tmp/old-ui.sock', 33170);
    const b = await startDesktopAgentMcp('/tmp/new-ui.sock', 33170);
    try {
      await a!.close();
      expect((await readAgentMcpDiscoveryForPort(33170))?.agentMcp).toEqual(b!.endpoint);
    } finally { await a!.close(); await b!.close(); }
  });

  it('selects the requested port after two operators restart in reverse order', async () => {
    const a = await startDesktopAgentMcp('/tmp/staging.sock', 33170);
    const b = await startDesktopAgentMcp('/tmp/release.sock', 33070);
    let a2: Awaited<ReturnType<typeof startDesktopAgentMcp>>;
    let b2: Awaited<ReturnType<typeof startDesktopAgentMcp>>;
    try {
      await b!.close();
      b2 = await startDesktopAgentMcp('/tmp/release-new.sock', 33070);
      await a!.close();
      a2 = await startDesktopAgentMcp('/tmp/staging-new.sock', 33170);
      const chosen = (await readAgentMcpDiscoveryForPort(33170))!;
      expect(chosen.agentMcp).toEqual(a2!.endpoint);
      expect(chosen.agentMcp!.generation).not.toBe(a!.endpoint.generation);
      expect(chosen.agentMcp!.operatorId).toBe(a!.endpoint.operatorId);
      const assertSelected = (candidate: typeof chosen) => {
        expect(candidate.port).toBe(33170);
        expect(candidate.agentMcp).toEqual(a2!.endpoint);
      };
      assertSelected(chosen);
      expect(() => assertSelected({ ...chosen, agentMcp: b2!.endpoint })).toThrow();
      expect((await readAgentMcpDiscoveryForPort(33070))!.agentMcp).toEqual(b2!.endpoint);
    } finally {
      await Promise.allSettled([a, b, a2!, b2!].filter(Boolean).map(listener => listener!.close()));
    }
  });

  it.each(['PAPERCUSP_IPC_TCP', 'WSL_INTEROP', 'WSL_DISTRO_NAME'])('retains HTTP across unsupported %s boundaries', async name => {
    vi.stubEnv(name, '1');
    expect(await startDesktopAgentMcp('/tmp/ui.sock', 33170)).toBeNull();
    expect(await readAgentMcpDiscoveryForPort(33170)).toBeNull();
  });

  it('pins the real bootstrap call to the single primary publisher', () => {
    // Structural companion, not a substitute for the executed bootstrap above.
    // Never boot the live operator from a unit test: it starts real DB routines.
    const source = readFileSync(new URL('../../../../../apps/operator/bin/host-bootstrap.ts', import.meta.url), 'utf8');
    expect(source).toContain('if (ipcEnabled && cluster.isPrimary)');
    expect(source).toContain('await startDesktopAgentMcp(');
    expect(source).toContain('server.socketPath, Number(process.env.PAPERCUSP_HONO_PORT) || 3070');
    expect(source).toContain(
      "import { agentMcpBootstrapFailureCode } from '@papercusp/operator-core/lib/endpoint-route/routes/transport/_mcp-uds-error';",
    );
    expect(source).not.toContain('bootstrap-unavailable');
    expect(source).not.toMatch(/const \{[^}]*agentMcpBootstrapFailureCode[^}]*\} = await import/);
  });

  it('keeps the startup classifier independent from the listener import graph', () => {
    const source = readFileSync(
      new URL('../routes/transport/_mcp-uds-error.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/^import\s/m);
    expect(agentMcpBootstrapFailureCode(new ReferenceError('secret module detail')))
      .toBe('runtime:ReferenceError');
  });
});
