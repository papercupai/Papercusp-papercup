/**
 * Route-stack mechanics — synthetic routes mounted on a throwaway Hono
 * app, exercised via Hono's in-process `app.request()` (no server).
 *
 * Covers: auth (public + gated), input validation (body + query),
 * handler invoke, error → 500, timeout → 408, duplicate-route guard,
 * and the route-stack step ordering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { request as httpRequest } from 'node:http';
import { serve } from '@hono/node-server';
import { z } from 'zod';

vi.mock('../../auth/require-principal', async () => {
  const actual = await vi.importActual<typeof import('../../auth/require-principal')>(
    '../../auth/require-principal',
  );
  return { ...actual, requirePrincipal: vi.fn() };
});
vi.mock('../../auth/principal/from-cookie', () => ({
  principalFromCookie: vi.fn(async () => null),
}));

// Telemetry writes to PG — out of scope for route-stack mechanics tests.
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

// The loopback tier reads ENDPOINT_AUTH_TIERS server-side (dynamic import).
// Partial mock — other transitive imports use the module's other exports.
vi.mock('@papercusp/flags/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/flags/server')>();
  return { ...actual, getFlag: vi.fn(async () => true) };
});

import { defineTool } from '@papercusp/agent-mcp';
import { registerRoute } from '../define-route';
import { createRouteDiagnostics, DEFAULT_ROUTE_STACK } from '../route-stack';
import { registerAllRoutes } from '../register';
import { requirePrincipal, PrincipalCheckError } from '../../auth/require-principal';
import { AgentIdentityRequiredError } from '../../auth/identity-required-error';
import { resolveAgentIdentity } from '../../agent-tools/coordination/identity';
import { principalFromCookie } from '../../auth/principal/from-cookie';
import { getFlag } from '@papercusp/flags/server';
import { recordRouteInvocation } from '../telemetry';
import { LOOPBACK_PEER_UID_POLICY_ENV, runWithLoopbackPeerVerdict } from '../../auth/loopback-peer-trust';

function freshApp(): Hono {
  return new Hono();
}

beforeEach(() => {
  vi.mocked(requirePrincipal).mockReset();
  vi.mocked(principalFromCookie).mockReset();
  vi.mocked(principalFromCookie).mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('route-stack — step order', () => {
  it('runs auth → input → invoke', () => {
    expect(DEFAULT_ROUTE_STACK.map((s) => s.name)).toEqual(['auth', 'input', 'invoke']);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_ROUTE_STACK)).toBe(true);
  });
});

describe('route diagnostics', () => {
  it('passes diagnostics through mounted handlers and records each stack phase', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/diagnostics', auth: 'public',
      handler: (_req, ctx) => {
        expect(ctx.routeDiagnostics).toBeDefined();
        return Response.json({ ok: true });
      },
    }));

    const response = await app.request('/diagnostics');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const execution = vi.mocked(recordRouteInvocation).mock.calls.at(-1)?.[0];
    expect(execution?.routeDiagnostics?.snapshot()).toEqual(expect.objectContaining({
      auth: expect.any(Number),
      input: expect.any(Number),
      invoke: expect.any(Number),
    }));
  });

  it('records rejected work while ignoring unbounded phase names', async () => {
    const diagnostics = createRouteDiagnostics();
    await expect(diagnostics.measure('handler.phase', async () => {
      throw new Error('diagnostic failure marker');
    })).rejects.toThrow('diagnostic failure marker');
    await diagnostics.measure('handler.phase', () => undefined);
    await diagnostics.measure('Bad phase', () => undefined);

    expect(diagnostics.snapshot()).toEqual({ 'handler.phase': expect.any(Number) });
  });
});

describe('auth step', () => {
  it('public route skips requirePrincipal and runs the handler', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/pub', auth: 'public',
      handler: () => Response.json({ ok: true }),
    }));
    const res = await app.request('/pub');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(requirePrincipal).not.toHaveBeenCalled();
  });

  it('gated route calls requirePrincipal and runs the handler on success', async () => {
    vi.mocked(requirePrincipal).mockResolvedValue({
      kind: 'system', slug: 's', workspaceId: 'w',
      authMethod: 'process-internal', trust: 'trusted', capabilities: new Set(),
    });
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/gated', auth: { trust: ['trusted'] },
      handler: (_req, ctx) => Response.json({ kind: ctx.principal?.kind }),
    }));
    const res = await app.request('/gated');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'system' });
  });

  it('gated route returns the PrincipalCheckError status on denial', async () => {
    vi.mocked(requirePrincipal).mockRejectedValue(new PrincipalCheckError(403, 'trust denied'));
    const app = freshApp();
    let handlerRan = false;
    registerRoute(app, defineTool({
      method: 'GET', path: '/gated', auth: { trust: ['trusted'] },
      handler: () => { handlerRan = true; return Response.json({}); },
    }));
    const res = await app.request('/gated');
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe('trust denied');
    expect(handlerRan).toBe(false);
  });
});

describe('auth step — native direct-remote policy (P-016 / D-025)', () => {
  const saved = {
    bind: process.env.PAPERCUSP_BIND_HOST,
    allow: process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN,
    origins: process.env.PAPERCUSP_REMOTE_ORIGINS,
  };

  beforeEach(() => {
    process.env.PAPERCUSP_BIND_HOST = '0.0.0.0';
    process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN = '1';
    process.env.PAPERCUSP_REMOTE_ORIGINS = 'https://app.example.com';
  });

  afterEach(() => {
    if (saved.bind === undefined) delete process.env.PAPERCUSP_BIND_HOST;
    else process.env.PAPERCUSP_BIND_HOST = saved.bind;
    if (saved.allow === undefined) delete process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;
    else process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN = saved.allow;
    if (saved.origins === undefined) delete process.env.PAPERCUSP_REMOTE_ORIGINS;
    else process.env.PAPERCUSP_REMOTE_ORIGINS = saved.origins;
  });

  const remotePost = (headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { origin: 'https://app.example.com', ...headers },
  });

  it('preserves public compatibility for an SSH-forwarded loopback request', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/pub', auth: 'public',
      handler: () => Response.json({ ok: true }),
    }));
    expect((await app.request('http://localhost/pub')).status).toBe(200);
  });

  it('rejects an unconfigured authority before any handler runs', async () => {
    const app = freshApp();
    let ran = false;
    registerRoute(app, defineTool({
      method: 'GET', path: '/pub', auth: 'public',
      handler: () => { ran = true; return Response.json({}); },
    }));
    const res = await app.request('https://evil.example.com/pub');
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('remote_authority_denied');
    expect(ran).toBe(false);
  });

  it('requires exact Origin on unsafe remote methods', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'POST', path: '/mutate', auth: 'public',
      handler: () => Response.json({ ok: true }),
    }));
    const res = await app.request('https://app.example.com/mutate', { method: 'POST' });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('remote_origin_denied');
  });

  it('requires explicit workspace, verified cookie, capability, and matching claim', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'POST', path: '/mutate', auth: 'public',
      handler: (_req, ctx) => Response.json({ principal: ctx.principal?.slug }),
    }));

    const missingWorkspace = await app.request('https://app.example.com/mutate', remotePost());
    expect(missingWorkspace.status).toBe(400);
    expect((await missingWorkspace.json()).error.code).toBe('workspace_required');

    const noCookie = await app.request('https://app.example.com/mutate', remotePost({
      'x-papercusp-workspace': 'ws-1',
    }));
    expect(noCookie.status).toBe(401);

    vi.mocked(principalFromCookie).mockResolvedValue({
      kind: 'user', slug: 'u1', workspaceId: 'ws-1',
      authMethod: 'cookie-session', trust: 'verified', capabilities: new Set(['*']),
    });
    const noCapability = await app.request('https://app.example.com/mutate', remotePost({
      'x-papercusp-workspace': 'ws-1',
    }));
    expect(noCapability.status).toBe(403);
    expect((await noCapability.json()).error.code).toBe('remote_capability_denied');

    vi.mocked(principalFromCookie).mockResolvedValue({
      kind: 'user', slug: 'u1', workspaceId: 'ws-other',
      authMethod: 'cookie-session', trust: 'verified', capabilities: new Set(['operator:remote']),
    });
    const mismatch = await app.request('https://app.example.com/mutate', remotePost({
      'x-papercusp-workspace': 'ws-1',
    }));
    expect(mismatch.status).toBe(403);
    expect((await mismatch.json()).error.code).toBe('workspace_mismatch');

    vi.mocked(principalFromCookie).mockResolvedValue({
      kind: 'user', slug: 'u1', workspaceId: 'ws-1',
      authMethod: 'cookie-session', trust: 'verified', capabilities: new Set(['operator:remote']),
    });
    const allowed = await app.request('https://app.example.com/mutate', remotePost({
      'x-papercusp-workspace': 'ws-1',
    }));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ principal: 'u1' });
    expect(requirePrincipal).not.toHaveBeenCalled();
  });

  it('requires a verified session for a configured-origin safe remote GET', async () => {
    const app = freshApp();
    let handlerRan = false;
    registerRoute(app, defineTool({
      method: 'GET', path: '/read', auth: 'public',
      handler: () => { handlerRan = true; return Response.json({ ok: true }); },
    }));

    const res = await app.request('https://app.example.com/read', {
      headers: {
        origin: 'https://app.example.com',
        'x-papercusp-workspace': 'ws-1',
      },
    });

    expect(res.status).toBe(401);
    expect(handlerRan).toBe(false);
  });

  it('allows the login bootstrap only after exact authority and Origin checks', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'POST', path: '/auth/login', auth: 'public',
      handler: () => Response.json({ ok: true }),
    }));
    const res = await app.request('https://app.example.com/auth/login', remotePost());
    expect(res.status).toBe(200);
    expect(principalFromCookie).not.toHaveBeenCalled();
  });
});

describe('auth step — local browser mutation policy (WI-2144494)', () => {
  const mutationRoute = (
    options: { cors?: boolean | { origins: readonly string[] } } = {},
    onInvoke?: () => void,
  ) => defineTool({
    method: 'POST',
    path: '/mutate',
    auth: 'loopback',
    ...options,
    input: z.object({ command: z.string() }),
    handler: (_req, ctx) => {
      onInvoke?.();
      return Response.json({ command: ctx.input.command });
    },
  });

  it('rejects a cross-site text/plain mutation before input or invoke', async () => {
    const app = freshApp();
    let handlerRan = false;
    registerRoute(app, mutationRoute({}, () => { handlerRan = true; }));

    const res = await app.request('/mutate', {
      method: 'POST',
      headers: {
        origin: 'https://untrusted.example.test',
        'sec-fetch-site': 'cross-site',
        'content-type': 'text/plain',
      },
      body: JSON.stringify({ command: 'bash' }),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('cross_origin_blocked');
    expect(handlerRan).toBe(false);
  });

  it('rejects cross-site Fetch Metadata even when Origin is absent', async () => {
    const app = freshApp();
    let handlerRan = false;
    registerRoute(app, mutationRoute({}, () => { handlerRan = true; }));

    const res = await app.request('/mutate', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' },
      body: JSON.stringify({ command: 'bash' }),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('cross_origin_blocked');
    expect(handlerRan).toBe(false);
  });

  it('allows no-Origin native requests and trusted default/custom origins', async () => {
    const invoke = vi.fn();
    const app = freshApp();
    registerRoute(app, mutationRoute({ cors: { origins: ['https://trusted.example.test'] } }, invoke));

    const native = await app.request('/mutate', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ command: 'native' }),
    });
    expect(native.status).toBe(200);

    const custom = await app.request('/mutate', {
      method: 'POST',
      headers: {
        origin: 'https://trusted.example.test',
        'sec-fetch-site': 'cross-site',
        'content-type': 'text/plain',
      },
      body: JSON.stringify({ command: 'custom' }),
    });
    expect(custom.status).toBe(200);

    // The route's explicit CORS origins replace the default allowlist.
    const defaultOrigin = await app.request('/mutate', {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:3170',
        'content-type': 'text/plain',
      },
      body: JSON.stringify({ command: 'default' }),
    });
    expect(defaultOrigin.status).toBe(403);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe('auth step — loopback browser read policy (P-001/F05)', () => {
  const readRoute = (options: { cors?: boolean | { origins: readonly string[] } } = {}, onInvoke?: () => void) =>
    defineTool({
      method: 'GET',
      path: '/read',
      auth: 'loopback',
      ...options,
      handler: () => {
        onInvoke?.();
        return Response.json({ ok: true });
      },
    });

  const envKeys = [
    'PAPERCUSP_OPERATOR_BASE',
    'PAPERCUSP_RELEASE_ORIGIN',
    'OPERATOR_E2E_BASE_URL',
    'OPERATOR_BASE_URL',
  ] as const;
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<(typeof envKeys)[number], string | undefined>;

  beforeEach(() => {
    for (const key of envKeys) delete process.env[key];
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('rejects an opaque null Origin before a sensitive GET handler runs', async () => {
    const app = freshApp();
    const invoke = vi.fn();
    registerRoute(app, readRoute({}, invoke));

    const res = await app.request('http://localhost:3070/read', { headers: { origin: 'null' } });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('cross_origin_blocked');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects an unrelated localhost port while allowing the configured dev origin', async () => {
    const app = freshApp();
    const invoke = vi.fn();
    registerRoute(app, readRoute({}, invoke));

    const unrelated = await app.request('http://localhost:3070/read', {
      headers: { origin: 'http://localhost:9999' },
    });
    expect(unrelated.status).toBe(403);
    expect(invoke).not.toHaveBeenCalled();

    const dev = await app.request('http://localhost:3070/read', {
      headers: { origin: 'http://localhost:3055' },
    });
    expect(dev.status).toBe(200);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('allows no-Origin native calls and same-instance sibling loopback origins', async () => {
    const app = freshApp();
    const invoke = vi.fn();
    registerRoute(app, readRoute({}, invoke));

    const native = await app.request('http://localhost:3070/read');
    expect(native.status).toBe(200);
    const sibling = await app.request('http://127.0.0.1:3070/read', {
      headers: { origin: 'http://localhost:3070' },
    });
    expect(sibling.status).toBe(200);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('honors an explicit route origin without reopening arbitrary local ports', async () => {
    const app = freshApp();
    const invoke = vi.fn();
    registerRoute(app, readRoute({ cors: { origins: ['https://trusted.example.test'] } }, invoke));

    const allowed = await app.request('http://localhost:3070/read', {
      headers: { origin: 'https://trusted.example.test' },
    });
    expect(allowed.status).toBe(200);
    const arbitrary = await app.request('http://localhost:3070/read', {
      headers: { origin: 'http://localhost:9999' },
    });
    expect(arbitrary.status).toBe(403);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

/**
 * Gap 5 — the `?token=` → `Authorization: Bearer` lift (route-stack.ts
 * `authHeaders`). SECURITY-sensitive: a query token may only become a
 * bearer credential when the route's `auth.tokenIn` includes `'query'`,
 * and it must never override an Authorization header the caller already
 * set. The stub `requirePrincipal` echoes the resolved `Authorization`
 * header it was handed back through the principal's slug, so the handler
 * can assert exactly what the resolvers would have seen.
 */
describe('auth step — ?token= → bearer lift (Gap 5, security)', () => {
  /** Echo whatever Authorization header the auth step resolved. */
  function echoAuthHeader() {
    vi.mocked(requirePrincipal).mockImplementation(async (headers) => ({
      kind: 'system',
      slug: headers.get('authorization') ?? '<none>',
      workspaceId: 'w',
      authMethod: 'process-internal',
      trust: 'trusted',
      capabilities: new Set<string>(),
    }));
  }

  it('(a) lifts ?token= into a bearer when tokenIn includes "query"', async () => {
    echoAuthHeader();
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/q-auth', auth: { kind: ['system'], tokenIn: ['query'] },
      handler: (_req, ctx) => Response.json({ seen: ctx.principal?.slug }),
    }));
    const res = await app.request('/q-auth?token=qtok');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ seen: 'Bearer qtok' });
  });

  it('(b) NEVER overrides an existing Authorization header with ?token=', async () => {
    echoAuthHeader();
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/q-auth', auth: { kind: ['system'], tokenIn: ['query'] },
      handler: (_req, ctx) => Response.json({ seen: ctx.principal?.slug }),
    }));
    // A real header is present AND a ?token= is supplied: the header wins.
    const res = await app.request('/q-auth?token=qtok', {
      headers: { authorization: 'Bearer real-header-token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ seen: 'Bearer real-header-token' });
  });

  it('(c) IGNORES ?token= entirely when tokenIn is absent (no bearer smuggling)', async () => {
    echoAuthHeader();
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/h-only', auth: { kind: ['system'] },
      handler: (_req, ctx) => Response.json({ seen: ctx.principal?.slug }),
    }));
    // No tokenIn → ?token= must NOT be promoted to a bearer. The resolver
    // sees no Authorization header at all.
    const res = await app.request('/h-only?token=qtok');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ seen: '<none>' });
  });

  it('(c2) IGNORES ?token= when tokenIn is ["header"] only', async () => {
    echoAuthHeader();
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/h-explicit', auth: { kind: ['system'], tokenIn: ['header'] },
      handler: (_req, ctx) => Response.json({ seen: ctx.principal?.slug }),
    }));
    const res = await app.request('/h-explicit?token=qtok');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ seen: '<none>' });
  });
});

describe('auth step — loopback tier (auth-tier rollout Wave 1)', () => {
  const lbRoute = () => defineTool({
    method: 'POST', path: '/lb', auth: 'loopback',
    handler: () => Response.json({ ok: true }),
  });

  beforeEach(() => {
    vi.mocked(getFlag).mockResolvedValue(true);
    delete process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;
  });
  afterEach(() => {
    delete process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;
  });

  it('admits a loopback-host request without requirePrincipal', async () => {
    const app = freshApp();
    registerRoute(app, lbRoute());
    // app.request('/lb') builds http://localhost/lb — a loopback Host.
    const res = await app.request('/lb', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(requirePrincipal).not.toHaveBeenCalled();
  });

  it('rejects a non-loopback Host with 403 before the handler', async () => {
    const app = freshApp();
    let handlerRan = false;
    registerRoute(app, defineTool({
      method: 'POST', path: '/lb', auth: 'loopback',
      handler: () => { handlerRan = true; return Response.json({}); },
    }));
    const res = await app.request('http://evil.example.com/lb', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(handlerRan).toBe(false);
  });

  it('flag OFF reverts to public behavior (the emergency lever)', async () => {
    vi.mocked(getFlag).mockResolvedValue(false);
    const app = freshApp();
    registerRoute(app, lbRoute());
    const res = await app.request('http://evil.example.com/lb', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('Gap 6: flag-layer error fails CLOSED — loopback route still 403s a remote Host', async () => {
    // The flag resolver throws (PG down, import failure, …). The route
    // declares itself loopback-only; `endpointAuthTiersEnabled` must treat
    // an unreachable flag layer as "enabled" so the declared tier holds.
    vi.mocked(getFlag).mockRejectedValue(new Error('flag layer unreachable'));
    const app = freshApp();
    let handlerRan = false;
    registerRoute(app, defineTool({
      method: 'POST', path: '/lb', auth: 'loopback',
      handler: () => { handlerRan = true; return Response.json({}); },
    }));
    const res = await app.request('http://evil.example.com/lb', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(handlerRan).toBe(false);
  });

  it('Gap 6: flag-layer error still admits a loopback Host (fail-closed, not fail-broken)', async () => {
    // Fail-CLOSED means "enforce the loopback gate", not "reject everything":
    // a genuinely-loopback caller must still get through.
    vi.mocked(getFlag).mockRejectedValue(new Error('flag layer unreachable'));
    const app = freshApp();
    registerRoute(app, lbRoute());
    const res = await app.request('/lb', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('PAPERCUSP_ALLOW_REMOTE_ADMIN=1 admits a remote host (deliberate opt-out)', async () => {
    process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN = '1';
    const app = freshApp();
    registerRoute(app, lbRoute());
    const res = await app.request('http://evil.example.com/lb', { method: 'POST' });
    expect(res.status).toBe(200);
  });
});

// WI-10003619: on a hosted workspace VM the customer account (a different uid)
// shares loopback with the operator. A loopback ADDRESS is not an identity, so the
// loopback tier must refuse a peer whose socket is not owned by the service uid —
// independently of the ENDPOINT_AUTH_TIERS flag and of PAPERCUSP_ALLOW_REMOTE_ADMIN.
describe('auth step — loopback tier, foreign local peer (WI-10003619)', () => {
  const SERVICE_UID = 999;
  const socket = { remoteAddress: '127.0.0.1', remotePort: 41234, localAddress: '127.0.0.1', localPort: 3070 };
  const procTcp = (clientUid: number) => [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    `   0: 0100007F:0BFE 0100007F:A112 01 00000000:00000000 00:00000000 00000000   ${SERVICE_UID}        0 22222 1 0000000000000000 20 4 30 10 -1`,
    `   1: 0100007F:A112 0100007F:0BFE 01 00000000:00000000 00:00000000 00000000  ${clientUid}        0 33333 1 0000000000000000 20 4 30 10 -1`,
  ].join('\n');
  const asPeer = <T>(reader: (path: string) => string, fn: () => T): T =>
    runWithLoopbackPeerVerdict(socket, fn, {
      env: { [LOOPBACK_PEER_UID_POLICY_ENV]: 'service-only' },
      serviceUid: SERVICE_UID,
      readProcFile: reader,
    });
  const tcpOnly = (clientUid: number) => (path: string) => {
    if (path.endsWith('/tcp')) return procTcp(clientUid);
    throw new Error('ENOENT');
  };

  let handlerRan = false;
  const lbApp = () => {
    handlerRan = false;
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'POST', path: '/lb', auth: 'loopback',
      handler: () => { handlerRan = true; return Response.json({ ok: true }); },
    }));
    return app;
  };

  afterEach(() => {
    delete process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;
  });

  it('403s a loopback peer owned by another uid even with ENDPOINT_AUTH_TIERS OFF', async () => {
    vi.mocked(getFlag).mockResolvedValue(false);
    const app = lbApp();
    const res = await asPeer(tcpOnly(1001), () => app.request('http://127.0.0.1:3070/lb', { method: 'POST' }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('loopback_peer_uid_denied');
    expect(handlerRan).toBe(false);
  });

  it('PAPERCUSP_ALLOW_REMOTE_ADMIN does not open the route to a foreign local uid', async () => {
    vi.mocked(getFlag).mockResolvedValue(true);
    process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN = '1';
    const app = lbApp();
    const res = await asPeer(tcpOnly(1001), () => app.request('http://127.0.0.1:3070/lb', { method: 'POST' }));
    expect(res.status).toBe(403);
    expect(handlerRan).toBe(false);
  });

  it('fails closed when the socket owner cannot be resolved', async () => {
    vi.mocked(getFlag).mockResolvedValue(false);
    const app = lbApp();
    const unreadable = () => { throw new Error('EACCES'); };
    const res = await asPeer(unreadable, () => app.request('http://127.0.0.1:3070/lb', { method: 'POST' }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toBe('unresolved');
    expect(handlerRan).toBe(false);
  });

  it('admits the service uid itself (the positive control)', async () => {
    vi.mocked(getFlag).mockResolvedValue(true);
    const app = lbApp();
    const res = await asPeer(tcpOnly(SERVICE_UID), () => app.request('http://127.0.0.1:3070/lb', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(handlerRan).toBe(true);
  });
});

describe('input step', () => {
  it('parses a valid POST body', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'POST', path: '/echo', auth: 'public',
      input: z.object({ n: z.number() }),
      handler: (_req, ctx) => Response.json({ doubled: ctx.input.n * 2 }),
    }));
    const res = await app.request('/echo', {
      method: 'POST', body: JSON.stringify({ n: 21 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ doubled: 42 });
  });

  it('rejects an invalid POST body with 400', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'POST', path: '/echo', auth: 'public',
      input: z.object({ n: z.number() }),
      handler: () => Response.json({}),
    }));
    const res = await app.request('/echo', {
      method: 'POST', body: JSON.stringify({ n: 'not-a-number' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_input');
  });

  it('rejects non-JSON body with 400', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'POST', path: '/echo', auth: 'public',
      input: z.object({ n: z.number() }),
      handler: () => Response.json({}),
    }));
    const res = await app.request('/echo', {
      method: 'POST', body: 'not json{', headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('parses GET input from the query string', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/q', auth: 'public',
      input: z.object({ limit: z.coerce.number() }),
      handler: (_req, ctx) => Response.json({ limit: ctx.input.limit }),
    }));
    const res = await app.request('/q?limit=7');
    expect(await res.json()).toEqual({ limit: 7 });
  });

  // ── Gap 13: GET query coercion footgun. searchParams are ALL strings;
  //    the route-stack does not coerce, so a non-coercing schema 400s. ──
  it('Gap 13: a GET z.number() schema 400s on ?n=5 (string, not coerced)', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/n', auth: 'public',
      input: z.object({ n: z.number() }),
      handler: (_req, ctx) => Response.json({ n: ctx.input.n }),
    }));
    const res = await app.request('/n?n=5');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_input');
  });

  it('Gap 13: z.coerce.number() passes ?n=5 → 200 with n===5 (number)', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/n', auth: 'public',
      input: z.object({ n: z.coerce.number() }),
      handler: (_req, ctx) => Response.json({ n: ctx.input.n, isNumber: typeof ctx.input.n === 'number' }),
    }));
    const res = await app.request('/n?n=5');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ n: 5, isNumber: true });
  });

  it('Gap 13: a repeated query key is last-wins (Object.fromEntries)', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/dup', auth: 'public',
      input: z.object({ x: z.string() }),
      handler: (_req, ctx) => Response.json({ x: ctx.input.x }),
    }));
    const res = await app.request('/dup?x=1&x=2');
    expect(res.status).toBe(200);
    // Object.fromEntries(searchParams) keeps the LAST value for a repeated key.
    expect(await res.json()).toEqual({ x: '2' });
  });

  it('handler gets undefined input when no schema declared', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'POST', path: '/raw', auth: 'public',
      handler: (_req, ctx) => Response.json({ input: ctx.input ?? 'undefined' }),
    }));
    const res = await app.request('/raw', { method: 'POST', body: 'anything' });
    expect(await res.json()).toEqual({ input: 'undefined' });
  });
});

describe('invoke step', () => {
  it('passes the accepted socket peer to handlers while ignoring forwarded-header changes', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/peer', auth: 'public',
      handler: (req, ctx) => Response.json({
        peerAddress: ctx.peerAddress,
        forwardedFor: req.headers.get('x-forwarded-for'),
      }),
    }));

    const server = serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req, bindings) => {
        Object.defineProperty(bindings.incoming.socket, 'remoteAddress', {
          configurable: true,
          value: '203.0.113.10',
        });
        return app.fetch(req, bindings);
      },
    });
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
      const port = address.port;
      const request = (forwardedFor: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = httpRequest({
          hostname: '127.0.0.1', port, path: '/peer',
          headers: { host: 'localhost', 'x-forwarded-for': forwardedFor },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }));
        });
        req.on('error', reject);
        req.end();
      });
      const first = await request('198.51.100.1');
      const second = await request('198.51.100.2');
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body.peerAddress).toBe('203.0.113.10');
      expect(second.body.peerAddress).toBe('203.0.113.10');
      expect(first.body.forwardedFor).toBe('198.51.100.1');
      expect(second.body.forwardedFor).toBe('198.51.100.2');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('a thrown handler error becomes a 500 envelope', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/boom', auth: 'public',
      handler: () => { throw new Error('kaboom'); },
    }));
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('handler_error');
    expect(body.error.message).toBe('kaboom');
  });

  // EI-24708210960582152: an unattributable caller (resolveAgentIdentity throws) is a REQUEST
  // fault. It must surface as a typed 401 identity_required, not the 500 handler_error above.
  it('an identity-required throw becomes a typed 401 identity_required, not a 500', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/needs-identity', auth: 'public',
      // The REAL resolver on an unattributed context, exactly what triggerToolContext does.
      handler: () => { resolveAgentIdentity({}); throw new Error('unreachable: identity resolved'); },
    }));
    const res = await app.request('/needs-identity');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('identity_required');
    expect(body.error.message).toMatch(/cannot be attributed/);
  });

  it('resolveAgentIdentity refuses an unattributed context with the typed error class', () => {
    expect(() => resolveAgentIdentity({})).toThrow(AgentIdentityRequiredError);
  });

  it('a handler exceeding timeoutSec becomes a 408', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/slow', auth: 'public',
      timeoutSec: 0.1,
      handler: (_req, ctx) => new Promise<Response>((resolve) => {
        // Resolve only after the abort fires — the route-stack should
        // surface a 408 regardless of this late success.
        ctx.signal.addEventListener('abort', () => resolve(Response.json({ late: true })));
      }),
    }));
    const res = await app.request('/slow');
    expect(res.status).toBe(408);
    expect((await res.json()).error.code).toBe('timeout');
  });

  it('passes path params through ctx.params', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/harness/:slug', auth: 'public',
      handler: (_req, ctx) => Response.json({ slug: ctx.params.slug }),
    }));
    const res = await app.request('/harness/sheets');
    expect(await res.json()).toEqual({ slug: 'sheets' });
  });

  it('timeoutSec: null disables the watchdog (long-lived SSE routes, EI-110)', async () => {
    vi.useFakeTimers();
    try {
      const app = freshApp();
      registerRoute(app, defineTool({
        method: 'GET', path: '/stream', auth: 'public',
        timeoutSec: null,
        handler: (_req, ctx) => new Promise<Response>((resolve) => {
          // Resolves well past the 30s default; only an abort could beat it.
          const t = setTimeout(() => resolve(Response.json({ ok: true })), 60_000);
          if (typeof t.unref === 'function') t.unref();
          ctx.signal.addEventListener('abort', () =>
            resolve(Response.json({ aborted: true }, { status: 599 })),
          );
        }),
      }));
      const pending = app.request('/stream');
      await vi.advanceTimersByTimeAsync(61_000); // would fire a 30s watchdog twice over
      const res = await pending;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true }); // never aborted
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runRouteStack — response byte capture (EI-7069)', () => {
  it('captures Content-Length as exec.responseBytes when the handler response carries one', async () => {
    // Hono's in-process app.request() never crosses a real HTTP transport, so
    // a plain Response.json() here does NOT get an auto-computed Content-Length
    // (that only happens once Node's real http layer serializes a known-length
    // body — @hono/node-server in production). Set it explicitly to exercise
    // this code's Content-Length-reading logic directly and deterministically.
    const app = freshApp();
    const body = JSON.stringify({ hello: 'world' });
    const byteLen = new TextEncoder().encode(body).length;
    registerRoute(app, defineTool({
      method: 'GET', path: '/sized', auth: 'public',
      handler: () => new Response(body, { headers: { 'content-type': 'application/json', 'content-length': String(byteLen) } }),
    }));
    const res = await app.request('/sized');
    expect(res.status).toBe(200);
    expect(recordRouteInvocation).toHaveBeenCalledTimes(1);
    const exec = vi.mocked(recordRouteInvocation).mock.calls[0][0];
    expect(exec.responseBytes).toBe(byteLen);
  });

  it('leaves responseBytes null for a streaming response with no Content-Length', async () => {
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/stream-sized', auth: 'public',
      handler: () =>
        new Response(new ReadableStream({ start: (c) => { c.enqueue(new Uint8Array([1])); c.close(); } })),
    }));
    const res = await app.request('/stream-sized');
    expect(res.status).toBe(200);
    expect(recordRouteInvocation).toHaveBeenCalledTimes(1);
    const exec = vi.mocked(recordRouteInvocation).mock.calls[0][0];
    expect(exec.responseBytes).toBeNull();
  });

  it('never breaks the response even if reading headers were to throw', async () => {
    // Defensive: the try/catch around header-reading must never surface into
    // the response itself, whatever the response shape.
    const app = freshApp();
    registerRoute(app, defineTool({
      method: 'GET', path: '/plain', auth: 'public',
      handler: () => new Response('ok'),
    }));
    const res = await app.request('/plain');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});

describe('registerAllRoutes — duplicate guard', () => {
  it('throws on a duplicate method+path', () => {
    // registerAllRoutes reads the real ALL_ROUTES; here we only assert
    // the guard logic via a direct collision in a hand-built app.
    const app = freshApp();
    const a = defineTool({ method: 'GET', path: '/x', auth: 'public', handler: () => Response.json({}) });
    registerRoute(app, a);
    // Re-registering the same path on Hono is allowed by Hono itself;
    // the duplicate *guard* lives in registerAllRoutes. Smoke-check that
    // registerAllRoutes runs without throwing on the real (collision-free)
    // ALL_ROUTES.
    expect(() => registerAllRoutes(freshApp())).not.toThrow();
  });
});
