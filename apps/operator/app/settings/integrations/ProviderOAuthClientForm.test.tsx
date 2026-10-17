// @vitest-environment jsdom
/**
 * The owner's OAuth app registration on a provider card (cupboard-distributable-integrations-
 * 2026-10-10 P-009; SPEC-R-2-P-009, SPEC-R-7-P-009): an unregistered OAuth provider asks for a
 * client ID and secret and shows the redirect URL to give the vendor; a saved one shows its client
 * ID and never a secret, with Replace; a save sends exactly { clientId, clientSecret? } to the
 * provider's oauth-client route; a re-save with the secret left blank keeps the saved one.
 *
 * Fixture values are deliberately neutral, low-entropy strings, not vendor-token-shaped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ProviderOAuthClientSummary } from '@papercusp/operator-core/lib/integrations/ticket-integrations';

const H = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  calls: [] as Array<{ method: string; url: string; body: unknown }>,
  response: { status: 200, body: { ok: true } as unknown },
}));

vi.mock('sonner', () => ({ toast: H.toast }));

import { ProviderOAuthClientForm, providerOAuthClientPath } from './ProviderOAuthClientForm';

const REDIRECT = 'https://operator.form.test/api/oauth/callback';

const client = (overrides: Partial<ProviderOAuthClientSummary> = {}): ProviderOAuthClientSummary => ({
  ref: 'fixture-app',
  configured: false,
  clientId: null,
  hasClientSecret: false,
  redirectUri: REDIRECT,
  savedAt: null,
  secretRequired: true,
  ...overrides,
});

beforeEach(() => {
  H.calls.length = 0;
  H.response = { status: 200, body: { ok: true } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      H.calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(H.response.body), { status: H.response.status, headers: { 'content-type': 'application/json' } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const renderForm = (summary: ProviderOAuthClientSummary | null) =>
  render(<ProviderOAuthClientForm providerId="fixture-tickets" displayName="Fixture Tickets" client={summary} />);

describe('ProviderOAuthClientForm', () => {
  it('requires a real supplied User-Agent without inventing one and saves the exact public identification', async () => {
    renderForm(client({ userAgentRequired: true }));
    expect((screen.getByLabelText('User-Agent') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'form-client' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'form-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save OAuth app' }));
    expect((await screen.findByRole('alert')).textContent).toContain('User-Agent');
    expect(H.calls).toEqual([]);
    const userAgent = 'desktop:fixture:1.0 (by /u/fixture-contact)';
    fireEvent.change(screen.getByLabelText('User-Agent'), { target: { value: userAgent } });
    fireEvent.click(screen.getByRole('button', { name: 'Save OAuth app' }));
    await waitFor(() => expect(H.calls).toHaveLength(1));
    expect(H.calls[0].body).toEqual({ clientId: 'form-client', clientSecret: 'form-secret', userAgent });
  });

  it('preserves the saved public User-Agent when replacing credentials', async () => {
    renderForm(client({ userAgentRequired: true, userAgent: 'desktop:saved-app:1.0', configured: true, clientId: 'saved', hasClientSecret: true }));
    expect(screen.getByText('User-Agent: desktop:saved-app:1.0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect((screen.getByLabelText('User-Agent') as HTMLInputElement).value).toBe('desktop:saved-app:1.0');
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'new-client' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save OAuth app' }));
    await waitFor(() => expect(H.calls).toHaveLength(1));
    expect(H.calls[0].body).toEqual({ clientId: 'new-client', userAgent: 'desktop:saved-app:1.0' });
  });
  it('opens the typed instance’s app settings before credentials exist and follows origin edits without a save', () => {
    render(<ProviderOAuthClientForm providerId="federated" displayName="Federated" client={client({ instanceRequired: true })}
      appRegistration={{ createUrl: '/settings/applications/new', definitionText: null, docsUrl: null, copyHint: null }} />);
    expect(screen.queryByRole('link', { name: 'Create Federated app' })).toBeNull();
    for (const origin of ['https://mastodon.social', 'https://hachyderm.io']) {
      fireEvent.change(screen.getByLabelText('Instance origin'), { target: { value: origin } });
      expect(screen.getByRole('link', { name: 'Create Federated app' }).getAttribute('href')).toBe(`${origin}/settings/applications/new`);
    }
    fireEvent.change(screen.getByLabelText('Instance origin'), { target: { value: 'https://127.0.0.1' } });
    expect(screen.queryByRole('link', { name: 'Create Federated app' })).toBeNull();
    expect(H.calls).toEqual([]);
  });
  it('saves the selected instance origin with its own app credentials', async () => {
    renderForm(client({ instanceRequired: true }));
    fireEvent.change(screen.getByLabelText('Instance origin'), { target: { value: 'https://first.example.com/' } });
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'first-client' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'first-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save OAuth app' }));
    await waitFor(() => expect(H.calls).toHaveLength(1));
    expect(H.calls[0]!.body).toEqual({ origin: 'https://first.example.com', clientId: 'first-client', clientSecret: 'first-secret' });
  });

  it('refuses an invalid instance and requires a fresh secret when switching to a new instance', async () => {
    renderForm(client({ instanceRequired: true, configured: true, origin: 'https://first.example.com', hasClientSecret: true, clientId: 'first' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'second-client' } });
    fireEvent.change(screen.getByLabelText('Instance origin'), { target: { value: 'https://127.0.0.1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save OAuth app' }));
    expect((await screen.findByRole('alert')).textContent).toContain('HTTPS origin');
    fireEvent.change(screen.getByLabelText('Instance origin'), { target: { value: 'https://second.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save OAuth app' }));
    expect((await screen.findByRole('alert')).textContent).toContain('client secret');
    expect(H.calls).toEqual([]);
  });
  it('renders nothing for a provider that does not sign in through OAuth', () => {
    const { container } = renderForm(null);
    expect(container.innerHTML).toBe('');
  });

  it('asks an unregistered provider for a client ID and a masked secret, and shows the redirect URL', () => {
    renderForm(client());
    const form = screen.getByRole('form', { name: 'Fixture Tickets OAuth app' });
    expect(form.getAttribute('data-configured')).toBe('false');
    expect(within(form).getByLabelText('Client ID').getAttribute('type')).toBe('text');
    expect(within(form).getByLabelText('Client secret').getAttribute('type')).toBe('password');
    expect(form.querySelector('[data-oauth-redirect-uri]')?.textContent).toBe(REDIRECT);
  });

  it('saves { clientId, clientSecret } to the provider route and clears the inputs', async () => {
    renderForm(client());
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: ' form-client ' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'form-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save OAuth app' }));
    await waitFor(() => expect(H.toast.success).toHaveBeenCalledWith('Fixture Tickets OAuth app saved.'));
    expect(H.calls).toEqual([
      { method: 'PUT', url: providerOAuthClientPath('fixture-tickets'), body: { clientId: 'form-client', clientSecret: 'form-secret' } },
    ]);
    expect((screen.getByLabelText('Client secret') as HTMLInputElement).value).toBe('');
  });

  it('refuses a missing secret before sending when the provider needs one', async () => {
    renderForm(client());
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'form-client' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save OAuth app' }));
    expect((await screen.findByRole('alert')).textContent).toContain('client secret');
    expect(H.calls).toEqual([]);
  });

  it('shows a saved registration by client ID, never a secret, and Replace keeps the saved secret when left blank', async () => {
    renderForm(client({ configured: true, clientId: 'saved-client', hasClientSecret: true, savedAt: '2026-10-11T08:00:00.000Z' }));
    const form = screen.getByRole('form', { name: 'Fixture Tickets OAuth app' });
    expect(form.getAttribute('data-configured')).toBe('true');
    expect(within(form).getByRole('status').textContent).toContain('saved-client');
    expect(within(form).queryByLabelText('Client secret')).toBeNull();

    fireEvent.click(within(form).getByRole('button', { name: 'Replace' }));
    const secret = within(form).getByLabelText('Client secret') as HTMLInputElement;
    expect(secret.value).toBe('');
    fireEvent.change(within(form).getByLabelText('Client ID'), { target: { value: 'renamed-client' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save OAuth app' }));
    await waitFor(() => expect(H.calls).toHaveLength(1));
    expect(H.calls[0]!.body).toEqual({ clientId: 'renamed-client' });
  });

  it('shows the route’s refusal and keeps the form open', async () => {
    H.response = { status: 422, body: { ok: false, error: 'invalid-client-id', detail: 'Client ID contains spaces or control characters.' } };
    renderForm(client({ secretRequired: false }));
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'form-client' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save OAuth app' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Client ID contains spaces');
    expect(screen.getByLabelText('Client ID')).toBeTruthy();
    expect(H.toast.success).not.toHaveBeenCalled();
  });
});
