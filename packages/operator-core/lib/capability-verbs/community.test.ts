/** The provider-neutral community badge read (P-005, D-035). */
import type postgres from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderDescriptor, ProviderInvokeRequest } from '@papercusp/plugin-sdk';
import { createProviderRegistry } from '../integrations/provider-registry';
const mocks = vi.hoisted(() => ({ sources: vi.fn() }));
vi.mock('../external-triggers/source-store', async (original) => ({ ...(await original<object>()), listOwnedExternalTriggerSources: mocks.sources }));
import { readCommunityPresence, resetCommunityPresenceCache } from './community';

const sql = (async () => []) as unknown as postgres.Sql;
const params = { workspaceId: 'ws', userId: 'owner', harnessSlug: 'papercusp' };
const source = (id: string, kind = 'community-example', config: Record<string, unknown> = {}, status = 'active') =>
  ({ id, workspaceId: 'ws', ownerUserId: 'owner', kind, status, credentialRef: `provider-setup:${kind}`, config });
const widget = { widget: 'enabled', presenceCount: 42, name: 'Papercusp', inviteUrl: 'https://discord.gg/papercusp' };

beforeEach(() => { vi.resetAllMocks(); resetCommunityPresenceCache(); });
async function fixture(capabilities = ['notify.send', 'community.presence'], result: Record<string, unknown> = widget) {
  const descriptor: ProviderDescriptor = { id: 'community-example', contractVersion: 1, displayName: 'Example Chat', datatypes: ['notification'], sync: false,
    capabilities, egressHosts: ['chat.test'], verification: { verifiedAt: '2026-10-20', sources: ['https://chat.test/docs'],
      capabilities: Object.fromEntries(capabilities.map((c) => [c, '2026-10-20'])) } };
  const invoke = vi.fn(async (_request: ProviderInvokeRequest): Promise<Record<string, unknown>> => result);
  const registry = createProviderRegistry();
  await registry.register({ descriptor, pluginName: descriptor.id, adapter: { describe: () => descriptor,
    syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }), invoke } });
  return { registry, invoke, deps: { registry, hostFetchFor: () => vi.fn() } };
}

describe('readCommunityPresence', () => {
  it('reads the single owned community source and caches it for five minutes', async () => {
    const f = await fixture();
    mocks.sources.mockResolvedValue([source('s1', 'community-example', { guildId: '987654321098765432' })]);
    let now = 1_000_000;
    const deps = { ...f.deps, now: () => now };
    expect(await readCommunityPresence(sql, params, deps)).toEqual({ providerId: 'community-example', displayName: 'Example Chat',
      presenceCount: 42, name: 'Papercusp', inviteUrl: 'https://discord.gg/papercusp' });
    expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ source: 's1', capability: 'community.presence', args: {},
      config: { guildId: '987654321098765432' } }), expect.anything());
    now += 4 * 60 * 1000;
    await readCommunityPresence(sql, params, deps);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    now += 2 * 60 * 1000;
    await readCommunityPresence(sql, params, deps);
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });

  it('prefers the source filed under this harness and refuses to guess between several', async () => {
    const f = await fixture();
    mocks.sources.mockResolvedValue([source('mine', 'community-example', { installSlug: 'papercusp' }), source('theirs', 'community-example', { installSlug: 'other' })]);
    await readCommunityPresence(sql, params, f.deps);
    expect(f.invoke).toHaveBeenCalledWith(expect.objectContaining({ source: 'mine' }), expect.anything());
    resetCommunityPresenceCache();
    f.invoke.mockClear();
    mocks.sources.mockResolvedValue([source('a', 'community-example', { installSlug: 'x' }), source('b', 'community-example', { installSlug: 'y' })]);
    expect(await readCommunityPresence(sql, params, f.deps)).toBeNull();
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('ignores providers without community.presence, other kinds and disabled or errored sources', async () => {
    const f = await fixture(['notify.send']);
    mocks.sources.mockResolvedValue([source('s1')]);
    expect(await readCommunityPresence(sql, params, f.deps)).toBeNull();
    resetCommunityPresenceCache();
    const g = await fixture();
    mocks.sources.mockResolvedValue([source('gone', 'community-example', {}, 'disabled'), source('bad', 'community-example', {}, 'error'), source('mail', 'gmail')]);
    expect(await readCommunityPresence(sql, params, g.deps)).toBeNull();
    expect(f.invoke).not.toHaveBeenCalled();
    expect(g.invoke).not.toHaveBeenCalled();
  });

  it('returns null on provider failure and drops untrusted counts and non-https invites', async () => {
    const f = await fixture();
    mocks.sources.mockResolvedValue([source('s1')]);
    f.invoke.mockRejectedValueOnce(new Error('widget_unreachable'));
    expect(await readCommunityPresence(sql, params, f.deps)).toBeNull();
    resetCommunityPresenceCache();
    f.invoke.mockResolvedValueOnce({ widget: 'enabled', presenceCount: 1.5, name: 7, inviteUrl: 'http://discord.gg/x' });
    expect(await readCommunityPresence(sql, params, f.deps)).toMatchObject({ presenceCount: null, name: null, inviteUrl: null });
  });

  it('does not read an unverified package', async () => {
    const f = await fixture();
    f.registry.get('community-example')!.descriptor.verification = undefined;
    mocks.sources.mockResolvedValue([source('s1')]);
    expect(await readCommunityPresence(sql, params, f.deps)).toBeNull();
    expect(f.invoke).not.toHaveBeenCalled();
  });
});
