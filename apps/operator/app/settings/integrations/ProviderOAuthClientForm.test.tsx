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
