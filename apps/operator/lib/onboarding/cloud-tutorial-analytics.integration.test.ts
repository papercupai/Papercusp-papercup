// @vitest-environment jsdom
import { createElement, useReducer } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTutorialState, tutorialReducer } from '@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson';
const sdk = vi.hoisted(() => ({ init: vi.fn(), capture: vi.fn(), identify: vi.fn(), startSessionRecording: vi.fn(), stopSessionRecording: vi.fn() }));
vi.mock('posthog-js', () => ({ default: sdk }));
vi.mock('./cloud-tutorial-adapter', () => ({ CloudTutorialHighlight: () => null }));
let enabled = false;
beforeEach(() => {
  vi.resetModules(); for (const mock of Object.values(sdk)) mock.mockReset(); enabled = false;
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ enabled, host: 'https://telemetry.invalid', project_key: 'public-key', distinct_id: 'anonymous-install' })));
});
beforeEach(async () => {
  const { pinModuleState } = await import('@papercusp/module-singleton');
  const state = pinModuleState('@papercusp/operator-ui.browser-telemetry', () => ({ client: null, initializing: null }));
  state.client = null; state.initializing = null;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const scope = { tenantId: 'private-tenant', userId: 'private-user', workspaceId: 'private-workspace' };
async function mountGuide() {
  const { PostHogProvider } = await import('@/app/_components/PostHogProvider');
  const { CloudTutorialGuide } = await import('./cloud-tutorial-guide');
  function Fixture() {
    const [state, dispatch] = useReducer(tutorialReducer, tutorialReducer(createTutorialState(scope), { type: 'observe', observation: { scope, revision: 1, access: 'allowed', attempt: { step: 'connection', status: 'failed' } } }));
    return createElement(PostHogProvider, null, createElement('div', null,
      createElement('button', { onClick: () => dispatch({ type: 'observe', observation: { scope, revision: 2, access: 'allowed', connection: { id: 'private-connection', provider: 'gcp', validated: true } } }) }, 'Confirm product connection'),
      createElement(CloudTutorialGuide, { state, dispatch })));
  }
  return render(createElement(Fixture));
}
describe('Guide uses the existing PostHog consent boundary', () => {
  it('routes actual guide and help events through the hosted consent boundary while retaining local consent reads', async () => {
    const { hostedBrowserApiMarker } = await import('../hosted-browser-api');
    const { createTutorialAnalytics, recordTutorialHelpRequest } = await import('./cloud-tutorial-analytics');
    window.__PAPERCUSP_HOSTED_BROWSER__ = hostedBrowserApiMarker('control');
    const analytics = createTutorialAnalytics();
    try {
      analytics.update(createTutorialState(scope));
      recordTutorialHelpRequest('connection', 'ready');
      await act(async () => { await Promise.resolve(); });
      const requests = vi.mocked(fetch).mock.calls;
      expect(requests).toHaveLength(4);
      const sent = requests.map(([url, init]) => {
        expect(url).toBe('/api/hosted/browser/monitoring/event');
        expect(init).toMatchObject({ method: 'POST', credentials: 'include', keepalive: true });
        return JSON.parse(String(init?.body));
      });
      // Starting the hosted tutorial is the disclosed feature choice, recorded once.
      const adoption = sent.filter(payload => payload.event === 'cloud_feature_adoption');
      expect(adoption.map(payload => payload.properties)).toEqual([{ feature: 'cloud_tutorial' }]);
      const payloads = sent.filter(payload => payload.event !== 'cloud_feature_adoption').map(payload => {
        expect(Object.keys(payload).sort()).toEqual(['event', 'operation_id', 'properties']);
        expect(payload.event).toBe('cloud_tutorial');
        expect(payload.operation_id).toMatch(/^[a-f0-9-]{36}$/);
        expect(payload.properties).toMatchObject({ lesson_id: 'first-cloud-agent', lesson_version: 1 });
        expect(Object.keys(payload.properties).every(key =>
          ['lesson_id', 'lesson_version', 'action', 'step', 'status'].includes(key))).toBe(true);
        for (const privateId of Object.values(scope)) expect(JSON.stringify(payload)).not.toContain(privateId);
        return payload;
      });
      expect(payloads.map(payload => payload.properties.action)).toEqual(['start', 'step_displayed', 'help_requested']);
      expect(sdk.init).not.toHaveBeenCalled();
      expect(sdk.capture).not.toHaveBeenCalled();
      expect(sdk.identify).not.toHaveBeenCalled();
      expect(sdk.startSessionRecording).not.toHaveBeenCalled();

      // The same default sink must still check consent for a desktop host.
      delete window.__PAPERCUSP_HOSTED_BROWSER__;
      analytics.action('check_again', 'connection');
      await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/desktop/telemetry-config', { cache: 'no-store' }));
    } finally {
      delete window.__PAPERCUSP_HOSTED_BROWSER__;
    }
  });

  it('measures saved full-product guide progress only through the existing consent boundary', async () => {
    const { AccountProductTutorial } = await import('@papercusp/operator-ui/onboarding');
    const account = { tenantId: 'private-tenant', userId: 'private-user', sessionId: 'private-session', workspaceId: null };
    const progress = { scope: { tenantId: account.tenantId, userId: account.userId }, version: 3, revision: 0,
      mutationId: null, disposition: 'active', currentLessonId: 'welcome', reviewedLessonIds: [] as string[] };
    let failSave = false;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('telemetry-config')) return Response.json({ enabled, host: 'https://telemetry.invalid', project_key: 'public-key' });
      if (init?.method === 'POST') {
        if (failSave) throw new Error('offline');
        Object.assign(progress, JSON.parse(String(init.body)), { revision: progress.revision + 1 });
      }
      return Response.json({ record: { ...progress } });
    });
    render(createElement(AccountProductTutorial, { account, children: createElement('p', null, 'Destination') }));
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    await act(async () => { await Promise.resolve(); });
    expect(sdk.init).not.toHaveBeenCalled(); expect(sdk.capture).not.toHaveBeenCalled();
    enabled = true; failSave = true;
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed — next lesson' }));
    await screen.findByRole('button', { name: 'Retry saving choice' });
    await waitFor(() => expect(sdk.capture.mock.calls.some(([, p]) => p.action === 'waiting')).toBe(true));
    expect(sdk.capture.mock.calls.some(([, p]) => p.action === 'explanation_reviewed')).toBe(false);
    failSave = false; fireEvent.click(screen.getByRole('button', { name: 'Retry saving choice' }));
    await screen.findByRole('heading', { name: 'Find your way around' });
    await waitFor(() => expect(sdk.capture.mock.calls.some(([, p]) => p.action === 'explanation_reviewed' && p.lesson === 'welcome')).toBe(true));
    expect(sdk.capture.mock.calls.some(([, p]) => p.action === 'recovery')).toBe(true);
    expect(sdk.capture.mock.calls.every(([event]) => event === 'product_tutorial')).toBe(true);
    for (const value of Object.values(account).filter(Boolean)) expect(JSON.stringify(sdk.capture.mock.calls)).not.toContain(value);
    expect(sdk.startSessionRecording).not.toHaveBeenCalled(); expect(sdk.stopSessionRecording).not.toHaveBeenCalled();
    enabled = false; sdk.capture.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Pause guide' }));
    await screen.findByText('Destination');
    await act(async () => { await Promise.resolve(); });
    expect(sdk.capture).not.toHaveBeenCalled();
  });
  it('sends no tutorial events or SDK initialization while telemetry is disabled, and keeps the Guide usable', async () => {
    await mountGuide(); fireEvent.click(screen.getByRole('button', { name: 'Confirm product connection' }));
    await act(async () => { await Promise.resolve(); });
    expect(sdk.init).not.toHaveBeenCalled(); expect(sdk.capture).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' })); expect(screen.getByText('Your lesson is paused.')).toBeTruthy();
    expect(sdk.capture).not.toHaveBeenCalled();
  });
  it('records real confirmation and recovery when enabled, without private data or changing session replay', async () => {
    enabled = true; await mountGuide(); await waitFor(() => expect(sdk.capture).toHaveBeenCalled());
    expect(sdk.capture.mock.calls.some(([, p]) => p.action === 'step_confirmed')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm product connection' }));
    await waitFor(() => expect(sdk.capture.mock.calls.some(([, p]) => p.action === 'step_confirmed' && p.step === 'connection')).toBe(true));
    expect(sdk.capture.mock.calls.some(([, p]) => p.action === 'recovery')).toBe(true);
    expect(sdk.init).toHaveBeenCalledOnce(); expect(sdk.init.mock.calls[0][1].disable_session_recording).toBe(true);
    expect(sdk.startSessionRecording).not.toHaveBeenCalled(); expect(sdk.stopSessionRecording).not.toHaveBeenCalled();
    for (const value of [...Object.values(scope), 'private-connection']) expect(JSON.stringify(sdk.capture.mock.calls)).not.toContain(value);
  });
  it('rechecks opt-out after initialization and never queues events for a later opt-in', async () => {
    enabled = true; await mountGuide(); await waitFor(() => expect(sdk.capture).toHaveBeenCalled());
    const { captureBrowserTelemetry } = await import('@/app/_components/PostHogProvider');
    enabled = false; sdk.capture.mockClear(); await captureBrowserTelemetry('cloud_tutorial', { action: 'help_requested' });
    expect(sdk.capture).not.toHaveBeenCalled(); enabled = true;
    await captureBrowserTelemetry('cloud_tutorial', { action: 'pause' });
    expect(sdk.capture.mock.calls).toEqual([['cloud_tutorial', { action: 'pause' }]]);
  });
  it('keeps pause and product progress working during config or SDK failures', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('config offline')); await mountGuide();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' })); expect(screen.getByText('Your lesson is paused.')).toBeTruthy();
    enabled = true; vi.mocked(fetch).mockImplementation(async () => Response.json({ enabled: true, host: 'https://telemetry.invalid', project_key: 'public-key' }));
    sdk.capture.mockImplementation(() => { throw new Error('capture offline'); });
    fireEvent.click(screen.getByRole('button', { name: 'Resume guide' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm product connection' }));
    await waitFor(() => expect(screen.getByText('1 of 6 steps confirmed')).toBeTruthy());
    await act(async () => { await Promise.resolve(); });
    expect(sdk.capture).toHaveBeenCalled();
  });
  it('records help requests with only fixed lesson metadata', async () => {
    enabled = true; const { recordTutorialHelpRequest } = await import('./cloud-tutorial-analytics');
    recordTutorialHelpRequest('connection', 'ready');
    await waitFor(() => expect(sdk.capture).toHaveBeenCalledWith('cloud_tutorial', { lesson_id: 'first-cloud-agent', lesson_version: 1, action: 'help_requested', step: 'connection', status: 'ready' }));
  });
  it('does not initialize the provider after its pending consent read outlives the mount', async () => {
    let resolve!: (response: Response) => void; vi.mocked(fetch).mockImplementation(() => new Promise(r => { resolve = r; }));
    const { PostHogProvider } = await import('@/app/_components/PostHogProvider'); const view = render(createElement(PostHogProvider, null, 'Child'));
    view.unmount(); await act(async () => resolve(Response.json({ enabled: true, host: 'https://telemetry.invalid', project_key: 'public-key' })));
    expect(sdk.init).not.toHaveBeenCalled();
  });
});
