// @vitest-environment jsdom
/**
 * How a provider's connected source is shared, on its card (cupboard-distributable-integrations-
 * 2026-10-10 D-026 ruling 4): the form offers only what the provider's declarations allow, keeps
 * live search tied to organization scope, and saves through the provider's setup route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const H = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  openExternal: vi.fn(async (_href: string) => {}),
  calls: [] as Array<{ method: string; url: string; body: unknown }>,
  response: { status: 200, body: { ok: true } as unknown },
}));

vi.mock('sonner', () => ({ toast: H.toast }));
vi.mock('../../_components/ExternalLinkProvider', () => ({ openExternalWebUrl: H.openExternal }));

import { providerCredentialsPath } from './ProviderCredentialsForm';
import { ProviderSourceSettingsForm } from './ProviderSourceSettingsForm';

const BOTH = { organization: true, liveSearch: true };
const PERSONAL = [{ scope: 'personal', liveSearch: false }];

beforeEach(() => {
  H.calls.length = 0;
  H.response = { status: 200, body: { ok: true } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      H.calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const { status, body } = H.response;
      return { ok: status < 400, status, json: async () => body } as unknown as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderForm(offer = BOTH, sources: ReadonlyArray<{ scope: string; liveSearch: boolean }> = PERSONAL) {
  return render(<ProviderSourceSettingsForm providerId="fixture-chat" displayName="Fixture Chat" offer={offer} sources={sources} />);
}

const form = () => screen.getByRole('form', { name: 'Fixture Chat sharing' });
// The choices are the shared RadioGroup / Checkbox primitives (role="radio"/"checkbox" buttons), not
// native inputs, so their state is read from aria-checked rather than an input's `.checked`.
const onlyYou = () => screen.getByRole('radio', { name: 'Only you' });
const organization = () => screen.getByRole('radio', { name: /^Your organization/ });
const liveSearch = () => screen.getByRole('checkbox', { name: /^Search Fixture Chat live/ }) as HTMLButtonElement;
const saveButton = () => screen.getByRole('button', { name: 'Save sharing' }) as HTMLButtonElement;
const isChecked = (element: HTMLElement) => element.getAttribute('aria-checked') === 'true';

describe('ProviderSourceSettingsForm', () => {
  it('renders nothing when the provider offers no organization scope, or nothing is connected yet', () => {
    const offered = renderForm({ organization: false, liveSearch: false });
    expect(offered.container.innerHTML).toBe('');
    cleanup();
    const unconnected = renderForm(BOTH, []);
    expect(unconnected.container.innerHTML).toBe('');
  });

  it('shows the stored choice, enables live search only for organization scope, and saves both', async () => {
    renderForm();
    expect(form().getAttribute('data-provider-source-settings')).toBe('fixture-chat');
    expect(form().getAttribute('data-scope')).toBe('personal');
    expect(form().getAttribute('data-live-search')).toBe('false');
    expect(screen.getByRole('radiogroup', { name: 'Who can read what it syncs' })).toBeTruthy();
    expect(isChecked(onlyYou())).toBe(true);
    expect(isChecked(organization())).toBe(false);
    expect(liveSearch().disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);

    fireEvent.click(organization());
    expect(isChecked(organization())).toBe(true);
    expect(isChecked(onlyYou())).toBe(false);
    expect(liveSearch().disabled).toBe(false);
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(liveSearch());
    expect(isChecked(liveSearch())).toBe(true);

    fireEvent.submit(form());
    await waitFor(() => expect(H.toast.success).toHaveBeenCalledWith('Fixture Chat sharing saved.'));
    expect(H.calls).toEqual([
      { method: 'PUT', url: providerCredentialsPath('fixture-chat'), body: { source: { scope: 'organization', liveSearch: true } } },
    ]);
  });

  it('offers no live search when the provider does not declare it, and sends scope alone', async () => {
    renderForm({ organization: true, liveSearch: false });
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(organization());
    fireEvent.submit(form());
    await waitFor(() => expect(H.calls).toHaveLength(1));
    expect(H.calls[0].body).toEqual({ source: { scope: 'organization' } });
  });

  it('turns live search off with a move back to personal, and shows a refusal from the server', async () => {
    renderForm(BOTH, [{ scope: 'organization', liveSearch: true }]);
    expect(form().getAttribute('data-live-search')).toBe('true');
    expect(isChecked(liveSearch())).toBe(true);

    fireEvent.click(onlyYou());
    expect(isChecked(liveSearch())).toBe(false);
    expect(liveSearch().disabled).toBe(true);

    H.response = {
      status: 409,
      body: { ok: false, error: 'live-search-needs-organization', detail: 'live search serves organization sources only' },
    };
    fireEvent.submit(form());
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'live search serves organization sources only');
    expect(H.calls[0].body).toEqual({ source: { scope: 'personal', liveSearch: false } });
    expect(H.toast.success).not.toHaveBeenCalled();
  });
});
