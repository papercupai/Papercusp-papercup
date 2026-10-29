// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { configureOperatorUi, OperatorWorkspaceLocationProvider } from './seam';
import { createHash } from 'node:crypto';
import { captureBrowserTelemetry, CloudMonitoringPreferences, CloudPortalVisit, PostHogProvider, reportCloudError, useCloudFeatureAdoption } from './browser-telemetry';
import { DEFAULT_CLOUD_TELEMETRY_CONSENT } from '@papercusp/operator-core/lib/telemetry-kinds';

const sdkFixture = vi.hoisted(() => ({
  client: { init: vi.fn(), capture: vi.fn(), identify: vi.fn() },
  state: {
    client: null as typeof import('posthog-js').default | null,
    initializing: null as Promise<typeof import('posthog-js').default> | null,
  },
}));
vi.mock('posthog-js', () => ({ default: sdkFixture.client }));
vi.mock('@papercusp/module-singleton', async importOriginal => {
  const original = await importOriginal<typeof import('@papercusp/module-singleton')>();
  return { ...original, pinModuleState: <T,>(key: string, initialize: () => T): T =>
    key === '@papercusp/operator-ui.browser-telemetry' ? sdkFixture.state as T : original.pinModuleState(key, initialize) };
});

afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks();
  configureOperatorUi({ setConsentedTelemetryOrigin: () => {} });
  sdkFixture.state.client = null; sdkFixture.state.initializing = null;
});

describe('browser telemetry host consent boundary', () => {
  it('keeps the hosted browser SDK absent and disables automatic capture and session replay for consented local events', async () => {
    const consentFetch = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => new Response(JSON.stringify({
      enabled: true, host: 'https://analytics.example.test', project_key: 'test-project', distinct_id: 'opaque-person',
    }), { status: 200 }));
    vi.stubGlobal('fetch', consentFetch);
    await captureBrowserTelemetry('cloud_portal_session', { action: 'returned' }, 'cloud');
    expect(sdkFixture.client.init).not.toHaveBeenCalled();
    expect(sdkFixture.client.capture).not.toHaveBeenCalled();
    expect(consentFetch).toHaveBeenCalledTimes(1);
    expect(consentFetch.mock.calls[0][0]).toBe('/api/hosted/browser/monitoring/event');

    await captureBrowserTelemetry('tutorial.event', { action: 'start' });
    expect(sdkFixture.client.init).toHaveBeenCalledTimes(1);
    expect(sdkFixture.client.init).toHaveBeenCalledWith('test-project', expect.objectContaining({
      api_host: 'https://analytics.example.test', person_profiles: 'identified_only',
      capture_pageview: false, capture_pageleave: false, autocapture: false, disable_session_recording: true,
    }));
    expect(sdkFixture.client.capture).toHaveBeenCalledWith('tutorial.event', { action: 'start' });
  });

  it('observes a hosted return without a desktop consent probe or vendor SDK', async () => {
    const consentFetch = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', consentFetch);
    render(<OperatorWorkspaceLocationProvider location="cloud">
      <PostHogProvider><p>Hosted guide</p></PostHogProvider>
    </OperatorWorkspaceLocationProvider>);
    await captureBrowserTelemetry('tutorial.event', { action: 'start' }, 'cloud');
    expect(consentFetch).toHaveBeenCalledTimes(1);
    const [url, init] = consentFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/hosted/browser/monitoring/event');
    expect(JSON.parse(String(init.body))).toMatchObject({ event: 'cloud_portal_session', properties: { action: 'returned' } });
  });

  it('rechecks the existing desktop consent endpoint for local explicit events', async () => {
    const consentFetch = vi.fn(async () => new Response(JSON.stringify({ enabled: false }), { status: 200 }));
    vi.stubGlobal('fetch', consentFetch);
    await captureBrowserTelemetry('tutorial.event', { action: 'start' });
    expect(consentFetch).toHaveBeenCalledWith('/api/desktop/telemetry-config', { cache: 'no-store' });
  });

  it('allows only the validated HTTPS origin returned by enabled desktop consent and clears it otherwise', async () => {
    const setOrigin = vi.fn();
    configureOperatorUi({ setConsentedTelemetryOrigin: setOrigin });
    const consentFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        enabled: true, host: 'https://analytics.example.test/capture', project_key: 'test-project',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        enabled: true, host: 'http://unknown.example.test', project_key: 'test-project',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: false }), { status: 200 }));
    vi.stubGlobal('fetch', consentFetch);

    await captureBrowserTelemetry('tutorial.event', { action: 'start' });
    expect(setOrigin).toHaveBeenNthCalledWith(1, 'https://analytics.example.test');
    expect(sdkFixture.client.init).toHaveBeenCalledTimes(1);

    await captureBrowserTelemetry('tutorial.event', { action: 'start' });
    expect(setOrigin).toHaveBeenNthCalledWith(2, null);
    expect(sdkFixture.client.capture).toHaveBeenCalledTimes(1);

    await captureBrowserTelemetry('tutorial.event', { action: 'start' });
    expect(setOrigin).toHaveBeenNthCalledWith(3, null);
    expect(sdkFixture.client.capture).toHaveBeenCalledTimes(1);
  });

  it('uses only authenticated explicit hosted metadata, without desktop consent or a vendor SDK', async () => {
    const captureFetch = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', captureFetch);
    await captureBrowserTelemetry('cloud_portal_session', { action: 'returned' }, 'cloud');
    expect(captureFetch).toHaveBeenCalledTimes(1);
    const [path, options] = captureFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/hosted/browser/monitoring/event');
    expect(options.credentials).toBe('include');
    const body = JSON.parse(String(options.body));
    expect(body.properties).toEqual({ action: 'returned' });
    expect(body.operation_id).toMatch(/^[a-f0-9-]{36}$/);
    for (const [event, properties] of [
      ['cloud_portal_session', { action: 'returned', prompt: 'secret' }],
      ['cloud_tutorial', { lesson_id: 'first-cloud-agent', lesson_version: 1, action: 'step_confirmed', step: 'task' }],
      ['cloud_tutorial', { lesson_id: 'first-cloud-agent', lesson_version: 1, action: 'complete' }],
    ] as const) await captureBrowserTelemetry(event, properties, 'cloud');
    expect(captureFetch).toHaveBeenCalledTimes(1);
  });

  it('retains the local provider consent check', () => {
    const consentFetch = vi.fn(async () => new Response('', { status: 403 }));
    vi.stubGlobal('fetch', consentFetch);
    render(<PostHogProvider><p>Desktop</p></PostHogProvider>);
    expect(consentFetch).toHaveBeenCalledTimes(1);
  });

  it('exports fixed public guide navigation but leaves saved reviews to the server witness', async () => {
    const captureFetch = vi.fn(async () => new Response('{}', { status: 202 })); vi.stubGlobal('fetch', captureFetch);
    const properties = { lesson_id: 'product-guide', lesson_version: 3, action: 'lesson_displayed', lesson: 'welcome' };
    await captureBrowserTelemetry('product_tutorial', properties, 'cloud');
    await captureBrowserTelemetry('product_tutorial', { ...properties, action: 'explanation_reviewed' }, 'cloud');
    await captureBrowserTelemetry('product_tutorial', { ...properties, lesson: 'private-task-title' }, 'cloud');
    expect(captureFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((captureFetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)).properties).toEqual(properties);
  });

  it('discloses separate opt-in choices and saves a server-confirmed choice without local consent probes', async () => {
    const consentFetch = vi.fn(async (_url, options?: RequestInit) => new Response(JSON.stringify({ consent: options?.method === 'POST'
      ? { ...DEFAULT_CLOUD_TELEMETRY_CONSENT, analytics: { enabled: true, since: '2026-10-14T00:00:00Z' } }
      : DEFAULT_CLOUD_TELEMETRY_CONSENT }), { status: 200 }));
    vi.stubGlobal('fetch', consentFetch);
    render(<OperatorWorkspaceLocationProvider location="cloud"><CloudMonitoringPreferences /></OperatorWorkspaceLocationProvider>);
    const analytics = screen.getByRole('checkbox', { name: 'Share portal analytics' }) as HTMLInputElement;
    const diagnostics = screen.getByRole('checkbox', { name: 'Allow aggregate diagnostic export' }) as HTMLInputElement;
    await waitFor(() => expect(analytics.disabled).toBe(false));
    expect(analytics.checked).toBe(false); expect(diagnostics.checked).toBe(false);
    fireEvent.click(analytics);
    await waitFor(() => expect(analytics.checked).toBe(true));
    expect(diagnostics.checked).toBe(false);
    const preferenceCalls = consentFetch.mock.calls.filter(([url]) => url === '/api/hosted/browser/monitoring');
    const options = preferenceCalls[1][1];
    expect(JSON.parse(String(options?.body))).toEqual({ disclosure_version: DEFAULT_CLOUD_TELEMETRY_CONSENT.disclosure_version, analytics: true });
    expect(screen.getByText(/no enforced event-deletion limit/)).toBeTruthy();
    const adoption = consentFetch.mock.calls.find(([url]) => url === '/api/hosted/browser/monitoring/event');
    expect(JSON.parse(String(adoption?.[1]?.body))).toMatchObject({ event: 'cloud_feature_adoption', properties: { feature: 'monitoring' } });
  });

  it('keeps failed preference reads unknown and never renders hosted choices locally', async () => {
    const consentFetch = vi.fn(async () => new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', consentFetch);
    const view = render(<CloudMonitoringPreferences />);
    expect(consentFetch).not.toHaveBeenCalled();
    view.rerender(<OperatorWorkspaceLocationProvider location="cloud"><CloudMonitoringPreferences /></OperatorWorkspaceLocationProvider>);
    await screen.findByRole('alert');
    expect((screen.getByRole('checkbox', { name: 'Share portal analytics' }) as HTMLInputElement).disabled).toBe(true);
  });

  it('explains an administrator grant refusal and keeps the saved diagnostic choice disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, options?: RequestInit) => options?.method === 'POST'
      ? new Response(JSON.stringify({ error: 'diagnostic_export_admin_required' }), { status: 403 })
      : new Response(JSON.stringify({ consent: DEFAULT_CLOUD_TELEMETRY_CONSENT }), { status: 200 })));
    render(<OperatorWorkspaceLocationProvider location="cloud"><CloudMonitoringPreferences /></OperatorWorkspaceLocationProvider>);
    const diagnostics = screen.getByRole('checkbox', { name: 'Allow aggregate diagnostic export' }) as HTMLInputElement;
    await waitFor(() => expect(diagnostics.disabled).toBe(false));
    fireEvent.click(diagnostics);
    expect((await screen.findByRole('alert')).textContent).toContain('owner or administrator');
    expect(diagnostics.checked).toBe(false);
    expect(diagnostics.disabled).toBe(false);
  });
});

const hostedEvents = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls
  .filter(([url]) => url === '/api/hosted/browser/monitoring/event')
  .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

describe('portal producers for the disclosed analytics (blind review G-1..G-3)', () => {
  it('records one hosted return per portal shell mount and nothing for a local shell', async () => {
    const captureFetch = vi.fn(async () => new Response('{}', { status: 202 })); vi.stubGlobal('fetch', captureFetch);
    const local = render(<CloudPortalVisit location="local" />);
    local.unmount();
    expect(captureFetch).not.toHaveBeenCalled();
    const view = render(<CloudPortalVisit location="cloud" />);
    view.rerender(<CloudPortalVisit location="cloud" />);
    await waitFor(() => expect(captureFetch).toHaveBeenCalledTimes(1));
    expect(hostedEvents(captureFetch)).toMatchObject([{ event: 'cloud_portal_session', properties: { action: 'returned' } }]);
    // The seam location is the default when the host passes none.
    render(<OperatorWorkspaceLocationProvider location="cloud"><CloudPortalVisit /></OperatorWorkspaceLocationProvider>);
    await waitFor(() => expect(captureFetch).toHaveBeenCalledTimes(2));
  });

  it('records each disclosed feature once per mount, only when hosted and active', async () => {
    const captureFetch = vi.fn(async () => new Response('{}', { status: 202 })); vi.stubGlobal('fetch', captureFetch);
    function Surface({ active, location }: { active: boolean; location?: 'cloud' | 'local' }) {
      useCloudFeatureAdoption('connection_setup', { active, location });
      return null;
    }
    const local = render(<Surface active location="local" />);
    local.unmount();
    const view = render(<Surface active={false} location="cloud" />);
    expect(captureFetch).not.toHaveBeenCalled();
    view.rerender(<Surface active location="cloud" />);
    view.rerender(<Surface active={false} location="cloud" />);
    view.rerender(<Surface active location="cloud" />);
    await waitFor(() => expect(captureFetch).toHaveBeenCalledTimes(1));
    expect(hostedEvents(captureFetch)).toMatchObject([{ event: 'cloud_feature_adoption', properties: { feature: 'connection_setup' } }]);
  });

  it('reports a hosted render failure as a code plus the server-compatible fingerprint, never the message', async () => {
    const captureFetch = vi.fn(async () => new Response('{}', { status: 202 })); vi.stubGlobal('fetch', captureFetch);
    const failure = new TypeError('private-profile acme-corp /secret/path');
    await reportCloudError('render_failure', failure, 'local');
    expect(captureFetch).not.toHaveBeenCalled();
    await reportCloudError('render_failure', failure, 'cloud');
    const [event] = hostedEvents(captureFetch);
    // Pinned to the server's safeCloudError formula: sha256(JSON.stringify([code, type])).
    const expected = createHash('sha256').update(JSON.stringify(['render_failure', 'TypeError'])).digest('hex');
    expect(event).toMatchObject({ event: 'cloud_error', properties: { code: 'render_failure', fingerprint: expected } });
    expect(Object.keys(event.properties).sort()).toEqual(['code', 'fingerprint']);
    expect(JSON.stringify(captureFetch.mock.calls)).not.toContain('private-profile');
    // An unreviewed error type collapses to Error, exactly as on the server.
    class CustomerError extends Error { override name = 'AcmeCorpError'; }
    await reportCloudError('render_failure', new CustomerError('x'), 'cloud');
    expect(hostedEvents(captureFetch)[1].properties.fingerprint)
      .toBe(createHash('sha256').update(JSON.stringify(['render_failure', 'Error'])).digest('hex'));
    expect(JSON.stringify(captureFetch.mock.calls)).not.toContain('AcmeCorp');
  });
});
