/**
 * E2 proving test (endpoint-unification-2026-05-21).
 *
 * Asserts a paired phone's device JWT reaches a built-in `defineTool`
 * through the `/api/agent-tools/*` catch-all. Before E2 the catch-all
 * resolved principals via `resolveBearer` alone (token_index → agent
 * `system`/`pi` only); a mobile JWT resolved to nothing and built-in
 * tools rejected the call as unauthenticated. The composite resolver
 * added in E2 closes that gap.
 *
 * The fixture tool carries no capability gate — this test proves the
 * *auth-resolution* path (JWT → Principal → dispatch → fn sees it).
 * Capability-gate behavior for the real `mobile:*` surface is covered
 * once those tools land (Phase E4).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `principalFromDeviceJwt` (Phase E4) runs `isRevoked` — which treats a
// device absent from `mobile_devices` as revoked. The synthetic JWT
// below is for a device that was never `insertDevice`'d, so without this
// mock the principal would (correctly) resolve to null. The mock stands
// it in as a known, non-revoked device.
// The catch-all's `runScoped` wires the handler to a REAL pool via getOrgPg()/withWorkspace
// (catchall.ts:98) — a unit test must not open one [EI-19311807188719573].
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const sql = Object.assign(async () => [], { unsafe: async () => [] });
  return {
    ...(await importOriginal<typeof import('@papercusp/db-org')>()),
    getOrgPg: () => ({ sql }),
    withWorkspace: async (_ws: string, fn: (tx: unknown) => Promise<unknown>) => fn(sql),
  };
});
vi.mock('../../device-store', async (orig) => ({
  ...(await orig<typeof import('../../device-store')>()),
  isRevoked: async () => false,
}));

import {
  registerProjectedTool,
  _resetProjectionRegistryForTests,
  type ProjectedTool,
} from '@papercusp/agent-mcp';

import catchall from '../routes/agent-tools/catchall';
import type { RouteContext } from '../define-route';
import { signDeviceToken, __resetDeviceJwtForTest } from '../../device-jwt';
import { setKernelEnforcementResolver } from '../../projected-tool-deps';

// A durable MOBILE_JWT_SECRET for the whole file: without one, the first
// signDeviceToken() lazily emits the "ephemeral secret" console.warn
// (warnIfMobileJwtSecretNotDurable), which vitest-fail-on-console rejects.
// The durability warning has its own dedicated tests in device-jwt.test.ts —
// here we only care about the JWT auth path.
const PRIOR_MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET;
process.env.MOBILE_JWT_SECRET = 'device-auth-e2e-test-secret-0123456789abcdef';
__resetDeviceJwtForTest();

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

function postHandler() {
  const def = catchall.find((d) => d.method === 'POST');
  if (!def) throw new Error('agent-tools catchall has no POST route');
  return (req: Request) => Promise.resolve(def.handler(req, CTX));
}
const POST = postHandler();

/**
 * Fixture built-in tool. Its `fn` echoes the resolved principal's slug
 * so the test can assert the device principal flowed all the way
 * through dispatch.
 */
function makePrincipalEchoTool(): ProjectedTool {
  return {
    pluginName: 'agent-mcp',
    description: 'echoes the resolved principal slug',
    inputSchema: { type: 'object' },
    capabilities: [],
    // The dispatcher now default-denies tools with no gate; this fixture is
    // intentionally ungated (it proves the auth-RESOLUTION path, not gating), so
    // mark it public to pass the gate and let the resolved principal reach `fn`.
    public: true,
    expose: {
      http: { path: '/api/agent-tools/fix/whoami', methods: ['POST'] },
      mcp: { name: 'fix:whoami' },
    },
    fn: async (_input, ctx) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            principalSlug: ctx.principal?.slug ?? null,
            principalWorkspace: ctx.principal?.workspaceId ?? null,
          }),
        },
      ],
    }),
  };
}

beforeEach(() => {
  _resetProjectionRegistryForTests();
  // This unit fixture has no session-control rows in its mocked database.
  // Supply that independent policy input while exercising real JWT resolution
  // and dispatch; the denial case below keeps the kernel boundary covered.
  setKernelEnforcementResolver(async () => ({ decision: 'allow' }));
});
afterEach(() => {
  _resetProjectionRegistryForTests();
  setKernelEnforcementResolver(null);
});
afterAll(() => {
  if (PRIOR_MOBILE_JWT_SECRET === undefined) delete process.env.MOBILE_JWT_SECRET;
  else process.env.MOBILE_JWT_SECRET = PRIOR_MOBILE_JWT_SECRET;
  __resetDeviceJwtForTest();
});

describe('agent-tools catch-all — mobile JWT auth (E2)', () => {
  it('resolves a device JWT to a principal and reaches the tool fn', async () => {
    registerProjectedTool(makePrincipalEchoTool());
    const jwt = signDeviceToken({
      sub: 'device-e2e-test',
      workspace_id: 'ws-e2e',
      device_kind: 'mobile',
      user_email: 'dev@example.com',
    });

    const req = new Request('http://x.test/api/agent-tools/fix/whoami', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: '{}',
    });
    const res = await POST(req);
    expect(res.status, await res.clone().text()).toBe(200);

    const body = (await res.json()) as { content: Array<{ type: string; text: string }> };
    const echoed = JSON.parse(body.content[0].text) as {
      principalSlug: string | null;
      principalWorkspace: string | null;
    };
    // The device JWT's `sub` is the principal slug; `workspace_id` its workspace.
    expect(echoed.principalSlug).toBe('device-e2e-test');
    expect(echoed.principalWorkspace).toBe('ws-e2e');
  });

  it('rejects a garbage bearer (not a JWT, not a token_index row) as anonymous', async () => {
    registerProjectedTool(makePrincipalEchoTool());
    const req = new Request('http://x.test/api/agent-tools/fix/whoami', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer not-a-real-token',
      },
      body: '{}',
    });
    const res = await POST(req);
    // The fixture tool has no capability gate, so it still runs — but
    // anonymously: the principal is null.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ type: string; text: string }> };
    const echoed = JSON.parse(body.content[0].text) as { principalSlug: string | null };
    expect(echoed.principalSlug).toBeNull();
  });

  it('does not let a valid device JWT bypass a kernel denial', async () => {
    const tool = makePrincipalEchoTool();
    const handler = vi.fn(tool.fn);
    registerProjectedTool({ ...tool, fn: handler });
    setKernelEnforcementResolver(async () => ({ decision: 'deny', code: 'revoked', reason: 'fixture policy revoked' }));
    const jwt = signDeviceToken({ sub: 'device-e2e-test', workspace_id: 'ws-e2e', device_kind: 'mobile' });
    const res = await POST(new Request('http://x.test/api/agent-tools/fix/whoami', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: '{}',
    }));
    expect(res.status, await res.clone().text()).toBe(403);
    const body = await res.json();
    expect(body.error.meta.kernelCode).toBe('revoked');
    expect(handler).not.toHaveBeenCalled();
  });
});
