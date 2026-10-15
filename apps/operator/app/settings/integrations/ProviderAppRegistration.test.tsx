// @vitest-environment jsdom
/**
 * "Create app" on a provider card (cupboard-distributable-integrations-2026-10-10 P-002,
 * SPEC-R-2-P-002): a package that declares vendor app creation gets a Create app button that opens
 * the vendor page with the app definition filled in, plus Copy definition as the fallback. The
 * summary is built from a real descriptor through `providerAppRegistrationView`, so the URL the button
 * opens is the one the host resolves, not a hand-written fixture.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { providerAppRegistrationView as appRegistrationSummary } from '@papercusp/plugin-sdk/provider';

const H = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  openExternal: vi.fn(async (_href: string) => {}),
  clipboard: vi.fn(async (_text: string) => {}),
}));

vi.mock('sonner', () => ({ toast: H.toast }));
vi.mock('../../_components/ExternalLinkProvider', () => ({ openExternalWebUrl: H.openExternal }));

import { ProviderAppRegistration } from './ProviderAppRegistration';

const definition = { display_information: { name: 'Papercusp' }, settings: { socket_mode_enabled: true } };
const declared = appRegistrationSummary({
  setup: {
    appRegistration: {
      createUrl: 'https://fixture-chat.test/apps?new_app=1&manifest_json={definition}',
      definition,
      docsUrl: 'https://fixture-chat.test/docs/manifests',
      copyHint: 'Choose Create New App, then From a manifest.',
    },
  },
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ProviderAppRegistration', () => {
  it('renders nothing when the provider declares no app registration', () => {
    expect(appRegistrationSummary({})).toBeNull();
    const { container } = render(<ProviderAppRegistration providerId="fixture-chat" displayName="Fixture Chat" registration={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('opens the vendor page with the definition filled in when Create app is pressed', async () => {
    render(<ProviderAppRegistration providerId="fixture-chat" displayName="Fixture Chat" registration={declared} />);
    const link = screen.getByRole('link', { name: 'Create Fixture Chat app' }) as HTMLAnchorElement;
    // The link's href is the very URL handed to the system opener, so the page shows where it goes.
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false); // the webview itself never navigates away
    await waitFor(() => expect(H.openExternal).toHaveBeenCalledTimes(1));
    expect(link.getAttribute('href')).toBe(H.openExternal.mock.calls[0]![0]);
    const opened = new URL(H.openExternal.mock.calls[0]![0]);
    expect(opened.origin + opened.pathname).toBe('https://fixture-chat.test/apps');
    expect(opened.searchParams.get('new_app')).toBe('1');
    expect(JSON.parse(opened.searchParams.get('manifest_json') ?? 'null')).toEqual(definition);
  });

  it('copies the same definition as pretty JSON and tells the owner what to do with it', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: H.clipboard } });
    render(<ProviderAppRegistration providerId="fixture-chat" displayName="Fixture Chat" registration={declared} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy definition' }));
    await waitFor(() => expect(H.clipboard).toHaveBeenCalledTimes(1));
    expect(JSON.parse(H.clipboard.mock.calls[0]![0])).toEqual(definition);
    expect(H.clipboard.mock.calls[0]![0]).toBe(JSON.stringify(definition, null, 2));
    expect(H.toast.success).toHaveBeenCalledWith('Definition copied. Choose Create New App, then From a manifest.');
  });

  it('links the vendor docs, and offers no copy button when there is no definition to copy', async () => {
    render(<ProviderAppRegistration providerId="fixture-chat" displayName="Fixture Chat" registration={declared} />);
    fireEvent.click(screen.getByRole('link', { name: 'How to create it' }));
    await waitFor(() => expect(H.openExternal).toHaveBeenCalledWith('https://fixture-chat.test/docs/manifests'));
    cleanup();

    const bare = appRegistrationSummary({ setup: { appRegistration: { createUrl: 'https://fixture-chat.test/apps/new' } } });
    render(<ProviderAppRegistration providerId="fixture-chat" displayName="Fixture Chat" registration={bare} />);
    expect(screen.getByRole('link', { name: 'Create Fixture Chat app' }).getAttribute('href')).toBe('https://fixture-chat.test/apps/new');
    expect(screen.queryByRole('button', { name: 'Copy definition' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'How to create it' })).toBeNull();
  });

  it('says so when the vendor page cannot be opened', async () => {
    H.openExternal.mockRejectedValueOnce(new Error('no browser'));
    render(<ProviderAppRegistration providerId="fixture-chat" displayName="Fixture Chat" registration={declared} />);
    fireEvent.click(screen.getByRole('link', { name: 'Create Fixture Chat app' }));
    await waitFor(() => expect(H.toast.error).toHaveBeenCalledWith('Couldn’t open the Fixture Chat app page: no browser'));
  });
});
