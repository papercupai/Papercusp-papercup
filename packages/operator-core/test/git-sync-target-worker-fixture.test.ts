import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  primary: new Error('request listener failed'),
  cleanup: new Error('request listener cleanup failed'),
  cleanupFails: false,
}));

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => 'fixture-head'), fork: vi.fn() }));
vi.mock('node:crypto', async original => ({
  ...await original<typeof import('node:crypto')>(), randomUUID: () => 'fixture-token',
}));
vi.mock('node:fs', async original => ({
  ...await original<typeof import('node:fs')>(),
  mkdirSync: vi.fn(), readFileSync: vi.fn(), writeFileSync: vi.fn(),
}));
vi.mock('node:http', () => ({ createServer: () => ({
  once: vi.fn(),
  listen: () => { throw state.primary; },
  closeAllConnections: () => { if (state.cleanupFails) throw state.cleanup; },
  close: (done: () => void) => done(),
}) }));
vi.mock('@hono/node-server', () => ({ getRequestListener: () => vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: { end: vi.fn() } }), _resetForTests: vi.fn(),
}));
vi.mock('../../../apps/operator/bin/host-handler', () => ({ handler: vi.fn() }));
vi.mock('../../../apps/operator/lib/mcp-proxy/proxy', () => ({ createMcpProxy: vi.fn(), readMcpWorkerTargets: vi.fn() }));
vi.mock('../lib/harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({ projects: [] })), saveHarnessRegistry: vi.fn(),
}));
vi.mock('../lib/endpoint-ipc-discovery', () => ({ writeEndpointIpcDiscovery: vi.fn() }));
vi.mock('../lib/superuser-token', () => ({
  readSuperuserToken: () => 'fixture-token', superuserTokenPath: () => '/fixture/token',
}));
vi.mock('../lib/serving-host-identity', () => ({ getServingHostIdentity: vi.fn() }));
vi.mock('../lib/process-identity', () => ({ readProcessIdentity: vi.fn() }));
vi.mock('../lib/memory/embed-sidecar-server', () => ({ runEmbedSidecarServer: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('FRICTION_SOURCE_ROOT', '/fixture/source');
  vi.stubEnv('PAPERCUSP_WORKSPACE_ID', 'test-runtime-cleanup-proof');
  vi.stubEnv('PAPERCUSP_PG_PORT', '65432');
  vi.stubEnv('PAPERCUSP_SKIP_PG_DISCOVERY', '1');
  vi.stubEnv('PAPERCUSP_DBOS_ROUTINES', '0');
  vi.stubEnv('PAPERCUSP_BACKGROUND_WORKERS', '0');
  vi.stubEnv('PAPERCUSP_EMBED_SIDECAR_MODE', '0');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each([false, true])('retains the original worker scenario failure when cleanup fails: %s', async cleanupFails => {
  state.cleanupFails = cleanupFails;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { runGitSyncTargetWorkerFixture } = await import('./git-sync-target-worker-fixture');
  const reported = await runGitSyncTargetWorkerFixture().catch(error => error);
  if (cleanupFails) {
    expect(reported).toBeInstanceOf(AggregateError);
    expect((reported as AggregateError).errors).toEqual([state.primary, state.cleanup]);
    expect((reported as Error).message).toContain(state.primary.message);
    expect((reported as Error).message).toContain(state.cleanup.message);
  } else {
    expect(reported).toBe(state.primary);
  }
});
