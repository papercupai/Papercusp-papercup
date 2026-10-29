import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostedPrincipal } from './auth/hosted-principal';
import { cloudTelemetryIdentity, prepareCloudTelemetryDelivery } from './cloud-telemetry';
import { readCloudProductUsage, readCloudProductUsageForSubject, ensureCloudMonitoringDashboard } from './cloud-telemetry-posthog';
import { DEFAULT_CLOUD_TELEMETRY_CONSENT, type CloudTelemetryConsent } from './telemetry-kinds';

const config = vi.hoisted(() => ({ value: { host: 'https://posthog.invalid', projectKey: 'capture-key', personalApiKey: 'admin-key' } as
  { host: string; projectKey: string; personalApiKey?: string } | null }));
vi.mock('./posthog-config', () => ({ getPosthogConfigWithSource: () => ({ config: config.value }) }));
const principal = createHostedPrincipal({ workspaceId: 'control', activeOrganizationId: 'tenant-a', userId: 'user-a',
  sessionId: 'session-a', sessionVersion: 1, permissions: [] });
const context = { principal, environment: 'production' as const };
const consent: CloudTelemetryConsent = { ...DEFAULT_CLOUD_TELEMETRY_CONSENT, analytics: { enabled: true, since: '2026-10-15T00:00:00Z' } };
const window = { windowStart: '2026-10-10T00:00:00Z', windowEnd: '2026-10-27T00:00:00Z' };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const observed = () => ({ columns: ['observations', 'portalSessionObservations', 'readyProvisioningObservations', 'featureAdoptionObservations'], results: [[4, 2, 1, 1]] });
function transport(queryResult: unknown = observed()) {
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/projects/') return response({ results: [{ id: 7, api_token: 'capture-key' }], next: null });
    if (path === '/api/projects/7/query/' && init?.method === 'POST') return response(queryResult);
    throw new Error(`unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
afterEach(() => {
  vi.unstubAllGlobals();
  config.value = { host: 'https://posthog.invalid', projectKey: 'capture-key', personalApiKey: 'admin-key' };
});

describe('P019 hosted product observations reuse capture identity, consent and project', () => {
  it('service subject uses exactly the browser capture selectors and rechecks consent after the vendor read', async () => {
    const fetcher = transport();
    const readConsent = vi.fn(async () => consent);
    const result = await readCloudProductUsageForSubject({ subject: { userId: principal.userId,
      organizationId: principal.activeOrganizationId }, environment: 'production', ...window, readConsent });
    expect(result.status).toBe('observed');
    expect(readConsent).toHaveBeenCalledTimes(3);
    const query = JSON.parse(String(fetcher.mock.calls[1]![1]!.body)).query.query as string;
    const identity = cloudTelemetryIdentity(context);
    expect(query).toContain(`distinct_id = '${identity.distinctId}'`);
    expect(query).toContain(`properties.organization_id = '${identity.organizationId}'`);
    expect(query).not.toMatch(/user-a|tenant-a|session-a/);
    readConsent.mockResolvedValueOnce(consent).mockResolvedValueOnce({ ...consent, analytics: { enabled: false, since: null } });
    expect(await readCloudProductUsageForSubject({ subject: { userId: principal.userId,
      organizationId: principal.activeOrganizationId }, environment: 'production', ...window, readConsent }))
      .toEqual({ status: 'unknown', reason: 'consent_changed' });
    // The changed service authority is caught after catalog discovery and
    // BEFORE a second query sends the subject selectors.
    expect(fetcher.mock.calls.filter(call => new URL(String(call[0])).pathname.endsWith('/query/'))).toHaveLength(1);
  });
  it.each([
    ['configuration', 'project-selection'],
    ['authentication', 'project-selection'],
    ['timeout', 'usage-query'],
    ['transport', 'usage-query'],
    ['response', 'usage-query'],
    ['unavailable', 'consent-recheck'],
  ] as const)('retains only safe %s diagnostics at %s', async (category, stage) => {
    const fetcher = transport();
    if (category === 'configuration') config.value = null;
    if (category === 'authentication') fetcher.mockImplementation(async () => response({ secret: 'private-vendor-body' }, 403));
    if (stage === 'usage-query') {
      const original = fetcher.getMockImplementation()!;
      fetcher.mockImplementation(async (url, init) => {
        if (new URL(String(url)).pathname.endsWith('/query/')) {
          if (category === 'timeout') throw new DOMException('admin-key private-query', 'TimeoutError');
          if (category === 'transport') throw new TypeError('admin-key private-query');
          return new Response('private-vendor-body', { status: 502 });
        }
        return original(url, init);
      });
    }
    const readConsent = vi.fn().mockResolvedValueOnce(consent);
    if (stage === 'consent-recheck') readConsent.mockRejectedValueOnce(new Error('private-customer-data'));
    else readConsent.mockResolvedValue(consent);
    const failures: unknown[] = [];
    expect(await readCloudProductUsage({ context, ...window, readConsent, onUnavailable: failure => failures.push(failure) }))
      .toEqual({ status: 'unknown', reason: 'usage_query_unavailable' });
    expect(failures).toEqual([{ stage, category }]);
    expect(JSON.stringify(failures)).not.toMatch(/admin-key|private|user-a|tenant-a/);
  });

  it('preserves unknown when the trusted diagnostic observer fails', async () => {
    config.value = null;
    expect(await readCloudProductUsage({ context, ...window, readConsent: async () => consent,
      onUnavailable: () => { throw new Error('logging unavailable'); } }))
      .toEqual({ status: 'unknown', reason: 'usage_query_unavailable' });
  });

  it('queries the capture project with exact opaque identity and effective consent window, without dashboard writes', async () => {
    const fetcher = transport();
    const readConsent = vi.fn(async () => consent);
    const result = await readCloudProductUsage({ context, ...window, readConsent });
    expect(result).toMatchObject({ status: 'observed', observations: 4, portalSessionObservations: 2, readyProvisioningObservations: 1, featureAdoptionObservations: 1,
      windowStart: '2026-10-15T00:00:00.000Z', windowEnd: '2026-10-27T00:00:00.000Z',
      evidenceRef: expect.stringMatching(/^posthog:7:hogql:[a-f0-9]{64}$/) });
    expect(readConsent).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls).toHaveLength(2);
    const capture = prepareCloudTelemetryDelivery({ event: 'cloud_portal_session',
      operation_id: '00000000-0000-4000-8000-000000000001', properties: { action: 'returned' } },
    { ...context, release: 'abcdef1234567', origin: 'portal', hostingMode: 'managed', observedAt: '2026-10-26T00:00:00Z' }, consent);
    if (!capture.ok) throw new Error('capture positive control failed');
    const query = JSON.parse(String(fetcher.mock.calls[1]![1]!.body)).query.query as string;
    expect(query).toContain(`distinct_id = '${capture.envelope.distinct_id}'`);
    expect(query).toContain(`properties.organization_id = '${capture.envelope.properties.organization_id}'`);
    expect(query).toContain("properties.environment = 'production'");
    expect(query).toContain('properties.synthetic = false');
    expect(query).toContain("properties.source IN ('portal', 'control-plane')");
    expect(query).toContain("properties.phase = 'ready' AND properties.source = 'control-plane'");
    expect(query).not.toMatch(/user-a|tenant-a|session-a|cloud_diagnostic|email.open/i);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ redirect: 'error' });
  });

  it('separates user, organization and environment with the capture writer derivation', () => {
    const identity = cloudTelemetryIdentity(context);
    expect(cloudTelemetryIdentity({ ...context, principal: { ...principal, sessionId: 'new-session' } })).toEqual(identity);
    for (const other of [
      { ...context, environment: 'staging' as const },
      { ...context, principal: { ...principal, userId: 'user-b', slug: 'user-b' } },
      { ...context, principal: { ...principal, activeOrganizationId: 'tenant-b' } },
    ]) expect(cloudTelemetryIdentity(other).distinctId).not.toBe(identity.distinctId);
  });

  it.each([
    ['disabled', DEFAULT_CLOUD_TELEMETRY_CONSENT, 'consent_disabled'],
    ['malformed', {}, 'consent_unavailable'],
    ['later epoch', { ...consent, analytics: { enabled: true, since: window.windowEnd } }, 'outside_consent_epoch'],
  ])('does not query with %s consent', async (_name, value, reason) => {
    const fetcher = transport();
    expect(await readCloudProductUsage({ context, ...window, readConsent: async () => value })).toEqual({ status: 'unknown', reason });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses unverified identity and invalid windows before reading consent or making network requests', async () => {
    const fetcher = transport();
    const readConsent = vi.fn(async () => consent);
    expect(await readCloudProductUsage({ context: { ...context, principal: { ...principal, slug: 'different-user' } },
      ...window, readConsent })).toEqual({ status: 'unknown', reason: 'identity_unavailable' });
    for (const windowStart of ['invalid', '2026-09-01T00:00:00Z', window.windowEnd]) {
      expect(await readCloudProductUsage({ context, ...window, windowStart, readConsent }))
        .toEqual({ status: 'unknown', reason: 'invalid_window' });
    }
    expect(readConsent).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { ...DEFAULT_CLOUD_TELEMETRY_CONSENT },
    { ...consent, analytics: { enabled: true, since: '2026-10-20T00:00:00Z' } },
  ])('refuses a revoked or changed consent epoch after the query', async current => {
    transport();
    const readConsent = vi.fn().mockResolvedValueOnce(consent).mockResolvedValueOnce(current);
    expect(await readCloudProductUsage({ context, ...window, readConsent })).toEqual({ status: 'unknown', reason: 'consent_changed' });
  });

  it.each([
    {}, { results: [[4, 2, 1, 1]] },
    { ...observed(), results: [[1, 2, 1, 1]] },
    { ...observed(), results: [[4, -1, 1, 4]] },
    { ...observed(), results: [[4, 2, 1, '1']] },
    { ...observed(), results: [[4, 2, 1, 1], [4, 2, 1, 1]] },
    { ...observed(), has_more: true },
  ])('keeps malformed or incomplete query responses unknown', async body => {
    transport(body);
    expect(await readCloudProductUsage({ context, ...window, readConsent: async () => consent }))
      .toEqual({ status: 'unknown', reason: 'usage_response_invalid' });
  });

  it('keeps an empty observation distinct from a measured zero score', async () => {
    transport({ ...observed(), results: [[0, 0, 0, 0]] });
    expect(await readCloudProductUsage({ context, ...window, readConsent: async () => consent }))
      .toEqual({ status: 'unknown', reason: 'no_observations' });
  });

  it('fails closed when admin access or the exact capture project is unavailable', async () => {
    const fetcher = transport();
    config.value = null;
    expect(await readCloudProductUsage({ context, ...window, readConsent: async () => consent })).toEqual({ status: 'unknown', reason: 'usage_query_unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
    config.value = { host: 'https://posthog.invalid', projectKey: 'capture-key', personalApiKey: 'admin-key' };
    fetcher.mockImplementation(async () => response({ results: [{ id: 8, api_token: 'other-project' }], next: null }));
    expect(await readCloudProductUsage({ context, ...window, readConsent: async () => consent })).toEqual({ status: 'unknown', reason: 'usage_query_unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retains the dashboard credential failure contract after extracting the shared read path', async () => {
    config.value = null;
    await expect(ensureCloudMonitoringDashboard('production')).rejects.toThrow('posthog_dashboard_credentials_unavailable');
  });

  it('does not send the admin credential to a foreign catalog continuation', async () => {
    const fetcher = transport();
    fetcher.mockImplementation(async () => response({ results: [], next: 'https://foreign.invalid/api/projects/' }));
    expect(await readCloudProductUsage({ context, ...window, readConsent: async () => consent }))
      .toEqual({ status: 'unknown', reason: 'usage_query_unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not return observations after a query failure or loss of the final consent read', async () => {
    const fetcher = transport();
    fetcher.mockImplementation(async () => { throw new Error('unreachable'); });
    expect(await readCloudProductUsage({ context, ...window, readConsent: async () => consent }))
      .toEqual({ status: 'unknown', reason: 'usage_query_unavailable' });
    transport();
    const readConsent = vi.fn().mockResolvedValueOnce(consent).mockRejectedValueOnce(new Error('consent read failed'));
    expect(await readCloudProductUsage({ context, ...window, readConsent }))
      .toEqual({ status: 'unknown', reason: 'usage_query_unavailable' });
  });
});
