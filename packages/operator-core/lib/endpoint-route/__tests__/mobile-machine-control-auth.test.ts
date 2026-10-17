/** Mobile pairing grants device authority, never remote machine control. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Principal } from '@papercusp/agent-mcp';

const fixture = vi.hoisted(() => ({ cookie: null as Principal | null, revoked: false }));
vi.mock('../../auth/principal/from-cookie', () => ({
  principalFromCookie: async () => fixture.cookie,
}));
vi.mock('../../device-store', async original => ({
  ...(await original<typeof import('../../device-store')>()),
  isRevoked: async () => fixture.revoked,
}));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));
vi.mock('../../coverage-census/attribution/sink', () => ({ recordHttpTraffic: vi.fn() }));

import { signDeviceToken, __resetDeviceJwtForTest } from '../../device-jwt';
import { principalFromDeviceJwt } from '../../auth/principal/from-device-jwt';
import { registerRoute, type RouteDefinition } from '../define-route';
import ptyRoutes from '../routes/pty';
import vncSession from '../routes/deploy/vnc-session';

const ORIGIN = 'https://machine-control.example.test';
const WORKSPACE = 'paired-workspace';
const spawn = ptyRoutes.find(route => route.method === 'POST' && route.path === '/harness/:slug/pty/spawn');
if (!spawn) throw new Error('PTY spawn route missing from the actual route family');
const DOORS = [spawn, vncSession] as const;

beforeEach(() => {
  fixture.cookie = null;
  fixture.revoked = false;
  vi.stubEnv('MOBILE_JWT_SECRET', 'machine-control-auth-test-fixture-only-000000');
  vi.stubEnv('PAPERCUSP_BIND_HOST', '0.0.0.0');
  vi.stubEnv('PAPERCUSP_ALLOW_REMOTE_ADMIN', '1');
  vi.stubEnv('PAPERCUSP_REMOTE_ORIGINS', ORIGIN);
  __resetDeviceJwtForTest();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetDeviceJwtForTest();
});

function requestFor(def: RouteDefinition, jwt: string): Request {
  const path = def.path.replace(':slug', 'fixture-harness');
  return new Request(`${ORIGIN}/api${path}`, {
    method: def.method,
    headers: {
      origin: ORIGIN,
      authorization: `Bearer ${jwt}`,
      'x-papercusp-workspace': WORKSPACE,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ display: 99, command: 'fixture-only' }),
  });
}

describe('mobile JWT machine-control boundary', () => {
  for (const def of DOORS) {
    it(`refuses a valid mobile JWT at ${def.path} before its machine-control handler`, async () => {
      const jwt = signDeviceToken({ sub: 'paired-phone', workspace_id: WORKSPACE, device_kind: 'mobile' });
      const request = requestFor(def, jwt);
      // A malformed/expired token would be a vacuous negative control.
      expect(await principalFromDeviceJwt(request.headers)).toMatchObject({
        kind: 'device', slug: 'paired-phone', workspaceId: WORKSPACE,
      });
      const invoked = vi.fn(() => Response.json({ invoked: true }));
      const app = new Hono().basePath('/api');
      // Preserve the production route declaration and mount/auth stack. Replace
      // only the side-effecting handler so an auth regression is safe to detect.
      registerRoute(app, { ...def, handler: invoked });
      const response = await app.request(request);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } });
      expect(invoked).not.toHaveBeenCalled();

      // The exact same reachable route admits its real remote-operator authority.
      fixture.cookie = {
        kind: 'user', slug: 'operator', workspaceId: WORKSPACE,
        authMethod: 'cookie-session', trust: 'verified', capabilities: new Set(['operator:remote']),
      };
      const allowed = await app.request(requestFor(def, jwt));
      expect(allowed.status).toBe(200);
      expect(invoked).toHaveBeenCalledTimes(1);
    });
  }

  it('stops resolving the same signed pairing token after authoritative revocation', async () => {
    const jwt = signDeviceToken({ sub: 'paired-phone', workspace_id: WORKSPACE, device_kind: 'mobile' });
    const headers = new Headers({ authorization: `Bearer ${jwt}` });
    expect(await principalFromDeviceJwt(headers)).toMatchObject({ kind: 'device' });
    fixture.revoked = true;
    expect(await principalFromDeviceJwt(headers)).toBeNull();
  });
});
