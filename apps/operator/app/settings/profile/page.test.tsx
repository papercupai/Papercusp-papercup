// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { OperatorSettingsSlotsProvider } from '@papercusp/operator-ui/settings-slots';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => () => 'pot' }));

import ProfilePage from './page';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Profile host composition', () => {
  it('keeps the desktop profile API and form unmounted when a host supplies identity', () => {
    const fetchProfile = vi.fn();
    vi.stubGlobal('fetch', fetchProfile);
    render(<OperatorSettingsSlotsProvider slots={{ profile: <section>
      <h1>Profile</h1><p>Your hosted account identity is managed in Account.</p>
    </section> }}><ProfilePage /></OperatorSettingsSlotsProvider>);
    expect(screen.getByRole('heading', { name: 'Profile' })).toBeTruthy();
    expect(screen.queryByLabelText('Display name')).toBeNull();
    expect(fetchProfile).not.toHaveBeenCalled();
  });

  it('loads the desktop profile when no host replacement is supplied', async () => {
    const fetchProfile = vi.fn(async () => new Response(JSON.stringify({
      email: 'ada@example.test', display_name: 'Ada', default_project_dir: '/projects',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchProfile);
    render(<ProfilePage />);
    await waitFor(() => expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Ada'));
    expect((screen.getByLabelText('Default project directory') as HTMLInputElement).value).toBe('/projects');
    expect(fetchProfile).toHaveBeenCalledWith('/api/profile');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('reports a refused profile response before reading it as empty identity', async () => {
    const readBody = vi.fn(async () => ({ error: 'operator_surface_requires_local_profile' }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: readBody })));
    render(<ProfilePage />);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('load failed: HTTP 403'));
    expect(readBody).not.toHaveBeenCalled();
    expect(screen.queryByText('Loading…')).toBeNull();
  });
});
