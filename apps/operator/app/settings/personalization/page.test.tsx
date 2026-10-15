// @vitest-environment jsdom

import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OperatorSettingsSlotsProvider } from '@papercusp/operator-ui/settings-slots';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';

const h = vi.hoisted(() => ({ catalogReads: vi.fn(), writeProfile: vi.fn(), savedPromptsMount: vi.fn() }));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => {
    h.catalogReads();
    return { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() };
  },
}));
vi.mock('@papercusp/operator-core/lib/profile-pref', () => ({
  injectedPref: () => null,
  reconcileProfilePref: vi.fn(async () => null),
  writeProfileField: (...args: unknown[]) => h.writeProfile(...args),
}));
vi.mock('nuqs', () => ({ useQueryState: () => useState(null), parseAsString: {} }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../harness/SavedPromptsSection', () => ({ default: (props: unknown) => {
  h.savedPromptsMount(props);
  return <h2>Native saved prompts</h2>;
} }));
vi.mock('./ThemeEditor', () => ({ default: () => null }));

import PersonalizationSettingsPage from './page';
import { THEME_STORAGE_KEY } from '@/lib/theme';

// Match the complete Storage fixture used by theme-catalog.test.tsx; current
// Node exposes an incomplete localStorage object in this jsdom worker.
const storageRows = new Map<string, string>();
const storage: Storage = {
  get length() { return storageRows.size; },
  clear: () => storageRows.clear(),
  getItem: key => storageRows.get(key) ?? null,
  key: index => [...storageRows.keys()][index] ?? null,
  removeItem: key => { storageRows.delete(key); },
  setItem: (key, value) => { storageRows.set(key, String(value)); },
};
Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });

function HostedPersonalization() {
  const [theme, setTheme] = useState('light');
  const select = (next: string) => {
    document.documentElement.dataset.theme = next;
    setTheme(next);
  };
  return <OperatorSettingsSlotsProvider slots={{ theme: <section aria-label="Host appearance">
    <button aria-pressed={theme === 'light'} onClick={() => select('light')}>Light</button>
    <button aria-pressed={theme === 'dark'} onClick={() => select('dark')}>Dark</button>
  </section> }}><PersonalizationSettingsPage /></OperatorSettingsSlotsProvider>;
}

beforeEach(() => {
  window.__PAPERCUSP_WS__ = 'theme-ownership-test';
  window.localStorage.clear();
  document.documentElement.dataset.theme = 'light';
  document.getElementById('pc-custom-themes')?.remove();
  h.catalogReads.mockClear();
  h.writeProfile.mockClear();
  h.savedPromptsMount.mockClear();
});
afterEach(cleanup);

describe('Personalization theme ownership', () => {
  it('keeps the desktop saved-prompt component inert when the host replaces its slot', () => {
    render(<OperatorSettingsSlotsProvider slots={{
      theme: <p>Host theme</p>,
      'saved-prompts': <p>Manage saved prompts in the desktop app.</p>,
    }}><PersonalizationSettingsPage /></OperatorSettingsSlotsProvider>);
    expect(screen.getByText('Manage saved prompts in the desktop app.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Native saved prompts' })).toBeNull();
    expect(h.savedPromptsMount).not.toHaveBeenCalled();
  });

  it('mounts the workspace saved-prompt component when the host supplies no replacement', () => {
    render(<OperatorSettingsSlotsProvider slots={{ theme: <p>Host theme</p> }}>
      <PersonalizationSettingsPage />
    </OperatorSettingsSlotsProvider>);
    expect(screen.getByRole('heading', { name: 'Native saved prompts' })).toBeTruthy();
    expect(h.savedPromptsMount).toHaveBeenCalledWith({ scope: { kind: 'workspace' } });
  });

  it('preserves the host theme on mount, selection and remount without starting the desktop theme writer', async () => {
    window.localStorage.setItem(wsLocalKey(THEME_STORAGE_KEY), 'frost');
    const mounted = render(<HostedPersonalization />);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    expect(screen.getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    mounted.unmount();
    render(<HostedPersonalization />);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(screen.queryByRole('radiogroup', { name: 'Theme' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Visual effects' })).toBeTruthy();
    expect(h.catalogReads).not.toHaveBeenCalled();
    expect(h.writeProfile).not.toHaveBeenCalled();
  });

  it('keeps native theme selection when the host supplies only an additive personalization control', async () => {
    render(<OperatorSettingsSlotsProvider slots={{ personalization: <p>Additional host preference</p> }}>
      <PersonalizationSettingsPage />
    </OperatorSettingsSlotsProvider>);
    expect(screen.getByText('Additional host preference')).toBeTruthy();
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('frost'));
    fireEvent.click(screen.getByRole('radio', { name: 'Black' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('black'));
    expect(window.localStorage.getItem(wsLocalKey(THEME_STORAGE_KEY))).toBe('black');
    expect(h.writeProfile).toHaveBeenCalledWith('theme_id', 'black');
  });
});
