/**
 * community.test.ts — GET /api/harness/:slug/community (P-005, D-035).
 *
 * Route-shaped (defineTool). Mocked: the harness registry (path resolution), node:fs existsSync
 * (the `.papercusp/shared.json` shared check), the session user, the active workspace, the org
 * PG handle and the provider-neutral community read. No real FS, PG, provider or network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/tooldef';

const H = vi.hoisted(() => ({
  shared: true,
  existsSync: vi.fn((_path: string) => true),
  loadHarnessRegistry: vi.fn(async () => ({ projects: [{ slug: 'shared-harness', path: '/repo/shared' }] })),
  readCommunityPresence: vi.fn(),
  sql: { tag: 'org-sql' },
}));
vi.mock('node:fs', async (orig) => ({ ...(await orig<typeof import('node:fs')>()), existsSync: H.existsSync }));
vi.mock('../../../../harness-registry', () => ({ loadHarnessRegistry: H.loadHarnessRegistry, deregisterEphemeralForeignHarness: vi.fn(async () => {}) }));
vi.mock('../../../../workspace-registry', async (orig) => ({ ...(await orig<object>()), activeWorkspaceId: () => 'ws-1' }));
vi.mock('../../../../auth', async (orig) => ({ ...(await orig<object>()), getSessionUserOrDefault: async () => ({ id: 7 }) }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<object>()), getOrgPg: () => ({ sql: H.sql }) }));
vi.mock('../../../../capability-verbs/community', () => ({ readCommunityPresence: H.readCommunityPresence }));

import routes from '../community';

const [getCommunity] = routes;
const ctx = (slug: string) => ({ principal: null, input: undefined, params: { slug }, log: () => {}, signal: new AbortController().signal }) as unknown as RouteContext;
const req = () => new Request('http://localhost/api/harness/x/community');
const community = { providerId: 'discord', displayName: 'Discord', presenceCount: 42, name: 'Papercusp', inviteUrl: 'https://discord.gg/papercusp' };

beforeEach(() => {
  vi.clearAllMocks();
  H.existsSync.mockReturnValue(true);
  H.readCommunityPresence.mockResolvedValue(community);
});

describe('GET /api/harness/:slug/community', () => {
  it('is the only harness route left — the provider-specific discord route is gone', () => {
    expect(routes.map((r) => (r as unknown as { path: string }).path)).toEqual(['/harness/:slug/community']);
  });

  it('404s an unknown harness without reading any provider', async () => {
    const res = await getCommunity.handler(req(), ctx('does-not-exist'));
    expect(res.status).toBe(404);
    expect(H.readCommunityPresence).not.toHaveBeenCalled();
  });

  it('answers a private harness without reading any provider', async () => {
    H.existsSync.mockReturnValue(false);
    const res = await getCommunity.handler(req(), ctx('shared-harness'));
    expect(await res.json()).toEqual({ isShared: false, community: null });
    expect(H.existsSync).toHaveBeenCalledWith('/repo/shared/.papercusp/shared.json');
    expect(H.readCommunityPresence).not.toHaveBeenCalled();
  });

  it('returns the shared harness owner community from the provider-neutral read', async () => {
    const res = await getCommunity.handler(req(), ctx('shared-harness'));
    expect(await res.json()).toEqual({ isShared: true, community });
    expect(H.readCommunityPresence).toHaveBeenCalledWith(H.sql, { workspaceId: 'ws-1', userId: '7', harnessSlug: 'shared-harness' });
  });

  it('degrades a failed read to no community instead of an error', async () => {
    H.readCommunityPresence.mockRejectedValueOnce(new Error('provider down'));
    const res = await getCommunity.handler(req(), ctx('shared-harness'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isShared: true, community: null });
  });
});
