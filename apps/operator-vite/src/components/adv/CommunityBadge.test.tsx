// @vitest-environment jsdom
//
// CommunityBadge — the shared harness's provider-neutral community pill (P-005, D-035). Fetches
// /api/harness/<slug>/community and renders NULL unless the harness is shared AND a provider
// returned an invite; otherwise an invite <a> whose label/dot reflect the live presence count.
// Real timers: the 5-min re-poll never fires inside a test; waitFor needs real timers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

import CommunityBadge from './CommunityBadge';

type Community = { providerId: string; displayName: string; presenceCount: number | null; name: string | null; inviteUrl: string | null };
const community = (over: Partial<Community> = {}): Community =>
  ({ providerId: 'discord', displayName: 'Discord', presenceCount: 7, name: 'Papercusp', inviteUrl: 'https://discord.gg/abc', ...over });

function stubFetch(impl: (url: string) => unknown) {
  const mock = vi.fn(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}
const ok = (body: { isShared: boolean; community: Community | null }) => ({ ok: true, json: async () => body });
async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('<CommunityBadge>', () => {
  it('renders nothing and fetches nothing for a null slug', () => {
    const mock = stubFetch(() => ok({ isShared: true, community: community() }));
    const { container } = render(<CommunityBadge slug={null} />);
    expect(container.innerHTML).toBe('');
    expect(mock).not.toHaveBeenCalled();
  });

  it('reads the provider-neutral route and renders "N online" with the invite link', async () => {
    const mock = stubFetch(() => ok({ isShared: true, community: community() }));
    render(<CommunityBadge slug="pot-a" />);
    const link = await waitFor(() => screen.getByRole('link'));
    expect(mock).toHaveBeenCalledWith('/api/harness/pot-a/community');
    expect(link.getAttribute('href')).toBe('https://discord.gg/abc');
    expect(link.getAttribute('data-provider')).toBe('discord');
    expect(link.textContent).toContain('7 online');
    expect(link.querySelector('.pc-community-badge__dot')).not.toBeNull();
  });

  it('shows the provider name without a dot when the presence count is unknown', async () => {
    stubFetch(() => ok({ isShared: true, community: community({ presenceCount: null }) }));
    render(<CommunityBadge slug="pot-b" />);
    const link = await waitFor(() => screen.getByRole('link'));
    expect(link.textContent).toBe('Discord');
    expect(link.querySelector('.pc-community-badge__dot')).toBeNull();
  });

  it.each([
    ['an unshared harness', { isShared: false, community: community() }],
    ['no community provider', { isShared: true, community: null }],
    ['no invite link', { isShared: true, community: community({ inviteUrl: null }) }],
  ])('renders nothing for %s', async (_label, body) => {
    stubFetch(() => ok(body));
    const { container } = render(<CommunityBadge slug="pot-c" />);
    await flush();
    expect(container.innerHTML).toBe('');
  });

  it('stays silent when the request fails', async () => {
    stubFetch(() => { throw new Error('offline'); });
    const { container } = render(<CommunityBadge slug="pot-d" />);
    await flush();
    expect(container.innerHTML).toBe('');
  });
});
