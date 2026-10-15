import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { RouteContext } from '@papercusp/tooldef';
import { createHostedPrincipal } from '../../auth/hosted-principal';
import { DEFAULT_CLOUD_TELEMETRY_CONSENT } from '../../telemetry-kinds';

const h = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('../../cloud-telemetry', () => ({ readCloudTelemetryConsent: h.read, writeCloudTelemetryConsent: h.write }));
vi.mock('../../build-info', () => ({ getBuildInfo: () => ({ sha: 'abcdef1234567', version: '1' }) }));
import { createHostedCloudMonitoringRoutes, HOSTED_BROWSER_MONITORING_PATH, HOSTED_BROWSER_MONITORING_EVENT_PATH } from './hosted-cloud-monitoring';

const origin = 'https://app.papercusp.com';
const principal = createHostedPrincipal({ workspaceId: 'control', userId: 'user-a', activeOrganizationId: 'organization-a',
  sessionId: 'session-a', sessionVersion: 1, permissions: [] });
const context = (actor: unknown = principal) => ({ principal: actor, params: {}, input: undefined,
  signal: new AbortController().signal, log: () => {} }) as RouteContext;
const request = (body: unknown, requestOrigin = origin) => new Request(origin + '/api' + HOSTED_BROWSER_MONITORING_PATH,
  { method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); h.read.mockResolvedValue(DEFAULT_CLOUD_TELEMETRY_CONSENT); h.write.mockResolvedValue(DEFAULT_CLOUD_TELEMETRY_CONSENT); });

function fixture() {
  const tx = (() => []) as unknown as Sql;
  const runTenant = vi.fn(async (_context, fn) => fn(tx));
  const deliver = vi.fn(async (_input: unknown, _context: unknown, _readConsent: () => Promise<unknown>) => ({ delivered: true }));
  const routes = createHostedCloudMonitoringRoutes({ origin, controlPlaneWorkspaceId: 'control', runTenant, deliver });
  return { runTenant, deliver, tx, get: routes[0].handler, post: routes[1].handler, event: routes[2].handler };
}

describe('hosted monitoring ingress', () => {
  it('requires administrator authority for diagnostic export grants but allows personal revocation and analytics', async () => {
    const f = fixture();
    const input = { disclosure_version: DEFAULT_CLOUD_TELEMETRY_CONSENT.disclosure_version, diagnostics: true };
    const member = createHostedPrincipal({ ...principal, permissions: ['workspace:view', 'workspace:operate'] });
    const admin = createHostedPrincipal({ ...principal, permissions: ['workspace:view', 'workspace:operate', 'members:manage'] });
    const denied = await f.post(request(input), context(member));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: 'diagnostic_export_admin_required' });
    expect(f.runTenant).not.toHaveBeenCalled(); expect(h.write).not.toHaveBeenCalled();
    expect((await f.post(request(input), context(admin))).status).toBe(200);
    expect((await f.post(request({ ...input, diagnostics: false }), context(member))).status).toBe(200);
    expect((await f.post(request({ disclosure_version: input.disclosure_version, analytics: true }), context(member))).status).toBe(200);
  });
  it('uses authenticated account scope before workspace selection and never trusts request identities', async () => {
    const f = fixture();
    const get = await f.get(new Request(origin + '/api' + HOSTED_BROWSER_MONITORING_PATH), context());
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ consent: DEFAULT_CLOUD_TELEMETRY_CONSENT });
    expect(f.runTenant.mock.calls[0][0].principal).toMatchObject({ activeOrganizationId: 'organization-a', userId: 'user-a' });
    const input = { disclosure_version: DEFAULT_CLOUD_TELEMETRY_CONSENT.disclosure_version, analytics: true };
    expect((await f.post(request(input), context())).status).toBe(200);
    expect(h.write).toHaveBeenCalledWith(f.tx, principal, input);
    expect((await f.post(request({ ...input, organization_id: 'organization-b' }), context())).status).toBe(400);
    expect(h.write).toHaveBeenCalledTimes(1);
  });
  it('refuses unauthenticated, cross-origin, foreign-host and workspace-header writes before tenant I/O', async () => {
    const f = fixture();
    const body = { disclosure_version: DEFAULT_CLOUD_TELEMETRY_CONSENT.disclosure_version, analytics: true };
    expect((await f.post(request(body), context(null))).status).toBe(401);
    expect((await f.post(request(body, 'https://foreign.invalid'), context())).status).toBe(403);
    expect((await f.post(request(body), context({ ...principal, workspaceId: 'other-control' }))).status).toBe(403);
    const forged = request(body); forged.headers.set('x-papercusp-workspace', 'foreign-workspace');
    expect((await f.post(forged, context())).status).toBe(403);
    expect(f.runTenant).not.toHaveBeenCalled();
  });
  it('passes only bounded metadata to the final delivery boundary and refuses browser outcome claims', async () => {
    const f = fixture();
    const body = { event: 'cloud_portal_session', operation_id: '00000000-0000-4000-8000-000000000001', properties: { action: 'returned' } };
    expect((await f.event(request(body), context())).status).toBe(202);
    expect(f.deliver.mock.calls[0][0]).toEqual(body);
    expect(f.deliver.mock.calls[0][1]).toMatchObject({ principal, origin: 'portal', hostingMode: 'byoc', release: 'abcdef1234567' });
    expect((await f.event(request({ ...body, properties: { ...body.properties, prompt: 'secret' } }), context())).status).toBe(400);
    expect((await f.event(request({ event: 'cloud_workspace_provisioning', operation_id: body.operation_id,
      properties: { phase: 'ready', provider: 'gcp', hosting_mode: 'byoc' } }), context())).status).toBe(400);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(HOSTED_BROWSER_MONITORING_EVENT_PATH).toBe('/hosted/browser/monitoring/event');
  });
  it('returns a non-blocking receipt when analytics delivery fails', async () => {
    const f = fixture(); f.deliver.mockRejectedValue(new Error('sink down'));
    const response = await f.event(request({ event: 'cloud_error', operation_id: '00000000-0000-4000-8000-000000000001',
      properties: { code: 'render_failure', fingerprint: 'a'.repeat(64) } }), context());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ delivered: false, code: 'delivery_unavailable' });
  });
  it('rejects a browser-forged saved explanation review before consulting the sink', async () => {
    const f = fixture();
    const response = await f.event(request({ event: 'product_tutorial', operation_id: '00000000-0000-4000-8000-000000000001',
      properties: { lesson_id: 'product-guide', lesson_version: 3, action: 'explanation_reviewed', lesson: 'welcome' } }), context());
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ ok: false, error: 'unwitnessed_outcome', message: 'unwitnessed_outcome' });
    expect(f.deliver).not.toHaveBeenCalled();
  });
});
