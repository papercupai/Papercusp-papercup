import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const h = vi.hoisted(() => ({ start: vi.fn(), get: vi.fn(), list: vi.fn(), artifact: vi.fn(), cookie: vi.fn(), appKey: vi.fn() }));
vi.mock('../../plan-audit-runs', () => ({ startPlanAudit: h.start, getPlanAuditRun: h.get, listPlanAuditRuns: h.list, readAuditArtifact: h.artifact }));
vi.mock('../../auth/principal/from-cookie', () => ({ principalFromCookie: h.cookie }));
vi.mock('../../connected-apps/principal', () => ({ resolveAppKeyPrincipal: h.appKey }));
vi.mock('../../auth/principal/from-device-jwt', () => ({ principalFromDeviceJwt: vi.fn(async () => null) }));
vi.mock('../../auth/principal/from-bearer-token', () => ({ principalFromBearerToken: vi.fn(async () => null) }));
vi.mock('../../auth/principal/from-superuser-token', () => ({
  principalFromSuperuserToken: (headers: Headers) => headers.get('authorization') === 'Bearer fixture-trusted'
    ? { kind: 'system', slug: 'fixture-su', workspaceId: 'ws', authMethod: 'superuser-token', trust: 'trusted', capabilities: new Set(['*']) }
    : null,
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws' }));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));
vi.mock('../../coverage-census/attribution/sink', () => ({ recordHttpTraffic: vi.fn() }));
import routes, { planAuditHandler } from '../routes/admin/plan-audit';
import { registerRoute } from '../define-route';
import type { RouteContext } from '@papercusp/agent-mcp';
const ctx = {} as RouteContext;
const app = new Hono();
for (const route of routes) registerRoute(app, route);
const auditRequest = { scope: 'single', planSlugs: ['a'] };
beforeEach(() => {
  vi.clearAllMocks();
  h.cookie.mockResolvedValue(null);h.appKey.mockResolvedValue(null);
  h.start.mockResolvedValue({ id: 'run', status: 'running' });h.list.mockResolvedValue([]);
});
describe('owner audit endpoint', () => {
  it('opens a durable running record and rejects malformed JSON', async () => {
    h.start.mockResolvedValue({ id: 'run', status: 'running' });
    const response = await planAuditHandler(new Request('http://localhost/api/admin/plan-audit', { method: 'POST', body: JSON.stringify({ scope: 'single', planSlugs: ['a'] }) }), ctx);
    expect(response.status).toBe(202);expect(h.start).toHaveBeenCalledWith({ scope: 'single', planSlugs: ['a'] });
    expect((await planAuditHandler(new Request('http://localhost/api/admin/plan-audit', { method: 'POST', body: '{' }), ctx)).status).toBe(400);
  });
  it('serves only completed artifacts with sandbox protection and no cache', async () => {
    h.get.mockResolvedValue({ id: 'run', status: 'complete' });h.artifact.mockResolvedValue('<html>audit</html>');
    const response = await planAuditHandler(new Request('http://localhost/api/admin/plan-audit?runId=run&format=html'), ctx);
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox allow-scripts');
    expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toContain('audit');
    h.get.mockResolvedValue({ status: 'failed', error: 'failed generation' });
    expect((await planAuditHandler(new Request('http://localhost/api/admin/plan-audit?runId=run&format=html'), ctx)).status).toBe(409);
    h.get.mockResolvedValue(null);
    expect((await planAuditHandler(new Request('http://localhost/api/admin/plan-audit?runId=foreign'), ctx)).status).toBe(404);
  });
});

describe('plan audit authentication and browser boundaries', () => {
  for (const method of ['GET', 'POST']) {
    it.each(['native-loopback', 'verified-cookie', 'trusted-bearer'])('%s can use ' + method + ' through the route stack', async identity => {
      if (identity === 'verified-cookie') h.cookie.mockResolvedValue({
        kind: 'user', slug: 'fixture-user', workspaceId: 'ws', authMethod: 'cookie-session', trust: 'verified', capabilities: new Set(['*']),
      });
      const response = await app.request('http://127.0.0.1/admin/plan-audit', {
        method, headers: { host: '127.0.0.1', ...(identity === 'trusted-bearer' ? { authorization: 'Bearer fixture-trusted' } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(auditRequest) } : {}),
      });
      expect(response.status).toBe(method === 'POST' ? 202 : 200);
      if (method === 'POST') expect(h.start).toHaveBeenCalledOnce();
      else expect(h.list).toHaveBeenCalledOnce();
    });
    it('refuses a rejected credential before ' + method + ' effects instead of falling back to loopback', async () => {
      h.appKey.mockResolvedValue({ ok: false, reason: 'invalid key' });
      const response = await app.request('http://127.0.0.1/admin/plan-audit', {
        method, headers: { host: '127.0.0.1', authorization: 'Bearer pcapp_rejected' },
        ...(method === 'POST' ? { body: JSON.stringify(auditRequest) } : {}),
      });
      expect(response.status).toBe(401);
      expect(h.start).not.toHaveBeenCalled();expect(h.list).not.toHaveBeenCalled();
    });
  }
  it.each(['http://127.0.0.1:3170', 'tauri://tauri.localhost'])('admits a desktop start from %s', async origin => {
    const response = await app.request('http://127.0.0.1/admin/plan-audit', {
      method: 'POST', headers: { host: '127.0.0.1', origin }, body: JSON.stringify(auditRequest),
    });
    expect(response.status).toBe(202);expect(h.start).toHaveBeenCalledOnce();
  });
  it.each(['https://foreign.example', 'null'])('rejects a simple cross-origin start from %s before creating an audit', async origin => {
    const response = await app.request('http://127.0.0.1/admin/plan-audit', {
      method: 'POST', headers: { host: '127.0.0.1', origin, 'content-type': 'text/plain' }, body: JSON.stringify(auditRequest),
    });
    expect(response.status).toBe(403);expect(h.start).not.toHaveBeenCalled();
  });
  it('rejects a cross-site browser start without Origin before creating an audit', async () => {
    const response = await app.request('http://127.0.0.1/admin/plan-audit', {
      method: 'POST', headers: { host: '127.0.0.1', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, body: JSON.stringify(auditRequest),
    });
    expect(response.status).toBe(403);expect(h.start).not.toHaveBeenCalled();
  });
  it('keeps the handler CSRF backstop effective when invoked directly', async () => {
    const response = await planAuditHandler(new Request('http://127.0.0.1/admin/plan-audit', {
      method: 'POST', headers: { origin: 'https://foreign.example', 'content-type': 'text/plain' }, body: JSON.stringify(auditRequest),
    }), ctx);
    expect(response.status).toBe(403);expect(h.start).not.toHaveBeenCalled();
  });
});
