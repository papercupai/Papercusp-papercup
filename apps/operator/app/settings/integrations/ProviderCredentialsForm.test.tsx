// @vitest-environment jsdom
/**
 * Paste-a-secret fields on a provider card (cupboard-distributable-integrations-2026-10-10 P-001,
 * SPEC-R-2-P-001): the form renders whatever the provider declares, keeps every input masked and
 * empty, refuses a value the provider's own format rejects before anything is sent, and shows a
 * saved field as "Saved <time>" with Replace and Clear instead of its value.
 *
 * Fixture values are deliberately neutral, low-entropy strings, not vendor-token-shaped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ProviderCredentialStatus } from '@papercusp/operator-core/lib/integrations/provider-credentials';
import devto from '../../../../../libs/papercusp/plugins/devto/papercusp.json';
import hashnode from '../../../../../libs/papercusp/plugins/hashnode/papercusp.json';

const H = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  openExternal: vi.fn(async (_href: string) => {}),
  calls: [] as Array<{ method: string; url: string; body: unknown }>,
  response: { status: 200, body: { ok: true, credentials: [] } as unknown },
}));

vi.mock('sonner', () => ({ toast: H.toast }));
vi.mock('../../_components/ExternalLinkProvider', () => ({ openExternalWebUrl: H.openExternal }));

import { ProviderCredentialsForm, providerCredentialsPath } from './ProviderCredentialsForm';

const field = (overrides: Partial<ProviderCredentialStatus> = {}): ProviderCredentialStatus => ({
  key: 'botToken',
  label: 'Bot token',
  help: 'Copy it from the app page.',
  helpUrl: 'https://fixture-chat.test/apps',
  placeholder: 'chat-…',
  pattern: 'chat-[0-9]+-[a-z]+',
  hosts: ['api.fixture-chat.test'],
  perPrincipal: false,
  configured: false,
  savedAt: null,
  ...overrides,
});

beforeEach(() => {
  H.calls.length = 0;
  H.response = { status: 200, body: { ok: true, credentials: [] } };
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

describe('ProviderCredentialsForm', () => {
  it.each([devto, hashnode])('renders the $name package credential declaration and saves only the entered value', async (manifest) => {
    const apiKeyFixture = 'fixture-api-key';
    const declared = manifest.provider.setup.credentials[0];
    render(<ProviderCredentialsForm providerId={manifest.provider.id} displayName={manifest.provider.displayName}
      credentials={[field({ ...declared, pattern: null, configured: false, savedAt: null })]} />);
    const input = screen.getByLabelText(declared.label) as HTMLInputElement;
    expect(input.type).toBe('password'); expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: apiKeyFixture } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(H.calls).toHaveLength(1));
    expect(H.calls[0]).toEqual({ method: 'PUT', url: providerCredentialsPath(manifest.provider.id), body: { values: { api_key: apiKeyFixture } } });
  });
  it('renders nothing when the provider declares no credentials', () => {
    const { container } = render(<ProviderCredentialsForm providerId="fixture-chat" displayName="Fixture Chat" credentials={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows an unconfigured field as an empty masked input with its help link', () => {
    render(<ProviderCredentialsForm providerId="fixture-chat" displayName="Fixture Chat" credentials={[field()]} />);
    const input = screen.getByLabelText('Bot token') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('chat-…');
    fireEvent.click(screen.getByText('Where to find it'));
    expect(H.openExternal).toHaveBeenCalledWith('https://fixture-chat.test/apps');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses a value the provider format rejects without sending anything', async () => {
    render(<ProviderCredentialsForm providerId="fixture-chat" displayName="Fixture Chat" credentials={[field()]} />);
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: 'wrong shape' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Bot token must not contain spaces or line breaks');
    expect(H.calls).toEqual([]);
  });

  it('sends the typed values to the credentials route and empties the input', async () => {
    render(<ProviderCredentialsForm providerId="fixture-chat" displayName="Fixture Chat" credentials={[field()]} />);
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: 'chat-1-sample' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(H.toast.success).toHaveBeenCalledWith('Fixture Chat credentials saved.'));
    expect(H.calls).toEqual([{ method: 'PUT', url: providerCredentialsPath('fixture-chat'), body: { values: { botToken: 'chat-1-sample' } } }]);
    expect((screen.getByLabelText('Bot token') as HTMLInputElement).value).toBe('');
  });

  it('shows the host refusal when the route rejects the value', async () => {
    H.response = { status: 422, body: { ok: false, error: 'invalid-value', detail: 'Bot token does not have the expected format' } };
    render(<ProviderCredentialsForm providerId="fixture-chat" displayName="Fixture Chat" credentials={[field({ pattern: null })]} />);
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: 'chat-1-sample' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Bot token does not have the expected format');
  });

  it('shows a saved field as Saved <time> with Replace and Clear, never an input or a value', async () => {
    render(
      <ProviderCredentialsForm
        providerId="fixture-chat"
        displayName="Fixture Chat"
        credentials={[field({ configured: true, savedAt: '2026-10-11T00:00:00.000Z' })]}
      />,
    );
    const row = document.querySelector('[data-credential="botToken"]') as HTMLElement;
    expect(row.dataset.configured).toBe('true');
    expect(within(row).getByText(/^Saved /)).toBeTruthy();
    expect(within(row).queryByLabelText('Bot token')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();

    fireEvent.click(within(row).getByRole('button', { name: 'Replace' }));
    const input = within(row).getByLabelText('Bot token') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');

    fireEvent.click(within(row).getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(H.toast.success).toHaveBeenCalledWith('Bot token cleared.'));
    expect(H.calls).toEqual([{ method: 'DELETE', url: `${providerCredentialsPath('fixture-chat')}/botToken`, body: undefined }]);
  });
});
