import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostedPrincipal } from './auth/hosted-principal';
import { DEFAULT_CLOUD_TELEMETRY_CONSENT } from './telemetry-kinds';
vi.mock('./posthog-config', () => ({ getPosthogConfigWithSource: () => ({ config: { host: 'https://sink.invalid', projectKey: 'capture-test-key' } }) }));
const local = vi.hoisted(() => ({ sql: vi.fn(async () => []), read: vi.fn(), write: vi.fn(), install: vi.fn(async () => 'local-install') }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: local.sql }) }));
vi.mock('./operator-state-pg', () => ({ readOperatorState: local.read, writeOperatorState: local.write }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'local-workspace' }));
vi.mock('./setup-wizard-install-id', () => ({ ensureInstallId: local.install }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('@papercusp/agent-mcp', () => ({ defineTool: (definition: unknown) => definition }));
import { deliverCloudPosthog, readCloudCaptureHealth, flushTelemetry, cloudMonitoringDashboardViews, ensureCloudMonitoringDashboard } from './telemetry-flush';
import telemetryConfig from './endpoint-route/routes/desktop/telemetry-config';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('strict cloud PostHog transport', () => {
  const principal = createHostedPrincipal({ workspaceId: 'control', activeOrganizationId: 'tenant-a', userId: 'user-a',
    sessionId: 'session-a', sessionVersion: 1, permissions: [] });
  const context = { principal, environment: 'staging' as const, release: 'abcdef1234567', origin: 'portal' as const, hostingMode: 'byoc' as const };
  const event = { event: 'cloud_portal_session', operation_id: '00000000-0000-4000-8000-000000000001', properties: { action: 'returned' } };
  const consent = { ...DEFAULT_CLOUD_TELEMETRY_CONSENT, analytics: { enabled: true, since: '2000-01-01T00:00:00Z' } };
  it('distinguishes capture health from a responsive admin API and handles outages', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(new Response('missing data', { status: 400 })).mockRejectedValueOnce(new Error('unreachable'));
    vi.stubGlobal('fetch', fetcher);
    expect(await readCloudCaptureHealth()).toEqual({ healthy: false, status: 502 });
    expect(await readCloudCaptureHealth()).toEqual({ healthy: true, status: 400 });
    expect(await readCloudCaptureHealth()).toEqual({ healthy: false, status: null });
  });
  it('sends strict opaque metadata with a stable vendor dedup identity and drops default/revoked input', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })); vi.stubGlobal('fetch', fetcher);
    const readConsent = vi.fn(async () => consent);
    expect(await deliverCloudPosthog(event, context, readConsent)).toEqual({ delivered: true });
    expect(await deliverCloudPosthog(event, context, readConsent)).toEqual({ delivered: true });
    const bodies = fetcher.mock.calls.map(call => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)));
    expect(bodies[0].batch[0].properties.$insert_id).toBe(bodies[1].batch[0].properties.$insert_id);
    expect(bodies[0].batch[0].properties.$insert_id).toMatch(/^[a-f0-9]{64}$/);
    expect(bodies[0].batch[0].uuid).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(bodies[0].batch[0].uuid).toBe(bodies[1].batch[0].uuid);
    expect(JSON.stringify(bodies)).not.toMatch(/tenant-a|user-a|session-a/);
    expect(await deliverCloudPosthog(event, context, async () => DEFAULT_CLOUD_TELEMETRY_CONSENT)).toMatchObject({ delivered: false });
    expect(await deliverCloudPosthog({ ...event, properties: { ...event.properties, prompt: 'private' } }, context, readConsent)).toMatchObject({ delivered: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('returns a dropped-event receipt for capture rejection without rejecting product work', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));
    expect(await deliverCloudPosthog(event, context, async () => consent)).toEqual({ delivered: false, code: 'delivery_unavailable' });
  });

  it('deduplicates readiness retries without collapsing distinct provisioning phases', async () => {
    const bodies: Array<{ batch: Array<{ properties: { $insert_id: string } }> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 200 });
    }));
    for (const phase of ['requested', 'ready', 'ready', 'failed'] as const) {
      expect(await deliverCloudPosthog({ event: 'cloud_workspace_provisioning', operation_id: event.operation_id,
        properties: { phase, provider: 'gcp', hosting_mode: 'byoc' } },
      { ...context, origin: 'control-plane' }, async () => consent)).toEqual({ delivered: true });
    }
    const ids = bodies.map(body => body.batch[0]!.properties.$insert_id);
    expect(ids[1]).toBe(ids[2]);
    expect(new Set(ids).size).toBe(3);
  });

  it('deduplicates guide review retries without collapsing distinct public lessons in one mutation', async () => {
    const bodies: Array<{ batch: Array<{ properties: { $insert_id: string } }> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body))); return new Response('{}', { status: 200 });
    }));
    for (const lesson of ['welcome', 'navigation', 'navigation']) {
      expect(await deliverCloudPosthog({ event: 'product_tutorial', operation_id: event.operation_id,
        properties: { lesson_id: 'product-guide', lesson_version: 3, action: 'explanation_reviewed', lesson } },
      { ...context, origin: 'control-plane' }, async () => consent)).toEqual({ delivered: true });
    }
    const ids = bodies.map(body => body.batch[0]!.properties.$insert_id);
    expect(ids[0]).not.toBe(ids[1]); expect(ids[1]).toBe(ids[2]);
  });

  it('keeps business views environment-scoped, excludes synthetic/private-runtime events and counts confirmed readiness only', () => {
    for (const environment of ['production', 'staging', 'development'] as const) {
      const views = cloudMonitoringDashboardViews(environment);
      for (const view of views) {
        expect(view.query).toContain(`properties.environment = '${environment}'`);
        expect(view.query).toContain('properties.synthetic = false');
        expect(view.query).toContain("properties.source IN ('portal', 'control-plane')");
        expect(view.query).not.toMatch(/cloud_diagnostic_aggregate|input_tokens|output_tokens|task_succeeded/);
      }
      expect(views.find(view => view.name === 'Confirmed ready duration')!.query).toContain("properties.phase = 'ready'");
      expect(views.find(view => view.name === 'Public explanations reviewed')!.query).toContain("properties.source = 'control-plane'");
      expect(views.find(view => view.name === 'Observed seven-day portal return')!.query).toContain('INTERVAL 7 DAY');
    }
    expect(() => cloudMonitoringDashboardViews('invalid' as 'staging')).toThrow('invalid_monitoring_environment');
  });

  it('requires configured dashboard authorization and performs no write when it is unavailable', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(ensureCloudMonitoringDashboard('production')).rejects.toThrow('posthog_dashboard_credentials_unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps legacy reports and browser SDK local on customer hosts despite opt-in and maintainer flags', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('PAPERCUSP_INTERNAL_BUILD', 'true');
    vi.stubEnv('PAPERCUSP_HOSTED_WORKSPACE_ROOT', '/customer/workspace');
    vi.stubEnv('PAPERCUSP_LOOPBACK_PEER_UID_POLICY', 'off');
    local.read.mockImplementation(async (key: string) => key === 'setup_wizard_state'
      ? { telemetry_enabled: true } : { reports: [{ kind: 'crash', payload: { prompt: 'private-content' }, received_at: '2026-10-14T00:00:00Z' }] });
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const result = await flushTelemetry();
    expect(result.archived).toBe(1);
    expect(result.forwarded).toBe(0);
    const response = await (telemetryConfig.handler as () => Promise<Response>)();
    expect(await response.json()).toEqual({ enabled: false, reason: 'customer-data-local' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
